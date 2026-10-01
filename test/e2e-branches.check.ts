/**
 * The version-control flows the default mode relies on, end to end through the API with the scripted
 * chat of test/support/fakeChat.ts, against real throwaway git repositories — plus "Restore" and "Run
 * again from here", the two buttons that move a repository on the operator's behalf.
 *
 * Why this file exists: `e2e-vcs.check.ts` pins the per-session and existing-branch paths that broke on
 * 2026-09-30. The default a session is created with is per-task with a commit after every task, and
 * nothing end to end held that path, the dirty-tree fallback, the names a plan gives, the commit-hygiene
 * advice, or what Restore and "Run again from here" do to the repositories. Each of these is a promise the
 * operator reads on screen ("the old branch keeps everything", "nothing is lost", "the code goes back
 * first"), so each is checked against git itself rather than against the task record alone.
 *
 * - per-task: one branch per task from one commit, the second task told the first one's work is not in its tree;
 * - a continuation stays on the attempt's branch; a re-run gets `-a2` from the same base; a new prompt builds on it;
 * - a dirty tree switches version control off for that task and touches nothing;
 * - `commitOnFinish: false` commits nothing, and the next task then finds a dirty tree (a decision pin);
 * - a branch name git refuses, and the branch and commit subject a plan names;
 * - tool output left in the tree is pointed out once, then either ignored or committed and marked;
 * - a failed task's work is still committed;
 * - a session made the way the UI makes it (POST /sessions, PUT, POST tasks) branches and commits;
 * - Restore: preview, restore, a second restore, a dirty tree, a running session — and another session
 *   running alone in the same repository;
 * - Run again from here: across two repositories, only the run's own tasks, in per-session mode where the
 *   rerun's checkout once undid the restore, and with a later session of the same repository chained on
 *   the failed work;
 * - the update from the remote before a session's first branch: no remote, ahead, up to date.
 *
 * Every check here must pass.
 *
 *   npm run check:e2e-branches        (or: npx tsx test/e2e-branches.check.ts)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

/**
 * One scenario on a harness of its own: a fresh data folder, a fresh repository and a fresh chat, so a
 * scenario that leaves the repository somewhere odd cannot decide the next one. Every scenario ends with
 * the chat having been asked nothing it had no script for, and with every scripted reply used — a reply
 * left over means the runner stopped talking earlier than the scenario says it should.
 */
async function scenario(title: string, settings: Record<string, unknown>, body: (h: Harness) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings });
  try {
    await body(h);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
    t.check('every scripted reply was used', h.chat.pending, 0);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

// --- the shapes read off the API -------------------------------------------------------------------

type Vcs = {
  branch?: string;
  baseCommit?: string;
  commit?: string;
  problem?: string;
  suspicious?: Array<{ path: string; reason: string }>;
};
type TaskRec = {
  id: string;
  title: string;
  status: string;
  reason?: string;
  attempt?: number;
  startedAt?: string;
  vcs?: Vcs;
  attempts?: Array<{ status: string; vcs?: Vcs }>;
  checkResults?: Array<{ name: string; passed: boolean; detail: string }>;
  firstMessage?: string;
};
type Update = { outcome: string; from?: string; to?: string; remote?: string };
type SessionRec = { id: string; name: string; chat?: { chatId: string }; vcsStart?: { commit?: string; update?: Update }; tasks: TaskRec[] };
type Preview = { ok: boolean; problem?: string; baseCommit?: string; leftBehind: string[]; keptOn?: string; branchName?: string; currentBranch?: string };
type Restored = { ok: boolean; problem?: string; branch?: string; commit?: string };
type RestartPlan = {
  ok: boolean;
  problem?: string;
  tasks: Array<{ sessionId: string; taskId: string; alreadyQueued: boolean }>;
  restores: Array<{ repoDir: string; ok: boolean; problem?: string; baseCommit?: string }>;
};
type Restarted = { started: boolean; reason?: string; requeued: number; restored: string[] };
type Approval = { id: string; sessionId: string };

const read = async (h: Harness, id: string): Promise<SessionRec> => (await h.session(id)) as unknown as SessionRec;
const run = async (h: Harness, id: string): Promise<SessionRec> => (await h.run(id)) as unknown as SessionRec;

// --- plans, replies, git -----------------------------------------------------------------------------

/** A plan of one session, per-session on a branch named after it unless `vcs` says otherwise. */
function plan(h: Harness, name: string, tasks: unknown[], vcs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    sessions: [{
      name,
      onFailure: 'stop',
      vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: name, ...vcs },
      // The review is a second conversation; none of these scenarios is about it.
      review: { enabled: false },
      tasks,
      ...extra,
    }],
  };
}

const fileTask = (title: string, file: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  title,
  prompt: `Create ${file} in the repository root holding exactly the text ${text}, and nothing else.`,
  checks: [{ name: `${file} written`, expect: 'file-contains', file, value: text }],
  ...extra,
});

/**
 * A check nothing in these scripts ever satisfies, so the task fails at its rounds. It reads contents: a
 * plan whose only check is that a file exists is refused at import, as proving nothing.
 */
const neverPasses = { name: 'never.txt holds never', expect: 'file-contains', file: 'never.txt', value: 'never' };

const write = (file: string, text: string): string => reply.steps(`Set-Content -Path ${file} -Value '${text}' -Encoding utf8`);

/**
 * Two rounds that end a task `failed` with `limits.maxCheckRounds: 1`. The file written between the two
 * "done"s matters: a second "done" over an unchanged tree with the same checks failing is stopped by the
 * no-progress rule as `blocked`, which is right, and not what these scenarios are about.
 */
const failTwice = (first: string, second: string): string[] => [write(first, 'x'), reply.done(), write(second, 'y'), reply.done()];

/** The files in a commit or a branch, recursively. */
const tree = (h: Harness, ref: string): string[] => h.git('ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean);
const gitIn = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

// =====================================================================================================

/*
 * The default mode's whole promise: every task on its own branch, cut from the same commit, so a task
 * never sees what the task before it changed — and is told so, by name, because an audit that ran after a
 * README task once went looking for a README that was on another branch.
 */
await scenario('per-task mode: one branch per task, from one commit, and the second task is told what is not in its tree', {}, async (h) => {
  const main = h.git('rev-parse', 'main');
  const [s] = await h.importPlan(plan(h, 'pt', [fileTask('first', 'a.txt', 'a'), fileTask('second', 'b.txt', 'b')], { branchMode: 'per-task' }));
  let secondOpening = '';
  h.chat.script(
    write('a.txt', 'a'),
    reply.done(),
    (m) => {
      secondOpening = m.text;
      return write('b.txt', 'b');
    },
    reply.done(),
  );
  const [one, two] = (await run(h, s!.id)).tasks;
  t.check('both tasks done', [one!.status, two!.status], ['done', 'done']);
  t.check('each on a branch of its own, named after the session and the task', [one!.vcs?.branch, two!.vcs?.branch], ['cop/pt-first', 'cop/pt-second']);
  t.check('both cut from the same commit: main as it was', [one!.vcs?.baseCommit, two!.vcs?.baseCommit], [main, main]);
  t.check('the second task\'s branch does not carry the first task\'s file', tree(h, 'cop/pt-second').includes('a.txt'), false);
  t.check('and does carry its own', tree(h, 'cop/pt-second').includes('b.txt'), true);
  t.truthy('the second opening names where the first task\'s work is, and that it is NOT in the tree',
    secondOpening.includes('"first" is on `cop/') && secondOpening.includes('NOT in your working tree'), secondOpening.slice(0, 1200));
});

/*
 * "Continue" after a limit carries on the same work: in per-task mode that is the attempt's own branch,
 * not a new `-a2` cut from the base, which would silently drop what the first attempt did.
 */
await scenario('per-task continuation stays on the attempt\'s branch, in the same chat', { limits: { maxIterations: 5 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'cont', [{ title: 'long-job', prompt: 'Write partial.txt in the repository root, one part per round, until the whole text is there.' }], { branchMode: 'per-task' }));
  // Six replies for a limit of five (as in e2e-continue): the answer to the fifth report is read before
  // the count is looked at. Each round writes something different, so neither the repeat guard nor the
  // no-progress guard ends the task first.
  for (let i = 1; i <= 6; i++) h.chat.script(reply.steps(`Set-Content -Path partial.txt -Value 'part ${i}' -Encoding utf8`));
  const stopped = (await run(h, s!.id)).tasks[0]!;
  t.check('attempt 1 stopped at the limit, its work committed', [stopped.status, !!stopped.vcs?.commit], ['limit-reached', true]);
  t.check('partial.txt is on that attempt\'s branch', stopped.vcs?.branch ? h.git('show', `${stopped.vcs.branch}:partial.txt`) : null, 'part 5');
  const firstChat = (await read(h, s!.id)).chat?.chatId;

  await h.call('POST', `/sessions/${s!.id}/tasks/${stopped.id}/continue`);
  let continuedIn: string | undefined;
  h.chat.script((m) => {
    continuedIn = m.chatId;
    return reply.done();
  });
  const after = (await run(h, s!.id)).tasks[0]!;
  t.check('the continuation is done', after.status, 'done');
  // Against the branch read before "Continue" (checked above to hold partial.txt), not against another
  // field of the same record, which would agree with it with both missing.
  t.check('on the branch attempt 1 used', after.vcs?.branch, stopped.vcs?.branch);
  t.truthy('with attempt 1\'s partial.txt in its tree', after.vcs?.branch && tree(h, after.vcs.branch).includes('partial.txt'), after.vcs);
  t.check('no -a2 branch was cut', h.git('branch', '--list', '*-a2'), '');
  t.check('the continuation went into the first chat', continuedIn, firstChat);
});

/*
 * A re-run and a new prompt that builds on the work are two different things in per-task mode: the
 * re-run starts again from where the task first started (a fresh `-a2`, the first attempt's branch kept
 * as it was), the build-on carries on that attempt's branch with its files in the tree.
 */
await scenario('per-task rerun starts from the same base on -a2; a new prompt that builds on the work carries on its branch', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'again', [fileTask('alpha', 'alpha.txt', 'alpha'), fileTask('beta', 'beta.txt', 'beta')], { branchMode: 'per-task' }, { onFailure: 'continue' }));
  h.chat.script(write('alpha.txt', 'alpha'), reply.done(), write('beta.txt', 'beta'), reply.done());
  const [alpha1, beta1] = (await run(h, s!.id)).tasks;
  t.check('both first attempts done', [alpha1!.status, beta1!.status], ['done', 'done']);

  await h.call('POST', `/sessions/${s!.id}/tasks/${alpha1!.id}/rerun`, {});
  h.chat.script(write('alpha.txt', 'alpha'), reply.done());
  const alpha2 = (await run(h, s!.id)).tasks[0]!;
  t.check('the re-run is done', alpha2.status, 'done');
  t.truthy('on a new branch ending -a2', alpha2.vcs?.branch?.endsWith('-a2') && alpha2.vcs.branch !== alpha1!.vcs?.branch, alpha2.vcs);
  t.check('cut from the commit the first attempt started from', alpha2.vcs?.baseCommit, alpha1!.vcs?.baseCommit);
  t.check('the first attempt\'s branch is untouched and still holds its file',
    [h.git('rev-parse', alpha1!.vcs!.branch!), h.git('show', `${alpha1!.vcs!.branch!}:alpha.txt`)], [alpha1!.vcs?.commit, 'alpha']);

  const newPrompt = 'Also create beta2.txt in the repository root holding exactly beta2, and keep beta.txt as it is.';
  await h.call('POST', `/sessions/${s!.id}/tasks/${beta1!.id}/rerun`, {
    prompt: newPrompt,
    checks: [{ name: 'beta2.txt written', expect: 'file-contains', file: 'beta2.txt', value: 'beta2' }],
    buildOnFinished: true,
  });
  let betaInTree: boolean | undefined;
  h.chat.script(
    () => {
      betaInTree = existsSync(join(h.repo, 'beta.txt'));
      return write('beta2.txt', 'beta2');
    },
    reply.done(),
  );
  const beta2 = (await run(h, s!.id)).tasks[1]!;
  t.check('the build-on attempt is done', beta2.status, 'done');
  t.check('when it began, the first attempt\'s beta.txt was already in the working tree', betaInTree, true);
  t.check('it carried on the first attempt\'s branch', beta2.vcs?.branch, beta1!.vcs?.branch);
  t.check('its commit sits on top of the first attempt\'s', beta2.vcs?.commit ? h.git('rev-parse', `${beta2.vcs.commit}^`) : null, beta1!.vcs?.commit);
  t.truthy('and its tree holds both files', beta2.vcs?.commit && ['beta.txt', 'beta2.txt'].every((f) => tree(h, beta2.vcs!.commit!).includes(f)), beta2.vcs);
});

/*
 * A dirty tree is the operator's own work in progress: committing it under the bot's name or carrying it
 * to another branch would both be decisions that are not the runner's. So version control is off for that
 * task — said on the task — and the repository is left exactly as it was, uncommitted changes included.
 */
await scenario('a dirty tree turns version control off for that task and touches nothing', {}, async (h) => {
  writeFileSync(join(h.repo, 'README.md'), '# fixture\nan edit the operator has not committed\n');
  writeFileSync(join(h.repo, 'wip.txt'), 'work in progress\n');
  const mainBefore = h.git('rev-parse', 'main');
  const [s] = await h.importPlan(plan(h, 'dirty', [fileTask('write-a', 'a.txt', 'a')]));
  let opening = '';
  h.chat.script((m) => {
    opening = m.text;
    return write('a.txt', 'a');
  }, reply.done());
  const task = (await run(h, s!.id)).tasks[0]!;
  t.check('the task still ran', task.status, 'done');
  t.truthy('the task says why version control was off, naming the files', /uncommitted changes \(README\.md, wip\.txt\)/.test(task.vcs?.problem ?? ''), task.vcs);
  t.check('the repository is still on main', h.git('branch', '--show-current'), 'main');
  t.check('no cop/ branch was made', h.git('for-each-ref', '--format=%(refname:short)', 'refs/heads/cop/'), '');
  t.check('main has no new commit', h.git('rev-parse', 'main'), mainBefore);
  const status = h.git('status', '--porcelain');
  t.truthy('README.md and wip.txt are still uncommitted, as the operator left them', /^\s?M README\.md$/m.test(status) && /^\?\? wip\.txt$/m.test(status), status);
  t.check('the chat was not told about version control', opening.includes('## Version control'), false);
});

/*
 * DECISION PIN. `commitOnFinish: false` means the runner branches and never commits: "Off means the changes
 * are left in the tree" (session/model.ts, and the setting's own hint says the same). A dirty tree is the
 * operator's own work in progress, which prepareForTask refuses to commit or carry on purpose — so the next
 * task finds task 1's files and runs with version control off. Both halves are deliberate; this pins what
 * they add up to, and is the scenario to change if the owner ever wants later tasks to carry on regardless.
 */
await scenario('commitOnFinish false: branched, nothing committed, and the next task finds a dirty tree (decision pin)', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'nocommit', [fileTask('one', 'one.txt', 'one'), fileTask('two', 'two.txt', 'two')], { commitOnFinish: false }));
  h.chat.script(write('one.txt', 'one'), reply.done(), write('two.txt', 'two'), reply.done());
  const [one, two] = (await run(h, s!.id)).tasks;
  t.check('task 1 done, on the session branch, with no commit', [one!.status, one!.vcs?.branch, one!.vcs?.commit ?? null], ['done', 'cop/nocommit', null]);
  t.check('the branch has nothing main has not', h.git('rev-list', '--count', 'main..cop/nocommit'), '0');
  t.truthy('task 1\'s file is left uncommitted in the tree', /^\?\? one\.txt$/m.test(h.git('status', '--porcelain')), h.git('status', '--porcelain'));
  t.truthy('task 2 ran with version control off, because of task 1\'s file', two!.status === 'done' && /uncommitted changes/.test(two!.vcs?.problem ?? ''), two);
});

/*
 * A plan can name a branch git will not have. The runner asks git (`check-ref-format`) rather than guess,
 * says so on the task, and makes nothing: no half-made ref, no commit anywhere.
 */
await scenario('a branch name git refuses: said on the task, nothing made', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'badname', [fileTask('write-a', 'a.txt', 'a')], { branchName: 'feature/work.lock' }));
  h.chat.script(write('a.txt', 'a'), reply.done());
  const task = (await run(h, s!.id)).tasks[0]!;
  t.truthy('the task says the name is not one git accepts', /is not a name git accepts/.test(task.vcs?.problem ?? ''), task.vcs);
  t.check('the only local branch is main', h.git('for-each-ref', '--format=%(refname:short)', 'refs/heads'), 'main');
  t.check('the task\'s file is left uncommitted', h.git('status', '--porcelain'), '?? a.txt');
});

/*
 * The names a plan gives are what the team reads in `git log` and `git branch`: a plain name gets the
 * prefix, a name with its own namespace is kept as written (spaces made safe), and the planned commit
 * message is the commit's subject rather than the task's title.
 */
await scenario('the branch and the commit subject a plan names', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'named', [
    fileTask('csv-writer', 'csv.txt', 'csv', { vcs: { branch: 'invoice-csv', commitMessage: 'Add the CSV writer' } }),
    fileTask('two-words', 'two.txt', 'two', { vcs: { branch: 'feature/Two Words' } }),
  ], { branchMode: 'per-task' }, { onFailure: 'continue' }));
  h.chat.script(write('csv.txt', 'csv'), reply.done(), write('two.txt', 'two'), reply.done());
  const [csv, two] = (await run(h, s!.id)).tasks;
  t.check('both done', [csv!.status, two!.status], ['done', 'done']);
  t.check('a plain name gets the prefix', csv!.vcs?.branch, 'cop/invoice-csv');
  t.check('the commit\'s subject is the planned message', h.git('log', '-1', '--format=%s', 'cop/invoice-csv'), 'Add the CSV writer');
  t.check('a namespaced name is kept, its space made safe', two!.vcs?.branch, 'feature/Two-Words');
  t.check('and that branch exists under exactly that name', h.git('rev-parse', 'feature/Two-Words'), two!.vcs?.commit);
});

/*
 * What a commit should not carry — installed dependencies, secrets, build state — is pointed out to the
 * chat once, before the commit, with the instruction to ignore it. Ignored, the commit is clean. Left, the
 * second "done" commits it anyway (refusing would leave the tree dirty and the next task unable to start)
 * and the task keeps the finding where a person will see it.
 */
await scenario('tool output left in the tree: pointed out once, then ignored — or committed and marked', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'hygiene', [{ title: 'install-and-configure', prompt: 'Install the dependency into node_modules and write the local settings to .env in the repository root.' }]));
  let pointedOut = '';
  h.chat.script(
    reply.steps(
      "New-Item -ItemType Directory -Force -Path node_modules/x | Out-Null; Set-Content -Path node_modules/x/index.js -Value 'module.exports = 1;' -Encoding utf8",
      "Set-Content -Path .env -Value 'LOG_LEVEL=debug' -Encoding utf8",
    ),
    reply.done(),
    (m) => {
      pointedOut = m.text;
      return reply.steps("Set-Content -Path .gitignore -Value 'node_modules/','.env' -Encoding utf8");
    },
    reply.done(),
  );
  const task = (await run(h, s!.id)).tasks[0]!;
  t.truthy('the message after "done" names both paths and says to ignore them',
    pointedOut.includes('node_modules/') && pointedOut.includes('.env') && /Add them to \.gitignore/.test(pointedOut), pointedOut.slice(0, 1200));
  t.check('done', task.status, 'done');
  const files = tree(h, 'cop/hygiene');
  t.truthy('the commit has the .gitignore and neither node_modules nor .env',
    files.includes('.gitignore') && !files.some((f) => f.startsWith('node_modules/')) && !files.includes('.env'), files);
  t.check('nothing is marked suspicious', task.vcs?.suspicious ?? null, null);

  // The variant: the build state is left where it is, and "done" is said twice.
  const [v] = await h.importPlan(plan(h, 'buildstate', [{ title: 'build-web', prompt: 'Build the web folder with incremental TypeScript and leave the project building.' }]));
  h.chat.script(
    reply.steps("New-Item -ItemType Directory -Force -Path web | Out-Null; Set-Content -Path web/tsconfig.tsbuildinfo -Value 'incremental' -Encoding utf8"),
    reply.done(),
    reply.done(),
  );
  const left = (await run(h, v!.id)).tasks[0]!;
  t.check('done, and committed', [left.status, !!left.vcs?.commit], ['done', true]);
  t.truthy('the build state is in the commit', left.vcs?.commit && tree(h, left.vcs.commit).includes('web/tsconfig.tsbuildinfo'), left.vcs);
  const marked = left.vcs?.suspicious ?? [];
  t.truthy('and marked on the task, with why', marked.length === 1 && marked[0]!.path === 'web/tsconfig.tsbuildinfo' && /incremental build state/.test(marked[0]!.reason), marked);
  const clean = left.checkResults?.find((c) => c.name === 'nothing installed, built, logged or secret is committed');
  t.truthy('the runner\'s check says it was let through after one mention', /still there after being pointed out once/.test(clean?.detail ?? ''), left.checkResults);
});

/*
 * "A failed task that left changes behind is exactly the case where having them on a branch is worth the
 * most" (commitTaskResult). The commit says how the task ended, and the tree is clean for the next one.
 */
await scenario('a failed task is still committed, and the commit says it failed', { limits: { maxCheckRounds: 1 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'failing', [{ title: 'never-good', prompt: 'Create never.txt in the repository root, whatever it takes, and nothing else.', checks: [neverPasses] }]));
  h.chat.script(...failTwice('a.txt', 'b.txt'));
  const task = (await run(h, s!.id)).tasks[0]!;
  t.check('failed, with its work committed', [task.status, !!task.vcs?.commit], ['failed', true]);
  t.truthy('the commit message says it ended failed', task.vcs?.commit && /Ended failed/.test(h.git('show', '-s', '--format=%B', task.vcs.commit)), task.vcs?.commit ? h.git('show', '-s', '--format=%B', task.vcs.commit) : task.vcs);
  t.check('the tree is clean for the next task', h.git('status', '--porcelain'), '');
});

/*
 * Most sessions are not imported: they are made on the Sessions page. That path fills the project folder
 * and the repository from Settings, and the default vcs it gets must branch and commit like an imported one.
 */
await scenario('a session made the way the UI makes it', {}, async (h) => {
  const made = await h.call<{ id: string; projectDir?: string; vcs?: { repoDir?: string } }>('POST', '/sessions', { name: 'ui' });
  t.check('its project folder and its repository come from Settings', [made.projectDir, made.vcs?.repoDir], [h.repo, h.repo]);
  await h.call('PUT', `/sessions/${made.id}`, { vcs: { enabled: true }, review: { enabled: false } });
  await h.call('POST', `/sessions/${made.id}/tasks`, { title: 't', prompt: 'Create ui.txt in the repository root holding exactly the text ui, and nothing else.' });

  type Status = { ok: boolean; branch?: string; git?: string | null; problem?: string };
  const before = await h.call<Status>('GET', `/sessions/${made.id}/vcs`);
  t.truthy('before the run: ready, on main, git found', before.ok && before.branch === 'main' && /git version/.test(before.git ?? ''), before);

  h.chat.script(write('ui.txt', 'ui'), reply.done());
  const task = (await run(h, made.id)).tasks[0]!;
  t.check('done', task.status, 'done');
  t.truthy('on a branch named after the session', task.vcs?.branch?.startsWith('cop/ui-'), task.vcs);
  t.check('and the file is committed there', task.vcs?.branch ? h.git('show', `${task.vcs.branch}:ui.txt`) : null, 'ui');

  writeFileSync(join(h.repo, 'x.txt'), 'untracked\n');
  const dirty = await h.call<Status>('GET', `/sessions/${made.id}/vcs`);
  t.truthy('an untracked file makes it not ready, and names the file', !dirty.ok && /uncommitted changes \(x\.txt\)/.test(dirty.problem ?? ''), dirty);
});

/*
 * Restore moves the operator's repository, so it is checked against git: HEAD at the task's starting
 * commit on a new branch, the session's branch untouched, a second restore a second branch, and a refusal
 * whenever something else could be working in that repository at the time.
 */
await scenario('Restore: preview, restore, again, dirty, running — and another session running alone', {}, async (h) => {
  // A session name has at least two letters; the branch is the plan's own `x`, so cop/x.
  const [s] = await h.importPlan(plan(h, 'restore', [fileTask('first', 'one.txt', 'one'), fileTask('second', 'two.txt', 'two')], { branchName: 'x' }));
  h.chat.script(write('one.txt', 'one'), reply.done(), write('two.txt', 'two'), reply.done());
  const [t1, t2] = (await run(h, s!.id)).tasks;
  t.check('both done', [t1!.status, t2!.status], ['done', 'done']);
  const tip = h.git('rev-parse', 'cop/x');
  const path = `/sessions/${s!.id}/tasks/${t1!.id}/restore`;

  const preview = await h.call<Preview>('GET', path);
  t.check('the preview: ready, back to where the first task began, two commits stay on cop/x',
    [preview.ok, preview.baseCommit, preview.leftBehind.length, preview.keptOn], [true, t1!.vcs?.baseCommit, 2, 'cop/x']);
  t.truthy('on a new branch named for the restore', preview.branchName?.startsWith('cop/restore-'), preview);

  const done = await h.call<Restored>('POST', path);
  t.check('restored: HEAD is the first task\'s starting commit', [done.ok, h.git('rev-parse', 'HEAD')], [true, t1!.vcs?.baseCommit]);
  t.check('on the branch it named', h.git('branch', '--show-current'), done.branch);
  t.check('cop/x is exactly where it was', h.git('rev-parse', 'cop/x'), tip);
  t.check('the tree is clean', h.git('status', '--porcelain'), '');

  const again = await h.call<Restored>('POST', path);
  t.check('a second restore gets a second branch, -2', [again.ok, again.branch], [true, `${done.branch}-2`]);

  writeFileSync(join(h.repo, 'stray.txt'), 'the operator\'s own file\n');
  const dirty = await h.call<Preview>('GET', path);
  t.truthy('with uncommitted changes the preview refuses, saying so', !dirty.ok && /uncommitted changes/.test(dirty.problem ?? ''), dirty);
  rmSync(join(h.repo, 'stray.txt'));

  // A run of this same session in confirm mode, held on the approval of its first step.
  await h.call('POST', `/sessions/${s!.id}/tasks`, { title: 'third', prompt: 'Create three.txt in the repository root holding exactly the text three, and nothing else.' });
  h.chat.script(write('three.txt', 'three'), reply.done());
  const started = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' });
  t.check('the confirm run started', started.started, true);
  const approval = await waitFor('the step to wait for approval', async () => (await h.call<Approval[]>('GET', `/approvals?session=${s!.id}`))[0]);
  const whileMine = await h.call<Restored>('POST', path);
  t.truthy('while this session runs, restore is refused, saying it is running', !whileMine.ok && /running/.test(whileMine.problem ?? ''), whileMine);
  await h.call('POST', `/approvals/${approval.id}`, { action: 'run' });
  await h.idle();
  t.check('the held task finished once approved', (await read(h, s!.id)).tasks[2]!.status, 'done');

  // Another session, in the same repository, running alone, its reply held by the chat.
  const [other] = await h.importPlan(plan(h, 'other-runner', [{ title: 'look-around', prompt: 'Look at the repository and report in the summary what is in it; change nothing at all.' }]));
  let release: ((text: string) => void) | undefined;
  h.chat.script(() => new Promise<string>((resolve) => {
    release = resolve;
  }));
  await h.call('POST', `/sessions/${other!.id}/start`, { mode: 'unattended' });
  let whileOther: { status: number; body: unknown } | undefined;
  let previewWhileOther: Preview | undefined;
  let restartWhileOther: RestartPlan | undefined;
  let headBefore = '';
  let headAfter = '';
  try {
    await waitFor('the other session\'s reply to be held', async () => !!release);
    headBefore = h.git('rev-parse', 'HEAD');
    // The two previews ask the same question first, so a dialog refuses before the operator agrees.
    previewWhileOther = await h.call<Preview>('GET', path);
    restartWhileOther = await h.call<RestartPlan>('GET', `/sessions/${s!.id}/tasks/${t1!.id}/restart`);
    // `raw`, not `call`: a refusal may come back as `ok: false`, or as a 4xx the way updateSession and
    // deleteSession refuse a running session (the controller turns a thrown error into a 400). Either is a
    // refusal; `call` would throw on the second and report it as the scenario crashing.
    whileOther = await h.raw('POST', path);
    headAfter = h.git('rev-parse', 'HEAD');
  } finally {
    // Whatever happened above, the other session gets its answer and finishes: left mid-task on a reply
    // that never comes, it would keep the harness busy and its folders could not be removed.
    release?.(reply.done());
    await h.idle();
  }
  const body = (whileOther?.body ?? {}) as { ok?: boolean; problem?: string; message?: string };
  const refusedWith = whileOther && whileOther.status >= 200 && whileOther.status < 300
    ? (body.ok === false ? body.problem ?? '' : null)
    : whileOther && whileOther.status >= 400 && whileOther.status < 500 ? String(body.message ?? '') : null;
  // Restore asks about every session running in the repository, not only its own and a batch: one
  // running alone there had the repository moved under it mid-task.
  t.truthy('while another session works in this repository, restore is refused, naming it',
    refusedWith !== null && /running/.test(refusedWith) && refusedWith.includes('other-runner'), whileOther);
  t.check('and the repository was not moved', headAfter, headBefore);
  t.truthy('the restore preview says so too, naming it', previewWhileOther?.ok === false && (previewWhileOther.problem ?? '').includes('other-runner'), previewWhileOther);
  t.truthy('and so does the preview of "Run again from here"',
    restartWhileOther?.restores.length === 1 && restartWhileOther.restores[0]!.ok === false && (restartWhileOther.restores[0]!.problem ?? '').includes('other-runner'), restartWhileOther?.restores);
});

/*
 * "Run again from here" in a run that spans two repositories, where the second session was never reached.
 * The preview already knows the second repository has nothing to go back to (its task never started); the
 * restore itself must agree, or the button fails half-way — first repository moved, nothing queued.
 */
await scenario('Run again from here across two repositories', { limits: { maxCheckRounds: 1 } }, async (h) => {
  const repo2 = join(h.base, 'repo2');
  mkdirSync(repo2, { recursive: true });
  await makeRepo(repo2);
  const [front, back] = await h.importPlan({
    version: 1,
    sessions: [
      { name: 'front', onFailure: 'stop', vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'front' }, review: { enabled: false },
        tasks: [{ title: 'front-task', prompt: 'Create never.txt in the repository root, whatever it takes, and nothing else.', checks: [neverPasses] }] },
      { name: 'back', onFailure: 'stop', vcs: { enabled: true, repoDir: repo2, branchMode: 'per-session', branchName: 'back' }, review: { enabled: false },
        tasks: [fileTask('back-task', 'back.txt', 'back')] },
    ],
  });
  h.chat.script(...failTwice('a.txt', 'b.txt'));
  await h.call('POST', '/batch/start', { sessionIds: [front!.id, back!.id], mode: 'unattended', onFailure: 'stop' });
  await h.idle();
  const failed = (await read(h, front!.id)).tasks[0]!;
  const never = (await read(h, back!.id)).tasks[0]!;
  t.check('the first session failed and the second was never reached', [failed.status, never.status, never.startedAt ?? null], ['failed', 'queued', null]);

  const planned = await h.call<RestartPlan>('GET', `/sessions/${front!.id}/tasks/${failed.id}/restart`);
  t.check('the preview: ready, both tasks, one restore — for the repository the run touched',
    [planned.ok, planned.tasks.map((x) => x.taskId), planned.restores.length, planned.restores[0]?.repoDir, planned.restores[0]?.ok], [true, [failed.id, never.id], 1, h.repo, true]);

  const r = await h.call<Restarted>('POST', `/sessions/${front!.id}/tasks/${failed.id}/restart`, { restore: true, start: false });
  // Checked against git, not against the count of strings in `restored`: the first repository is at the
  // commit the failed task began from, on a restore branch. (This part works today; the failure is what
  // comes after it.)
  t.check('the first repository is back where the failed task began, on a restore branch',
    [h.git('rev-parse', 'HEAD'), h.git('branch', '--show-current').startsWith('cop/restore-')], [failed.vcs?.baseCommit, true]);
  t.check('the second repository was left on main', gitIn(repo2, 'branch', '--show-current'), 'main');
  // "requeued" counts what was put back in the queue: the second session's task was still queued, so
  // it is left alone (restart.alreadyQueued), and only the failed task is re-queued. `start: false` ends
  // with the reason "prepared, not started" rather than with none.
  // The restore takes back exactly the repositories the preview listed (one rule for both): a
  // repository whose affected task never started is skipped, not refused after the first was moved.
  t.check('prepared and not started: one task re-queued, one repository taken back',
    [r.requeued, r.restored.length, r.reason ?? null], [1, 1, 'prepared, not started']);
  t.truthy('the repository it reports taking back is the first one', r.restored[0]?.startsWith(h.repo), r.restored);
  t.check('the failed task is queued again', (await read(h, front!.id)).tasks[0]!.status, 'queued');
});

/*
 * A run started on chosen tasks, then "Run again from here" on one of them: what runs again is what that
 * run was asked to do, not every queued task of the session — the preview lists exactly that, and the run
 * must match it.
 */
await scenario('Run again from here runs only the run\'s own tasks', { limits: { maxCheckRounds: 1 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'chosen', [fileTask('t-one', 'one.txt', 'good'), fileTask('t-two', 'two.txt', 'two'), fileTask('t-three', 'three.txt', 'three')]));
  const [one, two] = s!.tasks;
  h.chat.script(write('one.txt', 'bad'), reply.done(), write('one.txt', 'worse'), reply.done());
  await h.call('POST', '/batch/start', { sessionIds: [s!.id], taskIds: [one!.id, two!.id], mode: 'unattended', onFailure: 'stop' });
  await h.idle();
  t.check('t-one failed and stopped the chain; the rest are queued', (await read(h, s!.id)).tasks.map((x) => x.status), ['failed', 'queued', 'queued']);

  const planned = await h.call<RestartPlan>('GET', `/sessions/${s!.id}/tasks/${one!.id}/restart`);
  t.check('the preview lists the run\'s two tasks, not the third', planned.tasks.map((x) => x.taskId), [one!.id, two!.id]);

  h.chat.script(write('one.txt', 'good'), reply.done(), write('two.txt', 'two'), reply.done());
  const r = await h.call<Restarted>('POST', `/sessions/${s!.id}/tasks/${one!.id}/restart`, { restore: false });
  t.check('it started', r.started, true);
  await h.idle();
  const after = (await read(h, s!.id)).tasks;
  t.check('the run\'s two tasks are done', [after[0]!.status, after[1]!.status], ['done', 'done']);
  // The run is started on the preview's tasks by id; started with none named, the batch took every
  // queued task of the session, and t-three went to the chat with no reply scripted for it.
  t.check('t-three, never part of the run, is still queued', after[2]!.status, 'queued');
  t.check('the chat was asked only about the run\'s tasks', [...h.chat.problems], []);
  // Counted once above; cleared so the scenario's closing check reports only problems of its own.
  h.chat.problems.splice(0);
});

/*
 * In per-session mode a restore to before task B cuts a restore branch at B's starting commit — and then
 * the re-run of B checks the session's branch out again, which still has B's failed work on it. The
 * confirmation promises "The code goes back first"; as written, the code does not stay back.
 */
await scenario('Run again from here in per-session mode: the rerun\'s checkout must not undo the restore', { limits: { maxCheckRounds: 1 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'chain', [
    fileTask('a-task', 'a.txt', 'a'),
    { title: 'b-task', prompt: 'Create good.txt in the repository root holding exactly the text good, and nothing else.', checks: [{ name: 'good.txt written', expect: 'file-contains', file: 'good.txt', value: 'good' }] },
  ]));
  h.chat.script(write('a.txt', 'a'), reply.done(), write('bad.txt', 'bad'), reply.done(), write('good.txt', 'nope'), reply.done());
  const [a, b] = (await run(h, s!.id)).tasks;
  t.check('A done, B failed with bad.txt committed', [a!.status, b!.status, !!b!.vcs?.commit && tree(h, b!.vcs.commit).includes('bad.txt')], ['done', 'failed', true]);
  t.check('B started from A\'s commit', b!.vcs?.baseCommit, a!.vcs?.commit);

  let badAtStart: boolean | undefined;
  h.chat.script(
    () => {
      badAtStart = existsSync(join(h.repo, 'bad.txt'));
      return reply.steps('Test-Path bad.txt', "Set-Content -Path good.txt -Value 'good' -Encoding utf8");
    },
    reply.done(),
  );
  const r = await h.call<Restarted>('POST', `/sessions/${s!.id}/tasks/${b!.id}/restart`, { restore: true });
  t.check('started, after taking one repository back', [r.started, r.restored.length], [true, 1]);
  await h.idle();
  const b2 = (await read(h, s!.id)).tasks[1]!;
  t.check('B\'s second attempt is done', b2.status, 'done');
  // Attempt 2 must have a commit of its own, or the tree check below would be reading some other ref.
  t.truthy('attempt 2 was committed', !!b2.vcs?.commit, b2.vcs);
  // Compared with the base recorded before the restart (already checked above to be A's commit), not
  // with another field of the same record, which would pass with both missing.
  // The session carries on from the restore branch, not from cop/chain, which still holds B's failed
  // commit: checked out again, it brought that commit back under attempt 2.
  t.check('B\'s attempt 2 starts where attempt 1 did', b2.vcs?.baseCommit, b!.vcs?.baseCommit);
  t.check('bad.txt was not in the tree B started in', badAtStart, false);
  // Read from that commit only: no branch or HEAD to fall back on, since after a restore HEAD is the
  // restore branch, which never had bad.txt.
  t.check('bad.txt is not in attempt 2\'s tree', b2.vcs?.commit ? tree(h, b2.vcs.commit).includes('bad.txt') : 'no commit', false);
  t.check('attempt 2 is on the restore branch the restart reported', b2.vcs?.branch, r.restored[0]?.split(' -> ')[1]);
  t.check('and cop/chain still holds the attempt that failed', h.git('rev-parse', 'cop/chain'), b!.vcs?.commit);
});

/*
 * The same, one session further: a second per-session session in the same repository carried on from the
 * first one's branch ("previous-session") after its task failed, so its own branch is built on the failed
 * work. Run again from the failed task, the second session must not go back to that branch: it starts again
 * from the work done again, on a branch of its own, and its old branch keeps what it did.
 */
await scenario('Run again from here: a later session in the same repository starts again from the work done again', { limits: { maxCheckRounds: 1 } }, async (h) => {
  const chained = (name: string, tasks: unknown[], vcs: Record<string, unknown> = {}): Record<string, unknown> =>
    (plan(h, name, tasks, { startFrom: 'branch', baseBranch: 'main', updateFromRemote: false, ...vcs }).sessions as unknown[])[0] as Record<string, unknown>;
  const [first, second] = await h.importPlan({
    version: 1,
    sessions: [
      chained('first-chain', [
        fileTask('a-task', 'a.txt', 'a'),
        { title: 'b-task', prompt: 'Create good.txt in the repository root holding exactly the text good, and nothing else.', checks: [{ name: 'good.txt written', expect: 'file-contains', file: 'good.txt', value: 'good' }] },
      ]),
      chained('second-chain', [fileTask('c-task', 'c.txt', 'c')], { startFrom: 'previous-session' }),
    ],
  });
  h.chat.script(write('a.txt', 'a'), reply.done(), write('bad.txt', 'bad'), reply.done(), write('good.txt', 'nope'), reply.done(), write('c.txt', 'c'), reply.done());
  await h.call('POST', '/batch/start', { sessionIds: [first!.id, second!.id], mode: 'unattended', onFailure: 'continue' });
  await h.idle();
  const [a, b] = (await read(h, first!.id)).tasks;
  const c = (await read(h, second!.id)).tasks[0]!;
  t.check('A done, B failed, and C ran after it', [a!.status, b!.status, c.status], ['done', 'failed', 'done']);
  t.check('C carried on from B\'s failed commit, bad.txt and all', [c.vcs?.baseCommit, !!c.vcs?.commit && tree(h, c.vcs.commit).includes('bad.txt')], [b!.vcs?.commit, true]);
  const oldC = c.vcs?.commit;

  h.chat.script(write('good.txt', 'good'), reply.done(), write('c.txt', 'c'), reply.done());
  const r = await h.call<Restarted>('POST', `/sessions/${first!.id}/tasks/${b!.id}/restart`, { restore: true });
  t.check('started, after taking the one repository back', [r.started, r.restored.length], [true, 1]);
  await h.idle();
  const b2 = (await read(h, first!.id)).tasks[1]!;
  const c2 = (await read(h, second!.id)).tasks[0]!;
  t.check('both done the second time', [b2.status, c2.status], ['done', 'done']);
  t.check('B\'s attempt 2 starts where attempt 1 did', b2.vcs?.baseCommit, b!.vcs?.baseCommit);
  t.check('C\'s attempt 2 starts from B\'s attempt 2', c2.vcs?.baseCommit, b2.vcs?.commit);
  t.truthy('on a branch of its own, not the one built on the failed work', !!c2.vcs?.branch && c2.vcs.branch !== c.vcs?.branch, [c2.vcs?.branch, c.vcs?.branch]);
  t.check('its tree has good.txt and not bad.txt',
    c2.vcs?.commit ? [tree(h, c2.vcs.commit).includes('good.txt'), tree(h, c2.vcs.commit).includes('bad.txt')] : 'no commit', [true, false]);
  t.check('and its old branch still holds what it did the first time', c.vcs?.branch ? h.git('rev-parse', c.vcs.branch) : null, oldC);
});

/*
 * A session that carries on an existing branch cannot be taken back: its run checks that branch out again
 * before its first task, so a restore branch would be left the moment it was made, and going back on the
 * branch itself would take a reset. "Run again from here" says so before anything moves, instead of
 * promising that the code goes back first.
 */
await scenario('Run again from here on a session that carries on an existing branch', { limits: { maxCheckRounds: 1 } }, async (h) => {
  h.git('branch', 'develop');
  const [s] = await h.importPlan(plan(h, 'carry-on', [{ title: 'dev-task', prompt: 'Create never.txt in the repository root, whatever it takes, and nothing else.', checks: [neverPasses] }], { existingBranch: 'develop' }));
  h.chat.script(...failTwice('a.txt', 'b.txt'));
  const failed = (await run(h, s!.id)).tasks[0]!;
  t.check('the task failed on develop', [failed.status, failed.vcs?.branch], ['failed', 'develop']);

  const planned = await h.call<RestartPlan>('GET', `/sessions/${s!.id}/tasks/${failed.id}/restart`);
  t.truthy('the preview refuses to take the repository back, saying why',
    planned.restores.length === 1 && planned.restores[0]!.ok === false && /existing branch develop/.test(planned.restores[0]!.problem ?? ''), planned.restores);
  const r = await h.call<Restarted>('POST', `/sessions/${s!.id}/tasks/${failed.id}/restart`, { restore: true, start: false });
  t.check('and so does the restart: nothing moved, nothing queued',
    [r.requeued, r.restored, h.git('branch', '--show-current'), (await read(h, s!.id)).tasks[0]!.status], [0, [], 'develop', 'failed']);
  t.truthy('no restore branch was made', !h.git('branch', '--list', 'cop/restore-*').trim(), h.git('branch', '--list'));
});

/*
 * The update before a session's first branch (fetch, then fast-forward only). e2e-vcs covers updated,
 * diverged, switched off and unreachable; these are the three quiet outcomes, which must leave the local
 * branch exactly where it was and must not stop the task.
 */
await scenario('update from the remote: no remote, ahead, up to date', {}, async (h) => {
  const fromMain = (name: string): Record<string, unknown> => plan(h, name, [fileTask(`${name}-task`, `${name}.txt`, name)], { startFrom: 'branch', baseBranch: 'main' });

  const [a] = await h.importPlan(fromMain('noremote'));
  h.chat.script(write('noremote.txt', 'noremote'), reply.done());
  const ranA = await run(h, a!.id);
  t.check('no remote: said, and the task ran', [ranA.vcsStart?.update?.outcome, ranA.tasks[0]!.status], ['no-remote', 'done']);

  const bare = join(h.base, 'server.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  h.git('remote', 'add', 'origin', bare);
  h.git('checkout', '-q', 'main');
  h.git('push', '-q', '-u', 'origin', 'main');
  writeFileSync(join(h.repo, 'mine.txt'), 'a local commit nobody pushed\n');
  h.git('add', '-A');
  h.git('commit', '-q', '-m', 'local only');
  const local = h.git('rev-parse', 'main');
  const [b] = await h.importPlan(fromMain('ahead'));
  h.chat.script(write('ahead.txt', 'ahead'), reply.done());
  const ranB = await run(h, b!.id);
  t.check('ahead: said, main not moved, the session starts from it', [ranB.vcsStart?.update?.outcome, h.git('rev-parse', 'main'), ranB.tasks[0]!.vcs?.baseCommit, ranB.tasks[0]!.status], ['ahead', local, local, 'done']);

  h.git('checkout', '-q', 'main');
  h.git('push', '-q', 'origin', 'main');
  const [c] = await h.importPlan(fromMain('uptodate'));
  h.chat.script(write('uptodate.txt', 'uptodate'), reply.done());
  const ranC = await run(h, c!.id);
  t.check('up to date: said, main where it was', [ranC.vcsStart?.update?.outcome, h.git('rev-parse', 'main'), ranC.tasks[0]!.status], ['up-to-date', local, 'done']);
});

t.finish();
