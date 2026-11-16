"""Turn OrcaSlicer G-code into a compact layer-by-layer toolpath file for the page's preview.

Binary layout (little endian), version 1:
  header   magic b"BSGP", u32 version, u32 layers, u32 extrusions, u32 travels, u32 features-json length
  floats   f32 z[layers]
  ends     u32 extrusion_end[layers], u32 travel_end[layers]   (cumulative segment counts per layer)
  extr     u16 x1,y1,x2,y2 per extrusion segment               (mm / RES, i.e. 0.05 mm steps)
  feature  u8 per extrusion segment                            (index into the features list)
  travel   u16 x1,y1,x2,y2 per travel segment
  json     the feature names, UTF-8
Segments are stored per layer, in print order, with Z taken from the layer table.
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


def _q(v: float) -> int:
    n = int(round(v / RES))
    return 0 if n < 0 else MAX_COORD if n > MAX_COORD else n


def build(gcode: Path, out: Path) -> dict:
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

    x = y = z = 0.0
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

    def seg(x1, y1, x2, y2, extruding: bool) -> None:
        if abs(x2 - x1) < MIN_SEG and abs(y2 - y1) < MIN_SEG:
            return
        if not z_list:
            new_layer(z if z > 0 else 0.2)
        if extruding:
            extr.extend((_q(x1), _q(y1), _q(x2), _q(y2)))
            feat.append(cur_feat)
        else:
            trav.extend((_q(x1), _q(y1), _q(x2), _q(y2)))

    with gcode.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if not line:
                continue
            c = line[0]
            if c == ";":
                if line.startswith(";TYPE:"):
                    cur_feat = feat_id(line[6:].strip() or "Custom")
                elif line.startswith(";LAYER_CHANGE"):
                    layer_z_pending = -1.0
                elif line.startswith(";Z:") and layer_z_pending is not None:
                    try:
                        new_layer(float(line[3:]))
                    except ValueError:
                        new_layer(z)
                    layer_z_pending = None
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
                    px, py = x, y
                    for i in range(1, n + 1):
                        a = a0 + (a1 - a0) * i / n
                        qx, qy = (cx + r * math.cos(a), cy + r * math.sin(a)) if i < n else (nx, ny)
                        seg(px, py, qx, qy, extruding)
                        px, py = qx, qy
                else:
                    seg(x, y, nx, ny, extruding)
                x, y = nx, ny
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

    names = json.dumps(features).encode()
    n_layers = len(z_list)
    with out.open("wb") as fh:
        fh.write(b"BSGP" + struct.pack("<5I", 1, n_layers, len(feat), len(trav) // 4, len(names)))
        fh.write(array("f", z_list).tobytes())
        fh.write(array("I", extr_end).tobytes())
        fh.write(array("I", trav_end).tobytes())
        fh.write(extr.tobytes())
        fh.write(feat.tobytes())
        if len(feat) % 2:
            fh.write(b"\0")                # keep the travel u16 array 2-byte aligned
        fh.write(trav.tobytes())
        fh.write(names)
    return {"layers": n_layers, "extrusions": len(feat), "travels": len(trav) // 4, "features": features,
            "bytes": out.stat().st_size}


if __name__ == "__main__":
    import sys
    import time
    t = time.time()
    info = build(Path(sys.argv[1]), Path(sys.argv[2]))
    print(info, f"{time.time() - t:.2f}s")
