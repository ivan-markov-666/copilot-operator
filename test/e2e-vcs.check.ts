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
 *
 *   npm run check:e2e-vcs
 */
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

await scenario('a check expecting a branch the runner did not choose stops the task before it starts', {}, async (h) => {
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
  const ended = (await h.run(s!.id)).tasks[0]! as unknown as Ended;
  t.check('blocked before anything was sent', [ended.status, h.chat.sent.length], ['blocked', 0]);
  t.truthy('naming the branch it is on and the check to use instead', /cop\/session-work/.test(ended.reason ?? '') && /merge-base --is-ancestor/.test(ended.reason ?? ''), ended.reason);
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

t.finish();
