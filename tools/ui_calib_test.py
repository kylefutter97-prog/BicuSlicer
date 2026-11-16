"""Calibration tests and G-code at a layer in BicuSlicer, driven in headless Chromium (see ui_test.py for how to run).

    python ui_calib_test.py http://bicuslicer:8000/

Creates every calibration test from the Calibrate menu, slices each (six slices), enters a flow result, and adds a
pause from the Layers view. Prints the job ids so the G-code can be checked on the server. Saves nothing.
"""
import json, os, sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service

URL = sys.argv[1]
OUT = os.environ.get("OUT", "/out")
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), str(detail)[:300]))
    print(("PASS " if ok else "FAIL ") + name + (f": {str(detail)[:300]}" if detail != "" else ""), flush=True)


opts = webdriver.ChromeOptions()
for a in ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1400,1100",
          "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]:
    opts.add_argument(a)
opts.binary_location = os.environ.get("CHROME_BIN", "/usr/bin/chromium")
opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
d = webdriver.Chrome(service=Service(os.environ.get("CHROMEDRIVER", "/app/chromedriver")), options=opts)
W = lambda t=0.6: time.sleep(t)
el = lambda i: d.find_element(By.ID, i)
txt = lambda i: el(i).text.strip()
tabs = lambda: [b.text.replace("\n", " ").strip() for b in d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")]


def js_click(e):
    d.execute_script("arguments[0].scrollIntoView({block:'center'}); arguments[0].click()", e); W()


def menu(tool, label):
    js_click(d.find_element(By.CSS_SELECTOR, f'[data-tool="{tool}"]'))
    for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
        if label in b.text:
            js_click(b); return True
    return False


def slice_current():
    js_click(el("slice"))
    for _ in range(300):
        W(1)
        cur = d.find_element(By.CSS_SELECTOR, "#plate-tabs .ptab.on").get_attribute("innerHTML")
        if "pdot ok" in cur or "msg err" in el("result").get_attribute("innerHTML"):
            break
    return txt("result")


try:
    d.get(URL); W(8)
    # the plate tools appear once something is on the plate: show them by toggling with a test first
    d.execute_script("document.getElementById('plate-toolbar').hidden = false")
    TESTS = [("Temperature tower", None), ("Flow ratio", None), ("Pressure advance", None), ("Max flow", None), ("wall artefacts", None), ("Tolerance", None)]
    for title, _ in TESTS:
        ok = menu("calib", title)
        if not ok:
            check(f"{title}: in the Calibrate menu", False); continue
        legend = txt("calib-legend")
        js_click(el("calib-ok")); W(1.5)
        t = tabs()
        res = slice_current()
        good = "layers" in res and "msg err" not in el("result").get_attribute("innerHTML")
        check(f"{title}: made and sliced", good, f"{t[-2] if len(t) > 1 else t} | {legend[:90]} | {res[:80].replace(chr(10), ' ')}")
        d.save_screenshot(f"{OUT}/c-{title.split()[0].lower()}.png")

    # flow result -> unsaved filament change
    for i, b in enumerate(d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")):
        if "Flow" in b.text:
            js_click(b); js_click(d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")[i]); break
    for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
        if "calibration result" in b.text:
            js_click(b); break
    W()
    sel = d.find_element(By.ID, "calres-in")
    d.execute_script("arguments[0].value = '-5'; arguments[0].dispatchEvent(new Event('input'))", sel); W()
    out = txt("calres-out")
    js_click(el("calres-ok")); W(1)
    mod = txt("mod-filament") if el("mod-filament").is_displayed() else ""
    check("flow result becomes an unsaved filament change", "Flow ratio" in out and "unsaved" in mod, (out, mod))

    # pause at a layer, from the Layers view of the last sliced plate
    js_click(d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")[-2]); W(1)
    check("pause buttons only with this plate's layers on screen", not el("lg-row").is_displayed())
    slice_current()          # the filament change made every slice out of date
    js_click(d.find_element(By.CSS_SELECTOR, '[data-view="preview"]')); W(4)
    d.execute_script("const r = document.getElementById('layer'); r.value = 10; r.dispatchEvent(new Event('input'))"); W()
    js_click(el("lg-pause")); W()
    chips = [c.text for c in d.find_elements(By.CSS_SELECTOR, "#lg-list .lg-chip")]
    stale, layers_on = el("preview-stale").is_displayed(), "on" in d.find_element(By.CSS_SELECTOR, '[data-view="preview"]').get_attribute("class")
    check("pause added at the layer", chips and "Pause" in chips[0], chips)
    check("…staying in the layers view", layers_on)
    check("…and the slice is marked out of date", stale, el("preview-stale").get_attribute("outerHTML"))
    res = slice_current()
    check("slices again with the pause", "layers" in res, res[:60])
    d.save_screenshot(f"{OUT}/c-pause.png")

    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:600])
finally:
    with open(f"{OUT}/calib-results.json", "w") as f:
        json.dump(results, f)
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
