/**
 * Where a session's commands run.
 *
 * Until now every step, every check and every review command ran in `execution.cwd`, whose
 * default is `.` — the directory the runner was started from, which for the API is this
 * project's own checkout. The first step of a nine-task plan ran with
 * `cwd=C:\Projects\automate-365` while writing files into `C:\Projects\calculator-test`, and
 * it went right only because the model used absolute paths, as the plan's instructions told it
 * to. That is a plan author compensating for a runner default: one relative path in one step
 * and the model is editing the bot. The reviewer was told the same directory in as many words,
 * "Working directory for your commands: C:\Projects\automate-365", and the implementer was told
 * nothing at all.
 *
 * A session already knows its project — `vcs.repoDir` says where the branches go and
 * `mirror.rootDir` where the files are — so that is where its commands run. The configured
 * `execution.cwd` is the fallback for a session with no project, and this project's own
 * checkout is never a fallback: a session that would land here by default does not run, and
 * says why. Landing here on purpose — the operator pointed the session at the bot itself — is
 * allowed and said out loud, because that is a decision somebody made.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '../session/model.js';

export type WorkingDir = {
  cwd: string;
  /** Where the answer came from. */
  source: 'repository' | 'mirror' | 'config';
  /** The session's project is this runner's own checkout. Allowed, because it was chosen. */
  ownCheckout: boolean;
};

export type WorkingDirProblem = { cwd: string; problem: string };

let cachedBotRoot: string | undefined;

/**
 * This project's own root: the nearest ancestor of this file with a package.json named
 * `copilot-operator`. Walks rather than counting `..`, because the file sits at one depth under
 * `src/` and another under `dist/src/`.
 */
export function botRootDir(): string {
  if (cachedBotRoot) return cachedBotRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === 'copilot-operator') return (cachedBotRoot = dir);
    } catch {
      // No package.json here, or not ours. Keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) return (cachedBotRoot = process.cwd());
    dir = parent;
  }
}

function isInside(dir: string, root: string): boolean {
  const a = resolve(dir).toLowerCase();
  const b = resolve(root).toLowerCase();
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/** Whether a directory is, or is inside, this runner's own checkout. */
export function isOwnCheckout(dir: string, own = botRootDir()): boolean {
  return isInside(dir, own);
}

/**
 * Decides the directory a session's commands run in, or refuses.
 *
 * `configCwd` is `execution.cwd` already resolved; `own` is this runner's root, a parameter so
 * the rule can be exercised against a made-up one.
 */
export function workingDirFor(
  session: Pick<Session, 'vcs' | 'mirror'>,
  configCwd: string,
  own = botRootDir(),
): WorkingDir | WorkingDirProblem {
  const repo = (session.vcs?.repoDir ?? '').trim();
  const mirror = (session.mirror?.rootDir ?? '').trim();
  if (repo) return { cwd: resolve(repo), source: 'repository', ownCheckout: isInside(repo, own) };
  if (mirror) return { cwd: resolve(mirror), source: 'mirror', ownCheckout: isInside(mirror, own) };
  if (isInside(configCwd, own)) {
    return {
      cwd: resolve(configCwd),
      problem:
        "no working directory for this session's commands: it names no project folder, and the configured " +
        `default (${resolve(configCwd)}) is this runner's own checkout, where nothing the model writes belongs. ` +
        'Give the session a project folder, or set execution.cwd to a folder of its own.',
    };
  }
  return { cwd: resolve(configCwd), source: 'config', ownCheckout: false };
}

export function isWorkingDirProblem(w: WorkingDir | WorkingDirProblem): w is WorkingDirProblem {
  return 'problem' in w;
}

/** What the model is told, so a relative path is a fact rather than a guess. */
export function workingDirNote(w: WorkingDir): string {
  return [
    '## Working directory',
    '',
    `Commands run in \`${w.cwd}\` unless a step changes directory. Relative paths resolve there.`,
    ...(w.ownCheckout
      ? ['', "That folder is this runner's own checkout. The operator pointed the session at it deliberately."]
      : []),
  ].join('\n');
}
