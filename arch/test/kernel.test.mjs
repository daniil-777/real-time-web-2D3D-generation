// Kernel unit tests: node arch/test/kernel.test.mjs
import assert from 'node:assert/strict';
import { initKernel } from './node-kernel.mjs';
import { revolve, loft, thickSurface, tube, box, union, extrudeProfileX, extrudeXY, mat, radial, partsBBox, part, placeParts }
  from '../js/kernel.js';

await initKernel();
const near = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg}: ${a} vs ${b}`);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('revolve rectangle = cylinder', () => {
  const m = revolve([[0, 0], [0.5, 0], [0.5, 2], [0, 2]], 256);
  near(m.volume(), Math.PI * 0.25 * 2, 0.005, 'volume');
  assert.equal(m.status(), 'NoError');
});
t('revolve accepts clockwise profiles', () => {
  const m = revolve([[0, 0], [0, 2], [0.5, 2], [0.5, 0]], 256);
  near(m.volume(), Math.PI * 0.25 * 2, 0.005, 'volume');
});
t('loft of two squares = frustum', () => {
  const sq = (s) => [[-s, -s], [s, -s], [s, s], [-s, s]];
  const m = loft([sq(1), sq(0.5)], [0, 3]);
  const a1 = 4, a2 = 1, h = 3;
  near(m.volume(), (h / 3) * (a1 + a2 + Math.sqrt(a1 * a2)), 1e-6, 'volume');
  assert.equal(m.status(), 'NoError');
});
t('thickSurface flat patch', () => {
  const m = thickSurface((u, v) => [u, v, 0], 8, 8, 0.02);
  near(m.volume(), 0.02, 0.02, 'volume');
  assert.equal(m.genus(), 0);
});
t('thickSurface curved patch stays manifold', () => {
  const m = thickSurface((u, v) => [Math.cos(u * 2), Math.sin(u * 2), v * 0.5 + 0.1 * Math.sin(v * 9)], 24, 24, (u, v) => 0.01 + 0.01 * u);
  assert.equal(m.status(), 'NoError');
  assert.ok(m.volume() > 0);
});
t('tube is closed', () => {
  const pts = Array.from({ length: 40 }, (_, i) => [Math.cos(i / 6), Math.sin(i / 6), i * 0.02]);
  const m = tube(pts, (s) => 0.05 * (1 - 0.7 * s), 10);
  assert.equal(m.status(), 'NoError');
  assert.ok(m.volume() > 0);
});
t('overlapping cubes fuse into one body', () => {
  const m = union([box(0, 0, 0, 1, 1, 1), box(0.5, 0.5, 0.5, 1.5, 1.5, 1.5)]);
  assert.equal(m.genus(), 0);
  assert.equal(m.decompose().length, 1);
});
t('extrudeProfileX runs along X, profile in YZ', () => {
  const m = extrudeProfileX([[0, 0], [0.2, 0], [0.2, 0.1], [0, 0.1]], 3);
  const bb = m.boundingBox();
  near(bb.max[0] - bb.min[0], 3, 1e-6, 'x length');
  near(bb.max[1] - bb.min[1], 0.2, 1e-6, 'y depth');
  near(bb.max[2] - bb.min[2], 0.1, 1e-6, 'z height');
});
t('extrudeXY twist keeps volume', () => {
  const m = extrudeXY([[0.1, -0.05], [0.3, -0.05], [0.3, 0.05], [0.1, 0.05]], 1, { div: 256, twist: 360 });
  near(m.volume(), 0.02, 0.015, 'volume (sides are ruled between slices)');
});
t('mat.mul order: T·R rotates then translates', () => {
  const p = mat.apply(mat.mul(mat.T(1, 0, 0), mat.Rz(Math.PI / 2)), [1, 0, 0]);
  near(p[0], 1, 1e-9, 'x'); near(p[1], 1, 1e-9, 'y');
});
t('partsBBox honours instances', () => {
  const p = part('cube', 'stone', box(-0.5, -0.5, 0, 0.5, 0.5, 1), radial(4, mat.T(2, 0, 0)));
  const bb = partsBBox([p]);
  near(bb.max[0], 2.5, 1e-9, 'max x'); near(bb.min[1], -2.5, 1e-9, 'min y');
  const moved = placeParts([p], mat.T(0, 0, 3));
  near(partsBBox(moved).min[2], 3, 1e-9, 'placed');
});
// generate.family (audit C3): a rejected import() is dropped from the cache, so the next build retries the fetch
{
  const { family, FAMILY } = await import('../js/generate.js');
  FAMILY.__missing = '__missing';
  try {
    const p1 = family('__missing');
    await assert.rejects(p1);
    const p2 = family('__missing');
    assert.notEqual(p2, p1, 'a rejected import must not stay cached');
    await assert.rejects(p2);
    const a = family('column');
    assert.equal(family('column'), a, 'a good import stays cached');
    await a;
  } finally { delete FAMILY.__missing; }
  n++; console.log('ok family(): a rejected import is not cached');
}
console.log(`${n} kernel tests passed`);
