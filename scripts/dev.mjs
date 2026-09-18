#!/usr/bin/env node
/**
 * Starts the API and the web UI together.
 *
 *   npm start            build the API, then run both
 *   npm run dev          the same, and open the UI in the default browser
 *
 * Both children are killed when this process ends, including on Ctrl+C, and when either of
 * them dies the other is stopped too, so there is never a half-running pair to clean up by
 * hand. On Windows that needs taskkill with /T: a plain kill only reaches a wrapper, not the
 * server it spawned, which is exactly how a stale Next.js kept port 3210 busy once already.
 *
 * `tsc` and `next` are invoked as node scripts rather than through npm, so no shell is
 * involved and nothing has to be escaped.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const open = process.argv.includes('--open');

const API_URL = 'http://127.0.0.1:4000/api';
const WEB_URL = 'http://localhost:3210';

/** A package's CLI entry, wherever npm put it: the root or the web workspace. */
function bin(pkgRelPath) {
  for (const base of [root, resolve(root, 'web')]) {
    const p = resolve(base, 'node_modules', pkgRelPath);
    if (existsSync(p)) return p;
  }
  throw new Error(`cannot find ${pkgRelPath}; run npm install`);
}

function log(tag, line) {
  process.stdout.write(`[${tag}] ${line}\n`);
}

// 1. Build the API. Nest needs decorator metadata, which only tsc emits.
log('build', 'tsc -p tsconfig.json');
const build = spawnSync(process.execPath, [bin('typescript/bin/tsc'), '-p', 'tsconfig.json'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
if (build.status !== 0) {
  log('build', 'failed; not starting anything');
  process.exit(build.status ?? 1);
}

// 2. Start both.
const children = [];

function start(tag, args, cwd) {
  const child = spawn(process.execPath, args, { cwd, env: process.env, windowsHide: true });
  children.push({ tag, child });
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) log(tag, l);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    log(tag, `exited with code ${code}`);
    shutdown(code ?? 1);
  });
  return child;
}

start('api', [resolve(root, 'dist/src/api/main.js')], root);
start('web', [bin('next/dist/bin/next'), 'dev', '-p', '3210'], resolve(root, 'web'));

log('start', `api  ${API_URL}`);
log('start', `web  ${WEB_URL}`);
log('start', 'Ctrl+C stops both');

if (open) {
  // Give Next.js a moment to bind before the browser asks for the page.
  setTimeout(() => {
    const [cmd, args] = isWin
      ? ['cmd', ['/c', 'start', '', WEB_URL]]
      : process.platform === 'darwin'
        ? ['open', [WEB_URL]]
        : ['xdg-open', [WEB_URL]];
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  }, 4000);
}

// 3. Stop both, whatever ends first.
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const { tag, child } of children) {
    if (child.exitCode !== null) continue;
    log(tag, 'stopping');
    if (isWin && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => shutdown(0));
