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
 *   and tells the next message what was undone;
 * - the browser window stays open when the work on a message has ended, says so in it with an OK, and is the one
 *   the next message works in, in this conversation or a new one (2026-10-19); closed with its X between messages,
 *   the next one opens a new window; closed while a message is worked, that message is stopped, not failed; Stop
 *   leaves it open; a run that is not the chat's, reading the models, and closing the program close it.
 *
 *   npm run check:e2e-chat
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startHarness, waitFor, Tally, type Harness, type TaskView } from './support/harness.js';
import { reply } from './support/fakeChat.js';
import { chatNotice } from '../src/session/chatNotice.js';

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
  t.check('the browser window stays open when the work on the message has ended', [h.chat.opened, h.chat.closed, h.chat.windows.length], [1, 0, 1]);
  const card = h.chat.noticeUp;
  t.check('and says so in it, with the message, that it stays open, and an OK', [card?.tone, card?.title, card?.subject, card?.lines, card?.button], [
    'done',
    'The task is done',
    '“Create hi.txt holding exactly the word hi.”',
    ['Copilot finished it. What was done is in the copilot-operator chat.', 'This window stays open for your next message. You can close it at any time.'],
    'OK',
  ]);
  const signInsAfterOne = h.chat.signIns;
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
  t.check('worked in the window the first left open: not opened again, the sign-in looked at again, the card taken away first', [h.chat.opened, h.chat.closed, h.chat.signIns - signInsAfterOne, h.chat.noticesCleared, h.chat.notices.length], [1, 0, 1, 1, 2]);
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

  /*
   * "New chat" (2026-10-18): a message with no conversation named starts a new one, in a new Copilot conversation,
   * with nothing of the first in it.
   */
  const other = await h.call<Sent>('POST', '/chat', { text: 'A different question in a new conversation.', model: 'Think deeper' });
  t.truthy('a new chat is a conversation of its own', other.threadId !== first.threadId, other);
  const twoLines = "Write-Output 'line one'\nWrite-Output 'line two'";
  h.chat.script(reply.steps(write('other.txt', 'other'), twoLines), reply.done('I wrote other.txt and printed two lines.'));
  const otherRan = (await h.run(other.threadId)).tasks[0] as Full;
  const otherChat = (await h.call<ChatSession>('GET', `/sessions/${other.threadId}`)).chat?.chatId;
  t.check('it ran in a Copilot conversation of its own', [otherRan.status, !!otherChat && otherChat !== chatId], ['done', true]);
  t.check('in the same browser window, still open', [h.chat.opened, h.chat.closed, h.chat.windows.length], [1, 0, 1]);
  t.truthy('which was not told anything of the first', !h.chat.sent.filter((m) => m.chatId === otherChat).some((m) => m.text.includes('hi.txt')), h.chat.sent.filter((m) => m.chatId === otherChat).map((m) => m.text.slice(0, 120)));

  /*
   * One JSON per message (2026-10-18): everything between the bot and Copilot for that message — every message sent,
   * every reply, every command with its whole output — and nothing of the other messages.
   */
  type Entry = { kind: string; at?: string; n?: number; text?: string; attachments?: Array<{ name: string; text: string | null }>; command?: string; output?: string; exitCode?: number; outcome?: string; shell?: string; cwd?: string };
  type Exchange = { format: string; version: number; session: { id: string }; task: { id: string; message: string; status: string }; attempts: Array<{ runId: string; conversation: { chatId: string } | null; counts: Record<string, number>; entries: Entry[]; events: unknown[] }> };
  const exchange = await h.call<Exchange>('GET', `/sessions/${other.threadId}/tasks/${otherRan.id}/exchange`);
  const [attempt] = exchange.attempts;
  const kinds = (attempt?.entries ?? []).map((e) => e.kind);
  t.check('the message\'s JSON: its format, the message as written, how it ended, one attempt in its own conversation', [exchange.format, exchange.version, exchange.task.message, exchange.task.status, exchange.attempts.length, attempt?.conversation?.chatId], ['copilot-operator.task-exchange', 1, 'A different question in a new conversation.', 'done', 1, otherChat]);
  const sentToCopilot = h.chat.sent.filter((m) => m.chatId === otherChat || (!m.chatId && m.text.includes('A different question')));
  t.check('every message the bot sent, word for word, in order', (attempt?.entries ?? []).filter((e) => e.kind === 'sent').map((e) => e.text), sentToCopilot.map((m) => m.text));
  t.truthy('the task\'s own message is among them', (attempt?.entries ?? []).some((e) => e.kind === 'sent' && (e.text ?? '').includes('A different question in a new conversation.')), kinds);
  t.check('every reply, the steps and the "done" as Copilot wrote them', (attempt?.entries ?? []).filter((e) => e.kind === 'reply').length, (attempt?.counts.replies ?? -1));
  t.truthy('a reply holds what Copilot wrote', (attempt?.entries ?? []).some((e) => e.kind === 'reply' && (e.text ?? '').includes('I wrote other.txt and printed two lines.')), (attempt?.entries ?? []).filter((e) => e.kind === 'reply').map((e) => (e.text ?? '').slice(0, 200)));
  const commands = (attempt?.entries ?? []).filter((e) => e.kind === 'command');
  t.check('every command that ran, with its exit code', commands.map((c) => [c.command, c.exitCode, c.outcome]), [[write('other.txt', 'other'), 0, 'completed'], [twoLines, 0, 'completed']]);
  t.check('a command of two lines whole, and its output only what it printed', [commands[1]?.output?.split(/\r?\n/).map((l) => l.trim())], [['line one', 'line two']]);
  t.truthy('with the shell and the folder it ran in', commands.every((c) => c.shell === 'pwsh' && !!c.cwd && c.cwd.toLowerCase() === (repo ?? '').toLowerCase()), commands.map((c) => [c.shell, c.cwd]));
  t.truthy('the results file sent with the report, with what it said', (attempt?.entries ?? []).some((e) => e.kind === 'sent' && (e.attachments ?? []).some((a) => /iteration-1\.txt$/.test(a.name) && (a.text ?? '').includes('line two'))), (attempt?.entries ?? []).filter((e) => e.kind === 'sent').map((e) => e.attachments));
  t.truthy('in time order, and the run\'s own record beside it', (attempt?.entries ?? []).every((e, i, all) => i === 0 || (all[i - 1]!.at ?? '') <= (e.at ?? '')) && (attempt?.events.length ?? 0) > 0, kinds);
  t.truthy('nothing of the other conversation\'s messages in it', !JSON.stringify(exchange).includes('hi.txt'), 'hi.txt found in the other message\'s JSON');
  t.check('a task that is not there: refused', (await h.raw('GET', `/sessions/${other.threadId}/tasks/nope/exchange`)).status, 400);

  // In the language the workbench was in when the message was written.
  await h.call<Sent>('POST', '/chat', { text: 'Покажи файловете.', threadId: other.threadId, lang: 'bg' });
  h.chat.script(reply.steps('Get-ChildItem -Name'), reply.done());
  await h.run(other.threadId);
  const bg = h.chat.noticeUp;
  t.check('the card in Bulgarian, for a message written with the workbench in Bulgarian', [bg?.title, bg?.subject, bg?.lines.at(-1), bg?.button], ['Заданието е изпълнено', '„Покажи файловете.“', 'Прозорецът остава отворен за следващото ви съобщение. Можете да го затворите по всяко време.', 'ОК']);

  // Closed with its X between two messages: the next one opens a new window.
  t.check('the operator closes the window with its X', [h.chat.closeByHand(), h.chat.windows.length], [true, 0]);
  await h.call<Sent>('POST', '/chat', { text: 'List the files again.', threadId: other.threadId });
  h.chat.script(reply.steps('Get-ChildItem -Name'), reply.done());
  const openedBefore = h.chat.opened;
  const relisted = (await h.run(other.threadId)).tasks.at(-1) as Full;
  t.check('the next message opens a new window, works in it, and leaves it open', [relisted.status, h.chat.opened - openedBefore, h.chat.windows.length, h.chat.noticeUp?.tone], ['done', 1, 1, 'done']);

  // Closed with its X while a message is worked: that message is stopped, as the operator stopping it, and nothing more is sent.
  await h.call<Sent>('POST', '/chat', { text: 'Write four.txt holding exactly four.', threadId: other.threadId });
  const sentBefore = h.chat.sent.length;
  h.chat.script((m) => {
    m.world.closeByHand();
    return reply.steps(write('four.txt', 'four'));
  });
  const cut = (await h.run(other.threadId)).tasks.at(-1) as Full;
  t.check('closed while it works: the message ends stopped, said so, its steps not run, nothing more sent', [cut.status, cut.reason, file('four.txt'), h.chat.sent.length - sentBefore], ['aborted', 'the browser window was closed; nothing more was sent', null, 1]);
  t.check('no window is left, and none was opened again for it', [h.chat.windows.length, h.chat.opened - openedBefore], [0, 1]);
  const cutEvents = await h.call<Array<{ type: string; message: string }>>('GET', `/sessions/${other.threadId}/events`).catch(() => [] as Array<{ type: string; message: string }>);
  t.truthy('not said as an error', !cutEvents.some((e) => e.type === 'session-error' || e.type === 'task-error'), cutEvents.filter((e) => /error/.test(e.type)).map((e) => e.message));
  await h.call<Sent>('POST', '/chat', { text: 'Write four.txt holding exactly four, again.', threadId: other.threadId });
  h.chat.script(reply.steps(write('four.txt', 'four')), reply.done());
  const again = (await h.run(other.threadId)).tasks.at(-1) as Full;
  t.check('the message after it opens a window again and works', [again.status, file('four.txt'), h.chat.windows.length, h.chat.opened - openedBefore], ['done', 'four', 1, 2]);

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

console.log('\n--- the window the chat leaves open: Stop leaves it, anything else that needs the browser closes it first ---');
h = null;
try {
  h = await startHarness();
  const looked = 'Get-ChildItem -Name';
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Look at the files.', model: 'Think deeper' });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  h.chat.script(async () => {
    await gate;
    return reply.steps(looked);
  });
  t.check('a message runs', (await h.call<{ started: boolean }>('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' })).started, true);
  await waitFor('the message to reach the chat', async () => h!.chat.sent.some((m) => m.text.includes('Look at the files.')), 20_000);
  t.check('Stop is pressed while it works', (await h.call<{ stopping: boolean }>('POST', `/sessions/${sent.threadId}/stop`)).stopping, true);
  release();
  await h.idle();
  const stopped = (await h.session(sent.threadId)).tasks[0];
  t.check('stopped, and the window is left open, saying it was stopped', [stopped?.status, h.chat.windows.length, h.chat.noticeUp?.tone, h.chat.noticeUp?.title], ['aborted', 1, 'stopped', 'The task was stopped']);
  // Its photograph after it is not a commit: it was said as one, "committed … on undefined", for every message not done.
  t.truthy('its reason claims no commit the chat never makes', !/committed/.test(stopped?.reason ?? ''), stopped?.reason);

  // Reading the models needs the browser: the chat's window is closed first, then the models' own.
  const [opened, closed] = [h.chat.opened, h.chat.closed];
  await h.call('POST', '/models/refresh');
  t.check('reading the models closes the window the chat left open, and its own after it', [h.chat.opened - opened, h.chat.closed - closed, h.chat.windows.length], [1, 2, 0]);

  // A session's run that is not the chat's: the chat's window is closed before its own opens, and its own closed at its end.
  await h.call<Sent>('POST', '/chat', { text: 'Look at the files again.', threadId: sent.threadId });
  h.chat.script(reply.steps(looked), reply.done());
  await h.run(sent.threadId);
  t.check('the next message opens a window and leaves it open', h.chat.windows.length, 1);
  const [plain] = await h.importPlan({
    version: 1,
    sessions: [{ name: 'plain-session', onFailure: 'stop', vcs: { enabled: false }, review: { enabled: false }, tasks: [{ title: 'look', prompt: 'List the files in the repository root.' }] }],
  });
  h.chat.script(reply.steps(looked), reply.done());
  const [opened2, closed2] = [h.chat.opened, h.chat.closed];
  const ran = await h.run(plain!.id);
  t.check('a run that is not the chat\'s: the chat\'s window closed first, its own opened and closed at its end', [ran.tasks[0]?.status, h.chat.opened - opened2, h.chat.closed - closed2, h.chat.windows.length], ['done', 1, 2, 0]);
  t.check('and it said nothing in a window of its own', h.chat.notices.length, 2);

  await h.call<Sent>('POST', '/chat', { text: 'One more look.', threadId: sent.threadId });
  h.chat.script(reply.steps(looked), reply.done());
  await h.run(sent.threadId);
  t.check('a window kept open again', h.chat.windows.length, 1);

  // Closed with its X while the sign-in is looked at: in the window kept open, and in one being opened.
  type Failure = { message: string; sessions: Array<{ id: string }> };
  const failuresBefore = (await h.call<Failure[]>('GET', '/start/failures')).length;
  await h.call<Sent>('POST', '/chat', { text: 'Look once more.', threadId: sent.threadId });
  h.chat.closeOnSignIn = 1;
  let thread = await h.run(sent.threadId);
  t.check('closed while the kept window\'s sign-in is looked at: stopped, the message still queued, no window left', [thread.tasks.at(-1)?.status, h.chat.windows.length, h.chat.sent.some((m) => m.text.includes('Look once more.'))], ['queued', 0, false]);
  h.chat.closeOnSignIn = 1;
  const opened3 = h.chat.opened;
  thread = await h.run(sent.threadId);
  t.check('closed while a new window waits for the sign-in: stopped the same way, the window let go of', [thread.tasks.at(-1)?.status, h.chat.windows.length, h.chat.opened - opened3], ['queued', 0, 1]);
  const stops = (await h.call<Array<{ type: string; message: string }>>('GET', `/sessions/${sent.threadId}/events`)).filter((e) => e.type === 'session-stopped' || e.type === 'session-error').slice(-2);
  t.check('both said as stops, neither as an error', stops.map((e) => [e.type, e.message]), [
    ['session-stopped', 'the browser window was closed before the first task was sent; the tasks stay queued'],
    ['session-stopped', 'the browser window was closed before the first task was sent; the tasks stay queued'],
  ]);
  t.check('and neither recorded as a start that failed', (await h.call<Failure[]>('GET', '/start/failures')).length, failuresBefore);
  h.chat.script(reply.steps(looked), reply.done());
  thread = await h.run(sent.threadId);
  t.check('started again, it opens a window and works', [thread.tasks.at(-1)?.status, h.chat.windows.length], ['done', 1]);
  await h.stop();
  t.check('closed with the program, so every window opened was closed', [h.chat.windows.length, h.chat.opened, h.chat.closed], [0, h.chat.opened, h.chat.opened]);
  t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  t.check('every scripted reply was used', h.chat.pending, 0);
  h = null;
} catch (e) {
  t.truthy('the window scenarios ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h?.stop();
}

console.log('\n--- Kerrigan, the editor saving a file, and plan mode in the chat (2026-10-20) ---');
h = null;
try {
  h = await startHarness({ settings: { limits: { maxIterations: 33, maxRunMinutes: 44 }, execution: { mode: 'unattended', isolation: 'none-accepted' } } });
  // Kerrigan: the persona, in the language asked for, with this machine's limits.
  type Kerrigan = { lang: string; fileName: string; text: string; filled: boolean };
  const k = await h.call<Kerrigan>('GET', '/kerrigan?lang=en');
  t.check('Kerrigan in English: her name, the file to save her as', [k.lang, k.fileName, k.text.split('\n')[0], k.filled], ['en', 'kerrigan-copilot-operator.en.md', '# Kerrigan — a helper for copilot-operator', true]);
  t.truthy('with the limits Settings give', k.text.includes('at most 33 messages to Copilot and 44 minutes per task'), k.text.slice(0, 1500));
  t.truthy('and the chat\'s screen, named as it is', k.text.includes('"New chat"') && k.text.includes('"Plan mode"') && k.text.includes('## The chat\'s screen'), '');
  /*
   * What is new since 2026-10-20 is in her, and what went is not: Pause, Review, the editor, Settings with its
   * projects; no Sessions, no task register, no plan from JSON, no presets, no "prepare the folder".
   */
  t.truthy('she knows Pause, Review, the editor and Settings', ['"Pause"', '"Continue"', '"Review"', 'saved with Ctrl+S', '## Settings, and what is on them', '"Level 2 template (for Kerrigan)"'].every((x) => k.text.includes(x)), k.text.slice(0, 600));
  t.check('and says nothing of what went', ['Sessions page', 'task register', 'Import a plan', 'presets', 'remote main', 'Level 1 prompt'].filter((x) => k.text.includes(x)), []);
  const kb = await h.call<Kerrigan>('GET', '/kerrigan?lang=bg');
  t.check('in Bulgarian: in Bulgarian', [kb.lang, kb.fileName, kb.text.split('\n')[0]], ['bg', 'kerrigan-copilot-operator.bg.md', '# Кериган — помощник за copilot-operator']);
  // Another language of the interface: her prose in English, the controls' names left for the page, in its language.
  const kd = await h.call<Kerrigan>('GET', '/kerrigan?lang=de');
  t.check('in German: her own file, the names left to the page', [kd.lang, kd.fileName, kd.filled, kd.text.split('\n')[0]], ['de', 'kerrigan-copilot-operator.de.md', false, '# Kerrigan — a helper for copilot-operator']);
  t.truthy('as ⟦key⟧, each a key of the dictionary', kd.text.includes('**"⟦chat.newChat⟧"**') && !/⟦[^⟧]*[^\w.-⟧][^⟧]*⟧/.test(kd.text), kd.text.slice(0, 400));
  t.check('a code that is not a language: English', (await h.call<Kerrigan>('GET', '/kerrigan?lang=x!y')).lang, 'en');

  /*
   * The projects (2026-10-20): each with its branch now and the level 2 the operator wrote for it, saved in Settings
   * and carried by Kerrigan; the level 2 of another project kept when the list is saved without it.
   */
  const projectRepo = h.repo;
  const git = (...args: string[]): string => execFileSync('git', ['-C', projectRepo, ...args], { encoding: 'utf8' }).trim();
  git('checkout', '-q', '-b', 'feature/kerrigan');
  const other = join(h.base, 'tests-repo');
  mkdirSync(other, { recursive: true });
  type Project = { name: string; rootDir: string; branch?: string; level2: string; others: Array<{ name: string; rootDir: string; branch?: string; level2: string }> };
  await h.call('PUT', '/project', { level2: 'The fixture. Tests: none. Never touch README.md.', others: [{ name: 'the tests', rootDir: other, level2: 'Where the tests live.' }] });
  const proj = await h.call<Project>('GET', '/project');
  t.check('the project: its branch now and its level 2', [proj.branch, proj.level2], ['feature/kerrigan', 'The fixture. Tests: none. Never touch README.md.']);
  t.check('the other project: its level 2, and no branch outside a repository', [proj.others[0]?.level2, proj.others[0]?.branch], ['Where the tests live.', undefined]);
  await h.call('PUT', '/project', { others: [{ name: 'the tests, renamed', rootDir: other }] });
  t.check('saved without it, the other project keeps its level 2', (await h.call<Project>('GET', '/project')).others[0]?.level2, 'Where the tests live.');
  const tooLong = await h.raw('PUT', '/project', { level2: 'x'.repeat(8001) });
  t.check('a level 2 longer than 8 000 characters is refused', tooLong.status, 400);
  const kp = await h.call<Kerrigan>('GET', '/kerrigan?lang=en');
  const part = kp.text.slice(kp.text.indexOf('## The projects'), kp.text.indexOf('## How you help'));
  t.truthy('Kerrigan carries every project: name, folder, branch, level 2', part.includes('(the chat\'s folder)') && part.includes('`feature/kerrigan`') && part.includes('Never touch README.md') && part.includes('### the tests, renamed') && part.includes('Where the tests live.'), part);

  // What went with the pages (2026-10-20): editing the base prompt, the presets, preparing a folder from the remote main.
  const gone = await Promise.all([
    h.raw('PUT', '/level1', { content: 'x'.repeat(200) }),
    h.raw('DELETE', '/level1'),
    h.raw('GET', '/presets'),
    h.raw('POST', '/repo/prepare/preview', { dir: h.repo }),
    h.raw('POST', '/repo/prepare', { dir: h.repo, fingerprint: 'x' }),
    h.raw('GET', `/repo/sync?dir=${encodeURIComponent(h.repo)}`),
  ]);
  t.check('their routes are gone', gone.map((r) => r.status), [404, 404, 404, 404, 404, 404]);
  const l1 = await h.call<{ content: string; customised?: boolean }>('GET', '/level1');
  t.truthy('the base prompt is read as it ships, nothing to say it was changed', l1.content.length > 200 && l1.customised === undefined, Object.keys(l1));

  // The editor saving a file of the open folder.
  type Opened = { text: string | null; version?: string };
  writeFileSync(join(h.repo, 'crlf.txt'), '\ufeffone\r\ntwo\r\n', 'utf8');
  const opened = await h.call<Opened>('GET', '/workspace/file?path=crlf.txt');
  t.check('read: the text without its mark, and a version', [opened.text, typeof opened.version === 'string' && opened.version.length > 8], ['one\r\ntwo\r\n', true]);
  const saved = await h.call<{ version: string; size: number }>('PUT', '/workspace/file', { path: 'crlf.txt', text: 'one\ntwo\nthree\n', base: opened.version });
  t.check('saved over the version it was opened at: the file keeps its CRLF and its byte-order mark', readFileSync(join(h.repo, 'crlf.txt'), 'utf8'), '\ufeffone\r\ntwo\r\nthree\r\n');
  const stale = await h.raw('PUT', '/workspace/file', { path: 'crlf.txt', text: 'mine\n', base: opened.version });
  t.check('saved over a version that is no longer on disk: refused with 409, nothing written', [stale.status, readFileSync(join(h.repo, 'crlf.txt'), 'utf8')], [409, '\ufeffone\r\ntwo\r\nthree\r\n']);
  await h.call('PUT', '/workspace/file', { path: 'crlf.txt', text: 'mine\n' });
  t.check('saved with no version: over whatever is there', readFileSync(join(h.repo, 'crlf.txt'), 'utf8'), '\ufeffmine\r\n');
  t.truthy('and the version it answered with is the new one', saved.version !== opened.version, saved);
  writeFileSync(join(h.repo, 'lf.txt'), 'a\nb\n', 'utf8');
  await h.call('PUT', '/workspace/file', { path: 'lf.txt', text: 'a\r\nb\r\nc\r\n' });
  t.check('an LF file stays LF, whatever the text sent', readFileSync(join(h.repo, 'lf.txt'), 'utf8'), 'a\nb\nc\n');
  const outside = await h.raw('PUT', '/workspace/file', { path: '../outside.txt', text: 'x' });
  const inGit = await h.raw('PUT', '/workspace/file', { path: '.git/config', text: 'x' });
  const missing = await h.raw('PUT', '/workspace/file', { path: 'not-there.txt', text: 'x' });
  writeFileSync(join(h.repo, 'bin.dat'), Buffer.from([1, 0, 2, 0]));
  const binary = await h.raw('PUT', '/workspace/file', { path: 'bin.dat', text: 'x' });
  t.check('refused: a path out of the folder, git\'s own folder, a file not there, a binary file', [outside.status, inGit.status, missing.status, binary.status], [400, 400, 400, 400]);
  t.check('and nothing was made out of the folder', existsSync(join(h.repo, '..', 'outside.txt')), false);

  // Plan mode, chosen for a new conversation: the plan asked of the operator though commands run without asking.
  const repo = h.repo;
  const file = (p: string): string | null => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), 'utf8').trim() : null);
  const planned = await h.call<Sent>('POST', '/chat', { text: 'Create plan.txt holding exactly plan.', model: 'Think deeper', planMode: true });
  t.check('a conversation started in plan mode', (await h.call<ChatSession & { planMode?: string }>('GET', `/sessions/${planned.threadId}`)).planMode, 'approve');
  h.chat.script(
    reply.plan({ files: ['plan.txt'] }),
    (m) => {
      t.truthy('the approval reaches the chat', m.text.startsWith('The operator approved your plan.'), m.text.slice(0, 200));
      return reply.steps(write('plan.txt', 'plan'));
    },
    reply.done(),
  );
  t.check('it starts without asking about commands', (await h.call<{ started: boolean }>('POST', `/sessions/${planned.threadId}/start`, { mode: 'unattended' })).started, true);
  type PlanAsk = { id: string; plan?: { title: string } };
  const ask = await waitFor('the plan to be asked about', async () => (await h!.call<PlanAsk[]>('GET', `/approvals?session=${planned.threadId}`)).find((a) => a.plan), 20_000);
  t.check('the plan waits for the operator, though the commands run without asking', ask.plan?.title, 'Create plan.txt holding exactly plan.');
  t.check('and nothing was changed yet', file('plan.txt'), null);
  await h.call('POST', `/approvals/${ask.id}/plan`, { action: 'approve' });
  await h.idle();
  const after = (await h.call<ChatSession>('GET', `/sessions/${planned.threadId}`)).tasks[0] as Full & { plan?: { approved?: { by: string } } };
  t.check('approved, the work is done, the plan on its record approved by the operator', [after.status, file('plan.txt'), after.plan?.approved?.by], ['done', 'plan', 'operator']);
  t.check('a conversation without plan mode is off', (await h.call<ChatSession & { planMode?: string }>('GET', `/sessions/${(await h.call<Sent>('POST', '/chat', { text: 'Another.', model: 'Think deeper' })).threadId}`)).planMode, 'off');
  t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
} catch (e) {
  t.truthy('the Kerrigan, editor and plan-mode scenarios ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h?.stop();
}

/*
 * "Pause" and "Continue" (operator, 2026-10-20): the work on a message holds at its next message to Copilot or its next
 * command, and goes on when the operator continues; the time held does not count against maxRunMinutes; Stop while
 * held sends nothing more and runs nothing more.
 */
console.log('\n--- Pause holds the work at its next message or command, Continue goes on, Stop while paused sends nothing ---');
{
  let hp: Harness | undefined;
  const realNow = Date.now;
  try {
    // A limit of one minute, and a clock moved two minutes on while the task is held: only the pause took them.
    hp = await startHarness({ settings: { limits: { maxRunMinutes: 1 } } });
    const h = hp;
    type Ev = { type: string; message: string };
    type View = { paused?: boolean; running: boolean; tasks: Array<{ status: string; reason?: string }> };
    const view = async (id: string): Promise<View> => await h.call<View>('GET', `/sessions/${id}`);
    const exists = (p: string): boolean => existsSync(join(h.repo, p));
    const quiet = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    t.check('nothing running: there is nothing to pause', (await h.raw('POST', '/sessions/nothing-here/pause', {})).status, 400);

    // Held before a message: paused while a command runs, the report of it waits.
    const one = await h.call<Sent>('POST', '/chat', { text: 'Create slow.txt holding slow, slowly.', model: 'Think deeper' });
    h.chat.script(reply.steps(`Start-Sleep -Seconds 2; ${write('slow.txt', 'slow')}`), reply.done());
    await h.call('POST', `/sessions/${one.threadId}/start`, { mode: 'unattended' });
    await waitFor('the command to be running', async () => (await h.call<Ev[]>('GET', `/sessions/${one.threadId}/events`)).some((e) => e.type === 'step-started'), 20_000);
    t.check('"Pause" while a command runs', await h.call<{ paused: boolean }>('POST', `/sessions/${one.threadId}/pause`, {}), { paused: true });
    t.check('the conversation says it is paused', (await view(one.threadId)).paused, true);
    await waitFor('the command to end', async () => exists('slow.txt'), 20_000);
    const sentBefore = h.chat.exchanged.length;
    await quiet(1500);
    t.check('the command running was let finish, and its report is not sent while paused', [exists('slow.txt'), h.chat.exchanged.length, h.chat.pending], [true, sentBefore, 1]);
    t.check('the task is still the same task, running', (await view(one.threadId)).tasks[0]?.status, 'running');
    Date.now = () => realNow() + 2 * 60_000;
    t.check('"Continue"', await h.call<{ paused: boolean }>('POST', `/sessions/${one.threadId}/resume`, {}), { paused: false });
    await h.idle();
    const done = await view(one.threadId);
    t.check('it went on, and two minutes paused did not use up its one-minute limit', [done.tasks[0]?.status, done.paused, h.chat.pending], ['done', false, 0]);
    const said = (await h.call<Ev[]>('GET', `/sessions/${one.threadId}/events`)).map((e) => e.type);
    t.truthy('paused and continued are on its record', ['pause-asked', 'task-paused', 'resume-asked', 'task-resumed'].every((x) => said.includes(x)), said);
    Date.now = realNow;

    // Held before a command, then stopped: the command is not run and nothing more is sent.
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    const two = await h.call<Sent>('POST', '/chat', { text: 'Create held.txt holding held.', model: 'Think deeper' });
    h.chat.script(async () => {
      await answered;
      return reply.steps(write('held.txt', 'held'));
    });
    await h.call('POST', `/sessions/${two.threadId}/start`, { mode: 'unattended' });
    await waitFor('Copilot to be answering', async () => h.chat.pending === 0, 20_000);
    await h.call('POST', `/sessions/${two.threadId}/pause`, {});
    answer();
    await waitFor('the reply to be held before its command', async () => (await h.call<Ev[]>('GET', `/sessions/${two.threadId}/events`)).some((e) => e.type === 'task-paused'), 20_000);
    await quiet(1000);
    t.check('the reply came while paused: its command is not run', exists('held.txt'), false);
    const sentHeld = h.chat.exchanged.length;
    await h.call('POST', `/sessions/${two.threadId}/stop`, {});
    await h.idle();
    const stopped = await view(two.threadId);
    t.check('Stop while paused: the task stopped, its command never ran, nothing more was sent', [stopped.tasks[0]?.status, exists('held.txt'), h.chat.exchanged.length], ['aborted', false, sentHeld]);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy('the Pause scenarios ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    Date.now = realNow;
    await hp?.stop();
  }
}

/*
 * The review in the chat (operator, 2026-10-20: "if the model is chosen by hand, say plainly on the card that this is the
 * model for the review, best a different one"): on for a conversation the box asks it for, off for one asked for
 * without it; its conversation's model chosen by hand on a card marked as the review's; told what the message changed,
 * from the folder against its photograph, not from the operator's own uncommitted work.
 */
console.log('\n--- the review in the chat: when asked for, its model chosen by hand on a card that says it is the review\'s ---');
{
  let hr: Harness | undefined;
  try {
    hr = await startHarness({ settings: { execution: { mode: 'unattended', isolation: 'none-accepted' } } });
    const h = hr;
    type Reviewed = { review?: { enabled: boolean }; tasks: Array<{ status: string; review?: { verdict: string } }> };
    const quiet = await h.call<Sent>('POST', '/chat', { text: 'Not reviewed.', model: 'Think deeper' });
    t.check('asked for without the box: not reviewed', (await h.call<Reviewed>('GET', `/sessions/${quiet.threadId}`)).review?.enabled, false);
    // The operator's own uncommitted work in the folder before the message: not the message's doing.
    writeFileSync(join(h.repo, 'mine.txt'), 'the operator\'s own\n', 'utf8');
    const sent = await h.call<Sent>('POST', '/chat', { text: 'Create reviewed.txt holding reviewed.', model: 'Think deeper', review: true });
    t.check('with the box ticked: reviewed', (await h.call<Reviewed>('GET', `/sessions/${sent.threadId}`)).review?.enabled, true);
    let reviewSaw = '';
    h.chat.script(
      reply.steps(write('reviewed.txt', 'reviewed')),
      reply.done('I created reviewed.txt holding the word reviewed and read it back to check that it is there.'),
      (m) => {
        reviewSaw = m.text;
        // A reviewer looks before it passes: a "pass" with no command run is refused.
        return reply.steps('Get-Content -Path reviewed.txt');
      },
      reply.pass('I read reviewed.txt and it holds exactly the word reviewed, as the task asked for.'),
    );
    await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
    type Ask = { id: string; model?: { review?: boolean; manual?: boolean; asked: string } };
    const ask = await waitFor('the card for the review\'s model', async () => (await h.call<Ask[]>('GET', `/approvals?session=${sent.threadId}`)).find((a) => a.model?.review) ?? null, 30_000);
    t.check('no review model chosen: asked by hand, on a card marked as the review\'s', [ask.model?.review, ask.model?.manual, ask.model?.asked], [true, true, '']);
    await h.call('POST', `/approvals/${ask.id}`, { action: 'run' });
    await h.idle();
    const done = (await h.call<Reviewed>('GET', `/sessions/${sent.threadId}`)).tasks[0];
    t.check('reviewed and passed: done', [done?.status, done?.review?.verdict], ['done', 'pass']);
    t.truthy('the review was told the file the message made, and not the operator\'s own', reviewSaw.includes('reviewed.txt') && !reviewSaw.includes('mine.txt'), reviewSaw.slice(0, 900));
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy('the review scenarios ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await hr?.stop();
  }
}

console.log('\n--- what the card in the window says, for each way the work on a message ends ---');
{
  const keepBg = 'Прозорецът остава отворен за следващото ви съобщение. Можете да го затворите по всяко време.';
  const blocked = chatNotice('bg', [{ title: 'Промени README', status: 'blocked', summary: 'Файлът README.md го няма.', reason: 'blocked by the chat' }]);
  t.check('blocked: unfinished, with what Copilot said', [blocked.tone, blocked.title, blocked.subject, blocked.lines], ['failed', 'Заданието приключи незавършено', '„Промени README“', ['Copilot не успя да го завърши: Файлът README.md го няма.', keepBg]]);
  const limit = chatNotice('en', [{ title: 'Big job', status: 'limit-reached', reason: 'maxIterations (12) reached' }]);
  t.check('at a limit: unfinished, with the limit', [limit.tone, limit.title, limit.lines[0]], ['failed', 'The task ended unfinished', 'It stopped at a limit from the settings: maxIterations (12) reached']);
  const failed = chatNotice('en', [{ title: 'x', status: 'failed', reason: `a command died: ${'very long '.repeat(40)}` }]);
  t.truthy('failed: the reason, cut to a line', failed.lines[0]!.startsWith('It ended with an error: a command died: very long') && failed.lines[0]!.length <= 260 && failed.lines[0]!.endsWith('…'), failed.lines[0]);
  const notStarted = chatNotice('bg', [{ title: 'x', status: 'queued' }], 'The sign-in was not completed within 900 s.');
  t.check('nothing began: could not start, and why', [notStarted.tone, notStarted.title, notStarted.lines[0]], ['failed', 'Заданието не можа да започне', 'Нищо не беше изпратено: The sign-in was not completed within 900 s.']);
  const stoppedFirst = chatNotice('en', [{ title: 'x', status: 'queued' }]);
  t.check('stopped before it was sent: stopped', [stoppedFirst.tone, stoppedFirst.title], ['stopped', 'The task was stopped']);
  const two = chatNotice('en', [{ title: 'one', status: 'done' }, { title: 'two', status: 'aborted' }]);
  t.check('two messages: each with how it ended, no single subject', [two.tone, two.title, two.subject, two.lines], ['stopped', 'The task was stopped', undefined, ['“one” — done', '“two” — stopped', 'This window stays open for your next message. You can close it at any time.']]);
  // Every language of the interface (2026-10-20): its own words, Arabic right to left, an unknown one English.
  const de = chatNotice('de', [{ title: 'Datei anlegen', status: 'done' }]);
  t.check('in German: its own words and quotes', [de.title, de.subject, de.button, de.dir], ['Die Aufgabe ist erledigt', '„Datei anlegen“', 'OK', undefined]);
  const ar = chatNotice('ar', [{ title: 'x', status: 'done' }]);
  t.check('in Arabic: right to left', [ar.title, ar.dir], ['اكتملت المهمة', 'rtl']);
  t.check('every language of the interface has its words', ['en', 'bg', 'de', 'es', 'fr', 'pt', 'ja', 'ko', 'ar'].filter((l) => l !== 'en' && chatNotice(l, [{ title: 'x', status: 'done' }]).title === 'The task is done'), []);
  t.check('a language it has no words for: English', chatNotice('xx', [{ title: 'x', status: 'done' }]).title, 'The task is done');
}
t.finish();
