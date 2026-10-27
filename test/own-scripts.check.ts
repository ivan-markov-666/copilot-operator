/**
 * Only the project's own scripts run (operator, 2026-10-21).
 *
 * "I do not want the project to run scripts downloaded from the internet, or ones it created itself — everything
 * is dynamic, not from files"; then "that is for scripts from the internet; the ones that are part of it and needed
 * stay"; and "npm and the like of course — I mean only scripts from files, not whether the bot runs the tests or
 * the back end". What the chat writes comes from Copilot, a service on the internet: a script it wrote is a script
 * from the internet. So a script file a chat's step runs — `.ps1`, `.psm1`, `.cmd`, `.bat`, `.sh`, `.vbs`, `.wsf` —
 * must be committed in the project, unchanged since, last committed by someone other than the runner and before
 * the work began; nothing in `.cop-tmp` is run; the project's tools (npm, node, dotnet) go on as before.
 *
 * Held here: the rule itself (`ownScriptRefusal`) against a real repository, the step gate it sits in, the
 * operator's own checks it leaves alone, and a chat message end to end — a script written in one step and run in
 * the next is refused, and Copilot is told why.
 *
 *   npm run check:own-scripts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownScriptRefusal } from '../src/exec/scriptFiles.js';
import { checkCommandRefusal, staticCheck, type PolicyConfig } from '../src/exec/policy.js';
import { RunConfigSchema } from '../src/config/schema.js';
import type { Step } from '../src/protocol/replySchema.js';
import { startHarness, Tally } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
const base = await mkdtemp(join(tmpdir(), 'cop-own-scripts-'));
process.once('exit', () => rmSync(base, { recursive: true, force: true }));

const repo = join(base, 'repo');
mkdirSync(join(repo, 'tools'), { recursive: true });
mkdirSync(join(repo, '.cop-tmp'), { recursive: true });
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const as = (email: string, ...args: string[]): string => git('-c', `user.name=${email.split('@')[0]}`, '-c', `user.email=${email}`, ...args);
git('init', '-q', '-b', 'main');
const files: Record<string, string> = {
  'build.ps1': 'Write-Output built',
  'tools/run.cmd': '@echo ran',
  'deploy.sh': 'echo deployed',
  'legacy.vbs': 'WScript.Echo "legacy"',
  'scripts.js': 'console.log("project code")',
  '.cop-tmp/kept.ps1': 'Write-Output scratch',
};
for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
as('operator@example.com', 'add', '-A', '-f');
as('operator@example.com', 'commit', '-q', '-m', 'the project as the operator keeps it');
// One the runner committed, as its work commits are made.
writeFileSync(join(repo, 'bot.ps1'), 'Write-Output bot');
as('copilot-operator@localhost', 'add', 'bot.ps1');
as('copilot-operator@localhost', 'commit', '-q', '-m', 'the runner commits the work');
// The work began after all of that.
const began = new Date(Date.now() + 5_000).toISOString();

const refused = (cmd: string, since = began): string | null => ownScriptRefusal(cmd, repo, since);
const short = (r: string | null): string => (r ?? 'null').slice(0, 160);

console.log('--- the project\'s own scripts run, however they are called ---');
for (const cmd of [
  'pwsh -NoProfile -File .\\build.ps1',
  '& .\\build.ps1',
  '. .\\build.ps1',
  '.\\tools\\run.cmd',
  'cmd /c tools\\run.cmd',
  'bash deploy.sh',
  'cscript //nologo legacy.vbs',
  "Start-Process pwsh -ArgumentList '-File','build.ps1' -Wait",
]) {
  t.check(`runs: ${cmd}`, refused(cmd), null);
}

console.log('\n--- the project\'s tools are not scripts of this kind ---');
for (const cmd of [
  'npm test',
  'npm.cmd run build',
  'npx tsx src/main.ts',
  "Start-Process -FilePath 'npx.cmd' -ArgumentList 'tsx','src/main.ts' -PassThru",
  'node scripts.js',
  'node scripts.js > .cop-tmp\\out.txt',
  'dotnet test',
  'Get-Content .\\.cop-tmp\\kept.ps1',
]) {
  t.check(`runs: ${cmd}`, refused(cmd), null);
}

console.log('\n--- a script that is not the project\'s own is refused, and says why ---');
writeFileSync(join(repo, 'new.ps1'), 'Write-Output new');
writeFileSync(join(repo, 'made.sh'), 'echo made');
for (const [cmd, why] of [
  ['pwsh -NoProfile -File .\\new.ps1', 'not committed'],
  ['& .\\new.ps1', 'not committed'],
  ["Start-Process pwsh -ArgumentList '-File','new.ps1'", 'not committed'],
  ['bash made.sh', 'not committed'],
  ['sh ./made.sh', 'not committed'],
  ['.\\later.ps1', 'does not exist'],
  ['pwsh -File .\\bot.ps1', 'made by copilot-operator'],
  ['pwsh -File .\\.cop-tmp\\kept.ps1', '.cop-tmp'],
  ['node .\\.cop-tmp\\helper.js', '.cop-tmp'],
  ['npx tsx .cop-tmp/helper.ts', '.cop-tmp'],
] as const) {
  const r = refused(cmd);
  t.truthy(`refused (${why}): ${cmd}`, r !== null && r.includes(why), short(r));
}
writeFileSync(join(repo, 'build.ps1'), 'Write-Output changed');
t.truthy('changed since its commit: refused', refused('pwsh -File .\\build.ps1')?.includes('changed since') === true, short(refused('pwsh -File .\\build.ps1')));
git('checkout', '-q', '--', 'build.ps1');
t.check('put back as committed: it runs again', refused('pwsh -File .\\build.ps1'), null);
const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
t.truthy(
  'committed after the work began — by the chat, at the operator\'s word — is the work\'s, not the project\'s',
  refused('pwsh -File .\\build.ps1', hourAgo)?.includes('after this work began') === true,
  short(refused('pwsh -File .\\build.ps1', hourAgo)),
);
const loose = join(base, 'loose');
mkdirSync(loose, { recursive: true });
writeFileSync(join(loose, 'x.ps1'), 'Write-Output x');
t.truthy('outside a git repository nothing tells a script apart: refused', ownScriptRefusal('pwsh -File .\\x.ps1', loose, began)?.includes('not in a git repository') === true, short(ownScriptRefusal('pwsh -File .\\x.ps1', loose, began)));
const message = refused('pwsh -NoProfile -File .\\new.ps1') ?? '';
t.truthy('the reason tells the chat what to do instead: the step itself, or hand it to the operator', message.includes('in the step itself') && message.includes('several lines') && message.includes('"handoff"'), message);

/*
 * A file of code written during the work, given straight to a runtime (operator, 2026-10-26: "the script is made, but the
 * user runs it"): refused, the chat told to hand it over. A file of the project changed by the work still runs — the
 * application started after a change is the work — and so do the tests, as before.
 */
console.log('\n--- a file of code written during the work is the operator\'s to run ---');
await new Promise((r) => setTimeout(r, 2_100));
const workBegan = new Date().toISOString();
writeFileSync(join(repo, 'tools', 'inspect.ts'), 'console.log(1)');
writeFileSync(join(repo, 'diag.py'), 'print(1)');
writeFileSync(join(repo, 'scripts.js'), 'console.log("changed by the work")');
const code = (cmd: string): string | null => ownScriptRefusal(cmd, repo, workBegan);
for (const cmd of ['npx ts-node tools/inspect.ts', 'npx tsx tools\\inspect.ts', 'node tools/inspect.ts', '& node .\\tools\\inspect.ts', 'python diag.py', 'py .\\diag.py', 'deno run tools/inspect.ts']) {
  t.truthy(`refused, to hand over: ${cmd}`, /a script written during this work[\s\S]*"handoff"/.test(code(cmd) ?? ''), short(code(cmd)));
}
for (const cmd of ['node scripts.js', 'node --test tools/inspect.ts', 'npm test', 'npx playwright test tools/inspect.ts', 'node --version', 'python -m pytest', 'npx tsx src/missing.ts']) {
  t.check(`runs: ${cmd}`, code(cmd), null);
}
as('copilot-operator@localhost', 'add', 'tools/inspect.ts');
as('copilot-operator@localhost', 'commit', '-q', '-m', 'the runner commits the work');
t.truthy('committed by the runner during the work: still the work\'s',code('node tools/inspect.ts')?.includes('added by copilot-operator') === true, short(code('node tools/inspect.ts')));
git('checkout', '-q', '--', 'scripts.js');

console.log('\n--- in the step gate, for the chat; the operator\'s checks are theirs ---');
const shipped = RunConfigSchema.parse({}).execution;
const cfg: PolicyConfig = { mode: 'unattended', denyPatterns: shipped.denyPatterns, allowedPrograms: shipped.allowedPrograms, isolation: 'separate-account' };
const step = (cmd: string): Step => ({ id: 1, type: 'command', cmd, shell: 'pwsh' });
const confinement = { roots: [repo], cwd: repo, workStartedAt: began };
const gated = staticCheck(step('pwsh -NoProfile -File .\\new.ps1'), cfg, process.env, confinement);
t.truthy('a chat step running a script it wrote: skipped, with the reason', gated?.action === 'skip' && gated.reason.includes("not one of the project's own scripts"), JSON.stringify(gated));
t.check('a chat step running the project\'s script passes this gate', staticCheck(step('pwsh -NoProfile -File .\\build.ps1'), cfg, process.env, confinement), null);
t.check('an operator\'s check running a script is not held to it', checkCommandRefusal('pwsh -NoProfile -File .\\new.ps1', 'pwsh', cfg, { roots: [repo], cwd: repo }), null);

console.log('\n--- a chat message, end to end ---');
{
  const h = await startHarness({ settings: { execution: { mode: 'unattended', isolation: 'none-accepted' } } });
  try {
    h.chat.script(
      reply.steps("Set-Content -NoNewline -Path .\\count.ps1 -Value 'Write-Output counted'"),
      reply.steps('pwsh -NoProfile -File .\\count.ps1'),
      reply.steps('$n = (Get-ChildItem -File).Count\n"$n files"'),
      reply.done('The script was refused, so the count was made in the step itself: the folder holds its files.'),
    );
    const sent = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Count the files in the folder.', model: 'Think deeper' });
    await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
    await h.idle();
    // What Copilot was told: each message with the reports it carried.
    const reports = h.chat.sent.map((m) => [m.text, ...Object.values(m.attached)].join('\n'));
    const afterRun = reports.find((r) => r.includes('count.ps1') && r.includes('not one of the project')) ?? '';
    t.truthy('the script the chat wrote is not run, and Copilot is told why', afterRun.includes("is not one of the project's own scripts") && afterRun.includes('not committed'), reports.at(-2)?.slice(0, 600));
    t.truthy('the file it wrote is there, unrun', existsSync(join(h.repo, 'count.ps1')), h.repo);
    const multi = reports.slice(1).find((r) => /^\s*\d+ files\s*$/m.test(r));
    t.truthy('a command of several lines runs as written', multi !== undefined, reports.at(-1)?.slice(0, 800));
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } finally {
    await h.stop();
  }
}

t.finish();
