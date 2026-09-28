/**
 * "Continue" on a task that stopped at the runner's limit carries on in the same chat, on the same
 * branch, with a fresh count — and tells the chat to start from its plan, not over.
 *
 * Asked for on 2026-09-28: a task cut off by the iteration ceiling had only "Run again", which sends
 * the assignment again as if nothing had happened. The chat then started the work over.
 *
 *   npm run check:continue
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import { composeOpening } from '../src/session/compose.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const base = {
  level1: 'LEVEL ONE CONTRACT',
  level2: 'level two',
  prompt: 'Build the calculator and its tests.',
  taskTitle: 'basic-operations',
  taskNumber: 1,
};

console.log('--- what the chat is sent ---');
{
  const same = composeOpening({ ...base, contractAlreadySent: true, continuing: { fromAttempt: 1, stoppedBecause: 'maxIterations (60) reached' } });
  const text = same.messages.join('\n');
  check('one message', same.messages.length, 1);
  check('it says to continue', /^Continue task 1: basic-operations/.test(text), true);
  check('and why it stopped', /maxIterations \(60\) reached/.test(text) && /not because anything failed/.test(text), true);
  check('and to start from the plan, not over', /Do not start over/.test(text) && /start from\s+your plan/.test(text), true);
  check('the assignment is not sent again', text.includes('Build the calculator'), false);

  const lost = composeOpening({ ...base, contractAlreadySent: false, continuing: { fromAttempt: 1 } });
  const lostText = lost.messages.join('\n');
  check('a lost chat gets the contract and the task in full', lost.messages.length === 2 && lostText.includes('LEVEL ONE CONTRACT') && lostText.includes('Build the calculator'), true);
  check('with a line saying it is a continuation', /continues an earlier attempt/.test(lostText), true);

  const plain = composeOpening({ ...base, contractAlreadySent: true });
  check('an ordinary later task is unchanged', /^New task in this same conversation/.test(plain.messages[0]!) && plain.messages[0]!.includes('Build the calculator'), true);
}

console.log('\n--- what is allowed, and what is kept ---');
const dir = await mkdtemp(join(tmpdir(), 'cop-continue-'));
try {
  const store = new SessionStore(dir, join(dir, 'level1.md'));
  await store.init();
  const s = await store.createSession('calc', { enabled: false, rootDir: '' });
  const t = await store.addTask(s.id, { title: 'basic-operations', level2: '', prompt: base.prompt });

  let refused = false;
  try {
    await store.continueTask(s.id, t.id);
  } catch {
    refused = true;
  }
  check('a task that has not stopped at the limit cannot be continued', refused, true);

  await store.updateSession(s.id, (x) => {
    const task = x.tasks.find((y) => y.id === t.id)!;
    task.status = 'limit-reached';
    task.reason = 'maxIterations (60) reached';
    task.iterations = 60;
    task.runId = `${s.id}-${t.id}`;
    task.vcs = { branch: 'cop/calc/basic-operations', baseCommit: 'abc1234' } as never;
  });
  const next = await store.continueTask(s.id, t.id);
  check('queued again', next.status, 'queued');
  check('as the next attempt', next.attempt, 2);
  check('marked as a continuation, with why it stopped', next.continuing, { fromAttempt: 1, stoppedBecause: 'maxIterations (60) reached' });
  check('with a fresh count', next.iterations, 0);
  check('the attempt that stopped is kept, with its branch', [next.attempts?.[0]?.status, next.attempts?.[0]?.iterations, (next.attempts?.[0]?.vcs as { branch?: string } | undefined)?.branch], [
    'limit-reached',
    60,
    'cop/calc/basic-operations',
  ]);

  await store.updateSession(s.id, (x) => {
    x.tasks.find((y) => y.id === t.id)!.status = 'done';
  });
  const again = await store.rerunTask(s.id, t.id);
  check('an ordinary "Run again" is not a continuation', again.continuing ?? null, null);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(wrong === 0 ? '\nall good' : `\n${wrong} wrong`);
process.exit(wrong === 0 ? 0 : 1);
