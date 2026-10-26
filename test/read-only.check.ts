/**
 * Programs set to read only (operator, 2026-10-26: "give the bot az, with me signing in myself; it is important that it
 * runs without writing, for reference only"). `az`'s own words decide: a command that only reads runs without a card,
 * one that changes something, signs in or out, shows a secret, downloads or sends any request is refused with why, and
 * one the gate cannot read is put to the operator in every mode — Settings' agreement or not. A check, which has nobody
 * to ask, refuses both that and a platform's command. Nothing here starts az: the gate is read, never run.
 *
 *   npm run check:read-only
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanCommandHeads } from '../src/exec/commandHeads.js';
import { readOnlyCapable, readOnlyVerdict } from '../src/exec/readOnly.js';
import { platformTools } from '../src/exec/platforms.js';
import { checkCommandRefusal, commandRefusal, type PolicyConfig, type PolicyDecision } from '../src/exec/policy.js';
import { makeAuthorizer, unattendedAuthorizer, type HeldFor } from '../src/exec/authorizer.js';
import { RunConfigSchema } from '../src/config/schema.js';
import type { Step } from '../src/protocol/replySchema.js';

const DEFAULTS = RunConfigSchema.parse({}).execution;
const ALLOWED = [...DEFAULTS.allowedPrograms, 'az', 'gh'];
const RO = ['az'];

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}
const kind = (cmd: string, shell?: string, ro: string[] = RO): string | null => readOnlyVerdict(cmd, shell, ro)?.kind ?? null;
const reason = (cmd: string): string => {
  const v = readOnlyVerdict(cmd, undefined, RO);
  return v?.kind === 'refused' ? v.reason : '';
};

console.log('--- the setting, and what can be set so ---');
check('nothing is read only by default', DEFAULTS.readOnlyPrograms, []);
check('az can be set to read only', readOnlyCapable().includes('az'), true);
check('az is named as Azure', platformTools().az, 'Azure (az)');

console.log('\n--- the scanner gives each invocation its words ---');
check('az vm list --query: its words as the shell reads them', scanCommandHeads('az vm list --query "[].name" -o tsv').calls.map((c) => [c.head, c.args.map((a) => a.literal)]), [['az', ['vm', 'list', '--query', '[].name', '-o', 'tsv']]]);
check('quoted words are the words', scanCommandHeads("az 'vm' \"list\"").calls[0]!.args.map((a) => a.literal), ['vm', 'list']);
check('a variable is known only when it runs', scanCommandHeads('az $group list').calls[0]!.args.map((a) => a.dynamic), [true, false]);
check('after a pipe and an assignment too', scanCommandHeads('$v = az vm list | ConvertFrom-Json').calls.map((c) => c.head), ['az', 'ConvertFrom-Json']);
check('cmd: the words after the program', scanCommandHeads('az group show -n rg1', 'cmd').calls[0]!.args.map((a) => a.literal), ['group', 'show', '-n', 'rg1']);

console.log('\n--- az commands that only read run ---');
for (const cmd of [
  'az vm list',
  'az group show -n rg1',
  'az account show',
  'az account list -o table',
  'az graph query -q "Resources | take 5"',
  'az storage account list --query "[].name" -o tsv',
  'az vm list-sizes -l westeurope',
  'az aks get-versions -l westeurope',
  'az --version',
  'az vm create --help',
  'az deployment group what-if -g rg -f main.bicep',
  'az backup vault list',
  'az lock list',
  'az vm run-command list -l westeurope',
  '$vms = az vm list | ConvertFrom-Json; $vms.Count',
  'az find "storage account"',
  '& az group exists -n rg1',
]) {
  check(`reads: ${cmd}`, kind(cmd), 'reads');
}

console.log('\n--- a change, a sign-in, a secret, a download or any request is refused, saying why ---');
const refusals: Array<[string, RegExp]> = [
  ['az vm create -n x -g rg --image Ubuntu2204', /changes something/],
  ['az group delete -n rg --yes', /changes something/],
  ['az webapp restart -n app -g rg', /changes something/],
  ['az vm run-command invoke -g rg -n vm --command-id RunPowerShellScript', /changes something/],
  ['az ad sp create-for-rbac -n bot', /changes something/],
  ['az extension add --name devops', /changes something/],
  ['az login', /signs in or out/],
  ['az logout', /signs in or out/],
  ['az acr login -n registry', /signs in or out/],
  ['az account set --subscription prod', /--subscription <name or id>/],
  ['az account get-access-token', /shows a secret/],
  ['az storage account keys list -n store', /shows a secret/],
  ['az aks get-credentials -n cluster -g rg', /shows a secret/],
  ['az keyvault secret show --vault-name v -n s', /shows a secret/],
  ['az webapp config appsettings list -n app -g rg', /shows a secret/],
  ['az sql db show-connection-string -s srv -n db -c ado.net', /shows a secret/],
  ['az rest --method get --url https://management.azure.com/subscriptions', /"az rest" sends any request/],
  ['az storage blob download -c c -n f -f out.txt', /downloads a file/],
  ['az interactive', /waits for a person/],
  ['az vm list; az vm delete -n x -g rg --yes', /"az vm delete" changes something/],
];
for (const [cmd, why] of refusals) check(`refused: ${cmd}`, why.test(reason(cmd)), true);

console.log('\n--- what cannot be read is put to the operator ---');
for (const cmd of [
  'az webapp log tail -n app -g rg',
  'az group export -n rg',
  'az $verb list',
  'cmd /c "az vm delete -n x"',
  'Start-Process az -ArgumentList "vm","delete"',
  'Write-Output "az vm delete -n x"',
]) {
  check(`unclear: ${cmd}`, kind(cmd), 'unclear');
}

console.log('\n--- nothing to read: no az, or az not set to read only ---');
check('git status', kind('git status'), null);
check('a file named az.txt is not az', kind('Get-Content az.txt'), null);
check('a word with az in it is not az', kind('npm run lazy'), null);
check('az not set to read only', kind('az vm delete -n x', undefined, []), null);
check('a program with no rule is ignored', kind('gh repo delete x', undefined, ['gh']), null);

console.log('\n--- the gate: a change refused for a step, in a script it runs, and in a check ---');
const dir = await mkdtemp(join(tmpdir(), 'cop-readonly-'));
try {
  const confinement = { roots: [dir], cwd: dir };
  const refuse = (cmd: string, ro: string[] = RO): string | null => commandRefusal(cmd, 'pwsh', [], ALLOWED, process.env, confinement, ro);
  check('az vm create is refused when az is read only', /changes something/.test(refuse('az vm create -n x') ?? ''), true);
  check('and not by this gate when it is not', refuse('az vm create -n x', []), null);
  check('az vm list passes', refuse('az vm list'), null);
  await mkdir(join(dir, 'scripts'));
  await writeFile(join(dir, 'scripts', 'make.ps1'), 'az group create -n rg -l westeurope\n');
  await writeFile(join(dir, 'scripts', 'look.ps1'), 'az group list -o table\n');
  await writeFile(join(dir, 'scripts', 'tail.ps1'), 'az webapp log tail -n app -g rg\n');
  check('a script that changes something is refused', /changes something.*\(in the script/.test(refuse('pwsh -File .\\scripts\\make.ps1') ?? ''), true);
  check('a script that only reads runs', refuse('pwsh -File .\\scripts\\look.ps1'), null);
  check('a script whose az cannot be read is refused: nobody is asked inside a script', /could not be read as only reading/.test(refuse('pwsh -File .\\scripts\\tail.ps1') ?? ''), true);

  const checkCfg = (ro: string[], questions: 'ask' | 'agree' = 'ask') => ({ denyPatterns: [], allowedPrograms: ALLOWED, readOnlyPrograms: ro, questions });
  check('a check that only reads with az runs', checkCommandRefusal('az group list', 'pwsh', checkCfg(RO), confinement), null);
  check('a check that changes something is refused', /changes something/.test(checkCommandRefusal('az group create -n rg -l x', 'pwsh', checkCfg(RO), confinement) ?? ''), true);
  check('a check that cannot be read is refused', /could not be read as only reading/.test(checkCommandRefusal('az webapp log tail -n a', 'pwsh', checkCfg(RO), confinement) ?? ''), true);
  check('a check that reaches a platform asked about each time is refused: nobody is asked', /this check reaches GitHub \(gh\)/.test(checkCommandRefusal('gh repo list', 'pwsh', checkCfg(RO), confinement) ?? ''), true);
  check('az asked about each time, its check too', /this check reaches Azure \(az\)/.test(checkCommandRefusal('az group list', 'pwsh', checkCfg([]), confinement) ?? ''), true);
  check('unless Settings agree with what the bot proposes', checkCommandRefusal('gh repo list', 'pwsh', checkCfg(RO, 'agree'), confinement), null);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('\n--- who is asked: reading runs, unclear is asked in every mode ---');
{
  const step = (cmd: string, id = 1): Step => ({ id, type: 'command', shell: 'pwsh', cmd });
  const policy = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({ mode: 'unattended', denyPatterns: [], allowedPrograms: ALLOWED, isolation: 'none-accepted', platformAccess: 'ask', readOnlyPrograms: RO, ...over });
  const ask = async (cfg: PolicyConfig, cmd: string): Promise<{ decision: PolicyDecision; asked: boolean; held?: HeldFor }> => {
    let asked = false;
    let held: HeldFor | undefined;
    const decision = await makeAuthorizer(cfg, async (_s, _c, h) => {
      asked = true;
      held = h;
      return { action: 'run' };
    }).authorize(step(cmd), { iteration: 1 });
    return { decision, asked, held };
  };
  const reads = await ask(policy(), 'az vm list -o table');
  check('az vm list runs without a card in a run without asking', [reads.decision.action, reads.asked], ['run', false]);
  const writes = await ask(policy(), 'az vm create -n x');
  check('az vm create is refused and nobody is asked', [writes.decision.action, writes.asked, /changes something/.test((writes.decision as { reason?: string }).reason ?? '')], ['skip', false, true]);
  const unclear = await ask(policy(), 'az webapp log tail -n app');
  check('one that cannot be read is put to the operator, saying so', [unclear.asked, unclear.held?.platform, !!unclear.held?.readOnly], [true, 'Azure (az)', true]);
  const agreed = await ask(policy({ platformAccess: 'allow' }), 'az webapp log tail -n app');
  check('even when Settings agree with what the bot proposes', [agreed.asked, !!agreed.held?.readOnly], [true, true]);
  const agreedReads = await ask(policy({ platformAccess: 'allow' }), 'az vm list');
  check('and reading still runs then', [agreedReads.decision.action, agreedReads.asked], ['run', false]);
  const both = await ask(policy(), 'az vm list; gh repo list');
  check('a line that reads with az and reaches GitHub is asked about for GitHub', [both.asked, both.held?.platform, both.held?.readOnly], [true, 'GitHub (gh)', undefined]);
  const askEach = await ask(policy({ readOnlyPrograms: [] }), 'az vm list');
  check('az asked about each time: every command on a card, as before', [askEach.asked, askEach.held?.platform], [true, 'Azure (az)']);
  const confirm = await ask(policy({ mode: 'confirm' }), 'az vm list');
  check('in a run that asks before each command, reading is asked as any command is, not as a platform', [confirm.asked, confirm.held], [true, undefined]);
  const cli = await unattendedAuthorizer(policy()).authorize(step('az webapp log tail -n app'), { iteration: 1 });
  check('at the terminal with nobody there, it is refused, saying why', [cli.action, /set to read only here/.test((cli as { reason?: string }).reason ?? '')], ['skip', true]);
}

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
