"""OrcaSlicer itself, fetched on first start where it isn't installed alongside BicuSlicer (the Windows app).

The Docker image has OrcaSlicer built in. The Windows app doesn't ship it: on first start it downloads OrcaSlicer's
official portable build from OrcaSlicer's GitHub releases, checks it against the fingerprint pinned here, and unpacks
it next to BicuSlicer's data. So the installer stays small and BicuSlicer never redistributes OrcaSlicer (AGPL-3.0,
see THIRD_PARTY_NOTICES.md). Standard library only.
"""

from __future__ import annotations

import hashlib
import os
import platform
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

# OrcaSlicer version -> platform -> (file, size in bytes, SHA-256), from github.com/OrcaSlicer/OrcaSlicer/releases
PINNED = {
    "2.5.1": {
        "windows-x64": ("OrcaSlicer_Windows_V2.5.1_x64_portable.zip", 201859696,
                        "f73194789c9a114974e3587f646bb627fa69c7686d949bf040fdb710c41515e8"),
        "windows-arm64": ("OrcaSlicer_Windows_V2.5.1_arm64_portable.zip", 184407191,
                          "cebdc5fd938f2cf78c5da5426d5738f14e75b12bf5dc1804fcf9704e6989ac7d"),
    },
}
BASE_URL = os.environ.get("ORCA_DOWNLOAD_URL", "https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v{version}/").rstrip("/") + "/"
EXE = {"windows": "orca-slicer.exe"}


def platform_key() -> str | None:
    if sys.platform == "win32":
        m = (os.environ.get("PROCESSOR_ARCHITEW6432") or os.environ.get("PROCESSOR_ARCHITECTURE") or platform.machine()).lower()
        return "windows-arm64" if "arm" in m else "windows-x64"
    return None


def installed(root: Path, version: str) -> Path | None:
    """The OrcaSlicer program under root/<version>, if it's there and complete."""
    key = platform_key()
    if not key:
        return None
    exe = root / version / EXE[key.split("-")[0]]
    return exe if exe.is_file() and (root / version / ".complete").is_file() else None


def fetch(root: Path, version: str, progress=lambda done, total: None) -> Path:
    """Download, check and unpack OrcaSlicer `version` for this computer under root/<version>; returns the program."""
    key = platform_key()
    if not key or key not in PINNED.get(version, {}):
        raise RuntimeError(f"No OrcaSlicer {version} download is set up for this computer ({key or sys.platform}).")
    have = installed(root, version)
    if have:
        return have
    name, size, sha = PINNED[version][key]
    root.mkdir(parents=True, exist_ok=True)
    part = root / f"{name}.part"
    h, done = hashlib.sha256(), 0
    req = urllib.request.Request(BASE_URL.format(version=version) + name, headers={"User-Agent": "BicuSlicer"})
    with urllib.request.urlopen(req, timeout=60) as r, part.open("wb") as fh:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
            h.update(chunk)
            done += len(chunk)
            progress(done, size)
    if done != size or h.hexdigest() != sha:
        part.unlink(missing_ok=True)
        raise RuntimeError("The OrcaSlicer download didn't match its fingerprint (a broken or changed file); try again later.")
    dest, tmp = root / version, root / f"{version}.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    with zipfile.ZipFile(part) as z:
        for info in z.infolist():                       # stay inside the folder whatever the archive says
            target = (tmp / info.filename).resolve()
            if not str(target).startswith(str(tmp.resolve())):
                raise RuntimeError("The OrcaSlicer archive has a file outside its folder.")
        z.extractall(tmp)
    # the portable zip may have everything in one top folder
    inner = [p for p in tmp.iterdir()]
    if len(inner) == 1 and inner[0].is_dir() and not (tmp / EXE["windows"]).exists():
        for p in inner[0].iterdir():
            shutil.move(str(p), str(tmp / p.name))
        inner[0].rmdir()
    if not (tmp / EXE[key.split("-")[0]]).is_file():
        raise RuntimeError("The OrcaSlicer download doesn't contain its program.")
    (tmp / ".complete").write_text(f"{name}\n{sha}\n", encoding="utf-8")
    shutil.rmtree(dest, ignore_errors=True)
    tmp.rename(dest)
    part.unlink(missing_ok=True)
    # older versions fetched before: keep only this one
    for p in root.iterdir():
        if p.is_dir() and p.name != version:
            shutil.rmtree(p, ignore_errors=True)
    return dest / EXE[key.split("-")[0]]
