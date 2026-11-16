// meshops.js - pure mesh operations for BicuSlicer.
//
// Conventions (shared by every export):
//  * A "geometry" is a THREE.BufferGeometry, non-indexed, with only a
//    `position` attribute (Float32Array, 9 floats per triangle, millimetres,
//    Z up, counter-clockwise when seen from outside).
//  * Vertex identity = exact equality of the three float32 values (STL triangle
//    soup); -0 and +0 are treated as the same value.
//  * Every function is pure: inputs are never mutated, results are new
//    geometries (normals are left to the caller: computeVertexNormals()).
//  * Indexed or non-Float32 inputs are tolerated (converted on the fly).

import * as THREE from "three";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Non-indexed float32 positions of `geo`, whole triangles only (may share the input buffer: read only). */
function positionsOf(geo) {
  if (!geo || !geo.getAttribute) throw new TypeError("meshops: a THREE.BufferGeometry is required");
  const g = geo.index ? geo.toNonIndexed() : geo;
  const attr = g.getAttribute("position");
  if (!attr) return new Float32Array(0);
  const nTri = Math.floor(attr.count / 3);
  if (!attr.isInterleavedBufferAttribute && attr.itemSize === 3 && attr.array instanceof Float32Array) {
    return attr.array.length === nTri * 9 ? attr.array : attr.array.subarray(0, nTri * 9);
  }
  const out = new Float32Array(nTri * 9);
  for (let i = 0; i < nTri * 3; i++) {
    out[3 * i] = attr.getX(i);
    out[3 * i + 1] = attr.getY(i);
    out[3 * i + 2] = attr.getZ(i);
  }
  return out;
}

/** Wrap a Float32Array of positions into a new non-indexed BufferGeometry. */
function makeGeo(f32) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(f32, 3));
  return g;
}

/** Swap the 2nd and 3rd vertex of every triangle in place (flips winding). */
function flipWindingInPlace(p) {
  for (let i = 0; i < p.length; i += 9) {
    let t = p[i + 3]; p[i + 3] = p[i + 6]; p[i + 6] = t;
    t = p[i + 4]; p[i + 4] = p[i + 7]; p[i + 7] = t;
    t = p[i + 5]; p[i + 5] = p[i + 8]; p[i + 8] = t;
  }
}

function bboxOf(p, n = p.length) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return { min: [x0, y0, z0], max: [x1, y1, z1] };
}

function volumeOfArray(p) {
  let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    const x0 = p[i], y0 = p[i + 1], z0 = p[i + 2];
    const x1 = p[i + 3], y1 = p[i + 4], z1 = p[i + 5];
    const x2 = p[i + 6], y2 = p[i + 7], z2 = p[i + 8];
    v += x0 * (y1 * z2 - z1 * y2) - y0 * (x1 * z2 - z1 * x2) + z0 * (x1 * y2 - y1 * x2);
  }
  return v / 6;
}

function hash3(x, y, z) {
  let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return h;
}

function hash2(a, b) {
  let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x632be5ab, 0x85ebca77);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return h;
}

/**
 * Weld exact-duplicate corners.
 * @returns {{ids: Uint32Array, verts: Float32Array, count: number}} ids[corner] = unique vertex index,
 *   verts = unique positions (3 floats each).
 */
function weld(pos) {
  const n = (pos.length / 3) | 0;
  const bits = new Uint32Array(pos.buffer, pos.byteOffset, n * 3);
  let size = 64;
  while (size < n / 2) size *= 2;
  let mask = size - 1;
  let table = new Int32Array(size).fill(-1);
  let keys = new Uint32Array(Math.max(48, Math.ceil(n / 4) * 3));
  const ids = new Uint32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    let x = bits[3 * i], y = bits[3 * i + 1], z = bits[3 * i + 2];
    if (x === 0x80000000) x = 0;
    if (y === 0x80000000) y = 0;
    if (z === 0x80000000) z = 0;
    let h = hash3(x, y, z) & mask;
    for (;;) {
      const e = table[h];
      if (e < 0) {
        if (count * 3 + 3 > keys.length) { const k2 = new Uint32Array(keys.length * 2); k2.set(keys); keys = k2; }
        keys[3 * count] = x; keys[3 * count + 1] = y; keys[3 * count + 2] = z;
        table[h] = count; ids[i] = count; count++;
        if (count * 2 > size) {
          size *= 2; mask = size - 1;
          table = new Int32Array(size).fill(-1);
          for (let e2 = 0; e2 < count; e2++) {
            let h2 = hash3(keys[3 * e2], keys[3 * e2 + 1], keys[3 * e2 + 2]) & mask;
            while (table[h2] >= 0) h2 = (h2 + 1) & mask;
            table[h2] = e2;
          }
        }
        break;
      }
      if (keys[3 * e] === x && keys[3 * e + 1] === y && keys[3 * e + 2] === z) { ids[i] = e; break; }
      h = (h + 1) & mask;
    }
  }
  const verts = new Float32Array(keys.buffer.slice(0, count * 12));
  return { ids, verts, count };
}

/** Open-addressing hash map from an ordered uint32 pair to a dense entry index, with an int32 value per entry. */
class PairHash {
  constructor(expected = 64) {
    let size = 64;
    while (size < expected * 2) size *= 2;
    this.size = size; this.mask = size - 1;
    this.table = new Int32Array(size).fill(-1);
    const cap = Math.max(32, expected | 0);
    this.ka = new Uint32Array(cap); this.kb = new Uint32Array(cap); this.val = new Int32Array(cap);
    this.n = 0; this.isNew = false;
  }
  add(a, b) {
    const table = this.table, mask = this.mask, ka = this.ka, kb = this.kb;
    let i = hash2(a, b) & mask;
    for (;;) {
      const e = table[i];
      if (e < 0) break;
      if (ka[e] === a && kb[e] === b) { this.isNew = false; return e; }
      i = (i + 1) & mask;
    }
    const e = this.n++;
    if (e >= this.ka.length) this._grow();
    this.ka[e] = a; this.kb[e] = b; this.val[e] = 0;
    table[i] = e; this.isNew = true;
    if (this.n * 2 > this.size) this._rehash();
    return e;
  }
  _grow() {
    const c = this.ka.length * 2;
    const a = new Uint32Array(c); a.set(this.ka); this.ka = a;
    const b = new Uint32Array(c); b.set(this.kb); this.kb = b;
    const v = new Int32Array(c); v.set(this.val); this.val = v;
  }
  _rehash() {
    this.size *= 2; this.mask = this.size - 1;
    const table = new Int32Array(this.size).fill(-1), mask = this.mask;
    for (let e = 0; e < this.n; e++) {
      let i = hash2(this.ka[e], this.kb[e]) & mask;
      while (table[i] >= 0) i = (i + 1) & mask;
      table[i] = e;
    }
    this.table = table;
  }
}

class GrowU32 {
  constructor(cap = 1024) { this.a = new Uint32Array(Math.max(cap, 16)); this.n = 0; }
  push3(x, y, z) {
    if (this.n + 3 > this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    const a = this.a; a[this.n++] = x; a[this.n++] = y; a[this.n++] = z;
  }
  push(x) {
    if (this.n + 1 > this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = x;
  }
}

class GrowF64 {
  constructor(cap = 1024) { this.a = new Float64Array(Math.max(cap, 16)); this.n = 0; }
  /** Appends a point and returns its vertex index. */
  push3(x, y, z) {
    if (this.n + 3 > this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b; }
    const a = this.a; a[this.n++] = x; a[this.n++] = y; a[this.n++] = z;
    return this.n / 3 - 1;
  }
}

/** Indexed triangles (ids into P, a flat xyz array) -> non-indexed Float32Array. */
function expand(tri, nIdx, P) {
  const out = new Float32Array(nIdx * 3);
  for (let i = 0; i < nIdx; i++) {
    const v = tri[i] * 3;
    out[3 * i] = P[v]; out[3 * i + 1] = P[v + 1]; out[3 * i + 2] = P[v + 2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transform / combine
// ---------------------------------------------------------------------------

/**
 * Apply a matrix to every vertex position.
 * If the matrix mirrors (negative determinant), each triangle's 2nd and 3rd
 * vertices are swapped so faces keep pointing outwards.
 * @param {THREE.BufferGeometry} geo
 * @param {THREE.Matrix4} matrix4
 * @returns {THREE.BufferGeometry}
 */
export function bake(geo, matrix4) {
  const p = positionsOf(geo);
  const e = matrix4.elements;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const iw = w === 1 || w === 0 ? 1 : 1 / w;
    out[i] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * iw;
    out[i + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * iw;
    out[i + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * iw;
  }
  if (matrix4.determinant() < 0) flipWindingInPlace(out);
  return makeGeo(out);
}

/**
 * Mirror through the geometry's own bounding-box centre along one axis
 * (the bounding box is unchanged). Windings are flipped so faces stay outward.
 * @param {THREE.BufferGeometry} geo
 * @param {"x"|"y"|"z"} axis
 * @returns {THREE.BufferGeometry}
 */
export function mirror(geo, axis) {
  const k = { x: 0, y: 1, z: 2 }[String(axis).toLowerCase()];
  if (k === undefined) throw new RangeError(`meshops.mirror: axis must be "x", "y" or "z", got ${axis}`);
  const p = positionsOf(geo);
  const out = new Float32Array(p);
  if (!p.length) return makeGeo(out);
  const bb = bboxOf(p);
  const s = bb.min[k] + bb.max[k]; // 2 * centre
  for (let i = k; i < out.length; i += 3) out[i] = s - out[i];
  flipWindingInPlace(out);
  return makeGeo(out);
}

/**
 * Concatenate geometries that are already in a shared coordinate frame.
 * null / undefined / empty entries are skipped.
 * @param {THREE.BufferGeometry[]} list
 * @returns {THREE.BufferGeometry}
 */
export function mergeGeometries(list) {
  const arrs = (list || []).filter(Boolean).map(positionsOf);
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return makeGeo(out);
}

/**
 * Split a mesh into its connected shells. Two triangles are connected when they
 * share an exactly-equal vertex position (so shells that merely touch at one
 * vertex end up in the same part). Parts keep their original coordinates and
 * triangle order, and are returned in order of their first triangle.
 * @param {THREE.BufferGeometry} geo
 * @returns {THREE.BufferGeometry[]} one geometry per shell (a single-shell mesh gives a one-element array;
 *   an empty mesh gives an empty array)
 */
export function splitParts(geo) {
  const p = positionsOf(geo);
  const T = p.length / 9;
  if (!T) return [];
  const { ids, count } = weld(p);
  const par = new Int32Array(count);
  for (let i = 0; i < count; i++) par[i] = i;
  const find = (x) => {
    while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; }
    return x;
  };
  for (let t = 0; t < T; t++) {
    const a = find(ids[3 * t]);
    let b = find(ids[3 * t + 1]);
    if (a !== b) { if (a < b) par[b] = a; else par[a] = b; }
    const r = find(ids[3 * t]);
    const c = find(ids[3 * t + 2]);
    if (r !== c) { if (r < c) par[c] = r; else par[r] = c; }
  }
  const partOfRoot = new Int32Array(count).fill(-1);
  const triPart = new Int32Array(T);
  const sizes = [];
  for (let t = 0; t < T; t++) {
    const r = find(ids[3 * t]);
    let k = partOfRoot[r];
    if (k < 0) { k = partOfRoot[r] = sizes.length; sizes.push(0); }
    triPart[t] = k; sizes[k]++;
  }
  if (sizes.length === 1) return [makeGeo(new Float32Array(p))];
  const outs = sizes.map((s) => new Float32Array(s * 9));
  const fill = new Int32Array(sizes.length);
  for (let t = 0; t < T; t++) {
    const k = triPart[t];
    outs[k].set(p.subarray(9 * t, 9 * t + 9), fill[k]);
    fill[k] += 9;
  }
  return outs.map(makeGeo);
}

// ---------------------------------------------------------------------------
// Planar cut with caps
// ---------------------------------------------------------------------------

/**
 * Cut a mesh with the horizontal plane z = const and cap the cut faces.
 *
 * Triangles crossing the plane are split exactly (crossing points are computed
 * once per mesh edge, so both neighbours share them: no gaps). Vertices within
 * 1e-7 x model size of the plane are snapped onto it. Triangles lying in the
 * plane go to the piece they bound: facing up (+Z) -> bottom, facing down -> top.
 *
 * Caps: for each piece, the open edges lying in the plane are chained into
 * closed loops (by vertex identity first, then joining leftover chain ends that
 * are within 1e-6 x model size). Loops are nested by containment (even depth =
 * outer contour, odd depth = hole of its innermost container), and each region
 * is triangulated with THREE.ShapeUtils.triangulateShape using only the loop
 * vertices, so the cap shares its rim with the cut piece (watertight).
 * The top piece's cap faces -Z, the bottom piece's cap faces +Z.
 * Chains that cannot be closed (open / non-manifold input) are not capped.
 *
 * @param {THREE.BufferGeometry} geo
 * @param {number} z  cut height in mm (same frame as the positions)
 * @param {{capTop?: boolean, capBottom?: boolean}} [opts]
 * @returns {{top: THREE.BufferGeometry|null, bottom: THREE.BufferGeometry|null,
 *            openLoops: number, loops: number}}
 *   top / bottom are null when empty. openLoops = number of chains left uncapped
 *   (max over the capped pieces; 0 for a clean closed mesh). loops = number of
 *   closed loops capped (max over the capped pieces).
 */
export function cutAtZ(geo, z, opts = { capTop: true, capBottom: true }) {
  const capTop = !opts || opts.capTop !== false;
  const capBottom = !opts || opts.capBottom !== false;
  const pos = positionsOf(geo);
  const T = pos.length / 9;
  if (!T) return { top: null, bottom: null, openLoops: 0, loops: 0 };

  const { ids, verts, count: U } = weld(pos);
  const bb = bboxOf(verts);
  const size = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2], 1e-6);
  const zc = Math.fround(z);
  const snap = size * 1e-7;
  const tol = size * 1e-6;

  const P = new GrowF64(U * 3 + 3072);
  P.a.set(verts); P.n = U * 3;
  const side = new Int8Array(U);
  const dist = new Float64Array(U);
  {
    const A = P.a;
    for (let i = 0; i < U; i++) {
      const d = verts[3 * i + 2] - zc;
      if (Math.abs(d) <= snap) { side[i] = 0; dist[i] = 0; A[3 * i + 2] = zc; }
      else { side[i] = d > 0 ? 1 : -1; dist[i] = d; }
    }
  }

  const cross = new PairHash(1024);
  const crossVert = (a, b) => {
    if (a > b) { const t = a; a = b; b = t; }
    const e = cross.add(a, b);
    if (cross.isNew) {
      const A = P.a, t = dist[a] / (dist[a] - dist[b]);
      const ax = A[3 * a], ay = A[3 * a + 1], bx = A[3 * b], by = A[3 * b + 1];
      cross.val[e] = P.push3(Math.fround(ax + t * (bx - ax)), Math.fround(ay + t * (by - ay)), zc);
    }
    return cross.val[e];
  };

  const top = new GrowU32(T * 2), bot = new GrowU32(T * 2);
  for (let t = 0; t < T; t++) {
    const a = ids[3 * t], b = ids[3 * t + 1], c = ids[3 * t + 2];
    const sa = side[a], sb = side[b], sc = side[c];
    if (sa >= 0 && sb >= 0 && sc >= 0) {
      if (sa | sb | sc) { top.push3(a, b, c); continue; }
      // all three on the plane: assign by facing
      const A = P.a;
      const nz = (A[3 * b] - A[3 * a]) * (A[3 * c + 1] - A[3 * a + 1]) - (A[3 * b + 1] - A[3 * a + 1]) * (A[3 * c] - A[3 * a]);
      if (nz > 0) bot.push3(a, b, c); else if (nz < 0) top.push3(a, b, c);
      continue;
    }
    if (sa <= 0 && sb <= 0 && sc <= 0) { bot.push3(a, b, c); continue; }
    // crossing triangle: has a vertex above and one below
    let v0, v1, v2;
    if (sa === 0 || sb === 0 || sc === 0) {
      if (sa === 0) { v0 = a; v1 = b; v2 = c; } else if (sb === 0) { v0 = b; v1 = c; v2 = a; } else { v0 = c; v1 = a; v2 = b; }
      const m = crossVert(v1, v2);
      (side[v1] > 0 ? top : bot).push3(v0, v1, m);
      (side[v2] > 0 ? top : bot).push3(v0, m, v2);
    } else {
      if (sb === sc) { v0 = a; v1 = b; v2 = c; } else if (sa === sc) { v0 = b; v1 = c; v2 = a; } else { v0 = c; v1 = a; v2 = b; }
      const m1 = crossVert(v0, v1), m2 = crossVert(v0, v2);
      const L = side[v0] > 0 ? top : bot, R = side[v0] > 0 ? bot : top;
      L.push3(v0, m1, m2);
      R.push3(m1, v1, v2);
      R.push3(m1, v2, m2);
    }
  }

  const onPlane = (i) => i >= U || side[i] === 0;
  let openLoops = 0, loops = 0;
  if (capTop && top.n) { const r = capPiece(top, false, P, onPlane, tol); openLoops = Math.max(openLoops, r.open); loops = Math.max(loops, r.closed); }
  if (capBottom && bot.n) { const r = capPiece(bot, true, P, onPlane, tol); openLoops = Math.max(openLoops, r.open); loops = Math.max(loops, r.closed); }

  return {
    top: top.n ? makeGeo(expand(top.a, top.n, P.a)) : null,
    bottom: bot.n ? makeGeo(expand(bot.a, bot.n, P.a)) : null,
    openLoops,
    loops,
  };
}

/** Find the open on-plane rim of one cut piece, chain it into loops and append cap triangles to `list`. */
function capPiece(list, wantUp, P, onPlane, tol) {
  const arr = list.a, n = list.n;
  // 1. net directed count of every on-plane edge: interior edges cancel out
  const eh = new PairHash(1024);
  for (let t = 0; t < n; t += 3) {
    for (let k = 0; k < 3; k++) {
      const i = arr[t + k], j = arr[t + (k === 2 ? 0 : k + 1)];
      if (i === j || !onPlane(i) || !onPlane(j)) continue;
      const e = i < j ? eh.add(i, j) : eh.add(j, i);
      eh.val[e] += i < j ? 1 : -1;
    }
  }
  const from = [], to = [];
  for (let e = 0; e < eh.n; e++) {
    let c = eh.val[e];
    for (; c > 0; c--) { from.push(eh.ka[e]); to.push(eh.kb[e]); }
    for (; c < 0; c++) { from.push(eh.kb[e]); to.push(eh.ka[e]); }
  }
  if (!from.length) return { open: 0, closed: 0 };

  // 2. chain rim edges into loops (splitting pinched figure-eights)
  const outs = new Map(), bal = new Map();
  for (let e = 0; e < from.length; e++) {
    let l = outs.get(from[e]);
    if (!l) outs.set(from[e], (l = []));
    l.push(e);
    bal.set(from[e], (bal.get(from[e]) || 0) + 1);
    bal.set(to[e], (bal.get(to[e]) || 0) - 1);
  }
  const loopsIds = [], openChains = [];
  const nextEdge = (v) => { const l = outs.get(v); return l && l.length ? l.pop() : -1; };
  const walk = (v0) => {
    const chain = [v0], where = new Map([[v0, 0]]);
    let v = v0;
    for (;;) {
      const e = nextEdge(v);
      if (e < 0) break;
      const w = to[e], p = where.get(w);
      if (p !== undefined) {
        const loop = chain.splice(p);
        for (const u of loop) where.delete(u);
        loopsIds.push(loop);
        chain.push(w); where.set(w, chain.length - 1);
      } else {
        chain.push(w); where.set(w, chain.length - 1);
      }
      v = w;
    }
    if (chain.length > 1) openChains.push(chain);
  };
  for (const [v, b] of bal) if (b > 0) for (let k = 0; k < b; k++) walk(v);
  for (const v of outs.keys()) while (outs.get(v).length) walk(v);

  // 3. join leftover open chains whose ends nearly coincide
  const A = P.a, tol2 = tol * tol;
  let open = 0;
  if (openChains.length) {
    const dead = new Uint8Array(openChains.length);
    for (let i = 0; i < openChains.length; i++) {
      if (dead[i]) continue;
      let chain = openChains[i];
      for (;;) {
        const e = chain[chain.length - 1];
        const ex = A[3 * e], ey = A[3 * e + 1];
        let best = -1, bd = tol2;
        for (let j = i; j < openChains.length; j++) {
          if (dead[j]) continue;
          const s = j === i ? chain[0] : openChains[j][0];
          const dx = A[3 * s] - ex, dy = A[3 * s + 1] - ey, d = dx * dx + dy * dy;
          if (d <= bd) { bd = d; best = j; if (d === 0) break; }
        }
        if (best === i) { loopsIds.push(chain); dead[i] = 1; break; }
        if (best < 0) { open++; dead[i] = 1; break; }
        chain = chain.concat(openChains[best]); dead[best] = 1;
      }
    }
  }

  // 4. loops -> 2D polygons (drop consecutive near-duplicates)
  const polys = [];
  for (const ids of loopsIds) {
    const xs = [], ys = [], vid = [];
    for (const v of ids) {
      const x = A[3 * v], y = A[3 * v + 1];
      const m = xs.length;
      if (m && (xs[m - 1] - x) ** 2 + (ys[m - 1] - y) ** 2 <= tol2) continue;
      xs.push(x); ys.push(y); vid.push(v);
    }
    while (xs.length > 1 && (xs[0] - xs[xs.length - 1]) ** 2 + (ys[0] - ys[ys.length - 1]) ** 2 <= tol2) { xs.pop(); ys.pop(); vid.pop(); }
    if (xs.length < 3) continue;
    let area = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0, m = xs.length; k < m; k++) {
      const k2 = k + 1 === m ? 0 : k + 1;
      area += xs[k] * ys[k2] - xs[k2] * ys[k];
      if (xs[k] < x0) x0 = xs[k]; if (xs[k] > x1) x1 = xs[k];
      if (ys[k] < y0) y0 = ys[k]; if (ys[k] > y1) y1 = ys[k];
    }
    area /= 2;
    if (Math.abs(area) <= tol2) continue;
    polys.push({ xs, ys, vid, area, abs: Math.abs(area), x0, y0, x1, y1, depth: 0, parent: -1 });
  }

  // 5. nesting by containment: depth parity decides contour vs hole
  for (let i = 0; i < polys.length; i++) {
    const pi = polys[i];
    const tx = (pi.xs[0] + pi.xs[1]) / 2, ty = (pi.ys[0] + pi.ys[1]) / 2;
    let bestArea = Infinity;
    for (let j = 0; j < polys.length; j++) {
      const pj = polys[j];
      if (j === i || pj.abs <= pi.abs || tx < pj.x0 || tx > pj.x1 || ty < pj.y0 || ty > pj.y1) continue;
      if (pointInPoly(tx, ty, pj.xs, pj.ys)) {
        pi.depth++;
        if (pj.abs < bestArea) { bestArea = pj.abs; pi.parent = j; }
      }
    }
  }
  const holesOf = polys.map(() => []);
  for (let i = 0; i < polys.length; i++) {
    const q = polys[i];
    if (q.depth % 2 === 1 && q.parent >= 0 && polys[q.parent].depth === q.depth - 1) holesOf[q.parent].push(i);
  }

  // 6. triangulate each outer contour with its holes
  let closed = 0;
  const toV2 = (q, ccw) => {
    const rev = (q.area > 0) !== ccw;
    const pts = [], vid = [];
    const m = q.xs.length;
    for (let k = 0; k < m; k++) {
      const s = rev ? m - 1 - k : k;
      pts.push(new THREE.Vector2(q.xs[s], q.ys[s])); vid.push(q.vid[s]);
    }
    return { pts, vid };
  };
  for (let i = 0; i < polys.length; i++) {
    const q = polys[i];
    if (q.depth % 2 === 1) continue;
    closed++;
    const c = toV2(q, true);
    const hs = holesOf[i].map((h) => toV2(polys[h], false));
    closed += hs.length;
    let faces;
    try {
      faces = THREE.ShapeUtils.triangulateShape(c.pts, hs.map((h) => h.pts));
    } catch (err) {
      open += 1 + hs.length; closed -= 1 + hs.length;
      continue;
    }
    const vid = c.vid.concat(...hs.map((h) => h.vid));
    for (const f of faces) {
      let a = vid[f[0]], b = vid[f[1]], d = vid[f[2]];
      const cr = (A[3 * b] - A[3 * a]) * (A[3 * d + 1] - A[3 * a + 1]) - (A[3 * b + 1] - A[3 * a + 1]) * (A[3 * d] - A[3 * a]);
      if (cr === 0) continue;
      if ((cr > 0) !== wantUp) { const t = b; b = d; d = t; }
      list.push3(a, b, d);
    }
  }
  return { open, closed };
}

function pointInPoly(x, y, xs, ys) {
  let inside = false;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    const yi = ys[i], yj = ys[j];
    if ((yi > y) !== (yj > y) && x < ((xs[j] - xs[i]) * (y - yi)) / (yj - yi) + xs[i]) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** three.js Y-up indexed primitive -> Z-up, non-indexed, position-only, seams welded, outward. */
function fromThree(g) {
  const ni = g.index ? g.toNonIndexed() : g;
  const src = ni.getAttribute("position").array;
  const out = new Float32Array(src.length);
  let maxAbs = 0;
  for (let i = 0; i < src.length; i++) maxAbs = Math.max(maxAbs, Math.abs(src[i]));
  const eps = maxAbs * 1e-9;
  for (let i = 0; i < src.length; i += 3) {
    // (x, y, z) Y-up -> (x, -z, y) Z-up: a proper rotation, windings unchanged
    out[i] = src[i];
    out[i + 1] = -src[i + 2];
    out[i + 2] = src[i + 1];
  }
  // sin(2*pi) etc. leave ~1e-16 residues on seams/poles: snap them (and -0) to 0 so seams weld exactly
  for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) <= eps) out[i] = 0;
  g.dispose(); if (ni !== g) ni.dispose();
  if (volumeOfArray(out) < 0) flipWindingInPlace(out);
  return makeGeo(out);
}

/**
 * Axis-aligned box centred on the origin.
 * @param {number} w size along X (mm)
 * @param {number} d size along Y (mm)
 * @param {number} h size along Z (mm)
 * @returns {THREE.BufferGeometry} 12 triangles
 */
export function box(w, d, h) {
  return fromThree(new THREE.BoxGeometry(w, h, d));
}

/**
 * Closed cylinder along Z, centred on the origin (z from -h/2 to h/2).
 * @param {number} diameter (mm)
 * @param {number} h height (mm)
 * @param {number} [segments=64] radial segments
 * @returns {THREE.BufferGeometry}
 */
export function cylinder(diameter, h, segments = 64) {
  return fromThree(new THREE.CylinderGeometry(diameter / 2, diameter / 2, h, Math.max(3, segments | 0), 1, false));
}

/**
 * UV sphere centred on the origin, poles on the Z axis.
 * @param {number} diameter (mm)
 * @param {number} [segments=48] segments around the equator (pole-to-pole uses segments/2)
 * @returns {THREE.BufferGeometry} about segments^2 triangles
 */
export function sphere(diameter, segments = 48) {
  const w = Math.max(3, segments | 0);
  return fromThree(new THREE.SphereGeometry(diameter / 2, w, Math.max(2, Math.round(w / 2))));
}

/**
 * Closed cone along Z, centred on the origin: base disc at z = -h/2, apex at z = +h/2.
 * @param {number} diameter base diameter (mm)
 * @param {number} h height (mm)
 * @param {number} [segments=64] radial segments
 * @returns {THREE.BufferGeometry}
 */
export function cone(diameter, h, segments = 64) {
  return fromThree(new THREE.ConeGeometry(diameter / 2, h, Math.max(3, segments | 0), 1, false));
}

// ---------------------------------------------------------------------------
// Subdivision (for painting)
// ---------------------------------------------------------------------------

/**
 * Refine a mesh until no edge is longer than maxEdge, without exceeding maxTriangles.
 *
 * Method: conforming edge-midpoint refinement in passes. Each pass marks every
 * edge longer than maxEdge (edges are identified by welded vertex pairs, so a
 * shared edge is marked for both neighbours), inserts one midpoint per marked
 * edge, and splits each triangle by its number of marked edges: 1 -> 2
 * triangles (bisection), 2 -> 3 (corner cut + shorter quad diagonal),
 * 3 -> 4 (midpoint split). Because both triangles of an edge always agree, the
 * result is watertight (no T-junctions) for a welded input mesh, and volume is
 * preserved exactly. If a full pass would exceed maxTriangles, the last pass
 * splits only the longest marked edges that still fit the budget, then stops
 * (so some edges may remain longer than maxEdge).
 *
 * @param {THREE.BufferGeometry} geo
 * @param {number} maxEdge   target maximum edge length (mm)
 * @param {number} [maxTriangles=2000000] hard cap on the output triangle count
 * @returns {{geo: THREE.BufferGeometry, parent: Int32Array}} parent[i] = index of the input triangle
 *   that output triangle i lies in.
 */
export function subdivide(geo, maxEdge, maxTriangles = 2000000) {
  const pos = positionsOf(geo);
  const T0 = pos.length / 9;
  let parent = new Int32Array(T0);
  for (let i = 0; i < T0; i++) parent[i] = i;
  if (!T0 || !(maxEdge > 0)) return { geo: makeGeo(new Float32Array(pos)), parent };
  const { ids, verts, count } = weld(pos);
  const P = new GrowF64(count * 6);
  P.a.set(verts); P.n = count * 3;
  let tris = ids;
  const max2 = maxEdge * maxEdge;

  for (let pass = 0; pass < 64; pass++) {
    const T = tris.length / 3;
    if (T >= maxTriangles) break;
    const eh = new PairHash(T * 2);
    const te = new Uint32Array(T * 3);
    for (let i = 0; i < T * 3; i++) {
      const a = tris[i], b = tris[i % 3 === 2 ? i - 2 : i + 1];
      te[i] = a < b ? eh.add(a, b) : eh.add(b, a);
    }
    const E = eh.n;
    const A = P.a;
    const len2 = new Float64Array(E);
    const mark = new Uint8Array(E);
    let nMarked = 0;
    for (let e = 0; e < E; e++) {
      const a = 3 * eh.ka[e], b = 3 * eh.kb[e];
      const dx = A[a] - A[b], dy = A[a + 1] - A[b + 1], dz = A[a + 2] - A[b + 2];
      const l = dx * dx + dy * dy + dz * dz;
      len2[e] = l;
      if (l > max2) { mark[e] = 1; nMarked++; }
    }
    if (!nMarked) break;
    let extra = 0;
    for (let i = 0; i < T * 3; i++) extra += mark[te[i]];
    let last = false;
    if (T + extra > maxTriangles) {
      last = true;
      const use = new Uint8Array(E);
      for (let i = 0; i < T * 3; i++) if (use[te[i]] < 255) use[te[i]]++;
      const cand = new Uint32Array(nMarked);
      for (let e = 0, k = 0; e < E; e++) if (mark[e]) cand[k++] = e;
      cand.sort((x, y) => len2[y] - len2[x]);
      mark.fill(0);
      let budget = maxTriangles - T;
      extra = 0;
      for (const e of cand) {
        if (use[e] > budget) break;
        mark[e] = 1; budget -= use[e]; extra += use[e];
      }
      if (!extra) break;
    }
    const mid = new Int32Array(E).fill(-1);
    for (let e = 0; e < E; e++) {
      if (!mark[e]) continue;
      const B = P.a, a = 3 * eh.ka[e], b = 3 * eh.kb[e];
      mid[e] = P.push3(Math.fround((B[a] + B[b]) / 2), Math.fround((B[a + 1] + B[b + 1]) / 2), Math.fround((B[a + 2] + B[b + 2]) / 2));
    }
    const B = P.a;
    const d2 = (u, v) => {
      const dx = B[3 * u] - B[3 * v], dy = B[3 * u + 1] - B[3 * v + 1], dz = B[3 * u + 2] - B[3 * v + 2];
      return dx * dx + dy * dy + dz * dz;
    };
    const nt = new Uint32Array((T + extra) * 3);
    const np = new Int32Array(T + extra);
    let o = 0;
    const emit = (a, b, c, p) => { np[o / 3] = p; nt[o++] = a; nt[o++] = b; nt[o++] = c; };
    for (let t = 0; t < T; t++) {
      const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2], p = parent[t];
      const m0 = mid[te[3 * t]], m1 = mid[te[3 * t + 1]], m2 = mid[te[3 * t + 2]];
      const k = (m0 >= 0) + (m1 >= 0) + (m2 >= 0);
      if (k === 0) emit(a, b, c, p);
      else if (k === 3) { emit(a, m0, m2, p); emit(m0, b, m1, p); emit(m2, m1, c, p); emit(m0, m1, m2, p); }
      else if (k === 1) {
        let v0, v1, v2, m;
        if (m0 >= 0) { v0 = a; v1 = b; v2 = c; m = m0; } else if (m1 >= 0) { v0 = b; v1 = c; v2 = a; m = m1; } else { v0 = c; v1 = a; v2 = b; m = m2; }
        emit(v0, m, v2, p); emit(m, v1, v2, p);
      } else {
        // marked edges (v0v1) -> mA and (v1v2) -> mB
        let v0, v1, v2, mA, mB;
        if (m2 < 0) { v0 = a; v1 = b; v2 = c; mA = m0; mB = m1; }
        else if (m0 < 0) { v0 = b; v1 = c; v2 = a; mA = m1; mB = m2; }
        else { v0 = c; v1 = a; v2 = b; mA = m2; mB = m0; }
        emit(mA, v1, mB, p);
        if (d2(v0, mB) <= d2(mA, v2)) { emit(v0, mA, mB, p); emit(v0, mB, v2, p); }
        else { emit(v0, mA, v2, p); emit(mA, mB, v2, p); }
      }
    }
    tris = nt; parent = np;
    if (last) break;
  }
  return { geo: makeGeo(expand(tris, tris.length, P.a)), parent };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Triangles that need support, using the OrcaSlicer / PrusaSlicer
 * "support threshold angle" convention (same test as the slicers' paint-on
 * "highlight overhangs by angle"): with n = the triangle's unit world-space
 * normal (after matrix4; winding flipped for mirroring matrices), a triangle is
 * an overhang when it faces down AND its surface is tilted less than
 * maxAngleDeg away from horizontal, i.e. the angle between n and straight down
 * (0,0,-1) is less than maxAngleDeg:  -n.z > cos(maxAngleDeg).
 * Examples: 0 -> nothing; 30 -> ceilings and faces within 30 deg of a ceiling;
 * 90 -> every downward-facing face (vertical walls excluded).
 * Triangles resting on the bed (all three vertices within 0.01 mm of the lowest
 * world z of the whole geometry) are ignored.
 *
 * @param {THREE.BufferGeometry} geo
 * @param {THREE.Matrix4|null} matrix4 object-to-world transform (null = identity)
 * @param {number} maxAngleDeg threshold angle in degrees (OrcaSlicer support_threshold_angle)
 * @returns {Uint32Array} ascending triangle indices
 */
export function overhangTriangles(geo, matrix4, maxAngleDeg) {
  const p = positionsOf(geo);
  const T = p.length / 9;
  const e = matrix4 ? matrix4.elements : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const flip = matrix4 && matrix4.determinant() < 0 ? -1 : 1;
  const tz = (x, y, z) => e[2] * x + e[6] * y + e[10] * z + e[14];
  let zmin = Infinity;
  for (let i = 0; i < p.length; i += 3) { const z = tz(p[i], p[i + 1], p[i + 2]); if (z < zmin) zmin = z; }
  const bed = zmin + 0.01;
  const cosT = Math.cos((maxAngleDeg * Math.PI) / 180);
  const out = new GrowU32(1024);
  const w = new Float64Array(9);
  for (let t = 0; t < T; t++) {
    const o = 9 * t;
    for (let k = 0; k < 9; k += 3) {
      const x = p[o + k], y = p[o + k + 1], z = p[o + k + 2];
      w[k] = e[0] * x + e[4] * y + e[8] * z + e[12];
      w[k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      w[k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    if (w[2] <= bed && w[5] <= bed && w[8] <= bed) continue;
    const ux = w[3] - w[0], uy = w[4] - w[1], uz = w[5] - w[2];
    const vx = w[6] - w[0], vy = w[7] - w[1], vz = w[8] - w[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = (ux * vy - uy * vx) * flip;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len === 0) continue;
    if (-nz / len > cosT) out.push(t);
  }
  return out.a.slice(0, out.n);
}

/**
 * Per-triangle paint string for an OrcaSlicer 3MF `<triangle paint_supports="...">`
 * or `paint_seam="..."` attribute, for a whole (not split) triangle.
 * OrcaSlicer's TriangleSelector serialises each leaf as a nibble: the low two
 * bits are the split count (0 = leaf) and the state sits in bits 2-3, written
 * as hex. So enforcer (state 1) -> "4", blocker (state 2) -> "8".
 * @param {number} state 0 = none, 1 = enforcer, 2 = blocker
 * @returns {string} "4", "8", or "" (empty: omit the attribute)
 */
export function paintCode(state) {
  return state === 1 ? "4" : state === 2 ? "8" : "";
}

/**
 * Signed enclosed volume (divergence theorem). Positive for a closed mesh with
 * outward (CCW from outside) windings; meaningful only for closed meshes.
 * @param {THREE.BufferGeometry} geo
 * @returns {number} mm^3
 */
export function volume(geo) {
  return volumeOfArray(positionsOf(geo));
}
