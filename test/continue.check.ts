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
  check('a task that has not stopped cannot be continued', refused, true);

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
  check('marked as a continuation, with why it stopped', next.continuing, { fromAttempt: 1, stoppedBecause: 'maxIterations (60) reached', how: 'limit' });
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

/*
 * The bot stopped under a task — the power went, Ctrl+C, a crash (asked for on 2026-09-29). At the
 * next start the task is closed as aborted, its work committed, and where it had got to is read
 * from its run folder; "Continue" then carries it on in its chat, and the chat is told which of the
 * steps it had just asked for ran, which was cut off, and which never ran.
 */
console.log('\n--- after the bot stopped under a task ---');
{
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { readInterruption, describeInterruption } = await import('../src/session/interruption.js');
  const runs = await mkdtemp(join(tmpdir(), 'cop-interrupt-runs-'));
  const data = await mkdtemp(join(tmpdir(), 'cop-interrupt-data-'));
  const runId = 'run-interrupted';
  const runDir = join(runs, runId);
  await mkdir(join(runDir, 'steps'), { recursive: true });
  const line = (e: Record<string, unknown>): string => JSON.stringify({ at: '2026-09-29T10:00:00.000Z', ...e });
  await writeFile(
    join(runDir, 'transcript.jsonl'),
    [
      line({ type: 'reply-parsed', iteration: 2, status: 'continue', steps: 1 }),
      line({ type: 'step-finished', id: 1, outcome: 'completed', exitCode: 0 }),
      line({ type: 'report-written', iteration: 2 }),
      line({ type: 'message-sent', index: 2 }),
      line({ type: 'reply-parsed', iteration: 3, status: 'continue', steps: 3 }),
      line({ type: 'step-proposed', id: 1, description: '[pwsh] npm run build' }),
      line({ type: 'step-started', id: 1 }),
      line({ type: 'step-finished', id: 1, outcome: 'completed', exitCode: 0 }),
      line({ type: 'step-proposed', id: 2, description: '[pwsh] npm test' }),
      line({ type: 'step-started', id: 2 }),
      '{"at":"2026-09-29T10:00:05.000Z","type":"step-heart', // the line the power cut in half
    ].join('\n'),
  );
  await writeFile(join(runDir, 'steps', '3-1.log'), '# step 1\n# npm run build\nbuilt in 2.1s\n# outcome=completed exit=0 durationMs=2100\n');
  await writeFile(join(runDir, 'steps', '3-2.log'), '# step 2\n# npm test\n  ✓ adds\n  ✓ subtracts\n');

  const where = await readInterruption(runDir);
  check('it reads the last reply', [where?.iteration, where?.replyStatus], [3, 'continue']);
  check('which steps ran, which was cut, which did not', where?.steps.map((s) => s.state), ['finished', 'cut', 'not-run']);
  check('with the end of their output', where?.steps[1]?.outputTail?.includes('✓ subtracts'), true);
  check('and that their results were not sent yet', where?.resultsSent, false);
  const told = describeInterruption(where!);
  check('the chat is told step by step', /step 1 ran to the end \(exit 0\)/.test(told) && /step 2 was running when the runner stopped/.test(told) && /step 3 did not run/.test(told), true);

  process.env.COP_DATA_DIR = data;
  try {
    await writeFile(join(data, 'settings.json'), JSON.stringify({ runsDir: runs }));
    const { OperatorService } = await import('../src/api/operator.service.js');
    // The task as the stopped process left it: running, with its run folder.
    const seed = new SessionStore(data, join(data, 'level1.md'));
    await seed.init();
    const s = await seed.createSession('power cut', { enabled: false, rootDir: '' });
    await seed.updateSession(s.id, (x) => {
      x.vcs = { enabled: false, repoDir: '', branchMode: 'per-task', commitOnFinish: false, branchPrefix: 'cop/' };
      x.status = 'running';
    });
    const t = await seed.addTask(s.id, { title: 'build and test', level2: '', prompt: 'Build it and test it.' });
    await seed.updateTask(s.id, t.id, (x) => {
      x.status = 'running';
      x.runId = runId;
    });

    const ops = new OperatorService();
    await ops.bootstrap();
    const after = (await ops.store.getSession(s.id))!.tasks[0]!;
    check('at the next start it is closed as aborted', after.status, 'aborted');
    check('with where it had got to', after.interruption?.steps.map((x) => x.state), ['finished', 'cut', 'not-run']);
    check('and the reason says it can be continued', /Continue in the same chat/.test(after.reason ?? ''), true);
    const row = (await ops.taskRegistry()).find((e) => e.taskId === t.id);
    check('the register marks it interrupted', row?.interrupted, true);

    const next = await ops.continueTask(s.id, t.id);
    check('"Continue" carries it on, as an interruption', [next.status, next.continuing?.how], ['queued', 'interrupted']);
    check('the new attempt starts with no interruption of its own', next.interruption ?? null, null);
    const msg = composeOpening({ ...base, contractAlreadySent: true, continuing: next.continuing });
    const text = msg.messages.join('\n');
    check('the chat is told the runner stopped, not the task', /stopped unexpectedly/.test(text) && /nothing you did failed/.test(text), true);
    check('and which steps ran', /step 2 was running when the runner stopped/.test(text), true);
    check('and not that a limit was reached', /limit was reached/.test(text), false);

    // Stopped by the operator: continued too, and told so.
    await ops.store.updateTask(s.id, t.id, (x) => {
      x.status = 'aborted';
      x.interruption = undefined;
    });
    const stopped = await ops.continueTask(s.id, t.id);
    check('a task the operator stopped is continued as stopped', stopped.continuing?.how, 'stopped');
    // A verdict is not continued.
    await ops.store.updateTask(s.id, t.id, (x) => {
      x.status = 'failed';
    });
    let refusedFailed = false;
    await ops.continueTask(s.id, t.id).catch(() => (refusedFailed = true));
    check('a failed task is not continued', refusedFailed, true);
  } finally {
    await rm(runs, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
}

console.log(wrong === 0 ? '\nall good' : `\n${wrong} wrong`);
process.exit(wrong === 0 ? 0 : 1);
