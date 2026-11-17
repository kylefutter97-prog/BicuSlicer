// Measuring, like OrcaSlicer's Measure tool: what a tap on a part picks (a corner, a circle's centre or a flat face)
// and what two picks measure (distance, angle, gap between parallel faces, point to face).
import * as THREE from "three";

const KEY = 1e4;         // vertices closer than 0.1 µm are the same corner

/** Triangles of a mesh in world coordinates, with shared corners and edges (cached until the mesh moves). */
const topoCache = new WeakMap();
function topology(mesh) {
  mesh.updateMatrixWorld();
  const sig = mesh.matrixWorld.elements.join(",");
  const c = topoCache.get(mesh);
  if (c && c.sig === sig && c.geo === mesh.geometry) return c;
  const geo = mesh.geometry, pos = geo.getAttribute("position"), index = geo.getIndex();
  const T = (index ? index.count : pos.count) / 3;
  const ids = new Map(), verts = [], tv = new Int32Array(T * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < T * 3; i++) {
    v.fromBufferAttribute(pos, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
    const k = `${Math.round(v.x * KEY)},${Math.round(v.y * KEY)},${Math.round(v.z * KEY)}`;
    let id = ids.get(k);
    if (id === undefined) { id = verts.length; ids.set(k, id); verts.push(v.clone()); }
    tv[i] = id;
  }
  const edges = new Map();
  const ek = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  for (let t = 0; t < T; t++) for (let e = 0; e < 3; e++) {
    const k = ek(tv[t * 3 + e], tv[t * 3 + (e + 1) % 3]);
    const l = edges.get(k);
    if (l) l.push(t); else edges.set(k, [t]);
  }
  const normals = new Float32Array(T * 3), areas = new Float32Array(T);
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < T; t++) {
    const [a, b, cc] = [verts[tv[t * 3]], verts[tv[t * 3 + 1]], verts[tv[t * 3 + 2]]];
    n.crossVectors(ab.subVectors(b, a), ac.subVectors(cc, a));
    areas[t] = n.length() / 2;
    n.normalize();
    normals.set([n.x, n.y, n.z], t * 3);
  }
  const out = { sig, geo, verts, tv, edges, ek, normals, areas, T };
  topoCache.set(mesh, out);
  return out;
}

/** A circle through the points, if they lie on one (within 2 %): { center, radius, normal }. */
function fitCircle(points, normal) {
  if (points.length < 6) return null;
  const c = new THREE.Vector3();
  for (const p of points) c.add(p);
  c.divideScalar(points.length);
  let lo = Infinity, hi = 0, sum = 0;
  for (const p of points) { const r = p.distanceTo(c); lo = Math.min(lo, r); hi = Math.max(hi, r); sum += r; }
  const r = sum / points.length;
  return r > 0.05 && (hi - lo) / r < 0.02 ? { center: c, radius: r, normal: normal.clone() } : null;
}

/**
 * The flat face around triangle `tri` of a mesh (its neighbours in the same plane): its triangles, normal, area and
 * outline loops (each a circle when it is one: a hole, or a round face's rim).
 */
export function faceRegion(mesh, tri) {
  const tp = topology(mesh);
  const { verts, tv, edges, ek, normals, areas } = tp;
  const n0 = new THREE.Vector3(normals[tri * 3], normals[tri * 3 + 1], normals[tri * 3 + 2]);
  const p0 = verts[tv[tri * 3]];
  const cosTol = Math.cos(THREE.MathUtils.degToRad(1));
  const inRegion = new Set([tri]), queue = [tri];
  while (queue.length) {
    const t = queue.pop();
    for (let e = 0; e < 3; e++) {
      for (const u of edges.get(ek(tv[t * 3 + e], tv[t * 3 + (e + 1) % 3])) || []) {
        if (inRegion.has(u)) continue;
        const dot = n0.x * normals[u * 3] + n0.y * normals[u * 3 + 1] + n0.z * normals[u * 3 + 2];
        if (dot < cosTol) continue;
        const q = verts[tv[u * 3]];
        if (Math.abs(n0.x * (q.x - p0.x) + n0.y * (q.y - p0.y) + n0.z * (q.z - p0.z)) > 0.02) continue;
        inRegion.add(u);
        queue.push(u);
      }
    }
  }
  // outline: the region's edges that only one of its triangles has
  const count = new Map();
  for (const t of inRegion) for (let e = 0; e < 3; e++) {
    const a = tv[t * 3 + e], b = tv[t * 3 + (e + 1) % 3], k = ek(a, b);
    const c = count.get(k);
    count.set(k, c ? { n: c.n + 1, a, b } : { n: 1, a, b });
  }
  const next = new Map();
  for (const { n, a, b } of count.values()) if (n === 1) { (next.get(a) || next.set(a, []).get(a)).push(b); (next.get(b) || next.set(b, []).get(b)).push(a); }
  const loops = [], seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let prev = -1, curV = start;
    while (curV !== undefined && !seen.has(curV)) {
      seen.add(curV);
      loop.push(verts[curV]);
      const nb = next.get(curV) || [];
      const nx = nb.find((x) => x !== prev && !seen.has(x));
      prev = curV;
      curV = nx;
    }
    if (loop.length >= 3) {
      let len = 0;
      for (let i = 0; i < loop.length; i++) len += loop[i].distanceTo(loop[(i + 1) % loop.length]);
      loops.push({ points: loop, length: len, circle: fitCircle(loop, n0) });
    }
  }
  let area = 0;
  for (const t of inRegion) area += areas[t];
  return { tris: [...inRegion], normal: n0, area, loops, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n0, p0), topo: tp };
}

/**
 * What a tap picks: the corner under the pointer (within `snapPx` on screen), else a circle whose rim is close,
 * else the flat face. `toScreen(v)` gives a world point's screen position in px.
 */
export function pickFeature(mesh, hit, toScreen, snapPx = 14) {
  const region = faceRegion(mesh, hit.faceIndex);
  const tp = region.topo;
  const tap = toScreen(hit.point);
  // a corner of the tapped triangle
  let best = null, bestD = snapPx;
  for (let i = 0; i < 3; i++) {
    const v = tp.verts[tp.tv[hit.faceIndex * 3 + i]], s = toScreen(v), dd = Math.hypot(s.x - tap.x, s.y - tap.y);
    if (dd < bestD) { bestD = dd; best = v; }
  }
  // a circle's rim near the tap (on screen, or within a fifth of its radius)
  let circle = null, circD = Infinity;
  for (const l of region.loops) {
    if (!l.circle) continue;
    const off = Math.abs(hit.point.distanceTo(l.circle.center) - l.circle.radius);
    const nearPx = Math.min(...l.points.map((p) => { const s = toScreen(p); return Math.hypot(s.x - tap.x, s.y - tap.y); }));
    if ((off < l.circle.radius * 0.2 || nearPx < snapPx * 1.5) && off < circD) { circD = off; circle = l.circle; }
  }
  if (best && !circle) return { kind: "point", point: best.clone(), region };
  if (circle) return { kind: "circle", point: circle.center.clone(), circle, region };
  return { kind: "face", point: hit.point.clone(), region };
}

const deg = (r) => THREE.MathUtils.radToDeg(r);

/** What two picks measure: [{ label, value }] (mm and degrees). */
export function measureBetween(a, b) {
  const out = [];
  const d = new THREE.Vector3().subVectors(b.point, a.point);
  const name = { point: "corners", circle: "centres", face: "points" };
  out.push({ label: a.kind === b.kind ? `Distance between ${name[a.kind]}` : "Distance", value: `${d.length().toFixed(2)} mm`,
    detail: `X ${Math.abs(d.x).toFixed(2)} · Y ${Math.abs(d.y).toFixed(2)} · Z ${Math.abs(d.z).toFixed(2)}` });
  const na = a.region.normal, nb = b.region.normal;
  const sameFace = a.region.tris[0] === b.region.tris[0] && a.region.topo === b.region.topo;
  if (a.kind !== "point" && b.kind !== "point" && !sameFace) {
    const ang = deg(Math.acos(Math.min(1, Math.abs(na.dot(nb)))));
    out.push({ label: "Angle between faces", value: `${ang.toFixed(1)}°` });
    if (ang < 0.5) out.push({ label: "Gap between the faces", value: `${Math.abs(a.region.plane.distanceToPoint(b.point)).toFixed(2)} mm` });
  }
  if (a.kind === "point" && b.kind !== "point") out.push({ label: "Corner to face", value: `${Math.abs(b.region.plane.distanceToPoint(a.point)).toFixed(2)} mm` });
  if (b.kind === "point" && a.kind !== "point") out.push({ label: "Corner to face", value: `${Math.abs(a.region.plane.distanceToPoint(b.point)).toFixed(2)} mm` });
  return out;
}

/** What one pick is: [{ label, value }]. */
export function describe(p) {
  const f = (v) => `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
  if (p.kind === "point") return [{ label: "Corner", value: f(p.point) }];
  if (p.kind === "circle") return [{ label: "Circle", value: `Ø ${(p.circle.radius * 2).toFixed(2)} mm`, detail: `centre ${f(p.circle.center)}` }];
  const out = [{ label: "Face", value: `${p.region.area.toFixed(1)} mm²` }];
  const circles = p.region.loops.filter((l) => l.circle);
  if (circles.length) out.push({ label: circles.length > 1 ? "Circles on it" : "Circle on it", value: circles.slice(0, 4).map((l) => `Ø ${(l.circle.radius * 2).toFixed(2)}`).join(", ") + " mm" });
  return out;
}
