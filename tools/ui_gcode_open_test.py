"""Opening G-code files in headless Chromium: an OrcaSlicer G-code (its layers, print time and filament, the printer
it was made for, Send), a Cura-style file (layer markers of its own), a sliced .gcode.3mf with two plates, a binary
.bgcode refused with a reason, and a G-code plate going out of date once a part is added to it. Sends nothing.

    python ui_gcode_open_test.py http://bicuslicer:8000/ sample.gcode

sample.gcode: any G-code BicuSlicer sliced (it reads the print time, grams and layer count from it).
"""
import json, os, re, sys, time, zipfile
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service

URL, SAMPLE = sys.argv[1], sys.argv[2]
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
W = lambda t=0.6: time.sleep(t)


def add(path):
    inp = d.find_elements(By.CSS_SELECTOR, ".file-input")[0]
    d.execute_script("arguments[0].value = ''", inp)
    inp.send_keys(path); W(5)


try:
    text = open(SAMPLE, encoding="utf-8", errors="replace").read()
    want_layers = int(re.search(r"; total layer number: (\d+)", text).group(1))
    want_g = float(re.search(r"; total filament used \[g\] = ([\d.]+)", text).group(1))
    # a Cura-style file and a two-plate .gcode.3mf
    cura = ";FLAVOR:Marlin\n;TIME:600\n;Filament used: 0.5m\n;LAYER_COUNT:5\n;Generated with Cura_SteamEngine 5.7.0\nG28\nM82\nG92 E0\n" + "".join(
        f";LAYER:{i}\n;TYPE:WALL-OUTER\nG0 F3000 X100 Y100 Z{0.2 + i * 0.2:.1f}\nG1 F1500 X130 Y100 E{(i * 4 + 1):.1f}\nG1 X130 Y130 E{(i * 4 + 2):.1f}\nG1 X100 Y130 E{(i * 4 + 3):.1f}\nG1 X100 Y100 E{(i * 4 + 4):.1f}\n" for i in range(5))
    open("/tmp/cura_part.gcode", "w").write(cura)
    with zipfile.ZipFile("/tmp/two plates.gcode.3mf", "w") as z:
        z.writestr("Metadata/plate_1.gcode", text)
        z.writestr("Metadata/plate_2.gcode", cura)
        z.writestr("3D/3dmodel.model", "<model/>")
    open("/tmp/print.bgcode", "wb").write(b"GCDE\x01\x00")
    d.get(URL); W(8)
    # 1. an OrcaSlicer G-code
    add(SAMPLE)
    res = el("result").text
    check("it opens on a plate with its layers shown", el("pv-layers").is_displayed() and f"of {want_layers}" in el("layer-text").text, el("layer-text").text)
    check("print time, grams and layers from the file", f"{want_g:.1f} g" in res and str(want_layers) in res, res.replace("\n", " ")[:160])
    check("it names the slicer it came from", "OrcaSlicer" in el("plate-flash").text, el("plate-flash").text)
    btn = el("slice").text
    check("ready to send to the printer it was made for", btn.startswith("Send to") or btn.startswith("Add a printer"), btn)
    href = d.execute_script("const a = [...document.querySelectorAll('#result a.btn')].find(a => /\\/gcode$/.test(a.getAttribute('href'))); return a && a.getAttribute('href')")
    check("it can be downloaded again", bool(href), href)
    check("no pause / G-code-at-a-layer buttons (it isn't sliced here)", not el("lg-row").is_displayed())
    tabs = len(d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab"))
    # the colour modes work on it
    d.execute_script("const s = document.getElementById('color-mode'); s.value = 'speed'; s.dispatchEvent(new Event('change'))"); W(0.6)
    check("colour modes work on it", "mm/s" in el("mode-legend").text, el("mode-legend").text[:80])
    d.execute_script("const s = document.getElementById('color-mode'); s.value = 'feature'; s.dispatchEvent(new Event('change'))"); W(0.3)
    d.save_screenshot(f"{OUT}/gcode-open.png")
    # 2. Cura-style: its own layer markers
    add("/tmp/cura_part.gcode")
    check("a Cura-style file: on a new plate, its 5 layers", len(d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")) == tabs + 1 and "of 5" in el("layer-text").text, el("layer-text").text)
    check("…its time from Cura's comment", "10m" in el("result").text, el("result").text.replace("\n", " ")[:120])
    # 3. a sliced .gcode.3mf with two plates
    add("/tmp/two plates.gcode.3mf")
    check("a sliced .gcode.3mf brings both plates' G-code", "Plate 1" in el("result").text and "Plate 2" in el("result").text, el("result").text.replace("\n", " ")[:160])
    # 4. .bgcode: refused, saying why
    add("/tmp/print.bgcode")
    check("binary G-code is refused with the reason", "Binary G-code" in el("plate-flash").text, el("plate-flash").text)
    # 5. adding a part to a G-code plate: the G-code no longer matches it
    with open("/tmp/box.stl", "w") as f:
        v = [(x, y, z) for x in (0, 10) for y in (0, 10) for z in (0, 10)]
        tris = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
        f.write("solid b\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid b\n")
    add("/tmp/box.stl")
    check("adding a part makes it a normal plate to slice", el("slice").text.startswith("Slice"), el("slice").text)
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE" and "/api/gcode-file" not in e["message"]]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
