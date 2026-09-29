/**
 * A task from start to finish, through the API the interface uses, with a scripted chat in place of
 * Copilot (test/support/fakeChat.ts). No browser is opened and nothing is sent to Microsoft 365.
 *
 * What is real: the API and its guard, the session store, the runner, the step gate, the shells the
 * steps run in, the checks, the review loop and git. What is scripted: only what the chat answers.
 * Each scenario below is one thing an operator does or one way a chat misbehaves, and each asserts
 * both what the program did (status, files, branches) and what it told the chat.
 *
 *   npm run check:e2e-run
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

function plan(h: Harness, name: string, tasks: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    sessions: [
      {
        name,
        onFailure: 'stop',
        vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: name },
        review: { enabled: false },
        tasks,
        ...extra,
      },
    ],
  };
}

const greeting = {
  title: 'write-greeting',
  prompt: 'Create hello.txt in the repository root holding exactly the word hi, and nothing else.',
  checks: [{ name: 'greeting written', expect: 'file-contains', file: 'hello.txt', value: 'hi' }],
};

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

await scenario('an unattended task, from the plan to the commit', { copilot: { defaultModel: 'GPT 5.6 Think deeper' } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'hello', [greeting]));
  h.chat.script(reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8"), reply.done());
  const after = await h.run(s!.id);
  const task = after.tasks[0]!;

  t.check('the task is done', task.status, 'done');
  t.check('its work is on the session branch', h.git('show', 'cop/hello:hello.txt'), 'hi');
  t.check('and not on main', existsSync(join(h.repo, 'hello.txt')) && h.git('rev-parse', '--abbrev-ref', 'HEAD') === 'main', false);
  t.check('the branch holds one commit on top of main', h.git('rev-list', '--count', 'main..cop/hello'), '1');
  t.truthy('the commit says it was not pushed', /Not pushed\./.test(h.git('log', '-1', '--format=%B', 'cop/hello')));
  t.check('the tree is clean afterwards', h.git('status', '--porcelain'), '');
  const handoff = task.handoff;
  t.check('the handoff: outcome, files, checks, branch', [handoff?.outcome.status, handoff?.changedFiles.map((f) => f.path), handoff?.validation.every((v) => v.passed), handoff?.vcs.branch, handoff?.vcs.pushed], ['done', ['hello.txt'], true, 'cop/hello', false]);
  t.truthy('and says the push is left to the operator', handoff?.manual.some((m) => /push cop\/hello/.test(m)), handoff?.manual);
  t.check('with nothing left unrun and nothing known wrong', [handoff?.notExecuted, handoff?.knownIssues], [[], []]);

  t.check('a session with no model of its own asked for the one in Settings', h.chat.modelRequests, ['GPT 5.6 Think deeper']);
  t.check('and recorded what the chat ended up on', after.modelInUse, 'GPT 5.6 Think deeper');
  t.truthy('the conversation was named op/<code>/<session>', /^op\/[a-z0-9]+\/hello$/.test(after.chat?.name ?? ''), after.chat);
  t.check('the contract went once, then the task', h.chat.sent.map((m) => m.contract ?? 'other'), ['task', 'other', 'other']);
  const results = h.chat.exchanged[1]!;
  t.check('the step results went back as one attached report', results.attachments.length, 1);
  t.truthy('the report says what ran', Object.values(results.attached)[0]!.includes('Set-Content'), Object.values(results.attached)[0]!.slice(0, 300));

  // A second task in the same session: same conversation, no second contract, builds on the first.
  const added = await h.call<{ id: string }>('POST', `/sessions/${s!.id}/tasks`, {
    title: 'second-line',
    prompt: 'Add a second file bye.txt holding the word bye, next to hello.txt, and change nothing else.',
  });
  h.chat.script(
    (m) => {
      t.truthy('the next task is sent into the same conversation', m.chatId === after.chat?.chatId, m.chatId);
      t.truthy('and says so', /same conversation/i.test(m.text), m.text.slice(0, 200));
      return reply.steps("Set-Content -Path bye.txt -Value 'bye' -Encoding utf8");
    },
    reply.done(),
  );
  const again = await h.run(s!.id);
  t.check('the second task is done', again.tasks.find((x) => x.id === added.id)?.status, 'done');
  t.check('the contract was not sent a second time', h.chat.sent.filter((m) => m.contract === 'task').length, 1);
  t.check('both files are on the branch, one commit each', [h.git('show', 'cop/hello:hello.txt'), h.git('show', 'cop/hello:bye.txt'), h.git('rev-list', '--count', 'main..cop/hello')], ['hi', 'bye', '2']);
});

await scenario('a supervised run asks before every step, on the approvals route', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'asked', [greeting]));
  h.chat.script(
    reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8", "Set-Content -Path skipped.txt -Value 'no' -Encoding utf8"),
    (m) => {
      const report = Object.values(m.attached)[0] ?? '';
      t.truthy('the chat is told the second step was skipped by the operator', /skipped/i.test(report), report.slice(0, 400));
      return reply.done();
    },
  );
  const r = await h.call<{ started: boolean }>('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' });
  t.check('the run started', r.started, true);

  type Approval = { id: string; sessionId: string; stepId: number; description: string };
  const first = await waitFor('the first step to wait for approval', async () => (await h.call<Approval[]>('GET', '/approvals'))[0]);
  t.check('it waits on step 1 of this session', [first.sessionId, first.stepId], [s!.id, 1]);
  t.truthy('and says what the step is', first.description.includes('hello.txt'), first.description);
  t.check('nothing ran before the answer', existsSync(join(h.repo, 'hello.txt')), false);
  await h.call('POST', `/approvals/${first.id}`, { action: 'run' });

  const second = await waitFor('the second step to wait', async () => (await h.call<Approval[]>('GET', '/approvals')).find((a) => a.stepId === 2));
  const bad = await h.raw('POST', `/approvals/${second.id}`, { action: 'explode' });
  t.check('an unknown answer is refused', bad.status, 400);
  await h.call('POST', `/approvals/${second.id}`, { action: 'skip' });
  await h.idle();

  const after = await h.session(s!.id);
  t.check('the task is done', after.tasks[0]!.status, 'done');
  t.check('the approved step ran and the skipped one did not', [h.git('show', 'cop/asked:hello.txt'), existsSync(join(h.repo, 'skipped.txt'))], ['hi', false]);
  t.check('nothing is left waiting', await h.call('GET', '/approvals'), []);
});

await scenario('a reply that is not in the format is sent back, not guessed at', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'format', [greeting]));
  h.chat.script(
    reply.prose(),
    (m) => {
      t.truthy('the chat is told what was wrong with its reply', /json/i.test(m.text), m.text.slice(0, 300));
      return reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8");
    },
    reply.done(),
  );
  const after = await h.run(s!.id);
  t.check('the task still finishes', after.tasks[0]!.status, 'done');
});

await scenario('"done" is not taken on trust: the checks run, and a failure goes back to the chat', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'checked', [greeting]));
  h.chat.script(
    reply.done(),
    (m) => {
      const text = m.text + Object.values(m.attached).join('\n');
      t.truthy('the chat is told which check failed', text.includes('greeting written'), m.text.slice(0, 400));
      return reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8");
    },
    reply.done(),
  );
  const after = await h.run(s!.id);
  t.check('the task is done once the check passes', after.tasks[0]!.status, 'done');
  t.check('the file is there', h.git('show', 'cop/checked:hello.txt'), 'hi');
});

await scenario('a check that never passes ends the task as failed', { limits: { maxCheckRounds: 2 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'never', [greeting]));
  h.chat.script(reply.done(), reply.done(), reply.done(), reply.done());
  const after = await h.run(s!.id);
  t.check('the task failed', after.tasks[0]!.status, 'failed');
  t.truthy('and the reason names the check', (after.tasks[0]!.reason ?? '').includes('greeting written'), after.tasks[0]!.reason);
});

await scenario('a step the gate refuses is reported to the chat and never runs', {}, async (h) => {
  mkdirSync(join(h.repo, 'src'), { recursive: true });
  writeFileSync(join(h.repo, 'src', 'keep.txt'), 'keep\n');
  h.git('add', '-A');
  h.git('commit', '-q', '-m', 'src');
  const [s] = await h.importPlan(plan(h, 'refused', [greeting]));
  h.chat.script(
    reply.steps('Remove-Item -Recurse -Force src'),
    (m) => {
      const report = Object.values(m.attached)[0] ?? '';
      t.truthy('the report says the step was refused', /refus/i.test(report), report.slice(0, 400));
      return reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8");
    },
    reply.done(),
  );
  const after = await h.run(s!.id);
  t.check('the folder is still there', readFileSync(join(h.repo, 'src', 'keep.txt'), 'utf8'), 'keep\n');
  t.check('the task went on and finished', after.tasks[0]!.status, 'done');
  const notRun = after.tasks[0]!.handoff?.notExecuted ?? [];
  t.truthy('the handoff lists the refused step as not run, with why', notRun.length === 1 && notRun[0]!.includes('Remove-Item'), notRun);
});

await scenario('an independent review opens its own conversation and passes the work', {}, async (h) => {
  const p = plan(h, 'reviewed', [greeting]) as { sessions: Array<Record<string, unknown>> };
  p.sessions[0]!.review = { enabled: true };
  const [s] = await h.importPlan(p);
  let taskChat = '';
  h.chat.script(
    (m) => {
      taskChat = m.chatId;
      return reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8");
    },
    reply.done(),
    (m) => {
      t.truthy('the review is in a conversation of its own', m.chat.review && m.chatId !== taskChat, m.chatId);
      return reply.steps('Get-Content hello.txt');
    },
    reply.pass(),
  );
  const after = await h.run(s!.id);
  t.check('the task is done', after.tasks[0]!.status, 'done');
  t.check('with the review\'s verdict on it', after.tasks[0]!.review?.verdict, 'pass');
  t.check('two conversations: the task\'s and the review\'s', h.chat.conversations.size, 2);
});

await scenario('a task the chat calls blocked is tried once more in a fresh conversation', { limits: { retryBlockedInFreshChat: 1 } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'blocked', [greeting]));
  const chats: string[] = [];
  h.chat.script(
    (m) => {
      chats.push(m.chatId);
      return reply.blocked();
    },
    (m) => {
      chats.push(m.chatId);
      return reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8");
    },
    reply.done(),
  );
  const after = await h.run(s!.id);
  t.check('the second conversation finished it', after.tasks[0]!.status, 'done');
  t.truthy('the retry was in a different conversation', chats.length === 2 && chats[0] !== chats[1], chats);
  t.check('and the contract was sent again there', h.chat.sent.filter((m) => m.contract === 'task').length, 2);
});

await scenario('broken text is pointed out once before the commit, and the fix is committed', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'encoding', [{ ...greeting, checks: [] }]));
  h.chat.script(
    reply.steps(`Set-Content -Path config.json -Value '{"a":1}' -Encoding utf8BOM`),
    reply.done(),
    (m) => {
      const said = m.text + Object.values(m.attached).join('\n');
      t.truthy('the chat is told about the byte-order mark in config.json', /config\.json/.test(said) && /byte-order mark/.test(said), said.slice(0, 600));
      return reply.steps(`Set-Content -Path config.json -Value '{"a":1}' -Encoding utf8NoBOM`);
    },
    reply.done(),
  );
  const after = await h.run(s!.id);
  t.check('the task is done', after.tasks[0]!.status, 'done');
  const committed = h.git('show', 'cop/encoding:config.json');
  t.check('what was committed has no byte-order mark', committed.charCodeAt(0) === 0xfeff, false);
});

await scenario('a problem still there after one mention is committed and kept on the task', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'kept', [{ ...greeting, checks: [] }]));
  h.chat.script(reply.steps(`Set-Content -Path config.json -Value '{"a":1}' -Encoding utf8BOM`), reply.done(), reply.done());
  const after = await h.run(s!.id);
  t.check('the task is done', after.tasks[0]!.status, 'done');
  const results = (after.tasks[0] as unknown as { checkResults?: Array<{ name: string; passed: boolean; detail: string }> }).checkResults ?? [];
  const content = results.find((r) => /text written is clean/.test(r.name));
  t.truthy('and the finding stays on it', content && /still there after being pointed out once/.test(content.detail), results);
});

/** Starts a supervised run and waits for its first step to ask; the check acts on the repository meanwhile. */
async function whileWaiting(h: Harness, sessionId: string, meanwhile: () => void): Promise<void> {
  await h.call('POST', `/sessions/${sessionId}/start`, { mode: 'confirm' });
  type Approval = { id: string };
  const first = await waitFor('the step to wait for approval', async () => (await h.call<Approval[]>('GET', '/approvals'))[0]);
  meanwhile();
  await h.call('POST', `/approvals/${first.id}`, { action: 'run' });
  await h.idle();
}

await scenario('nothing is committed onto a branch the repository was moved to during the task', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'moved', [{ ...greeting, checks: [] }]));
  h.chat.script(reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8"), reply.done());
  // The operator switches branch in another window while the step waits.
  await whileWaiting(h, s!.id, () => h.git('checkout', '-q', '-b', 'someone-else'));
  const task = (await h.session(s!.id)).tasks[0]!;
  t.truthy('the task says why nothing was committed', /not on the task's branch cop\/moved/.test(task.vcs?.problem ?? ''), task.vcs);
  t.check('neither branch got a commit', [h.git('rev-list', '--count', 'main..cop/moved'), h.git('rev-list', '--count', 'main..someone-else')], ['0', '0']);
  t.check('the work is still in the working tree', h.git('status', '--porcelain'), '?? hello.txt');
});

await scenario('a commit on the branch that the runner did not make is named on the task', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'foreign', [{ ...greeting, checks: [] }]));
  h.chat.script(reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8"), reply.done());
  await whileWaiting(h, s!.id, () => h.git('-c', 'user.email=someone@example.invalid', '-c', 'user.name=someone', 'commit', '-q', '--allow-empty', '-m', 'sneaked in'));
  const task = (await h.session(s!.id)).tasks[0]!;
  const foreign = task.vcs?.foreignCommits ?? [];
  t.truthy('the foreign commit is recorded', foreign.length === 1 && foreign[0]!.includes('someone@example.invalid sneaked in'), foreign);
  t.check('and the task\'s own commit went on top of it', h.git('rev-list', '--count', 'main..cop/foreign'), '2');
});

await scenario('a change outside the task\'s scope is put back and the chat is told', {}, async (h) => {
  const [s] = await h.importPlan(plan(h, 'scoped', [{ ...greeting, scope: ['hello.txt'] }]));
  h.chat.script(
    (m) => {
      t.truthy('the opening message states the scope', /## Scope/.test(m.text) && m.text.includes('hello.txt'), m.text.slice(0, 300));
      return reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8", "Set-Content -Path README.md -Value 'rewritten' -Encoding utf8");
    },
    (m) => {
      t.truthy('the next message says README.md was put back', /put back by the runner: README\.md/.test(m.text), m.text.slice(0, 600));
      return reply.done();
    },
  );
  const after = await h.run(s!.id);
  const task = after.tasks[0]!;
  t.check('the task is done', task.status, 'done');
  t.check('its work inside the scope is committed', h.git('show', 'cop/scoped:hello.txt'), 'hi');
  t.check('the file outside it is as it was', h.git('show', 'cop/scoped:README.md'), '# fixture');
  t.check('and the task records what was put back', (task as unknown as { scopeReverted?: string[] }).scopeReverted, ['README.md']);
});

await scenario('the API refuses callers without the token', {}, async (h) => {
  const res = await fetch(`http://127.0.0.1:${h.api.port}/api/sessions`);
  t.check('no token: 401', res.status, 401);
  const wrong = await h.raw('GET', '/sessions', undefined, { 'x-cop-token': 'not-the-token' });
  t.check('a wrong token: 401', wrong.status, 401);
});

t.finish();
