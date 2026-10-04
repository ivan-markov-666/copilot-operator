/**
 * The command that brings a project's current branch back to the remote's main branch, handed to
 * the operator rather than run.
 *
 * Asked for after a day of runs: a project left on a task branch, with files a step created and
 * nobody committed, wants to go back to where the team's code is. That is `fetch`, `reset --hard`
 * to the remote's main, and `clean -fd` for the new files git does not ignore — three commands that
 * destroy work if pointed at the wrong folder or run a minute too early. So the bot never runs them.
 * It reads the repository, says exactly what would be lost — commits on this branch that the
 * remote's main does not have, changed tracked files, new files — and gives the command, ready to
 * paste into PowerShell, with a read-only preview beside it. Ignored files (`node_modules`, `.env`,
 * build output) are left alone: `clean` without `-x` does not touch them.
 *
 * Nothing here writes to the repository or the network. `git fetch` is in the command, not here:
 * what "would be lost" is computed against the remote branch as last fetched, and the page says so.
 */
import { git, lastFetchedAt, porcelainPaths } from './git.js';

export type SyncPlan = {
  ok: boolean;
  problem?: string;
  repoDir: string;
  branch?: string;
  remote?: string;
  /** The remote's main branch, as `origin/main`. */
  target?: string;
  /** When this repository last fetched, if it ever did; what "would be lost" is measured against that. */
  lastFetched?: string;
  willLose: {
    /** Commits on the current branch that the target does not contain: `sha subject`. */
    commits: string[];
    /** Tracked files with changes that are not committed. */
    changed: string[];
    /** New files and folders git does not ignore. */
    untracked: string[];
  };
  /** Read-only: fetches, then lists the same three things. */
  preview: string;
  /** Fetch, reset to the target, remove the new files — each step only if the one before succeeded. */
  command: string;
};

/** A string as a single-quoted PowerShell literal: nothing inside it is expanded. */
export function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * The two commands, for Windows PowerShell 5.1 and PowerShell 7 alike: `;` and `$LASTEXITCODE`
 * rather than `&&`, which 5.1 does not have, so a failed fetch stops everything after it instead
 * of resetting to a remote branch that is out of date.
 */
export function syncCommands(dir: string, remote: string, target: string): { preview: string; command: string } {
  const g = `git -C ${psQuote(dir)}`;
  return {
    preview: [
      `${g} fetch ${psQuote(remote)}`,
      `${g} log --oneline ${psQuote(`${target}..HEAD`)}`,
      `${g} status --short`,
      `${g} clean -nd`,
    ].join('; '),
    command:
      `${g} fetch ${psQuote(remote)}; if ($LASTEXITCODE -eq 0) { ${g} reset --hard ${psQuote(target)}; ` +
      `if ($LASTEXITCODE -eq 0) { ${g} clean -fd } }`,
  };
}

const empty = (repoDir: string, problem: string): SyncPlan => ({
  ok: false,
  problem,
  repoDir,
  willLose: { commits: [], changed: [], untracked: [] },
  preview: '',
  command: '',
});

export async function planSync(repoDir: string): Promise<SyncPlan> {
  const inside = await git(repoDir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') return empty(repoDir, `${repoDir} is not a git repository.`);

  const branch = await git(repoDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch.ok || !branch.stdout) {
    return empty(repoDir, 'The repository is not on a branch (a detached HEAD), so there is no "current branch" to bring up to date. Check out a branch first.');
  }

  const remotes = (await git(repoDir, ['remote'])).stdout.split('\n').map((r) => r.trim()).filter(Boolean);
  if (remotes.length === 0) return empty(repoDir, 'The repository has no remote, so there is no remote main branch to go back to.');
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]!;

  // The remote's own idea of its main branch first, then the two usual names.
  let target = '';
  const head = await git(repoDir, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
  if (head.ok && head.stdout) target = head.stdout;
  for (const name of ['main', 'master']) {
    if (target) break;
    const found = await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${name}`]);
    if (found.ok) target = `${remote}/${name}`;
  }
  if (!target) {
    return empty(
      repoDir,
      `No main branch of ${remote} is known here yet. Run ${syncCommands(repoDir, remote, `${remote}/main`).preview.split('; ')[0]} once, then look again.`,
    );
  }

  const commits = await git(repoDir, ['log', '--format=%h %s', `${target}..HEAD`]);
  const status = await git(repoDir, ['status', '--porcelain', '--untracked-files=no']);
  const clean = await git(repoDir, ['clean', '-nd']);
  const gitDir = (await git(repoDir, ['rev-parse', '--absolute-git-dir'])).stdout;
  const lastFetched = gitDir ? lastFetchedAt(gitDir) : undefined;

  return {
    ok: true,
    repoDir,
    branch: branch.stdout,
    remote,
    target,
    ...(lastFetched ? { lastFetched } : {}),
    willLose: {
      commits: commits.ok && commits.stdout ? commits.stdout.split('\n') : [],
      changed: porcelainPaths(status.stdout),
      untracked: clean.stdout
        .split('\n')
        .map((l) => l.replace(/^Would remove\s+/, '').trim())
        .filter(Boolean),
    },
    ...syncCommands(repoDir, remote, target),
  };
}
