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
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'web');
const log = (line) => process.stdout.write(`[package] ${line}\n`);
const die = (line) => {
  process.stderr.write(`[package] ${line}\n`);
  process.exit(1);
};

/** A package's CLI entry, wherever npm put it: the root or the web workspace. */
function bin(rel) {
  for (const base of [root, web]) {
    const p = join(base, 'node_modules', rel);
    if (existsSync(p)) return p;
  }
  die(`${rel} is not installed; run npm install first`);
}

function run(label, args, cwd, env = {}) {
  log(label);
  const r = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true, env: { ...process.env, ...env } });
  if (r.status !== 0) die(`${label} failed`);
}

run('compiling the API and the CLI', [bin('typescript/bin/tsc'), '-p', 'tsconfig.json'], root);

const exported = join(web, '.next-export');
rmSync(exported, { recursive: true, force: true });
run('building the web interface as static files', [bin('next/dist/bin/next'), 'build'], web, {
  COP_EXPORT: '1',
  NEXT_PUBLIC_COP_API: '/api',
  NEXT_TELEMETRY_DISABLED: '1',
});
if (!existsSync(join(exported, 'index.html'))) die('the web build produced no index.html in web/.next-export');

const target = join(root, 'dist', 'web');
rmSync(target, { recursive: true, force: true });
// The static pages and their assets, not Next's build bookkeeping beside them.
cpSync(exported, target, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(exported.length).replace(/\\/g, '/');
    if (rel.startsWith('/_next/')) return true;
    return !/^\/(cache|server|types|trace|diagnostics)(\/|$)/i.test(rel) && !/\.json$/i.test(rel);
  },
});
log(`interface copied to ${target}`);

// The one thing the package must never carry: a token baked into the page.
const pkgToken = (() => {
  try {
    return readFileSync(join(root, 'data', 'api-token'), 'utf8').trim();
  } catch {
    return '';
  }
})();
if (pkgToken) {
  const hit = spawnSync('findstr', ['/s', '/m', '/c:' + pkgToken, join(target, '*')], { encoding: 'utf8', windowsHide: true });
  if (hit.stdout && hit.stdout.trim()) die(`the built interface contains this machine's API token: ${hit.stdout.trim()}`);
}
log('done');
