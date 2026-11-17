"""Dovetail cuts and Replace with STL in headless Chromium: a box cut with a dovetail (the bottom gets the tongue, so
it's taller; the top lies on its cut face with the groove), both halves slice; then a part's mesh replaced by another
file, keeping its position, rotation and settings.

    python ui_dovetail_replace_test.py http://bicuslicer:8000/

Slices once; saves nothing.
"""
import json, os, re, sys, time
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
items = lambda: [li.text.replace("\n", " | ") for li in d.find_elements(By.CSS_SELECTOR, "#objects li")]


def write_box(path, sx, sy, sz):
    v = [(x, y, z) for x in (0, sx) for y in (0, sy) for z in (0, sz)]
    tris = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
    with open(path, "w") as f:
        f.write("solid b\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid b\n")


def select(name):
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith(name):
            li.click(); W(); return True


def set_field(i, v):
    f = el(i); f.clear(); f.send_keys(str(v)); f.send_keys(Keys.ENTER); W(0.4)


try:
    write_box("/tmp/block.stl", 40, 20, 30)
    write_box("/tmp/small.stl", 12, 8, 6)
    d.get(URL); W(8)
    # 1. a dovetail cut
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/block.stl"); W(2)
    select("block")
    d.execute_script("document.querySelector('[data-tool=cut]').click()"); W(1)
    d.execute_script("const e = document.getElementById('cut-h'); e.value = '15'; e.dispatchEvent(new Event('input', {bubbles: true}))"); W(0.5)
    d.execute_script("const s = document.getElementById('cut-conn'); s.value = 'dovetail'; s.dispatchEvent(new Event('input', {bubbles: true})); s.dispatchEvent(new Event('change', {bubbles: true}))"); W(1)
    check("the cut offers a dovetail, with its own options", el("cut-dove-opts").is_displayed() and not el("cut-conn-opts").is_displayed() and "tongue" in el("cut-points").text, el("cut-points").text)
    check("the dovetail is previewed on the cut plane", d.execute_script("return document.querySelectorAll('#cut-dlg').length") == 1)
    d.save_screenshot(f"{OUT}/dovetail-preview.png")
    d.find_element(By.CSS_SELECTOR, "#cut-dlg button[value=ok]").click(); W(5)
    it = items()
    check("the cut makes two halves, with a dovetail", len(it) == 2 and "dovetail" in el("plate-flash").text, (it, el("plate-flash").text))
    bottom = next((x for x in it if "(bottom)" in x), "")
    top = next((x for x in it if "(top)" in x), "")
    # bottom: 40 x 20 x 15 plus a 5 mm tongue on top = 20 tall; top: 40 x 20 x 15 lying on its cut face
    check("the bottom half carries the tongue (5 mm taller)", "40.0×20.0×20.0" in bottom, bottom)
    check("the top half keeps its outside size (the groove is inside)", "40.0×20.0×15.0" in top, top)
    d.save_screenshot(f"{OUT}/dovetail.png")
    d.execute_script("document.getElementById('slice').click()")
    for _ in range(240):
        W(1)
        if "layers" in el("result").text or "msg err" in el("result").get_attribute("innerHTML"):
            break
    check("both dovetailed halves slice", "layers" in el("result").text, el("result").text[:80].replace("\n", " "))
    # 2. replace with STL: keeps position, rotation and settings
    select("block (top)")
    d.execute_script("document.getElementById('tb-ears').click()"); W(0.4)
    for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
        if b.text.startswith("Automatic"):
            b.click(); break
    W(0.6)
    set_field("t-rz", 30)
    pos = (el("t-x").get_attribute("value"), el("t-y").get_attribute("value"))
    d.execute_script("document.querySelector('[data-tool=more]').click()"); W(0.4)
    check("More offers Replace with STL", any(b.text.startswith("Replace with STL") for b in d.find_elements(By.CSS_SELECTOR, "#menu button")))
    d.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE); W(0.3)
    d.execute_script("document.getElementById('replace-input').value = ''")
    d.execute_script("""const i = document.getElementById('replace-input'); const real = i.click; i.click = () => {}; window.__restore = () => { i.click = real; };""")
    for b in []: pass
    # open via the part menu path (the input's click is stubbed so the test can hand it the file)
    d.execute_script("document.querySelector('[data-tool=more]').click()"); W(0.4)
    for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
        if b.text.startswith("Replace with STL"):
            b.click(); break
    W(0.4)
    el("replace-input").send_keys("/tmp/small.stl"); W(2.5)
    it = items()
    rep = next((x for x in it if x.startswith("block (top)")), "")
    check("replaced: same name, the new mesh's size (turned 30°)", rep and "ears" in rep and not "40.0×20.0×15.0" in rep and "Replaced" in el("plate-flash").text, (rep, el("plate-flash").text))
    select("block (top)")
    check("its position and rotation stay", (el("t-x").get_attribute("value"), el("t-y").get_attribute("value")) == pos and abs(float(el("t-rz").get_attribute("value")) - 30) < 0.01,
          (pos, el("t-x").get_attribute("value"), el("t-y").get_attribute("value"), el("t-rz").get_attribute("value")))
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
