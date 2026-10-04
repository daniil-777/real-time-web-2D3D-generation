// Carved ornament as solids: acanthus leaf, Ionic volute, egg-and-dart, rosette, spiral helix.
// Local frames: a motif stands on z = 0, grows up +Z and faces -Y (the viewer); place it with mat.* transforms.

import { K, TAU, thickSurface, tube, extrudeXY, crossSection, union } from './kernel.js';

const sstep = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/**
 * Acanthus leaf, height h (to the top of its curl), width w. The blade is lobed (lobes per side) and serrated, cupped,
 * with a raised midrib; its lower part wraps a bell of radius `wrap` (0 = flat) and its tip curls forward and down.
 */
export function acanthusLeaf({ h, w, lobes = 4, curl = 1, lean = 0.1, wrap = 0, t = 0, nu = 36, nv = 96 }) {
  const th = t || Math.max(0.004 * h, 0.012 * w);
  // spine in the YZ plane: rises leaning outward (-Y), then turns over by up to ~150 degrees
  const S = 160, sp = [[0, 0]], ang = [lean];
  for (let i = 1; i <= S; i++) {
    const v = i / S, a = lean + curl * 1.75 * sstep((v - 0.7) / 0.3) ** 1.1;
    const [y, z] = sp[i - 1];
    sp.push([y - Math.sin(a) / S, z + Math.cos(a) / S]);
    ang.push(a);
  }
  const zmax = Math.max(...sp.map((q) => q[1]));
  const k = h / zmax;
  const spine = (v) => {
    const f = v * S, i = Math.min(S - 1, Math.floor(f)), r = f - i;
    return { y: k * (sp[i][0] * (1 - r) + sp[i + 1][0] * r), z: k * (sp[i][1] * (1 - r) + sp[i + 1][1] * r), a: ang[i] * (1 - r) + ang[i + 1] * r };
  };
  const env = (v) => (v < 0.45 ? 0.26 + 0.74 * sstep(v / 0.45) : v < 0.84 ? 1 - 0.42 * sstep((v - 0.45) / 0.39) : 0.58 * Math.sqrt(Math.max(0.02, 1 - ((v - 0.84) / 0.16) ** 2)));
  // lobes: pointed, leaning toward the tip, separated by deep "eyes"; each lobe carries three serrated fingers
  const lobeAt = (v) => {
    const x = ((v - 0.1) / 0.8) * lobes;
    if (x <= 0 || x >= lobes) return { tooth: v >= 0.9 ? 1 : 0.55, f: 0, finger: 0 };
    const f = x - Math.floor(x), g = f ** 0.8;                       // skew: lobes lean toward the tip
    const tooth = Math.sin(Math.PI * g) ** 1.1;
    const finger = Math.abs(Math.sin(Math.PI * g * 3)) ** 0.6;
    return { tooth, f, finger };
  };
  const f = (u, v) => {
    const s = spine(v), uu = 2 * u - 1, L = lobeAt(v), au = Math.abs(uu);
    const half = (w / 2) * env(v) * (0.46 + 0.44 * L.tooth + 0.1 * L.finger * L.tooth);
    let x = uu * half;
    // depth along the spine normal (outward): midrib ridge, cupped blade, lobe tips turning out, raised "pipes" from the
    // midrib to each lobe, and a shadowed hollow ("eye") at each notch
    let d = 0.05 * w * Math.exp(-((uu / 0.07) ** 2)) * (1 - 0.6 * v)
          + 0.12 * w * uu * uu * (0.35 + 0.65 * L.tooth)
          + 0.05 * w * au ** 3 * L.tooth * (0.6 + 0.4 * L.finger)
          + 0.03 * w * Math.exp(-(((au - 0.42) / 0.1) ** 2)) * L.tooth
          - 0.025 * w * Math.exp(-(((au - 0.62) / 0.12) ** 2)) * (1 - L.tooth);
    // wrap the lower blade around the bell (fades out where the leaf turns over)
    let back = 0;
    if (wrap > 0) {
      const fade = 1 - sstep((v - 0.45) / 0.3), a = x / wrap;
      back = fade * wrap * (1 - Math.cos(a));
      x = fade * wrap * Math.sin(a) + (1 - fade) * x;
    }
    const ny = -Math.cos(s.a), nz = -Math.sin(s.a);
    return [x, s.y + ny * d + back, s.z + nz * d];
  };
  const thick = (u, v) => th * (0.4 + 0.6 * (1 - (2 * u - 1) ** 2)) * (1 - 0.2 * v);
  return thickSurface(f, nu, nv, thick);
}

/** Points of a logarithmic spiral in the XZ plane around (0, 0): from radius r0 at the top (angle 0, clockwise toward +X)
 *  inward to radius r1 after `turns` turns. side = +1 spirals toward +X first, -1 mirrored. */
export function spiral(r0, r1, turns, n = 220, side = 1) {
  const kk = Math.log(r0 / r1) / (TAU * turns), out = [];
  for (let i = 0; i <= n; i++) {
    const th = (i / n) * TAU * turns, r = r0 * Math.exp(-kk * th);
    out.push([side * r * Math.sin(th), r * Math.cos(th), r, th]);
  }
  return out;
}

// local (x, y', z) of an XY cross-section extruded along +Z  ->  world (x, -z, y'): the section stands in XZ, depth along -Y
const SECTION_TO_XZ = Float64Array.from([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);

/** Extrude a polygon drawn in elevation (x, z) through depth along Y from y = y0 to y0 + depth. */
export function extrudeElevation(poly, depth, y0 = 0, div = 0) {
  return extrudeXY(poly, depth, { div }).transform(SECTION_TO_XZ).translate([0, y0 + depth, 0]);
}

/**
 * Ionic volute block for one side: a scroll of outer radius r0 seen in elevation (centre at the origin, x toward the
 * outside when side = +1), extruded through `depth` along Y (centred on y = 0) with a waisted bolster, and a spiral
 * channel carved into both faces.
 */
export function voluteScroll({ r0, depth, side = 1, eye = 0.13, turns = 2.75, channel = 0.32, groove = 0.05, pinch = 0.18 }) {
  const { Manifold } = K();
  const re = r0 * eye;
  const sp = spiral(r0, re, turns, 240, side);
  // disc = the area inside the first turn
  const firstTurn = sp.filter((q) => q[3] <= TAU + 1e-9).map(([x, z]) => [x, z]);
  // the hull of the first turn: a round scroll face without the notch where the spiral closes
  const disc = K().CrossSection.hull([crossSection(firstTurn)]);
  let body = extrudeElevation(disc, depth, -depth / 2, 28);
  // the bolster narrows toward its middle (the balteus)
  body = body.warp((v) => {
    const s = 1 - pinch * Math.exp(-((v[1] / (0.22 * depth)) ** 2));
    v[0] *= s; v[2] *= s;
  });
  // spiral channel: a strip between r(th) and r(th)(1 - channel), cut into both faces
  const outer = sp.filter((q) => q[3] <= TAU * (turns - 0.25));
  const strip = [...outer.map(([x, z]) => [x, z]), ...outer.slice().reverse().map(([x, z]) => [x * (1 - channel), z * (1 - channel)])];
  const g = groove * r0;
  const cut = Manifold.union([extrudeElevation(strip, g * 2, -depth / 2 - g), extrudeElevation(strip, g * 2, depth / 2 - g)]);
  body = body.subtract(cut);
  // the eye: a small boss on each face
  const eyeBoss = Manifold.cylinder(depth + g * 0.6, re, re, 32).rotate([90, 0, 0]).translate([0, depth / 2 + g * 0.3, 0]);
  return union([body, eyeBoss]);
}

/** One egg of egg-and-dart (an ellipsoid half sunk in its shell) and one dart; the caller arrays them. Local: egg centred on
 *  the origin, long axis along Z, facing -Y. */
export function eggAndDart({ h, w, d }) {
  const { Manifold } = K();
  const egg = Manifold.sphere(1, 28).scale([w / 2, d / 2, h / 2]);
  const shell = Manifold.sphere(1, 28).scale([w / 2 + w * 0.12, d / 2 * 0.7, h / 2 + w * 0.1]).translate([0, d * 0.18, 0])
    .subtract(Manifold.sphere(1, 28).scale([w / 2 + w * 0.04, d, h / 2 + w * 0.03]).translate([0, -d * 0.1, 0]));
  const dart = Manifold.sphere(1, 12).scale([w * 0.09, d * 0.32, h * 0.52]).translate([0, d * 0.05, -h * 0.05]);
  return { egg: union([egg, shell]), dart };
}

/** Rosette / fleuron of radius r: a boss with `petals` petals, facing -Y, centred on the origin. */
export function rosette(r, petals = 8, depth = 0.35) {
  const { Manifold } = K();
  const parts = [Manifold.sphere(1, 24).scale([r * 0.3, r * depth * 0.9, r * 0.3])];
  for (let i = 0; i < petals; i++) {
    const a = (i * 360) / petals;
    parts.push(Manifold.sphere(1, 18).scale([r * 0.2, r * depth * 0.5, r * 0.5]).translate([0, 0, r * 0.48]).rotate([0, a, 0]));
  }
  return union(parts);
}

/** A helix scroll as a tube: a planar spiral (radius r0 -> r1, turns) lifted by a stalk; used for Corinthian helices. */
export function helixScroll({ r0, r1, turns, rad, stalk = [] }) {
  const sp = spiral(r0, r1, turns, 90, 1).map(([x, z]) => [x, 0, z]);
  const pts = [...stalk, ...sp.map(([x, y, z]) => [x + (stalk.length ? stalk[stalk.length - 1][0] : 0), y, z + (stalk.length ? stalk[stalk.length - 1][2] - r0 : 0)])];
  return tube(pts, (s) => rad * (1 - 0.55 * s), 10);
}

export { crossSection };
