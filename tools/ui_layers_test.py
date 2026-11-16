"""Variable layer height and height ranges in BicuSlicer, driven in headless Chromium (see ui_test.py for how to run).

    python ui_layers_test.py http://bicuslicer:8000/ [project-with-layer-data.3mf]

Adds a sphere, turns on adaptive layer heights (checking the Organic-supports warning and its fix), smooths, adds a
height range, slices (one slice) and checks the slicer used them. The optional project is an OrcaSlicer-written 3MF
whose second object has a layer height profile and whose first has a height range (2 to 6 mm at 0.1 mm). Saves nothing.
"""
import json, math, os, re, sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.chrome.service import Service

URL = sys.argv[1]
PROJECT = sys.argv[2] if len(sys.argv) > 2 else None
OUT = os.environ.get("OUT", "/out")
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), str(detail)[:300]))
    print(("PASS " if ok else "FAIL ") + name + (f": {str(detail)[:300]}" if detail != "" else ""), flush=True)


def sphere_stl(path, r=12, seg=48, rings=32):
    pt = lambda i, j: (r * math.sin(i / rings * math.pi) * math.cos(j / seg * 2 * math.pi), r * math.sin(i / rings * math.pi) * math.sin(j / seg * 2 * math.pi), r - r * math.cos(i / rings * math.pi))
    with open(path, "w") as f:
        f.write("solid s\n")
        for i in range(rings):
            for j in range(seg):
                a, b, c, d = pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)
                for tri in ((a, b, c), (a, c, d)):
                    f.write(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {x:.5f} {y:.5f} {z:.5f}\n" for x, y, z in tri) + "  endloop\n endfacet\n")
        f.write("endsolid s\n")


opts = webdriver.ChromeOptions()
for a in ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1400,1100",
          "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]:
    opts.add_argument(a)
opts.binary_location = os.environ.get("CHROME_BIN", "/usr/bin/chromium")
opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
d = webdriver.Chrome(service=Service(os.environ.get("CHROMEDRIVER", "/app/chromedriver")), options=opts)
W = lambda t=0.6: time.sleep(t)
el = lambda i: d.find_element(By.ID, i)
shown = lambda i: el(i).is_displayed()
txt = lambda i: el(i).text.strip()
items = lambda: [li.text.replace("\n", " | ") for li in d.find_elements(By.CSS_SELECTOR, "#objects li")]


def click(i):
    d.execute_script("arguments[0].scrollIntoView({block:'center'})", el(i)); el(i).click(); W()


def pick(name):
    for li in d.find_elements(By.CSS_SELECTOR, "#objects li"):
        if name in li.text:
            li.click(); W(); return True
    return False


def layers(info):
    m = re.match(r"(\d+) layers \((\d+) at", info)
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


try:
    sphere_stl("/tmp/sphere.stl")
    d.get(URL); W(8)
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/sphere.stl"); W(2)
    pick("sphere")
    check("layer height section: uniform by default", "Every layer" in txt("lh-info") and not shown("lh-chart-wrap"), txt("lh-info"))
    d.execute_script("document.querySelector('[data-lh=adaptive]').click()"); W(1)
    n, uni = layers(txt("lh-info"))
    check("adaptive: chart and layer count", shown("lh-chart-wrap") and n and n != uni, txt("lh-info"))
    check("warns about organic supports (Bicubot's print settings use them)", shown("lh-warn"), txt("lh-warn"))
    click("lh-fix")
    check("one tap fixes it with slim tree supports for this part", not shown("lh-warn") and any("sphere" in x and "⚙ 1" in x for x in items()), items())
    # quality slider: finer -> more layers
    d.execute_script("const r = document.getElementById('lh-quality'); r.value = 0; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change'));"); W(1)
    n_fine, _ = layers(txt("lh-info"))
    check("finer quality gives more layers", n_fine and n_fine > n, (n, n_fine))
    click("lh-smooth")
    check("smooth keeps a valid profile", layers(txt("lh-info"))[0], txt("lh-info"))
    d.save_screenshot(f"{OUT}/l1-adaptive.png")
    # a height range
    click("range-add")
    rl = [li.text for li in d.find_elements(By.CSS_SELECTOR, "#range-list li")]
    check("height range added with its own layer height", len(rl) == 1 and "0.1 mm" in rl[0] and shown("range-edit"), rl)
    expect = layers(txt("lh-info"))[0]

    # slice: the slicer gets the profile (layer count close to ours)
    click("slice")
    for _ in range(240):
        W(1)
        if "pdot ok" in el("plate-tabs").get_attribute("innerHTML") or "msg err" in el("result").get_attribute("innerHTML"):
            break
    res = txt("result")
    m = re.search(r"(\d+)\s*\n?\s*layers", res)
    got = int(m.group(1)) if m else None
    check("slices, and the slicer's layer count matches the profile", got and expect and abs(got - expect) <= 3, (expect, got, res[:120]))
    d.save_screenshot(f"{OUT}/l2-sliced.png")

    # undo goes back through the steps; the slice goes stale
    ActionChains(d).key_down(Keys.CONTROL).send_keys("z").key_up(Keys.CONTROL).perform(); W(1)
    check("undo removes the range", not d.find_elements(By.CSS_SELECTOR, "#range-list li"), txt("lh-info"))

    if PROJECT:
        ActionChains(d).key_down(Keys.CONTROL).send_keys(Keys.DELETE).key_up(Keys.CONTROL).perform(); W(1)
        for b in d.find_elements(By.CSS_SELECTOR, "dialog[open] button"):
            if "Clear" in b.text: b.click(); W(); break
        d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys(PROJECT); W(2)
        if d.find_elements(By.CSS_SELECTOR, "#import-dlg[open]"):
            d.find_element(By.CSS_SELECTOR, "#import-dlg button[value=ok]").click(); W(3)
        it = items()
        check("project with layer data opens", len(it) >= 2, it)
        if len(it) >= 2:
            d.find_elements(By.CSS_SELECTOR, "#objects li")[1].click(); W()
            on = d.find_elements(By.CSS_SELECTOR, "[data-lh=imported].on")
            n2, uni2 = layers(txt("lh-info"))
            check("second part keeps the project's layer heights", on and n2 == 150, (bool(on), txt("lh-info")))
            d.find_elements(By.CSS_SELECTOR, "#objects li")[0].click(); W()
            rl = [li.text for li in d.find_elements(By.CSS_SELECTOR, "#range-list li")]
            vals = [i.get_attribute("value") for i in d.find_elements(By.CSS_SELECTOR, "#range-list input")]
            check("first part keeps its height range (2 to 6 mm at 0.1)", vals == ["2", "6"] and "0.1 mm" in (rl[0] if rl else ""), (vals, rl))
            check("…and its layer count", layers(txt("lh-info"))[0] == 70, txt("lh-info"))
            d.save_screenshot(f"{OUT}/l3-project.png")

    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:600])
finally:
    with open(f"{OUT}/layers-results.json", "w") as f:
        json.dump(results, f)
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
