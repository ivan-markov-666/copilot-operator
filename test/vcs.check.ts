/**
 * Version control, against a real repository in a temp folder.
 *
 * The questions this answers are the ones the feature was asked for: does a task get its own
 * branch, does the work land in a commit, does a second task start from the same place rather
 * than from the first task's changes, and does re-running a task go back to the code as it was
 * before that task began.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionStore } from '../src/session/store.js';
import { EventBus } from '../src/session/events.js';
import { git, repoState, commitAll, branchNameFrom } from '../src/vcs/git.js';
import { prepareForTask, commitTaskResult, commitMessage } from '../src/vcs/taskVcs.js';
import { looksGenerated, findSuspicious } from '../src/vcs/commitHygiene.js';
import { runCheck, COMMIT_CLEAN_CHECK } from '../src/exec/checks.js';
import type { Session, Task } from '../src/session/model.js';

const repo = await mkdtemp(join(tmpdir(), 'cop-vcs-repo-'));
const data = await mkdtemp(join(tmpdir(), 'cop-vcs-data-'));

// A repository with one commit, which is what any real project looks like.
await git(repo, ['init', '-b', 'main']);
await writeFile(join(repo, 'app.ts'), 'export const a = 1;\n');
await commitAll(repo, 'first commit');
const start = await repoState(repo);
console.log('--- the repository we start from ---');
console.log('branch :', start.branch, '| clean:', !start.dirty, '| head:', start.head?.slice(0, 8));

const store = new SessionStore(data, join(process.cwd(), 'prompts', 'level1.md'));
await store.init();
const bus = new EventBus();
const events: string[] = [];
bus.subscribe('*', (e) => events.push(`${e.type}: ${e.message ?? ''}`));

let session = await store.createSession('vcs probe');
await store.updateSession(session.id, (s) => {
  s.vcs = { enabled: true, repoDir: repo, branchMode: 'per-task', commitOnFinish: true, branchPrefix: 'cop/' };
});
const t1 = await store.addTask(session.id, { title: 'add a feature', level2: '', prompt: 'p' });
const t2 = await store.addTask(session.id, { title: 'add another', level2: '', prompt: 'p' });

const save = async (mutate: (s: Session) => void): Promise<void> => {
  await store.updateSession(session.id, mutate);
};
const reload = async (): Promise<Session> => (session = (await store.getSession(session.id)) as Session);

/** One task from start to finish: branch, change a file, commit. */
async function runFakeTask(task: Task, file: string, body: string): Promise<void> {
  await reload();
  const prepared = await prepareForTask(session, task, bus, save);
  await store.updateTask(session.id, task.id, (t) => {
    t.vcs = prepared.vcs;
  });
  await writeFile(join(repo, file), body);
  await reload();
  const fresh = session.tasks.find((x) => x.id === task.id) as Task;
  const after = await commitTaskResult(session, fresh, { status: 'done', summary: `wrote ${file}` }, bus);
  await store.updateTask(session.id, task.id, (t) => {
    t.vcs = after;
    t.status = 'done';
    t.summary = `wrote ${file}`;
  });
}

console.log('\n--- task 1 ---');
await runFakeTask(t1, 'feature-one.ts', 'export const one = 1;\n');
let s1 = (await store.getSession(session.id))?.tasks.find((x) => x.id === t1.id);
console.log('branch :', s1?.vcs?.branch);
console.log('from   :', s1?.vcs?.baseCommit?.slice(0, 8), '| committed:', s1?.vcs?.commit?.slice(0, 8));
console.log('commits:', s1?.vcs?.commits?.length);

console.log('\n--- task 2, per-task mode ---');
await runFakeTask(t2, 'feature-two.ts', 'export const two = 2;\n');
const s2 = (await store.getSession(session.id))?.tasks.find((x) => x.id === t2.id);
console.log('branch :', s2?.vcs?.branch);
console.log('from the same base as task 1:', s2?.vcs?.baseCommit === undefined ? 'n/a' : 'see below');

const filesOnTwo = await git(repo, ['ls-tree', '--name-only', 'HEAD']);
console.log('files on task 2 branch:', filesOnTwo.stdout.split('\n').join(', '));
console.log('task 1 file is NOT here:', !filesOnTwo.stdout.includes('feature-one.ts'), '(this is what "does not have the previous code" means)');

const branches = await git(repo, ['branch', '--format=%(refname:short)']);
console.log('branches now:', branches.stdout.split('\n').join(', '));

console.log('\n--- re-running task 1 goes back to where it started ---');
const before = (await store.getSession(session.id))?.tasks.find((x) => x.id === t1.id)?.vcs?.baseCommit;
await store.rerunTask(session.id, t1.id);
await reload();
const requeued = session.tasks.find((x) => x.id === t1.id) as Task;
const prepared = await prepareForTask(session, requeued, bus, save);
console.log('new branch  :', prepared.vcs.branch);
console.log('starts from :', prepared.vcs.baseCommit?.slice(0, 8), '| the first attempt started from:', before?.slice(0, 8));
console.log('same commit :', prepared.vcs.baseCommit === before);
const filesNow = await git(repo, ['ls-tree', '--name-only', 'HEAD']);
console.log('files in the tree:', filesNow.stdout.split('\n').join(', '), '(back to before task 1 ran)');
const oldBranchStillThere = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${s1?.vcs?.branch}`]);
console.log("the first attempt's branch still exists:", oldBranchStillThere.ok);

console.log('\n--- a dirty tree is left alone ---');
await writeFile(join(repo, 'someone-was-working.ts'), 'wip\n');
await reload();
const t3 = await store.addTask(session.id, { title: 'third', level2: '', prompt: 'p' });
await reload();
const refused = await prepareForTask(session, session.tasks.find((x) => x.id === t3.id) as Task, bus, save);
console.log('branch made :', refused.vcs.branch ?? '(none)');
console.log('reason      :', refused.vcs.problem?.slice(0, 80));

console.log('\n--- one branch for the whole session ---');
await git(repo, ['checkout', '--', '.']);
await rm(join(repo, 'someone-was-working.ts'), { force: true });
await store.updateSession(session.id, (s) => {
  s.vcs = { ...(s.vcs as NonNullable<Session['vcs']>), branchMode: 'per-session' };
});
const c1 = await store.addTask(session.id, { title: 'chained one', level2: '', prompt: 'p' });
const c2 = await store.addTask(session.id, { title: 'chained two', level2: '', prompt: 'p' });
await runFakeTask(c1, 'chain-one.ts', 'export const c1 = 1;\n');
await runFakeTask(c2, 'chain-two.ts', 'export const c2 = 2;\n');
const chained = (await store.getSession(session.id))?.tasks ?? [];
const b1 = chained.find((x) => x.id === c1.id)?.vcs?.branch;
const b2 = chained.find((x) => x.id === c2.id)?.vcs?.branch;
console.log('both on the same branch:', b1 === b2, '|', b1);
const chainFiles = await git(repo, ['ls-tree', '--name-only', 'HEAD']);
console.log('files there:', chainFiles.stdout.split('\n').join(', '), '(the second task built on the first)');

console.log('\n--- what Copilot is told ---');
console.log((prepared.note || '(nothing)').split('\n').slice(0, 6).join('\n'));

console.log('\n--- the commit message ---');
console.log(commitMessage({ title: 'add a feature', attempt: 2 } as Task, { status: 'done', summary: 'Added the thing.' }).split('\n').slice(0, 5).join('\n'));

console.log('\n--- branch names ---');
console.log(branchNameFrom(['My Session!', 'Задача с кирилица', 'a2']));
console.log(branchNameFrom(['..bad..', '  ']));

console.log('\n--- events ---');
console.log(events.filter((e) => e.startsWith('vcs')).slice(0, 8).join('\n'));

/*
 * What a commit should not carry.
 *
 * A plan wrote its .gitignore exactly as dictated and a later build still put
 * `tsconfig.tsbuildinfo` into the history, past a reviewer with the path in front of it and an
 * audit that looked only for the folders the plan had thought of. The runner now looks: the
 * pure rule first, then the check against a real working tree, then the mark on the record.
 */
console.log('\n--- what looks like tool output or secrets, and what does not ---');
for (const p of [
  'web/tsconfig.tsbuildinfo',
  'api/node_modules/',
  'api/node_modules/zod/index.js',
  'dist/',
  'web/.next/BUILD_ID',
  'npm-debug.log',
  '.env',
  '.env.local',
  '.env.example',
  'web/next-env.d.ts',
  'src/build.ts',
  'api/package-lock.json',
  'README.md',
]) {
  const hit = looksGenerated(p);
  console.log(`  ${p.padEnd(30)} ${hit ? `${hit.reason}  → reported as ${hit.key}` : '(work)'}`);
}
console.log('found out of a list       :', findSuspicious(['src/app.ts', 'dist/', '.env']).map((s) => s.path).join(', '), '(expect dist/, .env)');
console.log(
  'a folder is reported once :',
  findSuspicious(['api/node_modules/a.js', 'api/node_modules/b/c.js', 'api/src/ok.ts']).map((s) => s.path).join(', '),
  '(expect api/node_modules/)',
);

console.log('\n--- the check, against a real working tree ---');
// The machine's own global excludes must not decide this test: an operator who ignores
// node_modules everywhere would make the check look blind here when it is not.
await writeFile(join(data, 'no-excludes'), '');
await git(repo, ['config', 'core.excludesFile', join(data, 'no-excludes')]);
await mkdir(join(repo, 'web', 'node_modules', 'left'), { recursive: true });
await writeFile(join(repo, 'web', 'node_modules', 'left', 'index.js'), 'module.exports = 1;\n');
await writeFile(join(repo, 'web', 'tsconfig.tsbuildinfo'), '{}\n');
await writeFile(join(repo, '.env'), 'SECRET=1\n');
await writeFile(join(repo, 'honest.ts'), 'export const honest = true;\n');
const logs = join(data, 'check-logs');
await mkdir(logs, { recursive: true });
const dirtyTree = await runCheck(COMMIT_CLEAN_CHECK, 0, { cwd: repo, logDir: logs, repoDir: repo });
console.log('passed                    :', dirtyTree.passed, '(expect false)');
console.log('names the files           :', ['tsconfig.tsbuildinfo', 'node_modules', '.env'].every((s) => dirtyTree.detail.includes(s)) ? 'yes' : 'NO');
console.log('detail                    :', dirtyTree.detail.slice(0, 220));
console.log('leaves the work alone     :', !dirtyTree.detail.includes('honest.ts') ? 'yes' : 'NO');
console.log('no repository: passes     :', (await runCheck(COMMIT_CLEAN_CHECK, 0, { cwd: repo, logDir: logs })).passed, '(expect true — nothing will be committed)');
await rm(join(repo, 'web', 'node_modules'), { recursive: true, force: true });
await rm(join(repo, 'web', 'tsconfig.tsbuildinfo'), { force: true });
await rm(join(repo, '.env'), { force: true });
const cleanTree = await runCheck(COMMIT_CLEAN_CHECK, 0, { cwd: repo, logDir: logs, repoDir: repo });
console.log('after ignoring/removing   :', cleanTree.passed, '(expect true)');
await rm(join(repo, 'honest.ts'), { force: true });

console.log('\n--- left in place, it is committed and marked ---');
// The build state appears while the task runs — after its branch is cut, as it would for
// real — and is still there when the runner commits.
const marked = await store.addTask(session.id, { title: 'leaves build state behind', level2: '', prompt: 'p' });
await reload();
const markedPrep = await prepareForTask(session, session.tasks.find((x) => x.id === marked.id) as Task, bus, save);
await store.updateTask(session.id, marked.id, (t) => {
  t.vcs = markedPrep.vcs;
});
console.log('branch for it             :', markedPrep.vcs.branch ?? `(none: ${markedPrep.vcs.problem})`);
await writeFile(join(repo, 'honest-two.ts'), 'export const two = 2;\n');
await writeFile(join(repo, 'web', 'tsconfig.tsbuildinfo'), '{}\n');
await reload();
const markedAfter = await commitTaskResult(session, session.tasks.find((x) => x.id === marked.id) as Task, { status: 'done', summary: 'left build state behind' }, bus);
await store.updateTask(session.id, marked.id, (t) => {
  t.vcs = markedAfter;
});
const markedTask = (await store.getSession(session.id))?.tasks.find((x) => x.id === marked.id);
console.log('committed                 :', markedTask?.vcs?.commit ? 'yes' : 'NO');
console.log('marked as suspicious      :', (markedTask?.vcs?.suspicious ?? []).map((s) => `${s.path} (${s.reason})`).join('; ') || '(nothing)');
console.log('the honest file is not    :', !(markedTask?.vcs?.suspicious ?? []).some((s) => s.path.includes('honest')) ? 'yes' : 'NO');
console.log('event                     :', events.find((e) => e.startsWith('vcs-suspicious'))?.slice(0, 90) ?? '(none)');

await rm(repo, { recursive: true, force: true });
await rm(data, { recursive: true, force: true });
