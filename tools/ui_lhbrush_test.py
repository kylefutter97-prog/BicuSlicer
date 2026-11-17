"""The layer height brush (By hand) in headless Chromium: holding Thicker / Thinner on the chart changes the layer count,
Even out goes back towards uniform, a turned part falls back to uniform layers, and the slicer prints the brushed layers.

    python ui_lhbrush_test.py http://bicuslicer:8000/

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
count = lambda: int(re.match(r"(\d+) layers", el("lh-info").text).group(1)) if re.match(r"(\d+) layers", el("lh-info").text) else None


def hold(fx, secs, tool):
    d.execute_script("document.querySelector(`[data-brush=${arguments[0]}]`).click()", tool); W(0.2)
    d.execute_script("document.getElementById('lh-chart').scrollIntoView({block: 'center'})"); W(0.3)
    r = d.execute_script("const b = document.getElementById('lh-chart').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]")
    x, y = int(r[0] + r[2] * fx), int(r[1] + r[3] / 2)
    d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none", "buttons": 0})
    d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1})
    time.sleep(secs)
    d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1})
    W(0.5)


try:
    with open("/tmp/box.stl", "w") as f:
        v = [(x, y, z) for x in (0, 20) for y in (0, 20) for z in (0, 30)]
        tris = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
        f.write("solid b\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid b\n")
    d.get(URL); W(8)
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/box.stl"); W(2)
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith("box"):
            li.click(); break
    W()
    d.execute_script("document.querySelector('[data-lh=manual]').click()"); W(0.6)
    check("By hand: brush tools and the chart", el("lh-manual").is_displayed() and el("lh-chart-wrap").is_displayed())
    n0 = count()
    hold(0.6, 1.5, "increase")
    n1 = count()
    check("holding Thicker: fewer layers", n0 and n1 and n1 < n0, (n0, n1))
    hold(0.25, 1.5, "decrease")
    n2 = count()
    check("holding Thinner lower down: more layers again", n2 and n2 > n1, (n1, n2))
    prof = d.execute_script("return document.getElementById('lh-info').textContent")
    check("layer heights now vary", re.search(r"· (\d\.\d\d)–(\d\.\d\d) mm", prof) and len(set(re.search(r"· (\d\.\d\d)–(\d\.\d\d) mm", prof).groups())) == 2, prof)
    d.save_screenshot(f"{OUT}/lh-brush.png")
    # slice: OrcaSlicer prints these layers
    check("the organic-supports clash is flagged with a fix", el("lh-warn").is_displayed())
    el("lh-fix").click(); W(0.6)
    d.execute_script("document.getElementById('slice').click()")
    for _ in range(240):
        W(1)
        if "layers" in el("result").text or "msg err" in el("result").get_attribute("innerHTML"):
            break
    m = re.search(r"(\d+)\s*\n?\s*layers", el("result").text)
    check("the slice has the brushed layer count", m and abs(int(m.group(1)) - n2) <= 1, (m and m.group(1), n2))
    # Even out brings them back towards the normal height
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith("box"):
            li.click(); break
    W()
    for fx in (0.25, 0.6):
        hold(fx, 2.5, "reduce")
    n3 = count()
    check("Even out: back to (about) the uniform count", n3 and abs(n3 - n0) <= abs(n2 - n0), (n0, n2, n3))
    # turning the part: the brushed heights no longer fit
    f = el("t-rx"); f.clear(); f.send_keys("90"); f.send_keys(Keys.ENTER); W(1)
    check("a turned part falls back to uniform layers, saying why", "uniform layers are used" in el("lh-info").text, el("lh-info").text)
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
