"""The printer view (OrcaSlicer's Device tab) in headless Chromium, read-only: it never sends a command to the printer.

    python ui_printer_test.py http://bicuslicer:8000/

Opens the view from the printer pill and checks the status, the job card, the tiles and the camera area, and that the
server refuses out-of-range values (those requests stop at BicuSlicer and never reach the printer).
"""
import json, os, sys, time
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
el = lambda i: d.find_element(By.ID, i)
try:
    d.get(URL); time.sleep(8)
    el("printer").click(); time.sleep(4)
    check("the printer pill opens the printer view", d.find_elements(By.CSS_SELECTOR, "#pv[open]"))
    check("name and state", el("pv-name").text and el("pv-state").text not in ("", "…"), (el("pv-name").text, el("pv-state").text))
    tiles = [t.text.replace("\n", " ") for t in d.find_elements(By.CSS_SELECTOR, "#pv-tiles .pv-tile")]
    check("temperature, fan, speed and flow tiles", len(tiles) == 5 and "Nozzle" in tiles[0] and "°" in tiles[0], tiles)
    job = el("pv-job").is_displayed()
    if job:
        stats = el("pv-stats").text.replace("\n", " ")
        thumb = d.execute_script("const i = document.getElementById('pv-thumb'); return !i.hidden && i.complete && i.naturalWidth")
        check("the last job: file, progress, layer and times", el("pv-file").text and "Layer" in stats, (el("pv-file").text, stats))
        check("the G-code's thumbnail shows", thumb, thumb)
    else:
        check("no job card when nothing was printed", True)
    time.sleep(4)
    cam_ok = d.execute_script("const i = document.getElementById('pv-img'); return !i.hidden && i.complete && i.naturalWidth > 0")
    msg = el("pv-cam-msg").text
    check("camera: a picture, or a clear message", cam_ok or "camera" in msg.lower(), (cam_ok, msg))
    d.save_screenshot(f"{OUT}/pv-desktop.png")
    # the server refuses bad values before anything reaches the printer
    pid = d.execute_script("return fetch('/api/printers').then(r => r.json()).then(j => j.printers[0].id)")
    codes = [d.execute_script(f"return fetch('/api/printers/{pid}/action', {{method: 'POST', headers: {{'Content-Type': 'application/json'}}, body: JSON.stringify({b})}}).then(r => r.status)")
             for b in ['{"action": "nozzle", "value": 999}', '{"action": "bed", "value": -5}', '{"action": "fan", "value": "lots"}', '{"action": "rm -rf"}']]
    check("out-of-range or unknown actions are refused by the server", codes == [400, 400, 400, 400], codes)
    el("pv-close").click(); time.sleep(0.5)
    check("closing stops the camera", not d.find_elements(By.CSS_SELECTOR, "#pv[open]") and not el("pv-img").get_attribute("src"))
    d.set_window_size(400, 860); time.sleep(0.5)
    el("printer").click(); time.sleep(4)
    d.save_screenshot(f"{OUT}/pv-phone.png")
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE" and "/webcam/" not in e["message"] and "/thumb" not in e["message"] and "/action" not in e["message"]]
    check("no errors in the browser console (camera/thumbnail misses aside)", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
