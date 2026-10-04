// node arch/test/portico.test.mjs — porticoes: every order, column counts 2..16, every pediment, steps 0..8, height /
// width / both incl. the extreme legal sizes of SCHEMA, details. Each build: every part NoError with positive volume,
// size within tol of expected(), shaft count = columns, time < 1500 ms, < 2 M triangles. Invariants: columns on the
// order's axis spacing; a triglyph (Doric), dentil (Ionic) or modillion (Corinthian) centred over every column axis.
import assert from 'node:assert/strict';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { SCHEMA } from '../js/spec.js';
import { ORDER_KEYS, ORDERS } from '../js/orders.js';
import { instanceCount } from '../js/kernel.js';

await initKernel();
await generate({ element: 'portico', order: 'corinthian' });       // warm-up (WASM compile, first allocations): not timed

const BUDGET_MS = 1500, MAX_TRIS = 2e6, S = SCHEMA;
const cases = [];
const add = (spec) => cases.push({ element: 'portico', ...spec });
for (const order of ORDER_KEYS) add({ order });
for (const columns of [S.columns.min, 3, 6, 8, 10, S.columns.max]) for (const order of ['doric', 'ionic', 'corinthian']) add({ order, columns });
for (const pediment of S.pediment.values) for (const order of ['tuscan', 'greek-doric', 'composite']) add({ order, pediment });
for (const steps of [S.steps.min, 1, 5, S.steps.max]) add({ order: 'ionic', steps });
for (const height of [S.height.min, 3, 9, S.height.max]) add({ order: 'doric', height });
for (const width of [S.width.min, 6, 14, S.width.max]) add({ order: 'ionic', width });
add({ order: 'corinthian', height: 8, width: 16 }); add({ order: 'tuscan', columns: 6, height: 5, width: 30 });
for (const detail of S.detail.values) add({ order: 'corinthian', columns: 6, detail });
add({ order: 'ionic', frieze: 'pulvinated' }); add({ order: 'doric', cornice: 'dentils', frieze: 'triglyph' }); add({ order: 'ionic', cornice: 'modillions' });
add({ order: 'corinthian', enrichment: 'none' }); add({ order: 'ionic', depth: 3 }); add({ order: 'tuscan', depth: 0.2 }); add({ order: 'corinthian', pediment: 'segmental', columns: 8 }); add({ order: 'doric', pitch: 15 });

const count = (r, name) => r.parts.filter((p) => p.name === name).reduce((s, p) => s + instanceCount(p), 0);
/** x of the unrotated instances of a part that sit on the front (y < 0). */
const frontX = (r, name) => {
  const out = [];
  for (const p of r.parts.filter((q) => q.name === name)) for (let i = 0; i < instanceCount(p); i++) {
    const m = p.transforms.subarray(16 * i, 16 * i + 16);
    if (Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9) out.push(m[12]);
  }
  return out;
};
function check(r, spec) {
  const fails = [];
  for (const p of r.parts) {
    if (p.manifold.status() !== 'NoError') fails.push(`${p.name} ${p.manifold.status()}`);
    else if (!(p.manifold.volume() > 0)) fails.push(`${p.name} volume`);
  }
  const e = r.expected;
  ['x', 'y', 'z'].forEach((a, i) => {
    if (e.size[a] === undefined) return;
    if (!(Math.abs(r.size[i] - e.size[a]) / e.size[a] <= e.tol)) fails.push(`${a} ${r.size[i].toFixed(3)} vs ${e.size[a].toFixed(3)}`);
  });
  for (const [name, n] of Object.entries(e.counts)) if (count(r, name) !== n) fails.push(`${name} ${count(r, name)} vs ${n}`);
  if (r.ms > BUDGET_MS) fails.push(`time ${Math.round(r.ms)} ms`);
  if (r.tris > MAX_TRIS) fails.push(`tris ${r.tris}`);
  // the column axes: shafts evenly spaced, centred; an ornament over every axis
  const axes = frontX(r, 'shaft').sort((a, b) => a - b);
  const n = spec.columns || 4;
  if (axes.length !== n) fails.push(`axes ${axes.length}`);
  else {
    const d = axes.slice(1).map((x, i) => x - axes[i]);
    if (d.length && Math.max(...d) - Math.min(...d) > 1e-6) fails.push('axes uneven');
    if (Math.abs(axes[0] + axes[n - 1]) > 1e-6) fails.push('not centred');
    if (!spec.width && n > 1) {
      const D = r.parts.find((p) => p.name === 'shaft').manifold.boundingBox().max[0] * 2 / 1.0;
      void D;
    }
    for (const name of ['triglyph', 'dentil', 'modillion']) {
      const xs = frontX(r, name);
      if (!xs.length) continue;
      for (const a of axes) if (!xs.some((x) => Math.abs(x - a) < 1e-6)) { fails.push(`no ${name} over axis ${a.toFixed(3)}`); break; }
    }
  }
  return fails;
}

let pass = 0, fail = 0;
const w = [62, 6, 7, 28, 10];
console.log(['spec', 'ms', 'tris', 'size', 'shafts', 'result'].map((h, i) => (w[i] ? h.padEnd(w[i]) : h)).join(' '));
for (const spec of cases) {
  let r, fails;
  try {
    r = await generate(spec); fails = check(r, spec);
    // other processes share the machine: a time-only failure is re-measured once (the faster build counts)
    if (fails.length === 1 && fails[0].startsWith('time')) { const r2 = await generate(spec); if (r2.ms < r.ms) r = r2; fails = check(r, spec); }
  } catch (e) { fails = [`THROW ${e.message}`]; }
  if (fails.length) fail++; else pass++;
  const row = [JSON.stringify(spec).replace('"element":"portico",', '').replace(/"/g, ''), r ? Math.round(r.ms) : '-', r ? `${Math.round(r.tris / 1000)}k` : '-',
    r ? r.size.map((x) => x.toFixed(2)).join(' x ') : '-', r ? count(r, 'shaft') : '-', fails.join('; ') || 'ok'];
  console.log(row.map((c, i) => (w[i] ? String(c).slice(0, w[i]).padEnd(w[i]) : c)).join(' '));
}
const t = (name, fn) => fn().then(() => { pass++; console.log('ok', name); }, (e) => { fail++; console.log('FAIL', name, e.message); });
await t('axis spacing per order (Vignola: Doric ditriglyph 3.75 D, Ionic eustyle 3.25 D)', async () => {
  for (const order of ['doric', 'ionic', 'corinthian', 'greek-doric']) {
    const r = await generate({ element: 'portico', order, height: 6 }), D = 6 / ORDERS[order].colD;
    const xs = frontX(r, 'shaft').sort((a, b) => a - b);
    assert.ok(Math.abs(xs[1] - xs[0] - ORDERS[order].axis * D) < 1e-9, order);
  }
});
await t('Doric: three triglyphs per bay and one over each column (ditriglyph)', async () => {
  const r = await generate({ element: 'portico', order: 'doric', columns: 6 });
  const axes = frontX(r, 'shaft'), xs = frontX(r, 'triglyph').filter((x) => x >= Math.min(...axes) - 1e-9 && x <= Math.max(...axes) + 1e-9);
  assert.equal(xs.length, 3 * (6 - 1) + 1);
});
await t('height = column height, width = overall width', async () => {
  const r = await generate({ element: 'portico', order: 'ionic', height: 7.2 });
  const sh = r.parts.find((p) => p.name === 'shaft'), cap = r.parts.find((p) => p.name === 'capital');
  const top = cap.manifold.boundingBox().max[2] + cap.transforms[14], foot = 3 * 0.16;
  assert.ok(Math.abs(top - foot - 7.2) < 0.01 * 7.2, `column ${top - foot}`); void sh;
  const r2 = await generate({ element: 'portico', order: 'corinthian', width: 14 });
  assert.ok(Math.abs(r2.size[0] - 14) < 0.005 * 14, `width ${r2.size[0]}`);
});
console.log(`\n${pass} passed, ${fail} failed (${cases.length} builds + targeted checks)`);
process.exit(fail ? 1 : 0);
