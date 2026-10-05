// Arch Studio paint: a 3D dab field in each part's own coordinates (see the brush spec, 2026-10-05).
// - A stroke is a list of dabs (soft spheres) on one part, in the part's coordinates before the instance transform, so
//   "all copies" paints every baluster at once; a dab may name one copy instead (copy >= 0).
// - Strokes are immutable objects in an append-only list: an undo snapshot is a copy of the list (cheap), and a
//   rebuild never rewrites them: each stroke keeps the part's box it was painted on, and the grid maps its dabs into
//   the part's present box (normalised coordinates) when the size changed.
// - build() packs the strokes into textures for the fragment shader (view.js PAINT_GLSL): dabs (3 float texels each),
//   per part a sparse hash grid (cell key -> [start, count] into an index list, open addressing, the same hash on the
//   CPU and the GPU) and a 3-texel header. A part's grid is cached until its strokes change; strokes added at the end
//   (a new stroke) only rebuild the parts they touch. Each cell keeps its newest CELL_CAP entries.
// - Compositing (shader and paintAt here, the same order): newest first with premultiplied transmittance (paint:
//   C += T s c, A += T s, T *= 1 - s; erase: T *= 1 - s), so a cap or an early stop at T < 1e-3 only ever drops the
//   oldest, hidden paint. Within a stroke the dabs build up with flow (union of coverage x flow) up to a per-dab
//   ceiling (coverage x pen pressure), times the stroke's opacity; a fill covers the whole part (or one copy).
// - The stroke in progress lives in uniforms (the newest 48 dabs) and a live hash grid with per-cell linked lists
//   (newest first, built incrementally): its cost does not grow with the session. It is merged on pointer-up.
// Pure: no three.js, no DOM (runs in the page, the worker and Node tests).

export const TEX_W = 1024;                  // texture width (texels) of every paint texture
export const LIVE_MAX = 48;                 // newest dabs of the stroke in progress held in uniforms
export const LIVE_CAP = 8192;               // dabs of one stroke in the live grid; past it the stroke is committed and goes on
export const CELL_CAP = 256;                // entries a cell may hold; more and the older strokes are flattened first
export const RECENT_STROKES = 32;           // exact (analytic) strokes kept on top of the flattened field at most...
export const KEEP_RECENT = 8;               // ...and how many stay exact when older ones are flattened
export const FILL_MAX = 64;                 // exact fills of a part (they are among the exact strokes: <= RECENT_STROKES)
export const RECENT_DABS = 20000;           // exact dabs at most (beyond: flatten)
export const BRICK = 8, BRICK_S = 9, BRICK_N = 729;   // a brick: 8^3 voxels, 9^3 samples (its own apron: trilinear inside one brick)
export const MAX_SAMPLES = 4096 * 1024;     // flattened samples in all (one 1024 x 4096 texture: iPad's MAX_TEXTURE_SIZE)
export const LIVE_CELL_CAP = 256;           // entries the shader walks in a live cell
export const PROBE_MAX = 32;                // hash probes (the build guarantees every key is found within them)
export const DAB_BUDGET = 1500000;          // dabs in the store; past it a new stroke is refused (with a notice)
export const KIND = { paint: 0, erase: 1, fill: 2 };
export const FINISHES = ['matte', 'gloss', 'gold'];
/** roughness, metalness of a finish */
export const FINISH_PBR = { matte: [0.82, 0], gloss: [0.16, 0], gold: [0.26, 1] };
/** Pen pressure -> size and opacity (a gentle curve: light pressure stays light). */
export const pressureCurve = (x) => Math.pow(Math.min(1, Math.max(0, x)), 1.5);
/** hardness and flow in one exact float: round(hard * 255) + 256 * round(flow * 255) */
export const packHF = (hard, flow) => Math.round(Math.min(1, Math.max(0, hard)) * 255) + 256 * Math.round(Math.min(1, Math.max(0.004, flow)) * 255);
/** The cell hash (the same bits as the shader's uint arithmetic). */
export const hash3 = (x, y, z) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;

// --------------------------------------------------------------------------------------------- colour

export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const n = parseInt(h, 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
export const rgbToHex = (c) => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
export const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const toSRGB = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
export function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
export function rgbToHsv([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, mx ? d / mx : 0, mx];
}

/** The architectural palette (sRGB hex; gold leaf selects the gold finish). */
export const PALETTE = [
  { name: 'Lime white', hex: '#efeadf' }, { name: 'Travertine', hex: '#d9c9a8' }, { name: 'Naples yellow', hex: '#f1cf72' },
  { name: 'Siena ochre', hex: '#c27a2c' }, { name: 'Pompeian red', hex: '#9b2d20' }, { name: 'Terracotta', hex: '#c1623f' },
  { name: 'Verdigris', hex: '#4c9a87' }, { name: 'Ultramarine', hex: '#24408e' }, { name: 'Ivory black', hex: '#232220' },
  { name: 'Gold leaf', hex: '#d4a548', finish: 'gold' },
];

// --------------------------------------------------------------------------------------------- geometry helpers

/** Axis-aligned box [minx, miny, minz, maxx, maxy, maxz] of a position array. */
export function boxOf(P) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) {
    const v = P[i + a];
    if (v < b[a]) b[a] = v;
    if (v > b[a + 3]) b[a + 3] = v;
  }
  return b;
}
const sameBox = (a, b) => { for (let i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false; return true; };

/** A map from a part's old box to its new one: point and radius (normalised coordinates per axis). */
export function remapper(from, to) {
  if (!from || !to || sameBox(from, to)) return null;
  const s = [], o = [];
  let rs = 0, rn = 0;
  for (let a = 0; a < 3; a++) {
    const e0 = from[a + 3] - from[a], e1 = to[a + 3] - to[a];
    if (e0 > 1e-9) { s[a] = e1 / e0; rs += s[a]; rn++; }
    else s[a] = 1;
    o[a] = e0 > 1e-9 ? to[a] - from[a] * s[a] : (to[a] + to[a + 3]) / 2 - (from[a] + from[a + 3]) / 2;
  }
  return { s, o, r: rn ? rs / rn : 1 };
}

// --------------------------------------------------------------------------------------------- the store

/** A stroke: { id, part, kind: 'paint'|'erase'|'fill', rgb (linear), cap (opacity), hard, flow, finish, box, dabs:
 *  Float32Array of [x, y, z, r, p (opacity ceiling: pen pressure, else 1), copy] } (a fill has one dab: its copy). */
export function makeStroke(o) {
  return Object.freeze({ id: o.id, part: o.part, kind: o.kind || 'paint', rgb: o.rgb || [1, 1, 1], cap: o.cap ?? 1, hard: o.hard ?? 0.6,
    flow: o.flow ?? 1, finish: o.finish || 'matte', box: o.box, dabs: o.dabs instanceof Float32Array ? o.dabs : Float32Array.from(o.dabs || []) });
}

// --------------------------------------------------------------------------------------------- hash tables

/** Open addressing over cells (x, y, z: 0..65535), 4 uints per slot laid out as the GPU reads them:
 *  [x | y << 16, z + 1 (0 = empty), a, b]. Grows at half load; every key is found within PROBE_MAX probes. */
export class CellTable {
  constructor(n = 64) { this.alloc(Math.max(64, 1 << Math.ceil(Math.log2(Math.max(2, n * 2))))); }
  alloc(size) { this.size = size; this.mask = size - 1; this.t = new Uint32Array(size * 4); this.used = 0; }
  /** the slot of a cell, inserting it (a, b = 0) when absent */
  slot(x, y, z) {
    const k0 = (x | (y << 16)) >>> 0, k1 = z + 1, t = this.t;
    let h = hash3(x, y, z) & this.mask;
    for (let i = 0; ; i++) {
      const o = h * 4;
      if (t[o + 1] === 0) {
        if (i >= PROBE_MAX || (this.used + 1) * 2 > this.size) { this.grow(); return this.slot(x, y, z); }
        t[o] = k0; t[o + 1] = k1; this.used++;
        return h;
      }
      if (t[o] === k0 && t[o + 1] === k1) return h;
      h = (h + 1) & this.mask;
    }
  }
  find(x, y, z) {
    const k0 = (x | (y << 16)) >>> 0, k1 = z + 1, t = this.t;
    let h = hash3(x, y, z) & this.mask;
    for (let i = 0; i < PROBE_MAX; i++) {
      const o = h * 4;
      if (t[o + 1] === 0) return -1;
      if (t[o] === k0 && t[o + 1] === k1) return h;
      h = (h + 1) & this.mask;
    }
    return -1;
  }
  grow() {
    const old = this.t, n = this.size;
    this.alloc(n * 2);
    for (let s = 0; s < n; s++) {
      const o = s * 4;
      if (!old[o + 1]) continue;
      const x = old[o] & 0xffff, y = old[o] >>> 16, z = old[o + 1] - 1, d = this.slot(x, y, z) * 4;
      this.t[d + 2] = old[o + 2]; this.t[d + 3] = old[o + 3];
    }
  }
}

/** The grid of one part: CSR lists (ascending dab index, the newest CELL_CAP kept) behind a CellTable.
 *  D: the packed dabs (12 floats each), list: ascending global dab indices. Counting runs on a dense array when the
 *  dabs' box has at most 4 M cells (always, in practice), else on the table itself. */
export function partGrid(D, list, cellScale = 1) {
  const n = list.length;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let rsum = 0;
  for (let i = 0; i < n; i++) {
    const o = list[i] * 12, r = D[o + 3];
    rsum += r;
    for (let a = 0; a < 3; a++) { const v = D[o + a]; if (v - r < lo[a]) lo[a] = v - r; if (v + r > hi[a]) hi[a] = v + r; }
  }
  const maxExt = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
  const cell = Math.max((rsum / n) * 1.6 * cellScale, maxExt / 60000, 1e-5), inv = 1 / cell;
  const nx = Math.floor((hi[0] - lo[0]) * inv) + 1, ny = Math.floor((hi[1] - lo[1]) * inv) + 1, nz = Math.floor((hi[2] - lo[2]) * inv) + 1;
  const N = nx * ny * nz, dense = N <= 4194304;
  const R = new Int32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const o = list[i] * 12, r = D[o + 3], j = i * 6;
    R[j] = Math.max(0, Math.floor((D[o] - r - lo[0]) * inv)); R[j + 1] = Math.min(nx - 1, Math.floor((D[o] + r - lo[0]) * inv));
    R[j + 2] = Math.max(0, Math.floor((D[o + 1] - r - lo[1]) * inv)); R[j + 3] = Math.min(ny - 1, Math.floor((D[o + 1] + r - lo[1]) * inv));
    R[j + 4] = Math.max(0, Math.floor((D[o + 2] - r - lo[2]) * inv)); R[j + 5] = Math.min(nz - 1, Math.floor((D[o + 2] + r - lo[2]) * inv));
  }
  let T, entries = 0, total = 0, maxCell = 0, items;
  if (dense) {
    const count = new Uint32Array(N);
    for (let i = 0; i < n; i++) {
      const j = i * 6;
      for (let z = R[j + 4]; z <= R[j + 5]; z++) for (let y = R[j + 2]; y <= R[j + 3]; y++) {
        const row = nx * (y + ny * z);
        for (let x = R[j]; x <= R[j + 1]; x++) count[x + row]++;
      }
    }
    // occupied cells into the table; dense start / skip per cell (count is reused as the fill cursor)
    let occ = 0;
    for (let c = 0; c < N; c++) if (count[c]) occ++;
    T = new CellTable(occ);
    const start = new Uint32Array(N), skip = new Uint32Array(N);
    for (let c = 0; c < N; c++) {
      const k = count[c];
      if (!k) continue;
      entries += k;
      if (k > maxCell) maxCell = k;
      const keep = Math.min(k, CELL_CAP), x = c % nx, y = Math.floor(c / nx) % ny, z = Math.floor(c / (nx * ny));
      const sl = T.slot(x, y, z) * 4;
      T.t[sl + 2] = total; T.t[sl + 3] = keep;
      start[c] = total; skip[c] = k - keep; count[c] = 0; total += keep;
    }
    items = new Uint32Array(total);
    for (let i = 0; i < n; i++) {
      const j = i * 6, k = list[i];
      for (let z = R[j + 4]; z <= R[j + 5]; z++) for (let y = R[j + 2]; y <= R[j + 3]; y++) {
        const row = nx * (y + ny * z);
        for (let x = R[j]; x <= R[j + 1]; x++) { const c = x + row, q = count[c]++; if (q >= skip[c]) items[start[c] + q - skip[c]] = k; }
      }
    }
  } else {
    T = new CellTable(n * 4);
    for (let i = 0; i < n; i++) {
      const j = i * 6;
      for (let z = R[j + 4]; z <= R[j + 5]; z++) for (let y = R[j + 2]; y <= R[j + 3]; y++) for (let x = R[j]; x <= R[j + 1]; x++) { const sl = T.slot(x, y, z); T.t[sl * 4 + 3]++; entries++; }
    }
    const t = T.t, skip = new Uint32Array(T.size), seen = new Uint32Array(T.size);
    for (let sl = 0; sl < T.size; sl++) {
      const o = sl * 4;
      if (!t[o + 1]) continue;
      const c = t[o + 3];
      if (c > maxCell) maxCell = c;
      const keep = Math.min(c, CELL_CAP);
      skip[sl] = c - keep; t[o + 2] = total; t[o + 3] = keep; total += keep;
    }
    items = new Uint32Array(total);
    for (let i = 0; i < n; i++) {
      const j = i * 6, k = list[i];
      for (let z = R[j + 4]; z <= R[j + 5]; z++) for (let y = R[j + 2]; y <= R[j + 3]; y++) for (let x = R[j]; x <= R[j + 1]; x++) {
        const sl = T.find(x, y, z), q = seen[sl]++;
        if (q >= skip[sl]) items[t[sl * 4 + 2] + q - skip[sl]] = k;
      }
    }
  }
  return { min: lo, cell, table: T, items, entries, kept: total, cells: T.used, maxCell };
}

/** The live stroke's grid: per-cell linked lists, newest first, built one dab at a time (no rebuild per frame).
 *  Slots: [key0, key1, head (1-based entry), 0]; entries: [dab, next (1-based)]. */
export class LiveGrid {
  constructor() { this.reset(1); }
  reset(cell, origin = [0, 0, 0]) {
    this.cell = cell; this.inv = 1 / cell; this.origin = origin; this.T = new CellTable(256);
    this.ent = new Uint32Array(8192 * 2); this.m = 0; this.n = 0;
    this.dab = new Float32Array(1024 * 8);   // 2 texels per dab: [x, y, z, r], [part + 1, copy, p, 0]
  }
  add(part1, p, r, pr, copy) {
    const d = this.n++;
    if (this.dab.length < this.n * 8) { const a = new Float32Array(this.dab.length * 2); a.set(this.dab); this.dab = a; }
    const o = d * 8, D = this.dab;
    D[o] = p[0]; D[o + 1] = p[1]; D[o + 2] = p[2]; D[o + 3] = r; D[o + 4] = part1; D[o + 5] = copy; D[o + 6] = pr; D[o + 7] = 0;
    const g = this.origin, inv = this.inv, cl = (v) => Math.min(65535, Math.max(0, v));
    const x0 = cl(Math.floor((p[0] - r - g[0]) * inv)), x1 = cl(Math.floor((p[0] + r - g[0]) * inv));
    const y0 = cl(Math.floor((p[1] - r - g[1]) * inv)), y1 = cl(Math.floor((p[1] + r - g[1]) * inv));
    const z0 = cl(Math.floor((p[2] - r - g[2]) * inv)), z1 = cl(Math.floor((p[2] + r - g[2]) * inv));
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (this.ent.length < (this.m + 1) * 2) { const a = new Uint32Array(this.ent.length * 2); a.set(this.ent); this.ent = a; }
      const sl = this.T.slot(x, y, z) * 4;
      this.ent[this.m * 2] = d; this.ent[this.m * 2 + 1] = this.T.t[sl + 2];
      this.T.t[sl + 2] = ++this.m;
    }
  }
}

// --------------------------------------------------------------------------------------------- the store

export class Paint {
  constructor() {
    this.strokes = [];
    this.element = null;
    this.parts = [];          // [{ name, box, n (instances) }] of the element on screen, in mesh order
    this.index = new Map();   // part name -> index
    this.nextId = 1;
    this.live = { n: 0, id: 0, a: new Float32Array(LIVE_MAX * 4), b: new Float32Array(LIVE_MAX * 4), c: [0, 0, 0, 0], d: [0, 0, 0, 0],
      grid: new LiveGrid(), pending: [], gridVersion: 0 };
    this.version = 0;
    this.cellScale = 1;
    this.states = [EMPTY_STATE];   // flattened fields (copy on write), newest last; undo finds the one that fits
    this.clearCache();
  }
  clearCache() { this.packed = null; }

  /** The element's parts after a build ({ name, positions, transforms }). Returns 'cleared' when another element
   *  replaced the painted one (the paint goes; the history keeps it). */
  setParts(meshes, element) {
    this.parts = partsOf(meshes);
    this.index = new Map(this.parts.map((p, i) => [p.name, i]));
    this.clearCache();
    let out = 'kept';
    if (this.element && element && element !== this.element && this.strokes.length) { this.strokes = []; this.states = [EMPTY_STATE]; out = 'cleared'; }
    this.element = element || this.element;
    this.version++;
    return out;
  }

  snapshot() { return { strokes: this.strokes.slice(), element: this.element }; }
  restore(s) {
    if (!s) return false;
    const same = s.strokes.length === this.strokes.length && s.strokes.every((x, i) => x === this.strokes[i]);
    this.strokes = s.strokes.slice(); this.element = s.element;
    this.version++;
    return !same;
  }
  add(...strokes) { for (const s of strokes) this.strokes.push(makeStroke(s)); this.version++; }
  remove(id) { this.strokes = this.strokes.filter((s) => s.id !== id); this.version++; }
  clear() { this.strokes = []; this.version++; }
  /** The flattened field that fits the stroke list: the newest state whose strokes are a prefix of it. */
  pickState() {
    const S = this.strokes;
    let best = EMPTY_STATE;
    for (const st of this.states) if (st.F <= S.length && st.F >= best.F && (st.F === 0 || S[st.F - 1] === st.last)) best = st;
    return best;
  }
  /** Flatten strokes [state.F, F) into a new field state (the old one stays for undo). */
  flatten(state, F) {
    if (F <= state.F) return state;
    const t0 = Date.now();
    const next = flattenStrokes(state, this.strokes, F, this.parts, this.index);
    this.states.push(next);
    if (this.states.length > 7) this.states.splice(1, this.states.length - 7);
    this.flattenMs = Date.now() - t0;
    return next;
  }
  get dabCount() { let n = 0; for (const s of this.strokes) n += s.dabs.length / 6; return n + this.live.n + this.live.grid.n; }

  // ---- the stroke in progress

  /** o: { id, kind, rgb, cap, hard, flow, finish }; cell: the live grid's cell (about the brush radius), origin: a
   *  point the stroke stays within 30 000 cells of (the element's box minimum). */
  beginLive(o, cell, origin) {
    const L = this.live;
    L.n = 0; L.id = o.id; L.o = o; L.pending = [];
    L.boxes = new Map(this.parts.map((p) => [p.name, p.box]));   // a rebuild landing mid-stroke must not move its dabs
    L.c = [o.rgb[0], o.rgb[1], o.rgb[2], o.cap];
    L.d = [packHF(o.hard, o.flow ?? 1), KIND[o.kind] * 4 + Math.max(0, FINISHES.indexOf(o.finish)), 0, o.id];
    L.grid.reset(Math.max(cell, 1e-4), [origin[0] - 30000 * cell, origin[1] - 30000 * cell, origin[2] - 30000 * cell]);
    L.gridVersion++;
  }
  /** Add a dab to the stroke in progress (p part-local, r radius, pr opacity ceiling, copy). Returns true when the
   *  uniforms filled up and moved into the live grid (the caller uploads the live textures). */
  pushLive(part, p, r, pr, copy) {
    const L = this.live, pi = this.index.get(part);
    if (pi === undefined) return false;
    const k = L.n * 4;
    L.a[k] = p[0]; L.a[k + 1] = p[1]; L.a[k + 2] = p[2]; L.a[k + 3] = r;
    L.b[k] = pr; L.b[k + 1] = copy; L.b[k + 2] = pi + 1; L.b[k + 3] = 0;
    L.pending.push(part, p[0], p[1], p[2], r, pr, copy);
    L.n++; L.d[2] = L.n;
    if (L.n >= LIVE_MAX) { this.spillLive(); return true; }
    return false;
  }
  /** The uniforms' dabs into the live grid. */
  spillLive() {
    const L = this.live;
    for (let i = 0; i < L.n; i++) L.grid.add(L.b[i * 4 + 2], [L.a[i * 4], L.a[i * 4 + 1], L.a[i * 4 + 2]], L.a[i * 4 + 3], L.b[i * 4], L.b[i * 4 + 1]);
    L.n = 0; L.d[2] = 0; L.gridVersion++;
  }
  get liveCount() { return this.live.n + this.live.grid.n; }
  /** The stroke in progress into the store (one stroke object per part); the live state is emptied. */
  commitLive() {
    const L = this.live;
    const by = new Map();
    for (let i = 0; i < L.pending.length; i += 7) {
      const part = L.pending[i];
      if (!by.has(part)) by.set(part, []);
      by.get(part).push(L.pending[i + 1], L.pending[i + 2], L.pending[i + 3], L.pending[i + 4], L.pending[i + 5], L.pending[i + 6]);
    }
    const out = [];
    for (const [part, dabs] of by) {
      const pi = this.index.get(part);
      if (pi !== undefined) out.push(makeStroke({ ...L.o, part, box: (L.boxes && L.boxes.get(part)) || this.parts[pi].box, dabs }));
    }
    for (const s of out) this.strokes.push(s);
    this.dropLive();
    if (out.length) this.version++;
    return out;
  }
  /** Forget the stroke in progress. */
  dropLive() {
    const L = this.live;
    L.n = 0; L.d[2] = 0; L.pending = []; L.grid.reset(1); L.gridVersion++;
  }

  // ---- packing for the shader

  /** Textures for the fragment shader. The newest strokes stay exact: { dab (Float32 RGBA, 3 texels per dab), hash
   *  (Uint32 RGBA), idx (Uint32 R), head (Float32 RGBA, 3 texels per part) }; everything older is flattened into the
   *  field: { field: { head, lay, copy, hash, col (half RGBA), fin (RGBA8) } }. Strokes are flattened when more than
   *  RECENT_STROKES / RECENT_DABS are exact or a cell would hold more than CELL_CAP entries: no visible paint is ever
   *  capped away. maxRows: the GPU's texture height limit. */
  build(maxRows = 4096) {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const n = this.strokes.length;
    let state = this.pickState();
    let recentDabs = 0;
    for (let i = state.F; i < n; i++) recentDabs += this.strokes[i].dabs.length / 6;
    if (n - state.F > RECENT_STROKES || recentDabs > RECENT_DABS) {
      // keep the newest KEEP_RECENT strokes exact, and at most a quarter of RECENT_DABS (flattening is then rare)
      let F = Math.max(state.F, n - KEEP_RECENT), keep = 0;
      for (let i = n - 1; i >= F; i--) { keep += this.strokes[i].dabs.length / 6; if (keep > RECENT_DABS / 4) { F = i + 1; break; } }
      state = this.flatten(state, Math.min(n, F));
    }
    let B = this.packRecent(state.F, maxRows);
    if (B.stats.maxPerCell > CELL_CAP) { state = this.flatten(state, n); B = this.packRecent(n, maxRows); }
    B.field = packField(state, this.parts, maxRows);
    B.state = state; B.F = state.F;
    B.partNames = this.parts.map((p) => p.name);
    B.remaps = this.parts.map((pt) => { const e = state.parts.get(pt.name); return e ? remapper(pt.box, e.shared.box) : null; });
    B.ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
    B.flattenMs = this.flattenMs || 0;
    return B;
  }

  /** The exact strokes [F, n): packed dabs and per-part grids (appended strokes only rebuild their parts). */
  packRecent(F, maxRows) {
    const P = this.parts, np = P.length;
    let pk = this.packed;
    const appendable = pk && pk.base === F && pk.parts === P && pk.cellScale === this.cellScale && F + pk.strokes.length <= this.strokes.length
      && pk.strokes.every((s, i) => s === this.strokes[F + i]);
    if (!appendable) {
      pk = this.packed = { base: F, parts: P, cellScale: this.cellScale, strokes: [], n: 0, dab: new Float32Array(TEX_W * 12), lists: P.map(() => ({ dabs: [], fills: [] })), grids: new Array(np).fill(null) };
    }
    const dirty = new Set(appendable ? [] : P.map((_, i) => i));
    let total = pk.n;
    for (let si = F + pk.strokes.length; si < this.strokes.length; si++) total += this.strokes[si].dabs.length / 6;
    if (pk.dab.length < total * 12) { const cap = Math.max(pk.dab.length * 2, Math.ceil((total * 3) / TEX_W) * TEX_W * 4); const a = new Float32Array(cap); a.set(pk.dab.subarray(0, pk.n * 12)); pk.dab = a; }
    const D = pk.dab;
    for (let si = F + pk.strokes.length; si < this.strokes.length; si++) {
      const s = this.strokes[si], k = s.dabs.length / 6, pi = this.index.get(s.part);
      pk.strokes.push(s);
      if (pi === undefined) continue;                     // its part is gone (a same-element edit): it takes no space
      const map = remapper(s.box, P[pi].box), kind = KIND[s.kind] ?? 0, fin = Math.max(0, FINISHES.indexOf(s.finish)), hf = packHF(s.hard, s.flow);
      const L = pk.lists[pi];
      for (let i = 0; i < k; i++) {
        const d = s.dabs, j = i * 6, g = pk.n++, o = g * 12;
        let x = d[j], y = d[j + 1], z = d[j + 2], r = d[j + 3];
        if (map) { x = x * map.s[0] + map.o[0]; y = y * map.s[1] + map.o[1]; z = z * map.s[2] + map.o[2]; r *= map.r; }
        const copy = d[j + 5];
        D[o] = x; D[o + 1] = y; D[o + 2] = z; D[o + 3] = r;
        D[o + 4] = s.rgb[0]; D[o + 5] = s.rgb[1]; D[o + 6] = s.rgb[2]; D[o + 7] = s.cap;
        D[o + 8] = hf; D[o + 9] = (copy + 1) * 16 + kind * 4 + fin; D[o + 10] = s.id; D[o + 11] = d[j + 4];
        if (kind === 2) L.fills.push(g); else L.dabs.push(g);
      }
      dirty.add(pi);
    }
    for (const pi of dirty) {
      const L = pk.lists[pi];
      if (!L.dabs.length && !L.fills.length) { pk.grids[pi] = null; continue; }
      // fills, newest first: an opaque all-copies fill hides everything older; an opaque fill of one copy hides that
      // copy's older dabs and fills
      let cutAll = -1;
      const cutCopy = new Map(), keep = [];
      for (let i = L.fills.length - 1; i >= 0; i--) {
        const g = L.fills[i], o = g * 12, copy = Math.floor(D[o + 9] / 16) - 1, opaque = D[o + 7] >= 0.999;
        if (copy >= 0 && cutCopy.has(copy)) continue;
        keep.push(g);
        if (opaque) { if (copy < 0) { cutAll = g; break; } cutCopy.set(copy, g); }
      }
      keep.reverse();
      const vis = [];
      for (const g of L.dabs) {
        if (g < cutAll) continue;
        if (cutCopy.size) { const c = Math.floor(D[g * 12 + 9] / 16) - 1; if (c >= 0 && cutCopy.has(c) && g < cutCopy.get(c)) continue; }
        vis.push(g);
      }
      const grid = vis.length ? partGrid(D, vis, this.cellScale) : null;
      pk.grids[pi] = { grid, fills: Uint32Array.from(keep), dabs: vis, cutAll };
    }
    let hashN = 0, idxN = 0, entries = 0, kept = 0, cells = 0;
    for (const G of pk.grids) if (G) { hashN += G.grid ? G.grid.table.size : 0; idxN += (G.grid ? G.grid.kept : 0) + G.fills.length; }
    const rows = (k) => Math.max(1, Math.ceil(k / TEX_W));
    const hashRows = rows(hashN), idxRows = rows(idxN);
    if ((hashRows > maxRows || idxRows > maxRows) && this.cellScale < 16) {
      this.cellScale *= 2; this.clearCache();       // coarser grids, fewer entries: the paint stays, it costs more to draw
      return this.packRecent(F, maxRows);
    }
    const hash = new Uint32Array(hashRows * TEX_W * 4), idx = new Uint32Array(idxRows * TEX_W);
    const head = new Float32Array(Math.max(1, Math.ceil((np * 3) / TEX_W)) * TEX_W * 4);
    let ho = 0, io = 0;
    for (let pi = 0; pi < np; pi++) {
      const G = pk.grids[pi];
      if (!G) continue;
      const h = pi * 12, g = G.grid;
      if (g) {
        const t = g.table.t;
        hash.set(t, ho * 4);
        for (let sl = 0; sl < g.table.size; sl++) if (t[sl * 4 + 1]) hash[(ho + sl) * 4 + 2] += io;
        idx.set(g.items, io);
        head[h] = g.min[0]; head[h + 1] = g.min[1]; head[h + 2] = g.min[2]; head[h + 3] = g.cell;
        head[h + 4] = ho; head[h + 5] = g.table.size;
        entries += g.entries; kept += g.kept; cells += g.cells;
      } else { head[h + 3] = 1; head[h + 5] = 0; }
      const ioF = io + (g ? g.kept : 0);
      idx.set(G.fills, ioF);
      head[h + 6] = ioF; head[h + 7] = G.fills.length; head[h + 8] = 1;
      // an opaque all-copies fill among the exact strokes hides the flattened field below it
      head[h + 9] = G.cutAll >= 0 ? 1 : 0;
      ho += g ? g.table.size : 0; io = ioF + G.fills.length;
    }
    const maxPerCell = Math.max(0, ...pk.grids.map((G) => (G && G.grid ? G.grid.maxCell : 0)));
    const usedRows = Math.max(1, Math.ceil((pk.n * 3) / TEX_W));
    return { dab: D.subarray(0, usedRows * TEX_W * 4), hash, idx, head, rows: { dab: usedRows, hash: hashRows, idx: idxRows, head: head.length / (TEX_W * 4) },
      dabs: pk.n, parts: np, dirty: dirty.size,
      stats: { entries, kept, cells, maxPerCell, meanPerCell: cells ? kept / cells : 0, cellScale: this.cellScale },
      partDabs: pk.grids.map((G) => (G ? G.dabs : null)) };
  }
}

// --------------------------------------------------------------------------------------------- parts

/** One paint part per mesh: its key is the mesh's name, or name#2, name#3... for further meshes of the same name
 *  (a portico's raking dentils): a pick names the mesh that was hit, and "this copy" is a copy of that mesh. */
export function partsOf(meshes) {
  const seen = new Map();
  return meshes.map((m) => {
    const k = (seen.get(m.name) || 0) + 1;
    seen.set(m.name, k);
    return { name: k === 1 ? m.name : `${m.name}#${k}`, box: m.box || boxOf(m.positions), n: m.transforms ? m.transforms.length / 16 : 1 };
  });
}

// --------------------------------------------------------------------------------------------- the flattened field
//
// Older paint is merged, as a painter flattens layers: per part a sparse field of bricks (8^3 voxels, 9^3 samples with
// their own apron) in the part's coordinates, each sample the composite of the flattened strokes there (premultiplied
// colour + alpha, premultiplied roughness + metalness), with a uniform background outside the bricks (fills). Voxel
// about a third of the flattened dabs' radius. A copy painted on its own gets its own layer (a copy of the shared one
// at that moment). Fields are copy-on-write: each flatten makes a new state and the earlier ones stay for undo.

export const EMPTY_STATE = Object.freeze({ F: 0, last: null, parts: new Map(), id: 0 });
let stateId = 1;

class Layer {
  constructor(v, origin, box) { this.v = v; this.origin = origin; this.box = box; this.bg = new Float32Array(6); this.bricks = new Map(); this.own = new Set(); }
  clone() { const l = new Layer(this.v, this.origin, this.box); l.bg.set(this.bg); l.bricks = new Map(this.bricks); return l; }
  /** a brick this layer may write (copied on first write; created from the background) */
  brick(key) {
    let b = this.bricks.get(key);
    if (b && this.own.has(key)) return b;
    const nb = new Float32Array(BRICK_N * 6);
    if (b) nb.set(b); else for (let i = 0; i < BRICK_N; i++) nb.set(this.bg, i * 6);
    this.bricks.set(key, nb); this.own.add(key);
    return nb;
  }
}
const bkey = (x, y, z) => x + y * 65536 + z * 4294967296;
/** paint (s, colour c, finish f) or erase (c null) over a premultiplied sample at o */
function overSample(a, o, s, c, f) {
  const k = 1 - s;
  if (c) { a[o] = s * c[0] + k * a[o]; a[o + 1] = s * c[1] + k * a[o + 1]; a[o + 2] = s * c[2] + k * a[o + 2]; a[o + 3] = s + k * a[o + 3]; a[o + 4] = s * f[0] + k * a[o + 4]; a[o + 5] = s * f[1] + k * a[o + 5]; }
  else for (let i = 0; i < 6; i++) a[o + i] *= k;
}

/** A new state with strokes [state.F, F) flattened in. */
function flattenStrokes(state, strokes, F, parts, index) {
  const next = { F, last: strokes[F - 1], parts: new Map(state.parts), id: stateId++ };
  const touched = new Map();       // part key -> { shared, copies } owned by the new state
  const entry = (key, box, dabs) => {
    let e = touched.get(key);
    if (e) return e;
    const old = next.parts.get(key);
    if (old) e = { shared: old.shared.clone(), copies: new Map([...old.copies].map(([c, l]) => [c, l.clone()])) };
    else {
      // voxel: a third of the median radius of the dabs being flattened (not finer than the part's diagonal / 1500)
      const rs = [];
      for (let i = 3; i < dabs.length; i += 6 * Math.max(1, Math.floor(dabs.length / 6 / 400))) rs.push(dabs[i]);
      rs.sort((a, b) => a - b);
      const diag = Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) || 1;
      const v = Math.max((rs.length ? rs[rs.length >> 1] : diag / 100) / 3, diag / 1500, 1e-4);
      e = { shared: new Layer(v, [box[0] - 64 * v, box[1] - 64 * v, box[2] - 64 * v], box.slice()), copies: new Map() };
    }
    touched.set(key, e); next.parts.set(key, e);
    return e;
  };
  for (let si = state.F; si < F; si++) {
    const s = strokes[si];
    const pi = index.get(s.part);
    if (pi === undefined) continue;
    const e = entry(s.part, parts[pi].box, s.dabs);
    const kind = KIND[s.kind] ?? 0, col = kind === 1 ? null : s.rgb, fin = FINISH_PBR[s.finish] || FINISH_PBR.matte;
    // the copies this stroke names get their own layers (from the shared one as it is now)
    const named = new Set();
    for (let i = 5; i < s.dabs.length; i += 6) if (s.dabs[i] >= 0) named.add(s.dabs[i]);
    for (const c of named) if (!e.copies.has(c)) e.copies.set(c, e.shared.clone());
    const layers = [[e.shared, -1], ...[...e.copies].map(([c, l]) => [l, c])];
    for (const [L, lc] of layers) {
      if (kind === 2) {
        const copy = s.dabs[5];
        if (copy >= 0 && copy !== lc) continue;
        overSample(L.bg, 0, s.cap, col, fin);
        for (const key of [...L.bricks.keys()]) { const b = L.brick(key); for (let i = 0; i < BRICK_N; i++) overSample(b, i * 6, s.cap, col, fin); }
        continue;
      }
      applyStroke(L, s, lc, col, fin);
    }
  }
  return Object.freeze(next);
}

/** One paint or erase stroke into a layer: the stroke's coverage per sample (flow build-up up to the dab ceilings),
 *  then over (or erase) once per sample. lc: the layer's copy (-1 shared: only all-copies dabs). */
function applyStroke(L, s, lc, col, fin) {
  const map = remapper(s.box, L.box), v = L.v, inv = 1 / v, o = L.origin, hard = Math.min(1, Math.max(0, s.hard)), flow = s.flow ?? 1;
  const acc = new Map();
  const d = s.dabs;
  for (let i = 0; i < d.length; i += 6) {
    const copy = d[i + 5];
    if (copy >= 0 && copy !== lc) continue;
    let x = d[i], y = d[i + 1], z = d[i + 2], r = d[i + 3];
    if (map) { x = x * map.s[0] + map.o[0]; y = y * map.s[1] + map.o[1]; z = z * map.s[2] + map.o[2]; r *= map.r; }
    const p = d[i + 4], w = Math.max(r * (1 - hard), v * 0.5);
    const g0x = Math.max(0, Math.ceil((x - r - o[0]) * inv)), g1x = Math.floor((x + r - o[0]) * inv);
    const g0y = Math.max(0, Math.ceil((y - r - o[1]) * inv)), g1y = Math.floor((y + r - o[1]) * inv);
    const g0z = Math.max(0, Math.ceil((z - r - o[2]) * inv)), g1z = Math.floor((z + r - o[2]) * inv);
    if (g1x < g0x || g1y < g0y || g1z < g0z) continue;
    for (let bz = Math.max(0, Math.floor((g0z - 1) / BRICK)); bz <= Math.floor(g1z / BRICK); bz++)
      for (let by = Math.max(0, Math.floor((g0y - 1) / BRICK)); by <= Math.floor(g1y / BRICK); by++)
        for (let bx = Math.max(0, Math.floor((g0x - 1) / BRICK)); bx <= Math.floor(g1x / BRICK); bx++) {
          const sx0 = Math.max(0, g0x - bx * BRICK), sx1 = Math.min(BRICK, g1x - bx * BRICK);
          const sy0 = Math.max(0, g0y - by * BRICK), sy1 = Math.min(BRICK, g1y - by * BRICK);
          const sz0 = Math.max(0, g0z - bz * BRICK), sz1 = Math.min(BRICK, g1z - bz * BRICK);
          if (sx1 < sx0 || sy1 < sy0 || sz1 < sz0) continue;
          const key = bkey(bx, by, bz);
          let A = acc.get(key);
          for (let sz = sz0; sz <= sz1; sz++) {
            const pz = o[2] + (bz * BRICK + sz) * v - z;
            for (let sy = sy0; sy <= sy1; sy++) {
              const py = o[1] + (by * BRICK + sy) * v - y, pyz = py * py + pz * pz;
              for (let sx = sx0; sx <= sx1; sx++) {
                const px = o[0] + (bx * BRICK + sx) * v - x, dist = Math.sqrt(px * px + pyz);
                if (dist >= r) continue;
                const t = Math.min(1, Math.max(0, (dist - (r - w)) / w)), cov = 1 - t * t * (3 - 2 * t);
                if (cov <= 0) continue;
                if (!A) { A = new Float32Array(BRICK_N * 2); acc.set(key, A); }
                const q = (sx + BRICK_S * (sy + BRICK_S * sz)) * 2;
                A[q] += cov * flow * (1 - A[q]);
                if (cov * p > A[q + 1]) A[q + 1] = cov * p;
              }
            }
          }
        }
  }
  for (const [key, A] of acc) {
    const b = L.brick(key);
    for (let i = 0; i < BRICK_N; i++) {
      const sv = s.cap * Math.min(A[i * 2], A[i * 2 + 1]);
      if (sv > 0) overSample(b, i * 6, sv, col, fin);
    }
  }
}

// float -> half (truncating; the field's values are in [0, 1])
const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer);
function half(v) {
  F32[0] = v; const x = U32[0], e = ((x >>> 23) & 0xff) - 112;
  if (e <= 0) return 0;
  if (e > 30) return 0x7bff;
  return (e << 10) | ((x & 0x7fffff) >>> 13);
}
const HALF = new WeakMap();   // brick array -> its half-float colour and RGBA8 finish (bricks never change once shared)
function brickTex(b) {
  let t = HALF.get(b);
  if (t) return t;
  const col = new Uint16Array(BRICK_N * 4), fin = new Uint8Array(BRICK_N * 4);
  for (let i = 0; i < BRICK_N; i++) {
    for (let k = 0; k < 4; k++) col[i * 4 + k] = half(Math.min(1, Math.max(0, b[i * 6 + k])));
    fin[i * 4] = Math.round(Math.min(1, Math.max(0, b[i * 6 + 4])) * 255); fin[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, b[i * 6 + 5])) * 255);
  }
  t = { col, fin };
  HALF.set(b, t);
  return t;
}

/** The field's textures for the parts on screen (cached per state and parts list): part header (3 texels: layer + 1,
 *  copy list start, count, active; remap scale; remap offset), layers (4 texels: origin + voxel, brick table offset +
 *  size + brick base, background colour, background finish), copy list (copy, layer), brick tables, samples. */
const FIELD_CACHE = new WeakMap();
export function packField(state, parts, maxRows = 4096) {
  let byParts = FIELD_CACHE.get(state);
  if (!byParts) { byParts = new WeakMap(); FIELD_CACHE.set(state, byParts); }
  const hit = byParts.get(parts);
  if (hit) return hit;
  const np = parts.length, head = new Float32Array(Math.max(1, Math.ceil((np * 3) / TEX_W)) * TEX_W * 4);
  const layers = [], copies = [];
  let bricks = 0, hashN = 0;
  parts.forEach((pt, pi) => {
    const e = state.parts.get(pt.name);
    if (!e) return;
    const add = (L) => { layers.push(L); bricks += L.bricks.size; return layers.length - 1; };
    const sh = add(e.shared), cs = copies.length;
    for (const [c, L] of e.copies) copies.push(c, add(L));
    const m = remapper(pt.box, e.shared.box) || { s: [1, 1, 1], o: [0, 0, 0] }, h = pi * 12;
    head[h] = sh + 1; head[h + 1] = cs / 2; head[h + 2] = e.copies.size; head[h + 3] = 1;
    head[h + 4] = m.s[0]; head[h + 5] = m.s[1]; head[h + 6] = m.s[2];
    head[h + 8] = m.o[0]; head[h + 9] = m.o[1]; head[h + 10] = m.o[2];
  });
  const lay = new Float32Array(Math.max(1, Math.ceil((layers.length * 4) / TEX_W)) * TEX_W * 4);
  const copy = new Float32Array(Math.max(1, Math.ceil(copies.length / 2 / TEX_W)) * TEX_W * 4);
  for (let i = 0; i < copies.length; i += 2) { copy[i * 2] = copies[i]; copy[i * 2 + 1] = copies[i + 1]; }
  // brick tables first (a table may grow while it is filled), then the textures
  const tables = layers.map((L) => {
    const T = new CellTable(1);
    T.alloc(tableSize(L.bricks.size));
    for (const key of L.bricks.keys()) T.slot(key % 65536, Math.floor(key / 65536) % 65536, Math.floor(key / 4294967296));
    hashN += T.size;
    return T;
  });
  const hash = new Uint32Array(Math.max(1, Math.ceil(hashN / TEX_W)) * TEX_W * 4);
  const sampleRows = Math.max(1, Math.ceil((bricks * BRICK_N) / TEX_W));
  const col = new Uint16Array(sampleRows * TEX_W * 4), fin = new Uint8Array(sampleRows * TEX_W * 4);
  let ho = 0, bi = 0;
  layers.forEach((L, li) => {
    const T = tables[li];
    for (const [key, b] of L.bricks) {
      const sl = T.find(key % 65536, Math.floor(key / 65536) % 65536, Math.floor(key / 4294967296));
      T.t[sl * 4 + 2] = bi;
      const t = brickTex(b);
      col.set(t.col, bi * BRICK_N * 4); fin.set(t.fin, bi * BRICK_N * 4);
      bi++;
    }
    hash.set(T.t, ho * 4);
    const o = li * 16;
    lay[o] = L.origin[0]; lay[o + 1] = L.origin[1]; lay[o + 2] = L.origin[2]; lay[o + 3] = L.v;
    lay[o + 4] = ho; lay[o + 5] = T.size;
    for (let k = 0; k < 4; k++) lay[o + 8 + k] = L.bg[k];
    lay[o + 12] = L.bg[4]; lay[o + 13] = L.bg[5];
    ho += T.size;
  });
  const out = { head, lay, copy, hash, col, fin, bricks, samples: bricks * BRICK_N, rows: sampleRows, over: sampleRows > maxRows, layers: layers.length };
  byParts.set(parts, out);
  return out;
}
// a brick table's size (power of two, at most half full); the CellTable may grow past it while filling: then it is
// re-packed at its grown size (rare)
function tableSize(n) { return Math.max(64, 1 << Math.ceil(Math.log2(Math.max(2, n * 2)))); }

/** The flattened field at part-local point p of part pi, copy `copy`: [C r, g, b, A, F rough, F metal] premultiplied. */
export function fieldAt(B, pi, p, copy) {
  const out = [0, 0, 0, 0, 0, 0], st = B.state, pt = B.parts ? B.parts[pi] : null;
  const name = (B.partNames && B.partNames[pi]) || (pt && pt.name);
  const e = st && name !== undefined ? st.parts.get(name) : null;
  if (!e) return out;
  const L = e.copies.get(copy) || e.shared, m = B.remaps && B.remaps[pi];
  const q = m ? [p[0] * m.s[0] + m.o[0], p[1] * m.s[1] + m.o[1], p[2] * m.s[2] + m.o[2]] : p;
  const g = [0, 1, 2].map((a) => (q[a] - L.origin[a]) / L.v), b = g.map((x) => Math.floor(x / BRICK));
  const br = b.every((x) => x >= 0) ? L.bricks.get(bkey(b[0], b[1], b[2])) : null;
  if (!br) { for (let k = 0; k < 6; k++) out[k] = L.bg[k]; return out; }
  const l = g.map((x, a) => x - b[a] * BRICK), l0 = l.map((x) => Math.min(BRICK - 1, Math.floor(x))), t = l.map((x, a) => x - l0[a]);
  for (let c = 0; c < 8; c++) {
    const dx = c & 1, dy = (c >> 1) & 1, dz = c >> 2;
    const wgt = (dx ? t[0] : 1 - t[0]) * (dy ? t[1] : 1 - t[1]) * (dz ? t[2] : 1 - t[2]);
    const o = ((l0[0] + dx) + BRICK_S * ((l0[1] + dy) + BRICK_S * (l0[2] + dz))) * 6;
    for (let k = 0; k < 6; k++) out[k] += wgt * br[o + k];
  }
  return out;
}

// --------------------------------------------------------------------------------------------- compositing (CPU)

const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-9))); return t * t * (3 - 2 * t); };

/** The cell list of part pi at point p: [start, count] (the GPU's lookup). */
export function cellAt(B, pi, p) {
  const H = B.head, h = pi * 12;
  const hsize = H[h + 5];
  if (!H[h + 8] || !hsize) return [0, 0];
  const cs = H[h + 3], x = Math.floor((p[0] - H[h]) / cs), y = Math.floor((p[1] - H[h + 1]) / cs), z = Math.floor((p[2] - H[h + 2]) / cs);
  if (x < 0 || y < 0 || z < 0 || x > 65535 || y > 65535 || z > 65534) return [0, 0];
  const k0 = (x | (y << 16)) >>> 0, k1 = z + 1, mask = hsize - 1, ho = H[h + 4], t = B.hash;
  let s = hash3(x, y, z) & mask;
  for (let i = 0; i < PROBE_MAX; i++) {
    const o = (ho + s) * 4;
    if (t[o + 1] === 0) return [0, 0];
    if (t[o] === k0 && t[o + 1] === k1) return [t[o + 2], t[o + 3]];
    s = (s + 1) & mask;
  }
  return [0, 0];
}

/** Paint at part-local point p on copy `copy` of part pi, from a build() result: [r, g, b, alpha, rough, metal]
 *  (colour and finish not premultiplied). The shader's order exactly: newest first, transmittance, early stop. */
export function paintAt(B, pi, p, copy, px = 1e-4) {
  const H = B.head, h = pi * 12;
  const out = [0, 0, 0, 0, FINISH_PBR.matte[0], 0];
  const [st, cnt] = H[h + 8] ? cellAt(B, pi, p) : [0, 0], fs = H[h + 8] ? H[h + 6] : 0, fc = H[h + 8] ? H[h + 7] : 0, D = B.dab, I = B.idx;
  let C0 = 0, C1 = 0, C2 = 0, A = 0, F0 = 0, F1 = 0, T = 1;
  let id = -1, acc = 0, lim = 0, cap = 0, kind = 0, col = null, fin = null, hard = 0, flow = 1;
  const flush = () => {
    if (id < 0) return;
    const s = cap * Math.min(acc, lim);
    if (kind !== 1) { C0 += T * s * col[0]; C1 += T * s * col[1]; C2 += T * s * col[2]; A += T * s; F0 += T * s * fin[0]; F1 += T * s * fin[1]; }
    T *= 1 - s;
    id = -1; acc = 0; lim = 0;
  };
  let i = cnt - 1, j = fc - 1;
  for (let it = 0; it < CELL_CAP + FILL_MAX; it++) {
    if ((i < 0 && j < 0) || T < 1e-3) break;
    let d;
    if (i >= 0 && (j < 0 || I[st + i] > I[fs + j])) { d = I[st + i]; i--; } else { d = I[fs + j]; j--; }
    const o = d * 12, pk = D[o + 9], cp = Math.floor(pk / 16) - 1, kf = pk - (cp + 1) * 16, k = Math.floor(kf / 4), f = kf - k * 4;
    if (cp >= 0 && cp !== copy) continue;
    if (D[o + 10] !== id) {
      flush();
      id = D[o + 10]; col = [D[o + 4], D[o + 5], D[o + 6]]; cap = D[o + 7]; kind = k; fin = FINISH_PBR[FINISHES[f]];
      hard = (D[o + 8] % 256) / 255; flow = Math.floor(D[o + 8] / 256) / 255;
    }
    if (k === 2) { acc = 1; lim = 1; continue; }
    const r = D[o + 3], dist = Math.hypot(p[0] - D[o], p[1] - D[o + 1], p[2] - D[o + 2]);
    const w = Math.max(r * (1 - hard), px), cov = 1 - smooth(r - w, r, dist);
    acc += cov * flow * (1 - acc);
    lim = Math.max(lim, cov * D[o + 11]);
  }
  flush();
  // the flattened field below
  if (T >= 1e-3 && B.state && B.state.F) {
    const f = fieldAt(B, pi, p, copy);
    C0 += T * f[0]; C1 += T * f[1]; C2 += T * f[2]; A += T * f[3]; F0 += T * f[4]; F1 += T * f[5];
  }
  if (A > 1e-6) { out[0] = C0 / A; out[1] = C1 / A; out[2] = C2 / A; out[4] = F0 / A; out[5] = F1 / A; }
  out[3] = A;
  return out;
}

/** Vertex colours (linear RGBA: the base colour mixed with the paint) of part pi for one copy, or null if unpainted. */
/** Is part pi painted at all (exact strokes or a flattened field)? */
export const isPainted = (B, pi) => !!(B.head[pi * 12 + 8] || (B.state && B.partNames && B.state.parts.has(B.partNames[pi])));
export function bakeColors(B, pi, positions, copy, base) {
  if (!isPainted(B, pi)) return null;
  const n = positions.length / 3, out = new Float32Array(n * 4);
  let any = false;
  for (let v = 0; v < n; v++) {
    const c = paintAt(B, pi, [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]], copy, 1e-4);
    const a = c[3];
    if (a > 0.002) any = true;
    for (let k = 0; k < 3; k++) out[v * 4 + k] = base[k] * (1 - a) + c[k] * a;
    out[v * 4 + 3] = 1;
  }
  return any ? out : null;
}

/** The painted part's mesh for an export: refined only where the baked colour changes (edges sampled against their
 *  linear interpolation; a dab inside a triangle; a large triangle crossing the flattened field's bricks) until the
 *  edges there are shorter than half the local feature (r / 2 of the dabs, the field's voxel), within a vertex budget.
 *  Edges are marked on the WELDED topology (vertices at the same position, split for creases, are one): both sides
 *  of a crease split the same edges, so the part stays watertight (no T-junctions). Returns { positions, normals,
 *  indices, colors, refined } or null (unpainted). opts: { maxVerts }. */
export function refinePainted(mesh, B, pi, copy, base, opts = {}) {
  if (!isPainted(B, pi)) return null;
  const maxVerts = opts.maxVerts || 800000;
  const D = B.dab, list = (B.partDabs && B.partDabs[pi]) || [];
  const chunks = [];
  for (let i = 0; i < list.length; i += 32) {
    const c = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], ds: [] };
    for (let k = i; k < Math.min(list.length, i + 32); k++) {
      const o = list[k] * 12, cp = Math.floor(D[o + 9] / 16) - 1;
      if (cp >= 0 && cp !== copy) continue;
      const r = D[o + 3];
      c.ds.push(o);
      for (let a = 0; a < 3; a++) { c.lo[a] = Math.min(c.lo[a], D[o + a] - r); c.hi[a] = Math.max(c.hi[a], D[o + a] + r); }
    }
    if (c.ds.length) chunks.push(c);
  }
  // the flattened field's bricks (in part coordinates) for this copy
  const name = B.partNames && B.partNames[pi], fe = B.state && name !== undefined ? B.state.parts.get(name) : null;
  const layer = fe ? fe.copies.get(copy) || fe.shared : null, m = B.remaps && B.remaps[pi];
  const toL = (x, a) => (m ? x * m.s[a] + m.o[a] : x);
  const brickAt = (lo, hi) => {        // does the box [lo, hi] (part coordinates) meet a brick?
    if (!layer || !layer.bricks.size) return false;
    const span = BRICK * layer.v, b0 = [], b1 = [];
    for (let a = 0; a < 3; a++) {
      const u = toL(lo[a], a), w = toL(hi[a], a);
      b0.push(Math.floor((Math.min(u, w) - layer.origin[a]) / span)); b1.push(Math.floor((Math.max(u, w) - layer.origin[a]) / span));
    }
    const vol = (b1[0] - b0[0] + 1) * (b1[1] - b0[1] + 1) * (b1[2] - b0[2] + 1);
    if (vol > layer.bricks.size) {
      for (const k of layer.bricks.keys()) { const x = k % 65536, y = Math.floor(k / 65536) % 65536, z = Math.floor(k / 4294967296); if (x >= b0[0] && x <= b1[0] && y >= b0[1] && y <= b1[1] && z >= b0[2] && z <= b1[2]) return true; }
      return false;
    }
    for (let z = b0[2]; z <= b1[2]; z++) for (let y = b0[1]; y <= b1[1]; y++) for (let x = b0[0]; x <= b1[0]; x++) if (x >= 0 && y >= 0 && z >= 0 && layer.bricks.has(bkey(x, y, z))) return true;
    return false;
  };
  const vfine = layer ? layer.v : Infinity;
  const P = Array.from(mesh.positions), N = mesh.normals ? Array.from(mesh.normals) : null;
  let T = Array.from(mesh.indices);
  const nv0 = P.length / 3;
  // weld: one id per position
  const wid = [], wmap = new Map();
  const weld = (v) => { const k = `${Math.round(P[v * 3] * 1e6)},${Math.round(P[v * 3 + 1] * 1e6)},${Math.round(P[v * 3 + 2] * 1e6)}`; let w = wmap.get(k); if (w === undefined) { w = wmap.size; wmap.set(k, w); } wid[v] = w; };
  for (let v = 0; v < nv0; v++) weld(v);
  const colour = [];          // baked colour per vertex (cached)
  const bake = (p) => { const c = paintAt(B, pi, p, copy, 1e-4), a = c[3]; return [base[0] * (1 - a) + c[0] * a, base[1] * (1 - a) + c[1] * a, base[2] * (1 - a) + c[2] * a]; };
  const colOf = (v) => colour[v] || (colour[v] = bake([P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]));
  const ekey = (i, j) => { const a = wid[i], b = wid[j]; return a < b ? a * 8388608 + b : b * 8388608 + a; };
  let cand = null;
  for (let lv = 0; lv < 28; lv++) {
    const nt = T.length / 3, marks = new Set();
    for (let t = 0; t < nt; t++) {
      if (cand && !cand[t]) continue;
      const vi = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]], pts = vi.map((v) => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
      const lo = [0, 1, 2].map((a) => Math.min(pts[0][a], pts[1][a], pts[2][a])), hi = [0, 1, 2].map((a) => Math.max(pts[0][a], pts[1][a], pts[2][a]));
      const len = [0, 1, 2].map((e) => Math.hypot(pts[e][0] - pts[(e + 1) % 3][0], pts[e][1] - pts[(e + 1) % 3][1], pts[e][2] - pts[(e + 1) % 3][2]));
      const L = Math.max(...len);
      // the local feature size: the smallest radius of a dab that reaches the triangle; the field's voxel near bricks
      let h = Infinity, inside = false;
      for (const ch of chunks) {
        if (hi[0] < ch.lo[0] || lo[0] > ch.hi[0] || hi[1] < ch.lo[1] || lo[1] > ch.hi[1] || hi[2] < ch.lo[2] || lo[2] > ch.hi[2]) continue;
        for (const o of ch.ds) {
          const r = D[o + 3], c = [D[o], D[o + 1], D[o + 2]];
          if (c[0] + r < lo[0] || c[0] - r > hi[0] || c[1] + r < lo[1] || c[1] - r > hi[1] || c[2] + r < lo[2] || c[2] - r > hi[2]) continue;
          if (r / 2 < h) h = r / 2;
          if (!inside && r < L && pointInTri(c, pts, r)) inside = true;
        }
      }
      const nearField = brickAt(lo, hi);
      if (nearField && vfine < h * 2) h = Math.min(h, vfine);
      if (!(h < Infinity) || L <= h) continue;
      let split = inside || (nearField && L > BRICK * vfine);
      if (!split) {
        // colour change along an edge: sampled against the linear interpolation of its ends
        for (let e = 0; e < 3 && !split; e++) {
          if (len[e] <= h) continue;
          const a = vi[e], b = vi[(e + 1) % 3], ca = colOf(a), cb = colOf(b), k = Math.min(24, Math.max(2, Math.ceil(len[e] / h)));
          if (Math.max(Math.abs(ca[0] - cb[0]), Math.abs(ca[1] - cb[1]), Math.abs(ca[2] - cb[2])) > 0.004) { split = true; break; }
          for (let q = 1; q < k && !split; q++) {
            const u = q / k, c = bake([pts[e][0] + (pts[(e + 1) % 3][0] - pts[e][0]) * u, pts[e][1] + (pts[(e + 1) % 3][1] - pts[e][1]) * u, pts[e][2] + (pts[(e + 1) % 3][2] - pts[e][2]) * u]);
            if (Math.abs(c[0] - ca[0]) + Math.abs(c[1] - ca[1]) + Math.abs(c[2] - ca[2]) > 0.006) split = true;
          }
        }
      }
      if (split) for (let e = 0; e < 3; e++) if (len[e] > h) marks.add(ekey(vi[e], vi[(e + 1) % 3]));
    }
    if (!marks.size || P.length / 3 > maxVerts) break;
    const mid = new Map(), pkey = (i, j) => (i < j ? i * 8388608 + j : j * 8388608 + i);
    const midOf = (i, j) => {
      if (!marks.has(ekey(i, j))) return undefined;
      const k = pkey(i, j);
      let mv = mid.get(k);
      if (mv === undefined) {
        mv = P.length / 3;
        P.push((P[i * 3] + P[j * 3]) / 2, (P[i * 3 + 1] + P[j * 3 + 1]) / 2, (P[i * 3 + 2] + P[j * 3 + 2]) / 2);
        if (N) { const x = N[i * 3] + N[j * 3], y = N[i * 3 + 1] + N[j * 3 + 1], z = N[i * 3 + 2] + N[j * 3 + 2], l = Math.hypot(x, y, z) || 1; N.push(x / l, y / l, z / l); }
        weld(mv);
        mid.set(k, mv);
      }
      return mv;
    };
    const out = [], nc = [];
    for (let t = 0; t < nt; t++) {
      const v = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
      const mm = [midOf(v[0], v[1]), midOf(v[1], v[2]), midOf(v[2], v[0])];
      const n = (mm[0] !== undefined) + (mm[1] !== undefined) + (mm[2] !== undefined);
      if (!n) { out.push(v[0], v[1], v[2]); nc.push(0); continue; }
      nc.push(...(n === 3 ? [1, 1, 1, 1] : n === 2 ? [1, 1, 1] : [1, 1]));
      if (n === 3) { out.push(v[0], mm[0], mm[2], mm[0], v[1], mm[1], mm[2], mm[1], v[2], mm[0], mm[1], mm[2]); continue; }
      let s0 = 0;
      if (n === 1) s0 = mm[0] !== undefined ? 0 : mm[1] !== undefined ? 1 : 2;
      else s0 = mm[2] === undefined ? 0 : mm[0] === undefined ? 1 : 2;
      const V = [v[s0], v[(s0 + 1) % 3], v[(s0 + 2) % 3]], M = [mm[s0], mm[(s0 + 1) % 3], mm[(s0 + 2) % 3]];
      if (n === 1) out.push(V[0], M[0], V[2], M[0], V[1], V[2]);
      else out.push(M[0], V[1], M[1], V[0], M[0], M[1], V[0], M[1], V[2]);
    }
    T = out; cand = Uint8Array.from(nc);
  }
  const positions = Float32Array.from(P), n = positions.length / 3, colors = new Float32Array(n * 4);
  let any = false;
  for (let v = 0; v < n; v++) {
    const c = paintAt(B, pi, [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]], copy, 1e-4), a = c[3];
    if (a > 0.002) any = true;
    for (let k = 0; k < 3; k++) colors[v * 4 + k] = base[k] * (1 - a) + c[k] * a;
    colors[v * 4 + 3] = 1;
  }
  if (!any) return null;
  return { positions, normals: N ? Float32Array.from(N) : null, indices: Uint32Array.from(T), colors, refined: n - nv0 };
}
/** Is the dab centre c (within r of the plane) inside triangle pts? */
function pointInTri(c, pts, r) {
  const [a, b, d] = pts, u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], nl = Math.hypot(...n) || 1;
  if (Math.abs((w[0] * n[0] + w[1] * n[1] + w[2] * n[2]) / nl) > r) return false;
  const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2], vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2], uv = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const wu = w[0] * u[0] + w[1] * u[1] + w[2] * u[2], wv = w[0] * v[0] + w[1] * v[1] + w[2] * v[2], den = uv * uv - uu * vv || 1e-30;
  const s = (uv * wv - vv * wu) / den, t = (uv * wu - uu * wv) / den;
  return s >= -0.01 && t >= -0.01 && s + t <= 1.01;
}

/** Does any stroke of the part name one copy (then the copies differ and an export expands them)? */
export function perCopy(paint, name) {
  for (const s of paint.strokes) {
    if (s.part !== name) continue;
    for (let i = 5; i < s.dabs.length; i += 6) if (s.dabs[i] >= 0) return true;
  }
  return false;
}

/** Plain data for the worker (export bake): strokes + parts. */
export function exportData(paint) {
  return { element: paint.element, parts: paint.parts.map((p) => ({ name: p.name, box: p.box, n: p.n })),
    strokes: paint.strokes.map((s) => ({ ...s, rgb: [...s.rgb], box: s.box && [...s.box], dabs: new Float32Array(s.dabs) })) };
}
export function fromData(d) {
  const p = new Paint();
  p.parts = d.parts; p.parts.forEach((x, i) => { if (!p.index.has(x.name)) p.index.set(x.name, i); });
  p.element = d.element;
  p.strokes = d.strokes.map(makeStroke);
  return p;
}

// --------------------------------------------------------------------------------------------- stroke shaping

/** StreamLine-style smoothing: a lazy string of radius R = smoothing x 36 px (the brush follows the pointer only
 *  when it is pulled), then a light exponential filter; pressure is filtered too. */
export class Smoother {
  constructor(smoothing = 0.3) { this.k = Math.min(1, Math.max(0, smoothing)); this.p = null; }
  reset() { this.p = null; }
  push(x, y, pr) {
    if (!this.p) { this.p = { x, y, pr }; return { ...this.p }; }
    const R = this.k * 36, dx = x - this.p.x, dy = y - this.p.y, d = Math.hypot(dx, dy);
    if (d > R) { const t = (d - R) / d; this.p.x += dx * t; this.p.y += dy * t; }
    this.p.pr += (pr - this.p.pr) * (1 - this.k * 0.6);
    return { ...this.p };
  }
}

/** Points along a segment a->b (part-local) at spacing s, carrying the remainder from the last dab. */
export function spaced(a, b, s, carry) {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), out = [];
  let t = s - carry;
  if (d < 1e-9) return { pts: out, carry: carry + d };
  while (t <= d) { const u = t / d; out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, u]); t += s; }
  return { pts: out, carry: d - (t - s) };
}

/** Mirror a part-local point across the element's centre plane x = cx (element coordinates) and find the copy of the
 *  same part whose box contains it: { p, copy } or null. T: the part's instance transforms (16 per copy, column major). */
export function mirrorDab(p, copy, T, box, cx, r = 0) {
  const n = T ? T.length / 16 : 1, m = (k) => (T ? T.subarray(16 * k, 16 * k + 16) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const k0 = copy < 0 ? 0 : copy, M = m(k0);
  const w = [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]];
  w[0] = 2 * cx - w[0];
  for (let k = 0; k < n; k++) {
    const q = invApply(m(k), w);
    if (!q) continue;
    if (q[0] >= box[0] - r && q[0] <= box[3] + r && q[1] >= box[1] - r && q[1] <= box[4] + r && q[2] >= box[2] - r && q[2] <= box[5] + r) {
      return { p: q, copy: copy < 0 ? -1 : k };
    }
  }
  return null;
}
function invApply(M, w) {
  const a = M[0], b = M[4], c = M[8], d = M[1], e = M[5], f = M[9], g = M[2], h = M[6], i = M[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const x = w[0] - M[12], y = w[1] - M[13], z = w[2] - M[14];
  return [((e * i - f * h) * x - (b * i - c * h) * y + (b * f - c * e) * z) / det,
    (-(d * i - f * g) * x + (a * i - c * g) * y - (a * f - c * d) * z) / det,
    ((d * h - e * g) * x - (a * h - b * g) * y + (a * e - b * d) * z) / det];
}
