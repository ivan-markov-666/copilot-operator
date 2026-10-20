/**
 * Everything that happens to a task after its first run, end to end through the API, with the
 * scripted chat of test/support/fakeChat.ts in place of Copilot. No browser, no Microsoft 365.
 *
 * - a task that blocked, carried on with the operator's new prompt: same chat and branch, the blocked
 *   attempt's work kept, the chat told how it ended and then given the prompt;
 * - a task that stops at the message limit, continued in the same chat and on the same branch;
 * - every other limit from the settings — the reply wait, rounds of fixing checks — continued the same way,
 *   with its work committed and "Continue" offered on its register row;
 * - "only this one": a run of one picked task while the rest of the queue waits;
 * - a done task given a new prompt that builds on what it did;
 * - the operator stopping a run in the middle of a step;
 * - the side-by-side changes of a finished task;
 * - where a session's first branch is cut from (`startFrom`).
 *
 *   npm run check:e2e-continue
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, waitFor, Tally, type Harness, type SessionView } from './support/harness.js';
import { reply } from './support/fakeChat.js';
import { SessionStore } from '../src/session/store.js';
import { isContinuable, type Task } from '../src/session/model.js';
import { ReplyTimeoutError } from '../src/transport/chatTransport.js';

const t = new Tally();

function session(h: Harness, name: string, tasks: unknown[], vcs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    onFailure: 'stop',
    vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: name, ...vcs },
    review: { enabled: false },
    tasks,
    ...extra,
  };
}

const task = (title: string, file: string, text: string): Record<string, unknown> => ({
  title,
  prompt: `Create ${file} in the repository root holding exactly the text ${text}, and nothing else.`,
  checks: [{ name: `${file} written`, expect: 'file-contains', file, value: text }],
});

const write = (file: string, text: string): string => reply.steps(`Set-Content -Path ${file} -Value '${text}' -Encoding utf8`);

async function scenario(title: string, settings: Record<string, unknown>, body: (h: Harness) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings });
  try {
    await body(h);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
    t.check('every chat window opened was closed again', h.chat.opened, h.chat.closed);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

/*
 * Asked for on 2026-10-13: a task that failed goes on with a new prompt from the operator — from where it
 * got to, in its own chat and on its own branch, with the chat told how it ended and why.
 */
await scenario('a task that blocked is carried on with a new prompt, from where it got to', { limits: { retryBlockedInFreshChat: 0 } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'followup', [task('okta-tests', 'result.txt', 'finished')])] });
  h.chat.script(write('partial.txt', 'half'), reply.blocked());
  const blocked = (await h.run(s!.id)).tasks[0]!;
  t.check('the task blocked, after a step that wrote a file', [blocked.status, blocked.vcs?.branch, h.git('show', 'cop/followup:partial.txt')], ['blocked', 'cop/followup', 'half']);
  const firstChat = (await h.session(s!.id)).chat?.chatId;

  const refused = await h.raw('POST', `/sessions/${s!.id}/tasks/${blocked.id}/continue`, {});
  t.truthy('without a new prompt it is not carried on', refused.status === 400 && /new prompt/.test(JSON.stringify(refused.body)), refused.body);

  const instruction = 'The file it needs is not missing: create result.txt yourself, holding exactly the text finished.';
  const queued = await h.call<{ status: string; prompt: string; continuing?: { how?: string; instruction?: string; ended?: { status?: string } } }>(
    'POST',
    `/sessions/${s!.id}/tasks/${blocked.id}/continue`,
    { instruction },
  );
  t.check('with one: queued to carry on after the failure, the prompt added to the task\'s own', [queued.status, queued.continuing?.how, queued.continuing?.instruction, queued.continuing?.ended?.status, queued.prompt.startsWith('Create result.txt')], ['queued', 'failed', instruction, 'blocked', true]);

  h.chat.script(
    (m) => {
      t.check('it goes back into the same conversation', m.chatId, firstChat);
      t.truthy('which is told the attempt did not succeed, how it ended and why', /did not succeed: it ended blocked/.test(m.text), m.text.slice(0, 500));
      t.truthy('that its work is there and not to start over', /what it changed is in your working tree\. Do not start over/.test(m.text), m.text.slice(0, 600));
      t.truthy('and then given the new prompt', m.text.includes('## New instruction from the operator') && m.text.includes(instruction), m.text.slice(-600));
      return reply.steps('Get-Content partial.txt', "Set-Content -Path result.txt -Value 'finished' -Encoding utf8");
    },
    reply.done(),
  );
  const after = (await h.run(s!.id)).tasks[0]!;
  t.check('it finishes on the same branch, on top of the work the blocked attempt did', [after.status, after.vcs?.branch, h.git('show', 'cop/followup:partial.txt'), h.git('show', 'cop/followup:result.txt')], ['done', 'cop/followup', 'half', 'finished']);
  t.check('the blocked attempt stays on the record', after.attempts?.map((a) => a.status), ['blocked']);
  const card = (await h.session(s!.id)).tasks[0] as unknown as { continuing?: { instruction?: string; fromAttempt?: number } };
  t.check('and the task says which prompt it carried on with, after which attempt', [card.continuing?.instruction, card.continuing?.fromAttempt], [instruction, 1]);
});

await scenario('a task stopped at the message limit is continued in the same chat, on the same branch', { limits: { maxIterations: 5 } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'limited', [task('long-job', 'result.txt', 'finished')])] });
  // Rounds that each do something different, so neither the repeat guard nor the stall guard ends it
  // first. Six replies for a limit of five: the answer to the fifth report is read before the count
  // is looked at, and it is what the chat planned next — the continuation starts from it.
  for (let i = 1; i <= 6; i++) h.chat.script(reply.steps(`Write-Output 'round ${i}'`));
  const stopped = (await h.run(s!.id)).tasks[0]!;
  t.check('the task stopped at the limit', stopped.status, 'limit-reached');
  t.truthy('and says which limit', /maxIterations \(5\)/.test(stopped.reason ?? ''), stopped.reason);
  t.check('and records it', (stopped as unknown as { limit?: unknown }).limit, { setting: 'maxIterations', value: 5 });
  const firstChat = (await h.session(s!.id)).chat?.chatId;

  const queued = await h.call<{ status: string; continuing?: { how?: string } }>('POST', `/sessions/${s!.id}/tasks/${stopped.id}/continue`);
  t.check('"Continue in the same chat" queues it again, as a continuation of a limit', [queued.status, queued.continuing?.how], ['queued', 'limit']);

  h.chat.script(
    (m) => {
      t.check('the continuation goes into the same conversation', m.chatId, firstChat);
      t.truthy('and tells the chat to carry on, not start over', /Continue task 1/.test(m.text) && /Do not start over/.test(m.text), m.text.slice(0, 300));
      t.truthy('without sending the assignment again', !m.text.includes('holding exactly the text finished'), m.text.slice(0, 300));
      return write('result.txt', 'finished');
    },
    reply.done(),
  );
  const after = (await h.run(s!.id)).tasks[0]!;
  t.check('the continued attempt finishes', after.status, 'done');
  t.check('as attempt 2, with attempt 1 kept on the record', [after.attempt, after.attempts?.[0]?.status], [2, 'limit-reached']);
  t.check('on the branch the first attempt used', after.vcs?.branch, 'cop/limited');
  t.check('the contract was sent only once', h.chat.sent.filter((m) => m.contract === 'task').length, 1);

});

type Row = { taskId: string; status: string; continuable?: boolean; limit?: { setting: string; value: number }; branch?: string; commit?: string };
/** The task as the register showed it (the register went on 2026-10-20): whether it can be carried on, its limit, its branch. */
const row = async (h: Harness, taskId: string): Promise<Row> => {
  for (const s of await h.call<Array<{ tasks: Array<Task & { vcs?: { branch?: string; commit?: string } }> }>>('GET', '/sessions')) {
    const x = s.tasks.find((y) => y.id === taskId);
    if (x) return { taskId, status: x.status, continuable: isContinuable(x) || undefined, ...(x.limit ? { limit: x.limit } : {}), ...(x.vcs?.branch ? { branch: x.vcs.branch } : {}), ...(x.vcs?.commit ? { commit: x.vcs.commit } : {}) };
  }
  throw new Error(`no task ${taskId}`);
};

/*
 * Asked for on 2026-09-30: a task stopped by any limit from the settings must offer "Continue", with its
 * work safe on its branch. Seen live: a task stopped at its minutes, and the register showed no way on.
 */
await scenario('a reply that takes longer than Settings allow: stopped at a limit, work committed, continued', {}, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'slow', [task('slow-job', 'result.txt', 'finished')])] });
  h.chat.script(write('partial.txt', 'half'), () => {
    throw new ReplyTimeoutError(900, 'Copilot did not finish a reply within 900s (new turn seen: true, still streaming: true).');
  });
  const stopped = (await h.run(s!.id)).tasks[0]!;
  t.check('it stopped at a limit, not failed', stopped.status, 'limit-reached');
  t.check('the reply wait is the limit recorded', (stopped as unknown as { limit?: unknown }).limit, { setting: 'replyTimeoutSec', value: 900 });
  t.truthy('the work so far is committed on the task\'s branch', !!stopped.vcs?.commit && h.git('show', `${stopped.vcs?.branch}:partial.txt`) === 'half', stopped.vcs);
  const r = await row(h, stopped.id);
  t.check('the register offers "Continue" on the row, naming the branch and commit', [r.continuable, r.branch, r.commit], [true, 'cop/slow', stopped.vcs?.commit]);
  const firstChat = (await h.session(s!.id)).chat?.chatId;

  await h.call('POST', `/sessions/${s!.id}/tasks/${stopped.id}/continue`);
  h.chat.script(
    (m) => {
      t.check('the continuation goes into the same conversation', m.chatId, firstChat);
      t.truthy('and names the limit', /900 seconds to wait for one reply/.test(m.text) && /Do not start over/.test(m.text), m.text.slice(0, 400));
      return write('result.txt', 'finished');
    },
    reply.done(),
  );
  const after = (await h.run(s!.id)).tasks[0]!;
  t.check('the continued attempt finishes, on the same branch, with the earlier work', [after.status, after.vcs?.branch, h.git('show', 'cop/slow:partial.txt')], ['done', 'cop/slow', 'half']);
});

await scenario('out of rounds of fixing failed checks: failed, but continued in the same chat', { limits: { maxCheckRounds: 1 } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'rounds', [task('checked-job', 'result.txt', 'finished')])] });
  h.chat.script(write('result.txt', 'nearly'), reply.done(), write('result.txt', 'almost'), reply.done());
  const stopped = (await h.run(s!.id)).tasks[0]!;
  t.check('it failed: the checks said no', stopped.status, 'failed');
  t.check('and the limit that ended it is recorded', (stopped as unknown as { limit?: unknown }).limit, { setting: 'maxCheckRounds', value: 1 });
  t.check('the register offers "Continue"', (await row(h, stopped.id)).continuable, true);

  const queued = await h.call<{ status: string; continuing?: { how?: string } }>('POST', `/sessions/${s!.id}/tasks/${stopped.id}/continue`);
  t.check('"Continue" is accepted, as a limit', [queued.status, queued.continuing?.how], ['queued', 'limit']);
  h.chat.script(
    (m) => {
      t.truthy('the chat is told the rounds ran out and what failed is still open', /1 rounds of fixing failed checks/.test(m.text) && /still open/.test(m.text), m.text.slice(0, 400));
      return write('result.txt', 'finished');
    },
    reply.done(),
  );
  t.check('the continued attempt finishes', (await h.run(s!.id)).tasks[0]!.status, 'done');
});

/*
 * Asked for on 2026-10-14: like Claude Code, the work goes on until the task is done; the limits bound it.
 * A task a limit stopped is carried on at once in its own chat, up to limits.autoContinue times.
 */
await scenario('keep going: stopped at the message limit, carried on by itself in its chat, until done', { limits: { maxIterations: 3, autoContinue: 2 } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'nonstop', [task('long-job', 'result.txt', 'finished')])] });
  for (let i = 1; i <= 4; i++) h.chat.script(reply.steps(`Write-Output 'round ${i}'`));
  let firstChat = '';
  h.chat.script(
    (m) => {
      firstChat = h.chat.sent.find((x) => x.contract === 'task')?.chatId ?? '';
      t.check('the continuation goes into the same conversation, with nobody pressing anything', m.chatId, firstChat);
      t.truthy('and tells the chat to carry on, not start over', /Continue task 1/.test(m.text) && /Do not start over/.test(m.text), m.text.slice(0, 300));
      return write('result.txt', 'finished');
    },
    reply.done(),
  );
  const after = (await h.run(s!.id)).tasks[0]!;
  t.check('one run: the task is done, as attempt 2, the limit-reached attempt kept', [after.status, after.attempt, after.attempts?.map((a) => a.status)], ['done', 2, ['limit-reached']]);
  const types = (await h.call<Array<{ type: string; data?: Record<string, unknown> }>>('GET', `/sessions/${s!.id}/events`)).filter((e) => e.type.startsWith('task-auto-continue'));
  t.check('the events say it was carried on once, and that it ended done', types.map((e) => [e.type, e.data?.setting ?? e.data?.status]), [['task-auto-continue', 'maxIterations'], ['task-auto-continue-ended', 'done']]);
  t.check('the contract was sent only once', h.chat.sent.filter((m) => m.contract === 'task').length, 1);
});

await scenario('keep going is bounded: after limits.autoContinue times it waits for the operator', { limits: { maxIterations: 2, autoContinue: 1 } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'bounded', [task('endless-job', 'result.txt', 'finished')])] });
  // Two attempts of two messages each, every round doing something new, so only the limits end them.
  for (let i = 1; i <= 3; i++) h.chat.script(reply.steps(`Write-Output 'first ${i}'`));
  for (let i = 1; i <= 3; i++) h.chat.script(reply.steps(`Write-Output 'second ${i}'`));
  const after = (await h.run(s!.id)).tasks[0]!;
  t.check('carried on once, then stopped at the limit again and left for the operator', [after.status, after.attempt, after.attempts?.map((a) => a.status)], ['limit-reached', 2, ['limit-reached']]);
  const ended = (await h.call<Array<{ type: string; message?: string }>>('GET', `/sessions/${s!.id}/events`)).find((e) => e.type === 'task-auto-continue-ended');
  t.truthy('the record says the bound was reached', /limits\.autoContinue \(1\) reached/.test(ended?.message ?? ''), ended);
  t.check('and "Continue" is still offered', (await row(h, after.id)).continuable, true);
});

await scenario('keep going: out of rounds of fixing failed checks, carried on until the checks pass', { limits: { maxCheckRounds: 1, autoContinue: 1 } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'checked', [task('checked-job', 'result.txt', 'finished')])] });
  h.chat.script(
    write('result.txt', 'nearly'), reply.done(), write('result.txt', 'almost'), reply.done(),
    (m) => {
      t.truthy('the chat is told the rounds ran out and what failed is still open', /1 rounds of fixing failed checks/.test(m.text) && /still open/.test(m.text), m.text.slice(0, 400));
      return write('result.txt', 'finished');
    },
    reply.done(),
  );
  const after = (await h.run(s!.id)).tasks[0]!;
  t.check('done in the same run, the failed attempt kept', [after.status, after.attempts?.map((a) => a.status)], ['done', ['failed']]);
});

await scenario('stopping a run in the middle of a step ends the task as aborted', {}, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'stopped', [task('slow', 'late.txt', 'late')])] });
  h.chat.script(reply.steps('Start-Sleep -Seconds 4', "Set-Content -Path late.txt -Value 'late' -Encoding utf8"), reply.done());
  const r = await h.call<{ started: boolean }>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  t.check('started', r.started, true);
  await waitFor('the first step to be running', async () => {
    const x = await h.session(s!.id);
    return x.tasks[0]!.status === 'running' && h.chat.exchanged.length >= 1;
  });
  await new Promise((res) => setTimeout(res, 500));
  const stop = await h.call<{ stopping: boolean }>('POST', `/sessions/${s!.id}/stop`);
  t.check('the stop was taken', stop.stopping, true);
  await h.idle();
  const after = (await h.session(s!.id)).tasks[0]!;
  t.check('the task ended aborted', after.status, 'aborted');
  t.check('the step after the one that was running never ran', existsSync(join(h.repo, 'late.txt')), false);
  t.check('the session is idle again', (await h.session(s!.id)).status, 'idle');
  // The "done" left in the script was never asked for: the run stopped before the chat was.
  t.check('the chat was not asked anything after the stop', h.chat.discard(), 1);
});

await scenario('the changes of a finished task, file by file', {}, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'diffed', [task('greeting', 'hello.txt', 'hi')])] });
  // README.md is committed with LF: written so it keeps them (a whole-file flip to CRLF is pointed out, see live-fixes C7).
  h.chat.script(reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8", 'Set-Content -NoNewline -Path README.md -Value "# changed`n" -Encoding utf8'), reply.done());
  const done = (await h.run(s!.id)).tasks[0]!;
  type Changes = { ok: boolean; files: Array<{ path: string; status: string }> };
  const changes = await h.call<Changes>('GET', `/sessions/${s!.id}/tasks/${done.id}/changes`);
  t.check('two files changed: one added, one modified', changes.files.map((f) => `${f.status} ${f.path}`).sort(), ['A hello.txt', 'M README.md']);
  type FileDiff = { before: string | null; after: string | null; status: string };
  const added = await h.call<FileDiff>('GET', `/sessions/${s!.id}/tasks/${done.id}/changes/file?path=hello.txt`);
  t.check('an added file has no before and the new text after', [added.before, added.after?.trim()], [null, 'hi']);
  const modified = await h.call<FileDiff>('GET', `/sessions/${s!.id}/tasks/${done.id}/changes/file?path=README.md`);
  t.check('a modified file has both sides', [modified.before?.trim(), modified.after?.trim()], ['# fixture', '# changed']);
  const other = await h.raw('GET', `/sessions/${s!.id}/tasks/${done.id}/changes/file?path=${encodeURIComponent('../../secret.txt')}`);
  t.truthy('a path the task did not change is refused', other.status >= 400, other);
});

await scenario('where a session starts: after the previous session, or from a named branch', {}, async (h) => {
  const [a] = await h.importPlan({ version: 1, sessions: [session(h, 'first', [task('greeting', 'hello.txt', 'hi')], { startFrom: 'branch', baseBranch: 'main' })] });
  h.chat.script(write('hello.txt', 'hi'), reply.done());
  const aDone = await h.run(a!.id);
  const aEnd = aDone.tasks[0]!.vcs?.commit;
  t.check('the first session is done', aDone.tasks[0]!.status, 'done');
  // The repository is left on the first session's branch, which is exactly what `head` would build on.
  h.git('checkout', '-q', 'main');

  const [b, c] = await h.importPlan({
    version: 1,
    sessions: [
      session(h, 'second', [task('farewell', 'bye.txt', 'bye')], { startFrom: 'previous-session' }),
      session(h, 'fresh', [task('other', 'other.txt', 'other')], { startFrom: 'branch', baseBranch: 'main' }),
    ],
  });
  h.chat.script(
    (m) => {
      t.truthy('the chat is told whose work it continues', m.text.includes('continues the work of the earlier session "first"'), m.text.slice(0, 500));
      return write('bye.txt', 'bye');
    },
    reply.done(),
  );
  const bDone: SessionView = await h.run(b!.id);
  t.check('"previous-session" starts at the end of the first session\'s branch', [bDone.vcsStart?.commit, bDone.vcsStart?.kind], [aEnd, 'previous-session']);
  t.check('so its branch has both files', [h.git('show', 'cop/second:hello.txt'), h.git('show', 'cop/second:bye.txt')], ['hi', 'bye']);

  h.chat.script(write('other.txt', 'other'), reply.done());
  const cDone: SessionView = await h.run(c!.id);
  t.check('"branch" starts at main, whatever ran before', [cDone.vcsStart?.commit, cDone.vcsStart?.kind], [h.git('rev-parse', 'main'), 'branch']);
  t.truthy('so its branch does not have the earlier sessions\' files', !h.git('ls-tree', '--name-only', 'cop/fresh').split('\n').includes('hello.txt'), h.git('ls-tree', '--name-only', 'cop/fresh'));
});

await scenario('a maintenance task rewritten as an audit: old checks gone, repository untouched, done only on the audit deliverable', { limits: { retryBlockedInFreshChat: 0 } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'maint', [task('greeting', 'hello.txt', 'hi')])] });
  h.chat.script(write('hello.txt', 'hi'), reply.done());
  const done = (await h.run(s!.id)).tasks[0]!;
  t.check('the maintenance attempt is done', done.status, 'done');

  // An earlier review left a check behind: "hello.txt says HELLO" — true of the old intent at best.
  const store = new SessionStore(h.dataDir, join(import.meta.dirname, '..', 'prompts', 'level1.md'));
  await store.updateSession(s!.id, (x) => {
    x.tasks[0]!.reviewChecks = [
      { check: { name: 'greeting is loud', expect: 'file-contains', file: 'hello.txt', value: 'HELLO' }, findingId: 'r1f1', what: 'the greeting is too quiet', round: 1, attempt: 1, state: 'active' },
    ];
  });

  const auditPrompt = 'Audit the greeting: write audit/report.md with a "## Findings" section describing hello.txt. Change nothing else.';
  const auditCheck = { name: 'audit report written', expect: 'file-contains', file: 'audit/report.md', value: '## Findings' };
  const queued = await h.call<{ status: string; checks?: Array<{ name: string }>; scope?: string[]; reviewChecks?: Array<{ state: string; droppedBecause?: string }> }>(
    'POST',
    `/sessions/${s!.id}/tasks/${done.id}/rerun`,
    { prompt: auditPrompt, checks: [auditCheck], scope: ['audit/'], buildOnFinished: true },
  );
  t.check('queued with only the audit\'s check', queued.checks?.map((c) => c.name), ['audit report written']);
  t.check('scoped to the audit folder', queued.scope, ['audit/']);
  t.truthy('the inherited review check is dropped, with why', queued.reviewChecks?.every((r) => r.state === 'dropped' && /new prompt/.test(r.droppedBecause ?? '')), queued.reviewChecks);

  h.chat.script(
    (m) => {
      t.truthy('the chat gets the audit prompt and its scope', m.text.includes(auditPrompt) && /## Scope/.test(m.text), m.text.slice(0, 400));
      // It "fixes" the greeting as well, which the audit does not allow.
      return reply.steps("Set-Content -Path hello.txt -Value 'HELLO' -Encoding utf8", "New-Item -ItemType Directory -Force -Path audit | Out-Null; Set-Content -Path audit/report.md -Value '# Audit' -Encoding utf8");
    },
    (m) => {
      t.truthy('it is told the edit was put back', /put back by the runner: hello\.txt/.test(m.text), m.text.slice(0, 500));
      return reply.done();
    },
    (m) => {
      const said = m.text + Object.values(m.attached).join('\n');
      t.truthy('"done" without the deliverable is turned down by the audit check', said.includes('audit report written'), said.slice(0, 400));
      t.truthy('and not by the old review check', !said.includes('greeting is loud'), said.slice(0, 600));
      return reply.steps("Add-Content -Path audit/report.md -Value '## Findings' -Encoding utf8", "Add-Content -Path audit/report.md -Value 'hello.txt holds the word hi.' -Encoding utf8");
    },
    reply.done(),
  );
  const after = (await h.run(s!.id)).tasks[0]!;
  t.check('the audit is done', after.status, 'done');
  t.check('the repository outside the audit is as it was', h.git('show', 'cop/maint:hello.txt'), 'hi');
  t.truthy('the deliverable is committed', h.git('show', 'cop/maint:audit/report.md').includes('## Findings'));
  t.check('what was put back is on the task', (after as unknown as { scopeReverted?: string[] }).scopeReverted, ['hello.txt']);
});

await scenario('a read-only task that changes a file: put back every round, and it still finishes', {}, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'readonly', [{ title: 'audit-readme', prompt: 'Read README.md and report in your summary how long it is. Change nothing.', readOnly: true }])] });
  h.chat.script(
    reply.steps("Set-Content -Path README.md -Value 'rewritten' -Encoding utf8", '(Get-Content README.md).Length'),
    (m) => {
      t.truthy('the chat is told the task is read-only and the change was put back', /Changed by a read-only task, so put back by the runner: README\.md/.test(m.text) && /read-only: it may change no file/.test(m.text), m.text.slice(0, 500));
      return reply.done();
    },
  );
  const after = (await h.run(s!.id)).tasks[0]!;
  t.check('done, not failed: nothing it changed survived', after.status, 'done');
  t.check('README.md is untouched', readFileSync(join(h.repo, 'README.md'), 'utf8'), '# fixture\n');
  t.check('and nothing was committed', h.git('rev-list', '--count', 'main..cop/readonly'), '0');
});

await scenario('a task that contradicts itself is stopped before anything is sent', {}, async (h) => {
  const [s] = await h.importPlan({
    version: 1,
    sessions: [session(h, 'contradiction', [{ title: 'audit-only', prompt: 'Audit the project and report; change nothing at all in the repository.', readOnly: true, checks: [{ name: 'fix applied', expect: 'file-contains', file: 'README.md', value: 'fixed' }] }])],
  });
  // Refused before the browser opens now, the task left queued with no attempt (live-fixes C4).
  const r = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  t.check('refused before starting', r.started, false);
  t.truthy('the reason names the contradiction', /"fix applied" fails now and can only pass if README\.md changes, but the task is read-only/.test(r.reason ?? ''), r.reason);
  t.check('the task stays queued', (await h.session(s!.id)).tasks[0]!.status, 'queued');
  t.check('nothing was sent to the chat', h.chat.sent.length, 0);
});

t.finish();
