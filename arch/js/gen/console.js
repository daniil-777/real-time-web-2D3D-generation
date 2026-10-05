// Console (bracket, corbel, ancon, modillion): an S-scroll seen in side elevation — a large volute at the top, rolling
// back toward the wall, and a small opposed volute at the foot — joined by a cyma-shaped face; the scrolls are carved
// discs on both cheeks (spiral channel inside a continuous rim); the face is sunk between raised margins and carries an
// acanthus leaf that springs from the lower scroll and clasps the upper one; a small moulded cap (abacus) crowns it.
// Z-up, metres; the console stands against a wall at y = +depth/2 and projects toward -Y; origin at its base centre.
//
// Proportions (in the manner of the mensole of Vignola's door plates and the "trusses" of Gibbs' pattern books):
// cap 0.11 H high, projecting 0.07 D in front and 0.05 W at the sides; the upper scroll's greatest radius 0.45 of the
// body's projection (at most 0.30 of the body's height), the lower scroll half the upper; the face between them a
// cyma leaving each scroll tangentially; the scroll cheeks 0.90 W wide, the face 0.80 W, sunk ~6 mm between margins
// of 0.12 of its width.

import { K, TAU, mat, loft, union, part, bezier, crossSection, thickSurface } from '../kernel.js';
import { Prof } from '../profiles.js';
import { spiral, extrudeElevation } from '../ornament.js';

export const ELEMENTS = ['console'];

const OV = 0.001;
const sstep = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
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

/**
 * A scroll disc for the console's cheeks (the voluteScroll of ornament.js, adapted): the hull of the spiral's first turn
 * extruded through `depth` (centred on y = 0, elevation in XZ), a spiral channel carved into both faces, an eye boss.
 * The channel runs inside a continuous rim (listel) of `rim` r and opens from nothing over its first half turn, so the
 * disc's outline is never notched where the spiral starts.
 */
function scrollDisc({ r0, depth, side, groove, channel = 0.32, rim = 0.07 }) {
  const { Manifold, CrossSection } = K();
  const sp = spiral(r0, r0 * EYE, TURNS, 240, side);
  const disc = CrossSection.hull([crossSection(sp.filter((q) => q[3] <= TAU + 1e-9).map(([x, z]) => [x, z]))]);
  let body = extrudeElevation(disc, depth, -depth / 2);
  const o = [], i = [];
  for (const [x, z, , th] of sp.filter((q) => q[3] <= TAU * (TURNS - 0.25))) {
    const k = sstep(th / Math.PI), a = 1 - rim, b = 1 - rim - (channel - rim) * k;
    o.push([x * a, z * a]); i.push([x * b, z * b]);
  }
  const strip = [...o, ...i.reverse()], g = groove * r0;
  body = body.subtract(Manifold.union([extrudeElevation(strip, 2 * g, -depth / 2 - g), extrudeElevation(strip, 2 * g, depth / 2 - g)]));
  const re = r0 * EYE;
  return union([body, Manifold.cylinder(depth + 0.6 * g, re, re, 32).rotate([90, 0, 0]).translate([0, depth / 2 + 0.3 * g, 0])]);
}

/**
 * The acanthus leaf of the console, carved on its face: a shell built directly on the face's contour (arc length s
 * from s0 to s1, outward normal), so it hugs the cyma and the front of the upper scroll at every point. Outline: a
 * narrow stalk springing from the lower scroll, then a broad oval blade of three pointed lobes a side (leaning toward
 * the tip, each with three small teeth) and a pointed tip lobe. Relief (outward, at most ~0.07 w): a
 * raised midrib, raised ribs ("pipes") running from the midrib out and up to each lobe, the blade between them
 * slightly hollow, the lobe edges turning out, a small hollow "eye" at each notch. `base(s)` is the face's own offset
 * there (negative inside the sunk panel). Coordinates: t along the leaf (0 stalk .. 1 tip), uu across (-1 .. 1).
 */
function faceLeaf({ C, s0, s1, w, th, base, uMax, Dp, nu, nv }) {
  const T0 = 0.07, LOB = 3, T1 = 0.84;                 // stalk below T0, lobes T0..T1, tip lobe above
  const lobeC = Array.from({ length: LOB + 1 }, (_, k) => T0 + ((T1 - T0) * (k + 0.55)) / LOB).map((c, k) => (k === LOB ? 0.93 : c));
  const env = (t) => (t < 0.38 ? 0.3 + 0.7 * Math.sin((Math.PI / 2) * (t / 0.38)) : Math.cos((Math.PI / 2) * ((t - 0.38) / 0.62)) ** 0.85);
  const half = (t) => {
    if (t < T0) return 0.065 + 0.045 * sstep(t / T0);                                   // the stalk
    const x = Math.min(LOB, ((t - T0) / (T1 - T0)) * LOB), g = t >= T1 ? 0.5 + 0.5 * (t - T1) / (1 - T1) : x - Math.floor(x);
    const gg = g ** 0.8;                                                                  // lobes lean toward the tip
    const lobe = 0.72 + 0.28 * (1 - Math.abs(2 * gg - 1)) ** 0.6;                         // pointed lobe, notch between
    const teeth = 0.06 * (1 - Math.abs(2 * ((3 * gg) % 1) - 1)) ** 1.5 * (t < T1 ? 1 : 0);   // three teeth per lobe
    return 0.5 * Math.max(0.03, env(t)) * (lobe + teeth);
  };
  const relief = (uu, t) => {
    const au = Math.abs(uu);
    let d = 0.03 * w * Math.exp(-((uu / 0.06) ** 2)) * (1 - 0.5 * t)                    // midrib
      + 0.03 * w * uu * uu * sstep((t - T0) / 0.1)                                         // edges turning out
      - 0.012 * w * Math.sin(Math.PI * au) * sstep((t - T0) / 0.1);                       // blade hollow between
    for (const c of lobeC) {                                                               // pipes: midrib -> lobe
      const ax = 0.05, ay = c - 0.13, bx = 0.82, by = c + 0.01;
      const px = au - ax, py = t - ay, vx = bx - ax, vy = by - ay, k = Math.max(0, Math.min(1, (px * vx + py * vy) / (vx * vx + vy * vy)));
      const dist = Math.hypot(px - k * vx, (py - k * vy) * 2.2);
      d += 0.022 * w * Math.exp(-((dist / 0.06) ** 2)) * (t > T0 ? 1 : 0);
    }
    for (let k = 1; k <= LOB; k++) {                                                       // eyes at the notches
      const tn = T0 + ((T1 - T0) * k) / LOB;
      d -= 0.016 * w * Math.exp(-(((au - 0.7) / 0.09) ** 2 + ((t - tn) / 0.025) ** 2));
    }
    return d * (1 - 0.6 * sstep((t - 0.72) / 0.28));                                     // the tip lies flatter
  };
  const f = (u, v) => {
    const uu = 2 * u - 1, s = s0 + v * (s1 - s0), c = C.at(s);
    const d = base(s) + 0.1 * th + relief(uu, v);                                          // its back sunk in the stone
    return [uu * half(v) * w, Dp / 2 - Math.min(uMax, c.u + d * c.nu), c.v + d * c.nv];
  };
  return thickSurface(f, nu, nv, (u, v) => th * (0.45 + 0.55 * (1 - (2 * u - 1) ** 2)) * (1 - 0.45 * v));
}

/** meta.rigid for the deformation engine (deform.js): true = the part's instances follow a deformation rigidly (carved
 *  or assembled pieces stay true), false = warped with the shape (continuous members bend). A tag a part already
 *  carries (set where it is made) is kept. */
const tagRigid = (parts, rigid) => parts.map((p) => (typeof p.meta?.rigid === 'boolean' ? p : { ...p, meta: { ...p.meta, rigid: rigid(p) } }));

export function build(spec) {
  const g = design(spec), { Dp, Wv, Wb } = g;
  const parts = [];
  // the face's contour from the lower scroll's start, up the cyma and on round the front of the upper scroll
  const run = [...g.face, ...g.big.slice(1, 70)], C = contour(run), Lf = contour(g.face).L;
  // body, its face (the cyma between the scrolls) sunk between two raised margins of 0.12 of the face width; the
  // panel's floor rises smoothly into the scrolls at both ends (no step against the scroll's roll)
  const dep = Math.min(0.03 * Wb, 0.12 * g.r2), Wr = 0.76 * Wb, sa = 0.04 * Lf, sb = 0.98 * Lf, ns = 48;
  const panel = (s) => dep * sstep((s - sa) / (0.14 * Lf)) * sstep((sb - s) / (0.16 * Lf));
  const outer = [], inner = [];
  for (let i = 0; i <= ns; i++) {
    const s = sa + ((sb - sa) * i) / ns, c = C.at(s), d = Math.max(panel(s), 1e-4 * Wb);
    outer.push([c.u + 0.002 * Wb * c.nu, c.v + 0.002 * Wb * c.nv]);
    inner.push([c.u - d * c.nu, c.v - d * c.nv]);
  }
  const recess = crossSection([[...outer, ...inner.reverse()]]).extrude(Wr).transform(PROFILE_TO_WORLD(Wr, Dp));
  const body = bodySection(g).extrude(Wb).transform(PROFILE_TO_WORLD(Wb, Dp)).subtract(recess);
  // the scroll discs on the cheeks, slightly wider than the face so their spiral channels read on both sides;
  // channel depth 0.045 r, but never more than 8 % of the cheek width (very thin, very large scrolls)
  const place = (r, side, phi, uc, vc) => scrollDisc({ r0: r, depth: Wv, side, groove: Math.min(0.045, (0.08 * Wv) / r) })
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
  // acanthus leaf carved on the face: springs from the lower scroll, fills the sunk panel, clasps the upper scroll's
  // front and ends just short of its most projecting point; at most 3.2 face-widths long, at most 0.65 of its length wide
  if (spec.enrichment !== 'none') {
    const s1 = Lf + 0.6 * g.r1, s0 = Math.max(0.06 * Lf, s1 - 3.2 * Wb), w = Math.min(0.94 * Wr, 0.65 * (s1 - s0));
    const th = Math.min(0.03 * w, 0.25 * g.ef);
    const nu = spec.detail === 'low' ? 16 : spec.detail === 'medium' ? 24 : 32, nv = spec.detail === 'low' ? 48 : spec.detail === 'medium' ? 72 : 96;
    const leaf = faceLeaf({ C, s0, s1, w, th, base: (s) => -panel(s), uMax: g.Db + 0.8 * g.ef, Dp, nu, nv }), bb = leaf.boundingBox();
    // (at absurd proportions where the leaf would leave the requested box, the console is left plain)
    if (bb.min[1] >= -Dp / 2 && bb.max[1] <= Dp / 2 && bb.min[2] >= 0 && bb.max[2] <= g.Hb) parts.push(part('leaf', 'stone', leaf));
  }
  // the carved leaf follows a deformation rigidly; the body and the cap are continuous and warp (a console placed by an
  // arch or an entablature is tagged rigid, whole, by that family)
  return tagRigid(parts, (p) => p.name === 'leaf');
}

/** What the generator promises: the requested width, depth (wall to the cap's front) and height. */
export function expected(spec) {
  return { size: { x: spec.width, y: spec.depth, z: spec.height }, counts: {}, tol: 0.005 };
}

