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
import { contractConflicts } from '../src/orchestrator/contract.js';
import { checkPlan } from '../src/plan/schema.js';
import type { Task, TaskReviewCheck } from '../src/session/model.js';
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
} finally {
  await rm(dir, { recursive: true, force: true });
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
