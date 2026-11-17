"""The Layers view's colour modes in headless Chromium (like OrcaSlicer's G-code viewer: line type, layer height, width,
speed, fan, temperature, volumetric flow, layer time, filament).

    python ui_colourmodes_test.py http://bicuslicer:8000/ [height of the second part, mm]

Uses this (throwaway) browser's own filament slots; slices once; saves nothing.
"""
import json, os, sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service

URL = sys.argv[1]
TALL = float(sys.argv[2]) if len(sys.argv) > 2 else 10      # height of the second part (a tall one checks the tower's ribs)
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


def write_box(path, sx, sy, sz):
    v = [(x, y, z) for x in (0, sx) for y in (0, sy) for z in (0, sz)]
    tris = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
    with open(path, "w") as f:
        f.write("solid b\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid b\n")


def set_mode(m):
    d.execute_script("const s = document.getElementById('color-mode'); s.value = arguments[0]; s.dispatchEvent(new Event('change'))", m)
    W(0.8)


# a cheap fingerprint of the line colours: how many distinct colours, and a sum
colours = lambda: d.execute_script("""const a = window.__pv.geo.getAttribute('color').array; const s = new Set(); let t = 0;
  for (let i = 0; i < a.length; i += 6) { s.add(a[i].toFixed(3) + a[i+1].toFixed(3) + a[i+2].toFixed(3)); t += a[i] + 2 * a[i+1] + 3 * a[i+2]; }
  return [s.size, +t.toFixed(1)];""")

try:
    write_box("/tmp/red.stl", 20, 20, 6)
    write_box("/tmp/blue.stl", 12, 12, TALL)
    d.get(URL); W(8)
    d.execute_script("document.getElementById('fil-add').click()"); W(1)
    d.execute_script("const c = document.querySelector('#fil-slots input[data-colour=\"1\"]'); c.value = '#2050e0'; c.dispatchEvent(new Event('change', {bubbles: true}))"); W()
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/red.stl"); W(2)
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/blue.stl"); W(2)
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith("blue"):
            li.click(); break
    W()
    d.execute_script("const s = document.getElementById('obj-filament'); s.value = '2'; s.dispatchEvent(new Event('change'))"); W(1)
    d.execute_script("document.getElementById('slice').click()")
    for _ in range(300):
        W(1)
        if "layers" in el("result").text or "msg err" in el("result").get_attribute("innerHTML"):
            break
    check("the plate slices", "layers" in el("result").text, el("result").text[:90].replace("\n", " "))
    d.execute_script("document.querySelector('[data-view=\"preview\"]').click()"); W(5)
    # reach the Preview object through the module scope: the legend's change handler is ours, so expose it once
    d.execute_script("""import('/static/preview.js').then(m => { const P = m.Preview.prototype, r = P.recolour;
      P.recolour = function () { window.__pv = this; return r.call(this); }; });""")
    W(0.5)
    set_mode("feature")
    opts = d.execute_script("return [...document.querySelectorAll('#color-mode option')].map(o => o.value)")
    want = ["feature", "height", "width", "speed", "fan", "temp", "flow", "layertime", "layertimelog", "filament"]
    check("all the colour modes are offered", opts == want, opts)
    check("the layer readout shows OrcaSlicer's layer time", any(u in el("layer-text").text for u in ("s", "m")) and el("layer-text").text.count("·") >= 2, el("layer-text").text)
    base = colours()
    check("line type: coloured by feature, no scale shown", base[0] >= 2 and el("mode-legend").get_attribute("hidden") is not None, base)
    seen = {"feature": base}
    for m in want[1:]:
        set_mode(m)
        seen[m] = colours()
        legend = el("mode-legend").text.replace("\n", " ")
        ok = el("mode-legend").get_attribute("hidden") is None and legend
        if m == "filament":
            ok = ok and "Filament 1" in legend and "Filament 2" in legend
        check(f"{m}: recoloured with a legend", ok and seen[m] != base, (seen[m], legend[:120]))
        if m in ("speed", "filament", "layertime"):
            d.save_screenshot(f"{OUT}/cm-{m}.png")
    check("speed: a range of speeds shown (several colours)", seen["speed"][0] >= 3, seen["speed"])
    check("filament: exactly two colours", seen["filament"][0] == 2, seen["filament"])
    # hiding a line type re-ranges the scale (the prime tower's filament loading is the highest flow)
    set_mode("flow")
    before = el("mode-legend").text
    d.execute_script("""const l = [...document.querySelectorAll('#legend .lg')].find(x => /Prime tower/.test(x.textContent));
      const c = l.querySelector('input'); c.checked = false; c.dispatchEvent(new Event('change', {bubbles: true}));""")
    W(0.8)
    check("hiding a line type changes the scale to what's shown", el("mode-legend").text != before, (before.replace("\n", " "), el("mode-legend").text.replace("\n", " ")))
    # the choice is remembered on reload
    d.refresh(); W(8)
    check("the chosen mode is remembered", d.execute_script("return localStorage.getItem('bs-colour-mode')") == "flow")
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
