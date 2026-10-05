// Arches and arcades: semicircular, segmental, pointed, horseshoe, basket (three-centred) and Tudor (four-centred)
// intrados; wedge voussoirs (one instanced part per voussoir shape), keystone, archivolt, imposts, piers with bases or
// columns with dosserets, the spandrel wall and a crowning cornice; an arcade repeats the bay `bays` times.
// Z-up, metres, origin at the base centre, front -Y, the arcade runs along X.
//
// Proportions (stated where used): Vignola, Regola delli cinque ordini (1562), after W. R. Ware, The American Vignola
// (1903) - "arches": the opening is twice as high as it is wide; the pier is 1/3 to 1/2 of the opening; archivolt and
// impost are one module wide / high; the opening of an arch order is 6 1/2 M (Tuscan), 7 M (Doric), 8 1/2 M (Ionic),
// 9 M (Corinthian, Composite) wide with a 3 M pier. Medieval and Islamic arches follow the usual workshop
// constructions (equilateral pointed arch, Cordoban horseshoe, three- and four-centred arches), documented in archGeom().

import { ORDERS, entablatureDims } from '../orders.js';
import { K, mat, revolve, box, union, part, instances, loft, crossSection, extrudeXY, memo } from '../kernel.js';
import { Prof } from '../profiles.js';
import { extrudeElevation, rosette, acanthusLeaf } from '../ornament.js';
import { normalize } from '../spec.js';

/** Did the request state field f? (spec.given after normalize(); a raw spec: any value it carries) */
const stated = (spec, f) => (spec.given ? spec.given.includes(f) : spec[f] !== undefined && spec[f] !== null);
import { build as buildColumn } from './column.js';

export const ELEMENTS = ['arch', 'arcade'];

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const oddRound = (x, min = 3) => { let n = Math.max(min, Math.round(x)); if (n % 2 === 0) n += (x > n ? 1 : -1); return Math.max(min, n); };
const sstep = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

const TRI_BUDGET = 1.9e6;          // triangles per element after instancing (the convention says < 2 M)

// Vignola's arch orders: width of the opening in modules (M = D/2) for an arcade with a 3 M pier.
const OPEN_M = { tuscan: 6.5, doric: 7, ionic: 8.5, corinthian: 9, composite: 9, solomonic: 9, 'greek-doric': 7 };

// ------------------------------------------------------------------------------------------------ interpretation

/** Arch type, order and the architectural treatment that fits them (classical | gothic | romanesque | moorish | plain). */
function character(spec) {
  let type = spec.archType || 'semicircular';
  let order = spec.order || 'tuscan';
  const style = spec.style;
  // a style only overrides a field the request did not state (spec.given; a default value may also be a request)
  const defType = !stated(spec, 'archType'), defOrder = !stated(spec, 'order');
  if (defType && (style === 'gothic' || order === 'gothic')) type = 'pointed';
  if (defType && style === 'moorish') type = 'horseshoe';
  // a Gothic arch on the default (Tuscan) order stands on Gothic clustered piers
  if (defOrder && (style === 'gothic' || type === 'pointed' || type === 'tudor')) order = 'gothic';
  if (defOrder && (style === 'romanesque' || style === 'byzantine')) order = 'romanesque';
  if (defOrder && style === 'egyptian') order = 'egyptian';
  if (defOrder && style === 'art-deco') order = 'art-deco';
  if (defOrder && style === 'modern') order = 'modern';
  let tr = 'classical';
  if (type === 'pointed' || type === 'tudor' || order === 'gothic') tr = 'gothic';
  else if (type === 'horseshoe' || style === 'moorish') tr = 'moorish';
  else if (order === 'romanesque' || style === 'romanesque' || style === 'byzantine') tr = 'romanesque';
  else if (['modern', 'art-deco', 'egyptian'].includes(order) || style === 'modern' || style === 'art-deco') tr = 'plain';
  return { type, order, tr, brick: spec.material === 'brick' };
}

// ------------------------------------------------------------------------------------------------ intrados geometry

/**
 * The arch in its own plane: u along the arcade (0 on the arch axis), v up (0 on the springing line = top of the
 * impost). Returns the right half as a chain of circular arcs from the springing to the crown (angles in degrees,
 * measured from +u toward +v about each arc's centre), the rise, and whether the crown is round or pointed.
 *  - semicircular: one centre on the springing line, rise = span / 2.
 *  - segmental: rise = span / 4 -> radius 5/8 span with the centre 3/8 span below the springing (a 3-4-5 triangle),
 *    so the arc subtends 2 atan(4/3) = 106.26 deg; the end voussoirs rest on radial skewbacks.
 *  - pointed: equilateral Gothic arch, two arcs of radius = span centred on the opposite springing points; rise =
 *    span sqrt(3)/2.
 *  - horseshoe: Cordoban (Umayyad) horseshoe of 240 deg: the circle returns 30 deg below its centre line, i.e. half a
 *    radius; radius = span / (2 cos 30) so the opening at the foot is the span and the arch is 15.5 % wider at its
 *    widest; the lower courses below the centre line are horizontally bedded springers (tas-de-charge).
 *  - basket (anse de panier, three-centred): three arcs of 60 deg each, haunch radius 0.272 span and crown radius
 *    0.728 span (crown centre 0.394 span below the springing) - the equal-angle construction for rise = span / 3.
 *  - tudor (four-centred): haunch arcs of radius span/4 centred on the springing line at the quarter points, each
 *    turning 60 deg, then two flat arcs of radius 1.3 span meeting in a point; rise ~ 0.36 span.
 */
export function archGeom(type, S) {
  const s = S / 2;
  if (type === 'segmental') {
    const r = 1.25 * s, cv = -0.75 * s, a0 = Math.atan2(0.75, 1) * R2D;
    return { type, apex: 'round', arcs: [{ cu: 0, cv, r, a0, a1: 90 }], rise: r + cv };
  }
  if (type === 'horseshoe') {
    const beta = 30, r = s / Math.cos(beta * D2R), cv = r * Math.sin(beta * D2R);
    return { type, apex: 'round', arcs: [{ cu: 0, cv, r, a0: 0, a1: 90 }], springer: { a0: -beta, a1: 0 }, rise: cv + r };
  }
  if (type === 'pointed') {
    return { type, apex: 'point', arcs: [{ cu: -s, cv: 0, r: S, a0: 0, a1: 60 }], rise: s * Math.sqrt(3) };
  }
  if (type === 'basket') {
    const r1 = s * (Math.sqrt(3) - 4 / 3) / (Math.sqrt(3) - 1), r2 = 2 * s - r1, cv2 = (Math.sqrt(3) / 2) * (r1 - r2);
    return { type, apex: 'round', arcs: [{ cu: s - r1, cv: 0, r: r1, a0: 0, a1: 60 }, { cu: 0, cv: cv2, r: r2, a0: 60, a1: 90 }], rise: cv2 + r2 };
  }
  if (type === 'tudor') {
    const r1 = s / 2, th = 60, r2 = 2.6 * s;
    const hu = s - r1, pu = hu + r1 * Math.cos(th * D2R), pv = r1 * Math.sin(th * D2R);
    const cu = pu - r2 * Math.cos(th * D2R), cv = pv - r2 * Math.sin(th * D2R);
    const phi = Math.acos(-cu / r2) * R2D;
    return { type, apex: 'point', arcs: [{ cu: hu, cv: 0, r: r1, a0: 0, a1: th }, { cu, cv, r: r2, a0: th, a1: phi }], rise: cv + r2 * Math.sin(phi * D2R) };
  }
  return { type: 'semicircular', apex: 'round', arcs: [{ cu: 0, cv: 0, r: s, a0: 0, a1: 90 }], rise: s };
}

const onArc = (a, r, deg) => [a.cu + r * Math.cos(deg * D2R), a.cv + r * Math.sin(deg * D2R)];

/** Angle (deg) at which the circle (a.cu, a.cv, r) crosses the axis u = 0 (for pointed crowns). */
const axisAngle = (a, r) => Math.acos(clamp(-a.cu / r, -1, 1)) * R2D;

/** Right half of the extrados (u >= 0) from the springing joint to the crown, as (u, v) points. */
function extradosRight(g, W, step) {
  const pts = [];
  if (g.springer) {
    const a = g.arcs[0], R = a.r + W;
    // the horizontal bed of the springer at v = 0, then the extrados from where it crosses v = 0
    const a0 = Math.asin(clamp(-a.cv / R, -1, 1)) * R2D;
    const n = Math.max(2, Math.ceil((90 - a0) / step));
    for (let i = 0; i <= n; i++) pts.push(onArc(a, R, a0 + ((90 - a0) * i) / n));
    return pts;
  }
  g.arcs.forEach((a, k) => {
    const R = a.r + W, last = k === g.arcs.length - 1;
    const a1 = last && g.apex === 'point' ? axisAngle(a, R) : a.a1;
    const n = Math.max(2, Math.ceil((a1 - a.a0) / step));
    for (let i = k ? 1 : 0; i <= n; i++) pts.push(onArc(a, R, a.a0 + ((a1 - a.a0) * i) / n));
  });
  return pts;
}

/**
 * Voussoir layout: an odd count, about `vt` metres each along the extrados, the key at the crown keyK times as wide
 * (or a given key slot `fix`: { dk } for a round crown, { from } for a pointed one - brick rings share the stone key).
 * Returns { groups: [{ name, arc, r, deg, thetas }] } for the right half (mirrored by the caller) and the key group.
 */
function voussoirLayout(g, W, vt, keyK, fix = null) {
  const groups = [];
  const A = g.arcs;
  // the crown arc's voussoirs: odd count with a key slot dk, or with a given key slot (brick rings share the key)
  const crown = (a, lo) => {
    const full = 180 - 2 * lo;
    let dk, nOther;
    if (fix) {
      dk = fix.dk;
      nOther = Math.max(2, 2 * Math.round(((full - dk) * D2R * (a.r + W)) / vt / 2));
    } else {
      const n = oddRound((full * D2R * (a.r + W)) / vt, lo > 0 && A.length > 1 ? 3 : 5);
      dk = keyK > 1 ? Math.min(full / 3, (keyK * full) / n) : full / n;
      nOther = n - 1;
    }
    const d = (full - dk) / nOther;
    return { d, dk, thetas: Array.from({ length: nOther / 2 }, (_, i) => lo + d / 2 + i * d), n: nOther + 1 };
  };
  if (g.apex === 'round' && A.length === 1) {
    const a = A[0], c = crown(a, g.springer ? 0 : a.a0);
    groups.push({ name: 'voussoir', arc: 0, r: a.r, deg: c.d, thetas: c.thetas });
    groups.push({ name: 'key', arc: 0, r: a.r, deg: c.dk, thetas: [90] });
    return { groups, n: c.n };
  }
  if (g.apex === 'round') {           // basket: haunches + crown arc centred on the axis
    const h = A[0], ca = A[1];
    const nh = Math.max(1, Math.round(((h.a1 - h.a0) * D2R * (h.r + W)) / vt));
    const dh = (h.a1 - h.a0) / nh, c = crown(ca, ca.a0);
    groups.push({ name: 'voussoir-haunch', arc: 0, r: h.r, deg: dh, thetas: Array.from({ length: nh }, (_, i) => h.a0 + dh / 2 + i * dh) });
    groups.push({ name: 'voussoir', arc: 1, r: ca.r, deg: c.d, thetas: c.thetas });
    groups.push({ name: 'key', arc: 1, r: ca.r, deg: c.dk, thetas: [90] });
    return { groups, n: 2 * nh + c.n };
  }
  // pointed crowns: each arc of the right half has its own voussoirs; the key straddles the apex
  let total = 1;
  A.forEach((a, k) => {
    const last = k === A.length - 1;
    let n, d, from = a.a1;
    if (last && fix) {
      from = fix.from;
      n = Math.max(1, Math.round(((from - a.a0) * D2R * (a.r + W)) / vt));
      d = (from - a.a0) / n;
    } else {
      const span = a.a1 - a.a0;
      n = Math.max(1, Math.round((span * D2R * (a.r + W)) / vt - (last ? 0.5 * keyK : 0)));
      d = span / (n + (last ? 0.5 * keyK : 0));
      if (last) from = a.a1 - 0.5 * keyK * d;
    }
    groups.push({ name: last ? 'voussoir' : 'voussoir-haunch', arc: k, r: a.r, deg: d, thetas: Array.from({ length: n }, (_, i) => a.a0 + d / 2 + i * d) });
    if (last) groups.push({ name: 'key', arc: k, r: a.r, deg: a.a1 - from, from, thetas: [] });
    total += 2 * n;
  });
  return { groups, n: total };
}

// ------------------------------------------------------------------------------------------------ sections

/**
 * Face profile of the archivolt as [h, p] pairs: h runs from the intrados (0) to the extrados (W), p is the projection
 * beyond the wall face. Classical archivolts are architraves bent round the arch (Vignola): two fasciae (Tuscan,
 * Doric) or three (Ionic, Corinthian, Composite) under a crowning cyma reversa and fillet.
 */
function archivoltFace(L) {
  const { M, W, order, tr, detail } = L;
  if (tr !== 'classical' || detail === 'low') {
    // a plain band: classical (low detail) slightly proud, Moorish just proud of the wall, others flush
    const p = tr === 'moorish' ? 0.04 * M : tr === 'classical' ? 0.08 * M : 0;
    return [[0, p], [W, p]];
  }
  const three = ['ionic', 'corinthian', 'composite', 'solomonic'].includes(order);
  const pts = [];
  let h = 0, p = 0.06 * M;
  const go = (dh, dp = 0) => { if (dp) { p += dp; pts.push([h, p]); } h += dh; pts.push([h, p]); };
  pts.push([0, p]);
  if (three) { go(0.24 * W); go(0.27 * W, 0.035 * M); go(0.03 * W, 0.012 * M); go(0.0, -0.012 * M); go(0.24 * W, 0.0); }
  else { go(0.40 * W); go(0.38 * W, 0.045 * M); }
  // crowning cyma reversa (an ogee, concave toward the fasciae, convex toward the edge) and fillet
  const ch = W - h - 0.07 * W, cp = 0.09 * M, n = detail === 'high' ? 10 : 6, h0 = h, p0 = p;
  for (let i = 1; i <= n; i++) { const t = i / n; pts.push([h0 + ch * t, p0 + cp * (1 - Math.cos(Math.PI * t)) / 2]); }
  h = h0 + ch; p = p0 + cp;
  go(0.0, 0.015 * M); go(0.07 * W);
  return pts;
}

/** Closed ring section in (h, y): h from the intrados (0) out to W, y across the wall (front = -y). */
function ringSection(L) {
  const { T, W, tr, detail } = L;
  const t = T / 2;
  if (L.brick) {
    // one rowlock ring, flush with the wall; the collar joint to the next ring is a groove on both faces
    const w = L.ringW, c = (0.01 * w) / 0.225, jd = (0.012 * w) / 0.225;     // 10 mm collar joint, 12 mm deep
    return withTenon(L, [[0, -t], [w - c, -t], [w - c, -t + jd], [w, -t + jd], [w, t - jd], [w - c, t - jd], [w - c, t], [0, t]], w);
  }
  if (tr === 'gothic' || tr === 'romanesque') return withTenon(L, closeSym([...jambLine(L, detail), [W, -t]]), W);
  const face = archivoltFace(L);
  const front = face.map(([h, p]) => [h, -(t + p)]);
  const back = face.slice().reverse().map(([h, p]) => [h, t + p]);
  return withTenon(L, dedupe([...front, ...back]), W);
}

/**
 * A tenon on the extrados side of a ring section: a tongue `eps` deep running inside the wall's thickness, well clear
 * of both faces and of the joints, so every ring stone overlaps the spandrel wall (or the next brick ring) instead of
 * merely touching it - the arch prints and unions as one solid. Invisible, and no size changes.
 */
function withTenon(L, sec, W) {
  const e = L.eps, half = L.T / 2 - Math.max(3 * e, 0.06 * L.T);
  for (let i = 0; i < sec.length; i++) {
    const a = sec[i], b = sec[(i + 1) % sec.length];
    if (Math.abs(a[0] - W) > 1e-9 || Math.abs(b[0] - W) > 1e-9) continue;
    if (Math.min(a[1], b[1]) > -half || Math.max(a[1], b[1]) < half) continue;
    const s = Math.sign(b[1] - a[1]);
    const tongue = [[W, -s * half], [W + e, -s * half], [W + e, s * half], [W, s * half]];
    return [...sec.slice(0, i + 1), ...tongue, ...sec.slice(i + 1)];
  }
  return sec;
}

/**
 * Gothic and Romanesque rings: two recessed orders, the inner order (the soffit) narrower than the wall, the outer
 * flush with the wall faces; Gothic arrises are hollow-chamfered, Romanesque ones carry a roll on the inner order.
 * Returns the front half of the soffit line from the soffit centre (0, 0) to the face arris (hF, -T/2); the jambs below
 * the springing repeat it in plan (continuous orders), with plain chamfers for the mouldings that run round them.
 */
function jambLine(L, detail) {
  const { T, W, tr } = L, t = T / 2;
  if ((tr !== 'gothic' && tr !== 'romanesque') || L.brick) return [[0, 0], [0, -t]];
  const W1 = L.W1, y1 = L.y1;
  const c1 = detail === 'low' ? 0 : Math.min(0.32 * W1, 0.3 * y1);
  const c2 = detail === 'low' ? 0 : Math.min(0.3 * (W - W1), 0.45 * (t - y1));
  const front = [[0, 0]];
  corner(front, tr === 'gothic' ? 'hollow' : 'roll', 0, -y1, c1, detail);
  if (c2) { front.push([W1, -y1]); corner(front, tr === 'gothic' ? 'hollow' : 'chamfer', W1, -t, c2, detail); }
  else front.push([W1, -y1], [W1, -t]);
  return dedupe(front);
}

/** Treat the arris at (h0, y0) (soffit along -y, face along +h) with a hollow, a roll or a chamfer of size c. */
function corner(out, kind, h0, y0, c, detail) {
  if (!c) { out.push([h0, y0]); return; }
  if (kind === 'chamfer' || detail !== 'high') { out.push([h0, y0 + c], [h0 + c, y0]); return; }
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * (Math.PI / 2);
    out.push(kind === 'hollow' ? [h0 + c * Math.sin(a), y0 + c * Math.cos(a)] : [h0 + c - c * Math.cos(a), y0 + c - c * Math.sin(a)]);
  }
}

/** Close a front half outline (from (0, 0) on the soffit centre to (W, -t)) into a y-symmetric section. */
function closeSym(front) {
  const back = front.slice().reverse().map(([h, y]) => [h, -y]);
  return dedupe([...front, ...back.slice(0, -1)]);
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-7) out.push(p); }
  const a = out[0], b = out[out.length - 1];
  if (out.length > 1 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7) out.pop();
  return out;
}

// ------------------------------------------------------------------------------------------------ ring pieces

// result frame of Manifold.revolve (arch plane XY, axis Z) -> world (arch plane XZ, axis Y): (X, Y, Z) -> (X, -Z, Y)
const TO_ARCH = mat.Rx(Math.PI / 2);

/** A piece of the ring of intrados radius r turning `deg` degrees, centred on the +u direction about the origin. */
function ringPiece(sectionHY, r, deg, step, offset = 0) {
  const { CrossSection } = K();
  let cs = crossSection(sectionHY.map(([h, y]) => [r + h, -y]));
  if (offset) cs = cs.offset(offset, 'Miter', 2);
  if (cs instanceof CrossSection && cs.isEmpty()) return null;
  const segs = Math.max(3, Math.ceil(deg / step));
  return K().Manifold.revolve(cs, segs, deg).transform(mat.mul(TO_ARCH, mat.Rz((-deg / 2) * D2R)));
}

/** A voussoir with mortar joints: a body narrower by the joint, on a core that fills the joint a little way in. */
function voussoirSolid(L, r, deg, sec = L.section) {
  const hMid = Math.max(...sec.map((q) => q[0])) / 2;
  const body = ringPiece(sec, r, deg - (L.joint ? (L.joint / (r + hMid)) * R2D : 0), L.step);
  if (!L.joint) return body;
  const core = ringPiece(sec, r, deg, L.step, -L.jointDepth);
  return core ? union([body, core]) : body;
}

/** Transform placing a ring piece (centred on +u about the origin) at angle theta about arc centre (cu, cv) of bay b. */
function placeOnArc(L, xb, cu, cv, theta) {
  return mat.mul(mat.T(xb + cu, 0, L.zs + cv), mat.Ry(-theta * D2R));
}

// ------------------------------------------------------------------------------------------------ mouldings

/** Miter offset of a closed CCW outline by d (outward positive); keeps the vertex count. */
function offsetPoly(pts, d) {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const e1 = norm2([p[0] - a[0], p[1] - a[1]]), e2 = norm2([b[0] - p[0], b[1] - p[1]]);
    const n1 = [e1[1], -e1[0]], n2 = [e2[1], -e2[0]];
    const k = 1 + n1[0] * n2[0] + n1[1] * n2[1];
    return [p[0] + (d * (n1[0] + n2[0])) / k, p[1] + (d * (n1[1] + n2[1])) / k];
  });
}
const norm2 = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };

/** A moulding run round a closed CCW plan outline: profile p (projection) against height h, from z0. */
function mouldAround(outline, prof, z0) {
  const pts = prof.points ? prof.points() : prof;
  return loft(pts.map(([p]) => offsetPoly(outline, p)), pts.map(([, h]) => z0 + h));
}

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

function scaleProf(p, H) { const h = p.h; for (const q of p.pts) q[1] *= H / h; return p; }

/** Impost moulding at the springing (Vignola: one module high): fillet, ovolo, fillet, corona (fascia), cyma, fillet. */
function impostProf(L) {
  const { M, tr, hImp } = L, n = L.detail === 'high' ? 10 : 4;
  let p;
  if (tr === 'romanesque') p = new Prof(0).slope(0.16 * M, 0.55).fillet(0.45);                   // chamfered impost slab
  else if (tr === 'moorish') p = new Prof(0).fillet(0.25, 0.03 * M).ovolo(0.06 * M, 0.3, n).fillet(0.45, 0.02 * M);
  else if (['ionic', 'corinthian', 'composite', 'solomonic'].includes(L.order)) {
    p = torusP(new Prof(0).fillet(0.05, 0.025 * M), 0.1, 0.035 * M, n).fillet(0.2, -0.005 * M).cymaReversa(0.08 * M, 0.17, n).fillet(0.05, 0.01 * M)
      .fillet(0.25, 0.04 * M).cymaReversa(0.06 * M, 0.13, n).fillet(0.05, 0.01 * M);
  } else {
    p = new Prof(0).fillet(0.06, 0.03 * M).fillet(0.22).ovolo(0.1 * M, 0.2, n).fillet(0.06, 0.01 * M).fillet(0.32, 0.03 * M)
      .ovolo(0.05 * M, 0.1, n).fillet(0.04, 0.01 * M);
  }
  return scaleProf(p, hImp);
}

/** Pier base: plinth and a torus (Tuscan) or plinth, torus, scotia, torus (Attic); Gothic & Romanesque: chamfered plinth. */
function baseProf(L) {
  const { M, tr, hBase } = L, n = L.detail === 'high' ? 12 : 5;
  let p;
  if (tr === 'gothic' || tr === 'romanesque') p = new Prof(0.16 * M).fillet(0.55).slope(-0.1 * M, 0.25).fillet(0.08).slope(-0.06 * M, 0.12);
  else if (tr === 'moorish') p = new Prof(0.08 * M).fillet(0.7).slope(-0.08 * M, 0.3);
  else if (L.order === 'tuscan' || L.order === 'romanesque') {
    p = torusP(new Prof(0.2 * M).fillet(0.5).out(-0.02 * M), 0.32, 0.12 * M, n).out(-0.06 * M).fillet(0.08).cavetto(-0.1 * M, 0.1, n);
  } else {
    p = torusP(new Prof(0.22 * M).fillet(0.36).out(-0.02 * M), 0.2, 0.1 * M, n).out(-0.03 * M).fillet(0.04).scotia(0.12, 0.04 * M, 0, n)
      .fillet(0.04);
    p = torusP(p, 0.14, 0.07 * M, n).out(-0.04 * M).cavetto(-(0.22 * M - 0.02 * M - 0.03 * M - 0.04 * M), 0.1, n);
  }
  // end exactly on the pier face
  const last = p.pts[p.pts.length - 1];
  if (Math.abs(last[0]) > 1e-9) p.to(0, p.h);
  return scaleProf(p, hBase);
}

/** Crowning cornice: bed mould (cyma reversa), corona with its soffit, cyma recta (sima), fillet. */
function corniceProf(L) {
  const { M, tr, hCor } = L, n = L.detail === 'high' ? 12 : 5;
  let p;
  if (tr === 'gothic') p = new Prof(0).cavetto(0.22 * M, 0.35, n).fillet(0.25, 0.02 * M).slope(0.05 * M, 0.05).slope(-0.24 * M, 0.35);
  else if (tr === 'romanesque') p = new Prof(0).slope(0.3 * M, 0.45).fillet(0.55);
  else if (tr === 'plain' && L.order === 'egyptian') p = torusP(new Prof(0.02 * M), 0.14, 0.07 * M, n).cavetto(0.55 * M, 0.7, n).fillet(0.16, 0.02 * M);
  else if (tr === 'plain' && L.order === 'art-deco') p = new Prof(0.03 * M).fillet(0.3).out(0.06 * M).fillet(0.3).out(0.06 * M).fillet(0.4);
  else if (tr === 'plain') p = new Prof(0.04 * M).fillet(1);
  else if (tr === 'moorish') p = new Prof(0).fillet(0.3, 0.05 * M).cavetto(0.3 * M, 0.4, n).fillet(0.3, 0.02 * M);
  else {
    p = new Prof(0).fillet(0.04).cymaReversa(0.14 * M, 0.17, n).fillet(0.03, 0.015 * M).out(0.5 * M).fillet(0.03)
      .cavetto(0.04 * M, 0.04, 4).fillet(0.26).fillet(0.03, 0.02 * M).cymaReversa(0.05 * M, 0.06, n).cymaRecta(0.28 * M, 0.26, n)
      .fillet(0.08, 0.02 * M);
  }
  return scaleProf(p, hCor);
}

/** A torus (half round) of height dh (before scaling) that bulges by `bulge` metres whatever the later scaling. */
function torusP(p, dh, bulge, n) { return p.torus(dh, (2 * bulge) / dh, n); }

const maxP = (prof) => Math.max(...prof.points().map((q) => q[0]));

// ------------------------------------------------------------------------------------------------ layout

// height of the opening (to the crown of the intrados) over its span when no height is given: Vignola's 2:1 for round
// and Gothic arches; the flat arches serve wide openings (gateways, carriage entrances, Lauben) and stand lower
const OPENING = { semicircular: 2, pointed: 2, horseshoe: 1.8, tudor: 1.6, segmental: 1.5, basket: 1.4 };

// orders that dress a pier arcade as Vignola's "arch order" (half-columns and entablature) at high detail; Tuscan, the
// default, keeps plain piers with Tuscan imposts (the more common reading of "an arcade")
const ARCH_ORDERS = ['doric', 'greek-doric', 'ionic', 'corinthian', 'composite', 'solomonic'];

/** The dimensions that depend on the span alone (module, pier, wall, ring, impost, base); finish() adds the heights. */
function dims(spec, S, N, Mover) {
  const ch = character(spec), detail = spec.detail || 'high', o = ORDERS[ch.order] || ORDERS.tuscan;
  const L = { ...ch, detail, S, N, element: spec.element, o };
  const g0 = archGeom(ch.type, S);
  L.rise = g0.rise;
  const cols = spec.supports === 'columns';
  // module: Vignola's arch orders for the classical treatment; medieval arches use a module of span / 7
  const k = ch.tr === 'classical' ? (OPEN_M[ch.order] || 7) : ch.tr === 'moorish' ? 8 : ch.tr === 'plain' ? 8 : 7;
  L.cols = cols;
  L.archOrder = !cols && !spec._noOrder && ch.tr === 'classical' && detail === 'high' && ch.type === 'semicircular' && ARCH_ORDERS.includes(ch.order);
  if (!cols) {
    L.M = Mover || S / k;
    const M = L.M;
    // pier: Vignola's 3 M (= 0.46 span Tuscan ... 0.33 span Corinthian); Romanesque piers are massive, Gothic and
    // Moorish ones slender
    L.P = ch.tr === 'classical' ? 3 * M : ch.tr === 'romanesque' ? 0.5 * S : ch.tr === 'gothic' ? 0.36 * S : 0.34 * S;
    L.T = spec.depth || (ch.tr === 'romanesque' ? S / 3 : ch.tr === 'moorish' || ch.tr === 'plain' ? S / 5 : S / 4);
    L.W = ch.tr === 'gothic' ? 1.15 * M : ch.tr === 'moorish' ? 1.1 * M : M;
    L.hImp = ch.tr === 'gothic' || ch.tr === 'plain' ? 0 : ch.tr === 'romanesque' ? 0.6 * M : ch.tr === 'moorish' ? 0.45 * M : M;
    L.hBase = ch.tr === 'plain' ? 0 : ch.tr === 'moorish' ? 0.5 * M : M;
  } else {
    // columns carry the arch on a dosseret (impost block), as in Brunelleschi's loggia of the Innocenti; the column's
    // diameter follows from the springing height (opening twice the span unless the height is given)
    L.M = S / k;
    L.hBase = 0; L.hImp = 0;
  }
  return L;
}

/** Heights and supports for a given springing height (columns: diameter from it). */
function finish(spec, L, zs) {
  const { S, N } = L;
  L.zs = zs;
  if (L.cols) {
    const o = L.o, kd = L.tr === 'classical' ? 0.55 : 0.3;            // dosseret height in D
    const D = zs / (o.colD + kd);
    L.D = D; L.hDos = kd * D; L.colH = o.colD * D;
    // width of the support at the springing: the dosseret covers the capital's abacus and the base's plinth
    const half = { tuscan: 0.66, doric: 0.67, 'greek-doric': 0.64, ionic: 0.67, corinthian: 0.76, composite: 0.76, solomonic: 0.76,
      romanesque: 0.67, gothic: 0.66, egyptian: 0.82, 'art-deco': 0.68, modern: 0.5 }[L.order] ?? 0.67;
    L.P = 2 * half * D + 0.04 * D;
    L.T = spec.depth || 0.9 * L.P;
    L.M = Math.max(L.M, 0.5 * D);
    const ent = entablatureDims(L.order, D);
    L.W = Math.min(0.42 * L.P, Math.max(ent.arch, 0.45 * D));
  }
  const M = L.M;
  if (L.archOrder) {
    // Vignola's arch order: half-columns of 2 M on the pier faces, the entablature on them, the keystone rising to the
    // architrave; the wall is deep enough to bury the back half of each column
    L.D = 2 * M; L.colH = L.o.colD * L.D; L.ent = entablatureDims(L.order, L.D);
    L.T = spec.depth || Math.max(S / 4, 2.6 * M);
    L.ea = 0.5 * L.o.shaftTop * L.D;                       // the architrave's face is plumb with the column's top
  }
  L.eps = Math.min(0.002, 0.005 * M);                    // fusing overlap: 2 mm, less only for miniature elements
  if (L.tr === 'gothic' || L.tr === 'romanesque') { L.W1 = 0.5 * L.W; L.y1 = (L.tr === 'gothic' ? 0.3 : 0.34) * L.T; }
  L.key = spec.keystone !== false;
  // classical keystones project and rise into the cornice's bed (Vignola's keystone is a console under the cornice)
  L.keyRise = L.tr === 'classical' ? 0.55 * M : 0;
  L.hood = L.tr === 'gothic' && L.detail !== 'low' ? { gap: 0.1 * M, w: 0.42 * M, p: 0.32 * M } : null;
  L.hCor = L.tr === 'classical' ? 1.4 * M : L.tr !== 'plain' ? 0.9 * M : L.order === 'egyptian' ? 1.3 * M : L.order === 'art-deco' ? 0.9 * M : 0.6 * M;
  const above = L.tr === 'classical' ? (L.key ? L.keyRise : 0.45 * M) : L.hood ? L.hood.gap + L.hood.w + 0.6 * M : 0.6 * M;
  if (L.brick) {
    // rowlock rings of headers: a brick 215 x 65 mm with 10 mm joints, one ring per 2 m of span (at least one, at most
    // twelve); miniature arches get proportionally small bricks
    const b = Math.min(1, S / 1.35);
    L.rings = clamp(Math.ceil(S / 2), 1, 12);
    L.ringW = 0.225 * b; L.brickPitch = 0.075 * b;
    const bricks = N * L.rings * Math.PI * (S / 2 + L.rings * L.ringW) / L.brickPitch;
    if (bricks > 6000) L.brick = false;                           // a huge brick arcade: dressed voussoirs instead
    else L.W = L.rings * L.ringW;
  }
  L.g = archGeom(L.type, S);
  const gE = extradosRight(L.g, L.W, 3);
  L.crownE = Math.max(...gE.map((q) => q[1]));                                // extrados crown above the springing
  L.halfE = Math.max(...gE.map((q) => q[0]));                                 // widest point of the extrados
  // the rings of neighbouring arches must not meet over a support (a horseshoe is wider than its opening): widen the
  // pier, or for columns the impost block, as the Cordoban builders did
  L.P = Math.max(L.P, 2 * (L.halfE - S / 2) + 0.25 * M);
  L.zCor = zs + L.crownE + above;
  if (L.archOrder) { L.zCor = L.colH; L.hCor = L.ent.total; L.keyRise = Math.max(0, L.colH - zs - L.crownE); }
  L.Z = L.zCor + L.hCor;
  L.ret = L.archOrder ? Math.max(...Object.values(entablatureProfs(L)).map(maxP))
    : maxP(corniceProf(L));                                                   // the cornice returns round the ends
  L.X = N * (S + L.P) + L.P + 2 * L.ret;
  L.Xw = N * (S + L.P) + L.P;                                                // wall / supports, without the returns
  L.bays = Array.from({ length: N }, (_, b) => -L.Xw / 2 + L.P + S / 2 + b * (S + L.P));
  return L;
}

/** Layout for a spec: springing height from `height` (overall) or the type's opening proportion; the span shrinks if
 *  the height cannot hold the arch. */
function layoutFor(spec, S, N) {
  let L = dims(spec, S, N);
  const minZs = (LL) => (LL.cols ? 0.9 * LL.S : LL.hBase + LL.hImp + 0.5 * LL.M + 0.15 * LL.S);
  if (L.archOrder) {
    // the whole order (column + entablature) takes the height when one is given; the arch rises 2:1 (Vignola) but
    // always fits under the architrave with room for the keystone (a squat Greek Doric column lowers it)
    const o = L.o, eD = entablatureDims(L.order, 1).total;
    const M = spec.height ? spec.height / (o.colD + eD) / 2 : L.M, colH = o.colD * 2 * M;
    const crown = Math.min(2 * S, colH - M - 0.25 * M), zs = crown - L.rise;
    const LL = dims(spec, S, N, M);
    if (zs >= minZs(LL)) return finish(spec, LL, zs);
    return layoutFor({ ...spec, _noOrder: true }, S, N);
  }
  if (spec.height) {
    // Z = zs + top(S) where top is linear in S (for columns top depends on D which depends on zs: iterate)
    let zs = OPENING[L.type] * S - L.rise;
    for (let i = 0; i < 6; i++) { const F = finish(spec, dims(spec, S, N), zs); zs += spec.height - F.Z; }
    if (zs < minZs(L) && !spec._shrunk) {
      // the asked height cannot hold this span: shrink the span (all proportions scale with it)
      const F = finish(spec, dims(spec, S, N), minZs(L));
      const f = spec.height / F.Z;
      return layoutFor({ ...spec, span: S * f, _shrunk: true }, S * f, N);
    }
    L = finish(spec, dims(spec, S, N), Math.max(zs, minZs(L)));
  } else L = finish(spec, L, OPENING[L.type] * S - L.rise);
  return L;
}

/** The whole layout: arcade length -> bays and span; then layoutFor. */
function layout(spec) {
  let S = spec.span || 2.4, N = spec.element === 'arcade' ? (spec.bays || 3) : 1;
  if (spec.element === 'arcade' && spec.length) {
    const target = spec.length;
    const solve = (n) => {           // X is affine in S for a fixed bay count when the height is free
      const a = layoutFor(spec, 1, n).X, b = layoutFor(spec, 2, n).X;
      return clamp(1 + (target - a) / (b - a), 0.3, 40);
    };
    if (stated(spec, 'bays')) S = solve(N);
    else {
      let best = null;
      for (let n = 1; n <= 20; n++) {
        const s = solve(n), err = Math.abs(Math.log(s / S));
        if (!best || err < best.err) best = { n, s, err };
      }
      N = best.n; S = best.s;
    }
  }
  else if (spec.height && !stated(spec, 'span')) {
    // a height without a span: proportion the arch by its opening rule (the default span is not a request)
    const Z1 = layoutFor({ ...spec, height: undefined }, 1, N).Z;
    S = clamp(spec.height / Z1, 0.3, 40);
  }
  return layoutFor(spec, S, N);
}

// ------------------------------------------------------------------------------------------------ parts

/**
 * The ring of every bay as instance groups: { name, role, shape: { kind, r, deg, arc }, xf: [matrices] }. Shared by
 * build() (which makes one solid per shape) and expected() (which counts), so the two cannot disagree.
 */
function ringPlan(L) {
  const { g, bays } = L;
  const vt = clamp(0.3 * Math.sqrt(L.S / 2.4), 0.06, 1.4);
  const classicalKey = L.key && L.tr === 'classical';
  const layS = voussoirLayout(g, L.W, vt, classicalKey ? 1.6 : 1.0);
  const kg = layS.groups.find((q) => q.name === 'key');
  const moor = L.tr === 'moorish' && !L.brick;
  const groups = new Map();
  const add = (name, role, shape, m) => {
    const k = `${name}|${role}`;
    if (!groups.has(k)) groups.set(k, { name, role, shape, xf: [] });
    groups.get(k).xf.push(m);
  };
  // Moorish arches alternate two colours of stone (Cordoba): even courses stone, odd courses the accent
  const roleOf = (i) => (moor && i % 2 === 1 ? 'accent' : 'stone');
  const altName = (name, i) => (moor && i % 2 === 1 ? 'voussoir-alt' : name);
  // brick: rowlock rings of headers, each ring its own course of bricks round the same key (or crown brick)
  const rings = L.brick ? L.rings : 1;
  let maxI = 0;
  for (let k = 0; k < rings; k++) {
    const o = L.brick ? k * L.ringW : 0, suffix = k ? `-ring${k + 1}` : '';
    const gk = o ? { ...g, arcs: g.arcs.map((a) => ({ ...a, r: a.r + o })) } : g;
    const fix = L.brick && (classicalKey || g.apex === 'point') ? (g.apex === 'point' ? { from: kg.from } : { dk: kg.deg }) : null;
    const lay = L.brick ? voussoirLayout(gk, L.ringW, L.brickPitch, 1, fix) : layS;
    for (const grp of lay.groups) {
      if (grp.name === 'key') continue;
      const a = gk.arcs[grp.arc];
      const offset = grp.name === 'voussoir' && lay.groups.some((q) => q.name === 'voussoir-haunch') ? lay.groups[0].thetas.length : 0;
      grp.thetas.forEach((th, i) => {
        const ii = i + offset + (g.springer ? 1 : 0);
        maxI = Math.max(maxI, ii);
        const shape = { kind: 'v', r: grp.r, deg: grp.deg };
        for (const xb of bays) {
          add(altName(grp.name, ii) + suffix, roleOf(ii), shape, placeOnArc(L, xb, a.cu, a.cv, th));
          add(altName(grp.name, ii) + suffix, roleOf(ii), shape, placeOnArc(L, xb, -a.cu, a.cv, 180 - th));
        }
      });
    }
    // without a keystone a round crown has one more voussoir (brick) of the same shape in every ring
    if (!L.key && g.apex === 'round') {
      const kk = lay.groups.find((q) => q.name === 'key'), a = gk.arcs[kk.arc], vg = lay.groups.find((q) => q.name === 'voussoir');
      for (const xb of bays) add(altName('voussoir', maxI + 1) + suffix, roleOf(maxI + 1), { kind: 'v', r: vg.r, deg: vg.deg }, placeOnArc(L, xb, a.cu, a.cv, 90));
    }
  }
  if (g.springer) for (const xb of bays) {
    add('springer', roleOf(0), { kind: 'springer' }, mat.T(xb, 0, L.zs + g.arcs[0].cv));
    add('springer', roleOf(0), { kind: 'springer' }, mat.mul(mat.T(xb, 0, L.zs + g.arcs[0].cv), mat.Rz(Math.PI)));
  }
  for (const xb of bays) {
    if (L.key) add('keystone', roleOf(maxI + 1), { kind: 'key', kg }, mat.T(xb, 0, L.zs));
    else if (g.apex === 'point') add('crown', roleOf(maxI + 1), { kind: 'key', kg }, mat.T(xb, 0, L.zs));
  }
  return { groups: [...groups.values()], vt: L.brick ? L.brickPitch : vt, n: layS.n };
}

function voussoirParts(L) {
  const plan = ringPlan(L);
  // mortar joints: ashlar ~1/40 of a voussoir; brickwork 10 mm (scaled for miniatures)
  L.joint = L.detail === 'low' ? 0 : L.brick ? 0.01 * L.brickPitch / 0.075 : clamp(0.025 * plan.vt, 0.0015, 0.025);
  L.jointDepth = L.joint * (L.brick ? 1.2 : 1.6);
  const cache = new Map(), parts = [];
  const solidFor = (sh) => {
    const k = sh.kind === 'v' ? `v${sh.r.toFixed(6)}|${sh.deg.toFixed(6)}` : sh.kind;
    if (!cache.has(k)) cache.set(k, sh.kind === 'v' ? voussoirSolid(L, sh.r, sh.deg) : sh.kind === 'springer' ? springerSolid(L) : keyPiece(L, sh.kg));
    return cache.get(k);
  };
  for (const grp of plan.groups) parts.push(part(grp.name, grp.role, solidFor(grp.shape), instances(grp.xf)));
  // carved ornament of a console keystone: one part per carving, instanced on every key (front and back)
  for (const o of L.keyOrnament || []) {
    const keyXf = plan.groups.find((q) => q.name === 'keystone').xf;
    const xf = [];
    for (const k of keyXf) for (const m of o.local) xf.push(mat.mul(k, m));
    // a derived handle: the caller owns (and may delete) what build() returns, the memoised carving stays intact
    parts.push(part(o.name + (o.suffix || ''), 'stone', o.solid.translate([0, 0, 0]), instances(xf)));
  }
  return parts;
}

/** Horizontally bedded springer of a horseshoe arch (below the centre line), relative to the arc centre. */
function springerSolid(L) {
  const { g } = L, a = g.arcs[0], deg = g.springer.a1 - g.springer.a0;
  const s = voussoirSolid(L, a.r, deg, L.keySection).transform(mat.Ry(-(g.springer.a0 + deg / 2) * D2R));
  // keep what lies above the springing line (v = 0 is z = -cv in the centre's frame)
  return s.intersect(box(-1e3, -1e3, -a.cv, 1e3, 1e3, 1e3));
}

/** The crown piece of a bay at the origin of its springing line (u = 0, v = 0). */
function keyPiece(L, kg) {
  const { g } = L;
  const a = g.arcs[kg.arc];
  if (g.apex === 'round') {
    if (L.key && L.tr === 'classical') return classicalKeystone(L, a, kg.deg);
    // a flush key voussoir (medieval and Islamic arches have no projecting keystone)
    return voussoirSolid(L, a.r, kg.deg, L.keySection).transform(mat.mul(mat.T(a.cu, 0, a.cv), mat.Ry(-90 * D2R)));
  }
  // pointed crown: the end of each side's arc beyond `from` up to the axis, closing the V between the extrados arcs
  const R = a.r + L.W, top = axisAngle(a, R) + 2, deg = top - kg.from;
  let half = ringPiece(L.keySection, a.r, deg, L.step).transform(mat.mul(mat.T(a.cu, 0, a.cv), mat.Ry(-(kg.from + deg / 2) * D2R)));
  half = half.intersect(box(0, -1e3, -1e3, 1e3, 1e3, 1e3));
  const key = [half, half.transform(mat.Rz(Math.PI))];
  if (L.key) {
    // a plain key stone standing a little proud of the moulded orders across the apex (as in Gothic Revival work)
    const pi = onArc(a, a.r, kg.from), pe = onArc(a, R, kg.from), apexE = [0, a.cv + Math.sqrt(R * R - a.cu * a.cu)];
    const apexI = [0, a.cv + Math.sqrt(a.r * a.r - a.cu * a.cu)];
    const outline = [pi, pe, apexE, [-pe[0], pe[1]], [-pi[0], pi[1]], apexI];
    const pr = 0.1 * L.M;
    key.push(extrudeElevation(outline, L.T + 2 * pr, -L.T / 2 - pr));
  }
  return union(key);
}

/**
 * Classical keystone (Vignola): a wedge between radial joints, taller than the voussoirs (it rises into the bed of the
 * cornice), projecting beyond the archivolt with a cyma-curved face like a console, a small cap under the cornice.
 */
function classicalKeystone(L, a, deg) {
  const { M, T, W } = L;
  const r = a.r, top = L.crownE + L.keyRise + L.eps;      // v of the key's top (springing line v = 0)
  const half = (deg / 2) * D2R;
  // elevation: intrados arc, radial sides up to the top line
  const pts = [];
  const n = 8;
  for (let i = 0; i <= n; i++) { const t = Math.PI / 2 + half - (2 * half * i) / n; pts.push([r * Math.cos(t), a.cv + r * Math.sin(t)]); }
  const rTop = (top - a.cv) / Math.cos(half);
  pts.push([rTop * Math.sin(half), top], [-rTop * Math.sin(half), top]);
  const pa = Math.max(...archivoltFace(L).map((q) => q[1]));
  const consoleKey = L.detail === 'high' && ['ionic', 'corinthian', 'composite', 'solomonic'].includes(L.order);
  // plain keys (Tuscan, Doric) lean forward with a cyma face; console keys have a flat face between their scrolls
  const p0 = pa + (consoleKey ? 0.16 : 0.06) * M, p1 = pa + (L.detail === 'low' ? 0.06 : consoleKey ? 0.18 : 0.3) * M;
  const elev = extrudeElevation(pts, T + 2 * (p1 + 0.1 * M), -(T / 2 + p1 + 0.1 * M));
  // side profile (y, v): front face y = -(T/2 + p(v)), a cyma from p0 at the intrados to p1 under the cap
  const v0 = a.cv + r * Math.cos(half) - 0.02 * r, v1 = top - 0.18 * M, side = [];
  const m = L.detail === 'high' ? 14 : 4;
  for (let i = 0; i <= m; i++) {
    const t = i / m, v = v0 + (v1 - v0) * t;
    side.push([-(T / 2 + p0 + (p1 - p0) * sstep(t)), v]);
  }
  side.push([-(T / 2 + p1 + 0.06 * M), v1 + 0.02 * M], [-(T / 2 + p1 + 0.06 * M), top + 0.01]);
  const prof = [...side, ...side.slice().reverse().map(([y, v]) => [-y, v])];
  // the profile polygon lies in (y, v): extrude it along X
  const { Manifold } = K();
  const sideSolid = Manifold.extrude(crossSection(prof.map(([y, v]) => [y, v])), 4 * rTop + 2, 0, 0, [1, 1], true)
    .transform(Float64Array.from([0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1]));
  const key = elev.intersect(sideSolid);
  L.keyOrnament = null;
  if (consoleKey) {
    // console keystone (ancone) of the richer orders: a scroll rolls forward under the cap, a small one turns in at the
    // foot, an acanthus leaf runs up the face between them, front and back. Separate instanced parts, carved once per
    // session at the key's proportions (no booleans per build)
    const hk = top - (a.cv + r), wTop = 2 * rTop * Math.sin(half), wBot = 2 * r * Math.sin(half);
    const orn = consoleOrnament(wTop / hk, wBot / hk);
    const rt = 0.2 * hk, rb = 0.12 * hk, S = mat.S(hk);
    const yFace = (t) => -(T / 2 + p0 + (p1 - p0) * sstep(t));
    const place = (m) => [m, mat.mul(mat.Rz(Math.PI), m)];
    L.keyOrnament = [
      { name: 'key-scroll', solid: orn.big, local: place(mat.mul(mat.T(0, yFace(0.95) + 0.25 * rt, v1 - 0.95 * rt), mat.Rz(-Math.PI / 2), S)) },
      { name: 'key-scroll', solid: orn.small, local: place(mat.mul(mat.T(0, yFace(0.05) + 0.35 * rb, v0 + 0.02 * r + 1.05 * rb), mat.Rz(-Math.PI / 2), mat.Rx(Math.PI), S)), suffix: '-foot' },
      { name: 'key-leaf', solid: orn.leaf, local: place(mat.mul(mat.T(0, yFace(0.3) + 0.006 * hk, v0 + 0.02 * r + 2.0 * rb), S)) },
    ];
  }
  return key;
}

/** Scrolls and leaf of a console keystone in units of the key's height (widths quantised for the memo). Memoised per
 *  kernel generation (kernel.memo): never hand these out - parts get derived handles (see voussoirParts). */
function consoleOrnament(wt, wb) {
  wt = Math.round(wt * 50) / 50; wb = Math.round(wb * 50) / 50;
  return memo(`arch|key-ornament|${wt}|${wb}`, () => ({
    big: keyScroll(0.2, 0.86 * wt, 2.2, 0.2),
    small: keyScroll(0.12, 0.8 * wb, 1.8, 0.24),
    leaf: acanthusLeaf({ h: 0.56, w: 0.62 * wb, lean: 0.0, curl: 0.35, lobes: 3, nu: 14, nv: 30 }),
  }));
}

/**
 * A light scroll for keystones and consoles: the disc of the spiral's first turn run through `depth` (along Y, centred),
 * a raised spiral fillet on both faces and a boss at the eye. Same conventions as ornament.voluteScroll (spiral in XZ,
 * starting at the top and turning toward +X), a fraction of its cost.
 */
function keyScroll(r0, depth, turns, eye) {
  const n = 90, re = r0 * eye, kk = Math.log(r0 / re) / (2 * Math.PI * turns), sp = [];
  for (let i = 0; i <= n; i++) { const th = (i / n) * 2 * Math.PI * turns, r = r0 * Math.exp(-kk * th); sp.push([r * Math.sin(th), r * Math.cos(th), th]); }
  const first = sp.filter((q) => q[2] <= 2 * Math.PI + 1e-9).map(([x, z]) => [x, z]);
  const body = extrudeElevation(K().CrossSection.hull([crossSection(first)]), depth, -depth / 2);
  const run = sp.filter((q) => q[2] <= 2 * Math.PI * (turns - 0.2));
  const w = 0.16, strip = [...run.map(([x, z]) => [x, z]), ...run.slice().reverse().map(([x, z]) => [x * (1 - w), z * (1 - w)])];
  const g = 0.06 * r0;
  return union([
    body,
    extrudeElevation(strip, g * 1.5, -depth / 2 - g),
    extrudeElevation(strip, g * 1.5, depth / 2 - 0.5 * g),
    K().Manifold.cylinder(depth + 2.2 * g, re, re, 20).rotate([90, 0, 0]).translate([0, depth / 2 + 1.1 * g, 0]),
  ]);
}

/** Wall with the openings: piers + spandrels (piers) or spandrels only (columns), up into the cornice. */
function wallPart(L) {
  const { Xw, T, bays, S, zs, g } = L;
  const z0 = L.cols ? zs : 0, z1 = L.zCor + L.eps;
  let wall = box(-Xw / 2, -T / 2, z0, Xw / 2, T / 2, z1);
  const ext = extradosRight(g, L.W, L.step);
  const stepped = !L.cols && !L.brick && (L.tr === 'gothic' || L.tr === 'romanesque');
  const jl = stepped ? jambLine(L, L.detail) : null;
  const cuts = [];
  for (const xb of bays) {
    const right = ext.map(([u, v]) => [xb + u, zs + v]);
    const left = ext.slice().reverse().map(([u, v]) => [xb - u, zs + v]);
    // the ring's envelope above the springing (filled by the voussoirs)
    const poly = stepped ? [[xb + S / 2, zs], ...right, ...left.slice(1), [xb - S / 2, zs]]
      : [[xb - S / 2, z0 - 1], [xb + S / 2, z0 - 1], [xb + S / 2, zs], ...right, ...left.slice(1), [xb - S / 2, zs]];
    cuts.push(extrudeElevation(dedupe(poly), T + 1, -T / 2 - 0.5));
    if (stepped) {
      // the jambs repeat the recessed orders of the arch in plan
      const hF = jl[jl.length - 1][0], t = T / 2;
      const rb = [...jl.slice().reverse(), ...jl.slice(1).map(([h, y]) => [h, -y])].map(([h, y]) => [xb + S / 2 + h, y]);
      const plan = [[xb + S / 2 + hF, -t - 0.5], ...rb, [xb + S / 2 + hF, t + 0.5],
        [xb - S / 2 - hF, t + 0.5], ...rb.slice().reverse().map(([x, y]) => [2 * xb - x, y]), [xb - S / 2 - hF, -t - 0.5]];
      cuts.push(extrudeXY(dedupe(plan), zs + L.eps - (z0 - 1)).translate([0, 0, z0 - 1]));
    }
  }
  wall = wall.subtract(union(cuts));
  return part('wall', 'stone', wall);
}

/** Plan outline (CCW) of a pier of width P centred on x = 0; `flatLeft` / `flatRight` for the outer end of an end pier. */
function pierOutline(L, flatLeft, flatRight) {
  const { P, T } = L, t = T / 2;
  const jl = jambLine(L, 'medium');                      // chamfered version: offsets of it stay simple
  const J = [...jl.slice().reverse(), ...jl.slice(1).map(([h, y]) => [h, -y])];   // front (y = -t) to back (y = t)
  const right = flatRight ? [[P / 2, -t], [P / 2, t]] : J.map(([h, y]) => [P / 2 - h, y]);
  const left = flatLeft ? [[-P / 2, t], [-P / 2, -t]] : J.slice().reverse().map(([h, y]) => [-P / 2 + h, y]);
  return dedupe([...right, ...left]);
}

/** Base and impost mouldings round every pier (end piers included). */
function pierMouldings(L) {
  const parts = [];
  if (L.cols) return parts;
  const { P, bays, S, Xw } = L;
  const inner = [];
  for (let b = 0; b < bays.length - 1; b++) inner.push(mat.T(bays[b] + S / 2 + P / 2, 0, 0));
  const ends = [mat.T(Xw / 2 - P / 2, 0, 0), mat.mul(mat.T(-Xw / 2 + P / 2, 0, 0), mat.Rz(Math.PI))];
  const plain = (L.tr !== 'gothic' && L.tr !== 'romanesque') || L.brick;
  const oIn = pierOutline(L, false, false), oEnd = pierOutline(L, false, true);
  const add = (name, prof, z0) => {
    if (plain) { parts.push(part(name, 'stone', mouldAround(oIn, prof, z0), instances([...inner, ...ends]))); return; }
    if (inner.length) parts.push(part(name, 'stone', mouldAround(oIn, prof, z0), instances(inner)));
    parts.push(part(`${name}-end`, 'stone', mouldAround(oEnd, prof, z0), instances(ends)));
  };
  if (L.hBase > 0) add('pier-base', baseProf(L), 0);
  if (L.hImp > 0) add('impost', impostProf(L), L.zs - L.hImp);
  return parts;
}

function cornicePart(L) {
  const outline = rect(-L.Xw / 2, -L.T / 2, L.Xw / 2, L.T / 2);
  return part('cornice', 'stone', mouldAround(outline, corniceProf(L), L.zCor));
}

// ------------------------------------------------------------------------------------------------ arch order

/**
 * Entablature of the arch order as three moulding runs round the wall (projections from the wall face; the
 * architrave's face is plumb with the top of the half-columns). Heights from orders.js (Vignola); members after Ware:
 * Doric - two fasciae and taenia, triglyph frieze, ovolo bed mould, corona, cyma; Ionic - three fasciae, plain frieze,
 * dentil course, ovolo, corona, cyma; Corinthian and Composite - as Ionic plus a modillion course under the corona.
 * `marks` holds the dentil and modillion courses (height from the cornice's base, face projection, height).
 */
function entablatureProfs(L) {
  const { D, ent, order } = L, A = ent.arch, F = ent.frieze, C = ent.cornice, n = 10, ea = 0;
  const doric = order === 'doric' || order === 'greek-doric', rich = ['corinthian', 'composite', 'solomonic'].includes(order);
  const arch = doric
    ? new Prof(ea).fillet(0.38 * A).out(0.025 * D).fillet(0.42 * A).out(0.03 * D).fillet(0.2 * A)
    : new Prof(ea).fillet(0.22 * A).out(0.015 * D).fillet(0.27 * A).out(0.015 * D).fillet(0.31 * A).cymaReversa(0.045 * D, 0.14 * A, n)
      .fillet(0.06 * A, 0.008 * D);
  const frieze = new Prof(ea).fillet(F);
  const c = new Prof(ea), marks = {};
  if (doric) {
    c.fillet(0.05 * C, 0.01 * D).ovolo(0.12 * D, 0.18 * C, n).fillet(0.04 * C).out(0.42 * D).fillet(0.3 * C)
      .cymaReversa(0.04 * D, 0.08 * C, n).cymaRecta(0.2 * D, 0.27 * C, n).fillet(0.08 * C, 0.01 * D);
  } else {
    c.fillet(0.04 * C, 0.01 * D).cymaReversa(0.05 * D, rich ? 0.08 * C : 0.12 * C, n);
    marks.dentil = { z: c.h, p: c.p, h: (rich ? 0.14 : 0.2) * C };
    c.fillet(marks.dentil.h).ovolo(0.07 * D, 0.09 * C, n);
    if (rich) { marks.modillion = { z: c.h, p: c.p, h: 0.2 * C }; c.fillet(0.2 * C); }
    c.out(rich ? 0.36 * D : 0.3 * D).fillet((rich ? 0.2 : 0.27) * C).cymaReversa(0.03 * D, 0.06 * C, n);
    c.cymaRecta(0.2 * D, C - c.h - 0.07 * C, n).fillet(0.07 * C, 0.01 * D);
  }
  return { arch, frieze, cornice: Object.assign(c, { marks }) };
}

/** Pier axes (all piers, end piers included). */
function pierAxes(L) {
  const xs = [-L.Xw / 2 + L.P / 2];
  for (let b = 0; b < L.N; b++) xs.push(L.bays[b] + L.S / 2 + L.P / 2);
  return xs;
}

/** Plan outline of the entablature: brought forward over the half-columns on the front (its architrave plumb with
 *  their tops), flush with the wall at the back and the ends. */
const entOutline = (L) => rect(-L.Xw / 2, -L.T / 2 - L.ea, L.Xw / 2, L.T / 2);

/** Instance transforms along the four faces of the entablature's outline offset by p: a piece facing -Y with its back
 *  on the outline is repeated every `pitch` along the front and back (aligned with the pier axes) and the ends. */
function runAround(L, p, pitch, z, alignX) {
  const hx = L.Xw / 2 + p, yF = -L.T / 2 - L.ea - p, yB = L.T / 2 + p, xf = [];
  const along = (lo, hi, origin) => {
    const out = [];
    const k0 = Math.ceil((lo + 0.5 * pitch - origin) / pitch), k1 = Math.floor((hi - 0.5 * pitch - origin) / pitch);
    for (let k = k0; k <= k1; k++) out.push(origin + k * pitch);
    return out;
  };
  for (const x of along(-hx, hx, alignX)) { xf.push(mat.T(x, yF, z), mat.mul(mat.T(x, yB, z), mat.Rz(Math.PI))); }
  for (const y of along(yF, yB, (yF + yB) / 2)) { xf.push(mat.mul(mat.T(hx, y, z), mat.Rz(Math.PI / 2)), mat.mul(mat.T(-hx, y, z), mat.Rz(-Math.PI / 2))); }
  return xf;
}

function entablatureParts(L) {
  const { D, M, ent, order } = L;
  const pr = entablatureProfs(L), outline = entOutline(L);
  const z0 = L.zCor, e = L.eps;
  const body = union([
    mouldAround(outline, pr.arch, z0),
    mouldAround(outline, pr.frieze, z0 + ent.arch - e),
    mouldAround(outline, pr.cornice, z0 + ent.arch + ent.frieze - e),
  ]);
  const parts = [part('entablature', 'stone', body)];
  const axis0 = pierAxes(L)[0], zc = z0 + ent.arch + ent.frieze;
  const mk = pr.cornice.marks;
  if (mk.dentil) {
    // dentils: 1/3 M wide at a pitch of M/2, one on every column axis
    const w = M / 3, h = 0.86 * mk.dentil.h, d = 0.11 * D;
    const dentil = box(-w / 2, -d, 0, w / 2, e, h);
    parts.push(part('dentil', 'stone', dentil, instances(runAround(L, mk.dentil.p, M / 2, zc + mk.dentil.z, axis0))));
  }
  if (mk.modillion) {
    // modillions: scrolled consoles under the corona, one on every column axis and every 2 M
    const h = mk.modillion.h, len = 0.34 * D, w = 0.45 * M, m = 10, side = [[e, 0], [e, h]];
    for (let i = 0; i <= m; i++) { const t = i / m; side.push([-len * t, h - 0.42 * h * sstep(t * 1.2) ]); }
    for (let i = m; i >= 0; i--) { const t = i / m; side.push([-len * (0.18 + 0.82 * t), 0.58 * h * (1 - Math.sin((Math.PI / 2) * (1 - t))) * 0.9 + 0.05 * h * t]); }
    const mod = extrudeProfileXAt(dedupe(side), -w / 2, w / 2);
    parts.push(part('modillion', 'stone', mod, instances(runAround(L, mk.modillion.p, 2 * M, zc + mk.modillion.z, axis0))));
  }
  if (order === 'doric' || order === 'greek-doric') {
    // triglyphs (1 M wide) over every column axis and at 2 1/2 M - Vignola's Doric bay of 10 M takes four
    const w = M, h = ent.frieze, d = 0.05 * D, g = w / 6;
    let tri = box(-w / 2, -d, 0, w / 2, e, h);
    // two glyphs and two half-glyphs: V-grooves stopping short of the top (the triglyph's capital band)
    const groove = (x) => extrudeXY([[x - g / 2, -d - 0.1 * g], [x + g / 2, -d - 0.1 * g], [x, -d + 0.45 * g]], h - 0.1 * g).translate([0, 0, -0.1 * g]);
    tri = tri.subtract(union([groove(-w / 6), groove(w / 6), groove(-w / 2), groove(w / 2)]));
    const xf = runAround(L, 0, 2.5 * M, z0 + ent.arch, axis0);
    parts.push(part('triglyph', 'stone', tri, instances(xf)));
  }
  return parts;
}

/** Half-columns of the arch order on the front face of every pier. */
function engagedColumns(L) {
  const xs = pierAxes(L), faces = archOrderFaces(L);
  const { parts: col, f } = columnFor(L, xs.length * faces, L.triLeft);
  const places = [];
  for (const x of xs) {
    places.push(mat.mul(mat.T(x, -L.T / 2, 0), mat.S(f)));
    if (faces === 2) places.push(mat.mul(mat.T(x, L.T / 2, 0), mat.Rz(Math.PI), mat.S(f)));
  }
  return col.map((p) => {
    const own = p.transforms ? splitInst(p.transforms) : [mat.I()];
    const xf = [];
    for (const q of places) for (const m of own) xf.push(mat.mul(q, m));
    // a derived handle per build: the caller owns (and may delete) it, the memoised column stays intact
    return { ...p, meta: { ...p.meta, rigid: true }, name: `column-${p.name}`, manifold: p.manifold.translate([0, 0, 0]), transforms: instances(xf) };
  });
}

/** The arch order dresses the outer (front) face, as on the Colosseum and the Theatre of Marcellus; the inner face of
 *  the gallery shows plain piers with their imposts. */
function archOrderFaces() { return 1; }

/** Columns with dosserets (impost blocks) under every springing. */
function splitInst(t) { return Array.from({ length: t.length / 16 }, (_, i) => t.subarray(16 * i, 16 * i + 16)); }

/**
 * A column of the order built once per session at a reference height and shared (instances scale it): the arcade
 * regenerates fast while its span or height is edited. Lighter variants for long arcades (the triangle budget is per
 * element, after instancing), cheapest first: the acanthus leaves rebuilt at 20 x 44 with the parameters column.js uses,
 * then the heaviest plain parts simplified within D/150 one at a time (volutes, shaft, base...), then leaves at 14 x 30
 * and 10 x 22. A Corinthian column is ~480k triangles at every detail level of column.js.
 */
const COL_REF = 3;
// memoised per kernel generation (kernel.memo); the parts handed out are derived handles (columnHandles)
function referenceColumn(order, detail, step) {
  return memo(`arch|column|${order}|${detail}|${step}`, () => buildReferenceColumn(order, detail, step));
}

function buildReferenceColumn(order, detail, step) {
  let parts;
  if (step === 0) parts = buildColumn(normalize({ element: 'column', order, height: COL_REF, detail }).spec);
  else {
    const plan = lightSteps(order, detail), st = plan[step - 1], prev = referenceColumn(order, detail, step - 1);
    const o = ORDERS[order] || ORDERS.tuscan, D = COL_REF / o.colD, c = o.capD * D, comp = order === 'composite';
    parts = prev.map((p) => {
      if (st.leaves && p.name === 'leaf-lower') return { ...p, manifold: acanthusLeaf({ h: (comp ? 0.33 : 0.36) * c, w: 0.36 * D, lean: 0.16, wrap: 0.48 * D, nu: st.leaves[0], nv: st.leaves[1] }) };
      if (st.leaves && p.name === 'leaf-upper') return { ...p, manifold: acanthusLeaf({ h: (comp ? 0.56 : 0.64) * c, w: 0.33 * D, lean: 0.1, wrap: 0.5 * D, lobes: 5, nu: st.leaves[0], nv: st.leaves[1] }) };
      // Manifold's simplify is erratic: on the thin, warped volute scrolls a finer tolerance removes more and runs faster
      if (st.simplify === p.name) return { ...p, manifold: p.manifold.simplify(D / (/volute/.test(p.name) ? 600 : 150)) };
      return p;
    });
  }
  return parts;
}

/** The lightening steps of an order's column: leaves first, then its plain parts from the heaviest down. */
function lightSteps(order, detail) {
  return memo(`arch|column-steps|${order}|${detail}`, () => planLightSteps(order, detail));
}

function planLightSteps(order, detail) {
  const base = referenceColumn(order, detail, 0);
  const hasLeaves = base.some((p) => p.name === 'leaf-lower');
  const heavy = base.filter((p) => !/leaf/.test(p.name) && p.manifold.numTri() > 800)
    .map((p) => ({ name: p.name, w: p.manifold.numTri() * (p.transforms ? p.transforms.length / 16 : 1) }))
    .sort((a, b) => b.w - a.w).map((q) => ({ simplify: q.name }));
  return [...(hasLeaves ? [{ leaves: [20, 44] }] : []), ...heavy, ...(hasLeaves ? [{ leaves: [14, 30] }, { leaves: [10, 22] }] : [])];
}

/** The column for `count` copies within `budget` triangles, and its scale from the reference height. */
function columnFor(L, count, budget) {
  const tris = (ps) => ps.reduce((s, p) => s + p.manifold.numTri() * (p.transforms ? p.transforms.length / 16 : 1), 0);
  const n = lightSteps(L.order, L.detail).length;
  let parts = null;
  for (let step = 0; step <= n; step++) {
    parts = referenceColumn(L.order, L.detail, step);
    if (tris(parts) * count <= budget) break;
  }
  return { parts, f: L.colH / COL_REF };
}

function columnParts(L) {
  const xs = [];
  for (let b = 0; b <= L.N; b++) xs.push(-L.Xw / 2 + L.P / 2 + b * (L.S + L.P));
  const { parts: col, f } = columnFor(L, xs.length, L.triLeft - 2e4);
  const parts = col.map((p) => {
    const own = p.transforms ? splitInst(p.transforms) : [mat.I()];
    const xf = [];
    for (const x of xs) for (const m of own) xf.push(mat.mul(mat.T(x, 0, 0), mat.S(f), m));
    // a derived handle per build: the caller owns (and may delete) it, the memoised column stays intact
    return { ...p, meta: { ...p.meta, rigid: true }, name: `column-${p.name}`, manifold: p.manifold.translate([0, 0, 0]), transforms: instances(xf) };
  });
  // dosseret: a block of entablature (architrave fascia, frieze, small cornice) as in Brunelleschi's loggia
  // it reaches eps down into the capital and eps up into the wall and the voussoirs' feet: one solid
  const D = L.D, a = L.P / 2, t = L.T / 2 + 0.03 * D, h = L.hDos + 2 * L.eps, n = L.detail === 'high' ? 8 : 4;
  const prof = L.tr === 'classical'
    ? new Prof(-0.02 * D).fillet(0.3).fillet(0.08, 0.02 * D).fillet(0.32, -0.02 * D).ovolo(0.06 * D, 0.14, n).fillet(0.16, 0.02 * D)
    : new Prof(0).fillet(0.5).slope(0.06 * D, 0.5);
  scaleProf(prof, h);
  const dos = mouldAround(rect(-a + 0.02 * D, -t + 0.02 * D, a - 0.02 * D, t - 0.02 * D), prof, L.colH - L.eps);
  parts.push(part('dosseret', 'stone', dos, instances(xs.map((x) => mat.T(x, 0, 0)))));
  return { parts, n: xs.length };
}

/** Gothic hood mould (label) over the extrados, with label stops at the springing. */
function hoodParts(L) {
  const { g, hood, W, T, bays, M, S, P, N } = L;
  const t = T / 2, w = hood.w, p = hood.p, e = L.eps;
  // drip moulding (front face): a roll on top, a throat underneath, h = 0 on the side toward the arch
  const sec = [[0, -t + e], [0, -(t + 0.25 * p)], [0.15 * w, -(t + 0.7 * p)], [0.35 * w, -(t + p)], [0.65 * w, -(t + p)],
    [0.9 * w, -(t + 0.75 * p)], [w, -(t + 0.35 * p)], [w, -t + e]];
  // label stop: a block under the end of the hood with chamfered lower corners
  const stopAt = (x0, z1, len) => {
    const c = 0.3 * w, z0 = z1 - 1.5 * w;
    return extrudeElevation([[x0, z0 + c], [x0 + c, z0], [x0 + len - c, z0], [x0 + len, z0 + c], [x0 + len, z1], [x0, z1]], 1.12 * p + e, -(t + 1.12 * p));
  };
  const both = (m) => union([m, m.mirror([0, 1, 0])]);
  const clipU = (m, u) => m.intersect(box(-1e3, -1e3, -1e3, u, 1e3, 1e3));
  const xi = S / 2 + P / 2, xo = S / 2 + P - 0.12 * M;          // pier centre line; end of an end pier
  if (L.type === 'tudor') {
    // the square label of a Tudor arch: across over the crown, down the sides, returned at the ends; over an arcade one
    // label runs across all bays and drops only at the ends. Tudor roses fill the spandrels.
    // on columns the wall begins at the springing: the label stops on the impost block, without returns
    const xIn = L.halfE + hood.gap, zTop = L.crownE + hood.gap, zFoot = L.cols ? 0 : -0.25 * L.rise;
    const xL = bays[0] - xIn - w, xR = bays[N - 1] + xIn + w;
    const ret = L.cols ? 0 : clamp(xo - (xIn + w) - 0.5 * w, 0, 0.7 * w), legs = xIn + w <= (L.cols ? S / 2 + P : xo);
    const pieces = [extrudeProfileXAt(sec.map(([h, y]) => [y, zTop + h]), legs ? xL : bays[0] - xo, legs ? xR : bays[N - 1] + xo)];
    if (legs) {
      pieces.push(extrudeXY(sec.map(([h, y]) => [bays[N - 1] + xIn + h, y]), zTop + w - zFoot).translate([0, 0, zFoot]),
        extrudeXY(sec.map(([h, y]) => [bays[0] - xIn - h, y]), zTop + w - zFoot).translate([0, 0, zFoot]));
      if (ret > 0.2 * w) {
        pieces.push(extrudeProfileXAt(sec.map(([h, y]) => [y, zFoot + h]), xR - w, xR + ret),
          extrudeProfileXAt(sec.map(([h, y]) => [y, zFoot + h]), xL - ret, xL + w),
          stopAt(xR + ret - 0.1 * w, zFoot + w, 0.5 * w), stopAt(xL - ret - 0.4 * w, zFoot + w, 0.5 * w));
      }
    }
    const parts = [part('hood', 'stone', both(K().Manifold.union(pieces)), instances([mat.T(0, 0, L.zs)]))];
    if (L.detail === 'high') parts.push(...spandrelRoses(L, xIn, zTop, legs));
    return parts;
  }
  const pieces = [];
  g.arcs.forEach((a, k) => {
    const r = a.r + W + hood.gap, last = k === g.arcs.length - 1;
    const a1 = last ? axisAngle(a, r + w) + 1 : a.a1;
    const deg = a1 - a.a0;
    pieces.push(ringPiece(sec, r, deg, L.step).transform(mat.mul(mat.T(a.cu, 0, a.cv), mat.Ry(-(a.a0 + deg / 2) * D2R))));
  });
  const arcHalf = clipU(union(pieces), 1e3).intersect(box(0, -1e3, -1e3, 1e3, 1e3, 1e3));
  const a0 = g.arcs[0], u0 = a0.cu + a0.r + W + hood.gap, stopEnd = u0 + 1.3 * w;
  // neighbouring hoods over an arcade meet in a mitre above the pier; at the ends they finish on label stops
  const withStop = (lim) => (stopEnd <= lim ? both(union([arcHalf, stopAt(u0 - 0.1 * w, 0.02 * w, 1.4 * w)])) : both(clipU(arcHalf, lim)));
  const outer = withStop(xo), parts = [];
  const right = (xb) => mat.T(xb, 0, L.zs), left = (xb) => mat.mul(mat.T(xb, 0, L.zs), mat.Rz(Math.PI));
  if (N === 1) return [part('hood', 'stone', outer, instances([right(bays[0]), left(bays[0])]))];
  const inner = withStop(xi);
  const xfIn = [...bays.slice(0, -1).map(right), ...bays.slice(1).map(left)];
  parts.push(part('hood', 'stone', inner, instances(xfIn)));
  parts.push(part('hood-end', 'stone', outer, instances([right(bays[N - 1]), left(bays[0])])));
  return parts;
}

/** Tudor roses: the largest circle in each spandrel between the arches and the label, on both faces. */
function spandrelRoses(L, xIn, zTop, legs) {
  const { g, W, bays, S, P, N, T, M } = L, t = T / 2;
  const ext = extradosRight(g, W, 2);
  const distTo = (c, xb) => Math.min(...ext.map(([u, v]) => Math.min(Math.hypot(xb + u - c[0], v - c[1]), Math.hypot(xb - u - c[0], v - c[1]))));
  const spots = [];
  // end spandrels: walk down the corner's diagonal until the extrados is as near as the label
  const corner = (xb, sx) => {
    let d = 0.005 * S, c = null;
    for (let i = 0; i < 400; i++) {
      c = [xb + sx * (xIn - d / Math.SQRT2), zTop - d / Math.SQRT2];
      if (distTo(c, xb) <= d / Math.SQRT2) break;
      d *= 1.02;
    }
    return { c, r: d / Math.SQRT2 };
  };
  // spandrels between two arches: on the pier's centre line, under the label
  const between = (x) => {
    let r = 0.005 * S;
    for (let i = 0; i < 400; i++) {
      const c = [x, zTop - r];
      if (Math.min(distTo(c, x - S / 2 - P / 2), distTo(c, x + S / 2 + P / 2)) <= r) break;
      r *= 1.02;
    }
    return { c: [x, zTop - r], r };
  };
  if (legs) { spots.push(corner(bays[0], -1), corner(bays[N - 1], 1)); }
  for (let b = 0; b < N - 1; b++) spots.push(between(bays[b] + S / 2 + P / 2));
  const r0 = Math.min(...spots.map((q) => q.r)) * 0.78;
  if (!spots.length || r0 < 0.15 * M) return [];
  const rose = rosette(r0, 5, 0.35), xf = [];
  for (const { c } of spots) xf.push(mat.T(c[0], -t, L.zs + c[1]), mat.mul(mat.T(c[0], t, L.zs + c[1]), mat.Rz(Math.PI)));
  return [part('rose', 'stone', rose, instances(xf))];
}

/** A profile drawn in (y, z) run along X from x0 to x1. */
function extrudeProfileXAt(yz, x0, x1) {
  return K().Manifold.extrude(crossSection(yz), x1 - x0).transform(Float64Array.from([0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1])).translate([x0, 0, 0]);
}

/** Moorish alfiz: a rectangular frame round the horseshoe arch (one frame round the whole row over an arcade), from
 *  the impost up over the extrados, on both faces. */
function alfizParts(L) {
  const { M, T, bays, zs, N, S, P } = L;
  const t = T / 2, w = 0.35 * M, p = 0.08 * M, gap = 0.15 * M, e = L.eps;
  const hx = Math.min(L.halfE + gap, S / 2 + P - 0.15 * M - w), top = zs + L.crownE + gap;
  const z0 = zs - L.hImp, xL = bays[0] - hx, xR = bays[N - 1] + hx;
  const front = union([
    box(xL - w, -(t + p), top, xR + w, -t + e, top + w),
    box(xR, -(t + p), z0, xR + w, -t + e, top + w),
    box(xL - w, -(t + p), z0, xL, -t + e, top + w),
  ]);
  return [part('alfiz', 'stone', union([front, front.mirror([0, 1, 0])]))];
}

/** Brunelleschi's tondi: a moulded roundel in every spandrel between two arches of a loggia on columns. */
function tondoParts(L) {
  const { g, W, bays, S, P, N, T, zs } = L, t = T / 2;
  const ext = extradosRight(g, W, 2);
  const top = L.zCor - zs - 0.25 * L.M;                       // under the cornice, in springing coordinates
  const fits = (x, c, r) => ext.every(([u, v]) => Math.hypot(x - S / 2 - P / 2 - u, c - v) >= r && Math.hypot(x + S / 2 + P / 2 - u, c - v) >= r);
  let r = 0.02 * S;
  while (r < S && fits(0, top - 1.02 * r, 1.02 * r)) r *= 1.03;
  const R = 0.82 * r;
  if (R < 0.3 * L.M) return [];
  const n = L.detail === 'high' ? 64 : 32;
  // frame: a torus between fillets round a sunk disc
  const prof = [[0.62 * R, 0.0], [0.62 * R, 0.04 * R], [0.7 * R, 0.06 * R], [0.8 * R, 0.13 * R], [0.9 * R, 0.13 * R], [R, 0.07 * R], [R, 0]];
  const frame = revolve(prof.map(([a, b]) => [a, b]).concat([[0, 0]]).slice(0, -1).concat([]), n).transform(mat.Rx(Math.PI / 2));
  const disc = K().Manifold.cylinder(0.04 * R, 0.66 * R, 0.66 * R, n).transform(mat.Rx(Math.PI / 2)).translate([0, 0.02 * R, 0]);
  const tondo = union([frame, disc]);
  const xf = [];
  for (let b = 0; b < N - 1; b++) {
    const x = bays[b] + S / 2 + P / 2, z = zs + top - 1.02 * r;
    xf.push(mat.T(x, -t + 0.01 * R, z), mat.mul(mat.T(x, t - 0.01 * R, z), mat.Rz(Math.PI)));
  }
  return xf.length ? [part('tondo', 'stone', tondo, instances(xf))] : [];
}

// ------------------------------------------------------------------------------------------------ build

const stepFor = (detail) => (detail === 'low' ? 7.5 : detail === 'medium' ? 4 : 2.5);   // degrees per facet

/** Voussoirs, keystones (and their carving), springers, rosettes, tondi, dentils, modillions and triglyphs are single
 *  pieces: rigid; the wall, cornice, entablature, hood moulds, imposts, dosserets and pier bases are continuous: they
 *  bend. The columns (every part) are tagged where they are placed. */
const RIGID = /^(voussoir(-haunch|-alt)?(-ring\d+)?|keystone|crown|key|key-leaf|key-scroll(-foot)?|springer|rose|tondo|dentil|modillion|triglyph)$/;

export function build(spec) {
  const parts = buildParts(spec);
  return parts.map((p) => (typeof p.meta?.rigid === 'boolean' ? p : { ...p, meta: { ...p.meta, rigid: RIGID.test(p.name) } }));
}

function buildParts(spec) {
  const L = layout(spec);
  L.step = stepFor(L.detail);
  L.section = ringSection(L);
  // the key (and a horseshoe's springers) span every brick ring as one dressed stone
  L.keySection = L.brick ? withTenon(L, [[0, -L.T / 2], [L.W, -L.T / 2], [L.W, L.T / 2], [0, L.T / 2]], L.W) : L.section;
  const parts = [...voussoirParts(L), wallPart(L), ...pierMouldings(L)];
  parts.push(...(L.archOrder ? entablatureParts(L) : [cornicePart(L)]));
  if (L.hood) parts.push(...hoodParts(L));
  if (L.tr === 'moorish' && L.detail !== 'low') parts.push(...alfizParts(L));
  if (L.cols && L.tr === 'classical' && L.detail === 'high') parts.push(...tondoParts(L));
  // columns last: they take what the rest leaves of the triangle budget (this evaluates the rest's booleans)
  L.triLeft = TRI_BUDGET - parts.reduce((s, p) => s + p.manifold.numTri() * (p.transforms ? p.transforms.length / 16 : 1), 0);
  if (L.archOrder) parts.push(...engagedColumns(L));
  if (L.cols) parts.push(...columnParts(L).parts);
  dress(L, spec, parts);
  // last resort for very long Corinthian arcades: the keystones' carving goes before the budget does
  const total = parts.reduce((s, p) => s + p.manifold.numTri() * (p.transforms ? p.transforms.length / 16 : 1), 0);
  if (total <= TRI_BUDGET) return parts;
  // the dropped carvings' handles are this build's own (derived from the memoised ornament): freed here
  const kept = parts.filter((p) => !p.name.startsWith('key-')), held = new Set(kept.map((p) => p.manifold));
  for (const m of new Set(parts.filter((p) => !held.has(p.manifold)).map((p) => p.manifold))) m.delete();
  return kept;
}

/**
 * Materials the generator chooses itself (part.meta.material, honoured by the viewer and the exporters): the Cordoban
 * alternation of red brick and light stone in a horseshoe arch, and stone dressings (key, imposts, bases, cornice,
 * labels) on a brick arch, as in Georgian and Gothic brickwork.
 */
function dress(L, spec, parts) {
  const m = spec.material;
  const brickArch = m === 'brick' || m === 'terracotta';
  for (const p of parts) {
    if (p.role === 'accent') p.meta = { ...p.meta, material: brickArch ? 'limestone' : 'brick' };
    else if (brickArch && /^(keystone|crown|springer|impost|pier-base|cornice|entablature|hood|alfiz|dosseret|tondo|key-)/.test(p.name)) {
      p.meta = { ...p.meta, material: 'limestone' };
    }
  }
}

/** What the generator promises, for the tests. */
export function expected(spec) {
  const L = layout(spec);
  L.step = stepFor(L.detail);
  const counts = {};
  for (const grp of ringPlan(L).groups) counts[grp.name] = (counts[grp.name] || 0) + grp.xf.length;
  if (L.cols) counts['column-shaft'] = L.N + 1;
  if (L.archOrder) counts['column-shaft'] = (L.N + 1) * archOrderFaces(L);
  return { size: { x: L.X, z: L.Z }, counts, tol: 0.005 };
}
