/**
 * The queue of tasks (operator, 2026-10-24): tasks written beforehand and run one after another, each in a new chat on
 * its own model; a task may depend on earlier ones, and is skipped when one of them did not end done, while the queue
 * goes on with the tasks that do not depend on it; a task works in the folder as it is, or on a new branch from main —
 * fetched from the server when that asks nobody for anything, else the local main, which the chat is told.
 *
 * - the rules, without a browser: what an edit may hold, what a "Run again" puts back, which task is next;
 * - a queue of five run end to end through the API with the scripted chat (test/support/fakeChat.ts);
 * - a queue that was running when the bot closed is not running when it opens again;
 * - a task with a skill (2026-10-25): kept as it is named, refused when Settings have no such skill, sent with it;
 * - a task added while a message of the chat works starts after it (2026-10-25), waiting as a task that waits.
 *
 *   npm run check:queue
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkItems, itemTitle, mergeItems, nextStep, skippedBecause, statusOfTask, waitsByHand, type QueueItem } from '../src/queue/queue.js';
import { makeDirs, startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
const item = (id: string, over: Partial<QueueItem> = {}): QueueItem => ({ id, prompt: `task ${id}`, model: '', dependsOn: [], branch: 'folder', review: false, status: 'waiting', ...over });

console.log('--- the rules ---');
t.check('a task depends only on tasks before it', [
  'problem' in checkItems([{ id: 'a', prompt: 'x', dependsOn: ['b'] }, { id: 'b', prompt: 'y' }], 1000),
  'problem' in checkItems([{ id: 'a', prompt: 'x', dependsOn: ['a'] }], 1000),
  'problem' in checkItems([{ id: 'a', prompt: 'x' }, { id: 'b', prompt: 'y', dependsOn: ['a'] }], 1000),
], [true, true, false]);
t.check('and says so', (checkItems([{ id: 'a', prompt: 'x', dependsOn: ['b'] }, { id: 'b', prompt: 'y' }], 1000) as { problem: string }).problem, 'Task 1 depends on a task after it: a task can depend only on tasks before it.');
t.check('a task says something, and not too much', [
  (checkItems([{ id: 'a', prompt: '  ' }], 1000) as { problem: string }).problem,
  (checkItems([{ id: 'a', prompt: 'x'.repeat(11) }], 10) as { problem: string }).problem,
], ['Task 1 says nothing: write what it is to do.', 'Task 1 is 11 characters; a task can be at most 10.']);
t.check('what is not said is the default: the folder as it is, reviewed, Settings\' model', (checkItems([{ id: 'a', prompt: 'x' }], 1000) as { items: unknown[] }).items, [{ id: 'a', prompt: 'x', model: '', dependsOn: [], branch: 'folder', review: true }]);
// A name, two chats with the worker's model, the review's model (operator, 2026-10-24).
t.check('two chats: the worker\'s model kept, no review of its own (the lead judges), whatever is sent', (checkItems([{ id: 'a', name: ' Report ', prompt: 'x', lead: true, workerModel: 'W', review: true, reviewModel: 'R' }], 1000) as { items: unknown[] }).items, [
  { id: 'a', name: 'Report', prompt: 'x', model: '', dependsOn: [], branch: 'folder', review: false, lead: true, workerModel: 'W' },
]);
t.check('one chat, reviewed: the review\'s model kept, no worker\'s', (checkItems([{ id: 'a', prompt: 'x', review: true, reviewModel: 'R', workerModel: 'W' }], 1000) as { items: unknown[] }).items, [
  { id: 'a', prompt: 'x', model: '', dependsOn: [], branch: 'folder', review: true, reviewModel: 'R' },
]);
// A skill (2026-10-25): as typed after "/" or as Settings list it; whether it is there is the server's to say.
t.check('a skill kept by its name, in lowercase, without its "/"', (checkItems([{ id: 'a', prompt: 'x', review: false, skill: ' /New-Test ' }], 1000) as { items: Array<{ skill?: string }> }).items[0]!.skill, 'new-test');
t.check('and changed or dropped by an edit, as the rest of what the operator gives', [
  (mergeItems([item('a', { skill: 'new-test' })], [{ id: 'a', prompt: 'task a', model: '', dependsOn: [], branch: 'folder', review: false, skill: 'db-migration' }]) as { items: QueueItem[] }).items[0]!.skill,
  (mergeItems([item('a', { skill: 'new-test' })], [{ id: 'a', prompt: 'task a', model: '', dependsOn: [], branch: 'folder', review: false }]) as { items: QueueItem[] }).items[0]!.skill,
], ['db-migration', undefined]);
t.check('a name too long is refused', (checkItems([{ id: 'a', name: 'n'.repeat(81), prompt: 'x' }], 1000) as { problem: string }).problem, 'The name of task 1 is longer than 80 characters.');
t.check('the name, where there is one, is what a task is called', [itemTitle({ name: 'Report', prompt: 'Write it.\nmore' }), itemTitle({ prompt: 'Write it.\nmore' })], ['Report', 'Write it.']);
const none = {};
t.check('what would wait for a model chosen by hand: no model anywhere; a review with none; the lead with none', [
  waitsByHand({ model: '', review: false }, none),
  waitsByHand({ model: '', review: false }, { defaultModel: 'A' }),
  waitsByHand({ model: 'A', review: true }, none),
  waitsByHand({ model: 'A', review: true, reviewModel: 'B' }, none),
  waitsByHand({ model: 'A', review: true }, { defaultReviewModel: 'B' }),
  waitsByHand({ model: '', review: false, lead: true }, { defaultLeadModel: 'L' }),
  waitsByHand({ model: '', review: false, lead: true }, { defaultModel: 'A' }),
  waitsByHand({ model: '', review: true, lead: true }, none),
], [['model'], [], ['review'], [], [], [], [], ['model']]);

const ran = [item('a', { status: 'failed', why: 'blocked', sessionId: 's1' }), item('b', { status: 'running', sessionId: 's2' }), item('c')];
const merged = mergeItems(ran, [
  { id: 'a', prompt: 'task a, again', model: 'Think deeper', dependsOn: [], branch: 'main', review: true, status: 'waiting' },
  { id: 'b', prompt: 'changed while it runs', model: '', dependsOn: [], branch: 'folder', review: false },
  { id: 'c', prompt: 'task c', model: '', dependsOn: ['a'], branch: 'folder', review: false },
  { id: 'd', prompt: 'new', model: '', dependsOn: [], branch: 'folder', review: false, status: 'done' },
]) as { items: QueueItem[] };
t.check('"Run again" puts a task back to wait, with what it was given and nothing of how it went', merged.items[0], { id: 'a', prompt: 'task a, again', model: 'Think deeper', dependsOn: [], branch: 'main', review: true, status: 'waiting' });
t.check('a running task is kept as it is, whatever the edit says', merged.items[1], ran[1]);
t.check('a new one waits, whatever it says it is', merged.items[3]!.status, 'waiting');
t.check('a running task is not taken out', (mergeItems(ran, [{ id: 'a', prompt: 'x', model: '', dependsOn: [], branch: 'folder', review: false }]) as { problem: string }).problem, '"task b" is running: stop the queue before taking it out.');

const chain = [
  item('1', { status: 'failed' }),
  item('2', { dependsOn: ['1'] }),
  item('3'),
  item('4', { dependsOn: ['2'] }),
  item('5', { dependsOn: ['3'] }),
];
const walk: string[] = [];
for (let i = 0; i < 10; i += 1) {
  const step = nextStep(chain);
  if (!step) break;
  if ('skip' in step) {
    walk.push(`skip ${step.skip.id} (${skippedBecause(step.because)})`);
    step.skip.status = 'skipped';
  } else {
    walk.push(`run ${step.run.id}`);
    step.run.status = 'done';
  }
}
t.check('one fails: what depends on it is skipped, and on what was skipped for it; the rest run, in order', walk, [
  'skip 2 (it depends on "task 1", which failed)',
  'run 3',
  'skip 4 (it depends on "task 2", which was skipped)',
  'run 5',
]);
t.check('how a message ended, as the queue says it', ['done', 'aborted', 'blocked', 'failed', 'limit-reached', undefined].map((s) => statusOfTask(s)), ['done', 'stopped', 'failed', 'failed', 'failed', 'failed']);

console.log('\n--- a queue of five, end to end ---');
type QueueView = { items: QueueItem[]; running: boolean };
type SessionView = { id: string; kind?: string; name: string; model?: string; queueItem?: string; vcs?: { enabled?: boolean; startFrom?: string; baseBranch?: string }; chat?: { chatId: string }; tasks: Array<{ status: string; vcs?: { branch?: string; commit?: string } }> };
let h: Harness | null = null;
try {
  // "Model for the worker" in Settings: the tasks with no model of their own run on it.
  h = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 }, execution: { mode: 'unattended' }, copilot: { defaultModel: 'Auto' } } });
  const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;
  // The server's main cannot be reached, as when it asks for a password nobody is there to type.
  h.git('remote', 'add', 'origin', join(h.base, 'no-such-server.git'));

  t.check('a task that depends on one after it is refused', (await h.raw('PUT', '/queue', { items: [{ id: 'q1', prompt: 'x', dependsOn: ['q2'] }, { id: 'q2', prompt: 'y' }] })).status, 400);
  const items = [
    { id: 'q1', prompt: 'Find the old report and summarise it.', model: '', dependsOn: [], branch: 'folder', review: false },
    { id: 'q2', prompt: 'Turn the summary into a slide.', model: '', dependsOn: ['q1'], branch: 'folder', review: false },
    { id: 'q3', prompt: 'Create c.txt holding exactly the word c.', model: 'Think deeper', dependsOn: [], branch: 'main', review: false },
    { id: 'q4', prompt: 'Create d.txt holding exactly the word d.', model: '', dependsOn: ['q3'], branch: 'folder', review: false },
    { id: 'q5', prompt: 'Send the slide round.', model: '', dependsOn: ['q2'], branch: 'folder', review: false },
  ];
  const saved = await h.call<QueueView>('PUT', '/queue', { items });
  t.check('saved: five tasks waiting, not running', [saved.items.map((x) => x.status), saved.running], [['waiting', 'waiting', 'waiting', 'waiting', 'waiting'], false]);
  // Its branch made when it was added (2026-10-26), not checked out: the server's main out of reach, the local main.
  const q3 = saved.items[2] as QueueItem;
  t.check('the task on a new branch from main has its branch already, made from the local main, the folder untouched', [
    q3.branchName, q3.branchFrom, q3.branchBase === h.git('rev-parse', 'main'), h.git('rev-parse', '--verify', `refs/heads/${q3.branchName}`) === h.git('rev-parse', 'main'), h.git('rev-parse', '--abbrev-ref', 'HEAD'),
  ], ['queue/q3-create-c.txt-holding-exactly-the-word-c', 'main', true, true, 'main']);
  t.check('and the others none', saved.items.filter((x) => x.id !== 'q3').map((x) => (x as QueueItem).branchName ?? null), [null, null, null, null]);
  t.truthy('kept in the bot\'s data folder', existsSync(join(h.dataDir, 'queue.json')), '');

  const texts: string[] = [];
  h.chat.script(
    (m) => {
      texts.push(m.text);
      return reply.steps('Get-ChildItem');
    },
    reply.blocked(),
    (m) => {
      texts.push(m.text);
      return reply.steps(write('c.txt', 'c'));
    },
    reply.done(),
    (m) => {
      texts.push(m.text);
      return reply.steps(write('d.txt', 'd'));
    },
    reply.done(),
  );
  await h.call('POST', '/queue/run');
  t.check('running again while it runs is refused', (await h.raw('POST', '/queue/run')).status, 400);
  const done = await waitFor('the queue to end', async () => {
    const q = await h!.call<QueueView>('GET', '/queue');
    return !q.running && !q.items.some((x) => x.status === 'running' || x.status === 'waiting') ? q : null;
  }, 120_000);
  t.check('one failed; what depends on it skipped, and on that; the others done', done.items.map((x) => x.status), ['failed', 'skipped', 'done', 'done', 'skipped']);
  t.check('each skipped one says why', [done.items[1]!.why, done.items[4]!.why], ['it depends on "Find the old report and summarise it.", which failed', 'it depends on "Turn the summary into a slide.", which was skipped']);

  const sessions = await Promise.all(done.items.filter((x) => x.sessionId).map((x) => h!.call<SessionView>('GET', `/sessions/${x.sessionId}`)));
  t.check('each that ran, in a chat of its own, named and marked for the queue', [sessions.length, new Set(sessions.map((s) => s.chat?.chatId)).size, sessions.map((s) => [s.kind, s.queueItem, s.name])], [3, 3, [
    ['chat', 'q1', 'queue: Find the old report and summarise it.'],
    ['chat', 'q3', 'queue: Create c.txt holding exactly the word c.'],
    ['chat', 'q4', 'queue: Create d.txt holding exactly the word d.'],
  ]]);
  const [, onMain, inFolder] = sessions;
  t.check('its own model, chosen by the bot; Settings\' where it has none', [onMain!.model, inFolder!.model ?? '', h.chat.modelRequests.filter((m) => m !== 'Auto')], ['Think deeper', '', ['Think deeper']]);
  t.check('"new branch from main": the runner\'s version control, on the branch made for it', [onMain!.vcs?.enabled, onMain!.vcs?.startFrom, (onMain!.vcs as { existingBranch?: string } | undefined)?.existingBranch, inFolder!.vcs?.enabled], [true, 'existing-branch', 'queue/q3-create-c.txt-holding-exactly-the-word-c', false]);
  const branch = onMain!.tasks[0]!.vcs?.branch ?? '';
  t.truthy('its work committed on a branch of its own, made from main', branch === 'queue/q3-create-c.txt-holding-exactly-the-word-c' && h.git('show', `${branch}:c.txt`).trim() === 'c' && h.git('merge-base', '--is-ancestor', 'main', branch) === '', { branch });
  t.check('the next one, "the folder as it is", worked on that branch, and committed nothing', [h.git('rev-parse', '--abbrev-ref', 'HEAD'), readFileSync(join(h.repo, 'd.txt'), 'utf8').trim(), h.git('status', '--porcelain')], [branch, 'd', '?? d.txt']);

  const [first, second, third] = texts;
  t.truthy('the chat on the new branch is told so, not the folder\'s rule', second!.includes('## Version control') && second!.includes('on the existing branch `queue/q3-create-c.txt-holding-exactly-the-word-c`') && !second!.includes("## Working in the operator's folder"), second!.slice(0, 2000));
  t.truthy('and that the server\'s main could not be fetched, so it is the local one, not to be pulled', /made from the local `main`: the server's main could not be fetched without asking for a password, and a run never types one\. Do not try to fetch or pull it\./.test(second!), second!.slice(0, 2500));
  t.truthy('the chats in the folder as it is are told that', first!.includes("## Working in the operator's folder") && third!.includes("## Working in the operator's folder"), '');
  t.check('"Run again" puts the failed one back to wait', (await h.call<QueueView>('PUT', '/queue', { items: done.items.map((x) => ({ ...x, ...(x.id === 'q1' ? { status: 'waiting' } : {}) })) })).items.map((x) => x.status), ['waiting', 'skipped', 'done', 'done', 'skipped']);

  // Two chats from the queue (2026-10-24): the lead on the task's model, the worker on its own, no review.
  await h.call('PUT', '/queue', { items: [{ id: 'q6', name: 'Plan it', prompt: 'Plan the migration of the reports.', model: 'Think deeper', lead: true, workerModel: 'GPT 5.6 Think deeper', dependsOn: [], branch: 'folder' }] });
  h.chat.script(reply.lead.blocked('Nothing was done: this check only looks at how the conversation was made.', 'nothing; this is a check', { understanding: 'A plan of the migration of the reports.' }));
  await h.call('POST', '/queue/run');
  const led = await waitFor('the two-chat task to end', async () => {
    const q = await h!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]!.status !== 'waiting' && q.items[0]!.status !== 'running' ? q.items[0]! : null;
  }, 60_000);
  const lead = await h.call<SessionView & { lead?: { workerModel?: string }; review?: { enabled: boolean } }>('GET', `/sessions/${led.sessionId}`);
  t.check('a task of two chats: a lead on its model, the worker\'s model kept for its worker, no review, named', [lead.name, lead.model, lead.lead?.workerModel, lead.review?.enabled], ['queue: Plan it', 'Think deeper', 'GPT 5.6 Think deeper', false]);

  /*
   * A skill, and a task added while a message sent from the chat works (operator, 2026-10-25: "I think of another task
   * for after it, go to Queue and add it; the new one starts after the one running"): it waits as a task that waits,
   * the page is told what works, and it starts once that has ended — with its skill.
   */
  const skill = { name: 'new-test', description: 'Adding an automated test', text: 'Tests live in tests/e2e, one file per page.', projectDir: '' };
  const unknown = await h.raw('PUT', '/queue', { items: [{ id: 'q7', prompt: 'Add a test for the login page.', model: 'Think deeper', dependsOn: [], branch: 'folder', review: false, skill: 'new-test' }] });
  t.check('a skill Settings do not have: refused, and said', [unknown.status, (unknown.body as { message?: string }).message], [400, 'Task 1 is sent with the skill "new-test", which is not in Settings → Skills.']);
  await h.call('PUT', '/skills', { skills: [skill] });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let queueText = '';
  const order: string[] = [];
  h.chat.script(
    async () => {
      await held;
      order.push('chat');
      return reply.steps(write('chat.txt', 'chat'));
    },
    reply.done('I wrote chat.txt in the project folder, holding the word chat, as the message asked.'),
    (m) => {
      order.push('queue');
      queueText = m.text;
      return reply.done('I wrote the test for the login page in tests/e2e, as the skill says.');
    },
  );
  const sent = await h.call<{ threadId: string; taskId: string }>('POST', '/chat', { text: 'Create chat.txt holding the word chat.', model: 'Think deeper' });
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  const busy = await waitFor('the queue to see the chat at work', async () => {
    const q = await h!.call<QueueView & { busy?: { kind: string; sessionId?: string; title?: string } }>('GET', '/queue');
    return q.busy ? q.busy : null;
  }, 20_000);
  t.check('while a message of the chat works, the queue says what works', busy, { kind: 'chat', sessionId: sent.threadId, title: 'Create chat.txt holding the word chat.' });
  await h.call('PUT', '/queue', { items: [{ id: 'q7', prompt: 'Add a test for the login page.', model: 'Think deeper', dependsOn: [], branch: 'folder', review: false, skill: '/new-test' }] });
  const started = await h.call<QueueView & { busy?: { kind: string } }>('POST', '/queue/run');
  t.check('added and run while it works: the queue runs, and says what it waits for', [started.running, started.busy?.kind], [true, 'chat']);
  await new Promise((r) => setTimeout(r, 2_500));
  const meanwhile = await h.call<QueueView>('GET', '/queue');
  t.check('meanwhile the task waits, as a task that waits, and no chat of its own was made', [meanwhile.items[0]!.status, meanwhile.items[0]!.sessionId ?? null], ['waiting', null]);
  release();
  const after = await waitFor('the queued task to end', async () => {
    const q = await h!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]!.status !== 'waiting' && q.items[0]!.status !== 'running' ? q.items[0]! : null;
  }, 60_000);
  const chatSession = await h.call<{ tasks: Array<{ status: string; finishedAt?: string }> }>('GET', `/sessions/${sent.threadId}`);
  t.check('the message of the chat done, then the queued task, in that order', [chatSession.tasks[0]!.status, after.status, order], ['done', 'done', ['chat', 'queue']]);
  t.truthy('the queued task began after the message had ended', !!after.startedAt && !!chatSession.tasks[0]!.finishedAt && after.startedAt >= chatSession.tasks[0]!.finishedAt, { started: after.startedAt, chatEnded: chatSession.tasks[0]!.finishedAt });
  t.truthy('and was sent with its skill', queueText.includes('## Skill: new-test') && queueText.includes('Tests live in tests/e2e, one file per page.'), queueText.slice(-600));
  const qs = await h.call<{ skill?: { name: string } ; tasks: Array<{ skill?: { name: string } }> }>('GET', `/sessions/${after.sessionId}`);
  t.check('its message keeps the skill it was sent with', qs.tasks[0]!.skill?.name, 'new-test');
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h?.stop();
}

console.log('\n--- a task that waits for the operator: set aside, the queue goes on, answered later, carried on ---');
let hp: Harness | null = null;
try {
  // Asking before each command, so a command waits on a card as a plan does.
  hp = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 }, execution: { mode: 'confirm' }, copilot: { defaultModel: 'Auto' } } });
  const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;
  type Parked = { kind: string; approval: { plan?: unknown; description: string }; answer?: { kind: string } };
  type Sess = { id: string; chat?: { chatId: string }; tasks: Array<{ id: string; status: string; parked?: Parked; plan?: { approved?: { by: string; note?: string } }; attempts?: Array<{ parked?: Parked }> }> };
  const settled = await hp.call<QueueView & { parkAfterSec?: number }>('PUT', '/queue/settings', { parkAfterSec: 2 });
  t.check('the wait before a task is set aside: set on the queue', settled.parkAfterSec, 2);
  t.check('a wait that is not a number of seconds is refused', (await hp.raw('PUT', '/queue/settings', { parkAfterSec: -1 })).status, 400);
  await hp.call('PUT', '/queue', { items: [
    { id: 'p1', name: 'Planned', prompt: 'Write plan.txt holding plan.', model: '', dependsOn: [], branch: 'folder', review: false, plan: true },
    { id: 'p2', name: 'Independent', prompt: 'Write two.txt holding two.', model: '', dependsOn: [], branch: 'folder', review: false },
    { id: 'p3', name: 'After the plan', prompt: 'Write three.txt holding three.', model: '', dependsOn: ['p1'], branch: 'folder', review: false },
  ] });
  const chats: Record<string, string> = {};
  hp.chat.script(
    (m) => {
      chats.p1 = m.chatId;
      return reply.plan({ files: ['plan.txt'] });
    },
    (m) => {
      chats.p2 = m.chatId;
      return reply.steps(write('two.txt', 'two'));
    },
  );
  await hp.call('POST', '/queue/run');
  // p2's command waits on its card too; answered here, so only the plan is left unanswered.
  const card = await waitFor('p2\'s command to wait', async () => (await hp!.call<Array<{ id: string; description: string }>>('GET', '/approvals')).find((a) => a.description.includes('two.txt')) ?? null, 60_000);
  hp.chat.script(reply.done('I wrote two.txt holding the word two and read it back to check that it is there.'));
  await hp.call('POST', `/approvals/${card.id}`, { action: 'run' });
  const first = await waitFor('the queue to go round once', async () => {
    const q = await hp!.call<QueueView>('GET', '/queue');
    return !q.running ? q : null;
  }, 120_000);
  t.check('the plan unanswered: set aside; the independent task done; the one that needs it waiting, not skipped', first.items.map((x) => x.status), ['parked', 'done', 'waiting']);
  const parkedItem = first.items[0] as QueueItem;
  t.check('the queue keeps what it waits for, and says so', [parkedItem.waitsFor?.kind, parkedItem.why, !!(parkedItem.waitsFor?.approval as { plan?: unknown } | undefined)?.plan], ['plan', 'waits for you: its plan, to approve', true]);
  const s1 = await hp.call<Sess>('GET', `/sessions/${parkedItem.sessionId}`);
  t.check('and so does the task\'s record', [s1.tasks[0]!.status, s1.tasks[0]!.parked?.kind, s1.tasks[0]!.parked?.answer ?? null], ['aborted', 'plan', null]);
  t.check('an answer that does not fit the card is refused', (await hp.raw('POST', '/queue/items/p1/answer', { decision: 'revise' })).status, 400);
  const answered = await hp.call<QueueView>('POST', '/queue/items/p1/answer', { decision: 'approve', note: 'Keep it short.' });
  t.check('answered: it waits to carry on, first', [answered.items[0]!.status, (answered.items[0] as QueueItem).resume], ['waiting', true]);

  let resumed = '';
  hp.chat.script(
    (m) => {
      resumed = m.text;
      chats.p1again = m.chatId;
      return reply.steps(write('plan.txt', 'plan'));
    },
    reply.done('I wrote plan.txt holding the word plan, as the approved plan said, and read it back.'),
    (m) => {
      chats.p3 = m.chatId;
      return reply.steps(write('three.txt', 'three'));
    },
    reply.done('I wrote three.txt holding the word three and read it back to check that it is there.'),
  );
  // Both commands wait on their cards: answered as they come.
  await hp.call('POST', '/queue/run');
  for (const file of ['plan.txt', 'three.txt']) {
    const c = await waitFor(`${file}'s command to wait`, async () => (await hp!.call<Array<{ id: string; description: string }>>('GET', '/approvals')).find((a) => a.description.includes(file)) ?? null, 60_000);
    await hp.call('POST', `/approvals/${c.id}`, { action: 'run' });
  }
  const second = await waitFor('the queue to end', async () => {
    const q = await hp!.call<QueueView>('GET', '/queue');
    return !q.running && !q.items.some((x) => x.status === 'running' || x.status === 'waiting') ? q : null;
  }, 120_000);
  t.check('carried on and done; then the one that needed it', second.items.map((x) => x.status), ['done', 'done', 'done']);
  const s2 = await hp.call<Sess>('GET', `/sessions/${parkedItem.sessionId}`);
  t.check('in its own chat and conversation, its plan approved by the operator with the note', [second.items[0]!.sessionId === parkedItem.sessionId, chats.p1again === chats.p1, s2.tasks[0]!.plan?.approved?.by, s2.tasks[0]!.plan?.approved?.note], [true, true, 'operator', 'Keep it short.']);
  t.truthy('told why it was set aside, and the answer', resumed.includes('set aside so that the queue') && resumed.includes('The operator approved your plan.') && resumed.includes('Keep it short.'), resumed.slice(0, 1500));
  t.check('the attempt that waited keeps what it waited for and the answer', [s2.tasks[0]!.attempts?.at(-1)?.parked?.kind, s2.tasks[0]!.attempts?.at(-1)?.parked?.answer?.kind, s2.tasks[0]!.parked ?? null], ['plan', 'plan', null]);
  t.check('the files written, each by its own task', [readFileSync(join(hp.repo, 'plan.txt'), 'utf8').trim(), readFileSync(join(hp.repo, 'two.txt'), 'utf8').trim(), readFileSync(join(hp.repo, 'three.txt'), 'utf8').trim()], ['plan', 'two', 'three']);

  // A command that waited, approved on its card later: when its chat sends it again, it runs without asking.
  await hp.call('PUT', '/queue', { items: [{ id: 'c1', name: 'A command', prompt: 'Write cmd.txt holding cmd.', model: '', dependsOn: [], branch: 'folder', review: false }] });
  hp.chat.script(reply.steps(write('cmd.txt', 'cmd')));
  await hp.call('POST', '/queue/run');
  const cmdParked = await waitFor('the command to be set aside', async () => {
    const q = await hp!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]!.status === 'parked' ? (q.items[0] as QueueItem) : null;
  }, 120_000);
  t.check('a command unanswered: set aside, with what it asked', [cmdParked.waitsFor?.kind, (cmdParked.waitsFor?.approval as { description?: string } | undefined)?.description?.includes('cmd.txt')], ['command', true]);
  await hp.call('POST', '/queue/items/c1/answer', { decision: 'run' });
  let again = '';
  hp.chat.script(
    (m) => {
      again = m.text;
      return reply.steps(write('cmd.txt', 'cmd'));
    },
    reply.done('I wrote cmd.txt holding the word cmd and read it back to check that it is there.'),
  );
  let cards = 0;
  await hp.call('POST', '/queue/run');
  const ran = await waitFor('the approved command to run', async () => {
    cards = Math.max(cards, (await hp!.call<unknown[]>('GET', '/approvals')).length);
    const q = await hp!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]!.status !== 'waiting' && q.items[0]!.status !== 'running' ? q.items[0]! : null;
  }, 120_000);
  t.check('sent again, it ran without asking, and the task was done', [ran.status, cards, readFileSync(join(hp.repo, 'cmd.txt'), 'utf8').trim()], ['done', 0, 'cmd']);
  t.truthy('the chat was told it is approved now', again.includes('The command you were waiting to run is approved now'), again.slice(0, 1200));

  // Two chats: the lead's question unanswered, set aside; answered, the lead is told the answer in its own conversation.
  await hp.call('PUT', '/queue', { items: [{ id: 'l1', name: 'Led', prompt: 'Find where done.txt should go, and say it.', model: 'Think deeper', dependsOn: [], branch: 'folder', review: false, lead: true }] });
  hp.chat.script(reply.lead.ask('Should done.txt go at the root, or in a folder of its own?', ['at the root', 'in a folder'], { understanding: 'Where done.txt should go, said in a sentence.' }));
  await hp.call('POST', '/queue/run');
  const asked = await waitFor('the lead\'s question to be set aside', async () => {
    const q = await hp!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]!.status === 'parked' ? (q.items[0] as QueueItem) : null;
  }, 120_000);
  t.check('the lead\'s question unanswered: set aside, with the question', [asked.waitsFor?.kind, (asked.waitsFor?.approval as { question?: { text: string } } | undefined)?.question?.text], ['question', 'Should done.txt go at the root, or in a folder of its own?']);
  t.check('an empty answer is refused', (await hp.raw('POST', '/queue/items/l1/answer', { answer: '  ' })).status, 400);
  await hp.call('POST', '/queue/items/l1/answer', { answer: 'at the root' });
  let toLead = '';
  hp.chat.script((m) => {
    toLead = m.text;
    return reply.lead.done('done.txt goes at the root of the project, as the operator answered when asked; nothing else was needed.');
  });
  await hp.call('POST', '/queue/run');
  const led = await waitFor('the led task to end', async () => {
    const q = await hp!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]!.status !== 'waiting' && q.items[0]!.status !== 'running' ? q.items[0]! : null;
  }, 120_000);
  t.check('answered, the lead carried on and ended it', led.status, 'done');
  t.truthy('the lead was told why it stopped, its question and the answer', toLead.startsWith('Continue assignment') && toLead.includes('set aside so that the queue') && toLead.includes('You asked: Should done.txt go at the root') && toLead.includes('The operator answers: at the root'), toLead.slice(0, 1500));
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await hp?.stop();
}

console.log('\n--- the bot closed while the queue ran ---');
let h2: Harness | null = null;
try {
  const dirs = await makeDirs();
  writeFileSync(join(dirs.dataDir, 'queue.json'), JSON.stringify({ running: true, updatedAt: '', items: [item('a', { status: 'running', sessionId: 'gone' }), item('b'), item('c', { status: 'parked', sessionId: 's-c', why: 'waits for you: its plan, to approve' })] }), 'utf8');
  h2 = await startHarness({ dirs, own: true });
  const q = await h2.call<QueueView>('GET', '/queue');
  t.check('opened again: not running, the task in flight stopped and why, the rest waiting, a parked one still parked', [q.running, q.items.map((x) => x.status), q.items[0]!.why, q.items[2]!.why], [false, ['stopped', 'waiting', 'parked'], 'the bot was closed while it ran', 'waits for you: its plan, to approve']);
  await h2.call('PUT', '/queue', { items: [{ id: 'b', prompt: 'task b', model: '', dependsOn: [], branch: 'folder', review: false }] });
  // No model of its own and none in Settings: it would wait for somebody to choose one by hand, and nobody is there.
  const refused = await h2.raw('POST', '/queue/run');
  t.check('a task with no model anywhere: the queue does not start, and says why', [refused.status, (refused.body as { message?: string }).message], [
    400,
    '"task b" has no model of its own, and Settings have no "Model for the worker": it would wait for you to choose a model by hand. Choose the model in the task, or in Settings.',
  ]);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h2?.stop();
}

t.finish();
