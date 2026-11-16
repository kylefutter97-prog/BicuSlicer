// STEP (and IGES) import: the CAD file is turned into a mesh in the browser by OpenCascade, the CAD kernel
// OrcaSlicer's desktop app uses too, compiled to WebAssembly (occt-import-js, LGPL-2.1). The OrcaSlicer CLI can't
// read STEP itself. The server fetches the 7.8 MB reader once and serves it from /ext/occt/; it's only loaded the
// first time a STEP file is opened.

let loading = null;

function loadOcct() {
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/ext/occt/occt-import-js.js";
    s.async = true;
    s.onload = () => {
      // eslint-disable-next-line no-undef
      globalThis.occtimportjs({ locateFile: (name) => `/ext/occt/${name}` }).then(resolve, (e) => { loading = null; reject(e); });
    };
    s.onerror = async () => {
      loading = null;
      let why = "";
      try { const r = await fetch(s.src); if (!r.ok) why = await r.text(); } catch { /* offline */ }
      reject(new Error(why || "Couldn't load the STEP reader (OpenCascade)."));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Mesh detail, like OrcaSlicer's STEP import: how far (mm) the facets may stray from the true surface, and their angle (rad). */
export const STEP_DETAIL = {
  normal: { linearDeflection: 0.05, angularDeflection: 0.35 },
  fine: { linearDeflection: 0.01, angularDeflection: 0.15 },
};

/**
 * Read a STEP or IGES file. Returns { bodies: [{ name, pos: Float32Array (triangle soup, mm) }] }.
 * onStage(text) reports progress ("Loading the STEP reader…", "Converting…").
 */
export async function readStep(buffer, name = "", detail = "normal", onStage = () => {}) {
  const first = !loading;
  onStage(first ? "Loading the STEP reader (OpenCascade, about 8 MB the first time)…" : "Loading the STEP reader…");
  const occt = await loadOcct();
  onStage(`Converting ${name || "the STEP file"}…`);
  await new Promise((r) => setTimeout(r, 20));
  const params = { linearUnit: "millimeter", linearDeflectionType: "absolute_value", ...(STEP_DETAIL[detail] || STEP_DETAIL.normal) };
  const data = new Uint8Array(buffer);
  const res = /\.(iges|igs)$/i.test(name) ? occt.ReadIgesFile(data, params) : occt.ReadStepFile(data, params);
  if (!res?.success) throw new Error("OpenCascade couldn't read this file. Is it a valid STEP file?");
  const bodies = [];
  for (const m of res.meshes || []) {
    const p = m.attributes?.position?.array, idx = m.index?.array;
    if (!p?.length) continue;
    let pos;
    if (idx?.length) {
      pos = new Float32Array(idx.length * 3);
      for (let i = 0; i < idx.length; i++) { const v = idx[i] * 3; pos[i * 3] = p[v]; pos[i * 3 + 1] = p[v + 1]; pos[i * 3 + 2] = p[v + 2]; }
    } else pos = Float32Array.from(p);
    bodies.push({ name: m.name || "", pos });
  }
  if (!bodies.length) throw new Error("This STEP file has no solid bodies to print.");
  return { bodies };
}
