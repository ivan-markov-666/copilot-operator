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
import type { TaskCheck } from '../src/session/model.js';

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

await rm(dir, { recursive: true, force: true });
