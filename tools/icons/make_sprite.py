"""Build app/static/icons.svg, the page's icon sprite, from Lucide (https://lucide.dev, ISC licence).

    python3 tools/icons/make_sprite.py

Downloads the listed icons of a pinned lucide-static version and writes one <symbol id="i-NAME"> per icon. The page
uses them as <svg class="ic"><use href="/static/icons.svg#i-NAME"/></svg>, coloured by the surrounding text.
To add an icon, add its Lucide name below and run this again. Standard library only.
"""
import re
import sys
import urllib.request
from pathlib import Path

VERSION = "0.460.0"
ICONS = """undo-2 redo-2 file-plus shapes layout-grid rotate-3d arrow-down-to-line ungroup group scissors flip-horizontal-2
boxes ear paintbrush flask-conical ellipsis plus save scan trash-2 folder-open printer sliders-horizontal layers box pause
code type""".split()

OUT = Path(__file__).resolve().parents[2] / "app" / "static" / "icons.svg"


def fetch(name: str) -> str:
    url = f"https://unpkg.com/lucide-static@{VERSION}/icons/{name}.svg"
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read().decode()


def main() -> int:
    symbols = []
    for name in ICONS:
        svg = fetch(name)
        body = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1)
        body = re.sub(r"\s*\n\s*", "", body).strip()
        symbols.append(f'<symbol id="i-{name}" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" '
                       f'stroke-linecap="round" stroke-linejoin="round">{body}</g></symbol>')
    OUT.write_text(f'<svg xmlns="http://www.w3.org/2000/svg">\n<!-- Lucide icons v{VERSION}, ISC licence: see THIRD_PARTY_NOTICES.md -->\n'
                   + "\n".join(symbols) + "\n</svg>\n")
    print(f"{len(symbols)} icons -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
