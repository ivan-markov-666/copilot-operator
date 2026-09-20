/**
 * The gate that decides whether a task is really finished.
 *
 * The questions here are the ones the feature exists for. Does each kind of check actually
 * decide what it claims to? Does a check that cannot be evaluated fail rather than pass — a
 * gate that opens when it breaks is worse than no gate. And does a failure produce something
 * worth sending back to the chat: what was asked, what happened, and the output to act on.
 *
 * Commands run through `cmd`, which is on every Windows machine, so the check engine is what
 * is being tested rather than whether a particular shell happens to be installed.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCheck, runChecks, failureMessage, failureReport, describeCheck } from '../src/exec/checks.js';
import { validateDerivedChecks, suspendDisputed, settleAfterReview, onlyDerivedFailing, derivedCheckName } from '../src/orchestrator/derivedChecks.js';
import type { TaskCheck, TaskReviewCheck } from '../src/session/model.js';

const dir = await mkdtemp(join(tmpdir(), 'cop-checks-'));
const logDir = join(dir, 'logs');
await mkdir(logDir, { recursive: true });
await writeFile(join(dir, 'report.txt'), 'total: 2\nREADME.md\nnotes.txt\n', 'utf8');

const opts = { cwd: dir, logDir };
const cmd = (run: string): Partial<TaskCheck> => ({ run, shell: 'cmd' as const, cwd: dir });

console.log('--- one of each kind, against a machine that can answer ---');
const cases: Array<[TaskCheck, boolean]> = [
  [{ name: 'a command that succeeds', expect: 'exit-zero', ...cmd('echo fine') }, true],
  [{ name: 'a command that fails', expect: 'exit-zero', ...cmd('exit /b 3') }, false],
  [{ name: 'a failure that was wanted', expect: 'exit-nonzero', ...cmd('exit /b 3') }, true],
  [{ name: 'a success where failure was wanted', expect: 'exit-nonzero', ...cmd('echo fine') }, false],
  [{ name: 'output contains it', expect: 'output-contains', value: 'hello', ...cmd('echo hello world') }, true],
  [{ name: 'output does not contain it', expect: 'output-contains', value: 'missing', ...cmd('echo hello world') }, false],
  [{ name: 'output omits it', expect: 'output-omits', value: 'node_modules', ...cmd('echo src/app.ts') }, true],
  [{ name: 'output should have omitted it', expect: 'output-omits', value: 'node_modules', ...cmd('echo node_modules/x') }, false],
  [{ name: 'output matches a pattern', expect: 'output-matches', value: '^total: [0-9]+$', ...cmd('echo total: 2') }, true],
  [{ name: 'output does not match', expect: 'output-matches', value: '^total: [0-9]+$', ...cmd('echo nothing') }, false],
  [{ name: 'the file is there', expect: 'file-exists', file: join(dir, 'report.txt') }, true],
  [{ name: 'the file is not there', expect: 'file-exists', file: join(dir, 'nope.txt') }, false],
  [{ name: 'the file is absent, as wanted', expect: 'file-missing', file: join(dir, 'nope.txt') }, true],
  [{ name: 'the file should have been absent', expect: 'file-missing', file: join(dir, 'report.txt') }, false],
  [{ name: 'the file says it', expect: 'file-contains', file: join(dir, 'report.txt'), value: 'total: 2' }, true],
  [{ name: 'the file does not say it', expect: 'file-contains', file: join(dir, 'report.txt'), value: 'total: 9' }, false],
];

let wrong = 0;
for (const [check, shouldPass] of cases) {
  const outcome = await runCheck(check, 0, opts);
  const ok = outcome.passed === shouldPass;
  if (!ok) wrong += 1;
  console.log(
    `${ok ? '  ' : '!!'} ${check.name.padEnd(34)} ${outcome.passed ? 'passed' : 'failed'} (expected ${shouldPass ? 'passed' : 'failed'})`,
    `\n      ${outcome.detail}`,
  );
}
console.log('\nwrong verdicts:', wrong, '(expect 0)');

console.log('\n--- a check that cannot be evaluated fails, it does not pass ---');
const broken: TaskCheck[] = [
  { name: 'no command given', expect: 'exit-zero' },
  { name: 'no file given', expect: 'file-exists' },
  { name: 'a pattern that is not one', expect: 'output-matches', value: '([unclosed', ...cmd('echo x') },
];
for (const check of broken) {
  const outcome = await runCheck(check, 0, opts);
  console.log(`  ${check.name.padEnd(26)} ${outcome.passed ? 'PASSED (wrong)' : 'failed'} — ${outcome.detail}`);
}

console.log('\n--- the deny list applies to checks, the same as to steps ---');
const denied = await runCheck({ name: 'something destructive', expect: 'exit-zero', ...cmd('rmdir /s /q C:\\') }, 0, {
  ...opts,
  deny: (command) => (command.includes('rmdir') ? 'matches the deny pattern "rmdir"' : null),
});
console.log('  refused before running:', !denied.passed, '—', denied.detail);

console.log('\n--- what the chat is told when checks fail ---');
const outcomes = await runChecks(
  [
    { name: 'typescript compiles', expect: 'exit-zero', ...cmd('exit /b 2') },
    { name: 'the report exists', expect: 'file-exists', file: join(dir, 'report.txt') },
    { name: 'the endpoint is registered', expect: 'output-contains', value: 'CalculatorController', ...cmd('echo nothing here') },
  ] as TaskCheck[],
  opts,
);
console.log('passed:', outcomes.filter((o) => o.passed).length, '| failed:', outcomes.filter((o) => !o.passed).length);

const message = failureMessage(outcomes, 1, 3);
console.log('\nmessage sent to the chat:');
console.log(message.split('\n').slice(0, 14).join('\n'));
console.log('  …');
console.log('says it is not over    :', message.includes('not finished yet'));
console.log('names the failed checks:', message.includes('typescript compiles') && message.includes('the endpoint is registered'));
console.log('names the passed one   :', message.includes('the report exists'));
console.log('says which attempt     :', message.includes('attempt 1 of 3'));

const report = failureReport(outcomes);
console.log('\nthe attached file carries the output:', report.includes('EXIT  : 2'), '|', report.includes('CHECKS THAT PASSED'));

console.log('\n--- one line per check, for the log and the card ---');
for (const [check] of cases.slice(0, 3)) console.log(' ', describeCheck(check));

/*
 * A review finding's check, and the three rules that keep it from becoming a wall.
 *
 * The same missing @HttpCode(200) was found by one reviewer and missed by the next; a check
 * given with the finding would have made it arithmetic. Kept only if it fails on the work as
 * it stands; suspended by a dispute until the next review rules; never the reason a task ends
 * on its own.
 */
console.log('\n--- a check given with a finding is kept only if it fails now ---');
const findingWithBadCheck = { id: 'r1f1', what: 'x', evidence: 'y', where: 'z', about: 'work' as const, check: { name: 'always fine', expect: 'exit-zero' as const, run: 'echo fine', shell: 'cmd' as const, cwd: dir } };
const findingWithGoodCheck = { id: 'r1f2', what: 'the build fails', evidence: 'y', where: 'api/src', about: 'work' as const, check: { name: 'the build passes', expect: 'exit-zero' as const, run: 'exit /b 3', shell: 'cmd' as const, cwd: dir } };
const findingWithout = { id: 'r1f3', what: 'no check given', evidence: 'y', where: 'w', about: 'work' as const };
const validated = await validateDerivedChecks([findingWithBadCheck, findingWithGoodCheck, findingWithout], { cwd: dir, logDir });
console.log('kept (fails now)          :', validated.kept.map((k) => k.finding.id).join(', '), '(expect r1f2)');
console.log('refused (passes now)      :', validated.refused.map((r) => r.finding.id).join(', '), '(expect r1f1)');
console.log('named so it cannot clash  :', validated.kept[0]?.check.name, '(expect', JSON.stringify(derivedCheckName('r1f2', 'the build passes')) + ')');

console.log('\n--- a dispute suspends it; the next review decides ---');
const kept: TaskReviewCheck[] = validated.kept.map((k) => ({ check: k.check, findingId: k.finding.id, what: k.finding.what, where: k.finding.where, round: 1, attempt: 1, state: 'active' }));
const paused = suspendDisputed(kept, ['R1F2', 'r9f9']);
console.log('suspended by id           :', paused.suspended.join(', '), '| state:', paused.checks[0].state, '(expect r1f2 | suspended)');
const raisedAgain = settleAfterReview(paused.checks, 'fail', [{ what: 'the build still fails', evidence: 'e', where: 'api/src' }]);
console.log('raised again → active     :', raisedAgain.reactivated.join(', '), raisedAgain.checks[0].state, '(expect r1f2 active)');
const notRaised = settleAfterReview(paused.checks, 'fail', [{ what: 'something else', evidence: 'e', where: 'web/app' }]);
console.log('not raised → dropped      :', notRaised.dropped.join(', '), notRaised.checks[0].state, '(expect r1f2 dropped)');
const passed = settleAfterReview(paused.checks, 'pass', []);
console.log('review passed → dropped   :', passed.dropped.join(', '), '(expect r1f2)');

console.log('\n--- only derived checks failing is not a failed task ---');
const derivedFail = { check: kept[0].check, passed: false, detail: 'd' };
const planFail = { check: cases[0][0], passed: false, detail: 'd' };
const planPass = { check: cases[0][0], passed: true, detail: 'd' };
console.log('derived only              :', onlyDerivedFailing([derivedFail, planPass]), '(expect true — goes to the reviewer)');
console.log('a plan check too          :', onlyDerivedFailing([derivedFail, planFail]), '(expect false — the task fails)');
console.log('nothing failing           :', onlyDerivedFailing([planPass]), '(expect false)');

await rm(dir, { recursive: true, force: true });
