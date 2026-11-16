// Reads 3MF files, including OrcaSlicer / Bambu Studio projects (what MakerWorld downloads are): objects and their
// parts (normal parts, modifiers, negative parts), per-object and per-part settings, copies (build items), plates,
// painted supports and seams, and the project's settings. Pure data in, plain data out (no three.js, no DOM), so it
// also runs under Node for tests. The caller unzips: files = { "3D/3dmodel.model": Uint8Array, ... }.
//
// Formats follow OrcaSlicer's own reader (src/libslic3r/Format/bbs_3mf.cpp, TriangleSelector.cpp, PartPlate.cpp):
//  - 3D/3dmodel.model: objects with a <mesh>, or <components> pointing at objects (possibly in 3D/Objects/*.model
//    via p:path), and <build><item objectid transform printable> (one item per copy).
//  - Metadata/model_settings.config: <object id> with <metadata key value> settings and <part id subtype> per
//    component (id = the component's objectid), and <plate> blocks listing <model_instance> object_id/instance_id.
//  - Metadata/project_settings.config: the whole configuration the project was made with (JSON).
//  - triangles carry paint_supports / paint_seam (and paint_color for multi-colour) as hex strings encoding a tree of
//    sub-triangles (TriangleSelector); kept as they are so OrcaSlicer gets exactly what was painted.

const dec = new TextDecoder();
const text = (u8) => (u8 ? dec.decode(u8) : "");

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m);

function attrs(s) {
  const o = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) o[m[1]] = unxml(m[2]);
  return o;
}

function metadata(block) {
  const o = {};
  for (const m of block.matchAll(/<metadata\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.key != null) o[a.key] = a.value ?? "";
  }
  return o;
}

const UNITS = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

/** 3MF transform "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" (row vectors): p' = [x y z 1] · M */
export function parseTransform(s) {
  const v = (s || "").trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
}
export function mulTransform(a, b) {        // apply a, then b
  const r = new Array(12);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j] + (i === 3 ? b[9 + j] : 0);
  }
  return r;
}
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const isIdent = (t) => t.every((x, i) => Math.abs(x - IDENT[i]) < 1e-12);

function transformPositions(pos, t) {
  if (isIdent(t)) return pos;
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    out[i] = x * t[0] + y * t[3] + z * t[6] + t[9];
    out[i + 1] = x * t[1] + y * t[4] + z * t[7] + t[10];
    out[i + 2] = x * t[2] + y * t[5] + z * t[8] + t[11];
  }
  return out;
}
export { transformPositions };

/** One <mesh>: triangle soup (9 floats per triangle) and the paint strings per triangle (sparse arrays). */
function parseMesh(body, scale) {
  const vx = [];
  let m;
  const vre = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
  while ((m = vre.exec(body))) vx.push(+m[1], +m[2], +m[3]);
  if (!vx.length) {          // attributes in another order
    for (const v of body.matchAll(/<vertex\b([^>]*)\/?>/g)) { const a = attrs(v[1]); vx.push(+a.x, +a.y, +a.z); }
  }
  const tris = [];
  const paint = { supports: null, seam: null, fuzzy: null, color: null };
  const tre = /<triangle\b([^>]*?)\/?>/g;
  let k = 0;
  while ((m = tre.exec(body))) {
    const s = m[1];
    const v1 = /\bv1="(\d+)"/.exec(s), v2 = /\bv2="(\d+)"/.exec(s), v3 = /\bv3="(\d+)"/.exec(s);
    if (!v1 || !v2 || !v3) continue;
    tris.push(+v1[1], +v2[1], +v3[1]);
    if (s.length > 30) {
      const ps = /\bpaint_supports="([0-9A-Fa-f]+)"/.exec(s), pm = /\bpaint_seam="([0-9A-Fa-f]+)"/.exec(s), pf = /\bpaint_fuzzy_skin="([0-9A-Fa-f]+)"/.exec(s);
      if (ps) (paint.supports ||= [])[k] = ps[1].toUpperCase();
      if (pm) (paint.seam ||= [])[k] = pm[1].toUpperCase();
      if (pf) (paint.fuzzy ||= [])[k] = pf[1].toUpperCase();
      const pc = /\b(?:paint_color|mmu_segmentation)="([0-9A-Fa-f]+)"/.exec(s);
      if (pc) (paint.color ||= [])[k] = pc[1].toUpperCase();
    }
    k++;
  }
  const pos = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    const v = tris[i] * 3;
    pos[i * 3] = vx[v] * scale; pos[i * 3 + 1] = vx[v + 1] * scale; pos[i * 3 + 2] = vx[v + 2] * scale;
  }
  return { pos, count: k, paint };
}

function parseModelFile(src, path) {
  const unit = /<model\b[^>]*\bunit="([^"]+)"/.exec(src)?.[1] || "millimeter";
  const scale = UNITS[unit] ?? 1;
  const objects = new Map();
  for (const m of src.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const a = attrs(m[1]), body = m[2];
    const o = { id: a.id, path, name: a.name || "", type: a.type || "model" };
    const meshAt = body.indexOf("<mesh");
    if (meshAt >= 0) o.mesh = parseMesh(body.slice(meshAt), scale);
    else o.components = [...body.matchAll(/<component\b([^>]*?)\/?>/g)].map((c) => {
      const ca = attrs(c[1]);
      const t = parseTransform(ca.transform);
      if (scale !== 1) { t[9] *= scale; t[10] *= scale; t[11] *= scale; }
      return { objectid: ca.objectid, path: (ca["p:path"] || "").replace(/^\//, "") || path, transform: t };
    });
    objects.set(String(a.id), o);
  }
  const items = [...src.matchAll(/<item\b([^>]*?)\/?>/g)].map((it) => {
    const a = attrs(it[1]);
    const t = parseTransform(a.transform);
    if (scale !== 1) { t[9] *= scale; t[10] *= scale; t[11] *= scale; }
    return { objectid: a.objectid, path: (a["p:path"] || "").replace(/^\//, "") || path, transform: t, printable: a.printable !== "0" };
  });
  return { objects, items };
}

function parseModelSettings(src) {
  // per object: settings, parts (by id), and plates
  const objects = new Map();
  for (const m of src.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const a = attrs(m[1]);
    const parts = new Map();
    const own = m[2].replace(/<part\b([^>]*)>([\s\S]*?)<\/part>/g, (_, pa, pb) => {
      const p = attrs(pa);
      parts.set(String(p.id), { id: String(p.id), subtype: p.subtype || "normal_part", meta: metadata(pb.replace(/<text_info\b[\s\S]*?(\/>|<\/text_info>)/g, "")) });
      return "";
    });
    objects.set(String(a.id), { meta: metadata(own), parts });
  }
  const plates = [];
  for (const m of src.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const inst = [];
    const own = m[1].replace(/<model_instance>([\s\S]*?)<\/model_instance>/g, (_, b) => { const md = metadata(b); inst.push([String(md.object_id), Number(md.instance_id) || 0]); return ""; });
    const md = metadata(own);
    plates.push({ id: Number(md.plater_id) || plates.length + 1, name: md.plater_name || "", bedType: md.bed_type || "", seq: md.print_sequence || "",
      spiral: md.spiral_mode === "true" || md.spiral_mode === "1" ? "1" : md.spiral_mode === "false" || md.spiral_mode === "0" ? "0" : "", instances: inst });
  }
  plates.sort((x, y) => x.id - y.id);
  return { objects, plates };
}

/** Area share of each paint state in one painted triangle's tree (equal shares per split, close enough to decide). */
export function paintShares(hex) {
  const nib = [];
  for (let i = hex.length - 1; i >= 0; i--) nib.push(parseInt(hex[i], 16));
  let p = 0;
  const acc = {};
  const node = (w, depth) => {
    if (p >= nib.length || depth > 30) throw new Error("bad paint data");
    const code = nib[p++];
    const sides = code & 3;
    if (sides) { for (let k = 0; k <= sides; k++) node(w / (sides + 1), depth + 1); return; }
    let st = code >> 2;
    if (st === 3) { const x = nib[p++]; st = x === 15 ? nib[p++] + 18 : x + 3; }
    acc[st] = (acc[st] || 0) + w;
  };
  node(1, 0);
  return acc;
}

/** One state for a painted triangle (what BicuSlicer can show and edit): the painted state covering most of it, if it covers a third. */
export function paintState(hex) {
  try {
    const sh = paintShares(hex);
    let best = 0, area = 0;
    for (const [st, a] of Object.entries(sh)) if (+st && a > area) { best = +st; area = a; }
    return area >= 1 / 3 ? best : 0;
  } catch { return 0; }
}

const NOT_SETTINGS = new Set(["name", "matrix", "source_file", "source_object_id", "source_volume_id", "source_offset_x", "source_offset_y",
  "source_offset_z", "source_in_inches", "source_in_meters", "volume_type", "modifier_type", "mesh_stat"]);   // "extruder" is kept: the part's filament

/**
 * Read a 3MF. Returns { isProject, app, title, objects, plates, bed, settings, extra, notes }.
 * objects: [{ id, name, settings, parts: [{ subtype, name, settings, pos (Float32Array, object coordinates), paint }], items: [{ transform, printable }] }]
 */
export function readProject3mf(files) {
  const notes = new Set();
  const modelPath = Object.keys(files).find((n) => n.toLowerCase() === "3d/3dmodel.model")
    || Object.keys(files).find((n) => /^3d\/[^/]+\.model$/i.test(n));
  if (!modelPath) throw new Error("this 3MF has no 3D model in it");
  const cache = new Map();
  const fileOf = (path) => {
    const key = Object.keys(files).find((n) => n.toLowerCase() === path.toLowerCase());
    if (!key) throw new Error(`the 3MF is missing ${path}`);
    if (!cache.has(key)) cache.set(key, parseModelFile(text(files[key]), key));
    return cache.get(key);
  };
  const main = fileOf(modelPath);
  const mainSrc = text(files[modelPath]);
  const app = unxml(/<metadata\s+name="Application"\s*>([^<]*)</.exec(mainSrc)?.[1] || "");
  const title = unxml(/<metadata\s+name="Title"\s*>([^<]*)</.exec(mainSrc)?.[1] || "");

  const msName = Object.keys(files).find((n) => n.toLowerCase() === "metadata/model_settings.config");
  const ms = msName ? parseModelSettings(text(files[msName])) : { objects: new Map(), plates: [] };
  let settings = null;
  const psName = Object.keys(files).find((n) => n.toLowerCase() === "metadata/project_settings.config");
  if (psName) { try { settings = JSON.parse(text(files[psName])); } catch { notes.add("The project's settings couldn't be read."); } }

  // leaf meshes of an object, with the transforms down to them; the first level of components are the "parts"
  const leaves = (file, id, t, depth = 0) => {
    const o = file.objects.get(String(id));
    if (!o || depth > 8) return [];
    if (o.mesh) return [{ mesh: o.mesh, t }];
    return o.components.flatMap((c) => leaves(fileOf(c.path), c.objectid, mulTransform(c.transform, t), depth + 1));
  };

  const objects = [];
  const byId = new Map();
  for (const it of main.items) {
    let ob = byId.get(`${it.path}#${it.objectid}`);
    if (!ob) {
      const file = fileOf(it.path);
      const o = file.objects.get(String(it.objectid));
      if (!o) continue;
      const cfg = ms.objects.get(String(it.objectid));
      const settingsOf = (meta) => Object.fromEntries(Object.entries(meta || {}).filter(([k]) => !NOT_SETTINGS.has(k)));
      ob = { id: String(it.objectid), name: cfg?.meta?.name || o.name || "Part", settings: settingsOf(cfg?.meta), parts: [], items: [] };
      const comps = o.mesh ? [{ objectid: o.id, path: it.path, transform: IDENT, self: true }] : o.components;
      for (const c of comps) {
        const pc = cfg?.parts.get(String(c.objectid));
        const ls = c.self ? [{ mesh: o.mesh, t: IDENT }] : leaves(fileOf(c.path), c.objectid, c.transform);
        if (!ls.length) continue;
        const total = ls.reduce((n, l) => n + l.mesh.pos.length, 0);
        const pos = new Float32Array(total);
        const paint = { supports: null, seam: null, fuzzy: null, color: null };
        let off = 0, tri = 0;
        for (const l of ls) {
          pos.set(transformPositions(l.mesh.pos, l.t), off);
          for (const k of ["supports", "seam", "fuzzy", "color"]) {
            const src = l.mesh.paint[k];
            if (src) { paint[k] ||= []; src.forEach((v, i) => { if (v) paint[k][tri + i] = v; }); }
          }
          off += l.mesh.pos.length; tri += l.mesh.count;
        }
        const subtype = pc?.subtype || "normal_part";
        ob.parts.push({ subtype, name: pc?.meta?.name || o.name || "", settings: settingsOf(pc?.meta), pos, paint });
      }
      byId.set(`${it.path}#${it.objectid}`, ob);
      objects.push(ob);
    }
    ob.items.push({ transform: it.transform, printable: it.printable });
  }

  // the project's bed (to read plate positions) from its printer settings
  let bed = null;
  const area = settings?.printable_area;
  if (Array.isArray(area) && area.length >= 3) {
    const pts = area.map((p) => String(p).split("x").map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
    if (pts.length >= 3) {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      bed = { x0: Math.min(...xs), y0: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), d: Math.max(...ys) - Math.min(...ys) };
    }
  }

  const extra = {};
  for (const n of ["Metadata/layer_heights_profile.txt", "Metadata/layer_config_ranges.xml"]) {
    const key = Object.keys(files).find((f) => f.toLowerCase() === n.toLowerCase());
    if (key) extra[n.split("/")[1]] = text(files[key]);
  }
  const isProject = !!(msName || psName);
  return { isProject, app, title, objects, plates: ms.plates, bed, settings, extra, notes: [...notes] };
}

/** Where plate i (0-based) of a project with n plates starts, as OrcaSlicer lays plates out (a grid, gaps of a fifth of the bed). */
export function projectPlateOrigin(i, n, bed) {
  const v = Math.sqrt(n), r = Math.round(v);
  const cols = v > r ? r + 1 : r;
  const row = Math.floor(i / cols), col = i % cols;
  return { x: col * bed.w * 1.2 + bed.x0, y: -row * bed.d * 1.2 + bed.y0 };
}
