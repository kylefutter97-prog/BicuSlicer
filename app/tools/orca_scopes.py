"""Which OrcaSlicer settings can be set per part (per object), for a given OrcaSlicer tag.

OrcaSlicer allows per-object settings from two config classes in src/libslic3r/PrintConfig.hpp:
PrintObjectConfig (object-level: layer height, supports, brim, seam, ...) and PrintRegionConfig
(region-level: walls, infill, shells, speeds, ...). This reads those class definitions and writes
{"object": [...], "region": [...]} to <out>/scopes.json.

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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--tag", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    req = urllib.request.Request(URL.format(tag=args.tag), headers={"User-Agent": "BicuSlicer-orca-scopes"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            source = r.read().decode("utf-8", "replace")
    except Exception as e:
        print(f"download failed: {e}", file=sys.stderr)
        return 2
    try:
        scopes = parse(source)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 1
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    tmp = out / "scopes.json.tmp"
    tmp.write_text(json.dumps(scopes, indent=1))
    tmp.replace(out / "scopes.json")
    print(f"object {len(scopes['object'])}, region {len(scopes['region'])}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
