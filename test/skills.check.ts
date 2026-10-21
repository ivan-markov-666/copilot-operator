/**
 * Skills (operator, 2026-10-21): "a skill I can set and call for a certain task — information that belongs only to
 * one task that comes back: adding a new automated test, a new entity, migrations of the database".
 *
 * Held here, through the API and the scripted chat:
 *   - Settings keep a list of skills held to the rules: a name to type after `/`, used once; instructions that are
 *     there and not too long; a project of Settings or every project;
 *   - a message sent with a skill carries its instructions to Copilot, before the task, under "## Skill: <name>";
 *     the task keeps the skill as it read then, whatever is edited later; Continue sends the same one;
 *   - a skill for another project, or one that is not there, is refused with what there is; a note to a message at
 *     work cannot carry one;
 *   - with two chats, the lead is given it with the assignment and the worker with every subtask;
 *   - Kerrigan lists the skills.
 *
 *   npm run check:skills
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { startHarness, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

type Skill = { name: string; description: string; text: string; projectDir: string };
type Sent = { threadId: string; taskId: string };
type Thread = { id: string; lead?: { workerSessionId?: string }; tasks: Array<{ id: string; status: string; prompt: string; skill?: { name: string; text: string } }> };

const TEST_SKILL: Skill = {
  name: 'new-test',
  description: 'Adding an automated test',
  text: 'Tests live in tests/e2e, one file per page, named <page>.spec.ts. Run npm run test:e2e -- <file> and show it passing.',
  projectDir: '',
};

async function scenario(title: string, body: (h: Harness) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings: { execution: { mode: 'unattended', isolation: 'none-accepted' } } });
  try {
    await body(h);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

const refusal = async (h: Harness, method: string, path: string, body: unknown): Promise<string> => {
  const r = await h.raw(method, path, body);
  return r.status >= 400 ? String((r.body as { message?: string })?.message ?? r.status) : `accepted (${r.status})`;
};

await scenario('Settings: the list and its rules', async (h) => {
  t.check('none at first', (await h.call<{ skills: Skill[] }>('GET', '/skills')).skills, []);
  t.truthy('a name that cannot be typed after / is refused', (await refusal(h, 'PUT', '/skills', { skills: [{ ...TEST_SKILL, name: 'New Test!' }] })).includes('cannot be a skill\'s name'), await refusal(h, 'PUT', '/skills', { skills: [{ ...TEST_SKILL, name: 'New Test!' }] }));
  t.truthy('a name used twice is refused', (await refusal(h, 'PUT', '/skills', { skills: [TEST_SKILL, TEST_SKILL] })).includes('Two skills are named'), '');
  t.truthy('no instructions: refused', (await refusal(h, 'PUT', '/skills', { skills: [{ ...TEST_SKILL, text: '  ' }] })).includes('has no instructions'), '');
  t.truthy('instructions too long: refused', (await refusal(h, 'PUT', '/skills', { skills: [{ ...TEST_SKILL, text: 'x'.repeat(8001) }] })).includes('longer than'), '');
  t.truthy('a project that is not in Settings: refused', (await refusal(h, 'PUT', '/skills', { skills: [{ ...TEST_SKILL, projectDir: 'C:\\nowhere' }] })).includes('not one of the projects'), '');
  const saved = await h.call<{ skills: Skill[]; maxText: number }>('PUT', '/skills', { skills: [{ ...TEST_SKILL, name: 'New-Test' }] });
  t.check('saved, the name in lowercase, with the limit of its instructions', [saved.skills.map((k) => k.name), saved.maxText], [['new-test'], 8000]);
  t.check('and read back', (await h.call<{ skills: Skill[] }>('GET', '/skills')).skills[0]?.text, TEST_SKILL.text);
});

await scenario('a message with a skill: its instructions go to Copilot, and the task keeps them as they read', async (h) => {
  await h.call('PUT', '/skills', { skills: [TEST_SKILL, { name: 'db-migration', description: 'A migration', text: 'Migrations go in db/migrations.', projectDir: h.repo }] });
  let opening = '';
  h.chat.script((m) => {
    opening = m.text;
    return reply.done('The test was written where the skill says and run: it passes, as its output shows.');
  });
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Add a test for the login page.', model: 'Think deeper', skill: 'new-test' });
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  await h.idle();
  const thread = await h.call<Thread>('GET', `/sessions/${sent.threadId}`);
  t.check('the task keeps the skill it was sent with', thread.tasks[0]?.skill?.name, 'new-test');
  const sentAll = h.chat.sent.map((m) => m.text).join('\n\n');
  const at = sentAll.indexOf('## Skill: new-test');
  t.truthy('Copilot is given it: its name, what it is for, its instructions', at >= 0 && sentAll.includes('For: Adding an automated test') && sentAll.includes(TEST_SKILL.text), sentAll.slice(-1200));
  t.truthy('before the task itself', at >= 0 && at < sentAll.indexOf('Add a test for the login page.'), String(at));
  t.check('the message is the operator\'s, without the skill in it', thread.tasks[0]?.prompt, 'Add a test for the login page.');

  // Edited in Settings afterwards: the task keeps what it was told.
  await h.call('PUT', '/skills', { skills: [{ ...TEST_SKILL, text: 'Something else entirely, written later.' }] });
  t.check('a later edit does not change what the task was sent with', (await h.call<Thread>('GET', `/sessions/${sent.threadId}`)).tasks[0]?.skill?.text, TEST_SKILL.text);

  // A skill for the open folder is offered here; one for a folder elsewhere is not.
  const other = join(h.base, 'other-project');
  mkdirSync(other, { recursive: true });
  await h.call('PUT', '/project', { others: [{ name: 'other', rootDir: other }] });
  await h.call('PUT', '/skills', { skills: [TEST_SKILL, { name: 'elsewhere', description: '', text: 'For the other project.', projectDir: other }] });
  t.truthy('a skill for another project is refused here, saying whose it is', (await refusal(h, 'POST', '/chat', { text: 'x y z', skill: 'elsewhere' })).includes('not for the folder this chat works in'), '');
  t.truthy('one that is not there: refused, with the ones there are', (await refusal(h, 'POST', '/chat', { text: 'x y z', skill: 'nope' })).includes('there are new-test'), await refusal(h, 'POST', '/chat', { text: 'x y z', skill: 'nope' }));

  const kerrigan = await h.call<{ text: string }>('GET', '/kerrigan?lang=en');
  t.truthy('Kerrigan lists the skills, each with its project', kerrigan.text.includes('## The skills') && kerrigan.text.includes('`/new-test` (every project) — Adding an automated test') && kerrigan.text.includes('`/elsewhere` (other)'), kerrigan.text.slice(kerrigan.text.indexOf('## The skills'), kerrigan.text.indexOf('## How you help')));
});

await scenario('a note to a message at work cannot carry a skill', async (h) => {
  await h.call('PUT', '/skills', { skills: [TEST_SKILL] });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  h.chat.script(async () => {
    await held;
    return reply.done('Done after the note: nothing else was asked, and the folder was left as it was.');
  });
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Look at the folder.', model: 'Think deeper' });
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  for (let i = 0; i < 100 && h.chat.pending > 0; i++) await new Promise((r) => setTimeout(r, 100));
  t.truthy('refused, with when to send it', (await refusal(h, 'POST', '/chat', { text: 'and this', threadId: sent.threadId, skill: 'new-test' })).includes('A skill goes with a new message'), '');
  release();
  await h.idle();
});

await scenario('two chats: the lead is given the skill, and the worker with every subtask', async (h) => {
  await h.call('PUT', '/skills', { skills: [TEST_SKILL] });
  let assignment = '';
  let subtask = '';
  h.chat.script(
    (m) => {
      assignment = m.text;
      return reply.lead.delegate({ title: 'Write the test', readOnly: false }, { understanding: 'Add a test for the login page, as the skill says; done when it passes.' });
    },
    (m) => {
      subtask = m.text;
      return reply.done('The worker wrote the test as the skill says and ran it: it passes.');
    },
    reply.lead.done('The test for the login page is written as the skill says, and it passes.'),
  );
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Add a test for the login page.', model: 'Think deeper', lead: true, skill: 'new-test' });
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  await h.idle();
  const leadSent = h.chat.sent.filter((m) => m.contract === 'lead' || m.text.includes('## Assignment')).map((m) => m.text).join('\n\n');
  t.truthy('the assignment carries the skill', (leadSent + assignment).includes('## Skill: new-test') && (leadSent + assignment).includes(TEST_SKILL.text), (leadSent + assignment).slice(-900));
  const workerSent = h.chat.sent.filter((m) => m.text.includes('subtask 1 of a larger assignment') || m.text.includes('## Skill: new-test')).map((m) => m.text).join('\n\n');
  t.truthy('and the worker\'s subtask too', (workerSent + subtask).includes('## Skill: new-test'), (workerSent + subtask).slice(-900));
  const worker = await h.call<Thread>('GET', `/sessions/${(await h.call<Thread>('GET', `/sessions/${sent.threadId}`)).lead?.workerSessionId}`);
  t.check('the worker\'s subtask keeps it too', worker.tasks[0]?.skill?.name, 'new-test');
});

t.finish();
