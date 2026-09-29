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

/*
 * A new prompt for a task that ended done builds on its work (asked for on 2026-09-29): the next
 * attempt is on the finished attempt's branch with its files in place, and the chat is sent the new
 * instruction with a line saying it builds on work already there — unlike a continuation, whose
 * assignment has not changed and is not sent again. Only a done task: a failed one starts over.
 */
console.log('\n--- a new prompt for a finished task builds on it ---');
{
  const { writeFile } = await import('node:fs/promises');
  const { git, commitAll } = await import('../src/vcs/git.js');
  const { prepareForTask, commitTaskResult } = await import('../src/vcs/taskVcs.js');
  const { EventBus } = await import('../src/session/events.js');

  const msg = composeOpening({ ...base, prompt: 'Now add a percentage key.', contractAlreadySent: true, buildsOn: { fromAttempt: 1 } });
  const text = msg.messages.join('\n');
  check('the new instruction is sent', text.includes('Now add a percentage key.'), true);
  check('with a line saying it builds on work already there', /done once already \(attempt 1\)/.test(text) && /build on it/.test(text), true);
  check('and not told to carry on an unchanged assignment', /Continue task 1/.test(text), false);

  const repo = await mkdtemp(join(tmpdir(), 'cop-buildson-repo-'));
  const data = await mkdtemp(join(tmpdir(), 'cop-buildson-data-'));
  process.env.COP_DATA_DIR = data;
  try {
    await git(repo, ['init', '-b', 'main']);
    await writeFile(join(repo, 'app.ts'), 'export const a = 1;\n');
    await commitAll(repo, 'first');
    const { OperatorService } = await import('../src/api/operator.service.js');
    const ops = new OperatorService();
    await ops.store.init();
    const s = await ops.store.createSession('calc', { enabled: false, rootDir: '' });
    await ops.store.updateSession(s.id, (x) => {
      x.vcs = { enabled: true, repoDir: repo, branchMode: 'per-task', commitOnFinish: true, branchPrefix: 'cop/' };
    });
    const t = await ops.store.addTask(s.id, { title: 'calculator', level2: '', prompt: 'Build the calculator.' });
    const bus = new EventBus();
    const save = async (m: (x: never) => void): Promise<void> => void (await ops.store.updateSession(s.id, m as never));

    // The first attempt: its branch, its file, committed, done.
    let session = (await ops.store.getSession(s.id))!;
    const first = await prepareForTask(session, session.tasks[0]!, bus, save);
    await writeFile(join(repo, 'calculator.ts'), 'export const add = (a: number, b: number) => a + b;\n');
    await ops.store.updateTask(s.id, t.id, (x) => {
      x.vcs = first.vcs;
    });
    session = (await ops.store.getSession(s.id))!;
    const committed = await commitTaskResult(session, session.tasks[0]!, { status: 'done', summary: 'built' }, bus);
    await ops.store.updateTask(s.id, t.id, (x) => {
      x.vcs = committed;
      x.status = 'done';
    });

    const requeued = await ops.rerunTask(s.id, t.id, { prompt: 'Now add a percentage key.' }, { buildOnFinished: true });
    check('a done task is marked to build on its attempt', requeued.buildsOn, { fromAttempt: 1 });
    session = (await ops.store.getSession(s.id))!;
    const second = await prepareForTask(session, session.tasks[0]!, bus, save);
    check('the new attempt is on the finished attempt\'s branch', second.vcs.branch, first.vcs.branch);
    const files = (await git(repo, ['ls-tree', '--name-only', 'HEAD'])).stdout.split('\n');
    check('with its work in the tree', files.includes('calculator.ts'), true);

    // A failed task given a new prompt starts over, whatever the button asked.
    await ops.store.updateTask(s.id, t.id, (x) => {
      x.status = 'failed';
    });
    const failedAgain = await ops.rerunTask(s.id, t.id, { prompt: 'Try it differently.' }, { buildOnFinished: true });
    check('a failed task is not built on', failedAgain.buildsOn ?? null, null);
    await ops.store.updateTask(s.id, t.id, (x) => {
      x.status = 'done';
    });
    const plainAgain = await ops.rerunTask(s.id, t.id);
    check('an ordinary "Run again" does not build on it', plainAgain.buildsOn ?? null, null);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
}

console.log(wrong === 0 ? '\nall good' : `\n${wrong} wrong`);
process.exit(wrong === 0 ? 0 : 1);
