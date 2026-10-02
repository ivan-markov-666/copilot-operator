/**
 * The starting snapshot of the operator's uncommitted changes, against real repositories in a temp folder.
 *
 * Until `dirtyWorktree` existed, a tree with uncommitted changes kept version control out of a
 * session altogether — input files a task needed, untracked, were enough. The questions here are
 * what the snapshot promises: absent refuses a dirty tree, nothing run; asked for approval, a run is refused
 * and nothing changes; the approved list becomes one commit on a branch of its own that the
 * session's branches are cut from, the operator's branch untouched; secrets and files outside the
 * project are never taken and are left out locally, so no task commits them; a tracked secret
 * refuses; a list that no longer matches the repository refuses; without approval it is taken
 * automatically, and refused when something would have to be left out; a start the snapshot cannot
 * honour refuses; an ignored file goes in only when a scope names it and it is ticked; the plan
 * format carries the field.
 *
 *   npm run check:snapshot
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionStore } from '../src/session/store.js';
import { EventBus } from '../src/session/events.js';
import { git, commitAll } from '../src/vcs/git.js';
import { prepareForTask, commitTaskResult, vcsPreflight } from '../src/vcs/taskVcs.js';
import { planSnapshot, takeSnapshot, type SnapshotChoice } from '../src/vcs/snapshot.js';
import { checkPlan } from '../src/plan/schema.js';
import { importPlan } from '../src/plan/importPlan.js';
import { buildPlanExport } from '../src/session/exports.js';
import type { Session, Task, VersionControl } from '../src/session/model.js';

let wrong = 0;
const check = (what: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

const data = await mkdtemp(join(tmpdir(), 'cop-snap-data-'));
const store = new SessionStore(data, join(process.cwd(), 'prompts', 'level1.md'));
await store.init();
const bus = new EventBus();
const all = (): Promise<Session[]> => store.listSessions();
const out = async (dir: string, args: string[]): Promise<string> => (await git(dir, args)).stdout.trim();

async function repo(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'cop-snap-repo-'));
  await git(r, ['init', '-b', 'main']);
  await writeFile(join(r, 'app.ts'), 'export const a = 1;\n');
  await writeFile(join(r, '.gitignore'), 'local/\n');
  await commitAll(r, 'first commit');
  return r;
}

async function session(name: string, dir: string, vcs: Partial<VersionControl>, scope?: string[]): Promise<Session> {
  const s = await store.createSession(name, dir);
  await store.updateSession(s.id, (x) => {
    x.vcs = { enabled: true, repoDir: dir, branchMode: 'per-task', commitOnFinish: true, branchPrefix: 'cop/', ...vcs };
  });
  await store.addTask(s.id, { title: `${name} task`, level2: '', prompt: 'p' });
  if (scope) await store.updateTask(s.id, (await store.getSession(s.id))!.tasks[0]!.id, (t) => void (t.scope = scope));
  return (await store.getSession(s.id)) as Session;
}

const fresh = async (s: Session): Promise<Session> => (await store.getSession(s.id)) as Session;
const save = (s: Session) => async (m: (x: Session) => void): Promise<void> => void (await store.updateSession(s.id, m));
const prepare = async (s: Session) => {
  const now = await fresh(s);
  return await prepareForTask(now, now.tasks[0] as Task, bus, save(s), all);
};
const defaults = (entries: Array<{ path: string; choice: SnapshotChoice | null }>): Record<string, SnapshotChoice> =>
  Object.fromEntries(entries.filter((e) => e.choice).map((e) => [e.path, e.choice as SnapshotChoice]));

console.log('--- absent: a dirty tree refuses the task ---');
{
  const r = await repo();
  await writeFile(join(r, 'input.yaml'), 'a: 1\n');
  const s = await session('legacy', r, {});
  const p = await prepare(s);
  // It used to run "on but inactive", commit nothing and end done with the work loose in the tree.
  check('a dirty tree refuses the task, naming the files', /uncommitted changes \(input\.yaml\)/.test(p.refuse ?? ''), true);
  check('and says nothing was run, and how to go on', /Nothing was run/.test(p.refuse ?? '') && /starting snapshot/.test(p.refuse ?? ''), true);
  check('no snapshot is offered', (await vcsPreflight(await fresh(s), all)).snapshot, undefined);
}

console.log('\n--- asked for approval ---');
const r1 = await repo();
await writeFile(join(r1, 'app.ts'), 'export const a = 2;\n');
await writeFile(join(r1, 'input.yaml'), 'a: 1\n');
await writeFile(join(r1, '.env'), 'SECRET=1\n');
await mkdir(join(r1, 'local'), { recursive: true });
await writeFile(join(r1, 'local', 'seed.yaml'), 'seed: 1\n');
await writeFile(join(r1, 'local', 'other.txt'), 'x\n');
const a = await session('migrate', r1, { dirtyWorktree: { policy: 'snapshot' } }, ['local/seed.yaml', 'src/']);
const refused = await prepare(a);
check('a run before approval is refused', /approved the list/.test(refused.refuse ?? ''), true);
check('and nothing changed: still on main', await out(r1, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
check('with the changes where they were', (await out(r1, ['status', '--porcelain'])).includes('input.yaml'), true);

const pre = await vcsPreflight(await fresh(a), all);
const plan = pre.snapshot!;
const entry = (p: string) => plan.entries.find((e) => e.path === p);
check('the page gets the list', plan.needed && plan.ok, true);
check('a tracked change is taken', entry('app.ts')?.choice, 'include');
check('a new file is taken', entry('input.yaml')?.choice, 'include');
check('a secrets file can only be left out', entry('.env')?.allowed, ['leave-out']);
check('an ignored file a scope names is offered, unticked', entry('local/seed.yaml')?.choice, 'leave-out');
check('an ignored file no scope names is not offered', entry('local/other.txt'), undefined);
check('the snapshot branch is named for the session', plan.baselineBranch, `cop/baseline/${a.id}`);

const stale = await takeSnapshot(await fresh(a), { approved: true, choices: { 'app.ts': 'include' } }, bus, save(a), all);
check('a list that does not match the repository is refused', !stale.ok && /changed since the list was shown/.test(stale.problem), true);
const bad = await takeSnapshot(await fresh(a), { approved: true, choices: { ...defaults(plan.entries), '.env': 'include' } }, bus, save(a), all);
check('a secrets file cannot be taken', !bad.ok && bad.problem.startsWith('.env'), true);
check('and nothing was written to the exclude file', (await readFile(join(r1, '.git', 'info', 'exclude'), 'utf8').catch(() => '')).includes('.env'), false);

const taken = await takeSnapshot(await fresh(a), { approved: true, choices: { ...defaults(plan.entries), 'local/seed.yaml': 'include' } }, bus, save(a), all);
check('the approved list is taken', taken.ok, true);
const sa = await fresh(a);
const snapCommit = sa.vcsBaseCommit!;
check('the session starts from the snapshot', sa.vcsStart?.kind, 'snapshot');
check('on its own branch', await out(r1, ['rev-parse', '--abbrev-ref', 'HEAD']), `cop/baseline/${a.id}`);
check('main is untouched', await out(r1, ['rev-parse', 'main']), sa.vcsStart?.snapshot?.fromCommit);
check('the commit says what it is', await out(r1, ['log', '-1', '--format=%s', snapCommit]), 'Capture operator baseline before run');
check('by the runner', await out(r1, ['log', '-1', '--format=%ae', snapCommit]), 'copilot-operator@localhost');
const files = (await out(r1, ['show', '--name-only', '--format=', snapCommit])).split('\n').sort();
check('with the taken files, the ticked ignored one too', files, ['app.ts', 'input.yaml', 'local/seed.yaml']);
check('the tree is clean afterwards', await out(r1, ['status', '--porcelain']), '');
check('.env is still there, untouched', existsSync(join(r1, '.env')), true);
check('and left out locally', (await readFile(join(r1, '.git', 'info', 'exclude'), 'utf8')).includes('/.env'), true);
check('.gitignore is not touched', await readFile(join(r1, '.gitignore'), 'utf8'), 'local/\n');

const ran = await prepare(a);
check('the first task now runs', ran.refuse, undefined);
check("its branch is cut from the snapshot", ran.vcs.baseCommit, snapCommit);
check('the chat is told where it starts', ran.note.includes("operator's own uncommitted changes"), true);
await store.updateTask(a.id, sa.tasks[0]!.id, (t) => void (t.vcs = ran.vcs));
await writeFile(join(r1, 'migrated.ts'), 'done\n');
const after = await commitTaskResult(await fresh(a), (await fresh(a)).tasks[0] as Task, { status: 'done', summary: 'migrated' }, bus);
check("the task's commit holds only the task's work", (after.files ?? []).map((f) => f.path), ['migrated.ts']);
const again = await takeSnapshot(await fresh(a), { approved: true, choices: {} }, bus, save(a), all);
check('a second snapshot after the start is refused', !again.ok && /already started/.test(again.problem), true);

console.log('\n--- without approval ---');
{
  const r = await repo();
  await writeFile(join(r, 'input.yaml'), 'a: 1\n');
  const s = await session('auto', r, { dirtyWorktree: { policy: 'snapshot', requireApproval: false }, branchMode: 'per-session' });
  const p = await prepare(s);
  check('the snapshot is taken when the first task starts', (await fresh(s)).vcsStart?.kind, 'snapshot');
  check('and the task runs on its branch from it', p.vcs.baseCommit, (await fresh(s)).vcsBaseCommit);
  check('the commit records that it was automatic', (await out(r, ['log', '-1', '--format=%B', (await fresh(s)).vcsBaseCommit!])).includes('automatically'), true);

  const r2 = await repo();
  await writeFile(join(r2, 'input.yaml'), 'a: 1\n');
  await writeFile(join(r2, '.env.local'), 'K=1\n');
  const s2 = await session('auto-secret', r2, { dirtyWorktree: { policy: 'snapshot', requireApproval: false } });
  const p2 = await prepare(s2);
  check('something to leave out refuses: that needs approval', /needs your approval/.test(p2.refuse ?? ''), true);
  check('and nothing changed', [await out(r2, ['rev-parse', '--abbrev-ref', 'HEAD']), existsSync(join(r2, '.git', 'info', 'exclude')) ? (await readFile(join(r2, '.git', 'info', 'exclude'), 'utf8')).includes('.env') : false], ['main', false]);
}

console.log('\n--- what refuses ---');
{
  const r = await repo();
  await writeFile(join(r, '.env'), 'A=1\n');
  await commitAll(r, 'tracked env');
  await writeFile(join(r, '.env'), 'A=2\n');
  const s = await session('tracked-secret', r, { dirtyWorktree: { policy: 'snapshot' } });
  const p = await planSnapshot(await fresh(s), all);
  check('a changed tracked secrets file refuses the snapshot', !p.ok && /neither taken nor left out/.test(p.problem ?? ''), true);

  const r3 = await repo();
  await git(r3, ['checkout', '-b', 'feature']);
  await writeFile(join(r3, 'input.yaml'), 'a\n');
  await commitAll(r3, 'feature work');
  await writeFile(join(r3, 'more.yaml'), 'b\n');
  const s3 = await session('from-main', r3, { dirtyWorktree: { policy: 'snapshot' }, startFrom: 'branch', updateFromRemote: false });
  const p3 = await planSnapshot(await fresh(s3), all);
  check('a session set to start from main, with the changes on another branch, refuses', !p3.ok && /would not start where it was told/.test(p3.problem ?? ''), true);
  await git(r3, ['checkout', 'main']);
  const p4 = await planSnapshot(await fresh(s3), all);
  check('on main itself it is fine', p4.ok, true);

  const r5 = await repo();
  await writeFile(join(r5, 'new.yaml'), 'n\n');
  await writeFile(join(r5, 'app.ts'), 'changed\n');
  const s5 = await session('tracked-only', r5, { dirtyWorktree: { policy: 'tracked-only-snapshot' } });
  const p5 = await planSnapshot(await fresh(s5), all);
  check('tracked-only: a new file can only be left out', p5.entries.find((e) => e.path === 'new.yaml')?.allowed, ['leave-out']);

  const r6 = await repo();
  await mkdir(join(r6, 'web'), { recursive: true });
  await writeFile(join(r6, 'web', 'page.ts'), 'p\n');
  await writeFile(join(r6, 'notes.md'), 'n\n');
  const s6 = await session('subfolder', r6, { dirtyWorktree: { policy: 'snapshot' } });
  await store.updateSession(s6.id, (x) => void (x.projectDir = join(r6, 'web')));
  const p6 = await planSnapshot(await fresh(s6), all);
  check('a new file outside the project folder can only be left out', p6.entries.find((e) => e.path === 'notes.md')?.allowed, ['leave-out']);
  check('one inside it is taken', p6.entries.find((e) => e.path === 'web/page.ts')?.choice, 'include');
}

console.log('\n--- the plan format carries it ---');
{
  const r = await repo();
  const plan = (vcs: Record<string, unknown>): string =>
    JSON.stringify({
      version: 1,
      plan: 'p',
      sessions: [{ name: 'one', goal: 'g', level2: '', vcs: { enabled: true, repoDir: r, ...vcs }, tasks: [{ title: 'task one', prompt: 'Do the first thing, properly and completely.', expected: 'done' }] }],
    });
  const okPlan = checkPlan(plan({ dirtyWorktree: { policy: 'snapshot', includeUntracked: true, includeIgnoredOnlyWhenScoped: true, requireApproval: true } }));
  check('the spelling from the request is accepted', okPlan.ok, true);
  check('discard is refused', checkPlan(plan({ dirtyWorktree: { policy: 'discard' } })).ok, false);
  check('ignored files without a scope are refused', checkPlan(plan({ dirtyWorktree: { policy: 'snapshot', includeIgnoredOnlyWhenScoped: false } })).ok, false);
  check('tracked-only with untracked files is refused', checkPlan(plan({ dirtyWorktree: { policy: 'tracked-only-snapshot', includeUntracked: true } })).ok, false);
  const checked = checkPlan(plan({ dirtyWorktree: { policy: 'snapshot', includeUntracked: false, requireApproval: false } }));
  const imported = checked.ok ? await importPlan(store, checked.plan) : null;
  const importedVcs = imported ? (await fresh({ id: imported.sessions[0]!.id } as Session)).vcs : undefined;
  check('the import stores it in the one spelling: includeUntracked false is tracked-only', importedVcs?.dirtyWorktree, { policy: 'tracked-only-snapshot', requireApproval: false });
  const s = await session('exported', r, { dirtyWorktree: { policy: 'snapshot', requireApproval: false } });
  const exported = buildPlanExport({ label: 'x', sessions: [await fresh(s)] } as never) as { sessions: Array<{ vcs: Record<string, unknown> }> };
  check('the export writes it back', exported.sessions[0]?.vcs.dirtyWorktree, { policy: 'snapshot', requireApproval: false });
}

console.log(`\n${wrong === 0 ? 'all good' : `${wrong} wrong`}`);
process.exit(wrong === 0 ? 0 : 1);
