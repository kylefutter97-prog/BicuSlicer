"""Purge volumes (OrcaSlicer's flushing volumes) and purging into parts, in headless Chromium: a two-colour plate sliced
with the automatic table, with a large table set by hand, and with the parts taking the purge in their infill; checked
in the G-code (the table used, the prime tower's filament).

    python ui_flush_test.py http://bicuslicer:8000/

Uses this (throwaway) browser's own settings; slices three times; saves nothing.
"""
import json, os, re, sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By
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


def write_box(path, sx, sy, sz):
    v = [(x, y, z) for x in (0, sx) for y in (0, sy) for z in (0, sz)]
    tris = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
    with open(path, "w") as f:
        f.write("solid b\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid b\n")


def select(name):
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith(name):
            li.click(); W(); return True


def slice_gcode():
    d.execute_script("document.getElementById('slice').click()")
    for _ in range(300):
        W(1)
        if "layers" in el("result").text or "msg err" in el("result").get_attribute("innerHTML"):
            break
    if "layers" not in el("result").text:
        return None
    href = d.execute_script("const a = [...document.querySelectorAll('#result a.btn')].find(a => /\\/gcode$/.test(a.getAttribute('href'))); return a && a.getAttribute('href')")
    return d.execute_async_script("const done = arguments[arguments.length - 1]; fetch(arguments[0]).then(r => r.text()).then(done).catch(e => done(''))", href)


def tower_g(g):
    """Grams in the prime tower, from the per-line-type lengths OrcaSlicer reports, else by summing its extrusion."""
    e, typ = 0.0, ""
    for line in g.splitlines():
        if line.startswith(";TYPE:"):
            typ = line[6:]
        elif typ == "Prime tower" and line.startswith("G1") and " E" in line:
            m = re.search(r" E(-?[\d.]+)", line)
            if m and float(m.group(1)) > 0:
                e += float(m.group(1))
    return round(e, 1)          # filament mm (relative E)


matrix = lambda g: (re.search(r"^; flush_volumes_matrix = (.*)$", g, re.M) or [None, ""])[1]

try:
    write_box("/tmp/a.stl", 20, 20, 8)
    write_box("/tmp/b.stl", 20, 20, 8)
    d.get(URL); W(8)
    d.execute_script("document.getElementById('fil-add').click()"); W(1)
    d.execute_script("const c = document.querySelector('#fil-slots input[data-colour=\"1\"]'); c.value = '#1b1b1b'; c.dispatchEvent(new Event('change', {bubbles: true}))"); W()
    check("two filaments: Purge volumes is offered", el("fil-flush").is_displayed())
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/a.stl"); W(2)
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/b.stl"); W(2)
    select("b")
    d.execute_script("const s = document.getElementById('obj-filament'); s.value = '2'; s.dispatchEvent(new Event('change'))"); W(1)
    check("the part panel offers purging into the part", el("obj-flush").is_displayed())
    g0 = slice_gcode()
    check("automatic: slices, OrcaSlicer's own table", g0 and matrix(g0), matrix(g0) if g0 else "")
    t0 = tower_g(g0) if g0 else 0
    # the dialog shows the last slice's table
    el("fil-flush").click(); W(0.8)
    cells = [i.get_attribute("value") for i in d.find_elements(By.CSS_SELECTOR, "#fl-grid input")]
    auto_vals = ",".join(str(int(float(x))) for x in matrix(g0).split(",")) if g0 else ""
    check("the dialog shows the values the last slice used", ",".join(cells) == auto_vals and "last slice" in el("fl-note").text, (cells, auto_vals))
    check("it says when the printer doesn't purge in the prime tower (the Bicubot's setting)", el("fl-purge-off").is_displayed(), "")
    el("fl-purge-on").click(); W(0.5)
    d.execute_script("const r = document.querySelector('input[name=fl-mode][value=manual]'); r.checked = true; r.dispatchEvent(new Event('change'))"); W(0.3)
    for i in d.find_elements(By.CSS_SELECTOR, "#fl-grid input"):
        if i.is_enabled():
            i.clear(); i.send_keys("900")
    m = el("fl-mult"); m.clear(); m.send_keys("1")
    d.save_screenshot(f"{OUT}/flush-dialog.png")
    d.find_element(By.CSS_SELECTOR, "#flush-dlg button[value=ok]").click(); W(1)
    g1 = slice_gcode()
    check("by hand: the slice uses the table", g1 and matrix(g1).replace(" ", "") == "0,900,900,0", matrix(g1) if g1 else "")
    t1 = tower_g(g1) if g1 else 0
    check("a bigger purge (and purging in the tower): more filament into the prime tower", t1 > t0 * 1.5, (t0, t1))
    # purge into the parts' infill
    for name in ("a", "b"):
        select(name)
        d.execute_script("const c = document.querySelector('#obj-flush [data-flush=flush_into_infill]'); c.checked = true; c.dispatchEvent(new Event('change', {bubbles: true}))"); W(0.4)
    g2 = slice_gcode()
    t2 = tower_g(g2) if g2 else 0
    check("purging into the parts' infill: less into the tower", g2 and t2 < t1, (t1, t2))
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
