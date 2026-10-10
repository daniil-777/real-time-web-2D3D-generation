// Column family: every order × {plain, pedestal, no base} for columns and pilasters builds watertight, at the exact
// height, as ONE solid (base, shaft and capital overlap — printable, no floating pieces), within the time budget;
// re-generation by height hits the unit-D cache; fluted shafts carry the requested number of flutes.
//   node arch/test/column.test.mjs
import assert from 'node:assert/strict';
import { initKernel, TIME_SCALE } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { ORDER_KEYS } from '../js/orders.js';
import { solids } from './solid.mjs';

await initKernel();
let n = 0, worst = 0;
for (const element of ['column', 'pilaster']) for (const order of ORDER_KEYS) for (const extra of [{}, { pedestal: true }, { base: 'none' }]) {
  const g = await generate({ element, order, height: 3.6, ...extra });
  const tag = `${element} ${order} ${JSON.stringify(extra)}`;
  assert.ok(g.parts.every((p) => p.manifold.status() === 'NoError'), `${tag}: manifold`);
  assert.ok(Math.abs(g.size[2] - 3.6) <= 0.005 * 3.6, `${tag}: height ${g.size[2]}`);
  assert.equal(solids(g.parts).length, 1, `${tag}: one solid`);
  worst = Math.max(worst, g.ms); n++;
}
assert.ok(worst < 500 * TIME_SCALE, `first builds within ${500 * TIME_SCALE} ms (worst ${Math.round(worst)} ms)`);
// cached re-generation: a new height is a scale, not a rebuild
const t = performance.now();
for (const h of [2.5, 3, 4, 5, 6, 8]) await generate({ element: 'column', order: 'corinthian', height: h });
const per = (performance.now() - t) / 6;
assert.ok(per < 60, `cached re-generation ${per.toFixed(1)} ms`);
// flutes by slicing the shaft halfway up
for (const [order, flutes] of [['doric', 20], ['ionic', 24], ['corinthian', 28], ['tuscan', 0], ['egyptian', 8]]) {
  const g = await generate({ element: 'column', order, height: 4, ...(order === 'corinthian' ? { flutes } : {}) });
  const shaft = g.parts.find((p) => p.name === 'shaft'), bb = shaft.manifold.boundingBox();
  const poly = shaft.manifold.slice((bb.min[2] + bb.max[2]) / 2).toPolygons().reduce((a, b) => (b.length > a.length ? b : a));
  const r = poly.map(([x, y]) => Math.hypot(x, y)), lo = Math.min(...r), hi = Math.max(...r);
  let c = 0;
  if (hi - lo > 0.004 * hi) { const th = lo + (hi - lo) / 2; let inside = r[r.length - 1] < th; for (const v of r) { if (v < th && !inside) c++; inside = v < th; } }
  assert.equal(c, flutes, `${order} flutes ${c} vs ${flutes}`);
}
console.log(`${n} column/pilaster builds: one solid, exact height, NoError; worst first build ${Math.round(worst)} ms; cached ${per.toFixed(1)} ms; flute counts exact`);
