// 3D text, like OrcaSlicer's Text tool: a font's outlines (read by opentype.js, MIT) extruded into a mesh.
// Bundled open-licence fonts live in /static/fonts; fonts you upload are kept by the server (/api/fonts).
import * as THREE from "three";

let otModule = null;
const opentype = () => (otModule ||= import("/static/vendor/opentype.module.js"));

/** Fonts that come with BicuSlicer (open licences: see THIRD_PARTY_NOTICES.md). */
export const BUNDLED_FONTS = [
  { id: "roboto", label: "Roboto", url: "/static/fonts/roboto-latin-400-normal.woff" },
  { id: "roboto-bold", label: "Roboto Bold", url: "/static/fonts/roboto-latin-700-normal.woff" },
  { id: "roboto-slab", label: "Roboto Slab", url: "/static/fonts/roboto-slab-latin-400-normal.woff" },
  { id: "roboto-mono", label: "Roboto Mono", url: "/static/fonts/roboto-mono-latin-400-normal.woff" },
  { id: "bebas-neue", label: "Bebas Neue", url: "/static/fonts/bebas-neue-latin-400-normal.woff" },
  { id: "lobster", label: "Lobster", url: "/static/fonts/lobster-latin-400-normal.woff" },
];

const fontCache = new Map();
export function loadFont(url) {
  if (!fontCache.has(url)) {
    fontCache.set(url, (async () => {
      const ot = await opentype();
      const r = await fetch(url);
      if (!r.ok) throw new Error("couldn't load the font");
      return ot.parse(await r.arrayBuffer());
    })().catch((e) => { fontCache.delete(url); throw e; }));
  }
  return fontCache.get(url);
}

const area = (pts) => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x - pts[i].x) * (pts[j].y + pts[i].y); return a / 2; };

/** One glyph's outline as THREE shapes (y up), its holes worked out from the direction of its biggest contour. */
function glyphShapes(path, dy) {
  const sp = new THREE.ShapePath();
  for (const c of path.commands) {
    if (c.type === "M") sp.moveTo(c.x, -c.y + dy);
    else if (c.type === "L") sp.lineTo(c.x, -c.y + dy);
    else if (c.type === "Q") sp.quadraticCurveTo(c.x1, -c.y1 + dy, c.x, -c.y + dy);
    else if (c.type === "C") sp.bezierCurveTo(c.x1, -c.y1 + dy, c.x2, -c.y2 + dy, c.x, -c.y + dy);
  }
  if (!sp.subPaths.length) return [];
  // TrueType and PostScript fonts wind their outer contours opposite ways: follow the largest one
  let big = sp.subPaths[0], bigA = 0;
  for (const s of sp.subPaths) { const a = Math.abs(area(s.getPoints())); if (a > bigA) { bigA = a; big = s; } }
  // toShapes(false) takes clockwise contours as solid, toShapes(true) counter-clockwise ones
  return sp.toShapes(!THREE.ShapeUtils.isClockWise(big.getPoints()));
}

/**
 * Text as a mesh lying in the XY plane, extruded from z = 0 to z = depth, centred on x and y.
 * p = { text, size (mm, the font's em height), depth, spacing (mm between letters), lineSpacing (× size) }.
 * Returns a non-indexed BufferGeometry (positions only).
 */
export function textGeometry(font, p) {
  const size = Math.max(0.5, +p.size || 10), scale = size / font.unitsPerEm;
  const spacing = +p.spacing || 0, lineH = size * (+p.lineSpacing || 1.2);
  const shapes = [];
  const lines = String(p.text || "").replace(/\r/g, "").split("\n");
  const widths = [];
  lines.forEach((line, li) => {
    const glyphs = font.stringToGlyphs(line);
    let x = 0;
    const start = shapes.length;
    glyphs.forEach((g, i) => {
      shapes.push(...glyphShapes(g.getPath(x, 0, size), -li * lineH));
      x += g.advanceWidth * scale + spacing;
      if (i < glyphs.length - 1) x += font.getKerningValue(g, glyphs[i + 1]) * scale;
    });
    widths.push([start, shapes.length, x - spacing]);
  });
  // centre each line (like centred text in OrcaSlicer)
  const maxW = Math.max(0, ...widths.map((w) => w[2]));
  for (const [a, b, w] of widths) {
    const dx = (maxW - w) / 2;
    if (!dx) continue;
    for (let i = a; i < b; i++) {
      shapes[i].getPoints();       // make sure curves exist before moving
      for (const c of shapes[i].curves) for (const k of ["v0", "v1", "v2", "v3"]) if (c[k]) c[k].x += dx;
      for (const h of shapes[i].holes) for (const c of h.curves) for (const k of ["v0", "v1", "v2", "v3"]) if (c[k]) c[k].x += dx;
    }
  }
  if (!shapes.length) throw new Error("there's nothing to make: type some text (letters this font has)");
  let g = new THREE.ExtrudeGeometry(shapes, { depth: Math.max(0.2, +p.depth || 1.5), bevelEnabled: false, curveSegments: 8 });
  g = g.toNonIndexed();
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", g.getAttribute("position").clone());
  g.dispose();
  out.computeBoundingBox();
  const bb = out.boundingBox;
  out.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
  return out;
}

/** An SVG preview of the text in a font (for the dialog). */
export function previewSvg(font, p) {
  const size = 40, lineH = size * (+p.lineSpacing || 1.2), scale = size / Math.max(0.5, +p.size || 10);
  const spacing = (+p.spacing || 0) * scale;
  const lines = String(p.text || "").replace(/\r/g, "").split("\n");
  let d = "", w = 0;
  lines.forEach((line, li) => {
    const glyphs = font.stringToGlyphs(line);
    let x = 0;
    glyphs.forEach((g, i) => {
      d += g.getPath(x, size + li * lineH, size).toPathData(2);
      x += g.advanceWidth * (size / font.unitsPerEm) + spacing;
      if (i < glyphs.length - 1) x += font.getKerningValue(g, glyphs[i + 1]) * (size / font.unitsPerEm);
    });
    w = Math.max(w, x);
  });
  const h = size * 1.25 + (lines.length - 1) * lineH;
  return `<svg viewBox="-4 -4 ${Math.max(40, w) + 8} ${h + 8}" preserveAspectRatio="xMidYMid meet"><path d="${d}" fill="currentColor"/></svg>`;
}

/**
 * Where text placed on a part's face goes: a frame on the face (point, normal), the text's "up" along the face
 * (up the wall for side faces, away from you for top faces). kind "part" sits on the surface (sunk 0.3 mm in so
 * it joins), "negative" / "modifier" go into it.
 */
export function placementMatrix(point, normal, kind, depth) {
  const z = new THREE.Vector3(...normal).normalize();
  const up = Math.abs(z.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  const sink = kind === "part" ? -0.3 : -Math.max(0.2, +depth || 1.5);
  m.multiply(new THREE.Matrix4().makeTranslation(0, 0, sink));
  m.premultiply(new THREE.Matrix4().makeTranslation(...point));
  return m;
}
