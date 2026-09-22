/**
 * The allowlist gate: a command may start only the programs the project has declared, and must
 * never mistake a PowerShell cmdlet, an alias or a keyword for a program and refuse honest work.
 *
 * Two failure modes are tested on purpose. The one the gate exists for — an external program that
 * is not on the list is refused — and the one that would make it unusable — a real build or test
 * command, cmdlets and pipes and all, must pass untouched. The second set is drawn from the shapes
 * the runner has actually produced in its own runs, because a gate that breaks the working bot is a
 * gate that gets switched off. The default list is read from the config schema, so this pins the
 * shipped default, not a copy of it.
 */
import { commandHeads, externalProgram, inlineCodeRefusal, programRefusal } from '../src/exec/programs.js';
import { commandRefusal, staticCheck } from '../src/exec/policy.js';
import { RunConfigSchema } from '../src/config/schema.js';
import type { Step } from '../src/protocol/replySchema.js';

const ALLOWED = RunConfigSchema.parse({}).execution.allowedPrograms;

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

console.log('--- the default list is not empty (the gate is on) ---');
check('default allowedPrograms has entries', ALLOWED.length > 0, true);
check('node is on it', ALLOWED.includes('node'), true);
check('git is on it', ALLOWED.includes('git'), true);

console.log('\n--- a statement head is classified correctly ---');
check('node is an external program', externalProgram('node'), 'node');
check('a full path keeps only the stem', externalProgram('C:\\tools\\Foo.EXE'), 'foo');
check('a project-relative script is a program', externalProgram('.\\build.ps1'), 'build');
check('a cmdlet is not a program', externalProgram('Get-ChildItem'), null);
check('an alias is not a program', externalProgram('ls'), null);
check('a keyword is not a program', externalProgram('if'), null);
check('a variable is not a program', externalProgram('$env:PATH'), null);
check('a non-executable file is not a program', externalProgram('tsconfig.json'), null);

console.log('\n--- heads are found across separators ---');
check('a pipeline of cmdlets yields only cmdlets', commandHeads('Get-Service wuauserv | Format-List Name,Status').every((h) => externalProgram(h) === null), true);
check('&& yields both heads', JSON.stringify(commandHeads('npm ci && npm test')), JSON.stringify(['npm', 'npm']));
check('a hidden second command is still a head', commandHeads('npm ci ; nmap -sS 10.0.0.0/24').includes('nmap'), true);

console.log('\n--- real build and test commands pass (no false positives) ---');
for (const cmd of [
  'npm ci',
  'npm run build',
  'npx playwright test --project=api',
  'node dist/main.js',
  'git status --porcelain',
  'dotnet test',
  'tsc -p tsconfig.json --noEmit',
  'python -m pytest -q',
  'Get-ChildItem -Recurse | Where-Object { $_.Name -like "*.ts" } | Measure-Object',
  'if (Test-Path .\\dist) { Remove-Item .\\dist -Recurse -Force }',
  'Set-Content -Path out.txt -Value "done"',
  'cmd /c "echo hello"',
]) {
  check(`passes: ${cmd}`, programRefusal(cmd, ALLOWED), null);
}

console.log('\n--- an off-list program is refused ---');
for (const cmd of ['nmap -sS 10.0.0.0/24', 'mimikatz.exe', 'C:\\Temp\\foo.exe', 'npm ci && nmap x']) {
  const r = programRefusal(cmd, ALLOWED);
  check(`refuses: ${cmd}`, r !== null && r.includes('allowedPrograms'), true);
}

console.log('\n--- an empty list turns the gate off ---');
check('empty list allows anything', programRefusal('nmap -sS x', []), null);

console.log('\n--- it sits on top of dangerous.ts, which wins ---');
const cu = commandRefusal('certutil -decode a.b64 a.js', 'pwsh', [], ALLOWED);
check('certutil is refused', cu !== null, true);
check('by the dangerous floor, not the allowlist', cu !== null && !cu.includes('allowedPrograms'), true);
check('an allowed command with no bad technique passes commandRefusal', commandRefusal('npm run build', 'pwsh', [], ALLOWED), null);

console.log('\n--- graded autonomy: inline evaluation and nested shells ---');
for (const cmd of [
  'node -e "console.log(1)"',
  'node --experimental-vm-modules -e "x"',
  'python -c "import os"',
  'pwsh -NoProfile -Command "Get-Date"',
  'cmd /c "echo hello"',
  'cmd /s /c "echo hello"',
  'deno eval "1+1"',
]) {
  check(`evaluates inline: ${cmd}`, inlineCodeRefusal(cmd) !== null, true);
}
for (const cmd of [
  'node server.js -p 3000',
  'node dist/main.js',
  'npm run build',
  'git -c user.email=a@b.c commit -m x',
  'python -m pytest -q',
  'npx tsc -p tsconfig.json',
  'dotnet test',
]) {
  check(`is ordinary work: ${cmd}`, inlineCodeRefusal(cmd), null);
}

console.log('\n--- the rules apply only where nobody is watching ---');
const base = { denyPatterns: [] as string[], allowedPrograms: ALLOWED };
const watched = { ...base, mode: 'confirm' as const };
// An unattended policy must declare its isolation before any of these rules are reached at all —
// see `isolation.ts`. These cases are about what an unattended run refuses *once* it is allowed to
// start, so they say where they are running.
const unwatched = { ...base, mode: 'unattended' as const, isolation: 'separate-account' as const };
const evalStep: Step = { id: 1, type: 'command', shell: 'pwsh', cmd: 'node -e "console.log(1)"' };
const plainStep: Step = { id: 2, type: 'command', shell: 'pwsh', cmd: 'npm run build' };

check('confirm allows inline evaluation (a person reads it)', staticCheck(evalStep, watched), null);
check('unattended refuses it', staticCheck(evalStep, unwatched)?.action, 'skip');
check('unattended still runs ordinary work', staticCheck(plainStep, unwatched), null);
check('confirm runs ordinary work', staticCheck(plainStep, watched), null);

console.log('\n--- unattended with no allowlist is refused outright ---');
const noList = { ...base, allowedPrograms: [] as string[], mode: 'unattended' as const, isolation: 'separate-account' as const };
const decision = staticCheck(plainStep, noList);
check('an unattended run needs a list', decision?.action, 'skip');
check('and says why', decision?.action === 'skip' && decision.reason.includes('allowedPrograms'), true);
check('confirm with no list is unaffected', staticCheck(plainStep, { ...base, allowedPrograms: [], mode: 'confirm' as const }), null);

console.log('\n--- but isolation is asked first of all ---');
// Ordering matters for the message somebody reads: "you have not said where this runs" is the
// useful answer, not "your allowlist is empty", when both are true.
const nowhere = staticCheck(plainStep, { ...base, allowedPrograms: [], mode: 'unattended' as const });
check('unattended with no isolation is refused', nowhere?.action, 'skip');
check('and the reason is the isolation, not the list', nowhere?.action === 'skip' && nowhere.reason.includes('needs somewhere to run'), true);

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
