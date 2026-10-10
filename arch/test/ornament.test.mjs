// node arch/test/ornament.test.mjs [outDir]  — motif validity + a preview sheet
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { initKernel, ARCHKIT } from './node-kernel.mjs';
import { part, mat } from '../js/kernel.js';
import { acanthusLeaf, voluteScroll, eggAndDart, rosette } from '../js/ornament.js';
import { renderPNG, sheet } from './raster.mjs';
import { selfIntersections } from './self-intersect.mjs';

await initKernel();
const out = process.argv[2] || (ARCHKIT ? `${ARCHKIT}/previews` : path.join(os.tmpdir(), 'arch-previews'));   // no tool drive (CI): the temp folder
fs.mkdirSync(out, { recursive: true });
const t0 = performance.now();
const leaf = acanthusLeaf({ h: 0.3, w: 0.2, wrap: 0.25 });
const flat = acanthusLeaf({ h: 0.3, w: 0.2, wrap: 0 });
const vol = voluteScroll({ r0: 0.1, depth: 0.45 });
const { egg, dart } = eggAndDart({ h: 0.05, w: 0.035, d: 0.02 });
const ros = rosette(0.05);
console.log('built in', Math.round(performance.now() - t0), 'ms');
for (const [n, m] of Object.entries({ leaf, flat, vol, egg, dart, ros })) {
  assert.equal(m.status(), 'NoError', n);
  assert.ok(m.volume() > 0, n);
  const bb = m.boundingBox();
  console.log(n, 'tris', m.numTri(), 'size', bb.max.map((x, i) => +(x - bb.min[i]).toFixed(3)));
}
// the leaf's shell must not fold into itself where it can be avoided: ridges keep their crest radius above half the
// blade's thickness (the remaining crossings are at the lobes' notches). The Corinthian lower leaf had 619 before.
const lower = acanthusLeaf({ h: 0.36 * 0.42, w: 0.44 * 0.36, wrap: 0.48 * 0.36, lean: 0.16 });
const crossings = selfIntersections(lower);
console.log('corinthian lower leaf: self-crossing triangle pairs', crossings);
assert.ok(crossings < 450, `leaf self-crossings ${crossings}`);
const bb = leaf.boundingBox();
assert.ok(Math.abs(bb.max[2] - bb.min[2] - 0.3) < 0.3 * 0.06, 'leaf height ~ h');
const views = (parts) => ['three-quarter', 'front', 'side'].map((v) => renderPNG(parts, { size: 360, view: v }));
fs.writeFileSync(`${out}/ornament.png`, sheet([
  ...views([part('leaf', 'stone', leaf)]), ...views([part('flat', 'stone', flat)]),
  ...views([part('vol', 'stone', vol)]), ...views([part('egg', 'stone', egg), part('dart', 'stone', dart, Float64Array.from(mat.T(0.026, 0, 0))), part('ros', 'stone', ros, Float64Array.from(mat.T(0.12, 0, 0)))]),
], 3));
console.log('wrote', `${out}/ornament.png`);
