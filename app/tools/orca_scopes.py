"""Which OrcaSlicer settings can be set per part (per object), for a given OrcaSlicer tag.

OrcaSlicer allows per-object settings from two config classes in src/libslic3r/PrintConfig.hpp:
PrintObjectConfig (object-level: layer height, supports, brim, seam, ...) and PrintRegionConfig
(region-level: walls, infill, shells, speeds, ...). This reads those class definitions and writes
{"object": [...], "region": [...]} to <out>/scopes.json.

It also reads the desktop app's named rows from src/slic3r/GUI/Tab.cpp (e.g. "Cool Plate" holding
cool_plate_temp_initial_layer + cool_plate_temp side by side) into "lines": {key: {"label", "tooltip"}},
so the page can show those settings as one labelled row like OrcaSlicer does.

Like orca_data.py, it fetches OrcaSlicer's (AGPL) source at runtime instead of storing it here.
Usage: python3 orca_scopes.py --tag v2.5.1 --out <dir>
"""

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

URL = "https://raw.githubusercontent.com/OrcaSlicer/OrcaSlicer/{tag}/src/libslic3r/PrintConfig.hpp"
TAB_URL = "https://raw.githubusercontent.com/OrcaSlicer/OrcaSlicer/{tag}/src/slic3r/GUI/Tab.cpp"
LINE_START = re.compile(r'^\s*(?:(?:Line|auto)\s+)?line\s*=?\s*(?:Line\s*)?\{(.*)$')   # line = {..}, Line line {..}, Line line = Line{..}
LINE_END = re.compile(r'->append_line\(\s*line\s*\)')
STRING = re.compile(r'L\("((?:[^"\\]|\\.)*)"\)|"((?:[^"\\]|\\.)*)"')
VAR_OPT = re.compile(r'(\w+)\s*=\s*optgroup->get_option\(\s*"(\w+)"')
APPEND = re.compile(r'line\.append_option\(\s*(.*?)\s*\)\s*;')
DIRECT = re.compile(r'get_option\(\s*"(\w+)"')
CLASS = re.compile(r"^PRINT_CONFIG_CLASS_(?:DERIVED_)?DEFINE0?\(\s*(\w+)", re.M)
OPTION = re.compile(r"\(\(\s*ConfigOption(?:\w+)?(?:<[^>]*>)?\s*,\s*(\w+)\s*\)\)")


def parse(source: str) -> dict:
    starts = [m.start() for m in CLASS.finditer(source)] + [len(source)]
    classes = {}
    for a, b in zip(starts, starts[1:]):
        block = source[a:b]
        name = CLASS.match(block).group(1)
        classes[name] = OPTION.findall(block)
    out = {"object": classes.get("PrintObjectConfig", []), "region": classes.get("PrintRegionConfig", [])}
    if len(out["object"]) < 20 or len(out["region"]) < 20:
        raise ValueError("PrintConfig.hpp didn't parse as expected (too few per-object options)")
    return out


def parse_lines(tab: str) -> dict:
    """Map option key -> the named row ("Line") it is shown in, with that row's tooltip."""
    out, var, label, tip = {}, {}, None, ""
    rows = tab.splitlines()
    for i, raw in enumerate(rows):
        line = raw.split("//", 1)[0] if not raw.lstrip().startswith("//") else ""
        if not line.strip():
            continue
        m = VAR_OPT.search(line)
        if m:
            var[m.group(1)] = m.group(2)
        m = LINE_START.match(line)
        if m:
            # the label and tooltip may continue on the following lines, up to the closing "};"
            text = m.group(1)
            j = i
            while "};" not in text and j + 1 < len(rows) and j < i + 4:
                j += 1
                text += " " + rows[j].strip()
            strings = [a or b for a, b in STRING.findall(text)]
            label = strings[0].strip() if strings else ""
            tip = strings[1].strip() if len(strings) > 1 else ""
            continue
        if LINE_END.search(line):
            label = None                # the row is finished; later settings aren't part of it
            continue
        m = APPEND.search(line)
        if m and label:
            arg = m.group(1)
            d = DIRECT.search(arg)
            key = d.group(1) if d else var.get(arg.strip())
            if key:
                out.setdefault(key, {"label": label, "tooltip": tip})
    return out


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "BicuSlicer-orca-scopes"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--tag", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    try:
        source = fetch(URL.format(tag=args.tag))
    except Exception as e:
        print(f"download failed: {e}", file=sys.stderr)
        return 2
    try:
        scopes = parse(source)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 1
    try:
        scopes["lines"] = parse_lines(fetch(TAB_URL.format(tag=args.tag)))
    except Exception as e:             # optional: only affects how a few settings are labelled
        print(f"named rows skipped: {e}", file=sys.stderr)
        scopes["lines"] = {}
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "scopes.json.tmp"
    tmp.write_text(json.dumps(scopes, indent=1), encoding="utf-8")
    tmp.replace(out / "scopes.json")
    print(f"object {len(scopes['object'])}, region {len(scopes['region'])}, named-row options {len(scopes['lines'])}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
