// Presets and settings: the three pickers, the settings editor (Simple / Advanced / Expert, like OrcaSlicer),
// the profile manager (edit / create / rename / delete / import / export) and the first-run setup.
import { $, esc, store, apiJson, postJson, presetUrl, download, saveBlob, toast, ask, confirmBox, api } from "./util.js";

export const TYPES = ["machine", "filament", "process"];
export const TYPE_LABEL = { machine: "Printer", filament: "Filament", process: "Process" };
const MODE_RANK = { simple: 0, advanced: 1, expert: 2, develop: 3 };
const SOURCE_LABEL = { user: "Mine", orca: "OrcaSlicer", system: "System" };

export const S = {
  catalog: null,
  defaults: {},
  mode: store.get("mode") || "simple",
  lists: { machine: [], process: [], filament: [] },
  selected: { machine: null, process: null, filament: null },
  detail: { machine: null, process: null, filament: null },
  edits: { machine: {}, process: {}, filament: {} },   // unsaved changes used for slicing
  state: null,
};
let onChange = () => {};

/* ================================================================ values */

export function valueOf(detail, edits, key) {
  if (edits && key in edits) return edits[key];
  if (detail && key in detail.values) return detail.values[key];
  return S.defaults[key];
}

const scalar = (v) => (Array.isArray(v) ? v[0] : v);
function withScalar(old, v) {
  // vector settings (per extruder) get the same value in every slot
  if (Array.isArray(old)) return old.length ? old.map(() => v) : [v];
  return v;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ================================================================ settings editor */

class Editor {
  // A settings form for one preset type. get() returns {detail, edits}; set(key, value|undefined) records a change.
  constructor(root, type, get, set, opts = {}) {
    Object.assign(this, { root, type, get, set, opts });
    this.page = 0;
    this.query = "";
    root.classList.add("editor");
    root.addEventListener("input", (e) => this.onInput(e, false));
    root.addEventListener("change", (e) => this.onInput(e, true));
    root.addEventListener("click", (e) => this.onClick(e));
  }

  pages() {
    const lay = S.catalog?.layouts?.[this.type] || [];
    const rank = MODE_RANK[S.mode] ?? 0;
    const q = this.query.toLowerCase();
    const out = [];
    for (const p of lay) {
      const groups = [];
      for (const g of p.groups) {
        const opts = g.options.filter((k) => {
          const o = S.catalog.options[k];
          if (!o) return false;
          if (q) return (`${o.label || ""} ${o.full_label || ""} ${k} ${g.title} ${p.page}`).toLowerCase().includes(q);
          return (MODE_RANK[o.mode] ?? 1) <= rank;
        });
        if (opts.length) groups.push({ title: g.title, options: opts });
      }
      if (groups.length) out.push({ page: p.page, groups });
    }
    return out;
  }

  render() {
    if (!S.catalog) {
      this.root.innerHTML = `<p class="muted small">${esc(S.state?.orca?.status === "failed"
        ? "Couldn't download OrcaSlicer's settings list: " + (S.state.orca.error || "") : "Loading OrcaSlicer's settings list…")}</p>`;
      return;
    }
    const { detail } = this.get();
    if (!detail) { this.root.innerHTML = `<p class="muted small">Choose a preset.</p>`; return; }
    const pages = this.pages();
    if (this.page >= pages.length) this.page = 0;
    const shown = this.query ? pages : pages.slice(this.page, this.page + 1);
    const openState = this.openGroups || (this.openGroups = new Set());
    const tabs = this.query ? "" : `<div class="tabs" role="tablist">${pages.map((p, i) =>
      `<button type="button" role="tab" class="tab${i === this.page ? " on" : ""}" data-page="${i}">${esc(p.page)}</button>`).join("")}</div>`;
    const body = shown.map((p) => p.groups.map((g) => {
      const id = `${p.page}/${g.title}`;
      const open = this.query || this.opts.allOpen || !openState.has("closed:" + id);
      return `<details class="group" ${open ? "open" : ""} data-group="${esc(id)}">
        <summary>${this.query ? `<span class="muted">${esc(p.page)} ›</span> ` : ""}${esc(g.title)}</summary>
        ${g.options.map((k) => this.field(k)).join("")}
      </details>`;
    }).join("")).join("");
    const searchVal = esc(this.query);
    this.root.innerHTML = `
      <div class="editor-head">
        <input class="search" type="search" placeholder="Search settings" value="${searchVal}" data-search>
      </div>
      ${tabs}
      <div class="editor-body">${body || `<p class="muted small">${this.query ? "No settings match." : "Nothing to show in this mode."}</p>`}</div>`;
    if (this.focusSearch) {
      const s = this.root.querySelector("[data-search]");
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
      this.focusSearch = false;
    }
  }

  field(key) {
    const o = S.catalog.options[key];
    const { detail, edits } = this.get();
    const v = valueOf(detail, edits, key);
    const unsaved = edits && key in edits;
    const own = !unsaved && detail.own?.includes(key) && detail.inherits;
    const sv = scalar(v);
    const label = esc(o.label || o.full_label || key);
    const unit = o.sidetext ? `<span class="unit">${esc(o.sidetext)}</span>` : "";
    const ro = o.readonly || this.opts.readonly ? "disabled" : "";
    let ctl;
    const id = `f-${this.type}-${key}`;
    switch (o.type) {
      case "bool":
        ctl = `<label class="switch"><input id="${id}" type="checkbox" data-key="${key}" ${sv === "1" || sv === "true" || sv === true ? "checked" : ""} ${ro}><span></span></label>`;
        break;
      case "enum": {
        const vals = o.enum_values || [];
        const labels = o.enum_labels || vals;
        const has = vals.includes(sv);
        ctl = `<select id="${id}" data-key="${key}" ${ro}>${has ? "" : `<option selected>${esc(sv ?? "")}</option>`}${vals.map((x, i) =>
          `<option value="${esc(x)}"${x === sv ? " selected" : ""}>${esc(labels[i] || x)}</option>`).join("")}</select>`;
        break;
      }
      case "int": case "float":
        ctl = `<input id="${id}" type="number" step="any" inputmode="decimal" data-key="${key}" value="${esc(sv ?? "")}" ${o.min != null ? `min="${o.min}"` : ""} ${o.max != null ? `max="${o.max}"` : ""} ${ro}>`;
        break;
      case "percent":
        ctl = `<input id="${id}" type="number" step="any" inputmode="decimal" data-key="${key}" data-percent="1" value="${esc(String(sv ?? "").replace("%", ""))}" ${ro}><span class="unit">%</span>`;
        break;
      case "points":
        ctl = `<input id="${id}" type="text" data-key="${key}" data-points="1" value="${esc((Array.isArray(v) ? v : [v]).join(", "))}" ${ro}>`;
        break;
      case "string":
        ctl = o.multiline
          ? `<textarea id="${id}" data-key="${key}" rows="${Math.min(14, Math.max(3, String(sv ?? "").split("\n").length + 1))}" spellcheck="false" ${ro}>${esc(sv ?? "")}</textarea>`
          : `<input id="${id}" type="text" data-key="${key}" value="${esc(sv ?? "")}" ${ro}>`;
        break;
      default:
        ctl = `<input id="${id}" type="text" data-key="${key}" value="${esc(sv ?? "")}" ${ro}>`;
    }
    const wide = o.type === "string" && o.multiline;
    const help = o.tooltip ? `<button type="button" class="help" data-help="${key}" aria-label="About this setting">?</button>` : "";
    const reset = unsaved ? `<button type="button" class="reset" data-reset="${key}" title="Undo this change" aria-label="Undo this change">↺</button>`
      : own && detail.parent && key in detail.parent && !this.opts.readonly && detail.editable
        ? `<button type="button" class="reset own" data-parent="${key}" title="Use the value from ${esc(detail.inherits)}" aria-label="Use the inherited value">⤺</button>` : "";
    return `<div class="opt${wide ? " wide" : ""}${unsaved ? " unsaved" : own ? " own" : ""}" data-opt="${key}">
      <label for="${id}" class="opt-label">${label}${help}</label>
      <div class="ctl">${ctl}${o.type !== "percent" ? unit : ""}${reset}</div>
      ${o.tooltip ? `<p class="tip-text" hidden>${esc(o.tooltip)}<br><code>${key}</code></p>` : ""}
    </div>`;
  }

  onInput(e, commit) {
    if (e.target.matches("[data-search]")) {
      this.query = e.target.value;
      this.focusSearch = true;
      this.render();
      return;
    }
    const k = e.target.dataset.key;
    if (!k) return;
    if (!commit && e.target.type !== "checkbox" && e.target.tagName !== "SELECT") return;   // text: wait for change
    const o = S.catalog.options[k];
    const { detail, edits } = this.get();
    const old = valueOf(detail, {}, k);
    let v;
    if (e.target.type === "checkbox") v = e.target.checked ? "1" : "0";
    else if (e.target.dataset.percent) v = `${e.target.value}%`;
    else if (e.target.dataset.points) v = e.target.value.split(",").map((x) => x.trim()).filter(Boolean);
    else v = e.target.value;
    if (o.type === "int" || o.type === "float" || e.target.dataset.percent) {
      const n = parseFloat(e.target.value);
      if (Number.isNaN(n) || (o.min != null && n < o.min) || (o.max != null && n > o.max)) {
        e.target.classList.add("bad");
        toast(`${o.label || k}: ${o.min != null ? `min ${o.min}` : ""}${o.max != null ? ` max ${o.max}` : ""}`.trim() || "Not a number", "warn");
        return;
      }
      e.target.classList.remove("bad");
    }
    const nv = o.type === "points" ? v : withScalar(old, v);
    this.set(k, same(nv, old) ? undefined : nv);
    const row = this.root.querySelector(`[data-opt="${k}"]`);
    if (row) row.outerHTML = this.field(k);
  }

  onClick(e) {
    const tab = e.target.closest("[data-page]");
    if (tab) { this.page = Number(tab.dataset.page); this.render(); this.root.querySelector(".editor-body")?.scrollTo?.(0, 0); return; }
    const help = e.target.closest("[data-help]");
    if (help) {
      e.preventDefault();
      const t = this.root.querySelector(`[data-opt="${help.dataset.help}"] .tip-text`);
      if (t) t.hidden = !t.hidden;
      return;
    }
    const r = e.target.closest("[data-reset]");
    if (r) { this.set(r.dataset.reset, undefined); this.refreshField(r.dataset.reset); return; }
    const p = e.target.closest("[data-parent]");
    if (p) {
      const { detail } = this.get();
      this.set(p.dataset.parent, detail.parent[p.dataset.parent]);
      this.refreshField(p.dataset.parent);
      return;
    }
    const sum = e.target.closest("summary");
    if (sum) {
      const d = sum.parentElement;
      const id = "closed:" + d.dataset.group;
      setTimeout(() => { if (d.open) this.openGroups.delete(id); else this.openGroups.add(id); }, 0);
    }
  }

  refreshField(k) {
    const row = this.root.querySelector(`[data-opt="${k}"]`);
    if (row) row.outerHTML = this.field(k);
  }
}

/* ================================================================ main pickers + process editor */

let processEditor = null;

async function loadDetail(t) {
  const name = S.selected[t];
  S.detail[t] = name ? await apiJson(presetUrl(t, name)) : null;
}

export async function refreshLists(keepEdits = false) {
  const q = new URLSearchParams();
  for (const t of TYPES) if (S.selected[t]) q.set(t, S.selected[t]);
  const r = await apiJson(`/api/presets?${q}`);
  S.lists = r.presets;
  const changed = TYPES.filter((t) => S.selected[t] !== r.selected[t]);
  S.selected = r.selected;
  for (const t of TYPES) if (changed.includes(t) && !keepEdits) S.edits[t] = {};
  await Promise.all(TYPES.map(loadDetail));
  renderPickers();
  processEditor?.render();
  remember();
  onChange("presets");
}

function remember() { store.set("selected", S.selected); }

function optionList(rows, chosen) {
  const groups = { user: [], orca: [], system: [] };
  for (const r of rows) (groups[r.source] || groups.system).push(r);
  return Object.entries(groups).filter(([, v]) => v.length).map(([src, v]) =>
    `<optgroup label="${SOURCE_LABEL[src]}">${v.map((r) =>
      `<option value="${esc(r.name)}"${r.name === chosen ? " selected" : ""}>${esc(r.name)}${r.compatible === false ? " (incompatible)" : ""}</option>`).join("")}</optgroup>`).join("");
}

function editsCount(t) { return Object.keys(S.edits[t]).length; }

function renderPickers() {
  for (const t of TYPES) {
    const sel = $(`pick-${t}`);
    sel.innerHTML = S.lists[t].length ? optionList(S.lists[t], S.selected[t]) : `<option value="">No ${TYPE_LABEL[t].toLowerCase()} presets</option>`;
    const n = editsCount(t);
    $(`mod-${t}`).textContent = n ? `${n} unsaved` : "";
    $(`mod-${t}`).hidden = !n;
  }
  const n = editsCount("process");
  $("process-bar").hidden = !n;
  if (n) {
    $("process-bar-text").textContent = `${n} unsaved change${n === 1 ? "" : "s"} · used when you slice`;
    $("process-save").disabled = !S.detail.process?.editable;
  }
}

async function choose(t, name) {
  if (editsCount(t) && !(await confirmBox(`Discard ${editsCount(t)} unsaved ${TYPE_LABEL[t].toLowerCase()} change(s)?`, "Discard"))) {
    renderPickers();
    return;
  }
  S.selected[t] = name;
  S.edits[t] = {};
  if (t === "machine") await refreshLists();
  else { await loadDetail(t); renderPickers(); if (t === "process") processEditor.render(); remember(); onChange("presets"); }
}

async function saveEdits(t, asNew) {
  const d = S.detail[t];
  const values = { ...d.values, ...S.edits[t] };
  let name = d.name, inherits = d.inherits, replace = d.name;
  if (asNew || !d.editable) {
    name = await ask(`Save ${TYPE_LABEL[t].toLowerCase()} preset as`, d.editable ? `${d.name} copy` : `${d.name} (mine)`, "Save");
    if (!name) return;
    inherits = d.editable ? d.inherits : d.name;   // a copy of someone else's preset inherits from it, like OrcaSlicer
    replace = undefined;
  }
  try {
    await postJson(`/api/presets/${t}`, { name, inherits, values, replace });
    toast(`Saved "${name}"`);
    S.selected[t] = name;
    S.edits[t] = {};
    await refreshLists();
  } catch (e) { toast(e.message, "err"); }
}

/* ================================================================ profile manager */

const PM = { type: "machine", name: null, detail: null, edits: {}, editor: null, list: [], filter: "", view: "list" };

async function pmOpen(type = "machine") {
  PM.type = type;
  PM.name = S.selected[type];
  PM.edits = {};
  $("pm").showModal();
  await pmLoadList();
  await pmSelect(PM.name);
}

async function pmLoadList() {
  const q = new URLSearchParams({ all: "1" });
  for (const t of TYPES) if (S.selected[t]) q.set(t, S.selected[t]);
  const r = await apiJson(`/api/presets?${q}`);
  PM.list = r.presets[PM.type];
  pmRenderList();
  for (const b of document.querySelectorAll("#pm [data-pm-type]")) b.classList.toggle("on", b.dataset.pmType === PM.type);
}

function pmRenderList() {
  const f = PM.filter.toLowerCase();
  const rows = PM.list.filter((r) => !f || r.name.toLowerCase().includes(f));
  const bySrc = { user: [], orca: [], system: [] };
  for (const r of rows) (bySrc[r.source] || bySrc.system).push(r);
  $("pm-list").innerHTML = Object.entries(bySrc).filter(([, v]) => v.length).map(([src, v]) =>
    `<li class="pm-head">${SOURCE_LABEL[src]} <span class="muted">${v.length}</span></li>` + v.map((r) =>
      `<li class="pm-item${r.name === PM.name ? " sel" : ""}" data-name="${esc(r.name)}">
        <span class="name">${esc(r.name)}</span>
        ${r.inherits ? `<span class="muted small">from ${esc(r.inherits)}</span>` : ""}
      </li>`).join("")).join("") || `<li class="muted small pm-empty">Nothing here yet.</li>`;
}

async function pmSelect(name) {
  if (Object.keys(PM.edits).length && !(await confirmBox("Discard your unsaved changes to this preset?", "Discard"))) return;
  PM.name = name;
  PM.edits = {};
  PM.detail = name ? await apiJson(presetUrl(PM.type, name)) : null;
  pmRenderList();
  pmRenderDetail();
  document.querySelector("#pm .pm-body").classList.toggle("show-detail", !!name);
}

function pmRenderDetail() {
  const d = PM.detail;
  $("pm-title").textContent = d ? d.name : "";
  $("pm-sub").textContent = d ? `${SOURCE_LABEL[d.source]}${d.vendor ? " · " + d.vendor : ""}${d.inherits ? " · inherits " + d.inherits : ""}` : "";
  const n = Object.keys(PM.edits).length;
  $("pm-save").disabled = !d || !d.editable || !n;
  $("pm-saveas").disabled = !d;
  $("pm-rename").hidden = $("pm-delete").hidden = !d?.editable;
  $("pm-export").disabled = !d;
  $("pm-use").disabled = !d || d.name === S.selected[PM.type];
  $("pm-status").textContent = d && !d.editable ? "Read-only: save a copy to change it." : n ? `${n} unsaved change${n === 1 ? "" : "s"}` : "";
  PM.editor.render();
}

async function pmSave(asNew) {
  const d = PM.detail;
  const values = { ...d.values, ...PM.edits };
  let name = d.name, inherits = d.inherits, replace = d.name;
  if (asNew) {
    name = await ask(`New ${TYPE_LABEL[PM.type].toLowerCase()} preset name`, d.editable ? `${d.name} copy` : `${d.name} (mine)`, "Save");
    if (!name) return;
    inherits = d.editable ? d.inherits : d.name;
    replace = undefined;
  }
  try {
    await postJson(`/api/presets/${PM.type}`, { name, inherits, values, replace });
    toast(`Saved "${name}"`);
    PM.edits = {};
    await pmLoadList();
    await pmSelect(name);
    await refreshLists(true);
  } catch (e) { toast(e.message, "err"); }
}

async function pmNew() {
  const parentList = PM.list;
  const dlg = $("newp");
  $("newp-title").textContent = `New ${TYPE_LABEL[PM.type].toLowerCase()} preset`;
  $("newp-name").value = "";
  $("newp-parent").innerHTML = optionList(parentList, PM.name || S.selected[PM.type]);
  dlg.returnValue = "";
  dlg.showModal();
  $("newp-name").focus();
  await new Promise((r) => dlg.addEventListener("close", r, { once: true }));
  if (dlg.returnValue !== "ok") return;
  const name = $("newp-name").value.trim();
  const parent = $("newp-parent").value;
  if (!name) return;
  try {
    const pd = await apiJson(presetUrl(PM.type, parent));
    // like OrcaSlicer: a new preset inherits from a system/OrcaSlicer preset, or copies one of yours
    const inherits = pd.source === "user" ? pd.inherits : parent;
    await postJson(`/api/presets/${PM.type}`, { name, inherits, values: pd.values });
    toast(`Created "${name}"`);
    await pmLoadList();
    await pmSelect(name);
    await refreshLists(true);
  } catch (e) { toast(e.message, "err"); }
}

async function pmRename() {
  const d = PM.detail;
  const name = await ask("Rename preset", d.name, "Rename");
  if (!name || name === d.name) return;
  try {
    await postJson(`/api/presets/${PM.type}`, { name, inherits: d.inherits, values: { ...d.values, ...PM.edits }, replace: d.name });
    if (S.selected[PM.type] === d.name) S.selected[PM.type] = name;
    PM.edits = {};
    await pmLoadList();
    await pmSelect(name);
    await refreshLists(true);
  } catch (e) { toast(e.message, "err"); }
}

async function pmDelete() {
  const d = PM.detail;
  if (!(await confirmBox(`Delete "${d.name}"? This can't be undone.`, "Delete", true))) return;
  try {
    await api(presetUrl(PM.type, d.name), { method: "DELETE" });
    toast(`Deleted "${d.name}"`);
    PM.edits = {};
    await pmLoadList();
    await pmSelect(null);
    await refreshLists();
  } catch (e) { toast(e.message, "err"); }
}

async function pmImport(files) {
  const fd = new FormData();
  for (const f of files) fd.append("file", f, f.name);
  try {
    const { results } = await apiJson("/api/presets-import", { method: "POST", body: fd });
    const ok = results.filter((r) => r.name && !r.skipped && !r.error);
    const bad = results.filter((r) => r.skipped || r.error);
    toast(`Imported ${ok.length} preset${ok.length === 1 ? "" : "s"}${bad.length ? `; ${bad.length} skipped (${bad.map((b) => b.name || b.file).join(", ")}: ${bad[0].skipped || bad[0].error})` : ""}`, bad.length ? "warn" : "ok");
    await pmLoadList();
    if (ok.length) {
      const first = ok.find((r) => r.type === PM.type) || ok[0];
      if (first.type !== PM.type) { PM.type = first.type; await pmLoadList(); }
      await pmSelect(first.name);
    }
    await refreshLists(true);
  } catch (e) { toast(e.message, "err"); }
}

async function pmExportMine() {
  const all = await apiJson(`/api/presets?all=1&machine=${encodeURIComponent(S.selected.machine || "")}`);
  const mine = TYPES.flatMap((t) => all.presets[t].filter((p) => p.source === "user").map((p) => [t, p.name]));
  if (!mine.length) { toast("You haven't made any presets yet.", "warn"); return; }
  const r = await api("/api/presets-export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: mine }) });
  saveBlob(await r.blob(), "bicuslicer-presets.zip");
}

function wirePM() {
  PM.editor = new Editor($("pm-editor"), "machine", () => ({ detail: PM.detail, edits: PM.edits }), (k, v) => {
    if (v === undefined) delete PM.edits[k]; else PM.edits[k] = v;
    pmRenderDetail();
  });
  for (const b of document.querySelectorAll("#pm [data-pm-type]")) {
    b.addEventListener("click", async () => {
      if (Object.keys(PM.edits).length && !(await confirmBox("Discard your unsaved changes to this preset?", "Discard"))) return;
      PM.edits = {};
      PM.type = b.dataset.pmType;
      PM.editor.type = PM.type;
      PM.editor.page = 0;
      PM.filter = "";
      $("pm-filter").value = "";
      await pmLoadList();
      await pmSelect(S.selected[PM.type]);
    });
  }
  $("pm-filter").addEventListener("input", (e) => { PM.filter = e.target.value; pmRenderList(); });
  $("pm-list").addEventListener("click", (e) => { const li = e.target.closest(".pm-item"); if (li) pmSelect(li.dataset.name); });
  $("pm-back").addEventListener("click", () => document.querySelector("#pm .pm-body").classList.remove("show-detail"));
  $("pm-save").addEventListener("click", () => pmSave(false));
  $("pm-saveas").addEventListener("click", () => pmSave(true));
  $("pm-rename").addEventListener("click", pmRename);
  $("pm-delete").addEventListener("click", pmDelete);
  $("pm-export").addEventListener("click", () => download(`${presetUrl(PM.type, PM.detail.name)}/export`));
  $("pm-use").addEventListener("click", async () => { await choose(PM.type, PM.detail.name); pmRenderDetail(); toast(`Using "${PM.detail.name}"`); });
  $("pm-new").addEventListener("click", pmNew);
  $("pm-import").addEventListener("change", (e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length) pmImport(f); });
  $("pm-export-mine").addEventListener("click", () => pmExportMine().catch((e) => toast(e.message, "err")));
  $("pm-wizard").addEventListener("click", () => { $("pm").close(); openWizard(true); });
  $("pm-close").addEventListener("click", async () => {
    if (Object.keys(PM.edits).length && !(await confirmBox("Close without saving your changes?", "Close"))) return;
    PM.edits = {};
    $("pm").close();
  });
  $("pm").addEventListener("cancel", (e) => { if (Object.keys(PM.edits).length) { e.preventDefault(); $("pm-close").click(); } });
}

/* ================================================================ first-run setup */

const W = { vendors: null, chosen: new Set(), filter: "" };

export async function openWizard(adding = false) {
  W.adding = adding;
  W.chosen = new Set(adding ? S.state?.machines_enabled || [] : []);
  wizStep("intro");
  $("wiz-skip").hidden = !(S.state?.has_orca_presets || S.state?.has_user_presets);
  $("wiz").showModal();
}

function wizStep(step) {
  for (const s of document.querySelectorAll("#wiz [data-step]")) s.hidden = s.dataset.step !== step;
  if (step === "vendor") loadVendors();
}

async function loadVendors() {
  if (S.state?.orca?.status !== "ready") {
    $("wiz-vendors").innerHTML = `<p class="muted">The vendor library is still downloading (${esc(S.state?.orca?.status || "")}). Try again in a minute.</p>`;
    return;
  }
  if (!W.vendors) {
    $("wiz-vendors").innerHTML = `<p class="muted"><span class="spinner"></span>Loading printers…</p>`;
    W.vendors = await apiJson("/api/vendors");
  }
  renderVendors();
}

function renderVendors() {
  const f = W.filter.toLowerCase();
  const html = W.vendors.map((v) => {
    const models = v.models.filter((m) => !f || `${v.name} ${m.model}`.toLowerCase().includes(f));
    if (!models.length) return "";
    const picked = models.reduce((n, m) => n + m.presets.filter((p) => W.chosen.has(p.preset)).length, 0);
    return `<details class="vendor" ${f || picked ? "open" : ""}><summary>${esc(v.name)} <span class="muted small">${models.length} model${models.length === 1 ? "" : "s"}${picked ? ` · ${picked} chosen` : ""}</span></summary>
      ${models.map((m) => `<div class="model"><span class="model-name">${esc(m.model)}</span><span class="nozzles">${m.presets.map((p) =>
        `<label class="chip"><input type="checkbox" data-preset="${esc(p.preset)}" ${W.chosen.has(p.preset) ? "checked" : ""}>${esc(p.nozzle || "?")} mm</label>`).join("")}</span></div>`).join("")}
    </details>`;
  }).join("");
  $("wiz-vendors").innerHTML = html || `<p class="muted">No printers match.</p>`;
  $("wiz-count").textContent = W.chosen.size ? `${W.chosen.size} printer preset${W.chosen.size === 1 ? "" : "s"} chosen` : "";
}

async function wizFinish(body) {
  try {
    const r = await postJson("/api/setup", body);
    S.state = await apiJson("/api/state");
    $("wiz").close();
    if (r.created) S.selected.machine = r.created;
    else if (body.machines?.length && !S.lists.machine.some((m) => m.name === S.selected.machine)) S.selected.machine = body.machines[0];
    await refreshLists();
    toast(r.created ? `Created "${r.created}"` : "Printers saved");
  } catch (e) { toast(e.message, "err"); }
}

function wireWizard() {
  for (const b of document.querySelectorAll("#wiz [data-go]")) b.addEventListener("click", () => wizStep(b.dataset.go));
  $("wiz-skip").addEventListener("click", () => wizFinish({ machines: [], done: true, add: true }));
  $("wiz-filter").addEventListener("input", (e) => { W.filter = e.target.value; renderVendors(); });
  $("wiz-vendors").addEventListener("change", (e) => {
    const p = e.target.dataset.preset;
    if (!p) return;
    if (e.target.checked) W.chosen.add(p); else W.chosen.delete(p);
    $("wiz-count").textContent = W.chosen.size ? `${W.chosen.size} printer preset${W.chosen.size === 1 ? "" : "s"} chosen` : "";
  });
  $("wiz-vendor-done").addEventListener("click", () => wizFinish({ machines: [...W.chosen], done: true }));
  $("wiz-custom-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    wizFinish({ machines: [...(S.state?.machines_enabled || [])], done: true,
      custom: Object.fromEntries(["name", "width", "depth", "height", "nozzle", "flavor"].map((k) => [k, f.get(k)])) });
  });
  $("wiz-close").addEventListener("click", () => $("wiz").close());
}

/* ================================================================ modes, init */

function setMode(m) {
  S.mode = m;
  store.set("mode", m);
  for (const b of document.querySelectorAll("[data-mode]")) b.classList.toggle("on", b.dataset.mode === m);
  processEditor?.render();
  if ($("pm").open) PM.editor.render();
}

async function loadCatalog() {
  for (let i = 0; ; i++) {
    S.state = await apiJson("/api/state");
    if (S.state.orca.status === "ready" || S.state.orca.status === "failed") break;
    processEditor?.render();
    await new Promise((r) => setTimeout(r, Math.min(2000 + i * 1000, 8000)));
  }
  if (S.state.orca.status === "ready") {
    [S.catalog, S.defaults] = await Promise.all([apiJson("/api/catalog"), apiJson("/api/defaults")]);
  }
  processEditor?.render();
  if ($("pm").open) PM.editor.render();
}

export async function initSettings(changeCb) {
  onChange = changeCb;
  processEditor = new Editor($("process-editor"), "process", () => ({ detail: S.detail.process, edits: S.edits.process }), (k, v) => {
    if (v === undefined) delete S.edits.process[k]; else S.edits.process[k] = v;
    renderPickers();
  });
  for (const t of TYPES) {
    $(`pick-${t}`).addEventListener("change", (e) => choose(t, e.target.value));
    $(`edit-${t}`).addEventListener("click", () => pmOpen(t).catch((e) => toast(e.message, "err")));
  }
  $("process-save").addEventListener("click", () => saveEdits("process", false));
  $("process-saveas").addEventListener("click", () => saveEdits("process", true));
  $("process-discard").addEventListener("click", () => { S.edits.process = {}; renderPickers(); processEditor.render(); });
  for (const b of document.querySelectorAll("[data-mode]")) b.addEventListener("click", () => setMode(b.dataset.mode));
  $("open-profiles").addEventListener("click", () => pmOpen(S.selected.machine ? "machine" : "machine").catch((e) => toast(e.message, "err")));
  wirePM();
  wireWizard();
  setMode(S.mode);
  Object.assign(S.selected, store.get("selected") || {});
  processEditor.render();
  const catalog = loadCatalog();
  await refreshLists();
  S.state = S.state || await apiJson("/api/state");
  if (!S.state.setup_done) openWizard(false);
  await catalog;
  if (!S.state.setup_done && !$("wiz").open) openWizard(false);
}

export function machineValues() {
  const d = S.detail.machine;
  return d ? { ...d.values, ...S.edits.machine } : {};
}
