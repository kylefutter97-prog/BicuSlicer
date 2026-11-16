// Calibration tests, OrcaSlicer-style, built from what the OrcaSlicer CLI honours: models made here (boxes, towers,
// vases), per-part settings, height ranges, negative parts, and G-code at given heights (the 3MF's
// custom_gcode_per_layer.xml). Each test is a "plan" the page turns into a plate; pure data, so it runs under Node.
//
// plan = { name, plate: { name, spiral }, parts: [{ name, pos (triangle soup, plate mm, z from 0), overrides,
//          volumes: [{ kind, shape, size: [x,y,z], center: [x,y,z] }], ranges: [{ from, to, overrides }] }],
//          gcodes: [{ z, type: "custom", gcode, note }], legend: [text], result: { ... } }

/* ---------------------------------------------------------------- shapes (triangle soups, outward facing) */

function orient(tris, cx, cy, cz) {
  // make every triangle of a convex piece face away from its centre
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i + 3] - tris[i], ay = tris[i + 4] - tris[i + 1], az = tris[i + 5] - tris[i + 2];
    const bx = tris[i + 6] - tris[i], by = tris[i + 7] - tris[i + 1], bz = tris[i + 8] - tris[i + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const mx = (tris[i] + tris[i + 3] + tris[i + 6]) / 3 - cx, my = (tris[i + 1] + tris[i + 4] + tris[i + 7]) / 3 - cy, mz = (tris[i + 2] + tris[i + 5] + tris[i + 8]) / 3 - cz;
    if (nx * mx + ny * my + nz * mz < 0) for (let k = 0; k < 3; k++) { const t = tris[i + 3 + k]; tris[i + 3 + k] = tris[i + 6 + k]; tris[i + 6 + k] = t; }
  }
  return tris;
}

export function box(x0, y0, z0, x1, y1, z1) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return orient(f.flatMap((t) => t.flatMap((i) => v[i])), (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
}

/** A prism: polygon [[x, z], ...] (convex, in the XZ plane) pushed from y0 to y1. */
export function prismXZ(poly, y0, y1) {
  const out = [];
  const n = poly.length;
  for (let i = 1; i < n - 1; i++) {
    out.push(poly[0][0], y0, poly[0][1], poly[i][0], y0, poly[i][1], poly[i + 1][0], y0, poly[i + 1][1]);
    out.push(poly[0][0], y1, poly[0][1], poly[i][0], y1, poly[i][1], poly[i + 1][0], y1, poly[i + 1][1]);
  }
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    out.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y0, a[1], b[0], y1, b[1], a[0], y1, a[1]);
  }
  const cx = poly.reduce((s, p) => s + p[0], 0) / n, cz = poly.reduce((s, p) => s + p[1], 0) / n;
  return orient(out, cx, (y0 + y1) / 2, cz);
}

export function cylinder(cx, cy, r, z0, z1, seg = 96) {
  const out = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * 2 * Math.PI, a1 = ((i + 1) / seg) * 2 * Math.PI;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    out.push(cx, cy, z0, x1, y1, z0, x0, y0, z0, cx, cy, z1, x0, y0, z1, x1, y1, z1);
    out.push(x0, y0, z0, x1, y1, z0, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y0, z1);
  }
  return orient(out, cx, cy, (z0 + z1) / 2);
}

const join = (...pieces) => { const n = pieces.reduce((s, p) => s + p.length, 0), out = new Float32Array(n); let o = 0; for (const p of pieces) { out.set(p, o); o += p.length; } return out; };

/* ---------------------------------------------------------------- helpers */

/** Top of the first layer that starts at or above z, on a uniform layer grid (where per-height G-code goes). */
export function layerTopAbove(z, first, lh) {
  if (z <= 1e-9) return +first.toFixed(3);
  const n = Math.max(0, Math.ceil((z - first) / lh - 1e-6));
  return +(first + (n + 1) * lh).toFixed(3);
}

export function steps(start, end, step) {
  const s = Math.abs(step) || 1, dir = end >= start ? 1 : -1, out = [];
  for (let v = start, i = 0; dir > 0 ? v <= end + 1e-9 : v >= end - 1e-9; v = start + dir * s * ++i) {
    out.push(+v.toFixed(6));
    if (out.length > 200) break;
  }
  return out;
}

const PA_GCODE = {
  klipper: (v) => `SET_PRESSURE_ADVANCE ADVANCE=${v}`,
  reprapfirmware: (v) => `M572 D0 S${v}`,
};
export const paCommand = (flavor, v) => (PA_GCODE[flavor] || ((x) => `M900 K${x}`))(v);

/* ---------------------------------------------------------------- the tests */

export const TESTS = {
  temperature: {
    title: "Temperature tower",
    about: "One block per temperature, hottest at the bottom. Each block has a bridge, an overhang and a gap for stringing: pick the block that looks best.",
    params: [{ key: "start", label: "Bottom block", unit: "°C", def: 230, step: 5 }, { key: "end", label: "Top block", unit: "°C", def: 190, step: 5 },
      { key: "step", label: "Change per block", unit: "°C", def: 5, step: 1, min: 1 }],
    defaults: (ctx) => { const t = ctx.nozzleTemp || 220; return { start: t + 15, end: t - 15, step: 5 }; },
  },
  flow: {
    title: "Flow ratio",
    about: "Square tiles printed with slightly different flow. Pick the one whose top surface is smoothest, without gaps or ridges. Do the coarse pass first, then the fine one.",
    params: [{ key: "pass", label: "Pass", choices: [["1", "Coarse: −20% to +20%"], ["2", "Fine: −4% to +4%"]], def: "1" }],
    defaults: () => ({ pass: "1" }),
  },
  pa: {
    title: "Pressure advance",
    about: "A thin square tower whose pressure advance rises every millimetre. Find the height where the corners are sharpest without gaps.",
    params: [{ key: "start", label: "Start", def: 0, step: 0.001 }, { key: "end", label: "End", def: 0.08, step: 0.001 },
      { key: "step", label: "Change per mm", def: 0.002, step: 0.0005, min: 0.0001 }],
    defaults: (ctx) => (ctx.bowden ? { start: 0, end: 1, step: 0.02 } : { start: 0, end: 0.08, step: 0.002 }),
  },
  volumetric: {
    title: "Max flow (volumetric speed)",
    about: "A vase whose speed rises every millimetre. Note the height where the walls start to fail (gaps, weak or rough layers).",
    params: [{ key: "start", label: "Start", unit: "mm³/s", def: 5, step: 0.5 }, { key: "end", label: "End", unit: "mm³/s", def: 25, step: 0.5 },
      { key: "step", label: "Change per mm", unit: "mm³/s", def: 0.5, step: 0.1, min: 0.1 }],
    defaults: () => ({ start: 5, end: 25, step: 0.5 }),
  },
  vfa: {
    title: "Speed vs. wall artefacts (VFA)",
    about: "A vase in 5 mm bands of rising outer-wall speed. Look for bands with fine vertical lines (VFA) and avoid those speeds.",
    params: [{ key: "start", label: "Start", unit: "mm/s", def: 40, step: 10 }, { key: "end", label: "End", unit: "mm/s", def: 200, step: 10 },
      { key: "step", label: "Change per band", unit: "mm/s", def: 20, step: 5, min: 1 }],
    defaults: () => ({ start: 40, end: 200, step: 20 }),
  },
  tolerance: {
    title: "Tolerance",
    about: "A bar with square holes from 10.0 mm upwards and a 10 mm peg. The tightest hole the peg slides into is your clearance.",
    params: [{ key: "max", label: "Largest extra", unit: "mm", def: 0.5, step: 0.05 }, { key: "step", label: "Step", unit: "mm", def: 0.1, step: 0.05, min: 0.01 }],
    defaults: () => ({ max: 0.5, step: 0.1 }),
  },
};

/**
 * Build a test. ctx: { first, layer (mm), nozzle, flavor (gcode_flavor), bed: { w, d }, flowRatio, nozzleTemp }.
 * Returns a plan (see the top of this file).
 */
export function buildTest(id, p, ctx) {
  const { first, layer: lh, bed } = ctx;
  const cx = bed.w / 2, cy = bed.d / 2;
  if (id === "temperature") {
    const temps = steps(+p.start, +p.end, +p.step);
    const B = 10, base = 1;            // 10 mm blocks on a 1 mm base
    const pieces = [box(-8, -2, 0, 48, 12, base)];
    temps.forEach((_, i) => {
      const z0 = base + i * B;
      pieces.push(box(0, 0, z0, 8, 10, z0 + B));                   // left pillar
      pieces.push(box(32, 0, z0, 40, 10, z0 + B));                 // right pillar
      pieces.push(box(8, 0, z0 + B - 1.6, 32, 10, z0 + B));        // bridge between them (and the gap under it: stringing)
      pieces.push(prismXZ([[0, z0 + 3], [0, z0 + B], [-6, z0 + B]], 0, 10));   // 45°-ish overhang on the left
      pieces.push(box(16, 4, z0, 20, 6, z0 + B - 1.6));            // a thin spike under the bridge
    });
    const height = base + temps.length * B;
    return {
      name: `Temperature tower ${temps[0]}–${temps[temps.length - 1]} °C`,
      plate: { name: "Temperature tower", spiral: "" },
      parts: [{ name: "Temperature tower", pos: join(...pieces), xy: [cx, cy], overrides: { enable_support: "0" } }],
      gcodes: temps.map((t, i) => ({ z: layerTopAbove(base + i * B, first, lh), type: "custom", gcode: `M104 S${t}`, note: `Block ${i + 1}: ${t} °C` })),
      legend: [`${temps.length} blocks of ${B} mm, ${height} mm tall`, ...temps.map((t, i) => `Block ${i + 1}${i === 0 ? " (bottom)" : i === temps.length - 1 ? " (top)" : ""}: ${t} °C`)],
      result: { kind: "temperature", choices: temps.map((t, i) => [String(t), `Block ${i + 1}: ${t} °C`]) },
    };
  }
  if (id === "flow") {
    const offs = p.pass === "2" ? steps(-4, 4, 1) : steps(-20, 20, 5);
    const T = 20, G = 5, cols = 3, H = Math.max(2, +(first + 9 * lh).toFixed(2));
    const parts = offs.map((o, k) => {
      const col = k % cols, row = Math.floor(k / cols);
      const pieces = [box(0, 0, 0, T, T, H)];
      if (k === 0) pieces.push(prismXZ([[0, 0], [5, 0], [0, H]], -3, 0));   // marks tile 1 (front left)
      return { name: `Flow ${o > 0 ? "+" : o < 0 ? "−" : "±"}${Math.abs(o)}%`, pos: join(...pieces),
        xy: [cx + (col - (cols - 1) / 2) * (T + G), cy + (row - (Math.ceil(offs.length / cols) - 1) / 2) * (T + G)],
        overrides: { print_flow_ratio: String(+(1 + o / 100).toFixed(3)), top_shell_layers: "5", top_surface_pattern: "monotonic",
          ironing_type: "no ironing", sparse_infill_density: "35%", enable_support: "0" } };
    });
    return {
      name: `Flow ratio, ${p.pass === "2" ? "fine" : "coarse"} pass`,
      plate: { name: `Flow ratio pass ${p.pass === "2" ? 2 : 1}`, spiral: "" },
      parts, gcodes: [],
      legend: ["Tiles in rows of three from the front left (tile 1 has a little ramp on its front edge):",
        ...offs.map((o, k) => `Tile ${k + 1}: ${o > 0 ? "+" : ""}${o}%`)],
      result: { kind: "flow", choices: offs.map((o, k) => [String(o), `Tile ${k + 1}: ${o > 0 ? "+" : ""}${o}%`]) },
    };
  }
  if (id === "pa") {
    const vals = steps(+p.start, +p.end, +p.step);
    const H = vals.length + 1, S = 40, w = 1.6;
    const pos = join(box(0, 0, 0, S, w, H), box(0, S - w, 0, S, S, H), box(0, 0, 0, w, S, H), box(S - w, 0, 0, S, S, H));
    return {
      name: `Pressure advance ${vals[0]}–${vals[vals.length - 1]}`,
      plate: { name: "Pressure advance tower", spiral: "" },
      parts: [{ name: "PA tower", pos, xy: [cx, cy], overrides: { wall_loops: "2", sparse_infill_density: "0%", top_shell_layers: "0",
        bottom_shell_layers: "3", seam_position: "back", enable_support: "0" } }],
      gcodes: vals.map((v, i) => ({ z: layerTopAbove(i, first, lh), type: "custom", gcode: paCommand(ctx.flavor, v), note: `${i} mm: ${v}` })),
      legend: [`Pressure advance ${vals[0]} at the bottom, +${p.step} every mm, ${vals[vals.length - 1]} at ${vals.length - 1} mm`,
        `Command: ${paCommand(ctx.flavor, "…")} (${ctx.flavor || "marlin"} firmware)`],
      result: { kind: "pa", start: +p.start, step: +p.step, max: vals[vals.length - 1] },
    };
  }
  if (id === "volumetric") {
    const flows = steps(+p.start, +p.end, +p.step);
    const width = +((ctx.nozzle || 0.4) * 1.2).toFixed(2);
    const v0 = +(flows[0] / (lh * width)).toFixed(1);
    const H = flows.length + 2, R = 40;
    return {
      name: `Max flow ${flows[0]}–${flows[flows.length - 1]} mm³/s`,
      plate: { name: "Max flow vase", spiral: "1" },
      parts: [{ name: "Max flow vase", pos: cylinder(0, 0, R, 0, H), xy: [cx, cy], overrides: { outer_wall_speed: String(v0), outer_wall_line_width: String(width), enable_support: "0" } }],
      gcodes: flows.map((f, i) => ({ z: layerTopAbove(1 + i, first, lh), type: "custom", gcode: `M220 S${Math.round((100 * f) / flows[0])}`, note: `${1 + i} mm: ${f} mm³/s` })),
      legend: [`Walls ${width} mm wide at ${v0} mm/s = ${flows[0]} mm³/s from 1 mm; +${p.step} mm³/s every mm (firmware speed factor, M220), ${flows[flows.length - 1]} mm³/s at ${flows.length} mm.`,
        "Your filament's max volumetric speed and its slow-down for layer cooling also limit the speed: raise them for this test if the print looks slower than expected."],
      result: { kind: "volumetric", start: flows[0], step: +p.step, from: 1, max: flows[flows.length - 1] },
    };
  }
  if (id === "vfa") {
    const speeds = steps(+p.start, +p.end, +p.step);
    const band = 5, H = speeds.length * band, S = 30;
    return {
      name: `Wall artefacts ${speeds[0]}–${speeds[speeds.length - 1]} mm/s`,
      plate: { name: "VFA tower", spiral: "1" },
      parts: [{ name: "VFA tower", pos: box(0, 0, 0, S, S, H), xy: [cx, cy], overrides: { enable_support: "0" },
        ranges: speeds.map((v, i) => ({ from: i * band, to: (i + 1) * band, overrides: { layer_height: String(lh), outer_wall_speed: String(v) } })) }],
      gcodes: [],
      legend: [...speeds.map((v, i) => `${i * band}–${(i + 1) * band} mm: ${v} mm/s`),
        ...(ctx.maxVol > 0 && speeds[speeds.length - 1] > ctx.maxVol / (lh * (ctx.nozzle || 0.4) * 1.125)
          ? [`Note: your filament's max volumetric speed (${ctx.maxVol} mm³/s) caps walls at about ${Math.round(ctx.maxVol / (lh * (ctx.nozzle || 0.4) * 1.125))} mm/s, so faster bands print at that speed. Raise it for this test to see them all.`] : [])],
      result: null,
    };
  }
  if (id === "tolerance") {
    const extras = steps(0, +p.max, +p.step);
    const hole = 10, gap = 4, L = extras.length * (hole + +p.max + gap) + gap, W = 18, H = 6;
    let x = gap;
    const volumes = extras.map((e) => {
      const s = hole + e, c = [x + s / 2 - L / 2, 0, H / 2];
      x += hole + +p.max + gap;
      return { kind: "negative", shape: "box", size: [s, s, H + 2], center: c };
    });
    return {
      name: `Tolerance 0–${p.max} mm`,
      plate: { name: "Tolerance test", spiral: "" },
      parts: [
        { name: "Tolerance bar", pos: box(-L / 2, -W / 2, 0, L / 2, W / 2, H), xy: [cx, cy - 12], overrides: { enable_support: "0" }, volumes },
        { name: "Peg 10 mm", pos: box(-hole / 2, -hole / 2, 0, hole / 2, hole / 2, 12), xy: [cx, cy + 16], overrides: { enable_support: "0" } },
      ],
      gcodes: [],
      legend: [`Holes from the left: ${extras.map((e) => `${(hole + e).toFixed(2)} mm`).join(", ")}`],
      result: null,
    };
  }
  throw new Error(`unknown test ${id}`);
}

/** What a result means for the filament settings (unsaved edits), with a sentence saying so. */
export function resultEdits(result, answer, ctx) {
  if (!result) return null;
  if (result.kind === "temperature") return { edits: { nozzle_temperature: [String(answer)] }, text: `Nozzle temperature ${answer} °C` };
  if (result.kind === "flow") {
    const v = +((ctx.flowRatio || 1) * (1 + +answer / 100)).toFixed(3);
    return { edits: { filament_flow_ratio: [String(v)] }, text: `Flow ratio ${ctx.flowRatio || 1} → ${v}` };
  }
  if (result.kind === "pa") {
    const v = +Math.min(result.max, result.start + Math.floor(+answer + 1e-9) * result.step).toFixed(4);
    return { edits: { enable_pressure_advance: ["1"], pressure_advance: [String(v)] }, text: `Pressure advance ${v}` };
  }
  if (result.kind === "volumetric") {
    const v = +Math.min(result.max, Math.max(result.start, result.start + Math.floor(+answer - result.from + 1e-9) * result.step)).toFixed(2);
    const safe = +(v * 0.9).toFixed(1);
    return { edits: { filament_max_volumetric_speed: [String(safe)] }, text: `Max volumetric speed ${safe} mm³/s (90% of the ${v} mm³/s where it failed)` };
  }
  return null;
}

/** custom_gcode_per_layer.xml for one plate. */
export function customGcodeXml(items) {
  if (!items?.length) return "";
  const a = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "&#10;");
  const rows = [...items].sort((x, y) => x.z - y.z).map((g) => g.type === "pause"
    ? `<layer top_z="${g.z}" type="1" extruder="1" color="" extra="" gcode=""/>`
    : `<layer top_z="${g.z}" type="4" extruder="1" color="" extra="${a(g.gcode)}" gcode="${a(g.gcode)}"/>`);
  return `<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n<plate>\n<plate_info id="1"/>\n${rows.join("\n")}\n<mode value="SingleExtruder"/>\n</plate>\n</custom_gcodes_per_layer>\n`;
}
