// node arch/test/preview.mjs '<spec json>' out.png [views=three-quarter,front,close] [size=520]
// Builds a spec with generate() and writes a sheet of views; prints build stats and expected-vs-actual size.
import fs from 'node:fs';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { renderPNG, sheet } from './raster.mjs';

await initKernel();
const spec = JSON.parse(process.argv[2]);
const out = process.argv[3] || '/Volumes/LaCie/morph3d/archkit/preview.png';
const views = (process.argv[4] || 'three-quarter,front,close').split(',');
const size = +(process.argv[5] || 520);
const r = await generate(spec);
console.log(JSON.stringify({ element: r.spec.element, ms: Math.round(r.ms), tris: r.tris, parts: r.parts.map((p) => `${p.name}x${p.transforms ? p.transforms.length / 16 : 1}`),
  size: r.size.map((x) => +x.toFixed(4)), expected: r.expected, warnings: r.warnings }));
const bad = r.parts.filter((p) => p.manifold.status() !== 'NoError');
if (bad.length) console.log('NOT MANIFOLD:', bad.map((p) => p.name));
fs.writeFileSync(out, sheet(views.map((v) => renderPNG(r.parts, { size, view: v })), views.length));
console.log('wrote', out);
