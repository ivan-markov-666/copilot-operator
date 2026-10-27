/**
 * "New branch from main", in the chat (operator, 2026-10-26: "a button near the skill option: it takes the latest of
 * main and makes a new local branch for the new task, a copy of the remote main; if the remote asks for a password, a
 * window the bot never reads; and when the branch cannot simply be changed — uncommitted changes or another problem —
 * the program offers a choice").
 *
 * Two steps, as the page shows them:
 *
 *   1. The preview fetches the remote's main (asking through Git's own password window when it must, `remoteAuth.ts`)
 *      and reads the folder: the branch it is on, what is not committed, anything half done. It changes nothing else.
 *   2. Creating it, after checking the folder is still what the preview showed: a new local branch at the remote's
 *      main, not tracking it (a push of the task's work never goes to main by mistake), checked out. What was not
 *      committed is, as the operator chooses:
 *        - taken to the new branch, as git carries changes across a checkout — refused by git, with nothing moved, when
 *          the remote's main changed the same files; then the other choice is offered;
 *        - put aside: one commit on a branch of its own (`<prefix>saved/<when>`), made with a temporary index and
 *          checked to hold every change before anything moves, then the folder is left clean on the new branch.
 *      Nothing is deleted: no branch, and no change that is not first kept. Ignored files are not touched.
 *
 * When the remote cannot be fetched — a password not given, no network — the operator may go on from the remote's main
 * as it was last fetched here, said with its date.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { branchNameFrom, freeBranchName, git, lastFetchedAt, porcelainPaths, RUNNER_EMAIL } from './git.js';
import { fetchAsOperator, type OperatorFetch } from './remoteAuth.js';

export type NewBranchPlan = {
  ok: boolean;
  problem?: string;
  /** The repository's top folder: a checkout moves all of it. */
  repoDir: string;
  /** Where the folder is now: its branch (null on a detached HEAD) and commit. */
  branch?: string | null;
  head?: string;
  remote?: string;
  /** The remote's main, as `origin/main`, the commit it is at, and that commit's subject. */
  target?: string;
  targetCommit?: string;
  targetSubject?: string;
  /** How the fetch went; absent when it was not asked for. */
  fetched?: OperatorFetch;
  /** When the remote was last fetched here: what going on without a fetch is measured against. */
  lastFetched?: string;
  /** Tracked files with uncommitted changes, and new files git does not ignore. */
  changed: string[];
  untracked: string[];
  /** A name for the new branch nobody is using yet. */
  suggested?: string;
  /** What the folder was when the preview read it; creating refuses if it no longer is. */
  fingerprint?: string;
};

export type Carry = 'take' | 'aside';

export type NewBranchResult =
  | { ok: true; branch: string; commit: string; target: string; saved?: { branch: string; commit: string; files: number }; carried: number; result: string }
  /** `conflict`: the changes could not be taken across — the remote's main changed the same files; nothing moved. */
  | { ok: false; problem: string; conflict?: boolean };

const short = (c?: string | null): string => (c ?? '').slice(0, 8);
const lines = (s: string): string[] => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function stamp(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/** A merge, rebase, cherry-pick or revert half done: the folder is the operator's to finish first. */
function operationInProgress(gitDir: string): string | null {
  for (const [file, what] of [
    ['MERGE_HEAD', 'a merge'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
  ] as const) {
    if (existsSync(join(gitDir, file))) return what;
  }
  return null;
}

const refused = (repoDir: string, problem: string, extra: Partial<NewBranchPlan> = {}): NewBranchPlan => ({ ok: false, problem, repoDir, changed: [], untracked: [], ...extra });

/**
 * What making the branch would start from. `fetch`: the preview, which fetches the remote's main — through `askpass`,
 * Git's password window, when given; without a fetch, what was last fetched (going on after a fetch that failed, and
 * the creation itself, which compares against what the preview read).
 */
export async function planNewBranch(folder: string, opts: { fetch: boolean; askpass?: string | null }): Promise<NewBranchPlan> {
  const inside = await git(folder, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') return refused(folder, `${folder} is not a git repository, so there is no main to make a branch from.`);
  const top = await git(folder, ['rev-parse', '--show-toplevel']);
  const repoDir = top.ok && top.stdout ? resolve(top.stdout) : folder;
  const gitDir = (await git(repoDir, ['rev-parse', '--absolute-git-dir'])).stdout;
  const busy = gitDir ? operationInProgress(gitDir) : null;
  if (busy) return refused(repoDir, `The repository is in the middle of ${busy}. Finish it or abort it first; nothing was changed.`);
  const headR = await git(repoDir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const branchR = await git(repoDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = branchR.ok && branchR.stdout ? branchR.stdout : null;

  const remotes = lines((await git(repoDir, ['remote'])).stdout);
  if (remotes.length === 0) return refused(repoDir, 'The repository has no remote, so there is no remote main to make the branch from.');
  const remote = remotes.includes('origin') ? 'origin' : (remotes[0] as string);

  // Read before fetching: a fetch that fails empties FETCH_HEAD, and with it the time of the last one that worked.
  const lastBefore = gitDir ? lastFetchedAt(gitDir) : undefined;
  let fetched: OperatorFetch | undefined;
  if (opts.fetch) {
    // Only the remote's main: one connection, one password at most.
    fetched = await fetchAsOperator(repoDir, remote, { askpass: opts.askpass ?? null, refspecs: [`+refs/heads/main:refs/remotes/${remote}/main`] });
    // A remote whose main is called master: asked for by that name, once the first said it has no main.
    if (!fetched.ok && /couldn't find remote ref|could not find remote ref/i.test(fetched.detail ?? '')) {
      fetched = await fetchAsOperator(repoDir, remote, { askpass: opts.askpass ?? null, refspecs: [`+refs/heads/master:refs/remotes/${remote}/master`] });
    }
  }
  let target = '';
  for (const name of ['main', 'master']) {
    if ((await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${name}`])).ok) {
      target = `${remote}/${name}`;
      break;
    }
  }
  const lastFetched = fetched && !fetched.ok ? lastBefore : gitDir ? lastFetchedAt(gitDir) : undefined;
  if (!target) {
    return refused(repoDir, fetched && !fetched.ok ? `${remote} could not be fetched (${fetched.detail}), and no main of it is known here yet.` : `No main (or master) of ${remote} is known here.`, {
      ...(fetched ? { fetched } : {}),
      remote,
    });
  }
  const targetCommit = (await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${target}^{commit}`])).stdout;
  if (!targetCommit) return refused(repoDir, `${target} could not be read.`);
  const targetSubject = (await git(repoDir, ['log', '-1', '--format=%s', targetCommit])).stdout;

  const status = await git(repoDir, ['status', '--porcelain', '--untracked-files=no']);
  const changed = porcelainPaths(status.stdout);
  const untracked = lines((await git(repoDir, ['ls-files', '--others', '--exclude-standard'])).stdout);
  const suggested = await freeBranchName(repoDir, `task/${stamp()}`);
  const fingerprint = createHash('sha256')
    .update([headR.stdout, branch ?? '', targetCommit, status.stdout, untracked.join('\n')].join('\0'))
    .digest('hex')
    .slice(0, 16);
  return {
    ok: true,
    repoDir,
    branch,
    ...(headR.stdout ? { head: headR.stdout } : {}),
    remote,
    target,
    targetCommit,
    ...(targetSubject ? { targetSubject } : {}),
    ...(fetched ? { fetched } : {}),
    ...(lastFetched ? { lastFetched } : {}),
    changed,
    untracked,
    suggested,
    fingerprint,
  };
}

/** Whether git takes `name` as a new branch here: a legal name, and not one in use. */
export async function branchNameProblem(repoDir: string, name: string): Promise<string | null> {
  const n = name.trim();
  if (!n) return 'Write the new branch\'s name.';
  const legal = await git(repoDir, ['check-ref-format', '--branch', n]);
  if (!legal.ok || n.startsWith('-')) return `"${n}" cannot be a branch's name: no spaces, no "..", and not starting or ending with "/" or ".".`;
  if ((await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${n}`])).ok) return `There is a branch called "${n}" already; choose another name.`;
  return null;
}

/**
 * Every uncommitted change and new file, as one commit on top of HEAD on a branch of its own, made with a temporary
 * index — then checked to hold all of them, so nothing is removed from the folder that is not kept.
 */
async function keepUncommitted(dir: string, head: string, branch: string, message: string): Promise<{ commit: string } | { problem: string }> {
  const index = join(tmpdir(), `cop-saved-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    const read = await git(dir, ['read-tree', head], 60_000, env);
    if (!read.ok) return { problem: read.stderr || 'git read-tree failed' };
    const added = await git(dir, ['add', '-A', '--', '.'], 300_000, env);
    if (!added.ok) return { problem: `the changes could not be read into git: ${added.stderr || added.stdout}` };
    const differs = await git(dir, ['diff-files', '--name-only'], 120_000, env);
    const outside = await git(dir, ['ls-files', '--others', '--exclude-standard'], 120_000, env);
    if (!differs.ok || differs.stdout || !outside.ok || outside.stdout) {
      return { problem: `not every change could be kept (${[differs.stdout, outside.stdout].filter(Boolean).join(', ').slice(0, 300) || differs.stderr || outside.stderr}), so nothing was moved.` };
    }
    const tree = await git(dir, ['write-tree'], 60_000, env);
    if (!tree.ok || !tree.stdout) return { problem: tree.stderr || 'git write-tree failed' };
    const commit = await git(dir, ['-c', 'user.name=copilot-operator', '-c', `user.email=${RUNNER_EMAIL}`, 'commit-tree', tree.stdout, '-p', head, '-m', message]);
    if (!commit.ok || !commit.stdout) return { problem: commit.stderr || 'git commit-tree failed' };
    const made = await git(dir, ['branch', branch, commit.stdout]);
    if (!made.ok) return { problem: made.stderr || `the branch ${branch} could not be made` };
    return { commit: commit.stdout };
  } finally {
    await rm(index, { force: true });
  }
}

/** Makes the branch and checks it out, after checking the folder is still what the preview showed. */
export async function createNewBranch(folder: string, opts: { name: string; carry: Carry; fingerprint: string; prefix?: string }): Promise<NewBranchResult> {
  const plan = await planNewBranch(folder, { fetch: false });
  if (!plan.ok) return { ok: false, problem: plan.problem ?? 'the folder could not be read.' };
  if (!opts.fingerprint || plan.fingerprint !== opts.fingerprint) {
    return { ok: false, problem: 'The folder changed since it was read (a commit, a branch, a changed or new file). Look at it again; nothing was changed.' };
  }
  const repoDir = plan.repoDir;
  const name = opts.name.trim();
  const bad = await branchNameProblem(repoDir, name);
  if (bad) return { ok: false, problem: bad };
  const target = plan.target as string;
  const targetCommit = plan.targetCommit as string;
  const files = plan.changed.length + plan.untracked.length;
  const done = async (saved?: { branch: string; commit: string; files: number }): Promise<NewBranchResult> => {
    const nowBranch = (await git(repoDir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout;
    const nowHead = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout;
    if (nowBranch !== name || nowHead !== targetCommit) return { ok: false, problem: `The folder is on ${nowBranch || 'a detached HEAD'} at ${short(nowHead)}, not on ${name} at ${short(targetCommit)} as it should be.` };
    const carried = saved ? 0 : files;
    const result =
      `The folder is on the new branch ${name}, made from ${target} (${short(targetCommit)}).` +
      (saved ? ` What was not committed is kept on ${saved.branch} (${saved.files} file(s)).` : carried > 0 ? ` ${carried} uncommitted file(s) came with it.` : '');
    return { ok: true, branch: name, commit: targetCommit, target, ...(saved ? { saved } : {}), carried, result };
  };

  if (files === 0 || opts.carry === 'take') {
    // As git carries changes across a checkout; it refuses, and moves nothing, when a change would be overwritten.
    const moved = await git(repoDir, ['switch', '--quiet', '--no-track', '-c', name, targetCommit], 300_000);
    if (!moved.ok) {
      const said = (moved.stderr || moved.stdout).trim();
      const conflict = /would be overwritten|overwritten by checkout|untracked working tree files/i.test(said);
      return conflict
        ? { ok: false, conflict: true, problem: `The uncommitted changes cannot be taken to the new branch: ${target} changed the same files (${said.split(/\r?\n/).slice(1, 4).map((l) => l.trim()).filter(Boolean).join(', ') || said.split(/\r?\n/)[0]}). Nothing was moved.` }
        : { ok: false, problem: `The branch could not be made: ${said.split(/\r?\n/)[0] || 'git switch failed'}. Nothing was moved.` };
    }
    return done();
  }

  // Put aside: kept first, checked whole; only then is the folder moved, and left clean.
  const head = plan.head;
  if (!head) return { ok: false, problem: 'The repository has no commit yet to keep the changes on top of. Make a first commit, then try again.' };
  const saved = await freeBranchName(repoDir, `${branchNameFrom(['saved'], opts.prefix || 'cop/')}/${stamp()}`);
  const message = [
    'Keep uncommitted work before a new branch from main',
    '',
    `Everything that was not committed in the folder on ${plan.branch ?? 'a detached HEAD'} (${short(head)}), kept here before the new branch ${name} was made from ${target} (${short(targetCommit)}).`,
    'To take a file back: git restore --source <this branch> -- <path>',
    '',
    ...[...plan.changed.map((p) => `- changed: ${p}`), ...plan.untracked.map((p) => `- new: ${p}`)].slice(0, 300),
    '',
    'Committed by copilot-operator. Not pushed.',
    '',
  ].join('\n');
  const kept = await keepUncommitted(repoDir, head, saved, message);
  if ('problem' in kept) return { ok: false, problem: kept.problem };
  // Everything is kept; the forced switch drops the tracked changes that are on the saved branch.
  const moved = await git(repoDir, ['switch', '--quiet', '--no-track', '--discard-changes', '-c', name, targetCommit], 300_000);
  if (!moved.ok) return { ok: false, problem: `The branch could not be made: ${(moved.stderr || moved.stdout).split(/\r?\n/)[0]}. What was not committed is kept on ${saved}.` };
  /*
   * The new files, kept on the saved branch, out of the folder — those and no others (audit, 2026-10-27): a plain
   * `clean` also took a file the old branch's .gitignore ignored and the new one's does not, which was never saved.
   * Named a hundred at a time, literally, so a name is never read as a pattern.
   */
  for (let i = 0; i < plan.untracked.length; i += 100) {
    const cleaned = await git(repoDir, ['--literal-pathspecs', 'clean', '-fd', '--quiet', '--', ...plan.untracked.slice(i, i + 100)], 300_000);
    if (!cleaned.ok) return { ok: false, problem: `The new branch ${name} is made, but the new files could not be taken out of the folder: ${cleaned.stderr}. They are kept on ${saved}.` };
  }
  return done({ branch: saved, commit: kept.commit, files });
}
