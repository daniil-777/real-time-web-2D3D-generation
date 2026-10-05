// Arch Studio app: prompt -> parse() -> spec -> build worker (Manifold) -> viewer (three.js), plus the spec card,
// examples, exports, the A3 drawing sheet, the transform panel, the idle showcase and the URL. Exposes
// window.__arch = { ready, errors, busy, last, run, drawing, showcase } for the site and tests.
//
// URL: ?q=<prompt>  ?spec=<json> (bypasses the parser; q is then only shown)  &deform=<transform>  &mode=stone|white|line
//      &view=three-quarter|front|side|top  &shot=1 (canvas only)  &embed=1 (inside the site: the showcase runs at once)
//      &showcase=1 (run the idle showcase now, and again after 12 s idle) | 0 (never)

import { SCHEMA, DEFAULTS, ELEMENTS, MATERIALS } from './spec.js';
import { ORDERS } from './orders.js';
import { PBR, isRigidPart, frameScale, RIGID_RATIO } from './export.js';
import { smartStretch, makeDeformer, resolveOps, arapLattice, ffdLattice, foldCheck, polar3 } from './deform.js';

const A = window.__arch = { ready: false, errors: [], busy: false, last: null, backend: 'webgl', timing: {} };
const mark = (k) => { if (A.timing[k] === undefined) A.timing[k] = Math.round(performance.now()); };   // ms since navigation
mark('appStart');
const $ = (s) => document.querySelector(s);
const Q = new URLSearchParams(location.search);
const SHOT = Q.get('shot') === '1';
const EMBED = Q.get('embed') === '1';

// ------------------------------------------------------------------------------------------------ build worker

// The worker is recycled (terminated, a fresh one with a fresh Manifold instance spawned) before the next build once
// its WASM heap passes HEAP_LIMIT_MB or it has served MAX_BUILDS builds (WASM memory never shrinks and generators leave
// temporaries behind), after an error of the kernel itself (abort, out of bounds, unreachable…: the build is retried
// once on the fresh worker), and by a watchdog when a build, the preview geometry, an export or a drawing does not answer
// within its time limit (that request is reported as what hung; a build caught in the restart is sent again).
const HEAP_LIMIT_MB = 512, MAX_BUILDS = 25, BUILD_TIMEOUT_MS = 45000, EXPORT_TIMEOUT_MS = 90000;
// what the watchdog says of the request that hung, by its type
const HUNG = { build: 'building this', base: 'preparing the live preview', export: 'exporting', drawing: 'drawing the sheet' };

class Builder {
  constructor(onFatal, onEdges) {
    this.onFatal = onFatal; this.onEdges = onEdges;
    this.seq = 0; this.pending = new Map(); this.heap = 0; this.builds = 0; this.recycled = 0; this.sick = false;
    this.buildTimeout = BUILD_TIMEOUT_MS; this.exportTimeout = EXPORT_TIMEOUT_MS;
    this.spawn();
  }
  spawn() {
    mark('workerSpawn');
    // the page's head started a worker already (index.html): adopt it and replay what it said meanwhile
    const pre = !this.recycled && window.__archWorker;
    window.__archWorker = null;
    this.w = pre ? pre.w : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.ready = new Promise((res, rej) => { this.ok = res; this.fail = rej; });
    this.ready.catch(() => {});
    this.w.onmessage = (e) => this.message(e.data);
    this.w.onerror = (e) => this.fatal('the build worker failed to start' + (e && e.message ? ': ' + e.message : ''));
    if (pre) { A.timing.preSpawned = true; for (const m of pre.early.splice(0)) this.message(m); }
  }
  fatal(msg) { this.fail(new Error(msg)); this.rejectAll(msg); this.onFatal(msg); }
  /** Reject every pending request. After a watchdog restart the request that hung is told so in its own words (code
   *  'timeout'); the others were only caught in the restart ('restarted', code 'collateral': a build retries itself). */
  rejectAll(msg, hung = 0) {
    for (const [id, p] of this.pending) {
      p.reject(id === hung ? Object.assign(new Error(`${HUNG[p.type] || 'this request'} took longer than ${Math.round(p.ms / 1000)} s; the CAD kernel was restarted`), { code: 'timeout' })
        : Object.assign(new Error(hung ? 'restarted' : msg), hung ? { code: 'collateral' } : {}));
    }
    this.pending.clear();
  }
  message(m) {
    if (m.type === 'ready') {
      this.heap = m.heapMB; mark('kernel');
      if (m.boot && !A.timing.boot) A.timing.boot = Object.fromEntries(Object.entries(m.boot).map(([k, v]) => [k, Math.round(v - performance.timeOrigin)]));
      this.ok(); return;
    }
    if (m.type === 'warmed') { if (!A.timing.warm) A.timing.warm = { element: m.element, ms: Math.round(m.ms), at: Math.round((m.at || 0) - performance.timeOrigin) }; return; }
    if (m.type === 'fatal') { this.fatal(m.message); return; }
    if (m.type === 'edges') { this.onEdges(m.id, m.edges); return; }
    if (m.type === 'error' && m.heapMB !== undefined) { this.heap = m.heapMB; this.builds = m.builds; }
    const p = this.pending.get(m.id);
    if (!p) { if (m.type === 'error') console.warn('[arch]', m.message); return; }
    this.pending.delete(m.id);
    if (m.type === 'error') { const e = new Error(m.message); e.code = m.code; e.detail = m.stack; p.reject(e); } else p.resolve(m);
  }
  /** Post a request; with a time limit the worker is recycled (and the request rejected, code 'timeout') if it hangs. */
  call(msg, timeoutMs = 0) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = timeoutMs ? setTimeout(() => { if (this.pending.has(id)) this.recycle('timeout', id); }, timeoutMs) : 0;
      this.pending.set(id, { type: msg.type, ms: timeoutMs, resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.w.postMessage({ ...msg, id });
    });
  }
  recycle(reason = 'restarted', hung = 0) {
    this.w.terminate();
    this.rejectAll(reason, hung);
    this.heap = 0; this.builds = 0; this.sick = false; this.recycled++;
    this.spawn();
  }
  /** Build spec (and deform it by ops when given: { ops, deformOpts }). */
  async build(spec, edges, deform = null, retry = true) {
    if ((this.sick || this.heap > HEAP_LIMIT_MB || this.builds >= MAX_BUILDS) && this.pending.size === 0) this.recycle();
    await this.ready;
    try {
      mark('firstBuildSent');
      const m = await this.call({ type: 'build', spec, edges, sentAt: performance.timeOrigin + performance.now(),
        ...(deform || {}) }, this.buildTimeout);
      if (!A.timing.firstBuild) {
        const t = m.stats;
        A.timing.firstBuild = { back: Math.round(performance.now()), queueMs: Math.round(t.workerStart || 0), importMs: Math.round(t.importMs || 0),
          genMs: Math.round(t.genMs || 0), buildMs: Math.round(t.ms || 0), meshMs: Math.round(t.meshMs || 0), totalMs: Math.round(t.totalMs || 0) };
      }
      this.heap = m.stats.heapMB || 0;
      this.builds = m.stats.builds || this.builds + 1;
      return m;
    } catch (e) {
      // another request hung and the worker was restarted under this build: build it again on the fresh one
      if (e.code === 'collateral' && retry) return this.build(spec, edges, deform, false);
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
  /** The A3 drawing sheet of the model on screen (worker.js drawing(), drawing.js makeSheet()). */
  async drawing(forId, meta) { await this.ready; return this.call({ type: 'drawing', forId, meta }, this.exportTimeout); }
}

// ------------------------------------------------------------------------------------------------ parser (+ fallback)

let parseFn = null, describeFn = null;
const parserLoaded = import('./parse.js').then((m) => { parseFn = m.parse; mark('parser'); }, () => { console.info('[arch] parse.js not found: keyword fallback'); });
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
// the first impression when nobody typed anything: rich in detail, by turns a copper dome on a drum with a lantern
// and a Corinthian tetrastyle portico (index.html picks this visit's one, so its generator is warm before app.js runs)
const DEFAULT_PROMPT = window.__archDefault || 'Copper dome with drum and lantern';

const S = {
  prompt: '', spec: {}, parsed: null, edited: false, units: 'm',
  stats: null, interpretation: '',
  shown: { id: 0, input: null },   // the build on screen: its worker id and the spec it was built from
};
let edgeStash = null;             // feature edges that arrived before their build was on screen
// the idle showcase's state (see the end of this file)
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const SC = { on: false, paused: false, gen: 0, i: 0, timer: 0, idleT: 0, typeT: 0, engaged: false,
  forced: Q.get('showcase') === '1',
  allowed: Q.get('showcase') === '1' || (!SHOT && Q.get('showcase') !== '0' && !Q.get('q') && !Q.get('spec') && !Q.get('deform')) };
A.showcase = { running: false, index: -1, phase: '', shown: [] };


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
const announce = (text) => { if (!SC.on) $('#sr').textContent = text; };   // the showcase speaks once, not every example

const builder = new Builder((m) => { fail(m); A.busy = false; stage.classList.remove('busy'); },
  (id, list) => {
    if (viewer && id === S.shown.id) viewer.setEdges(list);
    else edgeStash = { id, list };
  });

Object.defineProperty(A, 'builder', { value: builder, enumerable: false }); // tests
Object.defineProperty(A, 'state', { value: S, enumerable: false });

/** The bands of the canvas its overlays cover (CSS px from each edge): the viewer frames the element clear of them. On a
 *  phone the rendering bar and the size pill fill the top of a low stage, the view and unit bars its foot. */
function overlayInsets() {
  const c = $('#c').getBoundingClientRect(), ins = { top: 0, bottom: 0, left: 0, right: 0 };
  if (!c.height) return ins;
  for (const el of document.querySelectorAll('#stage > .ov')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;                 // hidden (screenshots), or the size pill before the first build
    if (r.top + r.bottom < c.top + c.bottom) ins.top = Math.max(ins.top, r.bottom - c.top);
    else ins.bottom = Math.max(ins.bottom, c.bottom - r.top);
  }
  return ins;
}

let viewer = null;
const viewerReady = (async () => {
  const { Viewer, VIEWS, MODES } = await import('./view.js');
  const bg = getComputedStyle(stage).backgroundColor.match(/[\d.]+/g).slice(0, 3).map((x) => +x / 255);
  viewer = new Viewer($('#c'), { shot: SHOT, background: bg, pixelRatio: SHOT ? 2 : undefined, insets: overlayInsets });
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
  // a deformation request that asks for exactly what is being built already, or what is on screen (a release seen
  // twice: a lost focus, then the range's change), is not built again; a preview left standing gives way to the model
  if (reason === 'deform' && !queued && (inflight || shownKey) && buildKey() === (inflight ? inflightKey : shownKey)) {
    if (!inflight && viewer && viewer.previewing && !dragging()) viewer.showPreview(false);
    return;
  }
  if (reason) S.buildReason = reason;
  if (inflight) { queued = true; return; }
  build();
}
/** What a build would ask the worker for now: the spec and the deformation ops. */
function buildKey() { const smart = smartInput(), ops = deformOps(smart.free); return JSON.stringify({ spec: smart.spec, ops, rigid: ops.length ? S.x.rigid : null }); }
let inflightKey = null, shownKey = null;
const waitIdle = () => (inflight ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve());

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

async function build() {
  inflight = true; queued = false;
  const smart = smartInput(), spec = smart.spec, ops = deformOps(smart.free), infoKey = S.element ? S.element.key : null;
  const prompt = S.prompt, parsed = S.parsed, edited = S.edited, xs = JSON.stringify(S.x), reason = S.buildReason;
  inflightKey = JSON.stringify({ spec, ops, rigid: ops.length ? S.x.rigid : null });
  S.buildReason = null;
  A.busy = true; stage.classList.add('busy');
  try {
    const deform = ops.length ? { ops, deformOpts: { rigidInstances: S.x.rigid } } : null;
    // the worker builds while three.js and the viewer are still loading (first load): send first, then wait for both
    const line = viewer ? viewer.mode === 'line' : Q.get('mode') === 'line';
    const pending = builder.build(spec, line, deform);
    pending.catch(() => {});              // handled below; a failed viewer must not leave it unobserved
    await viewerReady;
    const r = await pending;
    // a newer request is waiting: do not spend a frame on this one (unless nothing has been shown for a while)
    if (queued && performance.now() - lastShown < 800) return;
    const reveal = S.reveal && !dragging();
    S.reveal = false;
    // the size pill first: framing the new element keeps it clear of the overlays, the pill among them
    const dimsNow = !dragging();
    if (dimsNow) renderDims(null, r.stats);
    if (reveal) viewer.beginReveal();
    await viewer.setModel(r.meshes, r.stats, { keepCamera: reason === 'deform' && S.stats && S.stats.spec.element === r.stats.spec.element,
      keepPreview: dragging() });
    if (reveal && SC.on) viewer.reveal(1100);
    else if (reveal) viewer.endReveal();            // the showcase was stopped while this model was being shown
    lastShown = performance.now();
    S.shown = { id: r.id, input: spec, deform };
    shownKey = inflightKey;
    S.stats = r.stats;
    S.element = r.stats.element;
    S.applied = smart.applied;
    S.builtX = xs;
    if (!ops.length) S.plainMeshes = { key: r.stats.element.key, meshes: r.meshes };
    if (JSON.stringify(spec) === JSON.stringify(clean(S.spec))) { S.baseSize = r.stats.element.size; S.baseNorm = r.stats.spec; }
    if (edgeStash && edgeStash.id === r.id) viewer.setEdges(edgeStash.list);
    else if (viewer.needsEdges()) builder.edges(r.id);
    edgeStash = null;
    // the line tells the model as built (the worker's spec carries what the generator decided, e.g. a Gothic window's
    // pointed head and no pediment), not the parser's reading of the request; the parser's line stays for a fallback
    const interp = describeFn || !parsed || !parsed.interpretation || edited || smart.changed ? describeSpec(r.stats.spec) : parsed.interpretation;
    S.interpretation = interp;
    showMsg('');
    renderRead(interp, parsed, r.stats.warnings);
    renderCard(r.stats.spec);
    renderStats(r.stats);
    if (!dragging()) { if (!dimsNow) renderDims(); renderX(); }     // a drag keeps its live estimates until its own bake lands
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
      if (viewer && !dragging()) viewer.showPreview(false);   // never leave a preview standing in for a failed bake
    }
  } finally {
    inflight = false; inflightKey = null;
    A.busy = false;
    if (queued) build();
    else {
      stage.classList.remove('busy'); idleWaiters.splice(0).forEach((r) => r());
      // nothing more is coming and nobody is dragging: the baked model, never a stale preview, is what shows
      if (viewer && viewer.previewing && !dragging()) viewer.showPreview(false);
    }
  }
}

let debounce = 0;
function specChanged() {
  S.edited = true;
  clearTimeout(debounce);
  debounce = setTimeout(() => { syncURL(); requestBuild(); }, 120);
}

/** Interpret a prompt and build it. Resolves when the result is on screen (or answered out of scope). */
async function submit(text, initialX = null, { keepPanel = false } = {}) {
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
  if (initialX) { S.x = initialX; if (!keepPanel) $('#xform').open = !isIdentityX(); }
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

/** The readout: the built element's size, or (preview) an estimate while a transform is being dragged. The estimates
 *  change every frame: the region is not read out then (aria-live off, as during the showcase), the baked size is. */
function renderDims(estimate = null, st = S.stats) {
  const el = $('#dims');
  el.setAttribute('aria-live', estimate || SC.on ? 'off' : 'polite');
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
      if (e.code !== 'stale' && e.message !== 'restarted' && e.code !== 'timeout') throw e;
      // the worker no longer holds the model on screen (it was recycled): rebuild the same spec quietly, once
      const rb = await builder.build(S.shown.input, false, S.shown.deform || null);
      S.shown = { ...S.shown, id: rb.id };  // the same geometry: edges and exports now refer to this build
      r = await builder.exportAs(f, name, rb.id);
    }
    download(new Blob(r.buffers, { type: r.mime }), `${name}.${f}`);
  } catch (e) {
    toast(`The ${f.toUpperCase()} export failed: ${e.message}`);
    console.error('[arch] export failed', e);
  } finally { b.disabled = false; b.textContent = old; b.focus(); }
});
// the drawing sheet: computed in the worker, written here as SVG or painted on a canvas at 300 dpi (PNG with its pHYs)
for (const b of document.querySelectorAll('[data-drawing]')) b.addEventListener('click', async () => {
  if (!S.stats) return;
  const f = b.dataset.drawing, old = b.textContent;
  b.disabled = true; b.textContent = '…';
  try {
    const out = await drawingFile(f);
    download(out.blob, `${slug()}-drawing.${f}`);
    announce(`Drawing sheet at 1:${out.scale} downloaded.`);
  } catch (e) {
    toast(`The drawing failed: ${e.message}`);
    console.error('[arch] drawing failed', e);
  } finally { b.disabled = false; b.textContent = old; b.focus(); }
});

/** The drawing sheet of the model on screen as a file: { blob, scale, dpi, sheet, ms }. */
async function drawingFile(format = 'png') {
  const t0 = performance.now();
  await waitIdle();
  const D = await import('./drawing.js');
  const interp = S.interpretation || describeSpec(S.stats.spec);
  const meta = { title: interp.split(' · ')[0], interpretation: interp, prompt: S.prompt || '', date: new Date().toISOString().slice(0, 10) };
  let r;
  try { r = await builder.drawing(S.shown.id, meta); }
  catch (e) {
    if (e.code !== 'stale' && e.message !== 'restarted' && e.code !== 'timeout') throw e;
    const rb = await builder.build(S.shown.input, false, S.shown.deform || null);
    S.shown = { ...S.shown, id: rb.id };
    r = await builder.drawing(rb.id, meta);
  }
  const sheet = r.sheet;
  if (format === 'svg') return { blob: new Blob([D.toSVG(sheet)], { type: 'image/svg+xml' }), scale: sheet.scale, sheet, ms: performance.now() - t0 };
  // 300 dpi A3 is 4961 x 3508 px; a browser that refuses a canvas that large (iOS caps at 16.7 M pixels) gets 200 dpi
  for (const dpi of [300, 200]) {
    const px = dpi / 25.4, cv = document.createElement('canvas');
    cv.width = Math.round(sheet.w * px); cv.height = Math.round(sheet.h * px);
    const ctx = cv.getContext('2d');
    if (!ctx) continue;
    D.paint(ctx, sheet, px);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    cv.width = cv.height = 0;
    if (!blob) continue;
    const png = D.pngWithDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
    return { blob: new Blob([png], { type: 'image/png' }), scale: sheet.scale, dpi, sheet, ms: performance.now() - t0 };
  }
  throw new Error('this browser could not make an image that large');
}
/** For the tests and the screenshot harness: the sheet as base64 (no download). */
A.drawing = async (format = 'png') => {
  const out = await drawingFile(format);
  const buf = new Uint8Array(await out.blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  const s = out.sheet;
  return { base64: btoa(bin), bytes: buf.length, scale: s.scale, dpi: out.dpi || null, ms: Math.round(out.ms), timing: s.timing, views: s.views,
    measured: s.measured, cut: s.cut, number: s.number, groups: s.groups.map((g) => ({ id: g.id, lines: g.starts.length - 1 })) };
};

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

/** A slider or a lattice handle is being dragged (the GPU preview stays up and bakes do not overwrite the readouts). */
const dragging = () => !!(S.sliderActive || (viewer && viewer.drag));

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

/** resolveOps on the page, with what deformParts would pass it: part stubs built from the undeformed meshes (name,
 *  local box, instances, meta.rigid tag — all resolveOps and its taper lift read of a part) and the bake's options, so a
 *  taper's lift and the 'auto' ranges match the bake. Without undeformed meshes yet: the shaft's box alone. */
const DEFORM_OPTS = () => ({ rigidInstances: S.x.rigid, rigidRatio: RIGID_RATIO, scaleInstances: 'auto' });
function partStubs(info) {
  const pv = viewer && viewer.preview && viewer.preview.key === previewKey() ? viewer.preview.meshes : null;
  const meshes = pv || (S.plainMeshes && S.plainMeshes.key === info.key && S.plainMeshes.meshes);
  if (!meshes) return info.shaftBox ? [{ name: 'shaft', manifold: { numTri: () => 1, boundingBox: () => info.shaftBox }, transforms: null }] : [];
  if (S.stubsFor && S.stubsFor.meshes === meshes) return S.stubsFor.stubs;
  const stubs = meshes.map((m) => {
    const P = m.positions, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { if (P[i + a] < min[a]) min[a] = P[i + a]; if (P[i + a] > max[a]) max[a] = P[i + a]; }
    const nt = m.indices.length / 3, box = { min, max };
    return { name: m.name, manifold: { numTri: () => nt, boundingBox: () => box }, transforms: m.transforms || null,
      meta: m.rigidTag === true || m.rigidTag === false ? { rigid: m.rigidTag } : {} };
  });
  S.stubsFor = { meshes, stubs };
  return stubs;
}
function resolved(ops, info = S.element) {
  const H = info.bbox.max[2] - info.bbox.min[2];
  ops = ops.map((o) => (o.lean ? { type: o.type, axis: o.axis, dx: o.lean[0] * H, dy: o.lean[1] * H } : o));
  return resolveOps(ops, partStubs(info), info.bbox, DEFORM_OPTS());
}

/** The FFD lattice for the ops before it: rest points over their output frame, offsets from the dragged points
 *  (ARAP for normal drags, exact for shift-drags). */
function latticeFor(before, info) {
  const d = S.x.dims, dims = [d, d, d];
  const F = makeDeformer(resolved(before, info), info.bbox).bboxOut;
  const lat = ffdLattice(dims, F);
  // targets stay within the lattice box padded by its own size on every side (a link cannot fling a point to infinity)
  const clampT = (t) => t.map((v, a) => Math.min(lat.max[a] + lat.size[a], Math.max(lat.min[a] - lat.size[a], v)));
  const ok = (i) => Number.isInteger(+i) && +i >= 0 && +i < lat.count;
  const pins = Object.fromEntries(Object.entries(S.x.pins).filter(([i]) => ok(i)).map(([i, t]) => [i, clampT(t)]));
  const offsets = Object.keys(pins).length ? arapLattice(dims, pins, 10, { rest: lat.rest }) : new Float64Array(3 * lat.count);
  for (const [i, t0] of Object.entries(S.x.plain)) {
    if (!ok(i)) continue;
    const t = clampT(t0);
    for (let a = 0; a < 3; a++) offsets[3 * i + a] = t[a] - lat.rest[3 * i + a];
  }
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
  // the deformed box and the re-grounding: estimated from the element's own extreme vertices (the image of its bbox would
  // overstate a twist: the corners of a twisted square box reach further than any stone), refreshed every 80 ms; the
  // bake's exact ground shift when the ops are the baked ones
  const baked = S.stats && S.stats.deform && JSON.stringify(ops) === JSON.stringify(S.stats.deform.ops);
  // (at most every 60 ms while dragging, and always once more 120 ms after the last move, so the readout ends exact)
  let est;
  if (D.identity) est = { min: info.bbox.min.slice(), max: info.bbox.max.slice() };
  else if (dragging() && S.estAt && t0 - S.estAt < 60 && S.estLast) {
    est = S.estLast;
    clearTimeout(S.estTrail);
    S.estTrail = setTimeout(() => { if (dragging()) { S.estAt = 0; doPreview(); } }, 120);
  } else { est = estimateBox(D) || D.bboxOut; S.estAt = t0; S.estLast = est; }
  const tEst = performance.now() - t0;
  const ground = D.identity ? 0 : baked ? S.stats.deform.ground || 0 : info.bbox.min[2] - est.min[2];
  const box = { min: [est.min[0], est.min[1], est.min[2] + ground], max: [est.max[0], est.max[1], est.max[2] + ground] };
  const has = viewer.hasPreview(previewKey());
  const gpu = has && viewer.previewDeform(ops, D, ground, box);
  A.preview = { gpu, ms: +(performance.now() - t0).toFixed(1), estMs: +tEst.toFixed(1), ops: ops.length, box };
  // no preview geometry yet: say so (the bake on release still comes); never bake at slider rate
  if (!gpu) $('#xinfo').textContent = has ? 'no live preview for this combination — release to apply' : 'preparing preview…';
  drawLattice(ops, D, ground);
  renderPoint();
  renderDims(box.max.map((v, a) => v - box.min[a]));
  // live fold warning (a grid of Jacobians, a few ms), at most every 150 ms
  if (performance.now() - foldT > 150) {
    foldT = performance.now();
    const fc = D.identity ? { folds: 0 } : foldCheck(D, info.bbox, 6);
    $('#xwarn').textContent = fc.folds ? 'The shape folds through itself at this setting.' : warnText(S.stats && S.stats.deform);
  }
  renderXOutputs();
}

/** Points that bound the preview geometry, picked once per preview base: for each warped mesh its extreme vertices in
 *  26 directions plus every k-th vertex (<= 400), for up to 48 of its instances; for rigid ornament the instance centres
 *  with the mesh's half diagonal (they move rigidly, so their size is known). */
const DIRS26 = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) DIRS26.push([x, y, z]);
function estimatorFor(meshes) {
  const items = [];
  for (const m of meshes) {
    const P = m.positions, nv = P.length / 3, T = m.transforms, n = T ? T.length / 16 : 1;
    if (!nv) continue;
    const step = Math.max(1, Math.ceil(n / 48)), inst = [];
    for (let k = 0; k < n; k += step) inst.push(T ? T.subarray(16 * k, 16 * k + 16) : null);
    if (m.rigid) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], P[i + a]); hi[a] = Math.max(hi[a], P[i + a]); }
      const corners = [];
      for (let k = 0; k < 8; k++) corners.push([k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]]);
      items.push({ rigid: true, centre: m.centre, corners, inst });
      continue;
    }
    const pick = new Set(), stride = Math.max(1, Math.floor(nv / 400));
    for (const d of DIRS26) {
      let best = -Infinity, bi = 0;
      for (let i = 0; i < nv; i++) { const v = d[0] * P[3 * i] + d[1] * P[3 * i + 1] + d[2] * P[3 * i + 2]; if (v > best) { best = v; bi = i; } }
      pick.add(bi);
    }
    for (let i = 0; i < nv; i += stride) pick.add(i);
    const local = new Float64Array(3 * pick.size);
    let o = 0;
    for (const i of pick) { local[o++] = P[3 * i]; local[o++] = P[3 * i + 1]; local[o++] = P[3 * i + 2]; }
    items.push({ rigid: false, local, inst });
  }
  return items;
}
function estimateBox(D) {
  const meshes = (viewer.preview && viewer.preview.meshes) || (S.plainMeshes && S.plainMeshes.key === S.element.key && S.plainMeshes.meshes);
  if (!meshes) return null;
  if (!S.estFor || S.estFor.meshes !== meshes) S.estFor = { meshes, items: estimatorFor(meshes) };
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], p = [0, 0, 0];
  const add = (q, r = 0) => { for (let a = 0; a < 3; a++) { if (q[a] - r < min[a]) min[a] = q[a] - r; if (q[a] + r > max[a]) max[a] = q[a] + r; } };
  const xf = (M, x, y, z) => {
    if (!M) { p[0] = x; p[1] = y; p[2] = z; return p; }
    p[0] = M[0] * x + M[4] * y + M[8] * z + M[12]; p[1] = M[1] * x + M[5] * y + M[9] * z + M[13]; p[2] = M[2] * x + M[6] * y + M[10] * z + M[14];
    return p;
  };
  const J = new Float64Array(9);
  for (const it of S.estFor.items) {
    for (const M of it.inst) {
      if (it.rigid) {
        // deformParts' rigid placement: corner' = f(c) + k R (corner - c), R the polar rotation of J(c)
        const c = xf(M, it.centre[0], it.centre[1], it.centre[2]).slice(), fc = D.point(c);
        D.jacobian(c, J);
        const { R, s } = polar3(J);
        let k = Math.abs(s[1]);
        if (!(k > 0) || !Number.isFinite(k) || Math.abs(k - 1) < 1e-6) k = 1;
        for (const w0 of it.corners) {
          const w = xf(M, w0[0], w0[1], w0[2]), d = [w[0] - c[0], w[1] - c[1], w[2] - c[2]];
          add([0, 1, 2].map((a) => fc[a] + k * (R[3 * a] * d[0] + R[3 * a + 1] * d[1] + R[3 * a + 2] * d[2])));
        }
        continue;
      }
      const L = it.local;
      for (let i = 0; i < L.length; i += 3) add(D.point(xf(M, L[i], L[i + 1], L[i + 2])));
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
  // the current lattice (before the ground shift): what the point fields read and write
  const rest = k >= 0 ? D.compiled[k].lattice.rest : ffdLattice(dims, D.bboxOut).rest;
  S.latticeNow = { dims, rest, moved: Float64Array.from(pts) };
  for (let i = 2; i < pts.length; i += 3) pts[i] += ground;
  viewer.setLattice(pts, dims, [...Object.keys(S.x.pins), ...Object.keys(S.x.plain)].map(Number), S.sel);
}

// ---- free-form from the keyboard: pick a control point, type or step its offset (arrows 1 cm, shift 10 cm)
function renderPoint() {
  const box = $('#x-point'), L = S.latticeNow;
  box.hidden = !S.x.ffd || !L;
  if (box.hidden) return;
  const d = L.dims[0], count = (d + 1) ** 3, sel = $('#x-pt');
  if (sel.options.length !== count) {
    sel.innerHTML = '';
    const side = (v, n, a, b) => (v === 0 ? a : v === n ? b : String(v));
    for (let i = 0; i < count; i++) {
      const ii = i % (d + 1), jj = Math.floor(i / (d + 1)) % (d + 1), kk = Math.floor(i / (d + 1) ** 2);
      sel.append(new Option(`${side(kk, d, 'bottom', 'top')} · ${side(jj, d, 'front', 'back')} · ${side(ii, d, 'left', 'right')}  (${ii},${jj},${kk})`, i));
    }
  }
  if (S.sel === undefined || S.sel === null || S.sel >= count) S.sel = count - 1;
  sel.value = String(S.sel);
  const i = S.sel;
  for (const el of document.querySelectorAll('#x-point input[type=number]')) {
    if (el === document.activeElement) continue;
    const a = +el.dataset.a, off = L.moved[3 * i + a] - L.rest[3 * i + a];
    el.value = (Math.abs(off) < 5e-5 ? 0 : off).toFixed(3);
  }
  $('#x-only').checked = i in S.x.plain;
}
function movePoint(a, value) {
  const L = S.latticeNow, i = S.sel;
  if (!L || i === null || i === undefined) return;
  const t = [0, 1, 2].map((k) => Math.round((L.moved[3 * i + k]) * 1e4) / 1e4);
  t[a] = Math.round((L.rest[3 * i + a] + value) * 1e4) / 1e4;
  if ($('#x-only').checked) { S.x.plain[i] = t; delete S.x.pins[i]; } else { S.x.pins[i] = t; delete S.x.plain[i]; }
  schedulePreview();
  clearTimeout(S.pointT);
  S.pointT = setTimeout(() => { S.releaseT = performance.now(); syncURL(); requestBuild('deform'); }, 350);
}
$('#x-pt').addEventListener('change', (e) => { S.sel = +e.target.value; renderPoint(); if (S.element) renderX(); });
for (const el of document.querySelectorAll('#x-point input[type=number]')) {
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const v = (parseFloat(el.value) || 0) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 0.1 : 0.01);
    el.value = v.toFixed(3);
    movePoint(+el.dataset.a, v);
  });
  el.addEventListener('change', () => { const v = parseFloat(el.value); if (Number.isFinite(v)) movePoint(+el.dataset.a, v); });
}
$('#x-only').addEventListener('change', (e) => {
  const i = S.sel, t = S.x.pins[i] || S.x.plain[i];
  if (!t) return;
  if (e.target.checked) { S.x.plain[i] = t; delete S.x.pins[i]; } else { S.x.pins[i] = t; delete S.x.plain[i]; }
  syncURL(); requestBuild('deform');
});

/** Ask the worker for the refined undeformed element (once per element and rigid setting); until it arrives the
 *  undeformed meshes on screen stand in, when there are some. */
function maybeBase(now = false) {
  if (!viewer || !S.element || (SC.on && !now)) return;   // the showcase needs no preview geometry
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
    if (viewer.previewing || dragging()) doPreview();
  }, (e) => {
    baseFor = null;
    if (e.code === 'timeout') fail(e.message);        // the watchdog restarted the kernel for the preview job: say so
    else if (e.code !== 'busy' && e.message !== 'restarted') console.warn('[arch] preview geometry unavailable:', e.message);
  });
}

/** The undeformed meshes on screen as a preview base: rigid parts flagged by deformParts' rule. */
function interimBase(meshes, bbox) {
  const diag = Math.hypot(...[0, 1, 2].map((k) => bbox.max[k] - bbox.min[k]));
  return meshes.map((m) => {
    const P = m.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { if (P[i + a] < lo[a]) lo[a] = P[i + a]; if (P[i + a] > hi[a]) hi[a] = P[i + a]; }
    const T = m.transforms, n = T ? T.length / 16 : 1;
    const rigid = isRigidPart({ instances: T ? n : 1, scale: frameScale(T), elementDiag: diag, enabled: S.x.rigid, empty: !P.length,
      tag: m.rigidTag, localDiag: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) });
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
  renderPoint();
}

// slider: input = live preview, change (release, or a key step) = exact bake
for (const el of document.querySelectorAll('#xform [data-x]')) {
  el.addEventListener('pointerdown', () => { S.sliderActive = true; });
  el.addEventListener('input', () => {
    S.x[el.dataset.x] = +el.value;
    $('#xnote').textContent = isIdentityX() ? '' : 'on';
    schedulePreview();
  });
  el.addEventListener('change', () => {
    S.sliderActive = false;
    S.releaseT = performance.now();
    S.x[el.dataset.x] = +el.value;
    syncURL();
    requestBuild('deform');
  });
  // double-click the label: back to neutral
  const lab = el.parentElement.querySelector('label');
  if (lab) lab.addEventListener('dblclick', () => { el.value = XDEF[el.dataset.x]; S.x[el.dataset.x] = XDEF[el.dataset.x]; syncURL(); renderX(); requestBuild('deform'); });
}
// a drag can end without a change event (a cancelled touch, the window losing focus): end it and bake what is shown
function endDrag() {
  const was = S.sliderActive || (viewer && viewer.drag);
  S.sliderActive = false;
  if (viewer && viewer.drag) viewer.cancelDrag();
  if (was && JSON.stringify(S.x) !== S.builtX) { S.releaseT = performance.now(); syncURL(); requestBuild('deform'); }
  else if (was && viewer && viewer.previewing && !inflight) viewer.showPreview(false);
}
// a release ends the drag; the range's own change event (which follows) bakes, once. Only a cancelled pointer or a lost
// focus, which never send that change, bake here.
window.addEventListener('pointerup', () => {
  if (!S.sliderActive) return;
  S.sliderActive = false;
  // a slider brought back to where it started sends no change: nothing to bake, the preview gives way to the model
  setTimeout(() => {
    if (!S.sliderActive && !dragging() && !inflight && !queued && viewer && viewer.previewing && JSON.stringify(S.x) === S.builtX) viewer.showPreview(false);
  }, 0);
});
window.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', endDrag);
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
  down: (i) => { S.sel = i; renderPoint(); },
  move: (i, q, shift) => {
    const t = [q[0], q[1], q[2] - latticeGround].map((a) => Math.round(a * 1e4) / 1e4);
    if (shift) { S.x.plain[i] = t; delete S.x.pins[i]; } else { S.x.pins[i] = t; delete S.x.plain[i]; }
    schedulePreview();
  },
  up: () => { S.releaseT = performance.now(); syncURL(); requestBuild('deform'); renderPoint(); },
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
  let o;
  try { o = JSON.parse(atob(String(str).replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { o = null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) { console.warn('[arch] ?deform= ignored: not a deformation'); return null; }
  const x = structuredClone(XDEF), num = (v, a, b, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d);
  if (Array.isArray(o.s)) STRETCH.forEach(([, k], i) => { x[k] = num(o.s[i], 0.5, 2, 1); });
  if (o.k === 0) x.keep = false;
  x.bend = num(o.b, -180, 180, 0); x.bow = num(o.w, -45, 45, 0); x.twist = num(o.t, -360, 360, 0); x.taper = num(o.p, 0.3, 1.5, 1);
  if (Array.isArray(o.l)) { x.lx = num(o.l[0], -25, 25, 0); x.ly = num(o.l[1], -25, 25, 0); }
  if (o.r === 0) x.rigid = false;
  if (o.f && typeof o.f === 'object' && !Array.isArray(o.f)) {
    x.dims = o.f.d === 4 ? 4 : 3;
    const count = (x.dims + 1) ** 3;
    // indices inside the lattice, three finite coordinates of sane size (the box clamp follows once the element is known)
    const pts = (m) => (m && typeof m === 'object' && !Array.isArray(m) ? Object.fromEntries(Object.entries(m).filter(([i, t]) =>
      /^\d+$/.test(i) && +i < count && Array.isArray(t) && t.length === 3 && t.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e4))) : {});
    x.pins = pts(o.f.p); x.plain = pts(o.f.m);
    x.ffd = true;
  }
  return x;
}

// ------------------------------------------------------------------------------------------------ URL

function syncURL() {
  if (SC.on) return;                      // the showcase does not write the address
  const q = new URLSearchParams(location.search);
  // the default element and the showcase's examples are not the visitor's request: they stay out of the address (a
  // reload then shows the other default, and the idle showcase may start again)
  if (S.prompt && !S.auto) q.set('q', S.prompt); else q.delete('q');
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
  if (!q) S.auto = true;
  submit(q || DEFAULT_PROMPT, xq);
})();

// ------------------------------------------------------------------------------------------------ idle showcase

// When nobody has asked for anything (no q / spec / deform in the address) and the page sits idle for 12 s — or at once
// inside the site's frame (embed=1), or with ?showcase=1 — the studio shows what it can do: ten curated elements, each
// "typed" into the prompt, built, and raised through a clipping plane, then turned slowly. Any interaction (pointer,
// wheel, key, touch) stops it at once and it does not come back (except with ?showcase=1, after 12 s idle again).
// prefers-reduced-motion: no typing, no rising, no turning, and a slower cycle.
const SHOWCASE = [
  { text: 'Corinthian tetrastyle portico' },
  { text: 'Corinthian capital in white marble' },
  { text: 'Russian onion dome with lantern' },
  { text: 'Gothic window with a pointed arch' },
  { text: 'Slate mansard roof with dormers' },
  { text: 'Ionic column 3.6 m on a pedestal' },
  { text: 'Broach spire with cross' },
  { text: 'Balustrade with urns, 5 m long' },
  { text: 'Balustrade with urns, 5 m long', x: { bend: 120 }, label: 'Curved balustrade with urns (plan curve 120°)' },
  { text: 'Copper dome with drum and lantern' },
];

function idleShowcase(ms) {
  clearTimeout(SC.idleT);
  if (!SC.allowed || SC.on || (SC.engaged && !SC.forced)) return;
  SC.idleT = setTimeout(startShowcase, ms);
}
// the live regions that a build updates stay quiet while the showcase runs (it would speak every 5 s, forever)
const LIVE = ['#dims', '#xwarn'];
function quiet(on) {
  for (const sel of LIVE) { const el = $(sel); if (!el) continue; if (on) el.setAttribute('aria-live', 'off'); else el.removeAttribute('aria-live'); }
  if (!on) $('#dims').setAttribute('aria-live', 'polite');
}
function startShowcase() {
  if (SC.on || !SC.allowed || (SC.engaged && !SC.forced) || !A.ready) return;
  $('#sr').textContent = 'Showcase running: examples build one after another. Press any key or click to stop it.';
  SC.on = true; A.showcase.running = true;
  quiet(true);
  document.documentElement.classList.add('showcase');
  // start after the element on screen (the default is the last example or the first)
  const cur = SHOWCASE.findIndex((e) => !e.x && e.text === S.prompt);
  SC.i = cur >= 0 ? cur + 1 : 0;
  if (!onShow()) { SC.paused = true; A.showcase.phase = 'paused'; return; }
  nextExample();
}
function stopShowcase() {
  clearTimeout(SC.idleT);
  if (!SC.on) return;
  SC.on = false; SC.paused = false; SC.gen++; A.showcase.running = false; A.showcase.phase = '';
  clearTimeout(SC.timer); clearTimeout(SC.typeT);
  document.documentElement.classList.remove('showcase');
  quiet(false);
  $('#prompt').value = S.prompt;          // a half-typed example gives way to the request on screen
  if (viewer) { viewer.controls.autoRotate = false; viewer.endReveal(); }
  S.reveal = false;
  $('#sr').textContent = `Showcase stopped. ${S.interpretation || ''}`;
}
// nobody sees it: a hidden tab, or the site's frame scrolled out of view. It waits, and goes on when it is seen again.
let inView = true;
const onShow = () => !document.hidden && inView;
function pauseShowcase() {
  if (!SC.on || SC.paused) return;
  SC.paused = true; SC.gen++; A.showcase.phase = 'paused';   // the loop under way (typing, building) ends at its next step
  clearTimeout(SC.timer); clearTimeout(SC.typeT);
  if (viewer) viewer.controls.autoRotate = false;
  $('#prompt').value = S.prompt;
}
function resumeShowcase() {
  if (!SC.on || !SC.paused || !onShow()) return;
  SC.paused = false;
  clearTimeout(SC.timer); clearTimeout(SC.typeT);
  SC.timer = setTimeout(nextExample, 1200);
}
document.addEventListener('visibilitychange', () => (document.hidden ? pauseShowcase() : resumeShowcase()));
if (typeof IntersectionObserver !== 'undefined') {
  // the implicit root is the top-level viewport, so this also sees the site scrolling this frame away
  new IntersectionObserver((entries) => {
    inView = entries[entries.length - 1].isIntersecting;
    if (inView) resumeShowcase(); else pauseShowcase();
  }, { threshold: 0.15 }).observe(stage);
}
/** Type text into the prompt box, a character at a time (at once with reduced motion); stops when its loop is over. */
function typeOut(text, gen) {
  const box = $('#prompt');
  if (REDUCED.matches) { box.value = text; box.dispatchEvent(new Event('input')); return Promise.resolve(); }
  return new Promise((resolve) => {
    let n = 0;
    box.value = '';
    const step = () => {
      if (SC.gen !== gen) return resolve();
      box.value = text.slice(0, ++n);
      if (n >= text.length) { box.dispatchEvent(new Event('input')); SC.typeT = setTimeout(resolve, 220); return; }
      SC.typeT = setTimeout(step, 22 + Math.random() * 26);
    };
    SC.typeT = setTimeout(step, 120);
  });
}
// One loop at a time: every pause or stop starts a new generation, and an example whose generation is over (it was
// typing or building when the tab was hidden) ends at its next step instead of scheduling another; a resume starts
// the new generation's loop.
async function nextExample() {
  if (!SC.on || SC.paused) return;
  const gen = SC.gen, live = () => SC.gen === gen && SC.on && !SC.paused;
  const t0 = performance.now(), k = SC.i++ % SHOWCASE.length, ex = SHOWCASE[k];
  A.showcase.index = k; A.showcase.phase = 'typing';
  if (viewer) viewer.controls.autoRotate = false;
  await typeOut(ex.text, gen);
  if (!live()) return;
  A.showcase.phase = 'building';
  S.auto = true;
  S.reveal = !REDUCED.matches;
  // the transform is applied as a link would apply it, but the panel stays as the visitor left it (closed)
  const x = ex.x ? { ...structuredClone(XDEF), ...ex.x } : null;
  try { await submit(ex.text, x, { keepPanel: true }); } catch (e) { /* a failed example: go on */ }
  if (!live()) return;
  A.showcase.phase = REDUCED.matches ? 'holding' : 'revealing';
  A.showcase.shown.push({ index: k, text: ex.label || ex.text, at: Math.round(performance.now()), ms: Math.round(performance.now() - t0) });
  if (A.showcase.shown.length > 40) A.showcase.shown.splice(0, A.showcase.shown.length - 40);
  if (viewer && !REDUCED.matches) { viewer.controls.autoRotate = true; viewer.controls.autoRotateSpeed = -0.55; }
  setTimeout(() => { if (live() && A.showcase.index === k) A.showcase.phase = 'holding'; }, 1100);
  // the next example's generator loads while this one is on show
  const nx = SHOWCASE[SC.i % SHOWCASE.length];
  try { const el = parseFn && parseFn(nx.text).spec.element; if (el) builder.w.postMessage({ type: 'warm', element: el }); } catch (e) { /* warm-up is optional */ }
  // one example every ~5 s; a slow build still gets 2.6 s on show (the rise, then a look)
  const hold = REDUCED.matches ? 9000 : Math.max(2600, 5200 - (performance.now() - t0));
  clearTimeout(SC.timer);
  SC.timer = setTimeout(nextExample, hold);
}
// interaction stops it (capture: before the canvas or a control handles the event); a pointer that only moves delays
// an idle start
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'focusin']) {
  window.addEventListener(ev, (e) => {
    if (!e.isTrusted) return;
    SC.engaged = true; S.auto = false;
    if (SC.on) { stopShowcase(); syncURL(); }
    if (SC.forced) idleShowcase(12000);
  }, { capture: true, passive: true });
}
window.addEventListener('pointermove', () => { if (!SC.on && !SC.engaged) idleShowcase(EMBED || SC.forced ? 1500 : 12000); }, { passive: true });
// once the first element is on screen
(async () => {
  while (!A.ready) await new Promise((r) => setTimeout(r, 200));
  idleShowcase(EMBED || SC.forced ? 1500 : 12000);
})();
