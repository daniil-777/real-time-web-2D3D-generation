// Arch Studio geometry kernel: a thin layer over Manifold (WASM, Apache-2.0) that every generator uses.
// Space is Z-up, metres, origin at the element's base centre, front facing -Y. Matrices are column-major 4x4
// (the layout of three.js Matrix4.elements and of Manifold.transform).
// Spec: /Volumes/LaCie/morph3d/work/2026-10-04-arch-studio-design.md

let W = null;

/** Inject the Manifold module (after `await Module(); wasm.setup()`), once, before any generator runs. */
export function setKernel(wasm) { W = wasm; }
export function K() { if (!W) throw new Error('arch kernel: setKernel(wasm) was not called'); return W; }

const TAU = Math.PI * 2;
export { TAU };

// ------------------------------------------------------------------------------------------------ matrices

export const mat = {
  I() { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  T(x, y, z) { const m = mat.I(); m[12] = x; m[13] = y; m[14] = z; return m; },
  S(x, y = x, z = x) { const m = mat.I(); m[0] = x; m[5] = y; m[10] = z; return m; },
  Rz(a) { const m = mat.I(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; },
  Rx(a) { const m = mat.I(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; },
  Ry(a) { const m = mat.I(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; },
  /** a·b (apply b first, then a). Any number of factors: mul(a, b, c) = a·b·c. */
  mul(...ms) {
    return ms.reduce((a, b) => {
      const o = new Float64Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
      return o;
    });
  },
  apply(m, p) {
    const [x, y, z] = p;
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14]];
  },
};

/** Concatenate matrices into one instance buffer (Float64Array of 16·n). */
export function instances(list) {
  const out = new Float64Array(16 * list.length);
  list.forEach((m, i) => out.set(m, 16 * i));
  return out;
}

/** n instances rotated about Z: angle0 + i·TAU/n, each composed with `local` (applied first). */
export function radial(n, local = mat.I(), angle0 = 0) {
  return instances(Array.from({ length: n }, (_, i) => mat.mul(mat.Rz(angle0 + (i * TAU) / n), local)));
}

// ------------------------------------------------------------------------------------------------ 2D helpers

/** Points of an arc in the plane: centre (cx, cy), radius r, from angle a0 to a1 (radians), n segments (n+1 points). */
export function arc(cx, cy, r, a0, a1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

/** Cubic Bezier from p0 to p3 with handles p1, p2, n segments (n+1 points). */
export function bezier(p0, p1, p2, p3, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
  return out;
}

/** Join point runs, dropping a point that repeats the previous one. */
export function chain(...runs) {
  const out = [];
  for (const run of runs) for (const p of run) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-9 || Math.abs(q[1] - p[1]) > 1e-9) out.push(p);
  }
  return out;
}

export function crossSection(poly) {
  const { CrossSection } = K();
  if (poly instanceof CrossSection) return poly;
  const contours = Array.isArray(poly[0][0]) ? poly : [poly];
  return new CrossSection(contours, 'NonZero');
}

// ------------------------------------------------------------------------------------------------ solids

/** Revolve a closed profile [[r, z], ...] (r >= 0) about the Z axis. */
export function revolve(rz, segs = 96, deg = 360) {
  const { Manifold } = K();
  return Manifold.revolve(crossSection(rz), segs, deg);
}

/** Extrude a polygon (or CrossSection) in XY along +Z to height h. opts: { div, twist (deg), scaleTop }. */
export function extrudeXY(poly, h, opts = {}) {
  const { Manifold } = K();
  return Manifold.extrude(crossSection(poly), h, opts.div || 0, opts.twist || 0, opts.scaleTop ?? [1, 1]);
}

// (a, b, c) -> (x = c, y = a, z = b): a profile drawn in (y, z) and extruded along its local z runs along X.
const PROFILE_TO_X = Float64Array.from([0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1]);

/** A straight run along X of a profile drawn in the (y, z) plane; centred on x = 0 unless centered = false. */
export function extrudeProfileX(yz, length, centered = true) {
  const { Manifold } = K();
  let m = Manifold.extrude(crossSection(yz), length).transform(PROFILE_TO_X);
  if (centered) m = m.translate([-length / 2, 0, 0]);
  return m;
}

/** A box from min corner to max corner. */
export function box(x0, y0, z0, x1, y1, z1) {
  const { Manifold } = K();
  return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0]);
}

/** Close a list of rings into a solid: each ring is a loop of 3D points running counter-clockwise when seen from the
 *  direction the rings advance; consecutive rings have the same point count. Ends are capped with fans to centroids. */
export function sweepRings(rings) {
  const n = rings.length, m = rings[0].length;
  const pos = new Float32Array((n * m + 2) * 3);
  rings.forEach((ring, i) => ring.forEach((p, j) => pos.set(p, (i * m + j) * 3)));
  const cent = (ring) => ring.reduce((s, p) => [s[0] + p[0] / m, s[1] + p[1] / m, s[2] + p[2] / m], [0, 0, 0]);
  const c0 = n * m, c1 = n * m + 1;
  pos.set(cent(rings[0]), c0 * 3);
  pos.set(cent(rings[n - 1]), c1 * 3);
  const tri = [];
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < m; j++) {
    const a = i * m + j, b = i * m + ((j + 1) % m), c = (i + 1) * m + ((j + 1) % m), d = (i + 1) * m + j;
    tri.push(a, b, c, a, c, d);
  }
  for (let j = 0; j < m; j++) {
    tri.push(c0, (j + 1) % m, j);
    tri.push(c1, (n - 1) * m + j, (n - 1) * m + ((j + 1) % m));
  }
  return fromMesh(pos, Uint32Array.from(tri));
}

/** Loft rings of 2D points (star-shaped about the origin, counter-clockwise) placed at heights zs. */
export function loft(rings, zs) {
  return sweepRings(rings.map((ring, i) => ring.map(([x, y]) => [x, y, zs[i]])));
}

/** A closed shell of thickness t around the surface f(u, v) -> [x, y, z], u, v in [0, 1]. t may be a number or
 *  t(u, v). The surface normal (df/du x df/dv) is the outside of the "top" sheet. */
export function thickSurface(f, nu, nv, t) {
  const th = typeof t === 'function' ? t : () => t;
  const P = [], N = [];
  const eps = 1e-4;
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
    const u = i / nu, v = j / nv;
    const p = f(u, v);
    const pu = f(Math.min(1, u + eps), v), pu0 = f(Math.max(0, u - eps), v);
    const pv = f(u, Math.min(1, v + eps)), pv0 = f(u, Math.max(0, v - eps));
    const du = [pu[0] - pu0[0], pu[1] - pu0[1], pu[2] - pu0[2]], dv = [pv[0] - pv0[0], pv[1] - pv0[1], pv[2] - pv0[2]];
    let nx = du[1] * dv[2] - du[2] * dv[1], ny = du[2] * dv[0] - du[0] * dv[2], nz = du[0] * dv[1] - du[1] * dv[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    P.push(p); N.push([nx / l, ny / l, nz / l]);
  }
  const G = (nv + 1), cnt = (nu + 1) * G;
  const pos = new Float32Array(cnt * 2 * 3);
  for (let k = 0; k < cnt; k++) {
    const i = Math.floor(k / G), j = k % G, h = th(i / nu, j / nv) / 2, p = P[k], q = N[k];
    pos.set([p[0] + h * q[0], p[1] + h * q[1], p[2] + h * q[2]], k * 3);
    pos.set([p[0] - h * q[0], p[1] - h * q[1], p[2] - h * q[2]], (cnt + k) * 3);
  }
  const id = (i, j) => i * G + j, tri = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1);
    tri.push(a, b, c, a, c, d);
    tri.push(cnt + a, cnt + c, cnt + b, cnt + a, cnt + d, cnt + c);
  }
  const loop = [];
  for (let i = 0; i < nu; i++) loop.push(id(i, 0));
  for (let j = 0; j < nv; j++) loop.push(id(nu, j));
  for (let i = nu; i > 0; i--) loop.push(id(i, nv));
  for (let j = nv; j > 0; j--) loop.push(id(0, j));
  for (let k = 0; k < loop.length; k++) {
    const p = loop[k], q = loop[(k + 1) % loop.length];
    tri.push(cnt + p, cnt + q, q, cnt + p, q, p);
  }
  return fromMesh(pos, Uint32Array.from(tri));
}

/** A capped tube along a polyline of 3D points; r is a number or r(s) with s in [0, 1] along the path. */
export function tube(pts, r, segs = 12) {
  const rad = typeof r === 'function' ? r : () => r;
  const n = pts.length;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const T = pts.map((p, i) => norm(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)])));
  // parallel transport of a normal along the path
  let nrm = Math.abs(T[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  nrm = norm(cross(cross(T[0], nrm), T[0]));
  const rings = [];
  let len = 0;
  const total = pts.reduce((s, p, i) => (i ? s + Math.hypot(...sub(p, pts[i - 1])) : 0), 0) || 1;
  for (let i = 0; i < n; i++) {
    if (i) {
      len += Math.hypot(...sub(pts[i], pts[i - 1]));
      nrm = norm(sub(nrm, T[i].map((x) => x * dot(nrm, T[i]))));
    }
    const b = cross(T[i], nrm), rr = rad(len / total);
    const ring = [];
    for (let k = 0; k < segs; k++) {
      const a = (k * TAU) / segs, c = Math.cos(a) * rr, s = Math.sin(a) * rr;
      ring.push([pts[i][0] + c * nrm[0] + s * b[0], pts[i][1] + c * nrm[1] + s * b[1], pts[i][2] + c * nrm[2] + s * b[2]]);
    }
    rings.push(ring);
  }
  return sweepRings(rings);
}

/** Manifold from raw triangles; throws when the triangles do not close into an oriented 2-manifold. */
export function fromMesh(positions, indices) {
  const { Manifold, Mesh } = K();
  const mesh = new Mesh({ numProp: 3, vertProperties: Float32Array.from(positions), triVerts: Uint32Array.from(indices) });
  mesh.merge();
  return Manifold.ofMesh(mesh);
}

export function union(list) {
  const { Manifold } = K();
  const l = list.filter(Boolean);
  if (!l.length) throw new Error('union of nothing');
  return l.length === 1 ? l[0] : Manifold.union(l);
}

export function subtract(a, b) { return Array.isArray(b) ? a.subtract(union(b)) : a.subtract(b); }

// ------------------------------------------------------------------------------------------------ parts

/** A named, materialised piece of an element. transforms: instances (Float64Array 16·n) or null for one copy. */
export function part(name, role, manifold, transforms = null, meta = {}) {
  return { name, role, manifold, transforms, meta };
}

export function instanceCount(p) { return p.transforms ? p.transforms.length / 16 : 1; }

export function partTris(p) { return p.manifold.numTri() * instanceCount(p); }

export function partsBBox(parts) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const bb = p.manifold.boundingBox();
    const corners = [];
    for (let k = 0; k < 8; k++) corners.push([(k & 1 ? bb.max : bb.min)[0], (k & 2 ? bb.max : bb.min)[1], (k & 4 ? bb.max : bb.min)[2]]);
    const n = instanceCount(p);
    for (let i = 0; i < n; i++) {
      const m = p.transforms ? p.transforms.subarray(16 * i, 16 * i + 16) : null;
      for (const c of corners) {
        const q = m ? mat.apply(m, c) : c;
        for (let a = 0; a < 3; a++) { if (q[a] < min[a]) min[a] = q[a]; if (q[a] > max[a]) max[a] = q[a]; }
      }
    }
  }
  return { min, max };
}

/** Translate every part (and its instances) so the whole lies on z = 0, centred on x = y = 0 when centre is true. */
export function grounded(parts, centre = true) {
  const { min, max } = partsBBox(parts);
  const t = mat.T(centre ? -(min[0] + max[0]) / 2 : 0, centre ? -(min[1] + max[1]) / 2 : 0, -min[2]);
  return placeParts(parts, t);
}

/** Place a whole list of parts by a matrix (pre-multiplies every instance). */
export function placeParts(parts, m) {
  return parts.map((p) => ({ ...p, transforms: p.transforms
    ? instances(Array.from({ length: instanceCount(p) }, (_, i) => mat.mul(m, p.transforms.subarray(16 * i, 16 * i + 16))))
    : instances([m]) }));
}
