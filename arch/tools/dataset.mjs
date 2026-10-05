// Dataset factory: exactly-labelled architectural elements for the neural stages (element-scale triplane model, text
// prior, text→spec). Every sample is procedurally generated from a random spec, so labels are exact and the data is
// ours (no third-party licence). Output on the LaCie drive (the user's request):
//   /Volumes/LaCie/morph3d/archkit/dataset/<name>/<element>/<id>/{spec.json, captions.json, mesh.glb, thumb.png}
//   + index.jsonl (one row per sample) + README.md
// node arch/tools/dataset.mjs [--name arch-v1] [--per 40] [--elements column,capital,...] [--seed 1] [--thumbs]
import fs from 'node:fs';
import path from 'node:path';
import { initKernel, ARCHKIT } from '../test/node-kernel.mjs';
import { generate, FAMILY } from '../js/generate.js';
import { SCHEMA, ELEMENTS, normalize } from '../js/spec.js';
import { ORDER_KEYS } from '../js/orders.js';

const args = process.argv.slice(2), opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const name = opt('--name', 'arch-v1'), per = +opt('--per', 40), seed0 = +opt('--seed', 1);
const only = opt('--elements', '') ? opt('--elements', '').split(',') : ELEMENTS;
const thumbs = args.includes('--thumbs');
const root = path.join(ARCHKIT, 'dataset', name);

await initKernel();
const { toGLB, materialFor } = await import('../js/export.js');
const { captions, describe } = await import('../js/describe.js').catch(() => ({}));
const raster = thumbs ? await import('../test/raster.mjs') : null;

// small deterministic RNG (mulberry32)
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const uni = (r, a, b) => +(a + (b - a) * r()).toFixed(3);
const chance = (r, p) => r() < p;
const ev = (f) => SCHEMA[f].values;

/** A random but plausible spec for an element (only fields that element uses). */
function randomSpec(element, r) {
  const s = { element, seed: Math.floor(r() * 1e6) };
  const stone = ['marble', 'limestone', 'sandstone', 'granite', 'travertine', 'plaster', 'concrete'];
  switch (element) {
    case 'column': case 'pilaster':
      s.order = pick(r, ORDER_KEYS); s.height = uni(r, 2.2, 9); s.pedestal = chance(r, 0.3);
      if (chance(r, 0.25)) s.flutes = pick(r, [0, 16, 20, 24, 28]);
      if (chance(r, 0.15)) s.base = pick(r, ev('base'));
      s.material = pick(r, stone); break;
    case 'capital': case 'base': case 'pedestal': s.order = pick(r, ORDER_KEYS); s.diameter = uni(r, 0.3, 1.0); s.material = pick(r, stone); break;
    case 'entablature': case 'cornice':
      s.order = pick(r, ORDER_KEYS.slice(0, 6)); s.length = uni(r, 1.5, 6); s.returns = chance(r, 0.6);
      if (chance(r, 0.3)) s.cornice = pick(r, ev('cornice')); if (chance(r, 0.2)) s.frieze = pick(r, ev('frieze'));
      s.material = pick(r, stone); break;
    case 'moulding': s.profile = pick(r, ev('profile')); s.enrichment = pick(r, ev('enrichment')); s.length = uni(r, 0.6, 2.5); s.height = uni(r, 0.06, 0.3); s.material = pick(r, stone); break;
    case 'pediment': s.pediment = pick(r, ['triangular', 'segmental', 'broken']); s.width = uni(r, 2, 10); s.order = pick(r, ORDER_KEYS.slice(0, 6)); break;
    case 'portico': s.order = pick(r, ORDER_KEYS.slice(0, 6)); s.columns = pick(r, [2, 4, 6, 8]); s.pediment = pick(r, ev('pediment')); s.steps = Math.floor(uni(r, 0, 5)); s.height = uni(r, 3, 10); s.material = pick(r, stone); break;
    case 'balustrade': s.baluster = pick(r, ev('baluster')); s.length = uni(r, 1.5, 8); s.height = uni(r, 0.8, 1.1); s.urns = chance(r, 0.3); s.material = pick(r, stone); break;
    case 'baluster': s.baluster = pick(r, ev('baluster')); s.height = uni(r, 0.5, 1.0); break;
    case 'arch': case 'arcade':
      s.archType = pick(r, ev('archType')); s.span = uni(r, 1, 5); s.keystone = chance(r, 0.6); s.supports = pick(r, ev('supports'));
      s.order = pick(r, ORDER_KEYS.slice(0, 6)); if (element === 'arcade') s.bays = Math.floor(uni(r, 2, 8)); s.material = pick(r, [...stone, 'brick']); break;
    case 'window': case 'door':
      s.width = element === 'door' ? uni(r, 1, 2.4) : uni(r, 0.7, 1.8); s.height = element === 'door' ? uni(r, 2.2, 4) : uni(r, 1.2, 2.8);
      s.pediment = pick(r, ev('pediment')); s.keystone = chance(r, 0.4); s.material = pick(r, stone); break;
    case 'roof': s.roofType = pick(r, ev('roofType')); s.width = uni(r, 5, 14); s.length = uni(r, 6, 20); s.pitch = uni(r, 20, 55); s.covering = pick(r, ev('covering')); break;
    case 'dome': case 'cupola':
      s.domeType = pick(r, ev('domeType')); s.diameter = element === 'dome' ? uni(r, 4, 20) : uni(r, 1.5, 4); s.drum = chance(r, 0.7);
      s.lantern = chance(r, 0.6); s.oculus = !s.lantern && chance(r, 0.3); s.material = pick(r, ['copper', 'lead', 'slate', 'gold', 'terracotta']); break;
    case 'spire': s.spireType = pick(r, ev('spireType')); s.height = uni(r, 6, 30); s.width = uni(r, 2, 5); s.finial = pick(r, ['cross', 'ball', 'spike']); s.material = pick(r, ['slate', 'copper', 'lead']); break;
    case 'finial': s.finial = pick(r, ev('finial').filter((x) => x !== 'none')); s.height = uni(r, 0.4, 1.5); break;
    case 'urn': s.height = uni(r, 0.5, 1.4); break;
    case 'obelisk': s.height = uni(r, 2, 15); break;
    case 'console': s.height = uni(r, 0.3, 0.9); s.depth = uni(r, 0.2, 0.6); s.width = uni(r, 0.15, 0.4); break;
  }
  return s;
}

function meshesOf(parts, spec) {
  return parts.map((p) => {
    const g = p.manifold.calculateNormals(0, 30).getMesh();
    const nv = g.vertProperties.length / g.numProp, pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) for (let c = 0; c < 3; c++) { pos[i * 3 + c] = g.vertProperties[i * g.numProp + c]; nrm[i * 3 + c] = g.vertProperties[i * g.numProp + 3 + c]; }
    // the viewer's and exporter's own material rule (part meta first, then role/spec)
    return { name: p.name, role: p.role, material: materialFor(p.role, spec, p.meta), positions: pos, normals: nrm, indices: Uint32Array.from(g.triVerts), transforms: p.transforms };
  });
}

fs.mkdirSync(root, { recursive: true });
const index = fs.createWriteStream(path.join(root, 'index.jsonl'), { flags: 'a' });
let ok = 0, fail = 0;
for (const element of only) {
  if (!FAMILY[element]) continue;
  const r = rng(seed0 * 1000003 + ELEMENTS.indexOf(element) * 7919);
  for (let i = 0; i < per; i++) {
    const raw = randomSpec(element, r), id = `${element}-${String(i).padStart(5, '0')}`, dir = path.join(root, element, id);
    try {
      const g = await generate(raw);
      if (g.parts.some((p) => p.manifold.status() !== 'NoError')) throw new Error('not manifold');
      fs.mkdirSync(dir, { recursive: true });
      const spec = normalize(raw).spec;
      fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec, null, 1));
      const caps = captions ? captions(spec, i) : [describe ? describe(spec) : element];
      fs.writeFileSync(path.join(dir, 'captions.json'), JSON.stringify(caps, null, 1));
      fs.writeFileSync(path.join(dir, 'mesh.glb'), Buffer.from(toGLB(meshesOf(g.parts, spec), { name: id })));
      if (raster) fs.writeFileSync(path.join(dir, 'thumb.png'), raster.renderPNG(g.parts, { size: 256 }));
      index.write(JSON.stringify({ id, element, path: path.relative(root, dir), size: g.size.map((x) => +x.toFixed(4)), tris: g.tris, ms: Math.round(g.ms), caption: caps[0] }) + '\n');
      ok++;
      // the caller owns returned manifolds: free them, and start a fresh kernel now and then (Manifold's heap limit)
      for (const p of g.parts) { try { p.manifold.delete(); } catch (e) { /* already freed */ } }
      if (ok % 40 === 0) await initKernel();
    } catch (e) { fail++; console.log(id, 'FAILED', e.message.split('\n')[0]); await initKernel(); }
  }
  console.log(element.padEnd(12), 'done', `(${ok} ok, ${fail} failed so far)`);
}
index.end();
fs.writeFileSync(path.join(root, 'README.md'), `# ${name}\n\nProcedurally generated architectural elements from Arch Studio (exact labels; generated data, no third-party assets).\nOne folder per sample: spec.json (normalized spec, metres), captions.json (EN + DE/FR/IT), mesh.glb (Y-up, metres, watertight parts), thumb.png.\nindex.jsonl lists every sample. Generator: arch/tools/dataset.mjs (seed ${seed0}, ${per} per element).\n`);
console.log(`dataset ${root}: ${ok} samples, ${fail} failed`);
