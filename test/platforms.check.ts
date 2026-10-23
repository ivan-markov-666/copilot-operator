/**
 * Commands that reach a platform with the operator's own access (operator, 2026-10-23: "it asked me whether to run
 * Azure CLI commands; ask the same for every such platform — Jira, Vercel, AWS, GitHub; permission must come from the
 * user; and an option in Settings to always agree with what the bot proposes").
 *
 * - which commands are such, read by the programs a line starts and the cmdlets it calls — and which are not;
 * - they wait for the operator in every mode, an unattended one too, and are never "run the rest"; agreed to in
 *   Settings (`execution.questions: agree`), they run; with nobody to ask (the CLI's unattended runs), refused;
 * - through the API: the card names the platform, and "Agree with what the bot proposes" lets it run.
 *
 *   npm run check:platforms
 */
import { platformReason } from '../src/exec/platforms.js';
import { makeAuthorizer, unattendedAuthorizer, type HeldFor } from '../src/exec/authorizer.js';
import type { PolicyConfig } from '../src/exec/policy.js';
import type { Step } from '../src/protocol/replySchema.js';
import { startHarness, waitFor, Tally } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

console.log('--- which commands reach a platform ---');
for (const [cmd, platform] of [
  ['az login', 'Azure (az)'],
  ['az account show --output json', 'Azure (az)'],
  ['aws s3 ls', 'AWS (aws)'],
  ['gcloud projects list', 'Google Cloud (gcloud)'],
  ['gh pr list --state open', 'GitHub (gh)'],
  ['glab mr list', 'GitLab (glab)'],
  ['jira issue list -p SHOP', 'Jira (jira)'],
  ['vercel deploy --prod', 'Vercel (vercel)'],
  ['kubectl get pods -n shop', 'Kubernetes (kubectl)'],
  ['terraform apply -auto-approve', 'Terraform (terraform)'],
  ['Get-ChildItem; az group list', 'Azure (az)'],
  ['C:\\tools\\az.cmd vm list', 'Azure (az)'],
  ['Connect-AzAccount', 'Azure (Az PowerShell)'],
  ['Get-AzVM -ResourceGroupName shop', 'Azure (Az PowerShell)'],
  ['Get-MgUser -Top 1', 'Microsoft Graph (PowerShell)'],
  ['Connect-ExchangeOnline', 'Exchange Online (PowerShell)'],
  ['npm publish --access public', 'the npm registry'],
  ['npm --workspace web publish', 'the npm registry'],
  ['docker push shop/web:1.2', 'a container registry'],
  ['dotnet nuget push pkg.nupkg', 'NuGet'],
] as const) {
  t.check(`${cmd}: ${platform}`, platformReason(cmd), platform);
}
for (const cmd of ['npm test', 'npm install', 'npm run build', 'Get-Content az.txt', "Select-String -Pattern 'aws' -Path README.md", 'echo gh', 'git status', 'dotnet test', 'docker build .', 'Get-Azure', 'node scripts/deploy.js']) {
  t.check(`not a platform: ${cmd}`, platformReason(cmd), null);
}

console.log('\n--- held for the operator in every mode, unless Settings agree ---');
{
  const step = (cmd: string): Step => ({ id: 1, cmd, shell: 'pwsh' }) as Step;
  const policy = (mode: 'confirm' | 'unattended', platformAccess?: 'ask' | 'allow'): PolicyConfig => ({ mode, denyPatterns: [], allowedPrograms: ['az', 'gh', 'npm'], isolation: 'none-accepted', ...(platformAccess ? { platformAccess } : {}) });
  const asked: Array<HeldFor | undefined> = [];
  const ask = async (_s: Step, _c: unknown, held?: HeldFor) => {
    asked.push(held);
    return { action: 'run' as const };
  };
  await makeAuthorizer(policy('confirm'), ask).authorize(step('az login'), { iteration: 1 });
  t.check('asking before each command: the card says it reaches Azure', asked.at(-1), { platform: 'Azure (az)' });
  const before = asked.length;
  const d = await makeAuthorizer(policy('unattended'), ask).authorize(step('gh repo list'), { iteration: 1 });
  t.check('a run without asking still asks', [asked.length - before, asked.at(-1), d.action], [1, { platform: 'GitHub (gh)' }, 'run']);
  const plain = asked.length;
  await makeAuthorizer(policy('unattended'), ask).authorize(step('npm test'), { iteration: 1 });
  t.check('an ordinary command, run without asking, is not held', asked.length, plain);
  const agreed = await makeAuthorizer(policy('unattended', 'allow'), ask).authorize(step('az login'), { iteration: 1 });
  t.check('agreed to in Settings: it runs, nobody asked', [agreed.action, asked.length], ['run', plain]);
  const nobody = await unattendedAuthorizer(policy('unattended')).authorize(step('Connect-AzAccount'), { iteration: 1 });
  t.truthy('with nobody to ask, it is refused and the chat told why', nobody.action === 'skip' && /reaches Azure \(Az PowerShell\) with the operator's access/.test(nobody.reason ?? ''), nobody);
}

console.log('\n--- through the API: the card names the platform; agreeing in Settings lets it run ---');
for (const questions of ['ask', 'agree'] as const) {
  const h = await startHarness({ settings: { execution: { mode: 'unattended', isolation: 'none-accepted', questions } } });
  try {
    const [s] = await h.importPlan({
      version: 1,
      sessions: [{ name: `platform-${questions}`, onFailure: 'stop', projectDir: h.repo, vcs: { enabled: false }, review: { enabled: false },
        tasks: [{ title: 'graph', prompt: 'Read the signed-in user from Microsoft Graph and say who it is, changing nothing in the project.' }] }],
    });
    h.chat.script(reply.steps('Get-MgUser -Top 1'), reply.done('The command was answered; the user could not be read here, which is what the output says.'));
    await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
    if (questions === 'ask') {
      const card = await waitFor('the card', async () => (await h.call<Array<{ id: string; platform?: string; description: string }>>('GET', '/approvals')).find((a) => a.description.includes('Get-MgUser')), 60_000);
      t.check('a run without asking: the command waits, the card naming Microsoft Graph', card.platform, 'Microsoft Graph (PowerShell)');
      await h.call('POST', `/approvals/${card.id}`, { action: 'run' });
    }
    await h.idle();
    const ran = (await h.call<Array<{ type: string; message?: string }>>('GET', `/sessions/${s!.id}/events`)).some((e) => e.type === 'step-finished' || /running step 1/.test(e.message ?? ''));
    t.check(questions === 'ask' ? 'allowed on the card, it runs' : '"Agree with what the bot proposes": it runs, nobody asked', ran, true);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy(`${questions}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

t.finish();
