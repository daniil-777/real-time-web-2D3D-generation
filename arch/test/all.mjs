// node arch/test/all.mjs [part-of-a-name] — runs every arch/test/*.test.mjs, each in its own process (they share
// nothing but the kernel they each load), in order; prints one line per file and exits 1 when any failed. `npm test`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];
const files = fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs') && (!only || f.includes(only))).sort();
if (!files.length) { console.error('no test files match', only); process.exit(2); }
const t0 = Date.now();
let failed = 0;
for (const f of files) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, f)], { encoding: 'utf8', maxBuffer: 256 << 20 });
  const lines = ((r.stdout || '') + (r.stderr || '')).trim().split('\n');
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f.padEnd(24)} ${((Date.now() - t) / 1000).toFixed(1).padStart(6)} s   ${ok ? lines.at(-1) || '' : `exit ${r.status}${r.signal ? ' ' + r.signal : ''}`}`);
  if (!ok) console.log(lines.slice(-30).map((l) => '      ' + l).join('\n'));
}
console.log(`\n${files.length - failed}/${files.length} test files passed in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
process.exit(failed ? 1 : 0);
