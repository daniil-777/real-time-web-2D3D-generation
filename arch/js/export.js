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

// ------------------------------------------------------------------------------------------------ mesh extraction

/** Render mesh of one Part (duck-typed Manifold: calculateNormals / getMesh / delete). Normals are smooth across
 *  edges below 30° and split above (crisp arrises, smooth shafts). Keeps the merge vectors for feature edges. */
export function partMesh(part, spec = {}) {
  const src = part.manifold;
  let m = src, own = false;
  try { m = src.calculateNormals(0, 30); own = true; } catch (e) { m = src; }
  const g = m.getMesh();
  const np = g.numProp, V = g.vertProperties, nv = V.length / np;
  const positions = new Float32Array(nv * 3);
  let normals = np >= 6 ? new Float32Array(nv * 3) : null;
  for (let i = 0; i < nv; i++) {
    const s = i * np, d = i * 3;
    positions[d] = V[s]; positions[d + 1] = V[s + 1]; positions[d + 2] = V[s + 2];
    if (normals) { normals[d] = V[s + 3]; normals[d + 1] = V[s + 4]; normals[d + 2] = V[s + 5]; }
  }
  const indices = Uint32Array.from(g.triVerts);
  if (!normals) normals = vertexNormals(positions, indices);
  const out = {
    name: part.name, role: part.role, material: materialFor(part.role, spec, part.meta),
    positions, normals, indices,
    transforms: part.transforms ? Float64Array.from(part.transforms) : null,
    mergeFrom: g.mergeFromVert ? Uint32Array.from(g.mergeFromVert) : null,
    mergeTo: g.mergeToVert ? Uint32Array.from(g.mergeToVert) : null,
  };
  if (own && m !== src && typeof m.delete === 'function') m.delete();
  return out;
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
  const material = (key) => {
    if (matIndex.has(key)) return matIndex.get(key);
    const p = PBR[key] || PBR.limestone;
    json.materials.push({ name: key, pbrMetallicRoughness: { baseColorFactor: [...hexLinear(p.color), 1], metallicFactor: p.metalness,
      roughnessFactor: p.roughness } });
    matIndex.set(key, json.materials.length - 1);
    return json.materials.length - 1;
  };
  // one glTF mesh from Y-up arrays
  const addMesh = (name, P, N, T, mat) => {
    const nv = P.length / 3;
    const idx = nv <= 65535 ? Uint16Array.from(T) : (T instanceof Uint32Array ? T : Uint32Array.from(T));
    const attributes = { POSITION: vec3Accessor(P) };
    if (N) attributes.NORMAL = vec3Accessor(N);
    json.accessors.push({ bufferView: view(idx, 34963), componentType: idx instanceof Uint16Array ? 5123 : 5125, count: idx.length,
      type: 'SCALAR' });
    json.meshes.push({ name, primitives: [{ attributes, indices: json.accessors.length - 1, material: material(mat), mode: 4 }] });
    return json.meshes.length - 1;
  };
  const flipWinding = (T) => { const o = Uint32Array.from(T); for (let t = 0; t < o.length; t += 3) { const x = o[t + 1]; o[t + 1] = o[t + 2]; o[t + 2] = x; } return o; };

  for (const mesh of meshes) {
    const list = instanceList(mesh);
    let shared = -1;
    list.forEach((m, i) => {
      const nodeName = list.length > 1 ? `${mesh.name}_${i + 1}` : mesh.name;
      const my = mul(mul(C, m), CI); // the instance transform in Y-up space
      const node = { name: nodeName };
      if (isTRS(my)) {
        if (shared < 0) {
          const y = transformed(mesh, C);
          shared = addMesh(mesh.name, y.p, y.q, mesh.indices, mesh.material);
        }
        node.mesh = shared;
        if (isTranslation(my)) {
          if (!isIdentity(my)) node.translation = [my[12], my[13], my[14]];
        } else node.matrix = Array.from(my);
      } else { // shear: bake this instance into its own mesh
        const y = transformed(mesh, mul(C, m));
        node.mesh = addMesh(nodeName, y.p, y.q, y.flip ? flipWinding(mesh.indices) : mesh.indices, mesh.material);
      }
      json.nodes.push(node);
      json.scenes[0].nodes.push(json.nodes.length - 1);
    });
  }
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
  const out = [`# Arch Studio${opts.name ? ' - ' + opts.name : ''}\n# units: metres, Y up\n\n`];
  let base = 1;
  for (const src of meshes) {
    // every vertex gets a normal, so v and vn indices stay equal across parts
    const mesh = src.normals ? src : { ...src, normals: vertexNormals(src.positions, src.indices) };
    out.push(`o ${safe(mesh.name)}\ng ${safe(mesh.name)}\nusemtl ${safe(mesh.material || 'stone')}\n`);
    for (const m of instanceList(mesh)) {
      const y = transformed(mesh, mul(C, m)), n = y.p.length / 3, v = new Array(n), vn = new Array(n);
      for (let i = 0; i < n; i++) {
        v[i] = `v ${num(y.p[i * 3])} ${num(y.p[i * 3 + 1])} ${num(y.p[i * 3 + 2])}\n`;
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
    }
  }
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
