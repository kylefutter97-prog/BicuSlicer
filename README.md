<p align="center"><img src="docs/banner.svg" alt="BicuSlicer" width="496"></p>

# BicuSlicer

A phone-friendly web front end for the [OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) slicing engine, for Klipper printers.

Lay out a plate in the browser, slice it with the real OrcaSlicer engine using the presets you already made in the OrcaSlicer desktop app, and send it to your printer through Moonraker. It runs on your own server with no cloud service.

## What it does

- **Plate editing on a phone:**
  - add several STL / 3MF / OBJ models;
  - drag parts around the bed;
  - tap a face to put it on the bed;
  - run OrcaSlicer's own auto-orient and check the result in the 3D view;
  - rotate in fixed steps, scale, add copies, and auto-arrange.
- **OrcaSlicer's plate tools**, on a toolbar above the plate and on right-click (long-press on a phone):
  - exact position, rotation and size, mirror, center, rename;
  - multi-select (Shift/Ctrl-click), merge, split into parts, cut at a height with filled cut faces;
  - add shapes (box, cylinder, sphere, cone), modifier parts with their own settings, negative parts;
  - one-click brim ears, printable on/off, Fix model (OrcaSlicer's repair), convert inches;
  - export a part as STL or the plate as 3MF;
  - **paint supports** (enforce / block, or paint every overhang) and **seams** (here / avoid) with a brush;
  - **undo and redo** (Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y, or ↶ ↷), 60 steps.
- **Multiple plates, like OrcaSlicer's:** plates side by side with tabs; drag a part onto another plate or use *Move to plate*. Each plate is sliced, sent and printed on its own, keeps its own result, and can have its own name, plate type, print sequence and spiral vase. Arrange spills what doesn't fit onto the next plates.
- **Open OrcaSlicer / Bambu Studio projects** (what MakerWorld downloads are): plates and their settings, copies, parts with their own settings, modifier and negative parts, and painted supports and seams (written back to the slicer exactly as painted). Optionally take the project's print settings as unsaved changes; speeds and accelerations, tuned for the project's printer, are a separate choice. Your printer and filament stay as they are. Layer height profiles and height ranges come along too. Not yet: multi-colour painting, support enforcer/blocker parts.
- **Variable layer height, like OrcaSlicer's:** per part, *Adaptive* (OrcaSlicer's own algorithm: thin layers where the surface slopes, thick ones on walls) with its quality/speed slider and *Smooth*, shown as a chart with the layer count; plus **height ranges** that give a band of the part its own layer height and other settings. Warns (with a one-tap fix) when the print settings use organic tree supports, which OrcaSlicer can't combine with them.
- **Projects:** save a plate and open it again on any device. A project keeps the parts, their positions, rotations, scale, copies and per-part settings, the chosen presets and unsaved print-settings edits, and a thumbnail. Projects are stored on the server in `DATA_DIR/projects/`.
- **Per-part settings,** like OrcaSlicer's object settings. Give one part its own infill, walls, shells, layer height, supports, brim, seam, fuzzy skin and so on: any of the ~300 settings OrcaSlicer allows per object, from its `PrintObjectConfig` / `PrintRegionConfig`. They're written into the plate's 3MF (`Metadata/model_settings.config`) for the slicer.
- **OrcaSlicer's settings, with its Simple / Advanced / Expert modes** (OrcaSlicer's "process" presets are called *print settings* here): every printer, filament and print setting, laid out in the same pages and groups as the desktop app, with search and help text. The list is generated from OrcaSlicer's own source for the version you run. Changes you haven't saved still apply when you slice.
- **Profiles:** create, edit, rename, delete, import and export printer, filament and print settings presets.
  - Your presets are kept in BicuSlicer's own store.
  - Presets from an OrcaSlicer desktop data folder and OrcaSlicer's vendor library (70+ brands) appear read-only, and you can save copies to change them.
  - Import takes OrcaSlicer `.json` presets and `.orca_printer` / `.orca_filament` / `.orca_bundle` / `.zip` bundles.
  - Export gives standalone `.json` files that also load in OrcaSlicer.
- **First-run setup:** choose printers from the vendor library, or enter a custom printer's bed size, nozzle and firmware.
- **Desktop and phone layouts:**
  - wide desktop screens get three columns (settings, the 3D view, then parts and results) filling the window;
  - laptops and tablets get two;
  - phones get one, with a fixed Slice button.
- **Results:** print time, filament weight and length, layer count and cost.
- **Physical printers, like OrcaSlicer's:**
  - Add printers with **Moonraker (Klipper)**, **OctoPrint** (also Klipper through Moonraker's OctoPrint compatibility), **PrusaLink** or **Duet (RepRapFirmware)** connections. Each uses OrcaSlicer's fields: host or IP, device UI, API key, HTTP digest user and password, and HTTPS check.
  - Test a connection before saving it, and link a connection to printer presets so choosing a preset picks its printer.
  - Like OrcaSlicer's upload dialog, **Send and print** or **Send only**. Starting is refused unless the printer reports it's idle, and that's checked again just before the print starts.
  - A slice that no longer matches the plate or settings can't be sent or started.
  - A status pill shows the printer's state and temperatures.
  - Credentials stay on the server (`DATA_DIR/printers.json`, mode 600) and are never sent back to the page.

What the page shows is what gets sliced. The page bakes every placed part into one 3MF in bed coordinates, and the server slices that 3MF with `--arrange 0`.

## Requirements

- Docker on an x86-64 or ARM64 host (e.g. a Raspberry Pi 5), or Docker Desktop on Windows or macOS. The image is about 1.8 GB and contains OrcaSlicer's slicing engine: no separate OrcaSlicer install is needed.
- Optional: an OrcaSlicer desktop data folder, if you want its user presets available. For example, the linuxserver/orcaslicer desktop container's `/config/.config/OrcaSlicer`. Without one, start from the vendor library or a custom printer.
- Internet access on first start, to fetch OrcaSlicer's settings catalogue and vendor profiles (see below).
- A Klipper printer with Moonraker, reachable from the container.
- About 1–2 GB of RAM while a slice runs. Jobs are sliced one at a time.

## Quick start

You need [Docker](https://docs.docker.com/engine/install/) with the Compose plugin. On most Linux systems, `curl -fsSL https://get.docker.com | sudo sh` installs both.

**With the published image** (x86-64 and ARM64):

```sh
mkdir bicuslicer && cd bicuslicer
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/kylefutter97-prog/BicuSlicer/main/docker-compose.example.yml
docker compose up -d
```

**Or build it yourself** from the repository:

```sh
git clone https://github.com/kylefutter97-prog/BicuSlicer.git
cd BicuSlicer
cp docker-compose.example.yml docker-compose.yml   # then swap image: for build: . in it
docker compose up -d --build
```

Open `http://<host>:8000`.
- **First start:** BicuSlicer downloads OrcaSlicer's settings list and vendor profiles (about 25 MB, a few minutes). A setup window then asks for your printer.
- **Connect your printer:** add it under **Printers**.
- **Your data:** it lives in the `bicuslicer-data` Docker volume, so it survives updates.
- **Updating:** run `docker compose pull && docker compose up -d`. New OrcaSlicer versions are tested automatically and proposed as pull requests; see [docs/UPDATING.md](docs/UPDATING.md).

> **There is no login.** Anyone who can reach the port can slice and start prints. Run it on a trusted network, or put it behind an
> authenticating reverse proxy (Authentik, Authelia, oauth2-proxy, Caddy/nginx basic auth…). Don't expose it to the internet as-is.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MOONRAKER_URL`, `MOONRAKER_API_KEY`, `PRINTER_UI_URL`, `UPLOAD_FOLDER` | – | Optional, from older versions: read once on first start to create a printer connection. Add printers in the page instead (tap the printer pill). |
| `ORCA_DIR` | `/orca` | Optional: an OrcaSlicer data folder whose user presets you want to see (mount it read-only) |
| `DATA_DIR` | `/data` | Jobs and temporary files |
| `KEEP_JOBS` | `20` | How many recent jobs to keep |
| `SLICE_TIMEOUT` | `900` | Seconds before a slice is stopped |
| `MAX_UPLOAD_MB` | `300` | Largest upload |
| `PORT` | `8000` | Listen port |
| `ALLOW_POST_PROCESS` | – | `1` lets print settings run their post-processing scripts. Off by default: OrcaSlicer runs them on the server, and presets and projects can come from anywhere. |

The OrcaSlicer version is the `ORCA_VERSION` build argument (`docker compose build --build-arg ORCA_VERSION=2.5.1`). Build with the same version as any OrcaSlicer desktop install whose presets you import, so presets saved by one version load in the other.

## Where the OrcaSlicer data comes from

On first start, `app/tools/orca_data.py` downloads the following from OrcaSlicer's GitHub repository, for the tag matching the slicer in the image:
- the settings catalogue, parsed from `PrintConfig.cpp`, `Preset.cpp` and `Tab.cpp`;
- the vendor profiles (`resources/profiles`, JSON only).

It saves them to `DATA_DIR/orca/<tag>/`. The CLI also exports OrcaSlicer's built-in defaults there. This data is OrcaSlicer's (AGPL-3.0), so it's fetched at runtime rather than included in this MIT-licensed repository. The container needs internet access once for this. Without it, slicing still works, but the settings editor and vendor library are unavailable.

## How it works

- **Server:** `app/server.py`, a small [aiohttp](https://docs.aiohttp.org/) app, plus `app/presets.py`, which resolves OrcaSlicer presets (`inherits` chains across your presets, the OrcaSlicer folder and the vendor library) without the GUI. For each job it writes standalone, fully resolved copies of the chosen printer, filament and print settings presets (with any unsaved changes applied) into a private folder, and runs:

  ```
  orca-slicer --datadir <job folder> --load-settings "machine.json;process.json" --load-filaments filament.json \
              --arrange 0 --orient 0 --slice 0 --export-statistics --outputdir out plate.3mf
  ```

  Your OrcaSlicer folder is never written to. BicuSlicer's own presets live in `DATA_DIR/presets/`, saved the way OrcaSlicer saves user presets: just the settings that differ from the parent, plus `inherits`.
- **Auto-orient** (`POST /api/orient`): runs `orca-slicer --orient 1` on the single part and reads back the direction Orca chose to face down. The page then turns the part to match.
- **Page:** `app/static/`, plain ES modules with [three.js](https://threejs.org/) for the 3D view. Three.js and [fflate](https://github.com/101arrowz/fflate) are vendored, so the page works offline.

### Notes on OrcaSlicer 2.5's command line

- The built-in vendor profiles are packed `.opc` files.
- A user preset's `inherits` only resolves with `--datadir`, and only for preset files inside that folder's `user/default/<type>/`.
- The command line can't read STEP files. Only the desktop app can, so export STL or 3MF first.

## Development

The code has no build step. Bind-mount `./app` over `/app` (see the example compose file) and restart the container after changes:

```sh
docker restart bicuslicer
```

## Licence

**Short version:**
- BicuSlicer's own code is MIT.
- The Docker image also contains OrcaSlicer, which is AGPL-3.0, so publishing the image means passing on OrcaSlicer's licence and source link. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) has the details.


[MIT](LICENSE) for this repository. Vendored third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). OrcaSlicer itself (AGPL-3.0) is not part of this repository. The `Dockerfile` downloads its official release into the image, where it runs as a separate program.
