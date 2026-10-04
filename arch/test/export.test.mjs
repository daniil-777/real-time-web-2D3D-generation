// node arch/test/export.test.mjs — builds parts in Node (kernel primitives, plus gen/column.js when present), exports
// GLB / OBJ / STL with arch/js/export.js and validates the bytes: GLB header + chunks + accessors + nodes, OBJ face and
// vertex counts, STL size and triangle count, and that all three put the element at the same place in space.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { initKernel, ARCHKIT } from './node-kernel.mjs';
import { part, revolve, box, mat, instances, partsBBox, instanceCount } from '../js/kernel.js';
import { partMesh, toGLB, toOBJ, toOBJParts, toSTL, featureEdges, materialFor } from '../js/export.js';

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log('  FAIL', msg); } };
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

await initKernel();

// ------------------------------------------------------------------------------------------------ fixtures
function primitives() {
  // a revolved Tuscan-ish base (single copy), a box with 5 instances incl. rotation, non-uniform scale and a mirror,
  // and a sheared instance (must be baked in the GLB, not a node matrix)
  const base = revolve([[0, 0], [0.4, 0], [0.4, 0.08], [0.33, 0.12], [0.3, 0.3], [0, 0.3]], 64);
  const blk = box(-0.05, -0.05, 0, 0.05, 0.05, 0.12);
  const shear = mat.I(); shear[4] = 0.3; // x += 0.3 y
  const t = instances([
    mat.T(0.6, 0, 0), mat.mul(mat.T(-0.6, 0, 0), mat.Rz(0.7)), mat.mul(mat.T(0, 0.6, 0), mat.S(1, 2, 0.5)),
    mat.mul(mat.T(0, -0.6, 0), mat.S(-1, 1, 1)), mat.mul(mat.T(0, 0, 0.5), shear),
  ]);
  return { parts: [part('base', 'stone', base), part('block', 'metal', blk, t)], spec: { element: 'pedestal', material: 'marble' } };
}

async function built(spec) {
  const { FAMILY, generate } = await import('../js/generate.js');
  const f = new URL(`../js/gen/${FAMILY[spec.element]}.js`, import.meta.url);
  if (!fs.existsSync(f)) return null;
  try {
    const r = await generate(spec);
    return { parts: r.parts, spec: r.spec };
  } catch (e) { console.log(`  (${spec.element}: generator not ready: ${e.message})`); return null; }
}
const column = () => built({ element: 'column', order: 'ionic', height: 3.6 });

// ------------------------------------------------------------------------------------------------ checks
function check(label, { parts, spec }) {
  console.log(`\n${label}: ${parts.length} parts, ${parts.reduce((s, p) => s + instanceCount(p), 0)} instances`);
  const t0 = performance.now();
  const meshes = parts.map((p) => partMesh(p, spec));
  const tExtract = performance.now() - t0;
  const instancesTotal = parts.reduce((s, p) => s + instanceCount(p), 0);
  const trisTotal = meshes.reduce((s, m, i) => s + (m.indices.length / 3) * instanceCount(parts[i]), 0);
  const vertsTotal = meshes.reduce((s, m, i) => s + (m.positions.length / 3) * instanceCount(parts[i]), 0);
  meshes.forEach((m, i) => {
    ok(m.indices.length / 3 === parts[i].manifold.numTri(), `${m.name}: triangle count ${m.indices.length / 3} = numTri ${parts[i].manifold.numTri()}`);
    ok(m.normals && m.normals.length === m.positions.length, `${m.name}: one normal per vertex`);
    let bad = 0;
    for (let k = 0; k < m.normals.length; k += 3) if (Math.abs(Math.hypot(m.normals[k], m.normals[k + 1], m.normals[k + 2]) - 1) > 1e-3) bad++;
    ok(bad === 0, `${m.name}: unit normals (${bad} bad)`);
    ok(typeof m.material === 'string' && m.material.length > 0, `${m.name}: material ${m.material}`);
  });
  const bb = partsBBox(parts); // Z-up metres
  const bbY = { min: [bb.min[0], bb.min[2], -bb.max[1]], max: [bb.max[0], bb.max[2], -bb.min[1]] }; // Y-up

  // ---- GLB
  const t1 = performance.now();
  const glb = toGLB(meshes, { name: label, extras: { spec } });
  const tGLB = performance.now() - t1;
  const dv = new DataView(glb);
  ok(dv.getUint32(0, true) === 0x46546c67, 'GLB magic glTF');
  ok(dv.getUint32(4, true) === 2, 'GLB version 2');
  ok(dv.getUint32(8, true) === glb.byteLength, `GLB length field ${dv.getUint32(8, true)} = ${glb.byteLength}`);
  const jl = dv.getUint32(12, true);
  ok(dv.getUint32(16, true) === 0x4e4f534a, 'GLB chunk 0 is JSON');
  ok(jl % 4 === 0, 'JSON chunk 4-byte aligned');
  let json = null;
  try { json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jl))); } catch (e) { ok(false, 'JSON chunk parses: ' + e.message); }
  const bo = 20 + jl, bl = dv.getUint32(bo, true);
  ok(dv.getUint32(bo + 4, true) === 0x004e4942, 'GLB chunk 1 is BIN');
  ok(bo + 8 + bl === glb.byteLength, 'BIN chunk fills the file');
  if (json) {
    ok(json.asset.version === '2.0', 'asset.version 2.0');
    ok(json.buffers[0].byteLength === bl, 'buffer byteLength = BIN length');
    ok(json.nodes.length === instancesTotal, `node count ${json.nodes.length} = instances ${instancesTotal}`);
    ok(json.scenes[0].nodes.length === json.nodes.length, 'every node is in the scene');
    ok(json.scenes[0].extras && json.scenes[0].extras.spec, 'scene extras carry the spec');
    const bin = new DataView(glb, bo + 8, bl);
    for (const v of json.bufferViews) ok(v.byteOffset % 4 === 0 && v.byteOffset + v.byteLength <= bl, 'bufferView inside BIN and aligned');
    const read = (acc) => {
      const v = json.bufferViews[acc.bufferView], comps = { SCALAR: 1, VEC3: 3 }[acc.type], out = new Float64Array(acc.count * comps);
      const size = { 5126: 4, 5125: 4, 5123: 2 }[acc.componentType];
      ok(v.byteLength === acc.count * comps * size, `accessor count ${acc.count} x ${comps} x ${size} = view ${v.byteLength}`);
      for (let i = 0; i < out.length; i++) {
        const o = v.byteOffset + i * size;
        out[i] = acc.componentType === 5126 ? bin.getFloat32(o, true) : acc.componentType === 5125 ? bin.getUint32(o, true) : bin.getUint16(o, true);
      }
      return out;
    };
    // accessors: min/max exact, indices in range
    const worldMin = [Infinity, Infinity, Infinity], worldMax = [-Infinity, -Infinity, -Infinity];
    let glbTris = 0;
    const meshPos = json.meshes.map((m) => {
      const prim = m.primitives[0], pa = json.accessors[prim.attributes.POSITION], P = read(pa);
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], P[i + a]); mx[a] = Math.max(mx[a], P[i + a]); }
      ok(mn.every((x, a) => x === Math.fround(pa.min[a])) && mx.every((x, a) => x === Math.fround(pa.max[a])), `${m.name}: POSITION min/max`);
      const na = json.accessors[prim.attributes.NORMAL];
      ok(na && na.count === pa.count, `${m.name}: NORMAL count = POSITION count`);
      const I = read(json.accessors[prim.indices]);
      ok(I.length % 3 === 0 && I.every((x) => x < pa.count), `${m.name}: indices in range`);
      ok(prim.material !== undefined && json.materials[prim.material], `${m.name}: material exists`);
      return { P, tris: I.length / 3 };
    });
    for (const n of json.nodes) {
      const mp = meshPos[n.mesh];
      ok(!!mp, `node ${n.name} references a mesh`);
      glbTris += mp.tris;
      const M = n.matrix || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...(n.translation || [0, 0, 0]), 1];
      for (let i = 0; i < mp.P.length; i += 3) {
        const p = mat.apply(M, [mp.P[i], mp.P[i + 1], mp.P[i + 2]]);
        for (let a = 0; a < 3; a++) { worldMin[a] = Math.min(worldMin[a], p[a]); worldMax[a] = Math.max(worldMax[a], p[a]); }
      }
    }
    ok(glbTris === trisTotal, `GLB triangles ${glbTris} = ${trisTotal}`);
    // the GLB world bbox is the kernel bbox turned Y-up (kernel bbox is from boxes, so it may be loose for rotated
    // instances: compare against the exact OBJ bbox below and against the kernel box with a tolerance)
    ok(worldMin.every((x, a) => x >= bbY.min[a] - 1e-4) && worldMax.every((x, a) => x <= bbY.max[a] + 1e-4), 'GLB world bbox inside kernel bbox (Y-up)');
    ok(near(worldMax[1] - worldMin[1], bb.max[2] - bb.min[2], 1e-4), `GLB height (Y) ${(worldMax[1] - worldMin[1]).toFixed(4)} = Z height ${(bb.max[2] - bb.min[2]).toFixed(4)}`);
    var glbBox = { min: worldMin, max: worldMax };
  }

  // ---- OBJ
  const t2 = performance.now();
  const obj = toOBJ(meshes, { name: label });
  const tOBJ = performance.now() - t2;
  const chunks = toOBJParts(meshes, { name: label });
  ok(chunks.length > meshes.length && chunks.join('') === obj, `OBJ in ${chunks.length} chunks, joined = toOBJ`);
  ok(Math.max(...chunks.map((c) => c.length)) < Math.max(4e6, obj.length / 2) || chunks.length > 2, 'no single giant OBJ string');
  let f = 0, v = 0, vn = 0, o = 0;
  const omin = [Infinity, Infinity, Infinity], omax = [-Infinity, -Infinity, -Infinity];
  for (const line of obj.split('\n')) {
    if (line.startsWith('f ')) f++;
    else if (line.startsWith('vn ')) vn++;
    else if (line.startsWith('v ')) {
      v++;
      const p = line.slice(2).split(' ').map(Number);
      for (let a = 0; a < 3; a++) { omin[a] = Math.min(omin[a], p[a]); omax[a] = Math.max(omax[a], p[a]); }
    } else if (line.startsWith('o ')) o++;
  }
  ok(f === trisTotal, `OBJ faces ${f} = ${trisTotal}`);
  ok(v === vertsTotal && vn === v, `OBJ vertices ${v} = ${vertsTotal}, normals ${vn}`);
  ok(o === parts.length, `OBJ objects ${o} = parts ${parts.length}`);
  if (glbBox) ok(omin.every((x, a) => near(x, glbBox.min[a], 1e-4)) && omax.every((x, a) => near(x, glbBox.max[a], 1e-4)), 'OBJ bbox = GLB bbox (both Y-up m)');

  // ---- STL
  const t3 = performance.now();
  const stl = toSTL(meshes, { name: label });
  const tSTL = performance.now() - t3;
  const sv = new DataView(stl), n = sv.getUint32(80, true);
  ok(n === trisTotal, `STL triangle count ${n} = ${trisTotal}`);
  ok(stl.byteLength === 84 + 50 * n, `STL size ${stl.byteLength} = 84 + 50·${n}`);
  ok(String.fromCharCode(...new Uint8Array(stl, 0, 5)) !== 'solid', 'STL header does not start with "solid"');
  const smin = [Infinity, Infinity, Infinity], smax = [-Infinity, -Infinity, -Infinity];
  let badN = 0, degenerate = 0;
  for (let t = 0; t < n; t++) {
    const b = 84 + t * 50;
    const nn = [0, 1, 2].map((k) => sv.getFloat32(b + k * 4, true));
    const ln = Math.hypot(...nn);
    if (ln === 0) degenerate++; else if (Math.abs(ln - 1) > 1e-3) badN++; // zero-area slivers get a zero normal
    for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) {
      const x = sv.getFloat32(b + 12 + k * 12 + a * 4, true);
      smin[a] = Math.min(smin[a], x); smax[a] = Math.max(smax[a], x);
    }
  }
  ok(badN === 0 && degenerate < n * 1e-3, `STL unit facet normals (${badN} bad, ${degenerate} zero-area slivers)`);
  if (glbBox) {
    // STL is Z-up mm: x = x, y = -z(Y-up), z = y(Y-up)
    ok(near(smin[0] / 1000, glbBox.min[0], 1e-4) && near(smax[0] / 1000, glbBox.max[0], 1e-4), 'STL x (mm) = GLB x (m)');
    ok(near(smin[2] / 1000, glbBox.min[1], 1e-4) && near(smax[2] / 1000, glbBox.max[1], 1e-4), 'STL z (mm) = GLB y (m)');
    ok(near(smin[1] / 1000, -glbBox.max[2], 1e-4) && near(smax[1] / 1000, -glbBox.min[2], 1e-4), 'STL y (mm) = -GLB z (m)');
  }
  // outward winding: signed volume of the STL is positive (mirrored instances flipped back)
  let vol = 0;
  for (let t = 0; t < n; t++) {
    const b = 84 + t * 50 + 12, p = (k) => [0, 1, 2].map((a) => sv.getFloat32(b + k * 12 + a * 4, true) / 1000);
    const [A, B, Cc] = [p(0), p(1), p(2)];
    vol += (A[0] * (B[1] * Cc[2] - B[2] * Cc[1]) - A[1] * (B[0] * Cc[2] - B[2] * Cc[0]) + A[2] * (B[0] * Cc[1] - B[1] * Cc[0])) / 6;
  }
  const expectVol = parts.reduce((s, p) => {
    let v1 = 0;
    const tr = p.transforms;
    for (let i = 0; i < instanceCount(p); i++) {
      const m = tr ? tr.subarray(16 * i, 16 * i + 16) : mat.I();
      const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
      v1 += p.manifold.volume() * Math.abs(det);
    }
    return s + v1;
  }, 0);
  ok(near(vol, expectVol, 2e-3), `STL signed volume ${vol.toFixed(6)} = ${expectVol.toFixed(6)} m³ (outward winding)`);

  // ---- feature edges
  const e = meshes.map((m) => featureEdges(m, 30));
  ok(e.every((s) => s.length % 6 === 0), 'feature edges are segment pairs');
  ok(e.some((s) => s.length > 0), 'feature edges found');

  console.log(`  extract ${tExtract.toFixed(0)} ms · GLB ${(glb.byteLength / 1024).toFixed(0)} KB ${tGLB.toFixed(0)} ms · OBJ ${(obj.length / 1024).toFixed(0)} KB ${tOBJ.toFixed(0)} ms · STL ${(stl.byteLength / 1024).toFixed(0)} KB ${tSTL.toFixed(0)} ms · ${trisTotal} tris`);
  return { glb, obj, stl, json };
}

// materials by role
ok(materialFor('stone', { element: 'column', material: 'marble' }) === 'marble', 'stone part of a marble column is marble');
ok(materialFor('stone', { element: 'column', material: 'bronze' }) === 'bronze', 'a bronze column is bronze');
ok(materialFor('stone', { element: 'dome', material: 'copper' }) === 'limestone', 'the drum of a copper dome is limestone');
ok(materialFor('roof', { element: 'dome', material: 'copper' }) === 'copper', 'a copper dome shell is copper');
ok(materialFor('roof', { element: 'roof', material: 'limestone', covering: 'slate' }) === 'slate', 'a roof goes by its covering');
ok(materialFor('roof', { element: 'roof', material: 'terracotta', covering: 'slate' }) === 'slate', 'a slate roof is slate even with the default material');
ok(materialFor('roof', { element: 'roof', material: 'copper', covering: 'seam' }) === 'copper', 'a copper standing-seam roof is copper');
ok(materialFor('metal', { element: 'roof' }, { material: 'lead' }) === 'lead', "the generator's part.meta.material wins");
ok(materialFor('stone', { element: 'roof' }, { material: 'plaster' }) === 'plaster', 'walls under a roof take meta.material');
ok(materialFor('stone', { element: 'column', material: 'marble' }, { material: 'nonsense' }) === 'marble', 'an unknown meta.material falls back to the role');
ok(materialFor('roof', { element: 'dome', material: 'marble' }) === 'marble', 'a marble dome is marble');
ok(materialFor('metal', { element: 'spire', material: 'slate' }) === 'gold', 'a spire cross is gilded');
ok(materialFor('metal', { element: 'roof', material: 'terracotta' }) === 'zinc', 'roof flashing and cresting are zinc');
ok(materialFor('glass', {}) === 'glass', 'glass is glass');

const prim = check('primitives', primitives());
// the sheared instance is baked: one more glTF mesh than parts
ok(prim.json.meshes.length === 3, `sheared instance baked into its own mesh (${prim.json.meshes.length} meshes)`);
ok(prim.json.nodes.some((n) => n.matrix) && prim.json.nodes.some((n) => n.translation), 'node matrices and translations both used');

const col = await column();
if (col) {
  const r = check('ionic column (gen/column.js)', col);
  fs.mkdirSync(`${ARCHKIT}/exports`, { recursive: true });
  fs.writeFileSync(`${ARCHKIT}/exports/test-ionic-column.glb`, new Uint8Array(r.glb));
  fs.writeFileSync(`${ARCHKIT}/exports/test-ionic-column.obj`, r.obj);
  fs.writeFileSync(`${ARCHKIT}/exports/test-ionic-column.stl`, new Uint8Array(r.stl));
  console.log(`  wrote ${ARCHKIT}/exports/test-ionic-column.{glb,obj,stl}`);
} else console.log('\n(gen/column.js not present yet: column export skipped)');

// more families when they are there: many instances (balusters), several roles and materials (dome: stone, roof, metal, glass)
for (const spec of [{ element: 'balustrade', urns: true }, { element: 'dome', domeType: 'onion', material: 'copper' }]) {
  const r = await built(spec);
  if (!r) { console.log(`\n(${spec.element}: family not present yet, skipped)`); continue; }
  const out = check(`${spec.element} (gen/${spec.element === 'dome' ? 'dome' : 'balustrade'}.js)`, r);
  const mats = new Set(out.json.materials.map((m) => m.name));
  console.log('  materials:', [...mats].join(', '));
  if (spec.element === 'dome') ok(mats.has('copper'), 'a copper dome exports a copper material');
}

// the worker frees every part manifold after extraction (controller requirement: no WASM leak per rebuild). A generator
// that cached a kernel object between builds would now fail on its second build; check every family that is present.
{
  const { FAMILY, generate } = await import('../js/generate.js');
  const fams = [...new Set(Object.values(FAMILY))].filter((f) => fs.existsSync(new URL(`../js/gen/${f}.js`, import.meta.url)));
  const firstEl = (f) => Object.keys(FAMILY).find((e) => FAMILY[e] === f);
  console.log('\nfree-and-rebuild:', fams.join(', '));
  for (const f of fams) {
    const spec = { element: firstEl(f) };
    try {
      for (let k = 0; k < 2; k++) {
        const r = await generate(spec);
        r.parts.map((p) => partMesh(p, r.spec));
        const seen = new Set();
        for (const p of r.parts) if (!seen.has(p.manifold)) { seen.add(p.manifold); p.manifold.delete(); }
      }
      ok(true, `${f}: builds again after its parts were deleted`);
    } catch (e) { ok(false, `${f}: second build after delete() failed: ${e.message}`); }
  }
}

// a third-party reader must accept the GLB
try {
  const { WebIO } = await import(pathToFileURL(`${ARCHKIT}/node_modules/@gltf-transform/core/dist/index.js`).href);
  const doc = await new WebIO().readBinary(new Uint8Array(prim.glb));
  const root = doc.getRoot();
  ok(root.listNodes().length === prim.json.nodes.length, `glTF-Transform reads the GLB (${root.listNodes().length} nodes, ${root.listMeshes().length} meshes)`);
} catch (e) { ok(false, 'glTF-Transform reads the GLB: ' + e.message); }

console.log(`\n${checks - fails}/${checks} checks passed${fails ? ` — ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
