/**
 * Plan mode, end to end through the API, with the scripted chat of test/support/fakeChat.ts in place
 * of Copilot (asked for on 2026-10-13). No browser, no Microsoft 365.
 *
 * - "auto": the task opens read-only; a change made while planning is put back and the chat told; "done"
 *   before a plan is sent back; the plan is approved by the runner, recorded on the task, and given to
 *   the reviewer to check the work against;
 * - "approve" in a run that asks before each command: the plan waits on an approval card; asking for
 *   another needs a note, which reaches the chat; the next version is approved with a note;
 * - "approve" in an unattended run: approved by the runner, which says why, and nothing waits;
 * - the operator stopping the task at its plan;
 * - a session's own setting outranks Settings, from the import and from the session page;
 * - a task carried on with a new prompt plans no more, and its reviewer still gets the plan.
 *
 *   npm run check:e2e-planmode
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, waitFor, Tally, type Harness, type TaskView } from './support/harness.js';
import { reply } from './support/fakeChat.js';
import { PLAN_FIRST, planForReviewer } from '../src/orchestrator/planMode.js';

const t = new Tally();

type Plan = {
  version: number;
  steps: string[];
  files: string[];
  approved?: { by: string; note?: string; why?: string };
  revisions?: Array<{ version: number; comment: string }>;
};
type Full = TaskView & { plan?: Plan; attempts?: Array<{ status: string; plan?: Plan }> };
type Approval = { id: string; sessionId: string; taskId?: string; plan?: { title: string; plan: Plan } };

function session(h: Harness, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    onFailure: 'stop',
    vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: name },
    review: { enabled: false },
    tasks: [
      {
        title: 'write-result',
        prompt: 'Create result.txt in the repository root holding exactly the text finished, and nothing else.',
        checks: [{ name: 'result.txt written', expect: 'file-contains', file: 'result.txt', value: 'finished' }],
      },
    ],
    ...extra,
  };
}

const write = (file: string, text: string): string => reply.steps(`Set-Content -Path ${file} -Value '${text}' -Encoding utf8`);
const taskOf = async (h: Harness, sessionId: string): Promise<Full> => (await h.session(sessionId)).tasks[0] as Full;
const events = (h: Harness, sessionId: string): Promise<Array<{ type: string; data?: Record<string, unknown> }>> =>
  h.call('GET', `/sessions/${sessionId}/events`);

async function scenario(title: string, settings: Record<string, unknown>, body: (h: Harness) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings });
  try {
    await body(h);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
    t.check('every chat window opened was closed again', h.chat.opened, h.chat.closed);
    t.check('every scripted reply was used', h.chat.pending, 0);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

/** Answers every step waiting in a confirm-mode run with "run" until the run is over; plans are left alone. */
async function runSteps(h: Harness): Promise<void> {
  await waitFor('the run to end, its steps approved', async () => {
    for (const a of await h.call<Approval[]>('GET', '/approvals')) {
      if (!a.plan) await h.call('POST', `/approvals/${a.id}`, { action: 'run' });
    }
    const act = await h.call<{ running: boolean; batch: boolean; starting?: boolean }>('GET', '/activity');
    return !act.running && !act.batch && !act.starting;
  });
}

const planWaiting = (h: Harness, version: number): Promise<Approval> =>
  waitFor(`plan ${version} to wait for approval`, async () =>
    (await h.call<Approval[]>('GET', '/approvals')).find((a) => a.plan?.plan.version === version));

await scenario('"auto": read first, a change put back, the plan approved by the runner and given to the reviewer', { execution: { planMode: 'auto' } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'planned', { review: { enabled: true } })] });
  h.chat.script(
    (m) => {
      t.truthy('the opening asks for a plan first, read-only', m.text.includes('## Plan first (plan mode)') && /Change nothing yet: the runner puts back any change/.test(m.text), m.text.slice(-1500));
      t.truthy('and says the runner approves it', m.text.includes('The runner approves the plan and tells you so.'), m.text.slice(-600));
      return reply.steps('Get-ChildItem -Name', "Set-Content -Path sneaky.txt -Value 'early' -Encoding utf8");
    },
    (m) => {
      t.truthy('a change made while planning is put back, and the chat told', /This is the planning phase, and nothing may change yet: the runner put back sneaky\.txt/.test(m.text), m.text.slice(-1200));
      t.truthy('the file is gone from the working tree', !existsSync(join(h.repo, 'sneaky.txt')));
      return reply.done();
    },
    (m) => {
      t.check('"done" before any plan is sent back', m.text, PLAN_FIRST);
      return reply.plan({ risks: 'none worth naming' });
    },
    (m) => {
      t.truthy('the plan approved by the runner, saying why', m.text.startsWith('Your plan is approved by the runner (plan mode approves plans automatically).'), m.text.slice(0, 300));
      return write('result.txt', 'finished');
    },
    reply.done(),
    (m) => {
      t.truthy('the reviewer is given the approved plan to check the work against', m.chat.review && m.text.includes('## The plan the work was to follow') && m.text.includes('Create the file the task names'), m.text.slice(0, 300));
      return reply.steps('Get-Content result.txt');
    },
    reply.pass(),
  );
  const s1 = await h.run(s!.id);
  const task = s1.tasks[0] as Full;
  t.check('the task is done', task.status, 'done');
  t.check('its plan is on the record: version, stages, files, risks, approved by the runner and why',
    [task.plan?.version, task.plan?.steps, task.plan?.files, (task.plan as { risks?: string } | undefined)?.risks, task.plan?.approved?.by, task.plan?.approved?.why],
    [1, ['create the file', 'read it back'], ['result.txt'], 'none worth naming', 'auto', 'plan mode approves plans automatically']);
  t.truthy('nothing changed while planning reached the branch', !h.git('ls-tree', '--name-only', 'cop/planned').split('\n').includes('sneaky.txt'), h.git('ls-tree', '--name-only', 'cop/planned'));
  const types = (await events(h, s!.id)).map((e) => e.type);
  t.truthy('the events say what happened, in order',
    ['plan-change-reverted', 'plan-first', 'plan-received', 'plan-approved'].every((x, i, all) => types.indexOf(x) >= 0 && (i === 0 || types.indexOf(x) > types.indexOf(all[i - 1]!))),
    types.filter((x) => x.startsWith('plan')));
});

await scenario('"approve", in a run that asks: another plan asked for with a note, the next approved with one', { execution: { planMode: 'approve' } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'asked')] });
  const comment = 'Write the text with -NoNewline as well, and say how you will read it back.';
  const note = 'Keep result.txt to the one word.';
  h.chat.script(
    (m) => {
      t.truthy('the opening says the operator reads the plan', m.text.includes('The operator reads the plan, and approves it or asks for another'), m.text.slice(-600));
      return reply.plan();
    },
    (m) => {
      t.truthy('the operator\'s note reaches the chat, asking for the whole plan again', m.text.startsWith('The operator read version 1 of your plan and asks for another.') && m.text.includes(comment), m.text);
      return reply.plan({ steps: ['create the file without a newline', 'read it back with Get-Content -Raw'] });
    },
    (m) => {
      t.truthy('approved by the operator, with the note', m.text.startsWith('The operator approved your plan.') && m.text.includes(note), m.text);
      return write('result.txt', 'finished');
    },
    reply.done(),
  );
  const started = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' });
  t.check('the run started, asking before each command', started.started, true);

  const first = await planWaiting(h, 1);
  t.check('the plan waits on an approval card, with the task and its stages', [first.sessionId, first.plan?.title, first.plan?.plan.steps], [s!.id, 'write-result', ['create the file', 'read it back']]);
  t.check('and is on the task, not yet approved', [(await taskOf(h, s!.id)).plan?.version, (await taskOf(h, s!.id)).plan?.approved], [1, undefined]);
  const bare = await h.raw('POST', `/approvals/${first.id}/plan`, { action: 'revise' });
  t.truthy('asking for another plan without saying what to change is refused', bare.status === 400 && /Say what to change/.test(JSON.stringify(bare.body)), bare);
  const wrong = await h.raw('POST', `/approvals/${first.id}/plan`, { action: 'maybe' });
  t.check('an answer that is none of the three is refused', wrong.status, 400);
  await h.call('POST', `/approvals/${first.id}/plan`, { action: 'revise', note: comment });

  const second = await planWaiting(h, 2);
  t.check('the next version comes back to the card, carrying the comment that asked for it', second.plan?.plan.revisions?.map((r) => [r.version, r.comment]), [[1, comment]]);
  await h.call('POST', `/approvals/${second.id}/plan`, { action: 'approve', note });
  const gone = await h.raw('POST', `/approvals/${second.id}/plan`, { action: 'approve' });
  t.truthy('a second answer to the same plan is refused', gone.status === 400 && /not waiting any more/.test(JSON.stringify(gone.body)), gone);

  await runSteps(h);
  const task = await taskOf(h, s!.id);
  t.check('the task is done, on plan 2, approved by the operator with the note', [task.status, task.plan?.version, task.plan?.approved?.by, task.plan?.approved?.note, task.plan?.approved?.why], ['done', 2, 'operator', note, undefined]);
});

await scenario('"approve", in a run that does not ask: approved by the runner, which says why', { execution: { planMode: 'approve' } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'unattended')] });
  h.chat.script(
    (m) => {
      t.truthy('the opening says the runner approves it', m.text.includes('The runner approves the plan and tells you so.'), m.text.slice(-600));
      return reply.plan();
    },
    (m) => {
      t.truthy('approved by the runner: the run does not ask', m.text.startsWith('Your plan is approved by the runner (the run does not ask before each command).'), m.text.slice(0, 200));
      return write('result.txt', 'finished');
    },
    reply.done(),
  );
  const task = (await h.run(s!.id, 'unattended')).tasks[0] as Full;
  t.check('done, the plan approved by the runner, and why', [task.status, task.plan?.approved?.by, task.plan?.approved?.why], ['done', 'auto', 'the run does not ask before each command']);
  t.check('nothing waited for anyone', (await events(h, s!.id)).filter((e) => e.type === 'plan-waiting').length, 0);
});

await scenario('stopped at its plan: the task ends, with nothing changed', { execution: { planMode: 'approve' } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'stopped')] });
  h.chat.script(reply.plan());
  await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' });
  const waiting = await planWaiting(h, 1);
  await h.call('POST', `/approvals/${waiting.id}/plan`, { action: 'stop' });
  await h.idle();
  const task = await taskOf(h, s!.id);
  t.check('the task is stopped by the operator at its plan', [task.status, task.reason], ['aborted', 'stopped by the operator at its plan']);
  t.check('no step ran', h.chat.sent.filter((m) => !m.contract).length, 1);
});

await scenario('a session\'s own setting outranks Settings: from the import, and from the session page', { execution: { planMode: 'auto' } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'own', { planMode: 'off' })] });
  t.check('the import keeps the session\'s own setting', (await h.session(s!.id) as unknown as { planMode?: string }).planMode, 'off');
  h.chat.script(
    (m) => {
      t.truthy('with plan mode off for the session, the opening asks for no plan', !m.text.includes('## Plan first'), m.text.slice(-600));
      return write('result.txt', 'finished');
    },
    reply.done(),
  );
  const task = (await h.run(s!.id)).tasks[0] as Full;
  t.check('the task is done without a plan', [task.status, task.plan], ['done', undefined]);

  const set = await h.call<{ planMode?: string }>('PUT', `/sessions/${s!.id}`, { planMode: 'approve' });
  t.check('the session page sets it', set.planMode, 'approve');
  const cleared = await h.call<{ planMode?: string }>('PUT', `/sessions/${s!.id}`, { planMode: '' });
  t.check('and an empty choice follows Settings again', cleared.planMode, undefined);
});

await scenario('a task carried on with a new prompt plans no more, and its reviewer still gets the plan', { execution: { planMode: 'auto' }, limits: { retryBlockedInFreshChat: 0 } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'carried', { review: { enabled: true } })] });
  h.chat.script(reply.plan(), write('partial.txt', 'half'), reply.blocked());
  const blocked = (await h.run(s!.id)).tasks[0] as Full;
  t.check('the first attempt planned, then blocked', [blocked.status, blocked.plan?.approved?.by], ['blocked', 'auto']);

  const instruction = 'Create result.txt yourself, holding exactly the text finished.';
  await h.call('POST', `/sessions/${s!.id}/tasks/${blocked.id}/continue`, { instruction });
  const plan = (await taskOf(h, s!.id)).attempts?.[0]?.plan;
  h.chat.script(
    (m) => {
      t.truthy('the carried-on attempt is not asked for a plan', !m.text.includes('## Plan first') && m.text.includes(instruction), m.text.slice(-800));
      return write('result.txt', 'finished');
    },
    reply.done(),
    (m) => {
      t.truthy('its reviewer is given the plan the first attempt made', m.chat.review && !!plan && m.text.includes(planForReviewer(plan as never).split('\n').slice(-3).join('\n')), m.text.slice(0, 400));
      return reply.steps('Get-Content result.txt');
    },
    reply.pass(),
  );
  const after = (await h.run(s!.id)).tasks[0] as Full;
  t.check('it finishes, the plan kept with the first attempt', [after.status, after.plan, after.attempts?.[0]?.plan?.version], ['done', undefined, 1]);
});

t.finish();
