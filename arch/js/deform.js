// Arch Studio deformation engine — a pure ES module (the build worker and Node share it; no DOM, no three.js).
//
// The user asked for "the ability to stretch, deform objects using top geometrical deformation methods, in the browser".
// Three layers, in the order the UI should try them:
//
// 1. smartStretch(spec, axis, factor, size) -> spec' | null
//    A stretch along an axis the element has a parameter for (a column's height, a balustrade's length, a dome's
//    diameter, an arcade's length...) is a re-parameterisation: regenerating with spec' re-arrays the repeated ornament
//    (more balusters, more bays, more dentils) and keeps every proportion rule instead of distorting anything.
//
// 2. Free space deformations f: R3 -> R3, built by makeDeformer(ops, bbox) and composed in order (op 1 first):
//    stretch  1-D "nine-slice" stretch: only the middle zone keep = [a, b] of the extent stretches, capitals and bases
//             keep their size; a C1 ease (smoothstep-integrated rate) at the zone ends avoids a crease in curved
//             profiles that cross the zone boundary (ease: 0 gives the plain piecewise-linear map).
//    bend     Barr's bend (A. H. Barr, "Global and Local Deformations of Solid Primitives", SIGGRAPH 1984): the axis
//             becomes a curve of curvature k(t) = angle * w(t) / len, every cross-section stays perpendicular to it and
//             the neutral (centre) line keeps its length. axis 'x' curves the run in plan (curved balustrade or cornice
//             for a round tower), axis 'z' bows the height sideways. Outside `range` the element continues rigidly
//             (Barr's bending region); with range = [0, 1] the centre line is an exact circular arc.
//    twist    rotation about the axis by angle * P(u) (Barr 1984);
//    taper    cross-section scale 1 + (scale - 1) * P(u) (Barr 1984); past the range end a similar figure; the height
//             and the footprint never change (the range takes back what the similar figure loses, plus a solved lift
//             when rigid ornament at the top shrinks);
//    shear    offset d * P(u), a lean (Barr's "skew"); d in metres (dx dy dz) or relative to the extent (rx ry rz);
//    ffd      trivariate Bernstein free-form deformation over the padded bbox (T. W. Sederberg, S. R. Parry,
//             "Free-Form Deformation of Solid Geometric Models", SIGGRAPH 1986). Control-point offsets come either
//             explicitly or from pins (dragged handles) solved by arapLattice(): As-Rigid-As-Possible deformation of
//             the lattice graph (O. Sorkine, M. Alexa, "As-Rigid-As-Possible Surface Modeling", SGP 2007), so dragging
//             one control point carries its neighbourhood along rigidly instead of shearing it.
//    P(u) is the normalised integral of the window w (0 outside `range`, 1 on its plateau, smoothstep ramps of width
//    `ease` at interior range ends), so every op is C1 along its axis.
//
// 3. deformParts(parts, ops, opts) applies f to an element (Part[] from generate()):
//    - parts tagged meta.rigid by their generator, and untagged small repeated parts (>= 2 instances, mesh bbox
//      diagonal < rigidRatio = RIGID_RATIO, 25 % of the element's) are not deformed: each
//      instance M is replaced by T(f(c)) * s R_J * T(-c) * M, with c the centre of the instance's mesh, R_J the
//      rotation of the polar decomposition J = R_J S of the Jacobian at c (balusters stay upright and true on a curved
//      balustrade, dentils follow a curved cornice undistorted) and s = 1 (scaleInstances false), det(J)^(1/3)
//      (scaleInstances 'volume' or true) or the median singular value of J (scaleInstances 'auto', the default: it is
//      exactly 1 under bend, twist, shear and stretch, so the instances stay rigid, and follows the cross-section under
//      a taper or an FFD bulge, so acanthus leaves shrink with the bell instead of floating off it);
//    - continuous parts (no instances, one instance, or large instanced parts, every instance baked into world space as
//      its own piece) are refined so every edge is shorter than l = min(L / 16, sqrt(8 eps / H)) — L the element extent,
//      H the largest directional second derivative of f (an edge of length l sags l^2 H / 8 off the exact image),
//      eps = L / 4000 — and moved with Manifold.warpBatch: topology is unchanged, so the result stays a closed oriented
//      2-manifold. (The plan's fixed L / 96 refined a 0.66 m capital to 7 mm edges, 1.9 s and +230 k triangles, for a
//      chord error 30x below the visible; the chord rule refines exactly where the map bends.) A piece whose longest
//      edge is already below l is not refined. The refinement is capped so the element stays under maxTris (1.5 M) and
//      the cap is reported. Stretch and shear alone are (piecewise) affine and need no refinement.
//    - fold check: det J <= 0 at any sampled vertex or instance centre -> warnings ['fold'] (the shape passes through
//      itself); a bend whose ends meet (|angle| >= 330°, or a closing gap narrower than the element's depth) ->
//      'overlap'. Exports stay honest; the UI shows the warning.
//
// Ranges: an op's `range` (stretch: `keep`) left out or 'auto' acts on the element's shaft when it has one (column,
// pilaster, obelisk: base, capital and pedestal stay true — resolveOps), else on the whole extent (stretch: [0.12, 0.88]).
// Space: Z-up metres, origin at the base centre, front -Y, length along X (family conventions). Angles in degrees.
// Anchors: ops along z keep the ground (the range start) in place; ops along x or y keep the middle of the range in
// place (a curved balustrade stays centred), except taper, which is 1 at the range start on every axis.
// deformParts re-grounds the result (min z restored) unless ground: false.

import { K, mat, instances, instanceCount, partsBBox } from './kernel.js';
import { SCHEMA, DEFAULTS, normalize } from './spec.js';
import { RIGID_RATIO } from './export.js';

const DEG = Math.PI / 180;
const AXES = { x: 0, y: 1, z: 2 };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const num = (x, d) => (Number.isFinite(+x) && x !== null && x !== '' ? +x : d);
const now = () => (globalThis.performance ? performance.now() : Date.now());

/** Parameter ranges of the free ops, for the UI (sliders) and for validation. */
export const OP_SCHEMA = {
  stretch: { axis: ['x', 'y', 'z'], factor: { min: 0.1, max: 10, default: 1 }, keep: { default: [0.12, 0.88], auto: true }, ease: { min: 0, max: 0.2, default: 0.04 } },
  bend: { axis: ['x', 'y', 'z'], angle: { min: -720, max: 720, default: 0, unit: '°' }, dir: { default: 0, unit: '°' }, range: { default: [0, 1], auto: true }, ease: { default: 0.04 } },
  twist: { axis: ['x', 'y', 'z'], angle: { min: -1440, max: 1440, default: 0, unit: '°' }, range: { default: [0, 1], auto: true }, ease: { default: 0.04 } },
  taper: { axis: ['x', 'y', 'z'], scale: { min: 0.02, max: 50, default: 1 }, range: { default: [0, 1], auto: true }, ease: { default: 0.04 },
    lift: { unit: 'm', default: 0, auto: true } },
  shear: { axis: ['x', 'y', 'z'], dx: { unit: 'm', default: 0 }, dy: { unit: 'm', default: 0 }, dz: { unit: 'm', default: 0 },
    rx: { unit: 'of the extent', default: 0 }, ry: { unit: 'of the extent', default: 0 }, rz: { unit: 'of the extent', default: 0 },
    range: { default: [0, 1], auto: true }, ease: { default: 0.04 } },
  ffd: { dims: { min: 1, max: 12, default: [3, 3, 3] }, pad: { default: 0.04 }, iters: { default: 10 }, reach: { default: 3.5 }, grip: { default: 2.2 }, follow: { default: 3 } },
};

// ================================================================================================ 3x3 linear algebra
// Row-major 3x3 matrices (Float64Array(9) or arrays): a[3 * row + col].

/** Eigen-decomposition of a symmetric 3x3 matrix by cyclic Jacobi rotations (Numerical Recipes 11.1). Eigenvalues are
 *  sorted descending; V holds the eigenvectors in its columns and is a proper rotation (det +1). */
export function eigSym3(a) {
  eigInto(a);
  return { w: [EW[0], EW[1], EW[2]], V: Float64Array.from(EV) };
}

// scratch of eigInto / polarInto: the GPU preview places thousands of rigid instances per drag frame through polar3, so
// the decomposition allocates nothing (results are copied out by the callers that keep them)
const EA = new Float64Array(9), EJ = new Float64Array(9), EV = new Float64Array(9), EW = new Float64Array(3);
const PB = new Float64Array(9), PR = new Float64Array(9), PU = new Float64Array(9), PS = new Float64Array(3);

/** eigSym3 into EW (eigenvalues, descending) and EV (eigenvectors in columns, det +1). Same arithmetic, same order. */
function eigInto(a) {
  const A = EA, V = EJ;
  for (let i = 0; i < 9; i++) { A[i] = a[i]; V[i] = i % 4 === 0 ? 1 : 0; }
  const scale = Math.abs(A[0]) + Math.abs(A[4]) + Math.abs(A[8]) + 1e-300;
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(A[1]) + Math.abs(A[2]) + Math.abs(A[5]);
    if (off <= 1e-17 * scale) break;
    for (let r = 0; r < 3; r++) {
      const p = r === 2 ? 1 : 0, q = r === 0 ? 1 : 2; // (0,1), (0,2), (1,2)
      const apq = A[3 * p + q];
      if (Math.abs(apq) <= 1e-300) continue;
      const theta = (A[3 * q + q] - A[3 * p + p]) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { // A <- A P (columns p, q)
        const akp = A[3 * k + p], akq = A[3 * k + q];
        A[3 * k + p] = c * akp - s * akq; A[3 * k + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) { // A <- P^T A (rows p, q)
        const apk = A[3 * p + k], aqk = A[3 * q + k];
        A[3 * p + k] = c * apk - s * aqk; A[3 * q + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) { // V <- V P
        const vkp = V[3 * k + p], vkq = V[3 * k + q];
        V[3 * k + p] = c * vkp - s * vkq; V[3 * k + q] = s * vkp + c * vkq;
      }
    }
  }
  // stable descending order of the diagonal (what [0, 1, 2].sort((i, j) => A[4 * j] - A[4 * i]) gives): insertion sort
  let o0 = 0, o1 = 1, o2 = 2;
  if (A[4] - A[0] > 0) { o0 = 1; o1 = 0; }
  if (A[8] - A[4 * o1] > 0) { o2 = o1; if (A[8] - A[4 * o0] > 0) { o1 = o0; o0 = 2; } else o1 = 2; }
  EW[0] = A[4 * o0]; EW[1] = A[4 * o1]; EW[2] = A[4 * o2];
  for (let r = 0; r < 3; r++) { EV[3 * r] = V[3 * r + o0]; EV[3 * r + 1] = V[3 * r + o1]; EV[3 * r + 2] = V[3 * r + o2]; }
  if (det3(EV) < 0) for (let r = 0; r < 3; r++) EV[3 * r + 2] = -EV[3 * r + 2];
}

export function det3(a) {
  return a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
}

/**
 * Signed SVD and polar decomposition of a 3x3 matrix A = U diag(s) V^T with U, V proper rotations and s[2] carrying
 * the sign of det A. R = U V^T is the rotation closest to A in the Frobenius norm (the rotation of the polar
 * decomposition A = R S when det A > 0; Kabsch's reflection-free fit otherwise). Via the eigenvectors of A^T A.
 * Returns { R, s, U, V } (row-major).
 * out (optional, for hot loops): { R: Float64Array(9), s: Float64Array(3) } filled in place and returned (U, V and w
 * are not written); nothing is allocated. The numbers are bit-identical either way.
 */
export function polar3(A, out) {
  const ok = polarInto(A);
  if (out) {
    for (let i = 0; i < 9; i++) out.R[i] = PR[i];
    out.s[0] = PS[0]; out.s[1] = PS[1]; out.s[2] = PS[2];
    return out;
  }
  if (!ok) { const I = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1); return { R: I, s: [0, 0, 0], U: I, V: Float64Array.from(EV) }; }
  return { R: Float64Array.from(PR), s: [PS[0], PS[1], PS[2]], U: Float64Array.from(PU), V: Float64Array.from(EV), w: [EW[0], EW[1], EW[2]] };
}

/** polar3 into PR, PS, PU (and EV, EW from eigInto); false when A is (numerically) zero: R = I, s = 0. */
function polarInto(A) {
  const B = PB;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) B[3 * i + j] = A[i] * A[j] + A[3 + i] * A[3 + j] + A[6 + i] * A[6 + j];
  eigInto(B);
  const V = EV;
  // a_k = A v_k (v_k the k-th column of V)
  const a1x = A[0] * V[0] + A[1] * V[3] + A[2] * V[6], a1y = A[3] * V[0] + A[4] * V[3] + A[5] * V[6], a1z = A[6] * V[0] + A[7] * V[3] + A[8] * V[6];
  const a2x = A[0] * V[1] + A[1] * V[4] + A[2] * V[7], a2y = A[3] * V[1] + A[4] * V[4] + A[5] * V[7], a2z = A[6] * V[1] + A[7] * V[4] + A[8] * V[7];
  const a3x = A[0] * V[2] + A[1] * V[5] + A[2] * V[8], a3y = A[3] * V[2] + A[4] * V[5] + A[5] * V[8], a3z = A[6] * V[2] + A[7] * V[5] + A[8] * V[8];
  const s1 = Math.hypot(a1x, a1y, a1z);
  if (!(s1 > 1e-300)) {
    for (let i = 0; i < 9; i++) PR[i] = PU[i] = i % 4 === 0 ? 1 : 0;
    PS[0] = PS[1] = PS[2] = 0;
    return false;
  }
  const u1x = a1x / s1, u1y = a1y / s1, u1z = a1z / s1;
  const d12 = u1x * a2x + u1y * a2y + u1z * a2z;
  let u2x = a2x - d12 * u1x, u2y = a2y - d12 * u1y, u2z = a2z - d12 * u1z;
  let n2 = Math.hypot(u2x, u2y, u2z);
  if (n2 <= 1e-12 * s1) { // rank one: any unit vector perpendicular to u1
    const ex = Math.abs(u1x) < 0.9 ? 1 : 0, ey = Math.abs(u1x) < 0.9 ? 0 : 1, ez = 0;
    const d = u1x * ex + u1y * ey + u1z * ez;
    u2x = ex - d * u1x; u2y = ey - d * u1y; u2z = ez - d * u1z;
    n2 = Math.hypot(u2x, u2y, u2z);
  }
  u2x /= n2; u2y /= n2; u2z /= n2;
  const u3x = u1y * u2z - u1z * u2y, u3y = u1z * u2x - u1x * u2z, u3z = u1x * u2y - u1y * u2x;
  PS[0] = s1;
  PS[1] = Math.max(0, u2x * a2x + u2y * a2y + u2z * a2z);
  PS[2] = u3x * a3x + u3y * a3y + u3z * a3z;
  const U = PU;
  U[0] = u1x; U[1] = u2x; U[2] = u3x; U[3] = u1y; U[4] = u2y; U[5] = u3y; U[6] = u1z; U[7] = u2z; U[8] = u3z;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) PR[3 * i + j] = U[3 * i] * V[3 * j] + U[3 * i + 1] * V[3 * j + 1] + U[3 * i + 2] * V[3 * j + 2];
  return true;
}

// ================================================================================================ the window
// Rate w(u) on the unit extent: 0 outside [a, b], 1 on the plateau, smoothstep ramps of width da (at a, only when a > 0)
// and db (at b, only when b < 1). W(u) = integral of w from 0 to u (C1, monotone), total = W(1), P = W / total.
// Integral of smoothstep S(t) = 3t^2 - 2t^3 is Q(t) = t^3 - t^4 / 2, Q(1) = 1/2.

function windowFn(a, b, ease) {
  let da = a > 1e-9 ? ease : 0, db = b < 1 - 1e-9 ? ease : 0;
  const span = b - a;
  if (da + db > span) { const k = span / (da + db); da *= k; db *= k; }
  const Q = (t) => t * t * t * (1 - 0.5 * t);
  const total = span - (da + db) / 2;
  const W = (u) => {
    if (u <= a) return 0;
    if (u >= b) return total;
    if (u < a + da) return da * Q((u - a) / da);
    if (u > b - db) return total - db * Q((b - u) / db);
    return da / 2 + (u - a - da);
  };
  const w = (u) => {
    if (u <= a || u >= b) return 0;
    if (u < a + da) { const t = (u - a) / da; return t * t * (3 - 2 * t); }
    if (u > b - db) { const t = (b - u) / db; return t * t * (3 - 2 * t); }
    return 1;
  };
  return { a, b, da, db, total, W, w, P: (u) => W(u) / total };
}

function range01(r, def) {
  let [a, b] = Array.isArray(r) && r.length === 2 ? r.map((x) => clamp(num(x, 0), 0, 1)) : def;
  if (a > b) [a, b] = [b, a];
  return [a, b];
}

function axisOf(op, def) {
  const a = op.axis ?? def;
  if (!(a in AXES)) throw new Error(`deform: ${op.type} axis must be x, y or z (got ${a})`);
  return AXES[a];
}

const centreOf = (F) => [0, 1, 2].map((k) => (F.min[k] + F.max[k]) / 2);

// ================================================================================================ ops
// compile(op, F) -> null (identity) | { type, map(v) (in place on a 3-vector), frameOut?, refine }
// F is the bbox of the shape at the op's input ({ min: [3], max: [3] }).

function compileStretch(op, F) {
  const ai = axisOf(op, 'z'), L = F.max[ai] - F.min[ai];
  const f0 = num(op.factor, 1);
  if (!(L > 1e-9) || Math.abs(f0 - 1) < 1e-12) return null;
  const f = clamp(f0, OP_SCHEMA.stretch.factor.min, OP_SCHEMA.stretch.factor.max);
  const [a, b] = range01(op.keep, OP_SCHEMA.stretch.keep.default);
  if (b - a < 1e-6) return null;
  const win = windowFn(a, b, clamp(num(op.ease, OP_SCHEMA.stretch.ease.default), 0, 0.5));
  // plateau slope 1 + k so that the middle zone grows by exactly (f - 1)(b - a) L despite the eased ends
  let k = ((f - 1) * (b - a)) / win.total;
  if (1 + k < 0.02) k = -0.98;                 // never fold: a squashed plateau keeps 2 % of its length
  const grow = k * win.total * L, shift = ai === 2 ? 0 : -grow / 2, min = F.min[ai];
  const map = (v) => { v[ai] += L * k * win.W((v[ai] - min) / L) + shift; };
  const frameOut = { min: F.min.slice(), max: F.max.slice() };
  frameOut.min[ai] += shift; frameOut.max[ai] += grow + shift;
  return { type: 'stretch', axis: ai, map, frameOut, refine: false };
}

/** Unit vectors (t along the axis, n toward the centre of curvature, b = t x n) for a bend. dir (rad) turns n about t:
 *  x: n = +Y at 0 (plan curve, convex front), +Z at 90°; z: n = +X at 0, +Y at 90°; y: n = +X at 0, -Z at 90°. */
function bendFrame(ai, dir) {
  const t = [0, 0, 0]; t[ai] = 1;
  const n0 = ai === 0 ? [0, 1, 0] : [1, 0, 0];
  const b0 = [t[1] * n0[2] - t[2] * n0[1], t[2] * n0[0] - t[0] * n0[2], t[0] * n0[1] - t[1] * n0[0]];
  const c = Math.cos(dir), s = Math.sin(dir);
  const n = [0, 1, 2].map((k) => c * n0[k] + s * b0[k]);
  const b = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
  return { t, n, b };
}

/**
 * Centre line of a bend: C(t) = integral from tA to t of (cos phi, sin phi) ds in the (t, n) plane, tabulated on N
 * steps of [t0, t1] with 3-point Gauss-Legendre quadrature per step and evaluated by cubic Hermite interpolation with
 * the exact tangents (error ~ dt^4 |C''''| / 384, far below a micrometre); outside [t0, t1] the line goes straight on.
 */
function curveTable(phi, t0, t1, tA, N = 1024) {
  const dt = (t1 - t0) / N;
  const CT = new Float64Array(N + 1), CN = new Float64Array(N + 1), COS = new Float64Array(N + 1), SIN = new Float64Array(N + 1);
  const g = [0.5 - Math.sqrt(0.15), 0.5, 0.5 + Math.sqrt(0.15)], gw = [5 / 18, 8 / 18, 5 / 18];
  for (let k = 0; k <= N; k++) { const p = phi(t0 + k * dt); COS[k] = Math.cos(p); SIN[k] = Math.sin(p); }
  for (let k = 0; k < N; k++) {
    let sc = 0, ss = 0;
    for (let q = 0; q < 3; q++) { const p = phi(t0 + (k + g[q]) * dt); sc += gw[q] * Math.cos(p); ss += gw[q] * Math.sin(p); }
    CT[k + 1] = CT[k] + sc * dt; CN[k + 1] = CN[k] + ss * dt;
  }
  const raw = (t, out) => {
    if (t <= t0) { out[0] = CT[0] + (t - t0) * COS[0]; out[1] = CN[0] + (t - t0) * SIN[0]; return; }
    if (t >= t1) { out[0] = CT[N] + (t - t1) * COS[N]; out[1] = CN[N] + (t - t1) * SIN[N]; return; }
    const x = (t - t0) / dt;
    let k = Math.floor(x);
    if (k >= N) k = N - 1;
    const h = x - k, h2 = h * h, h3 = h2 * h;
    const a0 = 2 * h3 - 3 * h2 + 1, b0 = (h3 - 2 * h2 + h) * dt, a1 = 3 * h2 - 2 * h3, b1 = (h3 - h2) * dt;
    out[0] = a0 * CT[k] + b0 * COS[k] + a1 * CT[k + 1] + b1 * COS[k + 1];
    out[1] = a0 * CN[k] + b0 * SIN[k] + a1 * CN[k + 1] + b1 * SIN[k + 1];
  };
  const o = [0, 0];
  raw(tA, o);
  for (let k = 0; k <= N; k++) { CT[k] -= o[0]; CN[k] -= o[1]; }
  return raw;
}

function compileBend(op, F) {
  const ai = axisOf(op, 'x'), L = F.max[ai] - F.min[ai];
  const th = clamp(num(op.angle, 0), -720, 720) * DEG;
  if (!(L > 1e-9) || Math.abs(th) < 1e-9) return null;
  const [a, b] = range01(op.range, [0, 1]);
  if (b - a < 1e-6) return null;
  const win = windowFn(a, b, clamp(num(op.ease, 0.04), 0, 0.5));
  const { t: tv, n: nv, b: bv } = bendFrame(ai, num(op.dir, 0) * DEG);
  const c = centreOf(F), min = F.min[ai];
  const uA = ai === 2 ? a : (a + b) / 2, PA = win.P(uA);
  const tA = min + uA * L;
  const phi = (t) => th * (win.P((t - min) / L) - PA);
  const curve = curveTable(phi, min + a * L, min + b * L, tA);
  const O = c.slice(); O[ai] = tA;
  const C = [0, 0];
  const map = (v) => {
    const dx = v[0] - c[0], dy = v[1] - c[1], dz = v[2] - c[2];
    const n = dx * nv[0] + dy * nv[1] + dz * nv[2], m = dx * bv[0] + dy * bv[1] + dz * bv[2];
    const t = v[ai], p = phi(t), cs = Math.cos(p), sn = Math.sin(p);
    curve(t, C);
    const T = C[0] - n * sn, N = C[1] + n * cs;
    v[0] = O[0] + T * tv[0] + N * nv[0] + m * bv[0];
    v[1] = O[1] + T * tv[1] + N * nv[1] + m * bv[1];
    v[2] = O[2] + T * tv[2] + N * nv[2] + m * bv[2];
  };
  // Overlap (the ends meet or pass each other: the shape intersects itself without a fold, which det J cannot see).
  // Conservative: any bend of 330° or more; below that, when the closing gap 2R sin((360° - |angle|) / 2) of the arc
  // of radius R = bent length / |angle| is narrower than the element's depth across the bend.
  const at = Math.abs(th), R = ((b - a) * L) / at;
  const depth = [0, 1, 2].reduce((acc, k) => acc + Math.abs(nv[k]) * (F.max[k] - F.min[k]), 0);
  const overlap = at >= (330 * Math.PI) / 180 || (at > Math.PI && 2 * R * Math.sin((2 * Math.PI - at) / 2) < depth);
  return { type: 'bend', axis: ai, map, refine: true, angle: th, overlap };
}

function compileTwist(op, F) {
  const ai = axisOf(op, 'z'), L = F.max[ai] - F.min[ai];
  const th = clamp(num(op.angle, 0), -1440, 1440) * DEG;
  if (!(L > 1e-9) || Math.abs(th) < 1e-9) return null;
  const [a, b] = range01(op.range, [0, 1]);
  if (b - a < 1e-6) return null;
  const win = windowFn(a, b, clamp(num(op.ease, 0.04), 0, 0.5));
  const uA = ai === 2 ? a : (a + b) / 2, PA = win.P(uA), min = F.min[ai];
  const p = (ai + 1) % 3, q = (ai + 2) % 3, c = centreOf(F), cp = c[p], cq = c[q];
  const map = (v) => {
    const al = th * (win.P((v[ai] - min) / L) - PA), cs = Math.cos(al), sn = Math.sin(al);
    const dp = v[p] - cp, dq = v[q] - cq;
    v[p] = cp + cs * dp - sn * dq; v[q] = cq + sn * dp + cs * dq;
  };
  return { type: 'twist', axis: ai, map, refine: true };
}

function compileTaper(op, F) {
  const ai = axisOf(op, 'z'), L = F.max[ai] - F.min[ai];
  const s = Array.isArray(op.scale) ? op.scale : [op.scale, op.scale];
  const sp = clamp(num(s[0], 1), 0.02, 50), sq = clamp(num(s[1], 1), 0.02, 50);
  if (!(L > 1e-9) || (Math.abs(sp - 1) < 1e-12 && Math.abs(sq - 1) < 1e-12)) return null;
  const [a, b] = range01(op.range, [0, 1]);
  if (b - a < 1e-6) return null;
  const win = windowFn(a, b, clamp(num(op.ease, 0.04), 0, 0.5));
  const min = F.min[ai], p = (ai + 1) % 3, q = (ai + 2) % 3, c = centreOf(F), cp = c[p], cq = c[q];
  // Past the range end the element continues as a similar figure: the cross-section keeps the end scale and the axis
  // takes the mean scale sa = sqrt(sp sq), blended in over the end ramp (rate 1 -> sa, C1). A capital above a tapered
  // shaft is then the same capital at the shaft's new top diameter, not a narrowed one of full height.
  // A taper keeps the element's height and footprint: the range gains back exactly the length the similar figure past
  // it loses, (1 - sa) L E(1), plus `lift` (metres; resolveOps solves it when rigid ornament at the top would shrink
  // below the old top), both spread over the range by P(u). The foot (scale 1, axis unchanged) never moves.
  const sa = Math.sqrt(sp * sq), db = win.db, b0 = b - db;
  const Q = (t) => t * t * t * (1 - 0.5 * t);
  const E = b < 1 - 1e-9 ? (u) => (u <= b0 ? 0 : u < b ? (db > 0 ? db * Q((u - b0) / db) : 0) : db / 2 + (u - b)) : () => 0;
  const lift = num(op.lift, 0);
  // the range may give up at most 90 % of its length to a negative lift (flaring tapers with growing ornament)
  const add = Math.max((1 - sa) * L * E(1) + lift, -0.9 * win.total * L);
  const map = (v) => {
    const u = (v[ai] - min) / L, w = win.P(u);
    v[p] = cp + (1 + (sp - 1) * w) * (v[p] - cp);
    v[q] = cq + (1 + (sq - 1) * w) * (v[q] - cq);
    v[ai] += (sa - 1) * L * E(u) + add * w;
  };
  // exact frame: the scale is monotone in w, so the extremes are at the range ends; the axis map is monotone
  const frameOut = { min: F.min.slice(), max: F.max.slice() };
  for (const [k, sk] of [[p, sp], [q, sq]]) {
    const ck = c[k], h = (F.max[k] - F.min[k]) / 2, m = Math.max(1, sk);
    frameOut.min[k] = ck - h * m; frameOut.max[k] = ck + h * m;
  }
  frameOut.max[ai] += (sa - 1) * L * E(1) + add;
  return { type: 'taper', axis: ai, map, frameOut, refine: true };
}

function compileShear(op, F) {
  const ai = axisOf(op, 'z'), L = F.max[ai] - F.min[ai];
  // offsets in metres (dx, dy, dz) and / or relative to the extent along the axis (rx, ry, rz: 0.1 = a 10 % lean)
  const d = [num(op.dx, 0) + num(op.rx, 0) * L, num(op.dy, 0) + num(op.ry, 0) * L, num(op.dz, 0) + num(op.rz, 0) * L];
  d[ai] = 0;
  if (!(L > 1e-9) || Math.hypot(...d) < 1e-12) return null;
  const [a, b] = range01(op.range, [0, 1]);
  if (b - a < 1e-6) return null;
  const win = windowFn(a, b, clamp(num(op.ease, 0.04), 0, 0.5));
  const uA = ai === 2 ? a : (a + b) / 2, PA = win.P(uA), min = F.min[ai];
  const map = (v) => {
    const w = win.P((v[ai] - min) / L) - PA;
    v[0] += d[0] * w; v[1] += d[1] * w; v[2] += d[2] * w;
  };
  const frameOut = { min: F.min.slice(), max: F.max.slice() };
  const w0 = -PA, w1 = 1 - PA;
  for (let k = 0; k < 3; k++) { frameOut.min[k] += Math.min(d[k] * w0, d[k] * w1); frameOut.max[k] += Math.max(d[k] * w0, d[k] * w1); }
  // a shear is affine (no ease) or piecewise affine along its axis: straight edges along the axis stay straight
  return { type: 'shear', axis: ai, map, frameOut, refine: !(a === 0 && b === 1) };
}

function checkDims(dims) {
  if (!Array.isArray(dims) || dims.length !== 3) throw new Error('deform: ffd dims must be [l, m, n]');
  return dims.map((x) => clamp(Math.round(num(x, 3)), 1, 12));
}

/**
 * The FFD lattice of an element: (l+1)(m+1)(n+1) control points on a regular grid over the bbox padded by
 * pad * diagonal on every side. Point (i, j, k) has index i + (l+1) * (j + (m+1) * k); rest holds xyz per index.
 */
export function ffdLattice(dims, bbox, pad = OP_SCHEMA.ffd.pad.default) {
  const [l, m, n] = checkDims(dims);
  const ext = [0, 1, 2].map((k) => bbox.max[k] - bbox.min[k]);
  const pd = Math.max(pad * Math.hypot(...ext), 1e-6);
  const min = bbox.min.map((x) => x - pd), max = bbox.max.map((x) => x + pd);
  const size = [0, 1, 2].map((k) => max[k] - min[k]);
  const count = (l + 1) * (m + 1) * (n + 1), rest = new Float64Array(3 * count);
  const index = (i, j, k) => i + (l + 1) * (j + (m + 1) * k);
  for (let k = 0; k <= n; k++) for (let j = 0; j <= m; j++) for (let i = 0; i <= l; i++) {
    const id = index(i, j, k);
    rest[3 * id] = min[0] + (size[0] * i) / l; rest[3 * id + 1] = min[1] + (size[1] * j) / m; rest[3 * id + 2] = min[2] + (size[2] * k) / n;
  }
  return { dims: [l, m, n], min, max, size, count, rest, index };
}

function binomials(n) { const c = [1]; for (let k = 1; k <= n; k++) c.push((c[k - 1] * (n - k + 1)) / k); return c; }

function compileFFD(op, F) {
  const dims = checkDims(op.dims || OP_SCHEMA.ffd.dims.default);
  const lat = ffdLattice(dims, F, num(op.pad, OP_SCHEMA.ffd.pad.default));
  let off = null;
  if (op.offsets) {
    if (op.offsets.length !== 3 * lat.count) throw new Error(`deform: ffd offsets need ${3 * lat.count} numbers, got ${op.offsets.length}`);
    off = Float64Array.from(op.offsets);
  } else if (op.pins && Object.keys(op.pins).length) {
    off = arapLattice(dims, op.pins, num(op.iters, OP_SCHEMA.ffd.iters.default), { rest: lat.rest, reach: op.reach, grip: op.grip, follow: op.follow });
  }
  if (!off || off.every((x) => Math.abs(x) < 1e-15)) return null;
  const [l, m, n] = lat.dims, Cl = binomials(l), Cm = binomials(m), Cn = binomials(n);
  const bs = new Float64Array(l + 1), bt = new Float64Array(m + 1), bu = new Float64Array(n + 1);
  const bern = (deg, C, x, out) => {
    // B_i(x) = C(deg, i) x^i (1-x)^(deg-i), by running powers
    let p = 1;
    for (let i = 0; i <= deg; i++) { out[i] = C[i] * p; p *= x; }
    p = 1;
    for (let i = deg; i >= 0; i--) { out[i] *= p; p *= 1 - x; }
  };
  const { min, size } = lat;
  const map = (v) => {
    bern(l, Cl, clamp((v[0] - min[0]) / size[0], 0, 1), bs);
    bern(m, Cm, clamp((v[1] - min[1]) / size[1], 0, 1), bt);
    bern(n, Cn, clamp((v[2] - min[2]) / size[2], 0, 1), bu);
    let dx = 0, dy = 0, dz = 0, id = 0;
    for (let k = 0; k <= n; k++) for (let j = 0; j <= m; j++) {
      const w2 = bu[k] * bt[j];
      for (let i = 0; i <= l; i++, id++) {
        const w = w2 * bs[i], o = 3 * id;
        dx += w * off[o]; dy += w * off[o + 1]; dz += w * off[o + 2];
      }
    }
    v[0] += dx; v[1] += dy; v[2] += dz;
  };
  return { type: 'ffd', map, refine: true, lattice: lat, offsets: off };
}

const COMPILE = { stretch: compileStretch, bend: compileBend, twist: compileTwist, taper: compileTaper, shear: compileShear, ffd: compileFFD };

/** Bbox of the image of box F under map, from a 17^3 sample grid (exact for the ops that report frameOut). */
function imageBox(map, F, n = 16) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], v = new Float64Array(3);
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) for (let k = 0; k <= n; k++) {
    v[0] = F.min[0] + ((F.max[0] - F.min[0]) * i) / n; v[1] = F.min[1] + ((F.max[1] - F.min[1]) * j) / n;
    v[2] = F.min[2] + ((F.max[2] - F.min[2]) * k) / n;
    map(v);
    for (let a = 0; a < 3; a++) { if (v[a] < min[a]) min[a] = v[a]; if (v[a] > max[a]) max[a] = v[a]; }
  }
  return { min, max };
}

// ================================================================================================ the deformer

/**
 * Compose ops (applied in order, op 1 first) into a deformation of the element whose bbox is `bbox`. Each op is
 * measured on the bbox of the shape at its input (frames[i]; exact for stretch / taper / shear, sampled otherwise), so
 * "stretch, then twist" twists the stretched height. Ops that do nothing (factor 1, angle 0, zero offsets) are dropped.
 *
 * Returns { identity, ops, compiled, frames, bbox, bboxOut, point(p), apply(v), warpBatch(verts, count), jacobian(p),
 *           curvature(), needsRefine, overlap }. compiled[i]: { type, axis (0 1 2; not ffd), frame (input bbox), map,
 *           lattice + offsets (ffd) } for the ops that do something.
 *   point([x, y, z]) -> [x', y', z'];  apply(v) moves a 3-vector in place;  warpBatch is Manifold.warpBatch's callback;
 *   jacobian(p) -> row-major 3x3 J[3 i + j] = d f_i / d x_j by central differences (h = 1e-5 of the diagonal);
 *   curvature() -> the largest directional second derivative |f(p + h d) - 2 f(p) + f(p - h d)| / h^2 on a grid
 *   (5^3, finer for fine FFD lattices) over 13 directions (h = 2 % of the diagonal), the H of the refinement rule.
 */
export function makeDeformer(ops, bbox) {
  const B0 = { min: Array.from(bbox.min), max: Array.from(bbox.max) };
  const list = Array.isArray(ops) ? ops : ops ? [ops] : [];
  const compiled = [], frames = [];
  let F = B0;
  for (const op of list) {
    const type = op && (op.type || op.op);
    if (!type) { frames.push(null); continue; }
    if (!COMPILE[type]) throw new Error(`deform: unknown op "${type}"`);
    const c = COMPILE[type](op, F);
    frames.push(c ? { min: F.min.slice(), max: F.max.slice() } : null);
    if (!c) continue;
    c.frame = { min: F.min.slice(), max: F.max.slice() }; // the op's input bbox (c.axis: its axis index, 0 1 2)
    compiled.push(c);
    F = c.frameOut || imageBox(c.map, F);
  }
  const maps = compiled.map((c) => c.map), nOps = maps.length;
  const ext = [0, 1, 2].map((k) => B0.max[k] - B0.min[k]), diag = Math.hypot(...ext) || 1;
  const apply = (v) => { for (let i = 0; i < nOps; i++) maps[i](v); return v; };
  const s = new Float64Array(3);
  const point = (p) => { s[0] = p[0]; s[1] = p[1]; s[2] = p[2]; apply(s); return [s[0], s[1], s[2]]; };
  const warpBatch = (verts, count) => {
    for (let i = 0, o = 0; i < count; i++, o += 3) {
      s[0] = verts[o]; s[1] = verts[o + 1]; s[2] = verts[o + 2];
      apply(s);
      verts[o] = s[0]; verts[o + 1] = s[1]; verts[o + 2] = s[2];
    }
  };
  const hJ = 1e-5 * diag;
  const ja = new Float64Array(3), jb = new Float64Array(3); // jacobian's scratch (it runs per rigid instance per drag frame)
  const jacobian = (p, out = new Float64Array(9)) => {
    const a = ja, b = jb;
    for (let j = 0; j < 3; j++) {
      a[0] = p[0]; a[1] = p[1]; a[2] = p[2]; b[0] = p[0]; b[1] = p[1]; b[2] = p[2];
      a[j] += hJ; b[j] -= hJ;
      apply(a); apply(b);
      for (let i = 0; i < 3; i++) out[3 * i + j] = (a[i] - b[i]) / (2 * hJ);
    }
    return out;
  };
  let H = null;
  const curvature = () => {
    if (H !== null) return H;
    H = 0;
    if (!nOps) return H;
    const h = 0.02 * diag, dirs = [];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      if ((x || y || z) && (x > 0 || (x === 0 && (y > 0 || (y === 0 && z > 0))))) { const l = Math.hypot(x, y, z); dirs.push([x / l, y / l, z / l]); }
    }
    // samples stay h inside the bbox: the ops continue rigidly beyond it, and a difference straddling that kink would
    // report a curvature no vertex ever sees
    // a fine lattice bends locally: sample at least two points per lattice cell (grid G^3, G = 4..12)
    const G = Math.min(12, Math.max(4, ...compiled.map((c) => (c.lattice ? 2 * Math.max(...c.lattice.dims) : 4))));
    const at = (k, i) => (ext[k] > 2 * h ? B0.min[k] + h + ((ext[k] - 2 * h) * i) / G : (B0.min[k] + B0.max[k]) / 2);
    const c = new Float64Array(3), a = new Float64Array(3), b = new Float64Array(3);
    for (let i = 0; i <= G; i++) for (let j = 0; j <= G; j++) for (let k = 0; k <= G; k++) {
      const p = [at(0, i), at(1, j), at(2, k)];
      c.set(p); apply(c);
      for (const d of dirs) {
        for (let q = 0; q < 3; q++) { a[q] = p[q] + h * d[q]; b[q] = p[q] - h * d[q]; }
        apply(a); apply(b);
        const e = Math.hypot(a[0] - 2 * c[0] + b[0], a[1] - 2 * c[1] + b[1], a[2] - 2 * c[2] + b[2]) / (h * h);
        if (e > H) H = e;
      }
    }
    return H;
  };
  return {
    identity: nOps === 0, ops: compiled.map((c) => c.type), compiled, frames, bbox: B0, bboxOut: F,
    point, apply, warpBatch, jacobian, curvature,
    needsRefine: compiled.some((c) => c.refine), overlap: compiled.some((c) => c.overlap),
  };
}

/** Fold check without geometry: det J on an n^3 grid of cell centres of the bbox. -> { folds, minDet, samples }. */
export function foldCheck(deformer, bbox = deformer.bbox, n = 8) {
  let folds = 0, minDet = Infinity;
  const J = new Float64Array(9);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    const p = [0, 1, 2].map((a) => bbox.min[a] + ((bbox.max[a] - bbox.min[a]) * ([i, j, k][a] + 0.5)) / n);
    const d = det3(deformer.jacobian(p, J));
    if (d < minDet) minDet = d;
    if (!(d > 1e-9)) folds++;
  }
  return { folds, minDet, samples: n * n * n };
}

// ================================================================================================ ARAP lattice

/** Banded Cholesky A = L L^T of an SPD matrix given by its lower band (n x (bw+1), A[i, i - d] at i * (bw+1) + d).
 *  Returns solve(b) -> x (in place on a copy). O(n bw^2). */
function bandCholesky(n, bw, band) {
  const W = bw + 1, Lb = Float64Array.from(band);
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(0, i - bw); j <= i; j++) {
      let s = Lb[i * W + (i - j)];
      for (let k = Math.max(0, i - bw); k < j; k++) {
        if (j - k > bw) continue;
        s -= Lb[i * W + (i - k)] * Lb[j * W + (j - k)];
      }
      if (i === j) {
        if (!(s > 0)) throw new Error('deform: ARAP system is not positive definite');
        Lb[i * W] = Math.sqrt(s);
      } else Lb[i * W + (i - j)] = s / Lb[j * W];
    }
  }
  return (b) => {
    const x = Float64Array.from(b);
    for (let i = 0; i < n; i++) {
      let s = x[i];
      for (let k = Math.max(0, i - bw); k < i; k++) s -= Lb[i * W + (i - k)] * x[k];
      x[i] = s / Lb[i * W];
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = x[i];
      for (let k = i + 1; k <= Math.min(n - 1, i + bw); k++) s -= Lb[k * W + (k - i)] * x[k];
      x[i] = s / Lb[i * W];
    }
    return x;
  };
}

/**
 * As-Rigid-As-Possible lattice solve (Sorkine & Alexa 2007) on the FFD lattice graph (6-neighbourhood) — what makes a
 * dragged control point carry its neighbourhood along instead of shearing the cells next to it.
 *
 *   E(p, R) = sum_i sum_{j in N(i)} w_ij |(p_i - p_j) - R_i (r_i - r_j)|^2  +  sum_i c_i |p_i - g_i|^2
 *
 * r rest positions, p solved positions, w_ij = 1 / |r_i - r_j|^2 (relative edge strain, so the long thin cells of a
 * column lattice count like cubic ones). Constraints, in the spirit of the paper's handle / region-of-interest editing:
 * - pins (dragged handles) are fixed at their targets;
 * - region of interest: points at lattice distance d_i >= reach from every pin (index units; capped at 0.85 of the
 *   largest distance so a small lattice keeps an anchor) stay at rest (hard), so a drag never moves the far side;
 * - grip: within d_i < grip a point is pulled toward the rigid motion of its nearest handles,
 *   g_i = sum_h f_ih (p_h + R_h (r_i - r_h)) / sum_h f_ih, with c_i = follow * sum_j w_ij * f(d_i / grip),
 *   f(t) = (1 - t^2)^2. A single-point constraint in a first-order energy like ARAP makes a cusp (the neighbours lag
 *   behind and the cells next to the handle stretch); the grip makes the handle act as a small rigid region, as in the
 *   paper, so the strain moves out into the free band between grip and reach, where ARAP spreads it as rotation.
 *   Measured on a column lattice [2,2,4] with its top corner dragged 0.5 m sideways: handle edges change 0.6 %
 *   (47 % with a plain distance-weighted anchor), the top layer follows at 94 %, the base stays put.
 * Local step: R_i = closest rotation to sum_j w_ij (p_i - p_j)(r_i - r_j)^T (polar3). Global step: the sparse SPD system
 * (L + C) p = sum_j w_ij / 2 (R_i + R_j)(r_i - r_j) + C g (+ pinned / anchored neighbours), factored once by a banded
 * Cholesky (bandwidth (l+1)(m+1) in the natural ordering), so each round is two triangular solves per coordinate.
 * Starts from R = I (Laplacian editing), then `iters` local/global rounds (default 10).
 *
 * dims: [l, m, n]; pinned: { index: [x, y, z] } absolute targets (a Map works too); opts: { bbox | rest, pad, reach
 * (3.5), grip (2.2), follow (3) }. Returns offsets (Float64Array 3 * count) = solved - rest, the ffd op's input.
 * A UI keeps every point the user has dragged in `pinned`, so the result depends only on the set of handles.
 */
export function arapLattice(dims, pinned, iters = OP_SCHEMA.ffd.iters.default, opts = {}) {
  const [l, m, n] = checkDims(dims);
  const count = (l + 1) * (m + 1) * (n + 1);
  const rest = opts.rest ? Float64Array.from(opts.rest)
    : ffdLattice([l, m, n], opts.bbox || { min: [0, 0, 0], max: [1, 1, 1] }, opts.bbox ? num(opts.pad, OP_SCHEMA.ffd.pad.default) : 0).rest;
  if (rest.length !== 3 * count) throw new Error('deform: lattice rest positions do not match dims');
  const pins = new Map();
  for (const [k, v] of pinned instanceof Map ? pinned : Object.entries(pinned || {})) {
    const id = Math.round(+k);
    if (id >= 0 && id < count && v && v.length === 3 && [0, 1, 2].every((a) => Number.isFinite(+v[a]))) pins.set(id, [+v[0], +v[1], +v[2]]);
  }
  const off = new Float64Array(3 * count);
  if (!pins.size) return off;
  const ijk = (id) => [id % (l + 1), Math.floor(id / (l + 1)) % (m + 1), Math.floor(id / ((l + 1) * (m + 1)))];
  // graph (6-neighbourhood) with relative-strain weights
  const nb = Array.from({ length: count }, () => []);
  const E = (a, b) => [rest[3 * a] - rest[3 * b], rest[3 * a + 1] - rest[3 * b + 1], rest[3 * a + 2] - rest[3 * b + 2]];
  for (let id = 0; id < count; id++) {
    const [i, j, k] = ijk(id);
    const add = (jd) => { const e = E(id, jd), w = 1 / Math.max(e[0] * e[0] + e[1] * e[1] + e[2] * e[2], 1e-18); nb[id].push([jd, w]); nb[jd].push([id, w]); };
    if (i < l) add(id + 1);
    if (j < m) add(id + (l + 1));
    if (k < n) add(id + (l + 1) * (m + 1));
  }
  const sumW = (id) => nb[id].reduce((s, [, w]) => s + w, 0);
  // distances to the handles, region of interest and grip
  const H = [...pins.keys()], Hq = H.map(ijk);
  const dist = new Float64Array(count * H.length), dmin = new Float64Array(count).fill(Infinity);
  for (let id = 0; id < count; id++) {
    const q = ijk(id);
    H.forEach((h, hi) => { const d = Math.hypot(q[0] - Hq[hi][0], q[1] - Hq[hi][1], q[2] - Hq[hi][2]); dist[id * H.length + hi] = d; if (d < dmin[id]) dmin[id] = d; });
  }
  let dmax = 0;
  for (let id = 0; id < count; id++) if (!pins.has(id)) dmax = Math.max(dmax, dmin[id]);
  const reach = Math.min(Math.max(1, num(opts.reach, 3.5)), 0.85 * dmax + 1e-9);
  const grip = Math.min(Math.max(0, num(opts.grip, 2.2)), 0.6 * reach), follow = Math.max(0, num(opts.follow, 3));
  const fall = (t) => (t < 1 ? (1 - t * t) ** 2 : 0);
  const P = Float64Array.from(rest);
  for (const [id, v] of pins) P.set(v, 3 * id);
  const free = [], fidx = new Int32Array(count).fill(-1), c = new Float64Array(count);
  for (let id = 0; id < count; id++) {
    if (pins.has(id) || dmin[id] >= reach) continue;
    fidx[id] = free.length; free.push(id);
    c[id] = grip > 0 ? follow * sumW(id) * fall(dmin[id] / grip) : 0;
  }
  const nf = free.length;
  if (nf) {
    let bw = 0;
    for (const id of free) for (const [jd] of nb[id]) if (fidx[jd] >= 0) bw = Math.max(bw, Math.abs(fidx[id] - fidx[jd]));
    const Wd = bw + 1, band = new Float64Array(nf * Wd);
    for (const id of free) {
      const fi = fidx[id];
      band[fi * Wd] = sumW(id) + c[id];
      for (const [jd, w] of nb[id]) { const fj = fidx[jd]; if (fj >= 0 && fj < fi) band[fi * Wd + (fi - fj)] -= w; }
    }
    const solve = bandCholesky(nf, bw, band);
    const R = Array.from({ length: count }, () => Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1));
    const rhs = [new Float64Array(nf), new Float64Array(nf), new Float64Array(nf)];
    const S = new Float64Array(9), g = [0, 0, 0];
    for (let it = 0; it <= Math.max(0, Math.round(num(iters, 10))); it++) {
      if (it > 0) { // local step: the best rotation of every point's star
        for (let id = 0; id < count; id++) {
          S.fill(0);
          for (const [jd, w] of nb[id]) {
            const e = E(id, jd), f0 = P[3 * id] - P[3 * jd], f1 = P[3 * id + 1] - P[3 * jd + 1], f2 = P[3 * id + 2] - P[3 * jd + 2];
            for (let b = 0; b < 3; b++) { S[b] += w * f0 * e[b]; S[3 + b] += w * f1 * e[b]; S[6 + b] += w * f2 * e[b]; }
          }
          R[id] = polar3(S).R;
        }
      }
      for (const r of rhs) r.fill(0);
      for (const id of free) {
        const fi = fidx[id], Ri = R[id];
        if (c[id] > 0) { // grip target: the handles' rigid motions, blended by falloff
          let fs = 0;
          g[0] = g[1] = g[2] = 0;
          H.forEach((h, hi) => {
            const f = fall(dist[id * H.length + hi] / grip);
            if (!f) return;
            const e = E(id, h), Rh = R[h];
            for (let a = 0; a < 3; a++) g[a] += f * (P[3 * h + a] + Rh[3 * a] * e[0] + Rh[3 * a + 1] * e[1] + Rh[3 * a + 2] * e[2]);
            fs += f;
          });
          for (let a = 0; a < 3; a++) rhs[a][fi] += (c[id] * g[a]) / fs;
        }
        for (const [jd, w] of nb[id]) {
          const Rj = R[jd], e = E(id, jd);
          for (let a = 0; a < 3; a++) {
            rhs[a][fi] += (w / 2) * ((Ri[3 * a] + Rj[3 * a]) * e[0] + (Ri[3 * a + 1] + Rj[3 * a + 1]) * e[1] + (Ri[3 * a + 2] + Rj[3 * a + 2]) * e[2]);
            if (fidx[jd] < 0) rhs[a][fi] += w * P[3 * jd + a];
          }
        }
      }
      for (let a = 0; a < 3; a++) {
        const x = solve(rhs[a]);
        for (let fi = 0; fi < nf; fi++) P[3 * free[fi] + a] = x[fi];
      }
    }
  }
  for (let i = 0; i < 3 * count; i++) off[i] = P[i] - rest[i];
  return off;
}

// ================================================================================================ 'auto' ranges

/**
 * Resolve the defaults of ops against the element (what deformParts runs; a UI previewing the map builds its deformer
 * from the same list, so preview and bake agree):
 * - range: 'auto' (bend, twist, taper, shear) and keep: 'auto' (stretch): when the element has a part named 'shaft'
 *   (column, pilaster, obelisk) that is long along the op's axis (at least twice its other extents), the op acts on
 *   the shaft only: a twisted or tapered column keeps a square plinth and an undistorted capital, a stretched column
 *   keeps its base, capital and pedestal exactly, a tapered obelisk keeps its pedestal. Otherwise range [0, 1] / keep
 *   [0.12, 0.88]. The shaft's ends are carried through the ops before this one. Explicit arrays pass through.
 * - taper lift (left out): a taper keeps the element's height. Continuous geometry keeps it by construction (see
 *   compileTaper); rigid ornament that shrinks with the cross-section (a finial's crown, urns on a balustrade) would
 *   still lower the top, so `lift` is solved here — the length added over the range that puts the top back exactly
 *   where it was (secant on the measured top: continuous parts' tops through the map, rigid instances' bbox corners
 *   through their rigid placement). opts: the same rigidInstances / rigidRatio / scaleInstances as deformParts.
 */
export function resolveOps(ops, parts, bbox = solidBBox(parts), opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const list = Array.isArray(ops) ? ops : ops ? [ops] : [];
  const shafts = (parts || []).filter((p) => p.name === 'shaft' && p.manifold.numTri() > 0);
  const sb = shafts.length ? partsBBox(shafts) : null;
  const out = [];
  for (const op of list) {
    const type = op && (op.type || op.op), key = type === 'stretch' ? 'keep' : 'range';
    if (!op || !COMPILE[type] || type === 'ffd') { out.push(op); continue; }
    let res = op;
    if (!Array.isArray(op[key])) {
      const ai = AXES[op.axis ?? (type === 'bend' ? 'x' : 'z')];
      let r = type === 'stretch' ? OP_SCHEMA.stretch.keep.default : [0, 1];
      if (sb && ai !== undefined) {
        const ext = [0, 1, 2].map((k) => sb.max[k] - sb.min[k]);
        if (ext[ai] >= 2 * Math.max(...ext.filter((_, k) => k !== ai))) {
          const prev = makeDeformer(out, bbox), F = prev.bboxOut, c = [0, 1, 2].map((k) => (sb.min[k] + sb.max[k]) / 2);
          const e0 = c.slice(), e1 = c.slice();
          e0[ai] = sb.min[ai]; e1[ai] = sb.max[ai];
          const L = F.max[ai] - F.min[ai];
          const u0 = (prev.point(e0)[ai] - F.min[ai]) / L, u1 = (prev.point(e1)[ai] - F.min[ai]) / L;
          const a = clamp(Math.min(u0, u1), 0, 1), b = clamp(Math.max(u0, u1), 0, 1);
          if (b - a > 0.05) r = [a, b];
        }
      }
      res = { ...op, [key]: r };
    }
    if (type === 'taper' && op.lift === undefined) res = { ...res, lift: taperLift(out, res, parts || [], bbox, o) };
    out.push(res);
  }
  return out;
}

/** The lift that keeps a taper's top where the shape's top was before it (see resolveOps). 0 when nothing rigid. */
function taperLift(prefix, op, parts, bbox, o) {
  const ai = AXES[op.axis ?? 'z'];
  if (ai === undefined || o.scaleInstances === false) return 0;
  const diag = Math.hypot(...[0, 1, 2].map((k) => bbox.max[k] - bbox.min[k]));
  const rigid = parts.filter((p) => isRigid(p, diag, o));
  if (!rigid.length) return 0;
  const cont = parts.filter((p) => !rigid.includes(p) && p.manifold.numTri() > 0);
  // what can be the top: continuous parts' top faces, rigid instances' bbox corners (with their centre)
  const contPts = []; // a 3^3 grid on each continuous part's bbox (a taper's axis map ignores the cross coordinates)
  for (const p of cont) {
    const b = partsBBox([p]), g = (k, i) => b.min[k] + ((b.max[k] - b.min[k]) * i) / 2;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) contPts.push([g(0, i), g(1, j), g(2, k)]);
  }
  const inst = [];
  for (const p of rigid) {
    const bb = p.manifold.boundingBox(), cl = [0, 1, 2].map((k) => (bb.min[k] + bb.max[k]) / 2), n = instanceCount(p);
    for (let i = 0; i < n; i++) {
      const M = p.transforms ? p.transforms.subarray(16 * i, 16 * i + 16) : mat.I();
      const corners = [];
      for (let k = 0; k < 8; k++) corners.push(mat.apply(M, [(k & 1 ? bb.max : bb.min)[0], (k & 2 ? bb.max : bb.min)[1], (k & 4 ? bb.max : bb.min)[2]]));
      inst.push({ c: mat.apply(M, cl), corners });
    }
  }
  const J = new Float64Array(9), pol = { R: new Float64Array(9), s: new Float64Array(3) };
  const topOf = (D, which) => {
    let top = -Infinity;
    for (const q of contPts) top = Math.max(top, D.point(q)[ai]);
    for (const it of which) {
      const fc = D.point(it.c);
      D.jacobian(it.c, J);
      const { R, s } = polar3(J, pol), k = instanceScale(s, o.scaleInstances);
      for (const w of it.corners) {
        const d = [w[0] - it.c[0], w[1] - it.c[1], w[2] - it.c[2]];
        top = Math.max(top, fc[ai] + k * (R[3 * ai] * d[0] + R[3 * ai + 1] * d[1] + R[3 * ai + 2] * d[2]));
      }
    }
    return top;
  };
  const target = topOf(makeDeformer(prefix, bbox), inst);
  const at = (lift) => topOf(makeDeformer([...prefix, { ...op, lift }], bbox), inst);
  let l0 = 0, t0 = at(0);
  const L = Math.max(1e-9, Math.hypot(...[0, 1, 2].map((k) => bbox.max[k] - bbox.min[k])));
  if (Math.abs(t0 - target) < 1e-7 * L) return 0;
  let l1 = target - t0, t1 = at(l1);
  for (let it = 0; it < 12 && Math.abs(t1 - target) > 1e-7 * L; it++) { // secant (the top moves ~1:1 with the lift)
    const slope = Math.abs(t1 - t0) > 1e-15 ? (t1 - t0) / (l1 - l0) : 1;
    const l2 = l1 + (target - t1) / (slope > 1e-3 ? slope : 1);
    l0 = l1; t0 = t1; l1 = l2; t1 = at(l1);
  }
  return l1;
}

// rigidRatio: the page's RIGID_RATIO (export.js), so a caller that does not pass one (tests, tools/dataset.mjs) bakes the
// same rigid set the page previews and bakes (audit C11)
const DEFAULT_OPTS = { rigidInstances: true, scaleInstances: 'auto', refine: true, maxTris: 1.5e6, rigidRatio: RIGID_RATIO, ground: true };

/**
 * Does a part move rigidly? meta.rigid === true: always (its instances, or the part as one piece); meta.rigid ===
 * false: never (it is warped). Untagged: when it has >= 2 instances and its mesh bbox diagonal (times the instance
 * scale) is below rigidRatio of the element's diagonal. rigidInstances: false warps everything. Empty parts: never.
 */
function isRigid(p, diag, o) {
  if (!o.rigidInstances || !(p.manifold.numTri() > 0)) return false;
  const tag = p.meta && p.meta.rigid;
  if (tag === true) return true;
  if (tag === false) return false;
  const n = instanceCount(p);
  if (!p.transforms || n < 2) return false;
  const bb = p.manifold.boundingBox(), M = p.transforms;
  const sc = Math.max(Math.hypot(M[0], M[1], M[2]), Math.hypot(M[4], M[5], M[6]), Math.hypot(M[8], M[9], M[10]));
  return Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) * sc < o.rigidRatio * diag;
}

/** Uniform scale of a rigid instance from the signed singular values of J (see the header). */
function instanceScale(s, mode) {
  let k = 1;
  if (mode === 'auto') k = Math.abs(s[1]);
  else if (mode === true || mode === 'volume') k = Math.cbrt(Math.abs(s[0] * s[1] * s[2]));
  return !(k > 0) || !Number.isFinite(k) || Math.abs(k - 1) < 1e-6 ? 1 : k; // exactly rigid unless J really scales
}

/** Scratch for placeRigid (one per loop; reused across instances). */
export function rigidScratch() {
  return { c: new Float64Array(3), fc: new Float64Array(3), J: new Float64Array(9), pol: { R: new Float64Array(9), s: new Float64Array(3) } };
}

/**
 * deformParts' rigid placement of one instance, allocation-free: M' = T(f(c)) * kR * T(-c) * M with c = M cl (cl the
 * centre of the part's mesh box), R the polar rotation of the Jacobian J(c) and k = instanceScale(s, mode). Writes the
 * column-major 4x4 into Q at offset `at` and leaves c and J(c) in w.c and w.J (deformParts' fold check reads them).
 * The arithmetic is deformParts' own, operation for operation, so the page's GPU preview (view.js previewDeform, the
 * app's box estimator) can place its rigid instances with it per drag frame and match the bake bit for bit.
 */
export function placeRigid(D, M, cl, mode, Q, w = rigidScratch(), at = 0) {
  const { c, fc, J, pol } = w;
  c[0] = M[0] * cl[0] + M[4] * cl[1] + M[8] * cl[2] + M[12];
  c[1] = M[1] * cl[0] + M[5] * cl[1] + M[9] * cl[2] + M[13];
  c[2] = M[2] * cl[0] + M[6] * cl[1] + M[10] * cl[2] + M[14];
  fc[0] = c[0]; fc[1] = c[1]; fc[2] = c[2];
  D.apply(fc);
  D.jacobian(c, J);
  const { R, s } = polar3(J, pol), k = instanceScale(s, mode);
  // M' = T(f(c)) * kR * T(-c) * M : linear part kR * M3, translation f(c) + kR (t_M - c)
  const a0 = R[0] * k, a1 = R[1] * k, a2 = R[2] * k, a3 = R[3] * k, a4 = R[4] * k, a5 = R[5] * k, a6 = R[6] * k, a7 = R[7] * k, a8 = R[8] * k;
  for (let col = 0; col < 3; col++) {
    const m0 = M[4 * col], m1 = M[4 * col + 1], m2 = M[4 * col + 2];
    Q[at + col * 4] = a0 * m0 + a1 * m1 + a2 * m2;
    Q[at + col * 4 + 1] = a3 * m0 + a4 * m1 + a5 * m2;
    Q[at + col * 4 + 2] = a6 * m0 + a7 * m1 + a8 * m2;
  }
  const t0 = M[12] - c[0], t1 = M[13] - c[1], t2 = M[14] - c[2];
  Q[at + 12] = fc[0] + a0 * t0 + a1 * t1 + a2 * t2;
  Q[at + 13] = fc[1] + a3 * t0 + a4 * t1 + a5 * t2;
  Q[at + 14] = fc[2] + a6 * t0 + a7 * t1 + a8 * t2;
  Q[at + 3] = Q[at + 7] = Q[at + 11] = 0; Q[at + 15] = 1;
  return Q;
}

/** partsBBox over the parts that have geometry (an empty Manifold's box is +-Infinity and would swallow the rest). */
const solidBBox = (parts) => partsBBox(parts.filter((p) => p.manifold.numTri() > 0));

const mat3of = (M) => [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]]; // linear part of a column-major 4x4

/**
 * Manifold.warpBatch, with a fallback: in manifold-3d 3.5.4 the warp glue reads the vertex pointer as a signed 32-bit
 * int, so once the WASM heap passes 2 GB warpBatch throws a RangeError (and warp would read NaN). Then — or when
 * forced — the same warp goes through the mesh: positions out, moved in JS, Manifold.ofMesh back in. Topology is
 * identical (same triangles and merge vectors); positions pass through float32, like every mesh the kernel builds.
 * (The browser worker is recycled at 512 MB and never gets there; long Node runs do.)
 */
function warpManifold(m, fn, viaMesh = false) {
  if (!viaMesh) {
    try { return m.warpBatch(fn); } catch (e) { if (!(e instanceof RangeError)) throw e; }
  }
  const { Manifold, Mesh } = K();
  const g = m.getMesh(), np = g.numProp, V = Float32Array.from(g.vertProperties), n = V.length / np;
  const pos = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) { pos[3 * i] = V[i * np]; pos[3 * i + 1] = V[i * np + 1]; pos[3 * i + 2] = V[i * np + 2]; }
  fn(pos, n);
  for (let i = 0; i < n; i++) { V[i * np] = pos[3 * i]; V[i * np + 1] = pos[3 * i + 1]; V[i * np + 2] = pos[3 * i + 2]; }
  const opts = { numProp: np, vertProperties: V, triVerts: Uint32Array.from(g.triVerts) };
  if (g.mergeFromVert && g.mergeFromVert.length) { opts.mergeFromVert = Uint32Array.from(g.mergeFromVert); opts.mergeToVert = Uint32Array.from(g.mergeToVert); }
  return Manifold.ofMesh(new Mesh(opts));
}
const mat3det = (M) => det3(mat3of(M));

/**
 * Apply ops to an element's parts.
 *
 * Which parts stay rigid (moved rigidly, never bent):
 * - a part tagged by its generator: meta.rigid === true always moves rigidly (each instance, or the part as one piece
 *   when it has no transforms); meta.rigid === false is always warped. Tagging ornament is the robust way;
 * - an untagged part: when it has >= 2 instances (transforms) and its mesh bbox diagonal (times the instance scale) is
 *   below rigidRatio (default RIGID_RATIO = 0.25) of the element's bbox diagonal: balusters, dentils, eggs, leaves and volutes on a
 *   whole column, roof tiles, voussoirs, urns. The outcome of this size rule depends on the element's size: the
 *   balusters of a 3 m balustrade measure 22 % of its diagonal (rigid at 0.25, warped at 0.2), the leaves of a
 *   capital shown on its own 26-37 % (warped, as a sculpt of the capital should be);
 * - everything else (single parts, parts placed once, large repeated parts) is warped; each instance of a warped part
 *   becomes its own piece (same name, meta.instance = i). rigidInstances: false warps everything. A part with no
 *   triangles passes through unchanged.
 *
 * opts:
 *   rigidInstances (true)  small repeated parts move rigidly (see the header); false bakes and warps everything
 *   scaleInstances ('auto') 'auto' median singular value of J | true / 'volume' det(J)^(1/3) | false none
 *   refine (true)          true: deformation-aware edge length; a number: that edge length (m); false: no refinement
 *   tolerance              chord tolerance eps of the refinement (default L / 4000)
 *   maxTris (1.5e6)        triangle budget of the whole element after refinement
 *   rigidRatio (0.25)      "small" = mesh bbox diagonal below this fraction of the element's diagonal (RIGID_RATIO)
 *   ground (true)          translate the result so its lowest point is where the element's was
 *   bbox                   the element's bbox (default partsBBox(parts)) — pass the original one when re-deforming
 *   warpViaMesh (false)    force the mesh path of warpManifold (tests; it is taken automatically past a 2 GB heap)
 * Ops are first passed through resolveOps(ops, parts, bbox, opts) — range / keep 'auto' -> the shaft when there is one,
 * taper lift solved so the height is kept. A preview built on makeDeformer must use that same resolved list (same opts).
 *
 * Returns { parts, warnings, stats, deformer, ops (resolved) }.
 *   parts     rigid parts: same manifold object as the input, new transforms (meta.deform 'rigid'); warped pieces: new
 *             manifolds, transforms null or one ground shift (meta.deform 'warp'). Input parts are never modified.
 *             Warped manifolds are owned by the caller: .delete() them when the result is replaced (never the 'rigid'
 *             ones — they are the input's). If deformParts throws, every manifold it created is already deleted.
 *   warnings  'fold' | 'overlap' | 'refine-capped' | 'not-manifold:<part name>'
 *   stats     { ms, tris (after instancing), rigid: [names], warped: [names], refined (pieces), edge (refinement edge,
 *             m; 0 = none), refineCapped, curvature (H, 1/m), folds, samples, minDet, timing: {rigid, refine, warp} ms,
 *             ground }: ground is the z shift (m) applied after the warp to put the lowest point back on the element's
 *             ground (0 when none). The deformer's point() / frames are BEFORE this shift: a UI drawing lattice points
 *             or handles over the result adds [0, 0, stats.ground].
 *   deformer  makeDeformer(ops resolved, bbox) — the exact map that was applied (point, jacobian, frames, compiled).
 */
export function deformParts(parts, ops, opts = {}) {
  const t0 = now();
  const o = { ...DEFAULT_OPTS, ...opts };
  const bbox = o.bbox || solidBBox(parts);
  const resolved = resolveOps(ops, parts, bbox, o);
  const D = makeDeformer(resolved, bbox);
  const ext = [0, 1, 2].map((k) => bbox.max[k] - bbox.min[k]), L = Math.max(...ext), diag = Math.hypot(...ext);
  const stats = { ms: 0, tris: 0, rigid: [], warped: [], edge: 0, refineCapped: false, folds: 0, samples: 0, curvature: 0, ground: 0, timing: {} };
  const lap = (k, t) => { stats.timing[k] = +(now() - t).toFixed(1); return now(); };
  let tl = now();
  if (D.identity) {
    stats.tris = parts.reduce((s, p) => s + p.manifold.numTri() * instanceCount(p), 0);
    stats.ms = now() - t0;
    return { parts: parts.slice(), warnings: [], stats, deformer: D, ops: resolved };
  }
  const warnings = new Set();
  if (D.overlap) warnings.add('overlap');
  const plan = parts.map((p) => {
    const empty = !(p.manifold.numTri() > 0);
    return { p, n: instanceCount(p), bb: p.manifold.boundingBox(), rigid: isRigid(p, diag, o), empty };
  });

  // fold samples: instance centres (rigid parts) and a stride of the warped vertices
  let foldN = 0, foldMin = Infinity, sampled = 0;
  const Jb = new Float64Array(9);
  const foldAt = (q, J) => {
    const d = det3(J || D.jacobian(q, Jb));
    sampled++;
    if (d < foldMin) foldMin = d;
    if (!(d > 1e-9)) foldN++;
  };

  // ---- rigid instances
  const out = new Array(parts.length);
  let rigidTris = 0;
  for (let pi = 0; pi < plan.length; pi++) {
    const { p, n, bb, rigid } = plan[pi];
    if (!rigid) continue;
    const cl = [0, 1, 2].map((k) => (bb.min[k] + bb.max[k]) / 2);
    const T = new Float64Array(16 * n), I4 = mat.I(), w = rigidScratch();
    for (let i = 0; i < n; i++) {
      const M = p.transforms ? p.transforms.subarray(16 * i, 16 * i + 16) : I4; // a tagged part without instances
      placeRigid(D, M, cl, o.scaleInstances, T, w, 16 * i);
      foldAt(w.c, w.J);
    }
    out[pi] = [{ ...p, transforms: T, meta: { ...p.meta, deform: 'rigid' } }];
    rigidTris += p.manifold.numTri() * n;
    stats.rigid.push(p.name);
  }

  tl = lap('rigid', tl);
  // ---- continuous parts: every instance baked into world space, refined where its edges are too long, warped.
  // Instances stay separate pieces (same part name, meta.instance = i): warping eight 14k-triangle leaves one by one
  // takes 94 ms, composing them into one Manifold first 350-500 ms (measured), and nothing downstream needs one mesh.
  const scaleOf = (M) => (M ? Math.max(Math.hypot(M[0], M[1], M[2]), Math.hypot(M[4], M[5], M[6]), Math.hypot(M[8], M[9], M[10])) : 1);
  // Every Manifold this call creates is registered here (never an input one). Intermediates are freed as soon as they
  // are used; if anything throws (a WASM error, out of memory) everything still registered — mirrored copies, refined
  // meshes, already warped pieces — is deleted before the error is rethrown, so a live drag loop cannot leak.
  const inputs = new Set(parts.map((p) => p.manifold)), created = new Set();
  const own = (m) => { if (!inputs.has(m)) created.add(m); return m; };
  const free = (m) => { if (m && created.delete(m)) m.delete(); };
  const pieces = [];
  try {
    for (let pi = 0; pi < plan.length; pi++) {
      const { p, n, rigid, empty } = plan[pi];
      if (empty) { out[pi] = [p]; continue; } // nothing to move (and a zero volume is no fold)
      if (rigid) continue;
      // per triangle of the shared local mesh (cheap: the local mesh, not the n copies): longest edge and area, which
      // decide whether a piece needs refining and predict how many triangles refining it makes
      const g = p.manifold.getMesh(), V = g.vertProperties, T = g.triVerts, np = g.numProp, nt = T.length / 3;
      const tri = new Float64Array(2 * nt);
      let e2 = 0;
      for (let t = 0; t < nt; t++) {
        const a = T[3 * t] * np, b = T[3 * t + 1] * np, c = T[3 * t + 2] * np;
        const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
        const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
        const wx = V[c] - V[b], wy = V[c + 1] - V[b + 1], wz = V[c + 2] - V[b + 2];
        const m = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx * wx + wy * wy + wz * wz);
        tri[2 * t] = Math.sqrt(m);
        tri[2 * t + 1] = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        if (m > e2) e2 = m;
      }
      for (let i = 0; i < n; i++) {
        const M = p.transforms ? p.transforms.subarray(16 * i, 16 * i + 16) : null, sc = scaleOf(M);
        // an instance with a proper frame (det > 0) is warped straight from the shared local mesh through v -> f(M v),
        // refined to l / scale: no transformed copy is ever built. A mirroring frame would turn the warped mesh inside
        // out (warp keeps the winding), so that one is transformed by Manifold first.
        const direct = !M || mat3det(M) > 0;
        pieces.push({ pi, i, p, M: direct ? M : null, sc: direct ? sc : 1, es: sc, tri, nt, maxEdge: Math.sqrt(e2) * sc,
          src: direct ? p.manifold : own(p.manifold.transform(Array.from(M))) });
      }
    }
    // Predicted triangles of a piece refined to edge l: a triangle splits into about max(ceil(e_max / l), 2.31 A / l^2)
    // (a strip along a sliver, area / equilateral-triangle area for a compact one), so the budget is met before refining.
    const predict = (pc, l) => {
      if (!(l > 0) || pc.maxEdge <= l) return pc.nt;
      let k = 0;
      const s = pc.es / l, s2 = 2.31 * s * s;
      for (let t = 0; t < pc.nt; t++) k += Math.max(1, Math.ceil(pc.tri[2 * t] * s), pc.tri[2 * t + 1] * s2);
      return k;
    };
    // The budget is for the triangles refinement makes: rigid instances are instanced (they cost GPU time, not refinement)
    // and are never refined, so they only shrink the warped pieces' share, down to a floor of a third of maxTris. Before,
    // an assembly whose rigid ornament alone neared maxTris (a Corinthian portico: 1.6 M) was never refined and its
    // entablature bent as straight chords under the curved ornament (audit C1).
    const budget = Math.max(o.maxTris - rigidTris, o.maxTris / 3);
    // summed from rigidTris and compared with budget + rigidTris (= maxTris exactly when the floor is not hit, all
    // integers), so the refinement edge is bit-for-bit what it was whenever the rigid share is small
    const cap = budget + rigidTris;
    const predictAll = (l) => pieces.reduce((acc, pc) => acc + predict(pc, l), rigidTris);
    let ell = 0;
    if (o.refine && D.needsRefine) {
      if (typeof o.refine === 'number' && o.refine > 0) ell = o.refine;
      else {
        // chord rule: an edge of length l under a map with second derivative H sags l^2 H / 8 off the true image, so
        // l = sqrt(8 eps / H) keeps every warped edge within eps of the exact deformation; capped at L / 16 in case
        // the 5^3-grid estimate of H missed a local bend
        const H = D.curvature(), eps = num(o.tolerance, L / 4000);
        stats.curvature = H;
        ell = Math.min(L / 16, H > 1e-12 ? Math.sqrt((8 * eps) / H) : Infinity);
      }
      ell = Math.max(ell, L / 4000);
    }
    if (ell > 0 && predictAll(ell) > cap) {
      // over budget: the coarsest edge that fits (bisection on log l; the prediction falls monotonically with l)
      stats.refineCapped = true;
      const top = Math.max(...pieces.map((pc) => pc.maxEdge), ell);
      if (predictAll(top) > cap) ell = 0; // already over budget unrefined: do not refine at all
      else {
        let lo = ell, hi = top;
        for (let k = 0; k < 24; k++) {
          const mid = Math.sqrt(lo * hi);
          if (predictAll(mid) > cap) lo = mid; else hi = mid;
        }
        ell = hi;
      }
    }
    for (let attempt = 0; ; attempt++) {
      let tris = 0; // warped triangles
      for (const pc of pieces) {
        pc.ref = ell > 0 && pc.maxEdge > ell ? own(pc.src.refineToLength(ell / pc.sc)) : pc.src;
        tris += pc.ref.numTri();
      }
      if (!(ell > 0) || tris <= budget + 0.1 * o.maxTris || attempt >= 2) break;
      // the prediction was short (it is within ~10 % on the families): coarsen by the miss and redo once more
      for (const pc of pieces) if (pc.ref !== pc.src) free(pc.ref);
      ell *= Math.sqrt(tris / Math.max(1, budget)) * 1.05;
      stats.refineCapped = true;
    }
    if (stats.refineCapped) warnings.add('refine-capped');
    stats.edge = ell;
    stats.refined = pieces.filter((pc) => pc.ref !== pc.src).length;
    tl = lap('refine', tl);
    const perPiece = Math.max(100, Math.floor(6000 / Math.max(1, pieces.length)));
    for (const pc of pieces) {
      const m = own(warpManifold(pc.ref, (verts, count) => {
        // a stride of the vertices, before they move, for the fold check (about 6000 samples in all)
        const stride = Math.max(1, Math.floor(count / perPiece));
        const M = pc.M;
        if (M) { // local -> world first
          for (let o = 0; o < 3 * count; o += 3) {
            const x = verts[o], y = verts[o + 1], z = verts[o + 2];
            verts[o] = M[0] * x + M[4] * y + M[8] * z + M[12];
            verts[o + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
            verts[o + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
          }
        }
        for (let i = 0; i < count; i += stride) foldAt([verts[3 * i], verts[3 * i + 1], verts[3 * i + 2]]);
        D.warpBatch(verts, count);
      }, o.warpViaMesh));
      if (m.status() !== 'NoError') warnings.add(`not-manifold:${pc.p.name}`);
      else if (!(m.volume() > 0)) warnings.add('fold');
      if (pc.ref !== pc.src) free(pc.ref);
      free(pc.src);
      const meta = { ...pc.p.meta, deform: 'warp' };
      if (plan[pc.pi].n > 1) meta.instance = pc.i;
      (out[pc.pi] ||= []).push({ ...pc.p, manifold: m, transforms: null, meta });
      if (pc.i === 0) stats.warped.push(pc.p.name);
    }
  } catch (e) {
    for (const m of created) { try { m.delete(); } catch (e2) { /* already freed */ } }
    created.clear();
    throw e;
  }
  tl = lap('warp', tl);

  stats.folds = foldN; stats.samples = sampled; stats.minDet = foldMin;
  if (foldN) warnings.add('fold');
  let result = out.flat();
  if (o.ground) {
    const bb = solidBBox(result), dz = bbox.min[2] - bb.min[2];
    if (Math.abs(dz) > 1e-9) {
      stats.ground = dz; // the deformer's frames are before this shift
      const T = mat.T(0, 0, dz);
      result = result.map((p) => ({ ...p, transforms: p.transforms
        ? instances(Array.from({ length: instanceCount(p) }, (_, i) => mat.mul(T, p.transforms.subarray(16 * i, 16 * i + 16))))
        : instances([T]) }));
    }
  }
  stats.tris = result.reduce((s, p) => s + p.manifold.numTri() * instanceCount(p), 0);
  stats.ms = now() - t0;
  return { parts: result, warnings: [...warnings], stats, deformer: D, ops: resolved };
}

// ================================================================================================ smart stretch

// axis -> spec field the stretch re-parameterises, per element. Decisions (documented in the report):
// - column / pilaster: z -> height; under Vignola the diameter follows (columns of one order are similar figures). x/y
//   have no parameter that keeps the order (null -> free stretch).
// - capital / base / pedestal: null on every axis — their proportions are fixed by the order; a free stretch with the
//   default keep zones lengthens a pedestal's die and keeps its mouldings, which is the right result.
// - roof: x -> length, y -> width (the roof family's convention: length along X), z -> height (the pitch is solved).
// - dome / cupola: x or y -> diameter (a dome stays round); spire: x or y -> width.
// - balustrade x: length (or the baluster count when the spec fixes it); arcade x: length (and the bay count scaled).
// - portico x: the column count, rounded to an even number (tetrastyle, hexastyle, octastyle); z: the column height
//   (or diameter) when the spec gives one, else null — the family's `height` is the columns', not the overall height.
const SMART = {
  column: { z: 'height' }, pilaster: { z: 'height' }, baluster: { z: 'height' },
  finial: { z: 'height' }, urn: { z: 'height' }, obelisk: { z: 'height' },
  spire: { x: 'width', y: 'width', z: 'height' },
  console: { x: 'width', y: 'depth', z: 'height' },
  balustrade: { x: 'length', z: 'height' },
  entablature: { x: 'length', z: 'height' }, cornice: { x: 'length', z: 'height' }, moulding: { x: 'length', z: 'height' },
  arch: { x: 'span', z: 'height' }, arcade: { x: 'length', z: 'height' },
  pediment: { x: 'width', z: 'height' }, window: { x: 'width', z: 'height' }, door: { x: 'width', z: 'height' },
  roof: { x: 'length', y: 'width', z: 'height' },
  dome: { x: 'diameter', y: 'diameter' }, cupola: { x: 'diameter', y: 'diameter' },
  portico: { x: 'columns', z: 'height' },
};

/**
 * Map a stretch of the element along `axis` by `factor` to its spec. size: the element's current extents [x, y, z]
 * (generate().size) — needed when the spec leaves the dimension to the generator (a column's height, an arcade's
 * length). Returns a new spec (values clamped to SCHEMA; may equal the input when a count rounds back) or null when
 * the axis has no parameter (the UI then falls back to a free stretch).
 */
export function smartStretch(spec, axis, factor, size = null) {
  if (!spec || !(axis in AXES) || !(factor > 0) || !Number.isFinite(factor)) return null;
  const el = spec.element || 'column', field = SMART[el] && SMART[el][axis];
  if (!field) return null;
  const out = { ...spec };
  // current values from the normalised spec (DEFAULTS filled: a dome's diameter is its diameter, not the drum cornice's
  // width in the bbox); the bbox extent only for what the generator derives itself (a column's height incl. pedestal)
  const ns = normalize(spec).spec;
  const cur = (f) => {
    if (ns[f] !== undefined && ns[f] !== null && Number.isFinite(+ns[f])) return +ns[f];
    return size && Number.isFinite(size[AXES[axis]]) ? size[AXES[axis]] : null;
  };
  const put = (f, v) => {
    const s = SCHEMA[f];
    let x = s ? clamp(v, s.min, s.max) : v;
    if (s && s.type === 'int') x = Math.round(x);
    out[f] = x;
  };
  if (field === 'columns') {
    const c = num(ns.columns, (DEFAULTS[el] && DEFAULTS[el].columns) || 4);
    const want = 1 + (c - 1) * factor;
    // nearest even count; a tie goes away from the current count so the stretch is felt
    let e = 2 * Math.round(want / 2);
    if (Math.abs(want / 2 - Math.round(want / 2)) === 0.5) e = factor > 1 ? 2 * Math.ceil(want / 2) : 2 * Math.floor(want / 2);
    put('columns', e);
    return out;
  }
  if (el === 'portico' && field === 'height') {
    // a portico's `height` is its columns' height (the order sets everything from D; the steps keep human scale), not
    // the overall height, so the bbox cannot stand in for it: scale what the spec gives, else leave it to a free stretch
    if (Number.isFinite(+ns.height) && ns.height > 0) put('height', ns.height * factor);
    else if (Number.isFinite(+ns.diameter) && ns.diameter > 0) put('diameter', ns.diameter * factor);
    else return null;
    return out;
  }
  if (el === 'balustrade' && field === 'length' && ns.balusters) {
    put('balusters', Math.max(1, Math.round(ns.balusters * factor)));
    return out;
  }
  const v = cur(field);
  if (v === null) return null;
  put(field, v * factor);
  if (el === 'arcade' && field === 'length') put('bays', Math.max(1, Math.round(num(ns.bays, DEFAULTS.arcade.bays) * factor)));
  return out;
}
