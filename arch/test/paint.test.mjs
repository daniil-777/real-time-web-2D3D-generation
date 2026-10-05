// paint.js unit tests (Node): hash grid, newest-first compositing, all copies vs this copy, erase, fill (and > 16 fills),
// remap on a size change, undo snapshots, element change, the live stroke (uniforms -> live grid -> commit), pressure
// ceiling, smoothing, spacing, mirror, bake + refinement, append-only rebuilds, dense layered painting (cells capped,
// the newest stroke always wins), grid build time.
import { Paint, CellTable, partGrid, cellAt, paintAt, bakeColors, refinePainted, remapper, Smoother, spaced, mirrorDab, hexToRgb, rgbToHex, hsvToRgb,
  rgbToHsv, exportData, fromData, perCopy, LIVE_MAX, CELL_CAP, hash3, packHF, partsOf, RECENT_STROKES } from '../js/paint.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const near = (a, b, e = 1e-4) => Math.abs(a - b) <= e;
const red = [0.8, 0.05, 0.02], blue = [0.02, 0.1, 0.7], green = [0.2, 0.6, 0.3];

// a unit cube part ("shaft", 1 copy) and a baluster part with 3 copies along x
const cube = { name: 'shaft', positions: new Float32Array([0, 0, 0, 1, 1, 1]), transforms: null };
const T = new Float32Array(48);
for (let k = 0; k < 3; k++) { const o = k * 16; T[o] = T[o + 5] = T[o + 10] = T[o + 15] = 1; T[o + 12] = k * 2; }
const bal = { name: 'baluster', positions: new Float32Array([-0.2, -0.2, 0, 0.2, 0.2, 1]), transforms: T };

// hash table: every key found, the same hash as the shader
const H = new CellTable(4);
for (let i = 0; i < 5000; i++) H.t[H.slot(i % 37, (i * 7) % 101, (i * 13) % 59) * 4 + 3]++;
let found = 0;
for (let i = 0; i < 5000; i++) if (H.find(i % 37, (i * 7) % 101, (i * 13) % 59) >= 0) found++;
ok(found === 5000 && H.used * 2 <= H.size, 'cell table: every key within the probe limit, at most half full');
ok(hash3(1, 2, 3) === ((Math.imul(1, 73856093) ^ Math.imul(2, 19349663) ^ Math.imul(3, 83492791)) >>> 0), 'hash3 is the shader hash');

const P = new Paint();
P.setParts([cube, bal], 'balustrade');
P.add({ id: 1, part: 'shaft', kind: 'paint', rgb: red, cap: 1, hard: 1, finish: 'matte', box: P.parts[0].box, dabs: [0.5, 0.5, 0.5, 0.1, 1, -1] });
let B = P.build();
let c = paintAt(B, 0, [0.5, 0.5, 0.55], 0);
ok(near(c[3], 1, 1e-3) && near(c[0], 0.8), 'a dab paints its centre fully');
ok(paintAt(B, 0, [0.5, 0.5, 0.75], 0)[3] < 1e-3, 'outside the dab: unpainted');
// erase
P.add({ id: 2, part: 'shaft', kind: 'erase', cap: 1, hard: 1, box: P.parts[0].box, dabs: [0.5, 0.5, 0.5, 0.05, 1, -1] });
B = P.build();
ok(B.dirty === 1, 'an appended stroke rebuilds only its part');
ok(paintAt(B, 0, [0.5, 0.5, 0.5], 0)[3] < 1e-3, 'erase removes the paint at its centre');
ok(paintAt(B, 0, [0.5, 0.5, 0.58], 0)[3] > 0.99, 'erase leaves the rest');
// paint over an erase shows again (order is respected)
P.add({ id: 3, part: 'shaft', kind: 'paint', rgb: blue, cap: 1, hard: 1, box: P.parts[0].box, dabs: [0.5, 0.5, 0.5, 0.02, 1, -1] });
B = P.build();
c = paintAt(B, 0, [0.5, 0.5, 0.5], 0);
ok(c[3] > 0.99 && near(c[2], 0.7), 'paint after an erase goes over it');
// opacity: a stroke builds up to its opacity only; flow 1: soft edges keep the dab profile (max, not union)
P.clear();
const dabs = [];
for (let i = 0; i < 40; i++) dabs.push(0.3 + i * 0.01, 0.5, 0.5, 0.05, 1, -1);
P.add({ id: 4, part: 'shaft', kind: 'paint', rgb: red, cap: 0.5, hard: 0.5, box: P.parts[0].box, dabs });
B = P.build();
ok(near(paintAt(B, 0, [0.5, 0.5, 0.5], 0)[3], 0.5, 1e-3), 'overlapping dabs of one stroke stop at the stroke opacity');
// pressure ceiling: a light pen stroke (p = 0.15) stays light however many dabs overlap
P.clear();
const light = [];
for (let i = 0; i < 40; i++) light.push(0.3 + i * 0.01, 0.5, 0.5, 0.05, 0.15, -1);
P.add({ id: 5, part: 'shaft', kind: 'paint', rgb: red, cap: 1, hard: 0.8, flow: 1, box: P.parts[0].box, dabs: light });
B = P.build();
ok(near(paintAt(B, 0, [0.5, 0.5, 0.5], 0)[3], 0.15, 0.01), 'pen pressure caps the dab opacity (light stroke stays light)');
// flow: builds up gradually but still reaches the stroke's opacity in the middle of a long stroke
P.clear();
P.add({ id: 6, part: 'shaft', kind: 'paint', rgb: red, cap: 1, hard: 0.8, flow: 0.2, box: P.parts[0].box, dabs });
B = P.build();
const fA = paintAt(B, 0, [0.5, 0.5, 0.5], 0)[3];
ok(fA > 0.75 && fA < 1.0001, `flow 20 % builds up over the overlapping dabs (${fA.toFixed(2)})`);
ok(packHF(0.6, 1) % 256 === 153 && Math.floor(packHF(0.6, 1) / 256) === 255, 'hardness and flow pack into one float');
// all copies vs this copy
P.clear();
P.add({ id: 7, part: 'baluster', kind: 'paint', rgb: red, cap: 1, hard: 1, box: P.parts[1].box, dabs: [0, 0, 0.5, 0.1, 1, -1] });
P.add({ id: 8, part: 'baluster', kind: 'paint', rgb: blue, cap: 1, hard: 1, box: P.parts[1].box, dabs: [0, 0, 0.8, 0.1, 1, 1] });
B = P.build();
ok(paintAt(B, 1, [0, 0, 0.5], 0)[3] > 0.99 && paintAt(B, 1, [0, 0, 0.5], 2)[3] > 0.99, 'all copies: every baluster takes the stroke');
ok(paintAt(B, 1, [0, 0, 0.8], 1)[3] > 0.99 && paintAt(B, 1, [0, 0, 0.8], 0)[3] < 1e-3, 'this copy: only copy 1');
ok(perCopy(P, 'baluster') && !perCopy(P, 'shaft'), 'perCopy');
// fill (all copies), paint over it
P.add({ id: 9, part: 'shaft', kind: 'fill', rgb: green, cap: 1, box: P.parts[0].box, dabs: [0, 0, 0, 0, 1, -1] });
B = P.build();
ok(paintAt(B, 0, [0.01, 0.99, 0.3], 0)[3] > 0.99 && near(paintAt(B, 0, [0.9, 0.1, 0.1], 0)[1], 0.6), 'fill covers the whole part');
P.add({ id: 10, part: 'shaft', kind: 'paint', rgb: red, cap: 1, hard: 1, box: P.parts[0].box, dabs: [0.5, 0.5, 0.5, 0.1, 1, -1] });
B = P.build();
ok(near(paintAt(B, 0, [0.5, 0.5, 0.5], 0)[0], 0.8), 'paint after a fill goes over it');
// more than 16 fills of single copies: none is lost
P.clear();
for (let k = 0; k < 3; k++) P.add({ id: 20 + k, part: 'baluster', kind: 'fill', rgb: [k / 3, 0.5, 0.5], cap: 1, box: P.parts[1].box, dabs: [0, 0, 0, 0, 1, k] });
for (let n = 0; n < 30; n++) P.add({ id: 30 + n, part: 'baluster', kind: 'fill', rgb: [0.1, 0.2, n / 30], cap: 1, box: P.parts[1].box, dabs: [0, 0, 0, 0, 1, 1] });
B = P.build();
ok(near(paintAt(B, 1, [0, 0, 0.5], 0)[0], 0) && near(paintAt(B, 1, [0, 0, 0.5], 2)[0], 2 / 3) && near(paintAt(B, 1, [0, 0, 0.5], 1)[2], 29 / 30),
  '> 16 fills: every copy keeps its own newest fill');
// undo snapshot
const snap = P.snapshot();
P.add({ id: 60, part: 'shaft', kind: 'erase', cap: 1, hard: 1, box: P.parts[0].box, dabs: [0.5, 0.5, 0.5, 0.2, 1, -1] });
P.build();
ok(P.restore(snap) && P.strokes.length === snap.strokes.length, 'a snapshot restores the stroke list');
B = P.build();
ok(B.dirty === 2, 'a restore (not an append) rebuilds every part');
// remap on a size change: the shaft doubles in height
P.clear();
P.add({ id: 61, part: 'shaft', kind: 'paint', rgb: red, cap: 1, hard: 1, box: P.parts[0].box, dabs: [0.5, 0.5, 0.9, 0.05, 1, -1] });
P.setParts([{ ...cube, positions: new Float32Array([0, 0, 0, 1, 1, 2]) }, bal], 'balustrade');
B = P.build();
ok(paintAt(B, 0, [0.5, 0.5, 1.8], 0)[3] > 0.99 && paintAt(B, 0, [0.5, 0.5, 0.9], 0)[3] < 1e-3, 'a resized part: the dab follows its box');
ok(remapper([0, 0, 0, 1, 1, 1], [0, 0, 0, 1, 1, 1]) === null, 'an unchanged part keeps its dabs exactly');
// another element clears
ok(P.setParts([cube], 'column') === 'cleared' && P.strokes.length === 0, 'another element clears the paint');
// live stroke: uniforms spill into the live grid, the commit makes one stroke per part
P.setParts([cube, bal], 'column');
P.beginLive({ id: 70, kind: 'paint', rgb: red, cap: 1, hard: 0.5, finish: 'gloss' }, 0.03, [0, 0, 0]);
let spilled = false;
for (let i = 0; i < LIVE_MAX + 5; i++) spilled = P.pushLive('shaft', [0.1 + i * 0.01, 0.5, 0.5], 0.03, 1, -1) || spilled;
ok(spilled && P.live.n === 5 && P.live.grid.n === LIVE_MAX && P.strokes.length === 0, 'live: the uniforms spill into the live grid, nothing is committed yet');
// the live grid's lists are newest first and reach every dab
const g = P.live.grid, gx = Math.floor((0.3 - g.origin[0]) / g.cell), gy = Math.floor((0.5 - g.origin[1]) / g.cell), gz = Math.floor((0.5 - g.origin[2]) / g.cell);
const sl = g.T.find(gx, gy, gz);
let e = sl >= 0 ? g.T.t[sl * 4 + 2] : 0, prev = Infinity, walked = 0, mono = true;
while (e) { const d = g.ent[(e - 1) * 2]; if (d > prev) mono = false; prev = d; walked++; e = g.ent[(e - 1) * 2 + 1]; }
ok(walked > 0 && mono, 'live grid: a cell lists its dabs newest first');
P.pushLive('baluster', [0, 0, 0.5], 0.03, 1, 2);
const out = P.commitLive();
ok(out.length === 2 && P.strokes.length === 2 && P.strokes.every((s) => s.id === 70) && P.live.n === 0 && P.live.grid.n === 0, 'the commit makes one stroke per part (one id)');
// smoothing and spacing
const sm = new Smoother(0.5);
sm.push(0, 0, 1);
ok(sm.push(10, 0, 1).x === 0, 'StreamLine: a short pull does not move the brush');
ok(near(sm.push(40, 0, 1).x, 40 - 18), 'a long pull drags it at the string length');
const sp = spaced([0, 0, 0], [1, 0, 0], 0.25, 0);
ok(sp.pts.length === 4 && near(sp.carry, 0), 'dab spacing along the segment');
// mirror: copy 0 at x=0 mirrors to copy 2 at x=4 across cx=2
const m = mirrorDab([0.1, 0, 0.5], 0, T, P.parts[1].box, 2);
ok(m && m.copy === 2 && near(m.p[0], -0.1), 'symmetry finds the mirrored copy');
// colour
ok(rgbToHex(hexToRgb('#9b2d20')) === '#9b2d20', 'hex round trip');
ok(rgbToHex(hsvToRgb(...rgbToHsv(hexToRgb('#24408e')))) === '#24408e', 'hsv round trip');
// bake + export data round trip
P.clear();
P.add({ id: 80, part: 'shaft', kind: 'fill', rgb: [1, 0, 0], cap: 1, box: P.parts[0].box, dabs: [0, 0, 0, 0, 1, -1] });
const P2 = fromData(structuredClone(exportData(P)));
const col = bakeColors(P2.build(), 0, cube.positions, 0, [0.5, 0.5, 0.5]);
ok(col && near(col[0], 1) && near(col[1], 0), 'bake: vertex colours carry the paint');
ok(bakeColors(P2.build(), 1, bal.positions, 0, [0.5, 0.5, 0.5]) === null, 'bake: an unpainted part has no colours');
// refinement: a 2 cm dab in the middle of a 2 m square of two triangles is kept by the export
{
  const Q = new Paint();
  const sq = { name: 'face', positions: new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
  Q.setParts([sq], 'pedestal');
  Q.add({ id: 1, part: 'face', kind: 'paint', rgb: red, cap: 1, hard: 0.8, box: Q.parts[0].box, dabs: [0.31, 0, 0.27, 0.02, 1, -1] });
  const QB = Q.build(), plain = bakeColors(QB, 0, sq.positions, 0, [0.5, 0.5, 0.5]);
  ok(plain === null, 'without refinement the dab between the vertices is lost');
  const rm = refinePainted(sq, QB, 0, 0, [0.5, 0.5, 0.5]);
  let best = -1, bd = Infinity;
  for (let v = 0; v < rm.positions.length / 3; v++) { const d = Math.hypot(rm.positions[v * 3] - 0.31, rm.positions[v * 3 + 1], rm.positions[v * 3 + 2] - 0.27); if (d < bd) { bd = d; best = v; } }
  ok(rm && bd < 0.012 && near(rm.colors[best * 4], 0.8, 0.08) && rm.positions.length / 3 < 4000, `refined export keeps the dab (nearest vertex ${(bd * 100).toFixed(1)} cm, ${rm.positions.length / 3} vertices)`);
}
// dense layered painting: a long stroke, then 40 ring strokes in one 10 cm band of a 3 m shaft, 4 cm brush
{
  const Q = new Paint();
  const shaft = { name: 'shaft', positions: new Float32Array([-0.22, -0.22, 0, 0.22, 0.22, 3]) };
  Q.setParts([shaft], 'column');
  const ring = (z, n = 280) => { const d = []; for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; d.push(Math.cos(a) * 0.22, Math.sin(a) * 0.22, z, 0.02, 1, -1); } return d; };
  const line = []; for (let z = 0; z < 3; z += 0.005) line.push(0, -0.22, z, 0.02, 1, -1);
  Q.add({ id: 1, part: 'shaft', kind: 'paint', rgb: green, cap: 1, hard: 0.6, box: Q.parts[0].box, dabs: line });
  for (let k = 0; k < 40; k++) Q.add({ id: 2 + k, part: 'shaft', kind: 'paint', rgb: [k / 40, 0.3, 0.3], cap: 1, hard: 0.6, box: Q.parts[0].box, dabs: ring(1.5 + ((k * 7) % 10) / 100) });
  const t0 = performance.now(), QB = Q.build(), ms = performance.now() - t0;
  console.log(`dense band: ${QB.dabs} dabs, max ${QB.stats.maxPerCell} per cell before the cap, mean ${QB.stats.meanPerCell.toFixed(1)} kept, ${ms.toFixed(1)} ms`);
  ok(QB.stats.meanPerCell <= CELL_CAP, 'cells keep at most CELL_CAP entries');
  // the newest ring is visible all around its centre line
  const zN = 1.5 + ((39 * 7) % 10) / 100;
  let vis = 0;
  for (let i = 0; i < 64; i++) { const a = (i / 64) * Math.PI * 2, c2 = paintAt(QB, 0, [Math.cos(a) * 0.22, Math.sin(a) * 0.22, zN], 0); if (near(c2[0], 39 / 40, 0.02)) vis++; }
  ok(vis === 64, `the newest stroke shows everywhere along the band (${vis}/64)`);
  // and an eraser there works
  Q.add({ id: 99, part: 'shaft', kind: 'erase', cap: 1, hard: 0.9, box: Q.parts[0].box, dabs: ring(zN) });
  const QE = Q.build();
  let er = 0;
  for (let i = 0; i < 64; i++) { const a = (i / 64) * Math.PI * 2; if (paintAt(QE, 0, [Math.cos(a) * 0.22, Math.sin(a) * 0.22, zN], 0)[3] < 0.01) er++; }
  ok(er === 64, `the eraser works in the dense band (${er}/64)`);
}
// grid build time: 20k dabs (warm), and an appended stroke after it
{
  const Q = new Paint();
  Q.setParts([cube], 'x');
  const many = [];
  for (let i = 0; i < 20000; i++) many.push(Math.random(), Math.random(), Math.random(), 0.02 + Math.random() * 0.02, 1, -1);
  Q.add({ id: 1, part: 'shaft', kind: 'paint', rgb: red, cap: 1, hard: 0.5, box: Q.parts[0].box, dabs: many });
  Q.build(); Q.clearCache();
  const t0 = performance.now();
  const QB = Q.build();
  const ms = performance.now() - t0;
  console.log(`grid build, 20k dabs: ${ms.toFixed(2)} ms (${QB.stats.kept} entries, ${QB.stats.cells} cells)`);
  ok(ms < 12, 'grid build for 20k dabs (Node)');
  // a cell lookup agrees with a brute-force list
  const p = [0.5, 0.5, 0.5], [st, cnt] = cellAt(QB, 0, p);
  let brute = 0;
  for (let i = 0; i < 20000; i++) { const o = i * 6; if (Math.hypot(many[o] - p[0], many[o + 1] - p[1], many[o + 2] - p[2]) <= many[o + 3]) brute++; }
  let inCell = 0;
  for (let i = 0; i < cnt; i++) { const o = QB.idx[st + i] * 12; if (Math.hypot(QB.dab[o] - p[0], QB.dab[o + 1] - p[1], QB.dab[o + 2] - p[2]) <= QB.dab[o + 3]) inCell++; }
  ok(inCell === Math.min(brute, CELL_CAP) || (cnt === CELL_CAP && inCell <= brute), `the cell lists every dab that reaches the point (${inCell}/${brute})`);
}
// partGrid on its own
{
  const D = new Float32Array(24); D[3] = 0.1; D[12] = 0.5; D[15] = 0.1;
  const gr = partGrid(D, [0, 1]);
  ok(gr.items.length >= 2 && gr.cells >= 2, 'partGrid lists the dabs');
}


// ---------------------------------------------------------------- fix round 2: flattened field (no visible paint is capped away)
{
  const wall = { name: 'wall', positions: new Float32Array([0, -0.1, 0, 2, 0.1, 2]) };
  const line = (z, r = 0.02, x0 = 0, x1 = 2) => { const d = []; for (let x = x0; x <= x1 + 1e-9; x += r / 4) d.push(x, 0, z, r, 1, -1); return d; };
  // the reviewers' glaze case: an opaque red coat, then 20 coats at 10 % over it: the red still shows through
  const Q = new Paint(); Q.setParts([wall], 'wall');
  Q.add({ id: 1, part: 'wall', kind: 'paint', rgb: red, cap: 1, hard: 0.6, box: Q.parts[0].box, dabs: line(1.0, 0.04) });
  for (let k = 0; k < 20; k++) Q.add({ id: 2 + k, part: 'wall', kind: 'paint', rgb: blue, cap: 0.1, hard: 0.6, box: Q.parts[0].box, dabs: line(1.0, 0.04) });
  const QB = Q.build();
  const c = paintAt(QB, 0, [1, 0, 1.0], 0), expectRed = 0.8 * Math.pow(0.9, 20) + 0.02 * (1 - Math.pow(0.9, 20));
  ok(Math.abs(c[0] - expectRed) < 0.02 && c[3] > 0.99, `glaze: opaque red + 20 coats at 10 % keeps the red (r ${c[0].toFixed(3)} vs ${expectRed.toFixed(3)})`);
  // 60 coats: flattened (RECENT_STROKES exceeded), same answer
  const Q2 = new Paint(); Q2.setParts([wall], 'wall');
  Q2.add({ id: 1, part: 'wall', kind: 'paint', rgb: red, cap: 1, hard: 0.6, box: Q2.parts[0].box, dabs: line(1.0, 0.04) });
  for (let k = 0; k < 60; k++) Q2.add({ id: 2 + k, part: 'wall', kind: 'paint', rgb: blue, cap: 0.1, hard: 0.6, box: Q2.parts[0].box, dabs: line(1.0, 0.04) });
  const QB2 = Q2.build(), c2 = paintAt(QB2, 0, [1, 0, 1.0], 0), e2 = 0.8 * Math.pow(0.9, 60) + 0.02 * (1 - Math.pow(0.9, 60));
  ok(QB2.F > 0 && Math.abs(c2[0] - e2) < 0.02 && c2[3] > 0.99, `glaze, 60 coats, ${QB2.F} flattened: red ${c2[0].toFixed(3)} vs ${e2.toFixed(3)}`);
  // adjacent lines: an opaque 4 cm line, then 30 newer lines 2.25 cm beside it: the older line stays everywhere
  const Q3 = new Paint(); Q3.setParts([wall], 'wall');
  Q3.add({ id: 1, part: 'wall', kind: 'paint', rgb: red, cap: 1, hard: 0.6, box: Q3.parts[0].box, dabs: line(1.0) });
  for (let k = 0; k < 30; k++) Q3.add({ id: 2 + k, part: 'wall', kind: 'paint', rgb: blue, cap: 1, hard: 0.6, box: Q3.parts[0].box, dabs: line(1.0225) });
  const QB3 = Q3.build();
  let lost = 0;
  for (let x = 0.2; x <= 1.8; x += 0.01) { const q = paintAt(QB3, 0, [x, 0, 1.0], 0); if (q[3] < 0.5 || q[0] < 0.5) lost++; }
  ok(lost === 0, `adjacent lines: the older line is kept at every point (${lost} lost; ${QB3.F} strokes flattened)`);
  // census: no cell-shaped blocks along the line (the colour is the same at every sample along x)
  let minR = 1, maxR = 0;
  for (let x = 0.2; x <= 1.8; x += 0.003) { const q = paintAt(QB3, 0, [x, 0, 0.998], 0); minR = Math.min(minR, q[0] * q[3]); maxR = Math.max(maxR, q[0] * q[3]); }
  ok(maxR - minR < 0.08, `no blocks: the red along the line varies by ${(maxR - minR).toFixed(3)}`);
  // undo past the flatten: the earlier field state is reused (no re-flatten), the stroke list decides
  const snapA = Q3.snapshot();
  Q3.add({ id: 99, part: 'wall', kind: 'paint', rgb: green, cap: 1, hard: 0.6, box: Q3.parts[0].box, dabs: line(1.0) });
  for (let k = 0; k < 30; k++) Q3.add({ id: 100 + k, part: 'wall', kind: 'paint', rgb: blue, cap: 0.3, hard: 0.6, box: Q3.parts[0].box, dabs: line(0.5) });
  Q3.build();
  Q3.restore(snapA);
  const t0 = performance.now(), QB4 = Q3.build(), ms = performance.now() - t0, c4 = paintAt(QB4, 0, [1, 0, 1.0], 0);
  ok(c4[0] > 0.7 && ms < 30, `undo past a flatten restores the earlier field cheaply (${ms.toFixed(1)} ms, red ${c4[0].toFixed(2)})`);
  // exact strokes stay bounded: the dab texture never exceeds the texture limit
  ok(QB3.rows.dab < 4096 && QB3.field.rows <= 4096, `texture rows within 4096 (dabs ${QB3.rows.dab}, field ${QB3.field.rows})`);
}
// one part per mesh: same-named meshes get their own keys
{
  const ps = partsOf([{ name: 'dentil', positions: new Float32Array(6) }, { name: 'dentil', positions: new Float32Array(6) }, { name: 'cornice', positions: new Float32Array(6) }]);
  ok(ps.map((p) => p.name).join() === 'dentil,dentil#2,cornice', 'same-named meshes are separate paint parts');
}
// a 1M-dab flattened history: built once, then the exact strokes on top stay cheap
{
  const shaft = { name: 'shaft', positions: new Float32Array([-0.25, -0.25, 0, 0.25, 0.25, 3]) };
  const Q = new Paint(); Q.setParts([shaft], 'column');
  let id = 1;
  for (let k = 0; k < 250; k++) {
    const d = [];
    for (let i = 0; i < 4000; i++) { const a = Math.random() * Math.PI * 2, z = Math.random() * 3; d.push(Math.cos(a) * 0.25, Math.sin(a) * 0.25, z, 0.02, 1, -1); }
    Q.strokes.push(Object.freeze({ id: id++, part: 'shaft', kind: 'paint', rgb: [k / 250, 0.3, 0.3], cap: 1, hard: 0.6, flow: 1, finish: 'matte', box: Q.parts[0].box, dabs: Float32Array.from(d) }));
  }
  const t0 = performance.now(), QB = Q.build(), ms = performance.now() - t0;
  console.log(`1M flattened dabs: ${ms.toFixed(0)} ms, ${QB.field.bricks} bricks (${QB.field.rows} rows), exact ${QB.dabs} dabs`);
  ok(QB.field.rows <= 4096 && QB.dabs <= 20000, `1M dabs: the field fits a 4096-row texture (${QB.field.rows} rows), ${QB.dabs} exact dabs`);
  Q.add({ id: id++, part: 'shaft', kind: 'paint', rgb: red, cap: 1, hard: 0.6, box: Q.parts[0].box, dabs: [0.25, 0, 1.5, 0.03, 1, -1] });
  const t1 = performance.now(), QBn = Q.build(), ms1 = performance.now() - t1;
  ok(ms1 < 40 && paintAt(QBn, 0, [0.25, 0, 1.5], 0)[0] > 0.75, `a new stroke over a 1M-dab history: ${ms1.toFixed(1)} ms, and it shows`);
}
// the export: refined only where the colour changes, watertight across a crease (no T-junctions)
{
  // a box with split (creased) corners: 6 faces x 4 vertices, a long 4 m face with a narrow 2 cm stroke across it
  const W = 4, H = 0.5;
  const faces = [[[0, 0, 0], [W, 0, 0], [W, 0, H], [0, 0, H]], [[W, 0, 0], [W, 0.5, 0], [W, 0.5, H], [W, 0, H]], [[W, 0.5, 0], [0, 0.5, 0], [0, 0.5, H], [W, 0.5, H]],
    [[0, 0.5, 0], [0, 0, 0], [0, 0, H], [0, 0.5, H]], [[0, 0, H], [W, 0, H], [W, 0.5, H], [0, 0.5, H]], [[0, 0.5, 0], [W, 0.5, 0], [W, 0, 0], [0, 0, 0]]];
  const pos = [], idx = [], nrm = [];
  faces.forEach((f, i) => { const b = i * 4; for (const p of f) pos.push(...p); const u = f[1].map((x, a) => x - f[0][a]), v = f[3].map((x, a) => x - f[0][a]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n); for (let k = 0; k < 4; k++) nrm.push(n[0] / l, n[1] / l, n[2] / l); idx.push(b, b + 1, b + 2, b, b + 2, b + 3); });
  const box = { name: 'rail', positions: new Float32Array(pos), normals: new Float32Array(nrm), indices: new Uint32Array(idx) };
  const Q = new Paint(); Q.setParts([box], 'rail');
  const d = []; for (let z = 0; z <= H; z += 0.0025) d.push(1.37, 0, z, 0.01, 1, -1);
  Q.add({ id: 1, part: 'rail', kind: 'paint', rgb: red, cap: 1, hard: 0.8, box: Q.parts[0].box, dabs: d });
  const QB = Q.build(), rm = refinePainted(box, QB, 0, 0, [0.5, 0.5, 0.5]);
  // narrow stroke kept: a vertex near its centre line carries its colour
  let best = Infinity, bc = null;
  for (let v = 0; v < rm.positions.length / 3; v++) { const dd = Math.hypot(rm.positions[v * 3] - 1.37, rm.positions[v * 3 + 1], rm.positions[v * 3 + 2] - 0.25); if (dd < best) { best = dd; bc = rm.colors[v * 4]; } }
  ok(best < 0.006 && Math.abs(bc - 0.8) < 0.1, `a 2 cm stroke across a 4 m face is kept (nearest vertex ${(best * 1000).toFixed(1)} mm, red ${bc.toFixed(2)})`);
  ok(rm.positions.length / 3 < 8000, `refined only where the colour changes (${rm.positions.length / 3} vertices from 24)`);
  // watertight: every welded edge is shared by exactly two triangles
  const key = (v) => `${Math.round(rm.positions[v * 3] * 1e6)},${Math.round(rm.positions[v * 3 + 1] * 1e6)},${Math.round(rm.positions[v * 3 + 2] * 1e6)}`;
  const edges = new Map();
  for (let t = 0; t < rm.indices.length; t += 3) for (let e = 0; e < 3; e++) { const a = key(rm.indices[t + e]), b = key(rm.indices[t + (e + 1) % 3]), k = a < b ? a + '|' + b : b + '|' + a; edges.set(k, (edges.get(k) || 0) + 1); }
  let bad = 0; for (const n of edges.values()) if (n !== 2) bad++;
  ok(bad === 0, `the refined part stays watertight across its creases (${bad} unpaired edges of ${edges.size})`);
}

console.log(`${pass}/${pass + fail} paint checks passed`);
if (fail) process.exit(1);
