#!/usr/bin/env node
/**
 * Starts the API and the web UI together.
 *
 *   npm start            build the API, then run both
 *   npm run dev          the same, and open the UI in the default browser
 *
 * Both children are stopped when this process ends, including on Ctrl+C, and when either of
 * them dies the other is stopped too, so there is never a half-running pair to clean up by
 * hand. A plain kill only reaches a wrapper, not the server it spawned, which is exactly how a
 * stale Next.js kept port 3210 busy once already, so the whole tree is stopped: `taskkill /T`
 * first, which asks, and `taskkill /T /F` only for what is still there after a grace period.
 *
 * The API token is never put in the web build or in the API's environment: anything able to read
 * either — a command step the bot is running, among others — could otherwise drive the API. The
 * web page is handed it once, through a link printed below whose `#token=` part stays in the
 * browser. See `web/lib/api.ts`.
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

const alive = (pid) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** Stops one process tree: `taskkill /T`, up to five seconds to close, then `taskkill /T /F`. */
async function stopTreeOf(pid) {
  spawnSync('taskkill', ['/pid', String(pid), '/T'], { stdio: 'ignore', windowsHide: true });
  const until = Date.now() + 5_000;
  while (Date.now() < until && alive(pid)) await new Promise((r) => setTimeout(r, 200));
  if (alive(pid)) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

/*
 * The processes this script started, written down so a later start knows which port holders are
 * a previous run of this starter. It used to decide by whether a holder's command line named this
 * folder — ownership by place, which is also true of anything the operator started by hand here.
 */
const dataDirEarly = process.env.COP_DATA_DIR ?? resolve(root, 'data');
const pidFile = join(dataDirEarly, 'dev-pids.json');
function readPidFile() {
  try {
    const list = JSON.parse(readFileSync(pidFile, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

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
    $conns = Get-NetTCPConnection -State Listen -LocalPort 4000, 3210 -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)"
      $parent = if ($p) { $p.ParentProcessId } else { 0 }
      $made = if ($p -and $p.CreationDate) { [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() } else { 0 }
      $cmd = if ($p) { $p.CommandLine } else { '' }
      Write-Output ("{0}|{1}|{2}|{3}|{4}" -f $c.LocalPort, $c.OwningProcess, $parent, $made, $cmd)
    }`;
  // Without PSModulePath: started from a PowerShell 7 terminal, Windows PowerShell would otherwise
  // look for its own modules in PowerShell 7's folders and fail to load them. See src/exec/winps.ts.
  const psEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'));
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: psEnv });
  const lines = (res.stdout ?? '').split(/\r?\n/).filter((l) => l.includes('|'));
  const recorded = readPidFile();
  let blocked = false;
  for (const line of lines) {
    const [port, pid, parent, made, ...rest] = line.split('|');
    const cmd = rest.join('|');
    // Ours when the holder, or the process that started it (Next's server is a child of `next dev`),
    // is one this script recorded, and the holder is no older than that record: an id alone is reused.
    const ours = recorded.some(
      (r) => (String(r.pid) === pid || String(r.pid) === parent) && Number(made) >= Number(r.startedAt) - 5_000,
    );
    if (ours) {
      log('start', `port ${port} is held by a previous run of this project (pid ${pid}); stopping it`);
      await stopTreeOf(pid);
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
const dataDir = dataDirEarly;
mkdirSync(dataDir, { recursive: true });
/*
 * The folder holds the token, the settings and every session, and under C:\Projects it inherits
 * "Authenticated Users: Modify" — every account on the machine. Narrowed to this account and
 * SYSTEM before the token is written; the API checks it again when it starts and refuses to run
 * with it wider. See `src/api/dataAcl.ts`.
 */
if (isWin) {
  const who = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`;
  spawnSync('icacls', [dataDir, '/inheritance:r', '/grant:r', `${who}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}
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
/*
 * What each child is given. Neither gets the token: the API reads it from its own file, and the web
 * page is handed it by the link printed below. Next's usage telemetry is switched off — it is
 * traffic from this machine to a third party that nobody asked for.
 */
const childEnv = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
delete childEnv.NEXT_PUBLIC_COP_TOKEN;

// 3. Start both.
const children = [];

function start(tag, args, cwd) {
  const child = spawn(process.execPath, args, { cwd, env: childEnv, windowsHide: true });
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
    void shutdown(code ?? 1);
  });
  return child;
}

start('api', [resolve(root, 'dist/src/api/main.js')], root);
// Bound to this machine only. Without -H, `next dev` listens on every network interface, which
// puts the UI on the office network and brings up a firewall prompt for node.exe.
start('web', [bin('next/dist/bin/next'), 'dev', '-p', '3210', '-H', '127.0.0.1'], resolve(root, 'web'));
try {
  writeFileSync(pidFile, JSON.stringify(children.map(({ tag, child }) => ({ tag, pid: child.pid, startedAt: Date.now() }))), 'utf8');
} catch {
  /* only costs the next start the ability to tell a leftover of this one */
}

log('start', `api  ${API_URL}`);
log('start', `web  ${WEB_URL}`);
log('start', `open once in your browser, to give it the API key: ${WEB_URL}/#token=${apiToken}`);
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
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all(
    children.map(async ({ tag, child }) => {
      if (child.exitCode !== null) return;
      log(tag, 'stopping (asked to close first, forced only if it does not)');
      if (isWin && child.pid) await stopTreeOf(child.pid);
      else child.kill('SIGTERM');
    }),
  );
  process.exit(code);
}

/*
 * The last resort, and the only thing `exit` allows: it cannot wait, so whatever the orderly stop
 * above has not reached by now is forced. Normally that is nothing — `shutdown` exits only once
 * both are down.
 */
function forceRemaining() {
  for (const { child } of children) {
    if (child.exitCode !== null || !child.pid) continue;
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGKILL');
  }
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('exit', forceRemaining);
