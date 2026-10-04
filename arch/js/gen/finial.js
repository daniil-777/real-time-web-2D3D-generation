// Finials, urns and obelisks: carved and turned terminals on moulded socles, and the obelisk on its stepped pedestal.
// Z-up, metres, origin at the base centre, front -Y. Every builder states the proportions it uses, as fractions of
// the element's height H; they follow common classical practice (the vases, finials and pedestals of the 18th-century
// pattern books of Gibbs and Chambers; the Roman obelisks re-erected under Sixtus V by D. Fontana).

import { K, TAU, mat, revolve, loft, box, union, part, instances, tube, thickSurface, extrudeXY, partsBBox, placeParts }
  from '../kernel.js';
import { Prof } from '../profiles.js';

export const ELEMENTS = ['finial', 'urn', 'obelisk'];
export const FINIALS = ['ball', 'pineapple', 'acorn', 'urn', 'flame', 'cross', 'spike'];

// detail -> lathe segments, samples per curved moulding, ornament density
const RES = { low: { segs: 40, q: 6, k: 0.5 }, medium: { segs: 72, q: 9, k: 0.75 }, high: { segs: 112, q: 12, k: 1 } };
export function resolution(detail) { return RES[detail] || RES.high; }

const OV = 0.001; // overlap of touching pieces (Manifold does not fuse touching faces)
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const sstep = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------------------------------------ helpers

/** Rescale a profile's heights so it spans exactly H (profiles are drawn in relative units). */
function scaleH(p, H) {
  const h0 = p.pts[0][1], h = p.h - h0;
  for (const q of p.pts) q[1] = h0 + ((q[1] - h0) * H) / h;
  return p;
}

/** Square "lathe": a profile (p = offset from the die face) wrapped around a square die of half-width a. */
function squareLoft(p, a, z0 = 0) { const { rings, zs } = p.toRings(a, a, z0); return loft(rings, zs); }

/** Turned piece: a profile (p = radius) revolved about Z, its foot at z0. */
function lathe(p, z0, segs) { return revolve(p.toRevolve(0, z0), segs); }

/** Column-major frame matrix from basis vectors and origin, with uniform scale s. */
function frame(ex, ey, ez, o, s = 1) {
  return Float64Array.from([ex[0] * s, ex[1] * s, ex[2] * s, 0, ey[0] * s, ey[1] * s, ey[2] * s, 0, ez[0] * s, ez[1] * s, ez[2] * s, 0,
    o[0], o[1], o[2], 1]);
}

/** Uniformly scale a finished element about the origin so that its bbox top is exactly H (absorbs the few
 *  millimetres a carved top — leaf tips, a flame — cannot be predicted in closed form). */
function fitHeight(parts, H) {
  const { min, max } = partsBBox(parts);
  const k = H / (max[2] - min[2]);
  return placeParts(parts, mat.mul(mat.S(k), mat.T(0, 0, -min[2])));
}

/**
 * Moulded square socle (plinth block) of die half-width a and height h: plinth course and cyma reversa at the foot,
 * plain die, cavetto bed moulding, corona fillet, ovolo and top fillet at the head. Mouldings project 0.18 a.
 * Heights in the manner of small classical pedestals: base ~0.30, die ~0.37, cap ~0.33 of the block.
 */
export function socle(a, h, q = 12) {
  const e = 0.18 * a;
  const p = new Prof(e).fillet(0.17)
    .cymaReversa(-0.7 * e, 0.13, q)
    .fillet(0.035, -0.3 * e)
    .fillet(0.38)
    .cavetto(0.35 * e, 0.09, q)
    .fillet(0.06, 0.08 * e)
    .ovolo(0.45 * e, 0.09, q)
    .fillet(0.07, 0.12 * e);
  return squareLoft(scaleH(p, h), a);
}

/**
 * Points spread over a surface of revolution (meridian rz(t) -> [r, z], t in [t0, t1]) by the golden angle, with equal
 * surface area per point (phyllotaxis, the arrangement of pine-cone and pineapple scales). Each point carries the local
 * frame used to instance a scale: ex along the parallel, ey = inward normal, ez = up the meridian, and the area side.
 */
function phyllotaxis(rz, n, t0 = 0, t1 = 1) {
  const S = 400, cum = [0], ts = [t0];
  let prev = rz(t0);
  for (let k = 1; k <= S; k++) {
    const t = t0 + ((t1 - t0) * k) / S, p = rz(t);
    cum.push(cum[k - 1] + TAU * ((p[0] + prev[0]) / 2) * Math.hypot(p[0] - prev[0], p[1] - prev[1]));
    ts.push(t); prev = p;
  }
  const A = cum[S], out = [];
  let k = 1;
  for (let i = 0; i < n; i++) {
    const target = ((i + 0.5) / n) * A;
    while (k < S && cum[k] < target) k++;
    const f = (target - cum[k - 1]) / (cum[k] - cum[k - 1] || 1), t = ts[k - 1] + f * (ts[k] - ts[k - 1]);
    const [r, z] = rz(t), e = 1e-4, a = rz(Math.max(t0, t - e)), b = rz(Math.min(t1, t + e));
    const dl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, tr = (b[0] - a[0]) / dl, tz = (b[1] - a[1]) / dl;
    const th = i * GOLDEN, c = Math.cos(th), s = Math.sin(th);
    out.push({ pos: [r * c, r * s, z], ex: [-s, c, 0], ey: [-tz * c, -tz * s, tr], ez: [tr * c, tr * s, tz], side: Math.sqrt(A / n), t });
  }
  return out;
}

/** One scale: an almond-shaped boss (pointed at its upper end, lifted off the surface by `lift` radians), centred on
 *  the origin in the frame of phyllotaxis() (x along the parallel, -y outward, z up the meridian); unit size. */
function scaleMesh(w, l, th, lift, segs) {
  const { Manifold } = K();
  const m = Manifold.sphere(0.5, segs).scale([w, th, l]).warp((v) => {
    const u = v[2] / (0.5 * l);                     // -1 .. 1 along the scale
    if (u > 0) v[0] *= 1 - 0.62 * u * u;             // taper to a point at the top
    v[1] += 0.18 * th * (1 - u * u) - 0.25 * th;    // flat back, sunk a quarter into the surface
  });
  return m.transform(mat.Rx(lift));
}

/**
 * A pointed leaf blade rising along +Z and arching outward (toward -Y) by `arch` radians at its tip; its section is a
 * shallow channel. len = length along the blade, w = greatest width.
 */
function blade({ len, w, arch = 1, lean = 0.2, t = 0, nu = 8, nv = 28 }) {
  const th = t || 0.06 * w, S = 80, sp = [[0, 0]], ang = [lean];
  for (let i = 1; i <= S; i++) {
    const v = i / S, a = lean + arch * v ** 1.7;
    sp.push([sp[i - 1][0] - (Math.sin(a) * len) / S, sp[i - 1][1] + (Math.cos(a) * len) / S]);
    ang.push(a);
  }
  const at = (v) => {
    const f = v * S, i = Math.min(S - 1, Math.floor(f)), r = f - i;
    return [sp[i][0] * (1 - r) + sp[i + 1][0] * r, sp[i][1] * (1 - r) + sp[i + 1][1] * r, ang[i] * (1 - r) + ang[i + 1] * r];
  };
  const width = (v) => w * (v < 0.3 ? 0.5 + 0.5 * Math.sin((Math.PI / 2) * (v / 0.3)) : Math.max(0.03, (1 - (v - 0.3) / 0.7) ** 0.85));
  const f = (u, v) => {
    const [y, z, a] = at(v), x = (2 * u - 1) * (width(v) / 2), d = 0.18 * width(v) * (2 * u - 1) ** 2;
    return [x, y - Math.cos(a) * d, z - Math.sin(a) * d];
  };
  return thickSurface(f, nu, nv, (u, v) => th * (1 - 0.7 * v) * (0.45 + 0.55 * (1 - (2 * u - 1) ** 2)));
}

/** Radial instances of a motif standing on a circle of radius r at height z, each facing outward. */
function ring(n, r, z, phase = 0, tilt = 0) {
  return instances(Array.from({ length: n }, (_, k) => {
    const phi = phase + (k * TAU) / n;
    return mat.mul(mat.T(r * Math.cos(phi), r * Math.sin(phi), z), mat.Rz(phi + Math.PI / 2), mat.Rx(tilt));
  }));
}

// ------------------------------------------------------------------------------------------------ finials

/** The turned stem between a socle and the finial body: torus foot, cavetto neck, bead, cup flaring to rCup. Its
 *  foot sits on z0 (sunk OV into the socle), its top at z1. Radii in units of H. */
function stem(H, z0, z1, { foot = 0.15, neck = 0.06, cup = 0.11 } = {}, R) {
  const p = new Prof(foot * H).fillet(0.012)
    .torus(0.045, H)                                  // bulge 0.0225 H (relative heights: bulge set explicitly)
    .fillet(0.008, -0.025 * H)
    .cavetto(-(foot * H - 0.025 * H - neck * H), 0.07, R.q)
    .fillet(0.03)
    .fillet(0.006, 0.01 * H).torus(0.022, H / 0.8, 12).fillet(0.006, -0.01 * H)
    .cavetto(cup * H - neck * H, 0.045, R.q)
    .fillet(0.01);
  return lathe(scaleH(p, z1 - z0 + OV), z0 - OV, R.segs);
}

/** Ball finial: socle 0.20 H high, die 0.42 H wide; necked stem; ball of diameter 0.54 H sunk in the stem's cup. */
function ballFinial(H, R) {
  const { Manifold } = K();
  const hs = 0.2 * H, a = 0.21 * H, rb = 0.27 * H, rc = 0.115 * H;
  const zc = H - rb - Math.sqrt(rb * rb - rc * rc);       // the cup rim meets the ball's surface
  return [
    part('socle', 'stone', socle(a, hs, R.q)),
    part('stem', 'stone', stem(H, hs, zc, { foot: 0.16, neck: 0.065, cup: 0.115 }, R)),
    part('ball', 'stone', Manifold.sphere(rb, R.segs).translate([0, 0, H - rb])),
  ];
}

/**
 * Pineapple (pine-cone) finial: socle 0.18 H; a necked stem whose cup receives the fruit; an ovoid fruit (0.58 H
 * high, greatest diameter 0.40 H at two-fifths of its height) covered with overlapping pointed scales set in
 * phyllotaxis (golden angle: 8 and 13 parastichies); a crown of two tiers of arching leaves.
 */
function pineappleFinial(H, R) {
  const hs = 0.18 * H, a = 0.19 * H, z0 = 0.26 * H, hf = 0.58 * H, rf = 0.2 * H;
  const pk = Math.log(0.5) / Math.log(0.42);
  const rz = (t) => [rf * Math.sin(Math.PI * Math.max(1e-4, t) ** pk) ** 0.72 + 0.0005 * H, z0 + t * hf];
  const prof = [[0, z0]];
  for (let i = 1; i < 48; i++) prof.push(rz(i / 48));
  prof.push([0, z0 + hf]);
  const fruit = revolve(prof, R.segs);
  const n = Math.round(150 * R.k + 20);
  const pts = phyllotaxis(rz, n, 0.07, 0.93);
  const side = pts[0].side;
  const sc = scaleMesh(1.25, 1.35, 0.42, 0.42, R.k > 0.6 ? 14 : 10);
  const scales = instances(pts.map((p) => frame(p.ex, p.ey, p.ez, p.pos, side)));
  const parts = [
    part('socle', 'stone', socle(a, hs, R.q)),
    part('stem', 'stone', stem(H, hs, z0 + 0.05 * H, { foot: 0.15, neck: 0.065, cup: 0.125 }, R)),
    part('fruit', 'stone', fruit),
    part('scale', 'stone', sc, scales),
  ];
  // crown: an inner tier standing up, an outer tier arching out
  // blades thick enough to carve in stone (0.012 H at the root)
  const bl = (len, w, arch, lean) => blade({ len, w, arch, lean, t: 0.012 * H, nv: Math.round(28 * R.k) + 6 });
  const zt = z0 + hf * 0.93;
  parts.push(part('crown-outer', 'stone', bl(0.19 * H, 0.075 * H, 1.1, 0.45), ring(7, 0.035 * H, zt - 0.03 * H, 0)));
  parts.push(part('crown-inner', 'stone', bl(0.17 * H, 0.065 * H, 0.55, 0.12), ring(5, 0.014 * H, zt - 0.01 * H, TAU / 14)));
  return fitHeight(parts, H);
}

/**
 * Acorn finial: socle 0.20 H; stem; a cupule (0.20 H deep, diameter 0.42 H) covered with small pointed scales; the nut
 * (ovoid, widest at the cup's rim, ending in a small point) rising to H.
 */
function acornFinial(H, R) {
  const hs = 0.2 * H, a = 0.17 * H, zc0 = 0.33 * H, hc = 0.2 * H, rc = 0.205 * H;
  const zst = zc0 + 0.02 * H;
  // cupule: a bowl from the stalk to a rounded rim
  const crz = (t) => [0.05 * H + (rc - 0.05 * H) * Math.sin((Math.PI / 2) * t) ** 0.8, zc0 + hc * (1 - Math.cos((Math.PI / 2) * t) ** 1.2)];
  const cupPts = [[0, zc0]];
  for (let i = 0; i <= 32; i++) cupPts.push(crz(i / 32));
  const rimT = 0.024 * H, zr = zc0 + hc;
  for (let i = 1; i <= 8; i++) { const a2 = (i / 8) * Math.PI; cupPts.push([rc - rimT + rimT * Math.cos(a2) * 0.9 + rimT * 0.1, zr + rimT * Math.sin(a2) * 0.8]); }
  cupPts.push([0, zr]);
  const cup = revolve(cupPts, R.segs);
  // nut: widest (0.185 H) at the cup's rim, an elliptic dome above it ending in a small point (mucro)
  const zn0 = zc0 + 0.06 * H, zr0 = zr, rn = 0.185 * H, hm = 0.03 * H;
  const nut = [[0, zn0]];
  for (let i = 0; i <= 10; i++) { const t = i / 10; nut.push([rn * (0.72 + 0.28 * Math.sin((Math.PI / 2) * t)), zn0 + t * (zr0 - zn0)]); }
  const hd = H - hm - zr0;
  for (let i = 1; i <= 32; i++) { const t = i / 32; nut.push([rn * Math.sqrt(Math.max(0, 1 - t ** 2.2)) ** 0.9 + 0.012 * H * t ** 4, zr0 + t * hd]); }
  nut.push([0.006 * H, H - hm * 0.7], [0.0012 * H, H - 0.0005 * H], [0, H]);
  const n = Math.round(90 * R.k + 16);
  const pts = phyllotaxis(crz, n, 0.12, 0.96);
  const sc = scaleMesh(1.35, 1.3, 0.38, 0.22, R.k > 0.6 ? 12 : 8);
  return fitHeight([
    part('socle', 'stone', socle(a, hs, R.q)),
    part('stem', 'stone', stem(H, hs, zst, { foot: 0.14, neck: 0.05, cup: 0.06 }, R)),
    part('cup', 'stone', cup),
    part('scale', 'stone', sc, instances(pts.map((p) => frame(p.ex, p.ey, p.ez, p.pos, p.side)))),
    part('nut', 'stone', revolve(nut, R.segs)),
  ], H);
}

/** A twisted flame: `tongues` sharp licks round a teardrop (widest at a fifth of its height, concave toward the
 *  point), the licks deepening and twisting about three-quarters of a turn as they rise, the tip swaying slightly. */
function flameSolid(h, rmax, R, { turns = 0.75, tongues = 6, base = 0.5 } = {}) {
  const nz = Math.round(64 * R.k) + 16, m = tongues * Math.round(12 * R.k + 6), rings = [], zs = [];
  for (let i = 0; i <= nz; i++) {
    const t = i / nz;
    const env = t < 0.2 ? base + (1 - base) * Math.sin((Math.PI / 2) * (t / 0.2)) : (1 - (t - 0.2) / 0.8) ** 1.35;
    const tw = turns * TAU * t ** 1.3, amp = 0.08 + 0.3 * t ** 0.9;
    const r0 = Math.max(0.004 * rmax, rmax * env), sway = 0.12 * rmax * Math.sin(Math.PI * t) * t;
    rings.push(Array.from({ length: m }, (_, j) => {
      const th = (j * TAU) / m, lick = ((1 + Math.cos(tongues * (th - tw))) / 2) ** 1.8;
      const r = r0 * (1 - amp + 1.6 * amp * lick);
      return [sway + r * Math.cos(th), r * Math.sin(th)];
    }));
    zs.push(t * h);
  }
  return loft(rings, zs);
}

/** Flame finial: socle 0.18 H; a small gadroon-less vase (cup) to 0.42 H; a twisted flame rising from it to H. */
function flameFinial(H, R) {
  const hs = 0.18 * H, a = 0.16 * H;
  const cup = new Prof(0.13 * H).fillet(0.012).torus(0.035, (0.7 * H) / 0.8).fillet(0.006, -0.03 * H)
    .cavetto(-0.045 * H, 0.05, R.q).fillet(0.015)
    .fillet(0.005, 0.008 * H).torus(0.018, H / 0.8, 12).fillet(0.004, -0.004 * H)
    .ovolo(0.095 * H, 0.07, R.q).fillet(0.012).cavetto(-0.03 * H, 0.04, R.q).fillet(0.012, 0.018 * H).fillet(0.004, -0.02 * H);
  const zc = 0.42 * H;
  const zf = zc - 0.04 * H;
  return [
    part('socle', 'stone', socle(a, hs, R.q)),
    part('vase', 'stone', lathe(scaleH(cup, zc - hs + OV), hs - OV, R.segs)),
    part('flame', 'stone', flameSolid(H - zf, 0.135 * H, R).translate([0, 0, zf])),
  ];
}

/** Octagonal section (w across x, t across y, chamfer c) — the section of a chamfered bar. */
function octagon(w, t, c) {
  return [[-w / 2 + c, -t / 2], [w / 2 - c, -t / 2], [w / 2, -t / 2 + c], [w / 2, t / 2 - c], [w / 2 - c, t / 2], [-w / 2 + c, t / 2],
    [-w / 2, t / 2 - c], [-w / 2, -t / 2 + c]];
}

/**
 * Latin cross botonnée in the XZ plane (faces -Y), foot at z = 0, height hc: arms of width w and thickness t with
 * chamfered arrises; the upper and side arms are equal (0.24 hc from the crossing), the foot arm about twice as long;
 * every arm ends in a trefoil of three chamfered bosses.
 */
function crossSolid(hc, w, t, segs) {
  const c = 0.2 * Math.min(w, t), rb = 0.55 * w;
  const arm = 0.24 * hc, zx = hc - arm - w / 2 - 1.6 * rb;   // crossing centre
  const vbar = extrudeXY(octagon(w, t, c), zx + arm + w / 2 + 0.75 * rb);
  const hlen = 2 * arm + w + 1.5 * rb;
  const hbar = extrudeXY(octagon(w, t, c), hlen).transform(mat.Ry(Math.PI / 2)).translate([-hlen / 2, 0, zx]);
  const bossProf = [[0, -t / 2], [rb - c, -t / 2], [rb, -t / 2 + c], [rb, t / 2 - c], [rb - c, t / 2], [0, t / 2]];
  const boss = revolve(bossProf, Math.max(24, segs >> 2)).transform(mat.Rx(Math.PI / 2));
  const bosses = [];
  const trefoil = (tip, d) => {      // tip: centre of the arm's end, d: unit direction of the arm
    const pr = [-d[1], d[0]];
    const c0 = [tip[0] + d[0] * 0.75 * rb, tip[1] + d[1] * 0.75 * rb];
    bosses.push(boss.translate([c0[0], 0, c0[1]]));
    for (const s of [-1, 1]) bosses.push(boss.translate([tip[0] - d[0] * 0.25 * rb + s * pr[0] * 0.95 * rb, 0, tip[1] - d[1] * 0.25 * rb + s * pr[1] * 0.95 * rb]));
  };
  trefoil([0, zx + arm + w / 2], [0, 1]);
  trefoil([arm + w / 2, zx], [1, 0]);
  trefoil([-(arm + w / 2), zx], [-1, 0]);
  return union([vbar, hbar, ...bosses]);
}

/** Cross finial: socle 0.18 H; stem; a ball (diameter 0.26 H); the cross botonnée (0.47 H) set into the ball. */
function crossFinial(H, R) {
  const { Manifold } = K();
  const hs = 0.18 * H, a = 0.15 * H, rb = 0.13 * H, rc = 0.07 * H;
  const zc = 0.33 * H, zb = zc + Math.sqrt(rb * rb - rc * rc);
  const z0 = zb + rb * 0.75;
  return fitHeight([
    part('socle', 'stone', socle(a, hs, R.q)),
    part('stem', 'stone', stem(H, hs, zc, { foot: 0.13, neck: 0.05, cup: 0.07 }, R)),
    part('ball', 'stone', Manifold.sphere(rb, R.segs).translate([0, 0, zb])),
    part('cross', 'stone', crossSolid(H - z0, 0.07 * H, 0.055 * H, R.segs).translate([0, 0, z0])),
  ], H);
}

/** Spike finial: socle 0.20 H; a turned spike — torus foot, vase-shaped boss, a collar, and a slender cone (base
 *  diameter ~0.09 H) girt by two rounded collars at 0.35 and 0.68 of its height, ending in a point. */
function spikeFinial(H, R) {
  const hs = 0.2 * H, a = 0.13 * H;
  const p = new Prof(0.12 * H).fillet(0.015).torus(0.04, H).fillet(0.006, -0.025 * H)
    .cavetto(-0.04 * H, 0.05, R.q).fillet(0.01)
    .ovolo(0.035 * H, 0.04, R.q).cavetto(-0.045 * H, 0.06, R.q)          // a small vase-shaped boss
    .fillet(0.006, 0.006 * H).torus(0.02, H / 0.8, 12).fillet(0.006, -0.006 * H);      // first collar
  const zc = hs + 0.21 * H;
  scaleH(p, zc - hs + OV);
  // the cone: from the first collar to a point at H, girt by two more collars at 0.35 and 0.68 of its height
  const r0 = p.p, zb = zc - hs + OV, hcn = H - zc, cr = 0.011 * H;
  const rad = (z) => r0 * (1 - z / hcn) ** 1.08;
  for (const f of [0.35, 0.68]) {
    const zc2 = f * hcn, r2 = rad(zc2);
    p.to(rad(zc2 - cr) * 1.0, zb + zc2 - cr);
    p.to(r2 + cr * 0.55, zb + zc2 - cr * 0.55).to(r2 + cr, zb + zc2 - cr * 0.15).to(r2 + cr, zb + zc2 + cr * 0.15)
      .to(r2 + cr * 0.55, zb + zc2 + cr * 0.55).to(rad(zc2 + cr), zb + zc2 + cr);
  }
  for (let i = 1; i <= 12; i++) { const z = 0.68 * hcn + cr + (i / 12) * (hcn - 0.68 * hcn - cr); p.to(rad(z), zb + z); }
  return [
    part('socle', 'stone', socle(a, hs, R.q)),
    part('spike', 'stone', revolve(p.toRevolve(0, hs - OV), R.segs)),
  ];
}

// ------------------------------------------------------------------------------------------------ urn

/**
 * Gadrooned bowl: core radius rc(t) over z0..z1 (t = 0..1) with n convex lobes (gadroons) of relative height `amp`,
 * their lower ends fading into the stem and their upper ends rounded off between tipStart and 1.
 */
function gadroonBowl(z0, z1, rc, amp, n, R, tipStart = 0.8) {
  const m = Math.round(10 * R.k) + 5, nz = Math.round(40 * R.k) + 12, P = TAU / n, rings = [], zs = [];
  for (let i = 0; i <= nz; i++) {
    const t = i / nz, z = z0 + t * (z1 - z0), r = rc(t);
    const hw = t <= tipStart ? 1 : Math.sqrt(Math.max(0, 1 - ((t - tipStart) / (1 - tipStart)) ** 2));
    const hwc = Math.max(0.04, hw) * 0.999, A = amp * r * sstep(t / 0.18) * Math.max(hw, 0);
    const pts = [];
    for (let k = 0; k < n; k++) {
      const c = (k + 0.5) * P;
      pts.push([r, c - P / 2]);
      for (let j = 1; j < m; j++) {
        const psi = hwc * (-1 + (2 * (j - 0.5)) / (m - 1)), bump = Math.sqrt(Math.max(0, 1 - (psi / hwc) ** 2));
        pts.push([r + A * bump, c + (psi * P) / 2]);
      }
    }
    rings.push(pts.map(([rr, th]) => [rr * Math.cos(th), rr * Math.sin(th)]));
    zs.push(z);
  }
  return loft(rings, zs);
}

/**
 * A covered urn (vase) of height H on its own square socle, as parts (base centre at the origin). Proportions of the
 * classical covered vase: socle 0.07 H; turned foot (torus, scotia, stem, collar) to 0.19 H; an ovoid body, widest
 * (0.47 H) at 0.42 H where a torus band girds it, its lower half carved with 16 gadroons, its upper half a plain ogee
 * shoulder narrowing to a neck of 0.25 H; ovolo lip; a domed cover with a bead; a knob (bud or flame) rising to H.
 * opts: handles (two scroll handles springing from the neck to the band), knob ('bud' | 'flame'), lobes.
 */
export function urnParts(H, { handles = false, knob = 'bud', lobes = 16, detail = 'high' } = {}) {
  const R = resolution(detail);
  const hs = 0.07 * H, a = 0.135 * H;
  const zf = 0.19 * H, rs = 0.07 * H, zw = 0.42 * H, rw = 0.235 * H, zn = 0.655 * H, rn = 0.125 * H;
  const foot = new Prof(0.145 * H).fillet(0.01).torus(0.035, (0.8 * H) / 0.9).fillet(0.006, -0.028 * H)
    .scotia(0.03, 0.012 * H, -0.01 * H, R.q).fillet(0.004)
    .cavetto(-(0.145 * H - 0.05 * H - rs), 0.035, R.q).fillet(0.01).fillet(0.004, 0.012 * H).torus(0.018, H / 0.9, 12).fillet(0.004, -0.004 * H);
  const footM = lathe(scaleH(foot, zf - hs + OV), hs - OV, R.segs);
  // lower body: gadrooned, core radius from the stem to the belly; gadroons stand out 9 % of the core
  const lower = (t) => rs + (rw - rs) * Math.sin((Math.PI / 2) * t) ** 0.8;
  const bowl = gadroonBowl(zf - 0.006 * H, zw, lower, 0.09, lobes, R, 0.8);
  // upper body: a convex shoulder from the belly to the neck, then neck, lip, cover
  const up = [[0, zw - 0.004 * H]];
  for (let i = 0; i <= 28; i++) { const s = i / 28; up.push([rn + (rw - rn) * 0.5 * (1 + Math.cos(Math.PI * s ** 0.8)), zw + s * (zn - zw)]); }
  const cover = new Prof(rn).fillet(0.015 * H)
    .fillet(0.004 * H, 0.006 * H).ovolo(0.022 * H, 0.026 * H, R.q).fillet(0.008 * H, 0.002 * H)   // lip
    .fillet(0.004 * H, -0.02 * H).fillet(0.006 * H).bead(0.012 * H)                               // cover's rim
    .cavetto(-0.1 * H, 0.07 * H, R.q).fillet(0.008 * H);                                          // the dome
  for (const [p, h] of cover.pts.slice(1)) up.push([p, zn + h]);
  const zt = zn + cover.h;
  up.push([0, zt]);
  const band = lathe(new Prof(rw - 0.002 * H).fillet(0.004 * H, 0.004 * H).torus(0.03 * H, 0.75).fillet(0.004 * H, -0.004 * H), zw - 0.019 * H, R.segs);
  const parts = [
    part('socle', 'stone', socle(a, hs, R.q)),
    part('foot', 'stone', footM),
    part('bowl', 'stone', bowl),
    part('body', 'stone', union([revolve(up, R.segs), band])),
  ];
  const kz = zt - OV, kh = H - kz;
  if (knob === 'flame') {
    parts.push(part('knob', 'stone', union([
      lathe(scaleH(new Prof(0.045 * H).fillet(0.02).torus(0.05, H / 0.9, 12).fillet(0.02), 0.08 * kh), kz, R.segs),
      flameSolid(kh * 0.93, 0.06 * H, R, { tongues: 5 }).translate([0, 0, kz + 0.07 * kh]),
    ])));
  } else {
    // a turned bud: collar and bead, an ovoid, a point (the acorn-like knob of covered vases)
    const b = new Prof(0.05 * H).fillet(0.006 * H).fillet(0.004 * H, -0.012 * H).cavetto(-0.012 * H, 0.012 * H, 6)
      .fillet(0.004 * H, 0.004 * H).bead(0.014 * H).fillet(0.004 * H, -0.006 * H);
    const pts = b.pts.map(([p, h]) => [p, kz + h]), z0 = kz + b.h, hb = H - z0, rb = 0.055 * H;
    for (let i = 1; i <= 28; i++) {
      const t = i / 28;
      const k = t < 0.4 ? 0.45 + 0.55 * Math.sin((Math.PI / 2) * (t / 0.4)) : Math.cos((Math.PI / 2) * ((t - 0.4) / 0.6)) ** 0.7;
      pts.push([Math.max(0.0008 * H, rb * k), z0 + t * hb]);
    }
    parts.push(part('knob', 'stone', revolve([[0, kz], ...pts, [0, H]], R.segs)));
  }
  if (handles) parts.push(part('handle', 'stone', urnHandle(H, R), instances([mat.I(), mat.Rz(Math.PI)])));
  return parts;
}

/** A scroll handle for the urn in the XZ plane (x > 0): springs from the neck with a small outward volute, sweeps out
 *  and down in a C, and dies into the belly band with an inward curl. */
function urnHandle(H, R) {
  const P = (x, z) => [x * H, 0, z * H];
  const bz = (p0, p1, p2, p3, n) => Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, u = 1 - t;
    return [0, 1, 2].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]);
  });
  const spiralAt = (cx, cz, r0, a0, sweep, shrink, n) => Array.from({ length: n }, (_, i) => {
    const t = (i + 1) / n, a = a0 + t * sweep, r = r0 * (1 - shrink * t);
    return P(cx + r * Math.cos(a), cz + r * Math.sin(a));
  });
  // top volute (outward, at the shoulder), then the C down to the band, then an inward curl
  const topCurl = spiralAt(0.235, 0.637, 0.024, Math.PI * 1.5, -1.7 * Math.PI, 0.5, 18).reverse();
  const arc = bz(P(0.235, 0.613), P(0.33, 0.62), P(0.35, 0.5), P(0.275, 0.455), 22);
  const lowCurl = spiralAt(0.275, 0.485, 0.03, -Math.PI / 2, -1.5 * Math.PI, 0.5, 16);
  const neck = bz(P(0.14, 0.6), P(0.18, 0.61), P(0.21, 0.613), P(0.235, 0.613), 8);
  const path = [...topCurl, ...arc, ...lowCurl];
  const stalk = tube(neck, (s) => H * (0.014 + 0.002 * s), Math.max(10, R.segs >> 3));
  return union([tube(path, (s) => H * (0.017 - 0.007 * s), Math.max(12, R.segs >> 3)), stalk]);
}

// ------------------------------------------------------------------------------------------------ obelisk

/**
 * Obelisk of height H. Roman (Sixtine) type: two steps (0.06 H), a moulded pedestal (0.22 H: base, die with sunk
 * panels, cornice), a plinth (0.02 H), four bronze balls under the shaft; the shaft tapers from a base width of 1/10 of
 * its height to 0.7 of that at the top; the pyramidion's faces rise at 60 degrees. Egyptian style, or `pedestal: false`:
 * the shaft on a plain two-course block (0.08 H) — the Egyptian pyramidion gilded (electrum); an Egyptian obelisk asked
 * for explicitly `on a pedestal` gets the Roman pedestal (as the ones re-erected in Rome).
 */
function obeliskParts(spec, R) {
  const { Manifold } = K();
  const H = spec.height, egypt = spec.style === 'egyptian', pedestal = spec.pedestal ?? !egypt;
  const taper = 0.7, tan60 = Math.tan(Math.PI / 3);
  const parts = [];
  const shaftOf = (zs, avail) => {
    // shaft height hs = 10 bw, pyramidion hp = (taper bw / 2) tan 60 -> avail = bw (10 + taper tan60 / 2)
    const bw = avail / (10 + (taper * tan60) / 2), hsft = 10 * bw, tw = taper * bw, hp = avail - hsft;
    const sq = (s) => [[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]];
    const shaft = loft([sq(bw), sq(tw)], [zs, zs + hsft + OV]);
    const pyr = loft([sq(tw), sq(tw * 0.002)], [zs + hsft, zs + avail]);
    return { shaft, pyr, bw };
  };
  if (!pedestal) {
    const hb = 0.08 * H;
    const { shaft, pyr, bw } = shaftOf(hb - OV, H - hb + OV);
    const b1 = 1.0 * bw, b2 = 0.85 * bw;
    parts.push(part('base', 'stone', union([box(-b1, -b1, 0, b1, b1, 0.45 * hb), box(-b2, -b2, 0.45 * hb - OV, b2, b2, hb)])));
    parts.push(part('shaft', 'stone', shaft), part('pyramidion', egypt ? 'accent' : 'stone', pyr));
    return parts;
  }
  const hStep = 0.03 * H, hPed = 0.22 * H, hPl = 0.02 * H, rBall = 0.012 * H;
  const zPed = 2 * hStep, zPl = zPed + hPed, zBall = zPl + hPl, zShaft = zBall + 2 * rBall - 2 * OV;
  const { shaft, pyr, bw } = shaftOf(zShaft, H - zShaft);
  const a = 0.95 * bw;                    // pedestal die half-width (die = 1.9 x the shaft's base width)
  // pedestal: base (plinth, torus, fillet, cyma reversa) 0.16, die 0.64, cornice (bed cyma, corona, cyma recta) 0.20
  const ped = new Prof(0.17 * a).fillet(0.08).torus(0.045, (0.6 * H) / 6).fillet(0.008, -0.05 * a)
    .cymaReversa(-0.09 * a, 0.03, R.q).fillet(0.005, -0.03 * a)
    .fillet(0.64)
    .fillet(0.012, 0.02 * a).cymaReversa(0.07 * a, 0.04, R.q).fillet(0.07, 0.01 * a)
    .cavetto(-0.012 * a, 0.006, 4).cymaRecta(0.11 * a, 0.055, R.q).fillet(0.018, 0.01 * a);
  scaleH(ped, hPed);
  let pedM = squareLoft(ped, a, zPed);
  // sunk panels on the four faces of the die, a fillet's width inside its edges
  const zd0 = zPed + 0.18 * hPed, zd1 = zPed + 0.76 * hPed, pi = 0.78 * a, dep = 0.035 * a;
  const cut = [0, 1, 2, 3].map((k) => box(-pi, -a - 1, zd0, pi, -a + dep, zd1).transform(mat.Rz((k * Math.PI) / 2)));
  pedM = pedM.subtract(union(cut));
  const tread = 0.045 * H, s1 = a + 0.17 * a + 2 * tread, s2 = a + 0.17 * a + tread;
  parts.push(part('steps', 'stone', union([box(-s1, -s1, 0, s1, s1, hStep), box(-s2, -s2, hStep - OV, s2, s2, 2 * hStep + OV)])));
  parts.push(part('pedestal', 'stone', pedM));
  // plinth under the balls: a block with a small cavetto and fillet at its head
  const pl = new Prof(0).fillet(0.7).cavetto(0.06 * bw, 0.2, 6).fillet(0.1);
  parts.push(part('plinth', 'stone', squareLoft(scaleH(pl, hPl + OV), 0.62 * bw, zPl - OV)));
  const bx = bw / 2 - 1.15 * rBall;
  parts.push(part('ball', 'metal', Manifold.sphere(rBall, Math.max(24, R.segs >> 1)),
    instances([[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([sx, sy]) => mat.T(sx * bx, sy * bx, zBall + rBall - OV)))));
  parts.push(part('shaft', 'stone', shaft), part('pyramidion', 'stone', pyr));
  return parts;
}

// ------------------------------------------------------------------------------------------------ assembly

export function build(spec) {
  const R = resolution(spec.detail), H = spec.height;
  if (spec.element === 'obelisk') return obeliskParts(spec, R);
  if (spec.element === 'urn') {
    const knob = spec.finial === 'flame' ? 'flame' : 'bud';
    return urnParts(H, { handles: true, knob, detail: spec.detail });
  }
  const kind = FINIALS.includes(spec.finial) ? spec.finial : 'pineapple';
  switch (kind) {
    case 'ball': return ballFinial(H, R);
    case 'acorn': return acornFinial(H, R);
    case 'urn': return urnParts(H, { handles: false, knob: 'bud', detail: spec.detail });
    case 'flame': return flameFinial(H, R);
    case 'cross': return crossFinial(H, R);
    case 'spike': return spikeFinial(H, R);
    default: return pineappleFinial(H, R);
  }
}

/** What the generator promises: the requested height, exactly. */
export function expected(spec) {
  return { size: { z: spec.height }, counts: {}, tol: 0.005 };
}
