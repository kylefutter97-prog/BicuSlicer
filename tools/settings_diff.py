"""What changed in OrcaSlicer's settings between two versions, as a Markdown report.

    python3 tools/settings_diff.py --old v2.5.0 --new v2.5.1 --report diff.md

It builds the settings catalogue for both tags with app/tools/orca_data.py (no vendor profiles, so it's quick)
and the per-part lists with app/tools/orca_scopes.py, then lists settings that were added, removed or
probably renamed, and changes to their mode (Simple/Advanced/Expert), default, choices, label or page.
Presets that use a removed or renamed setting may need a look after updating. Standard library only.
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "app" / "tools"


def build(tag: str, work: Path) -> tuple[dict, dict]:
    out = work / tag
    for script, extra in (("orca_data.py", ["--no-profiles"]), ("orca_scopes.py", [])):
        r = subprocess.run([sys.executable, str(TOOLS / script), "--tag", tag, "--out", str(out), *extra],
                           capture_output=True, text=True)
        if r.returncode:
            raise SystemExit(f"{script} failed for {tag}: {(r.stderr or r.stdout).strip().splitlines()[-1:]}")
    return json.loads((out / "catalog.json").read_text()), json.loads((out / "scopes.json").read_text())


def where(cat: dict, key: str) -> str:
    for t, pages in cat.get("layouts", {}).items():
        for p in pages:
            for g in p["groups"]:
                if key in g["options"]:
                    return f"{t} › {p['page']} › {g['title']}"
    return "–"


def label(o: dict, key: str) -> str:
    return o.get("label") or o.get("full_label") or key


def diff(old: dict, new: dict, old_sc: dict, new_sc: dict, old_tag: str, new_tag: str) -> str:
    oo, no = old["options"], new["options"]
    added = sorted(set(no) - set(oo))
    removed = sorted(set(oo) - set(no))
    # a removed and an added setting with the same label and type in the same place were probably renamed
    renamed = []
    for r in list(removed):
        cand = [a for a in added if label(no[a], a) == label(oo[r], r) and no[a].get("type") == oo[r].get("type")
                and where(new, a).split(" › ")[0] == where(old, r).split(" › ")[0]]
        if len(cand) == 1:
            renamed.append((r, cand[0]))
            removed.remove(r)
            added.remove(cand[0])
    changed = []
    for k in sorted(set(oo) & set(no)):
        a, b = oo[k], no[k]
        notes = []
        if a.get("mode") != b.get("mode"):
            notes.append(f"mode {a.get('mode')} → {b.get('mode')}")
        if a.get("default") != b.get("default"):
            notes.append(f"default `{a.get('default')}` → `{b.get('default')}`")
        ea, eb = set(a.get("enum_values") or []), set(b.get("enum_values") or [])
        if ea != eb:
            if eb - ea:
                notes.append("new choices: " + ", ".join(f"`{x}`" for x in sorted(eb - ea)))
            if ea - eb:
                notes.append("choices gone: " + ", ".join(f"`{x}`" for x in sorted(ea - eb)))
        if label(a, k) != label(b, k):
            notes.append(f"label “{label(a, k)}” → “{label(b, k)}”")
        if a.get("type") != b.get("type") or a.get("vector") != b.get("vector"):
            notes.append(f"type {a.get('type')}{'[]' if a.get('vector') else ''} → {b.get('type')}{'[]' if b.get('vector') else ''}")
        wa, wb = where(old, k), where(new, k)
        if wa != wb:
            notes.append(f"moved {wa} → {wb}")
        if notes:
            changed.append((k, label(b, k), notes))
    part_a = set(old_sc.get("object", [])) | set(old_sc.get("region", []))
    part_b = set(new_sc.get("object", [])) | set(new_sc.get("region", []))
    now_part = sorted(k for k in (part_b - part_a) if k in oo)
    no_part = sorted(k for k in (part_a - part_b) if k in no)

    L = [f"### OrcaSlicer settings: {old_tag} → {new_tag}", "",
         f"{len(oo)} → {len(no)} settings · **{len(added)} added · {len(removed)} removed · {len(renamed)} probably renamed · "
         f"{len(changed)} changed**", ""]
    if removed or renamed:
        L += ["> ⚠️ Presets that set a removed or renamed setting lose that value in the new version: check them after updating.", ""]

    def table(title, rows, head):
        if rows:
            sep = "|" + "|".join("---" for _ in head.strip("|").split("|")) + "|"
            L.extend([f"#### {title} ({len(rows)})", "", head, sep, *rows, ""])

    table("Added", [f"| `{k}` | {label(no[k], k)} | {no[k].get('mode')} | {where(new, k)} |" for k in added], "| Setting | Label | Mode | Where |")
    table("Removed", [f"| `{k}` | {label(oo[k], k)} | {where(old, k)} |" for k in removed], "| Setting | Label | Was in |")
    table("Probably renamed", [f"| `{a}` → `{b}` | {label(no[b], b)} | {where(new, b)} |" for a, b in renamed], "| Setting | Label | Where |")
    table("Changed", [f"| `{k}` | {lab} | {'; '.join(n).replace('|', '/')} |" for k, lab, n in changed], "| Setting | Label | What changed |")
    if now_part or no_part:
        L += ["#### Per-part availability", ""]
        if now_part:
            L += ["Now settable per part: " + ", ".join(f"`{k}`" for k in now_part), ""]
        if no_part:
            L += ["No longer settable per part: " + ", ".join(f"`{k}`" for k in no_part), ""]
    if not (added or removed or renamed or changed or now_part or no_part):
        L += ["No setting changes.", ""]
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--old", required=True, help="e.g. v2.5.0")
    ap.add_argument("--new", required=True, help="e.g. v2.5.1")
    ap.add_argument("--report", help="write the Markdown here (also printed)")
    args = ap.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        old_cat, old_sc = build(args.old, Path(tmp))
        new_cat, new_sc = build(args.new, Path(tmp))
    md = diff(old_cat, new_cat, old_sc, new_sc, args.old, args.new)
    if args.report:
        Path(args.report).write_text(md)
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
