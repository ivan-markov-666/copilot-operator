/**
 * A task is decided by its current contract — prompt, checks, what it may change — not by what an
 * earlier attempt inherited. The rules in `applyTaskPatch` (src/session/store.ts), the contract
 * check before a task starts (src/orchestrator/contract.ts), and the plan importer's refusal of a
 * task that contradicts itself.
 *
 *   npm run check:intent
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTaskPatch } from '../src/session/store.js';
import { contractConflicts, contractConflictsWithFixes, contractFixPatch, describeContractChange } from '../src/orchestrator/contract.js';
import { nextAttemptBranch } from '../src/vcs/taskVcs.js';
import { runQueuedSelection } from '../web/lib/runSelection.js';
import { checkPlan } from '../src/plan/schema.js';
import type { Session, Task, TaskReviewCheck } from '../src/session/model.js';
import { Tally } from './support/harness.js';

const t = new Tally();

const reviewCheck = (state: TaskReviewCheck['state']): TaskReviewCheck => ({
  check: { name: 'the build uses the new config', expect: 'output-contains', run: 'npm run build', value: 'config: new' },
  findingId: 'r1f1',
  what: 'the build still reads the old config',
  round: 1,
  attempt: 1,
  state,
});
const task = (): Task =>
  ({
    id: 't',
    title: 'maintain',
    level2: '',
    prompt: 'Move the build to the new config.',
    status: 'done',
    createdAt: '',
    iterations: 3,
    checks: [{ name: 'config moved', expect: 'file-contains', file: 'build.json', value: 'new' }],
    reviewChecks: [reviewCheck('active'), reviewCheck('suspended'), { ...reviewCheck('dropped'), findingId: 'r1f2' }],
  }) as Task;

console.log('--- a new prompt is a new question ---');
{
  const t1 = task();
  applyTaskPatch(t1, { prompt: 'Audit the build configuration and report what you find. Change nothing.' });
  t.check('every inherited review check is dropped', t1.reviewChecks?.map((r) => r.state), ['dropped', 'dropped', 'dropped']);
  t.truthy('with the reason beside it', /new prompt/.test(t1.reviewChecks?.[0]?.droppedBecause ?? ''), t1.reviewChecks?.[0]);
  t.check('one dropped before keeps its own record', t1.reviewChecks?.[2]?.droppedBecause, undefined);
  t.check('the plan\'s own checks are left to the caller to keep or replace', t1.checks?.map((c) => c.name), ['config moved']);

  const t2 = task();
  applyTaskPatch(t2, { prompt: '  Move the build to the new config.  ' });
  t.check('the same prompt re-sent keeps the review checks', t2.reviewChecks?.map((r) => r.state), ['active', 'suspended', 'dropped']);

  const t3 = task();
  applyTaskPatch(t3, { prompt: 'Audit it.', checks: [{ name: 'report written', expect: 'file-contains', file: 'audit/report.md', value: '## Findings' }], scope: ['audit/', ' '] });
  t.check('new checks replace the old', t3.checks?.map((c) => c.name), ['report written']);
  t.check('a scope is set, blanks dropped', t3.scope, ['audit/']);
  applyTaskPatch(t3, { readOnly: true, scope: [] });
  t.check('read-only on, scope cleared', [t3.readOnly, t3.scope], [true, undefined]);
  applyTaskPatch(t3, { readOnly: false });
  t.check('and off again', t3.readOnly, undefined);
}

console.log('\n--- a contract that cannot be met is named before anything runs ---');
const dir = await mkdtemp(join(tmpdir(), 'cop-intent-'));
try {
  await mkdir(join(dir, 'audit'), { recursive: true });
  await writeFile(join(dir, 'build.json'), '{"config":"old"}\n');
  const base = { checks: [] as Task['checks'], reviewChecks: [] as TaskReviewCheck[] };

  t.check('nothing to judge: no conflict', await contractConflicts({ ...base }, dir, dir), []);
  t.truthy('read-only and scoped at once', (await contractConflicts({ ...base, readOnly: true, scope: ['audit/'] }, dir, dir))[0]?.includes('read-only'));
  const ro = await contractConflicts({ ...base, readOnly: true, checks: [{ name: 'config moved', expect: 'file-contains', file: 'build.json', value: 'new' }] }, dir, dir);
  t.truthy('read-only, with a check that needs a file changed', ro.length === 1 && ro[0]!.includes('"config moved"') && ro[0]!.includes('read-only'), ro);
  const ok = await contractConflicts({ ...base, readOnly: true, checks: [{ name: 'config is there', expect: 'file-exists', file: 'build.json' }] }, dir, dir);
  t.check('read-only, with a check that already passes: fine', ok, []);
  const scoped = await contractConflicts({ ...base, scope: ['audit/'], checks: [{ name: 'config moved', expect: 'file-contains', file: 'build.json', value: 'new' }] }, dir, dir);
  t.truthy('scoped, with a check on a file outside the scope', scoped.length === 1 && scoped[0]!.includes('leaves that file out'), scoped);
  const inside = await contractConflicts({ ...base, scope: ['audit/'], checks: [{ name: 'report', expect: 'file-exists', file: 'audit/report.md' }] }, dir, dir);
  t.check('scoped, with a check on a file inside it: fine', inside, []);
  const cmd = await contractConflicts({ ...base, readOnly: true, checks: [{ name: 'tests pass', expect: 'exit-zero', run: 'npm test' }] }, dir, dir);
  t.check('a command check is not judged in advance', cmd, []);
  const inherited = await contractConflicts({ ...base, readOnly: true, reviewChecks: [{ ...reviewCheck('active'), check: { name: 'old finding', expect: 'file-contains', file: 'build.json', value: 'new' } }] }, dir, dir);
  t.check('an active review check counts too', inherited.length, 1);
  const droppedOnly = await contractConflicts({ ...base, readOnly: true, reviewChecks: [{ ...reviewCheck('dropped'), check: { name: 'old finding', expect: 'file-contains', file: 'build.json', value: 'new' } }] }, dir, dir);
  t.check('a dropped one does not', droppedOnly, []);

  /*
   * Each contradiction comes with the ways out, least change first, and applying the first of each makes
   * the task satisfiable (operator feedback 2026-10-08: "offer the minimal fix, e.g. add the required
   * output file to the scope"). Judged again after the fix, on the same tree: nothing left.
   */
  console.log('\n--- each contradiction comes with its smallest fix ---');
  const outside = { ...base, scope: ['audit/'], checks: [{ name: 'config moved', expect: 'file-contains' as const, file: 'build.json', value: 'new' }] };
  const [scopeConflict] = await contractConflictsWithFixes(outside, dir, dir);
  t.check('a file outside the scope: add that file first, or drop the check', scopeConflict?.fixes, [{ kind: 'add-to-scope', path: 'build.json' }, { kind: 'drop-check', check: 'config moved' }]);
  const widened = { ...outside, ...contractFixPatch(outside, [scopeConflict!.fixes[0]!]) };
  t.check('applied: the scope gains exactly that file, the check stays', [widened.scope, widened.checks?.map((c) => c.name), widened.readOnly], [['audit/', 'build.json'], ['config moved'], false]);
  t.check('and the task no longer contradicts itself', await contractConflicts(widened, dir, dir), []);

  const readOnlyNeedsChange = { ...base, readOnly: true, checks: [{ name: 'config moved', expect: 'file-contains' as const, file: 'build.json', value: 'new' }] };
  const [roConflict] = await contractConflictsWithFixes(readOnlyNeedsChange, dir, dir);
  t.check('read-only but a check needs a change: allow only that file first', roConflict?.fixes[0], { kind: 'not-read-only', scope: ['build.json'] });
  const loosened = { ...readOnlyNeedsChange, ...contractFixPatch(readOnlyNeedsChange, [roConflict!.fixes[0]!]) };
  t.check('applied: no longer read-only, scoped to that one file', [loosened.readOnly, loosened.scope], [false, ['build.json']]);
  t.check('and nothing left to contradict', await contractConflicts(loosened, dir, dir), []);

  const both = { ...base, readOnly: true, scope: ['audit/'] };
  const [bothConflict] = await contractConflictsWithFixes(both, dir, dir);
  t.check('read-only and scoped: drop the paths first (read-only already allows none)', bothConflict?.fixes.map((f) => f.kind), ['drop-scope', 'not-read-only']);
  const dropped = { ...both, ...contractFixPatch(both, [bothConflict!.fixes[0]!]) };
  t.check('applied: read-only, no scope', [dropped.readOnly, dropped.scope], [true, []]);
  t.check('and fine', await contractConflicts(dropped, dir, dir), []);

  // A review's check is that review's finding: it is never offered for dropping, only the task's own are.
  const fromReview = { ...base, scope: ['audit/'], reviewChecks: [{ ...reviewCheck('active'), check: { name: 'old finding', expect: 'file-contains' as const, file: 'build.json', value: 'new' } }] };
  const [reviewConflict] = await contractConflictsWithFixes(fromReview, dir, dir);
  t.check('a review check outside the scope: only the scope is offered', reviewConflict?.fixes, [{ kind: 'add-to-scope', path: 'build.json' }]);
  const dropOne = contractFixPatch({ checks: [{ name: 'a', expect: 'exit-zero', run: 'x' }, { name: 'b', expect: 'exit-zero', run: 'y' }] }, [{ kind: 'drop-check', check: 'a' }]);
  t.check('dropping a check drops that one only', dropOne.checks?.map((c) => c.name), ['b']);

  /*
   * Nothing the operator did not choose changes: a read-only task keeps its paths when "leave this one"
   * was chosen for that contradiction and another fix was applied (review of 2026-10-09: the paths went
   * silently). And the change is described by its result, not fix by fix: "drop the paths" for one
   * contradiction and "allow only this file" for another read side by side as a contradiction.
   */
  const roScoped = { readOnly: true, scope: ['audit/'], checks: [{ name: 'config moved', expect: 'file-contains' as const, file: 'build.json', value: 'new' }] };
  t.check('leaving read-only + scope while dropping a check keeps the paths', contractFixPatch(roScoped, [{ kind: 'drop-check', check: 'config moved' }]), { readOnly: true, scope: ['audit/'], checks: [] });
  const both2 = contractFixPatch(roScoped, [{ kind: 'drop-scope' }, { kind: 'not-read-only', scope: ['build.json'] }]);
  t.check('both defaults together: changes only build.json', [both2.readOnly, both2.scope], [false, ['build.json']]);
  t.check('described by the result, without a contradiction', describeContractChange(roScoped, both2), ['no longer read-only', 'may change only build.json (was audit/)']);
  t.check('a dropped check is named', describeContractChange(roScoped, { ...roScoped, checks: [] }), ['the check "config moved" dropped']);
} finally {
  await rm(dir, { recursive: true, force: true });
}

/*
 * The branch the next attempt goes on, judged before the run by the runner's own rules (taskVcs
 * prepareForTask): a task blocked before it committed anything goes on its empty branch again, not on a
 * "-a2" — a check about the branch was judged against a name the run would never use (review of 2026-10-09).
 */
console.log('\n--- the branch the next attempt goes on ---');
{
  const session = { name: 'web', vcs: { enabled: true, repoDir: '', branchMode: 'per-task', commitOnFinish: true, branchPrefix: 'cop/' } } as unknown as Session;
  const base = { id: 't1', title: 'login form', level2: '', prompt: 'p', createdAt: '', iterations: 0 } as unknown as Task;
  t.check('a first attempt: the derived name', nextAttemptBranch(session, { ...base, status: 'queued' } as Task), 'cop/web-login-form');
  t.check('blocked before committing anything: that empty branch again', nextAttemptBranch(session, { ...base, status: 'blocked', vcs: { branch: 'cop/web-login-form', baseCommit: 'abc' } } as Task), 'cop/web-login-form');
  t.check('failed after committing: a new "-a2" branch', nextAttemptBranch(session, { ...base, status: 'failed', vcs: { branch: 'cop/web-login-form', baseCommit: 'abc', commit: 'def' } } as Task), 'cop/web-login-form-a2');
  t.check('queued to continue: the previous attempt\'s branch', nextAttemptBranch(session, { ...base, status: 'queued', attempt: 2, continuing: { fromAttempt: 1 }, attempts: [{ status: 'limit-reached', iterations: 3, title: 't', prompt: 'p', level2: '', vcs: { branch: 'cop/web-login-form', baseCommit: 'abc', commit: 'def' } }] } as unknown as Task), 'cop/web-login-form');
  t.check('a planned name keeps its "-aN" rule', nextAttemptBranch(session, { ...base, status: 'failed', vcsPlan: { branch: 'feature/login' }, vcs: { branch: 'feature/login', baseCommit: 'abc', commit: 'def' } } as Task), 'feature/login-a2');
}

/*
 * "Run this task" (web/app/runQueued.tsx): what "this one and the ones after it" takes, and what the
 * panel says about the rest. Never a task that has already run; a chain's task that did not succeed is
 * named, before the one started and between it and the last queued one after it.
 */
console.log('\n--- what "Run this task" takes ---');
{
  const task = (id: string, status: string) => ({ id, title: id, status });
  const chain = { onFailure: 'stop' as const, tasks: [task('t1', 'done'), task('t2', 'queued'), task('t3', 'failed'), task('t4', 'queued'), task('t5', 'done')] };
  const s2 = runQueuedSelection(chain, 't2');
  t.check('this and the ones after it: only the queued ones, in order', s2.followingQueued.map((x) => x.id), ['t4']);
  t.check('what already ran after it is left as it is', s2.laterRan.map((x) => x.id), ['t3', 't5']);
  t.check('and what ran before it is not touched', s2.earlierRan.map((x) => x.id), ['t1']);
  t.check('a failed task between it and the last queued one is named', s2.chainGapLater?.id, 't3');
  t.check('nothing before it failed: no earlier gap', s2.chainGap, undefined);
  t.check('a chain says it stops at a failure', s2.chain, true);
  const s4 = runQueuedSelection(chain, 't4');
  t.check('started with an earlier task of the chain not done — here one still waiting — that one is named', s4.chainGap?.id, 't2');
  t.check('and a failed one before it, when it is the first', runQueuedSelection({ ...chain, tasks: chain.tasks.filter((x) => x.id !== 't2') }, 't4').chainGap?.id, 't3');
  t.check('nothing queued after it: no later gap', s4.chainGapLater, undefined);
  const loose = runQueuedSelection({ ...chain, onFailure: 'continue' }, 't2');
  t.check('independent tasks: no chain warnings', [loose.chain, loose.chainGap, loose.chainGapLater], [false, undefined, undefined]);
  t.check('an unknown task takes nothing', runQueuedSelection(chain, 'nope').task, undefined);
}

console.log('\n--- the importer refuses it too ---');
{
  const plan = {
    version: 1,
    sessions: [
      {
        name: 'audit',
        vcs: { enabled: false },
        tasks: [{ title: 'audit the build', prompt: 'Audit the build configuration and write what you find.', readOnly: true, scope: ['audit/'] }],
      },
    ],
  };
  const r = checkPlan(JSON.stringify(plan));
  t.check('not importable', r.ok, false);
  t.truthy('and the message says which to drop', !r.ok && r.issues.some((i) => /readOnly/.test(i.message) && /scope/.test(i.message)), !r.ok && r.issues);
}

t.finish();
