// The quality run: parse every prompt of a test library, compare with the gold fields, build the geometry and check it.
//   node arch/test/run.mjs [promptsFile=arch/test/prompts.json] [--label dev] [--no-geometry]
// Writes /Volumes/LaCie/morph3d/archkit/reports/<stamp>-<label>.json and .md; exits 1 when a gate fails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initKernel, ARCHKIT } from './node-kernel.mjs';
import { generate, FAMILY } from '../js/generate.js';
import { normalize } from '../js/spec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && !(i && args[i - 1] === '--label')) || path.join(here, 'prompts.json');
const label = (args.includes('--label') && args[args.indexOf('--label') + 1]) || path.basename(file, '.json');
const doGeom = !args.includes('--no-geometry');
const GATES = { fieldAcc: 0.95, oosRecall: 1.0, falseOos: 0, geomFail: 0, p95: 500, p95Assembly: 1500 };
const ASSEMBLY = new Set(['portico', 'arcade', 'balustrade', 'roof', 'dome']);

await initKernel();
const { prompts } = JSON.parse(fs.readFileSync(file, 'utf8'));
let parse = null;
try { ({ parse } = await import('../js/parse.js')); } catch (e) { console.log('parse.js not available:', e.message); }

const near = (a, b) => typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 0.01 * Math.max(1e-9, Math.abs(b)) : a === b;
const rows = [];
const fam = {};
for (const p of prompts) {
  const row = { id: p.id, cat: p.cat, lang: p.lang, text: p.text, fields: {}, errors: [] };
  const exp = p.expect || {};
  let res = null;
  if (parse) {
    const t0 = performance.now();
    try { res = parse(p.text); } catch (e) { row.errors.push('parse threw: ' + e.message); }
    row.parseMs = performance.now() - t0;
  }
  if (res) {
    row.interpretation = res.interpretation;
    row.outOfScope = !!res.outOfScope;
    for (const [k, v] of Object.entries(exp)) {
      if (k === 'why') continue;
      if (k === 'outOfScope') { row.fields[k] = { want: v, got: !!res.outOfScope, ok: !!res.outOfScope === v }; continue; }
      if (k === 'unknownIncludes') {
        const got = (res.unknown || []).map((w) => w.toLowerCase());
        row.fields[k] = { want: v, got, ok: v.every((w) => got.some((g) => g.includes(w.toLowerCase()))) };
        continue;
      }
      const got = res.spec ? res.spec[k] : undefined;
      row.fields[k] = { want: v, got, ok: near(got, v) };
    }
  }
  // geometry of in-scope prompts (the parsed spec, or the gold spec when the parser is missing)
  const inScope = !(exp.outOfScope);
  if (doGeom && inScope) {
    const spec = res && !res.outOfScope ? res.spec : (parse ? null : stripGold(exp));
    if (spec && spec.element && FAMILY[spec.element]) {
      try {
        const g = await generate(spec);
        row.geom = { element: g.spec.element, ms: g.ms, tris: g.tris, size: g.size, parts: g.parts.length };
        fam[g.spec.element] = true;
        const bad = g.parts.filter((q) => q.manifold.status() !== 'NoError' || !(q.manifold.volume() > 0)).map((q) => q.name);
        if (bad.length) row.errors.push('not manifold: ' + bad.join(','));
        const e = g.expected;
        if (e) {
          for (const [ax, i] of [['x', 0], ['y', 1], ['z', 2]]) if (e.size && e.size[ax] !== undefined) {
            const tol = e.tol ?? 0.005, want = e.size[ax], got = g.size[i];
            if (Math.abs(got - want) > tol * want + 0.002) row.errors.push(`size ${ax} ${got.toFixed(3)} vs ${want.toFixed(3)}`);
          }
          for (const [name, n] of Object.entries(e.counts || {})) {
            if (name === 'flutes') {
              const m = countFlutes(g.parts);
              if (m !== null && m !== n) row.errors.push(`flutes counted ${m} vs ${n}`);
              row.geom.flutes = m;
            } else {
              const prt = g.parts.find((q) => q.name === name);
              const got = prt ? (prt.transforms ? prt.transforms.length / 16 : 1) : 0;
              if (got !== n) row.errors.push(`count ${name} ${got} vs ${n}`);
            }
          }
        }
        const budget = ASSEMBLY.has(g.spec.element) ? GATES.p95Assembly : GATES.p95;
        if (g.ms > budget * 2) row.errors.push(`slow ${Math.round(g.ms)} ms`);
        if (g.tris > 2.5e6) row.errors.push(`heavy ${g.tris} tris`);
      } catch (e) {
        if (/Cannot find module|Failed to load|ERR_MODULE_NOT_FOUND/.test(e.message)) row.geomSkipped = 'family missing';
        else {
          row.errors.push('build threw: ' + e.message.split('\n')[0]);
          await initKernel(); // a WASM error can leave the module unusable: start a fresh one so failures do not cascade
        }
      }
    } else if (spec && spec.element) row.geomSkipped = 'no family';
  }
  rows.push(row);
}

function stripGold(exp) { const s = {}; for (const [k, v] of Object.entries(exp)) if (!['why', 'unknownIncludes', 'outOfScope'].includes(k)) s[k] = v; return s; }

/** Count flutes by slicing the shaft halfway up and counting minima of the radius around the section. */
function countFlutes(parts) {
  const shaft = parts.find((q) => q.name === 'shaft');
  if (!shaft) return null;
  const bb = shaft.manifold.boundingBox(), z = (bb.min[2] + bb.max[2]) / 2;
  const polys = shaft.manifold.slice(z).toPolygons();
  if (!polys.length) return null;
  const poly = polys.reduce((a, b) => (b.length > a.length ? b : a));
  const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2;
  // the contour is ordered around the section: count dips of the radius below the half-depth line
  const r = poly.map(([x, y]) => Math.hypot(x - cx, y - cy)), N = r.length;
  const rmax = Math.max(...r), rmin = Math.min(...r);
  if (rmax - rmin < 0.004 * rmax) return 0;
  const thr = rmin + 0.5 * (rmax - rmin);
  let count = 0, inside = r[N - 1] < thr;
  for (let i = 0; i < N; i++) { const now = r[i] < thr; if (now && !inside) count++; inside = now; }
  return count;
}

// ------------------------------------------------------------------------------------------------ summary
const inScope = rows.filter((r) => !(prompts.find((p) => p.id === r.id).expect || {}).outOfScope);
const oos = rows.filter((r) => (prompts.find((p) => p.id === r.id).expect || {}).outOfScope);
const fieldRows = inScope.flatMap((r) => Object.entries(r.fields).filter(([k]) => k !== 'outOfScope').map(([k, f]) => ({ k, ok: f.ok, cat: r.cat })));
const acc = (xs) => (xs.length ? xs.filter((x) => x.ok).length / xs.length : NaN);
const promptOk = (r) => Object.values(r.fields).every((f) => f.ok);
const byCat = {};
for (const r of rows) { (byCat[r.cat] ||= []).push(r); }
const geomRows = rows.filter((r) => r.geom || (r.errors.length && !r.geomSkipped));
const times = geomRows.filter((r) => r.geom).map((r) => r.geom.ms).sort((a, b) => a - b);
const pct = (xs, q) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(q * xs.length))] : NaN);
const summary = {
  file, label, when: new Date().toISOString(), prompts: rows.length, parser: !!parse,
  fieldAccuracy: acc(fieldRows), promptExact: acc(inScope.map((r) => ({ ok: promptOk(r) }))),
  oosRecall: acc(oos.map((r) => ({ ok: r.outOfScope === true }))),
  falseOos: inScope.filter((r) => r.outOfScope).length,
  byCategory: Object.fromEntries(Object.entries(byCat).map(([c, rs]) => [c, { n: rs.length, exact: acc(rs.map((r) => ({ ok: promptOk(r) }))), field: acc(rs.flatMap((r) => Object.values(r.fields))) }])),
  byField: Object.fromEntries([...new Set(fieldRows.map((f) => f.k))].map((k) => [k, acc(fieldRows.filter((f) => f.k === k))])),
  geometry: { built: times.length, failures: rows.filter((r) => r.errors.length).length, skipped: rows.filter((r) => r.geomSkipped).length,
    p50: pct(times, 0.5), p95: pct(times, 0.95), max: times[times.length - 1], families: Object.keys(fam) },
};
const gates = {
  fieldAccuracy: !parse || summary.fieldAccuracy >= GATES.fieldAcc,
  oosRecall: !parse || !oos.length || summary.oosRecall >= GATES.oosRecall,
  falseOos: !parse || summary.falseOos <= GATES.falseOos,
  geometry: summary.geometry.failures <= GATES.geomFail,
  speed: !(summary.geometry.p95 > GATES.p95Assembly),
};
summary.gates = gates;
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const outDir = path.join(ARCHKIT, 'reports');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${stamp}-${label}.json`), JSON.stringify({ summary, rows }, null, 1));
const f = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + ' %' : '–');
const md = [
  `# Arch Studio quality run — ${label} (${summary.when})`, '',
  `Prompts ${rows.length} · parser ${parse ? 'yes' : 'missing'} · field accuracy **${f(summary.fieldAccuracy)}** · prompts fully right **${f(summary.promptExact)}** · out-of-scope recall ${f(summary.oosRecall)} · false out-of-scope ${summary.falseOos}`,
  `Geometry: built ${summary.geometry.built}, failures ${summary.geometry.failures}, skipped ${summary.geometry.skipped}, build p50 ${Math.round(summary.geometry.p50)} ms, p95 ${Math.round(summary.geometry.p95)} ms, max ${Math.round(summary.geometry.max)} ms`,
  `Gates: ${Object.entries(gates).map(([k, v]) => `${k} ${v ? 'PASS' : 'FAIL'}`).join(' · ')}`, '',
  '| category | n | exact | field |', '|---|---|---|---|',
  ...Object.entries(summary.byCategory).map(([c, s]) => `| ${c} | ${s.n} | ${f(s.exact)} | ${f(s.field)} |`), '',
  '| field | accuracy |', '|---|---|', ...Object.entries(summary.byField).sort((a, b) => a[1] - b[1]).map(([k, a]) => `| ${k} | ${f(a)} |`), '',
  '## Failures', '',
  ...rows.filter((r) => !promptOk(r) || r.errors.length).map((r) => `- **${r.id}** "${r.text}" → ${r.interpretation || '–'}${Object.entries(r.fields).filter(([, x]) => !x.ok).map(([k, x]) => ` · ${k}: want ${JSON.stringify(x.want)} got ${JSON.stringify(x.got)}`).join('')}${r.errors.length ? ' · ' + r.errors.join('; ') : ''}`),
].join('\n');
fs.writeFileSync(path.join(outDir, `${stamp}-${label}.md`), md);
console.log(md.split('\n').slice(0, 6).join('\n'));
console.log(`report: ${path.join(outDir, `${stamp}-${label}.md`)}`);
process.exit(Object.values(gates).every(Boolean) ? 0 : 1);
