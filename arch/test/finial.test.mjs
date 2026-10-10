// Finial family tests (finial, urn, obelisk): node arch/test/finial.test.mjs
// Every finial kind, the urn (bud and flame knobs), the obelisk (Roman and Egyptian), heights incl. the SCHEMA extremes
// and detail levels: every part a closed 2-manifold with volume, height = the requested height within tolerance,
// obelisk proportions (shaft base = 1/10 of the shaft, pyramidion faces at 60 degrees), time and triangle budgets.
import assert from 'node:assert/strict';
import { initKernel, TIME_SCALE } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { normalize, SCHEMA } from '../js/spec.js';
import { instanceCount, partsBBox } from '../js/kernel.js';
import { FINIALS } from '../js/gen/finial.js';
import { solids } from './solid.mjs';
import { selfIntersections } from './self-intersect.mjs';

await initKernel();
const BUDGET = 500 * TIME_SCALE, TRI_MAX = 2e6;
let fails = 0;
const rows = [];

async function check(input, extra) {
  const r = await generate(input);
  const errs = [], ex = r.expected;
  for (const p of r.parts) {
    if (p.manifold.status() !== 'NoError') errs.push(`${p.name}: ${p.manifold.status()}`);
    else if (!(p.manifold.volume() > 0)) errs.push(`${p.name}: volume ${p.manifold.volume()}`);
  }
  ['x', 'y', 'z'].forEach((k, i) => {
    if (ex.size[k] !== undefined && Math.abs(r.size[i] - ex.size[k]) > ex.tol * ex.size[k]) errs.push(`${k} ${r.size[i].toFixed(4)} != ${ex.size[k].toFixed(4)}`);
  });
  for (const [name, n] of Object.entries(ex.counts)) {
    const got = r.parts.filter((p) => p.name === name).reduce((s, p) => s + instanceCount(p), 0);
    if (got !== n) errs.push(`count ${name} ${got} != ${n}`);
  }
  const { spec } = normalize(input);
  if (Math.abs(ex.size.z - spec.height) > 1e-9) errs.push('expected z is not the requested height');
  // the element stands on z = 0, centred on the Z axis
  if (Math.abs(r.bbox.min[2]) > 1e-6) errs.push(`base at z ${r.bbox.min[2]}`);
  const bb = partsBBox([r.parts[0]]);   // the socle / steps / base block: centred on the axis
  if (Math.abs(bb.min[0] + bb.max[0]) > 1e-6 * spec.height || Math.abs(bb.min[1] + bb.max[1]) > 1e-6 * spec.height) errs.push('base not centred');
  if (r.ms > BUDGET) errs.push(`time ${Math.round(r.ms)} ms > ${BUDGET}`);
  if (r.tris > TRI_MAX) errs.push(`tris ${r.tris}`);
  if (extra) extra(r, errs, spec);
  if (errs.length) fails++;
  rows.push([JSON.stringify(input).replace(/"element":"(\w+)",?/, '$1 ').slice(0, 58), `${Math.round(r.ms)}`, `${r.tris}`,
    r.size.map((v) => v.toFixed(3)).join(' x '), `${r.parts.length}`, errs.length ? 'FAIL ' + errs.join('; ') : 'ok']);
}

/** Obelisk: shaft base width = 1/10 of the shaft's height, top 0.7 of the base, pyramidion faces at 60 degrees. */
function obeliskRules(r, errs) {
  const shaft = r.parts.find((p) => p.name === 'shaft').manifold.boundingBox();
  const pyr = r.parts.find((p) => p.name === 'pyramidion').manifold.boundingBox();
  const bw = shaft.max[0] - shaft.min[0], hs = pyr.min[2] - shaft.min[2], tw = pyr.max[0] - pyr.min[0], hp = pyr.max[2] - pyr.min[2];
  if (Math.abs(bw / hs - 0.1) > 0.002) errs.push(`shaft width/height ${(bw / hs).toFixed(4)}`);
  if (Math.abs(tw / bw - 0.7) > 0.005) errs.push(`taper ${(tw / bw).toFixed(3)}`);
  const ang = (Math.atan2(hp, tw / 2) * 180) / Math.PI;
  if (Math.abs(ang - 60) > 0.5) errs.push(`pyramidion ${ang.toFixed(1)} deg`);
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

await generate({ element: 'finial' });   // warm-up (WASM and JIT)

const H = [undefined, SCHEMA.height.min, 2.5, SCHEMA.height.max];
for (const finial of FINIALS) for (const height of H) await check({ element: 'finial', finial, height });
await check({ element: 'finial', finial: 'none' });
for (const detail of ['low', 'medium']) for (const finial of FINIALS) await check({ element: 'finial', finial, detail });
for (const height of [...H, 0.85]) {
  await check({ element: 'urn', height });
  await check({ element: 'urn', height, finial: 'flame' });
}
await check({ element: 'urn', detail: 'low', material: 'terracotta' });
for (const height of [...H, 12, 18]) {
  await check({ element: 'obelisk', height }, obeliskRules);
  await check({ element: 'obelisk', height, style: 'egyptian' }, obeliskRules);
}
await check({ element: 'obelisk', detail: 'low' }, obeliskRules);
await check({ element: 'obelisk', pedestal: false }, (r, errs) => { obeliskRules(r, errs); if (r.parts.some((p) => p.name === 'pedestal')) errs.push('pedestal despite pedestal: false'); });
await check({ element: 'obelisk', style: 'egyptian', pedestal: true }, (r, errs) => { obeliskRules(r, errs); if (!r.parts.some((p) => p.name === 'pedestal')) errs.push('no pedestal despite pedestal: true'); });
// every finial, urn and obelisk is ONE solid (handles, stems, balls and crowns sunk into what carries them), and the
// pieces built from raw triangles (crown blades, handles: shells and tubes) do not pass through themselves
const oneSolid = (r, errs) => {
  const n = solids(r.parts).length;
  if (n !== 1) errs.push(`${n} separate solids`);
  for (const p of r.parts.filter((q) => ['crown-outer', 'crown-inner', 'handle', 'flame', 'bowl', 'scale'].includes(q.name))) {
    const x = selfIntersections(p.manifold);
    if (x) errs.push(`${p.name} self-intersects (${x} pairs)`);
  }
};
for (const finial of FINIALS) for (const height of [undefined, 2.5]) await check({ element: 'finial', finial, height }, oneSolid);
for (const finial of ['pineapple', 'acorn', 'flame']) await check({ element: 'finial', finial, detail: 'low' }, oneSolid);
for (const height of [undefined, 0.5, 2.5]) for (const finial of [undefined, 'flame']) await check({ element: 'urn', height, finial }, oneSolid);
for (const style of [undefined, 'egyptian']) await check({ element: 'obelisk', style }, oneSolid);
for (const finial of FINIALS) await similar({ element: 'finial', finial }, ['height']);
await similar({ element: 'urn' }, ['height']);
await similar({ element: 'urn', finial: 'flame' }, ['height']);
await similar({ element: 'obelisk' }, ['height']);
await similar({ element: 'obelisk', style: 'egyptian' }, ['height']);

const w = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i].length)));
console.log(['spec'.padEnd(w[0]), 'ms'.padStart(w[1]), 'tris'.padStart(w[2]), 'size (m)'.padEnd(w[3]), 'parts'.padStart(w[4]), 'result'].join('  '));
for (const r of rows) console.log([r[0].padEnd(w[0]), r[1].padStart(w[1]), r[2].padStart(w[2]), r[3].padEnd(w[3]), r[4].padStart(w[4]), r[5]].join('  '));
console.log(`${rows.length - fails}/${rows.length} finial / urn / obelisk cases passed`);
assert.equal(fails, 0, `${fails} finial case(s) failed`);
