// Validates Arch Studio prompt libraries: the dev set (arch/test/prompts.json) and the held-out set
// (/Volumes/LaCie/morph3d/archkit/holdout/prompts-holdout.json).
//
//   node arch/test/validate-prompts.mjs <file.json> [<file2.json> ...] [--dev | --holdout]
//
// Per file: JSON structure, unique ids, ids match categories, field names and values against spec.js SCHEMA, the
// special keys (outOfScope, unknownIncludes, why), category sanity (a `units` prompt has a length, a `counts` prompt a
// count, ...), category minimums, and in the dev set every element at least 3 times. The set kind (dev / holdout) is
// taken from the file name ("holdout" in it) unless --dev / --holdout is given.
// Several files: ids and texts unique across files, no held-out prompt that is a dev prompt with one word swapped or
// reordered (three words or more; two-word pairs are warnings to review), and every SCHEMA enum value used at least
// once across all files (with one file this is a warning).
// Exit code 1 on any error.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const { SCHEMA, ELEMENTS } = await import(new URL('../js/spec.js', import.meta.url).href);

const CATS = ['direct', 'units', 'counts', 'negation', 'multilingual', 'vague', 'compound', 'typos', 'oos', 'partial'];
const MIN = {
  dev: { direct: 40, units: 20, counts: 20, negation: 15, multilingual: 32, vague: 25, compound: 15, typos: 15, oos: 15, partial: 10 },
  holdout: { direct: 15, units: 10, counts: 10, negation: 8, multilingual: 15, vague: 10, compound: 8, typos: 6, oos: 6, partial: 5 },
};
const MIN_TOTAL = { dev: 200, holdout: 90 };
const MIN_PER_ELEMENT_DEV = 3;
const LANGS = ['en', 'de', 'fr', 'it', 'de-CH', 'mixed'];
const TOP_KEYS = ['version', 'note', 'conventions', 'prompts'];
const PROMPT_KEYS = ['id', 'cat', 'lang', 'text', 'expect'];
const SPECIAL = ['outOfScope', 'unknownIncludes', 'why'];
const LENGTHS = ['height', 'width', 'length', 'depth', 'diameter', 'span', 'pitch'];
const COUNTS = ['columns', 'balusters', 'bays', 'flutes', 'ribs', 'steps'];

const args = process.argv.slice(2);
const forced = args.includes('--dev') ? 'dev' : args.includes('--holdout') ? 'holdout' : null;
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('usage: node arch/test/validate-prompts.mjs <file.json> [<file2.json> ...] [--dev|--holdout]');
  process.exit(2);
}

const errors = [];
const warnings = [];
const sets = [];

for (const file of files) {
  const kind = forced || (/holdout/i.test(basename(file)) ? 'holdout' : 'dev');
  const err = (m) => errors.push(`${basename(file)}: ${m}`);
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { err(`cannot read/parse: ${e.message}`); continue; }
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) err(`unknown top-level key "${k}"`);
  if (doc.version !== 1) err(`version must be 1, got ${JSON.stringify(doc.version)}`);
  if (typeof doc.note !== 'string') err('note must be a string');
  if (!Array.isArray(doc.prompts)) { err('prompts must be an array'); continue; }

  const ids = new Set();
  const texts = new Map();
  const perCat = Object.fromEntries(CATS.map((c) => [c, 0]));
  let oosTrue = 0;
  const perLang = {};
  const perElement = Object.fromEntries(ELEMENTS.map((e) => [e, 0]));
  const fieldUse = {};

  doc.prompts.forEach((p, i) => {
    const where = `prompt #${i + 1} (${p && p.id})`;
    const bad = (m) => err(`${where}: ${m}`);
    if (!p || typeof p !== 'object') return bad('not an object');
    for (const k of Object.keys(p)) if (!PROMPT_KEYS.includes(k)) bad(`unknown key "${k}"`);
    if (!CATS.includes(p.cat)) bad(`unknown cat "${p.cat}"`);
    else perCat[p.cat]++;
    const idRe = new RegExp(`^${kind === 'holdout' ? 'h-' : ''}${p.cat}-\\d{3}$`);
    if (typeof p.id !== 'string' || !idRe.test(p.id)) bad(`id must look like ${kind === 'holdout' ? 'h-' : ''}${p.cat}-NNN`);
    if (ids.has(p.id)) bad('duplicate id');
    ids.add(p.id);
    if (!LANGS.includes(p.lang)) bad(`unknown lang "${p.lang}" (use ${LANGS.join(', ')})`);
    else perLang[p.lang] = (perLang[p.lang] || 0) + 1;
    if (typeof p.text !== 'string' || !p.text.trim() || p.text !== p.text.trim()) bad('text must be a non-empty trimmed string');
    else {
      const n = norm(p.text);
      if (texts.has(n)) bad(`same text as ${texts.get(n)}`);
      texts.set(n, p.id);
    }
    const x = p.expect;
    if (!x || typeof x !== 'object' || Array.isArray(x) || !Object.keys(x).length) return bad('expect must be a non-empty object');

    for (const [k, v] of Object.entries(x)) {
      fieldUse[k] = (fieldUse[k] || 0) + 1;
      if (k === 'outOfScope') { if (typeof v !== 'boolean') bad('outOfScope must be a boolean'); continue; }
      if (k === 'why') { if (typeof v !== 'string' || !v.trim()) bad('why must be a non-empty string'); continue; }
      if (k === 'unknownIncludes') {
        if (!Array.isArray(v) || !v.length || v.some((w) => typeof w !== 'string' || !w.trim())) bad('unknownIncludes must be a non-empty array of words');
        else for (const w of v) if (typeof p.text === 'string' && !p.text.toLowerCase().includes(w.toLowerCase())) bad(`unknownIncludes "${w}" is not in the text`);
        continue;
      }
      const s = SCHEMA[k];
      if (!s) { bad(`field "${k}" is not in SCHEMA`); continue; }
      if (s.type === 'enum' && !s.values.includes(v)) bad(`${k}: "${v}" is not one of ${s.values.join(', ')}`);
      if ((s.type === 'number' || s.type === 'int') && (typeof v !== 'number' || !Number.isFinite(v) || v < s.min || v > s.max)) bad(`${k}: ${v} is not a number in ${s.min}–${s.max}`);
      if (s.type === 'int' && !Number.isInteger(v)) bad(`${k}: ${v} is not an integer`);
      if (s.type === 'bool' && typeof v !== 'boolean') bad(`${k}: ${v} is not a boolean`);
    }

    if (x.outOfScope === true) {
      oosTrue++;
      for (const k of Object.keys(x)) if (k !== 'outOfScope' && k !== 'why') bad(`out-of-scope gold may hold only outOfScope and why, not "${k}"`);
      if (p.cat !== 'oos') bad('outOfScope: true belongs in cat oos');
    } else if (!x.element) bad('an in-scope prompt must name the element');
    if (x.element) perElement[x.element] = (perElement[x.element] || 0) + 1;

    // Category sanity: the gold must exercise what the category tests.
    if (p.cat === 'units' && !LENGTHS.some((k) => k in x)) bad('a units prompt needs a length/angle field');
    if (p.cat === 'counts' && !COUNTS.some((k) => k in x)) bad('a counts prompt needs a count field');
    if (p.cat === 'negation' && !Object.entries(x).some(([k, v]) => v === false || v === 'none' || (COUNTS.includes(k) && v === 0))) bad('a negation prompt needs a false / "none" / 0 field');
    if (p.cat === 'multilingual' && p.lang === 'en') bad('a multilingual prompt cannot be lang en');
    if (p.cat === 'oos' && typeof x.outOfScope !== 'boolean') bad('an oos prompt must state outOfScope true or false');
    if (p.cat === 'partial' && !x.unknownIncludes && !x.why) bad('a partial prompt needs unknownIncludes or a why for the contradiction');
  });

  const min = MIN[kind];
  for (const c of CATS) {
    const have = c === 'oos' ? oosTrue : perCat[c];
    if (have < min[c]) err(`category ${c}: ${have}${c === 'oos' ? ' out-of-scope' : ''} prompts, minimum ${min[c]}`);
  }
  if (doc.prompts.length < MIN_TOTAL[kind]) err(`${doc.prompts.length} prompts, minimum ${MIN_TOTAL[kind]}`);
  if (kind === 'dev') for (const e of ELEMENTS) if (perElement[e] < MIN_PER_ELEMENT_DEV) err(`element ${e} appears ${perElement[e]}x, minimum ${MIN_PER_ELEMENT_DEV}`);

  sets.push({ file, kind, doc, perCat, oosTrue, perLang, perElement, fieldUse });
}

// Across files: unique ids and texts, no one-word-swap rewrites between dev and held-out.
if (sets.length > 1) {
  const seenId = new Map();
  const seenText = new Map();
  for (const s of sets) for (const p of s.doc.prompts) {
    if (seenId.has(p.id)) errors.push(`id ${p.id} in both ${basename(seenId.get(p.id))} and ${basename(s.file)}`);
    seenId.set(p.id, s.file);
    const n = norm(p.text || '');
    if (seenText.has(n) && seenText.get(n).file !== s.file) errors.push(`text "${p.text}" (${p.id}) also in ${basename(seenText.get(n).file)} (${seenText.get(n).id})`);
    seenText.set(n, { file: s.file, id: p.id });
  }
  for (const a of sets) for (const b of sets) {
    if (a === b || a.kind !== 'dev' || b.kind !== 'holdout') continue;
    for (const h of b.doc.prompts) {
      const th = tokens(h.text || '');
      for (const d of a.doc.prompts) {
        const td = tokens(d.text || '');
        const swapped = th.length === td.length && th.filter((t, i) => t !== td[i]).length <= 1;
        // Two-word prompts ("colonne torse" / "colonne ionqiue") share a head noun by nature: warn, review by hand.
        if (swapped && th.length >= 3) errors.push(`held-out ${h.id} "${h.text}" is dev ${d.id} "${d.text}" with at most one word swapped`);
        else if (swapped && th.length === 2) warnings.push(`held-out ${h.id} "${h.text}" and dev ${d.id} "${d.text}" differ in one of two words`);
        else if (th.length === td.length && th.length > 1 && [...th].sort().join(' ') === [...td].sort().join(' ')) errors.push(`held-out ${h.id} "${h.text}" is dev ${d.id} "${d.text}" reordered`);
        else if (th.length >= 4 && jaccard(th, td) >= 0.8) warnings.push(`held-out ${h.id} "${h.text}" is close to dev ${d.id} "${d.text}"`);
      }
    }
  }
}

// Enum coverage over all files given.
const used = {};
for (const s of sets) for (const p of s.doc.prompts) for (const [k, v] of Object.entries(p.expect || {})) {
  (used[k] ||= new Map()).set(JSON.stringify(v), ((used[k] && used[k].get(JSON.stringify(v))) || 0) + 1);
}
const missing = [];
for (const [k, s] of Object.entries(SCHEMA)) {
  if (s.type !== 'enum') continue;
  for (const v of s.values) if (!used[k] || !used[k].has(JSON.stringify(v))) missing.push(`${k}=${v}`);
}
const boolGaps = [];
for (const [k, s] of Object.entries(SCHEMA)) {
  if (s.type !== 'bool') continue;
  for (const v of [true, false]) if (!used[k] || !used[k].has(JSON.stringify(v))) boolGaps.push(`${k}=${v}`);
}
const unusedFields = Object.keys(SCHEMA).filter((k) => !used[k]);
if (missing.length) (sets.length > 1 ? errors : warnings).push(`enum values never used${sets.length > 1 ? ' across all files' : ' in this file'}: ${missing.join(', ')}`);
if (boolGaps.length) warnings.push(`bool values never used: ${boolGaps.join(', ')}`);

// Report.
for (const s of sets) {
  const min = MIN[s.kind];
  console.log(`\n${s.file}  [${s.kind}]  ${s.doc.prompts.length} prompts (min ${MIN_TOTAL[s.kind]})`);
  console.log('  categories: ' + CATS.map((c) => `${c} ${c === 'oos' ? `${s.oosTrue}+${s.perCat.oos - s.oosTrue}in` : s.perCat[c]}/${min[c]}`).join(', '));
  console.log('  languages:  ' + Object.entries(s.perLang).map(([l, n]) => `${l} ${n}`).join(', '));
  console.log('  elements:   ' + ELEMENTS.map((e) => `${e} ${s.perElement[e]}`).join(', '));
  console.log('  fields:     ' + Object.entries(s.fieldUse).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
}
console.log(`\nenum values covered: ${Object.entries(SCHEMA).filter(([, s]) => s.type === 'enum').reduce((n, [k, s]) => n + s.values.filter((v) => used[k] && used[k].has(JSON.stringify(v))).length, 0)}/${Object.values(SCHEMA).filter((s) => s.type === 'enum').reduce((n, s) => n + s.values.length, 0)}${unusedFields.length ? `; SCHEMA fields never in gold: ${unusedFields.join(', ')}` : ''}`);
for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`ERROR: ${e}`);
console.log(errors.length ? `\nFAIL: ${errors.length} error(s), ${warnings.length} warning(s)` : `\nOK: ${files.length} file(s), 0 errors, ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);

function norm(t) { return t.toLowerCase().replace(/\s+/g, ' ').trim(); }
function tokens(t) {
  return t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\d+(?:[.,'’]\d+)*/g, ' # ').split(/[^a-z#]+/).filter(Boolean);
}
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let i = 0;
  for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}
