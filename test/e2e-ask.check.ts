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
 *   run, and the conversation says so; the lead's question too.
 *
 *   npm run check:e2e-ask
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReply } from '../src/protocol/parser.js';
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
type Card = { id: string; actor?: string; question?: { text: string; options: string[]; commands?: Array<string | null> } };

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
  await h.call('POST', `/approvals/${card.id}/answer`, { text: 'No, the word alone' });
  await h.idle();
  t.truthy('the answer reached the chat', told.startsWith('The operator answered your question') && told.includes('"No, the word alone"'), told.slice(0, 300));
  t.check('and the work went on to its end', (await h.session(s!.id)).tasks[0]!.status, 'done');
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
