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

// balustrades and balusters: a named period decides the baluster and urns (balustrade-style.js) unless stated. The line
// before the build equals the built one, names the baluster the build has (its volume equals the stated kind's) and
// "urns" iff the build has urns; spec.given stays as stated.
const vol = (r) => r.parts.find((p) => p.name === 'baluster').manifold.volume();
const ref = {};
for (const baluster of SCHEMA.baluster.values) {
  const r = await generate({ element: 'balustrade', length: 4, baluster });
  ref[baluster] = vol(r); free(r.parts);
}
let bpass = 0, bn = 0;
const bfails = [];
for (const style of [undefined, ...SCHEMA.style.values]) for (const stated of [{}, { baluster: 'vase' }, { urns: false }, { urns: true }]) {
  for (const element of ['balustrade', 'baluster']) {
    if (element === 'baluster' && 'urns' in stated) continue;
    const spec = { element, ...(style ? { style } : {}), ...(element === 'balustrade' ? { length: 4 } : {}), ...stated };
    const r = await generate(spec), line = describe(r.spec), pre = describe(normalize(spec).spec), errs = [];
    bn++;
    if (pre !== line) errs.push(`before the build: ${pre}`);
    if (JSON.stringify(r.spec.given) !== JSON.stringify(normalize(spec).spec.given)) errs.push('spec.given changed');
    const kind = (line.match(/\b(double-vase|vase|bottle|square|bar) balusters?\b/i) || [])[1]?.toLowerCase();
    if (element === 'balustrade') {
      if (!kind || Math.abs(vol(r) - ref[kind]) > 1e-9 * ref[kind]) errs.push(`built baluster is not "${kind}"`);
      if (/\burns\b/.test(line) !== r.parts.some((p) => p.name.startsWith('urn-'))) errs.push('urns read ≠ urns built');
    }
    if (stated.baluster && kind !== stated.baluster) errs.push('a stated baluster lost to the style');
    free(r.parts);
    if (errs.length) bfails.push(`${JSON.stringify(spec)} → ${line}: ${errs.join('; ')}`); else bpass++;
  }
}
// runs too short for pedestals carry no urns, stated or a period's: the built line says none, and a warning says why
for (const spec of [{ element: 'balustrade', style: 'baroque', length: 0.8 }, { element: 'balustrade', urns: true, length: 0.8 }]) {
  const r = await generate(spec), line = describe(r.spec);
  bn++;
  const urns = r.parts.some((p) => p.name.startsWith('urn-'));
  if (urns || /\burns\b/.test(line) || !r.warnings.some((w) => /no urns/.test(w))) bfails.push(`${JSON.stringify(spec)} → ${line}: urns read/built/warned wrong`);
  else bpass++;
  free(r.parts);
}
// an exported spec rebuilds the same element: the built spec (effective fields included) fed back as a request gives
// the same parts and volumes and the same line — a Baroque door's broken segmental pediment included (controller ruling 28)
for (const spec of [{ element: 'door', style: 'baroque' }, { element: 'window', style: 'baroque' }, { element: 'window', style: 'gothic' },
  { element: 'door', style: 'moorish' }, { element: 'balustrade', style: 'baroque', length: 4 }, { element: 'window', archType: 'basket' }]) {
  const a = await generate(spec), b = await generate(Object.fromEntries(Object.entries(a.spec).filter(([k]) => k !== 'given')));
  bn++;
  const sig = (r) => r.parts.map((p) => `${p.name}:${p.manifold.volume().toFixed(9)}`).join(',');
  // (the re-imported spec states pediment 'none', so its line may add "no pediment"; nothing else may differ)
  if (sig(a) !== sig(b) || describe(a.spec) !== describe(b.spec).replace(' · no pediment', '')) bfails.push(`${JSON.stringify(spec)}: the exported spec rebuilds differently`);
  else bpass++;
  free(a.parts); free(b.parts);
}
// the German / French / Italian captions say "no pediment" only when the request did (as the English line)
const { captions } = await import('../js/describe.js');
for (const [spec, want] of [[{ element: 'window', style: 'gothic' }, false], [{ element: 'window', pediment: 'none' }, true]]) {
  const r = await generate(spec), caps = captions(r.spec, 0).join(' | ');
  bn++;
  if (/ohne Giebel|sans fronton|senza frontone/.test(caps) !== want) bfails.push(`${JSON.stringify(spec)}: foreign captions ${caps}`); else bpass++;
  free(r.parts);
}
for (const f of bfails.slice(0, 20)) console.log('FAIL', f);
console.log(`readback balustrades: ${bpass}/${bn} pass`);
assert.equal(bfails.length, 0, `${bfails.length} balustrade read-backs disagree with the build`);
