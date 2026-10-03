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
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export type GitResult = { ok: boolean; stdout: string; stderr: string; code: number };

/**
 * Settings every git the runner starts is given, ahead of the command.
 *
 * The repository is one the chat's steps have been working in, and a repository can carry code that
 * git runs by itself: hooks (`post-checkout`, `prepare-commit-msg`, `post-commit` — `--no-verify`
 * skips only two of them), an fsmonitor program that `status` starts, and clean/smudge filters that
 * `add` and `checkout` run. Found on 2026-09-27: any of these, placed by a step, would have been
 * executed by the runner — as the runner, with no approval and no log. So hooks are pointed at a
 * folder that does not exist, fsmonitor is off, and the repository's own attribute files are not
 * read for filters (`core.attributesFile` cannot switch off `.gitattributes`, but a filter needs a
 * driver in the config, which the steps may no longer write — see `repositoryInternalsRefusal`).
 * `--no-optional-locks` keeps `status` from writing the index behind a step's back.
 */
const SAFE_GIT = [
  '-c', `core.hooksPath=${noHooksDir()}`,
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '--no-optional-locks',
];

/** A folder that does not exist, so git finds no hooks in it. */
function noHooksDir(): string {
  return process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'copilot-operator-no-hooks') : '/nonexistent';
}

/** Runs one git command in a directory. Never throws: the caller decides what a failure means. */
export function git(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
  env?: NodeJS.ProcessEnv,
  /** `windowsHide: false` only for a fetch the operator is sitting at, whose password window must be seen. */
  opts: { windowsHide?: boolean } = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', [...SAFE_GIT, ...args], { cwd, timeout: timeoutMs, windowsHide: opts.windowsHide ?? true, maxBuffer: 8 * 1024 * 1024, ...(env ? { env } : {}) }, (error, stdout, stderr) => {
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

  let inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  /*
   * A folder with a .git that git calls "not a repository" is, on Windows, a moment when another git is
   * replacing HEAD or the index (a rename there is not atomic while the file is open): asked again, it is
   * one. Found 2026-10-02 when a run was refused before it started for "not a git repository" while its
   * branch and HEAD read fine. Asked up to three more times before the answer stands.
   */
  for (let i = 0; i < 3 && (!inside.ok || inside.stdout !== 'true') && existsSync(join(dir, '.git')); i += 1) {
    await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  }
  if (!inside.ok || inside.stdout !== 'true') {
    return { ...empty, problem: `${dir} is not a git repository. Run "git init" there, or point version control at one.` };
  }

  const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = await git(dir, ['rev-parse', 'HEAD']);
  const status = await git(dir, ['status', '--porcelain']);
  const changed = porcelainPaths(status.stdout);

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
  return porcelainPaths(status.stdout)
    .map((p) => (p.includes(' -> ') ? p.slice(p.indexOf(' -> ') + 4) : p))
    .slice(0, limit);
}

/**
 * The paths out of `git status --porcelain`, whatever happened to the leading space.
 *
 * Porcelain puts two status characters and a space in front of every path, and the first of
 * those characters is a space for a file modified in the working tree but not staged: ` M
 * src/x.ts`. This runner trims every git result, which eats that leading space on the first
 * line only — and cutting a fixed three characters then ate the first letter of the path with
 * it. The operator saw "There are uncommitted changes (ules-engine/docs…)" and, worse, the
 * commit-hygiene check was looking for `node_modules` in a list where the first entry could
 * read `ode_modules`. So the status characters are matched rather than counted.
 */
export function porcelainPaths(stdout: string): string[] {
  if (!stdout) return [];
  return stdout
    .split('\n')
    .map((l) => l.replace(/^\s*[A-Z?!ADMRTUC ]{1,2}\s+/, '').trim())
    .filter(Boolean);
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
  /*
   * A name with its own namespace — `recovery/apz-migration`, `feature/JIRA-123-schemas` — is the
   * team's convention, and it is used as written: the prefix is only for names that have none.
   * Flattening it to `cop/recovery-apz-migration` made a different branch from the one asked for,
   * so a plan continuing a recovery branch worked beside it instead of on it (2026-09-30). Each
   * segment is still made safe, keeping its case; git itself has the last word in `switchTo`.
   */
  if (trimmed.includes('/')) {
    const segments = trimmed
      .split('/')
      .map((seg) => seg.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, ''))
      .filter(Boolean);
    if (segments.length > 1) return `${segments.join('/')}${attempt > 1 ? `-a${attempt}` : ''}`.replace(/\.\.+/g, '.').slice(0, 200);
  }
  const p = prefix.trim();
  const body = p && trimmed.toLowerCase().startsWith(p.toLowerCase()) ? trimmed.slice(p.length) : trimmed;
  return branchNameFrom([body, attempt > 1 ? `a${attempt}` : undefined], prefix);
}

export async function isValidBranchName(dir: string, name: string): Promise<boolean> {
  const r = await git(dir, ['check-ref-format', '--branch', name]);
  return r.ok;
}

/**
 * What bringing a local branch up to its remote did. `updated` moved it forward; every other outcome
 * left it exactly where it was, and says why.
 */
export type BranchUpdate = {
  branch: string;
  /** The remote-tracking branch compared with, `origin/main`. */
  remote?: string;
  outcome: 'updated' | 'up-to-date' | 'ahead' | 'diverged' | 'no-remote' | 'fetch-failed' | 'failed';
  from?: string;
  to?: string;
  detail?: string;
};

/**
 * Brings a local branch up to date with its remote: `git fetch`, then a fast-forward and nothing else.
 *
 * Asked for on 2026-09-30, so a session's branch is cut from the code as it is on the server and not
 * from whatever this checkout last pulled. Never a reset, a merge commit or a rewrite: a branch with
 * commits of its own (ahead) or one that has gone its own way (diverged) is left as it is, and the
 * outcome says so. The remote is the branch's upstream, or `origin` when it has none; a repository
 * with neither is left alone. git is not allowed to ask for credentials — a prompt would hang the run,
 * and a sign-in window on a machine nobody is watching is worse — so a remote that needs a password
 * git does not already have fails the fetch, which is reported, not fatal.
 */
export async function updateFromRemote(dir: string, branch: string): Promise<BranchUpdate> {
  const local = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (!local.ok || !local.stdout) return { branch, outcome: 'failed', detail: `there is no local branch ${branch}` };

  const upstream = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]);
  let remote = '';
  let remoteBranch = branch;
  if (upstream.ok && upstream.stdout.includes('/')) {
    remote = upstream.stdout.slice(0, upstream.stdout.indexOf('/'));
    remoteBranch = upstream.stdout.slice(remote.length + 1);
  } else {
    const remotes = await git(dir, ['remote']);
    const names = remotes.ok ? remotes.stdout.split(/\r?\n/).map((r) => r.trim()).filter(Boolean) : [];
    if (names.includes('origin')) remote = 'origin';
  }
  if (!remote) return { branch, outcome: 'no-remote', detail: 'the repository has no remote to update from' };
  const tracking = `${remote}/${remoteBranch}`;

  const quiet = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };
  const fetched = await git(dir, ['-c', 'credential.interactive=false', 'fetch', '--quiet', '--no-tags', remote, `+refs/heads/${remoteBranch}:refs/remotes/${tracking}`], 90_000, quiet);
  if (!fetched.ok) {
    return { branch, remote: tracking, outcome: 'fetch-failed', detail: (fetched.stderr || fetched.stdout || 'git fetch failed').split(/\r?\n/)[0] };
  }
  const theirs = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${tracking}^{commit}`]);
  if (!theirs.ok || !theirs.stdout) return { branch, remote: tracking, outcome: 'no-remote', detail: `${tracking} does not exist on the remote` };

  const from = local.stdout;
  const to = theirs.stdout;
  if (from === to) return { branch, remote: tracking, outcome: 'up-to-date', from, to };
  if (await isAncestor(dir, to, from)) return { branch, remote: tracking, outcome: 'ahead', from, to, detail: `${branch} has commits ${tracking} does not; it was left as it is` };
  if (!(await isAncestor(dir, from, to))) {
    return { branch, remote: tracking, outcome: 'diverged', from, to, detail: `${branch} and ${tracking} have each gone their own way; ${branch} was left as it is` };
  }

  // Forward only. A branch that is checked out moves with its tree (clean, or the caller would not be
  // here); one that is not is moved by its ref, and only if it still is where it was read.
  const current = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const moved = current.ok && current.stdout === branch
    ? await git(dir, ['merge', '--ff-only', '--quiet', to])
    : await git(dir, ['update-ref', `refs/heads/${branch}`, to, from]);
  if (!moved.ok) return { branch, remote: tracking, outcome: 'failed', from, to, detail: (moved.stderr || moved.stdout).split(/\r?\n/)[0] };
  return { branch, remote: tracking, outcome: 'updated', from, to };
}

/** One line for the log and the session page. */
export function describeUpdate(u: BranchUpdate): string {
  const short = (c?: string): string => (c ? c.slice(0, 8) : '?');
  switch (u.outcome) {
    case 'updated':
      return `${u.branch} brought up to date with ${u.remote}: ${short(u.from)} → ${short(u.to)}`;
    case 'up-to-date':
      return `${u.branch} was already up to date with ${u.remote}`;
    default:
      return `${u.branch} not updated from the remote: ${u.detail ?? u.outcome}`;
  }
}

/** The local branches of a repository, by name; empty when it cannot be read. */
export async function localBranches(dir: string): Promise<string[]> {
  const r = await git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return r.ok ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
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

/**
 * One git command, with its output as bytes and untouched.
 *
 * `git` trims what it returns, which is right for a branch name and wrong for a file: trimming
 * takes the indentation off the first line and the newline off the last, and a diff built on that
 * would show both as changes nobody made. Bytes also let a binary file be recognised rather than
 * decoded into noise.
 */
export function gitBytes(cwd: string, args: string[], timeoutMs = 60_000, maxBytes = 16 * 1024 * 1024): Promise<{ ok: boolean; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', [...SAFE_GIT, ...args], { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: maxBytes, encoding: 'buffer' }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: (stdout as Buffer | undefined) ?? Buffer.alloc(0), stderr: String(stderr ?? '').trim() });
    });
  });
}

/** One file a task changed, between the commit it started from and the one it produced. */
export type ChangedFile = {
  path: string;
  /** The path before a rename or a copy. */
  oldPath?: string;
  /** git's letter: A added, M modified, D deleted, R renamed, C copied, T type changed. */
  status: string;
  /** Lines added and removed; -1 for a binary file, which git counts in neither direction. */
  added: number;
  removed: number;
};

/**
 * The files that differ between two commits, renames detected, in git's order.
 *
 * Read NUL-separated (`-z`) so a path with a space, a tab or a non-ASCII letter comes through as it
 * is rather than quoted and escaped.
 */
export async function changedFilesBetween(dir: string, from: string, to: string): Promise<{ files: ChangedFile[]; problem?: string }> {
  const names = await gitBytes(dir, ['diff', '--name-status', '-M', '-z', from, to]);
  if (!names.ok) return { files: [], problem: names.stderr || 'git could not compare the two commits' };
  const tokens = names.stdout.toString('utf8').split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i] ?? '';
    if (!status) break;
    const letter = status[0]!;
    if (letter === 'R' || letter === 'C') {
      files.push({ status: letter, oldPath: tokens[i + 1] ?? '', path: tokens[i + 2] ?? '', added: 0, removed: 0 });
      i += 3;
    } else {
      files.push({ status: letter, path: tokens[i + 1] ?? '', added: 0, removed: 0 });
      i += 2;
    }
  }
  const counts = await gitBytes(dir, ['diff', '--numstat', '-M', '-z', from, to]);
  if (counts.ok) {
    const parts = counts.stdout.toString('utf8').split('\0');
    for (let i = 0; i < parts.length; ) {
      const head = parts[i] ?? '';
      if (!head) break;
      const [added = '0', removed = '0', path = ''] = head.split('\t');
      // A rename is written "added<TAB>removed<TAB>" followed by the old and the new path.
      const newPath = path === '' ? (parts[i + 2] ?? '') : path;
      i += path === '' ? 3 : 1;
      const file = files.find((f) => f.path === newPath);
      if (file) {
        file.added = added === '-' ? -1 : Number(added) || 0;
        file.removed = removed === '-' ? -1 : Number(removed) || 0;
      }
    }
  }
  return { files };
}

/** A file's bytes as they were in one commit, or null when it does not exist there. */
export async function fileAt(dir: string, commit: string, path: string, maxBytes: number): Promise<{ bytes: Buffer | null; tooLarge: boolean }> {
  const size = await git(dir, ['cat-file', '-s', `${commit}:${path}`]);
  if (!size.ok) return { bytes: null, tooLarge: false };
  if (Number(size.stdout) > maxBytes) return { bytes: null, tooLarge: true };
  const r = await gitBytes(dir, ['show', `${commit}:${path}`], 60_000, maxBytes + 1024);
  return r.ok ? { bytes: r.stdout, tooLarge: false } : { bytes: null, tooLarge: false };
}

/** The subject line of one commit, or empty when it cannot be read. */
export async function commitSubject(dir: string, commit: string): Promise<string> {
  const r = await git(dir, ['log', '-1', '--format=%s', commit]);
  return r.ok ? r.stdout.trim() : '';
}

/** One line per commit, newest first, for showing what a task produced. */
/**
 * One hash for the whole working tree as it differs from HEAD: tracked changes, staged or not, and
 * every untracked file that is not ignored, with its contents. Two equal fingerprints mean no file
 * changed in between, which is what `orchestrator/progress.ts` needs to tell a loop from work.
 * Null when there is no HEAD to compare with.
 */
export async function treeFingerprint(dir: string): Promise<string | null> {
  const diff = await gitBytes(dir, ['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv'], 60_000, 64 * 1024 * 1024);
  if (!diff.ok) return null;
  const hash = createHash('sha256').update(diff.stdout);
  const others = await gitBytes(dir, ['ls-files', '--others', '--exclude-standard', '-z']);
  const names = others.ok ? others.stdout.toString('utf8').split('\0').filter(Boolean).sort().slice(0, 5000) : [];
  for (const name of names) {
    hash.update(`\0${name}\0`);
    const info = await stat(join(dir, name)).catch(() => null);
    if (!info?.isFile()) continue;
    // A very large file is known by its size and time rather than read.
    if (info.size > 8 * 1024 * 1024) hash.update(`${info.size}:${info.mtimeMs}`);
    else hash.update(await readFile(join(dir, name)).catch(() => Buffer.alloc(0)));
  }
  return hash.digest('hex');
}

/** The identity the runner commits under (see `commitAll`). */
export const RUNNER_EMAIL = 'copilot-operator@localhost';

/** Whether `ancestor` is reachable from `ref`: false when the branch was reset or rewritten past it. */
export async function isAncestor(dir: string, ancestor: string, ref = 'HEAD'): Promise<boolean> {
  const r = await git(dir, ['merge-base', '--is-ancestor', ancestor, ref]);
  return r.ok;
}

/** Commits between the two that the runner did not make, as `<short sha> <author email> <subject>`. */
export async function foreignCommits(dir: string, fromCommit: string, toRef = 'HEAD'): Promise<string[]> {
  const r = await git(dir, ['log', '--format=%h %ae %s', `${fromCommit}..${toRef}`]);
  if (!r.ok || !r.stdout) return [];
  return r.stdout.split('\n').filter((line) => line.split(' ')[1] !== RUNNER_EMAIL);
}

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
