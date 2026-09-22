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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

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

/**
 * Says what is missing before anything is built, rather than after.
 *
 * A fresh clone on a second machine got through the whole API build and then Turbopack failed
 * with three screens about filesystem roots and concurrent installs, because `next` was not
 * where it looks. Dependencies that are simply not installed are the ordinary cause, and a
 * lockfile inside `web/` is the other: it makes npm treat that folder as its own project, so
 * the root install never hoists anything for it. Both are one sentence to say and a minute to
 * fix; neither is worth finding out from a stack trace.
 */
function checkInstall() {
  const problems = [];
  if (!existsSync(resolve(root, 'node_modules'))) {
    problems.push('the repository has no node_modules');
  }
  const nextPkg = [root, resolve(root, 'web')].map((b) => resolve(b, 'node_modules', 'next', 'package.json')).find(existsSync);
  if (!nextPkg) problems.push('the Next.js package is not installed (no node_modules/next here or in web/)');
  if (existsSync(resolve(root, 'web', 'package-lock.json'))) {
    problems.push(
      'web/package-lock.json exists, which means npm install was run inside web/ instead of at the repository root; ' +
        'that makes web its own project and the workspace install never reaches it — delete it, and web/node_modules with it',
    );
  }
  if (problems.length === 0) return;
  for (const p of problems) log('start', p);
  log('start', `fix it with one command, run in ${root}:`);
  log('start', '    npm install');
  process.exit(1);
}

function log(tag, line) {
  process.stdout.write(`[${tag}] ${line}\n`);
}

checkInstall();

// 0. Refuse to start on top of something that already holds a port, and say what it is.
//    A previous run of this project can survive as orphans (the API and Next.js's own
//    start-server child outlive a starter that died abruptly), and then a fresh start fails
//    with EADDRINUSE after the build has already taken ten seconds. If the holder is one of
//    ours it is stopped here; anything else is reported and left alone.
if (isWin) {
  const script = `
    $ports = 4000, 3210
    $conns = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }
    foreach ($c in $conns) {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)"
      $cmd = if ($p) { $p.CommandLine } else { '' }
      Write-Output ("{0}|{1}|{2}" -f $c.LocalPort, $c.OwningProcess, $cmd)
    }`;
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  const lines = (res.stdout ?? '').split(/\r?\n/).filter((l) => l.includes('|'));
  let blocked = false;
  for (const line of lines) {
    const [port, pid, cmd = ''] = line.split('|');
    const ours = cmd.replace(/\\/g, '/').toLowerCase().includes(root.replace(/\\/g, '/').toLowerCase());
    if (ours) {
      log('start', `port ${port} is held by a previous run of this project (pid ${pid}); stopping it`);
      spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      log('start', `port ${port} is in use by pid ${pid}: ${cmd.slice(0, 100) || '(unknown)'}`);
      blocked = true;
    }
  }
  if (blocked) {
    log('start', 'stop whatever holds the port, or set COP_API_PORT / change the web port, then run again');
    process.exit(1);
  }
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

// 2. The API's per-install token, made here so it exists before either process starts.
//
// The API would create it itself, but then the web build would race it for the file and a fresh
// install could compile the UI with an empty token and fail every request with a 401 that looks
// like a bug in the API. Created first, read by both. See `src/api/security.ts`.
const dataDir = process.env.COP_DATA_DIR ?? resolve(root, 'data');
mkdirSync(dataDir, { recursive: true });
const tokenPath = join(dataDir, 'api-token');
let apiToken = '';
try {
  apiToken = readFileSync(tokenPath, 'utf8').trim();
} catch {
  /* not there yet */
}
if (!apiToken) {
  apiToken = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, `${apiToken}
`, { encoding: 'utf8', mode: 0o600 });
  log('start', `made an API token in ${tokenPath}`);
}
// Next inlines NEXT_PUBLIC_* at compile time, and in dev it compiles on demand, so having it in
// the environment before `next dev` starts is enough.
process.env.NEXT_PUBLIC_COP_TOKEN = apiToken;

// 3. Start both.
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
