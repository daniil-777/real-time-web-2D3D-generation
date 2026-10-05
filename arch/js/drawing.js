// Arch Studio drawings: the element on screen as a sheet from an architecture office. Front and side elevation and a
// plan in first-angle arrangement (the side seen from the left stands right of the front, the plan below the front),
// hidden lines removed, line weights by depth; the plan of an element with supports is a horizontal section (poché at
// the cut, what lies above dashed); dimension chains with oblique ticks outside the views, centre lines, springing lines
// and pitch marks; a capital detail beside a column; a standard scale with a scale bar (and a scale of modules for the
// orders), and a title strip. Composed in millimetres on A3 landscape; written as SVG or painted on a 2D canvas (PNG).
//
// Pure (no DOM, no kernel): the worker runs makeSheet() on the meshes of the model it holds; the page writes the result
// with toSVG() or paint().
//
// Hidden lines. Each view is rasterised in software into a depth buffer at 12 px per paper millimetre (305 dpi, the
// PNG's own resolution) at pixel centres. The candidate lines are the line mode's feature edges (creases sharper than
// 30°) and the silhouettes (edges between a face turned to the viewer and one turned away), of every instance. Each is
// sampled every half pixel and kept where its depth is at most the deepest of the 3 × 3 depths around it: exact for a
// line on a plane (some neighbouring pixel centre is never nearer than the line), and a hidden line overshoots an
// occluder by at most a pixel, where the occluder's own outline is drawn anyway.
// Line weights, as a draughtsman sets them: a visible line with nothing behind it on one side is the outline; one along
// a step in depth of more than 2 % of the element is a contour; everything else is detail. Where detail lines crowd
// (slates converging at an apex) they are thinned to a legible density.

import { applies } from './spec.js';

export const PAPER = { w: 420, h: 297, name: 'A3' };
export const SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];   // ISO 5455 and the architects' 1:25, 1:250
export const PX_PER_MM = 12;
const FEATURE_DEG = 30;
const FRAME = { x0: 20, y0: 10, x1: 410, y1: 287 };                // ISO 5457: 20 mm filing margin, 10 mm elsewhere
const STRIP = 74;                                                   // title strip on the right
const FIELD = { x0: FRAME.x0 + 8, y0: FRAME.y0 + 8, x1: FRAME.x1 - STRIP - 8, y1: FRAME.y1 - 6 };
// pens (mm), ISO 128 widths
const PEN = { outline: 0.5, contour: 0.35, detail: 0.18, fine: 0.13, ground: 0.7, cut: 0.5, dim: 0.18, tick: 0.35, frame: 0.5, rule: 0.25, hair: 0.13 };
const T0 = 9, DT = 7.5;                                             // first dimension line from the object, tier pitch
const CAP = 16, GAP = 16;                                           // caption block under a view, gap between views
const TICK = 1.25, TXT = 2.5, GRAY = '#444';
const DASH_DOT = [6, 1.2, 0.6, 1.2], DASHED = [2.2, 1.2];

// view frames in the kernel's Z-up space: r (paper right), u (paper up), d (into the paper, away from the viewer)
export const VIEWS = {
  front: { r: [1, 0, 0], u: [0, 0, 1], d: [0, 1, 0], title: 'Front elevation' },
  side: { r: [0, -1, 0], u: [0, 0, 1], d: [1, 0, 0], title: 'Side elevation' },
  top: { r: [1, 0, 0], u: [0, 1, 0], d: [0, 0, -1], title: 'Plan' },
};

// elements that stand on the ground (their elevations get a ground line), and those whose plan is a section
const STANDING = new Set(['column', 'pilaster', 'pedestal', 'portico', 'balustrade', 'baluster', 'arch', 'arcade', 'door', 'obelisk',
  'finial', 'urn', 'spire', 'dome', 'cupola', 'base']);
const COLUMNS = new Set(['column', 'pilaster']);
const OPENINGS = new Set(['arch', 'arcade', 'window', 'door']);
const SECTIONED = new Set(['portico', 'arch', 'arcade', 'window', 'door', 'balustrade']);
const ORDER_LABEL = { tuscan: 'Tuscan', doric: 'Doric', 'greek-doric': 'Greek Doric', ionic: 'Ionic', corinthian: 'Corinthian', composite: 'Composite',
  romanesque: 'Romanesque', gothic: 'Gothic', egyptian: 'Egyptian', solomonic: 'Solomonic', 'art-deco': 'Art Deco', modern: 'Modern' };

// ------------------------------------------------------------------------------------------------ small helpers

class Grow {
  constructor(n = 1 << 16) { this.a = new Float32Array(n); this.n = 0; }
  push4(a, b, c, d) { if (this.n + 4 > this.a.length) this.more(); const A = this.a, o = this.n; A[o] = a; A[o + 1] = b; A[o + 2] = c; A[o + 3] = d; this.n += 4; }
  push6(a, b, c, d, e, f) { if (this.n + 6 > this.a.length) this.more(); const A = this.a, o = this.n; A[o] = a; A[o + 1] = b; A[o + 2] = c; A[o + 3] = d; A[o + 4] = e; A[o + 5] = f; this.n += 6; }
  more() { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
  view() { return this.a.subarray(0, this.n); }
}

const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const now = () => (globalThis.performance ? performance.now() : Date.now());
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Bounding box of render meshes, instances applied (corners of each mesh's box through every instance). */
export function meshesBBox(meshes) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const x of meshes) {
    const P = x.positions, T = x.transforms, n = T ? T.length / 16 : 1;
    if (!P || !P.length) continue;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { if (P[i + a] < lo[a]) lo[a] = P[i + a]; if (P[i + a] > hi[a]) hi[a] = P[i + a]; }
    for (let k = 0; k < n; k++) {
      const M = T ? T.subarray(16 * k, 16 * k + 16) : IDENT;
      for (let c = 0; c < 8; c++) {
        const x0 = c & 1 ? hi[0] : lo[0], y0 = c & 2 ? hi[1] : lo[1], z0 = c & 4 ? hi[2] : lo[2];
        const q = [M[0] * x0 + M[4] * y0 + M[8] * z0 + M[12], M[1] * x0 + M[5] * y0 + M[9] * z0 + M[13], M[2] * x0 + M[6] * y0 + M[10] * z0 + M[14]];
        for (let a = 0; a < 3; a++) { if (q[a] < min[a]) min[a] = q[a]; if (q[a] > max[a]) max[a] = q[a]; }
      }
    }
  }
  return { min, max };
}

/** The view's extent of a box: { a0, a1, b0, b1, c0, c1 } (paper right, paper up, depth). */
function extent(bbox, view) {
  const { r, u, d } = VIEWS[view], e = { a0: Infinity, a1: -Infinity, b0: Infinity, b1: -Infinity, c0: Infinity, c1: -Infinity };
  for (let c = 0; c < 8; c++) {
    const p = [c & 1 ? bbox.max[0] : bbox.min[0], c & 2 ? bbox.max[1] : bbox.min[1], c & 4 ? bbox.max[2] : bbox.min[2]];
    const a = dot3(r, p), b = dot3(u, p), z = dot3(d, p);
    e.a0 = Math.min(e.a0, a); e.a1 = Math.max(e.a1, a); e.b0 = Math.min(e.b0, b); e.b1 = Math.max(e.b1, b); e.c0 = Math.min(e.c0, z); e.c1 = Math.max(e.c1, z);
  }
  return e;
}

// ------------------------------------------------------------------------------------------------ mesh adjacency

/** Welded edges of a mesh with their two faces, the face normals (local) and which edges are creases. Cached. */
function adjacency(mesh) {
  if (mesh._adj) return mesh._adj;
  const P = mesh.positions, T = mesh.indices, nv = P.length / 3, nt = T.length / 3;
  const id = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) id[i] = i;
  if (mesh.mergeFrom && mesh.mergeTo) for (let k = 0; k < mesh.mergeFrom.length; k++) id[mesh.mergeFrom[k]] = mesh.mergeTo[k];
  else {
    const seen = new Map();
    for (let i = 0; i < nv; i++) {
      const key = `${Math.round(P[i * 3] * 1e5)},${Math.round(P[i * 3 + 1] * 1e5)},${Math.round(P[i * 3 + 2] * 1e5)}`;
      const j = seen.get(key);
      if (j === undefined) seen.set(key, i); else id[i] = j;
    }
  }
  const FN = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = id[T[t * 3]] * 3, b = id[T[t * 3 + 1]] * 3, c = id[T[t * 3 + 2]] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
    FN[t * 3] = nx / l; FN[t * 3 + 1] = ny / l; FN[t * 3 + 2] = nz / l;
  }
  const cos = Math.cos((FEATURE_DEG * Math.PI) / 180), first = new Map();
  const ea = [], eb = [], f1 = [], f2 = [], crease = [];
  for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) {
    const a = id[T[t * 3 + e]], b = id[T[t * 3 + ((e + 1) % 3)]];
    if (a === b) continue;
    const key = a < b ? a * nv + b : b * nv + a;
    const o = first.get(key);
    if (o === undefined) { first.set(key, t); continue; }
    first.delete(key);
    ea.push(a); eb.push(b); f1.push(o); f2.push(t);
    crease.push(FN[o * 3] * FN[t * 3] + FN[o * 3 + 1] * FN[t * 3 + 1] + FN[o * 3 + 2] * FN[t * 3 + 2] < cos ? 1 : 0);
  }
  for (const [key, t] of first) {               // open edges (none on a closed solid): drawn when their face shows
    const a = Math.floor(key / nv), b = key - a * nv;
    ea.push(a); eb.push(b); f1.push(t); f2.push(-1); crease.push(1);
  }
  mesh._adj = { id, FN, ea: Uint32Array.from(ea), eb: Uint32Array.from(eb), f1: Int32Array.from(f1), f2: Int32Array.from(f2), crease: Uint8Array.from(crease) };
  return mesh._adj;
}

// ------------------------------------------------------------------------------------------------ rendering a view

/** Pixel grid of a view: k px per metre, origin (A0, B1) at the top-left pixel corner, W x H pixels. */
function gridFor(ext, k, padPx = 6) {
  const A0 = ext.a0 - padPx / k, B1 = ext.b1 + padPx / k;
  return { A0, B1, k, W: Math.ceil((ext.a1 - ext.a0) * k) + 2 * padPx, H: Math.ceil((ext.b1 - ext.b0) * k) + 2 * padPx };
}

/** Depth-buffer one triangle (pixel coordinates x right, y down; depth z) at pixel centres. */
function tri(depth, W, H, x0, y0, z0, x1, y1, z1, x2, y2, z2) {
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (area > -1e-9 && area < 1e-9) return;
  let minX = Math.ceil(Math.min(x0, x1, x2) - 0.5), maxX = Math.floor(Math.max(x0, x1, x2) - 0.5);
  let minY = Math.ceil(Math.min(y0, y1, y2) - 0.5), maxY = Math.floor(Math.max(y0, y1, y2) - 0.5);
  if (minX < 0) minX = 0; if (minY < 0) minY = 0; if (maxX > W - 1) maxX = W - 1; if (maxY > H - 1) maxY = H - 1;
  if (minX > maxX || minY > maxY) return;
  const s = area > 0 ? 1 : -1, inv = 1 / area;
  const px = minX + 0.5, py = minY + 0.5;
  // edge functions (twice the signed sub-areas) at the first pixel centre, and their steps
  let e0r = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
  let e1r = (x0 - x2) * (py - y2) - (y0 - y2) * (px - x2);
  let e2r = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
  const e0x = -(y2 - y1), e1x = -(y0 - y2), e2x = -(y1 - y0), e0y = x2 - x1, e1y = x0 - x2, e2y = x1 - x0;
  const tol = -1e-4 * Math.abs(area) - 1e-6;          // shared edges never leave a crack
  for (let j = minY; j <= maxY; j++) {
    let e0 = e0r, e1 = e1r, e2 = e2r, o = j * W + minX;
    for (let i = minX; i <= maxX; i++, o++) {
      if (s * e0 >= tol && s * e1 >= tol && s * e2 >= tol) {
        const z = (e0 * z0 + e1 * z1 + e2 * z2) * inv;
        if (z < depth[o]) depth[o] = z;
      }
      e0 += e0x; e1 += e1x; e2 += e2x;
    }
    e0r += e0y; e1r += e1y; e2r += e2y;
  }
}

/** Clip a polygon [[x, y, z, w]…] to w <= hi (keep = -1) or w >= lo (keep = +1). */
function clipPoly(poly, lim, keep) {
  const out = [], n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const pin = keep < 0 ? p[3] <= lim : p[3] >= lim, qin = keep < 0 ? q[3] <= lim : q[3] >= lim;
    if (pin) out.push(p);
    if (pin !== qin) {
      const t = (lim - p[3]) / (q[3] - p[3]);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2]), lim]);
    }
  }
  return out;
}

/**
 * Render one view: depth buffer + candidate lines (creases, silhouettes) of every mesh and instance, in pixel space.
 * clip: { lo, hi } keeps the model's z in [lo, hi] (a plan's cut, a detail's band). Returns { depth, cand, grid }.
 */
function renderView(meshes, view, grid, clip = null, lines = true) {
  const { r, u, d } = VIEWS[view], { A0, B1, k, W, H } = grid;
  const depth = new Float32Array(W * H).fill(Infinity);
  const cand = new Grow(1 << 18);
  const lo = clip ? clip.lo ?? -Infinity : -Infinity, hi = clip ? clip.hi ?? Infinity : Infinity;
  let X = new Float32Array(0), Y = X, Z = X, ZW = X, front = new Uint8Array(0);
  for (const mesh of meshes) {
    const P = mesh.positions, T = mesh.indices;
    if (!P || !P.length || !T || !T.length) continue;
    const adj = adjacency(mesh), nv = P.length / 3, nt = T.length / 3, n = mesh.transforms ? mesh.transforms.length / 16 : 1;
    if (X.length < nv) { X = new Float32Array(nv); Y = new Float32Array(nv); Z = new Float32Array(nv); ZW = new Float32Array(nv); }
    if (front.length < nt) front = new Uint8Array(nt);
    const { FN, ea, eb, f1, f2, crease } = adj, ne = ea.length;
    for (let q = 0; q < n; q++) {
      const M = mesh.transforms ? mesh.transforms.subarray(16 * q, 16 * q + 16) : IDENT;
      const row = (v) => [v[0] * M[0] + v[1] * M[1] + v[2] * M[2], v[0] * M[4] + v[1] * M[5] + v[2] * M[6],
        v[0] * M[8] + v[1] * M[9] + v[2] * M[10], v[0] * M[12] + v[1] * M[13] + v[2] * M[14]];
      const ar = row(r), br = row(u), cr = row(d);
      let zmin = Infinity, zmax = -Infinity;
      for (let i = 0, o = 0; i < nv; i++, o += 3) {
        const x = P[o], y = P[o + 1], z = P[o + 2];
        X[i] = (ar[0] * x + ar[1] * y + ar[2] * z + ar[3] - A0) * k;
        Y[i] = (B1 - (br[0] * x + br[1] * y + br[2] * z + br[3])) * k;
        Z[i] = cr[0] * x + cr[1] * y + cr[2] * z + cr[3];
        if (clip) { const w = M[2] * x + M[6] * y + M[10] * z + M[14]; ZW[i] = w; if (w < zmin) zmin = w; if (w > zmax) zmax = w; }
      }
      if (clip && (zmax < lo || zmin > hi)) continue;
      const whole = !clip || (zmin >= lo && zmax <= hi);
      for (let t = 0; t < T.length; t += 3) {
        const a = T[t], b = T[t + 1], c = T[t + 2];
        if (whole || (ZW[a] >= lo && ZW[a] <= hi && ZW[b] >= lo && ZW[b] <= hi && ZW[c] >= lo && ZW[c] <= hi)) {
          tri(depth, W, H, X[a], Y[a], Z[a], X[b], Y[b], Z[b], X[c], Y[c], Z[c]);
          continue;
        }
        let poly = [[X[a], Y[a], Z[a], ZW[a]], [X[b], Y[b], Z[b], ZW[b]], [X[c], Y[c], Z[c], ZW[c]]];
        if (hi < Infinity) poly = clipPoly(poly, hi, -1);
        if (lo > -Infinity && poly.length) poly = clipPoly(poly, lo, 1);
        for (let i = 1; i + 1 < poly.length; i++) {
          const p0 = poly[0], p1 = poly[i], p2 = poly[i + 1];
          tri(depth, W, H, p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
        }
      }
      if (!lines) continue;
      // a face shows when its world normal points against d; world normal ∝ cof(A) n, so n_w · d = n · (adj(A) d),
      // adj(A) having the rows c1 × c2, c2 × c0, c0 × c1 (c_i the columns of A): mirrored instances included
      const c0 = [M[0], M[1], M[2]], c1 = [M[4], M[5], M[6]], c2 = [M[8], M[9], M[10]];
      const cr12 = [c1[1] * c2[2] - c1[2] * c2[1], c1[2] * c2[0] - c1[0] * c2[2], c1[0] * c2[1] - c1[1] * c2[0]];
      const cr20 = [c2[1] * c0[2] - c2[2] * c0[1], c2[2] * c0[0] - c2[0] * c0[2], c2[0] * c0[1] - c2[1] * c0[0]];
      const cr01 = [c0[1] * c1[2] - c0[2] * c1[1], c0[2] * c1[0] - c0[0] * c1[2], c0[0] * c1[1] - c0[1] * c1[0]];
      const dl0 = dot3(cr12, d), dl1 = dot3(cr20, d), dl2 = dot3(cr01, d);
      const eps = 1e-6 * (Math.hypot(dl0, dl1, dl2) || 1);
      for (let f = 0, o = 0; f < nt; f++, o += 3) front[f] = FN[o] * dl0 + FN[o + 1] * dl1 + FN[o + 2] * dl2 < -eps ? 1 : 0;
      for (let e = 0; e < ne; e++) {
        const fa = front[f1[e]], fb = f2[e] >= 0 ? front[f2[e]] : 0;
        if (!(fa !== fb || (crease[e] && (fa || fb)))) continue;
        const a = ea[e], b = eb[e];
        if (whole) { cand.push6(X[a], Y[a], Z[a], X[b], Y[b], Z[b]); continue; }
        // clip the segment to the band
        let ta = 0, tb = 1;
        const wa = ZW[a], wb = ZW[b];
        if (wa === wb) { if (wa < lo || wa > hi) continue; }
        else {
          const t1 = (lo - wa) / (wb - wa), t2 = (hi - wa) / (wb - wa);
          ta = Math.max(ta, Math.min(t1, t2)); tb = Math.min(tb, Math.max(t1, t2));
          if (!(tb > ta)) continue;
        }
        cand.push6(X[a] + ta * (X[b] - X[a]), Y[a] + ta * (Y[b] - Y[a]), Z[a] + ta * (Z[b] - Z[a]),
          X[a] + tb * (X[b] - X[a]), Y[a] + tb * (Y[b] - Y[a]), Z[a] + tb * (Z[b] - Z[a]));
      }
    }
  }
  return { depth, cand: cand.view(), grid };
}

/** 3 x 3 maximum of the depth buffer (the hidden-line test's tolerance for slopes inside a pixel). */
function dilateMax(depth, W, H) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const o = j * W;
    for (let i = 0; i < W; i++) {
      let m = depth[o + i];
      if (i > 0 && depth[o + i - 1] > m) m = depth[o + i - 1];
      if (i < W - 1 && depth[o + i + 1] > m) m = depth[o + i + 1];
      tmp[o + i] = m;
    }
  }
  for (let j = 0; j < H; j++) {
    const o = j * W;
    for (let i = 0; i < W; i++) {
      let m = tmp[o + i];
      if (j > 0 && tmp[o - W + i] > m) m = tmp[o - W + i];
      if (j < H - 1 && tmp[o + W + i] > m) m = tmp[o + W + i];
      out[o + i] = m;
    }
  }
  return out;
}

/**
 * Visible parts of the candidate lines, by weight class (1 detail, 2 contour, 3 outline), as segments in pixels.
 * jump: the depth step (m) that makes a contour.
 */
function hiddenLines(rv, jump) {
  const { depth, cand, grid } = rv, { W, H } = grid;
  const maxD = dilateMax(depth, W, H);
  let near = Infinity, far = -Infinity;
  for (let i = 0; i < depth.length; i++) { const z = depth[i]; if (z < near) near = z; if (z !== Infinity && z > far) far = z; }
  if (near === Infinity) return [null, new Float32Array(0), new Float32Array(0), new Float32Array(0)];
  const eps = 1e-6 * Math.max(1, far - near) + 1e-7 * Math.max(Math.abs(far), Math.abs(near));
  const out = [null, new Grow(1 << 16), new Grow(1 << 16), new Grow(1 << 16)];
  let vis = new Uint8Array(4096), cls = new Uint8Array(4096), sm = new Uint8Array(4096);
  const at = (x, y) => {
    const i = Math.floor(x), j = Math.floor(y);
    return i < 0 || j < 0 || i >= W || j >= H ? Infinity : depth[j * W + i];
  };
  for (let s = 0; s < cand.length; s += 6) {
    const x1 = cand[s], y1 = cand[s + 1], c1 = cand[s + 2], x2 = cand[s + 3], y2 = cand[s + 4], c2 = cand[s + 5];
    if ((x1 < 0 && x2 < 0) || (y1 < 0 && y2 < 0) || (x1 >= W && x2 >= W) || (y1 >= H && y2 >= H)) continue;
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), n = Math.max(1, Math.ceil(len / 0.5));
    if (n + 1 > vis.length) { vis = new Uint8Array(2 * (n + 1)); cls = new Uint8Array(2 * (n + 1)); sm = new Uint8Array(2 * (n + 1)); }
    const nx = len > 1e-9 ? -dy / len : 0, ny = len > 1e-9 ? dx / len : 1;
    let any = false;
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = x1 + t * dx, y = y1 + t * dy, c = c1 + t * (c2 - c1);
      const pi = Math.floor(x), pj = Math.floor(y);
      const v = pi >= 0 && pj >= 0 && pi < W && pj < H && c <= maxD[pj * W + pi] + eps ? 1 : 0;
      vis[i] = v;
      if (!v) continue;
      any = true;
      // across the line: the void on a side makes an outline; a step in depth (the second difference, which a
      // surface seen at a grazing angle does not have) makes a contour
      const za = at(x + 2 * nx, y + 2 * ny), zb = at(x - 2 * nx, y - 2 * ny);
      cls[i] = za === Infinity || zb === Infinity ? 3 : Math.abs(za + zb - 2 * depth[pj * W + pi]) > jump ? 2 : 1;
    }
    if (!any) continue;
    // a majority over five samples steadies the weight along a line (a tie keeps the sample's own class)
    for (let i = 0; i <= n; i++) {
      if (!vis[i]) { sm[i] = 0; continue; }
      const cnt = [0, 0, 0, 0];
      for (let j = Math.max(0, i - 2); j <= Math.min(n, i + 2); j++) if (vis[j]) cnt[cls[j]]++;
      let best = cls[i];
      for (let c = 1; c <= 3; c++) if (cnt[c] > cnt[best]) best = c;
      sm[i] = best;
    }
    const h = 0.5 / n;
    for (let i = 0; i <= n;) {
      if (!vis[i]) { i++; continue; }
      let j = i;
      while (j + 1 <= n && vis[j + 1] && sm[j + 1] === sm[i]) j++;
      const ta = Math.max(0, i / n - h), tb = Math.min(1, j / n + h);
      if (tb > ta) out[sm[i]].push4(x1 + ta * dx, y1 + ta * dy, x1 + tb * dx, y1 + tb * dy);
      i = j + 1;
    }
  }
  return [null, out[1].view(), out[2].view(), out[3].view()];
}

/**
 * Keep detail lines legible where they crowd (tile courses seen at a grazing angle, the two edges of a thin slate,
 * slates converging at an apex): a printed line needs clear space beside it, from the lines that run along it.
 * Polylines are taken longest first; one whose length runs mostly (> 70 %) within `gap` px of a kept line of about the
 * same direction (±22.5°) is left out, the others are kept and mark their neighbourhood with their direction. Long
 * lines (flutes, courses) are kept or dropped whole; lines that cross are never in each other's way; contours and
 * outlines are never thinned. W, H: the view's size in px.
 */
function thinPolylines(pl, W, H, gap) {
  const { pts, starts } = pl, n = starts.length - 1;
  if (n < 50) return pl;
  const C = Math.max(1, gap / 2.5), GW = Math.ceil(W / C) + 2, GH = Math.ceil(H / C) + 2, mask = new Uint8Array(GW * GH);
  const R = Math.ceil(gap / C), R2 = (gap / C) ** 2;
  const len = new Float64Array(n), order = new Uint32Array(n);
  for (let q = 0; q < n; q++) {
    let l = 0;
    for (let i = starts[q]; i + 1 < starts[q + 1]; i++) l += Math.hypot(pts[2 * i + 2] - pts[2 * i], pts[2 * i + 3] - pts[2 * i + 1]);
    len[q] = l; order[q] = q;
  }
  order.sort((a, b) => len[b] - len[a]);
  const keep = new Uint8Array(n);
  // direction buckets 1..8 (22.5° each, modulo 180°)
  const samples = (q, f) => {
    for (let i = starts[q]; i + 1 < starts[q + 1]; i++) {
      const x0 = pts[2 * i], y0 = pts[2 * i + 1], x1 = pts[2 * i + 2], y1 = pts[2 * i + 3], l = Math.hypot(x1 - x0, y1 - y0);
      if (l < 1e-9) continue;
      let ang = Math.atan2(y1 - y0, x1 - x0); if (ang < 0) ang += Math.PI; if (ang >= Math.PI) ang -= Math.PI;
      const dir = 1 + Math.min(7, Math.floor((ang / Math.PI) * 8)), m = Math.max(1, Math.ceil(l / C));
      for (let j = 0; j < m; j++) { const t = (j + 0.5) / m; f((x0 + t * (x1 - x0)) / C + 1, (y0 + t * (y1 - y0)) / C + 1, dir); }
    }
  };
  const along = (a, b) => { const d = Math.abs(a - b); return d <= 1 || d === 7; };
  for (const q of order) {
    let all = 0, near = 0;
    samples(q, (gx, gy, dir) => {
      all++;
      const i = Math.floor(gx), j = Math.floor(gy), m = i >= 0 && j >= 0 && i < GW && j < GH ? mask[j * GW + i] : 0;
      if (m && along(m, dir)) near++;
    });
    if (all > 2 && near > 0.7 * all) continue;
    keep[q] = 1;
    // mark the line's own neighbourhood after the test, so that a line never crowds itself
    samples(q, (gx, gy, dir) => {
      const ci = Math.floor(gx), cj = Math.floor(gy);
      for (let j = Math.max(0, cj - R); j <= Math.min(GH - 1, cj + R); j++) for (let i = Math.max(0, ci - R); i <= Math.min(GW - 1, ci + R); i++) {
        const dx = i + 0.5 - gx, dy = j + 0.5 - gy;
        if (dx * dx + dy * dy <= R2 && !mask[j * GW + i]) mask[j * GW + i] = dir;
      }
    });
  }
  const P = [], S = [0];
  for (let q = 0; q < n; q++) if (keep[q]) { for (let i = starts[q]; i < starts[q + 1]; i++) P.push(pts[2 * i], pts[2 * i + 1]); S.push(P.length / 2); }
  return { pts: Float32Array.from(P), starts: Uint32Array.from(S) };
}

/** Join segments that share end points into polylines and thin them (Douglas–Peucker, tol px). */
function polylines(seg, tol = 0.25) {
  const ns = seg.length / 4;
  if (!ns) return { pts: new Float32Array(0), starts: new Uint32Array([0]) };
  const Q = 32, key = (x, y) => Math.round(x * Q) * 1048576 + Math.round(y * Q);
  const vid = new Map(), ends = new Int32Array(2 * ns);
  for (let s = 0; s < ns; s++) for (let e = 0; e < 2; e++) {
    const kk = key(seg[4 * s + 2 * e], seg[4 * s + 2 * e + 1]);
    let v = vid.get(kk);
    if (v === undefined) { v = vid.size; vid.set(kk, v); }
    ends[2 * s + e] = v;
  }
  const head = new Int32Array(vid.size).fill(-1), next = new Int32Array(2 * ns);
  for (let r = 0; r < 2 * ns; r++) { next[r] = head[ends[r]]; head[ends[r]] = r; }
  const used = new Uint8Array(ns), pts = [], starts = [0];
  const take = (v) => { for (let r = head[v]; r >= 0; r = next[r]) if (!used[r >> 1]) return r; return -1; };
  const P = (r) => [seg[4 * (r >> 1) + 2 * (r & 1)], seg[4 * (r >> 1) + 2 * (r & 1) + 1]];
  for (let s = 0; s < ns; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const fwd = [P(2 * s), P(2 * s + 1)];
    let v = ends[2 * s + 1];
    for (let r = take(v); r >= 0; r = take(v)) { used[r >> 1] = 1; fwd.push(P(r ^ 1)); v = ends[r ^ 1]; }
    const back = [];
    v = ends[2 * s];
    for (let r = take(v); r >= 0; r = take(v)) { used[r >> 1] = 1; back.push(P(r ^ 1)); v = ends[r ^ 1]; }
    for (const p of simplify(back.reverse().concat(fwd), tol)) pts.push(p[0], p[1]);
    starts.push(pts.length / 2);
  }
  return { pts: Float32Array.from(pts), starts: Uint32Array.from(starts) };
}

function simplify(p, tol) {
  if (p.length < 3) return p;
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack = [[0, p.length - 1]], t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = p[a][0], ay = p[a][1], dx = p[b][0] - ax, dy = p[b][1] - ay, l2 = dx * dx + dy * dy;
    let best = -1, bd = t2;
    for (let i = a + 1; i < b; i++) {
      const qx = p[i][0] - ax, qy = p[i][1] - ay, t = l2 > 1e-12 ? (qx * dx + qy * dy) / l2 : 0;
      let d2;
      if (t <= 0 || l2 <= 1e-12) d2 = qx * qx + qy * qy;
      else if (t >= 1) { const ex = p[i][0] - p[b][0], ey = p[i][1] - p[b][1]; d2 = ex * ex + ey * ey; }
      else { const c = qx * dy - qy * dx; d2 = (c * c) / l2; }
      if (d2 > bd) { bd = d2; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return p.filter((_, i) => keep[i]);
}

/** Silhouette queries on a depth buffer (metres in, metres out): the extreme covered points of rows and columns. */
function outlineOf(depth, grid) {
  const { W, H, A0, B1, k } = grid;
  const rowL = new Int32Array(H).fill(-1), rowR = new Int32Array(H).fill(-1), colT = new Int32Array(W).fill(-1), colB = new Int32Array(W).fill(-1);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (depth[j * W + i] === Infinity) continue;
    if (rowL[j] < 0) rowL[j] = i;
    rowR[j] = i;
    if (colT[i] < 0) colT[i] = j;
    colB[i] = j;
  }
  const row = (b) => Math.min(H - 1, Math.max(0, Math.floor((B1 - b) * k)));
  const col = (a) => Math.min(W - 1, Math.max(0, Math.floor((a - A0) * k)));
  const near = (arr, i, n, better) => { let best = -1; for (let q = Math.max(0, i - 2); q <= Math.min(n - 1, i + 2); q++) if (arr[q] >= 0 && (best < 0 || better(arr[q], best))) best = arr[q]; return best; };
  const out = {
    left: (b) => { const i = near(rowL, row(b), H, (x, y) => x < y); return i < 0 ? null : A0 + i / k; },
    right: (b) => { const i = near(rowR, row(b), H, (x, y) => x > y); return i < 0 ? null : A0 + (i + 1) / k; },
    top: (a) => { const j = near(colT, col(a), W, (x, y) => x < y); return j < 0 ? null : B1 - j / k; },
    bottom: (a) => { const j = near(colB, col(a), W, (x, y) => x > y); return j < 0 ? null : B1 - (j + 1) / k; },
  };
  // the same, searching inward a little when the exact row / column is empty (a pointed top, a finial)
  const seek = (f, v, lo, hi, dflt) => { const step = (hi - lo) * 0.004, inward = v > (lo + hi) / 2 ? -1 : 1; for (let i = 0; i < 8; i++) { const r = f(v + inward * i * step); if (r !== null) return r; } return dflt; };
  return {
    ...out,
    leftAt: (b, E) => seek(out.left, b, E.b0, E.b1, E.a0),
    rightAt: (b, E) => seek(out.right, b, E.b0, E.b1, E.a1),
    bottomAt: (a, E) => seek(out.bottom, a, E.a0, E.a1, E.b0),
    topAt: (a, E) => seek(out.top, a, E.a0, E.a1, E.b1),
  };
}

// ------------------------------------------------------------------------------------------------ exact sections

/** Points where the mesh surfaces cross the plane coordinate[axis] = v (instances applied), as [x, y, z] triples. */
function sectionPoints(meshes, axis, v) {
  const out = [];
  for (const mesh of meshes) {
    const P = mesh.positions, T = mesh.indices;
    if (!P || !P.length) continue;
    const n = mesh.transforms ? mesh.transforms.length / 16 : 1, nv = P.length / 3, Wp = new Float64Array(nv * 3);
    for (let q = 0; q < n; q++) {
      const M = mesh.transforms ? mesh.transforms.subarray(16 * q, 16 * q + 16) : IDENT;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0, o = 0; i < nv; i++, o += 3) {
        const x = P[o], y = P[o + 1], z = P[o + 2];
        Wp[o] = M[0] * x + M[4] * y + M[8] * z + M[12]; Wp[o + 1] = M[1] * x + M[5] * y + M[9] * z + M[13]; Wp[o + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
        const c = Wp[o + axis]; if (c < lo) lo = c; if (c > hi) hi = c;
      }
      if (v < lo || v > hi) continue;
      for (let t = 0; t < T.length; t += 3) for (let e = 0; e < 3; e++) {
        const a = 3 * T[t + e], b = 3 * T[t + ((e + 1) % 3)];
        const da = Wp[a + axis] - v, db = Wp[b + axis] - v;
        if ((da > 0) === (db > 0) || da === db) continue;
        const s = da / (da - db);
        out.push([Wp[a] + s * (Wp[b] - Wp[a]), Wp[a + 1] + s * (Wp[b + 1] - Wp[a + 1]), Wp[a + 2] + s * (Wp[b + 2] - Wp[a + 2])]);
      }
    }
  }
  return out;
}

/**
 * The section of the model by the horizontal plane z = h: closed loops (x, y pairs, model metres) oriented with the
 * material on their left seen from above (so overlapping solids fill as their union under the nonzero rule).
 * Crossing points are computed from the lower to the higher vertex index of each welded edge, so the two triangles of
 * an edge give the same point and the loops close exactly.
 */
function sectionLoops(meshes, h) {
  const seg = [];
  for (const mesh of meshes) {
    const P = mesh.positions, T = mesh.indices;
    if (!P || !P.length) continue;
    const { id } = adjacency(mesh);
    const n = mesh.transforms ? mesh.transforms.length / 16 : 1, nv = P.length / 3, Wp = new Float64Array(nv * 3);
    for (let q = 0; q < n; q++) {
      const M = mesh.transforms ? mesh.transforms.subarray(16 * q, 16 * q + 16) : IDENT;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0, o = 0; i < nv; i++, o += 3) {
        const x = P[o], y = P[o + 1], z = P[o + 2];
        Wp[o] = M[0] * x + M[4] * y + M[8] * z + M[12]; Wp[o + 1] = M[1] * x + M[5] * y + M[9] * z + M[13]; Wp[o + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
        if (Wp[o + 2] < lo) lo = Wp[o + 2]; if (Wp[o + 2] > hi) hi = Wp[o + 2];
      }
      if (h <= lo || h >= hi) continue;
      const det = M[0] * (M[5] * M[10] - M[9] * M[6]) - M[4] * (M[1] * M[10] - M[9] * M[2]) + M[8] * (M[1] * M[6] - M[5] * M[2]);
      const flip = det < 0 ? -1 : 1;
      const cross = (a, b) => {                 // a, b welded ids, canonical order
        const p = 3 * Math.min(a, b), r = 3 * Math.max(a, b), s = (h - Wp[p + 2]) / (Wp[r + 2] - Wp[p + 2]);
        return [Wp[p] + s * (Wp[r] - Wp[p]), Wp[p + 1] + s * (Wp[r + 1] - Wp[p + 1])];
      };
      for (let t = 0; t < T.length; t += 3) {
        const v = [id[T[t]], id[T[t + 1]], id[T[t + 2]]], z = v.map((i) => Wp[3 * i + 2] - h);
        const pts = [];
        for (let e = 0; e < 3; e++) { const a = v[e], b = v[(e + 1) % 3]; if ((z[e] > 0) !== (z[(e + 1) % 3] > 0)) pts.push(cross(a, b)); }
        if (pts.length !== 2) continue;
        // face normal (world, horizontal part) decides the direction: material on the left = along z × n
        const A = 3 * v[0], B = 3 * v[1], C = 3 * v[2];
        const ux = Wp[B] - Wp[A], uy = Wp[B + 1] - Wp[A + 1], uz = Wp[B + 2] - Wp[A + 2], vx = Wp[C] - Wp[A], vy = Wp[C + 1] - Wp[A + 1], vz = Wp[C + 2] - Wp[A + 2];
        const nx = flip * (uy * vz - uz * vy), ny = flip * (uz * vx - ux * vz);
        const tx = -ny, ty = nx, dx = pts[1][0] - pts[0][0], dy = pts[1][1] - pts[0][1];
        if (dx * tx + dy * ty >= 0) seg.push(pts[0][0], pts[0][1], pts[1][0], pts[1][1]); else seg.push(pts[1][0], pts[1][1], pts[0][0], pts[0][1]);
      }
    }
  }
  // chain directed segments by their end points
  const ns = seg.length / 4, key = (x, y) => `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
  const from = new Map();
  for (let s = 0; s < ns; s++) { const kk = key(seg[4 * s], seg[4 * s + 1]); if (!from.has(kk)) from.set(kk, []); from.get(kk).push(s); }
  const used = new Uint8Array(ns), loops = [];
  for (let s = 0; s < ns; s++) {
    if (used[s]) continue;
    const loop = [seg[4 * s], seg[4 * s + 1]];
    let cur = s;
    used[cur] = 1;
    for (let guard = 0; guard < ns; guard++) {
      loop.push(seg[4 * cur + 2], seg[4 * cur + 3]);
      const list = from.get(key(seg[4 * cur + 2], seg[4 * cur + 3])) || [];
      const nx = list.find((q) => !used[q]);
      if (nx === undefined) break;
      used[nx] = 1; cur = nx;
    }
    if (loop.length >= 6) loops.push(loop);
  }
  return loops;
}

// ------------------------------------------------------------------------------------------------ text metrics

// Helvetica advance widths (1/1000 em), ASCII 32..126; system-ui is a little wider (the factor below)
const HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611,
  722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
let measureCtx;
export const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
export const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
/** Width in mm of a string at size mm (weight 400 | 600, mono, letter spacing ls mm). */
export function textWidth(str, size, { weight = 400, mono = false, ls = 0 } = {}) {
  str = String(str);
  if (measureCtx === undefined) {
    measureCtx = null;
    try { if (typeof OffscreenCanvas !== 'undefined') measureCtx = new OffscreenCanvas(8, 8).getContext('2d'); } catch (e) { measureCtx = null; }
  }
  let w;
  if (measureCtx) {
    measureCtx.font = `${weight} 100px ${mono ? MONO : FONT}`;
    w = (measureCtx.measureText(str).width / 100) * size;
  } else if (mono) w = 0.6 * size * str.length;
  else {
    let s = 0;
    for (const ch of str) { const c = ch.charCodeAt(0); s += c >= 32 && c <= 126 ? HW[c - 32] : 600; }
    w = (s / 1000) * size * 1.04 * (weight >= 600 ? 1.06 : 1);
  }
  return w + ls * Math.max(0, str.length - 1);
}

function wrap(str, size, width, opts) {
  const words = String(str).split(/\s+/).filter(Boolean), lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (cur && textWidth(t, size, opts) > width) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

// ------------------------------------------------------------------------------------------------ numbers

/** Metres as a draughtsman writes them: centimetres (2.40, 0.45); millimetres only on large-scale sheets (0.225). */
export function fmtM(v, scale = 20) {
  const a = Math.abs(v);
  if (scale <= 20 && a < 1 && Math.abs(Math.round(a * 1000) - Math.round(a * 100) * 10) >= 1) return v.toFixed(3);
  return v.toFixed(2);
}
/** A multiple of D as the orders' books write it: 9, 3¼, 0.4. */
function inD(v) {
  const q = Math.round(v * 4) / 4;
  if (Math.abs(v - q) > 0.02) return v.toFixed(1);
  const w = Math.floor(q), f = { 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[q - w];
  return (w || !f ? String(w) : '') + f;
}
const round1 = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(0, 6);
}
const drawingNo = (spec, deform) => 'AS-' + hash(JSON.stringify(spec) + JSON.stringify(deform || null));

// ------------------------------------------------------------------------------------------------ what to dimension

/** The arch type the arch family builds for a spec (its character(): a Gothic style turns the default type pointed). */
function archTypeOf(spec) {
  let type = spec.archType || 'semicircular';
  if (type === 'semicircular' && (spec.style === 'gothic' || spec.order === 'gothic')) type = 'pointed';
  if (type === 'semicircular' && spec.style === 'moorish') type = 'horseshoe';
  return type;
}

/**
 * Element-specific dimensions in model metres (Z-up), from the generator's own arithmetic where it exports it:
 * { chainLeft: [z…], chainBottom: [x…], axes: [x…], axisSpan, diameter: { z, x0, x1, D }, module, cut: z, key: [[label, value]…] }.
 */
function elementDims(spec, gen, bbox, scale = 20) {
  const el = spec.element, out = { key: [] }, fm = (v) => fmtM(v, scale);
  try {
    if (COLUMNS.has(el) && gen && gen.dimsFor) {
      const d = gen.dimsFor(spec);
      const z = [0];
      for (const h of [d.ped, d.base, d.shaft, d.cap]) if (h > 1e-6) z.push(z[z.length - 1] + h);
      out.chainLeft = z;
      out.axes = [0];
      out.diameter = { z: d.ped + d.base + 0.3 * d.shaft, x0: -d.D / 2, x1: d.D / 2, D: d.D };
      out.module = d.D / 2;
      out.capital = { z0: d.ped + d.base + d.shaft, z1: bbox.max[2] };
      if (d.base > 1e-6) out.baseBand = { z0: d.ped, z1: d.ped + d.base };
      out.key.push(['Lower diameter D', fm(d.D) + ' m'], ['Module M = D/2', fm(d.D / 2) + ' m'], ['Column height', `${fm(d.H)} m = ${inD(d.H / d.D)} D`]);
      if (d.ped) out.key.push(['Pedestal', `${fm(d.ped)} m = ${inD(d.ped / d.D)} D`]);
    } else if ((el === 'capital' || el === 'base') && gen && gen.dimsFor) {
      const d = gen.dimsFor(spec), h = el === 'capital' ? d.cap : d.base;
      out.module = d.D / 2;
      out.key.push(['For a column of Ø', fm(d.D) + ' m'], [el === 'capital' ? 'Capital height' : 'Base height', `${fm(h)} m = ${inD(h / d.D)} D`]);
    } else if ((el === 'dome' || el === 'cupola') && spec.diameter) {
      out.key.push(['Dome Ø', fm(spec.diameter) + ' m'], ['Overall height', fm(bbox.max[2] - bbox.min[2]) + ' m']);
    } else if (el === 'spire' && spec.height) {
      out.key.push(['Height', fm(spec.height) + ' m'], ['Width at the base', fm(spec.width || bbox.max[0] - bbox.min[0]) + ' m']);
    } else if (el === 'portico' && gen && gen.porticoPlan) {
      const pp = gen.porticoPlan(spec), e = pp.O.ent;
      // steps, column, entablature (architrave, frieze and the horizontal cornice), pediment
      const entTop = pp.ped ? Math.min(pp.zc + (e.arch + e.frieze + e.cornice) * pp.D, bbox.max[2] - 0.01) : null;
      const z = [0];
      for (const v of [pp.zs, pp.zc, entTop, bbox.max[2]]) if (v !== null && v - z[z.length - 1] > 1e-3) z.push(v);
      out.chainLeft = z;
      out.chainBottom = [bbox.min[0], ...pp.axes, bbox.max[0]];
      out.axes = pp.axes.slice();
      out.axisSpan = [pp.zs, pp.zc];
      out.module = pp.D / 2;
      out.cut = pp.zs + Math.min(1.0, 0.3 * pp.cd.H);
      out.key.push(['Columns', `${pp.n} × ${ORDER_LABEL[pp.order] || pp.order}`], ['Lower diameter D', fm(pp.D) + ' m'],
        ['Axis spacing', `${fm(pp.axis)} m = ${inD(pp.axis / pp.D)} D`], ['Column height', `${fm(pp.cd.H)} m = ${inD(pp.cd.H / pp.D)} D`]);
    } else if (el === 'balustrade' && gen && gen.layout) {
      const l = gen.layout(spec), d = l.d;
      const z = [0, d.hp, d.hp + d.hb, d.H];
      if (bbox.max[2] > d.H + 1e-3) z.push(bbox.max[2]);
      out.chainLeft = z;
      if (l.peds && l.peds.length) out.chainBottom = [bbox.min[0], ...l.peds.flatMap((p) => [p - d.Wd / 2, p + d.Wd / 2]), bbox.max[0]].filter((x, i, a) => i === 0 || x - a[i - 1] > 1e-3);
      out.cut = 0.42 * d.H;
      out.key.push(['Height', `${fm(d.H)} m`], ['Balusters', `${l.N}`], ['Baluster Ø', `${fm(d.Db)} m`]);
    } else if (el === 'roof' && gen && gen.dims) {
      const D = gen.dims(spec);
      out.roof = { swap: D.swap, B: D.B, B2: D.B2, lo: D.lo, up: D.up, type: D.type };
      // levels above the wall head (z = 0): eave, curb (mansard, gambrel), ridge, then the top (ridge tiles or finial)
      const z = [0];
      for (const v of [D.zE, D.zB, D.zR, bbox.max[2]]) if (Number.isFinite(v) && v - z[z.length - 1] > 0.02) z.push(v);
      out.chainLeft = z;
      out.key.push(['Pitch', D.type === 'mansard' || D.type === 'gambrel' ? `${round1(D.lo)}° / ${round1(D.up)}°` : `${round1(D.lo)}°`],
        ['Footprint (wall line)', `${fm(D.Lx)} × ${fm(D.W)} m`], ['Overhang', `${fm(D.o)} m`], ['Eave', `+${fm(D.zE)} m`]);
      if (Number.isFinite(D.zB)) out.key.push(['Curb', `+${fm(D.zB)} m`]);
      out.key.push([D.type === 'pyramid' ? 'Apex' : D.type === 'shed' ? 'Top of the slope' : 'Ridge', `+${fm(D.zR)} m`]);
    } else if (OPENINGS.has(el)) {
      out.opening = { type: el === 'window' || el === 'door' ? spec.archType || null : archTypeOf(spec), archGeom: gen && gen.archGeom };
    }
  } catch (e) { out.error = e && e.message; }
  return out;
}

/** The right half of an intrados (archGeom result) as (u, v) points from the springing (v = 0) to the crown. */
function intradosPts(g) {
  const pts = [];
  const arc = (a, a0, a1) => { const n = 96; for (let i = 0; i <= n; i++) { const t = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180; pts.push([a.cu + a.r * Math.cos(t), a.cv + a.r * Math.sin(t)]); } };
  if (g.springer) arc(g.arcs[0], g.springer.a0, g.springer.a1);
  g.arcs.forEach((a, i) => {
    let a1 = a.a1;
    if (i === g.arcs.length - 1 && g.apex === 'point') a1 = (Math.acos(Math.max(-1, Math.min(1, -a.cu / a.r))) * 180) / Math.PI;
    arc(a, a.a0, a1);
  });
  return pts;
}
/** Half-width at height v above the springing (first crossing from the springing up), or null. */
function intradosHalf(g, v) {
  const pts = intradosPts(g);
  for (let i = 0; i + 1 < pts.length; i++) {
    const [u0, v0] = pts[i], [u1, v1] = pts[i + 1];
    if ((v0 - v) * (v1 - v) <= 0 && v1 !== v0) return u0 + ((v - v0) / (v1 - v0)) * (u1 - u0);
  }
  return null;
}
/** Height above the springing where the intrados is u from the axis (last crossing on the way to the crown), or null. */
function intradosHeight(g, u) {
  const pts = intradosPts(g);
  for (let i = pts.length - 2; i >= 0; i--) {
    const [u0, v0] = pts[i], [u1, v1] = pts[i + 1];
    if ((u0 - u) * (u1 - u) <= 0 && u1 !== u0) return v0 + ((u - u0) / (u1 - u0)) * (v1 - v0);
  }
  return null;
}

/**
 * Openings of arches, arcades, windows and doors, measured on the model: the clear widths in the front view at the
 * height where the openings are widest (their jambs), exact from the mesh section; the crown and sill on each axis,
 * exact from the vertical section; the springing = crown − the rise of the arch type for that span (archGeom), kept
 * only when the opening's width half-way up the arch matches that intrados.
 */
function measureOpenings(F, meshes, dims) {
  const { E, depth, grid } = F, { W, H, A0, B1, k } = grid;
  const runs = (j) => {
    const o = j * W, res = [];
    let i = 0, last = W - 1;
    while (i < W && depth[o + i] === Infinity) i++;
    while (last >= 0 && depth[o + last] === Infinity) last--;
    for (; i <= last; i++) {
      if (depth[o + i] !== Infinity) continue;
      let e = i;
      while (e + 1 <= last && depth[o + e + 1] === Infinity) e++;
      res.push([i, e]); i = e;
    }
    return res;
  };
  const rows = [];
  for (let q = 0.04; q <= 0.8001; q += 0.01) {
    const b = E.b0 + q * (E.b1 - E.b0), j = Math.floor((B1 - b) * k);
    const rr = runs(j).filter(([s, e]) => e - s + 1 >= 0.03 * (E.a1 - E.a0) * k);
    const w = rr.reduce((s, [a, c]) => s + c - a + 1, 0);
    rows.push({ b, w, rr });
  }
  if (!rows.some((r) => r.w > 0)) return null;
  // the jambs: the longest run of rows with one opening width (a horseshoe's belly or a sliver at an impost is wider
  // but short; bases and imposts narrow the opening only over a few rows)
  const live = rows.filter((r) => r.w > 0);
  let best = null;
  for (const r of live) {
    const n = live.filter((q) => Math.abs(q.w - r.w) <= 2 && q.rr.length === r.rr.length).length;
    if (!best || n > best.n || (n === best.n && r.w > best.r.w)) best = { r, n };
  }
  const plateau = live.filter((q) => Math.abs(q.w - best.r.w) <= 2 && q.rr.length === best.r.rr.length);
  const mid = plateau[Math.floor(plateau.length / 2)], z0 = mid.b;
  const sec = sectionPoints(meshes, 2, z0).map((p) => p[0]).sort((a, b) => a - b);
  if (!sec.length) return null;
  const tol = 3 / k;
  const voids = mid.rr.map(([s, e]) => {
    const a = A0 + s / k, b = A0 + (e + 1) / k, m = (a + b) / 2;
    let xl = -Infinity, xr = Infinity;
    for (const x of sec) { if (x <= m && x >= a - tol && x > xl) xl = x; if (x >= m && x <= b + tol && x < xr) xr = x; }
    return [xl === -Infinity ? a : xl, xr === Infinity ? b : xr];
  });
  const [xa, xb] = voids[voids.length - 1], xc = (xa + xb) / 2, span = xb - xa;
  // the lowest material above the opening on a vertical line x (the intrados there), and the highest below it
  const above = (x) => { let z = Infinity; for (const p of sectionPoints(meshes, 0, x)) if (p[2] > z0 && p[2] < z) z = p[2]; return z; };
  let crown = above(xc), sill = E.b0;
  for (const p of sectionPoints(meshes, 0, xc)) if (p[2] < z0 && p[2] > sill) sill = p[2];
  if (!Number.isFinite(crown)) return { z0, sec, voids, xc, span };
  // an arched head: the springing from the intrados at the quarter points (a keystone's carving can hang below the
  // crown, never that far out), checked against the opening's width half-way up the arch
  let rise = 0, zsp = null, check = null;
  const o = dims.opening;
  if (o && o.type && o.archGeom) {
    try {
      const g = o.archGeom(o.type, span), rr = g.rise || 0, vq = intradosHeight(g, span / 4), half = intradosHalf(g, 0.5 * rr);
      const zl = above(xc - span / 4), zr = above(xc + span / 4);
      if (rr > 0 && vq !== null && half !== null && Number.isFinite(zl) && Number.isFinite(zr) && Math.abs(zl - zr) < 0.01 + 2 / k) {
        const zs = (zl + zr) / 2 - vq;
        const j = Math.floor((B1 - (zs + 0.5 * rr)) * k), ic = Math.floor((xc - A0) * k);
        if (zs > sill + 0.02 && j >= 0 && j < H && depth[j * W + ic] === Infinity) {
          let l = ic, r = ic;
          while (l > 0 && depth[j * W + l - 1] === Infinity) l--;
          while (r < W - 1 && depth[j * W + r + 1] === Infinity) r++;
          check = { measured: (r + 1 - l) / k, expected: 2 * half, quarter: [zl, zr] };
          if (Math.abs((r + 1 - l) / k - 2 * half) <= 3 / k + 0.01 * span) { rise = rr; zsp = zs; crown = zs + rr; }
        }
      }
    } catch (e) { /* no springing */ }
  }
  return { z0, sec, voids, xc, span, crown, sill, rise, zsp, check };
}

// ------------------------------------------------------------------------------------------------ layout

/** Margins (mm) around a view's drawing for tiers of dimensions on each side, and the caption below. */
function margins(t, ground) {
  const side = (n) => (n > 0 ? T0 + (n - 1) * DT + 4.5 : 3);
  const g = ground ? 10 : 0;
  return { l: Math.max(side(t.l), g), r: Math.max(side(t.r), g), t: Math.max(side(t.t), 3), b: side(t.b) + CAP };
}

/** Tiers of dimensions per view and side, for what will be drawn. */
function tiersFor(dims, plan, deformed) {
  const has = (k) => !deformed && dims[k];
  const front = { l: 1 + (has('chainLeft') ? 1 : 0), r: 0, b: 1 + (has('chainBottom') || has('opening') ? 1 : 0), t: 0 };
  const side = { l: 0, r: 0, b: 1, t: 0 };
  const top = plan ? { l: 1, r: 0, b: 1, t: 0 } : null;
  return { front, side, top };
}

/**
 * Choose the scale and place the views. The elevations stand in a row (front, then the side when it is drawn). The
 * plan goes under the front (A) or at the end of the row (B). The largest standard scale at which one arrangement fits
 * the drawing field wins (A on a tie). left: keep the composition at the left of the field (room for details).
 */
function layout(bbox, has, tiers, ground, left = false) {
  const E = { front: extent(bbox, 'front'), side: extent(bbox, 'side'), top: extent(bbox, 'top') };
  const M = { front: margins(tiers.front, ground), side: margins(tiers.side, ground), top: margins(tiers.top || { l: 1, r: 0, b: 1, t: 0 }, false) };
  const FW = FIELD.x1 - FIELD.x0, FH = FIELD.y1 - FIELD.y0;
  const size = (v, f) => [(E[v].a1 - E[v].a0) * f, (E[v].b1 - E[v].b0) * f];
  const top = Math.max(M.front.t, has.side ? M.side.t : 0), bot = Math.max(M.front.b, has.side ? M.side.b : 0);
  const sideW = (f) => (has.side ? GAP + M.side.l + size('side', f)[0] + M.side.r : 0);
  const tryA = (f) => {
    const [wf, hf] = size('front', f);
    let lft = M.front.l, W = lft + wf + M.front.r + sideW(f), H = top + hf + bot;
    if (has.plan) {
      const [wp, hp] = size('top', f);
      lft = Math.max(M.front.l, M.top.l);
      W = Math.max(lft + wf + M.front.r + sideW(f), lft + wp + M.top.r);
      H += GAP + M.top.t + hp + M.top.b;
    }
    return { W, H, lft };
  };
  const tryB = (f) => {
    const [wf, hf] = size('front', f), [wp, hp] = size('top', f);
    return { W: M.front.l + wf + M.front.r + sideW(f) + GAP + M.top.l + wp + M.top.r, H: Math.max(top + hf + bot, M.top.t + hp + M.top.b), lft: M.front.l };
  };
  let best = null;
  for (const s of SCALES) {
    const f = 1000 / s, a = tryA(f);
    if (a.W <= FW && a.H <= FH) { best = { s, f, mode: 'A', box: a }; break; }
    if (has.plan) { const b = tryB(f); if (b.W <= FW && b.H <= FH) { best = { s, f, mode: 'B', box: b }; break; } }
  }
  if (!best) { const s = SCALES[SCALES.length - 1]; best = { s, f: 1000 / s, mode: 'A', box: tryA(1000 / s) }; }
  const { f, mode, box } = best;
  const ox = left ? FIELD.x0 + 6 : FIELD.x0 + (FW - box.W) / 2, oy = FIELD.y0 + (FH - box.H) / 2;
  const [wf, hf] = size('front', f), place = {};
  place.front = { x: ox + box.lft, y: oy + top };
  let x1 = place.front.x + wf + M.front.r;
  if (has.side) { place.side = { x: x1 + GAP + M.side.l, y: place.front.y }; x1 = place.side.x + size('side', f)[0] + M.side.r; }
  if (has.plan) {
    const [wp, hp] = size('top', f);
    if (mode === 'A') { place.top = { x: place.front.x, y: place.front.y + hf + bot + GAP + M.top.t }; x1 = Math.max(x1, place.top.x + wp + M.top.r); }
    else { place.top = { x: x1 + GAP + M.top.l, y: oy + (box.H - (M.top.t + hp + M.top.b)) / 2 + M.top.t }; x1 = place.top.x + wp + M.top.r; }
  }
  // captions: one baseline for the elevations (and a plan in the same row)
  const capY = place.front.y + hf + bot - CAP + 5.5;
  return { scale: best.s, f, mode, E, M, place, capY, used: { x1 }, box, ox, oy };
}

/** True when the side elevation would repeat the front one (a body of revolution, a square plan…): their depth
 *  buffers at a coarse resolution agree to 1 % of the element on all but 0.3 % of the pixels. */
function sameSides(meshes, bbox) {
  const size = [0, 1, 2].map((a) => bbox.max[a] - bbox.min[a]), L = Math.max(...size);
  if (Math.abs(size[0] - size[1]) > 0.004 * Math.max(size[0], size[1]) + 1e-4) return false;
  const k = 320 / L, Ef = extent(bbox, 'front'), Es = extent(bbox, 'side');
  const gf = gridFor(Ef, k, 2), gs = gridFor(Es, k, 2);
  const a = renderView(meshes, 'front', gf, null, false).depth, b = renderView(meshes, 'side', gs, null, false).depth;
  const W = Math.min(gf.W, gs.W), H = Math.min(gf.H, gs.H), tol = 0.01 * L;
  let cov = 0, bad = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const za = a[j * gf.W + i], zb = b[j * gs.W + i], fa = za !== Infinity, fb = zb !== Infinity;
    if (fa || fb) cov++;
    if (fa !== fb || (fa && Math.abs(za - Ef.c0 - (zb - Es.c0)) > tol)) bad++;
  }
  return cov > 0 && bad <= 0.003 * cov;
}

// ------------------------------------------------------------------------------------------------ the sheet

/**
 * The drawing sheet of a model: { w, h, groups: [{ id, w, pts, starts }], items: [...], scale, number, timing }.
 * input: { meshes, spec, deform (resolved ops or null), gen (the generator module, for its dimensions), meta: { title,
 * interpretation, prompt, date } }. Geometry is in sheet millimetres, y down.
 */
export function makeSheet({ meshes, spec, deform = null, gen = null, meta = {}, bbox = null }) {
  const t0 = now(), timing = {};
  bbox = bbox || meshesBBox(meshes);
  const size = [0, 1, 2].map((a) => bbox.max[a] - bbox.min[a]), L = Math.max(...size);
  const deformed = !!(deform && deform.length);
  // the side elevation unless it repeats the front; the plan unless the element is tall and thin (then it takes the
  // place of a side elevation that would repeat the front)
  const side = !sameSides(meshes, bbox);
  const plan = !(size[2] > 2.2 * Math.max(size[0], size[1])) || !side;
  timing.symmetry = Math.round(now() - t0);
  const ground = STANDING.has(spec.element);
  let dims = deformed ? { key: [] } : elementDims(spec, gen, bbox);
  const lay = layout(bbox, { side, plan }, tiersFor(dims, plan, deformed), ground, !deformed && !!dims.capital);
  if (!deformed) dims = elementDims(spec, gen, bbox, lay.scale);   // the figures at the sheet's precision (cm at 1:50 and up)
  const { f } = lay;
  const fm = (v) => fmtM(v, lay.scale);
  const groups = [], items = [], D = new Draw(items), R = {};
  const weights = [null, lay.scale >= 100 ? PEN.fine : PEN.detail, lay.scale >= 100 ? 0.25 : PEN.contour, lay.scale >= 100 ? PEN.contour : PEN.outline];

  /** Render a view (optionally clipped) into line groups placed at P; returns the view record. */
  const draw = (v, E, P, ff, clip = null, opts = {}) => {
    const tv = now(), kk = PX_PER_MM * ff, grid = gridFor(E, kk);
    const rv = renderView(meshes, v, grid, clip);
    const lines = hiddenLines(rv, Math.max(0.02 * L, 3 / kk));
    const sx = ff / kk, ox = P.x + (grid.A0 - E.a0) * ff, oy = P.y + (E.b1 - grid.B1) * ff;
    const classes = opts.only || [1, 2, 3];
    for (const c of classes) {
      let pl = polylines(lines[c], 0.25);
      if (c === 1) pl = thinPolylines(pl, grid.W, grid.H, 0.42 * PX_PER_MM);   // 0.42 mm of clear space
      const pts = pl.pts;
      for (let i = 0; i < pts.length; i += 2) { pts[i] = ox + pts[i] * sx; pts[i + 1] = oy + pts[i + 1] * sx; }
      if (pl.starts.length > 1) groups.push({ id: `${opts.id || v}-${['', 'detail', 'contour', 'outline'][c]}`, w: opts.w || weights[c], pts, starts: pl.starts, ...(opts.dash ? { dash: opts.dash } : {}) });
    }
    timing[opts.id || v] = Math.round(now() - tv);
    return { E, P, f: ff, out: outlineOf(rv.depth, grid), X: (a) => P.x + (a - E.a0) * ff, Y: (b) => P.y + (E.b1 - b) * ff, depth: rv.depth, grid };
  };

  R.front = draw('front', lay.E.front, lay.place.front, f);
  if (side) R.side = draw('side', lay.E.side, lay.place.side, f);
  // the plan: a section through the supports where the element has them, else the view from above
  let cut = null, open = null;
  if (!deformed && dims.opening) {
    open = measureOpenings(R.front, meshes, dims);
    if (open && SECTIONED.has(spec.element)) cut = open.z0;
  }
  if (!deformed && dims.cut !== undefined && SECTIONED.has(spec.element)) cut = dims.cut;
  if (plan) {
    if (cut !== null) {
      // overhead: the outline of what lies above the cut, dashed; then the plan below the cut; then the poché
      R.topAll = draw('top', lay.E.top, lay.place.top, f, { lo: cut }, { id: 'overhead', only: [3], w: PEN.fine, dash: DASHED });
      R.top = draw('top', lay.E.top, lay.place.top, f, { hi: cut });
      poche(D, sectionLoops(meshes, cut), R.top, lay.scale);
    } else R.top = draw('top', lay.E.top, lay.place.top, f);
  }
  if (ground) for (const v of ['front', 'side']) { const r = R[v]; if (r) D.line(r.X(r.E.a0) - 8, r.Y(r.E.b0), r.X(r.E.a1) + 8, r.Y(r.E.b0), PEN.ground); }
  const planNo = side ? 3 : 2;
  annotate(D, R, lay, dims, { spec, deformed, plan, ground, open, cut, fm, planNo });
  // details of a column (capital, base) beside the elevations, where the sheet has room for them at a larger scale
  if (!deformed && dims.capital) details(D, draw, R, lay, dims, fm);
  // captions
  caption(D, R.front.X(lay.E.front.a0), lay.capY, 1, side ? VIEWS.front.title : 'Elevation', `1:${lay.scale}`);
  if (side) caption(D, R.side.X(lay.E.side.a0), lay.capY, 2, VIEWS.side.title, `1:${lay.scale}`);
  if (plan) {
    const r = R.top, y = lay.mode === 'A' ? r.Y(r.E.b0) + lay.M.top.b - CAP + 5.5 : lay.capY;
    caption(D, r.X(r.E.a0), y, planNo, spec.element === 'roof' ? 'Roof plan' : 'Plan', `1:${lay.scale}${cut !== null ? ` · cut at +${fm(cut)}` : ''}`);
  }
  titleStrip(D, { spec, meta, lay, size, dims, deform, fm });
  frame(D);
  for (const r of Object.values(R)) r.depth = null;
  timing.total = Math.round(now() - t0);
  const measured = open ? { span: open.span, spans: open.voids.map(([a, b]) => b - a), crown: open.crown, sill: open.sill, rise: open.rise || 0,
    springing: open.zsp ?? null, check: open.check } : null;
  return { w: PAPER.w, h: PAPER.h, paper: PAPER.name, scale: lay.scale, groups, items, timing, cut, measured, views: Object.keys(R),
    title: meta.title || cap1(spec.element), number: drawingNo(spec, deform) };
}

// ------------------------------------------------------------------------------------------------ drawing primitives

class Draw {
  constructor(items) { this.items = items; }
  line(x1, y1, x2, y2, w = PEN.dim, dash = null) { this.items.push({ t: 'line', x1, y1, x2, y2, w, ...(dash ? { dash } : {}) }); }
  poly(pts, w = PEN.dim, close = false) { this.items.push({ t: 'poly', pts, w, close }); }
  fill(pts, color = '#000') { this.items.push({ t: 'fill', pts, color }); }
  area(loops, color) { this.items.push({ t: 'area', loops, color }); }
  path(pts, starts, w) { this.items.push({ t: 'path', pts, starts, w }); }
  rect(x, y, w, h, lw = PEN.rule) { this.items.push({ t: 'rect', x, y, w, h, lw }); }
  circle(cx, cy, r, lw = PEN.rule) { this.items.push({ t: 'circle', cx, cy, r, lw }); }
  text(x, y, str, size = TXT, o = {}) {
    this.items.push({ t: 'text', x, y, str: String(str), size, anchor: o.anchor || 'start', weight: o.weight || 400, rot: o.rot || 0,
      ...(o.mono ? { mono: true } : {}), ...(o.ls ? { ls: o.ls } : {}), ...(o.color ? { color: o.color } : {}), ...(o.halo ? { halo: true } : {}) });
  }
  arc(cx, cy, r, a0, a1, w = PEN.dim) {
    const n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / 0.08)), pts = [];
    for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
    this.poly(pts, w);
  }
}

/** An oblique tick (45°, the architects' terminator) at (x, y). */
function tick(D, x, y) { D.line(x - TICK * 0.7071, y + TICK * 0.7071, x + TICK * 0.7071, y - TICK * 0.7071, PEN.tick); }

/**
 * A horizontal chain at height y (sheet mm) over the stops xs (increasing), labelled with values; ext: for each stop the
 * y where its extension line starts (beside the object), or null for none. Figures that do not fit between their ticks
 * go beyond the end ticks or are staggered.
 */
function chainH(D, xs, y, values, ext = null, halo = false) {
  const n = xs.length;
  if (n < 2) return;
  D.line(xs[0] - 2, y, xs[n - 1] + 2, y, PEN.dim);
  xs.forEach((x, i) => {
    tick(D, x, y);
    if (ext && ext[i] !== null && ext[i] !== undefined) {
      const down = ext[i] < y, y0 = ext[i] + (down ? 1.5 : -1.5), y1 = y + (down ? 1.5 : -1.5);
      if (Math.abs(y1 - y0) > 1 && (down ? y1 > y0 : y1 < y0)) D.line(x, y0, x, y1, PEN.dim);
    }
  });
  let lastEnd = -Infinity, stagger = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = xs[i], b = xs[i + 1], str = values[i], w = textWidth(str, TXT);
    let x = (a + b) / 2, anchor = 'middle', yy = y - 1;
    if (w + 1.5 > b - a) {
      if (i === 0 && n > 2) { x = a - 1.6; anchor = 'end'; }
      else if (i === n - 2) { x = b + 1.6; anchor = 'start'; }
      else { stagger = 1 - stagger; yy = y - 1 - stagger * 3.2; }
    }
    const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    if (left < lastEnd + 0.8 && yy === y - 1) yy = y - 4.2;
    D.text(x, yy, str, TXT, { anchor, halo });
    lastEnd = left + w;
  }
}

/** A vertical chain at x over the stops ys (sheet mm, increasing downward); figures read from the right (rotated). */
function chainV(D, x, ys, values, ext = null, { textRight = false, halo = false } = {}) {
  const n = ys.length;
  if (n < 2) return;
  D.line(x, ys[0] - 2, x, ys[n - 1] + 2, PEN.dim);
  ys.forEach((y, i) => {
    tick(D, x, y);
    if (ext && ext[i] !== null && ext[i] !== undefined) {
      const right = ext[i] > x, x0 = ext[i] + (right ? -1.5 : 1.5), x1 = x + (right ? -1.5 : 1.5);
      if (Math.abs(x1 - x0) > 1 && (right ? x1 < x0 : x1 > x0)) D.line(x0, y, x1, y, PEN.dim);
    }
  });
  let stagger = 0, lastEnd = -Infinity;
  const off = textRight ? 1 + TXT * 0.75 : -1;
  for (let i = n - 2; i >= 0; i--) {                      // bottom-up, as the text reads
    const a = ys[i], b = ys[i + 1], str = values[i], w = textWidth(str, TXT);
    let y = (a + b) / 2, anchor = 'middle', xx = x + off;
    if (w + 1.5 > b - a) {
      if (i === n - 2 && n > 2) { y = b + 1.6; anchor = 'end'; }
      else if (i === 0) { y = a - 1.6; anchor = 'start'; }
      else { stagger = 1 - stagger; xx = x + off + (textRight ? 1 : -1) * stagger * 3.2; }
    }
    // rotated -90°: 'start' runs upward from the anchor; the extent along the page (bottom = larger y)
    const lo = anchor === 'middle' ? y + w / 2 : anchor === 'start' ? y : y + w;
    if (-lo < lastEnd + 0.8 && xx === x + off) xx = x + off + (textRight ? 3.2 : -3.2);
    D.text(xx, y, str, TXT, { anchor, rot: -90, halo });
    lastEnd = -(lo - w);
  }
}

/** Annotations: dimensions (overall + the element's own), centre lines, springing lines, pitch marks, cut marks. */
function annotate(D, R, lay, dims, { spec, deformed, plan, ground, open, cut, fm, planNo }) {
  const F = R.front, S = R.side, tiers = tiersFor(dims, plan, deformed);
  const extDown = (r, a) => (ground ? r.Y(r.E.b0) : r.Y(r.out.bottomAt(a, r.E)));
  // ---------- front
  {
    const { E, X, Y, out } = F, nl = tiers.front.l, nb = tiers.front.b;
    const xL = X(E.a0) - T0 - (nl - 1) * DT, yB = Y(E.b0) + T0 + (nb - 1) * DT;
    chainV(D, xL, [Y(E.b1), Y(E.b0)], [fm(E.b1 - E.b0)], [X(out.leftAt(E.b1, E)), X(out.leftAt(E.b0, E))]);
    chainH(D, [X(E.a0), X(E.a1)], yB, [fm(E.a1 - E.a0)], [extDown(F, E.a0), extDown(F, E.a1)]);
    if (!deformed && dims.chainLeft) {
      const zs = dims.chainLeft;
      chainV(D, X(E.a0) - T0, zs.map(Y).reverse(), zs.slice(1).map((z, i) => fm(z - zs[i])).reverse(), zs.map((z) => X(out.leftAt(z, E))).reverse());
    }
    if (!deformed && dims.chainBottom) {
      const xs = dims.chainBottom, y1 = Y(E.b0) + T0;
      chainH(D, xs.map(X), y1, xs.slice(1).map((x, i) => fm(x - xs[i])), dims.axes ? null : xs.map((x) => extDown(F, x)));
    }
    if (!deformed && dims.axes) {
      const [z0, z1] = dims.axisSpan || [E.b0, E.b1];
      // centre lines through the columns, down to the axis chain when there is one
      const yEnd = dims.chainBottom ? Y(E.b0) + T0 + 1.5 : Y(z0) + 4;
      for (const a of dims.axes) D.line(X(a), Y(z1) - 4, X(a), yEnd, PEN.hair, DASH_DOT);
      if (S && spec.element !== 'portico') D.line(S.X((S.E.a0 + S.E.a1) / 2), S.Y(z1) - 4, S.X((S.E.a0 + S.E.a1) / 2), S.Y(z0) + 4, PEN.hair, DASH_DOT);
      if (plan && R.top) for (const a of dims.axes) D.line(R.top.X(a), R.top.Y(R.top.E.b1) - 4, R.top.X(a), R.top.Y(R.top.E.b0) + 4, PEN.hair, DASH_DOT);
    }
    if (!deformed && dims.diameter) {
      const d = dims.diameter, y = Y(d.z), xa = X(d.x0), xb = X(d.x1), str = `Ø ${fm(d.D)}`, w = textWidth(str, TXT);
      D.line(xa - 2, y, xb + 2, y, PEN.dim); tick(D, xa, y); tick(D, xb, y);
      if (w + 2 < xb - xa) D.text((xa + xb) / 2, y - 1, str, TXT, { anchor: 'middle', halo: true });
      else D.text(xb + 3, y + 0.9, str, TXT, { anchor: 'start', halo: true });
    }
    if (open) openingDims(D, F, open, dims, fm, (x) => extDown(F, x));
  }
  // ---------- side: overall depth
  if (S) {
    const { E, X, Y } = S, yB = Y(E.b0) + T0 + (tiers.side.b - 1) * DT;
    chainH(D, [X(E.a0), X(E.a1)], yB, [fm(E.a1 - E.a0)], [extDown(S, E.a0), extDown(S, E.a1)]);
  }
  // ---------- plan: width below, depth on the left
  if (plan && R.top) {
    const { E, X, Y, out } = R.top, yB = Y(E.b0) + T0, xL = X(E.a0) - T0;
    chainH(D, [X(E.a0), X(E.a1)], yB, [fm(E.a1 - E.a0)], [Y(out.bottomAt(E.a0, E)), Y(out.bottomAt(E.a1, E))]);
    chainV(D, xL, [Y(E.b1), Y(E.b0)], [fm(E.b1 - E.b0)], [X(out.leftAt(E.b1, E)), X(out.leftAt(E.b0, E))]);
  }
  // ---------- the cut, marked on the front elevation (view 3 is seen from above)
  if (plan && cut !== null) cutMarks(D, F, cut, tiers.front.l, planNo);
  // ---------- roof pitch on the profile view
  if (!deformed && dims.roof && (dims.roof.swap ? F : S)) pitchMarks(D, dims.roof.swap ? F : S, dims.roof);
}

/** Bottom chain (piers and openings), springing line, and the opening's heights on its axis. */
function openingDims(D, F, o, dims, fm, extDown) {
  const { E, X, Y } = F;
  const xs = [o.sec[0], ...o.voids.flat(), o.sec[o.sec.length - 1]];
  chainH(D, xs.map(X), Y(E.b0) + T0, xs.slice(1).map((x, i) => fm(x - xs[i])), xs.map(extDown));
  dims.key.push([o.voids.length > 1 ? 'Clear span (each)' : 'Clear span', fm(o.span) + ' m']);
  if (o.crown === undefined || !Number.isFinite(o.crown)) return;
  const [xa, xb] = o.voids[o.voids.length - 1];
  // the axis, the springing line, and a chain sill / springing / crown just right of the axis, inside the opening
  D.line(X(o.xc), Y(o.crown) - 5, X(o.xc), Y(o.sill) + 5, PEN.hair, DASH_DOT);
  const stops = [o.sill];
  if (o.zsp !== null && o.zsp !== undefined) {
    stops.push(o.zsp);
    D.line(X(xa), Y(o.zsp), X(xb), Y(o.zsp), PEN.hair, DASHED);
  }
  stops.push(o.crown);
  // extension lines from the axis for the sill and the crown (the springing has its own line across the opening)
  const ext = stops.map((z) => (z === o.zsp ? null : X(o.xc))).reverse();
  chainV(D, X(o.xc) + 3.5, stops.map(Y).reverse(), stops.slice(1).map((z, i) => fm(z - stops[i])).reverse(), ext, { textRight: true, halo: true });
  if (o.rise) dims.key.push(['Rise', fm(o.rise) + ' m'], ['Springing', `+${fm(o.zsp)} m`]);
  dims.key.push(['Opening height', fm(o.crown - o.sill) + ' m']);
}

/** Section marks at the cut height on both sides of the front elevation, pointing down (the plan looks down). */
function cutMarks(D, F, h, nl, no) {
  const { E, X, Y } = F, y = Y(h);
  for (const [x0, dir] of [[X(E.a0) - T0 - (nl - 1) * DT - 5, -1], [X(E.a1) + 4, 1]]) {
    const x1 = x0 + dir * 5;
    D.line(x0, y, x1, y, PEN.ground);
    // the arrow (filled) at the outer end, pointing down
    const xa = x1 - dir * 1.2;
    D.fill([xa - 1.1, y + 0.4, xa + 1.1, y + 0.4, xa, y + 2.6]);
    D.text(x1 + dir * 1.2, y + 1, String(no), 2.6, { anchor: dir > 0 ? 'start' : 'end', weight: 600 });
  }
}

/** Poché of the cut: solid black at small scales, a 45° hatch at large ones; the cut outlined with the heavy pen. */
function poche(D, loops, r, scale) {
  if (!loops.length) return;
  const sheet = loops.map((l) => { const o = new Float32Array(l.length); for (let i = 0; i < l.length; i += 2) { o[i] = r.X(l[i]); o[i + 1] = r.Y(l[i + 1]); } return o; });
  if (scale >= 100) D.area(sheet, '#000');
  else {
    D.area(sheet, '#fff');
    const h = hatch(sheet, scale >= 50 ? 1.0 : 1.4);
    if (h.starts.length > 1) D.path(h.pts, h.starts, PEN.fine);
  }
  for (const l of sheet) D.poly(Array.from(l), PEN.cut, true);
}

/** 45° hatch lines (sheet mm) inside loops under the nonzero rule, spacing s. */
function hatch(loops, s) {
  const c = Math.SQRT1_2, rot = (x, y) => [c * (x + y), c * (y - x)];   // u along the hatch, v across it
  const edges = [];
  let vmin = Infinity, vmax = -Infinity;
  for (const l of loops) for (let i = 0; i < l.length; i += 2) {
    const j = (i + 2) % l.length, [u0, v0] = rot(l[i], l[i + 1]), [u1, v1] = rot(l[j], l[j + 1]);
    if (v0 === v1) continue;
    edges.push([u0, v0, u1, v1]);
    vmin = Math.min(vmin, v0, v1); vmax = Math.max(vmax, v0, v1);
  }
  const pts = [], starts = [0];
  for (let v = Math.ceil(vmin / s) * s; v <= vmax; v += s) {
    const xs = [];
    for (const [u0, v0, u1, v1] of edges) if ((v0 <= v) !== (v1 <= v)) xs.push([u0 + ((v - v0) / (v1 - v0)) * (u1 - u0), v1 > v0 ? 1 : -1]);
    xs.sort((a, b) => a[0] - b[0]);
    let w = 0;
    for (let i = 0; i < xs.length; i++) {
      const before = w;
      w += xs[i][1];
      if (before === 0 && w !== 0) {
        let j = i + 1, ww = w;
        for (; j < xs.length; j++) { ww += xs[j][1]; if (ww === 0) break; }
        if (j < xs.length) {
          const u0 = xs[i][0], u1 = xs[j][0];
          pts.push(c * (u0 - v), c * (u0 + v), c * (u1 - v), c * (u1 + v));
          starts.push(pts.length / 2);
          w = 0; i = j;
        }
      }
    }
  }
  return { pts: Float32Array.from(pts), starts: Uint32Array.from(starts) };
}

/** Roof pitch marks on the profile view: an arc between the horizontal and the slope, with the angle. Each slope is
 *  looked for in its own stretch of the span (a mansard's steep brisis between B2 and B, its upper slope inside B2),
 *  half-way along it, where the outline falls at that pitch. */
function pitchMarks(D, V, roof) {
  const { E, X, Y, out } = V;
  const marks = [];
  if (roof.type === 'mansard' || roof.type === 'gambrel') marks.push([roof.B2, roof.B, roof.lo], [0, roof.B2, roof.up]);
  else if (roof.type === 'shed') marks.push([-roof.B, roof.B, roof.lo]);
  else marks.push([0, roof.B, roof.lo]);
  const used = [];
  for (const [lo, hi, deg] of marks) {
    // half-way along the slope first; where something stands in front of it there (a dormer in profile), anywhere on it
    let best = null;
    for (const [u0, u1] of [[0.25, 0.75], [0.03, 0.97]]) {
      for (const sgn of [1, -1]) for (let u = u0; u <= u1 + 1e-9; u += 0.0125) {
        const a = sgn * (lo + u * (hi - lo)), hh = Math.min(0.012 * (E.a1 - E.a0), 0.15 * (hi - lo));
        const z1 = out.top(a - hh), z2 = out.top(a + hh), z = out.top(a);
        if (z1 === null || z2 === null || z === null) continue;
        const slope = (Math.atan2(Math.abs(z1 - z2), 2 * hh) * 180) / Math.PI, err = Math.abs(slope - deg) + 4 * Math.abs(u - 0.5);
        const falling = sgn > 0 ? z1 > z2 : z2 > z1;
        if (falling && !used.includes(sgn) && Math.abs(slope - deg) < 4 && (!best || err < best.err)) best = { a, z, err, dir: sgn, slope };
      }
      if (best) break;
    }
    if (!best || Math.abs(best.slope - deg) > 6) continue;
    used.push(best.dir);
    const px = X(best.a), py = Y(best.z), dir = best.dir, r = 9, th = (deg * Math.PI) / 180;
    // horizontal reference toward the eave, then the arc down to the slope (y down on paper)
    D.line(px, py, px + dir * (r + 4), py, PEN.dim);
    if (dir > 0) D.arc(px, py, r, 0, th, PEN.dim); else D.arc(px, py, r, Math.PI - th, Math.PI, PEN.dim);
    const am = dir > 0 ? th / 2 : Math.PI - th / 2;
    D.text(px + (r + 1.5) * Math.cos(am), py + (r + 1.5) * Math.sin(am) + 0.9, `${round1(deg)}°`, TXT, { anchor: dir > 0 ? 'start' : 'end', halo: true });
  }
}

/**
 * Details of a column at a larger standard scale (at least twice the sheet's), stacked in the free part of the field
 * right of the elevations: A the capital, B the base (with the top of the pedestal). Each has its height and its
 * width figured, a break line where the shaft is cut off, and a detail circle on the front elevation.
 */
function details(D, draw, R, lay, dims, fm) {
  const F = R.front, M = dims.module, c = dims.capital, bs = dims.baseBand, bands = [];
  bands.push({ id: 'A', title: 'Detail: capital', member: [c.z0, c.z1], lo: c.z0 - Math.max(0.5 * (c.z1 - c.z0), 1.4 * M), hi: c.z1, widthAt: 'top' });
  if (bs) bands.push({ id: 'B', title: 'Detail: base', member: [bs.z0, bs.z1], lo: bs.z0 > 1e-6 ? bs.z0 - 0.5 * M : bs.z0, hi: bs.z1 + 1.4 * M, widthAt: 'bottom', onGround: bs.z0 <= 1e-6 });
  for (const b of bands) {                       // the band's width, from the elevation's outline
    let a0 = Infinity, a1 = -Infinity;
    for (let i = 0; i <= 60; i++) {
      const z = b.lo + ((b.hi - b.lo) * i) / 60, l = F.out.left(z), r = F.out.right(z);
      if (l !== null) a0 = Math.min(a0, l);
      if (r !== null) a1 = Math.max(a1, r);
    }
    if (!(a1 > a0)) return;
    const pad = 0.004 * (a1 - a0) + 1e-3;
    b.E = { a0: a0 - pad, a1: a1 + pad, b0: b.lo, b1: b.hi, c0: 0, c1: 0 };
  }
  const x0 = lay.used.x1 + GAP, FW = FIELD.x1 - x0, FH = FIELD.y1 - FIELD.y0;
  if (FW < 60) return;
  const need = (f) => ({ w: Math.max(...bands.map((b) => (b.E.a1 - b.E.a0) * f)) + 2 * T0 + 14,
    h: bands.reduce((s, b) => s + (b.E.b1 - b.E.b0) * f + 2 * T0 + CAP + 4, 0) });
  let s = null;
  for (const sc of SCALES) {
    if (sc > lay.scale / 2) break;
    const n = need(1000 / sc);
    if (n.w <= FW && n.h <= FH) { s = sc; break; }
  }
  if (!s) return;
  const f = 1000 / s, total = need(f).h, gapY = (FH - total) / (bands.length + 1);
  let y = FIELD.y0 + gapY;
  for (const b of bands) {
    const E = b.E, w = (E.a1 - E.a0) * f, h = (E.b1 - E.b0) * f;
    const P = { x: x0 + (FW - w) / 2 + 2, y: y + T0 };
    const r = draw('front', E, P, f, { lo: E.b0, hi: E.b1 + 1e-6 }, { id: 'detail-' + b.id });
    const xl = r.X(E.a0) - 3, xr = r.X(E.a1) + 3, xm = (xl + xr) / 2;
    const brk = (yy) => D.poly([xl, yy, xm - 2, yy, xm - 0.8, yy - 2, xm + 0.8, yy + 2, xm + 2, yy, xr, yy], PEN.dim);
    if (b.id === 'A' || !b.onGround) brk(r.Y(E.b0));
    else D.line(xl - 3, r.Y(E.b0), xr + 3, r.Y(E.b0), PEN.ground);
    if (b.id === 'B') brk(r.Y(E.b1));
    // the member's height on the left, its width above (capital: the abacus) or below (base: the plinth)
    const [m0, m1] = b.member;
    chainV(D, r.X(E.a0) - T0, [r.Y(m1), r.Y(m0)], [fm(m1 - m0)], [r.X(r.out.leftAt(m1, E)), r.X(r.out.leftAt(m0, E))]);
    const zt = b.widthAt === 'top' ? m1 - 0.02 * (m1 - m0) : m0 + 0.02 * (m1 - m0);
    const xa = r.out.leftAt(zt, E), xb = r.out.rightAt(zt, E);
    if (b.widthAt === 'top') chainH(D, [r.X(xa), r.X(xb)], r.Y(E.b1) - T0 + 2, [fm(xb - xa)], [r.Y(r.out.topAt(xa + 1e-3, E)), r.Y(r.out.topAt(xb - 1e-3, E))]);
    else chainH(D, [r.X(xa), r.X(xb)], r.Y(E.b0) + T0, [fm(xb - xa)], [r.Y(m0), r.Y(m0)]);
    D.line(r.X(0), r.Y(E.b1) - 4, r.X(0), r.Y(E.b0) + 4, PEN.hair, DASH_DOT);
    caption(D, r.X(E.a0) - 4, r.Y(E.b0) + T0 + 5.5 + (b.widthAt === 'bottom' ? 2 : 0), b.id, b.title, `1:${s}`);
    // the detail circle on the elevation
    const cx = F.X((E.a0 + E.a1) / 2), cy = F.Y((E.b0 + E.b1) / 2), rr = Math.max(Math.hypot(E.a1 - E.a0, E.b1 - E.b0) * lay.f * 0.55, 5);
    D.circle(cx, cy, rr, PEN.dim);
    const bx = cx + rr * 0.7071 + 2.4, by = cy - rr * 0.7071 - 2.4;
    D.circle(bx, by, 2.6, PEN.dim);
    D.text(bx, by + 0.9, b.id, 2.4, { anchor: 'middle', weight: 600 });
    y += h + 2 * T0 + CAP + 4 + gapY;
  }
}

/** View caption: a numbered circle, the title on a rule, the scale under it. */
function caption(D, x, y, n, title, scale) {
  D.circle(x + 3.5, y, 3.5, PEN.rule);
  D.text(x + 3.5, y + 1.05, String(n), 3, { anchor: 'middle', weight: 600 });
  const T = title.toUpperCase(), tw = textWidth(T, 2.8, { weight: 600, ls: 0.25 });
  D.text(x + 9, y - 0.8, T, 2.8, { weight: 600, ls: 0.25 });
  D.line(x + 9, y + 0.4, x + 9 + Math.max(tw, 18), y + 0.4, PEN.rule);
  D.text(x + 9, y + 3.6, scale, 2.3, { color: GRAY });
}

function frame(D) {
  D.rect(FRAME.x0, FRAME.y0, FRAME.x1 - FRAME.x0, FRAME.y1 - FRAME.y0, PEN.frame);
  const cx = PAPER.w / 2, cy = PAPER.h / 2;                     // centring marks (ISO 5457)
  D.line(cx, 0, cx, FRAME.y0, PEN.frame); D.line(cx, FRAME.y1, cx, PAPER.h, PEN.frame);
  D.line(0, cy, FRAME.x0, cy, PEN.frame); D.line(FRAME.x1, cy, PAPER.w, cy, PEN.frame);
}

// ------------------------------------------------------------------------------------------------ title strip

const MAT = { marble: 'Marble', limestone: 'Limestone', sandstone: 'Sandstone', granite: 'Granite', travertine: 'Travertine', plaster: 'Plaster',
  concrete: 'Concrete', terracotta: 'Terracotta', brick: 'Brick', slate: 'Slate', copper: 'Copper', lead: 'Lead', zinc: 'Zinc', bronze: 'Bronze',
  gold: 'Gold leaf', wood: 'Oak' };
const SPEC_SKIP = new Set(['given', 'seed']);

function titleStrip(D, { spec, meta, lay, size, dims, deform, fm }) {
  const x0 = FRAME.x1 - STRIP, x1 = FRAME.x1, pad = 4, xi = x0 + pad, wi = STRIP - 2 * pad;
  D.line(x0, FRAME.y0, x0, FRAME.y1, PEN.frame);
  let y = FRAME.y0 + 9;
  D.text(xi, y, 'ARCH STUDIO', 3.6, { weight: 600, ls: 0.55 });
  y += 4.2;
  D.text(xi, y, 'Procedural architectural elements', 2.1, { color: GRAY });
  y += 3.6;
  D.line(x0, y, x1, y, PEN.rule);
  // notes
  y += 5;
  label(D, xi, y, 'NOTES');
  y += 3.6;
  const notes = ['All dimensions in metres.', 'Figured dimensions govern; do not scale from the drawing.',
    'Orthographic views of the exact solid model (Manifold CAD kernel); hidden lines removed, line weight by depth.',
    'First-angle projection.'];
  if (deform && deform.length) notes.push(`Transformed (${deform.map(opText).join('; ')}): overall dimensions only.`);
  notes.forEach((n, i) => {
    D.text(xi, y, `${i + 1}.`, 2.1);
    for (const l of wrap(n, 2.1, wi - 4)) { D.text(xi + 4, y, l, 2.1); y += 2.9; }
    y += 0.6;
  });
  if (dims.key && dims.key.length) {
    y += 2.5;
    label(D, xi, y, 'KEY DIMENSIONS');
    y += 3.8;
    for (const [lab, value] of dims.key) {
      D.text(xi, y, lab, 2.2);
      D.text(x1 - pad, y, value, 2.2, { anchor: 'end', weight: 600 });
      y += 3.3;
    }
  }
  y += 2.5;
  label(D, xi, y, 'SPECIFICATION');
  y += 3.4;
  // the fields of this element (normalize() fills frieze and cornice for a column too: spec.js APPLIES)
  const entries = Object.entries(spec).filter(([key, v]) => v !== undefined && v !== null && v !== '' && !SPEC_SKIP.has(key) && applies(key, spec.element))
    .sort(([a], [b]) => (a === 'element' ? -1 : b === 'element' ? 1 : 0));
  const specText = entries.map(([key, v]) => `${key}: ${typeof v === 'number' ? +v.toFixed(3) : v}`).join('  ');
  // lower block heights (bottom-up): number 14, fields 4 x 9.5, element ~ 20–30, scale 15/25, issue 14
  const tl = wrap(meta.title || cap1(spec.element), 4, wi, { weight: 600 }), il = meta.interpretation ? wrap(meta.interpretation, 2.2, wi) : [];
  const hEl = 7 + tl.length * 5 + il.length * 3 + 3, hSc = dims.module ? 25 : 15, hIss = 15;
  const lowerTop = FRAME.y1 - 14 - 38 - hEl - hSc - hIss;
  for (const l of wrap(specText, 1.75, wi, { mono: true })) {
    if (y > lowerTop - 5) { D.text(xi, y, '…', 1.75, { mono: true }); break; }
    D.text(xi, y, l, 1.75, { mono: true, color: '#333' }); y += 2.5;
  }
  // ---------------- lower block, bottom-up
  let yb = FRAME.y1;
  D.line(x0, yb - 14, x1, yb - 14, PEN.rule);
  label(D, xi, yb - 10.6, 'DRAWING NO.');
  D.text(xi, yb - 4.2, drawingNo(spec, deform), 4.2, { weight: 600, ls: 0.15 });
  D.line(x1 - 22, yb - 14, x1 - 22, yb, PEN.rule);
  label(D, x1 - 22 + pad, yb - 10.6, 'SHEET');
  D.text(x1 - 22 + pad, yb - 4.2, '1 / 1', 3.4, { weight: 600 });
  yb -= 14;
  const date = meta.date || new Date().toISOString().slice(0, 10);
  const fields = [
    [['ORDER / STYLE', styleOf(spec)], ['OVERALL', `${fm(size[0])} × ${fm(size[1])} × ${fm(size[2])}`]],
    [['MATERIAL', MAT[spec.material] || (spec.covering ? cap1(String(spec.covering)) : spec.material ? cap1(String(spec.material)) : '—')], ['UNITS', 'metres']],
    [['DRAWN', 'Arch Studio'], ['CHECKED', '—']],
    [['SCALE', `1:${lay.scale} @ ${PAPER.name}`], ['DATE', date]],
  ];
  const xm = x0 + STRIP / 2 - 6;
  for (let i = fields.length - 1; i >= 0; i--) {
    const [[l1, v1], [l2, v2]] = fields[i];
    D.line(x0, yb - 9.5, x1, yb - 9.5, PEN.hair);
    D.line(xm, yb - 9.5, xm, yb, PEN.hair);
    label(D, xi, yb - 6.6, l1); D.text(xi, yb - 2.3, fit(v1, 2.6, xm - xi - 2), 2.6);
    label(D, xm + pad, yb - 6.6, l2); D.text(xm + pad, yb - 2.3, fit(v2, 2.6, x1 - xm - 2 * pad), 2.6);
    yb -= 9.5;
  }
  D.line(x0, yb - hEl, x1, yb - hEl, PEN.rule);
  label(D, xi, yb - hEl + 4.5, 'ELEMENT');
  let yt = yb - hEl + 10;
  for (const l of tl) { D.text(xi, yt, l, 4, { weight: 600 }); yt += 5; }
  yt -= 1;
  for (const l of il) { D.text(xi, yt, l, 2.2, { color: GRAY }); yt += 3; }
  yb -= hEl;
  D.line(x0, yb - hSc, x1, yb - hSc, PEN.rule);
  scaleBar(D, xi, yb - hSc + 5.5, wi - 20, lay.f, lay.scale);
  if (dims.module) moduleBar(D, xi, yb - hSc + 16, wi - 20, lay.f, dims.module, fm);
  firstAngle(D, x1 - pad - 15, yb - hSc + 7.5);
  yb -= hSc;
  // issue
  D.line(x0, yb - hIss, x1, yb - hIss, PEN.rule);
  label(D, xi, yb - hIss + 4.4, 'ISSUE');
  const iy = yb - hIss + 9.2;
  D.text(xi, iy, 'A', 2.2, { weight: 600 }); D.text(xi + 5, iy, date, 2.2); D.text(xi + 27, iy, 'First issue', 2.2, { color: GRAY });
}

/** A deformation op as words (the transform panel's names). */
function opText(o) {
  const deg = (v) => `${round1(v)}°`;
  if (!o || !o.type) return 'deformed';
  if (o.type === 'bend') return o.axis === 'x' ? `plan curve ${deg(o.angle)}` : `bow ${deg(o.angle)}`;
  if (o.type === 'twist') return `twist ${deg(o.angle)}`;
  if (o.type === 'taper') return `taper ${+(+o.scale).toFixed(2)}`;
  if (o.type === 'stretch') return `stretch ${o.axis} × ${+(+o.factor).toFixed(2)}`;
  if (o.type === 'shear') return 'lean';
  if (o.type === 'ffd') return 'free-form lattice';
  return o.type;
}
function label(D, x, y, s) { D.text(x, y, s, 1.8, { weight: 600, ls: 0.25, color: GRAY }); }
function fit(s, size, w) { s = String(s); while (s.length > 3 && textWidth(s, size) > w) s = s.slice(0, -2) + '…'; return s; }
function styleOf(spec) {
  const o = spec.order && ORDER_LABEL[spec.order], s = spec.style && cap1(spec.style.replace(/-/g, ' '));
  return [o, s].filter(Boolean).join(' · ') || '—';
}

/** The ISO first-angle projection symbol: a truncated cone, its end view (the circles) beside its large end. */
function firstAngle(D, x, y) {
  const r1 = 1.2, r2 = 2.4, L = 6;
  D.poly([x, y - r1, x + L, y - r2, x + L, y + r2, x, y + r1], PEN.rule, true);
  D.circle(x + L + 4 + r2, y, r2, PEN.rule);
  D.circle(x + L + 4 + r2, y, r1, PEN.rule);
  D.line(x - 1, y, x + L + 5 + 2 * r2 + 1, y, PEN.hair, [2, 0.6, 0.4, 0.6]);
  D.line(x + L + 4 + r2, y - r2 - 1, x + L + 4 + r2, y + r2 + 1, PEN.hair, [2, 0.6, 0.4, 0.6]);
}

/** Graphic scale: alternating blocks over a round length in metres (1, 2 or 5 × 10^k, in fifths, quarters or fifths)
 *  that fits the width; the figures between the ends only where they have room. */
function scaleBar(D, x, y, w, f, scale) {
  const NICE = [];
  for (let e = -2; e <= 3; e++) for (const m of [1, 2, 5]) NICE.push([m * 10 ** e, m === 2 ? 4 : 5]);
  let L = NICE[0][0], n = 5;
  for (const [v, k] of NICE) if (v * f <= w - 6) { L = v; n = k; }
  const seg = (L / n) * f, h = 1.6;
  D.text(x, y - 1.6, `SCALE 1:${scale}`, 1.9, { weight: 600, ls: 0.25, color: GRAY });
  for (let i = 0; i < n; i++) {
    const xa = x + i * seg;
    D.rect(xa, y, seg, h, PEN.hair);
    if (i % 2 === 0) D.fill([xa, y, xa + seg, y, xa + seg, y + h, xa, y + h]);
  }
  for (let i = 0; i <= n; i++) {
    if (i > 0 && i < n && seg < 6.5) continue;
    D.text(x + i * seg, y + h + 3, i === n ? `${fmtNum((L * i) / n)} m` : fmtNum((L * i) / n), 1.9, { anchor: 'middle' });
  }
}
const fmtNum = (v) => (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(+v.toFixed(2)));

/** Scale of modules (as on Vignola's plates): whole modules, the first divided in six; figures where they fit. */
function moduleBar(D, x, y, w, f, M, fm) {
  const seg = M * f, h = 1.2;
  const n = Math.max(1, Math.min(24, Math.floor((w - 8) / seg)));
  const every = Math.max(1, Math.ceil(5 / seg));
  D.text(x, y - 1.6, `MODULES  M = ${fm(M)} m`, 1.9, { weight: 600, ls: 0.25, color: GRAY });
  for (let i = 0; i < n; i++) {
    const xa = x + i * seg;
    D.rect(xa, y, seg, h, PEN.hair);
    if (i % 2 === 1) D.fill([xa, y, xa + seg, y, xa + seg, y + h, xa, y + h]);
  }
  if (seg > 6) for (let q = 1; q < 6; q++) D.line(x + (q * seg) / 6, y, x + (q * seg) / 6, y + h, PEN.hair);
  for (let i = 0; i <= n; i++) if (i % every === 0 || i === n) {
    if (i === n && n % every !== 0 && (n % every) * seg < 4) continue;
    D.text(x + i * seg, y + h + 3, i === n ? `${i} M` : String(i), 1.9, { anchor: 'middle' });
  }
}

// ------------------------------------------------------------------------------------------------ writers

// XML 1.0 has no place for C0 controls (but tab, line feed, carriage return), U+FFFE / U+FFFF or a lone surrogate: they
// are dropped, so no text (a prompt, a title from a crafted link) can make the SVG malformed
const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const esc = (s) => String(s).replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r2 = (v) => Math.round(v * 100) / 100;
const pairs = (p) => { const o = []; for (let i = 0; i < p.length; i += 2) o.push(`${r2(p[i])},${r2(p[i + 1])}`); return o.join(' '); };
function pathD(P, S, close = false) {
  let d = '';
  for (let q = 0; q + 1 < S.length; q++) {
    const a = S[q], b = S[q + 1];
    if (b - a < 2) continue;
    d += `M${r2(P[2 * a])} ${r2(P[2 * a + 1])}`;
    for (let i = a + 1; i < b; i++) d += `L${r2(P[2 * i])} ${r2(P[2 * i + 1])}`;
    if (close) d += 'Z';
  }
  return d;
}

/** The sheet as an SVG document (millimetres; one group per view and line weight, named for CAD import). */
export function toSVG(sheet) {
  const out = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.w}mm" height="${sheet.h}mm" viewBox="0 0 ${sheet.w} ${sheet.h}">`);
  out.push(`<title>${esc(sheet.title)} · ${esc(sheet.number)}</title>`);
  out.push(`<rect width="${sheet.w}" height="${sheet.h}" fill="#fff"/>`);
  out.push(`<g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">`);
  for (const g of sheet.groups) {
    const d = pathD(g.pts, g.starts);
    if (d) out.push(`<path id="${esc(g.id)}" stroke-width="${g.w}"${g.dash ? ` stroke-dasharray="${g.dash.join(' ')}"` : ''} d="${d}"/>`);
  }
  for (const it of sheet.items) {
    if (it.t === 'line') out.push(`<line x1="${r2(it.x1)}" y1="${r2(it.y1)}" x2="${r2(it.x2)}" y2="${r2(it.y2)}" stroke-width="${it.w}"${it.dash ? ` stroke-dasharray="${it.dash.join(' ')}" stroke-linecap="butt"` : ''}/>`);
    else if (it.t === 'poly') out.push(`<${it.close ? 'polygon' : 'polyline'} points="${pairs(it.pts)}" stroke-width="${it.w}"/>`);
    else if (it.t === 'rect') out.push(`<rect x="${r2(it.x)}" y="${r2(it.y)}" width="${r2(it.w)}" height="${r2(it.h)}" stroke-width="${it.lw}"/>`);
    else if (it.t === 'circle') out.push(`<circle cx="${r2(it.cx)}" cy="${r2(it.cy)}" r="${r2(it.r)}" stroke-width="${it.lw}"/>`);
    else if (it.t === 'fill') out.push(`<polygon points="${pairs(it.pts)}" fill="${it.color || '#000'}" stroke="none"/>`);
    else if (it.t === 'area') {
      let d = '';
      for (const l of it.loops) { d += `M${r2(l[0])} ${r2(l[1])}`; for (let i = 2; i < l.length; i += 2) d += `L${r2(l[i])} ${r2(l[i + 1])}`; d += 'Z'; }
      out.push(`<path d="${d}" fill="${it.color}" fill-rule="nonzero" stroke="none"/>`);
    } else if (it.t === 'path') out.push(`<path d="${pathD(it.pts, it.starts)}" stroke-width="${it.w}"/>`);
  }
  out.push(`</g>`);
  out.push(`<g font-family="${esc(FONT)}" fill="#000" stroke="none">`);
  for (const it of sheet.items) {
    if (it.t !== 'text') continue;
    const attrs = [`x="${r2(it.x)}"`, `y="${r2(it.y)}"`, `font-size="${it.size}"`];
    if (it.weight !== 400) attrs.push(`font-weight="${it.weight}"`);
    if (it.anchor !== 'start') attrs.push(`text-anchor="${it.anchor}"`);
    if (it.rot) attrs.push(`transform="rotate(${it.rot} ${r2(it.x)} ${r2(it.y)})"`);
    if (it.mono) attrs.push(`font-family="${esc(MONO)}"`);
    if (it.ls) attrs.push(`letter-spacing="${it.ls}"`);
    if (it.color) attrs.push(`fill="${it.color}"`);
    if (it.halo) attrs.push('stroke="#fff" stroke-width="0.9" stroke-linejoin="round" paint-order="stroke"');
    out.push(`<text ${attrs.join(' ')}>${esc(it.str)}</text>`);
  }
  out.push(`</g>`);
  out.push(`</svg>`);
  return out.join('\n');
}

/** Paint the sheet on a 2D context at px pixels per millimetre (the canvas is sheet.w·px × sheet.h·px). */
export function paint(ctx, sheet, px) {
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, sheet.w * px, sheet.h * px);
  ctx.scale(px, px);
  ctx.strokeStyle = '#000'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const trace = (P, S, close = false) => {
    for (let q = 0; q + 1 < S.length; q++) {
      const a = S[q], b = S[q + 1];
      if (b - a < 2) continue;
      ctx.moveTo(P[2 * a], P[2 * a + 1]);
      for (let i = a + 1; i < b; i++) ctx.lineTo(P[2 * i], P[2 * i + 1]);
      if (close) ctx.closePath();
    }
  };
  for (const g of sheet.groups) {
    ctx.lineWidth = g.w; ctx.setLineDash(g.dash || []);
    ctx.beginPath(); trace(g.pts, g.starts); ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const it of sheet.items) {
    if (it.t === 'text') continue;
    ctx.beginPath();
    if (it.t === 'line') {
      ctx.lineWidth = it.w; ctx.setLineDash(it.dash || []); ctx.lineCap = it.dash ? 'butt' : 'round';
      ctx.moveTo(it.x1, it.y1); ctx.lineTo(it.x2, it.y2); ctx.stroke(); ctx.setLineDash([]); ctx.lineCap = 'round';
    } else if (it.t === 'poly') {
      ctx.lineWidth = it.w; ctx.moveTo(it.pts[0], it.pts[1]);
      for (let i = 2; i < it.pts.length; i += 2) ctx.lineTo(it.pts[i], it.pts[i + 1]);
      if (it.close) ctx.closePath();
      ctx.stroke();
    } else if (it.t === 'rect') { ctx.lineWidth = it.lw; ctx.strokeRect(it.x, it.y, it.w, it.h); }
    else if (it.t === 'circle') { ctx.lineWidth = it.lw; ctx.arc(it.cx, it.cy, it.r, 0, 2 * Math.PI); ctx.stroke(); }
    else if (it.t === 'fill') {
      ctx.fillStyle = it.color || '#000'; ctx.moveTo(it.pts[0], it.pts[1]);
      for (let i = 2; i < it.pts.length; i += 2) ctx.lineTo(it.pts[i], it.pts[i + 1]);
      ctx.closePath(); ctx.fill();
    } else if (it.t === 'area') {
      ctx.fillStyle = it.color;
      for (const l of it.loops) { ctx.moveTo(l[0], l[1]); for (let i = 2; i < l.length; i += 2) ctx.lineTo(l[i], l[i + 1]); ctx.closePath(); }
      ctx.fill('nonzero');
    } else if (it.t === 'path') { ctx.lineWidth = it.w; trace(it.pts, it.starts); ctx.stroke(); }
  }
  for (const it of sheet.items) {
    if (it.t !== 'text') continue;
    ctx.save();
    ctx.translate(it.x, it.y);
    if (it.rot) ctx.rotate((it.rot * Math.PI) / 180);
    // canvas fonts are given in pixels: draw at 10x and scale down (small fractional sizes round badly)
    ctx.scale(0.1, 0.1);
    ctx.font = `${it.weight} ${it.size * 10}px ${it.mono ? MONO : FONT}`;
    ctx.textAlign = it.anchor === 'middle' ? 'center' : it.anchor === 'end' ? 'right' : 'left';
    ctx.textBaseline = 'alphabetic';
    if ('letterSpacing' in ctx) ctx.letterSpacing = it.ls ? `${it.ls * 10}px` : '0px';
    if (it.halo) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 9; ctx.lineJoin = 'round'; ctx.strokeText(it.str, 0, 0); }
    ctx.fillStyle = it.color || '#000';
    ctx.fillText(it.str, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

// ------------------------------------------------------------------------------------------------ PNG resolution

let CRC;
function crc32(bytes, start, end) {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG (bytes) with its pHYs chunk set to dpi (an existing one is replaced), so it prints at its true size. */
export function pngWithDpi(png, dpi) {
  const u8 = png instanceof Uint8Array ? png : new Uint8Array(png);
  const ppm = Math.round(dpi / 0.0254), chunk = new Uint8Array(21), dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9); chunk.set([0x70, 0x48, 0x59, 0x73], 4);
  dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
  dv.setUint32(17, crc32(chunk, 4, 17));
  const parts = [u8.subarray(0, 8)], view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let o = 8; o + 8 <= u8.length;) {
    const len = view.getUint32(o), type = String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]), end = o + 12 + len;
    if (type !== 'pHYs') parts.push(u8.subarray(o, end));
    if (type === 'IHDR') parts.push(chunk);
    o = end;
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let q = 0;
  for (const p of parts) { out.set(p, q); q += p.length; }
  return out;
}

/** Dots per inch of a PNG from its pHYs chunk, or null. */
export function pngDpi(png) {
  const u8 = png instanceof Uint8Array ? png : new Uint8Array(png), view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let o = 8; o + 8 <= u8.length;) {
    const len = view.getUint32(o), type = String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]);
    if (type === 'pHYs') return u8[o + 16] === 1 ? view.getUint32(o + 8) * 0.0254 : null;
    o += 12 + len;
  }
  return null;
}
