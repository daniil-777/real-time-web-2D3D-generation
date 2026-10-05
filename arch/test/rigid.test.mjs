// meta.rigid tags: node arch/test/rigid.test.mjs
// Every part every generator returns for the default spec of each of the 24 elements carries a boolean meta.rigid
// (deform.js then never falls back to its size rule); prints element -> rigid parts / warped parts; and a balustrade
// bent 120° keeps every baluster instance's mesh identical because of the tag (also with the size rule switched off),
// while the same part tagged rigid: false is warped.
import assert from 'node:assert/strict';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { ELEMENTS } from '../js/spec.js';
import { deformParts } from '../js/deform.js';

await initKernel();
let fails = 0;
const fail = (m) => { fails++; console.log('FAIL', m); };

console.log('element'.padEnd(12), 'rigid parts | warped parts');
for (const element of ELEMENTS) {
  const g = await generate({ element });
  const rigid = [], warped = [];
  for (const p of g.parts) {
    if (typeof p.meta?.rigid !== 'boolean') fail(`${element}: part "${p.name}" has meta.rigid = ${p.meta?.rigid}`);
    (p.meta?.rigid ? rigid : warped).push(p.name);
  }
  const u = (a) => [...new Set(a)].join(', ') || '-';
  console.log(element.padEnd(12), u(rigid), ' | ', u(warped));
}

// the tags win: balusters keep their mesh under a 120 degree bend, with the default rigidRatio (RIGID_RATIO) and with the size rule off
const bend = [{ type: 'bend', axis: 'x', angle: 120 }];
const g = await generate({ element: 'balustrade', length: 4 });
const checkBalusters = (label, opts) => {
  const r = deformParts(g.parts, bend, opts);
  for (const n of ['baluster', 'half-baluster']) {
    const a = g.parts.find((p) => p.name === n), b = r.parts.find((p) => p.name === n);
    if (!a || !b) { fail(`${label}: no ${n}`); continue; }
    try {
      assert.equal(b.manifold, a.manifold, 'same Manifold object');
      assert.equal(b.manifold.numTri(), a.manifold.numTri());
      assert.equal(b.transforms.length, a.transforms.length);
      assert.equal(b.meta.deform, 'rigid');
    } catch (e) { fail(`${label} ${n}: ${e.message}`); }
  }
  for (const n of ['rail', 'plinth']) {
    const a = g.parts.find((p) => p.name === n), b = r.parts.find((p) => p.name === n);
    if (r.parts.filter((p) => p.name === n).every((p) => p.meta.deform === 'rigid')) fail(`${label}: ${n} was moved rigidly, it must bend`);
  }
  console.log(`bend 120 ${label}: baluster instances identical (rigid): ok`);
};
checkBalusters('default rigidRatio (RIGID_RATIO 0.25)', {});
checkBalusters('rigidRatio 0 (size rule off)', { rigidRatio: 0 });

// control: the same part tagged false is warped (the tag, not the size, decides)
const flipped = g.parts.map((p) => (p.name === 'baluster' ? { ...p, meta: { ...p.meta, rigid: false } } : p));
const rf = deformParts(flipped, bend, {});
const warpedBal = rf.parts.filter((p) => p.name === 'baluster');
if (!warpedBal.length || warpedBal.some((p) => p.meta.deform === 'rigid')) fail('control: baluster tagged false was not warped');
else console.log('control: baluster tagged rigid:false is warped: ok');

console.log(fails ? `${fails} FAILED` : 'rigid tags: all ok');
process.exit(fails ? 1 : 0);
