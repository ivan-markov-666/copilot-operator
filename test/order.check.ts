/**
 * The sessions list in the operator's order (asked for on 2026-10-01).
 *
 * An imported plan used to appear upside down: the list was newest first, and a plan's sessions are
 * created one after another. Now the plan comes in on top in the plan's own order, a new session goes
 * on top, and the operator's arrangement — sent as the whole list, top to bottom — is what is stored.
 * A list that leaves a session out, names one twice or names one that does not exist is refused.
 *
 *   npm run check:order
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, Tally, type Harness } from './support/harness.js';

const t = new Tally();

const plan = (names: string[]): Record<string, unknown> => ({
  version: 1,
  sessions: names.map((name) => ({
    name,
    onFailure: 'stop',
    vcs: { enabled: false, repoDir: '' },
    review: { enabled: false },
    tasks: [{ title: `${name}-task`, prompt: 'Create here.txt in the project folder holding exactly here, and nothing else.' }],
  })),
});
const names = async (h: Harness): Promise<string[]> => (await h.call<Array<{ name: string }>>('GET', '/sessions')).map((s) => s.name);
const ids = async (h: Harness): Promise<string[]> => (await h.call<Array<{ id: string }>>('GET', '/sessions')).map((s) => s.id);

const h = await startHarness();
try {
  console.log('--- an imported plan comes in on top, in the plan\'s order ---');
  await h.importPlan(plan(['first', 'second', 'third']));
  t.check('the plan\'s order, not newest first', await names(h), ['first', 'second', 'third']);
  await h.importPlan(plan(['later-a', 'later-b']));
  t.check('a second plan on top of the first, each in its own order', await names(h), ['later-a', 'later-b', 'first', 'second', 'third']);
  await h.call('POST', '/sessions', { name: 'by-hand' });
  t.check('a session made by hand goes on top', (await names(h))[0], 'by-hand');

  console.log('\n--- the operator\'s order is what is stored ---');
  const reversed = (await ids(h)).reverse();
  const back = await h.call<Array<{ id: string }>>('PUT', '/sessions-order', { ids: reversed });
  t.check('the answer is the list in the new order', back.map((s) => s.id), reversed);
  t.check('and reading it again gives the same', await ids(h), reversed);
  await h.call('POST', '/sessions', { name: 'newest' });
  t.check('a session made after an arrangement still goes on top', (await names(h))[0], 'newest');

  console.log('\n--- an order that does not name every session once is refused ---');
  const all = await ids(h);
  const missing = await h.raw('PUT', '/sessions-order', { ids: all.slice(1) });
  t.truthy('one left out: refused, saying so', missing.status === 400 && /leaves out 1 session/.test(JSON.stringify(missing.body)), missing);
  const twice = await h.raw('PUT', '/sessions-order', { ids: [...all, all[0]] });
  t.truthy('one named twice: refused', twice.status === 400 && /twice/.test(JSON.stringify(twice.body)), twice);
  const unknown = await h.raw('PUT', '/sessions-order', { ids: [...all.slice(1), 'nope'] });
  t.truthy('one that does not exist: refused, naming it', unknown.status === 400 && /nope/.test(JSON.stringify(unknown.body)), unknown);
  const notAList = await h.raw('PUT', '/sessions-order', { ids: 'x' });
  t.check('not a list: refused', notAList.status, 400);
  t.check('and the stored order is untouched by every refusal', await ids(h), all);

  console.log('\n--- a session saved before the list could be arranged ---');
  // Written as a file of the old shape: no position. It sorts by when it was made, newest first,
  // and an arrangement sent afterwards places it like any other.
  mkdirSync(join(h.dataDir, 'sessions'), { recursive: true });
  writeFileSync(
    join(h.dataDir, 'sessions', '20260101-000000-old1.json'),
    JSON.stringify({ id: '20260101-000000-old1', name: 'old', createdAt: '2026-01-01T00:00:00.000Z', status: 'idle', contractSent: false, onFailure: 'stop',
      vcs: { enabled: false, repoDir: '', branchMode: 'per-task', commitOnFinish: true, branchPrefix: 'cop/' }, projectDir: '', tasks: [] }),
    'utf8',
  );
  const withOld = await names(h);
  t.check('it is listed', withOld.includes('old'), true);
  const arranged = await ids(h);
  const oldAtEnd = [...arranged.filter((id) => id !== '20260101-000000-old1'), '20260101-000000-old1'];
  await h.call('PUT', '/sessions-order', { ids: oldAtEnd });
  t.check('and an arrangement places it like any other', (await names(h)).at(-1), 'old');
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h.stop();
}

t.finish();
