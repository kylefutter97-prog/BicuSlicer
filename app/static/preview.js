// Layer preview: draws the sliced toolpaths (from the server's compact preview file) in the plate's 3D scene.
import * as THREE from "three";

const RES = 0.05;
const COLORS = {
  "Outer wall": "#ff8c1a", "Inner wall": "#ffd54a", "Overhang wall": "#3d7dff",
  "Sparse infill": "#c0392b", "Internal solid infill": "#9b59d0", "Solid infill": "#9b59d0",
  "Top surface": "#ff4d6a", "Bottom surface": "#5c9dff", "Bridge": "#4db8e6", "Internal Bridge": "#7fb3d5",
  "Gap infill": "#e6e6e6", "Skirt": "#00a884", "Brim": "#00a884", "Skirt/Brim": "#00a884",
  "Support": "#2ecc71", "Support interface": "#1e8449", "Support transition": "#58d68d",
  "Prime tower": "#b0b0b0", "Ironing": "#ffafc8", "Custom": "#8a8a8a",
};
// OrcaSlicer's G-code viewer range colours (low → high)
const RANGE = ["#0b2c7a", "#135985", "#1c8891", "#04d60f", "#aaf200", "#fcf903", "#f5ce0a", "#d16830", "#c2523c", "#942616"]
  .map((c) => new THREE.Color(c));
export const RANGE_CSS = ["#0b2c7a", "#135985", "#1c8891", "#04d60f", "#aaf200", "#fcf903", "#f5ce0a", "#d16830", "#c2523c", "#942616"];

const fmtTime = (s) => { s = Math.round(s); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };

/** The colour modes (like OrcaSlicer's "Line type", "Speed", ...): attribute, scale and how values read. */
export const MODES = [
  { id: "feature", label: "Line type" },
  { id: "height", label: "Layer height", attr: "height", k: 0.001, fmt: (v) => `${v.toFixed(2)} mm` },
  { id: "width", label: "Line width", attr: "width", k: 0.001, fmt: (v) => `${v.toFixed(2)} mm` },
  { id: "speed", label: "Speed", attr: "speed", k: 0.1, fmt: (v) => `${Math.round(v)} mm/s` },
  { id: "fan", label: "Fan speed", attr: "fan", k: 1, fmt: (v) => `${Math.round(v)} %` },
  { id: "temp", label: "Temperature", attr: "temp", k: 0.1, fmt: (v) => `${Math.round(v)} °C` },
  { id: "flow", label: "Volumetric flow", attr: "flow", k: 0.01, fmt: (v) => `${v.toFixed(1)} mm³/s` },
  { id: "layertime", label: "Layer time", layerTime: true, fmt: fmtTime },
  { id: "layertimelog", label: "Layer time (log)", layerTime: true, log: true, fmt: fmtTime },
  { id: "filament", label: "Filament" },
];
export { fmtTime };

function colorFor(name) {
  if (COLORS[name]) return COLORS[name];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 65% 60%)`;
}

export class Preview {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.data = null;
    this.hidden = new Set();
    this.showTravel = false;
    this.layer = 0;
    this.mode = this.wanted = "feature";      // wanted: the mode picked, kept for previews that can show it
  }

  /** Colour modes this preview has data for (older previews only have line types). */
  modes() { return this.data?.attrs ? MODES.filter((m) => !m.layerTime || this.data.times.some((t) => t > 0)) : MODES.slice(0, 1); }

  get loaded() { return !!this.data; }
  get layers() { return this.data ? this.data.z.length : 0; }

  clear() {
    for (const o of [...this.group.children]) { o.geometry?.dispose(); this.group.remove(o); }
    this.data = null;
    this.group.visible = false;
  }

  async load(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Preview failed (${r.status})`);
    this.parse(await r.arrayBuffer());
    this.build();
  }

  parse(buf) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
    if (magic !== "BSGP") throw new Error("Not a preview file");
    const [ver, L, nE, nT, nJ] = [4, 8, 12, 16, 20].map((o) => dv.getUint32(o, true));
    if (ver < 1 || ver > 3) throw new Error("Unknown preview version");
    let o = 24;
    const z = new Float32Array(buf.slice(o, o + 4 * L)); o += 4 * L;
    const eEnd = new Uint32Array(buf.slice(o, o + 4 * L)); o += 4 * L;
    const tEnd = new Uint32Array(buf.slice(o, o + 4 * L)); o += 4 * L;
    let times = new Float32Array(L);
    if (ver >= 2) { times = new Float32Array(buf.slice(o, o + 4 * L)); o += 4 * L; }
    const ext = new Uint16Array(buf.slice(o, o + 8 * nE)); o += 8 * nE;
    const feat = new Uint8Array(buf.slice(o, o + nE)); o += nE + (nE % 2);
    const trv = new Uint16Array(buf.slice(o, o + 8 * nT)); o += 8 * nT;
    let attrs = null;
    if (ver >= 2) {
      attrs = {};
      for (const k of ["speed", "width", "height", "flow", "temp"]) { attrs[k] = new Uint16Array(buf.slice(o, o + 2 * nE)); o += 2 * nE; }
      for (const k of ["fan", "tool"]) { attrs[k] = new Uint8Array(buf.slice(o, o + nE)); o += nE; }
      o += (2 * nE) % 4;
    }
    let eOff = null, tOff = null;
    if (ver >= 3) {
      eOff = new Uint32Array(buf.slice(o, o + 4 * nE)); o += 4 * nE;
      tOff = new Uint32Array(buf.slice(o, o + 4 * nT)); o += 4 * nT;
    }
    let meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, o, nJ)));
    if (Array.isArray(meta)) meta = { features: meta };
    const features = meta.features;
    const counts = new Array(features.length).fill(0);
    for (let i = 0; i < nE; i++) counts[feat[i]]++;
    // the layer of each line (for layer time)
    const segLayer = new Uint32Array(nE);
    for (let i = 0, l = 0; i < nE; i++) { while (l < L - 1 && i >= eEnd[l]) l++; segLayer[i] = l; }
    this.data = { z, eEnd, tEnd, times, ext, feat, trv, features, counts, attrs, segLayer,
      colours: meta.colours || [], totalTime: meta.time || null, eOff, tOff, featureStats: meta.feature_stats || {} };
    this.move = null;
    this.mode = this.modes().some((m) => m.id === this.wanted) ? this.wanted : "feature";
    this.layer = L - 1;
  }

  positions(arr, ends) {
    // u16 x1,y1,x2,y2 per segment -> xyz pairs, z from the layer table
    const n = arr.length / 4;
    const pos = new Float32Array(n * 6);
    let layer = 0;
    for (let i = 0; i < n; i++) {
      while (layer < ends.length - 1 && i >= ends[layer]) layer++;
      const zz = this.data.z[layer];
      const a = i * 4, p = i * 6;
      pos[p] = arr[a] * RES; pos[p + 1] = arr[a + 1] * RES; pos[p + 2] = zz;
      pos[p + 3] = arr[a + 2] * RES; pos[p + 4] = arr[a + 3] * RES; pos[p + 5] = zz;
    }
    return pos;
  }

  build() {
    for (const o of [...this.group.children]) { if (o !== this.nozzle) o.geometry?.dispose(); this.group.remove(o); }
    const d = this.data;
    const pos = this.positions(d.ext, d.eEnd);
    const col = new Float32Array(pos.length);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.geo = geo;
    this.below = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 }));
    // the current layer gets its own geometry object (same buffers) so its draw range is independent
    this.curGeo = new THREE.BufferGeometry();
    this.curGeo.setAttribute("position", geo.getAttribute("position"));
    this.curGeo.setAttribute("color", geo.getAttribute("color"));
    this.current = new THREE.LineSegments(this.curGeo, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.current.renderOrder = 1;
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute("position", new THREE.BufferAttribute(this.positions(d.trv, d.tEnd), 3));
    this.travel = new THREE.LineSegments(tgeo, new THREE.LineBasicMaterial({ color: 0x5aa0ff, transparent: true, opacity: 0.35 }));
    // the nozzle, shown while stepping through a layer's moves
    if (!this.nozzle) {
      const cone = new THREE.ConeGeometry(0.9, 3, 16);
      cone.rotateX(-Math.PI / 2);         // point down (-z)
      cone.translate(0, 0, 1.5);
      this.nozzle = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }));
      this.nozzle.renderOrder = 3;
    }
    this.nozzle.visible = false;
    for (const o of [this.below, this.current, this.travel]) { o.frustumCulled = false; this.group.add(o); }
    this.group.add(this.nozzle);
    this.reindex();
  }

  /** The value of line i in a range mode. */
  value(m, i) {
    const d = this.data;
    return m.layerTime ? d.times[d.segLayer[i]] : d.attrs[m.attr][i] * m.k;
  }

  /** Lowest and highest value over the lines shown (hidden line types don't stretch the scale). */
  range(m) {
    const d = this.data;
    let lo = Infinity, hi = -Infinity;
    if (m.layerTime) {
      // only layers that have something visible
      const seen = new Uint8Array(d.z.length);
      for (let i = 0; i < d.feat.length; i++) if (!this.hidden.has(d.feat[i])) seen[d.segLayer[i]] = 1;
      for (let l = 0; l < d.z.length; l++) if (seen[l] && d.times[l] > 0) { lo = Math.min(lo, d.times[l]); hi = Math.max(hi, d.times[l]); }
    } else {
      const a = d.attrs[m.attr];
      for (let i = 0; i < d.feat.length; i++) {
        if (this.hidden.has(d.feat[i])) continue;
        const v = a[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      lo *= m.k; hi *= m.k;
    }
    return lo <= hi ? [lo, hi] : [0, 0];
  }

  /** Where v sits between lo and hi (0..1), on a log scale for the log modes. */
  static pos(v, lo, hi, log) {
    if (hi - lo < 1e-9) return 0.5;
    if (log) { const l0 = Math.log(Math.max(lo, 1e-3)), l1 = Math.log(Math.max(hi, 1e-3)); return l1 - l0 < 1e-9 ? 0.5 : (Math.log(Math.max(v, 1e-3)) - l0) / (l1 - l0); }
    return (v - lo) / (hi - lo);
  }

  /** Recolour every line for the current mode. */
  recolour() {
    const d = this.data;
    if (!d || !this.geo) return;
    const col = this.geo.getAttribute("color");
    const arr = col.array;
    const put = (i, c) => { const p = i * 6; arr[p] = arr[p + 3] = c.r; arr[p + 1] = arr[p + 4] = c.g; arr[p + 2] = arr[p + 5] = c.b; };
    const m = MODES.find((x) => x.id === this.mode) || MODES[0];
    if (m.id === "feature") {
      const palette = d.features.map((f) => new THREE.Color(colorFor(f)));
      for (let i = 0; i < d.feat.length; i++) put(i, palette[d.feat[i]]);
    } else if (m.id === "filament") {
      const pal = d.colours.map((c) => new THREE.Color(/^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7) : "#cccccc"));
      const fallback = new THREE.Color("#cccccc");
      for (let i = 0; i < d.feat.length; i++) put(i, pal[d.attrs.tool[i]] || fallback);
    } else {
      const [lo, hi] = this.range(m);
      this.lastRange = [lo, hi];
      const c = new THREE.Color(), n = RANGE.length - 1;
      for (let i = 0; i < d.feat.length; i++) {
        const t = Math.max(0, Math.min(1, Preview.pos(this.value(m, i), lo, hi, m.log))) * n;
        const k = Math.min(n - 1, Math.floor(t));
        c.copy(RANGE[k]).lerp(RANGE[k + 1], t - k);
        put(i, c);
      }
    }
    col.needsUpdate = true;
  }

  setMode(id) {
    this.wanted = id;
    if (!this.modes().some((m) => m.id === id)) id = "feature";
    this.mode = id;
    this.recolour();
  }

  reindex() {
    // index buffer of visible features, in print order, with per-layer end offsets for the slider
    const d = this.data;
    const idx = new Uint32Array(d.feat.length * 2);
    const ends = new Uint32Array(d.z.length);
    let k = 0, layer = 0;
    for (let i = 0; i < d.feat.length; i++) {
      while (layer < d.eEnd.length - 1 && i >= d.eEnd[layer]) { ends[layer++] = k; }
      if (!this.hidden.has(d.feat[i])) { idx[k++] = 2 * i; idx[k++] = 2 * i + 1; }
    }
    this.movesCache = null;
    while (layer < ends.length) ends[layer++] = k;
    this.geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, k), 1));
    this.idxEnds = ends;
    this.recolour();           // ranges follow what's shown
    this.setLayer(this.layer);
  }

  setLayer(n) {
    if (!this.data) return;
    n = Math.max(0, Math.min(this.layers - 1, n));
    if (n !== this.layer) this.move = null;      // a new layer starts with all of it shown
    this.layer = n;
    const start = n > 0 ? this.idxEnds[n - 1] : 0, end = this.idxEnds[n];
    this.geo.setDrawRange(0, start);
    if (this.curGeo.getIndex() !== this.geo.getIndex()) this.curGeo.setIndex(this.geo.getIndex());
    this.curGeo.setDrawRange(start, end - start);
    const t = this.data.tEnd;
    this.travel.visible = this.showTravel;
    this.travel.geometry.setDrawRange(0, t[n] * 2);
    this.nozzle.visible = false;
    if (this.move !== null) this.applyMove();
  }

  /* ---- stepping through one layer's moves (OrcaSlicer's horizontal slider) */

  get hasMoves() { return !!this.data?.eOff; }

  /** The G-code offsets of the current layer's moves, in print order (visible line types, plus travel when shown). */
  moves() {
    const d = this.data, n = this.layer;
    const key = `${n}|${this.showTravel}`;
    if (this.movesCache?.key === key) return this.movesCache.list;
    const out = [];
    if (d.eOff) {
      const e0 = n > 0 ? d.eEnd[n - 1] : 0, e1 = d.eEnd[n];
      for (let i = e0; i < e1; i++) if (!this.hidden.has(d.feat[i])) out.push(d.eOff[i]);
      if (this.showTravel) { const t0 = n > 0 ? d.tEnd[n - 1] : 0; for (let i = t0; i < d.tEnd[n]; i++) out.push(d.tOff[i]); }
    }
    out.sort((a, b) => a - b);
    const list = [];
    for (const v of out) if (!list.length || list[list.length - 1] !== v) list.push(v);   // an arc is one move
    this.movesCache = { key, list: Uint32Array.from(list) };
    return this.movesCache.list;
  }

  /** Show the layer up to move i (0-based); null shows all of it. */
  setMove(i) {
    if (!this.data) return;
    const list = this.moves();
    this.move = i === null || i >= list.length - 1 ? null : Math.max(0, i);
    this.setLayer(this.layer);
  }

  /** The G-code offset of the current move (or the layer's last). */
  moveOffset() {
    const list = this.moves();
    return list.length ? list[this.move === null ? list.length - 1 : Math.min(this.move, list.length - 1)] : null;
  }

  applyMove() {
    const d = this.data, n = this.layer, list = this.moves();
    if (!list.length) return;
    const cur = list[Math.min(this.move, list.length - 1)];
    // extrusions: the visible ones of this layer up to the current move
    const start = n > 0 ? this.idxEnds[n - 1] : 0, end = this.idxEnds[n];
    const idx = this.geo.getIndex().array;
    let k = start, lastE = -1;
    while (k < end && d.eOff[idx[k] / 2] <= cur) { lastE = idx[k] / 2; k += 2; }
    this.curGeo.setDrawRange(start, k - start);
    // travel up to the current move
    const t0 = n > 0 ? d.tEnd[n - 1] : 0;
    let t = t0, lastT = -1;
    while (t < d.tEnd[n] && d.tOff[t] <= cur) { lastT = t; t++; }
    this.travel.geometry.setDrawRange(0, t * 2);
    // the nozzle at the end of the last move drawn
    let p = null;
    if (lastE >= 0 && (lastT < 0 || d.eOff[lastE] >= d.tOff[lastT])) p = this.geo.getAttribute("position").array.subarray(lastE * 6 + 3, lastE * 6 + 6);
    else if (lastT >= 0) p = this.travel.geometry.getAttribute("position").array.subarray(lastT * 6 + 3, lastT * 6 + 6);
    if (p) { this.nozzle.position.set(p[0], p[1], p[2]); this.nozzle.visible = true; }
  }

  setFeature(i, visible) {
    if (visible) this.hidden.delete(i); else this.hidden.add(i);
    this.move = null;
    this.reindex();
  }

  setVisible(v) { this.group.visible = v && !!this.data; }

  legend() {
    const d = this.data;
    return d.features.map((f, i) => ({ i, name: f, color: colorFor(f), count: d.counts[i], visible: !this.hidden.has(i), stats: d.featureStats[f] || null }))
      .filter((x) => x.count > 0);
  }

  /** What the current colour mode needs explaining: a scale, or the filaments used. */
  modeLegend() {
    const d = this.data, m = MODES.find((x) => x.id === this.mode) || MODES[0];
    if (!d || m.id === "feature") return null;
    if (m.id === "filament") {
      const used = new Map();
      for (let i = 0; i < d.feat.length; i++) if (!this.hidden.has(d.feat[i])) used.set(d.attrs.tool[i], (used.get(d.attrs.tool[i]) || 0) + 1);
      return { kind: "filament", items: [...used.keys()].sort((a, b) => a - b).map((t) => ({ n: t + 1, color: (d.colours[t] || "#cccccc").slice(0, 7) })) };
    }
    const [lo, hi] = this.range(m);
    if (hi - lo < 1e-6) return { kind: "range", single: m.fmt(lo), label: m.label };
    // tick values at even steps along the colour scale (log steps for the log mode)
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => m.fmt(m.log ? Math.exp(Math.log(Math.max(lo, 1e-3)) + t * (Math.log(Math.max(hi, 1e-3)) - Math.log(Math.max(lo, 1e-3)))) : lo + t * (hi - lo)));
    return { kind: "range", ticks, label: m.label };
  }

  /** The current layer's time, when OrcaSlicer's estimate is known. */
  layerTime(n = this.layer) { const t = this.data?.times?.[n]; return t > 0 ? fmtTime(t) : ""; }
}
