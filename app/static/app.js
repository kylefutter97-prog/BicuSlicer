import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { zipSync, unzipSync, strToU8 } from "three/addons/libs/fflate.module.js";
import { readProject3mf, paintState, projectPlateOrigin, transformPositions, parseBrimEars } from "./project3mf.js";
import { $, esc, api, apiJson, postJson, confirmBox, ask, toast, saveBlob } from "./util.js";
import { initSettings, S, bedChoices, projectSettingsDiff, applyProcessEdits, applyFilamentEdits, applyMachineEdits, filamentValue, filamentSlots, setFilamentSlots, machineValues, createPartEditor, pickPartSetting, processValue, partOptionsAvailable, applyProjectPresets } from "./settings.js";
import { Preview, RANGE_CSS, fmtTime as fmtSecs } from "./preview.js";
import * as MS from "./measure.js";
import * as MT from "./meshtools.js";
import * as MO from "./meshops.js";
import * as LH from "./layerheight.js";
import * as CAL from "./calibration.js";
import { readStep } from "./step.js";
import { BUNDLED_FONTS, loadFont, textGeometry, previewSvg, placementMatrix, svgGeometry, svgAspect, svgImage } from "./textgeo.js";
import { initPrinters, printerStatus, refreshPrinter, openPrinters, openPrinterView } from "./printers.js";

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const DOWN = new THREE.Vector3(0, 0, -1);
const GAP = 6;          // mm between parts when arranging (plus room for brims, see partGap)
/** Space between parts: 6 mm, plus both parts' brims when brims are on (OrcaSlicer flags touching brims as G-code conflicts). */
function partGap() {
  const raw = (k) => { const v = processValue(k); return Array.isArray(v) ? v[0] : v; };
  const type = String(raw("brim_type") ?? "auto_brim");
  if (type === "no_brim" || type === "painted") return GAP;
  const w = parseFloat(raw("brim_width")) || 0;
  // auto brims go only on parts that need one (small or tall), so leave room for one; other brim types go on every part
  return GAP + Math.min(20, type === "auto_brim" ? Math.max(w, 5) : 2 * w);
}
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
  // gcodeFile: the plate shows a G-code file that was opened (not sliced here)
  return { id: nextPlateId++, name: "", bedType: "", seq: "", spiral: "", gcodes: [], calib: null, job: null, jobKey: null, gcodeFile: false };
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
const measure = { on: false, picks: [], group: null };     // the Measure tool
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
    // support enforcer / blocker parts, in the paint tool's support colours
    enforcer: new THREE.MeshStandardMaterial({ color: 0x3d7dff, transparent: true, opacity: 0.3, depthWrite: false }),
    enforcerSel: new THREE.MeshStandardMaterial({ color: 0x3d7dff, transparent: true, opacity: 0.58, depthWrite: false }),
    blocker: new THREE.MeshStandardMaterial({ color: 0xf08c00, transparent: true, opacity: 0.3, depthWrite: false }),
    blockerSel: new THREE.MeshStandardMaterial({ color: 0xf08c00, transparent: true, opacity: 0.58, depthWrite: false }),
  };
  Object.assign(view, { el, renderer, scene, camera, controls, mats, bedGroup: null, raycaster: new THREE.Raycaster() });
  new ResizeObserver(resize).observe(el);
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
  wirePointer();
  wireContextMenu();
  view.preview = new Preview(scene);
  try { view.preview.wanted = localStorage.getItem("bs-colour-mode") || "feature"; } catch {}
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

/** STL and OBJ carry no units. A mesh under 1 mm on every side was almost surely saved in metres (as OrcaSlicer
 *  suspects on import): scale it ×1000 into millimetres and say so. Convert to metres (More menu) undoes it. */
function fromMetres(geo, name) {
  geo.computeBoundingBox();
  const s = geo.boundingBox.getSize(new THREE.Vector3());
  const big = Math.max(s.x, s.y, s.z);
  if (!(big > 0 && big < 1)) return geo;
  geo.scale(1000, 1000, 1000);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  s.multiplyScalar(1000);
  geo.userData.note = `${name} looked like it was saved in metres: scaled to millimetres (${fmtMm(s.x)}×${fmtMm(s.y)}×${fmtMm(s.z)} mm). Undo with More → Convert to metres.`;
  return geo;
}

async function parseFile(f) {
  const ext = f.name.split(".").pop().toLowerCase();
  if (ext === "stl") return fromMetres(mergeToGeometry(new THREE.Mesh(new STLLoader().parse(await f.arrayBuffer()))), f.name);
  if (ext === "obj") return fromMetres(mergeToGeometry(new OBJLoader().parse(await f.text())), f.name);
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
  // G-code sliced before (here or elsewhere), and sliced Bambu / MakerWorld .gcode.3mf: opened for its layers and to print
  const gfiles = files.filter((x) => /\.(gcode|gco|g|bgcode)$|\.gcode\.3mf$/i.test(x.name));
  files = files.filter((x) => !gfiles.includes(x));
  for (const f of gfiles) await openGcodeFile(f);
  if (!files.length) return;
  const problems = [], added = [];
  const ok = /\.(stl|3mf|obj|step|stp|iges|igs)$/i;
  for (const f of files.filter((x) => !ok.test(x.name))) problems.push(`${f.name}: use an STL, 3MF, OBJ, STEP or G-code file`);
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

/** Open a G-code file on a plate of its own: its layers, its print time and filament, and Send / Print. */
async function openGcodeFile(f) {
  busy(`Opening ${f.name}…`);
  try {
    const fd = new FormData();
    fd.append("file", f, f.name);
    const job = await apiJson("/api/gcode-file", { method: "POST", body: fd });
    let pi = cur;
    if (meshesOn(cur).length || plates[cur].job || plates[cur].gcodeFile) { plates.push(newPlate()); pi = plates.length - 1; }
    Object.assign(plates[pi], { name: job.name, gcodeFile: true, job });
    plates[pi].jobKey = plateKey(pi);
    drawBed();
    if (pi !== cur) setCurrentPlate(pi);
    refresh();
    showPlateResult();
    await showPreview(job, job.plates[0].plate);
    const p = job.plates[0];
    flash(`Opened ${f.name}${job.generator ? `, sliced with ${job.generator}` : ""}${job.plates.length > 1 ? ` (${job.plates.length} plates; this shows plate ${p.plate})` : ""}.`
      + (job.machine ? "" : " It names no printer set up here: check it's for your printer before printing."), "ok");
  } catch (e) {
    flash(`Couldn't open ${f.name}: ${e.message}`, "err");
  } finally { busy(null); }
}

/* ---- OrcaSlicer / Bambu Studio / MakerWorld projects */

function geoFrom(pos, flip) {
  // triangle soup -> geometry; a mirroring transform turns faces inside out, so swap two corners back
  if (flip) for (let i = 0; i < pos.length; i += 9) for (let k = 0; k < 3; k++) { const t = pos[i + 3 + k]; pos[i + 3 + k] = pos[i + 6 + k]; pos[i + 6 + k] = t; }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return g;
}

const partSettings = (o, allowed) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => allowed.has(k) || k === "extruder"));

/** One object of a 3MF -> BicuSlicer parts: copies that share a rotation and scale become one part with copies. */
function partsFromObject(ob, allowed, notes, layers = {}) {
  const out = [];
  const groups = new Map();
  ob.items.forEach((it, i) => { const k = it.transform.slice(0, 9).map((x) => x.toFixed(6)).join(","); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  // multi-colour objects: parts in another filament than the first become raised parts with that filament
  const allNormals = ob.parts.filter((p) => p.subtype === "normal_part");
  if (!allNormals.length) return out;
  const firstSlot = slotOf(allNormals[0].settings) || slotOf(ob.settings) || 1;
  const normals = allNormals.filter((p) => (slotOf(p.settings) || firstSlot) === firstSlot);
  const colourParts = allNormals.filter((p) => !normals.includes(p));
  for (const p of ob.parts) if (!["normal_part", "modifier_part", "negative_part", "support_enforcer", "support_blocker"].includes(p.subtype)) notes.add(`${p.subtype.replace(/_/g, " ")}s aren't supported yet, so they were left out.`);
  if (normals.length > 1 && normals.some((p) => Object.keys(partSettings(p.settings, allowed)).filter((k) => k !== "extruder").length))
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
    if (firstSlot > 1) m.overrides.extruder = String(firstSlot);
    // hand-placed brim ears: object coordinates, turned like the mesh and moved with its centre
    if (layers.ears?.length) {
      m.ears = layers.ears.map(([x, y, z, r]) => { const p = transformPositions(Float32Array.of(x, y, z), R); return { p: [+(p[0] - c.x).toFixed(4), +(p[1] - c.y).toFixed(4), +(p[2] - c.z).toFixed(4)], r }; });
      if (String(m.overrides.brim_type ?? [processValue("brim_type")].flat()[0]) !== "painted") notes.add(`${ob.name}: its hand-placed brim ears only print with the brim type "Painted".`);
    }
    for (const q of [...colourParts, ...ob.parts.filter((x) => ["modifier_part", "negative_part", "support_enforcer", "support_blocker"].includes(x.subtype))]) {
      const vg = geoFrom(transformPositions(q.pos, R), det < 0);
      const vc = centered(vg);
      vg.computeBoundingBox();
      const size = vg.boundingBox.getSize(new THREE.Vector3());
      const kind = { negative_part: "negative", modifier_part: "modifier", support_enforcer: "enforcer", support_blocker: "blocker" }[q.subtype] || "part";
      const v = { id: nextId++, kind, shape: "mesh",
        name: q.name || ({ negative: "Negative part", part: "Part", enforcer: "Support enforcer", blocker: "Support blocker" }[kind] || "Modifier"), size: size.clone(),
        pos: new THREE.Vector3(vc.x - c.x, vc.y - c.y, vc.z - minZ), overrides: !SETTINGLESS.has(kind) ? partSettings(q.settings, allowed) : {},
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
    const earsOfObj = parseBrimEars(proj.extra["brim_ear_points.txt"]);
    for (const [n, ob] of proj.objects.entries()) {
      for (const { m, copies } of partsFromObject(ob, allowed, notes, { profile: profiles[n + 1], ranges: rangesOf[n + 1], ears: earsOfObj[n + 1] })) {
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
    // a multi-colour project: as many filament slots as its parts and painting use, in its colours (or stock ones)
    let need = 1;
    for (const ob of proj.objects) {
      need = Math.max(need, slotOf(ob.settings));
      for (const q of ob.parts) {
        need = Math.max(need, slotOf(q.settings));
        if (q.paint.color) for (const h of q.paint.color) if (h) need = Math.max(need, paintState(h));
      }
    }
    const pc = Array.isArray(proj.settings?.filament_colour) ? proj.settings.filament_colour : [];
    need = Math.max(need, pc.length > 1 ? pc.length : 1);
    if (need > 1 && filamentSlots().length < need) {
      const STOCK = ["#2266FF", "#E23C3C", "#F2C12E", "#2FAE62", "#8A4FFF", "#FF8A00", "#1B1B1B", "#F5F5F5"];
      setFilamentSlots(Array.from({ length: need }, (_, i) => ({ preset: filamentSlots()[i]?.preset || S.selected.filament,
        colour: pc[i] || filamentSlots()[i]?.colour || STOCK[i % STOCK.length] })));
      notes.add(`It uses ${need} filaments: filament slots 1–${need} are set up${pc.length > 1 ? " in its colours" : ""} (your filament preset in each).`);
    }
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
    const g = MO.bake(v.base, new THREE.Matrix4().makeScale(s.x / (b.x || 1), s.y / (b.y || 1), s.z / (b.z || 1)));
    g.computeVertexNormals();       // raised parts are drawn solid and lit
    return g;
  }
  const g = v.shape === "cylinder" ? MO.cylinder(1, 1) : v.shape === "sphere" ? MO.sphere(1) : v.shape === "cone" ? MO.cone(1, 1) : MO.box(1, 1, 1);
  return MO.bake(g, new THREE.Matrix4().makeScale(s.x, s.y, s.z));
}

/* ---- filaments (multi-colour): slot 1, 2, ...; parts, modifiers, painting and layer changes refer to them */

const multiColour = () => filamentSlots().length > 1;
const slotOf = (o) => { const n = parseInt(Array.isArray(o?.extruder) ? o.extruder[0] : o?.extruder, 10); return Number.isFinite(n) && n >= 1 ? n : 0; };
const partSlot = (m) => Math.min(filamentSlots().length, slotOf(m.overrides) || 1);
const slotColour = (n) => (filamentSlots()[n - 1] || filamentSlots()[0]).colour;
const filamentMats = new Map();
function filamentMat(colour, sel) {
  const key = colour + (sel ? "+" : "");
  if (!filamentMats.has(key)) {
    filamentMats.set(key, new THREE.MeshStandardMaterial({ color: colour, roughness: 0.6, metalness: 0.04,
      emissive: sel ? new THREE.Color(css("--accent")) : new THREE.Color(0), emissiveIntensity: sel ? 0.28 : 0 }));
  }
  return filamentMats.get(key);
}

/** Filaments plate pi's parts use, not counting changes at a layer. OrcaSlicer applies a change at a layer only when
 *  this is one filament (its "multi as single" mode); a plate that already mixes filaments ignores them. */
function partFilaments(pi) {
  const used = usedFilaments(pi, false);
  return used;
}

/** The filament slots plate pi uses (parts, raised parts, modifiers, colour painting, filament changes at layers). */
function usedFilaments(pi, withLayerChanges = true) {
  const used = new Set();
  const n = filamentSlots().length;
  for (const m of modelsOn(pi)) {
    if (m.printable === false) continue;
    used.add(partSlot(m));
    for (const v of m.volumes) if (!SETTINGLESS.has(v.kind) && slotOf(v.overrides)) used.add(Math.min(n, slotOf(v.overrides)));
    const pc = m.paint?.color;
    if (pc) for (let i = 0; i < pc.length; i++) if (pc[i]) used.add(Math.min(n, pc[i]));
  }
  if (withLayerChanges && partFilaments(pi).size < 2) for (const g of plates[pi]?.gcodes || []) if (g.type === "filament") used.add(Math.min(n, g.extruder));
  return used;
}

/** Where plate pi's prime tower goes (plate mm, lower-left corner), when it uses several filaments and the print settings want one. */
/**
 * The prime tower's footprint, like OrcaSlicer 2.5's (WipeTower2): with the default "rib" walls the tower is a square
 * (prime_tower_width is ignored) sized by the purge per layer, its ribs reach out further on tall prints, and it has a
 * brim. The tower position (wipe_tower_x/y) is the footprint's front-left corner inside the brim. The purge area was
 * measured from real slices (≈940 mm² at 0.2 mm for one change per layer, ≈+260 mm² per extra filament), with room
 * to spare. Returns { x, y (the tower position), fx0..fy1 (footprint, plate coordinates), w, d } or { none }.
 */
function towerFootprint(pi) {
  const raw = (k) => { const v = processValue(k); return Array.isArray(v) ? v[0] : v; };
  const n = usedFilaments(pi).size;
  const lh = Math.max(0.04, parseFloat(raw("layer_height")) || 0.2);
  const H = Math.max(1, ...modelsOn(pi).map((m) => m.size.z));
  // measured with a 45 mm³ purge per change (OrcaSlicer's prime volume); with "Purge in prime tower" on, each change
  // purges the table's volume instead (× multiplier): 1 mm³ is 5 mm² of tower at 0.2 mm layers
  const prime = +[processValue("prime_volume")].flat()[0] || 45;
  let purge = prime;
  if (purgeOn()) {
    const mult = +[S.edits.process?.flush_multiplier ?? processValue("flush_multiplier")].flat()[0] || 0.3;
    const last = plates.map((p) => p.job?.plates?.[0]).find((pl) => pl?.flush_matrix?.length === n * n);
    const table = flushMatrix(n) || last?.flush_matrix || null;           // before the multiplier
    purge = Math.max(prime, table ? Math.max(...table) * mult : 280 * mult);
  }
  const area = (940 + 260 * Math.max(0, n - 2) + 5 * Math.max(0, purge - 45) * Math.max(1, n - 1)) * (0.2 / lh) * 1.15;
  const type = String(raw("wipe_tower_wall_type") || "rib");
  let brim = parseFloat(raw("prime_tower_brim_width"));
  if (!Number.isFinite(brim)) brim = 3;
  if (brim < 0) brim = Math.min(8, H / 100 * 8);
  brim += 1;                                   // the brim's real width rounds up to whole loops
  // the height-based minimum depth (WipeTower::min_depth_per_height)
  const pts = [[5, 5], [100, 20], [250, 40], [350, 60]];
  let minD = pts[pts.length - 1][1];
  for (let i = 0; i < pts.length; i++) {
    if (H <= pts[i][0]) { minD = i === 0 ? pts[0][1] : pts[i - 1][1] + (H - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]) * (pts[i][1] - pts[i - 1][1]); break; }
  }
  if (type === "rib") {
    const side = Math.sqrt(area);
    // ribs run the diagonals; below the minimum depth they're lengthened (to minD·√2) instead of the body
    const ribW = Math.min(parseFloat(raw("wipe_tower_rib_width")) || 8, side / 2);
    const extra = Math.max(0, parseFloat(raw("wipe_tower_extra_rib_length")) || 0);
    const diag = side * Math.SQRT2, ribLen = Math.max(diag, (side < minD ? minD * Math.SQRT2 : diag) + extra);
    const per = ((ribLen - diag) / 2 + ribW / 2) / Math.SQRT2;
    const f = side + 2 * per;
    return { w: Math.ceil(side), d: Math.ceil(side), fx0: -brim, fy0: -brim, fx1: f + brim, fy1: f + brim };
  }
  const w = Math.max(10, parseFloat(raw("prime_tower_width")) || 60), d = area / w;
  let fx0 = -brim, fy0 = -brim, fx1 = w + brim, fy1 = d + brim;
  const angle = parseFloat(raw("wipe_tower_cone_angle"));
  if (type === "cone" && angle > 0) {                // the stabilising cone's base (an ellipse round the centre)
    const R = Math.tan(angle / 2 * Math.PI / 180) * H;
    fx0 = Math.min(fx0, w / 2 - R - brim); fx1 = Math.max(fx1, w / 2 + R + brim);
    fy0 = Math.min(fy0, d / 2 - R - brim); fy1 = Math.max(fy1, d / 2 + R + brim);
  }
  return { w: Math.ceil(w), d: Math.ceil(d), fx0, fy0, fx1, fy1 };
}

function towerSpot(pi) {
  if (usedFilaments(pi).size < 2) return null;
  const raw = (k) => { const v = processValue(k); return Array.isArray(v) ? v[0] : v; };
  if (!/^(1|true)$/.test(String(raw("enable_prime_tower") ?? "1"))) return null;
  const t = towerFootprint(pi), margin = 4, edge = 1;
  const ox = plateX(pi), rects = [];
  for (const m of models) for (const x of m.meshes) if (plateOf(x) === pi && m.local) {
    const f = footprint(m, x);
    rects.push([f.x0 - ox - margin, f.y0 - margin, f.x1 - ox + margin, f.y1 + margin]);
  }
  let best = null;
  const W = t.fx1 - t.fx0, D = t.fy1 - t.fy0;
  for (let y = bed.d - edge - t.fy1; y + t.fy0 >= edge; y -= 2) for (let x = bed.w - edge - t.fx1; x + t.fx0 >= edge; x -= 2) {
    const a = [x + t.fx0, y + t.fy0, x + t.fx1, y + t.fy1];
    if (rects.some((r) => a[0] < r[2] && r[0] < a[2] && a[1] < r[3] && r[1] < a[3])) continue;
    const score = x + y * 1.2;           // OrcaSlicer-like: back right when there's room
    if (!best || score > best.score) best = { ...t, x: Math.floor(x), y: Math.floor(y), score };
  }
  return best || { none: true, w: Math.ceil(W), d: Math.ceil(D) };
}

let towerMeshes = [];
function drawTowers() {
  for (const t of towerMeshes) { view.scene.remove(t); t.geometry.dispose(); }
  towerMeshes = [];
  if (!view.scene || !multiColour() || viewMode !== "model") return;
  plates.forEach((p, i) => {
    const t = towerSpot(i);
    if (!t || t.none) return;
    const h = Math.max(1, ...modelsOn(i).map((m) => m.size.z)) ;
    // the whole footprint (ribs and brim included), so what you see is the room it takes
    const fw = t.fx1 - t.fx0, fd = t.fy1 - t.fy0;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(fw, fd, h), view.mats.ghost);
    mesh.position.set(plateX(i) + t.x + t.fx0 + fw / 2, t.y + t.fy0 + fd / 2, h / 2);
    mesh.userData.tower = true;
    view.scene.add(mesh);
    towerMeshes.push(mesh);
  });
}

/** OrcaSlicer's paint string for one painted triangle in state s (1..33: supports/seam use 1, 2; colours use filament slots). */
function paintCodeN(s) {
  if (!s) return "";
  const hex = "0123456789ABCDEF";
  const nib = s < 3 ? [s << 2] : s < 18 ? [12, s - 3] : [12, 15, s - 18];
  return nib.reverse().map((x) => hex[x]).join("");
}

const VOL_KIND = { negative: "negative part", modifier: "modifier", part: "raised part", enforcer: "support enforcer", blocker: "support blocker" };
const SETTINGLESS = new Set(["negative", "enforcer", "blocker"]);      // volume kinds without settings of their own
function volMat(v, sel, m) {
  if (v.kind === "part") {     // raised text etc.: part of the print
    if (multiColour()) return filamentMat(slotColour(slotOf(v.overrides) || (m ? partSlot(m) : 1)), sel);
    return sel ? view.mats.selected : view.mats.normal;
  }
  if (v.kind === "negative") return sel ? view.mats.negativeSel : view.mats.negative;
  if (v.kind === "enforcer") return sel ? view.mats.enforcerSel : view.mats.enforcer;
  if (v.kind === "blocker") return sel ? view.mats.blockerSel : view.mats.blocker;
  return sel ? view.mats.modifierSel : view.mats.modifier;
}

function syncVolumes(m) {
  const need = m.meshes.length * m.volumes.length;
  if ((m.volMeshes || []).length !== need || m.volMeshes.some((vm) => !m.volumes.includes(vm.userData.volume) || vm.geometry !== vm.userData.volume.geo || !m.meshes.includes(vm.userData.copy))) {
    for (const vm of m.volMeshes || []) view.scene.remove(vm);
    m.volMeshes = [];
    for (const mesh of m.meshes) for (const v of m.volumes) {
      const vm = new THREE.Mesh(v.geo, volMat(v, false, m));
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
    vm.material = volMat(v, v === selectedVolume || (selected === m && !selectedVolume && v.kind === "part"), m);
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
    plates: plates.map((p) => ({ id: p.id, name: p.name, bedType: p.bedType, seq: p.seq, spiral: p.spiral, gcodes: JSON.stringify(p.gcodes || []), calib: JSON.stringify(p.calib || null), gcodeFile: !!p.gcodeFile })),
    models: models.map((m) => {
      const op = prevPaint.get(m.id);
      return {
        id: m.id, name: m.name, geo: m.geo, quat: m.quat.toArray(), scale: m.scale.toArray(),
        copies: m.meshes.map((x) => [x.position.x, x.position.y]),
        overrides: JSON.stringify(m.overrides || {}), printable: m.printable !== false,
        volumes: (m.volumes || []).map((v) => ({ id: v.id, name: v.name, kind: v.kind, shape: v.shape, size: v.size.toArray(),
          pos: v.pos.toArray(), overrides: JSON.stringify(v.overrides || {}), geo: v.geo, base: v.base, baseSize: v.baseSize?.toArray(),
          text: v.text ? JSON.stringify(v.text) : null })),
        textp: JSON.stringify(m.text || null),
        earsp: JSON.stringify(m.ears || null),
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
        ...(v.base ? { base: v.base, baseSize: new THREE.Vector3().fromArray(v.baseSize) } : {}), ...(v.text ? { text: JSON.parse(v.text) } : {}) }));
      m.text = JSON.parse(sm.textp || "null");
      m.ears = JSON.parse(sm.earsp || "null");
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
  if (mode !== "preview") $("feat-stats").hidden = $("mode-legend").hidden = true;
  else if (view.preview?.loaded) renderLegend();
  renderMoves();
  $("layer-text").hidden = mode !== "preview";
  $("lg-row").hidden = mode !== "preview" || !!plates[cur]?.gcodeFile;      // an opened G-code can't take pauses (it isn't sliced here)
  $("lg-filament").hidden = !multiColour();
  if (mode !== "preview") $("lg-list").hidden = true; else renderLayerGcodes();
  if (mode === "preview") { setPickMode(false); if (measure.on) setMeasure(false); if (ears.on) stopEars(); }
  drawEars();
  $("tip").textContent = mode === "preview"
    ? "Drag to turn the view · pinch or scroll to zoom · slide to step through the layers"
    : "Drag a part to move it · drag empty space to turn the view · pinch or scroll to zoom · press ? for keyboard shortcuts";
}

function plateChanged(keepView = false) {
  // the plate or settings no longer match the last slice
  plateVersion++;
  if (measure.picks.length) { measure.picks = []; drawMeasure(); }     // what was measured has moved
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
  const lt = p.layerTime();
  $("layer-text").textContent = `Layer ${p.layer + 1} of ${p.layers} · Z ${p.data.z[p.layer].toFixed(2)} mm${lt ? ` · ${lt}` : ""}`;
  renderMoves();
  renderLayerGcodes();
}

/* ---- the moves within a layer (OrcaSlicer's horizontal slider), with the G-code being run */

let gcodeTimer = null, gcodeSeq = 0;
function renderMoves() {
  const p = view.preview;
  const on = !!p?.loaded && p.hasMoves && viewMode === "preview";
  $("pv-moves").hidden = !on;
  if (!on) { $("gcode-lines").hidden = true; return; }
  const list = p.moves();
  const n = list.length, cur = p.move === null ? n : p.move + 1;
  $("move").max = Math.max(1, n);
  $("move").value = cur;
  $("move").disabled = n < 2;
  $("move").setAttribute("aria-valuetext", `Move ${cur} of ${n}`);
  // the G-code around the move, only while stepping (the whole layer needs no line)
  if (p.move === null || !previewKey) { $("gcode-lines").hidden = true; return; }
  const at = p.moveOffset(), seq = ++gcodeSeq, [job, plate] = previewKey.split("/");
  clearTimeout(gcodeTimer);
  gcodeTimer = setTimeout(async () => {
    try {
      const r = await apiJson(`/api/jobs/${job}/plates/${plate}/gcode-lines?at=${at}&before=2&after=3`);
      if (seq !== gcodeSeq) return;
      $("gcode-lines").innerHTML = r.lines.map((l, i) => i === r.current ? `<span class="cur">${esc(l) || " "}</span>` : esc(l)).join("\n");
      $("gcode-lines").hidden = false;
    } catch { $("gcode-lines").hidden = true; }
  }, 80);
}

function stepMove(d) {
  const p = view.preview;
  if (!p.loaded || !p.hasMoves) return;
  const n = p.moves().length, cur = p.move === null ? n - 1 : p.move;
  p.setMove(Math.max(0, Math.min(n - 1, cur + d)));
  renderMoves();
}

/* ---- pause / G-code at a layer (OrcaSlicer's layer slider menu) */

function renderLayerGcodes() {
  const bp = plates[cur];
  const mixed = bp && partFilaments(cur).size > 1;
  $("lg-filament").disabled = mixed;
  $("lg-filament").title = mixed ? "This plate already prints with several filaments; OrcaSlicer only changes filament at a layer when the rest of the plate uses one."
    : "Print with another filament from this layer on (a manual swap on one nozzle)";
  const list = [...(bp?.gcodes || [])].sort((a, b) => a.z - b.z);
  $("lg-list").innerHTML = list.map((g) => `<span class="lg-chip" data-z="${g.z}"><button type="button" class="lg-go" title="Go to this layer">${g.type === "pause" ? "⏸ Pause" : g.type === "filament" ? `<span class="fil-swatch" style="background:${slotColour(g.extruder)}"></span>Filament ${g.extruder}${mixed ? " (not applied: the plate mixes filaments)" : ""}` : "G-code"} · ${(+g.z).toFixed(2)} mm${g.note ? ` · ${esc(g.note)}` : ""}</button><button type="button" class="lg-del" aria-label="Remove">✕</button></span>`).join("");
  $("lg-list").hidden = !list.length || viewMode !== "preview";
}

function layerZ() {
  // only while this plate's layers are on screen
  const p = view.preview;
  return p?.loaded && viewMode === "preview" && previewPlateId === plates[cur]?.id ? +p.data.z[p.layer].toFixed(3) : null;
}

async function addLayerGcode(type, extruder = 0) {
  const z = layerZ(), bp = plates[cur];
  if (z == null || !bp) return;
  let gcode = "";
  if (type === "filament") {
    bp.gcodes = bp.gcodes.filter((g) => !(g.z === z && g.type === "filament")).concat([{ z, type, extruder }]);
    plateChanged(true);
    renderLayerGcodes();
    flash(`Filament ${extruder} from the layer at ${z.toFixed(2)} mm. Slice again to include it.`, "ok");
    return;
  }
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
  const p = view.preview;
  renderFeatureStats();
  $("legend").innerHTML = p.legend().map((f) =>
    `<label class="lg${f.visible ? "" : " off"}"><input type="checkbox" data-feat="${f.i}" ${f.visible ? "checked" : ""}><span class="sw" style="background:${esc(f.color)}"></span>${esc(f.name)}</label>`).join("");
  // line types keep their colours only in "Line type"; in other modes they're just show/hide switches
  $("legend").classList.toggle("plain", p.mode !== "feature");
  const sel = $("color-mode"), modes = p.modes();
  sel.innerHTML = modes.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join("");
  sel.value = p.mode;
  sel.disabled = modes.length < 2;
  sel.title = modes.length < 2 ? "Slice again to colour by speed, width, fan, temperature…" : "Colour the lines by";
  const ml = p.modeLegend();
  $("mode-legend").hidden = !ml;
  if (!ml) return;
  if (ml.kind === "filament") {
    const slots = filamentSlots();
    $("mode-legend").innerHTML = `<div class="fil-row">${ml.items.map((f) => `<span class="fil-item"><span class="sw" style="background:${esc(f.color)}"></span>Filament ${f.n}${slots[f.n - 1]?.preset ? ` · ${esc(slots[f.n - 1].preset)}` : ""}</span>`).join("")}</div>`;
  } else if (ml.single) {
    $("mode-legend").innerHTML = `<div>${esc(ml.label)}: ${esc(ml.single)} throughout</div>`;
  } else {
    $("mode-legend").innerHTML = `<div class="scale-bar" style="background:linear-gradient(to right, ${RANGE_CSS.join(", ")})"></div>
      <div class="scale-ticks">${ml.ticks.map((t) => `<span>${esc(t)}</span>`).join("")}</div>`;
  }
}

/** OrcaSlicer's legend columns: time, share of the print and filament per line type. */
function renderFeatureStats() {
  const rows = view.preview.legend().filter((f) => f.stats);
  $("feat-stats").hidden = !rows.length;
  if (!rows.length) return;
  const total = rows.reduce((a, f) => a + f.stats.time, 0) || 1;
  const sum = (k) => rows.reduce((a, f) => a + f.stats[k], 0);
  $("feat-stats-body").innerHTML = `<table><thead><tr><th>Line type</th><th>Time</th><th>%</th><th>Filament</th></tr></thead><tbody>${rows.map((f) =>
    `<tr class="${f.visible ? "" : "off"}"><td><span class="sw" style="background:${esc(f.color)}"></span>${esc(f.name)}</td><td>${fmtSecs(f.stats.time)}</td><td>${(f.stats.time / total * 100).toFixed(1)}</td><td>${f.stats.weight.toFixed(2)} g</td></tr>`).join("")}
    <tr><td><b>Total</b></td><td><b>${fmtSecs(sum("time"))}</b></td><td></td><td><b>${sum("weight").toFixed(2)} g</b></td></tr></tbody></table>`;
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
  const w = m.size.x, d = m.size.y, ox = plateX(pi), G = partGap();
  if (w > bed.w + 0.01 || d > bed.d + 0.01) return null;
  const rects = [];
  for (const o of models) for (const x of o.meshes) {
    if (skip.includes(x) || plateOf(x) !== pi || !o.local) continue;
    const f = footprint(o, x);
    rects.push([f.x0 - ox - G, f.y0 - G, f.x1 - ox + G, f.y1 + G]);
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
  const G = partGap();
  // Shelf packing: tallest-footprint parts first, rows left→right; a new group (plate) when the bed is full
  items.sort((a, b) => b.d - a.d || b.w - a.w);
  const groups = [];
  let g = null, x = 0, y = 0, rowD = 0;
  for (const it of items) {
    if (g && x > 0 && x + it.w > bed.w) { y += rowD + G; x = 0; rowD = 0; }
    if (!g || (g.items.length && y + it.d > bed.d + 0.01)) { g = { items: [], maxX: 0, depth: 0 }; groups.push(g); x = 0; y = 0; rowD = 0; }
    it.px = x; it.py = y;
    g.items.push(it);
    x += it.w + G; rowD = Math.max(rowD, it.d);
    g.maxX = Math.max(g.maxX, x - G); g.depth = Math.max(g.depth, y + rowD);
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
    if (pickMode || measure.on || ears.on || e.button > 0) return;
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
    if (cut && cutTap(e)) return;
    const hit = hitPart(e);
    if (measure.on) { measureTap(hit); return; }
    if (ears.on) { earTap(e, hit); return; }
    if (textPlace) {
      if (hit && hit.object.userData.model === textPlace.model && hit.face) placeText(hit);
      else flash(`Tap a face of ${textPlace.model.name}.`, "warn");
      return;
    }
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

/* ---------------------------------------------------------------- measure (OrcaSlicer's Measure tool) */

function setMeasure(on) {
  measure.on = on && viewMode === "model" && models.length > 0;
  if (measure.on) { if (pickMode) setPickMode(false); }
  measure.picks = [];
  drawMeasure();
  $("tb-measure").classList.toggle("on", measure.on);
  const hint = $("hint");
  if (measure.on) { hint.hidden = false; hint.textContent = "Tap a corner, a circle's edge or a face; then another to measure between them. Esc to finish."; }
  else if (!pickMode && !textPlace) hint.hidden = true;
}

function toScreen(v) {
  const r = view.renderer.domElement.getBoundingClientRect(), p = v.clone().project(view.camera);
  return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
}

function measureTap(hit) {
  if (!hit || !hit.face) { measure.picks = []; drawMeasure(); return; }
  const f = MS.pickFeature(hit.object, hit, toScreen);
  f.part = hit.object.userData.model?.name || "";
  measure.picks = measure.picks.length >= 2 ? [f] : [...measure.picks, f];
  drawMeasure();
}

function drawMeasure() {
  if (measure.group) { view.scene.remove(measure.group); measure.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); measure.group = null; }
  const panel = $("measure-panel");
  if (!measure.on || !measure.picks.length) {
    panel.hidden = !measure.on;
    panel.innerHTML = measure.on ? `<span class="m-note">Nothing picked yet.</span>` : "";
    return;
  }
  const g = new THREE.Group();
  const accent = new THREE.Color(css("--accent")), second = new THREE.Color("#f5a524");
  measure.picks.forEach((p, i) => {
    const col = i ? second : accent;
    if (p.kind === "face") {
      // the picked face, drawn just above the part
      const tp = p.region.topo, arr = new Float32Array(p.region.tris.length * 9);
      p.region.tris.forEach((t, k) => { for (let j = 0; j < 3; j++) { const v = tp.verts[tp.tv[t * 3 + j]]; arr.set([v.x, v.y, v.z], k * 9 + j * 3); } });
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.renderOrder = 4; g.add(m);
    }
    if (p.kind === "circle") {
      const c = p.circle, pts = [];
      const u = new THREE.Vector3().copy(Math.abs(c.normal.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).cross(c.normal).normalize();
      const w = new THREE.Vector3().crossVectors(c.normal, u);
      for (let k = 0; k <= 64; k++) { const a = k / 64 * Math.PI * 2; pts.push(c.center.clone().addScaledVector(u, Math.cos(a) * c.radius).addScaledVector(w, Math.sin(a) * c.radius)); }
      const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col, depthTest: false }));
      ring.renderOrder = 5; g.add(ring);
    }
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.6, 16, 12), new THREE.MeshBasicMaterial({ color: col, depthTest: false }));
    dot.position.copy(p.point); dot.renderOrder = 6; g.add(dot);
  });
  if (measure.picks.length === 2) {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([measure.picks[0].point, measure.picks[1].point]),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 1, gapSize: 0.6, depthTest: false }));
    line.computeLineDistances(); line.renderOrder = 6; g.add(line);
  }
  view.scene.add(g);
  measure.group = g;
  const rows = measure.picks.length === 2 ? MS.measureBetween(...measure.picks) : MS.describe(measure.picks[0]);
  panel.innerHTML = rows.map((r) => `<div class="m-row"><span>${esc(r.label)}</span><b>${esc(r.value)}</b></div>${r.detail ? `<div class="m-detail">${esc(r.detail)}</div>` : ""}`).join("")
    + (measure.picks.length === 1 ? `<span class="m-note">Tap a second corner, circle or face to measure to it.</span>` : "");
  panel.hidden = false;
}

function setPickMode(on) {
  pickMode = on && !!selected;
  if (pickMode && measure.on) setMeasure(false);
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
  const gplate = !!plates[cur]?.gcodeFile;          // an opened G-code file: its layers, no parts needed
  if (ears.on && (!models.includes(ears.m) || selected !== ears.m)) { ears.on = false; ears.m = null; $("ears-panel").hidden = true; showHint(""); }
  drawEars();
  $("empty").hidden = has || gplate;
  if (!has && !gplate) $("preview-controls").hidden = true;      // nothing on the plates (e.g. after undo): no layers to show
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
      const mc = multiColour();
      mesh.material = m.printable === false ? view.mats.ghost : ok.off.has(m) || ok.tall.has(m) ? view.mats.bad
        : paint.on && m === paint.model ? mesh.material
          : mc ? filamentMat(slotColour(partSlot(m)), sel.has(m)) : sel.has(m) ? view.mats.selected : view.mats.normal;
    }
    syncVolumes(m);
  }
  $("plate-toolbar").hidden = false;      // always: Add, Shape and Calibrate make parts; the rest wait for some
  $("plate-tabs").hidden = !has && !gplate && plates.length < 2;
  updateToolbar();
  updatePlateTabs();
  drawTowers();
  const parts = models.reduce((n, m) => n + m.meshes.length, 0);
  $("plate-summary").textContent = has ? `${parts} part${parts === 1 ? "" : "s"}${plates.length > 1 ? ` · ${plates.length} plates` : ""}` : "";
  const onPlates = (m) => [...new Set(m.meshes.map((x) => plateOf(x) + 1))].sort((a, b) => a - b).join(",");
  $("objects").innerHTML = models.map((m) => `
    <li class="${sel.has(m) && !selectedVolume ? "sel" : ""}${ok.off.has(m) || ok.tall.has(m) ? " bad" : ""}${m.printable === false ? " ghost" : ""}" data-id="${m.id}">
      <span class="name">${esc(m.name)}${m.printable === false ? ' <span class="muted small">(not printed)</span>' : ""}</span>
      <span class="muted small">${multiColour() ? `<span class="fil-swatch" style="background:${slotColour(partSlot(m))}" title="Filament ${partSlot(m)}"></span>` : ""}${plates.length > 1 ? `<span class="part-badge" title="On plate ${onPlates(m)}">P${onPlates(m)}</span> ` : ""}${m.overrides.brim_type === "brim_ears" ? '<span class="part-badge" title="Brim ears">ears</span> ' : ""}${isPainted(m) ? '<span class="part-badge" title="Painted">🖌</span> ' : ""}${Object.keys(m.overrides).length ? `<span class="part-badge" title="Has its own settings">⚙ ${Object.keys(m.overrides).length}</span> ` : ""}${m.meshes.length > 1 ? `×${m.meshes.length} · ` : ""}${fmtMm(m.size.x)}×${fmtMm(m.size.y)}×${fmtMm(m.size.z)}</span>
    </li>${m.volumes.map((v) => `
    <li class="vol${v === selectedVolume ? " sel" : ""}" data-id="${m.id}" data-vol="${v.id}">
      <span class="name">↳ ${esc(v.name)}</span><span class="muted small">${VOL_KIND[v.kind] || v.kind}${Object.keys(v.overrides).length ? ` · ⚙ ${Object.keys(v.overrides).length}` : ""}</span>
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
    $("obj-edit-text").hidden = !selected.text;
    $("obj-edit-text").textContent = selected.text?.svg ? "Edit SVG…" : "Edit text…";
    fillFilamentSelect($("obj-filament"), partSlot(selected), false);
    renderFlushOpts();
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
      const code = raw?.[kind]?.[k] || (paint?.[kind] ? paintCodeN(paint[kind][k]) : "");
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
  const profiles = [], rangesBy = {}, earLines = [];
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
      // hand-placed brim ears (OrcaSlicer's "Painted" brim): bed points of this copy. Found by slicing: a plain part is
      // re-centred on its bounding box's middle (z too) before the points are used, so they're given relative to that;
      // a part with modifiers / negative / raised parts (written as components) keeps plate coordinates.
      const ears = earsOf(m, mesh);
      if (ears.length) {
        const c = m.volumes.length ? new THREE.Vector3(ox, 0, 0) : new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
        earLines.push(`object_id=${itemNo}|` + ears.map((e) => `${(e.x - c.x).toFixed(6)} ${(e.y - c.y).toFixed(6)} ${(-c.z).toFixed(6)} ${e.r.toFixed(6)}`).join(" "));
      }
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
        parts.push(`    <part id="${vid}" subtype="${{ negative: "negative_part", modifier: "modifier_part", part: "normal_part", enforcer: "support_enforcer", blocker: "support_blocker" }[v.kind] || "modifier_part"}">\n      <metadata key="name" value="${esc(v.name)}"/>\n${SETTINGLESS.has(v.kind) ? "" : metaXml(v.overrides, "      ")}    </part>\n`);
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
    ...(earLines.length ? { "Metadata/brim_ear_points.txt": strToU8("brim_points_format_version=0\n" + earLines.join("\n") + "\n") } : {}),
    ...(plates[pi]?.gcodes?.length ? { "Metadata/custom_gcode_per_layer.xml": strToU8(CAL.customGcodeXml(plates[pi].gcodes, filamentSlots().map((f) => f.colour), multiColour())) } : {}),
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
  if (p.gcodeFile && !meshesOn(pi).length) return `gcode:${p.job?.id}`;      // an opened G-code: current until parts are added
  const ox = plateX(pi);
  return JSON.stringify([settingsVersion, S.bedType, p.bedType, p.seq, p.spiral, p.gcodes, multiColour() ? filamentSlots() : 0, models.map((m) => {
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
    const fils = p.filament_g_each?.length > 1 ? `<p class="small fil-use">${p.filament_g_each.map((g, i) => g > 0 ? `<span><span class="fil-swatch" style="background:${slotColour(i + 1)}"></span>${i + 1}: ${g.toFixed(1)} g</span>` : "").join(" ")}</p>` : "";
    const swaps = p.filament_changes ? `<p class="msg ${job.manual_swaps ? "warn" : "ok"} small">${p.filament_changes} filament change${p.filament_changes === 1 ? "" : "s"}${job.manual_swaps ? ": the printer pauses (M600) for you to swap the filament each time" : ""}.</p>` : "";
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
      ${fils}${swaps}
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
    const tower = towerSpot(pi);
    if (tower?.none) { resultMsg(bp, `<p class="msg err">There's no room on this plate for the prime tower (${tower.w} × ${tower.d} mm): move parts, or turn the prime tower off in the print settings.</p>`); return; }
    if (tower) Object.assign(plateEdits, { wipe_tower_x: [String(tower.x)], wipe_tower_y: [String(tower.y)] });
    if (bp.spiral === "1") Object.assign(plateEdits, { wall_loops: "1", sparse_infill_density: "0%", top_shell_layers: "0", enable_support: "0", enforce_support_layers: "0" });
    // a calibration plate's own settings (as OrcaSlicer's calibrations set them), and its G-code step done by the server
    const ce = bp.calib?.edits || {};
    const proc = { ...S.edits.process };
    if (proc.flush_volumes_matrix && !flushMatrix()) delete proc.flush_volumes_matrix;      // set for another number of filaments
    fd.append("edits", JSON.stringify({ ...S.edits, process: { ...proc, ...plateEdits, ...(ce.process || {}) },
      filament: { ...S.edits.filament, ...(ce.filament || {}) }, machine: { ...S.edits.machine, ...(ce.machine || {}) } }));
    if (bp.calib?.post) fd.append("calib_post", JSON.stringify(bp.calib.post));
    if (multiColour()) fd.append("filaments", JSON.stringify(filamentSlots()));
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
  { head: "Supports" },
  ...["box", "cylinder", "sphere"].map((s) => ({ label: `Support enforcer: ${s}`, run: () => addVolume("enforcer", s), disabled: !selected })),
  ...["box", "cylinder", "sphere"].map((s) => ({ label: `Support blocker: ${s}`, run: () => addVolume("blocker", s), disabled: !selected })),
];
const paintItems = () => [
  { head: "Paint on the part" },
  { label: "Supports (enforce / block)", run: () => startPaint("supports"), disabled: !selected },
  { label: "Seam (here / avoid)", run: () => startPaint("seam"), disabled: !selected },
  { label: "Fuzzy skin", run: () => startPaint("fuzzy"), disabled: !selected },
  { label: "Colours (filaments)", run: () => startPaint("color"), disabled: !selected || !multiColour() },
];
const moreItems = () => [
  { label: "Rename…", run: renameSelected, disabled: !selected },
  { label: "Center on the bed", run: centerSelected, disabled: !selected },
  { label: "Printable", check: selected?.printable !== false, run: togglePrintable, disabled: !selected },
  { label: "Fix model", run: fixSelected, disabled: !selected },
  { label: "Replace with STL…", run: replaceSelected, disabled: !selected || selection().length > 1 },
  { label: "Convert from inches (×25.4)", run: () => convertUnits(25.4), disabled: !selected },
  { label: "Convert to inches (÷25.4)", run: () => convertUnits(1 / 25.4), disabled: !selected },
  { label: "Convert from metres (×1000)", run: () => convertUnits(1000), disabled: !selected },
  { label: "Convert to metres (÷1000)", run: () => convertUnits(1 / 1000), disabled: !selected },
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
    { label: "Add text on it…", run: addText },
    { label: "Add an SVG on it…", run: addSvg },
    { label: "Pick face down", key: "F", run: () => setPickMode(true) },
    { label: "Center on the bed", run: centerSelected },
    ...plates.map((p, i) => (i === cur ? null : { label: `Move to plate ${i + 1}${p.name ? ` · ${p.name}` : ""}`, run: () => moveToPlate(i) })),
    { label: "Move to a new plate", run: () => moveToPlate(null) },
    { sep: true },
    ...mirrorItems().slice(1),
    { label: "Split into parts", run: splitSelected, disabled: many },
    { label: "Cut…", run: openCut, disabled: many },
    { label: "Merge selected parts", run: mergeSelected, disabled: !many },
    ...booleanItems().filter((it) => !it.head && !it.disabled),
    { label: "Simplify…", run: openSimplify, disabled: many },
    { sep: true },
    ...volumeItems().filter((it) => !it.head).slice(0, 1), { label: "Negative part: box", run: () => addVolume("negative", "box") },
    { label: "Brim ears: automatic", check: selected?.overrides.brim_type === "brim_ears", run: toggleEars },
    { label: "Brim ears: place by hand…", run: startEars, disabled: many },
    { label: "Paint supports…", run: () => startPaint("supports") },
    { label: "Paint seam…", run: () => startPaint("seam") },
    { label: "Paint fuzzy skin…", run: () => startPaint("fuzzy") },
    ...(multiColour() ? [{ label: "Paint colours…", run: () => startPaint("color") }] : []),
    { label: "Printable", check: selected?.printable !== false, run: togglePrintable },
    { sep: true },
    { label: "Fix model", run: fixSelected, disabled: many },
    { label: "Replace with STL…", run: replaceSelected, disabled: many },
    { label: "Export as STL", run: exportPartStl, disabled: many },
    { label: many ? "Remove parts" : "Remove", key: "Del", run: () => $("obj-delete").click() },
  ];
}
const plateMenu = () => [
  { label: "Add a model…", key: "Ctrl+I", run: () => document.querySelector(".file-input")?.click() },
  ...shapeItems().slice(1).map((it) => ({ ...it, label: `Add ${it.label.toLowerCase()}` })),
  { sep: true },
  { label: "Add text…", run: addText },
  { label: "Arrange", key: "A", run: () => arrange(cur), disabled: !models.length },
  { label: "Plate settings…", run: () => plateSettings(cur) },
  { label: "Add a plate", run: addPlate },
  { label: "Auto-orient all", run: orientAll, disabled: !models.length },
  { label: "Export plate as 3MF", run: exportPlate3mf, disabled: !models.length },
];

function updateToolbar() {
  const one = !!selected, many = selection().length > 1;
  for (const b of document.querySelectorAll("#plate-toolbar [data-needs]")) {
    b.disabled = b.dataset.needs === "one" ? !one || many : b.dataset.needs === "many" ? !many : b.dataset.needs === "parts" ? !models.length : b.dataset.needs === "sel" ? !one : false;
  }
  $("tb-ears").classList.toggle("on", ears.on || (!!selected && ["brim_ears", "painted"].includes(selected.overrides.brim_type)));
  $("tb-paint").classList.toggle("on", paint.on);
}

$("plate-toolbar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tool]");
  if (!b || b.disabled) return;
  const r = b.getBoundingClientRect();
  const at = (items) => openMenu(r.left, r.bottom + 4, items);
  ({
    shape: () => at(shapeItems()), arrange, "orient-all": orientAll, split: splitSelected, merge: mergeSelected, cut: openCut,
    mirror: () => at(mirrorItems()), volume: () => at(volumeItems()), ears: () => (ears.on ? stopEars() : at(earItems())),
    svg: addSvg, measure: () => setMeasure(!measure.on), boolean: () => at(booleanItems()), simplify: openSimplify,
    paint: () => (paint.on ? stopPaint() : at(paintItems())), more: () => at(moreItems()), calib: () => at(calibItems()), face: () => setPickMode(!pickMode), text: addText,
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
  for (const m of selection()) { if (on) { m.overrides.brim_type = "brim_ears"; m.ears = null; } else delete m.overrides.brim_type; }
  drawEars();
  if (selected) partEditor.model = null;
  plateChanged();
  refresh();
  flash(on ? "Brim ears on: tabs on the sharp corners (tune them under the part's own settings)" : "Brim ears off", "ok");
}

/* ---- brim ears placed by hand (OrcaSlicer's brim ears tool; its "Painted" brim type) */

const ears = { on: false, m: null, group: null };
const earItems = () => [
  { head: "Brim ears" },
  { label: "Automatic: on sharp corners", check: selected?.overrides.brim_type === "brim_ears", run: toggleEars },
  { label: "Place them by hand…", run: startEars },
  ...(selected?.ears?.length ? [{ label: `Remove the ${selected.ears.length} hand-placed ear${selected.ears.length > 1 ? "s" : ""}`, run: () => clearEars(selected) }] : []),
];

/** A part's hand-placed ears for one copy, on the bed: [{ x, y, r }] (ears the part's turned away from the bed are left out, as OrcaSlicer does). */
function earsOf(m, mesh) {
  if (!m.ears?.length || String(m.overrides.brim_type ?? [processValue("brim_type")].flat()[0]) !== "painted") return [];
  mesh.updateMatrixWorld(true);
  return m.ears.map((e) => { const w = new THREE.Vector3(...e.p).applyMatrix4(mesh.matrixWorld); return { x: w.x, y: w.y, z: w.z, r: e.r }; })
    .filter((e) => e.z < 0.5);
}

function drawEars() {
  if (ears.group) { view.scene.remove(ears.group); ears.group.traverse((o) => o.geometry?.dispose()); ears.group = null; }
  if (!view.scene || viewMode !== "model") return;
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: css("--accent"), transparent: true, opacity: 0.55, depthWrite: false });
  for (const m of models) for (const mesh of m.meshes) for (const e of earsOf(m, mesh)) {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(e.r, e.r, 0.3, 40).rotateX(Math.PI / 2), mat);
    disc.position.set(e.x, e.y, 0.16);
    g.add(disc);
  }
  view.scene.add(g);
  ears.group = g;
}

function startEars() {
  const m = selected;
  if (!m || selection().length > 1) return;
  if (measure.on) setMeasure(false);
  if (pickMode) setPickMode(false);
  if (paint.on) stopPaint();
  ears.on = true; ears.m = m;
  $("ears-panel").hidden = false;
  $("ears-name").textContent = m.name;
  renderEarsPanel();
  showHint("Tap by the part's edge to add an ear; tap an ear to remove it.");
  updateToolbar();
}

function stopEars() {
  ears.on = false; ears.m = null;
  $("ears-panel").hidden = true;
  showHint("");
  updateToolbar();
  refresh();
}

function renderEarsPanel() {
  const n = ears.m?.ears?.length || 0;
  $("ears-count").textContent = n ? `${n} ear${n > 1 ? "s" : ""}` : "No ears yet";
}

function clearEars(m) {
  m.ears = null;
  if (m.overrides.brim_type === "painted") delete m.overrides.brim_type;
  partEditor.model = null;
  drawEars(); plateChanged(); refresh();
  if (ears.on) renderEarsPanel();
}

/** The nearest point to p on a copy's outline on the bed: { x, y, d } (from its bottom faces, else its lowest points' hull). */
function nearestOnBottomOutline(m, mesh, p) {
  const g = MO.bake(m.geo, mesh.matrixWorld), pos = g.getAttribute("position");
  const zMin = (() => { let z = Infinity; for (let i = 0; i < pos.count; i++) z = Math.min(z, pos.getZ(i)); return z; })();
  const key = (i) => `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)}`;
  const edges = new Map();
  for (let t = 0; t < pos.count; t += 3) {
    if (![0, 1, 2].every((j) => pos.getZ(t + j) < zMin + 0.05)) continue;     // a face on the bed
    for (let j = 0; j < 3; j++) {
      const a = t + j, b = t + (j + 1) % 3, ka = key(a), kb = key(b), k = ka < kb ? ka + "|" + kb : kb + "|" + ka;
      const e = edges.get(k);
      if (e) e.n++; else edges.set(k, { n: 1, a: [pos.getX(a), pos.getY(a)], b: [pos.getX(b), pos.getY(b)] });
    }
  }
  let segs = [...edges.values()].filter((e) => e.n === 1).map((e) => [e.a, e.b]);
  if (!segs.length) {        // no flat bottom (a sphere, a cone's tip): the outline of its lowest points
    const pts = [];
    for (let i = 0; i < pos.count; i++) if (pos.getZ(i) < zMin + 0.4) pts.push(new THREE.Vector2(pos.getX(i), pos.getY(i)));
    if (pts.length < 3) return null;
    const hull = convexHull2(pts);
    segs = hull.map((v, i) => [[v.x, v.y], [hull[(i + 1) % hull.length].x, hull[(i + 1) % hull.length].y]]);
  }
  g.dispose();
  let best = null;
  for (const [a, b] of segs) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / L)) : 0;
    const x = a[0] + t * dx, y = a[1] + t * dy, d = Math.hypot(p.x - x, p.y - y);
    if (!best || d < best.d) best = { x, y, d };
  }
  return best;
}

function convexHull2(pts) {
  const s = [...pts].sort((a, b) => a.x - b.x || a.y - b.y), cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], hi = [];
  for (const p of s) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of s.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

function earTap(e, hit) {
  const m = ears.m;
  if (!m || !models.includes(m)) { stopEars(); return; }
  const p = hit && hit.object.userData.model === m ? hit.point : bedPoint(e);
  if (!p) return;
  const r = Math.max(1, (+$("ears-size").value || 8) / 2);
  // which copy: the nearest one (the ear is kept in the part's own coordinates, so every copy gets it)
  let best = m.meshes[0], bd = Infinity;
  for (const mesh of m.meshes) { const d = Math.hypot(mesh.position.x - p.x, mesh.position.y - p.y); if (d < bd) { bd = d; best = mesh; } }
  best.updateMatrixWorld(true);
  // an ear sits on the part's edge on the bed (OrcaSlicer drops ears that don't touch it): snap to the nearest point
  const q = nearestOnBottomOutline(m, best, p);
  // tapping an ear (or the edge right by it) removes it
  const inv = best.matrixWorld.clone().invert();
  for (const ear of m.ears || []) {
    const w = new THREE.Vector3(...ear.p).applyMatrix4(best.matrixWorld);
    if (w.z > 0.5) continue;
    if (Math.hypot(w.x - p.x, w.y - p.y) <= Math.max(ear.r, 2) || (q && Math.hypot(w.x - q.x, w.y - q.y) <= Math.max(ear.r * 0.75, 1.5))) {
      m.ears.splice(m.ears.indexOf(ear), 1);
      if (!m.ears.length) clearEars(m); else { drawEars(); plateChanged(); renderEarsPanel(); }
      return;
    }
  }
  if (!q || q.d > 15) { flash("Tap closer to the part's edge on the bed.", "warn"); return; }
  const local = new THREE.Vector3(q.x, q.y, 0).applyMatrix4(inv);
  m.ears = [...(m.ears || []), { p: local.toArray().map((v) => +v.toFixed(4)), r }];
  m.overrides.brim_type = "painted";
  partEditor.model = null;
  drawEars(); plateChanged(); renderEarsPanel();
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

/* ---- boolean (OrcaSlicer's Mesh boolean) and simplify */

function booleanItems() {
  const list = selection(), m = selected;
  if (list.length > 1) {
    return [{ head: "Boolean" },
      { label: "Combine into one part (union)", run: () => booleanSelected("union") },
      { label: `Cut the others out of ${list[0].name} (difference)`, run: () => booleanSelected("subtract") },
      { label: "Keep only where they overlap (intersection)", run: () => booleanSelected("intersect") }];
  }
  const neg = m?.volumes?.some((v) => v.kind === "negative"), raised = m?.volumes?.some((v) => v.kind === "part");
  return [{ head: "Boolean" },
    ...(neg ? [{ label: "Apply its negative parts (cut them out for good)", run: () => applyVolumes("negative") }] : []),
    ...(raised ? [{ label: "Join its raised parts into it", run: () => applyVolumes("part") }] : []),
    { label: "Shift-click more parts to combine, cut or intersect them", disabled: true }];
}

/** The part's copies (or one copy) baked into plate axes. */
const bakedCopies = (m) => m.meshes.map((mesh) => { mesh.updateMatrixWorld(true); return MO.bake(m.geo, mesh.matrixWorld); });

async function booleanSelected(op) {
  const list = selection();
  if (list.length < 2) return;
  const name = { union: "combined", subtract: "cut", intersect: "overlap" }[op];
  busy(op === "union" ? "Combining…" : op === "subtract" ? "Cutting…" : "Intersecting…");
  try {
    const union = async (geos) => (geos.length === 1 ? geos[0] : MT.boolean("union", geos));
    let g;
    if (op === "union") g = await MT.boolean("union", list.flatMap(bakedCopies));
    else if (op === "subtract") g = await MT.boolean("subtract", [await union(bakedCopies(list[0])), ...list.slice(1).flatMap(bakedCopies)]);
    else g = await MT.boolean("intersect", await Promise.all(list.map((m) => union(bakedCopies(m)))));
    const first = list[0];
    for (const m of list) removeModel(m);
    g.computeBoundingBox();
    const c = g.boundingBox.getCenter(new THREE.Vector3());
    const { m } = addModel(`${first.name} (${name})`, g, { x: c.x, y: c.y }, first);
    selected = m; multi.clear();
    settle([]);
    const what = op === "union" ? `Combined ${list.length} parts into one` : op === "subtract" ? `Cut ${list.length - 1 > 1 ? `${list.length - 1} parts` : list[1].name} out of ${first.name}` : `Kept where ${list.length} parts overlap`;
    flash(`${what} (${MT.triangleCount(g).toLocaleString()} triangles)`, "ok");
  } catch (e) {
    flash(`Couldn't do that: ${e.message}`, "err");
  } finally { busy(null); }
}

/** Make a part's negative parts (cut out) or raised parts (joined) part of its mesh. */
async function applyVolumes(kind) {
  const m = selected;
  if (!m) return;
  const copy = m.meshes[0];
  syncVolumes(m);
  const vms = (m.volMeshes || []).filter((vm) => vm.userData.copy === copy && vm.userData.volume.kind === kind);
  if (!vms.length) return;
  busy(kind === "negative" ? "Cutting out its negative parts…" : "Joining its raised parts…");
  try {
    copy.updateMatrixWorld(true);
    const base = MO.bake(m.geo, copy.matrixWorld);
    const tools = vms.map((vm) => { vm.updateMatrixWorld(true); return MO.bake(vm.geometry, vm.matrixWorld); });
    const g = await MT.boolean(kind === "negative" ? "subtract" : "union", [base, ...tools]);
    g.translate(-copy.position.x, -copy.position.y, 0);
    const used = new Set(vms.map((vm) => vm.userData.volume));
    m.volumes = m.volumes.filter((v) => !used.has(v));
    if (used.has(selectedVolume)) selectedVolume = null;
    replaceGeo(m, g);
    syncVolumes(m);
    settle(m.meshes);
    flash(kind === "negative" ? `Cut ${used.size} negative part${used.size > 1 ? "s" : ""} out of ${m.name}` : `Joined ${used.size} raised part${used.size > 1 ? "s" : ""} into ${m.name}`, "ok");
  } catch (e) {
    flash(`Couldn't do that: ${e.message}`, "err");
  } finally { busy(null); }
}

let simp = null;          // the Simplify panel's state: { m, geo (before), result }
function openSimplify() {
  const m = selected;
  if (!m || selection().length > 1) return;
  if (simp) closeSimplify(false);
  simp = { m, geo: m.geo, result: null, seq: 0 };
  $("simp-name").textContent = m.name;
  $("simp-paint").hidden = !(m.paintRaw && Object.keys(m.paintRaw).length);
  $("simplify-dlg").returnValue = "";
  $("simplify-dlg").show();
  runSimplify();
}

let simpTimer = null;
function runSimplify() {
  if (!simp) return;
  const keep = +$("simp-keep").value / 100, err = +$("simp-err").value, seq = ++simp.seq;
  $("simp-pct").textContent = `${Math.round(keep * 100)}%`;
  $("simp-out").textContent = "Working…";
  clearTimeout(simpTimer);
  simpTimer = setTimeout(async () => {
    try {
      const r = await MT.simplify(simp.geo, keep, err);
      if (!simp || seq !== simp.seq) return;
      simp.result = r;
      for (const x of simp.m.meshes) x.geometry = r.geo;       // preview on the part
      const before = MT.triangleCount(simp.geo);
      $("simp-out").innerHTML = `${before.toLocaleString()} → <b>${r.triangles.toLocaleString()}</b> triangles · shape changed by up to ${r.error.toFixed(3)} mm`
        + (r.triangles > before * keep * 1.15 ? `<br><span class="muted">It stopped there to stay within ${err} mm: allow more change to go further.</span>` : "");
    } catch (e) { if (simp) $("simp-out").textContent = `Couldn't simplify: ${e.message}`; }
  }, 120);
}

function closeSimplify(apply) {
  const s = simp;
  simp = null;
  if ($("simplify-dlg").open) $("simplify-dlg").close();
  if (!s) return;
  for (const x of s.m.meshes) x.geometry = s.geo;
  if (!apply || !s.result) return;
  const m = s.m, before = MT.triangleCount(s.geo);
  const keepT = { quat: m.quat.clone(), scale: m.scale.clone() };
  replaceGeo(m, s.result.geo);
  m.quat.copy(keepT.quat); m.scale.copy(keepT.scale);
  updateBox(m);
  settle(m.meshes);
  flash(`Simplified ${m.name}: ${before.toLocaleString()} → ${s.result.triangles.toLocaleString()} triangles`, "ok");
}
$("simp-keep").addEventListener("input", runSimplify);
$("simp-err").addEventListener("change", runSimplify);
$("simplify-dlg").addEventListener("close", () => closeSimplify($("simplify-dlg").returnValue === "ok"));

/** Replace a part's mesh with another file's (a new version of it), keeping where it is, its turn and scale, its settings and modifiers. */
function replaceSelected() {
  const m = selected;
  if (!m || selection().length > 1) return;
  const i = $("replace-input");
  i.value = "";
  i.onchange = async () => {
    const f = i.files[0];
    if (!f || !models.includes(m)) return;
    busy(`Loading ${f.name}…`);
    try {
      const geo = await parseFile(f);
      centered(geo);
      const before = m.size.clone();
      m.geo = geo;
      m.paint = null; m.paintRaw = null; m.text = null; m.vlh = null;
      if (m.overrides.brim_type === "painted") { delete m.overrides.brim_type; m.ears = null; }
      for (const x of m.meshes) x.geometry = geo;
      updateBox(m);
      settle(m.meshes);
      flash(`Replaced ${m.name}'s mesh with ${f.name} (${fmtMm(before.x)}×${fmtMm(before.y)}×${fmtMm(before.z)} → ${fmtMm(m.size.x)}×${fmtMm(m.size.y)}×${fmtMm(m.size.z)} mm). Its settings and modifiers stay; painting was cleared.`, "ok");
    } catch (e) { flash(`Couldn't replace it: ${e.message}`, "err"); } finally { busy(null); }
  };
  i.click();
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
  const v = { id: nextId++, kind, shape, name: `${{ negative: "Negative", enforcer: "Support enforcer", blocker: "Support blocker" }[kind] || "Modifier"} ${shape}`,
    size: new THREE.Vector3(Math.max(2, s.x * 0.5), Math.max(2, s.y * 0.5), Math.max(2, s.z * 0.5)),
    pos: new THREE.Vector3(0, 0, s.z / 2), overrides: {} };
  if (kind === "modifier") v.overrides.sparse_infill_density = "40%";   // a sensible start, change it below
  v.geo = volumeGeo(v);
  m.volumes.push(v);
  selectedVolume = v;
  plateChanged();
  refresh();
  flash({ negative: "Negative part added: it is cut away from the part when slicing.",
    enforcer: supportsOn(m) ? "Support enforcer added: overhangs inside it get supports." : "Support enforcer added. Supports are off for this part: turn them on (below) for it to work.",
    blocker: "Support blocker added: no supports inside it." }[kind] || "Modifier added: its settings apply inside it.", kind === "enforcer" && !supportsOn(m) ? "warn" : "ok");
}

/** Whether a part gets supports (its own setting, else the print settings'). */
function supportsOn(m) {
  const raw = "enable_support" in m.overrides ? m.overrides.enable_support : processValue("enable_support");
  return /^(1|true)$/.test(String((Array.isArray(raw) ? raw[0] : raw) ?? ""));
}

/** OrcaSlicer only uses enforcers with supports on: "only where enforced" is its manual support type. */
function enforcedSupportsOnly(m) {
  const raw = processValue("support_type");
  const cur = String((Array.isArray(raw) ? raw[0] : raw) || "tree(auto)");
  m.overrides.enable_support = "1";
  m.overrides.support_type = /tree/.test(cur) ? "tree(manual)" : "normal(manual)";
  partEditor.model = null;
  plateChanged();
  refresh();
  flash(`Supports on for ${m.name}, only where enforced (support type "${m.overrides.support_type}").`, "ok");
}

function fillFilamentSelect(sel, current, allowDefault, hide = false) {
  const wrap = sel.closest(".fil-pick");
  wrap.hidden = hide || !multiColour();
  if (wrap.hidden) return;
  sel.innerHTML = (allowDefault ? `<option value="0">Same as the part</option>` : "")
    + filamentSlots().map((f, i) => `<option value="${i + 1}"${i + 1 === current ? " selected" : ""}>${i + 1} · ${esc(f.preset || "")}</option>`).join("");
  if (allowDefault && !current) sel.value = "0";
  wrap.querySelector(".fil-swatch").style.background = current ? slotColour(current) : "transparent";
}

function renderVolumePanel() {
  const v = selectedVolume, el = $("vol-panel");
  el.hidden = !v;
  if (!v) return;
  $("vol-name").textContent = v.name;
  $("vol-kind").textContent = { negative: "Negative part: cut away from the part", modifier: "Modifier: these settings apply inside it",
    part: "Raised part: printed as part of it", enforcer: "Support enforcer: overhangs inside it get supports",
    blocker: "Support blocker: no supports inside it" }[v.kind] || "";
  // enforcers only work with supports on; "only where enforced" is OrcaSlicer's manual support type
  const manual = selected && /manual/.test(String(selected.overrides.support_type ?? [processValue("support_type")].flat()[0] ?? ""));
  $("vol-support-on").hidden = !(v.kind === "enforcer" && selected && (!supportsOn(selected) || !manual));
  $("vol-support-on").classList.toggle("warn", !!selected && !supportsOn(selected));
  $("vol-support-text").textContent = selected && !supportsOn(selected) ? "Supports are off for this part, so OrcaSlicer ignores the enforcer." : "Supports are also made automatically elsewhere on this part.";
  $("vol-support-btn").textContent = selected && !supportsOn(selected) ? "Turn supports on for it, only where enforced" : "Support it only where enforced";
  $("vol-edit-text").hidden = !v.text;
  $("vol-edit-text").textContent = v.text?.svg ? "Edit SVG…" : "Edit text…";
  fillFilamentSelect($("vol-filament"), slotOf(v.overrides), true, SETTINGLESS.has(v.kind));
  const set = (id, val) => { if (!focusedInput(id)) $(id).value = +val.toFixed(2); };
  set("v-sx", v.size.x); set("v-sy", v.size.y); set("v-sz", v.size.z);
  set("v-px", v.pos.x); set("v-py", v.pos.y); set("v-pz", v.pos.z);
  $("vol-settings-wrap").hidden = SETTINGLESS.has(v.kind);
  $("vol-settings-wrap").querySelector(".group-label").textContent = v.kind === "part" ? "Settings for it" : "Settings inside it";
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
  if (m.vlh?.mode === "imported" || m.vlh?.mode === "manual") return m.vlh.pose === poseKey(m) ? m.vlh.profile : null;
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
const lhBrush = { action: "increase", band: 3, z: null, timer: null };      // the layer height brush (below)
function renderLayerPanel() {
  const m = selected;
  if (!m) return;
  const P = lhParams(m);
  const height = m.size.z;
  const imported = m.vlh?.mode === "imported" || m.vlh?.mode === "manual";
  const importedOk = imported && m.vlh.pose === poseKey(m);
  const mode = m.vlh?.mode || "off";
  for (const b of document.querySelectorAll("[data-lh]")) b.classList.toggle("on", b.dataset.lh === mode);
  $("lh-imported-btn").hidden = m.vlh?.mode !== "imported";
  $("lh-adaptive").hidden = mode !== "adaptive";
  $("lh-manual").hidden = mode !== "manual";
  for (const b of document.querySelectorAll("[data-brush]")) b.classList.toggle("on", b.dataset.brush === lhBrush.action);
  $("lh-chart").classList.toggle("brush", mode === "manual");
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
  } else if (imported && !importedOk) info = m.vlh.mode === "manual" ? "The part was turned, scaled or changed since its layer heights were set by hand: uniform layers are used. Choose By hand again to start over."
    : "The project's layer heights no longer match this part (it was rotated, scaled or changed): uniform layers are used.";
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
    <text x="${W - pad - 2}" y="${H - 6}" class="lh-t" text-anchor="end">${+height.toFixed(1)} mm high</text>
    ${lhBrush.z != null && selected?.vlh?.mode === "manual" ? `<rect class="lh-band" x="${x(Math.max(0, lhBrush.z - lhBrush.band / 2)).toFixed(1)}" y="0" width="${(x(Math.min(height, lhBrush.z + lhBrush.band / 2)) - x(Math.max(0, lhBrush.z - lhBrush.band / 2))).toFixed(1)}" height="${H}"/>` : ""}`;
}

/* ---- the layer height brush (OrcaSlicer's layer height editing): hold on the chart to change layers around a height */

function brushTick() {
  const m = selected;
  if (!m || m.vlh?.mode !== "manual" || lhBrush.z == null) return;
  const P = lhParams(m);
  m.vlh.profile = LH.adjustProfile(m.vlh.profile, P, m.size.z, lhBrush.z, 0.005, lhBrush.band, lhBrush.action, rangeLayers(m));
  m.vlh.pose = poseKey(m);
  renderLayerPanel();
}
function brushAt(e) {
  const r = $("lh-chart").getBoundingClientRect(), W = 300, pad = 4;
  const fx = ((e.clientX - r.left) / r.width) * W;
  lhBrush.z = Math.max(0, Math.min(selected.size.z, ((fx - pad) / (W - 2 * pad)) * selected.size.z));
}
$("lh-chart").addEventListener("pointerdown", (e) => {
  if (selected?.vlh?.mode !== "manual") return;
  e.preventDefault();
  $("lh-chart").setPointerCapture(e.pointerId);
  brushAt(e);
  brushTick();
  clearInterval(lhBrush.timer);
  lhBrush.timer = setInterval(brushTick, 40);       // held: keeps changing, as in OrcaSlicer
});
$("lh-chart").addEventListener("pointermove", (e) => { if (lhBrush.timer) brushAt(e); });
const brushEnd = () => {
  if (!lhBrush.timer) return;
  clearInterval(lhBrush.timer);
  lhBrush.timer = null;
  lhBrush.z = null;
  plateChanged();
  refresh();
};
$("lh-chart").addEventListener("pointerup", brushEnd);
$("lh-chart").addEventListener("pointercancel", brushEnd);
for (const b of document.querySelectorAll("[data-brush]")) b.addEventListener("click", () => { lhBrush.action = b.dataset.brush; renderLayerPanel(); });
$("lh-band").addEventListener("input", (e) => { lhBrush.band = +e.target.value; $("lh-band-val").textContent = `${lhBrush.band} mm`; });

function setVlh(v) {
  if (!selected) return;
  selected.vlh = v;
  plateChanged();
  refresh();
}

const rangeEditor = createPartEditor($("range-settings"), () => selRange?.overrides || null, () => { plateChanged(); refresh(); });

/** A filament slot was removed: what used it goes back to filament 1, later slots move down one. */
function removeSlot(n) {
  const fix = (o) => { const s = slotOf(o); if (!s) return; if (s === n) delete o.extruder; else if (s > n) o.extruder = String(s - 1); };
  for (const m of models) {
    fix(m.overrides);
    for (const v of m.volumes) fix(v.overrides);
    const pc = m.paint?.color;
    if (pc) { for (let i = 0; i < pc.length; i++) if (pc[i] === n) pc[i] = 0; else if (pc[i] > n) pc[i]--; m.paintRev = (m.paintRev || 0) + 1; }
    if (m.paintRaw?.color) m.paintRaw = { ...m.paintRaw, color: null };
  }
  for (const p of plates) p.gcodes = (p.gcodes || []).filter((g) => !(g.type === "filament" && g.extruder === n)).map((g) => (g.type === "filament" && g.extruder > n ? { ...g, extruder: g.extruder - 1 } : g));
}

/* ---- text (OrcaSlicer's Text tool): a new part, or raised / engraved / a modifier on a part's face */

let userFonts = [];
let textPlace = null;          // text waiting for a click on its part: { params, model }
const allFonts = () => [...BUNDLED_FONTS, ...userFonts];
const fontUrl = (id) => (allFonts().find((f) => f.id === id) || BUNDLED_FONTS[0]).url;
const shortText = (t) => { const s = String(t).replace(/\s+/g, " ").trim(); return s.length > 18 ? s.slice(0, 17) + "…" : s; };

function showHint(text) { const h = $("hint"); h.textContent = text; h.hidden = !text; }

function textDialog(init, fixedKind = null) {
  const dlg = $("text-dlg");
  const p = { text: "BicuSlicer", font: "roboto-bold", size: 10, depth: 1.5, spacing: 0, lineSpacing: 1.2, kind: selected ? "part" : "object", ...(init || {}) };
  $("text-title").textContent = fixedKind ? "Edit text" : "Add text";
  $("tx-ok").textContent = fixedKind ? "Save" : p.kind === "object" ? "Add" : "Place it…";
  $("tx-text").value = p.text;
  for (const [id, k] of [["tx-size", "size"], ["tx-depth", "depth"], ["tx-spacing", "spacing"], ["tx-line", "lineSpacing"]]) $(id).value = p[k];
  const fillFonts = (sel) => {
    $("tx-font").innerHTML = allFonts().map((f) => `<option value="${esc(f.id)}"${f.id === sel ? " selected" : ""}>${esc(f.label)}</option>`).join("")
      + `<option value="__upload">Add a font file (TTF, OTF, WOFF)…</option>`;
  };
  fillFonts(p.font);
  apiJson("/api/fonts").then((f) => { userFonts = f; fillFonts($("tx-font").value); }).catch(() => {});
  $("tx-kind-wrap").hidden = !!fixedKind;
  for (const r of dlg.querySelectorAll("input[name=tx-kind]")) {
    r.checked = r.value === p.kind;
    r.disabled = r.value !== "object" && !selected;
  }
  $("tx-note").textContent = selected ? "" : "Select a part first to put text on it.";
  const read = () => ({ text: $("tx-text").value, font: $("tx-font").value, size: +$("tx-size").value, depth: +$("tx-depth").value,
    spacing: +$("tx-spacing").value || 0, lineSpacing: +$("tx-line").value || 1.2,
    kind: fixedKind || dlg.querySelector("input[name=tx-kind]:checked")?.value || "object" });
  let seq = 0;
  const preview = async () => {
    const q = read(), n = ++seq;
    $("tx-ok").textContent = fixedKind ? "Save" : q.kind === "object" ? "Add" : "Place it…";
    try {
      const font = await loadFont(fontUrl(q.font));
      if (n === seq) { $("tx-preview").innerHTML = previewSvg(font, q); $("tx-ok").disabled = !q.text.trim(); }
    } catch (e) { if (n === seq) $("tx-preview").textContent = e.message; }
  };
  dlg.oninput = preview;
  $("tx-font").onchange = async (e) => {
    if (e.target.value !== "__upload") { preview(); return; }
    const f = await new Promise((res) => { const i = $("tx-font-file"); i.value = ""; i.onchange = () => res(i.files[0] || null); i.click(); });
    if (!f) { fillFonts(p.font); preview(); return; }
    try {
      const fd = new FormData();
      fd.append("font", f, f.name);
      const added = await apiJson("/api/fonts", { method: "POST", body: fd });
      userFonts.push(added);
      fillFonts(added.id);
      toast(`Added the font "${added.label}" (kept on the server for every device)`);
    } catch (err) { toast(err.message, "err"); fillFonts(p.font); }
    preview();
  };
  preview();
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok" ? read() : null), { once: true }));
}

async function addText() {
  const p = await textDialog(null);
  if (!p) return;
  if (p.kind === "object") { await makeTextPart(p); return; }
  if (!selected) { flash("Select a part to put the text on.", "warn"); return; }
  if (paint.on) stopPaint();
  setPickMode(false);
  textPlace = { params: p, model: selected };
  showHint(`Tap where the text goes on ${selected.name}. Esc to cancel.`);
}

function cancelTextPlace() { if (textPlace) { textPlace = null; showHint(""); } }

/* ---- SVG drawings: the same as text, from a drawing's filled shapes (p.svg holds the file's text) */

const embossName = (p) => (p.svg ? `SVG "${shortText(p.svgName || "drawing")}"` : `Text "${shortText(p.text)}"`);
async function embossGeometry(p) { return p.svg ? svgGeometry(p.svg, p) : textGeometry(await loadFont(fontUrl(p.font)), p); }

function svgDialog(init, fixedKind = null) {
  const dlg = $("svg-dlg");
  const p = { svg: "", svgName: "", width: 30, depth: 1.5, kind: selected ? "part" : "object", ...(init || {}) };
  $("svg-title").textContent = fixedKind ? "Edit the SVG" : "Add an SVG drawing";
  $("svg-width").value = p.width; $("svg-depth").value = p.depth;
  $("svg-kind-wrap").hidden = !!fixedKind;
  for (const r of dlg.querySelectorAll("input[name=svg-kind]")) { r.checked = r.value === p.kind; r.disabled = r.value !== "object" && !selected; }
  $("svg-note").textContent = selected || fixedKind ? "" : "Select a part first to put the drawing on it.";
  let src = p.svg, name = p.svgName, aspect = null, seq = 0;
  const kind = () => fixedKind || dlg.querySelector("input[name=svg-kind]:checked")?.value || "object";
  const update = async () => {
    $("svg-ok").textContent = fixedKind ? "Save" : kind() === "object" ? "Add" : "Place it…";
    $("svg-file").textContent = name || "No file chosen";
    $("svg-preview").innerHTML = src ? svgImage(src) : "";
    const n = ++seq;
    if (!src) { $("svg-size").textContent = ""; $("svg-ok").disabled = true; return; }
    try {
      aspect = await svgAspect(src);
      if (n !== seq) return;
      $("svg-size").textContent = `${(+$("svg-width").value || 0).toFixed(1)} × ${((+$("svg-width").value || 0) * aspect).toFixed(1)} mm`;
      $("svg-ok").disabled = false;
    } catch (e) { if (n === seq) { $("svg-size").textContent = e.message; $("svg-ok").disabled = true; } }
  };
  $("svg-choose").onclick = () => { const i = $("svg-input"); i.value = ""; i.click(); };
  $("svg-input").onchange = async () => {
    const f = $("svg-input").files[0];
    if (!f) return;
    if (f.size > 4e6) { $("svg-size").textContent = "That file is over 4 MB: too big for a drawing to emboss."; return; }
    src = await f.text(); name = f.name.replace(/\.svg$/i, "");
    update();
  };
  dlg.oninput = update;
  update();
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok" && src
    ? { svg: src, svgName: name, width: +$("svg-width").value || 30, depth: +$("svg-depth").value || 1.5, kind: kind() } : null), { once: true }));
}

async function addSvg() {
  const p = await svgDialog(null);
  if (!p) return;
  if (p.kind === "object") { await makeTextPart(p); return; }
  if (!selected) { flash("Select a part to put the drawing on.", "warn"); return; }
  if (paint.on) stopPaint();
  setPickMode(false);
  if (measure.on) setMeasure(false);
  textPlace = { params: p, model: selected };
  showHint(`Tap where the drawing goes on ${selected.name}. Esc to cancel.`);
}

async function makeTextPart(p) {
  busy(p.svg ? "Making the drawing…" : "Making the text…");
  try {
    const geo = await embossGeometry(p);
    centered(geo);
    if (!view.renderer) initViewer();
    const m = newModelRecord(embossName(p), geo);
    m.text = p;
    models.push(m);
    setCopies(m, 1);
    updateBox(m);
    selected = m; multi.clear(); selectedVolume = null;
    settle(m.meshes);
  } catch (e) { flash(`Couldn't make ${p.svg ? "the drawing" : "the text"}: ${e.message}`, "err"); } finally { busy(null); }
}

/** (Re)build a text volume's mesh from its parameters: anchor (x, y from the copy's centre, z above the bed) and face normal. */
async function buildTextVolume(v) {
  const t = v.text;
  const g = await embossGeometry({ ...t, depth: t.depth + 0.3 });       // 0.3 mm into the part (raised) or above it (engraved)
  g.applyMatrix4(placementMatrix(t.anchor, t.normal, v.kind, t.depth));
  const vc = centered(g);
  g.computeBoundingBox();
  const size = g.boundingBox.getSize(new THREE.Vector3());
  Object.assign(v, { base: g, baseSize: size.clone(), size: size.clone(), pos: vc });
  v.geo = volumeGeo(v);
}

async function placeText(hit) {
  const { params: p, model: m } = textPlace;
  cancelTextPlace();
  const copy = hit.object;
  const n = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(copy.matrixWorld)).normalize();
  const anchor = [hit.point.x - copy.position.x, hit.point.y - copy.position.y, hit.point.z];
  const v = { id: nextId++, kind: p.kind, shape: "mesh", name: embossName(p), overrides: {},
    text: { ...p, anchor, normal: n.toArray() } };
  busy("Making the text…");
  try {
    await buildTextVolume(v);
    m.volumes.push(v);
    selected = m; selectedVolume = v;
    plateChanged();
    refresh();
    const what = p.svg ? "drawing" : "text";
    flash(p.kind === "part" ? `Raised ${what} added: it prints as part of the part.` : p.kind === "negative" ? `Engraved ${what} added: it's cut into the part.`
      : `${p.svg ? "Drawing" : "Text"} modifier added: give it its own settings below.`, "ok");
  } catch (e) { flash(`Couldn't make the ${p.svg ? "drawing" : "text"}: ${e.message}`, "err"); } finally { busy(null); }
}

async function editText() {
  const v = selectedVolume, m = selected;
  if (v?.text) {
    const p = await (v.text.svg ? svgDialog(v.text, v.kind) : textDialog(v.text, v.kind));
    if (!p || !m.volumes.includes(v)) return;
    v.text = { ...v.text, ...p, kind: undefined };
    v.name = embossName(v.text);
    busy("Making the text…");
    try { await buildTextVolume(v); plateChanged(); refresh(); } catch (e) { flash(e.message, "err"); } finally { busy(null); }
    return;
  }
  if (!m?.text) return;
  const p = await (m.text.svg ? svgDialog(m.text, "object") : textDialog(m.text, "object"));
  if (!p || !models.includes(m)) return;
  busy("Making the text…");
  try {
    // keep the part's rotation and scale: bake them in, as replaceGeo expects plate axes
    const g = MO.bake(await embossGeometry(p), new THREE.Matrix4().compose(new THREE.Vector3(), m.quat, m.scale));
    replaceGeo(m, g);
    m.text = p;
    m.name = embossName(p);
    plateChanged();
    refresh();
  } catch (e) { flash(e.message, "err"); } finally { busy(null); }
}

/* ---- cut at a height */

// The cut plane goes through the part at a height, tilted by tiltX / tiltY (degrees). Cutting rotates the part so the
// plane is flat (z = 0, the "plane frame"), cuts there with the filled-in Z cut, and turns the halves back, or leaves
// the top half lying on its cut face. Connectors (OrcaSlicer's plugs and dowels) are made in the plane frame too:
// a plug is a raised part on the bottom half with a matching hole (plus tolerance) in the top half; dowels are holes
// in both halves and separate dowel parts.

let cut = null;        // the open cut: { m, copy, plane (Mesh), markers (Group), points: [[u, v]] }

function cutFrame(m, height, tiltX, tiltY) {
  // part-centred coords (rotated and scaled, as bakedGeo) -> plane frame
  const n = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(THREE.MathUtils.degToRad(tiltX), THREE.MathUtils.degToRad(tiltY), 0, "XYZ")).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 0, 1));
  const p0 = new THREE.Vector3(0, 0, m.local.z0 + height);
  const M = new THREE.Matrix4().makeRotationFromQuaternion(q).multiply(new THREE.Matrix4().makeTranslation(-p0.x, -p0.y, -p0.z));
  return { M, inv: M.clone().invert(), n };
}

function readCut() {
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  return { height: num("cut-h", 0), tiltX: num("cut-tx", 0), tiltY: num("cut-ty", 0), keep: $("cut-keep").value, faceDown: $("cut-face").checked,
    conn: { type: $("cut-conn").value, shape: $("cut-shape").value, size: Math.max(1, num("cut-size", 5)), depth: Math.max(1, num("cut-depth", 6)),
      tol: Math.max(0, num("cut-tol", 0.15)), count: Math.max(1, Math.min(12, Math.round(num("cut-count", 2)))) },
    dove: { width: Math.max(1, num("dv-width", 10)), depth: Math.max(0.5, num("dv-depth", 5)), angle: Math.max(0, Math.min(45, num("dv-angle", 15))),
      dir: num("dv-dir", 0), tol: Math.max(0, num("dv-tol", 0.2)) } };
}

/** Cross-section of the part on the cut plane: its cap triangles (2D, plane frame) and outline edges. */
function cutSection(m, P) {
  const { M } = cutFrame(m, P.height, P.tiltX, P.tiltY);
  const r = MO.cutAtZ(MO.bake(bakedGeo(m), M), 0, { capTop: false, capBottom: true });
  const tris = [];
  if (r.bottom) {
    const p = r.bottom.getAttribute("position").array;
    for (let i = 0; i < p.length; i += 9) if (Math.abs(p[i + 2]) < 1e-4 && Math.abs(p[i + 5]) < 1e-4 && Math.abs(p[i + 8]) < 1e-4) tris.push([p[i], p[i + 1], p[i + 3], p[i + 4], p[i + 6], p[i + 7]]);
  }
  const key = (x, y) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  const count = new Map();
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const a = [t[k * 2], t[k * 2 + 1]], b = [t[((k + 1) % 3) * 2], t[((k + 1) % 3) * 2 + 1]];
    const id = [key(...a), key(...b)].sort().join("|");
    const e = count.get(id);
    count.set(id, e ? { ...e, n: e.n + 1 } : { a, b, n: 1 });
  }
  const edges = [...count.values()].filter((e) => e.n === 1).map((e) => [e.a, e.b]);
  return { tris, edges };
}

/** The middle of the cross-section's area (plane frame), or null. */
function sectionCentre(sec) {
  let a = 0, x = 0, y = 0;
  for (const t of sec.tris) {
    const ar = Math.abs((t[2] - t[0]) * (t[5] - t[1]) - (t[4] - t[0]) * (t[3] - t[1])) / 2;
    a += ar; x += ar * (t[0] + t[2] + t[4]) / 3; y += ar * (t[1] + t[3] + t[5]) / 3;
  }
  return a > 0 ? [+(x / a).toFixed(2), +(y / a).toFixed(2)] : null;
}

/**
 * A dovetail's prism in the plane frame: a trapezoid across the groove (width at the cut plane, widening by `angle`
 * on each side going up), z from z0 to z1, grown by tol on every side, running `len` mm along the groove's direction.
 */
function dovetailPrism(D, [cu, cv], len, tol, z0, z1) {
  const k = Math.tan(THREE.MathUtils.degToRad(D.angle));
  const half = (z) => D.width / 2 + Math.max(0, z) * k + tol;
  const shape = new THREE.Shape([new THREE.Vector2(-half(z0), z0), new THREE.Vector2(half(z0), z0), new THREE.Vector2(half(z1), z1), new THREE.Vector2(-half(z1), z1)]);
  const g = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
  g.translate(0, 0, -len / 2);
  g.rotateX(Math.PI / 2);                        // (x, y, z) -> (x, -z, y): the trapezoid stands up, the groove runs along y
  g.rotateZ(THREE.MathUtils.degToRad(D.dir));
  g.translate(cu, cv, 0);
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", g.toNonIndexed().getAttribute("position").clone());
  g.dispose();
  return out;
}

/** Spread n connector spots over the cross-section: as far from its outline and from each other as possible. */
function autoConnectors(sec, n, size) {
  if (!sec.tris.length) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of sec.tris) for (let k = 0; k < 6; k += 2) { x0 = Math.min(x0, t[k]); x1 = Math.max(x1, t[k]); y0 = Math.min(y0, t[k + 1]); y1 = Math.max(y1, t[k + 1]); }
  const step = Math.max(0.5, Math.min(x1 - x0, y1 - y0) / 40);
  const inTri = (x, y, t) => {
    const d = (t[2] - t[0]) * (t[5] - t[1]) - (t[3] - t[1]) * (t[4] - t[0]);
    const a = ((t[2] - x) * (t[5] - y) - (t[3] - y) * (t[4] - x)) / d, b = ((t[4] - x) * (t[1] - y) - (t[5] - y) * (t[0] - x)) / d;
    return a >= 0 && b >= 0 && a + b <= 1;
  };
  const segDist = (x, y, [a, b]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L));
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
  };
  const cands = [];
  for (let y = y0 + step / 2; y < y1; y += step) for (let x = x0 + step / 2; x < x1; x += step) {
    if (!sec.tris.some((t) => inTri(x, y, t))) continue;
    const dEdge = Math.min(...sec.edges.map((e) => segDist(x, y, e)));
    if (dEdge >= size / 2 + 1.2) cands.push([x, y, dEdge]);      // room for the connector and a wall around it
  }
  if (!cands.length) return [];
  const out = [cands.reduce((a, c) => (c[2] > a[2] ? c : a))];
  while (out.length < n) {
    let best = null, bestD = -1;
    for (const c of cands) {
      const d = Math.min(...out.map((o) => Math.hypot(c[0] - o[0], c[1] - o[1])));
      if (d > bestD) { bestD = d; best = c; }
    }
    if (!best || bestD < size + 2) break;          // no more room
    out.push(best);
  }
  return out.map((c) => [+c[0].toFixed(2), +c[1].toFixed(2)]);
}

function connectorShape(shape, d, len) {
  // centred on the origin along Z
  if (shape === "square") return MO.box(d, d, len);
  if (shape === "hex") return MO.cylinder(d, len, 6);
  return MO.cylinder(d, len, 48);
}

function cutPreview() {
  if (!cut) return;
  const P = readCut(), m = cut.m;
  const { inv } = cutFrame(m, P.height, P.tiltX, P.tiltY);
  // plane frame -> plate: back to part-centred coords, then to where this copy stands
  const toPlate = new THREE.Matrix4().makeTranslation(cut.copy.position.x, cut.copy.position.y, -m.local.z0).multiply(inv);
  cut.plane.matrix.copy(toPlate);
  cut.markers.matrix.copy(toPlate);
  const dove = P.conn.type === "dovetail";
  const pts = dove ? (cut.points.length ? cut.points.slice(-1) : [sectionCentre(cutSection(m, P))].filter(Boolean))
    : cut.points.length ? cut.points : P.conn.type !== "none" ? autoConnectors(cutSection(m, P), P.conn.count, P.conn.size) : [];
  cut.auto = cut.points.length ? null : pts;
  while (cut.markers.children.length) { const c = cut.markers.children.pop(); c.geometry.dispose(); }
  if (dove && pts.length) {
    const mk = new THREE.Mesh(dovetailPrism(P.dove, pts[0], Math.max(m.size.x, m.size.y, m.size.z) * 1.5 + 10, 0, -0.5, P.dove.depth), view.mats.modifierSel);
    cut.markers.add(mk);
  }
  if (P.conn.type !== "none" && !dove) for (const [u, v] of pts) {
    const g = connectorShape(P.conn.shape, P.conn.size, P.conn.depth * 2);
    const mk = new THREE.Mesh(g, view.mats.modifierSel);
    mk.position.set(u, v, 0);
    cut.markers.add(mk);
  }
  $("cut-conn-opts").hidden = P.conn.type === "none" || dove;
  $("cut-dove-opts").hidden = !dove;
  $("cut-points").textContent = P.conn.type === "none" ? "" : dove ? "The bottom part gets a tongue, the top a matching groove: slide them together. Tap the cut plane to move it."
    : cut.points.length
    ? `${cut.points.length} placed by tapping. Tap the plane to add more.` : `${pts.length} placed automatically${pts.length < P.conn.count ? " (that's all that fit)" : ""}. Or tap the cut plane to place them yourself.`;
  $("cut-clear-points").hidden = !cut.points.length;
}

function openCut() {
  const m = selected;
  if (!m) return;
  closeCut();
  const dlg = $("cut-dlg");
  $("cut-name").textContent = m.name;
  const h = $("cut-h"), r = $("cut-range");
  r.max = h.max = m.size.z.toFixed(2);
  h.value = r.value = (m.size.z / 2).toFixed(2);
  const copy = selectedCopy();
  const span = Math.max(m.size.x, m.size.y, m.size.z) * 1.4 + 4;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(span, span),
    new THREE.MeshBasicMaterial({ color: css("--accent"), transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
  const markers = new THREE.Group();
  for (const o of [plane, markers]) { o.matrixAutoUpdate = false; view.scene.add(o); }
  cut = { m, copy, plane, markers, points: [], auto: null };
  h.oninput = () => { r.value = h.value; cutPreview(); };
  r.oninput = () => { h.value = r.value; cutPreview(); };
  dlg.oninput = (e) => { if (e.target !== h && e.target !== r) cutPreview(); };
  dlg.onchange = (e) => { if (["cut-size", "cut-shape"].includes(e.target.id)) cutPreview(); };
  cutPreview();
  dlg.returnValue = "";
  dlg.show();      // not modal: the plate stays visible (and tappable) with the cut plane
  dlg.onclose = () => {
    const P = readCut(), pts = cut?.points.length ? cut.points : cut?.auto || [];
    closeCut();
    if (dlg.returnValue === "ok") doCut(m, P, pts);
  };
}

function closeCut() {
  if (!cut) return;
  view.scene.remove(cut.plane, cut.markers);
  cut.plane.geometry.dispose();
  for (const c of cut.markers.children) c.geometry.dispose();
  cut = null;
}

/** A tap while the cut dialog is open: on the cut plane, it places a connector there. */
function cutTap(e) {
  if (!cut || readCut().conn.type === "none") return false;
  const hit = rayFrom(e).intersectObject(cut.plane, false)[0];
  if (!hit) return false;
  const p = hit.point.clone().applyMatrix4(cut.plane.matrix.clone().invert());
  cut.points.push([+p.x.toFixed(2), +p.y.toFixed(2)]);
  cutPreview();
  return true;
}

function doCut(m, P, pts) {
  if (!models.includes(m) || !(P.height > 0) || !(P.height < m.size.z)) { flash("Pick a height inside the part.", "warn"); return; }
  busy("Cutting…");
  setTimeout(async () => {
    try {
      const { M, inv } = cutFrame(m, P.height, P.tiltX, P.tiltY);
      const whole = MO.bake(bakedGeo(m), M);
      let { top, bottom, openLoops } = MO.cutAtZ(whole, 0, { capTop: true, capBottom: true });
      if (!top || !bottom) throw new Error("the plane misses the part");
      const base = cut?.copy?.position?.clone() || selectedCopy().position.clone();
      const C = P.conn, conn = C.type === "none" || C.type === "dovetail" ? [] : pts;
      if (C.type === "dovetail" && pts.length) {
        // the tongue (the part where the prism is) joins the bottom; the top gets the prism, plus tolerance, cut out
        const len = Math.max(m.size.x, m.size.y, m.size.z) * 2 + 20;
        const at = pts[pts.length - 1];       // the last tap moves it
        const tongue = await MT.boolean("intersect", [whole, dovetailPrism(P.dove, at, len, 0, -0.5, P.dove.depth)]);
        bottom = await MT.boolean("union", [bottom, tongue]);
        top = await MT.boolean("subtract", [top, dovetailPrism(P.dove, at, len, P.dove.tol, -0.5, P.dove.depth + P.dove.tol)]);
      }
      // connector pieces in the plane frame: [geometry, kind] for the bottom and top halves
      const vols = { bottom: [], top: [] }, dowels = [];
      const at = (g, u, v, z0, z1) => MO.bake(g, new THREE.Matrix4().makeTranslation(u, v, (z0 + z1) / 2));
      for (const [u, v] of conn) {
        const hole = C.size + 2 * C.tol;
        if (C.type === "plug") {
          vols.bottom.push([at(connectorShape(C.shape, C.size, C.depth + 1), u, v, -1, C.depth), "part"]);          // the plug, 1 mm into its half
          vols.top.push([at(connectorShape(C.shape, hole, C.depth + C.tol + 0.4), u, v, -0.2, C.depth + C.tol + 0.2), "negative"]);
        } else {
          vols.bottom.push([at(connectorShape(C.shape, hole, C.depth + 0.4), u, v, -C.depth - 0.2, 0.2), "negative"]);
          vols.top.push([at(connectorShape(C.shape, hole, C.depth + 0.4), u, v, -0.2, C.depth + 0.2), "negative"]);
          dowels.push(1);
        }
      }
      // where each half goes: bottom as it was; top as it was, or lying on its cut face (it already does in the plane frame)
      const back = (g) => MO.bake(g, inv);
      const halves = [];
      if (P.keep !== "top") halves.push(["bottom", back(bottom), vols.bottom.map(([g, k]) => [back(g), k])]);
      if (P.keep !== "bottom") {
        const keepFrame = P.faceDown;
        halves.push(["top", keepFrame ? top : back(top), vols.top.map(([g, k]) => [keepFrame ? g : back(g), k])]);
      }
      removeModel(m);
      const made = [];
      halves.forEach(([which, g, vl], i) => {
        g.computeBoundingBox();
        const c = g.boundingBox.getCenter(new THREE.Vector3()), minZ = g.boundingBox.min.z;
        const piece = newModelRecord(`${m.name} (${which})`, g);
        centered(g);
        piece.overrides = JSON.parse(JSON.stringify(m.overrides || {}));
        for (const [vg, kind] of vl) {
          vg.computeBoundingBox();
          const vc = vg.boundingBox.getCenter(new THREE.Vector3());
          centered(vg);
          const size = vg.boundingBox.getSize(new THREE.Vector3());
          const v = { id: nextId++, kind, shape: "mesh", name: kind === "part" ? "Plug" : "Connector hole", overrides: {},
            base: vg, baseSize: size.clone(), size: size.clone(), pos: new THREE.Vector3(vc.x - c.x, vc.y - c.y, vc.z - minZ) };
          v.geo = volumeGeo(v);
          piece.volumes.push(v);
        }
        models.push(piece);
        setCopies(piece, 1);
        updateBox(piece);
        piece.meshes[0].position.x = base.x + i * (m.size.x + partGap());      // x and y only: updateBox set the height that sits it on the bed
        piece.meshes[0].position.y = base.y;
        made.push(piece);
      });
      if (dowels.length) {
        // the dowels: printed lying down (stronger along their length), slightly shorter than the two holes
        const len = 2 * C.depth - 0.4;
        const dg = MO.bake(connectorShape(C.shape, C.size, len), new THREE.Matrix4().makeRotationY(Math.PI / 2));
        centered(dg);
        const dm = newModelRecord(`${m.name} dowel`, dg);
        dm.overrides = { enable_support: "0" };     // a small dowel's underside prints fine; supports would also grow into its neighbours
        models.push(dm);
        setCopies(dm, dowels.length);
        updateBox(dm);
        dm.meshes.forEach((x, k) => { x.position.x = base.x; x.position.y = base.y + m.size.y / 2 + 10 + k * (C.size + partGap()); });
        made.push(dm);
      }
      selected = made[0] || null; multi.clear(); selectedVolume = null;
      settle(made.flatMap((x) => x.meshes));
      const what = C.type === "dovetail" && pts.length ? " with a dovetail" : conn.length ? ` with ${conn.length} ${C.type === "plug" ? "plug" : "dowel"}${conn.length === 1 ? "" : "s"}` : "";
      flash(openLoops ? `Cut${what}, but ${openLoops} cut outline(s) weren't closed (the model has holes): try Fix model first.` : `Cut${what}.`, openLoops ? "warn" : "ok");
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
const PAINT_KINDS = ["supports", "seam", "fuzzy", "color"];
const PAINT_ATTR = { supports: "paint_supports", seam: "paint_seam", fuzzy: "paint_fuzzy_skin", color: "paint_color" };
const PAINT_UI = {
  supports: { title: "Paint supports", t1: "Enforce", t2: "Block", note: "Green = always support here, red = never. With supports set to \"manual\" in the print settings, supports go only where you've painted green." },
  seam: { title: "Paint seam", t1: "Seam here", t2: "Avoid", note: "Blue = put the seam here, orange = keep the seam away." },
  fuzzy: { title: "Paint fuzzy skin", t1: "Fuzzy", t2: null, note: "Purple = fuzzy skin here. Its look comes from the fuzzy skin settings (thickness, point distance)." },
  color: { title: "Paint colours", note: "Paint with a filament; Erase goes back to the part's own filament. On one nozzle each colour change in a layer is a filament swap." },
};
const hexRgb = (h) => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };
function paintPalette(target, m) {
  if (target !== "color") return PAINT_COLOURS[target];
  const pal = { 0: hexRgb(slotColour(partSlot(m))) };
  filamentSlots().forEach((f, i) => { pal[i + 1] = hexRgb(f.colour); });
  return pal;
}
function renderPaintTools(target) {
  const ui = PAINT_UI[target];
  $("paint-tools").innerHTML = target === "color"
    ? filamentSlots().map((f, i) => `<button type="button" data-paint-tool="${i + 1}"><span class="fil-swatch" style="background:${f.colour}"></span>${i + 1}</button>`).join("")
      + `<button type="button" data-paint-tool="0">Erase</button>`
    : `<button type="button" data-paint-tool="1">${esc(ui.t1)}</button>${ui.t2 ? `<button type="button" data-paint-tool="2">${esc(ui.t2)}</button>` : ""}<button type="button" data-paint-tool="0">Erase</button>`;
}
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
  if (viewMode === "preview") setViewMode("model");       // painting happens on the model, not on the layers
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
      renderPaintTools(target);
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
  const col = m.geo.getAttribute("color"), arr = col.array, st = m.paint[paint.target], pal = paintPalette(paint.target, m);
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
  m.text = src.text || null;
  m.ears = src.ears ? JSON.parse(JSON.stringify(src.ears)) : null;
  m.vlh = src.vlh ? JSON.parse(JSON.stringify(src.vlh)) : null;
  if (m.vlh?.mode === "imported" || m.vlh?.mode === "manual") m.vlh.pose = poseKey(m);
  m.ranges = (src.ranges || []).map((r) => ({ ...r, id: nextId++, overrides: { ...r.overrides } }));
  models.push(m);
  setCopies(m, 1);
  updateBox(m);
  const ref = src.meshes.filter((x) => plateOf(x) === cur).pop();
  if (ref) { m.meshes[0].position.x = ref.position.x + m.size.x + partGap(); m.meshes[0].position.y = ref.position.y; }
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
    if ((k === "ArrowLeft" || k === "ArrowRight") && view.preview.hasMoves) {
      handled();
      stepMove((k === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 10 : 1));
      return;
    }
  }
  switch (k) {
    case "Escape": if (simp) closeSimplify(false); else if (ears.on) stopEars(); else if (measure.on) setMeasure(false); else if (textPlace) cancelTextPlace(); else if (paint.on) stopPaint(); else if (pickMode) setPickMode(false); else { selected = null; multi.clear(); selectedVolume = null; refresh(); } break;
    case "Delete": case "Backspace": if (selected || multi.size) { handled(); $("obj-delete").click(); } return;
    case "a": case "A": if (models.length) { handled(); arrange(); } return;
    case "f": case "F": if (selected) { handled(); setPickMode(!pickMode); } return;
    case "m": case "M": if (models.length) { handled(); setMeasure(!measure.on); } return;
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
    presets: { ...S.selected, bed_type: S.bedType, filaments: multiColour() ? filamentSlots() : null }, edits: S.edits,
    plates: plates.map((p) => ({ name: p.name, bed_type: p.bedType, print_sequence: p.seq, spiral_mode: p.spiral, gcodes: p.gcodes, calib: p.calib })),
    models: models.map((m, i) => ({
      mid: i, name: m.name, quat: m.quat.toArray(), scale: m.scale.toArray(), overrides: m.overrides, printable: m.printable !== false,
      text: m.text || null,
      ears: m.ears || null,
      volumes: m.volumes.map((v) => ({ name: v.name, kind: v.kind, shape: v.shape, size: v.size.toArray(), pos: v.pos.toArray(), overrides: v.overrides, text: v.text || null,
        ...(v.shape === "mesh" ? { vmid: extraMeshes.push(v.base) - 1 + models.length, base_size: v.baseSize.toArray() } : {}) })),
      paint: m.paint ? Object.fromEntries(PAINT_KINDS.map((k) => [k, m.paint[k] ? b64(m.paint[k]) : null])) : null,
      paint_raw: m.paintRaw ? Object.fromEntries(PAINT_KINDS.map((k) => [k, sparse(m.paintRaw[k])])) : null,
      layer_height: m.vlh ? { ...m.vlh, pose: undefined, pose_ok: !["imported", "manual"].includes(m.vlh.mode) || m.vlh.pose === poseKey(m) } : null,
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
    if (Array.isArray(meta.presets?.filaments) && meta.presets.filaments.length > 1) setFilamentSlots(meta.presets.filaments);
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
      m.text = pm.text || null;
      m.ears = Array.isArray(pm.ears) ? pm.ears : null;
      m.printable = pm.printable !== false;
      m.volumes = [];
      for (const v of pm.volumes || []) {
        const vol = { id: nextId++, name: v.name, kind: v.kind, shape: v.shape, size: new THREE.Vector3().fromArray(v.size),
          pos: new THREE.Vector3().fromArray(v.pos), overrides: v.overrides || {}, ...(v.text ? { text: v.text } : {}) };
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
      if (pm.layer_height && (!["imported", "manual"].includes(pm.layer_height.mode) || pm.layer_height.pose_ok)) {
        m.vlh = { ...pm.layer_height };
        delete m.vlh.pose_ok;
      }
      m.ranges = (pm.height_ranges || []).map((r) => ({ id: nextId++, from: r.from, to: r.to, overrides: r.overrides || {} }));
      models.push(m);
      setCopies(m, (pm.instances || [[bed.w / 2, bed.d / 2, 0]]).length);
      updateBox(m);
      if (m.vlh?.mode === "imported" || m.vlh?.mode === "manual") m.vlh.pose = poseKey(m);
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
$("show-travel").addEventListener("change", (e) => { view.preview.showTravel = e.target.checked; view.preview.move = null; view.preview.setLayer(view.preview.layer); renderMoves(); });
$("move").addEventListener("input", (e) => { view.preview.setMove(Number(e.target.value) - 1); renderMoves(); });
$("move-down").addEventListener("click", () => stepMove(-1));
$("move-up").addEventListener("click", () => stepMove(1));
$("color-mode").addEventListener("change", (e) => {
  view.preview.setMode(e.target.value);
  try { localStorage.setItem("bs-colour-mode", view.preview.wanted); } catch {}
  renderLegend();
});
$("legend").addEventListener("change", (e) => {
  const i = e.target.dataset.feat;
  if (i === undefined) return;
  view.preview.setFeature(Number(i), e.target.checked);
  renderLegend();
  renderMoves();
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
    bowden: /bowden/i.test(String(mv.extruder_type || "")),
    // the printer's motion limits (the input shaping and cornering tests print at them, as OrcaSlicer's do)
    maxSpeed: Math.round(Math.min(num0(mv.machine_max_speed_x) || 300, num0(mv.machine_max_speed_y) || 300)),
    maxAccel: Math.round(num0(mv.machine_max_acceleration_extruding) || 5000),
    maxJerk: num0(mv.machine_max_jerk_x) || 0, jd: num0(mv.machine_max_junction_deviation) || 0 };
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
    calib: { id, params, name: plan.name, legend: plan.legend, result: plan.result, edits: plan.edits || null, post: plan.post || null } });
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
    : `<label>${esc(r.ask || (r.kind === "pa" ? "Height of the sharpest corners" : "Height where it starts to fail"))} <span class="muted">(mm)</span> <input id="calres-in" type="number" step="0.1" min="0" inputmode="decimal"></label>`;
  // some results (input shaping, cornering) belong in the printer's firmware config: shown, not applied
  const info = ["shaperFreq", "shaperDamp", "cornering"].includes(r.kind);
  $("calres-ok").textContent = info ? "Done" : "Apply to filament";
  const show = () => { const v = $("calres-in").value; const e = v !== "" ? CAL.resultEdits(r, v, ctx) : null; $("calres-out").textContent = e ? (e.edits ? `Sets ${e.text}` : `Put this in your printer's config: ${e.text}`) : ""; $("calres-ok").disabled = !e; };
  $("calres-in").oninput = show;
  show();
  dlg.returnValue = "";
  dlg.showModal();
  await new Promise((res) => dlg.addEventListener("close", res, { once: true }));
  if (dlg.returnValue !== "ok") return;
  const e = CAL.resultEdits(r, $("calres-in").value, ctx);
  if (!e?.edits) return;
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
  mesh.position.x += selected.size.x + partGap();
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
$("paint-tools").addEventListener("click", (e) => { const b = e.target.closest("[data-paint-tool]"); if (b) setPaintTool(Number(b.dataset.paintTool)); });
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
initSettings((what, info) => {
  if (what === "presets") { setBed(); refreshPrinter(); }
  if (what === "presets" || what === "edits") { settingsVersion++; plateChanged(); }
  if (what === "filaments") {
    if (info?.removed) removeSlot(info.removed);
    plateChanged();
    refresh();
  }
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
  else if (v === "manual" && !(selected.vlh?.mode === "manual" && selected.vlh.pose === poseKey(selected))) {
    // start from what's there now: the adaptive profile, or uniform layers (and height ranges)
    const m = selected, P = lhParams(m);
    const from = partProfile(m) || LH.rangesProfile(m.size.z, P, rangeLayers(m));
    setVlh({ mode: "manual", profile: from.slice(), pose: poseKey(m) });
  }
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
$("obj-edit-text").addEventListener("click", editText);
$("cut-clear-points").addEventListener("click", () => { if (cut) { cut.points = []; cutPreview(); } });
$("vol-edit-text").addEventListener("click", editText);
$("vol-support-btn").addEventListener("click", () => { if (selected) enforcedSupportsOnly(selected); });
$("ears-done").addEventListener("click", stopEars);
$("lg-pause").addEventListener("click", () => addLayerGcode("pause"));
$("lg-custom").addEventListener("click", () => addLayerGcode("custom"));
$("lg-filament").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, [{ head: "From this layer, print with" },
    ...filamentSlots().map((f, i) => ({ label: `Filament ${i + 1} · ${f.preset}`, run: () => addLayerGcode("filament", i + 1) }))]);
});
/* ---- purging (OrcaSlicer's flushing volumes, and flush into objects / infill / supports) */

/** OrcaSlicer only uses the purge table, and purging into parts, with the printer's "Purge in prime tower" on. */
const purgeOn = () => /^(1|true)$/.test(String([machineValues().purge_in_prime_tower].flat()[0] ?? "1"));
const flushDefault = (k) => /^(1|true)$/.test(String([processValue(k)].flat()[0] ?? (k === "flush_into_support" ? "1" : "0")));
function renderFlushOpts() {
  const m = selected, wrap = $("obj-flush");
  wrap.hidden = !m || !multiColour();
  if (wrap.hidden) return;
  for (const c of wrap.querySelectorAll("[data-flush]")) {
    const k = c.dataset.flush;
    c.checked = k in m.overrides ? /^(1|true)$/.test(String(m.overrides[k])) : flushDefault(k);
  }
  $("obj-flush-off").hidden = purgeOn();
}
$("obj-flush").addEventListener("change", (e) => {
  const k = e.target.dataset.flush;
  if (!k || !selected) return;
  for (const m of selection()) {
    if (e.target.checked === flushDefault(k)) delete m.overrides[k]; else m.overrides[k] = e.target.checked ? "1" : "0";
  }
  partEditor.model = null;
  plateChanged();
  refresh();
});

/** The purge table the print settings set by hand (row-major, from → to), when it fits the filament slots. */
function flushMatrix(n = filamentSlots().length) {
  const raw = [S.edits.process?.flush_volumes_matrix].flat()[0];
  const v = String(raw ?? "").split(",").map(Number).filter((x) => Number.isFinite(x));
  return v.length === n * n ? v : null;
}

async function openFlush() {
  const slots = filamentSlots(), n = slots.length, dlg = $("flush-dlg");
  if (n < 2) return;
  const manual = flushMatrix(n);
  // what the last slice used (OrcaSlicer's automatic values), as a starting point
  const last = plates.map((p) => p.job?.plates?.[0]).find((pl) => pl?.flush_matrix?.length === n * n);
  const seed = manual || last?.flush_matrix || Array.from({ length: n * n }, (_, i) => (Math.floor(i / n) === i % n ? 0 : 280));
  const multRaw = [S.edits.process?.flush_multiplier ?? processValue("flush_multiplier")].flat()[0];
  $("fl-mult").value = +(+multRaw || last?.flush_multiplier || 0.3).toFixed(3);
  const sw = (i) => `<span class="sw" style="background:${esc(slots[i].colour)}"></span>${i + 1}`;
  $("fl-grid").innerHTML = `<table><thead><tr><th>from \ to</th>${slots.map((_, j) => `<th>${sw(j)}</th>`).join("")}</tr></thead><tbody>${slots.map((_, i) =>
    `<tr><th>${sw(i)}</th>${slots.map((_, j) => `<td><input type="number" min="0" max="20000" step="1" data-ij="${i * n + j}" value="${Math.round(seed[i * n + j])}"${i === j ? " disabled" : ""} aria-label="From ${i + 1} to ${j + 1}"></td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const mode = () => dlg.querySelector("input[name=fl-mode]:checked")?.value || "auto";
  const sync = () => {
    const auto = mode() === "auto";
    for (const i of $("fl-grid").querySelectorAll("input")) i.disabled = auto || i.dataset.ij % (n + 1) === 0;
    $("fl-note").textContent = auto ? (last ? "Shown: the values OrcaSlicer used for your last slice of these filaments." : "Slice once to see the values OrcaSlicer works out.") : "Your values replace OrcaSlicer's for every plate.";
  };
  for (const r of dlg.querySelectorAll("input[name=fl-mode]")) { r.checked = r.value === (manual ? "manual" : "auto"); r.onchange = sync; }
  $("fl-purge-off").hidden = purgeOn();
  $("fl-prime").textContent = +[processValue("prime_volume")].flat()[0] || 45;
  $("fl-purge-on").onclick = () => {
    applyMachineEdits({ purge_in_prime_tower: "1" });
    $("fl-purge-off").hidden = true;
    renderFlushOpts();
    toast(`"Purge in prime tower" on: an unsaved change to ${S.selected.machine}.`);
  };
  sync();
  dlg.returnValue = "";
  dlg.showModal();
  await new Promise((r) => dlg.addEventListener("close", r, { once: true }));
  if (dlg.returnValue !== "ok") return;
  const mult = Math.max(0, +$("fl-mult").value || 0);
  const changes = { flush_multiplier: [String(mult)] };
  if (mode() === "manual") changes.flush_volumes_matrix = [[...$("fl-grid").querySelectorAll("input")].map((i) => String(Math.max(0, Math.round(+i.value || 0)))).join(",")];
  else delete S.edits.process.flush_volumes_matrix;
  applyProcessEdits(changes);
  plateChanged();
  toast(mode() === "manual" ? "Purge volumes set by hand: an unsaved change to the print settings." : `Purge volumes automatic, × ${mult}.`);
}
$("fil-slots").addEventListener("click", (e) => { if (e.target.closest("#fil-flush")) openFlush(); });

$("obj-filament").addEventListener("change", (e) => {
  if (!selected) return;
  for (const m of selection()) m.overrides.extruder = e.target.value;
  partEditor.render();
  plateChanged();
  refresh();
});
$("vol-filament").addEventListener("change", (e) => {
  const v = selectedVolume;
  if (!v) return;
  if (e.target.value === "0") delete v.overrides.extruder; else v.overrides.extruder = e.target.value;
  volEditor.render?.();
  plateChanged();
  refresh();
});
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
