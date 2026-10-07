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

    // Since 2026-10-07 the operator's word is taken: the button's text could not be relied on at work.
    // Pressed with the picker on another model, the run goes on, and the record says what the button read.
    await h.call('POST', `/approvals/${first.id}`, { action: 'run' });
    await h.idle();
    const v = await h.session(s!.id) as unknown as { modelInUse?: string; tasks: Array<{ status: string }> };
    const events = await h.call<Array<{ type: string; message: string }>>('GET', `/sessions/${s!.id}/events`);
    t.check('"I chose it": the run goes on, on the operator\'s word', [v.tasks[0]!.status, (await h.call<Approval[]>('GET', '/approvals')).length], ['done', 0]);
    t.truthy('and the record says what the button read', events.some((e) => e.type === 'model-help-taken-on-word' && /reads "Auto"/.test(e.message)), events.filter((e) => /model/.test(e.type)));
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

console.log('\n--- Settings: choose the model by hand (the workaround, 2026-10-06) ---');
{
  const h = await startHarness({ settings: { copilot: { defaultModel: 'Think deeper', manualModel: true } } });
  try {
    const [s] = await h.importPlan(plan(h));
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done());
    await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
    const ask = await card(h);
    t.check('a card for the model, the picker untouched', [ask.model?.asked, (ask.model as { manual?: boolean } | undefined)?.manual, h.chat.modelRequests.length, h.chat.sent.length], ['Think deeper', true, 0, 0]);
    h.chat.currentModel = 'Think deeper';
    await h.call('POST', `/approvals/${ask.id}`, { action: 'run' });
    await h.idle();
    const v = await h.session(s!.id) as unknown as { modelInUse?: string; tasks: Array<{ status: string }> };
    t.check('"Ready": checked on the picker, the run goes on', [v.tasks[0]!.status, v.modelInUse, h.chat.modelRequests.length], ['done', 'Think deeper', 0]);

    // A conversation already on the model is not asked about.
    const [s2] = await h.importPlan({ ...plan(h), sessions: [{ ...plan(h).sessions[0]!, name: 'already-on-it' }] });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done());
    await h.run(s2!.id, 'unattended');
    const v2 = await h.session(s2!.id) as unknown as { tasks: Array<{ status: string }> };
    t.check('the picker already on the model: no card, the run goes straight on', [v2.tasks[0]!.status, (await h.call<Approval[]>('GET', '/approvals')).length], ['done', 0]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}
{
  const h = await startHarness({ settings: { copilot: { manualModel: true } } });
  try {
    const [s] = await h.importPlan(plan(h));
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done());
    await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
    const ask = await card(h);
    t.check('no model in Settings: the card asks for whichever the operator wants', [ask.model?.asked, (ask.model as { manual?: boolean } | undefined)?.manual], ['', true]);
    h.chat.currentModel = 'GPT 5.6 Think deeper';
    await h.call('POST', `/approvals/${ask.id}`, { action: 'run' });
    await h.idle();
    const v = await h.session(s!.id) as unknown as { modelInUse?: string; tasks: Array<{ status: string }> };
    t.check('the run goes on, on the model chosen', [v.tasks[0]!.status, v.modelInUse], ['done', 'GPT 5.6 Think deeper']);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

t.finish();
