"""Checks app/orca_app.py (the Windows app's OrcaSlicer download) without Windows or the real 200 MB file: a fake
portable zip served from a folder, as if this were 64-bit Windows. Standard library only.

    python3 tools/test_orca_app.py
"""
import hashlib, os, sys, tempfile, zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
work = Path(tempfile.mkdtemp())
os.environ["ORCA_DOWNLOAD_URL"] = (work / "srv").as_uri() + "/"
import orca_app as O                                  # noqa: E402  (after the URL is set)
O.platform_key = lambda: "windows-x64"
fails = total = 0


def check(name, ok, detail=""):
    global fails, total
    fails += not ok
    total += 1
    print(("PASS " if ok else "FAIL ") + name + (f": {detail}" if detail else ""))


def serve(name, entries):
    (work / "srv").mkdir(exist_ok=True)
    p = work / "srv" / name
    with zipfile.ZipFile(p, "w") as z:
        for n, data in entries.items():
            z.writestr(n, data)
    b = p.read_bytes()
    return len(b), hashlib.sha256(b).hexdigest()


# a good download, with everything in one top folder (as some portable zips are)
size, sha = serve("good.zip", {"OrcaSlicer/orca-slicer.exe": b"MZ fake", "OrcaSlicer/resources/x.json": b"{}"})
O.PINNED["9.9.9"] = {"windows-x64": ("good.zip", size, sha)}
seen = []
exe = O.fetch(work / "orca", "9.9.9", lambda d, t: seen.append((d, t)))
check("fetches, checks and unpacks it", exe.is_file() and exe.name == "orca-slicer.exe" and (exe.parent / "resources" / "x.json").is_file(), str(exe))
check("reports progress up to the full size", seen and seen[-1] == (size, size), str(seen[-1:]))
check("then counts as installed", O.installed(work / "orca", "9.9.9") == exe)
check("leaves no download behind", not list((work / "orca").glob("*.part")))
# a changed file: refused, nothing installed
size2, _ = serve("bad.zip", {"orca-slicer.exe": b"MZ other"})
O.PINNED["9.9.8"] = {"windows-x64": ("bad.zip", size2, "0" * 64)}
try:
    O.fetch(work / "orca", "9.9.8")
    check("a file that doesn't match its fingerprint is refused", False)
except RuntimeError as e:
    check("a file that doesn't match its fingerprint is refused", "fingerprint" in str(e) and not O.installed(work / "orca", "9.9.8"), str(e))
# an archive writing outside its folder: refused
size3, sha3 = serve("evil.zip", {"orca-slicer.exe": b"MZ", "../../evil.txt": b"x"})
O.PINNED["9.9.7"] = {"windows-x64": ("evil.zip", size3, sha3)}
try:
    O.fetch(work / "orca", "9.9.7")
    check("an archive with paths outside its folder is refused", False)
except RuntimeError as e:
    check("an archive with paths outside its folder is refused", "outside" in str(e) and not (work / "evil.txt").exists(), str(e))
# no download for this computer
O.platform_key = lambda: None
try:
    O.fetch(work / "orca", "2.5.2")
    check("a computer without a download says so", False)
except RuntimeError as e:
    check("a computer without a download says so", "No OrcaSlicer" in str(e), str(e))
print(f"{total - fails}/{total} passed")
sys.exit(1 if fails else 0)
