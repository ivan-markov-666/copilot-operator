/**
 * Undoing a task, accepting one as done, and notes to the chat — end to end through the API, with the scripted
 * chat of test/support/fakeChat.ts in place of Copilot (asked for on 2026-10-14). No browser, no Microsoft 365.
 *
 * - "Undo only this task" on a session's one branch: the task's commit reverted in one commit, the tasks after
 *   it kept, the task queued again and not started; run again, it builds on the line without its old work;
 * - the same refused, with nothing changed, when a later task changed the same lines;
 * - "Go back to before this task": the line back at its start, it and the tasks after it queued, nothing started;
 * - per-task mode: the folder back at the task's start, its branch kept;
 * - a task that ran cannot be undone while queued; one that blocked is accepted as done, with what it was;
 * - a note on a queued task goes out with its opening; one written while it runs, with the next report.
 *
 *   npm run check:e2e-undo
 */
import { startHarness, Tally, type Harness, type TaskView } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

type Undone = { how: string; commit?: string; branch?: string; byTask?: string };
type Full = TaskView & { attempts?: Array<{ status: string; undone?: Undone }>; accepted?: { was: string; note?: string }; notes?: Array<{ text: string; sentAt?: string; attempt?: number }> };
type Preview = {
  this: { ok: boolean; problem?: string; perTask?: boolean; branch?: string; commits: string[]; later: string[]; nothing?: string; baseCommit?: string };
  back: { ok: boolean; tasks: Array<{ title: string }> };
};

const task = (title: string, file: string, text: string): Record<string, unknown> => ({
  title,
  prompt: `Create ${file} in the repository root holding exactly the text ${text}, and nothing else.`,
  checks: [{ name: `${file} written`, expect: 'file-contains', file, value: text }],
});
const write = (file: string, text: string): string => reply.steps(`Set-Content -Path ${file} -Value '${text}' -Encoding utf8`);

function session(h: Harness, name: string, tasks: unknown[], vcs: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, onFailure: 'stop', vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: name, ...vcs }, review: { enabled: false }, tasks };
}

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

const tasks = async (h: Harness, id: string): Promise<Full[]> => (await h.session(id)).tasks as Full[];
const files = (h: Harness, ref: string): string[] => h.git('ls-tree', '--name-only', ref).split('\n').filter(Boolean);
const running = async (h: Harness): Promise<boolean> => (await h.call<{ running: boolean }>('GET', '/activity')).running;

/** Three tasks on one branch, each writing its own file. */
async function threeDone(h: Harness, name: string, third = task('third', 'c.txt', 'three')): Promise<string> {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, name, [task('first', 'a.txt', 'one'), task('second', 'b.txt', 'two'), third])] });
  const thirdFile = (third.checks as Array<{ file: string; value: string }>)[0]!;
  h.chat.script(write('a.txt', 'one'), reply.done(), write('b.txt', 'two'), reply.done(), write(thirdFile.file, thirdFile.value), reply.done());
  const ran = await h.run(s!.id);
  t.check('all three tasks done', ran.tasks.map((x) => x.status), ['done', 'done', 'done']);
  return s!.id;
}

await scenario('undo only this task: its commit reverted on the line, the task after it kept, it waits in the queue', {}, async (h) => {
  const id = await threeDone(h, 'undo-one');
  const [, second] = await tasks(h, id);
  const tipBefore = h.git('rev-parse', 'cop/undo-one');
  const preview = await h.call<Preview>('GET', `/sessions/${id}/tasks/${second!.id}/undo`);
  t.check('the preview names its one commit, the commit after it that stays, and the tasks "go back" would queue',
    [preview.this.ok, preview.this.branch, preview.this.commits.length, preview.this.later.length, preview.back.tasks.map((x) => x.title)],
    [true, 'cop/undo-one', 1, 1, ['second', 'third']]);
  t.check('nothing changed by looking', h.git('rev-parse', 'cop/undo-one'), tipBefore);

  const done = await h.call<{ ok: boolean; message: string }>('POST', `/sessions/${id}/tasks/${second!.id}/undo`, { how: 'this' });
  t.truthy('undone, and it says how', done.ok && /took the work of "second" out of cop\/undo-one/.test(done.message), done);
  t.check('b.txt is gone from the line; a.txt and c.txt are there', files(h, 'cop/undo-one'), ['README.md', 'a.txt', 'c.txt']);
  t.truthy('in one new commit on top, which names the task', h.git('log', '-1', '--format=%s', 'cop/undo-one') === 'Undo task 2 "second"' && h.git('rev-parse', 'cop/undo-one^') === tipBefore, h.git('log', '-3', '--oneline', 'cop/undo-one'));
  const after = await tasks(h, id);
  t.check('the task is queued again, the others still done', after.map((x) => x.status), ['done', 'queued', 'done']);
  t.check('its earlier attempt says it was undone, and by which commit', [after[1]!.attempts?.[0]?.undone?.how, after[1]!.attempts?.[0]?.undone?.commit], ['this', h.git('rev-parse', 'cop/undo-one')]);
  t.check('nothing was started', await running(h), false);
  t.check('the working tree is clean', h.git('status', '--porcelain'), '');

  h.chat.script(write('b.txt', 'two again'), reply.done());
  const redo = (await h.run(id)).tasks as Full[];
  t.check('run again, it is done on the same line, without its old work under it', [redo[1]!.status, redo[1]!.vcs?.branch, h.git('show', 'cop/undo-one:b.txt').trim(), files(h, 'cop/undo-one')], ['done', 'cop/undo-one', 'two again', ['README.md', 'a.txt', 'b.txt', 'c.txt']]);

  const queuedNow = await h.raw('POST', `/sessions/${id}/tasks/${redo[1]!.id}/undo`, { how: 'nonsense' });
  t.check('an answer that is neither way is refused', queuedNow.status, 400);
});

await scenario('undo only this task is refused, with nothing changed, when a later task changed the same lines', {}, async (h) => {
  const id = await threeDone(h, 'clash', task('third', 'b.txt', 'three'));
  const [, second] = await tasks(h, id);
  const tip = h.git('rev-parse', 'cop/clash');
  const r = await h.raw('POST', `/sessions/${id}/tasks/${second!.id}/undo`, { how: 'this' });
  t.truthy('refused, naming the file and the other way', r.status === 400 && /conflicts with what came after it, in b\.txt/.test(JSON.stringify(r.body)) && /Go back to before this task/.test(JSON.stringify(r.body)), r.body);
  t.check('the line, the tree and the task are as they were', [h.git('rev-parse', 'cop/clash'), h.git('status', '--porcelain'), (await tasks(h, id))[1]!.status], [tip, '', 'done']);
});

await scenario('go back to before this task: the line at its start, it and the tasks after it queued, nothing started', {}, async (h) => {
  const id = await threeDone(h, 'back');
  const [first, second] = await tasks(h, id);
  const base = second!.vcs?.baseCommit;
  const r = await h.call<{ ok: boolean; requeued: number; message: string }>('POST', `/sessions/${id}/tasks/${second!.id}/undo`, { how: 'back' });
  t.check('two tasks queued again', [r.ok, r.requeued], [true, 2]);
  const after = await tasks(h, id);
  t.check('the first stays done, the second and third wait', after.map((x) => x.status), ['done', 'queued', 'queued']);
  t.check('the folder is at the second task\'s start, on a branch of its own', [h.git('rev-parse', 'HEAD'), h.git('rev-parse', '--abbrev-ref', 'HEAD').startsWith('cop/restore-')], [base, true]);
  t.check('the old line keeps all three', files(h, 'cop/back'), ['README.md', 'a.txt', 'b.txt', 'c.txt']);
  t.check('both attempts say they were undone; the third by the second', [after[1]!.attempts?.[0]?.undone?.how, after[2]!.attempts?.[0]?.undone?.byTask], ['back', second!.id]);
  t.check('nothing was started, the first task untouched', [await running(h), after[0]!.attempt ?? 1, first!.attempt ?? 1], [false, 1, 1]);
});

await scenario('per-task branches: undo puts the folder back at the task\'s start and keeps its branch', {}, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'own', [task('alone', 'x.txt', 'ex')], { branchMode: 'per-task' })] });
  h.chat.script(write('x.txt', 'ex'), reply.done());
  const done = (await h.run(s!.id)).tasks[0] as Full;
  const preview = await h.call<Preview>('GET', `/sessions/${s!.id}/tasks/${done.id}/undo`);
  t.check('the preview says per-task, back to its start', [preview.this.ok, preview.this.perTask, preview.this.baseCommit], [true, true, done.vcs?.baseCommit]);
  await h.call('POST', `/sessions/${s!.id}/tasks/${done.id}/undo`, { how: 'this' });
  t.check('the folder is at its start, without its file', [h.git('rev-parse', 'HEAD'), files(h, 'HEAD')], [done.vcs?.baseCommit, ['README.md']]);
  t.check('its branch keeps the work', files(h, done.vcs!.branch!), ['README.md', 'x.txt']);
  t.check('and the task is queued again', (await tasks(h, s!.id))[0]!.status, 'queued');
  const again = await h.raw('POST', `/sessions/${s!.id}/tasks/${done.id}/undo`, { how: 'this' });
  t.truthy('a queued task has nothing to undo', again.status === 400 && /queued/.test(JSON.stringify(again.body)), again.body);
});

await scenario('a task that blocked is accepted as done, with what it was kept', { limits: { retryBlockedInFreshChat: 0 } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'accept', [task('hard', 'h.txt', 'hard')])] });
  h.chat.script(...reply.triedThenBlocked());
  const blocked = (await h.run(s!.id)).tasks[0]!;
  t.check('it blocked', blocked.status, 'blocked');
  const accepted = await h.call<Full>('POST', `/sessions/${s!.id}/tasks/${blocked.id}/accept`, { note: 'Done by hand in the branch.' });
  t.check('accepted as done, with what it was and the note', [accepted.status, accepted.accepted?.was, accepted.accepted?.note], ['done', 'blocked', 'Done by hand in the branch.']);
  const twice = await h.raw('POST', `/sessions/${s!.id}/tasks/${blocked.id}/accept`, {});
  t.truthy('a done task cannot be accepted again', twice.status >= 400 && /done already/.test(JSON.stringify(twice.body)), twice.body);
});

await scenario('notes to the chat: one on a queued task goes with its opening, one written while it runs with the next report', {}, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'notes', [task('noted', 'n.txt', 'noted')])] });
  const id = s!.tasks[0]!.id;
  const empty = await h.raw('POST', `/sessions/${s!.id}/tasks/${id}/notes`, { text: '  ' });
  t.check('an empty note is refused', empty.status, 400);
  await h.call('POST', `/sessions/${s!.id}/tasks/${id}/notes`, { text: 'Use UTF-8 without a BOM.' });
  h.chat.script(
    (m) => {
      t.truthy('the opening carries the note', m.text.includes('## A note from the operator about this task') && m.text.includes('Use UTF-8 without a BOM.'), m.text.slice(-500));
      return reply.steps('Get-ChildItem -Name');
    },
    async (m) => {
      t.truthy('the first report has no note of its own', !m.text.includes('while you work'), m.text.slice(0, 300));
      // Written while the task runs: it goes out with the report on this reply's steps.
      await h.call('POST', `/sessions/${s!.id}/tasks/${id}/notes`, { text: 'Also keep the file to one line.' });
      return write('n.txt', 'noted');
    },
    (m) => {
      t.truthy('the next report carries the note written while it ran', m.text.includes('## A note from the operator, while you work') && m.text.includes('Also keep the file to one line.'), m.text.slice(0, 800));
      return reply.done();
    },
  );
  const done = (await h.run(s!.id)).tasks[0] as Full;
  t.check('done, both notes marked sent with attempt 1', [done.status, done.notes?.map((n) => [!!n.sentAt, n.attempt])], ['done', [[true, 1], [true, 1]]]);
});

/*
 * The repository, read-only, for the workbench (2026-10-14): a folder and a file at the session's branch, the
 * commits on it with the task that made each, and nothing outside the repository.
 */
await scenario('the repository as the workbench reads it: files at the session\'s branch, its commits with their tasks', {}, async (h) => {
  const id = await threeDone(h, 'reader');
  const [first] = await tasks(h, id);
  const tree = await h.call<{ label: string; entries: Array<{ name: string; type: string }> }>('GET', `/sessions/${id}/repo/tree`);
  t.check('the root at the session\'s branch, folders first, names in the order a person reads them', [tree.label, tree.entries.map((e) => e.name)], ['cop/reader', ['a.txt', 'b.txt', 'c.txt', 'README.md']]);
  const file = await h.call<{ text: string | null; binary: boolean }>('GET', `/sessions/${id}/repo/file?path=b.txt`);
  t.check('a file\'s text', [file.text?.trim(), file.binary], ['two', false]);
  const atTask = await h.call<{ entries: Array<{ name: string }> }>('GET', `/sessions/${id}/repo/tree?task=${first!.id}`);
  t.check('at a task\'s own commit, what it left', atTask.entries.map((e) => e.name), ['a.txt', 'README.md']);
  const outside = await h.raw('GET', `/sessions/${id}/repo/file?path=../secret.txt`);
  t.check('a path out of the repository is refused', outside.status, 400);
  const log = await h.call<{ commits: Array<{ subject: string; taskTitle?: string }> }>('GET', `/sessions/${id}/repo/log`);
  t.check('the commits, newest first, each with the task that made it', log.commits.map((c) => c.taskTitle ?? '-'), ['third', 'second', 'first', '-']);
});

t.finish();
