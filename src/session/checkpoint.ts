/**
 * Checkpoints of the workbench's chat (operator's request, 2026-10-17): "before any message, I can put the code
 * back as it was then — and the messages after it go, because they did not happen. The branch is mine: the bot
 * works on the one I left checked out."
 *
 * So a chat conversation neither branches nor commits. Before each message the folder is photographed — the branch
 * and commit it is on, and the working tree as it stands, untracked files included and ignored ones not — into a
 * commit that no branch points at, kept under `refs/copilot-operator/checkpoints/`; after the message, once more,
 * so what the message changed can be shown file by file. Going back puts the folder exactly as the photograph
 * shows it: the branch checked out, at its commit, with the same uncommitted changes. That rewrites the working
 * tree and can move the branch back, so before it the folder as it is is photographed too, under
 * `refs/copilot-operator/safety/`: nothing that going back removes is lost, it is one `git checkout` away. These
 * are the only places the runner's git overwrites anything (see the rules in `vcs/git.ts`).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, looksLikeRepo } from '../vcs/git.js';

export type Checkpoint = {
  /** The photograph: a commit whose tree is the working tree, its parent the commit the folder was on. */
  commit: string;
  /** The commit the folder was on, and the branch ('' when it was on no branch). */
  head: string;
  branch: string;
  at: string;
};

const AUTHOR = ['-c', 'user.name=copilot-operator', '-c', 'user.email=copilot-operator@localhost'];

/**
 * The working tree as a commit, without touching the index, HEAD or any branch: a scratch index is filled from
 * HEAD and then from the folder (`add -A`, which honours .gitignore), written as a tree, and committed on top of
 * HEAD under `ref`.
 */
async function photograph(dir: string, ref: string, message: string, parent?: string): Promise<{ commit: string; head: string; branch: string } | { problem: string }> {
  if (!looksLikeRepo(dir)) return { problem: 'The open folder is not a git repository, so there is no way back to a message: run "git init" there first.' };
  const head = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!head.ok || !head.stdout) return { problem: 'The repository has no commit yet, so there is nothing to go back to: make a first commit.' };
  const branch = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const scratch = await mkdtemp(join(tmpdir(), 'cop-checkpoint-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    const read = await git(dir, ['read-tree', 'HEAD'], 60_000, env);
    if (!read.ok) return { problem: `git could not read the commit: ${read.stderr}` };
    const add = await git(dir, ['add', '-A'], 120_000, env);
    if (!add.ok) return { problem: `git could not read the folder: ${add.stderr}` };
    const tree = await git(dir, ['write-tree'], 60_000, env);
    if (!tree.ok) return { problem: `git could not record the folder: ${tree.stderr}` };
    const commit = await git(dir, [...AUTHOR, 'commit-tree', tree.stdout, '-p', parent ?? head.stdout, '-m', message]);
    if (!commit.ok) return { problem: `git could not record the folder: ${commit.stderr}` };
    const kept = await git(dir, ['update-ref', ref, commit.stdout]);
    if (!kept.ok) return { problem: `git could not keep the record: ${kept.stderr}` };
    return { commit: commit.stdout, head: head.stdout, branch: branch.ok ? branch.stdout : '' };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Before a message: the folder as it is, kept under the message's id. */
export async function takeCheckpoint(dir: string, id: string): Promise<Checkpoint | { problem: string }> {
  const r = await photograph(dir, `refs/copilot-operator/checkpoints/${id}`, `checkpoint before message ${id}`);
  return 'problem' in r ? r : { ...r, at: new Date().toISOString() };
}

/** After a message: the folder again, on top of its checkpoint, so the commit holds exactly what the message changed. */
export async function takeAfter(dir: string, id: string, before: Checkpoint): Promise<{ commit: string } | { problem: string }> {
  const r = await photograph(dir, `refs/copilot-operator/after/${id}`, `after message ${id}`, before.commit);
  return 'problem' in r ? r : { commit: r.commit };
}

/**
 * The files a message has changed so far: the folder photographed now, against its checkpoint (for the review of a
 * chat message, 2026-10-20). The photograph is let go of afterwards; the one taken when the message ends is kept.
 */
export async function changedSince(dir: string, before: Checkpoint, id: string): Promise<string[]> {
  const ref = `refs/copilot-operator/review/${id}`;
  const r = await photograph(dir, ref, `the folder during the review of ${id}`, before.commit);
  if ('problem' in r) throw new Error(r.problem);
  try {
    const diff = await git(dir, ['diff', '--name-only', '--no-renames', before.commit, r.commit]);
    if (!diff.ok) throw new Error(diff.stderr);
    return diff.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } finally {
    await git(dir, ['update-ref', '-d', ref]).catch(() => undefined);
  }
}

/**
 * Puts the folder back as `cp` photographed it: its branch checked out at its commit, its working tree with the
 * same uncommitted changes. The folder as it is now is photographed first, under `refs/copilot-operator/safety/`.
 */
export async function restoreCheckpoint(dir: string, cp: Checkpoint): Promise<{ ok: true; safety: string } | { ok: false; problem: string }> {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  const safety = await photograph(dir, `refs/copilot-operator/safety/${stamp}`, `the folder before going back to ${cp.commit.slice(0, 8)}`);
  if ('problem' in safety) return { ok: false, problem: safety.problem };
  const step = async (args: string[], what: string): Promise<string | null> => {
    const r = await git(dir, args, 120_000);
    return r.ok ? null : `${what}: ${(r.stderr || r.stdout).split('\n')[0]}. Nothing is lost: the folder as it was is kept as ${safety.commit.slice(0, 8)}.`;
  };
  const problem =
    // On the branch it was on (or at its commit, when it was on none), whatever was checked out since.
    (cp.branch
      ? await step(['checkout', '--force', cp.branch], `${cp.branch} could not be checked out`)
      : await step(['checkout', '--force', '--detach', cp.head], `${cp.head.slice(0, 8)} could not be checked out`)) ??
    // At the commit it was on: a commit made after it, by the chat or by hand, is undone here (kept in the safety record).
    (cp.branch ? await step(['reset', '--hard', cp.head], `${cp.branch} could not be put back at ${cp.head.slice(0, 8)}`) : null) ??
    // Files made since that git does not track go; ignored ones (builds, installs) stay.
    (await step(['clean', '-f', '-d'], 'the files made since could not be removed')) ??
    // And the uncommitted changes as they were, untracked files included.
    (await step(['restore', '--source', cp.commit, '--worktree', '--', '.'], 'the files could not be put back'));
  return problem ? { ok: false, problem } : { ok: true, safety: safety.commit };
}
