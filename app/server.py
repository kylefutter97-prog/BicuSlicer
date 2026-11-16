"""BicuSlicer: a phone-friendly web front end for the OrcaSlicer command line.

Reads your OrcaSlicer presets (read-only), slices the plate the page builds with the
orca-slicer CLI in a per-job data dir, and sends G-code to a Klipper printer via Moonraker.
It has no login of its own: run it behind an authenticating reverse proxy or on a trusted network.
"""

import asyncio
import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path

import aiohttp
from aiohttp import web

ORCA_BIN = os.environ.get("ORCA_BIN", "/opt/orcaslicer/bin/orca-slicer")
ORCA_DIR = Path(os.environ.get("ORCA_DIR", "/orca"))           # OrcaSlicer data dir (read-only)
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
MOONRAKER = os.environ.get("MOONRAKER_URL", "http://localhost:7125").rstrip("/")
MOONRAKER_API_KEY = os.environ.get("MOONRAKER_API_KEY", "")     # only needed if Moonraker doesn't trust this host
PRINTER_UI_URL = os.environ.get("PRINTER_UI_URL", "")           # Mainsail/Fluidd link; default: the Moonraker host
UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "")             # sub-folder in Moonraker's gcodes root ("" = root)
KEEP_JOBS = int(os.environ.get("KEEP_JOBS", "20"))
SLICE_TIMEOUT = int(os.environ.get("SLICE_TIMEOUT", "900"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "300"))

STATIC = Path(__file__).parent / "static"
JOBS = DATA_DIR / "jobs"
MODEL_EXT = {".stl", ".3mf", ".obj"}   # the Orca CLI cannot read STEP (GUI only)
KINDS = ("machine", "process", "filament")
IDLE_PRINT_STATES = {"standby", "complete", "cancelled", "error"}

slice_lock = asyncio.Lock()
jobs: dict[str, dict] = {}   # in-memory job state; results are also written to meta.json


# ---------------------------------------------------------------- presets

def user_preset_dir() -> Path:
    base = ORCA_DIR / "user"
    if (base / "default").is_dir():
        return base / "default"
    subs = sorted(p for p in base.iterdir() if p.is_dir()) if base.is_dir() else []
    return subs[0] if subs else base / "default"


def load_presets() -> dict:
    out = {}
    for kind in KINDS:
        items = []
        for f in sorted((user_preset_dir() / kind).glob("*.json")):
            try:
                j = json.loads(f.read_text())
            except (OSError, ValueError):
                continue
            item = {"name": j.get("name", f.stem), "file": f.name}
            if kind == "machine":
                item["bed"] = j.get("printable_area")
                item["height"] = j.get("printable_height")
            items.append(item)
        out[kind] = items
    return out


def pick_defaults(presets: dict) -> dict:
    def first(items, prefer=""):
        names = [i["name"] for i in items]
        good = [n for n in names if not n.endswith("- Copy")]
        for n in good:
            if prefer and prefer.lower() in n.lower():
                return n
        return (good or names or [None])[0]
    machine = first(presets["machine"])
    stem = (machine or "").split()[0] if machine else ""
    return {
        "machine": machine,
        "process": first(presets["process"], stem),
        "filament": first(presets["filament"], stem),
    }


def preset_file(kind: str, name: str) -> Path:
    for item in load_presets()[kind]:
        if item["name"] == name:
            return user_preset_dir() / kind / item["file"]
    raise web.HTTPBadRequest(text=f"Unknown {kind} preset: {name}")


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


def build_datadir(job_dir: Path, process_name: str, overrides: dict) -> Path:
    """A private copy of the Orca data dir: system profiles + user presets, with the
    chosen process preset's overrides applied. The real config is never written to."""
    dd = job_dir / "orca"
    shutil.copytree(ORCA_DIR / "system", dd / "system")
    conf = ORCA_DIR / "OrcaSlicer.conf"
    if conf.is_file():
        shutil.copy2(conf, dd / "OrcaSlicer.conf")
    src = user_preset_dir()
    for kind in KINDS:
        (dd / "user/default" / kind).mkdir(parents=True, exist_ok=True)
        for f in (src / kind).glob("*"):
            if f.suffix in (".json", ".info"):
                shutil.copy2(f, dd / "user/default" / kind / f.name)
    if overrides:
        pf = dd / "user/default/process" / preset_file("process", process_name).name
        j = json.loads(pf.read_text())
        j.update(overrides)
        pf.write_text(json.dumps(j, indent=4))
    return dd


def overrides_from(form: dict) -> dict:
    o = {}
    supports = form.get("supports", "preset")
    if supports == "off":
        o["enable_support"] = "0"
    elif supports in ("normal", "tree"):
        o["enable_support"] = "1"
        o["support_type"] = "normal(auto)" if supports == "normal" else "tree(auto)"
    brim = form.get("brim", "preset")
    if brim == "off":
        o["brim_type"] = "no_brim"
    elif brim == "on":
        o["brim_type"] = "auto_brim"
    infill = form.get("infill", "preset")
    if infill != "preset":
        n = int(infill)
        if not 0 <= n <= 100:
            raise web.HTTPBadRequest(text="Infill must be 0–100")
        o["sparse_infill_density"] = f"{n}%"
    return o


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
            m = preset_file("machine", form["machine"])
            p = preset_file("process", form["process"])
            f = preset_file("filament", form["filament"])
            dd = await asyncio.to_thread(build_datadir, job_dir, form["process"], job["overrides"])
            u = dd / "user/default"
            out.mkdir(exist_ok=True)
            cmd = [ORCA_BIN, "--datadir", str(dd),
                   "--load-settings", f"{u / 'machine' / m.name};{u / 'process' / p.name}",
                   "--load-filaments", str(u / "filament" / f.name),
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


# ---------------------------------------------------------------- moonraker

async def moonraker(method: str, path: str, **kw) -> dict:
    timeout = aiohttp.ClientTimeout(total=kw.pop("timeout", 10))
    headers = {"X-Api-Key": MOONRAKER_API_KEY} if MOONRAKER_API_KEY else {}
    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as s:
        async with s.request(method, MOONRAKER + path, **kw) as r:
            body = await r.text()
            if r.status >= 400:
                try:
                    msg = json.loads(body)["error"]["message"]
                except (ValueError, KeyError, TypeError):
                    msg = body[:200]
                raise web.HTTPBadGateway(text=f"Printer said: {msg}")
            return json.loads(body).get("result", {})


async def printer_status() -> dict:
    q = "/printer/objects/query?webhooks&print_stats=state,filename&virtual_sdcard=progress&extruder=temperature,target&heater_bed=temperature,target"
    try:
        st = (await moonraker("GET", q, timeout=5))["status"]
    except Exception as e:
        return {"online": False, "message": str(e)[:200] or "Printer not reachable"}
    klippy = st.get("webhooks", {}).get("state")
    pstate = st.get("print_stats", {}).get("state")
    return {
        "online": True,
        "klippy": klippy,
        "message": st.get("webhooks", {}).get("state_message"),
        "state": pstate,
        "file": st.get("print_stats", {}).get("filename"),
        "progress": st.get("virtual_sdcard", {}).get("progress"),
        "nozzle": st.get("extruder", {}),
        "bed": st.get("heater_bed", {}),
        "idle": klippy == "ready" and pstate in IDLE_PRINT_STATES,
    }


# ---------------------------------------------------------------- routes

routes = web.RouteTableDef()


@routes.get("/")
async def index(_):
    return web.FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@routes.get("/api/presets")
async def api_presets(_):
    presets = await asyncio.to_thread(load_presets)
    return web.json_response({"presets": presets, "defaults": pick_defaults(presets)})


def printer_ui_url() -> str:
    if PRINTER_UI_URL:
        return PRINTER_UI_URL
    from urllib.parse import urlsplit
    host = urlsplit(MOONRAKER).hostname or "localhost"
    return "" if host in ("localhost", "127.0.0.1") else f"http://{host}/"


@routes.get("/api/printer")
async def api_printer(_):
    return web.json_response({**await printer_status(), "ui": printer_ui_url()})


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
            elif part.name:
                form[part.name] = (await part.text())[:200]
        if not model_name:
            raise web.HTTPBadRequest(text="No model file was uploaded")
        if form.get("name"):
            form["original"] = form["name"]
        for kind in KINDS:
            if not form.get(kind):
                raise web.HTTPBadRequest(text=f"Choose a {kind} preset")
            preset_file(kind, form[kind])
        overrides = overrides_from(form)
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    job = {"id": job_id, "status": "queued", "created": time.time(), "model": model_name,
           "name": safe_stem(form["original"]), "original": form["original"],
           "machine": form["machine"], "process": form["process"], "filament": form["filament"],
           "options": {k: form.get(k) for k in ("supports", "brim", "infill", "scale", "orient", "arrange")},
           "overrides": overrides}
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


@routes.post("/api/jobs/{id}/plates/{n}/upload")
async def api_upload(request):
    job = get_job(request.match_info["id"])
    pl = plate_of(job, request.match_info["n"])
    name = gcode_name(job, pl)
    data = aiohttp.FormData()
    data.add_field("root", "gcodes")
    if UPLOAD_FOLDER:
        data.add_field("path", UPLOAD_FOLDER)
    path = JOBS / job["id"] / "out" / pl["file"]
    with path.open("rb") as fh:
        data.add_field("file", fh, filename=name, content_type="application/octet-stream")
        res = await moonraker("POST", "/server/files/upload", data=data, timeout=300)
    pl["uploaded"] = res.get("item", {}).get("path") or (f"{UPLOAD_FOLDER}/{name}" if UPLOAD_FOLDER else name)
    save_meta(job)
    return web.json_response({"uploaded": pl["uploaded"]})


@routes.post("/api/jobs/{id}/plates/{n}/start")
async def api_start(request):
    job = get_job(request.match_info["id"])
    pl = plate_of(job, request.match_info["n"])
    if not pl.get("uploaded"):
        raise web.HTTPConflict(text="Send it to the printer first")
    st = await printer_status()
    if not st.get("idle"):
        why = st.get("message") if not st.get("online") or st.get("klippy") != "ready" else f"printer is {st.get('state')}"
        raise web.HTTPConflict(text=f"Printer is not ready to start: {why}")
    await moonraker("POST", "/printer/print/start", params={"filename": pl["uploaded"]})
    pl["started"] = time.time()
    save_meta(job)
    return web.json_response({"started": pl["uploaded"]})


@web.middleware
async def errors_as_text(request, handler):
    try:
        return await handler(request)
    except web.HTTPException as e:
        if e.status >= 400 and request.path.startswith("/api/"):
            return web.json_response({"error": e.text or e.reason}, status=e.status)
        raise


def main():
    JOBS.mkdir(parents=True, exist_ok=True)
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
    app = web.Application(client_max_size=MAX_UPLOAD_MB * 1024 * 1024, middlewares=[errors_as_text])
    app.add_routes(routes)
    app.router.add_static("/static/", STATIC, append_version=False)
    web.run_app(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), access_log=None)


if __name__ == "__main__":
    main()
