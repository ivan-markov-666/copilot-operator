/**
 * Where a session starts, against real repositories in a temp folder.
 *
 * Until `startFrom` existed a session started from wherever HEAD was at its first run, which after
 * a run of sessions is the branch the previous one left checked out — so whether sessions chained
 * or started clean depended on nothing anyone chose. The questions here are the two the option
 * answers, and the edges that make it trustworthy: a `branch` session starts from that branch even
 * with HEAD elsewhere; a `previous-session` one continues the latest work in the same repository,
 * and never a session's in another; with no earlier session it starts from the branch and says so;
 * a branch that does not exist is refused, not guessed; absent keeps the old behaviour; the plan
 * format carries it; and changing it clears the recorded start.
 *
 *   npm run check:startfrom
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionStore } from '../src/session/store.js';
import { EventBus } from '../src/session/events.js';
import { git, commitAll } from '../src/vcs/git.js';
import { prepareForTask, commitTaskResult } from '../src/vcs/taskVcs.js';
import { checkPlan } from '../src/plan/schema.js';
import { buildPlanExport } from '../src/session/exports.js';
import type { Session, Task, VersionControl } from '../src/session/model.js';

let wrong = 0;
const check = (what: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

const repo = await mkdtemp(join(tmpdir(), 'cop-start-repo-'));
const other = await mkdtemp(join(tmpdir(), 'cop-start-other-'));
const data = await mkdtemp(join(tmpdir(), 'cop-start-data-'));
for (const r of [repo, other]) {
  await git(r, ['init', '-b', 'main']);
  await writeFile(join(r, 'app.ts'), 'export const a = 1;\n');
  await commitAll(r, 'first commit');
}
const mainTip = (await git(repo, ['rev-parse', 'main'])).stdout.trim();

const store = new SessionStore(data, join(process.cwd(), 'prompts', 'level1.md'));
await store.init();
const bus = new EventBus();
const all = (): Promise<Session[]> => store.listSessions();
let clock = Date.parse('2026-09-29T10:00:00.000Z');

async function session(name: string, dir: string, vcs: Partial<VersionControl>): Promise<Session> {
  const s = await store.createSession(name);
  await store.updateSession(s.id, (x) => {
    x.vcs = { enabled: true, repoDir: dir, branchMode: 'per-session', commitOnFinish: true, branchPrefix: 'cop/', ...vcs };
  });
  await store.addTask(s.id, { title: `${name} task`, level2: '', prompt: 'p' });
  return (await store.getSession(s.id)) as Session;
}

/** Runs the session's one task: branch, write a file, commit. Returns what the task saw. */
async function run(s: Session, dir: string, file: string): Promise<{ note: string; files: string[]; problem?: string; branch?: string }> {
  const fresh = (await store.getSession(s.id)) as Session;
  const task = fresh.tasks[0] as Task;
  const prepared = await prepareForTask(fresh, task, bus, async (m) => void (await store.updateSession(s.id, m)), all);
  const files = (await git(dir, ['ls-tree', '--name-only', 'HEAD'])).stdout.split('\n').filter(Boolean);
  if (!prepared.vcs.branch) return { note: prepared.note, files, problem: prepared.vcs.problem };
  await store.updateTask(s.id, task.id, (t) => {
    t.vcs = prepared.vcs;
  });
  await writeFile(join(dir, file), `// ${file}\n`);
  const now = (await store.getSession(s.id)) as Session;
  const after = await commitTaskResult(now, now.tasks[0] as Task, { status: 'done', summary: file }, bus);
  clock += 60_000;
  await store.updateTask(s.id, task.id, (t) => {
    t.vcs = after;
    t.status = 'done';
    t.finishedAt = new Date(clock).toISOString();
  });
  return { note: prepared.note, files, branch: prepared.vcs.branch };
}

console.log('--- from a local branch ---');
const a = await session('alpha', repo, { startFrom: 'branch' });
const ra = await run(a, repo, 'alpha.ts');
check('alpha starts from main', (await store.getSession(a.id))?.vcsBaseCommit, mainTip);
check('and the record says so', (await store.getSession(a.id))?.vcsStart?.kind, 'branch');
check('the note tells the chat it starts clean', ra.note.includes('started from the local branch `main`'), true);

// HEAD is now on alpha's branch, which is exactly the case that used to decide by accident.
const b = await session('beta', repo, { startFrom: 'branch' });
const rb = await run(b, repo, 'beta.ts');
check('beta starts from main although HEAD was on alpha', (await store.getSession(b.id))?.vcsBaseCommit, mainTip);
check("so alpha's work is not in beta's tree", rb.files.includes('alpha.ts'), false);

console.log('\n--- from the previous session ---');
// The work of another repository, committed later than beta's, must not be what gamma continues.
const elsewhere = await session('elsewhere', other, { startFrom: 'branch' });
await run(elsewhere, other, 'elsewhere.ts');
const c = await session('gamma', repo, { startFrom: 'previous-session' });
const rc = await run(c, repo, 'gamma.ts');
const cs = (await store.getSession(c.id)) as Session;
check('gamma continues the latest session in this repository', cs.vcsStart?.fromSession?.name, 'beta');
check('from the end of its branch', cs.vcsStart?.branch, (await store.getSession(b.id))?.tasks[0]?.vcs?.branch);
check("so beta's work is in gamma's tree", rc.files.includes('beta.ts'), true);
check("and alpha's is not (beta never had it)", rc.files.includes('alpha.ts'), false);
check('the note tells the chat to build on it', rc.note.includes('continues the work of the earlier session "beta"'), true);
check('a session in another repository does not count', cs.vcsStart?.fromSession?.name === 'elsewhere', false);

const d = await session('delta', repo, { startFrom: 'previous-session' });
const rd = await run(d, repo, 'delta.ts');
check('the chain goes on: delta continues gamma', (await store.getSession(d.id))?.vcsStart?.fromSession?.name, 'gamma');
check('and has both earlier files', ['beta.ts', 'gamma.ts'].every((f) => rd.files.includes(f)), true);

console.log('\n--- the edges ---');
const fresh = await mkdtemp(join(tmpdir(), 'cop-start-fresh-'));
await git(fresh, ['init', '-b', 'main']);
await writeFile(join(fresh, 'x.ts'), 'x\n');
await commitAll(fresh, 'first');
const first = await session('first-of-chain', fresh, { startFrom: 'previous-session' });
await run(first, fresh, 'y.ts');
const fs = (await store.getSession(first.id)) as Session;
check('with no earlier session it starts from the branch', fs.vcsStart?.kind, 'branch');
check('and says why', /no earlier session/.test(fs.vcsStart?.note ?? ''), true);

const missing = await session('trunk-based', fresh, { startFrom: 'branch', baseBranch: 'trunk' });
const rm1 = await run(missing, fresh, 'z.ts');
check('a branch that does not exist is refused, not guessed', /no such branch/.test(rm1.problem ?? ''), true);
check('and nothing is recorded as its start', (await store.getSession(missing.id))?.vcsBaseCommit, undefined);

await git(fresh, ['checkout', '-b', 'somewhere-else']);
const headNow = (await git(fresh, ['rev-parse', 'HEAD'])).stdout.trim();
const legacy = await session('legacy', fresh, {});
await run(legacy, fresh, 'legacy.ts');
check('absent keeps the old behaviour: wherever HEAD was', (await store.getSession(legacy.id))?.vcsBaseCommit, headNow);

console.log('\n--- the plan format carries it ---');
const plan = (vcs: Record<string, unknown>): string =>
  JSON.stringify({
    version: 1,
    plan: 'p',
    sessions: [{ name: 'one', goal: 'g', level2: '', vcs: { enabled: true, repoDir: repo, ...vcs }, tasks: [{ title: 'task one', prompt: 'Do the first thing, properly and completely.', expected: 'done' }] }],
  });
const good = checkPlan(plan({ startFrom: 'previous-session', baseBranch: 'develop' }));
check('startFrom and baseBranch are accepted', good.ok, true);
check('without a warning', good.warnings.filter((w) => /startFrom|baseBranch/.test(w)), []);
check('a wrong value is refused', checkPlan(plan({ startFrom: 'main' })).ok, false);
const exported = buildPlanExport({ sessions: [(await store.getSession(c.id)) as Session], label: 'x' });
const exportedVcs = (exported.sessions as Array<{ vcs: Record<string, unknown> }>)[0]?.vcs ?? {};
check('the export writes the choice back out', exportedVcs.startFrom, 'previous-session');
const legacyExport = buildPlanExport({ sessions: [(await store.getSession(legacy.id)) as Session], label: 'x' });
check('and leaves it out where none was made', 'startFrom' in ((legacyExport.sessions as Array<{ vcs: Record<string, unknown> }>)[0]?.vcs ?? {}), false);

console.log('\n--- changing the choice clears the recorded start ---');
process.env.COP_DATA_DIR = data;
{
  const { OperatorService } = await import('../src/api/operator.service.js');
  const ops = new OperatorService();
  await ops.updateSession(c.id, { vcs: { startFrom: 'previous-session' } });
  check('the same choice keeps it', !!(await store.getSession(c.id))?.vcsBaseCommit, true);
  await ops.updateSession(c.id, { vcs: { startFrom: 'branch' } });
  const changed = (await store.getSession(c.id)) as Session;
  check('a new choice clears it', [changed.vcsBaseCommit, changed.vcsStart], [undefined, undefined]);
}

for (const dir of [repo, other, fresh, data]) await rm(dir, { recursive: true, force: true });
console.log(`\nwrong: ${wrong} (expect 0)`);
if (wrong > 0) process.exitCode = 1;
