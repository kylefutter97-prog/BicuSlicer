"""The Cut tool in headless Chromium: plugs (automatic and tapped), a tilted plane, dowels, undo, and slicing.

    python ui_cut_test.py http://bicuslicer:8000/

Slices once; saves nothing.
"""
import json, os, re, sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
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
W = lambda t=0.6: time.sleep(t)
setv = lambda i, v: d.execute_script("const e = document.getElementById(arguments[0]); e.value = arguments[1]; e.dispatchEvent(new Event('input', {bubbles: true})); e.dispatchEvent(new Event('change', {bubbles: true}))", i, str(v))


def select(name):
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith(name):
            li.click(); W(); return True


def size(name):
    for x in items():
        if x.startswith(name + " "):
            m = re.search(r"([\d.]+)×([\d.]+)×([\d.]+)", x)
            return tuple(float(v) for v in m.groups()) if m else None


def tap(x, y):
    for kind, b, bs in (("mouseMoved", "none", 0), ("mousePressed", "left", 1), ("mouseReleased", "left", 0)):
        d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": b, "buttons": bs, "clickCount": 1})
    W(1)


try:
    with open("/tmp/box.stl", "w") as f:
        v = [(x, y, z) for x in (0, 40) for y in (0, 40) for z in (0, 30)]
        tris = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
        f.write("solid b\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid b\n")
    d.get(URL); W(8)
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/box.stl"); W(2)
    select("box")
    d.execute_script("document.querySelector('[data-tool=cut]').click()"); W(1)
    check("cut dialog opens with its plane", d.find_elements(By.CSS_SELECTOR, "#cut-dlg[open]"))
    setv("cut-conn", "plug"); W(1)
    check("plugs placed automatically", "2 placed automatically" in el("cut-points").text, el("cut-points").text)
    # tap the cut plane (the middle of the view: the plane crosses the box there)
    r = d.execute_script("const b = document.querySelector('#viewer canvas').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]")
    tap(int(r[0] + r[2] * 0.5), int(r[1] + r[3] * 0.5))
    check("tapping the plane places a connector", "1 placed by tapping" in el("cut-points").text, el("cut-points").text)
    el("cut-clear-points").click(); W()
    check("back to automatic", "placed automatically" in el("cut-points").text, el("cut-points").text)
    setv("cut-tx", 20); W(1)
    check("a tilted plane still finds room for the plugs", "placed automatically" in el("cut-points").text, el("cut-points").text)
    setv("cut-tx", 0); W(0.5)
    d.save_screenshot(f"{OUT}/cut-dialog.png")
    d.find_element(By.CSS_SELECTOR, "#cut-dlg button[value=ok]").click(); W(3)
    it = items()
    check("cut with plugs: plugs on the bottom, holes in the top", sum("Plug" in x for x in it) == 2 and sum("Connector hole" in x for x in it) == 2, it)
    b, t = size("box (bottom)"), size("box (top)")
    check("halves: 15 mm each, the top lying on its cut face", b and t and abs(b[2] - 15) < 0.1 and abs(t[2] - 15) < 0.1, (b, t))
    d.save_screenshot(f"{OUT}/cut-plugs.png")
    ActionChains(d).key_down(Keys.CONTROL).send_keys("z").key_up(Keys.CONTROL).perform(); W(1)
    check("undo brings the whole box back", [x.split(" | ")[0] for x in items()] == ["box"], items())
    # dowels, with a tilted cut
    select("box")
    d.execute_script("document.querySelector('[data-tool=cut]').click()"); W(1)
    setv("cut-conn", "dowel"); setv("cut-count", 3); setv("cut-tx", 15); W(1)
    d.find_element(By.CSS_SELECTOR, "#cut-dlg button[value=ok]").click(); W(3)
    it = items()
    check("tilted cut with dowels: holes in both halves, and 3 dowels", sum("Connector hole" in x for x in it) == 6 and any(x.startswith("box dowel") and "×3" in x for x in it), it)
    el("slice").click()
    for _ in range(240):
        W(1)
        if "layers" in el("result").text or "msg err" in el("result").get_attribute("innerHTML"):
            break
    check("the cut plate slices", "layers" in el("result").text, el("result").text[:80].replace("\n", " "))
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
