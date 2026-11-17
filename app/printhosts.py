"""Physical printer connections, like OrcaSlicer's "physical printer" dialog.

A connection uses OrcaSlicer's own field names (host_type, print_host, print_host_webui, printhost_apikey,
printhost_authorization_type, printhost_user, printhost_password, printhost_port) so presets and connections
move between the two easily. Supported host types: moonraker, octoprint, prusalink, duet.

Every backend offers: test() -> {"ok", "message"}, status() -> normalised printer state,
upload(path, name) -> remote file name, start(remote_name).
Connections (with their secrets) are stored server-side in DATA_DIR/printers.json; the page never sees secrets.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import ssl
import time
import uuid
from pathlib import Path
from urllib.parse import quote, urljoin, urlsplit

import aiohttp

SUPPORTED = {
    "moonraker": "Moonraker (Klipper)",
    "octoprint": "Octo/Klipper (OctoPrint API)",
    "prusalink": "PrusaLink",
    "duet": "Duet (RepRapFirmware)",
}
# OrcaSlicer's other host types, shown as not available yet
UNSUPPORTED = {
    "prusaconnect": "PrusaConnect", "ultimaker": "UltiMaker", "flashair": "FlashAir", "astrobox": "AstroBox",
    "repetier": "Repetier", "mks": "MKS", "esp3d": "ESP3D", "crealityprint": "CrealityPrint", "obico": "Obico",
    "flashforge": "Flashforge", "simplyprint": "SimplyPrint", "elegoolink": "Elegoo Link", "3dprinteros": "3DPrinterOS",
}
SECRET_FIELDS = ("printhost_apikey", "printhost_password")
FIELDS = ("name", "host_type", "print_host", "print_host_webui", "printhost_apikey", "printhost_authorization_type",
          "printhost_user", "printhost_password", "printhost_port", "verify_tls", "upload_folder", "preset_names")


class HostError(Exception):
    pass


# ====================================================================== store

class Store:
    def __init__(self, path: Path):
        self.path = path
        self.data = {"printers": [], "active": None}
        if path.is_file():
            try:
                self.data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=1), encoding="utf-8")
        os.chmod(tmp, 0o600)
        tmp.replace(self.path)

    @property
    def printers(self) -> list[dict]:
        return self.data.setdefault("printers", [])

    def get(self, pid: str | None) -> dict | None:
        return next((p for p in self.printers if p["id"] == pid), None)

    def public(self, p: dict) -> dict:
        out = {k: v for k, v in p.items() if k not in SECRET_FIELDS}
        for k in SECRET_FIELDS:
            out[k + "_set"] = bool(p.get(k))
        out["type_label"] = SUPPORTED.get(p.get("host_type"), p.get("host_type"))
        out["webui"] = webui_url(p)
        return out

    def upsert(self, body: dict) -> dict:
        p = self.get(body.get("id")) if body.get("id") else None
        new = p is None
        if new:
            p = {"id": uuid.uuid4().hex[:12]}
        for k in FIELDS:
            if k not in body:
                continue
            v = body[k]
            if k in SECRET_FIELDS and (v is None or v == ""):
                if body.get(k + "_clear"):
                    p[k] = ""
                continue                      # empty secret field = keep the stored one
            if k == "preset_names":
                v = [str(x) for x in (v or []) if str(x).strip()][:50]
            elif k == "verify_tls":
                v = bool(v)
            else:
                v = str(v or "").strip()[:500]
            p[k] = v
        validate(p)
        if new:
            self.printers.append(p)
            if not self.data.get("active"):
                self.data["active"] = p["id"]
        self.save()
        return p

    def delete(self, pid: str) -> None:
        self.data["printers"] = [p for p in self.printers if p["id"] != pid]
        if self.data.get("active") == pid:
            self.data["active"] = self.printers[0]["id"] if self.printers else None
        self.save()

    def for_machine(self, machine: str | None) -> dict | None:
        """The connection linked to this printer preset, else the active one."""
        if machine:
            for p in self.printers:
                if machine in (p.get("preset_names") or []):
                    return p
        return self.get(self.data.get("active")) or (self.printers[0] if self.printers else None)


def validate(p: dict) -> None:
    if not p.get("name"):
        raise HostError("Give the printer a name")
    if p.get("host_type") not in SUPPORTED:
        raise HostError(f"{UNSUPPORTED.get(p.get('host_type'), p.get('host_type'))} connections aren't supported yet")
    if not p.get("print_host"):
        raise HostError("Enter the printer's hostname, IP address or URL")
    base_url(p)    # parses


def base_url(p: dict) -> str:
    h = p.get("print_host", "").strip()
    if not re.match(r"^https?://", h, re.I):
        h = "http://" + h
    u = urlsplit(h)
    if not u.hostname:
        raise HostError("That isn't a valid hostname, IP address or URL")
    return h.rstrip("/")


def webui_url(p: dict) -> str:
    if p.get("print_host_webui"):
        w = p["print_host_webui"]
        return w if re.match(r"^https?://", w, re.I) else "http://" + w
    try:
        u = urlsplit(base_url(p))
    except HostError:
        return ""
    # Moonraker's API port isn't the web UI; Mainsail/Fluidd normally sit on port 80 of the same host
    if p.get("host_type") == "moonraker" and u.port == 7125:
        return f"{u.scheme}://{u.hostname}/"
    return f"{u.scheme}://{u.netloc}/"


def migrate(store: Store, env_moonraker: str, env_ui: str, machine_presets: list[tuple[str, dict]]) -> None:
    """First run: turn the old MOONRAKER_URL setting and any printer presets that carry an OrcaSlicer
    print_host into saved connections."""
    if store.path.is_file():
        return
    seen = {}
    for name, values in machine_presets:
        host = (values.get("print_host") or "").strip()
        ht = values.get("host_type") or "octoprint"
        if not host:
            continue
        if ht == "octoprint" and env_moonraker and urlsplit(base_url({"print_host": host})).hostname == urlsplit(base_url({"print_host": env_moonraker})).hostname:
            ht = "moonraker"     # it's the same Klipper box the old setting pointed at
        if ht not in SUPPORTED:
            continue
        key = (ht, host)
        if key in seen:
            seen[key]["preset_names"].append(name)
            continue
        p = {"id": uuid.uuid4().hex[:12], "name": name, "host_type": ht, "print_host": host,
             "print_host_webui": values.get("print_host_webui") or (env_ui if ht == "moonraker" else ""),
             "printhost_apikey": values.get("printhost_apikey") or "", "printhost_authorization_type": values.get("printhost_authorization_type") or "key",
             "printhost_user": values.get("printhost_user") or "", "printhost_password": values.get("printhost_password") or "",
             "printhost_port": values.get("printhost_port") or "", "verify_tls": True, "upload_folder": "", "preset_names": [name]}
        seen[key] = p
        store.printers.append(p)
    if not store.printers and env_moonraker:
        store.printers.append({"id": uuid.uuid4().hex[:12], "name": "Klipper printer", "host_type": "moonraker",
                               "print_host": env_moonraker, "print_host_webui": env_ui, "printhost_apikey": os.environ.get("MOONRAKER_API_KEY", ""),
                               "printhost_authorization_type": "key", "printhost_user": "", "printhost_password": "", "printhost_port": "",
                               "verify_tls": True, "upload_folder": os.environ.get("UPLOAD_FOLDER", ""), "preset_names": []})
    store.data["active"] = store.printers[0]["id"] if store.printers else None
    store.save()


# ====================================================================== HTTP helpers

def _ssl(p: dict):
    if base_url(p).lower().startswith("https") and not p.get("verify_tls", True):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return None


class Client:
    def __init__(self, p: dict, timeout: float = 10):
        self.p = p
        self.base = base_url(p)
        self.timeout = aiohttp.ClientTimeout(total=timeout)
        self._digest = None

    def headers(self) -> dict:
        h = {}
        if self.p.get("printhost_apikey") and self.p.get("printhost_authorization_type", "key") != "user":
            h["X-Api-Key"] = self.p["printhost_apikey"]
        return h

    async def request(self, method: str, path: str, *, timeout: float | None = None, **kw):
        url = self.base + path
        to = aiohttp.ClientTimeout(total=timeout) if timeout else self.timeout
        headers = {**self.headers(), **kw.pop("headers", {})}
        async with aiohttp.ClientSession(timeout=to) as s:
            try:
                r = await s.request(method, url, headers=headers, ssl=_ssl(self.p), **kw)
                body = await r.read()
                if r.status == 401 and self.p.get("printhost_authorization_type") == "user" and "digest" in r.headers.get("WWW-Authenticate", "").lower():
                    headers["Authorization"] = _digest_header(r.headers["WWW-Authenticate"], method, url,
                                                              self.p.get("printhost_user", ""), self.p.get("printhost_password", ""))
                    if "data" in kw and hasattr(kw["data"], "seek"):
                        kw["data"].seek(0)
                    r = await s.request(method, url, headers=headers, ssl=_ssl(self.p), **kw)
                    body = await r.read()
            except aiohttp.ClientConnectorError:
                raise HostError(f"Can't reach {urlsplit(url).netloc}")
            except TimeoutError:
                raise HostError(f"{urlsplit(url).netloc} didn't answer in time")
            except aiohttp.ClientError as e:
                raise HostError(f"Connection problem: {e.__class__.__name__}")
        if r.status in (401, 403):
            raise HostError("The printer refused the login: check the API key / password")
        return r.status, body

    async def json(self, method: str, path: str, ok=(200,), **kw):
        status, body = await self.request(method, path, **kw)
        if status not in ok:
            raise HostError(_err(status, body))
        try:
            return json.loads(body) if body else {}
        except ValueError:
            raise HostError("The printer sent something that isn't JSON: is the host type right?")


def _err(status: int, body: bytes) -> str:
    try:
        j = json.loads(body)
        msg = (j.get("error") or {}).get("message") if isinstance(j.get("error"), dict) else j.get("error") or j.get("message")
    except (ValueError, AttributeError):
        msg = body[:160].decode("utf-8", "replace").strip()
    return f"Printer answered {status}: {msg or 'error'}"


def _digest_header(challenge: str, method: str, url: str, user: str, password: str) -> str:
    """RFC 2617 Digest (MD5, qop=auth), as PrusaLink uses. aiohttp 3.9 has no built-in digest auth."""
    params = dict(re.findall(r'(\w+)="?([^",]+)"?', challenge))
    realm, nonce, qop = params.get("realm", ""), params.get("nonce", ""), params.get("qop", "")
    path = urlsplit(url).path + (("?" + urlsplit(url).query) if urlsplit(url).query else "")
    ha1 = hashlib.md5(f"{user}:{realm}:{password}".encode()).hexdigest()
    ha2 = hashlib.md5(f"{method}:{path}".encode()).hexdigest()
    cnonce, nc = uuid.uuid4().hex[:16], "00000001"
    if "auth" in qop.split(","):
        resp = hashlib.md5(f"{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}".encode()).hexdigest()
        return (f'Digest username="{user}", realm="{realm}", nonce="{nonce}", uri="{path}", qop=auth, nc={nc}, '
                f'cnonce="{cnonce}", response="{resp}"' + (f', opaque="{params["opaque"]}"' if "opaque" in params else ""))
    resp = hashlib.md5(f"{ha1}:{nonce}:{ha2}".encode()).hexdigest()
    return f'Digest username="{user}", realm="{realm}", nonce="{nonce}", uri="{path}", response="{resp}"'


def _status(**kw) -> dict:
    base = {"online": True, "state": None, "message": None, "progress": None, "file": None,
            "nozzle": {}, "bed": {}, "idle": False}
    base.update(kw)
    return base


# ====================================================================== backends
# Each backend: test(), status() (the pill), upload(), start(); and for the printer view: detail() (status plus job
# times, layers, fan, speed), action(name, value) (pause, resume, cancel, temperatures, speed, ...) and webcams().

ACTIONS = {          # name: (min, max) for a value, or None
    "pause": None, "resume": None, "cancel": None, "estop": None, "restart": None, "home": None,
    "nozzle": (0, 350), "bed": (0, 150), "speed": (10, 300), "flow": (50, 150), "fan": (0, 100),
}


def cam_url(p: dict, url: str) -> str:
    """A webcam URL as the printer reports it, made absolute (relative ones live on the printer's web server)."""
    if not url:
        return ""
    if re.match(r"^https?://", url, re.I):
        return url
    u = urlsplit(base_url(p))
    root = f"{u.scheme}://{u.hostname}/" if p.get("host_type") == "moonraker" and u.port == 7125 else f"{u.scheme}://{u.netloc}/"
    return urljoin(root, url)


class Base:
    async def detail(self):
        return await self.status()

    async def action(self, name: str, value=None):
        raise HostError("That isn't available for this kind of printer connection yet")

    async def webcams(self) -> list[dict]:
        return []

    async def file_thumb(self, filename: str):
        return None


class Moonraker(Base):
    IDLE = {"standby", "complete", "cancelled", "error"}

    def __init__(self, p): self.c = Client(p); self.p = p

    async def test(self):
        info = (await self.c.json("GET", "/server/info")).get("result", {})
        return {"ok": True, "message": f"Moonraker {info.get('moonraker_version', '')} · Klipper {info.get('klippy_state', '?')}".strip()}

    async def status(self):
        q = "/printer/objects/query?webhooks&print_stats=state,filename&virtual_sdcard=progress&extruder=temperature,target&heater_bed=temperature,target"
        st = (await self.c.json("GET", q, timeout=5)).get("result", {}).get("status", {})
        klippy = st.get("webhooks", {}).get("state")
        pstate = st.get("print_stats", {}).get("state")
        return _status(state=pstate if klippy == "ready" else f"klipper {klippy}", message=st.get("webhooks", {}).get("state_message"),
                       progress=st.get("virtual_sdcard", {}).get("progress"), file=st.get("print_stats", {}).get("filename"),
                       nozzle=st.get("extruder", {}), bed=st.get("heater_bed", {}), idle=klippy == "ready" and pstate in self.IDLE,
                       printing=pstate in ("printing", "paused"))

    async def upload(self, path: Path, name: str):
        data = aiohttp.FormData()
        data.add_field("root", "gcodes")
        if self.p.get("upload_folder"):
            data.add_field("path", self.p["upload_folder"])
        with path.open("rb") as fh:
            data.add_field("file", fh, filename=name, content_type="application/octet-stream")
            res = await self.c.json("POST", "/server/files/upload", ok=(200, 201), data=data, timeout=600)
        r = res.get("result", res)
        return (r.get("item") or {}).get("path") or (f"{self.p['upload_folder']}/{name}" if self.p.get("upload_folder") else name)

    async def start(self, remote: str):
        await self.c.json("POST", "/printer/print/start", params={"filename": remote})

    _meta: dict = {}

    async def metadata(self, filename: str) -> dict:
        key = (self.c.base, filename)
        if key not in Moonraker._meta:
            try:
                Moonraker._meta[key] = (await self.c.json("GET", "/server/files/metadata", params={"filename": filename}, timeout=5)).get("result", {})
            except HostError:
                return {}
            if len(Moonraker._meta) > 50:
                Moonraker._meta.pop(next(iter(Moonraker._meta)))
        return Moonraker._meta[key]

    async def detail(self):
        q = ("/printer/objects/query?webhooks&print_stats&virtual_sdcard=progress,is_active&display_status=progress,message"
             "&extruder=temperature,target,power&heater_bed=temperature,target,power&fan=speed"
             "&gcode_move=speed_factor,extrude_factor,gcode_position&toolhead=homed_axes")
        st = (await self.c.json("GET", q, timeout=5)).get("result", {}).get("status", {})
        klippy = st.get("webhooks", {}).get("state")
        ps = st.get("print_stats", {})
        pstate = ps.get("state")
        fn = ps.get("filename") or None
        meta = await self.metadata(fn) if fn else {}
        prog = st.get("virtual_sdcard", {}).get("progress")
        dur = ps.get("print_duration") or 0
        est = meta.get("estimated_time")
        remaining = None
        if pstate in ("printing", "paused"):
            if est:
                remaining = max(0.0, est - dur)              # the slicer's estimate, as Mainsail shows it
            elif prog and prog > 0.01:
                remaining = dur / prog - dur
        info = ps.get("info") or {}
        gm = st.get("gcode_move", {})
        pos = gm.get("gcode_position") or [None, None, None]
        return _status(
            state=pstate if klippy == "ready" else f"klipper {klippy}", message=st.get("webhooks", {}).get("state_message") or ps.get("message"),
            progress=prog, file=fn, nozzle=st.get("extruder", {}), bed=st.get("heater_bed", {}),
            idle=klippy == "ready" and pstate in self.IDLE, printing=pstate in ("printing", "paused"), klippy=klippy,
            layer=info.get("current_layer"), layers=info.get("total_layer") or meta.get("layer_count"),
            elapsed=dur, total_elapsed=ps.get("total_duration"), remaining=remaining, estimate=est,
            filament_used=ps.get("filament_used"), filament_total=meta.get("filament_total"),
            speed_factor=gm.get("speed_factor"), flow_factor=gm.get("extrude_factor"), fan=st.get("fan", {}).get("speed"),
            z=pos[2] if len(pos) > 2 else None, homed=st.get("toolhead", {}).get("homed_axes"),
            display=st.get("display_status", {}).get("message"), has_thumb=bool(meta.get("thumbnails")),
            object_height=meta.get("object_height"), slicer=meta.get("slicer"))

    async def gcode(self, script: str):
        await self.c.json("POST", "/printer/gcode/script", params={"script": script}, timeout=60)

    async def action(self, name: str, value=None):
        if name in ("pause", "resume", "cancel"):
            await self.c.json("POST", f"/printer/print/{name}")
        elif name == "estop":
            await self.c.json("POST", "/printer/emergency_stop")
        elif name == "restart":
            await self.c.json("POST", "/printer/firmware_restart")
        elif name == "home":
            await self.gcode("G28")
        elif name == "nozzle":
            await self.gcode(f"M104 S{value:g}")
        elif name == "bed":
            await self.gcode(f"M140 S{value:g}")
        elif name == "speed":
            await self.gcode(f"M220 S{value:g}")
        elif name == "flow":
            await self.gcode(f"M221 S{value:g}")
        elif name == "fan":
            await self.gcode(f"M106 S{round(value * 2.55)}" if value > 0 else "M107")
        else:
            await super().action(name, value)

    async def webcams(self):
        res = (await self.c.json("GET", "/server/webcams/list", timeout=5)).get("result", {})
        out = []
        for w in res.get("webcams", []):
            if w.get("enabled") is False:
                continue
            out.append({"name": w.get("name") or "Camera", "service": w.get("service") or "",
                        "stream": cam_url(self.p, w.get("stream_url") or ""), "snapshot": cam_url(self.p, w.get("snapshot_url") or ""),
                        "flip_h": bool(w.get("flip_horizontal")), "flip_v": bool(w.get("flip_vertical")), "rotation": w.get("rotation") or 0,
                        "aspect": w.get("aspect_ratio") or "4:3"})
        return out

    async def file_thumb(self, filename: str):
        meta = await self.metadata(filename)
        th = sorted(meta.get("thumbnails") or [], key=lambda t: t.get("width", 0) * t.get("height", 0))
        if not th:
            return None
        folder = filename.rsplit("/", 1)[0] + "/" if "/" in filename else ""
        status, body = await self.c.request("GET", "/server/files/gcodes/" + quote(folder + th[-1]["relative_path"]), timeout=10)
        return body if status == 200 else None


class OctoPrint(Base):
    def __init__(self, p): self.c = Client(p); self.p = p

    async def test(self):
        v = await self.c.json("GET", "/api/version")
        return {"ok": True, "message": v.get("text") or f"OctoPrint {v.get('server', '')}"}

    async def status(self):
        status, body = await self.c.request("GET", "/api/printer", timeout=5)
        if status == 409:
            return _status(state="offline", message="Printer not connected to OctoPrint")
        if status != 200:
            raise HostError(_err(status, body))
        pr = json.loads(body)
        flags = pr.get("state", {}).get("flags", {})
        job = await self.c.json("GET", "/api/job", timeout=5)
        t = pr.get("temperature", {})
        tool, bed = t.get("tool0", {}), t.get("bed", {})
        prog = (job.get("progress") or {}).get("completion")
        return _status(state=pr.get("state", {}).get("text", "").lower() or None, message=pr.get("state", {}).get("text"),
                       progress=(prog / 100) if isinstance(prog, (int, float)) else None,
                       file=((job.get("job") or {}).get("file") or {}).get("name"),
                       nozzle={"temperature": tool.get("actual"), "target": tool.get("target")},
                       bed={"temperature": bed.get("actual"), "target": bed.get("target")},
                       idle=bool(flags.get("ready") or flags.get("operational")) and not flags.get("printing") and not flags.get("paused"),
                       printing=bool(flags.get("printing") or flags.get("paused")))

    async def upload(self, path: Path, name: str):
        data = aiohttp.FormData()
        if self.p.get("upload_folder"):
            data.add_field("path", self.p["upload_folder"])
        with path.open("rb") as fh:
            data.add_field("file", fh, filename=name, content_type="application/octet-stream")
            res = await self.c.json("POST", "/api/files/local", ok=(200, 201), data=data, timeout=600)
        f = (res.get("files") or {}).get("local") or {}
        return f.get("path") or f.get("name") or (f"{self.p['upload_folder']}/{name}" if self.p.get("upload_folder") else name)

    async def start(self, remote: str):
        await self.c.json("POST", "/api/files/local/" + quote(remote), ok=(200, 204), json={"command": "select", "print": True})

    async def detail(self):
        st = await self.status()
        try:
            job = await self.c.json("GET", "/api/job", timeout=5)
            pr = job.get("progress") or {}
            st.update(elapsed=pr.get("printTime"), remaining=pr.get("printTimeLeft"),
                      estimate=(job.get("job") or {}).get("estimatedPrintTime"))
        except HostError:
            pass
        return st

    async def action(self, name: str, value=None):
        post = lambda path, body: self.c.json("POST", path, ok=(200, 204), json=body)
        if name == "pause":
            await post("/api/job", {"command": "pause", "action": "pause"})
        elif name == "resume":
            await post("/api/job", {"command": "pause", "action": "resume"})
        elif name == "cancel":
            await post("/api/job", {"command": "cancel"})
        elif name == "nozzle":
            await post("/api/printer/tool", {"command": "target", "targets": {"tool0": value}})
        elif name == "bed":
            await post("/api/printer/bed", {"command": "target", "target": value})
        elif name == "speed":
            await post("/api/printer/printhead", {"command": "feedrate", "factor": int(value)})
        elif name == "flow":
            await post("/api/printer/tool", {"command": "flowrate", "factor": int(value)})
        elif name == "home":
            await post("/api/printer/printhead", {"command": "home", "axes": ["x", "y", "z"]})
        elif name in ("fan", "estop"):
            cmd = "M112" if name == "estop" else (f"M106 S{round(value * 2.55)}" if value > 0 else "M107")
            await post("/api/printer/command", {"commands": [cmd]})
        else:
            await super().action(name, value)

    async def webcams(self):
        try:
            w = (await self.c.json("GET", "/api/settings", timeout=5)).get("webcam") or {}
        except HostError:
            return []
        if not (w.get("streamUrl") or w.get("snapshotUrl")):
            return []
        return [{"name": "Camera", "service": "mjpegstreamer", "stream": cam_url(self.p, w.get("streamUrl") or ""),
                 "snapshot": cam_url(self.p, w.get("snapshotUrl") or ""), "flip_h": bool(w.get("flipH")), "flip_v": bool(w.get("flipV")),
                 "rotation": 90 if w.get("rotate90") else 0, "aspect": "16:9"}]


class PrusaLink(Base):
    def __init__(self, p): self.c = Client(p); self.p = p

    async def test(self):
        v = await self.c.json("GET", "/api/version")
        return {"ok": True, "message": f"{v.get('text') or 'PrusaLink'} {v.get('server', '')}".strip()}

    async def storage(self) -> str:
        try:
            st = await self.c.json("GET", "/api/v1/storage")
            for s in st.get("storage_list", []):
                if s.get("available") and not s.get("read_only"):
                    return s.get("path", "/usb").strip("/") or "usb"
        except HostError:
            pass
        return "usb"

    async def status(self):
        st = await self.c.json("GET", "/api/v1/status", timeout=5)
        pr, job = st.get("printer", {}), st.get("job") or {}
        state = (pr.get("state") or "").lower()
        return _status(state=state, message=pr.get("state"), progress=(job.get("progress") or 0) / 100 if job else None,
                       nozzle={"temperature": pr.get("temp_nozzle"), "target": pr.get("target_nozzle")},
                       bed={"temperature": pr.get("temp_bed"), "target": pr.get("target_bed")},
                       idle=state in ("idle", "finished", "stopped", "ready"), printing=state in ("printing", "paused"))

    async def upload(self, path: Path, name: str):
        store = await self.storage()
        folder = self.p.get("upload_folder", "").strip("/")
        remote = f"{folder}/{name}" if folder else name
        with path.open("rb") as fh:
            status, body = await self.c.request("PUT", f"/api/v1/files/{store}/{quote(remote)}", data=fh, timeout=600,
                                                headers={"Content-Type": "text/x.gcode", "Overwrite": "?1", "Print-After-Upload": "?0"})
        if status not in (200, 201, 204):
            raise HostError(_err(status, body))
        return f"{store}/{remote}"

    async def start(self, remote: str):
        status, body = await self.c.request("POST", "/api/v1/files/" + quote(remote))
        if status not in (200, 201, 204):
            raise HostError(_err(status, body))

    async def detail(self):
        st = await self.status()
        try:
            job = (await self.c.json("GET", "/api/v1/status", timeout=5)).get("job") or {}
            st.update(elapsed=job.get("time_printing"), remaining=job.get("time_remaining"), job_id=job.get("id"))
        except HostError:
            pass
        return st

    async def action(self, name: str, value=None):
        if name not in ("pause", "resume", "cancel"):
            return await super().action(name, value)
        job = (await self.c.json("GET", "/api/v1/status", timeout=5)).get("job") or {}
        if not job.get("id"):
            raise HostError("There's no print to control")
        method, path = ("DELETE", f"/api/v1/job/{job['id']}") if name == "cancel" else ("PUT", f"/api/v1/job/{job['id']}/{name}")
        status, body = await self.c.request(method, path)
        if status not in (200, 204):
            raise HostError(_err(status, body))


class Duet(Base):
    """RepRapFirmware in standalone mode (the board's own web server, as DWC uses)."""

    def __init__(self, p): self.c = Client(p); self.p = p

    async def connect(self):
        pw = self.p.get("printhost_password") or self.p.get("printhost_apikey") or "reprap"
        r = await self.c.json("GET", f"/rr_connect?password={quote(pw)}&time={time.strftime('%Y-%m-%dT%H:%M:%S')}")
        if r.get("err") == 1:
            raise HostError("Wrong Duet password")
        return r

    async def test(self):
        r = await self.connect()
        return {"ok": True, "message": f"Duet {r.get('boardType', '')} firmware {r.get('apiLevel', '')}".strip()}

    async def status(self):
        await self.connect()
        st = await self.c.json("GET", "/rr_model?key=state&flags=d99f", timeout=5)
        s = (st.get("result") or {}).get("status", "")
        return _status(state=s, message=s, idle=s in ("idle",), printing=s in ("processing", "paused", "pausing", "resuming", "simulating"))

    async def upload(self, path: Path, name: str):
        await self.connect()
        folder = self.p.get("upload_folder", "").strip("/")
        remote = f"0:/gcodes/{folder + '/' if folder else ''}{name}"
        with path.open("rb") as fh:
            r = await self.c.json("POST", f"/rr_upload?name={quote(remote)}&time={time.strftime('%Y-%m-%dT%H:%M:%S')}", data=fh, timeout=600)
        if r.get("err"):
            raise HostError("The Duet refused the upload")
        return remote

    async def start(self, remote: str):
        await self.connect()
        await self.c.json("GET", "/rr_gcode?gcode=" + quote(f'M32 "{remote}"'))

    async def action(self, name: str, value=None):
        codes = {"pause": "M25", "resume": "M24", "cancel": "M0", "estop": "M112", "home": "G28"}
        if name in codes:
            g = codes[name]
        elif name in ("nozzle", "bed", "speed", "flow", "fan"):
            g = {"nozzle": f"M104 S{value:g}", "bed": f"M140 S{value:g}", "speed": f"M220 S{value:g}", "flow": f"M221 S{value:g}",
                 "fan": f"M106 S{value / 100:.2f}"}[name]
        else:
            return await super().action(name, value)
        await self.connect()
        await self.c.json("GET", "/rr_gcode?gcode=" + quote(g))


BACKENDS = {"moonraker": Moonraker, "octoprint": OctoPrint, "prusalink": PrusaLink, "duet": Duet}


def backend(p: dict):
    validate(p)
    return BACKENDS[p["host_type"]](p)


def types_info() -> list[dict]:
    return [{"id": k, "label": v, "supported": True} for k, v in SUPPORTED.items()] + \
           [{"id": k, "label": v, "supported": False} for k, v in UNSUPPORTED.items()]
