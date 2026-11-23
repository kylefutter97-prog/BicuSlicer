// Small shared helpers for the BicuSlicer page.

export const $ = (id) => document.getElementById(id);

// In Home Assistant's sidebar (ingress) the page is served under a path, which the server puts in window.BICU_BASE
// and adds to the page's own links; URLs the server returns at run time (user fonts, ...) get it here.
export const BASE = window.BICU_BASE || "";
export const withBase = (u) => (BASE && typeof u === "string" && u.startsWith("/") && !u.startsWith(BASE + "/") ? BASE + u : u);
if (BASE) {
  const f = window.fetch.bind(window);
  window.fetch = (u, o) => f(withBase(u), o);
}

// iPhone/iPad: Safari only enables files whose type iOS knows, and iOS has no type for .stl/.3mf (or
// .orca_printer), so an accept=".stl,.3mf" picker greys them out. Let iOS pick any file; the page checks
// the extension itself. (iPadOS reports itself as a Mac, so also look for a touch screen.)
export const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
if (isIOS) {
  for (const input of document.querySelectorAll('input[type="file"][accept]')) {
    input.dataset.accept = input.getAttribute("accept");
    input.removeAttribute("accept");
  }
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem("bicuslicer." + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("bicuslicer." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

export async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(path, opts);
  } catch {
    // An expired proxy sign-in redirects to the login site, which fetch can't follow.
    throw new Error("Couldn't reach the server. If you've been away a while, reload the page (you may need to sign in again).");
  }
  if (r.status === 401 || r.status === 403) throw new Error("Your sign-in has expired. Reload the page to sign in again.");
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return r;
}
export const apiJson = async (path, opts) => (await api(path, opts)).json();
export const postJson = (path, body, method = "POST") =>
  apiJson(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const presetUrl = (type, name) => `/api/presets/${type}/${encodeURIComponent(name)}`;

export function download(url) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let toastTimer = null;
// Open dialogs (showModal) sit in the browser's top layer, above any z-index, so a plain toast would be hidden under
// them. As a popover the toast joins the top layer too, and showing it again puts it above whatever is open now.
// Browsers without popovers keep the old behaviour.
export function toast(text, kind = "ok") {
  const el = $("toast");
  const pop = typeof el.showPopover === "function";
  if (pop && !el.popover) el.popover = "manual";
  el.className = `toast ${kind}`;
  el.textContent = text;
  el.hidden = false;
  if (pop) try { if (el.matches(":popover-open")) el.hidePopover(); el.showPopover(); } catch { /* not connected */ }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
    if (pop) try { el.hidePopover(); } catch { /* already closed */ }
  }, kind === "err" ? 9000 : 4000);
}

// Ask for a line of text in a small dialog (prompt() is ugly and blocked in some webviews).
export function ask(title, value = "", okLabel = "OK") {
  return new Promise((resolve) => {
    const dlg = $("ask");
    $("ask-title").textContent = title;
    const input = $("ask-input");
    input.value = value;
    $("ask-ok").textContent = okLabel;
    dlg.returnValue = "";
    dlg.showModal();
    input.focus();
    input.select();
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok" ? input.value.trim() : null), { once: true });
  });
}

export function confirmBox(text, okLabel = "OK", danger = false) {
  return new Promise((resolve) => {
    const dlg = $("confirm");
    $("confirm-text").textContent = text;
    const ok = $("confirm-ok");
    ok.textContent = okLabel;
    ok.classList.toggle("danger-fill", danger);
    dlg.returnValue = "";
    dlg.showModal();
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
  });
}
