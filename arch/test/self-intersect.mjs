// Self-intersection check for one Manifold: counts pairs of triangles that share no vertex and cross each other
// (edge-triangle tests on a uniform grid). Manifold builds closed, oriented meshes but does not check that a mesh made
// from raw triangles (lofts, shells, tubes) does not pass through itself; this does.
//   import { selfIntersections } from './self-intersect.mjs'; selfIntersections(manifold) -> number of crossing pairs
export function selfIntersections(manifold) {
  const g = manifold.getMesh(), np = g.numProp, V = g.vertProperties, T = g.triVerts, nt = T.length / 3;
  const P = (i) => [V[i * np], V[i * np + 1], V[i * np + 2]];
  const tris = Array.from({ length: nt }, (_, t) => [T[3 * t], T[3 * t + 1], T[3 * t + 2]]);
  const bb = manifold.boundingBox(), size = Math.max(...bb.max.map((x, i) => x - bb.min[i]));
  let el = 0;
  const m = Math.min(nt, 2000);
  for (let t = 0; t < m; t++) { const p = P(tris[t][0]), q = P(tris[t][1]); el += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / m; }
  const cell = Math.max(2 * el, size / 200), grid = new Map();
  const box = tris.map((t) => { const ps = t.map(P); return [0, 1, 2].map((a) => [Math.min(...ps.map((p) => p[a])), Math.max(...ps.map((p) => p[a]))]); });
  box.forEach((b, t) => {
    const lo = b.map(([x], a) => Math.floor((x - bb.min[a]) / cell)), hi = b.map(([, x], a) => Math.floor((x - bb.min[a]) / cell));
    for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
      const key = `${i},${j},${k}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(t);
    }
  });
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const segTri = (p, q, a, b, c) => {            // Moller-Trumbore, open segment against the open triangle
    const e1 = sub(b, a), e2 = sub(c, a), d = sub(q, p), h = cross(d, e2), det = dot(e1, h);
    if (Math.abs(det) < 1e-18) return false;
    const f = 1 / det, s = sub(p, a), u = f * dot(s, h);
    if (u < 1e-9 || u > 1 - 1e-9) return false;
    const qq = cross(s, e1), v = f * dot(d, qq);
    if (v < 1e-9 || u + v > 1 - 1e-9) return false;
    const t = f * dot(e2, qq);
    return t > 1e-9 && t < 1 - 1e-9;
  };
  const seen = new Set();
  let hits = 0;
  for (const list of grid.values()) for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
    const A = Math.min(list[x], list[y]), B = Math.max(list[x], list[y]), key = A * nt + B;
    if (seen.has(key)) continue;
    seen.add(key);
    if (tris[A].some((v) => tris[B].includes(v))) continue;
    if (!box[A].every(([lo, hi], a) => hi >= box[B][a][0] && box[B][a][1] >= lo)) continue;
    const pa = tris[A].map(P), pb = tris[B].map(P);
    for (let e = 0; e < 3; e++) if (segTri(pa[e], pa[(e + 1) % 3], ...pb) || segTri(pb[e], pb[(e + 1) % 3], ...pa)) { hits++; break; }
  }
  return hits;
}
