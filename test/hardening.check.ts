/**
 * The 2026-09-27 hardening round: what a security review of the bot's own behaviour found, each
 * item held here so it stays fixed.
 *
 * Three reviews were run against the code — what endpoint tooling on a company laptop would see,
 * which paths execute code without its text passing the gate, and the local API and what leaves
 * the machine. This file holds the mechanical answers: the environment a step is given, the paths
 * a step may not reach, the scripts it runs being read, the lock's mode ceiling, the store's file
 * names, the redaction shapes, and the runner's own git not running what a task placed in the
 * repository.
 *
 *   npm run check:hardening
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stepEnvironment } from '../src/exec/stepEnv.js';
import { checkCommandRefusal, commandRefusal, repositoryInternalsRefusal, unattendedPrecondition } from '../src/exec/policy.js';
import { botSelfRefusal, networkFetchReason } from '../src/exec/network.js';
import { inlineCodeRefusal, startProcessTargets } from '../src/exec/programs.js';
import { redactSecrets } from '../src/exec/redaction.js';
import { safeName, safePresetName } from '../src/session/store.js';
import { invocationFor, resolveShell } from '../src/exec/shells.js';
import { git } from '../src/vcs/git.js';
import { applyPolicyLock } from '../src/config/lockedPolicy.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}
const refused = (r: string | null): boolean => r !== null;

console.log('--- a step is given a named environment, never the bot\'s ---');
{
  const env = stepEnvironment(
    { PATH: 'p', SystemRoot: 'C:\\Windows', NEXT_PUBLIC_COP_TOKEN: 't', COP_API_PORT: '4000', AWS_SECRET_ACCESS_KEY: 's', DATABASE_URL: 'd', PSModulePath: 'm' },
    ['DATABASE_URL', 'COP_API_PORT'],
  );
  check('PATH and SystemRoot pass', [env.PATH, env.SystemRoot], ['p', 'C:\\Windows']);
  check('the API token never passes', 'NEXT_PUBLIC_COP_TOKEN' in env, false);
  check('a COP_* name never passes, even when listed', 'COP_API_PORT' in env, false);
  check('an unlisted secret does not pass', 'AWS_SECRET_ACCESS_KEY' in env, false);
  check('a listed variable passes', env.DATABASE_URL, 'd');
  check('PSModulePath is left out', 'PSModulePath' in env, false);
  check('install scripts are off', [env.npm_config_ignore_scripts, env.YARN_ENABLE_SCRIPTS], ['true', '0']);
}

console.log('\n--- a step may not reach the bot, nor the repository\'s machinery ---');
{
  const allowed = ['pwsh', 'powershell', 'cmd', 'node', 'npm', 'npx', 'git', 'curl'];
  const dir = mkdtempSync(join(tmpdir(), 'cop-hard-'));
  const conf = { roots: [dir], cwd: dir };
  const gate = (cmd: string): string | null => commandRefusal(cmd, 'pwsh', [], allowed, process.env, conf);
  check('the API port is refused', refused(botSelfRefusal('curl http://127.0.0.1:4000/api/approvals')), true);
  check('the web port is refused', refused(botSelfRefusal('irm http://localhost:3210/')), true);
  check('the key file is refused', refused(botSelfRefusal('Get-Content ..\\data\\api-token')), true);
  check('a server of the task on another port is not', botSelfRefusal('curl http://localhost:3000/health'), null);
  check('writing under .git is refused', refused(repositoryInternalsRefusal("Set-Content .git\\hooks\\post-checkout 'x'")), true);
  check('git config <key> <value> is refused', refused(repositoryInternalsRefusal('git config core.hooksPath .hooks')), true);
  check('reading a setting is not', repositoryInternalsRefusal('git config --get user.name'), null);
  check('.gitignore is not .git', repositoryInternalsRefusal('Get-Content .gitignore'), null);
  check('through the whole gate too', refused(gate('git config core.fsmonitor tool.exe')), true);

  console.log('\n--- what Start-Process starts is a program on the line ---');
  check('the -FilePath target is found', startProcessTargets('Start-Process -Wait -FilePath node -ArgumentList app.js'), ['node']);
  check('the positional target is found', startProcessTargets("Start-Process notepad.exe"), ['notepad.exe']);
  check('npm start is not Start-Process', startProcessTargets('npm start'), []);
  check('an off-list program through Start-Process is refused', refused(gate('Start-Process notepad.exe')), true);
  check('an allowed one is not', gate('Start-Process node -ArgumentList app.js'), null);
  check('a shell through Start-Process is a nested shell', refused(inlineCodeRefusal("Start-Process powershell -ArgumentList '-NoProfile'")), true);
  check('a script name with "cmd" in it is not', inlineCodeRefusal('npm run start:cmd'), null);
  check('a document through its handler is refused', refused(gate('Invoke-Item .\\report.html')), true);
  check('a URL through the shell is refused', refused(gate('start https://example.com')), true);

  console.log('\n--- the script a step runs is read before it runs ---');
  writeFileSync(join(dir, 'ok.ps1'), 'Get-ChildItem .\\src | Measure-Object\n', 'utf8');
  writeFileSync(join(dir, 'reaches.ps1'), 'Get-Content C:\\Windows\\win.ini\n', 'utf8');
  writeFileSync(join(dir, 'fetches.ps1'), 'Invoke-WebRequest https://example.com/a.zip -OutFile a.zip\n', 'utf8');
  check('a plain script runs', gate('pwsh -NoProfile -File .\\ok.ps1'), null);
  check('a script reaching outside the project is refused', /outside|not inside|project/i.test(gate('pwsh -File .\\reaches.ps1') ?? ''), true);
  check('and the reason names the file', /reaches\.ps1/.test(gate('pwsh -File .\\reaches.ps1') ?? ''), true);
  check('a script that does not exist yet is refused', /does not exist yet/.test(gate('pwsh -File .\\later.ps1') ?? ''), true);
  check('writing and running in one line is refused', /same line/.test(gate("Set-Content .\\a.ps1 'dir'; pwsh -File .\\a.ps1") ?? ''), true);
  const cfg = { denyPatterns: [], allowedPrograms: allowed };
  check('a check whose script fetches is refused', /fetches from the network/.test(checkCommandRefusal('pwsh -File .\\fetches.ps1', 'pwsh', cfg, conf) ?? ''), true);
  check('a check that fetches on its own line is refused', /fetches from the network/.test(checkCommandRefusal('curl https://example.com -o a', 'pwsh', cfg, conf) ?? ''), true);
  check('a check against localhost runs', checkCommandRefusal('curl http://localhost:3000/health', 'pwsh', cfg, conf), null);

  console.log('\n--- npx and installs from elsewhere wait; installed tools do not ---');
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '.bin', 'tsx.cmd'), '', 'utf8');
  check('npx of an installed tool runs', networkFetchReason('npx tsx test/a.ts', dir), null);
  check('npx of a tool not installed waits', refused(networkFetchReason('npx cowsay hi', dir)), true);
  check('flags do not change that', refused(networkFetchReason('npx --yes cowsay hi', dir)), true);
  check('npm install from the registry runs', networkFetchReason('npm install lodash', dir), null);
  check('npm install from a repository waits', refused(networkFetchReason('npm install github:x/y', dir)), true);
  check('docker pull waits', refused(networkFetchReason('docker pull node:20', dir)), true);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n--- the lock\'s mode ceiling reaches every entrance ---');
{
  const { outcome } = applyPolicyLock({ mode: 'unattended', allowedPrograms: ['node'], denyPatterns: [] }, { maxMode: 'confirm' });
  check('the outcome carries the ceiling', outcome.maxMode, 'confirm');
  const blocked = unattendedPrecondition({ mode: 'unattended', allowedPrograms: ['node'], isolation: 'none-accepted', lockedToConfirm: outcome.maxMode === 'confirm' });
  check('an unattended start is refused under it', /policy\.lock\.json/.test(blocked ?? ''), true);
  check('a confirm start is not', unattendedPrecondition({ mode: 'confirm', allowedPrograms: [], lockedToConfirm: true }), null);
}

console.log('\n--- a session id or a preset name is a file name, never a path ---');
{
  check('an id of the store\'s own shape passes', safeName('20260927-100357-vv4p'), '20260927-100357-vv4p');
  for (const bad of ['..\\..\\x', '../x', 'a/b', 'C:\\x', '.hidden', '']) {
    let threw = false;
    try {
      safeName(bad);
    } catch {
      threw = true;
    }
    check(`refused: ${JSON.stringify(bad)}`, threw, true);
  }
  check('a Cyrillic preset name passes', safePresetName('моят пресет'), 'моят пресет');
  let threw = false;
  try {
    safePresetName('..\\evil');
  } catch {
    threw = true;
  }
  check('a preset name that climbs is refused', threw, true);
}

console.log('\n--- shapes of secrets that used to pass ---');
for (const [what, text, secret] of [
  ['an environment-style name', 'DB_PASSWORD=Summer1;', 'Summer1'],
  ['GITHUB_TOKEN=', 'GITHUB_TOKEN=abcdefghij1234', 'abcdefghij'],
  ['an env listing in columns', 'Name              Value\nAPI_KEY           zz9988xx7766\nPATH              C:\\x', 'zz9988'],
  ['a postgres URL', 'postgres://app:hunter22@db.internal/app', 'hunter22'],
  ['an sk- key', 'key sk-abcdefghijklmnopqrstu', 'sk-abcdef'],
  ['a key cut off before its END line', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nQ==', 'MIIEow'],
] as Array<[string, string, string]>) {
  const out = redactSecrets(text);
  check(`redacted: ${what}`, !out.includes(secret) && out.includes('REDACTED'), true);
}
check('a type listing is left alone', redactSecrets('interface User { password: string; token?: string }'), 'interface User { password: string; token?: string }');
check('PATH in a listing is left alone', redactSecrets('PATH              C:\\x'), 'PATH              C:\\x');

console.log('\n--- no execution-policy override on the command line ---');
{
  const resolved = resolveShell('powershell');
  const args = resolved.ok ? invocationFor(resolved.resolved, 'Get-Date').args : [];
  check('the flag is gone', args.some((a) => /ExecutionPolicy/i.test(a)), false);
}

if (process.platform === 'win32') {
  console.log('\n--- the runner\'s own git runs nothing a task placed in the repository ---');
  const repo = mkdtempSync(join(tmpdir(), 'cop-hooks-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' } });
  const mark = join(repo, 'hook-ran.txt');
  writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\necho ran > "${mark.replace(/\\/g, '/')}"\n`, 'utf8');
  await git(repo, ['checkout', '-b', 'runner-branch']);
  check('a post-checkout hook did not run for the runner', existsSync(mark), false);
  spawnSync('git', ['checkout', '-q', '-b', 'plain'], { cwd: repo });
  check('(the same hook does run for plain git — the test is real)', existsSync(mark), true);
  rmSync(repo, { recursive: true, force: true });
}

console.log(wrong === 0 ? '\nall good' : `\n${wrong} wrong`);
process.exit(wrong === 0 ? 0 : 1);
