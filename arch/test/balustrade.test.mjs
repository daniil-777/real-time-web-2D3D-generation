// Balustrade family tests: node arch/test/balustrade.test.mjs
// Every baluster style, counts and lengths (incl. the SCHEMA extremes), urns, detail levels: every part a closed
// 2-manifold with volume, sizes within tolerance of expected(), counts exact, the classical spacing rule, time and triangle
// budgets. Prints a table; exits non-zero on any failure.
import assert from 'node:assert/strict';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { normalize, SCHEMA } from '../js/spec.js';
import { instanceCount } from '../js/kernel.js';
import { BALUSTERS, layout } from '../js/gen/balustrade.js';

await initKernel();
const BUDGET = 500, TRI_MAX = 2e6;
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
  if (r.ms > BUDGET) errs.push(`time ${Math.round(r.ms)} ms > ${BUDGET}`);
  if (r.tris > TRI_MAX) errs.push(`tris ${r.tris}`);
  if (extra) extra(r, errs);
  if (errs.length) fails++;
  rows.push([JSON.stringify(input).replace(/"element":"(\w+)",?/, '$1 ').slice(0, 62), `${Math.round(r.ms)}`, `${r.tris}`,
    r.size.map((v) => v.toFixed(3)).join(' x '), Object.entries(ex.counts).map(([k, v]) => `${k}=${v}`).join(' '), errs.length ? 'FAIL ' + errs.join('; ') : 'ok']);
  return r;
}

/** The request must be honoured, not only self-consistent: length (or count) and height as asked. */
function honours(input) {
  return (r, errs) => {
    const { spec } = normalize(input), ex = r.expected;
    if (spec.element === 'baluster') { if (Math.abs(ex.size.z - spec.height) > 1e-9) errs.push('z not the requested height'); return; }
    if (spec.balusters) {
      if (ex.counts.baluster !== spec.balusters) errs.push('count not the requested one');
      // a length other than the default asked together with a count: both honoured whenever they can fit
      if (layout(spec).both && Math.abs(ex.size.x - spec.length) > 1e-9) errs.push('x not the requested length');
    } else if (Math.abs(ex.size.x - spec.length) > 1e-9) errs.push('x not the requested length');
    if (!spec.urns && Math.abs(ex.size.z - spec.height) > 1e-9) errs.push('z not the requested height');
  };
}

/** Classical spacing: the clear gap between balusters within a bay is at most D/2, and at least D/3 whenever the bay's width admits
 *  such a count (bars: at most 100 mm). Also the plinth and rail are 1/6 of the height each. */
function spacing(input) {
  return (r, errs) => {
    const { spec } = normalize(input), lay = layout(spec), { Db: D, bar } = lay.d;
    if (!lay.peds.length || lay.capped) return;   // runs with no pedestals / counts capped for absurd ratios are exempt
    if (lay.both) {                               // length and count both requested: equal spacing, positive gaps
      const all = lay.bays.flatMap((b) => b.xs.slice(1).map((x, i) => x - b.xs[i]));
      if (all.some((g) => Math.abs(g - all[0]) > 1e-9 || g - D <= 0)) errs.push('unequal or closed spacing');
      return;
    }
    for (const b of lay.bays) {
      const W = b.x1 - b.x0, fits = Math.ceil(W / (1.5 * D) - 1 - 1e-9) <= Math.floor(W / ((4 / 3) * D) - 1 + 1e-9);
      for (let i = 1; i < b.xs.length; i++) {
        const gap = b.xs[i] - b.xs[i - 1] - D;
        const bad = bar ? gap > 0.1 + 1e-9 : gap > D / 2 + 1e-9 || (fits && gap < D / 3 - 1e-9);
        if (bad) { errs.push(`gap ${gap.toFixed(4)} for D ${D.toFixed(4)}`); return; }
      }
    }
    // plinth 1/6, rail 1/6 of the height
    const rail = r.parts.find((p) => p.name === 'rail'), plinth = r.parts.find((p) => p.name === 'plinth');
    const H = spec.height;
    if (Math.abs(rail.manifold.boundingBox().min[2] - (5 * H) / 6) > 1e-6) errs.push('rail not at 5/6 H');
    if (Math.abs(plinth.manifold.boundingBox().max[2] - H / 6) > 1e-6) errs.push('plinth not 1/6 H');
  };
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

await generate({ element: 'balustrade' });   // warm-up (WASM and JIT)

const cases = [];
for (const baluster of BALUSTERS) {
  cases.push({ element: 'balustrade', baluster });
  cases.push({ element: 'balustrade', baluster, length: 6 });
  cases.push({ element: 'balustrade', baluster, length: 8, urns: true });
  cases.push({ element: 'balustrade', baluster, balusters: 12 });
  cases.push({ element: 'balustrade', baluster, balusters: 15, urns: true });
  cases.push({ element: 'baluster', baluster });
  cases.push({ element: 'baluster', baluster, height: SCHEMA.height.min });
  cases.push({ element: 'baluster', baluster, height: SCHEMA.height.max });
}
cases.push(
  { element: 'balustrade', length: 4.5 }, { element: 'balustrade', length: 1.05 }, { element: 'balustrade', length: 0.5 },
  { element: 'balustrade', length: SCHEMA.length.min }, { element: 'balustrade', length: SCHEMA.length.max },
  { element: 'balustrade', length: SCHEMA.length.max, baluster: 'bar' },
  { element: 'balustrade', height: SCHEMA.height.min }, { element: 'balustrade', height: SCHEMA.height.max },
  { element: 'balustrade', height: SCHEMA.height.min, length: SCHEMA.length.max },
  { element: 'balustrade', height: 1.05, length: 6 },
  { element: 'balustrade', balusters: SCHEMA.balusters.min }, { element: 'balustrade', balusters: SCHEMA.balusters.max },
  { element: 'balustrade', balusters: SCHEMA.balusters.max, baluster: 'double-vase', urns: true },
  { element: 'balustrade', balusters: 37 }, { element: 'balustrade', balusters: 20, baluster: 'bottle' },
  { element: 'balustrade', length: 60, balusters: 200 }, { element: 'balustrade', length: 6, balusters: 12 },
  { element: 'balustrade', length: 10, balusters: 10 }, { element: 'balustrade', length: 2, balusters: 40 },
  { element: 'balustrade', length: 4, balusters: 14, baluster: 'bar' }, { element: 'balustrade', length: 5, balusters: 16, urns: true },
  { element: 'balustrade', detail: 'low' }, { element: 'balustrade', detail: 'medium', urns: true },
  { element: 'baluster', height: 0.2 }, { element: 'baluster', height: 0.762, baluster: 'square' },
);
for (const baluster of BALUSTERS) await similar({ element: 'baluster', baluster }, ['height']);
// a one-bay balustrade with a given count, its height scaled: the same layout k times larger (longer runs gain
// pedestals every ~3 m, so they are not similar by design)
for (const baluster of BALUSTERS.filter((b) => b !== 'bar')) await similar({ element: 'balustrade', baluster, balusters: 5, urns: true }, ['height'], [0.25, 1.3]);
for (const c of cases) {
  const hon = honours(c), sp = c.element === 'balustrade' ? spacing(c) : null;
  await check(c, (r, errs) => { hon(r, errs); if (sp) sp(r, errs); });
}

const w = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i].length)));
console.log(['spec'.padEnd(w[0]), 'ms'.padStart(w[1]), 'tris'.padStart(w[2]), 'size (m)'.padEnd(w[3]), 'counts'.padEnd(w[4]), 'result'].join('  '));
for (const r of rows) console.log([r[0].padEnd(w[0]), r[1].padStart(w[1]), r[2].padStart(w[2]), r[3].padEnd(w[3]), r[4].padEnd(w[4]), r[5]].join('  '));
console.log(`${rows.length - fails}/${rows.length} balustrade cases passed`);
assert.equal(fails, 0, `${fails} balustrade case(s) failed`);
