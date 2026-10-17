/**
 * The workbench's chat, like an IDE's (asked for on 2026-10-17: "I write instructions in the chat and it starts
 * making changes, like Windsurf"), end to end through the API with the scripted chat of test/support/fakeChat.ts.
 *
 * - the open project folder (Settings → project folder) read as it is on disk: its files and one file, nothing
 *   outside it;
 * - a first message makes a conversation there — one branch, no review, plan mode off — and is a task of it;
 * - run, its commands run in the folder; a second message goes into the same Copilot conversation and on the
 *   same branch, building on the first, with no contract sent again;
 * - a message written while it works is a note the chat gets with the next report;
 * - the conversations are listed newest first.
 *
 *   npm run check:e2e-chat
 */
import { startHarness, waitFor, Tally, type Harness, type TaskView } from './support/harness.js';
import { reply } from './support/fakeChat.js';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const t = new Tally();
const write = (file: string, text: string): string => reply.steps(`Set-Content -Path ${file} -Value '${text}' -Encoding utf8`);
type Sent = { threadId: string; taskId: string; noted?: boolean; needsStart: boolean };
type Thread = { id: string; name: string; turns: number };
type Full = TaskView & { notes?: Array<{ text: string; sentAt?: string }> };
type ChatSession = { id: string; kind?: string; review?: { enabled: boolean }; planMode?: string; vcs?: { enabled?: boolean; branchMode?: string; repoDir?: string }; chat?: { chatId: string }; tasks: Full[] };

console.log('\n--- the chat works in the open project folder, one conversation and one branch for all its messages ---');
let h: Harness | null = null;
try {
  h = await startHarness();
  await h.call('PUT', '/settings', { ...(await h.call<{ raw: Record<string, unknown> }>('GET', '/settings')).raw, project: { rootDir: h.repo } });
  const ws = await h.call<{ ok: boolean; isRepo: boolean; branch?: string }>('GET', '/workspace');
  t.check('the open folder is the project folder, a repository on main', [ws.ok, ws.isRepo, ws.branch], [true, true, 'main']);
  writeFileSync(join(h.repo, 'notes.md'), 'draft\n', 'utf8');
  const files = await h.call<{ files: string[] }>('GET', '/workspace/files');
  t.check('its files as they are on disk, a new one not committed yet included', files.files, ['README.md', 'notes.md']);
  const file = await h.call<{ text: string | null }>('GET', '/workspace/file?path=notes.md');
  t.check('one of them, as text', file.text, 'draft\n');
  const outside = await h.raw('GET', '/workspace/file?path=../outside.txt');
  t.check('a path out of the folder is refused', outside.status, 400);
  const gitDir = await h.raw('GET', '/workspace/file?path=.git/config');
  t.check('and so is git\'s own folder', gitDir.status, 400);
  rmSync(join(h.repo, 'notes.md'));

  const empty = await h.raw('POST', '/chat', { text: '  ' });
  t.check('an empty message is refused', empty.status, 400);
  const first = await h.call<Sent>('POST', '/chat', { text: 'Create hello.txt holding exactly the word hi.' });
  t.check('the first message makes a conversation, asks where the work starts', [!!first.threadId, first.needsStart, first.noted ?? false], [true, true, false]);
  const made = await h.call<ChatSession>('GET', `/sessions/${first.threadId}`);
  t.check('a chat conversation in the folder: one branch, no review, plan mode off', [made.kind, made.vcs?.branchMode, made.vcs?.repoDir, made.review?.enabled, made.planMode], ['chat', 'per-session', h.repo, false, 'off']);
  t.check('its message is a queued task', made.tasks.map((x) => [x.prompt, x.status]), [['Create hello.txt holding exactly the word hi.', 'queued']]);

  h.chat.script(write('hello.txt', 'hi'), reply.done());
  const one = await h.run(first.threadId);
  const branch = one.tasks[0]!.vcs?.branch ?? '';
  t.check('run, its command ran in the folder and the work is on the conversation\'s branch', [one.tasks[0]!.status, h.git('show', `${branch}:hello.txt`).trim()], ['done', 'hi']);
  const chatId = (await h.call<ChatSession>('GET', `/sessions/${first.threadId}`)).chat?.chatId;

  const second = await h.call<Sent>('POST', '/chat', { text: 'Now add bye.txt holding exactly bye.', threadId: first.threadId });
  t.check('a second message is the next task of the same conversation, started where it is', [second.threadId, second.needsStart], [first.threadId, false]);
  h.chat.script(
    (m) => {
      t.check('it goes into the same Copilot conversation', m.chatId, chatId);
      t.truthy('with the message, and no contract again', m.text.includes('Now add bye.txt holding exactly bye.') && m.contract === undefined, m.text.slice(0, 300));
      return write('bye.txt', 'bye');
    },
    reply.done(),
  );
  const two = await h.run(first.threadId);
  t.check('on the same branch, building on the first message\'s work', [two.tasks[1]!.status, two.tasks[1]!.vcs?.branch, h.git('ls-tree', '--name-only', branch).split('\n')], ['done', branch, ['README.md', 'bye.txt', 'hello.txt']]);
  t.check('the contract was sent once in all', h.chat.sent.filter((m) => m.contract === 'task').length, 1);

  // A message while it works: held at the chat's first reply until the note is in.
  await h.call('POST', '/chat', { text: 'Then write three.txt holding exactly three.', threadId: first.threadId });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  h.chat.script(
    async () => {
      await gate;
      return reply.steps('Get-ChildItem -Name');
    },
    (m) => {
      t.truthy('a message written while it worked reaches the chat with the next report', m.text.includes('Use three, not 3.'), m.text.slice(0, 600));
      return write('three.txt', 'three');
    },
    reply.done(),
  );
  const started = await h.call<{ started: boolean }>('POST', `/sessions/${first.threadId}/start`, { mode: 'unattended' });
  t.check('the third message runs', started.started, true);
  await waitFor('the third task to be running', async () => (await h!.call<ChatSession>('GET', `/sessions/${first.threadId}`)).tasks[2]?.status === 'running', 20_000);
  // The note after its message has gone out, so it is the next report that carries it, not the opening.
  await waitFor('the third message to reach the chat', async () => h!.chat.sent.some((m) => m.text.includes('Then write three.txt holding exactly three.')), 20_000);
  const noted = await h.call<Sent>('POST', '/chat', { text: 'Use three, not 3.', threadId: first.threadId });
  t.check('written while it works, a message is a note to the task in flight', [noted.noted, noted.taskId], [true, (await h.call<ChatSession>('GET', `/sessions/${first.threadId}`)).tasks[2]!.id]);
  release();
  await h.idle();
  const after = await h.call<ChatSession>('GET', `/sessions/${first.threadId}`);
  t.check('three messages, three tasks, all done; the note marked sent', [after.tasks.map((x) => x.status), after.tasks[2]!.notes?.map((n) => !!n.sentAt)], [['done', 'done', 'done'], [true]]);

  await h.call<Sent>('POST', '/chat', { text: 'A different question in a new conversation.' });
  const threads = await h.call<Thread[]>('GET', '/chat/threads');
  t.check('the conversations, newest first, with their messages counted', threads.map((x) => [x.name, x.turns]), [['chat: A different question in a new conversation.', 1], ['chat: Create hello.txt holding exactly the word hi.', 3]]);
  const gone = await h.raw('POST', '/chat', { text: 'hello', threadId: 'nope' });
  t.check('a message to a conversation that is not there is refused', gone.status >= 400, true);

  t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  t.check('every scripted reply was used', h.chat.pending, 0);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h?.stop();
}
t.finish();
