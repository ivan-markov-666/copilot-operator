/**
 * When the runner cannot put the chat on the chosen model, it asks the operator to choose it in the
 * Copilot window and waits on a card (operator's request, 2026-10-06). Against the scripted chat.
 *
 *   npm run check:model-help
 */
import { startHarness, Tally, waitFor, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
type Approval = { id: string; model?: { asked: string; shown: string | null; why: string; tries: number } };

const plan = (h: Harness) => ({
  version: 1,
  sessions: [{ name: 'needs-a-hand', onFailure: 'stop', projectDir: h.repo, vcs: { enabled: false }, review: { enabled: false },
    tasks: [{ title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one.', checks: [{ name: 'a says one', expect: 'file-contains', file: 'a.txt', value: 'one' }] }] }],
});
const card = (h: Harness): Promise<Approval> =>
  waitFor('the card asking for the model', async () => (await h.call<Approval[]>('GET', '/approvals')).find((a) => !!a.model), 60_000);

console.log('--- the operator chooses it in the Copilot window, then presses "check and continue" ---');
{
  const h = await startHarness({ settings: { copilot: { defaultModel: 'GPT 9 Imaginary' } } });
  try {
    const [s] = await h.importPlan(plan(h));
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done());
    await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
    const first = await card(h);
    t.check('the card names the model and what the picker shows, even in an unattended run', [first.model?.asked, first.model?.shown, first.model?.tries], ['GPT 9 Imaginary', 'Auto', 1]);
    t.check('nothing was sent while it waits', h.chat.sent.length, 0);

    // Pressed before choosing it: the runner looks, and asks again.
    await h.call('POST', `/approvals/${first.id}`, { action: 'run' });
    const second = await waitFor('asked again', async () => (await h.call<Approval[]>('GET', '/approvals')).find((a) => !!a.model && a.id !== first.id), 60_000);
    t.check('pressed with the picker still on Auto: asked again, saying so', [second.model?.tries, /still shows "Auto"/.test(second.model?.why ?? '')], [2, true]);

    // Chosen by hand in the Copilot window, then pressed.
    h.chat.currentModel = 'GPT 9 Imaginary';
    await h.call('POST', `/approvals/${second.id}`, { action: 'run' });
    await h.idle();
    const v = await h.session(s!.id) as unknown as { modelInUse?: string; tasks: Array<{ status: string }> };
    t.check('the run goes on, on that model', [v.tasks[0]!.status, v.modelInUse], ['done', 'GPT 9 Imaginary']);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- "continue on the model it is on", and "stop" ---');
{
  const h = await startHarness({ settings: { copilot: { defaultModel: 'GPT 9 Imaginary' } } });
  try {
    const [s] = await h.importPlan(plan(h));
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done());
    await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
    await h.call('POST', `/approvals/${(await card(h)).id}`, { action: 'skip' });
    await h.idle();
    const v = await h.session(s!.id) as unknown as { modelInUse?: string; tasks: Array<{ status: string }> };
    const events = await h.call<Array<{ type: string }>>('GET', `/sessions/${s!.id}/events`);
    t.check('it goes on, on Auto, and says so', [v.tasks[0]!.status, v.modelInUse, events.some((e) => e.type === 'model-help-continue')], ['done', 'Auto', true]);

    const [s2] = await h.importPlan({ ...plan(h), sessions: [{ ...plan(h).sessions[0]!, name: 'stopped-for-a-model' }] });
    const sent = h.chat.sent.length;
    await h.call('POST', `/sessions/${s2!.id}/start`, { mode: 'unattended' });
    await h.call('POST', `/approvals/${(await card(h)).id}`, { action: 'abort' });
    await h.idle();
    const v2 = await h.session(s2!.id) as unknown as { tasks: Array<{ status: string }> };
    const ev2 = await h.call<Array<{ type: string }>>('GET', `/sessions/${s2!.id}/events`);
    t.check('"stop": nothing sent, the task stays queued, the run says why', [h.chat.sent.length - sent, v2.tasks[0]!.status, ev2.some((e) => e.type === 'run-failed')], [0, 'queued', true]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

t.finish();
