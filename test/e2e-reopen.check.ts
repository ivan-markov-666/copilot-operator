/**
 * The chat's window closed under the work, and "Continue" under a message that stopped (operator, 2026-11-13: "if I
 * close the browser with the chat on Microsoft 365 Copilot by accident, I want the bot to carry the task on from where
 * it got to"; then, asked: the window opened again by itself, and "Continue" for every stop).
 *
 * Held here, through the API and the scripted chat (test/support/fakeChat.ts), which goes through the same rules as the
 * real window (transport/keptWindow.ts):
 *   - closed while the chat writes its answer: opened again on the same conversation, and the answer asked for again;
 *   - closed while its commands run: their results go to the window opened again, and nothing is asked again;
 *   - closed as a message is sent: sent again, saying it is a copy;
 *   - closed while a card waits for the operator: their answer goes to the window opened again;
 *   - two chats and Kerrigan: opened again on the conversation the window was on — the worker's, hers;
 *   - past `limits.reopenWindow`, or a window that will not open again, or a conversation with no address yet: the
 *     message stops, saying why, and "Continue" carries it on in its conversation — told, for one stopped while its
 *     commands ran, which of them ran and what they printed; 0 is the old way, the window's X stops the message;
 *   - "Continue" after a Stop, and what it refuses: a message done, one the conversation has gone on past.
 *
 *   npm run check:e2e-reopen
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, waitFor, Tally, type Harness, type TaskView } from './support/harness.js';
import { reply } from './support/fakeChat.js';
import { ASK_AGAIN, CLOSED_NOT_REOPENED, SENT_AGAIN } from '../src/transport/keptWindow.js';
import { NO_ADDRESS_YET } from '../src/transport/copilotTransport.js';

const t = new Tally();
const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;
type Sent = { threadId: string; taskId: string };
type Ev = { type: string; message: string };
type Card = { id: string; sessionId: string; question?: { text: string } };
type Thread = { id: string; chat?: { chatId: string }; lead?: { workerSessionId?: string }; tasks: TaskView[] };

async function scenario(title: string, settings: Record<string, unknown>, body: (h: Harness) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings: { execution: { mode: 'unattended', isolation: 'none-accepted' }, ...settings } });
  try {
    await body(h);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
    t.check('every scripted reply was used', h.chat.pending, 0);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

const fileOf = (h: Harness, p: string): string | null => (existsSync(join(h.repo, p)) ? readFileSync(join(h.repo, p), 'utf8').trim() : null);
const said = async (h: Harness, id: string): Promise<string[]> => (await h.call<Ev[]>('GET', `/sessions/${id}/events`)).map((e) => e.type);
const lastOf = async (h: Harness, id: string): Promise<TaskView> => (await h.session(id)).tasks.at(-1)!;
/** "Continue" under the conversation's last message, then the work to its end. */
const carryOn = async (h: Harness, threadId: string, taskId: string): Promise<{ started: boolean; reason?: string }> => {
  const r = await h.call<{ started: boolean; reason?: string }>('POST', `/chat/${threadId}/tasks/${taskId}/continue`);
  await h.idle();
  return r;
};

await scenario('closed while a message is at work: opened again on its conversation, and the work goes on there', {}, async (h) => {
  // While the chat writes its answer: that answer reached no window, so it is asked for again.
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Write a.txt holding exactly a.', model: 'Think deeper' });
  let wroteIn = '';
  let asked = '';
  let askedIn = '';
  h.chat.script(
    (m) => {
      wroteIn = m.chatId;
      m.world.closeByHand();
      return reply.steps(write('a.txt', 'a'));
    },
    (m) => {
      asked = m.text;
      askedIn = m.chatId;
      return reply.steps(write('a.txt', 'a'));
    },
    reply.done(),
  );
  const opened = h.chat.opened;
  const a = (await h.run(sent.threadId)).tasks.at(-1)!;
  t.check('closed while the chat wrote its answer: the message done in the end, its file written', [a.status, fileOf(h, 'a.txt')], ['done', 'a']);
  t.check('the window opened again once, on the same conversation, and left open', [h.chat.opened - opened, h.chat.reopened.map((r) => r.chatId === wroteIn), h.chat.windows.length], [2, [true], 1]);
  t.check('the answer that reached no window asked for again, in that conversation', [asked, askedIn], [ASK_AGAIN, wroteIn]);
  const events = await said(h, sent.threadId);
  t.truthy('said as it happened: closed, opened again, back, the answer asked for again', ['browser:window-closed', 'browser:window-reopening', 'browser:window-reopened', 'browser:reply-asked-again'].every((x) => events.includes(x)), events.filter((x) => x.startsWith('browser:')));

  // While its commands run: their results go to the window opened again; nothing is asked again.
  await h.call<Sent>('POST', '/chat', { text: 'Wait a moment, then write b.txt holding exactly b.', threadId: sent.threadId });
  let report = '';
  let reportIn = '';
  h.chat.script(
    (m) => {
      setTimeout(() => m.world.closeByHand(), 300);
      return reply.steps('Start-Sleep -Milliseconds 1500', write('b.txt', 'b'));
    },
    (m) => {
      report = m.text;
      reportIn = m.chatId;
      return reply.done();
    },
  );
  const sentBefore = h.chat.sent.length;
  const b = (await h.run(sent.threadId)).tasks.at(-1)!;
  t.check('closed while its commands ran: done, its file written, the window opened again', [b.status, fileOf(h, 'b.txt'), h.chat.reopened.length, h.chat.windows.length], ['done', 'b', 2, 1]);
  t.truthy('the commands\' results went to the window opened again, in the same conversation', reportIn === wroteIn && report.length > 0 && !report.includes(ASK_AGAIN) && !report.startsWith(SENT_AGAIN), [reportIn, report.slice(0, 300)]);
  t.check('and nothing else was sent: the message and its results, nothing asked again', h.chat.sent.length - sentBefore, 2);

  // As a message is sent: it is sent again, saying it is a copy.
  await h.call<Sent>('POST', '/chat', { text: 'Write c.txt holding exactly c.', threadId: sent.threadId });
  let copy = '';
  h.chat.script(
    (m) => {
      m.world.closeOnSend = 1;
      return reply.steps(write('c.txt', 'c'));
    },
    (m) => {
      copy = m.text;
      return reply.done();
    },
  );
  const c = (await h.run(sent.threadId)).tasks.at(-1)!;
  t.check('closed as the results were sent: done, its file written', [c.status, fileOf(h, 'c.txt'), h.chat.reopened.length], ['done', 'c', 3]);
  t.truthy('the results sent again, saying they are a copy', copy.startsWith(`${SENT_AGAIN}\n\n`) && copy.length > SENT_AGAIN.length + 20, copy.slice(0, 300));

  // While a card waits for the operator: their answer goes to the window opened again.
  await h.call<Sent>('POST', '/chat', { text: 'Ask me which name to use, then write it to d.txt.', threadId: sent.threadId });
  let answered = '';
  h.chat.script(reply.ask('Which name should d.txt hold?', ['delta', 'dee'], 'The task leaves it to you.'), (m) => {
    answered = m.text;
    return reply.steps(write('d.txt', 'delta'));
  }, reply.done());
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  const card = await waitFor('the question', async () => (await h.call<Card[]>('GET', '/approvals')).find((x) => !!x.question), 30_000);
  h.chat.closeByHand();
  await waitFor('the window opened again while the card waits', async () => h.chat.reopened.length === 4 && h.chat.windows.length === 1, 20_000);
  await h.call('POST', `/approvals/${card.id}/answer`, { text: 'delta' });
  await h.idle();
  const d = await lastOf(h, sent.threadId);
  t.check('closed while the card waited: the answer reached the chat in the window opened again, and the work was done', [d.status, fileOf(h, 'd.txt'), answered.includes('delta')], ['done', 'delta', true]);
  t.check('no "Continue" for a message done', (await h.raw('POST', `/chat/${sent.threadId}/tasks/${d.id}/continue`)).status, 400);
});

await scenario('past the times Settings allow: the message stops, saying so, and "Continue" carries it on in its conversation', { limits: { reopenWindow: 1 } }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Write e.txt holding exactly e.', model: 'Think deeper' });
  h.chat.script(
    (m) => {
      m.world.closeByHand();
      return reply.steps(write('e.txt', 'e'));
    },
    (m) => {
      t.check('opened again once, the answer asked for', m.text, ASK_AGAIN);
      m.world.closeByHand();
      return reply.steps(write('e.txt', 'e'));
    },
  );
  const e1 = (await h.run(sent.threadId)).tasks.at(-1)!;
  t.check('closed a second time: stopped, not failed, nothing of it run', [e1.status, fileOf(h, 'e.txt')], ['aborted', null]);
  t.truthy('saying it closed twice, was opened again once, as many as Settings allow', /closed 2 times while this message was at work; it was opened again 1 time\(s\), as many as Settings allow for one message \(limits\.reopenWindow\)/.test(e1.reason ?? ''), e1.reason);
  t.check('no window is left: it is let go of', h.chat.windows.length, 0);
  const events = await said(h, sent.threadId);
  t.truthy('said as a stop, not as an error', events.includes('browser:window-not-reopened') && !events.includes('task-error') && !events.includes('session-error'), events.filter((x) => /error|window/.test(x)));

  const chatId = (await h.call<Thread>('GET', `/sessions/${sent.threadId}`)).chat?.chatId;
  let told = '';
  let toldIn = '';
  h.chat.script(
    (m) => {
      told = m.text;
      toldIn = m.chatId;
      return reply.steps(write('e.txt', 'e'));
    },
    reply.done(),
  );
  const r = await carryOn(h, sent.threadId, e1.id);
  const e2 = await lastOf(h, sent.threadId);
  t.check('"Continue": started, and the message done in the end, as its second attempt', [r.started, e2.status, e2.attempt, fileOf(h, 'e.txt')], [true, 'done', 2, 'e']);
  t.truthy('in the same conversation, told to carry on, not to start over', toldIn === chatId && told.startsWith('Continue task 1: Write e.txt holding exactly e., in this same conversation.') && told.includes('Do not start over'), [toldIn, chatId, told.slice(0, 400)]);
  t.truthy('and why it stopped: its window closed, not a Stop', told.includes('It stopped because the browser window this conversation is in was closed (the browser window was closed 2 times') && !told.includes('stopped by the operator'), told.slice(0, 600));
});

await scenario('with 0, closing the window stops the message, as before; "Continue" tells the chat which commands ran and what they printed', { limits: { reopenWindow: 0 } }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Wait, say slept well, then write f.txt holding exactly f.', model: 'Think deeper' });
  h.chat.script((m) => {
    setTimeout(() => m.world.closeByHand(), 300);
    return reply.steps("Start-Sleep -Milliseconds 1500; Write-Output 'slept well'");
  });
  const sentBefore = h.chat.sent.length;
  const f1 = (await h.run(sent.threadId)).tasks.at(-1)!;
  t.check('closed while its command ran: stopped as before, said so, nothing more sent, not opened again', [f1.status, f1.reason, h.chat.reopened.length, h.chat.windows.length], ['aborted', CLOSED_NOT_REOPENED, 0, 0]);
  t.check('what went out: the contract, the message, nothing after', h.chat.sent.length - sentBefore, 2);
  let told = '';
  h.chat.script(
    (m) => {
      told = m.text;
      return reply.steps(write('f.txt', 'f'));
    },
    reply.done(),
  );
  const r = await carryOn(h, sent.threadId, f1.id);
  t.check('"Continue": done in the end', [r.started, (await lastOf(h, sent.threadId)).status, fileOf(h, 'f.txt')], [true, 'done', 'f']);
  t.truthy('the chat told which of its last commands ran, how it ended, and what it printed', told.includes('Of the 1 step(s) in your last reply:') && told.includes('step 1 ran to the end (exit 0)') && told.includes('slept well'), told.slice(0, 900));
});

await scenario('a window that will not open again, and a conversation with no address yet: stopped, saying why; "Continue" sends the task in a new one', {}, async (h) => {
  // Edge would not start again on the profile, every time it was tried.
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Write g.txt holding exactly g.', model: 'Think deeper' });
  h.chat.script((m) => {
    m.world.reopenFails = 1;
    m.world.closeByHand();
    return reply.steps(write('g.txt', 'g'));
  });
  const g = (await h.run(sent.threadId)).tasks.at(-1)!;
  t.truthy('not opened again: stopped, with what Edge said', g.status === 'aborted' && /could not be opened again on its conversation: Microsoft Edge is already running with this profile/.test(g.reason ?? ''), [g.status, g.reason]);
  t.check('no window left', h.chat.windows.length, 0);

  // Closed before the conversation's first answer: it has no address, so it cannot be found again.
  const other = await h.call<Sent>('POST', '/chat', { text: 'Write h.txt holding exactly h.', model: 'Think deeper' });
  h.chat.onSent = (m) => {
    h.chat.onSent = null;
    void m;
    h.chat.closeByHand();
  };
  const h1 = (await h.run(other.threadId)).tasks.at(-1)!;
  t.check('closed before the conversation\'s first answer: stopped, saying it could not be found again', [h1.status, h1.reason], ['aborted', NO_ADDRESS_YET]);
  t.check('the window opened again stays, on no conversation, for the next message', h.chat.windows.length, 1);
  let opening = '';
  h.chat.script(
    (m) => {
      opening = m.text;
      return reply.steps(write('h.txt', 'h'));
    },
    reply.done(),
  );
  const r = await carryOn(h, other.threadId, h1.id);
  t.check('"Continue": done', [r.started, (await lastOf(h, other.threadId)).status, fileOf(h, 'h.txt')], [true, 'done', 'h']);
  // Only the contract had gone out: nothing of the task reached a conversation, so it goes out in full, as the first time.
  t.truthy('in a new conversation: the task in full, as the first time, since none of it had reached one', opening.includes('## Task 1: Write h.txt holding exactly h.') && !opening.includes('Continue task') && !opening.includes('This continues'), opening.slice(-400));
});

await scenario('"Continue" after Stop; refused for a message the conversation has gone on past', {}, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Look at the files.', model: 'Think deeper' });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  h.chat.script(async () => {
    await gate;
    return reply.steps('Get-ChildItem -Name');
  });
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  await waitFor('the message to reach the chat', async () => h.chat.sent.some((m) => m.text.includes('Look at the files.')), 20_000);
  await h.call('POST', `/sessions/${sent.threadId}/stop`);
  t.check('"Continue" is refused while the conversation works', (await h.raw('POST', `/chat/${sent.threadId}/tasks/${sent.taskId}/continue`)).status, 400);
  release();
  await h.idle();
  const stopped = await lastOf(h, sent.threadId);
  t.check('stopped', stopped.status, 'aborted');
  let told = '';
  h.chat.script(
    (m) => {
      told = m.text;
      return reply.steps('Get-ChildItem -Name');
    },
    reply.done(),
  );
  const r = await carryOn(h, sent.threadId, stopped.id);
  t.check('"Continue" after Stop: carried on, and done', [r.started, (await lastOf(h, sent.threadId)).status], [true, 'done']);
  t.truthy('told it was stopped and to carry on', told.startsWith('Continue task 1: Look at the files., in this same conversation.'), told.slice(0, 300));

  // A message stopped, then another written after it: the first is not carried on in a conversation that went on.
  await h.call<Sent>('POST', '/chat', { text: 'Look again.', threadId: sent.threadId });
  const gate2 = new Promise<void>((r) => (release = r));
  h.chat.script(async () => {
    await gate2;
    return reply.steps('Get-ChildItem -Name');
  });
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  await waitFor('the message to reach the chat', async () => h.chat.sent.some((m) => m.text.includes('Look again.')), 20_000);
  await h.call('POST', `/sessions/${sent.threadId}/stop`);
  release();
  await h.idle();
  const second = await lastOf(h, sent.threadId);
  await h.call<Sent>('POST', '/chat', { text: 'Never mind; just say done.', threadId: sent.threadId });
  h.chat.script(reply.steps('Get-ChildItem -Name'), reply.done());
  await h.run(sent.threadId);
  const refused = await h.raw('POST', `/chat/${sent.threadId}/tasks/${second.id}/continue`);
  t.truthy('a stopped message the conversation went on past: refused, saying why', refused.status === 400 && /the conversation has gone on past this one/.test(String((refused.body as { message?: string }).message)), refused);
});

await scenario('two chats: opened again on the worker\'s conversation, and the lead goes on', {}, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Write w.txt holding exactly w.', model: 'Think deeper', lead: true });
  let workerIn = '';
  let askedIn = '';
  h.chat.script(
    reply.lead.delegate({ title: 'Write w.txt', readOnly: false }, { understanding: 'w.txt at the root holding w; done when it is read back.' }),
    (m) => {
      workerIn = m.chatId;
      m.world.closeByHand();
      return reply.steps(write('w.txt', 'w'));
    },
    (m) => {
      t.check('the worker asked for its answer again', m.text, ASK_AGAIN);
      askedIn = m.chatId;
      return reply.steps(write('w.txt', 'w'));
    },
    reply.done(),
    reply.lead.done(),
  );
  const done = (await h.run(sent.threadId)).tasks.at(-1)!;
  t.check('done in the end, the file written', [done.status, fileOf(h, 'w.txt')], ['done', 'w']);
  t.check('opened again on the worker\'s conversation, where the answer was asked for', [h.chat.reopened.map((r) => r.chatId === workerIn), askedIn === workerIn], [[true], true]);
});

await scenario('Kerrigan directs: opened again on her conversation, and she goes on', {}, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Write k.txt holding exactly k.', model: 'Think deeper', kerrigan: true, chatModel: 'Think deeper' });
  let herIn = '';
  const send = reply.kerrigan.send('Create k.txt at the root holding exactly k, then read it back with Get-Content.', { understanding: 'k.txt at the root holding k; done when it is read back.', title: 'Write k.txt' });
  h.chat.script(
    (m) => {
      herIn = m.chatId;
      m.world.closeByHand();
      return send;
    },
    (m) => {
      t.truthy('she was asked for her answer again, in her conversation', m.text === ASK_AGAIN && m.chatId === herIn, [m.chatId, herIn, m.text.slice(0, 120)]);
      return send;
    },
    reply.steps(write('k.txt', 'k')),
    reply.done(),
    reply.kerrigan.done('Done: k.txt holds k, as the chat read it back.', ['Get-Content k.txt printed k']),
  );
  const done = (await h.run(sent.threadId)).tasks.at(-1)!;
  t.check('her message done, the file written', [done.status, fileOf(h, 'k.txt')], ['done', 'k']);
  t.check('opened again on her conversation', h.chat.reopened.map((r) => r.chatId === herIn), [true]);
});

t.finish();
