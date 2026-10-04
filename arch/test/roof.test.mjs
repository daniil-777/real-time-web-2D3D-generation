// Roof family tests: node arch/test/roof.test.mjs
// Every roof type × every covering, every detail level, extreme legal sizes and pitches, orientation (width > length),
// material → covering inference, height → pitch solving. Each build: all parts NoError with positive volume,
// bbox = expected() within tol, counts exact, build time within budget (single element: 500 ms), triangles < 2 M.
import assert from 'node:assert/strict';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { SCHEMA } from '../js/spec.js';
import { dims } from '../js/gen/roof.js';

await initKernel();

const TYPES = SCHEMA.roofType.values, COVERS = SCHEMA.covering.values;
const cases = [];
for (const roofType of TYPES) for (const covering of COVERS) cases.push({ roofType, covering });
for (const roofType of TYPES) for (const detail of ['low', 'medium']) cases.push({ roofType, detail });
for (const roofType of TYPES) {
  cases.push({ roofType, width: 12, length: 8 });                                  // ridge turns to run along Y
  cases.push({ roofType, width: 10, length: 10 });                                 // square plan
  cases.push({ roofType, width: SCHEMA.width.min, length: SCHEMA.length.min });     // 5 cm × 10 cm model
  cases.push({ roofType, width: 1.2, length: 2 });                                 // a porch canopy
  cases.push({ roofType, width: 30, length: 60, covering: 'slate' });              // a large public building
  cases.push({ roofType, pitch: SCHEMA.pitch.min }, { roofType, pitch: SCHEMA.pitch.max });
  cases.push({ roofType, height: 5 });                                             // ridge height given → pitch solved
}
cases.push({ roofType: 'hip', width: SCHEMA.width.max, length: SCHEMA.length.max });           // 80 × 120 m
cases.push({ roofType: 'mansard', width: SCHEMA.width.max, length: SCHEMA.length.max, covering: 'slate' });
cases.push({ roofType: 'gable', width: SCHEMA.width.max, length: SCHEMA.length.max, covering: 'pantiles' });
cases.push({ roofType: 'gable', material: 'copper' }, { roofType: 'hip', material: 'slate' }, { roofType: 'gable', material: 'wood' });
cases.push({ roofType: 'mansard', pitch: 75 }, { roofType: 'mansard', pitch: 20 }, { roofType: 'gambrel', pitch: 50 }, { roofType: 'gambrel', pitch: 15 });
cases.push({ roofType: 'gable', width: 9, length: 13, pitch: 45, covering: 'shingles', detail: 'medium' });

const rows = [];
let fail = 0, worstMs = 0, worstTris = 0;
for (const c of cases) {
  const spec = { element: 'roof', ...c };
  const label = Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ');
  try {
    const r = await generate(spec);
    const e = r.expected;
    for (const p of r.parts) {
      assert.equal(p.manifold.status(), 'NoError', `${p.name} not manifold`);
      assert.ok(p.manifold.volume() > 0, `${p.name} has no volume`);
      if (p.transforms) assert.ok(p.transforms.length >= 16 && p.transforms.every(Number.isFinite), `${p.name} transforms`);
    }
    assert.ok(Math.abs(r.bbox.min[2]) < 1e-6, `lowest point at z = ${r.bbox.min[2]}, not 0`);
    const axes = ['x', 'y', 'z'];
    axes.forEach((a, i) => {
      if (e.size[a] === undefined) return;
      const err = Math.abs(r.size[i] - e.size[a]) / e.size[a];
      assert.ok(err <= e.tol, `${a}: ${r.size[i].toFixed(4)} vs expected ${e.size[a].toFixed(4)} (${(err * 100).toFixed(2)} %)`);
    });
    for (const [name, n] of Object.entries(e.counts)) {
      const p = r.parts.find((q) => q.name === name);
      assert.equal(p ? (p.transforms ? p.transforms.length / 16 : 1) : 0, n, `count ${name}`);
    }
    // footprint is honoured: bbox = footprint + 2 × overhang, overhang 0 < o < 0.9 m and below 20 % of the span
    const D = dims(r.spec);
    assert.ok(D.o > 0 && D.o < 0.9 && D.o <= 0.2 * D.short + 1e-9, `overhang ${D.o}`);
    if (c.height) assert.ok(Math.abs(r.size[2] - c.height) / c.height < 0.005 || D.lo <= 5.001 || D.lo >= 74.999 || D.up <= 5.001,
      `height ${r.size[2]} vs asked ${c.height}`);
    assert.ok(r.ms < 500, `build ${r.ms.toFixed(0)} ms ≥ 500 ms`);
    assert.ok(r.tris < 2e6, `${r.tris} triangles ≥ 2 M`);
    worstMs = Math.max(worstMs, r.ms); worstTris = Math.max(worstTris, r.tris);
    const pieces = r.parts.reduce((s, p) => s + (p.transforms ? p.transforms.length / 16 : 1), 0);
    rows.push(['ok', label, r.size.map((x) => x.toFixed(2)).join('×'), `${r.ms.toFixed(0)} ms`, `${(r.tris / 1000).toFixed(0)}k tris`, `${pieces} pcs`]);
  } catch (err) {
    fail++;
    rows.push(['FAIL', label, String(err.message || err).slice(0, 140)]);
  }
}
const w = [4, 52, 22, 8, 12, 10];
for (const r of rows) console.log(r.map((x, i) => String(x).padEnd(w[i] || 0)).join(' '));
console.log(`${rows.length - fail}/${rows.length} roof builds pass · slowest ${worstMs.toFixed(0)} ms · most ${(worstTris / 1e6).toFixed(2)} M triangles`);

// rules that are not about one build
const d0 = dims({ element: 'roof', roofType: 'mansard', width: 8, length: 12, pitch: 35 });
assert.equal(d0.lo, 70); assert.equal(d0.up, 30);
const d1 = dims({ element: 'roof', roofType: 'gambrel', width: 8, length: 12, pitch: 35 });
assert.equal(d1.lo, 60); assert.equal(d1.up, 25);
assert.equal(dims({ element: 'roof', roofType: 'mansard', width: 8, length: 12, pitch: 75 }).lo, 75);
assert.equal(dims({ element: 'roof', roofType: 'gambrel', width: 8, length: 12, pitch: 20 }).up, 20);
assert.equal(dims({ element: 'roof', roofType: 'shed', width: 8, length: 12, pitch: 35 }).lo, 15);
assert.equal(dims({ element: 'roof', roofType: 'gable', width: 8, length: 12, pitch: 35, material: 'zinc', covering: 'tiles' }).cover, 'seam');
assert.equal(dims({ element: 'roof', roofType: 'gable', width: 8, length: 12, pitch: 35, covering: 'tiles' }).cover, 'tiles');
console.log('pitch / covering rules ok');
if (fail) process.exit(1);
