// Visual QA harness: drives the real page in Chrome and photographs every prompt.
//   node arch/test/shots.mjs [promptsFile] [--ids a,b] [--cat direct,units] [--limit N] [--out DIR] [--jobs 2]
//                            [--mode stone|white|line] [--view three-quarter|front|side|top] [--size 720] [--timeout ms]
//                            [--no-retry] [--drawings]
// --drawings also saves each element's A3 drawing sheet (window.__arch.drawing: 300 dpi PNG) as <id>-drawing.png.
// promptsFile defaults to arch/test/prompts.json ({ prompts: [{ id, text, expect }] }; an entry may carry `spec` instead
// of / besides `text`, which is then passed as ?spec=). Out-of-scope prompts (expect.outOfScope) are skipped.
// Writes <out>/<id>.png (720×720), results.json, index.html and contact sheets sheet-NN.png (4×3 tiles, prompt and
// interpretation under each) to /Volumes/LaCie/morph3d/archkit/shots/<YYYY-MM-DD-HHMM>/ and prints ok / errors / timeouts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ARCHKIT = process.env.ARCHKIT || '/Volumes/LaCie/morph3d/archkit';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ------------------------------------------------------------------------------------------------ arguments
const argv = process.argv.slice(2), opt = {}, pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    opt[k] = k !== 'no-retry' && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  else pos.push(argv[i]);
}
const file = path.resolve(pos[0] || path.join(REPO, 'arch/test/prompts.json'));
const stamp = (() => { const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; })();
const OUT = path.resolve(opt.out || `${ARCHKIT}/shots/${stamp}`);
const SIZE = +(opt.size || 720), JOBS = Math.max(1, +(opt.jobs || 2)), TIMEOUT = +(opt.timeout || 20000);

const lib = JSON.parse(fs.readFileSync(file, 'utf8'));
let list = (Array.isArray(lib) ? lib : lib.prompts).filter((p) => !(p.expect && p.expect.outOfScope));
if (opt.ids) { const ids = String(opt.ids).split(','); list = list.filter((p) => ids.some((i) => p.id === i || (i.endsWith('*') && p.id.startsWith(i.slice(0, -1))))); }
if (opt.cat) { const cats = String(opt.cat).split(','); list = list.filter((p) => cats.includes(p.cat)); }
if (opt.limit) list = list.slice(0, +opt.limit);
if (!list.length) { console.error('no prompts selected from', file); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------------------------------------ static server
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.gz': 'application/octet-stream', '.txt': 'text/plain' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(REPO, path.normalize(p));
  if (!f.startsWith(REPO)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------------------------------------ browser
const puppeteer = createRequire(`${ARCHKIT}/package.json`)('puppeteer-core');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-shots-'));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: profile,
  // several pages render at once: none of them may be throttled as a background tab
  args: ['--no-first-run', '--no-default-browser-check', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  defaultViewport: { width: SIZE, height: SIZE, deviceScaleFactor: 1 },
});

const results = [];
const t0 = Date.now();
async function shoot(page, p) {
  const q = new URLSearchParams();
  const text = p.text || '';
  if (text) q.set('q', text);
  if (p.spec) q.set('spec', JSON.stringify(p.spec));
  q.set('shot', '1');
  q.set('view', opt.view || p.view || 'three-quarter');
  if (opt.mode || p.mode) q.set('mode', opt.mode || p.mode);
  const url = `${BASE}/arch/?${q}`;
  const r = { id: p.id, cat: p.cat, text, url: url.replace(BASE, ''), status: 'timeout' };
  const logs = [];
  const onLog = (m) => { if (m.type() === 'error' || m.type() === 'warn') logs.push(`${m.type()}: ${m.text()}`.slice(0, 300)); };
  const onErr = (e) => logs.push('pageerror: ' + String(e.message || e).slice(0, 300));
  page.on('console', onLog); page.on('pageerror', onErr);
  const start = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction((t) => window.__arch && ((window.__arch.last && window.__arch.last.prompt === t) || window.__arch.errors.length > 0),
      { timeout: TIMEOUT, polling: 100 }, text);
    const st = await page.evaluate(() => ({ last: window.__arch.last, errors: window.__arch.errors }));
    r.loadMs = Date.now() - start;
    if (st.errors.length) { r.status = 'error'; r.error = st.errors.join(' | '); }
    else if (st.last && st.last.outOfScope) { r.status = 'oos'; r.error = st.last.message; }
    else {
      r.status = 'ok';
      Object.assign(r, { interpretation: st.last.interpretation, spec: st.last.spec, ms: Math.round(st.last.ms), tris: st.last.tris,
        size: st.last.size && st.last.size.map((x) => +x.toFixed(3)), warnings: st.last.warnings });
    }
  } catch (e) {
    r.error = String(e.message || e).split('\n')[0];
    // where did it stop? (kernel, viewer, build)
    try { r.state = await page.evaluate(() => window.__arch && { busy: window.__arch.busy, timing: window.__arch.timing, errors: window.__arch.errors }); } catch (e2) { /* page gone */ }
  }
  try { r.timing = await page.evaluate(() => window.__arch && window.__arch.timing); } catch (e) { /* page gone */ }
  try { await page.screenshot({ path: path.join(OUT, `${p.id}.png`) }); r.png = `${p.id}.png`; } catch (e) { /* page gone */ }
  if (opt.drawings && r.status === 'ok') {
    try {
      const d = await page.evaluate(async () => { try { return await window.__arch.drawing('png'); } catch (e) { return { error: e.message }; } });
      if (d.error) r.drawing = { error: d.error };
      else {
        fs.writeFileSync(path.join(OUT, `${p.id}-drawing.png`), Buffer.from(d.base64, 'base64'));
        r.drawing = { png: `${p.id}-drawing.png`, scale: `1:${d.scale}`, dpi: d.dpi, ms: d.ms, views: d.views, measured: d.measured };
      }
    } catch (e) { r.drawing = { error: String(e.message || e).split('\n')[0] }; }
  }
  page.off('console', onLog); page.off('pageerror', onErr);
  if (logs.length) r.logs = logs.slice(0, 8);
  results.push(r);
  const tag = { ok: 'ok     ', error: 'ERROR  ', timeout: 'TIMEOUT', oos: 'oos    ' }[r.status];
  console.log(`${tag} ${p.id.padEnd(18)} ${String(r.ms ?? '').padStart(5)} ms ${String(r.tris ?? '').padStart(8)} tris  ${text.slice(0, 60)}${r.error ? '  → ' + r.error.slice(0, 120) : ''}`);
}

const queue = list.slice();
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
  const page = await browser.newPage();
  while (queue.length) await shoot(page, queue.shift());
  await page.close();
}));
// a loaded machine can starve parallel pages: timeouts get one more, unhurried try on their own (--no-retry to skip)
const late = results.filter((r) => r.status === 'timeout');
if (late.length && !opt['no-retry']) {
  console.log(`retrying ${late.length} timeout(s) one at a time…`);
  const page = await browser.newPage();
  for (const r of late) { results.splice(results.indexOf(r), 1); await shoot(page, list.find((p) => p.id === r.id)); }
  await page.close();
}
results.sort((a, b) => list.findIndex((p) => p.id === a.id) - list.findIndex((p) => p.id === b.id));

// renderer actually used (GPU or software)
let gpu = '';
try {
  const page = await browser.newPage();
  gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'no WebGL2';
  });
  await page.close();
} catch (e) { gpu = '?'; }

// ------------------------------------------------------------------------------------------------ sheets + index
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const tile = (r, src) => `<figure class="${r.status}">${r.png ? `<img src="${src(r.png)}" alt="">` : '<div class="none"></div>'}
  <figcaption><b>${esc(r.text || JSON.stringify(r.spec || {}))}</b><span>${esc(r.interpretation || r.error || '')}</span>
  <small>${esc(r.id)}${r.status === 'ok' ? ` · ${r.tris?.toLocaleString('en')} tris · ${r.ms} ms · ${r.size ? r.size.join(' × ') + ' m' : ''}` : ' · ' + r.status.toUpperCase()}</small></figcaption></figure>`;
const CSS = `body{margin:0;padding:18px;background:#fff;font:13px/1.35 -apple-system,system-ui,sans-serif;color:#1d1d1f}
  h1{font-size:17px;margin:0 0 4px}p.sum{margin:0 0 14px;color:#6e6e73}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
  figure{margin:0}img,.none{display:block;width:100%;aspect-ratio:1;border-radius:8px;background:#f4f4f2}
  figcaption{margin-top:6px}figcaption b{display:block;font-weight:600}figcaption span{display:block;color:#6e6e73}
  figcaption small{display:block;color:#a1a1a6;margin-top:2px}
  figure.error figcaption span,figure.timeout figcaption span{color:#c00}`;
const counts = { ok: 0, error: 0, timeout: 0, oos: 0 };
for (const r of results) counts[r.status]++;
const summary = `${results.length} prompts · ${counts.ok} ok · ${counts.error} errors · ${counts.timeout} timeouts${counts.oos ? ` · ${counts.oos} answered out of scope` : ''} · ${((Date.now() - t0) / 1000).toFixed(0)} s · ${esc(gpu)}`;
fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>arch shots ${stamp}</title><style>${CSS}</style>
  <h1>Arch Studio shots — ${esc(path.basename(file))}</h1><p class="sum">${summary}</p>
  <div class="grid">${results.map((r) => `<a href="${r.png || '#'}" style="color:inherit;text-decoration:none">${tile(r, (f) => f)}</a>`).join('')}</div>`);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ file, base: BASE, gpu, summary: counts, results }, null, 1));

const sheets = [];
const page = await browser.newPage();
await page.setViewport({ width: 1480, height: 900, deviceScaleFactor: 1 });
for (let i = 0; i < results.length; i += 12) {
  const chunk = results.slice(i, i + 12), n = sheets.length + 1;
  const html = path.join(OUT, `sheet-${String(n).padStart(2, '0')}.html`);
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${CSS}</style><h1>Arch Studio — sheet ${n} (${i + 1}–${i + chunk.length} of ${results.length})</h1>
    <p class="sum">${summary}</p><div class="grid">${chunk.map((r) => tile(r, (f) => pathToFileURL(path.join(OUT, f)).href)).join('')}</div>`);
  await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
  const png = html.replace(/\.html$/, '.png');
  await page.screenshot({ path: png, fullPage: true });
  sheets.push(png);
}
await page.close();
await browser.close();
server.close();
fs.rmSync(profile, { recursive: true, force: true });

console.log(`\n${summary}\nout: ${OUT}\nsheets: ${sheets.map((s) => path.basename(s)).join(', ')}`);
process.exit(counts.error || counts.timeout ? 1 : 0);
