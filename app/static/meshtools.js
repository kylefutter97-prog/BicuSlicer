// Simplify and mesh booleans, like OrcaSlicer's Simplify and Mesh boolean tools.
// Simplify uses meshoptimizer's simplifier (MIT); booleans use Manifold (Apache-2.0), both vendored in /static/vendor
// and loaded the first time they're needed.
import * as THREE from "three";

let meshopt = null, manifold = null;
async function simplifier() {
  if (!meshopt) meshopt = import("/static/vendor/meshopt_simplifier.js").then(async (m) => { await m.MeshoptSimplifier.ready; return m.MeshoptSimplifier; });
  return meshopt;
}
async function manifoldLib() {
  if (!manifold) manifold = import("/static/vendor/manifold/manifold.js").then(async (m) => { const w = await m.default(); w.setup(); return w; });
  return manifold;
}

/** Shared corners: positions (Float32Array, xyz) and triangle indices (Uint32Array) of a geometry. */
export function weld(geo, tol = 1e-5) {
  const pos = geo.getAttribute("position"), index = geo.getIndex();
  const n = index ? index.count : pos.count;
  const ids = new Map(), verts = [], tris = new Uint32Array(n);
  const k = 1 / tol;
  for (let i = 0; i < n; i++) {
    const j = index ? index.getX(i) : i;
    const x = pos.getX(j), y = pos.getY(j), z = pos.getZ(j);
    const key = `${Math.round(x * k)},${Math.round(y * k)},${Math.round(z * k)}`;
    let id = ids.get(key);
    if (id === undefined) { id = verts.length / 3; ids.set(key, id); verts.push(x, y, z); }
    tris[i] = id;
  }
  // drop triangles that welding collapsed
  const keep = [];
  for (let t = 0; t < n; t += 3) if (tris[t] !== tris[t + 1] && tris[t + 1] !== tris[t + 2] && tris[t] !== tris[t + 2]) keep.push(tris[t], tris[t + 1], tris[t + 2]);
  return { positions: new Float32Array(verts), indices: Uint32Array.from(keep) };
}

/** A non-indexed geometry from positions and triangle indices. */
function unweld(positions, indices) {
  const out = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) out.set(positions.subarray(indices[i] * 3, indices[i] * 3 + 3), i * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}

export const triangleCount = (geo) => (geo.getIndex() ? geo.getIndex().count : geo.getAttribute("position").count) / 3;

/**
 * Fewer triangles, keeping the shape: `keep` is the share of triangles to aim for (0–1); `maxError` (mm) stops it
 * earlier where going further would change the shape more than that. Returns { geo, triangles, error (mm) }.
 */
export async function simplify(geo, keep, maxError = 0.5) {
  const S = await simplifier();
  const { positions, indices } = weld(geo);
  const target = Math.max(12, Math.floor(indices.length / 3 * keep)) * 3;
  const [out, err] = S.simplify(indices, positions, 3, target, maxError, ["ErrorAbsolute"]);
  return { geo: unweld(positions, out), triangles: out.length / 3, error: err };
}

/** A Manifold solid from a geometry (in the same axes as the others it's combined with). */
function toManifold(w, geo) {
  const { positions, indices } = weld(geo);
  const mesh = new w.Mesh({ numProp: 3, vertProperties: positions, triVerts: indices });
  mesh.merge();
  const bad = "its mesh isn't a closed solid (it has holes or loose faces): try More → Fix first";
  let m;
  try { m = new w.Manifold(mesh); } catch (e) { throw new Error(bad); }
  const st = m.status?.();
  if (st !== undefined && String(st?.value ?? st) !== "NoError" && String(st?.value ?? st) !== "0") { m.delete(); throw new Error(bad); }
  return m;
}

/**
 * Combine solids: op "union" (all into one), "subtract" (the rest cut out of the first) or "intersect" (only where
 * they all overlap). Geometries are in plate axes. Returns the result's geometry, or throws when it's empty.
 */
export async function boolean(op, geos) {
  const w = await manifoldLib();
  const solids = [];
  try {
    geos.forEach((g, i) => {
      try { solids.push(toManifold(w, g)); } catch (e) { throw new Error(`Part ${i + 1}: ${e.message}`); }
    });
    let r = solids[0];
    for (const s of solids.slice(1)) {
      const next = op === "union" ? r.add(s) : op === "subtract" ? r.subtract(s) : r.intersect(s);
      if (r !== solids[0]) r.delete();
      r = next;
    }
    const m = r.getMesh();
    if (r !== solids[0]) r.delete();
    if (!m.triVerts.length) throw new Error(op === "intersect" ? "the parts don't overlap: nothing is left" : "nothing is left");
    const pos = m.numProp === 3 ? m.vertProperties : (() => {
      const p = new Float32Array(m.vertProperties.length / m.numProp * 3);
      for (let i = 0, j = 0; i < m.vertProperties.length; i += m.numProp, j += 3) p.set(m.vertProperties.subarray(i, i + 3), j);
      return p;
    })();
    return unweld(pos, m.triVerts);
  } finally {
    for (const s of solids) s.delete();
  }
}
