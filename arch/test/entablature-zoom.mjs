// Close-up previews for the entablature family: node arch/test/entablature-zoom.mjs '<spec>' out.png [x0,x1|all] [z0,z1|all]
//   [tiltDeg] [views] [size] — clips the geometry to the x / z window (instances by their origin, solids by planes),
//   optionally tilts it about X (positive = seen from below, as an entablature is seen) and renders a sheet.
import fs from 'node:fs';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { mat, instances, placeParts } from '../js/kernel.js';
import { renderPNG, sheet } from './raster.mjs';

await initKernel();
const spec = JSON.parse(process.argv[2]);
const out = process.argv[3];
const xr = process.argv[4] && process.argv[4] !== 'all' ? process.argv[4].split(',').map(Number) : null;
const zr = process.argv[5] && process.argv[5] !== 'all' ? process.argv[5].split(',').map(Number) : null;
const tilt = +(process.argv[6] || 0);
const views = (process.argv[7] || 'three-quarter,front').split(',');
const size = +(process.argv[8] || 600);
const r = await generate(spec);
let parts = [];
for (const p of r.parts) {
  if (p.transforms && p.transforms.length > 16) {
    const keep = [];
    for (let i = 0; i < p.transforms.length / 16; i++) {
      const m = p.transforms.subarray(16 * i, 16 * i + 16);
      if (xr && (m[12] < xr[0] || m[12] > xr[1])) continue;
      if (zr && (m[14] < zr[0] || m[14] > zr[1])) continue;
      keep.push(m);
    }
    if (keep.length) parts.push({ ...p, transforms: instances(keep) });
  } else {
    let m = p.transforms ? p.manifold.transform(p.transforms) : p.manifold;
    if (xr) m = m.trimByPlane([1, 0, 0], xr[0]).trimByPlane([-1, 0, 0], -xr[1]);
    if (zr) m = m.trimByPlane([0, 0, 1], zr[0]).trimByPlane([0, 0, -1], -zr[1]);
    if (!m.isEmpty()) parts.push({ ...p, manifold: m, transforms: null });
  }
}
if (tilt) parts = placeParts(parts, mat.Rx((-tilt * Math.PI) / 180));
fs.writeFileSync(out, sheet(views.map((v) => renderPNG(parts, { size, view: v })), views.length));
console.log('wrote', out, Math.round(r.ms), 'ms', r.tris, 'tris');
