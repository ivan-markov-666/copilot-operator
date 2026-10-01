/**
 * The task loop's guards and records, end to end through the API with the scripted chat of
 * test/support/fakeChat.ts in place of Copilot. No browser, no Microsoft 365; the steps and the
 * checks run for real, in the real shells, inside a throwaway repository.
 *
 * What this pins, and why each one: every guard below exists because a live run once spent its
 * rounds, its conversations or the operator's trust on the thing it stops, and none of them was
 * covered end to end — only as units, which is where the wiring between them could break unseen.
 *
 * - the repeat guard refuses the third identical run and says so in the file and the message; a
 *   command whose answer changes is never refused;
 * - the stall guard ends a task whose every step is a refused repeat, as blocked, not at a limit;
 * - stopOnFailure ends the iteration at the failing step;
 * - step timeouts come from Settings and are capped by maxStepTimeoutSec;
 * - a damaged step, and a step naming a shell this machine has not got, never reach a process;
 * - a shell that will not start is an environment problem that ends the task with nothing sent;
 * - a check refused before it ran ends as invalid-check; the check-round limit is exact;
 * - a clean-tree check decided after the runner's commit can overturn "done";
 * - a failed upload falls back to text; a chat error fails the task and names an Edge crash;
 * - a check refused only for a package runner's tool not installed yet goes back to the chat;
 * - a model that cannot be selected, a conversation that moved or was deleted, and a fresh-chat
 *   retry that must not strand an earlier task's "Continue", on the session's model;
 * - "Continue" of a task whose message never reached a chat sends it in full, and an attempt with no
 *   record of its conversation is placed by the session's own;
 * - the stop marker with steps; secrets redacted before anything reaches the chat;
 * - what each run folder holds, the stats counters, and a server left running being stopped.
 *
 *   npm run check:e2e-loop   (or: npx tsx test/e2e-loop.check.ts)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { startHarness, waitFor, freePort, readJson, Tally, type Harness, type TaskView } from './support/harness.js';
import { reply, type Incoming, type Sent } from './support/fakeChat.js';
import { detectShells, inventoryOf, type Shell } from '../src/exec/shells.js';
import { setTransportFactory, type ChatTransport } from '../src/transport/chatTransport.js';
import type { EdgeCrash } from '../src/transport/edgeCrash.js';
import { SessionStore } from '../src/session/store.js';

const t = new Tally();

/** The machine's own shells, read before any scenario fakes an inventory, so a fake can name real paths. */
const realShells = detectShells({ fresh: true }).found;

/**
 * One scenario on a harness of its own. Every scenario ends with the same three facts: the chat was
 * never sent a message the script had no answer for, every window opened was closed, and no scripted
 * reply was left unused (a scenario that expects leftovers discards and pins them itself). A scenario
 * that fakes the machine's shells does it before the server starts and puts the real inventory back
 * afterwards, whatever happened.
 */
async function scenario(
  title: string,
  settings: Record<string, unknown>,
  body: (h: Harness) => Promise<void>,
  opts: { shells?: Partial<Record<Shell, string>> } = {},
): Promise<void> {
  console.log(`\n--- ${title} ---`);
  let h: Harness | undefined;
  try {
    if (opts.shells) inventoryOf(opts.shells);
    h = await startHarness({ settings });
    await body(h);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
    t.check('every chat window opened was closed again', h.chat.opened, h.chat.closed);
    t.check('no scripted reply was left over', h.chat.pending, 0);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    if (h) await h.stop();
    if (opts.shells) detectShells({ fresh: true });
  }
}

/** A reply exactly as given, for shapes the `reply` helpers are built never to produce. */
const fenced = (v: unknown): string => 'Here is my answer.\n\n```json\n' + JSON.stringify(v, null, 2) + '\n```\n';

const write = (file: string, text: string): string => reply.steps(`Set-Content -Path ${file} -Value '${text}' -Encoding utf8`);

/** The text of every file attached to a message. */
const attachedText = (m: Sent | Incoming): string => Object.values(m.attached).join('\n');

/**
 * A plan of one session. With version control on, the session works on a branch of its own in the
 * throwaway repository; off, it works in the same folder with no branch — which also switches off the
 * no-progress watch (it reads the tree only on a task's own branch), for the scenarios whose point is
 * a limit that watch would otherwise pre-empt.
 */
function plan(h: Harness, name: string, tasks: unknown[], opts: { vcs?: boolean; onFailure?: 'stop' | 'continue' } = {}): unknown {
  const vcs = opts.vcs ?? true;
  return {
    version: 1,
    sessions: [
      {
        name,
        onFailure: opts.onFailure ?? 'stop',
        vcs: vcs ? { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: name } : { enabled: false },
        ...(vcs ? {} : { projectDir: h.repo }),
        review: { enabled: false },
        tasks,
      },
    ],
  };
}

const task = (title: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  title,
  prompt: `Task "${title}": do in the repository root exactly what the steps of this check ask, and nothing else.`,
  ...extra,
});

/**
 * A check that passes, written beside the one a scenario is about. The importer refuses a task whose
 * every check is file-exists, file-missing or exit-zero (they pass with the work not done), so a
 * scenario about one of those kinds needs one check of another kind next to it.
 */
const readmeIntact = { name: 'the readme is intact', expect: 'file-contains', file: 'README.md', value: 'fixture' };

type Ended = TaskView & {
  stopCode?: string;
  finalReply?: string;
  checkResults?: Array<{ name: string; passed: boolean; detail: string }>;
  leftovers?: Array<{ pid: number; name: string; command: string; ports: number[]; by: string }>;
  limit?: { setting: string; value: number };
};
type Ev = { type: string; level?: string; message?: string; data?: Record<string, unknown> };
const eventsOf = (h: Harness, sessionId: string): Promise<Ev[]> => h.call<Ev[]>('GET', `/sessions/${sessionId}/events`);
const only = async (h: Harness, sessionId: string): Promise<Ended> => (await h.session(sessionId)).tasks[0] as Ended;
const branchFiles = (h: Harness, branch: string): string[] => h.git('ls-tree', '-r', '--name-only', branch).split('\n').filter(Boolean);

// --- the anti-spin guards -------------------------------------------------------------------

await scenario('the repeat guard: the third identical run is refused and said; a changing answer never is', { limits: { maxCommandRepeats: 2 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'repeat', [task('repeat-guard')]));
  // A counter: the same command every time, a different answer every time. The guard counts
  // identical results, not runs, so this is never refused however often it is sent.
  const counter = reply.steps('$n=[int](Get-Content c.txt -EA 0)+1; Set-Content c.txt $n; $n');
  h.chat.script(
    reply.steps('Write-Output same'),
    reply.steps('Write-Output same'),
    reply.steps('Write-Output same'),
    (m) => {
      const report = attachedText(m);
      t.truthy('the third run is refused in the report, naming the limit', report.includes('[policy] step not executed') && report.includes('maxCommandRepeats 2'), report.slice(-900));
      t.truthy('and the covering message says why', m.text.includes('repeat a command that has already run 2 time(s)'), m.text);
      return reply.steps('Write-Output other');
    },
    counter,
    counter,
    counter,
    (m) => {
      t.truthy('the counter\'s third run was not refused', !attachedText(m).includes('[policy] step not executed'), attachedText(m).slice(-600));
      return reply.done();
    },
  );
  const ended = (await h.run(s!.id)).tasks[0] as Ended;
  t.check('done', ended.status, 'done');
  t.check('exactly one repeat refused', ended.stats?.repeatsRefused, 1);
  t.check('the counter ran all three times', h.git('show', 'cop/repeat:c.txt').trim(), '3');
});

await scenario('the stall guard: every step a refused repeat, twice running, ends blocked', { limits: { maxCommandRepeats: 1, maxStalledIterations: 2, retryBlockedInFreshChat: 0 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'stall', [task('stall-guard')]));
  for (let i = 0; i < 4; i++) h.chat.script(reply.steps('Write-Output same'));
  const ended = (await h.run(s!.id)).tasks[0] as Ended;
  t.check('blocked', ended.status, 'blocked');
  t.truthy('the reason names the loop and the command', /sent again after being refused for repetition, 2 iteration/.test(ended.reason ?? '') && /Repeated: Write-Output same/.test(ended.reason ?? ''), ended.reason);
  t.truthy('not left to run into a limit', ended.status !== 'limit-reached', ended.status);
  // Run once, refused twice: the third reply ended it and the fourth was never asked for.
  t.check('the fourth reply was never asked for', h.chat.discard(), 1);
});

await scenario('stopOnFailure ends the iteration at the failing step', { execution: { stopOnFailure: true } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'stoponfail', [task('stop-on-failure')], { vcs: false }));
  h.chat.script(
    reply.steps({ cmd: 'exit /b 3', shell: 'cmd' }, "Set-Content -Path after.txt -Value 'x'"),
    (m) => {
      const report = attachedText(m);
      t.truthy('the report has step 1 and no step 2', report.includes('--- step 1') && !report.includes('--- step 2'), report.slice(-700));
      return reply.done();
    },
  );
  const ended = (await h.run(s!.id)).tasks[0] as Ended;
  t.check('done', ended.status, 'done');
  t.check('the step after the failure never ran', existsSync(join(h.repo, 'after.txt')), false);
});

// --- timeouts ----------------------------------------------------------------------------------

/** The header of step 1 in a report: its outcome and the duration it reports. */
function stepHeader(report: string): { outcome: string; seconds: number } | null {
  const m = /--- step 1 \(\w+, ([\w-]+), exit -?\d+, ([\d.]+)s\)/.exec(report);
  return m ? { outcome: m[1]!, seconds: Number(m[2]) } : null;
}

await scenario('timeouts come from Settings: a short idle limit stops a quiet step, "long" gets the long one', { execution: { idleTimeoutSec: 2, longIdleTimeoutSec: 20, maxStepTimeoutSec: 600 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'timeouts', [task('idle-limits')], { vcs: false }));
  h.chat.script(
    reply.steps({ cmd: 'Start-Sleep 5' }),
    (m) => {
      t.check('five quiet seconds against an idle limit of 2: stopped', stepHeader(attachedText(m))?.outcome, 'idle-timeout');
      return reply.steps({ cmd: 'Start-Sleep 5', expect: 'long' });
    },
    (m) => {
      t.check('the same step marked long gets longIdleTimeoutSec and completes', stepHeader(attachedText(m))?.outcome, 'completed');
      return reply.done();
    },
  );
  t.check('done', (await h.run(s!.id)).tasks[0]!.status, 'done');
});

await scenario('maxStepTimeoutSec caps what a step asks for', { execution: { maxStepTimeoutSec: 2 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'capped', [task('capped-step')], { vcs: false }));
  /*
   * The step asks for "long" and an idle limit of 100 s; the cap of 2 s must win over both. It sleeps
   * 30 s rather than 5: a stopped step's reported duration includes the stop itself — a polite
   * taskkill, a grace period of CLOSE_GRACE_MS (5 s, see processes.ts) and then /F — so a 5 s sleep
   * ends on its own inside that grace and its duration reads ~5 s whether or not it was capped. Against
   * 30 s, a duration well under 30 shows the cap cut it.
   */
  h.chat.script(
    fenced({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'Start-Sleep 30', expect: 'long', idleTimeoutSec: 100 }] }),
    (m) => {
      const head = stepHeader(attachedText(m));
      t.truthy('stopped at a timeout', head?.outcome === 'hard-timeout' || head?.outcome === 'idle-timeout', head);
      t.truthy('long before the 30 s it would have slept (reported duration under 20 s)', !!head && head.seconds < 20, head);
      return reply.done();
    },
  );
  t.check('done', (await h.run(s!.id)).tasks[0]!.status, 'done');
});

// --- steps that never reach a process ----------------------------------------------------------

await scenario('a damaged step never reaches a process', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'damaged', [task('damaged-step')]));
  /*
   * The step writes x.txt before it reaches the damaged part. Had it been handed to a shell, the
   * write would have happened whatever the shell then made of `(:Round(`, so the file's absence
   * shows the step was refused whole, not merely that the damaged call failed when it ran.
   */
  h.chat.script(
    reply.steps("Set-Content x.txt 'ran'; $r = (:Round(3.14159,2))"),
    (m) => {
      t.truthy('the chat is told how to write it so it survives', Object.values(m.attached).join().includes('put the type in a variable first'), attachedText(m).slice(-900));
      t.truthy('and that the runner refused it', m.text.includes('was refused by the runner'), m.text);
      return reply.done();
    },
  );
  const ended = (await h.run(s!.id)).tasks[0] as Ended;
  t.check('done', ended.status, 'done');
  t.truthy('x.txt was never written', !existsSync(join(h.repo, 'x.txt')) && !branchFiles(h, 'cop/damaged').includes('x.txt'), branchFiles(h, 'cop/damaged'));
  t.truthy('no step was ever started', !(await eventsOf(h, s!.id)).some((e) => e.type === 'step-started'), '');
  t.check('counted as one refused step', ended.stats?.stepsRefused, 1);
  t.truthy('the handoff names it as not run', (ended.handoff?.notExecuted ?? []).some((n) => n.includes(':Round(')), ended.handoff?.notExecuted);
});

// --- the guards that decide how a task ends ---------------------------------------------------

await scenario('invalid-check: a check refused before it ran ends the task as the checks\' fault', { limits: { retryBlockedInFreshChat: 0 } }, async (h) => {
  const [s] = await h.importPlan(
    plan(h, 'invalid', [task('network-check', { checks: [{ name: 'the page downloads', expect: 'exit-zero', run: 'curl https://example.com -o x.html' }, readmeIntact] })]),
  );
  // Enough "done" for any number of rounds the runner might spend on it; what is left is discarded.
  h.chat.script(reply.steps('Write-Output working'), reply.done(), reply.done(), reply.done(), reply.done());
  const ended = (await h.run(s!.id)).tasks[0] as Ended;
  h.chat.discard();
  const detail = ended.checkResults?.[0]?.detail ?? '';
  t.truthy('the check was refused before it ran, for fetching from the network', detail.includes('refused before it ran') && detail.includes('fetches from the network'), detail);
  // Nothing the chat does can make a check run that its own command line keeps from running, so the
  // first "done" ends the task on the checks — before the unchanged tree could read as no progress.
  t.check('failed, stopCode invalid-check', [ended.status, ended.stopCode ?? null], ['failed', 'invalid-check']);
  // And the chat is not sent it as work to fix.
  t.check('the chat was never asked to fix a check that could not run', h.chat.sent.filter((m) => m.text.includes('not finished yet')).length, 0);
});

/*
 * Where the line ends: a check refused for what a script it runs holds — here, a script that does
 * not exist yet — is the chat's to fix, so it goes back as any failing check does, and the task ends
 * done once the chat has written it. A check that runs a script in a way the settings refuse for the
 * line itself (`.\verify.ps1` names a program that is not on the allowlist) is the checks' fault
 * however the script reads, and ends the task at once.
 */
await scenario('a check refused for its script goes back to the chat; one refused for its line does not', { limits: { retryBlockedInFreshChat: 0 } }, async (h) => {
  const [s] = await h.importPlan(
    plan(h, 'script-check', [task('writes-its-verify', { checks: [{ name: 'verify.ps1 passes', expect: 'exit-zero', run: 'pwsh -NoProfile -File verify.ps1' }, readmeIntact] })]),
  );
  h.chat.script(
    reply.done(),
    (m) => {
      t.truthy('the chat is told the check was refused, and why', m.text.includes('not finished yet') && attachedText(m).includes('does not exist yet'), attachedText(m).slice(0, 600));
      return write('verify.ps1', 'exit 0');
    },
    reply.done(),
  );
  const ended = (await h.run(s!.id)).tasks[0] as Ended;
  t.check('done once the script is there', [ended.status, ended.stopCode ?? null], ['done', null]);

  const [p] = await h.importPlan(
    plan(h, 'script-line', [task('runs-it-by-path', { checks: [{ name: 'verify.ps1 by path', expect: 'exit-zero', run: '.\\verify.ps1' }, readmeIntact] })]),
  );
  const sent = h.chat.sent.length;
  h.chat.script(reply.done());
  const byPath = (await h.run(p!.id)).tasks[0] as Ended;
  t.check('refused for the line itself: failed, stopCode invalid-check', [byPath.status, byPath.stopCode ?? null], ['failed', 'invalid-check']);
  t.check('with nothing sent back about it', h.chat.sent.slice(sent).filter((m) => m.text.includes('not finished yet')).length, 0);
});

/*
 * The other thing the files decide: a package runner (`npx`) is held while the tool it names is not
 * installed in the project, because npx would download it — and installing it is work the chat can
 * do. So such a check goes back as any failing check does, and runs once the tool is there. Here the
 * check exits 0 as soon as the tool's package is in node_modules, before npx is reached, so nothing
 * is ever fetched.
 */
await scenario('a check whose package runner has no tool installed yet goes back to the chat', { limits: { retryBlockedInFreshChat: 0 } }, async (h) => {
  const npxCheck = { name: 'the greet tool runs', expect: 'exit-zero', run: 'if (Test-Path node_modules\\greet-tool\\package.json) { exit 0 }; npx greet-tool hi' };
  const [s] = await h.importPlan(plan(h, 'npx-check', [task('installs-its-tool', { checks: [npxCheck, readmeIntact] })], { vcs: false }));
  h.chat.script(
    reply.done(),
    (m) => {
      t.truthy('the chat is told the check is not satisfied yet, and to install the tool', m.text.includes('not finished yet') && attachedText(m).includes('install the tool into the project first'), attachedText(m).slice(0, 700));
      return reply.steps("New-Item -ItemType Directory -Force node_modules\\greet-tool | Out-Null; Set-Content node_modules\\greet-tool\\package.json '{}'");
    },
    reply.done(),
  );
  const ended = (await h.run(s!.id)).tasks[0] as Ended;
  t.check('not ended on the checks: done once the tool is installed', [ended.status, ended.stopCode ?? null], ['done', null]);
});

await scenario('invalid-check when the rounds run out: a check reading outside the project', { limits: { maxCheckRounds: 1 } }, async (h) => {
  const [s] = await h.importPlan(
    plan(h, 'outside', [task('outside-check', { checks: [{ name: 'the sibling file exists', expect: 'file-exists', file: '..\\outside.txt' }, readmeIntact] })], { vcs: false }),
  );
  h.chat.script(reply.steps('Write-Output working'), reply.done(), reply.done());
  const ended = (await h.run(s!.id)).tasks[0] as Ended;
  h.chat.discard();
  t.check('failed, stopCode invalid-check', [ended.status, ended.stopCode ?? null], ['failed', 'invalid-check']);
  t.truthy('the check was refused for leaving the project', /refused before it ran: .*outside the project folders/.test(ended.checkResults?.[0]?.detail ?? ''), ended.checkResults);
});

await scenario('the check-round limit is exact', { limits: { maxCheckRounds: 2 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'rounds', [task('never-passes', { checks: [{ name: 'never.txt written', expect: 'file-contains', file: 'never.txt', value: 'never' }] })], { vcs: false }));
  for (let i = 0; i < 5; i++) h.chat.script(reply.done());
  const ended = (await h.run(s!.id)).tasks[0] as Ended;
  t.check('failed', ended.status, 'failed');
  t.check('at the maxCheckRounds limit', ended.limit, { setting: 'maxCheckRounds', value: 2 });
  // Pinned: maxCheckRounds 2 is two failures sent back and a third "done" that ends it — three of the
  // five replies used.
  t.check('exactly 2 "not finished yet" messages', h.chat.sent.filter((m) => m.text.includes('not finished yet')).length, 2);
  t.check('two of the five "done" replies were never asked for', h.chat.discard(), 2);
});

await scenario('a clean-tree check after the runner\'s commit can overturn "done"', {}, async (h) => {
  const [s] = await h.importPlan(
    plan(h, 'late', [task('dirty-after-commit', {
      checks: [
        // Writes a file after the commit, then asks whether the tree is clean: it cannot be.
        { name: 'the tree is clean', expect: 'exit-zero', run: "'x' | Set-Content late.txt; if (git status --porcelain) { exit 1 }" },
        { name: 'a.txt written', expect: 'file-contains', file: 'a.txt', value: 'a' },
      ],
    })]),
  );
  h.chat.script(write('a.txt', 'a'), reply.done());
  const ended = (await h.run(s!.id)).tasks[0] as Ended;
  t.check('failed', ended.status, 'failed');
  t.truthy('the reason says it was after the runner\'s commit', /after the runner's commit/.test(ended.reason ?? ''), ended.reason);
  const after = (ended.checkResults ?? []).find((c) => c.name.endsWith('(after the commit)'));
  t.check('the check is recorded as decided after the commit, and failed', [after?.name, after?.passed], ['the tree is clean (after the commit)', false]);
});

// --- the chat misbehaving ----------------------------------------------------------------------

await scenario('a failed report upload falls back to text', { report: { uploadRetries: 0 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'upload', [task('upload-fails')], { vcs: false }));
  h.chat.script(
    reply.steps('Write-Output hi'),
    () => {
      throw new Error('upload rejected');
    },
    (m) => {
      t.truthy('the output goes as text, saying why', m.text.includes('The upload failed, so here is the output as text'), m.text.slice(0, 400));
      t.check('with nothing attached', m.attachments, []);
      t.truthy('and the step in it', m.text.includes('Write-Output hi'), m.text.slice(-600));
      return reply.done();
    },
  );
  const ended = (await h.run(s!.id)).tasks[0] as Ended;
  t.check('done', ended.status, 'done');
  // Pinned: uploadRetries 0 is one attempt with the file and one fallback without it.
  t.check('the report went twice: once attached, once as text', [h.chat.exchanged.filter((m) => m.attachments.length > 0).length, h.chat.exchanged.filter((m) => m.text.includes('The upload failed')).length], [1, 1]);
  t.truthy('the failed upload is an event', (await eventsOf(h, s!.id)).some((e) => e.type === 'report-send-failed'), '');
});

await scenario('an unexpected chat error fails the task, and names an Edge crash when there was one', {}, async (h) => {
  const closed = 'Target page, context or browser has been closed';
  const [s] = await h.importPlan(plan(h, 'chaterror', [task('chat-dies')], { vcs: false }));
  h.chat.script(() => {
    throw new Error(closed);
  });
  const after = await h.run(s!.id);
  const ended = after.tasks[0] as Ended;
  t.check('failed', ended.status, 'failed');
  t.truthy('the reason carries the error', (ended.reason ?? '').includes(closed), ended.reason);
  t.check('the session is idle again', after.status, 'idle');
  t.check('its window was closed', h.chat.opened, h.chat.closed);

  // The same, with Edge having left a crash report: the reason leads with the crash.
  const crash: EdgeCrash = { report: 'C:\\crashes\\edge.dmp', at: '2026-09-30T12:00:00.000Z', processType: 'browser', version: '140.0.0.0', subCode: '0xc0000005' };
  const base = h.chat.factory();
  setTransportFactory((opts) => {
    const tr = base(opts);
    (tr as { recentCrash: ChatTransport['recentCrash'] }).recentCrash = async () => crash;
    return tr;
  });
  const [c] = await h.importPlan(plan(h, 'crashed', [task('edge-crashes')], { vcs: false }));
  h.chat.script(() => {
    throw new Error(closed);
  });
  const crashed = (await h.run(c!.id)).tasks[0] as Ended;
  t.truthy('the reason names the crashed browser process, then the error', /^Edge's browser process crashed .*Target page/.test(crashed.reason ?? ''), crashed.reason);
});

await scenario('a model that cannot be selected: the run goes on, on what the chat has', { copilot: { defaultModel: 'No Such Model' } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'model', [task('any-model')], { vcs: false }));
  h.chat.script(reply.done());
  const after = await h.run(s!.id);
  t.check('done', after.tasks[0]!.status, 'done');
  t.check('on Auto', after.modelInUse, 'Auto');
  t.check('the model from Settings was asked for, once', h.chat.modelRequests, ['No Such Model']);
  t.truthy('and the miss is an event', (await eventsOf(h, s!.id)).some((e) => e.type === 'model-not-selected'), '');
});

await scenario('conversation re-entry: found again by name when moved, and a clear stop when gone', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'reentry', [task('first-in-chat')], { vcs: false }));
  h.chat.script(reply.done());
  const first = await h.run(s!.id);
  const chatId = first.chat!.chatId;
  const moved = h.chat.conversations.get(chatId)!;
  h.chat.conversations.delete(chatId);
  h.chat.adopt('other-id', moved.name);

  await h.call('POST', `/sessions/${s!.id}/tasks`, { title: 'second-in-chat', prompt: 'A second task, sent into the conversation the session already has.' });
  h.chat.script((m) => {
    t.check('the next task lands in the conversation of that name', m.chatId, 'other-id');
    return reply.done();
  });
  const second = await h.run(s!.id);
  t.check('and is done', second.tasks[1]!.status, 'done');

  h.chat.conversations.delete('other-id');
  const size = h.chat.conversations.size;
  const sent = h.chat.sent.length;
  const added = await h.call<{ id: string }>('POST', `/sessions/${s!.id}/tasks`, { title: 'third-in-chat', prompt: 'A third task, for a conversation that no longer exists at all.' });
  const third = await h.run(s!.id);
  t.check('nothing was sent', h.chat.sent.length, sent);
  t.truthy('the run says the conversation could not be reopened', (await eventsOf(h, s!.id)).some((e) => /could not be reopened/.test(e.message ?? '')), '');
  t.check('the task stays queued', third.tasks.find((x) => x.id === added.id)?.status, 'queued');
  t.check('no conversation was made in its place', h.chat.conversations.size, size);
});

/*
 * Run on a model from Settings, in a chat whose new conversations open on "Auto", the way Copilot's
 * do: the picker belongs to the conversation, so every conversation the run moves into — a retry's
 * fresh one, the one a "Continue" goes back to or opens — has to be put on the session's model again.
 */
await scenario('a fresh-chat retry must not strand an earlier task\'s "Continue"', { limits: { maxIterations: 5, retryBlockedInFreshChat: 1 }, copilot: { defaultModel: 'Think deeper' } }, async (h) => {
  const base = h.chat.factory();
  /** How many models had been asked for when the last new conversation was opened. */
  let requestsAtNewChat = 0;
  setTransportFactory((opts) => {
    const tr = base(opts);
    const open = tr.newChat.bind(tr);
    tr.newChat = async () => {
      await open();
      h.chat.currentModel = 'Auto';
      requestsAtNewChat = h.chat.modelRequests.length;
    };
    return tr;
  });
  const [s] = await h.importPlan(plan(h, 'strand', [task('long-first'), task('blocks-twice')], { vcs: false, onFailure: 'continue' }));
  let chatA = '';
  // Six replies for a limit of five: the answer to the fifth report is read before the count is.
  h.chat.script((m) => {
    chatA = m.chatId;
    return reply.steps("Write-Output 'round 1'");
  });
  for (let i = 2; i <= 6; i++) h.chat.script(reply.steps(`Write-Output 'round ${i}'`));
  // The second task gives up in the first chat, and again in the fresh one it is retried in.
  h.chat.script(reply.blocked(), reply.blocked());
  const after = await h.run(s!.id);
  const [t1, t2] = after.tasks as Ended[];
  t.check('the first stopped at the limit, the second blocked twice', [t1!.status, t2!.status], ['limit-reached', 'blocked']);
  t.truthy('the session now points at the fresh chat', !!after.chat && after.chat.chatId !== chatA, [after.chat, chatA]);

  const prompt = t1!.prompt;
  await h.call('POST', `/sessions/${s!.id}/tasks/${t1!.id}/continue`);
  h.chat.script((m) => {
    // Each attempt keeps the conversation it ran in; "Continue" goes back to it, and the session with it.
    t.truthy('the continuation goes to the chat that has the first task, or carries its prompt', m.chatId === chatA || m.text.includes(prompt), { chatId: m.chatId, chatA, text: m.text.slice(0, 400) });
    t.check('on the session\'s model', m.world.currentModel, 'Think deeper');
    return reply.done();
  });
  const continued = await h.run(s!.id);
  t.check('and the first task is done', continued.tasks[0]!.status, 'done');
  t.check('the session is back in the conversation that has it', continued.chat?.chatId, chatA);

  // Where that conversation cannot be opened again, the task goes out in full in a fresh one, with
  // the contract, saying it continues an earlier attempt — never as "the assignment above".
  await h.call('POST', `/sessions/${s!.id}/tasks`, { title: 'long-third', prompt: 'A third task that stops at the limit, in the conversation the session is in now.' });
  h.chat.script(reply.steps("Write-Output 'third 1'"));
  for (let i = 2; i <= 6; i++) h.chat.script(reply.steps(`Write-Output 'third ${i}'`));
  const third = (await h.run(s!.id)).tasks[2] as Ended;
  t.check('the third stopped at the limit', third.status, 'limit-reached');
  // A retry of another task in a fresh conversation moves the session again; then the third's
  // conversation is deleted outright.
  await h.call('POST', `/sessions/${s!.id}/tasks`, { title: 'blocks-again', prompt: 'A fourth task that gives up, twice, the second time in a fresh conversation.' });
  h.chat.script(reply.blocked(), reply.blocked());
  const moved = await h.run(s!.id);
  t.truthy('the session moved on from the conversation of the third', !!moved.chat && moved.chat.chatId !== chatA, [moved.chat, chatA]);
  h.chat.conversations.delete(chatA);
  await h.call('POST', `/sessions/${s!.id}/tasks/${third.id}/continue`);
  const prompt3 = third.prompt;
  h.chat.script((m) => {
    // Not by name either: every conversation of the session has the session's name, the fresh one
    // the retry just opened included, and that one never saw the third task.
    t.truthy(
      'the third task goes out in full, in a fresh conversation opened with the contract, saying it continues an earlier attempt',
      m.chatId !== chatA && m.chatId !== moved.chat?.chatId && m.chat.messages[0]?.contract === 'task' && m.text.includes(prompt3) && m.text.includes('continues an earlier attempt'),
      { chatId: m.chatId, first: m.chat.messages[0]?.text.slice(0, 80), text: m.text.slice(0, 600) },
    );
    // The fresh conversation opened on "Auto"; the session's model is asked for again once it is open.
    t.check('the fresh conversation is put on the session\'s model before the task goes out', [m.world.currentModel, h.chat.modelRequests.slice(requestsAtNewChat)], ['Think deeper', ['Think deeper']]);
    return reply.done();
  });
  const last = await h.run(s!.id);
  t.check('and the session records the model it is on', last.modelInUse, 'Think deeper');
  t.check('and the third task is done, in the conversation the session is in now', [last.tasks[2]!.status, last.chat?.chatId !== moved.chat?.chatId], ['done', true]);
});

/** The task contract's first line, which is in every message that carries the contract. */
const TASK_CONTRACT = readFileSync(join(import.meta.dirname, '..', 'prompts', 'level1.md'), 'utf8').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';

/**
 * Presses Stop, through the API, the first time the store writes the task `title` as running: after
 * the task has started and before anything of it is sent. The API runs in this process on this store
 * class, so the hook sits in the runner's own path. Returns its undo.
 */
function stopWhenRunning(h: Harness, title: string): () => void {
  const orig = SessionStore.prototype.updateTask;
  let armed = true;
  SessionStore.prototype.updateTask = async function (this: SessionStore, sid: string, tid: string, mutate: Parameters<typeof orig>[2]) {
    const r = await orig.call(this, sid, tid, mutate);
    if (armed && r.status === 'running' && r.title === title) {
      armed = false;
      await h.call('POST', `/sessions/${sid}/stop`);
    }
    return r;
  };
  return () => {
    SessionStore.prototype.updateTask = orig;
  };
}

/*
 * A task stopped after it started and before its message went out — while the runner prepared it —
 * ends aborted, which "Continue" carries on. No conversation ever had it, so "carry on, the assignment
 * is the one you were given above" would point at nothing: it goes out in full, where the session is.
 */
await scenario('"Continue" of a task stopped before its message was sent sends it in full', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'unsent', [task('sent-first'), task('stopped-unsent')], { vcs: false }));
  let chatA = '';
  h.chat.script((m) => {
    chatA = m.chatId;
    return reply.done();
  });
  const undo = stopWhenRunning(h, 'stopped-unsent');
  const first = await h.run(s!.id).finally(undo);
  const stopped = first.tasks[1] as Ended;
  t.check('the second task was stopped before it was sent', [stopped.status, stopped.reason], ['aborted', 'stopped before the task was sent']);
  t.check('its run folder records no conversation for it', existsSync(join(h.runsDir, stopped.runId!, 'chat.json')), false);
  t.truthy('and no chat ever saw it', !h.chat.sent.some((m) => m.text.includes(stopped.prompt)), '');

  await h.call('POST', `/sessions/${s!.id}/tasks/${stopped.id}/continue`);
  h.chat.script((m) => {
    t.truthy(
      'the task goes out in full into the session\'s conversation, not as "the assignment above"',
      m.chatId === chatA && m.text.includes(stopped.prompt) && !m.text.includes('given above'),
      { chatId: m.chatId, chatA, text: m.text.slice(0, 600) },
    );
    return reply.done();
  });
  const after = await h.run(s!.id);
  t.check('and it is done', after.tasks[1]!.status, 'done');
  t.check('the contract went out once', h.chat.sent.filter((m) => m.text.includes(TASK_CONTRACT)).length, 1);
});

/*
 * The same with the Stop between the two messages that open a new conversation: the contract went
 * out and was answered, the task did not. The conversation has the contract, so the next task gets
 * the reminder rather than the contract again; and once a retry of that task has moved the session,
 * "Continue" of the first still sends it in full, where the session is now — nothing says it ever
 * reached the conversation it was stopped in.
 */
await scenario('a Stop between the contract and the task: "Continue" sends the task in full where the session is', { limits: { retryBlockedInFreshChat: 1 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'between', [task('stopped-after-contract')], { vcs: false }));
  const base = h.chat.factory();
  let armed = true;
  setTransportFactory((opts) => {
    const tr = base(opts);
    const send = tr.sendAndConfirm.bind(tr);
    tr.sendAndConfirm = async (text: string, attachments?: string[]) => {
      const n = await send(text, attachments);
      if (armed && text.includes(TASK_CONTRACT)) {
        armed = false;
        await h.call('POST', `/sessions/${s!.id}/stop`);
      }
      return n;
    };
    return tr;
  });
  const first = await h.run(s!.id);
  const t1 = first.tasks[0] as Ended;
  const chatA = first.chat?.chatId ?? '';
  t.check('stopped before the task was sent', [t1.status, t1.reason], ['aborted', 'stopped before the task was sent']);
  t.truthy('in a conversation that holds the contract and nothing else', !!chatA && h.chat.conversations.get(chatA)?.messages.length === 1, first.chat);
  t.check('its run folder records no conversation for it', existsSync(join(h.runsDir, t1.runId!, 'chat.json')), false);

  await h.call('POST', `/sessions/${s!.id}/tasks`, { title: 'blocks-twice', prompt: 'A second task that gives up, twice, the second time in a fresh conversation.' });
  h.chat.script((m) => {
    t.truthy('the next task goes into that conversation without the contract again', m.chatId === chatA && !m.text.includes(TASK_CONTRACT), { chatId: m.chatId, chatA, text: m.text.slice(0, 300) });
    return reply.blocked();
  }, reply.blocked());
  const moved = await h.run(s!.id);
  t.truthy('a retry in a fresh conversation moved the session', !!moved.chat && moved.chat.chatId !== chatA, moved.chat);

  await h.call('POST', `/sessions/${s!.id}/tasks/${t1.id}/continue`);
  h.chat.script((m) => {
    t.truthy(
      'the first task goes out in full where the session is now, not as "the assignment above"',
      m.chatId === moved.chat?.chatId && m.text.includes(t1.prompt) && !m.text.includes('given above'),
      { chatId: m.chatId, session: moved.chat?.chatId, text: m.text.slice(0, 600) },
    );
    return reply.done();
  });
  const after = await h.run(s!.id);
  t.check('and it is done', after.tasks[0]!.status, 'done');
});

/*
 * An attempt from before every attempt kept its conversation: no chat.json, and opening messages that
 * do not say how many there were. Its second message went out, so the task reached a conversation,
 * and nothing on record says which; the session's own pointer answers as far as it can. Here it was
 * registered by a later task's retry after the attempt started, so it cannot hold it: the task goes
 * out in full in a fresh conversation.
 */
await scenario('an attempt with no record of its conversation is placed by the session\'s own', { limits: { maxIterations: 1, retryBlockedInFreshChat: 1 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'unrecorded', [task('stops-at-limit'), task('blocks-twice')], { vcs: false, onFailure: 'continue' }));
  let chatA = '';
  // Two replies for a limit of one: the answer to the first report is read before the count is.
  h.chat.script((m) => {
    chatA = m.chatId;
    return reply.steps("Write-Output 'one'");
  }, reply.steps("Write-Output 'two'"));
  h.chat.script(reply.blocked(), reply.blocked());
  const after = await h.run(s!.id);
  const [t1, t2] = after.tasks as Ended[];
  t.check('the first stopped at the limit, the second blocked twice', [t1!.status, t2!.status], ['limit-reached', 'blocked']);
  t.truthy('the session now points at the fresh chat', !!after.chat && after.chat.chatId !== chatA, [after.chat, chatA]);

  const dir = join(h.runsDir, t1!.runId!);
  t.check('control: the attempt kept its conversation', existsSync(join(dir, 'chat.json')), true);
  rmSync(join(dir, 'chat.json'));
  const transcript = join(dir, 'transcript.jsonl');
  const older = readFileSync(transcript, 'utf8').split('\n').map((line) => {
    if (!line.includes('"message-sent"')) return line;
    const e = JSON.parse(line) as Record<string, unknown>;
    delete e.of;
    delete e.task;
    delete e.chatId;
    return JSON.stringify(e);
  });
  writeFileSync(transcript, older.join('\n'));

  await h.call('POST', `/sessions/${s!.id}/tasks/${t1!.id}/continue`);
  h.chat.script((m) => {
    t.truthy(
      'it goes out in full, in a fresh conversation opened with the contract, saying it continues an earlier attempt',
      m.chatId !== chatA && m.chatId !== after.chat?.chatId && m.chat.messages[0]?.contract === 'task' && m.text.includes(t1!.prompt) && m.text.includes('continues an earlier attempt'),
      { chatId: m.chatId, first: m.chat.messages[0]?.text.slice(0, 80), text: m.text.slice(0, 600) },
    );
    return reply.done();
  });
  const last = await h.run(s!.id);
  t.check('and the first task is done', last.tasks[0]!.status, 'done');
});

await scenario('the stop marker with steps: done after one iteration, whatever the answer to its report', {}, async (h) => {
  const summary = 'I wrote the file the task asked for, holding the word it asked for, and nothing else in the repository.';
  const marked = (file: string): string =>
    fenced({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: `Set-Content -Path ${file} -Value 'hi' -Encoding utf8` }], summary }) + '\nКрай\n';

  const [s] = await h.importPlan(plan(h, 'marker', [task('stop-marker')]));
  const doneText = reply.done();
  h.chat.script(marked('hello.txt'), doneText);
  const ended = (await h.run(s!.id)).tasks[0] as Ended;
  t.check('done after one iteration', [ended.status, ended.iterations], ['done', 1]);
  t.check('its step was committed', h.git('show', 'cop/marker:hello.txt').trim(), 'hi');
  t.check('the answer to its report is kept as the final reply', ended.finalReply, doneText);

  /*
   * Decision pin: the stop word ended the task with its steps, so the answer to their report is not
   * read for more work. When that answer is a "continue" with new steps, the task is still done after
   * one iteration and those steps never run; the answer is kept as the final reply.
   */
  const [p] = await h.importPlan(plan(h, 'marker-more', [task('stop-marker-more')]));
  h.chat.script(marked('hello2.txt'), reply.steps("Set-Content -Path extra.txt -Value 'x' -Encoding utf8"));
  const pinned = (await h.run(p!.id)).tasks[0] as Ended;
  t.check('pinned: still done after one iteration', [pinned.status, pinned.iterations], ['done', 1]);
  t.truthy('pinned: the new steps never ran', !existsSync(join(h.repo, 'extra.txt')) && !branchFiles(h, 'cop/marker-more').includes('extra.txt'), branchFiles(h, 'cop/marker-more'));
  t.truthy('pinned: the continue with steps is the final reply', (pinned.finalReply ?? '').includes('extra.txt'), pinned.finalReply);
});

await scenario('secrets never reach the chat: the checks file, the step report', { limits: { maxCheckRounds: 1 } }, async (h) => {
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  // A second secret, in the value an output check looks for, which the message quotes twice: as what
  // was required, and again in the detail of what happened.
  const key = 'sk-live-0123456789abcdefghij';
  const [s] = await h.importPlan(
    plan(h, 'secrets', [
      task('prints-a-token', {
        checks: [
          { name: 'the token command fails', expect: 'exit-nonzero', run: `echo token=${token}` },
          { name: 'the key is printed', expect: 'output-contains', value: key, run: 'echo nothing' },
        ],
      }),
    ], { vcs: false }),
  );
  h.chat.script(
    reply.done(),
    (m) => {
      const file = attachedText(m);
      t.truthy('the checks file is redacted', file.includes('[REDACTED') && !file.includes('ghp_abcdef'), file.slice(0, 900));
      // The message quotes each failing check's command and value, so it is redacted where it is
      // written, the same as the file beside it.
      t.truthy('and the message beside it carries no token either', !m.text.includes('ghp_abcdef'), m.text.slice(0, 900));
      t.truthy('nor the key a check looks for, in its value or its detail', !m.text.includes('sk-live-0123') && !file.includes('sk-live-0123'), m.text.slice(0, 900));
      return reply.steps(`echo token=${token}`);
    },
    (m) => {
      const report = attachedText(m);
      t.truthy('the step report is redacted', report.includes('[REDACTED') && !report.includes('ghp_abcdef'), report.slice(-600));
      t.truthy('and so is its message', !m.text.includes('ghp_abcdef'), m.text);
      return reply.done();
    },
  );
  await h.run(s!.id);
  t.truthy('the redaction is an event', (await eventsOf(h, s!.id)).some((e) => e.type === 'report-redacted'), '');
});

// --- the records --------------------------------------------------------------------------------

type Approval = { id: string; sessionId: string; stepId: number };
const firstApproval = (h: Harness, sessionId: string): Promise<Approval> =>
  waitFor('a step to wait for approval', async () => (await h.call<Approval[]>('GET', '/approvals')).find((a) => a.sessionId === sessionId));
const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

await scenario('what each run folder holds', { limits: { maxCheckRounds: 1 } }, async (h) => {
  // A done, unattended run.
  const [s] = await h.importPlan(plan(h, 'folders', [task('done-run')]));
  h.chat.script(write('a.txt', 'a'), reply.done());
  const after = await h.run(s!.id);
  const ended = after.tasks[0] as Ended;
  t.check('done', ended.status, 'done');
  const dir = join(h.runsDir, ended.runId!);
  const policy = await readJson<{ mode: string; confinedTo: string[] }>(join(dir, 'policy.json'));
  t.check('policy.json: unattended', policy.mode, 'unattended');
  t.truthy('policy.json: confined to the repository', policy.confinedTo.map(norm).includes(norm(h.repo)), policy.confinedTo);
  const env = await readJson<{ shells?: { found?: Record<string, string | null> } }>(join(dir, 'environment.json'));
  // The shells this machine has, where it has them: the same inventory this file read at its top,
  // shell by shell (a present-but-empty map, or one of nulls, would say nothing).
  const found = env.shells?.found ?? {};
  const shellsOf = (m: Record<string, string | null | undefined>): Array<[string, string]> =>
    Object.keys(realShells).sort().map((k) => [k, norm(m[k] ?? '')]);
  t.truthy('environment.json: at least one shell found', Object.values(found).some(Boolean), env.shells);
  t.check('environment.json: the shells found, where they were found', shellsOf(found), shellsOf(realShells));
  const chat = await readJson<{ chatId: string; name: string }>(join(dir, 'chat.json'));
  t.check('chat.json: the session\'s conversation', chat.chatId, after.chat?.chatId);
  t.truthy('chat.json: named op/…', /^op\//.test(chat.name), chat.name);
  t.check('and the conversation carries that name', h.chat.conversations.get(chat.chatId)?.name, chat.name);
  const log = readFileSync(join(dir, 'task-log.txt'), 'utf8');
  t.truthy('task-log.txt: the opening, the iteration and the ending', ['OPENING MESSAGE', 'ITERATION 1', 'TASK DONE'].every((x) => log.includes(x)), log.slice(0, 300));
  t.check('no attempt record for a done run', existsSync(join(dir, 'plan.json')), false);

  // A failed run leaves its plan, work and runner views, and its plan imports again.
  const [f] = await h.importPlan(plan(h, 'failing', [task('fails-its-check', { checks: [{ name: 'never.txt written', expect: 'file-contains', file: 'never.txt', value: 'never' }] })], { vcs: false }));
  h.chat.script(reply.done(), reply.done());
  const failed = (await h.run(f!.id)).tasks[0] as Ended;
  t.check('failed', failed.status, 'failed');
  const fdir = join(h.runsDir, failed.runId!);
  t.check('plan.json, work.json, runner.json', ['plan.json', 'work.json', 'runner.json'].map((x) => existsSync(join(fdir, x))), [true, true, true]);
  const work = await readJson<{ tasks: Array<{ outcome: { status: string }; whyItFailed?: { failingChecks: Array<{ name: string }> } }> }>(join(fdir, 'work.json'));
  t.check('work.json: failed, on the check', [work.tasks[0]?.outcome.status, work.tasks[0]?.whyItFailed?.failingChecks[0]?.name], ['failed', 'never.txt written']);
  const checked = await h.call<{ ok: boolean }>('POST', '/plan/check', { text: readFileSync(join(fdir, 'plan.json'), 'utf8') });
  t.check('plan.json passes the plan check', checked.ok, true);

  // A supervised run switched to "run the rest without asking" on task 1 of two: each policy.json
  // says what was in force for its own task.
  const [c] = await h.importPlan(plan(h, 'switched', [task('asked-first'), task('then-unattended')], { vcs: false }));
  h.chat.script(write('b.txt', 'b'), reply.done(), write('c.txt', 'c'), reply.done());
  await h.call('POST', `/sessions/${c!.id}/start`, { mode: 'confirm' });
  const approval = await firstApproval(h, c!.id);
  await h.call('POST', `/approvals/${approval.id}`, { action: 'run-all' });
  await h.idle();
  const both = (await h.session(c!.id)).tasks as Ended[];
  t.check('both done', both.map((x) => x.status), ['done', 'done']);
  const modes = await Promise.all(both.map(async (x) => (await readJson<{ mode: string }>(join(h.runsDir, x.runId!, 'policy.json'))).mode));
  t.check('task 1 was run supervised, task 2 unattended', modes, ['confirm', 'unattended']);
});

await scenario('the stats counters: a gate refusal, a supervised skip, a scope put-back', {}, async (h) => {
  // The gate refuses deleting a committed folder (the case of e2e-run.check.ts): a deny pattern, so
  // the runner's refusal, counted apart from a person's.
  const srcDir = join(h.repo, 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'keep.txt'), 'keep\n');
  h.git('add', '-A');
  h.git('commit', '-q', '-m', 'src');
  const [a] = await h.importPlan(plan(h, 'refused', [task('gate-refuses')]));
  h.chat.script(reply.steps('Remove-Item -Recurse -Force src'), write('hello.txt', 'hi'), reply.done());
  const refused = (await h.run(a!.id)).tasks[0] as Ended;
  t.check('a gate refusal: stepsRefused 1', [refused.status, refused.stats?.stepsRefused], ['done', 1]);
  t.check('and the folder is still there', existsSync(join(srcDir, 'keep.txt')), true);

  // A person skips a step.
  const [b] = await h.importPlan(plan(h, 'skipped', [task('operator-skips')]));
  h.chat.script(write('skip.txt', 'no'), reply.done());
  await h.call('POST', `/sessions/${b!.id}/start`, { mode: 'confirm' });
  const approval = await firstApproval(h, b!.id);
  await h.call('POST', `/approvals/${approval.id}`, { action: 'skip' });
  await h.idle();
  const skipped = await only(h, b!.id);
  t.check('a supervised skip: operatorStops 1', [skipped.status, skipped.stats?.operatorStops], ['done', 1]);

  // A change outside the scope is put back.
  const [c] = await h.importPlan(plan(h, 'scoped', [task('scoped-change', { scope: ['hello.txt'] })]));
  h.chat.script(reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8", "Set-Content -Path README.md -Value 'rewritten' -Encoding utf8"), reply.done());
  const scoped = (await h.run(c!.id)).tasks[0] as Ended;
  t.check('a scope put-back: scopeReverts 1', [scoped.status, scoped.stats?.scopeReverts], ['done', 1]);
});

/**
 * Stops the node server.js the leftover scenario started on `port`, found by its own command line,
 * whether or not the runner saw it: the case this cleanup exists for is the one where the runner's
 * detection regressed, and then its list of leftovers says nothing. Only a node.exe whose command
 * line names both server.js and this port is touched — the process this check started, and no other.
 */
function stopServerOn(port: number): void {
  const find =
    `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*server.js*' -and $_.CommandLine -like '*${port}*' } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', find], { stdio: 'ignore', timeout: 60_000, windowsHide: true });
  } catch {
    /* nothing to stop, or PowerShell could not look: the server ends itself in two minutes anyway */
  }
}

await scenario('a process left running is stopped', {}, async (h) => {
  const port = await freePort();
  let ended: Ended | undefined;
  try {
    // The server ends itself after two minutes, so that even a regression nobody cleans up after
    // cannot leave it listening, holding the temp repository open, for ever.
    writeFileSync(
      join(h.repo, 'server.js'),
      "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.argv[2]), '127.0.0.1');\n" +
        'setTimeout(() => process.exit(0), 120000);\n',
    );
    h.git('add', '-A');
    h.git('commit', '-q', '-m', 'server');
    const [s] = await h.importPlan(plan(h, 'leftover', [task('starts-a-server')]));
    /*
     * The second step waits until the server is listening (up to 30 s), so the reap at the task's
     * end always finds a port to name: the runner reads the listening ports only then, and a fixed
     * sleep could lose that race to a slow node start on a loaded machine.
     */
    h.chat.script(
      reply.steps(
        `Start-Process -FilePath node -ArgumentList 'server.js','${port}' -WindowStyle Hidden`,
        `$d=(Get-Date).AddSeconds(30); while (-not (Get-NetTCPConnection -State Listen -LocalPort ${port} -EA 0) -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 200 }`,
      ),
      reply.done(),
    );
    ended = (await h.run(s!.id)).tasks[0] as Ended;
    t.check('done', ended.status, 'done');
    t.truthy('the task names the node server it left, with its port', (ended.leftovers ?? []).some((l) => /^node(\.exe)?$/i.test(l.name) && l.ports.includes(port)), ended.leftovers);
    const free = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    t.check('and the port is free again after the run', free, true);
  } finally {
    // Only if the runner did not: the server this check started, and nothing else — first as the
    // runner reported it, then by its command line in case the runner never saw it at all.
    for (const l of ended?.leftovers ?? []) {
      if (!l.command.includes('server.js') || !l.command.includes(String(port))) continue;
      try {
        process.kill(l.pid);
      } catch {
        /* already gone, as it should be */
      }
    }
    stopServerOn(port);
  }
});

// --- shells: faked inventories last, so the machine's own is what every other run recorded -----

await scenario(
  'a step naming a shell this machine lacks is refused and rewritten, not substituted',
  {},
  async (h) => {
    const [s] = await h.importPlan(plan(h, 'noshell', [task('pwsh-missing')], { vcs: false }));
    h.chat.script(
      reply.steps({ cmd: 'Write-Output x', shell: 'pwsh' }),
      (m) => {
        const all = `${m.text}\n${attachedText(m)}`;
        t.truthy('the chat is told the step named a shell this machine has not got', all.includes('named a shell this machine has not got'), m.text);
        t.truthy('and to write "shell": "powershell"', all.includes('"shell": "powershell"'), all.slice(-900));
        t.truthy('and never told to install anything', !all.includes('winget'), all.slice(-900));
        return reply.steps('Write-Output y');
      },
      reply.done(),
    );
    const ended = (await h.run(s!.id)).tasks[0] as Ended;
    t.check('done', ended.status, 'done');
    t.check('one step refused', ended.stats?.stepsRefused, 1);
  },
  { shells: { powershell: realShells.powershell ?? undefined, cmd: realShells.cmd ?? undefined } },
);

await scenario(
  'a shell that will not start is an environment problem, not a round',
  {},
  async (h) => {
    // (a) a step in it: the task ends there, and nothing more is sent.
    const [a] = await h.importPlan(plan(h, 'nostart', [task('pwsh-broken')], { vcs: false }));
    h.chat.script(reply.steps({ cmd: 'Write-Output x', shell: 'pwsh' }));
    const ended = (await h.run(a!.id)).tasks[0] as Ended;
    t.check('failed, stopCode environment', [ended.status, ended.stopCode ?? null], ['failed', 'environment']);
    t.truthy('the reason says the machine could not run it', /this machine could not run it/.test(ended.reason ?? ''), ended.reason);
    t.check('nothing was sent after that step', h.chat.exchanged.length, 1);

    // (b) a check in it: the same ending, and the chat is not asked to fix an interpreter.
    const [b] = await h.importPlan(
      plan(h, 'nostart-check', [task('pwsh-check-broken', { checks: [{ name: 'echo in pwsh', expect: 'exit-zero', run: 'echo x', shell: 'pwsh' }, readmeIntact] })], { vcs: false }),
    );
    h.chat.script(reply.steps({ cmd: 'Write-Output x', shell: 'powershell' }), reply.done());
    const checked = (await h.run(b!.id)).tasks[0] as Ended;
    t.check('failed, stopCode environment', [checked.status, checked.stopCode ?? null], ['failed', 'environment']);
    t.check('no message said the task was not finished', h.chat.sent.filter((m) => m.text.includes('not finished yet')).length, 0);
  },
  { shells: { pwsh: 'C:\\nope\\pwsh.exe', powershell: realShells.powershell ?? undefined, cmd: realShells.cmd ?? undefined } },
);

t.finish();
