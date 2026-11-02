/**
 * The chat's questions to the operator (operator, 2026-10-23: "answers to click, not only a text field; when the chat
 * proposes a command for the user to run by hand, a button behind it — the bot runs it; and an option in Settings to
 * always agree with what the bot proposes"), end to end through the API with the scripted chat:
 *
 * - "ask" in the reply's format: a question and at least two answers, read; one answer is sent back;
 * - the card: the question, its answers in order, the command an answer carries, asked by the worker;
 * - an answer chosen that carries a command: the bot runs it at once — no other card, the click being the
 *   permission — and the chat gets the answer with the command's output;
 * - an answer without one: the chat gets the answer, and goes on;
 * - Settings agree with what the bot proposes: no card; the recommended answer, the first, is taken and its command
 *   run, and the conversation says so; the lead's question too;
 * - a question of several answers (2026-11-02): said in the format, its answers carrying no command; the card says so;
 *   the ones chosen, by their place, checked, and told to the chat or the lead one a line, with what was written; a
 *   queue task set aside at it answered the same way.
 *
 *   npm run check:e2e-ask
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReply } from '../src/protocol/parser.js';
import { parseLeadReply } from '../src/protocol/leadSchema.js';
import { chosenAnswer, chosenSaid } from '../src/orchestrator/chosenAnswers.js';
import { parkedAnswerFrom } from '../src/queue/queue.js';
import type { PendingApproval } from '../src/session/model.js';
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
type Card = { id: string; actor?: string; question?: { text: string; options: string[]; commands?: Array<string | null>; multiple?: boolean } };

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

const plan = (h: Harness, name: string) => ({
  version: 1,
  sessions: [{ name, onFailure: 'stop', projectDir: h.repo, vcs: { enabled: false }, review: { enabled: false },
    tasks: [{ title: 'sign-in', prompt: 'Write signed.txt in the project folder once the operator has agreed to sign in, and say what was done.' }] }],
});
const SIGN_IN = "Set-Content -Path signed.txt -Value 'signed' -Encoding utf8";
const OPTS = { stopMarker: 'Край', defaultShell: 'pwsh' as const };

console.log('--- the format ---');
{
  const asked = parseReply(reply.ask('Shall I sign in?', [{ answer: 'Yes', run: 'az login' }, 'No']), OPTS);
  t.check('a question with two answers is read, a bare string an answer alone', asked.ok ? [asked.reply.status, asked.reply.options, asked.done] : asked, ['ask', [{ answer: 'Yes', run: 'az login' }, { answer: 'No' }], false]);
  const one = parseReply(reply.ask('Shall I sign in?', ['Yes']), OPTS);
  t.truthy('one answer is not enough: sent back, with how to write it', !one.ok && /at least two "options"/.test(one.detail ?? ''), one);
  const withSteps = parseReply('```json\n' + JSON.stringify({ status: 'ask', question: 'Shall I sign in?', options: ['Yes', 'No'], steps: [{ id: 1, type: 'command', cmd: 'az login' }] }) + '\n```', OPTS);
  t.truthy('nor does a question carry steps: the command goes in an answer', !withSteps.ok && /"ask" for the operator's answer/.test(withSteps.detail ?? ''), withSteps);
  // More than one answer at a time (operator, 2026-11-02): said by the chat, its answers carrying no command.
  const many = parseReply(reply.ask('Which checks shall I add?', ['Unit tests', 'An end-to-end check', 'A lint rule'], undefined, true), OPTS);
  t.check('a question of several answers is read as one, a question of one answer unless it says so', [many.ok ? [many.reply.status, many.reply.multiple] : many, asked.ok ? asked.reply.multiple : asked], [['ask', true], false]);
  const manyRun = parseReply(reply.ask('Which shall I run?', [{ answer: 'The tests', run: 'npm test' }, 'The linter'], undefined, true), OPTS);
  t.truthy('its answers carry no command: sent back, with what to do instead', !manyRun.ok && /cannot carry "run"/.test(manyRun.detail ?? ''), manyRun);
  const leadMany = parseLeadReply(reply.lead.ask('Which of the folders should the lead clean?', ['the old one', 'the new one'], { multiple: true }));
  const leadOne = parseLeadReply(reply.lead.ask('Which of the folders should the lead clean?', ['the old one'], { multiple: true }));
  t.check('the lead\'s too, with two answers to choose from at least', [leadMany.ok ? leadMany.reply.multiple : leadMany, leadOne.ok], [true, false]);
}

console.log('\n--- the answers chosen ---');
{
  const q = { options: ['A', 'B', 'C'], multiple: true };
  t.check('the ones chosen in their order, once each, and what was written under them', chosenAnswer(q, [2, 0, 2], ' and X '), { answer: '- A\n- C\n\nand X', chosen: ['A', 'C'], written: 'and X' });
  t.check('none chosen, a place that is not there, not a number: refused', [chosenAnswer(q, [], ''), chosenAnswer(q, [3], ''), chosenAnswer(q, ['0'], ''), chosenAnswer(q, 1, '')].map((r) => 'problem' in r), [true, true, true, true]);
  t.check('a question of one answer takes no choice of several', 'problem' in chosenAnswer({ options: ['A', 'B'] }, [0], ''), true);
  t.check('what the chat is told', [chosenSaid({ chosen: ['A', 'C'], written: 'and X' }), chosenSaid({ chosen: ['B'] })], ['choosing 2 of your answers:\n\n- A\n- C\n\nAnd wrote:\n\nand X', 'choosing one of your answers:\n\n- B']);
  const parked = { kind: 'question' as const, approval: { question: { text: 'Which?', options: ['A', 'B', 'C'], multiple: true } } as unknown as PendingApproval };
  t.check('a queue task set aside at it is answered the same way', [parkedAnswerFrom(parked, { answer: '', chosen: [1] }), 'problem' in parkedAnswerFrom(parked, { answer: '', chosen: [] }), parkedAnswerFrom(parked, { answer: 'none of them' })], [{ kind: 'question', answer: '- B', chosen: ['B'] }, true, { kind: 'question', answer: 'none of them' }]);
}

await scenario('a question, answered with the answer that carries a command: the bot runs it, and the chat is told', { execution: { mode: 'confirm' } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'ask-run'));
  let told = '';
  h.chat.script(
    reply.ask('The work needs a sign-in. Shall I do it now?', [{ answer: 'Yes, sign in', run: SIGN_IN }, 'No, stop here'], 'Nothing is signed in yet.'),
    (m) => {
      told = m.text;
      return reply.done('Signed in as the operator chose: signed.txt was written by the command the answer carried, and read back.');
    },
  );
  await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' });
  const card = await waitFor('the question', async () => (await h.call<Card[]>('GET', '/approvals')).find((a) => !!a.question), 60_000);
  t.check('the card: the question, its answers in order, the command one carries, asked by the worker',
    [card.question?.text, card.question?.options, card.question?.commands, card.actor],
    ['The work needs a sign-in. Shall I do it now?', ['Yes, sign in', 'No, stop here'], [SIGN_IN, null], 'worker']);
  await h.call('POST', `/approvals/${card.id}/answer`, { text: 'Yes, sign in' });
  await h.idle();
  t.check('the command ran at once, with no other card to answer', [existsSync(join(h.repo, 'signed.txt')) ? readFileSync(join(h.repo, 'signed.txt'), 'utf8').trim() : null], ['signed']);
  t.truthy('the chat was told the answer, and given the output of the command it carried', told.includes('"Yes, sign in"') && told.includes('The runner ran the command that answer carries'), told.slice(0, 600));
  t.check('done', (await h.session(s!.id)).tasks[0]!.status, 'done');
});

await scenario('a question, answered with an answer that carries no command: the chat is told, and goes on', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'ask-text'));
  let told = '';
  h.chat.script(
    reply.ask('Should signed.txt hold the date as well?', ['No, the word alone', 'Yes, with the date']),
    (m) => {
      told = m.text;
      return reply.steps(SIGN_IN);
    },
    reply.done('signed.txt holds the word alone, as the operator answered, and was read back to check it.'),
  );
  await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  const card = await waitFor('the question', async () => (await h.call<Card[]>('GET', '/approvals')).find((a) => !!a.question), 60_000);
  t.check('asked in a run without asking too: only the operator can answer', !!card, true);
  t.check('a question of one answer takes no choice of several', (await h.raw('POST', `/approvals/${card.id}/answer`, { text: '', chosen: [0] })).status, 400);
  await h.call('POST', `/approvals/${card.id}/answer`, { text: 'No, the word alone' });
  await h.idle();
  t.truthy('the answer reached the chat', told.startsWith('The operator answered your question') && told.includes('"No, the word alone"'), told.slice(0, 300));
  t.check('and the work went on to its end', (await h.session(s!.id)).tasks[0]!.status, 'done');
});

await scenario('a question of several answers: the ones chosen, and what was written, reach the chat', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'ask-many'));
  let told = '';
  h.chat.script(
    reply.ask('Which lines should signed.txt hold?', ['The word signed', 'The date', 'The user name'], 'The task does not say.', true),
    (m) => {
      told = m.text;
      return reply.steps(SIGN_IN);
    },
    reply.done('signed.txt holds the word signed, as the operator chose, and was read back to check it.'),
  );
  await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  const card = await waitFor('the question', async () => (await h.call<Card[]>('GET', '/approvals')).find((a) => !!a.question), 60_000);
  t.check('the card says more than one may be chosen', [card.question?.options, card.question?.multiple], [['The word signed', 'The date', 'The user name'], true]);
  const refused = [(await h.raw('POST', `/approvals/${card.id}/answer`, { text: '', chosen: [] })).status, (await h.raw('POST', `/approvals/${card.id}/answer`, { text: '', chosen: [5] })).status];
  t.check('none chosen, or one that is not there: refused, and the card still waits', [refused, (await h.call<Card[]>('GET', '/approvals')).some((a) => a.id === card.id)], [[400, 400], true]);
  await h.call('POST', `/approvals/${card.id}/answer`, { text: 'Nothing else.', chosen: [2, 0] });
  await h.idle();
  t.check('the chat is told the ones chosen, in their order, and what was written',
    told.split('\n\nGo on')[0],
    'The operator answered your question ("Which lines should signed.txt hold?"), choosing 2 of your answers:\n\n- The word signed\n- The user name\n\nAnd wrote:\n\nNothing else.');
  t.check('and the work went on to its end', (await h.session(s!.id)).tasks[0]!.status, 'done');
});

await scenario("the lead's question of several answers: the ones chosen reach the lead, and stay on its round", { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h) => {
  const sent = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create result.txt holding the word hello.', model: 'Think deeper', lead: true });
  let told = '';
  h.chat.script(
    reply.lead.ask('Which of these should result.txt hold besides hello?', ['the date', 'the user name', 'nothing else'], { understanding: 'Goal: result.txt holding hello. Done when it is there and read back.', multiple: true }),
    (m) => {
      told = m.text;
      return reply.lead.done(undefined, ['result.txt']);
    },
  );
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  const card = await waitFor('the lead\'s question', async () => (await h.call<Card[]>('GET', `/approvals?session=${sent.threadId}`)).find((a) => !!a.question), 20_000);
  t.check('the card says more than one may be chosen, asked by the lead', [card.question?.multiple, card.actor], [true, 'lead']);
  await h.call('POST', `/approvals/${card.id}/answer`, { text: '', chosen: [0, 1] });
  await h.idle();
  t.check('the lead is told the ones chosen', told.split('\n\nGo on')[0], 'The operator answered your question, choosing 2 of your answers:\n\n- the date\n- the user name');
  const round = ((await h.session(sent.threadId)).tasks[0] as unknown as { lead?: { rounds: Array<{ question?: { multiple?: boolean; answer?: string; chosen?: string[] } }> } }).lead?.rounds[0]?.question;
  t.check('and its round keeps the question\'s kind, the answer and the ones chosen', [round?.multiple, round?.answer, round?.chosen], [true, '- the date\n- the user name', ['the date', 'the user name']]);
});

await scenario('Settings agree with what the bot proposes: no card; the recommended answer taken and its command run', { execution: { mode: 'unattended', isolation: 'none-accepted', questions: 'agree' } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'ask-agree'));
  let told = '';
  h.chat.script(
    reply.ask('Shall I sign in now?', [{ answer: 'Yes, sign in', run: SIGN_IN }, 'No']),
    (m) => {
      told = m.text;
      return reply.done('Signed in as recommended: signed.txt was written by the command of the first answer, and read back.');
    },
  );
  await h.run(s!.id, 'unattended');
  t.check('nothing waited for anyone', (await h.call<Card[]>('GET', '/approvals')).length, 0);
  t.check('the first answer was taken, and its command run', existsSync(join(h.repo, 'signed.txt')), true);
  t.truthy('the chat is told it was its recommended answer', told.includes('The runner took your recommended answer'), told.slice(0, 300));
  const events = await h.call<Array<{ type: string }>>('GET', `/sessions/${s!.id}/events`);
  t.check('and the record says so', events.filter((e) => e.type === 'question-agreed').length, 1);
});

await scenario("Settings agree: the lead's question answered as it recommends", { execution: { mode: 'unattended', isolation: 'none-accepted', questions: 'agree' } }, async (h) => {
  const sent = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create result.txt holding the word hello.', model: 'Think deeper', lead: true });
  let told = '';
  h.chat.script(
    reply.lead.ask('Should result.txt end with a new line?', ['No new line', 'With a new line'], { understanding: 'Goal: result.txt holding hello. Done when it is there and read back.' }),
    (m) => {
      told = m.text;
      return reply.lead.done(undefined, ['result.txt']);
    },
  );
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  await h.idle();
  t.check('no card waited', (await h.call<Card[]>('GET', '/approvals')).length, 0);
  t.truthy('the lead got its recommended answer', told.includes('No new line'), told.slice(0, 300));
});

t.finish();
