"""Opening OrcaSlicer / Bambu projects in BicuSlicer, driven in headless Chromium (see ui_test.py for how to run).

    python ui_import_test.py http://bicuslicer:8000/ project.3mf [other-printer-project.3mf]

project.3mf is the test project tools/make_test_project.py builds and the OrcaSlicer CLI re-exports: plate 1 "Cubes A"
with a cube that has its own infill, a modifier part with denser infill, painted supports and seam, and a copy turned
90°; plate 2 "Cube B" (print sequence by object) with a small cube. The optional second file is any project made for
another printer, to check its print settings are offered. It slices plate 1 once (to check what the slicer gets) and
saves nothing.
"""
import json, os, sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.chrome.service import Service

URL, PROJECT = sys.argv[1], sys.argv[2]
OTHER = sys.argv[3] if len(sys.argv) > 3 else None
OUT = os.environ.get("OUT", "/out")
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), str(detail)[:300]))
    print(("PASS " if ok else "FAIL ") + name + (f": {str(detail)[:300]}" if detail != "" else ""), flush=True)


opts = webdriver.ChromeOptions()
for a in ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1400,1000",
          "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]:
    opts.add_argument(a)
opts.binary_location = os.environ.get("CHROME_BIN", "/usr/bin/chromium")
opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
d = webdriver.Chrome(service=Service(os.environ.get("CHROMEDRIVER", "/app/chromedriver")), options=opts)
d.set_script_timeout(120)
W = lambda t=0.6: time.sleep(t)
txt = lambda sel: (d.find_elements(By.CSS_SELECTOR, sel) or [None])[0] and d.find_element(By.CSS_SELECTOR, sel).text.strip()
tabs = lambda: [b.text.replace("\n", " ").strip() for b in d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")]
items = lambda: [li.text.replace("\n", " | ") for li in d.find_elements(By.CSS_SELECTOR, "#objects li")]


def open_file(path):
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys(path)
    for _ in range(30):
        W(0.5)
        if d.find_elements(By.CSS_SELECTOR, "#import-dlg[open]"):
            return True
    return False


def key(k, ctrl=False):
    a = ActionChains(d)
    if ctrl: a.key_down(Keys.CONTROL)
    a.send_keys(k)
    if ctrl: a.key_up(Keys.CONTROL)
    a.perform(); W()


def pick(name_part):
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if name_part in li.text:
            li.click(); W(); return True
    return False


try:
    d.get(URL); W(8)
    check("project dialog opens", open_file(PROJECT))
    summary = txt("#imp-summary")
    check("summary: parts, plates, modifier, own settings, painting", all(s in summary for s in ["on 2 plates", "modifier", "own settings", "Painted"]), summary)
    d.save_screenshot(f"{OUT}/i1-dialog.png")
    d.find_element(By.CSS_SELECTOR, "#import-dlg button[value=ok]").click(); W(3)
    bar = txt("#process-bar-text") if d.find_element(By.ID, "process-bar").is_displayed() else ""
    # made with this printer's own settings: nothing (or only what you've changed since) differs, never the ~200 defaults
    n_changed = int(bar.split()[0]) if bar else 0
    check("a project made with your own settings changes (almost) none of them", n_changed <= 3, bar)
    t = tabs()
    check("two plates with their names", len(t) == 3 and "Cubes A" in t[0] and "Cube B" in t[1], t)
    it = items()
    check("parts on their plates", any("Cube with modifier" in x and "P1" in x for x in it) and any("Small cube" in x and "P2" in x for x in it), it)
    check("modifier part listed under its part", any("denser core" in x and "modifier" in x for x in it), it)
    check("own settings and painting shown", any("Cube with modifier" in x and "⚙" in x and "🖌" in x for x in it), it)
    check("nothing off the bed", not d.find_element(By.ID, "plate-msg").is_displayed(), txt("#plate-msg"))
    pick("Cube with modifier")
    pos = (d.find_element(By.ID, "t-x").get_attribute("value"), d.find_element(By.ID, "t-y").get_attribute("value"))
    check("cube where the project had it (60, 80 on plate 1)", pos == ("60", "80"), pos)
    pick("Small cube")
    pos = (d.find_element(By.ID, "t-x").get_attribute("value"), d.find_element(By.ID, "t-y").get_attribute("value"))
    check("small cube where the project had it (100, 100 on plate 2)", pos == ("100", "100"), pos)
    d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")[1].click(); W()
    for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
        if "Plate settings" in b.text: b.click(); break
    W()
    seq = d.find_element(By.ID, "pl-seq").get_attribute("value")
    check("plate 2 keeps print sequence by object", seq == "by object", seq)
    d.find_element(By.CSS_SELECTOR, "#plate-dlg button[value=cancel]").click(); W()
    d.save_screenshot(f"{OUT}/i2-opened.png")

    # slice plate 1: the slicer gets the modifier, the part's settings and the painting exactly as painted
    d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")[0].click(); W()
    d.find_element(By.ID, "slice").click()
    for _ in range(240):
        W(1)
        if "pdot ok" in d.find_element(By.ID, "plate-tabs").get_attribute("innerHTML") or "msg err" in d.find_element(By.ID, "result").get_attribute("innerHTML"):
            break
    check("plate 1 slices", "pdot ok" in d.find_element(By.ID, "plate-tabs").get_attribute("innerHTML").split('data-pi="1"')[0], txt("#result"))

    key("z", ctrl=True); W(1)
    check("undo takes the whole project off again", len(tabs()) == 2 and not items(), (tabs(), items()))

    if OTHER:
        check("other printer's project opens", open_file(OTHER))
        st = txt("#imp-settings-text") if d.find_element(By.ID, "imp-set-wrap").is_displayed() else ""
        check("its print settings are offered", "differ" in st, st)
        sp = d.find_element(By.ID, "imp-speeds")
        check("speeds are offered separately and off by default", not sp.is_selected(), txt("#imp-speeds-text"))
        d.save_screenshot(f"{OUT}/i3-settings.png")
        d.find_element(By.CSS_SELECTOR, "#import-dlg button[value=ok]").click(); W(3)
        bar = txt("#process-bar-text") if d.find_element(By.ID, "process-bar").is_displayed() else ""
        check("print settings became unsaved changes", "unsaved change" in bar, bar)
        check("parts opened", len(items()) >= 1, items())

    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:600])
finally:
    with open(f"{OUT}/import-results.json", "w") as f:
        json.dump(results, f)
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
