"""Multi-colour in headless Chromium: filament slots, a part on filament 2, colour painting, a filament change at a
layer, the prime tower, manual swaps (M600) in the result, and removing a slot.

    python ui_multicolour_test.py http://bicuslicer:8000/

Uses this (throwaway) browser's own filament slots; slices twice; saves nothing.
"""
import json, os, re, sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service

URL = sys.argv[1]
PROJECT = sys.argv[2] if len(sys.argv) > 2 else None     # e.g. OrcaSlicer's resources/handy_models/OrcaBadge.3mf (4 colours)
OUT = os.environ.get("OUT", "/out")
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f": {detail}" if detail != "" else ""), flush=True)


o = webdriver.ChromeOptions()
for a in ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1400,1000", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]:
    o.add_argument(a)
o.binary_location = os.environ.get("CHROME_BIN", "/usr/bin/chromium")
o.set_capability("goog:loggingPrefs", {"browser": "ALL"})
d = webdriver.Chrome(service=Service(os.environ.get("CHROMEDRIVER", "/app/chromedriver")), options=o)
el = lambda i: d.find_element(By.ID, i)
items = lambda: [li.text.replace("\n", " | ") for li in d.find_elements(By.CSS_SELECTOR, "#objects li")]
W = lambda t=0.6: time.sleep(t)
mouse = lambda kind, x, y, b="left", bs=1: d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": b, "buttons": bs, "clickCount": 1})


def select(name):
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith(name):
            li.click(); W(); return True


def slice_now():
    d.execute_script("document.getElementById('slice').click()")
    for _ in range(300):
        W(1)
        if "layers" in el("result").text or "msg err" in el("result").get_attribute("innerHTML"):
            break
    return el("result").text


def write_box(path, sx, sy, sz):
    v = [(x, y, z) for x in (0, sx) for y in (0, sy) for z in (0, sz)]
    tris = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
    with open(path, "w") as f:
        f.write("solid b\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid b\n")


try:
    write_box("/tmp/red.stl", 20, 20, 10)
    write_box("/tmp/blue.stl", 20, 20, 10)
    d.get(URL); W(8)
    # 1. a second filament slot
    d.execute_script("document.getElementById('fil-add').click()"); W(1)
    slots = d.find_elements(By.CSS_SELECTOR, "#fil-slots .fil-slot")
    check("adding a filament makes two slots", len(slots) == 2, len(slots))
    d.execute_script("const c = document.querySelector('#fil-slots input[data-colour=\"1\"]'); c.value = '#e23c3c'; c.dispatchEvent(new Event('change', {bubbles: true}))"); W()
    # 2. two parts, the second on filament 2
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/red.stl"); W(2)
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/blue.stl"); W(2)
    select("blue")
    check("the part panel offers a filament", el("obj-filament").is_displayed())
    d.execute_script("const s = document.getElementById('obj-filament'); s.value = '2'; s.dispatchEvent(new Event('change'))"); W(1)
    sw = d.execute_script("return [...document.querySelectorAll('#objects .fil-swatch')].map(s => s.style.background)")
    check("parts show their filament's colour", len(sw) == 2 and sw[0] != sw[1], sw)
    towers = d.execute_script("return document.querySelectorAll('#viewer canvas').length")
    res = slice_now()
    check("a two-filament plate slices", "layers" in res, res[:90].replace("\n", " "))
    check("the result shows each filament's grams and the manual swaps", "filament change" in res and "M600" in res and "2:" in res, res.replace("\n", " ")[:260])
    d.save_screenshot(f"{OUT}/mc-two-parts.png")
    # 3. colour painting on the first part with filament 2
    select("red")
    d.execute_script("document.querySelector('[data-tool=paint]').click()"); W(0.4)
    for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
        if "Colours" in b.text:
            b.click(); break
    W(2)
    tools = [b.text for b in d.find_elements(By.CSS_SELECTOR, "#paint-tools button")]
    check("colour painting: a tool per filament and Erase", tools == ["1", "2", "Erase"], tools)
    d.execute_script("document.querySelector('#paint-tools [data-paint-tool=\"2\"]').click()"); W(0.3)
    d.find_element(By.TAG_NAME, "body").send_keys("z"); W(1)
    r = d.execute_script("const b = document.querySelector('#viewer canvas').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]")
    cx, cy = int(r[0] + r[2] * 0.66), int(r[1] + r[3] * 0.62)        # right of the paint panel
    mouse("mouseMoved", cx, cy, "none", 0); mouse("mousePressed", cx, cy)
    for k in range(1, 20):
        mouse("mouseMoved", cx + k * 4, cy + (k % 2)); W(0.02)
    mouse("mouseReleased", cx + 76, cy, "left", 0); W(0.6)
    d.save_screenshot(f"{OUT}/mc-paint.png")
    el("paint-done").click(); W(0.6)
    check("the painted part is marked", any(x.startswith("red") and "🖌" in x for x in items()), items())
    res = slice_now()
    d.execute_script("document.querySelector('[data-view=\"preview\"]').click()"); W(4)
    check("a plate that mixes filaments can't also change filament at a layer (OrcaSlicer's rule)", el("lg-filament").get_attribute("disabled") is not None)
    # 4. a filament change at a layer: both parts back on filament 1, unpainted
    d.execute_script("document.querySelector('[data-view=\"model\"]').click()"); W()
    for name in ("red", "blue"):
        select(name)
        d.execute_script("const s = document.getElementById('obj-filament'); s.value = '1'; s.dispatchEvent(new Event('change'))"); W(0.5)
    select("red")
    d.execute_script("document.querySelector('[data-tool=paint]').click()"); W(0.4)
    for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
        if "Colours" in b.text:
            b.click(); break
    W(1.5)
    el("paint-clear").click(); W(0.3); el("paint-done").click(); W(0.5)
    res = slice_now()
    d.execute_script("document.querySelector('[data-view=\"preview\"]').click()"); W(4)
    d.execute_script("const r = document.getElementById('layer'); r.value = 20; r.dispatchEvent(new Event('input'))"); W()
    check("Layers view offers Change filament", el("lg-filament").is_displayed() and el("lg-filament").get_attribute("disabled") is None)
    el("lg-filament").click(); W(0.4)
    for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
        if b.text.startswith("Filament 2"):
            b.click(); break
    W()
    chips = [c.text for c in d.find_elements(By.CSS_SELECTOR, "#lg-list .lg-chip")]
    check("filament change listed at the layer", chips and "Filament 2" in chips[0], chips)
    res = slice_now()
    m = re.search(r"(\d+) filament change", res)
    check("one filament change at the layer: one swap", "layers" in res and m and int(m.group(1)) == 1, res.replace("\n", " ")[:200])
    # 5. removing slot 2: back to one filament
    d.execute_script("document.querySelector('#fil-slots [data-remove=\"1\"]').click()"); W(1)
    check("removing the slot: one filament again, no filament pickers", not d.find_elements(By.CSS_SELECTOR, "#fil-slots .fil-slot") and not el("obj-filament").is_displayed())
    if PROJECT:
        # a multi-colour OrcaSlicer project: its colours become slots, parts in other filaments come along as coloured parts
        d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys(PROJECT); W(4)
        if d.find_elements(By.CSS_SELECTOR, "#import-dlg[open]"):
            d.find_element(By.CSS_SELECTOR, "#import-dlg button[value=ok]").click(); W(1.5)
            for b in d.find_elements(By.CSS_SELECTOR, "dialog[open] button"):
                if b.text == "Replace":          # the plate had unsaved parts
                    b.click(); break
            W(5)
        slots = d.find_elements(By.CSS_SELECTOR, "#fil-slots .fil-slot")
        it = items()
        check("multi-colour project: its colours become filament slots", len(slots) >= 2, (len(slots), el("plate-flash").text[:160]))
        check("its parts in other filaments come in as coloured parts", any("raised part" in x for x in it), it[:8])
        d.save_screenshot(f"{OUT}/mc-project.png")
        res = slice_now()
        check("the multi-colour project slices", "layers" in res, res.replace("\n", " ")[:220])

    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
