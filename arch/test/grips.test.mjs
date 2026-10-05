// Grip engine tests: node arch/test/grips.test.mjs
// Every element (defaults) and a few variants: gripsFor gives at least one well-formed grip (every contract field,
// finite anchor, unit dir, legal range, snap / apply / format); for every grip, apply(snap(v)) at min, mid and max
// normalizes without a range warning on the grip's field, builds without a kernel error as ONE solid, and the build
// honours the value: the extent along the grip's axis (within 1 %) when the value is the extent, the count of the part
// instances for counts, else the built spec's value and an extent that grows with the value. Then parseTyped units.
import assert from 'node:assert/strict';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { ELEMENTS, normalize } from '../js/spec.js';
import { K, instanceCount, partTris } from '../js/kernel.js';
import { gripsFor, parseTyped } from '../js/grips.js';

await initKernel();
const t0 = Date.now();
let fails = 0, builds = 0;
const errs = [];
const fail = (m) => { fails++; errs.push(m); };

const CASES = [
  ...ELEMENTS.map((element) => ({ element })),
  { element: 'portico', columns: 6 }, { element: 'balustrade', balusters: 12 }, { element: 'arcade', bays: 5 },
  { element: 'roof', roofType: 'gable' }, { element: 'roof', roofType: 'mansard' }, { element: 'arch', archType: 'pointed' },
  { element: 'column', pedestal: true },
];
// the part whose instances a count grip counts
const COUNTED = { columns: 'shaft', balusters: 'baluster', bays: 'keystone' };
const free = (r) => { for (const p of r.parts) p.manifold.delete(); };
const info = (r) => ({ size: r.size, bbox: r.bbox, expected: r.expected });
const label = (req) => JSON.stringify(req);

async function build(req) {
  const r = await generate(req);
  builds++;
  return r;
}

// One solid: a real union of every part instance (every handle made here is freed: solid.mjs keeps its copies and the
// union, which exhausts the WASM heap over hundreds of builds). Builds of more than PIECES instances or TRIS triangles
// (big roofs: thousands of tiles; tall spires: thousands of slates) are too heavy to union; there the instances' boxes
// must form one overlapping cluster (a floating piece still shows; a touching-but-not-fused one would not) - the roof
// and dome suites union small builds of those families for real.
const PIECES = 800, TRIS = 4e5;
let unions = 0, boxed = 0;
function solidCount(parts) {
  const pieces = parts.reduce((t, p) => t + instanceCount(p), 0), tris = parts.reduce((t, p) => t + partTris(p), 0);
  if (pieces > PIECES || tris > TRIS) { boxed++; return boxClusters(parts); }
  unions++;
  const { Manifold } = K(), all = [], own = [];
  for (const p of parts) {
    const n = p.transforms ? p.transforms.length / 16 : 1;
    for (let i = 0; i < n; i++) {
      if (!p.transforms) { all.push(p.manifold); continue; }
      const m = p.manifold.transform(Array.from(p.transforms.subarray(16 * i, 16 * i + 16)));
      all.push(m); own.push(m);
    }
  }
  const u = Manifold.union(all), comps = u.decompose();
  const n = comps.filter((c) => c.volume() > 1e-9).length;
  for (const c of comps) c.delete();
  u.delete();
  for (const m of own) m.delete();
  return n;
}
function boxClusters(parts) {
  const boxes = [];
  for (const p of parts) {
    const bb = p.manifold.boundingBox(), n = p.transforms ? p.transforms.length / 16 : 1;
    for (let i = 0; i < n; i++) {
      const m = p.transforms ? p.transforms.subarray(16 * i, 16 * i + 16) : null, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 8; c++) {
        const q = [(c & 1 ? bb.max : bb.min)[0], (c & 2 ? bb.max : bb.min)[1], (c & 4 ? bb.max : bb.min)[2]];
        for (let a = 0; a < 3; a++) {
          const w = m ? m[a] * q[0] + m[4 + a] * q[1] + m[8 + a] * q[2] + m[12 + a] : q[a];
          lo[a] = Math.min(lo[a], w); hi[a] = Math.max(hi[a], w);
        }
      }
      boxes.push({ lo, hi });
    }
  }
  const up = boxes.map((_, i) => i), find = (i) => { while (up[i] !== i) i = up[i] = up[up[i]]; return i; };
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].lo[0] - boxes[b].lo[0]), eps = 1e-6;
  const active = [];
  for (const i of order) {
    const bi = boxes[i];
    for (let k = active.length - 1; k >= 0; k--) {
      const bj = boxes[active[k]];
      if (bj.hi[0] < bi.lo[0] - eps) { active.splice(k, 1); continue; }
      if (bj.lo[1] <= bi.hi[1] + eps && bi.lo[1] <= bj.hi[1] + eps && bj.lo[2] <= bi.hi[2] + eps && bi.lo[2] <= bj.hi[2] + eps) up[find(i)] = find(active[k]);
    }
    active.push(i);
  }
  return new Set(boxes.map((_, i) => find(i))).size;
}

/** Distance from a point to the element's surface (0 inside it): Manifold minGap against a 2 mm ball, over the
 *  non-instanced parts and the instanced ones of at most 64 pieces (the covering's thousands of tiles are skipped). */
function gapTo(parts, pt, search) {
  const { Manifold } = K(), ball = Manifold.sphere(0.002, 8).translate(pt);
  let best = search;
  for (const p of parts) {
    const n = instanceCount(p);
    if (n > 64) continue;
    for (let i = 0; i < n; i++) {
      const m = p.transforms ? p.manifold.transform(Array.from(p.transforms.subarray(16 * i, 16 * i + 16))) : p.manifold;
      best = Math.min(best, m.minGap(ball, search));
      if (m !== p.manifold) m.delete();
    }
  }
  ball.delete();
  return best;
}

const rows = [], gaps = [];
for (const req of CASES) {
  const r = await build(req);
  const grips = gripsFor(r.spec, info(r));
  // every anchor on the element: within 3 % of its largest extent (at least 5 cm) of its surface
  const tolGap = Math.max(0.05, 0.03 * Math.max(...r.size));
  for (const g of grips) {
    const d = gapTo(r.parts, g.anchor, 2 * tolGap);
    gaps.push(`${label(req)} ${g.id} ${(d * 100).toFixed(1)} cm`);
    if (d > tolGap) fail(`${label(req)} ${g.id}: anchor ${g.anchor.map((c) => c.toFixed(2))} is ${d.toFixed(3)} m off the element (tolerance ${tolGap.toFixed(3)})`);
  }
  free(r);
  const tc = Date.now(), row = { s: 0 };
  rows.push(row);
  row.text = () => `${label(req).padEnd(48)} ${row.s.toFixed(1).padStart(5)} s  ${grips.map((g) => `${g.id}[${g.kind} ${+g.min.toFixed(3)}–${+g.max.toFixed(3)}${g.unit} @${+g.value.toFixed(3)}]`).join(' ')}`;
  if (!grips.length) { fail(`${label(req)}: no grips`); continue; }
  const ids = new Set();
  for (const g of grips) {
    const where = `${label(req)} ${g.id}`;
    for (const k of ['id', 'field', 'label', 'kind', 'anchor', 'dir', 'value', 'unit', 'min', 'max', 'ticks', 'perMetre', 'snap', 'apply', 'format']) {
      if (!(k in g)) fail(`${where}: no ${k}`);
    }
    if (ids.has(g.id)) fail(`${where}: duplicate id`);
    ids.add(g.id);
    if (!['length', 'count', 'angle'].includes(g.kind)) fail(`${where}: kind ${g.kind}`);
    if (g.anchor.length !== 3 || !g.anchor.every(Number.isFinite)) fail(`${where}: anchor ${g.anchor}`);
    if (Math.abs(Math.hypot(...g.dir) - 1) > 1e-9) fail(`${where}: dir not unit`);
    if (!(g.min < g.max) || !Number.isFinite(g.value) || !(g.perMetre > 0)) fail(`${where}: range ${g.min}–${g.max} value ${g.value} perMetre ${g.perMetre}`);
    if (g.value < g.min - 1e-9 || g.value > g.max + 1e-9) fail(`${where}: value ${g.value} outside ${g.min}–${g.max}`);
    if (typeof g.format(g.value) !== 'string' || !g.format(g.value)) fail(`${where}: format`);
    if (g.ticks !== null && !(Array.isArray(g.ticks) && g.ticks.every((t) => Number.isFinite(t.v)))) fail(`${where}: ticks`);
    if (g.kind === 'count' && !Number.isInteger(g.snap(g.value + 0.4))) fail(`${where}: count snap not an integer`);
    // the anchor sits on (or very near) the build's box
    const pad = 0.05 * Math.max(...r.size);
    for (let a = 0; a < 3; a++) if (g.anchor[a] < r.bbox.min[a] - pad || g.anchor[a] > r.bbox.max[a] + pad) fail(`${where}: anchor off the element (${g.anchor.map((c) => c.toFixed(2))})`);

    // min, mid, max: valid, one solid, honoured
    const ext = [];
    for (const v0 of [g.min, (g.min + g.max) / 2, g.max]) {
      const v = g.snap(v0), patch = g.apply(v), req2 = { ...req, ...patch };
      const at = `${where}=${+v.toFixed(4)}`;
      const n = normalize(req2);
      const clamped = n.warnings.filter((w) => w.startsWith(`${g.field} `));
      if (clamped.length) fail(`${at}: normalize: ${clamped.join('; ')}`);
      let r2;
      try { r2 = await build(req2); } catch (e) { fail(`${at}: build threw ${e.message}`); continue; }
      const bad = r2.parts.filter((p) => p.manifold.status() !== 'NoError');
      if (bad.length) fail(`${at}: ${bad.map((p) => `${p.name} ${p.manifold.status()}`).join(', ')}`);
      else {
        const n2 = solidCount(r2.parts);
        if (n2 !== 1) fail(`${at}: ${n2} solids`);
      }
      ext.push(r2.size[g.axis]);
      if (g.kind === 'count') {
        const part = COUNTED[g.field], got = r2.parts.filter((p) => p.name === part).reduce((t, p) => t + instanceCount(p), 0);
        if (got !== v) fail(`${at}: ${got} ${part} instances`);
      } else if (g.field === 'archType') {
        const want = g.ticks.find((t) => t.v === v).label;
        if (r2.spec.archType !== want) fail(`${at}: archType ${r2.spec.archType} != ${want}`);
      } else if (g.extent) {
        if (Math.abs(r2.size[g.axis] - v) > 0.01 * v) fail(`${at}: extent ${r2.size[g.axis].toFixed(4)} != ${v}`);
      } else if (r2.spec[g.field] !== v) fail(`${at}: built ${g.field} ${r2.spec[g.field]} != ${v}`);
      free(r2);
    }
    // a value that is not the extent still moves it the right way (an angle grip moves the apex up)
    if (!g.extent && g.kind !== 'count' && g.field !== 'archType' && !(ext[2] > ext[0])) fail(`${where}: extent does not grow with the value (${ext.map((e) => e.toFixed(3))})`);
    row.s = (Date.now() - tc) / 1000;
  }
}

// ------------------------------------------------------------------------------------------------ ticks and labels

{
  const r = await build({ element: 'portico' });
  const g = gripsFor(r.spec, info(r)).find((q) => q.id === 'columns');
  free(r);
  assert.deepEqual(g.ticks.map((t) => t.v), [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.equal(g.ticks.find((t) => t.v === 6).label, 'hexastyle');
  assert.equal(g.snap(5.2), 6);
  assert.equal(g.snap(3.1), 4);
  assert.equal(g.snap(40), 16);
  assert.equal(g.format(6), '6 columns · hexastyle');
  assert.deepEqual(g.apply(7.9), { columns: 8 });
}
{
  const r = await build({ element: 'balustrade', balusters: 12 });
  const gs = gripsFor(r.spec, info(r));
  free(r);
  const L = gs.find((q) => q.id === 'length'), N = gs.find((q) => q.id === 'balusters');
  assert.equal(N.value, 12);
  // the length grip drops a stated count so the balusters re-array at classical spacing; the count grip drops the length
  const p = L.apply(4.5);
  assert.ok('balusters' in p && p.balusters === undefined && p.length === 4.5);
  const q = N.apply(15);
  assert.ok('length' in q && q.length === undefined && q.balusters === 15);
  const a = await build({ element: 'balustrade', balusters: 12, ...L.apply(3) }), b = await build({ element: 'balustrade', balusters: 12, ...L.apply(6) });
  const cnt = (x) => x.parts.filter((pp) => pp.name === 'baluster').reduce((t, pp) => t + instanceCount(pp), 0);
  if (!(cnt(b) > cnt(a))) fail(`balustrade: longer run does not get more balusters (${cnt(a)} -> ${cnt(b)})`);
  // the derived count of a length-driven run (from the build's expected counts) is the grip's value
  const gs2 = gripsFor(a.spec, info(a));
  assert.equal(gs2.find((g) => g.id === 'balusters').value, cnt(a));
  // without expected counts the engine's own estimate agrees for the default run
  const gs3 = gripsFor(a.spec, { size: a.size, bbox: a.bbox });
  assert.equal(gs3.find((g) => g.id === 'balusters').value, cnt(a));
  free(a); free(b);
}
{
  const r = await build({ element: 'arch' });
  const g = gripsFor(r.spec, info(r)).find((q) => q.id === 'rise');
  free(r);
  assert.equal(g.field, 'archType');
  assert.deepEqual(g.apply(g.value), { archType: 'semicircular' });
  assert.deepEqual(g.apply(0.866 * 2.4), { archType: 'pointed' });
  assert.deepEqual(g.apply(0.6), { archType: 'segmental' });
  assert.match(g.format(1.2), /semicircular/);
}

// ------------------------------------------------------------------------------------------------ parseTyped

{
  const r = await build({ element: 'balustrade' });
  const L = gripsFor(r.spec, info(r)).find((q) => q.id === 'length');
  free(r);
  const near = (a, b) => a !== null && Math.abs(a - b) < 1e-9;
  assert.equal(L.value, 3);
  assert.ok(near(parseTyped('4.5', L, r.spec), 4.5));
  assert.ok(near(parseTyped('4.5 m', L, r.spec), 4.5));
  assert.ok(near(parseTyped('4,5', L, r.spec), 4.5));
  assert.ok(near(parseTyped('450 cm', L, r.spec), 4.5));
  assert.ok(near(parseTyped('4500 mm', L, r.spec), 4.5));
  assert.ok(near(parseTyped("12'", L, r.spec), 3.658));
  assert.ok(near(parseTyped('12 ft 6 in', L, r.spec), 3.81));
  assert.ok(near(parseTyped("12' 6\"", L, r.spec), 3.81));
  assert.ok(near(parseTyped('30 in', L, r.spec), 0.762));
  assert.ok(near(parseTyped('+10%', L, r.spec), 3.3));
  assert.ok(near(parseTyped('-10%', L, r.spec), 2.7));
  assert.ok(near(parseTyped('+0.5', L, r.spec), 3.5));
  assert.ok(near(parseTyped('-50 cm', L, r.spec), 2.5));
  assert.ok(near(parseTyped('200 m', L, r.spec), L.max));          // clamped to the legal range
  for (const bad of ['', '   ', 'abc', '4.5 kg', '35°', '9D', '1..2', '--3', null, undefined, {}]) assert.equal(parseTyped(bad, L, r.spec), null, `${bad}`);
}
{
  const r = await build({ element: 'column' });
  const H = gripsFor(r.spec, info(r)).find((q) => q.id === 'height');
  free(r);
  const D = 0.45;                                                    // the ionic default diameter
  assert.ok(Math.abs(parseTyped('9D', H, r.spec) - 9 * D) < 1e-9);
  assert.ok(Math.abs(parseTyped('10 d', H, r.spec) - 10 * D) < 1e-3);
  assert.equal(parseTyped('35°', H, r.spec), null);
  // a typed module height builds a column that tall
  const c = await build({ element: 'column', ...H.apply(parseTyped('10D', H, r.spec)) });
  assert.ok(Math.abs(c.size[2] - 4.5) < 0.005 * 4.5);
  free(c);
}
{
  const r = await build({ element: 'roof', roofType: 'gable' });
  const P = gripsFor(r.spec, info(r)).find((q) => q.id === 'pitch');
  free(r);
  assert.equal(P.kind, 'angle');
  assert.equal(P.unit, '°');
  assert.equal(P.min, 5);
  assert.equal(P.max, 75);
  assert.equal(parseTyped('35°', P, r.spec), 35);
  assert.equal(parseTyped('35 deg', P, r.spec), 35);
  assert.equal(parseTyped('40', P, r.spec), 40);
  assert.equal(parseTyped('+5°', P, r.spec), 40);
  assert.equal(parseTyped('90°', P, r.spec), 75);
  assert.equal(parseTyped('4 m', P, r.spec), null);
  assert.equal(P.format(35), '35°');
}
{
  const r = await build({ element: 'portico' });
  const C = gripsFor(r.spec, info(r)).find((q) => q.id === 'columns');
  free(r);
  assert.equal(parseTyped('6', C, r.spec), 6);
  assert.equal(parseTyped('6 columns', C, r.spec), 6);
  assert.equal(parseTyped('hexastyle', C, r.spec), 6);
  assert.equal(parseTyped('+2', C, r.spec), 6);
  assert.equal(parseTyped('5', C, r.spec), 6);                       // an odd count snaps to an even one
  assert.equal(parseTyped('six', C, r.spec), null);
  assert.equal(parseTyped('6 m', C, r.spec), null);
}

console.log(rows.map((w) => w.text()).join('\n'));
if (process.env.GRIPS_GAPS) console.log(gaps.join('\n'));
const s = ((Date.now() - t0) / 1000).toFixed(1);
if (fails) {
  console.log(`\n${errs.join('\n')}`);
  console.log(`\ngrips: ${fails} failure(s), ${builds} builds, ${s} s`);
  process.exit(1);
}
console.log(`\ngrips: ${CASES.length} cases, all grips honoured at min / mid / max as one solid (${unions} unions, ${boxed} box-connectivity); ${builds} builds, ${s} s`);
