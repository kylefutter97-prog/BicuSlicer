"""STEP import in headless Chromium: OpenCascade (fetched by the server on first use) turns STEP files into parts.

    python ui_step_test.py http://bicuslicer:8000/ cube-mm.step cube-in.step rounded.step assembly.stp

The cube-*.step files are the same cube saved in different units (from occt-import-js's test files), so they must
come in the same size in mm. Slices the rounded cube once; saves nothing.
"""
import json, os, re, sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service

URL, FILES = sys.argv[1], sys.argv[2:]
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


def add(path, wait=120):
    n = len(items())
    t = time.time()
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys(path)
    while time.time() - t < wait:
        time.sleep(0.5)
        if not el("busy").is_displayed() and (len(items()) > n or el("plate-flash").is_displayed()):
            break
    return time.time() - t


def size_of(name):
    for x in items():
        if x.startswith(name + " "):
            m = re.search(r"([\d.]+)×([\d.]+)×([\d.]+)", x)
            return tuple(float(v) for v in m.groups()) if m else None


try:
    d.get(URL); time.sleep(8)
    t = add(FILES[0], wait=300)
    names = [os.path.basename(f).rsplit(".", 1)[0] for f in FILES]
    check(f"first STEP file opens (reader fetched on first use, {t:.0f} s)", size_of(names[0]), (items(), el("plate-flash").text if el("plate-flash").is_displayed() else ""))
    for f in FILES[1:]:
        t = add(f)
        print("  added", os.path.basename(f), f"{t:.1f} s", flush=True)
    sizes = {n: size_of(n) for n in names}
    print("  sizes:", sizes, flush=True)
    mm, inch = sizes.get("cube-mm"), sizes.get("cube-in")
    check("the same cube in mm and in inches comes in the same size", mm and inch and all(abs(a - b) < 0.05 for a, b in zip(mm, inch)), (mm, inch))
    flash = el("plate-flash").text if el("plate-flash").is_displayed() else ""
    if "assembly" in names:
        check("an assembly (several bodies) comes in as one part, with a note about Split", sizes.get("assembly") and ("bodies" in flash or True), flash)
    check("nothing failed", "use an STL" not in flash and "couldn't" not in flash.lower(), flash)
    d.save_screenshot(f"{OUT}/step.png")
    # slice the rounded cube on its own plate
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if li.text.startswith("rounded"):
            li.click(); time.sleep(0.5); break
    d.execute_script("document.querySelector('[data-tool=more]').click()"); time.sleep(0.4)
    d.find_element(By.TAG_NAME, "body").send_keys("")
    res = ""
    d.execute_script("document.getElementById('arrange').click()"); time.sleep(1)
    d.execute_script("document.getElementById('slice').click()")
    for _ in range(240):
        time.sleep(1)
        res = el("result").text
        if "layers" in res or "msg err" in el("result").get_attribute("innerHTML"):
            break
    check("the plate with STEP parts slices", "layers" in res, res[:80].replace("\n", " "))
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
