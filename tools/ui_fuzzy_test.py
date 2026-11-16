"""Fuzzy skin painting in headless Chromium: paint, the "fuzzy skin is disabled" warning and its fix, and slicing.

    python ui_fuzzy_test.py http://bicuslicer:8000/

Uses real mouse input for the brush (DevTools). Slices once; saves nothing.
"""
import json, os, sys, time
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
items = lambda: [li.text.replace("\n", " | ") for li in d.find_elements(By.CSS_SELECTOR, "#objects li")]
mouse = lambda kind, x, y, b="left", bs=1: d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": b, "buttons": bs, "clickCount": 1})
try:
    with open("/tmp/box.stl", "w") as f:
        v = [(x, y, z) for x in (0, 40) for y in (0, 40) for z in (0, 30)]
        # outward-facing box
        tris = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
        f.write("solid b\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid b\n")
    d.get(URL); time.sleep(8)
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/box.stl"); time.sleep(2)
    d.find_elements(By.CSS_SELECTOR, "#objects li")[0].click(); time.sleep(0.5)
    d.execute_script("document.querySelector('[data-tool=paint]').click()"); time.sleep(0.4)
    labels = [b.text for b in d.find_elements(By.CSS_SELECTOR, "#menu button")]
    check("Paint menu offers fuzzy skin", any("Fuzzy" in l for l in labels), labels)
    for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
        if "Fuzzy" in b.text:
            b.click(); break
    time.sleep(2)
    check("fuzzy skin paint panel: one paint tool and the eraser", el("paint-title").text == "Paint fuzzy skin" and not el("paint-t2").is_displayed(), el("paint-title").text)
    check("warns that fuzzy skin is disabled for the part", el("paint-fuzzy-warn").is_displayed(), el("paint-fuzzy-warn").text[:80])
    el("paint-fuzzy-on").click(); time.sleep(0.6)
    check("one tap turns on painted fuzzy skin (Painted only) for the part", not el("paint-fuzzy-warn").is_displayed() and any("⚙ 1" in x for x in items()), items())
    # paint a stroke across the middle of the view (the box fills it after the camera focus)
    r = d.execute_script("const b = document.querySelector('#viewer canvas').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]")
    # the box's front face: lower middle of the view, clear of the paint panel (top left)
    cx, cy = int(r[0] + r[2] * 0.42), int(r[1] + r[3] * 0.72)
    mouse("mouseMoved", cx, cy, "none", 0); mouse("mousePressed", cx, cy)
    for k in range(1, 25):
        mouse("mouseMoved", cx + k * 4, cy + (k % 3)); time.sleep(0.02)
    mouse("mouseReleased", cx + 96, cy, "left", 0); time.sleep(0.6)
    d.save_screenshot(f"{OUT}/fuzzy-paint.png")
    check("the stroke painted the part", d.execute_script("return document.getSelection().toString()") == "", "")
    el("paint-done").click(); time.sleep(0.6)
    check("the part shows as painted", any("🖌" in x for x in items()), items())
    el("slice").click()
    for _ in range(240):
        time.sleep(1)
        if "layers" in el("result").text or "msg err" in el("result").get_attribute("innerHTML"):
            break
    check("slices", "layers" in el("result").text, el("result").text[:80].replace("\n", " "))
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
