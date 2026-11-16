"""Drives BicuSlicer in a real (headless) Chromium: multiple plates, undo/redo, per-plate slicing, plate settings,
overflow onto new plates, deleting a plate, and a project saved and reopened with its plates.

It slices one 20 mm cube and saves a project called "UI test plates (delete me)", which it deletes again at the end.
Use a throwaway instance or one you don't mind that on. Needs Selenium, Chromium and chromedriver; the FlareSolverr
image has all three, e.g. on the Docker network BicuSlicer is on:

    docker run --rm --network <net> -v "$PWD/tools:/t:ro" -v /tmp/ui:/out --entrypoint python \
        ghcr.io/flaresolverr/flaresolverr:latest /t/ui_test.py http://<bicuslicer>:8000/

Screenshots and results.json go to /out (OUT env var). CHROME_BIN and CHROMEDRIVER override the browser paths.
"""
import json, os, sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.chrome.service import Service

URL = sys.argv[1] if len(sys.argv) > 1 else "http://slice:8000/"
OUT = os.environ.get("OUT", "/out")
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f": {detail}" if detail else ""), flush=True)


def cube_stl(path, sx, sy, sz):
    v = [(x, y, z) for x in (0, sx) for y in (0, sy) for z in (0, sz)]
    faces = [(0, 2, 1), (1, 2, 3), (4, 5, 6), (5, 7, 6), (0, 1, 4), (1, 5, 4), (2, 6, 3), (3, 6, 7), (0, 4, 2), (2, 4, 6), (1, 3, 5), (3, 7, 5)]
    with open(path, "w") as f:
        f.write("solid c\n")
        for a, b, c in faces:
            f.write(" facet normal 0 0 0\n  outer loop\n")
            for i in (a, b, c):
                f.write(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n")
            f.write("  endloop\n endfacet\n")
        f.write("endsolid c\n")


opts = webdriver.ChromeOptions()
for a in ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1400,1000",
          "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]:
    opts.add_argument(a)
opts.binary_location = os.environ.get("CHROME_BIN", "/usr/bin/chromium")
opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
d = webdriver.Chrome(service=Service(os.environ.get("CHROMEDRIVER", "/app/chromedriver")), options=opts)
d.set_script_timeout(120)
W = lambda: time.sleep(0.6)


def text(sel):
    els = d.find_elements(By.CSS_SELECTOR, sel)
    return els[0].text.strip() if els else None


def tabs():
    return [(b.text.replace("\n", " ").strip(), "on" in b.get_attribute("class")) for b in d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")]


def add_file(path):
    inp = d.find_elements(By.CSS_SELECTOR, ".file-input")[0]
    inp.send_keys(path)
    time.sleep(2)


def key(k, ctrl=False, shift=False):
    a = ActionChains(d)
    if ctrl: a.key_down(Keys.CONTROL)
    if shift: a.key_down(Keys.SHIFT)
    a.send_keys(k)
    if shift: a.key_up(Keys.SHIFT)
    if ctrl: a.key_up(Keys.CONTROL)
    a.perform()
    W()


def shot(name):
    d.save_screenshot(f"{OUT}/{name}.png")


try:
    cube_stl("/tmp/cube20.stl", 20, 20, 20)
    cube_stl("/tmp/bar.stl", 60, 10, 5)
    d.get(URL)
    for _ in range(60):
        if d.find_elements(By.CSS_SELECTOR, "#slice") and "Choose" not in (text("#result") or "") and d.execute_script("return !!document.querySelector('#machine-select, select')"):
            break
        time.sleep(1)
    time.sleep(4)
    add_file("/tmp/cube20.stl")
    check("cube added", "1 part" in (text("#plate-summary") or ""), text("#plate-summary"))
    t = tabs()
    check("one plate tab plus add", len(t) == 2 and t[0][1], t)
    check("main button says Slice", text("#slice") == "Slice", text("#slice"))

    # add a plate
    d.find_element(By.CSS_SELECTOR, "#plate-tabs .ptab.add").click(); W()
    t = tabs()
    check("second plate added and current", len(t) == 3 and t[1][1], t)
    check("button: slice plate 2 (disabled, empty)", text("#slice") == "Slice plate 2" and not d.find_element(By.ID, "slice").is_enabled(), text("#slice"))
    add_file("/tmp/bar.stl")
    items = [li.text for li in d.find_elements(By.CSS_SELECTOR, "#objects li")]
    check("bar went onto plate 2", any("P2" in x and "bar" in x for x in items) and any("P1" in x and "cube20" in x for x in items), items)
    check("button enabled for plate 2", d.find_element(By.ID, "slice").is_enabled())
    shot("01-two-plates")

    # undo the bar, then the plate, then redo both
    key("z", ctrl=True)
    items = [li.text for li in d.find_elements(By.CSS_SELECTOR, "#objects li")]
    check("undo removes the bar", not any("bar" in x for x in items), items)
    key("z", ctrl=True)
    check("undo removes plate 2", len(tabs()) == 2, tabs())
    key("z", ctrl=True, shift=True)
    key("y", ctrl=True)
    items = [li.text for li in d.find_elements(By.CSS_SELECTOR, "#objects li")]
    check("redo brings plate 2 and the bar back", len(tabs()) == 3 and any("bar" in x for x in items), (tabs(), items))

    # switch to plate 1 and slice it
    d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")[0].click(); W()
    check("plate 1 current", tabs()[0][1] and text("#slice") == "Slice plate 1", (tabs(), text("#slice")))
    d.find_element(By.ID, "slice").click()
    for _ in range(180):
        time.sleep(1)
        if "pdot ok" in d.find_element(By.ID, "plate-tabs").get_attribute("innerHTML") or "msg err" in d.find_element(By.ID, "result").get_attribute("innerHTML"):
            break
    html = d.find_element(By.ID, "plate-tabs").get_attribute("innerHTML")
    check("plate 1 sliced (green dot)", 'data-pi="0"' in html and html.split('data-pi="1"')[0].count("pdot ok") == 1, text("#result")[:200] if text("#result") else "")
    check("main button moves on after slicing", text("#slice") not in ("Slice", "Slice plate 1", "Slicing…"), text("#slice"))
    time.sleep(3)
    shot("02-plate1-sliced")

    # plate 2: its result card is empty, and changing it doesn't touch plate 1's slice
    d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")[1].click(); W()
    check("plate 2 has no result shown", not d.find_element(By.ID, "result-card").is_displayed(), text("#result"))
    key("+")     # add a copy of the selected part? select bar first via the list
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if "bar" in li.text:
            li.click(); break
    W()
    key("r")      # rotate it on plate 2
    html = d.find_element(By.ID, "plate-tabs").get_attribute("innerHTML")
    check("plate 1 still sliced after editing plate 2", html.split('data-pi="1"')[0].count("pdot ok") == 1, html[:300])
    d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")[0].click(); W()
    check("back on plate 1 the slice is still valid", text("#slice") not in ("Slice plate 1",), text("#slice"))

    # plate settings dialog on plate 1
    d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")[0].click(); W()
    menu = [b.text for b in d.find_elements(By.CSS_SELECTOR, "#menu button")]
    check("plate menu opens", any("Plate settings" in m for m in menu) and any("Slice all" in m for m in menu), menu)
    for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
        if "Plate settings" in b.text:
            b.click(); break
    W()
    d.find_element(By.ID, "pl-name").send_keys("Cubes")
    shot("03-plate-settings")
    d.find_element(By.CSS_SELECTOR, "#plate-dlg button[value=ok]").click(); W()
    check("plate named", "Cubes" in tabs()[0][0], tabs())
    check("renaming doesn't make the slice stale", 'class="pdot ok"' in d.find_element(By.ID, "plate-tabs").get_attribute("innerHTML").split('data-pi="1"')[0])

    # arrange overflow: many copies of the bar on plate 2 spill onto a new plate
    d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")[1].click(); W()
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if "bar" in li.text:
            li.click(); break
    W()
    n0 = len(tabs())
    cp = d.find_element(By.ID, "copy-plus")
    for _ in range(48):
        d.execute_script("arguments[0].click()", cp)
    time.sleep(1.5)
    bars = [li.text for li in d.find_elements(By.CSS_SELECTOR, "#objects li") if "bar" in li.text]
    check("overflow fills plates in order, nothing left off a plate", not d.find_element(By.ID, "plate-msg").is_displayed()
          and bars and bars[0].split("\n")[1].startswith("P2,3,"), (len(tabs()), bars, text("#plate-msg")))
    shot("04-overflow")
    tx = d.find_element(By.ID, "t-x").get_attribute("value")
    check("position X is on the part's own plate", tx and 0 <= float(tx) <= 400, tx)
    d.execute_script("window.scrollTo(0,0)")

    # delete the last plate
    last = d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")[-2]
    last.click(); W()
    last = d.find_elements(By.CSS_SELECTOR, "#plate-tabs .ptab")[-2]
    last.click(); W()
    n1 = len(tabs())
    for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
        if "Delete this plate" in b.text:
            b.click(); break
    W()
    for b in d.find_elements(By.CSS_SELECTOR, "dialog[open] button"):
        if "Delete plate" in b.text:
            b.click(); break
    W()
    check("plate deleted", len(tabs()) == n1 - 1, tabs())
    key("z", ctrl=True)
    check("undo brings the deleted plate back", len(tabs()) == n1, tabs())

    # save as a project, reload, reopen: plates, names and which plate each copy is on come back
    n_pl = len(tabs()); before = [li.text for li in d.find_elements(By.CSS_SELECTOR, "#objects li")]
    key("s", ctrl=True)
    inp = d.find_element(By.ID, "ask-input"); inp.clear(); inp.send_keys("UI test plates (delete me)")
    d.find_element(By.ID, "ask-ok").click(); time.sleep(4)
    d.get(URL); time.sleep(6)
    key("o", ctrl=True); time.sleep(2)
    pid = None
    for card in d.find_elements(By.CSS_SELECTOR, ".pj-card"):
        if "UI test plates" in card.text:
            b = card.find_element(By.CSS_SELECTOR, "[data-pj-open]"); pid = b.get_attribute("data-pj-open"); b.click(); break
    time.sleep(5)
    after = [li.text for li in d.find_elements(By.CSS_SELECTOR, "#objects li")]
    check("reopened project has its plates", len(tabs()) == n_pl and "Cubes" in tabs()[0][0], tabs())
    check("reopened parts are on the same plates", before == after, (before, after))
    if pid:
        d.execute_async_script("fetch('/api/projects/' + arguments[0], {method: 'DELETE'}).then(r => arguments[1](r.status))", pid)
        check("test project deleted", pid not in json.dumps(d.execute_async_script("fetch('/api/projects').then(r => r.json()).then(arguments[0])")))

    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:800])
    shot("05-end")
finally:
    with open(f"{OUT}/results.json", "w") as f:
        json.dump(results, f)
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
