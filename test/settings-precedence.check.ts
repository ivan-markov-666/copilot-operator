/**
 * What is set in Settings outranks the same thing in a plan's JSON (operator's rule, 2026-10-06).
 *
 * A plan written by another chat named a model ("model", "review.model") that then overrode the model the
 * operator chose in Settings on every run. Now: the operator's own choice on the session's page or the run
 * panel first; then Settings; the plan's only when Settings name none.
 *
 *   npm run check:settings-precedence
 */
import { effectiveModels, modelByHand } from '../src/orchestrator/taskRunner.js';
import { startHarness, Tally } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
const cfg = (model: string, review = '') => ({ copilot: { defaultModel: model, defaultReviewModel: review } }) as never;

console.log('--- which model a session runs on ---');
{
  const plan = { model: 'Plan Model', modelSource: 'plan' as const, review: { enabled: true, model: 'Plan Reviewer' }, reviewModelSource: 'plan' as const };
  const e1 = effectiveModels(plan, cfg('Settings Model', 'Settings Reviewer'));
  t.check("the plan's model gives way to Settings", [e1.model, e1.modelFrom, e1.reviewModel, e1.reviewModelFrom], ['Settings Model', 'settings', 'Settings Reviewer', 'settings']);
  const e2 = effectiveModels(plan, cfg(''));
  t.check("the plan's model when Settings name none", [e2.model, e2.modelFrom, e2.reviewModel, e2.reviewModelFrom], ['Plan Model', 'plan', 'Plan Reviewer', 'plan']);
  const own = { model: 'Chosen Here', modelSource: 'operator' as const, review: { enabled: true, model: 'Reviewer Here' }, reviewModelSource: 'operator' as const };
  const e3 = effectiveModels(own, cfg('Settings Model', 'Settings Reviewer'));
  t.check("the operator's own choice on the session outranks Settings", [e3.model, e3.modelFrom, e3.reviewModel], ['Chosen Here', 'session', 'Reviewer Here']);
  const old = { model: 'Saved Before', review: { enabled: true, model: '' } };
  t.check('an older session, of unknown origin, follows Settings', effectiveModels(old, cfg('Settings Model')).model, 'Settings Model');
}

/*
 * Three models in Settings (operator, 2026-10-23: "Model for the worker, Model for the lead, Model for the review"):
 * the lead of two chats on the lead's, everyone else — the one chat, the worker of two chats — on the worker's; and
 * each part's own "by hand", the lead's and the review's as the worker's until they are set.
 */
console.log("\n--- the worker's, the lead's and the review's model, and each one's \"by hand\" ---");
{
  const three = (over: Record<string, unknown> = {}) => ({ copilot: { defaultModel: 'Worker Model', defaultLeadModel: 'Lead Model', defaultReviewModel: 'Review Model', manualModel: false, ...over } }) as never;
  t.check("the lead of two chats is on Settings' model for the lead", [effectiveModels({ lead: {} }, three()).model, effectiveModels({ lead: {} }, three()).modelFrom], ['Lead Model', 'settings']);
  t.check("the worker of two chats on Settings' model for the worker, not the lead's", effectiveModels({ workerOf: 's-lead' } as never, three()).model, 'Worker Model');
  t.check("the one chat on the worker's too", effectiveModels({}, three()).model, 'Worker Model');
  t.check("with no model for the lead, the lead is on the worker's, as before there were two", effectiveModels({ lead: {} }, three({ defaultLeadModel: '' })).model, 'Worker Model');
  t.check("the review on the review's", effectiveModels({ lead: {} }, three()).reviewModel, 'Review Model');
  const chat = { kind: 'chat' as const };
  t.check('"by hand": each part its own', [
    modelByHand({ ...chat, lead: {} }, three({ manualModel: true, leadManualModel: false })),
    modelByHand(chat, three({ manualModel: true, leadManualModel: false })),
    modelByHand({ ...chat, lead: {} }, three({ manualModel: false, leadManualModel: true })),
  ], [false, true, true]);
  t.check("the lead's, not set, is as the worker's", [modelByHand({ ...chat, lead: {} }, three({ manualModel: true })), modelByHand({ ...chat, lead: {} }, three({ manualModel: false }))], [true, false]);
}

console.log('\n--- two chats, run: the lead put on the lead\'s model, the worker on the worker\'s ---');
{
  const h = await startHarness({ settings: { execution: { mode: 'unattended', isolation: 'none-accepted' }, copilot: { manualModel: false, defaultModel: 'Auto', defaultLeadModel: 'Think deeper' } } });
  try {
    const sent = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create result.txt holding the word hello.', lead: true });
    h.chat.script(
      reply.lead.delegate(
        { title: 'Write result.txt', goal: 'Create result.txt at the root holding exactly the word hello.', readOnly: false, report: 'What Get-Content prints for the file.' },
        { understanding: 'Goal: a file result.txt holding hello. Done when the file is there and read back.', todo: [{ title: 'Write result.txt', status: 'running', phase: 'Work' }] },
      ),
      reply.steps("Set-Content -Path result.txt -Value 'hello' -Encoding utf8"),
      reply.done('I wrote result.txt and read it back: it holds hello.'),
      reply.lead.done(undefined, ['result.txt']),
    );
    await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
    await h.idle();
    t.check("the lead's conversation on Think deeper, the worker's on Auto", h.chat.modelRequests.slice(0, 2), ['Think deeper', 'Auto']);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log("\n--- two chats, no model for the worker in Settings: the worker on the lead's, chosen under the box ---");
{
  const h = await startHarness({ settings: { execution: { mode: 'unattended', isolation: 'none-accepted' }, copilot: { manualModel: false } } });
  try {
    const sent = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create result.txt holding the word hello.', model: 'Think deeper', lead: true });
    h.chat.script(
      reply.lead.delegate(
        { title: 'Write result.txt', goal: 'Create result.txt at the root holding exactly the word hello.', readOnly: false, report: 'What Get-Content prints for the file.' },
        { understanding: 'Goal: a file result.txt holding hello. Done when the file is there and read back.', todo: [{ title: 'Write result.txt', status: 'running', phase: 'Work' }] },
      ),
      reply.steps("Set-Content -Path result.txt -Value 'hello' -Encoding utf8"),
      reply.done('I wrote result.txt and read it back: it holds hello.'),
      reply.lead.done(undefined, ['result.txt']),
    );
    await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
    await h.idle();
    t.check("both conversations on Think deeper: the worker follows the lead's, as before Settings had one for each", h.chat.modelRequests.slice(0, 2), ['Think deeper', 'Think deeper']);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- a plan with a model, imported and run: the chat is put on the model in Settings ---');
{
  const h = await startHarness({ settings: { copilot: { defaultModel: 'Think deeper' } } });
  try {
    const [s] = await h.importPlan({
      version: 1,
      sessions: [{ name: 'plan-names-a-model', model: 'GPT 5.6 Think deeper', onFailure: 'stop', projectDir: h.repo, vcs: { enabled: false }, review: { enabled: false },
        tasks: [{ title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one.', checks: [{ name: 'a says one', expect: 'file-contains', file: 'a.txt', value: 'one' }] }] }],
    });
    const imported = await h.session(s!.id) as unknown as { model?: string; modelSource?: string };
    t.check("the plan's model is kept, marked as the plan's", [imported.model, imported.modelSource], ['GPT 5.6 Think deeper', 'plan']);
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done());
    await h.run(s!.id, 'unattended');
    t.check('the chat was put on the model in Settings, not the plan\'s', [h.chat.modelRequests[0], h.chat.currentModel], ['Think deeper', 'Think deeper']);
    const events = await h.call<Array<{ type: string; message: string }>>('GET', `/sessions/${s!.id}/events`);
    t.truthy('and the record says where it came from', events.some((e) => e.type === 'model-selected' && /from Settings/.test(e.message)), events.filter((e) => /model/.test(e.type)));

    // Chosen on the session's page: the operator's own, which then outranks Settings.
    await h.call('PUT', `/sessions/${s!.id}`, { model: 'GPT 5.6 Think deeper' });
    const chosen = await h.session(s!.id) as unknown as { modelSource?: string };
    t.check('a model chosen on the session\'s page is the operator\'s', chosen.modelSource, 'operator');
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

t.finish();
