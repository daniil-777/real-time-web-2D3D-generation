// Console (bracket, corbel, ancon, modillion): an S-scroll seen in side elevation — a large volute at the top, rolling
// back toward the wall, and a small opposed volute at the foot — joined by a cyma-shaped face; the scrolls are carved
// discs on both cheeks (ornament.js voluteScroll); an acanthus leaf springs from the lower scroll and climbs the face,
// its tip turning over under the upper scroll; a small moulded cap (abacus) crowns it.
// Z-up, metres; the console stands against a wall at y = +depth/2 and projects toward -Y; origin at its base centre.
//
// Proportions (in the manner of the mensole of Vignola's door plates and the "trusses" of Gibbs' pattern books):
// cap 0.11 H high, projecting 0.07 D in front and 0.05 W at the sides; the upper scroll's greatest radius 0.45 of the
// body's projection (at most 0.30 of the body's height), the lower scroll half the upper; the face between them a
// cyma leaving each scroll tangentially; the scroll cheeks 0.90 W wide, the face 0.80 W, sunk ~6 mm between margins
// of 0.12 of its width.

import { TAU, mat, loft, union, part, bezier, crossSection } from '../kernel.js';
import { Prof } from '../profiles.js';
import { acanthusLeaf, voluteScroll, spiral } from '../ornament.js';

export const ELEMENTS = ['console'];

const OV = 0.001;
const TURNS = 2.2, EYE = 0.16;             // both volutes: 2.2 turns, eye 0.16 of the outer radius

/** First turn of a volute's spiral, as voluteScroll draws it in elevation, rotated in its plane by phi (as Ry(phi)),
 *  in the console's profile plane (u = projection from the wall, v = height), centred on (uc, vc). */
function volutePts(r0, side, phi, uc = 0, vc = 0) {
  const c = Math.cos(phi), s = Math.sin(phi);
  return spiral(r0, r0 * EYE, TURNS, 240, side).filter((q) => q[3] <= TAU + 1e-9)
    .map(([x, z]) => [uc + c * x + s * z, vc - s * x + c * z]);
}

/** Convex hull (counter-clockwise) of 2D points (monotone chain). */
function hull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

const bbox2 = (pts) => pts.reduce((b, [u, v]) => [Math.min(b[0], u), Math.min(b[1], v), Math.max(b[2], u), Math.max(b[3], v)],
  [Infinity, Infinity, -Infinity, -Infinity]);

/** The side profile and everything placed on it, in (u, v). */
function design(spec) {
  const H = spec.height, Dp = spec.depth, Wc = spec.width;
  const hc = 0.11 * H, ef = 0.07 * Dp, es = 0.05 * Wc;
  const Hb = H - hc, Db = Dp - ef;                   // body height and projection under the cap
  const r1 = Math.min(0.45 * Db, 0.3 * Hb), r2 = 0.5 * r1;
  // upper scroll: spiral turning front -> top -> back (side -1), its start (largest radius) below the front, 45 deg
  // down, so the face rises into it tangentially; lower scroll: front -> bottom -> back (side +1), its start 30 deg up
  const PB = Math.PI / 2 + Math.PI / 4, PS = Math.PI / 2 - Math.PI / 6;
  const b0 = bbox2(volutePts(r1, -1, PB));
  const u1 = Db - b0[2], v1 = Hb + OV - b0[3];
  // the lower scroll stands on v = 0, its front at 0.42 of the projection (its back at least 6 % off the wall)
  const s0 = bbox2(volutePts(r2, 1, PS));
  const u2 = Math.max(-s0[0] + 0.06 * Db, 0.42 * Db - s0[2]), v2 = -s0[1];
  const big = volutePts(r1, -1, PB, u1, v1), small = volutePts(r2, 1, PS, u2, v2);
  // the face: a cyma leaving the lower scroll's outer line and entering the upper scroll's, tangent to both
  const S = small[0], B = big[0];
  const unit = (p, q) => { const l = Math.hypot(q[0] - p[0], q[1] - p[1]); return [(q[0] - p[0]) / l, (q[1] - p[1]) / l]; };
  const tS = unit(small[0], small[2]), tB = unit(big[0], big[2]), k = 0.42 * Math.hypot(B[0] - S[0], B[1] - S[1]);
  // control points kept inside the body's box, so the curve (inside their hull) never leaves it at odd proportions
  const box2 = (p) => [Math.min(Db, Math.max(0.02 * Db, p[0])), Math.min(Hb, Math.max(0, p[1]))];
  const face = bezier(S, box2([S[0] - tS[0] * k, S[1] - tS[1] * k]), box2([B[0] - tB[0] * k, B[1] - tB[1] * k]), B, 48);
  return { PB, PS, H, Dp, Wc, hc, ef, es, Hb, Db, r1, r2, u1, v1, u2, v2, big, small, face, Wv: 0.9 * Wc, Wb: 0.8 * Wc };
}

/** Body section: the face region back to the wall, each scroll's hull carried back to the wall. */
function bodySection(g) {
  const neck = [...g.face, [g.u1, g.v1], [0, g.v1], [0, g.v2], [g.u2, g.v2]];
  const top = hull([...g.big, [0, g.Hb + OV], [0, g.v1]]);
  const foot = hull([...g.small, [0, 0], [0, g.v2]]);
  return crossSection([neck, top, foot]);
}

// profile plane (u, v) extruded along +c  ->  world (x, y, z) = (Wb/2 - c, Dp/2 - u, v)   (a proper rotation)
const PROFILE_TO_WORLD = (Wb, Dp) => Float64Array.from([0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, Wb / 2, Dp / 2, 0, 1]);

/** Arc-length lookup along a polyline in (u, v): position and outward (forward) normal at distance s. */
function contour(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1];
  const at = (s) => {
    const x = Math.min(L, Math.max(0, s));
    let i = 1;
    while (i < pts.length - 1 && cum[i] < x) i++;
    const a = pts[i - 1], b = pts[i], l = cum[i] - cum[i - 1] || 1, f = (x - cum[i - 1]) / l;
    const tu = (b[0] - a[0]) / l, tv = (b[1] - a[1]) / l, over = s - x;  // beyond the ends: continue straight
    return { u: a[0] + f * (b[0] - a[0]) + over * tu, v: a[1] + f * (b[1] - a[1]) + over * tv, nu: tv, nv: -tu };
  };
  return { at, L };
}

export function build(spec) {
  const g = design(spec), { Dp, Wv, Wb } = g;
  const parts = [];
  // body, its face (the cyma between the scrolls) sunk between two raised margins of 0.12 of the face width
  const run = [...g.face, ...g.big.slice(1, 70)], C = contour(run), Lf = contour(g.face).L;
  const dep = Math.min(0.03 * Wb, 0.12 * g.r2), Wr = 0.76 * Wb, sa = 0.02 * Lf, ns = 40;
  const outer = [], inner = [];
  for (let i = 0; i <= ns; i++) {
    const c = C.at(sa + ((Lf - sa) * i) / ns);
    outer.push([c.u + 0.002 * Wb * c.nu, c.v + 0.002 * Wb * c.nv]);
    inner.push([c.u - dep * c.nu, c.v - dep * c.nv]);
  }
  const recess = crossSection([[...outer, ...inner.reverse()]]).extrude(Wr).transform(PROFILE_TO_WORLD(Wr, Dp));
  const body = bodySection(g).extrude(Wb).transform(PROFILE_TO_WORLD(Wb, Dp)).subtract(recess);
  // the scroll discs on the cheeks, slightly wider than the face so their spiral channels read on both sides
  // channel depth 0.045 r, but never more than 8 % of the cheek width (very thin, very large scrolls)
  const place = (r, side, phi, uc, vc) => voluteScroll({ r0: r, depth: Wv, side, eye: EYE, turns: TURNS, channel: 0.3, groove: Math.min(0.045, (0.08 * Wv) / r), pinch: 0 })
    .transform(mat.mul(mat.T(0, Dp / 2 - uc, vc), mat.Rz(-Math.PI / 2), mat.Ry(phi)));
  parts.push(part('console', 'stone', union([body, place(g.r1, -1, g.PB, g.u1, g.v1), place(g.r2, 1, g.PS, g.u2, g.v2)])));
  // cap: fillet, cyma reversa, fillet, corona, ovolo, fillet — returned on the front and both sides, flush at the wall
  const q = spec.detail === 'low' ? 6 : spec.detail === 'medium' ? 9 : 12;
  const cp = new Prof(0).fillet(0.1).cymaReversa(0.45, 0.28, q).fillet(0.08, 0.05).fillet(0.3).ovolo(0.4, 0.14, q).fillet(0.1, 0.1);
  const hTot = cp.h, yb = Dp / 2;
  const rings = cp.pts.map(([p]) => {
    const hx = Wv / 2 + p * g.es, yf = Dp / 2 - (g.Db + p * g.ef);
    return [[-hx, yf], [hx, yf], [hx, yb], [-hx, yb]];
  });
  parts.push(part('cap', 'stone', loft(rings, cp.pts.map(([, h]) => g.Hb + (h / hTot) * g.hc))));
  // acanthus leaf on the face, bent to follow it (and the upper scroll's front) from the lower scroll upward
  if (spec.enrichment !== 'none') {
    // the leaf springs from the lower scroll, climbs the face and clasps the front of the upper scroll, its tip
    // turning over at about the scroll's start
    // the leaf ends 0.75 r1 up the upper scroll; it is at most 3.2 face-widths long (a tall ancon's leaf starts higher)
    const sEnd = Lf + 0.75 * g.r1, hLeaf = Math.min(0.98 * sEnd, 3.2 * Wb), s0 = sEnd - hLeaf;
    const wLeaf = Math.min(0.92 * Wb, 0.62 * hLeaf), tLeaf = Math.min(0.012 * wLeaf, 0.03 * Dp, 0.03 * g.H);
    const nu = spec.detail === 'low' ? 18 : 30, nv = spec.detail === 'low' ? 40 : 72;
    // flatten the blade's relief to 50 % and sink its back into the face, so it lies on the stone like a carving
    const sink = 0.02 * wLeaf, flat = 0.5;
    const make = (curl, nu, nv) => acanthusLeaf({ h: hLeaf, w: wLeaf, lobes: 3, curl, lean: 0, wrap: 0, t: tLeaf, nu, nv }).warp((v) => {
      const sv = s0 + v[2], dip = dep * Math.min(1, Math.max(0, (Lf * 1.02 - sv) / (0.04 * Lf)));   // down into the sunk face
      const c = C.at(sv), d = -v[1] * flat - sink - dip;
      const u = c.u + d * c.nu, vv = c.v + d * c.nv;
      v[1] = Dp / 2 - u; v[2] = vv;
    });
    // the turned-over tip must stay under the cap's overhang: relax the curl until it does
    // (at absurd proportions where no curl fits, the console is left plain rather than with a protruding leaf)
    // (the search runs on a coarse leaf; the full one is built once and checked again)
    const fits = (m) => { const bb = m.boundingBox(); return bb.min[1] >= -Dp / 2 + 0.15 * g.ef && bb.min[2] >= 0 && bb.max[2] <= g.Hb; };
    for (const curl of [0.45, 0.3, 0.18, 0.08, 0]) {
      if (!fits(make(curl, 12, 24))) continue;
      const leaf = make(curl, nu, nv);
      if (fits(leaf)) { parts.push(part('leaf', 'stone', leaf)); break; }
    }
  }
  return parts;
}

/** What the generator promises: the requested width, depth (wall to the cap's front) and height. */
export function expected(spec) {
  return { size: { x: spec.width, y: spec.depth, z: spec.height }, counts: {}, tol: 0.005 };
}

