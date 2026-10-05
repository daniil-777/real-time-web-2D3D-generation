// node arch/test/readback.test.mjs — the read-back tells the model as built. For every element's default, the portico
// and the pediment element with every pediment, and the window / door matrix (style x archType x pediment stated or not):
// the describe() line of generate(spec).spec names a pediment iff the build has one (a raking cornice), and the right
// kind (broken: the urn on its pedestal; triangular / segmental: the tympanum's outline); a window / door names an arched
// head iff the build has an arched band, and a keystone iff it has one. The effective fields are SCHEMA values (the spec
// card can show them), spec.given stays exactly as normalize() made it, and the line of the normalised request (the
// parser's, before anything is built) is the same as the built model's.
import assert from 'node:assert/strict';
import { initKernel } from './node-kernel.mjs';
import { generate } from '../js/generate.js';
import { normalize, ELEMENTS, SCHEMA } from '../js/spec.js';
import { describe } from '../js/describe.js';

await initKernel();

const KIND = /\b(triangular|segmental|broken) pediment\b/i;
const HEAD = /\b(semicircular|segmental|pointed|horseshoe|basket-handle|Tudor) head\b/;
const free = (parts) => { const seen = new Set(); for (const p of parts) if (!seen.has(p.manifold)) { seen.add(p.manifold); p.manifold.delete(); } };

/** The pediment the build has: null, 'broken' (urn on a pedestal in the gap), else 'triangular' / 'segmental' by the
 *  tympanum's outline (a triangle extruded: 6 vertices; an arc: dozens). */
function builtPediment(parts) {
  if (!parts.some((p) => p.name === 'raking-cornice')) return null;
  if (parts.some((p) => p.name.startsWith('urn-'))) return 'broken';
  const ty = parts.find((p) => p.name === 'tympanum');
  return ty && ty.manifold.numVert() > 12 ? 'segmental' : 'triangular';
}

const cases = [];
for (const element of ELEMENTS) cases.push({ element });
for (const pediment of SCHEMA.pediment.values) cases.push({ element: 'portico', pediment }, { element: 'pediment', pediment });
for (const element of ['window', 'door']) for (const style of [undefined, ...SCHEMA.style.values])
  for (const archType of [undefined, ...SCHEMA.archType.values]) for (const pediment of [undefined, ...SCHEMA.pediment.values])
    cases.push({ element, style, archType, pediment, detail: 'low' });
for (const style of ['gothic', 'baroque', 'art-nouveau', 'renaissance', 'modern']) for (const element of ['window', 'door']) cases.push({ element, style, detail: 'high' });

let pass = 0;
const fails = [], tally = {};
const t0 = performance.now();
for (const input of cases) {
  const spec = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  let r;
  try { r = await generate(spec); } catch (e) { fails.push(`${JSON.stringify(spec)}: threw ${e.message}`); continue; }
  const line = describe(r.spec), errs = [];
  // the parser's line, before anything is built (describe of the normalised request), is the built model's line too
  const before = describe(normalize(spec).spec);
  if (before !== line) errs.push(`before the build "${before}"`);
  const built = builtPediment(r.parts), said = (line.match(KIND) || [])[1];
  if (built !== (said ? said.toLowerCase() : null)) errs.push(`pediment: built ${built}, read "${said || 'none'}"`);
  assert.deepEqual(r.spec.given, normalize(spec).spec.given, `${JSON.stringify(spec)}: spec.given changed`);
  if (r.spec.element === 'window' || r.spec.element === 'door') {
    const arched = r.parts.some((p) => p.name === 'archivolt' || p.name === 'frame'), head = HEAD.test(line);
    if (arched !== head) errs.push(`head: built ${arched ? 'arched' : 'flat'}, read "${line}"`);
    const key = r.parts.some((p) => p.name === 'keystone'), saysKey = /· keystone( ·|$)/.test(line);
    if (key !== saysKey) errs.push(`keystone: built ${key}, read ${saysKey}`);
    for (const k of ['pediment', 'archType']) if (r.spec[k] !== undefined && !SCHEMA[k].values.includes(r.spec[k])) errs.push(`${k} "${r.spec[k]}" is not a SCHEMA value`);
    if (typeof r.spec.keystone !== 'boolean') errs.push('keystone is not a boolean');
    if (/\bno pediment\b/.test(line) && !r.spec.given.includes('pediment')) errs.push('"no pediment" read for a pediment nobody asked for');
  }
  const k = `${r.spec.element} ${built || 'none'}`;
  tally[k] = (tally[k] || 0) + 1;
  free(r.parts);
  if (errs.length) fails.push(`${JSON.stringify(spec)} → ${line}: ${errs.join('; ')}`);
  else pass++;
}
const ms = performance.now() - t0;
console.log('built pediments:', Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(' · '));
for (const f of fails.slice(0, 40)) console.log('FAIL', f);
console.log(`readback: ${pass}/${cases.length} pass (${(ms / 1000).toFixed(1)} s)`);
assert.equal(fails.length, 0, `${fails.length} read-backs disagree with the build`);
