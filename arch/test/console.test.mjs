// Console family tests: node arch/test/console.test.mjs
// Default and parsed-prompt sizes, tall ancons, deep corbels, modillion-like brackets, the SCHEMA extremes of height,
// depth and width (alone and combined), with and without the acanthus leaf, every detail level: every part a closed
// 2-manifold with volume, x = width, y = depth, z = height within tolerance, the wall face at y = +depth/2 and the
// projection toward -Y, the base on z = 0, time and triangle budgets.
import assert from 'node:assert/strict';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { normalize, SCHEMA } from '../js/spec.js';
import { solids } from './solid.mjs';
import { selfIntersections } from './self-intersect.mjs';

await initKernel();
const BUDGET = 500, TRI_MAX = 2e6;
let fails = 0;
const rows = [];

async function check(input, deep = false) {
  const r = await generate(input);
  const errs = [], ex = r.expected, { spec } = normalize(input);
  for (const p of r.parts) {
    if (p.manifold.status() !== 'NoError') errs.push(`${p.name}: ${p.manifold.status()}`);
    else if (!(p.manifold.volume() > 0)) errs.push(`${p.name}: volume ${p.manifold.volume()}`);
  }
  ['x', 'y', 'z'].forEach((k, i) => {
    if (ex.size[k] !== undefined && Math.abs(r.size[i] - ex.size[k]) > ex.tol * ex.size[k]) errs.push(`${k} ${r.size[i].toFixed(4)} != ${ex.size[k].toFixed(4)}`);
  });
  if (ex.size.x !== spec.width || ex.size.y !== spec.depth || ex.size.z !== spec.height) errs.push('expected size is not the requested size');
  const { min, max } = r.bbox, tol = 1e-6 * Math.max(spec.depth, spec.height, spec.width);
  if (Math.abs(max[1] - spec.depth / 2) > tol) errs.push(`wall face at y ${max[1]}`);
  if (Math.abs(min[2]) > tol) errs.push(`base at z ${min[2]}`);
  if (Math.abs(min[0] + max[0]) > tol) errs.push('not centred on x');
  const leaf = r.parts.some((p) => p.name === 'leaf');
  if (spec.enrichment === 'none' && leaf) errs.push('leaf despite enrichment none');
  if (deep) {                    // one solid (leaf and scroll discs fused with the body), no self-intersecting part
    const n = solids(r.parts).length;
    if (n !== 1) errs.push(`${n} separate solids`);
    // the leaf is the only part built from raw triangles (body and cap come from extrusions, lofts and booleans)
    for (const p of r.parts.filter((q) => q.name === 'leaf')) { const x = selfIntersections(p.manifold); if (x) errs.push(`leaf self-intersects (${x} pairs)`); }
  }
  if (r.ms > BUDGET) errs.push(`time ${Math.round(r.ms)} ms > ${BUDGET}`);
  if (r.tris > TRI_MAX) errs.push(`tris ${r.tris}`);
  if (errs.length) fails++;
  rows.push([JSON.stringify(input).replace(/"element":"(\w+)",?/, '$1 ').slice(0, 64), `${Math.round(r.ms)}`, `${r.tris}`,
    r.size.map((v) => v.toFixed(3)).join(' x '), leaf ? 'leaf' : 'plain', errs.length ? 'FAIL ' + errs.join('; ') : 'ok']);
}

/** Similarity: the element built k times larger has every extent k times larger (no size-dependent detail). */
async function similar(input, keys, ks = [0.0625, 40]) {
  const a = await generate(input);
  for (const k0 of ks) {
    // keep every scaled value inside its SCHEMA range (normalize() would clamp it and break the comparison)
    const k = keys.reduce((kk, key) => Math.min(Math.max(kk, SCHEMA[key].min / a.spec[key]), SCHEMA[key].max / a.spec[key]), k0);
    const big = { ...input };
    for (const key of keys) big[key] = (a.spec[key]) * k;
    const b = await generate(big), bad = [];
    [0, 1, 2].forEach((i) => { if (Math.abs(b.size[i] / a.size[i] - k) > 0.005 * k) bad.push(`${'xyz'[i]} x${(b.size[i] / a.size[i]).toFixed(4)}`); });
    if (bad.length) fails++;
    rows.push([`similar ${JSON.stringify(input).replace(/"element":"(\w+)",?/, '$1 ').slice(0, 40)} x${k}`, '', '', b.size.map((v) => v.toFixed(3)).join(' x '), '', bad.length ? 'FAIL ' + bad.join('; ') : 'ok']);
  }
}

await generate({ element: 'console' });   // warm-up (WASM and JIT)

const cases = [
  {}, { height: 0.45 }, { height: 0.55, depth: 0.38 }, { enrichment: 'acanthus' }, { enrichment: 'none' },
  { height: 0.9, depth: 0.2, width: 0.22 }, { height: 2, depth: 0.3, width: 0.3 },        // tall ancons
  { height: 0.4, depth: 0.6, width: 0.3 }, { height: 0.3, depth: 1.2, width: 0.3 },       // deep corbels, modillions
  { height: 1.2, depth: 0.84, width: 0.52 }, { height: 0.12, depth: 0.25, width: 0.08 },
  { detail: 'low' }, { detail: 'medium' }, { detail: 'low', enrichment: 'none' }, { material: 'marble' },
];
const ext = { height: SCHEMA.height, depth: SCHEMA.depth, width: SCHEMA.width };
for (const [k, s] of Object.entries(ext)) for (const v of [s.min, s.max]) cases.push({ [k]: v });
for (const h of [SCHEMA.height.min, SCHEMA.height.max]) for (const d of [SCHEMA.depth.min, SCHEMA.depth.max])
  for (const wd of [SCHEMA.width.min, SCHEMA.width.max]) cases.push({ height: h, depth: d, width: wd });
for (const c of cases) await check({ element: 'console', ...c }, cases.indexOf(c) < 15);   // the realistic cases: deep checks
await similar({ element: 'console' }, ['height', 'depth', 'width'], [0.25, 40]);
await similar({ element: 'console', height: 0.9, depth: 0.2, width: 0.22 }, ['height', 'depth', 'width'], [0.25, 40]);

const w = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i].length)));
console.log(['spec'.padEnd(w[0]), 'ms'.padStart(w[1]), 'tris'.padStart(w[2]), 'size (m)'.padEnd(w[3]), 'leaf'.padEnd(w[4]), 'result'].join('  '));
for (const r of rows) console.log([r[0].padEnd(w[0]), r[1].padStart(w[1]), r[2].padStart(w[2]), r[3].padEnd(w[3]), r[4].padEnd(w[4]), r[5]].join('  '));
console.log(`${rows.length - fails}/${rows.length} console cases passed`);
assert.equal(fails, 0, `${fails} console case(s) failed`);
