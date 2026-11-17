"""Support enforcer / blocker parts and hand-placed brim ears in headless Chromium, checked by slicing an L-shaped part
(its arm overhangs): a blocker under the arm stops its supports, an enforcer with "only where enforced" brings them back
and nothing else, and ears placed by tapping the bed print as brim.

    python ui_supports_ears_test.py http://bicuslicer:8000/

Slices several times; saves nothing.
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
items = lambda: [li.text.replace("\n", " | ") for li in d.find_elements(By.CSS_SELECTOR, "#objects li")]


def write_l(path):
    # an L profile in XZ (column 10 wide, arm out to x = 30 at z 15..20), 10 deep in Y
    prof = [(0, 0), (10, 0), (10, 15), (30, 15), (30, 20), (0, 20)]
    fan = [(5, 0, 1), (5, 1, 2), (5, 2, 3), (5, 3, 4)]
    tris = []
    for a, b, c in fan:
        tris.append([(prof[a][0], 0, prof[a][1]), (prof[c][0], 0, prof[c][1]), (prof[b][0], 0, prof[b][1])])     # front (y = 0), facing -y
        tris.append([(prof[a][0], 10, prof[a][1]), (prof[b][0], 10, prof[b][1]), (prof[c][0], 10, prof[c][1])])  # back
    for i in range(len(prof)):
        p, q = prof[i], prof[(i + 1) % len(prof)]
        tris.append([(p[0], 0, p[1]), (q[0], 0, q[1]), (q[0], 10, q[1])])
        tris.append([(p[0], 0, p[1]), (q[0], 10, q[1]), (p[0], 10, p[1])])
    with open(path, "w") as f:
        f.write("solid l\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {x} {y} {z}\n" for x, y, z in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid l\n")


def select(name):
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith(name):
            li.click(); W(); return True


def menu(text):
    for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
        if b.text.startswith(text):
            b.click(); W(0.6); return True
    return False


def set_field(i, v):
    f = el(i); f.clear(); f.send_keys(str(v)); f.send_keys(Keys.ENTER); W(0.4)


def slice_stats():
    """Slice; return {line type: grams} from the Layers view's table."""
    d.execute_script("document.getElementById('slice').click()")
    for _ in range(240):
        W(1)
        if "layers" in el("result").text or "msg err" in el("result").get_attribute("innerHTML"):
            break
    if "layers" not in el("result").text:
        return {"error": el("result").text[:200]}
    d.execute_script("document.querySelector('[data-view=\"preview\"]').click()"); W(4)
    rows = d.execute_script("return [...document.querySelectorAll('#feat-stats tbody tr')].map(r => [...r.cells].map(c => c.textContent))")
    d.execute_script("document.querySelector('[data-view=\"model\"]').click()"); W(0.6)
    return {r[0]: float(r[3].replace(" g", "")) for r in rows if r[0] != "Total"}


def is_on(feature, st):
    return any(feature in k for k in st) and sum(v for k, v in st.items() if feature in k) > 0.005


try:
    write_l("/tmp/ell.stl")
    d.get(URL); W(8)
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/ell.stl"); W(2)
    select("ell")
    st0 = slice_stats()
    check("the L part gets supports under its arm", is_on("Support", st0), st0)
    # 1. a blocker under the arm
    select("ell")
    d.execute_script("document.querySelector('[data-tool=volume]').click()"); W(0.4)
    check("Modifier menu offers support blockers and enforcers", menu("Support blocker: box"), [b.text for b in d.find_elements(By.CSS_SELECTOR, "#menu button")])
    check("a support blocker is added", any("support blocker" in x for x in items()), items())
    for k, v in (("v-sx", 24), ("v-sy", 14), ("v-sz", 16), ("v-px", 5), ("v-py", 0), ("v-pz", 7.5)):
        set_field(k, v)
    d.save_screenshot(f"{OUT}/blocker.png")
    st1 = slice_stats()
    check("with the blocker: no supports", "error" not in st1 and not is_on("Support", st1), st1)
    # 2. swap it for an enforcer, supports only where enforced
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if "support blocker" in li.text:
            li.click(); break
    W()
    el("vol-remove").click(); W(0.8)
    select("ell")
    d.execute_script("document.querySelector('[data-tool=volume]').click()"); W(0.4)
    menu("Support enforcer: box"); W(0.6)
    for k, v in (("v-sx", 24), ("v-sy", 14), ("v-sz", 16), ("v-px", 5), ("v-py", 0), ("v-pz", 7.5)):
        set_field(k, v)
    check("the enforcer offers supports only where enforced", el("vol-support-on").is_displayed() and "only where enforced" in el("vol-support-btn").text, el("vol-support-on").text)
    el("vol-support-btn").click(); W(0.8)
    st2 = slice_stats()
    check("manual supports with the enforcer: supports under the arm", is_on("Support", st2), st2)
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if "support enforcer" in li.text:
            li.click(); break
    W()
    el("vol-remove").click(); W(0.8)
    st3 = slice_stats()
    check("manual supports without an enforcer: none", "error" not in st3 and not is_on("Support", st3), st3)
    # 3. brim ears by hand
    select("ell")
    d.execute_script("document.getElementById('view-reset').click()"); W()
    d.find_element(By.TAG_NAME, "body").send_keys("z"); W(1)
    d.execute_script("document.getElementById('tb-ears').click()"); W(0.4)
    check("Brim ears offers automatic or by hand", menu("Place them by hand"), "")
    check("by hand: a panel and a hint", el("ears-panel").is_displayed() and "Tap by the part's edge" in el("hint").text, el("hint").text)
    r = d.execute_script("const b = document.querySelector('#viewer canvas').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]")
    cx, cy = int(r[0] + r[2] / 2), int(r[1] + r[3] / 2)

    def tap(x, y):
        for kind, b, bs in (("mouseMoved", "none", 0), ("mousePressed", "left", 1), ("mouseReleased", "left", 0)):
            d.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": b, "buttons": bs, "clickCount": 1})
        W(0.6)
    A, B = (int(r[0] + r[2] * 0.3), int(r[1] + r[3] * 0.55)), (int(r[0] + r[2] * 0.5), int(r[1] + r[3] * 0.55))    # on the part's foot: snapped to its edge
    tap(*A)
    tap(*B)
    check("two taps: two ears", el("ears-count").text == "2 ears", el("ears-count").text)
    tap(*B)
    check("tapping an ear removes it", el("ears-count").text == "1 ear", el("ears-count").text)
    tap(*B)
    d.save_screenshot(f"{OUT}/ears.png")
    el("ears-done").click(); W(0.5)
    check("Done closes it; the part is marked", not el("ears-panel").is_displayed() and "on" in el("tb-ears").get_attribute("class"))
    st4 = slice_stats()
    check("the hand-placed ears print as brim", any("Brim" in k for k in st4) and sum(v for k, v in st4.items() if "Brim" in k) > 0.001, st4)
    # undo keeps ears in its history
    d.find_element(By.TAG_NAME, "body").send_keys(Keys.CONTROL, "z"); W(1)
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
