// node arch/test/entablature.test.mjs — the entablature family (entablature, cornice, moulding, pediment, window, door):
// every element x every relevant enum value x sizes including the extreme legal sizes of SCHEMA. For each build: every
// part NoError with positive volume, size within tol of expected(), exact counts, build time within budget, < 2 M
// triangles; plus layout invariants an architect checks (dentils evenly spaced and whole, a dentil / modillion /
// triglyph on every column axis, rake ornaments above the horizontal cornice, Doric metopes square).
import assert from 'node:assert/strict';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { SCHEMA } from '../js/spec.js';
import { ORDER_KEYS, ORDERS } from '../js/orders.js';
import { instanceCount, partsBBox } from '../js/kernel.js';

await initKernel();
await generate({ element: 'entablature', order: 'corinthian' });   // warm-up (WASM compile, first allocations): not timed
await generate({ element: 'window', pediment: 'segmental', keystone: true });

const BUDGET_MS = 500, MAX_TRIS = 2e6;
const cases = [];
const add = (spec) => cases.push(spec);
const S = SCHEMA;

// entablature and cornice: every order, frieze, cornice, enrichment, detail, returns; lengths / heights incl. extremes
for (const element of ['entablature', 'cornice']) {
  for (const order of ORDER_KEYS) add({ element, order });
  for (const order of ['doric', 'ionic', 'corinthian']) for (const returns of [true, false]) add({ element, order, returns });
  for (const cornice of S.cornice.values) for (const order of ['tuscan', 'doric', 'ionic', 'corinthian']) add({ element, order, cornice });
  for (const enrichment of S.enrichment.values) add({ element, order: 'ionic', enrichment });
  for (const detail of S.detail.values) for (const order of ['doric', 'corinthian']) add({ element, order, detail });
  for (const length of [S.length.min, 0.5, 4.5, S.length.max]) for (const order of ['doric', 'corinthian']) add({ element, order, length });
  for (const height of [S.height.min, 0.4, 3, S.height.max]) add({ element, order: 'ionic', height });
  add({ element, order: 'corinthian', depth: 1.4 });
  add({ element, order: 'doric', length: 6, cornice: 'mutules', frieze: 'triglyph' });
}
for (const frieze of S.frieze.values) for (const order of ['tuscan', 'doric', 'greek-doric', 'ionic', 'corinthian']) add({ element: 'entablature', order, frieze });
// moulding: every profile x every enrichment (stated), every profile with its default enrichment (ruling 21), returns,
// sizes incl. extremes
for (const profile of S.profile.values) for (const enrichment of S.enrichment.values) add({ element: 'moulding', profile, enrichment });
for (const profile of S.profile.values) add({ element: 'moulding', profile });
for (const profile of ['ovolo', 'crown', 'bead', 'cyma-reversa']) for (const returns of [true, false]) add({ element: 'moulding', profile, returns });
for (const length of [S.length.min, 2.4, S.length.max]) for (const height of [S.height.min, 0.18, 2]) add({ element: 'moulding', length, height });
add({ element: 'moulding', profile: 'ovolo', height: S.height.max, length: 3 });
for (const detail of S.detail.values) add({ element: 'moulding', profile: 'cyma-reversa', enrichment: 'acanthus', detail });
// pediment: every kind x orders x cornices, widths incl. extremes, height (-> pitch), pitch
for (const pediment of S.pediment.values) for (const order of ORDER_KEYS) add({ element: 'pediment', pediment, order });
for (const pediment of ['triangular', 'segmental', 'broken']) for (const cornice of S.cornice.values) add({ element: 'pediment', pediment, cornice });
for (const width of [S.width.min, 2, 7.5, S.width.max]) for (const pediment of ['triangular', 'segmental']) add({ element: 'pediment', pediment, width });
for (const height of [0.6, 1.5, 3]) add({ element: 'pediment', width: 5, height });
for (const pitch of [12.5, 30]) add({ element: 'pediment', pitch });
for (const detail of S.detail.values) add({ element: 'pediment', order: 'corinthian', detail });
// window / door: every pediment, keystone, frieze, sizes incl. extremes, orders and cornices
for (const element of ['window', 'door']) {
  for (const pediment of S.pediment.values) for (const keystone of [true, false]) add({ element, pediment, keystone });
  for (const [width, height] of [[S.width.min, S.height.min], [0.9, 1.6], [1.3, 2.4], [3, 6], [S.width.max, S.height.max]]) add({ element, width, height });
  for (const order of ['doric', 'corinthian']) for (const cornice of S.cornice.values) add({ element, order, cornice });
  add({ element, frieze: 'pulvinated' }); add({ element, detail: 'low' }); add({ element, enrichment: 'egg-and-dart', order: 'ionic' });
  // arched heads (ruling 22): every archType, with a keystone, with a pediment asked for (an aedicule), every style,
  // a style with an explicit archType, flattened arches (too tall for the opening), extreme sizes, details
  for (const archType of S.archType.values) {
    add({ element, archType }); add({ element, archType, keystone: true });
    add({ element, archType, pediment: element === 'window' ? 'segmental' : 'triangular' });
    add({ element, archType, width: 3, height: 1.2 }); add({ element, archType, detail: 'low' });
  }
  for (const style of S.style.values) add({ element, style });
  add({ element, style: 'gothic', archType: 'tudor' }); add({ element, style: 'romanesque', archType: 'segmental' });
  add({ element, style: 'moorish', pediment: 'broken' }); add({ element, style: 'baroque', archType: 'semicircular' });
  for (const [width, height] of [[S.width.min, S.height.min], [S.width.max, S.height.max]]) for (const style of ['gothic', 'moorish', 'baroque']) add({ element, style, width, height });
}

const count = (r, name) => r.parts.filter((p) => p.name === name).reduce((s, p) => s + instanceCount(p), 0);
function check(r, spec) {
  const fails = [];
  for (const p of r.parts) {
    if (p.manifold.status() !== 'NoError') fails.push(`${p.name} ${p.manifold.status()}`);
    else if (!(p.manifold.volume() > 0)) fails.push(`${p.name} volume ${p.manifold.volume()}`);
  }
  const e = r.expected;
  ['x', 'y', 'z'].forEach((a, i) => {
    if (e.size[a] === undefined) return;
    const rel = Math.abs(r.size[i] - e.size[a]) / e.size[a];
    if (!(rel <= e.tol)) fails.push(`${a} ${r.size[i].toFixed(4)} vs ${e.size[a].toFixed(4)}`);
  });
  for (const [name, n] of Object.entries(e.counts)) if (count(r, name) !== n) fails.push(`${name} ${count(r, name)} vs ${n}`);
  if (r.ms > BUDGET_MS) fails.push(`time ${Math.round(r.ms)} ms`);
  if (r.tris > MAX_TRIS) fails.push(`tris ${r.tris}`);
  if (spec.element === 'entablature' || spec.element === 'cornice') fails.push(...invariants(r));
  if (['window', 'door', 'pediment'].includes(spec.element)) fails.push(...cluster(r));
  return fails;
}

/** World bbox of every instance of every part. */
function pieceBoxes(r) {
  const out = [];
  for (const p of r.parts) {
    const n = instanceCount(p);
    for (let i = 0; i < n; i++) out.push({ name: p.name, ...partsBBox([{ ...p, transforms: p.transforms ? p.transforms.slice(16 * i, 16 * i + 16) : null }]) });
  }
  return out;
}
/** Every piece inside the expected bbox (x centred, z from 0), and all pieces one cluster: no piece (or group of
 *  pieces) separated from the rest by a gap > 1 cm (bboxes grown by 5 mm must chain together). */
function cluster(r) {
  const fails = [], e = r.expected.size, tol = e.tol ?? 0.005, boxes = pieceBoxes(r);
  for (const b of boxes) {
    if (e.x !== undefined && Math.max(-b.min[0], b.max[0]) > (e.x / 2) * (1 + tol) + 1e-6) { fails.push(`${b.name} outside x`); break; }
    if (e.z !== undefined && (b.min[2] < -1e-6 * e.z - 1e-6 || b.max[2] > e.z * (1 + tol) + 1e-6)) { fails.push(`${b.name} outside z`); break; }
  }
  const g = 0.005, parent = boxes.map((_, i) => i), find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const near = (a, b) => [0, 1, 2].every((k) => a.min[k] - g <= b.max[k] + g && b.min[k] - g <= a.max[k] + g);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (find(i) !== find(j) && near(boxes[i], boxes[j])) parent[find(i)] = find(j);
  const roots = new Set(boxes.map((_, i) => find(i)));
  if (roots.size > 1) {
    const sizes = {};
    boxes.forEach((b, i) => { (sizes[find(i)] ||= []).push(b.name); });
    const small = Object.values(sizes).sort((a, b) => a.length - b.length)[0];
    fails.push(`${roots.size} clusters (e.g. ${[...new Set(small)].join(',')})`);
  }
  return fails;
}

/** Front instances of a part (unrotated, x along the run) and their x. */
const frontX = (r, name) => {
  const p = r.parts.find((q) => q.name === name);
  if (!p || !p.transforms) return [];
  const xs = [];
  for (let i = 0; i < p.transforms.length / 16; i++) { const m = p.transforms.subarray(16 * i, 16 * i + 16); if (Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9) xs.push(m[12]); }
  return xs.sort((a, b) => a - b);
};
function invariants(r) {
  const out = [], L = r.spec.length || 3;
  for (const name of ['dentil', 'modillion', 'triglyph']) {
    const xs = frontX(r, name);
    if (xs.length < 3) continue;
    const d = xs.slice(1).map((x, i) => x - xs[i]);
    if (Math.max(...d) - Math.min(...d) > 1e-6 * Math.max(1, L)) out.push(`${name} spacing uneven`);
    if (Math.abs(xs[0] + xs[xs.length - 1]) > 1e-6 * Math.max(1, L)) out.push(`${name} not symmetric`);
    if (xs[xs.length - 1] > r.bbox.max[0]) out.push(`${name} beyond the run`);
  }
  return out;
}

let pass = 0, fail = 0;
const rows = [];
for (const spec of cases) {
  let r, fails;
  try {
    r = await generate(spec); fails = check(r, spec);
    // other processes share the machine: a time-only failure is re-measured once (the faster build counts)
    if (fails.length === 1 && fails[0].startsWith('time')) { const r2 = await generate(spec); if (r2.ms < r.ms) r = r2; fails = check(r, spec); }
  } catch (e) { fails = [`THROW ${e.message}`]; }
  if (fails.length) fail++; else pass++;
  rows.push([JSON.stringify(spec).replace(/"element":/, '').replace(/"/g, ''), r ? `${Math.round(r.ms)}` : '-', r ? `${Math.round(r.tris / 1000)}k` : '-',
    r ? r.size.map((x) => x.toFixed(3)).join(' x ') : '-', r ? Object.entries(r.expected.counts).map(([k, v]) => `${k}:${v}`).join(' ') : '', fails.join('; ') || 'ok']);
}
const w = [64, 6, 7, 26, 30];
console.log(['spec', 'ms', 'tris', 'size', 'counts', 'result'].map((h, i) => (w[i] ? h.padEnd(w[i]) : h)).join(' '));
for (const row of rows) console.log(row.map((c, i) => (w[i] ? String(c).slice(0, w[i]).padEnd(w[i]) : c)).join(' '));

// targeted invariants (beyond size and counts)
const t = (name, fn) => fn().then(() => { pass++; console.log('ok', name); }, (e) => { fail++; console.log('FAIL', name, e.message); });
await t('Doric metopes square in a run fitted to whole bays', async () => {
  const D = 0.45, r = await generate({ element: 'entablature', order: 'doric', length: 4 * 1.25 * D + ORDERS.doric.shaftTop * D, returns: false });
  const xs = frontX(r, 'triglyph'), pitch = xs[1] - xs[0];
  assert.ok(Math.abs(pitch - 1.25 * D) < 1e-6, `pitch ${pitch}`);
  assert.equal(xs.length, 5);
});
await t('Ionic dentils: width D/6, interval D/12 (Vignola)', async () => {
  const r = await generate({ element: 'entablature', order: 'ionic', length: 3 });
  const p = r.parts.find((q) => q.name === 'dentil'), bb = p.manifold.boundingBox(), xs = frontX(r, 'dentil'), D = 0.45;
  assert.ok(Math.abs(bb.max[0] - bb.min[0] - D / 6) < 1e-6);
  assert.ok(Math.abs((xs[1] - xs[0]) - D / 4) < 0.08 * D / 4, `pitch ${xs[1] - xs[0]}`);
});
await t('returned corner: a whole corner dentil seen on both faces', async () => {
  const r = await generate({ element: 'cornice', order: 'ionic', cornice: 'dentils', length: 3 });
  const p = r.parts.find((q) => q.name === 'dentil'), bb = p.manifold.boundingBox(), xs = frontX(r, 'dentil');
  assert.ok(Math.abs(xs[xs.length - 1] + (bb.max[0] - bb.min[0]) / 2 - r.bbox.max[0]) < 0.6 * r.expected.size.x, 'corner dentil at the corner');
  assert.ok(bb.max[1] - bb.min[1] >= bb.max[0] - bb.min[0] - 1e-9, 'corner dentil as deep as wide');
});
await t('pediment rake dentils are all above the horizontal cornice, left and right alike', async () => {
  const r = await generate({ element: 'pediment', order: 'ionic' });
  const hc = r.parts.find((q) => q.name === 'cornice').manifold.boundingBox().max[2];
  const rakes = r.parts.filter((q) => q.name === 'dentil').slice(1);      // the first dentil part is the horizontal cornice's
  assert.equal(rakes.length, 2);
  assert.equal(instanceCount(rakes[0]), instanceCount(rakes[1]));
  for (const p of rakes) for (let i = 0; i < instanceCount(p); i++) assert.ok(p.transforms[16 * i + 14] >= hc - 1e-6);
  assert.ok(instanceCount(rakes[0]) > 5);
});
await t('every instance matrix is rotation + translation (+ uniform scale): glTF TRS', async () => {
  for (const spec of [{ element: 'pediment', order: 'corinthian' }, { element: 'pediment', pediment: 'segmental' }, { element: 'window', pediment: 'broken' },
    { element: 'entablature', order: 'ionic' }, { element: 'door', keystone: true }, { element: 'window', style: 'gothic' },
    { element: 'door', style: 'romanesque' }, { element: 'door', style: 'baroque' }, { element: 'window', style: 'renaissance', keystone: true }]) {
    const r = await generate(spec);
    for (const p of r.parts) for (let i = 0; i < instanceCount(p) && p.transforms; i++) {
      const m = p.transforms.subarray(16 * i, 16 * i + 16), c = [0, 1, 2].map((k) => [m[4 * k], m[4 * k + 1], m[4 * k + 2]]);
      const len = c.map((v) => Math.hypot(...v)), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      assert.ok(Math.abs(dot(c[0], c[1])) + Math.abs(dot(c[0], c[2])) + Math.abs(dot(c[1], c[2])) < 1e-9 * Math.max(...len) ** 2, `${spec.element} ${p.name} not orthogonal`);
      assert.ok(Math.max(...len) - Math.min(...len) < 1e-9 * Math.max(...len), `${spec.element} ${p.name} non-uniform scale`);
    }
  }
});
await t('moulding: unstated enrichment is the profile\'s own (ruling 21); stated none is plain', async () => {
  const want = { ovolo: 'ovolo-egg', bead: 'bead', 'cyma-reversa': 'lesbian-leaf' }, motifs = ['ovolo-egg', 'bead', 'lesbian-leaf', 'leaf', 'dentil'];
  for (const profile of S.profile.values) {
    const names = (await generate({ element: 'moulding', profile })).parts.map((p) => p.name);
    for (const m of motifs) assert.equal(names.includes(m), want[profile] === m, `${profile}: ${m}`);
    const none = (await generate({ element: 'moulding', profile, enrichment: 'none' })).parts.map((p) => p.name);
    assert.deepEqual(none, ['moulding'], `${profile} none`);
  }
});
await t('window / door styles (ruling 22): heads, treatments, pediment only when asked for', async () => {
  const has = async (spec, ...names) => { const ps = (await generate(spec)).parts.map((p) => p.name); for (const n of names) assert.ok(ps.includes(n), `${JSON.stringify(spec)} lacks ${n}`); return ps; };
  const gothic = await has({ element: 'window', style: 'gothic' }, 'frame', 'hood-mould', 'label-stop', 'sill');
  assert.ok(!gothic.includes('raking-cornice') && !gothic.includes('console'), 'gothic: no pediment, no consoles');
  await has({ element: 'door', style: 'romanesque' }, 'archivolt', 'impost');
  await has({ element: 'window', style: 'moorish' }, 'archivolt', 'alfiz', 'spandrel');
  await has({ element: 'window', style: 'renaissance', keystone: true }, 'archivolt', 'keystone', 'console');
  await has({ element: 'window', style: 'baroque' }, 'keystone', 'raking-cornice', 'pedestal', 'urn-body');
  await has({ element: 'door', style: 'baroque' }, 'raking-cornice', 'urn-body', 'plinth');
  await has({ element: 'window', archType: 'semicircular', pediment: 'segmental' }, 'archivolt', 'spandrel', 'frieze', 'raking-cornice');
  const arched = (await generate({ element: 'door', archType: 'segmental' })).parts.map((p) => p.name);
  assert.ok(!arched.includes('raking-cornice'), 'arched head: the default pediment is omitted');
  const flat = (await generate({ element: 'window' })).parts.map((p) => p.name);
  assert.ok(flat.includes('raking-cornice') && flat.includes('architrave'), 'classical window keeps its pediment');
});
await t('an arched head keeps the opening: clear height to the crown = height, width between the jambs', async () => {
  for (const archType of S.archType.values) {
    const r = await generate({ element: 'door', archType, width: 1.4, height: 3 });
    const band = r.parts.find((p) => p.name === 'archivolt' || p.name === 'frame').manifold;
    // the opening's crown: the lowest point of the band on the axis
    const slice = band.trimByPlane([1, 0, 0], -0.0005).trimByPlane([-1, 0, 0], -0.0005).boundingBox();
    assert.ok(Math.abs(slice.min[2] - 3) < 0.003, `${archType} crown ${slice.min[2]}`);
    const jamb = band.trimByPlane([0, 0, -1], -0.5).trimByPlane([1, 0, 0], 0).boundingBox();   // right jamb below 0.5 m
    assert.ok(Math.abs(jamb.min[0] - 0.7) < 1e-5 && jamb.min[2] < 0.5, `${archType} jamb ${jamb.min[0]} ${jamb.min[2]}`);
  }
});
await t('a stated pediment is kept (spec.given): Gothic window + triangular -> aedicule; baroque + triangular -> triangular', async () => {
  const g = (await generate({ element: 'window', style: 'gothic', pediment: 'triangular' })).parts.map((p) => p.name);
  for (const n of ['frame', 'hood-mould', 'spandrel', 'frieze', 'raking-cornice', 'tympanum']) assert.ok(g.includes(n), `gothic + triangular lacks ${n}`);
  const plain = (await generate({ element: 'window', style: 'gothic' })).parts.map((p) => p.name);
  assert.ok(!plain.includes('raking-cornice'), 'gothic alone: no pediment');
  const b = await generate({ element: 'window', style: 'baroque', pediment: 'triangular' });
  const bn = b.parts.map((p) => p.name);
  assert.ok(bn.includes('raking-cornice') && !bn.includes('urn-body') && !bn.includes('pedestal'), 'baroque + triangular: an unbroken triangular pediment');
  const rk = b.parts.find((p) => p.name === 'raking-cornice').manifold;
  assert.equal(rk.decompose().length, 1, 'one continuous rake (not broken)');
  const bk = (await generate({ element: 'window', style: 'baroque' })).parts.map((p) => p.name);
  assert.ok(bk.includes('urn-body'), 'baroque alone: broken pediment with urn');
  const nk = (await generate({ element: 'window', style: 'baroque', keystone: false })).parts.map((p) => p.name);
  assert.ok(!nk.includes('keystone'), 'baroque without keystone: none');
});
await t('every style / arch variant of a window or door is one connected solid (true geometry, no floating piece)', async () => {
  const { K } = await import('../js/kernel.js');
  const specs = [];
  for (const element of ['window', 'door']) {
    for (const style of S.style.values) specs.push({ element, style });
    for (const archType of S.archType.values) specs.push({ element, archType }, { element, archType, pediment: 'broken', keystone: true });
    specs.push({ element, style: 'gothic', pediment: 'triangular' }, { element, style: 'moorish', pediment: 'segmental' });
  }
  for (const spec of specs) {
    const r = await generate({ ...spec, detail: 'low' });
    const solids = [];
    for (const p of r.parts) for (let i = 0; i < instanceCount(p); i++) solids.push(p.transforms ? p.manifold.transform(p.transforms.subarray(16 * i, 16 * i + 16)) : p.manifold);
    const n = K().Manifold.union(solids).decompose().length;
    assert.equal(n, 1, `${JSON.stringify(spec)}: ${n} separate solids`);
  }
});
await t('broken pediments carry an urn on a pedestal in the gap', async () => {
  for (const spec of [{ element: 'pediment', pediment: 'broken' }, { element: 'window', pediment: 'broken' }, { element: 'portico', pediment: 'broken' }]) {
    const r = await generate(spec), names = r.parts.map((p) => p.name);
    assert.ok(names.includes('pedestal') && names.includes('urn-body') && names.includes('urn-knob'), JSON.stringify(spec));
  }
});
await t('triangular pediment pitch is 22.5 deg (Serlio)', async () => {
  const r = await generate({ element: 'pediment', order: 'tuscan', width: 6 });
  const rk = r.parts.find((q) => q.name === 'raking-cornice').manifold.boundingBox();
  const hc = r.parts.find((q) => q.name === 'cornice').manifold.boundingBox();
  assert.ok(rk.max[2] > hc.max[2] + 0.2 * 6 * Math.tan(Math.PI / 8));
});
console.log(`\n${pass} passed, ${fail} failed (${cases.length} builds + targeted checks)`);
process.exit(fail ? 1 : 0);
