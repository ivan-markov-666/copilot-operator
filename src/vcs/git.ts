/**
 * The git the runner does for itself.
 *
 * Every git command in this project runs from here, not from a step written by Copilot. That
 * is deliberate. Branching and committing have to be exact, and exactness is the one thing a
 * language model cannot promise: a step it writes goes through improvisation, through the
 * approval gate, and through the output pipeline that has already been observed to mangle
 * text. A task that is asked to "go back to the code as it was" cannot be built on that.
 *
 * Two rules hold everywhere in this file:
 *
 *   - Nothing is destructive. There is no `reset --hard`, no forced checkout, no branch
 *     deletion. Going back to an earlier state means branching from the commit that state
 *     was at, which adds history instead of removing it.
 *   - Nothing runs through a shell. `execFile` takes an argument list, so a branch name or a
 *     commit message cannot turn into another command.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type GitResult = { ok: boolean; stdout: string; stderr: string; code: number };

/** Runs one git command in a directory. Never throws: the caller decides what a failure means. */
export function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException & { code?: number })?.code;
      resolve({
        ok: !error,
        stdout: (stdout ?? '').trim(),
        stderr: (stderr ?? '').trim(),
        code: typeof code === 'number' ? code : error ? 1 : 0,
      });
    });
  });
}

export type RepoState = {
  isRepo: boolean;
  /** The branch name, or null when the repository is in a detached head. */
  branch: string | null;
  head: string | null;
  /** True when there is anything uncommitted, tracked or not. */
  dirty: boolean;
  /** Files that make it dirty, for a message that says what is in the way. */
  changed: string[];
  /** Why this is not usable, when it is not. */
  problem?: string;
};

/** Everything the runner needs to know about a repository before it touches it. */
export async function repoState(dir: string): Promise<RepoState> {
  const empty: RepoState = { isRepo: false, branch: null, head: null, dirty: false, changed: [] };

  if (!dir?.trim()) return { ...empty, problem: 'No repository folder is set.' };
  if (!existsSync(dir)) return { ...empty, problem: `The folder ${dir} does not exist.` };

  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') {
    return { ...empty, problem: `${dir} is not a git repository. Run "git init" there, or point version control at one.` };
  }

  const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = await git(dir, ['rev-parse', 'HEAD']);
  const status = await git(dir, ['status', '--porcelain']);
  const changed = status.stdout ? status.stdout.split('\n').map((l) => l.slice(3).trim()).filter(Boolean) : [];

  return {
    isRepo: true,
    // A repository with no commits yet has no HEAD to resolve, and that is a real state:
    // a branch can still be made from it, but nothing can be "gone back to".
    branch: branch.ok && branch.stdout !== 'HEAD' ? branch.stdout : null,
    head: head.ok ? head.stdout : null,
    dirty: changed.length > 0,
    changed: changed.slice(0, 40),
  };
}

/**
 * Every path that would go into the next commit, file by file.
 *
 * `repoState` reads `git status --porcelain`, which folds a new folder into one line: a task
 * that creates `web/` and installs into it shows as `?? web/`, and nothing under it is named.
 * That is fine for "is the tree dirty" and useless for "what is in it" — the first task of
 * every plan creates a folder, and what it contains is exactly what a commit-hygiene check
 * has to see. `--untracked-files=all` lists each file; renames are reported by their new name.
 */
export async function workingTreePaths(dir: string, limit = 20_000): Promise<string[]> {
  const status = await git(dir, ['status', '--porcelain', '--untracked-files=all']);
  if (!status.ok || !status.stdout) return [];
  return status.stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .map((p) => (p.includes(' -> ') ? p.slice(p.indexOf(' -> ') + 4) : p))
    .filter(Boolean)
    .slice(0, limit);
}

/** Is git usable at all on this machine? */
export async function gitAvailable(): Promise<string | null> {
  const r = await git(process.cwd(), ['--version'], 10_000);
  return r.ok ? r.stdout : null;
}

/**
 * A branch name git will accept, built from whatever the caller has.
 *
 * git's own rules are stricter than they look: no spaces, no `..`, no leading or trailing
 * dots or slashes, no control characters, and a few reserved sequences. Rather than
 * reimplementing the rule book, this reduces the name to a conservative alphabet and then
 * asks git itself whether the result is legal.
 */
export function branchNameFrom(parts: Array<string | number | undefined>, prefix = 'cop/'): string {
  const body = parts
    .filter((p) => p !== undefined && `${p}`.trim() !== '')
    .map((p) =>
      `${p}`
        .toLowerCase()
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 40),
    )
    .filter(Boolean)
    .join('-');

  const name = `${prefix}${body || 'task'}`.replace(/\.\.+/g, '.').replace(/\/+/g, '/');
  return name.slice(0, 200);
}

/**
 * A branch name somebody chose, made safe without being made unrecognisable.
 *
 * The prefix is stripped if the name already carries it, because a plan written by a model
 * that has been told the prefix is `cop/` will helpfully include it, and `cop/cop-thing` is
 * the kind of small ugliness nobody ever goes back to fix. Everything else goes through the
 * same slug as a derived name: this is a suggestion from outside the system, and it reaches
 * git through exactly one path.
 */
export function plannedBranchName(raw: string, prefix = 'cop/', attempt = 1): string {
  const trimmed = raw.trim();
  const p = prefix.trim();
  const body = p && trimmed.toLowerCase().startsWith(p.toLowerCase()) ? trimmed.slice(p.length) : trimmed;
  return branchNameFrom([body, attempt > 1 ? `a${attempt}` : undefined], prefix);
}

export async function isValidBranchName(dir: string, name: string): Promise<boolean> {
  const r = await git(dir, ['check-ref-format', '--branch', name]);
  return r.ok;
}

export async function branchExists(dir: string, name: string): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  return r.ok && r.stdout.length > 0;
}

/** A name nothing is using yet, by adding `-2`, `-3` until one is free. */
export async function freeBranchName(dir: string, wanted: string): Promise<string> {
  if (!(await branchExists(dir, wanted))) return wanted;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${wanted}-${i}`;
    if (!(await branchExists(dir, candidate))) return candidate;
  }
  return `${wanted}-${Date.now()}`;
}

/**
 * Creates a branch and switches to it.
 *
 * `from` is a commit or a branch to start at. Leaving it out starts from where the repository
 * already is. This is how "go back to the code as it was before that task" is done: the task
 * recorded the commit it started at, and a new branch is cut from that commit. The branches
 * that already exist are not touched, so nothing that was done in between is lost.
 */
export async function createBranch(dir: string, name: string, from?: string): Promise<GitResult> {
  const args = from ? ['checkout', '-b', name, from] : ['checkout', '-b', name];
  return await git(dir, args);
}

export async function checkoutExisting(dir: string, name: string): Promise<GitResult> {
  return await git(dir, ['checkout', name]);
}

/**
 * Commits everything in the working tree, including files git does not track yet.
 *
 * Returns `committed: false` when there was nothing to commit, which is an ordinary outcome:
 * a task that only read things leaves no changes, and that is not a failure.
 *
 * The author is set per command rather than in the repository's configuration, so a machine
 * with no `user.email` still works and the operator's own identity is never written to.
 */
export async function commitAll(
  dir: string,
  message: string,
  author = 'copilot-operator <copilot-operator@localhost>',
): Promise<{ committed: boolean; commit?: string; problem?: string }> {
  const add = await git(dir, ['add', '-A']);
  if (!add.ok) return { committed: false, problem: add.stderr || 'git add failed' };

  const staged = await git(dir, ['diff', '--cached', '--name-only']);
  if (staged.stdout.length === 0) return { committed: false };

  const commit = await git(dir, [
    '-c',
    `user.name=${author.split('<')[0].trim()}`,
    '-c',
    `user.email=${author.includes('<') ? author.split('<')[1].replace('>', '').trim() : 'copilot-operator@localhost'}`,
    'commit',
    '--no-verify',
    '-m',
    message,
  ]);
  if (!commit.ok) return { committed: false, problem: commit.stderr || commit.stdout || 'git commit failed' };

  const head = await git(dir, ['rev-parse', 'HEAD']);
  return { committed: true, commit: head.ok ? head.stdout : undefined };
}

/**
 * What one commit touched: the files, and how many lines went in and out of each.
 *
 * Read once, at the moment of committing, and kept on the task. The alternative is asking git
 * again whenever the UI wants to show it, which fails the day the branch is gone, the folder
 * has moved or the operator is looking at the record of a machine they no longer have.
 */
export async function commitFiles(dir: string, commit: string): Promise<Array<{ path: string; added: number; removed: number }>> {
  const r = await git(dir, ['show', '--numstat', '--format=', commit]);
  if (!r.ok || !r.stdout) return [];
  return r.stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length === 3 && parts[2].trim() !== '')
    .map(([added, removed, path]) => ({
      path: path.trim(),
      // A binary file reports "-" for both, which is a real answer and not a zero.
      added: added === '-' ? -1 : Number(added) || 0,
      removed: removed === '-' ? -1 : Number(removed) || 0,
    }));
}

/** The subject line of one commit, or empty when it cannot be read. */
export async function commitSubject(dir: string, commit: string): Promise<string> {
  const r = await git(dir, ['log', '-1', '--format=%s', commit]);
  return r.ok ? r.stdout.trim() : '';
}

/** One line per commit, newest first, for showing what a task produced. */
export async function commitsBetween(dir: string, fromCommit: string, toRef = 'HEAD'): Promise<string[]> {
  const r = await git(dir, ['log', '--oneline', `${fromCommit}..${toRef}`]);
  return r.ok && r.stdout ? r.stdout.split('\n') : [];
}

/** True when the folder looks like a repository worth offering in the UI. */
export function looksLikeRepo(dir: string): boolean {
  return !!dir?.trim() && existsSync(join(dir, '.git'));
}

/**
 * Why version control cannot be turned on for a folder, or null when it can.
 *
 * Checked before the choice is saved rather than when a run reaches it. Version control that
 * is on but inactive is the worst of both: the operator believes there is a way back, the
 * runner quietly branches nothing, and the first anyone knows of it is a task card an hour
 * later. Making the repository a precondition of the switch means the switch tells the truth.
 *
 * An empty folder is not an error here. It means nothing has been chosen yet, and the panel
 * says that in its own words.
 */
export function repoUnusableReason(dir: string): string | null {
  const d = (dir ?? '').trim();
  if (!d) return null;
  if (!existsSync(d)) {
    return (
      `The folder ${d} does not exist, so there is no repository to work in. ` +
      'Create the project first, make it a git repository, and then point version control at it.'
    );
  }
  if (!existsSync(join(d, '.git'))) {
    return (
      `${d} is not a git repository: it has no .git folder. ` +
      'Version control cannot make a branch or a commit there. Run "git init" in that folder, ' +
      'or choose a folder that is already a repository.'
    );
  }
  return null;
}
