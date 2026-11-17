"""Simplify and Boolean in headless Chromium: the geometry (volumes after union / difference / intersection, triangle
counts after simplifying, a clear error for an open mesh), then the toolbar flows and a slice of the result.

    python ui_meshtools_test.py http://bicuslicer:8000/

Slices once; saves nothing.
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
W = lambda t=0.6: time.sleep(t)
items = lambda: [li.text.replace("\n", " | ") for li in d.find_elements(By.CSS_SELECTOR, "#objects li")]


def menu(text):
    for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
        if b.text.startswith(text):
            b.click(); W(0.4); return True
    return False


def select(name, shift=False):
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith(name):
            if shift:
                ActionChains(d).key_down(Keys.SHIFT).click(li).key_up(Keys.SHIFT).perform()
            else:
                li.click()
            W(); return True


def set_field(i, v):
    f = el(i); f.clear(); f.send_keys(str(v)); f.send_keys(Keys.ENTER); W(0.5)


try:
    d.get(URL); W(8)
    # 1. geometry
    geo = d.execute_async_script("""const done = arguments[0];
      Promise.all([import('three'), import('/static/meshops.js'), import('/static/meshtools.js')]).then(async ([THREE, MO, MT]) => {
        const at = (g, x, y, z) => MO.bake(g, new THREE.Matrix4().makeTranslation(x, y, z));
        const box = at(MO.box(20, 20, 20), 0, 0, 10), cyl = at(MO.cylinder(8, 30), 0, 0, 10), box2 = at(MO.box(20, 20, 20), 10, 0, 10);
        const v = (g) => +MO.volume(g).toFixed(0);
        const diff = await MT.boolean('subtract', [box, cyl]), uni = await MT.boolean('union', [box, box2]), inter = await MT.boolean('intersect', [box, box2]);
        const sph = MO.sphere(20, 64), n0 = MT.triangleCount(sph);
        const s1 = await MT.simplify(sph, 0.25, 0.5), s2 = await MT.simplify(sph, 0.05, 0.01);
        let openErr = '';
        const tri = new THREE.BufferGeometry(); tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0,0,0, 10,0,0, 0,10,0]), 3));
        try { await MT.boolean('union', [tri, box]); } catch (e) { openErr = e.message; }
        done({ box: v(box), diff: v(diff), uni: v(uni), inter: v(inter), n0, s1: [s1.triangles, +s1.error.toFixed(3), v(s1.geo)], sph: v(sph), s2: [s2.triangles, +s2.error.toFixed(4)], openErr });
      }).catch(e => done(String(e)));""")
    ok = isinstance(geo, dict)
    check("difference: a box less an 8 mm hole", ok and abs(geo["diff"] - (8000 - 3.14159 * 16 * 20)) < 30, geo)
    check("union and intersection of two overlapping boxes", ok and abs(geo["uni"] - 12000) < 2 and abs(geo["inter"] - 4000) < 2, geo)
    check("simplify to 25 %: about a quarter of the triangles, nearly the same volume", ok and geo["s1"][0] <= geo["n0"] * 0.27 and abs(geo["s1"][2] - geo["sph"]) / geo["sph"] < 0.02, geo)
    check("a tight error limit stops it early", ok and geo["s2"][0] > geo["n0"] * 0.05 and geo["s2"][1] <= 0.0101, geo)
    check("an open mesh gets a clear message", ok and "isn't a closed solid" in geo["openErr"], geo.get("openErr") if ok else geo)
    # 2. difference in the page: a box with a cylinder moved into it
    d.execute_script("document.querySelector('[data-tool=shape]').click()"); W(0.4); menu("Box"); W(1)
    d.execute_script("document.querySelector('[data-tool=shape]').click()"); W(0.4); menu("Cylinder"); W(1)
    select("Cylinder")
    set_field("t-sx", 8)          # keep proportions: 8 x 8 x 8
    bx = d.execute_script("return document.getElementById('t-x').value")
    select("Box"); bxx, byy = el("t-x").get_attribute("value"), el("t-y").get_attribute("value")
    select("Cylinder"); set_field("t-x", bxx); set_field("t-y", byy)
    select("Box"); select("Cylinder", shift=True)
    check("Boolean is on the toolbar for a selection", not el("tb-boolean").get_attribute("disabled"))
    d.execute_script("document.getElementById('tb-boolean').click()"); W(0.4)
    check("it offers union, difference and intersection", menu("Cut the others out of Box"), [b.text for b in d.find_elements(By.CSS_SELECTOR, "#menu button")])
    W(3)
    it = items()
    check("difference makes one part, the cylinder cut out of the box", len(it) == 1 and it[0].startswith("Box (cut)"), (it, el("plate-flash").text))
    d.save_screenshot(f"{OUT}/boolean-diff.png")
    # 3. a negative part applied for good
    select("Box (cut)")
    d.execute_script("document.querySelector('[data-tool=volume]').click()"); W(0.4)
    menu("Negative part"); W(1)
    if not any("negative" in x for x in items()):
        for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
            if "egative" in b.text:
                b.click(); break
        W(1)
    select("Box (cut)")
    d.execute_script("document.getElementById('tb-boolean').click()"); W(0.4)
    check("a part with a negative part can apply it", menu("Apply its negative parts"), [b.text for b in d.find_elements(By.CSS_SELECTOR, "#menu button")])
    W(3)
    check("applied: the negative part is gone, its cut stays", not any("negative" in x for x in items()) and "Cut 1 negative part" in el("plate-flash").text, (items(), el("plate-flash").text))
    # 4. simplify a sphere
    d.execute_script("document.querySelector('[data-tool=shape]').click()"); W(0.4); menu("Sphere"); W(1)
    select("Sphere")
    d.execute_script("document.querySelector('[data-tool=simplify]').click()"); W(2)
    check("Simplify opens with a live count", el("simplify-dlg").is_displayed() and "→" in el("simp-out").text, el("simp-out").text)
    d.execute_script("const r = document.getElementById('simp-keep'); r.value = 20; r.dispatchEvent(new Event('input'))")
    d.execute_script("const s = document.getElementById('simp-err'); s.value = '1'; s.dispatchEvent(new Event('change'))"); W(2)
    out = el("simp-out").text
    d.save_screenshot(f"{OUT}/simplify.png")
    el("simp-ok").click(); W(1.5)
    check("applying simplifies the part", "Simplified Sphere" in el("plate-flash").text, (out, el("plate-flash").text))
    ActionChains(d).key_down(Keys.CONTROL).send_keys("z").key_up(Keys.CONTROL).perform(); W(1)
    # 5. the boolean result slices
    d.execute_script("document.getElementById('slice').click()")
    for _ in range(240):
        W(1)
        if "layers" in el("result").text or "msg err" in el("result").get_attribute("innerHTML"):
            break
    check("the plate with the boolean and simplified parts slices", "layers" in el("result").text, el("result").text[:90].replace("\n", " "))
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
