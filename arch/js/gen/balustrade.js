// Balustrades and balusters in the manner of Vignola, Palladio and Gibbs' pattern books:
// a base rail (plinth), turned balusters on square plinth blocks under square abaci, a moulded handrail, end pedestals
// (and intermediate ones about every 3 m), engaged half-balusters against the pedestal dies, optional urns.
// Z-up, metres, origin at the base centre, length along X, front -Y.
//
// Height of the balustrade H: plinth 1/6, baluster 2/3, rail 1/6 (classical practice). Baluster greatest diameter
// D = 0.29–0.33 of the baluster's height; balusters are spaced so that the clear gap between bellies is about half the
// greatest diameter (the classical rule; kept between D/3 and D/2), i.e. axis spacing s = 1.5 D. Pedestal dies are
// 1.8 D square; the rail and plinth mouldings return round the pedestals at the same heights.

import { mat, revolve, loft, box, union, part, instances, extrudeProfileX, bezier } from '../kernel.js';
import { Prof } from '../profiles.js';
import { urnParts } from './finial.js';
import { effective as periodFields } from './balustrade-style.js';

export const ELEMENTS = ['balustrade', 'baluster'];
export const BALUSTERS = ['vase', 'double-vase', 'bottle', 'square', 'bar'];

const OV = 0.001;                 // overlap of touching pieces (Manifold does not fuse touching faces)
const MAX_BALUSTERS = { turned: 600, bar: 3000 };   // derived counts beyond these widen the spacing (absurd length/height only)
const TRI_BUDGET = 1.1e6;         // triangles allowed for all balusters together, after instancing
// greatest diameter D as a fraction of the baluster's height (typical stone balusters: about 190 mm on 600 mm)
const D_OF = { vase: 0.33, 'double-vase': 0.31, bottle: 0.31, square: 0.29 };
const RES = { low: { segs: 32, q: 5 }, medium: { segs: 64, q: 8 }, high: { segs: 96, q: 12 } };
const styled = (spec) => ({ ...spec, ...periodFields(spec) });   // the period's baluster and urns (balustrade-style.js)

/** What generate() merges into the spec it returns, the fields as built: the period's baluster and urns
 *  (balustrade-style.js), and no urns where the run is too short for pedestals to carry them. */
export function effective(spec) {
  const e = periodFields(spec), s = { ...spec, ...e };
  if (s.element === 'balustrade' && s.urns && !layout(s).peds.length) e.urns = false;
  return e;
}

// ------------------------------------------------------------------------------------------------ dimensions

/** Every dimension of a balustrade of this spec (no geometry is built here; expected() uses it too). */
function dims(spec, override = {}) {
  const H = spec.height, kind = BALUSTERS.includes(spec.baluster) ? spec.baluster : 'vase', bar = kind === 'bar';
  const hp = H / 6, hr = H / 6, hb = H - hp - hr;
  // modern bars: 40 mm square at the default height, clear gaps of at most 100 mm (SIA 358 / EN 1991: no 120 mm sphere)
  const D = override.D ?? (bar ? 0.063 * hb : D_OF[kind] * hb);   // the section's module: the classical diameter
  const Db = D;                                                     // the balusters' own diameter (layout may slim it)
  const gap = bar ? Math.min(0.1, 0.158 * hb) * (D / (0.063 * hb)) : Db / 2;
  const s = Db + gap;
  const tp = bar ? 3 * D : 1.3 * D;       // plinth body width (Y)
  const tr = bar ? 3.5 * D : 1.3 * D;     // rail body width (Y)
  const Wd = bar ? 6 * D : 1.8 * D;       // pedestal die, square
  const base = baseProfile(bar, D, hp), rail = railProfile(bar, D, hr);
  const pmax = Math.max(...base.pts.map((q) => q[0]), ...rail.pts.map((q) => q[0]));
  return { H, hp, hr, hb, D, Db, gap, s, tp, tr, Wd, half: !bar, kind, bar, base, rail, pmax };
}

/** Base (plinth) profile from z = 0 to hp; p = projection beyond the body face. Classical: a projecting plinth course
 *  and a cyma reversa returning to the face. Modern: a plain curb with a chamfered top edge. */
function baseProfile(bar, D, hp, q = 12) {
  if (bar) { const c = Math.min(0.12 * hp, 0.4 * D); return new Prof(0).fillet(hp - c).slope(-c, c); }
  return new Prof(0.16 * D).fillet(0.4 * hp).fillet(0.04 * hp, -0.02 * D).cymaReversa(-0.11 * D, 0.24 * hp, q)
    .fillet(0.04 * hp, -0.03 * D).fillet(0.28 * hp);
}

/** Rail (handrail) profile from its underside to its top edge (the wash is added above). Classical: fillet, cyma
 *  reversa bed moulding, a plain corona, an ovolo and a top fillet. Modern: a coping slab with a small drip. */
function railProfile(bar, D, hr, q = 12) {
  if (bar) return new Prof(0).fillet(0.08 * hr).out(0.6 * D).fillet(0.84 * hr);
  return new Prof(0).fillet(0.08 * hr).cymaReversa(0.1 * D, 0.2 * hr, q).fillet(0.06 * hr, 0.015 * D)
    .fillet(0.28 * hr).ovolo(0.07 * D, 0.18 * hr, q).fillet(0.1 * hr, 0.012 * D);
}

const pTop = (p) => p.pts[p.pts.length - 1][0];
const maxN = (d) => (d.bar ? MAX_BALUSTERS.bar : MAX_BALUSTERS.turned);

/** Symmetric distribution of N balusters over B bays (extras go to the centre bay, then in pairs from the middle). */
function distribute(N, B) {
  const out = Array(B).fill(Math.floor(N / B));
  let r = N % B;
  if (B % 2 === 1 && r % 2 === 1) { out[(B - 1) / 2]++; r--; }
  for (let k = 0; r > 0; k++) {
    if (B % 2 === 1) { out[(B - 1) / 2 - 1 - k]++; out[(B - 1) / 2 + 1 + k]++; r -= 2; }
    else if (r >= 2) { out[B / 2 - 1 - k]++; out[B / 2 + k]++; r -= 2; }
    else { out[B / 2 - 1 - k]++; r--; }
  }
  return out;
}

/** Clear width of a bay for n balusters: half-balusters against both dies -> (n + 1) s; bars -> n Db + (n + 1) gap. */
const bayW = (d, n) => (d.half ? (n + 1) * d.s : n * d.Db + (n + 1) * d.gap);

/** Baluster axes in a bay [x0, x0 + W] holding n balusters, evenly spaced. */
function axes(d, x0, W, n) {
  if (d.half) { const s = W / (n + 1); return Array.from({ length: n }, (_, i) => x0 + (i + 1) * s); }
  const g = (W - n * d.Db) / (n + 1);
  return Array.from({ length: n }, (_, i) => x0 + g + d.Db / 2 + i * (d.Db + g));
}

/** Bays for a run of N balusters about every 3 m, preferring a count that distributes them symmetrically. */
function bayCount(Lr, N) {
  const B0 = Lr > 4 ? Math.max(2, Math.round(Lr / 3)) : 1;
  let B = B0;
  if (B0 > 1) for (const c of [B0, B0 + 1, B0 - 1, B0 + 2]) if (c >= 2 && c <= N && (c % 2 === 1 || (N % c) % 2 === 0)) { B = c; break; }
  return Math.max(1, Math.min(B, N));
}

/** Pedestals and bays laid out from -L/2: end pedestal, bay, pedestal, ..., end pedestal. */
function place(d, L, e, Ws, counts, extra = {}) {
  const bays = [], peds = [];
  let x = -L / 2 + e + d.Wd / 2;
  peds.push(x);
  counts.forEach((n, b) => {
    const x0 = x + d.Wd / 2;
    bays.push({ x0, x1: x0 + Ws[b], n, xs: axes(d, x0, Ws[b], n) });
    x = x0 + Ws[b] + d.Wd / 2;
    peds.push(x);
  });
  return { d, L, peds, bays, N: counts.reduce((a, b) => a + b, 0), e, ...extra };
}

/**
 * Plan layout along X. Returns { d, L, peds: [x of pedestal centres], bays: [{ x0, x1, n, xs: [baluster axes] }] }.
 * B = number of bays (one per ~3 m once the run exceeds 4 m), Wd = pedestal die, e = projection of its mouldings,
 * s = axis spacing (classical 1.5 D: gap D/2), half-balusters engaged against every die (bars: none).
 *  - `balusters` given, no length (normalize() leaves `length` unset when a count is stated): the count is exact,
 *    the spacing classical, and the length follows:
 *       L = (B + 1) Wd + 2 e + sum over bays of (n_b + 1) s     (bars: n_b Db + (n_b + 1) gap)
 *  - `length` given: the length is exact; each bay of clear width W = (L - (B + 1) Wd - 2 e) / B takes the fewest
 *    balusters that keep the gap at most D/2 (and at least D/3 when the bay allows), the spacing adjusted to fill W;
 *    bars keep gaps <= 100 mm.
 *  - both given: both are exact; the spacing is (L - (B + 1) Wd - 2 e) / (N + B) and the balusters are slimmed (down
 *    to 0.5 D) to keep the gap at D/2, or spaced wider than classical when few are asked for (a warning in meta); a
 *    count that cannot fit even with 0.5 D balusters falls back to the count rule (the length follows, `fallback`).
 * Runs too short for two pedestals and a baluster have no pedestals: rail and plinth run the full length.
 */
export function layout(spec) {
  const d = dims(spec), e = d.pmax, N = spec.balusters, L = spec.length ?? (N ? undefined : 3);
  if (N && L !== undefined) {
    const r = fitBoth(d, e, N, L);
    if (r) return r;
  }
  if (N) {
    const B = bayCount(2 * d.Wd + 2 * e + bayW(d, N), N), counts = distribute(N, B), Ws = counts.map((n) => bayW(d, n));
    return place(d, (B + 1) * d.Wd + 2 * e + Ws.reduce((a, b) => a + b, 0), e, Ws, counts, { fallback: L !== undefined });
  }
  if (L < 2 * (d.Wd + e) + bayW(d, 1)) return shortRun(spec, d, L);
  const nFor = (W) => {
    if (!d.half) return Math.max(1, Math.ceil((W - d.gap) / d.s - 1e-9));   // bars: never a gap above the safety limit
    let n = Math.max(1, Math.ceil(W / d.s - 1 - 1e-9));                      // gap at most D/2 ...
    if (n > 1 && W / (n + 1) - d.D < d.D / 3 - 1e-9 && W / n - d.D <= d.D / 2 + 1e-9) n--;   // ... and not under D/3 if avoidable
    return n;
  };
  const B = L > 4 ? Math.max(2, Math.round(L / 3)) : 1;
  const W = (L - (B + 1) * d.Wd - 2 * e) / B, want = nFor(W);
  const n = Math.min(want, Math.floor(maxN(d) / B));
  return place(d, L, e, Array(B).fill(W), Array(B).fill(n), { capped: n < want });
}

/** Length and count both requested: equal spacing over the requested length, slimmer balusters if needed. */
function fitBoth(d, e, N, L) {
  const B = bayCount(L, N), counts = distribute(N, B), Wsum = L - (B + 1) * d.Wd - 2 * e;
  if (Wsum <= 0) return null;
  if (d.half) {
    const s = Wsum / (N + B), Db = Math.min(d.D, Math.max(0.5 * d.D, s / 1.5));
    if (s - Db < 0.25 * Db) return null;                    // too crowded even with slim balusters
    const dd = { ...d, Db, gap: s - Db, s };
    return place(dd, L, e, counts.map((n) => (n + 1) * s), counts, { both: true });
  }
  const g = (Wsum - N * d.Db) / (N + B);
  if (g < 0.25 * d.Db) return null;
  const dd = { ...d, gap: g, s: d.Db + g };
  return place(dd, L, e, counts.map((n) => n * d.Db + (n + 1) * g), counts, { both: true });
}

/** A run without pedestals (shorter than two pedestals and one baluster): exact length, at least one baluster. */
function shortRun(spec, d0, L) {
  let d = d0;
  if (L < d.s) d = dims(spec, { D: 0.999 * d.D * (L / d.s) });  // squeeze the section so one baluster fits
  const n = Math.max(1, Math.min(maxN(d), Math.floor(L / d.s)));
  const s = L / n;
  const xs = Array.from({ length: n }, (_, i) => -L / 2 + s / 2 + i * s);
  return { d, L, peds: [], bays: [{ x0: -L / 2, x1: L / 2, n, xs, open: true }], N: n, e: 0 };
}

// ------------------------------------------------------------------------------------------------ balusters

/** Append a cubic Bezier (absolute control points) to a Prof. */
function bz(p, p1, p2, p3, n) { for (const q of bezier([p.p, p.h], p1, p2, p3, n).slice(1)) p.to(q[0], q[1]); return p; }

/**
 * The turned part of a baluster as a Prof (p = radius, h = height) of height ht and greatest diameter D.
 *  vase:        base torus, a pear-shaped belly low (widest at a third), an ogee rising to a slender neck, collar
 *               (fillet-bead-fillet), a bell-shaped cap flaring under the abacus. (Vignola's single-bellied baluster)
 *  bottle:      base torus, a round belly low (widest at a quarter), a convex shoulder, a long straight neck with a
 *               double collar, cap.
 *  double-vase: symmetric about mid-height: two bellies (at 0.24 and 0.76) meeting in a waist girt by a ring (Palladio,
 *               Michelangelo's Campidoglio).
 * Radii in D, heights in ht.
 */
function turnedProfile(kind, ht, D, q) {
  const P = (r, z) => [r * D, z * ht];
  const n = Math.max(6, q + 4);
  // a bead of height dh (in ht) standing out by `out` (in D): its bulge follows the diameter, not the height
  const bead = (p, dh, out) => p.torus(dh * ht, (2 * out * D) / (dh * ht), q + 2);
  const foot = () => new Prof(0.4 * D).fillet(0.015 * ht).torus(0.06 * ht, (0.07 * D) / (0.03 * ht), q + 2)
    .fillet(0.012 * ht, -0.1 * D).cavetto(-0.05 * D, 0.03 * ht, q);
  if (kind === 'double-vase') {
    const p = foot();                                                      // to z ~ 0.117
    bz(p, P(0.4, 0.15), P(0.48, 0.18), P(0.48, 0.245), n);                 // lower belly
    bz(p, P(0.48, 0.32), P(0.26, 0.36), P(0.22, 0.43), n);                 // ogee into the waist
    const lower = p.pts;
    // the ring at mid-height (0.43 - 0.57): fillet, torus, fillet, centred on 0.5
    const ring = new Prof(0.22 * D, 0.43 * ht).fillet(0.025 * ht, 0.04 * D).torus(0.09 * ht, (0.07 * D) / (0.045 * ht), q + 2)
      .fillet(0.025 * ht).out(-0.04 * D);
    const upper = lower.slice().reverse().map(([r, h]) => [r, ht - h]);
    const out = new Prof(0, 0);
    out.pts = [...lower, ...ring.pts.slice(1, -1), ...upper];
    return out;
  }
  const p = foot();
  if (kind === 'bottle') {
    bz(p, P(0.43, 0.15), P(0.5, 0.19), P(0.5, 0.26), n);                   // round belly, widest low
    bz(p, P(0.5, 0.36), P(0.3, 0.42), P(0.225, 0.48), n);                  // shoulder
    bz(p, P(0.21, 0.56), P(0.2, 0.66), P(0.195, 0.72), n);                 // long neck, slightly tapering
    bead(p.fillet(0.01 * ht, 0.02 * D), 0.03, 0.025).fillet(0.01 * ht, -0.02 * D).fillet(0.008 * ht, 0.015 * D);
    bead(p, 0.024, 0.02).fillet(0.008 * ht, -0.015 * D);                                // double collar to ~0.81
  } else {
    bz(p, P(0.42, 0.15), P(0.5, 0.22), P(0.5, 0.33), n);                   // pear-shaped belly, widest at a third
    bz(p, P(0.5, 0.47), P(0.2, 0.52), P(0.19, 0.7), n + 2);                // ogee into the neck
    bead(p.fillet(0.03 * ht).fillet(0.012 * ht, 0.03 * D), 0.04, 0.03).fillet(0.012 * ht, -0.025 * D);  // collar to ~0.79
  }
  const zc = p.h, rc = p.p, rtop = 0.4 * D, hcap = 0.955 * ht - zc;
  p.cavetto(rtop - rc - 0.02 * D, hcap, q + 2);                            // bell-shaped cap
  p.fillet(0.012 * ht, 0.02 * D).fillet(ht - p.h - 0.012 * ht);           // fillet under the abacus
  p.to(p.p, ht);
  return p;
}

/**
 * One baluster of total height h (square plinth block 0.09 h, turned part, square abacus 0.075 h; blocks 0.9 D square),
 * standing on z = 0, axis on Z. Modern 'bar' is a plain square bar of side D.
 */
export function balusterSolid(kind, h, D, segs, q) {
  if (kind === 'bar') return box(-D / 2, -D / 2, 0, D / 2, D / 2, h);
  const hpb = 0.09 * h, hab = 0.075 * h, b = 0.45 * D;
  const ht = h - hpb - hab + 2 * OV;
  const prof = turnedProfile(kind, ht, D, q);
  let turned;
  if (kind === 'square') {
    // a square baluster: the vase profile lathed square (rings of the same half-size as the radius)
    const { rings, zs } = prof.toRings(0, 0, hpb - OV);
    const rr = rings.map((r) => r.map(([x, y]) => [Math.sign(x) * Math.max(Math.abs(x), 0.02 * D), Math.sign(y) * Math.max(Math.abs(y), 0.02 * D)]));
    turned = loft(rr, zs);
  } else turned = revolve(prof.toRevolve(0, hpb - OV), segs);
  // plinth block with a small chamfer on its upper arrises; abacus block with a fillet and chamfer below
  const plinth = loft(...ringsZ([[b, 0], [b, hpb - 0.012 * h], [b - 0.012 * h, hpb]]));
  const abacus = loft(...ringsZ([[b - 0.01 * h, h - hab], [b, h - hab + 0.01 * h], [b, h]]));
  return union([plinth, turned, abacus]);
}

/** Square rings for loft from [[halfSize, z], ...]. */
function ringsZ(list) {
  return [list.map(([a]) => [[-a, -a], [a, -a], [a, a], [-a, a]]), list.map(([, z]) => z)];
}

// ------------------------------------------------------------------------------------------------ rail, plinth, pedestal

/** Cross-section (y, z) of a straight run: body of width t with the profile on both faces. */
function runSection(prof, t, z0) {
  const front = prof.pts.map(([p, h]) => [-(t / 2 + p), z0 + h]);
  return [...front, ...front.slice().reverse().map(([y, z]) => [-y, z])];
}

/** The rail's section: the rail profile on both faces and a top rising to a ridge 1.5 mm below the pedestal caps
 *  (a wash that sheds water; modern copings are flat at that level), so the rail never shows through a cap. */
function railSection(d, capped = true) {
  const front = d.rail.pts.map(([p, h]) => [-(d.tr / 2 + p), d.H - d.hr + h]);
  const topZ = d.H - (capped ? 0.0015 : 0), last = front[front.length - 1];
  if (d.bar) front.push([last[0], topZ]);
  const back = front.slice().reverse().map(([y, z]) => [-y, z]);
  return d.bar ? [...front, ...back] : [...front, [0, topZ], ...back];
}

/** A run of `prof` along X from x0 to x1 (section closed front-to-back), as a Manifold. */
function run(section, x0, x1) {
  return extrudeProfileX(section, x1 - x0, false).translate([x0, 0, 0]);
}

/** Pedestal: base and cap mouldings returned round a square die, sunk panels on the front and back of the die. */
function pedestal(d) {
  const { H, hp, hr, Wd, base, rail, bar } = d, a = Wd / 2;
  const p = new Prof(base.pts[0][0], 0);
  const foot = bar ? [[0, 0]] : [...base.pts.map((q) => q.slice()), [0, hp]];   // a modern post has no base moulding
  p.pts = [...foot, ...rail.pts.map(([pp, h]) => [pp, H - hr + h]), [pTop(rail), H]];
  // drop consecutive duplicates
  p.pts = p.pts.filter((q, i, arr) => !i || Math.abs(q[0] - arr[i - 1][0]) > 1e-9 || Math.abs(q[1] - arr[i - 1][1]) > 1e-9);
  const { rings, zs } = p.toRings(a, a, 0);
  let m = loft(rings, zs);
  if (!bar) {
    const z0 = hp + 0.12 * (H - hp - hr), z1 = H - hr - 0.12 * (H - hp - hr), w = a - 0.16 * Wd, dep = 0.035 * Wd;
    m = m.subtract(union([box(-w, -a - 1, z0, w, -a + dep, z1), box(-w, a - dep, z0, w, a + 1, z1)]));
  }
  return m;
}

// ------------------------------------------------------------------------------------------------ assembly

function segsFor(detail, N, profPts) {
  const R = RES[detail] || RES.high;
  const s = Math.floor(TRI_BUDGET / Math.max(1, N) / (2 * Math.max(20, profPts)));
  return { segs: Math.max(12, Math.min(R.segs, s - (s % 4))), q: N > 150 ? Math.min(R.q, 5) : R.q };
}

/** Instance transforms of a list of parts at several placements. */
function replicate(parts, mats) {
  return parts.map((p) => {
    const own = p.transforms ? Array.from({ length: p.transforms.length / 16 }, (_, i) => p.transforms.subarray(16 * i, 16 * i + 16)) : [mat.I()];
    return { ...p, transforms: instances(mats.flatMap((m) => own.map((o) => mat.mul(m, o)))) };
  });
}

function urnHeight(d) { return 1.8 * d.Wd; }

/** meta.rigid for the deformation engine (deform.js): true = the part's instances follow a deformation rigidly (carved
 *  or assembled pieces stay true), false = warped with the shape (continuous members bend). A tag a part already
 *  carries (set where it is made) is kept. */
const tagRigid = (parts, rigid) => parts.map((p) => (typeof p.meta?.rigid === 'boolean' ? p : { ...p, meta: { ...p.meta, rigid: rigid(p) } }));

/** Balusters (and half-balusters) and urns are turned pieces: rigid; pedestals, plinths and rails bend. */
const RIGID = /^(baluster|half-baluster|urn-)/;

export function build(spec) {
  return tagRigid(buildParts(styled(spec)), (p) => RIGID.test(p.name));
}

function buildParts(spec) {
  if (spec.element === 'baluster') {
    const kind = BALUSTERS.includes(spec.baluster) ? spec.baluster : 'vase', h = spec.height;
    const D = kind === 'bar' ? 0.063 * h : D_OF[kind] * h;
    const R = RES[spec.detail] || RES.high;
    return [part('baluster', kind === 'bar' ? 'metal' : 'stone', balusterSolid(kind, h, D, R.segs + 32, R.q + 2))];
  }
  const lay = layout(spec), { d, bays, peds } = lay;
  const N = bays.reduce((s, b) => s + b.n, 0);
  const halfCount = d.half ? 2 * bays.filter((b) => !b.open).length : 0;
  const { segs, q } = segsFor(spec.detail, N + halfCount, 90);
  const hBal = d.hb + 2 * OV, zBal = d.hp - OV;
  const bal = balusterSolid(d.kind, hBal, d.Db, segs, q);
  const parts = [];
  // rails and plinths per bay, sunk 2 mm into the pedestals; equal bays share one mesh
  const inset = peds.length ? 0.002 : 0;
  const plinthSec = runSection(d.base, d.tp, 0);
  const widths = [...new Set(bays.map((b) => +(b.x1 - b.x0 + 2 * inset).toFixed(9)))];
  const runPart = (name, sec, role) => {
    if (widths.length === 1) {
      const w = widths[0], m = run(sec, -w / 2, w / 2);
      return part(name, role, m, instances(bays.map((b) => mat.T((b.x0 + b.x1) / 2, 0, 0))));
    }
    return part(name, role, union(bays.map((b) => run(sec, b.x0 - inset, b.x1 + inset))));
  };
  parts.push(runPart('plinth', plinthSec, 'stone'));
  parts.push(runPart('rail', railSection(d, peds.length > 0), 'stone'));
  // what the layout did, for the UI: spacing, gap, diameter, and a warning when the request forced an unclassical rhythm
  const xs = bays.flatMap((b) => b.xs), sp = xs.length > 1 ? xs[1] - xs[0] : d.s, gap = sp - d.Db;
  const mode = !peds.length ? 'short run' : lay.both ? 'length and count' : spec.balusters ? 'count' : 'length';
  let warning;
  if (lay.capped) warning = `the run would need more than ${maxN(d)} balusters; spacing widened`;
  else if (lay.fallback) warning = `${N} balusters cannot fit in ${spec.length} m even slimmed; the run is ${lay.L.toFixed(2)} m`;
  else if (!d.bar && peds.length && gap > d.Db * 0.55) warning = `gaps of ${(gap * 100).toFixed(0)} cm exceed half the baluster's diameter; more balusters would suit this length`;
  else if (d.bar && gap > 0.1 + 1e-9) warning = `gaps of ${(gap * 100).toFixed(0)} cm exceed 10 cm (SIA 358 guarding)`;
  else if (d.Db < d.D - 1e-9) warning = `balusters slimmed to ${(d.Db * 100).toFixed(1)} cm to fit ${N} in ${spec.length} m`;
  parts.push(part('baluster', d.bar ? 'metal' : 'stone', bal, instances(xs.map((x) => mat.T(x, 0, zBal))),
    { mode, count: N, spacing: sp, gap, diameter: d.Db, bays: bays.length, pedestals: peds.length, ...(warning ? { warning } : {}) }));
  if (halfCount) {
    const halfB = bal.trimByPlane([1, 0, 0], -OV);
    const xf = [];
    for (const b of bays) {
      if (b.open) continue;
      xf.push(mat.T(b.x0, 0, zBal), mat.mul(mat.T(b.x1, 0, zBal), mat.Rz(Math.PI)));
    }
    parts.push(part('half-baluster', 'stone', halfB, instances(xf)));
  }
  if (peds.length) {
    parts.push(part('pedestal', 'stone', pedestal(d), instances(peds.map((x) => mat.T(x, 0, 0)))));
    if (spec.urns) {
      const urn = urnParts(urnHeight(d), { handles: false, knob: 'bud', detail: spec.detail });
      const ends = [peds[0], peds[peds.length - 1]].map((x) => mat.T(x, 0, d.H - OV));
      parts.push(...replicate(urn, ends).map((p) => ({ ...p, name: `urn-${p.name}` })));
    }
  } else if (spec.urns) parts[0] = { ...parts[0], meta: { ...(parts[0].meta || {}), warning: 'no urns: a run this short has no pedestals to carry them' } };
  return parts;
}

/**
 * What the generator promises.
 * balustrade: x = the overall length, measured over the end pedestals' base and cap mouldings (pedestals included):
 *   - length given (no count): x = spec.length;
 *   - balusters given, no length: x = (B + 1) Wd + 2 e + sum_b (n_b + 1) s, where s = 1.5 D (gap
 *     D/2), Wd = 1.8 D the pedestal die, e its mouldings' projection, B bays of ~3 m (bars: n_b Db + (n_b + 1) gap);
 *   - both given: x = spec.length (see layout()), unless the count cannot fit even slimmed (then as above);
 *   - runs shorter than two pedestals and a baluster have no pedestals and x = spec.length.
 *   z = height, plus the urns' height (1.8 Wd, sunk 1 mm into the pedestal cap) when urns are on and there are
 *   pedestals to carry them. counts: baluster = the requested count, or the count derived from the length.
 * baluster: z = height.
 */
export function expected(input) {
  const spec = styled(input);
  if (spec.element === 'baluster') return { size: { z: spec.height }, counts: { baluster: 1 }, tol: 0.005 };
  const lay = layout(spec);
  const urns = spec.urns && lay.peds.length;
  return {
    size: { x: lay.L, z: spec.height + (urns ? urnHeight(lay.d) - OV : 0) },
    counts: { baluster: lay.bays.reduce((s, b) => s + b.n, 0) },
    tol: 0.005,
  };
}
