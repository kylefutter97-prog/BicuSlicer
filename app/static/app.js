import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { zipSync, strToU8 } from "three/addons/libs/fflate.module.js";
import { $, esc, api, apiJson, postJson, confirmBox, ask, toast, saveBlob } from "./util.js";
import { initSettings, S, machineValues, createPartEditor, pickPartSetting, processValue, partOptionsAvailable, applyProjectPresets } from "./settings.js";
import { Preview } from "./preview.js";
import * as MO from "./meshops.js";
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
const models = [];          // {id, name, geo, quat, scale (Vector3), meshes: [Mesh], overrides, printable, volumes, paint}
let selected = null;          // the part the panel shows (last clicked)
let selectedMesh = null;      // which copy of it was clicked (for its position)
const multi = new Set();      // extra parts picked with Shift/Ctrl-click (merge, delete, ...)
let selectedVolume = null;    // a modifier / negative part of the selected part, when one is picked in the list
const selection = () => [...new Set([...multi, ...(selected ? [selected] : [])])].filter((m) => models.includes(m));
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
    // a part switched to "not printable": stays on the plate, not sliced
    ghost: new THREE.MeshStandardMaterial({ color: css("--model-dim"), roughness: 0.7, transparent: true, opacity: 0.25, depthWrite: false }),
    modifier: new THREE.MeshStandardMaterial({ color: css("--ok"), transparent: true, opacity: 0.28, depthWrite: false }),
    modifierSel: new THREE.MeshStandardMaterial({ color: css("--ok"), transparent: true, opacity: 0.55, depthWrite: false }),
    negative: new THREE.MeshStandardMaterial({ color: css("--bad"), transparent: true, opacity: 0.28, depthWrite: false }),
    negativeSel: new THREE.MeshStandardMaterial({ color: css("--bad"), transparent: true, opacity: 0.55, depthWrite: false }),
  };
  Object.assign(view, { el, renderer, scene, camera, controls, mats, bedGroup: null, raycaster: new THREE.Raycaster() });
  new ResizeObserver(resize).observe(el);
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  wirePointer();
  wireContextMenu();
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
      const m = newModelRecord(f.name.replace(/\.[^.]+$/, ""), geo);
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

function newModelRecord(name, geo) {
  return { id: nextId++, name, geo, quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1), meshes: [], box: null,
    overrides: {}, printable: true, volumes: [], volMeshes: [], paint: null };
}

function centered(geo) {
  // recentre a geometry on its bounding-box centre; returns the offset it had
  geo.computeBoundingBox();
  const c = geo.boundingBox.getCenter(new THREE.Vector3());
  geo.translate(-c.x, -c.y, -c.z);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return c;
}

/** Put a new part on the plate. xy = where its centre goes (default: bed centre). */
function addModel(name, geo, xy = null, from = null) {
  const c = centered(geo);
  const m = newModelRecord(name, geo);
  if (from) { m.overrides = JSON.parse(JSON.stringify(from.overrides || {})); }
  models.push(m);
  setCopies(m, 1);
  updateBox(m);
  if (xy) { m.meshes[0].position.x = xy.x; m.meshes[0].position.y = xy.y; }
  return { m, center: c };
}

function removeModel(m) {
  for (const mesh of m.meshes) view.scene.remove(mesh);
  for (const vm of m.volMeshes || []) view.scene.remove(vm);
  m.volMeshes = [];
  m.geo.dispose();
  const i = models.indexOf(m);
  if (i >= 0) models.splice(i, 1);
  multi.delete(m);
  if (selected === m) { selected = null; selectedVolume = null; }
}

/** The part's mesh with its rotation and scale applied (centred), for operations that work in plate axes. */
function bakedGeo(m) {
  return MO.bake(m.geo, new THREE.Matrix4().compose(new THREE.Vector3(), m.quat, m.scale));
}

/** Replace a part's mesh with one already in plate axes (rotation/scale reset), keeping it where it was. */
function replaceGeo(m, geo) {
  const keepXY = m.meshes.map((x) => [x.position.x, x.position.y]);
  const c = centered(geo);
  m.geo.dispose();
  m.geo = geo;
  m.quat.identity();
  m.scale.set(1, 1, 1);
  m.paint = null;
  m.meshes.forEach((x, i) => { x.geometry = geo; x.position.x = keepXY[i][0] + c.x; x.position.y = keepXY[i][1] + c.y; });
  updateBox(m);
}

/* ---- modifier / negative parts: shown as see-through shapes that follow each copy of their part */

function volumeGeo(v) {
  const s = v.size;
  const g = v.shape === "cylinder" ? MO.cylinder(1, 1) : v.shape === "sphere" ? MO.sphere(1) : v.shape === "cone" ? MO.cone(1, 1) : MO.box(1, 1, 1);
  return MO.bake(g, new THREE.Matrix4().makeScale(s.x, s.y, s.z));
}

function syncVolumes(m) {
  const need = m.meshes.length * m.volumes.length;
  if ((m.volMeshes || []).length !== need || m.volMeshes.some((vm) => !m.volumes.includes(vm.userData.volume) || vm.geometry !== vm.userData.volume.geo)) {
    for (const vm of m.volMeshes || []) view.scene.remove(vm);
    m.volMeshes = [];
    for (const mesh of m.meshes) for (const v of m.volumes) {
      const vm = new THREE.Mesh(v.geo, v.kind === "negative" ? view.mats.negative : view.mats.modifier);
      vm.userData = { model: m, volume: v, copy: mesh };
      vm.renderOrder = 2;
      m.volMeshes.push(vm);
      view.scene.add(vm);
    }
  }
  for (const vm of m.volMeshes) {
    const v = vm.userData.volume, c = vm.userData.copy;
    vm.position.set(c.position.x + v.pos.x, c.position.y + v.pos.y, v.pos.z);
    vm.visible = viewMode === "model";
    vm.material = v === selectedVolume ? (v.kind === "negative" ? view.mats.negativeSel : view.mats.modifierSel)
      : (v.kind === "negative" ? view.mats.negative : view.mats.modifier);
  }
}

function updateBox(m) {
  // Exact bounding box of the part as rotated and scaled (iterates the vertices once).
  const mat = new THREE.Matrix4().compose(new THREE.Vector3(), m.quat, m.scale);
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
  mesh.scale.copy(m.scale);
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
  for (const m of models) { for (const mesh of m.meshes) mesh.visible = mode === "model"; syncVolumes(m); }
  view.preview?.setVisible(mode === "preview");
  for (const b of document.querySelectorAll("[data-view]")) b.classList.toggle("on", b.dataset.view === mode);
  $("pv-layers").hidden = $("legend").hidden = mode !== "preview";
  $("layer-text").hidden = mode !== "preview";
  if (mode === "preview") setPickMode(false);
  $("tip").textContent = mode === "preview"
    ? "Drag to turn the view · pinch or scroll to zoom · slide to step through the layers"
    : "Drag a part to move it · drag empty space to turn the view · pinch or scroll to zoom · press ? for keyboard shortcuts";
}

function plateChanged() {
  // the plate or settings no longer match the last slice
  plateVersion++;
  updateProjectLabel();
  updateMainButton();
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
  const mat = new THREE.Matrix4().compose(new THREE.Vector3(), m.quat, withScale ? m.scale : new THREE.Vector3(1, 1, 1));
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
  let down = null, drag = null, press = null;
  const pointers = new Set();
  const cancelPress = () => { clearTimeout(press); press = null; };

  el.addEventListener("pointerdown", (e) => {
    pointers.add(e.pointerId);
    closeMenu();
    if (viewMode === "preview") { down = null; return; }   // layers view: the pointer only turns the view
    if (pointers.size > 1) {                  // second finger: hand over to zoom/pan
      if (drag) endDrag();
      cancelPress();
      paint.painting = false;
      down = null;
      return;
    }
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (paint.on && e.button === 0 && paintAt(e)) {   // painting: a drag on the part paints, elsewhere turns the view
      paint.painting = true;
      view.controls.enabled = false;
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (e.pointerType === "touch") {
      // long-press on a part opens its menu (the touch version of right-click)
      const sx = e.clientX, sy = e.clientY;
      press = setTimeout(() => {
        press = null;
        const hit = hitPart({ clientX: sx, clientY: sy });
        if (!hit) return;
        if (drag) { drag = null; view.controls.enabled = true; view.el.classList.remove("dragging"); }
        down = null;
        if (!selection().includes(hit.object.userData.model)) pickPart(hit.object.userData.model, hit.object);
        openMenu(sx, sy, partMenu());
      }, 550);
    }
    if (pickMode || e.button > 0) return;
    const hit = hitPart(e);
    const p = hit && bedPoint(e);
    if (!hit || !p) return;
    const mesh = hit.object;
    drag = { mesh, offset: new THREE.Vector2(p.x - mesh.position.x, p.y - mesh.position.y), moved: false };
    view.controls.enabled = false;            // runs before OrbitControls sees this pointerdown (capture phase)
    el.setPointerCapture(e.pointerId);
    if (!selection().includes(mesh.userData.model)) pickPart(mesh.userData.model, mesh, e.shiftKey || e.ctrlKey || e.metaKey);
    else { selectedMesh = mesh; }
  }, { capture: true });

  el.addEventListener("pointermove", (e) => {
    if (press && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) cancelPress();
    if (paint.painting) { paintAt(e); return; }
    if (!drag) return;
    if (!drag.moved && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) return;
    const p = bedPoint(e);
    if (!p) return;
    drag.moved = true;
    view.el.classList.add("dragging");
    drag.mesh.position.x = p.x - drag.offset.x;
    drag.mesh.position.y = p.y - drag.offset.y;
    syncVolumes(drag.mesh.userData.model);
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
    cancelPress();
    if (paint.painting) { paint.painting = false; view.controls.enabled = true; down = null; plateChanged(); refresh(); return; }
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
    pickPart(hit ? hit.object.userData.model : null, hit?.object, e.shiftKey || e.ctrlKey || e.metaKey);
  }
}

function wireContextMenu() {
  view.renderer.domElement.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (viewMode === "preview" || paint.on) return;
    const hit = hitPart(e);
    if (hit) {
      if (!selection().includes(hit.object.userData.model)) pickPart(hit.object.userData.model, hit.object);
      openMenu(e.clientX, e.clientY, partMenu());
    } else openMenu(e.clientX, e.clientY, plateMenu());
  });
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
  if (!selected) { setPickMode(false); selectedVolume = null; }
  if (selectedVolume && !selected.volumes.includes(selectedVolume)) selectedVolume = null;
  const ok = layoutOk();
  const sel = new Set(selection());
  for (const m of models) {
    for (const mesh of m.meshes) {
      mesh.material = m.printable === false ? view.mats.ghost : ok.off.has(m) || ok.tall.has(m) ? view.mats.bad
        : sel.has(m) ? (paint.on && m === selected ? mesh.material : view.mats.selected) : view.mats.normal;
    }
    syncVolumes(m);
  }
  $("plate-toolbar").hidden = !has;
  updateToolbar();
  const parts = models.reduce((n, m) => n + m.meshes.length, 0);
  $("plate-summary").textContent = has ? `${parts} part${parts === 1 ? "" : "s"}` : "";
  $("objects").innerHTML = models.map((m) => `
    <li class="${sel.has(m) && !selectedVolume ? "sel" : ""}${ok.off.has(m) || ok.tall.has(m) ? " bad" : ""}${m.printable === false ? " ghost" : ""}" data-id="${m.id}">
      <span class="name">${esc(m.name)}${m.printable === false ? ' <span class="muted small">(not printed)</span>' : ""}</span>
      <span class="muted small">${m.overrides.brim_type === "brim_ears" ? '<span class="part-badge" title="Brim ears">ears</span> ' : ""}${m.paint && (m.paint.supports || m.paint.seam) ? '<span class="part-badge" title="Painted">🖌</span> ' : ""}${Object.keys(m.overrides).length ? `<span class="part-badge" title="Has its own settings">⚙ ${Object.keys(m.overrides).length}</span> ` : ""}${m.meshes.length > 1 ? `×${m.meshes.length} · ` : ""}${fmtMm(m.size.x)}×${fmtMm(m.size.y)}×${fmtMm(m.size.z)}</span>
    </li>${m.volumes.map((v) => `
    <li class="vol${v === selectedVolume ? " sel" : ""}" data-id="${m.id}" data-vol="${v.id}">
      <span class="name">↳ ${esc(v.name)}</span><span class="muted small">${v.kind === "negative" ? "negative part" : "modifier"}${Object.keys(v.overrides).length ? ` · ⚙ ${Object.keys(v.overrides).length}` : ""}</span>
    </li>`).join("")}`).join("");
  const panel = $("obj-panel");
  panel.hidden = !selected || !!selectedVolume;
  renderVolumePanel();
  if (selected) renderTransform();
  if (selected) {
    $("obj-name").textContent = selected.name;
    $("obj-size").textContent = `${fmtMm(selected.size.x)} × ${fmtMm(selected.size.y)} × ${fmtMm(selected.size.z)} mm`;
    const uni = Math.abs(selected.scale.x - selected.scale.y) < 1e-9 && Math.abs(selected.scale.y - selected.scale.z) < 1e-9;
    if (document.activeElement !== $("obj-scale")) $("obj-scale").value = uni ? Math.round(selected.scale.x * 1000) / 10 : "";
    $("obj-scale").placeholder = uni ? "" : "mixed";
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
  updateMainButton();
}

/* ================================================================ slicing */

function meshXml(geo, matrix, paint) {
  // a 3MF <mesh> with the vertices baked into plate coordinates; identical corners become one vertex.
  // paint (optional): per-triangle paint states for supports / seam, written the way OrcaSlicer reads them.
  const p = geo.getAttribute("position").array;
  const index = new Map(), uniq = [], tris = new Uint32Array(p.length / 3);
  for (let i = 0; i < p.length; i += 3) {
    const key = p[i] + "," + p[i + 1] + "," + p[i + 2];
    let v = index.get(key);
    if (v === undefined) { v = uniq.length / 3; index.set(key, v); uniq.push(p[i], p[i + 1], p[i + 2]); }
    tris[i / 3] = v;
  }
  const e = matrix.elements;
  const vx = [];
  for (let i = 0; i < uniq.length; i += 3) {
    const x = uniq[i], y = uniq[i + 1], z = uniq[i + 2];
    vx.push(`<vertex x="${(e[0] * x + e[4] * y + e[8] * z + e[12]).toFixed(4)}" y="${(e[1] * x + e[5] * y + e[9] * z + e[13]).toFixed(4)}" z="${(e[2] * x + e[6] * y + e[10] * z + e[14]).toFixed(4)}"/>`);
  }
  const flip = matrix.determinant() < 0;      // a mirrored transform turns faces inside out: swap two corners back
  const tx = [];
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = flip ? tris[t + 2] : tris[t + 1], c = flip ? tris[t + 1] : tris[t + 2];
    if (a === b || b === c || a === c) continue;
    const k = t / 3;
    const ps = paint?.supports ? MO.paintCode(paint.supports[k]) : "";
    const pm = paint?.seam ? MO.paintCode(paint.seam[k]) : "";
    tx.push(`<triangle v1="${a}" v2="${b}" v3="${c}"${ps ? ` paint_supports="${ps}"` : ""}${pm ? ` paint_seam="${pm}"` : ""}/>`);
  }
  return `<mesh><vertices>${vx.join("")}</vertices><triangles>${tx.join("")}</triangles></mesh>`;
}

const metaXml = (o, indent) => Object.entries(o || {}).map(([k, v]) =>
  `${indent}<metadata key="${esc(k)}" value="${esc(Array.isArray(v) ? v.join(",") : v)}"/>\n`).join("");

function build3mf() {
  // What the slicer sees is what's on screen: every placed copy of every printable part, baked in plate coordinates.
  // A part with modifier / negative parts becomes an object made of components, with each component's type and
  // settings in Metadata/model_settings.config (the layout OrcaSlicer itself writes; checked with test slices).
  const objects = [], items = [], configs = [];
  let id = 1;
  for (const m of models) {
    if (m.printable === false) continue;
    for (const mesh of m.meshes) {
      mesh.updateMatrixWorld(true);
      const bodyId = id++;
      objects.push(`<object id="${bodyId}" type="model" name="${esc(m.name)}">${meshXml(m.geo, mesh.matrixWorld, m.paint)}</object>`);
      if (!m.volumes.length) {
        // per-part settings: OrcaSlicer reads them from Metadata/model_settings.config, keyed by object id
        configs.push(`  <object id="${bodyId}">\n    <metadata key="name" value="${esc(m.name)}"/>\n${metaXml(m.overrides, "    ")}  </object>`);
        items.push(`<item objectid="${bodyId}"/>`);
        continue;
      }
      const parts = [`    <part id="${bodyId}" subtype="normal_part">\n      <metadata key="name" value="${esc(m.name)}"/>\n    </part>\n`];
      const comps = [`<component objectid="${bodyId}"/>`];
      for (const v of m.volumes) {
        const vid = id++;
        const mat = new THREE.Matrix4().makeTranslation(mesh.position.x + v.pos.x, mesh.position.y + v.pos.y, v.pos.z);
        objects.push(`<object id="${vid}" type="model" name="${esc(v.name)}">${meshXml(v.geo, mat, null)}</object>`);
        comps.push(`<component objectid="${vid}"/>`);
        parts.push(`    <part id="${vid}" subtype="${v.kind === "negative" ? "negative_part" : "modifier_part"}">\n      <metadata key="name" value="${esc(v.name)}"/>\n${v.kind === "negative" ? "" : metaXml(v.overrides, "      ")}    </part>\n`);
      }
      const objId = id++;
      objects.push(`<object id="${objId}" type="model" name="${esc(m.name)}"><components>${comps.join("")}</components></object>`);
      configs.push(`  <object id="${objId}">\n    <metadata key="name" value="${esc(m.name)}"/>\n${metaXml(m.overrides, "    ")}${parts.join("")}  </object>`);
      items.push(`<item objectid="${objId}"/>`);
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
  try { renderJobInner(job); } finally { updateMainButton(); }
}

function renderJobInner(job) {
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
    const sent = p.uploaded ? `<p class="msg ok">On ${esc(p.uploaded_name || "the printer")} as <b>${esc(p.uploaded)}</b>${p.started ? " · print started" : ""}</p>` : "";
    // sending and starting live on the main button; the card keeps the details
    const action = p.started && printerUrl() ? `<a class="btn" href="${esc(printerUrl())}" target="_blank" rel="noopener">Open printer</a>` : "";
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
  if (!models.some((m) => m.printable !== false)) { $("result-card").hidden = false; $("result").innerHTML = `<p class="msg err">Every part is set to not printable.</p>`; return; }
  if (!S.selected.machine || !S.selected.process || !S.selected.filament) {
    $("result-card").hidden = false;
    $("result").innerHTML = `<p class="msg err">Choose a printer, filament and print settings first.</p>`;
    return;
  }
  slicing = true;
  updateMainButton();
  $("result-card").hidden = false;
  $("result").innerHTML = `<p><span class="spinner"></span>Preparing the plate…</p>`;
  $("result-card").scrollIntoView({ behavior: "smooth", block: "start" });
  const version = plateVersion;     // what this slice is made from
  try {
    await new Promise((r) => setTimeout(r, 30));   // let the spinner paint before the heavy export
    const fd = new FormData();
    for (const k of ["machine", "process", "filament"]) fd.append(k, S.selected[k]);
    // unsaved setting changes apply to this slice, plus the chosen plate type (OrcaSlicer's curr_bed_type)
    fd.append("edits", JSON.stringify({ ...S.edits, process: { ...S.edits.process, ...(S.bedType ? { curr_bed_type: S.bedType } : {}) } }));
    fd.append("arrange", "0");
    fd.append("orient", "0");
    fd.append("name", plateName());
    fd.append("model", build3mf(), "plate.3mf");
    const thumbs = plateThumbs();      // Mainsail's file preview (the headless slicer can't render one)
    if (thumbs) fd.append("thumbs", new Blob([JSON.stringify(thumbs)], { type: "application/json" }), "thumbs.json");
    $("result").innerHTML = `<p><span class="spinner"></span>Uploading…</p>`;
    const job = await apiJson("/api/slice", { method: "POST", body: fd });
    currentJobVersion = version;
    const done = await poll(job.id);
    if (done.status === "done" && done.plates?.length && jobIsCurrent()) showPreview(done, done.plates[0].plate);
  } catch (e) {
    $("result").innerHTML = `<p class="msg err">${esc(e.message)}</p>`;
  } finally {
    slicing = false;
    refresh();
  }
}

async function plateAction(act, plate, btn) {
  const job = currentJob;
  if (act === "reslice") { slice(); return; }
  if (!jobIsCurrent() && act !== "printers") { renderJob(job); return; }   // never send or start an out-of-date slice
  if (act === "preview") { showPreview(job, plate); return; }
  if (act === "printers") { openPrinters(true); return; }
  let startNow = false;
  if (act === "send") {
    const p = job.plates.find((x) => String(x.plate) === plate);
    const choice = await sendDialog(p);
    if (!choice) return;
    if (!jobIsCurrent()) { renderJob(job); return; }
    startNow = choice === "print";
    act = "upload";
  }
  if (act === "start") {
    const p = job.plates.find((x) => String(x.plate) === plate);
    if (!(await confirmBox(`Start printing ${p.uploaded} (${fmtTime(p.time_s)})? Make sure the bed is clear.`, "Start print"))) return;
    if (!jobIsCurrent()) { renderJob(job); return; }   // the plate changed while the question was open
  }
  btn.disabled = true;
  const label = btn.textContent;
  btn.innerHTML = `<span class="spinner"></span>${act === "upload" ? (startNow ? "Sending and starting…" : "Sending…") : "Starting…"}`;
  try {
    const q = new URLSearchParams();
    if (act === "upload" && printerStatus().id) q.set("printer", printerStatus().id);
    if (startNow) q.set("start", "1");
    const res = await apiJson(`/api/jobs/${job.id}/plates/${plate}/${act}${q.toString() ? "?" + q : ""}`, { method: "POST" });
    if (res.note) toast(res.note, "warn");
    else if (res.started) toast(`Printing on ${res.printer}`);
    currentJob = await apiJson(`/api/jobs/${job.id}`);
    await refreshPrinter();
    renderJob(currentJob);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = label;
    $("result").insertAdjacentHTML("afterbegin", `<p class="msg err">${esc(e.message)}</p>`);
  }
}

/* ================================================================ plate tools (toolbar, right-click menu, transforms) */

function pickPart(m, mesh = null, additive = false, vol = null) {
  if (paint.on && m !== paint.model) stopPaint();
  if (additive && m) {
    if (multi.has(m) || (selected === m && multi.size)) { multi.delete(m); if (selected === m) selected = [...multi].pop() || null; multi.delete(selected); }
    else { if (selected && selected !== m) multi.add(selected); selected = m; }
  } else {
    multi.clear();
    selected = m;
  }
  selectedMesh = mesh && m?.meshes.includes(mesh) ? mesh : null;
  selectedVolume = vol;
  refresh();
}

const focusedInput = (id) => document.activeElement === $(id);
const deg = (r) => Math.round(THREE.MathUtils.radToDeg(r) * 100) / 100;

function selectedCopy() {
  return selected && (selected.meshes.includes(selectedMesh) ? selectedMesh : selected.meshes[0]);
}

function renderTransform() {
  const m = selected, c = selectedCopy();
  if (!m || !c) return;
  const set = (id, v) => { if (!focusedInput(id)) $(id).value = v; };
  set("t-x", +c.position.x.toFixed(2));
  set("t-y", +c.position.y.toFixed(2));
  const eu = new THREE.Euler().setFromQuaternion(m.quat, "XYZ");
  set("t-rx", deg(eu.x)); set("t-ry", deg(eu.y)); set("t-rz", deg(eu.z));
  set("t-sx", +m.size.x.toFixed(2)); set("t-sy", +m.size.y.toFixed(2)); set("t-sz", +m.size.z.toFixed(2));
  $("t-copy").textContent = m.meshes.length > 1 ? `copy ${m.meshes.indexOf(c) + 1} of ${m.meshes.length}` : "";
  $("t-printable").checked = m.printable !== false;
  $("t-ears").checked = m.overrides.brim_type === "brim_ears";
}

function setPosition(axis, v) {
  const c = selectedCopy();
  if (!c || !Number.isFinite(v)) return refresh();
  c.position[axis] = v;
  plateChanged();
  refresh();
}

function setRotation() {
  const m = selected;
  const r = ["t-rx", "t-ry", "t-rz"].map((id) => THREE.MathUtils.degToRad(parseFloat($(id).value) || 0));
  m.quat.setFromEuler(new THREE.Euler(r[0], r[1], r[2], "XYZ"));
  updateBox(m);
  settle(m.meshes);
}

function setSize(axis, mm) {
  const m = selected;
  const i = "xyz".indexOf(axis);
  const cur = m.size.getComponent(i);
  if (!(mm > 0) || !(cur > 0)) return refresh();
  const f = mm / cur;
  if ($("t-lock").checked) m.scale.multiplyScalar(f);
  else {
    // scale the part's own axis that lines up best with this plate axis
    const e = new THREE.Matrix4().makeRotationFromQuaternion(m.quat).elements;
    let j = 0, best = -1;
    for (let k = 0; k < 3; k++) { const w = Math.abs(e[k * 4 + i]); if (w > best) { best = w; j = k; } }
    m.scale.setComponent(j, m.scale.getComponent(j) * f);
  }
  updateBox(m);
  settle(m.meshes);
}

/* ---- menus (toolbar drop-downs and the right-click / long-press menu) */

let menuItems = [];
function openMenu(x, y, items) {
  const el = $("menu");
  menuItems = items.filter(Boolean);
  el.innerHTML = menuItems.map((it, i) => it.sep ? `<hr>` : it.head ? `<div class="menu-head">${esc(it.head)}</div>`
    : `<button type="button" role="menuitem" data-i="${i}" ${it.disabled ? "disabled" : ""}>${it.check !== undefined ? `<span class="tick">${it.check ? "✓" : ""}</span>` : ""}${esc(it.label)}${it.key ? `<kbd>${esc(it.key)}</kbd>` : ""}</button>`).join("");
  el.hidden = false;
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  el.querySelector("button:not([disabled])")?.focus({ preventScroll: true });
}
function closeMenu() { $("menu").hidden = true; menuItems = []; }
$("menu").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-i]");
  if (!b) return;
  const it = menuItems[Number(b.dataset.i)];
  closeMenu();
  it?.run?.();
});
document.addEventListener("pointerdown", (e) => { if (!$("menu").hidden && !e.target.closest("#menu")) closeMenu(); }, true);
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("menu").hidden) { e.stopPropagation(); closeMenu(); } }, true);
window.addEventListener("resize", closeMenu);

const shapeItems = () => [
  { head: "Add a shape" },
  { label: "Box", run: () => addShape("box") }, { label: "Cylinder", run: () => addShape("cylinder") },
  { label: "Sphere", run: () => addShape("sphere") }, { label: "Cone", run: () => addShape("cone") },
];
const mirrorItems = () => [{ head: "Mirror" }, ...["x", "y", "z"].map((a) => ({ label: `Mirror along ${a.toUpperCase()}`, run: () => mirrorSelected(a), disabled: !selected }))];
const volumeItems = () => [
  { head: "Modifier (own settings inside it)" },
  ...["box", "cylinder", "sphere"].map((s) => ({ label: `Modifier: ${s}`, run: () => addVolume("modifier", s), disabled: !selected })),
  { head: "Negative part (cut away)" },
  ...["box", "cylinder", "sphere"].map((s) => ({ label: `Negative part: ${s}`, run: () => addVolume("negative", s), disabled: !selected })),
];
const paintItems = () => [
  { head: "Paint on the part" },
  { label: "Supports (enforce / block)", run: () => startPaint("supports"), disabled: !selected },
  { label: "Seam (here / avoid)", run: () => startPaint("seam"), disabled: !selected },
];
const moreItems = () => [
  { label: "Rename…", run: renameSelected, disabled: !selected },
  { label: "Center on the bed", run: centerSelected, disabled: !selected },
  { label: "Printable", check: selected?.printable !== false, run: togglePrintable, disabled: !selected },
  { label: "Fix model", run: fixSelected, disabled: !selected },
  { label: "Convert from inches (×25.4)", run: () => convertUnits(25.4), disabled: !selected },
  { label: "Convert to inches (÷25.4)", run: () => convertUnits(1 / 25.4), disabled: !selected },
  { sep: true },
  { label: "Export part as STL", run: exportPartStl, disabled: !selected },
  { label: "Export plate as 3MF", run: exportPlate3mf, disabled: !models.length },
];

function partMenu() {
  const many = selection().length > 1;
  return [
    { head: many ? `${selection().length} parts` : selected?.name },
    { label: "Rename…", run: renameSelected, disabled: many },
    { label: "Add a copy", key: "+", run: () => $("copy-plus").click() },
    { label: "Auto-orient", run: () => selected && autoOrient(selected) },
    { label: "Pick face down", key: "F", run: () => setPickMode(true) },
    { label: "Center on the bed", run: centerSelected },
    { sep: true },
    ...mirrorItems().slice(1),
    { label: "Split into parts", run: splitSelected, disabled: many },
    { label: "Cut…", run: openCut, disabled: many },
    { label: "Merge selected parts", run: mergeSelected, disabled: !many },
    { sep: true },
    ...volumeItems().filter((it) => !it.head).slice(0, 1), { label: "Negative part: box", run: () => addVolume("negative", "box") },
    { label: "Brim ears", check: selected?.overrides.brim_type === "brim_ears", run: toggleEars },
    { label: "Paint supports…", run: () => startPaint("supports") },
    { label: "Paint seam…", run: () => startPaint("seam") },
    { label: "Printable", check: selected?.printable !== false, run: togglePrintable },
    { sep: true },
    { label: "Fix model", run: fixSelected, disabled: many },
    { label: "Export as STL", run: exportPartStl, disabled: many },
    { label: many ? "Remove parts" : "Remove", key: "Del", run: () => $("obj-delete").click() },
  ];
}
const plateMenu = () => [
  { label: "Add a model…", key: "Ctrl+I", run: () => document.querySelector(".file-input")?.click() },
  ...shapeItems().slice(1).map((it) => ({ ...it, label: `Add ${it.label.toLowerCase()}` })),
  { sep: true },
  { label: "Arrange", key: "A", run: arrange, disabled: !models.length },
  { label: "Auto-orient all", run: orientAll, disabled: !models.length },
  { label: "Export plate as 3MF", run: exportPlate3mf, disabled: !models.length },
];

function updateToolbar() {
  const one = !!selected, many = selection().length > 1;
  for (const b of document.querySelectorAll("#plate-toolbar [data-needs]")) {
    b.disabled = b.dataset.needs === "one" ? !one || many : b.dataset.needs === "many" ? !many : false;
  }
  $("tb-ears").classList.toggle("on", !!selected && selected.overrides.brim_type === "brim_ears");
  $("tb-paint").classList.toggle("on", paint.on);
}

$("plate-toolbar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tool]");
  if (!b || b.disabled) return;
  const r = b.getBoundingClientRect();
  const at = (items) => openMenu(r.left, r.bottom + 4, items);
  ({
    shape: () => at(shapeItems()), arrange, "orient-all": orientAll, split: splitSelected, merge: mergeSelected, cut: openCut,
    mirror: () => at(mirrorItems()), volume: () => at(volumeItems()), ears: toggleEars,
    paint: () => (paint.on ? stopPaint() : at(paintItems())), more: () => at(moreItems()),
  })[b.dataset.tool]?.();
});

/* ---- actions */

function addShape(kind) {
  if (!view.renderer) initViewer();
  const g = { box: () => MO.box(20, 20, 20), cylinder: () => MO.cylinder(20, 20), sphere: () => MO.sphere(20), cone: () => MO.cone(20, 20) }[kind]();
  const { m } = addModel(kind[0].toUpperCase() + kind.slice(1), g);
  selected = m; multi.clear();
  settle(m.meshes);
}

function renameSelected() {
  if (!selected) return;
  const m = selected;
  ask("Rename part", m.name, "Rename").then((name) => { if (name) { m.name = name; plateChanged(); refresh(); } });
}

function centerSelected() {
  const c = selectedCopy();
  if (!c) return;
  c.position.x = bed.w / 2; c.position.y = bed.d / 2;
  settle([c]);
}

function togglePrintable() {
  for (const m of selection()) m.printable = m.printable === false;
  plateChanged();
  refresh();
}

function toggleEars() {
  // OrcaSlicer's "Mouse ear" brim: small round tabs on sharp corners, found automatically
  const on = !(selected?.overrides.brim_type === "brim_ears");
  for (const m of selection()) { if (on) m.overrides.brim_type = "brim_ears"; else delete m.overrides.brim_type; }
  if (selected) partEditor.model = null;
  plateChanged();
  refresh();
  flash(on ? "Brim ears on: tabs on the sharp corners (tune them under the part's own settings)" : "Brim ears off", "ok");
}

function convertUnits(f) {
  for (const m of selection()) { m.scale.multiplyScalar(f); updateBox(m); }
  settle(selection().flatMap((m) => m.meshes));
}

function mirrorSelected(axis) {
  for (const m of selection()) {
    const g = MO.mirror(bakedGeo(m), axis);
    replaceGeo(m, g);
  }
  settle(selection().flatMap((m) => m.meshes));
}

function splitSelected() {
  const m = selected;
  if (!m) return;
  busy("Splitting…");
  setTimeout(() => {
    try {
      const pieces = MO.splitParts(bakedGeo(m));
      if (pieces.length < 2) { flash(`${m.name} is a single piece: nothing to split.`, "warn"); return; }
      const base = selectedCopy().position.clone();
      removeModel(m);
      const added = pieces.map((g, i) => {
        const r = addModel(`${m.name} ${i + 1}`, g, null, m);
        r.m.meshes[0].position.x = base.x + r.center.x;
        r.m.meshes[0].position.y = base.y + r.center.y;
        return r.m;
      });
      selected = added[0]; multi.clear(); added.slice(1).forEach((x) => multi.add(x));
      settle(added.flatMap((x) => x.meshes));
      flash(`Split into ${pieces.length} parts`, "ok");
    } catch (e) { flash(`Couldn't split: ${e.message}`, "err"); } finally { busy(null); }
  }, 20);
}

function mergeSelected() {
  const list = selection();
  if (list.length < 2) return;
  const geos = [];
  for (const m of list) for (const mesh of m.meshes) { mesh.updateMatrixWorld(true); geos.push(MO.bake(m.geo, mesh.matrixWorld)); }
  const g = MO.mergeGeometries(geos);
  const first = list[0];
  for (const m of list) removeModel(m);
  g.computeBoundingBox();
  const c = g.boundingBox.getCenter(new THREE.Vector3());
  const { m } = addModel(`${first.name} (merged)`, g, { x: c.x, y: c.y }, first);
  selected = m; multi.clear();
  settle([]);
  flash(`Merged ${list.length} parts into one`, "ok");
}

async function fixSelected() {
  const m = selected;
  if (!m) return;
  busy(`Fixing ${m.name}…`);
  try {
    const fd = new FormData();
    fd.append("model", meshStl(m.geo), "part.stl");
    const buf = await (await api("/api/repair", { method: "POST", body: fd })).arrayBuffer();
    const g = mergeToGeometry(new THREE.Mesh(new STLLoader().parse(buf)));
    const before = m.geo.getAttribute("position").count / 3, after = g.getAttribute("position").count / 3;
    const keep = { quat: m.quat.clone(), scale: m.scale.clone() };
    replaceGeo(m, g);
    m.quat.copy(keep.quat); m.scale.copy(keep.scale);
    updateBox(m);
    settle(m.meshes);
    flash(`Fixed ${m.name} (${before.toLocaleString()} → ${after.toLocaleString()} triangles)`, "ok");
  } catch (e) { flash(e.message, "err"); } finally { busy(null); }
}

async function orientAll() {
  for (const m of [...models]) await autoOrient(m);
  arrange();
}

function exportPartStl() {
  if (!selected) return;
  saveBlob(stlOf(selected, true), `${selected.name}.stl`);
}

function exportPlate3mf() {
  if (!models.length) return;
  saveBlob(build3mf(), `${plateName()}.3mf`);
}

/* ---- modifier and negative parts */

function addVolume(kind, shape) {
  const m = selected;
  if (!m) return;
  const s = m.size;
  const v = { id: nextId++, kind, shape, name: `${kind === "negative" ? "Negative" : "Modifier"} ${shape}`,
    size: new THREE.Vector3(Math.max(2, s.x * 0.5), Math.max(2, s.y * 0.5), Math.max(2, s.z * 0.5)),
    pos: new THREE.Vector3(0, 0, s.z / 2), overrides: {} };
  if (kind === "modifier") v.overrides.sparse_infill_density = "40%";   // a sensible start, change it below
  v.geo = volumeGeo(v);
  m.volumes.push(v);
  selectedVolume = v;
  plateChanged();
  refresh();
  flash(kind === "negative" ? "Negative part added: it is cut away from the part when slicing." : "Modifier added: its settings apply inside it.", "ok");
}

function renderVolumePanel() {
  const v = selectedVolume, el = $("vol-panel");
  el.hidden = !v;
  if (!v) return;
  $("vol-name").textContent = v.name;
  $("vol-kind").textContent = v.kind === "negative" ? "Negative part: cut away from the part" : "Modifier: these settings apply inside it";
  const set = (id, val) => { if (!focusedInput(id)) $(id).value = +val.toFixed(2); };
  set("v-sx", v.size.x); set("v-sy", v.size.y); set("v-sz", v.size.z);
  set("v-px", v.pos.x); set("v-py", v.pos.y); set("v-pz", v.pos.z);
  $("vol-settings-wrap").hidden = v.kind === "negative";
  if (volEditor.vol !== v) { volEditor.vol = v; volEditor.render(); }
}

function volumeChanged() {
  const v = selectedVolume;
  if (!v) return;
  const n = (id) => parseFloat($(id).value);
  const size = new THREE.Vector3(n("v-sx"), n("v-sy"), n("v-sz"));
  if ([size.x, size.y, size.z].every((x) => x > 0)) v.size.copy(size);
  const pos = new THREE.Vector3(n("v-px"), n("v-py"), n("v-pz"));
  if ([pos.x, pos.y, pos.z].every(Number.isFinite)) v.pos.copy(pos);
  v.geo.dispose();
  v.geo = volumeGeo(v);
  plateChanged();
  refresh();
}

/* ---- cut at a height */

let cutPlane = null;
function openCut() {
  const m = selected;
  if (!m) return;
  const dlg = $("cut-dlg");
  $("cut-name").textContent = m.name;
  const h = $("cut-h"), r = $("cut-range");
  r.max = h.max = m.size.z.toFixed(2);
  h.value = r.value = (m.size.z / 2).toFixed(2);
  const c = selectedCopy();
  cutPlane = new THREE.Mesh(new THREE.PlaneGeometry(m.size.x * 1.3 + 4, m.size.y * 1.3 + 4),
    new THREE.MeshBasicMaterial({ color: css("--accent"), transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
  cutPlane.position.set(c.position.x, c.position.y, m.size.z / 2);
  view.scene.add(cutPlane);
  const sync = (src) => { (src === h ? r : h).value = src.value; cutPlane.position.z = parseFloat(src.value) || 0; };
  h.oninput = () => sync(h);
  r.oninput = () => sync(r);
  dlg.returnValue = "";
  dlg.show();      // not modal: the plate stays visible with the cut plane
  dlg.onclose = () => {
    view.scene.remove(cutPlane);
    cutPlane = null;
    if (dlg.returnValue === "ok") doCut(m, parseFloat(h.value), $("cut-keep").value, $("cut-flip").checked);
  };
}

function doCut(m, height, keep, flip) {
  if (!models.includes(m) || !(height > 0) || !(height < m.size.z)) { flash("Pick a height inside the part.", "warn"); return; }
  busy("Cutting…");
  setTimeout(() => {
    try {
      const g = bakedGeo(m);
      const { top, bottom, openLoops } = MO.cutAtZ(g, m.local.z0 + height, { capTop: true, capBottom: true });
      const base = selectedCopy().position.clone();
      removeModel(m);
      const made = [];
      if (bottom && keep !== "top") {
        const r = addModel(`${m.name} (bottom)`, bottom, null, m);
        r.m.meshes[0].position.set(base.x + r.center.x, base.y + r.center.y, 0);
        made.push(r.m);
      }
      if (top && keep !== "bottom") {
        const t = flip ? MO.bake(top, new THREE.Matrix4().makeRotationX(Math.PI)) : top;
        const r = addModel(`${m.name} (top)`, t, null, m);
        r.m.meshes[0].position.set(base.x + r.center.x + (keep === "both" ? m.size.x + GAP : 0), base.y + r.center.y, 0);
        made.push(r.m);
      }
      selected = made[0] || null; multi.clear();
      settle(made.flatMap((x) => x.meshes));
      flash(openLoops ? `Cut, but ${openLoops} cut outline(s) weren't closed (the model has holes): try Fix model first.` : "Cut done", openLoops ? "warn" : "ok");
    } catch (e) { flash(`Couldn't cut: ${e.message}`, "err"); } finally { busy(null); }
  }, 20);
}

/* ---- painting supports and seams */

const paint = { on: false, model: null, target: "supports", tool: 1, radius: 3, centroids: null, painting: false };
const PAINT_COLOURS = {
  supports: { 0: [0.55, 0.58, 0.65], 1: [0.18, 0.75, 0.35], 2: [0.9, 0.25, 0.3] },
  seam: { 0: [0.55, 0.58, 0.65], 1: [0.3, 0.55, 1.0], 2: [0.95, 0.6, 0.15] },
};
let paintMat = null;

function startPaint(target) {
  const m = selected;
  if (!m) return;
  if (paint.on) stopPaint();
  busy("Preparing the surface for painting…");
  setTimeout(() => {
    try {
      // fine triangles to paint on: split until edges are about 1/80 of the part (never below 0.5 mm, at most 400k triangles)
      if (!m.paint?.fine) {
        const s = Math.max(m.scale.x, m.scale.y, m.scale.z);
        const edge = Math.max(0.5, Math.max(m.size.x, m.size.y, m.size.z) / 80) / s;
        const old = m.paint;
        const r = MO.subdivide(m.geo, edge, 400000);
        const remap = (arr) => (arr ? Uint8Array.from(r.parent, (pi) => arr[pi]) : null);
        r.geo.computeVertexNormals();
        r.geo.computeBoundingSphere();
        m.geo.dispose();
        m.geo = r.geo;
        for (const mesh of m.meshes) mesh.geometry = r.geo;
        m.paint = { supports: remap(old?.supports), seam: remap(old?.seam), fine: true };
      }
      const tris = m.geo.getAttribute("position").count / 3;
      m.paint[target] ||= new Uint8Array(tris);
      const p = m.geo.getAttribute("position").array;
      const cen = new Float32Array(tris * 3);
      for (let t = 0; t < tris; t++) for (let k = 0; k < 3; k++) cen[t * 3 + k] = (p[t * 9 + k] + p[t * 9 + 3 + k] + p[t * 9 + 6 + k]) / 3;
      Object.assign(paint, { on: true, model: m, target, tool: 1, centroids: cen });
      if (!m.geo.getAttribute("color")) m.geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(tris * 9), 3));
      recolour(m);
      paintMat ||= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.02 });
      for (const mesh of m.meshes) mesh.material = paintMat;
      $("paint-panel").hidden = false;
      $("paint-title").textContent = target === "supports" ? "Paint supports" : "Paint seam";
      $("paint-t1").textContent = target === "supports" ? "Enforce" : "Seam here";
      $("paint-t2").textContent = target === "supports" ? "Block" : "Avoid";
      $("paint-overhangs").hidden = target !== "supports";
      $("paint-note").textContent = target === "supports"
        ? "Green = always support here, red = never. With supports set to \"manual\" in the print settings, supports go only where you've painted green."
        : "Blue = put the seam here, orange = keep the seam away.";
      setPaintTool(1);
      setPickMode(false);
      refresh();
    } catch (e) { flash(`Couldn't start painting: ${e.message}`, "err"); } finally { busy(null); }
  }, 20);
}

function stopPaint() {
  if (!paint.on) return;
  const m = paint.model;
  paint.on = false; paint.model = null; paint.centroids = null;
  $("paint-panel").hidden = true;
  if (m) {
    const any = (a) => a && a.some((x) => x);
    if (!any(m.paint?.supports)) m.paint.supports = null;
    if (!any(m.paint?.seam)) m.paint.seam = null;
  }
  refresh();
}

function setPaintTool(t) {
  paint.tool = t;
  for (const b of document.querySelectorAll("[data-paint-tool]")) b.classList.toggle("on", Number(b.dataset.paintTool) === t);
}

function recolour(m, only = null) {
  const col = m.geo.getAttribute("color"), arr = col.array, st = m.paint[paint.target], pal = PAINT_COLOURS[paint.target];
  const one = (t) => { const c = pal[st[t]] || pal[0]; for (let k = 0; k < 3; k++) arr.set(c, t * 9 + k * 3); };
  if (only) for (const t of only) one(t); else for (let t = 0; t < st.length; t++) one(t);
  col.needsUpdate = true;
}

function paintAt(e) {
  const m = paint.model;
  const hit = rayFrom(e).intersectObjects(m.meshes, false)[0];
  if (!hit) return false;
  const local = hit.object.worldToLocal(hit.point.clone());
  const s = (m.scale.x + m.scale.y + m.scale.z) / 3;
  const r2 = (paint.radius / s) ** 2;
  const cen = paint.centroids, st = m.paint[paint.target], val = paint.tool;
  const changed = [];
  for (let t = 0, n = st.length; t < n; t++) {
    const dx = cen[t * 3] - local.x, dy = cen[t * 3 + 1] - local.y, dz = cen[t * 3 + 2] - local.z;
    if (dx * dx + dy * dy + dz * dz <= r2 && st[t] !== val) { st[t] = val; changed.push(t); }
  }
  if (hit.faceIndex != null && st[hit.faceIndex] !== val) { st[hit.faceIndex] = val; changed.push(hit.faceIndex); }
  if (changed.length) recolour(m, changed);
  return true;
}

function paintOverhangs() {
  const m = paint.model;
  if (!m) return;
  const ang = parseFloat(S.edits.process?.support_threshold_angle ?? S.detail.process?.values?.support_threshold_angle) || 30;
  const idx = MO.overhangTriangles(m.geo, new THREE.Matrix4().compose(new THREE.Vector3(), m.quat, m.scale), ang);
  const st = m.paint.supports;
  for (const t of idx) st[t] = 1;
  recolour(m);
  plateChanged();
  flash(`Painted ${idx.length.toLocaleString()} overhanging triangles (steeper than ${ang}°)`, "ok");
}

/* ================================================================ G-code thumbnails */

let thumbRenderer = null;

function filamentColour() {
  const v = S.detail.filament?.values?.filament_colour;
  const c = String(Array.isArray(v) ? v[0] : v || "");
  return /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7) : css("--model");
}

function plateThumbs() {
  // the plate's parts from a three-quarter view, in the filament's colour, on a transparent background
  if (!models.length || !view.scene) return null;
  try {
    thumbRenderer ||= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(1);
    const meshes = models.flatMap((m) => m.meshes);
    const box = new THREE.Box3();
    for (const m of meshes) { m.updateMatrixWorld(true); box.expandByObject(m); }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dist = Math.max(sphere.radius, 1) / Math.sin(THREE.MathUtils.degToRad(15)) * 1.04;
    const cam = new THREE.PerspectiveCamera(30, 1, dist / 100, dist * 4);
    cam.up.set(0, 0, 1);
    cam.position.copy(sphere.center).addScaledVector(new THREE.Vector3(0.9, -1.2, 1).normalize(), dist);
    cam.lookAt(sphere.center);
    const mat = new THREE.MeshStandardMaterial({ color: filamentColour(), roughness: 0.55, metalness: 0.05 });
    const meshState = meshes.map((m) => [m, m.material, m.visible]);
    const others = [view.bedGroup, view.preview?.group].filter(Boolean).map((o) => [o, o.visible]);
    for (const [o] of others) o.visible = false;
    for (const m of meshes) { m.material = mat; m.visible = true; }
    const out = {};
    for (const [w, h] of [[32, 32], [300, 300]]) {
      thumbRenderer.setSize(w, h, false);
      thumbRenderer.render(view.scene, cam);
      out[`${w}x${h}`] = thumbRenderer.domElement.toDataURL("image/png").split(",")[1];
    }
    for (const [m, mt, v] of meshState) { m.material = mt; m.visible = v; }
    for (const [o, v] of others) o.visible = v;
    mat.dispose();
    return out;
  } catch {
    return null;            // no preview is better than no slice
  }
}

/* ================================================================ keyboard shortcuts */
// Modelled on OrcaSlicer's. Ctrl means Cmd on a Mac. Slice is Ctrl+Enter because Ctrl+R reloads a browser page.

let clipboardModel = null;

function viewFrom(dir) {
  const r = Math.hypot(bed.w, bed.d) * 1.15;
  const c = new THREE.Vector3(bed.w / 2, bed.d / 2, 0);
  const d = { top: [0, -0.001, 1], front: [0, -1, 0.25], back: [0, 1, 0.25], left: [-1, 0, 0.25], right: [1, 0, 0.25] }[dir];
  view.camera.position.copy(c).addScaledVector(new THREE.Vector3(...d).normalize(), r);
  view.controls.target.copy(c);
  view.controls.update();
}

function nudge(dx, dy) {
  if (!selected) return;
  for (const mesh of selected.meshes) { mesh.position.x += dx; mesh.position.y += dy; }
  plateChanged();
  refresh();
}

function pasteModel() {
  const src = clipboardModel;
  if (!src || !models.includes(src) && !src.geo) return;
  const m = newModelRecord(src.name, src.geo.clone());
  m.quat.copy(src.quat);
  m.scale.copy(src.scale);
  m.overrides = JSON.parse(JSON.stringify(src.overrides || {}));
  m.printable = src.printable !== false;
  m.volumes = (src.volumes || []).map((v) => ({ ...v, id: nextId++, size: v.size.clone(), pos: v.pos.clone(), overrides: { ...v.overrides }, geo: v.geo.clone() }));
  if (src.paint) m.paint = { supports: src.paint.supports?.slice() || null, seam: src.paint.seam?.slice() || null };
  models.push(m);
  setCopies(m, 1);
  updateBox(m);
  const ref = src.meshes[src.meshes.length - 1];
  if (ref) { m.meshes[0].position.x = ref.position.x + m.size.x + GAP; m.meshes[0].position.y = ref.position.y; }
  selected = m;
  settle(m.meshes);
  flash(`Pasted ${m.name}`, "ok");
}

function onKey(e) {
  const t = e.target;
  if (t.closest?.("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key;
  const handled = () => e.preventDefault();
  if (ctrl) {
    const lower = k.toLowerCase();
    if (k === "Enter") { handled(); $("slice").click(); }
    else if (lower === "s") { handled(); saveProject(e.shiftKey); }
    else if (lower === "o") { handled(); openProjects().catch((err) => flash(err.message, "err")); }
    else if (lower === "i") { handled(); document.querySelector(".file-input")?.click(); }
    else if (lower === "c" && selected && !window.getSelection()?.toString()) { handled(); clipboardModel = selected; flash(`Copied ${selected.name}`, "ok"); }
    else if (lower === "v" && clipboardModel) { handled(); pasteModel(); }
    else if (k === "Delete" || k === "Backspace") { handled(); $("clear").click(); }
    return;
  }
  if (e.altKey) return;
  if (k === "?") { handled(); $("keys").showModal(); return; }
  if (k === "Tab" && view.preview?.loaded) { handled(); setViewMode(viewMode === "preview" ? "model" : "preview"); return; }
  if (viewMode === "preview") {
    if (k === "ArrowUp" || k === "ArrowDown") {
      handled();
      view.preview.setLayer(view.preview.layer + (k === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1));
      renderLayerInfo();
      return;
    }
  }
  switch (k) {
    case "Escape": if (paint.on) stopPaint(); else if (pickMode) setPickMode(false); else { selected = null; multi.clear(); selectedVolume = null; refresh(); } break;
    case "Delete": case "Backspace": if (selected || multi.size) { handled(); $("obj-delete").click(); } return;
    case "a": case "A": if (models.length) { handled(); arrange(); } return;
    case "f": case "F": if (selected) { handled(); setPickMode(!pickMode); } return;
    case "r": case "R":
      if (selected) { handled(); rotateModel(selected, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (e.shiftKey ? -1 : 1) * Math.PI / 4)); }
      return;
    case "+": case "=": if (selected) { handled(); $("copy-plus").click(); } return;
    case "-": case "_": if (selected) { handled(); $("copy-minus").click(); } return;
    case "ArrowLeft": case "ArrowRight": case "ArrowUp": case "ArrowDown":
      if (selected) {
        handled();
        const step = e.shiftKey ? 10 : 1;
        nudge(k === "ArrowLeft" ? -step : k === "ArrowRight" ? step : 0, k === "ArrowUp" ? step : k === "ArrowDown" ? -step : 0);
      }
      return;
    case "0": handled(); fitView(); return;
    case "1": handled(); viewFrom("top"); return;
    case "3": handled(); viewFrom("front"); return;
    case "4": handled(); viewFrom("back"); return;
    case "5": handled(); viewFrom("left"); return;
    case "6": handled(); viewFrom("right"); return;
    case "z": case "Z": handled(); if (selected) focusModel(selected); else fitView(); return;
  }
}
window.addEventListener("keydown", onKey);

/* ================================================================ main button */
// One button that follows the job, like OrcaSlicer's: Slice -> Send to <printer>... -> Start print -> Open <printer>.

let slicing = false;
let actionRunning = false;

function mainState() {
  if (slicing) return { label: "Slicing…", disabled: true };
  const job = currentJob;
  if (job?.status === "done" && job.plates?.length && jobIsCurrent()) {
    const pr = printerStatus();
    const p = job.plates.find((x) => !x.started);
    if (!p) return printerUrl() ? { label: `Open ${pr.name || "printer"}`, act: "open" } : { label: "Printing", disabled: true };
    if (!pr.configured) return { label: "Add a printer…", act: "printers", plate: p.plate };
    if (!p.uploaded) return { label: `Send to ${pr.name}…`, act: "send", plate: p.plate, ready: true };
    const ready = pr.idle && (!p.uploaded_to || p.uploaded_to === pr.id);
    return { label: ready ? "Start print" : pr.online ? `${pr.name} is busy` : `${pr.name} is offline`, act: "start", plate: p.plate, disabled: !ready, ready };
  }
  return { label: "Slice", act: "slice", disabled: !(models.length && layoutOk().fits) };
}

function updateMainButton() {
  if (actionRunning) return;          // keep the spinner while sending/starting
  const st = mainState();
  const b = $("slice");
  b.textContent = st.label;
  b.disabled = !!st.disabled;
  b.dataset.act = st.act || "";
  b.dataset.plate = st.plate ?? "";
  b.classList.toggle("go", !!st.ready);
}

/* ================================================================ send dialog */

function sendDialog(p) {
  // like OrcaSlicer's upload dialog: send and start printing, or just send the file
  const pr = printerStatus();
  return new Promise((resolve) => {
    const dlg = $("send");
    $("send-text").textContent = `Send ${p ? fmtTime(p.time_s) + " of printing" : "this plate"} to ${pr.name}.`;
    const printBtn = $("send-print");
    printBtn.disabled = !pr.idle;
    $("send-note").textContent = pr.idle ? "Make sure the bed is clear before starting."
      : `${pr.name} can't start now (${pr.online ? pr.message || pr.state || "busy" : "offline"}). You can still send the file and start it later.`;
    dlg.returnValue = "";
    dlg.showModal();
    (pr.idle ? printBtn : $("send-only")).focus();
    dlg.addEventListener("close", () => resolve(["print", "send"].includes(dlg.returnValue) ? dlg.returnValue : null), { once: true });
  });
}

/* ================================================================ projects */

let project = null;            // {id, name} of the open project, or null for an unsaved plate
let savedVersion = 0;          // plateVersion when the project was last saved or opened
const projectDirty = () => models.length > 0 && plateVersion !== savedVersion;

function updateProjectLabel() {
  const el = $("project-name");
  if (!el) return;
  el.textContent = project ? project.name : models.length ? "Unsaved plate" : "";
  el.classList.toggle("dirty", projectDirty());
  el.title = projectDirty() ? "Unsaved changes" : "";
}

const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

function meshStl(geo) {
  // the part's own mesh (centred, unrotated, unscaled) as binary STL
  const p = geo.getAttribute("position").array;
  const tris = p.length / 9;
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris, true);
  let o = 84;
  for (let i = 0; i < p.length; i += 9) {
    o += 12;
    for (let k = 0; k < 9; k++) { dv.setFloat32(o, p[i + k], true); o += 4; }
    o += 2;
  }
  return new Blob([buf], { type: "model/stl" });
}

function thumbnail() {
  // render the plate (models, not toolpaths) into a small PNG
  return new Promise((resolve) => {
    const wasPreview = viewMode === "preview";
    if (wasPreview) setViewMode("model");
    const prevSel = selected;
    selected = null;
    refresh();
    view.renderer.render(view.scene, view.camera);
    const src = view.renderer.domElement;
    const c = document.createElement("canvas");
    c.width = 360; c.height = 240;
    const ctx = c.getContext("2d");
    const s = Math.max(c.width / src.width, c.height / src.height);
    ctx.drawImage(src, (c.width - src.width * s) / 2, (c.height - src.height * s) / 2, src.width * s, src.height * s);
    selected = prevSel;
    refresh();
    if (wasPreview) setViewMode("preview");
    c.toBlob((b) => resolve(b), "image/png");
  });
}

async function saveProject(asNew) {
  if (!models.length) { toast("Add a model first.", "warn"); return; }
  let name = project?.name;
  if (asNew || !project) {
    name = await ask(asNew && project ? "Save a copy as" : "Save project as", project ? `${project.name} copy` : plateName(), "Save");
    if (!name) return;
  }
  const version = plateVersion;
  const meta = {
    id: asNew ? undefined : project?.id, name,
    presets: { ...S.selected, bed_type: S.bedType }, edits: S.edits,
    models: models.map((m, i) => ({
      mid: i, name: m.name, quat: m.quat.toArray(), scale: m.scale.toArray(), overrides: m.overrides, printable: m.printable !== false,
      volumes: m.volumes.map((v) => ({ name: v.name, kind: v.kind, shape: v.shape, size: v.size.toArray(), pos: v.pos.toArray(), overrides: v.overrides })),
      paint: m.paint ? { supports: m.paint.supports ? b64(m.paint.supports) : null, seam: m.paint.seam ? b64(m.paint.seam) : null } : null,
      instances: m.meshes.map((x) => [+x.position.x.toFixed(3), +x.position.y.toFixed(3)]),
    })),
  };
  const fd = new FormData();
  fd.append("project", new Blob([JSON.stringify(meta)], { type: "application/json" }), "project.json");
  models.forEach((m, i) => fd.append(`mesh_${i}`, meshStl(m.geo), `${i}.stl`));
  busy("Saving project…");
  try {
    const thumb = await thumbnail();
    if (thumb) fd.append("thumb", thumb, "thumb.png");
    const r = await apiJson("/api/projects", { method: "POST", body: fd });
    project = { id: r.id, name: r.name };
    savedVersion = version;
    updateProjectLabel();
    toast(`Saved "${r.name}"`);
    if ($("projects").open) await loadProjectList();
  } catch (e) { toast(e.message, "err"); } finally { busy(null); }
}

async function openProject(id) {
  if (projectDirty() && !(await confirmBox("Open this project? Unsaved changes to the current plate will be lost.", "Open"))) return;
  busy("Opening project…");
  try {
    const meta = await apiJson(`/api/projects/${id}`);
    $("projects").close();
    clearPlate();
    const missing = await applyProjectPresets(meta.presets, meta.edits);
    if (!view.renderer) initViewer();
    for (const pm of meta.models) {
      const buf = await (await api(`/api/projects/${id}/mesh/${pm.mid}`)).arrayBuffer();
      const geo = mergeToGeometry(new THREE.Mesh(new STLLoader().parse(buf)));
      const m = newModelRecord(pm.name, geo);
      m.quat.fromArray(pm.quat || [0, 0, 0, 1]);
      if (Array.isArray(pm.scale)) m.scale.fromArray(pm.scale); else m.scale.setScalar(pm.scale || 1);
      m.overrides = pm.overrides || {};
      m.printable = pm.printable !== false;
      m.volumes = (pm.volumes || []).map((v) => {
        const vol = { id: nextId++, name: v.name, kind: v.kind, shape: v.shape, size: new THREE.Vector3().fromArray(v.size),
          pos: new THREE.Vector3().fromArray(v.pos), overrides: v.overrides || {} };
        vol.geo = volumeGeo(vol);
        return vol;
      });
      // painted triangles line up with the saved mesh only if it wasn't recentred differently: the mesh is stored centred
      const tris = geo.getAttribute("position").count / 3;
      const unb = (x) => { const a = x ? unb64(x) : null; return a && a.length === tris ? a : null; };
      if (pm.paint) m.paint = { supports: unb(pm.paint.supports), seam: unb(pm.paint.seam) };
      models.push(m);
      setCopies(m, (pm.instances || [[bed.w / 2, bed.d / 2]]).length);
      updateBox(m);
      (pm.instances || []).forEach((xy, k) => { if (m.meshes[k]) { m.meshes[k].position.x = xy[0]; m.meshes[k].position.y = xy[1]; } });
    }
    selected = null;
    plateChanged();
    project = { id: meta.id, name: meta.name };
    savedVersion = plateVersion;
    refresh();
    fitView();
    updateProjectLabel();
    toast(missing.length ? `Opened "${meta.name}", but ${missing.join(", ")} isn't available here: using the current one instead.` : `Opened "${meta.name}"`, missing.length ? "warn" : "ok");
  } catch (e) { toast(e.message, "err"); } finally { busy(null); }
}

const fmtDate = (t) => (t ? new Date(t * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

async function loadProjectList() {
  const rows = await apiJson("/api/projects");
  $("pj-list").innerHTML = rows.length ? rows.map((r) => `
    <div class="pj-card${project?.id === r.id ? " current" : ""}">
      <button class="pj-open" data-pj-open="${r.id}" type="button" aria-label="Open ${esc(r.name)}">
        ${r.thumb ? `<img src="/api/projects/${r.id}/thumb.png?t=${r.updated}" alt="" loading="lazy">` : `<span class="pj-noimg">No preview</span>`}
      </button>
      <div class="pj-info"><b>${esc(r.name)}</b><span class="muted small">${r.parts} part${r.parts === 1 ? "" : "s"} · ${esc(fmtDate(r.updated))}</span>
        ${r.machine ? `<span class="muted small">${esc(r.machine)}</span>` : ""}</div>
      <div class="pj-actions">
        <button class="btn" data-pj-open="${r.id}" type="button">Open</button>
        <button class="btn" data-pj-rename="${r.id}" data-name="${esc(r.name)}" type="button">Rename</button>
        <button class="btn danger" data-pj-delete="${r.id}" data-name="${esc(r.name)}" type="button">Delete</button>
      </div>
    </div>`).join("") : `<p class="muted">No saved projects yet. Lay out a plate, then Save.</p>`;
  $("pj-save").disabled = !models.length;
  $("pj-save").textContent = project ? `Save "${project.name}"` : "Save plate…";
  $("pj-saveas").hidden = !project;
}

async function openProjects() {
  $("projects").showModal();
  await loadProjectList();
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
  const m = models.find((x) => String(x.id) === li.dataset.id) || null;
  const vol = li.dataset.vol && m ? m.volumes.find((v) => String(v.id) === li.dataset.vol) : null;
  pickPart(m, null, e.shiftKey || e.ctrlKey || e.metaKey, vol);
  if (selected && !e.shiftKey && !e.ctrlKey && !e.metaKey) focusModel(selected);
});
$("arrange").addEventListener("click", arrange);
$("view-reset").addEventListener("click", fitView);
function clearPlate() {
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
}
$("clear").addEventListener("click", async () => {
  if (projectDirty() && !(await confirmBox("Clear the plate? Unsaved changes to this project will be lost.", "Clear", true))) return;
  clearPlate();
  project = null;
  savedVersion = plateVersion;
  updateProjectLabel();
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
  if (!(v >= 1 && v <= 2000)) { refresh(); return; }
  selected.scale.setScalar(v / 100);
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
  if (selectedVolume) { selected.volumes.splice(selected.volumes.indexOf(selectedVolume), 1); selectedVolume = null; plateChanged(); refresh(); return; }
  const list = selection();
  if (!list.length) return;
  if (paint.on && list.includes(paint.model)) stopPaint();
  for (const m of list) removeModel(m);
  selected = null;
  multi.clear();
  plateChanged();
  refresh();
});
// transforms
for (const [id, axis] of [["t-x", "x"], ["t-y", "y"]]) $(id).addEventListener("change", (e) => setPosition(axis, parseFloat(e.target.value)));
for (const id of ["t-rx", "t-ry", "t-rz"]) $(id).addEventListener("change", () => selected && setRotation());
for (const [id, axis] of [["t-sx", "x"], ["t-sy", "y"], ["t-sz", "z"]]) $(id).addEventListener("change", (e) => selected && setSize(axis, parseFloat(e.target.value)));
$("t-printable").addEventListener("change", togglePrintable);
$("t-ears").addEventListener("change", toggleEars);
// modifier / negative part panel
for (const id of ["v-sx", "v-sy", "v-sz", "v-px", "v-py", "v-pz"]) $(id).addEventListener("change", volumeChanged);
$("vol-back").addEventListener("click", () => { selectedVolume = null; refresh(); });
$("vol-remove").addEventListener("click", () => $("obj-delete").click());
const volEditor = createPartEditor($("vol-settings"), () => (selectedVolume?.kind === "modifier" ? selectedVolume.overrides : null), () => { plateChanged(); refresh(); });
$("vol-add").addEventListener("click", async () => {
  const v = selectedVolume;
  if (!v) return;
  const key = await pickPartSetting(Object.keys(v.overrides));
  if (!key || selectedVolume !== v) return;
  v.overrides[key] = processValue(key);
  volEditor.render();
  plateChanged();
  refresh();
});
// painting panel
for (const b of document.querySelectorAll("[data-paint-tool]")) b.addEventListener("click", () => setPaintTool(Number(b.dataset.paintTool)));
$("paint-radius").addEventListener("input", (e) => { paint.radius = parseFloat(e.target.value) || 3; $("paint-radius-val").textContent = `${paint.radius} mm`; });
$("paint-overhangs").addEventListener("click", paintOverhangs);
$("paint-clear").addEventListener("click", () => { const m = paint.model; if (!m) return; m.paint[paint.target].fill(0); recolour(m); plateChanged(); });
$("paint-done").addEventListener("click", stopPaint);
$("open-projects").addEventListener("click", () => openProjects().catch((e) => toast(e.message, "err")));
$("save-project").addEventListener("click", () => saveProject(false));
$("pj-close").addEventListener("click", () => $("projects").close());
$("pj-save").addEventListener("click", () => saveProject(false));
$("pj-saveas").addEventListener("click", () => saveProject(true));
$("pj-list").addEventListener("click", async (e) => {
  const o = e.target.closest("[data-pj-open]");
  if (o) { openProject(o.dataset.pjOpen); return; }
  const r = e.target.closest("[data-pj-rename]");
  if (r) {
    const name = await ask("Rename project", r.dataset.name, "Rename");
    if (!name) return;
    try {
      await postJson(`/api/projects/${r.dataset.pjRename}/rename`, { name });
      if (project?.id === r.dataset.pjRename) { project.name = name; updateProjectLabel(); }
      await loadProjectList();
    } catch (err) { toast(err.message, "err"); }
    return;
  }
  const d = e.target.closest("[data-pj-delete]");
  if (d && await confirmBox(`Delete the project "${d.dataset.name}"? This can't be undone.`, "Delete", true)) {
    try {
      await api(`/api/projects/${d.dataset.pjDelete}`, { method: "DELETE" });
      if (project?.id === d.dataset.pjDelete) { project = null; updateProjectLabel(); }
      await loadProjectList();
    } catch (err) { toast(err.message, "err"); }
  }
});
window.addEventListener("beforeunload", (e) => { if (projectDirty()) { e.preventDefault(); e.returnValue = ""; } });
// Drag and drop: model files dropped anywhere on the page go onto the plate, like + Add.
{
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  const show = (on) => { $("drop-overlay").hidden = !on; };
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; show(true); });
  window.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) show(false); });
  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();          // don't let the browser open the file instead
    depth = 0;
    show(false);
    if (document.querySelector("dialog[open]")) return;   // a window is open: leave the plate alone
    const files = [...e.dataTransfer.files];
    if (files.length) await addFiles(files);
  });
}

$("slice").addEventListener("click", async () => {
  const b = $("slice");
  const act = b.dataset.act;
  if (act === "slice") return slice();
  if (act === "open") { window.open(printerUrl(), "_blank", "noopener"); return; }
  if (!act) return;
  actionRunning = true;
  try { await plateAction(act, b.dataset.plate, b); } finally { actionRunning = false; updateMainButton(); }
});
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
