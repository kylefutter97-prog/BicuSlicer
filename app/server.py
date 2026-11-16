"""BicuSlicer: a phone-friendly web front end for the OrcaSlicer command line.

Reads your OrcaSlicer presets (read-only), slices the plate the page builds with the
orca-slicer CLI in a per-job data dir, and sends G-code to a Klipper printer via Moonraker.
It has no login of its own: run it behind an authenticating reverse proxy or on a trusted network.
"""

import asyncio
import base64
import json
import os
import re
import shutil
import sys
import time
import uuid
import zipfile
from pathlib import Path

import aiohttp
from aiohttp import web

import gcode_preview
import presets as P
import printhosts as H

ORCA_BIN = os.environ.get("ORCA_BIN") or next(
    (p for p in ("/opt/orcaslicer/AppRun", "/opt/orcaslicer/bin/orca-slicer") if os.path.exists(p)), "orca-slicer")
ORCA_DIR = Path(os.environ.get("ORCA_DIR", "/orca"))           # OrcaSlicer data dir (read-only)
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
# Older single-printer settings: on first start they become a saved printer connection (see printhosts.migrate)
MOONRAKER = os.environ.get("MOONRAKER_URL", "").rstrip("/")
PRINTER_UI_URL = os.environ.get("PRINTER_UI_URL", "")
KEEP_JOBS = int(os.environ.get("KEEP_JOBS", "20"))
SLICE_TIMEOUT = int(os.environ.get("SLICE_TIMEOUT", "900"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "300"))

STATIC = Path(__file__).parent / "static"
JOBS = DATA_DIR / "jobs"
MODEL_EXT = {".stl", ".3mf", ".obj"}   # the Orca CLI cannot read STEP (GUI only)
# OrcaSlicer runs a print profile's post-processing scripts on the machine that slices, which here is the server, for
# anyone who can open the page, with presets and projects imported from anywhere. So they're switched off unless the
# person running BicuSlicer opts in.
ALLOW_POST_PROCESS = os.environ.get("ALLOW_POST_PROCESS", "") == "1"
# What of an uploaded 3MF reaches the slicer: geometry, per-object settings and layer height data. Not embedded
# project settings, presets or G-code (the chosen presets are what counts, and they must not be overridden).
KEEP_3MF_METADATA = {"metadata/model_settings.config", "metadata/layer_heights_profile.txt", "metadata/layer_config_ranges.xml",
                     "metadata/custom_gcode_per_layer.xml"}      # G-code at chosen heights (pauses, calibration steps): runs on the printer
KINDS = P.TYPES
TOOLS = Path(__file__).parent / "tools"
PRESET_DIR = DATA_DIR / "presets"
SETTINGS_FILE = DATA_DIR / "settings.json"
PROJECTS = DATA_DIR / "projects"
IDLE_PRINT_STATES = {"standby", "complete", "cancelled", "error"}

slice_lock = asyncio.Lock()
jobs: dict[str, dict] = {}   # in-memory job state; results are also written to meta.json


# ---------------------------------------------------------------- orca data, settings, presets

orca = {"tag": None, "status": "starting", "error": None, "dir": None}
lib: P.Library | None = None


def orca_tag() -> str:
    """'v2.5.1' from the CLI's banner ('OrcaSlicer-2.5.1:')."""
    import subprocess
    try:
        out = subprocess.run([ORCA_BIN, "--help"], capture_output=True, text=True, timeout=60).stdout
        m = re.search(r"OrcaSlicer-([\d.]+)", out)
        return "v" + m.group(1) if m else "unknown"
    except Exception:
        return "unknown"


def load_settings() -> dict:
    try:
        return json.loads(SETTINGS_FILE.read_text())
    except (OSError, ValueError):
        return {"setup_done": False, "machines": []}


def save_settings(st: dict) -> None:
    SETTINGS_FILE.write_text(json.dumps(st, indent=1))


def build_library() -> None:
    global lib
    system = orca["dir"] / "profiles" if orca["dir"] and (orca["dir"] / "profiles").is_dir() else None
    lib = P.Library(PRESET_DIR, ORCA_DIR if ORCA_DIR.is_dir() else None, system)


async def ensure_orca_data() -> None:
    """Fetch Orca's settings catalogue + vendor profiles for this slicer version (once), and its defaults."""
    tag = await asyncio.to_thread(orca_tag)
    d = DATA_DIR / "orca" / tag
    orca.update(tag=tag, dir=d)
    try:
        if not (d / "catalog.json").is_file() or not (d / "profiles").is_dir():
            orca["status"] = "downloading"
            proc = await asyncio.create_subprocess_exec(
                sys.executable or "python3",
                str(TOOLS / "orca_data.py"), "--tag", tag, "--out", str(d),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            out, _ = await proc.communicate()
            if proc.returncode != 0:
                raise RuntimeError(out.decode("utf-8", "replace").strip().splitlines()[-1:] or "download failed")
        def scopes_ok():
            try:
                return "lines" in json.loads((d / "scopes.json").read_text())
            except (OSError, ValueError):
                return False
        if not scopes_ok():
            # which settings may be set per part (OrcaSlicer's object/region config classes)
            proc = await asyncio.create_subprocess_exec(sys.executable or "python3", str(TOOLS / "orca_scopes.py"), "--tag", tag,
                                                        "--out", str(d), stdout=asyncio.subprocess.DEVNULL,
                                                        stderr=asyncio.subprocess.DEVNULL)
            await proc.wait()       # optional: without it the page just can't offer per-part settings
        if not (d / "defaults.json").is_file():
            work = DATA_DIR / "tmp" / uuid.uuid4().hex
            work.mkdir(parents=True)
            try:
                p = await asyncio.create_subprocess_exec(ORCA_BIN, "--export-settings", str(work / "defaults.json"),
                                                         cwd=str(work), env={**os.environ, "HOME": str(work)},
                                                         stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                await p.wait()
                if (work / "defaults.json").is_file():
                    shutil.move(str(work / "defaults.json"), d / "defaults.json")
            finally:
                shutil.rmtree(work, ignore_errors=True)
        orca["status"] = "ready"
        prune_orca_data(d)
    except Exception as e:
        orca.update(status="failed", error=str(e)[:300])
    await asyncio.to_thread(build_library)


def prune_orca_data(current: Path) -> None:
    """Keep the data for this OrcaSlicer version and the most recent other one (so going back an image version is
    instant); delete older ones. Each version's settings list and vendor profiles take ~70 MB."""
    others = sorted((p for p in current.parent.iterdir() if p.is_dir() and p != current and not p.name.endswith(".tmp")),
                    key=lambda p: p.stat().st_mtime, reverse=True)
    for old in others[1:]:
        shutil.rmtree(old, ignore_errors=True)


def need_lib() -> P.Library:
    if lib is None:
        raise web.HTTPServiceUnavailable(text="Still starting up")
    return lib


def machine_rows(st: dict) -> list[dict]:
    enabled = set(st.get("machines", []))
    rows = [r for r in need_lib().listing("machine") if r["source"] != "system" or r["name"] in enabled]
    ok = []
    for r in rows:
        try:
            v = lib.resolve("machine", r["name"])
            r["bed"], r["height"] = v.get("printable_area"), v.get("printable_height")
            ok.append(r)
        except P.PresetError:
            pass                              # broken preset (missing parent): hide it
    return ok


def preset_rows(t: str, machine: str | None, show_all: bool) -> list[dict]:
    rows = []
    for r in need_lib().listing(t):
        if r["source"] == "system":
            generic = t == "filament" and r.get("vendor") == "OrcaFilamentLibrary" and r["name"].startswith("Generic ") \
                and r["name"].endswith("@System")
            explicit = lib.explicit_compat(t, r["name"])
            if explicit is None:
                continue                      # broken vendor preset (missing parent): hide it
            if not show_all and not generic:
                if not explicit or not machine or not lib.compatible(t, r["name"], machine):
                    continue
        r["compatible"] = bool(machine) and lib.compatible(t, r["name"], machine)
        if not show_all and machine and not r["compatible"]:
            continue
        rows.append(r)
    return rows


def pick(rows: list[dict], wanted: str | None, prefer: str = "") -> str | None:
    names = [r["name"] for r in rows]
    if wanted in names:
        return wanted
    # your own presets first (BicuSlicer, then OrcaSlicer desktop), then the vendor library
    for src in ("user", "orca", "system"):
        mine = [r["name"] for r in rows if r["source"] == src and not r["name"].endswith("- Copy")]
        for n in mine:
            if prefer and prefer.lower() in n.lower():
                return n
        if mine:
            return mine[0]
    return names[0] if names else None


# ---------------------------------------------------------------- jobs

def safe_stem(name: str) -> str:
    stem = Path(name).stem
    stem = re.sub(r"[^A-Za-z0-9._ +-]+", "_", stem).strip(" .") or "model"
    return stem[:80]


def save_meta(job: dict) -> None:
    d = JOBS / job["id"]
    d.mkdir(parents=True, exist_ok=True)
    (d / "meta.json").write_text(json.dumps(job, indent=1))


def prune_jobs() -> None:
    if not JOBS.is_dir():
        return
    dirs = sorted((p for p in JOBS.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in dirs[KEEP_JOBS:]:
        jobs.pop(old.name, None)
        shutil.rmtree(old, ignore_errors=True)


def get_job(job_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{32}", job_id or ""):
        raise web.HTTPNotFound()
    job = jobs.get(job_id)
    if job is None:
        meta = JOBS / job_id / "meta.json"
        if not meta.is_file():
            raise web.HTTPNotFound()
        job = json.loads(meta.read_text())
        jobs[job_id] = job
    return job


def build_datadir(job_dir: Path, picks: dict, edits: dict) -> tuple[Path, dict]:
    """A private Orca data dir holding standalone (fully resolved) copies of the three chosen presets,
    with unsaved edits from the page applied. Nothing outside the job folder is written."""
    dd = job_dir / "orca"
    (dd / "system").mkdir(parents=True)
    files = {}
    for t in KINDS:
        name = picks[t]
        flat = need_lib().flattened(t, name, edits.get(t) or {})
        if t != "machine":
            # compatibility was checked on the page; standalone copies have no parents to match
            flat["compatible_printers"] = []
            flat["compatible_printers_condition"] = ""
            if t == "filament":
                flat["compatible_prints"] = []
                flat["compatible_prints_condition"] = ""
        d = dd / "user" / "default" / t
        d.mkdir(parents=True, exist_ok=True)
        if not ALLOW_POST_PROCESS:
            # removed, not emptied: OrcaSlicer's default is no scripts, and an explicit [] crashes the 2.5.1 CLI
            flat.pop("post_process", None)
        f = d / f"{name}.json"
        f.write_text(json.dumps(flat, indent=4))
        files[t] = f
    return dd, files


def clean_3mf(path: Path) -> None:
    """Rewrite an uploaded 3MF without embedded project settings, presets, G-code or post-processing settings."""
    try:
        with zipfile.ZipFile(path) as z:
            infos = z.infolist()
            drop = {i.filename for i in infos if i.filename.lower().startswith("metadata/") and i.filename.lower() not in KEEP_3MF_METADATA}
            ms = next((i for i in infos if i.filename.lower() == "metadata/model_settings.config"), None)
            risky = ms is not None and b"post_process" in z.read(ms)
            if not drop and not risky:
                return
            tmp = path.with_name(path.name + ".clean")
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
                for i in infos:
                    if i.filename in drop:
                        continue
                    data = z.read(i)
                    if i is ms:
                        data = re.sub(rb'<metadata\s+key="post_process"[^>]*/>', b"", data)
                    out.writestr(i, data, compress_type=zipfile.ZIP_DEFLATED)
        tmp.replace(path)
    except zipfile.BadZipFile:
        raise ValueError("That 3MF file is damaged (it isn't a valid zip)")


THUMB_SIZE = re.compile(r"^\d{1,4}x\d{1,4}$")


def inject_thumbnails(gcode: Path, thumbs: dict) -> int:
    """Put PNG thumbnails into the G-code the way OrcaSlicer/PrusaSlicer write them (base64 in "; thumbnail
    begin WxH len" comment blocks right after the header), so Moonraker/Mainsail show a file preview.
    The headless OrcaSlicer CLI can't render them itself (no OpenGL), so the page renders and sends them."""
    blocks = []
    for size, b64 in sorted(thumbs.items(), key=lambda kv: int(kv[0].split("x")[0]) if THUMB_SIZE.match(kv[0]) else 0):
        if not THUMB_SIZE.match(size) or not isinstance(b64, str):
            continue
        try:
            raw = base64.b64decode(b64, validate=True)
        except ValueError:
            continue
        if raw[:8] != b"\x89PNG\r\n\x1a\n" or len(raw) > 1_500_000:
            continue
        data = base64.b64encode(raw).decode()
        w, h = size.split("x")
        body = "".join(f"; {data[i:i + 78]}\n" for i in range(0, len(data), 78))
        blocks.append(f";\n; thumbnail begin {w}x{h} {len(data)}\n{body}; thumbnail end\n;\n")
    if not blocks:
        return 0
    tmp = gcode.with_suffix(".thumb.tmp")
    with gcode.open("rb") as src, tmp.open("wb") as dst:
        head = src.read(65536)
        marker = b"; HEADER_BLOCK_END\n"
        cut = head.find(marker)
        cut = cut + len(marker) if cut >= 0 else 0
        dst.write(head[:cut])
        dst.write("".join(blocks).encode())
        dst.write(head[cut:])
        shutil.copyfileobj(src, dst, 1 << 20)
    tmp.replace(gcode)
    return len(blocks)


def gcode_filament_mm(gcode: Path) -> float | None:
    """Orca writes '; filament used [mm] = N' in the G-code's summary block (start or end)."""
    pattern = re.compile(r"; filament used \[mm\] = ([\d.]+)")
    try:
        size = gcode.stat().st_size
        with gcode.open("rb") as fh:
            for offset in (0, max(0, size - 200_000)):
                fh.seek(offset)
                m = pattern.search(fh.read(200_000).decode("utf-8", "replace"))
                if m:
                    return float(m.group(1))
    except OSError:
        pass
    return None


async def run_slice(job: dict, form: dict) -> None:
    job_dir = JOBS / job["id"]
    out = job_dir / "out"
    try:
        async with slice_lock:
            job["status"] = "slicing"
            job["started"] = time.time()
            save_meta(job)
            if job["model"].endswith(".3mf"):
                await asyncio.to_thread(clean_3mf, job_dir / job["model"])
            dd, files = await asyncio.to_thread(build_datadir, job_dir, {t: form[t] for t in KINDS}, job["edits"])
            out.mkdir(exist_ok=True)
            cmd = [ORCA_BIN, "--datadir", str(dd),
                   "--load-settings", f"{files['machine']};{files['process']}",
                   "--load-filaments", str(files["filament"]),
                   # The page sends a ready-made plate (3MF with each model placed and oriented): arrange=0 keeps it as laid out.
                   "--arrange", "0" if form.get("arrange") == "0" else "1",
                   "--orient", "1" if form.get("orient") == "1" else "0"]
            scale = float(form.get("scale") or 100) / 100
            if abs(scale - 1) > 1e-6:
                if not 0.01 <= scale <= 20:
                    raise ValueError("Scale must be between 1% and 2000%")
                cmd += ["--scale", f"{scale:g}"]
            cmd += ["--slice", "0", "--export-statistics", "--outputdir", str(out), str(job_dir / job["model"])]
            env = {**os.environ, "HOME": str(job_dir)}
            proc = await asyncio.create_subprocess_exec(*cmd, cwd=str(dd), env=env,
                                                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            try:
                log, _ = await asyncio.wait_for(proc.communicate(), SLICE_TIMEOUT)
            except asyncio.TimeoutError:
                proc.kill()
                raise RuntimeError(f"Slicing took longer than {SLICE_TIMEOUT // 60} minutes and was stopped")
            (job_dir / "slice.log").write_bytes(log)
            shutil.rmtree(dd, ignore_errors=True)

        tj = job_dir / "thumbs.json"
        if tj.is_file():
            try:
                thumbs = json.loads(tj.read_text())
                for g in out.glob("plate_*.gcode"):
                    await asyncio.to_thread(inject_thumbnails, g, thumbs if isinstance(thumbs, dict) else {})
            except (ValueError, OSError):
                pass            # a missing preview never fails a slice
        result = {}
        rj = out / "result.json"
        if rj.is_file():
            result = json.loads(rj.read_text())
        plates = []
        for g in sorted(out.glob("plate_*.gcode"), key=lambda x: int(re.findall(r"\d+", x.stem)[0])):
            n = int(re.findall(r"\d+", g.stem)[0])
            stats = {}
            sf = out / f"plate_{n}.statistics.json"
            if sf.is_file():
                stats = json.loads(sf.read_text()).get("summary", {})
            plates.append({"plate": n, "file": g.name, "time_s": stats.get("time"),
                           "weight_g": stats.get("weight"), "layers": stats.get("layer_count"),
                           "cost": stats.get("filament_cost"), "filament_mm": gcode_filament_mm(g),
                           "size": g.stat().st_size, "uploaded": None})
        if not plates:
            msg = result.get("error_string") or "Slicing failed"
            tail = log.decode("utf-8", "replace").strip().splitlines()[-3:]
            raise RuntimeError(f"{msg} {' / '.join(tail)}".strip())
        job.update(status="done", plates=plates, finished=time.time(),
                   warnings=[w.get("msg", str(w)) if isinstance(w, dict) else str(w) for w in result.get("warnings", [])]
                   + [pl.get("warning_message") for pl in result.get("sliced_plates", []) if pl.get("warning_message")])
    except Exception as e:  # report every failure to the page
        job.update(status="error", error=getattr(e, "text", None) or str(e) or e.__class__.__name__,
                   finished=time.time())
    finally:
        save_meta(job)


# ---------------------------------------------------------------- printer connections

printers = H.Store(DATA_DIR / "printers.json")


def migrate_printers() -> None:
    machines = []
    if lib:
        for src in (lib.user, lib.orca):
            for name in src["machine"]:
                try:
                    values = lib.resolve("machine", name)
                except P.PresetError:
                    # the vendor library may not be loaded yet at startup: the preset's own fields are enough here
                    values = {k: v for k, v in lib.find("machine", name)[1].items() if k not in P.META_KEYS}
                machines.append((name, values))
    H.migrate(printers, MOONRAKER, PRINTER_UI_URL, machines)


def pick_printer(request, job: dict | None = None) -> dict:
    pid = request.query.get("printer")
    p = printers.get(pid) if pid else printers.for_machine(request.query.get("machine") or (job or {}).get("machine"))
    if not p:
        raise web.HTTPConflict(text="No printer connection set up yet: add one under Printers")
    return p


async def host_call(coro):
    try:
        return await coro
    except H.HostError as e:
        raise web.HTTPBadGateway(text=str(e))


# ---------------------------------------------------------------- routes

routes = web.RouteTableDef()


@routes.get("/favicon.ico")
async def favicon(_):
    return web.FileResponse(STATIC / "brand" / "favicon.ico", headers={"Cache-Control": "max-age=86400"})


@routes.get("/manifest.webmanifest")
async def manifest(_):
    return web.Response(body=(STATIC / "manifest.webmanifest").read_bytes(), content_type="application/manifest+json",
                        headers={"Cache-Control": "no-cache"})


@routes.get("/")
async def index(_):
    return web.FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@routes.get("/api/state")
async def api_state(_):
    st = load_settings()
    return web.json_response({
        "orca": {k: orca[k] for k in ("tag", "status", "error")},
        "setup_done": bool(st.get("setup_done")),
        "has_orca_presets": bool(lib and any(lib.orca[t] for t in KINDS)),
        "has_user_presets": bool(lib and any(lib.user[t] for t in KINDS)),
        "machines_enabled": st.get("machines", []),
        "bed_types": st.get("bed_types", {}),
    })


BED_TYPES = ("Cool Plate", "Engineering Plate", "High Temp Plate", "Textured PEI Plate", "Textured Cool Plate", "Supertack Plate")


@routes.post("/api/bed-type")
async def api_bed_type(request):
    """The plate type fitted to a printer (OrcaSlicer's curr_bed_type), saved per printer preset for every device."""
    body = await request.json()
    machine, bed = str(body.get("machine") or ""), str(body.get("bed_type") or "")
    try:
        need_lib().find("machine", machine)
    except P.PresetError:
        raise web.HTTPBadRequest(text="Unknown printer")
    allowed = BED_TYPES
    f = orca["dir"] / "catalog.json" if orca["dir"] else None
    if f and f.is_file():
        allowed = tuple(json.loads(f.read_text())["options"].get("curr_bed_type", {}).get("enum_values") or BED_TYPES)
    if bed not in allowed:
        raise web.HTTPBadRequest(text="Unknown plate type")
    st = load_settings()
    st.setdefault("bed_types", {})[machine] = bed
    save_settings(st)
    return web.json_response({"machine": machine, "bed_type": bed})


_catalog_cache: dict = {}


@routes.get("/api/catalog")
async def api_catalog(_):
    f = orca["dir"] / "catalog.json" if orca["dir"] else None
    if not f or not f.is_file():
        raise web.HTTPServiceUnavailable(text=f"Settings catalogue not available yet ({orca['status']})")
    sc = f.parent / "scopes.json"
    key = (str(f), f.stat().st_mtime, sc.stat().st_mtime if sc.is_file() else 0)
    if _catalog_cache.get("key") != key:
        cat = json.loads(f.read_text())
        part = []
        if sc.is_file():
            scopes = json.loads(sc.read_text())
            allowed = set(scopes.get("object", [])) | set(scopes.get("region", []))
            part = [k for k in cat.get("type_options", {}).get("process", []) if k in allowed and k in cat["options"]]
            # OrcaSlicer's named rows (e.g. "Cool Plate" = first-layer + other-layers bed temperature)
            for k, ln in (scopes.get("lines") or {}).items():
                if k in cat["options"]:
                    cat["options"][k]["line"] = ln.get("label")
                    cat["options"][k]["line_tooltip"] = ln.get("tooltip") or None
        cat["part_options"] = part          # process settings OrcaSlicer allows per part
        _catalog_cache.update(key=key, body=json.dumps(cat).encode())
    return web.Response(body=_catalog_cache["body"], content_type="application/json",
                        headers={"Cache-Control": "no-cache"})


@routes.get("/api/defaults")
async def api_defaults(_):
    f = orca["dir"] / "defaults.json" if orca["dir"] else None
    if not f or not f.is_file():
        return web.json_response({})
    return web.FileResponse(f, headers={"Cache-Control": "max-age=3600"})


@routes.get("/api/presets")
async def api_presets(request):
    """Preset lists for the three pickers. ?machine= filters process/filament by compatibility; ?all=1 shows everything."""
    st = load_settings()
    q = request.query
    show_all = q.get("all") == "1"
    machines = await asyncio.to_thread(machine_rows, st)
    machine = pick(machines, q.get("machine"))
    process = await asyncio.to_thread(preset_rows, "process", machine, show_all)
    filament = await asyncio.to_thread(preset_rows, "filament", machine, show_all)
    return web.json_response({
        "presets": {"machine": machines, "process": process, "filament": filament},
        "selected": {"machine": machine, "process": pick(process, q.get("process"), "0.20mm"),
                     "filament": pick(filament, q.get("filament"), "PLA")},
    })


def preset_kind(request) -> str:
    t = request.match_info["type"]
    if t not in KINDS:
        raise web.HTTPNotFound()
    return t


@routes.get("/api/presets/{type}/{name}")
async def api_preset(request):
    t, name = preset_kind(request), request.match_info["name"]
    L = need_lib()
    try:
        source, raw = L.find(t, name)
        values = L.resolve(t, name)
        parent = L.parent_values(t, name)
    except P.PresetError as e:
        raise web.HTTPNotFound(text=str(e))
    return web.json_response({
        "type": t, "name": name, "source": source.split(":")[0], "vendor": source.split(":", 1)[1] if ":" in source else None,
        "editable": source == "user", "inherits": raw.get("inherits") or "",
        "own": [k for k in raw if k not in P.META_KEYS],
        "values": values, "parent": parent, "ancestors": L.ancestors(t, name)[1:],
    })


@routes.post("/api/presets/{type}")
async def api_preset_save(request):
    """Create, update or rename a BicuSlicer preset. Body: {name, inherits, values, replace?}.
    'values' is the full set of settings wanted; only differences from 'inherits' are stored."""
    t = preset_kind(request)
    body = await request.json()
    name = str(body.get("name", "")).strip()
    L = need_lib()
    try:
        if body.get("replace") is None and (name in L.user[t] or name in L.orca[t] or (t, name) in L.system_meta):
            if not body.get("overwrite"):
                raise P.PresetError(f"A {t} preset named '{name}' already exists")
        preset = await asyncio.to_thread(need_lib().save_user, t, name, str(body.get("inherits") or ""),
                                         dict(body.get("values") or {}), body.get("replace"))
    except P.PresetError as e:
        raise web.HTTPBadRequest(text=str(e))
    return web.json_response({"saved": preset["name"]})


@routes.delete("/api/presets/{type}/{name}")
async def api_preset_delete(request):
    t, name = preset_kind(request), request.match_info["name"]
    try:
        await asyncio.to_thread(need_lib().delete_user, t, name)
    except P.PresetError as e:
        raise web.HTTPBadRequest(text=str(e))
    return web.json_response({"deleted": name})


@routes.get("/api/presets/{type}/{name}/export")
async def api_preset_export(request):
    t, name = preset_kind(request), request.match_info["name"]
    try:
        flat = need_lib().flattened(t, name)
    except P.PresetError as e:
        raise web.HTTPNotFound(text=str(e))
    fname = re.sub(r'[^A-Za-z0-9._@ +-]+', "_", name) + ".json"
    return web.Response(body=json.dumps(flat, indent=4), content_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@routes.post("/api/presets-export")
async def api_presets_export(request):
    body = await request.json()
    items = [(i[0], i[1]) for i in body.get("items", []) if isinstance(i, list) and len(i) == 2 and i[0] in KINDS]
    if not items:
        raise web.HTTPBadRequest(text="Nothing to export")
    try:
        data = await asyncio.to_thread(need_lib().export_bundle, items)
    except P.PresetError as e:
        raise web.HTTPBadRequest(text=str(e))
    return web.Response(body=data, content_type="application/zip",
                        headers={"Content-Disposition": 'attachment; filename="bicuslicer-presets.zip"'})


@routes.post("/api/presets-import")
async def api_presets_import(request):
    reader = await request.multipart()
    results = []
    async for part in reader:
        if part.name == "file" and part.filename:
            data = await part.read(decode=False)
            if len(data) > 50_000_000:
                raise web.HTTPBadRequest(text="That file is too big")
            try:
                results += await asyncio.to_thread(need_lib().import_file, part.filename, data)
            except P.PresetError as e:
                results.append({"file": part.filename, "error": str(e)})
    return web.json_response({"results": results})


@routes.get("/api/vendors")
async def api_vendors(_):
    """Printer models in Orca's vendor library, with their machine presets (one per nozzle size)."""
    L = need_lib()
    out = {}
    for (t, name), meta in L.system_meta.items():
        if t != "machine" or meta["instantiation"] != "true":
            continue
        v = out.setdefault(meta["vendor"], {"vendor": meta["vendor"], "name": L.vendors.get(meta["vendor"], {}).get("name", meta["vendor"]), "models": {}})
        model = meta.get("model") or name
        v["models"].setdefault(model, []).append({"preset": name, "nozzle": meta.get("variant")})
    rows = []
    for v in sorted(out.values(), key=lambda x: x["name"].lower()):
        rows.append({"vendor": v["vendor"], "name": v["name"],
                     "models": [{"model": m, "presets": sorted(p, key=lambda x: str(x["nozzle"]))} for m, p in sorted(v["models"].items())]})
    return web.json_response(rows)


@routes.post("/api/setup")
async def api_setup(request):
    """First-run choices: enabled vendor printers, plus an optional custom printer."""
    body = await request.json()
    st = load_settings()
    L = need_lib()
    machines = [m for m in body.get("machines", []) if ("machine", m) in L.system_meta]
    st["machines"] = sorted(set(machines) | (set(st.get("machines", [])) if body.get("add") else set()))
    created = None
    c = body.get("custom")
    if c:
        try:
            w, d, h = (float(c[k]) for k in ("width", "depth", "height"))
            nozzle = float(c.get("nozzle") or 0.4)
            assert 20 <= w <= 2000 and 20 <= d <= 2000 and 10 <= h <= 2000 and 0.1 <= nozzle <= 2
        except (KeyError, ValueError, TypeError, AssertionError):
            raise web.HTTPBadRequest(text="Check the bed size (20–2000 mm) and nozzle (0.1–2 mm)")
        flavor = {"klipper": "MyKlipper", "marlin": "MyMarlin", "rrf": "MyRRF", "repetier": "MyRepetier"}.get(c.get("flavor"), "MyKlipper")
        noz = f"{nozzle:g}"
        base = next((n for n in (f"{flavor} {noz} nozzle", f"{flavor} 0.4 nozzle", "MyKlipper 0.4 nozzle")
                     if ("machine", n) in L.system_meta), None)
        if not base:
            raise web.HTTPServiceUnavailable(text="The vendor library isn't downloaded yet")
        values = L.resolve("machine", base)
        values.update({"printable_area": [f"0x0", f"{w:g}x0", f"{w:g}x{d:g}", f"0x{d:g}"],
                       "printable_height": f"{h:g}", "nozzle_diameter": [noz] * len(values.get("nozzle_diameter") or [1])})
        name = str(c.get("name") or "My printer").strip()
        try:
            await asyncio.to_thread(L.save_user, "machine", name, base, values)
        except P.PresetError as e:
            raise web.HTTPBadRequest(text=str(e))
        created = name
    if body.get("done", True):
        st["setup_done"] = True
    save_settings(st)
    return web.json_response({"ok": True, "created": created, "machines": st["machines"]})


@routes.get("/api/printer")
async def api_printer(request):
    """Status of the printer for ?machine= (its linked connection, else the active one), or ?printer=<id>."""
    try:
        p = pick_printer(request)
    except web.HTTPConflict:
        return web.json_response({"configured": False, "online": False, "message": "No printer connection"})
    info = {"configured": True, "id": p["id"], "name": p["name"], "type": p["host_type"], "ui": H.webui_url(p)}
    try:
        st = await H.backend(p).status()
    except H.HostError as e:
        st = {"online": False, "message": str(e), "idle": False}
    return web.json_response({**st, **info})


@routes.get("/api/printers")
async def api_printers(_):
    return web.json_response({"printers": [printers.public(p) for p in printers.printers],
                              "active": printers.data.get("active"), "types": H.types_info()})


@routes.post("/api/printers")
async def api_printer_save(request):
    body = await request.json()
    try:
        p = printers.upsert(body)
    except H.HostError as e:
        raise web.HTTPBadRequest(text=str(e))
    return web.json_response(printers.public(p))


@routes.delete("/api/printers/{id}")
async def api_printer_delete(request):
    printers.delete(request.match_info["id"])
    return web.json_response({"deleted": request.match_info["id"]})


@routes.post("/api/printers/active")
async def api_printer_active(request):
    body = await request.json()
    if not printers.get(body.get("id")):
        raise web.HTTPNotFound(text="No such printer")
    printers.data["active"] = body["id"]
    printers.save()
    return web.json_response({"active": body["id"]})


# ---------------------------------------------------------------- STEP import: OpenCascade in the browser
# The OrcaSlicer CLI can't read STEP. The page converts it with occt-import-js (OpenCascade compiled to WebAssembly,
# LGPL-2.1, https://github.com/kovacsv/occt-import-js). Its 7.8 MB aren't bundled: the server fetches them the first
# time someone opens a STEP file, checks them against these checksums, and serves them from DATA_DIR afterwards.

OCCT_VERSION = "0.0.22"
OCCT_FILES = {
    "occt-import-js.js": "626b2d27e29f079d43e2d30e035a11779dc28208df373bf4cc90e6321e559df5",
    "occt-import-js.wasm": "08201564f0954a19d55f289226c85bbe909a9f1762d5cf4c44ee626d83d8cbee",
}
OCCT_URL = os.environ.get("OCCT_URL", f"https://unpkg.com/occt-import-js@{OCCT_VERSION}/dist/").rstrip("/") + "/"
OCCT_DIR = DATA_DIR / "ext" / f"occt-import-js-{OCCT_VERSION}"
_occt_lock = asyncio.Lock()


async def fetch_occt() -> None:
    import hashlib
    OCCT_DIR.mkdir(parents=True, exist_ok=True)
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=300)) as s:
        for name, sha in OCCT_FILES.items():
            dest = OCCT_DIR / name
            if dest.is_file():
                continue
            async with s.get(OCCT_URL + name) as r:
                if r.status != 200:
                    raise RuntimeError(f"{name}: download answered {r.status}")
                data = await r.read()
            if hashlib.sha256(data).hexdigest() != sha:
                raise RuntimeError(f"{name}: the download doesn't match its checksum")
            tmp = dest.with_suffix(dest.suffix + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(dest)


@routes.get("/ext/occt/{file}")
async def ext_occt(request):
    name = request.match_info["file"]
    if name not in OCCT_FILES:
        raise web.HTTPNotFound()
    path = OCCT_DIR / name
    if not path.is_file():
        async with _occt_lock:
            if not path.is_file():
                try:
                    await fetch_occt()
                except (aiohttp.ClientError, TimeoutError, RuntimeError, OSError) as e:
                    raise web.HTTPServiceUnavailable(
                        text=f"Opening STEP files needs a one-off download of OpenCascade (7.8 MB), which failed: {e}")
    ctype = "application/wasm" if name.endswith(".wasm") else "text/javascript"
    return web.FileResponse(path, headers={"Content-Type": ctype, "Cache-Control": "public, max-age=31536000, immutable"})


# ---------------------------------------------------------------- printer view (OrcaSlicer's Device tab)

def printer_or_404(request) -> dict:
    p = printers.get(request.match_info["id"])
    if not p:
        raise web.HTTPNotFound(text="No such printer")
    return p


@routes.get("/api/printers/{id}/detail")
async def api_printer_detail(request):
    p = printer_or_404(request)
    info = {"configured": True, "id": p["id"], "name": p["name"], "type": p["host_type"], "ui": H.webui_url(p)}
    try:
        st = await H.backend(p).detail()
    except H.HostError as e:
        st = {"online": False, "message": str(e), "idle": False}
    return web.json_response({**st, **info})


@routes.post("/api/printers/{id}/action")
async def api_printer_action(request):
    """Pause, resume, cancel, emergency stop, firmware restart, home; or set nozzle / bed temperature, speed, flow, fan."""
    p = printer_or_404(request)
    body = await request.json()
    name = body.get("action")
    if name not in H.ACTIONS:
        raise web.HTTPBadRequest(text="Unknown action")
    value = None
    if H.ACTIONS[name]:
        lo, hi = H.ACTIONS[name]
        try:
            value = float(body.get("value"))
        except (TypeError, ValueError):
            raise web.HTTPBadRequest(text="Enter a number")
        if not lo <= value <= hi:
            raise web.HTTPBadRequest(text=f"Enter a value from {lo} to {hi}")
    try:
        await H.backend(p).action(name, value)
    except H.HostError as e:
        raise web.HTTPBadGateway(text=str(e))
    return web.json_response({"ok": True})


_cams: dict[str, tuple[float, list]] = {}


async def printer_cams(p: dict) -> list:
    hit = _cams.get(p["id"])
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    try:
        cams = await H.backend(p).webcams()
    except H.HostError:
        cams = []
    _cams[p["id"]] = (time.time(), cams)
    return cams


@routes.get("/api/printers/{id}/webcams")
async def api_printer_webcams(request):
    p = printer_or_404(request)
    cams = await printer_cams(p)
    # the page gets our own URLs (proxied, same origin), never the camera's
    return web.json_response([{"index": i, "name": c["name"], "service": c["service"], "stream": bool(c["stream"]),
                               "snapshot": bool(c["snapshot"]), "flip_h": c["flip_h"], "flip_v": c["flip_v"],
                               "rotation": c["rotation"], "aspect": c["aspect"]} for i, c in enumerate(cams)])


def cam_or_404(cams: list, request) -> dict:
    try:
        return cams[int(request.match_info["n"])]
    except (ValueError, IndexError):
        raise web.HTTPNotFound(text="No such camera")


@routes.get("/api/printers/{id}/webcam/{n}/snapshot")
async def api_printer_snapshot(request):
    """One camera frame, fetched by the server (the camera is often only reachable on the LAN, or behind a login)."""
    p = printer_or_404(request)
    cam = cam_or_404(await printer_cams(p), request)
    if not cam["snapshot"]:
        raise web.HTTPNotFound(text="This camera has no snapshot URL")
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as s:
            async with s.get(cam["snapshot"], ssl=H._ssl(p)) as r:
                if r.status != 200:
                    raise web.HTTPBadGateway(text=f"Camera answered {r.status}")
                data = await r.read()
                ctype = r.headers.get("Content-Type", "image/jpeg").split(";")[0]
    except (aiohttp.ClientError, TimeoutError):
        raise web.HTTPBadGateway(text="Can't reach the camera")
    if not ctype.startswith("image/"):
        raise web.HTTPBadGateway(text="The camera didn't send an image")
    return web.Response(body=data, content_type=ctype, headers={"Cache-Control": "no-store"})


@routes.get("/api/printers/{id}/webcam/{n}/stream")
async def api_printer_stream(request):
    """The camera's MJPEG stream, passed through (multipart/x-mixed-replace), until the page closes it."""
    p = printer_or_404(request)
    cam = cam_or_404(await printer_cams(p), request)
    if not cam["stream"] or "mjpeg" not in cam["service"].lower():
        raise web.HTTPNotFound(text="No MJPEG stream for this camera")
    resp = None
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=30)) as s:
            async with s.get(cam["stream"], ssl=H._ssl(p)) as r:
                ctype = r.headers.get("Content-Type", "")
                if r.status != 200 or not ctype.lower().startswith("multipart/"):
                    raise web.HTTPBadGateway(text="The camera isn't sending an MJPEG stream")
                resp = web.StreamResponse(headers={"Content-Type": ctype, "Cache-Control": "no-store", "X-Accel-Buffering": "no"})
                await resp.prepare(request)
                async for chunk in r.content.iter_any():
                    await resp.write(chunk)
    except (aiohttp.ClientError, TimeoutError):
        if resp is None:
            raise web.HTTPBadGateway(text="Can't reach the camera")
    except (ConnectionResetError, asyncio.CancelledError):
        pass               # the page closed the stream
    return resp or web.Response(status=204)


@routes.get("/api/printers/{id}/thumb")
async def api_printer_thumb(request):
    """The thumbnail inside the G-code file the printer is printing (Moonraker)."""
    p = printer_or_404(request)
    fn = request.query.get("file", "")
    try:
        data = await H.backend(p).file_thumb(fn) if fn else None
    except H.HostError:
        data = None
    if not data:
        raise web.HTTPNotFound(text="No thumbnail")
    return web.Response(body=data, content_type="image/png", headers={"Cache-Control": "max-age=3600"})


@routes.post("/api/printers/test")
async def api_printer_test(request):
    """Try a connection as entered in the form (blank secrets fall back to the saved ones)."""
    body = await request.json()
    saved = printers.get(body.get("id")) or {}
    p = {**saved, **{k: v for k, v in body.items() if k in H.FIELDS and not (k in H.SECRET_FIELDS and not v)}}
    p.setdefault("name", "test")
    try:
        b = H.backend(p)
        res = await b.test()
        try:
            st = await b.status()
            res["state"] = st.get("state")
        except H.HostError:
            pass
        return web.json_response(res)
    except H.HostError as e:
        return web.json_response({"ok": False, "message": str(e)})


@routes.post("/api/slice")
async def api_slice(request: web.Request):
    reader = await request.multipart()
    form, model_name, job_id = {}, None, uuid.uuid4().hex
    job_dir = JOBS / job_id
    job_dir.mkdir(parents=True)
    try:
        async for part in reader:
            if part.name == "model" and part.filename:
                ext = Path(part.filename).suffix.lower()
                if ext not in MODEL_EXT:
                    raise web.HTTPBadRequest(text="Use an STL, 3MF or OBJ file")
                model_name = "model" + ext
                with (job_dir / model_name).open("wb") as fh:
                    while chunk := await part.read_chunk(1 << 20):
                        fh.write(chunk)
                form["original"] = part.filename
            elif part.name == "edits":
                form["edits"] = await part.text()
            elif part.name == "thumbs":
                raw = await part.read(decode=False)
                if len(raw) < 4_000_000:
                    (job_dir / "thumbs.json").write_bytes(raw)
            elif part.name:
                form[part.name] = (await part.text())[:200]
        if not model_name:
            raise web.HTTPBadRequest(text="No model file was uploaded")
        if form.get("name"):
            form["original"] = form["name"]
        for kind in KINDS:
            if not form.get(kind):
                raise web.HTTPBadRequest(text=f"Choose a {kind} preset")
            try:
                need_lib().find(kind, form[kind])
            except P.PresetError as e:
                raise web.HTTPBadRequest(text=str(e))
        try:
            edits = json.loads(form.get("edits") or "{}")
            assert isinstance(edits, dict) and all(isinstance(edits.get(t, {}), dict) for t in KINDS)
        except (ValueError, AssertionError):
            raise web.HTTPBadRequest(text="Bad settings data")
        edits = {t: edits.get(t) or {} for t in KINDS}
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    job = {"id": job_id, "status": "queued", "created": time.time(), "model": model_name,
           "name": safe_stem(form["original"]), "original": form["original"],
           "machine": form["machine"], "process": form["process"], "filament": form["filament"],
           "options": {k: form.get(k) for k in ("scale", "orient", "arrange")},
           "edits": edits}
    jobs[job_id] = job
    save_meta(job)
    prune_jobs()
    asyncio.get_running_loop().create_task(run_slice(job, form))
    return web.json_response(job)


tool_lock = asyncio.Semaphore(2)   # orient calls are quick; don't let a burst of them pile up


async def read_single_upload(request: web.Request, allowed: set[str], workdir: Path) -> Path:
    reader = await request.multipart()
    async for part in reader:
        if part.name == "model" and part.filename:
            ext = Path(part.filename).suffix.lower()
            if ext not in allowed:
                raise web.HTTPBadRequest(text=f"Expected a {' / '.join(sorted(allowed))} file")
            dest = workdir / ("input" + ext)
            with dest.open("wb") as fh:
                while chunk := await part.read_chunk(1 << 20):
                    fh.write(chunk)
            return dest
    raise web.HTTPBadRequest(text="No model file was uploaded")


async def run_orca_tool(workdir: Path, args: list[str], timeout: int = 180) -> str:
    async with tool_lock:
        proc = await asyncio.create_subprocess_exec(
            ORCA_BIN, *args, cwd=str(workdir), env={**os.environ, "HOME": str(workdir)},
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise web.HTTPGatewayTimeout(text="The slicer took too long")
    return out.decode("utf-8", "replace")


@routes.post("/api/orient")
async def api_orient(request: web.Request):
    """Ask Orca's auto-orient which direction of this mesh should face the bed.
    The page uploads the object as it is currently rotated; the reply is a unit vector in that
    same frame, which the page then turns to point straight down."""
    work = DATA_DIR / "tmp" / uuid.uuid4().hex
    work.mkdir(parents=True)
    try:
        stl = await read_single_upload(request, {".stl"}, work)
        (work / "out").mkdir()
        log = await run_orca_tool(work, ["--orient", "1", "--arrange", "0", "--export-stls", str(work / "out"), str(stl)])
        m = re.findall(r"best:\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)", log)
        if not m:
            raise web.HTTPUnprocessableEntity(text="Auto-orient didn't return a result for this model")
        x, y, z = (float(v) for v in m[-1])
        n = (x * x + y * y + z * z) ** 0.5 or 1.0
        return web.json_response({"down": [x / n, y / n, z / n]})
    finally:
        shutil.rmtree(work, ignore_errors=True)


@routes.post("/api/repair")
async def api_repair(request: web.Request):
    """OrcaSlicer's "Fix model": close holes and cracks, fix normals. STL in (the part as the page has it), STL out."""
    work = DATA_DIR / "tmp" / uuid.uuid4().hex
    work.mkdir(parents=True)
    try:
        stl = await read_single_upload(request, {".stl"}, work)
        out = work / "out"
        out.mkdir()
        log = await run_orca_tool(work, ["--repair", "--arrange", "0", "--orient", "0", "--export-stls", str(out), str(stl)], timeout=300)
        stls = sorted(out.glob("*.stl"))
        if not stls:
            raise web.HTTPUnprocessableEntity(text="OrcaSlicer couldn't repair this part. " + " / ".join(log.strip().splitlines()[-2:]))
        if len(stls) == 1:
            body = stls[0].read_bytes()
        else:   # repair can split a part into shells: join them back into one STL
            tris, count = [], 0
            for f in stls:
                d = f.read_bytes()
                c = int.from_bytes(d[80:84], "little")
                tris.append(d[84:84 + c * 50])
                count += c
            body = b"\0" * 80 + count.to_bytes(4, "little") + b"".join(tris)
        fixed = re.findall(r"(?i)(\d+)\s+(?:facets? reversed|edges? fixed|holes? filled|degenerate)", log)
        return web.Response(body=body, content_type="model/stl", headers={"X-Repair-Log": str(len(fixed))})
    finally:
        shutil.rmtree(work, ignore_errors=True)


@routes.get("/api/jobs/{id}")
async def api_job(request):
    job = get_job(request.match_info["id"])
    body = dict(job)
    if job["status"] == "queued" and slice_lock.locked():
        body["note"] = "Waiting for another slice to finish"
    return web.json_response(body)


def plate_of(job: dict, n: str) -> dict:
    for pl in job.get("plates", []):
        if str(pl["plate"]) == n:
            return pl
    raise web.HTTPNotFound()


def gcode_name(job: dict, plate: dict) -> str:
    stamp = time.strftime("%y%m%d-%H%M", time.localtime(job["created"]))
    suffix = f"_plate{plate['plate']}" if len(job.get("plates", [])) > 1 else ""
    return f"{job['name']}{suffix}_{stamp}.gcode"


@routes.get("/api/jobs/{id}/plates/{n}/gcode")
async def api_gcode(request):
    job = get_job(request.match_info["id"])
    pl = plate_of(job, request.match_info["n"])
    return web.FileResponse(JOBS / job["id"] / "out" / pl["file"],
                            headers={"Content-Disposition": f'attachment; filename="{gcode_name(job, pl)}"'})


preview_lock = asyncio.Semaphore(2)


@routes.get("/api/jobs/{id}/plates/{n}/preview")
async def api_preview(request):
    """Compact toolpaths for the layer preview (built from the G-code on first request, then cached)."""
    job = get_job(request.match_info["id"])
    pl = plate_of(job, request.match_info["n"])
    out = JOBS / job["id"] / "out"
    bin_path = out / f"plate_{pl['plate']}.preview"
    gz_path = out / f"plate_{pl['plate']}.preview.gz"
    if not gz_path.is_file():
        async with preview_lock:
            if not gz_path.is_file():
                def make():
                    import gzip
                    gcode_preview.build(out / pl["file"], bin_path)
                    tmp = gz_path.with_suffix(".tmp")
                    tmp.write_bytes(gzip.compress(bin_path.read_bytes(), 6))
                    tmp.replace(gz_path)
                    bin_path.unlink(missing_ok=True)
                await asyncio.to_thread(make)
    if "gzip" in request.headers.get("Accept-Encoding", ""):
        return web.Response(body=gz_path.read_bytes(), content_type="application/octet-stream",
                            headers={"Content-Encoding": "gzip", "Cache-Control": "private, max-age=86400"})
    import gzip
    return web.Response(body=gzip.decompress(gz_path.read_bytes()), content_type="application/octet-stream")


@routes.post("/api/jobs/{id}/plates/{n}/upload")
async def api_upload(request):
    job = get_job(request.match_info["id"])
    pl = plate_of(job, request.match_info["n"])
    p = pick_printer(request, job)
    b = H.backend(p)
    start = request.query.get("start") == "1"
    if start:      # "Send and print": don't upload at all if it couldn't start anyway
        st = await host_call(b.status())
        if not st.get("idle"):
            raise web.HTTPConflict(text=f"{p['name']} isn't ready to start: {st.get('message') or st.get('state') or 'busy'}. Use Send only, or try again when it's free.")
    remote = await host_call(b.upload(JOBS / job["id"] / "out" / pl["file"], gcode_name(job, pl)))
    pl.update(uploaded=remote, uploaded_to=p["id"], uploaded_name=p["name"], started=None)
    save_meta(job)
    started = False
    if start:
        st = await host_call(b.status())          # check again: the upload can take a while
        if not st.get("idle"):
            return web.json_response({"uploaded": remote, "printer": p["name"], "started": False,
                                      "note": f"Sent, but {p['name']} became busy, so it wasn't started"})
        await host_call(b.start(remote))
        pl["started"] = time.time()
        save_meta(job)
        started = True
    return web.json_response({"uploaded": remote, "printer": p["name"], "started": started})


@routes.post("/api/jobs/{id}/plates/{n}/start")
async def api_start(request):
    job = get_job(request.match_info["id"])
    pl = plate_of(job, request.match_info["n"])
    if not pl.get("uploaded"):
        raise web.HTTPConflict(text="Send it to the printer first")
    p = printers.get(pl.get("uploaded_to")) or pick_printer(request, job)
    b = H.backend(p)
    st = await host_call(b.status())
    if not st.get("idle"):
        raise web.HTTPConflict(text=f"{p['name']} isn't ready to start: {st.get('message') or st.get('state') or 'busy'}")
    await host_call(b.start(pl["uploaded"]))
    pl["started"] = time.time()
    save_meta(job)
    return web.json_response({"started": pl["uploaded"], "printer": p["name"]})


# ---------------------------------------------------------------- projects
# A project = project.json (presets, unsaved process edits, and per part: name, rotation, scale, copies'
# positions, per-part settings) + one binary STL per part (its mesh, centred, unrotated) + thumb.png.

PROJECT_ID = re.compile(r"^[0-9a-f]{12}$")


def project_dir(pid: str) -> Path:
    if not PROJECT_ID.match(pid or ""):
        raise web.HTTPNotFound()
    return PROJECTS / pid


def project_summary(d: Path) -> dict | None:
    try:
        j = json.loads((d / "project.json").read_text())
    except (OSError, ValueError):
        return None
    return {"id": d.name, "name": j.get("name") or "Untitled", "created": j.get("created"), "updated": j.get("updated"),
            "parts": sum(len(m.get("instances") or [1]) for m in j.get("models", [])),
            "models": len(j.get("models", [])), "machine": (j.get("presets") or {}).get("machine"),
            "thumb": (d / "thumb.png").is_file()}


@routes.get("/api/projects")
async def api_projects(_):
    rows = [r for r in (project_summary(d) for d in PROJECTS.iterdir() if d.is_dir()) if r] if PROJECTS.is_dir() else []
    rows.sort(key=lambda r: r.get("updated") or 0, reverse=True)
    return web.json_response(rows)


@routes.get("/api/projects/{id}")
async def api_project(request):
    f = project_dir(request.match_info["id"]) / "project.json"
    if not f.is_file():
        raise web.HTTPNotFound(text="No such project")
    return web.FileResponse(f, headers={"Cache-Control": "no-cache"})


@routes.get("/api/projects/{id}/thumb.png")
async def api_project_thumb(request):
    f = project_dir(request.match_info["id"]) / "thumb.png"
    if not f.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(f, headers={"Cache-Control": "no-cache"})


@routes.get("/api/projects/{id}/mesh/{mid}")
async def api_project_mesh(request):
    mid = request.match_info["mid"]
    if not mid.isdigit():
        raise web.HTTPNotFound()
    f = project_dir(request.match_info["id"]) / f"mesh_{mid}.stl"
    if not f.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(f, headers={"Cache-Control": "no-cache"})


@routes.post("/api/projects")
async def api_project_save(request):
    """Multipart: 'project' (JSON; with 'id' to overwrite that project), 'mesh_<mid>' (binary STL per part), 'thumb' (PNG)."""
    reader = await request.multipart()
    tmp = PROJECTS / f".tmp-{uuid.uuid4().hex}"
    tmp.mkdir(parents=True)
    try:
        meta = None
        async for part in reader:
            if part.name == "project":
                raw = await part.read(decode=False)
                if len(raw) > 5_000_000:
                    raise web.HTTPBadRequest(text="Project data too large")
                meta = json.loads(raw)
            elif part.name == "thumb":
                data = await part.read(decode=False)
                if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) < 2_000_000:
                    (tmp / "thumb.png").write_bytes(data)
            elif part.name and re.fullmatch(r"mesh_\d+", part.name):
                with (tmp / f"{part.name}.stl").open("wb") as fh:
                    while chunk := await part.read_chunk(1 << 20):
                        fh.write(chunk)
        if not isinstance(meta, dict) or not isinstance(meta.get("models"), list):
            raise web.HTTPBadRequest(text="Bad project data")
        for m in meta["models"]:
            if not (tmp / f"mesh_{int(m.get('mid', -1))}.stl").is_file():
                raise web.HTTPBadRequest(text=f"Missing mesh for {m.get('name')}")
        pid = meta.get("id") if PROJECT_ID.match(str(meta.get("id") or "")) and (PROJECTS / str(meta.get("id"))).is_dir() else uuid.uuid4().hex[:12]
        old = PROJECTS / pid
        prev = {}
        if (old / "project.json").is_file():
            try:
                prev = json.loads((old / "project.json").read_text())
            except ValueError:
                pass
        now = time.time()
        meta.update(id=pid, name=str(meta.get("name") or "Untitled").strip()[:120] or "Untitled",
                    created=prev.get("created") or now, updated=now, version=1)
        (tmp / "project.json").write_text(json.dumps(meta))
        if old.exists():
            trash = PROJECTS / f".old-{uuid.uuid4().hex}"
            old.rename(trash)
            tmp.rename(old)
            shutil.rmtree(trash, ignore_errors=True)
        else:
            tmp.rename(old)
        return web.json_response(project_summary(old))
    except ValueError:
        raise web.HTTPBadRequest(text="Bad project data")
    finally:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)


@routes.post("/api/projects/{id}/rename")
async def api_project_rename(request):
    d = project_dir(request.match_info["id"])
    f = d / "project.json"
    if not f.is_file():
        raise web.HTTPNotFound(text="No such project")
    body = await request.json()
    name = str(body.get("name") or "").strip()[:120]
    if not name:
        raise web.HTTPBadRequest(text="Give the project a name")
    j = json.loads(f.read_text())
    j["name"] = name
    j["updated"] = time.time()
    f.write_text(json.dumps(j))
    return web.json_response(project_summary(d))


@routes.delete("/api/projects/{id}")
async def api_project_delete(request):
    d = project_dir(request.match_info["id"])
    if not d.is_dir():
        raise web.HTTPNotFound(text="No such project")
    shutil.rmtree(d)
    return web.json_response({"deleted": d.name})


@web.middleware
async def static_revalidate(request, handler):
    """Make browsers re-check the page's own scripts and styles on each load (cheap: ETag -> 304),
    so updates show up without a hard refresh. The vendored libraries can be cached normally."""
    resp = await handler(request)
    if request.path.startswith("/static/") and not request.path.startswith("/static/vendor/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@web.middleware
async def errors_as_text(request, handler):
    try:
        return await handler(request)
    except web.HTTPException as e:
        if e.status >= 400 and request.path.startswith("/api/"):
            return web.json_response({"error": e.text or e.reason}, status=e.status)
        raise


async def on_startup(app):
    await asyncio.to_thread(build_library)          # user + OrcaSlicer presets work straight away
    await asyncio.to_thread(migrate_printers)
    app["orca_task"] = asyncio.get_running_loop().create_task(ensure_orca_data())


def main():
    JOBS.mkdir(parents=True, exist_ok=True)
    PRESET_DIR.mkdir(parents=True, exist_ok=True)
    PROJECTS.mkdir(parents=True, exist_ok=True)
    for leftover in list(PROJECTS.glob(".tmp-*")) + list(PROJECTS.glob(".old-*")):   # interrupted saves
        shutil.rmtree(leftover, ignore_errors=True)
    shutil.rmtree(DATA_DIR / "tmp", ignore_errors=True)   # leftovers from orient calls
    # jobs that were mid-slice when the container stopped can't finish
    for meta in JOBS.glob("*/meta.json"):
        try:
            j = json.loads(meta.read_text())
            if j.get("status") in ("queued", "slicing"):
                j.update(status="error", error="Interrupted by a restart; slice again")
                meta.write_text(json.dumps(j, indent=1))
        except (OSError, ValueError):
            pass
    app = web.Application(client_max_size=MAX_UPLOAD_MB * 1024 * 1024, middlewares=[static_revalidate, errors_as_text])
    app.add_routes(routes)
    app.on_startup.append(on_startup)
    app.router.add_static("/static/", STATIC, append_version=False)
    web.run_app(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), access_log=None)


if __name__ == "__main__":
    main()
