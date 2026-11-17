# BicuSlicer

BicuSlicer is a web front end for OrcaSlicer's slicing engine: open models (STL, 3MF, OBJ, STEP, OrcaSlicer and
MakerWorld projects), lay out plates, use OrcaSlicer's settings and profiles, slice, look through the layers and send
the result to your printer, from a computer or a phone. This add-on runs it inside Home Assistant and puts it in the
sidebar.

## Installation

1. Install the add-on and start it.
2. Open **BicuSlicer** from the sidebar (or **Open web UI**).
3. The first start downloads OrcaSlicer's settings list and printer library (about 25 MB); the setup window then asks
   for your printer. Add the printer's connection (Moonraker etc.) under **Printers**.

The add-on is large (about 2 GB): it contains OrcaSlicer itself. A slice needs about 1-2 GB of RAM while it runs, so a
Raspberry Pi 4 with 2 GB is too small; a Pi 5 or an x86-64 machine is fine.

## Options

There are no options: everything is set up inside BicuSlicer.

## Network

Through the sidebar, BicuSlicer is behind Home Assistant's login, and works through Home Assistant's remote access
too. The **Network** section can also open port 8000 directly (off by default), e.g. for phones that aren't signed in
to Home Assistant. That direct port has **no login**: only use it on a network you trust.

## Your data

Printers, presets, projects and recent slices are kept in the add-on's own storage, included in Home Assistant
backups. Recent slices are kept (20 by default), so backups grow with them.

## Limitations

- Slicing is one job at a time and can take a while on small hardware.
- The printer has to be reachable from Home Assistant (same network).

## Help and licence

Issues and questions: https://github.com/kylefutter97-prog/BicuSlicer/issues. BicuSlicer is MIT-licensed; OrcaSlicer,
inside the image, is AGPL-3.0 (see THIRD_PARTY_NOTICES.md in the repository).
