/**
 * Starting a run again from the task that broke.
 *
 * The scenario is the one that prompted it: three sessions of three tasks are started
 * together, the second task of the first session fails, and everything after it — the rest of
 * that session, and the two sessions that were never reached at all — has to run again.
 *
 * That last part is what makes this worth a test rather than an eyeball. The tasks that never
 * ran carry no record of the run, and the sessions that were never reached carry nothing
 * either, so asking the tasks gives back only the half of the run that already happened. The
 * answer has to come from what the run recorded about itself when it started.
 *
 *   npm run check:restart
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import { OperatorService } from '../src/api/operator.service.js';
import type { Session, Task, TaskStatus } from '../src/session/model.js';

const data = await mkdtemp(join(tmpdir(), 'cop-restart-'));
process.env.COP_DATA_DIR = data;

const ops = new OperatorService();
const store: SessionStore = ops.store;
await store.init();

const REPO = 'C:\\Projects\\shared-repo';

/** Three sessions of three tasks, all pointed at one repository, as an import would make them. */
const made: Session[] = [];
for (const name of ['first', 'second', 'third']) {
  const s = await store.createSession(name, { enabled: false, rootDir: '' });
  for (const n of [1, 2, 3]) {
    await store.addTask(s.id, {
      title: `${name}-task-${n}`,
      level2: '',
      prompt: `A prompt for ${name} task ${n} that is comfortably long enough to be real.`,
    });
  }
  await store.updateSession(s.id, (x) => {
    x.vcs = { enabled: true, repoDir: REPO, branchMode: 'per-session', commitOnFinish: true, branchPrefix: 'cop/' };
  });
  made.push((await store.getSession(s.id)) as Session);
}

/** What the batch writes onto each session the moment it starts: what it was asked to do. */
const RUN = { id: 'b-test-run', startedAt: new Date().toISOString(), sessions: 3 };
for (const [order, s] of made.entries()) {
  await store.updateSession(s.id, (x) => {
    x.runGroup = { ...RUN, order, taskIds: x.tasks.map((t) => t.id), mode: 'unattended', onFailure: 'stop' };
  });
}

/** The first session gets as far as its second task and fails there; nothing else is reached. */
const outcomes: Array<[number, TaskStatus]> = [
  [0, 'done'],
  [1, 'failed'],
];
await store.updateSession(made[0].id, (x) => {
  for (const [i, status] of outcomes) {
    const t = x.tasks[i] as Task;
    t.status = status;
    t.runGroup = RUN;
    t.startedAt = new Date().toISOString();
    t.finishedAt = new Date().toISOString();
    t.vcs = { branch: 'cop/first', baseCommit: `base${i}` };
  }
});

const first = (await store.getSession(made[0].id)) as Session;
const failed = first.tasks[1];

console.log('--- the run, as it stands ---');
for (const s of await store.listSessions()) {
  console.log(`  ${s.name.padEnd(7)} ${s.tasks.map((t) => `${t.title}=${t.status}`).join(' ')}`);
}

console.log('\n--- what starting again from the failed task would do ---');
const plan = await ops.restartPlan(first.id, failed.id);
console.log('ok                :', plan.ok, '(expect true)');
console.log('from              :', `${plan.from.sessionName}/${plan.from.title}`, `(${plan.from.status})`);
console.log('run recognised    :', plan.runId === RUN.id, '(expect true)');
console.log('sessions          :', plan.sessions.map((s) => `${s.name}(${s.tasks})`).join(', '));
console.log('tasks, in order   :');
for (const t of plan.tasks) console.log(`   ${t.sessionName}/${t.title} — ${t.status}${t.alreadyQueued ? ' (already queued)' : ''}`);
console.log('count             :', plan.tasks.length, '(expect 8: the failed one, the one after it, and two whole sessions)');
console.log('leaves the done one:', !plan.tasks.some((t) => t.title === 'first-task-1'), '(expect true)');
console.log('starts at the fail :', plan.tasks[0]?.title === 'first-task-2', '(expect true)');
console.log('mode and onFailure :', plan.mode, '/', plan.onFailure, '(expect unattended / stop — how the run was started)');

console.log('\n--- one repository, taken back once ---');
console.log('restore entries   :', plan.restores.length, '(expect 1 — three sessions, one repository)');
console.log('for the task      :', plan.restores[0]?.forTask, '(expect first-task-2, the earliest affected)');
console.log('repo              :', plan.restores[0]?.repoDir);
console.log(
  'refuses honestly  :',
  plan.restores[0]?.ok === false && (plan.restores[0]?.problem ?? '').length > 0,
  '(expect true — that path is not a repository on this machine)',
);

console.log('\n--- starting from the last task only touches the tail ---');
const last = await ops.restartPlan(made[2].id, (made[2].tasks[2] as Task).id);
console.log('tasks             :', last.tasks.map((t) => `${t.sessionName}/${t.title}`).join(', '), '(expect third/third-task-3 alone)');
console.log('sessions          :', last.sessions.length, '(expect 1)');

console.log('\n--- a task added after the run still finds its own session ---');
const added = await store.addTask(made[1].id, {
  title: 'second-task-4',
  level2: '',
  prompt: 'A task added to the session after the run had already been started and recorded.',
});
const late = await ops.restartPlan(made[1].id, added.id);
console.log('ok                :', late.ok, '(expect true — it is not in the run, but it is in the session)');
console.log('scope             :', late.tasks.map((t) => `${t.sessionName}/${t.title}`).join(', '));
console.log('its session kept  :', late.sessions.some((s) => s.name === 'second'), '(expect true)');

console.log('\n--- a session that was never part of a run falls back to itself ---');
const lonely = await store.createSession('lonely', { enabled: false, rootDir: '' });
for (const n of [1, 2, 3]) {
  await store.addTask(lonely.id, { title: `lonely-${n}`, level2: '', prompt: `Prompt ${n} long enough to be a real instruction.` });
}
const lonelyFull = (await store.getSession(lonely.id)) as Session;
const lonelyPlan = await ops.restartPlan(lonely.id, (lonelyFull.tasks[1] as Task).id);
console.log('no run on record  :', lonelyPlan.runId === undefined, '(expect true)');
console.log('scope             :', lonelyPlan.tasks.map((t) => t.title).join(', '), '(expect lonely-2, lonely-3)');

/*
 * Doing it, without letting it start.
 *
 * `start: false` stops one step short of opening a browser, which is what makes this
 * checkable at all — and it is a real option for the same reason an import does not run what
 * it creates. `restore: false` because the repository in this fixture is a made-up path.
 */
console.log('\n--- doing it: the failed task goes back into the queue ---');
const done = await ops.restartFrom(first.id, failed.id, { restore: false, start: false });
console.log('requeued          :', done.requeued, '(expect 1 — the other seven were already waiting)');
console.log('did not start     :', done.started === false, '(expect true)');
const after = (await store.getSession(first.id)) as Session;
console.log('statuses now      :', after.tasks.map((t) => `${t.title}=${t.status}`).join(' '));
console.log(
  'the failure kept  :',
  (after.tasks[1].attempts ?? []).some((a) => a.status === 'failed'),
  '(expect true — the attempt that failed is archived, not erased)',
);
console.log('attempt number    :', after.tasks[1].attempt, '(expect 2)');
console.log('the done one left :', after.tasks[0].status, '(expect done — it is before the failure)');

await rm(data, { recursive: true, force: true });
