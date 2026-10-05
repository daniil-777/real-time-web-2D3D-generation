// Arch Studio app: prompt -> parse() -> spec -> build worker (Manifold) -> viewer (three.js), plus the spec card,
// examples, exports and the URL. Exposes window.__arch = { ready, errors, busy, last, run } for the site and tests.
//
// URL: ?q=<prompt>  ?spec=<json> (bypasses the parser; q is then only shown)  &mode=stone|white|line
//      &view=three-quarter|front|side|top  &shot=1 (canvas only)  &embed=1 (inside the site)

import { SCHEMA, DEFAULTS, ELEMENTS, MATERIALS } from './spec.js';
import { ORDERS } from './orders.js';
import { PBR } from './export.js';
import { smartStretch, makeDeformer, resolveOps, arapLattice, ffdLattice, foldCheck } from './deform.js';

const A = window.__arch = { ready: false, errors: [], busy: false, last: null, backend: 'webgl', timing: {} };
const mark = (k) => { if (A.timing[k] === undefined) A.timing[k] = Math.round(performance.now()); };   // ms since navigation
const $ = (s) => document.querySelector(s);
const Q = new URLSearchParams(location.search);
const SHOT = Q.get('shot') === '1';

// ------------------------------------------------------------------------------------------------ build worker

// The worker is recycled (terminated, a fresh one with a fresh Manifold instance spawned) before the next build once
// its WASM heap passes HEAP_LIMIT_MB or it has served MAX_BUILDS builds (WASM memory never shrinks and generators leave
// temporaries behind), after an error of the kernel itself (abort, out of bounds, unreachable…: the build is retried
// once on the fresh worker), and by a watchdog when a build or an export does not answer within its time limit.
const HEAP_LIMIT_MB = 512, MAX_BUILDS = 25, BUILD_TIMEOUT_MS = 45000, EXPORT_TIMEOUT_MS = 90000;

class Builder {
  constructor(onFatal, onEdges) {
    this.onFatal = onFatal; this.onEdges = onEdges;
    this.seq = 0; this.pending = new Map(); this.heap = 0; this.builds = 0; this.recycled = 0; this.sick = false;
    this.buildTimeout = BUILD_TIMEOUT_MS; this.exportTimeout = EXPORT_TIMEOUT_MS;
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
    if (m.type === 'error' && m.heapMB !== undefined) { this.heap = m.heapMB; this.builds = m.builds; }
    const p = this.pending.get(m.id);
    if (!p) { if (m.type === 'error') console.warn('[arch]', m.message); return; }
    this.pending.delete(m.id);
    if (m.type === 'error') { const e = new Error(m.message); e.code = m.code; e.detail = m.stack; p.reject(e); } else p.resolve(m);
  }
  /** Post a request; with a time limit the worker is recycled (and the request rejected with 'timeout') if it hangs. */
  call(msg, timeoutMs = 0) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = timeoutMs ? setTimeout(() => { if (this.pending.has(id)) this.recycle('timeout'); }, timeoutMs) : 0;
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.w.postMessage({ ...msg, id });
    });
  }
  recycle(reason = 'restarted') {
    this.w.terminate();
    this.rejectAll(reason);
    this.heap = 0; this.builds = 0; this.sick = false; this.recycled++;
    this.spawn();
  }
  /** Build spec (and deform it by ops when given: { ops, deformOpts }). */
  async build(spec, edges, deform = null, retry = true) {
    if ((this.sick || this.heap > HEAP_LIMIT_MB || this.builds >= MAX_BUILDS) && this.pending.size === 0) this.recycle();
    await this.ready;
    try {
      const m = await this.call({ type: 'build', spec, edges, ...(deform || {}) }, this.buildTimeout);
      this.heap = m.stats.heapMB || 0;
      this.builds = m.stats.builds || this.builds + 1;
      return m;
    } catch (e) {
      if (e.message === 'timeout') throw new Error(`building this took longer than ${Math.round(this.buildTimeout / 1000)} s; the CAD kernel was restarted`);
      if (e.code === 'kernel') {
        this.sick = true;
        if (retry) { this.recycle(); return this.build(spec, edges, deform, false); }
      }
      throw e;
    }
  }
  edges(id) { this.w.postMessage({ type: 'edges', id }); }
  /** The undeformed element, refined for the GPU preview (see worker.js base()). */
  async base(spec, deformOpts) { await this.ready; return this.call({ type: 'base', spec, deformOpts }, this.buildTimeout); }
  async exportAs(format, name, forId) { await this.ready; return this.call({ type: 'export', format, name, forId }, this.exportTimeout); }
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
  stats: null, interpretation: '',
  shown: { id: 0, input: null },   // the build on screen: its worker id and the spec it was built from
};
let edgeStash = null;             // feature edges that arrived before their build was on screen

const stage = $('#stage'), msgEl = $('#msg');
const showMsg = (text, spin = false) => { msgEl.innerHTML = ''; if (spin) msgEl.insertAdjacentHTML('afterbegin', '<span class="spin" aria-hidden="true"></span>'); msgEl.append(text || ''); };

/** A failure: in the middle of the stage while nothing is shown; a passing note over a model that is still valid. */
function fail(text) {
  A.errors.push(text);
  if (S.stats) toast(text); else showMsg(text);
  console.error('[arch]', text);
}
let toastT = 0;
function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 5000);
}
/** Announce to screen readers (only finished builds and answers, never every typing pause). */
const announce = (text) => { $('#sr').textContent = text; };

const builder = new Builder((m) => { fail(m); A.busy = false; stage.classList.remove('busy'); },
  (id, list) => {
    if (viewer && id === S.shown.id) viewer.setEdges(list);
    else edgeStash = { id, list };
  });

Object.defineProperty(A, 'builder', { value: builder, enumerable: false }); // tests
Object.defineProperty(A, 'state', { value: S, enumerable: false });

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

let inflight = false, queued = false, lastShown = 0, idleWaiters = [];
/** reason 'deform': the transform panel asked (the camera stays where it is). */
function requestBuild(reason = null) {
  if (reason) S.buildReason = reason;
  if (inflight) { queued = true; return; }
  build();
}
const waitIdle = () => (inflight ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve());

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

async function build() {
  inflight = true; queued = false;
  const smart = smartInput(), spec = smart.spec, ops = deformOps(smart.free), infoKey = S.element ? S.element.key : null;
  const prompt = S.prompt, parsed = S.parsed, edited = S.edited, xs = JSON.stringify(S.x), reason = S.buildReason;
  S.buildReason = null;
  A.busy = true; stage.classList.add('busy');
  try {
    await viewerReady;
    const deform = ops.length ? { ops, deformOpts: { rigidInstances: S.x.rigid } } : null;
    const r = await builder.build(spec, viewer.mode === 'line', deform);
    // a newer request is waiting: do not spend a frame on this one (unless nothing has been shown for a while)
    if (queued && performance.now() - lastShown < 800) return;
    await viewer.setModel(r.meshes, r.stats, { keepCamera: reason === 'deform' && S.stats && S.stats.spec.element === r.stats.spec.element,
      keepPreview: S.dragging });
    lastShown = performance.now();
    S.shown = { id: r.id, input: spec, deform };
    S.stats = r.stats;
    S.element = r.stats.element;
    S.applied = smart.applied;
    S.builtX = xs;
    if (!ops.length) S.plainMeshes = { key: r.stats.element.key, meshes: r.meshes };
    if (JSON.stringify(spec) === JSON.stringify(clean(S.spec))) { S.baseSize = r.stats.element.size; S.baseNorm = r.stats.spec; }
    if (edgeStash && edgeStash.id === r.id) viewer.setEdges(edgeStash.list);
    else if (viewer.needsEdges()) builder.edges(r.id);
    edgeStash = null;
    const interp = !edited && parsed && parsed.interpretation && !smart.changed ? parsed.interpretation : describeSpec(r.stats.spec);
    S.interpretation = interp;
    showMsg('');
    renderRead(interp, parsed, r.stats.warnings);
    renderCard(r.stats.spec);
    renderStats(r.stats);
    renderDims();
    renderX();
    syncButtons();
    $('#c').setAttribute('aria-label', `3D view of the ${interp}. Arrow keys orbit, + and − zoom, F frames the whole element.`);
    announce(`Built: ${interp}${r.stats.deform ? ', transformed' : ''}.`);
    A.last = { prompt, spec: r.stats.spec, interpretation: interp, ms: r.stats.totalMs, buildMs: r.stats.ms, tris: r.stats.tris,
      size: r.stats.size, warnings: r.stats.warnings, parts: r.stats.parts, instances: r.stats.instances, mode: viewer.mode, view: viewer.view,
      heapMB: r.stats.heapMB, workerBuilds: r.stats.builds, recycled: builder.recycled,
      deform: r.stats.deform ? { ops: r.stats.deform.ops, warnings: r.stats.deform.warnings, ms: r.stats.deform.ms, x: JSON.parse(xs) } : null };
    A.ready = true;
    mark('firstModel');
    if (reason === 'deform' && S.releaseT) { A.bakeLatencyMs = Math.round(performance.now() - S.releaseT); S.releaseT = 0; }
    // a smart stretch that waited for the element's size (a spec without the dimension, loaded from a link) runs now
    if (smart.pending && S.baseSize) requestBuild('deform');
    // the lattice was laid over another element than the one now built (first load of a link, a smart stretch): redo
    else if (S.x.ffd && (Object.keys(S.x.pins).length || Object.keys(S.x.plain).length) && infoKey !== r.stats.element.key) requestBuild('deform');
    maybeBase();
  } catch (e) {
    if (e && e.message === 'restarted') { /* superseded by a worker restart */ }
    else {
      fail(`could not build this: ${e && e.message ? e.message : e}`);
      if (viewer && !S.dragging) viewer.showPreview(false);   // never leave a preview standing in for a failed bake
    }
  } finally {
    inflight = false;
    A.busy = false;
    if (queued) build();
    else { stage.classList.remove('busy'); idleWaiters.splice(0).forEach((r) => r()); }
  }
}

let debounce = 0;
function specChanged() {
  S.edited = true;
  clearTimeout(debounce);
  debounce = setTimeout(() => { syncURL(); requestBuild(); }, 120);
}

/** Interpret a prompt and build it. Resolves when the result is on screen (or answered out of scope). */
async function submit(text, initialX = null) {
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
    announce($('#oosMsg').textContent);
    A.ready = true;              // answered (the site wrapper may drop its loader)
    if (!S.stats) showMsg('');
    return;
  }
  renderOOS(null);
  S.prompt = text; S.spec = { ...(p.spec || {}) }; S.edited = false;
  resetX(false);
  if (initialX) { S.x = initialX; $('#xform').open = !isIdentityX(); }
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

/** The readout: the built element's size, or (preview) an estimate while a transform is being dragged. */
function renderDims(estimate = null) {
  const el = $('#dims'), st = S.stats;
  if (!st) { el.textContent = ''; return; }
  const [x, y, z] = estimate || st.size, u = S.units;
  el.innerHTML = '';
  [['H', z], ['W', x], ['D', y]].forEach(([k, v], i) => {
    if (i) { const d = document.createElement('i'); d.textContent = '·'; el.append(' ', d, ' '); }
    const s = document.createElement('span'); s.textContent = k; el.append(s, (estimate ? ' ≈ ' : ' ') + fmtLen(v, u));
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
// fields without a default that still belong on the card (the generator decides when they are left on auto)
const ALWAYS = { roof: ['covering', 'material', 'overhang', 'pitch', 'dormers'], moulding: ['enrichment'], dome: ['ribs'], cupola: ['ribs'] };
let cardElement = null;

function relevant(el, spec) {
  const keys = new Set([...Object.keys(DEFAULTS[el] || {}), ...(NUMS[el] || []), ...(ALWAYS[el] || []), 'material'].filter((k) => SCHEMA[k]));
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
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.field : null;
    box.innerHTML = ''; more.innerHTML = '';
    addField(box, 'element', spec);
    for (const k of relevant(el, spec)) addField(box, k, spec);
    for (const k of ['style', 'detail', 'seed']) addField(more, k, spec);
    // the rebuilt card keeps the keyboard where it was (e.g. on the element select)
    const again = focused && document.querySelector(`#card [data-field="${focused}"]`);
    if (again) again.focus();
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
    // a field the element has no default for may stay unset: the generator decides (e.g. a roof's covering)
    const optional = k === 'style' || (k !== 'element' && !(k in (DEFAULTS[spec.element] || {})) && !['base', 'frieze', 'cornice'].includes(k));
    if (optional) ctl.append(new Option(k === 'style' ? '—' : 'auto', ''));
    for (const v of s.values) ctl.append(new Option(optLabel(k, v), v));
    ctl.addEventListener('change', () => {
      commitSmart();
      if (k === 'element') {
        // a new element starts from its own defaults; keep a material the user chose
        const keep = S.spec.material && S.edited ? { material: S.spec.material } : {};
        S.spec = { element: ctl.value, ...keep };
        S.parsed = null;
        resetX(false);
      } else S.spec[k] = ctl.value || undefined;
      specChanged();
    });
  } else if (s.type === 'bool') {
    ctl = document.createElement('input'); ctl.type = 'checkbox';
    ctl.addEventListener('change', () => { commitSmart(); S.spec[k] = ctl.checked; specChanged(); });
  } else {
    ctl = document.createElement('input'); ctl.type = 'number'; ctl.inputMode = 'decimal';
    ctl.min = isLen(k) ? round(toUnit(s.min), 2) : s.min; ctl.max = isLen(k) ? round(toUnit(s.max), 1) : s.max;
    ctl.step = s.type === 'int' ? 1 : 'any';
    ctl.placeholder = 'auto';
    ctl.addEventListener('input', () => {
      const v = parseFloat(ctl.value);
      commitSmart();
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
  else if (ctl.tagName === 'SELECT') ctl.value = v === undefined ? ([...ctl.options].some((o) => o.value === '') ? '' : ctl.value) : v;
  else {
    ctl.value = v === undefined || v === null ? '' : isLen(k) ? String(round(toUnit(v), S.units === 'ft' ? 2 : 3)) : String(v);
    if (ctl.value === '' && S.stats) ctl.placeholder = autoValue(k);
  }
}
function autoValue(k) {
  const st = S.stats;
  // a column's height is the column proper (orders.js): with a pedestal the overall size is not it
  if (k === 'height' && st.spec.pedestal && ['column', 'pilaster'].includes(st.spec.element)) return 'auto';
  // a portico's or an arch's "height" is not its overall height (columns, opening): no number to suggest
  if (k === 'height' && ['portico', 'arch', 'arcade', 'capital', 'base'].includes(st.spec.element)) return 'auto';
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
  if (viewer.needsEdges()) builder.edges(S.shown.id);
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
  renderXOutputs();
});
$('#figure').addEventListener('click', () => { if (!viewer) return; viewer.setFigure(!viewer.figureShown()); syncButtons(); });
// "fit" frames the whole element (the 3/4 view of a long run shows its near end and profile)
const fitAll = () => { if (viewer) viewer.frameAll(); };
$('#fit').addEventListener('click', fitAll);
$('#c').addEventListener('dblclick', fitAll);
// the 3D view is keyboard operable: arrows orbit, + / − zoom, F fits, 1–4 pick the views
const KEY_VIEWS = { 1: 'three-quarter', 2: 'front', 3: 'side', 4: 'top' };
$('#c').addEventListener('keydown', (e) => {
  if (!viewer || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key, step = e.shiftKey ? 2 : 1;
  if (k === 'ArrowLeft') viewer.orbit(-12 * step, 0);
  else if (k === 'ArrowRight') viewer.orbit(12 * step, 0);
  else if (k === 'ArrowUp') viewer.orbit(0, 6 * step);
  else if (k === 'ArrowDown') viewer.orbit(0, -6 * step);
  else if (k === '+' || k === '=') viewer.zoom(1 / 1.15);
  else if (k === '-' || k === '_') viewer.zoom(1.15);
  else if (k === 'f' || k === 'F' || k === '0') fitAll();
  else if (KEY_VIEWS[k]) { viewer.setView(KEY_VIEWS[k]); syncButtons(); syncURL(); }
  else return;
  e.preventDefault();
  hideHint();
});

for (const b of document.querySelectorAll('[data-export]')) b.addEventListener('click', async () => {
  if (!S.stats) return;
  const f = b.dataset.export, name = slug();
  if (f === 'json') {
    const doc = { generator: 'Arch Studio', prompt: S.prompt || null, interpretation: S.interpretation, spec: S.stats.spec,
      size_m: { x: S.stats.size[0], y: S.stats.size[1], z: S.stats.size[2] }, axes: 'Z up, metres, origin at the base centre, front faces -Y',
      ...(S.stats.deform ? { deform: S.stats.deform.ops, deform_engine: 'arch/js/deform.js (Barr 1984, Sederberg & Parry 1986, Sorkine & Alexa 2007)' } : {}),
      created: new Date().toISOString() };
    return download(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), name + '.spec.json');
  }
  const old = b.textContent;
  b.disabled = true; b.textContent = '…';
  try {
    await waitIdle();                     // export what is on screen once the running build has landed
    let r;
    try { r = await builder.exportAs(f, name, S.shown.id); }
    catch (e) {
      if (e.code !== 'stale' && e.message !== 'restarted' && e.message !== 'timeout') throw e;
      // the worker no longer holds the model on screen (it was recycled): rebuild the same spec quietly, once
      const rb = await builder.build(S.shown.input, false);
      S.shown = { ...S.shown, id: rb.id };  // the same geometry: edges and exports now refer to this build
      r = await builder.exportAs(f, name, rb.id);
    }
    download(new Blob(r.buffers, { type: r.mime }), `${name}.${f}`);
  } catch (e) {
    toast(`The ${f.toUpperCase()} export failed: ${e.message}`);
    console.error('[arch] export failed', e);
  } finally { b.disabled = false; b.textContent = old; b.focus(); }
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

// ------------------------------------------------------------------------------------------------ transform panel
//
// Deformations after the element is built (deform.js). Stretch with "keep ornament" is first a re-parameterisation
// (smartStretch: a longer balustrade gets more balusters, a taller column a larger diameter); where the element has no
// parameter for that axis it falls back to a free "nine-slice" stretch that keeps capitals and bases. Then, in this
// order: taper, twist, bow (bend of the height), lean (shear), plan bend (curve along X), free-form (FFD lattice whose
// dragged points move their neighbours as rigidly as possible). While a slider or a handle moves, the viewer deforms the
// undeformed element on the GPU with the same maps (view.js); on release the worker bakes the exact, refined,
// watertight result (deformParts), which is what the downloads contain.

const XDEF = { sx: 1, sy: 1, sz: 1, keep: true, bend: 0, bow: 0, twist: 0, taper: 1, lx: 0, ly: 0, rigid: true, ffd: false, dims: 3, pins: {}, plain: {} };
S.x = structuredClone(XDEF);
S.applied = { sx: 1, sy: 1, sz: 1 };
const STRETCH = [['x', 'sx'], ['y', 'sy'], ['z', 'sz']];

/** S.spec with the stretches that are re-parameterisations applied; the rest (free stretches) as [axis, factor]. */
function smartInput() {
  const base = clean(S.spec);
  // read current values from the element as normalised (a dome's default diameter 8 m, not its bbox with the drum's
  // cornice), but write only the stretched field into the request (the rest stays "not stated")
  const full = S.baseNorm && S.baseNorm.element === base.element ? { ...S.baseNorm, ...base } : base;
  delete full.given;
  let spec = base;
  const free = [], applied = { sx: 1, sy: 1, sz: 1 }, used = new Set();
  let pending = false, changed = false;
  for (const [axis, k] of STRETCH) {
    const f = S.x[k];
    if (Math.abs(f - 1) < 1e-9) continue;
    let next = null;
    if (S.x.keep && base.element) {
      next = smartStretch(full, axis, f, S.baseSize);
      // the dimension is the generator's choice and the element's size is not known yet: stretch freely for now
      if (!next && !S.baseSize && smartStretch(full, axis, f, [1, 1, 1])) pending = true;
    }
    // the fields this axis re-parameterises; two axes on one field (a dome's diameter in x and y) do not compound:
    // the second stretches freely (a dome stretched in x and then y becomes elliptical, honestly)
    const fields = next ? Object.keys(next).filter((key) => key !== 'given' && JSON.stringify(next[key]) !== JSON.stringify(full[key])) : [];
    if (next && fields.length && !fields.some((key) => used.has(key))) {
      fields.forEach((key) => used.add(key));
      spec = { ...spec, ...Object.fromEntries(fields.map((key) => [key, next[key]])) };
      applied[k] = f; changed = true;
    } else if (next && !fields.length) {
      applied[k] = f;               // a count that rounds back (e.g. columns): nothing to change, nothing to stretch
    } else free.push([axis, f]);
  }
  return { spec: clean(spec), free, applied, pending, changed };
}

const isIdentityX = (x = S.x) => STRETCH.every(([, k]) => x[k] === 1) && !x.bend && !x.bow && !x.twist && x.taper === 1 && !x.lx && !x.ly
  && !(x.ffd && (Object.keys(x.pins).length || Object.keys(x.plain).length));

/** The free ops for the worker (or the preview), in the panel's order. free: [[axis, factor]] stretches. */
function deformOps(free, info = S.element) {
  const x = S.x, ops = [];
  for (const [axis, f] of free) ops.push(x.keep ? { type: 'stretch', axis, factor: f } : { type: 'stretch', axis, factor: f, keep: [0, 1] });
  if (x.taper !== 1) ops.push({ type: 'taper', axis: 'z', scale: x.taper });
  if (x.twist) ops.push({ type: 'twist', axis: 'z', angle: x.twist });
  if (x.bow) ops.push({ type: 'bend', axis: 'z', angle: x.bow });
  // lean in % of the element's height: the worker (and resolved() here) turn it into metres for the element it deforms
  if (x.lx || x.ly) ops.push({ type: 'shear', axis: 'z', lean: [x.lx / 100, x.ly / 100] });
  if (x.bend) ops.push({ type: 'bend', axis: 'x', angle: x.bend });
  if (x.ffd && info && (Object.keys(x.pins).length || Object.keys(x.plain).length)) {
    const lat = latticeFor(ops, info);
    ops.push({ type: 'ffd', dims: lat.dims, offsets: Array.from(lat.offsets, (v) => Math.round(v * 1e6) / 1e6) });
  }
  return ops;
}

/** resolveOps on the page: the worker sends the shaft's box, which is all resolveOps reads of the parts. */
function resolved(ops, info = S.element) {
  const H = info.bbox.max[2] - info.bbox.min[2];
  ops = ops.map((o) => (o.lean ? { type: o.type, axis: o.axis, dx: o.lean[0] * H, dy: o.lean[1] * H } : o));
  const stubs = info.shaftBox ? [{ name: 'shaft', manifold: { numTri: () => 1, boundingBox: () => info.shaftBox }, transforms: null }] : [];
  return resolveOps(ops, stubs, info.bbox);
}

/** The FFD lattice for the ops before it: rest points over their output frame, offsets from the dragged points
 *  (ARAP for normal drags, exact for shift-drags). */
function latticeFor(before, info) {
  const d = S.x.dims, dims = [d, d, d];
  const F = makeDeformer(resolved(before, info), info.bbox).bboxOut;
  const lat = ffdLattice(dims, F);
  const offsets = Object.keys(S.x.pins).length ? arapLattice(dims, S.x.pins, 10, { rest: lat.rest }) : new Float64Array(3 * lat.count);
  for (const [i, t] of Object.entries(S.x.plain)) for (let a = 0; a < 3; a++) offsets[3 * i + a] = t[a] - lat.rest[3 * i + a];
  return { dims, lat, offsets };
}

/** Make the card's values the element's own: the smart stretches become the spec, their sliders return to 1. */
function commitSmart() {
  const sm = smartInput();
  if (!sm.changed) return;
  S.spec = { ...sm.spec };
  for (const [, k] of STRETCH) if (sm.applied[k] !== 1) S.x[k] = 1;
  S.applied = { sx: 1, sy: 1, sz: 1 };
  S.baseSize = null; S.baseNorm = null;
  renderX(); syncURL();
}

/** A new element: everything back to the defaults (render: also redraw the panel). */
function resetX(render = true) {
  const keep = S.x.keep, rigid = S.x.rigid;
  S.x = structuredClone(XDEF);
  S.x.keep = keep; S.x.rigid = rigid;
  S.applied = { sx: 1, sy: 1, sz: 1 };
  S.baseSize = null; S.baseNorm = null;
  if (viewer) { viewer.setLattice(null); viewer.showPreview(false); }
  if (render) renderX();
}

// ---- GPU preview

/** The ops to preview on the element as built: every stretch runs as a free one relative to what the element already
 *  has (a smart stretch is re-parameterised only by the bake on release, which regenerates the element). */
function previewOps() {
  const free = [];
  for (const [axis, k] of STRETCH) {
    const rel = S.x[k] / (S.applied[k] || 1);
    if (Math.abs(rel - 1) > 1e-9) free.push([axis, rel]);
  }
  return deformOps(free);
}

let previewRAF = 0, foldT = 0, baseFor = null;
const previewKey = () => (S.element ? `${S.element.key}|${S.x.rigid}` : null);
function schedulePreview() { if (!previewRAF) previewRAF = requestAnimationFrame(() => { previewRAF = 0; doPreview(); }); }

function doPreview() {
  if (!viewer || !S.element) return;
  maybeBase(true);
  const info = S.element, t0 = performance.now();
  const ops = resolved(previewOps(), info), D = makeDeformer(ops, info.bbox);
  // the deformed box and the re-grounding, from a sample of the element's own vertices (the image of its bbox would
  // overstate a twist: the corners of a twisted square box reach further than any stone)
  const est = D.identity ? { min: info.bbox.min.slice(), max: info.bbox.max.slice() } : sampleBox(D) || D.bboxOut;
  const ground = D.identity ? 0 : info.bbox.min[2] - est.min[2];
  const box = { min: [est.min[0], est.min[1], est.min[2] + ground], max: [est.max[0], est.max[1], est.max[2] + ground] };
  const gpu = viewer.hasPreview(previewKey()) && viewer.previewDeform(ops, D, ground, box);
  A.preview = { gpu, ms: +(performance.now() - t0).toFixed(1), ops: ops.length };
  if (!gpu) requestBuild('deform');            // no preview geometry yet: the worker bakes, latest request only
  drawLattice(ops, D, ground);
  renderDims(box.max.map((v, a) => v - box.min[a]));
  // live fold warning (a grid of Jacobians, a few ms), at most every 150 ms
  if (performance.now() - foldT > 150) {
    foldT = performance.now();
    const fc = D.identity ? { folds: 0 } : foldCheck(D, info.bbox, 6);
    $('#xwarn').textContent = fc.folds ? 'The shape folds through itself at this setting.' : warnText(S.stats && S.stats.deform);
  }
  renderXOutputs();
}

/** Bbox of about 2500 vertices of the preview geometry (or the meshes on screen) mapped through D. */
function sampleBox(D) {
  const meshes = (viewer.preview && viewer.preview.meshes) || (S.plainMeshes && S.plainMeshes.key === S.element.key && S.plainMeshes.meshes);
  if (!meshes) return null;
  let total = 0;
  for (const m of meshes) total += (m.positions.length / 3) * Math.min(m.transforms ? m.transforms.length / 16 : 1, 32);
  const stride = Math.max(1, Math.floor(total / 2500));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], p = [0, 0, 0];
  for (const m of meshes) {
    const P = m.positions, T = m.transforms, n = T ? T.length / 16 : 1, step = Math.max(1, Math.floor(n / 32));
    for (let k = 0; k < n; k += step) {
      const M = T ? T.subarray(16 * k, 16 * k + 16) : null;
      for (let i = 0; i < P.length; i += 3 * stride) {
        const x = P[i], y = P[i + 1], z = P[i + 2];
        if (M) { p[0] = M[0] * x + M[4] * y + M[8] * z + M[12]; p[1] = M[1] * x + M[5] * y + M[9] * z + M[13]; p[2] = M[2] * x + M[6] * y + M[10] * z + M[14]; }
        else { p[0] = x; p[1] = y; p[2] = z; }
        const q = D.point(p);
        for (let a = 0; a < 3; a++) { if (q[a] < min[a]) min[a] = q[a]; if (q[a] > max[a]) max[a] = q[a]; }
      }
    }
  }
  return min[0] < Infinity ? { min, max } : null;
}

/** Lattice handles (when free-form is on): the FFD op's control points as moved, else its rest grid over the shape. */
let latticeGround = 0;
function drawLattice(ops, D, ground) {
  if (!viewer) return;
  if (!S.x.ffd || !S.element) { viewer.setLattice(null); return; }
  let pts, dims;
  const k = D.compiled.findIndex((c) => c.type === 'ffd');
  if (k >= 0) {
    const c = D.compiled[k];
    dims = c.lattice.dims;
    pts = Float64Array.from(c.lattice.rest, (v, i) => v + c.offsets[i]);
  } else {
    const d = S.x.dims;
    dims = [d, d, d];
    pts = Float64Array.from(ffdLattice(dims, D.bboxOut).rest);
  }
  latticeGround = ground;
  for (let i = 2; i < pts.length; i += 3) pts[i] += ground;
  viewer.setLattice(pts, dims, [...Object.keys(S.x.pins), ...Object.keys(S.x.plain)].map(Number));
}

/** Ask the worker for the refined undeformed element (once per element and rigid setting); until it arrives the
 *  undeformed meshes on screen stand in, when there are some. */
function maybeBase(now = false) {
  if (!viewer || !S.element) return;
  const key = previewKey();
  if (viewer.hasPreview(key) && !(viewer.preview.interim && now)) return;
  if (!$('#xform').open && isIdentityX() && !now) return;
  if (!viewer.hasPreview(key) && S.plainMeshes && S.plainMeshes.key === S.element.key) {
    viewer.setPreviewBase(key, interimBase(S.plainMeshes.meshes, S.element.bbox));
    viewer.preview.interim = true;
  }
  if (baseFor === key) return;
  baseFor = key;
  const spec = S.shown.input;
  builder.base(spec, { rigidInstances: S.x.rigid }).then((b) => {
    if (previewKey() !== key) return;
    viewer.setPreviewBase(key, b.meshes);
    A.previewBase = { tris: b.tris, ms: Math.round(b.ms), edge: b.edge };
    if (viewer.previewing || S.dragging) doPreview();
  }, (e) => { baseFor = null; console.warn('[arch] preview geometry unavailable:', e.message); });
}

/** The undeformed meshes on screen as a preview base: rigid parts flagged by deformParts' rule. */
function interimBase(meshes, bbox) {
  const diag = Math.hypot(...[0, 1, 2].map((k) => bbox.max[k] - bbox.min[k]));
  return meshes.map((m) => {
    const P = m.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { if (P[i + a] < lo[a]) lo[a] = P[i + a]; if (P[i + a] > hi[a]) hi[a] = P[i + a]; }
    const T = m.transforms, n = T ? T.length / 16 : 1;
    const sc = T ? Math.max(Math.hypot(T[0], T[1], T[2]), Math.hypot(T[4], T[5], T[6]), Math.hypot(T[8], T[9], T[10])) : 1;
    const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * sc;
    const rigid = !!(S.x.rigid && T && n >= 2 && P.length && size < 0.25 * diag);
    return { ...m, rigid, centre: [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2) };
  });
}

// ---- panel

const WARN = {
  fold: 'The shape folds through itself at this setting.', overlap: 'The ends of the bend meet or pass each other.',
  'refine-capped': 'Refinement was limited by the triangle budget; tight curves may show facets.',
};
function warnText(d) {
  if (!d || !d.warnings || !d.warnings.length) return '';
  return d.warnings.map((w) => WARN[w] || (w.startsWith('not-manifold:') ? `${w.slice(13)} is not watertight after the deformation.` : w)).join(' ');
}

const fmtM = (m) => (S.units === 'ft' ? fmtLen(m, 'ft') : `${m.toFixed(2)} m`);
function renderXOutputs() {
  const x = S.x, info = S.element;
  const extent = (axis, k) => {
    if (!info) return '';
    const ai = { x: 0, y: 1, z: 2 }[axis];
    // after a bake for exactly these sliders: the measured extent; while dragging: the prediction
    if (S.builtX === JSON.stringify(S.x) && S.stats) return fmtM(S.stats.size[ai]);
    const base = S.baseSize ? S.baseSize[ai] : info.size[ai] / (S.applied[k] || 1);
    return fmtM(base * x[k]);
  };
  for (const [axis, k] of STRETCH) {
    const o = $('#o-' + k);
    o.textContent = x[k] === 1 ? '—' : `${x[k].toFixed(2)}× · ${extent(axis, k)}`;
    o.classList.toggle('off', x[k] === 1);
  }
  const deg = (v) => `${v > 0 ? '' : v < 0 ? '−' : ''}${Math.abs(v)}°`;
  $('#o-bend').textContent = x.bend ? deg(x.bend) : '—';
  $('#o-bow').textContent = x.bow ? deg(x.bow) : '—';
  $('#o-twist').textContent = x.twist ? deg(x.twist) : '—';
  $('#o-taper').textContent = x.taper === 1 ? '—' : `${x.taper.toFixed(2)}×`;
  const H = info ? info.size[2] : 0;
  $('#o-lx').textContent = x.lx ? `${x.lx}% · ${fmtM(Math.abs(x.lx) / 100 * H)}` : '—';
  $('#o-ly').textContent = x.ly ? `${x.ly}% · ${fmtM(Math.abs(x.ly) / 100 * H)}` : '—';
  for (const id of ['bend', 'bow', 'twist', 'taper', 'lx', 'ly']) $('#o-' + id).classList.toggle('off', $('#o-' + id).textContent === '—');
  // the track is filled from the neutral value (1x, 0°) to the setting, so a bend left reads as left of neutral
  for (const el of document.querySelectorAll('#xform input[type=range]')) {
    const span = el.max - el.min, v = (el.value - el.min) / span, n = (XDEF[el.dataset.x] - el.min) / span;
    el.style.setProperty('--lo', `${(100 * Math.min(v, n)).toFixed(1)}%`);
    el.style.setProperty('--hi', `${(100 * Math.max(v, n)).toFixed(1)}%`);
  }
}

/** Panel from state (after a build, a reset, a URL). */
function renderX() {
  const x = S.x;
  for (const el of document.querySelectorAll('#xform [data-x]')) el.value = x[el.dataset.x];
  $('#x-keep').checked = x.keep; $('#x-rigid').checked = x.rigid; $('#x-ffd').checked = x.ffd; $('#x-dims').value = String(x.dims);
  $('#x-dims').disabled = !x.ffd;
  $('#xnote').textContent = isIdentityX() ? '' : 'on';
  const d = S.stats && S.stats.deform;
  $('#xwarn').textContent = warnText(d);
  $('#xinfo').textContent = d ? `exact bake ${Math.round(d.ms)} ms · ${(S.stats.tris / 1000).toFixed(0)}k triangles${A.preview ? ` · preview ${A.preview.gpu ? 'on the GPU' : 'from the worker'}` : ''}` : '';
  renderXOutputs();
  if (viewer && S.element) {
    if (x.ffd) { const ops = resolved(previewOps()), D = makeDeformer(ops, S.element.bbox); drawLattice(ops, D, d ? d.ground || 0 : 0); }
    else viewer.setLattice(null);
  }
}

// slider: input = live preview, change (release, or a key step) = exact bake
for (const el of document.querySelectorAll('#xform [data-x]')) {
  el.addEventListener('pointerdown', () => { S.dragging = true; });
  el.addEventListener('input', () => {
    S.x[el.dataset.x] = +el.value;
    $('#xnote').textContent = isIdentityX() ? '' : 'on';
    schedulePreview();
  });
  el.addEventListener('change', () => {
    S.dragging = false;
    S.releaseT = performance.now();
    S.x[el.dataset.x] = +el.value;
    syncURL();
    requestBuild('deform');
  });
  // double-click the label: back to neutral
  const lab = el.parentElement.querySelector('label');
  if (lab) lab.addEventListener('dblclick', () => { el.value = XDEF[el.dataset.x]; S.x[el.dataset.x] = XDEF[el.dataset.x]; syncURL(); renderX(); requestBuild('deform'); });
}
window.addEventListener('pointerup', () => { if (S.dragging && !(viewer && viewer.drag)) S.dragging = false; });
$('#x-keep').addEventListener('change', (e) => { S.x.keep = e.target.checked; syncURL(); requestBuild('deform'); renderX(); });
$('#x-rigid').addEventListener('change', (e) => { S.x.rigid = e.target.checked; syncURL(); requestBuild('deform'); maybeBase(); });
$('#x-ffd').addEventListener('change', (e) => {
  S.x.ffd = e.target.checked; syncURL(); renderX();
  if (viewer && S.x.ffd && !viewer.fits(0.96)) viewer.frameAll();   // every control point in view
  if (!isIdentityX()) requestBuild('deform');
});
$('#x-dims').addEventListener('change', (e) => { S.x.dims = +e.target.value; S.x.pins = {}; S.x.plain = {}; syncURL(); renderX(); requestBuild('deform'); });
$('#x-reset').addEventListener('click', () => { const was = !isIdentityX(); resetX(); syncURL(); if (was) requestBuild('deform'); });
$('#xform').addEventListener('toggle', () => { if ($('#xform').open) { maybeBase(); renderX(); } else if (viewer) viewer.setLattice(null); });

// lattice handles: drag = ARAP (neighbours follow), shift-drag = that point only
viewerReady.then((v) => v.enableHandles({
  down: () => { S.dragging = true; },
  move: (i, q, shift) => {
    const t = [q[0], q[1], q[2] - latticeGround].map((a) => Math.round(a * 1e4) / 1e4);
    if (shift) { S.x.plain[i] = t; delete S.x.pins[i]; } else { S.x.pins[i] = t; delete S.x.plain[i]; }
    schedulePreview();
  },
  up: () => { S.dragging = false; S.releaseT = performance.now(); syncURL(); requestBuild('deform'); },
})).catch(() => {});

// ---- the deformation in the URL: compact JSON, base64url
function encodeX() {
  const x = S.x, o = {}, r3 = (v) => v.map((a) => Math.round(a * 1e4) / 1e4);
  if (STRETCH.some(([, k]) => x[k] !== 1)) o.s = STRETCH.map(([, k]) => x[k]);
  if (!x.keep) o.k = 0;
  if (x.bend) o.b = x.bend;
  if (x.bow) o.w = x.bow;
  if (x.twist) o.t = x.twist;
  if (x.taper !== 1) o.p = x.taper;
  if (x.lx || x.ly) o.l = [x.lx, x.ly];
  if (!x.rigid) o.r = 0;
  if (x.ffd) {
    o.f = { d: x.dims };
    if (Object.keys(x.pins).length) o.f.p = Object.fromEntries(Object.entries(x.pins).map(([i, t]) => [i, r3(t)]));
    if (Object.keys(x.plain).length) o.f.m = Object.fromEntries(Object.entries(x.plain).map(([i, t]) => [i, r3(t)]));
  }
  if (!Object.keys(o).length) return '';
  return btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeX(str) {
  try {
    const o = JSON.parse(atob(str.replace(/-/g, '+').replace(/_/g, '/')));
    const x = structuredClone(XDEF), num = (v, a, b, d) => (Number.isFinite(+v) ? Math.min(b, Math.max(a, +v)) : d);
    if (Array.isArray(o.s)) STRETCH.forEach(([, k], i) => { x[k] = num(o.s[i], 0.5, 2, 1); });
    if (o.k === 0) x.keep = false;
    x.bend = num(o.b, -180, 180, 0); x.bow = num(o.w, -45, 45, 0); x.twist = num(o.t, -360, 360, 0); x.taper = num(o.p, 0.3, 1.5, 1);
    if (Array.isArray(o.l)) { x.lx = num(o.l[0], -25, 25, 0); x.ly = num(o.l[1], -25, 25, 0); }
    if (o.r === 0) x.rigid = false;
    if (o.f) {
      x.ffd = true; x.dims = o.f.d === 4 ? 4 : 3;
      const pts = (m) => Object.fromEntries(Object.entries(m || {}).filter(([i, t]) => /^\d+$/.test(i) && Array.isArray(t) && t.length === 3 && t.every(Number.isFinite)));
      x.pins = pts(o.f.p); x.plain = pts(o.f.m);
    }
    return x;
  } catch (e) { console.warn('[arch] ?deform= ignored:', e.message); return null; }
}

// ------------------------------------------------------------------------------------------------ URL

function syncURL() {
  const q = new URLSearchParams(location.search);
  if (S.prompt) q.set('q', S.prompt); else q.delete('q');
  if (S.edited) q.set('spec', JSON.stringify(clean(S.spec))); else q.delete('spec');
  const xd = encodeX();
  if (xd) q.set('deform', xd); else q.delete('deform');
  if (viewer && viewer.mode !== 'stone') q.set('mode', viewer.mode); else q.delete('mode');
  if (viewer && viewer.view !== 'three-quarter') q.set('view', viewer.view); else q.delete('view');
  const s = q.toString().replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%2F/g, '/');
  try { history.replaceState(null, '', s ? '?' + s : location.pathname); } catch (e) { /* sandboxed */ }
}

// ------------------------------------------------------------------------------------------------ start

(async () => {
  const specQ = Q.get('spec'), q = Q.get('q'), xq = Q.get('deform') ? decodeX(Q.get('deform')) : null;
  if (specQ) {
    let spec = null;
    try { spec = JSON.parse(specQ); } catch (e) { fail('?spec= is not valid JSON'); }
    if (spec) {
      await describeLoaded;
      S.prompt = q || ''; S.spec = spec; S.edited = true; S.parsed = null;
      if (xq) { S.x = xq; $('#xform').open = !isIdentityX(); }
      $('#prompt').value = S.prompt;
      renderX();
      requestBuild();
      return;
    }
  }
  submit(q || DEFAULT_PROMPT, xq);
})();
