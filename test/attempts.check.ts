/**
 * What belongs to one attempt stays with that attempt.
 *
 * Reported 2026-10-02: a task that the runner retried twice in a fresh chat showed "still blocked
 * after 2 fresh chat(s)" in the register, then 4 after the next Run again, then 6 — while each run
 * had retried twice. The count was a field on the task that the runner added to and `rerunTask` never
 * cleared; the processes an attempt left running piled up the same way. The class is a field that
 * belongs to one attempt but is not archived or cleared when the next begins, so two things are held
 * here:
 *
 *   - `rerunTask` against `TASK_FIELD_ON_RERUN`, field by field: archived fields move onto the
 *     attempt's record and leave the task, cleared ones leave it, kept ones stay. The table is a
 *     record over every key of `Task`, so a new field without a decision does not compile.
 *   - the register's fresh-chat count end to end, with the real runner and the scripted chat: 2 after
 *     every run that retried twice, through Run again and Continue, and nothing after a run that did
 *     not retry.
 *
 *   npm run check:attempts
 */
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionStore, TASK_FIELD_ON_RERUN } from '../src/session/store.js';
import { freshRetriesOfLatestRun, type Task, type TaskAttempt } from '../src/session/model.js';
import { taskAtAttempt } from '../src/session/exports.js';
import { startHarness, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

console.log('--- rerunTask, field by field ---');
{
  const data = await mkdtemp(join(tmpdir(), 'cop-attempts-data-'));
  const store = new SessionStore(data, join(process.cwd(), 'prompts', 'level1.md'));
  await store.init();
  const s = await store.createSession('fields');
  const added = await store.addTask(s.id, { title: 'one', level2: '', prompt: 'p' });

  // A value no field would have by accident, one per field; the bookkeeping fields keep real values.
  const special = new Set(['id', 'attempts', 'status', 'attempt', 'iterations', 'continuing', 'buildsOn']);
  const sentinel = (key: string): unknown => ({ sentinel: key });
  await store.updateTask(s.id, added.id, (task) => {
    const rec = task as unknown as Record<string, unknown>;
    for (const key of Object.keys(TASK_FIELD_ON_RERUN)) if (!special.has(key)) rec[key] = sentinel(key);
    task.status = 'blocked';
    task.attempt = 3;
    task.iterations = 7;
  });
  const after = await store.rerunTask(s.id, added.id, {});
  const live = after as unknown as Record<string, unknown>;
  const archived = after.attempts?.at(-1) as unknown as Record<string, unknown>;

  const wrongArchived: string[] = [];
  const wrongCleared: string[] = [];
  const wrongKept: string[] = [];
  for (const [key, what] of Object.entries(TASK_FIELD_ON_RERUN)) {
    if (special.has(key)) continue;
    const same = (v: unknown): boolean => JSON.stringify(v) === JSON.stringify(sentinel(key));
    if (what === 'archived' && (live[key] !== undefined || !same(archived?.[key]))) wrongArchived.push(key);
    if (what === 'cleared' && live[key] !== undefined) wrongCleared.push(key);
    if (what === 'kept' && !same(live[key])) wrongKept.push(key);
  }
  t.check('every archived field is on the attempt record and gone from the task', wrongArchived, []);
  t.check('every cleared field is gone from the task', wrongCleared, []);
  t.check('every kept field is still on the task', wrongKept, []);
  t.check('the new attempt starts queued, at zero, numbered on', [after.status, after.iterations, after.attempt], ['queued', 0, 4]);
  t.check('the attempt record keeps how the last one ended', [archived?.status, archived?.iterations], ['blocked', 7]);
  /*
   * An earlier attempt read back for the exports: by the same table. Found in review: it was mapped
   * field by field, and an earlier attempt came back with the latest one's handoff, counts, limit and
   * fresh-chat mark.
   */
  await store.updateTask(s.id, added.id, (task) => {
    const rec = task as unknown as Record<string, unknown>;
    for (const [key, what] of Object.entries(TASK_FIELD_ON_RERUN)) if (!special.has(key) && what !== 'kept') rec[key] = { latest: key };
  });
  const latest = (await store.getSession(s.id))!.tasks.find((x) => x.id === added.id)!;
  const earlier = taskAtAttempt(latest, latest.attempts?.length ?? 1) as unknown as Record<string, unknown>;
  const notAsItWas: string[] = [];
  for (const [key, what] of Object.entries(TASK_FIELD_ON_RERUN)) {
    if (special.has(key)) continue;
    if (what === 'archived' && JSON.stringify(earlier?.[key]) !== JSON.stringify(sentinel(key))) notAsItWas.push(key);
    if (what === 'cleared' && earlier?.[key] !== undefined && key !== 'logFile') notAsItWas.push(key);
  }
  t.check('an earlier attempt is read back with its own fields, none of the latest one\'s', notAsItWas, []);
  // The archived keys the table names must exist on TaskAttempt; a compile-time pin for the record.
  const onAttempt: Array<keyof TaskAttempt> = ['leftovers', 'environment', 'stats', 'freshRetry', 'scopeReverted', 'inputsRestored', 'artifactsKept', 'vcs'];
  t.truthy('the attempt record has the fields archived onto it', onAttempt.every((k) => k in (archived ?? {})), Object.keys(archived ?? {}));
}

console.log('\n--- the fresh-chat count, from the marks ---');
{
  const a = (freshRetry?: boolean): TaskAttempt => ({ status: 'blocked', iterations: 1, title: 't', prompt: 'p', level2: '', ...(freshRetry ? { freshRetry } : {}) });
  const task = (attempts: TaskAttempt[], freshRetry?: boolean): Pick<Task, 'attempts' | 'freshRetry'> => ({ attempts, freshRetry });
  t.check('started by the operator: none', freshRetriesOfLatestRun(task([], undefined)), 0);
  t.check('first retry of this run: 1', freshRetriesOfLatestRun(task([a()], true)), 1);
  t.check('second retry: 2', freshRetriesOfLatestRun(task([a(), a(true)], true)), 2);
  t.check('a later run with two retries is 2, not 4', freshRetriesOfLatestRun(task([a(), a(true), a(true), a(), a(true)], true)), 2);
  t.check('a later run without retries is 0, whatever came before', freshRetriesOfLatestRun(task([a(), a(true), a(true)], undefined)), 0);
}

type Reg = { taskId: string; status: string; autoRetries?: number };

async function register(h: Harness, taskId: string): Promise<Reg | undefined> {
  return (await h.call<Reg[]>('GET', '/tasks')).find((r) => r.taskId === taskId);
}

console.log('\n--- the register, run after run ---');
const h = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 2, maxIterations: 3 } } });
try {
  const [s] = await h.importPlan({
    version: 1,
    sessions: [{
      name: 'stuck',
      onFailure: 'stop',
      vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'stuck' },
      review: { enabled: false },
      tasks: [{
        title: 'stuck-task',
        prompt: 'Create done.txt in the repository root holding exactly the text ok, and nothing else.',
        checks: [{ name: 'done.txt written', expect: 'file-contains', file: 'done.txt', value: 'ok' }],
      }],
    }],
  });
  const sid = s!.id;
  const tid = (await h.session(sid)).tasks[0]!.id;

  h.chat.script(...reply.triedThenBlocked(), ...reply.triedThenBlocked(), ...reply.triedThenBlocked());
  await h.run(sid);
  t.check('run 1: blocked, retried twice in a fresh chat: 2', [(await register(h, tid))?.status, (await register(h, tid))?.autoRetries], ['blocked', 2]);

  await h.call('POST', `/sessions/${sid}/tasks/${tid}/rerun`, {});
  t.check('Run again: the queued task carries no count from the run before', (await register(h, tid))?.autoRetries, undefined);
  h.chat.script(...reply.triedThenBlocked(), ...reply.triedThenBlocked(), ...reply.triedThenBlocked());
  await h.run(sid);
  t.check('run 2: retried twice again: still 2, not 4', (await register(h, tid))?.autoRetries, 2);

  await h.call('POST', `/sessions/${sid}/tasks/${tid}/rerun`, {});
  for (let i = 1; i <= 4; i += 1) h.chat.script(reply.steps(`Write-Output 'round ${i}'`));
  await h.run(sid);
  t.check('run 3: stopped at the message limit, no retry: no count', [(await register(h, tid))?.status, (await register(h, tid))?.autoRetries], ['limit-reached', undefined]);

  await h.call('POST', `/sessions/${sid}/tasks/${tid}/continue`);
  h.chat.script(...reply.triedThenBlocked(), ...reply.triedThenBlocked(), ...reply.triedThenBlocked());
  await h.run(sid);
  t.check('run 4, Continue: blocked, retried twice: 2, not 6', (await register(h, tid))?.autoRetries, 2);

  await h.call('POST', `/sessions/${sid}/tasks/${tid}/rerun`, {});
  h.chat.script(reply.steps("Set-Content -Path done.txt -Value 'ok' -Encoding utf8"), reply.done());
  await h.run(sid);
  t.check('run 5: done at once: no "then done in a fresh chat" badge', [(await register(h, tid))?.status, (await register(h, tid))?.autoRetries], ['done', undefined]);

  /*
   * Found in review: a fresh retry queued by the runner that never ran — the new chat would not
   * open, the program was closed — left its mark on the queued task, and the operator's next run
   * counted it as one of its own: 1 + 2 = 3.
   */
  await h.call('POST', `/sessions/${sid}/tasks/${tid}/rerun`, {});
  const disk = new SessionStore(h.dataDir, join(process.cwd(), 'prompts', 'level1.md'));
  await disk.updateTask(sid, tid, (x) => void (x.freshRetry = true));
  h.chat.script(...reply.triedThenBlocked(), ...reply.triedThenBlocked(), ...reply.triedThenBlocked());
  await h.run(sid);
  t.check('run 6: a mark left on the queued task is not counted: 2, not 3', (await register(h, tid))?.autoRetries, 2);
  t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h.stop();
}

t.finish();
