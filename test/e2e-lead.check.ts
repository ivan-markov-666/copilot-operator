/**
 * The two-chat mode (operator, 2026-10-20: "chat A takes the whole task, breaks it into steps, checks that it understands
 * it, and directs; chat B carries out the small technical tasks and reports back; the browser is not closed between
 * the two"), end to end through the API with the scripted chat of test/support/fakeChat.ts:
 *
 * - the lead's conversation gets the lead's contract and the assignment, with what the runner tells it (the folder,
 *   how many subtasks it may give); its first reply must restate the assignment, and a reply in the wrong shape is sent
 *   back with the reason;
 * - a subtask goes to the worker's conversation, in the same window, as a task of the worker's session — hidden from
 *   the chat's list — with the level 1 contract the first time and not again; a read-only subtask is held to it;
 * - the worker's report goes back to the lead: its summary, the commands it ran with their exit codes, the files it
 *   changed, how many subtasks are left; the worker keeps its conversation, unless the lead asks for a fresh one;
 * - the plan is on record, approved by the operator when plan mode asks for it, sent back for another when asked;
 * - the lead's question waits for the operator's answer, which reaches the lead; Stop on it stops the task;
 * - the worker's commands are asked about under the lead's conversation when the run asks, and "run the rest without
 *   asking" there switches the whole run;
 * - the result is the message's summary, an object written out as its fields; the folder's changes are the message's;
 * - the subtask limit, Stop while the worker works, and the operator's notes while it works.
 *
 *   npm run check:e2e-lead
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;

type Sent = { threadId: string; taskId: string };
type Round = { n: number; status: string; understanding?: string; notes?: string; subtask?: { n: number; taskId: string; title: string; readOnly?: boolean; fresh?: boolean }; question?: { text: string; answer?: string; options?: string[] } };
type LeadTask = {
  id: string;
  status: string;
  summary?: string;
  reason?: string;
  plan?: { version: number; approved?: { by: string; note?: string }; steps: string[] };
  lead?: { rounds: Round[]; subtasks: number; maxSubtasks: number; evidence?: string[]; workerSessionId?: string };
  attempts?: Array<{ status: string; lead?: { rounds: Round[]; subtasks: number; maxSubtasks: number } }>;
  vcs?: { files?: Array<{ path: string }> };
};
type LeadSession = { id: string; lead?: { workerSessionId?: string }; review?: { enabled: boolean }; planMode?: string; tasks: LeadTask[] };
type WorkerSession = { id: string; kind?: string; workerOf?: string; chat?: { chatId: string }; tasks: Array<{ id: string; title: string; status: string; readOnly?: boolean; prompt: string; summary?: string; fromLead?: { taskId: string; n: number } }> };
type Approval = { id: string; sessionId: string; taskId: string; question?: { text: string; options: string[] }; plan?: unknown; description: string };

const ASSIGNMENT = 'Create result.txt holding the word hello, and tell me in the fields Title and Result what was done.';

async function scenario(title: string, settings: Record<string, unknown>, body: (h: Harness) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings });
  try {
    await body(h);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

const sessionOf = async (h: Harness, id: string): Promise<LeadSession> => await h.call<LeadSession>('GET', `/sessions/${id}`);
const workerOf = async (h: Harness, id: string): Promise<WorkerSession> => await h.call<WorkerSession>('GET', `/sessions/${(await sessionOf(h, id)).lead?.workerSessionId}`);

await scenario('the whole of it: understood, surveyed, planned, done by the worker, delivered in the form asked', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: ASSIGNMENT, model: 'Think deeper', lead: true });
  const made = await sessionOf(h, sent.threadId);
  t.check('a conversation with a lead: no review of its own (the lead judges)', [!!made.lead, made.review?.enabled], [true, false]);
  let report1 = '';
  let report2 = '';
  let workerFirst = '';
  h.chat.script(
    reply.lead.delegate({ title: 'Survey the project', readOnly: true }, { understanding: 'Goal: a file result.txt holding hello. Result: the fields Title and Result. Done when the file is there and read back.', notes: 'I start by looking at what is there.', todo: [{ title: 'Survey the project', status: 'running', phase: 'Survey' }, { title: 'Plan the work', status: 'planned', phase: 'Plan' }] }),
    (m) => {
      workerFirst = m.text;
      return reply.steps('Get-ChildItem -Name');
    },
    reply.done('The project folder holds README.md at its root, and nothing else that the assignment names.'),
    (m) => {
      report1 = m.text;
      return reply.lead.plan({}, { notes: 'The survey found only the README; the plan is short.', todo: [{ title: 'Survey the project', status: 'completed', phase: 'Survey' }, { title: 'Write result.txt', status: 'pending', phase: 'Work' }, { title: 'Read it back', phase: 'Verification' }] });
    },
    reply.lead.delegate({ title: 'Write result.txt', goal: 'Create result.txt at the root holding exactly the word hello.', readOnly: false, report: 'The command that wrote it and what Get-Content prints for the file.' }, { todo: [{ title: 'Survey the project', status: 'done', phase: 'Survey' }, { title: 'write result.txt', status: 'planned', phase: 'Work' }, { title: 'Read it back', status: 'planned', phase: 'Verification' }, { title: 'Check the README does not need it', status: 'planned', phase: 'Verification' }] }),
    reply.steps(write('result.txt', 'hello'), 'Get-Content result.txt'),
    reply.done('I wrote result.txt with Set-Content and read it back: Get-Content prints hello, exactly as asked.'),
    (m) => {
      report2 = m.text;
      return reply.lead.done({ Title: 'result.txt written', Result: 'result.txt holds hello, read back by the worker.' }, ['result.txt', 'Get-Content result.txt → hello']);
    },
  );
  t.check('it starts', (await h.call<{ started: boolean }>('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' })).started, true);
  await h.idle();

  const lead = await sessionOf(h, sent.threadId);
  const job = lead.tasks[0]!;
  t.check('done, with the result as its summary: an object written out as its fields', [job.status, job.summary], ['done', '**Title**: result.txt written\n**Result**: result.txt holds hello, read back by the worker.']);
  t.check('the lead\'s rounds, as it decided them', job.lead?.rounds.map((r) => r.status), ['delegate', 'plan', 'delegate', 'done']);
  t.truthy('its understanding of the assignment is on the first round', (job.lead?.rounds[0]?.understanding ?? '').includes('result.txt holding hello'), job.lead?.rounds[0]);
  t.check('two subtasks of twenty, the evidence kept', [job.lead?.subtasks, job.lead?.maxSubtasks, job.lead?.evidence], [2, 20, ['result.txt', 'Get-Content result.txt → hello']]);
  t.check('the plan on record, approved by the runner (plans not put to the operator here)', [job.plan?.version, job.plan?.approved?.by], [1, 'auto']);
  t.check('the work is done: result.txt holds hello', existsSync(join(h.repo, 'result.txt')) ? readFileSync(join(h.repo, 'result.txt'), 'utf8').trim() : null, 'hello');
  t.truthy('and the message\'s changes are the whole of it', (job.vcs?.files ?? []).some((f) => f.path === 'result.txt'), job.vcs);

  // The two conversations, in one window.
  const lead1 = h.chat.sent.filter((m) => m.contract === 'lead');
  t.check('the lead got its contract once', lead1.length, 1);
  const leadChat = lead1[0]!.chatId;
  const assignment = h.chat.sent.find((m) => m.chatId === leadChat && m.text.includes(ASSIGNMENT));
  t.truthy('then the assignment, with what the runner tells it', !!assignment && assignment.text.includes('at most 20 subtask(s)') && assignment.text.includes(h.repo), assignment?.text.slice(0, 600));
  const worker = await workerOf(h, sent.threadId);
  t.check('the worker is a session of its own, of the lead\'s', [worker.kind, worker.workerOf], ['chat', sent.threadId]);
  t.check('and not a conversation of the chat\'s list', (await h.call<Array<{ id: string }>>('GET', '/chat/threads')).map((x) => x.id), [sent.threadId]);
  t.check('its subtasks, in order, each the lead\'s', worker.tasks.map((x) => [x.title, x.status, x.fromLead?.n, x.fromLead?.taskId]), [['1. Survey the project', 'done', 1, job.id], ['2. Write result.txt', 'done', 2, job.id]]);
  t.check('the survey was held to changing nothing; the writing was not', worker.tasks.map((x) => !!x.readOnly), [true, false]);
  t.truthy('the worker was told where the subtask comes from and what to report', workerFirst.includes('subtask 1 of a larger assignment') && workerFirst.includes('The files at the root, one per line.'), workerFirst.slice(0, 700));
  const workerChats = [...new Set(h.chat.sent.filter((m) => m.chatId !== leadChat).map((m) => m.chatId))];
  t.check('one worker conversation for both subtasks, with the level 1 contract once', [workerChats.length, h.chat.sent.filter((m) => m.contract === 'task').length], [1, 1]);
  const order = h.chat.sent.filter((m) => !m.contract).map((m) => (m.chatId === leadChat ? 'lead' : 'worker'));
  const turns = order.filter((x, i) => i === 0 || x !== order[i - 1]);
  t.check('the window went from one conversation to the other and back', turns, ['lead', 'worker', 'lead', 'worker', 'lead']);
  t.check('and it was one window throughout', h.chat.windows.length, 1);
  // How many messages went to each chat, and in all (operator, 2026-10-21): as the window counted them.
  const counted = (await sessionOf(h, sent.threadId)).tasks[0]?.lead as unknown as { messages?: { lead: number; worker: number } } | undefined;
  const toLead = h.chat.sent.filter((m) => m.chatId === leadChat).length;
  const toWorker = h.chat.sent.filter((m) => m.chatId !== leadChat).length;
  t.check('the messages of each chat are counted, as the window sent them', [counted?.messages?.lead, counted?.messages?.worker], [toLead, toWorker]);
  // The operator's repository: the chat's, with no version control of the bot's own — the worker's neither.
  const git = (...args: string[]): string => execFileSync('git', ['-C', h.repo, ...args], { encoding: 'utf8' }).trim();
  t.check('the repository stays on its branch, with no branch of the worker\'s and no commit', [git('rev-parse', '--abbrev-ref', 'HEAD'), git('branch', '--list', 'cop/*'), git('rev-list', '--count', 'HEAD')], ['main', '', '1']);

  // The reports.
  t.truthy('the report: how it ended, the worker\'s summary, the command and its exit code, what is left', report1.startsWith('Report of subtask 1 (Survey the project): done.') && report1.includes('README.md at its root') && report1.includes('`Get-ChildItem -Name` → 0') && report1.includes('It changed no file.') && report1.includes('Subtasks left: 19 of 20.'), report1);
  t.truthy('the second names the file it changed', report2.includes('Files it changed: result.txt.') && report2.includes('Subtasks left: 18 of 20.'), report2);

  /*
   * The lead's list of subtasks (operator's feedback, 2026-10-21: "1 of 20" read as twenty planned): kept as it sent it,
   * the one given now running whatever its spelling there, a new version when subtasks come or go, what changed kept on
   * the round, the one it delivered on done; and given back to it with every report.
   */
  type Ledger = { revision: number; items: Array<{ title: string; status: string; phase?: string; n?: number }>; added?: string[]; removed?: string[] };
  const ledger = (job.lead as unknown as { ledger?: Ledger }).ledger;
  t.check(
    'the list as the lead sent it last, the subtask it delivered on done',
    ledger?.items.map((i) => [i.title, i.status, i.phase ?? null, i.n ?? null]),
    [['Survey the project', 'done', 'Survey', 1], ['write result.txt', 'done', 'Work', 2], ['Read it back', 'planned', 'Verification', null], ['Check the README does not need it', 'planned', 'Verification', null]],
  );
  t.check(
    'a version a change, what it added and dropped on the round it changed in',
    job.lead?.rounds.map((r) => (r as Round & { ledger?: { revision: number; added: number; removed: number; total: number } }).ledger ?? null),
    [{ revision: 1, added: 2, removed: 0, total: 2 }, { revision: 2, added: 2, removed: 1, total: 3 }, { revision: 3, added: 1, removed: 0, total: 4 }, null],
  );
  t.check('the last change kept on the list', [ledger?.revision, ledger?.added, ledger?.removed ?? []], [3, ['Check the README does not need it'], []]);
  t.truthy(
    'the report gives the lead its list back, with what to do with it',
    report1.includes('Your list of subtasks (version 1): 0 done, 1 running, 1 planned. Subtasks given so far: 1; at most 20 may be given.') && report1.includes('1. [running] Survey the project — Survey') && report1.includes('Send the whole list again'),
    report1,
  );
  t.truthy('the second, the list as the plan changed it', report2.includes('Your list of subtasks (version 3): 1 done, 1 running, 2 planned') && report2.includes('2. [running] write result.txt — Work'), report2);
});

await scenario('a subtask without the list of subtasks is sent back for it, and nothing of it runs', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: ASSIGNMENT, model: 'Think deeper', lead: true });
  let askedAgain = '';
  h.chat.script(
    reply.lead.delegate({ title: 'Survey the project' }, { understanding: 'A file result.txt holding hello, reported in two fields.', todo: null }),
    (m) => {
      askedAgain = m.text;
      return reply.lead.blocked('Nothing was done yet: I was asked for my list of subtasks again and stop here, as this check needs.', 'nothing; this is a check', { understanding: 'A file result.txt holding hello, reported in two fields.' });
    },
  );
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  await h.idle();
  t.truthy('sent back with the reason: the list, and its shape', askedAgain.includes('did not match the lead\'s format') && askedAgain.includes('"todo"') && askedAgain.includes('"running"'), askedAgain.slice(0, 900));
  const job = (await sessionOf(h, sent.threadId)).tasks[0]!;
  t.check('and no subtask was given for it', [job.lead?.subtasks, job.lead?.rounds.map((r) => r.status)], [0, ['blocked']]);
});

await scenario('the operator: a question answered, a plan sent back and then approved, a stop at the result', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: ASSIGNMENT, model: 'Think deeper', lead: true, planMode: true });
  let afterAnswer = '';
  let afterRevise = '';
  let afterApprove = '';
  h.chat.script(
    reply.lead.ask('Which folder do you mean: the old one or the new one?', ['the old one', 'the new one'], { understanding: 'A file result.txt holding hello, reported in two fields.' }),
    (m) => {
      afterAnswer = m.text;
      return reply.lead.plan({ steps: ['write the file in the old folder'] });
    },
    (m) => {
      afterRevise = m.text;
      return reply.lead.plan({ steps: ['write the file in the new folder', 'read it back'] });
    },
    (m) => {
      afterApprove = m.text;
      return reply.lead.blocked('The plan is approved, but the new folder does not exist on this machine, so nothing was written.', 'the new folder, created by the operator');
    },
  );
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  const question = await waitFor('the lead\'s question', async () => (await h.call<Approval[]>('GET', `/approvals?session=${sent.threadId}`)).find((a) => a.question) ?? null, 20_000);
  t.check('it waits for the operator, though nothing else asks', [question.question?.text, question.question?.options], ['Which folder do you mean: the old one or the new one?', ['the old one', 'the new one']]);
  t.check('an empty answer is refused', (await h.raw('POST', `/approvals/${question.id}/answer`, { text: '  ' })).status, 400);
  await h.call('POST', `/approvals/${question.id}/answer`, { text: 'the new one' });
  const plan1 = await waitFor('the first plan', async () => (await h.call<Approval[]>('GET', `/approvals?session=${sent.threadId}`)).find((a) => a.plan) ?? null, 20_000);
  t.truthy('the answer reached the lead', afterAnswer.startsWith('The operator answers your question:') && afterAnswer.includes('the new one'), afterAnswer);
  await h.call('POST', `/approvals/${plan1.id}/plan`, { action: 'revise', note: 'Use the new folder.' });
  const plan2 = await waitFor('the second plan', async () => (await h.call<Approval[]>('GET', `/approvals?session=${sent.threadId}`)).find((a) => a.plan && a.id !== plan1.id) ?? null, 20_000);
  t.truthy('sent back with what to change', afterRevise.includes('asks for another') && afterRevise.includes('Use the new folder.'), afterRevise);
  await h.call('POST', `/approvals/${plan2.id}/plan`, { action: 'approve', note: 'Read it back twice.' });
  await h.idle();
  t.truthy('approved, with the operator\'s note', afterApprove.startsWith('The operator approved your plan.') && afterApprove.includes('Read it back twice.'), afterApprove);
  const job = (await sessionOf(h, sent.threadId)).tasks[0]!;
  t.check('the lead stopped: blocked, with what it found and what would let it go on', [job.status, job.summary?.startsWith('The plan is approved'), job.reason], ['blocked', true, 'the lead could not take it further: the new folder, created by the operator']);
  t.check('the question and its answer, on its round', job.lead?.rounds[0]?.question?.answer, 'the new one');
  t.check('the plan: version 2, approved by the operator with the note', [job.plan?.version, job.plan?.approved?.by, job.plan?.approved?.note], [2, 'operator', 'Read it back twice.']);

  // Stop at the question.
  const again = await h.call<Sent>('POST', '/chat', { text: 'Another assignment for the lead.', threadId: sent.threadId });
  h.chat.script(reply.lead.ask('Should the old folder be deleted?', [], { understanding: 'Another assignment, unclear about deleting.' }));
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  const q2 = await waitFor('the second question', async () => (await h.call<Approval[]>('GET', `/approvals?session=${sent.threadId}`)).find((a) => a.question) ?? null, 20_000);
  const before = h.chat.exchanged.length;
  await h.call('POST', `/approvals/${q2.id}`, { action: 'abort' });
  await h.idle();
  const second = (await sessionOf(h, sent.threadId)).tasks.find((x) => x.id === again.taskId);
  t.check('stopped at the question: aborted, nothing more sent', [second?.status, h.chat.exchanged.length], ['aborted', before]);
  t.truthy('the second assignment went into the same conversation, without the contract again', h.chat.sent.filter((m) => m.contract === 'lead').length === 1 && h.chat.sent.some((m) => m.text.startsWith('New assignment in this same conversation.')), '');
});

await scenario('asked before each command: the worker\'s steps wait under the lead\'s conversation, "run the rest" switches the run', { execution: { mode: 'confirm', isolation: 'none-accepted' } }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: ASSIGNMENT, model: 'Think deeper', lead: true });
  h.chat.script(
    reply.lead.delegate({ title: 'Write result.txt', goal: 'Create result.txt holding exactly the word hello.', readOnly: false }, { understanding: 'A file result.txt holding hello.' }),
    reply.steps(write('result.txt', 'hello')),
    reply.steps('Get-Content result.txt'),
    reply.done('I wrote result.txt and read it back with Get-Content: it prints hello, exactly as asked.'),
    reply.lead.done('The worker wrote result.txt holding hello and read it back; nothing else was changed in the folder.'),
  );
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'confirm' });
  const step = await waitFor('the worker\'s step', async () => (await h.call<Approval[]>('GET', `/approvals?session=${sent.threadId}`)).find((a) => !a.question && !a.plan && !(a as { model?: unknown }).model) ?? null, 20_000);
  const worker = await workerOf(h, sent.threadId);
  t.check('asked under the lead\'s conversation, as the worker\'s', [step.sessionId, step.description.includes('Set-Content')], [worker.id, true]);
  await h.call('POST', `/approvals/${step.id}`, { action: 'run-all' });
  await h.idle();
  const job = (await sessionOf(h, sent.threadId)).tasks[0]!;
  t.check('"run the rest without asking" switched the whole run: the next step ran unasked, and it is done', [job.status, existsSync(join(h.repo, 'result.txt'))], ['done', true]);
});

await scenario('limits and conversations: the subtasks run out, a fresh worker, the wrong format, a note while it works', { execution: { mode: 'unattended', isolation: 'none-accepted' }, limits: { maxSubtasks: 2 } }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: ASSIGNMENT, model: 'Think deeper', lead: true });
  let formatBack = '';
  let understandingBack = '';
  let none = '';
  let noted = '';
  let fresh = '';
  h.chat.script(
    reply.prose('I will get on with it.'),
    (m) => {
      formatBack = m.text;
      return reply.lead.delegate({ title: 'Survey the project' });
    },
    (m) => {
      understandingBack = m.text;
      return reply.lead.delegate({ title: 'Survey the project' }, { understanding: 'A file result.txt holding hello.' });
    },
    reply.steps('Get-ChildItem -Name'),
    async () => {
      // A note of the operator's while the worker works: it goes to the lead with its next message.
      await h.call('POST', '/chat', { text: 'Use UTF-8 for the file.', threadId: sent.threadId });
      return reply.done('The project folder holds README.md at its root, and nothing else that the assignment names.');
    },
    (m) => {
      noted = m.text;
      return reply.lead.delegate({ title: 'Write result.txt', goal: 'Create result.txt holding exactly the word hello.', readOnly: false, freshWorker: true, context: 'The folder has only README.md.' });
    },
    (m) => {
      fresh = m.chatId;
      return reply.steps(write('result.txt', 'hello'));
    },
    reply.done('I wrote result.txt with Set-Content; it holds hello, exactly as the subtask asked.'),
    reply.lead.delegate({ title: 'Read it back' }),
    (m) => {
      none = m.text;
      return reply.lead.done('The worker wrote result.txt holding hello; the read-back could not be given as a subtask, none was left.');
    },
  );
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  await h.idle();
  const job = (await sessionOf(h, sent.threadId)).tasks[0]!;
  t.truthy('a reply not in the format: sent back with the reason', formatBack.includes('did not match the lead\'s format') && formatBack.includes('no fenced json'), formatBack.slice(0, 300));
  t.truthy('a first reply without the assignment restated: asked for it', understandingBack.startsWith('Before anything else, restate the assignment in "understanding"'), understandingBack.slice(0, 200));
  t.truthy('the operator\'s note reached the lead with the report', noted.includes('Use UTF-8 for the file.') && noted.startsWith('Report of subtask 1'), noted.slice(-600));
  const leadChat = h.chat.sent.find((m) => m.contract === 'lead')!.chatId;
  const workerChats = [...new Set(h.chat.sent.filter((m) => m.chatId !== leadChat).map((m) => m.chatId))];
  t.check('a fresh worker for the second subtask: a second conversation, with the contract again', [workerChats.length, workerChats[1] === fresh, h.chat.sent.filter((m) => m.contract === 'task').length], [2, true, 2]);
  t.truthy('no subtask left: the lead is told, and nothing more goes to the worker', none.startsWith('No subtask is left: all 2') && job.lead?.subtasks === 2, none);
  t.check('it ended done, with what it had', job.status, 'done');
});

await scenario('Stop while the worker works: the subtask and the message stop, nothing more is sent', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: ASSIGNMENT, model: 'Think deeper', lead: true });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  h.chat.script(
    reply.lead.delegate({ title: 'Write result.txt', readOnly: false, goal: 'Create result.txt holding exactly the word hello.' }, { understanding: 'A file result.txt holding hello.' }),
    async () => {
      await held;
      return reply.steps(write('result.txt', 'hello'));
    },
  );
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  await waitFor('the worker to be answering', async () => h.chat.pending === 0, 20_000);
  const before = h.chat.exchanged.length;
  await h.call('POST', `/sessions/${sent.threadId}/stop`, {});
  release();
  await h.idle();
  const job = (await sessionOf(h, sent.threadId)).tasks[0]!;
  const worker = await workerOf(h, sent.threadId);
  t.check('the message stopped, its subtask too, the command never ran', [job.status, worker.tasks[0]?.status, existsSync(join(h.repo, 'result.txt'))], ['aborted', 'aborted', false]);
  t.check('and nothing more was sent to either conversation', h.chat.exchanged.length, before);

  // "Continue": in the lead's own conversation, told why it stopped, to carry on — not the assignment again.
  let carried = '';
  h.chat.script((m) => {
    carried = m.text;
    return reply.lead.done('The worker had not written result.txt when the work was stopped; nothing else was changed, and the file is still to be made.');
  });
  const queued = await h.call<{ status: string; continuing?: { how?: string } }>('POST', `/sessions/${sent.threadId}/tasks/${job.id}/continue`);
  t.check('carried on: queued again, as a stopped one', [queued.status, queued.continuing?.how], ['queued', 'stopped']);
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  await h.idle();
  t.truthy('the lead is told to continue where the work got to, why it stopped, and not given the assignment again', carried.startsWith('Continue assignment 1:') && carried.includes('stopped by the operator') && carried.includes('Do not start over') && !carried.includes('## Assignment'), carried.slice(0, 500));
  const after = (await sessionOf(h, sent.threadId)).tasks[0]!;
  t.check('its first reply need not restate the assignment: it ended done', after.status, 'done');
  // The stopped attempt's rounds stay on its record, not written over by the next; the next counts its own subtasks.
  t.check('the stopped attempt keeps its rounds and its subtask; the new one starts its count from nothing', [after.attempts?.at(-1)?.lead?.subtasks, after.attempts?.at(-1)?.lead?.rounds.at(-1)?.subtask?.title, after.lead?.subtasks, after.lead?.rounds.length], [1, 'Write result.txt', 0, 1]);
});

t.finish();
