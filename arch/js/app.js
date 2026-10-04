// Arch Studio app: prompt -> parse() -> spec -> build worker (Manifold) -> viewer (three.js), plus the spec card,
// examples, exports and the URL. Exposes window.__arch = { ready, errors, busy, last, run } for the site and tests.
//
// URL: ?q=<prompt>  ?spec=<json> (bypasses the parser; q is then only shown)  &mode=stone|white|line
//      &view=three-quarter|front|side|top  &shot=1 (canvas only)  &embed=1 (inside the site)

import { SCHEMA, DEFAULTS, ELEMENTS, MATERIALS } from './spec.js';
import { ORDERS } from './orders.js';
import { PBR } from './export.js';

const A = window.__arch = { ready: false, errors: [], busy: false, last: null, backend: 'webgl', timing: {} };
const mark = (k) => { if (A.timing[k] === undefined) A.timing[k] = Math.round(performance.now()); };   // ms since navigation
const $ = (s) => document.querySelector(s);
const Q = new URLSearchParams(location.search);
const SHOT = Q.get('shot') === '1';

// ------------------------------------------------------------------------------------------------ build worker

// The worker is recycled (terminated, a fresh one with a fresh Manifold instance spawned) before the next build once
// its WASM heap passes HEAP_LIMIT_MB or it has served MAX_BUILDS builds: WASM memory never shrinks and generators
// leave temporaries behind, so long slider sessions would otherwise grow without bound.
const HEAP_LIMIT_MB = 512, MAX_BUILDS = 25;

class Builder {
  constructor(onFatal, onEdges) {
    this.onFatal = onFatal; this.onEdges = onEdges;
    this.seq = 0; this.pending = new Map(); this.heap = 0; this.builds = 0; this.recycled = 0;
    this.spawn();
  }
  spawn() {
    this.w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.ready = new Promise((res, rej) => { this.ok = res; this.fail = rej; });
    this.ready.catch(() => {});
    this.w.onmessage = (e) => this.message(e.data);
    this.w.onerror = (e) => this.fatal('the build worker failed to start' + (e && e.message ? ': ' + e.message : ''));
  }
  fatal(msg) { this.fail(new Error(msg)); this.rejectAll(msg); this.onFatal(msg); }
  rejectAll(msg) { for (const p of this.pending.values()) p.reject(new Error(msg)); this.pending.clear(); }
  message(m) {
    if (m.type === 'ready') { this.heap = m.heapMB; mark('kernel'); this.ok(); return; }
    if (m.type === 'fatal') { this.fatal(m.message); return; }
    if (m.type === 'edges') { this.onEdges(m.id, m.edges); return; }
    const p = this.pending.get(m.id);
    if (!p) { if (m.type === 'error') console.warn('[arch]', m.message); return; }
    this.pending.delete(m.id);
    if (m.type === 'error') { const e = new Error(m.message); e.detail = m.stack; p.reject(e); } else p.resolve(m);
  }
  call(msg) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.w.postMessage({ ...msg, id }); });
  }
  recycle() {
    this.w.terminate();
    this.rejectAll('restarted');
    this.heap = 0; this.builds = 0; this.recycled++;
    this.spawn();
  }
  async build(spec, edges, retry = true) {
    if ((this.heap > HEAP_LIMIT_MB || this.builds >= MAX_BUILDS) && this.pending.size === 0) this.recycle();
    await this.ready;
    try {
      const m = await this.call({ type: 'build', spec, edges });
      this.heap = m.stats.heapMB || 0;
      this.builds++;
      return m;
    } catch (e) {
      // a generator that kept a kernel object between builds finds it deleted: start clean and try once more
      if (retry && /deleted|BindingError/i.test(e.message)) { this.recycle(); return this.build(spec, edges, false); }
      throw e;
    }
  }
  edges(id) { this.w.postMessage({ type: 'edges', id }); }
  async exportAs(format, name) { await this.ready; return this.call({ type: 'export', format, name }); }
}

// ------------------------------------------------------------------------------------------------ parser (+ fallback)

let parseFn = null, describeFn = null;
const parserLoaded = import('./parse.js').then((m) => { parseFn = m.parse; }, () => { console.info('[arch] parse.js not found: keyword fallback'); });
const describeLoaded = import('./describe.js').then((m) => {
  const f = m.describe || m.interpretation || m.interpret || m.oneLine;
  if (typeof f === 'function') describeFn = f;
}, () => {});

const NUMS = {
  column: ['height', 'diameter'], pilaster: ['height', 'diameter'], capital: ['diameter'], base: ['diameter'], pedestal: ['height'],
  entablature: ['length'], cornice: ['length'], moulding: ['length', 'height'], pediment: ['width'],
  portico: ['columns', 'height', 'steps'], balustrade: ['length', 'height', 'balusters'], baluster: ['height'],
  arch: ['span', 'height'], arcade: ['span', 'bays', 'height'], window: ['width', 'height'], door: ['width', 'height'],
  roof: ['width', 'length', 'pitch', 'overhang'], dome: ['diameter', 'ribs'], cupola: ['diameter', 'ribs'], spire: ['height', 'width'],
  finial: ['height'], urn: ['height'], obelisk: ['height'], console: ['height', 'depth', 'width'],
};
const MAIN_DIM = { column: 'height', pilaster: 'height', baluster: 'height', finial: 'height', urn: 'height', obelisk: 'height',
  spire: 'height', pedestal: 'height', console: 'height', dome: 'diameter', cupola: 'diameter', balustrade: 'length',
  entablature: 'length', cornice: 'length', moulding: 'length', arcade: 'length', arch: 'span', pediment: 'width',
  capital: 'diameter', base: 'diameter', portico: 'height', window: 'width', door: 'width', roof: 'width' };

/** A tiny keyword reader, used only when parse.js is not there: element, order, material, one size, a few counts. */
function fallbackParse(text) {
  const t = ' ' + text.toLowerCase().replace(/[,;]/g, ' ') + ' ';
  const spec = {};
  const el = ELEMENTS.find((e) => new RegExp(`\\b${e}(e?s)?\\b`).test(t));
  if (!el) return { spec, outOfScope: true, interpretation: '', unknown: [], warnings: [],
    message: 'That does not look like an architectural element I can build.' };
  spec.element = el;
  const order = Object.keys(ORDERS).sort((a, b) => b.length - a.length).find((k) => t.includes(k.replace('-', ' ')) || t.includes(k));
  if (order) spec.order = order;
  const mat = MATERIALS.find((m) => t.includes(m));
  if (mat) spec.material = mat;
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(mm|cm|m|ft|')(?![a-z])/);
  if (m) {
    const v = parseFloat(m[1].replace(',', '.')) * { mm: 0.001, cm: 0.01, m: 1, ft: 0.3048, "'": 0.3048 }[m[2]];
    spec[MAIN_DIM[el] || 'height'] = v;
  }
  for (const k of ['flutes', 'balusters', 'columns', 'bays', 'steps', 'ribs']) {
    const c = t.match(new RegExp(`(\\d+)\\s+(?:\\w+\\s+)?${k}`));
    if (c) spec[k] = +c[1];
  }
  if (/pedestal/.test(t) && el !== 'pedestal') spec.pedestal = true;
  if (/\b(without|no) (a )?base\b/.test(t)) spec.base = 'none';
  return { spec, outOfScope: false, interpretation: '', unknown: [], warnings: [], confidence: 0.5 };
}

function parse(text) {
  if (parseFn) {
    try { return parseFn(text); } catch (e) { console.warn('[arch] parse failed, fallback used', e); }
  }
  return fallbackParse(text);
}

// ------------------------------------------------------------------------------------------------ formatting

const LABEL = { archType: 'arch', roofType: 'roof', domeType: 'dome', spireType: 'spire', supports: 'carried on', covering: 'covering',
  pediment: 'pediment', baluster: 'baluster', profile: 'profile', enrichment: 'enrichment', finial: 'finial', frieze: 'frieze',
  cornice: 'cornice', base: 'base', order: 'order', material: 'material', style: 'style', detail: 'detail', seed: 'seed', element: 'element' };
const optLabel = (field, v) => field === 'order' ? (ORDERS[v] ? ORDERS[v].label : v) : field === 'material' ? (PBR[v] ? PBR[v].label : v)
  : String(v).replace(/-/g, ' ');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function fmtLen(m, units, digits = 2) {
  if (!Number.isFinite(m)) return '–';
  if (units !== 'ft') return `${m.toFixed(digits)} m`;
  const inches = m / 0.0254;
  let ft = Math.floor(inches / 12), q = Math.round((inches - ft * 12) * 4) / 4;
  if (q >= 12) { ft++; q = 0; }
  const whole = Math.floor(q), frac = { 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[q - whole];
  return ft ? `${ft}′ ${whole}${frac}″` : `${whole}${frac}″`;
}

/** One line from a normalised spec, when describe.js is not there (or the spec was edited by hand). */
function describeSpec(s) {
  if (describeFn) { try { const d = describeFn(s); if (typeof d === 'string' && d) return d; if (d && d.interpretation) return d.interpretation; } catch (e) { /* fall through */ } }
  const el = s.element, out = [];
  const typeOf = { arch: s.archType, arcade: s.archType, roof: s.roofType, dome: s.domeType, cupola: s.domeType, spire: s.spireType,
    baluster: s.baluster, balustrade: s.baluster, moulding: s.profile, finial: s.finial };
  const ordered = ['column', 'pilaster', 'capital', 'base', 'pedestal', 'entablature', 'cornice', 'portico', 'pediment'].includes(el);
  const head = ordered && s.order && ORDERS[s.order] ? `${ORDERS[s.order].label} ${el}`
    : typeOf[el] ? `${String(typeOf[el]).replace(/-/g, ' ')} ${el === 'balustrade' ? 'balustrade' : el}` : el;
  out.push(cap(head));
  const dim = MAIN_DIM[el];
  if (dim && Number.isFinite(s[dim])) out.push(`${dim === 'diameter' ? 'Ø ' : ''}${s[dim].toFixed(2)} m`);
  if (s.flutes && ['column', 'pilaster', 'portico'].includes(el)) out.push(`${s.flutes} flutes`);
  for (const k of ['columns', 'balusters', 'bays']) if (s[k] && (NUMS[el] || []).includes(k)) out.push(`${s[k]} ${k}`);
  if (s.base && s.base !== 'none' && ['column', 'pilaster', 'base'].includes(el)) out.push(`${cap(s.base)} base`);
  if (s.pedestal && el !== 'pedestal') out.push('on a pedestal');
  if (s.pediment && s.pediment !== 'none' && ['portico', 'window', 'door', 'pediment'].includes(el) && el !== 'pediment') out.push(`${s.pediment} pediment`);
  if (s.lantern && ['dome', 'cupola'].includes(el)) out.push('lantern');
  if (s.material) out.push(PBR[s.material] ? PBR[s.material].label : s.material);
  return out.join(' · ');
}

// ------------------------------------------------------------------------------------------------ state

// columns, capitals, porticos, balustrades, arches, windows, cornices (German), roofs, domes, spires, finials, French
const EXAMPLES = [
  'Corinthian column on a pedestal',
  'Ionic capital, marble',
  'Tetrastyle Doric portico',
  'Balustrade with urns',
  'Semicircular arch, span 3 m',
  'Window, segmental pediment',
  'Kranzgesims mit Zahnschnitt',
  'Hip roof, terracotta tiles',
  'Copper onion dome, Ø 6 m',
  'Broach spire with cross',
  'Pineapple finial',
  'Colonne dorique cannelée',
];
const DEFAULT_PROMPT = EXAMPLES[0];

const S = {
  prompt: '', spec: {}, parsed: null, edited: false, units: 'm',
  stats: null, buildId: 0, interpretation: '',
};

const stage = $('#stage'), msgEl = $('#msg');
const showMsg = (text, spin = false) => { msgEl.innerHTML = ''; if (spin) msgEl.insertAdjacentHTML('afterbegin', '<span class="spin" aria-hidden="true"></span>'); msgEl.append(text || ''); };

function fail(text) {
  A.errors.push(text);
  showMsg(text);
  console.error('[arch]', text);
}

const builder = new Builder((m) => { fail(m); A.busy = false; stage.classList.remove('busy'); },
  (id, list) => { if (id === S.buildId && viewer) viewer.setEdges(list); });

let viewer = null;
const viewerReady = (async () => {
  const { Viewer, VIEWS, MODES } = await import('./view.js');
  const bg = getComputedStyle(stage).backgroundColor.match(/[\d.]+/g).slice(0, 3).map((x) => +x / 255);
  viewer = new Viewer($('#c'), { shot: SHOT, background: bg, pixelRatio: SHOT ? 2 : undefined });
  Object.defineProperty(A, 'viewer', { value: viewer, enumerable: false }); // debugging and tests
  const mode = Q.get('mode'), view = Q.get('view');
  if (MODES.includes(mode)) viewer.setMode(mode);
  if (VIEWS[view]) viewer.view = view;
  syncButtons();
  mark('three');
  // ambient occlusion arrives on its own; only screenshots wait for it (an interactive first frame should not)
  const ao = viewer.init().then(() => mark('viewer'));
  if (SHOT) await ao;
  return viewer;
})();
viewerReady.catch((e) => fail('3D view unavailable: ' + (e && e.message ? e.message : e)));

// ------------------------------------------------------------------------------------------------ build

let inflight = false, queued = false;
function requestBuild() {
  if (inflight) { queued = true; return; }
  build();
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

async function build() {
  inflight = true; queued = false;
  const spec = clean(S.spec), prompt = S.prompt, parsed = S.parsed, edited = S.edited;
  A.busy = true; stage.classList.add('busy');
  try {
    await viewerReady;
    const r = await builder.build(spec, viewer.mode === 'line');
    S.buildId = r.id;
    await viewer.setModel(r.meshes, r.stats);
    S.stats = r.stats;
    const interp = !edited && parsed && parsed.interpretation ? parsed.interpretation : describeSpec(r.stats.spec);
    S.interpretation = interp;
    showMsg('');
    renderRead(interp, parsed, r.stats.warnings);
    renderCard(r.stats.spec);
    renderStats(r.stats);
    renderDims();
    syncButtons();
    $('#c').setAttribute('aria-label', '3D view: ' + interp);
    A.last = { prompt, spec: r.stats.spec, interpretation: interp, ms: r.stats.totalMs, buildMs: r.stats.ms, tris: r.stats.tris,
      size: r.stats.size, warnings: r.stats.warnings, parts: r.stats.parts, instances: r.stats.instances, mode: viewer.mode, view: viewer.view,
      heapMB: r.stats.heapMB, workerBuilds: r.stats.builds, recycled: builder.recycled };
    A.ready = true;
    mark('firstModel');
  } catch (e) {
    if (e && e.message === 'restarted') { /* superseded by a worker restart */ }
    else fail(`could not build this: ${e && e.message ? e.message : e}`);
  } finally {
    inflight = false;
    A.busy = false;
    if (queued) build(); else stage.classList.remove('busy');
  }
}

let debounce = 0;
function specChanged() {
  S.edited = true;
  clearTimeout(debounce);
  debounce = setTimeout(() => { syncURL(); requestBuild(); }, 120);
}

/** Interpret a prompt and build it. Resolves when the result is on screen (or answered out of scope). */
async function submit(text) {
  text = String(text || '').trim();
  if (!text) return;
  await parserLoaded; await describeLoaded;
  $('#prompt').value = text;
  const p = parse(text);
  S.parsed = p;
  if (p.outOfScope) {
    renderOOS(p);
    renderRead('', p, []);
    S.prompt = text;
    syncURL();
    A.last = { prompt: text, outOfScope: true, message: p.message || '', interpretation: '', spec: null };
    A.ready = true;              // answered (the site wrapper may drop its loader)
    if (!S.stats) showMsg('');
    return;
  }
  renderOOS(null);
  S.prompt = text; S.spec = { ...(p.spec || {}) }; S.edited = false;
  renderRead(p.interpretation || '', p, p.warnings || [], true);
  syncURL();
  requestBuild();
  return waitLast(text);
}
function waitLast(prompt) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const check = () => {
      if ((A.last && A.last.prompt === prompt && !A.busy) || performance.now() - t0 > 30000) resolve(A.last);
      else setTimeout(check, 50);
    };
    check();
  });
}
A.run = submit;

// ------------------------------------------------------------------------------------------------ UI: read-back

function renderRead(interp, parsed, warnings, preview = false) {
  const i = $('#interp'), n = $('#notes');
  i.textContent = interp || '';
  i.classList.toggle('preview', !!preview);
  n.innerHTML = '';
  const unknown = parsed && parsed.unknown && parsed.unknown.length ? parsed.unknown : [];
  if (unknown.length) n.append(`not used: ${unknown.join(', ')}`);
  const ws = [...new Set([...(parsed && parsed.warnings) || [], ...(warnings || [])])];
  for (const w of ws) {
    if (n.childNodes.length) n.append(document.createElement('br'));
    const s = document.createElement('span'); s.className = 'w'; s.textContent = w; n.append(s);
  }
}

function renderOOS(p) {
  const box = $('#oos');
  if (!p) { box.hidden = true; return; }
  box.hidden = false;
  const list = Array.isArray(p.suggestions) && p.suggestions.length ? p.suggestions.slice(0, 4) : [EXAMPLES[0], EXAMPLES[3], EXAMPLES[8]];
  // the suggestions become buttons, so the message need not quote them as well
  let text = p.message || 'That is not an architectural element I can build yet.';
  const first = typeof list[0] === 'string' ? text.indexOf(`“${list[0]}”`) : -1;
  if (first > 0) text = text.slice(0, first).trim() + ' Try:';
  $('#oosMsg').textContent = text;
  const c = $('#oosChips'); c.innerHTML = '';
  for (const s of list) c.append(chip(typeof s === 'string' ? s : s.text || s.prompt || String(s)));
}

function chip(text) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'chip'; b.textContent = text;
  b.addEventListener('click', () => { submit(text); });
  return b;
}

function renderStats(st) {
  const pieces = st.instances > st.parts ? ` (${st.instances.toLocaleString('en')} pieces)` : '';
  $('#stats').textContent = `${st.tris.toLocaleString('en')} triangles · ${st.parts} parts${pieces} · built in ${Math.round(st.totalMs)} ms`;
}

function renderDims() {
  const el = $('#dims'), st = S.stats;
  if (!st) { el.textContent = ''; return; }
  const [x, y, z] = st.size, u = S.units;
  el.innerHTML = '';
  [['H', z], ['W', x], ['D', y]].forEach(([k, v], i) => {
    if (i) { const d = document.createElement('i'); d.textContent = '·'; el.append(' ', d, ' '); }
    const s = document.createElement('span'); s.textContent = k; el.append(s, ' ' + fmtLen(v, u));
  });
}

// ------------------------------------------------------------------------------------------------ UI: spec card

const ORDER_FIELDS = ['order', 'archType', 'roofType', 'domeType', 'spireType', 'baluster', 'profile', 'enrichment', 'pediment',
  'supports', 'covering', 'finial', 'base', 'frieze', 'cornice'];
const COUNTS = ['flutes', 'columns', 'balusters', 'bays', 'steps', 'ribs'];
const BOOLS = ['pedestal', 'entasis', 'keystone', 'urns', 'returns', 'drum', 'lantern', 'oculus', 'dormers'];
const APPLY = {
  base: ['column', 'pilaster', 'base', 'portico'], flutes: ['column', 'pilaster', 'portico'],
  frieze: ['entablature', 'portico'], cornice: ['entablature', 'cornice', 'portico'],
};
const ALWAYS = { roof: ['dormers'] };   // fields without a default that still belong on the card
let cardElement = null;

function relevant(el, spec) {
  const keys = new Set([...Object.keys(DEFAULTS[el] || {}), ...(NUMS[el] || []), ...(ALWAYS[el] || [])].filter((k) => SCHEMA[k]));
  for (const [k, els] of Object.entries(APPLY)) if (els.includes(el) && spec[k] !== undefined) keys.add(k);
  if (spec.supports === 'columns' && ['arch', 'arcade'].includes(el)) { keys.add('base'); keys.add('flutes'); }
  keys.delete('element');
  const order = [...ORDER_FIELDS, ...(NUMS[el] || []).filter((k) => !COUNTS.includes(k) && k !== 'pitch'), ...COUNTS, 'pitch', ...BOOLS, 'material'];
  return order.filter((k, i) => keys.has(k) && order.indexOf(k) === i);
}

function renderCard(spec) {
  const el = spec.element;
  const box = $('#fields'), more = $('#fieldsMore');
  if (cardElement !== el) {
    cardElement = el;
    box.innerHTML = ''; more.innerHTML = '';
    addField(box, 'element', spec);
    for (const k of relevant(el, spec)) addField(box, k, spec);
    for (const k of ['style', 'detail', 'seed']) addField(more, k, spec);
  }
  // refresh values of the fields that are not being edited
  for (const ctl of document.querySelectorAll('#card [data-field]')) {
    if (ctl === document.activeElement) continue;
    setControl(ctl, spec[ctl.dataset.field]);
  }
  $('#specNote').textContent = S.edited ? 'edited' : '';
}

const isLen = (k) => SCHEMA[k] && SCHEMA[k].unit === 'm';
const toUnit = (m) => S.units === 'ft' ? m / 0.3048 : m;
const fromUnit = (v) => S.units === 'ft' ? v * 0.3048 : v;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

function addField(box, k, spec) {
  const s = SCHEMA[k];
  if (!s) return;
  const id = 'f-' + k;
  const lab = document.createElement('label');
  lab.htmlFor = id; lab.textContent = LABEL[k] || k;
  const wrap = document.createElement('div'); wrap.className = 'ctl';
  let ctl;
  if (s.type === 'enum') {
    ctl = document.createElement('select');
    if (k === 'style') ctl.append(new Option('—', ''));
    for (const v of s.values) ctl.append(new Option(optLabel(k, v), v));
    ctl.addEventListener('change', () => {
      if (k === 'element') {
        // a new element starts from its own defaults; keep a material the user chose
        const keep = S.spec.material && S.edited ? { material: S.spec.material } : {};
        S.spec = { element: ctl.value, ...keep };
        S.parsed = null;
      } else S.spec[k] = ctl.value || undefined;
      specChanged();
    });
  } else if (s.type === 'bool') {
    ctl = document.createElement('input'); ctl.type = 'checkbox';
    ctl.addEventListener('change', () => { S.spec[k] = ctl.checked; specChanged(); });
  } else {
    ctl = document.createElement('input'); ctl.type = 'number'; ctl.inputMode = 'decimal';
    ctl.min = isLen(k) ? round(toUnit(s.min), 2) : s.min; ctl.max = isLen(k) ? round(toUnit(s.max), 1) : s.max;
    ctl.step = s.type === 'int' ? 1 : 'any';
    ctl.placeholder = 'auto';
    ctl.addEventListener('input', () => {
      const v = parseFloat(ctl.value);
      if (ctl.value === '' ) S.spec[k] = undefined;
      else if (Number.isFinite(v)) S.spec[k] = isLen(k) ? round(fromUnit(v), 4) : v;
      else return;
      specChanged();
    });
  }
  ctl.id = id; ctl.dataset.field = k;
  wrap.append(ctl);
  if (s.unit) { const u = document.createElement('span'); u.className = 'unit'; u.dataset.unitFor = k; u.textContent = unitText(k); wrap.append(u); }
  box.append(lab, wrap);
  setControl(ctl, spec[k]);
}
const unitText = (k) => SCHEMA[k].unit === 'm' ? (S.units === 'ft' ? 'ft' : 'm') : SCHEMA[k].unit;

function setControl(ctl, v) {
  const k = ctl.dataset.field;
  if (ctl.type === 'checkbox') ctl.checked = !!v;
  else if (ctl.tagName === 'SELECT') ctl.value = v === undefined ? (k === 'style' ? '' : ctl.value) : v;
  else {
    ctl.value = v === undefined || v === null ? '' : isLen(k) ? String(round(toUnit(v), S.units === 'ft' ? 2 : 3)) : String(v);
    if (ctl.value === '' && S.stats) ctl.placeholder = autoValue(k);
  }
}
function autoValue(k) {
  const st = S.stats;
  // a column's height is the column proper (orders.js): with a pedestal the overall size is not it
  if (k === 'height' && st.spec.pedestal && ['column', 'pilaster'].includes(st.spec.element)) return 'auto';
  const dim = { height: st.size[2], width: st.size[0], length: st.size[0], depth: st.size[1] }[k];
  if (dim !== undefined && Number.isFinite(dim)) return 'auto · ' + round(toUnit(dim), 2);
  const exp = st.expected && st.expected.counts ? st.expected.counts : {};
  const c = { balusters: exp.baluster, columns: exp.column, bays: exp.bay }[k];
  return c ? `auto · ${c}` : 'auto';
}

// ------------------------------------------------------------------------------------------------ UI: buttons

function syncButtons() {
  if (!viewer) return;
  for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', b.dataset.mode === viewer.mode);
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', b.dataset.view === viewer.view);
  for (const b of document.querySelectorAll('[data-units]')) b.setAttribute('aria-pressed', b.dataset.units === S.units);
  $('#figure').setAttribute('aria-pressed', viewer.figureShown());
}

for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => {
  if (!viewer) return;
  viewer.setMode(b.dataset.mode);
  if (viewer.needsEdges()) builder.edges(S.buildId);
  syncButtons(); syncURL();
  if (A.last) A.last.mode = viewer.mode;
});
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => {
  if (!viewer) return;
  viewer.setView(b.dataset.view);
  syncButtons(); syncURL();
  if (A.last) A.last.view = viewer.view;
});
for (const b of document.querySelectorAll('[data-units]')) b.addEventListener('click', () => {
  S.units = b.dataset.units;
  syncButtons(); renderDims();
  if (S.stats) { cardElement = null; renderCard(S.stats.spec); }   // rebuild: values, units and limits in the new unit
});
$('#figure').addEventListener('click', () => { if (!viewer) return; viewer.setFigure(!viewer.figureShown()); syncButtons(); });

for (const b of document.querySelectorAll('[data-export]')) b.addEventListener('click', async () => {
  if (!S.stats) return;
  const f = b.dataset.export, name = slug();
  if (f === 'json') {
    const doc = { generator: 'Arch Studio', prompt: S.prompt || null, interpretation: S.interpretation, spec: S.stats.spec,
      size_m: { x: S.stats.size[0], y: S.stats.size[1], z: S.stats.size[2] }, axes: 'Z up, metres, origin at the base centre, front faces -Y',
      created: new Date().toISOString() };
    return download(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), name + '.spec.json');
  }
  const old = b.textContent;
  b.disabled = true; b.textContent = '…';
  try {
    const r = await builder.exportAs(f, name);
    download(new Blob([r.buffer], { type: r.mime }), `${name}.${f}`);
  } catch (e) { fail(`export failed: ${e.message}`); }
  finally { b.disabled = false; b.textContent = old; }
});
function slug() {
  const s = S.stats.spec;
  const head = [s.order && ['column', 'pilaster', 'capital', 'base', 'portico', 'entablature', 'cornice'].includes(s.element) ? s.order : '',
    s.archType || s.roofType || s.domeType || s.spireType || '', s.element].filter(Boolean).join('-');
  return ('arch-' + head).replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// prompt box: live read-back while typing, build on Enter
let typing = 0;
$('#prompt').addEventListener('input', (e) => {
  clearTimeout(typing);
  const text = e.target.value.trim();
  typing = setTimeout(() => {
    if (!text || !parseFn) return;
    const p = parse(text);
    if (p.outOfScope) return;
    renderRead(p.interpretation ? p.interpretation + '  ↵' : '', p, [], true);
  }, 180);
});
$('#ask').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(typing); submit($('#prompt').value); });

const chips = $('#chips');
for (const t of EXAMPLES) chips.append(chip(t));

// first interaction hides the hint
const hint = $('#hint');
const hideHint = () => { hint.style.opacity = '0'; };
$('#c').addEventListener('pointerdown', hideHint, { once: true });
$('#c').addEventListener('wheel', hideHint, { once: true, passive: true });

// ------------------------------------------------------------------------------------------------ URL

function syncURL() {
  const q = new URLSearchParams(location.search);
  if (S.prompt) q.set('q', S.prompt); else q.delete('q');
  if (S.edited) q.set('spec', JSON.stringify(clean(S.spec))); else q.delete('spec');
  if (viewer && viewer.mode !== 'stone') q.set('mode', viewer.mode); else q.delete('mode');
  if (viewer && viewer.view !== 'three-quarter') q.set('view', viewer.view); else q.delete('view');
  const s = q.toString().replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%2F/g, '/');
  try { history.replaceState(null, '', s ? '?' + s : location.pathname); } catch (e) { /* sandboxed */ }
}

// ------------------------------------------------------------------------------------------------ start

(async () => {
  const specQ = Q.get('spec'), q = Q.get('q');
  if (specQ) {
    let spec = null;
    try { spec = JSON.parse(specQ); } catch (e) { fail('?spec= is not valid JSON'); }
    if (spec) {
      await describeLoaded;
      S.prompt = q || ''; S.spec = spec; S.edited = true; S.parsed = null;
      $('#prompt').value = S.prompt;
      requestBuild();
      return;
    }
  }
  submit(q || DEFAULT_PROMPT);
})();
