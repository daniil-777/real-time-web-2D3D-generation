// node arch/test/orders-sheet.mjs [element] [view] — every order side by side (front + close-ups) into one PNG
import fs from 'node:fs';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { ORDER_KEYS } from '../js/orders.js';
import { renderPNG, sheet } from './raster.mjs';
await initKernel();
const element = process.argv[2] || 'column', view = process.argv[3] || 'close';
const imgs = [];
for (const order of ORDER_KEYS) {
  try {
    const r = await generate({ element, order, height: element === 'column' ? 3.6 : undefined });
    const bad = r.parts.filter((p) => p.manifold.status() !== 'NoError').map((p) => p.name);
    console.log(order.padEnd(12), `${Math.round(r.ms)}ms`.padStart(7), `${r.tris} tris`.padStart(12), 'h', r.size[2].toFixed(3), 'exp', r.expected?.size?.z?.toFixed(3) ?? '-', bad.length ? 'BAD ' + bad : '');
    imgs.push(renderPNG(r.parts, { size: 300, view }));
  } catch (e) { console.log(order, 'ERROR', e.message); }
}
const out = `/Volumes/LaCie/morph3d/archkit/previews/${element}-${view}.png`;
fs.writeFileSync(out, sheet(imgs, 6));
console.log('wrote', out);
