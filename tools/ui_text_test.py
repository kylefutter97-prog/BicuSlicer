"""The Text tool in headless Chromium: a text part, raised and engraved text on a part's face, editing, a font upload,
undo, and slicing (the slicer gets the text as a normal part and a negative part).

    python ui_text_test.py http://bicuslicer:8000/

Uploads one font (a copy of a bundled one) and deletes it again; slices once; saves nothing else.
"""
import json, os, sys, time
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


def text_dialog(text, kind, font=None):
    d.execute_script("document.querySelector('[data-tool=text]').click()"); W(1.2)
    ta = el("tx-text"); ta.clear(); ta.send_keys(text)
    if font:
        d.execute_script("const s = document.getElementById('tx-font'); s.value = arguments[0]; s.dispatchEvent(new Event('change'))", font)
    d.execute_script("const r = document.querySelector(`input[name=tx-kind][value=${arguments[0]}]`); r.checked = true; r.dispatchEvent(new Event('input', {bubbles: true}))", kind)
    W(1)
    prev = d.execute_script("const s = document.querySelector('#tx-preview svg path'); return s ? s.getAttribute('d').length : 0")
    el("tx-ok").click(); W(1.5)
    return prev


def tap(x, y):
    d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none", "buttons": 0})
    d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1})
    d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1})
    W(2)


try:
    with open("/tmp/box.stl", "w") as f:
        v = [(x, y, z) for x in (0, 60) for y in (0, 40) for z in (0, 30)]
        tris = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
        f.write("solid b\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid b\n")
    d.get(URL); W(8)
    # 1. a text part on its own (nothing selected)
    prev = text_dialog("Bicu 8", "object")
    it = items()
    check("text preview drawn in the dialog", prev > 100, prev)
    check("text as a new part", any(x.startswith('Text "Bicu 8"') for x in it), it)
    # letters with holes (B, 8, O) must come out solid with their holes cut: positive volume, well below a full block
    vol = d.execute_async_script("""const done = arguments[0];
      import('/static/textgeo.js').then(async (t) => {
        const f = await t.loadFont('/static/fonts/roboto-latin-700-normal.woff');
        const one = (txt) => { const g = t.textGeometry(f, { text: txt, size: 10, depth: 1 }); const p = g.getAttribute('position').array; let v = 0;
          for (let i = 0; i < p.length; i += 9) v += (p[i] * (p[i+4] * p[i+8] - p[i+5] * p[i+7]) - p[i+1] * (p[i+3] * p[i+8] - p[i+5] * p[i+6]) + p[i+2] * (p[i+3] * p[i+7] - p[i+4] * p[i+6])) / 6;
          g.computeBoundingBox(); const b = g.boundingBox; return [+v.toFixed(2), +((b.max.x - b.min.x) * (b.max.y - b.min.y)).toFixed(2)]; };
        done({ O: one('O'), B: one('B'), I: one('I') });
      }).catch((e) => done(String(e)));""")
    ok_holes = isinstance(vol, dict) and all(v[0] > 0 for v in vol.values()) and vol["O"][0] < 0.6 * vol["O"][1] and vol["B"][0] < 0.85 * vol["B"][1]
    check("letters with holes come out right (positive volume, holes cut)", ok_holes, vol)
    # 2. raised and engraved text on a box's face
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/box.stl"); W(2)
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith("box"):
            li.click(); break
    W()
    d.execute_script("document.getElementById('view-reset').click()"); W()
    d.find_element(By.TAG_NAME, "body").send_keys("z"); W(1)     # zoom to the selected box
    r = d.execute_script("const b = document.querySelector('#viewer canvas').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]")
    fx, fy = int(r[0] + r[2] * 0.45), int(r[1] + r[3] * 0.62)       # the box's front face, below the middle
    text_dialog("BICU", "part", "roboto-bold")
    check("raised: asks where to put it", el("hint").is_displayed() and "Tap where" in el("hint").text, el("hint").text)
    tap(fx, fy)
    it = items()
    check("raised text on the box", any('Text "BICU"' in x and "raised part" in x for x in it), it)
    d.save_screenshot(f"{OUT}/text-raised.png")
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith("box"):
            li.click(); break
    W()
    text_dialog("X", "negative")
    tap(fx + 40, fy - 30)
    it = items()
    check("engraved text in the box", any('Text "X"' in x and "negative part" in x for x in it), it)
    # 3. edit the raised text
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if 'Text "BICU"' in li.text:
            li.click(); break
    W()
    check("a text part has Edit text", el("vol-edit-text").is_displayed())
    el("vol-edit-text").click(); W(1)
    ta = el("tx-text"); ta.clear(); ta.send_keys("SLICER")
    el("tx-ok").click(); W(2)
    check("editing the text rebuilds it", any('Text "SLICER"' in x for x in items()), items())
    # 4. a font upload (a copy of a bundled one) and its removal
    up = d.execute_async_script("""
      const done = arguments[0];
      fetch('/static/fonts/lobster-latin-400-normal.woff').then(r => r.blob()).then(b => {
        const fd = new FormData(); fd.append('font', b, 'UI test font.woff');
        return fetch('/api/fonts', { method: 'POST', body: fd }).then(r => r.json());
      }).then(j => fetch('/api/fonts').then(r => r.json()).then(list => fetch(j.url).then(r => [j, list.length, r.status])))
        .then(([j, n, st]) => fetch('/api/fonts/' + j.url.split('/').pop(), { method: 'DELETE' }).then(() => done([j.label, n, st])))
        .catch(e => done(String(e)));""")
    bad = d.execute_async_script("""const done = arguments[0]; const fd = new FormData(); fd.append('font', new Blob(['not a font']), 'x.ttf');
      fetch('/api/fonts', { method: 'POST', body: fd }).then(r => done(r.status));""")
    check("a font can be added (and removed), a non-font is refused", isinstance(up, list) and up[2] == 200 and bad == 400, (up, bad))
    # 5. undo, and slicing
    ActionChains(d).key_down(Keys.CONTROL).send_keys("z").key_up(Keys.CONTROL).perform(); W(1)
    check("undo takes the edit back", any('Text "BICU"' in x for x in items()), items())
    d.execute_script("document.getElementById('slice').click()")
    for _ in range(240):
        W(1)
        if "layers" in el("result").text or "msg err" in el("result").get_attribute("innerHTML"):
            break
    check("the plate with text slices", "layers" in el("result").text, el("result").text[:80].replace("\n", " "))
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE" and "/api/fonts" not in e["message"]]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
