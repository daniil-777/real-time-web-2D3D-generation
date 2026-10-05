// Arch Studio grips: the parametric handles on a built element (Revit / ArchiCAD style). Pure (no kernel, no DOM): the
// main thread and Node import it. A grip edits one REQUEST spec field (it becomes stated); the worker rebuilds, so every
// read-back (interpretation line, card, URL, drawing, exports, undo) follows the spec, never a mesh.
// Spec: /Volumes/LaCie/morph3d/work/2026-10-05-grips-spec.md (interface contract).
//
//   gripsFor(spec, info) -> Grip[]   spec: generate().spec (normalized + effective fields, with given)
//                                    info: { size, bbox } of the build (element coords: Z-up metres, origin at the base
//                                    centre, front -Y); optional info.expected (generate().expected) gives derived counts
//                                    (balusters of a run whose length is stated, bays of an arcade whose length is)
//   parseTyped(text, grip, spec) -> number | null
//
// Grip = { id, field, label, kind: 'length' | 'count' | 'angle', anchor, dir, value, unit, min, max, ticks, perMetre,
//          snap(v), apply(v) -> patch, format(v) }  plus two informative fields: axis (0 | 1 | 2, the bbox axis the value
//          moves) and extent (true when the value IS the build's extent along that axis, e.g. a balustrade's length).
//
// Decisions (documented in /Volumes/LaCie/morph3d/archkit/audit/grips-engine-report.md):
// - Baseline: deform.js SMART (height on Z at the top, length / width / span / diameter at the +X / +Y end); elements
//   are centred on X / Y, so an end grip whose extent is field + constant has perMetre 2, one whose extent scales with
//   the field (an arch's span, a pediment's width, a dome's diameter) has perMetre 2 · value / extent.
// - A patch may clear a field (value undefined: the merged request drops it, normalize() refills defaults): balustrade
//   length clears a stated baluster count (the balusters re-array at classical spacing) and the count grip clears the
//   length (the run follows the count); arcade length clears bays (the family picks the bay count nearest the span) and
//   the bays grip clears the length; roof / pediment pitch clears height (and height clears pitch), as height solves
//   the pitch in those families.
// - Ranges: SCHEMA limits narrowed to what each family builds as one valid solid that honours the value (tested).

import { SCHEMA, DEFAULTS } from './spec.js';
import { ORDERS, columnDims } from './orders.js';
import { surroundHead } from './gen/surround.js';

const R2D = 180 / Math.PI, D2R = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const pos = (v) => fin(v) && v > 0;
const stated = (spec, f) => (Array.isArray(spec.given) ? spec.given.includes(f) : spec[f] !== undefined && spec[f] !== null);
const range = (f, lo, hi) => [Math.max(SCHEMA[f].min, lo), Math.min(SCHEMA[f].max, hi)];
const rng = (f, [lo, hi]) => { const [min, max] = range(f, lo, hi); return { min, max }; };
const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1], NY = [0, -1, 0];

// ------------------------------------------------------------------------------------------------ the grip object

const nouns = { columns: ['column', 'columns'], balusters: ['baluster', 'balusters'], bays: ['bay', 'bays'] };

function grip(o) {
  const kind = o.kind || 'length';
  const unit = o.unit ?? (kind === 'angle' ? '°' : kind === 'count' ? '' : 'm');
  let [min, max] = [o.min, o.max];
  if (!(min < max)) max = min + (kind === 'count' ? 1 : 0.01);
  const ticks = o.ticks && o.ticks.length ? o.ticks : null;
  // the nearest tick; a tie goes to the larger one (as Math.round: a typed 5 columns -> 6)
  const nearestTick = (v) => ticks.reduce((b, t) => (Math.abs(t.v - v) <= Math.abs(b.v - v) + 1e-12 ? t : b), ticks[0]);
  const snap = o.snap || ((v) => {
    if (!fin(v)) v = o.value;
    v = clamp(v, min, max);
    if (ticks) return nearestTick(v).v;
    if (kind === 'count') return clamp(Math.round(v), Math.ceil(min), Math.floor(max));
    if (kind === 'angle') return Math.round(v * 10) / 10;
    return Math.round(v * 1000) / 1000;
  });
  const apply = (v) => (o.apply ? o.apply(snap(v)) : { [o.field]: snap(v) });
  const format = o.format || ((v) => {
    const t = ticks ? nearestTick(v) : null;
    if (kind === 'count') {
      const n = Math.round(v), [one, many] = nouns[o.field] || ['', ''];
      return `${n} ${n === 1 ? one : many}`.trim() + (t && t.v === n && t.label ? ` · ${t.label}` : '');
    }
    if (kind === 'angle') return `${(Math.round(v * 10) / 10).toString()}°`;
    return `${v < 0.1 ? v.toFixed(3) : v.toFixed(2)} m` + (t && t.label && Math.abs(t.v - v) < 1e-9 ? ` · ${t.label}` : '');
  });
  const value = fin(o.value) ? o.value : min;
  return {
    id: o.id, field: o.field, label: o.label, kind, anchor: o.anchor.map((c) => (fin(c) ? c : 0)), dir: unitv(o.dir),
    value, unit, min, max, ticks, perMetre: pos(o.perMetre) ? o.perMetre : 1, snap, apply, format,
    axis: o.axis ?? (o.dir[0] ? 0 : o.dir[1] ? 1 : 2), extent: !!o.extent,
  };
}

function unitv(d) {
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}

/** The build's box: info.bbox / info.size, else a guess from the spec (so gripsFor never throws). */
function boxOf(spec, info) {
  let min = info && info.bbox && info.bbox.min, max = info && info.bbox && info.bbox.max;
  let size = info && info.size;
  if (!size && min && max) size = [0, 1, 2].map((a) => max[a] - min[a]);
  if (!size || !size.every(fin)) {
    const w = spec.length || spec.width || spec.span || spec.diameter || 1, h = spec.height || w;
    size = [w, spec.depth || Math.min(w, 1), h];
  }
  if (!min || !max || !min.every(fin) || !max.every(fin)) { min = [-size[0] / 2, -size[1] / 2, 0]; max = [size[0] / 2, size[1] / 2, size[2]]; }
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2;
  return { min, max, size, cx, cy };
}

const heightGrip = (B, value, [lo, hi], extra = {}) => grip({
  id: 'height', field: 'height', label: 'Height', anchor: [B.cx, B.cy, B.max[2]], dir: Z, value, ...rng('height', [lo, hi]),
  perMetre: 1, extent: Math.abs(B.size[2] - value) < 0.005 * Math.max(value, 1e-3), ...extra,
});

/** An end grip on X (or Y): extent = value + constant -> perMetre 2; extent proportional to the value -> 2 value / extent. */
function endGrip(B, o) {
  const ax = o.axis ?? 0, ext = B.size[ax];
  const proportional = o.proportional && pos(ext) && pos(o.value);
  const anchor = o.anchor || (ax === 0 ? [B.max[0], B.cy, o.z ?? B.max[2] / 2] : [B.cx, B.max[1], o.z ?? B.max[2] / 2]);
  return grip({
    kind: 'length', dir: ax === 0 ? X : Y, anchor, perMetre: proportional ? (2 * o.value) / ext : 2,
    extent: !proportional && Math.abs(ext - o.value) < 0.005 * Math.max(o.value, 1e-3), ...o, axis: ax,
  });
}

// ------------------------------------------------------------------------------------------------ column family

/** column.js dimsFor (pure: orders.js only): the element's own height drives D. */
function colDims(spec) {
  const o = ORDERS[spec.order] || ORDERS.tuscan, el = spec.element;
  const ped = el === 'pedestal' || ((el === 'column' || el === 'pilaster') && spec.pedestal);
  const opts = { diameter: spec.diameter, pedestal: ped };
  if (spec.height) {
    if (el === 'column' || el === 'pilaster') opts.height = spec.height / (ped ? 4 / 3 : 1);
    else if (el === 'capital' && o.capD) opts.diameter = spec.height / o.capD;
    else if (el === 'base' && o.baseD) opts.diameter = spec.height / o.baseD;
    else if (el === 'pedestal') opts.height = spec.height * 3;
  }
  return columnDims(spec.order, opts);
}

function columnGrips(spec, B) {
  const d = colDims(spec), o = d.o, el = spec.element;
  if (el === 'column' || el === 'pilaster') return [heightGrip(B, spec.height || d.total, [0.3, 40])];
  if (el === 'pedestal') return [heightGrip(B, spec.height || d.ped || d.H / 3, [0.1, 6])];
  const own = el === 'capital' ? (o.capD ? d.cap : 0) : ((spec.base ?? o.base) !== 'none' && o.baseD ? d.base : 0);
  if (own > 0) {
    const g = heightGrip(B, spec.height || own, el === 'capital' ? [0.05, 4] : [0.03, 2]);
    // the capital's leaves stand a little above its abacus line: its extent scales with the height
    if (pos(B.size[2])) g.perMetre = g.value / B.size[2];
    return [g];
  }
  // an order without a capital / base: the element is a slab the diameter sizes
  return [endGrip(B, { id: 'diameter', field: 'diameter', label: 'Diameter', value: spec.diameter || d.D, min: 0.1, max: 3, proportional: true })];
}

// ------------------------------------------------------------------------------------------------ entablature family

const defaultPitch = (order) => (order === 'greek-doric' ? Math.atan(2 / 9) * R2D : 22.5);   // entablature.js

function entablatureGrips(spec, B) {
  const el = spec.element, out = [];
  if (el === 'entablature' || el === 'cornice' || el === 'moulding') {
    const L = spec.length || (el === 'moulding' ? 1.2 : 3);
    out.push(endGrip(B, { id: 'length', field: 'length', label: 'Length', value: L, ...rng('length', el === 'moulding' ? [0.1, 20] : [0.5, 40]),
      anchor: [B.max[0], B.cy, B.max[2]] }));
    const H = spec.height || (el === 'moulding' ? 0.16 : B.size[2]);
    out.push(heightGrip(B, H, el === 'entablature' ? [0.15, 8] : el === 'cornice' ? [0.08, 4] : [0.02, 1]));
    return out;
  }
  if (el === 'pediment') {
    const W = spec.width || 5;
    if (spec.pediment === 'none') {   // built as a cornice of that length: height is the cornice's
      out.push(endGrip(B, { id: 'width', field: 'width', label: 'Width', value: W, min: 1, max: 40, anchor: [B.max[0], B.cy, B.max[2] / 2] }));
      out.push(heightGrip(B, spec.height || B.size[2], [0.08, 4]));
      return out;
    }
    // z = A + xo tan(pitch): A the horizontal cornice (and the rake's depth), xo the rake's run (half the width over the
    // cornice, less half a broken pediment's gap)
    const order = ORDERS[spec.order] ? spec.order : 'ionic', O = ORDERS[order];
    const xo = Math.max(0.1, B.size[0] / 2 - (spec.pediment === 'broken' ? 0.15 * W : 0));
    const D = spec.diameter || W / (3 * O.axis + O.shaftTop);
    let p = spec.pitch ?? defaultPitch(order), A = B.size[2] - xo * Math.tan(p * D2R);
    if (spec.height) { A = 1.1 * D; p = clamp(Math.atan(Math.max(0, B.size[2] - A) / xo) * R2D, 5, 60); }
    A = clamp(A, 0.02, B.size[2]);
    // width: the end of the horizontal cornice, half-way up it; pitch: half-way along the right rake, on its top
    out.push(endGrip(B, { id: 'width', field: 'width', label: 'Width', value: W, min: 1, max: 40, proportional: true,
      anchor: [B.max[0], B.cy, A / 2] }));
    out.push(pitchGrip(B, p, [5, 60], xo / 2, { height: undefined },
      { anchor: [B.max[0] - xo / 2, B.cy, Math.min(B.max[2], A + (xo / 2) * Math.tan(p * D2R))] }));
    const zAt = (deg) => A + xo * Math.tan(deg * D2R);
    out.push(heightGrip(B, spec.height || B.size[2], [Math.max(0.05, zAt(10)), zAt(50)], {
      anchor: [B.cx, B.cy, B.max[2]], apply: (v) => ({ height: v, pitch: undefined }) }));
    return out;
  }
  // window / door: the opening's width and height (the surround is proportioned from the width, a = w / 6)
  const door = el === 'door', w = spec.width || (door ? 1.6 : 1.2), h = spec.height || (door ? 3 : 2.1);
  // entablature.js surroundPlan: the opening's sill stands on the consoles and the sill (a = w / 6); a door on the ground.
  // Width: on the right jamb, half-way up the opening; height: on the head of the opening (the crown of an arched one),
  // both on the architrave's face (the surround stands about a tenth of its band proud of the wall plane y = 0)
  const a = w / 6, zo = door ? 0 : surroundHead(spec).consoles ? 1.72 * a : 0.36 * a, yFace = Math.max(B.min[1], -0.1 * a);
  out.push(grip({ id: 'width', field: 'width', label: 'Width', anchor: [w / 2, yFace, zo + h / 2], dir: X, value: w,
    min: door ? 0.6 : 0.4, max: door ? 5 : 4, perMetre: 2 }));
  out.push(heightGrip(B, h, door ? [1.5, 8] : [0.6, 6], { anchor: [0, yFace, Math.min(B.max[2], zo + h)], extent: false }));
  return out;
}

/** An angle grip on a slope, `run` metres (horizontally) from the slope's foot: that point rises run tan(p), so a metre
 *  of travel there is cos^2(p) / run radians. Default anchor: the apex. */
function pitchGrip(B, p, [min, max], run, clears = {}, extra = {}) {
  const per = (R2D * Math.cos(p * D2R) ** 2) / Math.max(0.05, run);
  return grip({ id: 'pitch', field: 'pitch', label: 'Pitch', kind: 'angle', anchor: [B.cx, B.cy, B.max[2]], dir: Z, value: p,
    min, max, perMetre: per, apply: (v) => ({ pitch: v, ...clears }), ...extra });
}

// ------------------------------------------------------------------------------------------------ portico

const PORTICO_NAMES = { 2: 'distyle', 4: 'tetrastyle', 6: 'hexastyle', 8: 'octastyle', 10: 'decastyle', 12: 'dodecastyle' };
const PLINTH = { attic: 0.67, tuscan: 0.66, none: 0.52 };   // portico.js: plinth half-width in D
const RISER = 0.16, TREAD = 0.32;

/** The portico's lower diameter D (portico.js porticoPlan; with only a width stated, the stylobate's width solved). */
function porticoD(spec) {
  const O = ORDERS[spec.order] || ORDERS.ionic, n = spec.columns || 4, steps = spec.steps ?? 3;
  if (spec.height) return spec.height / O.colD;
  if (spec.width) {
    const base = spec.base ?? (['attic', 'tuscan', 'none'].includes(O.base) ? O.base : 'attic');
    const hp = (PLINTH[base] ?? 0.67) + 0.3, plat = steps > 0 ? steps - 1 : 0;
    return Math.max(0.02, (spec.width - 2 * plat * TREAD) / ((n - 1) * O.axis + 2 * hp));
  }
  return spec.diameter || 0.6;
}

function porticoGrips(spec, B) {
  const O = ORDERS[spec.order] || ORDERS.ionic, n = spec.columns || 4, steps = spec.steps ?? 3, D = porticoD(spec);
  const H = O.colD * D, axis = O.axis * D, zs = steps * RISER, xLast = ((n - 1) / 2) * axis;
  // a stated width (without a height) would hold the width and shrink the columns: the count grip lets the width follow
  const keepD = spec.width && !spec.height ? { width: undefined, diameter: Math.round(D * 1000) / 1000 } : {};
  const ticks = [];
  for (let c = 2; c <= 16; c += 2) ticks.push(PORTICO_NAMES[c] ? { v: c, label: PORTICO_NAMES[c] } : { v: c });
  const out = [grip({ id: 'columns', field: 'columns', label: 'Columns', kind: 'count', anchor: [xLast, -D / 2, zs + H / 2], dir: X,
    value: n, min: 2, max: 16, ticks, perMetre: 2 / axis, apply: (v) => ({ columns: v, ...keepD }) })];
  out.push(grip({ id: 'height', field: 'height', label: 'Column height', anchor: [xLast, -D / 2, zs + H], dir: Z, value: H,
    min: 2, max: 25, perMetre: 1, apply: (v) => ({ height: v, width: undefined }) }));
  if ((spec.pediment || 'triangular') !== 'none') {
    const p = spec.pitch ?? defaultPitch(ORDERS[spec.order] ? spec.order : 'ionic');
    out.push(pitchGrip(B, p, [5, 60], B.size[0] / 2, {}, { anchor: [0, -D / 2, B.max[2]] }));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ balustrade

const D_OF = { vase: 0.33, 'double-vase': 0.31, bottle: 0.31, square: 0.29 };   // balustrade.js

/** The run's module (balustrade.js dims): baluster diameter D, axis spacing s, pedestal die Wd, mouldings' projection e. */
function balusterModule(spec) {
  const H = spec.height || 0.95, kind = D_OF[spec.baluster] || spec.baluster === 'bar' ? spec.baluster : 'vase', bar = kind === 'bar';
  const hb = (2 * H) / 3, D = bar ? 0.063 * hb : D_OF[kind] * hb;
  const gap = bar ? Math.min(0.1, 0.158 * hb) : D / 2;
  return { H, hb, D, bar, s: D + gap, Wd: bar ? 6 * D : 1.8 * D, e: bar ? 0.6 * D : 0.2 * D, half: !bar };
}

/** Balusters a run of length L gets (balustrade.js layout, length mode) - for display when the build does not say. */
function balusterCount(m, L) {
  const bayW = (n) => (m.half ? (n + 1) * m.s : n * m.D + (n + 1) * (m.s - m.D));
  if (L < 2 * (m.Wd + m.e) + bayW(1)) return Math.max(1, Math.floor(L / m.s));
  const Bn = L > 4 ? Math.max(2, Math.round(L / 3)) : 1, W = (L - (Bn + 1) * m.Wd - 2 * m.e) / Bn;
  let n = m.half ? Math.max(1, Math.ceil(W / m.s - 1 - 1e-9)) : Math.max(1, Math.ceil((W - (m.s - m.D)) / m.s - 1e-9));
  if (m.half && n > 1 && W / (n + 1) - m.D < m.D / 3 - 1e-9 && W / n - m.D <= m.D / 2 + 1e-9) n--;
  return n * Bn;
}

function balustradeGrips(spec, B, info) {
  if (spec.element === 'baluster') return [heightGrip(B, spec.height || 0.7, [0.2, 2])];
  const m = balusterModule(spec), L = spec.length || B.size[0], urns = B.size[2] > m.H * 1.02;
  const N = spec.balusters || (info && info.expected && info.expected.counts && info.expected.counts.baluster) || balusterCount(m, L);
  return [
    endGrip(B, { id: 'length', field: 'length', label: 'Length', value: L, min: 0.3, max: 60, anchor: [B.max[0], B.cy, m.H],
      apply: (v) => ({ length: v, balusters: undefined }) }),
    heightGrip(B, m.H, [0.4, 2], { anchor: [B.cx, B.cy, m.H], extent: !urns }),
    grip({ id: 'balusters', field: 'balusters', label: 'Balusters', kind: 'count', dir: X, value: N, min: 1, max: 300, ticks: null,
      anchor: [Math.max(B.cx, B.max[0] - m.e - m.Wd - m.s), B.cy - 0.45 * m.D, 0.4 * m.H], perMetre: 2 / m.s,
      apply: (v) => ({ balusters: v, length: undefined }) }),
  ];
}

// ------------------------------------------------------------------------------------------------ arch and arcade

// arch.js archGeom: rise / span of each intrados (horseshoe rises as high as the pointed arch: a shape, not a rise)
const RISE = [
  { v: 0.25, label: 'segmental' }, { v: 1 / 3, label: 'basket' }, { v: 0.3612, label: 'tudor' },
  { v: 0.5, label: 'semicircular' }, { v: Math.sqrt(3) / 2, label: 'pointed' },
];
const RISE_OF = { segmental: 0.25, basket: 1 / 3, tudor: 0.3612, semicircular: 0.5, pointed: Math.sqrt(3) / 2, horseshoe: Math.sqrt(3) / 2 };
const OPENING = { semicircular: 2, pointed: 2, horseshoe: 1.8, tudor: 1.6, segmental: 1.5, basket: 1.4 };   // arch.js

/** arch.js character(): the style turns a default arch type pointed (Gothic) or horseshoe (Moorish). */
function archTypeOf(spec) {
  let t = spec.archType || 'semicircular';
  const def = t === (DEFAULTS[spec.element] || {}).archType;
  if (def && (spec.style === 'gothic' || spec.order === 'gothic')) t = 'pointed';
  if (def && spec.style === 'moorish') t = 'horseshoe';
  return t;
}

function archGrips(spec, B, info) {
  const arcade = spec.element === 'arcade', type = archTypeOf(spec), out = [];
  // arch.js decides the span itself in two cases (it compares with DEFAULTS, not spec.given): a height with the default
  // span proportions the arch from the height; an arcade length without a non-default bay count picks the bays and
  // solves the span. There the span and bays are estimated from the build: a default arcade's extent is
  // span x (1.4615 bays + 0.789) (an arch: 2.25 spans), the bay count from the keystones when the build reports them.
  const span0 = spec.span ?? DEFAULTS[spec.element].span;
  const freeSpan = !!spec.height && span0 === DEFAULTS[spec.element].span;
  const freeBays = arcade && !!spec.length && !(spec.bays !== undefined && spec.bays !== DEFAULTS.arcade.bays);
  let N = arcade ? spec.bays || 3 : 1;
  if (freeBays) {
    const keys = info && info.expected && info.expected.counts && info.expected.counts.keystone;
    N = keys || Math.max(1, Math.round((B.size[0] / span0 - 0.789) / 1.4615));
  }
  const S = freeSpan || freeBays ? B.size[0] / (arcade ? N * 1.4615 + 0.789 : 2.2508) : span0;
  const Z1 = B.size[2] / S;                                   // height per metre of span, as built
  const hRange = [Math.max(0.5, 0.35 * Z1), Math.min(120, 20 * Z1)];
  // the opening: crown at OPENING x span (arch.js, height free; a stated height moves the springing, the cornice and
  // spandrel above the crown keep about 0.454 span), springing = crown - rise, the arch's face half the wall depth in
  // front of the axis (wall depth: spec.depth, else a quarter of the span)
  const rise = Math.round((RISE_OF[type] ?? 0.5) * S * 1000) / 1000;   // on its tick (ticks are mm-rounded)
  const crown = clamp(spec.height && !freeSpan ? B.size[2] - 0.454 * S : (OPENING[type] || 2) * S, rise + 0.05 * S, 0.92 * B.size[2]);
  const zs = Math.max(0.02 * B.size[2], crown - rise), yFace = Math.max(B.min[1], -(spec.depth || S / 4) / 2);
  const p = arcade ? Math.max(1.05 * S, (B.size[0] - 0.789 * S) / N) : 0;   // bay axis spacing
  const xLast = ((N - 1) / 2) * p;                                         // the last bay's axis
  if (!arcade) {
    // on the right impost: the springing of the intrados moves half the span change
    out.push(grip({ id: 'span', field: 'span', label: 'Span', anchor: [S / 2, yFace, zs], dir: X, value: S, min: 0.5, max: 20,
      perMetre: 2 }));
  } else {
    out.push(endGrip(B, { id: 'length', field: 'length', label: 'Length', value: spec.length || B.size[0],
      min: Math.max(1.5, 0.4 * p), max: 100, anchor: [B.max[0], B.cy, 0.97 * B.max[2]],   // the crowning cornice's end
      apply: (v) => ({ length: v, bays: undefined }) }));
    // on the last bay's right impost: one more bay moves it half a bay
    const ticks = Array.from({ length: 20 }, (_, i) => ({ v: i + 1 }));
    out.push(grip({ id: 'bays', field: 'bays', label: 'Bays', kind: 'count', anchor: [xLast + S / 2, yFace, zs], dir: X,
      value: N, min: 1, max: 20, ticks, perMetre: 2 / p, apply: (v) => ({ bays: v, length: undefined }) }));
  }
  out.push(heightGrip(B, spec.height || B.size[2], hRange, { anchor: [B.cx, yFace, B.max[2]] }));
  // rise: the arch type sets it (rise / span); on the crown of the (middle) opening
  const ticks = RISE.map((t) => ({ v: Math.round(t.v * S * 1000) / 1000, label: t.label }));
  const typeAt = (v) => ticks.reduce((q, t) => (Math.abs(t.v - v) < Math.abs(q.v - v) ? t : q), ticks[0]).label;
  out.push(grip({ id: 'rise', field: 'archType', label: 'Rise', kind: 'length', anchor: [arcade && N % 2 === 0 ? p / 2 : 0, yFace, crown],
    dir: Z, value: rise, min: ticks[0].v, max: ticks[ticks.length - 1].v, ticks, perMetre: 1,
    apply: (v) => ({ archType: typeAt(v) }),
    format: (v) => `${(Math.round(v * 100) / 100).toFixed(2)} m · ${typeAt(v)}` }));
  return out;
}

// ------------------------------------------------------------------------------------------------ roof

const TYPE_PITCH = { gable: [35, 35], hip: [35, 35], pyramid: [35, 35], shed: [15, 15], mansard: [70, 30], gambrel: [60, 25] };   // roof.js

function roofGrips(spec, B) {
  const type = spec.roofType || 'hip', L = spec.length ?? DEFAULTS.roof.length, W = spec.width ?? DEFAULTS.roof.width;
  const short = Math.min(L, W), k = short >= 2 ? Math.min(1.5, Math.sqrt(short / 8)) : short / 4;
  const two = type === 'mansard' || type === 'gambrel';
  let [lo, up] = TYPE_PITCH[type] || TYPE_PITCH.hip;
  const p0 = spec.pitch;
  if (fin(p0)) { if (two) { if (p0 >= 45) lo = p0; else up = Math.min(p0, lo - 5); } else lo = up = p0; }
  // z = A + run tan(pitch) (the upper pitch of a mansard / gambrel); run = half the short span (a shed: all of it)
  const run = type === 'shed' ? short : two ? 0.45 * short / 2 : short / 2;
  let p = two ? up : lo, A = B.size[2] - run * Math.tan(p * D2R);
  if (spec.height) { A = 0.68 * k * (two ? 4 : 1); p = clamp(Math.atan(Math.max(0, B.size[2] - A) / run) * R2D, 5, two ? lo - 5 : 75); }
  const zAt = (deg) => A + run * Math.tan(deg * D2R);
  const oMin = 0.311 * k;                                    // roof.js: cornice + fascia + gutter in front of the wall line
  const o = spec.overhang ?? (B.size[1] - W) / 2;
  const keepLower = two && fin(p0) && p0 >= 45;
  // a mansard / gambrel reads a pitch >= 45 as its lower slope: the (upper) pitch grip stays below it
  const pMax = two ? Math.min(44, lo - 5) : 75;
  // anchors on the roof: an eave side at the fascia (about the cornice's height above the wall head), a verge (gable
  // end) at its apex - a shed's half-way up; the ridge runs along the longer side; the pitch half-way down the front
  // slope (on a ridge along Y, the right slope)
  const swap = W > L, hipped = type === 'hip' || type === 'pyramid' || type === 'mansard';
  const zEave = Math.min(0.3 * k, 0.5 * B.size[2]), zVerge = type === 'shed' ? B.size[2] / 2 : 0.97 * B.size[2];
  const zX = !hipped && !swap ? zVerge : zEave, zY = !hipped && swap ? zVerge : zEave;
  // a mansard's height is the top of the épis at its ridge ends (roof.js: 1.25 k tall, not at detail low), the ridge
  // between them that much lower; the height grip sits on an épi, at x = (L - W) / 2 (the ridge of the hipped upper roof)
  const epi = type === 'mansard' && spec.detail !== 'low' ? 1.25 * k : 0;
  const ridgeZ = B.max[2] - epi, ridgeEnd = Math.abs(L - W) / 2;
  const top = epi ? (swap ? [B.cx, B.cy + ridgeEnd, B.max[2]] : [B.cx + ridgeEnd, B.cy, B.max[2]]) : [B.cx, B.cy, B.max[2]];
  const zSlope = Math.max(zEave, ridgeZ - (run / 2) * Math.tan(p * D2R));
  const slope = type === 'shed' ? [B.cx, B.cy, B.size[2] / 2] : swap ? [B.cx + run / 2, B.cy, zSlope] : [B.cx, B.cy - run / 2, zSlope];
  return [
    endGrip(B, { id: 'length', field: 'length', label: 'Length', value: L, min: 2, max: 60, anchor: [B.max[0], B.cy, zX] }),
    endGrip(B, { id: 'width', field: 'width', label: 'Width', value: W, min: 2, max: 40, axis: 1, anchor: [B.cx, B.max[1], zY] }),
    heightGrip(B, spec.height || B.size[2], [Math.max(0.3, zAt(two ? 8 : 10)), zAt(two ? Math.min(40, pMax - 3) : 70)], {
      anchor: top, apply: (v) => (keepLower ? { height: v } : { height: v, pitch: undefined }) }),
    pitchGrip(B, p, [5, pMax], run / 2, { height: undefined }, { anchor: slope, ...(two ? { label: 'Upper pitch' } : {}) }),
    grip({ id: 'overhang', field: 'overhang', label: 'Overhang', anchor: [B.cx, B.min[1], zY], dir: NY, value: o,
      min: Math.round((oMin + 0.005) * 1000) / 1000, max: 3, perMetre: 1, axis: 1 }),
  ];
}

// ------------------------------------------------------------------------------------------------ the rest

function domeGrips(spec, B) {
  if (spec.element === 'spire') {
    const H = spec.height || 14, W = spec.width || 3;
    return [
      heightGrip(B, H, [Math.max(1, 1.25 * W), 120]),
      // on the base course (dome.js spirePlan: min(0.06 W, 0.04 H) high), where the spire is widest
      endGrip(B, { id: 'width', field: 'width', label: 'Width', value: W, min: 0.6, max: Math.min(30, 0.8 * H),
        anchor: [B.max[0], B.cy, Math.min(0.06 * W, 0.04 * H) / 2] }),
    ];
  }
  // on the shell where its radius is D / 2 (measured on the default builds: a drum puts the springing at about 0.4 of
  // the height of a dome, 0.58 of a cupola; without one, 0.12 / 0.15): that point moves half the diameter change
  const cup = spec.element === 'cupola', d = spec.diameter || (cup ? 2.4 : 8), drum = spec.drum !== false;
  const zf = (cup ? (drum ? 0.58 : 0.15) : drum ? 0.4 : 0.12) * B.size[2];
  return [grip({ id: 'diameter', field: 'diameter', label: 'Diameter', anchor: [d / 2, B.cy, zf], dir: X, value: d,
    min: cup ? 0.5 : 1, max: cup ? 12 : 60, perMetre: 2 })];
}

function finialGrips(spec, B) {
  const el = spec.element, H = spec.height || (el === 'obelisk' ? 6 : el === 'urn' ? 0.9 : 0.8);
  return [heightGrip(B, H, el === 'obelisk' ? [0.5, 60] : [0.1, 4])];
}

function consoleGrips(spec, B) {
  return [
    heightGrip(B, spec.height || 0.6, [0.1, 3]),
    // the console's cap spans its full width and depth: width at the cap's right end, depth at its front (the console
    // stands centred on Y, its back on +Y against the wall), height at the cap's centre
    endGrip(B, { id: 'width', field: 'width', label: 'Width', value: spec.width || 0.26, min: 0.05, max: 2,
      anchor: [B.max[0], B.cy, 0.97 * B.max[2]] }),
    grip({ id: 'depth', field: 'depth', label: 'Depth', anchor: [B.cx, B.min[1], 0.97 * B.max[2]], dir: NY, axis: 1,
      value: spec.depth || 0.42, min: 0.05, max: 2.5, perMetre: 2, extent: Math.abs(B.size[1] - (spec.depth || 0.42)) < 0.005 }),
  ];
}

const FAMILY = {
  column: columnGrips, pilaster: columnGrips, capital: columnGrips, base: columnGrips, pedestal: columnGrips,
  entablature: entablatureGrips, cornice: entablatureGrips, moulding: entablatureGrips, pediment: entablatureGrips,
  window: entablatureGrips, door: entablatureGrips,
  portico: porticoGrips, balustrade: balustradeGrips, baluster: balustradeGrips,
  arch: archGrips, arcade: archGrips, roof: roofGrips,
  dome: domeGrips, cupola: domeGrips, spire: domeGrips,
  finial: finialGrips, urn: finialGrips, obelisk: finialGrips, console: consoleGrips,
};

/** Grips of a built element (see the header). Never throws on a sane spec; unknown elements give []. */
export function gripsFor(spec, info) {
  if (!spec || !Object.hasOwn(FAMILY, spec.element)) return [];
  const B = boxOf(spec, info);
  return FAMILY[spec.element](spec, B, info).filter((g) => g && fin(g.value));
}

// ------------------------------------------------------------------------------------------------ typed values

/** Lower diameter D of a column-family element or a portico's columns (for '9D'), else null. */
function moduleOf(spec) {
  if (!spec) return null;
  if (['column', 'pilaster', 'capital', 'base', 'pedestal'].includes(spec.element)) return colDims(spec).D;
  if (spec.element === 'portico') return porticoD(spec);
  return null;
}

const NUM = '(\\d+(?:[.,]\\d*)?|[.,]\\d+)';
const toNum = (s) => Number(String(s).replace(',', '.'));
const LEN_UNITS = { m: 1, metre: 1, metres: 1, meter: 1, meters: 1, cm: 0.01, mm: 0.001 };
const RE = {
  pct: new RegExp(`^${NUM}\\s*%$`),
  metric: new RegExp(`^${NUM}\\s*(m|metres?|meters?|cm|mm)?$`),
  feet: new RegExp(`^${NUM}\\s*(?:'|’|ft|feet|foot)\\s*(?:${NUM}\\s*(?:"|”|''|in|inch|inches)?)?$`),
  inches: new RegExp(`^${NUM}\\s*(?:"|”|''|in|inch|inches)$`),
  module: new RegExp(`^${NUM}\\s*d$`),
  angle: new RegExp(`^${NUM}\\s*(°|º|deg|degs|degrees?)?$`),
  count: new RegExp(`^${NUM}\\s*(columns?|balusters?|bays?)?$`),
};

/** A typed value for a grip: '4.5', '4.5 m', '450 cm', '4500 mm', "12'", '12 ft 6 in', '9D', '+0.5', '-10%', '35°',
 *  '35 deg', '6', 'hexastyle' (a tick's label). Returns the snapped value, or null when it cannot be read. */
export function parseTyped(text, grip, spec) {
  if (!grip || (typeof text !== 'string' && typeof text !== 'number')) return null;
  let t = String(text).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  if (grip.ticks) for (const tk of grip.ticks) if (tk.label && tk.label.toLowerCase() === t) return grip.snap(tk.v);
  let sign = 0;
  if (t[0] === '+' || t[0] === '-' || t[0] === '−') { sign = t[0] === '+' ? 1 : -1; t = t.slice(1).trim(); }
  let m = t.match(RE.pct), q = null;
  if (m) {
    const f = toNum(m[1]) / 100;
    q = sign ? grip.value * (1 + sign * f) : grip.value * f;
    return fin(q) ? grip.snap(q) : null;
  }
  if (grip.kind === 'angle') {
    if ((m = t.match(RE.angle))) q = toNum(m[1]);
  } else if (grip.kind === 'count') {
    if ((m = t.match(RE.count))) q = toNum(m[1]);
  } else if ((m = t.match(RE.metric))) q = toNum(m[1]) * (LEN_UNITS[m[2] || 'm'] ?? 1);
  else if ((m = t.match(RE.feet))) q = toNum(m[1]) * 0.3048 + (m[2] ? toNum(m[2]) * 0.0254 : 0);
  else if ((m = t.match(RE.inches))) q = toNum(m[1]) * 0.0254;
  else if ((m = t.match(RE.module))) { const D = moduleOf(spec); q = D ? toNum(m[1]) * D : null; }
  if (!fin(q)) return null;
  const v = sign ? grip.value + sign * q : q;
  return fin(v) ? grip.snap(v) : null;
}
