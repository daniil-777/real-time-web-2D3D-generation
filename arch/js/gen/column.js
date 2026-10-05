// Columns after Vignola: pedestal, base, shaft (entasis, flutes with spoon ends, reeds, twist), capital of every order;
// also pilasters and the capital / base / pedestal on their own. Z-up, metres, base centre at the origin, front -Y.

import { ORDERS, columnDims } from '../orders.js';
import { K, TAU, mat, revolve, loft, box, union, part, radial, instances, tube, extrudeXY, memo } from '../kernel.js';
import { Prof } from '../profiles.js';
import { acanthusLeaf, voluteScroll, eggAndDart, rosette, extrudeElevation } from '../ornament.js';

export const ELEMENTS = ['column', 'pilaster', 'capital', 'base', 'pedestal'];

const sstep = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const segsFor = (detail) => (detail === 'low' ? 48 : detail === 'medium' ? 96 : 144);

/** Column dimensions for any element of this family (height means the element's own height). */
export function dimsFor(spec) {
  const o = ORDERS[spec.order] || ORDERS.tuscan;
  const ped = spec.element === 'pedestal' || ((spec.element === 'column' || spec.element === 'pilaster') && spec.pedestal);
  let opts = { diameter: spec.diameter, pedestal: ped };
  if (spec.height) {
    if (spec.element === 'column' || spec.element === 'pilaster') opts.height = spec.height / (ped ? 4 / 3 : 1);
    else if (spec.element === 'capital' && o.capD) opts.diameter = spec.height / o.capD;
    else if (spec.element === 'base' && o.baseD) opts.diameter = spec.height / o.baseD;
    else if (spec.element === 'pedestal') opts.height = spec.height * 3;
  }
  return columnDims(spec.order, opts);
}

// ------------------------------------------------------------------------------------------------ bases

/** Base profile (revolve) for the order; returns { parts, h, half } with the plinth half-width. */
function baseParts(kind, d, segs, style) {
  const { D } = d, R = D / 2;
  if (kind === 'none' || !d.base) return { parts: [], h: 0, half: R };
  const H = d.base;
  if (style === 'gothic') {
    const ph = H * 0.45, half = 0.62 * D;
    const oct = Array.from({ length: 8 }, (_, i) => [half * Math.cos((i + 0.5) * TAU / 8), half * Math.sin((i + 0.5) * TAU / 8)]);
    const plinth = extrudeXY(oct, ph);
    const mould = revolve(new Prof(0.56 * D).fillet(0.04 * H).torus(0.22 * H, 0.8).fillet(0.04 * H, -0.06 * D).scotia(0.12 * H, 0.03 * D)
      .torus(0.13 * H, 0.8).toRevolve(0, ph - 0.001), segs);
    return { parts: [part('base', 'stone', union([plinth, mould]))], h: H, half };
  }
  if (style === 'stepped') {
    const s = [0.68, 0.62, 0.56].map((k) => k * D), hh = H / 3;
    const steps = s.map((a, i) => box(-a, -a, i * hh - (i ? 0.001 : 0), a, a, (i + 1) * hh));
    return { parts: [part('base', 'stone', union(steps))], h: H, half: s[0] };
  }
  if (style === 'disc') {
    return { parts: [part('base', 'stone', revolve(new Prof(0.72 * D).fillet(H * 0.8).ovolo(-0.04 * D, H * 0.2, 6).toRevolve(), segs))], h: H, half: 0.72 * D };
  }
  if (kind === 'tuscan') {
    const p = new Prof(0.66 * D).fillet(0.5 * H).out(-0.11 * D).torus(0.38 * H, 1.6).out(-0.02 * D).fillet(0.06 * H).cavetto(-0.03 * D, 0.06 * H);
    scaleH(p, H);
    return { parts: [part('base', 'stone', revolve(p.toRevolve(), segs))], h: H, half: 0.66 * D };
  }
  // Attic base: square plinth, lower torus, fillet, scotia, fillet, upper torus, fillet, apophyge
  const plH = H / 3, half = 0.67 * D;
  const p = new Prof(0.605 * D).torus(0.125 * D, 1).out(-0.035 * D).fillet(0.018 * D).scotia(0.085 * D, 0.045 * D, 0.012 * D)
    .fillet(0.014 * D).out(-0.006 * D).torus(0.082 * D, 1).out(-0.04 * D).fillet(0.018 * D).cavetto(-(R * 1.044 - R), 0.035 * D);
  scaleH(p, H - plH);
  const ring = revolve(p.toRevolve(0, plH - 0.001), segs);
  const plinth = box(-half, -half, 0, half, half, plH);
  return { parts: [part('base', 'stone', union([plinth, ring]))], h: H, half };
}

function scaleH(p, H) { const h = p.h; for (const q of p.pts) q[1] *= H / h; }

// ------------------------------------------------------------------------------------------------ shaft

/** Radius envelope of the shaft at height z (apophyge at the foot, entasis from the lower third, fillet under the top). */
function envelope(d, entasis, z) {
  const { shaft: Hs, D } = d, R = D / 2, Rt = d.top / 2;
  let r;
  if (entasis) r = z < Hs / 3 ? R : R - (R - Rt) * (1 - Math.cos((Math.PI / 2) * ((z - Hs / 3) / ((2 * Hs) / 3))));
  else r = R + (Rt - R) * (z / Hs);
  const a = 0.075 * D, t = 0.05 * D;
  if (z < a) r += 0.04 * D * (1 - z / a) ** 2;
  if (z > Hs - t) r += 0.025 * D * (1 - (Hs - z) / t) ** 2;
  return r;
}

/** z samples: dense in the ends (flute terminations and flares), even in between. */
function zSamples(Hs, D, n = 64) {
  // clamp, never filter: a rounded top sample a hair above Hs must still give the top ring
  const zs = new Set(), add = (z) => zs.add(+Math.min(Hs, Math.max(0, z)).toFixed(7));
  for (let i = 0; i <= n; i++) add((i / n) * Hs);
  for (let i = 0; i <= 24; i++) { const e = (i / 24) * 0.22 * D; add(e); add(Hs - e); }
  zs.add(Hs);
  return [...zs].sort((a, b) => a - b).filter((z, i, a) => i === 0 || z - a[i - 1] > 1e-7);
}

/**
 * Shaft rings with flutes. kind: 'arris' (flutes meet in sharp edges), 'fillet' (semicircular flutes with fillets),
 * 'reed' (convex reeds). Flutes end in quarter-sphere "spoons" below the top and above the foot.
 */
function flutedShaft(d, n, kind, entasis) {
  const { shaft: Hs, D } = d;
  const P = TAU / n, fil = kind === 'fillet' ? 0.25 : 0;
  const hw = (P * (1 - fil)) / 2;                       // flute half width (radians)
  const depthK = kind === 'arris' ? (d.o.label === 'Greek Doric' ? 0.32 : 0.45) : kind === 'reed' ? 0.5 : 1;
  const m = kind === 'fillet' ? 11 : 13;                // samples across one flute
  const zf0 = 0.09 * D, zf1 = Hs - 0.065 * D;           // flutes run between these
  const zs = zSamples(Hs, D);
  const rings = zs.map((z) => {
    const r = envelope(d, entasis, z), rf = hw * r;     // flute radius (m)
    const q0 = (z - zf0) / rf, q1 = (zf1 - z) / rf;
    const qa = Math.min(1, q0, q1);
    const g = kind === 'reed' ? (z < zf0 || z > zf1 ? 0 : Math.min(1, Math.min(z - zf0, zf1 - z) / (0.06 * D)))
      : qa <= 0 ? 0 : Math.sqrt(1 - (1 - qa) ** 2);
    const ring = [];
    for (let k = 0; k < n; k++) {
      const c = k * P + P / 2;
      if (fil) ring.push(c - P / 2);
      for (let j = 0; j < m; j++) {
        if (!fil && j === 0) { ring.push(c - P / 2); continue; }
        const s = -1 + (2 * j) / (m - 1);
        ring.push(c + s * hw * (fil ? Math.max(g, 1e-3) : 1));
      }
      if (fil) ring.push(c + P / 2 - 1e-6);
    }
    return ring.map((th) => {
      const k = Math.floor(th / P), c = k * P + P / 2, psi = th - c;
      const w = hw * (kind === 'fillet' ? Math.max(g, 1e-3) : 1);
      const u = Math.abs(psi) / w;
      const bowl = u < 1 ? Math.sqrt(1 - u * u) : 0;
      const rr = kind === 'reed' ? r - depthK * rf * (1 - bowl) * g - 0.002 * D : r - depthK * rf * g * bowl;
      return [rr * Math.cos(th), rr * Math.sin(th)];
    });
  });
  return loft(rings, zs);
}

function plainShaft(d, entasis, segs) {
  const zs = zSamples(d.shaft, d.D, 48);
  return revolve([[0, 0], ...zs.map((z) => [envelope(d, entasis, z), z]), [0, d.shaft]], segs);
}

function solomonicShaft(d, turns = 3) {
  const { shaft: Hs, D } = d, R = D / 2, e = 0.16 * R, n = 96, rings = [], zs = [];
  const N = Math.round(turns * 72);
  for (let i = 0; i <= N; i++) {
    const z = (i / N) * Hs, env = envelope(d, true, z), rc = env - e, tau = (TAU * turns * z) / Hs;
    const fade = sstep(z / (0.12 * D)) * sstep((Hs - z) / (0.12 * D));
    const cx = e * fade * Math.cos(tau), cy = e * fade * Math.sin(tau), rr = rc + e * (1 - fade);
    rings.push(Array.from({ length: n }, (_, j) => {
      const ph = (j * TAU) / n, rib = rr * (1 + 0.06 * fade * Math.cos(4 * (ph - tau)));
      return [cx + rib * Math.cos(ph), cy + rib * Math.sin(ph)];
    }));
    zs.push(z);
  }
  return loft(rings, zs);
}

function clusteredShaft(d, segs) {
  const { shaft: Hs, D } = d;
  const core = revolve([[0, 0], [0.36 * D, 0], [0.36 * D, Hs], [0, Hs]], segs);
  const shafts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * TAU) / 8, big = i % 2 === 0, r = big ? 0.15 * D : 0.085 * D, at = big ? 0.36 * D : 0.4 * D;
    shafts.push(revolve([[0, 0], [r, 0], [r, Hs], [0, Hs]], 40).translate([at * Math.cos(a), at * Math.sin(a), 0]));
  }
  return union([core, ...shafts]);
}

function shaftParts(spec, d, segs) {
  const o = d.o, entasis = spec.entasis !== false && o.classical;
  const n = spec.flutes ?? o.flutes;
  if (spec.order === 'solomonic') return [part('shaft', 'stone', solomonicShaft(d), null, { flutes: 0, twist: 3 })];
  if (spec.order === 'gothic') return [part('shaft', 'stone', clusteredShaft(d, segs), null, { flutes: 0 })];
  if (n > 0) {
    const kind = o.flute === 'reed' ? 'reed' : o.flute === 'arris' ? 'arris' : 'fillet';
    return [part('shaft', 'stone', flutedShaft(d, n, kind, entasis), null, { flutes: n, kind })];
  }
  return [part('shaft', 'stone', plainShaft(d, entasis, segs), null, { flutes: 0 })];
}

/** Astragal at the top of the shaft (bead + fillet), base of the capital zone. */
function astragal(d, segs) {
  const { D } = d, r = d.top / 2;
  return revolve(new Prof(r).fillet(0.018 * D, 0.012 * D).bead(0.05 * D).toRevolve(0, -0.068 * D), segs);
}

// ------------------------------------------------------------------------------------------------ capitals

function squareRings(prof, z0 = 0) { const { rings, zs } = prof.toRings(0, 0, z0); return loft(rings, zs); }

function tuscanCapital(d, segs) {
  const { D, cap: c } = d, rt = d.top / 2;
  const ring = new Prof(rt).fillet(c / 3).fillet(0.03 * D, 0.03 * D).ovolo(0.58 * D - rt - 0.03 * D, c / 3 - 0.03 * D);
  const echinus = revolve(ring.toRevolve(), segs);
  const abacus = box(-0.6 * D, -0.6 * D, (2 * c) / 3 - 0.001, 0.6 * D, 0.6 * D, c);
  return [part('capital', 'stone', union([echinus, abacus]))];
}

function doricCapital(d, segs) {
  const { D, cap: c } = d, rt = d.top / 2;
  const p = new Prof(rt).fillet(c * 0.33);
  for (let i = 0; i < 3; i++) p.out(0.008 * D).fillet(0.018 * D);
  p.ovolo(0.565 * D - p.p, c * 0.25);
  const echinus = revolve(p.toRevolve(), segs);
  const z0 = p.h - 0.001, ah = c - z0;
  const ab = new Prof(0.585 * D).fillet(ah * 0.62).cymaReversa(0.025 * D, ah * 0.26).fillet(ah * 0.12, 0.005 * D);
  return [part('capital', 'stone', union([echinus, squareRings(ab, z0)]))];
}

function greekDoricCapital(d, segs) {
  const { D, cap: c } = d, rt = d.top / 2;
  const p = new Prof(rt);
  for (let i = 0; i < 4; i++) p.out(0.006 * D).fillet(0.012 * D);
  p.slope(0.13 * D, c * 0.36).ovolo(0.62 * D - rt - 0.024 * D - 0.13 * D, c * 0.3);
  const echinus = revolve(p.toRevolve(), segs);
  const z0 = p.h - 0.001;
  return [part('capital', 'stone', union([echinus, box(-0.64 * D, -0.64 * D, z0, 0.64 * D, 0.64 * D, c)]))];
}

/** Ionic: echinus with egg-and-dart, canalis and two volutes on a waisted bolster, moulded abacus. */
function ionicCapital(d, segs) {
  const { D, cap: c } = d, rt = d.top / 2;
  const A = 1.12 * D, abH = 0.065 * D, zab = c - abH;
  const r0 = 0.21 * D, xe = A / 2 - 0.85 * r0, ze = zab - 0.98 * r0, depth = 0.92 * A;
  const echH = 0.13 * D, echR = 0.53 * D;
  const ech = revolve(new Prof(rt).ovolo(echR - rt, echH).fillet(0.012 * D).toRevolve(0, zab - 0.2 * D), segs);
  // canalis band joining the volutes, its lower edge sagging between them
  const sag = Array.from({ length: 25 }, (_, i) => { const x = -xe + (2 * xe * i) / 24; return [x, zab - 0.42 * r0 - 0.18 * r0 * Math.cos((Math.PI * x) / (2 * xe))]; });
  const band = extrudeElevation([[-xe, zab + 0.002], ...sag.reverse().map(([x, z]) => [x, z]).reverse(), [xe, zab + 0.002]].reverse(), depth * 0.985, -(depth * 0.985) / 2);
  const listel = tube(sag.map(([x, z]) => [x, -(depth * 0.985) / 2 - 0.004 * D, z]), 0.011 * D, 8);
  const listelB = tube(sag.map(([x, z]) => [x, (depth * 0.985) / 2 + 0.004 * D, z]), 0.011 * D, 8);
  const vR = voluteScroll({ r0, depth, side: 1 }).translate([xe, 0, ze]);
  const vL = voluteScroll({ r0, depth, side: -1 }).translate([-xe, 0, ze]);
  const ab = new Prof(A / 2 - 0.02 * D).fillet(abH * 0.45).ovolo(0.02 * D, abH * 0.55, 8);
  const abacus = squareRings(ab, zab);
  const body = union([ech, band, listel, listelB, vR, vL, abacus]);
  // egg-and-dart on the echinus: 24 around, tilted with the ovolo
  const { egg, dart } = eggAndDart({ h: 0.085 * D, w: 0.07 * D, d: 0.04 * D });
  const ze0 = zab - 0.2 * D + echH * 0.5, re0 = rt + (echR - rt) * 0.62;
  const tilt = mat.Rx(-0.55);
  const eggs = radial(24, mat.mul(mat.T(0, -re0, ze0), tilt), Math.PI / 24);
  const darts = radial(24, mat.mul(mat.T(0, -re0 - 0.004 * D, ze0), tilt), 0);
  return [part('capital', 'stone', body), part('egg', 'stone', egg, eggs), part('dart', 'stone', dart, darts)];
}

/** Concave-sided abacus with cut horns (Corinthian, Composite). */
function concaveAbacus(D, z0, h, segs) {
  const half = 0.72 * D, sag = 0.11 * D, cut = 0.06 * D;
  const ringAt = (off) => {
    const pts = [], s = half + off;
    for (let side = 0; side < 4; side++) {
      const a = (side * Math.PI) / 2;
      for (let i = 0; i <= 16; i++) {
        const t = -1 + (2 * i) / 16;                       // along the side, -1..1
        const along = t * (s - cut), inward = sag * (1 - t * t);
        const x = s - inward, y = along;
        pts.push([x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]);
      }
    }
    return pts;
  };
  const p = new Prof(-0.035 * D).cavetto(0.02 * D, h * 0.3, 4).fillet(h * 0.15).ovolo(0.03 * D, h * 0.4, 5).fillet(h * 0.15);
  scaleH(p, h);
  return loft(p.pts.map(([off]) => ringAt(off)), p.pts.map(([, hh]) => z0 + hh));
}

function bell(d, top, segs, flare = 0.5) {
  const { D } = d, rt = d.top / 2;
  const pts = [[0, 0]];
  for (let i = 0; i <= 24; i++) { const t = i / 24; pts.push([rt + (flare * D - rt) * t ** 2.2, t * top]); }
  pts.push([flare * D + 0.03 * D, top], [flare * D + 0.03 * D, top + 0.03 * D], [0, top + 0.03 * D]);
  return revolve(pts, segs);
}

function leafRows(d, rows) {
  const out = [];
  for (const r of rows) {
    const leaf = acanthusLeaf({ h: r.h, w: r.w, lobes: r.lobes || 4, curl: r.curl ?? 1, lean: r.lean ?? 0.14, wrap: r.wrap });
    const xf = [];
    for (let k = 0; k < 8; k++) {
      const phi = r.phase + (k * TAU) / 8;
      xf.push(mat.mul(mat.T(r.rad * Math.cos(phi), r.rad * Math.sin(phi), r.z), mat.Rz(phi + Math.PI / 2)));
    }
    out.push(part(r.name, 'stone', leaf, instances(xf)));
  }
  return out;
}

/** Corinthian: bell, two rows of eight acanthus, caulicoli, corner volutes and inner helices, concave abacus, fleurons. */
function corinthianCapital(d, segs, composite = false) {
  const { D, cap: c } = d, rt = d.top / 2;
  const abH = c / 7, zab = c - abH;
  const parts = [part('bell', 'stone', bell(d, zab, segs))];
  parts.push(part('abacus', 'stone', concaveAbacus(D, zab - 0.001, abH, segs)));
  if (!composite) {
    parts.push(...leafRows(d, [
      { name: 'leaf-lower', h: 0.36 * c, w: 0.44 * D, phase: TAU / 16, rad: rt - 0.004 * D, z: 0, wrap: 0.48 * D, lean: 0.16 },
      { name: 'leaf-upper', h: 0.64 * c, w: 0.42 * D, phase: 0, rad: rt - 0.02 * D, z: 0.02 * c, wrap: 0.5 * D, lean: 0.1, lobes: 5 },
    ]));
    // caulicoli (stalks) between the upper leaves, with a collar
    const stalk = union([
      tube([[0, 0, 0], [0, -0.03 * D, 0.1 * c], [0, -0.05 * D, 0.17 * c]], (s) => 0.04 * D * (1 - 0.2 * s), 12),
      revolve(new Prof(0.045 * D).torus(0.025 * D).toRevolve(), 24).translate([0, -0.05 * D, 0.165 * c]),
    ]);
    const cx = [];
    for (let k = 0; k < 8; k++) {
      const phi = TAU / 16 + (k * TAU) / 8;
      cx.push(mat.mul(mat.T((rt + 0.03 * D) * Math.cos(phi), (rt + 0.03 * D) * Math.sin(phi), 0.46 * c), mat.Rz(phi + Math.PI / 2)));
    }
    parts.push(part('caulicolus', 'stone', stalk, instances(cx)));
    // per face: two corner volutes in the face plane curling out under the horns, two inner helices curling toward
    // the fleuron, each a carved scroll on a stalk springing from a caulicolus; the four faces are instances
    const zTop = zab - 0.006 * D, faceY = -0.5 * D, cR = rt + 0.03 * D;
    const cTop = [cR * Math.sin(TAU / 16), -cR * Math.cos(TAU / 16), 0.46 * c + 0.17 * c];   // caulicolus top (right)
    const vr = 0.085 * D, hr = 0.045 * D;
    const corner = voluteScroll({ r0: vr, depth: 0.05 * D, side: 1, pinch: 0, eye: 0.16, turns: 2.2, channel: 0.3 });
    const innerS = voluteScroll({ r0: hr, depth: 0.04 * D, side: -1, pinch: 0, eye: 0.2, turns: 1.8, channel: 0.3 });
    const vx = 0.62 * D, vy = faceY - 0.1 * D, vz = zTop - vr * 0.98;
    const ix = 0.075 * D, iy = faceY - 0.035 * D, iz = zTop - hr * 1.1;
    const bez = (p0, p1, p2, p3, n = 16) => Array.from({ length: n + 1 }, (_, i) => {
      const t = i / n, u = 1 - t;
      return [0, 1, 2].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]);
    });
    const stalkC = bez(cTop, [cTop[0] + 0.1 * D, cTop[1] - 0.05 * D, cTop[2] + 0.12 * c], [vx - 0.08 * D, vy + 0.02 * D, zTop - 0.02 * D], [vx - 0.02 * D, vy, zTop - 0.012 * D]);
    const stalkI = bez(cTop, [cTop[0] - 0.02 * D, cTop[1] - 0.03 * D, cTop[2] + 0.1 * c], [ix + 0.06 * D, iy, zTop - 0.02 * D], [ix + 0.01 * D, iy, zTop - 0.012 * D]);
    const half = [
      corner.translate([vx, vy, vz]),
      innerS.translate([ix, iy, iz]),
      tube(stalkC, (s) => 0.03 * D * (1 - 0.35 * s), 10),
      tube(stalkI, (s) => 0.022 * D * (1 - 0.35 * s), 8),
    ];
    const face = union([...half, ...half.map((m) => m.mirror([1, 0, 0]))]);
    parts.push(part('volute', 'stone', face, instances([0, 1, 2, 3].map((k) => mat.Rz((k * Math.PI) / 2)))));
  } else {
    parts.push(...leafRows(d, [
      { name: 'leaf-lower', h: 0.33 * c, w: 0.44 * D, phase: TAU / 16, rad: rt - 0.004 * D, z: 0, wrap: 0.48 * D, lean: 0.16 },
      { name: 'leaf-upper', h: 0.56 * c, w: 0.42 * D, phase: 0, rad: rt - 0.02 * D, z: 0.02 * c, wrap: 0.5 * D, lean: 0.1, lobes: 5 },
    ]));
    // Ionic part: echinus with eggs, four diagonal volutes under the horns
    const ze = 0.6 * c, echR = 0.56 * D, echH = 0.12 * c;
    parts.push(part('echinus', 'stone', revolve(new Prof(0.5 * D).ovolo(echR - 0.5 * D, echH).fillet(0.02 * D).toRevolve(0, ze), segs)));
    const { egg, dart } = eggAndDart({ h: 0.08 * D, w: 0.065 * D, d: 0.035 * D });
    parts.push(part('egg', 'stone', egg, radial(28, mat.mul(mat.T(0, -(0.5 * D + (echR - 0.5 * D) * 0.6), ze + echH * 0.5), mat.Rx(-0.5)), Math.PI / 28)));
    parts.push(part('dart', 'stone', dart, radial(28, mat.mul(mat.T(0, -(0.5 * D + (echR - 0.5 * D) * 0.6) - 0.004 * D, ze + echH * 0.5), mat.Rx(-0.5)))));
    // a thick scroll backed onto the echinus (Vignola's angular volute), not a disc hanging from the abacus horn
    const r0 = 0.2 * D, vol = voluteScroll({ r0, depth: 0.17 * D, side: 1, pinch: 0, turns: 2.5 });
    const vs = [];
    for (let k = 0; k < 4; k++) {
      const phi = Math.PI / 4 + (k * Math.PI) / 2, rad = 0.66 * D;
      // scroll seen from the diagonal: its plane faces outward along phi
      vs.push(mat.mul(mat.T(rad * Math.cos(phi), rad * Math.sin(phi), zab - r0 * 0.95), mat.Rz(phi - Math.PI / 2)));
    }
    parts.push(part('volute', 'stone', vol.translate([-0.02 * D, 0, 0]), instances(vs)));
  }
  // fleurons on the abacus faces
  const fl = rosette(0.075 * D, 8);
  parts.push(part('fleuron', 'stone', fl, instances([0, 1, 2, 3].map((k) => mat.mul(mat.Rz(-Math.PI / 2 + (k * Math.PI) / 2),
    mat.T(0, -(0.61 * D + 0.01 * D), zab + abH * 0.45), mat.Rx(0)))).map((x) => x)));
  return parts;
}

function cushionCapital(d, segs) {
  const { D, cap: c } = d, R = D / 2;
  const abH = 0.14 * c, top = c - abH, half = 0.6 * D;
  const rs = Math.hypot(half, half);
  const depth = Math.sqrt(Math.max(1e-6, rs * rs - R * R));
  const { Manifold } = K();
  const cube = box(-half, -half, top - depth, half, half, top);
  const cushion = cube.intersect(Manifold.sphere(rs, segs).translate([0, 0, top]));
  const neck = revolve([[0, 0], [R, 0], [R, top - depth + 0.002], [0, top - depth + 0.002]], segs);
  const abacus = loft(new Prof(half * 0.98).slope(0.06 * D, abH * 0.6).fillet(abH * 0.4).toRings(0, 0).rings, new Prof(0).slope(0, abH * 0.6).fillet(abH * 0.4).pts.map(([, h]) => top - 0.001 + h));
  return [part('capital', 'stone', union([neck, cushion, abacus]))];
}

function papyrusCapital(d, segs) {
  const { D, cap: c } = d, rt = d.top / 2, n = 16, m = 128, rings = [], zs = [];
  const topR = 0.82 * D;
  for (let i = 0; i <= 32; i++) {
    const t = i / 32, z = t * c * 0.86;
    const r = rt + (topR - rt) * (t ** 1.8);
    rings.push(Array.from({ length: m }, (_, j) => {
      const th = (j * TAU) / m, rib = 1 - 0.07 * t * (1 - Math.abs(Math.cos((n * th) / 2)) ** 0.6);
      return [r * rib * Math.cos(th), r * rib * Math.sin(th)];
    }));
    zs.push(z);
  }
  const bellM = loft(rings, zs);
  const bands = [0, 1, 2, 3, 4].map((i) => revolve(new Prof(rt).bead(0.035 * D).toRevolve(0, -0.22 * D + i * 0.036 * D), segs));
  const abacus = box(-0.3 * D, -0.3 * D, c * 0.86 - 0.002, 0.3 * D, 0.3 * D, c);
  return [part('capital', 'stone', union([bellM, abacus, ...bands]))];
}

function decoCapital(d) {
  const { D, cap: c } = d, hh = c / 3, s = [0.5, 0.56, 0.64].map((k) => k * D);
  const slabs = s.map((a, i) => box(-a, -a, i * hh - (i ? 0.001 : 0), a, a, (i + 1) * hh));
  const grooves = [];
  for (let i = -2; i <= 2; i++) for (let k = 0; k < 4; k++) {
    grooves.push(box(i * 0.12 * D - 0.015 * D, -s[1] - 0.01, hh * 1.15, i * 0.12 * D + 0.015 * D, -s[1] + 0.02 * D, hh * 1.85).rotate([0, 0, k * 90]));
  }
  return [part('capital', 'stone', union(slabs).subtract(union(grooves)))];
}

function gothicCapital(d, segs) {
  const { D, cap: c } = d, out = [];
  const one = (r) => revolve(new Prof(r).fillet(c * 0.1).cavetto(r * 0.5, c * 0.45, 8).fillet(c * 0.1).ovolo(r * 0.12, c * 0.15, 5).toRevolve(), 32);
  out.push(revolve(new Prof(0.36 * D).fillet(c * 0.1).cavetto(0.14 * D, c * 0.55, 10).toRevolve(), segs));
  for (let i = 0; i < 8; i++) {
    const a = (i * TAU) / 8, big = i % 2 === 0, r = big ? 0.15 * D : 0.085 * D, at = big ? 0.36 * D : 0.4 * D;
    out.push(one(r).translate([at * Math.cos(a), at * Math.sin(a), 0]));
  }
  const half = 0.66 * D, oct = Array.from({ length: 8 }, (_, i) => [half * Math.cos((i + 0.5) * TAU / 8), half * Math.sin((i + 0.5) * TAU / 8)]);
  out.push(extrudeXY(oct, c * 0.2 + 0.004 * D).translate([0, 0, c * 0.8 - 0.004 * D]));
  // Early English stiff-leaf: a tight curling leaf on each shaft's bell, turning out under the abacus
  const leaf = acanthusLeaf({ h: c * 0.62, w: 0.2 * D, lobes: 3, curl: 0.95, lean: 0.32, wrap: 0.12 * D });
  const xf = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * TAU) / 8, big = i % 2 === 0, at = (big ? 0.36 : 0.4) * D + (big ? 0.15 : 0.085) * D * 0.98;
    xf.push(mat.mul(mat.T(at * Math.cos(a), at * Math.sin(a), c * 0.1), mat.Rz(a + Math.PI / 2), mat.S(big ? 0.9 : 0.6)));
  }
  return [part('capital', 'stone', union(out)), part('leaf', 'stone', leaf, instances(xf))];
}

function capitalParts(spec, d, segs) {
  switch (spec.order) {
    case 'tuscan': return tuscanCapital(d, segs);
    case 'doric': return doricCapital(d, segs);
    case 'greek-doric': return greekDoricCapital(d, segs);
    case 'ionic': return ionicCapital(d, segs);
    case 'corinthian': case 'solomonic': return corinthianCapital(d, segs);
    case 'composite': return corinthianCapital(d, segs, true);
    case 'romanesque': return cushionCapital(d, segs);
    case 'egyptian': return papyrusCapital(d, segs);
    case 'art-deco': return decoCapital(d);
    case 'gothic': return gothicCapital(d, segs);
    default: {
      // modern: a plain cap plate (on its own a capital still has to be something)
      const h = Math.max(d.cap, 0.06 * d.D);
      return d.cap > 0 || spec.element === 'capital' ? [part('capital', 'stone', box(-0.55 * d.D, -0.55 * d.D, 0, 0.55 * d.D, 0.55 * d.D, h))] : [];
    }
  }
}

// ------------------------------------------------------------------------------------------------ pedestal

function pedestalParts(d, half) {
  // Vignola's pedestal: base (plinth, torus, cyma reversa), die, and a cornice that projects about its own height
  // (cyma reversa, corona with drip, cymatium)
  const P = d.ped, a = half, D = d.D;
  const baseH = 0.13 * P, capH = 0.1 * P, k = baseH;
  const base = new Prof(0.13 * D).fillet(k * 0.42).torus(k * 0.18, 0.7).fillet(k * 0.06, -0.03 * D)
    .cymaReversa(-0.08 * D, k * 0.26).fillet(k * 0.08, -0.01 * D);
  const die = new Prof(0).fillet(P - baseH - capH + 0.002);
  const c = capH;
  const cap = new Prof(0).fillet(c * 0.06, 0).bead(c * 0.08).cymaReversa(0.06 * D, c * 0.22).fillet(c * 0.3, 0.035 * D)
    .cavetto(-0.012 * D, c * 0.06, 4).cymaRecta(0.04 * D, c * 0.22).fillet(c * 0.06, 0.004 * D).out(-0.137 * D);
  const m = (p, z0) => { const { rings, zs } = p.toRings(a, a, z0); return loft(rings, zs); };
  return [part('pedestal', 'stone', union([m(base, 0), m(die, baseH - 0.001), m(cap, P - capH)]))];
}

// ------------------------------------------------------------------------------------------------ pilaster

function pilasterParts(spec, d) {
  const { D, shaft: Hs } = d, w = D / 2, dep = 0.16 * D;
  const n = spec.flutes ? Math.min(spec.flutes, 9) : 0;
  let shaft = box(-w, -dep, 0, w, dep, Hs);
  if (n) {
    // flutes cut into the face as capsules: semicircular section, rounded (spoon) ends
    const { Manifold } = K();
    const fw = (2 * w * 0.86) / n, fr = fw * 0.38, z0 = 0.09 * D + fr, z1 = Hs - 0.065 * D - fr;
    const caps = [];
    for (let k = 0; k < n; k++) {
      const cx = -w * 0.86 + fw * (k + 0.5);
      caps.push(Manifold.cylinder(z1 - z0, fr, fr, 24).translate([cx, -dep, z0]),
        Manifold.sphere(fr, 24).translate([cx, -dep, z0]), Manifold.sphere(fr, 24).translate([cx, -dep, z1]));
    }
    shaft = shaft.subtract(union(caps));
  }
  return [part('shaft', 'stone', shaft, null, { flutes: n })];
}

// ------------------------------------------------------------------------------------------------ assembly

/**
 * Every measure of a column is a multiple of its lower diameter D, so the family is built once at D = 1 per shape
 * (order, element, flutes, base, pedestal, entasis, detail) and scaled: changing only the height or diameter costs a
 * scale, not a rebuild. Scaled handles share the cached geometry; deleting them leaves the cache intact.
 */
// carved ornament follows a deformation rigidly; shaft, base, abacus, bell, echinus, astragal and pedestal bend with the shape
const RIGID = new Set(['caulicolus', 'dart', 'egg', 'fleuron', 'leaf', 'leaf-lower', 'leaf-upper', 'volute']);

export function build(spec) {
  const D = dimsFor(spec).D;
  const shape = { ...spec, height: undefined, diameter: 1, material: undefined, style: undefined, seed: undefined, given: undefined };
  const key = 'column:' + JSON.stringify(shape, Object.keys(shape).sort());
  const unit = memo(key, () => {
    const ps = buildUnit(shape);
    for (const p of ps) p.manifold.numTri(); // evaluate now: the cache holds finished meshes
    return ps;
  });
  const S = mat.S(D), Si = mat.S(1 / D);
  return unit.map((p) => ({
    ...p, meta: { ...p.meta, rigid: RIGID.has(p.name) }, manifold: p.manifold.scale(D),
    transforms: p.transforms ? instances(Array.from({ length: p.transforms.length / 16 }, (_, i) =>
      mat.mul(S, p.transforms.subarray(16 * i, 16 * i + 16), Si))) : null,
  }));
}

function buildUnit(spec) {
  const d = dimsFor(spec), segs = segsFor(spec.detail), o = d.o;
  const baseKind = spec.base ?? o.base;
  const style = o.base === 'gothic' || o.base === 'stepped' || o.base === 'disc' ? o.base : null;
  const parts = [];
  const lift = (ps, z) => ps.map((p) => ({ ...p, transforms: p.transforms
    ? instances(Array.from({ length: p.transforms.length / 16 }, (_, i) => mat.mul(mat.T(0, 0, z), p.transforms.subarray(16 * i, 16 * i + 16))))
    : instances([mat.T(0, 0, z)]) }));

  if (spec.element === 'capital') return grounded(capitalParts(spec, d, segs));
  const b = baseParts(baseKind === 'none' ? 'none' : baseKind, { ...d, base: baseKind === 'none' ? 0 : d.base }, segs, baseKind === 'none' ? null : style);
  if (spec.element === 'base') return b.parts.length ? b.parts : [part('base', 'stone', box(-0.55 * d.D, -0.55 * d.D, 0, 0.55 * d.D, 0.55 * d.D, 0.05 * d.D))];
  const pedHalf = Math.max(b.half, 0.6 * d.D);
  if (spec.element === 'pedestal') return pedestalParts({ ...d, ped: d.ped || d.H / 3 }, pedHalf);

  // Stacking with real overlaps so the column unions into one solid: the base seats OV into the pedestal, the shaft
  // starts OV inside the base and ends OV inside the capital; the capital sits exactly at total - cap, so the overall
  // height stays exact. (Unit build: D = 1, OV scales with D.)
  const OV = 0.004;
  let z = 0;
  if (d.ped) { parts.push(...pedestalParts(d, pedHalf)); z = d.ped - OV; }
  const baseH = baseKind === 'none' ? 0 : d.base;
  parts.push(...lift(b.parts, z));
  z += baseH;
  const zCap = d.total - d.cap, z0 = baseH ? z - OV : z, z1 = d.cap > 0 ? zCap + OV : zCap;
  const dd = { ...d, shaft: z1 - z0 };
  if (spec.element === 'pilaster') {
    parts.splice(parts.length - b.parts.length, b.parts.length, ...lift(pilasterBase(baseKind, { ...d, base: baseH }), z - baseH));
    parts.push(...lift(pilasterParts(spec, dd), z0));
    parts.push(...lift(pilasterCapital(spec, { ...d, shaft: dd.shaft }), zCap));
    return parts;
  }
  parts.push(...lift(shaftParts(spec, dd, segs), z0));
  if (o.classical || spec.order === 'solomonic') parts.push(...lift([part('astragal', 'stone', astragal({ ...dd, D: d.D }, segs))], zCap));
  if (d.cap > 0) parts.push(...lift(capitalParts(spec, { ...dd, shaft: dd.shaft }, segs), zCap));
  return parts;
}

function pilasterCapital(spec, d) {
  const { D, cap: c } = d;
  if (!c) return [];
  const w = D / 2, dep = 0.16 * D, o = spec.order;
  const rect = (prof, z0, ax = w, ay = dep) => { const { rings, zs } = prof.toRings(ax, ay, z0); return loft(rings, zs); };
  if (o === 'corinthian' || o === 'composite') {
    const abH = c / 7, zab = c - abH;
    const bellP = new Prof(0);
    for (let i = 1; i <= 12; i++) bellP.to(0.06 * D * (i / 12) ** 2.2, (zab * i) / 12);
    const out = [part('capital', 'stone', union([rect(bellP, 0), rect(new Prof(0.07 * D).cavetto(0.02 * D, abH * 0.3, 4).fillet(abH * 0.15)
      .ovolo(0.03 * D, abH * 0.4, 5).fillet(abH * 0.15), zab - 0.001)]))];
    const lower = acanthusLeaf({ h: 0.36 * c, w: 0.34 * D, lean: 0.12 });
    const upper = acanthusLeaf({ h: 0.62 * c, w: 0.3 * D, lean: 0.08, lobes: 5 });
    out.push(part('leaf-lower', 'stone', lower, instances([-0.34, 0, 0.34].map((x) => mat.T(x * D, -dep + 0.005 * D, 0)))));
    out.push(part('leaf-upper', 'stone', upper, instances([-0.17, 0.17].map((x) => mat.T(x * D, -dep + 0.012 * D, 0.03 * c)))));
    const vr = 0.08 * D, vol = voluteScroll({ r0: vr, depth: 0.05 * D, side: 1, pinch: 0, eye: 0.16, turns: 2.2 });
    out.push(part('volute', 'stone', union([vol.translate([w - 0.02 * D, -dep - 0.03 * D, zab - vr]),
      vol.mirror([1, 0, 0]).translate([-(w - 0.02 * D), -dep - 0.03 * D, zab - vr])])));
    out.push(part('fleuron', 'stone', rosette(0.07 * D, 8), instances([mat.T(0, -dep - 0.07 * D - 0.02 * D, zab + abH * 0.45)])));
    return out;
  }
  if (o === 'ionic') {
    const abH = 0.065 * D, zab = c - abH, r0 = 0.18 * D;
    const body = union([rect(new Prof(0).fillet(zab - 0.12 * D).ovolo(0.05 * D, 0.12 * D, 6), 0),
      rect(new Prof(0.07 * D).fillet(abH * 0.45).ovolo(0.02 * D, abH * 0.55, 5), zab - 0.001)]);
    const vR = voluteScroll({ r0, depth: 0.12 * D, side: 1, pinch: 0 }).translate([w - 0.05 * D, -dep - 0.02 * D, zab - 0.98 * r0]);
    const vL = voluteScroll({ r0, depth: 0.12 * D, side: -1, pinch: 0 }).translate([-(w - 0.05 * D), -dep - 0.02 * D, zab - 0.98 * r0]);
    return [part('capital', 'stone', union([body, vR, vL]))];
  }
  // Tuscan / Doric / other: necking, echinus (ovolo), abacus as a rectangular lathe
  const p = new Prof(0).fillet(c * 0.36).fillet(0.02 * D, 0.012 * D).ovolo(0.07 * D, c * 0.28).fillet(c * 0.34 - 0.02 * D, 0.012 * D);
  return [part('capital', 'stone', rect(p, 0))];
}

/** Rectangular version of a base (for pilasters): the order's base profile on rectangular rings. */
function pilasterBase(kind, d) {
  const { D, base: H } = d, w = D / 2, dep = 0.16 * D;
  if (!H || kind === 'none') return [];
  const p = new Prof(0.17 * D).fillet(H / 3).torus(0.125 * D * 0.8, 1).out(-0.035 * D).fillet(0.015 * D).scotia(0.07 * D, 0.035 * D, 0.01 * D)
    .torus(0.07 * D, 1).out(-0.03 * D).fillet(0.015 * D);
  scaleH(p, H);
  const { rings, zs } = p.toRings(w, dep);
  return [part('base', 'stone', loft(rings, zs))];
}

function grounded(parts) {
  let min = Infinity;
  for (const p of parts) {
    const bb = p.manifold.boundingBox(), n = p.transforms ? p.transforms.length / 16 : 1;
    for (let i = 0; i < n; i++) {
      const m = p.transforms ? p.transforms.subarray(16 * i, 16 * i + 16) : null;
      for (let k = 0; k < 8; k++) {
        const c = [(k & 1 ? bb.max : bb.min)[0], (k & 2 ? bb.max : bb.min)[1], (k & 4 ? bb.max : bb.min)[2]];
        const zz = m ? m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14] : c[2];
        if (zz < min) min = zz;
      }
    }
  }
  const t = mat.T(0, 0, -min);
  return parts.map((p) => ({ ...p, transforms: p.transforms
    ? instances(Array.from({ length: p.transforms.length / 16 }, (_, i) => mat.mul(t, p.transforms.subarray(16 * i, 16 * i + 16))))
    : instances([t]) }));
}

/** What the generator promises, for the tests. */
export function expected(spec) {
  const d = dimsFor(spec), o = d.o, out = { size: {}, counts: {}, tol: 0.005 };
  if (spec.element === 'column' || spec.element === 'pilaster') {
    out.size.z = d.total;
    const n = spec.flutes ?? o.flutes;
    if (spec.element === 'column' && !['solomonic', 'gothic'].includes(spec.order)) out.counts.flutes = n;
  } else if (spec.element === 'pedestal') out.size.z = d.ped || d.H / 3;
  else if (spec.element === 'base' && (spec.base ?? o.base) !== 'none') out.size.z = d.base;
  return out;
}
