"""BicuSlicer under Home Assistant's ingress (the add-on's sidebar panel), in headless Chromium, through a stand-in for
Home Assistant's proxy: it serves only /api/hassio_ingress/<token>/..., forwards to a BicuSlicer started with INGRESS=1
and adds the X-Ingress-Path header, and (like Home Assistant) answers 404 to anything outside that path, so a link
the page didn't prefix fails visibly. Loads the page, its settings, a part, a slice and the layer preview.

    python ui_ingress_test.py http://bicuslicer-with-ingress:8000

Slices once; saves nothing.
"""
import http.server, json, os, sys, threading, time, urllib.request, urllib.error
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service

UPSTREAM = sys.argv[1].rstrip("/")
PREFIX = "/api/hassio_ingress/Tok3n_abc-123"
OUT = os.environ.get("OUT", "/out")
results, outside = [], []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f": {detail}" if detail != "" else ""), flush=True)


class Proxy(http.server.BaseHTTPRequestHandler):
    def _go(self):
        if not self.path.startswith(PREFIX + "/") and self.path != PREFIX:
            outside.append(self.path)
            self.send_response(404); self.end_headers(); return
        rest = self.path[len(PREFIX):] or "/"
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)) if self.command == "POST" else None
        hdrs = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "content-length", "accept-encoding")}
        hdrs["X-Ingress-Path"] = PREFIX
        req = urllib.request.Request(UPSTREAM + rest, data=body, headers=hdrs, method=self.command)
        try:
            r = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            r = e
        data = r.read()
        self.send_response(r.status)
        for k, v in r.headers.items():
            if k.lower() not in ("transfer-encoding", "connection", "content-length", "content-encoding"):
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    do_GET = do_POST = do_DELETE = _go
    def log_message(self, *a): pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 9000), Proxy)
threading.Thread(target=srv.serve_forever, daemon=True).start()

o = webdriver.ChromeOptions()
for a in ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--window-size=1400,1000", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]:
    o.add_argument(a)
o.binary_location = os.environ.get("CHROME_BIN", "/usr/bin/chromium")
o.set_capability("goog:loggingPrefs", {"browser": "ALL"})
d = webdriver.Chrome(service=Service(os.environ.get("CHROMEDRIVER", "/app/chromedriver")), options=o)
el = lambda i: d.find_element(By.ID, i)
W = lambda t=0.6: time.sleep(t)

try:
    with open("/tmp/box.stl", "w") as f:
        v = [(x, y, z) for x in (0, 20) for y in (0, 20) for z in (0, 5)]
        tris = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1), (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
        f.write("solid b\n" + "".join(" facet normal 0 0 0\n  outer loop\n" + "".join(f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}\n" for i in t) + "  endloop\n endfacet\n" for t in tris) + "endsolid b\n")
    d.get(f"http://127.0.0.1:9000{PREFIX}/"); W(10)
    check("the page loads under the ingress path", d.execute_script("return window.BICU_BASE") == PREFIX and el("pick-process").is_displayed())
    opts = d.execute_script("return document.querySelectorAll('#pick-process option').length")
    check("its settings and presets load", opts > 0, opts)
    icons = d.execute_script("return [...document.querySelectorAll('use')].slice(0, 3).map(u => u.getAttribute('href'))")
    check("icons point inside the ingress path", icons and all(h.startswith(PREFIX + "/static/") for h in icons), icons)
    d.find_elements(By.CSS_SELECTOR, ".file-input")[0].send_keys("/tmp/box.stl"); W(2)
    d.execute_script("document.getElementById('slice').click()")
    for _ in range(240):
        W(1)
        if "layers" in el("result").text or "msg err" in el("result").get_attribute("innerHTML"):
            break
    check("slicing works through it", "layers" in el("result").text, el("result").text[:90].replace("\n", " "))
    href = d.execute_script("const a = [...document.querySelectorAll('#result a.btn')].find(a => /\\/gcode$/.test(a.getAttribute('href'))); return a && a.getAttribute('href')")
    check("the G-code download link is inside the ingress path", href and href.startswith(PREFIX + "/api/"), href)
    d.execute_script("document.querySelector('[data-view=\"preview\"]').click()"); W(5)
    check("the layer preview loads", el("pv-layers").is_displayed() and "Layer" in el("layer-text").text, el("layer-text").text)
    # a font the server hands back at run time (an absolute URL in its data)
    got = d.execute_async_script("""const done = arguments[arguments.length - 1];
      fetch('/api/fonts').then(r => r.json()).then(list => done(['ok', list.length])).catch(e => done(String(e)));""")
    check("run-time absolute URLs get the ingress path too", isinstance(got, list) and got[0] == "ok", got)
    d.save_screenshot(f"{OUT}/ingress.png")
    check("nothing was requested outside the ingress path", not outside, outside[:10])
    errs = [e for e in d.get_log("browser") if e["level"] == "SEVERE"]
    check("no errors in the browser console", not errs, json.dumps(errs)[:500])
finally:
    d.quit()
    srv.shutdown()
print(f"{sum(r[1] for r in results)}/{len(results)} passed")
