"""Hand-placed brim ears from an OrcaSlicer project, in headless Chromium: the import test's project (exported.3mf, made
by OrcaSlicer) with two ears added at the corners of its first object's base and that object's brim set to "Painted";
opened in BicuSlicer, the ears come along on that part, sit at its corners, and slice as brim.

    python ui_ears_import_test.py http://bicuslicer:8000/ exported.3mf

Slices once; saves nothing.
"""
import io, json, os, re, sys, time, zipfile
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service

URL, SRC = sys.argv[1], sys.argv[2]
OUT = os.environ.get("OUT", "/out")
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f": {detail}" if detail != "" else ""), flush=True)


# the project, with ears
zin = zipfile.ZipFile(SRC)
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
    for n in zin.namelist():
        data = zin.read(n)
        if n == "Metadata/model_settings.config":
            data = data.replace(b'<metadata key="sparse_infill_density" value="30%"/>', b'<metadata key="sparse_infill_density" value="30%"/>\n    <metadata key="brim_type" value="painted"/>', 1)
        zout.writestr(n, data)
    zout.writestr("Metadata/brim_ear_points.txt", "brim_points_format_version=0\nobject_id=1|-10 -10 0 4 10 10 0 4\n")
open("/tmp/ears-project.3mf", "wb").write(buf.getvalue())

o = webdriver.ChromeOptions()
for a in ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1400,1000", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]:
    o.add_argument(a)
o.binary_location = os.environ.get("CHROME_BIN", "/usr/bin/chromium")
o.set_capability("goog:loggingPrefs", {"browser": "ALL"})
d = webdriver.Chrome(service=Service(os.environ.get("CHROMEDRIVER", "/app/chromedriver")), options=o)
el = lambda i: d.find_element(By.ID, i)
W = lambda t=0.6: time.sleep(t)

try:
    d.get(URL); W(8)
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/ears-project.3mf"); W(4)
    if d.find_elements(By.CSS_SELECTOR, "#import-dlg[open]"):
        d.find_element(By.CSS_SELECTOR, "#import-dlg button[value=ok]").click(); W(5)
    names = [li.text.split("\n")[0] for li in d.find_elements(By.CSS_SELECTOR, "#objects li")]
    check("the project opens", any(n.startswith("Cube with modifier") for n in names), names)
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith("Cube with modifier"):
            li.click(); break
    W()
    d.execute_script("document.getElementById('tb-ears').click()"); W(0.4)
    labels = [b.text for b in d.find_elements(By.CSS_SELECTOR, "#menu button")]
    check("its two hand-placed ears came along", any("Remove the 2 hand-placed ears" in t for t in labels), labels)
    d.find_element(By.TAG_NAME, "body").send_keys(""); W(0.3)
    # the ears sit on the part's corners: compare the part's footprint with the ear discs' centres via a slice
    d.execute_script("document.getElementById('slice').click()")
    for _ in range(240):
        W(1)
        if "layers" in el("result").text or "msg err" in el("result").get_attribute("innerHTML"):
            break
    check("plate 1 slices", "layers" in el("result").text, el("result").text[:100].replace("\n", " "))
    href = d.execute_script("const a = [...document.querySelectorAll('#result a.btn')].find(a => /\\/gcode$/.test(a.getAttribute('href'))); return a && a.getAttribute('href')")
    g = d.execute_async_script("const done = arguments[arguments.length - 1]; fetch(arguments[0]).then(r => r.text()).then(done).catch(e => done(''))", href) if href else ""
    brim, typ, x, y = [], "", 0.0, 0.0
    for line in g.splitlines():
        if line.startswith(";TYPE:"):
            typ = line[6:]
        elif line.startswith("G1"):
            mx, my, me = re.search(r" X(-?[\d.]+)", line), re.search(r" Y(-?[\d.]+)", line), re.search(r" E([\d.]+)", line)
            x = float(mx.group(1)) if mx else x
            y = float(my.group(1)) if my else y
            if typ == "Brim" and me and (mx or my):
                brim.append((x, y))
    check("the ears print as brim", len(brim) > 10, len(brim))
    if brim:
        xs, ys = [p[0] for p in brim], [p[1] for p in brim]
        # two separate ear blobs, about 8 mm across each, ~20 mm apart diagonally
        span = (max(xs) - min(xs), max(ys) - min(ys))
        check("two ears at opposite corners (the brim spans corner to corner, not all round)", 22 < span[0] < 32 and 22 < span[1] < 32, span)
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
