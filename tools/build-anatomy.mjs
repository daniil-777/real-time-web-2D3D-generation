// tools/build-anatomy.mjs — builds the public copy of VISCERA Studio (the anatomy app) into anatomy/, which the site
// deploys as is (build.mjs copies it into _site/anatomy/; it is committed, since the studio's sources live in the
// viscera/ workspace next to this repository and not in git).
//   node tools/build-anatomy.mjs [--api http://127.0.0.1:8000] [--keep-specimens]
// What it does:
//   1. asks the running VISCERA API for the atlas catalogue and renders the reference specimen of every template with
//      default controls — the public copy has no API, so these are what it shows (static/api/atlas/, gzipped JSON);
//      --keep-specimens reuses the ones already in anatomy/static/ (no API needed)
//   2. builds the studio with Vite for a relative base ("./": it sits at any path) and without source maps
//   3. compresses the whole-body atlas (19 MB → a few MB: quantized, meshopt-encoded; tools/compress-glb.mjs)
//   4. writes anatomy/build.json, and swaps the whole tree into anatomy/ in one move (built outside the repository first:
//      the folder is iCloud-synced, and files replaced while it uploads them come back as "name 2" conflict copies)
// Start the API first from viscera/: `npm run api` (or the python -m uvicorn line in docs/WEB_DEPLOYMENT.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compressGlb } from './compress-glb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VISCERA = path.join(ROOT, 'viscera');
const FINAL = path.join(ROOT, 'anatomy');
// everything is written outside the repository first (it sits in an iCloud folder, which turns files replaced while
// it uploads them into "name 2" conflict copies), then swapped in as one directory
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'anatomy-build-'));
const OUT = path.join(WORK, 'anatomy');
const STATIC = path.join(OUT, 'static', 'api', 'atlas');
const FINAL_STATIC = path.join(FINAL, 'static', 'api', 'atlas');
const conflictCopy = (name) => / \d+(\.[\w.]+)?$/.test(name);   // "x 2.json.gz": what iCloud leaves behind
const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
const API = (opt.api || process.env.VISCERA_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
const t0 = Date.now();

for (const p of ['apps/studio/vite.config.ts', 'node_modules/vite/bin/vite.js', 'apps/studio/public/anatomy-scene/bodyparts3d-torso.glb'])
  if (!fs.existsSync(path.join(VISCERA, p))) throw new Error(`viscera/${p} is missing: the studio workspace (with its node_modules) must sit next to this repository`);

// ---- 1. the catalogue and the reference specimens, from the API
let specimens;
const keep = path.join(WORK, 'keep');
if (opt['keep-specimens']) {
  if (!fs.existsSync(FINAL_STATIC)) throw new Error('--keep-specimens: anatomy/static/api/atlas does not exist yet');
  fs.cpSync(FINAL_STATIC, keep, { recursive: true, filter: (p) => !conflictCopy(path.basename(p)) });
  specimens = fs.readdirSync(path.join(keep, 'specimens')).length;
  console.log(`keeping ${specimens} bundled specimens`);
} else {
  const health = await fetch(`${API}/api/health`).then((r) => r.ok, () => false);
  if (!health) throw new Error(`no VISCERA API at ${API}: start it from viscera/ (npm run api), or pass --keep-specimens`);
  const catalog = await fetch(`${API}/api/atlas/catalog`).then((r) => { if (!r.ok) throw new Error(`catalog: HTTP ${r.status}`); return r.json(); });
  if (!Array.isArray(catalog.organs) || !Array.isArray(catalog.controls)) throw new Error('the catalogue has no organs or controls');
  fs.mkdirSync(path.join(keep, 'specimens'), { recursive: true });
  fs.writeFileSync(path.join(keep, 'catalog.json'), JSON.stringify(catalog));
  specimens = 0;
  const unavailable = [];
  for (const organ of catalog.organs) for (const template of organ.templates) {
    // the same spec the studio's defaultAtlasSpec() builds (apps/studio/src/atlas.ts): the API's answer must equal it
    const spec = { ...(catalog.renderer_version ? { renderer_version: catalog.renderer_version } : {}), template_id: template.id, seed: 42,
      controls: Object.fromEntries(catalog.controls.map((c) => [c.key, c.default])), appearance: 'tissue',
      ...(catalog.materials ? { material: { ...catalog.materials.defaults[organ.id] } } : {}) };
    const r = await fetch(`${API}/api/atlas/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
    if (r.status === 422) {   // a template the API itself refuses (its QA gate): the studio says so when picked
      const detail = (await r.text()).slice(0, 200);
      unavailable.push({ id: template.id, detail });
      console.log(`  ${template.id.padEnd(32)} not rendered: ${detail}`);
      continue;
    }
    if (!r.ok) throw new Error(`${template.id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const text = await r.text();
    const result = JSON.parse(text);
    if (!result.scene || !result.spec || result.spec.template_id !== template.id) throw new Error(`${template.id}: unexpected answer`);
    const gz = zlib.gzipSync(text, { level: 9 });
    fs.writeFileSync(path.join(keep, 'specimens', `${template.id}.json.gz`), gz);
    specimens++;
    console.log(`  ${template.id.padEnd(32)} ${mb(text.length)} → ${mb(gz.length)} gz · ${result.summary?.triangles ?? '?'} triangles`);
  }
  fs.writeFileSync(path.join(keep, 'unavailable.json'), JSON.stringify(unavailable, null, 2) + '\n');
}

// ---- 2. the studio, built for a relative base, without source maps
const r = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'apps/studio/vite.config.ts', '--outDir', OUT, '--emptyOutDir'],
  { cwd: VISCERA, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, VISCERA_BASE: './', VISCERA_SOURCEMAP: '0' } });
if (r.status !== 0) { console.error(r.stdout, r.stderr); throw new Error('vite build failed'); }
console.log(r.stdout.split('\n').filter((l) => /\.js|\.css|built in/.test(l) && !/woff/.test(l)).join('\n'));
if (fs.readdirSync(path.join(OUT, 'assets')).some((f) => f.endsWith('.map'))) throw new Error('source maps were written');
for (const f of ['index.html', 'default-scene.json', 'anatomy-scene/bodyparts3d-torso.glb', 'anatomy-scene/manifest.json', 'body-reference/catalog.json'])
  if (!fs.existsSync(path.join(OUT, f))) throw new Error(`anatomy/${f} missing after the build`);
fs.mkdirSync(path.dirname(STATIC), { recursive: true });
fs.cpSync(keep, STATIC, { recursive: true });

// ---- 3. the whole-body atlas, compressed
const glb = path.join(OUT, 'anatomy-scene', 'bodyparts3d-torso.glb'), tmp = glb.replace(/\.glb$/, '.compressed.glb');   // the writer picks the format by extension
const c = await compressGlb(glb, tmp);
fs.renameSync(tmp, glb);
if (c.bytesOut < 1e6 || c.bytesOut > c.bytesIn) throw new Error(`the compressed atlas is ${c.bytesOut} bytes: not plausible`);
console.log(`atlas ${mb(c.bytesIn)} → ${mb(c.bytesOut)} (${c.meshes} meshes, ${c.extensions.join(' ')})`);

// ---- 4. the stamp, then the swap into the repository
let files = 0, bytes = 0;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (conflictCopy(e.name)) throw new Error(`conflict copy in the build: ${p}`); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } } };
walk(OUT);
const vite = JSON.parse(fs.readFileSync(path.join(VISCERA, 'node_modules/vite/package.json'), 'utf8')).version;
const unavailable = JSON.parse(fs.readFileSync(path.join(STATIC, 'unavailable.json'), 'utf8')).map((u) => u.id);
fs.writeFileSync(path.join(OUT, 'build.json'), JSON.stringify({ builtAt: new Date().toISOString(), vite, specimens, unavailable, atlasBytes: c.bytesOut, files, bytes }, null, 2) + '\n');
fs.rmSync(FINAL, { recursive: true, force: true });
try { fs.renameSync(OUT, FINAL); } catch (e) { fs.cpSync(OUT, FINAL, { recursive: true }); }
fs.rmSync(WORK, { recursive: true, force: true });
const left = []; const scan = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (conflictCopy(e.name)) left.push(path.join(d, e.name)); if (e.isDirectory()) scan(path.join(d, e.name)); } }; scan(FINAL);
if (left.length) throw new Error(`conflict copies appeared in anatomy/ (iCloud): ${left.slice(0, 3).join(', ')}… — wait for the folder to sync and run again`);
console.log(`anatomy/: ${files} files, ${mb(bytes)}, ${specimens} specimens, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
