/**
 * Which shell a command is handed to, on machines this one is not.
 *
 * The bug this covers cost a whole run on a second Windows machine: it has Windows PowerShell
 * and `cmd` but no PowerShell 7, the runner spawned `pwsh.exe` anyway, and every step and every
 * post-task check died of `spawn ENOENT` while the same commands worked perfectly through
 * `cmd`. Worse than the failure was the shape of it — the checks failed, so the task spent its
 * retry rounds asking a language model to fix a missing interpreter, and then reported that the
 * work had failed.
 *
 * So the questions here are about resolution and about classification. Is a shell that was
 * asked for by name and is not installed refused with a message that says what is missing and
 * what is here, rather than quietly swapped for an interpreter that reads the same command
 * differently? Does a command that named no shell fall through pwsh, powershell, cmd? Do a task
 * step and a post-task check get the same answer, since they are the two paths that used to
 * disagree? And is a shell that will not start told apart from work that failed, so that it
 * does not cost the task a round it never had?
 *
 * Detection is injected rather than arranged: a machine is described to `inventoryOf` and the
 * whole runner then believes it, which is the only way to reason about a machine without
 * PowerShell 7 from one that has it. Only the ENOENT case really spawns anything, and it spawns
 * a path that is deliberately not there, because the classification of ENOENT is the thing
 * under test.
 *
 *   npm run check:shells
 */
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  availableShells,
  detectShells,
  effectiveShell,
  inventoryOf,
  invocationFor,
  preferredShell,
  refusalForChat,
  resolveShell,
  shellNote,
  type Shell,
} from '../src/exec/shells.js';
import { runStep } from '../src/exec/runner.js';
import { environmentProblemIn, runCheck, type CheckOutcome } from '../src/exec/checks.js';
import type { TaskCheck } from '../src/session/model.js';

let wrong = 0;
const check = (label: string, got: unknown, expected: unknown): void => {
  const ok = got === expected;
  if (!ok) wrong += 1;
  console.log(`${ok ? '  ' : '!!'} ${label.padEnd(46)}:`, got, `(expect ${String(expected)})`);
};

const dir = await mkdtemp(join(tmpdir(), 'cop-shells-'));
const logDir = join(dir, 'logs');
await mkdir(logDir, { recursive: true });

console.log('--- what this machine actually has ---');
const real = detectShells();
for (const shell of ['pwsh', 'powershell', 'cmd'] as Shell[]) {
  console.log(`  ${shell.padEnd(11)}: ${real.found[shell] ?? '(not installed)'}`);
}
console.log('  available  :', availableShells(real).join(', ') || '(none)');

// The real executables, reused so that the pretended machines below can still run something.
const realPath = (shell: Shell): string => real.found[shell] ?? '';
const everything = { pwsh: realPath('pwsh'), powershell: realPath('powershell'), cmd: realPath('cmd') };
const noPwsh = { powershell: realPath('powershell'), cmd: realPath('cmd') };
const onlyCmd = { cmd: realPath('cmd') };

console.log('\n--- a shell named by name, on a machine that has it ---');
const withPwsh = inventoryOf(everything);
const explicit = resolveShell('pwsh', withPwsh);
check('pwsh is allowed to run', explicit.ok, true);
if (explicit.ok) {
  check('as the shell that was asked for', explicit.resolved.shell, 'pwsh');
  check('recorded as asked for, not chosen', explicit.resolved.requested, 'pwsh');
  check('resolved to the executable on disk', explicit.resolved.path, everything.pwsh);
}
// The order says pwsh first, and a named shell still wins over it.
const namedCmd = resolveShell('cmd', withPwsh);
check('cmd asked for is cmd, not the first in the order', namedCmd.ok && namedCmd.resolved.shell, 'cmd');

console.log('\n--- the same name, on a machine that has not got it ---');
const withoutPwsh = inventoryOf(noPwsh);
const refused = resolveShell('pwsh', withoutPwsh);
check('it is refused rather than substituted', refused.ok, false);
if (!refused.ok) {
  console.log('  what it says :', refused.problem.message);
  check('the message names what was asked for', refused.problem.message.includes('pwsh.exe'), true);
  check('it names the alternatives that are here', refused.problem.message.includes('powershell, cmd'), true);
  check('it says what to install', refused.problem.message.includes('winget install Microsoft.PowerShell'), true);
  check('it says nothing was substituted', refused.problem.message.includes('nothing was substituted'), true);
  check('and carries the alternatives as data', refused.problem.available.join(', '), 'powershell, cmd');
  check('with the shell that was wanted', refused.problem.requested, 'pwsh');
}

console.log('\n--- nothing named: the fallback order ---');
check('everything installed → pwsh', resolveShell(undefined, withPwsh).ok && (resolveShell(undefined, withPwsh) as { resolved: { shell: Shell } }).resolved.shell, 'pwsh');
const chosenWithoutPwsh = resolveShell(undefined, withoutPwsh);
check('no pwsh → powershell', chosenWithoutPwsh.ok && chosenWithoutPwsh.resolved.shell, 'powershell');
check('and it is recorded as nobody’s request', chosenWithoutPwsh.ok && chosenWithoutPwsh.resolved.requested, null);
const withOnlyCmd = inventoryOf(onlyCmd);
const chosenOnlyCmd = resolveShell(undefined, withOnlyCmd);
check('only cmd → cmd', chosenOnlyCmd.ok && chosenOnlyCmd.resolved.shell, 'cmd');
const bare = resolveShell(undefined, inventoryOf({}));
check('no shell at all → refused', bare.ok, false);
if (!bare.ok) console.log('  what it says :', bare.problem.message);

console.log('\n--- the configured default is a preference, a named shell is not ---');
check('pwsh is kept when it is here', preferredShell('pwsh', withPwsh), 'pwsh');
check('and falls through when it is not', preferredShell('pwsh', withoutPwsh), 'powershell');
check('all the way to cmd', preferredShell('pwsh', withOnlyCmd), 'cmd');
check('a label never refuses', effectiveShell(undefined, withoutPwsh), 'powershell');
// A named shell keeps its name in a label: it is not going to run in anything else, and the
// refusal that follows is about the shell that was asked for.
check('and does not rename what was asked for', effectiveShell('pwsh', withoutPwsh), 'pwsh');

console.log('\n--- how each shell is invoked, unchanged ---');
const psCall = invocationFor({ requested: 'pwsh', shell: 'pwsh', path: 'P:\\pwsh.exe' }, 'Get-Date');
check('pwsh takes -Command', psCall.args.join(' '), '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command Get-Date');
check('at the executable that was resolved', psCall.file, 'P:\\pwsh.exe');
const cmdCall = invocationFor({ requested: null, shell: 'cmd', path: 'C:\\cmd.exe' }, 'echo hi');
check('cmd takes /d /s /c', cmdCall.args.join(' '), '/d /s /c echo hi');
const scriptCall = invocationFor({ requested: 'powershell', shell: 'powershell', path: 'W:\\powershell.exe' }, 'C:\\a.ps1', ['--one']);
check('a script is run with -File', scriptCall.args.slice(-3).join(' '), '-File C:\\a.ps1 --one');

/*
 * The two paths that used to disagree, run against the same pretended machine.
 *
 * `checks.ts` used to fall back to `pwsh` on its own while the runner hardcoded the executable
 * names, so a step and the check that judged it could be read by different interpreters without
 * anything saying so. Both are run here, for real, on a machine told it has no PowerShell 7.
 */
console.log('\n--- a task step and a post-task check resolve identically ---');
inventoryOf(noPwsh);
const step = await runStep({ id: 1, command: 'echo from-a-step', cwd: dir, logPath: join(logDir, 'step.log') });
const asCheck: TaskCheck = { name: 'a check that names no shell', expect: 'exit-zero', run: 'echo from-a-check', cwd: dir };
const checked = await runCheck(asCheck, 0, { cwd: dir, logDir });
console.log('  the step ran in:', step.shell, '|', step.shellPath);
console.log('  the check ran in:', checked.shell, '|', checked.shellPath);
check('the step fell through to powershell', step.shell, 'powershell');
check('the check agrees on the shell', checked.shell, step.shell);
check('and on the executable', checked.shellPath, step.shellPath);
check('the step ran', step.exitCode, 0);
check('the check passed', checked.passed, true);

// The policy gate is told which shell it is screening for, because the traps it looks for are
// shell-specific; screening for one interpreter and running in another finds nothing.
const screened: Shell[] = [];
await runCheck(asCheck, 0, { cwd: dir, logDir, deny: (_command, shell) => { screened.push(shell); return null; } });
check('the deny gate sees the shell that will run it', screened.join(','), 'powershell');

console.log('\n--- the same, on a machine that has only cmd ---');
inventoryOf(onlyCmd);
const inCmd = await runStep({ id: 2, command: 'echo only-cmd', cwd: dir, logPath: join(logDir, 'cmd.log') });
check('the step ran in cmd', inCmd.shell, 'cmd');
check('and it worked', inCmd.exitCode, 0);
check('with the output kept', inCmd.stdout.trim(), 'only-cmd');

console.log('\n--- a check that names a shell the machine has not got never runs ---');
const named = await runCheck({ name: 'typescript compiles', expect: 'exit-zero', run: 'npx tsc --noEmit', shell: 'pwsh' }, 0, { cwd: dir, logDir });
check('it counts as failed', named.passed, false);
check('it is marked as the machine, not the work', named.environmentProblem !== undefined, true);
check('nothing was started, so there is no exit code', named.exitCode, undefined);
console.log('  what it says :', named.detail);

/*
 * A shell that was there when the run began and will not start now.
 *
 * This one really spawns, at a path that is deliberately not on disk, because what is under
 * test is that `spawn ENOENT` is recognised as the interpreter rather than as the command. It
 * is instant and it needs nothing to be uninstalled.
 */
console.log('\n--- a shell that vanished between detection and use ---');
inventoryOf({ pwsh: join(dir, 'not-installed', 'pwsh.exe'), powershell: realPath('powershell'), cmd: realPath('cmd') });
const vanished = await runStep({ id: 3, shell: 'pwsh', command: 'Get-Date', cwd: dir, logPath: join(logDir, 'gone.log') });
check('the step ends as a spawn error', vanished.outcome, 'spawn-error');
check('and says it was the shell', vanished.shellProblem !== undefined, true);
console.log('  what it says :', vanished.shellProblem?.message);

const enoent = await runCheck({ name: 'the build passes', expect: 'exit-zero', run: 'Get-Date', shell: 'pwsh', cwd: dir }, 0, { cwd: dir, logDir });
check('the check carries the same problem', enoent.environmentProblem !== undefined, true);

/*
 * The rule `gateOnChecks` applies, exercised with the predicate it applies it with.
 *
 * The counter in the gate is what decides whether the failures go back to the chat as "the task
 * is not finished yet" and how many times that may happen. A round that never reached the work
 * must not raise it, or a missing interpreter eats the task's attempts and the task is reported
 * as failed work.
 */
console.log('\n--- a missing shell does not cost the task a round ---');
let checkRounds = 0;
const gate = (outcomes: CheckOutcome[]): 'environment' | 'counted' => {
  if (environmentProblemIn(outcomes)) return 'environment';
  checkRounds += 1;
  return 'counted';
};
check('a round that died of the shell', gate([enoent]), 'environment');
check('leaves the counter alone', checkRounds, 0);
check('and it is reported once for all of them', gate([enoent, named, enoent]), 'environment');
check('still leaving the counter alone', checkRounds, 0);

inventoryOf(everything);
const ordinary = await runCheck({ name: 'a command that fails', expect: 'exit-zero', run: 'exit /b 3', shell: 'cmd', cwd: dir }, 0, { cwd: dir, logDir });
check('an ordinary failure is not the machine', environmentProblemIn([ordinary]), null);
check('so it counts as a round', gate([ordinary]), 'counted');
check('and the counter moves', checkRounds, 1);

/*
 * The other ENOENT, which is not the shell at all.
 *
 * Windows raises ENOENT for a working directory that does not exist, and Node writes the
 * *executable's* name into the message while doing it — `spawn cmd.exe ENOENT` for a folder that
 * was simply never created. Classified as a missing interpreter, that would close a task with a
 * sentence about PowerShell not being installed, and close it silently, since an environment
 * fault is never sent back to the chat and the chat is the only thing that could have made the
 * folder. A task whose first step creates a directory its second step works in would be dead on
 * a machine with every shell installed.
 */
console.log('\n--- ENOENT from a missing working directory is not a missing shell ---');
inventoryOf(everything);
const noSuchDir = join(dir, 'never-created');
const badCwd = await runStep({ id: 4, shell: 'cmd', command: 'echo hi', cwd: noSuchDir, logPath: join(logDir, 'badcwd.log') });
check('the step still fails', badCwd.outcome, 'spawn-error');
check('but not because of the shell', badCwd.shellProblem, undefined);
check('so the gate sees work, not the machine', badCwd.shellProblem === undefined, true);
const badCwdCheck = await runCheck({ name: 'the api builds', expect: 'exit-zero', run: 'echo hi', shell: 'cmd', cwd: noSuchDir }, 0, { cwd: dir, logDir });
check('a check with a missing cwd is work, not the machine', badCwdCheck.environmentProblem, undefined);
check('and it counts as a round', gate([badCwdCheck]), 'counted');

/*
 * The standing default reaches a check, not only a step.
 *
 * `execution.defaultShell` is honoured for steps by the parser. A check used to work it out for
 * itself and got the first shell the machine had, so a default of `cmd` on a machine that also
 * has PowerShell 7 meant a step ran in `cmd` while the check judging it ran in `pwsh` — a gate
 * answering a question nobody asked.
 */
console.log('\n--- a check that names no shell takes the run\'s default, like a step does ---');
inventoryOf({ pwsh: realPath('pwsh') ?? realPath('powershell') ?? realPath('cmd') ?? '', powershell: realPath('powershell'), cmd: realPath('cmd') });
const withDefault = await runCheck({ name: 'says which shell', expect: 'exit-zero', run: 'echo one' }, 0, { cwd: dir, logDir, defaultShell: 'cmd' });
check('the check took the configured default', withDefault.shell, 'cmd');
const withoutDefault = await runCheck({ name: 'says which shell', expect: 'exit-zero', run: 'echo one' }, 0, { cwd: dir, logDir });
check('and without one, the first shell there is', withoutDefault.shell, availableShells()[0]);
const checkNames = await runCheck({ name: 'says which shell', expect: 'exit-zero', run: 'echo one', shell: 'powershell' }, 0, { cwd: dir, logDir, defaultShell: 'cmd' });
check('a check that names one still wins', checkNames.shell, 'powershell');

/*
 * What the chat is told before it writes its first step.
 *
 * The contract shows `"shell": "pwsh"` in its worked example, so a model writing to that example
 * names `pwsh` — and on the machine this whole change exists for, that step is refused. Refusing
 * it and saying nothing would cost a round of the conversation on every task. Saying it up front
 * costs a paragraph, and only on the machines where it is true.
 */
console.log('\n--- what the chat is told about this machine ---');
check('a machine with pwsh is told nothing', shellNote(inventoryOf(everything)), undefined);
const note = shellNote(inventoryOf({ powershell: realPath('powershell') ?? 'x', cmd: realPath('cmd') ?? 'y' }), 'powershell') ?? '';
check('a machine without it is told so', note.includes('is not installed here'), true);
check('and told what to write instead', note.includes('"shell": "powershell"'), true);
check('and never told to write pwsh', /write `"shell": "pwsh"`/.test(note), false);
const onlyCmdNote = shellNote(inventoryOf({ cmd: realPath('cmd') ?? 'y' })) ?? '';
check('a cmd-only machine is warned about cmdlets', onlyCmdNote.includes('rather than for PowerShell'), true);

/*
 * The same refusal has two readers, and they cannot be told the same thing.
 *
 * A check's shell is the operator's, written in a plan the chat cannot edit, so the refusal is
 * addressed to them and says what to install or configure. A step's shell is the chat's own, and
 * telling *it* to install PowerShell 7 is the mistake this runner already knows the shape of: it
 * tries, fails the same way, and spends the round. So the step's refusal says only the half it
 * can act on.
 */
console.log('\n--- the refusal says different things to the operator and to the chat ---');
const refusedPwsh = resolveShell('pwsh', inventoryOf({ powershell: 'C:\ps.exe', cmd: 'C:\cmd.exe' }));
if (refusedPwsh.ok) throw new Error('pwsh should have been refused on a machine without it');
const forOperator = refusedPwsh.problem.message;
const forChat = refusalForChat(refusedPwsh.problem, 'powershell');
check('the operator is told what to install', forOperator.includes('winget install'), true);
check('the chat is told not to ask for that', forChat.includes('nothing in this conversation can install it'), true);
check('and never told to install it', forChat.includes('winget'), false);
check('the chat is told what to write instead', forChat.includes('"shell": "powershell"'), true);
check('naming the shell it would get anyway', forChat.includes('the runner uses `powershell`'), true);
// The message must name the shell that leaving `shell` out really produces, which is the run's
// default and not always the first shell on the machine: offering the two as equivalent when they
// are not is how a PowerShell command ends up being read by cmd.
const configuredCmd = refusalForChat(refusedPwsh.problem, 'cmd');
check('and it follows the run default, not the order', configuredCmd.includes('"shell": "cmd"'), true);
const nothingHere = resolveShell('pwsh', inventoryOf({}));
check('a machine with no shell is told to stop', nothingHere.ok ? '' : refusalForChat(nothingHere.problem, undefined).includes('end the task with status "blocked"'), true);
check('and is offered no shell to try', nothingHere.ok ? '' : /"shell": "/.test(refusalForChat(nothingHere.problem, undefined)), false);

// The real machine again, so nothing after this test believes the pretended ones.
const restored = detectShells({ fresh: true });
check('the real inventory is back', availableShells(restored).join(', '), availableShells(real).join(', '));

await rm(dir, { recursive: true, force: true });

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
