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
 * - a dirty tree refuses the task and touches nothing (until 0.1.18 it switched version control off and ran);
 * - `commitOnFinish: false` commits nothing, and the next task then finds a dirty tree (a decision pin);
 * - a branch name git refuses (the task is refused), and the branch and commit subject a plan names;
 * - tool output left in the tree is pointed out once, then either ignored or committed and marked;
 * - a failed task's work is still committed;
 * - a session made the way the UI makes it (POST /sessions, PUT, POST tasks) branches and commits, and so
 *   does one made with a folder of its own, in that folder, with the review told what changed;
 * - Restore: preview, restore, a second restore, a dirty tree, a running session — and another session
 *   running alone in the same repository, or in a folder inside it;
 * - Run again from here: across two repositories (and a refusal at the second, after the first moved),
 *   only the run's own tasks, in per-session mode where the rerun's checkout once undid the restore, a
 *   second restart on the line of work the first one started, a later session of the same repository
 *   chained on the failed work or started from a named branch, a machine that no longer allows the run
 *   unattended, and (a decision pin) a session that carries on an existing branch;
 * - the update from the remote before a session's first branch: no remote, ahead, up to date.
 *
 * Every check here must pass. Checks marked as a decision pin hold behaviour that was chosen.
 *
 *   npm run check:e2e-branches        (or: npx tsx test/e2e-branches.check.ts)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
type SessionRec = { id: string; name: string; chat?: { chatId: string }; vcs?: { branchName?: string; branchNameExact?: boolean }; vcsStart?: { commit?: string; update?: Update }; tasks: TaskRec[] };
type Preview = { ok: boolean; problem?: string; baseCommit?: string; leftBehind: string[]; keptOn?: string; branchName?: string; currentBranch?: string };
type Restored = { ok: boolean; problem?: string; branch?: string; commit?: string };
type RestartPlan = {
  ok: boolean;
  problem?: string;
  tasks: Array<{ sessionId: string; taskId: string; alreadyQueued: boolean }>;
  restores: Array<{ repoDir: string; ok: boolean; problem?: string; baseCommit?: string; branchName?: string }>;
  mode?: string;
  unattendedRefused?: string;
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
 * A dirty tree is the operator's own work in progress: committing it under the bot's name or carrying it
 * to another branch would both be decisions that are not the runner's. So version control is off for that
 * task — said on the task — and the repository is left exactly as it was, uncommitted changes included.
 */
/*
 * Until 0.1.18 a dirty tree switched version control off and the task ran: nothing was committed and it
 * ended done, its work loose in the tree (reported 2026-10-02). With commits on, a task whose work could
 * not be committed is not run: it is refused before anything is sent, and nothing is touched.
 */
await scenario('a dirty tree refuses the run before the browser opens, and touches nothing', {}, async (h) => {
  writeFileSync(join(h.repo, 'README.md'), '# fixture\nan edit the operator has not committed\n');
  writeFileSync(join(h.repo, 'wip.txt'), 'work in progress\n');
  const mainBefore = h.git('rev-parse', 'main');
  const [s] = await h.importPlan(plan(h, 'dirty', [fileTask('write-a', 'a.txt', 'a')]));
  // Since 2026-10-02 version control is checked before the browser opens: the start itself is refused.
  const r = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  t.check('the run does not start', r.started, false);
  t.truthy('the reason names the files', /uncommitted changes \(README\.md, wip\.txt\)/.test(r.reason ?? ''), r.reason);
  t.check('no browser opened, no message went to the chat', [h.chat.opened, h.chat.sent.length], [0, 0]);
  t.check('the repository is still on main', h.git('branch', '--show-current'), 'main');
  t.check('no cop/ branch was made', h.git('for-each-ref', '--format=%(refname:short)', 'refs/heads/cop/'), '');
  t.check('main has no new commit', h.git('rev-parse', 'main'), mainBefore);
  const status = h.git('status', '--porcelain');
  t.truthy('README.md and wip.txt are still uncommitted, as the operator left them', /^\s?M README\.md$/m.test(status) && /^\?\? wip\.txt$/m.test(status), status);
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
  t.truthy('task 2 ran with version control off, because of task 1\'s file', two!.status === 'done' && /commits are off for this session, so the files the earlier task\(s\) left are still in the working tree/.test(two!.vcs?.problem ?? ''), two);
});

/*
 * A plan can name a branch git will not have. The runner asks git (`check-ref-format`) rather than guess,
 * says so on the task, and makes nothing: no half-made ref, no commit anywhere.
 */
await scenario('a branch name git refuses: said on the task, nothing made', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'badname', [fileTask('write-a', 'a.txt', 'a')], { branchName: 'feature/work.lock' }));
  const task = (await run(h, s!.id)).tasks[0]!;
  t.truthy('the task says the name is not one git accepts', /is not a name git accepts/.test(task.vcs?.problem ?? ''), task.vcs);
  t.check('the only local branch is main', h.git('for-each-ref', '--format=%(refname:short)', 'refs/heads'), 'main');
  // Refused, not run without version control as until 0.1.18: nothing was written, so nothing is loose.
  t.check('the task is refused and nothing was written', [task.status, h.git('status', '--porcelain'), h.chat.sent.length], ['failed', '', 0]);
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
    pointedOut.includes('node_modules/') && pointedOut.includes('.env') && /to \.gitignore/.test(pointedOut), pointedOut.slice(0, 1200));
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
 * The same machine, from the page. The plan says that the run it repeats went on its own and why this
 * machine no longer allows that, and the dialog then asks for the run step by step, which is always
 * allowed: the dialog has no other mode to offer, so asked as recorded, its button was refused every
 * time. And a run that left no record of its own — `cop run` from the terminal, or one older than the
 * record — is run again step by step: taken for unattended, it was refused the same way on every
 * machine that refuses unattended runs, the default among them.
 */
/** Waits for the run to end, approving every step it asks about, as an operator running step by step would. */
async function idleApproving(h: Harness): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    for (const a of await h.call<Array<{ id: string }>>('GET', '/approvals')) await h.call('POST', `/approvals/${a.id}`, { action: 'run' });
    const act = await h.call<{ running: boolean; batch: boolean; starting?: boolean }>('GET', '/activity');
    if (!act.running && !act.batch && !act.starting) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('the run did not end');
}

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
