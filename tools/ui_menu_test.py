"""Plate toolbar on an empty plate, and the right-click menu vs. right-drag panning, in headless Chromium.

    python ui_menu_test.py http://bicuslicer:8000/

Real mouse input goes through Chrome's input pipeline (DevTools Input.dispatchMouseEvent). Saves nothing, slices nothing.
"""
import json, os, sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service

URL = sys.argv[1]
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f": {detail}" if detail != "" else ""), flush=True)


o = webdriver.ChromeOptions()
for a in ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1400,1000",
          "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]:
    o.add_argument(a)
o.binary_location = os.environ.get("CHROME_BIN", "/usr/bin/chromium")
o.set_capability("goog:loggingPrefs", {"browser": "ALL"})
d = webdriver.Chrome(service=Service(os.environ.get("CHROMEDRIVER", "/app/chromedriver")), options=o)
W = lambda t=0.5: time.sleep(t)
el = lambda i: d.find_element(By.ID, i)
menu_open = lambda: el("menu").is_displayed()


def mouse(kind, x, y, button="right", buttons=2):
    d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": button, "buttons": buttons, "clickCount": 1})


try:
    d.get(URL); W(8)
    tb = el("plate-toolbar")
    calib = d.find_element(By.CSS_SELECTOR, '[data-tool="calib"]')
    arrange = d.find_element(By.CSS_SELECTOR, '[data-tool="arrange"]')
    check("empty plate: toolbar shown, Calibrate usable, Arrange greyed out", tb.is_displayed() and calib.is_enabled() and not arrange.is_enabled())
    el("empty-calib").click(); W()
    items = [b.text for b in d.find_elements(By.CSS_SELECTOR, "#menu button")]
    check("empty plate offers the calibration tests", menu_open() and any("Temperature" in t for t in items), items[:3])
    d.find_element(By.TAG_NAME, "body").send_keys("\ue00c"); W()     # Escape

    # a cube in the middle of the plate
    with open("/tmp/c.stl", "w") as f:
        v = [(x, y, z) for x in (0, 30) for y in (0, 30) for z in (0, 30)]
        tris = [(0, 2, 1), (1, 2, 3), (4, 5, 6), (5, 7, 6), (0, 1, 4), (1, 5, 4), (2, 6, 3), (3, 6, 7), (0, 4, 2), (2, 4, 6), (1, 3, 5), (3, 7, 5)]
        f.write("solid c\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid c\n")
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/c.stl"); W(2)
    r = d.execute_script("const b = document.querySelector('#viewer canvas').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]")
    cx, cy = int(r[0] + r[2] / 2), int(r[1] + r[3] / 2)
    check("with a part: Arrange usable", d.find_element(By.CSS_SELECTOR, '[data-tool="arrange"]').is_enabled())

    # right-click in place -> menu
    mouse("mouseMoved", cx, cy, "none", 0); mouse("mousePressed", cx, cy); W(0.1); mouse("mouseReleased", cx, cy, "right", 0); W()
    items = [b.text for b in d.find_elements(By.CSS_SELECTOR, "#menu button")]
    check("right-click opens the menu", menu_open(), items[:4])
    # Windows order: the browser's menu event arrives after release, aimed at whatever is under the pointer (our menu)
    blocked = d.execute_script("""const out = [];
      for (const t of [document.getElementById('menu'), document.querySelector('#viewer canvas'), document.getElementById('viewer')]) {
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10 });
        t.dispatchEvent(ev); out.push(ev.defaultPrevented);
      } return out;""")
    check("the browser's own menu is kept away (menu, view, viewer)", all(blocked), blocked)
    check("...and ours stays open", menu_open())
    d.find_element(By.TAG_NAME, "body").send_keys("\ue00c"); W()
    check("Escape closes it", not menu_open())

    # right-drag (pan) on empty bed -> no menu, view moves
    sx, sy = int(r[0] + r[2] * 0.2), int(r[1] + r[3] * 0.8)
    canvas = d.find_element(By.CSS_SELECTOR, "#viewer canvas")
    before = canvas.screenshot_as_png
    mouse("mouseMoved", sx, sy, "none", 0); mouse("mousePressed", sx, sy)
    for k in range(1, 16):
        mouse("mouseMoved", sx + k * 10, sy - k * 4); W(0.03)
    mouse("mouseReleased", sx + 150, sy - 60, "right", 0); W(1)
    after = canvas.screenshot_as_png
    check("right-drag pans without opening the menu", not menu_open() and before != after, f"menu {menu_open()}, view changed {before != after}")

    # right-drag that starts on the part: also just a pan
    mouse("mouseMoved", cx, cy, "none", 0); mouse("mousePressed", cx, cy)
    for k in range(1, 12):
        mouse("mouseMoved", cx - k * 8, cy + k * 3); W(0.03)
    mouse("mouseReleased", cx - 88, cy + 33, "right", 0); W(1)
    check("right-drag starting on a part doesn't open the menu", not menu_open())

    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:400])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
