// Arch Studio exporters: render meshes -> GLB (glTF 2.0 binary), OBJ, binary STL. Pure ES module: no Manifold import,
// no three.js, so the worker, the page and the Node tests share it.
//
// A "mesh" here is one part of an element, as the worker posts it:
//   { name, role, material, positions: Float32Array (xyz, Z-up metres), normals: Float32Array | null,
//     indices: Uint32Array, transforms: Float64Array (16·n, column-major, Z-up) | null }
// Exports: GLB and OBJ are Y-up metres (glTF convention; Y = Z, Z = -Y); STL stays Z-up in millimetres (slicers
// assume mm and Z-up).

// ------------------------------------------------------------------------------------------------ materials

/** PBR presets per material key (base colour in sRGB hex). Shared by the viewer (which adds procedural noise on top)
 *  and the GLB exporter. */
export const PBR = {
  marble: { color: '#efece6', roughness: 0.36, metalness: 0, label: 'Carrara marble' },
  limestone: { color: '#d8cdb8', roughness: 0.84, metalness: 0, label: 'limestone' },
  sandstone: { color: '#c39960', roughness: 0.9, metalness: 0, label: 'sandstone' },
  granite: { color: '#7a7672', roughness: 0.5, metalness: 0, label: 'granite' },
  travertine: { color: '#e0d1b2', roughness: 0.74, metalness: 0, label: 'travertine' },
  plaster: { color: '#f3f1ec', roughness: 0.93, metalness: 0, label: 'plaster' },
  concrete: { color: '#a8a6a1', roughness: 0.9, metalness: 0, label: 'concrete' },
  terracotta: { color: '#6c2c10', roughness: 0.82, metalness: 0, label: 'terracotta' },
  brick: { color: '#5c2717', roughness: 0.88, metalness: 0, label: 'brick' },
  slate: { color: '#4b535e', roughness: 0.62, metalness: 0, label: 'slate' },
  copper: { color: '#346a5a', roughness: 0.66, metalness: 0.08, label: 'copper (verdigris)' },
  lead: { color: '#878c92', roughness: 0.58, metalness: 0.55, label: 'lead' },
  zinc: { color: '#9aa2a8', roughness: 0.42, metalness: 0.8, label: 'zinc' },
  bronze: { color: '#8a6a3e', roughness: 0.42, metalness: 1, label: 'bronze' },
  gold: { color: '#e6b94c', roughness: 0.26, metalness: 1, label: 'gilded' },
  wood: { color: '#694b28', roughness: 0.72, metalness: 0, label: 'oak' },
  glass: { color: '#1f2a31', roughness: 0.06, metalness: 0, label: 'glass' },
};

const STONE_LIKE = new Set(['marble', 'limestone', 'sandstone', 'granite', 'travertine', 'plaster', 'concrete', 'terracotta', 'brick']);
const ROOF_LIKE = new Set(['slate', 'copper', 'lead', 'zinc', 'terracotta', 'gold', 'wood']);
const COVERING = { tiles: 'terracotta', pantiles: 'terracotta', slate: 'slate', seam: 'zinc', shingles: 'wood' };
const ROOF_ELEMENTS = new Set(['roof', 'dome', 'cupola', 'spire']);

/** The material key of a part: the generator's own choice (part.meta.material: gutters 'zinc', fascia 'wood', walls
 *  'plaster'…) when it made one, otherwise from its role and the (normalised) spec. */
export function materialFor(role, spec = {}, meta = null) {
  if (meta && meta.material && PBR[meta.material]) return meta.material;
  const m = spec.material, el = spec.element;
  switch (role) {
    case 'roof':
      if (el === 'roof') {
        // a roof is what it is covered with; the material only refines tiles (terracotta) and seams (which metal)
        if (spec.covering === 'slate') return 'slate';
        if (spec.covering === 'shingles') return m === 'slate' ? 'slate' : 'wood';
        if (spec.covering === 'seam') return ['copper', 'zinc', 'lead', 'gold'].includes(m) ? m : 'zinc';
        return ROOF_LIKE.has(m) ? m : 'terracotta';
      }
      if (ROOF_LIKE.has(m)) return m;
      // a marble or stone dome (Taj Mahal, Florence) keeps the stone the text asked for
      if (STONE_LIKE.has(m)) return m;
      return COVERING[spec.covering] || 'lead';
    case 'metal': return m === 'gold' || (ROOF_ELEMENTS.has(el) && el !== 'roof') ? 'gold' : el === 'roof' ? 'zinc' : 'bronze';
    case 'glass': return 'glass';
    case 'wood': return 'wood';
    default: // 'stone', 'accent' and anything unknown: the body of the element
      if (STONE_LIKE.has(m)) return m;
      // a bronze, wooden or gilded column is what was asked for; on roofs and domes the walls stay stone
      if (m && PBR[m] && !ROOF_ELEMENTS.has(el)) return m;
      return 'limestone';
  }
}

// ------------------------------------------------------------------------------------------------ rigid ornament rule

/** Small repeated ornament moves rigidly under a deformation (deform.js deformParts' rule, with the app's ratio): a part
 *  with >= 2 instances whose mesh box diagonal (times the instance scale) is below RIGID_RATIO of the element's diagonal.
 *  0.25, not the engine's 0.2: a 3 m balustrade's balusters measure 22 % and would otherwise bend on a curved run, while
 *  capital leaves (26-37 %), volutes (60 %) and dome seams (27 %) still follow the deformation. One definition for the
 *  worker's bake options, its preview geometry and the page's stand-in preview. */
export const RIGID_RATIO = 0.25;
export function isRigidPart({ instances, localDiag, scale = 1, elementDiag, enabled = true, empty = false, tag }) {
  if (!enabled || empty) return false;
  if (tag === true || tag === false) return tag;     // the generator's meta.rigid tag wins (deform.js does the same)
  return instances >= 2 && localDiag * scale < RIGID_RATIO * elementDiag;
}
/** Largest column norm of the linear part of a column-major 4x4 (the instance scale deformParts uses). */
export function frameScale(M) {
  return M ? Math.max(Math.hypot(M[0], M[1], M[2]), Math.hypot(M[4], M[5], M[6]), Math.hypot(M[8], M[9], M[10])) : 1;
}

// ------------------------------------------------------------------------------------------------ mesh extraction

/** Render mesh of one Part: positions, normals smooth across edges below 30° and split above (crisp arrises, smooth
 *  shafts), indices, instance transforms, and the weld map back to the kernel's vertices (for feature edges).
 *  The normals are computed here (creasedNormals) rather than with Manifold's calculateNormals: same rule, but the
 *  kernel call costs 0.4 s on a 29k-triangle tile mesh and 0.23 s on a fluted shaft (its flat-region search), this
 *  takes a few ms. opts.kernelNormals: true uses Manifold's (kept for comparison). */
export function partMesh(part, spec = {}, opts = {}) {
  const src = part.manifold;
  let positions, normals, indices, mergeFrom = null, mergeTo = null;
  if (opts.kernelNormals) {
    let m = src, own = false;
    try { m = src.calculateNormals(0, 30); own = true; } catch (e) { m = src; }
    const g = m.getMesh(), np = g.numProp, V = g.vertProperties, nv = V.length / np;
    positions = new Float32Array(nv * 3);
    normals = np >= 6 ? new Float32Array(nv * 3) : null;
    for (let i = 0; i < nv; i++) {
      const s = i * np, d = i * 3;
      positions[d] = V[s]; positions[d + 1] = V[s + 1]; positions[d + 2] = V[s + 2];
      if (normals) { normals[d] = V[s + 3]; normals[d + 1] = V[s + 4]; normals[d + 2] = V[s + 5]; }
    }
    indices = Uint32Array.from(g.triVerts);
    if (!normals) normals = vertexNormals(positions, indices);
    mergeFrom = g.mergeFromVert ? Uint32Array.from(g.mergeFromVert) : null;
    mergeTo = g.mergeToVert ? Uint32Array.from(g.mergeToVert) : null;
    if (own && m !== src && typeof m.delete === 'function') m.delete();
  } else {
    const g = src.getMesh(), np = g.numProp, V = g.vertProperties, nv = V.length / np;
    // weld vertices the kernel keeps apart for properties (none for our parts, but the merge vectors say so)
    const P = new Float64Array(nv * 3);
    for (let i = 0; i < nv; i++) { P[3 * i] = V[i * np]; P[3 * i + 1] = V[i * np + 1]; P[3 * i + 2] = V[i * np + 2]; }
    const T = Uint32Array.from(g.triVerts);
    if (g.mergeFromVert && g.mergeFromVert.length) {
      const to = new Uint32Array(nv);
      for (let i = 0; i < nv; i++) to[i] = i;
      for (let k = 0; k < g.mergeFromVert.length; k++) to[g.mergeFromVert[k]] = g.mergeToVert[k];
      for (let k = 0; k < T.length; k++) T[k] = to[T[k]];
    }
    ({ positions, normals, indices, mergeFrom, mergeTo } = creasedNormals(P, T, 30));
  }
  return {
    name: part.name, role: part.role, material: materialFor(part.role, spec, part.meta),
    rigidTag: part.meta && (part.meta.rigid === true || part.meta.rigid === false) ? part.meta.rigid : undefined,
    positions, normals, indices,
    transforms: part.transforms ? Float64Array.from(part.transforms) : null,
    mergeFrom, mergeTo,
  };
}

/**
 * Normals of a closed triangle mesh with sharp edges kept (Manifold's calculateNormals rule): around each vertex the
 * fan of faces is split into smooth groups at the edges whose dihedral angle exceeds `deg`; each group gets one normal,
 * the angle-weighted mean of its faces' normals (planar regions stay exactly flat, a fluted shaft's arrises stay
 * crisp, an acanthus leaf shades smoothly). P: welded positions (xyz), T: triangles. Returns render arrays (one output
 * vertex per group) and the weld map (mergeFrom -> mergeTo) from split vertices back to the first copy.
 */
export function creasedNormals(P, T, deg = 30) {
  // Math.sqrt rather than Math.hypot (4 per triangle; hypot is several times slower in V8, so normals may differ from
  // the hypot version in the last bits), a CSR edge pairing rather than a Map keyed by edge, typed outputs (audit O6)
  const nv = P.length / 3, nc = T.length, nt = nc / 3, cos = Math.cos((deg * Math.PI) / 180);
  const FN = new Float64Array(3 * nt), A = new Float64Array(nc);     // face normals, corner angles
  for (let t = 0; t < nt; t++) {
    const ia = 3 * T[3 * t], ib = 3 * T[3 * t + 1], ic = 3 * T[3 * t + 2];
    const ux = P[ib] - P[ia], uy = P[ib + 1] - P[ia + 1], uz = P[ib + 2] - P[ia + 2];
    const vx = P[ic] - P[ia], vy = P[ic + 1] - P[ia + 1], vz = P[ic + 2] - P[ia + 2];
    const wx = P[ic] - P[ib], wy = P[ic + 1] - P[ib + 1], wz = P[ic + 2] - P[ib + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 0) { nx /= l; ny /= l; nz /= l; }
    FN[3 * t] = nx; FN[3 * t + 1] = ny; FN[3 * t + 2] = nz;
    const lu = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1, lv = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    const lw = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
    let d0 = (ux * vx + uy * vy + uz * vz) / (lu * lv), d1 = (-ux * wx - uy * wy - uz * wz) / (lu * lw);
    d0 = d0 < -1 ? -1 : d0 > 1 ? 1 : d0; d1 = d1 < -1 ? -1 : d1 > 1 ? 1 : d1;
    const a0 = Math.acos(d0), a1 = Math.acos(d1), a2 = Math.PI - a0 - a1;
    A[3 * t] = a0; A[3 * t + 1] = a1; A[3 * t + 2] = a2 > 0 ? a2 : 0;
  }
  // union-find over corners (corner k = 3 t + j): corners of one vertex join across smooth edges
  const parent = new Uint32Array(nc);
  for (let k = 0; k < nc; k++) parent[k] = k;
  const find = (k) => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; } };
  // half-edges bucketed by their smaller vertex (CSR, in corner order): the two faces of an edge pair up in order of
  // appearance, as a Map keyed by the edge would pair them (a non-manifold edge's 1st with 2nd, 3rd with 4th)
  const next = (k) => k - (k % 3) + ((k % 3) + 1) % 3;
  const cnt = new Uint32Array(nv + 1);
  for (let k = 0; k < nc; k++) { const a = T[k], b = T[next(k)]; if (a !== b) cnt[(a < b ? a : b) + 1]++; }
  for (let i = 0; i < nv; i++) cnt[i + 1] += cnt[i];
  const fill = cnt.slice(0, nv), he = new Uint32Array(cnt[nv]);
  for (let k = 0; k < nc; k++) { const a = T[k], b = T[next(k)]; if (a !== b) he[fill[a < b ? a : b]++] = k; }
  const used = new Uint8Array(cnt[nv]);
  for (let v = 0; v < nv; v++) {
    const e = cnt[v + 1];
    for (let x = cnt[v]; x < e; x++) {
      if (used[x]) continue;
      const k = he[x], kb = next(k), t = (k / 3) | 0, hi = T[k] < T[kb] ? T[kb] : T[k];
      for (let y = x + 1; y < e; y++) {
        if (used[y]) continue;
        const k2 = he[y], kb2 = next(k2), t2 = (k2 / 3) | 0, hi2 = T[k2] < T[kb2] ? T[kb2] : T[k2];
        if (hi2 !== hi) continue;
        used[x] = used[y] = 1;
        const d = FN[3 * t] * FN[3 * t2] + FN[3 * t + 1] * FN[3 * t2 + 1] + FN[3 * t + 2] * FN[3 * t2 + 2];
        if (d >= cos) { // a smooth edge: join the corners at the smaller and at the larger vertex of the two faces
          const ma = T[k] < T[kb] ? k : kb, mb = T[k] < T[kb] ? kb : k, oa = T[k2] < T[kb2] ? k2 : kb2, ob = T[k2] < T[kb2] ? kb2 : k2;
          join(oa, ma); join(ob, mb);
        }  // else a sharp edge (or a degenerate face): the groups stay apart
        break;
      }
    }
  }
  // one output vertex per group; the vertex's whole fan (angle-weighted) is the fallback for a group with no direction
  // (zero-area slivers alone)
  const sum = new Float64Array(3 * nc), vsum = new Float64Array(3 * nv);
  for (let k = 0; k < nc; k++) {
    const r = find(k), t = (k / 3) | 0, w = A[k], v = T[k];
    sum[3 * r] += w * FN[3 * t]; sum[3 * r + 1] += w * FN[3 * t + 1]; sum[3 * r + 2] += w * FN[3 * t + 2];
    vsum[3 * v] += w * FN[3 * t]; vsum[3 * v + 1] += w * FN[3 * t + 1]; vsum[3 * v + 2] += w * FN[3 * t + 2];
  }
  const outIndex = new Int32Array(nc).fill(-1), first = new Int32Array(nv).fill(-1);
  const outP = new Float32Array(3 * nc), outN = new Float32Array(3 * nc), outI = new Uint32Array(nc);
  const mF = new Uint32Array(nc), mT = new Uint32Array(nc);
  let count = 0, nm = 0;
  for (let k = 0; k < nc; k++) {
    const r = find(k);
    if (outIndex[r] < 0) {
      const v = T[k];
      let nx = sum[3 * r], ny = sum[3 * r + 1], nz = sum[3 * r + 2];
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (l > 1e-12) { nx /= l; ny /= l; nz /= l; }
      else {
        nx = vsum[3 * v]; ny = vsum[3 * v + 1]; nz = vsum[3 * v + 2];
        const lv = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (lv > 1e-12) { nx /= lv; ny /= lv; nz /= lv; } else { nx = 0; ny = 0; nz = 1; }
      }
      const o = count++;
      outIndex[r] = o;
      outP[3 * o] = P[3 * v]; outP[3 * o + 1] = P[3 * v + 1]; outP[3 * o + 2] = P[3 * v + 2];
      outN[3 * o] = nx; outN[3 * o + 1] = ny; outN[3 * o + 2] = nz;
      if (first[v] < 0) first[v] = o; else { mF[nm] = o; mT[nm] = first[v]; nm++; }
    }
    outI[k] = outIndex[r];
  }
  return { positions: outP.slice(0, 3 * count), normals: outN.slice(0, 3 * count), indices: outI,
    mergeFrom: mF.slice(0, nm), mergeTo: mT.slice(0, nm) };
}

/** Area-weighted vertex normals (fallback when the kernel gave none). */
export function vertexNormals(P, T) {
  const N = new Float32Array(P.length);
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { N[k] += nx; N[k + 1] += ny; N[k + 2] += nz; }
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
    N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
  }
  return N;
}

/** Feature edges (dihedral angle > deg) of a mesh, in its local space: Float32Array of segment end points.
 *  Vertices that the kernel split for normals are welded back through mergeFrom/mergeTo (exact, no hashing). */
export function featureEdges(mesh, deg = 30) {
  const P = mesh.positions, T = mesh.indices, nv = P.length / 3;
  const id = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) id[i] = i;
  if (mesh.mergeFrom && mesh.mergeTo) for (let k = 0; k < mesh.mergeFrom.length; k++) id[mesh.mergeFrom[k]] = mesh.mergeTo[k];
  else { // weld by quantised position
    const seen = new Map();
    for (let i = 0; i < nv; i++) {
      const key = `${Math.round(P[i * 3] * 1e5)},${Math.round(P[i * 3 + 1] * 1e5)},${Math.round(P[i * 3 + 2] * 1e5)}`;
      const j = seen.get(key);
      if (j === undefined) seen.set(key, i); else id[i] = j;
    }
  }
  const nt = T.length / 3, FN = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = id[T[t * 3]] * 3, b = id[T[t * 3 + 1]] * 3, c = id[T[t * 3 + 2]] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    FN[t * 3] = nx / l; FN[t * 3 + 1] = ny / l; FN[t * 3 + 2] = nz / l;
  }
  const cos = Math.cos((deg * Math.PI) / 180), first = new Map(), seg = [];
  for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) {
    const a = id[T[t * 3 + e]], b = id[T[t * 3 + ((e + 1) % 3)]];
    if (a === b) continue;
    const key = a < b ? a * nv + b : b * nv + a;
    const o = first.get(key);
    if (o === undefined) { first.set(key, t); continue; }
    first.delete(key);
    const d = FN[o * 3] * FN[t * 3] + FN[o * 3 + 1] * FN[t * 3 + 1] + FN[o * 3 + 2] * FN[t * 3 + 2];
    if (d < cos) seg.push(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
  }
  return Float32Array.from(seg);
}

// ------------------------------------------------------------------------------------------------ small linear algebra

const IDENTITY = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
// Z-up -> Y-up: (x, y, z) -> (x, z, -y), as a column-major 4x4, and its inverse (the transpose)
const C = Float64Array.from([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
const CI = Float64Array.from([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);

function mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
const det3 = (m) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
/** Inverse-transpose of the upper 3x3 (for normals), as 9 numbers in column-major order. */
function normalMatrix(m) {
  // rows of the 3x3: [a d g; b e h; c f i] (m is column-major)
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const c00 = e * i - h * f, c01 = -(b * i - h * c), c02 = b * f - e * c;
  const c10 = -(d * i - g * f), c11 = a * i - g * c, c12 = -(a * f - d * c);
  const c20 = d * h - g * e, c21 = -(a * h - g * b), c22 = a * e - d * b;
  const det = a * c00 + d * c01 + g * c02 || 1;
  // inverse-transpose = cofactor matrix / det, returned column-major
  return [c00 / det, c10 / det, c20 / det, c01 / det, c11 / det, c21 / det, c02 / det, c12 / det, c22 / det];
}
const isIdentity = (m) => m.every((x, k) => Math.abs(x - IDENTITY[k]) < 1e-12);
const isTranslation = (m) => m.every((x, k) => k >= 12 || Math.abs(x - IDENTITY[k]) < 1e-12);
/** A glTF node matrix must decompose into T·R·S: the upper 3x3 columns must be mutually orthogonal (no shear). */
function isTRS(m) {
  const col = (j) => [m[j * 4], m[j * 4 + 1], m[j * 4 + 2]];
  const [x, y, z] = [col(0), col(1), col(2)];
  const d = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const l = (u) => Math.sqrt(d(u, u)) || 1;
  return Math.abs(d(x, y)) / (l(x) * l(y)) < 1e-6 && Math.abs(d(x, z)) / (l(x) * l(z)) < 1e-6 && Math.abs(d(y, z)) / (l(y) * l(z)) < 1e-6
    && Math.abs(m[3]) < 1e-12 && Math.abs(m[7]) < 1e-12 && Math.abs(m[11]) < 1e-12 && Math.abs(m[15] - 1) < 1e-12;
}

function instanceList(mesh) {
  const t = mesh.transforms;
  if (!t || !t.length) return [IDENTITY];
  const out = [];
  for (let i = 0; i < t.length / 16; i++) out.push(Float64Array.from(t.subarray(16 * i, 16 * i + 16)));
  return out;
}

/** Positions and normals of a mesh after the 4x4 m (normals renormalised); flip = winding must be reversed. */
function transformed(mesh, m) {
  const P = mesh.positions, N = mesh.normals, n = P.length / 3;
  const p = new Float32Array(P.length), q = N ? new Float32Array(N.length) : null, nm = normalMatrix(m);
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    p[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
    p[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    p[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (q) {
      const a = N[i * 3], b = N[i * 3 + 1], c = N[i * 3 + 2];
      let u = nm[0] * a + nm[3] * b + nm[6] * c, v = nm[1] * a + nm[4] * b + nm[7] * c, w = nm[2] * a + nm[5] * b + nm[8] * c;
      const l = Math.hypot(u, v, w) || 1;
      q[i * 3] = u / l; q[i * 3 + 1] = v / l; q[i * 3 + 2] = w / l;
    }
  }
  return { p, q, flip: det3(m) < 0 };
}

// ------------------------------------------------------------------------------------------------ GLB

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function hexLinear(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => +srgbToLinear(v / 255).toFixed(5));
}

/** glTF 2.0 binary. One glTF mesh per part (+ one per instance whose transform has shear, baked), one node per
 *  instance referencing it, one PBR material per material key. opts: { name, extras } (extras land on the scene). */
export function toGLB(meshes, opts = {}) {
  const json = {
    asset: { version: '2.0', generator: 'Arch Studio (procedural, Manifold CAD kernel)' },
    scene: 0, scenes: [{ name: opts.name || 'element', nodes: [] }],
    nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }],
  };
  if (opts.extras) json.scenes[0].extras = opts.extras;
  const chunks = [];
  let offset = 0;
  const view = (arr, target) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
    chunks.push(bytes);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    offset += bytes.byteLength;
    return json.bufferViews.length - 1;
  };
  const vec3Accessor = (arr) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < arr.length; i += 3) for (let a = 0; a < 3; a++) {
      const v = arr[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
    json.accessors.push({ bufferView: view(arr, 34962), componentType: 5126, count: arr.length / 3, type: 'VEC3', min, max });
    return json.accessors.length - 1;
  };
  const matIndex = new Map();
  const material = (key, painted = false) => {
    const mk = painted ? key + '|painted' : key;
    if (matIndex.has(mk)) return matIndex.get(mk);
    const p = PBR[key] || PBR.limestone;
    // a painted part carries its colour in COLOR_0 (the material colour mixed with the paint): its factor is white
    json.materials.push({ name: painted ? key + '-painted' : key, pbrMetallicRoughness: { baseColorFactor: painted ? [1, 1, 1, 1] : [...hexLinear(p.color), 1],
      metallicFactor: p.metalness, roughnessFactor: p.roughness } });
    matIndex.set(mk, json.materials.length - 1);
    return json.materials.length - 1;
  };
  // one glTF mesh from Y-up arrays
  const addMesh = (name, P, N, T, mat, col = null) => {
    const nv = P.length / 3;
    const idx = nv <= 65535 ? Uint16Array.from(T) : (T instanceof Uint32Array ? T : Uint32Array.from(T));
    const attributes = { POSITION: vec3Accessor(P) };
    if (N) attributes.NORMAL = vec3Accessor(N);
    if (col) { json.accessors.push({ bufferView: view(col, 34962), componentType: 5126, count: col.length / 4, type: 'VEC4' }); attributes.COLOR_0 = json.accessors.length - 1; }
    json.accessors.push({ bufferView: view(idx, 34963), componentType: idx instanceof Uint16Array ? 5123 : 5125, count: idx.length,
      type: 'SCALAR' });
    json.meshes.push({ name, primitives: [{ attributes, indices: json.accessors.length - 1, material: material(mat, !!col), mode: 4 }] });
    return json.meshes.length - 1;
  };
  const flipWinding = (T) => { const o = Uint32Array.from(T); for (let t = 0; t < o.length; t += 3) { const x = o[t + 1]; o[t + 1] = o[t + 2]; o[t + 2] = x; } return o; };

  // paint (paint.js refinePainted): opts.paintMesh(meshIndex, copy (-1: every copy alike), base linear rgb) ->
  // { positions, normals, indices, colors } (the part split where the paint changes, linear RGBA per vertex) or null;
  // opts.expand(meshIndex): the copies differ (each gets its own mesh)
  meshes.forEach((mesh0, mi) => {
    const list = instanceList(mesh0), base = hexLinear((PBR[mesh0.material] || PBR.limestone).color);
    const expand = !!(opts.paintMesh && opts.expand && opts.expand(mi));
    const sharedPM = opts.paintMesh && !expand ? opts.paintMesh(mi, -1, base) : null;
    let shared = -1;
    list.forEach((m, i) => {
      const pm = expand ? opts.paintMesh(mi, i, base) : sharedPM, col = pm ? pm.colors : null;
      const mesh = pm ? { ...mesh0, positions: pm.positions, normals: pm.normals, indices: pm.indices } : mesh0;
      const nodeName = list.length > 1 ? `${mesh.name}_${i + 1}` : mesh.name;
      const my = mul(mul(C, m), CI); // the instance transform in Y-up space
      const node = { name: nodeName };
      if (isTRS(my)) {
        if (expand && col) {
          const y = transformed(mesh, C);
          node.mesh = addMesh(nodeName, y.p, y.q, mesh.indices, mesh.material, col);
        } else {
          if (shared < 0) {
            const y = transformed(mesh, C);
            shared = addMesh(mesh.name, y.p, y.q, mesh.indices, mesh.material, col);
          }
          node.mesh = shared;
        }
        if (isTranslation(my)) {
          if (!isIdentity(my)) node.translation = [my[12], my[13], my[14]];
        } else node.matrix = Array.from(my);
      } else { // shear: bake this instance into its own mesh
        const y = transformed(mesh, mul(C, m));
        node.mesh = addMesh(nodeName, y.p, y.q, y.flip ? flipWinding(mesh.indices) : mesh.indices, mesh.material, col);
      }
      json.nodes.push(node);
      json.scenes[0].nodes.push(json.nodes.length - 1);
    });
  });
  const pad = (4 - (offset % 4)) % 4;
  if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
  json.buffers[0].byteLength = offset;

  const enc = new TextEncoder();
  let jsonBytes = enc.encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) { const j = new Uint8Array(jsonBytes.length + jpad); j.set(jsonBytes); j.fill(0x20, jsonBytes.length); jsonBytes = j; }
  const total = 12 + 8 + jsonBytes.length + 8 + offset;
  const out = new ArrayBuffer(total), dv = new DataView(out), u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true); dv.setUint32(16, 0x4e4f534a, true); u8.set(jsonBytes, 20);
  let o = 20 + jsonBytes.length;
  dv.setUint32(o, offset, true); dv.setUint32(o + 4, 0x004e4942, true); o += 8;
  for (const c of chunks) { u8.set(c, o); o += c.byteLength; }
  return out;
}

// ------------------------------------------------------------------------------------------------ OBJ

const num = (x) => { const r = Math.round(x * 1e6) / 1e6; return r === 0 ? '0' : String(r); };
const nrm = (x) => { const r = Math.round(x * 1e4) / 1e4; return r === 0 ? '0' : String(r); };

/** Wavefront OBJ (Y-up, metres) as a list of text chunks (one per block of one instance), so a large model is never
 *  one giant string: the worker encodes the chunks one by one and the page makes a Blob of them. One object + group
 *  per part, every instance expanded, vertex normals, usemtl per material key (Blender and Rhino create materials by
 *  name). */
export function toOBJParts(meshes, opts = {}) {
  const out = [`# Arch Studio${opts.name ? ' - ' + opts.name : ''}\n# units: metres, Y up${opts.paintMesh ? '\n# painted parts carry vertex colours (v x y z r g b, sRGB)' : ''}\n\n`];
  let base = 1;
  const enc = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
  meshes.forEach((src0, mi) => {
    const bc = hexLinear((PBR[src0.material] || PBR.limestone).color);
    const expand = !!(opts.paintMesh && opts.expand && opts.expand(mi)), sharedPM = opts.paintMesh && !expand ? opts.paintMesh(mi, -1, bc) : null;
    out.push(`o ${safe(src0.name)}\ng ${safe(src0.name)}\nusemtl ${safe(src0.material || 'stone')}\n`);
    instanceList(src0).forEach((m, k) => {
      const pm = expand ? opts.paintMesh(mi, k, bc) : sharedPM, src = pm ? { ...src0, positions: pm.positions, normals: pm.normals, indices: pm.indices } : src0;
      // every vertex gets a normal, so v and vn indices stay equal across parts
      const mesh = src.normals ? src : { ...src, normals: vertexNormals(src.positions, src.indices) };
      // a part some of whose copies are painted: its unpainted copies carry the material colour (one format per object)
      let col = pm ? pm.colors : null;
      if (!col && expand) { col = new Float32Array((mesh.positions.length / 3) * 4); for (let i = 0; i < col.length; i += 4) { col[i] = bc[0]; col[i + 1] = bc[1]; col[i + 2] = bc[2]; col[i + 3] = 1; } }
      const y = transformed(mesh, mul(C, m)), n = y.p.length / 3, v = new Array(n), vn = new Array(n);
      for (let i = 0; i < n; i++) {
        v[i] = col ? `v ${num(y.p[i * 3])} ${num(y.p[i * 3 + 1])} ${num(y.p[i * 3 + 2])} ${enc(col[i * 4]).toFixed(4)} ${enc(col[i * 4 + 1]).toFixed(4)} ${enc(col[i * 4 + 2]).toFixed(4)}\n`
          : `v ${num(y.p[i * 3])} ${num(y.p[i * 3 + 1])} ${num(y.p[i * 3 + 2])}\n`;
        vn[i] = `vn ${nrm(y.q[i * 3])} ${nrm(y.q[i * 3 + 1])} ${nrm(y.q[i * 3 + 2])}\n`;
      }
      out.push(v.join(''), vn.join(''));
      const T = mesh.indices, f = new Array(T.length / 3);
      for (let t = 0; t < T.length; t += 3) {
        const a = T[t] + base, b = T[t + (y.flip ? 2 : 1)] + base, c = T[t + (y.flip ? 1 : 2)] + base;
        f[t / 3] = `f ${a}//${a} ${b}//${b} ${c}//${c}\n`;
      }
      out.push(f.join(''));
      base += n;
    });
  });
  return out;
}

/** The same OBJ as one string (small models, tests). */
export function toOBJ(meshes, opts = {}) { return toOBJParts(meshes, opts).join(''); }
const safe = (s) => String(s).replace(/\s+/g, '_');

// ------------------------------------------------------------------------------------------------ STL

/** Binary STL of every part and instance, Z-up, millimetres; facet normals from the (transformed) triangles. */
export function toSTL(meshes, opts = {}) {
  let n = 0;
  for (const mesh of meshes) n += (mesh.indices.length / 3) * instanceList(mesh).length;
  const buf = new ArrayBuffer(84 + 50 * n), dv = new DataView(buf);
  const head = `Arch Studio${opts.name ? ' ' + opts.name : ''} - binary STL, Z up, millimetres`.slice(0, 80);
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i) & 0x7f);
  dv.setUint32(80, n, true);
  let o = 84;
  const S = 1000;
  for (const mesh of meshes) for (const m of instanceList(mesh)) {
    const y = transformed({ positions: mesh.positions, normals: null }, m), P = y.p, T = mesh.indices;
    for (let t = 0; t < T.length; t += 3) {
      const a = T[t] * 3, b = T[t + (y.flip ? 2 : 1)] * 3, c = T[t + (y.flip ? 1 : 2)] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
      for (const [k, v] of [[12, a], [24, b], [36, c]]) {
        dv.setFloat32(o + k, P[v] * S, true); dv.setFloat32(o + k + 4, P[v + 1] * S, true); dv.setFloat32(o + k + 8, P[v + 2] * S, true);
      }
      dv.setUint16(o + 48, 0, true);
      o += 50;
    }
  }
  return buf;
}
