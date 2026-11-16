// The printer view, like OrcaSlicer's Device tab: camera, the print's progress, temperatures, fan / speed / flow,
// and pause / resume / cancel. Talks to the printer through BicuSlicer's server (which also relays the camera,
// so it works from a phone, off the printer's network path and behind a login).
import { $, esc, apiJson, postJson, toast, confirmBox, ask } from "./util.js";

let pid = null;
let timer = null;
let last = null;
let snapTimer = null;
let onConnections = () => {};

const fmtDur = (s) => {
  if (s == null || !isFinite(s)) return "–";
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
};
const temp = (h) => (h && typeof h.temperature === "number" ? `${Math.round(h.temperature)}°` : "–");
const target = (h) => (h && h.target ? `→ ${Math.round(h.target)}°` : "off");
const pct = (f) => (typeof f === "number" ? `${Math.round(f * 100)}%` : "–");

function stateText(d) {
  if (!d.online) return ["bad", "Offline"];
  if (d.klippy && d.klippy !== "ready") return ["bad", `Klipper ${d.klippy}`];
  return ({ printing: ["busy", "Printing"], paused: ["warn", "Paused"], complete: ["ok", "Finished"], cancelled: ["", "Cancelled"],
    error: ["bad", "Error"], standby: ["ok", "Ready"] })[d.state] || [d.idle ? "ok" : "", d.state || "Ready"];
}

function render(d) {
  last = d;
  const [cls, text] = stateText(d);
  $("pv-name").textContent = d.name || "Printer";
  const st = $("pv-state");
  st.className = `pv-state ${cls}`;
  st.textContent = text;
  const ui = $("pv-ui");
  ui.hidden = !d.ui;
  if (d.ui) ui.href = d.ui;
  // the job
  const job = !!d.file && ["printing", "paused", "complete", "cancelled", "error"].includes(d.state);
  $("pv-job").hidden = !job;
  if (job) {
    $("pv-file").textContent = d.file.replace(/^.*\//, "").replace(/\.gcode$/i, "");
    const thumb = $("pv-thumb");
    const src = d.has_thumb ? `/api/printers/${pid}/thumb?file=${encodeURIComponent(d.file)}` : "";
    if (thumb.dataset.src !== src) { thumb.dataset.src = src; thumb.src = src; thumb.hidden = !src; }
    const p = Math.max(0, Math.min(1, d.progress || 0));
    $("pv-bar").style.width = `${(p * 100).toFixed(1)}%`;
    $("pv-pct").textContent = `${Math.round(p * 100)}%`;
    const eta = d.remaining != null && d.state === "printing" ? new Date(Date.now() + d.remaining * 1000) : null;
    $("pv-stats").innerHTML = [
      ["Layer", d.layer != null ? `${d.layer}${d.layers ? ` / ${d.layers}` : ""}` : "–"],
      ["Printing for", fmtDur(d.elapsed)],
      ["Left", d.remaining != null ? fmtDur(d.remaining) : "–"],
      ["Done at", eta ? eta.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "–"],
      ["Filament", typeof d.filament_used === "number" ? `${(d.filament_used / 1000).toFixed(2)}${d.filament_total ? ` / ${(d.filament_total / 1000).toFixed(2)}` : ""} m` : "–"],
      ["Z", typeof d.z === "number" ? `${d.z.toFixed(2)} mm` : "–"],
    ].map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("");
  }
  // controls
  const printing = d.state === "printing", paused = d.state === "paused";
  $("pv-pause").hidden = !printing;
  $("pv-resume").hidden = !paused;
  $("pv-cancel").hidden = !(printing || paused);
  $("pv-restart").hidden = !(d.klippy && d.klippy !== "ready");
  $("pv-msg").textContent = d.online ? d.message && d.klippy !== "ready" ? d.message : d.display || "" : d.message || "";
  // temperatures and factors
  $("pv-tiles").innerHTML = [
    ["nozzle", "Nozzle", temp(d.nozzle), target(d.nozzle)],
    ["bed", "Bed", temp(d.bed), target(d.bed)],
    ["fan", "Part fan", pct(d.fan), "tap to set"],
    ["speed", "Speed", pct(d.speed_factor), "tap to set"],
    ["flow", "Flow", pct(d.flow_factor), "tap to set"],
  ].map(([k, label, big, small]) => `<button type="button" class="pv-tile" data-set="${k}" ${d.online ? "" : "disabled"}><span>${label}</span><b>${big}</b><small>${small}</small></button>`).join("");
}

async function poll() {
  if (!pid) return;
  try { render(await apiJson(`/api/printers/${pid}/detail`)); }
  catch (e) { render({ online: false, message: e.message, name: last?.name }); }
}

/* ---- camera: the MJPEG stream through the server, else snapshots every 1.5 s */

async function startCamera() {
  const img = $("pv-img"), msg = $("pv-cam-msg");
  stopCamera();
  let cams = [];
  try { cams = await apiJson(`/api/printers/${pid}/webcams`); } catch { /* none */ }
  const cam = cams[0];
  $("pv-cam").hidden = false;
  if (!cam) { img.hidden = true; msg.textContent = "No camera is set up on this printer."; return; }
  const [w, h] = String(cam.aspect || "4:3").split(":").map(Number);
  $("pv-cam").style.aspectRatio = w && h ? `${w} / ${h}` : "4 / 3";
  img.style.transform = `rotate(${cam.rotation || 0}deg) scale(${cam.flip_h ? -1 : 1}, ${cam.flip_v ? -1 : 1})`;
  msg.textContent = "";
  img.hidden = false;
  const snapshots = () => {
    if (!cam.snapshot) { fail(); return; }
    img.onerror = fail;
    img.onload = () => { msg.textContent = ""; if (snapTimer !== null) snapTimer = setTimeout(next, 1500); };
    snapTimer = 0;
    const next = () => { if (snapTimer !== null) img.src = `/api/printers/${pid}/webcam/${cam.index}/snapshot?t=${Date.now()}`; };
    next();
  };
  const fail = () => {
    stopCamera();
    img.hidden = true;
    msg.textContent = "The camera isn't answering: its service on the printer (e.g. crowsnest) may be stopped, or the camera unplugged.";
  };
  if (cam.stream && /mjpeg/i.test(cam.service)) {
    img.onerror = snapshots;
    img.onload = null;
    img.src = `/api/printers/${pid}/webcam/${cam.index}/stream?t=${Date.now()}`;
  } else snapshots();
}

function stopCamera() {
  clearTimeout(snapTimer);
  snapTimer = null;
  const img = $("pv-img");
  img.onerror = img.onload = null;
  img.removeAttribute("src");        // closes the MJPEG stream
}

/* ---- actions */

async function act(action, value) {
  try {
    await postJson(`/api/printers/${pid}/action`, value === undefined ? { action } : { action, value });
    setTimeout(poll, 400);
  } catch (e) { toast(e.message, "err"); }
}

const SETTERS = {
  nozzle: ["Nozzle temperature (°C, 0 = off)", (d) => d.nozzle?.target ?? 0],
  bed: ["Bed temperature (°C, 0 = off)", (d) => d.bed?.target ?? 0],
  fan: ["Part cooling fan (%)", (d) => Math.round((d.fan ?? 0) * 100)],
  speed: ["Speed (%)", (d) => Math.round((d.speed_factor ?? 1) * 100)],
  flow: ["Flow (%)", (d) => Math.round((d.flow_factor ?? 1) * 100)],
};

export async function openPrinterView(id) {
  if (!id) { onConnections(); return; }
  pid = id;
  last = null;
  $("pv-job").hidden = true;
  $("pv-tiles").innerHTML = "";
  $("pv-name").textContent = "Printer";
  $("pv-state").textContent = "…";
  $("pv").showModal();
  await poll();
  startCamera();
  clearInterval(timer);
  timer = setInterval(poll, 2000);
}

export function initPrinterView(opts = {}) {
  onConnections = opts.onConnections || onConnections;
  const dlg = $("pv");
  dlg.addEventListener("close", () => { clearInterval(timer); timer = null; stopCamera(); pid = null; });
  $("pv-close").addEventListener("click", () => dlg.close());
  $("pv-conn").addEventListener("click", () => { dlg.close(); onConnections(); });
  $("pv-pause").addEventListener("click", () => act("pause"));
  $("pv-resume").addEventListener("click", () => act("resume"));
  $("pv-cancel").addEventListener("click", async () => {
    if (await confirmBox(`Cancel the print on ${last?.name || "the printer"}? It can't be resumed.`, "Cancel print", true)) act("cancel");
  });
  $("pv-home").addEventListener("click", async () => {
    if (await confirmBox("Home all axes? Make sure nothing is in the way.", "Home")) act("home");
  });
  $("pv-estop").addEventListener("click", async () => {
    if (await confirmBox("Emergency stop: halt the printer immediately (heaters and motors off)? It needs a firmware restart afterwards.", "Emergency stop", true)) act("estop");
  });
  $("pv-restart").addEventListener("click", () => act("restart"));
  $("pv-tiles").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-set]");
    if (!b || !last) return;
    const [title, cur] = SETTERS[b.dataset.set];
    const v = await ask(title, String(cur(last)), "Set");
    if (v === null || v === "") return;
    const n = parseFloat(v);
    if (!isFinite(n)) { toast("Enter a number", "err"); return; }
    act(b.dataset.set, n);
  });
}
