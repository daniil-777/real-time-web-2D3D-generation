// Arch Studio build worker (module worker): loads the Manifold CAD kernel, runs generate(spec), turns every part into
// render arrays (positions, normals with crisp arrises > 30°, indices, instance transforms) and posts them as
// transferable buffers. Exports run here too, from the arrays of the last build, so the page never blocks.
//
// in : { type: 'build', id, spec, edges, ops?, deformOpts? }   ops: deform.js op list applied after generate()
//      { type: 'base', id, spec, deformOpts? }   the undeformed element, refined for the page's GPU preview
//      { type: 'edges', id: buildId }
//      { type: 'export', id, forId: buildId, format: 'glb'|'obj'|'stl', name }
//      { type: 'drawing', id, forId: buildId, meta: { title, interpretation, prompt, date } }   the A3 drawing sheet
// out: { type: 'ready', heapMB }  { type: 'fatal', message }
//      { type: 'built', id, meshes: [{ name, role, material, positions, normals, indices, transforms }], stats }
//      { type: 'base', id, key, meshes: [... + rigid, centre], bbox, shaftBox, edge, tris, ms }
//      { type: 'edges', id: buildId, edges: [Float32Array per mesh] }   (always for the model this worker holds)
//      { type: 'exported', id, format, buffers: [ArrayBuffer…], mime }
//      { type: 'drawing', id, sheet }   (drawing.js makeSheet(): line groups, items, scale, measured openings)
//      { type: 'error', id, message, code: 'stale' | 'kernel' | undefined, heapMB, builds }

import { setKernel, partsBBox, instanceCount } from './kernel.js';
import { generate, family } from './generate.js';
import { partMesh, featureEdges, toGLB, toOBJParts, toSTL, RIGID_RATIO, isRigidPart, frameScale } from './export.js';
import { deformParts } from './deform.js';

const MANIFOLD = 'https://cdn.jsdelivr.net/npm/manifold-3d@3.5.4/manifold.js';
const MANIFOLD_WASM = 'https://cdn.jsdelivr.net/npm/manifold-3d@3.5.4/manifold.wasm';
// the kernel's WebAssembly (540 KB) is requested the moment this worker starts, in parallel with Manifold's JS (which
// would otherwise ask for it only once it has loaded); a document <link rel=preload> could not serve a worker's fetch
const wasmResponse = fetch(MANIFOLD_WASM, { credentials: 'same-origin' });
wasmResponse.catch(() => {});

// WebAssembly memory never shrinks, and generators leave temporaries behind: the page recycles this worker (a fresh
// Manifold instance) when the heap grows large or after a number of builds. The heap is found by watching the
// instantiation (Manifold exports its memory but does not expose it on the module object; there is no HEAPU8).
let memory = null;
const watch = (fn) => async (...args) => {
  const r = await fn(...args);
  const inst = r && r.instance ? r.instance : r;
  for (const v of Object.values((inst && inst.exports) || {})) if (v instanceof WebAssembly.Memory) memory = v;
  return r;
};
if (WebAssembly.instantiateStreaming) WebAssembly.instantiateStreaming = watch(WebAssembly.instantiateStreaming.bind(WebAssembly));
WebAssembly.instantiate = watch(WebAssembly.instantiate.bind(WebAssembly));
const heapMB = () => (memory ? Math.round(memory.buffer.byteLength / 1048576) : 0);

// cold-start timeline, in epoch ms (the page subtracts its own timeOrigin): worker started, Manifold's JS imported,
// WASM fetched + compiled + instantiated, set up
const epoch = () => performance.timeOrigin + performance.now();
const boot = { start: epoch() };
const kernel = (async () => {
  const { default: Module } = await import(MANIFOLD);
  boot.imported = epoch();
  // compile from the early response (streaming); Emscripten's own fetch is the fallback
  const instantiateWasm = (imports, receive) => {
    wasmResponse.then((res) => WebAssembly.instantiateStreaming(res, imports))
      .catch(() => fetch(MANIFOLD_WASM).then((r) => r.arrayBuffer()).then((b) => WebAssembly.instantiate(b, imports)))
      .then((r) => receive(r.instance, r.module), (e) => post({ type: 'fatal', message: 'the CAD kernel could not load: ' + msg(e) }));
    return {};
  };
  const wasm = await Module({ instantiateWasm });
  boot.instantiated = epoch();
  wasm.setup();
  setKernel(wasm);
  boot.ready = epoch();
  return wasm;
})();
kernel.then(() => post({ type: 'ready', heapMB: heapMB(), boot }), (e) => post({ type: 'fatal', message: 'the CAD kernel could not load: ' + msg(e) }));

let last = null; // { id, meshes, spec } of the last build, for edges and exports (plain arrays, no kernel objects)
let builds = 0;
// The undeformed element of the last spec, kept so a deformation change (a slider release) re-deforms it without
// regenerating: { key, parts, r (generate result), bbox (solid), shaftBox }. Its manifolds are freed when the spec changes.
let cache = null;
let queue = Promise.resolve();
let buildsWaiting = 0;        // build requests queued behind the current job (a preview-geometry job yields to them)
self.onmessage = (e) => {
  const m = e.data;
  // warm-up: import a generator module right away, in parallel with the kernel's download and compilation
  if (m && m.type === 'warm') {
    const t = performance.now();
    family(m.element).then(() => post({ type: 'warmed', element: m.element, ms: performance.now() - t, at: epoch() }), () => {});
    return;
  }
  if (m && m.type === 'build') buildsWaiting++;
  queue = queue.then(() => handle(m)).finally(() => { if (m && m.type === 'build') buildsWaiting--; });
};

// errors that mean the WASM instance itself is unwell (the page then recycles the worker), not a bad request
const KERNEL_ERR = /abort|RuntimeError|unreachable|out of bounds|memory|deleted object|BindingError|table index|null function|stack/i;

async function handle(m) {
  try {
    await kernel;
    if (m.type === 'build') await build(m);
    else if (m.type === 'base') await base(m);
    else if (m.type === 'edges') edges(m.id);
    else if (m.type === 'export') exportAs(m);
    else if (m.type === 'drawing') await drawing(m);
  } catch (e) {
    post({ type: 'error', id: m.id, message: msg(e), code: e.code || (KERNEL_ERR.test(msg(e)) ? 'kernel' : undefined),
      heapMB: heapMB(), builds, stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join('\n') : '' });
  }
}

/** The undeformed element for spec: from the cache, or generated (and cached; the previous one is freed). */
async function element(spec) {
  const key = JSON.stringify(spec || {});
  if (cache && cache.key === key) return cache;
  const t0 = performance.now();
  builds++;                     // every generation counts (a throwing one leaves its temporaries too), once
  // the generator module, timed apart from the build; an unknown element is left to generate(), which normalises it
  // (a column, with a warning)
  await family((spec && spec.element) || 'column').catch(() => {});
  const tImport = performance.now() - t0;
  const r = await generate(spec || {});
  if (!r.parts || !r.parts.length || !r.tris) {
    freeParts(r.parts || []);
    throw new Error(`the ${r.spec.element} generator returned no geometry`);
  }
  if (cache) freeParts(cache.parts);
  const solid = r.parts.filter((p) => p.manifold.numTri() > 0);
  const shafts = solid.filter((p) => p.name === 'shaft');
  cache = { key, parts: r.parts, r, bbox: partsBBox(solid), shaftBox: shafts.length ? partsBBox(shafts) : null, genMs: performance.now() - t0,
    importMs: tImport, fresh: true };
  return cache;
}

const DEFORM_DEFAULTS = { rigidInstances: true, rigidRatio: RIGID_RATIO };

async function build(m) {
  const t0 = performance.now();
  const el = await element(m.spec);
  const r = el.r, fresh = el.fresh;
  el.fresh = false;
  let parts = el.parts, deform = null, meshes, t2, t3;
  try {
    if (Array.isArray(m.ops) && m.ops.length) {
      const opts = { ...DEFORM_DEFAULTS, ...(m.deformOpts || {}), bbox: el.bbox };
      // a lean is given in fractions of the element's height (the page cannot know it before the element is built)
      const H = el.bbox.max[2] - el.bbox.min[2];
      const ops = m.ops.map((o) => (o && o.lean ? { type: o.type, axis: o.axis, dx: o.lean[0] * H, dy: o.lean[1] * H } : o));
      const d = deformParts(el.parts, ops, opts);   // if it throws, it has freed what it made
      parts = d.parts;
      deform = { ops: d.ops, warnings: d.warnings, ms: d.stats.ms, tris: d.stats.tris, edge: d.stats.edge, ground: d.stats.ground,
        rigid: d.stats.rigid, warped: d.stats.warped, folds: d.stats.folds, minDet: d.stats.minDet, timing: d.stats.timing,
        identity: d.deformer.identity };
    }
    t2 = performance.now();
    meshes = parts.map((p) => partMesh(p, r.spec));
    t3 = performance.now();
  } finally {
    // ownership by identity, not by tags: every manifold of the result that is not one of the cached element's own was
    // made for this build (warped pieces) and is freed here, also when extracting the meshes threw
    if (parts !== el.parts) {
      const owned = new Set(el.parts.map((p) => p.manifold));
      freeParts(parts.filter((p) => !owned.has(p.manifold)));
    }
  }
  last = { id: m.id, meshes, spec: r.spec, deform: deform ? deform.ops : null };
  const transfer = [];
  const copy = (a) => { if (!a) return null; const c = a.slice(); transfer.push(c.buffer); return c; };
  const out = meshes.map((x) => ({ name: x.name, role: x.role, material: x.material, positions: copy(x.positions), normals: copy(x.normals),
    indices: copy(x.indices), transforms: copy(x.transforms), rigidTag: x.rigidTag }));
  const bbox = deform ? meshBBox(meshes) : r.bbox;
  const size = [0, 1, 2].map((k) => bbox.max[k] - bbox.min[k]);
  const stats = {
    tris: meshes.reduce((n, x) => n + (x.indices.length / 3) * (x.transforms ? x.transforms.length / 16 : 1), 0),
    parts: parts.length, instances: parts.reduce((n, p) => n + instanceCount(p), 0),
    ms: fresh ? r.ms : 0, deformMs: deform ? deform.ms : 0, meshMs: t3 - t2, totalMs: t3 - t0, cached: !fresh,
    importMs: fresh ? el.importMs : 0, genMs: fresh ? el.genMs : 0, workerStart: m.sentAt ? epoch() - (performance.now() - t0) - m.sentAt : undefined,
    size, bbox, warnings: r.warnings, spec: r.spec, expected: r.expected, heapMB: heapMB(), builds,
    element: { bbox: el.bbox, size: [0, 1, 2].map((k) => el.bbox.max[k] - el.bbox.min[k]), shaftBox: el.shaftBox, key: el.key },
    deform,
  };
  post({ type: 'built', id: m.id, meshes: out, stats }, transfer);
  if (m.edges) edges(m.id);
}

/** Bounding box of render meshes (instances applied): the deformed element's true extent. */
function meshBBox(meshes) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const x of meshes) {
    const P = x.positions, T = x.transforms, n = T ? T.length / 16 : 1;
    if (!P.length) continue;
    // local box of the mesh, then its 8 corners through every instance (exact for the box, tight for these meshes)
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { if (P[i + a] < lo[a]) lo[a] = P[i + a]; if (P[i + a] > hi[a]) hi[a] = P[i + a]; }
    for (let k = 0; k < n; k++) {
      if (!T) { for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], lo[a]); max[a] = Math.max(max[a], hi[a]); } continue; }
      const M = T.subarray(16 * k, 16 * k + 16);
      for (let c = 0; c < 8; c++) {
        const x0 = c & 1 ? hi[0] : lo[0], y0 = c & 2 ? hi[1] : lo[1], z0 = c & 4 ? hi[2] : lo[2];
        const q = [M[0] * x0 + M[4] * y0 + M[8] * z0 + M[12], M[1] * x0 + M[5] * y0 + M[9] * z0 + M[13], M[2] * x0 + M[6] * y0 + M[10] * z0 + M[14]];
        for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], q[a]); max[a] = Math.max(max[a], q[a]); }
      }
    }
  }
  return { min, max };
}

/**
 * The undeformed element for the page's GPU preview. The page deforms these meshes in a vertex shader while a slider or
 * a lattice handle moves, so long edges are split first (a 3 m rail is otherwise one box whose bent image would be a
 * straight chord): every edge of a part that the bake would warp gets at most l = L / 40 (L the largest extent), or
 * the coarsest l that keeps the whole preview under 1.2 M triangles. Parts the bake keeps rigid (the same rule as
 * deformParts: >= 2 instances, smaller than rigidRatio of the element's diagonal) are sent as they are, with the
 * centre of their mesh box: the page moves them by the same instance formula on the CPU.
 */
async function base(m) {
  const t0 = performance.now();
  // the preview geometry is a convenience: a build waiting behind it goes first (the page asks again later)
  if (buildsWaiting > 0) throw Object.assign(new Error('a build is waiting'), { code: 'busy' });
  const el = await element(m.spec);
  const o = { ...DEFORM_DEFAULTS, ...(m.deformOpts || {}) };
  const ext = [0, 1, 2].map((k) => el.bbox.max[k] - el.bbox.min[k]), L = Math.max(...ext), diag = Math.hypot(...ext);
  const plan = el.parts.map((p) => {
    const n = instanceCount(p), bb = p.manifold.boundingBox(), M = p.transforms ? p.transforms.subarray(0, 16) : null;
    const sc = frameScale(M), empty = !(p.manifold.numTri() > 0);
    const rigid = isRigidPart({ instances: p.transforms ? n : 1, scale: sc, elementDiag: diag, enabled: o.rigidInstances, empty,
      tag: p.meta && p.meta.rigid, localDiag: Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) });
    const mesh = partMesh(p, el.r.spec);
    // per triangle: longest edge and area (local), for the refinement prediction
    const P = mesh.positions, T = mesh.indices, nt = T.length / 3, tri = new Float64Array(2 * nt);
    let emax = 0;
    for (let t = 0; t < nt; t++) {
      const a = 3 * T[3 * t], b = 3 * T[3 * t + 1], c = 3 * T[3 * t + 2];
      const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const w = [P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]];
      const e = Math.sqrt(Math.max(u[0] ** 2 + u[1] ** 2 + u[2] ** 2, v[0] ** 2 + v[1] ** 2 + v[2] ** 2, w[0] ** 2 + w[1] ** 2 + w[2] ** 2));
      tri[2 * t] = e; tri[2 * t + 1] = 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
      if (e > emax) emax = e;
    }
    return { p, n, sc, bb, rigid, empty, mesh, tri, nt, emax };
  });
  const predict = (q, l) => {
    if (q.rigid || q.empty || q.emax * q.sc <= l) return q.nt * q.n;
    let k = 0;
    const s = q.sc / l, s2 = 2.31 * s * s;
    for (let t = 0; t < q.nt; t++) k += Math.max(1, Math.ceil(q.tri[2 * t] * s), q.tri[2 * t + 1] * s2);
    return k * q.n;
  };
  const total = (l) => plan.reduce((acc, q) => acc + predict(q, l), 0);
  const BUDGET = 1.2e6;
  let ell = L / 40;
  if (total(ell) > BUDGET) {
    let lo = ell, hi = Math.max(L, ...plan.map((q) => q.emax * q.sc));
    if (total(hi) > BUDGET) ell = 0;
    else {
      for (let k = 0; k < 20; k++) { const mid = Math.sqrt(lo * hi); if (total(mid) > BUDGET) lo = mid; else hi = mid; }
      ell = hi;
    }
  }
  const meshes = plan.map((q) => {
    let mesh = q.mesh;
    if (ell > 0 && !q.rigid && !q.empty && q.emax * q.sc > ell) {
      const fine = q.p.manifold.refineToLength(ell / q.sc);
      try { mesh = partMesh({ ...q.p, manifold: fine }, el.r.spec); } finally { fine.delete(); }
    }
    const c = [0, 1, 2].map((k) => (q.bb.min[k] + q.bb.max[k]) / 2);
    return { ...mesh, rigid: q.rigid, centre: c };
  });
  const transfer = [];
  const copy = (a) => { if (!a) return null; const c = a.slice(); transfer.push(c.buffer); return c; };
  const out = meshes.map((x) => ({ name: x.name, role: x.role, material: x.material, positions: copy(x.positions), normals: copy(x.normals),
    indices: copy(x.indices), transforms: copy(x.transforms), rigid: x.rigid, centre: x.centre, rigidTag: x.rigidTag }));
  const tris = meshes.reduce((n, x) => n + (x.indices.length / 3) * (x.transforms ? x.transforms.length / 16 : 1), 0);
  post({ type: 'base', id: m.id, key: el.key, meshes: out, bbox: el.bbox, shaftBox: el.shaftBox, edge: ell, tris,
    ms: performance.now() - t0 }, transfer);
}

/** delete() every part manifold once (two parts may share one); a generator that kept one for later would fail on
 *  its next build with a "deleted object" error, which makes the page recycle the worker and retry. */
function freeParts(parts) {
  const seen = new Set();
  for (const p of parts) {
    const m = p.manifold;
    if (!m || seen.has(m) || typeof m.delete !== 'function') continue;
    seen.add(m);
    try { m.delete(); } catch (e) { /* already deleted */ }
  }
}

/** Feature edges of the model this worker holds, answered with its build id (the page applies them only to that
 *  build); a request for another build is ignored: that build is either gone or will ask again once it is shown. */
function edges(id) {
  if (!last || (id !== undefined && id !== last.id)) return;
  const list = last.meshes.map((x) => featureEdges(x, 30));
  post({ type: 'edges', id: last.id, edges: list }, list.map((a) => a.buffer));
}

const stale = () => Object.assign(new Error('the model on screen is not the one this worker holds'), { code: 'stale' });

/** Export the model on screen: forId must be the build the page shows, or the answer is a 'stale' error. */
function exportAs(m) {
  if (!last || (m.forId !== undefined && m.forId !== last.id)) throw stale();
  const name = m.name || last.spec.element;
  let buffers, mime;
  if (m.format === 'glb') {
    buffers = [toGLB(last.meshes, { name, extras: { spec: last.spec, ...(last.deform ? { deform: last.deform } : {}), generator: 'Arch Studio' } })];
    mime = 'model/gltf-binary';
  }
  else if (m.format === 'obj') {
    // chunk by chunk: a large model never becomes one giant string
    const enc = new TextEncoder();
    buffers = toOBJParts(last.meshes, { name }).map((t) => enc.encode(t).buffer);
    mime = 'text/plain';
  } else if (m.format === 'stl') { buffers = [toSTL(last.meshes, { name })]; mime = 'model/stl'; }
  else throw new Error('unknown export format ' + m.format);
  post({ type: 'exported', id: m.id, format: m.format, buffers, mime }, buffers);
}

/**
 * The drawing sheet of the model on screen (elevations, plan, dimensions, title strip: drawing.js), computed here so
 * the page never blocks. The generator's own arithmetic dimensions the element (column parts, portico axes, roof
 * pitches; arches and openings are measured on the model against arch.js's intrados).
 */
const OPENING_FAMILIES = new Set(['arch', 'arcade', 'window', 'door']);
async function drawing(m) {
  if (!last || (m.forId !== undefined && m.forId !== last.id)) throw stale();
  const D = await import('./drawing.js');
  const el = last.spec.element;
  let gen = null;
  try {
    gen = { ...(await family(el)) };
    if (OPENING_FAMILIES.has(el) && !gen.archGeom) gen.archGeom = (await family('arch')).archGeom;
  } catch (e) { gen = null; }
  const sheet = D.makeSheet({ meshes: last.meshes, spec: last.spec, deform: last.deform, gen, meta: m.meta || {} });
  const transfer = [];
  for (const g of sheet.groups) transfer.push(g.pts.buffer, g.starts.buffer);
  for (const it of sheet.items) {
    if (it.t === 'area') for (const l of it.loops) transfer.push(l.buffer);
    else if (it.t === 'path') transfer.push(it.pts.buffer, it.starts.buffer);
  }
  post({ type: 'drawing', id: m.id, sheet }, [...new Set(transfer)]);
}

function post(m, transfer = []) { self.postMessage(m, transfer); }
function msg(e) { return e && e.message ? e.message : String(e); }
