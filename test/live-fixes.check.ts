/**
 * Regression checks for what the live test with the real Copilot chat found on 2026-10-03/04
 * (docs/live-test-2026-10-03.md), with the real API and runner and the scripted chat. Each section
 * names the finding it holds.
 *
 *   npm run check:live-fixes
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, Tally, waitFor, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';
import { noteFor } from '../src/vcs/taskVcs.js';
import { buildChatName, chatCode, chatNameForms } from '../src/transport/chatSession.js';
import { parseReply } from '../src/protocol/parser.js';
import { readOnlyNote } from '../src/session/compose.js';

const t = new Tally();

type Task = { id: string; status: string; reason?: string; stopCode?: string; attempt?: number; autoRetries?: number; runId?: string; attempts?: unknown[] };
type View = { id: string; tasks: Task[] };

const session = (h: Harness, plan: unknown) => h.importPlan(plan);
const vcs = (h: Harness, extra: Record<string, unknown> = {}) => ({ enabled: true, repoDir: h.repo, branchMode: 'per-session', updateFromRemote: false, ...extra });
const PROMPT = 'Write src/limit.js exporting LIMIT = 10, and a test for it named "limit is 10" using node:test.';
const testChecks = [
  { name: 'the test passes', expect: 'output-contains', run: 'node --test', value: 'fail 0' },
  { name: 'the limit test runs', expect: 'output-contains', run: 'node --test', value: 'limit is 10' },
];

console.log('--- C4: a task that contradicts itself is refused before the browser opens, and stays queued ---');
{
  const h = await startHarness({});
  try {
    mkdirSync(join(h.repo, 'src'), { recursive: true });
    const [s] = await session(h, {
      version: 1,
      sessions: [{
        name: 'contradiction', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'limit', prompt: PROMPT, scope: ['src/**'],
          checks: [...testChecks, { name: 'the notes name the limit', expect: 'file-contains', file: 'docs/notes.md', value: 'limit 10' }] }],
      }],
    });
    const branchesBefore = h.git('branch', '--list', 'cop/*');
    const r = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
    t.check('refused', r.started, false);
    t.truthy('saying the task contradicts itself and stays queued', /contradicts itself, so it was not started and stays queued/.test(r.reason ?? ''), r.reason);
    t.check('before the browser opened', [h.chat.opened, h.chat.sent.length], [0, 0]);
    const v = await h.session(s!.id) as unknown as View;
    t.check('no attempt, no branch', [v.tasks[0]!.status, v.tasks[0]!.runId ?? null, h.git('branch', '--list', 'cop/*')], ['queued', null, branchesBefore]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C3 (and 2026-10-04): a check expecting another branch is refused before the start, when the branch is known ---');
{
  const h = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 2 } } });
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{
        name: 'branch-check', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'limit', prompt: PROMPT,
          checks: [...testChecks, { name: 'on the release branch', expect: 'output-contains', run: 'git branch --show-current', value: 'release/1.0' }] }],
      }],
    });
    const r = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
    t.check('refused before the browser opened', [r.started, h.chat.opened], [false, 0]);
    t.truthy('naming the branch the task will be on', /expects another branch, but version control put this task on cop\//.test(r.reason ?? ''), r.reason);
    const v = await h.session(s!.id) as unknown as View;
    t.check('no attempt, no retry, no branch', [v.tasks[0]!.status, v.tasks[0]!.autoRetries ?? 0, h.git('branch', '--list', 'cop/*')], ['queued', 0, '']);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C5: "blocked" before any step ran is not accepted as two approaches ---');
{
  const h = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 2 } } });
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'early-block', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'notes', prompt: 'Write notes.txt in the project folder holding exactly the word hello.', checks: [{ name: 'notes say hello', expect: 'file-contains', file: 'notes.txt', value: 'hello' }] }] }],
    });
    h.chat.script(reply.blocked(), reply.steps("Set-Content -Path notes.txt -Value 'hello'"), reply.done());
    await h.run(s!.id, 'unattended');
    const v = await h.session(s!.id) as unknown as View;
    const events = await h.call<Array<{ type: string }>>('GET', `/sessions/${s!.id}/events`);
    t.check('the chat was told how the runner works, and the task went on', [events.some((e) => e.type === 'blocked-before-any-step'), v.tasks[0]!.status], [true, 'done']);
    t.check('without a fresh chat', v.tasks[0]!.autoRetries ?? 0, 0);
    t.truthy('the message says nothing has run yet', h.chat.sent.some((m) => /nothing has been run in this task/.test(m.text)), h.chat.sent.map((m) => m.text.slice(0, 80)));
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C6: reading a file back right after a step changed it is not a repeat ---');
{
  const h = await startHarness({});
  try {
    writeFileSync(join(h.repo, 'notes.txt'), 'first\r\n'); // CRLF, as Set-Content writes it: line endings are not what is tested here
    h.git('add', '-A');
    h.git('commit', '-q', '-m', 'notes');
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'read-back', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'notes', prompt: 'Change notes.txt in the project folder so it holds exactly the word second.', checks: [{ name: 'notes say second', expect: 'file-contains', file: 'notes.txt', value: 'second' }] }] }],
    });
    const read = 'Get-Content -Path notes.txt';
    h.chat.script(reply.steps(read), reply.steps(read), reply.steps(read), reply.steps("Set-Content -Path notes.txt -Value 'second'", read), reply.done());
    await h.run(s!.id, 'unattended');
    const v = await h.session(s!.id) as unknown as View;
    const events = await h.call<Array<{ type: string; message: string }>>('GET', `/sessions/${s!.id}/events`);
    t.check('the read-back after the write ran', events.filter((e) => e.type === 'step-repeated').length, 0);
    t.check('and the task is done', v.tasks[0]!.status, 'done');
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C6: the same read with nothing changed is still refused after the limit ---');
{
  const h = await startHarness({});
  try {
    writeFileSync(join(h.repo, 'notes.txt'), 'first\r\n'); // CRLF, as Set-Content writes it: line endings are not what is tested here
    h.git('add', '-A');
    h.git('commit', '-q', '-m', 'notes');
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'repeat', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'notes', prompt: 'Change notes.txt in the project folder so it holds exactly the word second.', checks: [{ name: 'notes say second', expect: 'file-contains', file: 'notes.txt', value: 'second' }] }] }],
    });
    const read = 'Get-Content -Path notes.txt';
    h.chat.script(reply.steps(read), reply.steps(read), reply.steps(read), reply.steps(read), reply.steps("Set-Content -Path notes.txt -Value 'second'"), reply.done());
    await h.run(s!.id, 'unattended');
    const events = await h.call<Array<{ type: string; message: string }>>('GET', `/sessions/${s!.id}/events`);
    t.check('the fourth identical read is refused', events.filter((e) => e.type === 'step-repeated').length, 1);
    t.truthy('and the chat is not told "in a row"', !h.chat.sent.some((m) => /already run \d+ time\(s\) in a row/.test(m.text + Object.values(m.attached ?? {}).join(' '))));
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C10: a new problem in another file is pointed out, not waved through as "pointed out once" ---');
{
  const h = await startHarness({});
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'once-per-finding', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'config', prompt: 'Write a.json and b.json in the project folder, each holding an empty JSON object.', checks: [{ name: 'a.json is there with an object', expect: 'file-contains', file: 'a.json', value: '{}' }] }] }],
    });
    h.chat.script(
      reply.steps("Set-Content -Encoding utf8BOM -Path a.json -Value '{}'"), reply.done(),
      // Told about a.json: fixes it, and writes b.json with the same problem.
      reply.steps("Set-Content -Encoding utf8NoBOM -Path a.json -Value '{}'", "Set-Content -Encoding utf8BOM -Path b.json -Value '{}'"), reply.done(),
      reply.steps("Set-Content -Encoding utf8NoBOM -Path b.json -Value '{}'"), reply.done(),
    );
    await h.run(s!.id, 'unattended');
    const v = await h.session(s!.id) as unknown as View & { tasks: Array<Task & { checkResults?: Array<{ name: string; passed: boolean; detail: string }> }> };
    const told = h.chat.sent.map((m) => m.text + Object.values(m.attached).join(' '));
    t.truthy('b.json was named to the chat in a failed round', told.some((x) => /b\.json: starts with a UTF-8 byte-order mark/.test(x)), told.map((x) => x.slice(0, 120)));
    t.check('and the task ended done with both files clean', [v.tasks[0]!.status, (v.tasks[0]!.checkResults ?? []).every((c) => c.passed && !/pointed out once/.test(c.detail))], ['done', true]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C11: helper scripts in .cop-tmp are never committed; a scratch copy elsewhere is pointed out ---');
{
  const h = await startHarness({});
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'scratch', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'greeting', prompt: 'Write greeting.txt in the project folder holding exactly the word hello.', checks: [{ name: 'greeting says hello', expect: 'file-contains', file: 'greeting.txt', value: 'hello' }] }] }],
    });
    h.chat.script(
      reply.steps(
        "New-Item -ItemType Directory -Force .cop-tmp | Out-Null; Set-Content -Path .cop-tmp/write.ps1 -Value \"Set-Content -Path greeting.txt -Value 'hello'\"",
        'pwsh -NoProfile -File .cop-tmp/write.ps1',
        'Copy-Item greeting.txt tmp-greeting.txt',
      ),
      reply.done(),
      reply.steps('Remove-Item tmp-greeting.txt'),
      reply.done(),
    );
    await h.run(s!.id, 'unattended');
    const v = await h.session(s!.id) as unknown as { tasks: Array<Task & { vcs?: { commit?: string; files?: Array<{ path: string }> } }> };
    const told = h.chat.sent.map((m) => m.text + Object.values(m.attached).join(' '));
    t.truthy('the scratch copy was pointed out', told.some((x) => /tmp-greeting\.txt/.test(x) && /temporary copy/.test(x)), told.map((x) => x.slice(0, 120)));
    t.check('the commit holds the work only', [v.tasks[0]!.status, (v.tasks[0]!.vcs?.files ?? []).map((f) => f.path)], ['done', ['greeting.txt']]);
    t.check('.cop-tmp is excluded from git', h.git('check-ignore', '.cop-tmp/write.ps1'), '.cop-tmp/write.ps1');
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C14/C15: what a check writes outside the scope is put back, not blamed on the chat, and not committed ---');
{
  const h = await startHarness({});
  try {
    mkdirSync(join(h.repo, 'scripts'), { recursive: true });
    mkdirSync(join(h.repo, 'src'), { recursive: true });
    writeFileSync(join(h.repo, 'scripts', 'stamp.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('docs', { recursive: true });\nwriteFileSync('docs/stamp.json', JSON.stringify({ at: new Date().toISOString() }) + '\\n');\nconsole.log('stamped');\n");
    h.git('add', '-A');
    h.git('commit', '-q', '-m', 'stamp script');
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'scoped', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'write a.js', prompt: 'Write src/a.js in the project folder holding exactly the line A=1.', scope: ['src/**'],
          checks: [
            { name: 'the docs stamp runs', expect: 'output-contains', run: 'node scripts/stamp.mjs', value: 'stamped' },
            { name: 'a.js says A=1', expect: 'file-contains', file: 'src/a.js', value: 'A=1' },
          ] }] }],
    });
    h.chat.script(
      reply.steps("Set-Content -Path src/a.js -Value 'A=0'"), reply.done(),
      reply.steps("Set-Content -Path src/a.js -Value 'A=1'"), reply.done(),
    );
    await h.run(s!.id, 'unattended');
    const v = await h.session(s!.id) as unknown as { tasks: Array<Task & { vcs?: { files?: Array<{ path: string }> } }> };
    const told = h.chat.sent.map((m) => m.text + Object.values(m.attached).join(' '));
    t.check('done, committing only the scoped file', [v.tasks[0]!.status, (v.tasks[0]!.vcs?.files ?? []).map((f) => f.path)], ['done', ['src/a.js']]);
    t.truthy('the chat was never told docs/stamp.json broke its scope', !told.some((x) => /stamp\.json/.test(x) && /scope/i.test(x)), told.filter((x) => /stamp\.json/.test(x)).map((x) => x.slice(0, 200)));
    const events = await h.call<Array<{ type: string; message: string }>>('GET', `/sessions/${s!.id}/events`);
    t.truthy('the put-back is said, as the checks\' doing', events.some((e) => e.type === 'scope-reverted' && /written by the checks/.test(e.message)), events.filter((e) => e.type === 'scope-reverted').map((e) => e.message));
    t.check('and the tree is clean', h.git('status', '--porcelain'), '');
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C13: a read-only task is judged on what it changed, not on what it found or what its checks wrote ---');
{
  const h = await startHarness({});
  try {
    mkdirSync(join(h.repo, 'scripts'), { recursive: true });
    writeFileSync(join(h.repo, 'scripts', 'report.mjs'), "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('reports', { recursive: true });\nwriteFileSync('reports/out.json', '{\"ok\":true}\\n');\nconsole.log('report written');\n");
    h.git('add', '-A');
    h.git('commit', '-q', '-m', 'report script');
    // Left by another session before this one starts, uncommitted.
    writeFileSync(join(h.repo, 'leftover.js'), 'module.exports = 1;\n');
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'audit', onFailure: 'stop', projectDir: h.repo, vcs: { enabled: false }, review: { enabled: false },
        tasks: [{ title: 'audit', prompt: 'Read README.md in the project folder and say in your summary what its first line says. Change nothing.', readOnly: true,
          checks: [{ name: 'the report runs', expect: 'output-contains', run: 'node scripts/report.mjs', value: 'report written' }] }] }],
    });
    h.chat.script(reply.steps('Get-Content -Path README.md'), reply.done('The first line of README.md is "# fixture"; I read it and changed nothing.'));
    await h.run(s!.id, 'unattended');
    const v = await h.session(s!.id) as unknown as View;
    t.check('done: neither the leftover file nor the check\'s report counts against it', [v.tasks[0]!.status, v.tasks[0]!.reason ?? null], ['done', null]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C16/C38: nothing promises a commit that will not happen, and a read-only task is not told to change files ---');
{
  const off = noteFor('C:\\repo', { branch: 'cop/t' }, { mode: 'per-task', earlier: [], commits: false });
  t.truthy('commits off: the note says nothing is committed', /commits nothing when the task finishes/.test(off) && !/will commit whatever you change/.test(off) && !/already a commit, and it can be returned to/.test(off), off);
  const ro = noteFor('C:\\repo', { branch: 'cop/t' }, { mode: 'per-task', earlier: [], readOnly: true });
  t.truthy('read-only: no "Change files as the task requires"', !/Change files as the task requires/.test(ro) && /This task is read-only/.test(ro), ro);
  t.truthy('the read-only note without commits says nothing is committed', /Nothing is committed in this session/.test(readOnlyNote(false)) && !/commits the change/.test(readOnlyNote(false)));
  t.truthy('with commits it still says the change is kept on the branch', /commits the change on the task's branch/.test(readOnlyNote(true)));
}

console.log('\n--- C22: "Run again" of a failed task in per-session mode starts from where it first started ---');
{
  type T = Task & { vcs?: { branch?: string; baseCommit?: string; commit?: string; files?: Array<{ path: string }> }; attempts?: Array<{ status: string; vcs?: { branch?: string; baseCommit?: string; commit?: string } }> };
  const h = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 } } });
  try {
    const start = h.git('rev-parse', 'HEAD');
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'per-session-rerun', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one.', checks: [{ name: 'a says one', expect: 'file-contains', file: 'a.txt', value: 'one' }] }] }],
    });
    // Attempt 1 writes the wrong thing and gives up after trying.
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'zero'"), reply.blocked());
    await h.run(s!.id, 'unattended');
    let v = await h.session(s!.id) as unknown as { tasks: T[] };
    const first = v.tasks[0]!;
    t.check('attempt 1 ended blocked, its work committed', [first.status, !!first.vcs?.commit], ['blocked', true]);
    await h.call('POST', `/sessions/${s!.id}/tasks/${first.id}/rerun`, {});
    h.chat.script(reply.steps('Test-Path a.txt'), reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done());
    await h.run(s!.id, 'unattended');
    v = await h.session(s!.id) as unknown as { tasks: T[] };
    const again = v.tasks[0]!;
    t.check('attempt 2 starts from where the task first started, not from the failed commit', [again.status, again.vcs?.baseCommit], ['done', start]);
    t.truthy('on a branch of its own, the failed attempt kept on the old one', again.vcs?.branch !== first.vcs?.branch && h.git('rev-parse', first.vcs!.branch!) === first.vcs!.commit, [again.vcs?.branch, first.vcs?.branch]);
    const ran = h.chat.sent.map((m) => Object.values(m.attached).join(' ')).find((x) => /Test-Path a\.txt/.test(x)) ?? '';
    t.truthy('the failed attempt\'s file is not in the tree it starts from', /False/.test(ran), ran.slice(0, 400));
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- 2026-10-05: a model chosen and not offered stops the run before anything is sent; never Auto instead ---');
{
  const h = await startHarness({ settings: { copilot: { defaultModel: 'GPT 9 Imaginary' } } });
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'model-record', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one.', checks: [{ name: 'a says one', expect: 'file-contains', file: 'a.txt', value: 'one' }] }] }],
    });
    const r = await h.call<{ started: boolean }>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
    t.check('the run starts (the model is known only in the chat)', r.started, true);
    // Since 2026-10-06 the operator is asked to choose it by hand first; "Stop" on that card ends it here.
    const ask = await waitFor('the card asking for the model', async () => (await h.call<Array<{ id: string; model?: unknown }>>('GET', '/approvals')).find((a) => !!a.model), 60_000);
    await h.call('POST', `/approvals/${ask.id}`, { action: 'abort' });
    await h.idle();
    const v = await h.session(s!.id) as unknown as { tasks: Array<{ status: string; runId?: string }> };
    t.check('nothing was sent, the task stays queued', [h.chat.sent.length, v.tasks[0]!.status, v.tasks[0]!.runId ?? null], [0, 'queued', null]);
    const events = await h.call<Array<{ type: string; message: string }>>('GET', `/sessions/${s!.id}/events`);
    t.truthy('and the run says why, naming the model and what the page offers',
      events.some((e) => e.type === 'run-failed' && /could not be put on the chosen model "GPT 9 Imaginary"/.test(e.message) && /Nothing was sent/.test(e.message) && /it offers/.test(e.message)),
      events.filter((e) => /model|run-failed/.test(e.type)));
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- 2026-10-05: the list read in Settings keeps where each model sits, and a run chooses it there ---');
{
  const h = await startHarness({});
  try {
    const o = (name: string, group?: string) => ({ name, raw: name, selected: name === 'Auto', disabled: false, role: 'menuitemradio', ...(group ? { group } : {}) });
    h.chat.models = [o('Auto'), o('Quick response'), o('Think deeper'), o('GPT-5.6 Sol Quick response', 'GPT'), o('GPT-5.6 Sol Think deeper', 'GPT')];
    await h.call('POST', '/models/refresh');
    const list = await h.call<{ options: Array<{ name: string; locator?: { index: number; group?: { testId?: string; name: string } } }> }>('GET', '/models');
    const gpt = list.options.find((x) => x.name === 'GPT-5.6 Sol Think deeper');
    t.check('the saved list has the model with its place: second in the GPT group', [gpt?.locator?.index, gpt?.locator?.group?.name, !!gpt?.locator?.group?.testId], [1, 'GPT', true]);
    await h.call('PUT', '/models/default', { model: 'GPT-5.6 Sol Think deeper' });
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'by-locator', onFailure: 'stop', vcs: vcs(h), review: { enabled: true, model: 'Think deeper' },
        tasks: [{ title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one.', checks: [{ name: 'a says one', expect: 'file-contains', file: 'a.txt', value: 'one' }] }] }],
    });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done());
    await h.run(s!.id, 'unattended');
    t.check('the run chose the work model and the review model at their saved places', h.chat.modelPicks, [{ name: 'GPT-5.6 Sol Think deeper', by: 'locator' }, { name: 'Think deeper', by: 'locator' }]);
    const v = await h.session(s!.id) as unknown as { modelInUse?: string; tasks: Array<{ id: string; status: string; runId: string }> };
    t.check('the task ran on it', [v.tasks[0]!.status, v.modelInUse], ['done', 'GPT-5.6 Sol Think deeper']);
    const line = readFileSync(join(h.runsDir, v.tasks[0]!.runId, 'transcript.jsonl'), 'utf8').split('\n').find((l) => l.includes('"model-in-use"')) ?? '';
    t.truthy('and its record says so', /"ok":true/.test(line) && /GPT-5\.6 Sol Think deeper/.test(line), line);

    // The page moved the model since the list was read: found again on a fresh reading, by name.
    h.chat.models = [o('Auto'), o('Think deeper'), o('Quick response'), o('GPT-5.6 Sol Think deeper', 'GPT'), o('GPT-5.6 Sol Quick response', 'GPT')];
    await h.call('POST', `/sessions/${s!.id}/tasks/${v.tasks[0]!.id}/rerun`, {});
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done());
    await h.run(s!.id, 'unattended');
    t.check('moved within its group: chosen at its new place', h.chat.modelPicks.slice(-2)[0], { name: 'GPT-5.6 Sol Think deeper', by: 'reread' });
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- 2026-10-04: a model the page offers under a new name is found there ---');
{
  const { pageModelFor } = await import('../src/transport/modelMatch.js');
  const o = (name: string, disabled = false) => ({ name, raw: name, selected: false, disabled, role: 'menuitemradio' });
  const live = [o('Auto'), o('Quick response'), o('Think deeper'), o('GPT 5.6 Sol Quick response'), o('GPT 5.6 Sol Think deeper')];
  t.check('the name as it is, when offered', pageModelFor('Think deeper', live)?.name, 'Think deeper');
  t.check('"GPT 5.6 Think deeper" is now "GPT 5.6 Sol Think deeper" (as seen live)', pageModelFor('GPT 5.6 Think deeper', live)?.name, 'GPT 5.6 Sol Think deeper');
  t.check('and the quick one likewise', pageModelFor('GPT 5.6 Quick response', live)?.name, 'GPT 5.6 Sol Quick response');
  t.check('a new version of the same name', pageModelFor('GPT 5.6 Think deeper', [o('GPT 5.7 Think deeper'), o('GPT 5.7 Quick response')])?.name, 'GPT 5.7 Think deeper');
  t.check('the newest of several versions', pageModelFor('GPT 5.6 Think deeper', [o('GPT 5.7 Think deeper'), o('GPT 5.8 Think deeper')])?.name, 'GPT 5.8 Think deeper');
  t.check('a family name never turns into a vendor\'s model', pageModelFor('Think deeper', [o('Auto'), o('GPT 5.6 Sol Think deeper')]), null);
  t.check('two that fit as well are not guessed between', pageModelFor('GPT Think deeper', [o('GPT A Think deeper'), o('GPT B Think deeper')]), null);
  t.check('a disabled row is not chosen', pageModelFor('GPT 5.6 Think deeper', [o('GPT 5.6 Sol Think deeper', true)]), null);
  t.check('nothing like it: nothing', pageModelFor('Claude Opus', live), null);

  // 2026-10-05: the page wrote "GPT-5.6 Sol Think deeper", the day after "GPT 5.6 Sol Think deeper".
  const { sameModel, buttonShows } = await import('../src/transport/modelMatch.js');
  const dashed = [o('Auto'), o('Think deeper'), o('GPT-5.6 Sol Quick response'), o('GPT-5.6 Sol Think deeper')];
  t.check('a dash or a space is the same model', [sameModel('GPT 5.6 Sol Think deeper', 'GPT-5.6 Sol Think deeper'), sameModel('gpt-5.6 sol  think deeper', 'GPT 5.6 Sol Think deeper')], [true, true]);
  t.check('the saved spelling finds the page\'s', pageModelFor('GPT 5.6 Sol Think deeper', dashed)?.name, 'GPT-5.6 Sol Think deeper');
  t.check('and an older name finds it through the dash too', pageModelFor('GPT 5.6 Think deeper', dashed)?.name, 'GPT-5.6 Sol Think deeper');
  t.check('the button\'s shortened name agrees (words dropped from the end)', [buttonShows('GPT-5.6 Sol Think', 'GPT-5.6 Sol Think deeper'), buttonShows('GPT 5.6 Quick', 'GPT 5.6 Quick response'), buttonShows('Think deeper', 'Think deeper')], [true, true, true]);
  t.check('a piece from elsewhere does not: "Think deeper" is not "GPT-5.6 Sol Think deeper"', [buttonShows('Think deeper', 'GPT-5.6 Sol Think deeper'), buttonShows('Quick response', 'GPT-5.6 Sol Quick response'), buttonShows('GPT-5.6 Sol Quick', 'GPT-5.6 Sol Think deeper'), buttonShows('Auto', 'GPT-5.6 Sol Think deeper')], [false, false, false, false]);
  t.check('nor half a word', buttonShows('GPT-5.6 Sol Thi', 'GPT-5.6 Sol Think deeper'), false);
}

console.log('\n--- 2026-10-04: a run follows the page when the Settings model was renamed, and Settings follows too ---');
{
  const h = await startHarness({ settings: { copilot: { defaultModel: 'GPT 5.6 Think deeper', defaultReviewModel: 'GPT 5.6 Quick response' } } });
  try {
    const o = (name: string) => ({ name, raw: name, selected: name === 'Auto', disabled: false, role: 'menuitemradio' });
    h.chat.models = [o('Auto'), o('Quick response'), o('Think deeper'), o('GPT 5.6 Sol Quick response'), o('GPT 5.6 Sol Think deeper')];
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'renamed-model', onFailure: 'stop', vcs: vcs(h), review: { enabled: true },
        tasks: [{ title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one.', checks: [{ name: 'a says one', expect: 'file-contains', file: 'a.txt', value: 'one' }] }] }],
    });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done());
    await h.run(s!.id, 'unattended');
    const v = await h.session(s!.id) as unknown as { modelInUse?: string; tasks: Array<{ status: string }> };
    t.check('the chat ran on the page\'s name for it', v.modelInUse, 'GPT 5.6 Sol Think deeper');
    t.truthy('both the session model and the review model were chosen under the page\'s names', h.chat.modelPicks.some((p) => p.name === 'GPT 5.6 Sol Think deeper') && h.chat.modelPicks.some((p) => p.name === 'GPT 5.6 Sol Quick response'), h.chat.modelPicks);
    const models = await h.call<{ defaultModel: string; defaultReviewModel: string; options: Array<{ name: string }>; readAt: string | null }>('GET', '/models');
    t.check('Settings now say what the page offers', [models.defaultModel, models.defaultReviewModel], ['GPT 5.6 Sol Think deeper', 'GPT 5.6 Sol Quick response']);
    t.truthy('and the saved list is the page\'s', models.options.some((m) => m.name === 'GPT 5.6 Sol Think deeper') && !models.options.some((m) => m.name === 'GPT 5.6 Think deeper') && !!models.readAt, models);
    const events = await h.call<Array<{ type: string; message: string }>>('GET', `/sessions/${s!.id}/events`);
    t.truthy('and the run says so', events.some((e) => e.type === 'model-renamed' && /"GPT 5\.6 Think deeper" is no longer offered under that name; the page offers it as "GPT 5\.6 Sol Think deeper"/.test(e.message)), events.filter((e) => /model/.test(e.type)));
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- 2026-10-05: the model chosen from the list is the one the chat runs on, however the page spells it today ---');
{
  const h = await startHarness({ settings: { copilot: { defaultModel: 'GPT 5.6 Sol Think deeper' } } });
  try {
    const o = (name: string) => ({ name, raw: name, selected: name === 'Auto', disabled: false, role: 'menuitemradio' });
    h.chat.models = [o('Auto'), o('Quick response'), o('Think deeper'), o('GPT-5.6 Sol Quick response'), o('GPT-5.6 Sol Think deeper')];
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'dashed-model', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one.', checks: [{ name: 'a says one', expect: 'file-contains', file: 'a.txt', value: 'one' }] }] }],
    });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done());
    await h.run(s!.id, 'unattended');
    const v = await h.session(s!.id) as unknown as { modelInUse?: string };
    t.check('the chat is on the chosen model, as the page names it', [v.modelInUse, h.chat.currentModel], ['GPT-5.6 Sol Think deeper', 'GPT-5.6 Sol Think deeper']);
    const events = await h.call<Array<{ type: string }>>('GET', `/sessions/${s!.id}/events`);
    t.check('found as it is, not as a rename, and not refused', [events.some((e) => e.type === 'model-renamed'), events.some((e) => e.type === 'model-not-selected')], [false, false]);

    // Reading the list from Settings follows a rename too, without waiting for a run.
    await h.call('PUT', '/models/default', { model: 'GPT 5.6 Think deeper' });
    await h.call('PUT', '/models/review-default', { model: 'GPT 5.6 Quick response' });
    await h.call('POST', '/models/refresh');
    const after = await h.call<{ defaultModel: string; defaultReviewModel: string }>('GET', '/models');
    t.check('"Refresh" makes Settings say what the page offers', [after.defaultModel, after.defaultReviewModel], ['GPT-5.6 Sol Think deeper', 'GPT-5.6 Sol Quick response']);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- 2026-10-05: a conversation not yet in the sidebar when registered is named before the next message ---');
{
  const h = await startHarness({});
  try {
    h.chat.sidebarLate = 1;
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'late-sidebar', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one.', checks: [{ name: 'a says one', expect: 'file-contains', file: 'a.txt', value: 'one' }] }] }],
    });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done());
    await h.run(s!.id, 'unattended');
    const v = await h.session(s!.id) as unknown as { chat?: { chatId: string; name: string; named?: boolean }; tasks: Array<{ status: string }> };
    const conv = v.chat ? h.chat.conversations.get(v.chat.chatId) : undefined;
    t.check('the task is done, and the chat is named after all', [v.tasks[0]!.status, conv?.name === v.chat?.name, v.chat?.named ?? null], ['done', true, null]);
    t.check('a second try, not more', h.chat.nameTries, 2);
    const events = await h.call<Array<{ type: string }>>('GET', `/sessions/${s!.id}/events`);
    t.truthy('and the late naming is on record', events.some((e) => e.type === 'chat-named-later'), events.map((e) => e.type).filter((x) => /chat/.test(x)));
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

/*
 * 2026-10-17: "the bot tries to save a chat name longer than 50 characters, and it breaks its logic". Copilot's
 * dialog takes a shorter form of the name (see `chatNameForms`); that form is the chat's name on record, the one a
 * later run finds it by — at the first naming and when it is named later, once the sidebar has the row.
 */
console.log('\n--- 2026-10-17: a chat name Copilot takes only shortened is the name on record ---');
for (const late of [0, 1]) {
  const h = await startHarness({});
  try {
    const takes = (asked: string): string => chatNameForms(asked).find((f) => Buffer.byteLength(f, 'utf8') <= 50) ?? asked;
    h.chat.renameTakes = takes;
    h.chat.sidebarLate = late;
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'Създай калкулатор с тестове и документация', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [
          { title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one.', checks: [] },
          { title: 'write b', prompt: 'Write b.txt in the project folder holding exactly the word two.', checks: [] },
        ] }],
    });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done(), reply.steps("Set-Content -Path b.txt -Value 'two'"), reply.done());
    await h.run(s!.id, 'unattended');
    const v = await h.session(s!.id) as unknown as { chat?: { chatId: string; name: string; named?: boolean }; tasks: Array<{ status: string; runId?: string }> };
    const conv = v.chat ? h.chat.conversations.get(v.chat.chatId) : undefined;
    const asked = buildChatName(chatCode(s!.id), 'Създай калкулатор с тестове и документация');
    const when = late ? 'named later' : 'named at once';
    // In Latin letters from the start (2026-10-19): a dialog that counts bytes takes it at the first try.
    t.truthy(`${when}: the name asked for is in Latin letters, transliterated, 50 at most`, /^[\x20-\x7e]+$/.test(asked) && /^op\/[a-z0-9]+\/Sazday-kalkulator-s-testove-i-dok/.test(asked) && asked.length <= 50, asked);
    t.check(`${when}: taken as asked, one try (one more while the sidebar had no row)`, [takes(asked) === asked, h.chat.nameTries], [true, 1 + late]);
    t.check(`${when}: the name on record is the one Copilot took, and the chat has it`, [v.chat?.name, conv?.name, v.chat?.named ?? null], [takes(asked), takes(asked), null]);
    const pointer = JSON.parse(readFileSync(join(h.runsDir, v.tasks[0]!.runId!, 'chat.json'), 'utf8')) as { name: string };
    t.check(`${when}: and so is the task's record of its conversation`, pointer.name, takes(asked));
    t.check(`${when}: both tasks ran in that one conversation`, [v.tasks.map((x) => x.status), [...new Set(h.chat.sent.map((m) => m.chatId))]], [['done', 'done'], [v.chat?.chatId]]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C31: the stop word is not kept in the summary, so it never reaches a commit ---');
{
  const fence = (o: unknown): string => '```json\n' + JSON.stringify(o) + '\n```\nКрай';
  const r = parseReply(fence({ status: 'done', summary: 'The calculator is written and its 6 tests pass. Край' }), { stopMarker: 'Край', defaultShell: 'pwsh' });
  t.check('the summary without it', r.ok ? r.reply.summary : null, 'The calculator is written and its 6 tests pass.');
  t.check('and the reply still ends the task', r.ok ? r.done : null, true);
  const word = parseReply(fence({ status: 'done', summary: 'Крайният резултат е готов: калкулаторът е написан, а шестте му теста минават при node --test.' }), { stopMarker: 'Край', defaultShell: 'pwsh' });
  t.check('a word that only starts with it is left alone', word.ok ? word.reply.summary : null, 'Крайният резултат е готов: калкулаторът е написан, а шестте му теста минават при node --test.');
}

console.log('\n--- 2026-10-04: taking the stop word out never touches commands and paths in the text ---');
{
  const opts = { stopMarker: 'Край', defaultShell: 'pwsh' as const };
  const fence = (o: unknown): string => '```json\n' + JSON.stringify(o) + '\n```\nКрай';
  const plain = String.raw`I ran Get-Content .\src\pad.js and wrote the draft in .cop-tmp , then checked it .`;
  const p = parseReply(fence({ status: 'done', summary: plain, notes: String.raw`See Get-Content .\notes.md` }), opts);
  t.check('a summary without the stop word comes back untouched', p.ok ? p.reply.summary : null, plain);
  t.check('and so do the notes', p.ok ? p.reply.notes : null, String.raw`See Get-Content .\notes.md`);
  const mixed = parseReply(fence({ status: 'done', summary: String.raw`Read it with Get-Content .\src\pad.js and kept the draft in .cop-tmp. Край.` }), opts);
  t.check('with the stop word: only where it stood is tidied', mixed.ok ? mixed.reply.summary : null, String.raw`Read it with Get-Content .\src\pad.js and kept the draft in .cop-tmp.`);
  const inside = parseReply(fence({ status: 'done', summary: 'Tests pass (Край) and the file is saved Край .' }), opts);
  t.check('in brackets or before a full stop', inside.ok ? inside.reply.summary : null, 'Tests pass and the file is saved.');
}

console.log('\n--- C31: and the commit message has no stop word ---');
{
  const h = await startHarness({});
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'marker', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'greeting', prompt: 'Write greeting.txt in the project folder holding exactly the word hello.', checks: [{ name: 'greeting says hello', expect: 'file-contains', file: 'greeting.txt', value: 'hello' }] }] }],
    });
    h.chat.script(reply.steps("Set-Content -Path greeting.txt -Value 'hello'"), reply.done('greeting.txt holds hello; I read it back to check. Край'));
    await h.run(s!.id, 'unattended');
    const v = await h.session(s!.id) as unknown as { tasks: Array<Task & { vcs?: { commit?: string } }> };
    const message = h.git('log', '-1', '--format=%B', v.tasks[0]!.vcs!.commit!);
    t.truthy('no "Край" in the commit message', !/Край/.test(message) && /greeting\.txt holds hello/.test(message), message);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C26: "Continue" after a Stop tells the chat which steps ran and what they printed ---');
{
  const h = await startHarness({});
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'stop-continue', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'write c', prompt: 'Write c.txt in the project folder holding exactly the word done.', checks: [{ name: 'c says done', expect: 'file-contains', file: 'c.txt', value: 'done' }] }] }],
    });
    h.chat.script(reply.steps("Write-Output 'inspection-finished-marker'", 'Start-Sleep -Seconds 20'));
    const started = await h.call<{ started: boolean }>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
    t.check('started', started.started, true);
    await waitFor('the second step to run', async () => (await h.call<Array<{ message: string }>>('GET', `/sessions/${s!.id}/events`)).some((e) => /running step 2/.test(e.message)), 60_000);
    await h.call('POST', `/sessions/${s!.id}/stop`);
    await h.idle();
    const stopped = (await h.session(s!.id)) as unknown as View;
    t.check('stopped', stopped.tasks[0]!.status, 'aborted');
    await h.call('POST', `/sessions/${s!.id}/tasks/${stopped.tasks[0]!.id}/continue`);
    let told = '';
    let nudge = '';
    // The chat that answers "blocked" there is given the assignment again (live run 2026-10-04).
    h.chat.script((m) => { told = m.text; return reply.blocked(); }, (m) => { nudge = m.text; return reply.steps("Set-Content -Path c.txt -Value 'done'"); }, reply.done());
    await h.run(s!.id, 'unattended');
    t.truthy('a "blocked" at once is answered with the assignment, not "nothing has been run"', /this task is being continued/.test(nudge) && /Write c\.txt in the project folder/.test(nudge) && !/nothing has been run in this task/.test(nudge), nudge.slice(0, 600));
    t.truthy('the continuation names step 1 as run, with its output', /step 1 ran to the end/.test(told) && /inspection-finished-marker/.test(told), told.slice(0, 900));
    t.truthy('and step 2 as cut off by the stop', /step 2 was running when it was stopped/.test(told), told.slice(0, 900));
    t.check('and the task finishes', ((await h.session(s!.id)) as unknown as View).tasks[0]!.status, 'done');
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C25: a branch carried on is not described as made for the task from the session base ---');
{
  const h = await startHarness({});
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'carry-on', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [
          { title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one.', checks: [{ name: 'a says one', expect: 'file-contains', file: 'a.txt', value: 'one' }] },
          { title: 'write b', prompt: 'Write b.txt in the project folder holding exactly the word two.', checks: [{ name: 'b says two', expect: 'file-contains', file: 'b.txt', value: 'two' }] },
        ] }],
    });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done(), reply.steps("Set-Content -Path b.txt -Value 'two'"), reply.done());
    await h.run(s!.id, 'unattended');
    const events = await h.call<Array<{ type: string; message: string }>>('GET', `/sessions/${s!.id}/events`);
    const branches = events.filter((e) => e.type === 'vcs-branch').map((e) => e.message);
    t.truthy('the first task\'s branch is made, the second carries it on', branches.length === 2 && /made from/.test(branches[0]!) && /carrying on the existing branch/.test(branches[1]!), branches);
    const second = h.chat.sent.map((m) => m.text).filter((x) => /Task 2/.test(x) || /write b/.test(x)).join('\n');
    t.truthy('and the second task is told it is on the existing branch', /on the existing branch/.test(second) && !/created for this task from/.test(second), second.slice(0, 600));
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C61: the steps after a refused step of the same reply are not run ---');
{
  const h = await startHarness({});
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'after-refusal', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'write after', prompt: 'Write after.txt in the project folder holding exactly the word hello.', checks: [{ name: 'after says hello', expect: 'file-contains', file: 'after.txt', value: 'hello' }] }] }],
    });
    let report = '';
    let told = '';
    h.chat.script(
      reply.steps(String.raw`Get-Content C:\Windows\win.ini`, "Set-Content -Path after.txt -Value 'too early'"),
      (m) => { report = Object.values(m.attached).join('\n'); told = m.text; return reply.steps("Set-Content -Path after.txt -Value 'hello'"); },
      reply.done(),
    );
    await h.run(s!.id, 'unattended');
    t.truthy('the second step was not run, and the chat is told why', /not run, because step 1 of this reply was refused/.test(report), report.slice(0, 1500));
    // 2026-10-04: headed and announced as "REFUSED by the runner" like the step that was.
    t.truthy('headed as not run because of step 1, not as refused', /--- step 2 \(pwsh, NOT RUN because step 1 was refused/.test(report) && /--- step 1 \(pwsh, REFUSED by the runner/.test(report), report.slice(0, 1500));
    t.truthy('and the message says so too', /step 2 was not run, because step 1 was refused/.test(told) && !/step 2 was refused by the runner/.test(told), told.slice(0, 1200));
    const events = await h.call<Array<{ type: string; data?: { after?: number } }>>('GET', `/sessions/${s!.id}/events`);
    t.truthy('and it is on record', events.some((e) => e.type === 'step-skipped' && e.data?.after === 1));
    t.check('the task still finishes', ((await h.session(s!.id)) as unknown as View).tasks[0]!.status, 'done');
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C64: a retry in a fresh chat names its conversation with the attempt ---');
{
  const h = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 1 } } });
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'retry-name', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'write z', prompt: 'Write z.txt in the project folder holding exactly the word done.', checks: [{ name: 'z says done', expect: 'file-contains', file: 'z.txt', value: 'done' }] }] }],
    });
    h.chat.script(...reply.triedThenBlocked(), reply.steps("Set-Content -Path z.txt -Value 'done'"), reply.done());
    await h.run(s!.id, 'unattended');
    const names = [...h.chat.conversations.values()].map((c) => c.name).filter(Boolean);
    t.truthy('two conversations with different names, the retry\'s carrying /a2', names.length === 2 && names[0] !== names[1] && names.some((n) => /\/a2\//.test(n!)), names);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C63: a retry after an attempt that committed nothing takes its branch again, no empty one left ---');
{
  const h = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 1 } } });
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'empty-branch', onFailure: 'stop', vcs: vcs(h, { branchMode: 'per-task' }), review: { enabled: false },
        tasks: [{ title: 'write w', prompt: 'Write w.txt in the project folder holding exactly the word done.', checks: [{ name: 'w says done', expect: 'file-contains', file: 'w.txt', value: 'done' }] }] }],
    });
    h.chat.script(...reply.triedThenBlocked(), reply.steps("Set-Content -Path w.txt -Value 'done'"), reply.done());
    await h.run(s!.id, 'unattended');
    const v = (await h.session(s!.id)) as unknown as { tasks: Array<Task & { vcs?: { branch?: string } }> };
    const branches = h.git('branch', '--list', 'cop/*', '--format=%(refname:short)').split('\n').filter(Boolean);
    t.check('done, on one branch, with no empty one beside it', [v.tasks[0]!.status, branches.length, branches[0] === v.tasks[0]!.vcs?.branch], ['done', 1, true]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

void writeFileSync;
void reply;
t.finish();
