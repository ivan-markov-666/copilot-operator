/**
 * How long a task and a run took, from the timestamps the record already has.
 *
 *   npm run check:clock
 */
import { elapsedMs, isLive, runSpanMs, latestRun } from '../web/lib/clock.js';

const t0 = Date.parse('2026-09-20T09:00:00.000Z');
const at = (s: number): string => new Date(t0 + s * 1000).toISOString();

console.log('--- one task ---');
console.log('finished                 :', elapsedMs(at(0), at(272)), '(expect 272000)');
console.log('still running, now=+61   :', elapsedMs(at(0), undefined, t0 + 61_000), '(expect 61000)');
console.log('not started              :', elapsedMs(undefined), '(expect undefined)');
console.log('never negative           :', elapsedMs(at(10), at(0)), '(expect 0)');
console.log('live: running            :', isLive({ startedAt: at(0), status: 'running' }), '(expect true)');
console.log('live: finished           :', isLive({ startedAt: at(0), finishedAt: at(5), status: 'done' }), '(expect false)');
console.log('live: queued             :', isLive({ status: 'queued' }), '(expect false)');

console.log('\n--- one run ---');
const run = { id: 'r-1', startedAt: at(0), sessions: 3 };
const done = [
  { startedAt: at(1), finishedAt: at(300), status: 'done', runGroup: run },
  { startedAt: at(301), finishedAt: at(900), status: 'done', runGroup: run },
  { startedAt: at(901), finishedAt: at(1500), status: 'failed', runGroup: run },
];
const finished = runSpanMs(run, done, t0 + 99_999_000);
console.log('finished run             :', finished.ms, finished.live, finished.tasks, '(expect 1500000 false 3)');
const inFlight = [done[0], done[1], { startedAt: at(901), status: 'running', runGroup: run }];
const going = runSpanMs(run, inFlight, t0 + 1000_000);
console.log('run still going, now=+1000:', going.ms, going.live, '(expect 1000000 true)');
const notYet = runSpanMs(run, [done[0], { status: 'queued', runGroup: run }], t0 + 400_000);
console.log('a task not yet started   :', notYet.live, '(expect false — queued is not live; the span ends at the last finish)', notYet.ms, '(expect 300000)');

console.log('\n--- the latest run of a session ---');
const older = { id: 'r-0', startedAt: at(-5000), sessions: 1 };
const tasks = [
  { startedAt: at(-4999), finishedAt: at(-4000), status: 'done', runGroup: older },
  ...done,
  { status: 'queued' },
];
const latest = latestRun(tasks);
console.log('picks the newest         :', latest?.run.id, '| tasks in it:', latest?.tasks.length, '(expect r-1 | 3)');
console.log('none without a run       :', latestRun([{ status: 'queued' }]), '(expect null)');
