// Physical printer connections (OrcaSlicer's "physical printer" dialog): list, add/edit, test, link to printer presets.
import { $, esc, apiJson, postJson, api, toast, confirmBox } from "./util.js";

let getMachine = () => null;
let machineNames = () => [];
let onStatus = () => {};
let status = { configured: false };
let list = { printers: [], active: null, types: [] };
let editing = null;          // printer being edited (null = new)
const liveStatus = {};       // id -> status for the list

export const printerStatus = () => status;

/* ------------------------------------------------------------ pill */

const fmtTemp = (h) => (h && typeof h.temperature === "number" ? `${Math.round(h.temperature)}°` : "–");

export function describe(st) {
  if (!st.configured) return { cls: "bad", text: "Add a printer" };
  if (!st.online) return { cls: "bad", text: `${st.name}: offline` };
  if (st.printing) return { cls: "busy", text: `${st.name}: ${st.state === "paused" ? "paused" : "printing"} ${Math.round((st.progress || 0) * 100)}%` };
  if (!st.idle) return { cls: "bad", text: `${st.name}: ${st.message || st.state || "not ready"}` };
  return { cls: "ok", text: `${st.name} · ${fmtTemp(st.nozzle)} / ${fmtTemp(st.bed)}` };
}

export async function refreshPrinter() {
  try {
    const m = getMachine();
    status = await apiJson(`/api/printer${m ? `?machine=${encodeURIComponent(m)}` : ""}`);
  } catch (e) {
    status = { configured: true, online: false, message: e.message, name: "Printer" };
  }
  const pill = $("printer");
  const d = describe(status);
  pill.className = `pill ${d.cls}`;
  $("printer-text").textContent = d.text;
  pill.title = status.message || d.text;
  onStatus(status);
}

/* ------------------------------------------------------------ dialog */

async function loadList() {
  list = await apiJson("/api/printers");
  renderList();
  await Promise.all(list.printers.map(async (p) => {
    try { liveStatus[p.id] = await apiJson(`/api/printer?printer=${p.id}`); } catch (e) { liveStatus[p.id] = { online: false, message: e.message }; }
    renderList();
  }));
}

function renderList() {
  const el = $("pr-list");
  if (!list.printers.length) {
    el.innerHTML = `<p class="muted">No printers yet. Add one to send G-code straight to it, like OrcaSlicer's physical printers.</p>`;
    return;
  }
  el.innerHTML = list.printers.map((p) => {
    const st = liveStatus[p.id];
    const d = st ? describe({ ...st, configured: true, name: p.name }) : { cls: "", text: "Checking…" };
    const linked = (p.preset_names || []).length ? `Used for ${p.preset_names.map(esc).join(", ")}` : "Not linked to a printer preset";
    return `<div class="pr-card${p.id === status.id ? " current" : ""}">
      <div class="pr-main">
        <span class="dot ${d.cls}"></span>
        <div class="pr-names"><b>${esc(p.name)}</b><span class="muted small">${esc(p.type_label)} · ${esc(p.print_host)}</span>
        <span class="muted small">${esc(d.text.replace(`${p.name}: `, "").replace(`${p.name} · `, ""))} · ${linked}</span></div>
      </div>
      <div class="pr-actions">
        ${p.webui ? `<a class="btn" href="${esc(p.webui)}" target="_blank" rel="noopener">Web UI</a>` : ""}
        ${p.id !== list.active ? `<button class="btn" data-pr-active="${p.id}" type="button">Make default</button>` : `<span class="muted small default-tag">Default</span>`}
        <button class="btn" data-pr-edit="${p.id}" type="button">Edit</button>
      </div>
    </div>`;
  }).join("");
}

function typeOptions(selected) {
  return list.types.map((t) =>
    `<option value="${t.id}"${t.id === selected ? " selected" : ""}${t.supported ? "" : " disabled"}>${esc(t.label)}${t.supported ? "" : " (not yet)"}</option>`).join("");
}

function showForm(p) {
  editing = p;
  const f = $("pr-form");
  $("pr-form-title").textContent = p ? `Edit ${p.name}` : "Add a printer";
  f.elements.name.value = p?.name || "";
  f.elements.host_type.innerHTML = typeOptions(p?.host_type || "moonraker");
  f.elements.print_host.value = p?.print_host || "";
  f.elements.print_host_webui.value = p?.print_host_webui || "";
  f.elements.printhost_authorization_type.value = p?.printhost_authorization_type || "key";
  f.elements.printhost_apikey.value = "";
  f.elements.printhost_apikey.placeholder = p?.printhost_apikey_set ? "Saved · leave blank to keep" : "Optional";
  f.elements.printhost_user.value = p?.printhost_user || "";
  f.elements.printhost_password.value = "";
  f.elements.printhost_password.placeholder = p?.printhost_password_set ? "Saved · leave blank to keep" : "";
  f.elements.upload_folder.value = p?.upload_folder || "";
  f.elements.verify_tls.checked = p ? p.verify_tls !== false : true;
  const linked = new Set(p?.preset_names || (p ? [] : [getMachine()].filter(Boolean)));
  $("pr-presets").innerHTML = machineNames().map((n) =>
    `<label class="chip"><input type="checkbox" name="preset" value="${esc(n)}" ${linked.has(n) ? "checked" : ""}>${esc(n)}</label>`).join("") ||
    `<span class="muted small">No printer presets yet.</span>`;
  $("pr-delete").hidden = !p;
  $("pr-test-result").textContent = "";
  $("pr-test-result").className = "pr-test muted small";
  syncFormFields();
  $("pr-view-list").hidden = true;
  $("pr-view-form").hidden = false;
  f.elements.name.focus();
}

function syncFormFields() {
  const f = $("pr-form");
  const t = f.elements.host_type.value;
  const digest = t === "prusalink" && f.elements.printhost_authorization_type.value === "user";
  $("pr-auth-row").hidden = t !== "prusalink";
  $("pr-key-row").hidden = digest || t === "duet";
  $("pr-user-row").hidden = !digest;
  $("pr-pass-row").hidden = !(digest || t === "duet");
  $("pr-pass-label").textContent = t === "duet" ? "Board password (if set)" : "Password";
  $("pr-tls-row").hidden = !/^https:/i.test(f.elements.print_host.value.trim());
  const hint = {
    moonraker: "Klipper: the Moonraker address, e.g. 192.168.1.50, http://printer.local or http://192.168.1.50:7125. An API key is only needed if Moonraker doesn't trust this server.",
    octoprint: "OctoPrint, or Klipper through Moonraker's OctoPrint compatibility. The API key is under OctoPrint Settings → Application keys.",
    prusalink: "Prusa MK4 / MINI / XL / Core One: the printer's IP. Use the API key from the printer's menu, or HTTP digest with the username and password it shows.",
    duet: "Duet/RepRapFirmware in standalone mode: the board's IP. Leave the password blank unless you set one with M551.",
  }[t] || "";
  $("pr-hint").textContent = hint;
}

function formBody() {
  const f = $("pr-form");
  return {
    id: editing?.id,
    name: f.elements.name.value.trim(),
    host_type: f.elements.host_type.value,
    print_host: f.elements.print_host.value.trim(),
    print_host_webui: f.elements.print_host_webui.value.trim(),
    printhost_authorization_type: f.elements.printhost_authorization_type.value,
    printhost_apikey: f.elements.printhost_apikey.value,
    printhost_user: f.elements.printhost_user.value.trim(),
    printhost_password: f.elements.printhost_password.value,
    upload_folder: f.elements.upload_folder.value.trim(),
    verify_tls: f.elements.verify_tls.checked,
    preset_names: [...f.querySelectorAll('input[name="preset"]:checked')].map((x) => x.value),
  };
}

async function testForm() {
  const out = $("pr-test-result");
  out.className = "pr-test muted small";
  out.innerHTML = `<span class="spinner"></span>Connecting…`;
  try {
    const r = await postJson("/api/printers/test", formBody());
    out.className = `pr-test small ${r.ok ? "ok" : "err"}`;
    out.textContent = r.ok ? `Connected: ${r.message}${r.state ? ` · ${r.state}` : ""}` : r.message;
  } catch (e) { out.className = "pr-test small err"; out.textContent = e.message; }
}

async function saveForm(e) {
  e.preventDefault();
  try {
    const p = await postJson("/api/printers", formBody());
    toast(`Saved "${p.name}"`);
    backToList();
    await refreshPrinter();
  } catch (err) { toast(err.message, "err"); }
}

function backToList() {
  $("pr-view-form").hidden = true;
  $("pr-view-list").hidden = false;
  loadList().catch((e) => toast(e.message, "err"));
}

export async function openPrinters(addNew = false) {
  $("printers").showModal();
  $("pr-view-form").hidden = true;
  $("pr-view-list").hidden = false;
  await loadList();
  if (addNew || !list.printers.length) showForm(null);
}

export function initPrinters(opts) {
  ({ getMachine, machineNames, onStatus } = { ...{ getMachine, machineNames, onStatus }, ...opts });
  for (const id of ["printer", "open-printers"]) $(id).addEventListener("click", () => openPrinters().catch((e) => toast(e.message, "err")));
  $("pr-close").addEventListener("click", () => $("printers").close());
  $("pr-add").addEventListener("click", () => showForm(null));
  $("pr-cancel").addEventListener("click", backToList);
  $("pr-test").addEventListener("click", testForm);
  $("pr-form").addEventListener("submit", saveForm);
  $("pr-form").addEventListener("input", (e) => { if (["host_type", "printhost_authorization_type", "print_host"].includes(e.target.name)) syncFormFields(); });
  $("pr-form").addEventListener("change", (e) => { if (["host_type", "printhost_authorization_type"].includes(e.target.name)) syncFormFields(); });
  $("pr-delete").addEventListener("click", async () => {
    if (!editing || !(await confirmBox(`Remove the connection to "${editing.name}"?`, "Remove", true))) return;
    try { await api(`/api/printers/${editing.id}`, { method: "DELETE" }); toast(`Removed "${editing.name}"`); backToList(); await refreshPrinter(); }
    catch (e) { toast(e.message, "err"); }
  });
  $("pr-list").addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-pr-edit]");
    if (ed) { showForm(list.printers.find((p) => p.id === ed.dataset.prEdit)); return; }
    const ac = e.target.closest("[data-pr-active]");
    if (ac) {
      await postJson("/api/printers/active", { id: ac.dataset.prActive });
      await loadList();
      await refreshPrinter();
    }
  });
  refreshPrinter();
  setInterval(refreshPrinter, 10000);
}
