/**
 * The scripts of package.json a command line runs (2026-10-27): `npm run build`, `npm test`, `pnpm lint`, `yarn dev`.
 *
 * The operator: "whether I allow npm … scripts that are already there, and another box for scripts the bot created".
 * A script of package.json is a command line someone wrote into the project; one the bot added or changed is a script
 * the bot wrote, as much as a `.ps1` is, and it used to run unread. So each one a line runs is told apart here: the
 * project's, the same as it was in the last commit before the work began; or the work's, added or changed since.
 *
 * Read only from what the line says: which runner, which script, in which folder (`--prefix`, `-C`, `--dir`, `--cwd`)
 * and which workspace (`-w`, `--workspace`; `--workspaces`, `-r`, `--filter` for all of them). A name the line builds
 * at run time cannot be told and is taken as written during the work.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { gitSync } from '../vcs/git.js';
import { scanCommandHeads } from './commandHeads.js';

export type PackageScriptRun = {
  /** The package.json, as a full path. */
  pkg: string;
  name: string;
  /** Its command line now; null when package.json has no such script. */
  command: string | null;
  /** The name is built at run time. */
  dynamic?: boolean;
};

const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** The runners' own commands, which a bare word after them is before it is a script's name (pnpm, yarn and bun run a script by its name alone). */
const OWN_COMMANDS = new Set([
  'add', 'audit', 'bin', 'cache', 'ci', 'config', 'create', 'dedupe', 'deploy', 'dlx', 'doctor', 'env', 'exec', 'explain', 'fetch', 'help',
  'i', 'import', 'info', 'init', 'install', 'link', 'list', 'login', 'logout', 'ls', 'node', 'outdated', 'pack', 'patch', 'pm', 'prune', 'publish',
  'rebuild', 'remove', 'rm', 'root', 'run', 'run-script', 'server', 'set', 'setup', 'store', 'tag', 'test', 't', 'unlink', 'up', 'update',
  'upgrade', 'version', 'why', 'workspace', 'workspaces',
]);
/** Switches that take the next word as their value. */
const TAKES_VALUE = /^(?:--prefix|-C|--dir|--cwd|-w|--workspace|--filter|-F|--userconfig|--cache|--registry|--loglevel|--script-shell|--reporter)$/;

const readScripts = (text: string | null): Record<string, string> | null => {
  if (text === null) return null;
  try {
    const value = JSON.parse(text.replace(/^﻿/, '')) as { scripts?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value.scripts ?? {})) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return null;
  }
};

const scriptsOnDisk = (pkg: string): Record<string, string> | null => {
  try {
    return readScripts(readFileSync(pkg, 'utf8'));
  } catch {
    return null;
  }
};

/** Every package.json under a folder, the git-ignored ones (node_modules) left out. */
function workspacePackages(dir: string): string[] {
  const listed = gitSync(dir, ['ls-files', '-co', '--exclude-standard', '--', 'package.json', '**/package.json']);
  const found = listed.ok ? listed.stdout.split('\n').filter((p) => p && !/(^|\/)node_modules\//.test(p)).map((p) => resolve(dir, p)) : [];
  if (existsSync(join(dir, 'package.json')) && !found.some((p) => p === join(dir, 'package.json'))) found.unshift(join(dir, 'package.json'));
  return found;
}

/** The scripts of package.json this line runs, with the package.json each one is in. */
export function packageScriptsRun(command: string, cwd: string, shell?: string): PackageScriptRun[] {
  const out: PackageScriptRun[] = [];
  for (const call of scanCommandHeads(command, shell ?? 'pwsh').calls) {
    const runner = call.head.replace(/^.*[\\/]/, '').replace(/\.(?:exe|cmd|ps1)$/i, '').toLowerCase();
    if (!RUNNERS.has(runner)) continue;
    let folder: string | undefined;
    let workspace: string | undefined;
    let everyWorkspace = false;
    const words: Array<{ literal: string; dynamic: boolean }> = [];
    for (let i = 0; i < call.args.length; i++) {
      const a = call.args[i]!;
      const [flag, inline] = a.literal.startsWith('-') && a.literal.includes('=') ? [a.literal.slice(0, a.literal.indexOf('=')), a.literal.slice(a.literal.indexOf('=') + 1)] : [a.literal, undefined];
      if (flag === '--') break;
      if (flag.startsWith('-')) {
        const value = inline ?? (TAKES_VALUE.test(flag) ? call.args[++i]?.literal : undefined);
        if (flag === '--prefix' || flag === '-C' || flag === '--dir' || flag === '--cwd') folder = value;
        else if (flag === '-w' || flag === '--workspace') workspace = value;
        else if (flag === '--workspaces' || flag === '-ws' || flag === '-r' || flag === '--recursive' || flag === '--filter' || flag === '-F') everyWorkspace = true;
        continue;
      }
      words.push(a);
    }
    const base = resolve(cwd, folder ?? '.');
    const packages = (): string[] => {
      if (everyWorkspace) return workspacePackages(base);
      if (workspace) {
        const own = resolve(base, workspace, 'package.json');
        return existsSync(own) ? [own] : workspacePackages(base);
      }
      return [join(base, 'package.json')];
    };
    const sub = words[0];
    if (!sub) continue;
    const verb = sub.literal.toLowerCase();
    let name: { literal: string; dynamic: boolean } | undefined;
    let implicit = false;
    if (verb === 'run' || verb === 'run-script' || verb === 'rum' || verb === 'urn') name = words[1];
    else if (runner !== 'bun' && (verb === 'test' || verb === 't' || verb === 'tst')) name = { literal: 'test', dynamic: false };
    else if (verb === 'start' || verb === 'stop' || verb === 'restart') name = { literal: verb, dynamic: false };
    else if (runner !== 'npm' && !OWN_COMMANDS.has(verb)) {
      // `pnpm lint`, `yarn dev`, `bun dev`: a script only when package.json has one by that name.
      name = sub;
      implicit = true;
    }
    if (!name) continue;
    // `bun run x.ts` is a file of code, not a script: see `codeFilesRun`.
    if (runner === 'bun' && /[\\/]|\.[cm]?[jt]sx?$/i.test(name.literal)) continue;
    for (const pkg of packages()) {
      if (name.dynamic) {
        out.push({ pkg, name: name.literal, command: null, dynamic: true });
        continue;
      }
      const scripts = scriptsOnDisk(pkg);
      // npm is given npm_config_ignore_scripts (`stepEnv.ts`), which leaves pre- and post- scripts out; yarn and bun run them.
      const names: string[] = runner === 'yarn' || runner === 'bun' ? [`pre${name.literal}`, name.literal, `post${name.literal}`] : [name.literal];
      for (const n of names) {
        const cmd = scripts?.[n] ?? null;
        if (cmd === null && (n !== name.literal || implicit)) continue;
        out.push({ pkg, name: n, command: cmd });
      }
    }
  }
  return out;
}

/** Whether a line writes package.json's scripts itself: `npm pkg set scripts.x=…`, `npm set-script`, or the file written. */
export function writesPackageScripts(command: string): boolean {
  return (
    /\b(?:npm|pnpm)(?:\.cmd)?\s+(?:pkg\s+set\b[^|;\n]*\bscripts\.|set-script\b)/i.test(command) ||
    /\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Tee-Object|sc|ac|cp|copy|mv|move|tee)\b[^|;\n]*package\.json\b|>\s*["']?[^\s"']*package\.json\b/i.test(command)
  );
}

/**
 * Why a script of package.json was written during the work, or null when it is the project's: the same as in the last
 * commit before the work began. A package.json git does not know is the project's when it was made before then (and
 * its scripts cannot be told apart further). `sameLine`: the line itself writes package.json's scripts.
 */
export function packageScriptWritten(run: PackageScriptRun, since: string | undefined, sameLine: boolean): string | null {
  if (run.dynamic) return 'its name is decided when the line runs, so nothing tells whose it is';
  if (run.command === null) return sameLine ? 'this same line writes it into package.json' : null;
  const began = since ? Date.parse(since) : NaN;
  const top = gitSync(dirname(run.pkg), ['rev-parse', '--show-toplevel']);
  if (top.ok && top.stdout) {
    const rel = relative(top.stdout, run.pkg);
    const path = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : null;
    const known = path !== null && gitSync(top.stdout, ['log', '-1', '--format=%H', '--', path]).stdout.trim() !== '';
    if (path && known) {
      const at = Number.isFinite(began) ? gitSync(top.stdout, ['rev-list', '-1', `--before=@${Math.floor(began / 1000)}`, 'HEAD']) : gitSync(top.stdout, ['rev-parse', 'HEAD']);
      const commit = at.ok ? at.stdout.trim() : '';
      if (!commit) return 'package.json had no commit before this work began';
      const then = gitSync(top.stdout, ['show', `${commit}:${path}`]);
      const before = then.ok ? readScripts(then.stdout) : {};
      const was = before?.[run.name];
      if (was === run.command) return null;
      return was === undefined ? 'it was added to package.json during this work' : 'it was changed in package.json during this work';
    }
  }
  if (!Number.isFinite(began)) return null;
  let born = NaN;
  try {
    born = statSync(run.pkg).birthtimeMs;
  } catch {
    /* not there: npm says so */
  }
  return Number.isFinite(born) && born >= began - 1000 ? 'package.json was made during this work and is not committed' : null;
}
