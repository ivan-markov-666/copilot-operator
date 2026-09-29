/**
 * Everything that happens to a task after its first run, end to end through the API, with the
 * scripted chat of test/support/fakeChat.ts in place of Copilot. No browser, no Microsoft 365.
 *
 * - a task that stops at the message limit, continued in the same chat and on the same branch;
 * - "only this one": a run of one picked task while the rest of the queue waits;
 * - a done task given a new prompt that builds on what it did;
 * - the operator stopping a run in the middle of a step;
 * - the side-by-side changes of a finished task;
 * - where a session's first branch is cut from (`startFrom`).
 *
 *   npm run check:e2e-continue
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, waitFor, Tally, type Harness, type SessionView } from './support/harness.js';
import { reply } from './support/fakeChat.js';

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

await scenario('a task stopped at the message limit is continued in the same chat, on the same branch', { limits: { maxIterations: 5 } }, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'limited', [task('long-job', 'result.txt', 'finished')])] });
  // Rounds that each do something different, so neither the repeat guard nor the stall guard ends it
  // first. Six replies for a limit of five: the answer to the fifth report is read before the count
  // is looked at, and it is what the chat planned next — the continuation starts from it.
  for (let i = 1; i <= 6; i++) h.chat.script(reply.steps(`Write-Output 'round ${i}'`));
  const stopped = (await h.run(s!.id)).tasks[0]!;
  t.check('the task stopped at the limit', stopped.status, 'limit-reached');
  t.truthy('and says which limit', /maxIterations \(5\)/.test(stopped.reason ?? ''), stopped.reason);
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

  type Ratio = { n: number; of: number };
  const figures = (await h.call<{ rows: Array<{ group: string; firstPass: Ratio; doneInTheEnd: Ratio; resumed: Ratio; manualInterventions: number; attempts: number }> }>('GET', '/metrics')).rows[0]!;
  t.check('the register\'s figures: not done first time, done in the end, resumed and finished, one person stepping in',
    [figures.attempts, figures.firstPass, figures.doneInTheEnd, figures.resumed, figures.manualInterventions],
    [2, { n: 0, of: 1 }, { n: 1, of: 1 }, { n: 1, of: 1 }, 1]);
});

await scenario('"only this one": a run of one picked task leaves the rest queued', {}, async (h) => {
  const [s] = await h.importPlan({
    version: 1,
    sessions: [session(h, 'picked', [task('first-file', 'one.txt', 'one'), task('second-file', 'two.txt', 'two'), task('third-file', 'three.txt', 'three')], {}, { onFailure: 'continue' })],
  });
  const second = s!.tasks[1]!;
  h.chat.script(write('two.txt', 'two'), reply.done());
  const r = await h.call<{ started?: boolean }>('POST', '/batch/start', { sessionIds: [s!.id], mode: 'unattended', taskIds: [second.id] });
  t.truthy('the run of one task started', r && r.started !== false, r);
  await h.idle();
  const after = await h.session(s!.id);
  t.check('only the picked task ran', after.tasks.map((x) => x.status), ['queued', 'done', 'queued']);
  t.check('and only its file was written', [existsSync(join(h.repo, 'one.txt')), h.git('show', 'cop/picked:two.txt'), existsSync(join(h.repo, 'three.txt'))], [false, 'two', false]);
});

await scenario('a done task given a new prompt builds on its own work', {}, async (h) => {
  const [s] = await h.importPlan({ version: 1, sessions: [session(h, 'builds', [task('greeting', 'hello.txt', 'hi')])] });
  h.chat.script(write('hello.txt', 'hi'), reply.done());
  const done = (await h.run(s!.id)).tasks[0]!;
  const firstCommit = done.vcs?.commit;
  t.check('the first attempt is done', done.status, 'done');

  const newPrompt = 'Also create bye.txt in the repository root holding exactly the word bye, and keep hello.txt as it is.';
  const queued = await h.call<{ status: string; buildsOn?: unknown; prompt: string }>('POST', `/sessions/${s!.id}/tasks/${done.id}/rerun`, {
    prompt: newPrompt,
    checks: [{ name: 'bye.txt written', expect: 'file-contains', file: 'bye.txt', value: 'bye' }],
    buildOnFinished: true,
  });
  t.check('queued again with the new prompt, building on the finished work', [queued.status, queued.prompt, Boolean(queued.buildsOn)], ['queued', newPrompt, true]);

  h.chat.script(
    (m) => {
      t.truthy('the chat gets the new instruction', m.text.includes(newPrompt), m.text.slice(0, 300));
      t.truthy('and is told the earlier work is already in the tree', /build on/i.test(m.text), m.text.slice(0, 400));
      return write('bye.txt', 'bye');
    },
    reply.done(),
  );
  const after = (await h.run(s!.id)).tasks[0]!;
  t.check('the new attempt is done', after.status, 'done');
  t.check('on the same branch', after.vcs?.branch, 'cop/builds');
  t.check('its commit sits on top of the first attempt\'s', h.git('rev-parse', `${after.vcs?.commit}^`), firstCommit);
  t.check('both files are there', [h.git('show', 'cop/builds:hello.txt'), h.git('show', 'cop/builds:bye.txt')], ['hi', 'bye']);
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
  h.chat.script(reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8", "Set-Content -Path README.md -Value '# changed' -Encoding utf8"), reply.done());
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

t.finish();
