// Arch Studio build worker (module worker): loads the Manifold CAD kernel, runs generate(spec), turns every part into
// render arrays (positions, normals with crisp arrises > 30°, indices, instance transforms) and posts them as
// transferable buffers. Exports run here too, from the arrays of the last build, so the page never blocks.
//
// in : { type: 'build', id, spec, edges }  { type: 'edges', id }  { type: 'export', id, format: 'glb'|'obj'|'stl', name }
// out: { type: 'ready', heapMB }  { type: 'fatal', message }
//      { type: 'built', id, meshes: [{ name, role, material, positions, normals, indices, transforms }], stats }
//      { type: 'edges', id, edges: [Float32Array per mesh] }  { type: 'exported', id, format, buffer, mime }
//      { type: 'error', id, message }

import { setKernel } from './kernel.js';
import { generate } from './generate.js';
import { partMesh, featureEdges, toGLB, toOBJ, toSTL } from './export.js';

const MANIFOLD = 'https://cdn.jsdelivr.net/npm/manifold-3d@3.5.4/manifold.js';

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

const kernel = (async () => {
  const { default: Module } = await import(MANIFOLD);
  const wasm = await Module();
  wasm.setup();
  setKernel(wasm);
  return wasm;
})();
kernel.then(() => post({ type: 'ready', heapMB: heapMB() }), (e) => post({ type: 'fatal', message: 'the CAD kernel could not load: ' + msg(e) }));

let last = null; // { meshes, spec } of the last build, for edges and exports (plain arrays, no kernel objects)
let builds = 0;
let queue = Promise.resolve();
self.onmessage = (e) => { queue = queue.then(() => handle(e.data)); };

async function handle(m) {
  try {
    await kernel;
    if (m.type === 'build') await build(m);
    else if (m.type === 'edges') edges(m.id);
    else if (m.type === 'export') exportAs(m);
  } catch (e) {
    post({ type: 'error', id: m.id, message: msg(e), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join('\n') : '' });
  }
}

async function build(m) {
  const t0 = performance.now();
  const r = await generate(m.spec || {});
  if (!r.parts || !r.parts.length || !r.tris) throw new Error(`the ${r.spec.element} generator returned no geometry`);
  const t1 = performance.now();
  const meshes = r.parts.map((p) => partMesh(p, r.spec));
  freeParts(r.parts);   // the arrays are copies: give the kernel objects back to the WASM heap
  builds++;
  const t2 = performance.now();
  last = { meshes, spec: r.spec };
  const transfer = [];
  const copy = (a) => { if (!a) return null; const c = a.slice(); transfer.push(c.buffer); return c; };
  const out = meshes.map((x) => ({ name: x.name, role: x.role, material: x.material, positions: copy(x.positions), normals: copy(x.normals),
    indices: copy(x.indices), transforms: copy(x.transforms) }));
  const instancesN = r.parts.reduce((s, p) => s + (p.transforms ? p.transforms.length / 16 : 1), 0);
  const stats = {
    tris: r.tris, parts: r.parts.length, instances: instancesN, ms: r.ms, meshMs: t2 - t1, totalMs: t2 - t0,
    size: r.size, bbox: r.bbox, warnings: r.warnings, spec: r.spec, expected: r.expected, heapMB: heapMB(), builds,
  };
  post({ type: 'built', id: m.id, meshes: out, stats }, transfer);
  if (m.edges) edges(m.id);
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

function edges(id) {
  if (!last) throw new Error('nothing built yet');
  const list = last.meshes.map((x) => featureEdges(x, 30));
  post({ type: 'edges', id, edges: list }, list.map((a) => a.buffer));
}

function exportAs(m) {
  if (!last) throw new Error('nothing built yet');
  const name = m.name || last.spec.element;
  let buffer, mime;
  if (m.format === 'glb') { buffer = toGLB(last.meshes, { name, extras: { spec: last.spec, generator: 'Arch Studio' } }); mime = 'model/gltf-binary'; }
  else if (m.format === 'obj') { buffer = new TextEncoder().encode(toOBJ(last.meshes, { name })).buffer; mime = 'text/plain'; }
  else if (m.format === 'stl') { buffer = toSTL(last.meshes, { name }); mime = 'model/stl'; }
  else throw new Error('unknown export format ' + m.format);
  post({ type: 'exported', id: m.id, format: m.format, buffer, mime }, [buffer]);
}

function post(m, transfer = []) { self.postMessage(m, transfer); }
function msg(e) { return e && e.message ? e.message : String(e); }
