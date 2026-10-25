/**
 * Trying a subtask of two chats again (operator's specification, 2026-10-25), its rules without a browser and end to end
 * through the API with the scripted chat of test/support/fakeChat.ts:
 *
 *  1. an answer cut off with no command run: the same subtask tried again, nothing to carry on from;
 *  2. tried again by a fresh worker, told what the subtasks before it reported;
 *  3. the second attempt does it;
 *  4. no more attempts than Settings allow;
 *  5. a subtask done is not done again;
 *  6. a retry is not another planned subtask: the count stays;
 *  7. a test that really fails is not tried again by itself;
 *  8. the operator's Stop is not tried again by itself — and after it, the chosen subtask is, and the lead goes on;
 *  9. cut off after a command that changed something: that command is not run again;
 * 10. what changed not known: the operator decides, and the folder is put back only at their word;
 * 11. Settings "Ask me": a card with the choices; 12. "Do not retry, let the lead decide": no card;
 * 14. the card is there however often the page asks for it;
 * 15. a record from before there were attempts is carried on all the same.
 * (13, the attempts shown, is in test/ui-flows.check.ts.)
 *
 *   npm run check:subtask-retry
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifySubtaskEnd, describeAttempts, retryMessage, retryPlan, sanitizedReason, sideEffectsOf, stepFacts } from '../src/orchestrator/subtaskRetry.js';
import type { SubtaskAttempt } from '../src/session/model.js';
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;

console.log('--- the rules ---');
t.check('how an attempt ended, as a category', [
  classifySubtaskEnd({ status: 'done' }),
  classifySubtaskEnd({ status: 'aborted' }),
  classifySubtaskEnd({ status: 'failed', failure: { kind: 'transport', detail: 'net::ERR_CONNECTION_RESET' } }),
  classifySubtaskEnd({ status: 'limit-reached', limit: { setting: 'replyTimeoutSec', value: 900 } }),
  classifySubtaskEnd({ status: 'limit-reached', limit: { setting: 'maxFormatRetries', value: 2 } }),
  classifySubtaskEnd({ status: 'failed', stopCode: 'environment' }),
  classifySubtaskEnd({ status: 'failed' }),
  classifySubtaskEnd({ status: 'blocked' }),
  classifySubtaskEnd({ status: 'limit-reached', limit: { setting: 'maxIterations', value: 60 } }),
  classifySubtaskEnd({ status: 'failed', failure: { kind: 'transport', detail: 'x' } }, { stopped: true }),
], [null, 'USER_STOPPED', 'TRANSIENT_CHAT_FAILURE', 'TRANSIENT_CHAT_FAILURE', 'TRANSIENT_CHAT_FAILURE', 'COMMAND_INFRASTRUCTURE_FAILURE', 'TASK_EVIDENCE_FAILURE', 'TASK_EVIDENCE_FAILURE', 'TASK_EVIDENCE_FAILURE', 'USER_STOPPED']);
const step = (command: string, outcome: string, exitCode?: number) => ({ kind: 'step' as const, iteration: 1, id: 1, command, output: '', outcome, ...(exitCode !== undefined ? { exitCode } : {}), failed: outcome !== 'completed' });
const facts = stepFacts([step('a', 'completed', 0), step('b', 'refused'), step('c', 'hard-timeout'), step('d', 'spawn-error'), step('e', 'completed', 1)]);
t.check('the commands: began, finished, cut off, and what finished', [facts.started, facts.completed, facts.cutOff, facts.done.map((d) => d.command)], [3, 2, ['c'], ['a', 'e']]);
const photo = { commit: 'c1', branch: 'main', head: 'h1' } as never;
const changedVcs = { baseCommit: 'c1', commit: 'c2', files: [{ path: 'a.txt', added: 1, removed: 0 }] };
const none = stepFacts([]);
t.check('what an attempt left', [
  sideEffectsOf({ checkpoint: photo, vcs: { baseCommit: 'c1', commit: 'c2', files: [] } }, none).state,
  sideEffectsOf({ checkpoint: photo, vcs: changedVcs }, stepFacts([step('w', 'completed', 0)])).state,
  sideEffectsOf({ checkpoint: photo, vcs: changedVcs }, stepFacts([step('w', 'aborted')])).state,
  sideEffectsOf({ checkpoint: photo, vcs: changedVcs, readOnly: true }, stepFacts([step('w', 'aborted')])).state,
  sideEffectsOf({}, stepFacts([step('w', 'completed', 0)])).state,
], ['none', 'changed', 'unknown', 'changed', 'unknown']);
const plan = (category: Parameters<typeof retryPlan>[0]['category'], sideEffects: 'none' | 'changed' | 'unknown', mode: 'ask' | 'same' | 'fresh' | 'lead', attempt = 1, canAsk = true) => retryPlan({ category, sideEffects, mode, attempt, maxAttempts: 3, canAsk });
t.check('what to do next', [
  plan('TRANSIENT_CHAT_FAILURE', 'none', 'same'),
  plan('TRANSIENT_CHAT_FAILURE', 'changed', 'fresh'),
  plan('TRANSIENT_CHAT_FAILURE', 'unknown', 'same').do,
  plan('TRANSIENT_CHAT_FAILURE', 'none', 'ask').do,
  plan('TRANSIENT_CHAT_FAILURE', 'none', 'ask', 1, false).do,
  plan('TRANSIENT_CHAT_FAILURE', 'none', 'lead').do,
  plan('TRANSIENT_CHAT_FAILURE', 'none', 'same', 3).do,
  plan('COMMAND_INFRASTRUCTURE_FAILURE', 'none', 'same').do,
  plan('TASK_EVIDENCE_FAILURE', 'none', 'same').do,
  plan('USER_STOPPED', 'none', 'same').do,
], [
  { do: 'retry', choice: 'same', continued: false },
  { do: 'retry', choice: 'fresh', continued: true },
  'ask', 'ask', 'lead', 'lead', 'lead', 'ask', 'lead', 'lead',
]);
t.check('the choices on a card', [(plan('TRANSIENT_CHAT_FAILURE', 'unknown', 'same') as { choices: string[] }).choices, (plan('TRANSIENT_CHAT_FAILURE', 'none', 'ask') as { choices: string[] }).choices], [['continue', 'restore', 'accept'], ['same', 'fresh', 'accept']]);
t.check('a reason for the record: one line, no secrets', sanitizedReason('fetch failed token=abc123\nat Object.<anonymous> (x.ts:1)'), 'fetch failed token=…');
const attempts: SubtaskAttempt[] = [
  { attempt: 1, taskId: 'a', status: 'failed', category: 'TRANSIENT_CHAT_FAILURE', reason: 'net::ERR_CONNECTION_RESET', commands: { started: 0, completed: 0 }, repoChanged: false },
  { attempt: 2, taskId: 'b', status: 'done', commands: { started: 1, completed: 1 }, repoChanged: true },
];
t.check('the attempts, said to the lead', describeAttempts(attempts, 3), 'It was done at attempt 2 of 3.\n- Attempt 1: failed (a temporary failure of the chat or the browser) — net::ERR_CONNECTION_RESET.');
t.check('one attempt is not said', describeAttempts(attempts.slice(0, 1), 3), '');
const continued = retryMessage('PROMPT', { n: 4, attempt: 2, maxAttempts: 3, why: 'x', continued: true, restored: false, fresh: false, done: [{ command: 'Set-Content a', exitCode: 0 }], cutOff: [], changed: ['a.txt'], predecessors: [] });
t.truthy('carried on: what finished is not to be run again', continued.startsWith('PROMPT') && continued.includes('## Attempt 2 of 3 at subtask 4') && continued.includes('do not run them again') && continued.includes('`Set-Content a` → exit 0') && continued.includes('Files changed so far in this subtask: a.txt'), continued);

// --- end to end ---------------------------------------------------------------------------------------------------

type Attempt = SubtaskAttempt;
type Round = { n: number; status: string; subtask?: { n: number; taskId: string; title: string; attempts?: Attempt[]; maxAttempts?: number; report?: string } };
type LeadTask = { id: string; status: string; reason?: string; lead?: { rounds: Round[]; subtasks: number; maxSubtasks: number; workerSessionId?: string } };
type Sent = { threadId: string; taskId: string };
type Approval = { id: string; sessionId: string; taskId: string; retry?: { n: number; attempt: number; maxAttempts: number; category: string; sideEffects: string; choices: string[]; reason: string } };
type WorkerSession = { tasks: Array<{ id: string; title: string; status: string }> };
const ASSIGNMENT = 'Create result.txt holding the word hello, and tell me what was done.';
const WORKER_DONE = 'I wrote result.txt in the project folder and read it back: it holds exactly the word hello, as the subtask asked.';
const LEAD_DONE = 'The work is finished: the worker wrote result.txt and read it back, and it holds exactly the word hello, as the assignment asked.';
const LEAD_BLOCKED = 'The worker could not finish the subtask: its conversation failed before it reported, and nothing more could be done from here.';
const understood = { understanding: 'A file result.txt holding hello; said what was done.' };
const cutOff = (): string => {
  throw new Error('net::ERR_CONNECTION_RESET: the answer stopped coming');
};

async function scenario(title: string, limits: Record<string, unknown>, body: (h: Harness) => Promise<void>, execution: Record<string, unknown> = {}): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings: { execution: { mode: 'unattended', isolation: 'none-accepted', ...execution }, limits: { retryBlockedInFreshChat: 0, subtaskRetryWaitSec: 0, ...limits }, report: { uploadRetries: 0 } } });
  try {
    await body(h);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}
const leadTask = async (h: Harness, id: string): Promise<LeadTask> => (await h.call<{ tasks: LeadTask[] }>('GET', `/sessions/${id}`)).tasks[0]!;
const subOf = (task: LeadTask, n: number) => task.lead!.rounds.filter((r) => r.subtask?.n === n).at(-1)!.subtask!;
const workerOf = async (h: Harness, task: LeadTask): Promise<WorkerSession> => await h.call<WorkerSession>('GET', `/sessions/${task.lead!.workerSessionId}`);
const begin = async (h: Harness): Promise<Sent> => {
  const sent = await h.call<Sent>('POST', '/chat', { text: ASSIGNMENT, model: 'Think deeper', lead: true });
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  return sent;
};
const retryCard = async (h: Harness): Promise<Approval> => await waitFor('the retry card', async () => (await h.call<Approval[]>('GET', '/approvals')).find((a) => a.retry) ?? null, 30_000);

await scenario('1, 3, 6: cut off with nothing run, tried again in the same conversation, done at the second attempt', { subtaskRetryMode: 'same' }, async (h) => {
  let again = '';
  let report = '';
  const chats: string[] = [];
  h.chat.script(
    reply.lead.delegate({ title: 'Write result.txt', readOnly: false, goal: 'Create result.txt holding exactly the word hello.' }, understood),
    (m) => {
      chats.push(m.chatId);
      return cutOff();
    },
    (m) => {
      chats.push(m.chatId);
      again = m.text;
      return reply.steps(write('result.txt', 'hello'));
    },
    reply.done(WORKER_DONE),
    (m) => {
      report = m.text;
      return reply.lead.done(LEAD_DONE);
    },
  );
  const sent = await begin(h);
  await h.idle();
  const job = await leadTask(h, sent.threadId);
  const sub = subOf(job, 1);
  t.check('done; one subtask given, under one number, with two attempts', [job.status, job.lead?.subtasks, job.lead?.rounds.filter((r) => r.subtask).length, sub.attempts?.map((a) => [a.attempt, a.status, a.category ?? null, a.sideEffects])], [
    'done', 1, 1, [[1, 'failed', 'TRANSIENT_CHAT_FAILURE', 'none'], [2, 'done', null, 'changed']],
  ]);
  t.check('the second by Settings, the first\'s retry, in the same conversation', [sub.attempts?.[1]?.retryOf, sub.attempts?.[1]?.by, chats[0] === chats[1], sub.maxAttempts], [1, 'settings', true, 3]);
  t.truthy('the worker is told which attempt it is, why, and that nothing changed', again.includes('## Attempt 2 of 3 at subtask 1') && again.includes('a temporary failure of the chat or the browser') && again.includes('Nothing in the folder changed'), again.slice(-900));
  t.truthy('the lead is told it was done at the second attempt, and how the first ended', report.includes('It was done at attempt 2 of 3.') && report.includes('- Attempt 1: failed (a temporary failure of the chat or the browser)'), report.slice(0, 900));
  t.check('the worker\'s tasks: one an attempt', (await workerOf(h, job)).tasks.map((x) => [x.title, x.status]), [['1. Write result.txt', 'failed'], ['1. Write result.txt (attempt 2)', 'done']]);
});

await scenario('2, 5: a fresh worker, told what the subtask before reported; the subtask done is not done again', { subtaskRetryMode: 'fresh' }, async (h) => {
  let again = '';
  let againChat = '';
  let firstChat = '';
  h.chat.script(
    reply.lead.delegate({ title: 'Survey the project', readOnly: true }, understood),
    (m) => {
      firstChat = m.chatId;
      return reply.steps('Get-ChildItem -Name');
    },
    reply.done('I listed the project folder with Get-ChildItem: it holds README.md at its root and nothing else that the assignment names.'),
    reply.lead.delegate({ title: 'Write result.txt', readOnly: false, goal: 'Create result.txt holding exactly the word hello.' }),
    cutOff,
    (m) => {
      again = m.text;
      againChat = m.chatId;
      return reply.steps(write('result.txt', 'hello'));
    },
    reply.done(WORKER_DONE),
    reply.lead.done(LEAD_DONE),
  );
  const sent = await begin(h);
  await h.idle();
  const job = await leadTask(h, sent.threadId);
  t.check('two subtasks given; the second at its second attempt, by a fresh worker', [job.status, job.lead?.subtasks, subOf(job, 2).attempts?.map((a) => [a.status, a.fresh ?? false])], ['done', 2, [['failed', false], ['done', true]]]);
  t.truthy('in a conversation of its own', againChat !== '' && againChat !== firstChat, { againChat, firstChat });
  t.truthy('told it is fresh, with the first subtask\'s report, and not to redo it', again.includes('This is a fresh conversation') && again.includes('### Subtask 1: Survey the project') && again.includes('README.md') && again.includes('the ones done are not to be done again'), again.slice(-1400));
  t.check('the subtask done was done once', (await workerOf(h, job)).tasks.filter((x) => x.title.startsWith('1. ')).length, 1);
});

await scenario('4: no more attempts than Settings allow', { subtaskRetryMode: 'same', subtaskRetries: 1 }, async (h) => {
  let report = '';
  h.chat.script(
    reply.lead.delegate({ title: 'Write result.txt', readOnly: false, goal: 'Create result.txt holding exactly the word hello.' }, understood),
    cutOff,
    cutOff,
    (m) => {
      report = m.text;
      return reply.lead.blocked('The worker\'s chat failed twice; nothing was written.', 'a working chat');
    },
  );
  const sent = await begin(h);
  await h.idle();
  const job = await leadTask(h, sent.threadId);
  t.check('two attempts, both failed; then the lead', [subOf(job, 1).attempts?.map((a) => a.status), subOf(job, 1).maxAttempts, job.status], [['failed', 'failed'], 2, 'blocked']);
  t.truthy('the lead is told it ended at the last attempt', report.includes('It ended at attempt 2 of 2.') && report.includes('It ended for this reason: a temporary failure of the chat or the browser.'), report.slice(0, 700));
});

await scenario('7: a test that really fails is not tried again: the lead decides', { subtaskRetryMode: 'same' }, async (h) => {
  let report = '';
  h.chat.script(
    reply.lead.delegate({ title: 'Run the tests', readOnly: false, goal: 'Run the tests and report.' }, understood),
    reply.steps("Write-Output 'FAIL: 1 test failed'; exit 1"),
    reply.blocked('The tests fail: 1 test failed, and it is not something I can fix here.'),
    (m) => {
      report = m.text;
      return reply.lead.blocked(LEAD_BLOCKED, 'a working chat for the worker');
    },
  );
  const sent = await begin(h);
  await h.idle();
  const job = await leadTask(h, sent.threadId);
  t.check('one attempt, the work\'s own ending; no card', [subOf(job, 1).attempts?.map((a) => [a.status, a.category]), (await h.call<Approval[]>('GET', '/approvals')).length], [[['blocked', 'TASK_EVIDENCE_FAILURE']], 0]);
  t.truthy('the lead is told it was the work itself', report.includes('It ended for this reason: the work itself.'), report.slice(0, 500));
});

await scenario('8: Stop is not tried again by itself; after it, the chosen subtask is, under its number, and the lead goes on', { subtaskRetryMode: 'same' }, async (h) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  h.chat.script(
    reply.lead.delegate({ title: 'Write result.txt', readOnly: false, goal: 'Create result.txt holding exactly the word hello.' }, understood),
    async () => {
      await held;
      return reply.steps(write('result.txt', 'hello'));
    },
  );
  const sent = await begin(h);
  await waitFor('the worker to be answering', async () => h.chat.pending === 0, 20_000);
  await h.call('POST', `/sessions/${sent.threadId}/stop`, {});
  release();
  await h.idle();
  const stopped = await leadTask(h, sent.threadId);
  t.check('stopped: one attempt, the operator\'s; not tried again', [stopped.status, subOf(stopped, 1).attempts?.map((a) => [a.status, a.category]), (await workerOf(h, stopped)).tasks.length], ['aborted', [['aborted', 'USER_STOPPED']], 1]);
  t.check('a subtask done, or not there, is refused', [(await h.raw('POST', `/chat/${sent.threadId}/tasks/${stopped.id}/retry-subtask`, { n: 7 })).status], [400]);

  let again = '';
  let toLead = '';
  h.chat.script(
    (m) => {
      again = m.text;
      return reply.steps(write('result.txt', 'hello'));
    },
    reply.done(WORKER_DONE),
    (m) => {
      toLead = m.text;
      return reply.lead.done(LEAD_DONE);
    },
  );
  const started = await h.call<{ started: boolean }>('POST', `/chat/${sent.threadId}/tasks/${stopped.id}/retry-subtask`, { n: 1 });
  t.check('"try it again" after the Stop starts the conversation', started.started, true);
  await h.idle();
  const job = await leadTask(h, sent.threadId);
  const sub = subOf(job, 1);
  t.check('done; the same subtask, its stopped attempt kept, the second after the Stop', [job.status, job.lead?.subtasks, sub.n, sub.attempts?.map((a) => [a.attempt, a.status, a.by ?? null])], ['done', 1, 1, [[1, 'aborted', null], [2, 'done', 'after-stop']]]);
  t.truthy('the worker carries on from the folder as it is, at attempt 2', again.includes('## Attempt 2 of 3 at subtask 1') && again.includes('Carry on from the folder'), again.slice(-700));
  t.truthy('the lead is told to continue, with that subtask\'s report under its own number', toLead.startsWith('Continue assignment 1:') && toLead.includes('the operator had subtask 1 tried again after the Stop') && toLead.includes('Report of subtask 1 (Write result.txt): done.'), toLead.slice(0, 900));
  t.check('result.txt written once', readFileSync(join(h.repo, 'result.txt'), 'utf8').trim(), 'hello');
});

await scenario('9: cut off after a command that changed something: the next attempt carries on and does not run it again', { subtaskRetryMode: 'same' }, async (h) => {
  let again = '';
  h.chat.script(
    reply.lead.delegate({ title: 'Write result.txt', readOnly: false, goal: 'Create result.txt holding exactly the word hello.' }, understood),
    reply.steps(write('result.txt', 'hello')),
    // The report cut off, and its resend as text too (runTask's own second try).
    cutOff,
    cutOff,
    (m) => {
      again = m.text;
      return reply.steps('Get-Content result.txt');
    },
    reply.done(WORKER_DONE),
    reply.lead.done(LEAD_DONE),
  );
  const sent = await begin(h);
  await h.idle();
  const job = await leadTask(h, sent.threadId);
  const [first, second] = subOf(job, 1).attempts!;
  t.check('the first changed the folder by a command that finished; the second carried on', [first?.sideEffects, first?.repoChanged, first?.commands, second?.continued, second?.status], ['changed', true, { started: 1, completed: 1 }, true, 'done']);
  t.truthy('told what finished, not to run it again, and what changed', again.includes('Carry on from the folder') && again.includes('do not run them again') && again.includes("Set-Content -Path result.txt -Value 'hello'") && again.includes('Files changed so far in this subtask: result.txt'), again.slice(-900));
  // The second ran only the read it was given; the write ran once, in the first.
  t.check('the write ran once: the second attempt only read', [first?.commands.completed, second?.commands], [1, { started: 1, completed: 1 }]);
});

await scenario('10, 14: what changed not known: a card, kept however often it is read; the folder put back at the operator\'s word', { subtaskRetryMode: 'same' }, async (h) => {
  let again = '';
  h.chat.script(
    reply.lead.delegate({ title: 'Write result.txt', readOnly: false, goal: 'Create result.txt holding exactly the word hello.' }, understood),
    reply.steps({ cmd: "Set-Content -Path partial.txt -Value 'half'; Start-Sleep -Seconds 30", expect: 'fast' }),
    cutOff,
    cutOff,
    (m) => {
      again = m.text;
      return reply.steps(write('result.txt', 'hello'));
    },
    reply.done(WORKER_DONE),
    reply.lead.done(LEAD_DONE),
  );
  const sent = await begin(h);
  const card = await retryCard(h);
  t.check('a card: the subtask, the attempt, what changed not known, and the choices', [card.retry?.n, card.retry?.attempt, card.retry?.maxAttempts, card.retry?.category, card.retry?.sideEffects, card.retry?.choices], [1, 1, 3, 'UNKNOWN_SIDE_EFFECT_STATE', 'unknown', ['continue', 'restore', 'accept']]);
  t.check('not put back by itself', existsSync(join(h.repo, 'partial.txt')), true);
  t.check('read again, the card is still there', (await h.call<Approval[]>('GET', '/approvals')).filter((a) => a.retry).map((a) => a.id), [card.id]);
  t.check('a choice not of the card is refused', (await h.raw('POST', `/approvals/${card.id}/retry`, { choice: 'same' })).status, 400);
  await h.call('POST', `/approvals/${card.id}/retry`, { choice: 'restore' });
  await h.idle();
  const job = await leadTask(h, sent.threadId);
  t.check('put back to the subtask\'s start, then done', [existsSync(join(h.repo, 'partial.txt')), subOf(job, 1).attempts?.map((a) => [a.status, a.category ?? null, a.restored ?? false, a.by ?? null]), job.status], [
    false, [['failed', 'UNKNOWN_SIDE_EFFECT_STATE', false, null], ['done', null, true, 'operator']], 'done',
  ]);
  t.truthy('the worker is told the folder was put back, to start over', again.includes('The folder was put back to how it was when the subtask began'), again.slice(-700));
}, { commandTimeoutSec: 2, idleTimeoutSec: 2 });

await scenario('11: "Ask me": a card with the same, a fresh worker, or failed; failed goes to the lead', { subtaskRetryMode: 'ask' }, async (h) => {
  let report = '';
  h.chat.script(
    reply.lead.delegate({ title: 'Write result.txt', readOnly: false, goal: 'Create result.txt holding exactly the word hello.' }, understood),
    cutOff,
    (m) => {
      report = m.text;
      return reply.lead.blocked('The worker\'s chat failed; nothing was written.', 'a working chat');
    },
  );
  const sent = await begin(h);
  const card = await retryCard(h);
  t.check('the card\'s choices, at attempt 1 of 3', [card.retry?.choices, card.retry?.attempt, card.retry?.category], [['same', 'fresh', 'accept'], 1, 'TRANSIENT_CHAT_FAILURE']);
  await h.call('POST', `/approvals/${card.id}/retry`, { choice: 'accept' });
  await h.idle();
  const job = await leadTask(h, sent.threadId);
  t.check('taken as failed: one attempt, then the lead', [subOf(job, 1).attempts?.length, job.status], [1, 'blocked']);
  t.truthy('the lead is told why it ended', report.includes('It ended for this reason: a temporary failure of the chat or the browser.'), report.slice(0, 500));
});

await scenario('12: "Do not retry, let the lead decide": no card, the report to the lead', { subtaskRetryMode: 'lead' }, async (h) => {
  h.chat.script(
    reply.lead.delegate({ title: 'Write result.txt', readOnly: false, goal: 'Create result.txt holding exactly the word hello.' }, understood),
    cutOff,
    reply.lead.blocked('The worker\'s chat failed; nothing was written.', 'a working chat'),
  );
  const sent = await begin(h);
  await h.idle();
  const job = await leadTask(h, sent.threadId);
  t.check('one attempt, no card, the lead decided', [subOf(job, 1).attempts?.length, (await h.call<Approval[]>('GET', '/approvals')).length, job.status], [1, 0, 'blocked']);
});

await scenario('15: a record from before there were attempts is tried again all the same', { subtaskRetryMode: 'same' }, async (h) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  h.chat.script(
    reply.lead.delegate({ title: 'Write result.txt', readOnly: false, goal: 'Create result.txt holding exactly the word hello.' }, understood),
    async () => {
      await held;
      return reply.steps(write('result.txt', 'hello'));
    },
  );
  const sent = await begin(h);
  await waitFor('the worker to be answering', async () => h.chat.pending === 0, 20_000);
  await h.call('POST', `/sessions/${sent.threadId}/stop`, {});
  release();
  await h.idle();
  const stopped = await leadTask(h, sent.threadId);
  // As an older version wrote it: the subtask with no attempts and no most.
  await h.ops.store.updateTask(sent.threadId, stopped.id, (t2) => {
    for (const r of t2.lead?.rounds ?? []) if (r.subtask) {
      delete r.subtask.attempts;
      delete r.subtask.maxAttempts;
    }
  });
  h.chat.script(reply.steps(write('result.txt', 'hello')), reply.done(WORKER_DONE), reply.lead.done(LEAD_DONE));
  await h.call('POST', `/chat/${sent.threadId}/tasks/${stopped.id}/retry-subtask`, { n: 1 });
  await h.idle();
  const job = await leadTask(h, sent.threadId);
  t.check('carried on: its one attempt as the record had it, then the second', [job.status, subOf(job, 1).attempts?.map((a) => [a.attempt, a.status])], ['done', [[1, 'aborted'], [2, 'done']]]);
});

t.finish();
