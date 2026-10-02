/**
 * The operator's input files, artifacts, and a chain that must carry all of the previous session's
 * work — against real repositories in a temp folder.
 *
 * From a real run: YAML schemas put into the project by hand stayed untracked, were not carried
 * predictably between branches, and a session started from `main` began without them although they
 * were in other commits; evidence files had to go into .gitignore by hand; a session chained after a
 * per-task one started from the last task's branch only. The questions here are what each fix
 * promises:
 *
 *   inputs     listed with size and status and approved before the run; committed as "Capture
 *              user-provided inputs" (ignored ones too); their sums recorded; a later session whose
 *              start lacks them gets them committed on top of it, the operator's tree untouched; a
 *              pattern that matches nothing, a secrets file and other uncommitted changes refuse;
 *              read-only: a changed, deleted or added input is put back; an existing branch that
 *              lacks them is refused, not written to.
 *   artifacts  never committed, .gitignore untouched; copied into the run's record with sums;
 *              secrets never copied.
 *   chain      previous-session after a per-task session with several done tasks is refused, and
 *              the plan import warns; after a per-session one it continues.
 *   plan       the spelling from the request is accepted and stored in one spelling; what cannot
 *              be honoured is refused with a sentence; the export writes it back.
 *
 *   npm run check:inputs
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionStore } from '../src/session/store.js';
import { EventBus } from '../src/session/events.js';
import { git, commitAll } from '../src/vcs/git.js';
import { prepareForTask, commitTaskResult, vcsPreflight } from '../src/vcs/taskVcs.js';
import { takeSnapshot, type SnapshotChoice } from '../src/vcs/snapshot.js';
import { protectInputs } from '../src/vcs/inputs.js';
import { keepArtifacts } from '../src/vcs/artifacts.js';
import { checkPlan } from '../src/plan/schema.js';
import { importPlan } from '../src/plan/importPlan.js';
import { buildPlanExport, buildDomainExport } from '../src/session/exports.js';
import type { Session, Task, VersionControl } from '../src/session/model.js';

let wrong = 0;
const check = (what: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

const data = await mkdtemp(join(tmpdir(), 'cop-inputs-data-'));
const store = new SessionStore(data, join(process.cwd(), 'prompts', 'level1.md'));
await store.init();
const bus = new EventBus();
const all = (): Promise<Session[]> => store.listSessions();
const out = async (dir: string, args: string[]): Promise<string> => (await git(dir, args)).stdout.trim();
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
let clock = Date.parse('2026-10-02T10:00:00.000Z');

async function repo(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'cop-inputs-repo-'));
  await git(r, ['init', '-b', 'main']);
  // As on most Windows machines: checked-out files get CRLF while commits keep LF. The read-only
  // guard once compared bytes and called every untouched input changed under this setting.
  await git(r, ['config', 'core.autocrlf', 'true']);
  await writeFile(join(r, 'app.ts'), 'export const a = 1;\n');
  await writeFile(join(r, '.gitignore'), 'secret-data/\nevidence-old/\n');
  await commitAll(r, 'first commit');
  return r;
}

async function session(name: string, dir: string, vcs: Partial<VersionControl>, tasks = 1): Promise<Session> {
  const s = await store.createSession(name, dir);
  await store.updateSession(s.id, (x) => {
    x.vcs = { enabled: true, repoDir: dir, branchMode: 'per-task', commitOnFinish: true, branchPrefix: 'cop/', ...vcs };
  });
  for (let i = 1; i <= tasks; i += 1) await store.addTask(s.id, { title: `${name} task ${i}`, level2: '', prompt: 'p' });
  return (await store.getSession(s.id)) as Session;
}
const fresh = async (s: Session): Promise<Session> => (await store.getSession(s.id)) as Session;
const save = (s: Session) => async (m: (x: Session) => void): Promise<void> => void (await store.updateSession(s.id, m));
const prepare = async (s: Session, i = 0) => {
  const now = await fresh(s);
  return await prepareForTask(now, now.tasks[i] as Task, bus, save(s), all);
};
/** Runs task i: branch, write the file, commit, mark done. */
async function run(s: Session, dir: string, file: string, i = 0) {
  const prepared = await prepare(s, i);
  if (!prepared.vcs.branch) return prepared;
  const id = (await fresh(s)).tasks[i]!.id;
  await store.updateTask(s.id, id, (t) => void (t.vcs = prepared.vcs));
  await writeFile(join(dir, file), `// ${file}\n`);
  const now = await fresh(s);
  const after = await commitTaskResult(now, now.tasks[i] as Task, { status: 'done', summary: file }, bus);
  clock += 60_000;
  await store.updateTask(s.id, id, (t) => {
    t.vcs = after;
    t.status = 'done';
    t.finishedAt = new Date(clock).toISOString();
  });
  return prepared;
}
const approveAll = async (s: Session) => {
  const plan = (await vcsPreflight(await fresh(s), all)).snapshot!;
  const choices = Object.fromEntries(plan.entries.filter((e) => e.choice).map((e) => [e.path, e.choice as SnapshotChoice]));
  return { plan, taken: await takeSnapshot(await fresh(s), { approved: true, choices }, bus, save(s), all) };
};

console.log('--- input files: approved, captured, summed ---');
const r1 = await repo();
await mkdir(join(r1, 'schemas'), { recursive: true });
await writeFile(join(r1, 'schemas', 'a.yaml'), 'a: 1\n');
await writeFile(join(r1, 'schemas', 'b.yaml'), 'b: 2\n');
await mkdir(join(r1, 'secret-data'), { recursive: true });
await writeFile(join(r1, 'secret-data', 'ref.yaml'), 'ref: 1\n');
const a = await session('migrate', r1, { userInputs: { paths: ['schemas/*.yaml', 'secret-data/ref.yaml'] }, branchMode: 'per-session' });
const refused = await prepare(a);
check('a run before the inputs are approved is refused', /approved the list/.test(refused.refuse ?? ''), true);
check('and nothing changed', await out(r1, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
const { plan, taken } = await approveAll(a);
const entry = (p: string) => plan.entries.find((e) => e.path === p);
check('the list shows each input with its size', entry('schemas/a.yaml')?.size, 5);
check('and its git status: an ignored input is listed', entry('secret-data/ref.yaml')?.kind, 'ignored');
check('inputs are marked and can only be taken', [entry('schemas/a.yaml')?.input, entry('schemas/a.yaml')?.allowed], [true, ['include']]);
check('the approved inputs are taken', taken.ok, true);
const snap = (await fresh(a)).vcsBaseCommit!;
check('as "Capture user-provided inputs"', await out(r1, ['log', '-1', '--format=%s', snap]), 'Capture user-provided inputs');
check('the ignored input is committed too', (await out(r1, ['show', '--name-only', '--format=', snap])).split('\n').sort(), ['schemas/a.yaml', 'schemas/b.yaml', 'secret-data/ref.yaml']);

const ra = await run(a, r1, 'work-a.ts');
const sa = await fresh(a);
check('the first task records the sums', sa.vcsStart?.inputs?.files.map((f) => [f.path, f.sha256]), [
  ['schemas/a.yaml', sha('a: 1\n')],
  ['schemas/b.yaml', sha('b: 2\n')],
  ['secret-data/ref.yaml', sha('ref: 1\n')],
]);
check('read-only unless said otherwise', sa.vcsStart?.inputs?.readOnly, true);
check('the chat is told they are read-only inputs', /input files are in your working tree.*read-only/s.test(ra.note), true);
check("the task's commit does not hold the inputs", (sa.tasks[0]?.vcs?.files ?? []).map((f) => f.path), ['work-a.ts']);

console.log('\n--- read-only ---');
{
  const before = await out(r1, ['rev-parse', 'HEAD']);
  await writeFile(join(r1, 'schemas', 'a.yaml'), 'a: CHANGED\n');
  await rm(join(r1, 'schemas', 'b.yaml'));
  await writeFile(join(r1, 'schemas', 'c.yaml'), 'new\n');
  const c = await protectInputs(r1, before, sa.vcsStart!.inputs!);
  check('a changed, a deleted and an added input are all noticed', c.changed.sort(), ['schemas/a.yaml', 'schemas/b.yaml', 'schemas/c.yaml']);
  const text = async (p: string): Promise<string> => (await readFile(join(r1, p), 'utf8')).replace(/\r\n/g, '\n');
  check('and put back', [await text('schemas/a.yaml'), await text('schemas/b.yaml'), existsSync(join(r1, 'schemas', 'c.yaml'))], ['a: 1\n', 'b: 2\n', false]);
  check('with nothing that failed', c.failed, []);
  check('the tree is clean again', await out(r1, ['status', '--porcelain']), '');
  const quiet = await protectInputs(r1, before, sa.vcsStart!.inputs!);
  check('untouched inputs are left alone', quiet.changed, []);
}

console.log('\n--- a later session whose start lacks them ---');
{
  const b = await session('from-main', r1, { userInputs: { paths: ['schemas/*.yaml', 'secret-data/ref.yaml'] }, startFrom: 'branch', updateFromRemote: false });
  const mainBefore = await out(r1, ['rev-parse', 'main']);
  const rb = await run(b, r1, 'work-b.ts');
  const sb = await fresh(b);
  check('they are committed on top of main for it', sb.vcsStart?.inputs?.carried?.onto, mainBefore);
  check('on a branch of their own', sb.vcsStart?.inputs?.carried?.branch, `cop/input/${b.id}`);
  check('with the same sums', sb.vcsStart?.inputs?.files.map((f) => f.sha256), sa.vcsStart?.inputs?.files.map((f) => f.sha256));
  check('main is untouched', await out(r1, ['rev-parse', 'main']), mainBefore);
  check("its task's branch has them", (await out(r1, ['ls-tree', '-r', '--name-only', rb.vcs.branch!])).split('\n').filter((p) => p.endsWith('.yaml')).sort(), ['schemas/a.yaml', 'schemas/b.yaml', 'secret-data/ref.yaml']);
  check("and none of the first session's work", (await out(r1, ['ls-tree', '-r', '--name-only', rb.vcs.branch!])).includes('work-a.ts'), false);

  const c = await session('chain', r1, { userInputs: { paths: ['schemas/*.yaml'] }, startFrom: 'previous-session', branchMode: 'per-session' });
  await run(c, r1, 'work-c.ts');
  check('a chain whose start has them commits nothing more', (await fresh(c)).vcsStart?.inputs?.carried, undefined);

  const d = await session('wrong-pattern', r1, { userInputs: { paths: ['schemas/*.json'] }, startFrom: 'branch', updateFromRemote: false });
  const rd = await prepare(d);
  check('a pattern that matches nothing refuses', /match no file/.test(rd.refuse ?? ''), true);
}

console.log('\n--- what refuses ---');
{
  const r = await repo();
  await writeFile(join(r, 'input.yaml'), 'x\n');
  await writeFile(join(r, 'notes.md'), 'mine\n');
  const s = await session('others', r, { userInputs: { paths: ['input.yaml'] } });
  const p = await prepare(s);
  check('other uncommitted changes beside the inputs refuse', /besides the input files/.test(p.refuse ?? ''), true);

  const r2 = await repo();
  await writeFile(join(r2, '.env'), 'K=1\n');
  const s2 = await session('secret', r2, { userInputs: { paths: ['.env'] } });
  const p2 = await prepare(s2);
  check('a secrets file is never an input', /never taken as an input/.test(p2.refuse ?? ''), true);

  const r3 = await repo();
  await writeFile(join(r3, 'input.yaml'), 'x\n');
  const s3 = await session('auto', r3, { userInputs: { paths: ['input.yaml'], requireApproval: false } });
  const p3 = await prepare(s3);
  check('without approval the inputs are taken when the first task starts', [p3.refuse, (await fresh(s3)).vcsStart?.inputs?.files.length], [undefined, 1]);

  const r4 = await repo();
  await git(r4, ['branch', 'feature']);
  await writeFile(join(r4, 'input.yaml'), 'x\n');
  await commitAll(r4, 'inputs on main');
  const s4 = await session('existing', r4, { userInputs: { paths: ['input.yaml'] }, startFrom: 'existing-branch', existingBranch: 'feature', updateFromRemote: false });
  const p4 = await prepare(s4);
  check('an existing branch that lacks the inputs is refused, not written to', /does not commit onto a branch you named/.test(p4.refuse ?? ''), true);
  check('and the branch is as it was', (await out(r4, ['ls-tree', '--name-only', 'feature'])).includes('input.yaml'), false);
}

console.log('\n--- found in review: what a clean tree hides ---');
{
  // An ignored input does not make the tree dirty; it was skipped, and the run refused "matches no file".
  const r = await repo();
  await mkdir(join(r, 'secret-data'), { recursive: true });
  await writeFile(join(r, 'secret-data', 'only.yaml'), 'o\n');
  const s = await session('ignored-only', r, { userInputs: { paths: ['secret-data/only.yaml'] } });
  check('the tree is clean to git', await out(r, ['status', '--porcelain']), '');
  const pre = await vcsPreflight(await fresh(s), all);
  check('the page still lists the ignored input for approval', pre.snapshot?.entries.map((e) => [e.path, e.kind]), [['secret-data/only.yaml', 'ignored']]);
  const p = await prepare(s);
  check('and the run asks for that approval, not "matches no file"', /approved the list/.test(p.refuse ?? ''), true);

  // A snapshot approved on the page, then the operator moves the repository elsewhere before the run.
  const r2 = await repo();
  await writeFile(join(r2, 'in.yaml'), 'i\n');
  const s2 = await session('moved', r2, { userInputs: { paths: ['in.yaml'] } });
  check('approved on the page', (await approveAll(s2)).taken.ok, true);
  await git(r2, ['checkout', '-q', 'main']);
  const p2 = await prepare(s2);
  check('the inputs are found in the session\'s own start', [p2.refuse, (await fresh(s2)).vcsStart?.inputs?.files.map((f) => f.path)], [undefined, ['in.yaml']]);

  // Artifacts are not "uncommitted changes" on the page: the run keeps them out of git first.
  const r3 = await repo();
  await mkdir(join(r3, 'evidence'), { recursive: true });
  await writeFile(join(r3, 'evidence', 'old.zip'), 'PK');
  const s3 = await session('evidence-left', r3, { artifacts: { paths: ['evidence/**'] } });
  const pre3 = await vcsPreflight(await fresh(s3), all);
  check('the page says the repository is ready', [pre3.ok, pre3.problem], [true, undefined]);
}

console.log('\n--- artifacts ---');
{
  const r = await repo();
  const s = await session('evidence', r, { artifacts: { paths: ['evidence/**', 'results/'] }, branchMode: 'per-session' });
  const p = await prepare(s);
  check('the session runs', p.refuse, undefined);
  check('the patterns are in .git/info/exclude', ['/evidence/**', '/results/'].every((l) => readFileSyncLines(r).includes(l)), true);
  check('.gitignore is untouched', await readFile(join(r, '.gitignore'), 'utf8'), 'secret-data/\nevidence-old/\n');
  check('the chat is told where evidence goes', /Evidence goes under `evidence\/\*\*`/.test(p.note), true);
  await mkdir(join(r, 'evidence', 'zip'), { recursive: true });
  await writeFile(join(r, 'evidence', 'zip', 'pack.zip'), 'PK');
  await mkdir(join(r, 'results'), { recursive: true });
  await writeFile(join(r, 'results', 'report.txt'), 'all green\n');
  await writeFile(join(r, 'results', '.env'), 'K=1\n');
  await writeFile(join(r, 'work.ts'), 'w\n');
  const id = (await fresh(s)).tasks[0]!.id;
  await store.updateTask(s.id, id, (t) => void (t.vcs = p.vcs));
  const after = await commitTaskResult(await fresh(s), (await fresh(s)).tasks[0] as Task, { status: 'done', summary: 'x' }, bus);
  check('artifacts are not committed', (after.files ?? []).map((f) => f.path), ['work.ts']);
  const dest = await mkdtemp(join(tmpdir(), 'cop-inputs-kept-'));
  const kept = await keepArtifacts(r, ['evidence/**', 'results/'], dest);
  check('they are kept with the run', kept.kept.map((k) => k.path), ['evidence/zip/pack.zip', 'results/report.txt']);
  check('with their sums', kept.kept[1]?.sha256, sha('all green\n'));
  check('the copy is there', await readFile(join(dest, 'results', 'report.txt'), 'utf8'), 'all green\n');
  check('a secrets file is never kept', kept.skipped.some((x) => x.startsWith('results/.env')), true);
}

console.log('\n--- a chain after a per-task session ---');
{
  const r = await repo();
  const pt = await session('per-task', r, { startFrom: 'branch', updateFromRemote: false }, 2);
  await run(pt, r, 'one.ts', 0);
  await run(pt, r, 'two.ts', 1);
  const next = await session('next', r, { startFrom: 'previous-session', updateFromRemote: false });
  const pn = await prepare(next);
  check('it is refused: the done work is on two branches', /whose done work is not on one branch/.test(pn.vcs.problem ?? ''), true);
  check('and names the task whose work is missing', (pn.vcs.problem ?? '').includes('"per-task task 1"'), true);

  const ps = await session('per-session', r, { startFrom: 'branch', branchMode: 'per-session', updateFromRemote: false }, 2);
  await run(ps, r, 'three.ts', 0);
  await run(ps, r, 'four.ts', 1);
  const next2 = await session('next2', r, { startFrom: 'previous-session', updateFromRemote: false });
  const pn2 = await run(next2, r, 'five.ts');
  check('after a per-session one it continues', (await fresh(next2)).vcsStart?.fromSession?.name, 'per-session');
  const tree = (await out(r, ['ls-tree', '--name-only', pn2.vcs.branch!])).split('\n');
  check('with all of its work', ['three.ts', 'four.ts'].every((f) => tree.includes(f)), true);
}

console.log('\n--- the plan format ---');
{
  const r = await repo();
  const plan = (vcs: Record<string, unknown>, extra: Record<string, unknown>[] = []): string =>
    JSON.stringify({
      version: 1,
      plan: 'p',
      sessions: [
        { name: 'one', goal: 'g', level2: '', vcs: { enabled: true, repoDir: r, ...vcs }, tasks: [{ title: 'task one', prompt: 'Do the first thing, properly and completely.', expected: 'done' }, { title: 'task two', prompt: 'Do the second thing, properly and completely.', expected: 'done' }] },
        ...extra,
      ],
    });
  const spec = {
    userInputs: { enabled: true, paths: ['rules-engine/test-data/schemas/*.yaml'], capture: 'baseline-commit', allowUntracked: true, allowIgnored: true, readOnlyAfterCapture: true, requireApproval: true },
    artifacts: { paths: ['rules-engine/test-evidence/ambulance-pickup-zip/**', 'rules-engine/test-results/**'], allowIgnored: true, attachToRun: true, commit: false },
  };
  const ok = checkPlan(plan(spec));
  check('the blocks from the request are accepted as written', ok.ok, true);
  check('another capture is refused', checkPlan(plan({ userInputs: { paths: ['a.yaml'], capture: 'other' } })).ok, false);
  check('committing artifacts is refused', checkPlan(plan({ artifacts: { paths: ['e/**'], commit: true } })).ok, false);
  check('an input pattern that names everything is refused', checkPlan(plan({ userInputs: { paths: ['**'] } })).ok, false);
  const next = { name: 'two', goal: 'g', level2: '', vcs: { enabled: true, repoDir: r, startFrom: 'previous-session' }, tasks: [{ title: 'task three', prompt: 'Do the third thing, properly and completely.', expected: 'done' }] };
  const chained = checkPlan(plan({}, [next]));
  const imported = chained.ok ? await importPlan(store, chained.plan) : null;
  check('a chain after a per-task session with several tasks is warned about at import', (imported?.warnings ?? []).some((w) => w.includes('runs a branch per task')), true);
  const stored = ok.ok ? await importPlan(store, ok.plan) : null;
  const vcs = stored ? (await fresh({ id: stored.sessions[0]!.id } as Session)).vcs : undefined;
  check('stored in one spelling', [vcs?.userInputs, vcs?.artifacts], [{ paths: ['rules-engine/test-data/schemas/*.yaml'] }, { paths: ['rules-engine/test-evidence/ambulance-pickup-zip/**', 'rules-engine/test-results/**'] }]);
  const exported = buildPlanExport({ label: 'x', sessions: [await fresh({ id: stored!.sessions[0]!.id } as Session)] }) as { sessions: Array<{ vcs: Record<string, unknown> }> };
  check('the export writes both back', [exported.sessions[0]?.vcs.userInputs, exported.sessions[0]?.vcs.artifacts], [vcs?.userInputs, vcs?.artifacts]);
  const domain = (await buildDomainExport({ label: 'x', sessions: [await fresh(a)] }, data)) as { tasks: Array<{ session: { start?: { commit: string; inputs?: { files: unknown[] } } } }> };
  check('the work export records the baseline commit and the inputs with their sums', [domain.tasks[0]?.session.start?.commit, domain.tasks[0]?.session.start?.inputs?.files.length], [(await fresh(a)).vcsBaseCommit, 3]);
}

function readFileSyncLines(r: string): string[] {
  return readFileSync(join(r, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/);
}

console.log(`\n${wrong === 0 ? 'all good' : `${wrong} wrong`}`);
process.exit(wrong === 0 ? 0 : 1);
