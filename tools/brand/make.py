"""Build BicuSlicer's brand assets from the 16x16 pixel drawing in pixels.py (needs Pillow).

Usage (from the repo root): python3 tools/brand/make.py app/static/brand docs
Writes the favicons, app icons, header logo (logo.svg + logo-inline.txt to paste into index.html),
the README banner and app/static/manifest.webmanifest.
"""
import json, sys
from pathlib import Path
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parent))   # pixels.py sits next to this script
from pixels import A, PAL, FONT, rects, word

OUT = Path(sys.argv[1]); DOCS = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True); DOCS.mkdir(parents=True, exist_ok=True)
GRID = A.splitlines()
BG = PAL["K"]
ACCENT = "#4dabf7"   # matches the page accent in dark mode
# pixel-art rounded corners on the 16x16 tile (transparent corner pixels)
CORNER = {(0,0),(1,0),(0,1),(14,0),(15,0),(15,1),(0,14),(0,15),(1,15),(15,14),(14,15),(15,15)}

def rgb(h): h=h.lstrip("#"); return tuple(int(h[i:i+2],16) for i in (0,2,4))

def tile(scale, pad=0, rounded=True, size=None):
    """The icon on its dark tile, scaled by whole pixels. pad = extra tile around the 16x16 grid (in output px)."""
    n = 16*scale + 2*pad
    img = Image.new("RGBA", (n, n), (0,0,0,0) if rounded else rgb(BG)+(255,))
    px = img.load()
    for y in range(n):
        for x in range(n):
            gx, gy = (x - pad)//scale if x >= pad else -1, (y - pad)//scale if y >= pad else -1
            inside = 0 <= gx < 16 and 0 <= gy < 16
            if rounded and pad == 0 and (gx, gy) in CORNER:
                continue
            ch = GRID[gy][gx] if inside else "."
            px[x, y] = rgb(PAL[ch] if ch != "." else BG) + (255,)
    if size and size != n:
        img = img.resize((size, size), Image.NEAREST)
    return img

# PNGs
tile(1).save(OUT/"favicon-16.png")
tile(2).save(OUT/"favicon-32.png")
tile(10, pad=10, rounded=False).save(OUT/"apple-touch-icon.png")           # 180x180, iOS rounds the corners itself
tile(11, pad=8, rounded=False).save(OUT/"icon-192.png")                    # 192x192
tile(30, pad=16, rounded=False).save(OUT/"icon-512.png")                   # 512x512, art inside the maskable safe zone
ico = tile(2)
ico.save(OUT/"favicon.ico", sizes=[(16,16),(32,32)], bitmap_format="png", append_images=[tile(1)])

# SVG favicon: tile with pixel-rounded corners + art
def tile_svg(s, x0=0, y0=0):
    # one grid with the tile colour filled in (corners left empty), drawn as merged horizontal runs
    filled = "\n".join("".join("." if (x, y) in CORNER else ("K" if GRID[y][x] == "." else GRID[y][x]) for x in range(16)) for y in range(16))
    return rects(filled, x0, y0, s)
(OUT/"favicon.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">{tile_svg(1)}</svg>')

# header logo: icon + wordmark; "Bicu" uses currentColor so it follows light/dark text, "Slicer" the accent
icon = tile_svg(1)
w_bicu, end1 = word("Bicu", 20, 4.5, 1, ["currentColor"]*4)
w_slicer, end2 = word("Slicer", end1 + 2, 4.5, 1, [ACCENT]*6)
(OUT/"logo.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {end2+1} 16" shape-rendering="crispEdges">{icon}{w_bicu}{w_slicer}</svg>')
(OUT/"logo-inline.txt").write_text(f'<svg class="brand-logo" viewBox="0 0 {end2+1} 16" shape-rendering="crispEdges" aria-hidden="true">{icon}<g class="wm">{w_bicu}<g class="acc">{w_slicer}</g></g></svg>')

# README banner (fixed dark tile, reads on GitHub light and dark)
s = 6
icon_b = tile_svg(s, 24, 24)
wb, e1 = word("Bicu", 24 + 16*s + 30, 24 + 4.5*s, s, ["#eceef2"]*4)
ws, e2 = word("Slicer", e1 + 2*s, 24 + 4.5*s, s, [ACCENT]*6)
W, H = e2 + 40, 16*s + 48
(DOCS/"banner.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" shape-rendering="crispEdges">'
                               f'<rect width="{W}" height="{H}" rx="24" fill="{BG}"/>{icon_b}{wb}{ws}</svg>')

# web app manifest
(OUT.parent/"manifest.webmanifest").write_text(json.dumps({
    "name": "BicuSlicer", "short_name": "BicuSlicer", "start_url": "/", "scope": "/", "display": "standalone",
    "background_color": BG, "theme_color": BG,
    "icons": [{"src": "/static/brand/icon-192.png", "sizes": "192x192", "type": "image/png"},
              {"src": "/static/brand/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
              {"src": "/static/brand/favicon.svg", "sizes": "any", "type": "image/svg+xml"}]}, indent=1))
for f in sorted(OUT.iterdir()): print(f.name, f.stat().st_size)
print("banner", W, H)
