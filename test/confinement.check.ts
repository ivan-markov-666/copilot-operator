/**
 * The project and nothing else.
 *
 * Before this rule, eighteen operations reaching outside the project were probed against the gate
 * and fourteen of them ran — every cmdlet, every path, the registry, services, a user account —
 * because nothing in the runner knew what "the project" was. The cases below are those eighteen and
 * more, and they are pinned in both directions: what reaches outside is refused, and the ordinary
 * work of a build or a test suite — including the things that merely look like paths, a regex's
 * `\d`, `HEAD~1`, a URL, `$env:PATH` — goes through untouched, because a gate that stops honest
 * work is a gate that gets switched off.
 *
 * Then the places the rule has to reach and nearly did not: a check's own working folder, the file
 * a file check reads (which used to be resolved against the runner's own checkout), and a derived
 * check the gate refuses — which reports as a failure, and so would have been *kept* by the rule
 * "keep a derived check only if it fails now", and then failed the task for ever.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { confinementRefusal, isWithin, projectRoots } from '../src/exec/confinement.js';
import { staticCheck } from '../src/exec/policy.js';
import { runCheck } from '../src/exec/checks.js';
import { validateDerivedChecks } from '../src/orchestrator/derivedChecks.js';
import { RunConfigSchema } from '../src/config/schema.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const c = {
  roots: [String.raw`C:\Projects\rules-tests`, String.raw`C:\Projects\rules-api`, String.raw`C:\My Projects\calc`],
  cwd: String.raw`C:\Projects\rules-tests`,
};

console.log('--- a root is a folder, not a prefix ---');
check('the root itself', isWithin(String.raw`C:\Projects\rules-api`, c.roots), true);
check('inside it', isWithin(String.raw`C:\Projects\rules-api\src\x.ts`, c.roots), true);
check('case does not matter on Windows', isWithin(String.raw`c:\projects\RULES-API\x`, c.roots), true);
check('a folder that merely starts the same is outside', isWithin(String.raw`C:\Projects\rules-api-evil\x`, c.roots), false);
check('the parent is outside', isWithin(String.raw`C:\Projects`, c.roots), false);
check('roots are de-duplicated', projectRoots([String.raw`C:\a`, 'c:\\A\\', '', undefined]).length, 1);

console.log('\n--- ordinary work goes through ---');
for (const cmd of [
  String.raw`Get-ChildItem .\src -Recurse`,
  'npm ci; npm install -D vitest',
  'npm test',
  String.raw`Get-Content C:\Projects\rules-tests\package.json`,
  String.raw`npm --prefix ..\rules-api start`,
  String.raw`Get-Content "C:\My Projects\calc\README.md"`,
  String.raw`$env:PATH = "$PWD\node_modules\.bin;$env:PATH"; npx tsc`,
  'Invoke-WebRequest http://localhost:4400/api/health',
  String.raw`Select-String -Path .\log.txt -Pattern '\d+ errors'`,
  'git log HEAD~1 --oneline',
  'Test-NetConnection localhost -Port 4400',
  'taskkill /PID 1234 /T /F',
  String.raw`python -m venv .venv; .venv\Scripts\python -m pip install -r requirements.txt`,
  String.raw`npx playwright test --config=C:\Projects\rules-tests\playwright.config.ts`,
  // the worked examples level 1 now teaches, which have to obey the rule they sit beside
  String.raw`Get-Content .\package.json`,
  String.raw`Set-Content -Path .\count-tests.ps1 -Value 'x'; pwsh -File .\count-tests.ps1`,
]) {
  check(`runs: ${cmd}`, confinementRefusal(cmd, c), null);
}

console.log('\n--- what reaches outside is refused ---');
for (const cmd of [
  String.raw`Get-Content C:\Users\test657\.ssh\id_rsa`,
  String.raw`Get-Content $env:USERPROFILE\.ssh\id_rsa`,
  String.raw`Get-Content ~\.gitconfig`,
  'Get-ChildItem $HOME',
  String.raw`Set-Content $env:APPDATA\x.txt 'hi'`,
  "Set-Content ${env:LOCALAPPDATA}\\x.txt 'hi'",
  String.raw`type %TEMP%\x.log`,
  String.raw`Remove-Item C:\Windows\Temp\x.log`,
  String.raw`Get-Content ..\..\secrets.txt`,
  String.raw`Set-Location C:\; Get-ChildItem`,
  'cd \\',
  String.raw`Get-Content C:\Projects\rules-tests-evil\x`,
  String.raw`cmd /c "copy C:\Projects\rules-tests\a C:\Windows\b"`,
  String.raw`Get-Content -LiteralPath:C:\Windows\win.ini`,
  'Invoke-WebRequest file:///C:/Users/test657/.ssh/id_rsa',
  String.raw`Get-ChildItem \\fileserver\share`,
  String.raw`Set-ItemProperty HKCU:\Software\X -Name A -Value 1`,
  String.raw`Get-ItemProperty HKLM:\Software\Microsoft`,
  'Stop-Service -Name Spooler',
  'Get-Service -Name wuauserv',
  'New-NetFirewallRule -DisplayName x -Action Allow',
  'New-LocalUser -Name x -NoPassword',
  'Set-TimeZone -Id UTC',
  'Enable-WindowsOptionalFeature -Online -FeatureName x',
  'Install-Module Pester -Scope CurrentUser',
  'Get-Disk',
  'npm install -g some-tool',
  'npm i --global some-tool',
  'pnpm add -g x',
  'yarn global add x',
  'dotnet tool install --global dotnet-ef',
  'cargo install ripgrep',
  'go install golang.org/x/tools/gopls@latest',
  'pip install requests',
  'python -m pip install requests',
  String.raw`.venv\Scripts\pip install --user requests`,
]) {
  check(`refused: ${cmd}`, confinementRefusal(cmd, c) !== null, true);
}

console.log('\n--- the refusal says where the project is and what to do ---');
const said = confinementRefusal(String.raw`Get-Content C:\Users\x\.ssh\id_rsa`, c) ?? '';
check('names the project folders', said.includes(String.raw`C:\Projects\rules-tests`), true);
check('tells the model to stop and ask rather than reach', said.includes('`blocked`'), true);
check('an install says how to do it in the project', (confinementRefusal('npm install -g x', c) ?? '').includes('npm install -D'), true);
check('pip says to make a .venv', (confinementRefusal('pip install x', c) ?? '').includes('.venv'), true);

console.log('\n--- it is part of the one gate, and only when there is a project ---');
const e = RunConfigSchema.parse({}).execution;
const policy = { mode: 'confirm' as const, denyPatterns: e.denyPatterns, allowedPrograms: e.allowedPrograms };
const outsideStep = { id: 1, type: 'command' as const, shell: 'pwsh' as const, cmd: String.raw`Get-Content C:\Users\x\.ssh\id_rsa` };
check('a step reaching outside is refused', staticCheck(outsideStep, policy, undefined, c)?.action, 'skip');
check('the same step with no project given is not judged on it', staticCheck(outsideStep, policy), null);
check('ordinary work passes the whole gate', staticCheck({ ...outsideStep, cmd: 'npm test' }, policy, undefined, c), null);

console.log('\n--- checks: their folder and their file are held to it too ---');
const dir = await mkdtemp(join(tmpdir(), 'cop-confine-'));
try {
  const root = join(dir, 'project');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.txt'), 'hello', 'utf8');
  await writeFile(join(dir, 'secret.txt'), 'the key', 'utf8');
  const opts = { cwd: root, logDir: join(dir, 'logs'), roots: [root] };

  const relative = await runCheck({ name: 'rel', expect: 'file-contains', file: String.raw`src\a.txt`, value: 'hello' }, 0, opts);
  check('a relative file is read from the project, not from the runner', relative.passed, true);

  const leak = await runCheck({ name: 'leak', expect: 'file-contains', file: join(dir, 'secret.txt'), value: 'x' }, 1, opts);
  check('a file outside is refused', leak.passed, false);
  check('before it is read', leak.refusedBeforeRunning, true);
  check('and nothing of it reaches the report', (leak.output ?? '').includes('the key'), false);

  const climb = await runCheck({ name: 'climb', expect: 'file-exists', file: String.raw`..\secret.txt` }, 2, opts);
  check('climbing out by .. is refused', climb.refusedBeforeRunning, true);

  const where = await runCheck({ name: 'where', expect: 'exit-zero', run: 'echo hi', cwd: dir }, 3, opts);
  check('a check whose own folder is outside is refused', where.refusedBeforeRunning, true);

  console.log('\n--- a derived check the gate refuses is dropped, not kept ---');
  const finding = {
    id: 'r1f1',
    what: 'the key is exposed',
    where: 'secret.txt',
    basis: 'task',
    check: { name: 'reads the key', expect: 'file-contains' as const, file: join(dir, 'secret.txt'), value: 'nope' },
  };
  const v = await validateDerivedChecks([finding as never], { ...opts, deny: () => null });
  check('it is not kept, although a refusal reads as a failure', v.kept.length, 0);
  check('it is not counted as passing either', v.refused.length, 0);
  check('it is blocked', v.blocked.length, 1);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
