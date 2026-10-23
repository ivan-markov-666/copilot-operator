/**
 * Who works, and who asks, end to end through the API with the scripted chat of test/support/fakeChat.ts (operator,
 * 2026-10-22: "show clearly what the bot is doing and who works — plan mode, the lead, the worker, the reviewer; on
 * the cards to choose a model or to allow a command, say clearly who asks"):
 *
 * - plan mode, then the work, then the review, in a run that asks before each command: every card says who asks — a
 *   command while planning the plan, the plan itself the plan, a command of the work the worker, a command of the
 *   review the reviewer — and the task and `/activity` say who is at work at each card; nothing is said once it ended;
 * - two chats, the model chosen by hand: the lead's model card is the lead's, the worker's the worker's; a worker's
 *   command is the worker's, while the lead's message says the worker is at work on subtask 1; the lead's question is
 *   the lead's, and the lead is at work again;
 * - the model card the bot raises when it could not choose the model says whose conversation it is too.
 *
 *   npm run check:e2e-actors
 */
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
type Card = { id: string; sessionId: string; taskId: string; stepId: number; description: string; actor?: string; plan?: unknown; model?: { review?: boolean; role?: string }; question?: { text: string } };
type Acting = { actor: string; subtask?: number; round?: number };
type Activity = { running: boolean; starting: boolean; acting?: Acting; last?: { status: string } };
type Task = { id: string; status: string; acting?: Acting };

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

const card = (h: Harness, what: string, pick: (c: Card) => boolean): Promise<Card> =>
  waitFor(what, async () => (await h.call<Card[]>('GET', '/approvals')).find(pick), 60_000);
const taskNow = async (h: Harness, sessionId: string, taskId?: string): Promise<Task> => {
  const s = await h.call<{ tasks: Task[] }>('GET', `/sessions/${sessionId}`);
  return (taskId ? s.tasks.find((x) => x.id === taskId) : s.tasks[0])!;
};
const activity = (h: Harness): Promise<Activity> => h.call<Activity>('GET', '/activity');
const actingOf = (a?: Acting): unknown => (a ? [a.actor, a.subtask ?? a.round ?? null] : null);

await scenario('plan mode, the work, the review: every card says who asks, and the bot who is at work', { execution: { planMode: 'approve' } }, async (h) => {
  const [s] = await h.importPlan({
    version: 1,
    sessions: [
      {
        name: 'who-asks',
        onFailure: 'stop',
        vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'who-asks' },
        review: { enabled: true },
        tasks: [
          {
            title: 'write-result',
            prompt: 'Create result.txt in the repository root holding exactly the text finished, and nothing else.',
            checks: [{ name: 'result.txt written', expect: 'file-contains', file: 'result.txt', value: 'finished' }],
          },
        ],
      },
    ],
  });
  h.chat.script(
    reply.steps('Get-ChildItem -Name'),
    reply.plan(),
    reply.steps("Set-Content -Path result.txt -Value 'finished' -Encoding utf8"),
    reply.done(),
    reply.steps('Get-Content result.txt'),
    reply.pass(),
  );
  t.check('it starts, asking before each command', (await h.call<{ started: boolean }>('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' })).started, true);

  const looking = await card(h, 'the command run while planning', (c) => c.description.includes('Get-ChildItem'));
  t.check('a command while planning: asked by plan mode', looking.actor, 'plan');
  t.check('and the task and the bot say plan mode is at work', [actingOf((await taskNow(h, s!.id)).acting), actingOf((await activity(h)).acting)], [['plan', null], ['plan', null]]);
  await h.call('POST', `/approvals/${looking.id}`, { action: 'run' });

  const plan = await card(h, 'the plan', (c) => !!c.plan);
  t.check('the plan: asked by plan mode', plan.actor, 'plan');
  await h.call('POST', `/approvals/${plan.id}/plan`, { action: 'approve' });

  const writing = await card(h, 'the command of the work', (c) => c.description.includes('Set-Content'));
  t.check('a command of the work, the plan approved: asked by the worker', writing.actor, 'worker');
  t.check('and the worker is at work', [actingOf((await taskNow(h, s!.id)).acting), actingOf((await activity(h)).acting)], [['worker', null], ['worker', null]]);
  await h.call('POST', `/approvals/${writing.id}`, { action: 'run' });

  const reading = await card(h, 'the command of the review', (c) => c.description.includes('Get-Content'));
  t.check("a command of the review: asked by the reviewer", reading.actor, 'review');
  t.check('and the reviewer is at work, in round 1', [actingOf((await taskNow(h, s!.id)).acting), actingOf((await activity(h)).acting)], [['review', 1], ['review', 1]]);
  await h.call('POST', `/approvals/${reading.id}`, { action: 'run' });

  await h.idle();
  const done = await taskNow(h, s!.id);
  t.check('done, and nobody is said to be at work any more', [done.status, done.acting, (await activity(h)).acting], ['done', undefined, undefined]);
  // How the message ended, for the tab to say it (2026-10-23).
  t.check('the bot says how the last message ended: done', (await activity(h)).last?.status, 'done');
  const said = (await h.call<Array<{ type: string; data?: Acting }>>('GET', `/sessions/${s!.id}/events`)).filter((e) => e.type === 'acting').map((e) => e.data?.actor);
  t.check('the events say who, in turn', said, ['plan', 'worker', 'review', 'worker']);
});

await scenario('two chats, the model by hand: the lead asks for its model, the worker for its own, each card says whose', { execution: { mode: 'confirm' }, copilot: { manualModel: true } }, async (h) => {
  const sent = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create result.txt holding the word hello.', lead: true });
  const leadId = sent.threadId;
  h.chat.script(
    reply.lead.delegate(
      { title: 'Write result.txt', goal: 'Create result.txt at the root holding exactly the word hello.', readOnly: false, report: 'What Get-Content prints for the file.' },
      { understanding: 'Goal: a file result.txt holding hello. Done when the file is there and read back.', todo: [{ title: 'Write result.txt', status: 'running', phase: 'Work' }] },
    ),
    reply.steps("Set-Content -Path result.txt -Value 'hello' -Encoding utf8"),
    reply.done('I wrote result.txt and read it back: it holds hello.'),
    reply.lead.ask('Should the file end with a new line?', [], { todo: [{ title: 'Write result.txt', status: 'done', phase: 'Work' }] }),
    reply.lead.done(undefined, ['result.txt']),
  );
  t.check('it starts', (await h.call<{ started: boolean }>('POST', `/sessions/${leadId}/start`, { mode: 'confirm' })).started, true);

  const leadModel = await card(h, "the lead's model card", (c) => !!c.model && c.sessionId === leadId);
  t.check("the lead's model card: asked by the lead", [leadModel.actor, leadModel.model?.role], ['lead', 'lead']);
  await h.call('POST', `/approvals/${leadModel.id}`, { action: 'run' });

  const workerModel = await card(h, "the worker's model card", (c) => !!c.model && c.sessionId !== leadId);
  t.check("the worker's model card: asked by the worker", [workerModel.actor, workerModel.model?.role], ['worker', 'worker']);
  t.check("while the lead's message says the worker is at work on subtask 1", [actingOf((await taskNow(h, leadId)).acting), actingOf((await activity(h)).acting)], [['worker', 1], ['worker', 1]]);
  await h.call('POST', `/approvals/${workerModel.id}`, { action: 'run' });

  const step = await card(h, "the worker's command", (c) => c.description.includes('Set-Content'));
  t.check("the worker's command: asked by the worker", step.actor, 'worker');
  await h.call('POST', `/approvals/${step.id}`, { action: 'run' });

  const asked = await card(h, "the lead's question", (c) => !!c.question);
  t.check("the lead's question: asked by the lead", asked.actor, 'lead');
  t.check('and the lead is at work again', [actingOf((await taskNow(h, leadId)).acting), actingOf((await activity(h)).acting)], [['lead', null], ['lead', null]]);
  await h.call('POST', `/approvals/${asked.id}/answer`, { text: 'No new line.' });

  await h.idle();
  const done = await taskNow(h, leadId);
  t.check('done, and nobody is said to be at work any more', [done.status, done.acting, (await activity(h)).acting], ['done', undefined, undefined]);
});

await scenario('the model the bot could not choose: the card says whose conversation it is', { copilot: { defaultModel: 'GPT 9 Imaginary' }, execution: { planMode: 'auto' } }, async (h) => {
  const [s] = await h.importPlan({
    version: 1,
    sessions: [{ name: 'no-such-model', onFailure: 'stop', projectDir: h.repo, vcs: { enabled: false }, review: { enabled: false }, tasks: [{ title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one, and nothing else.' }] }],
  });
  await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  const asked = await card(h, 'the model card', (c) => !!c.model);
  t.check('a session that plans first: asked by plan mode, its first message being the plan', asked.actor, 'plan');
  await h.call('POST', `/approvals/${asked.id}`, { action: 'abort' });
  await h.idle();
});

t.finish();
