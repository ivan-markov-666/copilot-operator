/**
 * Version control for a run, made ready on the run screen before anything opens the browser.
 *
 * From the feedback of 2026-10-02: the run screen named the right problem once per session, left the
 * run buttons on, and told the operator to approve a list they could not see; and version control was
 * only checked once the browser was open and the first task had begun. Version control should be light
 * and never in the way: every problem comes with the fix, done from here, said exactly before it is
 * done, and nothing about version control is left to find out after the browser opens.
 *
 * So the sessions of a run are grouped by repository — one problem is one problem, however many
 * sessions share the repository — and each group says where it stands (the repository, its branch and
 * HEAD, the base branch the plan asked for and its HEAD, the sessions, the input patterns, the matched
 * files with status and size, the unrelated uncommitted files apart) and what can be done:
 *
 *   review-inputs       show the input files; changes nothing
 *   snapshot-on-base    the starting snapshot on the base branch: that branch's tree plus the approved
 *                       input files only, committed with a temporary index — no branch switched, the
 *                       operator's checkout untouched. Every session of the run in that repository
 *                       that starts from that branch starts from it; a chained one carries it on.
 *   snapshot-here       the starting snapshot where the repository is, as the session page takes it
 *   use-current-branch  the sessions start from the branch the repository is on instead
 *   allow-snapshot      uncommitted changes become a starting snapshot to approve, instead of a refusal
 *
 * The run is refused before the browser opens while any group is not ready (see the service).
 */
import { join, resolve } from 'node:path';

import type { EventBus } from '../session/events.js';
import type { Session, SessionStart } from '../session/model.js';
import { branchNameFrom, freeBranchName, git } from './git.js';
import { commitOnto, dirtyBesidesInputs, inputSettings, inputSumsAt, missingInputPatterns } from './inputs.js';
import { dirtyPolicy, takeSnapshot, type SnapshotChoice, type SnapshotEntry } from './snapshot.js';
import { repoDirOf, vcsPreflight } from './taskVcs.js';
import { artifactPatterns } from './artifacts.js';
import { inScope } from './scope.js';

export type RunVcsActionId = 'review-inputs' | 'snapshot-on-base' | 'snapshot-here' | 'use-current-branch' | 'allow-snapshot';

export type RunVcsAction = {
  id: RunVcsActionId;
  available: boolean;
  recommended?: boolean;
  /** What pressing it does, exactly: commits, branches, settings, what stays as it is. */
  result: string;
  /** Why it is not available, when it is not. */
  why?: string;
};

export type RunVcsGroup = {
  repoDir: string;
  ready: boolean;
  problem?: string;
  branch: string | null;
  head: string | null;
  baseBranch?: string;
  baseHead?: string | null;
  /** The run's sessions in this repository, in run order, and how each will start. */
  sessions: Array<{ id: string; name: string; startFrom: string; started: boolean; role: 'first' | 'shares' | 'inherits' | 'own' }>;
  inputPatterns: string[];
  /** The input files a snapshot would take, with status and size. */
  inputs: SnapshotEntry[];
  /** Uncommitted files that are not inputs, apart. */
  unrelated: Array<{ path: string; reason?: string }>;
  /** Every file a snapshot where the repository is would list, with its default choice (for "snapshot-here"). */
  entries: SnapshotEntry[];
  actions: RunVcsAction[];
};

const norm = (dir: string): string => dir.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
const short = (c?: string | null): string => (c ?? '').slice(0, 8);
const names = (list: Array<{ name: string }>): string => list.map((s) => `"${s.name}"`).join(', ');

/** The groups, one per repository, for the sessions of a run in run order. */
export async function runVcsPreflight(sessions: Session[], allSessions: () => Promise<Session[]>): Promise<RunVcsGroup[]> {
  const byRepo = new Map<string, Session[]>();
  for (const s of sessions) {
    if (!s.vcs?.enabled || !repoDirOf(s)) continue;
    const key = norm(repoDirOf(s));
    byRepo.set(key, [...(byRepo.get(key) ?? []), s]);
  }
  const groups: RunVcsGroup[] = [];
  for (const list of byRepo.values()) groups.push(await groupFor(list, allSessions));
  return groups;
}

async function groupFor(list: Session[], allSessions: () => Promise<Session[]>): Promise<RunVcsGroup> {
  const first = list[0] as Session;
  const repoDir = repoDirOf(first);
  const branchR = await git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headR = await git(repoDir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const branch = branchR.ok && branchR.stdout !== 'HEAD' ? branchR.stdout : null;
  const head = headR.ok && headR.stdout ? headR.stdout : null;
  const startFrom = first.vcs?.startFrom ?? 'head';
  const baseBranch = startFrom === 'branch' || startFrom === 'previous-session' ? first.vcs?.baseBranch?.trim() || 'main' : undefined;
  const baseHead = baseBranch ? (await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}^{commit}`])).stdout || null : undefined;
  const settings = inputSettings(first.vcs);

  const sessions = list.map((s, i) => {
    const sf = s.vcs?.startFrom ?? 'head';
    const role: RunVcsGroup['sessions'][number]['role'] =
      i === 0 ? 'first' : sf === 'previous-session' ? 'inherits' : sf === 'branch' && (s.vcs?.baseBranch?.trim() || 'main') === baseBranch && !s.vcsBaseCommit ? 'shares' : 'own';
    return { id: s.id, name: s.name, startFrom: sf, started: !!s.vcsBaseCommit, role };
  });

  const pre = await vcsPreflight(first, allSessions);
  const plan = pre.snapshot;
  const inputs = (plan?.entries ?? []).filter((e) => e.input);
  /*
   * Every uncommitted file that is not an input, read from the tree itself: the snapshot's list stops at
   * the first thing in the way (other changes beside the inputs) and would leave them out.
   */
  const inputPaths = new Set(inputs.map((e) => e.path));
  const artifacts = artifactPatterns(first.vcs);
  const reasons = new Map((plan?.entries ?? []).filter((e) => !e.input && e.reason).map((e) => [e.path, e.reason as string]));
  const unrelated: RunVcsGroup['unrelated'] =
    pre.problem === 'off'
      ? []
      : (await dirtyBesidesInputs(repoDir, first.vcsStart)).other
          .filter((path) => !inputPaths.has(path) && !(artifacts.length > 0 && inScope(path, artifacts)))
          .map((path) => ({ path, ...(reasons.has(path) ? { reason: reasons.get(path) } : {}) }));

  // Before anything is approved: a pattern that matches nothing is said here, not after the browser opens.
  let problem = pre.ok ? undefined : pre.problem;
  // Problems no approval or setting of version control's own can get past: they need the operator.
  let blocking = false;
  if (!first.vcsBaseCommit && settings) {
    const topR = await git(repoDir, ['rev-parse', '--show-toplevel']);
    const missing = topR.ok ? await missingInputPatterns(first, repoDir, resolve(topR.stdout), allSessions) : [];
    if (missing.length > 0) {
      blocking = true;
      problem = `the input file pattern(s) ${missing.map((m) => `"${m}"`).join(', ')} match no file in the project: put the files in, or correct "Input files" on the session's page.`;
    }
  }
  /*
   * The branches the sessions name, before the browser opens rather than at their first task: a
   * branch to carry on that is not there, a base branch that is not there.
   */
  for (const s of list) {
    if (s.vcsBaseCommit) continue;
    const named = s.vcs?.startFrom === 'existing-branch' ? s.vcs.existingBranch?.trim() : s.vcs?.startFrom === 'branch' ? s.vcs.baseBranch?.trim() || 'main' : '';
    if (!named) continue;
    const there = (await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${named}^{commit}`])).stdout;
    if (!there) {
      blocking = true;
      problem = `${problem ? `${problem} ` : ''}"${s.name}" is set to ${s.vcs?.startFrom === 'existing-branch' ? 'carry on' : 'start from'} the local branch "${named}", and there is no such branch: create it, or change "Start from" on the session's page.`;
    }
  }
  const noCommits = first.vcs?.commitOnFinish === false;
  const ready = blocking ? false : !problem ? true : noCommits && !plan?.needed ? true : !!plan?.needed && plan.ok && !plan.requireApproval;

  const sharing = sessions.filter((s) => s.role === 'first' || s.role === 'shares');
  const inheriting = sessions.filter((s) => s.role === 'inherits');
  const blockedInputs = inputs.filter((e) => e.allowed.length === 0);
  const prefix = first.vcs?.branchPrefix || 'cop/';
  const baselineName = `${branchNameFrom(['baseline'], prefix)}/${first.id}`;

  const actions: RunVcsAction[] = [];
  if (inputs.length > 0) {
    actions.push({ id: 'review-inputs', available: true, result: `Shows the ${inputs.length} input file(s) with their git status and size. Changes nothing.` });
  }
  if (baseBranch && !first.vcsBaseCommit && inputs.length > 0) {
    const why = !baseHead
      ? `there is no local branch "${baseBranch}"`
      : unrelated.length > 0
        ? `besides the input files there are other uncommitted changes (${unrelated.slice(0, 5).map((u) => u.path).join(', ')}${unrelated.length > 5 ? '…' : ''}): commit or stash them first, or use the current branch instead`
        : blockedInputs.length > 0
          ? `${blockedInputs.map((b) => b.path).join(', ')} cannot be taken as input files`
          : problem && /match no file/.test(problem)
            ? problem
            : undefined;
    actions.push({
      id: 'snapshot-on-base',
      available: !why,
      recommended: !why && branch !== baseBranch,
      ...(why ? { why } : {}),
      result:
        `Commits the ${inputs.length} input file(s) on top of "${baseBranch}" (${short(baseHead)}) as "Capture user-provided inputs", on the new branch ${baselineName}, ` +
        `without switching branches: your checkout${branch ? ` of "${branch}"` : ''} and the files stay exactly as they are. ` +
        `${names(sharing)} start from it${inheriting.length > 0 ? `; ${names(inheriting)} carry it on through the chain` : ''}.`,
    });
  }
  if (plan?.needed && plan.ok && plan.requireApproval) {
    actions.push({
      id: 'snapshot-here',
      available: true,
      result: plan.recapture
        ? `Commits the ${plan.entries.length} changed input file(s) on "${first.name}"'s line of work (${plan.baselineBranch}); the next task starts from them.`
        : `Commits the ${plan.entries.filter((e) => e.choice === 'include').length} file(s) ticked on top of "${branch ?? 'HEAD'}" (${short(head)}) as one commit on the new branch ${plan.baselineBranch}, and puts the repository on it; "${branch ?? 'HEAD'}" itself does not move.` +
          (plan.entries.some((e) => e.choice === 'leave-out') ? ' Files left out go into .git/info/exclude.' : ''),
    });
  }
  if (baseBranch && startFrom === 'branch' && !first.vcsBaseCommit && branch && branch !== baseBranch) {
    actions.push({
      id: 'use-current-branch',
      available: true,
      result:
        `${names(sharing)} start from "${branch}" (${short(head)}) instead of "${baseBranch}": their "Start from" becomes "From wherever the repository is". ` +
        'Nothing is committed yet; a snapshot on that branch is offered next if one is needed.',
    });
  }
  if (!plan?.needed && unrelated.length > 0 && dirtyPolicy(first.vcs).policy === 'reject' && !first.vcsBaseCommit && !noCommits) {
    actions.push({
      id: 'allow-snapshot',
      available: true,
      result: `"Uncommitted changes" for "${first.name}" becomes "Take them as a starting snapshot": the files are listed here for you to approve. Nothing is committed yet.`,
    });
  }

  return {
    repoDir,
    ready,
    ...(problem && !ready ? { problem: problem.replace(/^There are uncommitted changes, and no starting snapshot can be taken: /, '') } : {}),
    branch,
    head,
    ...(baseBranch ? { baseBranch, baseHead } : {}),
    sessions,
    inputPatterns: settings?.patterns ?? [],
    inputs,
    unrelated,
    entries: plan?.entries ?? [],
    actions,
  };
}

/**
 * Does one action for one repository of a run, after checking it is still what was shown: the group is
 * worked out again, and an action that is no longer available, or a list of files that changed, is
 * refused with nothing done.
 */
export async function runVcsPrepare(
  sessions: Session[],
  repoDir: string,
  action: RunVcsActionId,
  choices: Record<string, SnapshotChoice>,
  bus: EventBus,
  saveSession: (id: string, mutate: (s: Session) => void) => Promise<void>,
  allSessions: () => Promise<Session[]>,
): Promise<{ ok: true; result: string } | { ok: false; problem: string }> {
  const list = sessions.filter((s) => s.vcs?.enabled && norm(repoDirOf(s)) === norm(repoDir));
  if (list.length === 0) return { ok: false, problem: 'none of the run\'s sessions works in that repository.' };
  const group = await groupFor(list, allSessions);
  const offered = group.actions.find((a) => a.id === action);
  if (!offered || !offered.available) return { ok: false, problem: offered?.why ?? 'that is not offered for this repository now. Look again; nothing was done.' };
  const first = list[0] as Session;

  if (action === 'review-inputs') return { ok: true, result: offered.result };

  if (action === 'use-current-branch') {
    const moved = group.sessions.filter((s) => (s.role === 'first' || s.role === 'shares') && !s.started);
    for (const s of moved) {
      await saveSession(s.id, (x) => {
        if (x.vcs) x.vcs.startFrom = 'head';
        x.vcsBaseCommit = undefined;
        x.vcsStart = undefined;
      });
    }
    return { ok: true, result: `${names(moved)} now start from "${group.branch}".` };
  }

  if (action === 'allow-snapshot') {
    await saveSession(first.id, (x) => {
      if (x.vcs) x.vcs.dirtyWorktree = { policy: 'snapshot' };
    });
    return { ok: true, result: `"${first.name}" takes its uncommitted changes as a starting snapshot once you approve the list.` };
  }

  if (action === 'snapshot-here') {
    const taken = await takeSnapshot(first, { approved: true, choices }, bus, async (m) => saveSession(first.id, m), allSessions);
    return taken.ok ? { ok: true, result: `taken: ${short(taken.start.commit)} on ${taken.start.branch ?? taken.start.inputs?.recaptured?.at(-1)?.branch ?? ''}.` } : { ok: false, problem: taken.problem };
  }

  // snapshot-on-base: the base branch's tree plus the approved inputs only, with a temporary index.
  const paths = group.inputs.map((e) => e.path);
  const shown = Object.keys(choices).sort();
  if (JSON.stringify(shown) !== JSON.stringify([...paths].sort()) || paths.some((p) => choices[p] !== 'include')) {
    return { ok: false, problem: 'the input files changed since the list was shown. Look at the list again; nothing was done.' };
  }
  const topR = await git(repoDir, ['rev-parse', '--show-toplevel']);
  if (!topR.ok || !topR.stdout || !group.baseHead || !group.baseBranch) return { ok: false, problem: 'the base branch could not be read.' };
  const top = resolve(topR.stdout);
  const files: Array<{ path: string; mode: string; blob: string }> = [];
  for (const path of paths) {
    const blob = await git(top, ['hash-object', '-w', `--path=${path}`, '--', join(top, path)]);
    if (!blob.ok || !blob.stdout) return { ok: false, problem: `${path} could not be read into git: ${blob.stderr}` };
    const mode = (await git(top, ['ls-tree', group.baseHead, '--', path])).stdout.split(' ')[0] || '100644';
    files.push({ path, mode, blob: blob.stdout });
  }
  const branch = await freeBranchName(top, `${branchNameFrom(['baseline'], first.vcs?.branchPrefix || 'cop/')}/${first.id}`);
  const sharing = group.sessions.filter((s) => (s.role === 'first' || s.role === 'shares') && !s.started);
  const message = [
    'Capture user-provided inputs',
    '',
    `The operator's input files, approved on the run screen, on top of "${group.baseBranch}" (${short(group.baseHead)}).`,
    `Made without switching branches; the sessions ${names(sharing)} start from it. The work reads them and does not change them.`,
    '',
    ...paths.slice(0, 200).map((p) => `- ${p}`),
    '',
    'Committed by copilot-operator. Not pushed.',
    '',
  ].join('\n');
  const made = await commitOnto(top, group.baseHead, files, message, branch);
  if ('problem' in made) return { ok: false, problem: made.problem };
  const settings = inputSettings(first.vcs);
  const sums = await inputSumsAt(top, made.commit, settings?.patterns ?? []);
  const approvedAt = new Date().toISOString();
  for (const s of sharing) {
    const start: SessionStart = {
      kind: 'snapshot',
      commit: made.commit,
      branch,
      snapshot: {
        fromBranch: group.baseBranch,
        fromCommit: group.baseHead,
        included: paths.slice(0, 500),
        leftOut: [],
        approved: true,
        onBase: true,
        approvedAt,
        sharedWith: sharing.map((x) => ({ id: x.id, name: x.name })),
      },
      inputs: { patterns: settings?.patterns ?? [], files: sums, readOnly: settings?.readOnly ?? true },
    };
    await saveSession(s.id, (x) => {
      x.vcsBaseCommit = made.commit;
      x.vcsStart = start;
    });
    bus.publish({
      sessionId: s.id,
      type: 'vcs-snapshot',
      level: 'info',
      message: `starting snapshot approved on the run screen: ${paths.length} input file(s) on top of ${group.baseBranch} (${short(group.baseHead)}) as ${short(made.commit)} on ${branch}; the checkout was not touched`,
      data: { commit: made.commit, branch, base: group.baseHead, baseBranch: group.baseBranch, inputs: paths, approvedAt, sessions: sharing.map((x) => x.id) },
    });
  }
  return { ok: true, result: `taken: ${short(made.commit)} on ${branch}, on top of "${group.baseBranch}"; ${names(sharing)} start from it.` };
}
