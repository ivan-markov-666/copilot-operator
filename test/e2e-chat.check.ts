/**
 * The workbench's chat, like an IDE's (asked for on 2026-10-17), end to end through the API with the scripted
 * chat of test/support/fakeChat.ts.
 *
 * - the open project folder (Settings → project folder) read as it is on disk: its files and one file, nothing
 *   outside it or in .git;
 * - a message makes a conversation there with no version control of the bot's own: it runs on the branch the
 *   folder is on, with the operator's uncommitted work in it, and commits nothing;
 * - before each message the folder is photographed, after it again: its changed files are on the record;
 * - git is the operator's in the chat: switching branches is allowed, pushing is refused;
 * - the next message goes into the same Copilot conversation; one written while it works is a note;
 * - going back to before a message puts the folder exactly as it was then — branch, files, uncommitted work —
 *   takes it and the messages after it out of the conversation, keeps the folder as it was in a safety record,
 *   and tells the next message what was undone.
 *
 *   npm run check:e2e-chat
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, waitFor, Tally, type Harness, type TaskView } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;
type Sent = { threadId: string; taskId: string; noted?: boolean; needsStart: boolean };
type Thread = { id: string; name: string; turns: number };
type Full = TaskView & { notes?: Array<{ text: string; sentAt?: string }>; checkpoint?: { commit: string; branch: string }; vcs?: { files?: Array<{ path: string }>; baseCommit?: string; commit?: string } };
type ChatSession = { id: string; kind?: string; model?: string; review?: { enabled: boolean }; planMode?: string; vcs?: { enabled?: boolean }; chat?: { chatId: string }; tasks: Full[]; rewound?: Array<{ tasks: unknown[]; safety: string }> };

console.log('\n--- the chat works in the open folder, on its branch, and can go back to before any message ---');
let h: Harness | null = null;
try {
  h = await startHarness();
  const repo = h.repo;
  const file = (p: string): string | null => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), 'utf8').trim() : null);
  const ws = await h.call<{ ok: boolean; isRepo: boolean; branch?: string }>('GET', '/workspace');
  t.check('the open folder is the project folder, a repository on main', [ws.ok, ws.isRepo, ws.branch], [true, true, 'main']);
  writeFileSync(join(repo, 'notes.md'), 'draft\n', 'utf8');
  const files = await h.call<{ files: string[] }>('GET', '/workspace/files');
  t.check('its files as they are on disk, one not committed yet included', files.files, ['README.md', 'notes.md']);
  t.check('one of them, as text', (await h.call<{ text: string | null }>('GET', '/workspace/file?path=notes.md')).text, 'draft\n');
  t.check('a path out of the folder is refused', (await h.raw('GET', '/workspace/file?path=../outside.txt')).status, 400);
  t.check('and so is git\'s own folder', (await h.raw('GET', '/workspace/file?path=.git/config')).status, 400);
  t.check('an empty message is refused', (await h.raw('POST', '/chat', { text: '  ' })).status, 400);

  const headBefore = h.git('rev-parse', 'HEAD');
  const first = await h.call<Sent>('POST', '/chat', { text: 'Create hi.txt holding exactly the word hi.', model: 'Think deeper' });
  t.check('a first message makes a conversation and asks nothing about where the work starts', [!!first.threadId, first.needsStart], [true, false]);
  const made = await h.call<ChatSession>('GET', `/sessions/${first.threadId}`);
  t.check('a chat conversation: no version control of its own, no review, plan mode off, the model chosen in the chat', [made.kind, made.vcs?.enabled, made.review?.enabled, made.planMode, made.model], ['chat', false, false, 'off', 'Think deeper']);

  h.chat.script(reply.steps(write('hi.txt', 'hi')), reply.done());
  const one = (await h.run(first.threadId)).tasks[0] as Full;
  t.check('it ran on main, in the folder with the operator\'s uncommitted work, and committed nothing', [one.status, h.git('rev-parse', '--abbrev-ref', 'HEAD'), h.git('rev-parse', 'HEAD'), file('hi.txt'), file('notes.md')], ['done', 'main', headBefore, 'hi', 'draft']);
  t.check('the folder before it is kept, and what it changed is on the record', [one.checkpoint?.branch, !!one.checkpoint?.commit, one.vcs?.files?.map((f) => f.path)], ['main', true, ['hi.txt']]);
  const chatId = (await h.call<ChatSession>('GET', `/sessions/${first.threadId}`)).chat?.chatId;

  // The second message changes the first's file, adds one, and makes a branch: the git is the operator's here.
  const second = await h.call<Sent>('POST', '/chat', { text: 'Make hi.txt say hello, add bye.txt, and work on a new branch feature/greet.', threadId: first.threadId });
  t.check('the next message is the next task of the same conversation', [second.threadId, second.needsStart], [first.threadId, false]);
  h.chat.script(
    (m) => {
      t.check('it goes into the same Copilot conversation', m.chatId, chatId);
      t.truthy('which is told git is the operator\'s here', m.text.includes('## Working in the operator\'s folder') && m.text.includes('may switch or create a branch'), m.text.slice(-900));
      return reply.steps('git switch -c feature/greet', write('hi.txt', 'hello'), write('bye.txt', 'bye'), 'git push origin feature/greet');
    },
    (m) => {
      t.truthy('pushing is refused, switching is not', /refused/i.test(m.text), m.text.slice(0, 900));
      return reply.done('I made feature/greet, changed hi.txt to hello and added bye.txt; the push was refused.');
    },
  );
  const two = (await h.run(first.threadId)).tasks[1] as Full;
  t.check('done, on the new branch, with its changes', [two.status, h.git('rev-parse', '--abbrev-ref', 'HEAD'), file('hi.txt'), file('bye.txt')], ['done', 'feature/greet', 'hello', 'bye']);
  t.check('its changed files on the record', two.vcs?.files?.map((f) => f.path).sort(), ['bye.txt', 'hi.txt']);

  // Back to before the second message.
  const back = await h.call<{ ok: boolean; text: string; safety: string }>('POST', `/chat/${first.threadId}/rewind`, { taskId: two.id });
  t.check('going back answers with the message, to write again', back.text, 'Make hi.txt say hello, add bye.txt, and work on a new branch feature/greet.');
  t.check('the folder is as it was before it: main, hi.txt from the first message, no bye.txt, the operator\'s draft', [h.git('rev-parse', '--abbrev-ref', 'HEAD'), h.git('rev-parse', 'HEAD'), file('hi.txt'), file('bye.txt'), file('notes.md')], ['main', headBefore, 'hi', null, 'draft']);
  const after = await h.call<ChatSession>('GET', `/sessions/${first.threadId}`);
  t.check('that message is out of the conversation, and kept on the record', [after.tasks.map((x) => x.title), after.rewound?.[0]?.tasks.length], [['Create hi.txt holding exactly the word hi.'], 1]);
  t.truthy('the folder as it was before going back is kept in a safety record', h.git('cat-file', '-t', back.safety) === 'commit' && h.git('show', `${back.safety}:bye.txt`).trim() === 'bye', back.safety);
  t.check('the branch the message made is the operator\'s, left alone', h.git('branch', '--list', 'feature/greet').replace('*', '').trim(), 'feature/greet');

  await h.call<Sent>('POST', '/chat', { text: 'Add a line to hi.txt.', threadId: first.threadId });
  h.chat.script(
    (m) => {
      t.truthy('the next message tells the chat what was undone', m.text.includes('The operator went back to before the message "Make hi.txt say hello'), m.text.slice(-900));
      return reply.steps('Get-Content hi.txt');
    },
    reply.done(),
  );
  await h.run(first.threadId);

  // A message written while it works: a note, at the next report.
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
      return reply.steps(write('three.txt', 'three'));
    },
    reply.done(),
  );
  t.check('the third message runs', (await h.call<{ started: boolean }>('POST', `/sessions/${first.threadId}/start`, { mode: 'unattended' })).started, true);
  await waitFor('the message to reach the chat', async () => h!.chat.sent.some((m) => m.text.includes('Then write three.txt holding exactly three.')), 20_000);
  const busy = await h.raw('POST', `/chat/${first.threadId}/rewind`, { taskId: one.id });
  t.check('going back is refused while it works', busy.status, 400);
  const noted = await h.call<Sent>('POST', '/chat', { text: 'Use three, not 3.', threadId: first.threadId });
  t.check('written while it works, a message is a note to the task in flight', noted.noted, true);
  release();
  await h.idle();

  // All the way back: the folder as it was before the first message.
  const start = await h.call<{ ok: boolean }>('POST', `/chat/${first.threadId}/rewind`, { taskId: one.id });
  t.check('back to before the first message: no hi.txt, no three.txt, the draft kept, nothing left in the conversation', [start.ok, file('hi.txt'), file('three.txt'), file('notes.md'), (await h.call<ChatSession>('GET', `/sessions/${first.threadId}`)).tasks.length], [true, null, null, 'draft', 0]);

  await h.call<Sent>('POST', '/chat', { text: 'A different question in a new conversation.' });
  const threads = await h.call<Thread[]>('GET', '/chat/threads');
  t.check('the conversations, newest first', threads.map((x) => x.name), ['chat: A different question in a new conversation.', 'chat: Create hi.txt holding exactly the word hi.']);
  t.check('a message to a conversation that is not there is refused', (await h.raw('POST', '/chat', { text: 'hello', threadId: 'nope' })).status >= 400, true);

  t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  t.check('every scripted reply was used', h.chat.pending, 0);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h?.stop();
}
t.finish();
