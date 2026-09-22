/**
 * The three exports of a chosen set of tasks, in one file.
 *
 * The register offers plan, work and runner separately, which is right when the question is
 * known and wrong for the thing the operator does most: hand a failure to a chat model and ask
 * what happened. That needs all three, and it needs them for the tasks they picked — which may
 * be one from each of three runs, not one whole run.
 *
 * So the questions here are about the selection and about the shape. Does the file hold exactly
 * the tasks that were ticked and no others, across sessions? Do all three parts agree on which
 * those are? And — the one that decides the whole design — is the `plan` inside it still the
 * document the plan download gives, so it goes back in through the import page untouched? The
 * alternative shape, one array of tasks each carrying its own three views, reads better and
 * fails that last question, which is why it was not built.
 *
 *   npm run check:bundle
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildBundleExport } from '../src/session/exports.js';
import { checkPlan } from '../src/plan/schema.js';
import { SessionStore } from '../src/session/store.js';
import type { Session, Task } from '../src/session/model.js';

let wrong = 0;
const check = (what: string, got: unknown, expected: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) wrong += 1;
  console.log(`  ${ok ? ' ' : '!'} ${what.padEnd(46)}:`, got, `(expect ${JSON.stringify(expected)})`);
};

const dir = await mkdtemp(join(tmpdir(), 'cop-bundle-'));
const store = new SessionStore(dir, join(process.cwd(), 'prompts', 'level1.md'));
await store.init();

/** A task that has run, with enough on it for all three views to have something to say. */
const ran = (title: string, n: number): Partial<Task> => ({
  title,
  prompt: `Do the ${title} work. This prompt is long enough to be a real instruction for it.`,
  status: 'done',
  summary: `${title} finished`,
  startedAt: '2026-09-21T10:00:00.000Z',
  finishedAt: '2026-09-21T10:10:00.000Z',
  iterations: n,
  runId: `run-${title}`,
});

const sessions: Session[] = [];
for (const [name, titles] of [
  ['alpha', ['one', 'two']],
  ['beta', ['three']],
] as Array<[string, string[]]>) {
  const s = await store.createSession(name);
  for (const title of titles) {
    await store.addTask(s.id, { title, prompt: `Do the ${title} work. This prompt is long enough to be a real instruction for it.`, level2: '' });
  }
  await store.updateSession(s.id, (x) => {
    x.vcs = { enabled: false, repoDir: '', branchMode: 'per-task', commitOnFinish: false, branchPrefix: 'cop/' };
  });
  const full = (await store.getSession(s.id)) as Session;
  for (const [i, task] of full.tasks.entries()) {
    await store.updateTask(s.id, task.id, (t) => Object.assign(t, ran(t.title, i + 1)));
  }
  sessions.push((await store.getSession(s.id)) as Session);
}

const machine = { node: 'x', platform: 'win32', cwd: dir, limits: {} };
const all = sessions.flatMap((s) => s.tasks.map((t) => ({ session: s, task: t })));
console.log('the store holds   :', all.map((x) => `${x.session.name}/${x.task.title}`).join(', '));

/*
 * One task from each of two sessions, which is the case the whole feature exists for: a run
 * export cannot express it, and three separate downloads of it is six files.
 */
console.log('\n--- a selection that crosses sessions ---');
const chosen = new Set([all[0].task.id, all[2].task.id]);
const scope = { sessions, taskFilter: (_s: Session, t: Task) => chosen.has(t.id), label: '2-tasks-2-sessions' };
const bundle = await buildBundleExport(scope, join(dir, 'runs'), machine);

check('the parts are all there', Object.keys(bundle).sort(), ['about', 'chosen', 'exportedAt', 'plan', 'runner', 'work']);
const chosenNames = (bundle.chosen as Array<{ session: string; task: string }>).map((c) => `${c.session}/${c.task}`);
check('it names what was chosen', chosenNames, ['alpha/one', 'beta/three']);

const planDoc = bundle.plan as { sessions: Array<{ name: string; tasks: Array<{ title: string }> }> };
check('the plan holds only those', planDoc.sessions.map((s) => `${s.name}:${s.tasks.map((t) => t.title).join('+')}`), ['alpha:one', 'beta:three']);
// Both nest the task under `task`, beside the session and their own view of it.
type Viewed = { tasks: Array<{ session: unknown; task: { title: string } }> };
const workTitles = (bundle.work as Viewed).tasks.map((t) => t.task.title);
const runnerTitles = (bundle.runner as Viewed).tasks.map((t) => t.task.title);
check('the work holds only those', workTitles, ['one', 'three']);
check('the runner agrees', runnerTitles, workTitles);
check('the task nobody ticked is absent', JSON.stringify(bundle).includes('"two"'), false);

/*
 * The property the shape was chosen for. A plan that no longer validates is a plan the operator
 * cannot put back through the import page, which is the only thing the plan export is for.
 */
console.log('\n--- the plan inside it still imports ---');
const verdict = checkPlan(JSON.stringify(bundle.plan));
check('it validates', verdict.ok, true);
if (verdict.ok) check('as the same two sessions', verdict.summary.sessions.length, 2);

console.log('\n--- one task, and the whole of one session ---');
const one = await buildBundleExport({ sessions: [sessions[1]], taskFilter: (_s, t) => t.id === all[2].task.id, label: 'beta-three' }, join(dir, 'runs'), machine);
check('one task, one session', (one.chosen as unknown[]).length, 1);
const whole = await buildBundleExport({ sessions: [sessions[0]], label: 'alpha' }, join(dir, 'runs'), machine);
check('no filter means every task', (whole.chosen as Array<{ task: string }>).map((c) => c.task), ['one', 'two']);

console.log('\n--- what it says it is ---');
const about = bundle.about as string;
check('it says how many', about.includes('3 chosen task(s)'), false);
check('it counts the chosen', about.includes('2 chosen task(s)'), true);
check('it names all three parts', ['`plan`', '`work`', '`runner`'].every((w) => about.includes(w)), true);

await rm(dir, { recursive: true, force: true });

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
