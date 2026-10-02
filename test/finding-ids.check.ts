/**
 * A review finding's id names one finding for the whole life of its task, not only for one attempt.
 *
 * The runner names findings by round and position (`r1f2`) and the round counter starts again on
 * every attempt, while the checks reviewers give with their findings are kept with the task for every
 * later attempt (`Task.reviewChecks`). So the first finding of attempt 2 was `r1f1` again, beside the
 * kept check of attempt 1's `r1f1`, and everything that finds a review check by its finding's id or
 * by its check's name — a dispute suspending it, spent check rounds deferring it, the runner dropping
 * one it now refuses, the interface pairing it with its result — acted on both. A dispute of attempt
 * 2's finding suspended attempt 1's check, and the next review's pass dropped it, although nobody had
 * disputed it and no reviewer had ruled on it (adversarial review, 2026-10-02).
 *
 * From the second attempt on an id carries its attempt — `a2r1f1` — and the check's name with it, so
 * ids and names are unique across the task. The first attempt keeps `r1f1`. Each scenario runs the
 * scripted chat (test/support/fakeChat.ts) through the real API, as e2e-review does.
 *
 *   npm run check:finding-ids   (or: npx tsx test/finding-ids.check.ts)
 */
import { startHarness, Tally, type Harness, type TaskView } from './support/harness.js';
import { reply } from './support/fakeChat.js';
import { findingId } from '../src/protocol/reviewSchema.js';
import { derivedCheckName, isDerivedCheck, suspendDisputed, withAttemptIds } from '../src/orchestrator/derivedChecks.js';
import type { TaskReviewCheck } from '../src/session/model.js';

const t = new Tally();

// --- helpers (the shapes e2e-review.check.ts uses) -------------------------------------------

const fenced = (value: unknown): string => `Here is my answer.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;

/** The exact sentence of the task prompt a finding rests on, so the grounding rule lets it through. */
const BASIS = 'holding exactly the word hi';

type Check = { name: string; expect: string; file: string; value: string };

function fail(what: string, check: Check): string {
  return fenced({
    status: 'fail',
    summary: 'I ran Get-Content on hello.txt and compared what it printed with what the task asks for.',
    findings: [{ what, where: 'hello.txt', evidence: 'Get-Content hello.txt printed something else', basis: BASIS, check }],
  });
}

const look = (): string => reply.steps('Get-Content hello.txt');
const write = (text: string): string => reply.steps(`Set-Content hello.txt '${text}'`);

/** The id in front of the first finding of a findings message, as the implementer reads it. */
const firstId = (text: string): string | null => /\[((?:a\d+)?r\d+f\d+)\]/.exec(text)?.[1] ?? null;

const greeting = {
  title: 'write-greeting',
  prompt: 'Create hello.txt in the repository root holding exactly the word hi, and nothing else.',
  checks: [] as unknown[],
};

function plan(h: Harness, name: string): unknown {
  return {
    version: 1,
    sessions: [{ name, onFailure: 'stop', vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: name }, review: { enabled: true }, tasks: [greeting] }],
  };
}

type Full = TaskView & {
  reviewChecks?: Array<{ findingId: string; attempt: number; state: string; check: { name: string } }>;
  checkResults?: Array<{ name: string; passed: boolean; detail: string }>;
  review?: { verdict?: string; findings?: Array<{ id?: string }> };
};
const taskNow = async (h: Harness, sessionId: string): Promise<Full> => (await h.session(sessionId)).tasks[0] as Full;

/** Attempt 1: a finding's check (`hi!`) joins the gate, the work is fixed, the review passes. */
async function firstAttempt(h: Harness, sessionId: string, checkName: string): Promise<Full> {
  h.chat.script(
    write('hi'),
    reply.done(),
    look(),
    fail('hello.txt has no exclamation mark after hi', { name: checkName, expect: 'file-contains', file: 'hello.txt', value: 'hi!' }),
    write('hi!'),
    reply.done(),
    look(),
    reply.pass(),
  );
  const task = (await h.run(sessionId)).tasks[0] as Full;
  t.check('attempt 1 is done, its finding\'s check kept with the task', [task.status, task.reviewChecks?.map((rc) => [rc.findingId, rc.state])], ['done', [['r1f1', 'active']]]);
  return task;
}

async function scenario(title: string, settings: Record<string, unknown>, body: (h: Harness) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings });
  try {
    await body(h);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
    t.check('every scripted reply was used', h.chat.pending, 0);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

const started = Date.now();

// --- the ids and names, without a chat ------------------------------------------------------------

console.log('--- ids and names ---');
t.check('the first attempt keeps the short id', findingId(1, 0, 1), 'r1f1');
t.check('a later attempt\'s id carries its attempt', findingId(1, 0, 2), 'a2r1f1');
t.check('an attempt that is not known counts as the first', findingId(2, 1), 'r2f2');
t.truthy('the same round and position on two attempts are two names', derivedCheckName(findingId(1, 0, 1), 'x') !== derivedCheckName(findingId(1, 0, 2), 'x'));
t.truthy('a derived check is recognised by its name, with or without the attempt',
  isDerivedCheck({ name: 'review a2r1f1: x', expect: 'exit-zero' } as never) && isDerivedCheck({ name: 'review r1f1: x', expect: 'exit-zero' } as never));
t.truthy('and an operator\'s check is not', !isDerivedCheck({ name: 'review the README', expect: 'exit-zero' } as never));

const rc = (findingId: string, attempt: number, name: string): TaskReviewCheck => ({
  check: { name: `review ${findingId}: ${name}`, expect: 'file-contains', file: 'a.txt', value: 'x' } as TaskReviewCheck['check'],
  findingId,
  what: name,
  round: 1,
  attempt,
  state: 'active',
});
// Written before ids carried the attempt: two `r1f1`s, one per attempt, the same check name.
const legacy = [rc('r1f1', 1, 'greets'), rc('r1f1', 2, 'greets'), rc('r2f1', 3, 'shouts')];
const upgraded = withAttemptIds(legacy);
t.check('kept checks written before are given the id their attempt would give them now',
  upgraded.map((c) => [c.findingId, c.check.name]),
  [['r1f1', 'review r1f1: greets'], ['a2r1f1', 'review a2r1f1: greets'], ['a3r2f1', 'review a3r2f1: shouts']]);
t.check('and once is enough', withAttemptIds(upgraded), upgraded);
t.check('a dispute of one of them then suspends that one only',
  suspendDisputed(upgraded, ['A2R1F1']).checks.map((c) => c.state), ['active', 'suspended', 'active']);

// --- end to end ---------------------------------------------------------------------------------

/*
 * The reported case. Attempt 1 keeps a check from its `r1f1`; attempt 2's reviewer raises a different
 * finding with a check of its own; the implementer disputes that finding by the id it was shown. Only
 * that finding's check is suspended: attempt 1's goes on running in the gate, and the pass that rules
 * on the dispute drops the disputed check and leaves the other where it was.
 */
await scenario('a dispute on a later attempt suspends that attempt\'s check, not an earlier one with the same round and position', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'ids-dispute'));
  const first = await firstAttempt(h, s!.id, 'says hi!');
  const earlierName = first.reviewChecks?.[0]?.check.name ?? '';

  await h.call('POST', `/sessions/${s!.id}/tasks/${first.id}/rerun`);
  let disputed = '';
  h.chat.script(
    write('hi!'),
    reply.done(),
    look(),
    fail('hello.txt does not say HELLO in capital letters', { name: 'says HELLO', expect: 'file-contains', file: 'hello.txt', value: 'HELLO' }),
    (m) => {
      disputed = firstId(m.text) ?? '(no id in the findings message)';
      t.check('attempt 2\'s finding is named with its attempt', disputed, 'a2r1f1');
      return fenced({
        status: 'continue',
        notes: 'Plan: 1. show the file 2. report done',
        steps: [{ id: 1, type: 'command', cmd: 'Get-Content hello.txt' }],
        disputed: [{ finding: disputed, why: 'the task says exactly hi', evidence: 'the prompt reads holding exactly the word hi' }],
      });
    },
    (m) => {
      t.truthy('the implementer is told the disputed finding\'s check, and only it, is suspended',
        m.text.includes(`tied to ${disputed} are suspended`), m.text.slice(0, 900));
      return reply.done();
    },
    async () => {
      const now = await taskNow(h, s!.id);
      const ran = (now.checkResults ?? []).map((c) => [c.name, c.passed]);
      t.truthy('the gate after the dispute still ran attempt 1\'s check, and it passed', ran.some(([n, p]) => n === earlierName && p === true), ran);
      t.truthy('and did not run the disputed one', !ran.some(([n]) => String(n).includes('says HELLO')), ran);
      return look();
    },
    reply.pass(),
  );
  const task = (await h.run(s!.id)).tasks[0] as Full;
  t.check('attempt 2 is done', [task.attempt, task.status], [2, 'done']);
  t.check('attempt 1\'s check is still active, the disputed one dropped by the pass',
    task.reviewChecks?.map((c) => [c.findingId, c.attempt, c.state]), [['r1f1', 1, 'active'], ['a2r1f1', 2, 'dropped']]);
  const names = (task.reviewChecks ?? []).map((c) => c.check.name);
  t.check('no two of the task\'s review checks share a name', new Set(names).size, names.length);
});

/*
 * The same collision through the check's name. Both reviewers call their check the same; attempt 2's
 * keeps failing, and when the check rounds are spent the runner suspends the derived checks that
 * fail, by name, and sends the work to the reviewer. Attempt 1's check was passing and must stay out
 * of that: it was suspended with the other and dropped by the pass that followed.
 */
await scenario('checks deferred by spent rounds are the failing ones, not an earlier attempt\'s of the same name', { limits: { maxCheckRounds: 1 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'ids-deferral'));
  const first = await firstAttempt(h, s!.id, 'the greeting is right');

  await h.call('POST', `/sessions/${s!.id}/tasks/${first.id}/rerun`);
  h.chat.script(
    write('hi!'),
    reply.done(),
    look(),
    fail('hello.txt does not say HELLO in capital letters', { name: 'the greeting is right', expect: 'file-contains', file: 'hello.txt', value: 'HELLO' }),
    // A change, so the next "done" is not read as no progress; the new check still fails.
    write('hi!!'),
    reply.done(),
    async () => {
      const now = await taskNow(h, s!.id);
      const failed = (now.checkResults ?? []).filter((c) => !c.passed).map((c) => c.name);
      t.check('the gate failed attempt 2\'s check only', failed, ['review a2r1f1: the greeting is right']);
      return look();
    },
    reply.pass(),
  );
  const task = (await h.run(s!.id)).tasks[0] as Full;
  t.check('attempt 2 is done', [task.attempt, task.status], [2, 'done']);
  t.check('attempt 1\'s passing check is still active, the deferred one dropped by the pass',
    task.reviewChecks?.map((c) => [c.findingId, c.state]), [['r1f1', 'active'], ['a2r1f1', 'dropped']]);
});

console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s)`);
t.finish();
