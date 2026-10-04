/**
 * The version-control lifecycle of one task, end to end with the scripted chat, from the defects
 * reported on 2026-09-30 while a task carried on a recovery branch:
 *
 * - a branch name in the team's own convention is used as written, and an existing one is carried on;
 * - the chat is told that branch is where the work goes, and `git merge-base` is not refused;
 * - a check expecting another branch stops the task before anything is sent, saying what to check instead;
 * - a check that the tree is clean is decided after the runner's commit, not before it;
 * - a task that ends blocked says the runner committed its changes afterwards, and why no review ran;
 * - the handoff keeps the tree before the commit, the checks, the commit and the tree after it apart.
 * - a plan can put a new task on an existing branch (`existingBranch`): no new branch, exactly that
 *   name, task after task; a branch that is not there is refused at import, and at the run a missing
 *   branch or a dirty tree refuses the task before anything is sent.
 * - before a session's first branch the starting branch is fetched and fast-forwarded from its remote,
 *   only ever forward: a branch with its own commits is left and said, and the option can be switched off.
 *
 *   npm run check:e2e-vcs
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

async function scenario(title: string, settings: Record<string, unknown>, body: (h: Harness) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings });
  try {
    await body(h);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

const write = (file: string, text: string): string => reply.steps(`Set-Content -Path ${file} -Value '${text}' -Encoding utf8`);

type Lifecycle = {
  preCommitState?: { changed: string[] };
  checksResult: Array<{ name: string; passed: boolean }>;
  commitResult: { branch?: string; commit?: string; files: number };
  postCommitState?: { branch?: string; head?: string; clean: boolean; uncommitted: string[] };
};
type Ended = { status: string; reason?: string; vcs?: { branch?: string; commit?: string }; checkResults?: Array<{ name: string; passed: boolean; detail: string }>;
  review?: { verdict: string; skippedBecause?: string }; handoff?: { lifecycle?: Lifecycle } };

/** A recovery branch with a checkpoint commit on it, the way the operator left the repository. */
function recoveryBranch(h: Harness): string {
  h.git('checkout', '-q', '-b', 'recovery/apz-migration');
  writeFileSync(join(h.repo, 'checkpoint.txt'), 'half of the migration\n');
  h.git('add', '-A');
  h.git('commit', '-q', '-m', 'checkpoint');
  const checkpoint = h.git('rev-parse', 'HEAD');
  h.git('checkout', '-q', 'main');
  return checkpoint;
}

await scenario('a recovery branch named in the plan is carried on, as written', {}, async (h) => {
  const checkpoint = recoveryBranch(h);
  const [s] = await h.importPlan({
    version: 1,
    sessions: [{
      name: 'apz',
      onFailure: 'stop',
      vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'recovery/apz-migration' },
      review: { enabled: false },
      tasks: [{
        title: 'finish-migration',
        prompt: 'Finish the migration on the recovery branch: create done.txt holding exactly finished.',
        checks: [
          { name: 'done.txt written', expect: 'file-contains', file: 'done.txt', value: 'finished' },
          { name: 'on the recovery branch', expect: 'output-contains', run: 'git branch --show-current', value: 'recovery/apz-migration' },
          { name: 'the checkpoint is included', expect: 'exit-zero', run: `git merge-base --is-ancestor ${checkpoint} HEAD` },
          { name: 'the tree is clean', expect: 'exit-zero', run: 'if (git status --porcelain) { exit 1 }' },
        ],
      }],
    }],
  });
  h.chat.script(
    (m) => {
      t.truthy('the chat is told the branch is where the work goes, whatever the task names', /`recovery\/apz-migration` is where this work goes/.test(m.text), m.text.slice(0, 600));
      t.truthy('and to check a commit with merge-base, not the branch name', /git merge-base --is-ancestor <commit> HEAD/.test(m.text), '');
      return write('done.txt', 'finished');
    },
    reply.done(),
  );
  const ended = (await h.run(s!.id)).tasks[0]! as unknown as Ended;
  t.check('done', [ended.status, ended.reason ?? null], ['done', null]);
  t.check('on the branch the plan named, not a copy with a prefix', ended.vcs?.branch, 'recovery/apz-migration');
  t.check('carried on: the checkpoint is under the task\'s commit', h.git('merge-base', '--is-ancestor', checkpoint, ended.vcs!.commit!) === '', true);
  const results = Object.fromEntries((ended.checkResults ?? []).map((c) => [c.name, c.passed]));
  t.check('the branch check and the merge-base check pass', [results['on the recovery branch'], results['the checkpoint is included']], [true, true]);
  t.check('the clean-tree check was decided after the commit, and passed', results['the tree is clean (after the commit)'], true);
  t.check('and not before it', 'the tree is clean' in results, false);
  const life = ended.handoff?.lifecycle;
  t.truthy('the handoff: before the commit done.txt was new', life?.preCommitState?.changed.some((p) => p.includes('done.txt')), life?.preCommitState);
  t.check('the commit, then a clean tree on the same branch at that commit', [life?.commitResult.commit, life?.postCommitState?.clean, life?.postCommitState?.branch, life?.postCommitState?.head],
    [ended.vcs?.commit, true, 'recovery/apz-migration', ended.vcs?.commit]);
});

await scenario('a check expecting a branch the runner did not choose is refused before the run starts', {}, async (h) => {
  const [s] = await h.importPlan({
    version: 1,
    sessions: [{
      name: 'other',
      onFailure: 'stop',
      vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'session-work' },
      review: { enabled: false },
      tasks: [{
        title: 'wrong-branch-check',
        prompt: 'Create a.txt in the repository root holding exactly the letter a, and nothing else.',
        checks: [{ name: 'on the recovery branch', expect: 'output-contains', run: 'git branch --show-current', value: 'recovery/apz-migration' }],
      }],
    }],
  });
  // Since 2026-10-04 the branch is known before the run, so it is refused there: no branch cut, no attempt.
  const r = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  const ended = (await h.session(s!.id)).tasks[0]! as unknown as Ended;
  t.check('refused before anything was sent, the task still queued', [r.started, ended.status, h.chat.sent.length], [false, 'queued', 0]);
  t.truthy('naming the branch it would be on and the check to use instead', /cop\/session-work/.test(r.reason ?? '') && /merge-base --is-ancestor/.test(r.reason ?? ''), r.reason);
});

await scenario('a task that ends blocked says the runner committed afterwards, and why no review ran', { limits: { retryBlockedInFreshChat: 0 } }, async (h) => {
  const [s] = await h.importPlan({
    version: 1,
    sessions: [{
      name: 'stuck',
      onFailure: 'stop',
      vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'stuck' },
      review: { enabled: true },
      tasks: [{ title: 'half-done', prompt: 'Create half.txt in the repository root, then finish the rest of the migration.' }],
    }],
  });
  h.chat.script(write('half.txt', 'half'), reply.blocked('I could not finish: nothing is committed and the working tree is dirty, and the rest needs a file that is not here.'));
  const ended = (await h.run(s!.id)).tasks[0]! as unknown as Ended;
  t.check('blocked, and the work committed', [ended.status, !!ended.vcs?.commit], ['blocked', true]);
  t.truthy('the reason says the runner committed after the chat wrote its account', new RegExp(`runner committed the task's changes as ${ended.vcs!.commit!.slice(0, 8)}`).test(ended.reason ?? '') && /working tree is clean/.test(ended.reason ?? ''), ended.reason);
  t.truthy('a review that was on and never ran says why', ended.review?.verdict === 'skipped' && /ended blocked before its work reached the review/.test(ended.review.skippedBecause ?? ''), ended.review);
  t.check('the handoff: after the commit the tree is clean', ended.handoff?.lifecycle?.postCommitState?.clean, true);
});

/** A plan of one session that carries on `branch`, with the tasks given. */
const onExisting = (h: Harness, name: string, branch: string, tasks: unknown[]): Record<string, unknown> => ({
  version: 1,
  sessions: [{
    name,
    onFailure: 'stop',
    // `existingBranch` alone means startFrom "existing-branch"; branchMode is written to show it does not apply.
    vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-task', existingBranch: branch },
    review: { enabled: false },
    tasks,
  }],
});
const fileTask = (title: string, file: string, text: string): Record<string, unknown> => ({
  title,
  prompt: `Create ${file} in the repository root holding exactly the text ${text}, and nothing else.`,
  checks: [{ name: `${file} written`, expect: 'file-contains', file, value: text }],
});

await scenario('new tasks on an existing branch: that branch, exactly, task after task', {}, async (h) => {
  // A branch without a "/" — the case a prefix used to swallow.
  h.git('checkout', '-q', '-b', 'develop');
  writeFileSync(join(h.repo, 'earlier.txt'), 'work already on develop\n');
  h.git('add', '-A');
  h.git('commit', '-q', '-m', 'earlier work');
  const tip = h.git('rev-parse', 'HEAD');
  h.git('checkout', '-q', 'main');

  const [s] = await h.importPlan(onExisting(h, 'carry-on', 'develop', [fileTask('first', 'one.txt', 'one'), fileTask('second', 'two.txt', 'two')]));
  t.check('imported as carrying on the branch', [s!.vcs?.startFrom, (s!.vcs as { existingBranch?: string } | undefined)?.existingBranch], ['existing-branch', 'develop']);
  h.chat.script(
    (m) => {
      t.truthy('the chat is told it carries on the existing branch, with its work in the tree', /carries on the existing branch `develop`/.test(m.text), m.text.slice(0, 700));
      return write('one.txt', 'one');
    },
    reply.done(),
    write('two.txt', 'two'),
    reply.done(),
  );
  const after = await h.run(s!.id);
  const [one, two] = after.tasks as unknown as Array<{ status: string; vcs?: { branch?: string; baseCommit?: string; commit?: string } }>;
  t.check('both done, both on develop', [one!.status, two!.status, one!.vcs?.branch, two!.vcs?.branch], ['done', 'done', 'develop', 'develop']);
  t.check('the first starts from the branch as it was', one!.vcs?.baseCommit, tip);
  t.check('the second builds on the first', h.git('rev-parse', `${two!.vcs?.commit}^`), one!.vcs?.commit);
  t.check('develop now ends at the second task\'s commit', h.git('rev-parse', 'develop'), two!.vcs?.commit);
  t.check('no other branch was made', h.git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort(), ['develop', 'main']);
  const record = (await h.session(s!.id)) as unknown as { vcsStart?: { kind: string; branch?: string; commit: string } };
  t.check('the session records where the branch was when it began', [record.vcsStart?.kind, record.vcsStart?.branch, record.vcsStart?.commit], ['existing-branch', 'develop', tip]);
});

await scenario('a branch that is not there: refused at import, naming the branches that are', {}, async (h) => {
  const r = await h.call<{ ok: boolean; check?: { issues?: Array<{ path: string; message: string }> } }>('POST', '/plan/import', {
    text: JSON.stringify(onExisting(h, 'nowhere', 'recovery/missing', [fileTask('lost', 'x.txt', 'x')])),
  });
  const issue = r.check?.issues?.[0];
  t.truthy('refused, on existingBranch, listing main', !r.ok && issue?.path === 'sessions[0].vcs.existingBranch' && /no local branch "recovery\/missing"/.test(issue.message) && /main/.test(issue.message), r);
  const plain = await h.call<{ ok: boolean; check?: { issues?: Array<{ message: string }> } }>('POST', '/plan/check', {
    text: JSON.stringify({ ...onExisting(h, 'both', 'main', []), sessions: [{ ...(onExisting(h, 'both', 'main', [fileTask('t', 'x.txt', 'x')]).sessions as Array<Record<string, unknown>>)[0], vcs: { enabled: true, repoDir: h.repo, startFrom: 'branch', existingBranch: 'main' } }] }),
  });
  t.truthy('existingBranch with another startFrom is refused as contradictory', plain.ok === false, plain);
});

await scenario('before the browser opens: a branch gone, or uncommitted changes, refuse the run', {}, async (h) => {
  // Since 2026-10-02 these are found before anything opens the browser: the start itself is refused.
  const start = async (id: string): Promise<{ started: boolean; reason?: string }> => await h.call('POST', `/sessions/${id}/start`, { mode: 'unattended' });
  h.git('branch', 'feature/soon-gone');
  const [s] = await h.importPlan(onExisting(h, 'gone', 'feature/soon-gone', [fileTask('never', 'x.txt', 'x')]));
  h.git('branch', '-D', 'feature/soon-gone');
  const gone = await start(s!.id);
  t.truthy('refused, saying the branch is missing, no browser opened', !gone.started && /no such branch/.test(gone.reason ?? '') && h.chat.opened === 0, gone);

  h.git('branch', 'feature/dirty');
  const [d] = await h.importPlan(onExisting(h, 'dirty', 'feature/dirty', [fileTask('never-either', 'y.txt', 'y')]));
  writeFileSync(join(h.repo, 'operator-work.txt'), "the operator's own change\n");
  const dirty = await start(d!.id);
  t.truthy('refused, saying the tree has uncommitted changes, no browser opened', !dirty.started && /uncommitted changes/.test(dirty.reason ?? '') && h.chat.opened === 0, dirty);
  t.check('and the repository was left on main, the change untouched', [h.git('branch', '--show-current'), h.git('status', '--porcelain')], ['main', '?? operator-work.txt']);
});

/**
 * A bare repository as `origin`, with main pushed, and a second clone that pushes one more commit to it —
 * the server moving on while this checkout did not. Returns that commit.
 */
function serverMovesOn(h: Harness, branch = 'main'): string {
  const bare = join(h.base, 'server.git');
  const other = join(h.base, 'colleague');
  const run = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  h.git('remote', 'add', 'origin', bare);
  h.git('push', '-q', '-u', 'origin', 'main');
  if (branch !== 'main') h.git('push', '-q', '-u', 'origin', branch);
  execFileSync('git', ['clone', '-q', '-b', branch, bare, other]);
  run(other, 'config', 'user.email', 'colleague@example.invalid');
  run(other, 'config', 'user.name', 'colleague');
  writeFileSync(join(other, 'server.txt'), 'pushed by a colleague\n');
  run(other, 'add', '-A');
  run(other, 'commit', '-q', '-m', 'on the server');
  run(other, 'push', '-q', 'origin', branch);
  return run(other, 'rev-parse', 'HEAD');
}

const fromMain = (h: Harness, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  sessions: [{
    name,
    onFailure: 'stop',
    vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: name, startFrom: 'branch', baseBranch: 'main', ...extra },
    review: { enabled: false },
    tasks: [fileTask(`${name}-task`, 'a.txt', 'a')],
  }],
});

type Started = { vcsStart?: { commit?: string; update?: { outcome: string; from?: string; to?: string; remote?: string } } };

await scenario('before the session branch: main is fetched and moved forward to the server\'s', {}, async (h) => {
  const server = serverMovesOn(h);
  const [s] = await h.importPlan(fromMain(h, 'fresh'));
  h.chat.script(write('a.txt', 'a'), reply.done());
  const task = (await h.run(s!.id)).tasks[0]!;
  const started = (await h.session(s!.id)) as unknown as Started;
  t.check('the session starts from the server\'s commit', [started.vcsStart?.commit, task.vcs?.baseCommit], [server, server]);
  t.check('main was moved forward to it', h.git('rev-parse', 'main'), server);
  t.check('and it says so', [started.vcsStart?.update?.outcome, started.vcsStart?.update?.remote, started.vcsStart?.update?.to], ['updated', 'origin/main', server]);
  t.check('the colleague\'s file is in the task\'s work', h.git('show', `${task.vcs?.commit}:server.txt`), 'pushed by a colleague');
});

await scenario('main with commits of its own is left as it is, and that is said', {}, async (h) => {
  serverMovesOn(h);
  writeFileSync(join(h.repo, 'mine.txt'), 'a local commit nobody pushed\n');
  h.git('add', '-A');
  h.git('commit', '-q', '-m', 'local only');
  const local = h.git('rev-parse', 'main');
  const [s] = await h.importPlan(fromMain(h, 'diverged'));
  h.chat.script(write('a.txt', 'a'), reply.done());
  const task = (await h.run(s!.id)).tasks[0]!;
  const started = (await h.session(s!.id)) as unknown as Started;
  t.check('main is untouched and the session starts from it', [h.git('rev-parse', 'main'), task.vcs?.baseCommit], [local, local]);
  t.check('the update says the branches went their own ways', started.vcsStart?.update?.outcome, 'diverged');
  t.check('the task still ran', task.status, 'done');
});

await scenario('switched off in the plan: no fetch, the local branch as it is', {}, async (h) => {
  serverMovesOn(h);
  const local = h.git('rev-parse', 'main');
  const [s] = await h.importPlan(fromMain(h, 'offline', { updateFromRemote: false }));
  h.chat.script(write('a.txt', 'a'), reply.done());
  const task = (await h.run(s!.id)).tasks[0]!;
  const started = (await h.session(s!.id)) as unknown as Started;
  t.check('started from the local main, no update recorded', [task.vcs?.baseCommit, h.git('rev-parse', 'main'), started.vcsStart?.update ?? null], [local, local, null]);
});

await scenario('an existing branch carried on is brought up to date from its upstream first', {}, async (h) => {
  h.git('checkout', '-q', '-b', 'feature/shared');
  h.git('checkout', '-q', 'main');
  const server = serverMovesOn(h, 'feature/shared');
  const [s] = await h.importPlan(onExisting(h, 'shared', 'feature/shared', [fileTask('on-shared', 'b.txt', 'b')]));
  h.chat.script(write('b.txt', 'b'), reply.done());
  const task = (await h.run(s!.id)).tasks[0]!;
  const started = (await h.session(s!.id)) as unknown as Started;
  t.check('the branch was moved forward to the server\'s, and the task built on it', [started.vcsStart?.update?.outcome, task.vcs?.baseCommit, h.git('rev-parse', `${task.vcs?.commit}^`)], ['updated', server, server]);
});

await scenario('a remote that cannot be reached: said, and the session starts from the local branch', {}, async (h) => {
  h.git('remote', 'add', 'origin', join(h.base, 'no-such-server.git'));
  const local = h.git('rev-parse', 'main');
  const [s] = await h.importPlan(fromMain(h, 'unreachable'));
  h.chat.script(write('a.txt', 'a'), reply.done());
  const task = (await h.run(s!.id)).tasks[0]!;
  const started = (await h.session(s!.id)) as unknown as Started;
  t.check('the fetch failed and was said, the task ran from the local main', [started.vcsStart?.update?.outcome, task.vcs?.baseCommit, task.status], ['fetch-failed', local, 'done']);
});

t.finish();
