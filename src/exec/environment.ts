/**
 * The tools a run actually ran with, written down once per task.
 *
 * Between two runs of the same plan, a day apart, `npm install` fetched TypeScript 6 and then
 * 7, Next 15 and then 16, and the two runs behaved differently for reasons that took an
 * afternoon to explain. "Latest" is a moving target and a plan that pins nothing gets a new
 * world every time; the least the runner can do is say which world a run got. The project's
 * own dependencies are in its lockfile, which the runner commits; this is the layer under
 * that — the machine's Node, npm, git, both PowerShells, Edge, and the OS.
 *
 * Collected once per process and reused: versions do not change mid-run, and each probe is a
 * child process.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { release, type as osType } from 'node:os';

import { availableShells, detectShells, type Shell, type ShellInventory } from './shells.js';

export type Environment = {
  collectedAt: string;
  os: string;
  node: string;
  npm: string | null;
  git: string | null;
  pwsh: string | null;
  powershell: string | null;
  /**
   * Which shells this machine has and where, which is a different question from the versions
   * above: those say what a PowerShell answered when asked, this says what the runner will
   * find when it goes to start one, and a run that died of a missing interpreter is diagnosed
   * from the second and not the first.
   */
  shells: ShellInventory;
  edge: { path: string; version: string | null } | null;
};

let cached: Environment | null = null;

/** One probe: its trimmed stdout, or null when the tool is missing or says nothing. */
function probe(file: string, args: string[], shell = false): string | null {
  try {
    // With a shell the command is one string; Node warns about args it would only concatenate.
    const r = shell
      ? spawnSync([file, ...args].join(' '), { encoding: 'utf8', windowsHide: true, timeout: 15_000, shell: true })
      : spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    return r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim() ? r.stdout.trim().split('\n')[0].trim() : null;
  } catch {
    return null;
  }
}

const EDGE_PATHS = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];

export function collectEnvironment(fresh = false): Environment {
  if (cached && !fresh) return cached;
  const edgePath = EDGE_PATHS.find((p) => existsSync(p)) ?? null;
  const psVersion = '$PSVersionTable.PSVersion.ToString()';
  cached = {
    collectedAt: new Date().toISOString(),
    os: `${osType()} ${release()}`,
    node: process.versions.node,
    // npm is a .cmd on Windows, which spawn cannot start without a shell.
    npm: probe('npm', ['-v'], true),
    git: probe('git', ['--version'])?.replace(/^git version\s*/i, '') ?? null,
    pwsh: probe('pwsh', ['-NoProfile', '-NonInteractive', '-Command', psVersion]),
    powershell: probe('powershell', ['-NoProfile', '-NonInteractive', '-Command', psVersion]),
    shells: detectShells({ fresh }),
    edge: edgePath
      ? { path: edgePath, version: probe('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item '${edgePath}').VersionInfo.ProductVersion`]) }
      : null,
  };
  return cached;
}

/** The manifest as a block of `name : version` lines, for the task log. */
export function describeEnvironment(e: Environment, defaultShell: Shell | undefined): string {
  const at = (shell: 'pwsh' | 'powershell' | 'cmd'): string => (e.shells.found[shell] ? ` at ${e.shells.found[shell]}` : '');
  /*
   * What a command that named no shell was actually handed to.
   *
   * `execution.defaultShell` decides it whenever the machine has that shell, and only when it has
   * not does the order take over. Reporting the order's answer regardless was wrong in the one
   * case somebody would be reading this line to understand: a default of `cmd` on a machine that
   * also has PowerShell 7 would be written down here as `pwsh`, which is the opposite of what ran.
   */
  const fallback = (defaultShell && e.shells.found[defaultShell] ? defaultShell : availableShells(e.shells)[0]) ?? null;
  return [
    `os         : ${e.os}`,
    `node       : ${e.node}`,
    `npm        : ${e.npm ?? '(not found)'}`,
    `git        : ${e.git ?? '(not found)'}`,
    `pwsh       : ${e.pwsh ?? '(not found)'}${at('pwsh')}`,
    `powershell : ${e.powershell ?? '(not found)'}${at('powershell')}`,
    `cmd        : ${e.shells.found.cmd ?? '(not found)'}`,
    // The one line somebody reads when a step ran and behaved unlike the machine it was written
    // on: which interpreter a command that named no shell was handed to.
    `shell used : ${fallback ?? '(none — nothing can be run on this machine)'} when a step or a check names none`,
    `edge       : ${e.edge ? `${e.edge.version ?? '(version unknown)'} at ${e.edge.path}` : '(not found)'}`,
    `collected  : ${e.collectedAt}`,
  ].join('\n');
}
