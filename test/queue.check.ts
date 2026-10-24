/**
 * The queue of tasks (operator, 2026-10-24): tasks written beforehand and run one after another, each in a new chat on
 * its own model; a task may depend on earlier ones, and is skipped when one of them did not end done, while the queue
 * goes on with the tasks that do not depend on it; a task works in the folder as it is, or on a new branch from main —
 * fetched from the server when that asks nobody for anything, else the local main, which the chat is told.
 *
 * - the rules, without a browser: what an edit may hold, what a "Run again" puts back, which task is next;
 * - a queue of five run end to end through the API with the scripted chat (test/support/fakeChat.ts);
 * - a queue that was running when the bot closed is not running when it opens again.
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
  t.check('"new branch from main": the runner\'s version control, from main', [onMain!.vcs?.enabled, onMain!.vcs?.startFrom, onMain!.vcs?.baseBranch, inFolder!.vcs?.enabled], [true, 'branch', 'main', false]);
  const branch = onMain!.tasks[0]!.vcs?.branch ?? '';
  t.truthy('its work committed on a branch of its own, made from main', /^cop\//.test(branch) && h.git('show', `${branch}:c.txt`).trim() === 'c' && h.git('merge-base', '--is-ancestor', 'main', branch) === '', { branch });
  t.check('the next one, "the folder as it is", worked on that branch, and committed nothing', [h.git('rev-parse', '--abbrev-ref', 'HEAD'), readFileSync(join(h.repo, 'd.txt'), 'utf8').trim(), h.git('status', '--porcelain')], [branch, 'd', '?? d.txt']);

  const [first, second, third] = texts;
  t.truthy('the chat on the new branch is told so, not the folder\'s rule', second!.includes('## Version control') && second!.includes('started from the local branch `main`') && !second!.includes("## Working in the operator's folder"), second!.slice(0, 2000));
  t.truthy('and that the server\'s main could not be fetched, so it is the local one, not to be pulled', /The server's `main` could not be fetched.*a run never types a password or a key's passphrase, so it is the local `main`.*Do not try to fetch or pull it\./s.test(second!), second!.slice(0, 2500));
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
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h?.stop();
}

console.log('\n--- the bot closed while the queue ran ---');
let h2: Harness | null = null;
try {
  const dirs = await makeDirs();
  writeFileSync(join(dirs.dataDir, 'queue.json'), JSON.stringify({ running: true, updatedAt: '', items: [item('a', { status: 'running', sessionId: 'gone' }), item('b')] }), 'utf8');
  h2 = await startHarness({ dirs, own: true });
  const q = await h2.call<QueueView>('GET', '/queue');
  t.check('opened again: not running, the task in flight stopped and why, the rest waiting', [q.running, q.items.map((x) => x.status), q.items[0]!.why], [false, ['stopped', 'waiting'], 'the bot was closed while it ran']);
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
