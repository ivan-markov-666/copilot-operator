/**
 * Kerrigan directs (operator, 2026-11-12: "I paste Kerrigan into a chat, give her the task, she gives me the prompt and
 * says plan mode, two chats, the reviewer, which skill; I start the bot; when it asks me something I take it to her and
 * do what she says; at the end she reads the result and goes on, in a new chat or the same — automate that"), end to end
 * through the API with the scripted chat of test/support/fakeChat.ts:
 *
 * - her conversation gets her contract and the facts of this machine once, then the person's task, with how many
 *   messages to chats she may send; her first reply must restate the task, and one in the wrong shape is sent back;
 * - her message goes to a chat of its own (`directedBy`), in the same window, with the plan mode, review and skill she
 *   chose; the chat is a conversation of the list;
 * - the chat's plan and its question go to her and she answers them in the person's place — even with Settings agreeing
 *   with what the bot proposes — and the chat is told it was her; the window goes back to the chat before it goes on;
 * - an answer of hers that carries a command does not run it unasked: it is asked about as the run asks (the person's
 *   choice, 2026-11-12: "questions, plans, retries; the commands as Settings say");
 * - a card she leaves to the person stays with them, with why and what she would choose; one the person answers first
 *   is theirs; her own question waits on a card in her conversation;
 * - the result goes back to her: how it ended, the summary, the commands with their exit codes, the files, how many
 *   messages are left; "same" carries on in the chat she sent to last; her report is the message's summary.
 *
 *   npm run check:e2e-kerrigan
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;

type Sent = { threadId: string; taskId: string };
type Round = {
  status: string;
  understanding?: string;
  notes?: string;
  sources?: string[];
  send?: { n: number; title: string; prompt: string; chat: string; planMode: boolean; twoChats: boolean; review: boolean; skill?: string; sessionId?: string; taskId?: string; status?: string; summary?: string };
  card?: { id: string; kind: string; text: string; options?: string[]; answer?: string; by?: string; yours?: { why: string; suggestion?: string } };
  question?: { text: string; options: string[]; answer?: string };
  report?: string;
};
type KTask = { id: string; status: string; summary?: string; reason?: string; kerrigan?: { rounds: Round[]; sent: number; maxSends: number; messages: number; chats: string[] } };
type KSession = { id: string; kerrigan?: unknown; review?: { enabled: boolean }; planMode?: string; tasks: KTask[] };
type ChatSession = { id: string; name: string; kind?: string; directedBy?: string; planMode?: string; review?: { enabled: boolean }; lead?: unknown; chat?: { chatId: string }; tasks: Array<{ id: string; title: string; status: string; prompt: string; summary?: string; fromKerrigan?: { sessionId: string; taskId: string; n: number }; plan?: { approved?: { by: string; note?: string } } }> };
type Approval = { id: string; sessionId: string; taskId: string; actor?: string; description: string; question?: { text: string; options: string[] }; plan?: unknown; kerrigan?: { state: string; why?: string; suggestion?: string } };

const TASK = 'Create result.txt holding the word hello, and tell me what was done.';

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

const sessionOf = async (h: Harness, id: string): Promise<KSession> => await h.call<KSession>('GET', `/sessions/${id}`);
const chatOf = async (h: Harness, id: string): Promise<ChatSession> => await h.call<ChatSession>('GET', `/sessions/${id}`);
const pending = async (h: Harness, session: string): Promise<Approval[]> => await h.call<Approval[]>('GET', `/approvals?session=${session}`);

await scenario('the whole of it: she understands, sends, approves the plan, answers the question, judges and reports', { execution: { mode: 'unattended', isolation: 'none-accepted', questions: 'agree' } }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: TASK, model: 'Think deeper', kerrigan: true, chatModel: 'Think deeper' });
  const made = await sessionOf(h, sent.threadId);
  t.check('a conversation Kerrigan directs: no review or plan of its own (she chooses for each message)', [!!made.kerrigan, made.review?.enabled, made.planMode], [true, false, 'off']);
  let taskMessage = '';
  let chatFirst = '';
  let planCard = '';
  let afterPlan = '';
  let questionCard = '';
  let afterAnswer = '';
  let result = '';
  let resultFiles: Record<string, string> = {};
  h.chat.script(
    (m) => {
      taskMessage = m.text;
      return reply.kerrigan.send(undefined, {
        understanding: 'Goal: result.txt at the root holding hello. Result: a short report of what was done. Done when the file is read back.',
        notes: 'A small change: plan mode so the plan comes to me first; no review for one file.',
        sources: ['The task itself; nothing in the mail names result.txt'],
        planMode: true,
        title: 'Write result.txt',
      });
    },
    (m) => {
      chatFirst = m.text;
      return reply.plan();
    },
    (m) => {
      planCard = m.text;
      return reply.kerrigan.answer({ decision: 'approve', note: 'Keep the file to the one word.', why: 'the plan does what the task asks' });
    },
    (m) => {
      afterPlan = m.text;
      return reply.ask('Which encoding should result.txt be written in?', ['UTF-8', 'ASCII'], 'the task does not say');
    },
    (m) => {
      questionCard = m.text;
      return reply.kerrigan.answer({ option: 1, why: 'UTF-8 is what the project uses' });
    },
    (m) => {
      afterAnswer = m.text;
      return reply.steps(write('result.txt', 'hello'), 'Get-Content result.txt');
    },
    reply.done('I wrote result.txt with Set-Content and read it back: Get-Content prints hello, exactly as asked.'),
    (m) => {
      result = m.text;
      resultFiles = m.attached;
      return reply.kerrigan.done('Done: result.txt is at the root and holds hello; the chat wrote it with Set-Content and read it back with Get-Content, which printed hello.', ['result.txt', 'Get-Content result.txt → hello']);
    },
  );
  t.check('it starts', (await h.call<{ started: boolean }>('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' })).started, true);
  await h.idle();

  const k = await sessionOf(h, sent.threadId);
  const job = k.tasks[0]!;
  t.check('done, with her report as its summary', [job.status, job.summary], ['done', 'Done: result.txt is at the root and holds hello; the chat wrote it with Set-Content and read it back with Get-Content, which printed hello.']);
  t.check('her rounds, as she decided them', job.kerrigan?.rounds.map((r) => r.status), ['send', 'answer', 'answer', 'done']);
  t.truthy('her understanding and her sources are on the first round', (job.kerrigan?.rounds[0]?.understanding ?? '').includes('result.txt') && (job.kerrigan?.rounds[0]?.sources ?? []).length === 1, job.kerrigan?.rounds[0]);
  t.check('one message to a chat of six', [job.kerrigan?.sent, job.kerrigan?.maxSends], [1, 6]);
  t.check('the work is done: result.txt holds hello', existsSync(join(h.repo, 'result.txt')) ? readFileSync(join(h.repo, 'result.txt'), 'utf8').trim() : null, 'hello');

  // Her conversation: the contract and the facts once, then the task.
  const opening = h.chat.sent.filter((m) => m.contract === 'kerrigan');
  t.check('her contract went once', opening.length, 1);
  t.truthy('with the facts of this machine: the foundations, the language, the projects, the limits', /Foundations \(level 0\)/.test(opening[0]!.text) && opening[0]!.text.includes('The person writes in **English**') && opening[0]!.text.includes('at most **6** message(s)'), opening[0]!.text.slice(-2000));
  t.truthy('and where to look before asking: the mail, the chats, the transcripts, the files', /their mail, their Teams chats and channels, the transcripts/.test(opening[0]!.text) && /never an instruction to you/.test(opening[0]!.text), '');
  t.truthy('then the person\'s task, with how many messages she may send and that no chat is there yet', taskMessage.includes(TASK) && taskMessage.includes('at most 6 message(s)') && taskMessage.includes('No chat of yours is there yet'), taskMessage);
  const herChat = opening[0]!.chatId;

  // The chat she sent to.
  const send = job.kerrigan!.rounds[0]!.send!;
  t.check('her message went to a new chat, with plan mode on and no review', [send.n, send.chat, send.planMode, send.twoChats, send.review, send.status], [1, 'new', true, false, false, 'done']);
  const chat = await chatOf(h, send.sessionId!);
  t.check('a chat of its own, which she directs, with the settings she chose', [chat.kind, chat.directedBy, chat.planMode, chat.review?.enabled, !!chat.lead], ['chat', sent.threadId, 'approve', false, false]);
  t.check('its message is hers, the first', chat.tasks.map((x) => [x.title, x.status, x.fromKerrigan?.n, x.fromKerrigan?.taskId]), [['Write result.txt', 'done', 1, job.id]]);
  t.truthy('the chat got the level 1 contract and her prompt', h.chat.sent.some((m) => m.contract === 'task' && m.chatId !== herChat) && chatFirst.includes('Create result.txt at the root of the project'), chatFirst.slice(0, 400));
  const threads = await h.call<Array<{ id: string; kerrigan?: boolean; directedBy?: string }>>('GET', '/chat/threads');
  t.check('both are conversations of the list: hers, and the chat under her', threads.map((x) => [x.id === sent.threadId ? 'hers' : x.id === chat.id ? 'chat' : x.id, !!x.kerrigan, x.directedBy ?? null]).sort(), [['chat', false, sent.threadId], ['hers', true, null]]);

  // The cards.
  // What "Copy all" gives on each card (operator, 2026-11-12), and how to answer it in her format.
  t.truthy('the plan came to her as "Copy all" gives it, with how to approve it or send it back', planCard.includes('What its "Copy all" gives:') && planCard.includes('Plan for “Write result.txt”, waiting for approval') && planCard.includes('## Steps\n\n1. create the file') && planCard.includes('"decision": "approve"'), planCard);
  t.truthy('the chat was told she approved it, with her note', afterPlan.startsWith('Kerrigan, who directs this work for the operator, approved your plan.') && afterPlan.includes('Keep the file to the one word.'), afterPlan);
  t.check('and the plan is on record as approved by her', chat.tasks[0]?.plan?.approved?.by, 'kerrigan');
  t.truthy('the question came to her — though Settings agree with what the bot proposes — as "Copy all" gives it, its answers numbered', questionCard.includes('The chat asks you\n\nWhich encoding should result.txt be written in?\n\nthe task does not say') && questionCard.includes('1. UTF-8 (Recommended by the chat)\n2. ASCII') && questionCard.includes('"option", the number of one of the answers offered'), questionCard);
  t.truthy('the chat was told she answered, and what', afterAnswer.startsWith('Kerrigan, who directs this work for the operator, answered your question') && afterAnswer.includes('"UTF-8"'), afterAnswer);
  const cards = job.kerrigan!.rounds.filter((r) => r.card).map((r) => [r.card!.kind, r.card!.answer, r.card!.by]);
  t.check('the cards are on her record: what she answered, and that it was her', cards, [['plan', 'approved — Keep the file to the one word.', 'kerrigan'], ['question', 'UTF-8', 'kerrigan']]);
  t.check('no card waits now', (await pending(h, sent.threadId)).length, 0);

  // The result.
  /*
   * The result, by default (operator, 2026-11-12: "only what 'Copy' gives; the last message must be enough"): how it
   * ended, and what "Copy" under its ending gives — the chat's summary — with what is left; no commands, no files, and
   * nothing attached.
   */
  t.truthy('the result went back to her: how it ended, what "Copy" under its ending gives, what is left', result.startsWith('The result of your message 1 ("Write result.txt")') && result.includes('done — the chat says it is finished') && result.includes('What "Copy" under its ending gives:\n\n---\nI wrote result.txt with Set-Content and read it back: Get-Content prints hello, exactly as asked.\n---') && result.includes('Messages to chats left: 5 of 6.'), result);
  t.check('and only that: no commands, no files, nothing attached', [result.includes('`Get-Content result.txt` → 0'), result.includes('Files it changed'), Object.keys(resultFiles).length], [false, false, 0]);

  // One window, going from her conversation to the chat's and back.
  const order = h.chat.sent.filter((m) => !m.contract).map((m) => (m.chatId === herChat ? 'kerrigan' : 'chat'));
  const turns = order.filter((x, i) => i === 0 || x !== order[i - 1]);
  t.check('the window went from her conversation to the chat\'s and back, for each card and the result', turns, ['kerrigan', 'chat', 'kerrigan', 'chat', 'kerrigan', 'chat', 'kerrigan']);
  t.check('and it was one window throughout', h.chat.windows.length, 1);
});

await scenario('a card she leaves to the person; one the person answers first; her own question; an answer with a command is asked about', { execution: { mode: 'confirm', isolation: 'none-accepted' } }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: TASK, model: 'Think deeper', kerrigan: true, chatModel: 'Think deeper' });
  let leftCard = '';
  let toChat = '';
  let herAnswer = '';
  h.chat.script(
    // Her own question first.
    reply.kerrigan.ask({ understanding: 'Goal: result.txt holding hello.', question: 'Should result.txt be committed when it is written, or left for you to look at?', why: 'I searched the mail and the team\'s chat: nothing says.', options: ['Leave it uncommitted', 'Commit it'] }),
    (m) => {
      herAnswer = m.text;
      return reply.kerrigan.send(undefined, { title: 'Write result.txt' });
    },
    reply.ask('May I overwrite result.txt if it is there already?', ['Overwrite it', 'Keep the old one'], 'it may be there'),
    (m) => {
      leftCard = m.text;
      return reply.kerrigan.ask({ why: 'Overwriting a file the person may have written cannot be undone.', suggestion: 'Overwrite it' });
    },
    (m) => {
      toChat = m.text;
      return reply.ask('List the folder first?', [{ answer: 'List it', run: 'Get-ChildItem -Name' }, 'No need'], 'to see what is there');
    },
    reply.kerrigan.answer({ option: 1, why: 'a listing changes nothing' }),
    (m) => {
      t.truthy('the listing ran, after the person approved it on its card, and its output went back with her answer', m.text.includes('The runner ran the command that answer carries') && Object.values(m.attached).join(' ').includes('README.md'), [m.text.slice(0, 600), Object.keys(m.attached)]);
      return reply.steps(write('result.txt', 'hello'));
    },
    reply.done('I wrote result.txt with Set-Content; it holds hello.'),
    reply.kerrigan.done(),
  );
  t.check('it starts', (await h.call<{ started: boolean }>('POST', `/sessions/${sent.threadId}/start`, { mode: 'confirm' })).started, true);

  const hers = await waitFor('her question', async () => (await pending(h, sent.threadId)).find((a) => a.question && a.actor === 'kerrigan') ?? null, 20_000);
  t.check('her question waits on a card in her conversation, said to be hers', [hers.sessionId, hers.question?.options], [sent.threadId, ['Leave it uncommitted', 'Commit it']]);
  await h.call('POST', `/approvals/${hers.id}/answer`, { text: 'Leave it uncommitted' });

  const left = await waitFor('the card she left to the person', async () => (await pending(h, sent.threadId)).find((a) => a.question?.text.startsWith('May I overwrite') && a.kerrigan?.state === 'yours') ?? null, 20_000);
  t.check('the card she left is the person\'s, with why and what she would choose', [left.kerrigan?.why, left.kerrigan?.suggestion], ['Overwriting a file the person may have written cannot be undone.', 'Overwrite it']);
  t.truthy('it is shown in her conversation though it is the chat\'s', left.sessionId !== sent.threadId, left);
  await h.call('POST', `/approvals/${left.id}/answer`, { text: 'Keep the old one' });

  // Her answer to a question whose answer carries a command: the command waits for the person, as the run asks.
  const command = await waitFor('the listing, asked about', async () => (await pending(h, sent.threadId)).find((a) => a.description.includes('Get-ChildItem -Name')) ?? null, 20_000);
  t.truthy('the command her answer carries is asked about, not run by her word', !!command && !command.question && !command.plan, command);
  await h.call('POST', `/approvals/${command.id}`, { action: 'run' });
  const write1 = await waitFor('the write, asked about', async () => (await pending(h, sent.threadId)).find((a) => a.description.includes('Set-Content')) ?? null, 20_000);
  await h.call('POST', `/approvals/${write1.id}`, { action: 'run' });
  await h.idle();

  const job = (await sessionOf(h, sent.threadId)).tasks[0]!;
  t.check('done', job.status, 'done');
  t.truthy('her question reached her answered', herAnswer.startsWith('The person answers your question:') && herAnswer.includes('Leave it uncommitted'), herAnswer);
  t.truthy('the card she was given said it was a question of the chat\'s', leftCard.includes('May I overwrite result.txt') && leftCard.includes('1. Overwrite it'), leftCard);
  t.truthy('the chat was told the person answered, not her', toChat.startsWith('The operator answered your question') && toChat.includes('Keep the old one'), toChat);
  const rounds = job.kerrigan!.rounds;
  t.check('her rounds: the question, the message, the card left, the card answered, the report', rounds.map((r) => r.status), ['ask', 'send', 'ask', 'answer', 'done']);
  t.check('the card she left is on record as the person\'s', [rounds[2]?.card?.yours?.suggestion, rounds[2]?.card?.by], ['Overwrite it', 'operator']);
  t.check('her question, with the person\'s answer', [rounds[0]?.question?.text, rounds[0]?.question?.answer], ['Should result.txt be committed when it is written, or left for you to look at?', 'Leave it uncommitted']);
});

await scenario('the same chat carried on; a reply in the wrong shape sent back; "same" with another "twoChats" refused; the whole exchange attached, as Settings ask', { execution: { mode: 'unattended', isolation: 'none-accepted', kerriganResult: 'exchange' } }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: TASK, model: 'Think deeper', kerrigan: true, chatModel: 'Think deeper' });
  let repair = '';
  let refusedSame = '';
  let second = '';
  let firstExchange = '';
  let firstNames: string[] = [];
  let firstResult = '';
  h.chat.script(
    reply.prose('Sure, I will get the chat on it.'),
    (m) => {
      repair = m.text;
      return reply.kerrigan.send(undefined, { understanding: 'Goal: result.txt holding hello.', title: 'Write result.txt' });
    },
    // A secret in what a command printed: taken out of the exchange before it goes to her.
    reply.steps(write('result.txt', 'hell'), "Write-Output 'the config holds ghp_abcdefghijklmnopqrstuvwxyz0123456789'"),
    reply.done('I wrote result.txt with Set-Content; it holds hell.'),
    (m) => {
      firstExchange = Object.values(m.attached).join('\n');
      firstNames = Object.keys(m.attached).map((x) => x.replace(/^.*[\\/]/, ''));
      firstResult = m.text;
      return reply.kerrigan.send('Carry on in the same work: result.txt holds hell, not hello. Make it hold exactly hello and read it back.', { chat: 'same', twoChats: true, title: 'Fix result.txt' });
    },
    (m) => {
      refusedSame = m.text;
      return reply.kerrigan.send('Carry on in the same work: result.txt holds hell, not hello. Make it hold exactly hello and read it back.', { chat: 'same', title: 'Fix result.txt' });
    },
    (m) => {
      second = m.text;
      return reply.steps(write('result.txt', 'hello'), 'Get-Content result.txt');
    },
    reply.done('result.txt now holds hello; Get-Content prints hello.'),
    reply.kerrigan.done(),
  );
  t.check('it starts', (await h.call<{ started: boolean }>('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' })).started, true);
  await h.idle();
  const job = (await sessionOf(h, sent.threadId)).tasks[0]!;
  t.check('done', job.status, 'done');
  t.truthy('a reply in the wrong shape is sent back, with an example of the format', repair.startsWith('Your last reply did not match Kerrigan\'s format') && repair.includes('"status": "send"'), repair);
  t.truthy('"same" with another "twoChats" is sent back, with why', refusedSame.includes('"twoChats" is set when a chat begins') && refusedSame.includes('Nothing from your last reply was acted on'), refusedSame);
  const sends = job.kerrigan!.rounds.filter((r) => r.send).map((r) => [r.send!.n, r.send!.chat, r.send!.sessionId]);
  t.check('two messages, the second to the same chat', [sends.length, sends[1]?.[1], sends[0]?.[2] === sends[1]?.[2]], [2, 'same', true]);
  t.check('one chat of hers', job.kerrigan?.chats.length, 1);
  /*
   * The whole exchange (operator, 2026-11-12: "I copy the whole JSON, or the one message"; "make it an option"): with
   * Settings asking for it, the message's "JSON" is attached to its result and named there.
   */
  t.check('one file attached to the result: the exchange of her message', firstNames, ['exchange-of-message-1.txt']);
  let parsed: { format?: string } = {};
  try {
    parsed = JSON.parse(firstExchange) as typeof parsed;
  } catch {
    /* said below */
  }
  t.truthy('it is the exchange as its JSON button gives it: the prompt, the chat\'s replies, the commands', parsed.format === 'copilot-operator.task-exchange' && firstExchange.includes('Create result.txt at the root of the project') && firstExchange.includes('it holds hell.'), firstExchange.slice(0, 800));
  t.truthy('and the result says it is attached, and what it is', firstResult.includes('Attached, `exchange-of-message-1.txt`: the whole exchange of this message, as JSON'), firstResult.slice(-700));
  t.truthy('the exchange she was sent has the command and what it printed, the secret in it taken out', firstExchange.includes('the config holds') && firstExchange.includes('[REDACTED GITHUB TOKEN]') && !firstExchange.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), firstExchange.slice(0, 600));
  const chat = await chatOf(h, sends[0]![2] as string);
  t.check('the chat has both of her messages, in order', chat.tasks.map((x) => [x.title, x.fromKerrigan?.n]), [['Write result.txt', 1], ['Fix result.txt', 2]]);
  t.truthy('the second went into the same conversation, which already had the level 1 contract', !!second && h.chat.sent.filter((m) => m.contract === 'task').length === 1, second.slice(0, 300));
  t.check('result.txt holds hello', readFileSync(join(h.repo, 'result.txt'), 'utf8').trim(), 'hello');

  // A second task of the person's, in the same conversation: told so, and that a chat of hers is there to carry on.
  let next = '';
  h.chat.script(
    (m) => {
      next = m.text;
      return reply.kerrigan.done('Nothing to do: result.txt already holds hello, as the chat read back in the last message.', [], { understanding: 'Goal: check result.txt holds hello.' });
    },
  );
  await h.call('POST', '/chat', { text: 'Check that result.txt still holds hello.', threadId: sent.threadId });
  t.check('the next message starts', (await h.call<{ started: boolean }>('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' })).started, true);
  await h.idle();
  t.truthy('her next task is said to be a new one in the same conversation, with the chat she can carry on in', next.startsWith('A new task from the person, in this same conversation.') && next.includes('A chat of yours is there to carry on') && next.includes('"same" sends to it'), next);
  t.check('her contract was not sent again', h.chat.sent.filter((m) => m.contract === 'kerrigan').length, 1);
});

/*
 * Found 2026-11-18 (a review of the code against Kerrigan's description): "Continue" under her message, stopped while a
 * chat of hers was at work, started her over with no chats — "same" was refused, the chat she was directing was lost
 * with its conversation, and the count of what she may send began again.
 */
await scenario('stopped while her chat works, then carried on: "same" goes on in that chat, and what she sent is counted on', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: TASK, model: 'Think deeper', kerrigan: true, chatModel: 'Think deeper' });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  h.chat.script(
    reply.kerrigan.send(undefined, { understanding: 'Goal: result.txt holding hello.', title: 'Write result.txt' }),
    async () => {
      await gate;
      return reply.steps(write('result.txt', 'hello'));
    },
  );
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  await waitFor('her chat at work', async () => (await sessionOf(h, sent.threadId)).tasks.at(-1)?.kerrigan?.chats.length === 1 && h.chat.sent.filter((m) => !m.contract).length >= 2, 30_000);
  await h.call('POST', `/sessions/${sent.threadId}/stop`);
  release();
  await h.idle();
  const stopped = (await sessionOf(h, sent.threadId)).tasks.at(-1)!;
  const chatId = stopped.kerrigan?.chats[0];
  t.check('her message stopped, with the chat she was directing', [stopped.status, stopped.kerrigan?.chats.length, stopped.kerrigan?.sent], ['aborted', 1, 1]);

  let toldHer = '';
  h.chat.script(
    (m) => {
      toldHer = m.text;
      return reply.kerrigan.send('Carry on: make result.txt hold exactly hello, then read it back with Get-Content.', { chat: 'same', title: 'Finish result.txt' });
    },
    reply.steps(write('result.txt', 'hello')),
    reply.done('result.txt holds hello, as Get-Content printed.'),
    reply.kerrigan.done('Done: result.txt holds hello, as the chat read it back.', ['Get-Content result.txt printed hello']),
  );
  const r = await h.call<{ started: boolean }>('POST', `/chat/${sent.threadId}/tasks/${stopped.id}/continue`);
  await h.idle();
  const done = (await sessionOf(h, sent.threadId)).tasks.at(-1)!;
  const second = done.kerrigan?.rounds.find((x) => x.send)?.send;
  t.check('carried on: "same" went to the chat she was directing, not refused', [r.started, done.status, second?.chat, second?.sessionId === chatId, done.kerrigan?.chats], [true, 'done', 'same', true, [chatId]]);
  t.check('what she sent is counted on from the attempt before', done.kerrigan?.sent, 2);
  t.truthy('she was told she was carried on', toldHer.length > 0 && !/No chat of yours is there yet/.test(JSON.stringify(done.kerrigan?.rounds ?? [])), toldHer.slice(0, 300));
  t.truthy('the file written in the end', existsSync(join(h.repo, 'result.txt')) && readFileSync(join(h.repo, 'result.txt'), 'utf8').trim() === 'hello');
});

t.finish();
