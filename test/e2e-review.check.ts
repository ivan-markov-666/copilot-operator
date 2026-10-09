/**
 * The independent review loop, end to end, with the scripted chat in place of Copilot
 * (test/support/fakeChat.ts). No browser is opened and nothing is sent to Microsoft 365.
 *
 * The review is the gate that decides whether work reported done and checked is actually done, and
 * every rule it has was added after a run went wrong without it. What this file pins, each through
 * the API the interface uses and with the reviewer's steps run for real in the throwaway repository:
 *
 * - fail, fix, pass: the findings go back into the implementer's own conversation, named by id and
 *   by round, and the next reviewer is told what the last one found;
 * - the rounds of fixing run out: blocked at the `maxReviewRounds` limit, not left to spin;
 * - a "pass" without a single command run is sent back once (the anti-rubber-stamp rule);
 * - findings about the task rather than the work: a fail stops the task at once, a pass carries them
 *   as notes;
 * - a finding must quote the task (grounding): asked once for the quote, then dropped;
 * - a review that breaks (format, iterations) accepts the work, and says so on the record;
 * - the review runs on the review model from Settings, or the session's own;
 * - the implementer's declared deviations reach the reviewer and the commit;
 * - a check given with a finding joins the gate, a dispute suspends it, and the next review rules;
 *   one the runner refuses later for its own line (the settings changed) is dropped, and the work is
 *   judged without it rather than ended on it;
 * - after the review the implementer's conversation is the one the next task goes to;
 * - a session whose repository is only its project folder (vcs.repoDir empty) is reviewed as one
 *   with a repository: the reviewer is told where it is and what the task changed in it;
 * - a secret a reviewer quotes in its evidence is redacted before it goes back to the chat, and a
 *   check turned down for passing on the work goes back with the operator's own patterns applied;
 * - Stop pressed during the review ends the task aborted, not done, with nothing more sent to either
 *   chat, and the review loop ends on it by itself, not only because the runner's chat refuses to
 *   send; pressed once the checks have accepted the work, it ends the task before a review opens,
 *   and with the review switched off it leaves the task done, there being nothing left to judge.
 *
 *   npm run check:e2e-review   (or: npx tsx test/e2e-review.check.ts)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, waitFor, Tally, type Harness, type TaskView } from './support/harness.js';
import { reply, type Incoming } from './support/fakeChat.js';
import { SessionStore } from '../src/session/store.js';
import { loadConfigObject, RunConfigSchema } from '../src/config/schema.js';
import { runReview } from '../src/orchestrator/review.js';
import { Pacer } from '../src/util/pacing.js';
import type { Session } from '../src/session/model.js';

const t = new Tally();

// --- helpers ---------------------------------------------------------------------------------

/** A reply exactly as fakeChat builds its own: one fenced json block with a sentence before it. */
const fenced = (value: unknown): string => `Here is my answer.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;

/** The exact sentence of the task prompt a finding rests on, so the grounding rule lets it through. */
const BASIS = 'holding exactly the word hi';

type Finding = { what: string; evidence: string; where: string; basis: string; about?: 'work' | 'task'; check?: Record<string, unknown> };

/** A finding in the reviewer's format: `what` at least 15 characters, `evidence` at least 10. */
function finding(f: Partial<Finding> & { what: string; where: string }): Finding {
  return { evidence: 'Get-Content hello.txt printed: hello', basis: BASIS, ...f };
}

/** A "fail" verdict; the contract wants a summary of at least 40 characters with it. */
function fail(findings: Finding[], summary = 'I ran Get-Content on hello.txt and compared what it printed with what the task asks for.'): string {
  return fenced({ status: 'fail', summary, findings });
}

/** A "pass" that carries findings, which the contract allows only when they are about the task. */
function passWith(findings: Finding[], summary = 'I ran Get-Content on hello.txt: it holds exactly hi, which is what the task asks for.'): string {
  return fenced({ status: 'pass', summary, findings });
}

/** An implementer's "continue" with extra fields — deviations, disputes — the reply helpers never add. */
function stepsWith(cmd: string, extra: Record<string, unknown>): string {
  return fenced({ status: 'continue', notes: 'Plan: 1. do the work 2. check it', steps: [{ id: 1, type: 'command', cmd }], ...extra });
}

const write = (text: string): string => reply.steps(`Set-Content hello.txt ${text}`);
const look = (): string => reply.steps('Get-Content hello.txt');

/*
 * The greeting task of e2e-run, without its plan check. The review is what is under test here, and a
 * plan check for "hi" would catch a first attempt that writes "hello" before any reviewer saw it. The
 * runner's own two checks (nothing to be committed that should not be, clean text) still run.
 */
const greeting = {
  title: 'write-greeting',
  prompt: 'Create hello.txt in the repository root holding exactly the word hi, and nothing else.',
  checks: [] as unknown[],
};

function plan(h: Harness, name: string, tasks: unknown[], review: Record<string, unknown> = { enabled: true }): unknown {
  return {
    version: 1,
    sessions: [{ name, onFailure: 'stop', vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: name }, review, tasks }],
  };
}

/** The parts of the task record this file reads beyond `TaskView`. */
type Full = Omit<TaskView, 'review'> & {
  review?: { verdict?: string; rounds?: number; stepsRun?: number; problem?: string; model?: string; findings?: Array<{ id?: string; what: string; about?: string }> };
  reviewChecks?: Array<{ findingId: string; state: string; check: { name: string }; droppedBecause?: string }>;
  stopCode?: string;
  checkResults?: Array<{ name: string; passed: boolean; detail: string }>;
  deviations?: Array<{ instruction: string; did: string; why: string }>;
  limit?: { setting: string; value: number };
};
const full = (x: TaskView): Full => x as unknown as Full;
const taskNow = async (h: Harness, sessionId: string, index = 0): Promise<Full> => full((await h.session(sessionId)).tasks[index]!);
const events = (h: Harness, sessionId: string): Promise<Array<{ type: string; data?: Record<string, unknown> }>> =>
  h.call('GET', `/sessions/${sessionId}/events`);
const reviewConversations = (h: Harness): number => [...h.chat.conversations.values()].filter((c) => c.review).length;

/*
 * The task contract's first line, read the way fakeChat reads it. fakeChat marks a message as the
 * contract only when it is the first one of its conversation; a contract sent again into a
 * conversation that already has messages would go unmarked, so counting the marks cannot tell. The
 * text itself can: it is in every message that carries the contract, wherever it was sent.
 */
const TASK_CONTRACT = readFileSync(join(import.meta.dirname, '..', 'prompts', 'level1.md'), 'utf8')
  .split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';

async function scenario(title: string, settings: Record<string, unknown>, body: (h: Harness) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings });
  try {
    await body(h);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
    t.check('every chat window opened was closed again', h.chat.opened, h.chat.closed);
    t.check('every scripted reply was used', h.chat.pending, 0);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

const started = Date.now();

// --- scenarios -------------------------------------------------------------------------------

/*
 * The loop the whole mechanism exists for: work that is wrong in a way the plan's checks did not
 * catch goes back with the reviewer's findings, gets fixed, and a fresh reviewer — told what the
 * first one found — passes it. The findings must land in the implementer's conversation (the
 * reviewer's is a different one), carry the id a dispute would name, and say which round it is.
 */
await scenario('fail, fix, pass', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'fixed', [greeting]));
  let implChat = '';
  h.chat.script(
    (m) => {
      implChat = m.chatId;
      return write('hello');
    },
    reply.done(),
    look(),
    fail([finding({ what: 'hello.txt holds hello, not hi as the task asks', where: 'hello.txt' })]),
    (m) => {
      t.truthy('the findings go back into the implementer\'s own conversation', m.chatId === implChat && !m.chat.review, { got: m.chatId, want: implChat });
      t.truthy('each finding is named by the id a dispute would use', m.text.includes('[r1f1]'), m.text.slice(0, 600));
      t.truthy('and the message says which round of how many this is', m.text.includes('review round 1 of 2'), m.text.slice(-900));
      return write('hi');
    },
    reply.done(),
    (m) => {
      t.truthy('the second reviewer is told what round 1 found, by id', /What review round 1 found/.test(m.text) && m.text.includes('[r1f1]'), m.text.slice(0, 900));
      t.truthy('in a conversation of its own again', m.chat.review && m.chatId !== implChat, m.chatId);
      return look();
    },
    reply.pass(),
  );
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the task is done', task.status, 'done');
  t.check('after two rounds, the last one a pass', [task.review?.rounds, task.review?.verdict], [2, 'pass']);
  t.check('one rejection counted', task.stats?.reviewRejections, 1);
  t.check('three conversations: the implementer\'s and one per review round', h.chat.conversations.size, 3);
  t.truthy('the findings as sent are kept in the run folder', !!task.runId && existsSync(join(h.runsDir, task.runId, 'review', '1', 'findings-sent.md')), task.runId);
  t.check('the fix is what was committed', h.git('show', 'cop/fixed:hello.txt'), 'hi');
});

/*
 * The budget counts times findings are sent back. With one round allowed: round 1's findings go back,
 * the fix is reviewed (round 2), and a finding still there ends the task blocked at the limit — a
 * limit, so "Continue" can carry it on, rather than a verdict.
 */
await scenario('review rounds exhausted', { limits: { maxReviewRounds: 1, retryBlockedInFreshChat: 0 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'exhausted', [greeting]));
  h.chat.script(
    write('hello'),
    reply.done(),
    look(),
    fail([finding({ what: 'hello.txt holds hello, not hi as the task asks', where: 'hello.txt' })]),
    (m) => {
      t.truthy('the findings say this is the only round', m.text.includes('review round 1 of 1'), m.text.slice(-900));
      return write('hey');
    },
    reply.done(),
    look(),
    fail([finding({ what: 'hello.txt holds hey, still not hi as the task asks', where: 'hello.txt', evidence: 'Get-Content hello.txt printed: hey' })]),
  );
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('blocked', task.status, 'blocked');
  t.truthy('the reason says the finding outlived the rounds of fixing', /still there after 1 round\(s\) of fixing/.test(task.reason ?? ''), task.reason);
  t.check('the limit that ended it is recorded', task.limit, { setting: 'maxReviewRounds', value: 1 });
  t.check('exactly two review conversations were opened', reviewConversations(h), 2);
});

/*
 * Anti-rubber-stamp: the runner counts the commands a reviewer ran, and a "pass" with none is sent
 * back once, in as many words. The pass that follows real steps stands, with the count on the record.
 */
await scenario('a pass without running anything is sent back once', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'stamp', [greeting]));
  h.chat.script(
    write('hi'),
    reply.done(),
    reply.pass(),
    (m) => {
      t.truthy('the reviewer is told it ran nothing', m.text.includes('without running a single command'), m.text.slice(0, 400));
      return look();
    },
    reply.pass(),
  );
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the task is done', task.status, 'done');
  t.check('passed, on one command run', [task.review?.verdict, task.review?.stepsRun], ['pass', 1]);
  t.truthy('the refusal is on the record', (await events(h, s!.id)).some((e) => e.type === 'review-passed-nothing-run'));
});

/*
 * `about: "task"` is the reviewer's way of saying the work is right and the task is wrong. Failing
 * with only such findings ends the task at once — sending them back would ask the implementer to
 * fix a sentence it may not change — and passing with them keeps them as notes for the task's author.
 */
await scenario('findings about the task: a fail stops the task without sending anything back', { limits: { retryBlockedInFreshChat: 0 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'taskwrong', [greeting]));
  let implChat = '';
  h.chat.script(
    (m) => {
      implChat = m.chatId;
      return write('hi');
    },
    reply.done(),
    look(),
    fail([finding({ what: 'the task asks for hi while the project instructions demand hello in every file', where: 'hello.txt', about: 'task' })]),
  );
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('blocked', task.status, 'blocked');
  t.truthy('the reason says the problem is the task, not the work', /problem\(s\) with the task itself rather than with the work/.test(task.reason ?? ''), task.reason);
  const sent = h.chat.sent;
  const reviewOpened = sent.findIndex((m) => h.chat.conversations.get(m.chatId)?.review);
  const lastToImplementer = sent.map((m) => m.chatId).lastIndexOf(implChat);
  t.truthy('the implementer\'s conversation got nothing after the review opened', reviewOpened > 0 && lastToImplementer < reviewOpened, { reviewOpened, lastToImplementer });
});

await scenario('findings about the task: a pass carries them as notes', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'tasknotes', [greeting]));
  h.chat.script(
    write('hi'),
    reply.done(),
    look(),
    passWith([finding({ what: 'the task says nothing else but a trailing newline is always written', where: 'hello.txt', about: 'task', evidence: 'Get-Content -Raw hello.txt printed hi and a line break' })]),
  );
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the task is done', task.status, 'done');
  t.check('the review passed and kept its one note', [task.review?.verdict, task.review?.findings?.length], ['pass', 1]);
  t.truthy('the notes are said on the record', (await events(h, s!.id)).some((e) => e.type === 'review-task-notes'));
});

/*
 * Grounding: a finding must quote the sentence of the task it rests on. One that quotes something
 * the task never said is sent back once for the quote; the same again, and it is dropped as an
 * invented requirement. A fail with nothing grounded left has reviewed nothing, so it is an error —
 * and an error accepts the work.
 */
await scenario('ungrounded findings are asked for their quote once, then dropped', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'grounding', [greeting]));
  const invented = fail([finding({ what: 'the label in hello.txt does not read First number', where: 'hello.txt', basis: 'labels must read First number' })]);
  h.chat.script(
    write('hi'),
    reply.done(),
    look(),
    invented,
    (m) => {
      t.truthy('the reviewer is asked to quote the sentence its finding rests on', m.text.includes('quote the sentence'), m.text.slice(0, 600));
      return invented;
    },
  );
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the task is done', task.status, 'done');
  t.check('the review is recorded as an error, not a fail', task.review?.verdict, 'error');
  t.truthy('saying its findings rested on nothing the task asked', /rested on something the task never asked for/.test(task.review?.problem ?? ''), task.review);
});

/*
 * A review that cannot be carried out is not evidence about the work. It accepts the work, loudly:
 * the verdict "error" and the reason stay on the task so "this went unreviewed" is visible.
 */
await scenario('a reviewer that will not keep its format: accepted, recorded as an error', { limits: { maxFormatRetries: 1 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'format', [greeting]));
  h.chat.script(write('hi'), reply.done(), reply.prose(), reply.prose());
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the task is done', task.status, 'done');
  t.check('the review is an error', task.review?.verdict, 'error');
  t.truthy('because the reviewer would not keep its contract', /would not keep its output contract/.test(task.review?.problem ?? ''), task.review);
});

await scenario('a reviewer that never reaches a verdict: accepted, recorded as an error', { limits: { maxReviewIterations: 1 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'iterations', [greeting]));
  // The second "continue" is read at the top of the loop, where the budget is already spent: it never runs.
  h.chat.script(write('hi'), reply.done(), look(), reply.steps('Get-Content hello.txt -Raw'));
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the task is done', task.status, 'done');
  t.check('the review is an error', task.review?.verdict, 'error');
  t.truthy('because it used its iterations without a verdict', /without reaching a verdict/.test(task.review?.problem ?? ''), task.review);
  t.check('the review ran one command, not two', task.review?.stepsRun, 1);
});

/*
 * The reviewer can be put on a different model — the same model has the same blind spots in either
 * conversation. Settings give the default; a review model the operator chose for the session overrides
 * it (a plan's gives way to Settings since 0.1.33: test/settings-precedence.check.ts).
 */
const models = { copilot: { defaultModel: 'Auto', defaultReviewModel: 'Think deeper' } };
await scenario('the review runs on the review model from Settings', models, async (h) => {
  const [s] = await h.importPlan(plan(h, 'model', [greeting]));
  h.chat.script(
    write('hi'),
    reply.done(),
    (m) => {
      t.check('the brief reaches a chat already switched to the review model', m.world.currentModel, 'Think deeper');
      return look();
    },
    reply.pass(),
  );
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the session model, then the review model', h.chat.modelRequests, ['Auto', 'Think deeper']);
  t.check('and the task records which model reviewed it', task.review?.model, 'Think deeper');
});

await scenario('a review model chosen on the session\'s page overrides Settings', models, async (h) => {
  const [s] = await h.importPlan(plan(h, 'ownmodel', [greeting]));
  // As the session's page sends it: the operator's own word.
  await h.call('PUT', `/sessions/${s!.id}`, { review: { enabled: true, model: 'GPT 5.6 Think deeper' } });
  h.chat.script(write('hi'), reply.done(), look(), reply.pass());
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the session model, then the session\'s review model', h.chat.modelRequests, ['Auto', 'GPT 5.6 Think deeper']);
  t.check('recorded on the task', task.review?.model, 'GPT 5.6 Think deeper');
});

/*
 * A deviation — "this instruction could not be followed as written" — is a claim the reviewer must
 * test, so it goes into the brief; and it is a product decision somebody will look for later, so it
 * goes into the commit.
 */
await scenario('deviations reach the reviewer and the commit', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'deviated', [greeting]));
  h.chat.script(
    stepsWith('Set-Content hello.txt hi', { deviations: [{ instruction: 'jsx preserve', did: 'kept react-jsx', why: 'next build rewrites it' }] }),
    reply.done(),
    (m) => {
      t.truthy('the brief lists what could not be done as written', m.text.includes('could not be done as written') && m.text.includes('jsx preserve'), m.text.slice(0, 1200));
      return look();
    },
    reply.pass(),
  );
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the task is done', task.status, 'done');
  t.check('the deviation is on the task', task.deviations?.length, 1);
  const message = h.git('log', '-1', '--format=%B', 'cop/deviated');
  // The commit words it as its own section ("Not as the task said:" / "did:" / "because:"), not with
  // the brief's "Did instead:" label; what must reach it is every part of the deviation.
  t.truthy('the commit message carries the instruction, what was done and why',
    /Not as the task said:/.test(message) && message.includes('jsx preserve') && message.includes('kept react-jsx') && message.includes('next build rewrites it'), message);
});

/*
 * A reviewer's finding can carry the check that would have caught it. That check joins the gate at
 * once — and a dispute of the finding suspends it, so the implementer is not held to a check it says
 * is wrong. The implementer is told in the very next message; the next reviewer is told of the dispute
 * and rules on it; not raised again, the check is dropped.
 */
await scenario('a disputed finding\'s check is suspended until the next review rules', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'disputed', [greeting]));
  h.chat.script(
    write('hi'),
    reply.done(),
    look(),
    fail([finding({
      what: 'hello.txt does not say HELLO in capital letters',
      where: 'hello.txt',
      check: { name: 'says HELLO', expect: 'file-contains', file: 'hello.txt', value: 'HELLO' },
    })]),
    async () => {
      const now = await taskNow(h, s!.id);
      t.check('after the round the finding\'s check is in the gate', now.reviewChecks?.[0]?.state, 'active');
      return stepsWith('Get-Content hello.txt', { disputed: [{ finding: 'r1f1', why: 'the task says exactly hi', evidence: 'the prompt reads holding exactly the word hi' }] });
    },
    (m) => {
      t.truthy('the next message says the dispute was noted and the check suspended', m.text.includes('Noted: you disputed r1f1') && m.text.includes('suspended'), m.text.slice(0, 900));
      return reply.done();
    },
    async (m) => {
      const now = await taskNow(h, s!.id);
      t.truthy('the gate that followed did not run the suspended check', (now.checkResults ?? []).length > 0 && !(now.checkResults ?? []).some((c) => c.name.startsWith('review r1f1')), now.checkResults);
      t.truthy('round 2 is told the implementer disputes a finding', m.text.includes('Findings the implementer disputes') && m.text.includes('r1f1'), m.text.slice(0, 1500));
      return look();
    },
    reply.pass(),
  );
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the task is done', task.status, 'done');
  t.check('not raised again, the disputed check is dropped', task.reviewChecks?.map((rc) => rc.state), ['dropped']);
});

/*
 * The other side: a check given with a finding that fails now, the implementer fixes the work, and
 * the gate runs the check and it passes. After the pass the check stays with the task: a derived
 * check is kept "for every attempt after this one" (review.ts), so a later rerun or continue is held
 * to it too. A read-only task never gets one: nothing it may do could change what the check reports.
 */
await scenario('a finding\'s check joins the gate and passes once the work is fixed', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'derived', [greeting]));
  h.chat.script(
    write('hi'),
    reply.done(),
    look(),
    fail([finding({
      what: 'hello.txt has no exclamation mark after hi',
      where: 'hello.txt',
      evidence: 'Get-Content hello.txt printed: hi',
      check: { name: 'says hi!', expect: 'file-contains', file: 'hello.txt', value: 'hi!' },
    })]),
    reply.steps("Set-Content hello.txt 'hi!'"),
    reply.done(),
    look(),
    reply.pass(),
  );
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the task is done', task.status, 'done');
  const derived = (task.checkResults ?? []).filter((c) => c.name.startsWith('review r1f1'));
  t.truthy('the gate ran the finding\'s check, and it passed', derived.length === 1 && derived[0]!.passed, task.checkResults);
  // Decision pin. The plan asked for "not active" after the pass; the design keeps a surviving derived
  // check for this attempt and every later one (derivedChecks.ts, Task.reviewChecks in model.ts,
  // docs/architecture.md), and only a dispute, spent check rounds, a read-only task or a new prompt
  // take it out of the gate. A pass drops suspended checks only.
  t.check('after the pass the check stays with the task for later attempts', task.reviewChecks?.map((rc) => rc.state), ['active']);
});

/*
 * A check kept with a finding outlives the attempt it was given in, and the settings can change
 * under it: here a deny pattern added afterwards refuses its command line. Nothing the implementer
 * does can make it run, and it is a reviewer's check, which never ends a task on its own. So the gate
 * drops it, saying why, and judges the work on the rest; the finding still stands for the next
 * reviewer. It used to end the task at the first "done", failed with invalid-check, on every attempt.
 */
await scenario('a finding\'s check the runner refuses later is dropped, not the end of the task', { limits: { maxIterations: 2 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'refusedlater', [greeting]));
  h.chat.script(
    write('hi'),
    reply.done(),
    look(),
    fail([finding({
      what: 'hello.txt has no exclamation mark after hi',
      where: 'hello.txt',
      evidence: 'Get-Content hello.txt printed: hi',
      check: { name: 'says hi!', expect: 'output-contains', run: 'Get-Content -Path hello.txt -Raw', value: 'hi!' },
    })]),
    // The answer to the findings is not read: the second iteration was the last one Settings allow.
    reply.steps("Set-Content hello.txt 'hi!'"),
  );
  const first = full((await h.run(s!.id)).tasks[0]!);
  t.check('the attempt stopped at the iteration limit, the finding\'s check kept with the task', [first.status, first.reviewChecks?.map((rc) => rc.state)], ['limit-reached', ['active']]);

  // The command line of that check is refused from now on.
  const settings = await h.call<{ raw: Record<string, unknown> & { execution?: Record<string, unknown> } }>('GET', '/settings');
  const denyPatterns = [...RunConfigSchema.parse({}).execution.denyPatterns, 'hello\\.txt -Raw'];
  await h.call('PUT', '/settings', { ...settings.raw, execution: { ...settings.raw.execution, denyPatterns } });

  await h.call('POST', `/sessions/${s!.id}/tasks/${first.id}/continue`);
  h.chat.script(reply.done(), look(), reply.pass());
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the task is done, judged without the check', [task.status, task.stopCode ?? null], ['done', null]);
  t.check('the check is dropped', task.reviewChecks?.map((rc) => rc.state), ['dropped']);
  t.truthy('saying the runner refuses it now', /refuses it now.*deny pattern/.test(task.reviewChecks?.[0]?.droppedBecause ?? ''), task.reviewChecks);
  t.truthy('it is not among the results', !(task.checkResults ?? []).some((c) => c.name.startsWith('review r1f1')), task.checkResults);
  t.truthy('and the record says so', (await events(h, s!.id)).some((e) => e.type === 'review-check-blocked'));
});

await scenario('a read-only task never carries a finding\'s check', {}, async (h) => {
  writeFileSync(join(h.repo, 'hello.txt'), 'hi\n');
  h.git('add', '-A');
  h.git('commit', '-q', '-m', 'greeting');
  const audit = { title: 'audit-greeting', prompt: 'Report whether hello.txt in the repository root is holding exactly the word hi; change nothing.', readOnly: true };
  const [s] = await h.importPlan(plan(h, 'readonly', [audit]));
  let afterRound = null as string[] | null;
  h.chat.script(
    look(),
    reply.done(),
    look(),
    fail([finding({
      what: 'hello.txt has no exclamation mark after hi',
      where: 'hello.txt',
      evidence: 'Get-Content hello.txt printed: hi',
      check: { name: 'says hi!', expect: 'file-contains', file: 'hello.txt', value: 'hi!' },
    })]),
    async () => {
      afterRound = ((await taskNow(h, s!.id)).reviewChecks ?? []).map((rc) => rc.state);
      return reply.done();
    },
    look(),
    reply.pass(),
  );
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the task is done', task.status, 'done');
  /*
   * Not "never active" but "never there": the runner has a second way to be rid of such a check (it
   * suspends a derived check it finds on a read-only task, then drops it, with the same event), so a
   * check that was taken on and later set aside would pass a "never active" test. The rule is that a
   * read-only task's findings stand and their checks are not kept at all.
   */
  t.check('no check was kept after the round', afterRound, []);
  t.check('no check was kept with the task', task.reviewChecks ?? [], []);
  t.truthy('no check was ever active, after the round or at the end',
    ![...(afterRound ?? []), ...(task.reviewChecks ?? []).map((rc) => rc.state)].includes('active'), { afterRound, end: task.reviewChecks });
  t.truthy('no gate ran one', !(task.checkResults ?? []).some((c) => c.name.startsWith('review r')), task.checkResults);
  t.truthy('and the record says why', (await events(h, s!.id)).some((e) => e.type === 'review-check-not-kept-readonly'));
});

/*
 * The review opens a conversation of its own and must hand the chat back: the next task of the
 * session goes into the implementer's conversation, which already has the contract, and not into
 * the reviewer's.
 */
await scenario('after a review the next task goes to the implementer\'s conversation', {}, async (h) => {
  const second = { title: 'write-farewell', prompt: 'Add a second file bye.txt holding the word bye, next to hello.txt, and change nothing else.' };
  const [s] = await h.importPlan(plan(h, 'returned', [greeting, second]));
  let implChat = '';
  h.chat.script(
    (m) => {
      implChat = m.chatId;
      return write('hi');
    },
    reply.done(),
    look(),
    reply.pass(),
    (m) => {
      t.truthy('task 2 opens in task 1\'s implementer conversation, not the review\'s', m.chatId === implChat && !m.chat.review, { got: m.chatId, want: implChat });
      // The reply must be answering task 2's own prompt, not a second contract whose handshake the
      // runner would throw away (which would hand task 2 the next scripted reply with no steps).
      t.truthy('the message it answers is task 2\'s prompt, with no contract in front of it',
        m.text.includes('Add a second file bye.txt') && !m.text.includes(TASK_CONTRACT), m.text.slice(0, 600));
      return reply.steps('Set-Content bye.txt bye');
    },
    reply.done(),
    reply.steps('Get-Content bye.txt'),
    reply.pass(),
  );
  const after = await h.run(s!.id);
  t.check('both tasks done', after.tasks.map((x) => x.status), ['done', 'done']);
  t.truthy('the contract line is known (prompts/level1.md read)', TASK_CONTRACT.length > 10, TASK_CONTRACT);
  t.check('the task contract was sent once', h.chat.sent.filter((m) => m.text.includes(TASK_CONTRACT)).length, 1);
  t.check('and marked as the opening of its conversation', h.chat.sent.filter((m) => m.contract === 'task').length, 1);
  t.check('one review conversation per task', reviewConversations(h), 2);
  // Task 2's own steps ran: the file it was asked for is in what was committed.
  t.check('task 2\'s own work is what was committed', h.git('show', 'cop/returned:bye.txt'), 'bye');
});

/*
 * A session whose repository is its project folder: version control on, `vcs.repoDir` left empty and
 * `projectDir` set, as the session page can save it. The runner branches and commits in that folder
 * (`repoDirOf`), and the reviewer must be told so; the review read `vcs.repoDir` itself, and was told
 * there was no repository and no changed files for work committed right there.
 */
await scenario('the review finds the repository of a session that names it only as its project folder', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'projectonly', [greeting]));
  await h.call('PUT', `/sessions/${s!.id}`, { projectDir: h.repo, vcs: { repoDir: '' } });
  const saved = await h.call<Session>('GET', `/sessions/${s!.id}`);
  t.check('control: version control on, no repoDir, the project folder set', [saved.vcs?.enabled, saved.vcs?.repoDir, saved.projectDir], [true, '', h.repo]);
  let brief = '';
  h.chat.script(
    write('hi'),
    reply.done(),
    (m) => {
      brief = m.text;
      return look();
    },
    reply.pass(),
  );
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the task is done', task.status, 'done');
  t.check('its work was committed on the session\'s branch in that folder', h.git('show', 'cop/projectonly:hello.txt'), 'hi');
  t.truthy('the reviewer is told where the repository is', brief.includes(`Repository: ${h.repo}`) && !brief.includes('There is no repository'), brief.slice(0, 1500));
  t.truthy('and which file the task changed', /^- hello\.txt$/m.test(brief), brief.slice(0, 1500));
});

/*
 * A reviewer quotes output in its evidence, and output can hold a secret. The findings message is
 * uploaded to the chat, so it is redacted like any step report — both what is sent and what is kept.
 */
await scenario('a secret in a finding\'s evidence is redacted before it goes back', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'secret', [greeting]));
  let findingsText = '';
  h.chat.script(
    write('hi'),
    reply.done(),
    look(),
    fail([finding({
      what: 'hello.txt holds a line the task never asked for',
      where: 'hello.txt',
      evidence: 'Get-Content hello.txt printed: hi and token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    })]),
    (m: Incoming) => {
      findingsText = m.text;
      return reply.done();
    },
    look(),
    reply.pass(),
  );
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the task is done', task.status, 'done');
  t.truthy('the message to the implementer has the token redacted', findingsText.includes('[REDACTED') && !findingsText.includes('ghp_abcdef'), findingsText.slice(0, 900));
  const kept = task.runId ? join(h.runsDir, task.runId, 'review', '1', 'findings-sent.md') : '';
  const file = kept && existsSync(kept) ? readFileSync(kept, 'utf8') : '';
  t.truthy('and so has the copy in the run folder', file.includes('[REDACTED') && !file.includes('ghp_abcdef'), file.slice(0, 900) || kept);
});

/*
 * The operator's own patterns (report.redactPatterns) hold for what goes back to a reviewer as well.
 * A check given with a finding that passes on the work is turned down with its result quoted, and
 * that result repeats the value the check looked for: a key in a company's own format, which no
 * built-in shape knows, went back to the reviewer in it.
 */
await scenario('a turned-down check goes back to the reviewer with the operator\'s patterns applied', { report: { redactPatterns: ['CORP-[0-9]{6}'] } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'ownpattern', [greeting]));
  let turnedDown = '';
  h.chat.script(
    write('hi'),
    reply.done(),
    look(),
    fail([finding({
      what: 'hello.txt does not carry the company key next to hi',
      where: 'hello.txt',
      check: { name: 'prints the key', expect: 'output-contains', run: 'Write-Output CORP-123456', value: 'CORP-123456' },
    })]),
    (m: Incoming) => {
      turnedDown = m.text;
      return reply.pass();
    },
  );
  const task = full((await h.run(s!.id)).tasks[0]!);
  t.check('the task is done', task.status, 'done');
  t.truthy('the reviewer is told its check passed on the work, without the key', turnedDown.includes('it passed') && !turnedDown.includes('CORP-123456'), turnedDown.slice(0, 900));
  const redacted = (await events(h, s!.id)).filter((e) => e.type === 'report-redacted');
  t.truthy('and the record says something was taken out of it', redacted.some((e) => e.data?.refusedChecks === true && e.data?.round === 1), redacted);
});

/*
 * Stop pressed while a reviewer's step runs. The step is cut short; the task then ends as the
 * operator stopped it — `aborted`, which "Continue" carries on — not as done. The review reports a
 * Stop the way it reports a broken browser, as a review error, and a review error accepts the work;
 * so the runner asks about the Stop before it reads the verdict. (It did not, and the stopped task
 * was closed `done` and committed.)
 */
await scenario('Stop pressed during the review', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'stopped', [greeting]));
  h.chat.script(
    write('hi'),
    reply.done(),
    // r.done is written only by a step that lives through its whole sleep. The sleep is far longer
    // than a stop takes (about 9 s: taskkill /T, the close grace, then /F), and shorter than the wait
    // for the run to go idle, so a stop that kills nothing still ends inside the scenario and fails it.
    reply.steps('New-Item r.flag -Force | Out-Null; Start-Sleep 45; New-Item r.done -Force | Out-Null'),
    // The report of the cut-short step is not sent after the stop (pinned below). A reply for it is
    // scripted all the same, so that a regression shows as that pin failing rather than as the chat
    // failing on an unscripted message, and it is discarded below when unused.
    reply.pass(),
  );
  const r = await h.call<{ started: boolean }>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  t.check('the run started', r.started, true);
  await waitFor('the reviewer\'s step to be running', async () => existsSync(join(h.repo, 'r.flag')));
  const stopAt = Date.now();
  const sentBefore = h.chat.sent.length;
  await h.call('POST', `/sessions/${s!.id}/stop`);
  await h.idle();
  const stoppedIn = (Date.now() - stopAt) / 1000;
  t.check('nothing more reached either chat after the stop', h.chat.sent.slice(sentBefore).map((m) => m.text.slice(0, 120)), []);
  h.chat.discard();
  const task = await taskNow(h, s!.id);
  const step = (await events(h, s!.id)).find((e) => e.type === 'review-step-finished');
  console.log(`      (the step ended ${String(step?.data?.outcome)}; the run was idle ${stoppedIn.toFixed(1)} s after the stop)`);
  /*
   * Not the clock (under a loaded machine the time after a stop varies) and not the step's recorded
   * outcome alone: the runner calls a step "aborted" as soon as Stop is pressed, however the process
   * later closed, so a step left to run to its end would be recorded the same way. The marker the
   * step writes only after its sleep is what tells the two apart. The runner waits for the step's
   * process to close before the run goes idle, so the marker is settled by now either way. It is
   * looked for in the commits too: a task closed done commits what its steps left behind.
   */
  const committed = h.git('log', '--all', '--format=', '--name-only').split(/\r?\n/);
  t.truthy('the reviewer\'s step was cut short by the stop, not waited out',
    !existsSync(join(h.repo, 'r.done')) && !committed.includes('r.done'), { stoppedIn, committed });
  t.check('and it is recorded as aborted', step?.data?.outcome, 'aborted');
  t.truthy('the review records that the run was stopped', /the run was stopped/.test(task.review?.problem ?? ''), task.review);
  // A review cut short by Stop is not an error that accepts the work: the task ends as Stop ends every task.
  t.check('a task stopped during its review ends aborted, not done', task.status, 'aborted');
  const cont = await h.raw('POST', `/sessions/${s!.id}/tasks/${task.id}/continue`);
  // Aborted is what "Continue" carries on.
  t.truthy('and "Continue" can carry it on', cont.status >= 200 && cont.status < 300, cont);
});

/*
 * The same Stop, as the review loop answers it on its own. The runner hands the review a chat that
 * refuses to send once the run is stopped (`sendsUntilStopped`), which hides whether the review
 * stops by itself; it did not — it uploaded the cut-short step's report and waited for the answer,
 * and only the runner's chat kept that from reaching the reviewer. Run here on the chat as it is.
 */
await scenario('Stop during a reviewer\'s last step ends the review by itself, sending nothing more', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'selfstop', [greeting]));
  // The whole record, as the API keeps it, and the settings the runner would have read.
  const session = await h.call<Session>('GET', `/sessions/${s!.id}`);
  const cfg = await loadConfigObject(JSON.parse(readFileSync(join(h.dataDir, 'settings.json'), 'utf8')), h.base);
  const chat = h.chat.factory()({} as never);
  await chat.open();
  await chat.newChat();
  const stop = new AbortController();
  h.chat.script(
    reply.steps('New-Item r.flag -Force | Out-Null; Start-Sleep 45; New-Item r.done -Force | Out-Null'),
    // The answer to the cut-short step's report, should it be sent; discarded below when unused.
    reply.pass(),
  );
  const review = runReview(chat, session, session.tasks[0]!, {
    cfg,
    authorizer: { authorize: async () => ({ action: 'run' }) },
    signal: stop.signal,
    pacer: new Pacer({ enabled: false, settleMs: 0, maxMessagesPerHour: 10_000 }),
    dir: join(h.base, 'review-selfstop'),
    round: 1,
    cwd: h.repo,
    roots: [h.repo],
    changedFiles: [],
    deviations: [],
    disputes: [],
    event: () => undefined,
    record: async () => undefined,
  });
  try {
    await waitFor('the reviewer\'s step to be running', async () => existsSync(join(h.repo, 'r.flag')));
    const sentBefore = h.chat.sent.length;
    stop.abort();
    const outcome = await review;
    t.check('nothing more was sent after the stop', h.chat.sent.slice(sentBefore).map((m) => m.text.slice(0, 120)), []);
    t.check('the answer scripted for its report was never asked for', h.chat.discard(), 1);
    t.truthy('the review ends on the stop, with no verdict', outcome.verdict === 'error' && /the run was stopped/.test(outcome.problem ?? ''), outcome);
    t.truthy('the step was cut short by the stop, not waited out', !existsSync(join(h.repo, 'r.done')), '');
  } finally {
    stop.abort();
    await review.catch(() => undefined);
    await chat.close();
  }
});

/*
 * Stop pressed after the checks have accepted the work and before the review has begun: the task
 * ends there, aborted, and no review conversation is opened for a run that was stopped. Pressed at
 * the moment the passing results are written, which is the gate's last act before it accepts.
 */
await scenario('Stop pressed once the checks have passed, before the review', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'beforereview', [greeting]));
  h.chat.script(write('hi'), reply.done());
  const original = SessionStore.prototype.updateTask;
  let armed = true;
  let sentAtStop = -1;
  SessionStore.prototype.updateTask = async function (this: SessionStore, sid: string, tid: string, mutate: Parameters<typeof original>[2]) {
    const r = await original.call(this, sid, tid, mutate);
    if (armed && (r.checkResults ?? []).length > 0 && (r.checkResults ?? []).every((c) => c.passed)) {
      armed = false;
      sentAtStop = h.chat.sent.length;
      await h.call('POST', `/sessions/${sid}/stop`);
    }
    return r;
  };
  try {
    await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
    await h.idle();
  } finally {
    SessionStore.prototype.updateTask = original;
  }
  const task = await taskNow(h, s!.id);
  t.check('the stop was pressed once the checks had passed', armed, false);
  // The reason goes on to say what the runner then committed, as for any ending that is not done.
  t.check('the task ends aborted, before the review', [task.status, (task.reason ?? '').startsWith('stopped by the operator before the review')], ['aborted', true]);
  // Two sentences, read as two: "… before the review After that, …" ran them together.
  t.truthy('and what the runner committed after it follows as a sentence of its own',
    (task.reason ?? '').includes('stopped by the operator before the review. After that, the runner committed'), task.reason);
  t.check('no review conversation was opened', reviewConversations(h), 0);
  t.check('and nothing reached the chat after the stop', h.chat.sent.slice(sentAtStop).map((m) => m.text.slice(0, 120)), []);
  const cont = await h.raw('POST', `/sessions/${s!.id}/tasks/${task.id}/continue`);
  t.truthy('and "Continue" can carry it on', cont.status >= 200 && cont.status < 300, cont);
});

/*
 * The same Stop with the review switched off, and nothing else left to judge: no checks, version
 * control off, so the checks accept at once. The chat ended with its stop word and one last step;
 * the step ran and the operator pressed Stop while the chat answered its report, as one does to stop
 * the queue after this task. There is no review to keep from opening, so the task is done, its review
 * recorded as skipped. It ended aborted "before the review", naming a review that did not exist, and
 * a batch that stops on a failure counted it as one and skipped the sessions after it.
 */
await scenario('Stop pressed with the review switched off and nothing left to judge: the task is done', {}, async (h) => {
  const plan1 = {
    version: 1,
    sessions: [{ name: 'noreview', onFailure: 'stop', vcs: { enabled: false }, projectDir: h.repo, review: { enabled: false }, tasks: [greeting] }],
  };
  const [s] = await h.importPlan(plan1);
  const summary = 'I wrote hello.txt holding the word hi, and changed nothing else in the repository.';
  const last = 'Here is my answer.\n\n```json\n' +
    JSON.stringify({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: "Set-Content -Path hello.txt -Value 'hi' -Encoding utf8" }], summary }, null, 2) +
    '\n```\nКрай\n';
  h.chat.script(last, async () => {
    await h.call('POST', `/sessions/${s!.id}/stop`);
    return reply.done();
  });
  await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  await h.idle();
  const task = await taskNow(h, s!.id);
  t.check('the step ran', readFileSync(join(h.repo, 'hello.txt'), 'utf8').trim(), 'hi');
  t.check('the task is done, not aborted before a review that is switched off', [task.status, (task.reason ?? '').includes('review')], ['done', false]);
  t.check('its review is recorded as skipped', task.review?.verdict, 'skipped');
  t.check('no review conversation was opened', reviewConversations(h), 0);
});

console.log(`\nruntime: ${((Date.now() - started) / 1000).toFixed(1)} s`);
t.finish();
