// Arch family tests: node arch/test/arch.test.mjs [--quick]
// Every arch type x supports x keystone, every order and style that changes the treatment, every detail level, and
// the extreme legal sizes (span 0.3 m and 40 m, 1 and 20 bays, tall and squat heights, an arcade by length): built via
// generate(), every part NoError with positive volume, size within tol of expected(), counts exact, time and
// triangle budgets met.
import assert from 'node:assert/strict';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { SCHEMA } from '../js/spec.js';
import { ORDER_KEYS } from '../js/orders.js';
import { solids } from './solid.mjs';

await initKernel();
const quick = process.argv.includes('--quick');
const TYPES = SCHEMA.archType.values, SUPPORTS = SCHEMA.supports.values;
const cases = [];
const add = (name, spec) => cases.push({ name, spec });

for (const element of ['arch', 'arcade']) {
  for (const archType of TYPES) for (const supports of SUPPORTS) for (const keystone of [true, false]) {
    add(`${element} ${archType} ${supports}${keystone ? '' : ' no-key'}`, { element, archType, supports, keystone });
  }
}
for (const order of ORDER_KEYS) for (const supports of SUPPORTS) for (const element of ['arch', 'arcade']) {
  add(`${element} ${order} ${supports}`, { element, order, supports });
}
for (const order of ['doric', 'ionic', 'corinthian']) add(`arcade ${order} 6 m high`, { element: 'arcade', order, height: 6 });
add('arcade ionic 4 m span 6 m high', { element: 'arcade', order: 'ionic', span: 4, height: 6 });
for (const style of ['gothic', 'romanesque', 'byzantine', 'moorish', 'renaissance', 'modern', 'art-deco', 'egyptian']) {
  add(`arcade style ${style}`, { element: 'arcade', style });
  add(`arch style ${style} columns`, { element: 'arch', style, supports: 'columns' });
}
for (const detail of SCHEMA.detail.values) for (const archType of TYPES) {
  add(`arch ${archType} ${detail}`, { element: 'arch', archType, detail });
  add(`arcade ${archType} ${detail} columns`, { element: 'arcade', archType, detail, supports: 'columns', order: 'ionic' });
}
for (const material of ['brick', 'marble']) for (const archType of TYPES) add(`arch ${archType} ${material}`, { element: 'arch', archType, material });
// sizes: extreme legal spans, bay counts, heights, lengths
for (const span of [0.3, 1, 6, 15, 40]) for (const archType of TYPES) {
  add(`arch ${archType} span ${span}`, { element: 'arch', archType, span });
  if (!quick) add(`arcade ${archType} span ${span} columns`, { element: 'arcade', archType, span, supports: 'columns' });
}
for (const bays of [1, 2, 7, 20]) {
  add(`arcade ${bays} bays`, { element: 'arcade', bays });
  add(`arcade ${bays} bays corinthian columns`, { element: 'arcade', bays, supports: 'columns', order: 'corinthian' });
  add(`arcade ${bays} bays pointed`, { element: 'arcade', bays, archType: 'pointed' });
}
for (const height of [0.05, 1, 3.9, 8, 30, 120]) {
  add(`arch height ${height}`, { element: 'arch', height });
  add(`arch tudor height ${height} columns`, { element: 'arch', archType: 'tudor', height, supports: 'columns' });
}
for (const order of ['corinthian', 'composite', 'solomonic', 'ionic']) add(`arcade 20 bays ${order} arch order`, { element: 'arcade', bays: 20, order });
add('arcade 12 bays composite arch order', { element: 'arcade', bays: 12, order: 'composite' });
add('arcade 20 bays brick', { element: 'arcade', bays: 20, material: 'brick' });
add('arcade 20 bays 40 m brick', { element: 'arcade', bays: 20, span: 40, material: 'brick' });
add('arch 2.6 wide 3.9 high', { element: 'arch', span: 2.6, height: 3.9 });
add('arcade 18 m long', { element: 'arcade', length: 18 });
add('arcade 18 m long 5 bays', { element: 'arcade', length: 18, bays: 5 });
add('arcade 120 m long', { element: 'arcade', length: 120 });
add('arcade 0.1 m long', { element: 'arcade', length: 0.1 });
add('arcade 40 m span 20 bays', { element: 'arcade', span: 40, bays: 20 });
add('arcade 0.3 m span 20 bays corinthian columns', { element: 'arcade', span: 0.3, bays: 20, supports: 'columns', order: 'corinthian' });
add('arcade wall depth 1.2', { element: 'arcade', depth: 1.2 });
add('arch absurd values', { element: 'arch', span: -4, height: 1e6, bays: 999 });

const SINGLE = 500, ASSEMBLY = 1500, TRIS = 2e6;
let fails = 0, worst = { ms: 0 }, maxTris = { tris: 0 };
const rows = [];
// the caller owns what build() returns: free each build (WASM memory is not collected by the JS heap's pace)
const freeAll = (r) => { const seen = new Set(); for (const p of r.parts) if (!seen.has(p.manifold)) { seen.add(p.manifold); p.manifold.delete(); } };
for (const c of cases) {
  try {
    const r = await generate(c.spec);
    const e = r.expected;
    for (const p of r.parts) {
      assert.equal(p.manifold.status(), 'NoError', `${p.name} not manifold`);
      assert.ok(p.manifold.volume() > 0, `${p.name} has no volume`);
    }
    const tol = e.tol ?? 0.005;
    for (const [i, ax] of [[0, 'x'], [1, 'y'], [2, 'z']]) {
      if (e.size[ax] === undefined) continue;
      assert.ok(Math.abs(r.size[i] - e.size[ax]) <= tol * e.size[ax], `${ax} ${r.size[i].toFixed(4)} vs expected ${e.size[ax].toFixed(4)}`);
    }
    for (const [name, n] of Object.entries(e.counts)) {
      const got = r.parts.filter((p) => p.name === name).reduce((s, p) => s + (p.transforms ? p.transforms.length / 16 : 1), 0);
      assert.equal(got, n, `count ${name}: ${got} vs ${n}`);
    }
    // an arcade, or an arch that carries columns (on columns or dressed with half-columns), is an assembly of elements
    const assembly = r.spec.element === 'arcade' || r.parts.some((p) => p.name.startsWith('column-'));
    const budget = assembly ? ASSEMBLY : SINGLE;
    assert.ok(r.ms < budget, `build ${Math.round(r.ms)} ms over ${budget} ms`);
    assert.ok(r.tris < TRIS, `${r.tris} triangles`);
    if (r.ms > worst.ms) worst = { ms: r.ms, name: c.name };
    if (r.tris > maxTris.tris) maxTris = { tris: r.tris, name: c.name };
    rows.push(`ok   ${c.name.padEnd(44)} ${String(Math.round(r.ms)).padStart(5)} ms ${String(r.tris).padStart(8)} tris  x ${r.size[0].toFixed(3).padStart(8)} z ${r.size[2].toFixed(3).padStart(8)}  ${Object.entries(e.counts).map(([k, n]) => `${k}:${n}`).join(' ')}`);
    freeAll(r);
  } catch (err) {
    fails++;
    rows.push(`FAIL ${c.name.padEnd(44)} ${err.message.split('\n')[0]}`);
  }
}
// Ownership (family conventions, "Ownership of returned manifolds"): the caller owns and may delete every returned
// manifold. Build, delete everything, build the same again; then re-initialise the kernel and build once more.
const OWN = [
  { element: 'arcade', bays: 5, supports: 'columns', order: 'tuscan' },     // the crash: memoised columns
  { element: 'arch', order: 'corinthian' },                                  // console keystone carvings + half-columns
  { element: 'arcade', order: 'corinthian', supports: 'columns' },           // lightened columns
  { element: 'arch', archType: 'horseshoe' }, { element: 'arch', material: 'brick', archType: 'pointed' },
];
const ownRound = async (label) => {
  for (const spec of OWN) {
    const name = `ownership ${label}: ${JSON.stringify(spec)}`;
    try {
      const r = await generate(spec);
      for (const p of r.parts) assert.equal(p.manifold.status(), 'NoError', `${p.name} not manifold`);
      const tol = r.expected.tol ?? 0.005;
      assert.ok(Math.abs(r.size[0] - r.expected.size.x) <= tol * r.expected.size.x, `x ${r.size[0]} vs ${r.expected.size.x}`);
      freeAll(r);
      rows.push(`ok   ${name}`);
    } catch (err) { fails++; rows.push(`FAIL ${name} ${err.message.split('\n')[0]}`); }
  }
};
// Printability: every arch and arcade unions into ONE solid (columns seated in their dosserets, ring stones tenoned
// into the wall). Every archType x supports x bays (1, 3) x order (tuscan, corinthian), plus the other treatments.
const PRINT = [];
for (const archType of TYPES) for (const supports of SUPPORTS) for (const bays of [1, 3]) for (const order of ['tuscan', 'corinthian']) {
  PRINT.push({ element: bays === 1 ? 'arch' : 'arcade', archType, supports, bays, order });
}
for (const style of ['moorish', 'romanesque', 'gothic', 'modern', 'egyptian']) PRINT.push({ element: 'arcade', style }, { element: 'arch', style, supports: 'columns' });
for (const archType of TYPES) PRINT.push({ element: 'arch', archType, material: 'brick' }, { element: 'arch', archType, detail: 'low' });
PRINT.push({ element: 'arcade', order: 'doric' }, { element: 'arcade', order: 'ionic' }, { element: 'arch', span: 0.3, supports: 'columns' },
  { element: 'arch', span: 40, archType: 'tudor' }, { element: 'arch', keystone: false, archType: 'pointed' });
for (const spec of PRINT) {
  const name = `one solid: ${JSON.stringify(spec)}`;
  // the union of a Corinthian loggia (every acanthus instance expanded) needs ~1 GB of WASM heap and solid.mjs leaves
  // its temporaries to the GC: give every check a fresh kernel instance, as a recycled browser worker would have
  await initKernel();
  try {
    const r = await generate(spec);
    const t0 = performance.now(), s = solids(r.parts);
    assert.equal(s.length, 1, `${s.length} solids: ${s.slice(1, 4).map((c) => `${c.volume.toFixed(4)} m3 at x ${((c.bbox.min[0] + c.bbox.max[0]) / 2).toFixed(2)}`).join(', ')}`);
    rows.push(`ok   ${name.padEnd(100)} ${String(Math.round(performance.now() - t0)).padStart(6)} ms union`);
    freeAll(r);
  } catch (err) { fails++; rows.push(`FAIL ${name} ${err.message.split('\n')[0]}`); }
}

await ownRound('first build, then delete');
await ownRound('rebuild after delete');
await initKernel();
await ownRound('fresh kernel');

console.log(rows.join('\n'));
const total = cases.length + 3 * OWN.length + PRINT.length;
console.log(`\n${total - fails}/${total} passed; slowest ${Math.round(worst.ms)} ms (${worst.name}); most triangles ${maxTris.tris} (${maxTris.name})`);
if (fails) process.exit(1);
