/**
 * A branch of its own for each task of the queue "on a new branch from main" (operator, 2026-10-26: "the branches are
 * best made when the task is added to the queue, not when its turn comes; the bot knows which branch each chat works
 * with, and changes to it when it goes from one task to another"). Made when the task is added — the operator is there
 * to type a password if the remote asks for one, in Git's own window — at the remote's main as it is then; brought up
 * to the remote's main when the task starts, if nothing has been done on it yet and the remote can be read without
 * asking anybody. The run then works on it as an existing branch (`startFrom: 'existing-branch'`).
 */
import { branchNameFrom, freeBranchName, git, isAncestor } from '../vcs/git.js';
import { planNewBranch } from '../vcs/newBranch.js';
import { fetchAsOperator } from '../vcs/remoteAuth.js';
import { mainBranchOf } from './queue.js';

/** Where new branches start from: the remote's main as fetched now (or as last fetched), else the local main. */
export type BranchStart = { commit: string; from: string; fetched: boolean } | { problem: string };

/** Fetches the remote's main once, through Git's window when it asks; for every branch made in one edit of the list. */
export async function branchStart(dir: string, askpass: string | null): Promise<BranchStart> {
  const plan = await planNewBranch(dir, { fetch: true, askpass });
  if (plan.ok && plan.targetCommit) return { commit: plan.targetCommit, from: plan.target ?? 'origin/main', fetched: !!plan.fetched?.ok };
  // No remote, or no main of it known: the local main, as a task "on a new branch from main" always had.
  const local = await mainBranchOf(dir);
  if (!local) return { problem: plan.problem ?? `${dir} has no main (or master) branch to make a branch from` };
  const commit = (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}^{commit}`])).stdout;
  return commit ? { commit, from: local, fetched: false } : { problem: `${local} could not be read` };
}

/**
 * A free branch name for a task: `queue/<its id>-<its name>`, the name in Latin letters only — one typed at a prompt
 * should not need another keyboard — and `-2` and on when it is taken.
 */
export async function queueBranchName(dir: string, id: string, title: string): Promise<string> {
  const latin = title.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').trim();
  return await freeBranchName(dir, branchNameFrom([id, latin.slice(0, 40)], 'queue/'));
}

/** Makes the branch at `start`, not checked out: the folder is not touched. */
export async function makeQueueBranch(dir: string, id: string, title: string, start: { commit: string }): Promise<{ branch: string; base: string } | { problem: string }> {
  const branch = await queueBranchName(dir, id, title);
  const made = await git(dir, ['branch', '--no-track', branch, start.commit]);
  if (!made.ok) return { problem: (made.stderr || made.stdout || `the branch ${branch} could not be made`).split(/\r?\n/)[0]! };
  return { branch, base: start.commit };
}

/**
 * At the task's start: the branch brought up to the remote's main when nothing has been done on it yet — still at the
 * commit it was made at — and the remote can be read without asking anybody (nobody may be there). Forward only.
 */
export async function refreshQueueBranch(dir: string, branch: string, base: string): Promise<{ base: string; moved: boolean; detail?: string }> {
  const tip = (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])).stdout;
  if (!tip) return { base, moved: false, detail: `there is no branch ${branch} any more` };
  if (tip !== base) return { base, moved: false, detail: 'work is on it already' };
  const remotes = (await git(dir, ['remote'])).stdout.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!remote) return { base, moved: false, detail: 'no remote' };
  const fetched = await fetchAsOperator(dir, remote, { askpass: null, refspecs: [`+refs/heads/main:refs/remotes/${remote}/main`] });
  if (!fetched.ok) return { base, moved: false, detail: fetched.detail };
  const latest = (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/main^{commit}`])).stdout;
  if (!latest || latest === base) return { base, moved: false };
  if (!(await isAncestor(dir, base, latest))) return { base, moved: false, detail: `${remote}/main went another way` };
  const current = (await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout;
  const moved = current === branch ? await git(dir, ['merge', '--ff-only', '--quiet', latest]) : await git(dir, ['update-ref', '-m', `copilot-operator: ${branch} brought up to ${remote}/main`, `refs/heads/${branch}`, latest, base]);
  return moved.ok ? { base: latest, moved: true } : { base, moved: false, detail: (moved.stderr || moved.stdout).split(/\r?\n/)[0] };
}
