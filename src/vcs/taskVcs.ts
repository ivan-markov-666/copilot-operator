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
import type { Session, Task, TaskVcs, VersionControl } from '../session/model.js';
import type { Deviation } from '../protocol/replySchema.js';
import { findSuspicious } from './commitHygiene.js';
import { branchNameFrom, commitAll, commitFiles, commitsBetween, commitSubject, createBranch, checkoutExisting, freeBranchName, isValidBranchName, plannedBranchName, repoState } from './git.js';

/** Which repository a session works in: its own setting, else the project it mirrors. */
export function repoDirOf(session: Session): string {
  return (session.vcs?.repoDir?.trim() || session.mirror.rootDir?.trim() || '').trim();
}

export type PrepareResult = {
  vcs: TaskVcs;
  /** What level 1 should tell Copilot about the repository, or empty when there is nothing. */
  note: string;
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
  // which is what makes the tasks independent of each other rather than of the calendar.
  let base = session.vcsBaseCommit;
  if (!base && state.head) {
    base = state.head;
    await saveSession((s) => {
      s.vcsBaseCommit = base;
    });
  }

  const attempt = task.attempt ?? 1;
  const prefix = settings.branchPrefix || 'cop/';

  if (settings.branchMode === 'per-session') {
    const planned = settings.branchName?.trim();
    const wanted = planned
      ? plannedBranchName(planned, prefix)
      : branchNameFrom([session.name, session.id.slice(0, 13)], prefix);
    return await switchTo(session, task, dir, wanted, base, bus, { reuseExisting: true });
  }

  // A name the task carries wins over one derived from its title: whoever wrote the plan knew
  // what the task was for, and a title is only ever a label for the list.
  const plannedBranch = task.vcsPlan?.branch?.trim();
  const wanted = plannedBranch
    ? plannedBranchName(plannedBranch, prefix, attempt)
    : branchNameFrom([session.name, task.title, attempt > 1 ? `a${attempt}` : undefined], prefix);
  // A re-run starts from where that task started the first time, not from where the previous
  // attempt ended. That is the whole point of recording the base commit.
  const from = firstAttemptBase(task) ?? base;
  return await switchTo(session, task, dir, wanted, from, bus, { reuseExisting: false });
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
  opts: { reuseExisting: boolean },
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
    result = existing.ok ? existing : await createBranch(dir, wantedName, from);
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
  const mode = session.vcs?.branchMode ?? 'per-task';
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
  return [
    '## Version control',
    '',
    `The runner has already put ${repoDir} on the branch \`${vcs.branch}\`, created for this task from ${base},`,
    'and it will commit whatever you change when the task finishes.',
    '',
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
  const message = commitMessage(task, outcome);
  const result = await commitAll(dir, message);

  if (result.problem) {
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-problem', level: 'warn',
      message: `nothing was committed: ${result.problem}` });
    return { ...current, problem: result.problem };
  }

  if (!result.committed) {
    bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-nothing', level: 'info',
      message: `nothing to commit on ${current.branch}: the task changed no files` });
    return current;
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

  return { ...current, commit: result.commit, commits, files, ...(suspicious.length > 0 ? { suspicious } : {}) };
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

/** What restoring this task would do, asked before anything is done. */
export async function restorePreview(session: Session, task: Task): Promise<RestorePreview> {
  const repoDir = repoDirOf(session);
  const empty: RestorePreview = { ok: false, repoDir, leftBehind: [] };

  if (!session.vcs?.enabled) return { ...empty, problem: 'Version control is off for this session.' };

  const base = earliestBase(task);
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
    branchName: await freeBranchName(repoDir, plannedBranchName(`restore-${task.title}`, prefix)),
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
