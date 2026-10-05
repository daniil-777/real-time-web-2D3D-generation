// Deformation engine tests: node arch/test/deform.test.mjs [--previews | --previews-only]
// --previews also writes before/after sheets (shared framing; gold dots = FFD control points) to
// /Volumes/LaCie/morph3d/archkit/previews/deform/ — in a child process with a fresh WASM heap (generators keep their
// temporaries, and manifold-3d 3.5.4's warp glue breaks past a 2 GB heap; deform.js falls back, but a fresh heap is
// simply faster).
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { box, part, partsBBox, instances, mat } from '../js/kernel.js';
import { polar3, eigSym3, det3, makeDeformer, deformParts, resolveOps, arapLattice, ffdLattice, foldCheck, smartStretch }
  from '../js/deform.js';

const W = await initKernel();
const PREVIEWS_ONLY = process.argv.includes('--previews-only');
const rows = [];
let failed = 0;
async function t(name, fn) {
  if (PREVIEWS_ONLY) return;
  const t0 = performance.now();
  try { const note = await fn(); rows.push([name, 'ok', (performance.now() - t0).toFixed(0), note || '']); }
  catch (e) { failed++; rows.push([name, 'FAIL', (performance.now() - t0).toFixed(0), e.message.split('\n')[0].slice(0, 140)]); }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const rel = (a, b, r, msg) => assert.ok(Math.abs(a - b) <= r * Math.abs(b), `${msg}: ${a} vs ${b} (${(100 * r).toFixed(2)} %)`);
const ext = (bb, k) => bb.max[k] - bb.min[k];
const named = (parts, n) => parts.filter((p) => p.name === n);
const allOk = (parts) => { for (const p of parts) { assert.equal(p.manifold.status(), 'NoError', p.name); assert.ok(p.manifold.volume() > 0, `${p.name} volume`); } };
const boxPart = () => part('box', 'stone', box(-0.5, -0.5, 0, 0.5, 0.5, 2));
const vol = (parts) => parts.reduce((s, p) => s + p.manifold.volume() * (p.transforms ? p.transforms.length / 16 : 1), 0);
function frameOrtho(M) { // linear part of a column-major 4x4: columns orthonormal, det +1
  const c = [0, 1, 2].map((j) => [M[4 * j], M[4 * j + 1], M[4 * j + 2]]);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) near(c[i][0] * c[j][0] + c[i][1] * c[j][1] + c[i][2] * c[j][2], i === j ? 1 : 0, 1e-6, 'frame');
}

// ------------------------------------------------------------------------------------------------ linear algebra
await t('polar3: 2000 random 3x3 (rotation, det +1, J = R S)', () => {
  let worst = 0;
  for (let k = 0; k < 2000; k++) {
    const A = Array.from({ length: 9 }, () => Math.random() * 2 - 1), { R, s } = polar3(A);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let d = 0; for (let q = 0; q < 3; q++) d += R[3 * q + i] * R[3 * q + j];
      worst = Math.max(worst, Math.abs(d - (i === j)));
    }
    worst = Math.max(worst, Math.abs(det3(R) - 1), Math.abs(s[0] * s[1] * s[2] - det3(A)) / Math.max(1, Math.abs(det3(A))));
    if (det3(A) > 0) { // S = R^T A symmetric positive definite
      const S = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let d = 0; for (let q = 0; q < 3; q++) d += R[3 * q + i] * A[3 * q + j]; S.push(d); }
      worst = Math.max(worst, Math.abs(S[1] - S[3]), Math.abs(S[2] - S[6]), Math.abs(S[5] - S[7]));
      assert.ok(S[0] > 0 && S[4] > 0 && S[8] > 0, 'S positive');
    }
  }
  assert.ok(worst < 1e-9, `worst ${worst}`);
  const { w, V } = eigSym3([4, 1, 0, 1, 3, 0, 0, 0, 1]);
  for (let j = 0; j < 3; j++) { const v = [V[j], V[3 + j], V[6 + j]]; const Av = [4 * v[0] + v[1], v[0] + 3 * v[1], v[2]]; for (let i = 0; i < 3; i++) near(Av[i], w[j] * v[i], 1e-12, 'eig'); }
  return `max error ${worst.toExponential(1)}`;
});

// ------------------------------------------------------------------------------------------------ identity
await t('identity ops = unchanged positions (same parts back)', async () => {
  const bb = { min: [-1, -1, 0], max: [1, 1, 3] };
  const ops = [{ type: 'stretch', axis: 'z', factor: 1 }, { type: 'bend', axis: 'x', angle: 0 }, { type: 'twist', angle: 0 }, { type: 'taper', scale: 1 },
    { type: 'shear', dx: 0, dy: 0 }, { type: 'ffd', dims: [2, 2, 2], offsets: new Float64Array(81) }];
  const D = makeDeformer(ops, bb);
  assert.equal(D.identity, true);
  for (let k = 0; k < 50; k++) { const p = [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 3]; assert.deepEqual(D.point(p), p); }
  const g = await generate({ element: 'balustrade', length: 3 });
  const r = deformParts(g.parts, ops);
  assert.equal(r.parts.length, g.parts.length);
  r.parts.forEach((p, i) => { assert.equal(p.manifold, g.parts[i].manifold); assert.equal(p.transforms, g.parts[i].transforms); });
});
await t('non-trivial ops fix their anchor exactly', () => {
  const bb = { min: [-2, -0.3, 0], max: [2, 0.3, 1] };
  for (const op of [{ type: 'bend', axis: 'x', angle: 170 }, { type: 'twist', axis: 'x', angle: 90 }, { type: 'shear', axis: 'x', dy: 0.4 }]) {
    const p = makeDeformer([op], bb).point([0, 0, 0.5]);
    near(Math.hypot(p[0], p[1], p[2] - 0.5), 0, 1e-9, op.type + ' centre');
  }
  for (const op of [{ type: 'bend', axis: 'z', angle: 40 }, { type: 'twist', axis: 'z', angle: 300 }, { type: 'taper', axis: 'z', scale: 0.3 }]) {
    const D = makeDeformer([op], { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 4] });
    for (const q of [[0.5, 0.5, 0], [-0.5, 0.2, 0]]) { const p = D.point(q); near(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]), 0, 1e-9, op.type + ' base'); }
  }
});

// ------------------------------------------------------------------------------------------------ stretch
await t('stretch z 1.5, keep [0,1]: box volume x1.5', () => {
  const r = deformParts([boxPart()], [{ type: 'stretch', axis: 'z', factor: 1.5, keep: [0, 1] }]);
  rel(r.parts[0].manifold.volume(), 3, 0.01, 'volume');
  near(ext(partsBBox(r.parts), 2), 3, 1e-9, 'height');
  return `volume ${r.parts[0].manifold.volume().toFixed(6)} (2 -> 3)`;
});
for (const order of ['ionic', 'corinthian']) {
  await t(`stretch z 1.5, keep [0.12,0.88]: ${order} capital and base keep their heights`, async () => {
    const g = await generate({ element: 'column', order });
    const r = deformParts(g.parts, [{ type: 'stretch', axis: 'z', factor: 1.5, keep: [0.12, 0.88] }]);
    allOk(r.parts);
    const H = ext(g.bbox, 2);
    rel(ext(partsBBox(r.parts), 2), H * (1 + 0.5 * 0.76), 0.001, 'total height');
    const capNames = order === 'ionic' ? ['capital'] : ['bell', 'abacus', 'leaf-upper', 'volute'];
    const notes = [];
    for (const n of ['base', ...capNames]) {
      const h0 = ext(partsBBox(named(g.parts, n)), 2), h1 = ext(partsBBox(named(r.parts, n)), 2);
      rel(h1, h0, 0.005, `${n} height`);
      notes.push(`${n} ${(100 * (h1 / h0 - 1)).toFixed(3)}%`);
    }
    rel(ext(partsBBox(named(r.parts, 'shaft')), 2), ext(partsBBox(named(g.parts, 'shaft')), 2) + 0.5 * 0.76 * H, 0.002, 'shaft grows by all of it');
    return notes.join(', ');
  });
}
await t('stretch keep auto: pedestal, base, capital exact on a column with pedestal', async () => {
  const g = await generate({ element: 'column', order: 'doric', pedestal: true });
  const r = deformParts(g.parts, [{ type: 'stretch', axis: 'z', factor: 1.6 }]);
  const k = r.ops[0].keep;
  for (const n of ['pedestal', 'base', 'capital']) rel(ext(partsBBox(named(r.parts, n)), 2), ext(partsBBox(named(g.parts, n)), 2), 1e-6, n);
  return `keep -> [${k.map((x) => x.toFixed(3))}]`;
});

// ------------------------------------------------------------------------------------------------ bend
await t('bend x 180°: 4 m balustrade -> half ring (rigid balusters)', async () => {
  const g = await generate({ element: 'balustrade', length: 4 });
  const r = deformParts(g.parts, [{ type: 'bend', axis: 'x', angle: 180 }]);
  const D = r.deformer, bb = g.bbox, yc = (bb.min[1] + bb.max[1]) / 2, zc = (bb.min[2] + bb.max[2]) / 2, L = ext(bb, 0);
  let len = 0, prev = null;
  for (let i = 0; i <= 2000; i++) { const p = D.point([bb.min[0] + (L * i) / 2000, yc, zc]); if (prev) len += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]); prev = p; }
  rel(len, L, 0.01, 'centre-line length');
  const e0 = D.point([bb.min[0], yc, zc]), e1 = D.point([bb.max[0], yc, zc]);
  rel(Math.hypot(e0[0] - e1[0], e0[1] - e1[1]), (2 * L) / Math.PI, 0.001, 'ends 2R apart');
  const J0 = D.jacobian([bb.min[0], yc, zc]), J1 = D.jacobian([bb.max[0], yc, zc]);
  const t0 = [J0[0], J0[3], J0[6]], t1 = [J1[0], J1[3], J1[6]];
  near((t0[0] * t1[0] + t0[1] * t1[1] + t0[2] * t1[2]) / (Math.hypot(...t0) * Math.hypot(...t1)), -1, 1e-6, 'end tangents opposite');
  for (const n of ['baluster', 'half-baluster']) {
    const a = named(g.parts, n)[0], b = named(r.parts, n)[0];
    assert.equal(b.manifold, a.manifold, `${n}: same Manifold object`);
    assert.equal(b.manifold.volume(), a.manifold.volume());
    assert.equal(b.transforms.length, a.transforms.length);
    for (let i = 0; i < b.transforms.length / 16; i++) {
      const M = b.transforms.subarray(16 * i, 16 * i + 16);
      frameOrtho(M);
      near(M[10], 1, 1e-6, 'upright');
    }
  }
  allOk(r.parts);
  assert.deepEqual(r.warnings, []);
  return `centre line ${len.toFixed(5)} m of ${L.toFixed(3)}, ${r.stats.rigid.join('/')} rigid, ${r.stats.ms.toFixed(0)} ms`;
});
await t('bend x 180°: 4 m Ionic entablature -> half ring (rigid dentils, eggs)', async () => {
  let g;
  try { g = await generate({ element: 'entablature', order: 'ionic', length: 4 }); } catch (e) { return 'skipped: entablature family not available'; }
  const r = deformParts(g.parts, [{ type: 'bend', axis: 'x', angle: 180 }]);
  allOk(r.parts);
  const d = named(r.parts, 'dentil')[0];
  assert.equal(d.manifold, named(g.parts, 'dentil')[0].manifold);
  for (let i = 0; i < d.transforms.length / 16; i++) frameOrtho(d.transforms.subarray(16 * i, 16 * i + 16));
  assert.deepEqual(r.warnings, []);
  return `${d.transforms.length / 16} dentils rigid, ${r.stats.tris} tris, ${r.stats.ms.toFixed(0)} ms`;
});
await t('bend z 25° (range auto): base untouched, capital rigid', async () => {
  const g = await generate({ element: 'column', order: 'tuscan' });
  const r = deformParts(g.parts, [{ type: 'bend', axis: 'z', angle: 25 }]);
  allOk(r.parts);
  const b0 = partsBBox(named(g.parts, 'base')), b1 = partsBBox(named(r.parts, 'base'));
  for (let k = 0; k < 3; k++) { near(b1.min[k], b0.min[k], 1e-6, 'base min'); near(b1.max[k], b0.max[k], 1e-6, 'base max'); }
  rel(vol(named(r.parts, 'capital')), vol(named(g.parts, 'capital')), 1e-4, 'capital volume (rigid motion)');
  near(ext(partsBBox(named(r.parts, 'capital')), 2) > 0 ? 0 : 1, 0, 0, 'capital');
  return `range -> [${r.ops[0].range.map((x) => x.toFixed(3))}]`;
});

// ------------------------------------------------------------------------------------------------ twist, taper, shear
await t('twist z 90°: box volume kept, top corner turned 90°', () => {
  const r = deformParts([boxPart()], [{ type: 'twist', axis: 'z', angle: 90 }]);
  rel(r.parts[0].manifold.volume(), 2, 0.002, 'volume');
  const p = r.deformer.point([0.5, 0.5, 2]);
  near(p[0], -0.5, 1e-9, 'x'); near(p[1], 0.5, 1e-9, 'y');
  allOk(r.parts);
  return `volume ${r.parts[0].manifold.volume().toFixed(5)}, ${r.stats.tris} tris (edge ${r.stats.edge.toFixed(3)} m)`;
});
await t('taper z 0.5: frustum volume and top section', () => {
  const r = deformParts([boxPart()], [{ type: 'taper', axis: 'z', scale: 0.5 }]);
  rel(r.parts[0].manifold.volume(), (2 * (1 + 0.5 + 0.25)) / 3, 1e-6, 'volume');
  const bb = r.parts[0].manifold.boundingBox(); // the top face is the only one at z = 2
  const p = r.deformer.point([0.5, 0.5, 2]);
  near(p[0], 0.25, 1e-9, 'top half-width');
  near(ext(bb, 2), 2, 1e-9, 'height');
});
await t('taper z auto on an obelisk: pedestal true, shaft tapered', async () => {
  const g = await generate({ element: 'obelisk' });
  const r = deformParts(g.parts, [{ type: 'taper', axis: 'z', scale: 0.5 }]);
  allOk(r.parts);
  for (const n of ['steps', 'pedestal', 'plinth']) {
    const a = partsBBox(named(g.parts, n)), b = partsBBox(named(r.parts, n));
    for (let k = 0; k < 3; k++) { near(b.min[k], a.min[k], 1e-6, n); near(b.max[k], a.max[k], 1e-6, n); }
  }
  // width of the shaft's top section (the taper is 1 at the shaft foot, `scale` at its top)
  const topWidth = (p) => {
    const g2 = p.manifold.getMesh(), V = g2.vertProperties, np = g2.numProp, M = p.transforms ? p.transforms.subarray(0, 16) : null;
    const pts = []; for (let i = 0; i < V.length; i += np) pts.push(M ? mat.apply(M, [V[i], V[i + 1], V[i + 2]]) : [V[i], V[i + 1], V[i + 2]]);
    const zt = Math.max(...pts.map((q) => q[2])), top = pts.filter((q) => q[2] > zt - 1e-6);
    return Math.max(...top.map((q) => q[0])) - Math.min(...top.map((q) => q[0]));
  };
  const w0 = topWidth(named(g.parts, 'shaft')[0]), w1 = topWidth(named(r.parts, 'shaft')[0]);
  rel(w1, 0.5 * w0, 1e-6, 'shaft top width');
  return `shaft top ${w0.toFixed(3)} -> ${w1.toFixed(3)} m, pedestal unchanged`;
});
await t('taper past the range end: a similar figure (Corinthian capital scaled uniformly)', async () => {
  const g = await generate({ element: 'column', order: 'corinthian' });
  const r = deformParts(g.parts, [{ type: 'taper', axis: 'z', scale: 0.6 }]);
  allOk(r.parts);
  const a = partsBBox(named(g.parts, 'abacus')), b = partsBBox(named(r.parts, 'abacus'));
  rel(ext(b, 0), 0.6 * ext(a, 0), 0.002, 'abacus width'); rel(ext(b, 2), 0.6 * ext(a, 2), 0.002, 'abacus height');
  const leaf = named(r.parts, 'leaf-upper')[0].transforms; // rigid, scaled by the median singular value
  near(Math.hypot(leaf[0], leaf[1], leaf[2]), 0.6, 0.01, 'leaf scale');
  rel(ext(partsBBox(r.parts), 2), ext(g.bbox, 2), 1e-6, 'column height kept');
  return 'abacus x0.6 in width and height, leaves x0.6, column height kept';
});
// footprint: x/y extents of every vertex within 1 mm of the element's lowest point (instances included)
const footprint = (parts) => {
  const z0 = partsBBox(parts.filter((p) => p.manifold.numTri() > 0)).min[2], ext = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of parts) {
    const g = p.manifold.getMesh(), V = g.vertProperties, np = g.numProp, n = p.transforms ? p.transforms.length / 16 : 1;
    for (let i = 0; i < n; i++) {
      const M = p.transforms ? p.transforms.subarray(16 * i, 16 * i + 16) : null;
      for (let v = 0; v < V.length; v += np) {
        const q = M ? mat.apply(M, [V[v], V[v + 1], V[v + 2]]) : [V[v], V[v + 1], V[v + 2]];
        if (q[2] > z0 + 1e-3) continue;
        ext[0] = Math.min(ext[0], q[0]); ext[1] = Math.max(ext[1], q[0]); ext[2] = Math.min(ext[2], q[1]); ext[3] = Math.max(ext[3], q[1]);
      }
    }
  }
  return ext;
};
await t('taper keeps height and footprint (obelisk, columns, pilaster, spire, finial)', async () => {
  const notes = [];
  for (const [spec, base] of [[{ element: 'obelisk' }, 'steps'], [{ element: 'column', order: 'corinthian' }, 'base'],
    [{ element: 'column', order: 'tuscan', pedestal: true }, 'pedestal'], [{ element: 'pilaster', order: 'ionic' }, 'base'],
    [{ element: 'spire' }, null], [{ element: 'finial' }, null]]) {
    const g = await generate(spec), f0 = footprint(g.parts);
    let worst = 0;
    for (const sc of [0.3, 0.5, 1.4]) {
      const r = deformParts(g.parts, [{ type: 'taper', axis: 'z', scale: sc }]);
      allOk(r.parts);
      const bb = partsBBox(r.parts);
      near(bb.min[2], g.bbox.min[2], 1e-9, `${spec.element} foot`);
      rel(bb.max[2] - bb.min[2], g.size[2], 1e-4, `${spec.element} height at taper ${sc}`); // the brief asks 0.5 %
      worst = Math.max(worst, Math.abs((bb.max[2] - bb.min[2]) / g.size[2] - 1));
      const f1 = footprint(r.parts);
      for (let k = 0; k < 4; k++) near(f1[k], f0[k], 1e-6, `${spec.element} footprint`);
      if (base) { // the taper starts above the base part: it is untouched
        const a = partsBBox(named(g.parts, base)), b = partsBBox(named(r.parts, base));
        for (let k = 0; k < 3; k++) { near(b.min[k], a.min[k], 1e-6, base); near(b.max[k], a.max[k], 1e-6, base); }
      }
    }
    notes.push(`${spec.element}${spec.order ? ' ' + spec.order : ''} ${(worst * 100).toExponential(0)} %`);
  }
  return 'height error: ' + notes.join(', ');
});
await t('meta.rigid tags override the size rule', async () => {
  const g = await generate({ element: 'balustrade', length: 3 });
  const untagged = deformParts(g.parts, [{ type: 'bend', axis: 'x', angle: 90 }]);
  assert.ok(untagged.stats.warped.includes('baluster'), 'untagged balusters of a 3 m run are warped at rigidRatio 0.2');
  const tag = (parts, name, rigid) => parts.map((p) => (p.name === name ? { ...p, meta: { ...p.meta, rigid } } : p));
  const tagged = deformParts(tag(g.parts, 'baluster', true), [{ type: 'bend', axis: 'x', angle: 90 }]);
  assert.ok(tagged.stats.rigid.includes('baluster'));
  assert.equal(named(tagged.parts, 'baluster')[0].manifold, named(g.parts, 'baluster')[0].manifold);
  const g6 = await generate({ element: 'balustrade', length: 6 });
  assert.ok(deformParts(g6.parts, [{ type: 'bend', axis: 'x', angle: 90 }]).stats.rigid.includes('pedestal'), '6 m: pedestals rigid by size');
  assert.ok(deformParts(tag(g6.parts, 'pedestal', false), [{ type: 'bend', axis: 'x', angle: 90 }]).stats.warped.includes('pedestal'), 'tag false warps');
  const knob = part('knob', 'stone', W.Manifold.sphere(0.2, 24).translate([0, 0, 1.8]), null, { rigid: true });
  const r = deformParts([part('post', 'stone', box(-0.1, -0.1, 0, 0.1, 0.1, 1.6)), knob], [{ type: 'bend', axis: 'z', angle: 40 }]);
  const k = named(r.parts, 'knob')[0];
  assert.equal(k.manifold, knob.manifold); assert.equal(k.transforms.length, 16); frameOrtho(k.transforms);
  untagged.parts.filter((q) => q.meta.deform === 'warp').forEach((q) => q.manifold.delete());
  return 'balusters rigid when tagged, pedestals warped when tagged false, a single tagged knob moves as one piece';
});
await t('shear z (lean): volume kept, top moved by d', () => {
  const r = deformParts([boxPart()], [{ type: 'shear', axis: 'z', dx: 0.5, dy: -0.2 }]);
  rel(r.parts[0].manifold.volume(), 2, 1e-9, 'volume');
  const p = r.deformer.point([0, 0, 2]);
  near(p[0], 0.5, 1e-9, 'dx'); near(p[1], -0.2, 1e-9, 'dy');
  assert.equal(r.stats.edge, 0, 'affine: no refinement');
  const q = makeDeformer([{ type: 'shear', axis: 'z', rx: 0.1, ry: -0.05 }], { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 2] }).point([0, 0, 2]);
  near(q[0], 0.2, 1e-12, 'relative lean x'); near(q[1], -0.1, 1e-12, 'relative lean y');
  const D = makeDeformer([{ type: 'taper', axis: 'z', scale: 0.5 }, { type: 'bend', axis: 'x', angle: 30 }], { min: [-1, -0.5, 0], max: [1, 0.5, 2] });
  assert.deepEqual(D.compiled.map((c) => c.axis), [2, 0]);
  assert.deepEqual(D.compiled[0].frame, { min: [-1, -0.5, 0], max: [1, 0.5, 2] });
});

// ------------------------------------------------------------------------------------------------ FFD + ARAP
await t('ffd: zero offsets = identity; affine offsets reproduce the affine map', () => {
  const bb = { min: [-1, -0.5, 0], max: [1, 0.5, 2] }, dims = [3, 2, 4], lat = ffdLattice(dims, bb);
  assert.equal(makeDeformer([{ type: 'ffd', dims, offsets: new Float64Array(3 * lat.count) }], bb).identity, true);
  const A = [1.1, 0.2, 0, -0.1, 0.9, 0.3, 0.05, 0, 1.2], tr = [0.1, -0.2, 0.3];
  const aff = (p) => [0, 1, 2].map((i) => A[3 * i] * p[0] + A[3 * i + 1] * p[1] + A[3 * i + 2] * p[2] + tr[i]);
  const off = new Float64Array(3 * lat.count);
  for (let i = 0; i < lat.count; i++) { const p = [lat.rest[3 * i], lat.rest[3 * i + 1], lat.rest[3 * i + 2]], q = aff(p); for (let a = 0; a < 3; a++) off[3 * i + a] = q[a] - p[a]; }
  const D = makeDeformer([{ type: 'ffd', dims, offsets: off }], bb);
  let worst = 0;
  for (let k = 0; k < 200; k++) {
    const p = [0, 1, 2].map((a) => bb.min[a] + Math.random() * (bb.max[a] - bb.min[a])), q = D.point(p), e = aff(p);
    worst = Math.max(worst, Math.hypot(q[0] - e[0], q[1] - e[1], q[2] - e[2]));
  }
  assert.ok(worst < 1e-12, `linear precision ${worst}`);
  return `linear precision ${worst.toExponential(1)}`;
});
function arapCase(dims, bb, pin, move) {
  const lat = ffdLattice(dims, bb), id = pin(lat), tgt = [0, 1, 2].map((a) => lat.rest[3 * id + a] + move[a]);
  const off = arapLattice(dims, { [id]: tgt }, 10, { rest: lat.rest });
  const P = lat.rest.map((x, i) => x + off[i]), [l, m] = lat.dims;
  near(Math.hypot(...[0, 1, 2].map((a) => P[3 * id + a] - tgt[a])), 0, 1e-12, 'pin exact');
  const ijk = (q) => [q % (l + 1), Math.floor(q / (l + 1)) % (m + 1), Math.floor(q / ((l + 1) * (m + 1)))];
  const h = ijk(id), opp = lat.index(...h.map((x, k) => (x ? 0 : lat.dims[k])));
  const oppMove = Math.hypot(off[3 * opp], off[3 * opp + 1], off[3 * opp + 2]);
  let strain = 0;
  for (const d of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) for (const sg of [1, -1]) {
    const q = h.map((x, k) => x + sg * d[k]);
    if (q.some((x, k) => x < 0 || x > lat.dims[k])) continue;
    const j = lat.index(...q);
    const r0 = Math.hypot(...[0, 1, 2].map((a) => lat.rest[3 * id + a] - lat.rest[3 * j + a])), r1 = Math.hypot(...[0, 1, 2].map((a) => P[3 * id + a] - P[3 * j + a]));
    strain = Math.max(strain, Math.abs(r1 / r0 - 1));
  }
  assert.ok(oppMove < 0.1, `opposite corner moved ${oppMove}`);
  assert.ok(strain < 0.1, `handle edges changed ${(100 * strain).toFixed(1)} %`);
  return `opposite ${oppMove.toFixed(4)} m, handle edges ${(100 * strain).toFixed(1)} %`;
}
await t('ARAP: 2 m cube lattice [3,3,3], corner pulled out 0.5 m', () => arapCase([3, 3, 3], { min: [-1, -1, 0], max: [1, 1, 2] }, () => 0, [-0.5, 0, 0]));
await t('ARAP: column lattice [2,2,4], top corner dragged 0.5 m sideways', () => arapCase([2, 2, 4], { min: [-0.33, -0.33, 0], max: [0.33, 0.33, 4.5] }, (lat) => lat.index(2, 2, 4), [0.5, 0, 0]));
await t('ARAP: balustrade lattice [6,1,1], corner pulled 0.5 m forward', () => arapCase([6, 1, 1], { min: [-2, -0.23, 0], max: [2, 0.23, 0.95] }, () => 0, [0, -0.5, 0]));
await t('ARAP: no pins = zeros; two pins both exact; 10^3 lattice fast', () => {
  assert.ok(arapLattice([3, 3, 3], {}).every((x) => x === 0));
  const dims = [10, 10, 10], lat = ffdLattice(dims, { min: [-1, -1, 0], max: [1, 1, 2] }), last = lat.count - 1;
  const pins = { 0: [lat.rest[0] - 0.3, lat.rest[1], lat.rest[2]], [last]: [lat.rest[3 * last] + 0.3, lat.rest[3 * last + 1], lat.rest[3 * last + 2] + 0.2] };
  const t0 = performance.now(), off = arapLattice(dims, pins, 10, { rest: lat.rest }), ms = performance.now() - t0;
  for (const [id, v] of Object.entries(pins)) for (let a = 0; a < 3; a++) near(lat.rest[3 * id + a] + off[3 * id + a], v[a], 1e-12, 'pin');
  assert.ok(ms < 1000, `${ms} ms`);
  return `1331 points: ${ms.toFixed(0)} ms`;
});
await t('ffd with pins on a Corinthian capital: watertight, no folds', async () => {
  const g = await generate({ element: 'capital', order: 'corinthian' });
  const dims = [3, 3, 3], lat = ffdLattice(dims, g.bbox), id = lat.index(3, 0, 3), p = [0, 1, 2].map((a) => lat.rest[3 * id + a]);
  const r = deformParts(g.parts, [{ type: 'ffd', dims, pins: { [id]: [p[0] + 0.15, p[1] - 0.15, p[2] + 0.06] } }]);
  allOk(r.parts);
  assert.ok(!r.warnings.includes('fold'));
  return `${r.parts.length} parts, ${r.stats.tris} tris, ${r.stats.ms.toFixed(0)} ms`;
});

// ------------------------------------------------------------------------------------------------ modes, folds, budget
await t('rigidInstances false: everything baked and warped', async () => {
  const g = await generate({ element: 'balustrade', length: 4 });
  const r = deformParts(g.parts, [{ type: 'bend', axis: 'x', angle: 90 }], { rigidInstances: false });
  allOk(r.parts);
  assert.equal(r.stats.rigid.length, 0);
  assert.ok(r.parts.every((p) => !p.transforms || p.transforms.length === 16));
  assert.equal(named(r.parts, 'baluster').length, named(g.parts, 'baluster')[0].transforms.length / 16, 'one piece per baluster');
  return `${r.parts.length} pieces`;
});
await t('baked instances: mirrored and scaled frames stay outward-facing', () => {
  // two large instances of one mesh: one mirrored in x (det < 0: transformed by Manifold before the warp), one scaled
  const wedge = W.Manifold.cylinder(1, 0.4, 0.1, 24).translate([0.6, 0, 0]);
  const p = part('wedge', 'stone', wedge, instances([mat.mul(mat.T(-0.2, 0, 0), mat.S(-1, 1, 1)), mat.mul(mat.T(0.2, 0, 0), mat.S(1.2, 0.8, 1))]));
  const r = deformParts([p], [{ type: 'twist', axis: 'z', angle: 120 }]);
  assert.equal(r.parts.length, 2);
  allOk(r.parts);
  rel(r.parts[0].manifold.volume(), wedge.volume(), 0.01, 'mirrored piece volume');
  rel(r.parts[1].manifold.volume(), wedge.volume() * 0.96, 0.01, 'scaled piece volume');
  return `volumes ${r.parts.map((q) => q.manifold.volume().toFixed(4)).join(' / ')}`;
});
await t('warp fallback (mesh path past a 2 GB heap) = fast path', async () => {
  const g = await generate({ element: 'balustrade', length: 4 }), ops = [{ type: 'bend', axis: 'x', angle: 120 }];
  const a = deformParts(g.parts, ops), b = deformParts(g.parts, ops, { warpViaMesh: true });
  allOk(b.parts);
  let worst = 0;
  a.parts.forEach((p, i) => {
    worst = Math.max(worst, Math.abs(b.parts[i].manifold.volume() / p.manifold.volume() - 1));
    assert.equal(b.parts[i].manifold.numTri(), p.manifold.numTri(), 'same topology');
  });
  assert.ok(worst < 1e-5, `volume ${worst}`);
  return `max volume difference ${worst.toExponential(1)} (float32 positions)`;
});
await t('empty part passes through; re-grounding reported', () => {
  const empty = part('nothing', 'stone', W.Manifold.cube([1, 1, 1]).subtract(W.Manifold.cube([2, 2, 2]).translate([-0.5, -0.5, -0.5])));
  const slab = part('slab', 'stone', box(-2, -0.1, 0, 2, 0.1, 0.2));
  const r = deformParts([slab, empty], [{ type: 'bend', axis: 'x', angle: 90, dir: -90 }]); // sag: the ends drop
  assert.equal(r.parts[1].manifold, empty.manifold);
  assert.deepEqual(r.warnings, []);
  near(partsBBox(r.parts).min[2], 0, 1e-9, 'grounded');
  assert.ok(r.stats.ground > 0, 'lifted back onto z = 0');
  return `lifted ${r.stats.ground.toFixed(3)} m`;
});
await t('no leaks: a throw mid-loop frees every Manifold deformParts created', () => {
  // record every Manifold made by the calls deformParts uses, inject a failure, check what survives
  // (the methods live on the prototype of Manifold instances, which is not W.Manifold.prototype in this binding)
  const P = Object.getPrototypeOf(W.Manifold.cube([1, 1, 1])), orig = { transform: P.transform, refineToLength: P.refineToLength, warpBatch: P.warpBatch, ofMesh: W.Manifold.ofMesh };
  let made = [], fail = null;
  const calls = { transform: 0, refineToLength: 0, warpBatch: 0 };
  const wrap = (name) => function (...a) {
    calls[name]++;
    if (fail && fail.name === name && calls[name] === fail.at) throw new Error(`injected ${name} failure`);
    const r = orig[name].apply(this, a); made.push(r); return r;
  };
  const install = () => { P.transform = wrap('transform'); P.refineToLength = wrap('refineToLength'); P.warpBatch = wrap('warpBatch');
    W.Manifold.ofMesh = (...a) => { const r = orig.ofMesh(...a); made.push(r); return r; }; };
  const restore = () => { Object.assign(P, { transform: orig.transform, refineToLength: orig.refineToLength, warpBatch: orig.warpBatch }); W.Manifold.ofMesh = orig.ofMesh; };
  // a mirrored large instanced part (Manifold transform), two long boxes (refined), all warped by a twist
  const wedge = W.Manifold.cylinder(2, 0.4, 0.1, 24).translate([0.6, 0, 0]);
  const parts = [part('wedge', 'stone', wedge, instances([mat.mul(mat.T(-0.2, 0, 0), mat.S(-1, 1, 1)), mat.T(0.2, 0, 0)])),
    part('post', 'stone', box(-1.2, -0.1, 0, -1, 0.1, 2)), part('post2', 'stone', box(1, -0.1, 0, 1.2, 0.1, 2))];
  const ops = [{ type: 'twist', axis: 'z', angle: 160 }];
  const notes = [];
  try {
    for (const f of [{ name: 'warpBatch', at: 3 }, { name: 'refineToLength', at: 2 }]) {
      made = []; fail = f; for (const k in calls) calls[k] = 0;
      install();
      assert.throws(() => deformParts(parts, ops), /injected/);
      restore();
      assert.ok(made.length >= 2, `created ${made.length} before the failure`);
      for (const m of made) assert.ok(m.isDeleted(), `${f.name} failure: a created Manifold survived`);
      for (const p of parts) { assert.ok(!p.manifold.isDeleted(), 'input deleted'); assert.ok(p.manifold.volume() > 0); }
      notes.push(`${f.name} #${f.at}: ${made.length} freed`);
    }
    // and on success only the returned pieces are alive
    made = []; fail = null; install();
    const r = deformParts(parts, ops);
    restore();
    const outs = new Set(r.parts.map((q) => q.manifold));
    for (const m of made) assert.equal(m.isDeleted(), !outs.has(m), 'only outputs survive');
    notes.push(`success: ${made.length} made, ${made.filter((m) => !m.isDeleted()).length} alive = ${r.parts.length} outputs`);
  } finally { restore(); }
  return notes.join('; ');
});
await t('overlap warning when a bend closes on itself', () => {
  const rail = part('rail', 'stone', box(-2, -0.05, 0, 2, 0.05, 0.1)), deep = part('deep', 'stone', box(-2, -0.4, 0, 2, 0.4, 0.3));
  const w = (p, angle) => deformParts([p], [{ type: 'bend', axis: 'x', angle }]).warnings;
  assert.ok(w(rail, 330).includes('overlap'), '330°');
  assert.ok(w(rail, -340).includes('overlap'), '-340°');
  assert.ok(!w(rail, 300).includes('overlap'), 'thin rail at 300° leaves a gap');
  assert.ok(w(deep, 300).includes('overlap'), 'deep run at 300°: gap 2R sin 30° = 0.76 m < 0.8 m depth');
  assert.ok(!w(deep, 180).includes('overlap'));
  return 'rail 330°/-340° overlap, 300° not; deep 300° overlap';
});
await t('fold check: a bend tighter than the depth folds; 400° overlaps', () => {
  const thick = part('slab', 'stone', box(-0.25, -0.3, 0, 0.25, 0.3, 0.2));
  const r = deformParts([thick], [{ type: 'bend', axis: 'x', angle: 300 }]);
  assert.ok(r.warnings.includes('fold'), JSON.stringify(r.warnings));
  const ok = deformParts([thick], [{ type: 'bend', axis: 'x', angle: 60 }]);
  assert.deepEqual(ok.warnings, []);
  assert.equal(foldCheck(ok.deformer).folds, 0);
  const D = makeDeformer([{ type: 'bend', axis: 'x', angle: 300 }], { min: [-0.25, -0.3, 0], max: [0.25, 0.3, 0.2] });
  assert.ok(foldCheck(D).folds > 0);
  assert.ok(deformParts([part('rail', 'stone', box(-2, -0.05, 0, 2, 0.05, 0.1))], [{ type: 'bend', axis: 'x', angle: 400 }]).warnings.includes('overlap'));
  return `fold at R = ${(0.5 / (300 * Math.PI / 180)).toFixed(3)} m < half depth 0.3 m`;
});
await t('triangle budget: refinement capped and reported', async () => {
  const g = await generate({ element: 'obelisk' });
  const r = deformParts(g.parts, [{ type: 'twist', axis: 'z', angle: 720 }], { maxTris: 9000, tolerance: 1e-5 });
  assert.ok(r.warnings.includes('refine-capped'), JSON.stringify(r.warnings));
  assert.ok(r.stats.tris <= 9000 * 1.25, `${r.stats.tris}`);
  allOk(r.parts);
  return `${r.stats.tris} tris for a 9000 budget (edge ${r.stats.edge.toFixed(3)} m)`;
});

// ------------------------------------------------------------------------------------------------ smart stretch
await t('smartStretch: column z re-parameterises height (regenerated x1.5)', async () => {
  const g = await generate({ element: 'column', order: 'ionic' });
  const s = smartStretch(g.spec, 'z', 1.5, g.size);
  rel(s.height, g.size[2] * 1.5, 1e-12, 'height');
  const g2 = await generate(s);
  rel(g2.size[2], g.size[2] * 1.5, 0.005, 'regenerated height');
  assert.equal(smartStretch(g.spec, 'x', 1.5, g.size), null, 'no x parameter on a column');
  return `${g.size[2].toFixed(3)} -> ${g2.size[2].toFixed(3)} m`;
});
await t('smartStretch: balustrade x re-arrays balusters', async () => {
  const g = await generate({ element: 'balustrade', length: 3 });
  const s = smartStretch(g.spec, 'x', 1.5, g.size), g2 = await generate(s);
  near(s.length, 4.5, 1e-12, 'length'); rel(g2.size[0], 4.5, 0.005, 'regenerated length');
  const n1 = named(g.parts, 'baluster')[0].transforms.length / 16, n2 = named(g2.parts, 'baluster')[0].transforms.length / 16;
  assert.ok(n2 > n1, `${n1} -> ${n2}`);
  const s2 = smartStretch({ ...g.spec, balusters: 10 }, 'x', 2);
  assert.equal(s2.balusters, 20);
  return `balusters ${n1} -> ${n2}`;
});
await t('smartStretch: arcade x, roof z, dome y, portico x, clamps and nulls', async () => {
  const a = await generate({ element: 'arcade' });
  const sa = smartStretch(a.spec, 'x', 2, a.size), a2 = await generate(sa);
  rel(a2.size[0], a.size[0] * 2, 0.005, 'arcade length'); assert.equal(sa.bays, 6);
  const r = await generate({ element: 'roof' });
  const sr = smartStretch(r.spec, 'z', 1.2, r.size), r2 = await generate(sr);
  rel(r2.size[2], r.size[2] * 1.2, 0.005, 'roof height');
  assert.equal(smartStretch({ element: 'dome', diameter: 8 }, 'y', 1.25).diameter, 10);
  assert.equal(smartStretch({ element: 'dome' }, 'x', 1.5, [20, 20, 12]).diameter, 12, 'the default diameter, not the bbox');
  const cp = await generate({ element: 'column', order: 'doric', pedestal: true }), cs = smartStretch(cp.spec, 'z', 1.2, cp.size);
  rel((await generate(cs)).size[2], cp.size[2] * 1.2, 0.005, 'column with pedestal');
  assert.equal(smartStretch({ element: 'portico', columns: 4 }, 'x', 1.5).columns, 6);
  assert.equal(smartStretch({ element: 'portico', columns: 4 }, 'z', 1.5), null);
  assert.equal(smartStretch({ element: 'obelisk', height: 100 }, 'z', 2).height, 120, 'clamped to SCHEMA');
  assert.equal(smartStretch({ element: 'capital', order: 'ionic' }, 'z', 1.3, [1, 1, 1]), null);
  assert.equal(smartStretch({ element: 'column' }, 'z', 1.3), null, 'no size, no height');
  assert.equal(smartStretch({ element: 'column', height: 5 }, 'q', 1.3), null);
  return `arcade ${a.size[0].toFixed(2)} -> ${a2.size[0].toFixed(2)} m (${sa.bays} bays), roof ${r.size[2].toFixed(2)} -> ${r2.size[2].toFixed(2)} m`;
});

// ------------------------------------------------------------------------------------------------ performance
await t('perf: Corinthian column bend + twist < 600 ms', async () => {
  const g = await generate({ element: 'column', order: 'corinthian' });
  const ops = [{ type: 'bend', axis: 'z', angle: 20 }, { type: 'twist', axis: 'z', angle: 90 }];
  const runs = [];
  let last;
  for (let i = 0; i < 3; i++) { const t0 = performance.now(); last = deformParts(g.parts, ops); runs.push(performance.now() - t0); }
  allOk(last.parts);
  const best = Math.min(...runs);
  assert.ok(best < 600, `${runs.map((x) => x.toFixed(0)).join(', ')} ms`);
  return `${g.tris} tris -> ${last.stats.tris}; runs ${runs.map((x) => x.toFixed(0)).join(' / ')} ms; stages ${JSON.stringify(last.stats.timing)}`;
});

// ------------------------------------------------------------------------------------------------ report
if (!PREVIEWS_ONLY) {
  const w = [Math.max(...rows.map((r) => r[0].length)), 4, 6];
  console.log(`${'test'.padEnd(w[0])}  res   ms    note`);
  for (const r of rows) console.log(`${r[0].padEnd(w[0])}  ${r[1].padEnd(4)} ${r[2].padStart(5)}  ${r[3]}`);
  console.log(failed ? `${failed} of ${rows.length} FAILED` : `all ${rows.length} deform tests passed`);
}
if (process.argv.includes('--previews')) {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const c = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--previews-only'], { stdio: 'inherit' });
  if (c.status) failed++;
}

// ------------------------------------------------------------------------------------------------ previews
if (PREVIEWS_ONLY) {
  const { renderPNG, sheet } = await import('./raster.mjs');
  const OUT = '/Volumes/LaCie/morph3d/archkit/previews/deform/';
  fs.mkdirSync(OUT, { recursive: true });
  // shared framing: tiny markers at the union bbox corners, so before and after are drawn at one scale
  const frame = (bb) => {
    const d = Math.hypot(...[0, 1, 2].map((k) => bb.max[k] - bb.min[k])) * 4e-4, xs = [];
    for (let k = 0; k < 8; k++) xs.push(mat.T(k & 1 ? bb.max[0] : bb.min[0], k & 2 ? bb.max[1] : bb.min[1], k & 4 ? bb.max[2] : bb.min[2]));
    return part('frame', 'stone', box(-d, -d, -d, d, d, d), instances(xs));
  };
  const union = (a, b) => ({ min: [0, 1, 2].map((k) => Math.min(a.min[k], b.min[k])), max: [0, 1, 2].map((k) => Math.max(a.max[k], b.max[k])) });
  const dots = (pts, r) => part('lattice', 'accent', W.Manifold.sphere(r, 12), instances(pts.map((p) => mat.T(...p))));
  const shot = async (name, spec, ops, views, opts = {}) => {
    const g = await generate(spec), r = deformParts(g.parts, typeof ops === 'function' ? ops(g) : ops, opts);
    let before = g.parts, after = r.parts;
    const ffd = r.deformer.compiled.find((c) => c.type === 'ffd');
    if (ffd) {
      const lat = ffd.lattice, rad = Math.hypot(...lat.size) * 0.008, rest = [], moved = [];
      for (let i = 0; i < lat.count; i++) { const p = [0, 1, 2].map((a) => lat.rest[3 * i + a]); rest.push(p); moved.push(p.map((x, a) => x + ffd.offsets[3 * i + a])); }
      before = [...before, dots(rest, rad)]; after = [...after, dots(moved, rad)];
    }
    const bb = union(partsBBox(before), partsBBox(after));
    before = [...before, frame(bb)]; after = [...after, frame(bb)];
    const imgs = [];
    for (const v of views) imgs.push(renderPNG(before, { size: 520, view: v }), renderPNG(after, { size: 520, view: v }));
    fs.writeFileSync(OUT + name + '.png', sheet(imgs, imgs.length));
    console.log(`preview ${name}: ${r.stats.ms.toFixed(0)} ms, ${g.tris} -> ${r.stats.tris} tris, warnings [${r.warnings}]`);
  };
  const capFlare = (g) => {
    const dims = [2, 2, 2], lat = ffdLattice(dims, g.bbox), pins = {};
    for (const [i, j] of [[0, 0], [2, 0], [0, 2], [2, 2]]) { const id = lat.index(i, j, 2), p = [0, 1, 2].map((a) => lat.rest[3 * id + a]); pins[id] = [p[0] * 1.35, p[1] * 1.35, p[2] + 0.08]; }
    return [{ type: 'ffd', dims, pins }];
  };
  const capDrag = (g) => {
    const dims = [3, 3, 3], lat = ffdLattice(dims, g.bbox), id = lat.index(3, 0, 3), p = [0, 1, 2].map((a) => lat.rest[3 * id + a]);
    return [{ type: 'ffd', dims, pins: { [id]: [p[0] + 0.15, p[1] - 0.15, p[2] + 0.06] } }];
  };
  await shot('curved-balustrade', { element: 'balustrade', length: 6, urns: true }, [{ type: 'bend', axis: 'x', angle: 150 }], ['three-quarter', 'top']);
  await shot('curved-cornice', { element: 'cornice', order: 'corinthian', length: 4, returns: false }, [{ type: 'bend', axis: 'x', angle: 120 }], ['three-quarter', 'top']);
  await shot('curved-entablature', { element: 'entablature', order: 'ionic', length: 4 }, [{ type: 'bend', axis: 'x', angle: 180 }], ['three-quarter', 'top']);
  await shot('curved-arcade', { element: 'arcade', bays: 5 }, [{ type: 'bend', axis: 'x', angle: -70 }], ['three-quarter', 'top']);
  await shot('bent-column', { element: 'column', order: 'ionic' }, [{ type: 'bend', axis: 'z', angle: 25 }], ['three-quarter', 'front']);
  await shot('twisted-column', { element: 'column', order: 'doric' }, [{ type: 'twist', axis: 'z', angle: 180 }], ['three-quarter', 'close']);
  await shot('tapered-obelisk', { element: 'obelisk' }, [{ type: 'taper', axis: 'z', scale: 0.45 }], ['three-quarter', 'front']);
  await shot('tapered-column', { element: 'column', order: 'corinthian' }, [{ type: 'taper', axis: 'z', scale: 0.6 }], ['front', 'close']);
  await shot('tapered-finial', { element: 'finial' }, [{ type: 'taper', axis: 'z', scale: 0.5 }], ['front', 'three-quarter']);
  await shot('stretched-column', { element: 'column', order: 'corinthian', pedestal: true }, [{ type: 'stretch', axis: 'z', factor: 1.4 }], ['front', 'close']);
  await shot('lean-column', { element: 'column', order: 'tuscan' }, [{ type: 'shear', axis: 'z', dx: 0.35 }], ['front', 'three-quarter']);
  await shot('ffd-capital', { element: 'capital', order: 'corinthian' }, capFlare, ['three-quarter', 'front']);
  await shot('ffd-capital-drag', { element: 'capital', order: 'corinthian' }, capDrag, ['three-quarter', 'top']);
}
process.exit(failed ? 1 : 0);
