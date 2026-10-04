// Roofs: gable, hip, mansard, gambrel, pyramid and shed (lean-to) over a rectangular footprint, built the way a roofer
// builds them: a moulded eaves cornice (wall plate) on the wall head, a rafter deck with plumb-cut eaves and a boarded
// soffit, fascia and barge boards, a hung half-round gutter on brackets, the covering laid course by course as
// instanced pieces (cut along hips, ridges and verges like real cut tiles), ridge and hip tiles, mansard curbs and
// finials. Z-up, metres, origin at the centre of the footprint on the wall head (z = 0 = underside of the cornice).
//
// Conventions of this family (documented decisions):
// - Footprint: `length` runs along X, `width` along Y (the family convention "length along X"); the ridge runs along the
//   LONGER side: when width > length the roof is built with the ridge on Y (the whole roof turned 90°).
// - `overhang` o = horizontal distance from the wall line to the outermost point of the roof (the gutter's rolled bead
//   at the eaves, the barge board's face at the verges); the same on all four sides, so the bbox is
//   (length + 2o) × (width + 2o). Unset: 0.55 m at an 8 m span, less where a steep eave would drop below the wall head.
//   spec.overhang (0–3 m) is honoured down to the smallest eave that clears the cornice (≈ 0.31 m at 8 m: cornice
//   projection + fascia + gutter). A long overhang on a low pitch does not hang the eave below the wall head: the eave
//   is held up and the wall rises above the cornice as a knee wall (Kniestock), as on a chalet.
// - Height: z = top of the ridge tiles (or of the finial on a pyramid / mansard, or of the capping of a shed). With
//   spec.height given, the pitch (the upper pitch on a mansard / gambrel) is solved so that the roof is that tall.
// - Pitches (TYPE_PITCH, used when spec.pitch is unset): gable / hip / pyramid 35°, shed 15° (a lean-to is low),
//   mansard lower 70° / upper 30°, gambrel lower 60° / upper 25° (French and Dutch practice). A given pitch is used
//   as-is on single-pitch roofs; on a mansard / gambrel it replaces the lower pitch when ≥ 45° and the upper pitch when
//   < 45°. A pyramid on a rectangle keeps the pitch on the long sides; its end slopes come out flatter so all four meet
//   in one apex.
// - Dormers (spec.dormers): true → on gable, hip and mansard roofs; false → none; unset → mansards at detail high.
// - Covering (real sizes): tiles = Swiss "Biberschwanz" beaver-tail plain tiles 18 × 38 cm, round tail, double lap
//   ("Doppeldeckung", gauge 15 cm); slate = rectangular double-lap slates 40 × 25 cm (gauge 16 cm); shingles = split
//   larch shingles 7–13 cm wide, 36 cm, triple lap (gauge 12 cm); pantiles = S pantiles, 21 cm cover width, gauge 32 cm,
//   laid in straight columns; seam = double-lock standing seam, 53 cm pans, 3 cm seams. Courses are staggered by half a
//   tile; every piece is tilted like a real lapped tile (its tail rests on the course below). When the material names
//   a covering and the covering is the default (tiles): slate → slate, copper / zinc / lead → standing seam,
//   wood → shingles.
// - Tiles are only scaled for tiny roofs (< 2.5 m span) and for huge ones (to keep the covering under ~1 M triangles).

import { DEFAULTS } from '../spec.js';
import { K, TAU, mat, instances, box, union, part, extrudeXY, extrudeProfileX, revolve, loft, placeParts } from '../kernel.js';
import { Prof } from '../profiles.js';

export const ELEMENTS = ['roof'];

const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
/** Column-major matrix with axis columns X, Y, Z (may carry scale) and translation T. */
function frame(X, Y, Z, T) {
  return Float64Array.from([X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, Z[0], Z[1], Z[2], 0, T[0], T[1], T[2], 1]);
}
function rng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const segsFor = (detail, hi, med, lo) => (detail === 'low' ? lo : detail === 'medium' ? med : hi);

// ------------------------------------------------------------------------------------------------ covering catalogue

// Real sizes in metres. w: cover width (module across the slope), L: piece length, t: thickness at the tail, g: gauge
// (batten spacing = exposed length), lap: double/triple lap lift, proj: projection of the eave course over the deck edge.
const COVER = {
  tiles: { w: 0.18, L: 0.38, t: 0.014, g: 0.15, gap: 0.004, proj: 0.07, stagger: true, eave: true, ridge: 'piece', tris: 44 },
  slate: { w: 0.25, L: 0.40, t: 0.009, g: 0.16, gap: 0.005, proj: 0.06, stagger: true, eave: true, ridge: 'roll', tris: 12 },
  shingles: { w: 0.10, wMin: 0.07, wMax: 0.13, L: 0.36, t: 0.012, g: 0.12, gap: 0.004, proj: 0.05, stagger: 'random', eave: true, ridge: 'boards', tris: 12 },
  pantiles: { w: 0.21, P: 0.245, L: 0.40, t: 0.013, g: 0.32, A: 0.05, proj: 0.07, stagger: false, eave: false, ridge: 'piece', tris: 190 },
  seam: { w: 0.53, L: 1, t: 0.003, g: 1, sh: 0.032, sw: 0.009, proj: 0.04, ridge: 'roll', tris: 30 },
};
const COVER_NAME = { tiles: 'tile', slate: 'slate', shingles: 'shingle', pantiles: 'pantile', seam: 'pan' };

// Materials a roof covering can be made of (a stated material outside this set describes the masonry: cornice, walls).
const ROOFING = new Set(['terracotta', 'brick', 'concrete', 'slate', 'copper', 'zinc', 'lead', 'wood', 'gold']);
const METALS = new Set(['copper', 'zinc', 'lead', 'gold']);
const MASONRY = new Set(['marble', 'limestone', 'sandstone', 'granite', 'travertine', 'plaster']);
const COVER_MATERIAL = { tiles: 'terracotta', pantiles: 'terracotta', slate: 'slate', seam: 'zinc', shingles: 'wood' };

/** The covering: a stated covering always wins; unset, the stated material chooses it (copper / zinc / lead / gold →
 *  standing seam, slate → slate, wood → shingles, terracotta / brick / concrete → tiles); otherwise plain tiles. */
function effectiveCovering(spec) {
  if (spec.covering !== undefined && spec.covering !== null) return spec.covering;
  const m = spec.material;
  if (METALS.has(m)) return 'seam';
  if (m === 'slate') return 'slate';
  if (m === 'wood') return 'shingles';
  return 'tiles';
}

/** What each kind of piece is made of (part meta.material; the viewer's roles alone cannot say it).
 *  Covering: the stated material when it is a roofing material ("copper tiles" are copper tiles, like copper shingles
 *  or zinc diamond tiles in Swiss practice; a standing seam needs a metal), else the covering's own material (tiles and
 *  pantiles terracotta, slate slate, seam zinc, shingles wood). A stated masonry material (marble, limestone, sandstone,
 *  granite, travertine, plaster) goes to the cornice and the walls instead; they default to limestone and plaster.
 *  Metalwork (gutters, flashings, rolls, snow guards) matches a metal covering, is zinc on slate (French practice) and
 *  copper otherwise; finials are gilded when the material is gold. */
function materials(spec, cover) {
  const m = spec.material;
  const covering = m && ROOFING.has(m) && (cover !== 'seam' || METALS.has(m)) ? m : COVER_MATERIAL[cover];
  const metal = METALS.has(covering) && covering !== 'gold' ? covering : cover === 'slate' ? 'zinc' : 'copper';
  const stone = MASONRY.has(m) ? m : null;
  return { covering, metal, finial: m === 'gold' ? 'gold' : metal, wood: 'wood', cornice: stone || 'limestone', wall: stone || 'plaster',
    coverRole: covering === 'wood' ? 'wood' : 'roof' };
}

// ------------------------------------------------------------------------------------------------ dimensions

/** Each roof type's own pitches (degrees) when the text gives none: [eave / lower, upper]. A lean-to (Pultdach) is a
 *  low roof; mansard and gambrel follow French and Dutch practice. */
export const TYPE_PITCH = { gable: [35, 35], hip: [35, 35], pyramid: [35, 35], shed: [15, 15], mansard: [70, 30], gambrel: [60, 25] };

/** Pitches { lo: eave (lower) pitch, up: upper pitch }. spec.pitch undefined = not given → the type's own pitches. A
 *  given pitch is used as-is on single-pitch roofs; on a mansard / gambrel it replaces the lower slope when ≥ 45° (only
 *  a steep figure can describe the brisis) and the upper slope when < 45°. */
function pitches(spec, type) {
  let [lo, up] = TYPE_PITCH[type] || TYPE_PITCH.hip;
  const p = spec.pitch;
  if (p === undefined || p === null) return { lo, up };
  if (type === 'mansard' || type === 'gambrel') { if (p >= 45) lo = p; else up = Math.min(p, lo - 5); }
  else lo = up = p;
  return { lo, up };
}

/** Everything the build and the tests need, from the normalised spec. Pure arithmetic (no kernel calls). */
export function dims(spec) {
  const type = spec.roofType || 'hip';
  const W = spec.width ?? DEFAULTS.roof.width, Lx = spec.length ?? DEFAULTS.roof.length;
  const long = Math.max(W, Lx), short = Math.min(W, Lx);
  const k = short >= 2 ? Math.min(1.5, Math.sqrt(short / 8)) : short / 4;   // scale of the eaves members
  const D = {
    type, swap: W > Lx, W, Lx, long, short, a: long / 2, b: short / 2, k,
    cover: effectiveCovering(spec), detail: spec.detail || 'high', overhang: spec.overhang,
    // eaves members (k = 1 at an 8 m span): cornice / wall plate, rafter deck, fascia, barge, gutter
    hc: 0.30 * k, pc: 0.10 * k, tn: 0.18 * k, tf: 0.035 * k, tb: 0.04 * k, db: 0.04 * k,
    rg: 0.07 * k, gt: 0.004 * k, rb: 0.011 * k, tcap: 0.004 * k,
  };
  D.gw = 2 * D.rg + 2 * D.rb - 1.5 * D.gt;            // gutter projection in front of the fascia
  D.coverMat = materials(spec, D.cover).covering;
  let { lo, up } = pitches(spec, type);
  levels(D, lo, up);
  if (spec.height) solveHeight(D, spec.height);
  return D;
}

function levels(D, lo, up) {
  const { type, a, b, k } = D;
  const pe = lo * DEG, tl = Math.tan(pe), tu = Math.tan(up * DEG);
  D.lo = lo; D.up = up; D.pe = pe;
  D.tv = Math.min(D.tn / Math.cos(pe), 2 * D.tn);     // deck thickness measured vertically
  // slab overhang beyond the wall line. Default: 0.55 m to the gutter front, shortened on steep eaves so that the
  // soffit, resting on the cornice's outer edge, never drops below the wall head. Given (spec.overhang, wall line to
  // the outermost point): honoured down to the smallest eave that clears the cornice (fascia + gutter in front of it)
  const oMin = D.pc + 0.02 * k + D.tf + D.gw;
  let oS;
  if (D.overhang !== undefined && D.overhang !== null) oS = Math.max(D.overhang, oMin) - D.tf - D.gw;
  else oS = clamp(0.55 * k - D.tf - D.gw, D.pc + 0.02 * k, Math.max(D.pc + 0.02 * k, D.pc + (D.hc - 0.05 * k) / tl));
  D.oS = oS; D.o = oS + D.tf + D.gw;
  D.hipped = type === 'hip' || type === 'pyramid' || type === 'mansard';
  D.Ax = D.hipped ? a + oS : a + D.o - D.tb;         // deck half-length along the ridge
  D.B = b + oS;                                       // deck half-span at the eaves
  D.B1 = type === 'shed' ? b + D.o - D.tf - D.tcap : D.B;
  // the deck's soffit rests on the cornice's outer top edge (y = b + pc, z = hc). A long overhang would bring the eave
  // below the wall head: the eave is held up instead and the wall rises above the cornice as a knee wall (Kniestock)
  const zE0 = D.hc + D.tv - (oS - D.pc) * tl, zEmin = D.tv + 0.05 * k;
  D.knee = zE0 < zEmin - 1e-9;
  D.zE = Math.max(zE0, zEmin);
  D.R = 0;
  if (type === 'gable') { D.zR = D.zE + D.B * tl; D.R = D.Ax; }
  else if (type === 'hip') { D.zR = D.zE + D.B * tl; D.R = Math.max(0, D.Ax - D.B); }
  else if (type === 'pyramid') D.zR = D.zE + D.B * tl;
  else if (type === 'shed') D.zR = D.zE + (D.B + D.B1) * tl;
  else {
    // mansard: the steep brisis holds an attic storey (≈ 1/3 of the span, at most 3.2 m); gambrel: ≈ 0.3 of the span
    let hL = type === 'mansard' ? Math.min(0.34 * D.short, 3.2) : Math.min(0.30 * D.short, 3.4);
    hL = Math.min(hL, 0.6 * D.B * tl);
    D.hL = hL; D.rL = hL / tl; D.zB = D.zE + hL;
    D.A2 = type === 'mansard' ? D.Ax - D.rL : D.Ax; D.B2 = D.B - D.rL;
    D.zR = D.zB + D.B2 * tu;
    D.R = type === 'mansard' ? Math.max(0, D.A2 - D.B2) : D.Ax;
  }
  covering(D);
  tops(D);
}

/** Covering sizes (scaled only for tiny or huge roofs) and its height above the deck. */
function covering(D) {
  const C0 = COVER[D.cover];
  let kt = Math.min(1, D.short / 2.5);
  const flat = Math.min(D.lo, D.up) * DEG;
  const area = (2 * D.Ax + 0.2) * (D.B + D.B1 + 0.2) / Math.cos(flat);
  const count = (s) => area / (C0.w * C0.g * s * s);
  if (D.detail !== 'low') {
    // keep the covering under ~1 M triangles and 60 000 pieces: tiles grow on very large roofs (they read as texture)
    if (count(kt) * C0.tris > 1.0e6) kt = Math.sqrt((area * C0.tris) / (C0.w * C0.g * 1.0e6));
    if (count(kt) > 60000) kt = Math.sqrt(area / (C0.w * C0.g * 60000));
  }
  const C = { ...C0 };
  for (const key of ['w', 'wMin', 'wMax', 'L', 't', 'g', 'gap', 'proj', 'P', 'A', 'sh', 'sw']) if (C[key] !== undefined) C[key] *= kt;
  if (D.cover === 'seam') { C.L = 1; C.g = 1; }
  if (D.cover === 'shingles' && D.coverMat !== 'wood') C.ridge = 'roll';   // metal shingles get a metal ridge roll
  C.kt = kt;
  // lift of the tail: a lapped piece rests on the course below; double lap needs lift = t·L/g
  C.lift = D.cover === 'seam' ? 0 : D.cover === 'pantiles' ? C.t : (C.t * C.L) / C.g;
  C.alpha = D.cover === 'seam' ? 0 : Math.asin(Math.min(0.3, C.lift / C.L));
  C.hT = D.cover === 'seam' ? C.t + C.sh : D.cover === 'pantiles' ? C.lift + C.t + C.A : C.lift + C.t;
  // the eave course reaches about a third into the gutter, never past it (its top edge leans out by hT·sin pitch)
  C.proj = clamp((D.tf + 0.4 * D.gw - C.hT * Math.sin(D.pe)) / Math.cos(D.pe), -0.3 * C.L, C.proj);
  // ridge / hip covering (half-round clay pieces, metal roll on a saddle, or two oak boards)
  C.R = { le: 0.13 * kt, c: 0.012 * kt, tr: 0.017 * kt, Lr: 0.42 * kt, lr: 0.36 * kt, fr: 0.012 * kt,
    ts: 0.004 * kt, rr: 0.028 * kt, tbd: 0.026 * kt, leB: 0.15 * kt, leS: 0.12 * kt };
  D.C = C;
}

/** Height of the top of the roof (ridge covering, finial or shed capping) above z = 0. */
function tops(D) {
  const C = D.C, type = D.type;
  D.finialH = 0;
  if (type === 'shed') {
    const cap = shedCapping(D);
    D.zTop = Math.max(...cap.map((q) => q[1]));
    return;
  }
  // hips meeting in one point (pyramid, or a hip / mansard on a square) carry a finial; a mansard has two épis
  D.apex = type === 'pyramid' || ((type === 'hip' || type === 'mansard') && D.R < 1e-6);
  if (D.apex || (type === 'mansard' && D.detail !== 'low')) D.finialH = (type === 'mansard' ? 1.25 : 1.0) * D.k;
  const pr = (type === 'mansard' || type === 'gambrel' ? D.up : D.lo) * DEG;
  const off = C.hT / Math.cos(pr);
  if (D.apex) {
    D.zApex = D.zR + off;
    D.zTop = D.zApex - 0.02 * D.k + D.finialH;
    return;
  }
  const sec = ridgeSection(C.ridge, pr, C, 16);
  D.zTop = D.zR + off + sec.top;
  if (D.finialH) D.zTop = Math.max(D.zTop, D.zR + off + sec.top * 0.5 + D.finialH);
}

/** Pitch solver for spec.height: varies the (upper) pitch until the roof's top is at the requested height. */
function solveHeight(D, H) {
  const varyUp = D.type === 'mansard' || D.type === 'gambrel';
  const lo0 = D.lo;
  const f = (p) => { if (varyUp) levels(D, lo0, p); else levels(D, p, p); return D.zTop; };
  let l = 5, h = varyUp ? lo0 - 2 : 75;
  if (f(l) >= H) { f(l); return; }
  if (f(h) <= H) { f(h); return; }
  for (let i = 0; i < 60; i++) { const m = (l + h) / 2; if (f(m) < H) l = m; else h = m; }
  f((l + h) / 2);
}

// ------------------------------------------------------------------------------------------------ roof faces

function newell(P) {
  const n = [0, 0, 0];
  for (let i = 0; i < P.length; i++) {
    const p = P[i], q = P[(i + 1) % P.length];
    n[0] += (p[1] - q[1]) * (p[2] + q[2]); n[1] += (p[2] - q[2]) * (p[0] + q[0]); n[2] += (p[0] - q[0]) * (p[1] + q[1]);
  }
  return V.norm(n);
}

/** A planar roof face: vertices counter-clockwise seen from outside; edges[i] describes P[i] → P[i+1]:
 *  { kind: 'eave' | 'brk' (free bottom edges) | 'verge' | 'high' | 'nb' (shared with face nb) }. */
function makeFace(P0, E0) {
  const P = [], edges = [];
  for (let i = 0; i < P0.length; i++) {
    const q = P0[(i + 1) % P0.length];
    if (V.len(V.sub(P0[i], q)) < 1e-9) continue;     // degenerate edge (a hip roof on a square: no ridge)
    P.push(P0[i]); edges.push(E0[i]);
  }
  const n = newell(P);
  const e = V.norm([-n[1], n[0], 0]), s = V.cross(n, e);
  const us = P.map((p) => V.dot(p, e)), vs = P.map((p) => V.dot(p, s));
  const u0 = (Math.min(...us) + Math.max(...us)) / 2, v0 = Math.min(...vs);
  const O = V.add(V.add(V.mul(n, V.dot(P[0], n)), V.mul(e, u0)), V.mul(s, v0));
  return { P, edges, n, e, s, O, uv: P.map((_, i) => [us[i] - u0, vs[i] - v0]) };
}

/** Faces, ridge / hip / break lines and the deck hull points of the roof (local frame: ridge along X). */
function geometry(D) {
  const { type, Ax, B, B1, zE, zR, R } = D;
  const X = D.hipped ? Ax : Ax + D.tb;                 // covering reaches the barge boards' faces at the verges
  const xo = D.a + D.o;                                // outer face of the barge boards
  const nb = (i) => ({ kind: 'nb', nb: i }), eave = { kind: 'eave' }, verge = { kind: 'verge' }, brk = { kind: 'brk' };
  const F = [];
  const lines = [];
  const L = (P0, P1, fa, fb, kind) => lines.push({ P0, P1, fa, fb, kind });
  if (type === 'gable') {
    F.push([[[-X, -B, zE], [X, -B, zE], [X, 0, zR], [-X, 0, zR]], [eave, verge, nb(1), verge]]);
    F.push([[[X, B, zE], [-X, B, zE], [-X, 0, zR], [X, 0, zR]], [eave, verge, nb(0), verge]]);
    L([-xo, 0, zR], [xo, 0, zR], 0, 1, 'ridge');
  } else if (type === 'hip' || type === 'pyramid') {
    const r = type === 'hip' ? R : 0;
    F.push([[[-Ax, -B, zE], [Ax, -B, zE], [r, 0, zR], [-r, 0, zR]], [eave, nb(1), nb(2), nb(3)]]);
    F.push([[[Ax, -B, zE], [Ax, B, zE], [r, 0, zR]], [eave, nb(2), nb(0)]]);
    F.push([[[Ax, B, zE], [-Ax, B, zE], [-r, 0, zR], [r, 0, zR]], [eave, nb(3), nb(0), nb(1)]]);
    F.push([[[-Ax, B, zE], [-Ax, -B, zE], [-r, 0, zR]], [eave, nb(0), nb(2)]]);
    if (r > 1e-6) L([-r, 0, zR], [r, 0, zR], 0, 2, 'ridge');
    L([Ax, -B, zE], [r, 0, zR], 0, 1, 'hip'); L([Ax, B, zE], [r, 0, zR], 1, 2, 'hip');
    L([-Ax, B, zE], [-r, 0, zR], 2, 3, 'hip'); L([-Ax, -B, zE], [-r, 0, zR], 3, 0, 'hip');
  } else if (type === 'shed') {
    F.push([[[-X, -B, zE], [X, -B, zE], [X, B1, zR], [-X, B1, zR]], [eave, verge, { kind: 'high' }, verge]]);
  } else if (type === 'mansard') {
    const { A2, B2, zB } = D, r = R;
    F.push([[[-Ax, -B, zE], [Ax, -B, zE], [A2, -B2, zB], [-A2, -B2, zB]], [eave, nb(1), nb(4), nb(3)]]);
    F.push([[[Ax, -B, zE], [Ax, B, zE], [A2, B2, zB], [A2, -B2, zB]], [eave, nb(2), nb(5), nb(0)]]);
    F.push([[[Ax, B, zE], [-Ax, B, zE], [-A2, B2, zB], [A2, B2, zB]], [eave, nb(3), nb(6), nb(1)]]);
    F.push([[[-Ax, B, zE], [-Ax, -B, zE], [-A2, -B2, zB], [-A2, B2, zB]], [eave, nb(0), nb(7), nb(2)]]);
    F.push([[[-A2, -B2, zB], [A2, -B2, zB], [r, 0, zR], [-r, 0, zR]], [brk, nb(5), nb(6), nb(7)]]);
    F.push([[[A2, -B2, zB], [A2, B2, zB], [r, 0, zR]], [brk, nb(6), nb(4)]]);
    F.push([[[A2, B2, zB], [-A2, B2, zB], [-r, 0, zR], [r, 0, zR]], [brk, nb(7), nb(4), nb(5)]]);
    F.push([[[-A2, B2, zB], [-A2, -B2, zB], [-r, 0, zR]], [brk, nb(4), nb(6)]]);
    if (r > 1e-6) L([-r, 0, zR], [r, 0, zR], 4, 6, 'ridge');
    L([A2, -B2, zB], [r, 0, zR], 4, 5, 'hip'); L([A2, B2, zB], [r, 0, zR], 5, 6, 'hip');
    L([-A2, B2, zB], [-r, 0, zR], 6, 7, 'hip'); L([-A2, -B2, zB], [-r, 0, zR], 7, 4, 'hip');
    L([Ax, -B, zE], [A2, -B2, zB], 0, 1, 'hip-lower'); L([Ax, B, zE], [A2, B2, zB], 1, 2, 'hip-lower');
    L([-Ax, B, zE], [-A2, B2, zB], 2, 3, 'hip-lower'); L([-Ax, -B, zE], [-A2, -B2, zB], 3, 0, 'hip-lower');
    L([-A2, -B2, zB], [A2, -B2, zB], 0, 4, 'break'); L([A2, -B2, zB], [A2, B2, zB], 1, 5, 'break');
    L([A2, B2, zB], [-A2, B2, zB], 2, 6, 'break'); L([-A2, B2, zB], [-A2, -B2, zB], 3, 7, 'break');
  } else if (type === 'gambrel') {
    const { B2, zB } = D;
    F.push([[[-X, -B, zE], [X, -B, zE], [X, -B2, zB], [-X, -B2, zB]], [eave, verge, nb(2), verge]]);
    F.push([[[X, B, zE], [-X, B, zE], [-X, B2, zB], [X, B2, zB]], [eave, verge, nb(3), verge]]);
    F.push([[[-X, -B2, zB], [X, -B2, zB], [X, 0, zR], [-X, 0, zR]], [brk, verge, nb(3), verge]]);
    F.push([[[X, B2, zB], [-X, B2, zB], [-X, 0, zR], [X, 0, zR]], [brk, verge, nb(2), verge]]);
    L([-xo, 0, zR], [xo, 0, zR], 2, 3, 'ridge');
    L([-xo, -B2, zB], [xo, -B2, zB], 0, 2, 'break'); L([xo, B2, zB], [-xo, B2, zB], 1, 3, 'break');
  }
  const faces = F.map(([P, E]) => makeFace(P, E));
  // trimming planes (keep n·p ≥ d): the bisector between neighbouring faces; vertical planes at verges / high edge
  let pid = 0;
  for (const f of faces) {
    f.planes = f.edges.map((ed, i) => {
      const p = f.P[i];
      if (ed.kind === 'nb') { const N = V.norm(V.sub(f.n, faces[ed.nb].n)); return { N, d: V.dot(N, p) }; }
      if (ed.kind === 'verge') { const sx = Math.sign(p[0] + f.P[(i + 1) % f.P.length][0]); return { N: [-sx, 0, 0], d: -X }; }
      if (ed.kind === 'high') return { N: [0, -1, 0], d: -B1 };
      return null;
    }).map((pl) => pl && { ...pl, id: pid++ });
  }
  for (const l of lines) { l.nA = faces[l.fa].n; l.nB = faces[l.fb].n; }
  // deck hull: the faces with verges pulled back to the deck ends, plus the eave outline far below (vertical sides)
  const hull = [];
  const zLow = zE - 2 * D.tv - 0.5 * D.k;
  for (const f of faces) for (const p of f.P) hull.push([clamp(p[0], -Ax, Ax), p[1], p[2]]);
  for (const [x, y] of [[-Ax, -B], [Ax, -B], [Ax, B1], [-Ax, B1]]) hull.push([x, y, zLow]);
  // faces that, with their half-turn twins, make the whole roof (see build)
  const halfSet = { gable: [0], hip: [0, 1], pyramid: [0, 1], mansard: [0, 1, 4, 5], gambrel: [0, 2], shed: [0] }[type];
  return { faces, lines, hull, X, xo, halfSet };
}

// ------------------------------------------------------------------------------------------------ helpers

/** u-extent of a convex polygon (uv) along the horizontal line v. */
function sliceU(uv, v) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < uv.length; i++) {
    const p = uv[i], q = uv[(i + 1) % uv.length];
    if (Math.abs(p[1] - v) < 1e-12) { lo = Math.min(lo, p[0]); hi = Math.max(hi, p[0]); }
    if ((p[1] - v) * (q[1] - v) < 0) { const u = p[0] + ((v - p[1]) / (q[1] - p[1])) * (q[0] - p[0]); lo = Math.min(lo, u); hi = Math.max(hi, u); }
  }
  return [lo, hi];
}
/** Highest v of a convex polygon at u. */
function topV(uv, u) {
  let hi = -Infinity;
  for (let i = 0; i < uv.length; i++) {
    const p = uv[i], q = uv[(i + 1) % uv.length];
    if (Math.abs(p[0] - u) < 1e-12) hi = Math.max(hi, p[1]);
    if ((p[0] - u) * (q[0] - u) < 0) hi = Math.max(hi, p[1] + ((u - p[0]) / (q[0] - p[0])) * (q[1] - p[1]));
  }
  return hi;
}
/** Outer u-interval of the polygon over the band va..vb (clamped to the polygon). */
function bandU(uv, va, vb) {
  const vMin = Math.min(...uv.map((q) => q[1])), vMax = Math.max(...uv.map((q) => q[1]));
  const a = clamp(va, vMin, vMax), b = clamp(vb, vMin, vMax);
  let [lo, hi] = sliceU(uv, a);
  const [lo2, hi2] = sliceU(uv, b);
  lo = Math.min(lo, lo2); hi = Math.max(hi, hi2);
  for (const q of uv) if (q[1] > a && q[1] < b) { lo = Math.min(lo, q[0]); hi = Math.max(hi, q[0]); }
  return [lo, hi];
}

/** For a rectangle in face coordinates: null when it lies outside a cut edge, else the planes it crosses. */
function classify(f, rect) {
  const planes = [];
  const n = f.uv.length;
  for (let i = 0; i < n; i++) {
    if (!f.planes[i]) continue;
    const q0 = f.uv[i], q1 = f.uv[(i + 1) % n];
    const ex = q1[0] - q0[0], ey = q1[1] - q0[1], el = Math.hypot(ex, ey);
    let inside = 0;
    for (const p of rect) if ((ex * (p[1] - q0[1]) - ey * (p[0] - q0[0])) / el >= -1e-7) inside++;
    if (inside === 0) return null;
    if (inside < rect.length) planes.push(f.planes[i]);
  }
  return planes;
}

/** A piece lying on face f: tail centre at (u, v), tilted by alpha, tail lifted by lift; sx scales across. */
function onFace(f, u, v, { sx = 1, sy = 1, alpha = 0, lift = 0, spin = 0 } = {}) {
  const { e, s, n, O } = f;
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  let X = e, Y = V.sub(V.mul(s, ca), V.mul(n, sa));
  const Z = V.add(V.mul(n, ca), V.mul(s, sa));
  if (spin) { const c = Math.cos(spin), si = Math.sin(spin); const X2 = V.add(V.mul(X, c), V.mul(Y, si)); Y = V.sub(V.mul(Y, c), V.mul(X, si)); X = X2; }
  const T = V.add(O, V.add(V.mul(e, u), V.add(V.mul(s, v), V.mul(n, lift))));
  return frame(V.mul(X, sx), V.mul(Y, sy), Z, T);
}

/** Clip a closed triangle mesh (P: flat xyz, T: indices, counter-clockwise outside) to the half-space N·p ≥ d and cap
 *  the cut, so the result stays a closed 2-manifold. Vertices within 0.1 mm of the plane are snapped onto it (no sliver
 *  triangles where a cut passes through a corner); the cap is built from the kept surface's open edges, which all lie in
 *  the plane, chained into loops and ear-clipped. Returns { P, T } (compacted) or null when nothing is left. */
function clipMesh(P, T, N, d, eps = 1e-4) {
  const nv = P.length / 3, sd = new Float64Array(nv);
  let any = false, out = false;
  const Q = Array.from(P);
  for (let i = 0; i < nv; i++) {
    let v = N[0] * P[3 * i] + N[1] * P[3 * i + 1] + N[2] * P[3 * i + 2] - d;
    if (Math.abs(v) < eps) { Q[3 * i] -= v * N[0]; Q[3 * i + 1] -= v * N[1]; Q[3 * i + 2] -= v * N[2]; v = 0; }
    sd[i] = v; if (v > 0) any = true; if (v < 0) out = true;
  }
  if (!any) return null;
  if (!out) return { P: Q, T };
  const U = [], cross = new Map();
  const mid = (i, j) => {
    const key = i < j ? i * nv + j : j * nv + i;
    let k = cross.get(key);
    if (k === undefined) {
      const t = sd[i] / (sd[i] - sd[j]);
      k = Q.length / 3;
      Q.push(Q[3 * i] + (Q[3 * j] - Q[3 * i]) * t, Q[3 * i + 1] + (Q[3 * j + 1] - Q[3 * i + 1]) * t, Q[3 * i + 2] + (Q[3 * j + 2] - Q[3 * i + 2]) * t);
      cross.set(key, k);
    }
    return k;
  };
  for (let t = 0; t < T.length; t += 3) {
    const v = [T[t], T[t + 1], T[t + 2]], s = v.map((i) => sd[i]);
    if (s[0] >= 0 && s[1] >= 0 && s[2] >= 0) { U.push(v[0], v[1], v[2]); continue; }
    if (s[0] <= 0 && s[1] <= 0 && s[2] <= 0) continue;
    // Sutherland–Hodgman on one triangle: keep IN and ON vertices, add a point on every strictly crossing edge
    const poly = [];
    for (let k = 0; k < 3; k++) {
      const i = v[k], j = v[(k + 1) % 3], si = s[k], sj = s[(k + 1) % 3];
      if (si >= 0) poly.push(i);
      if ((si > 0 && sj < 0) || (si < 0 && sj > 0)) poly.push(mid(i, j));
    }
    for (let k = 1; k + 1 < poly.length; k++) U.push(poly[0], poly[k], poly[k + 1]);
  }
  // open edges of the kept surface lie in the plane; the cap runs along them the other way round
  const nQ = Q.length / 3, edges = new Set();
  for (let t = 0; t < U.length; t += 3) for (let k = 0; k < 3; k++) edges.add(U[t + k] * nQ + U[t + (k + 1) % 3]);
  const next = new Map();
  for (const e of edges) {
    const a = Math.floor(e / nQ), b = e % nQ;
    if (!edges.has(b * nQ + a)) next.set(b, a);
  }
  const e1 = V.norm(Math.abs(N[0]) < 0.9 ? V.cross(N, [1, 0, 0]) : V.cross(N, [0, 1, 0])), e2 = V.cross(N, e1);
  const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let k = start, guard = 0;
    while (k !== undefined && !seen.has(k) && guard++ < 100000) { seen.add(k); loop.push(k); k = next.get(k); }
    if (loop.length < 3) continue;
    earClip(loop, (i) => [Q[3 * i] * e1[0] + Q[3 * i + 1] * e1[1] + Q[3 * i + 2] * e1[2], Q[3 * i] * e2[0] + Q[3 * i + 1] * e2[1] + Q[3 * i + 2] * e2[2]], U);
  }
  // compact
  const map = new Int32Array(nQ).fill(-1), R = [];
  for (let i = 0; i < U.length; i++) {
    const o = U[i];
    if (map[o] < 0) { map[o] = R.length / 3; R.push(Q[3 * o], Q[3 * o + 1], Q[3 * o + 2]); }
    U[i] = map[o];
  }
  return U.length ? { P: R, T: U } : null;
}

/** Triangulate a simple polygon (vertex ids in order) by ear clipping, keeping its orientation; xy(id) → 2D point. */
function earClip(ids, xy, out) {
  const pts = ids.map(xy), idx = ids.map((_, i) => i);
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; area += p[0] * q[1] - q[0] * p[1]; }
  const sgn = area >= 0 ? 1 : -1;
  const cr = (a, b, c) => ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * sgn;
  while (idx.length > 3) {
    let best = -1, bestCr = -Infinity;
    for (let j = 0; j < idx.length; j++) {
      const a = pts[idx[(j + idx.length - 1) % idx.length]], b = pts[idx[j]], c = pts[idx[(j + 1) % idx.length]];
      const k = cr(a, b, c);
      if (k <= 0) { if (k > bestCr && best < 0) bestCr = k; continue; }
      let ear = true;
      for (let m = 0; m < idx.length && ear; m++) {
        const im = idx[m];
        if (m === j || m === (j + 1) % idx.length || m === (j + idx.length - 1) % idx.length) continue;
        const p = pts[im];
        if (cr(a, b, p) > 0 && cr(b, c, p) > 0 && cr(c, a, p) > 0) ear = false;
      }
      if (ear) { best = j; break; }
    }
    if (best < 0) {                                     // degenerate (collinear) remainder: clip the flattest corner
      let bk = -Infinity;
      for (let j = 0; j < idx.length; j++) {
        const k = cr(pts[idx[(j + idx.length - 1) % idx.length]], pts[idx[j]], pts[idx[(j + 1) % idx.length]]);
        if (k > bk) { bk = k; best = j; }
      }
    }
    const j = best;
    out.push(ids[idx[(j + idx.length - 1) % idx.length]], ids[idx[j]], ids[idx[(j + 1) % idx.length]]);
    idx.splice(j, 1);
  }
  out.push(ids[idx[0]], ids[idx[1]], ids[idx[2]]);
}

/** Cut copies of a base piece (each cut is unique, so they cannot be instances): the base mesh is transformed and
 *  clipped in JS, all cut pieces become one mesh and one Manifold (no boolean union; ~30× faster than trimming each
 *  copy with Manifold). Falls back to Manifold's trimByPlane if the mesh does not validate. */
class CutSink {
  constructor() { this.items = []; this.meshes = new Map(); this.fallbacks = 0; }
  add(base, M, planes) { this.items.push([base, M, planes]); }
  manifold() {
    if (!this.items.length) return null;
    const { Manifold, Mesh } = K();
    const pos = [], tri = [];
    for (const [base, m, planes] of this.items) {
      let src = this.meshes.get(base);
      if (!src) { const g = base.getMesh(); src = { V: g.vertProperties, T: Array.from(g.triVerts), np: g.numProp }; this.meshes.set(base, src); }
      const nv = src.V.length / src.np, P = new Array(nv * 3);
      for (let i = 0; i < nv; i++) {
        const x = src.V[i * src.np], y = src.V[i * src.np + 1], z = src.V[i * src.np + 2];
        P[3 * i] = m[0] * x + m[4] * y + m[8] * z + m[12];
        P[3 * i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        P[3 * i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      }
      let mesh = { P, T: src.T };
      for (const pl of planes) { mesh = clipMesh(mesh.P, mesh.T, pl.N, pl.d); if (!mesh) break; }
      if (!mesh || mesh.T.length < 12) continue;
      const o = pos.length / 3;
      for (const v of mesh.P) pos.push(v);
      for (const t of mesh.T) tri.push(t + o);
    }
    const items = this.items;
    this.items = [];
    if (!tri.length) return null;
    let why = '';
    try {
      const m = Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: Float32Array.from(pos), triVerts: Uint32Array.from(tri) }));
      if (m.status() === 'NoError' && !m.isEmpty()) {
        // long thin pieces (standing-seam pans) can keep µm slivers where a cut grazes an edge; they would spoil the
        // smooth normals of the large faces next to them. Manifold's simplify removes them (≈ 1 ms on small meshes).
        if (m.numTri() > 8000) return m;
        const sm = m.simplify(1e-4);
        if (sm.status() === 'NoError' && !sm.isEmpty()) { m.delete(); return sm; }
        sm.delete();
        return m;
      }
      why = `ofMesh status ${m.status()}`;
      m.delete();
    } catch (e) { why = String(e && e.message || e); }
    // fallback: trim every piece with Manifold (≈ 30× slower) — counted on the part, warned with ARCH_DEBUG set
    this.fallbacks = items.length;
    const env = globalThis.process?.env || {};
    if (env.ARCH_DEBUG || globalThis.ARCH_DEBUG) console.warn(`roof: JS clip mesh rejected (${why}); trimming ${items.length} pieces with Manifold`);
    const list = [];
    for (const [base, M, planes] of items) {
      let m = base.transform(M);
      for (const pl of planes) { const t = m.trimByPlane(pl.N, pl.d); m.delete(); m = t; }
      if (m.isEmpty()) m.delete(); else list.push(m);
    }
    if (!list.length) return null;
    const out = Manifold.compose ? Manifold.compose(list) : Manifold.union(list);
    for (const m of list) m.delete();
    return out;
  }
}

/** Polygon in the (x, z) plane extruded along +Y from 0 to len. */
function extrudeXZ(poly, len) {
  return extrudeXY(poly, len).transform(mat.mul(mat.T(0, len, 0), mat.Rx(Math.PI / 2)));
}

// ------------------------------------------------------------------------------------------------ covering pieces

function catmull(pts, n) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** The base piece of a covering: local x across (centred), y from the tail (0) up the slope, z out of the slope. */
function coverPiece(D) {
  const C = D.C, d = D.detail;
  if (d === 'low' && D.cover !== 'seam') return box(-0.5, 0, 0, 0.5, C.L, C.t);   // one strip per course
  switch (D.cover) {
    case 'tiles': {
      // Biberschwanz with a round tail (Rundschnitt)
      const hw = C.w / 2 - C.gap / 2, ry = 0.62 * hw, n = segsFor(d, 12, 6, 4), pts = [];
      for (let i = 0; i <= n; i++) { const th = Math.PI + (Math.PI * i) / n; pts.push([hw * Math.cos(th), ry + ry * Math.sin(th)]); }
      pts.push([hw, C.L], [-hw, C.L]);
      return extrudeXY(pts, C.t);
    }
    case 'slate': { const hw = C.w / 2 - C.gap / 2; return box(-hw, 0, 0, hw, C.L, C.t); }
    case 'shingles': {
      const { Manifold } = K(), h = 0.5, t = C.t, th = 0.3 * C.t;
      return Manifold.hull([[-h, 0, 0], [h, 0, 0], [-h, 0, t], [h, 0, t], [-h, C.L, 0], [h, C.L, 0], [-h, C.L, th], [h, C.L, th]]);
    }
    case 'pantiles': {
      // S pantile: wide water channel, roll on the right that laps over the next tile's left edge
      const P = C.P, A = C.A, x0 = -C.w / 2;
      const key = [[0, 0.30], [0.08, 0.12], [0.24, 0.0], [0.42, 0.04], [0.58, 0.30], [0.72, 0.82], [0.82, 1.0], [0.9, 0.9], [0.96, 0.62], [1.0, 0.5]];
      const curve = catmull(key.map(([x, h]) => [x0 + x * P, h * A]), segsFor(d, 2, 2, 1));
      const top = [], bot = [];
      for (let i = 0; i < curve.length; i++) {
        const p = curve[i], q = curve[Math.min(curve.length - 1, i + 1)], r = curve[Math.max(0, i - 1)];
        const tx = q[0] - r[0], tz = q[1] - r[1], tl = Math.hypot(tx, tz) || 1;
        bot.push([p[0], p[1]]); top.push([p[0] - (tz / tl) * C.t, p[1] + (tx / tl) * C.t]);
      }
      return extrudeXZ([...bot, ...top.reverse()], C.L);
    }
    default: return null;
  }
}

/** A piece starting at v whose width ua..ub lies inside a dormer's footprint (hidden in its body) is left out. */
function inHole(f, ua, ub, v) {
  for (const h of f.holes || []) if (ua >= h.u0 && ub <= h.u1 && v >= h.v0 && v <= h.v1) return true;
  return false;
}

/** Lay the covering of one face, course by course. Whole pieces → matrices; pieces crossing a hip, ridge or verge →
 *  cut copies (like a roofer's cut tiles). */
function coverFace(D, f, base, rnd, out) {
  const C = D.C, low = D.detail === 'low';
  const eaveEdge = f.edges.some((ed) => ed.kind === 'eave');
  const vTop = Math.max(...f.uv.map((q) => q[1]));
  const v0 = eaveEdge ? -C.proj : 0;
  const extra = D.cover === 'pantiles' && !low ? C.P - C.w : 0;   // an S pantile's roll laps onto its right neighbour
  const place = (u, v, w, opt) => {
    if (inHole(f, u - w / 2, u + w / 2, v)) return;
    const ua = u - w / 2, ub = u + w / 2 + extra;
    const rect = [[ua, v], [ub, v], [ub, v + C.L], [ua, v + C.L]];
    const planes = classify(f, rect);
    if (!planes) return;
    const M = onFace(f, u, v, opt);
    if (planes.length) out.cut.add(base, M, planes); else out.whole.push(M);
  };
  for (let i = 0; ; i++) {
    const vt = v0 + i * C.g;
    if (vt > vTop - 0.08 * C.g) break;
    const [uLo, uHi] = bandU(f.uv, vt, vt + C.L);
    if (!(uHi - uLo > 1e-6)) continue;
    const opt = { alpha: C.alpha, lift: C.lift };
    if (low) { place((uLo + uHi) / 2, vt, uHi - uLo, { ...opt, sx: uHi - uLo }); continue; }
    if (D.cover === 'shingles') {
      // random widths, butts slightly irregular; the eave course doubled
      const courses = i === 0 && eaveEdge && C.eave ? [[0, 0, 0.5], [C.alpha, C.lift, 0]] : [[C.alpha, C.lift, 0]];
      for (const [al, li, sh] of courses) {
        let u = uLo - rnd() * C.wMax - sh * C.w;
        while (u < uHi) {
          const w = C.wMin + (C.wMax - C.wMin) * rnd();
          const dv = (rnd() - 0.5) * 0.25 * C.t * 3;
          place(u + w / 2, vt + dv, w, { alpha: al, lift: li, sx: w - C.gap, spin: (rnd() - 0.5) * 0.02 });
          u += w;
        }
      }
      continue;
    }
    const off = C.stagger && i % 2 ? C.w / 2 : 0;
    const j0 = Math.floor((uLo - off) / C.w - 0.5), j1 = Math.ceil((uHi - off) / C.w + 0.5);
    const jit = D.cover === 'slate';
    for (let j = j0; j <= j1; j++) {
      const sp = jit ? (rnd() - 0.5) * 0.012 : 0, du = jit ? (rnd() - 0.5) * 0.004 * C.kt : 0;
      place(j * C.w + off + du, vt, C.w, { ...opt, spin: sp });
    }
    if (i === 0 && eaveEdge && C.eave) {
      // eave course under the first course, joints broken by half a tile, lying flat on the deck
      for (let j = j0; j <= j1 + 1; j++) place(j * C.w + C.w / 2 - off, vt, C.w, {});
    }
  }
}

/** Standing seam: one pan per bay from the eave to the ridge / hip, seams between the pans. */
function seamFace(D, f, out) {
  const C = D.C;
  const eaveEdge = f.edges.some((ed) => ed.kind === 'eave');
  const v0 = eaveEdge ? -C.proj : 0;
  const us = f.uv.map((q) => q[0]), uMin = Math.min(...us), uMax = Math.max(...us);
  const j0 = Math.floor(uMin / C.w) - 1, j1 = Math.ceil(uMax / C.w) + 1;
  for (let j = j0; j <= j1; j++) {
    const u = j * C.w, ua = Math.max(uMin, u - C.w / 2), ub = Math.min(uMax, u + C.w / 2);
    if (ub - ua < 1e-6) continue;
    let vHi = Math.max(topV(f.uv, ua), topV(f.uv, ub));
    for (const q of f.uv) if (q[0] > ua && q[0] < ub) vHi = Math.max(vHi, q[1]);
    const len = vHi - v0;
    if (len <= 1e-6) continue;
    const rect = [[u - C.w / 2, v0], [u + C.w / 2, v0], [u + C.w / 2, vHi], [u - C.w / 2, vHi]];
    const planes = classify(f, rect);
    if (!planes) continue;
    const M = onFace(f, u, v0, { sy: len });
    if (planes.length) out.cut.add(out.pan, M, planes); else out.whole.push(M);
    // the seam on the right edge of this pan
    const us2 = u + C.w / 2;
    if (us2 > uMin + 0.02 * C.w && us2 < uMax - 0.02 * C.w) {
      const top = topV(f.uv, us2);
      if (top - v0 > 1e-3) out.seams.push(onFace(f, us2, v0, { sy: top - v0 }));
    }
  }
}

// ------------------------------------------------------------------------------------------------ ridges and hips

/** Cross-section of the covering of a ridge / hip in the plane across the line: x lateral, y along the line's 'up'
 *  (bisector of the two faces), origin where the two covering surfaces meet; the surfaces fall away as
 *  y = -|x|·tan(th). Pure arithmetic. Returns { polys, top, hc } (polys: contours, all counter-clockwise). */
function ridgeSection(style, th, C, segs) {
  const R = C.R, tn = Math.tan(th);
  if (style === 'piece') {
    // half-round clay ridge tile through (±le, -le·tanθ) and (0, c)
    const le = R.le, c = R.c;
    const hc = (c * c - le * le * (1 + tn * tn)) / (2 * (c + le * tn));
    const r = c - hc;
    const phi = Math.max(Math.atan2(-le * tn - hc, le), -0.35);
    const outer = [], inner = [];
    for (let i = 0; i <= segs; i++) {
      const a = phi + ((Math.PI - 2 * phi) * i) / segs;
      outer.push([(r + R.tr) * Math.cos(a), hc + (r + R.tr) * Math.sin(a)]);
      inner.push([r * Math.cos(a), hc + r * Math.sin(a)]);
    }
    return { polys: [[...outer, ...inner.reverse()]], top: hc + r + R.tr, hc, outer };
  }
  const chevron = (le, t) => {
    const h = t / Math.cos(th);
    return [[-le, -le * tn], [0, 0], [le, -le * tn], [le, -le * tn + h], [0, h], [-le, -le * tn + h]];
  };
  if (style === 'boards') return { polys: [chevron(R.leB, R.tbd)], top: R.tbd / Math.cos(th), hc: 0 };
  // metal roll on a saddle flashing
  const h = R.ts / Math.cos(th), cy = h + 0.55 * R.rr, n = Math.max(12, segs);
  const circ = Array.from({ length: n }, (_, i) => { const a = -Math.PI / 2 + (i * TAU) / n; return [R.rr * Math.cos(a), cy + R.rr * Math.sin(a)]; });
  return { polys: [chevron(R.leS, R.ts), circ], top: cy + R.rr, hc: 0 };
}

/** Frame of a line: t along it, up = bisector of the faces' normals, side = up × t; θ = how steeply the faces fall away
 *  across the line; off = rise of the covering surfaces' meeting line above the deck line. */
function lineFrame(line, hT) {
  const t = V.norm(V.sub(line.P1, line.P0));
  const up = V.norm(V.add(line.nA, line.nB));
  const side = V.norm(V.cross(up, t));
  const fall = (n) => { let d = V.norm(V.cross(n, t)); if (V.dot(d, up) > 0) d = V.mul(d, -1); return Math.asin(clamp(-V.dot(d, up), 0, 1)); };
  const th = (fall(line.nA) + fall(line.nB)) / 2;
  const off = hT / ((V.dot(up, line.nA) + V.dot(up, line.nB)) / 2);
  return { t, up, side, th, off, len: V.len(V.sub(line.P1, line.P0)) };
}

/** How far up a hip its covering must start so that no piece reaches past the gutter line (a + o, b + o): the
 *  lowest piece's corners are tested; hips run inward, so moving up the line pulls them in. */
function hipStart(D, l, F, sec) {
  const xs = sec.polys.flat().map((q) => q[0]), ys = sec.polys.flat().map((q) => q[1]);
  const lim = [D.a + D.o - 1e-4, D.b + D.o - 1e-4];
  let d0 = 0;
  for (const x of [Math.min(...xs), Math.max(...xs)]) for (const y of [Math.min(...ys), Math.max(...ys)]) {
    const c = V.add(l.P0, V.add(V.mul(F.up, F.off + y), V.mul(F.side, x)));
    for (const a of [0, 1]) {
      const over = Math.abs(c[a]) - lim[a], rate = -Math.sign(c[a]) * F.t[a];
      if (over > 0) d0 = Math.max(d0, rate > 1e-6 ? over / rate : F.len * 0.5);
    }
  }
  return Math.min(d0, 0.5 * F.len);
}

function ridgeParts(D, G, mats) {
  const C = D.C, out = [];
  const style = C.ridge, low = D.detail === 'low';
  const segs = segsFor(D.detail, 16, 10, 8);
  const role = style === 'boards' ? 'wood' : style === 'roll' && D.cover === 'slate' ? 'metal' : 'roof';
  const material = role === 'wood' ? mats.wood : role === 'metal' ? mats.metal : mats.covering;
  for (const kind of ['ridge', 'hip', 'hip-lower']) {
    const lines = G.lines.filter((l) => l.kind === kind);
    if (!lines.length) continue;
    const F0 = lineFrame(lines[0], C.hT);
    const sec = ridgeSection(style, F0.th, C, segs);
    const xf = [], ends = [];
    let piece;
    if (style === 'piece' && !low) {
      const R = C.R, st = 1 - R.fr / (R.le + R.tr);
      // a slightly conical shell: the wide (socket) end of each piece laps over the narrow end of the one before
      const shifted = sec.polys[0].map(([x, y]) => [x, y - sec.hc]);
      piece = extrudeXY(shifted, R.Lr, { scaleTop: [st, st] }).translate([0, sec.hc, 0]);
      for (let l of lines) {
        const F = lineFrame(l, C.hT);
        if (kind !== 'ridge') { const d0 = hipStart(D, l, F, sec); F.len -= d0; l = { ...l, P0: V.add(l.P0, V.mul(F.t, d0)) }; }
        const n = Math.max(1, Math.ceil((F.len - R.Lr) / R.lr) + 1);
        const step = n > 1 ? (F.len - R.Lr) / (n - 1) : 0, sz = n === 1 ? Math.min(1, F.len / R.Lr) : 1;
        const base = V.add(l.P0, V.mul(F.up, F.off));
        for (let i = 0; i < n; i++) xf.push(frame(F.side, F.up, V.mul(F.t, sz), V.add(base, V.mul(F.t, i * step))));
        if (kind === 'ridge' || kind === 'hip' || kind === 'hip-lower') ends.push({ F, base });
      }
    } else {
      piece = extrudeXY(sec.polys.length > 1 ? sec.polys : sec.polys[0], 1);
      for (let l of lines) {
        const F = lineFrame(l, C.hT);
        if (kind !== 'ridge') { const d0 = hipStart(D, l, F, sec); F.len -= d0; l = { ...l, P0: V.add(l.P0, V.mul(F.t, d0)) }; }
        xf.push(frame(F.side, F.up, V.mul(F.t, F.len), V.add(l.P0, V.mul(F.up, F.off))));
      }
    }
    out.push(part(kind, role, piece, instances(xf), { material }));
    // where two hips meet the ridge: a domed cap (Walmkappe) over the three-way joint
    if (kind === 'ridge' && (D.type === 'hip' || D.type === 'mansard') && style !== 'boards') {
      const { Manifold } = K();
      const F = lineFrame(lines[0], C.hT);
      const rad = style === 'piece' ? sec.top - sec.hc : C.R.rr, cz = style === 'piece' ? sec.hc : sec.top - C.R.rr;
      const cap = Manifold.sphere(rad, segsFor(D.detail, 24, 16, 12));
      const at = (P) => mat.T(P[0], P[1], P[2] + F.off + cz);
      out.push(part('ridge-cap', role, cap, instances(lines.flatMap((l) => [at(l.P0), at(l.P1)])), { material }));
    }
    // end discs closing the open ends of a clay ridge at the verges, and the foot of each hip
    if (style === 'piece' && !low && (kind === 'ridge' ? D.type === 'gable' || D.type === 'gambrel' : true)) {
      const disc = extrudeXY([...sec.outer], 0.012 * C.kt);
      const ex = [];
      for (const { F, base } of ends) {
        ex.push(frame(F.side, F.up, F.t, base));
        if (kind === 'ridge') ex.push(frame(F.side, F.up, F.t, V.add(base, V.mul(F.t, F.len - 0.012 * C.kt))));
      }
      out.push(part(`${kind}-end`, role, disc, instances(ex), { material }));
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ eaves

/** Eaves cornice / wall plate: plinth fillet, cavetto, corona; mitred round the footprint (Tuscan eaves after Vignola,
 *  reduced to a wall-head course: height 0.3 m, projection 0.1 m at an 8 m span). */
function cornice(D, mats) {
  const { hc, pc } = D, n = segsFor(D.detail, 10, 6, 3);
  const p = new Prof(0).fillet(0.14 * hc).cavetto(0.6 * pc, 0.32 * hc, n).out(0.4 * pc).fillet(0.54 * hc);
  const { rings, zs } = p.toRings(D.a, D.b, 0);
  return part('cornice', 'stone', loft(rings, zs), null, { material: mats.cornice });
}

function deckAndWalls(D, G, mats) {
  const { Manifold } = K();
  const outer = Manifold.hull(G.hull);
  const inner = outer.translate([0, 0, -D.tv]);
  const deck = outer.subtract(inner);
  inner.delete();
  // the wall head under the deck: gable walls at the verges, the high wall of a shed; hidden under hipped roofs
  const ov = Math.min(0.001, 0.01 * D.k);
  // (fills the wedge over the cornice up to the soffit; a knee wall stands on the wall line, the cornice a ledge)
  const e = D.knee ? 0 : D.pc;
  const xi = D.hipped ? D.a + e : D.a, yLo = D.b + e, yHi = D.type === 'shed' ? D.b : D.b + e;
  const lifted = outer.translate([0, 0, -D.tv + ov]);
  const walls = lifted.intersect(box(-xi, -yLo, D.hc - ov, xi, yHi, D.zR + D.k));
  lifted.delete(); outer.delete();
  const out = [part('deck', 'wood', deck, null, { material: mats.wood })];
  if (!walls.isEmpty()) out.push(part(D.hipped ? 'wall-head' : 'gable', 'stone', walls, null, { material: mats.wall }));
  return out;
}

/** Top line of the deck at the verge (y, z), from eave to eave (or eave to the high edge of a shed). */
function vergeLine(D) {
  const { type, B, B1, zE, zR } = D;
  if (type === 'gable') return [[-B, zE], [0, zR], [B, zE]];
  if (type === 'gambrel') return [[-B, zE], [-D.B2, D.zB], [0, zR], [D.B2, D.zB], [B, zE]];
  if (type === 'shed') return [[-B, zE], [B1, zR]];
  return null;
}

/** Shed capping (y, z) polygon: a folded flashing over the high edge and down the fascia. */
function shedCapping(D) {
  const { B, B1, zE, tf, tcap, k } = D, C = D.C, tl = Math.tan(D.pe), sec = 1 / Math.cos(D.pe);
  const zt = (y) => zE + (y + B) * tl + C.hT * sec;
  const Lf = 0.16 * k, drop = 0.09 * k, y2 = B1 + tf, y3 = y2 + tcap;
  return [[B1 - Lf, zt(B1 - Lf)], [y2, zt(y2)], [y2, D.zR - drop], [y3, D.zR - drop], [y3, zt(y3) + tcap * sec], [B1 - Lf, zt(B1 - Lf) + tcap * sec]];
}

function eaveParts(D, G, mats) {
  const out = [], { Ax, B, B1, zE, tv, tf, tb, db, k, zR } = D, ov = Math.min(0.001, 0.01 * k);
  const xo = G.xo;
  // fascia boards on the eaves (and on the high side of a shed)
  const fz0 = zE - tv - 0.012 * k;                   // the fascia just covers the plumb cut (drip below the soffit)
  const boards = [];
  if (D.hipped) {
    boards.push(box(-(Ax + tf), -(B + tf), fz0, Ax + tf, -B, zE), box(-(Ax + tf), B, fz0, Ax + tf, B + tf, zE));
    boards.push(box(Ax, -B - ov, fz0, Ax + tf, B + ov, zE), box(-(Ax + tf), -B - ov, fz0, -Ax, B + ov, zE));
  } else {
    boards.push(box(-xo, -(B + tf), fz0, xo, -B, zE));
    if (D.type === 'shed') boards.push(box(-xo, B1, zR - tv - 0.012 * k, xo, B1 + tf, zR));
    else boards.push(box(-xo, B, fz0, xo, B + tf, zE));
  }
  out.push(part('fascia', 'wood', union(boards), null, { material: mats.wood }));
  // barge boards along the verges, covering the deck's end
  const vl = vergeLine(D);
  if (vl) {
    const h = tv + db;
    const poly = [...vl, ...vl.map(([y, z]) => [y, z - h]).reverse()];
    const bargeRole = D.cover === 'seam' ? 'roof' : 'wood';
    const board = extrudeProfileX(poly, tb, false);
    out.push(part('barge', bargeRole, board, instances([mat.T(Ax, 0, 0), mat.T(-Ax - tb, 0, 0)]),
      { material: bargeRole === 'roof' ? mats.covering : mats.wood }));
  }
  if (D.type === 'shed') {
    out.push(part('capping', 'metal', extrudeProfileX(shedCapping(D), 2 * xo), null, { material: mats.metal }));
  }
  out.push(...gutters(D, G, mats));
  return out;
}

const Manifold3 = () => K().Manifold;

/** Half-round hung gutter (rolled bead at the front), its brackets, mitred round hipped roofs, end caps at verges. */
function gutters(D, G, mats) {
  const { rg, gt, rb, tf, k, zE, Ax, B } = D, segs = segsFor(D.detail, 20, 12, 8);
  const zG = zE - 0.02 * k;                            // top line of the gutter, just under the eave course
  const arc = (r, a0, a1, n, cx = rg) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [cx + r * Math.cos(a), r * Math.sin(a)]; });
  // cross-sections in (u outward from the fascia face, w up from the gutter's top line)
  const trough = [...arc(rg, Math.PI, TAU, segs), ...arc(rg - gt, TAU, Math.PI, segs)];
  const bc = [2 * rg + rb - 1.5 * gt, 0.25 * rb];
  const bead = Array.from({ length: 12 }, (_, i) => [bc[0] + rb * Math.cos((i * TAU) / 12), bc[1] + rb * Math.sin((i * TAU) / 12)]);
  const half = arc(rg, Math.PI, TAU, segs);
  const ts = 0.004 * k, bw = 0.025 * k;
  const strap = [...arc(rg + ts, Math.PI, TAU, segs), ...arc(rg - 0.0005 * k, TAU, Math.PI, segs)];
  const tab = [[-ts, 0], [0.0005 * k, 0], [0.0005 * k, 0.06 * k], [-ts, 0.06 * k]];
  // (u, w) -> (y, z) in front of a fascia face at y = -yF; reversed to stay counter-clockwise after the mirror
  const toYZ = (poly, yF) => poly.map(([u, w]) => [-(yF + u), zG + w]).reverse();
  /** A run along X in front of the fascia face y = -yF, from x = -h to h; mitred at the corners (xc, -yF) of a
   *  hipped roof's gutter ring, or closed by end caps at a verge. */
  const run = (yF, h, xc) => {
    let g = union([extrudeProfileX(toYZ(trough, yF), 2 * h), extrudeProfileX(toYZ(bead, yF), 2 * h)]);
    if (xc !== undefined) {
      const s = Math.SQRT1_2, d = -s * xc + s * yF;      // exact mitre: the four runs meet face to face
      g = g.trimByPlane([-s, -s, 0], d).trimByPlane([s, -s, 0], d);
    } else {
      const capT = Math.max(0.003 * k, 1.5 * gt), cap = extrudeProfileX(toYZ(half, yF), capT);
      g = union([g, cap.translate([h - capT / 2, 0, 0]), cap.translate([-h + capT / 2, 0, 0])]);
    }
    return g;
  };
  const bracket = (yF) => union([extrudeProfileX(toYZ(strap, yF), bw), extrudeProfileX(toYZ(tab, yF), bw)]);
  /** bracket positions along a run of half-length h, about every 0.8 m (Swiss practice: ≤ 90 cm), placed by rot */
  const along = (h, rot, xf) => {
    const usable = 2 * h - 0.3 * k, n = Math.max(2, Math.round(usable / (0.8 * Math.max(1, k))) + 1);
    for (let i = 0; i < n; i++) xf.push(mat.mul(rot, mat.T(-usable / 2 + (usable * i) / (n - 1), 0, 0)));
  };
  const out = [], runs = [], brA = [], brB = [];
  const yF = B + tf, xF = Ax + tf;
  const brackets = D.detail !== 'low';
  if (D.hipped) {
    const front = run(yF, xF + D.gw + 0.01 * k, xF), side = run(xF, yF + D.gw + 0.01 * k, yF);
    runs.push(front, front.rotate([0, 0, 180]), side.rotate([0, 0, 90]), side.rotate([0, 0, -90]));
    if (brackets) {
      along(xF - 0.1 * k, mat.I(), brA); along(xF - 0.1 * k, mat.Rz(Math.PI), brA);
      along(yF - 0.1 * k, mat.Rz(Math.PI / 2), brB); along(yF - 0.1 * k, mat.Rz(-Math.PI / 2), brB);
    }
  } else {
    const front = run(yF, G.xo);
    runs.push(front);
    if (D.type !== 'shed') runs.push(front.rotate([0, 0, 180]));
    if (brackets) { along(G.xo, mat.I(), brA); if (D.type !== 'shed') along(G.xo, mat.Rz(Math.PI), brA); }
  }
  out.push(part('gutter', 'metal', union(runs), null, { material: mats.metal }));
  // downpipes: outlet socket under the gutter and the pipe straight down, clear of fascia and cornice, to the wall head
  // (z = 0), where it continues on the building (its swan neck back to the wall lies below the roof); about one every
  // 10 m of eave, at least one near each end of every eave run
  if (D.detail !== 'low') {
    const rp = 0.045 * k, yo = -(yF + rg), zo = zG - rg + 0.01 * k;
    if (zo > 0.05 * k) {
      const sg = segsFor(D.detail, 16, 12, 8);
      const pipe = union([Manifold3().cylinder(zo, rp, rp, sg).translate([0, yo, 0]),
        Manifold3().cylinder(0.05 * k, rp * 1.2, rp * 1.05, sg).translate([0, yo, zo - 0.05 * k]),
        Manifold3().cylinder(0.025 * k, rp * 1.3, rp * 1.3, sg).translate([0, yo, 0.35 * zo])]);
      const xs = [], half = (D.hipped ? Ax : G.xo) - 0.45 * k, n = Math.max(2, Math.round((2 * half) / 10) + 1);
      for (let i = 0; i < n; i++) xs.push(-half + (2 * half * i) / (n - 1));
      const xf = xs.map((x) => mat.T(x, 0, 0));
      if (D.type !== 'shed') for (const x of xs) xf.push(mat.mul(mat.Rz(Math.PI), mat.T(x, 0, 0)));
      out.push(part('downpipe', 'metal', pipe, instances(xf), { material: mats.metal }));
    }
  }
  if (brA.length) out.push(part('gutter-bracket', 'metal', bracket(yF), instances(brA), { material: mats.metal }));
  if (brB.length) out.push(part('gutter-bracket-end', 'metal', bracket(xF), instances(brB), { material: mats.metal }));
  return out;
}

// ------------------------------------------------------------------------------------------------ extras

/** Finial (épi de faîtage / spire knob): a bell-shaped hood over the joint of the hips, ring, stem, collar, ball,
 *  spike. Height H from its base. */
function finialPiece(H, segs) {
  const s = H, pts = [[0, 0], [0.17 * s, 0]];
  for (let i = 1; i <= 8; i++) { const t = i / 8; pts.push([(0.05 + 0.12 * (1 - t) ** 2) * s, 0.13 * s * t]); }
  pts.push([0.075 * s, 0.13 * s], [0.075 * s, 0.16 * s], [0.035 * s, 0.165 * s], [0.03 * s, 0.25 * s], [0.045 * s, 0.265 * s], [0.03 * s, 0.285 * s]);
  const zc = 0.37 * s, r = 0.08 * s;
  for (let i = 0; i <= 12; i++) { const a = -Math.PI / 2 + 0.3 + ((Math.PI - 0.6) * i) / 12; pts.push([r * Math.cos(a), zc + r * Math.sin(a)]); }
  pts.push([0.022 * s, 0.47 * s], [0.03 * s, 0.5 * s], [0.016 * s, 0.53 * s], [0.006 * s, 0.92 * s], [0, s]);
  return revolve(pts, segs);
}

function extraParts(D, G, mats) {
  const out = [], segs = segsFor(D.detail, 40, 24, 12);
  // curb roll at the break of a mansard / gambrel (zinc or lead roll over the joint of the two pitches)
  const breaks = G.lines.filter((l) => l.kind === 'break');
  if (breaks.length) {
    const { Manifold } = K();
    const r = 0.035 * D.C.kt;
    const pieces = [];
    for (const l of breaks) {
      const F = lineFrame(l, D.C.hT);
      const c0 = V.add(l.P0, V.mul(F.up, F.off + 0.35 * r));
      const extra = D.type === 'mansard' ? r : 0;
      const cyl = Manifold.cylinder(F.len + 2 * extra, r, r, segsFor(D.detail, 20, 14, 8)).transform(frame(F.side, F.up, F.t, V.sub(c0, V.mul(F.t, extra))));
      pieces.push(cyl);
      if (D.type === 'mansard') pieces.push(Manifold.sphere(r, segsFor(D.detail, 20, 12, 8)).translate(c0));
    }
    let curb = union(pieces);
    if (G.dormerCut) curb = curb.subtract(G.dormerCut);
    out.push(part('curb', 'metal', curb, null, { material: mats.metal }));
  }
  if (D.finialH) {
    const f = finialPiece(D.finialH, segs);
    const xf = [];
    if (D.apex) xf.push(mat.T(0, 0, D.zApex - 0.02 * D.k));
    else {
      const pr = D.up * DEG, z = D.zR + D.C.hT / Math.cos(pr) + ridgeSection(D.C.ridge, pr, D.C, 16).top * 0.5;
      xf.push(mat.T(-D.R, 0, z), mat.T(D.R, 0, z));
    }
    out.push(part('finial', 'metal', f, instances(xf), { material: mats.finial }));
  }
  return out;
}


// ------------------------------------------------------------------------------------------------ dormers

/** Dormers: a stone front with a moulded window surround, sill, cornice and triangular pediment, a small gable roof
 *  running back into the roof, a French casement (glazing bars). spec.dormers true → on gable, hip and mansard roofs;
 *  false → none; unset → mansards at detail high (their defining feature). One bay every ≈ 2.8 m, kept 0.35 m clear
 *  of hips and gable walls. Mansard: lucarnes on all four brisis faces, the front just behind the gutter. Gable / hip
 *  (pitch ≥ 20°): on the long slopes, the front just behind the wall line so the eave runs on below; the window is made
 *  shorter (down to 0.6 m) or the dormers left out when the roof is too low for them. The covering under a dormer is
 *  left out. */
function dormerLayout(D, G, spec) {
  const want = spec.dormers === undefined || spec.dormers === null ? D.type === 'mansard' && D.detail === 'high' : !!spec.dormers;
  if (!want || !['mansard', 'gable', 'hip'].includes(D.type)) return null;
  const tL = Math.tan(D.pe), mansard = D.type === 'mansard';
  let kd, yf, zBase, zc, zo0, zo1, slopeY;
  if (mansard) {
    kd = clamp(D.hL / 2.7, 0.35, 1.3); yf = 0.3 * kd;
    zBase = D.zE + yf * tL;
    zc = zBase + 0.9 * (D.zB - zBase); zo0 = zBase + 0.12 * kd; zo1 = zc - 0.22 * kd;
    if (zo1 - zo0 < 0.45 * kd) return null;
    const tU = Math.tan(D.up * DEG);
    slopeY = (z) => (z <= D.zB ? (z - D.zE) / tL : D.rL + (z - D.zB) / tU);
  } else {
    if (D.lo < 20) return null;
    kd = clamp(D.short / 8, 0.35, 1.2); yf = D.oS + 0.4 * kd;
    zBase = D.zE + yf * tL;
    const zMax = D.zE + (D.B - 0.35 * kd) * tL;          // the dormer roof must meet the slope below the ridge
    const win = Math.min(1.3 * kd, zMax - zBase - 0.79 * kd);
    if (win < 0.6 * kd) return null;
    zo0 = zBase + 0.12 * kd; zo1 = zo0 + win; zc = zo1 + 0.22 * kd;
    slopeY = (z) => (z - D.zE) / tL;
  }
  const wd = 1.15 * kd, cp = 0.06 * kd, hp = 0.36 * kd, zr = zc + hp;
  const yMeet = slopeY(zr + 0.05 * kd), yBk = yMeet + 0.25 * kd;
  const L = { kd, wd, cp, yf, zBase, zc, zo0, zo1, hp, zr, yBk, ww: 0.66 * kd };
  const bays = (half) => {
    const U = 2 * (half - 0.35 * kd - wd / 2 - cp);
    if (U < 0) return [];
    const n = Math.floor(U / (2.8 * kd)) + 1, sp = n > 1 ? Math.min(3.4 * kd, U / (n - 1)) : 0;
    return Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * sp);
  };
  // each dormer is built with its eave line on local y = 0, front -Y; per face a rotation, the eave's distance from the
  // centre and the half-width available (mansard: at the break; hip: where the dormer roof meets the slope)
  const sides = mansard
    ? [[0, mat.I(), D.B, D.A2], [1, mat.Rz(Math.PI / 2), D.Ax, D.B2], [2, mat.Rz(Math.PI), D.B, D.A2], [3, mat.Rz(-Math.PI / 2), D.Ax, D.B2]]
    : D.type === 'gable' ? [[0, mat.I(), D.B, D.a], [1, mat.Rz(Math.PI), D.B, D.a]]
      : [[0, mat.I(), D.B, D.Ax - yBk], [2, mat.Rz(Math.PI), D.B, D.Ax - yBk]];
  const v1 = mansard ? Infinity : slopeY(zc) / Math.cos(D.pe);
  const xf = [], cuts = [];
  for (const [fi, rot, dist, half] of sides) {
    const f = G.faces[fi];
    f.holes = [];
    for (const x of bays(half)) {
      const M = mat.mul(rot, mat.T(x, -dist, 0));
      xf.push(M);
      const c = mat.apply(M, [0, yf, D.zE]);
      const uc = V.dot(V.sub(c, f.O), f.e);
      f.holes.push({ u0: uc - wd / 2 - cp, u1: uc + wd / 2 + cp, v0: yf / Math.cos(D.pe), v1 });
      if (mansard) cuts.push(box(-wd / 2 - cp, yf - 0.1 * kd, zBase, wd / 2 + cp, yBk, zr + 0.2 * kd).transform(M));
    }
  }
  if (!xf.length) return null;
  if (cuts.length) G.dormerCut = union(cuts);
  return { L, xf };
}

function dormerParts(D, layout, mats) {
  if (!layout) return [];
  const { L, xf } = layout, { kd, wd, cp, yf, zBase, zc, zo0, zo1, hp, zr, yBk, ww } = L;
  const I = instances(xf);
  // stone front: body, architrave round the opening, sill, cornice, pediment
  const body = box(-wd / 2, yf, zBase - 0.1 * kd, wd / 2, yBk, zc - 0.12 * kd + 0.001);
  const archi = box(-ww / 2 - 0.09 * kd, yf - 0.025 * kd, zo0, ww / 2 + 0.09 * kd, yf + 0.01, zo1 + 0.09 * kd);
  const opening = box(-ww / 2, yf - 0.2 * kd, zo0, ww / 2, yf + 0.14 * kd, zo1);
  const sill = box(-ww / 2 - 0.12 * kd, yf - 0.07 * kd, zo0 - 0.07 * kd, ww / 2 + 0.12 * kd, yf + 0.05 * kd, zo0 + 0.001);
  const cornice = box(-wd / 2 - cp, yf - cp, zc - 0.12 * kd, wd / 2 + cp, yBk, zc);
  const ped = extrudeXZ([[-wd / 2 - cp, zc - 0.001], [wd / 2 + cp, zc - 0.001], [0, zr]], 0.16 * kd).translate([0, yf - cp, 0]);
  const stone = union([body, archi, sill, cornice, ped]).subtract(opening);
  // dormer roof: a gable prism behind the pediment, running back into the main roof
  const ov = 0.1 * kd;
  const roofM = extrudeXZ([[-wd / 2 - ov, zc - 0.03 * kd], [wd / 2 + ov, zc - 0.03 * kd], [0, zr + 0.07 * kd]], yBk + 0.3 * kd - (yf - 0.03 * kd))
    .translate([0, yf - 0.03 * kd, 0]);
  // casement: frame, central meeting stiles, two glazing bars per leaf; glass behind
  const yg = yf + 0.09 * kd, fw = 0.045 * kd, bw = 0.022 * kd;
  const bars = [
    box(-ww / 2, yg - 0.03 * kd, zo0, -ww / 2 + fw, yg, zo1), box(ww / 2 - fw, yg - 0.03 * kd, zo0, ww / 2, yg, zo1),
    box(-ww / 2, yg - 0.03 * kd, zo0, ww / 2, yg, zo0 + fw), box(-ww / 2, yg - 0.03 * kd, zo1 - fw, ww / 2, yg, zo1),
    box(-fw * 0.8, yg - 0.035 * kd, zo0, fw * 0.8, yg, zo1),
  ];
  for (const t of [1 / 3, 2 / 3]) { const z = zo0 + (zo1 - zo0) * t; bars.push(box(-ww / 2, yg - 0.025 * kd, z - bw / 2, ww / 2, yg, z + bw / 2)); }
  const glass = box(-ww / 2, yg, zo0, ww / 2, yg + 0.006 * kd, zo1);
  return [
    part('dormer', 'stone', stone, I, { material: mats.cornice }),
    part('dormer-roof', 'roof', roofM, I, { material: mats.covering }),
    part('dormer-sash', 'wood', union(bars), I, { material: mats.wood }),
    part('dormer-glass', 'glass', glass, I, { material: 'glass' }),
  ];
}

// ------------------------------------------------------------------------------------------------ snow guards

/** Snow guards (Schneefang, detail high): two tubes on forged brackets about 0.5 m up from the eave of every slope
 *  that has an eave and is no steeper than 55°. Brackets ≤ 0.9 m apart. */
function snowGuards(D, G, mats) {
  if (D.detail !== 'high' || D.type === 'mansard') return [];
  const { Manifold } = K(), C = D.C, k = Math.min(1, C.kt);
  const r = 0.015 * k, base = C.hT - 0.004 * k, h1 = base + 0.05 * k, h2 = base + 0.11 * k;
  const tube = Manifold.cylinder(1, r, r, 12);
  const plate = extrudeXY([[-0.06 * k, 0], [0.05 * k, 0], [0.03 * k, 0.14 * k], [-0.01 * k, 0.14 * k]], 0.008 * k).translate([0, base - 0.004 * k, -0.004 * k]);
  const holes = [h1, h2].map((h) => Manifold.cylinder(0.02 * k, r * 0.9, r * 0.9, 10).translate([0, h, -0.01 * k]));
  const bracket = plate.subtract(union(holes));
  const tubes = [], brs = [];
  for (const f of G.faces) {
    if (!f.edges.some((ed) => ed.kind === 'eave') || Math.acos(f.n[2]) > 55 * DEG) continue;
    const v = 0.5 * Math.max(0.5, Math.min(1, D.short / 6)) - C.proj;
    const [uLo, uHi] = sliceU(f.uv, Math.max(0, v + 0.1 * k));
    const a = uLo + 0.12 * k, b = uHi - 0.12 * k;
    if (b - a < 0.4 * k) continue;
    const at = (u, w) => V.add(f.O, V.add(V.mul(f.e, u), V.add(V.mul(f.s, v), V.mul(f.n, w))));
    for (const w of [h1, h2]) tubes.push(frame(f.s, f.n, V.mul(f.e, b - a), V.add(at(a, w), V.mul(f.s, 0))));
    const n = Math.max(2, Math.ceil((b - a - 0.2 * k) / (0.9 * k)) + 1);
    for (let i = 0; i < n; i++) brs.push(frame(f.s, f.n, f.e, at(a + 0.1 * k + ((b - a - 0.2 * k) * i) / (n - 1), 0)));
  }
  if (!tubes.length) return [];
  // tube axis is local z: frame(s, n, e·len) maps it along the eave; the bracket plate stands in the s-n plane
  return [part('snow-guard', 'metal', tube, instances(tubes), { material: mats.metal }),
    part('snow-guard-bracket', 'metal', bracket, instances(brs), { material: mats.metal })];
}

// ------------------------------------------------------------------------------------------------ assembly

export function build(spec) {
  const D = dims(spec);
  const G = geometry(D);
  const mats = materials(spec, D.cover);
  const dormers = dormerLayout(D, G, spec);
  const parts = [cornice(D, mats), ...deckAndWalls(D, G, mats), ...eaveParts(D, G, mats)];
  const rnd = rng(spec.seed ?? 7);
  const name = COVER_NAME[D.cover], C = D.C;
  // every roof but the shed is symmetric under a half turn about Z: lay the covering on half of the faces and turn it
  // (the covering's random variation repeats on the opposite slope, which is never seen together with its twin)
  const half = G.faces.filter((f, i) => D.type === 'shed' || G.halfSet.includes(i));
  const turn = D.type === 'shed' ? null : mat.Rz(Math.PI);
  const both = (list) => (turn ? [...list, ...list.map((m) => mat.mul(turn, m))] : list);
  const cutXf = turn ? instances([mat.I(), turn]) : null;
  if (D.cover === 'seam') {
    const pan = box(-(C.w - C.sw) / 2 - 0.002 * C.kt, 0, 0, (C.w - C.sw) / 2 + 0.002 * C.kt, 1, C.t);
    const r = C.sw / 2, seamPoly = [[-r, 0], [r, 0], [r, C.sh - r]];
    for (let i = 1; i < 8; i++) { const a = (Math.PI * i) / 8; seamPoly.push([r * Math.cos(a), C.sh - r + r * Math.sin(a)]); }
    seamPoly.push([-r, C.sh - r]);
    const seam = extrudeXZ(seamPoly, 1);
    const out = { whole: [], seams: [], cut: new CutSink(), pan };
    for (const f of half) seamFace(D, f, out);
    parts.push(part('pan', 'roof', pan, instances(both(out.whole)), { material: mats.covering }));
    const cut = out.cut.manifold();
    if (cut) parts.push(part('pan-cut', 'roof', cut, cutXf, { material: mats.covering, clipFallbacks: out.cut.fallbacks }));
    parts.push(part('seam', 'roof', seam, instances(both(out.seams)), { material: mats.covering }));
  } else {
    const base = coverPiece(D);
    const out = { whole: [], cut: new CutSink() };
    for (const f of half) coverFace(D, f, base, rnd, out);
    const role = mats.coverRole;
    parts.push(part(D.detail === 'low' ? `${name}-course` : name, role, base, instances(both(out.whole)), { material: mats.covering }));
    const cut = out.cut.manifold();
    if (cut) parts.push(part(`${name}-cut`, role, cut, cutXf, { material: mats.covering, clipFallbacks: out.cut.fallbacks }));
  }
  parts.push(...ridgeParts(D, G, mats), ...extraParts(D, G, mats), ...dormerParts(D, dormers, mats), ...snowGuards(D, G, mats));
  const kept = parts.filter((p) => !p.transforms || p.transforms.length);
  return D.swap ? placeParts(kept, mat.Rz(Math.PI / 2)) : kept;
}

/** What the generator promises, for the tests. */
export function expected(spec) {
  const D = dims(spec);
  const L = spec.length ?? DEFAULTS.roof.length, W = spec.width ?? DEFAULTS.roof.width;
  // what the roof type itself defines: two verges with barge boards on gabled types, one finial where hips meet in a
  // point, two épis at the ridge ends of a mansard
  const counts = {};
  if (!D.hipped) counts.barge = 2;
  if (D.finialH) counts.finial = D.apex ? 1 : 2;
  return { size: { x: L + 2 * D.o, y: W + 2 * D.o, z: D.zTop }, counts, tol: 0.005 };
}
