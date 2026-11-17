"""The SVG tool in headless Chromium: a drawing as a new part (sized by width, holes kept), raised and engraved on a
part's face, editing its width, an outlines-only drawing refused with a reason, a drawing's script never run, and a slice.

    python ui_svg_test.py http://bicuslicer:8000/

Slices once; saves nothing.
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
items = lambda: [li.text.replace("\n", " | ") for li in d.find_elements(By.CSS_SELECTOR, "#objects li")]

LOGO = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <script>window.__pwned = 1</script>
  <rect x="0" y="0" width="80" height="100" fill="#123"/>
  <path fill="#e33" fill-rule="evenodd" d="M150 0 A50 50 0 1 1 149.99 0 Z M150 30 A20 20 0 1 0 150.01 30 Z"/>
</svg>"""
OUTLINE = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 12h18" fill="none" stroke="#000" stroke-width="2"/></svg>"""


def tap(x, y):
    for kind, b, bs in (("mouseMoved", "none", 0), ("mousePressed", "left", 1), ("mouseReleased", "left", 0)):
        d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": b, "buttons": bs, "clickCount": 1})
    W(2)


def svg_dialog(path, kind, width=None):
    d.execute_script("document.querySelector('[data-tool=svg]').click()"); W(0.8)
    d.execute_script("document.getElementById('svg-input').value = ''")      # as "Choose…" does
    el("svg-input").send_keys(path); W(1.5)
    if width:
        f = el("svg-width"); f.clear(); f.send_keys(str(width)); W(0.6)
    d.execute_script("const r = document.querySelector(`input[name=svg-kind][value=${arguments[0]}]`); r.checked = true; r.dispatchEvent(new Event('input', {bubbles: true}))", kind)
    W(0.6)


try:
    open("/tmp/logo.svg", "w").write(LOGO)
    open("/tmp/outline.svg", "w").write(OUTLINE)
    with open("/tmp/box.stl", "w") as f:
        v = [(x, y, z) for x in (0, 60) for y in (0, 40) for z in (0, 30)]
        tris = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
        f.write("solid b\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid b\n")
    d.get(URL); W(8)
    # 1. outlines only: refused with the reason
    svg_dialog("/tmp/outline.svg", "object")
    check("an outlines-only drawing is refused, saying why", "only has outlines" in el("svg-size").text and el("svg-ok").get_attribute("disabled") is not None, el("svg-size").text)
    d.execute_script("document.querySelector('#svg-dlg button[value=cancel]').click()"); W(0.5)
    # 2. a new part, 40 mm wide
    svg_dialog("/tmp/logo.svg", "object", 40)
    check("the dialog previews it and gives its size", el("svg-preview").find_elements(By.TAG_NAME, "img") and "40.0 × 20.0 mm" in el("svg-size").text, el("svg-size").text)
    el("svg-ok").click(); W(2)
    it = items()
    check("an SVG as a new part, 40 × 20 mm", any(x.startswith('SVG "logo"') and "40.0×20.0×1.5" in x for x in it), it)
    check("the drawing's script never ran", d.execute_script("return window.__pwned") is None)
    vol = d.execute_async_script("""const src = arguments[0], done = arguments[arguments.length - 1];
      Promise.all([import('/static/textgeo.js'), import('/static/meshops.js')]).then(async ([T, MO]) => {
        done(+MO.volume(await T.svgGeometry(src, { width: 40, depth: 1 })).toFixed(1));
      }).catch(e => done(String(e)));""", LOGO)
    # 16 x 20 rect + ring (r 10, hole 4) at 0.2 scale: 320 + pi*(100-16) = 583.9 mm^3 at 1 mm deep
    check("holes stay holes (the ring's volume is right)", isinstance(vol, float) and abs(vol - 583.9) < 6, vol)
    # 3. raised and engraved on a box
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/box.stl"); W(2)
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith("box"):
            li.click(); break
    W()
    d.execute_script("document.getElementById('view-reset').click()"); W()
    d.find_element(By.TAG_NAME, "body").send_keys("z"); W(1)
    r = d.execute_script("const b = document.querySelector('#viewer canvas').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]")
    fx, fy = int(r[0] + r[2] * 0.45), int(r[1] + r[3] * 0.62)
    svg_dialog("/tmp/logo.svg", "part", 30)
    el("svg-ok").click(); W(1)
    check("raised: asks where to put it", el("hint").is_displayed() and "Tap where the drawing goes" in el("hint").text, el("hint").text)
    tap(fx, fy)
    it = items()
    check("raised drawing on the box", any('SVG "logo"' in x and "raised part" in x for x in it), it)
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith("box"):
            li.click(); break
    W()
    svg_dialog("/tmp/logo.svg", "negative", 20)
    el("svg-ok").click(); W(1)
    tap(fx + 40, fy - 40)
    check("engraved drawing in the box", any('SVG "logo"' in x and "negative part" in x for x in items()), items())
    d.save_screenshot(f"{OUT}/svg-on-box.png")
    # 4. edit the raised one's width
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if 'SVG "logo"' in li.text and "raised" in li.text:
            li.click(); break
    W()
    check("a drawing has Edit SVG", el("vol-edit-text").is_displayed() and el("vol-edit-text").text == "Edit SVG…", el("vol-edit-text").text)
    el("vol-edit-text").click(); W(1)
    f = el("svg-width"); f.clear(); f.send_keys("50"); W(0.6)
    el("svg-ok").click(); W(2)
    sx = [float(el(i).get_attribute("value")) for i in ("v-sx", "v-sy")]
    check("editing rebuilds it at the new width", abs(max(sx) - 50) < 0.6, sx)
    # 5. slice
    d.execute_script("document.getElementById('slice').click()")
    for _ in range(240):
        W(1)
        if "layers" in el("result").text or "msg err" in el("result").get_attribute("innerHTML"):
            break
    check("the plate with drawings slices", "layers" in el("result").text, el("result").text[:80].replace("\n", " "))
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
