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
  const settings = session.vcs;
  if (!settings?.enabled) return { vcs: {}, note: '' };

  const dir = repoDirOf(session);
  const state = await repoState(dir);

  if (!state.isRepo) {
    const problem = state.problem ?? 'The repository could not be read.';
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-unavailable', level: 'warn',
      message: `version control is on but inactive: ${problem}` });
    return { vcs: { problem }, note: '' };
  }

  if (settings.startFrom === 'existing-branch') return await onExistingBranch(session, task, dir, state, bus, saveSession);

  // A dirty tree is the operator's own work in progress. Committing it under the bot's name
  // or moving it to another branch would both be decisions that are not ours to make.
  if (state.dirty) {
    const problem =
      `the repository has uncommitted changes (${state.changed.slice(0, 5).join(', ')}` +
      `${state.changed.length > 5 ? `, and ${state.changed.length - 5} more` : ''}). ` +
      'Commit or stash them, so the task starts from a known state.';
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-dirty', level: 'warn',
      message: `version control is on but inactive: ${problem}` });
    return { vcs: { problem }, note: '' };
  }

  // The session's base is fixed the first time it runs: every per-task branch is cut from it,
  // which is what makes the tasks independent of each other rather than of the calendar. Where
  // it is taken from is the session's `startFrom`; see `sessionStart`.
  let base = session.vcsBaseCommit;
  let start = session.vcsStart;
  if (!base) {
    const resolved = await sessionStart(session, dir, state.head, allSessions);
    if ('problem' in resolved) {
      bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-problem', level: 'warn',
        message: `version control is on but inactive: ${resolved.problem}` });
      return { vcs: { problem: resolved.problem }, note: '' };
    }
    start = resolved.start;
    base = start?.commit;
    if (start) {
      const chosen = start;
      await saveSession((s) => {
        s.vcsBaseCommit = chosen.commit;
        s.vcsStart = chosen;
      });
      bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-start', level: chosen.note || updateWarns(chosen) ? 'warn' : 'info',
        message: describeStart(chosen), data: { ...chosen } });
    }
  }

  const attempt = task.attempt ?? 1;
  const prefix = settings.branchPrefix || 'cop/';

  if (settings.branchMode === 'per-session') {
    return await switchTo(session, task, dir, sessionBranchName(session), base, bus, { reuseExisting: true, start });
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
  if (previousBranch) return await switchTo(session, task, dir, previousBranch, base, bus, { reuseExisting: true, start });
  // A re-run starts from where that task started the first time, not from where the previous
  // attempt ended. That is the whole point of recording the base commit.
  const from = firstAttemptBase(task) ?? base;
  return await switchTo(session, task, dir, wanted, from, bus, { reuseExisting: false, start });
}

/**
 * The one branch a `per-session` session works on: the name it was given, else one made from its
 * name and id. Every task of the session is put on it, and an existing branch of that name is
 * carried on, not copied — which is why "Run again from here" names the restore branch here when it
 * takes a chain back (see `OperatorService.rerunFromRestore`).
 */
export function sessionBranchName(session: Session): string {
  const prefix = session.vcs?.branchPrefix || 'cop/';
  const planned = session.vcs?.branchName?.trim();
  return planned ? plannedBranchName(planned, prefix) : branchNameFrom([session.name, session.id.slice(0, 13)], prefix);
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
        `so the work cannot be put on "${wanted}" without taking them along. Commit or stash them first. Nothing was run.`,
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
): Promise<{ start?: SessionStart } | { problem: string }> {
  const how = session.vcs?.startFrom ?? 'head';
  const baseBranch = session.vcs?.baseBranch?.trim() || 'main';
  if (how === 'head') return head ? { start: { kind: 'head', commit: head } } : {};

  const fromBranch = async (note?: string): Promise<{ start?: SessionStart } | { problem: string }> => {
    // The code as it is on the server, not as this checkout last pulled it: see `updateFromRemote`.
    const update = session.vcs?.updateFromRemote !== false && (await branchTip(dir, baseBranch)) ? await updateFromRemote(dir, baseBranch) : undefined;
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

  const here = normalise(dir);
  let best: { session: Session; branch: string; at: string } | null = null;
  for (const other of await allSessions()) {
    if (other.id === session.id || !other.vcs?.enabled || normalise(repoDirOf(other)) !== here) continue;
    const last = lastWorkOf(other);
    if (last && (!best || last.at > best.at)) best = { session: other, ...last };
  }
  if (!best) return await fromBranch(`no earlier session has committed work in this repository, so it starts from "${baseBranch}"`);
  const tip = await branchTip(dir, best.branch);
  if (!tip) {
    return await fromBranch(
      `the branch of the previous session "${best.session.name}" (${best.branch}) is no longer in the repository, so it starts from "${baseBranch}"`,
    );
  }
  return { start: { kind: 'previous-session', commit: tip, branch: best.branch, fromSession: { id: best.session.id, name: best.session.name } } };
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
  const at = start.commit.slice(0, 8);
  const said =
    start.kind === 'previous-session'
      ? `this session continues "${start.fromSession?.name ?? '?'}": it starts from the end of its branch ${start.branch} (${at})`
      : start.kind === 'existing-branch'
        ? `this session carries on the existing branch ${start.branch}, from its tip ${at}`
        : start.kind === 'branch'
        ? `this session starts from the local branch ${start.branch} (${at})`
        : `this session starts from where the repository was (${at})`;
  const updated = start.update ? ` (${describeUpdate(start.update as BranchUpdate)})` : '';
  return start.note ? `${said}${updated} — ${start.note}` : `${said}${updated}`;
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
    const planned = session.vcs?.branchName?.trim();
    const complete = branches[branches.length - 1]?.branch ?? (planned ? plannedBranchName(planned, session.vcs?.branchPrefix || 'cop/') : undefined);
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
  opts: { reuseExisting: boolean; mustExist?: boolean; start?: SessionStart },
): Promise<PrepareResult> {
  if (!(await isValidBranchName(dir, wantedName))) {
    const problem = `"${wantedName}" is not a name git accepts.`;
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-problem', level: 'warn', message: problem });
    return { vcs: { problem }, note: '' };
  }

  const state = await repoState(dir);
  let name = wantedName;
  let result;

  if (opts.reuseExisting && state.branch === wantedName) {
    result = { ok: true, stdout: '', stderr: '', code: 0 };
  } else if (opts.reuseExisting) {
    const existing = await checkoutExisting(dir, wantedName);
    result = existing.ok || opts.mustExist ? existing : await createBranch(dir, wantedName, from);
  } else {
    name = await freeBranchName(dir, wantedName);
    result = await createBranch(dir, name, from);
  }

  if (!result.ok) {
    const problem = result.stderr || result.stdout || 'the branch could not be created';
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-problem', level: 'warn',
      message: `version control is on but inactive: ${problem}` });
    return { vcs: { problem }, note: '' };
  }

  const after = await repoState(dir);
  const vcs: TaskVcs = { branch: after.branch ?? name, baseCommit: after.head ?? from };

  bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-branch', level: 'info',
    message: `working on branch ${vcs.branch}${from ? ` (from ${from.slice(0, 8)})` : ''}`, data: { ...vcs, repoDir: dir } });

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
        : 'Every task of this session gets its own branch from that same commit.';
  /*
   * Where the session began, said when it was chosen. A session that continues another has that
   * session's files in its tree, and a model not told so reads them as something to redo or
   * doubt; one that starts from `main` has none of them, and a model not told so goes looking.
   */
  const began =
    ctx.start?.kind === 'previous-session'
      ? `This session continues the work of the earlier session "${ctx.start.fromSession?.name ?? ''}": it was started from the end of its branch \`${ctx.start.branch}\`, so that session's work is already in your working tree. Build on it; do not redo it.`
      : ctx.start?.kind === 'existing-branch'
        ? `This session carries on the existing branch \`${ctx.start.branch}\`: the work already on it is in your working tree. Build on it; do not redo it.`
        : ctx.start?.kind === 'branch'
        ? `This session started from the local branch \`${ctx.start.branch}\`, not from any earlier session's work${ctx.start.note ? ` (${ctx.start.note})` : ''}.`
        : '';
  return [
    '## Version control',
    '',
    `The runner has already put ${repoDir} on the branch \`${vcs.branch}\`, created for this task from ${base},`,
    'and it will commit whatever you change when the task finishes.',
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
    standing,
    '',
    '- Do not create branches, switch branches, commit, stash, reset or revert. That is the',
    "  runner's job, and two of us doing it would leave the repository in a state neither of us",
    '  expects.',
    '- Do not push anything. Pushing is the operator\'s decision, made by hand, afterwards.',
    '- Read-only git is fine: `git status`, `git diff`, `git log` tell you where you are.',
    '- Change files as the task requires. You do not need to preserve the old ones by copying',
    '  them aside: the previous state is already a commit, and it can be returned to.',
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
  const beforeCommit = { changed: state.changed.slice(0, 200) };
  const withStates = async (v: TaskVcs): Promise<TaskVcs> => {
    const after = await repoState(dir).catch(() => null);
    return {
      ...v,
      beforeCommit,
      ...(after ? { afterCommit: { branch: after.branch ?? undefined, head: after.head ?? undefined, clean: !after.dirty, changed: after.changed.slice(0, 200) } } : {}),
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
  return {
    ok: true,
    repoDir,
    baseCommit: base,
    currentBranch: state.branch ?? undefined,
    leftBehind: await commitsBetween(repoDir, base, 'HEAD'),
    keptOn: state.branch ?? undefined,
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
export async function vcsPreflight(session: Session): Promise<{ ok: boolean; repoDir: string; branch?: string; problem?: string }> {
  const settings: VersionControl | undefined = session.vcs;
  if (!settings?.enabled) return { ok: false, repoDir: '', problem: 'off' };

  const repoDir = repoDirOf(session);
  const state = await repoState(repoDir);
  if (!state.isRepo) return { ok: false, repoDir, problem: state.problem };
  if (state.dirty) {
    return {
      ok: false,
      repoDir,
      branch: state.branch ?? undefined,
      problem: `There are uncommitted changes (${state.changed.slice(0, 3).join(', ')}${state.changed.length > 3 ? '…' : ''}). Commit or stash them first.`,
    };
  }
  return { ok: true, repoDir, branch: state.branch ?? undefined };
}
