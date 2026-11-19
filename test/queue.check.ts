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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkItems, itemTitle, mergeItems, nextStep, skippedBecause, statusOfTask, waitsByHand, type QueueItem } from '../src/queue/queue.js';
import { madeFromRemote, refreshQueueBranch, remoteMainOf } from '../src/queue/queueBranch.js';
import { newItemId } from '../web/lib/queueId.js';
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
/*
 * A task that carries on in its own chat, edited (bug hunt 2026-11-18): the edit was kept and never used — it carried on
 * as it was given. An edit of what it does starts it over, as "Run again"; its name or what it depends on keep it going.
 */
{
  const carrying = item('a', { resume: true, sessionId: 's1', why: 'the queue was stopped while it ran', branch: 'main', branchName: 'queue/a', branchBase: 'abc' });
  const asIs = { id: 'a', prompt: 'task a', model: '', dependsOn: [], branch: 'main' as const, review: false };
  const renamed = (mergeItems([carrying], [{ ...asIs, name: 'Report' }]) as { items: QueueItem[] }).items[0]!;
  const rewritten = (mergeItems([carrying], [{ ...asIs, prompt: 'task a, said better' }]) as { items: QueueItem[] }).items[0]!;
  const remodelled = (mergeItems([carrying], [{ ...asIs, model: 'Think deeper' }]) as { items: QueueItem[] }).items[0]!;
  t.check('a new name: it still carries on in its chat, on its branch', [renamed.name, renamed.resume, renamed.sessionId, renamed.branchName], ['Report', true, 's1', 'queue/a']);
  t.check('what it does changed: started over with the edit, nothing of the chat it carried on in', [rewritten, remodelled.resume, remodelled.sessionId, remodelled.model], [{ id: 'a', prompt: 'task a, said better', model: '', dependsOn: [], branch: 'main', review: false, status: 'waiting' }, undefined, undefined, 'Think deeper']);
  t.check('the same task sent back as it is (a move, another removed): it carries on', (mergeItems([carrying], [{ ...asIs, review: false }]) as { items: QueueItem[] }).items[0]!.resume, true);
}

/*
 * A new task's id never one a task had before (bug hunt 2026-11-18): "q<n>" after the number of tasks gave a removed
 * task's id to the next one added, and a card left in the removed one's chat answered for it.
 */
{
  const two = [{ id: 'q1' }, { id: 'q2' }];
  const removedThen = two.slice(0, 1);
  const added = newItemId(removedThen, Date.UTC(2026, 10, 18, 12));
  t.check("a task added after the last was removed: an id of its own, not the removed one's", [added === 'q2', added !== newItemId(removedThen, Date.UTC(2026, 10, 18, 13)), newItemId([{ id: added }], Date.UTC(2026, 10, 18, 12)) !== added], [false, true, true]);
}

/*
 * A queue branch brought up to date at its start (bug hunt 2026-11-18): only `main` of `origin` was fetched, so in a
 * repository whose remote is "upstream" and whose main is "master" it never was, and its chat was told it came from a
 * local main. Brought up to the remote branch it was made from.
 */
{
  const root = mkdtempSync(join(tmpdir(), 'cop-qbranch-'));
  const run = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  const server = join(root, 'server.git');
  const mine = join(root, 'mine');
  const theirs = join(root, 'theirs');
  run(root, 'init', '--bare', '--initial-branch=master', server);
  for (const dir of [mine, theirs]) {
    run(root, 'clone', '--quiet', '--origin', 'upstream', server, dir);
    run(dir, 'config', 'user.email', 'check@example.invalid');
    run(dir, 'config', 'user.name', 'check');
  }
  writeFileSync(join(mine, 'a.txt'), 'a');
  run(mine, 'add', 'a.txt');
  run(mine, 'commit', '--quiet', '-m', 'first');
  run(mine, 'push', '--quiet', 'upstream', 'HEAD:master');
  const first = run(mine, 'rev-parse', 'HEAD');
  run(mine, 'fetch', '--quiet', 'upstream');
  run(mine, 'branch', '--no-track', 'queue/q1-x', first);
  run(theirs, 'pull', '--quiet', 'upstream', 'master');
  writeFileSync(join(theirs, 'b.txt'), 'b');
  run(theirs, 'add', 'b.txt');
  run(theirs, 'commit', '--quiet', '-m', 'second');
  run(theirs, 'push', '--quiet', 'upstream', 'HEAD:master');
  const second = run(theirs, 'rev-parse', 'HEAD');
  const fresh = await refreshQueueBranch(mine, 'queue/q1-x', first, 'upstream/master');
  t.check('made from upstream/master: brought up to it at the start', [fresh.moved, fresh.base === second, fresh.from, run(mine, 'rev-parse', 'queue/q1-x') === second], [true, true, 'upstream/master', true]);
  t.check('a branch made from a remote is said so; one from a local main is not', [await madeFromRemote(mine, 'upstream/master'), await madeFromRemote(mine, 'master'), await madeFromRemote(mine, 'origin/main')], [true, false, false]);
  t.check('made from the local master: that main on the remote', await remoteMainOf(mine, 'master'), { remote: 'upstream', ref: 'master' });
  rmSync(root, { recursive: true, force: true });
}

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
    async (m) => {
      texts.push(m.text);
      midQueue = await h!.call<{ queue?: boolean }>('GET', '/activity');
      return reply.steps(write('c.txt', 'c'));
    },
    reply.done(),
    (m) => {
      texts.push(m.text);
      return reply.steps(write('d.txt', 'd'));
    },
    reply.done(),
  );
  // Whether the queue's turn is still going, for "Done" to wait for its end (2026-11-03).
  let midQueue = null as { queue?: boolean } | null;
  await h.call('POST', '/queue/run');
  t.check('running again while it runs is refused', (await h.raw('POST', '/queue/run')).status, 400);
  const done = await waitFor('the queue to end', async () => {
    const q = await h!.call<QueueView>('GET', '/queue');
    return !q.running && !q.items.some((x) => x.status === 'running' || x.status === 'waiting') ? q : null;
  }, 120_000);
  t.check('one failed; what depends on it skipped, and on that; the others done', done.items.map((x) => x.status), ['failed', 'skipped', 'done', 'done', 'skipped']);
  t.check('while its turn goes the activity says the queue is at work, for "Done" to wait for its end', midQueue?.queue, true);
  await waitFor('the turn of the queue to be over', async () => !(await h!.call<{ queue?: boolean }>('GET', '/activity')).queue, 10_000).catch(() => undefined);
  t.check('its turn over, it says nothing of the queue', (await h.call<{ queue?: boolean }>('GET', '/activity')).queue, undefined);
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
  /*
   * The skill taken out of Settings afterwards (bug hunt 2026-11-18): every edit of the queue was refused for the task
   * done with it — adding, moving, removing another — and a task done cannot be edited. Only a task that will run is
   * held to the skills Settings have.
   */
  await h.call('PUT', '/skills', { skills: [] });
  const doneOne = { id: 'q7', prompt: 'Add a test for the login page.', model: 'Think deeper', dependsOn: [], branch: 'folder', review: false, skill: 'new-test', status: 'done' };
  const added = await h.raw('PUT', '/queue', { items: [doneOne, { id: 'q8', prompt: 'Write notes.txt.', model: 'Think deeper', dependsOn: [], branch: 'folder', review: false }] });
  t.check('its skill taken out of Settings: the task done with it does not block adding another', [added.status, (added.body as QueueView).items?.map((x) => x.status)], [200, ['done', 'waiting']]);
  const again = await h.raw('PUT', '/queue', { items: [{ ...doneOne, status: 'waiting' }] });
  t.check('but put back to run with it: refused, and said', [again.status, (again.body as { message?: string }).message], [400, 'Task 1 is sent with the skill "new-test", which is not in Settings → Skills.']);
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
  // 2026-11-18: "Continue" in its chat took what it waited for off its record, and every button on its card failed after.
  const carried = await hp.raw('POST', `/chat/${parkedItem.sessionId}/tasks/${s1.tasks[0]!.id}/continue`);
  t.truthy('"Continue" in its chat is refused: it is answered on its card', carried.status === 400 && /answer it there/.test(JSON.stringify(carried.body)), carried);
  t.check('and what it waits for is still on its record', (await hp.call<Sess>('GET', `/sessions/${parkedItem.sessionId}`)).tasks[0]!.parked?.kind, 'plan');
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

  // A question of several answers set aside (2026-11-02): answered with the ones chosen, the lead is told them.
  await hp.call('PUT', '/queue', { items: [{ id: 'l2', name: 'Led many', prompt: 'Find what done.txt should hold, and say it.', model: 'Think deeper', dependsOn: [], branch: 'folder', review: false, lead: true }] });
  hp.chat.script(reply.lead.ask('What should done.txt hold?', ['the date', 'the user name', 'nothing'], { understanding: 'What done.txt should hold, said in a sentence.', multiple: true }));
  await hp.call('POST', '/queue/run');
  await waitFor('the question of several answers to be set aside', async () => {
    const q = await hp!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]!.status === 'parked' ? true : null;
  }, 120_000);
  t.check('none chosen is refused', (await hp.raw('POST', '/queue/items/l2/answer', { answer: '', chosen: [] })).status, 400);
  await hp.call('POST', '/queue/items/l2/answer', { answer: '', chosen: [1, 0] });
  let toLeadMany = '';
  hp.chat.script((m) => {
    toLeadMany = m.text;
    return reply.lead.done('done.txt holds the date and the user name, as the operator chose when asked; nothing else was needed.');
  });
  await hp.call('POST', '/queue/run');
  await waitFor('the led task to end', async () => {
    const q = await hp!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]!.status !== 'waiting' && q.items[0]!.status !== 'running' ? true : null;
  }, 120_000);
  t.truthy('the lead was told the ones chosen', toLeadMany.includes('You asked: What should done.txt hold?') && toLeadMany.includes('The operator answered your question, choosing 2 of your answers:\n\n- the date\n- the user name'), toLeadMany.slice(0, 1500));

  // The chat's own question set aside, answered with an answer that carries a command (2026-11-02): it is told to run it.
  await hp.call('PUT', '/queue', { items: [{ id: 'c2', name: 'Asks', prompt: 'Write signed.txt once the operator agrees to it.', model: 'Think deeper', dependsOn: [], branch: 'folder', review: false }] });
  hp.chat.script(reply.ask('Shall I write signed.txt now?', [{ answer: 'Yes, write it', run: "Set-Content -Path signed.txt -Value 'signed'" }, 'No']));
  await hp.call('POST', '/queue/run');
  await waitFor('the chat\'s question to be set aside', async () => {
    const q = await hp!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]!.status === 'parked' ? true : null;
  }, 120_000);
  await hp.call('POST', '/queue/items/c2/answer', { answer: 'Yes, write it' });
  let toChat = '';
  hp.chat.script((m) => {
    toChat = m.text;
    return reply.done('Nothing was left to do once the operator answered: signed.txt is written by the next step, as the answer said.');
  });
  await hp.call('POST', '/queue/run');
  await waitFor('the asking task to end', async () => {
    const q = await hp!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]!.status !== 'waiting' && q.items[0]!.status !== 'running' ? true : null;
  }, 120_000);
  t.truthy('the chat was told the answer, and to send the command it carries', toChat.includes('The operator answers: Yes, write it') && toChat.includes("That answer carries a command: send `Set-Content -Path signed.txt -Value 'signed'` as your next step."), toChat.slice(0, 1500));
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
  // The one in flight waits to carry on in its own chat (2026-11-18): stopped, what depends on it was skipped at the next run.
  t.check('opened again: not running, the task in flight waiting to carry on and why, the rest waiting, a parked one still parked', [q.running, q.items.map((x) => x.status), q.items[0]!.resume ?? false, q.items[0]!.why, q.items[2]!.why], [false, ['waiting', 'waiting', 'parked'], true, 'the bot was closed while it ran; it carries on from where it stopped, in its own chat, when the queue is run again', 'waits for you: its plan, to approve']);
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

/*
 * Found 2026-11-18, reviewing the code against Kerrigan's description: a task on "the folder as it is" leaves its
 * changes uncommitted, and the next task on a branch of its own was refused for them ("There are uncommitted changes …
 * Commit or stash them first", and "on the Sessions page", which is gone), with what depends on it skipped. Now those
 * changes are put aside, kept whole on a branch of their own and not pushed, and the task runs.
 */
console.log('\n--- a task on the folder as it is, then one on a branch of its own: what the first left is put aside ---');
let h3: Harness | null = null;
try {
  h3 = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 }, execution: { mode: 'unattended' }, copilot: { defaultModel: 'Auto' } } });
  const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;
  h3.git('remote', 'add', 'origin', join(h3.base, 'no-such-server.git'));
  await h3.call<QueueView>('PUT', '/queue', { items: [
    { id: 'f1', prompt: 'Write left.txt holding exactly left.', model: '', dependsOn: [], branch: 'folder', review: false },
    { id: 'b1', prompt: 'Write b.txt holding exactly b.', model: '', dependsOn: [], branch: 'main', review: false },
  ] });
  h3.chat.script(reply.steps(write('left.txt', 'left')), reply.done(), reply.steps(write('b.txt', 'b')), reply.done());
  await h3.call('POST', '/queue/run');
  const done = await waitFor('the queue to end', async () => {
    const q = await h3!.call<QueueView>('GET', '/queue');
    return !q.running && !q.items.some((x) => x.status === 'running' || x.status === 'waiting') ? q : null;
  }, 120_000);
  t.check('both done: the one on its own branch not refused for what the first left', [done.items.map((x) => x.status), done.items[1]!.why ?? null], [['done', 'done'], null]);
  const saved = h3.git('branch', '--list', 'cop/saved/*', '--format=%(refname:short)').split('\n').filter(Boolean);
  t.check('what the first left is kept whole on a branch of its own', [saved.length, saved[0] ? h3.git('show', `${saved[0]}:left.txt`).trim() : null], [1, 'left']);
  const second = await h3.call<{ tasks: Array<{ vcs?: { branch?: string } }> }>('GET', `/sessions/${done.items[1]!.sessionId}`);
  const branch = second.tasks[0]?.vcs?.branch ?? '';
  t.truthy('the second task\'s work committed on its own branch, without what the first left', branch.startsWith('queue/b1') && h3.git('show', `${branch}:b.txt`).trim() === 'b' && !h3.git('ls-tree', '--name-only', branch).split('\n').includes('left.txt'), { branch, tree: h3.git('ls-tree', '--name-only', branch) });
  const said = (await h3.call<Array<{ type: string; message: string }>>('GET', `/sessions/${done.items[1]!.sessionId}/events`)).find((e) => e.type === 'queue-set-aside');
  t.truthy('and it is said, with where it was put', !!said && said.message.includes(saved[0] ?? '?') && said.message.includes('not pushed'), said);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h3?.stop();
}

/*
 * Found 2026-11-18, reviewing the code against Kerrigan's description ("every task needs a model named … since nobody is
 * there to choose one by hand"): Settings' "by hand", on by default, put every task of the queue on its model's card,
 * and each was set aside after the wait, its model named or not. The model named is chosen by the bot now.
 */
console.log('\n--- Settings choose the model by hand: the queue\'s tasks have their named model chosen by the bot ---');
let h4: Harness | null = null;
try {
  h4 = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 }, execution: { mode: 'unattended' }, copilot: { defaultModel: 'Auto', manualModel: true, leadManualModel: true, reviewManualModel: true } } });
  const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;
  await h4.call('PUT', '/queue/settings', { parkAfterSec: 5 });
  await h4.call<QueueView>('PUT', '/queue', { items: [{ id: 'm1', prompt: 'Write m.txt holding exactly m.', model: 'Think deeper', dependsOn: [], branch: 'folder', review: false }] });
  h4.chat.script(reply.steps(write('m.txt', 'm')), reply.done());
  const before = h4.chat.modelRequests.length;
  await h4.call('POST', '/queue/run');
  const done = await waitFor('the queue to end', async () => {
    const q = await h4!.call<QueueView>('GET', '/queue');
    return !q.running && !q.items.some((x) => x.status === 'running' || x.status === 'waiting') ? q : null;
  }, 60_000);
  t.check('done, not set aside on a card for its model', [done.items.map((x) => x.status), done.items[0]!.why ?? null], [['done'], null]);
  t.check('its model was chosen by the bot', h4.chat.modelRequests.slice(before), ['Think deeper']);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h4?.stop();
}

/*
 * Found 2026-11-18: a queue task with two chats and "Plan first", set aside at the lead's plan and approved later, was
 * told the single chat's words — reply with status "continue" — which is not a status of the lead's, and it was asked
 * again for its format. It is told in the lead's words now.
 */
console.log('\n--- two chats, plan first: the lead\'s plan approved on the card the queue kept, told in the lead\'s words ---');
let h5: Harness | null = null;
try {
  h5 = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 }, execution: { mode: 'unattended' }, copilot: { defaultModel: 'Auto' } } });
  await h5.call('PUT', '/queue/settings', { parkAfterSec: 2 });
  await h5.call('PUT', '/queue', { items: [{ id: 'l1', name: 'Led', prompt: 'Create result.txt holding hello.', model: '', dependsOn: [], branch: 'folder', review: false, plan: true, lead: true }] });
  h5.chat.script(reply.lead.plan({ steps: ['write result.txt', 'read it back'] }, { understanding: 'A file result.txt holding hello.' }));
  await h5.call('POST', '/queue/run');
  await waitFor('the lead\'s plan to be set aside', async () => {
    const q = await h5!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]!.status === 'parked' ? q : null;
  }, 60_000);
  await h5.call('POST', '/queue/items/l1/answer', { decision: 'approve' });
  let resumed = '';
  h5.chat.script((m) => {
    resumed = m.text;
    return reply.lead.blocked('Stopping here: this only checks what the lead was told.', 'nothing');
  });
  await h5.call('POST', '/queue/run');
  await waitFor('the queue to end', async () => {
    const q = await h5!.call<QueueView>('GET', '/queue');
    return !q.running && !q.items.some((x) => x.status === 'running' || x.status === 'waiting') ? q : null;
  }, 60_000);
  t.truthy('the lead told its plan is approved, and to give the worker the first subtask, not to reply "continue"',
    resumed.includes('The operator approved your plan.') && resumed.includes('status "delegate"') && !resumed.includes('status "continue"'), resumed.slice(0, 1500));
  t.check('and not asked again for its format', h5.chat.problems, []);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h5?.stop();
}

/*
 * Found 2026-11-18, reviewing the code against Kerrigan's description ("Stop the queue … the rest wait"): the task at
 * work was marked stopped, and the next "Run the queue" skipped every task that depends on it at once; only "Run again"
 * was left, which starts it over in a new chat. It waits to carry on now, in its own chat, before the others.
 */
console.log('\n--- "Stop the queue" while a task works: it carries on when the queue runs again; what depends on it is not skipped ---');
let h6: Harness | null = null;
try {
  h6 = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 }, execution: { mode: 'unattended' }, copilot: { defaultModel: 'Auto' } } });
  const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;
  await h6.call('PUT', '/queue', { items: [
    { id: 's1', prompt: 'Write s1.txt holding s1.', model: '', dependsOn: [], branch: 'folder', review: false },
    { id: 's2', prompt: 'Write s2.txt holding s2.', model: '', dependsOn: ['s1'], branch: 'folder', review: false },
  ] });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  h6.chat.script(async () => {
    await held;
    return reply.steps(write('s1.txt', 's1'));
  });
  await h6.call('POST', '/queue/run');
  await waitFor('the first task to be answering', async () => (h6!.chat.pending === 0 ? true : null), 30_000);
  await h6.call('POST', '/queue/stop');
  release();
  const stopped = await waitFor('the queue to stop', async () => {
    const q = await h6!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]!.status !== 'running' ? q : null;
  }, 60_000);
  t.check('stopped with the queue: it waits to carry on, and the one that depends on it waits, not skipped', [stopped.items.map((x) => x.status), stopped.items[0]!.resume ?? false], [['waiting', 'waiting'], true]);
  let carried = '';
  h6.chat.script(
    (m) => {
      carried = m.text;
      return reply.steps(write('s1.txt', 's1'));
    },
    reply.done('I wrote s1.txt holding the word s1 and read it back.'),
    reply.steps(write('s2.txt', 's2')),
    reply.done('I wrote s2.txt holding the word s2 and read it back.'),
  );
  await h6.call('POST', '/queue/run');
  const done = await waitFor('the queue to end', async () => {
    const q = await h6!.call<QueueView>('GET', '/queue');
    return !q.running && !q.items.some((x) => x.status === 'running' || x.status === 'waiting') ? q : null;
  }, 90_000);
  t.check('run again: it carried on in its own chat, then the one that depends on it ran', [done.items.map((x) => x.status), done.items[0]!.sessionId === stopped.items[0]!.sessionId], [['done', 'done'], true]);
  t.truthy('the chat told to carry on, not given the task anew', carried.includes('Continue task'), carried.slice(0, 600));
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h6?.stop();
}

/*
 * Found 2026-11-18: a task on "the folder as it is", set aside at its plan, carried on on whatever branch the task after
 * it left the folder on — a branch made for another task — though its card says it carries on where it began. It is
 * put back on the branch it began on. And a card in its chat answered for a run that is not the queue's task now is
 * refused; one stopped is said so on its record, not offered again.
 */
console.log('\n--- a task on the folder, set aside, carries on on the branch it began on; a card of another run is refused ---');
let h7: Harness | null = null;
try {
  h7 = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 }, execution: { mode: 'unattended' }, copilot: { defaultModel: 'Auto' } } });
  const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;
  await h7.call('PUT', '/queue/settings', { parkAfterSec: 2 });
  await h7.call('PUT', '/queue', { items: [
    { id: 'a1', name: 'Folder, planned', prompt: 'Write a.txt holding a.', model: '', dependsOn: [], branch: 'folder', review: false, plan: true },
    { id: 'b1', name: 'On its branch', prompt: 'Write b.txt holding b.', model: '', dependsOn: [], branch: 'main', review: false },
  ] });
  h7.chat.script(reply.plan({ files: ['a.txt'] }), reply.steps(write('b.txt', 'b')), reply.done('I wrote b.txt holding the word b and read it back.'));
  await h7.call('POST', '/queue/run');
  const first = await waitFor('the queue to go round once', async () => {
    const q = await h7!.call<QueueView>('GET', '/queue');
    return !q.running && !q.items.some((x) => x.status === 'running' || x.status === 'waiting') ? q : null;
  }, 90_000);
  t.check('the planned one set aside, the other done on its own branch, the folder left there', [first.items.map((x) => x.status), h7.git('rev-parse', '--abbrev-ref', 'HEAD').startsWith('queue/b1')], [['parked', 'done'], true]);
  const parked = first.items[0] as QueueItem;
  const stale = await h7.raw('POST', '/queue/items/a1/answer', { decision: 'approve', sessionId: 'an-earlier-run' });
  t.truthy('an answer from the card of another run of it: refused, saying so', stale.status === 400 && /another run/.test(JSON.stringify(stale.body)), stale);
  await h7.call('POST', '/queue/items/a1/answer', { decision: 'approve', sessionId: parked.sessionId });
  h7.chat.script(reply.steps(write('a.txt', 'a')), reply.done('I wrote a.txt holding the word a, as the plan said, and read it back.'));
  await h7.call('POST', '/queue/run');
  const second = await waitFor('the queue to end', async () => {
    const q = await h7!.call<QueueView>('GET', '/queue');
    return !q.running && !q.items.some((x) => x.status === 'running' || x.status === 'waiting') ? q : null;
  }, 90_000);
  t.check('carried on back on main, where it began: its file there, not on the other task\'s branch', [second.items[0]!.status, h7.git('rev-parse', '--abbrev-ref', 'HEAD'), existsSync(join(h7.repo, 'a.txt'))], ['done', 'main', true]);

  // A card stopped: said so on the task's record, so its chat does not offer it again.
  await h7.call('PUT', '/queue', { items: [{ id: 'c1', name: 'Planned again', prompt: 'Write c.txt holding c.', model: '', dependsOn: [], branch: 'folder', review: false, plan: true }] });
  h7.chat.script(reply.plan({ files: ['c.txt'] }));
  await h7.call('POST', '/queue/run');
  const cParked = await waitFor('the plan to be set aside', async () => {
    const q = await h7!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]!.status === 'parked' ? (q.items[0] as QueueItem) : null;
  }, 60_000);
  await h7.call('POST', '/queue/items/c1/answer', { stop: true });
  const cTask = (await h7.call<{ tasks: Array<{ parked?: { answer?: { kind: string } } }> }>('GET', `/sessions/${cParked.sessionId}`)).tasks[0];
  t.check('stopped at its card: the record says so, and the card is not offered again in its chat', cTask?.parked?.answer?.kind, 'stopped');
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h7?.stop();
}

/*
 * Found 2026-11-18: a task on "the folder as it is", set aside at its question with its work not committed, carried on
 * without it — the task after it, on a branch of its own, had put that work aside on cop/saved/…. It is put back, not
 * committed, before it carries on.
 */
console.log('\n--- a task on the folder, set aside with its work not committed, gets it back when it carries on ---');
let h8: Harness | null = null;
try {
  h8 = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 }, execution: { mode: 'unattended', questions: 'ask' }, copilot: { defaultModel: 'Auto' } } });
  const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;
  await h8.call('PUT', '/queue/settings', { parkAfterSec: 2 });
  await h8.call('PUT', '/queue', { items: [
    { id: 'a2', name: 'Folder, asks', prompt: 'Write w.txt holding w, then ask me which name to use for n.txt.', model: '', dependsOn: [], branch: 'folder', review: false },
    { id: 'b2', name: 'On its branch', prompt: 'Write b.txt holding b.', model: '', dependsOn: [], branch: 'main', review: false },
  ] });
  h8.chat.script(
    reply.steps(write('w.txt', 'w')),
    reply.ask('Which name should n.txt hold?', ['north', 'south'], 'The task leaves it to you.'),
    reply.steps(write('b.txt', 'b')),
    reply.done('I wrote b.txt holding the word b and read it back.'),
  );
  await h8.call('POST', '/queue/run');
  const first = await waitFor('the queue to go round once', async () => {
    const q = await h8!.call<QueueView>('GET', '/queue');
    return !q.running && !q.items.some((x) => x.status === 'running' || x.status === 'waiting') ? q : null;
  }, 90_000);
  const a2 = first.items[0] as QueueItem;
  const saved = h8.git('for-each-ref', '--format=%(refname:short)', 'refs/heads/cop/saved/');
  t.check('set aside at its question, its w.txt put aside by the task on its own branch, and kept for it', [first.items.map((x) => x.status), existsSync(join(h8.repo, 'w.txt')), !!saved, a2.setAside], [['parked', 'done'], false, true, [saved]]);
  await h8.call('POST', '/queue/items/a2/answer', { answer: 'north', sessionId: a2.sessionId });
  let told = '';
  h8.chat.script(
    (m) => {
      told = m.text;
      return reply.steps(write('n.txt', 'north'));
    },
    reply.done('w.txt holds the word w, as before, and I wrote n.txt holding north, the name the operator chose.'),
  );
  await h8.call('POST', '/queue/run');
  const second = await waitFor('the queue to end', async () => {
    const q = await h8!.call<QueueView>('GET', '/queue');
    return !q.running && !q.items.some((x) => x.status === 'running' || x.status === 'waiting') ? q : null;
  }, 90_000);
  t.check('carried on back on main with its w.txt back, not committed, and done', [
    second.items[0]!.status,
    h8.git('rev-parse', '--abbrev-ref', 'HEAD'),
    existsSync(join(h8.repo, 'w.txt')) ? readFileSync(join(h8.repo, 'w.txt'), 'utf8').trim() : null,
    h8.git('status', '--porcelain', '--', 'w.txt'),
    (second.items[0] as QueueItem).setAside ?? [],
  ], ['done', 'main', 'w', '?? w.txt', []]);
  t.truthy('the answer went on to the chat', told.includes('north'), told.slice(0, 300));
  const events = await h8.call<Array<{ type: string; message: string }>>('GET', `/sessions/${a2.sessionId}/events`);
  t.truthy('said: put back, from where', events.some((e) => e.type === 'queue-put-back' && e.message.includes(saved) && /back in the folder/.test(e.message)), events.filter((e) => e.type.startsWith('queue-')).map((e) => e.message));
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h8?.stop();
}

/*
 * Found 2026-11-19 (second bug hunt): a task whose conversation could not be put back (ended stopped since 2026-11-18,
 * so that "Continue" is offered) stopped the whole queue left running overnight, as the operator's Stop does, and
 * what came after it waited. Only the operator's Stop stops the queue: such a task failed, the others run.
 */
console.log('\n--- a task whose conversation is lost: it fails, and the queue goes on ---');
let h9: Harness | null = null;
try {
  h9 = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 }, execution: { mode: 'unattended' }, copilot: { defaultModel: 'Auto' } } });
  const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;
  await h9.call('PUT', '/queue', { items: [
    { id: 'a3', name: 'Loses its chat', prompt: 'Write x.txt holding x.', model: '', dependsOn: [], branch: 'folder', review: false },
    { id: 'b3', name: 'After it', prompt: 'Write y.txt holding y.', model: '', dependsOn: [], branch: 'folder', review: false },
  ] });
  h9.chat.script(
    (m) => {
      // Deleted in Copilot while the step runs: the window cannot be put back on it for the report.
      h9!.chat.unopenable.add(m.chatId);
      h9!.chat.leavePage();
      return reply.steps(write('x.txt', 'x'));
    },
    reply.steps(write('y.txt', 'y')),
    reply.done('I wrote y.txt holding the word y and read it back.'),
  );
  await h9.call('POST', '/queue/run');
  const ended = await waitFor('the queue to stop', async () => {
    const q = await h9!.call<QueueView>('GET', '/queue');
    return !q.running && !q.items.some((x) => x.status === 'running') ? q : null;
  }, 90_000);
  t.check('the one that lost its chat failed, saying why; the one after it ran', [
    ended.items.map((x) => x.status),
    /could not be opened again/.test(ended.items[0]?.why ?? ''),
    existsSync(join(h9.repo, 'y.txt')),
  ], [['failed', 'done'], true, true]);
  h9.chat.discard();
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h9?.stop();
}

/*
 * Found 2026-11-19 (second bug hunt), the cards of tasks set aside:
 * - one answered on its card, then "Continue" in its chat: the answer was filed under the attempt before and lost;
 *   "Continue" is refused, saying the queue carries it on with the answer;
 * - one the queue lets go of — taken out, run again — kept its card in its chat, where every button failed, Stop
 *   included, and "Continue" was refused: the card is closed, Stop on it is taken, and "Continue" carries it on;
 * - while one waits, "Finished: aborted" was said: the work is not over, and the activity says one waits.
 */
console.log('\n--- the cards of tasks set aside: answered, carried on by the queue; let go of, carried on in their chats ---');
let h10: Harness | null = null;
try {
  h10 = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 }, execution: { mode: 'unattended', questions: 'ask' }, copilot: { defaultModel: 'Auto' } } });
  await h10.call('PUT', '/queue/settings', { parkAfterSec: 2 });
  const asks = (id: string, name: string) => ({ id, name, prompt: `Ask me which name to use for ${id}.txt.`, model: '', dependsOn: [], branch: 'folder', review: false });
  await h10.call('PUT', '/queue', { items: [asks('a4', 'Asks first')] });
  h10.chat.script(reply.ask('Which name should a4.txt hold?', ['north', 'south'], 'The task leaves it to you.'));
  await h10.call('POST', '/queue/run');
  const a4 = await waitFor('it to be set aside', async () => {
    const q = await h10!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]?.status === 'parked' ? (q.items[0] as QueueItem) : null;
  }, 60_000);
  const act = await h10.call<{ parked?: number }>('GET', '/activity');
  t.check('while it waits, the activity says one is set aside (so "Done" is not said)', act.parked, 1);
  type View = { tasks: Array<{ id: string; parked?: { answer?: { kind: string } } }> };
  const a4Task = (await h10.call<View>('GET', `/sessions/${a4.sessionId}`)).tasks[0]!;
  await h10.call('POST', '/queue/items/a4/answer', { answer: 'north', sessionId: a4.sessionId });
  const early = await h10.raw('POST', `/chat/${a4.sessionId}/tasks/${a4Task.id}/continue`);
  t.truthy('answered on its card, "Continue" in its chat is refused: the queue carries it on with the answer', early.status === 400 && /answered on its card/.test(JSON.stringify(early.body)), early.body);

  // Taken out of the queue, answered or not: its card closed, and "Continue" carries it on in its chat.
  await h10.call('PUT', '/queue', { items: [] });
  const released = (await h10.call<View>('GET', `/sessions/${a4.sessionId}`)).tasks[0]!;
  t.check('taken out after it was answered: its card is closed as let go of', released.parked?.answer?.kind, 'released');
  h10.chat.script(reply.done('I asked which name a4.txt should hold; the queue let the task go, so nothing more was written.'));
  const went = await h10.call<{ started: boolean }>('POST', `/chat/${a4.sessionId}/tasks/${a4Task.id}/continue`);
  t.check('and "Continue" carries it on in its chat', went.started, true);
  await h10.idle();

  // Set aside, then taken out before it was answered: Stop on its card is taken, not refused.
  await h10.call('PUT', '/queue', { items: [asks('b4', 'Asks next')] });
  h10.chat.script(reply.ask('Which name should b4.txt hold?', ['east', 'west'], 'The task leaves it to you.'));
  await h10.call('POST', '/queue/run');
  const b4 = await waitFor('it to be set aside', async () => {
    const q = await h10!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]?.status === 'parked' ? (q.items[0] as QueueItem) : null;
  }, 60_000);
  await h10.call('PUT', '/queue', { items: [] });
  const stop = await h10.raw('POST', '/queue/items/b4/answer', { stop: true, sessionId: b4.sessionId });
  const b4Task = (await h10.call<View>('GET', `/sessions/${b4.sessionId}`)).tasks[0]!;
  t.check('taken out before it was answered: its card closed, and Stop on it is taken', [stop.status < 300, b4Task.parked?.answer?.kind], [true, 'released']);
  t.check('nothing set aside any more', (await h10.call<{ parked?: number }>('GET', '/activity')).parked, undefined);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h10?.stop();
}

/*
 * Found 2026-11-19 (second bug hunt): a sign-in Copilot asks for in a queue left running was waited for fifteen
 * minutes, then the task failed and what depended on it was skipped; nothing said the work waited for one, and "Sign in
 * to Copilot" was refused "once the run has finished". Now a task of the queue waits for it as long as it takes, the
 * tab and the chat say so, "Sign in to Copilot" points to that window, and once signed in the task goes on by itself.
 */
console.log('\n--- a sign-in asked for in the queue: waited for as long as it takes, said, and the task goes on ---');
let h13: Harness | null = null;
try {
  h13 = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 }, execution: { mode: 'unattended' }, copilot: { defaultModel: 'Auto', signInTimeoutSec: 60 } } });
  const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;
  let signIn!: () => void;
  await h13.call('PUT', '/queue', { items: [{ id: 'a7', name: 'Signed out meanwhile', prompt: 'Write s.txt holding s.', model: '', dependsOn: [], branch: 'folder', review: false }] });
  h13.chat.script(
    () => {
      // The account signed out while the step runs: the window finds a sign-in on its way back to the conversation.
      h13!.chat.leavePage();
      h13!.chat.signInOnReturn = 1;
      h13!.chat.signInWait = new Promise<void>((r) => (signIn = r));
      return reply.steps(write('s.txt', 's'));
    },
    reply.done('I wrote s.txt holding the word s and read it back.'),
  );
  await h13.call('POST', '/queue/run');
  await waitFor('the work to wait for the sign-in', async () => ((await h13!.call<{ signIn?: boolean }>('GET', '/activity')).signIn ? true : null), 60_000);
  t.check('the queue\'s window waits for a sign-in as long as it takes, not the fifteen minutes of Settings', (h13.chat.windowOptions.at(-1)?.signInTimeoutMs ?? 0) >= 7 * 24 * 3600 * 1000, true);
  const login = await h13.raw('POST', '/login', {});
  t.truthy('"Sign in to Copilot" points to the window that waits for it', login.status === 400 && /waiting for you to sign in: sign in there/.test(JSON.stringify(login.body)), login.body);
  signIn();
  const ended = await waitFor('the queue to end', async () => {
    const q = await h13!.call<QueueView>('GET', '/queue');
    return !q.running && !q.items.some((x) => x.status === 'running' || x.status === 'waiting') ? q : null;
  }, 60_000);
  t.check('signed in: the task went on by itself, done', [ended.items[0]?.status, (await h13.call<{ signIn?: boolean }>('GET', '/activity')).signIn], ['done', undefined]);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h13?.stop();
}

/*
 * Found 2026-11-19 (second bug hunt): a queue.json there but not readable — the machine lost power over it, another
 * program held it — was read as an empty queue, and the next change wrote that over it: every task and every card kept
 * for the operator gone, without a word. Refused now, naming the file; the file kept as it was.
 */
console.log('\n--- a queue file there but not readable: refused, never written over ---');
let h12: Harness | null = null;
try {
  h12 = await startHarness({ settings: { copilot: { defaultModel: 'Auto' } } });
  const file = join(h12.dataDir, 'queue.json');
  const broken = '{"items": [{"id": "a6", "name": "Kept", "prompt": "Write k.txt."';
  writeFileSync(file, broken, 'utf8');
  const read = await h12.raw('GET', '/queue');
  const add = await h12.raw('PUT', '/queue', { items: [{ id: 'b6', name: 'New', prompt: 'Write n.txt holding n.', model: '', dependsOn: [], branch: 'folder', review: false }] });
  t.check('read and changed: refused, naming the file; the file as it was', [
    read.status,
    add.status,
    JSON.stringify(add.body).includes('queue.json') && /not valid JSON/.test(JSON.stringify(add.body)),
    readFileSync(file, 'utf8'),
  ], [400, 400, true, broken]);
  writeFileSync(file, '', 'utf8');
  const fresh = await h12.call<QueueView>('PUT', '/queue', { items: [{ id: 'b6', name: 'New', prompt: 'Write n.txt holding n.', model: '', dependsOn: [], branch: 'folder', review: false }] });
  t.check('an empty one is a queue not begun: the task added', fresh.items.map((x) => x.id), ['b6']);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h12?.stop();
}

/*
 * Found 2026-11-19 (second bug hunt): the work of a task on "the folder as it is", set aside with its changes not
 * committed, was lost track of. "New branch from main" took it to the new branch — the task carried on without it,
 * Copilot not told — or put it aside, whose nobody knew. Taken along now refused, saying so; put aside, it is kept for
 * the task. And stopped at its card, its chat is told where work put aside for it is kept.
 */
console.log('\n--- the work of a task set aside on the folder: "New branch" keeps it for the task; a Stop says where it is ---');
let h11: Harness | null = null;
try {
  h11 = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 }, execution: { mode: 'unattended', questions: 'ask' }, copilot: { defaultModel: 'Auto' } } });
  const remote = join(h11.base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  h11.git('remote', 'add', 'origin', remote);
  h11.git('push', '-q', '-u', 'origin', 'main');
  const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;
  await h11.call('PUT', '/queue/settings', { parkAfterSec: 2 });
  await h11.call('PUT', '/queue', { items: [{ id: 'a5', name: 'Folder, asks', prompt: 'Write w.txt holding w, then ask me which name to use.', model: '', dependsOn: [], branch: 'folder', review: false }] });
  h11.chat.script(reply.steps(write('w.txt', 'w')), reply.ask('Which name should it hold?', ['north', 'south'], 'The task leaves it to you.'));
  await h11.call('POST', '/queue/run');
  const a5 = await waitFor('it to be set aside', async () => {
    const q = await h11!.call<QueueView>('GET', '/queue');
    return !q.running && q.items[0]?.status === 'parked' ? (q.items[0] as QueueItem) : null;
  }, 60_000);
  const plan = await h11.call<{ ok: boolean; fingerprint: string; suggested: string }>('POST', '/workspace/new-branch/preview', { fetch: true });
  const take = await h11.raw('POST', '/workspace/new-branch', { name: plan.suggested, carry: 'take', fingerprint: plan.fingerprint });
  t.truthy('taken to the new branch: refused, naming the task whose work it is', take.status === 400 && /Folder, asks/.test(JSON.stringify(take.body)) && h11.git('symbolic-ref', '--short', 'HEAD') === 'main', take.body);
  const aside = await h11.call<{ ok: boolean; saved?: { branch: string } }>('POST', '/workspace/new-branch', { name: plan.suggested, carry: 'aside', fingerprint: plan.fingerprint });
  const kept = ((await h11.call<QueueView>('GET', '/queue')).items[0] as QueueItem).setAside;
  t.check('put aside: kept for the task, to be put back when it carries on', [aside.ok, !!aside.saved, kept], [true, true, aside.saved ? [aside.saved.branch] : []]);
  // Stopped at its card: nothing puts it back now, and its chat is told where it is.
  await h11.call('POST', '/queue/items/a5/answer', { stop: true, sessionId: a5.sessionId });
  const notes = JSON.stringify((await h11.call<{ tasks: Array<{ notes?: unknown }> }>('GET', `/sessions/${a5.sessionId}`)).tasks.at(-1)?.notes ?? '');
  t.truthy('stopped at its card: its chat is told where its work is kept', !!aside.saved && notes.includes(aside.saved.branch), notes.slice(0, 400));
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h11?.stop();
}

t.finish();
