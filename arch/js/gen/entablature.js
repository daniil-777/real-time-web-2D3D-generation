// Entablatures after Vignola (Regola delli cinque ordini, 1562, via W. R. Ware, The American Vignola, 1903): architrave,
// frieze (plain, Doric triglyphs and metopes, pulvinated) and cornice (plain, dentils, modillions, mutules) drawn as moulding
// profiles and swept along a run with mitred returns; the cornice alone; a single enriched moulding run; pediments
// (triangular, segmental, broken); window and door surrounds (eared architrave, frieze, cornice, pediment, keystone, sill).
// Z-up, metres. The run lies along X, the front faces -Y, y = 0 is the reference plane (the frieze face, or the wall face
// for a moulding / surround); z = 0 is the lowest point (the architrave soffit for an entablature).
//
// Proportions (D = lower column diameter, M = D/2; heights from orders.js):
// - Architrave: Tuscan one fascia + taenia; Doric two fasciae + taenia with regulae and six guttae under each triglyph;
//   Ionic / Corinthian / Composite three fasciae (heights rising 0.20 : 0.24 : 0.28 of the architrave) parted by astragals,
//   crowned by a cyma reversa and fillet projecting 0.095 D (Ware). The frieze face is plumb with the lowest fascia.
// - Doric frieze: triglyph 1 M wide, metope 1.5 M (square), triglyph pitch 2.5 M = 1.25 D, so the ditriglyph bay of
//   3.75 D puts a triglyph over every column axis; triglyph = 12 parts: two glyphs (2), three shanks (2), two half-glyphs (1).
// - Cornice projection = its height (Vignola, all orders but the Doric mutule cornice, which projects 4/3 of its height).
// - Dentils (Vignola's Ionic, Ware): 1/3 M wide, interval 1/6 M, i.e. pitch D/4 (13 to an Ionic axis of 3.25 D); a dentil
//   on every column axis and a whole corner dentil seen on both faces at a returned angle.
// - Modillions: pitch 0.65 D (5 to a Corinthian axis of 3.25 D, one over every column axis), length = the corona soffit,
//   a square coffer with a rosette between modillions and at the corner (detail high).
// - Mutules (Vitruvius IV.3): one over every triglyph and every metope, with 3 x 6 guttae.

import { ORDERS, DEFAULT_D, entablatureDims } from '../orders.js';
import { K, mat, instances, box, union, part, crossSection, extrudeProfileX, bezier, arc, placeParts } from '../kernel.js';
import { Prof } from '../profiles.js';
import { acanthusLeaf, rosette, spiral } from '../ornament.js';
import { socle, urnParts } from './finial.js';
import { archGeom } from './arch.js';

export const ELEMENTS = ['entablature', 'cornice', 'moulding', 'pediment', 'window', 'door'];

const EPS = 0.001;                                      // overlap so pieces meant to touch overlap (Manifold does not fuse touching faces)

// Modules of the repeated members of a cornice, in lower diameters D (Vignola, after Ware, The American Vignola, 1903).
// orders.js holds the orders' heights and axes; these are the cornice's own carving modules.
const DENTIL = { w: 1 / 6, pitch: 1 / 4 };   // Ionic dentil 1/3 M wide, interval 1/6 M: 13 to the eustyle axis of 3.25 D
const MODILLION = { pitch: 0.65, w: 0.22 };  // Corinthian modillion: 5 to the eustyle axis of 3.25 D (one on every axis)
/** Was a field stated in the request? normalize() lists them in spec.given (a spec built by hand: any defined value). */
const stated = (spec, f) => (spec.given ? spec.given.includes(f) : spec[f] !== undefined && spec[f] !== null);

// Default enrichment of a moulding when none is stated (controller ruling 21): each profile's canonical carving.
const MOULDING_ENRICH = { ovolo: 'egg-and-dart', bead: 'bead-and-reel', 'cyma-reversa': 'leaf-and-dart' };
const RICH = new Set(['ionic', 'corinthian', 'composite', 'solomonic']);
const EGG_TILT = (32 * Math.PI) / 180;                // eggs lean out of the ovolo, facing down-out as seen from below
const sstep = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const curveN = (detail) => (detail === 'low' ? 6 : detail === 'medium' ? 10 : 14);
const orderKey = (o) => (ORDERS[o] ? o : 'ionic');

// ------------------------------------------------------------------------------------------------ sweep

/**
 * Sweep a closed profile polygon [[a, b], ...] through a list of frames {o, A, B}: ring k is the profile placed at
 * o + a·A + b·B. Built as an extrusion (exact cap triangulation) whose rings are then moved onto the frames, so mitres,
 * plumb rakes and radial arcs are all exact. The traversal is reversed when the frames are left-handed.
 */
export function sweep(poly, frames) {
  const { Manifold } = K();
  const n = frames.length, f0 = frames[0];
  const T = frames[1].o.map((v, i) => v - f0.o[i]), A = f0.A, B = f0.B;
  const det = A[0] * (B[1] * T[2] - B[2] * T[1]) - A[1] * (B[0] * T[2] - B[2] * T[0]) + A[2] * (B[0] * T[1] - B[1] * T[0]);
  const fr = det < 0 ? frames.slice().reverse() : frames;
  return Manifold.extrude(crossSection(poly), n - 1, n - 2).warp((v) => {
    const f = fr[Math.round(v[2])], a = v[0], b = v[1];
    v[0] = f.o[0] + a * f.A[0] + b * f.B[0];
    v[1] = f.o[1] + a * f.A[1] + b * f.B[1];
    v[2] = f.o[2] + a * f.A[2] + b * f.B[2];
  });
}

/** Frames along a plan polyline (outward side on the left of travel), mitred at every inner vertex, profile up = +Z. */
function planFrames(pts, z = 0) {
  const n = pts.length, nrm = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dy);
    nrm.push([-dy / l, dx / l]);
  }
  return pts.map((p, k) => {
    let o;
    if (k === 0) o = nrm[0];
    else if (k === n - 1) o = nrm[n - 2];
    else { const a = nrm[k - 1], b = nrm[k], s = 1 + a[0] * b[0] + a[1] * b[1]; o = [(a[0] + b[0]) / s, (a[1] + b[1]) / s]; }
    return { o: [p[0], p[1], z], A: [o[0], o[1], 0], B: [0, 0, 1] };
  });
}

/** The reference line of a run: front from x = L/2 to -L/2 at y = 0, returned back to y = B at both ends. The returns
 *  run a hair (min(1 mm, B/100)) past the body's back plane, so the inner mitre point (at depth B) never coincides with
 *  the end of the return (a zero-length edge). */
const runPts = (L, B, returns) => {
  const b = B + Math.min(EPS, B / 100);
  return returns ? [[L / 2, b], [L / 2, 0], [-L / 2, 0], [-L / 2, b]] : [[L / 2, 0], [-L / 2, 0]];
};

/** Profile points (q, z) closed to the back plane q = -B (q = projection in front of the reference plane). */
function closeBack(pts, B) {
  const bot = pts[0][1], top = pts[pts.length - 1][1];
  return [[-B, bot], ...pts, [-B, top]];
}

/** Sweep a profile along a run (with mitred returns when asked). */
function runSolid(pts, L, B, returns) { return sweep(closeBack(pts, B), planFrames(runPts(L, B, returns))); }

// ------------------------------------------------------------------------------------------------ profiles

/**
 * Draw a member list into profile points with the moulding turtle. Members: {t, h, p, tag} where t is the member type,
 * h its height and p the projection (in front of the reference plane) at its end. Tags record each member's extent.
 */
function drawMembers(members, n, z0 = 0, p0 = 0) {
  const P = new Prof(p0, z0), tags = {};
  for (const m of members) {
    const h0 = P.h, q0 = P.p, dp = (m.p ?? P.p) - P.p, i0 = P.pts.length - 1;
    switch (m.t) {
      case 'fillet': P.fillet(m.h, dp); break;
      case 'ovolo': P.ovolo(dp, m.h, n); break;
      case 'cavetto': P.cavetto(dp, m.h, n); break;
      case 'cymaRecta': P.cymaRecta(dp, m.h, n); break;
      case 'cymaReversa': P.cymaReversa(dp, m.h, n); break;
      case 'torus': if (dp) P.out(dp); P.torus(m.h, m.k ?? 1, n + 4); break;
      case 'scotia': P.scotia(m.h, m.depth, m.end ?? 0, n + 4); break;     // hollow `depth` deep, ending `end` from its start
      case 'slope': P.slope(dp, m.h); break;
      case 'corona': {                                  // soffit out to the front with a drip (throat) near the edge, then the face
        const g = m.drip || 0, f = m.p;
        if (g > 0) { P.to(f - 2.6 * g, h0); P.to(f - 2.6 * g, h0 + g); P.to(f - 1.4 * g, h0 + g); P.to(f - 1.4 * g, h0); }
        P.to(f, h0); P.to(f, h0 + m.h); break;
      }
      case 'pulvino': {                                 // convex cushion frieze: circular arc of sagitta s
        const s = m.s, hh = m.h, R = (s * s + hh * hh / 4) / (2 * s), cq = q0 + s - R, cz = h0 + hh / 2, a = Math.asin(hh / 2 / R);
        for (let i = 1; i <= 2 * n; i++) { const t = -a + (2 * a * i) / (2 * n); P.to(cq + R * Math.cos(t), cz + R * Math.sin(t)); }
        break;
      }
      default: throw new Error(`member ${m.t}`);
    }
    if (m.tag) tags[m.tag] = { h0, h1: P.h, p0: q0, p1: P.p, t: m.t, drip: m.drip || 0, pts: P.pts.slice(i0).map((q) => q.slice()) };
  }
  const pts = P.points();
  return { pts, tags, top: P.h, P: Math.max(...pts.map((q) => q[0])) };
}

// Cornices: [type, height (fraction of the cornice height c), projection at the member's end (fraction of P), tag]
const CORNICES = {
  plain: [ // Tuscan (Vignola): bed cyma reversa, band, ovolo, corona with drip, fillet, cyma recta crown
    ['cymaReversa', 0.13, 0.10, 'bed'], ['fillet', 0.04, 0.12], ['fillet', 0.18, 0.12, 'band'], ['ovolo', 0.15, 0.28, 'ovolo'],
    ['corona', 0.25, 0.74, 'corona'], ['fillet', 0.04, 0.77, 'cymatium'], ['cymaRecta', 0.17, 0.97, 'sima'], ['fillet', 0.04, 1, 'simaFillet']],
  dentils: [ // Ionic: bed, dentil course, ovolo, corona, cymatium, sima
    ['cymaReversa', 0.10, 0.07, 'bed'], ['fillet', 0.02, 0.08], ['fillet', 0.27, 0.08, 'dentilBand'], ['fillet', 0.03, 0.26, 'dentilCap'],
    ['ovolo', 0.11, 0.37, 'ovolo'], ['corona', 0.20, 0.72, 'corona'], ['cymaReversa', 0.06, 0.76, 'cymatium'], ['fillet', 0.02, 0.77],
    ['cymaRecta', 0.15, 0.97, 'sima'], ['fillet', 0.04, 1, 'simaFillet']],
  modillions: [ // Corinthian: bed, dentils, ovolo, modillion band with its cap, corona, cymatium, sima
    ['cymaReversa', 0.08, 0.06, 'bed'], ['fillet', 0.02, 0.07], ['fillet', 0.175, 0.07, 'dentilBand'], ['fillet', 0.02, 0.21, 'dentilCap'],
    ['ovolo', 0.09, 0.30, 'ovolo'], ['fillet', 0.015, 0.31], ['fillet', 0.18, 0.31, 'modBand'], ['cymaReversa', 0.035, 0.34, 'modCap'],
    ['corona', 0.17, 0.80, 'corona'], ['cymaReversa', 0.05, 0.83, 'cymatium'], ['fillet', 0.015, 0.835],
    ['cymaRecta', 0.12, 0.98, 'sima'], ['fillet', 0.03, 1, 'simaFillet']],
  modillionsPlain: [ // modillions without dentils (Palladio's Tuscan, Georgian modillion cornices)
    ['cymaReversa', 0.10, 0.07, 'bed'], ['fillet', 0.03, 0.09], ['ovolo', 0.10, 0.20, 'ovolo'], ['fillet', 0.02, 0.21],
    ['fillet', 0.25, 0.21, 'modBand'], ['cymaReversa', 0.04, 0.24, 'modCap'], ['corona', 0.22, 0.80, 'corona'],
    ['cymaReversa', 0.06, 0.83, 'cymatium'], ['fillet', 0.02, 0.835], ['cymaRecta', 0.13, 0.98, 'sima'], ['fillet', 0.03, 1, 'simaFillet']],
  mutules: [ // Doric (Vignola's mutulary cornice): bed, mutule band, corona, cymatium, sima
    ['cymaReversa', 0.10, 0.06, 'bed'], ['fillet', 0.03, 0.07], ['fillet', 0.15, 0.07, 'mutBand'],
    ['corona', 0.30, 0.76, 'corona'], ['cymaReversa', 0.08, 0.80, 'cymatium'], ['fillet', 0.03, 0.81],
    ['cymaRecta', 0.24, 0.97, 'sima'], ['fillet', 0.07, 1, 'simaFillet']],
  gorge: [ // Egyptian cavetto ("gorge") cornice over a torus roll
    ['torus', 0.14, 0.03, 'roll'], ['fillet', 0.04, 0.06], ['cavetto', 0.66, 0.96, 'gorge'], ['fillet', 0.16, 1, 'simaFillet']],
  deco: [['fillet', 0.25, 0.25], ['fillet', 0.25, 0.5], ['fillet', 0.25, 0.75], ['fillet', 0.25, 1, 'simaFillet']],
  slab: [['fillet', 0.12, 0.06], ['corona', 0.88, 1, 'corona']],
};
// projection / height of each cornice
const PROJ = { plain: 1, dentils: 1, modillions: 1, modillionsPlain: 1, mutules: 4 / 3, gorge: 0.75, deco: 0.6, slab: 1.6 };

/** Cornice members for height c (absolute). noSima drops the crowning cyma recta (horizontal cornice under a pediment). */
export function corniceMembers(kind, c, { noSima = false, dripK = 1 } = {}) {
  const rows = CORNICES[kind].filter((r) => !(noSima && (r[3] === 'sima' || r[3] === 'simaFillet')));
  const all = CORNICES[kind].reduce((s, r) => s + r[1], 0), P = PROJ[kind] * c;
  return rows.map(([t, h, p, tag]) => ({ t, h: (h / all) * c, p: p * P, tag, drip: t === 'corona' ? 0.035 * c * dripK : 0 }));
}

// Architraves: [type, height (fraction of the architrave a), projection (in D), tag]
const ARCHITRAVES = {
  one: [['fillet', 0.82, 0, 'fascia1'], ['fillet', 0.18, 0.05, 'taenia']],
  two: [['fillet', 0.33, 0, 'fascia1'], ['fillet', 0.5, 0.025, 'fascia2'], ['fillet', 0.17, 0.085, 'taenia']],
  greek: [['fillet', 0.86, 0, 'fascia2'], ['fillet', 0.14, 0.05, 'taenia']],
  three: [['fillet', 0.2, 0, 'fascia1'], ['torus', 0.04, 0, 'astragal1'], ['fillet', 0.24, 0.016, 'fascia2'], ['torus', 0.04, 0.016, 'astragal2'],
    ['fillet', 0.28, 0.032, 'fascia3'], ['cymaReversa', 0.13, 0.085, 'crown'], ['fillet', 0.07, 0.095]],
  deco: [['fillet', 0.4, 0], ['fillet', 0.3, 0.03], ['fillet', 0.3, 0.06]],
  plain: [['fillet', 1, 0]],
};
const archKind = (order) => ({ tuscan: 'one', romanesque: 'one', gothic: 'one', egyptian: 'plain', doric: 'two', 'greek-doric': 'greek',
  'art-deco': 'deco', modern: 'plain' }[order] || 'three');

/** Architrave members; with carved bead-and-reel the astragals are cut back to a slender core the beads stand on. */
function architraveMembers(order, a, D, beads = false) {
  return ARCHITRAVES[archKind(order)].map(([t, h, p, tag]) => ({ t, h: h * a, p: p * D, tag, k: beads && t === 'torus' ? BEAD_CORE : 1 }));
}
const BEAD_CORE = 0.35;

// Triglyph (Vignola via Ware): width 1 M = D/2, face 1/12 M proud of the metope, capital 1/6 M. The pitch is the Doric
// bay over the triglyphs it holds (orders.js): ditriglyph 3.75 D / 3 = 1.25 D (Roman), monotriglyph 2.5 D / 2 (Greek).
const TRI = { w: 0.5, proj: 0.04, cap: 1 / 12 };
const triPitch = (order) => (order === 'greek-doric' ? ORDERS['greek-doric'].axis / 2 : ORDERS.doric.axis / 3);

function friezeMembers(kind, f, D, order) {
  // Palladio's pulvinated (cushion) frieze: a flat circular segment whose belly just passes the architrave's crown
  if (kind === 'pulvinated') return [{ t: 'pulvino', h: f, s: 0.115 * f, tag: 'frieze' }];
  if (kind === 'triglyph') {
    const cap = Math.min(0.3 * f, (order === 'greek-doric' ? 1 / 14 : TRI.cap) * D);
    return [{ t: 'fillet', h: f - cap, p: 0, tag: 'metope' }, { t: 'fillet', h: cap, p: (TRI.proj + 0.012) * D, tag: 'tcap' }];
  }
  return [{ t: 'fillet', h: f, p: 0, tag: 'frieze' }];
}

/** Map the user's cornice choice (+ order) to a cornice construction. */
function corniceKindFor(spec, order) {
  let k = spec.cornice || ORDERS[order].cornice;
  if (k === 'gorge') k = 'plain';
  if (spec.enrichment === 'dentils' && k === 'plain') k = 'dentils';
  if (k === 'plain') return { egyptian: 'gorge', 'art-deco': 'deco', modern: 'slab' }[order] || 'plain';
  if (k === 'modillions') return RICH.has(order) || spec.enrichment === 'dentils' ? 'modillions' : 'modillionsPlain';
  return k;
}
const friezeKindFor = (spec, order) => spec.frieze || ORDERS[order].frieze || 'plain';

/** Enrichments in force: order defaults (Ionic and richer: egg-and-dart, + bead-and-reel at detail high) plus the asked one. */
function enrichSet(spec, order, defaults = true) {
  const s = new Set(), d = spec.detail || 'high';
  if (spec.enrichment === 'none') return s;
  if (defaults && RICH.has(order) && d !== 'low') { s.add('egg-and-dart'); if (d === 'high') s.add('bead-and-reel'); }
  if (spec.enrichment) s.add(spec.enrichment);
  return s;
}

// ------------------------------------------------------------------------------------------------ layout (pure)

// Beyond these counts a run is so long that the enrichment is far below what any view resolves; the carved motifs that
// are not counted (eggs, beads, leaves, rosettes) are left out and modillions keep their silhouette only (triangle budget).
const MANY = { egg: 2000, bead: 1600, leaf: 500, modillion: 160 };

/** Centres between sorted anchors: each gap is divided into round(gap / pitch) (>= 1) equal steps; anchors included. */
function spaced(anchors, pitch) {
  const a = anchors.slice().sort((x, y) => x - y).filter((x, i, s) => !i || x - s[i - 1] > 1e-6);
  const out = [a[0]];
  for (let i = 1; i < a.length; i++) {
    const n = Math.max(1, Math.round((a[i] - a[i - 1]) / pitch));
    for (let k = 1; k <= n; k++) out.push(a[i - 1] + ((a[i] - a[i - 1]) * k) / n);
  }
  return out;
}

/** Front positions between the two end positions ±e (and any column axes strictly between). */
function frontRow(e, pitch, axes) {
  const inner = (axes || []).filter((x) => Math.abs(x) < e - 1e-6);
  return e <= 1e-9 ? [0] : spaced([-e, ...inner, e], pitch);
}

/** Positions along a return (y from the front toward the back), first at y0, while the piece (half-width h) is whole. */
function sideRow(y0, pitch, half, B) {
  const out = [];
  for (let y = y0; y + half <= B + 1e-9 && out.length < 400; y += pitch) out.push(y);
  return out;
}

/** Evenly spaced motifs (eggs, beads, leaves) along a line of length len: n whole motifs at (k + 0.5)·len/n. */
function motifRow(len, pitch, whole = false) {
  let n = whole ? Math.floor(len / pitch + 1e-9) : Math.round(len / pitch);
  if (!whole && n * pitch > 1.08 * len) n = Math.floor(len / pitch + 1e-9);   // never squeeze motifs by more than 8 %
  return { n: Math.max(0, n), p: whole || !n ? pitch : len / n };
}

/**
 * Where every repeated piece of a run goes (pure: no geometry). tags = absolute profile tags of the run. Front positions
 * are x on the front, side positions are y on the returns (measured back from the front reference plane).
 * ctx: { tags, L, B, returns, D, order, axes (column axes), enrich (Set), detail, ck (cornice kind), fk (frieze kind) }
 */
export function runPlan(ctx) {
  const { tags, L, B, returns, D, order, axes, enrich, detail, ck, fk } = ctx;
  const pl = { pos: {}, dims: {}, counts: {} }, greek = order === 'greek-doric';
  // triglyph rhythm: frieze triglyphs, regulae under them, mutules over triglyphs and metopes
  if ((fk === 'triglyph' && tags.metope) || (ck === 'mutules' && tags.mutBand)) {
    const tw = TRI.w * D, qt = TRI.proj * D, et = (ORDERS[order].shaftTop * D) / 2;
    const e = greek ? (returns ? L / 2 + qt - tw / 2 : L / 2 - tw / 2) : L / 2 - et;
    const front = frontRow(Math.max(0, e), triPitch(order) * D, axes);
    const p = front.length > 1 ? front[1] - front[0] : triPitch(order) * D;
    const side = returns ? sideRow(greek ? -qt + tw / 2 : et, p, tw / 2, B) : [];
    pl.dims.tri = { tw, qt, p };
    if (fk === 'triglyph' && tags.metope) {
      pl.pos.triglyph = { front, side };
      pl.counts.triglyph = front.length + 2 * side.length;
      if (tags.taenia) { pl.pos.regula = { front, side }; pl.counts.regula = pl.counts.triglyph; }
    }
    if (ck === 'mutules' && tags.mutBand) {
      const mid = (r) => r.flatMap((x, i) => (i ? [(r[i - 1] + x) / 2, x] : [x]));
      const sideM = returns ? mid(side).filter((y) => y + tw / 2 <= B + 1e-9) : [];
      pl.pos.mutule = { front: mid(front), side: sideM };
      pl.counts.mutule = pl.pos.mutule.front.length + 2 * sideM.length;
    }
  }
  if (tags.dentilBand && tags.dentilCap) {
    const w = DENTIL.w * D, pitch = DENTIL.pitch * D, qb = tags.dentilBand.p1, cap = tags.dentilCap.p1, qf = cap - 0.08 * (cap - qb);
    const front = frontRow(returns ? L / 2 + qf - w / 2 : L / 2 - w / 2, pitch, axes);
    const p = front.length > 1 ? front[1] - front[0] : pitch;
    const side = returns ? sideRow(-qf + w / 2 + p, p, w / 2, B) : [];
    pl.dims.dentil = { w, qb, qf, h: tags.dentilBand.h1 - tags.dentilBand.h0, z: tags.dentilBand.h0, p };
    pl.pos.dentil = { front, side };
    pl.counts.dentil = front.length + 2 * side.length;
  }
  if (tags.modBand && tags.corona) {
    const qm = tags.modBand.p1, co = tags.corona, l = co.p1 - 2.2 * co.drip - qm, h = co.h0 - tags.modBand.h0;
    const w = Math.min(MODILLION.w * D, 0.6 * l), pitch = MODILLION.pitch * D, dl = 0.06 * w;
    const front = frontRow(returns ? L / 2 + qm - w / 2 - dl : L / 2 - pitch / 2, pitch, axes);
    const p = front.length > 1 ? front[1] - front[0] : pitch;
    const side = returns ? sideRow(-qm + w / 2 + dl, p, w / 2, B) : [];
    pl.dims.mod = { w, l, h, qm, z: tags.modBand.h0, cap: tags.modCap ? tags.modCap.h1 - tags.modCap.h0 : 0,
      capP: tags.modCap ? tags.modCap.p1 - tags.modCap.p0 : 0, dl, p };
    pl.pos.modillion = { front, side };
    pl.counts.modillion = front.length + 2 * side.length;
    pl.dims.mod.plain = pl.counts.modillion > MANY.modillion;     // very long runs: the scroll silhouette only
    if (detail === 'high' && pl.counts.modillion <= MANY.modillion) {
      const gaps = (r) => r.slice(1).map((x, i) => [r[i], x]);
      pl.pos.coffer = { front: gaps(front), side: gaps(side), corners: returns };
      pl.counts.rosette = front.length - 1 + 2 * Math.max(0, side.length - 1) + (returns ? 2 : 0);
    }
  }
  if (enrich.has('egg-and-dart') && tags.ovolo && detail !== 'low') {
    // eggs carved in the ovolo: height 0.8 of the ovolo, width 2/3 of that, the face on the ovolo at mid height
    const o = tags.ovolo, dp = o.p1 - o.p0, dh = o.h1 - o.h0, eh = 0.9 * dh;
    const size = { h: eh, w: 0.64 * eh, d: Math.min(0.56 * eh, 0.9 * dp) }, pitch = 1.36 * size.w;
    const z = o.h0 + dh / 2, q = o.p0 + dp * Math.sin(Math.PI / 3) - 0.36 * size.d;
    const len = returns ? L + 2 * q : L, f = motifRow(len, pitch);
    const fs = returns ? motifRow(B + q, f.p, true) : { n: 0, p: f.p };
    if (f.n > 0 && f.n + 2 * fs.n <= MANY.egg) {
      pl.dims.egg = { q, z, size, len, p: f.p, n: f.n, ns: fs.n, sideLen: B + q };
      pl.counts['ovolo-egg'] = f.n + 2 * fs.n;
    }
  }
  if (enrich.has('bead-and-reel') && detail === 'high') {
    const rows = Object.keys(tags).filter((k) => k.startsWith('astragal')).map((k) => tags[k]);
    if (rows.length) {
      pl.dims.bead = rows.map((t) => {
        const r = (t.h1 - t.h0) / 2, q = t.p0, z = (t.h0 + t.h1) / 2, pitch = 4.7 * r;
        const len = returns ? L + 2 * q : L, f = motifRow(len, pitch), fs = returns ? motifRow(B + q, f.p, true) : { n: 0 };
        return { r, q, z, len, p: f.p, n: f.n, ns: fs.n, sideLen: B + q };
      });
      pl.counts.bead = pl.dims.bead.reduce((s, b) => s + b.n + 2 * b.ns, 0);
      if (pl.counts.bead > MANY.bead || pl.dims.bead.some((b) => !b.n)) { delete pl.dims.bead; delete pl.counts.bead; }
    }
  }
  if (enrich.has('leaf-and-dart') && (tags.leafHost || tags.bed) && detail !== 'low') {
    // Lesbian cymatium (Erechtheion): heart-shaped leaves, point down, rimmed and ribbed, a dart between each pair
    const hostL = tags.leafHost || tags.bed, hb = hostL.h1 - hostL.h0, q = hostL.p0, pitch = 0.9 * hb;
    const len = returns ? L + 2 * q : L, f = motifRow(len, pitch), fs = returns ? motifRow(B + q, f.p, true) : { n: 0 };
    if (f.n > 0 && f.n + 2 * fs.n <= MANY.leaf) {
      pl.dims.lesbian = { q, z: hostL.h0, h: hb, surf: hostL.pts, len, p: f.p, n: f.n, ns: fs.n };
      pl.counts['lesbian-leaf'] = f.n + 2 * fs.n;
    }
  }
  const host = tags.leafHost || tags.bed || (!enrich.has('egg-and-dart') && tags.ovolo);   // an ovolo takes leaves unless it has eggs
  if (enrich.has('acanthus') && host && detail !== 'low') {
    const hb = host.h1 - host.h0, q = host.p0, pitch = 0.82 * hb;
    const len = returns ? L + 2 * q : L, f = motifRow(len, pitch), fs = returns ? motifRow(B + q, f.p, true) : { n: 0 };
    if (f.n > 0 && f.n + 2 * fs.n <= MANY.leaf) {
      pl.dims.leaf = { q, z: host.h0, h: hb, surf: host.pts, len, p: f.p, n: f.n, ns: fs.n, sideLen: B + q };
      pl.counts.leaf = f.n + 2 * fs.n;
    }
  }
  return pl;
}

// ------------------------------------------------------------------------------------------------ motifs

/** Triglyph: two V glyphs, three shanks, two half-glyph chamfers; channels stop under a solid head. Front face at y = 0. */
function triglyphSolid(tw, h, back) {
  const u = tw / 12, g = 0.85 * u, hc = 0.87 * h;
  const sec = [[-6 * u, back], [-6 * u, g], [-5 * u, 0], [-3 * u, 0], [-2 * u, g], [-u, 0], [u, 0], [2 * u, g], [3 * u, 0],
    [5 * u, 0], [6 * u, g], [6 * u, back]];
  const { Manifold } = K();
  const lower = Manifold.extrude(crossSection(sec), hc);
  return union([lower, box(-6 * u, 0, hc - EPS, 6 * u, back, h)]);
}

/** Regula with six guttae hanging from the taenia (top at z = 0, front at y = 0, fascia face at y = toFascia). */
function regulaSolid(tw, hr, hg, toFascia, segs) {
  const { Manifold } = K();
  // guttae: truncated cones widening downward, as deep as the regula projects (their fronts flush with it)
  const r2 = Math.min(tw / 15, 0.5 * toFascia), r1 = 0.75 * r2, list = [box(-tw / 2, 0, -hr, tw / 2, toFascia + 0.004, EPS)];
  for (let k = 0; k < 6; k++) {
    const x = -tw / 2 + tw / 12 + (k * tw) / 6;
    list.push(Manifold.cylinder(hg + EPS, r2, r1, segs).translate([x, Math.max(r2 * 0.6, toFascia - r2), -hr - hg]));
  }
  return union(list);
}

/** Mutule slab under the corona soffit (top z = 0, back at y = 0, front at y = -l) with 3 rows of 6 guttae. */
function mutuleSolid(w, l, t, hg, segs) {
  const { Manifold } = K();
  const list = [box(-w / 2, -l, -t, w / 2, 0.004, EPS)];
  const r = w / 15;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 6; k++) {
    const x = -w / 2 + w / 12 + (k * w) / 6, y = -l * (0.2 + 0.3 * i);
    list.push(Manifold.cylinder(hg + EPS, r, r * 0.8, segs).translate([x, y, -t - hg]));
  }
  return union(list);
}

/**
 * Modillion: a scrolled console lying under the corona (back against the band at y = 0, front at y = -l, bottom z = 0,
 * top z = h). Larger scroll at the back, smaller under the front, an S-curved soffit between; spiral channels on the
 * cheeks, a cap moulding round the top and (separately) an acanthus leaf under the soffit.
 */
export function modillionSolids({ w, l, h, cap, capP }, detail) {
  const { Manifold } = K();
  const hb = h - cap, rb = 0.42 * hb, rf = 0.3 * hb, n = detail === 'low' ? 8 : 16;
  const cf = [l - rf, hb - rf];
  const pB = [rb + rb * Math.cos(-Math.PI / 3), rb + rb * Math.sin(-Math.PI / 3)];
  const pF = [l - rf, hb - 2 * rf];
  const sof = bezier(pF, [pF[0] - 0.32 * (pF[0] - pB[0]), pF[1]], [pB[0] + 0.3 * (pF[0] - pB[0]) * 0.866, pB[1] + 0.3 * (pF[0] - pB[0]) * 0.5], pB, n);
  const poly = [[0, h + EPS], [l, h + EPS], [l, cf[1]], ...arc(cf[0], cf[1], rf, 0, -Math.PI / 2, n).slice(1), ...sof.slice(1),
    ...arc(rb, rb, rb, -Math.PI / 3, -Math.PI, n).slice(1), [-0.004, rb], [-0.004, h + EPS]];
  let body = extrudeProfileX(poly.map(([u, v]) => [-u, v]), w);
  if (detail !== 'low') {
    const g = 0.1 * w, cuts = [];
    const groove = (cx, cz, r0, turns, side) => {
      const sp = spiral(r0, 0.16 * r0, turns, 120, side), ch = 0.2;
      const strip = [...sp.map(([x, z]) => [cx + x, cz + z]), ...sp.slice().reverse().map(([x, z, r]) => [cx + x * (1 - ch * r0 / r), cz + z * (1 - ch * r0 / r)])];
      for (const sx of [1, -1]) cuts.push(extrudeProfileX(strip.map(([u, v]) => [-u, v]), 2 * g, true).translate([sx * w / 2, 0, 0]));
    };
    groove(rb, rb, 0.9 * rb, 1.6, 1);
    groove(cf[0], cf[1], 0.88 * rf, 1.4, -1);
    body = body.subtract(union(cuts));
  }
  const pieces = [body];
  if (cap > 0 && detail !== 'low') {
    const cp = new Prof(0, 0).cymaReversa(capP, cap * 0.75, 8).fillet(cap * 0.25 + EPS).points();
    const prof = [[-0.3 * w, 0], ...cp, [-0.3 * w, cap + EPS]];
    pieces.push(sweep(prof, planFrames([[w / 2, 0.004], [w / 2, -l], [-w / 2, -l], [-w / 2, 0.004]], hb)));
  }
  const solid = union(pieces).simplify(0.0025 * l);
  let leaf = null;
  if (detail !== 'low') {
    // acanthus leaf lying face-down along the soffit, its tip curling under the front scroll
    const u0 = 0.9 * rb, len = l - 0.35 * rf - u0;
    const tab = sof.slice().reverse();                  // soffit (u, v) from back to front
    const vAt = (u) => {
      if (u <= tab[0][0]) return tab[0][1];
      for (let i = 1; i < tab.length; i++) if (u <= tab[i][0]) { const t = (u - tab[i - 1][0]) / (tab[i][0] - tab[i - 1][0]); return tab[i - 1][1] * (1 - t) + tab[i][1] * t; }
      return tab[tab.length - 1][1];
    };
    const lf = acanthusLeaf({ h: len, w: 0.9 * w, lobes: 3, curl: 0.42, lean: 0, nu: 18, nv: 36 });
    // raised by its cupping so the blade's edges tuck into the soffit and the midrib and the curled tip stand proud
    leaf = lf.transform(mat.Rx(Math.PI / 2)).translate([0, -u0, 0]).warp((v) => { v[2] += vAt(-v[1]) + 0.04 * w; }).simplify(0.0025 * l);
  }
  return { solid, leaf };
}

/** Egg-and-dart as ornament.eggAndDart builds it, with the sphere resolution set by the detail level (the egg is
 *  instanced by the hundred along a cornice, so 16 segments instead of 28 keep a portico within its triangle budget). */
function eggDartSolids({ h, w, d }, segs, tilt = 0) {
  const { Manifold } = K();
  if (tilt) { const r = eggDartSolids({ h, w, d }, segs); return { egg: r.egg.transform(mat.Rx(tilt)), dart: r.dart.transform(mat.Rx(tilt)) }; }
  const egg = Manifold.sphere(1, segs).scale([w / 2, d / 2, h / 2]);
  const shell = Manifold.sphere(1, segs).scale([w / 2 + w * 0.12, (d / 2) * 0.7, h / 2 + w * 0.1]).translate([0, d * 0.18, 0])
    .subtract(Manifold.sphere(1, segs).scale([w / 2 + w * 0.04, d, h / 2 + w * 0.03]).translate([0, -d * 0.1, 0]));
  const dart = Manifold.sphere(1, 8).scale([w * 0.09, d * 0.32, h * 0.52]).translate([0, d * 0.05, -h * 0.05]);
  return { egg: union([egg, shell]), dart };
}

/** Bead (olive, 2 : 1) and reel (a pair of discs), carved out of a half-round: flat at the back (y = +0.2 r). */
function beadSolids(r, segs) {
  const { Manifold } = K();
  const bead = Manifold.sphere(1, segs).scale([1.7 * r, r, r]).trimByPlane([0, -1, 0], -0.2 * r);
  const disc = Manifold.cylinder(0.32 * r, 0.82 * r, 0.82 * r, segs).rotate([0, 90, 0]);
  const reel = union([disc.translate([-0.42 * r, 0, 0]), disc.translate([0.1 * r, 0, 0])]).trimByPlane([0, -1, 0], -0.2 * r);
  return { bead, reel };
}

// ------------------------------------------------------------------------------------------------ run ornaments

/** An axis-aligned box mapped by a matrix of quarter turns, translations and axis mirrors, built in place. */
function boxT(x0, y0, z0, x1, y1, z1, M) {
  const a = mat.apply(M, [x0, y0, z0]), b = mat.apply(M, [x1, y1, z1]);
  return box(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]));
}

/** Instance matrices on the front (x) and the two returns (y) at projection q and height z, composed with `local`. */
function placer(L, returns) {
  const F = (x, q, z, local) => mat.mul(mat.T(x, -q, z), local || mat.I());
  const S = (s, y, q, z, local) => mat.mul(mat.T(s * (L / 2 + q), y, z), mat.Rz((s * Math.PI) / 2), local || mat.I());
  const all = (front, side, q, z, local) => [...front.map((x) => F(x, q, z, local)),
    ...(returns ? [1, -1].flatMap((s) => side.map((y) => S(s, y, q, z, local))) : [])];
  const corner = (s, q, z, local) => mat.mul(mat.T(s * (L / 2 + q), -q, z), mat.Rz((s * Math.PI) / 4), local || mat.I());
  return { F, S, all, corner };
}

/** Repeated pieces of a run as instanced parts; also returns the coffers to cut from the cornice soffit. */
function runParts(pl, ctx) {
  const { tags, L, B, returns, D, detail } = ctx;
  const { all, corner, F, S } = placer(L, returns);
  const segs = detail === 'low' ? 8 : detail === 'medium' ? 12 : 16;
  const parts = [], cuts = [];
  if (pl.pos.triglyph) {
    const { tw, qt } = pl.dims.tri, m = tags.metope;
    const tri = triglyphSolid(tw, m.h1 - m.h0 + EPS, qt + 0.6 * (tw / 12));
    parts.push(part('triglyph', 'stone', tri, instances(all(pl.pos.triglyph.front, pl.pos.triglyph.side, qt, m.h0))));
  }
  if (pl.pos.regula) {
    const { tw } = pl.dims.tri, t = tags.taenia, below = tags.fascia2 || tags.fascia1;
    const ht = t.h1 - t.h0, toF = t.p1 - below.p1;
    const reg = regulaSolid(tw, 0.45 * ht, 0.55 * ht, toF, segs);
    parts.push(part('regula', 'stone', reg, instances(all(pl.pos.regula.front, pl.pos.regula.side, t.p1 - 0.004, t.h0))));
  }
  if (pl.pos.mutule) {
    const { tw } = pl.dims.tri, mb = tags.mutBand, co = tags.corona, hb = co.h0 - mb.h0;
    const l = co.p1 - 2.6 * co.drip - mb.p1 - 0.02 * D;
    const mu = mutuleSolid(tw, l, 0.38 * hb, 0.3 * hb, segs);
    parts.push(part('mutule', 'stone', mu, instances(all(pl.pos.mutule.front, pl.pos.mutule.side, mb.p1, co.h0))));
  }
  if (pl.pos.dentil) {
    const d = pl.dims.dentil, depth = Math.max(d.w, d.qf - d.qb + 0.002);
    const den = box(-d.w / 2, 0, 0, d.w / 2, depth, d.h + EPS);
    parts.push(part('dentil', 'stone', den, instances(all(pl.pos.dentil.front, pl.pos.dentil.side, d.qf, d.z))));
  }
  if (pl.pos.modillion) {
    const md = pl.dims.mod, { solid, leaf } = modillionSolids(md, md.plain ? 'low' : detail);
    const xf = all(pl.pos.modillion.front, pl.pos.modillion.side, md.qm, md.z);
    parts.push(part('modillion', 'stone', solid, instances(xf)));
    if (leaf) parts.push(part('modillion-leaf', 'stone', leaf, instances(xf)));
    if (pl.pos.coffer) {
      const co = tags.corona, depth = 0.3 * (co.h1 - co.h0), m = 0.045 * D, y0 = md.qm + m, y1 = md.qm + md.l - m * 0.5;
      const zc = co.h0 - EPS, rosXf = [];
      const ros = rosette(Math.min(0.32 * (md.p - md.w - 2 * m), 0.4 * (y1 - y0)), 8).transform(mat.Rx(Math.PI / 2));
      const addFront = (a, b, xform) => {
        const x0 = a + md.w / 2 + m, x1 = b - md.w / 2 - m;
        if (x1 - x0 < 2 * m) return;
        cuts.push(boxT(x0, -y1, zc, x1, -y0, co.h0 + depth, xform));
        rosXf.push(mat.T(...mat.apply(xform, [(x0 + x1) / 2, -(y0 + y1) / 2, co.h0 + depth - 0.002])));   // translation only: no mirrored instances
      };
      for (const [a, b] of pl.pos.coffer.front) addFront(a, b, mat.I());
      if (returns) for (const s of [1, -1]) for (const [a, b] of pl.pos.coffer.side) {
        // a side coffer built in the right return's frame (canonical x -> y along the return), mirrored for the left
        addFront(a, b, mat.mul(mat.S(s, 1, 1), mat.T(L / 2, 0, 0), mat.Rz(Math.PI / 2)));
      }
      if (returns) for (const s of [1, -1]) {
        const xa = L / 2 + md.qm - md.dl + m, xb = L / 2 + md.qm + md.l - m * 0.5, ya = -(md.qm + md.l - m * 0.5), yb = -(md.qm - md.dl + m);
        cuts.push(boxT(xa, ya, zc, xb, yb, co.h0 + depth, mat.S(s, 1, 1)));
        rosXf.push(mat.T(s * (xa + xb) / 2, (ya + yb) / 2, co.h0 + depth - 0.002));
      }
      parts.push(part('rosette', 'stone', ros, instances(rosXf)));
    }
  }
  if (pl.dims.egg) {
    // the egg mesh is built already tilted, so its own bounding box is tight (instances only move and turn by quarters)
    const e = pl.dims.egg, { egg, dart } = eggDartSolids(e.size, segs, EGG_TILT), tilt = mat.I(), sink = 0;
    const fx = Array.from({ length: e.n }, (_, k) => -e.len / 2 + (k + 0.5) * e.p);
    const fd = Array.from({ length: e.n - 1 }, (_, k) => -e.len / 2 + (k + 1) * e.p);
    const sy = Array.from({ length: e.ns }, (_, k) => -e.q + (k + 0.5) * e.p);
    const sd = Array.from({ length: Math.max(0, e.ns - 1) }, (_, k) => -e.q + (k + 1) * e.p);
    parts.push(part('ovolo-egg', 'stone', egg, instances(all(fx, sy, e.q - sink, e.z, tilt))));
    const dx = all(fd, sd, e.q - sink - 0.1 * e.size.d, e.z, tilt);
    if (returns) for (const s of [1, -1]) dx.push(corner(s, e.q - sink - 0.1 * e.size.d, e.z, tilt));
    if (dx.length) parts.push(part('ovolo-dart', 'stone', dart, instances(dx)));
  }
  if (pl.dims.bead) {
    const bx = [], rx = [];
    const r0 = pl.dims.bead[0].r, { bead, reel } = beadSolids(r0, Math.max(segs, Math.min(40, Math.round(r0 * 600))));
    for (const b of pl.dims.bead) {
      const k = b.r / pl.dims.bead[0].r, sc = mat.S(k);
      bx.push(...all(Array.from({ length: b.n }, (_, i) => -b.len / 2 + (i + 0.5) * b.p), Array.from({ length: b.ns }, (_, i) => -b.q + (i + 0.5) * b.p), b.q, b.z, sc));
      rx.push(...all(Array.from({ length: b.n - 1 }, (_, i) => -b.len / 2 + (i + 1) * b.p), Array.from({ length: Math.max(0, b.ns - 1) }, (_, i) => -b.q + (i + 1) * b.p), b.q, b.z, sc));
    }
    parts.push(part('bead', 'stone', bead, instances(bx)));
    if (rx.length) parts.push(part('reel', 'stone', reel, instances(rx)));
  }
  if (pl.dims.leaf) {
    const lf = pl.dims.leaf;
    // an upright leaf bent onto the moulding: each point moves out by the profile's projection at its height
    const qAt = (zz) => {
      const sp = lf.surf, z = lf.z + zz;
      if (z <= sp[0][1]) return sp[0][0];
      for (let i = 1; i < sp.length; i++) if (z <= sp[i][1]) { const t = (z - sp[i - 1][1]) / Math.max(1e-12, sp[i][1] - sp[i - 1][1]); return sp[i - 1][0] * (1 - t) + sp[i][0] * t; }
      return sp[sp.length - 1][0];
    };
    // on a convex-topped host (cyma reversa, ovolo) the tip only nods; on a concave one (cyma recta, cavetto) it curls over
    const convexTop = lf.surf.length > 2 && (() => { const a = lf.surf[lf.surf.length - 3], b = lf.surf[lf.surf.length - 2], c = lf.surf[lf.surf.length - 1];
      return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) > 0; })();
    const leaf = acanthusLeaf({ h: lf.h * (convexTop ? 0.98 : 0.94), w: (convexTop ? 0.94 : 0.86) * lf.p, lobes: 3, curl: convexTop ? 0.18 : 0.45, lean: 0, nu: 16, nv: 32 })
      .warp((v) => { v[1] -= qAt(Math.max(0, v[2])) - lf.q; });
    const fx = Array.from({ length: lf.n }, (_, k) => -lf.len / 2 + (k + 0.5) * lf.p);
    const sy = Array.from({ length: lf.ns }, (_, k) => -lf.q + (k + 0.5) * lf.p);
    parts.push(part('leaf', 'stone', leaf, instances(all(fx, sy, lf.q - 0.15 * (lf.h / 10), lf.z))));
  }
  if (pl.dims.lesbian) {
    const lf = pl.dims.lesbian, { leaf, dart } = lesbianSolids(lf);
    const fx = Array.from({ length: lf.n }, (_, k) => -lf.len / 2 + (k + 0.5) * lf.p);
    const fd = Array.from({ length: lf.n - 1 }, (_, k) => -lf.len / 2 + (k + 1) * lf.p);
    const sy = Array.from({ length: lf.ns }, (_, k) => -lf.q + (k + 0.5) * lf.p);
    const sd = Array.from({ length: Math.max(0, lf.ns - 1) }, (_, k) => -lf.q + (k + 1) * lf.p);
    parts.push(part('lesbian-leaf', 'stone', leaf, instances(all(fx, sy, lf.q, lf.z))));
    const dx = all(fd, sd, lf.q, lf.z);
    if (dx.length) parts.push(part('lesbian-dart', 'stone', dart, instances(dx)));
  }
  void F; void S; void B;
  return { parts, cuts };
}

/**
 * Lesbian leaf-and-dart for a cyma reversa (the Erechtheion's cymatium): a heart-shaped leaf, point down, 0.8 of the
 * pitch wide and 0.96 of the moulding high, its two lobes rounded under the top; a raised rim and a tapering midrib;
 * the dart a narrow lozenge between leaves. Drawn in elevation, given a shallow relief, refined and bent onto the
 * profile (each point moves out by the moulding's projection at its height). Local: y = 0 on the host's base line.
 */
function lesbianSolids(lf) {
  const { CrossSection } = K();
  const W = 0.8 * lf.p, H = 0.92 * lf.h, N = 14;
  const right = [];
  for (let i = 0; i <= N; i++) { const v = i / N; right.push([(W / 2) * Math.sin((Math.PI / 2) * v) ** 0.85, v * 0.66 * H]); }
  const cx = W / 4, cz = 0.66 * H, rx = W / 4, rz = 0.31 * H;
  for (let i = 1; i <= N; i++) { const a = (0.86 * Math.PI * i) / N; right.push([cx + rx * Math.cos(a), cz + rz * Math.sin(a)]); }
  const heart = [...right, [0, 0.8 * H], ...right.slice(1).reverse().map(([x, z]) => [-x, z])];
  const cs = new CrossSection([heart], 'NonZero'), inner = cs.offset(-0.07 * W, 'Round', 2, 12);
  const rib = [[-0.035 * W, 0.08 * H], [0.035 * W, 0.08 * H], [0.02 * W, 0.74 * H], [-0.02 * W, 0.74 * H]];
  const d = lf.h;
  const leafM = union([slab(inner, -0.05 * d, 0.06 * d), slab(cs.subtract(inner), -0.085 * d, 0.06 * d), slab(rib, -0.08 * d, 0.06 * d)]);
  const dartM = slab([[0, 0.06 * H], [0.07 * W, 0.5 * H], [0.045 * W, 0.92 * H], [-0.045 * W, 0.92 * H], [-0.07 * W, 0.5 * H]], -0.07 * d, 0.06 * d);
  const sp = lf.surf, qAt = (zz) => {
    const z = lf.z + zz;
    if (z <= sp[0][1]) return sp[0][0];
    for (let i = 1; i < sp.length; i++) if (z <= sp[i][1]) { const t = (z - sp[i - 1][1]) / Math.max(1e-12, sp[i][1] - sp[i - 1][1]); return sp[i - 1][0] * (1 - t) + sp[i][0] * t; }
    return sp[sp.length - 1][0];
  };
  // the relief flattens toward the top, where the cyma's convex lip reaches the crowning fillet's line
  const bend = (m) => m.refineToLength(lf.h / 14).warp((v) => {
    const z = Math.max(0, v[2]), k = 1 - 0.75 * sstep((z - 0.55 * lf.h) / (0.4 * lf.h));
    v[1] = (v[1] < 0 ? v[1] * k : v[1]) - (qAt(z) - lf.q);
  });
  return { leaf: bend(leafM), dart: bend(dartM) };
}

// ------------------------------------------------------------------------------------------------ entablature / cornice

/** Shift profile points / tags forward by dq (a run whose reference plane sits dq in front of the wall). */
const shiftPts = (pts, dq) => (dq ? pts.map(([q, z]) => [q + dq, z]) : pts);
function shiftTags(tags, dq) {
  if (!dq) return tags;
  const out = {};
  for (const [k, t] of Object.entries(tags)) out[k] = { ...t, p0: t.p0 + dq, p1: t.p1 + dq, pts: t.pts && t.pts.map(([q, z]) => [q + dq, z]) };
  return out;
}

/**
 * The plan of an entablature run (pure: profiles, sizes, ornament positions). Used by build, expected and the portico.
 * o: { order, D, L, B?, returns, fk, ck, enrich (Set), detail, parts: 'all' | 'cornice' | 'lower', axes, noSima, z0 }
 */
export function entablaturePlan(o) {
  const order = orderKey(o.order), D = o.D, n = curveN(o.detail);
  const { arch: a, frieze: f, cornice: c } = entablatureDims(order, D);
  const lower = o.parts !== 'cornice', upper = o.parts !== 'lower';
  const segs = {};
  let z = o.z0 || 0;
  if (lower) {
    const beads = o.enrich.has('bead-and-reel') && o.detail === 'high';
    segs.architrave = drawMembers(architraveMembers(order, a, D, beads), n, z); z += a;
    if (f > 1e-9) { segs.frieze = drawMembers(friezeMembers(o.fk, f, D, order), n, z); z += f; }
  }
  if (upper) { segs.cornice = drawMembers(corniceMembers(o.ck, c, { noSima: o.noSima }), n, z); z = segs.cornice.top; }
  const tags = Object.assign({}, ...Object.values(segs).map((s) => s.tags));
  const P = Math.max(...Object.values(segs).map((s) => s.P));
  const Pc = PROJ[o.ck] * c;
  let B = o.B ?? (upper ? Pc : D);
  if (o.returns) B = Math.min(B, 0.49 * o.L);
  const pl = runPlan({ tags, L: o.L, B, returns: o.returns, D, order, axes: o.axes, enrich: o.enrich, detail: o.detail,
    ck: upper ? o.ck : null, fk: lower ? o.fk : null });
  return { ...o, order, a, f, c, segs, tags, P, Pc, B, H: z - (o.z0 || 0), pl,
    size: { x: o.returns ? o.L + 2 * P : o.L, z: z - (o.z0 || 0) } };
}

/** Geometry of an entablature plan: one swept part per member group (architrave, frieze, cornice) + ornaments. */
export function entablatureParts(plan) {
  const { segs, L, B, returns } = plan, out = [];
  const names = Object.keys(segs);
  const solids = {};
  names.forEach((name, i) => {
    let pts = segs[name].pts;
    if (i > 0) pts = [[0, pts[0][1] - EPS], ...pts];  // overlap into the member group below
    solids[name] = runSolid(pts, L, B, returns);
  });
  const { parts, cuts } = runParts(plan.pl, { tags: plan.tags, L, B, returns, D: plan.D, detail: plan.detail });
  if (cuts.length && solids.cornice) solids.cornice = solids.cornice.subtract(union(cuts));
  for (const name of names) out.push(part(name, 'stone', solids[name]));
  return [...out, ...parts];
}

function entSpecPlan(spec) {
  const order = orderKey(spec.order), O = ORDERS[order], e = O.ent;
  const alone = spec.element === 'cornice';
  const tot = alone ? e.cornice : e.arch + e.frieze + e.cornice;
  const D = spec.height ? spec.height / tot : (spec.diameter || DEFAULT_D);
  return entablaturePlan({ order, D, L: spec.length || 3, B: spec.depth, returns: spec.returns !== false,
    fk: friezeKindFor(spec, order), ck: corniceKindFor(spec, order), enrich: enrichSet(spec, order),
    detail: spec.detail || 'high', parts: alone ? 'cornice' : 'all' });
}

// ------------------------------------------------------------------------------------------------ moulding run

// [type, height fraction, projection fraction of the moulding height, tag]
const MOULDINGS = {
  ovolo: [['fillet', 0.12, 0.08], ['ovolo', 0.74, 0.78, 'ovolo'], ['fillet', 0.14, 0.84]],
  cavetto: [['fillet', 0.12, 0.06], ['cavetto', 0.76, 0.8, 'leafHost'], ['fillet', 0.12, 0.86]],
  'cyma-recta': [['fillet', 0.1, 0.05], ['cymaRecta', 0.78, 0.84, 'leafHost'], ['fillet', 0.12, 0.88]],
  'cyma-reversa': [['fillet', 0.1, 0.05], ['cymaReversa', 0.78, 0.6, 'leafHost'], ['fillet', 0.12, 0.64]],
  torus: [['fillet', 0.1, 0.04], ['torus', 0.8, 0.04, 'astragal'], ['fillet', 0.1, 0.04]],
  scotia: [['fillet', 0.14, 0.42], ['scotia', 0.72, 0.28, 'scotia'], ['fillet', 0.14, 0.28]],
  bead: [['fillet', 0.15, 0.03], ['torus', 0.7, 0.03, 'astragal'], ['fillet', 0.15, 0.03]],
  crown: [['cavetto', 0.22, 0.18, 'leafHost'], ['fillet', 0.05, 0.22], ['corona', 0.26, 0.62, 'corona'], ['fillet', 0.05, 0.65],
    ['cymaRecta', 0.32, 0.93], ['fillet', 0.1, 0.96]],
};
const HOSTS = { 'egg-and-dart': ['ovolo'], 'bead-and-reel': ['bead', 'torus'], acanthus: ['cavetto', 'cyma-recta', 'cyma-reversa', 'ovolo', 'crown'],
  'leaf-and-dart': ['cyma-reversa'] };

/**
 * A moulding run: the profile, and when the enrichment cannot be carved on the profile itself, an enriched course under
 * it (egg-and-dart on an ovolo, bead-and-reel on an astragal, acanthus on a cyma reversa, dentils on a dentil course).
 */
export function mouldingPlan(spec) {
  const H = spec.height || 0.16, L = spec.length || 1.2, profile = MOULDINGS[spec.profile] ? spec.profile : 'ovolo';
  // stated enrichment ('none' = none), else the profile's canonical one: ovolo egg-and-dart, astragal bead-and-reel,
  // cyma reversa leaf-and-dart (acanthus leaves); torus, scotia, cavetto, cyma recta and crown plain
  const en = !stated(spec, 'enrichment') || !spec.enrichment ? (MOULDING_ENRICH[profile] || null)
    : spec.enrichment !== 'none' ? spec.enrichment : null, n = curveN(spec.detail);
  const course = en && (en === 'dentils' || !HOSTS[en].includes(profile)) ? en : null;
  const fr = course === 'dentils' ? 0.42 : course === 'egg-and-dart' ? 0.36 : course === 'acanthus' ? 0.4 : course ? 0.2 : 0;
  const hc = fr * H, hm = H - hc, members = [];
  let base = 0;
  if (course === 'dentils') {
    members.push({ t: 'fillet', h: 0.8 * hc, p: 0.04 * H, tag: 'dentilBand' }, { t: 'fillet', h: 0.2 * hc, p: 0.04 * H + 0.4 * hc, tag: 'dentilCap' });
    base = 0.04 * H + 0.4 * hc;
  } else if (course === 'egg-and-dart') {
    members.push({ t: 'fillet', h: 0.12 * hc, p: 0.04 * H }, { t: 'ovolo', h: 0.88 * hc, p: 0.04 * H + 0.85 * hc, tag: 'ovolo' });
    base = 0.04 * H + 0.85 * hc;
  } else if (course === 'bead-and-reel') {
    members.push({ t: 'torus', h: hc, p: 0.03 * H, tag: 'astragal', k: (spec.detail || 'high') === 'high' ? BEAD_CORE : 1 });
    base = 0.03 * H;
  } else if (course === 'acanthus') {
    members.push({ t: 'fillet', h: 0.1 * hc, p: 0.03 * H }, { t: 'cymaReversa', h: 0.9 * hc, p: 0.03 * H + 0.55 * hc, tag: 'leafHost' });
    base = 0.03 * H + 0.55 * hc;
  }
  for (const [t, h, p, tag] of MOULDINGS[profile]) {
    const m = { t, h: h * hm, p: base + p * hm, tag: course ? (tag === 'ovolo' || tag === 'astragal' || tag === 'leafHost' ? undefined : tag) : tag };
    if (t === 'scotia') { m.depth = 0.32 * hm; m.end = -0.14 * hm; }
    if (t === 'torus') m.k = en === 'bead-and-reel' && (spec.detail || 'high') === 'high' ? BEAD_CORE : 1;
    if (t === 'corona') m.drip = 0;
    members.push(m);
  }
  const pr = drawMembers(members, n, 0);
  const returns = spec.returns === true, B = 0.002;
  const enrich = new Set(en ? [en] : []);
  const D = H * 1.2;                                    // dentil module: dentils ~ D/6 wide on a 0.42 H course
  const pl = runPlan({ tags: pr.tags, L, B, returns, D, order: 'ionic', enrich, detail: spec.detail || 'high', ck: null, fk: null });
  if (course === 'dentils') {
    // dentil course of a moulding: dentil width = 0.6 x the course height (Vignola's 2:3 dentil), pitch 1.5 x width
    const t = pr.tags, w = 0.62 * (t.dentilBand.h1 - t.dentilBand.h0), pitch = 1.5 * w, qb = t.dentilBand.p1, qf = t.dentilCap.p1 - 0.08 * (t.dentilCap.p1 - qb);
    const front = frontRow(returns ? L / 2 + qf - w / 2 : L / 2 - w / 2, pitch, null);
    pl.dims.dentil = { w, qb, qf, h: t.dentilBand.h1 - t.dentilBand.h0, z: t.dentilBand.h0, p: pitch };
    pl.pos.dentil = { front, side: [] };
    pl.counts.dentil = front.length;
  }
  return { L, H, B, returns, pr, pl, profile, course, size: { x: returns ? L + 2 * pr.P : L, z: H } };
}

function buildMoulding(spec) {
  const mp = mouldingPlan(spec), { L, B, returns, pr } = mp;
  const pts = [...pr.pts, [0, pr.top]];                // closed to the wall plane y = 0 (pr.pts starts at (0, 0))
  const solid = sweep(pts, planFrames(runPts(L, B, returns)));
  const { parts } = runParts(mp.pl, { tags: pr.tags, L, B, returns, D: mp.H * 1.2, detail: spec.detail || 'high' });
  return [part('moulding', 'stone', solid), ...parts];
}

// ------------------------------------------------------------------------------------------------ pediment

/**
 * Pediment plan. The horizontal cornice (without its sima) returns at both ends; the raking cornice is the full cornice
 * drawn plumb (its vertical sections equal the horizontal profile, Ware), its corona drip passing through the outer top
 * edge of the horizontal cornice; the tympanum is recessed in the frieze plane. Pitch: Serlio's / Vignola's construction
 * (a circle through the eaves from a centre half the width below the cornice) gives 22.5 deg; a segmental pediment is
 * the arc through the same eaves points and apex, its members concentric (radial sections). Broken: the rakes stop
 * 0.15 W either side of the axis, the tympanum is cut level there.
 * o: { order, D, W, B, kind, pitch, ck, enrich, detail, axes, dq (reference plane in front of the wall), z0 }
 */
export function pedimentPlan(o) {
  const order = orderKey(o.order), O = ORDERS[order], D = o.D, n = curveN(o.detail), dq = o.dq || 0, z0 = o.z0 || 0;
  const c = O.ent.cornice * D, kind = ['segmental', 'broken', 'broken-segmental'].includes(o.kind) ? o.kind : 'triangular';
  const seg = kind === 'segmental' || kind === 'broken-segmental', broken = kind.startsWith('broken');
  const hor = drawMembers(corniceMembers(o.ck, c, { noSima: true }), n, z0);
  const full = drawMembers(corniceMembers(o.ck, c), n, 0);
  const hh = hor.top, Ph = hor.P + dq, xo = o.W / 2 + Ph;
  const zc0 = full.tags.corona ? full.tags.corona.h0 : 0.5 * c;
  const th = ((o.pitch ?? defaultPitch(order)) * Math.PI) / 180, t = Math.tan(th), rise = xo * t;
  const gap = broken ? 0.3 * o.W : 0;
  const B = o.B ?? PROJ[o.ck] * c;
  const tags = shiftTags(hor.tags, dq);
  const hpl = runPlan({ tags, L: o.W, B, returns: true, D, order, axes: o.axes, enrich: o.enrich, detail: o.detail, ck: o.ck, fk: null });
  // the rake's drip line passes the groove height below the outer top edge of the horizontal cornice, so the throat of
  // the raking corona dies into the horizontal cornice instead of showing as a notch at the eaves
  const hd = hh - (full.tags.corona ? full.tags.corona.drip : 0);
  const zOff = (x) => hd - zc0 + (xo - Math.abs(x)) * t;             // plumb rake: height of the profile's base at x
  const Rd = (xo * xo + rise * rise) / (2 * rise), zC = hd + rise - Rd, Rb = Rd - zc0; // segmental: drip circle, bed radius
  const crown = hd - zc0 + xo * t + full.top;                           // apex / crown of the sima (unbroken)
  let top = seg ? (broken ? zC + Math.sqrt((Rb + full.top) ** 2 - (gap / 2) ** 2) : crown) : hd - zc0 + (xo - gap / 2) * t + full.top;
  // broken: an urn (finial.js, flame knob) on a moulded pedestal stands on the level top of the tympanum in the gap,
  // rising a tenth above where the unbroken apex would be; the pedestal's die face is in the tympanum plane
  let urn = null;
  if (broken) {
    const zf = seg ? zC + Math.sqrt(Rb * Rb - (gap / 2) ** 2) : zOff(gap / 2);
    // pedestal 0.28 and urn 0.72 of the group; the pedestal's die a little wider than the urn's own socle (0.135 H)
    const T = Math.max(0.35 * gap, 1.1 * (crown - zf)), hP = 0.28 * T, Hu = T - hP, aP = Math.min(0.17 * Hu, 0.3 * gap);
    urn = { zf, aP, hP, Hu, y: -dq + aP };
    top = Math.max(top, zf + hP + Hu);
  }
  return { ...o, order, kind, seg, broken, D, c, n, hor, full, hh, hd, Ph, xo, zc0, th, t, rise, gap, B, dq, z0, tags, hpl, zOff, Rd, zC,
    Rb, urn, size: { x: o.W + 2 * Ph, z: top - z0 } };
}

/** Pediment pitch when none is asked: Serlio's / Vignola's 22.5 deg; a Greek Doric front follows Vitruvius (III.5.12:
 *  the tympanum one ninth of the cornice length, atan(2/9) = 12.5 deg, close to the Parthenon's 13.5 deg). */
export const defaultPitch = (order) => (order === 'greek-doric' ? (Math.atan(2 / 9) * 180) / Math.PI : 22.5);

/** Collect instances into a part by name (reusing its manifold when it exists). */
function addTo(parts, name, make, xf) {
  if (!xf.length) return;
  const p = parts.find((q) => q.name === name);
  if (p) { p.transforms = instances([...Array.from({ length: p.transforms.length / 16 }, (_, i) => p.transforms.subarray(16 * i, 16 * i + 16)), ...xf]); return; }
  parts.push(part(name, 'stone', make(), instances(xf)));
}

export function pedimentParts(pp) {
  const { W, B, dq, hh, xo, zOff, t, th, kind, gap, full, D, detail } = pp;
  const { Manifold } = K();
  const parts = [];
  // horizontal cornice and its ornaments
  // seated (o.seat) the horizontal cornice reaches EPS down into what carries it (a surround's frieze): touching faces
  // would leave two solids
  const hp0 = shiftPts(pp.hor.pts, dq);
  let hc = runSolid(pp.seat ? [[dq, hp0[0][1] - EPS], ...hp0] : hp0, W, B, true);
  const ho = runParts(pp.hpl, { tags: pp.tags, L: W, B, returns: true, D, detail });
  if (ho.cuts.length) hc = hc.subtract(union(ho.cuts));
  parts.push(part('cornice', 'stone', hc), ...ho.parts);
  // raking cornice
  const prof = closeBack(shiftPts(full.pts, dq), B);
  const fr = (x, z) => ({ o: [x, 0, z], A: [0, -1, 0], B: [0, 0, 1] });
  let rake;
  if (pp.seg) {
    const ad = Math.asin(Math.min(1, xo / pp.Rd)) * 1.12, N = detail === 'low' ? 24 : detail === 'medium' ? 36 : 56, frames = [];
    for (let i = 0; i <= N; i++) {
      const a = -ad + (2 * ad * i) / N, u = [Math.sin(a), 0, Math.cos(a)];
      frames.push({ o: [pp.Rb * u[0], 0, pp.zC + pp.Rb * u[2]], A: [0, -1, 0], B: u });
    }
    rake = sweep(prof, frames).trimByPlane([-1, 0, 0], -xo).trimByPlane([1, 0, 0], -xo);
    if (pp.broken) rake = union([rake.trimByPlane([1, 0, 0], gap / 2), rake.trimByPlane([-1, 0, 0], gap / 2)]);
  } else if (kind === 'broken') {
    rake = union([sweep(prof, [fr(-xo, zOff(xo)), fr(-gap / 2, zOff(gap / 2))]), sweep(prof, [fr(gap / 2, zOff(gap / 2)), fr(xo, zOff(xo))])]);
  } else {
    rake = sweep(prof, [fr(-xo, zOff(xo)), fr(0, zOff(0)), fr(xo, zOff(xo))]);
  }
  rake = rake.trimByPlane([0, 0, 1], hh - EPS);
  parts.push(part('raking-cornice', 'stone', rake));
  // tympanum, recessed in the reference (frieze) plane
  let ty;
  if (pp.seg) {
    const xt = Math.sqrt(Math.max(0, pp.Rb * pp.Rb - (hh - pp.zC) ** 2)), N = 32, poly = [[-xt, hh - EPS], [xt, hh - EPS]];
    const arcZ = (x) => pp.zC + Math.sqrt(pp.Rb * pp.Rb - x * x);
    if (pp.broken) {                                    // the arc down to the gap, then level across it
      for (let i = 1; i <= N; i++) { const x = xt - ((xt - gap / 2) * i) / N; poly.push([x, arcZ(x) + EPS]); }
      poly.push([gap / 2 - EPS, pp.urn.zf], [-gap / 2 + EPS, pp.urn.zf]);
      for (let i = 0; i < N; i++) { const x = -gap / 2 - ((xt - gap / 2) * i) / N; poly.push([x, arcZ(x) + EPS]); }
    } else for (let i = 1; i < N; i++) { const x = xt - (2 * xt * i) / N; poly.push([x, arcZ(x) + EPS]); }
    ty = poly;
  } else {
    const xt = xo - (pp.zc0 + hh - pp.hd) / t;
    ty = kind === 'broken'
      ? [[-xt, hh - EPS], [xt, hh - EPS], [gap / 2, zOff(gap / 2) + EPS], [gap / 2 - EPS, zOff(gap / 2)], [-gap / 2 + EPS, zOff(gap / 2)], [-gap / 2, zOff(gap / 2) + EPS]]
      : [[-xt, hh - EPS], [xt, hh - EPS], [0, zOff(0) + EPS]];
  }
  const tyM = Manifold.extrude(crossSection(ty), B + dq).transform(Float64Array.from([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1])).translate([0, B, 0]);
  parts.push(part('tympanum', 'stone', tyM));
  // ornaments of the rake: plumb dentils (sheared), modillions square to the slope, eggs along the ovolo
  const ft = full.tags, hp = pp.hpl;
  const lim = (x, half, zLow) => x - half >= gap / 2 && x + half <= xo - 0.01 * D && zLow >= hh + EPS;
  const radial = pp.seg;
  const at = (x, q, zp, local) => mat.mul(mat.T(x, -q, zOff(x) + zp), local);
  const atR = (a, q, zp, local) => mat.mul(mat.T(Math.sin(a) * (pp.Rb + zp), -q, pp.zC + Math.cos(a) * (pp.Rb + zp)), mat.Ry(a), local);
  const arcRow = (r, pitch, half, zp) => {          // symmetric angular positions on the radial rake, whole pieces only
    const out = [], da = pitch / r, kmax = Math.floor(Math.PI / 2 / da);
    for (let k = -kmax; k <= kmax; k++) {
      const a = k * da, x = Math.sin(a) * (pp.Rb + zp), zl = pp.zC + Math.cos(Math.abs(a) + half / r) * (pp.Rb + zp);
      if (Math.abs(x) + half <= xo - 0.01 * D && Math.abs(x) - half >= gap / 2 && zl >= hh + EPS) out.push(a);
    }
    return out;
  };
  // every instance matrix stays a rotation + translation (glTF nodes must decompose into TRS): the plumb shear of the
  // raking dentils and the cos(pitch) height of the raking modillions are baked into their own meshes
  const sh = (s) => { const m = mat.I(); m[2] = s; return m; };
  if (hp.pos.dentil) {
    const d = hp.dims.dentil, qf = ft.dentilCap.p1 + dq - 0.08 * (ft.dentilCap.p1 - ft.dentilBand.p1), zp = ft.dentilBand.h0;
    const depth = Math.max(d.w, qf - (ft.dentilBand.p1 + dq) + 0.002), hgt = ft.dentilBand.h1 - zp;
    const den = () => box(-d.w / 2, 0, 0, d.w / 2, depth, hgt + EPS);
    if (radial) addTo(parts, 'dentil', den, arcRow(pp.Rb + zp, d.p, d.w / 2, zp).map((a) => atR(a, qf, zp, mat.I())));
    else {
      const xs = hp.pos.dentil.front.filter((x) => Math.abs(x) > 1e-6).filter((x) => lim(Math.abs(x), d.w / 2, zOff(Math.abs(x) + d.w / 2) + zp));
      for (const side of [1, -1]) {
        const xf = xs.filter((x) => Math.sign(x) === side).map((x) => at(x, qf, zp, mat.I()));
        if (xf.length) parts.push(part('dentil', 'stone', den().transform(sh(-side * t)), instances(xf)));
      }
    }
  }
  if (hp.pos.modillion) {
    const md = hp.dims.mod, zp = ft.modBand.h0, hgt = (ft.corona.h0 - zp) * Math.cos(th), ext = md.w / 2 + hgt * Math.sin(th);
    // reuse the horizontal cornice's modillion (same profile, same dims) rather than carving it twice
    const hm = parts.find((q) => q.name === 'modillion'), hl = parts.find((q) => q.name === 'modillion-leaf');
    let cache = hm ? { solid: hm.manifold, leaf: hl ? hl.manifold : null } : null;
    const mk = () => (cache ||= modillionSolids(md, md.plain ? 'low' : detail));
    const leafToo = detail !== 'low' && !md.plain && !!mk().leaf;
    if (radial) {
      const xf = arcRow(pp.Rb + zp, md.p, md.w / 2, zp).map((a) => atR(a, md.qm, zp, mat.I()));
      addTo(parts, 'modillion', () => mk().solid, xf);
      if (leafToo) addTo(parts, 'modillion-leaf', () => mk().leaf, xf);
    } else {
      // square to the slope (Roman practice), standing in the plumb band: the height scaled by cos(pitch)
      const xf = hp.pos.modillion.front.filter((x) => Math.abs(x) > 1e-6).filter((x) => lim(Math.abs(x), ext, zOff(Math.abs(x) + md.w / 2) + zp))
        .map((x) => at(x, md.qm, zp, mat.Ry(x > 0 ? th : -th)));
      if (xf.length) {
        const c = Math.cos(th);
        parts.push(part('modillion', 'stone', mk().solid.scale([1, 1, c]), instances(xf)));
        if (leafToo) parts.push(part('modillion-leaf', 'stone', mk().leaf.scale([1, 1, c]), instances(xf)));
      }
    }
  }
  if (hp.dims.egg) {
    const e = hp.dims.egg, o = ft.ovolo, q = e.q, zp = o.h0 + (o.h1 - o.h0) / 2;
    const tilt = mat.I();                               // the egg mesh is pre-tilted (eggDartSolids)
    let ex = [], dx = [];
    if (radial) {
      const r = pp.Rb + zp, as = arcRow(r, e.p, e.size.w / 2, zp);
      ex = as.slice(1).map((a, i) => [as[i], a]).filter(([a0, a1]) => a1 - a0 < 1.5 * e.p / r).map(([a0, a1]) => atR((a0 + a1) / 2, q, zp, tilt));
      dx = as.map((a) => atR(a, q - 0.1 * e.size.d, zp, tilt));
    } else {
      const xl = xo - (pp.zc0 - zp + hh - pp.hd) / t - e.size.h * 0.5, n = Math.max(1, Math.round((xl - gap / 2) / Math.cos(th) / e.p)), px = (xl - gap / 2) / n;
      for (const s of [1, -1]) for (let k = 0; k < n; k++) {
        const r = mat.Ry(s > 0 ? th : -th);
        ex.push(at(s * (gap / 2 + (k + 0.5) * px), q, zp, mat.mul(r, tilt)));
        if (k > 0 || gap > 0) dx.push(at(s * (gap / 2 + k * px), q - 0.1 * e.size.d, zp, mat.mul(r, tilt)));
      }
      if (!gap) dx.push(at(0, q - 0.1 * e.size.d, zp, tilt));
    }
    const ed = () => eggDartSolids(e.size, detail === 'low' ? 8 : detail === 'medium' ? 12 : 16, EGG_TILT);
    let cache = null;
    addTo(parts, 'ovolo-egg', () => (cache ||= ed()).egg, ex);
    addTo(parts, 'ovolo-dart', () => (cache ||= ed()).dart, dx);
  }
  if (pp.urn) {
    const u = pp.urn;
    parts.push(...placeParts([part('pedestal', 'stone', socle(u.aP, u.hP + 2 * EPS, Math.max(6, pp.n)))], mat.T(0, u.y, u.zf - EPS)));
    const urn = urnParts(u.Hu, { knob: 'flame', detail }).map((q) => ({ ...q, name: `urn-${q.name}` }));
    parts.push(...placeParts(urn, mat.T(0, u.y, u.zf + u.hP)));
  }
  return parts;
}

function pedSpecPlan(spec) {
  const order = orderKey(spec.order), O = ORDERS[order];
  const W = spec.width || 5, ck = corniceKindFor(spec, order);
  // a pediment alone is proportioned as the pediment of a tetrastyle portico of its order and width (eustyle axes)
  let D = spec.diameter || W / (3 * O.axis + O.shaftTop);
  let pitch = spec.pitch ?? defaultPitch(order);
  const base = { order, D, W, B: spec.depth, kind: spec.pediment, pitch, ck, enrich: enrichSet(spec, order), detail: spec.detail || 'high' };
  if (spec.height) {
    // the asked height (soffit of the horizontal cornice to the apex or urn) is met by the pitch, the cornice keeping
    // its module: the height grows monotonically with the pitch, so bisect within 5-60 deg
    const zAt = (pt) => pedimentPlan({ ...base, pitch: pt }).size.z;
    let lo = 5, hi = 60;
    if (zAt(lo) >= spec.height) pitch = lo;
    else if (zAt(hi) <= spec.height) pitch = hi;
    else { for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2; if (zAt(mid) < spec.height) lo = mid; else hi = mid; } pitch = (lo + hi) / 2; }
  }
  return pedimentPlan({ ...base, pitch });
}

// ------------------------------------------------------------------------------------------------ window and door surrounds

// Style -> head and treatment (controller ruling 22). archType, when given, sets the head's curve; the style sets the
// treatment. Gothic: pointed head, chamfered reveals, hood mould with label stops. Romanesque / Byzantine: round head,
// plain archivolt in two orders with a roll, impost blocks. Renaissance: round head, the architrave turned as an
// archivolt. Moorish: horseshoe head, plain archivolt framed by an alfiz. Art Nouveau: basket head, soft frame.
// Baroque: flat head with ears and keystone, pulvinated frieze, broken pediment (a broken segmental one over a door)
// with an urn. Egyptian / Art Deco / Modern: flat head, plain frame, gorge / stepped / slab cornice, no pediment.
const STYLE_SURROUND = {
  gothic: { arch: 'pointed', tr: 'gothic' }, romanesque: { arch: 'semicircular', tr: 'romanesque' },
  byzantine: { arch: 'semicircular', tr: 'romanesque' }, renaissance: { arch: 'semicircular', tr: 'classical' },
  moorish: { arch: 'horseshoe', tr: 'moorish' }, 'art-nouveau': { arch: 'basket', tr: 'nouveau' },
  baroque: { arch: null, tr: 'baroque' }, egyptian: { arch: null, tr: 'egyptian' }, 'art-deco': { arch: null, tr: 'deco' },
  modern: { arch: null, tr: 'modern' },
};
const ARCH_TREATMENT = { pointed: 'gothic', tudor: 'gothic', horseshoe: 'moorish' };   // an arch without a style
const D2R = Math.PI / 180;

/** Head, treatment, pediment, keystone, ears... of a window or door spec. "Asked for" = stated in the request
 *  (spec.given): an arched or Egyptian / Deco / Modern head takes a pediment only when one was asked for. */
function surroundKind(spec) {
  const door = spec.element === 'door', st = STYLE_SURROUND[spec.style] || null;
  const arch = spec.archType || (st && st.arch) || null;
  let tr = st ? st.tr : arch ? ARCH_TREATMENT[arch] || 'classical' : 'classical';
  if (arch && ['baroque', 'egyptian', 'deco', 'modern'].includes(tr)) tr = tr === 'baroque' ? 'classical' : 'plain';
  const asked = stated(spec, 'pediment') && !!spec.pediment;
  let ped;
  if (arch || ['egyptian', 'deco', 'modern'].includes(tr)) ped = asked ? spec.pediment : 'none';
  else if (tr === 'baroque') ped = asked ? spec.pediment : door ? 'broken-segmental' : 'broken';
  else ped = spec.pediment ?? (door ? 'segmental' : 'triangular');   // classical: the spec's value (spec.js default)
  const flatOrder = { egyptian: 'egyptian', deco: 'art-deco', modern: 'modern' }[tr];
  const order = flatOrder || (spec.order ? orderKey(spec.order) : 'ionic');
  const classicalBottom = tr === 'classical' || tr === 'baroque';
  const round = arch && arch !== 'pointed' && arch !== 'tudor';
  return { door, arch, tr, ped, order, ears: !arch && classicalBottom, fasciae: classicalBottom,
    keystone: tr === 'baroque' && !stated(spec, 'keystone') ? true : !!spec.keystone && (!arch || round) && tr !== 'gothic',
    frieze: spec.frieze === 'pulvinated' || (tr === 'baroque' && !stated(spec, 'frieze')) ? 'pulvinated' : 'plain',
    ck: flatOrder || spec.cornice ? corniceKindFor(spec.cornice ? spec : { ...spec, cornice: undefined }, order) : 'plain',
    consoles: !door && classicalBottom, plinths: door && classicalBottom };
}

/** Frames along an elevation polyline (x, z) with the outward side on the left of travel, mitred at every vertex:
 *  the profile's first coordinate goes to -Y (projection), the second along the mitre (outward in the wall plane). */
function elevFrames(path) {
  const nrm = path.slice(1).map((p, i) => { const dx = p[0] - path[i][0], dz = p[1] - path[i][1], l = Math.hypot(dx, dz); return [-dz / l, dx / l]; });
  return path.map((p, k) => {
    let o;
    if (k === 0) o = nrm[0]; else if (k === path.length - 1) o = nrm[nrm.length - 1];
    else { const u = nrm[k - 1], v = nrm[k], s = 1 + u[0] * v[0] + u[1] * v[1]; o = [(u[0] + v[0]) / s, (u[1] + v[1]) / s]; }
    return { o: [p[0], 0, p[1]], A: [0, -1, 0], B: [o[0], 0, o[1]] };
  });
}

/** Drop vertices whose inward (left-turn) mitres would fold a band of width W offset outward from the path; the ends
 *  and the points in `keep` (springings, label corners) are never dropped. */
function cleanFolds(path, W, keep = []) {
  const pts = path.slice(), kept = new Set(keep);
  for (let iter = 0; iter < 400; iter++) {
    const turn = (k) => {
      if (k <= 0 || k >= pts.length - 1) return 0;
      const a = [pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]], b = [pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]];
      return Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
    };
    const shrink = (k) => { const th = turn(k); return th > 0 ? W * Math.tan(th / 2) : 0; };
    let drop = -1;
    for (let i = 0; i < pts.length - 1 && drop < 0; i++) {
      const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      if (len < 1.05 * (shrink(i) + shrink(i + 1)) + 1e-9) {
        const cand = [i, i + 1].filter((k) => k > 0 && k < pts.length - 1 && !kept.has(pts[k]));
        if (cand.length) drop = cand.reduce((x, y) => (Math.abs(turn(x)) <= Math.abs(turn(y)) ? x : y));
      }
    }
    if (drop < 0) break;
    pts.splice(drop, 1);
  }
  return pts;
}

/** In-plane extent (max |x|, max z) of a band swept along frames over the profile's outward range [r0, r1]. */
function bandExtent(frames, r0, r1) {
  let x = 0, z = -Infinity;
  for (const f of frames) for (const r of [r0, r1]) { x = Math.max(x, Math.abs(f.o[0] + r * f.B[0])); z = Math.max(z, f.o[2] + r * f.B[2]); }
  return { x, z };
}

/** Right half of an arch's intrados (u, v), springing (u = span/2, v = 0) to crown (u = 0), v scaled by kv. */
function intradosHalf(g, step, kv) {
  const arcs = g.springer ? [{ ...g.arcs[0], a0: g.springer.a0 }] : g.arcs, pts = [];
  arcs.forEach((a, k) => {
    const last = k === arcs.length - 1;
    const a1 = last && g.apex === 'point' ? Math.acos(Math.max(-1, Math.min(1, -a.cu / a.r))) / D2R : a.a1;
    const n = Math.max(2, Math.ceil((a1 - a.a0) / step));
    for (let i = k ? 1 : 0; i <= n; i++) {
      const d = (a.a0 + ((a1 - a.a0) * i) / n) * D2R;
      pts.push([i === n && last ? Math.max(0, a.cu + a.r * Math.cos(d)) : a.cu + a.r * Math.cos(d), (a.cv + a.r * Math.sin(d)) * kv]);
    }
  });
  pts[pts.length - 1][0] = 0;
  return pts;
}

// Band profiles drawn outward from the opening edge (h = distance out in the wall plane, p = projection), in a = w/6
const BANDS = {
  classical: (a) => ({ p0: 0.16 * a, m: [['fillet', 0.335, 0.16], ['torus', 0.035, 0.16], ['fillet', 0.24, 0.2], ['torus', 0.03, 0.2],
    ['fillet', 0.22, 0.24], ['cymaReversa', 0.09, 0.32], ['fillet', 0.05, 0.34]] }),
  gothic: (a) => ({ p0: -0.18 * a, m: [['slope', 0.3, 0.12], ['fillet', 0.4, 0.12], ['torus', 0.06, 0.12], ['fillet', 0.04, 0.12]] }),
  romanesque: (a) => ({ p0: 0.1 * a, m: [['fillet', 0.42, 0.1], ['torus', 0.08, 0.1], ['fillet', 0.5, 0.24]] }),
  moorish: (a) => ({ p0: 0.06 * a, m: [['fillet', 0.08, 0.06], ['fillet', 0.62, 0.14], ['torus', 0.06, 0.14], ['fillet', 0.04, 0.14]] }),
  nouveau: (a) => ({ p0: 0.04 * a, m: [['fillet', 0.25, 0.04], ['cavetto', 0.35, 0.2], ['torus', 0.14, 0.2], ['fillet', 0.06, 0.12]] }),
  plain: (a) => ({ p0: 0.14 * a, m: [['fillet', 0.9, 0.14], ['fillet', 0.1, 0.2]] }),
};
function bandProfile(kind, a, n) {
  const b = BANDS[kind](a);
  return drawMembers(b.m.map(([t, h, p]) => ({ t, h: h * a, p: p * a, k: 1 })), n, 0, b.p0);
}

/**
 * Surround of an opening w x h (open: no wall panel), after Vignola's and Gibbs's door and window plates: architrave
 * a = w/6 (three fasciae, cyma crown); flat heads with ears (crossettes) projecting a/3 and dropping a/2, frieze 0.9 a,
 * cornice 1.1 a with returns, pediment (Serlio's 22.5 deg, segmental, broken with an urn); arched heads (archType or
 * style: see STYLE_SURROUND) whose band follows the arch (arch geometry from arch.js), the opening's height being its
 * clear height to the crown (an arch too tall for it is flattened to 0.85 h); keystone; window sill on scrolled consoles
 * (classical) or a plain projecting sill; door plinth blocks (classical). The surround stands proud of the wall plane
 * y = 0 and is t = 0.3 a deep behind it. All extents come from the same frames the build sweeps (expected is exact).
 */
export function surroundPlan(spec) {
  const K0 = surroundKind(spec), { door, arch, tr } = K0;
  const w = spec.width || (door ? 1.6 : 1.2), h = spec.height || (door ? 3 : 2.1), s = w / 2;
  const a = w / 6, t = 0.3 * a, e = K0.ears ? 0.32 * a : 0, ed = 0.5 * a, r1 = 0.285 * a;
  const detail = spec.detail || 'high', n = curveN(detail), O = ORDERS[K0.order];
  const fz = 0.9 * a, cz = 1.1 * a, D = cz / O.ent.cornice, d1 = 0.16 * a, df = 0.24 * a;
  const cons = K0.consoles ? 1.3 * a : 0, hs = door ? 0 : K0.consoles ? 0.42 * a : 0.36 * a;
  const plinth = K0.plinths ? Math.min(0.17 * h, 1.5 * a) : 0;
  const zo = door ? 0 : cons + hs, zb = door ? plinth : zo, zt = zo + h;
  const ext = [];                                       // [max |x|, max z] of every piece
  const pl = { ...K0, w, h, s, a, t, e, ed, r1, D, fz, cz, d1, df, cons, hs, plinth, zo, zb, zt, detail, n, ext };
  // the band and the opening outline
  if (arch) {
    const g = archGeom(arch, w), kv = Math.min(1, (0.85 * h) / g.rise), rise = g.rise * kv, zs = zt - rise;
    const step = detail === 'low' ? 8 : detail === 'medium' ? 5 : 3;
    const half = intradosHalf(g, step, kv);                                 // right half: springing -> crown
    // left springing -> crown -> right springing
    const archPts = [...half.map(([u, v]) => [-u, zs + v]), ...half.slice(0, -1).reverse().map(([u, v]) => [u, zs + v])];
    const bandKind = tr === 'classical' ? 'classical' : tr;
    let band = bandProfile(bandKind, a, n), W = band.top;
    // a jamb too short for the band's inward mitre at the springing (a very low, wide opening): narrow the band
    const d0 = [archPts[1][0] - archPts[0][0], archPts[1][1] - archPts[0][1]], th = Math.atan2(-d0[0], d0[1]);
    const Lj = zs - zb, Wmax = th > 1e-6 ? (0.9 * Lj) / Math.tan(th / 2) : Infinity;
    if (W > Wmax) { const k = Wmax / W; band = { ...band, pts: band.pts.map(([q, r]) => [q, r * k]), top: band.top * k }; W = band.top; }
    const path = cleanFolds([[-s, zb], ...archPts, [s, zb]], W, [archPts[0], archPts[archPts.length - 1]]);
    const frames = elevFrames(path);
    const bx = bandExtent(frames, 0, W);
    ext.push([bx.x, bx.z]);
    Object.assign(pl, { g, kv, rise, zs, band, W, path, frames, crownZ: zt, bandTop: bx.z, bandX: bx.x,
      bandName: tr === 'gothic' || tr === 'nouveau' ? 'frame' : 'archivolt' });
    // arch-only frames (left springing .. right springing) for offset mouldings
    const iL = path.findIndex((p) => Math.abs(p[1] - zs) < 1e-9 && p[0] < 0), iR = path.length - 2;
    const archFrames = frames.slice(Math.max(1, iL), iR + 1);
    if (tr === 'gothic') {
      // hood mould: seated on the frame's outer edge (no wall carries it here), returned level at the springing as
      // labels with stops
      const Oh = W - 0.002, Lr = 0.45 * a, hood = drawMembers([{ t: 'cavetto', h: 0.07 * a, p: 0.11 * a }, { t: 'fillet', h: 0.02 * a, p: 0.11 * a },
        { t: 'torus', h: 0.05 * a, p: 0.11 * a, k: 1 }, { t: 'slope', h: 0.1 * a, p: 0.02 * a }], n, 0, 0);
      const q = archFrames.map((f) => [f.o[0] + Oh * f.B[0], f.o[2] + Oh * f.B[2]]);
      q[0] = [-s - Oh, zs]; q[q.length - 1] = [s + Oh, zs];
      const hp = cleanFolds([[-s - Oh - Lr, zs], ...q, [s + Oh + Lr, zs]], hood.top, [q[0], q[q.length - 1]]);
      const hf = elevFrames(hp), hx = bandExtent(hf, 0, hood.top);
      const stop = { w: 0.24 * a, h: 0.3 * a, d: 0.15 * a, x: s + Oh + Lr - 0.12 * a };
      ext.push([hx.x, hx.z], [stop.x + stop.w / 2, zs]);
      Object.assign(pl, { hood, hoodFrames: hf, stop });
    }
    if (tr === 'romanesque') {
      const im = { x0: s - 0.06 * a, x1: s + W + 0.12 * a, h: 0.28 * a, d: 0.34 * a };
      ext.push([im.x1, zs]);
      pl.impost = im;
    }
    if (K0.keystone && arch !== 'pointed' && arch !== 'tudor') {
      const ks = { kb: 0.45 * a, kt: 0.62 * a, dk: 0.42 * a, z0: zt - 0.03 * a, z1: zt + W + 0.3 * a };
      ext.push([ks.kt / 2, ks.z1]);
      pl.ks = ks;
    }
    // the spandrel field: inside an alfiz (Moorish) or under the frieze of an aedicule when a pediment is asked for
    const outer = archFrames.slice(1, -1).map((f) => [f.o[0] + (W - EPS) * f.B[0], f.o[2] + (W - EPS) * f.B[2]]);
    if (K0.ped !== 'none') {
      const Xs = Math.max(s + W, bx.x) + 0.1 * a, zf = bx.z + 0.1 * a;
      Object.assign(pl, { spandrel: { X: Xs, z0: zs, z1: zf + EPS, outer }, Lf: 2 * Xs, zf, zc: zf + fz });
    } else if (tr === 'moorish') {
      const Xa = bx.x + 0.12 * a, Za = bx.z + 0.12 * a, aw = 0.28 * a;
      const af = elevFrames([[-Xa, zs], [-Xa, Za], [Xa, Za], [Xa, zs]]), ax = bandExtent(af, 0, aw);
      ext.push([ax.x, ax.z]);
      Object.assign(pl, { alfiz: { frames: af, w: aw }, spandrel: { X: Xa + EPS, z0: zs, z1: Za + EPS, outer } });
    }
  } else {
    const X = s + r1;
    pl.path = e ? [[-X, zb], [-X, zt - ed], [-X - e, zt - ed], [-X - e, zt + r1], [X + e, zt + r1], [X + e, zt - ed], [X, zt - ed], [X, zb]]
      : [[-X, zb], [-X, zt + r1], [X, zt + r1], [X, zb]];
    pl.Lf = w + 2 * a + 2 * e;
    pl.zf = zt + a; pl.zc = pl.zf + fz;
    if (!K0.fasciae) {                                 // a plain frame swept from the opening edge
      pl.band = bandProfile('plain', a, n); pl.W = pl.band.top;
      pl.path = [[-s, zb], [-s, zt], [s, zt], [s, zb]];
      pl.zf = zt + pl.W;  pl.zc = pl.zf + fz;
    }
    pl.frames = elevFrames(pl.path);
    ext.push([s + a + e, zt + a]);
    if (K0.keystone) { pl.ks = { kb: 0.55 * a, kt: 0.75 * a, dk: 0.42 * a, z0: zt - 0.04 * a, z1: pl.zc, cap: true }; ext.push([0.75 * a / 2 + 0.05 * a, pl.zc]); }
  }
  // frieze, cornice / pediment (flat heads always; arched heads as an aedicule when a pediment is asked for)
  if (pl.Lf) {
    const enrich = enrichSet(spec, K0.order, false);
    pl.enrich = enrich;
    if (K0.ped !== 'none') {
      pl.pp = pedimentPlan({ order: K0.order, D, W: pl.Lf, B: t, kind: K0.ped, pitch: spec.pitch ?? defaultPitch(K0.order), ck: K0.ck, enrich, detail, dq: df, z0: pl.zc, seat: true });
      ext.push([pl.pp.size.x / 2, pl.zc + pl.pp.size.z]);
    } else {
      pl.cp = entablaturePlan({ order: K0.order, D, L: pl.Lf, B: t, returns: true, fk: 'plain', ck: K0.ck, enrich, detail, parts: 'cornice', z0: pl.zc });
      ext.push([pl.Lf / 2 + pl.cp.P + df, pl.zc + pl.cp.size.z]);
    }
    ext.push([pl.Lf / 2 + df, pl.zf]);
  }
  // sill / plinths
  const W = pl.W || a;
  if (!door) {
    pl.sillL = w + 2 * W + 0.7 * a; pl.qs = K0.consoles ? 0.5 * a : 0.32 * a;
    ext.push([pl.sillL / 2 + pl.qs, zo]);
  }
  if (K0.plinths) { pl.pw = a + 0.12 * a; pl.xc = s - 0.04 * a + pl.pw / 2; ext.push([pl.xc + pl.pw / 2 + 0.02 * a, plinth]); }
  pl.size = { x: 2 * Math.max(...ext.map((q) => q[0])), z: Math.max(...ext.map((q) => q[1])) };
  return pl;
}

const SECTION_XZ = Float64Array.from([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
/** An elevation polygon (x, z) extruded from y = y1 (back) to y = y0 (front, y0 < y1). */
function slab(poly, y0, y1) { const { Manifold } = K(); return Manifold.extrude(crossSection(poly), y1 - y0).transform(SECTION_XZ).translate([0, y1, 0]); }

function buildSurround(spec) {
  const sp = surroundPlan(spec), { w, s, a, t, e, r1, zb, zt, d1, df, detail, n } = sp;
  const parts = [];
  if (sp.arch || !sp.fasciae) {
    // the band follows the opening outline (jambs and arch, or a plain flat frame)
    const bp = sp.band.pts;                             // starts exactly at the opening edge: the opening keeps its width
    const band = sweep([[-t, 0], ...bp, [-t, sp.band.top]], sp.frames);
    parts.push(part(sp.arch ? sp.bandName : 'architrave', 'stone', band));
  } else {
    // eared architrave: three fasciae beyond the inner fascia, the inner fascia a flat taking the ears' lobes
    const bandM = drawMembers([
      { t: 'torus', h: 0.035 * a, p: d1, k: 1 }, { t: 'fillet', h: 0.26 * a, p: 0.2 * a }, { t: 'torus', h: 0.03 * a, p: 0.2 * a, k: 1 },
      { t: 'fillet', h: 0.25 * a, p: 0.24 * a }, { t: 'cymaReversa', h: 0.09 * a, p: 0.32 * a }, { t: 'fillet', h: 0.05 * a, p: 0.34 * a }], n, 0, d1);
    const arch = sweep([[-t, -EPS], [d1, -EPS], ...bandM.pts, [-t, bandM.top]], sp.frames);
    const p = sp.path, inner = [[-w / 2, zb], ...p, [w / 2, zb], [w / 2, zt], [-w / 2, zt]];
    parts.push(part('architrave', 'stone', union([arch, slab(inner, -d1, t)])));
  }
  if (sp.hood) {
    const hp = sp.hood.pts;
    parts.push(part('hood-mould', 'stone', sweep([[-0.05 * a, 0], ...hp, [-0.05 * a, sp.hood.top]], sp.hoodFrames)));
    const st = sp.stop, blk = slab([[-st.w / 2, sp.zs - st.h], [st.w / 2, sp.zs - st.h], [st.w / 2, sp.zs + EPS], [-st.w / 2, sp.zs + EPS]], -st.d, t)
      .subtract(slab([[-st.w, sp.zs - st.h - 0.01], [st.w, sp.zs - st.h - 0.01], [st.w, sp.zs - st.h + 0.45 * st.h]], -st.d - 0.01, -st.d + 0.6 * st.d));
    parts.push(part('label-stop', 'stone', blk, instances([mat.T(-st.x, 0, 0), mat.T(st.x, 0, 0)])));
  }
  if (sp.impost) {
    const im = sp.impost, L = im.x1 - im.x0, zs = sp.zs;
    const blk = extrudeProfileX([[t, zs - im.h], [-0.6 * im.d, zs - im.h], [-im.d, zs - 0.45 * im.h], [-im.d, zs + EPS], [t, zs + EPS]], L);
    const xc = (im.x0 + im.x1) / 2;
    parts.push(part('impost', 'stone', blk, instances([mat.T(-xc, 0, 0), mat.T(xc, 0, 0)])));
  }
  if (sp.alfiz) {
    const al = drawMembers([{ t: 'fillet', h: sp.alfiz.w, p: 0.12 * a }], n, 0, 0.12 * a);
    parts.push(part('alfiz', 'stone', sweep([[-t, -EPS], [0.12 * a, -EPS], ...al.pts, [-t, al.top]], sp.alfiz.frames)));
  }
  if (sp.spandrel) {
    const sd = sp.spandrel, X = sd.X;
    const poly = [[-X, sd.z0], [-X, sd.z1], [X, sd.z1], [X, sd.z0], [s + sp.W - EPS, sd.z0], ...sd.outer.slice().reverse(), [-s - sp.W + EPS, sd.z0]];
    parts.push(part('spandrel', 'stone', slab(poly, -0.05 * a, t)));
  }
  if (sp.Lf) {
    // frieze (plain or pulvinated), returned; then the cornice or the pediment
    const fm = sp.frieze === 'pulvinated' ? [{ t: 'fillet', h: EPS, p: df * 0.6 }, { t: 'pulvino', h: sp.fz - EPS, s: 0.4 * df }] : [{ t: 'fillet', h: sp.fz, p: df }];
    const fr = drawMembers(fm, n, sp.zf - EPS);
    parts.push(part('frieze', 'stone', runSolid([[0, sp.zf - EPS], ...fr.pts], sp.Lf, t, true)));
    if (sp.pp) parts.push(...pedimentParts(sp.pp));
    else {
      const cp = sp.cp, pts = [[0, sp.zc - EPS], ...shiftPts(cp.segs.cornice.pts, df)];
      let cs = runSolid(pts, sp.Lf, t, true);
      const tg = shiftTags(cp.tags, df);
      const ro = runParts(runPlan({ tags: tg, L: sp.Lf, B: t, returns: true, D: sp.D, order: sp.order, axes: null, enrich: sp.enrich, detail, ck: sp.ck, fk: null }),
        { tags: tg, L: sp.Lf, B: t, returns: true, D: sp.D, detail });
      if (ro.cuts.length) cs = cs.subtract(union(ro.cuts));
      parts.push(part('cornice', 'stone', cs), ...ro.parts);
    }
  }
  if (sp.ks) {
    // keystone: through the head (and the frieze of a flat head), tapering upward, proud of the band
    const k = sp.ks, ksM = slab([[-k.kb / 2, k.z0], [k.kb / 2, k.z0], [k.kt / 2, k.z1], [-k.kt / 2, k.z1]], -k.dk, t);
    const cap = k.cap ? box(-k.kt / 2 - 0.05 * a, -k.dk - 0.04 * a, k.z1 - 0.12 * a, k.kt / 2 + 0.05 * a, t, k.z1) : null;
    parts.push(part('keystone', 'stone', cap ? union([ksM, cap]) : ksM));
  }
  if (!sp.door) {
    // sill: a moulded slab returned at both ends; classical: on two scrolled consoles under the jambs
    const hs = sp.hs, z0 = sp.cons, qs = sp.qs;
    const sm = sp.consoles
      ? drawMembers([{ t: 'corona', h: 0.45 * hs, p: qs - 0.07 * a, drip: 0.035 * a }, { t: 'cymaReversa', h: 0.3 * hs, p: qs }, { t: 'fillet', h: 0.25 * hs + EPS, p: qs }], n, z0)
      : drawMembers([{ t: 'corona', h: 0.6 * hs, p: qs, drip: 0.03 * a }, { t: 'slope', h: 0.4 * hs + EPS, p: qs - 0.08 * a }], n, z0);
    parts.push(part('sill', 'stone', runSolid(sm.pts, sp.sillL, t, true)));
    if (sp.consoles) {
      const ch = qs - 0.09 * a, cl = sp.cons + EPS, cw = 0.5 * a;
      const { solid, leaf } = modillionSolids({ w: cw, l: cl, h: ch, cap: 0, capP: 0 }, detail);
      // the modillion stood on end: its back (u = 0) under the sill, its flat top against the wall, scrolls facing out
      const M = mat.mul(mat.T(0, -ch, cl), mat.Rz(Math.PI), mat.Rx(Math.PI / 2));   // a rotation (no mirrored solids); foot at z = 0
      const xs = [-(w / 2 + a / 2), w / 2 + a / 2].map((x) => mat.T(x, 0, 0));
      parts.push(part('console', 'stone', solid.transform(M), instances(xs)));
      if (leaf) parts.push(part('console-leaf', 'stone', leaf.transform(M), instances(xs)));
    }
  }
  if (sp.plinths) {
    // plinth blocks under the jambs, a little wider and prouder than the architrave
    const pw = sp.pw, pd = 0.4 * a, xc = sp.xc;
    const pb = union([box(-pw / 2, -pd, 0, pw / 2, t, sp.plinth + EPS), box(-pw / 2 - 0.02 * a, -pd - 0.02 * a, 0, pw / 2 + 0.02 * a, t, 0.08 * sp.plinth)]);
    parts.push(part('plinth', 'stone', pb, instances([mat.T(-xc, 0, 0), mat.T(xc, 0, 0)])));
  }
  void e; void r1;
  return parts;
}

/** The frieze, cornice and enrichment a portico of this spec uses (shared with portico.js). */
export function porticoKinds(spec, order) {
  return { fk: friezeKindFor(spec, order), ck: corniceKindFor(spec, order), enrich: enrichSet(spec, order), detail: spec.detail || 'high' };
}

// ------------------------------------------------------------------------------------------------ family entry points

/** Part role from the material: wood -> wood, metals -> metal, every masonry / plaster material -> stone. */
export function roleFor(material) {
  return material === 'wood' ? 'wood' : ['copper', 'lead', 'zinc', 'bronze', 'gold'].includes(material) ? 'metal' : 'stone';
}

/** Carved and repeated ornament (dentils, modillions and their leaves, mutules, regulae, triglyphs, eggs, darts, beads,
 *  reels, leaves, rosettes, consoles, keystones, label stops, acroteria urns) follows a deformation rigidly; the runs
 *  (architrave, frieze, cornice, raking cornice, tympanum, mouldings, hood moulds, sills, plinths, pedestals, spandrels,
 *  imposts) bend with the shape. A tag a part already carries is kept. */
const RIGID = /^(bead|console|console-leaf|dentil|keystone|label-stop|leaf|lesbian-dart|lesbian-leaf|modillion|modillion-leaf|mutule|ovolo-dart|ovolo-egg|egg|dart|reel|regula|rosette|triglyph|urn-.*)$/;
export const tagRigid = (parts) => parts.map((p) => (typeof p.meta?.rigid === 'boolean' ? p : { ...p, meta: { ...p.meta, rigid: RIGID.test(p.name) } }));

export function build(spec) {
  let parts;
  switch (spec.element) {
    case 'moulding': parts = buildMoulding(spec); break;
    case 'pediment':
      parts = spec.pediment === 'none' ? entablatureParts(entSpecPlan({ ...spec, element: 'cornice', length: spec.width || 5 })) : pedimentParts(pedSpecPlan(spec));
      break;
    case 'window': case 'door': parts = buildSurround(spec); break;
    default: parts = entablatureParts(entSpecPlan(spec));
  }
  const role = roleFor(spec.material);
  parts = tagRigid(parts);
  return role === 'stone' ? parts : parts.map((p) => ({ ...p, role }));
}

/**
 * What the generator promises (for the tests); counts exact for the given spec.
 * - entablature / cornice: x = length (returns false) or length + 2 P with returns, P = the cornice projection
 *   (= its height c for plain, dentil and modillion cornices, 4/3 c for the Doric mutule cornice, 0.75 c Egyptian gorge,
 *   0.6 c Art Deco, 1.6 c modern slab); z = architrave + frieze + cornice (entablatureDims) or the cornice alone.
 *   counts: dentil, modillion, triglyph, mutule (front + both returns).
 * - moulding: x = length (+ 2 x its projection with returns), z = height.
 * - pediment: x = width + 2 Ph (Ph = projection of the horizontal cornice without its sima); z = soffit of the
 *   horizontal cornice to the apex = hh - drip - zc + (width/2 + Ph - gap/2) tan(pitch) + c (hh: horizontal cornice
 *   height, zc: corona soffit in the cornice, gap: broken pediments 0.3 width).
 * - window / door: x = the widest of the cornice / pediment (frieze length + 2 (frieze proj. + cornice proj.)) and the
 *   sill; z = foot (console foot for a window, threshold for a door) to the apex (or cornice top).
 */
export function expected(spec) {
  const out = { size: {}, counts: {}, tol: 0.005 };
  if (spec.element === 'moulding') { const mp = mouldingPlan(spec); out.size = { ...mp.size }; if (mp.pl.counts.dentil) out.counts.dentil = mp.pl.counts.dentil; }
  else if (spec.element === 'pediment') {
    out.size = spec.pediment === 'none' ? { ...entSpecPlan({ ...spec, element: 'cornice', length: spec.width || 5 }).size } : { ...pedSpecPlan(spec).size };
  } else if (spec.element === 'window' || spec.element === 'door') out.size = { ...surroundPlan(spec).size };
  else {
    const p = entSpecPlan(spec);
    out.size = { ...p.size };
    for (const k of ['dentil', 'modillion', 'triglyph', 'mutule']) if (p.pl.counts[k]) out.counts[k] = p.pl.counts[k];
  }
  return out;
}
