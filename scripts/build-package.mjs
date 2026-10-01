#!/usr/bin/env node
/**
 * Builds what the npm package carries: the compiled API and CLI in `dist/`, and the web interface
 * as static files in `dist/web/`, which the API serves itself when installed from npm.
 *
 *   npm run build:package        (also run by `npm pack` and `npm publish`, as `prepack`)
 *
 * The interface is built with `COP_EXPORT=1` into its own folder (`web/.next-export`, where Next
 * writes the static export when a distDir is set), so a `npm start` dev server running from the
 * same clone is not disturbed. Its API address is the relative `/api`, since the page and the API
 * come from one origin.
 *
 * Plain .mjs, run by node: nothing here may depend on a build that has not happened yet.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'web');
const log = (line) => process.stdout.write(`[package] ${line}\n`);
const die = (line) => {
  process.stderr.write(`[package] ${line}\n`);
  process.exit(1);
};
/** A path as the messages show it: from the repository root, with forward slashes. */
const shown = (p) => relative(root, p).replace(/\\/g, '/');

/** A package's CLI entry, wherever npm put it: the root or the web workspace. */
function bin(rel) {
  for (const base of [root, web]) {
    const p = join(base, 'node_modules', rel);
    if (existsSync(p)) return p;
  }
  die(`${rel} is not installed; run npm install first`);
}

/*
 * What every child of this build inherits: the shell's environment without a single NEXT_PUBLIC_*
 * variable. Next compiles each one it is handed into the browser chunks, so a shell that holds
 * NEXT_PUBLIC_COP_TOKEN (one that ran npm start's environment does) would bake this machine's API
 * token into every copy of the package. Only the values a step names itself reach the page. The
 * names are compared without regard to case, because Windows treats `next_public_cop_token` as the
 * same variable.
 */
function inheritedEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^NEXT_PUBLIC_/i.test(k)) env[k] = v;
  return env;
}

function run(label, args, cwd, env = {}) {
  log(label);
  const r = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true, env: { ...inheritedEnv(), ...env } });
  if (r.status !== 0) die(`${label} failed`);
}

run('compiling the API and the CLI', [bin('typescript/bin/tsc'), '-p', 'tsconfig.json'], root);

/**
 * The source a compiled file is made from: tsconfig.json compiles `<name>.ts` to `<name>.js`, and to
 * `<name>.d.ts` and source maps if those are ever switched on. Anything else has no source.
 */
function sourceOf(name) {
  const m = /^(.*?)(?:\.d\.ts|\.js)(?:\.map)?$/i.exec(name);
  return m ? `${m[1]}.ts` : null;
}

/** Removes every file under `out` that has no source under `src`, and the folders that leaves empty. */
function pruneCompiled(out, src) {
  const removed = [];
  for (const entry of readdirSync(out, { withFileTypes: true })) {
    const file = join(out, entry.name);
    if (entry.isDirectory()) {
      removed.push(...pruneCompiled(file, join(src, entry.name)));
      try {
        // Only an empty folder goes: rmdir refuses one that still holds compiled files, or that
        // another build has just written into.
        rmdirSync(file);
      } catch {
        // Not empty, which is the usual case.
      }
      continue;
    }
    const source = sourceOf(entry.name);
    if (source && existsSync(join(src, source))) continue;
    rmSync(file, { force: true });
    removed.push(file);
  }
  return removed;
}

/*
 * tsc writes dist/ but never removes a file whose source is gone, and package.json's `files` ships
 * all of dist/src. So a module deleted from src/ (the project mirror, the Desktop copies and the
 * file attachments were, on purpose) would still be installed on every machine that takes the next
 * release. The output is pruned after compiling rather than emptied before it: `npm start` runs the
 * API from dist/src/api/main.js and another build may be running in this clone, and neither must
 * find dist/src empty or half-written. A file stays only when tsc could have made it from a source
 * that is still there. The folders are the ones tsconfig.json compiles.
 */
const stale = [];
for (const folder of ['src', 'scripts']) {
  const out = join(root, 'dist', folder);
  if (existsSync(out)) stale.push(...pruneCompiled(out, join(root, folder)));
}
if (stale.length > 0) log(`removed ${stale.length} compiled file(s) whose source is gone: ${stale.map(shown).join(', ')}`);

const exported = join(web, '.next-export');
rmSync(exported, { recursive: true, force: true });
/*
 * NEXT_PUBLIC_COP_TOKEN is set, to nothing, rather than only left out: Next then compiles the
 * `process.env.NEXT_PUBLIC_COP_TOKEN` fallback in web/lib/api.ts to '' instead of leaving a lookup
 * in the chunk that a build run differently could fill. The page the package serves is given its
 * token by the API that serves it, as the cop_token cookie.
 */
run('building the web interface as static files', [bin('next/dist/bin/next'), 'build'], web, {
  COP_EXPORT: '1',
  NEXT_PUBLIC_COP_API: '/api',
  NEXT_PUBLIC_COP_TOKEN: '',
  NEXT_TELEMETRY_DISABLED: '1',
});
if (!existsSync(join(exported, 'index.html'))) die('the web build produced no index.html in web/.next-export');

/** What of the export ships: the static pages and their assets, not Next's build bookkeeping beside them. */
const ships = (path) => {
  const rel = path.slice(exported.length).replace(/\\/g, '/');
  if (rel.startsWith('/_next/')) return true;
  return !/^\/(cache|server|types|trace|diagnostics)(\/|$)/i.test(rel) && !/\.json$/i.test(rel);
};

/*
 * The interface of an earlier build goes first, whatever this one finds below. It was built from
 * other sources, and a clone's API serves dist/web whenever it holds an index.html
 * (src/config/layout.ts), so a build refused below must leave nothing there to serve.
 */
const target = join(root, 'dist', 'web');
rmSync(target, { recursive: true, force: true });

/*
 * The one thing the package must never carry: a token baked into the page. Checked on every build,
 * whether or not this clone has a token of its own (CI has none), and on the export before any of it
 * is copied to dist/web: a build refused here leaves no interface to be served or packed. The files
 * scanned are the ones the copy below keeps. The name NEXT_PUBLIC_COP_TOKEN left in a chunk is a
 * lookup that a build run from another shell would fill, and a run of exactly 64 hex digits is what
 * an API token looks like wherever it came from. The tokens this machine does have, in the clone's
 * data folders and in the shell, are looked for by value as well; a value under 16 characters is
 * none this program made, and would be found in some file by chance. Only file names are printed,
 * never a token.
 */
const tokens = new Set();
const lookFor = (value) => {
  if (value && value.trim().length >= 16) tokens.add(value.trim().toLowerCase());
};
for (const file of [
  join(root, 'data', 'api-token'),
  join(root, '.copilot-operator', 'data', 'api-token'),
  ...(process.env.COP_DATA_DIR ? [join(process.env.COP_DATA_DIR, 'api-token')] : []),
]) {
  try {
    lookFor(readFileSync(file, 'utf8'));
  } catch {
    // Not there, as in CI.
  }
}
lookFor(process.env.NEXT_PUBLIC_COP_TOKEN);

/*
 * Read with a file or folder allowed to vanish under the scan: another build in this clone empties
 * web/.next-export when it starts, and what is gone is no longer anything this build would ship.
 */
const gone = (e) => e?.code === 'ENOENT';

/**
 * Every file under a folder that `keep` keeps, never walking into a folder it does not (Next's cache
 * beside the pages is large), or none when the folder is not there.
 */
function filesUnder(dir, keep) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (gone(e)) return [];
    throw e;
  }
  return entries.flatMap((e) => {
    const path = join(dir, e.name);
    if (!keep(path)) return [];
    return e.isDirectory() ? filesUnder(path, keep) : [path];
  });
}

const holders = [];
const names = [];
const hexRuns = [];
for (const file of filesUnder(exported, ships)) {
  let text;
  try {
    // latin1 reads any byte as one character, so fonts and images are scanned without failing.
    text = readFileSync(file, 'latin1');
  } catch (e) {
    if (gone(e)) continue;
    throw e;
  }
  const lower = text.toLowerCase();
  for (const token of tokens) if (lower.includes(token)) holders.push(shown(file));
  if (text.includes('NEXT_PUBLIC_COP_TOKEN')) names.push(shown(file));
  if (/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i.test(text)) hexRuns.push(shown(file));
}
if (holders.length > 0) die(`the built interface contains this machine's API token: ${[...new Set(holders)].join(', ')}`);
if (names.length > 0) die(`the built interface still reads NEXT_PUBLIC_COP_TOKEN, which a build from another shell would fill with a token: ${names.join(', ')}`);
if (hexRuns.length > 0) die(`the built interface holds a run of 64 hex digits, the shape of an API token: ${hexRuns.join(', ')}`);

cpSync(exported, target, { recursive: true, filter: ships });
log(`interface copied to ${target}`);
log('done');
