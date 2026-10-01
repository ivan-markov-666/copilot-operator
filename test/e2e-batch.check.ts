/**
 * The operator's controls over a run, end to end with the scripted chat: what Pause, Resume and Stop
 * do at each point a run can be in, what the four answers on the approval screen do, that only one
 * chat window is ever open, and how a batch of sessions ends when it cannot go on.
 *
 * These are the buttons an operator presses when something is going wrong, which is exactly when a
 * button that does something slightly different from what it says costs the most: a Stop that lets
 * one more step run, a Pause that is still switched on the next morning, a "run the rest" that
 * reaches further than the dialog said. Each scenario presses one of them at a known point — a reply
 * held on a gate, an approval waiting, a check running — through the same routes the interface uses,
 * and asserts what happened to the tasks, the files, the batch record and the chat.
 *
 * - a pause holds the queue behind the task in flight and the sessions after it, and is gone once
 *   the batch ends; a resume lets the queue carry on; with no batch the three answer "nothing to do";
 * - a batch stop clears the approval on screen, aborts the task in flight and leaves the rest queued;
 * - "abort" on an approval ends the task at once, runs nothing after it and asks the chat nothing;
 * - "run the rest without asking" stops the asking for the rest of the run, and only the run;
 * - Stop while a step waits, Stop in an unattended run, Stop during the check gate: `aborted`, every time;
 *   and Stop's write of the session never collides with the runner's (the store race behind the
 *   intermittent failures of the two Stop scenarios, reproduced on the store itself);
 * - one chat window at a time: a second start, a second batch and reading the models are refused
 *   while one is open, and a batch of two sessions opens one window;
 * - a batch that stops on a failure leaves the sessions it never reached queued and stamped with the run;
 * - a browser that will not open fails the batch with that reason and touches no task;
 * - what the start routes refuse, and how; and what the run panel's model choice writes on a session.
 *
 * Every scenario runs in a harness of its own (test/support/harness.ts): its own temporary data
 * folder, repository and port. Checks marked `DEFECT` fail on purpose until the product is fixed.
 *
 *   npm run check:e2e-batch        (once package.json names it; until then:)
 *   npx tsx test/e2e-batch.check.ts
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';
import { setTransportFactory } from '../src/transport/chatTransport.js';
import { OperatorService } from '../src/api/operator.service.js';
import { SessionStore } from '../src/session/store.js';

const t = new Tally();

type Approval = { id: string; sessionId: string; taskId: string; stepId: number; description: string };
type BatchEntry = { sessionId: string; name: string; state: string; ran: number; failed: number; reason?: string };
type BatchView = { id: string; running: boolean; pausing: boolean; stopping: boolean; sessions: BatchEntry[] };
type Started = { started: boolean; reason?: string; batch?: BatchView };
type RunGroupView = { id: string; order?: number };
type ModelView = { model?: string; review?: { enabled?: boolean; model?: string }; runGroup?: RunGroupView; runMode?: string; running?: boolean };

/**
 * How many chat windows are open at once. The fake chat counts windows opened and closed over the
 * whole scenario; the question "was a second one ever open beside the first" needs the count at
 * each moment, so every transport the product asks for is wrapped here, locally, without touching
 * test/support. `failOpen` makes the next window refuse to open, the way Edge does when the profile
 * is locked or the executable is missing.
 */
type Windows = { live: number; max: number; failOpen: Error | null };

function countWindows(h: Harness): Windows {
  const w: Windows = { live: 0, max: 0, failOpen: null };
  const inner = h.chat.factory();
  setTransportFactory((o) => {
    const c = inner(o);
    const open = c.open.bind(c);
    const close = c.close.bind(c);
    let isOpen = false;
    c.open = async () => {
      if (w.failOpen) throw w.failOpen;
      await open();
      if (!isOpen) {
        isOpen = true;
        w.live += 1;
        w.max = Math.max(w.max, w.live);
      }
    };
    c.close = async () => {
      await close();
      if (isOpen) {
        isOpen = false;
        w.live -= 1;
      }
    };
    return c;
  });
  return w;
}

/** A reply that is not given until the check says so: the point at which a control is pressed. */
type Held = { reached: boolean; release: () => void; script: () => Promise<string> };

/**
 * Every hold not yet released. A scenario that throws before its own `release()` would otherwise
 * leave the runner parked on a reply forever, with the harness torn down underneath it; the
 * wrapper below releases whatever is left, whichever way the body ended.
 */
const liveHolds = new Set<Held>();

function held(text: string): Held {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const state: Held = {
    reached: false,
    release: () => {
      liveHolds.delete(state);
      open();
    },
    script: async () => {
      state.reached = true;
      await gate;
      return text;
    },
  };
  liveHolds.add(state);
  return state;
}

/**
 * What a scenario that threw leaves behind is a run still going: a reply held, an approval
 * waiting, a 20-second check with the repository as its working folder. Tearing the harness down
 * under it leaks the temporary folder on Windows (the check's process holds it) and lets the run
 * write into a store that is being deleted. So before the teardown every hold is let go, the
 * batch and every session are stopped, and the run is given a moment to end. Only on failure paths.
 */
async function windDown(h: Harness): Promise<void> {
  for (const hold of [...liveHolds]) hold.release();
  await h.raw('POST', '/batch/stop').catch(() => undefined);
  const sessions = await h.call<Array<{ id: string }>>('GET', '/sessions').catch(() => [] as Array<{ id: string }>);
  for (const s of sessions) await h.raw('POST', `/sessions/${s.id}/stop`).catch(() => undefined);
  await waitFor('the run to end after a failed scenario', async () => {
    const a = await h.call<{ running: boolean; batch: boolean }>('GET', '/activity');
    return !a.running && !a.batch;
  }, 20_000).catch(() => undefined);
}

/**
 * Every scenario ends with the same three questions about the chat, because a control that works
 * only by leaving a reply unasked, a window open or a message unanswered has not worked: the chat
 * never met a message it had no script for, every window was closed, and every scripted reply was
 * used. The fourth — never two windows at once — is asked everywhere except where a scenario asks
 * it itself.
 */
async function scenario(
  title: string,
  settings: Record<string, unknown>,
  body: (h: Harness, w: Windows) => Promise<void>,
  opts: { windowsAsserted?: boolean } = {},
): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings });
  const w = countWindows(h);
  try {
    await body(h, w);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
    t.check('every chat window opened was closed again', h.chat.opened, h.chat.closed);
    t.check('every scripted reply was asked for', h.chat.pending, 0);
    if (!opts.windowsAsserted) t.truthy('never more than one chat window open at a time', w.max <= 1, w);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
    await windDown(h);
  } finally {
    for (const hold of [...liveHolds]) hold.release();
    await h.stop();
  }
}

/**
 * A session with no version control and no review: the controls are the subject, not git. Its
 * commands run in the harness's repository, named as its project folder, because a session with
 * no folder of its own is refused rather than run in the runner's own checkout.
 */
const plain = (h: Harness, name: string, tasks: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  onFailure: 'stop',
  vcs: { enabled: false, repoDir: '' },
  review: { enabled: false },
  projectDir: h.repo,
  tasks,
  ...extra,
});

const job = (title: string, file: string): Record<string, unknown> => ({
  title,
  prompt: `Create ${file} in the project folder holding exactly the text ${title}, and nothing else.`,
});

/**
 * A task the runner refuses before anything is sent: read-only, with a check only a change could
 * pass. It opens a window and ends `blocked` without a message, so a run of it that should never
 * have started shows up as a second window rather than as a message the script has no answer for.
 */
const noSend = (title: string): Record<string, unknown> => ({
  title,
  prompt: 'Read the project and report on what is in it; this task must not change a single file anywhere.',
  readOnly: true,
  checks: [{ name: 'a file nobody writes', expect: 'file-contains', file: 'never-written.txt', value: 'never' }],
});

const write = (file: string, text: string): string => reply.steps(`Set-Content -Path ${file} -Value '${text}' -Encoding utf8`);

const approvals = (h: Harness): Promise<Approval[]> => h.call<Approval[]>('GET', '/approvals');
const firstApproval = (h: Harness, sessionId: string): Promise<Approval> =>
  waitFor(`a step of ${sessionId} to wait for approval`, async () => (await approvals(h)).find((a) => a.sessionId === sessionId));
const entry = (b: BatchView, sessionId: string): BatchEntry | undefined => b.sessions.find((e) => e.sessionId === sessionId);

// --- pause and resume ----------------------------------------------------------------------------

/*
 * Pause is "finish the task in flight, then hold": the task it interrupts runs to done, the task
 * behind it and the session after it stay queued, and the batch record says which is which. And
 * once the batch has ended, the hold has nothing left to hold: pressing Start on the session later
 * is an ordinary start. The flag lives on the batch record, which outlives the batch, and every run
 * reads it through `shouldPause` — so a hold nobody switches off stops the next single run before
 * its first task.
 */
await scenario('a pause holds the queue behind the task in flight, and does not stay switched on', {}, async (h) => {
  const [a, b] = await h.importPlan({
    version: 1,
    sessions: [plain(h, 'pause-a', [job('pause-a-one', 'a1.txt'), job('pause-a-two', 'a2.txt')]), plain(h, 'pause-b', [job('pause-b-one', 'b1.txt')])],
  });
  let paused: unknown = 'never pressed';
  h.chat.script(async () => {
    paused = await h.call('POST', '/batch/pause').catch((e: unknown) => (e as Error).message);
    return write('a1.txt', 'a1');
  }, reply.done());
  const started = await h.call<Started>('POST', '/batch/start', { sessionIds: [a!.id, b!.id], mode: 'unattended' });
  t.check('the batch started', started.started, true);
  await h.idle();

  t.check('pause, pressed while the first task ran, was taken', paused, { pausing: true });
  const sa = await h.session(a!.id);
  const sb = await h.session(b!.id);
  t.check('the task in flight finished; the one behind it and the next session wait', [sa.tasks[0]!.status, sa.tasks[1]!.status, sb.tasks[0]!.status], ['done', 'queued', 'queued']);
  t.check('the interrupted task\'s work is there', existsSync(join(h.repo, 'a1.txt')), true);
  const batch = await h.call<BatchView>('GET', '/batch');
  const ea = entry(batch, a!.id);
  const eb = entry(batch, b!.id);
  t.truthy('the batch record: the first session stopped, paused after one task', ea?.state === 'stopped' && /paused after 1/.test(ea.reason ?? ''), ea);
  t.truthy('the second skipped because of the pause, its tasks still queued', eb?.state === 'skipped' && /paused/.test(eb.reason ?? ''), eb);

  // Later, the operator starts the first session on its own to carry on.
  h.chat.script(write('a2.txt', 'a2'), reply.done());
  const again = await h.call<Started>('POST', `/sessions/${a!.id}/start`, { mode: 'unattended' });
  t.check('a single start after the paused batch is accepted', again.started, true);
  await h.idle();
  const second = (await h.session(a!.id)).tasks[1]!;
  // DEFECT: batch.pausing is never reset when the batch ends, so shouldPause stays true and every later run of any session stops before its first task.
  t.check('and it runs the queued task: the hold ended with the batch', second.status, 'done');
  // Counted once, above: when the hold outlives the batch, the two replies for that task were never asked for.
  if (second.status !== 'done') h.chat.discard();
});

/*
 * Resume takes the hold off before it has done anything, so the batch runs as if nobody had
 * touched it. And the three buttons, pressed with no batch running, say there was nothing to do
 * rather than failing or changing a batch that has already ended.
 */
await scenario('a resume lets the queue carry on; with no batch the buttons answer "nothing to do"', {}, async (h) => {
  t.check('pause with no batch ever run', await h.call('POST', '/batch/pause'), { pausing: false });
  t.check('resume with no batch ever run', await h.call('POST', '/batch/resume'), { pausing: false });
  t.check('stop with no batch ever run', (await h.call<{ stopping?: boolean }>('POST', '/batch/stop')).stopping ?? false, false);

  const [a, b] = await h.importPlan({
    version: 1,
    sessions: [plain(h, 'resume-a', [job('resume-a-one', 'a1.txt'), job('resume-a-two', 'a2.txt')]), plain(h, 'resume-b', [job('resume-b-one', 'b1.txt')])],
  });
  const pressed: unknown[] = [];
  h.chat.script(
    async () => {
      pressed.push(await h.call('POST', '/batch/pause').catch((e: unknown) => (e as Error).message));
      pressed.push(await h.call('POST', '/batch/resume').catch((e: unknown) => (e as Error).message));
      return write('a1.txt', 'a1');
    },
    reply.done(),
    write('a2.txt', 'a2'),
    reply.done(),
    write('b1.txt', 'b1'),
    reply.done(),
  );
  await h.call('POST', '/batch/start', { sessionIds: [a!.id, b!.id], mode: 'unattended' });
  await h.idle();
  t.check('pause then resume, both taken', pressed, [{ pausing: true }, { pausing: false }]);
  const all = [...(await h.session(a!.id)).tasks, ...(await h.session(b!.id)).tasks].map((x) => x.status);
  t.check('all three tasks ran', all, ['done', 'done', 'done']);
  const batch = await h.call<BatchView>('GET', '/batch');
  t.check('both sessions done in the batch record, the hold off', [batch.sessions.map((e) => e.state), batch.pausing], [['done', 'done'], false]);

  t.check('pause after the batch ended', await h.call('POST', '/batch/pause'), { pausing: false });
  t.check('resume after the batch ended', await h.call('POST', '/batch/resume'), { pausing: false });
  t.check('stop after the batch ended', (await h.call<{ stopping?: boolean }>('POST', '/batch/stop')).stopping ?? false, false);
});

// --- stop ------------------------------------------------------------------------------------------

/*
 * Stop on a batch whose first session is waiting for approval: the question on screen goes (nobody
 * is left to answer it), the task it belonged to ends aborted with nothing run, and the session the
 * batch never reached is skipped with its task queued, ready for another day.
 */
await scenario('a batch stop clears the approval on screen and leaves the rest queued', {}, async (h) => {
  const [a, b] = await h.importPlan({ version: 1, sessions: [plain(h, 'bstop-a', [job('bstop-a-one', 'a1.txt')]), plain(h, 'bstop-b', [job('bstop-b-one', 'b1.txt')])] });
  h.chat.script(write('a1.txt', 'a1'));
  await h.call('POST', '/batch/start', { sessionIds: [a!.id, b!.id], mode: 'confirm' });
  await firstApproval(h, a!.id);
  t.check('one approval is waiting', (await approvals(h)).length, 1);
  const stopped = await h.raw('POST', '/batch/stop');
  // Asked the moment the stop has answered, not polled: Stop takes the question off the screen
  // itself, before it answers. A poll would also pass if the question were only dropped later,
  // when the run ends and its leftovers are cleared, which is a Stop that left it up meanwhile.
  t.check('the approval is gone at once', await approvals(h), []);
  await h.idle();
  const task = (await h.session(a!.id)).tasks[0]!;
  // One check for the answer and the outcome, because the store race below decides which of the
  // two a given run gets wrong: Stop's write loses (a 500 here) or the runner's does (the task
  // ends 'failed', "Could not save"), and now and then neither shows.
  // DEFECT (intermittent): Stop's write of the session races the runner's; atomicWrite's temporary file is per process, not per write, so one of them fails with ENOENT.
  t.check(
    'the batch stop is taken, and the task in flight ended aborted with its step never run',
    [stopped.status >= 200 && stopped.status < 300, stopped.body, task.status, existsSync(join(h.repo, 'a1.txt'))],
    [true, { stopping: true }, 'aborted', false],
  );
  const eb = entry(await h.call<BatchView>('GET', '/batch'), b!.id);
  t.truthy('the second session skipped, saying the batch was stopped first', eb?.state === 'skipped' && /stopped before this session/.test(eb.reason ?? ''), eb);
  t.check('its task still queued', (await h.session(b!.id)).tasks[0]!.status, 'queued');
});

/*
 * "Abort" on the first of two steps: the task ends there. The second step is not run and not asked
 * about, the chat is not sent the results and asked what next, and the record counts one stop by
 * the operator — the step that was refused.
 */
await scenario('"abort" on an approval ends the task: nothing after it runs, the chat is asked nothing', {}, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [plain(h, 'abort', [job('abort-one', 'a.txt')])] });
  h.chat.script(reply.steps('Set-Content a.txt 1', 'Set-Content b.txt 2'), reply.done());
  await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' });
  const first = await firstApproval(h, s!.id);
  t.check('the question is about the first step', first.stepId, 1);
  t.check('the answer is taken', await h.call('POST', `/approvals/${first.id}`, { action: 'abort' }), { ok: true });
  await h.idle();
  const task = (await h.session(s!.id)).tasks[0]!;
  t.check('the task ended aborted, by the operator', [task.status, task.reason], ['aborted', 'the operator aborted the task']);
  t.check('neither step ran', [existsSync(join(h.repo, 'a.txt')), existsSync(join(h.repo, 'b.txt'))], [false, false]);
  t.check('one stop by the operator on the record', task.stats?.operatorStops, 1);
  t.check('the "done" reply was never asked for', h.chat.discard(), 1);
});

/*
 * "Run this and the rest without asking" on the first of three steps: the other two run unasked,
 * the run says it switched, and the task ends done with all three files committed. The reply after
 * the steps is where the run is looked at from the inside, while it is still running.
 */
await scenario('"run the rest without asking" runs the rest of the task unasked, and says so', {}, async (h) => {
  const [s] = await h.importPlan({
    version: 1,
    sessions: [{ ...plain(h, 'runall', [job('runall-one', 'a.txt')]), vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'runall' } }],
  });
  let inside: { runMode?: string; running?: boolean; switched: boolean } | string = 'the reply after the steps was never asked for';
  h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'a' -Encoding utf8", "Set-Content -Path b.txt -Value 'b' -Encoding utf8", "Set-Content -Path c.txt -Value 'c' -Encoding utf8"), async () => {
    try {
      const now = await h.call<ModelView>('GET', `/sessions/${s!.id}`);
      const events = await h.call<Array<{ type: string }>>('GET', `/sessions/${s!.id}/events`);
      inside = { runMode: now.runMode, running: now.running, switched: events.some((e) => e.type === 'run-mode-changed') };
    } catch (e) {
      inside = (e as Error).message;
    }
    return reply.done();
  });
  await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' });
  const first = await firstApproval(h, s!.id);
  t.check('asked about the first step', first.stepId, 1);
  await h.call('POST', `/approvals/${first.id}`, { action: 'run-all' });

  // Watched until the run ends. Anything asked after the switch is recorded and answered, so a
  // regression shows here as a count rather than as a run that hangs until the timeout.
  const askedAfter: Approval[] = [];
  await waitFor('the run to end', async () => {
    for (const a of await approvals(h)) {
      askedAfter.push(a);
      await h.call('POST', `/approvals/${a.id}`, { action: 'run' });
    }
    const act = await h.call<{ running: boolean; batch: boolean }>('GET', '/activity');
    return !act.running && !act.batch;
  });
  t.check('the second and third steps were never asked about', askedAfter.map((a) => a.stepId), []);
  t.check('while running: unattended, and the switch is in the events', inside, { runMode: 'unattended', running: true, switched: true });
  const task = (await h.session(s!.id)).tasks[0]!;
  t.check('the task is done', task.status, 'done');
  t.check('all three files committed on the session branch', ['a', 'b', 'c'].map((f) => h.git('show', `cop/runall:${f}.txt`)), ['a', 'b', 'c']);
});

/*
 * The same answer inside a watched batch of two sessions. The confirmation dialog says the commands
 * will run without asking "until this run ends", and the run the operator started is the batch —
 * so the second session's steps should not be put to them either. Today the switch belongs to the
 * first session's run only: the second session starts in the batch's mode and asks again.
 *
 * The first session's reply has two steps, so that "nothing more of it was asked about" has a step
 * it could have been asked about: with one step, the one answered, that half could never fail.
 */
await scenario('"run the rest without asking" inside a batch reaches as far as the dialog says', {}, async (h) => {
  const [s1, s2] = await h.importPlan({ version: 1, sessions: [plain(h, 'scope-one', [job('scope-one-task', 'r1.txt')]), plain(h, 'scope-two', [job('scope-two-task', 'r2.txt')])] });
  h.chat.script(
    reply.steps("Set-Content -Path r1.txt -Value 'one' -Encoding utf8", "Set-Content -Path r1b.txt -Value 'one' -Encoding utf8"),
    reply.done(),
    write('r2.txt', 'two'),
    reply.done(),
  );
  await h.call('POST', '/batch/start', { sessionIds: [s1!.id, s2!.id], mode: 'confirm' });
  const first = await firstApproval(h, s1!.id);
  t.check('asked about the first session\'s first step', first.stepId, 1);
  await h.call('POST', `/approvals/${first.id}`, { action: 'run-all' });
  const askedLater: Approval[] = [];
  await waitFor('the batch to end', async () => {
    for (const a of await approvals(h)) {
      askedLater.push(a);
      await h.call('POST', `/approvals/${a.id}`, { action: 'run' });
    }
    const act = await h.call<{ running: boolean; batch: boolean }>('GET', '/activity');
    return !act.running && !act.batch;
  });
  t.check('nothing more of the first session was asked about', askedLater.filter((a) => a.sessionId === s1!.id).map((a) => a.stepId), []);
  t.check('and its second step ran', existsSync(join(h.repo, 'r1b.txt')), true);
  // DEFECT: run-all switches only the running session (setRunMode on one entry of `running`); the batch's next session starts in batch.mode 'confirm' and asks again, though the dialog says "until this run ends".
  t.check('nor, "until this run ends", the second session\'s step', askedLater.filter((a) => a.sessionId === s2!.id).length, 0);
  t.check('both sessions finished their task', [(await h.session(s1!.id)).tasks[0]!.status, (await h.session(s2!.id)).tasks[0]!.status], ['done', 'done']);
});

/*
 * Stop pressed while a step waits for approval: the question goes at once, the step never runs, the
 * task ends aborted. A second Stop, with nothing left running, says so.
 */
await scenario('Stop while a step waits for approval', {}, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [plain(h, 'stopwait', [job('stopwait-one', 's.txt')])] });
  h.chat.script(reply.steps('Set-Content s.txt x'));
  await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' });
  await firstApproval(h, s!.id);
  const stopped = await h.raw('POST', `/sessions/${s!.id}/stop`);
  t.check('the approval left the screen with the answer', await approvals(h), []);
  await h.idle();
  const task = (await h.session(s!.id)).tasks[0]!;
  // Folded into one check for the reason given in the batch-stop scenario: which half the race
  // turns red changes from run to run.
  // DEFECT (intermittent): the store race (see the store scenario below); Stop answers 500, or the task ends 'failed' with "Could not save".
  t.check(
    'the stop is taken, and the task ended aborted with the step never run',
    [stopped.status >= 200 && stopped.status < 300, stopped.body, task.status, existsSync(join(h.repo, 's.txt'))],
    [true, { stopping: true }, 'aborted', false],
  );
  t.check('a second stop finds nothing running', await h.call('POST', `/sessions/${s!.id}/stop`), { stopping: false });
});

/*
 * Why the two Stop scenarios above fail now and then. Stop writes the session ("stopping") at the
 * moment it answers the approval, and the answer wakes the runner, which writes the same session
 * (the task is running again). `updateSession` promises that two writers cannot clobber each other,
 * but it is a read, a change and a write with nothing held in between, and `atomicWrite` names its
 * temporary file after the process, so the two writes share one: one rename takes it, the other
 * finds nothing and throws "Could not save … ENOENT" — a Stop that answers 500, or a task that ends
 * failed instead of aborted. Reproduced here directly on the store, where it does not depend on timing.
 */
console.log('\n--- Stop and the runner write the session at the same moment ---');
{
  const dir = await mkdtemp(join(tmpdir(), 'cop-e2e-batch-store-'));
  try {
    const store = new SessionStore(dir, join(dir, 'level1.md'));
    await store.init();
    const s = await store.createSession('race');
    await store.addTask(s.id, { title: 'race-task', level2: '', prompt: 'A prompt that is comfortably long enough to be a real task.' });
    const writes = await Promise.allSettled([
      store.updateSession(s.id, (x) => {
        x.status = 'stopping';
      }),
      store.updateSession(s.id, (x) => {
        x.tasks[0]!.status = 'running';
      }),
    ]);
    const after = await store.getSession(s.id);
    // One check for both ways it goes wrong, because which one a given run shows is down to timing:
    // DEFECT: atomicWrite's temporary file is `<file>.<pid>.tmp`, shared by every write of that session in this process, so one of two concurrent writes fails its rename with ENOENT;
    // and when both renames land, updateSession has read, changed and written with nothing serialising the writers, so the later write drops the earlier one's change.
    t.check(
      'two writes at once are both saved, and neither undoes the other',
      [...writes.map((w) => (w.status === 'fulfilled' ? 'saved' : String((w.reason as Error).message).slice(0, 80))), after?.status, after?.tasks[0]?.status],
      ['saved', 'saved', 'stopping', 'running'],
    );
  } catch (e) {
    t.truthy('the store scenario ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}

/*
 * Stop in an unattended run, at the moment a step is being authorized. The runner checks the signal
 * before each step, but between that check and the authorization it writes the task to disk; a Stop
 * landing there reaches the authorizer, and `runStep` does not look at a signal that was aborted
 * before it started — so whatever the authorizer answers is what happens. Driven through the
 * service's own authorizer, as test/network.check.ts drives it, with a run entry of each kind.
 */
console.log('\n--- a step proposed after Stop is not authorized, in any mode ---');
{
  const data = await mkdtemp(join(tmpdir(), 'cop-e2e-batch-auth-'));
  const earlier = process.env.COP_DATA_DIR;
  process.env.COP_DATA_DIR = data;
  try {
    const ops = new OperatorService();
    const internals = ops as unknown as {
      running: Map<string, unknown>;
      webAuthorizer(p: unknown, signal: AbortSignal): { authorize(step: unknown, ctx: unknown): Promise<{ action: string; reason?: string }> };
    };
    const step = { id: 1, type: 'command', cmd: 'npm test' };
    const policy = (mode: 'confirm' | 'unattended') => ({ mode, denyPatterns: [], allowedPrograms: ['npm', 'pwsh', 'powershell'], isolation: 'none-accepted' as const });
    const stoppedRun = (id: string, mode: 'confirm' | 'unattended') => {
      const p = policy(mode);
      const controller = new AbortController();
      internals.running.set(id, { controller, startedAt: new Date().toISOString(), mode, policy: p });
      return { p, controller, auth: internals.webAuthorizer(p, controller.signal) };
    };

    const watched = stoppedRun('watched', 'confirm');
    watched.controller.abort();
    const w = await watched.auth.authorize(step, { sessionId: 'watched', taskId: 't1', iteration: 1 });
    t.check('a watched run that was stopped: the step is aborted, not put on screen', [w.action, ops.pendingApprovals('watched').length], ['abort', 0]);

    const unattended = stoppedRun('unattended', 'unattended');
    unattended.controller.abort();
    const u = await unattended.auth.authorize(step, { sessionId: 'unattended', taskId: 't1', iteration: 1 });
    // DEFECT: makeAuthorizer answers 'run' for an unattended policy before `ask` is reached, and webAuthorizer's own `ask` also answers 'run' for unattended before it looks at signal.aborted.
    t.check('an unattended run that was stopped: the step is not authorized to run', u.action, 'abort');

    const switched = stoppedRun('switched', 'confirm');
    t.check('"run the rest without asking" switches it', ops.setRunMode('switched', 'unattended').ok, true);
    switched.controller.abort();
    const s = await switched.auth.authorize(step, { sessionId: 'switched', taskId: 't1', iteration: 1 });
    // DEFECT: same cause, reached by "run the rest without asking": the policy object is switched to unattended and the signal is never consulted.
    t.check('a run switched to unattended and then stopped: the step is not authorized to run', s.action, 'abort');
  } catch (e) {
    t.truthy('the authorizer scenario ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    if (earlier === undefined) delete process.env.COP_DATA_DIR;
    else process.env.COP_DATA_DIR = earlier;
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}

/*
 * Stop while the task's own checks are running: the operator stopped a task, they did not fail it.
 * The check in flight is killed (a 20-second check must not hold the Stop for 20 seconds), the task
 * ends `aborted` — which is what makes "Continue" offer to carry it on — and the round that the Stop
 * cut short is not counted against the work as a rejected "done".
 */
await scenario('Stop during the check gate ends the task aborted, not failed', {}, async (h) => {
  const [s] = await h.importPlan({
    version: 1,
    sessions: [
      plain(h, 'slowcheck', [
        {
          title: 'slow-check-task',
          prompt: 'Create hello.txt in the project folder holding exactly the word hi, and nothing else.',
          // The slow one first, so the Stop lands on it; the second is what the plan check asks
          // for, a check that only the finished work passes.
          checks: [
            { name: 'slow', expect: 'exit-zero', run: 'New-Item started.flag -Force | Out-Null; Start-Sleep 20; exit 0' },
            { name: 'hello written', expect: 'file-contains', file: 'hello.txt', value: 'hi' },
          ],
        },
      ]),
    ],
  });
  h.chat.script(reply.steps('Set-Content hello.txt hi'), reply.done());
  await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  await waitFor('the check to start', async () => existsSync(join(h.repo, 'started.flag')));
  const stoppedAt = Date.now();
  // Read raw rather than through h.call: the killed check wakes the runner, which writes the
  // session while Stop is writing it (the store race), and a 500 thrown here would skip every
  // check below along with the harness's own.
  const stopped = await h.raw('POST', `/sessions/${s!.id}/stop`);
  await h.idle();
  t.truthy('the check was cut short rather than waited out', Date.now() - stoppedAt < 15_000, `${Date.now() - stoppedAt} ms after the stop`);
  const task = (await h.session(s!.id)).tasks[0]!;
  const row = (await h.call<Array<{ taskId: string; continuable?: boolean }>>('GET', '/tasks')).find((r) => r.taskId === task.id);
  // The answer and the outcome in one check, as in the other two Stop scenarios, so the red line
  // does not move with the race.
  // DEFECT: gateOnChecks counts the killed check as a failed round (doneRejected += 1) and returns 'give-up' on an aborted signal, so the runner finishes 'failed' instead of 'aborted'; (intermittent) the store race can also make Stop answer 500.
  t.check(
    'the stop is taken, and the task ended aborted',
    [stopped.status >= 200 && stopped.status < 300, stopped.body, task.status],
    [true, { stopping: true }, 'aborted'],
  );
  // DEFECT: follows from the above: a 'failed' task with no limit is not continuable.
  t.check('the register offers to continue it', [!!row, row?.continuable], [true, true]);
  // DEFECT: the check round the Stop cut short is counted as a rejected "done".
  t.check('the cut-short round is not counted as a rejected "done"', task.stats?.doneRejected ?? 0, 0);
});

// --- one browser at a time -------------------------------------------------------------------------

/*
 * The Edge profile takes one writer. While a single session's run holds the window, a second
 * session's start, a batch, and reading the model picker must all be refused where the operator can
 * read why — not start a second window on the same profile, which fails minutes later with a message
 * about a closed browser. Sessions B and C are tasks the runner refuses before sending anything, so
 * if they are let through the only trace is the second window, counted here.
 */
await scenario('one browser at a time', { limits: { retryBlockedInFreshChat: 0 } }, async (h, w) => {
  const [a, b, c, a2, b2] = await h.importPlan({
    version: 1,
    sessions: [
      plain(h, 'solo-a', [job('solo-a-task', 'solo-a.txt')]),
      plain(h, 'solo-b', [noSend('solo-b-task')]),
      plain(h, 'solo-c', [noSend('solo-c-task')]),
      plain(h, 'pair-a', [job('pair-a-task', 'pair-a.txt')]),
      plain(h, 'pair-b', [job('pair-b-task', 'pair-b.txt')]),
    ],
  });
  const hold = held(write('solo-a.txt', 'a'));
  h.chat.script(hold.script, reply.done());
  t.check('A starts on its own', (await h.call<Started>('POST', `/sessions/${a!.id}/start`, { mode: 'unattended' })).started, true);
  await waitFor("A's first reply to be held", async () => hold.reached);

  const other = await h.call<Started>('POST', `/sessions/${b!.id}/start`, { mode: 'unattended' });
  // DEFECT: start() refuses only while a batch runs, and beginRun only a second run of the same session; another session's run opens a second window on the same profile.
  t.check('while A holds the window, starting B is refused', other.started, false);
  const batch = await h.call<Started>('POST', '/batch/start', { sessionIds: [c!.id], mode: 'unattended' });
  // DEFECT: startBatch refuses only a second batch or a selected session that is itself running; a batch of other sessions opens a second window.
  t.check('and so is a batch of another session', batch.started, false);
  const refresh = await h.raw('POST', '/models/refresh');
  t.truthy('and reading the models is refused', refresh.status >= 400 && refresh.status < 500, refresh);
  hold.release();
  await h.idle();
  t.check('A finished', (await h.session(a!.id)).tasks[0]!.status, 'done');

  // A normal two-session batch: one window for both, and nothing else may open one meanwhile.
  const before = { opened: h.chat.opened, closed: h.chat.closed };
  const hold2 = held(write('pair-a.txt', 'a'));
  h.chat.script(hold2.script, reply.done(), write('pair-b.txt', 'b'), reply.done());
  t.check('the batch starts', (await h.call<Started>('POST', '/batch/start', { sessionIds: [a2!.id, b2!.id], mode: 'unattended' })).started, true);
  await waitFor("the batch's first reply to be held", async () => hold2.reached);
  const refresh2 = await h.raw('POST', '/models/refresh');
  t.truthy('reading the models is refused while the batch holds the window', refresh2.status >= 400 && refresh2.status < 500, refresh2);
  hold2.release();
  await h.idle();
  t.check('both sessions of the batch finished', [(await h.session(a2!.id)).tasks[0]!.status, (await h.session(b2!.id)).tasks[0]!.status], ['done', 'done']);
  t.check('the batch opened one window and closed it', [h.chat.opened - before.opened, h.chat.closed - before.closed], [1, 1]);
  // DEFECT: the two starts above that should have been refused each opened a second window beside A's.
  t.check('never more than one chat window open at a time, in the whole scenario', w.max, 1);
}, { windowsAsserted: true });

// --- a batch that cannot go on ---------------------------------------------------------------------

/*
 * A batch set to stop on a failure: the first session's task fails its check for good, and the two
 * sessions after it are skipped with their tasks queued. They still carry the run they were part of
 * — that is what "run the rest again" is built on — in the order the run had them, and the run panel
 * can name a run of them.
 */
await scenario('onFailure "stop" leaves the rest queued, with the run on record', { limits: { maxCheckRounds: 1, retryBlockedInFreshChat: 0 } }, async (h) => {
  const [s1, s2, s3] = await h.importPlan({
    version: 1,
    sessions: [
      plain(h, 'chain-one', [{ ...job('chain-one-task', 'one.txt'), checks: [{ name: 'a file never written', expect: 'file-contains', file: 'never-written.txt', value: 'never' }] }]),
      plain(h, 'chain-two', [job('chain-two-task', 'two.txt')]),
      plain(h, 'chain-three', [job('chain-three-task', 'three.txt')]),
    ],
  });
  h.chat.script(reply.done(), reply.done());
  const started = await h.call<Started>('POST', '/batch/start', { sessionIds: [s1!.id, s2!.id, s3!.id], mode: 'unattended', onFailure: 'stop' });
  t.check('the batch started', started.started, true);
  await h.idle();
  const batch = await h.call<BatchView>('GET', '/batch');
  t.check('the batch record: failed, skipped, skipped', batch.sessions.map((e) => e.state), ['failed', 'skipped', 'skipped']);
  t.truthy('the first session\'s task did not end done', (await h.session(s1!.id)).tasks[0]!.status !== 'done', (await h.session(s1!.id)).tasks[0]);
  const later = await Promise.all([s2!, s3!].map((s) => h.call<ModelView & { tasks: Array<{ status: string }> }>('GET', `/sessions/${s.id}`)));
  t.check('the sessions never reached still have their tasks queued', later.map((s) => s.tasks[0]!.status), ['queued', 'queued']);
  t.check('and carry this run, in its order', later.map((s) => [s.runGroup?.id, s.runGroup?.order]), [[batch.id, 1], [batch.id, 2]]);
  const name = await h.call<{ name: string }>('GET', `/batch/name?sessions=${s2!.id},${s3!.id}`);
  t.truthy('a run of them can be named', typeof name.name === 'string' && name.name.trim().length > 0, name);
});

/*
 * Edge will not start. Nothing can run without it, so the batch says so once, on every session it
 * was given, and no task is touched: no run stamped, nothing moved out of the queue.
 */
await scenario('a browser that cannot open fails the batch and touches no task', {}, async (h, w) => {
  const [a, b] = await h.importPlan({ version: 1, sessions: [plain(h, 'noedge-a', [job('noedge-a-task', 'a.txt')]), plain(h, 'noedge-b', [job('noedge-b-task', 'b.txt')])] });
  w.failOpen = new Error('Edge failed to launch');
  t.check('the batch is accepted', (await h.call<Started>('POST', '/batch/start', { sessionIds: [a!.id, b!.id], mode: 'unattended' })).started, true);
  await h.idle();
  const batch = await h.call<BatchView>('GET', '/batch');
  t.truthy('every session failed, saying the browser could not be opened and why',
    batch.sessions.length === 2 && batch.sessions.every((e) => e.state === 'failed' && /browser could not be opened/.test(e.reason ?? '') && /Edge failed to launch/.test(e.reason ?? '')), batch.sessions);
  t.check('every task still queued', [(await h.session(a!.id)).tasks[0]!.status, (await h.session(b!.id)).tasks[0]!.status], ['queued', 'queued']);
  // The run is stamped on the sessions only once the window is open: a run that never started is
  // not one "run the rest again" should offer to repeat. (JSON turns both sides' undefined into null.)
  t.check(
    'no run stamped on either session',
    [(await h.call<ModelView>('GET', `/sessions/${a!.id}`)).runGroup, (await h.call<ModelView>('GET', `/sessions/${b!.id}`)).runGroup],
    [undefined, undefined],
  );
  t.check('the batch is over', batch.running, false);
});

// --- the entrance ----------------------------------------------------------------------------------

/*
 * What the two start routes refuse, and how. A malformed request is the caller's mistake (400); a
 * well-formed request that cannot be honoured is an answer, `started: false` with the reason, which
 * the page shows under the button. A session named twice is one session.
 */
await scenario('the entrance: what a start or a batch is refused for, and how', {}, async (h) => {
  const [s1, s2, s3] = await h.importPlan({
    version: 1,
    sessions: [plain(h, 'gate-one', [job('gate-one-task', 'g1.txt')]), plain(h, 'gate-two', [job('gate-two-task', 'g2.txt')]), plain(h, 'gate-three', [job('gate-three-task', 'g3.txt')])],
  });
  t.check('sessionIds that is not a list: 400', (await h.raw('POST', '/batch/start', { sessionIds: 'x' })).status, 400);
  t.check('taskIds that is not a list: 400', (await h.raw('POST', '/batch/start', { sessionIds: [s1!.id], taskIds: 't' })).status, 400);
  const empty = await h.call<Started>('POST', '/batch/start', { sessionIds: [] });
  t.check('an empty selection is refused with the reason', [empty.started, empty.reason], [false, 'no sessions were selected']);
  t.check('none of these began anything', await h.call('GET', '/activity'), { running: false, sessions: 0, batch: false });

  // A single run waiting on its first approval: a batch including that session is refused.
  h.chat.script(write('g1.txt', 'one'));
  t.check('a single run starts', (await h.call<Started>('POST', `/sessions/${s1!.id}/start`, { mode: 'confirm' })).started, true);
  const w1 = await firstApproval(h, s1!.id);
  const clash = await h.call<Started>('POST', '/batch/start', { sessionIds: [s1!.id], mode: 'confirm' });
  t.truthy('a batch of a session running on its own is refused, saying so', !clash.started && /already running on its own/.test(clash.reason ?? ''), clash);
  // Ended by aborting the step rather than with Stop: this scenario is about the entrance, and Stop
  // has scenarios of its own (and a defect of its own, the store race further down).
  await h.call('POST', `/approvals/${w1.id}`, { action: 'abort' });
  await h.idle();

  // A batch with one session named twice, waiting on its first approval: a second batch is refused.
  h.chat.script(write('g2.txt', 'two'));
  t.check('a batch naming a session twice starts', (await h.call<Started>('POST', '/batch/start', { sessionIds: [s2!.id, s2!.id], mode: 'confirm' })).started, true);
  const w2 = await firstApproval(h, s2!.id);
  t.check('and holds it once', (await h.call<BatchView>('GET', '/batch')).sessions.map((e) => e.sessionId), [s2!.id]);
  const second = await h.call<Started>('POST', '/batch/start', { sessionIds: [s3!.id], mode: 'confirm' });
  t.check('a second batch is refused while it runs', [second.started, second.reason], [false, 'a batch is already running']);
  await h.call('POST', `/approvals/${w2.id}`, { action: 'abort' });
  await h.idle();
  t.check('the session the second batch named was not touched', (await h.session(s3!.id)).tasks[0]!.status, 'queued');

  const nope = await h.raw('POST', '/sessions/nope-0000/start', { mode: 'confirm' });
  // DEFECT: start() writes the run onto the session (store.updateSession) before beginRun looks the session up, so a missing session throws and the route answers 500.
  t.check('a start for a session that does not exist is an answer, not a server error', [nope.status >= 200 && nope.status < 300, nope.body], [true, { started: false, reason: 'no such session' }]);
});

// --- the run panel's model choice ------------------------------------------------------------------

/*
 * The run panel starts on the models chosen in Settings. Choosing exactly that model leaves a
 * session that follows Settings following it (so a later change in Settings still reaches it); a
 * review model is written on every session in the run; whether a session is reviewed at all is not
 * the run panel's to change. Choosing another model writes it, and the chat is asked for it.
 */
await scenario("the run panel's model choice", { copilot: { defaultModel: 'Auto' } }, async (h) => {
  const [a, b] = await h.importPlan({
    version: 1,
    sessions: [
      // A: no model of its own, reviewed (the default) — its tasks opt out, so no review conversation is needed.
      {
        name: 'model-a',
        onFailure: 'stop',
        vcs: { enabled: false, repoDir: '' },
        projectDir: h.repo,
        tasks: [
          { ...job('model-a-one', 'ma1.txt'), review: false },
          { ...job('model-a-two', 'ma2.txt'), review: false },
        ],
      },
      // B: review switched off.
      plain(h, 'model-b', [job('model-b-one', 'mb1.txt')]),
    ],
  });
  const firstIds = [a!.tasks[0]!.id, b!.tasks[0]!.id];
  h.chat.script(write('ma1.txt', 'a1'), reply.done(), write('mb1.txt', 'b1'), reply.done());
  const run1 = await h.call<Started>('POST', '/batch/start', { sessionIds: [a!.id, b!.id], mode: 'unattended', model: 'Auto', reviewModel: 'Think deeper', taskIds: firstIds });
  t.check('the first run starts', run1.started, true);
  await h.idle();
  const sa = await h.call<ModelView>('GET', `/sessions/${a!.id}`);
  const sb = await h.call<ModelView>('GET', `/sessions/${b!.id}`);
  t.check('run on the model Settings chose, A keeps following Settings', sa.model, undefined);
  t.check('the review model is written on both sessions', [sa.review?.model, sb.review?.model], ['Think deeper', 'Think deeper']);
  t.check('whether each is reviewed is left as it was', [sa.review?.enabled, sb.review?.enabled], [true, false]);
  // Each session that follows Settings asks the chat for the Settings model as it enters its
  // conversation; neither is reviewed, so the review model is written but never asked for.
  t.check('the chat was asked for the Settings model, once per session, and nothing else', h.chat.modelRequests, ['Auto', 'Auto']);

  h.chat.script(write('ma2.txt', 'a2'), reply.done());
  const run2 = await h.call<Started>('POST', '/batch/start', { sessionIds: [a!.id], mode: 'unattended', model: 'Think deeper' });
  t.check('the second run starts', run2.started, true);
  await h.idle();
  t.check('another model chosen is written on the session', (await h.call<ModelView>('GET', `/sessions/${a!.id}`)).model, 'Think deeper');
  t.check('and the chat is asked for it', h.chat.modelRequests.includes('Think deeper'), true);
  t.check('both of A\'s tasks ran', (await h.session(a!.id)).tasks.map((x) => x.status), ['done', 'done']);
});

t.finish();
