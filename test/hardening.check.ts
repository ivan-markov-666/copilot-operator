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
import { checkCommandRefusal, commandRefusal, matchDenyPattern, repositoryInternalsRefusal, unattendedPrecondition } from '../src/exec/policy.js';
import { RunConfigSchema } from '../src/config/schema.js';
import { botSelfRefusal, networkFetchReason } from '../src/exec/network.js';
import { inlineCodeRefusal, startProcessTargets } from '../src/exec/programs.js';
import { redactSecrets } from '../src/exec/redaction.js';
import { safeName, safePresetName } from '../src/session/store.js';
import { invocationFor, resolveShell } from '../src/exec/shells.js';
import { git } from '../src/vcs/git.js';
import { applyPolicyLock, readPolicyLocks, PolicyLockSchema } from '../src/config/lockedPolicy.js';
import { principalsInSddl } from '../src/api/dataAcl.js';
import { dmtfOf } from '../src/exec/processes.js';
import { pruneRuns } from '../src/session/retention.js';
import { utimes } from 'node:fs/promises';

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

console.log('\n--- what a corporate configuration must not break (Constrained Language Mode) ---');
{
  // The permission check reads SDDL, which Get-Acl gives in every language mode; the aliases are
  // expanded so that "SY" and "S-1-5-18" are one principal, and a deny entry is not access.
  const own = 'S-1-5-21-1-2-3-1000';
  check('aliases and SIDs are read alike', principalsInSddl('O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;' + own + ')').sort(), ['S-1-5-18', own].sort());
  check('Authenticated Users is somebody else', principalsInSddl('D:(A;OICIID;0x1301bf;;;AU)').includes('S-1-5-11'), true);
  check('a deny entry is not access', principalsInSddl('D:(D;;FA;;;BU)(A;;FA;;;SY)'), ['S-1-5-18']);
  check('a SACL after the DACL is not read as access', principalsInSddl('D:(A;;FA;;;SY)S:(AU;SA;FA;;;WD)'), ['S-1-5-18']);
  // The process-table filter is built here, not by a .NET converter PowerShell may not allow.
  check('a WMI datetime literal, in UTC', dmtfOf(Date.UTC(2026, 8, 27, 13, 5, 9, 250)), '20260927130509.250000+000');
}

console.log('\n--- an administrator\'s lock outside the install is honoured first ---');
{
  const base = mkdtempSync(join(tmpdir(), 'cop-lock-'));
  const programData = join(base, 'ProgramData');
  mkdirSync(join(programData, 'copilot-operator'), { recursive: true });
  writeFileSync(join(programData, 'copilot-operator', 'policy.lock.json'), JSON.stringify({ maxMode: 'confirm' }), 'utf8');
  writeFileSync(join(base, 'policy.lock.json'), JSON.stringify({ allowedPrograms: ['node'] }), 'utf8');
  const locks = await readPolicyLocks(base, { ProgramData: programData });
  check('both locks are read, the machine-wide one first', locks.map((l) => (l.maxMode ? 'machine' : 'install')), ['machine', 'install']);
  check('with no ProgramData only the install\'s counts', (await readPolicyLocks(base, {})).length, 1);
  rmSync(base, { recursive: true, force: true });
}

console.log('\n--- run folders follow the retention rule ---');
{
  const runs = mkdtempSync(join(tmpdir(), 'cop-runs-'));
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 8, 27);
  for (const [name, ageDays] of [['old-session', 40], ['recent-session', 3], ['_browser', 400]] as Array<[string, number]>) {
    mkdirSync(join(runs, name));
    writeFileSync(join(runs, name, 'x.txt'), 'x', 'utf8');
    const when = new Date(now - ageDays * day);
    await utimes(join(runs, name), when, when);
  }
  check('nothing is removed while retention is off', await pruneRuns(runs, 0, now), []);
  check('older folders go, recent ones and the bot\'s own stay', await pruneRuns(runs, 30, now), ['old-session']);
  check('and they are really gone', [existsSync(join(runs, 'old-session')), existsSync(join(runs, 'recent-session')), existsSync(join(runs, '_browser'))], [false, true, true]);
  rmSync(runs, { recursive: true, force: true });
}

console.log('\n--- git that only reads is not taken for git that writes ---');
{
  // Refused live on 2026-09-30: `merge` caught `merge-base`, because a hyphen ends a word.
  const deny = RunConfigSchema.parse({}).execution.denyPatterns;
  const denied = (c: string): boolean => matchDenyPattern(c, deny) !== null;
  check('git merge-base --is-ancestor is allowed', denied('git merge-base --is-ancestor abc1234 HEAD'), false);
  check('with -C in front too', denied('git -C C:/repo merge-base main HEAD'), false);
  check('git merge is still refused', [denied('git merge main'), denied('git merge')], [true, true]);
  check('and the hyphenated ones that write', ['git read-tree HEAD', 'git checkout-index -a', 'git commit-tree abc', 'git merge-file a b c'].map(denied), [true, true, true, true]);
  check('git rm and git add still refused', [denied('git rm x'), denied('git add .')], [true, true]);
}

console.log('\n--- the second compliance round ---');
{
  // `git -c` with a key that names a program is the config write in another spelling.
  check('git -c core.hooksPath is refused', refused(repositoryInternalsRefusal('git -c core.hooksPath=.h status')), true);
  check('git -c credential.helper is refused', refused(repositoryInternalsRefusal("git -c credential.helper='!x' fetch")), true);
  check('git -c core.quotepath is not', repositoryInternalsRefusal('git -c core.quotepath=off log --oneline'), null);
  check('git commit -c <commit> is not', repositoryInternalsRefusal('git commit -c HEAD~1'), null);
  // The bot's own record folders, by path, wherever the project is.
  check("the bot's data folder is refused by path", refused(botSelfRefusal('Get-Content C:\\bot\\data\\settings.json', [4000], 'C:\\bot')), true);
  check("its runs folder too", refused(botSelfRefusal('dir C:/bot/runs', [4000], 'C:\\bot')), true);
  check('a project folder named data elsewhere is not', botSelfRefusal('Get-Content C:\\proj\\data\\seed.json', [4000], 'C:\\bot'), null);
  // Telemetry switches travel, and the common opt-outs are set.
  const env = stepEnvironment({ PATH: 'p', VSCODE_TELEMETRY_LEVEL: 'off', SOMETOOL_OPTOUT: '1', HOMEBREW_NO_ANALYTICS: '1' });
  check('a *TELEMETRY* variable passes', env.VSCODE_TELEMETRY_LEVEL, 'off');
  check('an *_OPTOUT variable passes', env.SOMETOOL_OPTOUT, '1');
  check('an unrelated one still does not', 'HOMEBREW_NO_ANALYTICS' in env, false);
  check('the common opt-outs are set', [env.DOTNET_CLI_TELEMETRY_OPTOUT, env.POWERSHELL_TELEMETRY_OPTOUT, env.DO_NOT_TRACK], ['1', '1', '1']);
  // The lock reaches the settings that move data, and the updater. A lock written for an earlier
  // version still parses: its Desktop and .env switches lock nothing now that there is no Desktop copy.
  const lock = PolicyLockSchema.parse({ requireIsolation: true, allowDesktopMirror: false, allowEnvFiles: false, passEnv: ['DATABASE_URL'], update: { requireSigned: true, remote: 'https://git.example.com/x.git' } });
  const { policy, outcome } = applyPolicyLock(
    { mode: 'confirm', allowedPrograms: ['node'], denyPatterns: [], isolation: 'none-accepted', passEnv: ['DATABASE_URL', 'AWS_SECRET'] },
    lock,
  );
  check('none-accepted becomes none', policy.isolation, 'none');
  check('passEnv is narrowed to the ceiling', policy.passEnv, ['DATABASE_URL']);
  check('and every change is on the record', outcome.changes.length, 2);
  check('the update fields parse', lock.update?.requireSigned, true);
  let strict = false;
  try {
    PolicyLockSchema.parse({ allowDownloads: true });
  } catch {
    strict = true;
  }
  check('an unknown field is an error, not a shrug', strict, true);
}

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
