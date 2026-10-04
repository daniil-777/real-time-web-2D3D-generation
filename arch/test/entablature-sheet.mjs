// Contact sheet of many specs: node arch/test/entablature-sheet.mjs out.png view size cols '<spec>' '<spec>' ...
// (a spec may carry "_tilt": deg to be seen from below, "_x": [x0, x1] / "_z": [z0, z1] to clip a detail)
import fs from 'node:fs';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { mat, placeParts } from '../js/kernel.js';
import { renderPNG, sheet } from './raster.mjs';

await initKernel();
const [out, view, size, cols, ...specs] = process.argv.slice(2);
const imgs = [];
for (const s of specs) {
  const spec = JSON.parse(s);
  const r = await generate(spec);
  // clip honestly: every instance is baked and trimmed like a solid (a part kept by its origin would float)
  let parts = [];
  for (const p of r.parts) {
    const n = p.transforms ? p.transforms.length / 16 : 1;
    for (let i = 0; i < n; i++) {
      let m = p.transforms ? p.manifold.transform(p.transforms.subarray(16 * i, 16 * i + 16)) : p.manifold;
      if (spec._x || spec._z) {
        const bb = m.boundingBox();
        if (spec._x && (bb.max[0] < spec._x[0] || bb.min[0] > spec._x[1])) continue;
        if (spec._z && (bb.max[2] < spec._z[0] || bb.min[2] > spec._z[1])) continue;
        if (spec._x) m = m.trimByPlane([1, 0, 0], spec._x[0]).trimByPlane([-1, 0, 0], -spec._x[1]);
        if (spec._z) m = m.trimByPlane([0, 0, 1], spec._z[0]).trimByPlane([0, 0, -1], -spec._z[1]);
      }
      if (!m.isEmpty()) parts.push({ ...p, manifold: m, transforms: null });
    }
  }
  if (spec._tilt) parts = placeParts(parts, mat.Rx((-spec._tilt * Math.PI) / 180));
  const bad = r.parts.filter((p) => p.manifold.status() !== 'NoError').map((p) => p.name);
  const e = r.expected?.size || {};
  const dx = e.x ? (r.size[0] / e.x - 1) * 100 : 0, dz = e.z ? (r.size[2] / e.z - 1) * 100 : 0;
  console.log(JSON.stringify(Object.fromEntries(Object.entries(spec).filter(([k]) => !k.startsWith('_')))).padEnd(70), `${Math.round(r.ms)}ms`.padStart(7),
    `${(r.tris / 1000).toFixed(0)}k`.padStart(6), 'x', r.size[0].toFixed(3), `${dx.toFixed(2)}%`, 'z', r.size[2].toFixed(3), `${dz.toFixed(2)}%`, bad.length ? 'BAD ' + bad : '');
  imgs.push(renderPNG(parts, { size: +size, view }));
}
fs.writeFileSync(out, sheet(imgs, +cols));
console.log('wrote', out);
