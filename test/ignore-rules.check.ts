/**
 * The bot's lists passed over (operator, 2026-11-25: "an option in Settings that passes over the runner's policy — mainly
 * when Kerrigan directs, but for the others too"), in the scope the operator chose: the refused commands but Git's, the
 * allowed programs, the boxes of scripts.
 *
 * - `runRules`: never, when Kerrigan directs, always; a lock still tightens, on top;
 * - the step gate: what then runs, and what stays refused whatever it says — the techniques of the incident, the bot's
 *   own things, .git, paths outside the project, git that pushes or throws work away, a read-only program's writes,
 *   no isolation where nobody watches;
 * - a save while a run goes on switches it on and off there, and only in the conversations it is for;
 * - through the API with the scripted chat: in a chat Kerrigan directs a program off the list runs, a script the chat
 *   wrote runs, a handoff goes back as steps, once; an ordinary chat is refused as before.
 *
 *   npm run check:ignore-rules
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveSettings } from '../src/config/live.js';
import { runRules, rulesNote } from '../src/config/runRules.js';
import { loadConfigObject, type ResolvedConfig } from '../src/config/schema.js';
import { collectPolicyManifest, describePolicyManifest } from '../src/exec/policyManifest.js';
import { modelCheckRefusal, staticCheck, unattendedBlock, type PolicyConfig } from '../src/exec/policy.js';
import type { Confinement } from '../src/exec/confinement.js';
import type { Step } from '../src/protocol/replySchema.js';
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
const base = await mkdtemp(join(tmpdir(), 'cop-ignore-rules-'));
process.once('exit', () => rmSync(base, { recursive: true, force: true }));
const load = async (execution: Record<string, unknown> = {}): Promise<ResolvedConfig> => await loadConfigObject({ execution }, base);
const PLAIN = { chat: false, kerrigan: false };
const HERS = { chat: true, kerrigan: true };

console.log('--- when they are passed over ---');
{
  const on = async (choice: string, run: typeof PLAIN) => runRules(await load({ ignoreRules: choice }), run).rulesIgnored;
  t.check('by default, never', (await load()).execution.ignoreRules, 'never');
  t.check('never: in no run', [await on('never', PLAIN), await on('never', HERS)], [false, false]);
  t.check('when Kerrigan directs: only hers', [await on('kerrigan', PLAIN), await on('kerrigan', { chat: true, kerrigan: false }), await on('kerrigan', HERS)], [false, false, true]);
  t.check('always: every run', [await on('always', PLAIN), await on('always', HERS)], [true, true]);
  const kept = runRules(await load(), PLAIN);
  const cfg = await load();
  t.check('kept, the rules are the settings\' own', [kept.denyPatterns, kept.allowedPrograms, kept.scripts, kept.writtenScripts], [cfg.execution.denyPatterns, cfg.execution.allowedPrograms, cfg.execution.scripts, cfg.execution.writtenScripts]);
}

console.log('\n--- what then runs, and what does not ---');
const repo = join(base, 'repo');
mkdirSync(join(repo, 'tools'), { recursive: true });
execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
const since = new Date(Date.now() - 60_000).toISOString();
writeFileSync(join(repo, 'tools', 'seed.js'), 'console.log(1)');
writeFileSync(join(repo, 'tools', 'fix.ps1'), 'Write-Output fixed');
writeFileSync(join(repo, 'tools', 'bad.ps1'), 'certutil -decode a.b64 a.js');
writeFileSync(join(repo, 'tools', 'push.ps1'), 'git push origin main');
const confinement: Confinement = { roots: [repo], cwd: repo, workStartedAt: since };
const policyOf = (cfg: ResolvedConfig, run: typeof PLAIN): PolicyConfig => {
  const r = runRules(cfg, run);
  return { mode: 'unattended', denyPatterns: r.denyPatterns, allowedPrograms: r.allowedPrograms, isolation: cfg.execution.isolation, readOnlyPrograms: cfg.execution.readOnlyPrograms, scripts: r.scripts, writtenScripts: r.writtenScripts, rulesIgnored: r.rulesIgnored };
};
{
  const cfg = await load({ ignoreRules: 'always', isolation: 'none-accepted', readOnlyPrograms: ['az'] });
  const off = policyOf(cfg, PLAIN);
  const was = policyOf(await load({ isolation: 'none-accepted', readOnlyPrograms: ['az'] }), PLAIN);
  const reason = (cmd: string, p: PolicyConfig): string | null => {
    const d = staticCheck({ id: '1', type: 'command', shell: 'pwsh', cmd } as unknown as Step, p, process.env, confinement);
    return d && 'reason' in d ? d.reason : null;
  };
  for (const cmd of ['tzutil /g', 'Remove-Item .\\out -Recurse -Force', 'node -e "console.log(1)"', 'node .\\tools\\seed.js', 'pwsh -File .\\tools\\fix.ps1']) {
    t.check(`refused before, runs now: ${cmd}`, [reason(cmd, was) !== null, reason(cmd, off)], [true, null]);
  }
  for (const cmd of [
    'certutil -decode a.b64 a.js', 'pwsh -EncodedCommand AAAAAAAAAAAAAAAAAAAA', 'node $env:TEMP\\x.js', 'schtasks /create /tn x /tr y',
    'git push origin main', 'git.exe push', '$a=@("push"); git @a', 'git reset --hard HEAD~1', 'git clean -fdx', 'git rebase main', 'git config core.hooksPath x',
    'Get-Content C:\\Users\\Public\\x.txt', 'Get-Content ~\\.ssh\\id_rsa', 'Set-Content .git\\hooks\\pre-commit x', 'Stop-Process -Name node',
    'New-LocalUser bob', 'az group delete -n x --yes', 'pwsh -File .\\tools\\bad.ps1', 'pwsh -File .\\tools\\push.ps1',
    'Set-Content .\\.cop-tmp\\run.ps1 x',
  ]) t.truthy(`stays refused: ${cmd}`, reason(cmd, off) !== null, 'ran');
  t.check("in Kerrigan's chats, whose git is the operator's, push stays refused", [reason('git push', policyOf(cfg, HERS)) !== null, reason('git commit -m x', policyOf(cfg, HERS))], [true, null]);
  t.check('nobody watching and no isolation claimed: still not started', unattendedBlock({ ...off, isolation: 'none' }), 'isolation');
  t.check('no list, by the operator\'s choice: started; emptied otherwise: not', [unattendedBlock(off), unattendedBlock({ ...off, rulesIgnored: false })], [null, 'allowlist']);
  t.check("a reviewer's check: a program off the list too", [modelCheckRefusal('tzutil /g', 'pwsh', was, confinement) !== null, modelCheckRefusal('tzutil /g', 'pwsh', off, confinement)], [true, null]);
  const note = rulesNote(off as never) ?? '';
  t.truthy('the chat is told what holds, and what stands', /Any program may be started/.test(note) && /except its Git commands/.test(note) && /Do not hand commands over/.test(note) && /Everything else stands/.test(note), note);
  t.check('told nothing when the rules are in force', rulesNote(was as never), undefined);
  const manifest = collectPolicyManifest({ mode: 'unattended', allowedPrograms: off.allowedPrograms, denyPatterns: off.denyPatterns, cwd: repo, isolation: { claim: 'none-accepted', signals: {}, warnings: [] } as never, scripts: off.scripts, writtenScripts: off.writtenScripts, rulesIgnored: true });
  t.truthy('and the record of the run says so', /BY THE OPERATOR'S SETTING/.test(describePolicyManifest(manifest)), manifest.rulesIgnored);
}

console.log("\n--- an administrator's lock ---");
{
  const cfg = await load({ ignoreRules: 'always' });
  const locked = runRules({ ...cfg, policyLocks: [{ allowedPrograms: ['node'], denyPatterns: ['Remove-Item'], writtenScripts: 'never' }] }, PLAIN);
  t.check('its programs, its patterns and its word on scripts hold', [locked.allowedPrograms, locked.denyPatterns.includes('Remove-Item'), Object.values(locked.scripts).some((r) => r.written), locked.writtenScripts], [['node'], true, false, 'ask']);
  const note = rulesNote({ ...locked }) ?? '';
  t.check('and the chat is not told otherwise', [/Any program/.test(note), /runs the scripts/.test(note), /Do not hand/.test(note)], [false, false, false]);
  const dir = await mkdtemp(join(tmpdir(), 'cop-ignore-lock-'));
  writeFileSync(join(dir, 'policy.lock.json'), JSON.stringify({ allowedPrograms: ['node'] }));
  const read = runRules(await loadConfigObject({ execution: { ignoreRules: 'always' } }, dir), PLAIN);
  t.check('read from its file', read.allowedPrograms, ['node']);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n--- saved while a run goes on ---');
{
  const started = await load();
  const runOf = (run: typeof PLAIN): ResolvedConfig => ({ ...started, execution: { ...started.execution, ...runRules(started, run) } });
  const [hers, other] = [runOf(HERS), runOf({ chat: true, kerrigan: false })];
  const [liveHers, liveOther] = [new LiveSettings(hers, true, started, true), new LiveSettings(other, true, started, false)];
  const on = await load({ ignoreRules: 'kerrigan' });
  t.check('named as taken at once', [liveHers.take(on).now, liveOther.take(on).now], [['execution.ignoreRules'], ['execution.ignoreRules']]);
  t.check('on in hers, not in another', [hers.execution.rulesIgnored, hers.execution.allowedPrograms.length, other.execution.rulesIgnored, other.execution.allowedPrograms.length > 0], [true, 0, false, true]);
  // Another setting saved meanwhile does not bring the lists back.
  liveHers.take(await load({ ignoreRules: 'kerrigan', allowedPrograms: ['node', 'tzutil'] }));
  t.check('a list saved meanwhile is still passed over', hers.execution.allowedPrograms, []);
  liveHers.take(await load({ ignoreRules: 'never', allowedPrograms: ['node', 'tzutil'] }));
  t.check('and off again: the lists as saved', [hers.execution.rulesIgnored, hers.execution.allowedPrograms], [false, ['node', 'tzutil']]);
}

type Sent = { threadId: string };
type Card = { id: string; question?: { handoff?: { commands: string[]; warnings?: unknown[] } } };
type Ses = { tasks: Array<{ status: string; kerrigan?: { chats: string[] } }> };
async function scenario(title: string, settings: Record<string, unknown>, body: (h: Harness) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings });
  try {
    await body(h);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}
const ON = { mode: 'unattended', isolation: 'none-accepted', ignoreRules: 'kerrigan' };
const HAND = ['node tools/seed.js'];
const SEED = "New-Item -ItemType Directory -Force tools | Out-Null; Set-Content -Path tools/seed.js -Value 'console.log(40+2)'";

await scenario('in a chat Kerrigan directs: a program off the list, a script of the work, a handoff sent back as steps', { execution: ON }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Say the time zone and make a seed script.', model: 'Think deeper', kerrigan: true, chatModel: 'Think deeper' });
  let opening = '';
  let zone = '';
  let back = '';
  let ran = '';
  h.chat.script(
    reply.kerrigan.send(undefined, { understanding: 'Goal: the time zone and a seed script.', title: 'Zone and seed' }),
    (m) => {
      opening = [m.text, ...Object.values(m.attached)].join('\n');
      return reply.steps('tzutil /g', SEED);
    },
    (m) => {
      zone = [m.text, ...Object.values(m.attached)].join('\n');
      return reply.handoff(HAND, 'It prints 42.', { why: 'A script I wrote.' });
    },
    (m) => {
      back = m.text;
      return reply.steps(...HAND);
    },
    (m) => {
      ran = [m.text, ...Object.values(m.attached)].join('\n');
      return reply.done('tzutil printed the time zone, and node tools/seed.js ran and printed 42, as the steps show.');
    },
    reply.kerrigan.done('Done: the time zone was read and the seed script prints 42.'),
  );
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  await h.idle();
  t.truthy('the chat is told the rules are set aside', opening.includes('Rules the operator has set aside in this run'), opening.slice(-800));
  t.truthy('the program off the list ran', !/not in execution\.allowedPrograms/.test(zone), zone.slice(0, 1500));
  t.truthy('the handoff went back to the chat, not to the person', back.includes('Not shown to the operator') && back.includes('Send them as steps now'), back.slice(0, 400));
  t.truthy('and the script of the work ran', ran.includes('42') && !ran.includes('written during this work'), ran.slice(0, 1500));
  t.check('done, with no card', [(await h.call<Ses>('GET', `/sessions/${sent.threadId}`)).tasks[0]!.status, (await h.call<Card[]>('GET', '/approvals')).length], ['done', 0]);
});

await scenario('the same commands handed over again: the person is needed, and the card comes', { execution: { ...ON, ignoreRules: 'always' } }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Sign in.', model: 'Think deeper' });
  h.chat.script(
    reply.handoff(['node tools/login.js'], 'Signed in.', { why: 'To sign in.' }),
    reply.handoff(['node tools/login.js'], 'Signed in.', { why: 'Only the person can sign in.' }),
    reply.done('The operator ran the sign-in themselves, and it ended signed in, as they said.'),
  );
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  const card = await waitFor('the card', async () => (await h.call<Card[]>('GET', '/approvals')).find((a) => !!a.question?.handoff), 60_000);
  t.check('once back, then the card', card.question?.handoff?.commands, ['node tools/login.js']);
  await h.call('POST', `/approvals/${card.id}/answer`, { text: 'signed in' });
  await h.idle();
  t.check('and the work went on', (await h.call<Ses>('GET', `/sessions/${sent.threadId}`)).tasks[0]!.status, 'done');
});

await scenario('what would be refused even now is not sent back: it goes to the card', { execution: { ...ON, ignoreRules: 'always' } }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Push it.', model: 'Think deeper' });
  h.chat.script(
    reply.handoff(['git push origin main'], 'Pushed.', { why: 'Push is yours.' }),
    reply.done('The operator did not push; the branch is as it was, left for them to push from the Git view.'),
  );
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  const card = await waitFor('the card', async () => (await h.call<Card[]>('GET', '/approvals')).find((a) => !!a.question?.handoff), 60_000);
  t.check('with its line marked', card.question?.handoff?.warnings, [{ kind: 'git', line: 1, text: 'git push origin main' }]);
  await h.call('POST', `/approvals/${card.id}/answer`, { text: 'no', ran: false });
  await h.idle();
});

await scenario('for Kerrigan only: an ordinary chat is refused as before', { execution: ON }, async (h) => {
  const sent = await h.call<Sent>('POST', '/chat', { text: 'Say the time zone.', model: 'Think deeper' });
  let opening = '';
  let said = '';
  h.chat.script(
    (m) => {
      opening = [m.text, ...Object.values(m.attached)].join('\n');
      return reply.steps('tzutil /g');
    },
    (m) => {
      said = [m.text, ...Object.values(m.attached)].join('\n');
      return reply.steps('Get-TimeZone | Select-Object -ExpandProperty Id');
    },
    reply.done('Get-TimeZone printed the time zone this machine is set to, in the step above.'),
  );
  await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
  await h.idle();
  t.check('refused, and told nothing of rules set aside', [/not in execution\.allowedPrograms/.test(said), opening.includes('Rules the operator has set aside')], [true, false]);
});

t.finish();
