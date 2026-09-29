/**
 * How well the bot itself is doing, added up from the task records.
 *
 * The number of commands a run executed says nothing about whether it was worth running. What
 * does: how often a task was right the first time, how often "done" turned out not to be, how often
 * a reviewer sent the work back, how often a person had to step in, and whether a task carried on
 * from where it stopped actually finished. Each figure here is a count of things the runner
 * recorded on an attempt (`Task.stats`, the review, the branch, how the attempt began), never
 * something a model said about itself, and each is given as "so many of so many" so a rate over
 * three tasks is not mistaken for one over three hundred.
 *
 * Attempts recorded before 2026-09-29 have no `stats`; the figures that need them count only the
 * attempts that have them, and say how many that is.
 */
import type { Session, Task, TaskAttempt, TaskStatus } from './model.js';

/** "So many of so many". `of` is 0 when nothing could be counted. */
export type Ratio = { n: number; of: number };

export type MetricsRow = {
  /** `all`, or the model the attempts ran on. */
  group: string;
  tasks: number;
  attempts: number;
  /** Tasks whose first attempt ended done. */
  firstPass: Ratio;
  /** Tasks whose latest attempt ended done. */
  doneInTheEnd: Ratio;
  /** Where the latest attempts ended. */
  ended: Partial<Record<TaskStatus, number>>;
  /** Attempts run again in a fresh chat by the runner after a block. */
  freshRetries: number;
  /** Attempts a person started again (re-run, new prompt, continue) plus steps a person skipped or stopped. */
  manualInterventions: number;
  /** Attempts in which "done" was answered with failing checks at least once. */
  falseCompletion: Ratio;
  /** Reviewed attempts in which a reviewer failed the work at least once. */
  reviewRejection: Ratio;
  /** Attempts in which a repeated command was refused. */
  repeatedCommands: Ratio;
  /** Attempts with a scope in which something outside it was put back. */
  scopeViolation: Ratio;
  /** Attempts stopped by a no-progress signal. */
  noProgress: Ratio;
  /** Attempts that committed a file flagged as tool output or secrets, or found foreign commits on their branch. */
  unrelatedDiff: Ratio;
  /** Attempts that carried on from where an earlier one stopped, and how many of those ended done. */
  resumed: Ratio;
  /** Attempts recorded with counts; the figures above that need them are out of this. */
  withStats: number;
};

export type Metrics = { rows: MetricsRow[]; computedAt: string };

const ENDED: TaskStatus[] = ['done', 'failed', 'blocked', 'aborted', 'limit-reached'];

/** One ended attempt, whether it is the task's latest or one on its record. */
type Attempt = Pick<TaskAttempt, 'status' | 'review' | 'stats' | 'continuing' | 'buildsOn' | 'freshRetry' | 'scope' | 'scopeReverted' | 'vcs'>;

function attemptsOf(task: Task): Attempt[] {
  const all: Attempt[] = [...(task.attempts ?? [])];
  if (ENDED.includes(task.status)) all.push(task);
  return all.filter((a) => ENDED.includes(a.status));
}

function modelOf(session: Session): string {
  return (session.modelInUse ?? '').trim() || (session.model ?? '').trim() || '(the chat default)';
}

function row(group: string, tasks: Task[]): MetricsRow {
  const r: MetricsRow = {
    group,
    tasks: 0,
    attempts: 0,
    firstPass: { n: 0, of: 0 },
    doneInTheEnd: { n: 0, of: 0 },
    ended: {},
    freshRetries: 0,
    manualInterventions: 0,
    falseCompletion: { n: 0, of: 0 },
    reviewRejection: { n: 0, of: 0 },
    repeatedCommands: { n: 0, of: 0 },
    scopeViolation: { n: 0, of: 0 },
    noProgress: { n: 0, of: 0 },
    unrelatedDiff: { n: 0, of: 0 },
    resumed: { n: 0, of: 0 },
    withStats: 0,
  };
  for (const task of tasks) {
    const list = attemptsOf(task);
    if (list.length === 0) continue;
    r.tasks += 1;
    r.attempts += list.length;
    r.firstPass.of += 1;
    if (list[0]!.status === 'done') r.firstPass.n += 1;
    const last = list[list.length - 1]!;
    r.doneInTheEnd.of += 1;
    if (last.status === 'done') r.doneInTheEnd.n += 1;
    r.ended[last.status] = (r.ended[last.status] ?? 0) + 1;

    list.forEach((a, i) => {
      if (a.freshRetry) r.freshRetries += 1;
      else if (i > 0) r.manualInterventions += 1;
      r.unrelatedDiff.of += 1;
      if ((a.vcs?.suspicious?.length ?? 0) > 0 || (a.vcs?.foreignCommits?.length ?? 0) > 0) r.unrelatedDiff.n += 1;
      if ((a.scope?.length ?? 0) > 0) {
        r.scopeViolation.of += 1;
        if ((a.scopeReverted?.length ?? 0) > 0) r.scopeViolation.n += 1;
      }
      if (a.continuing) {
        r.resumed.of += 1;
        if (a.status === 'done') r.resumed.n += 1;
      }
      if (a.review && a.review.verdict !== 'skipped') {
        r.reviewRejection.of += 1;
        if ((a.stats?.reviewRejections ?? 0) > 0 || a.review.verdict === 'fail' || (a.review.rounds ?? 0) > 1) r.reviewRejection.n += 1;
      }
      if (!a.stats) return;
      r.withStats += 1;
      r.manualInterventions += a.stats.operatorStops;
      r.falseCompletion.of += 1;
      if (a.stats.doneRejected > 0) r.falseCompletion.n += 1;
      r.repeatedCommands.of += 1;
      if (a.stats.repeatsRefused > 0) r.repeatedCommands.n += 1;
      r.noProgress.of += 1;
      if (a.stats.stoppedFor === 'no-progress') r.noProgress.n += 1;
    });
  }
  return r;
}

/** All tasks, then one row per model the sessions ran on, busiest first. */
export function computeMetrics(sessions: Session[], now = new Date()): Metrics {
  const all = sessions.flatMap((s) => s.tasks);
  const byModel = new Map<string, Task[]>();
  for (const s of sessions) byModel.set(modelOf(s), [...(byModel.get(modelOf(s)) ?? []), ...s.tasks]);
  const models = [...byModel.entries()]
    .map(([group, tasks]) => row(group, tasks))
    .filter((r) => r.tasks > 0)
    .sort((a, b) => b.tasks - a.tasks);
  return { rows: [row('all', all), ...(models.length > 1 ? models : [])], computedAt: now.toISOString() };
}
