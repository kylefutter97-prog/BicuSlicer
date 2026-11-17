"""The Measure tool in headless Chromium: faces, corners and circles picked by tapping, distance / angle / gap between
two picks, and the geometry behind it (a plate with a hole).

    python ui_measure_test.py http://bicuslicer:8000/

Saves nothing.
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
panel = lambda: el("measure-panel").text.replace("\n", " | ")


def tap(x, y):
    for kind, b, bs in (("mouseMoved", "none", 0), ("mousePressed", "left", 1), ("mouseReleased", "left", 0)):
        d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": b, "buttons": bs, "clickCount": 1})
    W(0.5)


def toggle():
    d.execute_script("document.getElementById('tb-measure').click()"); W(0.3)


try:
    with open("/tmp/box.stl", "w") as f:
        v = [(x, y, z) for x in (0, 40) for y in (0, 30) for z in (0, 10)]
        tris = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
        f.write("solid b\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid b\n")
    d.get(URL); W(8)
    # 1. the geometry: a 30 x 30 x 5 plate with a 6 mm hole
    geo = d.execute_async_script("""const done = arguments[0];
      Promise.all([import('three'), import('/static/measure.js')]).then(([THREE, MS]) => {
        const s = new THREE.Shape(); s.moveTo(-15, -15); s.lineTo(15, -15); s.lineTo(15, 15); s.lineTo(-15, 15); s.lineTo(-15, -15);
        const h = new THREE.Path(); h.absarc(5, 0, 3, 0, Math.PI * 2, true); s.holes.push(h);
        const g = new THREE.ExtrudeGeometry(s, { depth: 5, bevelEnabled: false, curveSegments: 48 });
        const mesh = new THREE.Mesh(g); mesh.updateMatrixWorld();
        // a triangle of the top face (z = 5, normal up)
        const p = g.getAttribute('position'), idx = g.getIndex(); let top = -1;
        const n = (idx ? idx.count : p.count) / 3;
        for (let t = 0; t < n && top < 0; t++) { let ok = true; for (let j = 0; j < 3; j++) if (Math.abs(p.getZ(idx ? idx.getX(t*3+j) : t*3+j) - 5) > 1e-6) ok = false; if (ok) top = t; }
        const r = MS.faceRegion(mesh, top);
        const circles = r.loops.filter(l => l.circle).map(l => +(l.circle.radius * 2).toFixed(2));
        // the bottom face, and the gap / angle between the two
        let bot = -1; for (let t = 0; t < n && bot < 0; t++) { let ok = true; for (let j = 0; j < 3; j++) if (Math.abs(p.getZ(idx ? idx.getX(t*3+j) : t*3+j)) > 1e-6) ok = false; if (ok) bot = t; }
        const rb = MS.faceRegion(mesh, bot);
        const fa = { kind: 'face', point: new THREE.Vector3(0, 10, 5), region: r }, fb = { kind: 'face', point: new THREE.Vector3(-10, -10, 0), region: rb };
        const between = MS.measureBetween(fa, fb).map(x => x.label + ': ' + x.value);
        // a tap on the hole's rim picks the circle (screen = world x, y for this check)
        const hit = { point: new THREE.Vector3(5 + 3.05, 0, 5), faceIndex: top };
        const pk = MS.pickFeature(mesh, hit, (v) => ({ x: v.x * 10, y: v.y * 10 }), 4);
        done({ area: +r.area.toFixed(1), loops: r.loops.length, circles, between, pick: pk.kind, dia: pk.circle ? +(pk.circle.radius * 2).toFixed(2) : null });
      }).catch(e => done(String(e)));""")
    check("a face with a hole: its area and loops", isinstance(geo, dict) and abs(geo["area"] - (900 - 3.14159 * 9)) < 1 and geo["loops"] == 2, geo)
    check("the hole is found as a 6 mm circle", isinstance(geo, dict) and any(abs(c - 6) < 0.05 for c in geo["circles"]), geo)
    check("two parallel faces: angle 0 and a 5 mm gap", isinstance(geo, dict) and any("Angle between faces: 0.0°" in b for b in geo["between"]) and any("Gap between the faces: 5.00 mm" in b for b in geo["between"]), geo)
    check("a tap by the hole's rim picks the circle", isinstance(geo, dict) and geo["pick"] == "circle" and abs(geo["dia"] - 6) < 0.05, geo)
    # 2. tapping a box in the page
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/box.stl"); W(2)
    d.execute_script("document.getElementById('view-reset').click()"); W()
    d.find_element(By.TAG_NAME, "body").send_keys("z"); W(1)
    d.find_element(By.TAG_NAME, "body").send_keys("m"); W(0.4)
    check("M turns Measure on, with a hint", "on" in el("tb-measure").get_attribute("class") and el("hint").is_displayed() and "Tap a corner" in el("hint").text, el("hint").text)
    r = d.execute_script("const b = document.querySelector('#viewer canvas').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]")
    cx = int(r[0] + r[2] / 2)
    found = {}
    for k in range(0, 40):         # walk up the middle of the view: the front face, then the top
        y = int(r[1] + r[3] * 0.85 - k * r[3] * 0.018)
        tap(cx, y)
        t = panel()
        m = re.search(r"Face \| ([\d.]+) mm²", t)
        if m:
            a = float(m.group(1))
            if abs(a - 400) < 1 and "front" not in found: found["front"] = y
            if abs(a - 1200) < 1 and "top" not in found: found["top"] = y
        toggle(); toggle()       # start over
        if len(found) == 2:
            break
    check("tapping finds the box's front (400 mm²) and top (1200 mm²) faces", len(found) == 2, (found, panel()))
    if len(found) == 2:
        tap(cx, found["front"]); tap(cx, found["top"])
        t = panel()
        check("front then top: 90° between them", "Angle between faces | 90.0°" in t, t)
        d.save_screenshot(f"{OUT}/measure-faces.png")
        tap(cx, found["top"])
        check("a third tap starts over", "Face | 1200.0 mm²" in panel() and "Angle" not in panel(), panel())
    # dragging on a part while measuring doesn't move it
    pos = d.execute_script("return [...document.querySelectorAll('#objects li')].map(l => l.textContent)")
    if found.get("top"):
        y = found["top"]
        d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": cx, "y": y, "button": "left", "buttons": 1, "clickCount": 1})
        for k in range(1, 8):
            d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": cx + k * 10, "y": y, "button": "left", "buttons": 1})
        d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": cx + 70, "y": y, "button": "left", "buttons": 0, "clickCount": 1})
        W(0.5)
        check("dragging while measuring turns the view, doesn't move the part", d.execute_script("return [...document.querySelectorAll('#objects li')].map(l => l.textContent)") == pos)
    d.find_element(By.TAG_NAME, "body").send_keys(""); W(0.4)      # Escape
    check("Esc ends Measure and clears it", "on" not in el("tb-measure").get_attribute("class") and not el("measure-panel").is_displayed() and not el("hint").is_displayed())
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
