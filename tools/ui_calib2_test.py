"""The retraction, input shaping (frequency, damping) and cornering tests in headless Chromium: each is made from the
Calibrate menu and sliced, and its G-code checked (the retraction lengths the server wrote per height, the shaper /
corner commands per layer, the fast outer walls), then results are entered.

    python ui_calib2_test.py http://bicuslicer:8000/

Slices four times; saves nothing.
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
W = lambda t=0.6: time.sleep(t)
el = lambda i: d.find_element(By.ID, i)
txt = lambda i: el(i).text.strip()


def js_click(e):
    d.execute_script("arguments[0].scrollIntoView({block:'center'}); arguments[0].click()", e); W()


def menu(tool, label):
    js_click(d.find_element(By.CSS_SELECTOR, f'[data-tool="{tool}"]'))
    for b in d.find_elements(By.CSS_SELECTOR, "#menu button"):
        if label in b.text:
            js_click(b); return True
    return False


def make_and_slice(title, params=None):
    if not menu("calib", title):
        return None, "not in the menu"
    for k, v in (params or {}).items():
        d.execute_script("const e = document.querySelector(`#calib-fields [data-k='${arguments[0]}']`); e.value = arguments[1]; e.dispatchEvent(new Event('input', {bubbles: true}))", k, str(v))
    W(0.4)
    legend = txt("calib-legend")
    js_click(el("calib-ok")); W(1.5)
    js_click(el("slice"))
    for _ in range(300):
        W(1)
        cur = d.find_element(By.CSS_SELECTOR, "#plate-tabs .ptab.on").get_attribute("innerHTML")
        if "pdot ok" in cur or "msg err" in el("result").get_attribute("innerHTML"):
            break
    if "layers" not in txt("result"):
        return None, txt("result")[:200]
    href = d.execute_script("const a = [...document.querySelectorAll('#result a.btn')].find(a => /\\/gcode$/.test(a.getAttribute('href'))); return a && a.getAttribute('href')")
    g = d.execute_async_script("const done = arguments[arguments.length - 1]; fetch(arguments[0]).then(r => r.text()).then(done).catch(e => done(''))", href)
    return g, legend


def enter_result(value):
    menu("calib", "Enter this plate's result")
    W(0.6)
    d.execute_script("const e = document.getElementById('calres-in'); e.value = arguments[0]; e.dispatchEvent(new Event('input'))", str(value)); W(0.4)
    out = txt("calres-out"), el("calres-ok").text
    js_click(el("calres-ok")); W(0.8)
    return out


def zsections(g):
    """[(z, line)] for the G-code body."""
    z, out = 0.0, []
    for line in g.splitlines():
        if line.startswith(";Z:"):
            z = float(line[3:])
        out.append((z, line))
    return out


try:
    d.get(URL); W(8)
    d.execute_script("document.getElementById('plate-toolbar').hidden = false")
    # 1. retraction: 0.4 mm at the bottom, +0.2 per mm from 1 mm
    g, legend = make_and_slice("Retraction", {"start": 0.4, "end": 2.0, "step": 0.2})
    check("retraction test: made and sliced", g, legend)
    if g:
        lens = {}
        for z, line in zsections(g):
            m = re.match(r"G1 E-(\d*\.?\d+)", line)
            if m and "X" not in line and "Y" not in line:
                lens.setdefault(round(z, 1), set()).add(round(float(m.group(1)), 3))
        low = lens.get(0.6) or lens.get(0.4) or set()
        mid = next((v for k, v in sorted(lens.items()) if 3.0 <= k < 4.0), set())
        top = next((v for k, v in sorted(lens.items(), reverse=True) if k > 8.0), set())
        check("retraction lengths follow the height (0.4 at the bottom, 0.8 at 3 mm, 2.0 near the top)",
              low == {0.4} and mid == {0.8} and top == {2.0}, (sorted(low), sorted(mid), sorted(top), len(lens)))
        check("relative extrusion, no wipe, as the test sets", "M83" in g and not re.search(r"^G1 X[\d.]+ Y[\d.]+ E-", g, re.M), "")
        check("the server marked where the length changes", g.count("; BicuSlicer retraction test:") >= 8, g.count("; BicuSlicer retraction test:"))
        out = enter_result(2.0)
        check("retraction result: a filament retraction length", "Retraction length 0.6 mm" in out[0], out)
    # 2. input shaping frequency
    g, legend = make_and_slice("Input shaping frequency", {"start": 20, "end": 80})
    check("input shaping frequency: made and sliced (as a vase)", g, legend)
    if g:
        cmds = [l for _, l in zsections(g) if l.startswith("SET_INPUT_SHAPER")]
        fr = [float(m.group(1)) for c in cmds for m in [re.search(r"SHAPER_FREQ_X=([\d.]+)", c)] if m]
        check("a shaper command every layer, frequency rising 20 → 80 Hz", len(cmds) > 200 and "SHAPER_TYPE=mzv" in cmds[0] and abs(fr[0] - 20) < 0.5 and abs(fr[-1] - 80) < 0.5 and fr == sorted(fr),
              (len(cmds), cmds[:1], fr[:1], fr[-1:]))
        speeds, typ = [0], ""
        for line in g.splitlines():
            if line.startswith(";TYPE:"):
                typ = line[6:]
            elif typ == "Outer wall" and line.startswith("G1") and " F" in line:
                speeds.append(float(re.search(r" F(\d+\.?\d*)", line).group(1)) / 60)
        check("outer walls at the printer's top speed (no slow-down)", max(speeds) >= 150, max(speeds))
        out = enter_result(30)
        check("frequency result: what to put in printer.cfg (not applied to the filament)", "shaper_freq" in out[0] and out[1] == "Done", out)
    # 3. damping
    g, legend = make_and_slice("Input shaping damping", {"freqX": 52, "freqY": 47, "start": 0.05, "end": 0.15})
    check("input shaping damping: made and sliced", g, legend)
    if g:
        cmds = [l for _, l in zsections(g) if l.startswith("SET_INPUT_SHAPER")]
        check("the frequencies first, then damping rising 0.05 → 0.15", cmds and "SHAPER_FREQ_X=52.00" in cmds[0] and "SHAPER_FREQ_Y=47.00" in cmds[0]
              and "DAMPING_RATIO_X=0.15" in cmds[-1] and len(cmds) > 200, (cmds[:2], cmds[-1:]))
    # 4. cornering
    g, legend = make_and_slice("Cornering", {"start": 2, "end": 12})
    check("cornering: made and sliced", g, legend)
    if g:
        cmds = [l for _, l in zsections(g) if "SQUARE_CORNER_VELOCITY=" in l and l.startswith("SET_VELOCITY_LIMIT SQUARE")]
        v = [float(re.search(r"=([\d.]+)", c).group(1)) for c in cmds]
        check("a corner velocity every layer, 2 → 12", len(v) > 150 and abs(v[0] - 2) < 0.1 and abs(v[-1] - 12) < 0.1, (len(v), v[:1], v[-1:]))
        out = enter_result(20)
        check("cornering result: square_corner_velocity for printer.cfg", "square_corner_velocity" in out[0], out)
    d.save_screenshot(f"{OUT}/calib2.png")
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
