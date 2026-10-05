// Parser tests: the dev library (arch/test/prompts.json) with gates, the five Review Focus cases, schema validity of every
// output, robustness on garbage, timing, and the parser author's own paraphrase checks.
//   node arch/test/parse.test.mjs [promptsFile] [--quiet]
// Exits 1 when a gate fails: field accuracy < 95 %, out-of-scope recall < 100 %, any false out-of-scope, any unit case.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, LEXICON_COLLISIONS } from '../js/parse.js';
import { describe, captions } from '../js/describe.js';
import { normalize, SCHEMA, ELEMENTS } from '../js/spec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) || path.join(here, 'prompts.json');
const quiet = args.includes('--quiet');
const near = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 0.01 * Math.max(1e-9, Math.abs(b)) : a === b);
const pct = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1) + ' %' : '–');
let failures = 0;

// ================================================================================================= 1. dev library
const { prompts } = JSON.parse(fs.readFileSync(file, 'utf8'));
const rows = [];
const times = [], cold = [];
parse('warm-up: Ionic column 3 m');   // first call compiles the code paths; not a prompt time
for (const p of prompts) {
  const t0 = performance.now();
  let r;
  try { r = parse(p.text); } catch (e) { r = { error: e.message, spec: null, unknown: [] }; }
  cold.push(performance.now() - t0);
  // the cost of a prompt: median of 5 runs (single calls include GC pauses of the whole process)
  const runs = [];
  for (let k = 0; k < 5; k++) { const a = performance.now(); try { parse(p.text); } catch (e) { /* reported above */ } runs.push(performance.now() - a); }
  times.push(runs.sort((x, y) => x - y)[2]);
  const fields = [];
  for (const [k, v] of Object.entries(p.expect || {})) {
    if (k === 'why') continue;
    let got, ok;
    if (k === 'outOfScope') { got = !!r.outOfScope; ok = got === v; }
    else if (k === 'unknownIncludes') { got = r.unknown || []; ok = v.every((w) => got.some((g) => g.toLowerCase().includes(w.toLowerCase()))); }
    else { got = r.spec ? r.spec[k] : undefined; ok = near(got, v); }
    fields.push({ k, want: v, got, ok });
  }
  rows.push({ p, r, fields });
}
const inScope = rows.filter((x) => !x.p.expect.outOfScope);
const oos = rows.filter((x) => x.p.expect.outOfScope === true);
const fieldRows = inScope.flatMap((x) => x.fields.filter((f) => f.k !== 'outOfScope').map((f) => ({ ...f, cat: x.p.cat })));
const acc = (xs) => (xs.length ? xs.filter((x) => x.ok).length / xs.length : NaN);
const fieldAcc = acc(fieldRows);
const oosRecall = acc(oos.map((x) => ({ ok: !!x.r.outOfScope })));
const falseOos = inScope.filter((x) => x.r.outOfScope).length;
const exact = acc(inScope.map((x) => ({ ok: x.fields.every((f) => f.ok) })));
times.sort((a, b) => a - b);
const mean = times.reduce((a, b) => a + b, 0) / times.length;

console.log(`dev library ${path.basename(file)}: ${prompts.length} prompts`);
console.log(`  field accuracy ${pct(fieldAcc)} (${fieldRows.filter((f) => f.ok).length}/${fieldRows.length}) · prompts fully right ${pct(exact)} · out-of-scope recall ${pct(oosRecall)} (${oos.length}) · false out-of-scope ${falseOos}`);
cold.sort((a, b) => a - b);
console.log(`  time per prompt (median of 5): mean ${mean.toFixed(2)} ms · p95 ${times[Math.floor(0.95 * times.length)].toFixed(2)} ms · max ${times[times.length - 1].toFixed(2)} ms · first call: mean ${(cold.reduce((a, b) => a + b, 0) / cold.length).toFixed(2)} ms, max ${cold[cold.length - 1].toFixed(2)} ms`);
const byCat = {};
for (const x of rows) (byCat[x.p.cat] ||= []).push(x);
console.log('  per category: ' + Object.entries(byCat).map(([c, xs]) => `${c} ${pct(acc(xs.flatMap((x) => x.fields)))}`).join(' · '));
const byField = {};
for (const f of fieldRows) (byField[f.k] ||= []).push(f);
console.log('  per field: ' + Object.entries(byField).sort((a, b) => acc(a[1]) - acc(b[1])).map(([k, xs]) => `${k} ${pct(acc(xs))}`).join(' · '));
const bad = rows.filter((x) => x.r.error || x.fields.some((f) => !f.ok));
if (bad.length) {
  console.log(`  failures (${bad.length}):`);
  for (const x of bad) console.log(`    ${x.p.id} "${x.p.text}" → ${x.r.error ? 'THREW ' + x.r.error : x.r.outOfScope ? 'out of scope' : x.r.interpretation}${x.fields.filter((f) => !f.ok).map((f) => ` · ${f.k}: want ${JSON.stringify(f.want)} got ${JSON.stringify(f.got)}`).join('')}`);
}
const gates = { fieldAccuracy: fieldAcc >= 0.95, oosRecall: !oos.length || oosRecall >= 1, falseOos: falseOos === 0, speed: times[times.length - 1] < 5 };
console.log('  gates: ' + Object.entries(gates).map(([k, v]) => `${k} ${v ? 'PASS' : 'FAIL'}`).join(' · '));
if (!Object.values(gates).every(Boolean)) failures++;

// ================================================================================================= 2. unit cases
const cases = [];
function check(name, fn) {
  try { const msg = fn(); if (msg) throw new Error(msg); cases.push({ name, ok: true }); }
  catch (e) { cases.push({ name, ok: false, err: e.message }); }
}
const has = (text, want) => () => {
  const r = parse(text);
  if (want.outOfScope !== undefined && !!r.outOfScope !== want.outOfScope) return `outOfScope ${r.outOfScope}`;
  for (const [k, v] of Object.entries(want)) {
    if (k === 'outOfScope') continue;
    if (k === 'unknown') { for (const w of v) if (!r.unknown.some((g) => g.includes(w))) return `unknown ${JSON.stringify(r.unknown)} lacks ${w}`; continue; }
    if (k === 'warns') { if (!r.warnings.some((w) => w.includes(v))) return `warnings ${JSON.stringify(r.warnings)} lack “${v}”`; continue; }
    const got = r.spec && r.spec[k];
    if (v === undefined ? got !== undefined : !near(got, v)) return `${k}: want ${JSON.stringify(v)} got ${JSON.stringify(got)} (${JSON.stringify(r.spec)})`;
  }
  return '';
};

// Review Focus 1: a partial request keeps the element and reports what it could not use
check('RF1 Ionic column with gargoyles', has('Ionic column with gargoyles', { element: 'column', order: 'ionic', unknown: ['gargoyles'] }));
check('RF1 arch with a dragon on the keystone stays in scope', has('arch with a dragon carved on the keystone', { outOfScope: false, element: 'arch', keystone: true, unknown: ['dragon'] }));
// Review Focus 2: extreme numbers parse exactly; absurd ones pass through and normalize() clamps them with a warning
check('RF2 a 30 m Corinthian column', has('a 30 m Corinthian column', { element: 'column', order: 'corinthian', height: 30 }));
check('RF2 200 balusters', has('balustrade with 200 balusters', { element: 'balustrade', balusters: 200 }));
check('RF2 a 20 cm baluster', has('a 20 cm baluster', { element: 'baluster', height: 0.2 }));
for (const [t, k, v] of [['a column 0 m', 'height', 0], ['a column -3 m', 'height', -3], ['a column 1 km tall', 'height', 1000], ['dome Ø 500 m', 'diameter', 500], ['portico with 40 columns', 'columns', 40]]) {
  check(`RF2 absurd “${t}” passes through and clamps`, () => {
    const r = parse(t);
    if (!r.spec || !near(r.spec[k], v)) return `${k}: want ${v} got ${r.spec && r.spec[k]}`;
    const n = normalize(r.spec);
    if (!n.warnings.some((w) => w.startsWith(k))) return `normalize() did not warn: ${JSON.stringify(n.warnings)}`;
    if (!r.warnings.some((w) => w.startsWith(k))) return `parse() warnings lack the clamp: ${JSON.stringify(r.warnings)}`;
    return '';
  });
}
// Review Focus 3: units in other languages and formats parse to metres
for (const [t, v] of [['Ionic column 3,6 m', 3.6], ['Ionic column 360 cm', 3.6], ['Ionic column 12 ft', 3.6576], ["Ionic column 12'", 3.6576], ['Ionic column 3.6 Meter', 3.6],
  ['Ionic column 3600 mm', 3.6], ['ionische Säule 3,60 Meter hoch', 3.6], ['colonne ionique de 3,6 mètres', 3.6], ['colonna ionica alta 3,6 metri', 3.6], ['Ionic column 11\' 9.7"', 3.5992]]) {
  check(`RF3 ${t}`, has(t, { element: 'column', height: v }));
}
check('RF3 Swiss thousands 4\'500 mm', has("Kranzgesims 4'500 mm", { element: 'cornice', length: 4.5 }));
check('RF3 pair 1,25 × 2,45 m', has('door 1,25 × 2,45 m', { element: 'door', width: 1.25, height: 2.45 }));
check('RF3 unitless size assumed metres with a warning', has('Doric column 6', { height: 6, warns: 'no unit' }));
// Review Focus 4: counts as words in four languages and Greek terms
for (const [t, k, v] of [['portico with four columns', 'columns', 4], ['Portikus mit vier Säulen', 'columns', 4], ['portique à quatre colonnes', 'columns', 4],
  ['portico con quattro colonne', 'columns', 4], ['hexastyle portico', 'columns', 6], ['tetrastyle temple front', 'columns', 4], ['decastyle portico', 'columns', 10],
  ['balustrade with a dozen balusters', 'balusters', 12], ['three-bay arcade', 'bays', 3], ['Balustrade mit zwölf Docken', 'balusters', 12],
  ['dôme à douze nervures', 'ribs', 12], ['arcata a cinque campate', 'bays', 5], ['colonna con ventiquattro scanalature', 'flutes', 24], ['vierundzwanzig Kanneluren', 'flutes', 24]]) {
  check(`RF4 ${t}`, has(t, { [k]: v }));
}
// Review Focus 5: non-architectural prompts are out of scope, with a helpful message; never a column
for (const t of ['a red sports car', 'cat', 'an Ionic sofa', 'a house', 'une voiture rouge', 'un gatto nero', 'ein Einfamilienhaus mit Garten', 'asdf qwerty', 'what time is it?', '', '   ', 'a spiral staircase', 'the Parthenon']) {
  check(`RF5 out of scope: “${t}”`, () => {
    const r = parse(t);
    if (!r.outOfScope) return `in scope: ${JSON.stringify(r.spec)}`;
    if (!r.message || !r.suggestions || r.suggestions.length < 2) return 'no message with examples';
    if (r.spec) return 'spec should be null';
    return '';
  });
}
for (const t of ['church spire', 'the dome of St Peter\'s', 'a cathedral arch', 'the roof of a house, gable', 'column for a car park, concrete']) check(`RF5 near miss stays in scope: “${t}”`, has(t, { outOfScope: false }));

// the parser author's paraphrase checks (written independently of the gold library; wording differs from it)
const PARA = [
  ['a column in the Ionic order', { element: 'column', order: 'ionic' }],
  ['show me a tuscan pillar', { element: 'column', order: 'tuscan' }],
  ['the cornice of an Ionic entablature', { element: 'cornice', order: 'ionic' }],
  ['swan-neck pediment over a doorway', { element: 'door', pediment: 'broken' }],
  ['colonnade of six Doric columns', { element: 'portico', columns: 6, order: 'doric' }],
  ['three-centred arch', { element: 'arch', archType: 'basket' }],
  ['four-centred arch, 3 m span', { element: 'arch', archType: 'tudor', span: 3 }],
  ['a row of five arches', { element: 'arcade', bays: 5 }],
  ['saddle roof 35 degrees', { element: 'roof', roofType: 'gable', pitch: 35 }],
  ['hipped roof with slate', { element: 'roof', roofType: 'hip', covering: 'slate' }],
  ['steeple with a weathervane', { element: 'spire', unknown: ['weathervane'] }],
  ['a stone pineapple for the gatepost', { element: 'finial', finial: 'pineapple' }],
  ['window 4 ft by 7 ft', { element: 'window', width: 1.2192, height: 2.1336 }],
  ['door 900 x 2100 mm', { element: 'door', width: 0.9, height: 2.1 }],
  ['a dome 30 metres across', { element: 'dome', diameter: 30 }],
  ['dome radius 5 m', { element: 'dome', diameter: 10 }],
  ['urn, 1m20', { element: 'urn', height: 1.2 }],
  ['column 3 to 4 m', { element: 'column', height: 3, warns: 'range' }],
  ['Ionic column 360', { height: 3.6, warns: 'centimetres' }],
  ['baluster 70', { element: 'baluster', height: 0.7 }],
  ['half a dozen columns in a portico', { element: 'portico', columns: 6 }],
  ['two hundred balusters', { element: 'balustrade', balusters: 200 }],
  ['window without a pediment but with a keystone', { pediment: 'none', keystone: true }],
  ['cornice with no dentils', { element: 'cornice', cornice: 'plain' }],
  ['Ionic column, not fluted', { flutes: 0 }],
  ['Säule von drei Metern Höhe', { element: 'column', height: 3 }],
  ['colonna alta tre metri e mezzo', { element: 'column', height: 3.5 }],
  ['Fenster 1,2 auf 2,1 m', { element: 'window', width: 1.2, height: 2.1 }],
  ['Dach 10 auf 14 Meter, Neigung 35°', { element: 'roof', width: 10, length: 14, pitch: 35 }],
  ['Haustür mit Dreiecksgiebel 1,2 x 2,4 m', { element: 'door', pediment: 'triangular', width: 1.2, height: 2.4 }],
  ['Mansarddach mit Schiefer', { element: 'roof', roofType: 'mansard', covering: 'slate' }],
  ['Kupferkuppel mit Laterne', { element: 'dome', material: 'copper', lantern: true }],
  ['Zwiebelturm', { element: 'dome', domeType: 'onion' }],
  ['Turmhelm achteckig 20 m', { element: 'spire', spireType: 'octagonal', height: 20 }],
  ['une colonne dorique sans base', { element: 'column', order: 'doric', base: 'none' }],
  ['toit à quatre pans en tuiles', { element: 'roof', roofType: 'hip', covering: 'tiles' }],
  ['coupole hémisphérique', { element: 'dome', domeType: 'hemisphere' }],
  ['lesena dorica scanalata', { element: 'pilaster', order: 'doric', flutes: 20 }],
  ['arcata con sette archi su colonne', { element: 'arcade', bays: 7, supports: 'columns' }],
  ['tetto a capanna con coppi', { element: 'roof', roofType: 'gable', covering: 'pantiles' }],
  ['something stately for a town hall entrance', { element: 'portico', order: 'corinthian' }],
  ['a delicate column for a reading room', { element: 'column', order: 'ionic' }],
  ['a no-nonsense, robust pilaster', { element: 'pilaster', order: 'doric' }],
  ['the thing on top of a church tower', { element: 'spire' }],
  ['something for the top of a newel post', { element: 'finial' }],
  ['roof like an American barn', { element: 'roof', roofType: 'gambrel' }],
  ['the most elaborate column you can do', { element: 'column', order: 'composite' }],
  ['a column like in ancient Egypt', { element: 'column', order: 'egyptian' }],
  ['Alhambra style arcade', { element: 'arcade', archType: 'horseshoe' }],
  ['a dome with a hole in the top', { element: 'dome', oculus: true }],
  ['a Corinthian dining table', { outOfScope: true }],
  ['a car with Ionic columns', { outOfScope: true }],
  ['a statue on a pedestal', { element: 'pedestal', unknown: ['statue'] }],
  ['house with a hip roof', { element: 'roof', roofType: 'hip' }],
  ['Corinthian capital with gargoyles and owls', { element: 'capital', unknown: ['gargoyles', 'owls'] }],
  ['window with a small balcony', { element: 'window', unknown: ['balcony'] }],
  ['balustrade with a glass handrail and LED strips', { element: 'balustrade', unknown: ['glass', 'handrail'] }],
  ['column with a bench around it', { element: 'column', unknown: ['bench'] }],
  ['window with wooden shutters', { element: 'window', material: undefined, unknown: ['shutters'] }],
  ['spire 35 m, octagonal, slate, with a gilded ball', { material: 'slate', finial: 'ball' }],
  ['a column, sorry, a pilaster, Corinthian', { element: 'pilaster', order: 'corinthian' }],
  ['dome with lantern - no, without lantern', { lantern: false }],
  ['8 m tall column, or rather 9 m', { height: 9 }],
  ['ionik colum', { element: 'column', order: 'ionic' }],
  ['corinthean capitel', { element: 'capital', order: 'corinthian' }],
  ['balustrad with 8 ballusters', { element: 'balustrade', balusters: 8 }],
  ['copula with lantern', { element: 'cupola', lantern: true }],
  ['hiproof', { outOfScope: true }],   // English words are never split into compounds (review finding 3)
  ['a steep Alpine roof', { element: 'roof', pitch: undefined }],
  ['hip roof with a 1.2 m overhang', { element: 'roof', overhang: 1.2 }],
  ['Satteldach, Dachüberstand 60 cm, mit Gauben', { element: 'roof', roofType: 'gable', overhang: 0.6, dormers: true }],
  ['mansard roof without dormers', { roofType: 'mansard', dormers: false }],
  ['tetto con abbaini', { element: 'roof', dormers: true }],
  ['D=0.5 m Doric column', { element: 'column', diameter: 0.5 }],
  ['Grüezi, ich hätte gern eine korinthische Säule', { element: 'column', order: 'corinthian', detail: undefined }],
  ['Säule ohni Basis', { element: 'column', base: 'none' }],
];
for (const [t, want] of PARA) check(`para “${t}”`, has(t, want));

// review round 1: one block per finding (rules and vocabulary, checked on words the dev library does not contain)
const REVIEW = [
  // 1. inflection stems need 5+ letters: "turn" is not Tür
  ['F1', 'turn left', { outOfScope: true }],
  ['F1', 'Ionic column, turn it round', { element: 'column', order: 'ionic' }],
  // 2. everyday words are never corrected into architecture; swaps of 4-letter element words are
  ['F2', 'basil', { outOfScope: true }], ['F2', 'chapter 4', { outOfScope: true }], ['F2', 'tonic', { outOfScope: true }],
  ['F2', 'pilates class', { outOfScope: true }], ['F2', 'a basket', { outOfScope: true }], ['F2', 'Kapitel 3 lesen', { outOfScope: true }],
  ['F2', 'a true Corinthian column', { element: 'column', order: 'corinthian', unknown: ['true'] }],
  ['F2', 'the final version of the capital', { element: 'capital', finial: undefined }],
  ['F2', 'start with a column', { element: 'column', order: undefined }],
  ['F2', 'arhc with a keystone', { element: 'arch', keystone: true }], ['F2', 'dmoe', { element: 'dome' }], ['F2', 'onion doem', { element: 'dome', domeType: 'onion' }],
  ['F2', 'pedastal', { element: 'pedestal' }], ['F2', 'copula with lantern', { element: 'cupola', lantern: true }],
  // 3. compounds only for German words, head last
  ['F3', 'baseball', { outOfScope: true }], ['F3', 'a baseball cap', { outOfScope: true }], ['F3', 'database', { outOfScope: true }],
  ['F3', 'Zeltdach', { element: 'roof', roofType: 'pyramid' }], ['F3', 'Glasdach', { element: 'roof' }], ['F3', 'Rundbogenarkade', { element: 'arcade', archType: 'semicircular' }],
  // 4. a number without unit or size word is a size only next to the element noun
  ['F4', 'Windows 11 update', { outOfScope: true }],
  ['F4', 'Ionic column for room 12', { element: 'column', height: undefined, warns: 'not used' }],
  ['F4', 'Doric column 6', { height: 6 }],
  // 5. "1 m 20", word numbers with halves, centimetres after metres in words
  ['F5', 'column 1 m 20', { height: 1.2 }], ['F5', 'a column two and a half metres tall', { height: 2.5 }],
  ['F5', 'Säule dreieinhalb Meter hoch', { height: 3.5 }], ['F5', 'colonne de trois mètres cinquante', { height: 3.5 }],
  ['F5', 'colonna di tre metri e cinquanta', { height: 3.5 }], ['F5', 'balustrade 3 m 12 balusters', { length: 3, balusters: 12 }],
  // 6. cintré / centinato: an arched head, not a pediment (unless it qualifies the fronton)
  ['F6', 'fenêtre cintrée', { element: 'window', archType: 'segmental', pediment: undefined }],
  ['F6', 'porte cintrée en pierre', { element: 'door', archType: 'segmental', pediment: undefined }],
  ['F6', 'finestra centinata', { element: 'window', archType: 'segmental', pediment: undefined }],
  ['F6', 'fenêtre avec fronton cintré', { element: 'window', pediment: 'segmental' }],
  // 7. self-corrections: the later value of the same field wins, for counts and word numbers too
  ['F7', 'a portico with six columns, sorry, eight', { columns: 8 }],
  ['F7', 'balustrade with 12 balusters, I mean 16', { balusters: 16 }],
  ['F7', 'dôme à douze nervures, pardon, seize', { ribs: 16 }],
  ['F7', 'Säule mit 20 Kanneluren, ich meine 24', { flutes: 24 }],
  ['F7', 'colonna di 3 m, anzi 4', { height: 4 }],
  ['F7', '4 m column, make that 5', { height: 5 }],
  ['F7', 'column diameter 50 cm, no, 60 cm', { diameter: 0.6 }],
  // 8. pedestal on obelisks, urns, finials
  ['F8', 'obelisk on a pedestal', { element: 'obelisk', pedestal: true }], ['F8', 'Obelisk ohne Sockel', { element: 'obelisk', pedestal: false }],
  ['F8', 'urn without a plinth', { element: 'urn', pedestal: false }], ['F8', 'finial on a small pedestal', { element: 'finial', pedestal: true }],
  // 9. a portico by meaning
  ['F9', 'a classical columned front for a courthouse', { element: 'portico' }],
  ['F9', 'something like the front of a Greek temple', { element: 'portico' }],
  ['F9', 'a colonnaded facade for the museum', { element: 'portico' }],
  ['F9', 'Tempel mit sechs Säulen', { element: 'portico', columns: 6 }],
  ['F9', 'a temple with Ionic columns', { element: 'portico', order: 'ionic' }],
  ['F9', 'la façade à colonnes d un temple', { element: 'portico' }],
  ['F9', 'the front of a house', { outOfScope: true }], ['F9', 'a Greek temple', { outOfScope: true }],
  // 10. "X sitting on / over Y": X is the head
  ['F10', 'a pyramid-shaped roof sitting on a clock tower', { element: 'roof', roofType: 'pyramid' }],
  ['F10', 'a gable roof over the bell tower', { element: 'roof', roofType: 'gable' }],
  ['F10', 'a pointy church roof', { element: 'spire' }],
  // 11. figures of speech are not architecture; the real thing next to them still is
  ...['column of smoke', 'pillar of the community', 'a column chart', 'a pillar box', 'dome tent', 'door handle', 'the capital of France',
    'the base of the pyramid', 'a newspaper column', 'a spinal column', 'a capital city', 'Rauchsäule aus dem Schornstein'].map((t) => ['F11', t, { outOfScope: true }]),
  ['F11', 'the capital of a Corinthian column', { element: 'capital', order: 'corinthian' }], ['F11', 'the base of a column', { element: 'base' }],
  ['F11', 'the dome of St Peter\'s', { element: 'dome' }], ['F11', 'the roof of a house, gable', { element: 'roof' }],
  // 12. rulings
  ['F12', 'a stone pier 3 m', { element: 'pilaster', height: 3, warns: 'pier' }], ['F12', 'Pfeiler aus Sandstein', { element: 'pilaster', material: 'sandstone', warns: 'pier' }],
  ['F12', 'arcade on piers', { element: 'arcade', supports: 'piers' }], ['F12', 'urn finial on a gate pier', { element: 'finial', finial: 'urn' }],
  ['F12', 'the Pantheon', { element: 'dome', oculus: true }],
  ['F12', 'a column with no base and no capital', { element: 'column', base: 'none', warns: 'capital' }],
  // 13. exponents are not numbers
  ['F13', 'column 1e3 m', { element: 'column', height: undefined, warns: 'exponent' }],
];
for (const [f, t, want] of REVIEW) check(`${f} “${t}”`, has(t, want));

// every output is a valid spec: SCHEMA fields only, legal enums, finite numbers, element always present
const ALL = [...prompts.map((p) => p.text), ...PARA.map((x) => x[0])];
check('outputs use SCHEMA fields and values only', () => {
  for (const t of ALL) {
    const r = parse(t);
    if (r.outOfScope) continue;
    if (!ELEMENTS.includes(r.spec.element)) return `${t}: element ${r.spec.element}`;
    for (const [k, v] of Object.entries(r.spec)) {
      const s = SCHEMA[k];
      if (!s) return `${t}: field ${k} not in SCHEMA`;
      if (s.type === 'enum' && !s.values.includes(v)) return `${t}: ${k}=${v} not allowed`;
      if ((s.type === 'number' || s.type === 'int') && !Number.isFinite(v)) return `${t}: ${k}=${v} not a number`;
      if (s.type === 'int' && !Number.isInteger(v)) return `${t}: ${k}=${v} not an integer`;
      if (s.type === 'bool' && typeof v !== 'boolean') return `${t}: ${k}=${v} not a boolean`;
    }
    if (typeof r.interpretation !== 'string' || !r.interpretation) return `${t}: no interpretation`;
    if (!(r.confidence >= 0 && r.confidence <= 1)) return `${t}: confidence ${r.confidence}`;
  }
  return '';
});
check('no lexicon collisions', () => (LEXICON_COLLISIONS.length ? LEXICON_COLLISIONS.join(', ') : ''));
// describe() and captions() of every element
check('describe/captions for every element and order', () => {
  for (const el of ELEMENTS) {
    const { spec } = normalize({ element: el });
    const d = describe(spec);
    if (!d || /undefined|NaN/.test(d)) return `${el}: describe “${d}”`;
    for (const seed of [0, 1, 2, 3]) {
      const c = captions(spec, seed);
      if (c.length < 4 || c.length > 6) return `${el}: ${c.length} captions`;
      if (c.some((s) => /undefined|NaN/.test(s))) return `${el}: ${c.join(' | ')}`;
    }
  }
  for (const order of SCHEMA.order.values) {
    const d = describe(normalize({ element: 'column', order }).spec);
    if (/undefined|NaN/.test(d)) return `${order}: ${d}`;
  }
  const d = describe(normalize(parse('Ionic column 3.6 m').spec).spec);
  if (d !== 'Ionic column · 3.60 m · 24 flutes · Attic base · marble') return `describe: ${d}`;
  return '';
});
check('captions carry one DE/FR/IT line with the same facts', () => {
  const spec = normalize(parse('Corinthian column 4.5 m, granite').spec).spec;
  const seen = new Set();
  for (let seed = 0; seed < 12; seed++) {
    const c = captions(spec, seed);
    const f = c.find((s) => /Säule|colonne|colonna/i.test(s));
    if (!f) return `no foreign caption: ${c.join(' | ')}`;
    if (!/4[.,]50/.test(f)) return `foreign caption lacks the height: ${f}`;
    seen.add(f.split(' ')[0]);
  }
  return seen.size >= 2 ? '' : 'only one foreign language over 12 seeds';
});
// a ?spec= link is JSON a stranger may write: inherited names (constructor, toString, __proto__...) are no fields, no
// order, no element; nothing reaches the spec (the drawing's spec block lists it) and no prototype changes
check('normalize() keeps only own SCHEMA fields of a crafted spec', () => {
  const crafted = JSON.parse('{"element":"column","constructor":"\\u0001x","toString":"y","valueOf":2,"hasOwnProperty":"z","__proto__":{"polluted":1},"isPrototypeOf":"w"}');
  const { spec, warnings } = normalize(crafted);
  const bad = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf'].filter((k) => Object.hasOwn(spec, k));
  if (bad.length) return `own keys ${bad.join(', ')} in ${JSON.stringify(spec)}`;
  if (spec.given.length) return `given ${JSON.stringify(spec.given)}`;
  if (Object.getPrototypeOf(spec) !== Object.prototype || ({}).polluted !== undefined) return 'a prototype changed';
  if (warnings.length) return `warnings ${JSON.stringify(warnings)}`;
  for (const order of ['constructor', 'toString', '__proto__']) {
    const n = normalize({ element: 'column', order });
    if (n.spec.order !== 'ionic' || !n.warnings.some((w) => w.includes('unknown order'))) return `order "${order}" → ${n.spec.order} ${JSON.stringify(n.warnings)}`;
  }
  const e = normalize({ element: 'constructor' });
  return e.spec.element === 'column' && e.warnings.length ? '' : `element "constructor" → ${e.spec.element}`;
});
{
  const { family } = await import('../js/generate.js');
  for (const el of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = await family(el).then(() => 'resolved', (e) => e.message);
    check(`family("${el}") rejects`, () => (/no generator/.test(r) ? '' : r));
  }
}
// robustness: never throws, always answers quickly
check('robust on garbage and long input', () => {
  const junk = ['', ' ', '!!!', '0', '-', "'", '"', '°', 'Ø', 'x', '1 x', 'x 2', '3-', '--3 m', '1e9 m', '9999999999999 balusters', '1.2.3.4 m', '1,2,3', 'ü', 'ßßß', '🙂 column',
    'a'.repeat(500), 'column '.repeat(200), 'Ionic column 4 m '.repeat(50), '\n\t column \n', '<script>alert(1)</script>', 'NaN m', 'Infinity m', 'null', 'undefined'];
  let worst = 0;
  for (const t of junk) {
    const t0 = performance.now();
    const r = parse(t);
    worst = Math.max(worst, performance.now() - t0);
    if (typeof r !== 'object' || !('outOfScope' in r)) return `bad result for ${JSON.stringify(t)}`;
    if (r.spec) for (const [k, v] of Object.entries(r.spec)) if (typeof v === 'number' && !Number.isFinite(v)) return `${JSON.stringify(t)}: ${k}=${v}`;
  }
  return worst < 50 ? '' : `slow: ${worst.toFixed(1)} ms`;
});

const failed = cases.filter((c) => !c.ok);
console.log(`unit cases: ${cases.length - failed.length}/${cases.length} pass`);
for (const c of failed) console.log(`  FAIL ${c.name}: ${c.err}`);
if (!quiet) for (const c of cases.filter((x) => x.ok && x.name.startsWith('RF'))) console.log(`  ok ${c.name}`);
if (failed.length) failures++;
console.log(failures ? 'parse tests: FAIL' : 'parse tests: PASS');
process.exit(failures ? 1 : 0);
