/**
 * The end of a task in one fixed shape, put together by the runner from what it recorded.
 *
 * The chat's summary is the model's account, in its words and in whatever order it chose. The
 * operator reading a finished run needs the same eight answers every time — what came of it, which
 * files, what was checked, what is still wrong, where the evidence is, where the code is, what is
 * left for a person to do, and what was never run — and until now had to piece them together from
 * the summary, the check list, the review panel, the branch line and the iteration reports. This
 * reads them off the task record instead, so every entry is a fact the runner saw rather than a
 * claim, and nothing here is written by the model.
 */
import { isContinuable, type Task, type TaskStatus } from './model.js';

export type Handoff = {
  outcome: { status: TaskStatus; reason?: string; stopCode?: string };
  changedFiles: Array<{ path: string; added: number; removed: number }>;
  validation: Array<{ name: string; passed: boolean }>;
  review?: { verdict: string; open: number; skippedBecause?: string };
  /**
   * The repository in the order things happened, each state on its own: the tree before the runner's
   * commit, the checks, the commit, the repository after it. Mixed into one, "the tree is dirty" (true
   * before) and a commit (made after) read as a contradiction. Absent without version control.
   */
  lifecycle?: {
    preCommitState?: { changed: string[] };
    checksResult: Array<{ name: string; passed: boolean }>;
    commitResult: { branch?: string; commit?: string; files: number; problem?: string };
    postCommitState?: { branch?: string; head?: string; clean: boolean; uncommitted: string[] };
  };
  /** What is known to be wrong or doubtful at the end, one line each. */
  knownIssues: string[];
  evidence: { runId?: string; checks: number; reviewRounds: number };
  vcs: { branch?: string; commit?: string; pushed: false; problem?: string };
  /** What a person still has to do. */
  manual: string[];
  /** Steps the chat sent that were not run, and why. */
  notExecuted: string[];
};

/** A step that was not run, as the runner recorded it on the task. */
export type NotRun = { command: string; why: string };

export function composeHandoff(task: Task, notRun: NotRun[] = []): Handoff {
  const failedChecks = (task.checkResults ?? []).filter((c) => !c.passed);
  const openFindings = task.review?.verdict === 'fail' ? (task.review.findings ?? []).filter((f) => f.about !== 'task') : [];
  const vcs = task.vcs ?? {};
  const knownIssues = [
    ...failedChecks.map((c) => `check failed: ${c.name} — ${c.detail}`),
    ...openFindings.map((f) => `review finding${f.id ? ` ${f.id}` : ''}: ${f.what}${f.where ? ` (${f.where})` : ''}`),
    ...(task.checkResults ?? [])
      .filter((c) => c.passed && /still there after being pointed out once/.test(c.detail))
      .map((c) => `committed with a finding left in place: ${c.name}`),
    ...(vcs.suspicious ?? []).map((s) => `committed although it looks like ${s.reason}: ${s.path}`),
    ...(vcs.foreignCommits ?? []).map((c) => `a commit on the branch the runner did not make: ${c}`),
    ...(task.scopeReverted?.length ? [`put back because ${task.readOnly ? 'the task is read-only' : "outside the task's scope"}: ${task.scopeReverted.join(', ')}`] : []),
    ...(task.deviations ?? []).map((d) => `did not follow "${d.instruction}" as written: ${d.did}`),
  ];

  const manual: string[] = [];
  if (vcs.problem) manual.push(`version control: ${vcs.problem}`);
  if (vcs.commit && vcs.branch) manual.push(`push ${vcs.branch} when you are ready — the runner never pushes`);
  if (isContinuable(task)) manual.push('continue it in the same chat from the register, or run it again');
  if (task.status === 'blocked') manual.push(`unblock it: ${task.reason ?? 'see the reason'}`);
  // A refusal of version control's own is fixed there, not in the prompt (live run 2026-10-03).
  if (task.status === 'failed' && !vcs.problem) manual.push('read why it failed, fix the prompt or the checks, and queue it again');
  if (openFindings.length > 0) manual.push(`${openFindings.length} review finding(s) are open`);
  if ((vcs.suspicious?.length ?? 0) > 0 || (vcs.foreignCommits?.length ?? 0) > 0) manual.push('look at the committed files and commits listed above');

  return {
    outcome: { status: task.status, ...(task.reason ? { reason: task.reason } : {}), ...(task.stopCode ? { stopCode: task.stopCode } : {}) },
    changedFiles: (vcs.files ?? []).map((f) => ({ path: f.path, added: f.added, removed: f.removed })),
    validation: (task.checkResults ?? []).map((c) => ({ name: c.name, passed: c.passed })),
    ...(task.review
      ? { review: { verdict: task.review.verdict, open: openFindings.length, ...(task.review.skippedBecause ? { skippedBecause: task.review.skippedBecause } : {}) } }
      : {}),
    ...(vcs.branch || vcs.problem
      ? {
          lifecycle: {
            ...(vcs.beforeCommit ? { preCommitState: { changed: vcs.beforeCommit.changed } } : {}),
            checksResult: (task.checkResults ?? []).map((c) => ({ name: c.name, passed: c.passed })),
            commitResult: {
              ...(vcs.branch ? { branch: vcs.branch } : {}),
              ...(vcs.commit ? { commit: vcs.commit } : {}),
              files: vcs.files?.length ?? 0,
              ...(vcs.problem ? { problem: vcs.problem } : {}),
            },
            ...(vcs.afterCommit
              ? {
                  postCommitState: {
                    ...(vcs.afterCommit.branch ? { branch: vcs.afterCommit.branch } : {}),
                    ...(vcs.afterCommit.head ? { head: vcs.afterCommit.head } : {}),
                    clean: vcs.afterCommit.clean,
                    uncommitted: vcs.afterCommit.changed,
                  },
                }
              : {}),
          },
        }
      : {}),
    knownIssues,
    evidence: { ...(task.runId ? { runId: task.runId } : {}), checks: task.checkResults?.length ?? 0, reviewRounds: task.review?.rounds ?? 0 },
    vcs: { ...(vcs.branch ? { branch: vcs.branch } : {}), ...(vcs.commit ? { commit: vcs.commit } : {}), pushed: false, ...(vcs.problem ? { problem: vcs.problem } : {}) },
    manual,
    notExecuted: notRun.slice(0, 30).map((n) => `${n.command} — ${n.why}`),
  };
}
