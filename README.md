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
- **Your presets:** printer, quality and filament presets are read from your OrcaSlicer data folder (read-only). Edit a preset in the desktop app and it shows up here.
- **Quick overrides:** supports (off / normal / tree), brim, and infill. Each one defaults to "Preset", which leaves your preset unchanged.
- **Results:** print time, filament weight and length, layer count and cost.
- **Printer:** send the G-code to Moonraker, then start the print with a separate, confirmed tap. Starting is refused unless Klipper is ready and the printer is idle. A status pill shows printer state and temperatures.

What the page shows is what gets sliced. The page bakes every placed part into one 3MF in bed coordinates, and the server slices that 3MF with `--arrange 0`.

## Requirements

- Docker on an **x86-64** host. The image is built on [linuxserver/orcaslicer](https://docs.linuxserver.io/images/docker-orcaslicer/), which is amd64-only and about 7 GB.
- An OrcaSlicer data folder with your user presets. The easiest source is the same linuxserver/orcaslicer container running the desktop app: its `/config/.config/OrcaSlicer`.
- A Klipper printer with Moonraker, reachable from the container.
- About 1–2 GB of RAM while a slice runs. Jobs are sliced one at a time.

## Quick start

```sh
git clone https://github.com/<you>/BicuSlicer.git
cd BicuSlicer
cp docker-compose.example.yml docker-compose.yml   # then edit the paths and MOONRAKER_URL
docker compose up -d --build
```

Open `http://<host>:8000`.

> **There is no login.** Anyone who can reach the port can slice and start prints. Run it on a trusted network, or put it behind an
> authenticating reverse proxy (Authentik, Authelia, oauth2-proxy, Caddy/nginx basic auth…). Don't expose it to the internet as-is.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MOONRAKER_URL` | `http://localhost:7125` | Moonraker's base URL (Mainsail/Fluidd's nginx on port 80 also works) |
| `MOONRAKER_API_KEY` | – | Only needed if Moonraker doesn't list this host in `trusted_clients` |
| `PRINTER_UI_URL` | Moonraker's host | Link used by the status pill and "Open printer" |
| `UPLOAD_FOLDER` | – (gcodes root) | Sub-folder in Moonraker's `gcodes` for uploads |
| `ORCA_DIR` | `/orca` | OrcaSlicer data folder (mount it read-only) |
| `DATA_DIR` | `/data` | Jobs and temporary files |
| `KEEP_JOBS` | `20` | How many recent jobs to keep |
| `SLICE_TIMEOUT` | `900` | Seconds before a slice is stopped |
| `MAX_UPLOAD_MB` | `300` | Largest upload |
| `PORT` | `8000` | Listen port |

The OrcaSlicer version comes from the base image tag in the `Dockerfile`. Keep it the same as your desktop OrcaSlicer, so presets saved by one version load in the other.

## How it works

- **Server:** `app/server.py`, a small [aiohttp](https://docs.aiohttp.org/) app. For each job it copies the OrcaSlicer data folder's `system/` profiles and `user/` presets into a private folder, applies the overrides to the chosen process preset, and runs:

  ```
  orca-slicer --datadir <job folder> --load-settings "machine.json;process.json" --load-filaments filament.json \
              --arrange 0 --orient 0 --slice 0 --export-statistics --outputdir out plate.3mf
  ```

  Your real OrcaSlicer folder is never written to.
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

[MIT](LICENSE). Vendored third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). OrcaSlicer itself (AGPL-3.0) is not part of this repository. It comes from the base image and runs as a separate program.
