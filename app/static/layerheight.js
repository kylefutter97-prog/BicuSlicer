// Variable layer height, as OrcaSlicer computes it (ported from src/libslic3r/SlicingAdaptive.cpp and Slicing.cpp,
// OrcaSlicer 2.5.1): an adaptive profile from the slope of the part's faces, OrcaSlicer's smoothing, and the layers a
// profile gives. A profile is OrcaSlicer's layer_height_profile: [z0, h0, z1, h1, ...], heights in mm from the bed,
// read as a piecewise-linear layer height. Pure functions (no three.js), so they run under Node for tests.

const EPSILON = 1e-4;
const LAYER_HEIGHT_CHANGE_STEP = 0.04;      // OrcaSlicer keeps neighbouring layers within 0.04 mm of each other
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Slicing limits from the printer and print settings, the way OrcaSlicer derives them:
 * min / max layer height from the printer (0 = 0.07 mm / ¾ of the nozzle), widened to include the layer height.
 */
export function slicingParams({ layerHeight, firstLayerHeight, minLayerHeight, maxLayerHeight, nozzle }) {
  const lh = layerHeight > 0 ? layerHeight : 0.2;
  let min = minLayerHeight > 0 ? Math.max(0.01, minLayerHeight) : 0.07;
  let max = maxLayerHeight > 0 ? maxLayerHeight : 0.75 * (nozzle > 0 ? nozzle : 0.4);
  max = Math.max(min, max);
  min = Math.min(min, lh);
  max = Math.max(max, lh);
  return { layer: lh, first: firstLayerHeight > 0 ? firstLayerHeight : lh, min, max };
}

/** Faces of a triangle soup (9 floats per triangle, z up, sitting on z = 0): z span and slope, sorted by z span. */
function faces(pos) {
  const n = pos.length / 9;
  const out = new Array(n);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2];
    const bx = pos[o + 6] - pos[o], by = pos[o + 7] - pos[o + 1], bz = pos[o + 8] - pos[o + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const z0 = Math.min(pos[o + 2], pos[o + 5], pos[o + 8]), z1 = Math.max(pos[o + 2], pos[o + 5], pos[o + 8]);
    out[t] = { lo: z0, hi: z1, cos: Math.abs(nz), sin: Math.sqrt(nx * nx + ny * ny) };
  }
  out.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  return out;
}

const heightFromSlope = (f, dev) => Math.min(dev / 0.184, f.cos > 1e-5 ? 1.44 * dev * Math.sqrt(f.sin / f.cos) : Infinity);

/**
 * OrcaSlicer's adaptive profile. quality 0 = finest (most layers), 0.5 = OrcaSlicer's default, 1 = fastest.
 * ranges: [{ from, to, layerHeight }] (height-range modifiers) force their layer height, as OrcaSlicer does.
 */
export function adaptiveProfile(pos, params, quality = 0.5, ranges = []) {
  const F = faces(pos);
  let height = 0;
  for (const f of F) if (f.hi > height) height = f.hi;
  const P = params;
  const dev = quality < 0.5 ? lerp(P.min, P.layer, 2 * quality) : lerp(P.max, P.layer, 2 * (1 - quality));
  const prof = [0, P.first, P.first, P.first];         // the first layer is fixed (no raft)
  let printZ = P.first, cur = 0;
  while (printZ + EPSILON < height) {
    // next layer height from the faces around this height (SlicingAdaptive::next_layer_height)
    let h = P.max;
    let id = cur, firstHit = false;
    for (; id < F.length; id++) {
      const f = F[id];
      if (f.lo >= printZ) break;
      if (f.hi > printZ) {
        if (!firstHit) { firstHit = true; cur = id; }
        if (f.hi < printZ + EPSILON) continue;
        h = Math.min(h, heightFromSlope(f, dev));
      }
    }
    h = Math.max(h, P.min);
    if (h > P.min) {
      for (; id < F.length; id++) {
        const f = F[id];
        if (f.lo >= printZ + h) break;
        if (f.hi < printZ + EPSILON) continue;
        const red = heightFromSlope(f, dev), dz = f.lo - printZ;
        if (red < dz) h = dz; else if (red < h) h = red;
      }
      h = Math.max(h, P.min);
    }
    h = Math.min(h, P.max);
    const last = prof[prof.length - 1];
    if (h > last && h - last > LAYER_HEIGHT_CHANGE_STEP) h = last + LAYER_HEIGHT_CHANGE_STEP;
    else if (h < last && last - h > LAYER_HEIGHT_CHANGE_STEP) h = last - LAYER_HEIGHT_CHANGE_STEP;
    for (const r of ranges) if (printZ >= r.from && printZ <= r.to && r.layerHeight > 0) { h = r.layerHeight; break; }
    prof.push(printZ, h);
    printZ += h;
  }
  const gap = height - prof[prof.length - 2];
  if (gap > 0) prof.push(height, Math.min(P.max, Math.max(P.min, gap)));
  return prof;
}

/** OrcaSlicer's "Smooth" (gaussian blur biased towards thin layers, six passes); radius in layers, OrcaSlicer's default 5. */
export function smoothProfile(profile, params, radius = 5, keepMin = false) {
  const P = params;
  const blur = (pr) => {
    const skip = 4;                 // the fixed first layer
    if (pr.length - skip < 6) return pr;
    const r = Math.max(radius, 1);
    const sigma = 0.3 * (r - 1) + 0.8, two = 2 * sigma * sigma, norm = 1 / Math.sqrt(Math.PI * two);
    const kernel = Array.from({ length: 2 * r + 1 }, (_, i) => norm * Math.exp(-((i - r) ** 2) / two));
    const out = pr.slice(0, skip);
    const dh = P.max - P.min, inv = dh !== 0 ? 1 / dh : 1;
    const band = r * P.layer;
    for (let i = skip; i < pr.length; i += 2) {
      const zi = pr[i], hi = pr[i + 1];
      let sum = 0, wt = 0;
      const b = Math.max(i - 2 * r, skip), e = Math.min(i + 2 * r, pr.length - 2);
      for (let j = b; j <= e; j += 2) {
        const k = r + (j - i) / 2;
        if (Math.abs(zi - pr[j]) * P.layer <= band) {
          const w = kernel[k] * Math.sqrt(Math.abs(P.max - pr[j + 1]) * inv);
          sum += w * pr[j + 1]; wt += w;
        }
      }
      let h = Math.min(P.max, Math.max(P.min, wt === 0 ? hi : sum / wt));
      if (keepMin) h = Math.min(h, hi);
      out.push(zi, h);
    }
    return out;
  };
  let p = profile;
  for (let n = 0; n < 6; n++) p = blur(p);
  return p;
}

/** Layer height at z from a profile (piecewise linear between its points). */
export function heightAt(profile, z) {
  if (profile.length < 2) return 0;
  if (z <= profile[0]) return profile[1];
  for (let i = 2; i < profile.length; i += 2) {
    if (z <= profile[i]) {
      const z0 = profile[i - 2], z1 = profile[i], t = z1 > z0 ? (z - z0) / (z1 - z0) : 1;
      return lerp(profile[i - 1], profile[i + 1], t);
    }
  }
  return profile[profile.length - 1];
}

/** The layer tops a profile gives for a part this high: OrcaSlicer's generate_object_layers (first layer fixed). */
export function layersOf(profile, height, params) {
  const tops = [params.first];
  let printZ = params.first, idx = 0;
  let sliceZ = printZ + 0.5 * params.min;
  while (sliceZ < height && tops.length < 100000) {
    let h = params.min;
    if (idx < profile.length) {
      let next = idx + 2;
      while (next < profile.length && sliceZ >= profile[next]) { idx = next; next += 2; }
      const z1 = profile[idx], h1 = profile[idx + 1];
      h = h1;
      if (next < profile.length) h = lerp(h1, profile[next + 1], (sliceZ - z1) / (profile[next] - z1));
    }
    sliceZ = printZ + 0.5 * h;
    if (sliceZ >= height) break;
    printZ += h;
    tops.push(printZ);
    sliceZ = printZ + 0.5 * params.min;
  }
  return tops;
}

/** A profile with uniform layers (what slicing without one gives), for comparison. */
export function uniformCount(height, params) {
  return height <= params.first ? 1 : 1 + Math.ceil((height - params.first) / params.layer - 1e-6);
}

/** Profile from height ranges alone (when there's no adaptive profile), for showing. */
export function rangesProfile(height, params, ranges) {
  const prof = [0, params.first, params.first, params.first];
  let z = params.first;
  while (z + EPSILON < height) {
    let h = params.layer;
    for (const r of ranges) if (z >= r.from && z < r.to && r.layerHeight > 0) { h = r.layerHeight; break; }
    prof.push(z, h);
    z += h;
  }
  return prof;
}

/**
 * OrcaSlicer's layer height brush (Slicing.cpp adjust_layer_height_profile): change the profile around z within a band
 * (cosine falloff), by `delta` mm per call. action: "increase" | "decrease" | "reduce" (back towards the normal layer
 * height) | "smooth". The first layer stays fixed; the profile is made to end at the part's height. Returns a new profile.
 */
export function adjustProfile(profile, params, height, z, delta, band, action, ranges = []) {
  const P = params;
  let prof = profile.slice();
  if (prof[prof.length - 2] < height - EPSILON) prof.push(height, prof[prof.length - 1]);
  else prof[prof.length - 2] = height;
  const span0 = P.first, span1 = height;
  if (z < span0 || z > span1) return prof;
  const cur = heightAt(prof, z);
  for (const r of ranges) if (z >= r.from - cur && z <= r.to + cur) return prof;     // height ranges win, as in OrcaSlicer
  let d = delta;
  if (action === "decrease" || action === "increase") {
    if (action === "decrease") d = -d;
    if (d > 0) { if (cur >= P.max - EPSILON) return prof; d = Math.min(d, P.max - cur); }
    else { if (cur <= P.min + EPSILON) return prof; d = Math.max(d, P.min - cur); }
  } else {
    d = Math.min(Math.abs(d), Math.abs(P.layer - cur));
    if (d < EPSILON && action === "reduce") return prof;
  }
  // densify the band at 0.1 mm and change it there
  const lo = Math.max(span0, z - band / 2), hi = z + band / 2, step = 0.1;
  let idx = 0;
  while (idx < prof.length && prof[idx] < lo) idx += 2;
  idx = Math.max(0, idx - 2);
  const out = prof.slice(0, idx + 2);
  const iStart = out.length;
  let zz = lo;
  while (zz < hi) {
    const next = idx + 2;
    let h = prof[idx + 1];
    if (next < prof.length) h = lerp(prof[idx + 1], prof[next + 1], (zz - prof[idx]) / Math.max(1e-9, prof[next] - prof[idx]));
    const w = Math.abs(zz - z) < band / 2 ? 0.5 + 0.5 * Math.cos((2 * Math.PI * (zz - z)) / band) : 0;
    if (action === "increase" || action === "decrease") h += w * d;
    else if (action === "reduce") { const dd = h - P.layer, st = w * d; h += Math.abs(dd) > st ? (dd > 0 ? -st : st) : -dd; }
    h = Math.min(P.max, Math.max(P.min, h));
    if (zz >= span1 - 1e-9) {
      if (out[out.length - 2] + EPSILON > zz) out.length -= 2;
      out.push(span1, h);
      idx = prof.length;
      break;
    }
    if (out[out.length - 2] + EPSILON < zz) out.push(zz, h);
    zz = Math.min(zz + step, span1);
    idx = next;
    while (idx < prof.length && prof[idx] < zz) idx += 2;
    idx -= 2;
  }
  idx += 2;
  const iEnd = out.length;
  if (idx < prof.length) out.push(...prof.slice(idx));
  else if (out[out.length - 2] + EPSILON / 2 < span1) out.push(...prof.slice(-2));
  if (action === "smooth") {
    const a = Math.max(iStart, 4), b = Math.min(iEnd, out.length - 2);     // the first layer stays
    for (let round = 0; round < 6; round++) {
      const pn = out.slice();
      for (let i = a; i < b; i += 2) {
        const t = Math.abs(pn[i] - z) < band / 2 ? 0.25 + 0.25 * Math.cos((2 * Math.PI * (pn[i] - z)) / band) : 0;
        out[i + 1] = (1 - t) * pn[i + 1] + 0.5 * t * (pn[i - 1] + pn[i + 3]);
      }
    }
  }
  return out;
}

/** layer_heights_profile.txt line for 3MF object number n (1-based, the build item order). */
export const profileLine = (n, profile) => `object_id=${n}|${profile.map((v) => v.toFixed(6)).join(";")}`;

/** Parse layer_heights_profile.txt: { objectNumber: profile }. */
export function parseProfiles(text) {
  const out = {};
  for (const line of (text || "").split(/\r?\n/)) {
    const m = /^object_id=(\d+)\|(.*)$/.exec(line.trim());
    if (!m) continue;
    const v = m[2].split(";").map(Number);
    if (v.length >= 4 && v.length % 2 === 0 && v.every(Number.isFinite)) out[+m[1]] = v;
  }
  return out;
}

/** Parse layer_config_ranges.xml: { objectNumber: [{ from, to, settings }] }. */
export function parseRanges(xml) {
  const out = {};
  const un = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  for (const o of (xml || "").matchAll(/<object\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    const ranges = [];
    for (const r of o[2].matchAll(/<range\b([^>]*)>([\s\S]*?)<\/range>/g)) {
      const from = +(/min_z="([^"]+)"/.exec(r[1])?.[1]), to = +(/max_z="([^"]+)"/.exec(r[1])?.[1]);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const settings = {};
      for (const op of r[2].matchAll(/<option\b[^>]*\bopt_key="([^"]+)"[^>]*>([\s\S]*?)<\/option>/g)) settings[op[1]] = un(op[2].trim());
      ranges.push({ from, to, settings });
    }
    if (ranges.length) out[+o[1]] = ranges;
  }
  return out;
}

/** layer_config_ranges.xml for { objectNumber: [{ from, to, settings }] }. */
export function rangesXml(byObject) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const objs = Object.entries(byObject).filter(([, r]) => r.length);
  if (!objs.length) return "";
  return `<?xml version="1.0" encoding="utf-8"?>\n<objects>\n${objs.map(([n, rs]) => ` <object id="${n}">\n${rs.map((r) =>
    `  <range min_z="${r.from}" max_z="${r.to}">\n${Object.entries(r.settings).map(([k, v]) =>
      `   <option opt_key="${esc(k)}">${esc(Array.isArray(v) ? v.join(",") : v)}</option>\n`).join("")}  </range>\n`).join("")} </object>\n`).join("")}</objects>\n`;
}
