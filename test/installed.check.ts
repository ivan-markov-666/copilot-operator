/**
 * A clone whose node_modules are not what its package-lock.json names is said so before anything is built
 * (scripts/installed.mjs). The case that brought it: 0.1.54 added mermaid to web/, a checkout fast-forwarded to it
 * by git alone kept its old node_modules, and `npm publish` there compiled the API and then stopped deep inside
 * Next at "Can't resolve 'mermaid'". Held here:
 *
 * - on folders made for it: a package not installed, one installed at another version, one of a workspace held in
 *   the workspace's own node_modules, a scoped name, a workspace's link to another, an optional one left out, no
 *   lockfile;
 * - this clone is as its lockfile says (so the build and `npm start` here are not stopped for nothing);
 * - scripts/build-package.mjs, with one dependency of web/ hidden from it, says which, and the command, and starts
 *   neither tsc nor next; scripts/dev.mjs (`npm start`) likewise starts nothing.
 *
 *   npm run check:installed
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tally } from './support/harness.js';

type Stale = { name: string; of: string; wanted: string; found: string | null };
const { notInstalled, notInstalledLines } = (await import(pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'installed.mjs')).href)) as {
  notInstalled: (root: string) => Stale[];
  notInstalledLines: (list: Stale[]) => string[];
};

const t = new Tally();
const root = join(import.meta.dirname, '..');
const base = mkdtempSync(join(tmpdir(), 'cop-installed-'));
process.once('exit', () => rmSync(base, { recursive: true, force: true }));

const json = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
};
/** A package as npm leaves it in node_modules: its folder and its package.json. */
const installed = (dir: string, key: string, version: string): void => json(join(dir, key, 'package.json'), { name: key.replace(/^.*node_modules\//, ''), version });

{
  // A root with a workspace, as this repository is.
  const dir = join(base, 'clone');
  json(join(dir, 'package.json'), { name: 'app', workspaces: ['web'], dependencies: { yaml: '^2.0.0', '@scope/tool': '^1.0.0' }, devDependencies: { typescript: '^5.0.0' }, optionalDependencies: { fsevents: '^2.0.0' } });
  json(join(dir, 'web', 'package.json'), { name: 'web', dependencies: { next: '^15.0.0', mermaid: '12.2.0', react: '^19.0.0', shared: '*' } });
  json(join(dir, 'package-lock.json'), {
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', workspaces: ['web'] },
      web: { name: 'web' },
      'node_modules/web': { resolved: 'web', link: true },
      'node_modules/shared': { resolved: 'shared', link: true },
      'node_modules/yaml': { version: '2.9.1' },
      'node_modules/@scope/tool': { version: '1.2.3' },
      'node_modules/typescript': { version: '5.9.3', dev: true },
      'node_modules/fsevents': { version: '2.3.3', optional: true },
      'node_modules/next': { version: '15.5.25' },
      'node_modules/mermaid': { version: '12.2.0' },
      'node_modules/react': { version: '18.3.1' },
      'web/node_modules/react': { version: '19.3.0' },
    },
  });
  for (const [key, version] of [
    ['node_modules/yaml', '2.9.1'],
    ['node_modules/@scope/tool', '1.2.3'],
    ['node_modules/typescript', '5.9.3'],
    ['node_modules/next', '15.5.25'],
    ['node_modules/mermaid', '12.2.0'],
    ['node_modules/react', '18.3.1'],
    ['web/node_modules/react', '19.3.0'],
  ] as const) {
    installed(dir, key, version);
  }
  t.check('as the lockfile says: nothing to say (a link to a workspace, an optional package not installed, a scoped one)', notInstalled(dir), []);

  rmSync(join(dir, 'node_modules', 'mermaid'), { recursive: true });
  installed(dir, 'node_modules/next', '15.5.20');
  installed(dir, 'web/node_modules/react', '18.3.1');
  installed(dir, 'node_modules/@scope/tool', '1.0.0');
  t.check(
    "one not installed, others at another version — a workspace's in its own node_modules",
    notInstalled(dir),
    [
      { name: '@scope/tool', of: '', wanted: '1.2.3', found: '1.0.0' },
      { name: 'mermaid', of: 'web', wanted: '12.2.0', found: null },
      { name: 'next', of: 'web', wanted: '15.5.25', found: '15.5.20' },
      { name: 'react', of: 'web', wanted: '19.3.0', found: '18.3.1' },
    ],
  );
  t.check('said a line a package', notInstalledLines(notInstalled(dir))[1], 'mermaid (web): package-lock.json names 12.2.0, not installed');

  rmSync(join(dir, 'package-lock.json'));
  t.check('no lockfile: nothing to compare with, nothing said', notInstalled(dir), []);
}

t.check('this clone is as its lockfile says', notInstalledLines(notInstalled(root)), []);

/*
 * The two scripts run for real, with one dependency of web/ hidden from them and their children replaced before they
 * load: reading the hidden package's files fails as if it were not there, and every child a script would start is
 * written down instead.
 */
const web = JSON.parse(readFileSync(join(root, 'web', 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
const hidden = 'mermaid';
t.truthy('control: web/ depends on the package hidden here', web.dependencies && hidden in web.dependencies, web.dependencies);
const lockVersion = (JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> }).packages[`node_modules/${hidden}`]?.version;

const runHidden = (script: string): { code: number | null; out: string; spawned: string[][] } => {
  const record = join(base, `${script}.spawned.json`);
  const preload = join(base, `${script}.preload.mjs`);
  writeFileSync(
    preload,
    `import cp from 'node:child_process';
import fs from 'node:fs';
import { resolve, sep } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const spawned = [];
const write = fs.writeFileSync;
const save = () => write(${JSON.stringify(record)}, JSON.stringify(spawned), 'utf8');
save();
const gone = [${JSON.stringify(join(root, 'node_modules', hidden))}, ${JSON.stringify(join(root, 'web', 'node_modules', hidden))}].map((p) => resolve(p).toLowerCase());
const isGone = (p) => { const k = resolve(String(p)).toLowerCase(); return gone.some((g) => k === g || k.startsWith(g + sep)); };
const enoent = () => { const e = new Error('ENOENT (installed.check)'); e.code = 'ENOENT'; return e; };
const read = fs.readFileSync;
const exists = fs.existsSync;
fs.readFileSync = function (p, ...rest) { if (isGone(p)) throw enoent(); return read.call(this, p, ...rest); };
fs.existsSync = (p) => (isGone(p) ? false : exists(p));
cp.spawnSync = (cmd, args = []) => { spawned.push([String(cmd), ...args.map(String)]); save(); return { status: 0, stdout: '', stderr: '', output: [], pid: 0, signal: null }; };
cp.spawn = (cmd, args = []) => { spawned.push([String(cmd), ...args.map(String)]); save(); throw new Error('spawn replaced (installed.check)'); };
syncBuiltinESMExports();
`,
    'utf8',
  );
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(cop_|next_public_)/i.test(k)) env[k] = v;
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'scripts', script)], { cwd: root, env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const spawned = existsSync(record) ? (JSON.parse(readFileSync(record, 'utf8')) as string[][]) : [];
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, spawned };
};

const line = `${hidden} (web): package-lock.json names ${lockVersion}, not installed`;
{
  const r = runHidden('build-package.mjs');
  t.check('the package build stops at once', r.code, 1);
  t.truthy('naming the package, its version and the command', r.out.includes(line) && r.out.includes('npm install'), r.out);
  t.check('and starts neither tsc nor next', r.spawned, []);
}
{
  const r = runHidden('dev.mjs');
  t.check('npm start stops at once', r.code, 1);
  t.truthy('naming the package and the command', r.out.includes(line) && r.out.includes('npm install'), r.out);
  t.check('and starts nothing', r.spawned, []);
}

t.finish();
