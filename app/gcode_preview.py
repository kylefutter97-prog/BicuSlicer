"""Turn OrcaSlicer G-code into a compact layer-by-layer toolpath file for the page's preview.

Binary layout (little endian), version 3:
  header   magic b"BSGP", u32 version, u32 layers, u32 extrusions, u32 travels, u32 json length
  floats   f32 z[layers]
  ends     u32 extrusion_end[layers], u32 travel_end[layers]   (cumulative segment counts per layer)
  times    f32 layer_time[layers]                              (seconds; OrcaSlicer's own estimate when known)
  extr     u16 x1,y1,x2,y2 per extrusion segment               (mm / RES, i.e. 0.05 mm steps)
  feature  u8 per extrusion segment                            (index into the features list), padded to 2 bytes
  travel   u16 x1,y1,x2,y2 per travel segment
  attrs    per extrusion segment, for the colour modes (OrcaSlicer's G-code viewer "Line type", "Speed"...):
           u16 speed (0.1 mm/s), u16 width (µm), u16 height (µm), u16 flow (0.01 mm³/s), u16 temperature (0.1 °C),
           u8 fan (%), u8 filament (0-based), padded to 4 bytes
  offsets  u32 per extrusion segment, then u32 per travel segment: the byte offset of its G-code line (for the move
           slider and showing the G-code being run)
  json     {"features": [names], "colours": [filament colours], "time": total seconds or null,
            "feature_stats": {name: {"time", "volume", "weight"}} from OrcaSlicer's statistics}
Segments are stored per layer, in print order, with Z taken from the layer table.
Version 2 had no offsets; version 1 also no times or attrs, and its json was just the feature list.
"""

from __future__ import annotations

import json
import math
import re
import struct
from array import array
from pathlib import Path

RES = 0.05            # mm per unit (u16 covers 0–3276 mm)
MAX_COORD = 65535
ARC_STEP = 1.0        # mm per chord when flattening G2/G3
MIN_SEG = 0.02        # drop zero-length moves
_WORD = re.compile(r"([XYZEIJRF])(-?\d*\.?\d+)")


def _isnum(v: str) -> bool:
    try:
        float(v)
        return True
    except ValueError:
        return False


def _q(v: float) -> int:
    n = int(round(v / RES))
    return 0 if n < 0 else MAX_COORD if n > MAX_COORD else n


def _param(code: str, letter: str) -> float | None:
    m = re.search(r"\s" + letter + r"(-?\d*\.?\d+)", code)
    return float(m.group(1)) if m else None


def _footer_config(gcode: Path) -> dict:
    """The "; key = value" settings OrcaSlicer writes at the end of the G-code."""
    cfg = {}
    with gcode.open("rb") as fh:
        fh.seek(0, 2)
        size = fh.tell()
        fh.seek(max(0, size - 400_000))
        tail = fh.read().decode("utf-8", "replace")
    i = tail.rfind("; CONFIG_BLOCK_START")
    for line in tail[i if i >= 0 else 0:].splitlines():
        if line.startswith("; ") and " = " in line:
            k, v = line[2:].split(" = ", 1)
            cfg[k.strip()] = v.strip()
    return cfg


def _list(v: str | None, sep=",") -> list[str]:
    return [x.strip() for x in (v or "").replace(";", sep).split(sep) if x.strip()]


def _feature_stats(stats: Path | None) -> dict:
    """Time, volume and weight per line type, from OrcaSlicer's statistics."""
    try:
        f = json.loads(stats.read_text()).get("summary", {}).get("features", {}) if stats and stats.is_file() else {}
        return {k: {kk: float(v.get(kk) or 0) for kk in ("time", "volume", "weight")} for k, v in f.items() if isinstance(v, dict)}
    except (ValueError, OSError, AttributeError, TypeError):
        return {}


def _layer_times(stats: Path | None, z_list: list[float]) -> tuple[list[float] | None, float | None]:
    """Per-layer times from OrcaSlicer's statistics (matched by order, or by height when the counts differ)."""
    if not stats or not stats.is_file():
        return None, None
    try:
        d = json.loads(stats.read_text())
        layers = [(float(x.get("z", 0)), float(x.get("time", 0))) for x in d.get("layers", [])]
        total = d.get("summary", {}).get("time")
    except (ValueError, OSError, TypeError, AttributeError):
        return None, None
    if not layers:
        return None, total
    if len(layers) == len(z_list):
        return [t for _, t in layers], total
    out = []
    for z in z_list:
        best = min(layers, key=lambda lt: abs(lt[0] - z))
        out.append(best[1] if abs(best[0] - z) < 0.01 else 0.0)
    return out, total


def build(gcode: Path, out: Path, stats: Path | None = None) -> dict:
    features: list[str] = []
    feat_index: dict[str, int] = {}

    def feat_id(name: str) -> int:
        if name not in feat_index:
            if len(features) >= 255:
                return 0
            feat_index[name] = len(features)
            features.append(name)
        return feat_index[name]

    z_list: list[float] = []
    extr_end: list[int] = []
    trav_end: list[int] = []
    extr = array("H")
    feat = array("B")
    trav = array("H")
    a_speed, a_width, a_height, a_flow, a_temp = (array("H") for _ in range(5))
    a_fan, a_tool = array("B"), array("B")
    epm = array("f")            # filament mm per mm of line, turned into mm³/s once the diameter is known
    seg_layer_temp_unknown = array("B")
    e_off, t_off = array("I"), array("I")      # byte offset of each segment's G-code line
    cur_off = 0   # 1: no M104 seen yet; filled from the settings afterwards

    x = y = z = 0.0
    feed = 0.0                  # mm/min
    width = height = 0.0
    fan = 0
    temp = None
    tool = 0
    e_abs = 0.0
    rel_xyz = False
    rel_e = False
    cur_feat = feat_id("Custom")
    layer_z_pending: float | None = None

    def new_layer(lz: float) -> None:
        if z_list:
            extr_end.append(len(feat))
            trav_end.append(len(trav) // 4)
        z_list.append(lz)

    def seg(x1, y1, x2, y2, extruding: bool, e_per_mm: float = 0.0) -> None:
        if abs(x2 - x1) < MIN_SEG and abs(y2 - y1) < MIN_SEG:
            return
        if not z_list:
            new_layer(z if z > 0 else 0.2)
        if extruding:
            extr.extend((_q(x1), _q(y1), _q(x2), _q(y2)))
            feat.append(cur_feat)
            e_off.append(cur_off)
            a_speed.append(min(65535, int(feed / 6 + 0.5)))          # mm/min -> 0.1 mm/s
            a_width.append(min(65535, int(width * 1000 + 0.5)))
            a_height.append(min(65535, int(height * 1000 + 0.5)))
            epm.append(e_per_mm)
            a_temp.append(min(65535, int((temp or 0) * 10 + 0.5)))
            seg_layer_temp_unknown.append(1 if temp is None else 0)
            a_fan.append(fan)
            a_tool.append(min(255, tool))
        else:
            trav.extend((_q(x1), _q(y1), _q(x2), _q(y2)))
            t_off.append(cur_off)

    with gcode.open("rb") as fh:
        pos = 0
        for raw in fh:
            cur_off = min(pos, 0xFFFFFFFF)
            pos += len(raw)
            line = raw.decode("utf-8", "replace")
            if not line:
                continue
            c = line[0]
            if c == ";":
                if line.startswith(";TYPE:"):
                    cur_feat = feat_id(line[6:].strip() or "Custom")
                elif line.startswith(";WIDTH:"):
                    try:
                        width = float(line[7:])
                    except ValueError:
                        pass
                elif line.startswith(";HEIGHT:"):
                    try:
                        height = float(line[8:])
                    except ValueError:
                        pass
                elif line.startswith("; MANUAL_TOOL_CHANGE T"):
                    try:
                        tool = int(line[22:].split()[0])
                    except (ValueError, IndexError):
                        pass
                elif line.startswith(";LAYER_CHANGE"):
                    layer_z_pending = -1.0
                elif line.startswith(";Z:") and layer_z_pending is not None:
                    try:
                        new_layer(float(line[3:]))
                    except ValueError:
                        new_layer(z)
                    layer_z_pending = None
                continue
            if c == "T" and line[1:2].isdigit():
                try:
                    tool = int(line[1:].split(";", 1)[0].strip())
                except ValueError:
                    pass
                continue
            if c != "G" and c != "M":
                continue
            code = line.split(";", 1)[0].strip()
            if not code:
                continue
            head = code.split(None, 1)[0]
            if head in ("G1", "G0", "G2", "G3"):
                if layer_z_pending is not None:           # ;LAYER_CHANGE without ;Z:
                    new_layer(z)
                    layer_z_pending = None
                w = dict(_WORD.findall(code))
                if "F" in w:
                    feed = float(w["F"])
                nx = float(w["X"]) + (x if rel_xyz else 0) if "X" in w else x
                ny = float(w["Y"]) + (y if rel_xyz else 0) if "Y" in w else y
                if "Z" in w:
                    z = float(w["Z"]) + (z if rel_xyz else 0)
                de = 0.0
                if "E" in w:
                    ev = float(w["E"])
                    if rel_e:
                        de = ev
                    else:
                        de = ev - e_abs
                        e_abs = ev
                extruding = de > 1e-6
                if head in ("G2", "G3") and ("I" in w or "J" in w):
                    cx, cy = x + float(w.get("I", 0)), y + float(w.get("J", 0))
                    r = math.hypot(x - cx, y - cy)
                    a0, a1 = math.atan2(y - cy, x - cx), math.atan2(ny - cy, nx - cx)
                    if head == "G2":            # clockwise
                        while a1 >= a0:
                            a1 -= 2 * math.pi
                    else:
                        while a1 <= a0:
                            a1 += 2 * math.pi
                    n = max(2, min(200, int(abs(a1 - a0) * r / ARC_STEP) + 1))
                    length = abs(a1 - a0) * r
                    px, py = x, y
                    for i in range(1, n + 1):
                        a = a0 + (a1 - a0) * i / n
                        qx, qy = (cx + r * math.cos(a), cy + r * math.sin(a)) if i < n else (nx, ny)
                        seg(px, py, qx, qy, extruding, de / length if extruding and length > 1e-9 else 0.0)
                        px, py = qx, qy
                else:
                    length = math.hypot(nx - x, ny - y)
                    seg(x, y, nx, ny, extruding, de / length if extruding and length > 1e-9 else 0.0)
                x, y = nx, ny
            elif head == "M106":
                if _param(code, "P") in (None, 0.0):          # the part fan, not an auxiliary one
                    sv = _param(code, "S")
                    fan = max(0, min(100, int(round((sv if sv is not None else 255) / 2.55))))
            elif head == "M107":
                if _param(code, "P") in (None, 0.0):
                    fan = 0
            elif head in ("M104", "M109"):
                sv = _param(code, "S")
                if sv is not None and (sv > 0 or temp is not None):
                    temp = sv
            elif head == "G90":
                rel_xyz = False
            elif head == "G91":
                rel_xyz = True
            elif head == "M82":
                rel_e = False
            elif head == "M83":
                rel_e = True
            elif head == "G92":
                w = dict(_WORD.findall(code))
                if "E" in w:
                    e_abs = float(w["E"])
                if "X" in w:
                    x = float(w["X"])
                if "Y" in w:
                    y = float(w["Y"])
                if "Z" in w:
                    z = float(w["Z"])

    if not z_list:
        z_list.append(0.0)
    extr_end.append(len(feat))
    trav_end.append(len(trav) // 4)

    cfg = _footer_config(gcode)
    # volumetric flow: filament mm per line mm × filament cross-section × speed
    diam = [float(v) for v in _list(cfg.get("filament_diameter")) if _isnum(v)] or [1.75]
    for i in range(len(epm)):
        dd = diam[min(a_tool[i], len(diam) - 1)]
        a_flow.append(min(65535, int(epm[i] * math.pi * dd * dd / 4 * a_speed[i] / 10 * 100 + 0.5)))
    # segments before the first M104 print at the settings' temperatures (the start G-code / macro heats up)
    first = [float(v) for v in _list(cfg.get("nozzle_temperature_initial_layer")) if _isnum(v)]
    other = [float(v) for v in _list(cfg.get("nozzle_temperature")) if _isnum(v)] or first
    if any(seg_layer_temp_unknown) and (first or other):
        lay = 0
        for i in range(len(a_temp)):
            while lay < len(extr_end) - 1 and i >= extr_end[lay]:
                lay += 1
            if seg_layer_temp_unknown[i]:
                src = first if lay == 0 and first else other
                a_temp[i] = int(src[min(a_tool[i], len(src) - 1)] * 10 + 0.5)

    times, total = _layer_times(stats, z_list)
    meta = json.dumps({"features": features, "colours": _list(cfg.get("filament_colour"), ";"),
                       "time": total, "times_from": "orca" if times else None,
                       "feature_stats": _feature_stats(stats)}).encode()
    n_layers = len(z_list)
    with out.open("wb") as fh:
        fh.write(b"BSGP" + struct.pack("<5I", 3, n_layers, len(feat), len(trav) // 4, len(meta)))
        fh.write(array("f", z_list).tobytes())
        fh.write(array("I", extr_end).tobytes())
        fh.write(array("I", trav_end).tobytes())
        fh.write(array("f", times or [0.0] * n_layers).tobytes())
        fh.write(extr.tobytes())
        fh.write(feat.tobytes())
        if len(feat) % 2:
            fh.write(b"\0")                # keep the travel u16 array 2-byte aligned
        fh.write(trav.tobytes())
        for a in (a_speed, a_width, a_height, a_flow, a_temp):
            fh.write(a.tobytes())
        fh.write(a_fan.tobytes())
        fh.write(a_tool.tobytes())
        if (2 * len(feat)) % 4:
            fh.write(b"\0\0")
        fh.write(e_off.tobytes())
        fh.write(t_off.tobytes())
        fh.write(meta)
    return {"layers": n_layers, "extrusions": len(feat), "travels": len(trav) // 4, "features": features,
            "bytes": out.stat().st_size}


if __name__ == "__main__":
    import sys
    import time
    t = time.time()
    info = build(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]) if len(sys.argv) > 3 else None)
    print(info, f"{time.time() - t:.2f}s")
