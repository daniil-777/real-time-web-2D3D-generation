// Arch Studio interpreter: an architect's free text (EN / DE / FR / IT, Swiss spellings, typos) → a typed spec.
// Deterministic and explainable: tokenise → read numbers and units → look words up in the lexicon (phrases, inflections,
// German compounds, typo tolerance) → detect the language → split into chunks at prepositions → pick the head noun →
// bind counts and sizes → apply modifiers (with negation scope and "last statement wins") → describe.
//   parse(text) → { spec, interpretation, confidence, unknown, outOfScope, message, suggestions, warnings }
// spec holds only what the text states or clearly implies (plus element); normalize() fills the rest.

import { ENTRIES, GROUPS, UNITS, DEGREE_WORDS, NUMBER_MORPHEMES, COMMON_WORDS, fold, foldPlain } from './lexicon.js';
import { normalize, DEFAULTS, SCHEMA } from './spec.js';
import { describe } from './describe.js';

// ================================================================================================= index (built once)
const WORDS = new Map();     // folded word → [{ lang, m }]
const PHRASES = new Map();   // first folded word → [{ key, words, lang, m }], longest first
const FUZZY = [];            // FUZZY[length] = [folded word]
export const LEXICON_COLLISIONS = [];

const splitWords = (s) => s.split(/[^a-z0-9ø]+/).filter(Boolean);
function mergeMeaning(a, b, w) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (out[k] === undefined) out[k] = v;
    else if (JSON.stringify(out[k]) !== JSON.stringify(v)) LEXICON_COLLISIONS.push(`${w} · ${k}`);
  }
  return out;
}
function addForm(words, lang, m) {
  if (words.length === 1) {
    let arr = WORDS.get(words[0]);
    if (!arr) WORDS.set(words[0], (arr = []));
    const same = arr.find((e) => e.lang === lang);
    if (same) same.m = mergeMeaning(same.m, m, words[0]); else arr.push({ lang, m });
    return;
  }
  let arr = PHRASES.get(words[0]);
  if (!arr) PHRASES.set(words[0], (arr = []));
  const key = words.join(' ');
  const same = arr.find((e) => e.key === key && e.lang === lang);
  if (same) same.m = mergeMeaning(same.m, m, key); else arr.push({ key, words, lang, m });
}
for (const [lang, forms, m] of ENTRIES) {
  for (const form of forms.split('|')) {
    const a = splitWords(fold(form)), b = splitWords(foldPlain(form));
    if (a.length) addForm(a, lang, m);
    if (b.length && b.join(' ') !== a.join(' ')) addForm(b, lang, m);
  }
}
for (const u of [...Object.keys(UNITS), ...DEGREE_WORDS]) addForm([u], '*', { fill: true, unitWord: true });
// everyday words are known (so never typo-corrected into architecture) but carry no meaning
for (const w of COMMON_WORDS) { const f = fold(w); if (f.length >= 3 && !WORDS.has(f)) addForm([f], '*', { word: true }); }
for (const arr of PHRASES.values()) arr.sort((x, y) => y.words.length - x.words.length);
const isFunction = (m) => m.stop || m.prep || m.negator || m.corr || m.most;
function letterMask(w) { let m = 0; for (let i = 0; i < w.length; i++) { const c = w.charCodeAt(i) - 97; if (c >= 0 && c < 26) m |= 1 << c; } return m; }
function popcount(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }
const vowels = (w) => w.replace(/[^aeiouy]/g, '').split('').sort().join('');
for (const [w, arr] of WORDS) {
  if (w.length < 4 || /\d/.test(w)) continue;
  if (arr.every((e) => isFunction(e.m) || e.m.word)) continue;
  if (arr.some((e) => e.m.num !== undefined || e.m.mul) && w.length < 6) continue;
  (FUZZY[w.length] ||= []).push({ w, mask: letterMask(w) });
}
const MORPH_KEYS = Object.fromEntries(Object.entries(NUMBER_MORPHEMES).map(([l, t]) => [l, Object.keys(t).sort((a, b) => b.length - a.length)]));

// ================================================================================================= constants
const ORDER_HEADS = new Set(GROUPS.ordh);
const VAGUE_HEADS = new Set(GROUPS.vagh);
const COLX = new Set(GROUPS.colx);
const DOMES = new Set(GROUPS.dome);
const STYLE_VALUES = new Set(SCHEMA.style.values);
const CLASSICAL = new Set(['tuscan', 'doric', 'greek-doric', 'ionic', 'corinthian', 'composite', 'solomonic']);
const BOUNDARY = new Set([',', ';', '.', ':', '!', '?', '(', ')', '[', ']', '/', '...', '..', '|', '\n', '•']);
const FOREIGN = new Set(['vehicle', 'animal', 'person', 'furniture', 'food', 'thing', 'geo']);
const MAIN_DIM = {
  column: 'height', pilaster: 'height', capital: 'height', base: 'height', pedestal: 'height', baluster: 'height',
  finial: 'height', urn: 'height', obelisk: 'height', spire: 'height', console: 'height', window: 'height', door: 'height',
  dome: 'diameter', cupola: 'diameter', balustrade: 'length', entablature: 'length', cornice: 'length', moulding: 'length',
  arcade: 'length', arch: 'span', pediment: 'width', portico: 'width', roof: 'width',
};
const PAIR_DIMS = {
  window: ['width', 'height'], door: ['width', 'height'], roof: ['width', 'length'], portico: ['width', 'depth'],
  arch: ['span', 'height'], arcade: ['length', 'height'], balustrade: ['length', 'height'], entablature: ['length', 'height'],
  cornice: ['length', 'height'], moulding: ['length', 'height'], pediment: ['width', 'height'], console: ['depth', 'height'],
  spire: ['width', 'height'], obelisk: ['width', 'height'], dome: ['diameter', 'height'], cupola: ['diameter', 'height'],
  pedestal: ['width', 'height'],
};
const TRIPLE_DIMS = { roof: ['width', 'length', 'height'], console: ['width', 'depth', 'height'], _: ['width', 'depth', 'height'] };
const NOUN_EL = { column: 'a column', pilaster: 'a pilaster', capital: 'a capital', base: 'a column base', pedestal: 'a pedestal',
  entablature: 'an entablature', cornice: 'a cornice', moulding: 'a moulding', pediment: 'a pediment', portico: 'a portico',
  balustrade: 'a balustrade', baluster: 'a baluster', arch: 'an arch', arcade: 'an arcade', window: 'a window', door: 'a door',
  roof: 'a roof', dome: 'a dome', cupola: 'a cupola', spire: 'a spire', finial: 'a finial', urn: 'an urn', obelisk: 'an obelisk',
  console: 'a console' };

// ================================================================================================= small helpers
function prepare(text) {
  return String(text ?? '').normalize('NFC').toLowerCase()
    .replace(/[’‘‛′`´]/g, "'").replace(/[”“„″«»]/g, '"').replace(/''/g, '"')
    .replace(/[×✕✖]/g, ' x ').replace(/[−–—]/g, '-').replace(/…/g, '...').replace(/⌀/g, ' ø ')
    .replace(/\bw\/o\b/g, ' without ').replace(/\bw\//g, ' with ')
    .replace(/\b\d+(?:[.,]\d+)?e[+-]?\d+\b/g, ' ')                  // 1e3: not a size anyone types
    .replace(/\b(st|ste|ss)\.\s?/g, '$1 ')
    .replace(/(\d+)\s?m\s?(\d{1,2})\s?cm\b/g, (_, a, b) => `${a}.${b.padStart(2, '0')} m`)   // 1 m 20 cm
    .replace(/\b(\d+)m(\d{2})\b/g, '$1.$2 m')                 // 1m20 (French / Swiss notation)
    .replace(/(\d)'(\d{3})(?![\d'"])/g, '$1$2')          // Swiss thousands: 4'500 mm
    .replace(/(\d) (\d{3})(?=\s*mm\b)/g, '$1$2');        // 4 500 mm
}

const TOKRE = /(\d+(?:[.,]\d+)*)|([\p{L}\p{M}]+)|(\.{2,}|[^\s\p{L}\p{M}\d])/gu;
function tokenize(s) {
  const toks = [];
  TOKRE.lastIndex = 0;
  let m;
  while ((m = TOKRE.exec(s))) {
    const p = m.index, e = p + m[0].length;
    if (m[1]) toks.push({ k: 'n', s: m[1], p, e });
    else if (m[2]) toks.push({ k: 'w', s: m[2], f: fold(m[2]), p, e });
    else if (m[3] === '&' || m[3] === '+') toks.push({ k: 'w', s: m[3], f: 'and', p, e, sym: true });
    else toks.push({ k: 'p', s: m[3], p, e });
  }
  return toks;
}

/** Damerau-Levenshtein (optimal string alignment) with an early exit above k. */
function dl(a, b, k) {
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > k) return k + 1;
  let prev2 = null, prev = new Array(m + 1), cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > k) return k + 1;
    const t = prev2 || new Array(m + 1);
    prev2 = prev; prev = cur; cur = t;
  }
  return prev[m];
}
function dice(a, b) {
  const grams = (w) => { const g = []; for (let i = 0; i < w.length - 1; i++) g.push(w.slice(i, i + 2)); return g; };
  const A = grams(a), B = grams(b);
  let common = 0;
  const pool = B.slice();
  for (const g of A) { const k = pool.indexOf(g); if (k >= 0) { common++; pool.splice(k, 1); } }
  return (2 * common) / Math.max(1, A.length + B.length);
}
/** How likely a one-edit slip is: swapped neighbours and dropped/doubled letters are cheap, a wrong first letter dear. */
function slipCost(a, b) {
  if (a.length === b.length) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    if (i < a.length - 1 && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)) return 0.5;
    return i === 0 ? 1.5 : 1;
  }
  const [L, S] = a.length > b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < S.length && L[i] === S[i]) i++;
  if (L[i] === L[i - 1] || L[i] === L[i + 1]) return 0.5;
  return i === 0 ? 1.5 : 1;
}
const skeleton = (w) => w.replace(/(.)\1+/g, '$1').replace(/[aeiouy]/g, '');

/** Inflected forms to try. Plurals (EN/FR/IT) may leave a 3-letter stem ("arcs" → arc); German endings and Romance
 *  gender/number swaps need a stem of 5+ letters, so "turn" never becomes "Tür". */
function variants(f) {
  const out = [];
  const add = (s, min) => { if (s.length >= min && s !== f && !out.includes(s)) out.push(s); };
  if (f.length < 4) return out;
  if (f.endsWith('ies')) add(f.slice(0, -3) + 'y', 3);
  if (f.endsWith('es')) add(f.slice(0, -2), 3);
  if (f.endsWith('s')) add(f.slice(0, -1), 3);
  if (f.endsWith('x')) add(f.slice(0, -1), 4);
  const base = [f];
  if (f.endsWith('s') && f.length > 5) base.push(f.slice(0, -1));
  for (const w of base) {
    if (/(en|em|er|es)$/.test(w)) add(w.slice(0, -2), 5);
    if (/[en]$/.test(w)) add(w.slice(0, -1), 5);
    if (w.endsWith('nne')) add(w.slice(0, -2), 5);
    if (w.endsWith('che')) { add(w.slice(0, -3) + 'ca', 5); add(w.slice(0, -3) + 'co', 5); }
    if (w.endsWith('chi')) add(w.slice(0, -3) + 'co', 5);
    if (w.endsWith('ghe')) add(w.slice(0, -3) + 'ga', 5);
    if (w.endsWith('i')) for (const x of 'oea') add(w.slice(0, -1) + x, 5);
    if (w.endsWith('e')) for (const x of 'ao') add(w.slice(0, -1) + x, 5);
    if (w.endsWith('a')) for (const x of 'oe') add(w.slice(0, -1) + x, 5);
    if (w.endsWith('ee')) add(w.slice(0, -1), 5);
  }
  return out;
}

const LOOKUP_CACHE = new Map();
function lookupWord(f) {
  const direct = WORDS.get(f);
  if (direct) return { cands: direct, via: 'exact' };
  if (LOOKUP_CACHE.has(f)) return LOOKUP_CACHE.get(f);
  let r = null;
  for (const v of variants(f)) { const c = WORDS.get(v); if (c) { r = { cands: c, via: 'variant' }; break; } }
  if (LOOKUP_CACHE.size > 20000) LOOKUP_CACHE.clear();
  LOOKUP_CACHE.set(f, r);
  return r;
}

/** Split a German compound into known parts, head last: "Walmdach" → walm + dach, "Rundbogenarkade" → rund + bogen + arkade.
 *  The head must be a German (or shared) word and every known part German or shared, so English words such as
 *  "baseball" (base + ball) or "database" are never split. */
const germanish = (w) => /(sch|tz|ck|ae|oe|ue|ss|ei|ie|ch)/.test(w);
const isDe = (cands) => cands && cands.some((c) => (c.lang === 'de' || (c.lang === '*' && (c.m.el || c.m.mat || c.m.ord || c.m.os || c.m.sty))) && !isFunction(c.m) && !c.m.word);
function splitCompound(f, depth = 0) {
  if (f.length < 6 || depth > 2) return null;
  for (let i = 2; i <= f.length - 3; i++) {
    const head = f.slice(i), pre = f.slice(0, i);
    if (head.length < 3) break;
    const h = lookupWord(head);
    if (!h || !isDe(h.cands)) continue;
    // prefix, with linking elements (Säule-n-, Dreieck-s-, Triglyph-en-)
    for (const p of [pre, pre.replace(/s$/, ''), pre.replace(/n$/, ''), pre.replace(/en$/, ''), pre.replace(/es$/, ''), pre.replace(/e$/, '')]) {
      if (p.length < 3) continue;
      const q = lookupWord(p);
      if (q && isDe(q.cands)) return [{ f: p, cands: q.cands }, { f: head, cands: h.cands }];
      if (q) continue;
      const deeper = splitCompound(p, depth + 1);
      if (deeper) return [...deeper, { f: head, cands: h.cands }];
    }
    // an unknown modifier in front of a German element noun: "Glasdach", "Eckpilaster"
    if (h.via === 'exact' && h.cands.some((c) => c.m.el && (c.lang === 'de' || c.lang === '*')) && pre.length >= 3 && !WORDS.get(pre)
      && (head.length >= 5 || germanish(f))) return [{ f: pre, cands: null }, { f: head, cands: h.cands }];
  }
  return null;
}

function fuzzyLookup(f, maxD = 2) {
  if (f.length < 4 || /\d/.test(f)) return null;
  let best = null, bestD = 9, bestRank = 9, bestSim = -1;
  const fmask = letterMask(f);
  for (let len = Math.max(4, f.length - maxD); len <= f.length + maxD; len++) {
    const bucket = FUZZY[len];
    if (!bucket) continue;
    for (const { w, mask } of bucket) {
      if (popcount(fmask ^ mask) > 2 * maxD) continue;   // letter sets too different for maxD edits
      // a four-letter word is only reached through a doubled consonant ("rooff") or two swapped neighbours of an
      // element or feature noun ("arhc" → arch, "dmoe" → dome); never "steep" → step
      const swap4 = w.length === 4 && f.length === 4 && slipCost(f, w) === 0.5 && dl(f, w, 1) === 1 && WORDS.get(w).some((e) => e.m.el || e.m.cls);
      if (w.length < 5 && !swap4 && !(f.length === w.length + 1 && [...f].some((c, i) => !/[aeiouy]/.test(c) && f[i - 1] === c && f.slice(0, i) + f.slice(i + 1) === w))) continue;
      const L = Math.max(w.length, f.length);
      let k = Math.min(maxD, L >= 9 ? 2 : L >= 5 || swap4 ? 1 : 0);
      if (!k) continue;
      if (k === 2 && w[0] !== f[0]) k = 1;
      const d = dl(f, w, k);
      if (d > k) continue;
      const c = WORDS.get(w);
      const rank = c.some((e) => e.m.el) ? 0 : c.some((e) => e.m.ord || e.m.os || e.m.cnt) ? 1 : c.some((e) => e.m.fill || e.m.oos) ? 3 : 2;
      const cost = d === 1 ? slipCost(f, w) : d;
      const sim = dice(f, w);
      if (cost < bestD || (cost === bestD && (rank < bestRank || (rank === bestRank && sim > bestSim)))) { best = w; bestD = cost; bestRank = rank; bestSim = sim; }
    }
  }
  if (best) return { cands: WORDS.get(best), via: 'fuzzy', to: best, d: Math.ceil(bestD), cost: bestD };
  // same consonant skeleton (vowel slips: "copula" → cupola)
  if (f.length >= 5 && maxD >= 2) {
    const sk = skeleton(f), vw = vowels(f);
    for (const { w, mask } of FUZZY[f.length] || []) {
      if (mask !== fmask || w[0] !== f[0]) continue;
      if (skeleton(w) === sk && vowels(w) === vw && WORDS.get(w).some((e) => e.m.el || e.m.ord || e.m.os)) return { cands: WORDS.get(w), via: 'fuzzy', to: w, d: 2, cost: 2 };
    }
  }
  return null;
}

function numberWord(f) {
  const arr = WORDS.get(f);
  if (arr) {
    for (const e of arr) if (e.m.num !== undefined) return { v: e.m.num };
    for (const e of arr) if (e.m.mul) return { mul: e.m.mul };
    return null;
  }
  for (const lang of ['de', 'it']) {
    if (f.length < 6) break;
    const table = NUMBER_MORPHEMES[lang], keys = MORPH_KEYS[lang];
    const parts = [];
    let i = 0;
    while (i < f.length) {
      const hit = keys.find((k) => f.startsWith(k, i));
      if (!hit) break;
      parts.push(table[hit]); i += hit.length;
    }
    if (i === f.length && parts.length >= 2) {
      let cur = 0;
      for (const v of parts) cur = v === 100 ? (cur || 1) * 100 : cur + v;
      return { v: cur };
    }
  }
  return null;
}

function parseNum(raw, factor) {
  let s = raw;
  const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
  if (dots && commas) {
    const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    s = s.slice(0, last).replace(/[.,]/g, '') + '.' + s.slice(last + 1);
  } else if (/^\d{1,3}([.,]\d{3})+$/.test(s) && factor === 0.001) s = s.replace(/[.,]/g, '');
  else if (dots + commas > 1) s = s.replace(/[.,](?=.*[.,])/g, '').replace(',', '.');
  else s = s.replace(',', '.');
  return parseFloat(s);
}

const fmt = (v) => (Math.round(v * 100) / 100).toFixed(2);

// ================================================================================================= reading numbers
function readUnit(toks, j) {
  let t = toks[j];
  if (!t) return null;
  if (t.k === 'p' && t.s === '-' && toks[j + 1] && toks[j + 1].k === 'w' && toks[j - 1] && toks[j - 1].e === t.p && t.e === toks[j + 1].p) {
    const u = readUnit(toks, j + 1);
    return u && !u.deg ? { ...u, n: u.n + 1 } : null;
  }
  if (t.k === 'p') {
    if (t.s === "'") return { factor: 0.3048, n: 1, ft: true, name: 'ft' };
    if (t.s === '"') return { factor: 0.0254, n: 1, name: 'in' };
    if (t.s === '°' || t.s === 'º') return { deg: true, n: 1, name: '°' };
    return null;
  }
  if (t.k !== 'w') return null;
  const f = t.f;
  if (f === 'in') {
    const nx = toks[j + 1];
    const ok = !nx || nx.k === 'p' || nx.k === 'n' || (nx.k === 'w' && (['x', 'by', 'high', 'tall', 'wide', 'long', 'deep', 'diameter', 'and'].includes(nx.f)));
    return ok ? { factor: 0.0254, n: 1, name: 'in' } : null;
  }
  if (UNITS[f] !== undefined) return { factor: UNITS[f], n: 1, name: f, ft: UNITS[f] === 0.3048 };
  if (DEGREE_WORDS.has(f)) return { deg: true, n: 1, name: '°' };
  return null;
}

function readNumbers(toks, warnings) {
  // word numbers (runs: "twenty four", "vingt-quatre", "two hundred", "a dozen") become numeric tokens
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'w' || t.used) continue;
    // a fixed phrase wins over its number words ("three-centred arch", "eight-sided"); "half a dozen" is a number
    const ph = PHRASES.get(t.f);
    let phrase = null;
    if (ph) for (const P of ph) { const idx = matchPhrase(toks, i, P.words); if (idx) { phrase = { P, idx }; break; } }
    if (phrase) {
      const v = phrase.P.m.num;
      if (v !== undefined) {
        t.k = 'n'; t.val = v; t.word = true; t.e = toks[phrase.idx[phrase.idx.length - 1]].e;
        for (let k = i + 1; k <= phrase.idx[phrase.idx.length - 1]; k++) toks[k].used = 'num';
      }
      i = phrase.idx[phrase.idx.length - 1];
      continue;
    }
    const nw = numberWord(t.f);
    if (!nw) continue;
    let cur = nw.mul ? nw.mul : nw.v, last = i, prev = cur;
    for (let j = i + 1; j < toks.length; j++) {
      let q = toks[j], skip = 0;
      if ((q.k === 'p' && q.s === '-' && q.p === toks[j - 1].e) || (q.k === 'w' && ['and', 'et', 'und', 'e'].includes(q.f))) { skip = 1; q = toks[j + 1]; }
      if (!q || q.k !== 'w') break;
      const nx = numberWord(q.f);
      if (!nx) break;
      if (nx.mul) cur = (cur || 1) * nx.mul;
      else if (nx.v === 20 && prev === 4 && /^vingt/.test(q.f)) cur = cur - 4 + 80;
      else if ((cur >= 20 && cur % 10 === 0 && cur < 100 && nx.v < 10) || (cur >= 100 && cur % 100 === 0 && nx.v < 100)) cur += nx.v;
      else break;
      prev = nx.v ?? prev;
      for (let k = i + 1; k <= j + skip; k++) toks[k].used = 'num';
      last = j + skip; j += skip;
    }
    t.k = 'n'; t.val = cur; t.word = true;
    if (last > i) t.e = toks[last].e;
  }
  const meas = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'n' || t.used) continue;
    const nx = toks[i + 1];
    // "3D", "1920s", "3rd", "2nd", "1°" ordinals: not measures
    if (!t.word && nx && nx.k === 'w' && nx.p === t.e && /^(d|s|th|st|nd|rd|eme|er|ere|ste|te|ten|ter|ieme)$/.test(nx.f)) { t.used = 'num'; nx.used = 'unit'; continue; }
    const raw = t.word ? null : t.s;
    let neg = false;
    const pv = toks[i - 1];
    if (!t.word && pv && pv.k === 'p' && pv.s === '-' && pv.e === t.p) {
      const pp = toks[i - 2];
      if (!pp || pp.k !== 'n' || pp.e < pv.p) { neg = true; pv.used = 'num'; }
    }
    const m = { i0: i, i1: i, vals: [], raws: [], factor: null, deg: false, word: !!t.word, unitName: null };
    const readOne = (idx) => {
      const tok = toks[idx];
      const u = readUnit(toks, idx + 1);
      let v = tok.word ? tok.val : null, end = idx, unit = u;
      if (u && tok.word && u.name === 'in') unit = null;
      if (unit) {
        end = idx + unit.n;
        if (!unit.deg) {
          v = (tok.word ? tok.val : parseNum(tok.s, unit.factor)) * unit.factor;
          if (unit.ft) {   // 10' 6"  /  10 ft 6 in
            const n2 = toks[end + 1];
            const u2 = n2 && n2.k === 'n' ? readUnit(toks, end + 2) : null;
            if (u2 && u2.name === 'in') { v += parseNum(n2.s) * 0.0254; end += 1 + u2.n; }
            else if (n2 && n2.k === 'n' && !u2 && /^\d{1,2}$/.test(n2.s) && +n2.s < 12) {
              // 6 ft 6, 5'6 : the inches without their mark
              const after = toks[end + 2];
              if (!after || after.k === 'p' || (after.k === 'w' && !UNITS[after.f])) { v += parseNum(n2.s) * 0.0254; end += 1; }
            }
          }
        } else v = tok.word ? tok.val : parseNum(tok.s, 1);
      } else if (!tok.word) v = parseNum(tok.s, 1);
      // "three and a half metres", "tre metri e mezzo", "trois mètres et demi"
      const half = (k) => { const a = toks[k], b = toks[k + 1], c = toks[k + 2];
        if (a && a.k === 'w' && ['and', 'e', 'et', 'und'].includes(a.f)) {
          if (b && b.k === 'w' && ['half', 'mezzo', 'demi', 'demie', 'halb', 'einhalb'].includes(b.f)) return 2;
          if (b && b.k === 'w' && ['a', 'un', 'ein'].includes(b.f) && c && c.k === 'w' && ['half', 'halb'].includes(c.f)) return 3;
        }
        return 0; };
      const h = half(end + 1);
      if (h && v !== null) {
        end += h;
        const u2 = unit ? null : readUnit(toks, end + 1);
        if (u2 && !u2.deg) { unit = u2; v = (v + 0.5) * u2.factor; end += u2.n; }
        else v += 0.5 * (unit && !unit.deg ? unit.factor : 1);
      } else if (unit && unit.factor === 1 && v !== null) {
        // "1 m 20", "trois mètres cinquante", "tre metri e cinquanta": the centimetres after the metres
        let j = end + 1;
        const conj = toks[j] && toks[j].k === 'w' && ['e', 'et', 'und', 'and'].includes(toks[j].f);
        if (conj) j++;
        const c = toks[j], after = toks[j + 1];
        const cv = c && c.k === 'n' ? (c.word ? c.val : /^\d{1,2}$/.test(c.s) ? +c.s : null) : null;
        const free = !after || (after.k === 'p' && !["'", '"', '-', '/'].includes(after.s))
          || (after.k === 'w' && !UNITS[after.f] && !['x', 'by', 'per', 'sur', 'mal', 'auf', 'times'].includes(after.f) && !(WORDS.get(after.f) || []).some((e) => e.m.cnt || e.m.el));
        if (cv !== null && cv > 0 && cv < 100 && Number.isInteger(cv) && free && !c.used && c.p >= toks[end].e) { v += cv / 100; end = j; }
      }
      return { v, unit, end, raw: tok.word ? String(tok.val) : tok.s, int: tok.word || /^\d+$/.test(tok.s) };
    };
    const first = readOne(i);
    const items = [first];
    let end = first.end;
    // pairs and triples: 1.2 x 2.1 m, 8 by 12 m, 1,20 sur 2,10
    for (let guard = 0; guard < 2; guard++) {
      const sep = toks[end + 1], nn = toks[end + 2];
      if (!sep || !nn || nn.k !== 'n' || nn.used) break;
      const isX = (sep.k === 'w' && ['x', 'by', 'per', 'sur', 'mal', 'times', 'auf'].includes(sep.f)) || (sep.k === 'p' && (sep.s === '*' || (sep.s === '/' && sep.p === toks[end].e && nn.p === sep.e)));
      if (!isX) break;
      const it = readOne(end + 2);
      items.push(it); end = it.end;
    }
    // ranges: 3-4 m, 3 to 4 m, zwischen 3 und 4 m: keep the first
    if (items.length === 1) {
      const sep = toks[end + 1], nn = toks[end + 2];
      const before = toks[i - 1];
      const dash = sep && sep.k === 'p' && sep.s === '-' && nn && nn.k === 'n' && sep.p === toks[end].e && nn.p === sep.e;
      const word = sep && sep.k === 'w' && ['to', 'bis', 'until', 'till', 'a', 'au'].includes(sep.f) && nn && nn.k === 'n';
      const between = sep && sep.k === 'w' && ['and', 'und', 'et', 'e'].includes(sep.f) && nn && nn.k === 'n' && before && before.k === 'w' && ['between', 'zwischen', 'entre', 'tra', 'fra'].includes(before.f);
      if (dash || word || between) {
        const it = readOne(end + 2);
        if (!first.unit && it.unit) { const u = it.unit; first.unit = u; first.v = u.deg ? first.v : (first.v ?? parseNum(t.s, u.factor)) * (u.deg ? 1 : u.factor); }
        warnings.push(`a range was given (${first.raw}–${it.raw}); used the first value`);
        end = it.end;
      }
    }
    // a unit written only after the last number applies to all ("1.2 x 2.1 m")
    const lastUnit = items[items.length - 1].unit;
    for (const it of items) {
      if (!it.unit && lastUnit && !lastUnit.deg) { it.unit = lastUnit; it.v = it.v * lastUnit.factor; }
    }
    m.vals = items.map((it) => (neg ? -1 : 1) * it.v);
    m.raws = items.map((it) => it.raw);
    m.factor = items[0].unit && !items[0].unit.deg ? items[0].unit.factor : null;
    m.deg = !!(items[0].unit && items[0].unit.deg);
    m.bare = !items.some((it) => it.unit);
    m.int = items.length === 1 && first.int && !neg;
    m.unitName = items[0].unit ? items[0].unit.name : null;
    m.i1 = end;
    for (let k = i; k <= end; k++) if (!toks[k].used) toks[k].used = k === i ? 'num' : 'unit';
    toks[i].used = 'num';
    toks[i].meas = m;
    meas.push(m);
  }
  return meas;
}

// ================================================================================================= lexicon lookup
function annotate(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 'w' || t.used) { out.push(t); continue; }
    // phrases (longest first); hyphens and apostrophes inside a phrase are skipped
    const ph = PHRASES.get(t.f) || variants(t.f).map((v) => PHRASES.get(v)).find(Boolean);
    let done = false;
    if (ph) {
      for (const P of ph) {
        const idx = matchPhrase(toks, i, P.words);
        if (!idx) continue;
        const cands = ph.filter((q) => q.key === P.key).map((q) => ({ lang: q.lang, m: q.m }));
        const lastTok = toks[idx[idx.length - 1]];
        out.push({ ...t, s: toks.slice(i, idx[idx.length - 1] + 1).filter((q) => q.k === 'w').map((q) => q.s).join(' '), f: P.key, e: lastTok.e, cands, via: 'phrase', span: idx.length });
        for (const k of idx.slice(1)) toks[k].used = 'phrase';
        for (let k = i + 1; k < idx[idx.length - 1]; k++) if (!toks[k].used) toks[k].used = 'phrase';
        i = idx[idx.length - 1];
        done = true;
        break;
      }
    }
    if (done) continue;
    const look = lookupWord(t.f);
    if (look) { out.push({ ...t, cands: look.cands, via: look.via }); continue; }
    const near = fuzzyLookup(t.f, 1);
    if (near) { out.push({ ...t, cands: near.cands, via: 'fuzzy', to: near.to, fcost: near.cost }); continue; }
    const parts = splitCompound(t.f);
    if (parts) {
      parts.forEach((q, n) => out.push({ ...t, f: q.f, cands: q.cands, via: 'compound', comp: true, compLast: n === parts.length - 1, compPart: n }));
      continue;
    }
    const fz = fuzzyLookup(t.f);
    if (fz) { out.push({ ...t, cands: fz.cands, via: 'fuzzy', to: fz.to, fcost: fz.cost }); continue; }
    out.push({ ...t, cands: null });
  }
  return out;
}

function matchPhrase(toks, i, words) {
  const idx = [];
  let j = i;
  for (let w = 0; w < words.length; w++) {
    while (j < toks.length && toks[j].k === 'p' && (toks[j].s === '-' || toks[j].s === "'") && w > 0) j++;
    const t = toks[j];
    if (!t || t.k !== 'w' || (t.used && w > 0)) return null;
    if (t.f !== words[w] && !(w === words.length - 1 || w === 0 ? variants(t.f).includes(words[w]) : false)) return null;
    idx.push(j); j++;
  }
  return idx;
}

function detectLang(toks) {
  const score = { en: 0, de: 0, fr: 0, it: 0 };
  for (const t of toks) {
    if (t.k !== 'w') continue;
    if (/[äöüß]/.test(t.s)) score.de += 1;
    if (t.s === 'à' || /[éèêçœ]/.test(t.s)) score.fr += 0.5;
    if (!t.cands) continue;
    const langs = new Set(t.cands.map((c) => c.lang).filter((l) => l !== '*'));
    if (langs.size === 1) score[[...langs][0]] += 1;
  }
  let best = 'en';
  for (const l of ['de', 'fr', 'it']) if (score[l] > score[best]) best = l;
  return { lang: best, score };
}

function resolveMeaning(cands, lang) {
  if (!cands || !cands.length) return null;
  const star = cands.filter((c) => c.lang === '*');
  let pick = cands.filter((c) => c.lang === lang);
  if (!pick.length) pick = cands.filter((c) => c.lang === 'en');
  if (!pick.length) for (const l of ['de', 'fr', 'it']) { pick = cands.filter((c) => c.lang === l); if (pick.length) break; }
  let m = {};
  for (const c of [...star, ...pick]) m = { ...c.m, ...m };
  return m;
}

// ================================================================================================= the parser
export function parse(text) {
  const raw = String(text ?? '');
  const warnings = [];
  const prepared = prepare(raw);
  let toks = tokenize(prepared);
  const meas = readNumbers(toks, warnings);
  toks = annotate(toks);
  // measurement indices refer to the token list before phrases collapsed and compounds expanded
  toks.forEach((t, j) => { if (t.meas) { const m = t.meas; m.i1 = j + (m.i1 - m.i0); m.i0 = j; } });
  const { lang } = detectLang(toks);
  for (const t of toks) {
    if (t.k !== 'w') continue;
    t.m = t.used ? null : resolveMeaning(t.cands, lang);
    if (t.m && t.m.word) { t.m = null; t.common = true; }   // an ordinary word: never corrected into an element
    if (t.s === 'à' || (t.f === 'a' && (lang === 'fr' || lang === 'it') && !t.used)) t.m = { prep: 'w' };
  }
  if (/\d(?:[.,]\d+)?e[+-]?\d/i.test(raw)) warnings.push('numbers written with an exponent (1e3) are not read');
  // "no," / "non," / "nein," / "no wait" are corrections, not negations
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === 'w' && t.m && t.m.negator && !t.m.prep && ['no', 'non', 'nein', 'nope'].includes(t.f)) {
      const nx = toks.slice(i + 1).find((q) => !q.used);
      if (!nx || (nx.k === 'p' && BOUNDARY.has(nx.s)) || (nx.k === 'w' && nx.m && (nx.m.corr || nx.f === 'wait'))) t.m = { corr: true };
    }
  }
  const S = { toks, meas, lang, warnings, assign: [], head: null, headTok: -1, fluted: [], notes: [] };
  chunkUp(S);
  markNegation(S);

  // ---- head
  const head = toks.some((t) => t.k === 'w' && t.m && t.m.help) && !toks.some(isEl) ? { oos: true, reason: 'help' } : chooseHead(S);
  if (head.oos) return outOfScope(raw, S, head);
  S.head = head.el; S.headTok = head.tok; S.headVia = head.via;
  if (head.warn) warnings.push(head.warn);

  bindCounts(S);
  bindMeasures(S);
  applyWords(S);
  const spec = resolve(S);
  postRules(S, spec);

  // ---- unknown words, interpretation, confidence
  const unknown = unknownWords(S);
  const norm = normalize(spec);
  for (const w of norm.warnings) if (!warnings.includes(w)) warnings.push(w);
  let interpretation = '';
  try { interpretation = describe(norm.spec); } catch (e) { interpretation = `${spec.element}`; }
  const confidence = scoreConfidence(S, unknown, spec);
  const res = { spec, interpretation, confidence, unknown, outOfScope: false, message: '', suggestions: [], warnings: [...new Set(warnings)] };
  if (confidence < 0.6) {
    res.suggestions = suggestionsFor(spec.element);
    res.message = msg(S.lang, 'unsure', { interp: interpretation, unknown }) + ' ' + res.suggestions.slice(0, 3).map((x) => `“${x}”`).join(', ');
  }
  return res;
}

// ------------------------------------------------------------------------------------------------- chunks and negation
function chunkUp(S) {
  const chunks = [];
  let seg = 0;
  let cur = { type: 'main', toks: [], seg, corr: false };
  const open = (type, extra = {}) => { chunks.push(cur); cur = { type, toks: [], seg, ...extra }; };
  S.toks.forEach((t, i) => {
    if (t.used && t.used !== 'num') { t.chunk = cur; return; }
    if (t.k === 'p' && BOUNDARY.has(t.s)) { open('main'); t.chunk = cur; return; }
    if (t.k === 'w' && t.m) {
      if (t.m.corr) { seg++; (S.corrPos ||= {})[seg] = i; open('main', { corr: true }); t.chunk = cur; return; }
      if (t.m.prep) {
        const type = t.m.prep === 'and' ? cur.type : t.m.prep === 'but' ? 'main' : t.m.prep;
        open(type, { top: !!t.m.top, prepTok: i });
        t.chunk = cur; cur.toks.push(i); return;
      }
    }
    t.chunk = cur; cur.toks.push(i);
  });
  chunks.push(cur);
  S.chunks = chunks.filter((c) => c.toks.length || c.corr);
  S.toks.forEach((t) => { t.chunkType = t.chunk ? t.chunk.type : 'main'; });
}

function markNegation(S) {
  let negChunk = null;
  for (const t of S.toks) {
    if (t.chunk !== negChunk) negChunk = t.chunk && t.chunk.type === 'n' ? t.chunk : null;
    t.neg = !!negChunk;
    if (t.k === 'w' && t.m && t.m.negator && !t.m.prep) { negChunk = t.chunk; t.neg = false; t.isNegator = true; }
  }
  // a negator that ends its chunk carries into the next one: "column not on a pedestal", "nicht auf einem Sockel"
  for (let i = 0; i < S.toks.length; i++) {
    const t = S.toks[i];
    if (!t.isNegator) continue;
    const rest = S.toks.slice(i + 1).filter((q) => q.chunk === t.chunk && q.k === 'w' && !q.used);
    const nx = S.toks[i + 1];
    if (!rest.length && nx && nx.k === 'w' && nx.m && nx.m.prep && nx.m.prep !== 'and' && nx.m.prep !== 'but') {
      for (let j = i + 1; j < S.toks.length && S.toks[j].chunk === nx.chunk; j++) S.toks[j].neg = true;
    }
  }
  // a negation after the noun: "pediment: none", "lantern: no", "Basis: keine"
  for (let i = 0; i < S.toks.length; i++) {
    const t = S.toks[i];
    if (t.k !== 'w' || !t.m || !(t.m.neg || t.m.el || t.m.cnt)) continue;
    let j = i + 1;
    while (S.toks[j] && S.toks[j].k === 'p' && [':', '=', '-'].includes(S.toks[j].s)) j++;
    const q = S.toks[j], after = S.toks[j + 1];
    if (j > i + 1 && q && q.k === 'w' && ['no', 'none', 'nein', 'non', 'keine', 'kein', 'aucun', 'aucune', 'nessuno', 'nessuna', 'false', 'off', 'without', 'ohne', 'sans', 'senza'].includes(q.f) && (!after || after.k === 'p')) {
      t.neg = true; q.neg = false; q.isNegator = false;
    }
  }
  // "and"/"or" chunks that continue a negated chunk ("without keystone or pediment") inherit its negation
  for (let i = 1; i < S.toks.length; i++) {
    const t = S.toks[i];
    if (t.k === 'w' && t.m && t.m.prep === 'and' && S.toks[i - 1].neg) {
      for (let j = i + 1; j < S.toks.length && S.toks[j].chunk === t.chunk; j++) S.toks[j].neg = true;
    }
  }
}

// ------------------------------------------------------------------------------------------------- head selection
const isEl = (t) => t.k === 'w' && t.m && t.m.el && !(t.comp && !t.compLast) && !t.neg;
const isNoun = (t) => t.k === 'w' && t.m && (t.m.el || t.m.oos || t.m.land) && !(t.comp && !t.compLast);

function pickInChunk(S, chunk, pred) {
  const idx = chunk.toks.filter((i) => pred(S.toks[i]));
  if (!idx.length) return -1;
  let k = S.lang === 'fr' || S.lang === 'it' ? idx[0] : idx[idx.length - 1];
  const t = S.toks[k];
  if (t.m.el && (t.m.hs || 2) < 2) {   // "dome roof", "Kuppeldach": the dome wins over the roof
    const strong = idx.filter((i) => S.toks[i].m.el && (S.toks[i].m.hs || 2) >= 2);
    if (strong.length) k = strong[strong.length - 1];
  }
  return k;
}

function impliedCandidates(S, onlyMain) {
  const out = [];
  S.toks.forEach((t, i) => {
    if (t.k !== 'w' || !t.m || t.neg) return;
    if (onlyMain && t.chunkType !== 'main') return;
    if (t.m.imp) out.push({ el: t.m.imp[0], w: t.m.imp[1], tok: i });
    // "on top of a gatepost" → finial, "the top bit of a column" → capital, "the bottom part of a column" → base
    if (t.m.top || t.m.bottom) {
      const key = t.m.bottom ? 'bottomEl' : 'topEl';
      for (let j = i + 1; j < Math.min(S.toks.length, i + 7); j++) {
        const q = S.toks[j];
        if (q.k === 'w' && q.m && q.m[key]) { out.push({ el: q.m[key], w: 8.5, tok: j, top: true }); break; }
        if (q.k === 'w' && q.m && q.m.el && !q.m[key]) break;
      }
    }
  });
  out.sort((a, b) => b.w - a.w || a.tok - b.tok);
  return out;
}

const METAPHOR = new Set(['vehicle', 'animal', 'person', 'furniture', 'food', 'thing', 'geo']);
const CUE_KEYS = ['el', 'ord', 'os', 'sty', 'mat', 'set', 'ctx', 'mod', 'cnt', 'vag', 'dim', 'imp', 'top', 'land', 'place', 'oos', 'fl', 'colCue', 'frontCue', 'temple'];
function chooseHead(S) {
  const { toks } = S;
  const live = (t) => t.k === 'w' && t.m && !t.neg;
  const flag = (f) => toks.some((t) => live(t) && t.m[f]);
  let h = chooseHeadCore(S);
  // a portico by meaning: "the front of a Greek temple", "a classical columned front", "Tempel mit sechs Säulen"
  const colNoun = toks.some((t) => isEl(t) && (t.m.el === 'column' || t.m.el === 'pilaster'));
  const temple = flag('temple'), front = flag('frontCue'), columned = flag('colCue');
  const otherEl = h.el && h.via === 'noun' && !['column', 'pilaster'].includes(h.el);
  if (!otherEl && ((temple && (front || columned || colNoun)) || (columned && front))) {
    return { el: 'portico', tok: -1, via: 'implied', impTok: toks.findIndex((t) => live(t) && (t.m.temple || t.m.colCue || t.m.frontCue)) };
  }
  if (h.oos || h.tok < 0) {
    if (!h.oos && h.impTok >= 0 && needsCue(toks[h.impTok]) && !hasCue(S, h.impTok)) return { oos: true, reason: 'unknown', hint: h.el };
    return h;
  }
  const ht = toks[h.tok];
  // a corrected word needs another architectural cue ("basil" is not a base, "chapter 4" not a capital), unless the
  // slip is a swap / doubled letter, or a single edit of a long word ("pedastal")
  if (needsCue(ht) && !hasCue(S, h.tok)) return { oos: true, reason: 'unknown', hint: h.el };
  // figures of speech: "column of smoke", "the capital of France", "a newspaper column", "pillar of the community"
  const next = toks.slice(h.tok + 1).find((q) => !(q.used && q.used !== 'num') && !(q.k === 'w' && q.m && q.m.stop));
  if (next && next.k === 'w' && next.m && next.m.prep === 'o') {
    const ofNoun = toks.find((q) => q.chunk === next.chunk && q.k === 'w' && q.m && (METAPHOR.has(q.m.oos) || q.m.metaY));
    if (ofNoun) return { oos: true, reason: 'figure', word: `${ht.s} ${next.s} ${ofNoun.s}` };
  }
  const prev = toks[h.tok - 1];
  if (prev && prev.k === 'w' && prev.m && prev.m.oos === 'thing' && prev.chunk === ht.chunk) return { oos: true, reason: 'figure', word: `${prev.s} ${ht.s}` };
  if (ht.m.pierWarn) h.warn = 'a free-standing pier is built as a square pier (pilaster)';
  return h;
}

const needsCue = (t) => t.fcost >= 1 && !(t.fcost === 1 && t.f.length >= 7);
/** Is there anything architectural besides token `skip`? (a unit size, an order, a material, a feature, …) */
function hasCue(S, skip) {
  if (S.meas.some((m) => !m.bare && !m.deg)) return true;
  return S.toks.some((t, i) => i !== skip && t.k === 'w' && t.m && !t.m.stop && !t.m.fill && !t.m.prep && CUE_KEYS.some((k) => t.m[k] !== undefined) && !FOREIGN.has(t.m.oos));
}

function chooseHeadCore(S) {
  const { toks, chunks } = S;
  // element nouns in main chunks; a later correction segment overrides an earlier one
  let elTok = -1, elSeg = -1;
  for (const c of chunks) {
    if (c.type !== 'main') continue;
    if (elSeg === c.seg && elTok >= 0) continue;
    const k = pickInChunk(S, c, isEl);
    if (k >= 0 && c.seg > elSeg) { elTok = k; elSeg = c.seg; }
  }
  // the first main chunk that holds any noun decides whether the head is a non-element ("an Ionic sofa", "a house")
  let headNoun = -1;
  for (const c of chunks) {
    if (c.type !== 'main' || (elSeg >= 0 && c.seg !== elSeg)) continue;
    const k = pickInChunk(S, c, isNoun);
    if (k >= 0) { headNoun = k; break; }
  }
  const anyEl = elTok >= 0 ? elTok : toks.findIndex((t, i) => isEl(t) && t.chunkType !== 'lk');
  if (headNoun >= 0 && !toks[headNoun].m.el) {
    const nm = toks[headNoun].m, cat = nm.land ? 'building' : nm.oos;
    if (FOREIGN.has(cat)) {
      const support = toks.findIndex((t) => isEl(t) && (t.chunkType === 'on' || t.chunkType === 'un'));
      const before = toks[headNoun - 1];
      const word = before && before.k === 'w' && before.m && before.m.el && before.chunk === toks[headNoun].chunk ? `${before.s} ${toks[headNoun].s}` : toks[headNoun].s;
      if (support < 0) return { oos: true, reason: cat, word, tokIdx: headNoun };
      return { el: toks[support].m.el, tok: support, via: 'support', warn: `only the ${toks[support].m.el} is built; “${toks[headNoun].s}” is not something this tool makes` };
    }
    if (anyEl >= 0) {
      return { el: toks[anyEl].m.el, tok: anyEl, via: 'part', warn: cat === 'building' ? `whole buildings are not available; built ${NOUN_EL[toks[anyEl].m.el]}` : `“${toks[headNoun].s}” is not available; built ${NOUN_EL[toks[anyEl].m.el]}` };
    }
    const imp = impliedCandidates(S, false).filter((c) => c.w >= 6);
    if ((cat === 'building' || cat === 'part') && imp.length && !toks[headNoun].m.land) return { el: imp[0].el, tok: -1, via: 'implied', impTok: imp[0].tok };
    return { oos: true, reason: cat === 'part' ? 'building' : cat, word: toks[headNoun].s, tokIdx: headNoun };
  }
  if (elTok >= 0) return { el: toks[elTok].m.el, tok: elTok, via: 'noun' };
  // no element noun in a main chunk: "on top of a gatepost", "Ionic", "something grand for a bank entrance"
  const top = impliedCandidates(S, false).find((c) => c.top);
  const impMain = impliedCandidates(S, true).filter((c) => c.w >= 4);
  const foreign = toks.some((t) => t.k === 'w' && t.m && (FOREIGN.has(t.m.oos) || t.m.oos === 'missing' || t.m.oos === 'object') && t.chunkType === 'main');
  const lastUnknown = firstChunkEndsUnknown(S);
  if (!foreign && !lastUnknown) {
    if (top) return { el: top.el, tok: -1, via: 'top', impTok: top.tok };
    if (impMain.length) return { el: impMain[0].el, tok: -1, via: 'implied', impTok: impMain[0].tok };
  }
  if (anyEl >= 0) return { el: toks[anyEl].m.el, tok: anyEl, via: 'noun' };
  const imp = impliedCandidates(S, false);
  if (imp.length && !foreign && !lastUnknown) return { el: imp[0].el, tok: -1, via: 'implied', impTok: imp[0].tok };
  const oosTok = toks.findIndex((t) => t.k === 'w' && t.m && (t.m.oos || t.m.land));
  if (oosTok >= 0) return { oos: true, reason: toks[oosTok].m.land ? 'building' : toks[oosTok].m.oos === 'part' ? 'building' : toks[oosTok].m.oos, word: toks[oosTok].s, tokIdx: oosTok };
  const hintTok = toks.find((t) => t.k === 'w' && t.m && t.m.hint);
  const hint = imp.length ? imp[0].el : hintTok ? hintTok.m.hint : null;
  return { oos: true, reason: S.toks.some((t) => t.k === 'w' && !t.used) ? 'unknown' : 'empty', hint };
}

/** "an Ionic toaster": the first main chunk ends in a word nobody knows → that word is the head noun. */
function firstChunkEndsUnknown(S) {
  const c = S.chunks.find((q) => q.type === 'main' && q.toks.some((i) => S.toks[i].k === 'w' && !S.toks[i].used));
  if (!c) return false;
  const content = c.toks.map((i) => S.toks[i]).filter((t) => t.k === 'w' && !t.used && !(t.m && (t.m.stop || t.m.prep || t.m.negator)));
  if (!content.length) return false;
  const t = S.lang === 'fr' || S.lang === 'it' ? content[0] : content[content.length - 1];
  return !t.m && t.f.length > 2;
}

// ------------------------------------------------------------------------------------------------- assignments
function put(S, field, value, prio, pos, why) { S.assign.push({ field, value, prio, pos, why }); }

function inGroup(key, el) { return key === el || (GROUPS[key] && GROUPS[key].includes(el)); }
function pickCtx(ctx, head) {
  for (const key of Object.keys(ctx)) if (key !== '_' && inGroup(key, head)) return ctx[key];
  return ctx._ || null;
}
function nounClass(t) { return t && t.k === 'w' && t.m ? (t.m.cls || t.m.el || null) : null; }
/** The noun a modifier describes: the next noun in its chunk (EN/DE), or the previous one (FR/IT); then the other side. */
function nearestNoun(S, i, maxR = 3, maxL = 2) {
  const t = S.toks[i];
  const look = (dir, max) => {
    for (let j = i + dir, n = 0; j >= 0 && j < S.toks.length && n < max; j += dir) {
      const q = S.toks[j];
      if (q.chunk !== t.chunk) break;
      if (q.used && q.used !== 'num') continue;
      if (q.k !== 'w') { if (q.k === 'p' && q.s !== '-') break; continue; }
      n++;
      if (nounClass(q)) return q;
    }
    return null;
  };
  const romance = S.lang === 'fr' || S.lang === 'it';
  return romance ? (look(-1, maxL + 1) || look(1, maxR)) : (look(1, maxR) || look(-1, maxL));
}
function pickMod(mod, cls) {
  if (!cls) return null;
  for (const key of Object.keys(mod)) if (key === cls || inGroup(key, cls)) return mod[key];
  return null;
}

function applyMeaning(S, i, m, depth = 0) {
  const t = S.toks[i];
  const pos = i;
  if (t.neg && depth === 0) {
    if (m.neg) for (const [k, v] of Object.entries(m.neg)) put(S, k, v, 3, pos, 'negation');
    if (m.fl) put(S, 'flutes', 0, 3, pos, 'negation');
    if (m.set && m.set.entasis === true) put(S, 'entasis', false, 3, pos);
    return;
  }
  let sub = null;
  if (m.mod) { const n = nearestNoun(S, i); if (n && n !== t) sub = pickMod(m.mod, nounClass(n)); }
  if (!sub && m.ctx) sub = pickCtx(m.ctx, S.head);
  if (sub && depth < 2) applyMeaning(S, i, sub, depth + 1);
  const prio = m.prio || 3;
  if (m.set) for (const [k, v] of Object.entries(m.set)) put(S, k, v, prio, pos);
  if (m.flat) S.notes.push('a flat roof is drawn as a 5° shed roof');
  if (m.mat) applyMaterial(S, i, m.mat, prio);
  if (m.ord) applyOrder(S, i, m.ord, prio, m.colOnly);
  if (m.os) applyOrderStyle(S, i, m.os, prio);
  if (m.sty) put(S, 'style', m.sty, m.styPrio || prio, pos);
  if (m.vag) applyVague(S, i, m.vag, m.colOnly);
  if (m.fl) S.fluted.push(pos);
}

const BODY = { balustrade: ['baluster', 'balustrade'], portico: ['column'], arcade: ['column', 'arch'], arch: ['column'], roof: ['roof'], dome: ['dome'], cupola: ['cupola'] };
function applyMaterial(S, i, mat, prio) {
  // "window with wooden shutters", "spire with a gilded ball": the material belongs to the thing it qualifies,
  // unless that thing is the body of the element ("balustrade with marble balusters")
  const t = S.toks[i];
  for (let j = i + 1; j < S.toks.length; j++) {
    const q = S.toks[j];
    if (q.chunk !== t.chunk || q.k !== 'w' || (q.used && q.used !== 'num')) break;
    if (q.m && (q.m.stop || q.m.fill || q.m.mat)) continue;
    if (!q.m || FOREIGN.has(q.m.oos) || q.m.oos === 'object') return;
    const cls = nounClass(q);
    if (cls && j !== S.headTok && t.chunkType !== 'main' && !(BODY[S.head] || []).includes(q.m.el || cls)) {
      if (!(q.m.el === S.head)) return;
    }
    break;
  }
  put(S, 'material', mat, prio, i);
}

function applyOrder(S, i, order, prio, colOnly) {
  const head = S.head;
  const n = nearestNoun(S, i, 1, 1);
  if (n && nounClass(n) === 'base' && head !== 'base') { if (order === 'tuscan') put(S, 'base', 'tuscan', prio, i); return; }
  if (head === 'base' && order === 'tuscan') put(S, 'base', 'tuscan', prio, i);
  if (colOnly && !COLX.has(head) && !['portico', 'arch', 'arcade'].includes(head)) return;
  if (!CLASSICAL.has(order) && !ORDER_HEADS.has(head)) { if (STYLE_VALUES.has(order)) put(S, 'style', order, prio, i); return; }
  put(S, 'order', order, prio, i);
}
function applyOrderStyle(S, i, v, prio) {
  if (ORDER_HEADS.has(S.head)) put(S, 'order', v, prio, i); else if (STYLE_VALUES.has(v)) put(S, 'style', v, prio, i);
}
function applyVague(S, i, v, colOnly) {
  if (!VAGUE_HEADS.has(S.head)) return;
  if (colOnly && !COLX.has(S.head)) return;
  let o = v;
  if (v === 'corinthian') {
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) { const q = S.toks[j]; if (q.k === 'w' && q.m && q.m.most) { o = 'composite'; break; } }
  }
  put(S, 'order', o, 1, i, 'character');
  S.vague = true;
}

// ------------------------------------------------------------------------------------------------- counts
function bindCounts(S) {
  const { toks } = S;
  toks.forEach((t, i) => {
    if (t.k !== 'w' || !t.m || !t.m.cnt || (t.comp && !t.compLast && !t.m.cnt)) return;
    if (t.neg) return;   // "no steps", "ohne Kanneluren": handled as a negation
    let mIdx = -1;
    // number before the noun, over at most three modifiers: "four Corinthian columns", "15 vase balusters"
    for (let j = i - 1, n = 0; j >= 0 && n < 4; j--) {
      const q = toks[j];
      if (q.used === 'phrase' || q.used === 'unit') continue;
      if (q.k === 'n' && q.meas) { if (countable(q.meas)) mIdx = j; break; }
      if (q.k === 'p' && q.s !== '-') break;
      if (q.k === 'w' && q.m && (q.m.cnt || q.m.prep || q.m.negator)) break;
      if (q.k === 'w' && q.m && q.m.el && q.m.el !== 'urn') break;
      n++;
    }
    // or after it: "columns: 6", "flutes 24" (an element noun needs the colon: "column 360" is a size)
    if (mIdx < 0 && i !== S.headTok) {
      for (let j = i + 1, n = 0, colon = false; j < toks.length && n < 2; j++) {
        const q = toks[j];
        if (q.k === 'p' && (q.s === ':' || q.s === '=')) { colon = true; continue; }
        if (t.m.el && !colon) break;
        if (q.k === 'n' && q.meas && countable(q.meas)) {
          const after = toks[q.meas.i1 + 1];
          if (!(after && after.k === 'w' && after.m && after.m.cnt)) mIdx = j;
        }
        break;
      }
    }
    const cnt = t.m.cnt;
    if (mIdx < 0) {
      if (cnt === 'flutes') S.fluted.push(i);
      else if (t.m.rb && DOMES.has(S.head)) put(S, 'domeType', 'ribbed', 3, i);
      return;
    }
    const meas = toks[mIdx].meas;
    meas.usedAs = 'count';
    const n = meas.vals[0];
    const field = countTo(S, cnt, t.m.el, n, i);
    if (field) (S.numLog ||= []).push({ pos: mIdx, field, kind: 'count' });
  });
}
function countable(m) { return m.bare && !m.usedAs && m.vals.length === 1 && Number.isInteger(m.vals[0]) && m.vals[0] >= 0 && m.vals[0] <= 1000; }

/** Puts a count on the field it means for this head; returns that field (or null when the count is not used). */
function countTo(S, cnt, nounEl, n, pos) {
  const head = S.head;
  switch (cnt) {
    case 'columns':
      if (head === 'portico') { put(S, 'columns', n, 3, pos); return 'columns'; }
      if (head === 'arcade' && n >= 2) { put(S, 'bays', n - 1, 3, pos); S.notes.push(`${n} columns → ${n - 1} bays`); return 'bays'; }
      if (head === 'arch' || head === 'arcade') { put(S, 'supports', 'columns', 3, pos); return null; }
      if (n >= 2 && head === 'column' && S.toks.some((q) => isEl(q) && q.m.el === 'portico')) { S.head = 'portico'; put(S, 'columns', n, 3, pos); return 'columns'; }
      if (n >= 2 && (head === 'column' || head === 'pilaster')) S.notes.push(`one ${head} is built (the request named ${n})`);
      return null;
    case 'balusters':
      if (head === 'baluster' && n >= 2) { S.head = 'balustrade'; S.notes.push(`${n} balusters → a balustrade`); }
      if (S.head === 'balustrade') { put(S, 'balusters', n, 3, pos); return 'balusters'; }
      return null;
    case 'bays':
      if (head === 'arch' && n >= 2) { S.head = 'arcade'; S.notes.push(`${n} arches → an arcade`); }
      if (S.head === 'arcade') { put(S, 'bays', n, 3, pos); return 'bays'; }
      return null;
    case 'flutes': put(S, 'flutes', n, 3, pos); return 'flutes';
    case 'ribs': if (n === 0 || DOMES.has(head)) { put(S, 'ribs', n, 3, pos); return 'ribs'; } return null;
    case 'steps': put(S, 'steps', n, 3, pos); return 'steps';
    case 'sides':
      if (head === 'spire' || head === 'roof') {
        if (n === 8) put(S, 'spireType', 'octagonal', 3, pos);
        else if (n === 4) put(S, head === 'roof' ? 'roofType' : 'spireType', head === 'roof' ? 'hip' : 'square', 3, pos);
      }
      return null;
    default: return null;
  }
}

// ------------------------------------------------------------------------------------------------- sizes
const LEFT_SKIP = new Set(['of', 'is', 'a', 'an', 'the', 'de', 'di', 'd', 'von', 'about', 'approx', 'approximately', 'ca', 'circa', 'around', 'roughly', 'total', 'overall', 'with', 'mit', 'avec', 'con', 'at', 'be', 'by', 'en', 'um', 'etwa', 'environ', 'circa', 'its', 'it', 'and']);
const RIGHT_SKIP = new Set(['de', 'di', 'of', 'in', 'en', 'im', 'da', 'von', 'd', 'total', 'overall', 'clear', 'max', 'maximum']);

function bindMeasures(S) {
  const { toks } = S;
  const usedDim = new Set();
  const dimAt = (j) => { const q = toks[j]; return q && q.k === 'w' && q.m && q.m.dim && !usedDim.has(j) ? q.m.dim : null; };
  for (const m of S.meas) {
    if (m.usedAs) continue;
    let dim = null;
    // a dimension word right after ("6 m long", "5 m de long", "4 m span") or right before ("height 5 m", "Ø 6 m")
    for (let j = m.i1 + 1, n = 0; j < toks.length && n < 3; j++) {
      const q = toks[j];
      if (q.used === 'phrase' || (q.k === 'p' && q.s === '-')) continue;
      if (q.k === 'w' && RIGHT_SKIP.has(q.f) && !(q.m && q.m.dim)) { n++; continue; }
      const d = dimAt(j);
      if (d) { dim = d; usedDim.add(j); }
      break;
    }
    // "D = 0.5 m", "H: 3 m": the letters architects use on drawings
    const p1 = toks[m.i0 - 1], p2 = toks[m.i0 - 2];
    if (!dim && p1 && p1.k === 'p' && (p1.s === '=' || p1.s === ':') && p2 && p2.k === 'w' && p2.s.length === 1) {
      dim = { h: 'height', d: 'diameter', b: 'width', w: 'width', l: 'length', r: 'radius', t: 'depth', s: 'span' }[p2.f] || null;
    }
    // "a column of 7 diameters": a proportion, set by the order
    const nx = toks[m.i1 + 1];
    if (m.bare && nx && nx.k === 'w' && /^(diameters|diametri|diametres|modules|moduli|modulen)$/.test(nx.f)) { m.usedAs = 'proportion'; S.notes.push(`proportions follow the order's rules; “${m.raws[0]} ${nx.s}” is not used`); continue; }
    if (!dim) {
      for (let j = m.i0 - 1, n = 0; j >= 0 && n < 4; j--) {
        const q = toks[j];
        if (q.used === 'phrase' || (q.k === 'p' && (q.s === ':' || q.s === '='))) continue;
        if (q.k === 'w' && LEFT_SKIP.has(q.f) && !(q.m && q.m.dim)) { n++; continue; }
        const d = dimAt(j);
        if (d) { dim = d; usedDim.add(j); }
        break;
      }
    }
    // a self-correction repeats the field of the last number before it: "four bays, no wait, five", "4 m, make that 5"
    const corr = !dim && correctionBase(S, m);
    if (corr && !m.deg && m.vals.length === 1) {
      m.usedAs = 'correction';
      if (corr.kind === 'count' && m.bare) { if (Number.isInteger(m.vals[0])) put(S, corr.field, m.vals[0], 3, m.i0); }
      else put(S, corr.field, Math.round((m.bare ? m.vals[0] * (corr.factor || 1) : m.vals[0]) * 1e6) / 1e6, 3, m.i0);
      (S.numLog ||= []).push({ pos: m.i0, field: corr.field, kind: corr.kind, factor: m.bare ? corr.factor : m.factor });
      continue;
    }
    if (m.word && m.bare) continue;   // "a fluted one", "two": a word number without a unit is never a size
    // a number without unit or size word is a size only right next to the element noun ("column 6", "Kuppel 12")
    if (m.bare && !dim && !m.deg && !nextToHead(S, m)) { m.usedAs = 'dropped'; S.notes.push(`“${m.raws.join(' x ')}” has no unit or size word; not used`); continue; }
    m.usedAs = 'size';
    if (dim === 'spacing') { S.notes.push(`spacing (${m.raws[0]}${m.unitName ? ' ' + m.unitName : ''}) is set by the generator; not used`); continue; }
    assignMeasure(S, m, dim);
  }
}

function correctionBase(S, m) {
  const seg = S.toks[m.i0].chunk ? S.toks[m.i0].chunk.seg : 0;
  const at = seg && S.corrPos ? S.corrPos[seg] : undefined;
  if (at === undefined || !S.numLog) return null;
  const before = S.numLog.filter((x) => x.pos < at);
  return before.length ? before[before.length - 1] : null;
}
const NEAR_SKIP = new Set(['about', 'approx', 'approximately', 'ca', 'circa', 'roughly', 'around', 'some', 'etwa', 'um', 'environ', 'circa', 'ungefaehr']);
function nextToHead(S, m) {
  const h = S.headTok;
  if (h < 0 || S.toks[h].fcost >= 1) return false;
  let j = m.i0 - 1;
  while (j >= 0 && S.toks[j].k === 'w' && NEAR_SKIP.has(S.toks[j].f)) j--;
  if (j === h || (j === h + 1 && S.toks[j].k === 'p' && S.toks[j].s === ',')) return true;
  let k = m.i1 + 1;
  while (k < S.toks.length && S.toks[k].used === 'phrase') k++;
  return k === h;
}

function assignMeasure(S, m, dim) {
  const head = S.head, pos = m.i0;
  if (m.deg || dim === 'pitch') {
    const v = m.vals[0];
    if (head === 'roof') put(S, 'pitch', v, 3, pos);
    else S.notes.push(`the angle ${m.raws[0]}° is not used for ${NOUN_EL[head] || head}`);
    return;
  }
  if (m.vals.length >= 2 && !dim) {
    let fields;
    if (m.vals.length >= 3) fields = TRIPLE_DIMS[head] || TRIPLE_DIMS._;
    else if (COLX.has(head) || ['baluster', 'finial', 'urn'].includes(head)) {
      const [a, b] = m.vals;
      fields = a <= b ? ['diameter', 'height'] : ['height', 'diameter'];
    } else fields = PAIR_DIMS[head] || ['width', 'height'];
    m.vals.forEach((v, k) => { if (fields[k]) putSize(S, fields[k], v, m, pos); });
    return;
  }
  let field = dim ? mapDim(dim, head, m.vals[0]) : MAIN_DIM[head] || 'height';
  let v = m.vals[0];
  if (dim === 'radius') v *= 2;
  if (!dim && head === 'moulding' && !m.bare && v < 0.45) field = 'height';
  if (!dim && COLX.has(head) && S.assign.some((a) => a.field === 'height') && v < 0.35 * S.assign.find((a) => a.field === 'height').value) field = 'diameter';
  putSize(S, field, v, m, pos);
}

function mapDim(dim, head, v) {
  switch (dim) {
    case 'width':
      if (head === 'arch') return 'span';
      if (head === 'arcade') return v <= 8 ? 'span' : 'length';
      if (DOMES.has(head)) return 'diameter';
      if (['column', 'pilaster', 'capital', 'base', 'baluster', 'finial', 'urn'].includes(head)) return 'diameter';
      return 'width';
    case 'span':
      if (head === 'arch' || head === 'arcade') return 'span';
      if (DOMES.has(head)) return 'diameter';
      return 'width';
    case 'diameter': case 'radius':
      return head === 'arch' || head === 'arcade' ? 'span' : 'diameter';
    case 'length':
      return head === 'arch' ? 'span' : 'length';
    case 'depth':
      return head === 'roof' ? 'overhang' : 'depth';
    case 'overhang':
      return head === 'roof' ? 'overhang' : 'depth';
    default: return dim;
  }
}

function typical(head, field) {
  const d = DEFAULTS[head] && DEFAULTS[head][field];
  if (typeof d === 'number') return d;
  if (field === 'height') return { column: 4, pilaster: 4, capital: 0.6, base: 0.25, pedestal: 1.2, arch: 4, arcade: 5, portico: 8, dome: 6, cupola: 3, entablature: 1, cornice: 0.5, pediment: 1.5, roof: 5 }[head] || 3;
  if (field === 'diameter') return DOMES.has(head) ? 8 : 0.5;
  if (field === 'width') return { portico: 12, pedestal: 0.8, spire: 3, obelisk: 1, roof: 8 }[head] || 2;
  if (field === 'depth') return { portico: 4, roof: 8 }[head] || 0.5;
  if (field === 'length') return 4;
  if (field === 'span') return 2.4;
  if (field === 'overhang') return 0.6;
  return 3;
}

function putSize(S, field, v, m, pos) {
  if (m.bare) {
    // a size without a unit: the reading (m / cm / mm) closest to a typical size of this element
    const typ = typical(S.head, field), s = SCHEMA[field];
    let best = null;
    for (const [f, name] of [[1, 'metres'], [0.01, 'centimetres'], [0.001, 'millimetres']]) {
      const x = v * f;
      if (x < Math.max(typ / 15, s ? s.min : 0) || x > Math.min(typ * 15, s ? s.max : Infinity)) continue;
      const d = Math.abs(Math.log(x / typ));
      if (!best || d < best.d) best = { x, d, name };
    }
    if (!best) best = { x: v, name: 'metres' };
    S.warnings.push(`“${m.raws[m.vals.indexOf(v)] ?? v}” has no unit: read as ${best.name} (${fmt(best.x)} m ${field})`);
    v = best.x;
    S.bareSizes = (S.bareSizes || 0) + 1;
  }
  put(S, field, Math.round(v * 1e6) / 1e6, 3, pos);
  (S.numLog ||= []).push({ pos, field, kind: 'size', factor: m.bare ? null : m.factor });
}

// ------------------------------------------------------------------------------------------------- modifiers
function applyWords(S) {
  S.toks.forEach((t, i) => {
    if (t.k !== 'w' || !t.m || (t.used && t.used !== 'num')) return;
    if (t.m.cnt && !t.neg && !t.m.neg && !t.m.mod && !t.m.ctx) return;
    applyMeaning(S, i, t.m);
  });
}

function resolve(S) {
  const spec = { element: S.head };
  const by = {};
  for (const a of S.assign) (by[a.field] ||= []).push(a);
  // "fluted" becomes a flute count once the order is known; it competes with explicit counts by position
  for (const pos of S.fluted) (by.flutes ||= []).push({ field: 'flutes', value: 'FLUTED', prio: 3, pos });
  for (const [field, list] of Object.entries(by)) {
    if (!(field in SCHEMA)) continue;
    const top = Math.max(...list.map((a) => a.prio));
    const best = list.filter((a) => a.prio === top).sort((a, b) => a.pos - b.pos);
    const win = best[best.length - 1];
    const distinct = [...new Set(best.map((a) => JSON.stringify(a.value)))];
    if (top === 3 && distinct.length > 1 && field !== 'flutes') {
      const prev = best.filter((a) => JSON.stringify(a.value) !== JSON.stringify(win.value)).pop();
      S.warnings.push(`${field}: “${show(prev.value)}” and later “${show(win.value)}”; used “${show(win.value)}”`);
    }
    spec[field] = win.value;
  }
  if (spec.flutes === 'FLUTED') spec.flutes = flutesFor(spec.order);
  return spec;
}
const show = (v) => (typeof v === 'number' ? fmt(v).replace(/\.00$/, '') : String(v));
function flutesFor(order) {
  if (['doric', 'greek-doric', 'tuscan'].includes(order)) return 20;
  if (!order || ['ionic', 'corinthian', 'composite'].includes(order)) return 24;
  return ({ egyptian: 8, 'art-deco': 16 })[order] || 24;
}

function postRules(S, spec) {
  const { toks } = S;
  // a pediment over a door or window: the opening is what gets built (it carries the pediment)
  if (spec.element === 'pediment') {
    const op = toks.find((t) => isEl(t) && (t.m.el === 'door' || t.m.el === 'window'));
    if (op) { spec.element = op.m.el; if (!spec.pediment) spec.pediment = 'triangular'; }
  }
  // a pointy church or tower roof is a spire, unless a roof type is stated or the roof only sits on the tower
  // ("a pyramid-shaped roof sitting on a clock tower" stays a roof)
  if (spec.element === 'roof' && !S.assign.some((a) => a.field === 'roofType' && a.prio === 3)) {
    const own = (t) => t.m && !['on', 'ov', 'un', 'at'].includes(t.chunkType);
    const hint = toks.some((t) => own(t) && t.m.spireHint);
    const church = toks.some((t) => own(t) && t.m.topEl === 'spire');
    const tower = toks.some((t) => own(t) && t.m.tower);
    if ((hint && church) || tower) { spec.element = 'spire'; delete spec.roofType; delete spec.pitch; }
  }
  if (['column', 'pilaster'].includes(spec.element) && toks.some((t) => t.neg && t.m && t.m.el === 'capital')) S.notes.push('a column always has a capital; it is kept');
  if (S.head !== spec.element) S.head = spec.element;
  // fields that only make sense for other elements are dropped (kept honest for the spec card)
  const el = spec.element;
  if (!DOMES.has(el)) { delete spec.domeType; delete spec.lantern; delete spec.drum; if (el !== 'spire') delete spec.ribs; }
  if (el !== 'roof') { delete spec.roofType; delete spec.pitch; delete spec.overhang; delete spec.dormers; if (!DOMES.has(el) && el !== 'spire') delete spec.covering; }
  if (!['arch', 'arcade', 'window', 'door'].includes(el)) { delete spec.archType; }
  if (!['arch', 'arcade'].includes(el)) delete spec.supports;
  if (el !== 'portico') { delete spec.columns; delete spec.steps; }
  if (el !== 'balustrade') { delete spec.balusters; delete spec.urns; }
  if (el !== 'arcade') delete spec.bays;
  if (!['balustrade', 'baluster'].includes(el)) delete spec.baluster;
  if (el !== 'spire') delete spec.spireType;
  if (!['column', 'pilaster', 'obelisk', 'urn', 'finial'].includes(el)) delete spec.pedestal;
  if (!['column', 'pilaster'].includes(el)) delete spec.entasis;
  if (el === 'urn' && spec.finial === 'urn') delete spec.finial;
  if (el !== 'dome' && el !== 'cupola' && el !== 'window' && el !== 'door') delete spec.oculus;
  for (const n of S.notes) if (!S.warnings.includes(n)) S.warnings.push(n);
}

// ------------------------------------------------------------------------------------------------- unknown words, confidence
function unknownWords(S) {
  const out = [];
  const seen = new Set();
  const add = (w) => { const s = w.toLowerCase(); if (s.length > 1 && !seen.has(s)) { seen.add(s); out.push(s); } };
  const compKnown = new Map();
  for (const t of S.toks) if (t.comp) compKnown.set(t.p, (compKnown.get(t.p) || false) || !!t.m);
  for (const t of S.toks) {
    if (t.k !== 'w' || t.used) continue;
    if (t.comp) { if (!compKnown.get(t.p) && t.compLast) add(S.toks.filter((q) => q.p === t.p).map((q) => q.s)[0]); continue; }
    if (!t.m) { if (!/^\d/.test(t.s)) add(t.s); continue; }
    const cat = t.m.land ? null : t.m.oos;
    if (!cat) continue;
    const ct = t.chunkType;
    if ((FOREIGN.has(cat) || cat === 'object' || cat === 'missing') && (ct === 'main' || ct === 'w' || ct === 'n')) add(t.s);
    else if ((cat === 'building' || cat === 'part') && (ct === 'w' || ct === 'n') && !t.m.ctx && !t.m.vag) add(t.s);
  }
  return out;
}

function scoreConfidence(S, unknown, spec) {
  let c = S.headVia === 'noun' ? 0.95 : S.headVia === 'top' || S.headVia === 'support' || S.headVia === 'part' ? 0.75 : 0.7;
  const fuzzy = S.toks.filter((t) => t.via === 'fuzzy' && t.m).length;
  c *= Math.pow(0.96, fuzzy);
  c -= Math.min(0.4, 0.08 * unknown.length);
  c -= 0.05 * (S.bareSizes || 0);
  if (S.vague) c -= 0.05;
  if (Object.keys(spec).length === 1 && S.headVia !== 'noun') c -= 0.1;
  return Math.max(0.05, Math.min(1, Math.round(c * 100) / 100));
}

// ================================================================================================= out of scope
const EXAMPLES = {
  en: ['Ionic column 3.6 m on a pedestal', 'copper onion dome Ø 6 m with lantern', 'balustrade with 12 vase balusters', 'hip roof 9 by 13 m, slate', 'segmental pediment over a 1.4 by 2.8 m door', 'tetrastyle Doric portico'],
  de: ['Ionische Säule 3,6 m auf Postament', 'Zwiebelkuppel aus Kupfer mit Laterne', 'Kranzgesims mit Zahnschnitt, 4 m', 'Walmdach 9 x 13 m'],
  fr: ['colonne dorique cannelée de 4 m', 'fronton triangulaire', 'dôme à côtes avec lanterne', 'toit mansardé en ardoise'],
  it: ['colonna corinzia di 4 m', 'cupola a cipolla in rame', 'arco a tutto sesto in mattoni', 'balaustrata con balaustri a vaso'],
};
const BY_REASON = {
  building: ['hip roof 9 by 13 m', 'window with a segmental pediment', 'tetrastyle Ionic portico'],
  missing: ['portico with five steps', 'balustrade with vase balusters', 'semicircular arch, span 3 m'],
  object: ['granite pedestal 1.2 m', 'Egyptian obelisk 12 m', 'terracotta garden urn'],
};
function suggestionsFor(el) {
  const map = {
    column: ['Corinthian column 4 m, fluted', 'Doric column on a pedestal'], capital: ['Ionic capital', 'Corinthian capital, marble'],
    dome: ['hemispherical dome Ø 12 m with oculus', 'copper onion dome with lantern'], roof: ['mansard roof, slate', 'gable roof 40° pitch'],
    arch: ['pointed arch, span 4 m', 'horseshoe arch'], portico: ['hexastyle Doric portico', 'portico with four Corinthian columns'],
  };
  return map[el] || EXAMPLES.en.slice(0, 3);
}

const MSG = {
  en: {
    vehicle: (w) => `“${w}” is a vehicle, not an architectural element. I build single elements of classical and historic architecture, for example:`,
    animal: (w) => `“${w}” is not an architectural element. I build columns, capitals, porticos, arches, domes, roofs and their details, for example:`,
    person: (w) => `I can't make “${w}”; I build architectural elements such as columns, arches and domes, for example:`,
    furniture: (w) => `“${w}” is furniture. I build architectural elements; in that spirit, try:`,
    food: (w) => `“${w}” is not an architectural element. Try one of these instead:`,
    object: (w) => `“${w}” is not one of the elements I can build yet. Try:`,
    thing: (w) => `“${w}” is not an architectural element. I build columns, capitals, porticos, arches, domes, roofs and their details, for example:`,
    geo: (w) => `“${w}” is a place, not an architectural element. Try for example:`,
    generic: (w) => `“${w}” is not an architectural element. Try for example:`,
    building: (w) => `I build single elements, not a whole ${w}. Try one of its parts:`,
    missing: (w) => `There is no ${w} element yet. The closest things I can build:`,
    unknown: () => `I couldn't find an architectural element in that. Try for example:`,
    figure: (w) => `“${w}” is not an architectural element. Try for example:`,
    help: () => `Describe one architectural element in words (English, Deutsch, français or italiano): its type, order or style, size, material and details. For example:`,
    empty: () => `Describe one architectural element, for example:`,
    hint: (el) => `Did you mean ${NOUN_EL[el] || el}? For example:`,
    unsure: ({ interp, unknown }) => `I read this as “${interp}”${unknown.length ? `; not used: ${unknown.join(', ')}` : ''}. If that is not what you meant, edit the fields or try for example:`,
  },
  de: {
    building: (w) => `Ich baue einzelne Bauteile, kein ganzes Gebäude („${w}“). Zum Beispiel:`,
    missing: (w) => `„${w}“ gibt es noch nicht als Bauteil. Am nächsten kommen:`,
    generic: (w) => `„${w}“ ist kein Bauteil. Ich baue Säulen, Kapitelle, Gesimse, Bögen, Kuppeln, Dächer – zum Beispiel:`,
    unknown: () => `Ich habe darin kein Bauteil gefunden. Zum Beispiel:`,
    help: () => `Beschreiben Sie ein Bauteil: Typ, Ordnung oder Stil, Grösse, Material, Details. Zum Beispiel:`,
    unsure: ({ interp, unknown }) => `Verstanden als „${interp}“${unknown.length ? `; nicht verwendet: ${unknown.join(', ')}` : ''}. Sonst zum Beispiel:`,
  },
  fr: {
    building: (w) => `Je construis des éléments, pas un bâtiment entier (« ${w} »). Par exemple :`,
    missing: (w) => `« ${w} » n'existe pas encore comme élément. Les plus proches :`,
    generic: (w) => `« ${w} » n'est pas un élément d'architecture. Je construis colonnes, chapiteaux, arcs, dômes, toits – par exemple :`,
    unknown: () => `Je n'ai pas trouvé d'élément d'architecture. Par exemple :`,
    help: () => `Décrivez un élément : type, ordre ou style, dimensions, matériau, détails. Par exemple :`,
    unsure: ({ interp, unknown }) => `Compris comme « ${interp} »${unknown.length ? ` ; non utilisé : ${unknown.join(', ')}` : ''}. Sinon, par exemple :`,
  },
  it: {
    building: (w) => `Costruisco singoli elementi, non un intero edificio («${w}»). Per esempio:`,
    missing: (w) => `«${w}» non esiste ancora come elemento. I più vicini:`,
    generic: (w) => `«${w}» non è un elemento architettonico. Costruisco colonne, capitelli, archi, cupole, tetti – per esempio:`,
    unknown: () => `Non ho trovato un elemento architettonico. Per esempio:`,
    help: () => `Descrivete un elemento: tipo, ordine o stile, misure, materiale, dettagli. Per esempio:`,
    unsure: ({ interp, unknown }) => `Interpretato come «${interp}»${unknown.length ? `; non usato: ${unknown.join(', ')}` : ''}. Altrimenti, per esempio:`,
  },
};
function msg(lang, key, arg) {
  const L = MSG[lang] || MSG.en;
  const f = L[key] || (['unsure', 'unknown', 'empty', 'hint', 'help'].includes(key) ? null : L.generic) || MSG.en[key] || MSG.en.generic;
  return f(arg);
}

function outOfScope(raw, S, head) {
  const reason = head.reason || 'unknown';
  const lang = S.lang;
  let suggestions;
  // a style word next to a non-element ("an Ionic sofa", "a Baroque wardrobe"): suggest elements in that style
  const style = S.toks.find((t) => t.k === 'w' && t.m && (t.m.ord || t.m.os || t.m.sty));
  const land = S.toks.find((t) => t.k === 'w' && t.m && t.m.sug);
  if (head.hint) suggestions = suggestionsFor(head.hint);
  else if (land) suggestions = land.m.sug;
  else if (style && (reason === 'furniture' || reason === 'object' || reason === 'unknown')) {
    const w = style.s.replace(/^./, (c) => c.toUpperCase());
    suggestions = [`${w} column`, `${w} capital`, `${w} balustrade`];
  } else suggestions = BY_REASON[reason] || (EXAMPLES[lang] || EXAMPLES.en).slice(0, 3);
  let word = head.word || raw.trim();
  if (land && land.m.land) word = word.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  let message = head.hint ? msg(lang, 'hint', head.hint) : msg(lang, reason, word);
  message += ' ' + suggestions.map((s) => `“${s}”`).join(', ');
  const unknown = S.toks.filter((t) => t.k === 'w' && !t.used && !t.m && t.s.length > 1).map((t) => t.s);
  return { spec: null, interpretation: '', confidence: reason === 'unknown' || reason === 'empty' ? 0.6 : 0.9, unknown: [...new Set(unknown)], outOfScope: true, message, suggestions, warnings: S.warnings };
}

/** Debug view: how each word was read (lexicon / inflection / compound / typo), its chunk and negation. */
export function explain(text) {
  const warnings = [];
  let toks = tokenize(prepare(text));
  readNumbers(toks, warnings);
  toks = annotate(toks);
  const { lang, score } = detectLang(toks);
  for (const t of toks) if (t.k === 'w') { t.m = t.used ? null : resolveMeaning(t.cands, lang); if (t.m && t.m.word) { t.m = null; t.common = true; } }
  const S = { toks, lang };
  chunkUp(S); markNegation(S);
  return { lang, score, tokens: toks.map((t) => ({ s: t.s, k: t.k, via: t.via || t.used || '', to: t.to, chunk: t.chunkType, neg: t.neg || undefined,
    m: t.m ? Object.keys(t.m).filter((k) => t.m[k] !== undefined).map((k) => (typeof t.m[k] === 'object' ? k : `${k}=${t.m[k]}`)).join(' ') : (t.k === 'w' && !t.used ? '?' : '') })) };
}
