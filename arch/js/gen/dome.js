// Domes, cupolas and spires. Z-up, metres, origin at the base centre, front -Y.
//
// dome   : drum (podium, wall with arched windows between engaged columns or pilasters, entablature, attic) or a moulded
//          base ring; the shell (hemisphere, segmental, onion, ribbed/pointed) with ribs or standing seams; lantern or
//          oculus; finial.
// cupola : the small roof-top cupola: square curb, an octagonal (drum) or square louvred stage with corner pilasters and
//          cornice, the dome, optional lantern, finial.
// spire  : octagonal, square or broach spire on a moulded base course; bell-cast eaves, hip rolls, slates (or seams,
//          or crockets on a stone spire), lucarnes, capstone and cross.
//
// Proportions (sources stated at each use): Vignola (via Ware, The American Vignola) for the orders of drum and
// lantern (orders.js), Palladio and Serlio for the segmental dome, St Peter's / St Paul's / the Invalides for the drum
// (≈ D/2 high, columns between arched windows, attic), Brunelleschi / della Porta for the pointed ribbed profile,
// Russian and Bavarian practice for the onion, English parish practice (Ketton, Northamptonshire) for broach spires.

import { K, TAU, mat, revolve, loft, box, union, part, radial, instances, tube, extrudeXY, sweepRings, bezier, arc, chain }
  from '../kernel.js';
import { Prof } from '../profiles.js';
import { ORDERS, columnDims, entablatureDims } from '../orders.js';
import { acanthusLeaf, voluteScroll, extrudeElevation } from '../ornament.js';

export const ELEMENTS = ['dome', 'cupola', 'spire'];

// masonry materials: a dome or spire of these is built, not covered (role stone); terracotta means a tiled covering
// (Florence) and stays a roof, its ribs in stone
const STONY = new Set(['marble', 'limestone', 'sandstone', 'granite', 'travertine', 'plaster', 'concrete', 'brick']);
const METAL_SKIN = new Set(['copper', 'lead', 'zinc', 'gold', 'bronze']);
const segsFor = (d) => (d === 'low' ? 48 : d === 'medium' ? 96 : 144);
const curveN = (d) => (d === 'low' ? 18 : d === 'medium' ? 30 : 44);
// overlap of pieces meant to fuse: 1 mm, less on elements under half a metre (a 5 cm model keeps its proportions)
let EPS = 1e-3;
function setScale(spec) {
  const s = spec.element === 'spire' ? Math.min(spec.width, spec.height) : spec.diameter;
  EPS = Math.min(1e-3, 0.002 * s);
}

// ================================================================================================ profile helpers

/** Scale a profile's heights so it is exactly H tall (its first point stays at h = 0). */
function scaleH(p, H) {
  const h0 = p.pts[0][1], k = H / (p.h - h0);
  for (const q of p.pts) q[1] = (q[1] - h0) * k;
  return p;
}
const pMax = (p) => Math.max(...p.pts.map((q) => q[0]));

/** Stack profiles bottom to top (each drawn from its own h = 0) into one. */
function stackProf(...ps) {
  const out = new Prof(0, 0);
  out.pts = [];
  let z = 0;
  for (const p of ps) {
    const h0 = p.pts[0][1];
    for (const [a, h] of p.pts) {
      const q = [a, z + h - h0], l = out.pts[out.pts.length - 1];
      if (!l || Math.abs(l[0] - q[0]) > 1e-9 || Math.abs(l[1] - q[1]) > 1e-9) out.pts.push(q);
    }
    z = out.pts[out.pts.length - 1][1];
  }
  return out;
}

/** Lathe a profile (p outward from r0, h up from z0) into a ring closed at the inner radius rIn (0 = a solid disc). */
function lathe(p, r0, z0, rIn, segs) {
  const pts = p.pts.map(([a, h]) => [Math.max(rIn + 1e-4, r0 + a), z0 + h]);
  return revolve([[rIn, pts[0][1]], ...pts, [rIn, pts[pts.length - 1][1]]], segs);
}

/** Regular n-gon ring (apothem a) with a flat facing +X (and -Y when n % 4 == 0). */
function ngon(n, a) {
  const rc = a / Math.cos(Math.PI / n);
  return Array.from({ length: n }, (_, i) => [rc * Math.cos(Math.PI / n + (i * TAU) / n), rc * Math.sin(Math.PI / n + (i * TAU) / n)]);
}

/** Loft a profile as regular n-gon rings of apothem a0 + p ("polygonal lathe": octagonal cornices, square curbs). */
function polyLathe(p, n, a0, z0) {
  return loft(p.pts.map(([q]) => ngon(n, a0 + q)), p.pts.map(([, h]) => z0 + h));
}

/** Copies of a set of parts: every instance of every part placed by each matrix of `mats`. */
function replicate(parts, mats) {
  return parts.map((p) => {
    const own = p.transforms ? Array.from({ length: p.transforms.length / 16 }, (_, i) => p.transforms.subarray(16 * i, 16 * i + 16)) : [mat.I()];
    const list = [];
    for (const M of mats) for (const T of own) list.push(mat.mul(M, T));
    return { ...p, transforms: instances(list) };
  });
}


/** Ring of 3D points oriented so it runs counter-clockwise about `dir` (what sweepRings expects). */
function orient(ring, dir) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return nx * dir[0] + ny * dir[1] + nz * dir[2] < 0 ? ring.slice().reverse() : ring;
}

// ================================================================================================ dome meridians

/**
 * Outer meridian of a dome of springing radius R, from (R, 0) to the crown, as [[r, z], ...].
 *  hemisphere : quarter circle (Pantheon, St Paul's inner dome); rise R.
 *  segmental  : rise D/3 (Palladio's and Serlio's "scemo" vault); a sphere of radius 13R/12 whose centre lies 5R/12
 *               below the springing, meeting it at 22.6° — the haunch is taken by the base ring.
 *  pointed    : two arcs of radius 1.3R centred 0.3R across the axis (the "slightly pointed" profile of della Porta's
 *               St Peter's; Brunelleschi's quinto acuto would be centres 0.6R across, too steep for a default);
 *               rise 1.265R.
 *  onion      : cubic Bezier bulb (see onionCurve).
 */
function domeCurve(type, R, n, opts = {}) {
  let c;
  if (type === 'segmental') {
    const h = (2 * R) / 3, rho = (R * R + h * h) / (2 * h), zc = h - rho;
    c = arc(0, zc, rho, Math.acos(R / rho), Math.PI / 2, n);
  } else if (type === 'pointed') {
    const k = 0.3 * R, rho = R + k;
    c = arc(-k, 0, rho, 0, Math.acos(k / rho), n);
  } else if (type === 'onion') c = onionCurve(R, n, opts.neck);
  else c = arc(0, 0, R, 0, Math.PI / 2, n);
  if (type !== 'onion') c[0] = [R, 0];
  const l = c[c.length - 1];
  if (Math.abs(l[0]) < 1e-9 * R + 1e-12) l[0] = 0;
  return c;
}

/**
 * Onion bulb (units of R, the widest radius): the neck (0.82R, the drum below) flares out to the widest girth at about a
 * quarter of the height, then draws in with an ogee. Russian type (neck = false): a tall bulb (≈ 0.98 D) whose concave
 * upper third tapers to a slender point that carries the cross. Bavarian type (neck = true, the onion that carries a
 * lantern, "Zwiebelhaube mit Laterne"): squatter, drawn in to a short vertical neck of 0.3R on which the lantern stands.
 */
function onionCurve(R, n, neck) {
  const k = Math.max(6, Math.round(n / 3));
  const S = neck
    ? [[[0.82, 0], [0.86, 0.1], [1.0, 0.16], [1.0, 0.4]], [[1.0, 0.4], [1.0, 0.7], [0.8, 0.86], [0.55, 0.95]],
      [[0.55, 0.95], [0.36, 1.01], [0.3, 1.08], [0.3, 1.22]]]
    : [[[0.82, 0], [0.86, 0.12], [1.0, 0.2], [1.0, 0.5]], [[1.0, 0.5], [1.0, 0.87], [0.7, 1.1], [0.37, 1.37]],
      [[0.37, 1.37], [0.17, 1.53], [0.075, 1.72], [0.045, 1.96]]];
  return chain(...S.map((s) => bezier(...s, k))).map(([r, z]) => [r * R, z * R]);
}

/** The highest z at which the meridian is still at least r wide (where a lantern or boss of radius r sits). */
function zSeat(c, r) {
  for (let i = c.length - 1; i > 0; i--) {
    if (c[i][0] >= r) return c[i][1];
    if (c[i - 1][0] >= r) { const a = c[i - 1], b = c[i], t = (a[0] - r) / (a[0] - b[0]); return a[1] + t * (b[1] - a[1]); }
  }
  return c[0][1];
}

/** The meridian cut at height zMax (keeps the part below). */
function clipZ(c, zMax) {
  const out = [];
  for (let i = 0; i < c.length; i++) {
    if (c[i][1] <= zMax) { out.push(c[i]); continue; }
    const a = c[i - 1], b = c[i], t = (zMax - a[1]) / (b[1] - a[1]);
    out.push([a[0] + t * (b[0] - a[0]), zMax]);
    break;
  }
  return out;
}

/** The meridian cut where it comes in to radius rMin on its upper (descending) branch. */
function clipR(c, rMin) {
  const out = [];
  let past = false;
  for (let i = 0; i < c.length; i++) {
    if (i && c[i][0] < c[i - 1][0]) past = true;
    if (!past || c[i][0] >= rMin) { out.push(c[i]); continue; }
    const a = c[i - 1], b = c[i], t = (a[0] - rMin) / (a[0] - b[0]);
    out.push([rMin, a[1] + t * (b[1] - a[1])]);
    break;
  }
  return out;
}

/** Inward offset of a meridian by t (along its normal). */
function offsetIn(c, t) {
  return c.map((p, i) => {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)];
    const dr = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dr, dz) || 1;
    return [p[0] - (t * dz) / l, p[1] + (t * dr) / l];
  });
}

/** Revolve the shell: solid to the axis, or hollow (thickness t) with an eye of radius `eye`. */
function shellSolid(c, segs, { eye = 0, t = 0 } = {}) {
  if (!eye) {
    const l = c[c.length - 1];
    return revolve([[0, c[0][1]], ...c, ...(l[0] > 0 ? [[0, l[1]]] : [])], segs);
  }
  const outer = clipR(c, eye);
  const inner = clipR(offsetIn(c, t).filter((p) => p[0] > 0), eye - 0.25 * t);
  return revolve([...outer, ...inner.reverse()], segs);
}

// ================================================================================================ the orders (lite)

/** Entablature profile for a ring after Vignola: architrave (1–3 fasciae), frieze, cornice with a dentil band, corona and
 *  cyma; heights from orders.js; p = 0 is the architrave's lowest fascia (in line with the upper shaft). */
function entProf(order, Dc) {
  const e = entablatureDims(order, Dc), fas = order === 'tuscan' ? 1 : order === 'doric' || order === 'greek-doric' ? 2 : 3;
  const ar = new Prof(0, 0);
  const fr = fas === 1 ? [1] : fas === 2 ? [0.45, 0.55] : [0.28, 0.33, 0.39];
  fr.forEach((k, i) => { if (i) ar.out(0.022 * Dc); ar.fillet(0.78 * k); });
  ar.cymaReversa(0.05 * Dc, 0.15, 8).fillet(0.07, 0.012 * Dc);
  scaleH(ar, e.arch);
  const fz = new Prof(0.01 * Dc, 0).fillet(1);
  scaleH(fz, e.frieze);
  const co = new Prof(0.01 * Dc, 0).cymaReversa(0.07 * Dc, 0.1, 8).fillet(0.02).out(0.04 * Dc).fillet(0.17)
    .out(0.03 * Dc).ovolo(0.09 * Dc, 0.12, 8).fillet(0.02, 0.01 * Dc).out(0.34 * Dc).fillet(0.22).cymaReversa(0.035 * Dc, 0.07, 6)
    .fillet(0.03, 0.01 * Dc).cymaRecta(0.17 * Dc, 0.19, 10).fillet(0.04, 0.008 * Dc);
  scaleH(co, e.cornice);
  return { prof: stackProf(ar, fz, co), dentilZ: e.arch + e.frieze + e.cornice * (0.12 / 1.06), dentilH: e.cornice * (0.17 / 1.06),
    dentilP: 0.01 * Dc + 0.07 * Dc + 0.04 * Dc, total: e.total };
}


/** Shaft radius at z (Vignola's entasis from the lower third, apophyge at the foot, a slight flare under the astragal). */
function shaftR(d, z) {
  const R = d.D / 2, Rt = d.top / 2, Hs = d.shaft;
  let r = z < Hs / 3 ? R : R - (R - Rt) * (1 - Math.cos((Math.PI / 2) * ((z - Hs / 3) / ((2 * Hs) / 3))));
  const a = 0.075 * d.D, t = 0.05 * d.D;
  if (z < a) r += 0.04 * d.D * (1 - z / a) ** 2;
  if (z > Hs - t) r += 0.025 * d.D * (1 - (Hs - z) / t) ** 2;
  return r;
}

/** A small planar spiral tube (a Corinthian helix) in the XZ plane, starting at the top and turning toward +X. */
function helixTube(r0, r1, turns, rad, stalk, n = 30) {
  const k = Math.log(r0 / r1) / (TAU * turns), pts = stalk.slice();
  for (let i = 0; i <= n; i++) { const th = (i / n) * TAU * turns, r = r0 * Math.exp(-k * th); pts.push([r * Math.sin(th), 0, r * Math.cos(th) - r0]); }
  return tube(pts, (s) => rad * (1 - 0.5 * s), 6);
}

/** A light Ionic volute: the bolster as a disc and the spiral as a raised fillet on both faces (≈ 1/8 of the
 *  triangles of ornament.voluteScroll, for drums that repeat the capital 16–40 times). */
function liteVolute(r0, depth, side) {
  const M = K().Manifold;
  const disc = M.cylinder(depth, r0 * 0.97, r0 * 0.97, 24, true).rotate([90, 0, 0]);
  const k = Math.log(1 / 0.14) / (TAU * 2.6), pts = [];
  for (let i = 0; i <= 40; i++) { const th = (i / 40) * TAU * 2.6, r = r0 * 0.9 * Math.exp(-k * th); pts.push([side * r * Math.sin(th), r * Math.cos(th)]); }
  const spiral = (y) => tube(pts.map(([x, z]) => [x, y, z]), (s) => r0 * (0.07 - 0.04 * s), 5);
  const eye = M.sphere(r0 * 0.14, 10).scale([1, (depth / r0) * 0.55 + 0.2, 1]);
  return union([disc, spiral(-depth / 2), spiral(depth / 2), eye]);
}

/**
 * A light engaged column of `order` and height Hc at the origin (front -Y, the wall behind at +Y): Attic or Tuscan
 * base, shaft with entasis, astragal and a capital whose ornament is drawn with few triangles (a drum repeats it 8–32
 * times): Tuscan/Doric echinus and abacus, Ionic volutes, Corinthian bell with two rows of acanthus (only the leaves
 * that stand clear of the wall), corner helices and a concave abacus. Heights from Vignola (orders.js).
 */
function liteColumn(order, Hc, segs, lod = 1) {
  const key = ORDERS[order] && ORDERS[order].classical ? order : 'tuscan';
  const o = ORDERS[key];
  const d = columnDims(key, { height: Hc }), D = d.D, R = D / 2, rt = d.top / 2;
  const sg = lod > 1 ? 40 : 28, parts = [];
  if (d.base > 0) {
    const H = d.base, plH = H / 3, half = o.base === 'tuscan' ? 0.66 * D : 0.67 * D;
    let p;
    const hh = H - plH;
    if (o.base === 'tuscan') p = new Prof(0.56 * D).torus(0.7 * hh, 0.9, 10).out(-0.03 * D).fillet(0.12 * hh).cavetto(-(0.53 * D - R * 1.04), 0.18 * hh, 4);
    else p = new Prof(0.605 * D).torus(0.125 * D, 1, 10).out(-0.035 * D).fillet(0.018 * D).scotia(0.085 * D, 0.045 * D, 0.012 * D, 8)
      .fillet(0.014 * D).out(-0.006 * D).torus(0.082 * D, 1, 8).out(-0.04 * D).fillet(0.018 * D).cavetto(-(R * 1.044 - R), 0.035 * D, 4);
    scaleH(p, H - plH);
    parts.push(part('col-base', 'stone', union([box(-half, -half, 0, half, half, plH), revolve(p.toRevolve(0, plH - EPS), sg)])));
  }
  const zs = Array.from({ length: 11 }, (_, i) => (i / 10) * d.shaft);
  for (const e of [0.025, 0.06].map((k) => k * D)) zs.push(e, d.shaft - e * 0.6);
  zs.sort((a, b) => a - b);
  parts.push(part('col-shaft', 'stone', revolve([[0, 0], ...zs.map((z) => [shaftR(d, z), z]), [0, d.shaft]], sg).translate([0, 0, d.base - EPS])));
  const zc = d.base + d.shaft, c = d.cap;
  const astr = revolve(new Prof(rt).fillet(0.018 * D, 0.012 * D).torus(0.05 * D, 1, 8).toRevolve(0, zc - 0.068 * D), sg);
  if (key === 'tuscan' || key === 'doric' || key === 'greek-doric') {
    const p = new Prof(rt).fillet(c / 3);
    if (key !== 'tuscan') for (let i = 0; i < 3; i++) p.out(0.008 * D).fillet(0.016 * D);
    p.ovolo(0.56 * D - p.p, c * 0.3, 8);
    parts.push(part('col-capital', 'stone', union([astr, revolve(p.toRevolve(0, zc - EPS), sg),
      box(-0.6 * D, -0.6 * D, zc + p.h - 2 * EPS, 0.6 * D, 0.6 * D, zc + c)])));
  } else if (key === 'ionic') {
    const A = 1.12 * D, abH = 0.065 * D, zab = zc + c - abH, r0 = 0.21 * D, xe = A / 2 - 0.85 * r0, ze = zab - 0.98 * r0, depth = 0.92 * A;
    const ech = revolve(new Prof(rt).ovolo(0.53 * D - rt, 0.13 * D, 8).fillet(0.012 * D).toRevolve(0, zab - 0.2 * D), sg);
    const band = box(-xe, -depth / 2 * 0.985, zab - 0.5 * r0, xe, depth / 2 * 0.985, zab + EPS);
    const vR = (lod > 2 ? voluteScroll({ r0, depth, side: 1 }) : liteVolute(r0, depth, 1)).translate([xe, 0, ze]);
    const vL = (lod > 2 ? voluteScroll({ r0, depth, side: -1 }) : liteVolute(r0, depth, -1)).translate([-xe, 0, ze]);
    const ab = new Prof(A / 2 - 0.02 * D).fillet(abH * 0.45).ovolo(0.02 * D, abH * 0.55, 4);
    const { rings, zs: hz } = ab.toRings(0, 0, zab);
    parts.push(part('col-capital', 'stone', union([astr, ech, band, vR, vL, loft(rings, hz)])));
  } else {
    // Corinthian / Composite (Vignola: leaves 2/7 and 4/7, abacus 1/7 of the capital, which is 7/6 D high)
    const abH = c / 7, zab = zc + c - abH;
    const bpts = [[0, zc - EPS]];
    for (let i = 0; i <= 8; i++) { const t = i / 8; bpts.push([rt + (0.5 * D - rt) * t ** 2.2, zc - EPS + t * (zab - zc + EPS)]); }
    bpts.push([0.53 * D, zab], [0.53 * D, zab + 0.02 * D], [0, zab + 0.02 * D]);
    const bell = revolve(bpts, sg);
    const half = 0.72 * D, sag = 0.11 * D, cut = 0.06 * D;
    const ringAt = (off) => {
      const pts = [], s = half + off;
      for (let side = 0; side < 4; side++) {
        const a = (side * Math.PI) / 2;
        for (let i = 0; i <= 6; i++) {
          const t = -1 + (2 * i) / 6, y = t * (s - cut), x = s - sag * (1 - t * t);
          pts.push([x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]);
        }
      }
      return pts;
    };
    const ap = new Prof(-0.035 * D).cavetto(0.02 * D, abH * 0.3, 3).fillet(abH * 0.15).ovolo(0.03 * D, abH * 0.4, 3).fillet(abH * 0.15);
    const abacus = loft(ap.pts.map(([off]) => ringAt(off)), ap.pts.map(([, h]) => zab - EPS + h));
    const hel = helixTube(0.085 * D, 0.02 * D, 1.5, 0.024 * D, [[-0.06 * D, 0, -0.42 * c], [-0.03 * D, 0, -0.25 * c], [-0.01 * D, 0, -0.08 * c]]);
    const hels = [0, 1, 2, 3].map((k) => hel.rotate([0, 0, -90]).translate([0.6 * D, 0, zab - 0.01 * D]).rotate([0, 0, 45 + 90 * k]));
    const fl = K().Manifold.sphere(0.05 * D, 10).scale([1, 0.55, 1]);
    const fls = [0, 1, 2, 3].map((k) => fl.translate([0, -half + sag * 0.6, zab + abH * 0.45]).rotate([0, 0, 90 * k]));
    parts.push(part('col-capital', 'stone', union([astr, bell, abacus, ...hels, ...fls])));
    const nu = lod > 1 ? 7 : 5, nv = lod > 1 ? 14 : 10;
    for (const r of [
      { name: 'col-leaf-lower', h: 0.36 * c, w: 0.36 * D, phase: TAU / 16, rad: rt - 0.004 * D, z: zc, wrap: 0.48 * D, lean: 0.16, lobes: 3 },
      { name: 'col-leaf-upper', h: 0.64 * c, w: 0.33 * D, phase: 0, rad: rt - 0.02 * D, z: zc + 0.02 * c, wrap: 0.5 * D, lean: 0.1, lobes: 4 },
    ]) {
      const leaf = acanthusLeaf({ h: r.h, w: r.w, lobes: r.lobes, lean: r.lean, wrap: r.wrap, nu, nv });
      const xf = [];
      for (let k = 0; k < 8; k++) {
        const phi = r.phase + (k * TAU) / 8;
        if (Math.sin(phi) > 0.5) continue;                       // buried in the wall behind the column
        xf.push(mat.mul(mat.T(r.rad * Math.cos(phi), r.rad * Math.sin(phi), r.z), mat.Rz(phi + Math.PI / 2)));
      }
      parts.push(part(r.name, 'stone', leaf, instances(xf)));
    }
  }
  return { parts, D, H: Hc };
}

/** A flat pilaster (front -Y, back face at y = 0 going into the wall by `embed`) with a moulded base and capital. */
function litePilaster(W, Hc, proj, embed) {
  const bH = 0.08 * Hc, cH = 0.07 * Hc, half = W / 2, dep = (proj + embed) / 2, yc = -(proj - embed) / 2;
  const bp = new Prof(0.12 * W).fillet(0.4 * bH).cavetto(-0.08 * W, 0.35 * bH, 4).fillet(0.25 * bH, -0.04 * W);
  const cp = new Prof(0).fillet(0.3 * cH).ovolo(0.07 * W, 0.35 * cH, 4).fillet(0.35 * cH, 0.03 * W);
  const ring = (p, z0) => { const { rings, zs } = p.toRings(half, dep, z0); return loft(rings.map((r) => r.map(([x, y]) => [x, y + yc])), zs); };
  return union([ring(bp, 0), box(-half, yc - dep, bH - EPS, half, yc + dep, Hc - cH + EPS), ring(cp, Hc - cH)]);
}

// ================================================================================================ finials

/**
 * Finial standing on z = 0, exactly h tall, foot radius rb (gilded metal). ball: a gilded ball on a moulded stem;
 * cross: orb and Latin cross (Orthodox three-bar cross when russian); spike: needle with two knops (Bavarian "Spitz");
 * pineapple: scaled ovoid with a crown of leaves on a cup; acorn: knobbed cup and nut; urn: gadrooned urn with lid;
 * flame: small urn with a twisting flame.
 */
function finialParts(kind, h, rb, segs, russian = false, name = 'finial') {
  if (kind === 'none' || !(h > 0)) return [];
  const sg = Math.max(24, segs >> 1), M = K().Manifold;
  const foot = (top) => {   // moulded foot from rb up to height `top`, ending in a stem of radius 0.055h
    const p = new Prof(rb).fillet(0.12 * top).cavetto(-(rb - 0.62 * rb), 0.3 * top, 6).torus(0.16 * top, 0.7).out(-(0.62 * rb - 0.055 * h - 0.0 * rb))
      .fillet(0.42 * top);
    p.pts = p.pts.map(([r, z]) => [Math.max(0.03 * h, r), z]);
    return scaleH(p, top);
  };
  const ballArc = (zc, rs, a0 = -1.2) => arc(0, zc, rs, a0, Math.PI / 2, 24).map(([x, y]) => [Math.max(0, x), y]);
  const rev = (pts) => revolve([[0, pts[0][1]], ...pts, [0, pts[pts.length - 1][1]]], sg);
  const parts = [];
  if (kind === 'ball' || kind === 'spike' || kind === 'cross') {
    const top = kind === 'ball' ? 0.3 * h : 0.16 * h;
    const f = foot(top).pts;
    if (kind === 'ball') {
      const rs = 0.32 * h, b = ballArc(h - rs, rs);
      parts.push(part(name, 'metal', rev([...f, [Math.max(0.055 * h, b[0][0] * 0.7), b[0][1] - 0.03 * h], ...b])));
    } else if (kind === 'spike') {
      const r1 = 0.075 * h, z1 = top + 0.11 * h, r2 = 0.04 * h, z2 = 0.58 * h;
      const pts = [...f, ...ballArc(z1, r1, -1.25).slice(0, 18), [0.03 * h, z1 + r1 * 0.75], [0.026 * h, z2 - r2],
        ...arc(0, z2, r2, -1.0, 1.0, 10), [0.016 * h, z2 + r2 * 0.9], [0.0001 * h, h]];
      parts.push(part(name, 'metal', rev(pts)));
    } else {
      const ro = 0.12 * h, zo = top + ro * 0.85;
      parts.push(part(name, 'metal', rev([...f, ...ballArc(zo, ro, -1.25), ])));
      const s = 0.05 * h, z0 = zo + ro * 0.9, bars = [box(-s / 2, -s / 2, z0, s / 2, s / 2, h)];
      if (russian) {
        const bar = (zc, half, tilt = 0) => box(-half, -s / 2, zc - s / 2, half, s / 2, zc + s / 2).rotate([0, tilt, 0]).translate([0, 0, 0]);
        bars.push(bar(0.88 * h, 0.1 * h).translate([0, 0, 0]), bar(0.73 * h, 0.21 * h));
        bars.push(box(-0.14 * h, -s / 2, -s / 2, 0.14 * h, s / 2, s / 2).rotate([0, 22, 0]).translate([0, 0, 0.5 * h]));
      } else {
        const za = z0 + 0.62 * (h - z0), half = 0.25 * (h - z0) + s / 2;
        bars.push(box(-half, -s / 2, za - s / 2, half, s / 2, za + s / 2));
        // small ball terminals at the arm ends
        bars.push(M.sphere(0.042 * h, 12).translate([half, 0, za]), M.sphere(0.042 * h, 12).translate([-half, 0, za]));
      }
      parts.push(part(name + '-cross', 'metal', union(bars)));
    }
    return parts;
  }
  if (kind === 'pineapple') {
    const top = 0.18 * h, f = foot(top).pts;
    const z0 = top - EPS, z1 = 0.78 * h, rmax = 0.17 * h, nTh = 48, rows = 9, N = 40;
    const zsB = [], rings = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, z = z0 + t * (z1 - z0), r0 = rmax * Math.sin(Math.PI * (0.12 + 0.86 * t)) ** 0.8 + 0.02 * h * (1 - t);
      const row = t * rows, rr = Math.floor(row), fr = row - rr, ph = (rr % 2) * (TAU / 24);
      rings.push(Array.from({ length: nTh }, (_, j) => {
        const th = (j * TAU) / nTh, k = 1 + 0.09 * Math.sin(Math.PI * fr) * Math.abs(Math.cos(6 * (th - ph)));
        return [r0 * k * Math.cos(th), r0 * k * Math.sin(th)];
      }));
      zsB.push(z);
    }
    parts.push(part(name, 'metal', union([rev([...f, [0.055 * h, z0 + 0.01 * h]]), loft(rings, zsB)])));
    // crown of leaves: an eight-pointed star splaying out, then tapering and twisting to the tip
    const cr = [], cz = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12, r = 0.12 * h * Math.sin(Math.PI * Math.min(1, 0.35 + t)) ** 0.6 * (1 - t) ** 0.7 + 0.001 * h;
      cr.push(Array.from({ length: 32 }, (_, j) => { const th = (j * TAU) / 32 + t * 0.5, k = j % 4 === 0 ? 1 : j % 2 === 0 ? 0.35 : 0.6; return [r * k * Math.cos(th), r * k * Math.sin(th)]; }));
      cz.push(z1 - 0.03 * h + t * (h - z1 + 0.03 * h));
    }
    parts.push(part(name + '-crown', 'metal', loft(cr, cz)));
    return parts;
  }
  if (kind === 'acorn') {
    // a knobbed cup holding an ovoid nut with a small point
    const top = 0.17 * h, f = foot(top).pts, nTh = 54, rows = 4, N = 24, z0 = top - EPS, z1 = 0.47 * h;
    const rings = [], zz = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, z = z0 + t * (z1 - z0);
      const r0 = t < 0.85 ? 0.06 * h + 0.13 * h * Math.sin((Math.PI / 2) * (t / 0.85)) ** 0.7 : 0.19 * h - 0.06 * h * ((t - 0.85) / 0.15);
      const row = t * rows, rr = Math.floor(row), fr = row - rr, ph = (rr % 2) * (TAU / 18);
      rings.push(Array.from({ length: nTh }, (_, j) => {
        const th = (j * TAU) / nTh, k = 1 + 0.07 * Math.sin(Math.PI * fr) * Math.abs(Math.cos(4.5 * (th - ph))) * (t < 0.92 ? 1 : 0);
        return [r0 * k * Math.cos(th), r0 * k * Math.sin(th)];
      }));
      zz.push(z);
    }
    const nut = [];
    for (let i = 0; i <= 20; i++) { const sN = i / 20; nut.push([0.155 * h * Math.sin(Math.PI * sN) ** 0.55 * (1 - 0.3 * sN) + 0.01 * h * sN, 0.36 * h + sN * 0.6 * h]); }
    nut.push([0.007 * h, 0.985 * h], [0, h]);
    parts.push(part(name, 'metal', union([rev([...f, [0.055 * h, z0 + 0.01 * h]]), loft(rings, zz), rev(nut)])));
    return parts;
  }
  // urn and flame urn
  const urnTop = kind === 'flame' ? 0.5 * h : h, u = urnTop;
  const f = foot(0.12 * u).pts;
  const prof = [...f, [0.09 * u, 0.15 * u], [0.13 * u, 0.2 * u], [0.2 * u, 0.32 * u], [0.24 * u, 0.45 * u], [0.24 * u, 0.55 * u],
    [0.2 * u, 0.63 * u], [0.12 * u, 0.7 * u], [0.1 * u, 0.74 * u], [0.15 * u, 0.76 * u], [0.15 * u, 0.79 * u], [0.12 * u, 0.82 * u]];
  if (kind === 'urn') prof.push([0.06 * u, 0.86 * u], [0.04 * u, 0.9 * u], ...arc(0, 0.95 * u, 0.05 * u, -1.0, Math.PI / 2, 10));
  else prof.push([0.05 * u, 0.85 * u], [0.04 * u, u]);
  const body = rev(prof);
  // gadroons on the lower belly
  const gad = [], gz = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, z = 0.2 * u + t * 0.3 * u, r0 = 0.13 * u + (0.245 * u - 0.13 * u) * Math.sin((Math.PI / 2) * t) ** 0.8;
    gad.push(Array.from({ length: 64 }, (_, j) => { const th = (j * TAU) / 64, k = 1 + 0.05 * Math.abs(Math.cos(8 * th)) * Math.sin(Math.PI * Math.min(1, t * 1.2)); return [r0 * k * Math.cos(th), r0 * k * Math.sin(th)]; }));
    gz.push(z);
  }
  parts.push(part(name, 'metal', union([body, loft(gad, gz)])));
  if (kind === 'flame') {
    const fr = [], fz = [];
    for (let i = 0; i <= 18; i++) {
      const t = i / 18, r = 0.11 * h * Math.sin(Math.PI * Math.min(1, 0.25 + 0.95 * t)) ** 0.7 * (1 - t) + 0.0005 * h;
      fr.push(Array.from({ length: 40 }, (_, j) => { const th = (j * TAU) / 40 + t * 2.2, k = 0.62 + 0.38 * Math.abs(Math.cos(2.5 * th)); return [r * k * Math.cos(th), r * k * Math.sin(th)]; }));
      fz.push(u - 0.02 * h + t * (h - u + 0.02 * h));
    }
    parts.push(part(name + '-flame', 'metal', loft(fr, fz)));
  }
  return parts;
}

/** Height of a finial of `kind` for a carrier of size s (the dome or lantern diameter). */
function finialH(kind, s) {
  return { ball: 0.42, cross: 0.62, spike: 0.75, pineapple: 0.5, acorn: 0.42, urn: 0.48, flame: 0.58, none: 0 }[kind] * s;
}

// ================================================================================================ dome plan (numbers only)

function defaultFinial(spec) {
  if (spec.finial) return spec.finial;
  return spec.domeType === 'onion' || spec.style === 'byzantine' || spec.style === 'russian' ? 'cross' : 'ball';
}

/** All dimensions of a dome or cupola, shared by build() and expected(). */
function domePlan(spec) {
  const cup = spec.element === 'cupola';
  const D = spec.diameter, R = D / 2, type = spec.domeType || 'hemisphere', onion = type === 'onion';
  // ribs not stated (undefined): a ribbed dome gets 16 (St Peter's), a ribbed cupola 8 (one per corner of its octagon),
  // other types none. Stated 0 on a ribbed dome is honoured: the smooth pointed "ribbed" profile without ribs.
  const ribs = spec.ribs === undefined ? (type === 'ribbed' ? (cup ? 8 : 16) : 0) : spec.ribs;
  const prof = type === 'ribbed' ? 'pointed' : type;
  const lantern = !!spec.lantern, oculus = !!spec.oculus && !onion;
  // the Orthodox three-bar cross: asked for (russian), or a big onion dome without a lantern and no other style;
  // a lantern onion (Bavarian / Austrian "Zwiebelhaube") or a roof-top onion cupola (Swiss "Dachreiter") gets a Latin cross
  const russian = spec.style === 'russian' || (onion && !cup && !lantern && !spec.style);
  const finial = defaultFinial(spec);
  const segs = segsFor(spec.detail), nC = curveN(spec.detail);
  const P = { cup, D, R, type, prof, onion, ribs, lantern, oculus, finial, russian, segs, nC, detail: spec.detail || 'high',
    material: spec.material || 'copper' };
  const ord = spec.order && ORDERS[spec.order] ? spec.order : 'corinthian';
  P.order = ord;
  P.classical = ORDERS[ord].classical;
  P.rMax = R;
  if (!cup) lowerDomePlan(P, spec); else lowerCupolaPlan(P, spec);
  upperPlan(P);
  return P;
}

/** Drum after St Peter's / St Paul's: total height D/2 (podium 7 %, columns + entablature, attic 12 %). */
function lowerDomePlan(P, spec) {
  const { D, R } = P;
  P.drum = spec.drum !== false;
  P.Rw = (P.onion ? 0.8 : 1) * R + 0.012 * D;               // wall face; the shell springs just inside the attic
  // Byzantine: a low drum of many arched lights under hood moulds between lesenes (Constantinople, Thessaloniki), or
  // without a drum the ring of windows between buttresses at the foot of the dome (Hagia Sophia: 40 at 31 m)
  P.byz = spec.style === 'byzantine' && !P.onion;
  if (P.byz) return byzDrumPlan(P);
  if (!P.drum) {
    // moulded base ring: plinth, die, cyma and fillet; the shell springs from its top
    P.hb = 0.06 * D;
    P.baseProf = scaleH(new Prof(0.03 * D).fillet(0.25).cymaReversa(-0.012 * D, 0.12, 6).fillet(0.38, -0.006 * D)
      .ovolo(0.012 * D, 0.15, 6).fillet(0.1, 0.004 * D), P.hb);
    P.rBase = (P.onion ? 0.82 : 1) * R;
    P.rMax = Math.max(P.rMax, P.rBase + pMax(P.baseProf));
    P.zS = P.hb;
    return;
  }
  // an onion stands on a taller, plainer drum (Russian barabán: lesenes, tall narrow lights, a simple cornice)
  // neoclassical: a free-standing peristyle round the drum carrying a balustraded gallery, a taller attic behind
  // (St Paul's, the Panthéon in Paris, the US Capitol)
  P.peri = spec.style === 'neoclassical' && P.classical && P.detail !== 'low' && !P.onion;
  const Hd = (P.onion ? 0.62 : 0.5) * D, ps = 0.07 * Hd, Ha0 = (P.peri ? 0.24 : 0.12) * Hd;
  const orderStated = spec.given ? spec.given.includes('order') : spec.order !== undefined;
  P.useCols = P.classical && P.detail !== 'low' && !(P.onion && !orderStated);
  const eOrd = P.onion && !orderStated ? 'tuscan' : P.order;
  const o = ORDERS[eOrd];
  const entRatio = entablatureDims(eOrd, 1).total / o.colD;
  const Hc = (Hd - ps - Ha0) / (1 + entRatio);
  const Dc = Hc / o.colD;
  const ent = entProf(eOrd, Dc);
  Object.assign(P, { Hd, ps, Hc, Dc, He: ent.total, Ha: Hd - ps - Hc - ent.total, ent });
  P.Rc = P.Rw + (P.peri ? 1.7 : 0.18) * Dc;                 // three-quarter engaged columns, or the peristyle
  P.pilProj = 0.2 * Dc;
  P.rA = P.useCols ? P.Rc + 0.5 * Dc * o.shaftTop : P.Rw + P.pilProj;   // architrave face over the upper shaft
  P.tw = 0.07 * D;                                           // wall (St Peter's drum: ~3 m on 42 m)
  P.rIn = P.Rw - P.tw;
  // bays: 8 under 12 m, 12 under 24 m, 16 above (St Peter's: 16 at 42 m); a ribbed dome aligns its ribs on the piers
  let n = D < 12 ? 8 : D < 24 ? 12 : 16;
  if (P.ribs >= 6) {
    const divs = []; for (let k = 6; k <= 24; k++) if (P.ribs % k === 0) divs.push(k);
    if (divs.length) n = divs.filter((k) => k <= 16).pop() || divs[0];
  }
  P.n = n;
  const bay = (TAU * P.Rw) / n;
  P.paired = P.useCols && !P.peri && bay / Dc >= 11;
  const pier = P.paired ? 2.6 * Dc : P.peri ? bay / 2 : 1.4 * Dc;
  if (P.peri) { P.nCols = 2 * n; P.balH = 0.85 * ent.total; }
  // windows: Vignola's arch, twice as high as wide, 0.7 of the column; the onion drum's lights are slimmer (1 : 2.6)
  const k = P.onion ? 2.6 : 2;
  let Ww = (0.7 * Hc) / k;
  Ww = Math.min(Ww, 0.55 * (bay - pier));
  P.Ww = Ww; P.Hw = k * Ww; P.zw = ps + 0.08 * Hc;
  P.pierAng = (0.75 * Dc) / P.Rc;                            // half the axis distance of coupled columns (1.5 Dc)
  // podium (pedestal course): die just enclosing the column plinths, base and cap mouldings
  P.rPod = P.useCols ? P.Rc + 0.78 * Dc : P.Rw + P.pilProj + 0.12 * Dc;
  P.podProf = scaleH(new Prof(0.14 * Dc).fillet(0.2).cymaReversa(-0.1 * Dc, 0.13, 6).fillet(0.05, -0.04 * Dc).fillet(0.42)
    .cymaReversa(0.06 * Dc, 0.1, 6).fillet(0.1, 0.03 * Dc), ps);
  P.atticProf = scaleH(new Prof(0.04 * Dc).fillet(0.08).cymaReversa(-0.04 * Dc, 0.06, 4).fillet(0.66)
    .cymaReversa(0.05 * Dc, 0.08, 4).fillet(0.07, 0.02 * Dc).ovolo(0.03 * Dc, 0.06, 4).fillet(0.05, -0.0), P.Ha);
  P.rMax = Math.max(P.rMax, P.rPod + pMax(P.podProf), P.rA + pMax(ent.prof), P.Rw + pMax(P.atticProf));
  P.zS = Hd;
}

function byzDrumPlan(P) {
  const { D } = P;
  const Hd = (P.drum ? 0.26 : 0.12) * D, ps = 0.08 * Hd, u = 0.012 * D;
  const He = 0.12 * Hd, Ha = 0.03 * Hd, Hc = Hd - ps - He - Ha;
  const n = P.drum ? (D < 12 ? 12 : D < 24 ? 16 : 24) : D < 12 ? 24 : 40;
  const bay = (TAU * P.Rw) / n;
  const prof = scaleH(new Prof(0).fillet(0.22).cavetto(1.6 * u, 0.3, 6).fillet(0.16).ovolo(0.8 * u, 0.2, 4).fillet(0.12), He);
  Object.assign(P, { Hd, ps, Hc, Dc: Hc / 10, He, Ha, n, useCols: false, paired: false, tw: 0.06 * D, keystone: false, hood: true,
    noDentils: true, noAttic: true, ent: { prof, total: He } });
  P.rIn = P.Rw - P.tw;
  P.pilW = P.drum ? 0.12 * bay : 0.3 * bay;
  P.pilProj = P.drum ? 0.04 * bay : 0.28 * bay;
  P.rA = P.Rw + (P.drum ? P.pilProj : 0.05 * bay);
  P.Ww = Math.min((0.72 * Hc) / 2.2, 0.62 * (bay - P.pilW)); P.Hw = 2.2 * P.Ww; P.zw = ps + 0.1 * Hc;
  P.rPod = P.Rw + P.pilProj + 0.2 * u;
  P.podProf = scaleH(new Prof(0.6 * u).fillet(0.55).cavetto(-0.6 * u, 0.45, 4), ps);
  P.atticProf = scaleH(new Prof(0).fillet(1), Ha);
  P.rMax = Math.max(P.rMax, P.rPod + pMax(P.podProf), P.rA + pMax(prof), P.Rw);
  P.zS = Hd;
}

/** Roof-top cupola (Georgian / Swiss "Dachreiter"): a square base box 0.28 D high that straddles the ridge, a louvred
 *  stage — octagonal when it has a drum (0.6 D high, the brief's cupola drum), square otherwise (0.5 D) — with corner
 *  pilasters and an entablature ≈ 1/5 of the stage (Vignola's 1/4 of a column, lightened for joinery); the dome springs
 *  at the stage's wall face from the weathered top of the cornice. */
function lowerCupolaPlan(P, spec) {
  const { D, R } = P;
  P.drum = spec.drum !== false;
  P.sides = P.drum ? 8 : 4;
  P.aSt = (P.onion ? 0.86 : 1) * R;                            // stage apothem: the dome springs at the wall face
  const corner = P.aSt / Math.cos(Math.PI / P.sides);
  P.aCurb = (P.drum ? corner : P.aSt) + 0.03 * D;
  P.hCurb = 0.28 * D;
  P.curbProf = scaleH(new Prof(0.022 * D).fillet(0.12).cymaReversa(-0.022 * D, 0.08, 4).fillet(0.6)
    .cymaReversa(0.02 * D, 0.06, 4).fillet(0.05, 0.006 * D).ovolo(0.014 * D, 0.06, 4).fillet(0.03, 0.002 * D)
    .slope(-0.042 * D, 0.03), P.hCurb);
  P.Hs = (P.drum ? 0.6 : 0.5) * D;
  P.plH = 0.07 * P.Hs; P.entH = 0.2 * P.Hs;
  P.stPlProf = scaleH(new Prof(0.02 * D).fillet(0.5).cymaReversa(-0.02 * D, 0.5, 4), P.plH);
  P.stEntProf = scaleH(new Prof(0.008 * D).fillet(0.2).out(0.004 * D).fillet(0.08).fillet(0.26, -0.012 * D)
    .cymaReversa(0.014 * D, 0.07, 4).ovolo(0.014 * D, 0.07, 4).out(0.02 * D).fillet(0.11).cymaReversa(0.006 * D, 0.04, 4)
    .cymaRecta(0.016 * D, 0.1, 6).fillet(0.02, 0.002 * D).slope(-(0.072 * D), 0.05), P.entH);
  P.tw = 0.05 * D;
  const face = 2 * P.aSt * Math.tan(Math.PI / P.sides);
  P.pilW = (P.drum ? 0.075 : 0.1) * D;
  const wallH = P.Hs - P.plH - P.entH;
  // one arched light per face of the octagon; a pair per face of the square stage (a belfry's coupled lights)
  P.perFace = P.drum ? 1 : 2;
  P.Ww = Math.min((0.8 * wallH) / 2, (0.62 * (face - P.pilW * (P.drum ? 1.3 : 2))) / P.perFace);
  P.opX = P.perFace === 2 ? [-0.23 * face, 0.23 * face] : [0];
  P.Hw = 2 * P.Ww;
  P.zSt = P.hCurb - EPS;
  P.zw = P.zSt + P.plH + 0.45 * (wallH - P.Hw);
  P.zS = P.zSt + P.Hs;
  P.rMax = Math.max(P.rMax, P.aCurb + pMax(P.curbProf), P.aSt + pMax(P.stEntProf), P.aSt + pMax(P.stPlProf));
}

/** Shell, lantern, oculus and finial heights above the springing zS. */
function upperPlan(P) {
  const { D, R } = P;
  P.curve = domeCurve(P.prof, R, P.nC, { neck: P.onion && P.lantern }).map(([r, z]) => [r, z + P.zS]);
  P.footH = 0.03 * D;
  P.footProf = new Prof(0.016 * D).fillet(0.3 * P.footH).torus(0.4 * P.footH, 0.6, 12).fillet(0.3 * P.footH, -0.006 * D);
  P.rMax = Math.max(P.rMax, (P.onion ? 0.82 * R : R) + pMax(P.footProf));
  // ribs: width 4.5 % of D at the springing (St Peter's ≈ 1/25), tapering to 45 % at the top; projection 1.4 % of D
  const rWide = Math.max(...P.curve.map((q) => q[0]));
  P.pats = [];
  if (P.ribs) {
    P.ribW = Math.min(0.045 * D, (0.55 * TAU * R) / P.ribs);
    P.ribH = 0.014 * D;
    P.ribAngle0 = P.cup ? Math.PI / P.sides : P.n ? Math.PI / P.n : Math.PI / P.ribs;
    P.pats.push({ n: P.ribs, a0: P.ribAngle0, rho: rWide + P.ribH, hw: P.ribW / 2 });
  } else if (P.detail === 'high' && METAL_SKIN.has(P.material)) {
    // standing seams of the copper / lead sheets (≈ 0.6 m wide pans), counted in whole sheets per bay, one on the axis
    const base = P.n || P.sides || 8, per = Math.max(1, Math.round((Math.PI * D) / 0.6 / base)), ns = Math.min(96, base * per);
    if (ns >= 8) {
      P.seams = { ns, rs: Math.min(0.018, 0.0035 * D), a0: 0 };
      P.pats.push({ n: ns, a0: 0, rho: rWide + P.seams.rs, hw: P.seams.rs });
    }
  }
  if (P.lantern) {
    // lantern ≈ 1/4 of the dome's diameter (Florence, St Peter's); stands on a pedestal ring seated on the shell
    const Dl = D / 4;
    P.Dl = Dl;
    P.rLp = 0.6 * Dl;                                      // pedestal, widest
    P.hLp = 0.16 * Dl;
    P.zL0 = zSeat(P.curve, P.rLp);
    P.lpProf = scaleH(new Prof(0).fillet(0.18).cymaReversa(-0.04 * Dl, 0.14, 4).fillet(0.46).cymaReversa(0.025 * Dl, 0.12, 4)
      .fillet(0.1, 0.006 * Dl), P.hLp);
    P.open = P.oculus;                                     // an oculus under a lantern makes it an open lantern
    const o = ORDERS[P.order];
    P.Hcl = 0.74 * Dl;
    P.Dcl = P.Hcl / o.colD;
    P.lent = entProf(P.order, P.Dcl);
    P.rCore = 0.36 * Dl;
    P.rCol = P.open ? 0.4 * Dl : P.rCore + 0.42 * P.Dcl;
    P.Hal = 0.07 * Dl;
    P.rCap = 0.43 * Dl;
    P.capProf = P.onion ? 'onion' : P.prof;
    P.capCurve0 = domeCurve(P.capProf, P.rCap, Math.max(14, P.nC >> 1), {});
    const zCapS = P.zL0 + P.hLp + P.Hcl + P.lent.total + P.Hal;
    P.zCapS = zCapS;
    P.capCurve = P.capCurve0.map(([r, z]) => [r, z + zCapS]);
    P.rBoss = Math.max(0.05 * Dl, P.onion ? 0.045 * P.rCap : 0);
    P.hBoss = 0.06 * Dl;
    P.zBoss = zSeat(P.capCurve, P.rBoss);
    P.zF = P.zBoss + P.hBoss;
    P.Hf = finialH(P.finial, P.onion ? 1.3 * Dl : Dl);
    P.rbF = 0.9 * P.rBoss;
    P.zTop = P.zF + P.Hf;
  } else if (P.oculus) {
    if (!P.cup && !P.n && (P.prof === 'hemisphere' || P.prof === 'segmental')) { P.steps = true; P.stepTop = 0.5 * (P.curve[P.curve.length - 1][1] - P.zS); P.stepOut = 0.012 * D; }
    // the Pantheon's eye: 1/5 of the diameter, with a moulded curb
    P.rOc = 0.1 * D;
    P.tSh = 0.035 * D;
    P.curbW = 0.028 * D;
    P.curbH = 0.022 * D;
    P.zCurb = zSeat(P.curve, P.rOc + P.curbW);
    P.zTop = zSeat(P.curve, P.rOc) + P.curbH;
    P.zTop = Math.max(P.zTop, P.zCurb + P.curbH);
    P.Hf = 0;
  } else {
    // crown boss carrying the finial; wide enough for the ribs to die into
    P.rBoss = Math.max(0.045 * D, P.ribs ? (P.ribs * P.ribW * 0.5) / (0.7 * TAU) : 0);
    if (P.onion) P.rBoss = 0.06 * R;
    P.hBoss = 0.035 * D;
    P.zBoss = zSeat(P.curve, P.rBoss);
    P.zF = P.zBoss + P.hBoss;
    P.Hf = finialH(P.finial, P.onion && !P.lantern ? 0.62 * D : 0.3 * D);
    P.rbF = 0.9 * P.rBoss;
    P.zTop = P.zF + P.Hf;
  }
  if (P.finial === 'none' && !P.oculus) P.zTop = P.zF;
}

// ================================================================================================ dome geometry

function windowOutline(Ww, Hw, zw, n = 16) {
  const r = Ww / 2, zsp = zw + Hw - r;
  return [[-r, zw], [r, zw], ...arc(0, zsp, r, 0, Math.PI, n).slice(0, -1), [-r, zsp]];
}

/** Through-cutter (elevation outline extruded radially through a wall of outer radius Ro, thickness t), front bay. */
function cutterAt(outline, Ro, t) { return extrudeElevation(outline, t + 0.6 * Ro + 0.2, -(Ro + 0.1)); }

/** Flat elevation solid set on a curved wall of radius Ro: its front at y = -(Ro + proj), its back buried in the wall. */
function onWall(cs, Ro, proj, xMax, back = 0.02) {
  const ry = Math.sqrt(Math.max(0, Ro * Ro - xMax * xMax));
  const y0 = -(Ro + proj), y1 = -(ry - back);
  return extrudeElevation(cs, y1 - y0, y0);
}

function drumParts(P) {
  const { segs, n, Rw, rIn, ps, Hc, Dc, D } = P, parts = [];
  parts.push(part('drum-podium', 'stone', lathe(P.podProf, P.rPod, 0, rIn, segs)));
  // wall with n arched windows (Vignola: opening twice as high as wide)
  const out = windowOutline(P.Ww, P.Hw, P.zw, P.detail === 'low' ? 10 : 18);
  const cut = cutterAt(out, Rw, P.tw);
  let wall = revolve([[rIn, ps - EPS], [Rw, ps - EPS], [Rw, ps + Hc + EPS], [rIn, ps + Hc + EPS]], segs);
  wall = wall.subtract(union(Array.from({ length: n }, (_, i) => cut.rotate([0, 0, (i * 360) / n]))));
  parts.push(part('drum-wall', 'stone', wall));
  // glazing set a third into the reveal
  const glass = extrudeElevation(K().CrossSection.ofPolygons([out]).offset(0.004 * D, 'Miter'), 0.02 * P.Ww, -(Rw - P.tw * 0.35));
  parts.push(part('window-glass', 'glass', glass, radial(n)));
  if (P.detail !== 'low') {
    // glazing bars: mullion, transom at the springing, sash bars below and radiating bars in the fanlight
    const Ww = P.Ww, r = Ww / 2, zsp = P.zw + P.Hw - r, bw = 0.035 * Ww, yb = -(Rw - P.tw * 0.35) - 0.03 * Ww, dep = 0.035 * Ww;
    const bar = (x0, z0, x1, z1) => {
      const L = Math.hypot(x1 - x0, z1 - z0), a = Math.atan2(x1 - x0, z1 - z0);
      return box(-bw / 2, 0, 0, bw / 2, dep, L).rotate([0, (a * 180) / Math.PI, 0]).translate([x0, yb, z0]);
    };
    const bars = [bar(0, P.zw, 0, zsp + r * 0.98), bar(-r, zsp, r, zsp)];
    for (const k of [1, 2]) bars.push(bar(-r, P.zw + (k * (zsp - P.zw)) / 3, r, P.zw + (k * (zsp - P.zw)) / 3));
    for (const a of [Math.PI / 4, (3 * Math.PI) / 4]) bars.push(bar(0, zsp, r * 0.98 * Math.cos(a), zsp + r * 0.98 * Math.sin(a)));
    parts.push(part('glazing-bar', 'wood', union(bars), radial(n)));
  }
  // architrave surround (1/6 of the opening, Vignola), sill, keystone
  const s = P.Ww / 6, cs = K().CrossSection.ofPolygons([out]);
  const band = cs.offset(s, 'Miter').subtract(cs).subtract(K().CrossSection.ofPolygons([[[-P.Ww, P.zw - 2 * s], [P.Ww, P.zw - 2 * s], [P.Ww, P.zw + EPS], [-P.Ww, P.zw + EPS]]]));
  const pieces = [onWall(band, Rw, 0.05 * P.Ww, P.Ww / 2 + s)];
  const sw = P.Ww / 2 + 1.6 * s, sh = 0.7 * s;
  pieces.push(onWall([[-sw, P.zw - sh], [sw, P.zw - sh], [sw, P.zw + 0.15 * s], [-sw, P.zw + 0.15 * s]], Rw, 0.14 * P.Ww, sw));
  if (P.hood) {
    // hood mould over the arch, springing from small imposts
    const r0 = P.Ww / 2 + s, zsp = P.zw + P.Hw - P.Ww / 2;
    const hood = [...arc(0, zsp, r0 + 0.9 * s, 0, Math.PI, 16), ...arc(0, zsp, r0, Math.PI, 0, 16)];
    pieces.push(onWall(hood, Rw, 0.12 * P.Ww, r0 + 0.9 * s));
    pieces.push(onWall([[-(r0 + 1.1 * s), zsp - 0.5 * s], [r0 + 1.1 * s, zsp - 0.5 * s], [r0 + 1.1 * s, zsp + EPS], [-(r0 + 1.1 * s), zsp + EPS]], Rw, 0.1 * P.Ww, r0 + 1.1 * s));
  } else if (P.detail === 'high') {
    const zk = P.zw + P.Hw, kw0 = 0.36 * s, kw1 = 0.55 * s;
    pieces.push(onWall([[-kw0, zk - 0.25 * s], [kw0, zk - 0.25 * s], [kw1, zk + 1.25 * s], [-kw1, zk + 1.25 * s]], Rw, 0.09 * P.Ww, kw1));
  }
  parts.push(part('window-surround', 'stone', union(pieces), radial(n)));
  // supports between the windows: three-quarter columns (coupled when the bay allows) or pilasters
  const piers = [];
  if (P.peri) for (let k = 0; k < P.nCols; k++) piers.push(((k + 0.5) * TAU) / P.nCols - Math.PI / P.nCols + Math.PI / P.nCols);
  else for (let i = 0; i < n; i++) {
    const phi = ((i + 0.5) * TAU) / n;
    if (P.paired) piers.push(phi - P.pierAng, phi + P.pierAng); else piers.push(phi);
  }
  if (P.useCols) {
    const col = liteColumn(P.order, Hc, segs, P.detail === 'high' ? 2 : 1);
    parts.push(...replicate(col.parts, piers.map((a) => mat.mul(mat.Rz(a), mat.T(0, -P.Rc, ps - EPS)))));
  } else {
    const pil = litePilaster(P.pilW || Dc, Hc, P.pilProj, 0.25 * Dc);
    parts.push(part('drum-pilaster', 'stone', pil, instances(piers.map((a) => mat.mul(mat.Rz(a), mat.T(0, -Rw, ps - EPS))))));
  }
  // entablature ring and (high) dentils
  const zE = ps + Hc;
  const rArch = P.rA;
  parts.push(part('drum-entablature', 'stone', lathe(P.ent.prof, rArch, zE, rIn, segs)));
  if (P.detail === 'high' && !P.noDentils) {
    const dw = 0.11 * Dc, rD = rArch + P.ent.dentilP, nd = Math.round((TAU * rD) / (1.5 * dw));
    const dent = box(-dw / 2, -0.07 * Dc, 0, dw / 2, 0.02 * Dc, P.ent.dentilH);
    parts.push(part('dentil', 'stone', dent, radial(nd, mat.T(0, -rD, zE + P.ent.dentilZ))));
  }
  if (P.peri) parts.push(...balustrade(P, zE + P.He - EPS, piers));
  // attic: ring with strips over the piers and sunk panels over the windows
  const zA = zE + P.He - EPS;
  let attic = lathe(P.atticProf, Rw, zA, rIn, segs);
  if (P.noAttic) { parts.push(part('drum-attic', 'stone', attic)); return parts; }
  const apH = P.Ha * 0.45, apW = P.Ww * 0.9;
  const panel = box(-apW / 2, -(Rw + 0.1), zA + P.Ha * 0.27, apW / 2, -(Rw - 0.03 * Dc), zA + P.Ha * 0.27 + apH);
  attic = attic.subtract(union(Array.from({ length: n }, (_, i) => panel.rotate([0, 0, (i * 360) / n]))));
  parts.push(part('drum-attic', 'stone', attic));
  const stripW = P.paired ? 2.6 * Dc : 1.1 * Dc;
  const strip = box(-stripW / 2, -(Rw + 0.06 * Dc), zA + 0.12 * P.Ha, stripW / 2, -(Rw - 0.1 * Dc), zA + 0.8 * P.Ha);
  parts.push(part('attic-strip', 'stone', strip, radial(n, mat.I(), Math.PI / n)));
  return parts;
}

/**
 * The gallery balustrade over a peristyle (Vignola / Palladio proportions: height ≈ 4/5 of the entablature, plinth
 * 1/5, rail 1/6, balusters at half their height apart), with a pedestal over every column.
 */
function balustrade(P, z0, colAngles) {
  const { Dc, segs } = P, Hb = P.balH, rb = P.rA, parts = [];
  const hp = 0.2 * Hb, hr = 0.16 * Hb, hbal = Hb - hp - hr;
  const plinth = scaleH(new Prof(0).fillet(0.7).cymaReversa(0.04 * Dc, 0.3, 4), hp);
  parts.push(part('balustrade-plinth', 'stone', lathe(plinth, rb + 0.3 * Dc, z0, rb - 0.34 * Dc, segs)));
  const rail = scaleH(new Prof(0.02 * Dc).cavetto(0.04 * Dc, 0.3, 4).fillet(0.5).ovolo(0.02 * Dc, 0.2, 4), hr);
  parts.push(part('balustrade-rail', 'stone', lathe(rail, rb + 0.3 * Dc, z0 + Hb - hr, rb - 0.36 * Dc, segs)));
  // pedestals (dies) over the columns
  const pw = 0.95 * Dc;
  const ped = box(-pw / 2, -0.36 * Dc, 0, pw / 2, 0.36 * Dc, Hb - hr + EPS);
  parts.push(part('balustrade-pedestal', 'stone', ped, instances(colAngles.map((a) => mat.mul(mat.Rz(a), mat.T(0, -rb, z0))))));
  // balusters: a vase on a square plinth under a square abacus (Vignola's), turned with few segments
  const w = 0.36 * hbal, u = hbal;
  const vase = revolve([[0, 0.1 * u], [0.4 * w, 0.1 * u], [0.44 * w, 0.14 * u], [0.3 * w, 0.18 * u], [0.46 * w, 0.32 * u], [0.47 * w, 0.42 * u],
    [0.36 * w, 0.54 * u], [0.2 * w, 0.66 * u], [0.15 * w, 0.72 * u], [0.22 * w, 0.75 * u], [0.22 * w, 0.78 * u], [0.16 * w, 0.8 * u],
    [0.32 * w, 0.86 * u], [0.42 * w, 0.9 * u], [0, 0.9 * u]], 12);
  const bal = union([box(-w / 2, -w / 2, 0, w / 2, w / 2, 0.1 * u + EPS), vase, box(-0.48 * w, -0.48 * w, 0.9 * u - EPS, 0.48 * w, 0.48 * w, u)]);
  const xf = [], step = TAU / colAngles.length, half = (pw / 2 + 0.3 * w) / rb, sp = 0.5 * hbal;
  for (const a of colAngles) {
    const a0 = a + half, a1 = a + step - half, m = Math.max(1, Math.floor(((a1 - a0) * rb) / sp));
    for (let j = 0; j < m; j++) xf.push(mat.mul(mat.Rz(a0 + ((j + 0.5) * (a1 - a0)) / m), mat.T(0, -rb, z0 + hp - EPS)));
  }
  parts.push(part('baluster', 'stone', bal, instances(xf)));
  return parts;
}

function baseRingParts(P) {
  const ring = lathe(P.baseProf, P.rBase, 0, 0, P.segs);
  return [part('base-ring', 'stone', ring)];
}

/** One rib following the meridian `c` on the front (-Y) meridian plane, tapering with the radius; ends buried. */
function ribSolid(c, w0, h0, R, embed) {
  const rings = [];
  for (let i = 0; i < c.length; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)], p = c[i];
    const dr = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dr, dz) || 1;
    const nr = dz / l, nz = -dr / l;                       // outward normal in (r, z)
    const k = p[0] / R, w = w0 * (0.45 + 0.55 * k), h = h0 * (0.65 + 0.35 * k);
    const sec = [[-w / 2, -embed], [w / 2, -embed], [w / 2, 0.5 * h], [0.3 * w, h], [-0.3 * w, h], [-w / 2, 0.5 * h]];
    rings.push(sec.map(([u, v]) => [u, -(p[0] + v * nr), p[1] + v * nz]));
  }
  const dir = [0, -(c[1][0] - c[0][0]), c[1][1] - c[0][1]];
  return sweepRings(rings.map((r) => orient(r, dir)));
}

/**
 * St Peter's lucarnes (one tier of its three): a small aedicule in every gore between the ribs, its front standing
 * on the shell a fifth of the way up, an arched light under a triangular pediment, its body running back into the shell.
 */
function domeLucarnes(P, c) {
  const rise = c[c.length - 1][1] - P.zS, zl = P.zS + 0.18 * rise;
  const rAt = (z) => { for (let i = 1; i < c.length; i++) if (c[i][1] >= z) { const a = c[i - 1], b = c[i], t = (z - a[1]) / (b[1] - a[1]); return a[0] + t * (b[0] - a[0]); } return 0; };
  const rl = rAt(zl), lw = 0.3 * ((TAU * rl) / P.ribs), lh = 1.45 * lw, ph = 0.26 * lw, o = 0.08 * lw;
  const dep = rl - rAt(zl + lh + ph) + 0.15 * lw;
  const yf = -rl;
  let body = extrudeElevation([[-lw / 2, zl - 0.2 * lw], [lw / 2, zl - 0.2 * lw], [lw / 2, zl + lh], [-lw / 2, zl + lh]], dep + 0.2 * lw, yf);
  const ow = 0.56 * lw, oh = 0.78 * lh, out = windowOutline(ow, oh, zl + 0.1 * lh, 12);
  body = body.subtract(extrudeElevation(out, 0.1 * lw, yf - 0.05 * lw));
  const ped = extrudeElevation([[-lw / 2 - o, zl + lh], [lw / 2 + o, zl + lh], [0, zl + lh + ph]], dep, yf - 0.04 * lw);
  const corn = extrudeElevation([[-lw / 2 - o, zl + lh - 0.07 * lw], [lw / 2 + o, zl + lh - 0.07 * lw], [lw / 2 + o, zl + lh + EPS], [-lw / 2 - o, zl + lh + EPS]], dep, yf - 0.06 * lw);
  const sill = extrudeElevation([[-lw / 2 - o, zl + 0.06 * lh], [lw / 2 + o, zl + 0.06 * lh], [lw / 2 + o, zl + 0.1 * lh], [-lw / 2 - o, zl + 0.1 * lh]], 0.2 * lw, yf - 0.06 * lw);
  const a0 = P.ribAngle0 + Math.PI / P.ribs;
  return [part('dome-lucarne', 'stone', union([body, ped, corn, sill]), radial(P.ribs, mat.I(), a0)),
    part('lucarne-glass', 'glass', extrudeElevation(out, 0.01 * lw, yf + 0.04 * lw), radial(P.ribs, mat.I(), a0))];
}

function seamSolid(c, rs) { return tube(c.map(([r, z]) => [0, -r, z]), rs, 6); }

/** Shell, foot ring, ribs or seams, lantern or oculus or crown boss, finial. */
function upperParts(P, spec) {
  const { segs, D, R } = P, parts = [];
  const shellRole = STONY.has(spec.material) ? 'stone' : 'roof';
  const rFoot = P.onion ? 0.82 * R : R;
  parts.push(part('dome-foot', 'stone', lathe(P.footProf, rFoot, P.zS - 0.4 * P.footH, 0.6 * rFoot, segs)));
  // the shell, cut where the lantern / boss / eye begins
  let c = P.curve, zCut = null;
  if (P.lantern) zCut = P.zL0 + 0.5 * P.hLp;
  else if (!P.oculus) zCut = P.zBoss + 0.5 * P.hBoss;
  let shell;
  if (P.oculus) {
    const eye = P.lantern ? P.rLp * 0.62 : P.rOc;
    shell = shellSolid(c, segs, { eye, t: P.tSh || 0.035 * D });
  } else shell = shellSolid(clipZ(c, zCut), segs);
  const meta = { domeType: P.type, profile: P.prof, ribs: P.ribs };
  if (spec.oculus && P.onion) meta.warning = 'an onion has no oculus: its crown is the spike that carries the cross';
  if (P.oculus && P.lantern) meta.note = 'oculus under an open lantern (the eye lights the dome through a ring of columns)';
  if (P.type === 'ribbed' && !P.ribs) meta.note = 'ribbed dome asked with 0 ribs: the pointed ribbed profile, smooth';
  parts.push(part('dome-shell', shellRole, shell, null, meta));
  if (P.steps) {
    // the Pantheon's step rings: five risers up the haunch to 30° (they load the haunch of a Roman concrete dome)
    const k = 5, zs = Array.from({ length: k + 1 }, (_, i) => P.zS + (i / k) * P.stepTop);
    const rAt = (z) => { for (let i = 1; i < c.length; i++) if (c[i][1] >= z) { const a = c[i - 1], b = c[i], t = (z - a[1]) / (b[1] - a[1]); return a[0] + t * (b[0] - a[0]); } return 0; };
    const stair = [];
    for (let i = 0; i < k; i++) stair.push([rAt(zs[i]) + P.stepOut, zs[i]], [rAt(zs[i]) + P.stepOut, zs[i + 1]]);
    const back = offsetIn(clipZ(c, zs[k]), 0.5 * (P.tSh || 0.035 * D)).reverse();
    parts.push(part('step-rings', shellRole, revolve([...stair, ...back], segs)));
  }
  // ribs (instanced) from the springing to the lantern pedestal / boss / curb
  const rTop = P.lantern ? P.rLp * 0.8 : P.oculus ? P.rOc + P.curbW * 0.5 : P.rBoss * 0.8;
  if (P.ribs) {
    const rc = clipR(c, rTop);
    const ribRole = spec.material === 'terracotta' || spec.material === 'brick' ? 'stone' : shellRole;
    parts.push(part('rib', ribRole, ribSolid(rc, P.ribW, P.ribH, R, 0.006 * D), radial(P.ribs, mat.I(), P.ribAngle0), { ribs: P.ribs }));
    if (P.type === 'ribbed' && P.detail === 'high' && P.ribs >= 8 && !P.cup) parts.push(...domeLucarnes(P, c));
  } else if (P.seams) {
    const sc = clipR(c, rTop + 0.02 * D);
    parts.push(part('seam', shellRole, seamSolid(sc.slice(1), P.seams.rs), radial(P.seams.ns, mat.I(), P.seams.a0)));
  }
  if (P.lantern) parts.push(...lanternParts(P, spec));
  else if (P.oculus) {
    const z0 = P.zCurb - 0.004 * D;
    const curb = scaleH(new Prof(P.curbW).fillet(0.3).ovolo(0.004 * D, 0.4, 6).fillet(0.3, -0.002 * D), P.zTop - z0);
    parts.push(part('oculus-curb', 'stone', lathe(curb, P.rOc, z0, P.rOc, segs)));
  } else {
    parts.push(part('crown-boss', 'metal', crownBoss(P, Math.max(24, segs >> 1))));
    parts.push(...finialAt(P.finial, P.Hf, P.rbF, segs, P.russian, P.zF));
  }
  return parts;
}

/** The moulded boss on the crown (or on the lantern's cap) that carries the finial; sunk a little into the shell, its top
 *  exactly at zBoss + hBoss. */
function crownBoss(P, sg) {
  const sink = 0.002 * P.D;
  const boss = scaleH(new Prof(0).fillet(0.25).ovolo(-0.25 * P.rBoss, 0.45, 6).fillet(0.3, -0.1 * P.rBoss), P.hBoss + sink);
  return lathe(boss, P.rBoss, P.zBoss - sink, 0, sg);
}

/** A finial whose top is exactly z + h, its foot sunk a little into what carries it. */
function finialAt(kind, h, rb, segs, russian, z) {
  const ov = Math.min(EPS, 0.1 * h);
  return placeAt(finialParts(kind, h + ov, rb, segs, russian), z - ov);
}

function placeAt(parts, z) {
  const T = mat.T(0, 0, z);
  return parts.map((p) => ({ ...p, transforms: p.transforms
    ? instances(Array.from({ length: p.transforms.length / 16 }, (_, i) => mat.mul(T, p.transforms.subarray(16 * i, 16 * i + 16))))
    : instances([T]) }));
}

/** Lantern: pedestal on the shell, a core with eight arched lights between columns (or an open ring of columns over an
 *  oculus), entablature, attic, a small cap dome of the main dome's kind, finial. */
function lanternParts(P, spec) {
  const { segs, Dl } = P, parts = [], sg = Math.max(32, segs >> 1);
  const z0 = P.zL0 - 0.012 * P.D;
  const ped = new Prof(0).fillet(P.zL0 - z0);
  const pedP = stackProf(ped, P.lpProf);
  const rInPed = P.open ? P.rLp * 0.62 : 0;
  parts.push(part('lantern-pedestal', 'stone', lathe(pedP, P.rLp - pMax(P.lpProf), z0, rInPed, sg), null,
    P.open ? { warning: 'lantern and oculus both asked: the lantern stands open over the eye' } : {}));
  const zc = P.zL0 + P.hLp, Hc = P.Hcl;
  const nL = 8;
  if (!P.open) {
    const t = 0.06 * Dl, Ww = Math.min(0.34 * Hc, 0.55 * (TAU * P.rCore) / nL), out = windowOutline(Ww, 2 * Ww, zc + 0.12 * Hc, 10);
    let core = revolve([[P.rCore - t, zc - EPS], [P.rCore, zc - EPS], [P.rCore, zc + Hc + EPS], [P.rCore - t, zc + Hc + EPS]], sg);
    const cut = cutterAt(out, P.rCore, t);
    core = core.subtract(union(Array.from({ length: nL }, (_, i) => cut.rotate([0, 0, (i * 360) / nL]))));
    parts.push(part('lantern-core', 'stone', core));
    parts.push(part('lantern-glass', 'glass', extrudeElevation(out, 0.01 * Dl, -(P.rCore - t * 0.4)), radial(nL)));
  }
  const piers = Array.from({ length: nL }, (_, i) => ((i + 0.5) * TAU) / nL);
  if (P.classical && P.detail !== 'low') {
    const col = liteColumn(P.order, Hc, segs, 1);
    parts.push(...replicate(col.parts.map((p) => ({ ...p, name: 'lantern-' + p.name })), piers.map((a) => mat.mul(mat.Rz(a), mat.T(0, -P.rCol, zc - EPS)))));
  } else {
    const pil = litePilaster(1.2 * P.Dcl, Hc, 0.3 * P.Dcl, 0.2 * P.Dcl);
    parts.push(part('lantern-pilaster', 'stone', pil, instances(piers.map((a) => mat.mul(mat.Rz(a), mat.T(0, -P.rCore, zc - EPS))))));
  }
  const rA = P.rCol + 0.5 * P.Dcl * 0.83;
  const zE = zc + Hc;
  const rInE = P.open ? P.rCol - 0.7 * P.Dcl : 0;
  parts.push(part('lantern-entablature', 'stone', lathe(P.lent.prof, rA, zE, rInE, sg)));
  const attic = scaleH(new Prof(0).fillet(0.7).ovolo(0.01 * Dl, 0.3, 4), P.Hal);
  const rAt = P.rCap + 0.02 * Dl;
  parts.push(part('lantern-attic', 'stone', lathe(attic, rAt, zE + P.lent.total - EPS, 0, sg)));
  // cap dome
  const zCut = P.zBoss + 0.5 * P.hBoss;
  const shellRole = STONY.has(spec.material) ? 'stone' : 'roof';
  parts.push(part('lantern-dome', shellRole, shellSolid(clipZ(P.capCurve, zCut), sg)));
  if (P.ribs) {
    const rc = clipR(P.capCurve, P.rBoss * 0.8);
    parts.push(part('lantern-rib', shellRole, ribSolid(rc, 0.2 * P.rCap, 0.05 * P.rCap, P.rCap, 0.01 * P.rCap), radial(nL, mat.I(), Math.PI / nL)));
  }
  parts.push(part('crown-boss', 'metal', crownBoss(P, sg)));
  parts.push(...finialAt(P.finial, P.Hf, P.rbF, segs, P.russian, P.zF));
  return parts;
}

// ================================================================================================ cupola geometry

function cupolaLowerParts(P) {
  const { D, sides } = P, parts = [];
  // base box with sunk panels on its faces
  let curb = polyLathe(P.curbProf, 4, P.aCurb, 0);
  if (P.detail !== 'low') {
    const pw = P.aCurb * 1.25, ph = P.hCurb * 0.5, z0 = P.hCurb * 0.2, dpt = 0.012 * D;
    const pan = box(-pw / 2, -P.aCurb - 0.1, z0, pw / 2, -P.aCurb + dpt, z0 + ph);
    curb = curb.subtract(union([0, 1, 2, 3].map((k) => pan.rotate([0, 0, 90 * k]))));
  }
  parts.push(part('cupola-base', 'stone', curb));
  const z0 = P.zSt, a = P.aSt;
  parts.push(part('stage-plinth', 'stone', polyLathe(P.stPlProf, sides, a, z0)));
  const zw0 = z0 + P.plH - EPS, zw1 = z0 + P.Hs - P.entH + EPS;
  const outerCS = K().CrossSection.ofPolygons([ngon(sides, a)]), innerCS = K().CrossSection.ofPolygons([ngon(sides, a - P.tw)]);
  let wall = extrudeXY(outerCS.subtract(innerCS), zw1 - zw0).translate([0, 0, zw0]);
  const out = windowOutline(P.Ww, P.Hw, P.zw, P.detail === 'low' ? 8 : 14);
  const cut = extrudeElevation(out, P.tw + 0.4 * D, -(a + 0.1 * D));
  const ops = [];
  for (let i = 0; i < sides; i++) for (const x of P.opX) ops.push(mat.mul(mat.Rz((i * TAU) / sides), mat.T(x, 0, 0)));
  wall = wall.subtract(union(ops.map((m) => cut.transform(m))));
  parts.push(part('stage-wall', 'stone', wall));
  // louvres: slats at 40° in every opening, those in the arch head cut to its chord
  const r = P.Ww / 2, zsp = P.zw + P.Hw - r, slatP = 0.09 * P.Ww;
  const xf = [];
  const nS = Math.floor((P.Hw - 0.2 * r) / slatP);
  for (let j = 0; j < nS; j++) {
    const zz = P.zw + 0.6 * slatP + j * slatP;
    let w = P.Ww;
    if (zz > zsp) { const dz = zz - zsp + 0.4 * slatP; w = 2 * Math.sqrt(Math.max(0, r * r - dz * dz)); }
    if (w < 0.2 * P.Ww) continue;
    for (const m of ops) xf.push(mat.mul(m, mat.T(0, -(a - P.tw * 0.5), zz), mat.Rx(-0.7), mat.S(w + 0.004 * D, 1.5 * slatP, 0.1 * slatP)));
  }
  if (P.detail !== 'low') parts.push(part('louvre', 'wood', box(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5), instances(xf)));
  else parts.push(part('louvre-panel', 'wood', extrudeElevation(out, 0.01 * D, -(a - P.tw * 0.6)), instances(ops)));
  // architrave surrounds with sills and keystones
  const s = P.Ww / 7, cs = K().CrossSection.ofPolygons([out]);
  const band = cs.offset(s, 'Miter').subtract(cs).subtract(K().CrossSection.ofPolygons([[[-P.Ww, P.zw - 2 * s], [P.Ww, P.zw - 2 * s], [P.Ww, P.zw + EPS], [-P.Ww, P.zw + EPS]]]));
  const sill = [[-(r + 1.4 * s), P.zw - 0.8 * s], [r + 1.4 * s, P.zw - 0.8 * s], [r + 1.4 * s, P.zw + 0.1 * s], [-(r + 1.4 * s), P.zw + 0.1 * s]];
  const zk = P.zw + P.Hw;
  const key = [[-0.4 * s, zk - 0.3 * s], [0.4 * s, zk - 0.3 * s], [0.6 * s, zk + 1.2 * s], [-0.6 * s, zk + 1.2 * s]];
  const sur = union([extrudeElevation(band, 0.012 * D + 0.03 * D, -(a + 0.012 * D)), extrudeElevation(sill, 0.05 * D, -(a + 0.022 * D)),
    extrudeElevation(key, 0.05 * D, -(a + 0.02 * D))]);
  parts.push(part('opening-surround', 'stone', sur, instances(ops)));
  const pw = P.pilW, ph = zw1 - zw0, cornerR = a / Math.cos(Math.PI / sides);
  const pil = litePilaster(pw, ph, 0.016 * D, 0.03 * D);
  parts.push(part('stage-pilaster', 'stone', pil, radial(sides, mat.T(0, -cornerR + 0.012 * D, zw0), Math.PI / sides)));
  parts.push(part('stage-entablature', 'stone', polyLathe(P.stEntProf, sides, a, z0 + P.Hs - P.entH)));
  if (sides === 4 && P.detail !== 'low') {
    // urns on the four corners of the square cornice, where the round dome leaves the angles free (Georgian practice)
    const hu = 0.17 * D, urn = finialParts('urn', hu, 0.05 * D, P.segs, false, 'corner-urn');
    const c = 0.84 * a;
    parts.push(...replicate(urn.map((q) => ({ ...q, role: 'stone' })), [0, 1, 2, 3].map((k) => mat.mul(mat.Rz(Math.PI / 4 + (k * Math.PI) / 2), mat.T(0, -c * Math.SQRT2, P.zS - EPS)))));
  }
  return parts;
}

// ================================================================================================ spire

function spirePlan(spec) {
  const W = spec.width, H = spec.height, type = spec.spireType || 'octagonal', mtl = spec.material || 'slate';
  const finial = spec.finial || 'cross';
  const n = type === 'square' ? 4 : 8;
  const hb = Math.min(0.06 * W, 0.04 * H);                   // base course (wall-plate cornice)
  const Hf = finial === 'none' ? 0 : Math.min(0.11 * H, 1.6 * W);
  const capH = Math.min((finial === 'none' ? 0.05 : 0.025) * H, 0.6 * W);
  const zTop = H - Hf;                                        // top of the capstone = foot of the finial
  // apex of the faces: under the finial's foot, or, with no finial, inside the capstone so its point is the top
  const zA = finial === 'none' ? zTop - 0.55 * capH : zTop;
  const aE = 0.47 * W;                                        // eaves apothem, inside the base course
  const aTop = Math.min(0.028 * W, 0.02 * H + 0.004 * W);
  const kick = type === 'broach' ? 0 : 0.035 * W, kickH = type === 'broach' ? 0 : Math.min(0.07 * (zA - hb), 0.45 * W);
  const cover = STONY.has(mtl) ? 'stone' : METAL_SKIN.has(mtl) ? 'seam' : mtl === 'wood' ? 'shingle' : 'slate';
  // coverings, crockets, bands and lucarnes only on something shaped like a spire (pitch > 63°, at least 1 m tall)
  const deco = zA - hb >= W && zA - hb >= 1 && W >= 0.3;
  return { W, H, type, n, hb, Hf, zA, aE, aTop, kick, kickH, finial, cover, mtl, detail: spec.detail || 'high', segs: segsFor(spec.detail),
    hbB: type === 'broach' ? 0.45 * (zA - hb) : 0, deco, rr: Math.min(0.012 * W, 0.06, 0.05 * (zA - hb)), capH, zTop };
}

/** Apothem of the main (above the kick) face plane at z. */
function spireA(S, z) {
  const a0 = S.aE - S.kick;
  return a0 + (S.aTop - a0) * ((z - S.hb) / (S.zA - S.hb));
}

/** Intervals where a horizontal line at v crosses a simple polygon (in face coordinates [u, v]). */
function sliceU(poly, v) {
  const xs = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a[1] <= v && b[1] > v) || (b[1] <= v && a[1] > v)) xs.push(a[0] + ((v - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
  }
  xs.sort((p, q) => p - q);
  const out = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}

/**
 * Slates (or shingles, tiles) in broken-bond courses on a planar face polygon given in 3D. The face frame: U horizontal,
 * V up the slope, N outward. Each slate is an instance of a unit box scaled to (width, length, thickness), lying on the
 * one below it (butt lifted by its thickness); the last slate of a course is cut to the hip.
 */
function slateFace(poly3, sz, out) {
  const [o0] = poly3;
  // frame: U along the lowest horizontal edge direction, N outward (polygon CCW seen from outside)
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < poly3.length; i++) {
    const a = poly3[i], b = poly3[(i + 1) % poly3.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const nl = Math.hypot(nx, ny, nz); const N = [nx / nl, ny / nl, nz / nl];
  let U = [-N[1], N[0], 0]; const ul = Math.hypot(U[0], U[1]) || 1; U = [U[0] / ul, U[1] / ul, 0];
  const V = [N[1] * U[2] - N[2] * U[1], N[2] * U[0] - N[0] * U[2], N[0] * U[1] - N[1] * U[0]];
  const vmin = Math.min(...poly3.map((p) => (p[0] - o0[0]) * V[0] + (p[1] - o0[1]) * V[1] + (p[2] - o0[2]) * V[2]));
  const uv = poly3.map((p) => { const d = [p[0] - o0[0], p[1] - o0[1], p[2] - o0[2]]; return [d[0] * U[0] + d[1] * U[1], d[0] * V[0] + d[1] * V[1] + d[2] * V[2] - vmin]; });
  const vmax = Math.max(...uv.map((q) => q[1]));
  const { e, w, l, t } = sz;
  const tilt = Math.atan2(t, e);
  const R = [U[0], U[1], U[2], 0, V[0], V[1], V[2], 0, N[0], N[1], N[2], 0, 0, 0, 0, 1];
  const ucen = (Math.min(...uv.map((q) => q[0])) + Math.max(...uv.map((q) => q[0]))) / 2;
  for (let k = 0; ; k++) {
    const v0 = k * e;
    if (v0 + l > vmax) break;                                // the top slate ends below the apex (capstone / finial)
    const ivs = sliceU(uv, Math.min(vmax - 1e-6, v0 + e));
    const st = (k % 2) * 0.5 * w;
    for (const [u0, u1] of ivs) {
      const j0 = Math.floor((u0 - ucen - st) / w), j1 = Math.ceil((u1 - ucen - st) / w);
      for (let j = j0; j < j1; j++) {
        const a = Math.max(u0, ucen + st + j * w), b = Math.min(u1, ucen + st + (j + 1) * w);
        const ww = b - a - 0.025 * w;
        if (ww < 0.18 * w) continue;
        const uc = (a + b) / 2, vc = v0 + l / 2;
        const P0 = [o0[0] + U[0] * uc + V[0] * (vc + vmin), o0[1] + U[1] * uc + V[1] * (vc + vmin), o0[2] + V[2] * (vc + vmin)];
        const off = t * 0.5 + t * 0.6;
        const T = mat.T(P0[0] + N[0] * off, P0[1] + N[1] * off, P0[2] + N[2] * off);
        out.push(mat.mul(T, Float64Array.from(R), mat.Rx(-tilt), mat.S(ww, l, t)));
      }
    }
  }
}

function spireParts(S, spec) {
  const { W, n, hb, zA, aE, aTop, segs } = S, parts = [];
  const roleCover = S.cover === 'stone' ? 'stone' : 'roof';
  // base course: plinth fillet, cavetto and a projecting cyma — its widest member is the full width W
  const bprof = scaleH(new Prof(-0.025 * W).fillet(0.35).ovolo(0.01 * W, 0.2, 4).fillet(0.1, 0.004 * W).cymaRecta(0.011 * W, 0.3, 6)
    .fillet(0.05, 0.0), hb);
  const bmax = pMax(bprof);
  parts.push(part('spire-base', 'stone', polyLathe(bprof, S.type === 'octagonal' ? 8 : 4, W / 2 - bmax, 0)));
  if (spec.style === 'art-deco' && S.deco) return decoSpire(S, parts, roleCover);
  // body
  const ring = (a, nn = n) => ngon(nn, a);
  let body;
  const z0 = hb - EPS;
  if (S.type === 'broach') {
    const oct = loft([ring(aE, 8), ring(aTop, 8)], [z0, zA]);
    const zb = hb + S.hbB;
    const sq = loft([ring(aE, 4), ring(0.004 * W, 4)], [z0, zb]);
    body = union([oct, sq]);
  } else {
    const zK = hb + S.kickH;
    body = loft([ring(aE), ring(spireA(S, zK)), ring(aTop)], [z0, zK, zA]);
  }
  parts.push(part('spire', roleCover, body, null, { spireType: S.type }));
  // geometry of the faces (for slates, hips, lucarnes)
  const corners = (a, nn, z) => ngon(nn, a).map(([x, y]) => [x, y, z]);
  const faces = [];                                          // planar polygons, CCW from outside
  const hips = [];
  if (S.type === 'broach') {
    const B = corners(aE, 8, hb), A = corners(aTop, 8, zA), a = aE;
    // broach top T on each square corner hip: (1/√2)(1 - s/hb) = (1/2)(1 - s/Hs) in units of the apothem
    const Hs = zA - hb, s = (1 / Math.SQRT2 - 0.5) / (1 / Math.SQRT2 / S.hbB - 0.5 / Hs);
    const Tz = hb + s, Tr = a * Math.SQRT2 * (1 - s / S.hbB);
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      const ang = Math.PI / 8 + (i * TAU) / 8 + Math.PI / 8;       // face normal angle
      const diagonal = i % 2 === 0;
      if (!diagonal) faces.push([B[i], B[j], A[j], A[i]]);
      else {
        const k = Math.round((ang - Math.PI / 4) / (Math.PI / 2));
        const ca = Math.PI / 4 + k * (Math.PI / 2);
        const T = [Tr * Math.cos(ca), Tr * Math.sin(ca), Tz];
        faces.push([B[i], T, B[j], A[j], A[i]]);
      }
      hips.push([B[j], A[j]]);
    }
    // broach triangles: square-pyramid face parts between the square corner C, the octagon foot O and the top T
    for (let k = 0; k < 4; k++) {
      const ca = Math.PI / 4 + k * (Math.PI / 2);
      const Cc = [a * Math.SQRT2 * Math.cos(ca), a * Math.SQRT2 * Math.sin(ca), hb];
      const T = [Tr * Math.cos(ca), Tr * Math.sin(ca), Tz];
      const iBefore = (2 * k) % 8, iAfter = (2 * k + 1) % 8;     // octagon vertices either side of the corner
      faces.push([B[iBefore], Cc, T]);
      faces.push([Cc, B[(iAfter + 0) % 8], T]);
      hips.push([Cc, T]);
    }
  } else {
    const zK = hb + S.kickH, aK = spireA(S, zK);
    const B = corners(aE, n, hb), K1 = corners(aK, n, zK), A = corners(aTop, n, zA);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (S.kickH > 0) faces.push([B[i], B[j], K1[j], K1[i]]);
      faces.push([K1[i], K1[j], A[j], A[i]]);
      hips.push(S.kickH > 0 ? [B[j], K1[j], A[j]] : [B[j], A[j]]);
    }
  }
  // covering
  const slant = Math.hypot(zA - hb, aE - aTop);
  if (S.deco && S.detail === 'high' && (S.cover === 'slate' || S.cover === 'shingle')) {
    const e0 = S.cover === 'shingle' ? 0.12 : 0.17;
    // real slates (0.25 × 0.4 m, 0.17 m gauge) unless the spire is small (≥ 5 to a face) or huge (≤ 110 courses)
    const e = Math.max(slant / 110, Math.min(e0, slant / 16, W / 10));
    const sz = { e, w: (S.cover === 'shingle' ? 1.1 : 1.45) * e, l: 2.3 * e, t: 0.075 * e };
    const xf = [];
    for (const f of faces) slateFace(f, sz, xf);
    parts.push(part(S.cover, 'roof', box(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5), instances(xf)));
  }
  if (S.deco && S.detail !== 'low' && S.cover === 'seam') {
    // standing seams parallel to each face's centre line, ending at the hips
    const xf = [], sp = Math.max(0.45, slant / 40) * (W / 3 > 0.2 ? 1 : W / 0.6);
    for (const f of faces) {
      const mid = f.length === 4 ? f : null;
      if (!mid) continue;
      const [b0, b1, t1, t0] = f;
      const hw = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]) / 2, U = [(b1[0] - b0[0]) / (2 * hw), (b1[1] - b0[1]) / (2 * hw), 0];
      const bc = [(b0[0] + b1[0]) / 2, (b0[1] + b1[1]) / 2, b0[2]], tc = [(t0[0] + t1[0]) / 2, (t0[1] + t1[1]) / 2, t0[2]];
      const thw = Math.hypot(t1[0] - t0[0], t1[1] - t0[1]) / 2;
      const Vv = [tc[0] - bc[0], tc[1] - bc[1], tc[2] - bc[2]], L = Math.hypot(...Vv), V = Vv.map((x) => x / L);
      const N = [U[1] * V[2] - U[2] * V[1], U[2] * V[0] - U[0] * V[2], U[0] * V[1] - U[1] * V[0]];
      const Nn = N[0] * bc[0] + N[1] * bc[1] < 0 ? N.map((x) => -x) : N;
      const ns = Math.floor((2 * hw) / sp);
      for (let k = 1; k < ns; k++) {
        const u = -hw + (k * 2 * hw) / ns;
        // length until the face's half width (tapering from hw to thw) equals |u|
        const fr = Math.abs(u) <= thw ? 1 : (hw - Math.abs(u)) / (hw - thw);
        const len = 0.97 * fr * L;                          // stops short of the apex / hip
        if (len < 0.05 * L) continue;
        const p = [bc[0] + U[0] * u + V[0] * len / 2 + Nn[0] * 0.006 * W, bc[1] + U[1] * u + V[1] * len / 2 + Nn[1] * 0.006 * W, bc[2] + V[2] * len / 2 + Nn[2] * 0.006 * W];
        const Rm = Float64Array.from([U[0], U[1], U[2], 0, V[0], V[1], V[2], 0, Nn[0], Nn[1], Nn[2], 0, 0, 0, 0, 1]);
        xf.push(mat.mul(mat.T(...p), Rm, mat.S(0.008 * W, len, 0.012 * W)));
      }
    }
    if (xf.length) parts.push(part('seam', 'roof', box(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5), instances(xf)));
  }
  // hip rolls (lead) or, on a stone spire, plain hip arrises with crockets
  const rr = S.rr;
  // each roll stops a little short of its top end so its rounded end stays under the apex
  const shorten = (h) => {
    const a = h[h.length - 2], b = h[h.length - 1], L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), k = Math.min(0.5, (2 * rr) / L);
    return [...h.slice(0, -1), [b[0] - (b[0] - a[0]) * k, b[1] - (b[1] - a[1]) * k, b[2] - (b[2] - a[2]) * k]];
  };
  const hipM = union(hips.map((h) => tube(shorten(h), rr, 8)));
  parts.push(part('hip', roleCover === 'stone' ? 'stone' : 'roof', hipM));
  if (S.deco && S.cover === 'stone' && S.detail !== 'low') {
    // Gothic crockets: curled leaves climbing the hips about every metre (Salisbury, Freiburg), and two moulded bands
    const nk = S.detail === 'high' ? 10 : 6, xf = [];
    // one crocket: a stalk springing from the hip and curling over into a bud, with two side lobes (local front -Y)
    const q = 0.8 * W, M = K().Manifold;
    const hook = tube([[0, 0.012 * q, -0.01 * q], [0, -0.022 * q, 0.028 * q], [0, -0.046 * q, 0.064 * q], [0, -0.056 * q, 0.098 * q],
      [0, -0.046 * q, 0.122 * q], [0, -0.028 * q, 0.13 * q]], (s) => q * (0.022 - 0.01 * s), 8);
    const leaf = union([hook, M.sphere(0.026 * q, 10).translate([0, -0.026 * q, 0.122 * q]),
      M.sphere(0.019 * q, 8).translate([0.024 * q, -0.036 * q, 0.06 * q]), M.sphere(0.019 * q, 8).translate([-0.024 * q, -0.036 * q, 0.06 * q])]);
    for (const h of hips.slice(0, S.type === 'broach' ? 8 : n)) {
      const a = h[0], b = h[h.length - 1];
      for (let k = 1; k <= nk; k++) {
        const t = 0.16 + (0.78 * (k - 1)) / nk, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        const ang = Math.atan2(p[1], p[0]);
        const k2 = 1 - 0.55 * t, ra = Math.hypot(p[0], p[1]) - 0.015 * W * k2;
        xf.push(mat.mul(mat.T(ra * Math.cos(ang), ra * Math.sin(ang), p[2] - 0.02 * W * k2), mat.Rz(ang + Math.PI / 2), mat.S(k2)));
      }
    }
    parts.push(part('crocket', 'stone', leaf, instances(xf)));
    const bands = [];
    for (const t of [0.34, 0.64]) {
      const z = hb + t * (zA - hb), bh = 0.035 * W, pr = 0.022 * W;
      const pb = new Prof(0).fillet(0.2 * bh).ovolo(pr, 0.4 * bh, 4).fillet(0.25 * bh).slope(-pr, 0.15 * bh);
      const nn = S.type === 'square' ? 4 : 8;
      bands.push(loft(pb.pts.map(([q, h]) => ngon(nn, spireA(S, z + h) + q + 0.002 * W)), pb.pts.map(([, h]) => z + h)));
    }
    parts.push(part('band', 'stone', union(bands)));
  }
  // lucarnes (high): gabled openings on the cardinal faces near the foot, smaller ones higher on the diagonals
  if (S.deco && S.detail === 'high' && zA - hb > 1.5 * W) {
    const tiers = [{ z: hb + 0.13 * (zA - hb), k: 1, ang0: 0 }];
    if (S.type !== 'square') tiers.push({ z: hb + 0.42 * (zA - hb), k: 0.62, ang0: Math.PI / 4 });
    for (const [ti, tr] of tiers.entries()) {
      const a = S.type === 'broach' && ti === 0 ? spireA({ ...S, kick: 0 }, tr.z) : spireA(S, tr.z);
      // the front stands proud of the face by a tenth of its width; its breast runs down to meet the slope
      const lw = 0.26 * W * tr.k, lh = 0.34 * W * tr.k, pitchH = 0.5 * lw, dep = 0.55 * W * tr.k, pr = 0.1 * lw;
      const steep = (zA - hb) / Math.max(1e-6, S.aE - S.kick - aTop), drop = pr * steep + 0.03 * lw;
      const ow = 0.52 * lw, oh = 0.66 * lh, oz = 0.12 * lh;
      const front = [[-lw / 2, -drop], [lw / 2, -drop], [lw / 2, lh], [0, lh + pitchH], [-lw / 2, lh]];
      let body = extrudeElevation(front, dep + pr, -pr);
      const outl = windowOutline(ow, oh, oz, 10);
      body = body.subtract(extrudeElevation(outl, 0.08 * lw, -pr - 0.02 * lw));
      // roof: two slabs at the gable pitch, oversailing the front and the cheeks; a sill; a knop on the apex
      const rl = Math.hypot(lw / 2, pitchH) + 0.12 * lw, rt2 = 0.07 * lw, slope = (Math.atan2(pitchH, lw / 2) * 180) / Math.PI;
      const rh1 = box(-rl, -pr - 0.1 * lw, 0, 0, dep, rt2).rotate([0, -slope, 0]).translate([0, 0, lh + pitchH]);
      const rh2 = box(0, -pr - 0.1 * lw, 0, rl, dep, rt2).rotate([0, slope, 0]).translate([0, 0, lh + pitchH]);
      const sillB = box(-0.36 * lw, -pr - 0.07 * lw, oz - 0.05 * lw, 0.36 * lw, -pr + 0.1 * lw, oz + 0.005 * lw);
      const L = union([body, rh1, rh2, sillB]).translate([0, -a, tr.z]);
      // louvre boards in the light
      const slats = [];
      const nsl = 5;
      for (let j = 0; j < nsl; j++) slats.push(box(-ow / 2, -0.022 * lw, -0.01 * lw, ow / 2, 0.022 * lw, 0.01 * lw).rotate([40, 0, 0]).translate([0, -pr + 0.035 * lw, oz + (j + 0.6) * (oh - ow / 2) / nsl]));
      const knop = K().Manifold.sphere(0.06 * lw, 10).translate([0, 0, lh + pitchH + rt2 + 0.04 * lw]);
      const nn4 = radial(4, mat.T(0, -a, tr.z), tr.ang0);
      parts.push(part(ti === 0 ? 'lucarne-louvre' : 'lucarne-upper-louvre', 'wood', union(slats), nn4));
      parts.push(part(ti === 0 ? 'lucarne-knop' : 'lucarne-upper-knop', 'metal', knop, nn4));
      const nn = S.type === 'square' ? 4 : 4;
      parts.push(part(ti === 0 ? 'lucarne' : 'lucarne-upper', roleCover, L, radial(nn, mat.I(), tr.ang0)));
    }
  }
  // capstone collar and finial
  const capH = S.capH, capR = aTop * 1.5;
  const capP = capstoneProf(capR, capH, S.finial);
  parts.push(part('capstone', 'metal', lathe(capP, capR, S.zTop - capH, 0, 32)));
  parts.push(...finialAt(S.finial, S.Hf, capR * 0.9, segs, spec.style === 'russian', S.zTop));
  return parts;
}

/** The lead capstone at the apex: a moulded collar that seats the finial, or, with no finial, a collar finished in a
 *  short point so the spire ends cleanly at its stated height. */
function capstoneProf(capR, capH, finial) {
  if (finial === 'none') return scaleH(new Prof(0).fillet(0.12).ovolo(0.25 * capR, 0.18, 4).fillet(0.12, -0.1 * capR).slope(-1.15 * capR, 0.58), capH);
  return scaleH(new Prof(0).fillet(0.3).ovolo(0.25 * capR, 0.35, 4).fillet(0.35, -0.1 * capR), capH);
}

/**
 * Art Deco spire (Chrysler, the Empire State mast): four set-back tiers, each a prism whose faces carry a stepped
 * "sunburst" light and whose corners carry metal fins, the tiers stepping in by a fifth; then a needle to the finial.
 */
function decoSpire(S, parts, role) {
  const { W, n, hb, zA, aE, aTop, segs } = S;
  const Hb = zA - hb, hs = [0.15, 0.125, 0.105, 0.09].map((k) => k * Hb);
  const tiers = [], fins = [], lights = [];
  let z = hb - EPS;
  const nn = n === 8 ? 8 : 4;
  for (let i = 0; i < 4; i++) {
    const a = aE * (1 - 0.19 * i), a1 = aE * (1 - 0.19 * (i + 1)) * 1.03, h = hs[i];
    // prism, then a two-step set-back to the next tier
    tiers.push(loft([ngon(nn, a), ngon(nn, a), ngon(nn, 0.5 * (a + a1)), ngon(nn, 0.5 * (a + a1)), ngon(nn, a1)],
      [z, z + 0.72 * h, z + 0.72 * h, z + 0.86 * h, z + h + EPS]));
    const fw = 2 * a * Math.tan(Math.PI / nn);
    // sunburst light: a stepped triangle of dark glass on every face
    lights.push(...Array.from({ length: nn }, (_, k) => mat.mul(mat.Rz((k * TAU) / nn), mat.T(0, -a - 0.002 * W, z + 0.12 * h), mat.S(0.42 * fw, 0.004 * W, 0.56 * h))));
    // corner fins
    const rc = a / Math.cos(Math.PI / nn);
    fins.push(...Array.from({ length: nn }, (_, k) => mat.mul(mat.Rz(Math.PI / nn + (k * TAU) / nn), mat.T(0, -rc - 0.008 * W, z + 0.36 * h), mat.S(0.012 * W, 0.03 * W, 0.72 * h))));
    z += h;
  }
  parts.push(part('tier', role, union(tiers)));
  // a unit stepped triangle (base 1 wide, 1 high) facing -Y, 0.01 deep
  const st = [];
  for (let k = 0; k < 4; k++) st.push(box(-0.5 + 0.125 * k, -0.6, 0.25 * k, 0.5 - 0.125 * k, 0.4, 0.25 * (k + 1) + 0.001));
  parts.push(part('deco-light', 'glass', union(st), instances(lights)));
  parts.push(part('fin', 'metal', box(-0.5, -0.5, -0.5, 0.5, 0.5, 0.5), instances(fins)));
  // needle: a slender octagonal pyramid with ribbed arrises
  const a0 = aE * (1 - 0.19 * 4) * 1.03;
  parts.push(part('needle', role, loft([ngon(8, a0), ngon(8, aTop)], [z - EPS, zA])));
  const rN = Math.min(0.006 * W, 0.4 * a0), zN = zA - 2 * rN, aN = aTop + ((a0 - aTop) * 2 * rN) / (zA - z);
  const hip = tube([[a0 / Math.cos(Math.PI / 8), 0, z], [aN / Math.cos(Math.PI / 8), 0, zN]], rN, 6);
  parts.push(part('needle-rib', 'metal', hip, radial(8, mat.Rz(Math.PI / 8 - Math.PI / 2))));
  const capH = S.capH, capR = aTop * 1.5;
  const capP = capstoneProf(capR, capH, S.finial);
  parts.push(part('capstone', 'metal', lathe(capP, capR, S.zTop - capH, 0, 32)));
  parts.push(...finialAt(S.finial === 'cross' ? 'spike' : S.finial, S.Hf, capR * 0.9, segs, false, S.zTop));
  return parts;
}

// ================================================================================================ build / expected

export function build(spec) {
  setScale(spec);
  if (spec.element === 'spire') return spireParts(spirePlan(spec), spec);
  const P = domePlan(spec);
  const parts = [];
  if (P.cup) parts.push(...cupolaLowerParts(P));
  else if (P.n) parts.push(...drumParts(P));
  else parts.push(...baseRingParts(P));
  parts.push(...upperParts(P, spec));
  return parts;
}

/**
 * dome / cupola: x = y = the widest ring (drum cornice, podium or base moulding, cupola curb or cornice — never less
 * than the dome itself); z = springing + shell to its seat + lantern stack + finial (see domePlan / upperPlan).
 * spire: x = y = width (the base course), z = height (finial included).
 */
export function expected(spec) {
  const out = { size: {}, counts: {}, tol: 0.005 };
  setScale(spec);
  if (spec.element === 'spire') {
    const S = spirePlan(spec);
    out.size = { x: S.W, y: S.W, z: S.H };
    return out;
  }
  const P = domePlan(spec);
  // rings are symmetric; ribs and seams (radial patterns built on the front meridian) may reach further on an onion
  let x0 = -P.rMax, x1 = P.rMax, y0 = -P.rMax, y1 = P.rMax;
  for (const q of P.pats) for (let k = 0; k < q.n; k++) {
    const f = q.a0 + (k * TAU) / q.n, s = Math.sin(f), c = Math.cos(f);
    x0 = Math.min(x0, q.rho * s - q.hw * Math.abs(c)); x1 = Math.max(x1, q.rho * s + q.hw * Math.abs(c));
    y0 = Math.min(y0, -q.rho * c - q.hw * Math.abs(s)); y1 = Math.max(y1, -q.rho * c + q.hw * Math.abs(s));
  }
  out.size = { x: x1 - x0, y: y1 - y0, z: P.zTop };
  if (P.ribs) out.counts.rib = P.ribs;
  return out;
}
