// Offline preview renderer (Node): parts -> PNG. Not the product renderer (that is three.js in view.js); it exists so
// generators can be checked visually without a browser, and for dataset thumbnails.
//   import { renderPNG } from './raster.mjs';  fs.writeFileSync('x.png', renderPNG(parts, { size: 640, view: 'three-quarter' }))
// Views: 'three-quarter' (front-left, above), 'front' (elevation), 'side', 'top', 'close' (three-quarter on the top 30 %).
import zlib from 'node:zlib';
import { instanceCount } from '../js/kernel.js';

const VIEWS = {
  'three-quarter': { az: -35, el: 18 }, front: { az: 0, el: 0 }, side: { az: -90, el: 0 }, top: { az: 0, el: 89.9 },
  close: { az: -30, el: 12, zoomTop: 0.32 },
};

function meshes(parts) {
  const out = [];
  for (const p of parts) {
    let m = p.manifold;
    try { m = m.calculateNormals(0, 30); } catch (e) { /* flat normals below */ }
    const g = m.getMesh();
    const np = g.numProp, V = g.vertProperties, T = g.triVerts;
    const n = instanceCount(p);
    for (let i = 0; i < n; i++) out.push({ np, V, T, M: p.transforms ? p.transforms.subarray(16 * i, 16 * i + 16) : null, role: p.role });
  }
  return out;
}

const ROLE_TINT = { stone: [0.93, 0.91, 0.87], accent: [0.95, 0.85, 0.55], roof: [0.62, 0.66, 0.70], metal: [0.80, 0.70, 0.45],
  glass: [0.35, 0.42, 0.48], wood: [0.70, 0.52, 0.35] };

export function renderPNG(parts, opts = {}) {
  const size = opts.size || 640, ss = 2, W = size * ss, H = size * ss;
  const v = VIEWS[opts.view || 'three-quarter'] || VIEWS['three-quarter'];
  const az = (v.az * Math.PI) / 180, el = (v.el * Math.PI) / 180;
  // camera basis: looking from direction d toward origin; Z-up world
  const d = [Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)];
  const right = norm(cross([0, 0, 1], d));
  const up = cross(d, right);
  const ms = meshes(parts);
  // transform all vertices to camera space (x right, y up, z toward camera)
  const tris = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (const m of ms) {
    const nv = m.V.length / m.np, P = new Float64Array(nv * 3), N = new Float64Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      let p = [m.V[i * m.np], m.V[i * m.np + 1], m.V[i * m.np + 2]];
      let q = m.np >= 6 ? [m.V[i * m.np + 3], m.V[i * m.np + 4], m.V[i * m.np + 5]] : null;
      if (m.M) { p = app(m.M, p); if (q) q = appDir(m.M, q); }
      P[i * 3] = dot(p, right); P[i * 3 + 1] = dot(p, up); P[i * 3 + 2] = dot(p, d);
      if (q) { q = norm(q); N[i * 3] = dot(q, right); N[i * 3 + 1] = dot(q, up); N[i * 3 + 2] = dot(q, d); }
      zMin = Math.min(zMin, p[2]); zMax = Math.max(zMax, p[2]);
    }
    for (let t = 0; t < m.T.length; t += 3) tris.push([P, N, m.T[t], m.T[t + 1], m.T[t + 2], m.np >= 6, m.role]);
    for (let i = 0; i < nv; i++) {
      minX = Math.min(minX, P[i * 3]); maxX = Math.max(maxX, P[i * 3]);
      minY = Math.min(minY, P[i * 3 + 1]); maxY = Math.max(maxY, P[i * 3 + 1]);
    }
  }
  if (v.zoomTop) { const h = maxY - minY; minY = maxY - h * v.zoomTop; }
  const span = Math.max(maxX - minX, maxY - minY) * 1.08 || 1;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const sx = (x) => ((x - cx) / span + 0.5) * W, sy = (y) => (0.5 - (y - cy) / span) * H;
  const depth = new Float64Array(W * H).fill(-Infinity), nrm = new Float32Array(W * H * 3), tint = new Uint8Array(W * H);
  const roles = Object.keys(ROLE_TINT);
  for (const [P, N, a, b, c, smooth, role] of tris) {
    const x0 = sx(P[a * 3]), y0 = sy(P[a * 3 + 1]), x1 = sx(P[b * 3]), y1 = sy(P[b * 3 + 1]), x2 = sx(P[c * 3]), y2 = sy(P[c * 3 + 1]);
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area >= 0) continue; // back-facing (screen y is flipped)
    let fn = null;
    if (!smooth) {
      const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
      const e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
      fn = norm(cross(e1, e2));
    }
    const bx0 = Math.max(0, Math.floor(Math.min(x0, x1, x2))), bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const by0 = Math.max(0, Math.floor(Math.min(y0, y1, y2))), by1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
    const ri = Math.max(0, roles.indexOf(role));
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
      const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * P[a * 3 + 2] + w1 * P[b * 3 + 2] + w2 * P[c * 3 + 2];
      const k = y * W + x;
      if (z <= depth[k]) continue;
      depth[k] = z;
      let n = fn;
      if (!n) n = norm([w0 * N[a * 3] + w1 * N[b * 3] + w2 * N[c * 3], w0 * N[a * 3 + 1] + w1 * N[b * 3 + 1] + w2 * N[c * 3 + 1],
        w0 * N[a * 3 + 2] + w1 * N[b * 3 + 2] + w2 * N[c * 3 + 2]]);
      nrm[k * 3] = n[0]; nrm[k * 3 + 1] = n[1]; nrm[k * 3 + 2] = n[2]; tint[k] = ri;
    }
  }
  // shading + depth-based ambient occlusion + feature lines
  const L1 = norm([-0.5, 0.55, 0.65]), L2 = norm([0.6, 0.2, 0.4]);
  const img = new Uint8Array(W * H * 3);
  const scale = W / span, R = Math.max(2, Math.round(W / 90));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x;
    if (depth[k] === -Infinity) { img.set([255, 255, 255], k * 3); continue; }
    const n = [nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]];
    // occlusion and edges measured against the pixel's tangent plane, so grazing surfaces are not darkened
    const nz = Math.max(0.08, n[2]), gx = -n[0] / nz, gy = n[1] / nz; // depth change per pixel along screen x, y
    let occ = 0, cnt = 0;
    for (let s = 0; s < 8; s++) {
      const ang = (s / 8) * Math.PI * 2, ox = Math.round(Math.cos(ang) * R), oy = Math.round(Math.sin(ang) * R);
      const xx = x + ox, yy = y + oy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const dn = depth[yy * W + xx];
      if (!Number.isFinite(dn)) { cnt++; continue; }
      const dz = (dn - depth[k]) * scale - (gx * ox + gy * oy);
      occ += Math.max(0, Math.min(1, dz / R)); cnt++;
    }
    const ao = 1 - 0.6 * (cnt ? occ / cnt : 0);
    const diff = 0.72 * Math.max(0, dot(n, L1)) + 0.22 * Math.max(0, dot(n, L2)) + 0.30 + 0.12 * n[1];
    const t = ROLE_TINT[roles[tint[k]]];
    let edge = 0;
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const kk = (y + dy) * W + (x + dx);
      if (x + dx >= W || y + dy >= H) continue;
      if (depth[kk] === -Infinity) { edge = 1; continue; }
      const jump = Math.abs((depth[kk] - depth[k]) * scale - (gx * dx + gy * dy));
      const nd = nrm[kk * 3] * n[0] + nrm[kk * 3 + 1] * n[1] + nrm[kk * 3 + 2] * n[2];
      if (jump > 2.5) edge = 1;
      else if (nd < 0.8) edge = Math.max(edge, 0.55);
    }
    const shade = Math.min(1.08, diff) * ao * (1 - 0.6 * edge);
    img.set(t.map((c) => Math.max(0, Math.min(255, Math.round(255 * c * shade)))), k * 3);
  }
  // 2x2 box downsample
  const out = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let ch = 0; ch < 3; ch++) {
    let s = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) s += img[((y * ss + j) * W + (x * ss + i)) * 3 + ch];
    out[(y * size + x) * 3 + ch] = Math.round(s / (ss * ss));
  }
  return png(out, size, size);
}

/** Several renders side by side in one PNG (e.g. views of one element, or many elements). */
export function sheet(pngs, cols) {
  const imgs = pngs.map(unpng), w = imgs[0].w, h = imgs[0].h, rows = Math.ceil(imgs.length / cols);
  const out = new Uint8Array(w * cols * h * rows * 3).fill(255);
  imgs.forEach((im, i) => {
    const ox = (i % cols) * w, oy = Math.floor(i / cols) * h;
    for (let y = 0; y < h; y++) out.set(im.px.subarray(y * w * 3, (y + 1) * w * 3), ((oy + y) * w * cols + ox) * 3);
  });
  return png(out, w * cols, h * rows);
}

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function app(m, p) { return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]; }
function appDir(m, p) { return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]]; }

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
function unpng(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  let p = 8; const idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8); if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len)); p += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) px.set(raw.subarray(y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1)), y * w * 3);
  return { w, h, px };
}
