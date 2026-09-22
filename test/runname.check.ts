/**
 * What a run is called when nobody typed anything.
 *
 * "Unnamed run" was the heading on half the register, and the two places it appeared hardest are
 * the two where naming is least convenient: continuing after a failure, and "Run again from
 * here", which starts a run from a task card that has no field to type into and never named
 * anything at all. A register that groups finished work under its run, and then labels the group
 * with nothing, has thrown away the grouping.
 *
 * So the questions here are whether a name is always produced, whether it says what the run is
 * about, and — the one that matters most — whether two goes at the same work can be told apart.
 * A second run that simply reused the first one's name would be worse than no name: two headings
 * reading `rules-engine`, one of them stale, and nothing to say which.
 *
 *   npm run check:runname
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionStore } from '../src/session/store.js';
import { suggestRunName } from '../src/session/runName.js';
import type { Session, TaskRunGroup } from '../src/session/model.js';

let wrong = 0;
const check = (what: string, got: unknown, expected: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) wrong += 1;
  console.log(`  ${ok ? ' ' : '!'} ${what.padEnd(48)}:`, JSON.stringify(got), `(expect ${JSON.stringify(expected)})`);
};

const dir = await mkdtemp(join(tmpdir(), 'cop-runname-'));
const store = new SessionStore(dir, join(process.cwd(), 'prompts', 'level1.md'));
await store.init();

/** The rule itself, over whatever the store holds right now. */
const suggest = async (sessionIds: string[], about?: string): Promise<string> =>
  suggestRunName(await store.listSessions(), sessionIds, about);

const group = (name: string | undefined, at: string): TaskRunGroup => ({ id: `r-${at}`, startedAt: at, sessions: 1, ...(name ? { name } : {}) });

const a = await store.createSession('billing');
const b = await store.createSession('invoices');

console.log('--- a session that has never run ---');
check('takes the session name', await suggest([a.id]), 'billing');
check('two of them say how many', await suggest([a.id, b.id]), '2 sessions');
check('and a task can name it instead', await suggest([a.id, b.id], 'csv-writer'), 'csv-writer');
check('nothing at all still gets a name', await suggest([]), 'run');

console.log('\n--- continuing a run that had a name ---');
await store.updateSession(a.id, (s) => { s.runGroup = { ...group('rules-engine', '2026-09-20T10:00:00.000Z'), order: 0, taskIds: [], mode: 'confirm', onFailure: 'stop' }; });
check('the second go is told apart', await suggest([a.id]), 'rules-engine #2');
await store.updateSession(b.id, (s) => { s.runGroup = { ...group('rules-engine #2', '2026-09-20T11:00:00.000Z'), order: 0, taskIds: [], mode: 'confirm', onFailure: 'stop' }; });
check('and so is the third', await suggest([a.id]), 'rules-engine #3');
check('the number is not stacked up', (await suggest([b.id])).includes('#2 #'), false);

console.log('\n--- continuing a run that had none ---');
const c = await store.createSession('payroll');
await store.updateSession(c.id, (s) => { s.runGroup = { ...group(undefined, '2026-09-20T12:00:00.000Z'), order: 0, taskIds: [], mode: 'confirm', onFailure: 'stop' }; });
check('falls back to the session name', await suggest([c.id]), 'payroll');

console.log('\n--- the newest name wins, not the first found ---');
const d = await store.createSession('ledger');
await store.updateSession(d.id, (s) => {
  s.runGroup = { ...group('older', '2026-09-19T09:00:00.000Z'), order: 0, taskIds: [], mode: 'confirm', onFailure: 'stop' };
});
await store.addTask(d.id, { title: 'one', prompt: 'A prompt that is definitely long enough to be real.', level2: '' });
const withTask = (await store.getSession(d.id)) as Session;
await store.updateTask(d.id, withTask.tasks[0].id, (t) => { t.runGroup = group('newer', '2026-09-21T09:00:00.000Z'); });
check('takes the latest run these sessions had', await suggest([d.id]), 'newer #2');

console.log('\n--- a name is always produced ---');
const every = await Promise.all([suggest([a.id]), suggest([b.id]), suggest([c.id]), suggest([d.id]), suggest([]), suggest([a.id, b.id, c.id])]);
check('never empty', every.every((n) => n.trim().length > 0), true);
check('never says unnamed', every.every((n) => !/unnamed|без име/i.test(n)), true);
/*
 * Sessions with different histories get different names; ones asked about together do not, and
 * should not. The rule is a pure question about the state as it stands, and the state only
 * changes when a run actually starts — which it cannot do twice at once, because the browser
 * profile is single-writer and both entry points refuse while a run is in flight.
 */
check('different work, different names', new Set([every[2], every[3], every[4]]).size, 3);
check('the same work asked twice agrees', every[0], every[1]);
console.log('  they are            :', JSON.stringify(every));

await rm(dir, { recursive: true, force: true });

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
