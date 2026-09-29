/**
 * The register's figures (src/session/metrics.ts), added up from task records made by hand.
 *
 *   npm run check:metrics
 */
import { computeMetrics } from '../src/session/metrics.js';
import type { Session, Task, TaskStats } from '../src/session/model.js';
import { Tally } from './support/harness.js';

const t = new Tally();
const stats = (s: Partial<TaskStats> = {}): TaskStats => ({ formatErrors: 0, doneRejected: 0, repeatsRefused: 0, stepsRefused: 0, operatorStops: 0, reviewRejections: 0, scopeReverts: 0, ...s });
const task = (id: string, t: Partial<Task>): Task => ({ id, title: id, level2: '', prompt: 'p', status: 'queued', createdAt: '2026-09-29T10:00:00Z', iterations: 0, ...t }) as Task;
const session = (id: string, modelInUse: string, tasks: Task[]): Session => ({ id, name: id, modelInUse, tasks }) as unknown as Session;

const sessions = [
  session('s1', 'GPT 5.6 Think deeper', [
    // Right first time.
    task('a', { status: 'done', stats: stats(), review: { verdict: 'pass', rounds: 1, stepsRun: 2 } }),
    // "Done" turned down by the checks, then fixed within the same attempt.
    task('b', { status: 'done', stats: stats({ doneRejected: 1, repeatsRefused: 2 }) }),
    // Stopped at the limit, continued by a person, finished.
    task('c', {
      status: 'done',
      attempt: 2,
      stats: stats(),
      continuing: { fromAttempt: 1, how: 'limit' },
      attempts: [{ status: 'limit-reached', iterations: 60, title: 'c', prompt: 'p', level2: '', stats: stats() }],
    }),
    // Blocked, run again by the runner in a fresh chat, still blocked; stopped for no progress.
    task('d', {
      status: 'blocked',
      attempt: 2,
      freshRetry: true,
      stats: stats({ stoppedFor: 'no-progress' }),
      attempts: [{ status: 'blocked', iterations: 4, title: 'd', prompt: 'p', level2: '', stats: stats() }],
    }),
    // Still queued: not counted.
    task('e', { status: 'queued' }),
  ]),
  session('s2', 'Auto', [
    // An old task with no counts, sent back by a reviewer once, with a scope it broke.
    task('f', { status: 'failed', review: { verdict: 'fail', rounds: 2, stepsRun: 5 }, scope: ['src/'], scopeReverted: ['README.md'] }),
    // A step a person skipped, and a commit on its branch the runner did not make.
    task('g', { status: 'done', stats: stats({ operatorStops: 1 }), vcs: { branch: 'cop/g', foreignCommits: ['abc x@y z'] } }),
  ]),
];

const m = computeMetrics(sessions, new Date('2026-09-29T12:00:00Z'));
const all = m.rows[0]!;
t.check('one row for all, one per model, busiest first', m.rows.map((r) => r.group), ['all', 'GPT 5.6 Think deeper', 'Auto']);
t.check('tasks that ran, and their attempts', [all.tasks, all.attempts], [6, 8]);
t.check('done at the first attempt', all.firstPass, { n: 3, of: 6 });
t.check('done in the end', all.doneInTheEnd, { n: 4, of: 6 });
t.check('where the latest attempts ended', all.ended, { done: 4, blocked: 1, failed: 1 });
t.check('"done" turned down, out of the attempts with counts', all.falseCompletion, { n: 1, of: 7 });
t.check('attempts with counts', all.withStats, 7);
t.check('review rejections, out of reviewed attempts', all.reviewRejection, { n: 1, of: 2 });
t.check('repeated commands', all.repeatedCommands, { n: 1, of: 7 });
t.check('stopped for no progress', all.noProgress, { n: 1, of: 7 });
t.check('scope violations, out of attempts with a scope', all.scopeViolation, { n: 1, of: 1 });
t.check('suspicious or foreign commits', all.unrelatedDiff, { n: 1, of: 8 });
t.check('carried on and finished', all.resumed, { n: 1, of: 1 });
t.check('fresh-chat retries by the runner', all.freshRetries, 1);
t.check('a person stepped in: one continue, one skipped step', all.manualInterventions, 2);
t.check('the per-model row counts only its own tasks', [m.rows[1]!.tasks, m.rows[1]!.firstPass], [4, { n: 2, of: 4 }]);
t.check('one model only: no per-model rows', computeMetrics([sessions[0]!]).rows.map((r) => r.group), ['all']);
t.check('nothing ran: zeros, not a division by zero', computeMetrics([]).rows[0]!.firstPass, { n: 0, of: 0 });

t.finish();
