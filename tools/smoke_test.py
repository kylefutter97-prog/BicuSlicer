"""BicuSlicer smoke test: real slices against a running BicuSlicer, checked in the G-code and weights.

Used by the OrcaSlicer update workflow (and handy before any release):

    python3 tools/smoke_test.py --url http://localhost:8000 --report smoke.md

It needs a BicuSlicer whose OrcaSlicer data has been (or can be) downloaded, and changes nothing it didn't
create: it adds one custom printer preset called "Smoke Klipper" and its jobs. Use a throwaway container.
Exit code 0 = every check passed, 1 = something failed. Standard library only.
"""

import argparse
import base64
import io
import json
import math
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
import zlib

RESULTS: list[tuple[bool, str, str]] = []


def check(ok: bool, name: str, detail: str = "") -> bool:
    RESULTS.append((bool(ok), name, detail))
    print(("PASS " if ok else "FAIL ") + name + (f": {detail}" if detail else ""), flush=True)
    return bool(ok)


class Api:
    def __init__(self, url: str):
        self.url = url.rstrip("/")

    def req(self, method, path, body=None, headers=None, timeout=120):
        r = urllib.request.Request(self.url + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)

    def json(self, method, path, obj=None, **kw):
        body = json.dumps(obj).encode() if obj is not None else None
        st, data, _ = self.req(method, path, body, {"Content-Type": "application/json"} if body else {}, **kw)
        try:
            return st, json.loads(data or b"null")
        except ValueError:
            return st, {"raw": data[:200].decode("utf-8", "replace")}

    def multipart(self, path, fields: dict, files: dict, timeout=120):
        b = uuid.uuid4().hex
        out = io.BytesIO()
        for k, v in fields.items():
            out.write(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        for k, (fname, data, ctype) in files.items():
            out.write(f'--{b}\r\nContent-Disposition: form-data; name="{k}"; filename="{fname}"\r\nContent-Type: {ctype}\r\n\r\n'.encode())
            out.write(data)
            out.write(b"\r\n")
        out.write(f"--{b}--\r\n".encode())
        st, data, _ = self.req("POST", path, out.getvalue(), {"Content-Type": f"multipart/form-data; boundary={b}"}, timeout=timeout)
        try:
            return st, json.loads(data)
        except ValueError:
            return st, {"raw": data[:200].decode("utf-8", "replace")}


# ---------------------------------------------------------------- test geometry

def box(x0, y0, z0, x1, y1, z1):
    v = [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    i = lambda x, y, z: x * 4 + y * 2 + z
    t = [(i(0,0,0),i(0,1,0),i(1,1,0)),(i(0,0,0),i(1,1,0),i(1,0,0)),(i(0,0,1),i(1,0,1),i(1,1,1)),(i(0,0,1),i(1,1,1),i(0,1,1)),
         (i(0,0,0),i(1,0,0),i(1,0,1)),(i(0,0,0),i(1,0,1),i(0,0,1)),(i(0,1,0),i(0,1,1),i(1,1,1)),(i(0,1,0),i(1,1,1),i(1,1,0)),
         (i(0,0,0),i(0,0,1),i(0,1,1)),(i(0,0,0),i(0,1,1),i(0,1,0)),(i(1,0,0),i(1,1,0),i(1,1,1)),(i(1,0,0),i(1,1,1),i(1,0,1))]
    return v, t


def stl(v, t) -> bytes:
    out = b"\0" * 80 + struct.pack("<I", len(t))
    for a, b, c in t:
        out += struct.pack("<12fH", 0, 0, 0, *v[a], *v[b], *v[c], 0)
    return out


def mesh_xml(v, t, paint=None):
    tv = "".join(f'<vertex x="{a}" y="{b}" z="{c}"/>' for a, b, c in v)
    tt = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"' + (f' paint_supports="{paint(k)}"' if paint and paint(k) else "") + "/>"
                 for k, (a, b, c) in enumerate(t))
    return f"<mesh><vertices>{tv}</vertices><triangles>{tt}</triangles></mesh>"


HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>'


def threemf(model: str, config: str | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        z.writestr("3D/3dmodel.model", model)
        if config:
            z.writestr("Metadata/model_settings.config", config)
    return buf.getvalue()


def cube_3mf(volume=None) -> bytes:
    """A 20 mm cube at (100..120, 100..120); optionally with a 12x12x10 box in its top half as a modifier or negative part."""
    v, t = box(100, 100, 0, 120, 120, 20)
    if not volume:
        return threemf(HEAD + f'<object id="1" type="model" name="cube">{mesh_xml(v, t)}</object></resources><build><item objectid="1"/></build></model>')
    mv, mt = box(104, 104, 10, 116, 116, 20)
    model = (HEAD + f'<object id="1" type="model" name="body">{mesh_xml(v, t)}</object><object id="2" type="model" name="extra">{mesh_xml(mv, mt)}</object>'
             '<object id="3" type="model" name="cube"><components><component objectid="1"/><component objectid="2"/></components></object>'
             '</resources><build><item objectid="3"/></build></model>')
    extra = '<metadata key="sparse_infill_density" value="100%"/>' if volume == "modifier_part" else ""
    cfg = ('<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <object id="3">\n    <metadata key="name" value="cube"/>\n'
           '    <part id="1" subtype="normal_part"><metadata key="name" value="body"/></part>\n'
           f'    <part id="2" subtype="{volume}"><metadata key="name" value="extra"/>{extra}</part>\n  </object>\n</config>\n')
    return threemf(model, cfg)


def overhang_3mf(block: bool) -> bytes:
    """A 10 mm post with a slab sticking out sideways; block=True paints the slab's underside 'no support'."""
    pv, pt = box(100, 100, 0, 110, 110, 15)
    sv, st = box(100, 100, 15, 130, 110, 20)
    v = pv + sv
    t = pt + [(a + 8, b + 8, c + 8) for a, b, c in st]
    paint = (lambda k: "8" if k - 12 in (0, 1) else None) if block else None
    return threemf(HEAD + f'<object id="1" type="model" name="overhang">{mesh_xml(v, t, paint)}</object></resources><build><item objectid="1"/></build></model>')


def png(w, h, rgba=(77, 171, 247, 255)) -> bytes:
    raw = b"".join(b"\0" + bytes(rgba) * w for _ in range(h))
    chunk = lambda typ, data: struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


# ---------------------------------------------------------------- slicing helpers

class Slicer:
    def __init__(self, api: Api, machine: str, process: str, filament: str):
        self.api, self.presets = api, {"machine": machine, "process": process, "filament": filament}
        self.gcode_cache = {}

    def slice(self, name: str, data: bytes, edits=None, arrange="1", thumbs=None):
        fields = {**self.presets, "edits": json.dumps(edits or {}), "arrange": arrange, "orient": "0"}
        files = {"model": (name, data, "application/octet-stream")}
        if thumbs:
            files["thumbs"] = ("thumbs.json", json.dumps(thumbs).encode(), "application/json")
        st, job = self.api.multipart("/api/slice", fields, files)
        if st != 200 or "id" not in job:
            return {"status": "error", "error": f"upload {st}: {job}"}
        for _ in range(600):
            st, job = self.api.json("GET", f"/api/jobs/{job['id']}")
            if job.get("status") in ("done", "error"):
                return job
            time.sleep(1)
        return {"status": "error", "error": "timed out"}

    def gcode(self, job) -> str:
        st, data, _ = self.api.req("GET", f"/api/jobs/{job['id']}/plates/{job['plates'][0]['plate']}/gcode", timeout=300)
        return data.decode("utf-8", "replace") if st == 200 else ""


def header_value(gcode: str, key: str):
    for line in gcode.splitlines():
        if line.startswith(f"; {key} = "):
            return line.split(" = ", 1)[1].strip()
    return None


def weight(job):
    return job["plates"][0]["weight_g"] if job.get("status") == "done" and job.get("plates") else None


# ---------------------------------------------------------------- the checks

def run(url: str, wait: int) -> None:
    api = Api(url)

    # 1. OrcaSlicer data downloaded and parsed
    deadline = time.time() + wait
    state, last = {}, "no answer yet"
    while time.time() < deadline:
        try:
            st, state = api.json("GET", "/api/state")
            last = f"HTTP {st}"
            if st == 200 and state.get("orca", {}).get("status") in ("ready", "failed"):
                break
        except OSError as e:
            last = f"{type(e).__name__}: {e}"
        time.sleep(5)
    orca = state.get("orca", {}) if isinstance(state, dict) else {}
    if not check(orca.get("status") == "ready", "OrcaSlicer data downloaded",
                 f"{orca.get('tag')} {orca.get('status')} {orca.get('error') or ''}".strip() if orca else f"the server didn't answer ({last})"):
        return
    st, cat = api.json("GET", "/api/catalog")
    opts = cat.get("options", {}) if st == 200 else {}
    check(len(opts) > 500, "settings catalogue parsed", f"{len(opts)} settings")
    check(all(len(cat.get("layouts", {}).get(t, [])) >= 3 for t in ("process", "filament", "machine")), "settings pages for all three preset types")
    check(len(cat.get("part_options", [])) > 100, "per-part settings list", f"{len(cat.get('part_options', []))} settings")
    check(sum(1 for o in opts.values() if o.get("line")) >= 10, "named setting rows (e.g. bed temperature per plate)")
    check("curr_bed_type" in opts and len(opts["curr_bed_type"].get("enum_values") or []) >= 4, "plate types known")
    st, vendors = api.json("GET", "/api/vendors")
    check(st == 200 and len(vendors) > 20, "vendor library", f"{len(vendors) if isinstance(vendors, list) else 0} brands")

    # 2. a custom Klipper printer, as a new user would make one
    st, res = api.json("POST", "/api/setup", {"machines": [], "custom": {"name": "Smoke Klipper", "width": "220", "depth": "220",
                                                                         "height": "250", "nozzle": "0.4", "flavor": "klipper"}, "done": True})
    if not check(st == 200 and res.get("created") == "Smoke Klipper", "custom printer created", str(res)[:160]):
        return
    st, pres = api.json("GET", "/api/presets?machine=Smoke%20Klipper")
    sel = pres.get("selected", {})
    if not check(all(sel.get(t) for t in ("machine", "process", "filament")), "presets offered for it", json.dumps(sel)):
        return
    s = Slicer(api, sel["machine"], sel["process"], sel["filament"])
    cube = stl(*box(0, 0, 0, 20, 20, 20))

    # 3. plain slice + G-code basics
    j = s.slice("cube.stl", cube)
    if not check(j.get("status") == "done", "slice a 20 mm cube", j.get("error") or f"{j.get('plates', [{}])[0].get('time_s', 0):.0f} s, {weight(j)} g"):
        return
    g = s.gcode(j)
    gen = next((ln for ln in g.splitlines()[:5] if "generated by" in ln), "")
    check(orca.get("tag", "").lstrip("v") in gen, "G-code made by this OrcaSlicer version", gen.strip("; "))
    st, data, _ = api.req("GET", f"/api/jobs/{j['id']}/plates/1/preview", headers={"Accept-Encoding": "identity"})
    check(st == 200 and data[:4] == b"BSGP" and struct.unpack("<I", data[8:12])[0] > 50, "layer preview built", f"{struct.unpack('<I', data[8:12])[0] if st == 200 else st} layers")

    # 4. unsaved edits reach the slicer
    j = s.slice("cube.stl", cube, {"process": {"layer_height": "0.1", "wall_loops": "5", "sparse_infill_density": "40%"}})
    g = s.gcode(j) if j.get("status") == "done" else ""
    check(header_value(g, "layer_height") == "0.1" and header_value(g, "wall_loops") == "5" and header_value(g, "sparse_infill_density") == "40%",
          "unsaved setting changes apply", f"layer {header_value(g, 'layer_height')}, walls {header_value(g, 'wall_loops')}, infill {header_value(g, 'sparse_infill_density')}")

    # 5. plate type picks the bed temperature
    j = s.slice("cube.stl", cube, {"process": {"curr_bed_type": "Textured PEI Plate"}})
    g = s.gcode(j) if j.get("status") == "done" else ""
    check(header_value(g, "curr_bed_type") == "Textured PEI Plate", "plate type passed to the slicer", str(header_value(g, "curr_bed_type")))

    # 6. per-part and modifier / negative parts in the 3MF
    plain = s.slice("plate.3mf", cube_3mf(), {"process": {"sparse_infill_density": "15%"}}, arrange="0")
    mod = s.slice("plate.3mf", cube_3mf("modifier_part"), {"process": {"sparse_infill_density": "15%"}}, arrange="0")
    check(weight(plain) and weight(mod) and weight(mod) > weight(plain) * 1.15, "modifier part with its own infill", f"{weight(plain)} g -> {weight(mod)} g")
    solid = s.slice("plate.3mf", cube_3mf(), {"process": {"sparse_infill_density": "100%"}}, arrange="0")
    neg = s.slice("plate.3mf", cube_3mf("negative_part"), {"process": {"sparse_infill_density": "100%"}}, arrange="0")
    check(weight(solid) and weight(neg) and weight(neg) < weight(solid) * 0.92, "negative part cut away", f"{weight(solid)} g -> {weight(neg)} g")

    # 7. painted support blocker
    sup = {"process": {"enable_support": "1", "support_type": "normal(auto)"}}
    a = s.slice("plate.3mf", overhang_3mf(False), sup, arrange="0")
    b = s.slice("plate.3mf", overhang_3mf(True), sup, arrange="0")
    check(weight(a) and weight(b) and weight(b) < weight(a), "painted support blocker", f"{weight(a)} g -> {weight(b)} g")

    # 8. thumbnails inserted for Mainsail
    thumbs = {"32x32": base64.b64encode(png(32, 32)).decode(), "300x300": base64.b64encode(png(300, 300)).decode()}
    j = s.slice("cube.stl", cube, thumbs=thumbs)
    g = s.gcode(j) if j.get("status") == "done" else ""
    check("; thumbnail begin 32x32" in g and "; thumbnail begin 300x300" in g, "G-code thumbnails inserted")

    # 9. auto-orient (OrcaSlicer's algorithm): a 40x20x10 box tilted 35° about X then 20° about Y should go back
    #    onto its big face, i.e. the reply's "down" direction is that face's (tilted) normal
    v, t = box(0, 0, 0, 40, 20, 10)
    rx, ry = math.radians(35), math.radians(20)
    def tilt(p):
        x, y, z = p
        y, z = y * math.cos(rx) - z * math.sin(rx), y * math.sin(rx) + z * math.cos(rx)
        return (x * math.cos(ry) + z * math.sin(ry), y, -x * math.sin(ry) + z * math.cos(ry))
    expected = tilt((0, 0, -1))
    st, res = api.multipart("/api/orient", {}, {"model": ("part.stl", stl([tilt(p) for p in v], t), "model/stl")})
    down = res.get("down") if st == 200 else None
    dot = sum(a * b for a, b in zip(down, expected)) if down else 0
    check(dot > 0.99, "auto-orient puts a tilted box back on its big face", f"down {[round(x, 3) for x in down] if down else res}")

    # 10. a vendor printer from the library
    machine = next((p["preset"] for v in vendors if v["vendor"] in ("Voron", "Prusa", "Creality") for m in v["models"] for p in m["presets"]
                    if str(p.get("nozzle")) in ("0.4", "0.4 nozzle")), None)
    if check(bool(machine), "vendor printer found", str(machine)):
        api.json("POST", "/api/setup", {"machines": [machine], "done": True, "add": True})
        st, pres = api.json("GET", "/api/presets?machine=" + urllib.parse.quote(machine))
        vs = pres.get("selected", {})
        if all(vs.get(t) for t in ("machine", "process", "filament")):
            j = Slicer(api, vs["machine"], vs["process"], vs["filament"]).slice("cube.stl", cube)
            check(j.get("status") == "done", f"slice on {machine}", j.get("error") or f"{weight(j)} g with {vs['process']} / {vs['filament']}")
        else:
            check(False, f"presets offered for {machine}", json.dumps(vs))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--wait", type=int, default=1800, help="seconds to wait for the OrcaSlicer data download")
    ap.add_argument("--report", help="write a Markdown summary here")
    args = ap.parse_args()
    try:
        run(args.url, args.wait)
    except Exception as e:      # an unexpected crash is a failure too, with the reason in the report
        check(False, "smoke test ran to the end", f"{type(e).__name__}: {e}")
    ok = all(r[0] for r in RESULTS) and bool(RESULTS)
    if args.report:
        lines = [f"### Smoke test: {'all passed ✅' if ok else 'FAILED ❌'}", "", "| | Check | Detail |", "|---|---|---|"]
        lines += [f"| {'✅' if r[0] else '❌'} | {r[1]} | {r[2].replace('|', '/')} |" for r in RESULTS]
        open(args.report, "w").write("\n".join(lines) + "\n")
    print(f"\n{sum(r[0] for r in RESULTS)}/{len(RESULTS)} checks passed")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
