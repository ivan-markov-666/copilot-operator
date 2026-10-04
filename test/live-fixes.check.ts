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

console.log('\n--- C3: a contradiction decided at the start is not retried in fresh chats ---');
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
    t.check('started (the branch is only known at the start)', r.started, true);
    await h.idle();
    const v = await h.session(s!.id) as unknown as View;
    const task = v.tasks[0]!;
    t.check('blocked on the contract', [task.status, task.stopCode], ['blocked', 'contract-conflict']);
    t.check('and not retried in a fresh chat', [task.autoRetries ?? 0, (task.attempts ?? []).length], [0, 0]);
    t.check('no empty -a2/-a3 branches', h.git('branch', '--list', 'cop/*a[0-9]*'), '');
    t.check('nothing was sent to the chat', h.chat.sent.length, 0);
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

console.log('\n--- C8: input files next to other changes are no dead end on the run screen ---');
{
  type Group = { ready: boolean; repoDir: string; actions: Array<{ id: string; available: boolean }>; entries: Array<{ path: string; choice?: string; allowed: string[] }> };
  const h = await startHarness({});
  try {
    mkdirSync(join(h.repo, 'specs'), { recursive: true });
    writeFileSync(join(h.repo, 'specs', 'rates.json'), '{"eur": 1.95583}\n');
    writeFileSync(join(h.repo, 'README.md'), '# fixture, changed by the operator\n');
    writeFileSync(join(h.repo, 'scratch.txt'), 'scratch\n');
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'inputs-and-more', onFailure: 'stop', vcs: vcs(h, { startFrom: 'branch', baseBranch: 'main', userInputs: { paths: ['specs/**'] } }), review: { enabled: false },
        tasks: [{ title: 'rates', prompt: 'Write src/rates.js that exports the EUR rate read from specs/rates.json, with a node:test test named "eur rate".', checks: testChecks }] }],
    });
    const groups = () => h.call<Group[]>('GET', `/batch/vcs?ids=${s!.id}`);
    const press = (action: string, choices: Record<string, string> = {}) =>
      h.call<{ ok: boolean; problem?: string }>('POST', '/batch/vcs/prepare', { sessionIds: [s!.id], repoDir: h.repo, action, choices });
    let g = (await groups())[0]!;
    t.check('not ready, and "take them as a starting snapshot" is offered', [g.ready, g.actions.some((a) => a.id === 'allow-snapshot' && a.available)], [false, true]);
    t.check('pressed', (await press('allow-snapshot')).ok, true);
    g = (await groups())[0]!;
    const here = g.actions.find((a) => a.id === 'snapshot-here');
    t.check('then the snapshot here is offered, with every file listed', [here?.available, g.entries.map((e) => e.path).sort()], [true, ['README.md', 'scratch.txt', 'specs/rates.json']]);
    const choices = Object.fromEntries(g.entries.map((e) => [e.path, e.path === 'scratch.txt' ? 'leave-out' : (e.choice ?? 'include')]));
    const took = await press('snapshot-here', choices);
    t.check('taken, with scratch.txt left out', [took.ok, took.problem ?? null], [true, null]);
    t.check('the panel is ready', (await groups())[0]!.ready, true);
    const snap = (await h.session(s!.id) as unknown as { vcsBaseCommit: string }).vcsBaseCommit;
    t.check('the snapshot holds the input and the operator\'s change, not the scratch file', h.git('diff', '--name-only', 'main', snap).split('\n').sort(), ['README.md', 'specs/rates.json']);
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

console.log('\n--- C13: a read-only task that does change a file still fails, and is not promised a commit when nothing commits ---');
{
  const h = await startHarness({});
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'audit-writes', onFailure: 'stop', projectDir: h.repo, vcs: { enabled: false }, review: { enabled: false },
        tasks: [{ title: 'audit', prompt: 'Read README.md in the project folder and say in your summary what its first line says. Change nothing.', readOnly: true,
          checks: [{ name: 'readme still there', expect: 'file-contains', file: 'README.md', value: 'fixture' }] }] }],
    });
    h.chat.script(reply.steps("Set-Content -Path notes.md -Value 'audit notes'"), reply.done('The first line of README.md is "# fixture".'));
    await h.run(s!.id, 'unattended');
    const v = await h.session(s!.id) as unknown as View;
    t.check('failed, naming the file', [v.tasks[0]!.status, /notes\.md/.test(v.tasks[0]!.reason ?? '')], ['failed', true]);
    t.truthy('and saying nothing is committed', /Nothing is committed/.test(v.tasks[0]!.reason ?? '') && !/committed on the task's branch/.test(v.tasks[0]!.reason ?? ''), v.tasks[0]!.reason);
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

console.log('\n--- C20: a starting snapshot on the base branch brings the branch up to its remote first ---');
{
  type Group = { ready: boolean; inputs: Array<{ path: string }>; actions: Array<{ id: string; available: boolean }> };
  const h = await startHarness({});
  try {
    const remote = join(h.base, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    h.git('remote', 'add', 'origin', remote);
    h.git('push', '-q', '-u', 'origin', 'main');
    // A teammate moves main on.
    const other = join(h.base, 'other');
    execFileSync('git', ['clone', '-q', remote, other]);
    const og = (...a: string[]): string => execFileSync('git', ['-C', other, ...a], { encoding: 'utf8' }).trim();
    og('config', 'user.email', 'o@example.invalid');
    og('config', 'user.name', 'o');
    writeFileSync(join(other, 'team.txt'), 'team\n');
    og('add', '-A');
    og('commit', '-q', '-m', 'team work');
    og('push', '-q', 'origin', 'main');
    const remoteMain = og('rev-parse', 'HEAD');
    mkdirSync(join(h.repo, 'specs'), { recursive: true });
    writeFileSync(join(h.repo, 'specs', 'rates.json'), '{"eur": 1.95583}\n');
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'from-main', onFailure: 'stop', vcs: vcs(h, { startFrom: 'branch', baseBranch: 'main', updateFromRemote: true, userInputs: { paths: ['specs/**'] } }), review: { enabled: false },
        tasks: [{ title: 'rates', prompt: 'Write src/rates.js that exports the EUR rate read from specs/rates.json, with a node:test test named "eur rate".', checks: testChecks }] }],
    });
    const g = (await h.call<Group[]>('GET', `/batch/vcs?ids=${s!.id}`))[0]!;
    const took = await h.call<{ ok: boolean; result?: string; problem?: string }>('POST', '/batch/vcs/prepare', {
      sessionIds: [s!.id], repoDir: h.repo, action: 'snapshot-on-base', choices: Object.fromEntries(g.inputs.map((e) => [e.path, 'include'])),
    });
    t.check('taken', [took.ok, took.problem ?? null], [true, null]);
    t.truthy('saying main was brought up to date', /brought up to date with origin\/main/.test(took.result ?? ''), took.result);
    const v = await h.session(s!.id) as unknown as { vcsBaseCommit: string; vcsStart?: { update?: { outcome: string } } };
    t.check('the snapshot sits on the remote\'s main', h.git('rev-parse', `${v.vcsBaseCommit}^`), remoteMain);
    t.check('and the start records the update', v.vcsStart?.update?.outcome, 'updated');
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
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

console.log('\n--- C21: a Restore holds in per-session mode: the next run of that task starts from the restore branch ---');
{
  type T = Task & { vcs?: { branch?: string; baseCommit?: string; commit?: string } };
  const h = await startHarness({});
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'per-session-restore', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [
          { title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one.', checks: [{ name: 'a says one', expect: 'file-contains', file: 'a.txt', value: 'one' }] },
          { title: 'write b', prompt: 'Write b.txt in the project folder holding exactly the word two.', checks: [{ name: 'b says two', expect: 'file-contains', file: 'b.txt', value: 'two' }] },
        ] }],
    });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done(), reply.steps("Set-Content -Path b.txt -Value 'two'"), reply.done());
    await h.run(s!.id, 'unattended');
    let v = await h.session(s!.id) as unknown as { tasks: T[] };
    const a = v.tasks[0]!;
    const restored = await h.call<{ ok: boolean; branch?: string; commit?: string; problem?: string }>('POST', `/sessions/${s!.id}/tasks/${a.id}/restore`);
    t.check('restored', [restored.ok, restored.commit, restored.problem ?? null], [true, a.vcs?.baseCommit, null]);
    await h.call('POST', `/sessions/${s!.id}/tasks/${a.id}/rerun`, { prompt: 'Write a.txt in the project folder holding exactly the word uno.', checks: [{ name: 'a says uno', expect: 'file-contains', file: 'a.txt', value: 'uno' }] });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'uno'"), reply.done());
    await h.run(s!.id, 'unattended');
    v = await h.session(s!.id) as unknown as { tasks: T[] };
    const again = v.tasks[0]!;
    t.check('it ran on the restore branch, from before the task', [again.status, again.vcs?.branch, again.vcs?.baseCommit], ['done', restored.branch, a.vcs?.baseCommit]);
    t.check('without the later task\'s work under it', h.git('ls-tree', '--name-only', again.vcs!.commit!).split('\n').includes('b.txt'), false);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C24: a plan check the runner refuses for its command line stops the run before the browser opens ---');
{
  const h = await startHarness({});
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'net-check', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'docs page', prompt: 'Write docs/index.html in the project folder with a heading that says Hello.', checks: [
          { name: 'the page has the heading', expect: 'file-contains', file: 'docs/index.html', value: 'Hello' },
          { name: 'the published page is reachable', expect: 'exit-zero', run: 'curl -fsS https://example.com/ -o page.html' },
        ] }] }],
    });
    const r = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
    t.check('refused before the browser opened', [r.started, h.chat.opened], [false, 0]);
    t.truthy('naming the check that can never run', /"the published page is reachable" is refused by the runner/.test(r.reason ?? ''), r.reason);
    const v = await h.session(s!.id) as unknown as View;
    t.check('the task stays queued, no attempt', [v.tasks[0]!.status, v.tasks[0]!.runId ?? null], ['queued', null]);
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

console.log('\n--- C27: a session the operator stops inside a batch is "stopped", not "failed", and the batch goes on ---');
{
  const h = await startHarness({});
  try {
    const mk = (name: string, file: string) => ({ name, onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
      tasks: [{ title: `write ${file}`, prompt: `Write ${file} in the project folder holding exactly the word done.`, checks: [{ name: `${file} says done`, expect: 'file-contains', file, value: 'done' }] }] });
    const [a, b] = await session(h, { version: 1, sessions: [mk('first', 'a.txt'), mk('second', 'b.txt')] });
    h.chat.script(
      reply.steps('Start-Sleep -Seconds 20'),
      reply.steps("Set-Content -Path b.txt -Value 'done'"), reply.done(),
    );
    const started = await h.call<{ started: boolean; reason?: string }>('POST', '/batch/start', { sessionIds: [a!.id, b!.id], mode: 'unattended', onFailure: 'stop' });
    t.check('the batch starts', started.started, true);
    await waitFor('the long step to run', async () => (await h.call<Array<{ type: string }>>('GET', `/sessions/${a!.id}/events`)).some((e) => e.type === 'step-started' || /running step/.test(JSON.stringify(e))), 60_000);
    await h.call('POST', `/sessions/${a!.id}/stop`);
    await h.idle();
    const batch = await h.call<{ sessions: Array<{ sessionId: string; state: string; reason?: string }> }>('GET', '/batch');
    const first = batch.sessions.find((x) => x.sessionId === a!.id);
    const second = batch.sessions.find((x) => x.sessionId === b!.id);
    t.check('the stopped session is "stopped"', [first?.state, /stopped by the operator/.test(first?.reason ?? '')], ['stopped', true]);
    t.check('and the next session still ran', second?.state, 'done');
    const events = await h.call<Array<{ type: string }>>('GET', `/sessions/${a!.id}/events`);
    t.check('no "batch stopped early"', events.some((e) => e.type === 'batch-stopped-early'), false);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C28: a chained session whose predecessor has not finished is refused before the chat, with no attempt ---');
{
  const h = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 } } });
  try {
    const mk = (name: string, file: string, startFrom: string) => ({ name, onFailure: 'stop', vcs: vcs(h, { startFrom, baseBranch: 'main' }), review: { enabled: false },
      tasks: [{ title: `write ${file}`, prompt: `Write ${file} in the project folder holding exactly the word done.`, checks: [{ name: `${file} says done`, expect: 'file-contains', file, value: 'done' }] }] });
    const [a, b] = await session(h, { version: 1, sessions: [mk('first', 'a.txt', 'branch'), mk('second', 'b.txt', 'previous-session')] });
    h.chat.script(reply.steps('Get-ChildItem'), reply.blocked());
    await h.run(a!.id, 'unattended');
    t.check('the first session ended blocked', ((await h.session(a!.id)) as unknown as View).tasks[0]!.status, 'blocked');
    const opened = h.chat.opened;
    const r = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${b!.id}/start`, { mode: 'unattended' });
    t.check('the second is refused, before a browser is opened', [r.started, h.chat.opened - opened], [false, 0]);
    t.truthy('saying the session before it has not finished', /has not finished/.test(r.reason ?? ''), r.reason);
    const v = (await h.session(b!.id)) as unknown as View;
    t.check('its task stays queued, no attempt', [v.tasks[0]!.status, v.tasks[0]!.runId ?? null, v.tasks[0]!.attempt ?? 1], ['queued', null, 1]);
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
    h.chat.script((m) => { told = m.text; return reply.steps("Set-Content -Path c.txt -Value 'done'"); }, reply.done());
    await h.run(s!.id, 'unattended');
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

console.log('\n--- C32-C41: the records keep what happened: refused runs, every attempt\'s run, operator actions, messages, problems ---');
{
  type Group = { ready: boolean; sessions: Array<{ started: boolean }>; actions: Array<{ id: string; available: boolean }>; entries: Array<{ path: string; choice?: string }> };
  const h = await startHarness({ settings: { limits: { retryBlockedInFreshChat: 0 } } });
  try {
    writeFileSync(join(h.repo, 'operator-notes.md'), 'notes\n');
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'records', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'write x', prompt: 'Write test/x.txt in the project folder holding exactly the word done.', checks: [{ name: 'x says done', expect: 'file-contains', file: 'test/x.txt', value: 'done' }] }] }],
    });
    const refused = await h.call<{ started: boolean }>('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' });
    t.check('the first start is refused (uncommitted file)', refused.started, false);
    const press = (action: string, choices: Record<string, string> = {}) => h.call<{ ok: boolean; problem?: string }>('POST', '/batch/vcs/prepare', { sessionIds: [s!.id], repoDir: h.repo, action, choices });
    t.check('allow a starting snapshot', (await press('allow-snapshot')).ok, true);
    let g = (await h.call<Group[]>('GET', `/batch/vcs?ids=${s!.id}`))[0]!;
    t.check('snapshot taken', (await press('snapshot-here', Object.fromEntries(g.entries.map((e) => [e.path, e.choice ?? 'include'])))).ok, true);
    g = (await h.call<Group[]>('GET', `/batch/vcs?ids=${s!.id}`))[0]!;
    t.check('C41: a snapshot is not a started session', g.sessions[0]?.started, false);
    const start = ((await h.session(s!.id)) as unknown as { vcsStart?: { snapshot?: { approvedAt?: string } } }).vcsStart;
    t.truthy('C39: the approval is timestamped', !!start?.snapshot?.approvedAt, start);

    // Attempt 1 gives up after a step; attempt 2 does it.
    h.chat.script(reply.steps('Get-ChildItem'), reply.blocked());
    await h.run(s!.id, 'unattended');
    const first = ((await h.session(s!.id)) as unknown as View).tasks[0]!;
    await h.call('POST', `/sessions/${s!.id}/tasks/${first.id}/rerun`, {});
    h.chat.script(reply.steps("New-Item -ItemType Directory -Force test | Out-Null; Set-Content -Path test/x.txt -Value 'done'"), reply.done());
    // Step by step this time: every step is approved, as the operator would.
    await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' });
    for (let i = 0; i < 40; i += 1) {
      for (const a of await h.call<Array<{ id: string }>>('GET', '/approvals')) await h.call('POST', `/approvals/${a.id}`, { action: 'run' });
      const act = await h.call<{ running: boolean; starting?: boolean }>('GET', '/activity');
      if (!act.running && !act.starting) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const v = (await h.session(s!.id)) as unknown as { tasks: Array<Task & { runGroup?: { id: string }; attempts?: Array<{ runGroup?: { id: string } }>; vcs?: { beforeCommit?: { changed: string[] } } }> };
    const task = v.tasks[0]!;
    t.check('attempt 2 is done', task.status, 'done');
    t.check('C40: the pre-commit state lists files, not folders', task.vcs?.beforeCommit?.changed, ['test/x.txt']);

    type Bot = { runs: Record<string, { refused?: boolean }>; operatorActions: Record<string, Array<{ type: string }>>; tasks: Array<{ problems: unknown[]; policy?: { mode: string }; transport: { counts: Record<string, number> }; eventCounts: Record<string, number>; earlierAttempts: Array<{ run?: { id: string }; policy?: { mode: string }; problems: unknown[] }> }> };
    const bot = await h.call<Bot>('GET', `/export/bot?session=${s!.id}`);
    const ids = Object.keys(bot.runs);
    t.truthy('C32: the export lists both attempts\' runs and the refused run', ids.includes(task.runGroup!.id) && ids.includes(task.attempts![0]!.runGroup!.id) && Object.values(bot.runs).some((r) => r.refused), bot.runs);
    const ea = bot.tasks[0]!.earlierAttempts[0]!;
    t.check('C32: the earlier attempt carries its run and its mode', [ea.run?.id, ea.policy?.mode, bot.tasks[0]!.policy?.mode], [task.attempts![0]!.runGroup!.id, 'unattended', 'step-by-step']);
    t.truthy('C34: the blocked attempt\'s problems are listed', ea.problems.length > 0, ea.problems);
    t.truthy('C35: version control events are in the transcript', (bot.tasks[0]!.eventCounts['vcs-branch'] ?? 0) + (bot.tasks[0]!.eventCounts['vcs-commit'] ?? 0) > 0, bot.tasks[0]!.eventCounts);
    t.truthy('C38: every message sent is counted', (bot.tasks[0]!.transport.counts['message-sent'] ?? 0) >= 2, bot.tasks[0]!.transport.counts);
    const runDir = join(h.runsDir, (task as unknown as { runId: string }).runId, 'messages');
    t.truthy('C38: and kept as text', existsSync(runDir) && readdirSync(runDir).length >= 2, existsSync(runDir) ? readdirSync(runDir) : 'no messages folder');
    t.truthy('C36: the run-screen actions are on record', (bot.operatorActions[s!.id] ?? []).filter((a) => a.type === 'run-screen-action').length === 2, bot.operatorActions);
    void readFileSync;
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- C37: the work export\'s session start keeps the update from the remote ---');
{
  const h = await startHarness({});
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'start-record', onFailure: 'stop', vcs: vcs(h, { startFrom: 'branch', baseBranch: 'main', updateFromRemote: true }), review: { enabled: false },
        tasks: [{ title: 'write y', prompt: 'Write y.txt in the project folder holding exactly the word done.', checks: [{ name: 'y says done', expect: 'file-contains', file: 'y.txt', value: 'done' }] }] }],
    });
    h.chat.script(reply.steps("Set-Content -Path y.txt -Value 'done'"), reply.done());
    await h.run(s!.id, 'unattended');
    type Dom = { tasks: Array<{ session: { start?: { kind: string; update?: { outcome: string } } } }> };
    const dom = await h.call<Dom>('GET', `/export/domain?session=${s!.id}`);
    t.check('start with its update', [dom.tasks[0]!.session.start?.kind, dom.tasks[0]!.session.start?.update?.outcome], ['branch', 'no-remote']);
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
    h.chat.script(
      reply.steps(String.raw`Get-Content C:\Windows\win.ini`, "Set-Content -Path after.txt -Value 'too early'"),
      (m) => { report = Object.values(m.attached).join('\n'); return reply.steps("Set-Content -Path after.txt -Value 'hello'"); },
      reply.done(),
    );
    await h.run(s!.id, 'unattended');
    t.truthy('the second step was not run, and the chat is told why', /not run, because step 1 of this reply was refused/.test(report), report.slice(0, 1500));
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

console.log('\n--- wave 2: what the plan check, the panel and the records say ---');
{
  type Group = { ready: boolean; inputs: Array<{ path: string }>; unrelated: Array<{ path: string; reason?: string }>; actions: Array<{ id: string; available: boolean; recommended?: boolean }> };
  const h = await startHarness({});
  try {
    const checkPlan = (plan: unknown) => h.call<{ ok: boolean; issues?: Array<{ message: string }>; warnings?: string[] }>('POST', '/plan/check', { text: JSON.stringify(plan) });
    const two = [
      { title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one.', checks: [{ name: 'a says one', expect: 'file-contains', file: 'a.txt', value: 'one' }] },
      { title: 'write b', prompt: 'Write b.txt in the project folder holding exactly the word two.', checks: [{ name: 'b says two', expect: 'file-contains', file: 'b.txt', value: 'two' }] },
    ];
    const off = await checkPlan({ version: 1, sessions: [{ name: 'commits-off', vcs: vcs(h, { branchMode: 'per-task', commitOnFinish: false }), review: { enabled: false }, tasks: two }] });
    t.truthy('C47: per-task with commits off is warned about at import', (off.warnings ?? []).some((w) => /gives only the first task a branch of its own/.test(w)), off.warnings);
    const missing = await checkPlan({ version: 1, sessions: [{ name: 'no-folder', projectDir: join(h.base, 'nowhere'), vcs: { enabled: false }, review: { enabled: false }, tasks: two.slice(0, 1) }] });
    t.truthy('C66: a missing project folder is refused with version control off too', !missing.ok && (missing.issues ?? []).some((i) => /does not exist/.test(i.message)), missing);

    // C57/C60: reasons for unrelated files under "refuse"; the fix that leaves the checkout alone is recommended.
    mkdirSync(join(h.repo, 'specs'), { recursive: true });
    writeFileSync(join(h.repo, 'specs', 'rates.json'), '{}\n');
    const [s] = await session(h, { version: 1, sessions: [{ name: 'panel', vcs: vcs(h, { startFrom: 'branch', baseBranch: 'main', userInputs: { paths: ['specs/**'] } }), review: { enabled: false }, tasks: two.slice(0, 1) }] });
    let g = (await h.call<Group[]>('GET', `/batch/vcs?ids=${s!.id}`))[0]!;
    t.check('C60: on the base branch, the snapshot on it is recommended', g.actions.find((a) => a.id === 'snapshot-on-base')?.recommended, true);
    writeFileSync(join(h.repo, '.env'), 'X=1\n');
    g = (await h.call<Group[]>('GET', `/batch/vcs?ids=${s!.id}`))[0]!;
    t.truthy('C57: a secrets file among the other files says what it is', /secrets/.test(g.unrelated.find((u) => u.path === '.env')?.reason ?? ''), g.unrelated);
    rmSync(join(h.repo, '.env'));

    // C44: run from a snapshot on main; afterwards the repository is on the work branch and the inputs are not on main: said.
    g = (await h.call<Group[]>('GET', `/batch/vcs?ids=${s!.id}`))[0]!;
    await h.call('POST', '/batch/vcs/prepare', { sessionIds: [s!.id], repoDir: h.repo, action: 'snapshot-on-base', choices: Object.fromEntries(g.inputs.map((e) => [e.path, 'include'])) });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done());
    await h.run(s!.id, 'unattended');
    const events = await h.call<Array<{ type: string; message: string }>>('GET', `/sessions/${s!.id}/events`);
    t.truthy('C44: where the repository is left, and that the inputs are not on main, is said', events.some((e) => e.type === 'vcs-left-on' && /not on main/.test(e.message) && /git restore --source/.test(e.message)), events.filter((e) => e.type === 'vcs-left-on'));

    // C51: a new prompt on a done task does not reuse the plan's commit subject.
    const [c] = await session(h, { version: 1, sessions: [{ name: 'subject', vcs: vcs(h, { startFrom: 'head' }), review: { enabled: false },
      tasks: [{ ...two[1]!, vcs: { commitMessage: 'Write b as planned' } }] }] });
    h.chat.script(reply.steps("Set-Content -Path b.txt -Value 'two'"), reply.done());
    await h.run(c!.id, 'unattended');
    const task = (await h.session(c!.id)).tasks[0]!;
    await h.call('POST', `/sessions/${c!.id}/tasks/${task.id}/rerun`, { prompt: 'Write b.txt in the project folder holding exactly the word three.' });
    const after = (await h.session(c!.id)).tasks[0] as unknown as { vcsPlan?: { commitMessage?: string } };
    t.check('C51: the plan\'s commit subject is dropped with a new prompt', after.vcsPlan?.commitMessage ?? null, null);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

void writeFileSync;
void reply;
t.finish();
