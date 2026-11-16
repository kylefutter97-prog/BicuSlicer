import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { zipSync, unzipSync, strToU8 } from "three/addons/libs/fflate.module.js";
import { readProject3mf, paintState, projectPlateOrigin, transformPositions } from "./project3mf.js";
import { $, esc, api, apiJson, postJson, confirmBox, ask, toast, saveBlob } from "./util.js";
import { initSettings, S, bedChoices, projectSettingsDiff, applyProcessEdits, applyFilamentEdits, filamentValue, machineValues, createPartEditor, pickPartSetting, processValue, partOptionsAvailable, applyProjectPresets } from "./settings.js";
import { Preview } from "./preview.js";
import * as MO from "./meshops.js";
import * as LH from "./layerheight.js";
import * as CAL from "./calibration.js";
import { readStep } from "./step.js";
import { initPrinters, printerStatus, refreshPrinter, openPrinters, openPrinterView } from "./printers.js";

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const DOWN = new THREE.Vector3(0, 0, -1);
const GAP = 6;          // mm between parts when arranging
const MAX_COPIES = 50;

// Every change to the plate bumps this (for "unsaved changes"). Whether a plate's slice is still valid is decided
// by plateKey(): a slice remembers the key of the plate it was made from, and a result whose key no longer
// matches can't be sent or printed until that plate is sliced again.
let plateVersion = 0;
let settingsVersion = 0;      // bumped when presets or setting edits change: every plate's slice is out of date

// Plates sit side by side, like OrcaSlicer's: plate i's bed starts at x = plateX(i). A copy of a part belongs to
// the plate its centre is over, so dragging it across moves it to that plate. Each plate is sliced on its own.
let nextPlateId = 1;
function newPlate() {
  // gcodes: G-code at chosen heights [{ z, type: "pause" | "custom", gcode, note }]; calib: the calibration test it holds
  return { id: nextPlateId++, name: "", bedType: "", seq: "", spiral: "", gcodes: [], calib: null, job: null, jobKey: null };
}
const plates = [newPlate()];
let cur = 0;                  // the current plate (index)
const curJob = () => plates[cur]?.job || null;
const jobIsCurrent = (i = cur) => !!plates[i]?.job && plates[i].jobKey === plateKey(i);
const slicingPlates = new Set();      // plate ids being sliced

/* ================================================================ scene */

const bed = { w: 220, d: 220, h: 300 };
const plateGap = () => Math.max(20, Math.round(bed.w * 0.15));
const plateX = (i) => i * (bed.w + plateGap());
const plateAt = (x) => Math.max(0, Math.min(plates.length - 1, Math.round((x - bed.w / 2) / (bed.w + plateGap()))));
const plateOf = (mesh) => plateAt(mesh.position.x);
const meshesOn = (i) => models.flatMap((m) => m.meshes.filter((x) => plateOf(x) === i));
const modelsOn = (i) => models.filter((m) => m.meshes.some((x) => plateOf(x) === i));
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
  const keep = models.flatMap((m) => m.meshes.map((x) => { const i = plateOf(x); return [x, i, x.position.x - plateX(i)]; }));
  const v = machineValues();
  const pts = (v.printable_area || []).map((p) => String(p).split("x").map(Number));
  if (pts.length >= 3 && pts.every((p) => p.length === 2 && p.every(Number.isFinite))) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    bed.w = Math.max(...xs) - Math.min(...xs);
    bed.d = Math.max(...ys) - Math.min(...ys);
  }
  bed.h = parseFloat(v.printable_height) || 300;
  for (const [x, i, lx] of keep) x.position.x = plateX(i) + lx;
  placePreview();
  drawBed();
  if (models.length) { const bad = layoutOk().bad; if (bad.size) for (const i of bad) arrange(i); else refresh(); }
}

function drawBed() {
  if (!view.scene) return;
  if (view.bedGroup) { view.scene.remove(view.bedGroup); view.bedGroup.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); }); }
  const g = new THREE.Group();
  const size = Math.max(bed.w, bed.d);
  plates.forEach((p, i) => {
    const ox = plateX(i), on = i === cur;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(bed.w, bed.d),
      new THREE.MeshBasicMaterial({ color: css("--bed"), transparent: true, opacity: on || plates.length === 1 ? 0.6 : 0.3, side: THREE.DoubleSide }));
    plate.position.set(ox + bed.w / 2, bed.d / 2, -0.05);
    plate.userData.bed = i;
    g.add(plate);
    const grid = new THREE.GridHelper(size, Math.round(size / 10), css("--muted"), css("--muted"));
    grid.rotation.x = Math.PI / 2;
    grid.position.set(ox + bed.w / 2, bed.d / 2, 0);
    grid.material.transparent = true; grid.material.opacity = on ? 0.25 : 0.12;
    g.add(grid);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(bed.w, bed.d, 0.01)),
      new THREE.LineBasicMaterial({ color: on && plates.length > 1 ? css("--accent") : css("--muted") }));
    edge.position.set(ox + bed.w / 2, bed.d / 2, 0);
    g.add(edge);
    if (plates.length > 1) g.add(plateLabel(`${i + 1}${p.name ? " · " + p.name : ""}`, ox, on));
  });
  view.bedGroup = g;
  view.scene.add(g);
}

function plateLabel(text, ox, on) {
  // the plate's number, lying flat in front of it
  const c = document.createElement("canvas");
  c.width = 512; c.height = 64;
  const ctx = c.getContext("2d");
  ctx.font = "600 40px system-ui, sans-serif";
  ctx.fillStyle = on ? css("--accent") : css("--muted");
  ctx.textBaseline = "middle";
  ctx.fillText(text.length > 24 ? text.slice(0, 23) + "…" : text, 4, 32);
  const tex = new THREE.CanvasTexture(c);
  const w = Math.min(bed.w, 160), h = w / 8;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.position.set(ox + w / 2, -h / 2 - 4, 0);
  return m;
}

function fitView() {
  const r = Math.hypot(bed.w, bed.d) * 0.85;
  let top = 0;
  for (const m of modelsOn(cur)) top = Math.max(top, m.size?.z ?? 0);
  const cx = plateX(cur) + bed.w / 2;
  view.camera.position.set(cx + r * 0.35, bed.d / 2 - r * 1.15, r * 0.95 + top * 0.6);
  view.controls.target.set(cx, bed.d / 2, Math.min(top / 3, 40));
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
  if (["step", "stp", "iges", "igs"].includes(ext)) {
    // CAD files: OpenCascade turns them into a mesh in the browser; several bodies come in as one part (Split separates them)
    const { bodies } = await readStep(await f.arrayBuffer(), f.name, "normal", (t) => busy(t));
    const group = new THREE.Group();
    for (const b of bodies) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(b.pos, 3));
      group.add(new THREE.Mesh(g));
    }
    const geo = mergeToGeometry(group);
    if (bodies.length > 1) geo.userData.note = `${f.name} has ${bodies.length} bodies, added as one part: use Split to separate them.`;
    return geo;
  }
  throw new Error("use an STL, 3MF, OBJ or STEP file");
}

async function addFiles(files) {
  if (!files.length) return;
  if (!view.renderer) initViewer();
  const problems = [], added = [];
  const ok = /\.(stl|3mf|obj|step|stp|iges|igs)$/i;
  for (const f of files.filter((x) => !ok.test(x.name))) problems.push(`${f.name}: use an STL, 3MF, OBJ or STEP file`);
  const notes = [];
  files = files.filter((x) => ok.test(x.name));
  const projects = [];
  for (const f of files) {
    busy(`Loading ${f.name}…`);
    try {
      if (/\.3mf$/i.test(f.name)) {
        // OrcaSlicer / Bambu projects open with their plates, parts and settings (after the plain files);
        // other 3MFs come in object by object. Anything this reader can't follow falls back to the generic loader.
        let proj = null;
        try { proj = readProject3mf(unzipSync(new Uint8Array(await f.arrayBuffer()))); } catch (e) { console.warn("3MF reader:", e); }
        if (proj?.objects.length) {
          if (proj.isProject) { projects.push([f.name, proj]); continue; }
          for (const ob of proj.objects) for (const { m, copies } of partsFromObject(ob, new Set(S.catalog?.part_options || []), new Set())) {
            models.push(m); setCopies(m, copies.length); updateBox(m);
            added.push(...m.meshes);
            selected = m;
          }
          continue;
        }
      }
      const geo = await parseFile(f);
      if (geo.userData.note) notes.push(geo.userData.note);
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
  if (added.length) { settle(added); fitView(); }
  if (problems.length) flash(problems.join(" · "), "err");
  else if (notes.length) flash(notes.join(" · "), "ok");
  for (const [name, proj] of projects) await openProject3mf(name, proj);
}

/* ---- OrcaSlicer / Bambu Studio / MakerWorld projects */

function geoFrom(pos, flip) {
  // triangle soup -> geometry; a mirroring transform turns faces inside out, so swap two corners back
  if (flip) for (let i = 0; i < pos.length; i += 9) for (let k = 0; k < 3; k++) { const t = pos[i + 3 + k]; pos[i + 3 + k] = pos[i + 6 + k]; pos[i + 6 + k] = t; }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return g;
}

const partSettings = (o, allowed) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => allowed.has(k) && k !== "extruder"));

/** One object of a 3MF -> BicuSlicer parts: copies that share a rotation and scale become one part with copies. */
function partsFromObject(ob, allowed, notes, layers = {}) {
  const out = [];
  const groups = new Map();
  ob.items.forEach((it, i) => { const k = it.transform.slice(0, 9).map((x) => x.toFixed(6)).join(","); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  const normals = ob.parts.filter((p) => p.subtype === "normal_part");
  if (!normals.length) return out;
  for (const p of ob.parts) if (!["normal_part", "modifier_part", "negative_part"].includes(p.subtype)) notes.add(`${p.subtype.replace(/_/g, " ")}s aren't supported yet, so they were left out.`);
  if (normals.length > 1 && normals.some((p) => Object.keys(partSettings(p.settings, allowed)).length))
    notes.add(`${ob.name}: settings of its separate parts apply to the whole part here.`);
  for (const idx of groups.values()) {
    const t0 = ob.items[idx[0]].transform;
    const R = [...t0.slice(0, 9), 0, 0, 0];
    const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
    const total = normals.reduce((n, q) => n + q.pos.length, 0);
    const pos = new Float32Array(total);
    const raw = { supports: null, seam: null, fuzzy: null };
    let off = 0, tri = 0;
    for (const q of normals) {
      pos.set(transformPositions(q.pos, R), off);
      for (const k of PAINT_KINDS) if (q.paint[k]) { raw[k] ||= new Array(total / 9); q.paint[k].forEach((v, i) => { if (v) raw[k][tri + i] = v; }); }
      off += q.pos.length; tri += q.pos.length / 9;
    }
    const geo = geoFrom(pos, det < 0);
    geo.computeBoundingBox();
    const minZ = geo.boundingBox.min.z;
    const c = centered(geo);
    const m = newModelRecord(ob.name, geo);
    m.overrides = { ...partSettings(ob.settings, allowed), ...(normals.length === 1 ? partSettings(normals[0].settings, allowed) : {}) };
    // OrcaSlicer's layer height profile belongs to the first copy's orientation; height ranges are just heights
    if (layers.profile && idx.includes(0)) m.vlh = { mode: "imported", profile: layers.profile, pose: null };
    m.ranges = (layers.ranges || []).map((r) => ({ id: nextId++, from: r.from, to: r.to,
      overrides: Object.fromEntries(Object.entries(r.settings).filter(([k]) => k === "layer_height" || (allowed.has(k) && k !== "extruder"))) }));
    m.printable = ob.items[idx[0]].printable;
    if (PAINT_KINDS.some((k) => raw[k])) {
      const states = (a) => (a ? Uint8Array.from({ length: total / 9 }, (_, i) => (a[i] ? paintState(a[i]) : 0)) : null);
      m.paint = Object.fromEntries(PAINT_KINDS.map((k) => [k, states(raw[k])]));
      if (det > 0) m.paintRaw = raw;      // kept exactly as painted, for the slicer
    }
    for (const q of ob.parts) {
      if (q.subtype !== "modifier_part" && q.subtype !== "negative_part") continue;
      const vg = geoFrom(transformPositions(q.pos, R), det < 0);
      const vc = centered(vg);
      vg.computeBoundingBox();
      const size = vg.boundingBox.getSize(new THREE.Vector3());
      const v = { id: nextId++, kind: q.subtype === "negative_part" ? "negative" : "modifier", shape: "mesh",
        name: q.name || (q.subtype === "negative_part" ? "Negative part" : "Modifier"), size: size.clone(),
        pos: new THREE.Vector3(vc.x - c.x, vc.y - c.y, vc.z - minZ), overrides: q.subtype === "modifier_part" ? partSettings(q.settings, allowed) : {},
        base: vg, baseSize: size.clone() };
      v.geo = volumeGeo(v);
      m.volumes.push(v);
    }
    // each copy's centre where the project had it: the transform moves the (rotated) centre c by its translation
    if (m.vlh) m.vlh.pose = poseKey(m);
    out.push({ m, copies: idx.map((i) => ({ item: i, x: c.x + ob.items[i].transform[9], y: c.y + ob.items[i].transform[10] })) });
  }
  return out;
}

function importDialog(name, proj, diff) {
  const dlg = $("import-dlg");
  const parts = proj.objects.reduce((n, o) => n + o.items.length, 0);
  const nPlates = Math.max(1, proj.plates.length);
  const painted = proj.objects.some((o) => o.parts.some((p) => p.paint.supports || p.paint.seam || p.paint.fuzzy));
  const mods = proj.objects.reduce((n, o) => n + o.parts.filter((p) => p.subtype !== "normal_part").length, 0);
  const own = proj.objects.filter((o) => Object.keys(o.settings).length || o.parts.some((p) => Object.keys(p.settings).length)).length;
  const made = [proj.settings?.printer_settings_id, proj.settings?.print_settings_id].filter(Boolean).map(String);
  $("imp-title").textContent = proj.title || name.replace(/(\.gcode)?\.3mf$/i, "");
  $("imp-summary").innerHTML = [
    `${parts} part${parts === 1 ? "" : "s"} on ${nPlates} plate${nPlates === 1 ? "" : "s"}`,
    mods ? `${mods} modifier or negative part${mods === 1 ? "" : "s"}` : "",
    own ? `${own} part${own === 1 ? " has" : "s have"} their own settings` : "",
    painted ? "Painted supports, seams or fuzzy skin" : "",
    made.length ? `Made with ${made.map(esc).join(" · ")}${proj.app ? ` in ${esc(proj.app)}` : ""}` : proj.app ? `Made in ${esc(proj.app)}` : "",
    ...proj.notes.map((n) => `<span class="warn-text">${esc(n)}</span>`),
  ].filter(Boolean).map((x) => `<li>${x}</li>`).join("");
  $("imp-mode-wrap").hidden = !models.length;
  const nq = Object.keys(diff.quality).length, ns = Object.keys(diff.speed).length;
  $("imp-set-wrap").hidden = !(nq + ns);
  $("imp-settings").checked = nq > 0;
  $("imp-settings-text").textContent = `Use its print settings: ${nq} differ from yours (layer height, walls, infill, supports…)`;
  const shown = diff.groups.slice(0, 6).map(([g, labs]) => (labs.length === 1 && labs[0].toLowerCase().includes(g.toLowerCase()) ? labs[0] : `${g}: ${labs.join(", ").toLowerCase()}`));
  $("imp-settings-list").textContent = shown.join(" · ") + (diff.groups.length > 6 ? ` · and ${diff.groups.slice(6).reduce((n, [, l]) => n + l.length, 0)} more` : "");
  $("imp-speeds-wrap").hidden = !ns;
  $("imp-speeds").checked = false;
  $("imp-speeds-text").textContent = `Also its ${ns} speed and acceleration setting${ns === 1 ? "" : "s"}${proj.settings?.printer_settings_id ? ` (tuned for ${proj.settings.printer_settings_id})` : ""}`;
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok" ? {
    replace: !models.length || dlg.querySelector("input[name=imp-mode]:checked")?.value !== "add",
    settings: $("imp-settings").checked && !$("imp-set-wrap").hidden, speeds: $("imp-speeds").checked && !$("imp-speeds-wrap").hidden,
  } : null), { once: true }));
}

async function openProject3mf(name, proj) {
  const diff = projectSettingsDiff(proj.settings);
  const choice = await importDialog(name, proj, diff);
  if (!choice) return;
  if (choice.replace && projectDirty() && !(await confirmBox("Replace the plates? Unsaved changes to them will be lost.", "Replace", true))) return;
  busy(`Opening ${name}…`);
  await new Promise((r) => setTimeout(r, 30));
  try {
    if (!view.renderer) initViewer();
    const notes = new Set(proj.notes);
    if (choice.replace) { clearPlate(); project = null; }
    const nP = Math.max(1, proj.plates.length);
    // where the project's plates go: from plate 1 when replacing; after the last plate with parts when adding
    const lastUsed = plates.reduce((a, p, i) => (meshesOn(i).length ? i : a), -1);
    const base = choice.replace ? 0 : nP === 1 && !meshesOn(cur).length ? cur : lastUsed + 1;
    const bedIds = new Set(bedChoices().map((b) => b.v));
    for (let i = 0; i < nP; i++) {
      if (!plates[base + i]) plates.push(newPlate());
      const pp = proj.plates[i];
      if (pp && (choice.replace || !meshesOn(base + i).length)) {
        Object.assign(plates[base + i], { name: pp.name || "", bedType: bedIds.has(pp.bedType) ? pp.bedType : "", seq: pp.seq || "", spiral: pp.spiral || "" });
      }
    }
    const onPlate = new Map();
    proj.plates.forEach((pp, i) => { for (const [oid, k] of pp.instances) onPlate.set(`${oid}#${k}`, i); });
    const allowed = new Set(S.catalog?.part_options || []);
    const placed = new Map();          // our plate index -> copies placed there
    const profiles = LH.parseProfiles(proj.extra["layer_heights_profile.txt"]), rangesOf = LH.parseRanges(proj.extra["layer_config_ranges.xml"]);
    for (const [n, ob] of proj.objects.entries()) {
      for (const { m, copies } of partsFromObject(ob, allowed, notes, { profile: profiles[n + 1], ranges: rangesOf[n + 1] })) {
        models.push(m);
        setCopies(m, copies.length);
        updateBox(m);
        copies.forEach((cp, k) => {
          const pi = onPlate.get(`${ob.id}#${cp.item}`) ?? 0;
          const o = proj.bed ? projectPlateOrigin(pi, nP, proj.bed) : { x: 0, y: 0 };
          const mesh = m.meshes[k];
          mesh.position.x = plateX(base + pi) + (cp.x - o.x);
          mesh.position.y = cp.y - o.y;
          if (!placed.has(base + pi)) placed.set(base + pi, []);
          placed.get(base + pi).push(mesh);
        });
      }
    }
    // keep each plate's layout; if it's off this bed, centre it, and if it doesn't fit at all, arrange it
    for (const [pi, list] of placed) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const mesh of list) { const f = footprint(mesh.userData.model, mesh); x0 = Math.min(x0, f.x0); y0 = Math.min(y0, f.y0); x1 = Math.max(x1, f.x1); y1 = Math.max(y1, f.y1); }
      const ox = plateX(pi);
      const inside = x0 >= ox - 0.5 && x1 <= ox + bed.w + 0.5 && y0 >= -0.5 && y1 <= bed.d + 0.5;
      if (inside && !list.some(overlapsOthers)) continue;
      if (x1 - x0 <= bed.w && y1 - y0 <= bed.d) {
        const dx = ox + (bed.w - (x1 - x0)) / 2 - x0, dy = (bed.d - (y1 - y0)) / 2 - y0;
        for (const mesh of list) { mesh.position.x += dx; mesh.position.y += dy; }
        if (!list.some(overlapsOthers)) continue;
      }
      arrange(pi);
    }
    if (choice.settings) applyProcessEdits({ ...diff.quality, ...(choice.speeds ? diff.speed : {}) });
    selected = null; multi.clear(); selectedVolume = null;
    if (choice.replace) cur = 0;
    drawBed();
    plateChanged();
    refresh();
    fitView();
    showPlateResult();
    const n = [...placed.values()].reduce((a, l) => a + l.length, 0);
    flash(`Opened ${proj.title || name}: ${n} part${n === 1 ? "" : "s"} on ${placed.size} plate${placed.size === 1 ? "" : "s"}.${notes.size ? " " + [...notes].join(" ") : ""}`, notes.size ? "warn" : "ok");
  } catch (e) {
    flash(`Couldn't open ${name}: ${e.message}`, "err");
  } finally {
    busy(null);
  }
}

/* ---------------------------------------------------------------- model maths */

function newModelRecord(name, geo) {
  return { id: nextId++, name, geo, quat: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1), meshes: [], box: null,
    overrides: {}, printable: true, volumes: [], volMeshes: [], paint: null,
    vlh: null,        // variable layer height: { mode: "adaptive", quality, smooth } or { mode: "imported", profile, pose }
    ranges: [] };     // height-range modifiers: [{ id, from, to, overrides }]
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
  m.geo = geo;
  m.quat.identity();
  m.scale.set(1, 1, 1);
  m.paint = null;
  m.paintRaw = null;
  m.meshes.forEach((x, i) => { x.geometry = geo; x.position.x = keepXY[i][0] + c.x; x.position.y = keepXY[i][1] + c.y; });
  updateBox(m);
}

/* ---- modifier / negative parts: shown as see-through shapes that follow each copy of their part */

function volumeGeo(v) {
  const s = v.size;
  if (v.shape === "mesh") {      // a modifier / negative part brought in with a project: its own mesh, resized
    const b = v.baseSize;
    return MO.bake(v.base, new THREE.Matrix4().makeScale(s.x / (b.x || 1), s.y / (b.y || 1), s.z / (b.z || 1)));
  }
  const g = v.shape === "cylinder" ? MO.cylinder(1, 1) : v.shape === "sphere" ? MO.sphere(1) : v.shape === "cone" ? MO.cone(1, 1) : MO.box(1, 1, 1);
  return MO.bake(g, new THREE.Matrix4().makeScale(s.x, s.y, s.z));
}

function syncVolumes(m) {
  const need = m.meshes.length * m.volumes.length;
  if ((m.volMeshes || []).length !== need || m.volMeshes.some((vm) => !m.volumes.includes(vm.userData.volume) || vm.geometry !== vm.userData.volume.geo || !m.meshes.includes(vm.userData.copy))) {
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
    else mesh.position.set(plateX(cur) + bed.w / 2, bed.d / 2, 0);
    if (m.local) applyPose(m, mesh);
    m.meshes.push(mesh);
    view.scene.add(mesh);
  }
}

function footprint(m, mesh) {
  return { x0: mesh.position.x + m.local.x0, x1: mesh.position.x + m.local.x1, y0: mesh.position.y + m.local.y0, y1: mesh.position.y + m.local.y1 };
}

function layoutOk() {
  // off / tall: parts with a copy off its plate or too tall; bad: plates (indices) with such a copy; overlaps: plates with overlapping copies
  const all = [];
  for (const m of models) for (const mesh of m.meshes) all.push({ m, mesh, f: footprint(m, mesh), p: plateOf(mesh) });
  const off = new Set(), tall = new Set(), bad = new Set(), overlaps = new Set();
  for (const a of all) {
    const ox = plateX(a.p);
    if (a.f.x0 < ox - 0.5 || a.f.y0 < -0.5 || a.f.x1 > ox + bed.w + 0.5 || a.f.y1 > bed.d + 0.5) { off.add(a.m); bad.add(a.p); }
    if (a.m.size.z > bed.h + 0.01) { tall.add(a.m); bad.add(a.p); }
  }
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i].f, b = all[j].f;
    if (a.x0 < b.x1 - 0.2 && b.x0 < a.x1 - 0.2 && a.y0 < b.y1 - 0.2 && b.y0 < a.y1 - 0.2) overlaps.add(all[i].p);
  }
  return { fits: bad.size === 0, off, tall, bad, overlaps, overlap: overlaps.size > 0 };
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
/* ---------------------------------------------------------------- undo / redo */
// Every plate change goes through plateChanged(), which schedules one snapshot of the plate. Changes made in the same
// moment (a drag, a paint stroke, Arrange after adding) become one step; a snapshot equal to the last one (a settings
// change, a click that changed nothing) isn't recorded. Meshes are shared between snapshots, not copied; painted
// triangles are copied only when they changed. Meshes no snapshot or part uses any more are freed.

const HISTORY_MAX = 60;
const history = { steps: [], at: -1, timer: null, restoring: false };
const knownGeos = new Set();
const arrayIds = new WeakMap();
let nextArrayId = 1;
const arrId = (a) => { if (!a) return 0; if (!arrayIds.has(a)) arrayIds.set(a, nextArrayId++); return arrayIds.get(a); };
const sameBytes = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

function scheduleHistory() {
  if (history.restoring || history.timer) return;
  history.timer = setTimeout(recordHistory, 0);
}

function takeSnapshot() {
  const prev = history.steps[history.at];
  const prevPaint = new Map((prev?.models || []).map((pm) => [pm.id, pm.paint]));
  const keepOrCopy = (cur, old) => (!cur ? null : sameBytes(cur, old) ? old : cur.slice());
  const snap = {
    sel: selected?.id ?? null, selVol: selectedVolume?.id ?? null, multi: [...multi].map((m) => m.id), cur,
    plates: plates.map((p) => ({ id: p.id, name: p.name, bedType: p.bedType, seq: p.seq, spiral: p.spiral, gcodes: JSON.stringify(p.gcodes || []), calib: JSON.stringify(p.calib || null) })),
    models: models.map((m) => {
      const op = prevPaint.get(m.id);
      return {
        id: m.id, name: m.name, geo: m.geo, quat: m.quat.toArray(), scale: m.scale.toArray(),
        copies: m.meshes.map((x) => [x.position.x, x.position.y]),
        overrides: JSON.stringify(m.overrides || {}), printable: m.printable !== false,
        volumes: (m.volumes || []).map((v) => ({ id: v.id, name: v.name, kind: v.kind, shape: v.shape, size: v.size.toArray(),
          pos: v.pos.toArray(), overrides: JSON.stringify(v.overrides || {}), geo: v.geo, base: v.base, baseSize: v.baseSize?.toArray() })),
        paintRaw: m.paintRaw || null,
        layers: JSON.stringify([m.vlh, m.ranges]),
        paintRev: m.paintRev || 0,
        paint: m.paint ? { fine: !!m.paint.fine, ...Object.fromEntries(PAINT_KINDS.map((k) => [k, keepOrCopy(m.paint[k], op?.[k])])) } : null,
      };
    }),
  };
  snap.key = JSON.stringify(snap.plates) + JSON.stringify(snap.models.map((sm) => [sm.id, sm.name, sm.geo.uuid, sm.quat, sm.scale, sm.copies, sm.overrides, sm.printable,
    sm.volumes.map((v) => [v.id, v.name, v.kind, v.shape, v.size, v.pos, v.overrides, v.geo.uuid]),
    sm.paint && [sm.paint.fine, ...PAINT_KINDS.map((k) => arrId(sm.paint[k]))], arrId(sm.paintRaw), sm.layers]));
  return snap;
}

function recordHistory() {
  clearTimeout(history.timer);
  history.timer = null;
  if (history.restoring) return;
  const snap = takeSnapshot();
  if (history.steps[history.at]?.key === snap.key) { history.steps[history.at].sel = snap.sel; return; }
  history.steps.length = history.at + 1;          // a new change drops the redo steps
  history.steps.push(snap);
  if (history.steps.length > HISTORY_MAX) history.steps.splice(0, history.steps.length - HISTORY_MAX);
  history.at = history.steps.length - 1;
  freeUnusedGeos();
  updateUndoButtons();
}

function resetHistory() {
  clearTimeout(history.timer);
  history.timer = null;
  history.steps = [];
  history.at = -1;
  recordHistory();
}

function freeUnusedGeos() {
  const live = new Set();
  const add = (g) => { if (g) { live.add(g); knownGeos.add(g); } };
  for (const m of models) { add(m.geo); for (const v of m.volumes || []) add(v.geo); }
  for (const s of history.steps) for (const sm of s.models) { add(sm.geo); for (const v of sm.volumes) add(v.geo); }
  if (clipboardModel) { add(clipboardModel.geo); for (const v of clipboardModel.volumes || []) add(v.geo); }
  for (const g of knownGeos) if (!live.has(g)) { g.dispose(); knownGeos.delete(g); }
}

function restoreSnapshot(s) {
  history.restoring = true;
  try {
    if (paint.on) stopPaint();
    if (pickMode) setPickMode(false);
    if ($("cut-dlg").open) $("cut-dlg").close();
    for (const m of models) {
      for (const mesh of m.meshes) view.scene.remove(mesh);
      for (const vm of m.volMeshes || []) view.scene.remove(vm);
    }
    models.length = 0;
    multi.clear();
    const oldPlates = new Map(plates.map((p) => [p.id, p]));      // slices stay with their plate
    plates.length = 0;
    for (const sp of s.plates) {
      const o = oldPlates.get(sp.id);
      plates.push({ ...sp, gcodes: JSON.parse(sp.gcodes), calib: JSON.parse(sp.calib), job: o?.job || null, jobKey: o?.jobKey || null });
    }
    if (cur >= plates.length) cur = plates.length - 1;
    for (const sm of s.models) {
      const m = newModelRecord(sm.name, sm.geo);
      m.id = sm.id;
      m.paintRev = sm.paintRev;
      m.quat.fromArray(sm.quat);
      m.scale.fromArray(sm.scale);
      m.overrides = JSON.parse(sm.overrides);
      m.printable = sm.printable;
      m.volumes = sm.volumes.map((v) => ({ id: v.id, name: v.name, kind: v.kind, shape: v.shape, size: new THREE.Vector3().fromArray(v.size),
        pos: new THREE.Vector3().fromArray(v.pos), overrides: JSON.parse(v.overrides), geo: v.geo,
        ...(v.base ? { base: v.base, baseSize: new THREE.Vector3().fromArray(v.baseSize) } : {}) }));
      m.paintRaw = sm.paintRaw;
      [m.vlh, m.ranges] = JSON.parse(sm.layers);
      // painting changes the arrays in place, so the part gets its own copies
      m.paint = sm.paint ? { fine: sm.paint.fine, ...Object.fromEntries(PAINT_KINDS.map((k) => [k, sm.paint[k]?.slice() ?? null])) } : null;
      models.push(m);
      setCopies(m, sm.copies.length);
      updateBox(m);
      sm.copies.forEach(([x, y], k) => { m.meshes[k].position.x = x; m.meshes[k].position.y = y; });
    }
    const byId = (id) => models.find((m) => m.id === id) || null;
    selected = byId(s.sel);
    selectedMesh = null;
    for (const id of s.multi) { const m = byId(id); if (m) multi.add(m); }
    selectedVolume = selected?.volumes.find((v) => v.id === s.selVol) || null;
    drawBed();
    plateChanged();       // slices that no longer match go stale; not recorded while restoring
  } finally {
    history.restoring = false;
  }
  refresh();
  showPlateResult();
  updateUndoButtons();
}

function undo() {
  if (history.timer) recordHistory();       // a change still waiting to be recorded is undone first
  if (history.at <= 0) { flash("Nothing to undo", "warn"); return; }
  history.at--;
  restoreSnapshot(history.steps[history.at]);
}

function redo() {
  if (history.timer) recordHistory();
  if (history.at >= history.steps.length - 1) { flash("Nothing to redo", "warn"); return; }
  history.at++;
  restoreSnapshot(history.steps[history.at]);
}

function updateUndoButtons() {
  const u = $("tb-undo"), r = $("tb-redo");
  if (u) u.disabled = history.at <= 0;
  if (r) r.disabled = history.at >= history.steps.length - 1;
}

/* ---------------------------------------------------------------- layer preview */

let viewMode = "model";
let previewKey = null;          // "<job>/<plate>" currently loaded
let previewPlateId = null;      // which of our plates that preview is for

function placePreview() {
  const pi = plates.findIndex((p) => p.id === previewPlateId);
  if (view.preview?.group) view.preview.group.position.x = pi >= 0 ? plateX(pi) : 0;
}

function setViewMode(mode) {
  if (mode === "preview" && (!view.preview?.loaded || previewPlateId !== plates[cur]?.id)) {
    const j = curJob();      // the layers of this plate's slice, if it has a current one
    if (j?.status === "done" && j.plates?.length && jobIsCurrent()) { showPreview(j, j.plates[0].plate); return; }
    mode = "model";
  }
  viewMode = mode;
  for (const m of models) { for (const mesh of m.meshes) mesh.visible = mode === "model"; syncVolumes(m); }
  view.preview?.setVisible(mode === "preview");
  for (const b of document.querySelectorAll("[data-view]")) b.classList.toggle("on", b.dataset.view === mode);
  $("pv-layers").hidden = $("legend").hidden = mode !== "preview";
  $("layer-text").hidden = mode !== "preview";
  $("lg-row").hidden = mode !== "preview";
  if (mode !== "preview") $("lg-list").hidden = true; else renderLayerGcodes();
  if (mode === "preview") setPickMode(false);
  $("tip").textContent = mode === "preview"
    ? "Drag to turn the view · pinch or scroll to zoom · slide to step through the layers"
    : "Drag a part to move it · drag empty space to turn the view · pinch or scroll to zoom · press ? for keyboard shortcuts";
}

function plateChanged(keepView = false) {
  // the plate or settings no longer match the last slice
  plateVersion++;
  scheduleHistory();
  updateProjectLabel();
  updatePlateTabs();
  updateMainButton();
  if (curJob()?.status === "done") renderJob(curJob());
  if (!view.preview?.loaded) return;
  const pi = plates.findIndex((p) => p.id === previewPlateId);
  if (pi >= 0 && jobIsCurrent(pi)) return;
  $("preview-stale").hidden = false;
  if (viewMode === "preview" && !keepView) setViewMode("model");
}

function renderLayerInfo() {
  const p = view.preview;
  if (!p.loaded) return;
  $("layer").max = p.layers;
  $("layer").value = p.layer + 1;
  $("layer-text").textContent = `Layer ${p.layer + 1} of ${p.layers} · Z ${p.data.z[p.layer].toFixed(2)} mm`;
  renderLayerGcodes();
}

/* ---- pause / G-code at a layer (OrcaSlicer's layer slider menu) */

function renderLayerGcodes() {
  const bp = plates[cur];
  const list = [...(bp?.gcodes || [])].sort((a, b) => a.z - b.z);
  $("lg-list").innerHTML = list.map((g) => `<span class="lg-chip" data-z="${g.z}"><button type="button" class="lg-go" title="Go to this layer">${g.type === "pause" ? "⏸ Pause" : "G-code"} · ${(+g.z).toFixed(2)} mm${g.note ? ` · ${esc(g.note)}` : ""}</button><button type="button" class="lg-del" aria-label="Remove">✕</button></span>`).join("");
  $("lg-list").hidden = !list.length || viewMode !== "preview";
}

function layerZ() {
  // only while this plate's layers are on screen
  const p = view.preview;
  return p?.loaded && viewMode === "preview" && previewPlateId === plates[cur]?.id ? +p.data.z[p.layer].toFixed(3) : null;
}

async function addLayerGcode(type) {
  const z = layerZ(), bp = plates[cur];
  if (z == null || !bp) return;
  let gcode = "";
  if (type === "custom") {
    gcode = await ask(`G-code to run before the layer at ${z.toFixed(2)} mm`, bp.gcodes.find((g) => g.z === z && g.type === "custom")?.gcode || "M117 Hello", "Add");
    if (!gcode) return;
  }
  bp.gcodes = bp.gcodes.filter((g) => !(g.z === z && g.type === type)).concat([{ z, type, gcode }]);
  plateChanged(true);
  renderLayerGcodes();
  flash(type === "pause" ? `The print will pause before the layer at ${z.toFixed(2)} mm. Slice again to include it.` : `G-code added at ${z.toFixed(2)} mm. Slice again to include it.`, "ok");
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
    previewPlateId = plates[cur].id;
    placePreview();
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

function settle(newMeshes = [], home = cur) {
  // New copies stay on their plate (the current one, or the plate of the copy they were made from). One that's off
  // the plate or on top of something moves to the nearest free spot; only if there's none is the plate re-arranged.
  for (const x of newMeshes) { const i = plateOf(x); if (i !== home) x.position.x += plateX(home) - plateX(i); }
  plateChanged();
  let repack = false;
  for (const x of newMeshes) {
    const m = x.userData.model;
    if (!m?.local) continue;
    const f = footprint(m, x), ox = plateX(home);
    if (f.x0 >= ox - 0.5 && f.x1 <= ox + bed.w + 0.5 && f.y0 >= -0.5 && f.y1 <= bed.d + 0.5 && !overlapsOthers(x)) continue;
    const spot = findSpot(home, m, [x], x.position);
    if (spot) { x.position.x = spot.x; x.position.y = spot.y; } else repack = true;
  }
  if (repack || layoutOk().bad.has(home)) arrange(home);
  else refresh();
}

/** The free spot on plate pi nearest to `near` (default: the plate's centre) where part m fits, as a position for its copy; or null. */
function findSpot(pi, m, skip = [], near = null) {
  const w = m.size.x, d = m.size.y, ox = plateX(pi);
  if (w > bed.w + 0.01 || d > bed.d + 0.01) return null;
  const rects = [];
  for (const o of models) for (const x of o.meshes) {
    if (skip.includes(x) || plateOf(x) !== pi || !o.local) continue;
    const f = footprint(o, x);
    rects.push([f.x0 - ox - GAP, f.y0 - GAP, f.x1 - ox + GAP, f.y1 + GAP]);
  }
  const tx = near ? near.x - ox + m.local.x0 + w / 2 : bed.w / 2, ty = near ? near.y + m.local.y0 + d / 2 : bed.d / 2;
  const step = Math.max(1, Math.min(5, Math.min(w, d) / 3));
  const xs = [], ys = [];
  for (let x = 0; x < bed.w - w; x += step) xs.push(x);
  xs.push(Math.max(0, bed.w - w));
  for (let y = 0; y < bed.d - d; y += step) ys.push(y);
  ys.push(Math.max(0, bed.d - d));
  let best = null, bestD = Infinity;
  for (const y of ys) for (const x of xs) {
    const dd = (x + w / 2 - tx) ** 2 + (y + d / 2 - ty) ** 2;
    if (dd >= bestD) continue;
    if (rects.some((r) => x < r[2] && r[0] < x + w && y < r[3] && r[1] < y + d)) continue;
    best = [x, y]; bestD = dd;
  }
  return best && { x: ox + best[0] - m.local.x0, y: best[1] - m.local.y0 };
}

function shelfPack(items) {
  // Shelf packing: tallest-footprint parts first, rows left→right; a new group (plate) when the bed is full
  items.sort((a, b) => b.d - a.d || b.w - a.w);
  const groups = [];
  let g = null, x = 0, y = 0, rowD = 0;
  for (const it of items) {
    if (g && x > 0 && x + it.w > bed.w) { y += rowD + GAP; x = 0; rowD = 0; }
    if (!g || (g.items.length && y + it.d > bed.d + 0.01)) { g = { items: [], maxX: 0, depth: 0 }; groups.push(g); x = 0; y = 0; rowD = 0; }
    it.px = x; it.py = y;
    g.items.push(it);
    x += it.w + GAP; rowD = Math.max(rowD, it.d);
    g.maxX = Math.max(g.maxX, x - GAP); g.depth = Math.max(g.depth, y + rowD);
  }
  return groups;
}

function placeGroup(gr, pi) {
  // centre a packed group on plate pi
  const ox = plateX(pi) + Math.max(0, (bed.w - gr.maxX) / 2), oy = Math.max(0, (bed.d - gr.depth) / 2);
  for (const it of gr.items) {
    it.mesh.position.x = ox + it.px - it.m.local.x0;
    it.mesh.position.y = oy + it.py - it.m.local.y0;
  }
}

function arrange(pi = cur) {
  if (typeof pi !== "number") pi = cur;      // called from a click
  plateChanged();
  // Pack plate pi. What doesn't fit goes into free space on the plates after it, then onto new plates, like OrcaSlicer.
  const items = [];
  for (const m of models) for (const mesh of m.meshes) if (plateOf(mesh) === pi) items.push({ m, mesh, w: m.size.x, d: m.size.y });
  const groups = shelfPack(items);
  if (groups.length) placeGroup(groups[0], pi);
  let rest = groups.slice(1).flatMap((g) => g.items);
  const went = new Set();
  rest = rest.filter((it) => {
    for (let j = pi + 1; j < plates.length; j++) {
      const spot = findSpot(j, it.m, rest.filter((r) => !r.placed).map((r) => r.mesh));   // not-yet-placed spill doesn't block
      if (spot) { it.mesh.position.x = spot.x; it.mesh.position.y = spot.y; went.add(j + 1); it.placed = true; return false; }
    }
    return true;
  });
  for (const gr of shelfPack(rest)) {
    plates.push(newPlate());
    placeGroup(gr, plates.length - 1);
    went.add(plates.length);
  }
  if (went.size) { drawBed(); flash(`Not everything fits on plate ${pi + 1}: the rest went to plate ${[...went].sort((a, b) => a - b).join(", ")}.`, "ok"); }
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
    const moved = drag?.mesh;
    drag = null;
    if (wasMoved && moved && plateOf(moved) !== cur) setCurrentPlate(plateOf(moved), false);   // dropped on another plate
    view.controls.enabled = true;
    view.el.classList.remove("dragging");
    if (wasMoved) { plateChanged(); refresh(); }
    return wasMoved;
  }

  const finish = (e) => {
    pointers.delete(e.pointerId);
    cancelPress();
    if (e.button === 2) { down = null; return; }
    if (paint.painting) { paint.painting = false; view.controls.enabled = true; down = null; if (paint.model) paint.model.paintRev = (paint.model.paintRev || 0) + 1; plateChanged(); refresh(); return; }
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
    if (!hit) {        // a tap on another plate's bed makes it the current plate
      const bp = bedPoint(e);
      if (bp && bp.y >= 0 && bp.y <= bed.d) { const i = plateAt(bp.x); if (i !== cur && bp.x >= plateX(i) && bp.x <= plateX(i) + bed.w) setCurrentPlate(i, false); }
    }
    pickPart(hit ? hit.object.userData.model : null, hit?.object, e.shiftKey || e.ctrlKey || e.metaKey);
  }
}

function wireContextMenu() {
  // The right button also pans the view, so the menu opens on a right *click* (released where it was pressed,
  // quickly), not at the start or end of a right-drag. Ctrl-click (a Mac's right-click) opens it straight away.
  const el = view.renderer.domElement;
  let rdown = null;
  const open = (e) => {
    if (viewMode === "preview" || paint.on) return;
    const hit = hitPart(e);
    if (hit) {
      if (!selection().includes(hit.object.userData.model)) pickPart(hit.object.userData.model, hit.object);
      openMenu(e.clientX, e.clientY, partMenu());
    } else openMenu(e.clientX, e.clientY, plateMenu());
  };
  el.addEventListener("pointerdown", (e) => { rdown = e.button === 2 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; }, { capture: true });
  el.addEventListener("pointerup", (e) => {
    if (e.button !== 2 || !rdown) return;
    const still = Math.hypot(e.clientX - rdown.x, e.clientY - rdown.y) <= 5 && performance.now() - rdown.t < 700;
    rdown = null;
    if (still) open(e);
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (e.button === 0 && e.ctrlKey) open(e);
  });
  // On Windows the browser's own menu event comes after the button is released, by which time our menu is open under
  // the pointer and gets that event instead of the view: keep the browser's menu away from the view and our menu.
  for (const target of [view.el, $("menu")]) target.addEventListener("contextmenu", (e) => e.preventDefault());
}

function setPickMode(on) {
  pickMode = on && !!selected;
  $("tb-face").classList.toggle("on", pickMode);
  $("tb-face").title = pickMode ? "Click the face that should go on the bed · click again or press Esc to cancel" : "Lay on face: click the face that should go on the bed (F)";
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
  if (!has) $("preview-controls").hidden = true;      // nothing on the plates (e.g. after undo): no layers to show
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
  $("plate-toolbar").hidden = false;      // always: Add, Shape and Calibrate make parts; the rest wait for some
  $("plate-tabs").hidden = !has && plates.length < 2;
  updateToolbar();
  updatePlateTabs();
  const parts = models.reduce((n, m) => n + m.meshes.length, 0);
  $("plate-summary").textContent = has ? `${parts} part${parts === 1 ? "" : "s"}${plates.length > 1 ? ` · ${plates.length} plates` : ""}` : "";
  const onPlates = (m) => [...new Set(m.meshes.map((x) => plateOf(x) + 1))].sort((a, b) => a - b).join(",");
  $("objects").innerHTML = models.map((m) => `
    <li class="${sel.has(m) && !selectedVolume ? "sel" : ""}${ok.off.has(m) || ok.tall.has(m) ? " bad" : ""}${m.printable === false ? " ghost" : ""}" data-id="${m.id}">
      <span class="name">${esc(m.name)}${m.printable === false ? ' <span class="muted small">(not printed)</span>' : ""}</span>
      <span class="muted small">${plates.length > 1 ? `<span class="part-badge" title="On plate ${onPlates(m)}">P${onPlates(m)}</span> ` : ""}${m.overrides.brim_type === "brim_ears" ? '<span class="part-badge" title="Brim ears">ears</span> ' : ""}${isPainted(m) ? '<span class="part-badge" title="Painted">🖌</span> ' : ""}${Object.keys(m.overrides).length ? `<span class="part-badge" title="Has its own settings">⚙ ${Object.keys(m.overrides).length}</span> ` : ""}${m.meshes.length > 1 ? `×${m.meshes.length} · ` : ""}${fmtMm(m.size.x)}×${fmtMm(m.size.y)}×${fmtMm(m.size.z)}</span>
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
    renderLayerPanel();
    const n = Object.keys(selected.overrides).length;
    $("part-count").textContent = n ? `· ${n}` : "";
    $("part-add").disabled = !partOptionsAvailable();
  }
  let warn = "";
  if (ok.tall.size) warn = `Too tall for this printer (max ${bed.h} mm): ${[...ok.tall].map((m) => m.name).join(", ")}.`;
  else if (ok.off.size) warn = `Doesn't fit on the bed: ${[...ok.off].map((m) => m.name).join(", ")}. Try Arrange, fewer copies, a smaller scale or another orientation.`;
  else if (ok.overlaps.has(cur)) warn = "Some parts overlap. Tap Arrange to space them out.";
  if (warn && plates.length > 1) warn = `${[...ok.bad].length && !ok.bad.has(cur) ? `Plate ${[...ok.bad].map((i) => i + 1).join(", ")}: ` : ""}${warn}`;
  const msg = $("plate-msg");
  msg.textContent = warn;
  msg.hidden = !warn;
  updateMainButton();
}

/* ================================================================ slicing */

function meshXml(geo, matrix, paint, raw = null) {
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
  if (flip) raw = null;                       // painted sub-triangles follow the corner order: use the plain states
  const tx = [];
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = flip ? tris[t + 2] : tris[t + 1], c = flip ? tris[t + 1] : tris[t + 2];
    if (a === b || b === c || a === c) continue;
    const k = t / 3;
    let attrs = "";
    for (const kind of PAINT_KINDS) {
      const code = raw?.[kind]?.[k] || (paint?.[kind] ? MO.paintCode(paint[kind][k]) : "");
      if (code) attrs += ` ${PAINT_ATTR[kind]}="${code}"`;
    }
    tx.push(`<triangle v1="${a}" v2="${b}" v3="${c}"${attrs}/>`);
  }
  return `<mesh><vertices>${vx.join("")}</vertices><triangles>${tx.join("")}</triangles></mesh>`;
}

const metaXml = (o, indent) => Object.entries(o || {}).map(([k, v]) =>
  `${indent}<metadata key="${esc(k)}" value="${esc(Array.isArray(v) ? v.join(",") : v)}"/>\n`).join("");

function build3mf(pi = cur) {
  // What the slicer sees is what's on screen: every placed copy of every printable part, baked in plate coordinates.
  // A part with modifier / negative parts becomes an object made of components, with each component's type and
  // settings in Metadata/model_settings.config (the layout OrcaSlicer itself writes; checked with test slices).
  const objects = [], items = [], configs = [];
  const profiles = [], rangesBy = {};
  let id = 1;
  const ox = plateX(pi);            // the plate's own coordinates
  const toPlate = new THREE.Matrix4().makeTranslation(-ox, 0, 0);
  for (const m of models) {
    if (m.printable === false) continue;
    for (const mesh of m.meshes) {
      if (plateOf(mesh) !== pi) continue;
      mesh.updateMatrixWorld(true);
      const itemNo = items.length + 1;
      const prof = partProfile(m);
      if (prof) profiles.push(LH.profileLine(itemNo, prof));
      if (m.ranges.length) rangesBy[itemNo] = m.ranges.map((r) => ({ from: r.from, to: r.to, settings: { layer_height: lhParams(m).layer, ...r.overrides } }));
      const bodyId = id++;
      objects.push(`<object id="${bodyId}" type="model" name="${esc(m.name)}">${meshXml(m.geo, toPlate.clone().multiply(mesh.matrixWorld), m.paint, m.paintRaw)}</object>`);
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
        const mat = new THREE.Matrix4().makeTranslation(mesh.position.x - ox + v.pos.x, mesh.position.y + v.pos.y, v.pos.z);
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
    ...(profiles.length ? { "Metadata/layer_heights_profile.txt": strToU8(profiles.join("\n") + "\n") } : {}),
    ...(plates[pi]?.gcodes?.length ? { "Metadata/custom_gcode_per_layer.xml": strToU8(CAL.customGcodeXml(plates[pi].gcodes)) } : {}),
    ...(Object.keys(rangesBy).length ? { "Metadata/layer_config_ranges.xml": strToU8(LH.rangesXml(rangesBy)) } : {}),
  }, { level: 6 });
  return new Blob([zip], { type: "model/3mf" });
}

function plateName(pi = cur) {
  if (plates[pi]?.name) return plates[pi].name;
  const ms = modelsOn(pi);
  if (!ms.length) return `Plate ${pi + 1}`;
  const n = ms[0].meshes.filter((x) => plateOf(x) === pi).length;
  return ms.length === 1 ? ms[0].name + (n > 1 ? ` x${n}` : "") : `${ms[0].name} +${ms.length - 1}`;
}

/** What plate pi's slice depends on: if this changes, its slice is out of date. */
function plateKey(pi) {
  const p = plates[pi];
  if (!p) return "";
  const ox = plateX(pi);
  return JSON.stringify([settingsVersion, S.bedType, p.bedType, p.seq, p.spiral, p.gcodes, models.map((m) => {
    if (m.printable === false) return null;
    const c = m.meshes.filter((x) => plateOf(x) === pi).map((x) => [+(x.position.x - ox).toFixed(3), +x.position.y.toFixed(3)]);
    return c.length ? [m.id, m.geo.uuid, m.quat.toArray(), m.scale.toArray(), c, m.overrides, m.paintRev || 0, arrId(m.paintRaw), m.vlh, m.ranges,
      m.volumes.map((v) => [v.kind, v.size.toArray(), v.pos.toArray(), v.overrides, v.geo.uuid])] : null;
  }).filter(Boolean)]);
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
    const action = p.started && printerStatus().id ? `<button class="btn" data-act="watch" type="button">Watch the print</button>` : "";
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

async function poll(id, bp) {
  for (;;) {
    const job = await apiJson(`/api/jobs/${id}`);
    if (bp.job?.id !== id && bp.job) return job;      // sliced again since: this one is old news
    bp.job = job;
    if (plates[cur] === bp) renderJob(job); else updatePlateTabs();
    if (job.status === "done" || job.status === "error") return job;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function resultMsg(bp, html) {
  // the result card shows the current plate's slice
  if (plates[cur] !== bp) return;
  $("result-card").hidden = false;
  $("result").innerHTML = html;
}

async function slice(pi = cur, quiet = false) {
  const bp = plates[pi];
  if (!bp || slicingPlates.has(bp.id)) return;
  if (!modelsOn(pi).length || layoutOk().bad.has(pi)) return;
  if (!modelsOn(pi).some((m) => m.printable !== false)) { resultMsg(bp, `<p class="msg err">Every part on this plate is set to not printable.</p>`); return; }
  if (!S.selected.machine || !S.selected.process || !S.selected.filament) {
    resultMsg(bp, `<p class="msg err">Choose a printer, filament and print settings first.</p>`);
    return;
  }
  slicingPlates.add(bp.id);
  updateMainButton();
  updatePlateTabs();
  resultMsg(bp, `<p><span class="spinner"></span>Preparing the plate…</p>`);
  if (!quiet && plates[cur] === bp) $("result-card").scrollIntoView({ behavior: "smooth", block: "start" });
  const key = plateKey(pi);     // what this slice is made from
  try {
    await new Promise((r) => setTimeout(r, 30));   // let the spinner paint before the heavy export
    const fd = new FormData();
    for (const k of ["machine", "process", "filament"]) fd.append(k, S.selected[k]);
    // unsaved setting changes apply to this slice, plus the plate type (OrcaSlicer's curr_bed_type) and this plate's own settings
    const plateEdits = { curr_bed_type: bp.bedType || S.bedType || undefined, print_sequence: bp.seq || undefined, spiral_mode: bp.spiral || undefined };
    for (const k of Object.keys(plateEdits)) if (plateEdits[k] === undefined) delete plateEdits[k];
    // spiral vase: what OrcaSlicer's desktop app switches for you (its CLI refuses anything else)
    if (bp.spiral === "1") Object.assign(plateEdits, { wall_loops: "1", sparse_infill_density: "0%", top_shell_layers: "0", enable_support: "0", enforce_support_layers: "0" });
    fd.append("edits", JSON.stringify({ ...S.edits, process: { ...S.edits.process, ...plateEdits } }));
    fd.append("arrange", "0");
    fd.append("orient", "0");
    fd.append("name", plateName(pi));
    fd.append("model", build3mf(pi), "plate.3mf");
    const thumbs = plateThumbs(pi);      // Mainsail's file preview (the headless slicer can't render one)
    if (thumbs) fd.append("thumbs", new Blob([JSON.stringify(thumbs)], { type: "application/json" }), "thumbs.json");
    resultMsg(bp, `<p><span class="spinner"></span>Uploading…</p>`);
    const job = await apiJson("/api/slice", { method: "POST", body: fd });
    bp.job = job;
    bp.jobKey = key;
    const done = await poll(job.id, bp);
    const i = plates.indexOf(bp);
    if (!quiet && done.status === "done" && done.plates?.length && i === cur && jobIsCurrent(i)) showPreview(done, done.plates[0].plate);
  } catch (e) {
    resultMsg(bp, `<p class="msg err">${esc(e.message)}</p>`);
  } finally {
    slicingPlates.delete(bp.id);
    refresh();
  }
}

async function sliceAll() {
  // every plate with parts that isn't already sliced as it is, one after the other
  const todo = plates.filter((p, i) => modelsOn(i).length && !jobIsCurrent(i) && !layoutOk().bad.has(i));
  if (!todo.length) { flash("Every plate is already sliced.", "ok"); return; }
  for (const bp of todo) { const i = plates.indexOf(bp); if (i >= 0) await slice(i, true); }
  const j = curJob();
  if (j?.status === "done" && jobIsCurrent()) showPreview(j, j.plates[0].plate);
  flash(`Sliced ${todo.length} plate${todo.length === 1 ? "" : "s"}.`, "ok");
}

async function plateAction(act, plate, btn) {
  const bp = plates[cur];
  const job = bp?.job;
  if (act === "reslice") { slice(); return; }
  if (!job) return;
  const valid = () => plates.includes(bp) && jobIsCurrent(plates.indexOf(bp));
  const show = () => { if (plates[cur] === bp) renderJob(bp.job); };
  if (!valid() && act !== "printers") { show(); return; }   // never send or start an out-of-date slice
  if (act === "preview") { showPreview(job, plate); return; }
  if (act === "printers") { openPrinters(true); return; }
  let startNow = false;
  if (act === "send") {
    const p = job.plates.find((x) => String(x.plate) === plate);
    const choice = await sendDialog(p);
    if (!choice) return;
    if (!valid()) { show(); return; }
    startNow = choice === "print";
    act = "upload";
  }
  if (act === "start") {
    const p = job.plates.find((x) => String(x.plate) === plate);
    if (!(await confirmBox(`Start printing ${p.uploaded} (${fmtTime(p.time_s)})? Make sure the bed is clear.`, "Start print"))) return;
    if (!valid()) { show(); return; }   // the plate changed while the question was open
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
    bp.job = await apiJson(`/api/jobs/${job.id}`);
    await refreshPrinter();
    show();
    updatePlateTabs();
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
  const c = selectedMesh || (m && !m.meshes.some((x) => plateOf(x) === cur) ? m.meshes[0] : null);
  if (c && plateOf(c) !== cur) setCurrentPlate(plateOf(c), false);
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
  set("t-x", +(c.position.x - plateX(plateOf(c))).toFixed(2));     // on its own plate
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
  c.position[axis] = axis === "x" ? plateX(plateOf(c)) + v : v;
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
  { label: "Fuzzy skin", run: () => startPaint("fuzzy"), disabled: !selected },
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
    ...plates.map((p, i) => (i === cur ? null : { label: `Move to plate ${i + 1}${p.name ? ` · ${p.name}` : ""}`, run: () => moveToPlate(i) })),
    { label: "Move to a new plate", run: () => moveToPlate(null) },
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
    { label: "Paint fuzzy skin…", run: () => startPaint("fuzzy") },
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
  { label: "Arrange", key: "A", run: () => arrange(cur), disabled: !models.length },
  { label: "Plate settings…", run: () => plateSettings(cur) },
  { label: "Add a plate", run: addPlate },
  { label: "Auto-orient all", run: orientAll, disabled: !models.length },
  { label: "Export plate as 3MF", run: exportPlate3mf, disabled: !models.length },
];

function updateToolbar() {
  const one = !!selected, many = selection().length > 1;
  for (const b of document.querySelectorAll("#plate-toolbar [data-needs]")) {
    b.disabled = b.dataset.needs === "one" ? !one || many : b.dataset.needs === "many" ? !many : b.dataset.needs === "parts" ? !models.length : false;
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
    paint: () => (paint.on ? stopPaint() : at(paintItems())), more: () => at(moreItems()), calib: () => at(calibItems()), face: () => setPickMode(!pickMode),
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
  c.position.x = plateX(plateOf(c)) + bed.w / 2; c.position.y = bed.d / 2;
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
  if (!modelsOn(cur).length) return;
  saveBlob(build3mf(cur), `${plateName(cur)}.3mf`);
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
  v.geo = volumeGeo(v);
  plateChanged();
  refresh();
}

/* ---- layer height: variable (adaptive, like OrcaSlicer's) and height ranges */

const num0 = (v) => parseFloat(Array.isArray(v) ? v[0] : v);
function lhParams(m) {
  const mv = machineValues();
  return LH.slicingParams({ layerHeight: num0(m?.overrides?.layer_height ?? processValue("layer_height")),
    firstLayerHeight: num0(processValue("initial_layer_print_height")),
    minLayerHeight: num0(mv.min_layer_height), maxLayerHeight: num0(mv.max_layer_height), nozzle: num0(mv.nozzle_diameter) });
}
const poseKey = (m) => `${m.geo.uuid}|${m.quat.toArray().map((x) => x.toFixed(6))}|${m.scale.toArray().map((x) => x.toFixed(6))}`;
const rangeLayers = (m) => m.ranges.map((r) => ({ from: r.from, to: r.to, layerHeight: num0(r.overrides.layer_height ?? lhParams(m).layer) }));

/** The part's layer height profile for the slicer, or null (uniform layers, or ranges only). */
function partProfile(m) {
  if (m.vlh?.mode === "imported") return m.vlh.pose === poseKey(m) ? m.vlh.profile : null;
  if (m.vlh?.mode !== "adaptive") return null;
  const P = lhParams(m), rl = rangeLayers(m);
  const key = JSON.stringify([poseKey(m), m.vlh, P, rl]);
  if (m._lh?.key !== key) {
    // the part as it stands on the bed: rotated and scaled, bottom at z = 0
    const pos = MO.bake(m.geo, new THREE.Matrix4().compose(new THREE.Vector3(0, 0, -m.local.z0), m.quat, m.scale)).getAttribute("position").array;
    let prof = LH.adaptiveProfile(pos, P, m.vlh.quality ?? 0.5, rl);
    for (let i = 0; i < (m.vlh.smooth || 0); i++) prof = LH.smoothProfile(prof, P);
    m._lh = { key, prof };
  }
  return m._lh.prof;
}

/** OrcaSlicer refuses variable layer height and height ranges with organic tree supports. */
function organicSupports(m) {
  const v = (k) => { const raw = k in m.overrides ? m.overrides[k] : processValue(k); return String((Array.isArray(raw) ? raw[0] : raw) ?? ""); };
  const on = /^(1|true)$/.test(v("enable_support"));
  return on && /tree/.test(v("support_type")) && /^(|default|organic)$/.test(v("support_style"));
}

let selRange = null;
function renderLayerPanel() {
  const m = selected;
  if (!m) return;
  const P = lhParams(m);
  const height = m.size.z;
  const imported = m.vlh?.mode === "imported";
  const importedOk = imported && m.vlh.pose === poseKey(m);
  const mode = m.vlh?.mode || "off";
  for (const b of document.querySelectorAll("[data-lh]")) b.classList.toggle("on", b.dataset.lh === mode);
  $("lh-imported-btn").hidden = !imported;
  $("lh-adaptive").hidden = mode !== "adaptive";
  if (mode === "adaptive" && !focusedInput("lh-quality")) $("lh-quality").value = m.vlh.quality ?? 0.5;
  const prof = partProfile(m) || (m.ranges.length ? LH.rangesProfile(height, P, rangeLayers(m)) : null);
  $("lh-chart-wrap").hidden = !prof;
  let info = "";
  if (prof) {
    const tops = LH.layersOf(prof, height, P);
    drawLayerChart(tops, P, height);
    let lo = Infinity, hi = 0;
    tops.forEach((z, i) => { const h = z - (i ? tops[i - 1] : 0); if (i) { lo = Math.min(lo, h); hi = Math.max(hi, h); } });   // the first layer is fixed
    info = `${tops.length} layers (${LH.uniformCount(height, P)} at ${P.layer} mm) · ${lo === Infinity ? P.first : lo.toFixed(2)}–${hi.toFixed(2)} mm`;
  } else if (imported && !importedOk) info = "The project's layer heights no longer match this part (it was rotated, scaled or changed): uniform layers are used.";
  else info = `Every layer ${P.layer} mm (${LH.uniformCount(height, P)} layers).`;
  $("lh-info").textContent = info;
  const clash = (prof || m.ranges.length) && organicSupports(m);
  $("lh-warn").hidden = !clash;
  // height ranges
  $("range-count").textContent = m.ranges.length ? `· ${m.ranges.length}` : "";
  if (selRange && !m.ranges.includes(selRange)) selRange = null;
  $("range-list").innerHTML = m.ranges.map((r) => {
    const n = Object.keys(r.overrides).filter((k) => k !== "layer_height").length;
    return `<li class="${r === selRange ? "sel" : ""}" data-r="${r.id}">
      <input type="number" class="r-from" value="${+r.from.toFixed(2)}" step="0.1" min="0" inputmode="decimal" aria-label="From (mm)"> –
      <input type="number" class="r-to" value="${+r.to.toFixed(2)}" step="0.1" min="0" inputmode="decimal" aria-label="To (mm)"> mm
      <button type="button" class="link r-edit">${esc(String(r.overrides.layer_height ?? P.layer))} mm${n ? ` · ⚙ ${n}` : ""}</button></li>`;
  }).join("");
  $("range-edit").hidden = !selRange;
  if (selRange) {
    $("range-label").textContent = `${+selRange.from.toFixed(2)} to ${+selRange.to.toFixed(2)} mm`;
    if (rangeEditor.range !== selRange) { rangeEditor.range = selRange; rangeEditor.render(); }
  }
}

function drawLayerChart(tops, P, height) {
  // layer height (up) against height in the part (across); dashed: uniform layers
  const W = 300, H = 90, pad = 4;
  const y = (h) => H - pad - ((h - P.min) / Math.max(1e-6, P.max - P.min)) * (H - 2 * pad);
  const x = (z) => pad + (z / Math.max(1e-6, height)) * (W - 2 * pad);
  let d = "";
  tops.forEach((z, i) => { const z0 = i ? tops[i - 1] : 0, h = z - z0; d += `${i ? "L" : "M"}${x(z0).toFixed(1)},${y(h).toFixed(1)}L${x(z).toFixed(1)},${y(h).toFixed(1)}`; });
  $("lh-chart").setAttribute("viewBox", `0 0 ${W} ${H}`);
  $("lh-chart").innerHTML = `<line x1="${pad}" x2="${W - pad}" y1="${y(P.layer)}" y2="${y(P.layer)}" class="lh-uniform"/>
    <path d="${d}" class="lh-line"/>
    <text x="${pad + 2}" y="12" class="lh-t">${P.max} mm</text><text x="${pad + 2}" y="${H - 6}" class="lh-t">${P.min} mm</text>
    <text x="${W - pad - 2}" y="${H - 6}" class="lh-t" text-anchor="end">${+height.toFixed(1)} mm high</text>`;
}

function setVlh(v) {
  if (!selected) return;
  selected.vlh = v;
  plateChanged();
  refresh();
}

const rangeEditor = createPartEditor($("range-settings"), () => selRange?.overrides || null, () => { plateChanged(); refresh(); });

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
  fuzzy: { 0: [0.55, 0.58, 0.65], 1: [0.72, 0.38, 0.95] },
};
let paintMat = null;
const PAINT_KINDS = ["supports", "seam", "fuzzy"];
const PAINT_ATTR = { supports: "paint_supports", seam: "paint_seam", fuzzy: "paint_fuzzy_skin" };
const PAINT_UI = {
  supports: { title: "Paint supports", t1: "Enforce", t2: "Block", note: "Green = always support here, red = never. With supports set to \"manual\" in the print settings, supports go only where you've painted green." },
  seam: { title: "Paint seam", t1: "Seam here", t2: "Avoid", note: "Blue = put the seam here, orange = keep the seam away." },
  fuzzy: { title: "Paint fuzzy skin", t1: "Fuzzy", t2: null, note: "Purple = fuzzy skin here. Its look comes from the fuzzy skin settings (thickness, point distance)." },
};
const isPainted = (m) => !!m.paint && PAINT_KINDS.some((k) => m.paint[k]);

/** OrcaSlicer only applies painted fuzzy skin when the part's fuzzy skin setting isn't "Disabled". */
function fuzzyDisabled(m) {
  const raw = "fuzzy_skin" in m.overrides ? m.overrides.fuzzy_skin : processValue("fuzzy_skin");
  return String((Array.isArray(raw) ? raw[0] : raw) ?? "disabled_fuzzy") === "disabled_fuzzy";
}

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
        m.geo = r.geo;
        m.paintRaw = null;      // a project's painting continues at the detail shown (finer than that is approximated)
        for (const mesh of m.meshes) mesh.geometry = r.geo;
        m.paint = { ...Object.fromEntries(PAINT_KINDS.map((k) => [k, remap(old?.[k])])), fine: true };
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
      const ui = PAINT_UI[target];
      $("paint-title").textContent = ui.title;
      $("paint-t1").textContent = ui.t1;
      $("paint-t2").hidden = !ui.t2;
      if (ui.t2) $("paint-t2").textContent = ui.t2;
      $("paint-overhangs").hidden = target !== "supports";
      $("paint-note").textContent = ui.note;
      $("paint-fuzzy-warn").hidden = !(target === "fuzzy" && fuzzyDisabled(m));
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
    for (const k of PAINT_KINDS) if (m.paint && !any(m.paint[k])) m.paint[k] = null;
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
  m.paintRev = (m.paintRev || 0) + 1;
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

function plateThumbs(pi = cur) {
  // the plate's parts from a three-quarter view, in the filament's colour, on a transparent background
  if (!models.length || !view.scene) return null;
  try {
    thumbRenderer ||= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(1);
    const meshes = meshesOn(pi);
    if (!meshes.length) return null;
    const hide = models.flatMap((m) => m.meshes).filter((x) => !meshes.includes(x)).map((x) => [x, x.visible]);
    for (const [x] of hide) x.visible = false;
    const vols = models.flatMap((m) => m.volMeshes || []).map((x) => [x, x.visible]);
    for (const [x] of vols) x.visible = false;
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
    for (const [x, v] of [...hide, ...vols]) x.visible = v;
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
  const c = new THREE.Vector3(plateX(cur) + bed.w / 2, bed.d / 2, 0);
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
  if (src.paint) m.paint = { fine: src.paint.fine, ...Object.fromEntries(PAINT_KINDS.map((k) => [k, src.paint[k]?.slice() || null])) };
  m.paintRaw = src.paintRaw || null;
  m.vlh = src.vlh ? JSON.parse(JSON.stringify(src.vlh)) : null;
  if (m.vlh?.mode === "imported") m.vlh.pose = poseKey(m);
  m.ranges = (src.ranges || []).map((r) => ({ ...r, id: nextId++, overrides: { ...r.overrides } }));
  models.push(m);
  setCopies(m, 1);
  updateBox(m);
  const ref = src.meshes.filter((x) => plateOf(x) === cur).pop();
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
    else if (lower === "z" && !e.shiftKey) { handled(); undo(); }
    else if ((lower === "z" && e.shiftKey) || lower === "y") { handled(); redo(); }
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

let actionRunning = false;

function mainState() {
  if (slicingPlates.has(plates[cur]?.id)) return { label: "Slicing…", disabled: true };
  const job = curJob();
  if (job?.status === "done" && job.plates?.length && jobIsCurrent()) {
    const pr = printerStatus();
    const p = job.plates.find((x) => !x.started);
    if (!p) return pr.id ? { label: `Watch on ${pr.name || "the printer"}`, act: "open" } : { label: "Printing", disabled: true };
    if (!pr.configured) return { label: "Add a printer…", act: "printers", plate: p.plate };
    if (!p.uploaded) return { label: `Send to ${pr.name}…`, act: "send", plate: p.plate, ready: true };
    const ready = pr.idle && (!p.uploaded_to || p.uploaded_to === pr.id);
    return { label: ready ? "Start print" : pr.online ? `${pr.name} is busy` : `${pr.name} is offline`, act: "start", plate: p.plate, disabled: !ready, ready };
  }
  return { label: plates.length > 1 ? `Slice plate ${cur + 1}` : "Slice", act: "slice", disabled: !(modelsOn(cur).length && !layoutOk().bad.has(cur)) };
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
  const extraMeshes = [];      // mesh-shaped modifiers, stored after the parts' meshes
  const sparse = (a) => (a ? Object.fromEntries(a.flatMap((v, i) => (v ? [[i, v]] : []))) : null);
  const meta = {
    id: asNew ? undefined : project?.id, name,
    presets: { ...S.selected, bed_type: S.bedType }, edits: S.edits,
    plates: plates.map((p) => ({ name: p.name, bed_type: p.bedType, print_sequence: p.seq, spiral_mode: p.spiral, gcodes: p.gcodes, calib: p.calib })),
    models: models.map((m, i) => ({
      mid: i, name: m.name, quat: m.quat.toArray(), scale: m.scale.toArray(), overrides: m.overrides, printable: m.printable !== false,
      volumes: m.volumes.map((v) => ({ name: v.name, kind: v.kind, shape: v.shape, size: v.size.toArray(), pos: v.pos.toArray(), overrides: v.overrides,
        ...(v.shape === "mesh" ? { vmid: extraMeshes.push(v.base) - 1 + models.length, base_size: v.baseSize.toArray() } : {}) })),
      paint: m.paint ? Object.fromEntries(PAINT_KINDS.map((k) => [k, m.paint[k] ? b64(m.paint[k]) : null])) : null,
      paint_raw: m.paintRaw ? Object.fromEntries(PAINT_KINDS.map((k) => [k, sparse(m.paintRaw[k])])) : null,
      layer_height: m.vlh ? { ...m.vlh, pose: undefined, pose_ok: m.vlh.mode !== "imported" || m.vlh.pose === poseKey(m) } : null,
      height_ranges: m.ranges.map((r) => ({ from: r.from, to: r.to, overrides: r.overrides })),
      // [x, y, plate]: x and y on that plate
      instances: m.meshes.map((x) => { const pi = plateOf(x); return [+(x.position.x - plateX(pi)).toFixed(3), +x.position.y.toFixed(3), pi]; }),
    })),
  };
  const fd = new FormData();
  fd.append("project", new Blob([JSON.stringify(meta)], { type: "application/json" }), "project.json");
  models.forEach((m, i) => fd.append(`mesh_${i}`, meshStl(m.geo), `${i}.stl`));
  extraMeshes.forEach((g, j) => fd.append(`mesh_${models.length + j}`, meshStl(g), `${models.length + j}.stl`));
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
    if (Array.isArray(meta.plates) && meta.plates.length) {
      plates.length = 0;
      for (const pp of meta.plates) plates.push({ ...newPlate(), name: String(pp.name || ""), bedType: pp.bed_type || "", seq: pp.print_sequence || "", spiral: pp.spiral_mode || "",
        gcodes: Array.isArray(pp.gcodes) ? pp.gcodes : [], calib: pp.calib || null });
      cur = 0;
      drawBed();
    }
    for (const pm of meta.models) {
      const buf = await (await api(`/api/projects/${id}/mesh/${pm.mid}`)).arrayBuffer();
      const geo = mergeToGeometry(new THREE.Mesh(new STLLoader().parse(buf)));
      const m = newModelRecord(pm.name, geo);
      m.quat.fromArray(pm.quat || [0, 0, 0, 1]);
      if (Array.isArray(pm.scale)) m.scale.fromArray(pm.scale); else m.scale.setScalar(pm.scale || 1);
      m.overrides = pm.overrides || {};
      m.printable = pm.printable !== false;
      m.volumes = [];
      for (const v of pm.volumes || []) {
        const vol = { id: nextId++, name: v.name, kind: v.kind, shape: v.shape, size: new THREE.Vector3().fromArray(v.size),
          pos: new THREE.Vector3().fromArray(v.pos), overrides: v.overrides || {} };
        if (v.shape === "mesh") {
          const vb = await (await api(`/api/projects/${id}/mesh/${v.vmid}`)).arrayBuffer();
          vol.base = mergeToGeometry(new THREE.Mesh(new STLLoader().parse(vb)));
          vol.baseSize = new THREE.Vector3().fromArray(v.base_size);
        }
        vol.geo = volumeGeo(vol);
        m.volumes.push(vol);
      }
      // painted triangles line up with the saved mesh only if it wasn't recentred differently: the mesh is stored centred
      const tris = geo.getAttribute("position").count / 3;
      const unb = (x) => { const a = x ? unb64(x) : null; return a && a.length === tris ? a : null; };
      if (pm.paint) m.paint = Object.fromEntries(PAINT_KINDS.map((k) => [k, unb(pm.paint[k])]));
      if (pm.paint_raw) {
        const arr = (o) => { if (!o) return null; const a = new Array(tris); for (const [i, v] of Object.entries(o)) if (+i < tris) a[+i] = v; return a; };
        m.paintRaw = Object.fromEntries(PAINT_KINDS.map((k) => [k, arr(pm.paint_raw[k])]));
      }
      if (pm.layer_height && (pm.layer_height.mode !== "imported" || pm.layer_height.pose_ok)) {
        m.vlh = { ...pm.layer_height };
        delete m.vlh.pose_ok;
      }
      m.ranges = (pm.height_ranges || []).map((r) => ({ id: nextId++, from: r.from, to: r.to, overrides: r.overrides || {} }));
      models.push(m);
      setCopies(m, (pm.instances || [[bed.w / 2, bed.d / 2, 0]]).length);
      updateBox(m);
      if (m.vlh?.mode === "imported") m.vlh.pose = poseKey(m);
      (pm.instances || []).forEach((xy, k) => { if (m.meshes[k]) { m.meshes[k].position.x = xy[0] + (xy.length > 2 ? plateX(Math.min(xy[2], plates.length - 1)) : 0); m.meshes[k].position.y = xy[1]; } });
    }
    selected = null;
    plateChanged();
    project = { id: meta.id, name: meta.name };
    savedVersion = plateVersion;
    resetHistory();         // undo starts from the opened project
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
  for (const m of models) for (const vm of m.volMeshes || []) view.scene.remove(vm);
  models.length = 0;
  multi.clear(); selectedVolume = null;
  plates.length = 0;
  plates.push(newPlate());
  cur = 0;
  previewPlateId = null;
  drawBed();
  plateChanged();
  showPlateResult();
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
/* ---- calibration tests (OrcaSlicer's Calibration menu) */

function calibContext() {
  const mv = machineValues();
  const flavor = String((Array.isArray(mv.gcode_flavor) ? mv.gcode_flavor[0] : mv.gcode_flavor) || "marlin");
  return { first: num0(processValue("initial_layer_print_height")) || 0.2, layer: num0(processValue("layer_height")) || 0.2,
    nozzle: num0(mv.nozzle_diameter) || 0.4, flavor, bed: { w: bed.w, d: bed.d },
    flowRatio: num0(filamentValue("filament_flow_ratio")) || 1, nozzleTemp: num0(filamentValue("nozzle_temperature")) || 220,
    maxVol: num0(filamentValue("filament_max_volumetric_speed")) || 0,
    bowden: /bowden/i.test(String(mv.extruder_type || "")) };
}

const calibItems = () => [{ head: "Calibration tests" }, ...Object.entries(CAL.TESTS).map(([id, t]) => ({ label: `${t.title}…`, run: () => calibDialog(id) })),
  ...(plates[cur]?.calib?.result ? [{ sep: true }, { label: "Enter this plate's result…", run: calibResult }] : [])];

async function calibDialog(id) {
  const T = CAL.TESTS[id], ctx = calibContext(), d = T.defaults(ctx), dlg = $("calib-dlg");
  $("calib-title").textContent = T.title;
  $("calib-about").textContent = T.about;
  $("calib-fields").innerHTML = T.params.map((f) => f.choices
    ? `<label>${esc(f.label)} <select data-k="${f.key}">${f.choices.map(([v, l]) => `<option value="${v}"${String(d[f.key]) === v ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`
    : `<label>${esc(f.label)}${f.unit ? ` <span class="muted">(${esc(f.unit)})</span>` : ""} <input type="number" data-k="${f.key}" value="${d[f.key]}" step="any"${f.min != null ? ` min="${f.min}"` : ""} inputmode="decimal"></label>`).join("");
  const read = () => Object.fromEntries([...$("calib-fields").querySelectorAll("[data-k]")].map((i) => [i.dataset.k, i.value]));
  const preview = () => {
    try { const plan = CAL.buildTest(id, read(), ctx); $("calib-legend").textContent = plan.legend.slice(0, 8).join(" · ") + (plan.legend.length > 8 ? " …" : ""); $("calib-ok").disabled = false; }
    catch (e) { $("calib-legend").textContent = e.message; $("calib-ok").disabled = true; }
  };
  $("calib-fields").oninput = preview;
  preview();
  dlg.returnValue = "";
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener("close", r, { once: true }));
  if (dlg.returnValue !== "ok") return;
  try { createCalibration(id, read(), ctx); } catch (e) { flash(`Couldn't make the test: ${e.message}`, "err"); }
}

function createCalibration(id, params, ctx) {
  const plan = CAL.buildTest(id, params, ctx);
  if (!view.renderer) initViewer();
  if (paint.on) stopPaint();
  let pi = cur;
  if (meshesOn(cur).length) { plates.push(newPlate()); pi = plates.length - 1; }
  Object.assign(plates[pi], { name: plan.plate.name, spiral: plan.plate.spiral || "", gcodes: plan.gcodes,
    calib: { id, params, name: plan.name, legend: plan.legend, result: plan.result } });
  const made = [];
  for (const part of plan.parts) {
    const geo = geoFrom(Float32Array.from(part.pos), false);
    const c = centered(geo);
    const m = newModelRecord(part.name, geo);
    m.overrides = { ...part.overrides };
    for (const v of part.volumes || []) {
      const vol = { id: nextId++, kind: v.kind, shape: v.shape, name: v.kind === "negative" ? `Hole ${(v.size[0]).toFixed(2)} mm` : "Modifier",
        size: new THREE.Vector3(...v.size), pos: new THREE.Vector3(v.center[0] - c.x, v.center[1] - c.y, v.center[2]), overrides: {} };
      vol.geo = volumeGeo(vol);
      m.volumes.push(vol);
    }
    m.ranges = (part.ranges || []).map((r) => ({ id: nextId++, from: r.from, to: r.to, overrides: { ...r.overrides } }));
    models.push(m);
    setCopies(m, 1);
    updateBox(m);
    m.meshes[0].position.x = plateX(pi) + part.xy[0];
    m.meshes[0].position.y = part.xy[1];
    made.push(m);
  }
  selected = null; multi.clear();
  drawBed();
  setCurrentPlate(pi);
  plateChanged();
  refresh();
  fitView();
  flash(`${plan.name} is on plate ${pi + 1}. Slice and print it${plan.result ? ", then enter what you see under the plate's menu (Enter this plate's result)" : ""}.`, "ok");
}

async function calibResult() {
  const bp = plates[cur], c = bp?.calib;
  if (!c?.result) return;
  const r = c.result, ctx = calibContext(), dlg = $("calres-dlg");
  $("calres-title").textContent = c.name;
  $("calres-legend").innerHTML = c.legend.map((l) => `<li>${esc(l)}</li>`).join("");
  $("calres-field").innerHTML = r.choices
    ? `<label>Best looking <select id="calres-in">${r.choices.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}</select></label>`
    : `<label>${r.kind === "pa" ? "Height of the sharpest corners" : "Height where it starts to fail"} <span class="muted">(mm)</span> <input id="calres-in" type="number" step="0.1" min="0" inputmode="decimal"></label>`;
  const show = () => { const v = $("calres-in").value; const e = v !== "" ? CAL.resultEdits(r, v, ctx) : null; $("calres-out").textContent = e ? `Sets ${e.text}` : ""; $("calres-ok").disabled = !e; };
  $("calres-in").oninput = show;
  show();
  dlg.returnValue = "";
  dlg.showModal();
  await new Promise((res) => dlg.addEventListener("close", res, { once: true }));
  if (dlg.returnValue !== "ok") return;
  const e = CAL.resultEdits(r, $("calres-in").value, ctx);
  if (!e) return;
  applyFilamentEdits(e.edits);
  toast(`${e.text}: an unsaved change to ${S.selected.filament}. Save it with the ✎ next to the filament.`);
}

/* ---- plates: tabs, current plate, plate settings */

function setCurrentPlate(i, moveView = true) {
  if (i === cur || !plates[i]) return;
  const dx = plateX(i) - plateX(cur);
  cur = i;
  if (moveView && view.camera) { view.camera.position.x += dx; view.controls.target.x += dx; view.controls.update(); }
  if (selected && !selected.meshes.some((x) => plateOf(x) === cur)) { selected = null; selectedMesh = null; multi.clear(); selectedVolume = null; }
  drawBed();
  if (viewMode === "preview") setViewMode("preview");      // this plate's layers, or the model view
  showPlateResult();
  refresh();
}

function showPlateResult() {
  // the result card follows the current plate
  const j = curJob();
  if (j) renderJob(j);
  else if (!slicingPlates.has(plates[cur]?.id)) { $("result-card").hidden = true; $("result").innerHTML = ""; updateMainButton(); }
}

function plateState(i) {
  const p = plates[i];
  if (slicingPlates.has(p.id)) return ["slicing", "slicing…"];
  if (!p.job) return ["", modelsOn(i).length ? "not sliced" : "empty"];
  if (p.job.status === "error") return ["err", "slicing failed"];
  if (!jobIsCurrent(i)) return ["stale", "changed since slicing"];
  if (p.job.plates?.some((x) => x.started)) return ["printing", "sent and started"];
  if (p.job.plates?.some((x) => x.uploaded)) return ["sent", "on the printer"];
  return ["ok", "sliced"];
}

function updatePlateTabs() {
  const el = $("plate-tabs");
  if (!el) return;
  el.innerHTML = plates.map((p, i) => {
    const [st, what] = plateState(i);
    return `<button type="button" class="ptab${i === cur ? " on" : ""}" data-pi="${i}" title="Plate ${i + 1}${p.name ? `: ${esc(p.name)}` : ""} · ${what}${i === cur ? " · tap for plate options" : ""}">`
      + `<span class="pdot ${st}"></span>${i + 1}${p.name ? ` <span class="pname">${esc(p.name)}</span>` : ""}${i === cur ? ' <span class="caret">▾</span>' : ""}</button>`;
  }).join("") + `<button type="button" class="ptab add" data-pi="add" title="Add a plate"><svg class="ic" aria-hidden="true"><use href="/static/icons.svg#i-plus"/></svg>Plate</button>`;
}

function addPlate() {
  plates.push(newPlate());
  drawBed();
  setCurrentPlate(plates.length - 1);
  plateChanged();
  refresh();
}

async function deletePlate(i) {
  if (plates.length < 2) return;
  const on = meshesOn(i);
  if (on.length && !(await confirmBox(`Delete plate ${i + 1} and the ${on.length} part${on.length === 1 ? "" : "s"} on it?`, "Delete plate", true))) return;
  const w = plateX(1) - plateX(0);
  for (const m of [...models]) {
    const keep = m.meshes.filter((x) => plateOf(x) !== i);
    for (const x of m.meshes) if (!keep.includes(x)) view.scene.remove(x);
    if (!keep.length) { removeModel(m); continue; }
    m.meshes = keep;
  }
  for (const m of models) for (const x of m.meshes) if (plateOf(x) > i) x.position.x -= w;   // later plates move up one
  if (paint.on && !models.includes(paint.model)) stopPaint();
  plates.splice(i, 1);
  if (cur >= plates.length) cur = plates.length - 1;
  else if (cur > i) cur--;
  previewPlateId = plates.some((p) => p.id === previewPlateId) ? previewPlateId : null;
  placePreview();
  drawBed();
  fitView();
  plateChanged();
  showPlateResult();
  refresh();
}

function moveToPlate(target) {
  // the selected parts' copies on the current plate move to another plate (a new one when target is null), keeping their spot
  const from = cur;
  if (target == null) { plates.push(newPlate()); target = plates.length - 1; drawBed(); }
  const moved = [];
  for (const m of selection()) for (const x of m.meshes) if (plateOf(x) === from) { x.position.x += plateX(target) - plateX(from); moved.push(x); }
  if (!moved.length) return;
  setCurrentPlate(target);
  plateChanged();
  if (layoutOk().bad.has(target) || moved.some(overlapsOthers)) arrange(target); else refresh();
  flash(`Moved to plate ${target + 1}`, "ok");
}

const plateOptionsMenu = () => [
  { head: `Plate ${cur + 1}${plates[cur].name ? ` · ${plates[cur].name}` : ""}` },
  { label: "Plate settings…", run: () => plateSettings(cur) },
  { label: "Arrange this plate", key: "A", run: () => arrange(cur), disabled: !modelsOn(cur).length },
  { label: "Select everything on it", run: () => selectPlate(cur), disabled: !modelsOn(cur).length },
  ...(plates[cur].calib?.result ? [{ label: "Enter calibration result…", run: calibResult }] : []),
  { sep: true },
  { label: `Slice plate ${cur + 1}`, run: () => slice(cur), disabled: !modelsOn(cur).length },
  { label: "Slice all plates", run: sliceAll, disabled: plates.length < 2 },
  { sep: true },
  { label: "Add a plate", run: addPlate },
  { label: "Delete this plate", run: () => deletePlate(cur), disabled: plates.length < 2 },
];

function selectPlate(i) {
  const ms = modelsOn(i);
  multi.clear();
  selected = ms[ms.length - 1] || null;
  for (const m of ms) if (m !== selected) multi.add(m);
  refresh();
}

async function plateSettings(i) {
  // like OrcaSlicer's plate settings: a name, and the plate type, print sequence and spiral vase for this plate only
  const p = plates[i], dlg = $("plate-dlg");
  $("plate-dlg-title").textContent = `Plate ${i + 1}`;
  $("pl-name").value = p.name;
  const printerBed = bedChoices().find((b) => b.v === S.bedType);
  $("pl-bed").innerHTML = `<option value="">Same as the printer${printerBed ? ` (${esc(printerBed.label)})` : ""}</option>`
    + bedChoices().map((b) => `<option value="${esc(b.v)}"${b.v === p.bedType ? " selected" : ""}>${esc(b.label)}</option>`).join("");
  const seq = S.catalog?.options?.print_sequence;
  const seqVals = seq?.enum_values?.length ? seq.enum_values : ["by layer", "by object"];
  $("pl-seq").innerHTML = `<option value="">Same as the print settings</option>`
    + seqVals.map((v, k) => `<option value="${esc(v)}"${v === p.seq ? " selected" : ""}>${esc(seq?.enum_labels?.[k] || v)}</option>`).join("");
  $("pl-spiral").value = p.spiral;
  dlg.returnValue = "";
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener("close", r, { once: true }));
  if (dlg.returnValue !== "ok" || !plates.includes(p)) return;
  Object.assign(p, { name: $("pl-name").value.trim().slice(0, 60), bedType: $("pl-bed").value, seq: $("pl-seq").value, spiral: $("pl-spiral").value });
  drawBed();
  plateChanged();
  refresh();
}

$("plate-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pi]");
  if (!b) return;
  if (b.dataset.pi === "add") { addPlate(); return; }
  const i = Number(b.dataset.pi);
  if (i !== cur) { setCurrentPlate(i); return; }
  const r = b.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, plateOptionsMenu());
});

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
  const from = selected.meshes.filter((x) => plateOf(x) === cur).pop() || selected.meshes[selected.meshes.length - 1];
  const home = plateOf(from);
  setCopies(selected, selected.meshes.length + 1);
  const mesh = selected.meshes[selected.meshes.length - 1];
  mesh.position.copy(from.position);
  mesh.position.x += selected.size.x + GAP;
  settle([mesh], home);
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
$("paint-fuzzy-on").addEventListener("click", () => {
  const m = paint.model;
  if (!m) return;
  m.overrides.fuzzy_skin = "none";          // OrcaSlicer's "Painted only": fuzzy skin just where it's painted
  $("paint-fuzzy-warn").hidden = true;
  partEditor.render();
  plateChanged();
  refresh();
  flash("Painted fuzzy skin is on for this part (Fuzzy skin: Painted only).", "ok");
});
$("paint-clear").addEventListener("click", () => { const m = paint.model; if (!m) return; m.paint[paint.target].fill(0); recolour(m); m.paintRev = (m.paintRev || 0) + 1; plateChanged(); });
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
  if (act === "open") { openPrinterView(printerStatus().id); return; }
  if (!act) return;
  actionRunning = true;
  try { await plateAction(act, b.dataset.plate, b); } finally { actionRunning = false; updateMainButton(); }
});
$("result").addEventListener("click", (e) => {
  if (e.target.closest("[data-act=watch]")) { openPrinterView(printerStatus().id); return; }
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
  onStatus: () => { if (curJob()?.status === "done") renderJob(curJob()); },
});
initSettings((what) => {
  if (what === "presets") { setBed(); refreshPrinter(); }
  if (what === "presets" || what === "edits") { settingsVersion++; plateChanged(); }
}).then(fitView).catch((e) => {
  $("result-card").hidden = false;
  $("result").innerHTML = `<p class="msg err">Couldn't load presets: ${esc(e.message)}</p>`;
});

/* layer height panel */
for (const b of document.querySelectorAll("[data-lh]")) b.addEventListener("click", () => {
  if (!selected) return;
  const v = b.dataset.lh;
  if (v === "off") setVlh(null);
  else if (v === "adaptive") setVlh(selected.vlh?.mode === "adaptive" ? selected.vlh : { mode: "adaptive", quality: 0.5, smooth: 0 });
});
$("lh-quality").addEventListener("change", (e) => { if (selected?.vlh?.mode === "adaptive") setVlh({ ...selected.vlh, quality: +e.target.value, smooth: 0 }); });
$("lh-quality").addEventListener("input", (e) => {      // live chart while dragging; recorded on release
  if (selected?.vlh?.mode !== "adaptive") return;
  selected.vlh = { ...selected.vlh, quality: +e.target.value, smooth: 0 };
  renderLayerPanel();
});
$("lh-smooth").addEventListener("click", () => { if (selected?.vlh?.mode === "adaptive") setVlh({ ...selected.vlh, smooth: Math.min(10, (selected.vlh.smooth || 0) + 1) }); });
$("lh-reset").addEventListener("click", () => { if (selected?.vlh?.mode === "adaptive") setVlh({ mode: "adaptive", quality: 0.5, smooth: 0 }); });
$("lh-fix").addEventListener("click", () => {
  if (!selected) return;
  const vals = S.catalog?.options?.support_style?.enum_values || [];
  selected.overrides.support_style = ["tree_slim", "tree_hybrid", "tree_strong"].find((v) => vals.includes(v)) || "tree_slim";
  partEditor.render();
  plateChanged();
  refresh();
  flash("This part now uses slim tree supports.", "ok");
});
$("range-add").addEventListener("click", () => {
  const m = selected;
  if (!m) return;
  const h = m.size.z, last = m.ranges[m.ranges.length - 1];
  const from = last ? Math.min(h, last.to) : +(h / 2).toFixed(1);
  const to = h;
  if (to - from < 0.1) { flash("The ranges already reach the top of the part: change one first.", "warn"); return; }
  const P = lhParams(m);
  const r = { id: nextId++, from, to: +to.toFixed(2), overrides: { layer_height: String(+Math.max(P.min, P.layer / 2).toFixed(2)) } };
  m.ranges.push(r);
  selRange = r;
  plateChanged();
  refresh();
});
$("range-list").addEventListener("change", (e) => {
  const li = e.target.closest("li[data-r]"), m = selected;
  const r = m?.ranges.find((x) => String(x.id) === li?.dataset.r);
  if (!r) return;
  const v = parseFloat(e.target.value);
  if (Number.isFinite(v) && v >= 0) {
    if (e.target.classList.contains("r-from")) r.from = Math.min(v, r.to - 0.05);
    if (e.target.classList.contains("r-to")) r.to = Math.max(v, r.from + 0.05);
    m.ranges.sort((a, b) => a.from - b.from);
  }
  plateChanged();
  refresh();
});
$("range-list").addEventListener("click", (e) => {
  if (e.target.closest("input")) return;
  const li = e.target.closest("li[data-r]");
  const r = selected?.ranges.find((x) => String(x.id) === li?.dataset.r);
  if (!r) return;
  selRange = selRange === r ? null : r;
  refresh();
});
$("range-add-setting").addEventListener("click", async () => {
  const r = selRange;
  if (!r) return;
  const key = await pickPartSetting(Object.keys(r.overrides));
  if (!key || selRange !== r) return;
  r.overrides[key] = processValue(key);
  rangeEditor.render();
  plateChanged();
  refresh();
});
$("range-remove").addEventListener("click", () => {
  const m = selected;
  if (!m || !selRange) return;
  m.ranges.splice(m.ranges.indexOf(selRange), 1);
  selRange = null;
  plateChanged();
  refresh();
});
$("empty-calib").addEventListener("click", (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left, r.bottom + 4, calibItems()); });
$("lg-pause").addEventListener("click", () => addLayerGcode("pause"));
$("lg-custom").addEventListener("click", () => addLayerGcode("custom"));
$("lg-list").addEventListener("click", (e) => {
  const chip = e.target.closest(".lg-chip");
  const bp = plates[cur];
  if (!chip || !bp) return;
  const z = +chip.dataset.z;
  if (e.target.closest(".lg-del")) {
    bp.gcodes = bp.gcodes.filter((g) => g.z !== z);
    plateChanged(true);
    renderLayerGcodes();
    return;
  }
  const i = view.preview?.data?.z?.findIndex((x) => Math.abs(x - z) < 1e-3);
  if (i >= 0) { view.preview.setLayer(i); renderLayerInfo(); }
});
$("tb-undo").addEventListener("click", undo);
$("tb-redo").addEventListener("click", redo);
resetHistory();
