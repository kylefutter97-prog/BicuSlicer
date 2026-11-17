"""BicuSlicer for Windows: runs the BicuSlicer server in the background and puts an icon in the system tray.

Started from the Start menu (or at sign-in, with "Start with Windows"), it:
  - starts app/server.py with the Python that comes with it, without a console window;
  - on first start the server downloads OrcaSlicer itself (about 200 MB, checked against a pinned fingerprint);
  - opens BicuSlicer in your browser, and keeps a tray icon with Open, "Let phones on my Wi-Fi use it",
    "Start with Windows", the data folder, the log and Quit.

Your printers, presets, projects and slices live in %LOCALAPPDATA%\\BicuSlicer\\data (the same layout as the Docker
image's /data). The app's own files live where it was installed; uninstalling leaves your data.

    pythonw.exe launcher.pyw              normal start (opens the browser when ready)
    pythonw.exe launcher.pyw --background at sign-in: no browser
    python.exe  launcher.pyw --selftest   start the server, wait until it answers, stop (for the build)
"""

import ctypes
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent                    # the install folder: launcher.pyw, app\, python\
APP = HERE / "app"
PYTHON = HERE / "python" / "python.exe"                   # runs the server (console-less via CREATE_NO_WINDOW)
PYTHONW = HERE / "python" / "pythonw.exe"
BASE = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "BicuSlicer"
DATA = BASE / "data"
CONFIG = BASE / "launcher.json"
LOG = BASE / "bicuslicer.log"
ORCA_VERSION = "2.5.1"
NO_WINDOW = 0x08000000
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"

BASE.mkdir(parents=True, exist_ok=True)
_log = open(LOG, "a", encoding="utf-8", buffering=1)
if sys.stdout is None or sys.executable.lower().endswith("pythonw.exe"):     # pythonw has no console
    sys.stdout = sys.stderr = _log


def log(msg: str) -> None:
    _log.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")


def load_config() -> dict:
    try:
        return {"port": 8000, "lan": False, **json.loads(CONFIG.read_text(encoding="utf-8"))}
    except (OSError, ValueError):
        return {"port": 8000, "lan": False}


def save_config(c: dict) -> None:
    CONFIG.write_text(json.dumps(c, indent=1), encoding="utf-8")


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def lan_ip() -> str:
    """This computer's address on the local network (no packet is sent)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            return s.getsockname()[0]
    except OSError:
        return "this computer's IP"


def answering(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


class Server:
    """The BicuSlicer server as a child process."""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.proc = None
        self.stopping = False
        self.restarts = 0

    @property
    def url(self) -> str:
        return f"http://localhost:{self.cfg['port']}/"

    def start(self) -> None:
        if not port_free(self.cfg["port"]):
            # something else has the port: take the next free one
            for p in range(self.cfg["port"] + 1, self.cfg["port"] + 50):
                if port_free(p):
                    log(f"port {self.cfg['port']} is in use; using {p}")
                    self.cfg["port"] = p
                    save_config(self.cfg)
                    break
        env = {**os.environ, "DATA_DIR": str(DATA), "ORCA_FETCH": "1", "ORCA_VERSION": ORCA_VERSION,
               "ORCA_APP_DIR": str(BASE / "orca"), "PORT": str(self.cfg["port"]),
               "HOST": "0.0.0.0" if self.cfg.get("lan") else "127.0.0.1", "PYTHONUNBUFFERED": "1",
               "PYTHONUTF8": "1"}            # Windows' default text encoding isn't UTF-8
        DATA.mkdir(parents=True, exist_ok=True)
        log(f"starting the server on {env['HOST']}:{env['PORT']}")
        self.proc = subprocess.Popen([str(PYTHON), str(APP / "server.py")], cwd=str(APP), env=env,
                                     stdout=_log, stderr=subprocess.STDOUT, creationflags=NO_WINDOW)
        threading.Thread(target=self.watch, args=(self.proc,), daemon=True).start()

    def watch(self, proc) -> None:
        code = proc.wait()
        if self.stopping or proc is not self.proc:
            return
        log(f"the server stopped (exit code {code})")
        if self.restarts < 3:
            self.restarts += 1
            time.sleep(2)
            self.start()

    def stop(self) -> None:
        self.stopping = True
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def restart(self) -> None:
        self.stop()
        self.stopping = False
        self.restarts = 0
        self.start()

    def wait_ready(self, timeout: float = 120) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            if answering(self.cfg["port"]):
                return True
            if self.proc and self.proc.poll() is not None and self.restarts >= 3:
                return False
            time.sleep(0.5)
        return False


def autostart_enabled() -> bool:
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            winreg.QueryValueEx(k, "BicuSlicer")
            return True
    except OSError:
        return False


def set_autostart(on: bool) -> None:
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        if on:
            winreg.SetValueEx(k, "BicuSlicer", 0, winreg.REG_SZ, f'"{PYTHONW}" "{HERE / "launcher.pyw"}" --background')
        else:
            try:
                winreg.DeleteValue(k, "BicuSlicer")
            except OSError:
                pass


def tray(server: Server) -> None:
    import pystray
    from PIL import Image

    def open_app(*_):
        webbrowser.open(server.url)

    def toggle_lan(icon, _):
        server.cfg["lan"] = not server.cfg.get("lan")
        save_config(server.cfg)
        server.restart()
        if server.cfg["lan"]:
            icon.notify(f"Phones and tablets on your Wi-Fi can open http://{lan_ip()}:{server.cfg['port']}/ "
                        "(allow BicuSlicer if Windows asks about the firewall).", "BicuSlicer")
        icon.update_menu()

    def toggle_autostart(icon, _):
        set_autostart(not autostart_enabled())
        icon.update_menu()

    def quit_app(icon, _):
        server.stop()
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem("Open BicuSlicer", open_app, default=True),
        pystray.MenuItem(lambda _: f"Phones: http://{lan_ip()}:{server.cfg['port']}/", open_app,
                         visible=lambda _: bool(server.cfg.get("lan")), enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Let phones on my Wi-Fi use it", toggle_lan, checked=lambda _: bool(server.cfg.get("lan"))),
        pystray.MenuItem("Start with Windows", toggle_autostart, checked=lambda _: autostart_enabled()),
        pystray.MenuItem("Open data folder", lambda *_: os.startfile(str(DATA))),
        pystray.MenuItem("Show log", lambda *_: os.startfile(str(LOG))),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit BicuSlicer", quit_app),
    )
    icon = pystray.Icon("BicuSlicer", Image.open(HERE / "icon.png"), "BicuSlicer", menu)
    icon.run()


def main() -> int:
    args = sys.argv[1:]
    cfg = load_config()
    if "--selftest" in args:
        s = Server(cfg)
        s.start()
        ok = s.wait_ready(180)
        print("BicuSlicer answered" if ok else "BicuSlicer did not answer", flush=True)
        s.stop()
        return 0 if ok else 1
    # one at a time: a second start just opens the browser
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _mutex = k32.CreateMutexW(None, False, "Local\\BicuSlicerLauncher")      # kept for as long as this runs
    if ctypes.get_last_error() == 183:                          # ERROR_ALREADY_EXISTS
        webbrowser.open(f"http://localhost:{cfg['port']}/")
        return 0
    server = Server(cfg)
    server.start()
    if "--background" not in args:
        def open_when_ready():
            if server.wait_ready():
                webbrowser.open(server.url)
            else:
                ctypes.windll.user32.MessageBoxW(None, f"BicuSlicer didn't start. The log is at\n{LOG}", "BicuSlicer", 0x10)
        threading.Thread(target=open_when_ready, daemon=True).start()
    try:
        tray(server)
    finally:
        server.stop()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:                    # pythonw shows nothing: log it, and say so
        import traceback
        log("crashed: " + traceback.format_exc())
        try:
            ctypes.windll.user32.MessageBoxW(None, f"BicuSlicer stopped: {e}\nThe log is at {LOG}", "BicuSlicer", 0x10)
        except Exception:
            pass
        raise
