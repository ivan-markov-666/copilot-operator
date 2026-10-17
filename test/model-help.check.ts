/**
 * When the runner cannot put the chat on the chosen model, it asks the operator to choose it in the
 * Copilot window and waits on a card (operator's request, 2026-10-06). Against the scripted chat.
 *
 *   npm run check:model-help
 */
import { startHarness, Tally, waitFor, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';
import { RunConfigSchema } from '../src/config/schema.js';

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

// Leave the automatic choice for now, and work with the model chosen by hand (operator, 2026-10-17): the default.
t.check('the model is chosen by hand unless Settings say otherwise', RunConfigSchema.parse({}).copilot.manualModel, true);

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

    /*
     * The next run in the same conversation is not asked again, even when the picker button reads otherwise: at
     * work its text could not be relied on to show the model chosen by hand (2026-10-07, 2026-10-17).
     */
    await h.call('POST', `/sessions/${s!.id}/tasks`, { title: 'write b', prompt: 'Write b.txt in the project folder holding exactly the word two.' });
    h.chat.currentModel = 'GPT-5.6 Sol Think';
    h.chat.script(reply.steps("Set-Content -Path b.txt -Value 'two'"), reply.done());
    await h.run(s!.id, 'unattended');
    const again = await h.session(s!.id) as unknown as { tasks: Array<{ status: string }> };
    const kept = (await h.call<Array<{ type: string }>>('GET', `/sessions/${s!.id}/events`)).filter((e) => e.type === 'model-kept-by-hand').length;
    t.check('the next run in that conversation: no card, the picker untouched, on record as set by hand', [again.tasks[1]!.status, (await h.call<Approval[]>('GET', '/approvals')).length, h.chat.modelRequests.length, kept], ['done', 0, 0, 1]);
    h.chat.currentModel = 'Think deeper';

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

/*
 * The chat's own "Set the model by hand" (2026-10-17, it replaced "Whatever the chat is on"): after signing in the run
 * waits on the card while the operator chooses the model in the Copilot window, then goes on when "Ready" is pressed.
 * Once per conversation: the next message in it is not asked again; another choice of model, or a new conversation, is.
 */
console.log('\n--- the chat: "Set the model by hand", asked once per conversation ---');
{
  // A model in Settings, so the choice by hand is seen to outrank it.
  const h = await startHarness({ settings: { copilot: { defaultModel: 'Think deeper' } } });
  type Chat = { modelInUse?: string; manualModel?: boolean; modelByHand?: { shown: string | null }; tasks: Array<{ status: string }> };
  const asked = async (id: string): Promise<number> =>
    (await h.call<Array<{ type: string }>>('GET', `/sessions/${id}/events`)).filter((e) => e.type === 'model-help-asked').length;
  const say = async (threadId: string, text: string, file: string): Promise<void> => {
    await h.call('POST', '/chat', { text, threadId });
    h.chat.script(reply.steps(`Set-Content -Path ${file} -Value 'x'`), reply.done());
    await h.call('POST', `/sessions/${threadId}/start`, { mode: 'unattended' });
  };
  try {
    const { threadId } = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Write a.txt holding x.', manualModel: true });
    t.check('the conversation is set to "by hand"', (await h.call<Chat>('GET', `/sessions/${threadId}`)).manualModel, true);
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'x'"), reply.done());
    await h.call('POST', `/sessions/${threadId}/start`, { mode: 'unattended' });
    const ask = await card(h);
    t.check(
      'signed in, it waits: a card for any model, the picker untouched, nothing sent — Settings\' model not chosen',
      [ask.model?.asked, (ask.model as { manual?: boolean } | undefined)?.manual, h.chat.modelRequests.length, h.chat.sent.length],
      ['', true, 0, 0],
    );
    h.chat.currentModel = 'GPT 5.6 Sol Think deeper';
    await h.call('POST', `/approvals/${ask.id}`, { action: 'run' });
    await h.idle();
    let v = await h.call<Chat>('GET', `/sessions/${threadId}`);
    t.check('"Ready": the message runs on the model chosen by hand, and that is on the record', [v.tasks[0]!.status, v.modelInUse, v.modelByHand?.shown], ['done', 'GPT 5.6 Sol Think deeper', 'GPT 5.6 Sol Think deeper']);

    await say(threadId, 'Now b.txt holding x.', 'b.txt');
    await h.idle();
    v = await h.call<Chat>('GET', `/sessions/${threadId}`);
    const events = await h.call<Array<{ type: string }>>('GET', `/sessions/${threadId}/events`);
    t.check('the next message, in the same conversation: not asked again, the picker still untouched', [v.tasks[1]!.status, await asked(threadId), events.some((e) => e.type === 'model-kept-by-hand'), h.chat.modelRequests.length], ['done', 1, true, 0]);

    await h.call('PUT', `/sessions/${threadId}`, { model: 'Think deeper', manualModel: false });
    await h.call('PUT', `/sessions/${threadId}`, { model: '', manualModel: true });
    t.check('another choice of model forgets what was set by hand', (await h.call<Chat>('GET', `/sessions/${threadId}`)).modelByHand, undefined);
    await say(threadId, 'Then c.txt holding x.', 'c.txt');
    const again = await card(h);
    t.check('and the next message asks again', [(again.model as { manual?: boolean } | undefined)?.manual, await asked(threadId)], [true, 2]);
    await h.call('POST', `/approvals/${again.id}`, { action: 'run' });
    await h.idle();
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}
{
  // No model anywhere: the chat's picker shows "by hand", and that is what happens.
  const h = await startHarness();
  try {
    const { threadId } = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Write a.txt holding x.' });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'x'"), reply.done());
    await h.call('POST', `/sessions/${threadId}/start`, { mode: 'unattended' });
    const ask = await card(h);
    t.check('a chat with no model of its own and none in Settings is set by hand', [ask.model?.asked, (ask.model as { manual?: boolean } | undefined)?.manual, h.chat.sent.length], ['', true, 0]);
    await h.call('POST', `/approvals/${ask.id}`, { action: 'run' });
    await h.idle();
    t.check('and runs once "Ready" is pressed', (await h.session(threadId)).tasks[0]!.status, 'done');
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}
/*
 * Stop pressed while the bot is still trying to put the chat on the model (2026-10-17: "the Stop button seems not to
 * work"): the attempts can take minutes, and the Stop waited for them. It ends the choice at once, sends nothing, puts
 * up no card, and is said as a stop, not as a failure.
 */
console.log('\n--- Stop while the model is being chosen ---');
{
  const h = await startHarness({ settings: { copilot: { defaultModel: 'Think deeper' } } });
  try {
    const [s] = await h.importPlan(plan(h));
    h.chat.modelPickMs = 120_000;
    await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
    await waitFor('the model to be asked for', async () => h.chat.modelRequests.length === 1, 30_000);
    const pressed = Date.now();
    await h.call('POST', `/sessions/${s!.id}/stop`);
    await h.idle();
    const tookMs = Date.now() - pressed;
    const v = await h.session(s!.id);
    const events = await h.call<Array<{ type: string; level?: string }>>('GET', `/sessions/${s!.id}/events`);
    t.truthy('the run ends at once, not when the choice would have', tookMs < 10_000, `${tookMs} ms`);
    t.check('nothing sent, no card, the task still queued', [h.chat.sent.length, (await h.call<Approval[]>('GET', '/approvals')).length, v.tasks[0]!.status], [0, 0, 'queued']);
    t.check('said as a stop, not as a failure', [events.some((e) => e.type === 'run-failed' || e.type === 'session-error'), events.some((e) => e.type === 'model-help-asked')], [false, false]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}
{
  // A model in Settings and none chosen in the chat: Settings' model, chosen by the bot, no card.
  const h = await startHarness({ settings: { copilot: { defaultModel: 'Think deeper' } } });
  try {
    const { threadId } = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Write a.txt holding x.' });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'x'"), reply.done());
    const v = await h.run(threadId);
    t.check('"As in Settings": chosen by the bot, no card', [v.tasks[0]!.status, h.chat.modelRequests, (await h.call<Approval[]>('GET', '/approvals')).length], ['done', ['Think deeper'], 0]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

t.finish();
