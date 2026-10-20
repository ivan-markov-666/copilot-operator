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
import { canFollowUp, isContinuable, MAX_INSTRUCTION_CHARS } from '../src/session/model.js';
import { canFollowUp as webCanFollowUp, isContinuable as webIsContinuable } from '../web/lib/api.js';

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

console.log('\n--- a limit from the settings: which one, and who may continue ---');
{
  // Asked for on 2026-09-30: a task stopped by a limit in the settings must always offer "Continue".
  const minutes = composeOpening({ ...base, contractAlreadySent: true, continuing: { fromAttempt: 1, how: 'limit', stoppedBecause: 'maxRunMinutes (120) reached', limit: { setting: 'maxRunMinutes', value: 120 } } }).messages.join('\n');
  check('the chat is told which limit, in words', /limit of 120 minutes per task was reached/.test(minutes) && /not because anything failed/.test(minutes), true);
  const wait = composeOpening({ ...base, contractAlreadySent: true, continuing: { fromAttempt: 1, how: 'limit', limit: { setting: 'replyTimeoutSec', value: 900 } } }).messages.join('\n');
  check('the reply wait too', /900 seconds to wait for one reply/.test(wait), true);
  const rounds = composeOpening({ ...base, contractAlreadySent: true, continuing: { fromAttempt: 1, how: 'limit', limit: { setting: 'maxCheckRounds', value: 3 } } }).messages.join('\n');
  check('out of rounds of fixing: what failed is still open, and it is not called a success', /3 rounds of fixing failed checks/.test(rounds) && /still open/.test(rounds) && !/not because anything failed/.test(rounds), true);

  const limit = { setting: 'maxCheckRounds' as const, value: 3 };
  check('stopped at the limit, aborted: continuable', [isContinuable({ status: 'limit-reached' }), isContinuable({ status: 'aborted' })], [true, true]);
  check('failed or blocked by a limit from the settings: continuable', [isContinuable({ status: 'failed', limit }), isContinuable({ status: 'blocked', limit })], [true, true]);
  check('failed or blocked on the work itself: not', [isContinuable({ status: 'failed' }), isContinuable({ status: 'blocked' })], [false, false]);
  check('done or queued, whatever is recorded: not', [isContinuable({ status: 'done', limit }), isContinuable({ status: 'queued', limit })], [false, false]);
  check('the page and the API decide the same way', (['done', 'failed', 'blocked', 'aborted', 'limit-reached', 'queued'] as const).flatMap((status) => [
    isContinuable({ status }) === webIsContinuable({ status }),
    isContinuable({ status, limit }) === webIsContinuable({ status, limit }),
  ]).every(Boolean), true);
}

console.log('\n--- what is allowed, and what is kept ---');
const dir = await mkdtemp(join(tmpdir(), 'cop-continue-'));
try {
  const store = new SessionStore(dir, join(dir, 'level1.md'));
  await store.init();
  const s = await store.createSession('calc');
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
    const task = x.tasks.find((y) => y.id === t.id)!;
    task.status = 'failed';
    task.reason = '1 check(s) still failing after 3 attempt(s)';
  });
  let refusedVerdict = false;
  await store.continueTask(s.id, t.id).catch(() => (refusedVerdict = true));
  check('failed on the work itself: not continued', refusedVerdict, true);
  await store.updateSession(s.id, (x) => {
    x.tasks.find((y) => y.id === t.id)!.limit = { setting: 'maxCheckRounds', value: 3 };
  });
  const byLimit = await store.continueTask(s.id, t.id);
  check('failed because the rounds ran out: continued, as a limit, naming it', [byLimit.status, byLimit.continuing?.how, byLimit.continuing?.limit],
    ['queued', 'limit', { setting: 'maxCheckRounds', value: 3 }]);
  check('the stopped attempt keeps its limit; the new one starts without', [byLimit.attempts?.at(-1)?.limit, byLimit.limit ?? null], [{ setting: 'maxCheckRounds', value: 3 }, null]);

  await store.updateSession(s.id, (x) => {
    x.tasks.find((y) => y.id === t.id)!.status = 'done';
  });
  const again = await store.rerunTask(s.id, t.id);
  check('an ordinary "Run again" is not a continuation', again.continuing ?? null, null);
} finally {
  await rm(dir, { recursive: true, force: true });
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
    const s = await seed.createSession('power cut');
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
    // Carried on as the runner carries a task on by itself (`limits.autoContinue`): the store's own continuation.
    const next = await ops.store.continueTask(s.id, t.id);
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
    const stopped = await ops.store.continueTask(s.id, t.id);
    check('a task the operator stopped is continued as stopped', stopped.continuing?.how, 'stopped');
  } finally {
    await rm(runs, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
}

/*
 * A task that failed, carried on with a new prompt (asked for on 2026-10-13): the operator says what to
 * do now, the task goes back to its chat and branch, and the chat is told how the attempt ended and why
 * before it is given the prompt — added to the task's own, not in its place.
 */
console.log('\n--- a failed task, carried on with a new prompt ---');
{
  check('who may: failed or blocked on the work', [canFollowUp({ status: 'failed' }), canFollowUp({ status: 'blocked' })], [true, true]);
  check('not a task that contradicted itself, nor one that ended any other way', [canFollowUp({ status: 'blocked', stopCode: 'contract-conflict' }), canFollowUp({ status: 'done' }), canFollowUp({ status: 'aborted' }), canFollowUp({ status: 'queued' })], [false, false, false, false]);
  const statuses = ['queued', 'running', 'waiting-approval', 'done', 'blocked', 'failed', 'aborted', 'limit-reached'] as const;
  check('the page and the runner agree on who may', statuses.flatMap((st) => [undefined, 'contract-conflict' as const].map((sc) => canFollowUp({ status: st, stopCode: sc }) === webCanFollowUp({ status: st, stopCode: sc }))).every(Boolean), true);

  const ended = {
    status: 'failed' as const,
    reason: '1 check(s) still failing after 3 attempt(s)',
    failedChecks: [{ name: 'okta url read', detail: 'expected src/okta.ts to contain "config/okta.json", and it does not' }],
    findings: [{ what: 'The URL is hard-coded', where: 'src/okta.ts:12', evidence: 'const url = "https://dev.okta.example"' }],
    summary: 'I added the validation tests; one still fails.',
  };
  const same = composeOpening({
    ...base,
    contractAlreadySent: true,
    continuing: { fromAttempt: 2, how: 'failed', stoppedBecause: ended.reason, instruction: 'Read the Okta URL from config/okta.json instead of hard-coding it, then run the tests again.', ended },
    instruction: { text: 'Read the Okta URL from config/okta.json instead of hard-coding it, then run the tests again.', fromAttempt: 2, ended },
  });
  const text = same.messages.join('\n');
  check('one message, in the same conversation', [same.messages.length, /^Continue task 1: basic-operations, in this same conversation, with a new instruction from the operator/.test(text)], [1, true]);
  check('it says the attempt did not succeed, how it ended and why', /attempt 2\) did not succeed: it ended failed — 1 check\(s\) still failing/.test(text), true);
  check('with the checks that did not pass and what the review found', text.includes('- okta url read: expected src/okta.ts') && text.includes('- The URL is hard-coded (src/okta.ts:12): const url'), true);
  check('and that attempt\'s own summary', text.includes("That attempt's own summary: I added the validation tests"), true);
  check('the work is there, not to be started over', /what it changed is in your working tree\. Do not start over/.test(text), true);
  check('then the new prompt, as its own section, added to the task', /## New instruction from the operator\n\nAdded to the task above, not in place of it; where the two disagree, this wins\.\n\nRead the Okta URL from config\/okta\.json/.test(text), true);
  check('not "carry on from your plan", which is the plan that failed; nor "the assignment has not changed"', [/start from\s+your plan/.test(text), /it has not changed/.test(text)], [false, false]);
  check('the assignment is not sent again', text.includes('Build the calculator'), false);

  const lost = composeOpening({ ...base, contractAlreadySent: false, continuing: { fromAttempt: 2, how: 'failed', instruction: 'Use config/okta.json.', ended }, instruction: { text: 'Use config/okta.json.', fromAttempt: 2, ended } });
  const lostText = lost.messages.join('\n');
  check('a chat that lost it gets the task in full, how the attempt ended, and the prompt after it', [lostText.includes('Build the calculator'), /did not succeed/.test(lostText), lostText.indexOf('Build the calculator') < lostText.indexOf('## New instruction from the operator'), lostText.includes('Use config/okta.json.')], [true, true, true, true]);
  const never = composeOpening({ ...base, contractAlreadySent: true, instruction: { text: 'Use config/okta.json.', fromAttempt: 2, ended } });
  const neverText = never.messages.join('\n');
  check('an attempt that never reached a chat: the task, then how it ended and the prompt', [neverText.includes('Build the calculator'), /never reached this conversation/.test(neverText), neverText.includes('Use config/okta.json.')], [true, true, true]);
  const limitPlus = composeOpening({ ...base, contractAlreadySent: true, continuing: { fromAttempt: 1, how: 'limit', limit: { setting: 'maxRunMinutes', value: 120 }, instruction: 'Skip the slow e2e suite.' }, instruction: { text: 'Skip the slow e2e suite.', fromAttempt: 1 } }).messages.join('\n');
  check('a Continue after a limit may bring a prompt too: carries on, with it added', [/start from\s+your plan/.test(limitPlus), limitPlus.includes('## New instruction from the operator'), limitPlus.includes('Skip the slow e2e suite.'), /it has not changed/.test(limitPlus)], [true, true, true, false]);

  const dir2 = await mkdtemp(join(tmpdir(), 'cop-followup-'));
  try {
    const store = new SessionStore(dir2, join(dir2, 'level1.md'));
    await store.init();
    const s = await store.createSession('okta');
    const t = await store.addTask(s.id, { title: 'okta-tests', level2: '', prompt: 'Add Okta validation tests.' });
    await store.updateSession(s.id, (x) => {
      const task = x.tasks.find((y) => y.id === t.id)!;
      task.status = 'failed';
      task.reason = ended.reason;
      task.summary = ended.summary;
      task.checkResults = [{ name: 'okta url read', passed: false, detail: ended.failedChecks[0]!.detail }, { name: 'tests exist', passed: true, detail: 'ok' }];
      task.review = { verdict: 'fail', rounds: 1, stepsRun: 2, findings: [{ what: ended.findings[0]!.what, where: ended.findings[0]!.where, evidence: ended.findings[0]!.evidence }] } as never;
      task.vcs = { branch: 'cop/okta/okta-tests', baseCommit: 'abc1234', commit: 'def5678' } as never;
    });
    const without = await store.continueTask(s.id, t.id).then(() => 'queued', (e: Error) => e.message);
    check('without a prompt it is refused, saying a prompt is what carries it on', /carried on with a new prompt/.test(without), true);
    const tooLong = await store.continueTask(s.id, t.id, null, 'x'.repeat(MAX_INSTRUCTION_CHARS + 1)).then(() => 'queued', (e: Error) => e.message);
    check('nor with one longer than a message can carry', /at most/.test(tooLong), true);
    const next = await store.continueTask(s.id, t.id, null, '  Read the URL from config/okta.json.  ');
    check('with one: queued as the next attempt, carrying on after the failure', [next.status, next.attempt, next.continuing?.how, next.continuing?.instruction], ['queued', 2, 'failed', 'Read the URL from config/okta.json.']);
    check('with how it ended: the reason, the failed check only, the review finding, the summary', next.continuing?.ended, {
      status: 'failed',
      reason: ended.reason,
      summary: ended.summary,
      failedChecks: [{ name: 'okta url read', detail: ended.failedChecks[0]!.detail }],
      findings: [{ what: ended.findings[0]!.what, where: ended.findings[0]!.where, evidence: ended.findings[0]!.evidence }],
    });
    check('the prompt is added, not put in place of the task\'s', next.prompt, 'Add Okta validation tests.');
    check('the failed attempt is kept, with its branch', [next.attempts?.at(-1)?.status, (next.attempts?.at(-1)?.vcs as { branch?: string } | undefined)?.branch], ['failed', 'cop/okta/okta-tests']);
    // Ended again, and continued again: the earlier prompt stays with the attempt it was given for.
    await store.updateSession(s.id, (x) => {
      const task = x.tasks.find((y) => y.id === t.id)!;
      task.status = 'blocked';
      task.reason = 'config/okta.json is not in the repository';
    });
    const third = await store.continueTask(s.id, t.id, null, 'It is in config/samples/okta.json.');
    check('a second prompt after a second failure: its own, and the first one stays on the attempt it ran with', [third.continuing?.instruction, third.continuing?.ended?.status, third.attempts?.at(-1)?.continuing?.instruction], ['It is in config/samples/okta.json.', 'blocked', 'Read the URL from config/okta.json.']);
    await store.updateSession(s.id, (x) => {
      const task = x.tasks.find((y) => y.id === t.id)!;
      task.status = 'blocked';
      task.stopCode = 'contract-conflict';
    });
    const conflicted = await store.continueTask(s.id, t.id, null, 'Anything.').then(() => 'queued', (e: Error) => e.message);
    check('a task that contradicted itself is sent to its fix instead', /Fix the contradiction/.test(conflicted), true);
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }
}

console.log(wrong === 0 ? '\nall good' : `\n${wrong} wrong`);
process.exit(wrong === 0 ? 0 : 1);
