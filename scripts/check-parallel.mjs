#!/usr/bin/env node
/**
 * The checks of `npm run check`, several at a time (operator, 2026-11-18: "why are the tests so slow? can we run them in
 * parallel, or is it not a good idea?"). One after another they take over an hour: 97 of them, most starting the bot's
 * own server or a browser with a fake Copilot and waiting real seconds. They are kept apart already — each in a folder of
 * its own under the temp folder, on a free port — so most can run side by side.
 *
 *   npm run check:parallel                 the types, the checks of `npm run check` and check:ui, then check:release
 *   npm run check:parallel -- --jobs 6     six at a time (default: half the processors, 2 to 4)
 *   npm run check:parallel -- --only e2e   only the checks whose name holds "e2e"
 *
 * - The slowest run first, by the times of the last run (kept in node_modules/.cache), so the long ones do not end last.
 * - SERIAL: the checks that use what the whole machine shares (the clipboard, the processes, the browser profile's lock)
 *   run after the others, alone.
 * - A check that fails among the others is run again alone. One that then passes is said as such — failed under load,
 *   passed alone — and still counts as a failure: a check that only passes alone is a check to look at, not to trust.
 * - Each check's output is kept in a file; the end says which failed, where their output is, and the slowest ten.
 *
 * `npm run check:all` (one at a time) stays as it was, for a release.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** The machine's shared things: one of these runs with nothing else beside it. */
const SERIAL = new Set(['check:clipboard', 'check:card-copy', 'check:processes', 'check:crash', 'check:lock']);
/*
 * check:ui builds the package and then drives the interface: the longest of all (13 minutes of the first run's 35), so
 * it runs among the others from the start, not after them. The other checks that speak of dist/ make their own in a
 * temp folder. check:release builds the package too, into the same dist/, so it runs after everything, alone.
 */
const WITH_THE_OTHERS = ['check:ui'];
const AFTER = ['check:release'];

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const jobs = Math.max(1, Number(arg('--jobs') ?? process.env.COP_CHECK_JOBS ?? Math.min(4, Math.max(2, Math.floor(cpus().length / 2)))));
const only = arg('--only');
const withAfter = !args.includes('--no-after') && !only;

const chain = String(pkg.scripts.check ?? '')
  .split('&&')
  .map((p) => /npm run (\S+)/.exec(p.trim())?.[1])
  .filter((n) => !!n && (!only || n.includes(only)));
if (chain.length === 0) {
  console.error(only ? `No check's name holds "${only}".` : 'package.json has no "check" chain to run.');
  process.exit(2);
}

const timesFile = join(root, 'node_modules', '.cache', 'cop-check-times.json');
let times = {};
try {
  times = JSON.parse(readFileSync(timesFile, 'utf8'));
} catch {
  times = {};
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const logDir = join(tmpdir(), `cop-checks-${stamp}`);
mkdirSync(logDir, { recursive: true });

/** One check, its output to its own file: how it ended and how long it took. */
function run(name, tag = '') {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = join(logDir, `${name.replace(/[^\w.-]/g, '_')}${tag}.log`);
    const out = createWriteStream(log);
    const child = spawn(`npm run ${name}`, { cwd: root, shell: true, env: { ...process.env, FORCE_COLOR: '0' } });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on('close', (code) => {
      out.end();
      resolve({ name, ok: code === 0, code, ms: Date.now() - started, log });
    });
  });
}

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const said = (r, note = '') => console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(28)} ${secs(r.ms).padStart(8)}${note}`);

const began = Date.now();
// As check:all: the types first; the checks of a source that does not compile say nothing.
if (!only) {
  const types = await run('typecheck');
  said(types);
  if (!types.ok) {
    console.log(`\nThe types do not check: ${types.log}`);
    process.exit(1);
  }
}
const pooled = [...chain.filter((n) => !SERIAL.has(n)), ...(withAfter ? WITH_THE_OTHERS : [])].sort((a, b) => (times[b] ?? 60_000) - (times[a] ?? 60_000));
const alone = chain.filter((n) => SERIAL.has(n));
console.log(`${pooled.length} checks at ${jobs} at a time, then ${alone.length} alone${withAfter ? `, then ${AFTER.join(' and ')}` : ''}. Output: ${logDir}\n`);

const results = [];
let next = 0;
async function worker() {
  while (next < pooled.length) {
    const name = pooled[next++];
    const r = await run(name);
    results.push(r);
    said(r);
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, pooled.length) }, worker));
for (const name of alone) {
  const r = await run(name);
  results.push(r);
  said(r, '  (alone)');
}

// A failure among the others, once more alone: under load, or for real.
const failedPooled = results.filter((r) => !r.ok && !SERIAL.has(r.name));
const underLoad = [];
if (failedPooled.length > 0) console.log(`\n${failedPooled.length} failed among the others; each again, alone:`);
for (const r of failedPooled) {
  const again = await run(r.name, '.alone');
  said(again, again.ok ? '  passed alone: it failed under load' : '  failed alone too');
  if (again.ok) underLoad.push(r.name);
  r.again = again;
}

if (withAfter && results.every((r) => r.ok)) {
  for (const name of AFTER) {
    const r = await run(name);
    results.push(r);
    said(r, '  (after)');
    if (!r.ok) break;
  }
}

for (const r of results) times[r.name] = r.ms;
try {
  mkdirSync(dirname(timesFile), { recursive: true });
  writeFileSync(timesFile, JSON.stringify(times, null, 2));
} catch {
  // the order is a convenience: without it, the next run is only slower
}

const wall = Date.now() - began;
const sum = results.reduce((a, r) => a + r.ms, 0);
console.log(`\n--- the slowest ---`);
for (const r of [...results].sort((a, b) => b.ms - a.ms).slice(0, 10)) console.log(`${r.name.padEnd(28)} ${secs(r.ms).padStart(8)}`);
console.log(`\n${results.length} checks in ${(wall / 60_000).toFixed(1)} min (one after another they would take about ${(sum / 60_000).toFixed(1)} min).`);

const failed = results.filter((r) => !r.ok);
if (underLoad.length > 0) console.log(`Failed under load, passed alone (still failures — to look at): ${underLoad.join(', ')}`);
if (failed.length > 0) {
  console.log(`\nFAILED: ${failed.length}`);
  for (const r of failed) console.log(`  ${r.name}: ${r.again && !r.again.ok ? r.again.log : r.log}`);
  process.exit(1);
}
console.log('\nAll passed.');
