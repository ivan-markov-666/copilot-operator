/**
 * The administrator's policy lock: it may tighten, and it may never loosen.
 *
 * Every property here is one a deployment would rely on. The one worth naming is the empty-list
 * case: `allowedPrograms: []` means "no allowlist at all", which is the loosest setting the
 * configuration has, so an operator clearing that field must not thereby escape a lock that
 * defines one. A ceiling that can be stepped over by deleting a line is not a ceiling.
 */
import { applyPolicyLock, PolicyLockSchema, type LockablePolicy } from '../src/config/lockedPolicy.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const operator: LockablePolicy = {
  mode: 'unattended',
  allowedPrograms: ['node', 'npm', 'git', 'nmap'],
  denyPatterns: ['local-one'],
};

console.log('--- no lock changes nothing ---');
const none = applyPolicyLock(operator, null);
check('not applied', none.outcome.applied, false);
check('the policy is untouched', JSON.stringify(none.policy), JSON.stringify(operator));

console.log('\n--- a lock forbids unattended ---');
const confirmed = applyPolicyLock(operator, { maxMode: 'confirm' });
check('mode forced to confirm', confirmed.policy.mode, 'confirm');
check('and it is reported', confirmed.outcome.changes.some((c) => c.includes('confirm')), true);
check('a lock that permits unattended leaves it', applyPolicyLock(operator, { maxMode: 'unattended' }).policy.mode, 'unattended');

console.log('\n--- the allowlist is a ceiling, never a grant ---');
const narrowed = applyPolicyLock(operator, { allowedPrograms: ['node', 'npm', 'git'] });
check('an off-ceiling program is dropped', narrowed.policy.allowedPrograms.includes('nmap'), false);
check('the rest survive', narrowed.policy.allowedPrograms.length, 3);
const widened = applyPolicyLock({ ...operator, allowedPrograms: ['node'] }, { allowedPrograms: ['node', 'npm', 'git'] });
check('a lock cannot grant what the operator did not allow', widened.policy.allowedPrograms.length, 1);

console.log('\n--- clearing the list does not escape the lock ---');
const emptied = applyPolicyLock({ ...operator, allowedPrograms: [] }, { allowedPrograms: ['node', 'npm'] });
check('the lock list is used instead of "off"', emptied.policy.allowedPrograms.length, 2);
check('so the gate stays enforced', emptied.policy.allowedPrograms.length > 0, true);
check('and it is reported', emptied.outcome.changes.some((c) => c.includes('switched off locally')), true);

console.log('\n--- deny patterns are a floor, merged in ---');
const merged = applyPolicyLock(operator, { denyPatterns: ['locked-one', 'local-one'] });
check('the lock pattern is added', merged.policy.denyPatterns.includes('locked-one'), true);
check('the local one is kept', merged.policy.denyPatterns.includes('local-one'), true);
check('and not duplicated', merged.policy.denyPatterns.filter((p) => p === 'local-one').length, 1);


console.log('\n--- a malformed lock is rejected, not ignored ---');
check('an unknown key is refused', PolicyLockSchema.safeParse({ allowEverything: true }).success, false);
check('a wrong type is refused', PolicyLockSchema.safeParse({ maxMode: 'whenever' }).success, false);
check('an empty lock is valid', PolicyLockSchema.safeParse({}).success, true);

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
