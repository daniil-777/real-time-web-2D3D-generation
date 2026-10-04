// Roof family tests: node arch/test/roof.test.mjs
// Every roof type × every covering, every detail level, extreme legal sizes and pitches, orientation (width > length),
// material → covering inference, height → pitch solving, given overhangs, dormers on / off. Each build:
// - all parts NoError with positive volume; lowest point z = 0; bbox = expected() within tol; counts exact;
// - every single (non-instanced) part lies inside the promised (L + 2o) × (W + 2o) × z box (± 1 mm);
// - every covering piece lies ON the deck: each vertex 0…(a tile's height) above the deck's top surface, the surface
//   taken from the built deck mesh itself (no floating tiles, none sunk into the roof);
// - independent of dims(): the pitches measured on the built deck equal the pitches the spec asks for (brief's table:
//   gable / hip / pyramid 35°, shed 15°, mansard 70/30, gambrel 60/25; a given pitch replaces the lower slope when
//   ≥ 45° and the upper when < 45° on mansard / gambrel), and the ridge rise measured on the deck = half-span × tan(pitch);
// - cut-tile meshes built by the JS clipper (no Manifold fallback); build < 500 ms, < 2 M triangles.
import assert from 'node:assert/strict';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { SCHEMA, MATERIALS } from '../js/spec.js';
import { mat, partsBBox, instanceCount } from '../js/kernel.js';
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
  cases.push({ roofType, pitch: SCHEMA.pitch.min }, { roofType, pitch: SCHEMA.pitch.max }, { roofType, pitch: 35 });
  cases.push({ roofType, height: 5 });                                             // ridge height given → pitch solved
  cases.push({ roofType, overhang: 1.2 }, { roofType, overhang: SCHEMA.overhang.min }, { roofType, overhang: SCHEMA.overhang.max });
}
cases.push({ roofType: 'hip', width: SCHEMA.width.max, length: SCHEMA.length.max });           // 80 × 120 m
cases.push({ roofType: 'mansard', width: SCHEMA.width.max, length: SCHEMA.length.max, covering: 'slate' });
cases.push({ roofType: 'gable', width: SCHEMA.width.max, length: SCHEMA.length.max, covering: 'pantiles' });
cases.push({ roofType: 'gable', material: 'copper' }, { roofType: 'hip', material: 'slate' }, { roofType: 'gable', material: 'wood' });
cases.push({ roofType: 'gable', covering: 'tiles', material: 'copper' }, { roofType: 'hip', covering: 'shingles', material: 'zinc' },
  { roofType: 'mansard', covering: 'slate', material: 'limestone' }, { roofType: 'gable', covering: 'seam', material: 'terracotta' });
cases.push({ roofType: 'mansard', pitch: 75 }, { roofType: 'mansard', pitch: 20 }, { roofType: 'gambrel', pitch: 50 }, { roofType: 'gambrel', pitch: 15 });
cases.push({ roofType: 'gable', width: 9, length: 13, pitch: 45, covering: 'shingles', detail: 'medium' });
cases.push({ roofType: 'gable', overhang: 1.4, pitch: 25, covering: 'shingles' });            // a chalet
for (const roofType of ['gable', 'hip', 'mansard']) cases.push({ roofType, dormers: true }, { roofType, dormers: true, detail: 'low' });
cases.push({ roofType: 'mansard', dormers: false }, { roofType: 'gable', dormers: true, pitch: 50, covering: 'slate' });
cases.push({ roofType: 'gambrel', dormers: true }, { roofType: 'gable', dormers: true, pitch: 15 });   // no dormers: type / too flat

// ---------------------------------------------------------------------------------------------- independent checks

/** The pitches the brief asks for (independent restatement, not dims()). */
function askedPitches(c) {
  const own = { gable: [35, 35], hip: [35, 35], pyramid: [35, 35], shed: [15, 15], mansard: [70, 30], gambrel: [60, 25] }[c.roofType];
  if (c.pitch === undefined) return own;
  if (c.roofType === 'mansard' || c.roofType === 'gambrel') return c.pitch >= 45 ? [c.pitch, own[1]] : [own[0], c.pitch];
  return [c.pitch, c.pitch];
}

/** Planes of the deck's top surface (up-facing triangles of the built deck mesh), world coordinates. */
function deckPlanes(parts) {
  const deck = parts.find((p) => p.name === 'deck');
  const m = deck.transforms ? deck.manifold.transform(deck.transforms.subarray(0, 16)) : deck.manifold;
  const g = m.getMesh(), V = g.vertProperties, T = g.triVerts, np = g.numProp, planes = [];
  for (let t = 0; t < T.length; t += 3) {
    const P = [0, 1, 2].map((k) => [V[T[t + k] * np], V[T[t + k] * np + 1], V[T[t + k] * np + 2]]);
    const u = P[1].map((x, i) => x - P[0][i]), v = P[2].map((x, i) => x - P[0][i]);
    const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...c);
    if (l < 1e-9 || c[2] / l < 0.05) continue;
    const n = c.map((x) => x / l), d = n[0] * P[0][0] + n[1] * P[0][1] + n[2] * P[0][2];
    if (!planes.some((q) => Math.abs(q.n[0] - n[0]) + Math.abs(q.n[1] - n[1]) + Math.abs(q.n[2] - n[2]) < 1e-4 && Math.abs(q.d - d) < 1e-4)) planes.push({ n, d });
  }
  return { planes, bb: m.boundingBox() };
}
/** Height of p above the deck's top surface, measured along the normal of the face under it (convex roof: the top
 *  surface is the lowest of the face planes). */
function aboveDeck(planes, p) {
  let best = null, bz = Infinity;
  for (const q of planes) { const z = (q.d - q.n[0] * p[0] - q.n[1] * p[1]) / q.n[2]; if (z < bz) { bz = z; best = q; } }
  return (p[2] - bz) * best.n[2];
}
const COVER_PART = /^(tile|slate|shingle|pantile|pan|seam)(-cut|-course|-course-cut)?$/;

function coveringOnDeck(r, D) {
  const { planes } = deckPlanes(r.parts);
  // a lapped piece rises at most its lift + thickness (+ an S pantile's wave, a seam's height) above the battens
  const hMax = 1.05 * D.C.hT + 0.001;
  let n = 0, lo = Infinity, hi = -Infinity;
  for (const p of r.parts) {
    if (!COVER_PART.test(p.name)) continue;
    const g = p.manifold.getMesh(), V = g.vertProperties, np = g.numProp, nv = V.length / np;
    const k = instanceCount(p);
    for (let i = 0; i < k; i++) {
      const M = p.transforms ? p.transforms.subarray(16 * i, 16 * i + 16) : null;
      for (let j = 0; j < nv; j++) {
        let q = [V[j * np], V[j * np + 1], V[j * np + 2]];
        if (M) q = mat.apply(M, q);
        const h = aboveDeck(planes, q);
        lo = Math.min(lo, h); hi = Math.max(hi, h); n++;
      }
    }
  }
  assert.ok(n > 0, 'no covering found');
  assert.ok(lo > -0.0015, `a covering piece sinks ${(-lo * 1000).toFixed(1)} mm into the deck`);
  assert.ok(hi < hMax, `a covering piece floats ${(hi * 1000).toFixed(0)} mm above the deck (max ${(hMax * 1000).toFixed(0)})`);
  return { lo, hi };
}

function pitchesOnDeck(r, c) {
  const { planes, bb } = deckPlanes(r.parts);
  const measured = [...new Set(planes.map((q) => +(Math.acos(q.n[2]) * 180 / Math.PI).toFixed(2)))].sort((a, b) => a - b);
  if (c.height !== undefined) return measured;          // the pitch was solved from the height
  const [lo, up] = askedPitches(c), near = (a, b) => Math.abs(a - b) < 0.05;
  if (c.roofType === 'mansard' || c.roofType === 'gambrel') {
    assert.ok(measured.length === 2 && near(measured[0], Math.min(lo, up)) && near(measured[1], Math.max(lo, up)),
      `pitches ${measured} vs asked ${lo}/${up}`);
  } else if (c.roofType === 'pyramid') {
    assert.ok(near(measured[measured.length - 1], lo), `pyramid long-side pitch ${measured} vs asked ${lo}`);
  } else {
    assert.ok(measured.every((m) => near(m, lo)), `pitches ${measured} vs asked ${lo}`);
    // ridge rise on the built deck = half-span × tan(pitch), span measured across the ridge on the deck
    const ex = [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]], across = Math.min(...ex);
    // the deck's highest point minus the top edge at the eave (eave top = highest point of the deck's eave plumb cut)
    const zEave = eaveTop(r.parts);
    const run = c.roofType === 'shed' ? across : across / 2;
    const rise = bb.max[2] - zEave, want = run * Math.tan((lo * Math.PI) / 180);
    assert.ok(Math.abs(rise - want) < 0.002 * Math.max(1, want) + 1e-4, `ridge rise ${rise.toFixed(4)} vs ${want.toFixed(4)} (half-span × tan pitch)`);
  }
  return measured;
}
/** z of the deck's top edge at the eaves: the lowest vertex of its up-facing surface. */
function eaveTop(parts) {
  const deck = parts.find((p) => p.name === 'deck');
  const m = deck.transforms ? deck.manifold.transform(deck.transforms.subarray(0, 16)) : deck.manifold;
  const g = m.getMesh(), V = g.vertProperties, T = g.triVerts, np = g.numProp;
  let z = Infinity;
  for (let t = 0; t < T.length; t += 3) {
    const P = [0, 1, 2].map((k) => [V[T[t + k] * np], V[T[t + k] * np + 1], V[T[t + k] * np + 2]]);
    const u = P[1].map((x, i) => x - P[0][i]), v = P[2].map((x, i) => x - P[0][i]);
    const cz = u[0] * v[1] - u[1] * v[0], l = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], cz);
    if (l > 1e-9 && cz / l > 0.05) for (const q of P) z = Math.min(z, q[2]);
  }
  return z;
}

// ---------------------------------------------------------------------------------------------- run

const rows = [];
let fail = 0, worstMs = 0, worstTris = 0;
for (const c of cases) {
  const spec = { element: 'roof', ...c };
  const label = Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ');
  try {
    const r = await generate(spec);
    const e = r.expected, D = dims(r.spec);
    for (const p of r.parts) {
      assert.equal(p.manifold.status(), 'NoError', `${p.name} not manifold`);
      assert.ok(p.manifold.volume() > 0, `${p.name} has no volume`);
      if (p.transforms) assert.ok(p.transforms.length >= 16 && p.transforms.every(Number.isFinite), `${p.name} transforms`);
      if (p.meta && p.meta.clipFallbacks !== undefined) assert.equal(p.meta.clipFallbacks, 0, `${p.name}: clipper fell back to Manifold trims`);
      assert.ok(p.meta && (MATERIALS.includes(p.meta.material) || p.meta.material === 'glass'), `${p.name}: meta.material ${p.meta && p.meta.material}`);
    }
    assert.ok(Math.abs(r.bbox.min[2]) < 1e-6, `lowest point at z = ${r.bbox.min[2]}, not 0`);
    ['x', 'y', 'z'].forEach((a, i) => {
      if (e.size[a] === undefined) return;
      const err = Math.abs(r.size[i] - e.size[a]) / e.size[a];
      assert.ok(err <= e.tol, `${a}: ${r.size[i].toFixed(4)} vs expected ${e.size[a].toFixed(4)} (${(err * 100).toFixed(2)} %)`);
    });
    // the promised footprint: (length + 2o) × (width + 2o), o = the given overhang when it is buildable
    const L = r.spec.length, W = r.spec.width;
    assert.ok(Math.abs(e.size.x - (L + 2 * D.o)) < 1e-9 && Math.abs(e.size.y - (W + 2 * D.o)) < 1e-9, 'expected = footprint + 2 overhang');
    if (c.overhang !== undefined) assert.ok(D.o >= c.overhang - 1e-9 && (D.o - c.overhang < 1e-9 || c.overhang < 0.35 * D.k + 1e-9), `overhang ${D.o} vs asked ${c.overhang}`);
    else assert.ok(D.o > 0 && D.o < 0.9 && D.o <= 0.2 * D.short + 1e-9, `default overhang ${D.o}`);
    // every single part inside the promised box (± 1 mm)
    for (const p of r.parts) {
      if (instanceCount(p) > 1) continue;
      const b = partsBBox([p]), t = 0.001;
      assert.ok(b.min[0] >= -e.size.x / 2 - t && b.max[0] <= e.size.x / 2 + t && b.min[1] >= -e.size.y / 2 - t && b.max[1] <= e.size.y / 2 + t
        && b.min[2] >= -t && b.max[2] <= e.size.z + t, `${p.name} outside the promised box`);
    }
    for (const [name, n] of Object.entries(e.counts)) {
      const p = r.parts.find((q) => q.name === name);
      assert.equal(p ? instanceCount(p) : 0, n, `count ${name}`);
    }
    const cov = coveringOnDeck(r, D);
    const pitch = pitchesOnDeck(r, c);
    if (c.height) assert.ok(Math.abs(r.size[2] - c.height) / c.height < 0.005 || D.lo <= 5.001 || D.lo >= 74.999 || D.up <= 5.001,
      `height ${r.size[2]} vs asked ${c.height}`);
    const dormer = r.parts.find((q) => q.name === 'dormer');
    if (c.dormers === false || c.roofType === 'gambrel' || (c.dormers && c.pitch === 15)) assert.ok(!dormer, 'unexpected dormers');
    else if (c.dormers === true) assert.ok(dormer && instanceCount(dormer) >= 2, 'dormers asked for, none built');
    assert.ok(r.ms < 500, `build ${r.ms.toFixed(0)} ms ≥ 500 ms`);
    assert.ok(r.tris < 2e6, `${r.tris} triangles ≥ 2 M`);
    worstMs = Math.max(worstMs, r.ms); worstTris = Math.max(worstTris, r.tris);
    const pieces = r.parts.reduce((s, p) => s + instanceCount(p), 0);
    rows.push(['ok', label, r.size.map((x) => x.toFixed(2)).join('×'), `${r.ms.toFixed(0)} ms`, `${(r.tris / 1000).toFixed(0)}k tris`,
      `${pieces} pcs`, `pitch ${pitch.join('/')}°`, `on deck ${(cov.lo * 1000).toFixed(1)}…${(cov.hi * 1000).toFixed(0)} mm`]);
  } catch (err) {
    fail++;
    rows.push(['FAIL', label, String(err.message || err).slice(0, 160)]);
  }
}
const w = [4, 50, 22, 8, 12, 10, 18, 20];
for (const r of rows) console.log(r.map((x, i) => String(x).padEnd(w[i] || 0)).join(' '));
console.log(`${rows.length - fail}/${rows.length} roof builds pass · slowest ${worstMs.toFixed(0)} ms · most ${(worstTris / 1e6).toFixed(2)} M triangles`);

// rules that are not about one build
const R = (c) => dims({ element: 'roof', width: 8, length: 12, ...c });
assert.deepEqual([R({ roofType: 'mansard' }).lo, R({ roofType: 'mansard' }).up], [70, 30]);
assert.deepEqual([R({ roofType: 'gambrel' }).lo, R({ roofType: 'gambrel' }).up], [60, 25]);
assert.deepEqual([R({ roofType: 'mansard', pitch: 35 }).lo, R({ roofType: 'mansard', pitch: 35 }).up], [70, 35]);
assert.equal(R({ roofType: 'mansard', pitch: 75 }).lo, 75);
assert.equal(R({ roofType: 'gambrel', pitch: 20 }).up, 20);
assert.equal(R({ roofType: 'shed' }).lo, 15);
assert.equal(R({ roofType: 'shed', pitch: 35 }).lo, 35);
assert.equal(R({ roofType: 'gable' }).lo, 35);
// covering: stated wins; unset → from the stated material; neither → tiles
assert.equal(R({ roofType: 'gable', material: 'zinc' }).cover, 'seam');
assert.equal(R({ roofType: 'gable', material: 'slate' }).cover, 'slate');
assert.equal(R({ roofType: 'gable', material: 'wood' }).cover, 'shingles');
assert.equal(R({ roofType: 'gable', material: 'brick' }).cover, 'tiles');
assert.equal(R({ roofType: 'gable', material: 'limestone' }).cover, 'tiles');
assert.equal(R({ roofType: 'gable' }).cover, 'tiles');
assert.equal(R({ roofType: 'gable', material: 'zinc', covering: 'tiles' }).cover, 'tiles');
// material of the pieces (part meta), for a few stated / unstated combinations
const matOf = async (c, name) => (await generate({ element: 'roof', roofType: 'gable', ...c })).parts.find((p) => p.name === name).meta.material;
assert.equal(await matOf({}, 'tile'), 'terracotta');
assert.equal(await matOf({ covering: 'pantiles' }, 'pantile'), 'terracotta');
assert.equal(await matOf({ covering: 'slate' }, 'slate'), 'slate');
assert.equal(await matOf({ covering: 'seam' }, 'pan'), 'zinc');
assert.equal(await matOf({ covering: 'shingles' }, 'shingle'), 'wood');
assert.equal(await matOf({ covering: 'tiles', material: 'copper' }, 'tile'), 'copper');         // copper tiles
assert.equal(await matOf({ material: 'copper' }, 'pan'), 'copper');                             // a copper roof: seam
assert.equal(await matOf({ covering: 'seam', material: 'terracotta' }, 'pan'), 'zinc');         // a seam needs a metal
assert.equal(await matOf({ covering: 'slate', material: 'limestone' }, 'slate'), 'slate');      // stone → the masonry
assert.equal(await matOf({ covering: 'slate', material: 'limestone' }, 'cornice'), 'limestone');
assert.equal(await matOf({}, 'cornice'), 'limestone');
assert.equal(await matOf({}, 'gable'), 'plaster');
assert.equal(await matOf({ covering: 'slate' }, 'gutter'), 'zinc');
assert.equal(await matOf({}, 'gutter'), 'copper');
assert.equal(R({ roofType: 'gable', overhang: 1.2 }).o, 1.2);
assert.ok(R({ roofType: 'gable', overhang: 1.2, pitch: 25 }).knee, 'a long overhang on a low pitch raises a knee wall');
console.log('pitch / overhang / covering / material rules ok');
if (fail) process.exit(1);
