// generate(spec): normalise, build with the element's family generator, measure. Families load lazily so the page
// fetches only what it uses and a family can land without touching this file.

import { normalize } from './spec.js';
import { partsBBox, partTris } from './kernel.js';

export const FAMILY = {
  column: 'column', pilaster: 'column', capital: 'column', base: 'column', pedestal: 'column',
  entablature: 'entablature', cornice: 'entablature', moulding: 'entablature', pediment: 'entablature',
  portico: 'portico',
  balustrade: 'balustrade', baluster: 'balustrade',
  arch: 'arch', arcade: 'arch', window: 'entablature', door: 'entablature',
  roof: 'roof',
  dome: 'dome', cupola: 'dome', spire: 'dome',
  finial: 'finial', urn: 'finial', obelisk: 'finial',
  console: 'console',
};

const cache = {};
export function family(element) {
  const f = FAMILY[element];
  if (!f) return Promise.reject(new Error(`no generator for "${element}"`));
  return (cache[f] ||= import(`./gen/${f}.js`));
}

const now = () => (globalThis.performance ? performance.now() : Date.now());

/** → { parts, bbox, size, tris, ms, spec, warnings, expected } */
export async function generate(input) {
  const { spec, warnings } = normalize(input);
  const mod = await family(spec.element);
  const t0 = now();
  const parts = mod.build(spec);
  const ms = now() - t0;
  const bbox = partsBBox(parts);
  const size = [0, 1, 2].map((a) => bbox.max[a] - bbox.min[a]);
  const tris = parts.reduce((s, p) => s + partTris(p), 0);
  return { parts, bbox, size, tris, ms, spec, warnings, expected: mod.expected ? mod.expected(spec) : null };
}
