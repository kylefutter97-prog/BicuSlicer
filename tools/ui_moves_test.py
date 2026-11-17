"""The Layers view's move slider (stepping through one layer's moves, with the nozzle and the G-code line being run)
and the time / filament per line type table, in headless Chromium.

    python ui_moves_test.py http://bicuslicer:8000/

Slices once; saves nothing.
"""
import json, os, sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.chrome.service import Service

URL = sys.argv[1]
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
pv = lambda js: d.execute_script("const p = window.__pv; " + js)

try:
    with open("/tmp/box.stl", "w") as f:
        v = [(x, y, z) for x in (0, 30) for y in (0, 20) for z in (0, 4)]
        tris = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
        f.write("solid b\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid b\n")
    d.get(URL); W(8)
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/box.stl"); W(2)
    d.execute_script("document.getElementById('slice').click()")
    for _ in range(240):
        W(1)
        if "layers" in el("result").text or "msg err" in el("result").get_attribute("innerHTML"):
            break
    check("the plate slices", "layers" in el("result").text, el("result").text[:80].replace("\n", " "))
    d.execute_script("""import('/static/preview.js').then(m => { const P = m.Preview.prototype, r = P.setLayer;
      P.setLayer = function (n) { window.__pv = this; return r.call(this, n); }; });""")
    W(0.5)
    d.execute_script("document.querySelector('[data-view=\"preview\"]').click()"); W(5)
    d.execute_script("const r = document.getElementById('layer'); r.value = 5; r.dispatchEvent(new Event('input'))"); W()
    check("the move slider shows in the Layers view", el("pv-moves").is_displayed())
    n = int(el("move").get_attribute("max"))
    full = pv("return p.curGeo.drawRange.count")
    check("it starts at the layer's last move, no G-code box", int(el("move").get_attribute("value")) == n and not el("gcode-lines").is_displayed() and n > 5, (n, el("move").get_attribute("value")))
    d.execute_script("const r = document.getElementById('move'); r.value = Math.round(r.max / 2); r.dispatchEvent(new Event('input'))"); W(1.5)
    half = pv("return p.curGeo.drawRange.count")
    check("halfway: about half the layer drawn", 0 < half < full, (half, full))
    check("the nozzle is shown", pv("return p.nozzle.visible"))
    gl = el("gcode-lines").text
    cur = d.execute_script("const c = document.querySelector('#gcode-lines .cur'); return c ? c.textContent : ''")
    check("the G-code being run is shown and highlighted", el("gcode-lines").is_displayed() and cur.startswith("G1") and len(gl.splitlines()) >= 4, (cur, gl.splitlines()[:3]))
    nozzle = pv("return [p.nozzle.position.x, p.nozzle.position.y]")
    xy = {k: float(v) for k, v in __import__("re").findall(r"([XY])(-?[\d.]+)", cur)}
    check("the nozzle is where the highlighted line goes", all(abs(xy[k] - nozzle["XY".index(k)]) < 0.2 for k in xy) and xy, (xy, nozzle))
    before = int(el("move").get_attribute("value"))
    d.find_element(By.TAG_NAME, "body").send_keys(Keys.ARROW_RIGHT); W(0.3)
    d.find_element(By.TAG_NAME, "body").send_keys(Keys.SHIFT + Keys.ARROW_LEFT); W(0.3)
    check("→ and Shift+← step through the moves", int(el("move").get_attribute("value")) == before + 1 - 10, (before, el("move").get_attribute("value")))
    el("move-up").click(); W(0.3)
    check("the › button steps too", int(el("move").get_attribute("value")) == before - 8, el("move").get_attribute("value"))
    el("show-travel").click(); W(0.5)
    n2 = int(el("move").get_attribute("max"))
    check("showing travel adds travel moves and shows the whole layer again", n2 > n and int(el("move").get_attribute("value")) == n2, (n, n2))
    d.save_screenshot(f"{OUT}/moves-travel.png")
    d.execute_script("const r = document.getElementById('move'); r.value = 3; r.dispatchEvent(new Event('input'))"); W(1)
    d.save_screenshot(f"{OUT}/moves-step.png")
    d.find_element(By.TAG_NAME, "body").send_keys(Keys.ARROW_UP); W(0.5)
    check("a new layer shows all of it", int(el("move").get_attribute("value")) == int(el("move").get_attribute("max")) and not pv("return p.nozzle.visible"))
    # per line type table
    check("time and filament per line type offered", el("feat-stats").is_displayed())
    d.execute_script("document.querySelector('#feat-stats summary').click()"); W(0.4)
    rows = [r.text for r in d.find_elements(By.CSS_SELECTOR, "#feat-stats tbody tr")]
    check("the table lists line types with time, % and grams, and a total", len(rows) >= 3 and "Outer wall" in " ".join(rows) and rows[-1].startswith("Total") and " g" in rows[-1], rows)
    d.save_screenshot(f"{OUT}/moves-stats.png")
    d.execute_script("document.querySelector('[data-view=\"model\"]').click()"); W(0.6)
    check("the Model view hides it all", not el("pv-moves").is_displayed() and not el("feat-stats").is_displayed() and not el("gcode-lines").is_displayed())
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
