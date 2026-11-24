# The Windows app

BicuSlicer for Windows is the same server and page as the Docker image, run by a small tray launcher, so people can
use it without Docker. It's built and tested by GitHub Actions (`.github/workflows/windows.yml`) for every version tag.

## What's in it

- **Python 3.12** (python.org's official embeddable build, checked against a pinned SHA-256) with BicuSlicer's few
  packages (aiohttp, and pystray + Pillow for the tray icon), installed from wheels pinned by version and hash
  (`windows/requirements.txt`).
- **BicuSlicer**: `app/` (server and page) and `windows/launcher.pyw` (the tray launcher).
- **Not OrcaSlicer.** On first start the server downloads OrcaSlicer's official Windows portable build from
  OrcaSlicer's GitHub releases, checks it against the fingerprint pinned in `app/orca_app.py`, and unpacks it to
  `%LOCALAPPDATA%\BicuSlicer\orca\<version>`. The installer stays small (about 30 MB) and BicuSlicer doesn't
  redistribute OrcaSlicer (AGPL-3.0).

## Where things are

| What | Where |
|---|---|
| The app | `%LOCALAPPDATA%\Programs\BicuSlicer` (per user, no administrator rights) |
| Your printers, presets, projects, slices | `%LOCALAPPDATA%\BicuSlicer\data` (same layout as Docker's `/data`) |
| OrcaSlicer | `%LOCALAPPDATA%\BicuSlicer\orca\2.5.2` |
| Launcher settings (port, phones on/off) | `%LOCALAPPDATA%\BicuSlicer\launcher.json` |
| Log | `%LOCALAPPDATA%\BicuSlicer\bicuslicer.log` (tray: Show log) |

To move from Docker to Windows (or back), copy the data folder's contents across.

## Network

By default BicuSlicer only answers on this computer (`http://localhost:8000`). **Let phones on my Wi-Fi use it**
makes it answer on the local network too; Windows asks once whether to allow it through the firewall. There's no
login, as with the Docker image: only turn it on for a network you trust. If port 8000 is taken, the next free port is
used and remembered.

## Building it yourself

On Windows, with Python 3.12 and [Inno Setup 6](https://jrsoftware.org/isinfo.php):

    powershell -File windows\build.ps1 -Version 0.0.0-dev

This makes `build\BicuSlicer` (the app folder; run `build\BicuSlicer\python\pythonw.exe build\BicuSlicer\launcher.pyw`)
and `build\BicuSlicer-Setup-0.0.0-dev.exe`.

## Updating OrcaSlicer

Bump the version and the two Windows downloads' sizes and SHA-256s in `app/orca_app.py` (`PINNED`), and
`ORCA_VERSION` in `windows/launcher.pyw`. The Windows workflow's smoke test slices with the new version before an
installer is published. The [OrcaSlicer update](../.github/workflows/orca-update.yml) workflow's pull request does
this for you: it adds the new `PINNED` entry from the release's file sizes and SHA-256s (as GitHub lists them) and
bumps the version in the launcher, the Windows workflow and this page.
