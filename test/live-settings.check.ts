/**
 * Settings saved while a message is at work (operator, 2026-11-03: "when I change a setting in Settings, if it can be,
 * let it take effect at once, even while a task is running").
 *
 * - `LiveSettings`: what a save changes at once in the run's own settings, in place, and what it only names — for the
 *   next message, or the next time the chat window opens; a save names its own change, not an earlier one's; the chat's
 *   deny patterns stay the chat's; those who listen hear only of what is taken at once.
 * - End to end through the API, with the scripted chat: a program the allowlist refuses, added in Settings while the
 *   task runs, runs at the next step; the save says what it did; the chat is told; the record says so and keeps the
 *   rules in force beside the first ones; a setting for the next message is named, not taken; with nothing running,
 *   nothing is said.
 *
 *   npm run check:live-settings
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveSettings, mergedChange } from '../src/config/live.js';
import { chatDenyPatterns, loadConfigObject, type ResolvedConfig } from '../src/config/schema.js';
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

console.log('--- what a save changes at once, and what it only names ---');
{
  const base = await mkdtemp(join(tmpdir(), 'cop-live-'));
  const load = async (over: Record<string, unknown> = {}): Promise<ResolvedConfig> => await loadConfigObject(over, base);
  const started = await load();
  const runCfg = { ...started, execution: { ...started.execution, mode: 'unattended' as const } } as ResolvedConfig;
  const limitsBefore = runCfg.limits;
  const live = new LiveSettings(runCfg, false, started);
  const heard: string[][] = [];
  live.onChange((c) => heard.push(c.now));
  const asSaved = {
    execution: { allowedPrograms: [...started.execution.allowedPrograms, 'tzutil'], planMode: started.execution.planMode === 'off' ? 'auto' : 'off', mode: started.execution.mode === 'confirm' ? 'unattended' : 'confirm' },
    limits: { maxIterations: started.limits.maxIterations + 7, maxSubtasks: (started.limits.maxSubtasks ?? 20) + 1 },
    copilot: { replyTimeoutSec: started.copilot.replyTimeoutSec + 60 },
  };
  // The run's sections are the loaded settings' own objects too, as in a start: read the old value before the save.
  const iterationsAtStart = started.limits.maxIterations;
  const saved = await load(asSaved);
  const change = live.take(saved);
  t.check(
    'named by kind: the allowlist and the limit at once; plan mode, the standing mode and the subtasks next; the reply wait with the window',
    [change.now.sort(), change.next.sort(), change.window],
    [['execution.allowedPrograms', 'limits.maxIterations'], ['execution.mode', 'execution.planMode', 'limits.maxSubtasks'], ['copilot.replyTimeoutSec']],
  );
  t.check('taken in place: the run\'s own objects hold the new values', [runCfg.execution.allowedPrograms.includes('tzutil'), runCfg.limits.maxIterations, runCfg.limits === limitsBefore], [true, iterationsAtStart + 7, true]);
  t.check('only named: plan mode, the run\'s mode, the subtasks and the reply wait are as the run began', [runCfg.execution.planMode, runCfg.execution.mode, runCfg.limits.maxSubtasks, runCfg.copilot.replyTimeoutSec], [started.execution.planMode, 'unattended', started.limits.maxSubtasks, started.copilot.replyTimeoutSec]);
  t.check('those who listen heard it once, with what was taken', heard, [['execution.allowedPrograms', 'limits.maxIterations']]);
  const paced = { ...asSaved, pacing: { settleMs: started.pacing.settleMs + 250 } };
  const again = live.take(await load(paced));
  t.check('a later save names its own change, not the ones before it', again, { now: ['pacing.settleMs'], next: [], window: [] });
  const same = live.take(await load(paced));
  t.check('a save that changes nothing names nothing, and nobody hears of it', [same, heard.length], [{ now: [], next: [], window: [] }, 2]);

  const chatCfg = { ...started, execution: { ...started.execution, denyPatterns: chatDenyPatterns(started.execution.denyPatterns) } } as ResolvedConfig;
  const chat = new LiveSettings(chatCfg, true, started);
  const extra = [...started.execution.denyPatterns, 'Remove-Item\\s+-Recurse\\s+C:\\\\'];
  chat.take(await load({ execution: { denyPatterns: extra } }));
  t.check("a chat's deny patterns are taken as the chat's: its git stays the operator's", chatCfg.execution.denyPatterns, chatDenyPatterns(extra));
  t.check('several runs\' changes together, each name once', mergedChange([{ now: ['a', 'b'], next: ['c'], window: [] }, { now: ['b'], next: [], window: ['d'] }]), { now: ['a', 'b'], next: ['c'], window: ['d'] });
}

type Saved = { ok: boolean; running: number; now: string[]; next: string[]; window: string[] };
type Raw = { raw: Record<string, Record<string, unknown> | undefined>; programs?: { inForce: string[] } };

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

const plan = (h: Harness, name: string) => ({
  version: 1,
  sessions: [{ name, onFailure: 'stop', projectDir: h.repo, vcs: { enabled: false }, review: { enabled: false },
    tasks: [{ title: 'time zone', prompt: 'Say which time zone this machine is set to.' }] }],
});
const ZONE = 'tzutil /g';

await scenario('a program refused, added in Settings while the task runs: the next step runs it, and the chat is told', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'live-allowlist'));
  let refusal = '';
  let savedNow = null as Saved | null;
  let savedNext = null as Saved | null;
  let told = '';
  h.chat.script(
    reply.steps(ZONE),
    async (m) => {
      refusal = [m.text, ...Object.values(m.attached)].join('\n');
      const got = await h.call<Raw>('GET', '/settings');
      const inForce = got.programs?.inForce ?? [];
      savedNow = await h.call<Saved>('PUT', '/settings', { ...got.raw, execution: { ...(got.raw.execution ?? {}), allowedPrograms: [...inForce, 'tzutil'] } });
      const after = await h.call<Raw>('GET', '/settings');
      savedNext = await h.call<Saved>('PUT', '/settings', { ...after.raw, execution: { ...(after.raw.execution ?? {}), stopOnFailure: !(after.raw.execution?.stopOnFailure ?? false) } });
      return reply.steps(ZONE);
    },
    (m) => {
      told = [m.text, ...Object.values(m.attached)].join('\n');
      return reply.done('The machine is set to the time zone tzutil printed; the operator let the runner start tzutil while the task ran, and the step ran.');
    },
  );
  await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  await h.idle();
  t.truthy('first refused: tzutil is not among the programs the bot may start', /"tzutil" is not in execution\.allowedPrograms/.test(refusal), refusal.slice(0, 400));
  t.check('the save said so: one run at work, the allowlist in force at once', [savedNow?.running, savedNow?.now, savedNow?.next, savedNow?.window], [1, ['execution.allowedPrograms'], [], []]);
  t.check('a setting for the next message is named, not taken', [savedNext?.running, savedNext?.now, savedNext?.next], [1, [], ['execution.stopOnFailure']]);
  t.truthy('the next step ran it: what it printed reached the chat, not a refusal', !/not in execution\.allowedPrograms/.test(told) && /tzutil/.test(told), told.slice(0, 600));
  t.truthy('the chat was told the operator changed what steps are judged by', told.includes('The operator changed Settings while this task runs: allowedPrograms'), told.slice(0, 600));
  const task = (await h.session(s!.id)).tasks[0]!;
  t.check('and the work went on to its end', task.status, 'done');
  const events = await h.call<Array<{ type: string; data?: { now?: string[] } }>>('GET', `/sessions/${s!.id}/events`);
  t.check('the record says what was taken while it ran', events.filter((e) => e.type === 'settings-changed').map((e) => e.data?.now), [['execution.allowedPrograms']]);
  const runDir = join(h.runsDir, task.runId ?? '');
  const first = JSON.parse(readFileSync(join(runDir, 'policy.json'), 'utf8')) as { allowlist: { count: number } };
  const second = existsSync(join(runDir, 'policy-2.json')) ? (JSON.parse(readFileSync(join(runDir, 'policy-2.json'), 'utf8')) as { allowlist: { count: number } }) : null;
  t.check('the rules in force are kept beside the first ones, with the program added', second ? second.allowlist.count - first.allowlist.count : null, 1);
  t.truthy('the transcript says the rules changed', readdirSync(runDir).some((f) => /transcript|task-log/i.test(f) && /POLICY CHANGED \(2\)/.test(readFileSync(join(runDir, f), 'utf8'))), readdirSync(runDir));
});

await scenario('nothing at work: a save says nothing runs', {}, async (h) => {
  const got = await h.call<Raw>('GET', '/settings');
  const saved = await h.call<Saved>('PUT', '/settings', { ...got.raw, limits: { ...(got.raw.limits ?? {}), maxIterations: 33 } });
  t.check('saved, nothing running, nothing taken', [saved.ok, saved.running, saved.now, saved.next, saved.window], [true, 0, [], [], []]);
  await waitFor('the setting saved', async () => (await h.call<Raw>('GET', '/settings')).raw.limits?.maxIterations === 33, 5_000);
});

t.finish();
