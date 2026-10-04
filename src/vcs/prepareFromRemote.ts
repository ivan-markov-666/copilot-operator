/**
 * "Prepare the folder from the remote main branch": the project folder put exactly where the team's
 * code is — the remote's main branch, freshly fetched, checked out as the local branch of the same
 * name, with no uncommitted changes — so the operator can add the files a task needs on top of it and
 * hand it to the bot from there.
 *
 * Asked for on 2026-10-03, after a run was refused for uncommitted files on a branch the operator had
 * put them on: a button beside the project in Settings, instead of the command to copy that
 * `syncCommand.ts` hands out. A command to paste was the answer while the only way back to the remote
 * was `reset --hard` and `clean -fd`, which throw work away. This does not throw anything away, which
 * is what makes it a button:
 *
 *   1. Everything not on the remote's main is kept first. Uncommitted changes and new files git does
 *      not ignore become one commit on a branch of their own (`<prefix>saved/<when>`), made with a
 *      temporary index, so neither the checkout nor the real index moves while it is made — and it is
 *      checked to hold every one of them before anything else happens. Commits of the local main
 *      branch that the remote does not have get a branch of their own too. The branch the folder was
 *      on keeps its commits; no branch is deleted.
 *   2. Only then is the folder moved: the local main branch is set to the remote's main and checked
 *      out, and the new files that are now on the saved branch are removed from the folder. Ignored
 *      files — node_modules, .env, build output, what a snapshot left out — are not touched.
 *   3. The result is read back: HEAD on the remote's main, nothing uncommitted. Otherwise it says so.
 *
 * The preview fetches (so what it shows is against the remote as it is now) and changes nothing else;
 * the preparation itself refuses when the folder is no longer what the preview showed.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { branchNameFrom, freeBranchName, git, lastFetchedAt, porcelainPaths, RUNNER_EMAIL } from './git.js';
import { closePasswordWindows, describeFetchFailure, fetchCommandFor, operatorFetchEnv, QUIET_FETCH_ENV } from './remoteAuth.js';

export type PreparePlan = {
  ok: boolean;
  problem?: string;
  /** The repository's top folder, which is what moves, whatever folder under it the project names. */
  repoDir: string;
  /** Where the folder is now. */
  branch?: string | null;
  head?: string;
  remote?: string;
  /** The remote's main branch, as `origin/main`, and the commit it is at after the fetch. */
  target?: string;
  targetCommit?: string;
  /** The local branch the folder ends up on: the target without the remote's name. */
  localBranch?: string;
  /** Whether that local branch exists already, and where. */
  localHead?: string | null;
  /**
   * How the fetch went: `asked` when the remote could ask for a password through Git's own window,
   * `auth` when it failed on a password or key.
   */
  fetched?: { ok: boolean; detail?: string; auth?: boolean; asked?: boolean };
  /** When the remote was last fetched here, by anyone: what a preview without fetching is measured against. */
  lastFetched?: string;
  /** The fetch for the operator's own PowerShell, when the bot's could not get through. */
  fetchCommand?: string;
  /** Tracked files with uncommitted changes, and new files git does not ignore: kept on `savedBranch`. */
  changed: string[];
  untracked: string[];
  /** Commits of the local main branch the remote's main does not have: kept on `savedMainBranch`. */
  mainOnlyCommits: string[];
  /** Commits of the branch the folder is on that the remote's main does not have: they stay on that branch. */
  branchOnlyCommits: string[];
  /** The branch names the preparation would use, worked out now (a later press may need the next free one). */
  savedBranch?: string;
  savedMainBranch?: string;
  /** Already exactly there: nothing to do. */
  alreadyThere?: boolean;
  /** What the folder was when the preview read it; the preparation refuses if it no longer is. */
  fingerprint?: string;
};

export type PrepareResult =
  | {
      ok: true;
      branch: string;
      commit: string;
      target: string;
      saved: Array<{ branch: string; commit: string; what: string }>;
      removedFromFolder: number;
      result: string;
    }
  | { ok: false; problem: string };

const short = (c?: string | null): string => (c ?? '').slice(0, 8);
const lines = (s: string): string[] => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function stamp(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
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

const empty = (repoDir: string, problem: string): PreparePlan => ({
  ok: false,
  problem,
  repoDir,
  changed: [],
  untracked: [],
  mainOnlyCommits: [],
  branchOnlyCommits: [],
});

/**
 * What preparing the folder would do. Fetches the remote when `fetch` is true (the preview); reads
 * only when it is false (the preparation, which must compare against what the preview fetched, or a
 * preview after the operator fetched in their own terminal). With `askpass`, the fetch may ask for a
 * password through that program (see `remoteAuth.ts`); without it, it may not ask at all.
 */
export async function planPrepare(folder: string, opts: { fetch: boolean; prefix?: string; askpass?: string | null }): Promise<PreparePlan> {
  const inside = await git(folder, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') return empty(folder, `${folder} is not a git repository.`);
  // The whole repository, not the folder under it the project may name: a checkout moves all of it.
  const topR = await git(folder, ['rev-parse', '--show-toplevel']);
  const repoDir = topR.ok && topR.stdout ? resolve(topR.stdout) : folder;
  const gitDir = (await git(repoDir, ['rev-parse', '--absolute-git-dir'])).stdout;
  const busy = gitDir ? operationInProgress(gitDir) : null;
  if (busy) return empty(repoDir, `The repository is in the middle of ${busy}. Finish or abort it first; nothing was changed.`);
  const headR = await git(repoDir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!headR.ok || !headR.stdout) return empty(repoDir, 'The repository has no commits yet, so there is nothing to keep the changes on top of. Make a first commit, then press it again.');
  const branchR = await git(repoDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = branchR.ok && branchR.stdout ? branchR.stdout : null;

  const remotes = lines((await git(repoDir, ['remote'])).stdout);
  if (remotes.length === 0) return empty(repoDir, 'The repository has no remote, so there is no remote main branch to prepare it from.');
  const remote = remotes.includes('origin') ? 'origin' : (remotes[0] as string);

  const fetchCommand = fetchCommandFor(repoDir, remote);
  // Read before fetching: a fetch that fails empties FETCH_HEAD, and with it the time of the last one that worked.
  const lastBefore = gitDir ? lastFetchedAt(gitDir) : undefined;
  let fetched: PreparePlan['fetched'];
  if (opts.fetch) {
    /*
     * With the password window: five minutes for the operator to type, and the window not hidden. One
     * connection only — `remote set-head --auto` would open a second and ask for the password again —
     * so the remote's main is read from what was fetched, below.
     */
    const asked = !!opts.askpass;
    const env = asked ? operatorFetchEnv(opts.askpass as string) : QUIET_FETCH_ENV;
    const args = [...(asked ? [] : ['-c', 'credential.interactive=false']), 'fetch', '--quiet', '--no-tags', '--prune', remote];
    const started = new Date(Date.now() - 1000);
    const f = await git(repoDir, args, asked ? 300_000 : 120_000, env, { windowsHide: !asked, killTree: true });
    // Given up on with the window still open: closed, so it is not left on screen asking for nothing.
    if (!f.ok && asked && /gave up after/.test(f.stderr)) await closePasswordWindows(opts.askpass as string, started);
    if (f.ok) fetched = { ok: true, asked };
    else {
      const why = describeFetchFailure(f.stderr || f.stdout);
      fetched = { ok: false, detail: why.detail, auth: why.auth, asked };
    }
  }

  let target = '';
  const remoteHead = await git(repoDir, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
  if (remoteHead.ok && remoteHead.stdout) target = remoteHead.stdout;
  for (const name of ['main', 'master']) {
    if (target) break;
    if ((await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${name}`])).ok) target = `${remote}/${name}`;
  }
  const last = fetched && !fetched.ok ? lastBefore : gitDir ? lastFetchedAt(gitDir) : undefined;
  if (!target) {
    return {
      ...empty(repoDir, fetched && !fetched.ok ? `The remote could not be fetched (${fetched.detail}), and no main branch of ${remote} is known here.` : `No main branch of ${remote} is known here.`),
      ...(fetched ? { fetched } : {}),
      fetchCommand,
    };
  }
  if (fetched && !fetched.ok) {
    return {
      ...empty(repoDir, `The remote could not be fetched, so the folder would be set to an old copy of ${target}: ${fetched.detail}. Nothing was changed.`),
      fetched,
      fetchCommand,
      ...(last ? { lastFetched: last } : {}),
    };
  }
  const targetCommit = (await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${target}^{commit}`])).stdout;
  if (!targetCommit) return empty(repoDir, `${target} could not be read.`);
  const localBranch = target.slice(remote.length + 1);
  const localHead = (await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${localBranch}^{commit}`])).stdout || null;

  const status = await git(repoDir, ['status', '--porcelain', '--untracked-files=no']);
  const changed = porcelainPaths(status.stdout);
  const untracked = lines((await git(repoDir, ['ls-files', '--others', '--exclude-standard'])).stdout);
  const mainOnlyCommits = localHead ? lines((await git(repoDir, ['log', '--format=%h %s', `${targetCommit}..${localHead}`])).stdout) : [];
  const branchOnlyCommits = branch && branch !== localBranch ? lines((await git(repoDir, ['log', '--format=%h %s', `${targetCommit}..HEAD`])).stdout) : [];

  const prefix = opts.prefix || 'cop/';
  const when = stamp();
  const dirty = changed.length + untracked.length > 0;
  // The local main's own commits need a branch only when nothing else keeps them: the saved commit sits on top of them when the folder is on main.
  const mainNeedsKeeping = mainOnlyCommits.length > 0 && !(dirty && branch === localBranch);
  const savedBranch = dirty ? await freeBranchName(repoDir, `${branchNameFrom(['saved'], prefix)}/${when}`) : undefined;
  const savedMainBranch = mainNeedsKeeping ? await freeBranchName(repoDir, `${branchNameFrom(['saved'], prefix)}/${when}-${localBranch}`) : undefined;
  const alreadyThere = !dirty && branch === localBranch && headR.stdout === targetCommit;

  const fingerprint = createHash('sha256')
    .update([headR.stdout, branch ?? '', targetCommit, localHead ?? '', status.stdout, untracked.join('\n')].join('\0'))
    .digest('hex')
    .slice(0, 16);

  return {
    ok: true,
    repoDir,
    branch,
    head: headR.stdout,
    remote,
    target,
    targetCommit,
    localBranch,
    localHead,
    ...(fetched ? { fetched } : {}),
    ...(last ? { lastFetched: last } : {}),
    fetchCommand,
    changed,
    untracked,
    mainOnlyCommits,
    branchOnlyCommits,
    ...(savedBranch ? { savedBranch } : {}),
    ...(savedMainBranch ? { savedMainBranch } : {}),
    ...(alreadyThere ? { alreadyThere } : {}),
    fingerprint,
  };
}

/**
 * Every uncommitted change and new file, as one commit on top of HEAD on a branch of its own, made
 * with a temporary index — then checked to hold all of them, so nothing is removed from the folder
 * that is not kept.
 */
async function keepUncommitted(dir: string, head: string, branch: string, message: string): Promise<{ commit: string } | { problem: string }> {
  const index = join(tmpdir(), `cop-saved-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    const read = await git(dir, ['read-tree', head], 60_000, env);
    if (!read.ok) return { problem: read.stderr || 'git read-tree failed' };
    const added = await git(dir, ['add', '-A', '--', '.'], 300_000, env);
    if (!added.ok) return { problem: `the changes could not be read into git: ${added.stderr || added.stdout}` };
    // Kept means kept: no tracked file differs from the saved index, and no new file is outside it.
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

/** Does it, after checking the folder is still what the preview showed. */
export async function prepareFromRemote(
  folder: string,
  fingerprint: string,
  /** `names`: the saved-branch names the preview showed, used when still free, so Confirm makes what was shown. */
  opts: { prefix?: string; names?: { savedBranch?: string; savedMainBranch?: string } } = {},
): Promise<PrepareResult> {
  const plan = await planPrepare(folder, { fetch: false, prefix: opts.prefix });
  // The names the operator saw, not ones stamped a minute later (live run 2026-10-03).
  const prefix = opts.prefix || 'cop/';
  const free = async (name: string | undefined): Promise<boolean> =>
    !!name && name.startsWith(`${prefix}saved/`) && !(await git(plan.repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).ok;
  if (plan.savedBranch && (await free(opts.names?.savedBranch))) plan.savedBranch = opts.names!.savedBranch;
  if (plan.savedMainBranch && (await free(opts.names?.savedMainBranch))) plan.savedMainBranch = opts.names!.savedMainBranch;
  if (!plan.ok) return { ok: false, problem: plan.problem ?? 'the folder could not be read.' };
  const repoDir = plan.repoDir;
  if (!fingerprint || plan.fingerprint !== fingerprint) {
    return { ok: false, problem: 'The folder changed since the preview was shown (a commit, a branch, a changed or new file). Look at the preview again; nothing was changed.' };
  }
  const target = plan.target as string;
  const targetCommit = plan.targetCommit as string;
  const localBranch = plan.localBranch as string;
  const head = plan.head as string;
  if (plan.alreadyThere) {
    return { ok: true, branch: localBranch, commit: targetCommit, target, saved: [], removedFromFolder: 0, result: `The folder is already on ${localBranch} at ${short(targetCommit)}, the same as ${target}, with nothing uncommitted. Nothing was changed.` };
  }

  const saved: Array<{ branch: string; commit: string; what: string }> = [];
  if (plan.savedBranch) {
    const what = `${plan.changed.length} changed and ${plan.untracked.length} new file(s) from ${plan.branch ?? `HEAD ${short(head)}`}`;
    const message = [
      'Keep uncommitted work before preparing the folder from the remote',
      '',
      `Everything that was not committed in the folder on ${plan.branch ?? 'a detached HEAD'} (${short(head)}), kept here before the folder was set to ${target} (${short(targetCommit)}).`,
      'To take a file back: git restore --source <this branch> -- <path>',
      '',
      ...[...plan.changed.map((p) => `- changed: ${p}`), ...plan.untracked.map((p) => `- new: ${p}`)].slice(0, 300),
      '',
      'Committed by copilot-operator. Not pushed.',
      '',
    ].join('\n');
    const kept = await keepUncommitted(repoDir, head, plan.savedBranch, message);
    if ('problem' in kept) return { ok: false, problem: kept.problem };
    saved.push({ branch: plan.savedBranch, commit: kept.commit, what });
  }
  if (plan.savedMainBranch && plan.localHead) {
    const made = await git(repoDir, ['branch', plan.savedMainBranch, plan.localHead]);
    if (!made.ok) return { ok: false, problem: `the commits of ${localBranch} the remote does not have could not be kept on ${plan.savedMainBranch}: ${made.stderr}. ${saved.length ? `The uncommitted work is on ${saved[0]!.branch}; ` : ''}the folder was not moved.` };
    saved.push({ branch: plan.savedMainBranch, commit: plan.localHead, what: `${plan.mainOnlyCommits.length} commit(s) of ${localBranch} that ${target} does not have` });
  }

  // Everything is kept; now the folder. The forced checkout drops tracked changes that are on the saved branch.
  const moved = await git(repoDir, ['checkout', '--quiet', '--force', '-B', localBranch, targetCommit], 300_000);
  if (!moved.ok) {
    return { ok: false, problem: `${localBranch} could not be checked out at ${short(targetCommit)}: ${moved.stderr || moved.stdout}. ${saved.map((s) => `${s.what} are on ${s.branch}.`).join(' ')}` };
  }
  await git(repoDir, ['branch', `--set-upstream-to=${target}`, localBranch]);
  // The new files, kept on the saved branch, out of the folder; ignored files stay (no -x).
  const removed = plan.untracked.length > 0 ? await git(repoDir, ['clean', '-fd', '--quiet'], 300_000) : { ok: true, stdout: '', stderr: '' };

  const nowHead = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout;
  const left = lines((await git(repoDir, ['status', '--porcelain'])).stdout);
  const keptLine = saved.length > 0 ? ` Kept: ${saved.map((s) => `${s.what} on ${s.branch}`).join('; ')}.` : '';
  const branchLine = plan.branchOnlyCommits.length > 0 && plan.branch ? ` ${plan.branch} keeps its ${plan.branchOnlyCommits.length} commit(s); nothing was deleted.` : '';
  if (nowHead !== targetCommit || left.length > 0 || !removed.ok) {
    return {
      ok: false,
      problem:
        `The folder is on ${localBranch} at ${short(nowHead)}, but not exactly at ${target}: ${left.length > 0 ? `still uncommitted: ${left.slice(0, 10).join(', ')}` : removed.ok ? 'HEAD differs' : removed.stderr}.` +
        keptLine,
    };
  }
  return {
    ok: true,
    branch: localBranch,
    commit: targetCommit,
    target,
    saved,
    removedFromFolder: plan.untracked.length,
    result:
      `The folder is on ${localBranch} at ${short(targetCommit)}, the same as ${target}, with nothing uncommitted.${keptLine}${branchLine} ` +
      'Ignored files (node_modules, .env, build output) were not touched. Add the files the task needs now; the run screen offers a starting snapshot of them.',
  };
}
