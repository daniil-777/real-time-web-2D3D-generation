#!/usr/bin/env node
// build.mjs — assembles the deployable site in _site/ (what GitHub Pages serves; .github/workflows/deploy.yml runs it
// on every push to main):
//   node build.mjs            build
//   node build.mjs --serve    build, then serve _site at http://127.0.0.1:8123/ (tools/serve.mjs)
// The sources stay runnable as they are (arch/index.html loads arch/js/*.js and takes three.js and the CAD kernel from
// the CDN). Only the built tree is bundled: Arch Studio's thirty modules, three.js, N8AO and the kernel become a few
// minified, content-hashed files on this one origin (no import map, no third-party host), the 3D objects app's
// thirteen scripts one file, and each page's HTML is rewritten to point at them — a rewrite that fails loudly if the
// markup it expects has moved.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, '_site');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const write = (p, data) => { fs.mkdirSync(path.dirname(path.join(OUT, p)), { recursive: true }); fs.writeFileSync(path.join(OUT, p), data); };
const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(1).padStart(7) + ' KB';

// never deployed: editor and agent droppings, archives, databases
const SKIP = /(^|[\\/])(\._[^\\/]*|\.DS_Store|\.claude-flow|\.pytest_cache|agentdb\.rvf[^\\/]*|ruvector\.db|[^\\/]*\.zip)$/;
function copy(relPath) {
  const src = path.join(ROOT, relPath);
  if (!fs.existsSync(src)) throw new Error(`missing: ${relPath}`);
  fs.cpSync(src, path.join(OUT, relPath), { recursive: true, filter: (p) => !SKIP.test(p) });
}
/** Replace exactly one occurrence, or fail: a page whose markup moved must not deploy half-rewritten. */
function replaceOnce(html, from, to, what) {
  const i = html.indexOf(from);
  if (i < 0) throw new Error(`${what}: "${from.slice(0, 70)}" not found`);
  if (html.indexOf(from, i + from.length) >= 0) throw new Error(`${what}: "${from.slice(0, 70)}" found twice`);
  return html.slice(0, i) + to + html.slice(i + from.length);
}
function cutOnce(html, re, what) {
  if (!re.test(html)) throw new Error(`${what}: ${re} not found`);
  return html.replace(re, '');
}

const t0 = Date.now();
const report = [];
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT);

// ---------------------------------------------------------------------------------------- the site shell, the drawings
copy('index.html');
copy('.nojekyll');
for (const p of ['pixel-morph/index.html', 'pixel-morph/pixel-morph.html', 'pixel-morph/audio', 'pixel-morph/model', 'pixel-morph/model-hq', 'pixel-morph/model-ultra', 'pixel-morph/samples']) copy(p);

// ---------------------------------------------------------------------------------------- the 3D objects app
// thirteen classic scripts, each an IIFE sharing only window.* with the others: one minified file, same order
{
  let html = read('morph3d/index.html');
  const tags = [...html.matchAll(/<script src="(m3d-[\w-]+\.js)"><\/script>\n/g)];
  if (tags.length < 10) throw new Error(`morph3d/index.html: expected the m3d-*.js script tags, found ${tags.length}`);
  const parts = tags.map((m) => read('morph3d/' + m[1]));
  const src = parts.map((s, i) => `// ---- ${tags[i][1]}\n${s}`).join('\n;\n');
  const { code } = await esbuild.transform(src, { minify: true, target: 'es2022', legalComments: 'none', logLevel: 'warning' });
  html = replaceOnce(html, tags[0][0], '<script src="m3d.min.js"></script>\n', 'morph3d/index.html');
  for (const m of tags.slice(1)) html = replaceOnce(html, m[0], '', 'morph3d/index.html');
  write('morph3d/index.html', html);
  write('morph3d/m3d.min.js', code);
  for (const d of fs.readdirSync(path.join(ROOT, 'morph3d'))) if (/^model(-[\w-]+)?$/.test(d) || d === 'clip-laion-b32') copy('morph3d/' + d);
  report.push(['morph3d/m3d.min.js', code.length, gz(code), `${tags.length} scripts, ${kb(parts.reduce((s, p) => s + p.length, 0)).trim()} of source`]);
}

// ---------------------------------------------------------------------------------------- Arch Studio
// bundled with esbuild, split as the sources are (the viewer, the parser, each generator family and the ambient
// occlusion stay lazy chunks); three.js and N8AO come from node_modules, the CAD kernel is served from here
{
  const r = await esbuild.build({
    absWorkingDir: ROOT, entryPoints: ['arch/js/app.js', 'arch/js/worker.js'], outdir: '_site/arch/dist',
    bundle: true, format: 'esm', splitting: true, minify: true, sourcemap: true, target: ['es2022'],
    metafile: true, legalComments: 'linked', logLevel: 'warning',
    alias: { postprocessing: './tools/postprocessing-stub.js' },
    define: { ARCH_KERNEL_BASE: JSON.stringify('../vendor/manifold-3d/') },
  });
  const outputs = r.metafile.outputs;
  const app = '_site/arch/dist/app.js', worker = '_site/arch/dist/worker.js';
  for (const k of [app, worker]) if (!outputs[k]) throw new Error(`esbuild wrote no ${k}`);
  // what the first screen needs, in the order it is needed, preloaded from the page's head: the app and its static
  // chunks (otherwise found only once app.js has arrived), the worker's, then the viewer (with three.js), the parser
  // and the ambient occlusion, which the app imports lazily but always
  const statics = (k, acc = []) => { for (const i of outputs[k].imports) if (i.kind === 'import-statement' && !acc.includes(i.path)) { acc.push(i.path); statics(i.path, acc); } return acc; };
  const chunkOf = (input) => Object.keys(outputs).find((k) => outputs[k].inputs && outputs[k].inputs[input]);
  const view = chunkOf('arch/js/view.js'), parse = chunkOf('arch/js/parse.js'), n8ao = chunkOf('node_modules/n8ao/dist/N8AO.js');
  if (!view || !parse || !n8ao) throw new Error('arch bundle: the viewer, parser or N8AO chunk was not found in the metafile');
  const preload = [];
  for (const k of [app, ...statics(app), worker, ...statics(worker), view, ...statics(view), parse, ...statics(parse), n8ao]) if (!preload.includes(k)) preload.push(k);
  const name = (k) => path.posix.relative('_site/arch', k);

  let html = read('arch/index.html');
  html = cutOnce(html, /<script type="importmap">[\s\S]*?<\/script>\n/, 'arch/index.html import map');
  html = cutOnce(html, /<!-- N8AO also ships[\s\S]*?-->\n/, 'arch/index.html N8AO note');
  html = cutOnce(html, /(<link rel="modulepreload" href="https:\/\/cdn\.jsdelivr\.net\/npm\/three[^\n]*\n){2}/, 'arch/index.html three.js preloads');
  html = cutOnce(html, /<link rel="preconnect" href="https:\/\/cdn\.jsdelivr\.net" crossorigin>\n/, 'arch/index.html preconnect');
  html = replaceOnce(html, "new Worker('js/worker.js', { type: 'module' })", "new Worker('dist/worker.js', { type: 'module' })", 'arch/index.html worker');
  html = replaceOnce(html, '<script type="module" src="js/app.js"></script>', '<script type="module" src="dist/app.js"></script>', 'arch/index.html app');
  html = replaceOnce(html, '<style>\n  :root {', preload.map((k) => `<link rel="modulepreload" href="${name(k)}">`).join('\n') + '\n<style>\n  :root {', 'arch/index.html head');
  if (/cdn\.jsdelivr|importmap/.test(html)) throw new Error('arch/index.html still refers to the CDN or an import map');
  write('arch/index.html', html);

  // the CAD kernel: the npm package's files, checked against the digests the worker pins (it checks them again in
  // the browser); the WebAssembly gzipped, since GitHub Pages compresses no .wasm
  const pkg = path.join(ROOT, 'node_modules/manifold-3d');
  const js = fs.readFileSync(path.join(pkg, 'manifold.js')), wasm = fs.readFileSync(path.join(pkg, 'manifold.wasm'));
  const sri = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');
  const pinned = read('arch/js/worker.js').match(/sha384-[A-Za-z0-9+/=]+/g) || [];
  for (const [f, buf] of [['manifold.js', js], ['manifold.wasm', wasm]]) if (!pinned.includes(sri(buf))) throw new Error(`node_modules/manifold-3d/${f} does not match a SHA-384 pinned in arch/js/worker.js`);
  const wasmGz = zlib.gzipSync(wasm, { level: 9 });
  write('arch/vendor/manifold-3d/manifold.js', js);
  write('arch/vendor/manifold-3d/manifold.wasm.gz', wasmGz);

  for (const k of Object.keys(outputs).filter((k) => k.endsWith('.js')).sort((a, b) => outputs[b].bytes - outputs[a].bytes)) {
    const buf = fs.readFileSync(path.join(ROOT, k));
    report.push([`arch/${name(k)}`, buf.length, gz(buf), preload.includes(k) ? 'preloaded' : 'lazy']);
  }
  report.push(['arch/vendor/manifold-3d/manifold.js', js.length, gz(js), 'kernel']);
  report.push(['arch/vendor/manifold-3d/manifold.wasm.gz', wasmGz.length, wasmGz.length, `kernel, ${kb(wasm.length).trim()} inflated`]);
}

// ---------------------------------------------------------------------------------------- stamp and report
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { /* no git */ }
write('version.json', JSON.stringify({ commit, builtAt: new Date().toISOString() }) + '\n');

let files = 0, bytes = 0;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } } };
walk(OUT);
console.log(`${'file'.padEnd(46)} ${'raw'.padStart(10)} ${'gzip'.padStart(10)}`);
for (const [f, raw, z, note] of report) console.log(`${f.padEnd(46)} ${kb(raw)} ${kb(z)}   ${note || ''}`);
console.log(`\n_site: ${files} files, ${(bytes / 1048576).toFixed(1)} MB, commit ${commit}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);

if (process.argv.includes('--serve')) {
  const { serve } = await import('./tools/serve.mjs');
  const port = +(process.argv[process.argv.indexOf('--serve') + 1] || 8123);
  const s = await serve(OUT, port);
  console.log(`serving at http://127.0.0.1:${s.address().port}/`);
}
