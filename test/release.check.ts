/**
 * What `npm publish` ships, and what the program does once it is installed from it.
 *
 * The package is how the bot reaches another machine: `npm i -D copilot-operator`, then
 * `npx cop start`. Nothing in the clone's own checks runs the code the way a user gets it — built by
 * `scripts/build-package.mjs`, packed by npm, unpacked into a stranger's `node_modules` — so a
 * packaging mistake would only be found by whoever installs it next. Held here:
 *
 * - `cop --version` says the version that is actually installed;
 * - the tarball carries the compiled CLI and API, the static interface, the prompts, the README and
 *   the licence, and none of the operator's records, the checks, the web sources or build leftovers;
 *   nor a compiled file whose source was deleted (a stale file planted in dist/src must not ship);
 * - no API token is baked into the shipped interface, and the package build cannot bake one in from
 *   whatever the shell that runs it happens to hold;
 * - the installed package starts in a throwaway project, serves its page with the token as a cookie,
 *   keeps its records out of the project's git, and leaves its port free once it is stopped;
 * - `cop run` refuses a run it must not start before any browser is opened; `cop doctor` names a
 *   default model the picker on this machine does not have, and a settings file the API will not
 *   start on, which it reads as the API does (a byte-order mark is not damage);
 * - the API process logs a stray promise rejection and carries on, and fails loudly on a taken port;
 * - decision pin: `npm start` (scripts/dev.mjs, run here with its children replaced) keeps the token
 *   out of the API's environment and hands it to the dev web server, as the operator decided it
 *   should stay; web/lib/api.ts must then not say the token is in no file the web server hands out.
 *
 * Nothing here opens Edge or Copilot or touches the operator's data: every folder is a new temporary
 * one, every port is asked of the system, the doctor's `npm ping` is answered by a server on
 * 127.0.0.1, and the only traffic off the machine is `npm install` fetching the package's own
 * dependencies (from the cache first). The one thing written into the clone is a marker file in
 * dist/src for the length of the build, removed again at the end of that section.
 *
 * Each section runs on its own: one that throws is reported as a failure of that section and the
 * rest still run.
 *
 *   npm run check:release        (also run by the release workflow before it publishes)
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tally, waitFor, freePort, makeRepo } from './support/harness.js';

const t = new Tally();
const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
  bin?: Record<string, string>;
  files?: string[];
};
const base = mkdtempSync(join(tmpdir(), 'cop-release-'));
/** tsx as a loader for children started outside the repository: `--import tsx` resolves from the cwd. */
const tsx = pathToFileURL(join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const cliTs = join(root, 'src', 'cli.ts');

/** The environment a child starts from: none of the operator's COP_* settings, and npm kept quiet. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    // PSModulePath: Windows PowerShell started from a PowerShell 7 terminal otherwise loads the wrong
    // modules (see src/exec/winps.ts). COP_*: the operator's own data folder or port must not leak in.
    if (/^cop_/i.test(k) || k.toLowerCase() === 'psmodulepath' || k.toUpperCase() === 'NEXT_PUBLIC_COP_TOKEN') continue;
    env[k] = v;
  }
  return {
    ...env,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    // tsx looks for tsconfig.json in the cwd; from a temporary folder it would find none and compile
    // the API without decorators. Pointed at the repository's, a child anywhere compiles as npm start does.
    TSX_TSCONFIG_PATH: join(root, 'tsconfig.json'),
    ...extra,
  };
}

function killTree(pid: number | undefined): void {
  if (pid) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
}

/** Kills a child this check started and waits for it to be gone, so its folders can be removed. */
async function stopChild(child: ChildProcess): Promise<void> {
  const gone = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  killTree(child.pid);
  await Promise.race([gone, new Promise((r) => setTimeout(r, 15_000))]);
}

type Ran = { code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean };

/** Runs a child to its end, asynchronously (the doctor's npm ping is answered by this process). */
function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<Ran> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started, timedOut });
    };
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? cleanEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs);
    child.on('error', (e) => {
      stderr += String(e);
      done(null);
    });
    child.on('close', (code) => done(code));
  });
}

/** npm, run as the script it is next to node.exe: npm.cmd would need a shell, and quoting with it. */
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
function npm(args: string[], cwd: string, timeoutMs: number): Promise<Ran> {
  if (existsSync(npmCli)) return run(process.execPath, [npmCli, ...args], { cwd, timeoutMs });
  return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm ${args.map((a) => `"${a}"`).join(' ')}`], { cwd, timeoutMs });
}

/** `cop` from the sources, the way `npm run cop` runs it, from any folder. */
function cop(args: string[], cwd: string, env: NodeJS.ProcessEnv = cleanEnv(), timeoutMs = 60_000): Promise<Ran> {
  return run(process.execPath, ['--import', tsx, cliTs, ...args], { cwd, env, timeoutMs });
}

async function portFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = createNetServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/**
 * Edge processes, with their command lines, from the process table. Only the ones whose command
 * line names a folder of this check count: the operator's own Edge, and the browser a running
 * copilot-operator starts, come and go all the time and are none of this check's business.
 */
function edgeProcesses(): Map<number, string> | null {
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: cleanEnv(), timeout: 30_000 });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  const text = r.stdout.trim();
  const map = new Map<number, string>();
  if (!text) return map;
  try {
    const parsed = JSON.parse(text) as { ProcessId: number; CommandLine: string | null } | Array<{ ProcessId: number; CommandLine: string | null }>;
    for (const p of Array.isArray(parsed) ? parsed : [parsed]) map.set(p.ProcessId, p.CommandLine ?? '');
    return map;
  } catch {
    return null;
  }
}

/** Code lines only: comments dropped, so only code can satisfy a pattern. */
const code = (file: string): string =>
  readFileSync(join(root, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
    .join('\n');

/**
 * One part of this file. A throw inside is a failure of that part, recorded, and the next part
 * still runs: an offline `npm install` must not hide what `cop run` or the API do.
 */
async function section(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n--- ${name} ---`);
  try {
    await fn();
  } catch (e) {
    t.truthy(`${name}: ran without throwing`, false, (e as Error).stack ?? String(e));
  }
}

/** What `npm pack --json` says it put in the tarball. */
type Packed = { filename: string; files: Array<{ path: string }> };

let packedFiles: string[] = [];
let tarball = '';
/** The package as npm packed it: a copy of what package.json's `files` names, taken right after the build. */
const stage = join(base, 'stage');
const project = join(base, 'project');
const installed = join(project, 'node_modules', 'copilot-operator');

/*
 * The clone's own tokens, read before anything is built: those are what a build here could bake
 * into dist/web. A token the installed package mints later cannot be in a tarball built before it,
 * so it does not count as something to look for. Read to compare, never printed.
 */
const cloneTokens = new Set<string>();
for (const file of [join(root, 'data', 'api-token'), join(root, '.copilot-operator', 'data', 'api-token')]) {
  try {
    const v = readFileSync(file, 'utf8').trim();
    if (v) cloneTokens.add(v.toLowerCase());
  } catch {
    /* not there, as in CI */
  }
}

await section('cop --version', async () => {
  // Commander prints whatever `.version()` was given. Hard-coded, it said 0.1.0 through thirteen
  // releases, so a bug report's "cop --version" names a version that never had the bug.
  const r = await cop(['--version'], root);
  t.check('cop --version exits 0', r.code, 0);
  // src/cli.ts reads the version from the package.json of copilot-operator it runs from, not a literal.
  t.check('cop --version prints the version in package.json', r.stdout.trim(), pkg.version);
});

await section('what the tarball carries', async () => {
  /*
   * tsc writes dist/src but never removes a file whose source is gone, and `files` ships all of
   * dist/src. So code deleted from src/ — the project mirror, the Desktop copies and the file
   * attachments, removed on purpose — would be installed on every machine that takes the next
   * release unless the build empties dist/src first. A marker planted there before the build shows
   * whether it does, whatever this checkout happens to hold (a fresh clone holds nothing stale).
   */
  const markerRel = 'dist/src/__release_check_stale.js';
  const marker = join(root, markerRel);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, '// written by test/release.check.ts for the length of one build; safe to delete\n', 'utf8');
  try {
    t.truthy('package.json has a files allowlist (what ships is named, not everything minus .gitignore)', Array.isArray(pkg.files) && pkg.files.length > 0, pkg.files);

    /*
     * Built the way `npm pack` builds it (prepack), then copied at once into a folder of this
     * check's own and packed from there with scripts off. Another build in this checkout (check:ui
     * runs one) empties dist/web and web/.next-export when it starts; packed straight from the
     * checkout, the tarball could lack the interface or carry half of it. The copy is taken of
     * whatever package.json's `files` names, so a change to that list is packed as npm would pack it.
     */
    const stageFromClone = (): void => {
      rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      mkdirSync(stage, { recursive: true });
      const entries = new Set<string>(['package.json', ...(pkg.files ?? [])]);
      for (const name of readdirSync(root)) if (/^(readme|license|licence)(\..*)?$/i.test(name) || name === '.npmignore') entries.add(name);
      for (const entry of entries) {
        const from = join(root, entry);
        if (existsSync(from)) cpSync(from, join(stage, entry), { recursive: true });
      }
    };
    /** What of the interface is missing from the copy: index.html and every script and stylesheet it names. */
    const interfaceGaps = (): string[] => {
      const index = join(stage, 'dist', 'web', 'index.html');
      if (!existsSync(index)) return ['dist/web/index.html'];
      const refs = [...new Set(readFileSync(index, 'utf8').match(/\/_next\/static\/[\w\-./]+?\.(?:js|css)/g) ?? [])];
      if (refs.length === 0) return ['(index.html names no /_next/static script)'];
      return refs.filter((r) => !existsSync(join(stage, 'dist', 'web', r))).map((r) => `dist/web${r}`);
    };
    let built = false;
    let gaps: string[] = ['(not built yet)'];
    for (let attempt = 1; attempt <= 2 && !(built && gaps.length === 0); attempt++) {
      const build = await run(process.execPath, [join(root, 'scripts', 'build-package.mjs')], { cwd: root, env: cleanEnv(), timeoutMs: 300_000 });
      built = build.code === 0;
      if (!built) {
        console.log(`(the package build failed (attempt ${attempt}): ${(build.stderr || build.stdout).slice(-400)})`);
        continue;
      }
      try {
        stageFromClone();
        gaps = interfaceGaps();
      } catch (e) {
        gaps = [`(copying the build failed: ${(e as Error).message})`];
      }
      if (gaps.length > 0) console.log(`(the copied interface was incomplete (attempt ${attempt}), probably another build replacing it: ${gaps.slice(0, 3).join(', ')})`);
    }
    t.truthy('scripts/build-package.mjs succeeds', built);
    t.check('the packed interface is whole: index.html and every script and stylesheet it names', gaps, []);

    const packDir = join(base, 'pack');
    mkdirSync(packDir, { recursive: true });
    const packed = await npm(['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], stage, 120_000);
    t.check('npm pack succeeds', packed.code, 0);
    const json = packed.stdout.indexOf('[');
    if (packed.code !== 0 || json < 0) {
      t.truthy('npm pack said what it packed', false, (packed.stderr || packed.stdout).slice(-1500));
      return;
    }
    const list = JSON.parse(packed.stdout.slice(json)) as Packed[];
    packedFiles = list[0]!.files.map((f) => f.path.replace(/\\/g, '/'));
    tarball = join(packDir, list[0]!.filename);
    t.truthy('the tarball was written', existsSync(tarball), tarball);

    for (const need of ['package.json', 'dist/src/cli.js', 'dist/src/api/main.js', 'dist/web/index.html', 'prompts/level1.md', 'prompts/review1.md', 'README.md', 'LICENSE']) {
      t.truthy(`ships ${need}`, packedFiles.includes(need));
    }
    // The operator's records, the checks, the web sources and Next's build bookkeeping (the server
    // bundle holds the build's environment) are the clone's, never the package's; nor are source
    // maps, which nothing compiles here (tsconfig has no sourceMap) and would only point at sources
    // the package does not carry.
    const forbidden = packedFiles.filter(
      (p) => /^(data|runs|test|web|scripts|docs)\//.test(p) || /^dist\/web\/server\//.test(p) || /^dist\/scripts\//.test(p) || /\.map$/.test(p) || /\.tgz$/.test(p) || /(^|\/)\.env/.test(p) || /(^|\/)api-token$/.test(p),
    );
    t.check('ships nothing from data/, runs/, test/, web/, dist/web/server/, and no .map, .env or token file', forbidden, []);
    t.check('package.json bin.cop is the compiled CLI', pkg.bin?.cop, 'dist/src/cli.js');

    // build-package.mjs prunes, after tsc, every file in dist/src that no source in src/ could have made.
    t.check('a stale file planted in dist/src before the build is not in the tarball', packedFiles.includes(markerRel), false);
    // Removed from dist/src itself, not only left out of the tarball: dist/src holds what src/ compiles to.
    t.check('and the build removed it from dist/src', existsSync(marker), false);
    // The same question asked of what this checkout already had lying there.
    const orphans = packedFiles
      .filter((p) => p !== markerRel && p.startsWith('dist/src/') && p.endsWith('.js'))
      .filter((p) => !existsSync(join(root, p.replace(/^dist\//, '').replace(/\.js$/, '.ts'))));
    // The removed mirror and attachment modules (dist/src/context/{contextFiles,desktopMirror,projectMirror}.js) shipped this way once.
    t.check('every compiled file shipped has a source in src/ (nothing stale from a deleted module)', orphans, []);
  } finally {
    rmSync(marker, { force: true });
  }
});

await section("the installed package starts, and stays out of the project's git", async () => {
  if (!tarball || !existsSync(tarball)) {
    t.truthy('there is a tarball to install (the section above made none)', false);
    return;
  }
  // A project as a user has one: a git repository with a commit, node_modules ignored.
  mkdirSync(project, { recursive: true });
  await makeRepo(project);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'release-check-project', version: '1.0.0', private: true }, null, 2), 'utf8');
  writeFileSync(join(project, '.gitignore'), 'node_modules/\n', 'utf8');
  const git = (...args: string[]): string => spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' }).stdout.trim();
  git('add', '-A');
  git('commit', '-q', '-m', 'project');

  // --ignore-scripts: the dependencies' own install scripts are not what is tested, and the
  // package itself must not need one (checked below). --prefer-offline: from the cache first.
  const install = await npm(['install', '-D', tarball, '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'], project, 300_000);
  t.check('npm i -D <tarball> succeeds in a fresh project', install.code, 0);
  if (install.code !== 0 || !existsSync(join(installed, 'package.json'))) {
    t.truthy('the package is in the project\'s node_modules (the rest of this section needs it)', false, install.stderr.slice(-1500));
    return;
  }
  // The install is part of the project, committed as a project would commit it.
  git('add', '-A');
  git('commit', '-q', '-m', 'add copilot-operator');

  const shippedPkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as { version: string; scripts?: Record<string, string> };
  // A script that runs at install time runs on every machine that installs the bot, unasked.
  const installHooks = Object.keys(shippedPkg.scripts ?? {}).filter((k) => /^(pre|post)?install$|^prepare$/.test(k));
  t.check('the package runs nothing at install time', installHooks, []);
  // Read from the installed copy: that is what the bin shim runs.
  t.truthy('the installed CLI starts with a node shebang, which the bin shim needs', readFileSync(join(installed, 'dist', 'src', 'cli.js'), 'utf8').startsWith('#!/usr/bin/env node'));
  t.truthy('npm made the cop shim in node_modules/.bin', existsSync(join(project, 'node_modules', '.bin', 'cop.cmd')));
  const version = await run(process.execPath, [join(installed, 'dist', 'src', 'cli.js'), '--version'], { cwd: project, timeoutMs: 60_000 });
  // Read from node_modules/copilot-operator/package.json, not from the project's own package.json beside it.
  t.check('the installed cop --version is the installed version', version.stdout.trim(), shippedPkg.version);

  const port = await freePort();
  const child = spawn(process.execPath, [join(installed, 'dist', 'src', 'cli.js'), 'start', '--port', String(port)], {
    cwd: project,
    env: cleanEnv(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => (out += c));
  try {
    const origin = `http://127.0.0.1:${port}`;
    const state = await waitFor(
      'the installed API to answer /api/health, or to exit',
      async () => (child.exitCode !== null ? 'exited' : (await fetch(`${origin}/api/health`)).status === 200 ? 'up' : false),
      90_000,
    ).catch(() => 'timed out');
    t.truthy('the installed API came up', state === 'up', `${state}: ${out.slice(-1500)}`);
    if (state !== 'up') return;
    // /api/health answers as soon as the port is bound; the start-up lines come after the
    // bootstrap, the settings and the folder permissions, a moment later.
    const said = `running for ${project}`.toLowerCase();
    await waitFor('the start-up line', async () => out.toLowerCase().includes(said), 30_000).catch(() => false);
    t.truthy('it says it runs for the project it was installed in', out.toLowerCase().includes(said), out);

    const page = await fetch(`${origin}/`);
    t.check('GET / answers 200', page.status, 200);
    t.truthy('with the interface as HTML', (page.headers.get('content-type') ?? '').startsWith('text/html'), page.headers.get('content-type'));
    await page.text();
    const cookie = /cop_token=([0-9a-f]+)/.exec(page.headers.getSetCookie().join('\n'))?.[1] ?? '';
    t.truthy('and hands the page the token as the cop_token cookie', cookie.length === 64);
    const sessions = await fetch(`${origin}/api/sessions`, { headers: { cookie: `cop_token=${cookie}` } });
    t.check('GET /api/sessions with that cookie answers 200', sessions.status, 200);
    t.check('with no sessions in a new project', await sessions.json(), []);
    const refused = await fetch(`${origin}/api/sessions`);
    t.check('and without it, 401', refused.status, 401);

    const home = join(project, '.copilot-operator');
    t.check('the records folder ignores itself: .copilot-operator/.gitignore is "*\\n"', existsSync(join(home, '.gitignore')) ? readFileSync(join(home, '.gitignore'), 'utf8') : null, '*\n');
    const tokenFile = join(home, 'data', 'api-token');
    t.truthy('the token is kept in .copilot-operator/data/api-token', existsSync(tokenFile));
    t.truthy('and it is the token the cookie carried', existsSync(tokenFile) && readFileSync(tokenFile, 'utf8').trim() === cookie);
    t.check("the project's git sees nothing new", git('status', '--porcelain'), '');
  } finally {
    await stopChild(child);
  }
  const freed = await waitFor('the port to be free after the tree is killed', async () => await portFree(port), 15_000).catch(() => false);
  t.check('after taskkill /T /F its port is free', freed, true);
});

await section('no token in what ships', async () => {
  // Read from the staged copy: byte for byte what npm packed, and not changed under this check by
  // another build of dist/web in the same checkout.
  const webFiles = packedFiles.filter((p) => p.startsWith('dist/web/'));
  t.truthy('the tarball carries an interface to scan', webFiles.length > 5 && existsSync(stage), `${webFiles.length} file(s) under dist/web in the tarball`);
  if (cloneTokens.size === 0) {
    console.log(
      "(this clone has no api-token of its own, as in CI: this scan can only look for the name NEXT_PUBLIC_COP_TOKEN; that a token in the build's shell cannot be baked in is held by the next section)",
    );
  } else {
    console.log(`(looking for this clone's ${cloneTokens.size} token(s), read before the build)`);
  }

  const namesIt: string[] = [];
  const holdsToken: string[] = [];
  let hexRuns = 0;
  for (const rel of webFiles) {
    const text = readFileSync(join(stage, rel), 'latin1');
    if (text.includes('NEXT_PUBLIC_COP_TOKEN')) namesIt.push(rel);
    hexRuns += (text.match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi) ?? []).length;
    const lower = text.toLowerCase();
    for (const tok of cloneTokens) if (lower.includes(tok)) holdsToken.push(rel);
  }
  console.log(`(scanned ${webFiles.length} shipped files: ${hexRuns} run(s) of 64 hex digits)`);
  t.check("no shipped file holds this clone's API token", [...new Set(holdsToken)], []);
  // The name left in a chunk would be Next's unreplaced `process.env.NEXT_PUBLIC_COP_TOKEN` fallback
  // in web/lib/api.ts: a lookup that the same build run from a shell with the variable set replaces
  // with the token itself. build-package.mjs pins it to '' for the export build, so it compiles away.
  t.check('no shipped file mentions NEXT_PUBLIC_COP_TOKEN', namesIt, []);
});

await section('the package build cannot bake in a token from its environment', async () => {
  // build-package.mjs run for real, but with child_process.spawnSync and the file operations
  // replaced before it loads: tsc and next are not started, dist/ and web/ are not touched, and the
  // environment each would have been given is written down. The clone's data/api-token reads as
  // absent, as in CI, so only the shell's variables could carry a token in.
  const record = join(base, 'build-env.json');
  const preload = join(base, 'build-preload.mjs');
  writeFileSync(
    preload,
    `import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const calls = [];
const write = fs.writeFileSync;
const read = fs.readFileSync;
const exists = fs.existsSync;
cp.spawnSync = (cmd, args = [], opts = {}) => {
  const env = opts.env ?? process.env;
  calls.push({
    cmd,
    args: args.map(String),
    token: Object.prototype.hasOwnProperty.call(env, 'NEXT_PUBLIC_COP_TOKEN') ? env.NEXT_PUBLIC_COP_TOKEN : null,
    publics: Object.keys(env).filter((k) => /^NEXT_PUBLIC_/i.test(k)),
  });
  write(${JSON.stringify(record)}, JSON.stringify(calls), 'utf8');
  return { status: 0, stdout: '', stderr: '', output: [], pid: 0, signal: null };
};
fs.rmSync = () => undefined;
fs.cpSync = () => undefined;
fs.readFileSync = function (p, ...rest) {
  if (/api-token$/.test(String(p))) { const e = new Error('ENOENT (release.check)'); e.code = 'ENOENT'; throw e; }
  return read.call(this, p, ...rest);
};
fs.existsSync = (p) => (/\\.next-export[\\\\/]index\\.html$/.test(String(p)) ? true : exists(p));
syncBuiltinESMExports();
`,
    'utf8',
  );
  const canary = 'c0ffee'.repeat(10) + 'c0de';
  const r = await run(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'scripts', 'build-package.mjs')], {
    cwd: root,
    // A second NEXT_PUBLIC_* of the shell's, in lower case as Windows allows: Next inlines any of them.
    env: cleanEnv({ NEXT_PUBLIC_COP_TOKEN: canary, next_public_release_check: canary }),
    timeoutMs: 60_000,
  });
  t.check('the build ran to its end with its children replaced', r.code, 0);
  const calls = existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as Array<{ args: string[]; token: string | null; publics: string[] }>) : [];
  const nextBuild = calls.find((c) => c.args.some((a) => /next[\\/]dist[\\/]bin[\\/]next$/.test(a)) && c.args.includes('build'));
  t.truthy('it would have started next build', nextBuild, calls);
  // build-package.mjs gives its children the shell's environment without any NEXT_PUBLIC_* and pins the token to ''.
  t.truthy('next build is not handed the NEXT_PUBLIC_COP_TOKEN of the shell that runs the build', nextBuild !== undefined && (nextBuild.token === null || nextBuild.token === ''), nextBuild?.token === canary ? 'the canary token was passed through' : nextBuild);
  t.check(
    'nor any other NEXT_PUBLIC_* variable of that shell',
    (nextBuild?.publics ?? []).filter((k) => !/^NEXT_PUBLIC_COP_(API|TOKEN)$/.test(k)),
    [],
  );
});

await section('cop run refuses before any browser opens', async () => {
  /*
   * Each file carries two independent reasons to refuse (isolation "none" and an empty program
   * allowlist, with --unattended), so a regression in one of them fails an assertion here rather
   * than going on to open Edge. Each run has a browser profile and a data folder of its own, and
   * after each both must still be absent: Edge makes its profile folder the moment it is launched,
   * and the session store makes the data folder before a session is created. A browser killed
   * with the run's process tree would leave the folder behind even if it is gone from the table.
   */
  const dir = join(base, 'run');
  const refusal = async (name: string, body: Record<string, unknown>): Promise<Ran> => {
    const own = join(dir, name);
    mkdirSync(own, { recursive: true });
    const dataDir = join(own, 'data');
    const profileDir = join(own, 'profile');
    const file = join(own, 'run.yaml');
    // JSON is YAML, and it escapes the backslashes of a Windows path.
    writeFileSync(file, JSON.stringify({ dataDir, copilot: { profileDir }, ...body }, null, 2), 'utf8');
    const r = await cop(['run', file, '--unattended'], own);
    t.check(`${name}: no data folder was made (nothing was recorded)`, existsSync(dataDir), false);
    t.check(`${name}: no browser profile folder was made (Edge was never launched)`, existsSync(profileDir), false);
    const edges = edgeProcesses();
    t.truthy(`${name}: the process table can be read`, edges !== null);
    const ours = edges ? [...edges].filter(([, cmd]) => cmd.toLowerCase().includes(own.toLowerCase())) : [];
    t.check(`${name}: no Edge is running with this run's profile`, ours.map(([pid]) => pid), []);
    // Started by this check's own run, so this check stops them: they would hold the folder.
    for (const [pid] of ours) killTree(pid);
    return r;
  };

  const unisolated = await refusal('isolation-none', { task: 'x', execution: { isolation: 'none' } });
  t.check('unattended with execution.isolation "none": exit 1', unisolated.code, 1);
  t.truthy('within 20 s', unisolated.ms < 20_000, `${unisolated.ms} ms`);
  t.truthy('saying execution.isolation is why', /execution\.isolation/.test(unisolated.stderr), unisolated.stderr.slice(0, 400));

  const noTask = await refusal('no-task', { execution: { isolation: 'none' } });
  t.check('a run.yaml without a task: exit 1', noTask.code, 1);
  t.truthy('saying it has no "task"', noTask.stderr.includes('has no "task"'), noTask.stderr.slice(0, 400));

  const sometimes = await refusal('mode-sometimes', { task: 'x', execution: { mode: 'sometimes', isolation: 'none' } });
  t.check('execution.mode "sometimes": exit 1', sometimes.code, 1);
  t.truthy('naming execution.mode', /execution\.mode/.test(sometimes.stderr), sometimes.stderr.slice(0, 400));
});

await section('cop doctor names a default model the picker lacks, and a settings file that is broken', async () => {
  // `npm ping` goes to a registry on 127.0.0.1 that answers everything: the check stays on this
  // machine, and the npm line is not what decides the result.
  const registry = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => registry.listen(0, '127.0.0.1', () => r()));
  const registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`;
  try {
    const doctor = async (model: string, settings = JSON.stringify({ copilot: { defaultModel: model } })): Promise<Ran & { problems: number }> => {
      const data = join(base, `doctor-${model}`);
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, 'settings.json'), settings, 'utf8');
      writeFileSync(join(data, 'models.json'), JSON.stringify({ options: [{ name: 'Auto' }] }), 'utf8');
      const r = await cop(['doctor'], data, cleanEnv({ COP_DATA_DIR: data, npm_config_registry: registryUrl }), 90_000);
      const m = /(\d+) problem\(s\) to fix first/.exec(r.stdout);
      return { ...r, problems: m ? Number(m[1]) : /\bReady\./.test(r.stdout) ? 0 : -1 };
    };
    const [nope, auto, broken, marked] = await Promise.all([
      doctor('Nope'),
      doctor('Auto'),
      doctor('broken', '{broken'),
      doctor('marked', `${String.fromCharCode(0xfeff)}${JSON.stringify({ copilot: { defaultModel: 'Auto' } })}`),
    ]);
    t.truthy('with defaultModel "Nope": FAIL default model "Nope" is not in the picker', /FAIL\s+default model "Nope" is not in the picker/.test(nope.stdout), nope.stdout);
    t.check('and it exits 1', nope.code, 1);
    t.truthy('with defaultModel "Auto": ok default model "Auto" is in the picker', /\bok\s+default model "Auto" is in the picker/.test(auto.stdout), auto.stdout);
    // Everything else about this machine is the same in both runs, so the model is the one difference.
    t.check('the unknown model is exactly one more problem than the known one', nope.problems - auto.problems, 1);

    // Read as the API reads it: a file it will not start on is the problem to name, not a file to
    // take for empty. Taken for empty, doctor said "isolation: none" and "no default model is set"
    // of a file that may say otherwise, and never that it was broken.
    t.truthy('with settings.json "{broken": FAIL naming the file, why, and that the API will not start on it',
      /FAIL\s+\S*settings\.json is not valid JSON .*the API will not start until it is mended or deleted/.test(broken.stdout), broken.stdout);
    t.check('and nothing said about what the broken file holds',
      [/isolation:/.test(broken.stdout), /no default model is set/.test(broken.stdout), broken.code], [false, false, 1]);
    // A file saved by hand in Notepad starts with a byte-order mark; it is read, as the API reads it.
    t.truthy('a settings file that starts with a byte-order mark is read: ok default model "Auto" is in the picker',
      /\bok\s+default model "Auto" is in the picker/.test(marked.stdout) && !/settings\.json/.test(marked.stdout), marked.stdout);
  } finally {
    await new Promise((r) => registry.close(r));
  }
});

await section('the API survives a stray rejection, and fails loudly on a taken port', async () => {
  // main.ts is the process `npm start` and `cop start` run. A promise nobody reads any more that
  // rejects (a losing Promise.race branch once took a batch of three sessions down) is logged and
  // the process goes on.
  const dir = join(base, 'api');
  const mk = (name: string): string => {
    const data = join(dir, name, 'data');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'settings.json'), JSON.stringify({ runsDir: join(dir, name, 'runs') }), 'utf8');
    return data;
  };
  const stray = join(dir, 'stray.mjs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    stray,
    `await import(process.argv[2]);\nsetTimeout(() => { void Promise.reject(new Error('stray rejection from release.check')); }, 500);\n`,
    'utf8',
  );
  const mainUrl = pathToFileURL(join(root, 'src', 'api', 'main.ts')).href;
  const port = await freePort();
  const health = `http://127.0.0.1:${port}/api/health`;
  const envFor = (name: string): NodeJS.ProcessEnv =>
    cleanEnv({ COP_DATA_DIR: mk(name), COP_API_PORT: String(port), COP_PROJECT_ROOT: join(dir, name) });

  const first = spawn(process.execPath, ['--import', tsx, stray, mainUrl], { cwd: dir, env: envFor('first'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let firstErr = '';
  first.stderr.setEncoding('utf8').on('data', (c: string) => (firstErr += c));
  first.stdout.resume();
  try {
    // The rejection fires half a second in, before the API has bound its port: without the handler
    // the process dies there, and this wait ends on the exit instead of running out.
    const state = await waitFor(
      'the API to answer, or its exit',
      async () => (first.exitCode !== null ? 'exited' : (await fetch(health)).status === 200 ? 'up' : false),
      60_000,
    ).catch(() => 'timed out');
    t.truthy('the API came up and did not die of the stray rejection', state === 'up', `${state}: ${firstErr.slice(-1200)}`);
    await waitFor('the stray rejection to be logged', async () => firstErr.includes('unhandled rejection (the run continues)'), 30_000).catch(() => false);
    t.truthy('stderr says: unhandled rejection (the run continues)', firstErr.includes('unhandled rejection (the run continues)'), firstErr.slice(0, 600));
    if (state !== 'up') return;
    await new Promise((r) => setTimeout(r, 2_000));
    t.check('two seconds later the process is still running', first.exitCode, null);
    t.check('and /api/health still answers 200', (await fetch(health)).status, 200);

    // A second API on the same port must not sit there looking started: it says so and exits 1.
    const second = await run(process.execPath, ['--import', tsx, join(root, 'src', 'api', 'main.ts')], { cwd: dir, env: envFor('second'), timeoutMs: 45_000 });
    t.check('a second API on the same port exits with code 1', second.code, 1);
    t.truthy('saying the address is in use', /EADDRINUSE|address already in use/i.test(second.stderr), second.stderr.slice(0, 600));
    t.check('and the first one is unaffected', (await fetch(health)).status, 200);
  } finally {
    await stopChild(first);
    await waitFor('the port to be free', async () => await portFree(port), 15_000).catch(() => false);
  }
});

await section('decision pin: the token and npm start', async () => {
  /*
   * The operator's decision: `npm start` (scripts/dev.mjs) stays as it is. What it does with the
   * token is pinned here, both halves, by running dev.mjs itself with child_process.spawn and
   * spawnSync replaced before it loads: no tsc, no Next, no port check, no icacls are run; each
   * child it would start is written down with the environment it would get. COP_DATA_DIR points at
   * a folder of this check's own, where dev.mjs makes its token, and the shell carries a canary
   * NEXT_PUBLIC_COP_TOKEN. The API child — whose environment every command step used to inherit —
   * must get no token by any name; the dev web server gets the one from <data>/api-token, and Next
   * inlines it into the dev chunks through web/lib/api.ts's fallback.
   */
  const devData = join(base, 'dev-data');
  mkdirSync(devData, { recursive: true });
  const record = join(base, 'dev-children.json');
  const preload = join(base, 'dev-preload.mjs');
  writeFileSync(
    preload,
    `import cp from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
const calls = [];
const save = () => fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(calls), 'utf8');
const tokenNow = () => { try { return fs.readFileSync(join(process.env.COP_DATA_DIR, 'api-token'), 'utf8').trim(); } catch { return ''; } };
cp.spawnSync = (cmd, args = [], opts = {}) => {
  calls.push({ kind: 'spawnSync', cmd: String(cmd), args: (args ?? []).map(String) });
  save();
  return { status: 0, stdout: '', stderr: '', output: [], pid: 0, signal: null };
};
cp.spawn = (cmd, args = [], opts = {}) => {
  const env = opts.env ?? process.env;
  const tok = tokenNow();
  calls.push({
    kind: 'spawn',
    cmd: String(cmd),
    args: (args ?? []).map(String),
    hasToken: Object.prototype.hasOwnProperty.call(env, 'NEXT_PUBLIC_COP_TOKEN'),
    token: env.NEXT_PUBLIC_COP_TOKEN ?? null,
    telemetry: env.NEXT_TELEMETRY_DISABLED ?? null,
    carriers: tok ? Object.keys(env).filter((k) => String(env[k]).toLowerCase().includes(tok.toLowerCase())) : null,
  });
  save();
  // A child that never starts and never ends: pid 0, so nothing is ever signalled or killed.
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 0;
  child.exitCode = null;
  child.kill = () => true;
  child.unref = () => child;
  return child;
};
syncBuiltinESMExports();
`,
    'utf8',
  );
  const canary = 'feed'.repeat(16);
  const r = await run(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'scripts', 'dev.mjs')], {
    cwd: base,
    env: cleanEnv({ COP_DATA_DIR: devData, NEXT_PUBLIC_COP_TOKEN: canary }),
    timeoutMs: 60_000,
  });
  t.check('npm start\'s starter ran to its end with its children replaced', r.code, 0);
  type DevCall = { kind: string; cmd: string; args: string[]; hasToken?: boolean; token?: string | null; telemetry?: string | null; carriers?: string[] | null };
  const calls = existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as DevCall[]) : [];
  const spawned = calls.filter((c) => c.kind === 'spawn');
  const api = spawned.find((c) => /dist[\\/]src[\\/]api[\\/]main\.js$/.test(c.args[0] ?? ''));
  const web = spawned.find((c) => /next[\\/]dist[\\/]bin[\\/]next$/.test(c.args[0] ?? '') && c.args.includes('dev'));
  t.truthy('it starts the API child', api, r.stdout.slice(-800) + r.stderr.slice(-800));
  t.truthy('and the dev web server', web, spawned.map((c) => c.args.join(' ')));
  let token = '';
  try {
    token = readFileSync(join(devData, 'api-token'), 'utf8').trim();
  } catch {
    /* checked next */
  }
  t.truthy('it made the token in COP_DATA_DIR/api-token', /^[0-9a-f]{64}$/.test(token));
  t.check('the API child has no NEXT_PUBLIC_COP_TOKEN (the canary in the shell was dropped too)', api?.hasToken, false);
  t.check('and no variable of the API child carries the token under another name', api?.carriers, []);
  // Pinned as it is today: the dev UI gets the token at build time (the operator's accepted flow).
  t.truthy('the dev web server is handed the token from COP_DATA_DIR/api-token (pinned: npm start does not change)', token !== '' && web?.token === token, web?.token === canary ? 'the shell\'s canary was passed through' : web?.token);
  t.check('under that one name only', web?.carriers, ['NEXT_PUBLIC_COP_TOKEN']);
  t.check('both children have Next telemetry off', [api?.telemetry, web?.telemetry], ['1', '1']);
  t.truthy('the dev web server binds 127.0.0.1 only', web !== undefined && web.args.join(' ').includes('-H 127.0.0.1'), web?.args);
  const webGetsToken = token !== '' && web?.token === token;

  const apiTs = code('web/lib/api.ts');
  t.truthy('web/lib/api.ts reads process.env.NEXT_PUBLIC_COP_TOKEN as its fallback, so the dev chunks carry it', /process\.env\.NEXT_PUBLIC_COP_TOKEN/.test(apiTs));

  /*
   * With that pinned, the doc comment on apiToken() in web/lib/api.ts must not say the token "is no
   * longer in any file the web server hands out", as it once did. That is true of the package's
   * static interface only: `npm start`'s dev server hands it out in every chunk that imports api.ts,
   * and a reader deciding whether a command step can reach the token would be told it cannot. The
   * claim may stand only if the same sentence limits it (static interface, package, cop start).
   */
  const whole = readFileSync(join(root, 'web', 'lib', 'api.ts'), 'utf8');
  const doc = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*export function apiToken/.exec(whole)?.[1] ?? '';
  const prose = doc.replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ');
  const claim = /[^.]*no longer in any file the web server hands out[^.]*\./i.exec(prose)?.[0]?.trim() ?? '';
  const limited = /static|package|cop start|installed|except|dev server|npm start (still|builds|compiles)/i.test(claim);
  t.truthy('found the doc comment of apiToken() in web/lib/api.ts', doc !== '');
  // The comment now says which page carries the token in its chunks (npm start's) and which does not (the package's).
  t.truthy(
    "web/lib/api.ts does not claim, unqualified, that no served file holds the token while npm start's dev chunks do",
    !(webGetsToken && claim !== '' && !limited),
    claim,
  );
});

try {
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
} catch (e) {
  console.log(`(could not remove ${base}: ${(e as Error).message}; it is a temporary folder of this check and can be deleted by hand)`);
}

t.finish();
