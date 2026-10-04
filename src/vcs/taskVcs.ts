/**
 * Version control around one task: a branch before it, a commit after it.
 *
 * The shape of this is the answer to one question the operator asked: how do you put the code
 * back the way it was before a task, when that task is run again? The answer here is that you
 * never put anything back. Each task records the commit it started from, and a re-run cuts a
 * fresh branch from that exact commit. The old branch keeps everything the first attempt did,
 * the new one starts from the same place the first one did, and nothing is rewritten, reset or
 * deleted. Going back is additive.
 *
 * The two branch modes are the operator's other question:
 *
 *   per-task     every task branches from the session's base commit, so a task never sees
 *                what the task before it changed. Independent checks against one starting
 *                point.
 *   per-session  one branch for the whole queue, so each task builds on the last. A chain.
 */
import type { EventBus } from '../session/events.js';
import type { Session, SessionStart, Task, TaskVcs, VersionControl } from '../session/model.js';
import type { Deviation } from '../protocol/replySchema.js';
import { findSuspicious } from './commitHygiene.js';
import { dirtyPolicy, planSnapshot, someOf, takeSnapshot, type SnapshotPlan } from './snapshot.js';
import { dirtyBesidesInputs, inputSettings, inputsNote, settleInputs } from './inputs.js';
import { artifactPatterns, excludeArtifacts } from './artifacts.js';
import { workingTreePaths } from './git.js';
import { inScope } from './scope.js';
import { branchExists, branchNameFrom, describeUpdate, updateFromRemote, type BranchUpdate, localBranches, commitAll, commitFiles, commitsBetween, commitSubject, createBranch, foreignCommits, isAncestor, checkoutExisting, freeBranchName, git, isValidBranchName, plannedBranchName, repoState } from './git.js';

/** Which repository a session works in: its own setting, else the project it mirrors. */
export function repoDirOf(session: Pick<Session, 'vcs' | 'projectDir'>): string {
  return (session.vcs?.repoDir?.trim() || session.projectDir?.trim() || '').trim();
}

/**
 * The repository version control keeps this session's work in, or '' when version control is off.
 *
 * What a reader asks when it wants "the session's repository": `repoDirOf` says which folder that
 * is, and this says whether there is one. Readers that took `vcs.repoDir` itself missed a session
 * whose repository is its project folder — version control on, `repoDir` empty, `projectDir` set,
 * as the session page can save it — where the branch is cut and the work committed all the same:
 * the reviewer was told there was no repository and no changed files.
 */
export function trackedRepoOf(session: Pick<Session, 'vcs' | 'projectDir'>): string {
  return session.vcs?.enabled ? repoDirOf(session) : '';
}

export type PrepareResult = {
  vcs: TaskVcs;
  /** What level 1 should tell Copilot about the repository, or empty when there is nothing. */
  note: string;
  /**
   * Set when the task must not run at all: the session is to carry on an existing branch and the
   * runner cannot put the repository on it. Running anyway would put the work on whatever branch is
   * checked out — the mixing of unrelated work this option exists to prevent.
   */
  refuse?: string;
};

/**
 * Puts the repository on the right branch for a task and reports where it starts from.
 *
 * A problem is never fatal. Version control failing is a reason to tell the operator and carry
 * on without it, not a reason to throw away a queue of work: the task itself may not even
 * touch the repository.
 */
export async function prepareForTask(
  session: Session,
  task: Task,
  bus: EventBus,
  saveSession: (mutate: (s: Session) => void) => Promise<void>,
  /** Every session on record, for `startFrom: previous-session` to find the one before this. */
  allSessions: () => Promise<Session[]> = async () => [],
): Promise<PrepareResult> {
  const prepared = await prepare(session, task, bus, saveSession, allSessions);
  /*
   * Version control that is on but cannot do its part refuses the task, whatever the cause — a dirty
   * tree, a starting branch that is not there, a branch git would not make. It used to be "on but
   * inactive": the task ran, nothing was committed, and the task still ended done with its work
   * loose in the tree. A task that cannot be committed is not run.
   */
  // Not when the operator chose no commits (`commitOnFinish` false): earlier tasks' files are then
  // meant to stay in the tree, and refusing would stop every task after the first.
  if (session.vcs?.enabled && session.vcs.commitOnFinish !== false && !prepared.refuse && !prepared.vcs.branch && prepared.vcs.problem) {
    const why = `version control is on and cannot work for this task: ${prepared.vcs.problem.replace(/\.?\s*$/, '.')} Nothing was run.`;
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-refused', level: 'error', message: why });
    return { ...prepared, refuse: why };
  }
  return prepared;
}

async function prepare(
  session: Session,
  task: Task,
  bus: EventBus,
  saveSession: (mutate: (s: Session) => void) => Promise<void>,
  allSessions: () => Promise<Session[]>,
): Promise<PrepareResult> {
  const settings = session.vcs;
  if (!settings?.enabled) return { vcs: {}, note: '' };

  const dir = repoDirOf(session);
  let state = await repoState(dir);

  if (!state.isRepo) {
    const problem = state.problem ?? 'The repository could not be read.';
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-unavailable', level: 'warn',
      message: `version control is on but inactive: ${problem}` });
    return { vcs: { problem }, note: '' };
  }

  const refuse = (why: string): PrepareResult => {
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-refused', level: 'error', message: why });
    return { vcs: { problem: why }, note: '', refuse: why };
  };

  /*
   * The session's artifacts are never committed: their patterns go into the repository's own
   * exclude file before anything looks at the tree, so they neither make it dirty nor go into a
   * commit. See `artifacts.ts`.
   */
  const excluded = await excludeArtifacts(dir, session);
  if (excluded.problem) return refuse(`the session's artifacts could not be kept out of git: ${excluded.problem}. Nothing was run.`);
  if (excluded.tracked.length > 0) {
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-artifacts-tracked', level: 'warn',
      message: `${excluded.tracked.length} artifact file(s) are already tracked by git, so a change to them is still committed: ${someOf(excluded.tracked)}. Take them out of git yourself (git rm --cached) if they should not be.` });
  }
  // Read again: the exclude file may just have taken the scratch folder or artifacts out of what makes the tree dirty.
  state = await repoState(dir);

  if (settings.startFrom === 'existing-branch') return await onExistingBranch(session, task, dir, state, bus, saveSession, allSessions);

  // The session's base is fixed the first time it runs: every per-task branch is cut from it,
  // which is what makes the tasks independent of each other rather than of the calendar. Where
  // it is taken from is the session's `startFrom`; see `sessionStart`.
  let base = session.vcsBaseCommit;
  let start = session.vcsStart;

  /*
   * The operator's own changes before the session's first task — under a snapshot policy, or its
   * input files: they become the commit the session starts from (see `snapshot.ts`). Asked for
   * approval, the run is refused until the list has been approved on the session's page; running
   * without version control instead would be the one outcome the operator chose against.
   */
  const dirty = dirtyPolicy(settings);
  const inputs = inputSettings(settings);
  // Input files are looked for even in a clean tree: an ignored input does not make it dirty.
  if ((state.dirty || inputs) && !base && (dirty.policy !== 'reject' || inputs)) {
    const plan = await planSnapshot(session, allSessions);
    if (plan.needed) {
      if (!plan.ok) return refuse(`the starting snapshot cannot be taken: ${plan.problem} Nothing was run.`);
      if (plan.requireApproval) {
        return refuse(
          `the repository has uncommitted changes (${someOf(plan.entries.map((e) => e.path))}), and this session takes them as its starting snapshot ` +
            'once you have approved the list: on the session\'s page, Version control → "Uncommitted changes", choose what goes in and take the snapshot. Nothing was run.',
        );
      }
      const taken = await takeSnapshot(session, { approved: false }, bus, saveSession, allSessions);
      if (!taken.ok) return refuse(`the starting snapshot of the uncommitted changes was not taken: ${taken.problem} Nothing was run.`);
      base = taken.start.commit;
      start = taken.start;
      state = await repoState(dir);
    }
  }

  /*
   * Started already, and input files changed or were added since: taken onto the session's line of
   * work (see `recaptureInputs`), with the operator's approval unless they said otherwise. They used
   * to be "a dirty tree to commit or stash": version control went off and the task ran without it.
   */
  if (base && inputs) {
    const plan = await planSnapshot(session, allSessions);
    if (plan.needed && plan.recapture) {
      if (!plan.ok) return refuse(`the input files changed since the session started cannot be taken: ${plan.problem} Nothing was run.`);
      if (plan.requireApproval) {
        return refuse(
          `input files changed or were added since the session started (${someOf(plan.entries.map((e) => e.path))}). Approve them on the session's page, ` +
            'Version control → "Uncommitted changes", and they are committed on its line of work before the next task. Nothing was run.',
        );
      }
      const taken = await takeSnapshot(session, { approved: false }, bus, saveSession, allSessions);
      if (!taken.ok) return refuse(`the changed input files were not taken: ${taken.problem} Nothing was run.`);
      start = taken.start;
      if (plan.recapture.newBranch) base = taken.start.inputs?.recaptured?.at(-1)?.commit ?? base;
      state = await repoState(dir);
    }
  }

  /*
   * Input files taken into a starting snapshot on the base branch stay untracked where they are, as
   * they were approved: not "a dirty tree" while their content is the recorded one. They are staged
   * when the task's branch is checked out, so the switch keeps them (see `switchTo`).
   */
  let carryInputs: string[] = [];
  if (state.dirty && start?.inputs) {
    const split = await dirtyBesidesInputs(dir, start);
    if (split.other.length === 0 && split.inputs.length > 0) {
      carryInputs = split.inputs;
      state = { ...state, dirty: false };
    }
  }

  // A dirty tree is the operator's own work in progress. Committing it under the bot's name
  // or moving it to another branch would both be decisions that are not ours to make — unless
  // the operator made it, with a snapshot policy, above.
  if (state.dirty) {
    /*
     * With commits off, what an earlier task of this session wrote is still in the tree: that is how the
     * session is set, not the operator's work to commit or stash (live run 2026-10-03). Said as it is: this
     * task runs on top of it, without a branch of its own.
     */
    const earlierRan = session.tasks.some((t) => t.id !== task.id && t.status !== 'queued' && !!t.startedAt);
    const commitsOff = settings.commitOnFinish === false;
    const problem = commitsOff && earlierRan
      ? `commits are off for this session, so the files the earlier task(s) left are still in the working tree (${state.changed.slice(0, 5).join(', ')}` +
        `${state.changed.length > 5 ? `, and ${state.changed.length - 5} more` : ''}). This task runs on top of them, on ${state.branch ?? 'the current branch'}, without a branch of its own, and its scope is not enforced. ` +
        'For a branch per task, turn "Commit when a task finishes" on, or use one branch for the whole session.'
      : `the repository has uncommitted changes (${state.changed.slice(0, 5).join(', ')}` +
        `${state.changed.length > 5 ? `, and ${state.changed.length - 5} more` : ''}). ` +
        (base
          ? 'Commit or stash them, so the task starts from a known state.'
          : 'Commit or stash them, or choose "Take them as a starting snapshot" under Version control → "Uncommitted changes" (input files: "Input files").');
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-dirty', level: 'warn',
      message: `version control cannot start: ${problem}` });
    return { vcs: { problem }, note: '' };
  }

  let startIsNew = false;
  if (!base) {
    const resolved = await sessionStart(session, dir, state.head, allSessions);
    if ('problem' in resolved) {
      bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-problem', level: 'warn',
        message: `version control is on but inactive: ${resolved.problem}` });
      return { vcs: { problem: resolved.problem }, note: '' };
    }
    start = resolved.start;
    base = start?.commit;
    /*
     * Recorded below, once the inputs are settled too, not here. Recorded here, a task refused for its
     * inputs (a pattern matching nothing yet) left the session started: the retry, with the files added,
     * skipped the starting snapshot and ran with version control off (reported on 0.1.18). A start that
     * is refused records nothing, and the retry starts afresh.
     */
    startIsNew = !!start;
  }

  /*
   * The operator's input files, in the commit the session starts from whatever its `startFrom`, with
   * their sums on the record. Once per session: a start that has recorded them has them.
   */
  if (inputs && start && !start.inputs) {
    const settled = await settleInputs(session, dir, start, allSessions);
    if ('problem' in settled) return refuse(`${settled.problem} Nothing was run.`);
    start = settled.start;
    base = settled.start.commit;
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-inputs', level: 'info',
      message: describeInputs(settled.start), data: { files: settled.start.inputs?.files.length ?? 0, carried: settled.start.inputs?.carried } });
    startIsNew = true;
  }
  if (startIsNew && start) {
    const chosen = start;
    await saveSession((s) => {
      s.vcsBaseCommit = chosen.commit;
      s.vcsStart = chosen;
    });
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-start', level: chosen.note || updateWarns(chosen) ? 'warn' : 'info',
      message: describeStart(chosen), data: { ...chosen } });
  }

  const attempt = task.attempt ?? 1;
  const prefix = settings.branchPrefix || 'cop/';

  if (settings.branchMode === 'per-session') {
    /*
     * "Run again" of a task whose last attempt did not end done starts again from where the task first
     * started, as the button promises, and not on top of the failed attempt's commit (live run
     * 2026-10-03: the re-run found the failed attempt's files, "already satisfied" them and committed
     * nothing). Only when no other task of the session ran after this one: then the session's line moves
     * to a new branch at that point, and the old one keeps the failed attempt. Otherwise the later work
     * sits on top, and "Run again from here" is the way to take the whole chain back.
     */
    const previous = task.attempts?.at(-1);
    const startedFirst = task.attempts?.[0]?.startedAt;
    const laterRan = !!startedFirst && session.tasks.some((t) => t.id !== task.id && t.startedAt && t.startedAt > startedFirst);
    const restartAt = !task.continuing && !task.buildsOn && previous && previous.status !== 'done' ? firstAttemptBase(task) : undefined;
    // Already there — "Run again from here" or a Restore moved the session onto a branch at that point — then nothing to move.
    const tipNow = (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${sessionBranchName(session)}^{commit}`])).stdout;
    if (restartAt && !laterRan && tipNow && tipNow !== restartAt) {
      const left = sessionBranchName(session);
      const fresh = await freeBranchName(dir, `${left}-a${attempt}`);
      await saveSession((s) => {
        if (s.vcs) {
          s.vcs.branchName = fresh;
          s.vcs.branchNameExact = true;
        }
      });
      bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-session-branch', level: 'info',
        message: `"${task.title}" runs again from where it first started (${restartAt.slice(0, 8)}), on ${fresh}; ${left} keeps the failed attempt`,
        data: { branch: fresh, left, from: restartAt } });
      return await switchTo(session, task, dir, fresh, restartAt, bus, { reuseExisting: false, start, stage: carryInputs });
    }
    if (restartAt && laterRan) {
      bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-builds-on-failed', level: 'warn',
        message: `"${task.title}" runs again on ${sessionBranchName(session)}, on top of its failed attempt, because later tasks of this session ran after it; use "Run again from here" to take the chain back to before it` });
    }
    return await switchTo(session, task, dir, sessionBranchName(session), base, bus, { reuseExisting: true, start, stage: carryInputs });
  }

  // A name the task carries wins over one derived from its title: whoever wrote the plan knew
  // what the task was for, and a title is only ever a label for the list.
  const plannedBranch = task.vcsPlan?.branch?.trim();
  const wanted = plannedBranch
    ? plannedBranchName(plannedBranch, prefix, attempt)
    : branchNameFrom([session.name, task.title, attempt > 1 ? `a${attempt}` : undefined], prefix);
  // A continuation carries on where the previous attempt stopped, on that attempt's own branch:
  // its work is what is being continued. See `continueTask` in the store.
  // The same for a new prompt given to a finished task: it builds on that attempt's work.
  const previousBranch = task.continuing || task.buildsOn ? task.attempts?.at(-1)?.vcs?.branch : undefined;
  if (previousBranch) return await switchTo(session, task, dir, previousBranch, base, bus, { reuseExisting: true, start, stage: carryInputs });
  /*
   * The previous attempt committed nothing and its branch is still where it was cut: that branch is
   * taken again rather than leaving it empty beside a new "-a2" that holds the work (live run 2026-10-03,
   * a fresh-chat retry). The branch the task first started from is the same commit, so nothing changes
   * about where the attempt stands.
   */
  const prev = task.attempts?.at(-1);
  if (prev?.vcs?.branch && prev.vcs.baseCommit && !prev.vcs.commit && prev.vcs.baseCommit === firstAttemptBase(task)) {
    const tip = (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${prev.vcs.branch}^{commit}`])).stdout;
    if (tip && tip === prev.vcs.baseCommit) {
      return await switchTo(session, task, dir, prev.vcs.branch, prev.vcs.baseCommit, bus, { reuseExisting: true, start, stage: carryInputs });
    }
  }
  // A re-run starts from where that task started the first time, not from where the previous
  // attempt ended. That is the whole point of recording the base commit.
  const from = firstAttemptBase(task) ?? base;
  return await switchTo(session, task, dir, wanted, from, bus, { reuseExisting: false, start, stage: carryInputs });
}

/**
 * The one branch a `per-session` session works on: the name it was given, else one made from its
 * name and id. Every task of the session is put on it, and an existing branch of that name is
 * carried on, not copied — which is why "Run again from here" names the restore branch here when it
 * takes a chain back (see `OperatorService.rerunFromRestore`).
 */
export function sessionBranchName(session: Session): string {
  const prefix = session.vcs?.branchPrefix || 'cop/';
  return namedSessionBranch(session.vcs) ?? branchNameFrom([session.name, session.id.slice(0, 13)], prefix);
}

/**
 * The branch a session's `branchName` names, or undefined when it names none: a name a plan or the
 * operator chose, made safe (`plannedBranchName`), or a branch this program made, as it is written
 * (`branchNameExact`). The one reading of the field, for the run and for what the pages show.
 */
export function namedSessionBranch(vcs: VersionControl | undefined): string | undefined {
  const named = vcs?.branchName?.trim();
  if (!named) return undefined;
  return vcs?.branchNameExact ? named : plannedBranchName(named, vcs?.branchPrefix || 'cop/');
}

/**
 * A session that carries on an existing branch: every task on that branch, exactly as named.
 *
 * Nothing is created. The branch must exist and the tree must be clean — the uncommitted changes
 * would otherwise be carried onto the branch, or stop the switch half-way — and anything else
 * refuses the task before a message is sent. The first run records the branch's tip as where the
 * session started, so the record and a restore know what was there before the work.
 */
async function onExistingBranch(
  session: Session,
  task: Task,
  dir: string,
  state: Awaited<ReturnType<typeof repoState>>,
  bus: EventBus,
  saveSession: (mutate: (s: Session) => void) => Promise<void>,
  allSessions: () => Promise<Session[]>,
): Promise<PrepareResult> {
  const wanted = (session.vcs?.existingBranch ?? '').trim();
  const refuse = (why: string): PrepareResult => {
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-refused', level: 'error', message: why });
    return { vcs: { problem: why }, note: '', refuse: why };
  };
  if (!wanted) return refuse('this session is set to carry on an existing branch, and no branch is named. Name it (Version control → "Start from").');
  if (!(await branchExists(dir, wanted))) {
    const have = await localBranches(dir);
    return refuse(
      `this session is set to carry on the branch "${wanted}", and ${dir} has no such local branch` +
        `${have.length > 0 ? ` (it has: ${have.slice(0, 12).join(', ')})` : ''}. Nothing was run.`,
    );
  }
  if (state.dirty) {
    return refuse(
      `the repository has uncommitted changes (${state.changed.slice(0, 5).join(', ')}${state.changed.length > 5 ? `, and ${state.changed.length - 5} more` : ''}), ` +
        `so the work cannot be put on "${wanted}" without taking them along. Commit or stash them first. Nothing was run.` +
        (dirtyPolicy(session.vcs).policy !== 'reject' ? ' A starting snapshot does not apply here: it is a branch of its own, and this session works on the branch you named.' : ''),
    );
  }
  let start = session.vcsStart;
  if (!session.vcsBaseCommit || start?.kind !== 'existing-branch' || start.branch !== wanted) {
    const update = session.vcs?.updateFromRemote !== false ? await updateFromRemote(dir, wanted) : undefined;
    const tip = await branchTip(dir, wanted);
    if (tip) {
      const chosen: SessionStart = { kind: 'existing-branch', commit: tip, branch: wanted, ...(update ? { update } : {}) };
      start = chosen;
      await saveSession((s) => {
        s.vcsBaseCommit = chosen.commit;
        s.vcsStart = chosen;
      });
      bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-start', level: updateWarns(chosen) ? 'warn' : 'info', message: describeStart(chosen), data: { ...chosen } });
    }
  }
  /*
   * The input files must already be on the branch, as they are: the runner commits nothing onto a
   * branch the operator named, so one that lacks them, or has them otherwise, is refused.
   */
  if (inputSettings(session.vcs) && start && !start.inputs) {
    const settled = await settleInputs(session, dir, start, allSessions);
    if ('problem' in settled) return refuse(`${settled.problem} Nothing was run.`);
    if (settled.start.commit !== start.commit) {
      return refuse(
        `the input files are not on "${wanted}" as they were last committed (${settled.start.inputs?.carried?.from ?? 'elsewhere'}), and the runner does not commit onto a branch you named. ` +
          `Commit them on "${wanted}" yourself. Nothing was run.`,
      );
    }
    const chosen = settled.start;
    start = chosen;
    await saveSession((s) => {
      s.vcsStart = chosen;
    });
  }
  const prepared = await switchTo(session, task, dir, wanted, undefined, bus, { reuseExisting: true, mustExist: true, start });
  return prepared.vcs.branch === wanted ? prepared : refuse(`the repository could not be put on "${wanted}": ${prepared.vcs.problem ?? 'unknown reason'}. Nothing was run.`);
}

/**
 * The commit a session's first branch is cut from, by its `startFrom`, or why there is none.
 *
 * `previous-session` looks for the session whose work was committed last in this same repository —
 * not the one listed before it, because a plan may put sessions in several repositories, and
 * continuing a front end from a back end's branch would be nonsense. In a run of several sessions
 * that is the one that ran just before; started on its own, it is the last one that worked here.
 * When there is none, it starts from `baseBranch` and says so, rather than from wherever the
 * repository happens to be.
 */
export async function sessionStart(
  session: Session,
  dir: string,
  head: string | null,
  allSessions: () => Promise<Session[]>,
  /** `dry`: only whether it can start — nothing fetched or moved. For the checks before the browser opens. */
  opts: { dry?: boolean } = {},
): Promise<{ start?: SessionStart } | { problem: string }> {
  const how = session.vcs?.startFrom ?? 'head';
  const baseBranch = session.vcs?.baseBranch?.trim() || 'main';
  if (how === 'head') return head ? { start: { kind: 'head', commit: head } } : {};

  const fromBranch = async (note?: string): Promise<{ start?: SessionStart } | { problem: string }> => {
    // The code as it is on the server, not as this checkout last pulled it: see `updateFromRemote`.
    const update = !opts.dry && session.vcs?.updateFromRemote !== false && (await branchTip(dir, baseBranch)) ? await updateFromRemote(dir, baseBranch) : undefined;
    const tip = await branchTip(dir, baseBranch);
    if (!tip) {
      return {
        problem:
          `this session is set to start from the local branch "${baseBranch}", and ${dir} has no such branch. ` +
          'Name the branch the work should start from (Version control → "Start from"), or create it.',
      };
    }
    return { start: { kind: 'branch', commit: tip, branch: baseBranch, ...(note ? { note } : {}), ...(update ? { update } : {}) } };
  };
  if (how === 'branch') return await fromBranch();

  /*
   * The session before this one: the one that ran last in this repository, however it ended — not the
   * last one that happened to commit, which skipped a predecessor that had failed or committed
   * nothing and continued from older work as if it were the latest. A session set aside does not count.
   */
  const here = normalise(dir);
  let pred: { session: Session; at: string } | null = null;
  for (const other of await allSessions()) {
    if (other.id === session.id || !other.vcs?.enabled || other.active === false || normalise(repoDirOf(other)) !== here) continue;
    const at = lastActivityOf(other);
    if (at && (!pred || at > pred.at)) pred = { session: other, at };
  }
  if (!pred) return await fromBranch(`no earlier session has run in this repository, so it starts from "${baseBranch}"`);
  const before = pred.session;

  /*
   * Checked before anything is carried on: the previous session finished, and what it produced is
   * there — a final commit on a branch that still exists, or a result that is artifacts only (or no
   * change at all), which ends where it started. Anything else is refused with what is wrong; it used
   * to fall back to the base branch with a note, and the chain went on without the work it needed.
   */
  const unfinished = before.tasks.filter((t) => t.status !== 'done');
  if (unfinished.length > 0) {
    return {
      problem:
        `this session continues the previous session in this repository, "${before.name}", which has not finished: ` +
        `${unfinished.slice(0, 6).map((t) => `"${t.title}" is ${t.status}`).join(', ')}${unfinished.length > 6 ? `, and ${unfinished.length - 6} more` : ''}. ` +
        'Finish it first (Continue or Run again), or choose another "Start from".',
    };
  }
  const work = lastWorkOf(before);
  if (!work) {
    const startedAt = before.vcsBaseCommit;
    if (!startedAt || !(await git(dir, ['cat-file', '-e', `${startedAt}^{commit}`])).ok) {
      return { problem: `the previous session "${before.name}" committed nothing, and the commit it started from is not in the repository, so there is nothing to carry on from.` };
    }
    const artifactsOnly = before.tasks.some((t) => (t.artifactsKept?.length ?? 0) > 0);
    return {
      start: {
        kind: 'previous-session',
        commit: startedAt,
        ...(before.vcsStart?.branch ? { branch: before.vcsStart.branch } : {}),
        fromSession: { id: before.id, name: before.name },
        ...inheritedBaseline(before),
        note: artifactsOnly
          ? `"${before.name}" committed nothing — its result is artifacts only — so this session starts where it started (${startedAt.slice(0, 8)})`
          : `"${before.name}" changed nothing, so this session starts where it started (${startedAt.slice(0, 8)})`,
      },
    };
  }
  const best = { session: before, ...work };
  const tip = await branchTip(dir, best.branch);
  if (!tip) {
    return {
      problem:
        `the branch of the previous session "${best.session.name}" (${best.branch}) is no longer in the repository, so its final commit cannot be carried on. ` +
        'Restore the branch, or choose another "Start from".',
    };
  }
  /*
   * The whole of that session's done work, or nothing. In per-task mode every task has a branch of
   * its own, all cut from one commit, so the branch of the task that finished last holds that task's
   * work only — a chain that started there began without the files the earlier tasks had made,
   * though they were in the repository on other branches. The runner does not merge them; it says
   * which are missing and refuses, rather than start from part of the work as if it were all.
   */
  const missing: string[] = [];
  for (const t of best.session.tasks) {
    if (t.status !== 'done') continue;
    const done = [{ vcs: t.vcs, at: t.finishedAt }, ...(t.attempts ?? []).map((a) => ({ vcs: a.vcs, at: a.finishedAt }))]
      .filter((v) => !!v.vcs?.commit && !!v.vcs.branch)
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))[0];
    if (done?.vcs?.commit && !(await isAncestor(dir, done.vcs.commit, tip))) missing.push(`"${t.title}" (on ${done.vcs.branch})`);
  }
  if (missing.length > 0) {
    return {
      problem:
        `this session continues the previous session "${best.session.name}", whose done work is not on one branch: ${best.branch} does not have ` +
        `${missing.slice(0, 8).join(', ')}${missing.length > 8 ? `, and ${missing.length - 8} more` : ''}. ` +
        'That session ran per task, so each task\'s work is on its own branch. Merge them into one branch and continue it ("Carry on an existing branch"), ' +
        'or run that session "One branch for the whole session" so the next one can carry on from it.',
    };
  }
  return { start: { kind: 'previous-session', commit: tip, branch: best.branch, fromSession: { id: best.session.id, name: best.session.name }, ...inheritedBaseline(best.session) } };
}

/**
 * The branch holding a session's latest work, and when that work ended: in `per-session` mode its
 * one branch, in `per-task` mode the branch of the task that finished last — only tasks that
 * committed something, since a branch with nothing on it is the session's start, not its work.
 */
function lastWorkOf(session: Session): { branch: string; at: string } | null {
  let best: { branch: string; at: string } | null = null;
  for (const t of session.tasks) {
    for (const v of [...(t.attempts ?? []).map((a) => ({ vcs: a.vcs, at: a.finishedAt })), { vcs: t.vcs, at: t.finishedAt }]) {
      if (!v.vcs?.branch || !v.vcs.commit || !v.at) continue;
      if (!best || v.at > best.at) best = { branch: v.vcs.branch, at: v.at };
    }
  }
  return best;
}

/**
 * The starting snapshot a session carries on, for the one that continues it: its own when it made
 * one, else the one it inherited. Recorded so the export can say each session of a chain shares it.
 */
function inheritedBaseline(before: Session): { baseline?: SessionStart['baseline'] } {
  const own = before.vcsStart?.kind === 'snapshot' ? { commit: before.vcsStart.commit, branch: before.vcsStart.branch, fromSession: { id: before.id, name: before.name } } : undefined;
  const baseline = own ?? before.vcsStart?.baseline;
  return baseline ? { baseline } : {};
}

/** When a session last did anything: the latest start or end of any of its tasks' attempts. */
function lastActivityOf(session: Session): string | null {
  let at: string | null = null;
  for (const t of session.tasks) {
    for (const v of [t.finishedAt, t.startedAt, ...(t.attempts ?? []).flatMap((a) => [a.finishedAt, a.startedAt])]) {
      if (v && (!at || v > at)) at = v;
    }
  }
  return at;
}

async function branchTip(dir: string, branch: string): Promise<string | null> {
  if (!(await isValidBranchName(dir, branch))) return null;
  const r = await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

function normalise(dir: string): string {
  return dir.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

/** One line for the log and the event stream: where this session starts, and why. */
export function describeStart(start: SessionStart): string {
  // With input files carried in, the start is a commit on top of the branch, not its tip: said apart (live run 2026-10-03).
  const carried = start.inputs?.carried;
  const at = carried ? carried.onto.slice(0, 8) : start.commit.slice(0, 8);
  const said =
    start.kind === 'snapshot'
      ? `this session starts from a snapshot of your uncommitted changes: ${start.branch} (${at}), taken on ${start.snapshot?.fromBranch ?? 'a detached HEAD'} at ${(start.snapshot?.fromCommit ?? '').slice(0, 8)}`
      : start.kind === 'previous-session'
      ? `this session continues "${start.fromSession?.name ?? '?'}": it starts from the end of its branch ${start.branch} (${at})`
      : start.kind === 'existing-branch'
        ? `this session carries on the existing branch ${start.branch}, from its tip ${at}`
        : start.kind === 'branch'
        ? `this session starts from the local branch ${start.branch} (${at})`
        : `this session starts from where the repository was (${at})`;
  const updated = start.update ? ` (${describeUpdate(start.update as BranchUpdate)})` : '';
  const plus = carried ? `, plus the operator's input files carried from ${carried.from} as ${start.commit.slice(0, 8)} on ${carried.branch}` : '';
  return start.note ? `${said}${plus}${updated} — ${start.note}` : `${said}${plus}${updated}`;
}

/**
 * Where a session leaves the repository, when its input files exist only on the runner's branches: the
 * operator's base branch does not have them, and checking it out takes them out of the folder (live run
 * 2026-10-03: specs/ gone after `git checkout main`, an ignored local file with it). Null when there is
 * nothing to say.
 */
export async function whereLeft(session: Session): Promise<string | null> {
  const files = session.vcsStart?.inputs?.files ?? [];
  const dir = repoDirOf(session);
  if (!session.vcs?.enabled || files.length === 0 || !dir) return null;
  const base = session.vcs.baseBranch?.trim() || 'main';
  const state = await repoState(dir).catch(() => null);
  if (!state?.isRepo || !state.branch || state.branch === base) return null;
  const onBase = await git(dir, ['cat-file', '-e', `refs/heads/${base}:${files[0]!.path}`]);
  if (onBase.ok) return null;
  const paths = files.map((f) => f.path);
  const list = paths.slice(0, 5).join(', ') + (paths.length > 5 ? ` and ${paths.length - 5} more` : '');
  return (
    `the repository is left on ${state.branch}. The input files (${list}) are committed only on the runner's branches, not on ${base}: ` +
    `checking out ${base} takes them out of the folder. To have them back there: git restore --source ${state.branch} -- ${paths.slice(0, 5).join(' ')}`
  );
}

/** One line for the log: the session's input files, and whether the runner had to commit them on its start. */
export function describeInputs(start: SessionStart): string {
  const n = start.inputs?.files.length ?? 0;
  const carried = start.inputs?.carried;
  return (
    `${n} input file(s) in the session's start (${start.commit.slice(0, 8)})${start.inputs?.readOnly ? ', read-only' : ''}` +
    (carried ? `: they were not in ${carried.onto.slice(0, 8)}, so they were committed on top of it as ${carried.branch}, from ${carried.from}` : '')
  );
}

/** Whether the update before a session's start is worth a warning: it did not bring the branch up to date. */
export function updateWarns(start: SessionStart): boolean {
  return !!start.update && !['updated', 'up-to-date', 'no-remote'].includes(start.update.outcome);
}

/** Where a session's work is, for the operator: one branch, or one per task. */
export type SessionBranches = {
  mode: 'per-task' | 'per-session';
  /** The one branch that holds the whole session's work, in per-session mode. */
  complete?: string;
  branches: Array<{ title: string; branch: string; commit?: string; status: string }>;
};

/**
 * Which branch has the complete work of a session, when one does.
 *
 * Answered from the session's own record rather than from git, because the question is asked
 * after the run, from a page, and often about a repository whose HEAD is somewhere else: in
 * per-task mode HEAD is left on whichever task ran last, which for a nine-task plan was an
 * audit branch that did not carry the README written one task earlier.
 */
export function sessionBranches(session: Session): SessionBranches {
  const mode = session.vcs?.branchMode ?? 'per-task';
  const branches = session.tasks
    .filter((t) => !!t.vcs?.branch)
    .map((t) => ({ title: t.title, branch: t.vcs?.branch as string, commit: t.vcs?.commit, status: t.status }));
  if (mode === 'per-session') {
    const complete = branches[branches.length - 1]?.branch ?? namedSessionBranch(session.vcs);
    return { mode, complete, branches };
  }
  return { mode, branches };
}

/** The commit the task's first attempt started from, if it has one. */
function firstAttemptBase(task: Task): string | undefined {
  return earliestBase(task);
}

async function switchTo(
  session: Session,
  task: Task,
  dir: string,
  wantedName: string,
  from: string | undefined,
  bus: EventBus,
  /** `mustExist`: carry on this branch or nothing; never create it. */
  opts: { reuseExisting: boolean; mustExist?: boolean; start?: SessionStart; stage?: string[] },
): Promise<PrepareResult> {
  if (!(await isValidBranchName(dir, wantedName))) {
    const problem = `"${wantedName}" is not a name git accepts.`;
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-problem', level: 'warn', message: problem });
    return { vcs: { problem }, note: '' };
  }

  // Approved inputs left untracked where they are: staged first, so the switch keeps them.
  const stage = opts.stage ?? [];
  if (stage.length > 0) await git(dir, ['--literal-pathspecs', 'add', '-f', '--', ...stage]);
  const state = await repoState(dir);
  let name = wantedName;
  let result;
  /** Whether the branch was made now, or an existing one carried on: said differently, since they are different. */
  let created = false;

  if (opts.reuseExisting && state.branch === wantedName) {
    result = { ok: true, stdout: '', stderr: '', code: 0 };
  } else if (opts.reuseExisting) {
    const existing = await checkoutExisting(dir, wantedName);
    if (existing.ok || opts.mustExist) result = existing;
    else {
      result = await createBranch(dir, wantedName, from);
      created = result.ok;
    }
  } else {
    name = await freeBranchName(dir, wantedName);
    result = await createBranch(dir, name, from);
    created = result.ok;
  }

  if (!result.ok) {
    // The operator's checkout as it was: the staged inputs go back to untracked.
    if (stage.length > 0) await git(dir, ['--literal-pathspecs', 'restore', '--staged', '--', ...stage]);
    const problem = result.stderr || result.stdout || 'the branch could not be created';
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-problem', level: 'warn',
      message: `version control is on but inactive: ${problem}` });
    return { vcs: { problem }, note: '' };
  }

  const after = await repoState(dir);
  const vcs: TaskVcs = { branch: after.branch ?? name, baseCommit: after.head ?? from };

  /*
   * "(from X)" only for a branch made now: a branch carried on was not made from the session's base, and
   * saying so sent the reader to the wrong commit (live run 2026-10-03).
   */
  bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-branch', level: 'info',
    message: created
      ? `working on branch ${vcs.branch}${from ? ` (made from ${from.slice(0, 8)})` : ''}`
      : `carrying on the existing branch ${vcs.branch} at ${(vcs.baseCommit ?? '').slice(0, 8)}`,
    data: { ...vcs, repoDir: dir, created } });

  // What the task stands on, and what it does not: the base commit by name, and the other
  // tasks of this session that already ran, with the branch each of them worked on.
  const subject = vcs.baseCommit ? await commitSubject(dir, vcs.baseCommit) : '';
  // A session carrying on an existing branch has all its tasks on it, one after another.
  const mode = session.vcs?.startFrom === 'existing-branch' ? 'per-session' : (session.vcs?.branchMode ?? 'per-task');
  // On this branch (per-session: their work is here) or on others (per-task: it is not). A
  // session whose mode was switched mid-way has both, and each kind is reported by where it is.
  const earlier = session.tasks
    .filter((t) => t.id !== task.id && !!t.vcs?.branch && t.status !== 'queued')
    .filter((t) => (mode === 'per-session' ? t.vcs?.branch === vcs.branch : t.vcs?.branch !== vcs.branch))
    .map((t) => ({ title: t.title, branch: t.vcs?.branch as string }));
  const note = noteFor(dir, vcs, {
    mode,
    base: vcs.baseCommit ? { commit: vcs.baseCommit, subject } : undefined,
    earlier,
    start: opts.start,
    artifacts: artifactPatterns(session.vcs),
    commits: session.vcs?.commitOnFinish !== false,
    readOnly: !!task.readOnly,
    created,
  });
  return { vcs, note };
}

/** What a task is told about where it stands in the repository. */
export type NoteContext = {
  mode: 'per-task' | 'per-session';
  /** The commit the branch was cut from, and its subject line. */
  base?: { commit: string; subject: string };
  /** The other tasks of this session that already ran, with the branch each worked on. */
  earlier: Array<{ title: string; branch: string }>;
  /** Where the session itself started, when it was chosen rather than taken from HEAD. */
  start?: SessionStart;
  /** The session's artifact patterns: kept with the run, never committed. */
  artifacts?: string[];
  /** Whether the runner commits when the task ends (`commitOnFinish`); absent means it does. */
  commits?: boolean;
  /** A read-only task: it is not told to change files. */
  readOnly?: boolean;
  /** Whether the branch was made for this task now; false when an existing one is carried on. Absent means made. */
  created?: boolean;
};

/**
 * What level 1 tells Copilot when version control is on.
 *
 * Copilot has to know the repository is being managed, or it will helpfully create its own
 * branch, commit half-way through, or switch away in the middle of a task. It is written as a
 * plain instruction with the reason attached, because a rule without a reason is the kind a
 * model talks itself out of.
 */
export function noteFor(repoDir: string, vcs: TaskVcs, ctx: NoteContext = { mode: 'per-task', earlier: [] }): string {
  if (!vcs.branch) return '';
  const base = ctx.base
    ? `\`${ctx.base.commit.slice(0, 8)}\`${ctx.base.subject ? ` ("${ctx.base.subject}")` : ''}`
    : 'the current commit';
  const named = ctx.earlier.map((e) => `"${e.title}"`).join(', ');
  /*
   * Which earlier work is in the tree and which is not, said outright. In per-task mode every
   * branch is cut from the same commit, so an audit task that ran after a README task was
   * looking at a tree without the README — and had no way to know, because until this note
   * was written it was told only the branch's name.
   */
  const standing =
    ctx.mode === 'per-session'
      ? ctx.earlier.length > 0
        ? `This branch already carries the work of ${ctx.earlier.length} earlier task(s) of this session — ${named} — so their files are in your working tree.`
        : 'This is the first task on this branch.'
      : ctx.earlier.length > 0
        ? `Every task of this session gets its own branch from that same commit, so the work of the earlier tasks is NOT in your working tree: ` +
          `${ctx.earlier.map((e) => `"${e.title}" is on \`${e.branch}\``).join(', ')}. If this task depends on what one of them produced, say so in the summary rather than looking for files that are not here.`
        : ctx.created === false
          ? 'This branch is carried on, not new: the other tasks of this session get branches of their own from where the session started.'
          : 'Every task of this session gets its own branch from that same commit.';
  /*
   * Where the session began, said when it was chosen. A session that continues another has that
   * session's files in its tree, and a model not told so reads them as something to redo or
   * doubt; one that starts from `main` has none of them, and a model not told so goes looking.
   */
  const began =
    ctx.start?.kind === 'snapshot'
      ? `This session started from \`${ctx.start.branch}\`: a commit of the operator's own uncommitted changes, taken before the run so that your work is kept apart from theirs. Those files are in your working tree as the starting point; they are not work for you to redo or undo.`
      : ctx.start?.kind === 'previous-session'
      ? `This session continues the work of the earlier session "${ctx.start.fromSession?.name ?? ''}": it was started from the end of its branch \`${ctx.start.branch}\`, so that session's work is already in your working tree. Build on it; do not redo it.`
      : ctx.start?.kind === 'existing-branch'
        ? `This session carries on the existing branch \`${ctx.start.branch}\`: the work already on it is in your working tree. Build on it; do not redo it.`
        : ctx.start?.kind === 'branch'
        ? `This session started from the local branch \`${ctx.start.branch}\`, not from any earlier session's work${ctx.start.note ? ` (${ctx.start.note})` : ''}.`
        : '';
  return [
    '## Version control',
    '',
    ctx.created === false
      ? `The runner has already put ${repoDir} on the existing branch \`${vcs.branch}\`, carried on at ${base} with the work already on it,`
      : `The runner has already put ${repoDir} on the branch \`${vcs.branch}\`, created for this task from ${base},`,
    ctx.commits === false
      ? 'and it commits nothing when the task finishes: commits are off for this session, so your changes stay in the working tree, where the next task sees them.'
      : 'and it will commit whatever you change when the task finishes.',
    '',
    /*
     * Said outright because a plan's text may still name the branch the work came from: a task that
     * was told to continue a recovery branch went on asking for it, on a branch the runner had made
     * (2026-09-30). The branch above is where the work goes; what it must contain is a commit.
     */
    `\`${vcs.branch}\` is where this work goes, whatever branch the task or the project instructions name: do not ask for`,
    'another branch, switch to it or check that you are on it. When earlier work must be included, check its',
    'commit instead: `git merge-base --is-ancestor <commit> HEAD` exits 0 when it is.',
    '',
    ...(began ? [began, ''] : []),
    ...(inputsNote(ctx.start?.inputs) ? [inputsNote(ctx.start?.inputs), ''] : []),
    ...((ctx.artifacts?.length ?? 0) > 0
      ? [
          `Evidence goes under ${ctx.artifacts?.map((a) => `\`${a}\``).join(', ')}: those files are kept with the run's record and are never committed, ` +
            'so write reports, archives and test results there rather than changing .gitignore for them.',
          '',
        ]
      : []),
    standing,
    '',
    '- Do not create branches, switch branches, commit, stash, reset or revert. That is the',
    "  runner's job, and two of us doing it would leave the repository in a state neither of us",
    '  expects.',
    '- Do not push anything. Pushing is the operator\'s decision, made by hand, afterwards.',
    '- Read-only git is fine: `git status`, `git diff`, `git log` tell you where you are.',
    ...(ctx.readOnly
      ? ['- This task is read-only: change no file in the project (see "Read-only task").']
      : ctx.commits === false
        ? ['- Change files as the task requires. Nothing is committed for you, so think before you overwrite: the previous state is the commit above.']
        : [
            '- Change files as the task requires. You do not need to preserve the old ones by copying',
            '  them aside: the previous state is already a commit, and it can be returned to.',
          ]),
  ].join('\n');
}

/**
 * Commits what the task changed, after it has ended.
 *
 * Runs whatever the outcome was. A failed task that left changes behind is exactly the case
 * where having them on a branch, rather than loose in the tree, is worth the most.
 */
export async function commitTaskResult(
  session: Session,
  task: Task,
  outcome: { status: string; summary?: string; reason?: string; deviations?: Deviation[] },
  bus: EventBus,
): Promise<TaskVcs> {
  const settings = session.vcs;
  const current = task.vcs ?? {};
  if (!settings?.enabled || !settings.commitOnFinish || !current.branch) return current;

  const dir = repoDirOf(session);

  /*
   * Where the commit would land, checked before anything is staged.
   *
   * `commitAll` commits on whatever HEAD is. The task's branch was checked out at its start, and
   * nothing the chat runs may move it (git writes are refused), but the operator can, in another
   * window, and so can a tool a step started. Committing then puts the task's work on somebody
   * else's branch under the task's name. So: the repository must still be on the task's branch,
   * and the commit the task started from must still be in that branch's history — a branch reset
   * or rewritten under the task is not one to add to. Either failing leaves the changes in the
   * working tree, uncommitted, and says so; the next task will not start over a dirty tree, which
   * is the stop that is wanted. Commits on the branch that the runner did not make are allowed
   * (they are already there; refusing would not remove them) and named on the task.
   */
  const state = await repoState(dir);
  /*
   * The repository before the commit and after it, kept apart on the record. A task's own claims
   * ("nothing committed, the tree is dirty") were written before this runs; without both states
   * the export read as contradicting itself. See `TaskVcs.beforeCommit`.
   */
  // File by file (`git status -uall`), not the folded folders `repoState` keeps, capped at 40 (live run 2026-10-03).
  const beforeCommit = { changed: (await workingTreePaths(dir)).slice(0, 200) };
  const withStates = async (v: TaskVcs): Promise<TaskVcs> => {
    const after = await repoState(dir).catch(() => null);
    return {
      ...v,
      beforeCommit,
      ...(after ? { afterCommit: { branch: after.branch ?? undefined, head: after.head ?? undefined, clean: !after.dirty, changed: (after.dirty ? await workingTreePaths(dir) : []).slice(0, 200) } } : {}),
    };
  };
  if (state.branch !== current.branch) {
    const problem =
      `the repository is on ${state.branch ?? 'a detached HEAD'}, not on the task's branch ${current.branch}: it was moved while the task ran. ` +
      'Nothing was committed; the changes are left in the working tree for you to look at.';
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-provenance', level: 'error', message: problem,
      data: { expected: current.branch, actual: state.branch } });
    return await withStates({ ...current, problem });
  }
  if (current.baseCommit && state.head && !(await isAncestor(dir, current.baseCommit))) {
    const problem =
      `the task's branch ${current.branch} no longer contains the commit it started from (${current.baseCommit.slice(0, 8)}): ` +
      'it was reset or rewritten while the task ran. Nothing was committed; the changes are left in the working tree.';
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-provenance', level: 'error', message: problem,
      data: { base: current.baseCommit, head: state.head } });
    return await withStates({ ...current, problem });
  }
  const foreign = current.baseCommit ? await foreignCommits(dir, current.baseCommit) : [];
  if (foreign.length > 0) {
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-foreign-commits', level: 'warn',
      message: `${foreign.length} commit(s) on ${current.branch} since the task started were not made by the runner: ${foreign.slice(0, 5).join(' | ')}`,
      data: { commits: foreign } });
  }

  const message = commitMessage(task, outcome);
  const result = await commitAll(dir, message);

  if (result.problem) {
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-problem', level: 'warn',
      message: `nothing was committed: ${result.problem}` });
    return await withStates({ ...current, problem: result.problem });
  }

  if (!result.committed) {
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-nothing', level: 'info',
      message: `nothing to commit on ${current.branch}: the task changed no files` });
    return await withStates(current);
  }

  const commits = current.baseCommit ? await commitsBetween(dir, current.baseCommit) : [];
  const files = result.commit ? await commitFiles(dir, result.commit) : [];
  bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-commit', level: 'info',
    message:
      `committed on ${current.branch} as ${result.commit?.slice(0, 8)}: ` +
      `${files.length} file(s) — push it yourself when you are ready`,
    data: { branch: current.branch, commit: result.commit, files: files.length } });

  // What went in that should not have. Read from the commit itself rather than from the check
  // that pointed it out, so the record is what happened and not what was noticed.
  const suspicious = findSuspicious(files.map((f) => f.path));
  if (suspicious.length > 0) {
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-suspicious', level: 'warn',
      message:
        `${suspicious.length} committed file(s) look like tool output or secrets: ` +
        suspicious.map((s) => `${s.path} (${s.reason})`).join('; '),
      data: { commit: result.commit, suspicious } });
  }

  return await withStates({
    ...current,
    commit: result.commit,
    commits,
    files,
    ...(suspicious.length > 0 ? { suspicious } : {}),
    ...(foreign.length > 0 ? { foreignCommits: foreign } : {}),
  });
}

/**
 * Why a task's work is not committed although version control is on and commits it, or undefined
 * when it is (or there was nothing to commit). Read after `commitTaskResult`; a task that would end
 * done ends failed with this instead. See `finish` in the runner.
 */
export async function commitShortfall(session: Session, before: TaskVcs | undefined, after: TaskVcs | undefined, error?: string): Promise<string | undefined> {
  if (!session.vcs?.enabled || !session.vcs.commitOnFinish) return undefined;
  if (error) return `version control failed after the task, so its work was not committed: ${error}. The changes are left in the working tree.`;
  if (!after?.branch) {
    // Never on a branch of its own. The start refuses that now; whatever got through, it is said.
    const state = await repoState(repoDirOf(session));
    return state.isRepo && state.dirty
      ? `version control is on but was not active for this task (${after?.problem ?? before?.problem ?? 'no branch was made'}), so its changes were not committed: ${someOf(state.changed)}. They are left in the working tree.`
      : undefined;
  }
  if (after.problem) return `the runner could not commit the task's work: ${after.problem}`;
  if (after.afterCommit && !after.afterCommit.clean) {
    return `after the runner's commit the working tree still has uncommitted changes (${someOf(after.afterCommit.changed)}), so not all of the task's work is on ${after.branch}.`;
  }
  return undefined;
}

/**
 * Commits what a task left behind when the process running it ended before it could.
 *
 * `commitTaskResult` runs when a task finishes, whatever the outcome, which covers every failure
 * the runner itself decides. It does not cover the process going away mid-task — `npm start`
 * stopped with Ctrl+C, a restart, a crash, the laptop shutting down. Then nothing committed the
 * work: at the next start the task was only marked aborted, its changes stayed loose in the tree,
 * and the next attempt found a dirty repository and ran with version control switched off — so
 * the first attempt's work was neither on a branch nor carried forward, and one `git checkout .`
 * from gone. Called at startup for each task the recovery pass closes.
 *
 * Only on the task's own branch. The runner created that branch for this task and the process
 * that owned it is gone, so what is uncommitted there is the task's work; a repository that has
 * since been moved to another branch is someone's deliberate act, and is left alone with a
 * warning, as a dirty tree is left alone before a task.
 */
export async function commitInterrupted(session: Session, task: Task, reason: string, bus: EventBus): Promise<TaskVcs | undefined> {
  const settings = session.vcs;
  const branch = task.vcs?.branch;
  if (!settings?.enabled || !settings.commitOnFinish || !branch) return undefined;
  const dir = repoDirOf(session);
  const state = await repoState(dir);
  if (!state.isRepo || !state.dirty) return undefined;
  if (state.branch !== branch) {
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-problem', level: 'warn',
      message:
        `"${task.title}" was interrupted with uncommitted changes, but ${dir} is now on ${state.branch ?? 'no branch'}, ` +
        `not on the task's branch ${branch}; nothing was committed, so the changes are where they are` });
    return undefined;
  }
  return await commitTaskResult(session, task, { status: 'aborted', reason }, bus);
}

/**
 * A commit message that says what was asked and how it ended, in git's own shape.
 *
 * A task can carry its own message, which is what an imported plan sets: the model that wrote
 * the plan knew what the change was for before it was made, and that reads better in a log
 * than a title typed into a form. Its first line is the subject and the rest, if there is any,
 * becomes the first paragraph of the body. Everything the runner adds afterwards — the
 * summary, how it ended, the trailer — is added either way, because none of it can be known
 * in advance.
 */
export function commitMessage(task: Task, outcome: { status: string; summary?: string; reason?: string; deviations?: Deviation[] }): string {
  const planned = task.vcsPlan?.commitMessage?.trim();
  const [plannedSubject = '', ...plannedRest] = (planned ?? '').split('\n');
  const subject = (planned ? plannedSubject : task.title).replace(/\s+/g, ' ').trim().slice(0, 72) || 'copilot-operator task';
  const paragraphs = [
    plannedRest.join('\n').trim() || undefined,
    outcome.summary?.trim(),
    // What the model could not do as the task said. In the commit because that is where the
    // next person looks for why a file is not what the plan describes.
    outcome.deviations && outcome.deviations.length > 0
      ? `Not as the task said:\n${outcome.deviations.map((d) => `- ${d.instruction}\n  did: ${d.did}\n  because: ${d.why}`).join('\n')}`
      : undefined,
    outcome.reason
      ? `Ended ${outcome.status}: ${outcome.reason}`
      : outcome.status !== 'done'
        ? `Ended ${outcome.status}.`
        : undefined,
    [`Task: ${task.title}`, `Attempt: ${task.attempt ?? 1}`, 'Committed by copilot-operator. Not pushed.'].join('\n'),
  ].filter((p): p is string => !!p && p.trim().length > 0);

  return `${subject}\n\n${paragraphs.join('\n\n')}\n`;
}

/**
 * Going back to the code as it was before a task started.
 *
 * Additively, like everything else here: a new branch is cut at the commit the task began at
 * and checked out. Nothing is reset, nothing is deleted, no history is rewritten. The work
 * that came after stays exactly where it is, on the branch it was made on, and the message the
 * operator reads says so — because "restore" in most tools means "destroy the rest", and here
 * it does not.
 *
 * The practical effect is still what they asked for: the working tree is the code as it was
 * before that task, and they can read it, build it and run it.
 */
export type RestorePreview = {
  ok: boolean;
  problem?: string;
  repoDir: string;
  /** The commit the task started from, which is where the restore lands. */
  baseCommit?: string;
  /** The branch the repository is on right now. */
  currentBranch?: string;
  /** Commits the restored branch will not have, newest first. */
  leftBehind: string[];
  /** Where those commits stay. Nothing is lost; it is on this branch. */
  keptOn?: string;
  /** The name the new branch would get. */
  branchName?: string;
};

/** The earliest starting point recorded for this task, across all of its attempts. */
function earliestBase(task: Task): string | undefined {
  const fromAttempts = (task.attempts ?? []).map((a) => a.vcs?.baseCommit).find(Boolean);
  return fromAttempts ?? task.vcs?.baseCommit;
}

/**
 * Where going back to before this task lands: where it first started, on the line of work the
 * session carries on now.
 *
 * In per-session mode that line is the session's one branch, and "Run again from here" moves the
 * session onto a new one, the restore branch (see `OperatorService.rerunFromRestore`). The task's
 * attempts from before that move are on the branch it left, the work it abandoned. Taken from the
 * first attempt of all, a second restart, or a Restore after one, went back onto that abandoned line
 * and dropped what was done again since. So the earliest attempt on the session's branch decides,
 * live or archived; without a restart every attempt is on it and the answer is the first one's, as
 * before. A task with no attempt on that branch (it ran only before a move, or the branch was
 * renamed) falls back to its first attempt. Per-task mode cuts every attempt from where the task
 * first started, so the first attempt is the answer there.
 */
export function restorePoint(session: Session, task: Task): string | undefined {
  if (session.vcs?.branchMode === 'per-session' && session.vcs.startFrom !== 'existing-branch') {
    const branch = sessionBranchName(session);
    const onIt = [...(task.attempts ?? []).map((a) => a.vcs), task.vcs].find((v) => v?.branch === branch && !!v.baseCommit);
    if (onIt?.baseCommit) return onIt.baseCommit;
  }
  return earliestBase(task);
}

/**
 * Makes a branch at a commit without checking it out: the repository stays where it is, on the
 * branch the operator was shown. Additive like every other change here; an existing name is refused
 * by git, never moved.
 */
export async function branchAt(dir: string, name: string, commit: string): Promise<{ ok: boolean; problem?: string }> {
  if (!(await isValidBranchName(dir, name))) return { ok: false, problem: `"${name}" is not a name git accepts.` };
  const r = await git(dir, ['branch', name, commit]);
  return r.ok ? { ok: true } : { ok: false, problem: r.stderr || r.stdout || 'the branch could not be made' };
}

/** What restoring this task would do, asked before anything is done. */
export async function restorePreview(session: Session, task: Task): Promise<RestorePreview> {
  const repoDir = repoDirOf(session);
  const empty: RestorePreview = { ok: false, repoDir, leftBehind: [] };

  if (!session.vcs?.enabled) return { ...empty, problem: 'Version control is off for this session.' };

  const base = restorePoint(session, task);
  if (!base) {
    return {
      ...empty,
      problem:
        'This task never recorded where it started, so there is nothing to go back to. That happens when ' +
        'version control was off or inactive at the time it ran.',
    };
  }

  const state = await repoState(repoDir);
  if (!state.isRepo) return { ...empty, problem: state.problem ?? 'The repository could not be read.' };
  if (state.dirty) {
    return {
      ...empty,
      baseCommit: base,
      currentBranch: state.branch ?? undefined,
      problem:
        `There are uncommitted changes (${state.changed.slice(0, 3).join(', ')}${state.changed.length > 3 ? '…' : ''}). ` +
        'Switching branches now would carry them along or lose them, and neither is this tool\'s decision to make. ' +
        'Commit or stash them first.',
    };
  }

  const prefix = session.vcs.branchPrefix || 'cop/';
  /*
   * What the restore leaves behind is measured on the line of work the task is on, not on whatever is
   * checked out: measured from HEAD it listed the operator's own unrelated commits and left out the
   * task's own work (live run 2026-10-03). Only commits that descend from the starting point count.
   */
  /*
   * In per-session mode the line is the session's branch as it is now, which `restorePoint` already
   * follows: after a "Run again from here" moved the session, the task's last attempt is on the branch it
   * left, and measured there the preview named that branch as keeping the work, listed its commits and
   * left out the ones made since on the new one (live run 2026-10-04).
   */
  const candidates = [
    ...(session.vcs.branchMode === 'per-session' && session.vcs.startFrom !== 'existing-branch' ? [sessionBranchName(session)] : []),
    ...(task.vcs?.branch ? [task.vcs.branch] : []),
  ];
  let workBranch: string | undefined;
  for (const b of candidates) {
    if ((await branchExists(repoDir, b)) && (await isAncestor(repoDir, base, b))) {
      workBranch = b;
      break;
    }
  }
  const line = workBranch ?? 'HEAD';
  const descends = await isAncestor(repoDir, base, line);
  return {
    ok: true,
    repoDir,
    baseCommit: base,
    currentBranch: state.branch ?? undefined,
    leftBehind: descends ? await commitsBetween(repoDir, base, line) : [],
    keptOn: workBranch ?? state.branch ?? undefined,
    /*
     * Derived from the title, so built the way every derived name is. A title is a label for the
     * list, not a branch name anybody chose: put through `plannedBranchName`, a "/" in it ("Add
     * CI/CD pipeline") read as a namespace the plan wanted and gave "restore-Add-CI/CD-pipeline",
     * outside the session's prefix and in the title's case.
     */
    branchName: await freeBranchName(repoDir, branchNameFrom(['restore', task.title], prefix)),
  };
}

/** Does it: a new branch at that commit, checked out. Nothing else changes. */
export async function restoreToBase(
  session: Session,
  task: Task,
  bus: EventBus,
): Promise<{ ok: boolean; problem?: string; branch?: string; commit?: string; leftBehind?: string[]; keptOn?: string }> {
  const preview = await restorePreview(session, task);
  if (!preview.ok || !preview.baseCommit || !preview.branchName) {
    return { ok: false, problem: preview.problem ?? 'The restore could not be prepared.' };
  }

  const result = await createBranch(preview.repoDir, preview.branchName, preview.baseCommit);
  if (!result.ok) {
    return { ok: false, problem: result.stderr || result.stdout || 'the branch could not be created' };
  }

  bus.publish({
    sessionId: session.id,
    taskId: task.id,
    type: 'vcs-restored',
    level: 'info',
    message:
      `restored the code as it was before "${task.title}": ${preview.repoDir} is on ${preview.branchName} at ` +
      `${preview.baseCommit.slice(0, 8)}` +
      (preview.leftBehind.length > 0 ? `; ${preview.leftBehind.length} later commit(s) stay on ${preview.keptOn}` : ''),
    data: { branch: preview.branchName, commit: preview.baseCommit, leftBehind: preview.leftBehind.length },
  });

  return {
    ok: true,
    branch: preview.branchName,
    commit: preview.baseCommit,
    leftBehind: preview.leftBehind,
    keptOn: preview.keptOn,
  };
}

/** What the UI shows before a run: is version control going to work here? */
export async function vcsPreflight(
  session: Session,
  allSessions: () => Promise<Session[]> = async () => [],
): Promise<{ ok: boolean; repoDir: string; branch?: string; problem?: string; snapshot?: SnapshotPlan }> {
  const settings: VersionControl | undefined = session.vcs;
  if (!settings?.enabled) return { ok: false, repoDir: '', problem: 'off' };

  const repoDir = repoDirOf(session);
  const state = await repoState(repoDir);
  if (!state.isRepo) return { ok: false, repoDir, problem: state.problem };
  // Artifacts do not count: the run keeps them out of git before it looks (see `excludeArtifacts`).
  const artifacts = artifactPatterns(settings);
  // File by file when anything is to be told apart: plain status folds a new folder into one line.
  let changed = state.dirty && (artifacts.length > 0 || !!session.vcsStart?.inputs) ? (await workingTreePaths(repoDir)).filter((p) => !artifacts.length || !inScope(p, artifacts)) : state.changed;
  // Approved inputs left untracked as they were (a snapshot on the base branch) are not dirt either.
  if (changed.length > 0 && session.vcsStart?.inputs) {
    const split = await dirtyBesidesInputs(repoDir, session.vcsStart);
    changed = changed.filter((p) => !split.inputs.includes(p));
  }
  const dirty = changed.length > 0;
  /*
   * Before the first task, under a snapshot policy or with input files: the list to approve, file by
   * file. Input files are looked for even in a clean tree — an ignored input does not make it dirty.
   */
  const inputs = !!inputSettings(settings);
  if ((dirty || inputs) && (!session.vcsBaseCommit || inputs) && (dirtyPolicy(settings).policy !== 'reject' || inputs) && settings.startFrom !== 'existing-branch') {
    const snapshot = await planSnapshot(session, allSessions);
    if (snapshot.needed) {
      const listed = snapshot.entries.map((e) => e.path);
      return {
        ok: false,
        repoDir,
        branch: state.branch ?? undefined,
        problem: snapshot.recapture
          ? snapshot.ok
            ? `Input files changed or were added since the session started (${someOf(listed, 3)}). They are committed on its line of work ${snapshot.requireApproval ? 'once the list is approved under "Prepare version control for this run" or on the session\'s page' : 'when its next task starts'}.`
            : `Input files changed since the session started, and they cannot be taken: ${snapshot.problem}`
          : snapshot.ok
            ? `There are uncommitted changes (${someOf(listed, 3)}). They become the session's starting snapshot ${snapshot.requireApproval ? 'once the list is approved under "Prepare version control for this run" or on the session\'s page' : 'when its first task starts'}.`
            : `There are uncommitted changes, and no starting snapshot can be taken: ${snapshot.problem}`,
        snapshot,
      };
    }
  }
  if (dirty) {
    return {
      ok: false,
      repoDir,
      branch: state.branch ?? undefined,
      problem: `There are uncommitted changes (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? '…' : ''}). Commit or stash them first.`,
    };
  }
  /*
   * A session that continues the one before it: whether that one finished and its work is there, asked
   * here too, without fetching or moving anything. Found only when the first task was prepared, the
   * refusal came after `task-started` and the model picker and used up an attempt (live run 2026-10-03).
   */
  if (!session.vcsBaseCommit && settings.startFrom === 'previous-session') {
    const planned = await sessionStart(session, repoDir, state.head, allSessions, { dry: true });
    if ('problem' in planned) return { ok: false, repoDir, branch: state.branch ?? undefined, problem: planned.problem };
  }
  return { ok: true, repoDir, branch: state.branch ?? undefined };
}
