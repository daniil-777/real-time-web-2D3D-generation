// test/smoke.mjs — opens the built site in headless Chrome and checks that every app starts and answers the way a
// visitor's browser sees it: the site shell with its three tabs, Arch Studio building two elements from text, the 3D
// objects and the drawings reaching their first frame, and no console errors anywhere. Exit 1 on any failure.
//   node test/smoke.mjs [--dir _site] [--url https://host/path/] [--out DIR] [--chrome PATH] [--port 8123] [--timeout 90000]
//                       [--only home,arch,morph3d,pixel-morph] [--budget 480000]
// --dir serves the built tree itself (tools/serve.mjs); --url checks a deployed site instead. Screenshots go to --out.
// --only picks checks (a machine without a GPU, like a CI runner, can start the CAD app on software WebGL but not the
// neural apps at a useful speed); --budget is the whole run's limit in ms, after which it fails instead of hanging.
// Needs puppeteer-core (npm install) and a Chrome: $CHROME, --chrome, or the usual places.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { serve } from '../tools/serve.mjs';

const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
const T = +(opt.timeout || 90000);
const ONLY = opt.only ? String(opt.only).split(',') : null;
const BUDGET = +(opt.budget || 480000);
setTimeout(() => { console.log(`\nsmoke: no verdict after ${BUDGET / 1000} s`); process.exit(1); }, BUDGET).unref();
const OUTDIR = opt.out || path.join(os.tmpdir(), 'smoke-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ''));
fs.mkdirSync(OUTDIR, { recursive: true });

const CHROME = [opt.chrome, process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
  .find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('no Chrome found: pass --chrome PATH or set $CHROME'); process.exit(2); }

let server = null, base = opt.url;
if (!base) {
  server = await serve(opt.dir || '_site', +(opt.port || 8123));
  base = `http://127.0.0.1:${server.address().port}/`;
}
if (!base.endsWith('/')) base += '/';
console.log(`smoke: ${base}  (${CHROME})\n`);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--window-size=1400,900', '--no-first-run', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])],
});

const results = [];
let failures = 0;
async function check(name, fn) {
  if (ONLY && !ONLY.includes(name)) return;
  const t = Date.now();
  const page = await browser.newPage();
  page.setDefaultTimeout(T);
  await page.setViewport({ width: 1380, height: 820 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(m.text())) errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/i.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  // a request the page itself abandoned (the shell removes a tab's frame, and its downloads with it) is no failure
  page.on('requestfailed', (r) => { const why = r.failure() && r.failure().errorText; if (!/favicon/i.test(r.url()) && why !== 'net::ERR_ABORTED') errors.push(`failed ${r.url()} (${why})`); });
  let info = '', ok = true;
  try {
    info = await fn(page) || '';
    if (errors.length) throw new Error(`console errors: ${errors.slice(0, 3).join(' | ')}`);
  } catch (e) { ok = false; failures++; info = e && e.message || String(e); }
  try { await page.screenshot({ path: path.join(OUTDIR, name + '.png') }); } catch (e) { /* page gone */ }
  await page.close();
  results.push({ name, ok, ms: Date.now() - t, info });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(18)} ${((Date.now() - t) / 1000).toFixed(1).padStart(5)} s   ${info}`);
}
const flag = (page, expr) => page.waitForFunction(expr, { timeout: T });

// 1. the site shell: each tab's app becomes ready inside its frame and the caption under the stage says it is live
await check('home', async (page) => {
  await page.goto(base + '#objects', { waitUntil: 'load', timeout: T });
  const notes = [];
  for (const tab of ['objects', 'architecture', 'drawings']) {
    await page.click(`#tab-${tab}`);
    await flag(page, `document.querySelector('#stage') && !document.querySelector('#stage').classList.contains('busy') && document.querySelector('#live').dataset.state !== 'load'`);
    const live = await page.$eval('#live', (el) => [el.dataset.state, el.textContent.trim()]);
    if (live[0] !== 'on') throw new Error(`${tab}: ${live[1]}`);
    notes.push(`${tab}: ${live[1]}`);
  }
  return notes.join(' · ');
});

// 2. Arch Studio: a link's prompt is built, then another through the page's own entry point
await check('arch', async (page) => {
  await page.goto(base + 'arch/?q=Corinthian%20column%20on%20a%20pedestal&showcase=0', { waitUntil: 'load', timeout: T });
  await flag(page, 'window.__arch && (window.__arch.ready || window.__arch.errors.length)');
  let a = await page.evaluate(() => ({ errors: window.__arch.errors, spec: window.__arch.last && window.__arch.last.spec, timing: window.__arch.timing }));
  if (a.errors.length) throw new Error(a.errors.join(' | '));
  if (!a.spec || a.spec.element !== 'column' || a.spec.order !== 'corinthian' || !a.spec.pedestal) throw new Error(`built ${JSON.stringify(a.spec)} for the column prompt`);
  const first = a.timing.firstModel;
  await page.evaluate(() => window.__arch.run('Tetrastyle Doric portico'));
  await flag(page, "window.__arch.last && window.__arch.last.spec && window.__arch.last.spec.element === 'portico' && !window.__arch.busy");
  a = await page.evaluate(() => ({ errors: window.__arch.errors, last: window.__arch.last, n: performance.getEntriesByType('resource').length + 1,
    kb: Math.round(performance.getEntriesByType('resource').reduce((s, r) => s + (r.transferSize || 0), 0) / 1024) }));
  if (a.errors.length) throw new Error(a.errors.join(' | '));
  if (a.last.spec.order !== 'doric') throw new Error(`portico built as ${JSON.stringify(a.last.spec)}`);
  return `first model ${first} ms after navigation · ${a.n} requests, ${a.kb} KB · portico ${Math.round(a.last.ms)} ms, ${a.last.tris} tris`;
});

// 3. the 3D objects: the decoder's first frame on whatever backend this Chrome has
await check('morph3d', async (page) => {
  await page.goto(base + 'morph3d/?embed=1', { waitUntil: 'load', timeout: T });
  await flag(page, 'window.__m3d && (window.__m3d.ready || window.__m3d.errors.length)');
  const m = await page.evaluate(() => ({ errors: window.__m3d.errors, backend: window.__m3d.backend, fps: window.__m3d.fps }));
  if (m.errors.length) throw new Error(m.errors.join(' | '));
  return `backend ${m.backend}${m.fps ? ', ' + Math.round(m.fps) + ' fps' : ''}`;
});

// 4. the drawings
await check('pixel-morph', async (page) => {
  await page.goto(base + 'pixel-morph/?embed=1', { waitUntil: 'load', timeout: T });
  await flag(page, 'window.__pm && (window.__pm.ready || window.__pm.errors.length)');
  const m = await page.evaluate(() => ({ errors: window.__pm.errors, backend: window.__pm.backend, fps: window.__pm.fps }));
  if (m.errors.length) throw new Error(m.errors.join(' | '));
  return `backend ${m.backend}${m.fps ? ', ' + Math.round(m.fps) + ' fps' : ''}`;
});

await browser.close();
if (server) server.close();
console.log(`\n${results.length - failures}/${results.length} checks passed · screenshots in ${OUTDIR}`);
process.exit(failures ? 1 : 0);
