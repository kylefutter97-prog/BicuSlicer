import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { zipSync, strToU8 } from "three/addons/libs/fflate.module.js";
import { $, esc, apiJson, confirmBox } from "./util.js";
import { initSettings, S, machineValues, createPartEditor, pickPartSetting, processValue, partOptionsAvailable } from "./settings.js";
import { Preview } from "./preview.js";
import { initPrinters, printerStatus, refreshPrinter, openPrinters } from "./printers.js";

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const DOWN = new THREE.Vector3(0, 0, -1);
const GAP = 6;          // mm between parts when arranging
const MAX_COPIES = 50;

let currentJob = null;
// Every change to the plate or the slicing settings bumps this; a slice remembers the version it was made
// from, and a result whose version no longer matches can't be sent or printed until the plate is sliced again.
let plateVersion = 0;
let currentJobVersion = -1;
const jobIsCurrent = () => currentJobVersion === plateVersion;

/* ================================================================ scene */

const bed = { w: 220, d: 220, h: 300 };
const models = [];          // {id, name, geo, quat, scale, meshes: [Mesh], box}
let selected = null;
let pickMode = false;
let nextId = 1;

const view = {};

function initViewer() {
  const el = $("viewer");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x60606a, 2.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(0.6, -1.2, 2);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(35, 1, 1, 10000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.62;   // allow a peek under the bed edge, not a full flip
  const mats = {
    normal: new THREE.MeshStandardMaterial({ color: css("--model-dim"), roughness: 0.65, metalness: 0.05 }),
    selected: new THREE.MeshStandardMaterial({ color: css("--model"), roughness: 0.55, metalness: 0.05 }),
    bad: new THREE.MeshStandardMaterial({ color: css("--bad"), roughness: 0.6, metalness: 0.05 }),
  };
  Object.assign(view, { el, renderer, scene, camera, controls, mats, bedGroup: null, raycaster: new THREE.Raycaster() });
  new ResizeObserver(resize).observe(el);
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  wirePointer();
  view.preview = new Preview(scene);
  resize();
}

function resize() {
  const w = view.el.clientWidth, h = view.el.clientHeight;
  if (!w || !h) return;
  view.renderer.setSize(w, h, false);
  view.camera.aspect = w / h;
  view.camera.updateProjectionMatrix();
}

function setBed() {
  const v = machineValues();
  const pts = (v.printable_area || []).map((p) => String(p).split("x").map(Number));
  if (pts.length >= 3 && pts.every((p) => p.length === 2 && p.every(Number.isFinite))) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    bed.w = Math.max(...xs) - Math.min(...xs);
    bed.d = Math.max(...ys) - Math.min(...ys);
  }
  bed.h = parseFloat(v.printable_height) || 300;
  drawBed();
  if (models.length) { if (!layoutOk().fits) arrange(); else refresh(); }
}

function drawBed() {
  if (!view.scene) return;
  if (view.bedGroup) view.scene.remove(view.bedGroup);
  const g = new THREE.Group();
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(bed.w, bed.d),
    new THREE.MeshBasicMaterial({ color: css("--bed"), transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
  plate.position.set(bed.w / 2, bed.d / 2, -0.05);
  plate.userData.bed = true;
  g.add(plate);
  const size = Math.max(bed.w, bed.d);
  const grid = new THREE.GridHelper(size, Math.round(size / 10), css("--muted"), css("--muted"));
  grid.rotation.x = Math.PI / 2;
  grid.position.set(bed.w / 2, bed.d / 2, 0);
  grid.material.transparent = true; grid.material.opacity = 0.25;
  g.add(grid);
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(bed.w, bed.d, 0.01)),
    new THREE.LineBasicMaterial({ color: css("--muted") }));
  edge.position.set(bed.w / 2, bed.d / 2, 0);
  g.add(edge);
  view.bedGroup = g;
  view.scene.add(g);
}

function fitView() {
  const r = Math.hypot(bed.w, bed.d) * 0.85;
  let top = 0;
  for (const m of models) top = Math.max(top, (m.box?.max.z ?? 0));
  view.camera.position.set(bed.w / 2 + r * 0.35, bed.d / 2 - r * 1.15, r * 0.95 + top * 0.6);
  view.controls.target.set(bed.w / 2, bed.d / 2, Math.min(top / 3, 40));
  view.controls.update();
}

/* ---------------------------------------------------------------- loading */

function mergeToGeometry(obj) {
  // Flatten whatever the loader produced into one non-indexed geometry (positions only).
  obj.updateMatrixWorld(true);
  const parts = [];
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    g = new THREE.BufferGeometry().setAttribute("position", g.getAttribute("position").clone());
    g.applyMatrix4(o.matrixWorld);
    parts.push(g.getAttribute("position").array);
  });
  if (!parts.length) throw new Error("no mesh found in the file");
  const total = parts.reduce((n, a) => n + a.length, 0);
  const pos = new Float32Array(total);
  let off = 0;
  for (const a of parts) { pos.set(a, off); off += a.length; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.computeBoundingBox();
  const c = geo.boundingBox.getCenter(new THREE.Vector3());
  geo.translate(-c.x, -c.y, -c.z);       // rotate about the part's own centre
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

async function parseFile(f) {
  const ext = f.name.split(".").pop().toLowerCase();
  if (ext === "stl") return mergeToGeometry(new THREE.Mesh(new STLLoader().parse(await f.arrayBuffer())));
  if (ext === "obj") return mergeToGeometry(new OBJLoader().parse(await f.text()));
  if (ext === "3mf") return mergeToGeometry(new ThreeMFLoader().parse(await f.arrayBuffer()));
  if (ext === "step" || ext === "stp") throw new Error("STEP files can't be sliced here. Export it as STL or 3MF (SolidCraft can) and add that");
  throw new Error("use an STL, 3MF or OBJ file");
}

async function addFiles(files) {
  if (!files.length) return;
  if (!view.renderer) initViewer();
  const problems = [], added = [];
  const ok = /\.(stl|3mf|obj)$/i;
  for (const f of files.filter((x) => !ok.test(x.name))) problems.push(`${f.name}: use an STL, 3MF or OBJ file`);
  files = files.filter((x) => ok.test(x.name));
  for (const f of files) {
    busy(`Loading ${f.name}…`);
    try {
      const geo = await parseFile(f);
      const m = { id: nextId++, name: f.name.replace(/\.[^.]+$/, ""), geo, quat: new THREE.Quaternion(), scale: 1, meshes: [], box: null, overrides: {} };
      models.push(m);
      setCopies(m, 1);
      updateBox(m);
      added.push(...m.meshes);
      selected = m;
    } catch (e) {
      problems.push(`${f.name}: ${e.message}`);
    }
  }
  busy(null);
  settle(added);
  fitView();
  if (problems.length) flash(problems.join(" · "), "err");
}

/* ---------------------------------------------------------------- model maths */

function updateBox(m) {
  // Exact bounding box of the part as rotated and scaled (iterates the vertices once).
  const mat = new THREE.Matrix4().compose(new THREE.Vector3(), m.quat, new THREE.Vector3(m.scale, m.scale, m.scale));
  const e = mat.elements, p = m.geo.getAttribute("position").array;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const X = e[0] * x + e[4] * y + e[8] * z, Y = e[1] * x + e[5] * y + e[9] * z, Z = e[2] * x + e[6] * y + e[10] * z;
    if (X < x0) x0 = X; if (X > x1) x1 = X;
    if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
  }
  m.local = { x0, y0, z0, x1, y1, z1 };     // relative to the part's centre
  m.size = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0);
  for (const mesh of m.meshes) applyPose(m, mesh);
}

function applyPose(m, mesh) {
  mesh.quaternion.copy(m.quat);
  mesh.scale.setScalar(m.scale);
  mesh.position.z = -m.local.z0;            // sit on the bed
}

function setCopies(m, n) {
  n = Math.max(1, Math.min(MAX_COPIES, n));
  while (m.meshes.length > n) view.scene.remove(m.meshes.pop());
  while (m.meshes.length < n) {
    const mesh = new THREE.Mesh(m.geo, view.mats.normal);
    mesh.userData.model = m;
    const src = m.meshes[m.meshes.length - 1];
    if (src) mesh.position.copy(src.position);
    else mesh.position.set(bed.w / 2, bed.d / 2, 0);
    if (m.local) applyPose(m, mesh);
    m.meshes.push(mesh);
    view.scene.add(mesh);
  }
}

function footprint(m, mesh) {
  return { x0: mesh.position.x + m.local.x0, x1: mesh.position.x + m.local.x1, y0: mesh.position.y + m.local.y0, y1: mesh.position.y + m.local.y1 };
}

function layoutOk() {
  const all = [];
  for (const m of models) for (const mesh of m.meshes) all.push({ m, mesh, f: footprint(m, mesh) });
  const off = new Set(), tall = new Set();
  let overlap = false;
  for (const a of all) {
    if (a.f.x0 < -0.5 || a.f.y0 < -0.5 || a.f.x1 > bed.w + 0.5 || a.f.y1 > bed.d + 0.5) off.add(a.m);
    if (a.m.size.z > bed.h + 0.01) tall.add(a.m);
  }
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i].f, b = all[j].f;
    if (a.x0 < b.x1 - 0.2 && b.x0 < a.x1 - 0.2 && a.y0 < b.y1 - 0.2 && b.y0 < a.y1 - 0.2) overlap = true;
  }
  return { fits: off.size === 0 && tall.size === 0, off, tall, overlap };
}

function overlapsOthers(mesh) {
  const m = mesh.userData.model, a = footprint(m, mesh);
  for (const o of models) for (const other of o.meshes) {
    if (other === mesh) continue;
    const b = footprint(o, other);
    if (a.x0 < b.x1 - 0.2 && b.x0 < a.x1 - 0.2 && a.y0 < b.y1 - 0.2 && b.y0 < a.y1 - 0.2) return true;
  }
  return false;
}

// Keep the user's placement; only re-arrange when the given parts don't fit or land on top of something.
/* ---------------------------------------------------------------- layer preview */

let viewMode = "model";
let previewKey = null;          // "<job>/<plate>" currently loaded

function setViewMode(mode) {
  if (mode === "preview" && !view.preview?.loaded) mode = "model";
  viewMode = mode;
  for (const m of models) for (const mesh of m.meshes) mesh.visible = mode === "model";
  view.preview?.setVisible(mode === "preview");
  for (const b of document.querySelectorAll("[data-view]")) b.classList.toggle("on", b.dataset.view === mode);
  $("pv-layers").hidden = $("legend").hidden = mode !== "preview";
  $("layer-text").hidden = mode !== "preview";
  if (mode === "preview") setPickMode(false);
  $("tip").textContent = mode === "preview"
    ? "Drag to turn the view · pinch or scroll to zoom · slide to step through the layers"
    : "Drag a part to move it · drag empty space to turn the view · pinch or scroll to zoom";
}

function plateChanged() {
  // the plate or settings no longer match the last slice
  plateVersion++;
  if (currentJob?.status === "done") renderJob(currentJob);
  if (!view.preview?.loaded) return;
  $("preview-stale").hidden = false;
  if (viewMode === "preview") setViewMode("model");
}

function renderLayerInfo() {
  const p = view.preview;
  if (!p.loaded) return;
  $("layer").max = p.layers;
  $("layer").value = p.layer + 1;
  $("layer-text").textContent = `Layer ${p.layer + 1} of ${p.layers} · Z ${p.data.z[p.layer].toFixed(2)} mm`;
}

function renderLegend() {
  $("legend").innerHTML = view.preview.legend().map((f) =>
    `<label class="lg${f.visible ? "" : " off"}"><input type="checkbox" data-feat="${f.i}" ${f.visible ? "checked" : ""}><span class="sw" style="background:${esc(f.color)}"></span>${esc(f.name)}</label>`).join("");
}

async function showPreview(job, plate) {
  const key = `${job.id}/${plate}`;
  try {
    if (previewKey !== key) {
      busy("Loading layer preview…");
      view.preview.clear();
      previewKey = null;
      await view.preview.load(`/api/jobs/${job.id}/plates/${plate}/preview`);
      previewKey = key;
      $("show-travel").checked = view.preview.showTravel;
      renderLegend();
    }
    $("preview-stale").hidden = true;
    $("preview-controls").hidden = false;
    renderLayerInfo();
    setViewMode("preview");
  } catch (e) {
    flash(e.message, "err");
  } finally {
    busy(null);
  }
}

function settle(newMeshes = []) {
  plateChanged();
  if (!layoutOk().fits || newMeshes.some(overlapsOthers)) arrange();
  else refresh();
}

function arrange() {
  plateChanged();
  // Shelf packing: tallest-footprint parts first, rows left→right, then centre the block on the bed.
  const items = [];
  for (const m of models) for (const mesh of m.meshes) items.push({ m, mesh, w: m.size.x, d: m.size.y });
  items.sort((a, b) => b.d - a.d || b.w - a.w);
  let x = 0, y = 0, rowD = 0, maxX = 0;
  for (const it of items) {
    if (x > 0 && x + it.w > bed.w) { y += rowD + GAP; x = 0; rowD = 0; }
    it.px = x; it.py = y;
    x += it.w + GAP; rowD = Math.max(rowD, it.d); maxX = Math.max(maxX, x - GAP);
  }
  const totalD = y + rowD;
  const ox = Math.max(0, (bed.w - maxX) / 2), oy = Math.max(0, (bed.d - totalD) / 2);
  for (const it of items) {
    it.mesh.position.x = ox + it.px - it.m.local.x0;
    it.mesh.position.y = oy + it.py - it.m.local.y0;
  }
  refresh();
}

/* ---------------------------------------------------------------- orientation */

function rotateModel(m, q) {
  m.quat.premultiply(q).normalize();
  updateBox(m);
  settle(m.meshes);
}

function layFace(m, worldNormal) {
  rotateModel(m, new THREE.Quaternion().setFromUnitVectors(worldNormal.clone().normalize(), DOWN));
}

function stlOf(m, withScale = false) {
  // Binary STL of the part as currently rotated (and optionally scaled), centred on its origin.
  const p = m.geo.getAttribute("position").array;
  const tris = p.length / 9;
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris, true);
  const mat = new THREE.Matrix4().compose(new THREE.Vector3(), m.quat, new THREE.Vector3().setScalar(withScale ? m.scale : 1));
  const e = mat.elements;
  let o = 84;
  for (let i = 0; i < p.length; i += 9) {
    o += 12;     // zero normal: slicers recompute it
    for (let k = 0; k < 9; k += 3) {
      const x = p[i + k], y = p[i + k + 1], z = p[i + k + 2];
      dv.setFloat32(o, e[0] * x + e[4] * y + e[8] * z, true);
      dv.setFloat32(o + 4, e[1] * x + e[5] * y + e[9] * z, true);
      dv.setFloat32(o + 8, e[2] * x + e[6] * y + e[10] * z, true);
      o += 12;
    }
    o += 2;
  }
  return new Blob([buf], { type: "model/stl" });
}

async function autoOrient(m) {
  busy(`Auto-orienting ${m.name}…`);
  try {
    const fd = new FormData();
    fd.append("model", stlOf(m), "part.stl");
    const { down } = await apiJson("/api/orient", { method: "POST", body: fd });
    const d = new THREE.Vector3(...down);
    const q = new THREE.Quaternion().setFromUnitVectors(d, DOWN);
    const deg = Math.round(THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, Math.abs(q.w)))));
    if (deg < 1) flash(`${m.name} is already in the best orientation.`, "ok");
    else { rotateModel(m, q); flash(`Auto-orient turned ${m.name} by ${deg}°. Check it in the view, or tap Reset to undo.`, "ok"); }
    focusModel(m);
  } catch (e) {
    flash(e.message, "err");
  } finally {
    busy(null);
  }
}

function focusModel(m) {
  const mesh = m.meshes[0];
  const r = Math.max(m.size.length(), 40);
  const t = new THREE.Vector3(mesh.position.x, mesh.position.y, m.size.z / 2);
  view.controls.target.copy(t);
  view.camera.position.set(t.x + r * 0.6, t.y - r * 1.4, t.z + r * 0.9);
  view.controls.update();
}

/* ---------------------------------------------------------------- pointer */

const BED_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function rayFrom(e) {
  const r = view.renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  view.raycaster.setFromCamera(ndc, view.camera);
  return view.raycaster;
}
const hitPart = (e) => rayFrom(e).intersectObjects(models.flatMap((m) => m.meshes), false)[0];
const bedPoint = (e) => rayFrom(e).ray.intersectPlane(BED_PLANE, new THREE.Vector3());

function wirePointer() {
  // One finger / left button on a part drags it across the bed; anywhere else turns the view
  // (two fingers zoom and pan). A short tap selects. Pick-face mode never drags.
  const el = view.renderer.domElement;
  let down = null, drag = null;
  const pointers = new Set();

  el.addEventListener("pointerdown", (e) => {
    pointers.add(e.pointerId);
    if (viewMode === "preview") { down = null; return; }   // layers view: the pointer only turns the view
    if (pointers.size > 1) {                  // second finger: hand over to zoom/pan
      if (drag) endDrag();
      down = null;
      return;
    }
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (pickMode || e.button > 0) return;
    const hit = hitPart(e);
    const p = hit && bedPoint(e);
    if (!hit || !p) return;
    const mesh = hit.object;
    drag = { mesh, offset: new THREE.Vector2(p.x - mesh.position.x, p.y - mesh.position.y), moved: false };
    view.controls.enabled = false;            // runs before OrbitControls sees this pointerdown (capture phase)
    el.setPointerCapture(e.pointerId);
    if (selected !== mesh.userData.model) { selected = mesh.userData.model; refresh(); }
  }, { capture: true });

  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.moved && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) return;
    const p = bedPoint(e);
    if (!p) return;
    drag.moved = true;
    view.el.classList.add("dragging");
    drag.mesh.position.x = p.x - drag.offset.x;
    drag.mesh.position.y = p.y - drag.offset.y;
  });

  function endDrag() {
    const wasMoved = drag?.moved;
    drag = null;
    view.controls.enabled = true;
    view.el.classList.remove("dragging");
    if (wasMoved) { plateChanged(); refresh(); }
    return wasMoved;
  }

  const finish = (e) => {
    pointers.delete(e.pointerId);
    if (drag && endDrag()) { down = null; return; }   // a drag, not a tap
    if (!down || e.type === "pointercancel") { down = null; return; }
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 450;
    down = null;
    if (moved > 8 || !quick) return;          // that was an orbit/zoom, not a tap
    onTap(e);
  };
  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", finish);

  function onTap(e) {
    const hit = hitPart(e);
    if (pickMode) {
      if (hit && hit.object.userData.model === selected && hit.face) {
        const n = hit.face.normal.clone().applyQuaternion(selected.quat);
        setPickMode(false);
        layFace(selected, n);
        flash(`That face is now on the bed.`, "ok");
      } else if (hit) {
        flash("Tap a face of the highlighted part.", "warn");
      }
      return;
    }
    selected = hit ? hit.object.userData.model : null;
    refresh();
  }
}

function setPickMode(on) {
  pickMode = on && !!selected;
  $("lay-face").classList.toggle("on", pickMode);
  $("lay-face").textContent = pickMode ? "Cancel" : "Pick face down";
  const hint = $("hint");
  hint.hidden = !pickMode;
  hint.textContent = "Tap the face that should sit on the bed. Drag to turn the view.";
}

/* ---------------------------------------------------------------- ui */

let flashTimer = null;
function flash(text, kind = "warn") {
  // Short-lived notes (orientation results, load errors); layout warnings live in #plate-msg.
  const el = $("plate-flash");
  el.className = `msg ${kind}`;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, kind === "err" ? 12000 : 6000);
}

function busy(text) {
  $("busy").hidden = !text;
  $("busy-text").textContent = text || "";
}

const fmtMm = (v) => v.toFixed(v < 100 ? 1 : 0);

function refresh() {
  const has = models.length > 0;
  $("empty").hidden = has;
  $("plate-tools").hidden = !has;
  $("tip").hidden = !has;
  $("parts-card").hidden = !has;
  if (!models.includes(selected)) selected = null;
  if (!selected) setPickMode(false);
  const ok = layoutOk();
  for (const m of models) for (const mesh of m.meshes) {
    mesh.material = ok.off.has(m) || ok.tall.has(m) ? view.mats.bad : m === selected ? view.mats.selected : view.mats.normal;
  }
  const parts = models.reduce((n, m) => n + m.meshes.length, 0);
  $("plate-summary").textContent = has ? `${parts} part${parts === 1 ? "" : "s"}` : "";
  $("objects").innerHTML = models.map((m) => `
    <li class="${m === selected ? "sel" : ""}${ok.off.has(m) || ok.tall.has(m) ? " bad" : ""}" data-id="${m.id}">
      <span class="name">${esc(m.name)}</span>
      <span class="muted small">${Object.keys(m.overrides).length ? `<span class="part-badge" title="Has its own settings">⚙ ${Object.keys(m.overrides).length}</span> ` : ""}${m.meshes.length > 1 ? `×${m.meshes.length} · ` : ""}${fmtMm(m.size.x)}×${fmtMm(m.size.y)}×${fmtMm(m.size.z)}</span>
    </li>`).join("");
  const panel = $("obj-panel");
  panel.hidden = !selected;
  if (selected) {
    $("obj-name").textContent = selected.name;
    $("obj-size").textContent = `${fmtMm(selected.size.x)} × ${fmtMm(selected.size.y)} × ${fmtMm(selected.size.z)} mm`;
    if (document.activeElement !== $("obj-scale")) $("obj-scale").value = Math.round(selected.scale * 1000) / 10;
    $("copy-count").textContent = selected.meshes.length;
    if (partEditor.model !== selected) { partEditor.model = selected; partEditor.render(); }
    const n = Object.keys(selected.overrides).length;
    $("part-count").textContent = n ? `· ${n}` : "";
    $("part-add").disabled = !partOptionsAvailable();
  }
  let warn = "";
  if (ok.tall.size) warn = `Too tall for this printer (max ${bed.h} mm): ${[...ok.tall].map((m) => m.name).join(", ")}.`;
  else if (ok.off.size) warn = `Doesn't fit on the bed: ${[...ok.off].map((m) => m.name).join(", ")}. Try Arrange, fewer copies, a smaller scale or another orientation.`;
  else if (ok.overlap) warn = "Some parts overlap. Tap Arrange to space them out.";
  const msg = $("plate-msg");
  msg.textContent = warn;
  msg.hidden = !warn;
  $("slice").disabled = !has || !ok.fits;
}

/* ================================================================ slicing */

function build3mf() {
  // One 3MF object per placed part, vertices baked in bed coordinates (what the slicer sees is what's on screen).
  const objects = [], items = [], configs = [];
  let id = 1;
  for (const m of models) {
    const p = m.geo.getAttribute("position").array;
    // shared vertices (the loaders give triangle soup; identical corners become one vertex)
    const index = new Map(), uniq = [], tris = new Uint32Array(p.length / 3);
    for (let i = 0; i < p.length; i += 3) {
      const key = p[i] + "," + p[i + 1] + "," + p[i + 2];
      let v = index.get(key);
      if (v === undefined) { v = uniq.length / 3; index.set(key, v); uniq.push(p[i], p[i + 1], p[i + 2]); }
      tris[i / 3] = v;
    }
    for (const mesh of m.meshes) {
      mesh.updateMatrixWorld(true);
      const e = mesh.matrixWorld.elements;
      const vx = [];
      for (let i = 0; i < uniq.length; i += 3) {
        const x = uniq[i], y = uniq[i + 1], z = uniq[i + 2];
        vx.push(`<vertex x="${(e[0] * x + e[4] * y + e[8] * z + e[12]).toFixed(4)}" y="${(e[1] * x + e[5] * y + e[9] * z + e[13]).toFixed(4)}" z="${(e[2] * x + e[6] * y + e[10] * z + e[14]).toFixed(4)}"/>`);
      }
      const tx = [];
      for (let t = 0; t < tris.length; t += 3) {
        const a = tris[t], b = tris[t + 1], c = tris[t + 2];
        if (a !== b && b !== c && a !== c) tx.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
      }
      objects.push(`<object id="${id}" type="model" name="${esc(m.name)}"><mesh><vertices>${vx.join("")}</vertices><triangles>${tx.join("")}</triangles></mesh></object>`);
      // per-part settings: OrcaSlicer reads them from Metadata/model_settings.config, keyed by object id
      configs.push(`  <object id="${id}">\n    <metadata key="name" value="${esc(m.name)}"/>\n${Object.entries(m.overrides).map(([k, v]) =>
        `    <metadata key="${esc(k)}" value="${esc(Array.isArray(v) ? v.join(",") : v)}"/>\n`).join("")}  </object>`);
      items.push(`<item objectid="${id}"/>`);
      id++;
    }
  }
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects.join("")}</resources><build>${items.join("")}</build></model>`;
  const zip = zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    "3D/3dmodel.model": strToU8(model),
    "Metadata/model_settings.config": strToU8(`<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${configs.join("\n")}\n</config>\n`),
  }, { level: 6 });
  return new Blob([zip], { type: "model/3mf" });
}

function plateName() {
  if (models.length === 1) return models[0].name + (models[0].meshes.length > 1 ? ` x${models[0].meshes.length}` : "");
  return `${models[0].name} +${models.length - 1}`;
}

function fmtTime(s) {
  if (s == null) return "–";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function printerUrl() {
  return printerStatus().ui || "";
}

function renderJob(job) {
  const out = $("result");
  $("result-card").hidden = false;
  if (job.status === "queued" || job.status === "slicing") {
    out.innerHTML = `<p><span class="spinner"></span>${job.status === "queued" ? esc(job.note || "Queued…") : "Slicing… this can take a minute"}</p>`;
    return;
  }
  if (job.status === "error") { out.innerHTML = `<p class="msg err">${esc(job.error)}</p>`; return; }
  if (!jobIsCurrent()) {
    const anySent = job.plates.some((p) => p.uploaded && !p.started);
    out.innerHTML = `<p class="msg warn">The plate or settings changed after this slice, so it can't be sent or printed.${anySent
      ? " The copy already on the printer is out of date too: don't start it." : ""}</p>
      <div class="stats stale-stats">${job.plates.map((p) => `<div class="stat"><b>${fmtTime(p.time_s)}</b><span>${job.plates.length > 1 ? `plate ${p.plate}` : "previous slice"}</span></div>`).join("")}</div>
      <div class="actions"><button class="primary" data-act="reslice" type="button">Slice again</button></div>`;
    return;
  }
  const warn = (job.warnings || []).filter(Boolean).map((w) => `<p class="msg warn">${esc(w)}</p>`).join("");
  out.innerHTML = warn + job.plates.map((p) => {
    const title = job.plates.length > 1 ? `<h3>Plate ${p.plate}</h3>` : "";
    const pr = printerStatus();
    const sent = p.uploaded ? `<p class="msg ok">On ${esc(p.uploaded_name || "the printer")} as <b>${esc(p.uploaded)}</b>${p.started ? " · print started" : ""}</p>` : "";
    let action;
    if (!p.uploaded) action = pr.configured
      ? `<button class="primary" data-act="upload" data-plate="${p.plate}">Send to ${esc(pr.name)}</button>`
      : `<button class="primary" data-act="printers" data-plate="${p.plate}">Add a printer…</button>`;
    else if (!p.started) {
      const ready = pr.idle && (!p.uploaded_to || p.uploaded_to === pr.id);
      action = `<button class="primary" data-act="start" data-plate="${p.plate}" ${ready ? "" : "disabled"}>${ready ? "Start print" : pr.online ? "Printer busy" : "Printer offline"}</button>`;
    }
    else action = printerUrl() ? `<a class="btn" href="${esc(printerUrl())}" target="_blank" rel="noopener">Open printer</a>` : "";
    return `<div class="plate">${title}
      <div class="stats">
        <div class="stat"><b>${fmtTime(p.time_s)}</b><span>print time</span></div>
        <div class="stat"><b>${p.weight_g != null ? p.weight_g.toFixed(1) + " g" : "–"}</b><span>filament${p.filament_mm ? " · " + (p.filament_mm / 1000).toFixed(2) + " m" : ""}</span></div>
        <div class="stat"><b>${p.layers ?? "–"}</b><span>layers</span></div>
        <div class="stat"><b>${p.cost != null ? p.cost.toFixed(2) : "–"}</b><span>filament cost</span></div>
      </div>
      ${sent}
      <div class="actions">
        <button class="btn" data-act="preview" data-plate="${p.plate}" type="button">Layers</button>
        <a class="btn" href="/api/jobs/${job.id}/plates/${p.plate}/gcode">Download</a>
        ${action}
      </div></div>`;
  }).join("");
}

async function poll(id) {
  for (;;) {
    const job = await apiJson(`/api/jobs/${id}`);
    currentJob = job;
    renderJob(job);
    if (job.status === "done" || job.status === "error") return job;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function slice() {
  if (!models.length || !layoutOk().fits) return;
  if (!S.selected.machine || !S.selected.process || !S.selected.filament) {
    $("result-card").hidden = false;
    $("result").innerHTML = `<p class="msg err">Choose a printer, filament and process first.</p>`;
    return;
  }
  const btn = $("slice");
  btn.disabled = true;
  btn.textContent = "Slicing…";
  $("result-card").hidden = false;
  $("result").innerHTML = `<p><span class="spinner"></span>Preparing the plate…</p>`;
  $("result-card").scrollIntoView({ behavior: "smooth", block: "start" });
  const version = plateVersion;     // what this slice is made from
  try {
    await new Promise((r) => setTimeout(r, 30));   // let the spinner paint before the heavy export
    const fd = new FormData();
    for (const k of ["machine", "process", "filament"]) fd.append(k, S.selected[k]);
    fd.append("edits", JSON.stringify(S.edits));   // unsaved setting changes apply to this slice
    fd.append("arrange", "0");
    fd.append("orient", "0");
    fd.append("name", plateName());
    fd.append("model", build3mf(), "plate.3mf");
    $("result").innerHTML = `<p><span class="spinner"></span>Uploading…</p>`;
    const job = await apiJson("/api/slice", { method: "POST", body: fd });
    currentJobVersion = version;
    const done = await poll(job.id);
    if (done.status === "done" && done.plates?.length && jobIsCurrent()) showPreview(done, done.plates[0].plate);
  } catch (e) {
    $("result").innerHTML = `<p class="msg err">${esc(e.message)}</p>`;
  } finally {
    btn.textContent = "Slice";
    refresh();
  }
}

async function plateAction(act, plate, btn) {
  const job = currentJob;
  if (act === "reslice") { slice(); return; }
  if (!jobIsCurrent() && act !== "printers") { renderJob(job); return; }   // never send or start an out-of-date slice
  if (act === "preview") { showPreview(job, plate); return; }
  if (act === "printers") { openPrinters(true); return; }
  if (act === "start") {
    const p = job.plates.find((x) => String(x.plate) === plate);
    if (!(await confirmBox(`Start printing ${p.uploaded} (${fmtTime(p.time_s)})? Make sure the bed is clear.`, "Start print"))) return;
    if (!jobIsCurrent()) { renderJob(job); return; }   // the plate changed while the question was open
  }
  btn.disabled = true;
  const label = btn.textContent;
  btn.innerHTML = `<span class="spinner"></span>${act === "upload" ? "Sending…" : "Starting…"}`;
  try {
    const target = act === "upload" && printerStatus().id ? `?printer=${printerStatus().id}` : "";
    await apiJson(`/api/jobs/${job.id}/plates/${plate}/${act}${target}`, { method: "POST" });
    currentJob = await apiJson(`/api/jobs/${job.id}`);
    await refreshPrinter();
    renderJob(currentJob);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = label;
    $("result").insertAdjacentHTML("afterbegin", `<p class="msg err">${esc(e.message)}</p>`);
  }
}

/* ================================================================ wiring */

for (const input of document.querySelectorAll(".file-input")) {
  input.addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    await addFiles(files);
  });
}
for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", () => setViewMode(b.dataset.view));
$("layer").addEventListener("input", (e) => { view.preview.setLayer(Number(e.target.value) - 1); renderLayerInfo(); });
$("layer-down").addEventListener("click", () => { view.preview.setLayer(view.preview.layer - 1); renderLayerInfo(); });
$("layer-up").addEventListener("click", () => { view.preview.setLayer(view.preview.layer + 1); renderLayerInfo(); });
$("show-travel").addEventListener("change", (e) => { view.preview.showTravel = e.target.checked; view.preview.setLayer(view.preview.layer); });
$("legend").addEventListener("change", (e) => {
  const i = e.target.dataset.feat;
  if (i === undefined) return;
  view.preview.setFeature(Number(i), e.target.checked);
  renderLegend();
});
$("objects").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  selected = models.find((m) => String(m.id) === li.dataset.id) || null;
  refresh();
  if (selected) focusModel(selected);
});
$("arrange").addEventListener("click", arrange);
$("view-reset").addEventListener("click", fitView);
$("clear").addEventListener("click", () => {
  for (const m of models) for (const mesh of m.meshes) view.scene.remove(mesh);
  for (const m of models) m.geo.dispose();
  plateChanged();
  models.length = 0;
  view.preview.clear();
  previewKey = null;
  $("preview-controls").hidden = true;
  setViewMode("model");
  selected = null;
  $("plate-flash").hidden = true;
  refresh();
});
$("lay-face").addEventListener("click", () => setPickMode(!pickMode));
$("auto-orient").addEventListener("click", () => selected && autoOrient(selected));
$("orient-reset").addEventListener("click", () => {
  if (!selected) return;
  selected.quat.identity();
  updateBox(selected);
  settle(selected.meshes);
});
for (const b of document.querySelectorAll("[data-rot]")) {
  b.addEventListener("click", () => {
    if (!selected) return;
    const [axis, dir] = b.dataset.rot.split(",");
    const angle = (axis === "z" ? Math.PI / 4 : Math.PI / 2) * Number(dir);
    const v = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[axis];
    rotateModel(selected, new THREE.Quaternion().setFromAxisAngle(v, angle));
  });
}
$("obj-scale").addEventListener("change", () => {
  if (!selected) return;
  const v = parseFloat($("obj-scale").value);
  if (!(v >= 1 && v <= 2000)) { $("obj-scale").value = Math.round(selected.scale * 1000) / 10; return; }
  selected.scale = v / 100;
  updateBox(selected);
  settle(selected.meshes);
});
const partEditor = createPartEditor($("part-settings"), () => selected?.overrides || null, () => { plateChanged(); refresh(); });
$("part-add").addEventListener("click", async () => {
  if (!selected) return;
  const key = await pickPartSetting(Object.keys(selected.overrides));
  if (!key || !selected) return;
  selected.overrides[key] = processValue(key);
  partEditor.render();
  plateChanged();
  refresh();
  $("part-settings").querySelector(`[data-key="${key}"]`)?.focus();
});
$("copy-plus").addEventListener("click", () => {
  if (!selected || selected.meshes.length >= MAX_COPIES) return;
  setCopies(selected, selected.meshes.length + 1);
  const mesh = selected.meshes[selected.meshes.length - 1];
  mesh.position.x += selected.size.x + GAP;
  settle([mesh]);
});
$("copy-minus").addEventListener("click", () => { if (selected) { setCopies(selected, selected.meshes.length - 1); plateChanged(); refresh(); } });
$("obj-delete").addEventListener("click", () => {
  if (!selected) return;
  for (const mesh of selected.meshes) view.scene.remove(mesh);
  selected.geo.dispose();
  models.splice(models.indexOf(selected), 1);
  plateChanged();
  selected = null;
  refresh();
});
$("slice").addEventListener("click", slice);
$("result").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (b) plateAction(b.dataset.act, b.dataset.plate, b);
});

initViewer();
drawBed();
fitView();
refresh();
initPrinters({
  getMachine: () => S.selected.machine,
  machineNames: () => S.lists.machine.map((m) => m.name),
  onStatus: () => { if (currentJob?.status === "done") renderJob(currentJob); },
});
initSettings((what) => {
  if (what === "presets") { setBed(); refreshPrinter(); }
  if (what === "presets" || what === "edits") plateChanged();
}).then(fitView).catch((e) => {
  $("result-card").hidden = false;
  $("result").innerHTML = `<p class="msg err">Couldn't load presets: ${esc(e.message)}</p>`;
});
