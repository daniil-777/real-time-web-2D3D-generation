// Dome family tests: node arch/test/dome.test.mjs
// Every element (dome, cupola, spire) across every relevant enum value, the legal size extremes of SCHEMA, the
// interacting flags (drum × lantern × oculus), finials, orders, materials and detail levels. For each build: every part
// NoError with positive volume, size within tol of expected(), counts exact, triangles < 2 M, build time within budget.
import assert from 'node:assert/strict';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { SCHEMA, MATERIALS } from '../js/spec.js';
import { ORDER_KEYS } from '../js/orders.js';

await initKernel();

const BUDGET = { dome: 1500, cupola: 1500, spire: 500 };   // dome/cupola with drum + lantern are assemblies
const TRI_MAX = 2e6;
const cases = [];
const add = (spec, label) => cases.push({ spec, label: label || Object.entries(spec).filter(([k]) => k !== 'element').map(([k, v]) => `${k}=${v}`).join(' ') });

const domeTypes = SCHEMA.domeType.values, finials = SCHEMA.finial.values, spireTypes = SCHEMA.spireType.values;
// dome and cupola: every type × drum × lantern × oculus
for (const element of ['dome', 'cupola'])
  for (const domeType of domeTypes) for (const drum of [true, false]) for (const lantern of [true, false]) for (const oculus of [false, true])
    add({ element, domeType, drum, lantern, oculus });
// finials on a crown, on a lantern, on a cupola
for (const finial of finials) {
  add({ element: 'dome', finial, lantern: false });
  add({ element: 'dome', finial, lantern: true, domeType: 'onion' });
  add({ element: 'cupola', finial });
}
// ribs (0 = none; a ribbed dome without a count gets 16, a ribbed cupola 8)
for (const ribs of [0, 5, 8, 12, 16, 24, 48]) for (const domeType of domeTypes) add({ element: 'dome', domeType, ribs });
for (const ribs of [0, 8, 16]) add({ element: 'cupola', domeType: 'ribbed', ribs });
// drum orders (non-classical orders fall back to pilaster strips)
for (const order of ORDER_KEYS) add({ element: 'dome', order });
// materials and styles
for (const material of MATERIALS) { add({ element: 'dome', material }); add({ element: 'spire', material }); }
for (const style of ['russian', 'byzantine', 'baroque', 'gothic', 'art-deco']) { add({ element: 'dome', domeType: 'onion', style, lantern: false }); add({ element: 'spire', style }); }
for (const domeType of domeTypes) for (const drum of [true, false]) for (const diameter of [0.05, 8, 31, 60])
  add({ element: 'dome', style: 'byzantine', domeType, drum, diameter, lantern: false });
for (const order of ['tuscan', 'doric', 'ionic', 'corinthian', 'composite', 'gothic']) for (const diameter of [0.05, 8, 42, 60])
  add({ element: 'dome', style: 'neoclassical', order, diameter });
for (const detail of SCHEMA.detail.values) add({ element: 'dome', style: 'neoclassical', domeType: 'ribbed', detail });
for (const spireType of spireTypes) for (const [width, height] of [[0.05, 0.05], [3, 14], [80, 120], [80, 0.05], [0.05, 120]])
  add({ element: 'spire', style: 'art-deco', spireType, width, height });
// detail levels
for (const detail of SCHEMA.detail.values) {
  add({ element: 'dome', detail }); add({ element: 'dome', domeType: 'ribbed', detail }); add({ element: 'dome', domeType: 'onion', detail });
  add({ element: 'cupola', detail }); add({ element: 'cupola', domeType: 'onion', lantern: true, detail });
  for (const spireType of spireTypes) for (const material of ['slate', 'copper', 'limestone', 'wood']) add({ element: 'spire', spireType, material, detail });
}
// sizes, including the SCHEMA extremes
const dMin = SCHEMA.diameter.min, dMax = SCHEMA.diameter.max;
for (const diameter of [dMin, 0.3, 1, 2.4, 8, 14, 24, 42, dMax]) {
  add({ element: 'dome', diameter }); add({ element: 'dome', diameter, domeType: 'ribbed', oculus: true }); add({ element: 'cupola', diameter, lantern: true });
}
const wMin = SCHEMA.width.min, wMax = SCHEMA.width.max, hMin = SCHEMA.height.min, hMax = SCHEMA.height.max;
for (const [width, height] of [[wMin, hMin], [wMin, hMax], [wMax, hMin], [wMax, hMax], [3, 14], [1, 6], [6, 40], [0.3, 2], [12, 90]])
  for (const spireType of spireTypes) add({ element: 'spire', spireType, width, height });
// out-of-range values are clamped by normalize() and must still build
add({ element: 'dome', diameter: 500, ribs: 999 }, 'diameter=500 ribs=999 (clamped)');
add({ element: 'spire', width: -3, height: 1e6 }, 'width=-3 height=1e6 (clamped)');

const rows = [];
let fails = 0;
const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);
console.log(pad('element', 7), pad('case', 58), lpad('ms', 6), lpad('tris', 9), lpad('size x×y×z (m)', 26), lpad('expected', 26), ' result');
const now = () => performance.now();
for (const c of cases) {
  let r, err = null;
  try {
    const t0 = now();
    r = await generate(c.spec);
    r.total = now() - t0;                       // build + Manifold's lazy evaluation (bbox), what a user waits for
    const el = r.spec.element, ex = r.expected;
    for (const p of r.parts) {
      assert.equal(p.manifold.status(), 'NoError', `${p.name} status`);
      assert.ok(p.manifold.volume() > 0, `${p.name} volume ${p.manifold.volume()}`);
    }
    for (const [i, k] of ['x', 'y', 'z'].entries()) if (ex.size[k] != null) {
      const a = r.size[i], e = ex.size[k];
      assert.ok(Math.abs(a - e) <= ex.tol * e, `${k} ${a.toFixed(4)} vs expected ${e.toFixed(4)}`);
    }
    for (const [name, n] of Object.entries(ex.counts)) {
      const p = r.parts.find((q) => q.name === name);
      assert.ok(p, `missing part ${name}`);
      assert.equal(p.transforms ? p.transforms.length / 16 : 1, n, `${name} count`);
    }
    if (c.spec.ribs > 0 && SCHEMA.ribs.max >= c.spec.ribs) assert.equal(ex.counts.rib, c.spec.ribs, 'ribs promised as asked');
    assert.ok(r.tris < TRI_MAX, `${r.tris} triangles`);
    assert.ok(r.ms < BUDGET[el], `${r.ms.toFixed(0)} ms over ${BUDGET[el]} ms`);
    assert.ok(r.total < BUDGET[el], `${r.total.toFixed(0)} ms with evaluation, over ${BUDGET[el]} ms`);
  } catch (e) { err = e.message; fails++; }
  rows.push({ c, r, err });
  // free the result (Manifold objects live in WASM memory until deleted)
  if (r) { const seen = new Set(); for (const p of r.parts) if (!seen.has(p.manifold)) { seen.add(p.manifold); p.manifold.delete(); } }
  const sz = r ? r.size.map((x) => x.toFixed(3)).join('×') : '-';
  const ex = r && r.expected ? ['x', 'y', 'z'].map((k) => (r.expected.size[k] ?? NaN).toFixed(3)).join('×') : '-';
  console.log(pad(c.spec.element, 7), pad(c.label.slice(0, 58), 58), lpad(r ? r.total.toFixed(0) : '-', 6), lpad(r ? r.tris : '-', 9), lpad(sz, 26), lpad(ex, 26), err ? ' FAIL ' + err : ' ok');
}
const ms = rows.filter((x) => x.r).map((x) => x.r.total).sort((a, b) => a - b);
const tr = rows.filter((x) => x.r).map((x) => x.r.tris).sort((a, b) => a - b);
console.log(`\n${rows.length} builds, ${rows.length - fails} passed, ${fails} failed; ms median ${ms[ms.length >> 1].toFixed(0)} max ${ms[ms.length - 1].toFixed(0)}; tris median ${tr[tr.length >> 1]} max ${tr[tr.length - 1]}`);
if (fails) process.exit(1);
