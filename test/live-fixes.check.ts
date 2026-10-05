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
import { versionControlLines } from '../src/session/exportRecord.js';

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
    const scratch = g.entries.find((e) => e.path === 'scratch.txt') as { allowed: string[]; choice?: string } | undefined;
    t.check("a file named like a scratch copy is the operator's to include, left out unless ticked (2026-10-04)", [scratch?.allowed, scratch?.choice], [['include', 'leave-out'], 'leave-out']);
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
    // 2026-10-04: the record named no changed file beside a verdict that named one.
    const done = v.tasks[0] as unknown as { treeChanged?: string[]; handoff?: { changedFiles: unknown[]; uncommittedFiles?: string[] } };
    t.check('the changed file is on record without a commit', [done.treeChanged, done.handoff?.uncommittedFiles], [['notes.md'], ['notes.md']]);
    const lines = versionControlLines(v.tasks[0] as never, { vcs: { enabled: false } } as never);
    t.truthy('and in the record', lines.some((l) => /changed, not committed: 1 file\(s\) — notes\.md/.test(l)), lines);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- 2026-10-04: with commits off the record says so, not "the task changed no files" ---');
{
  const task = { id: 't', title: 't', prompt: '', status: 'done', treeChanged: ['src/a.js'],
    vcs: { branch: 'cop/t', baseCommit: 'abcdef1234', afterCommit: { branch: 'cop/t', head: 'abcdef1234', clean: false, changed: ['src/a.js'] } } };
  const lines = versionControlLines(task as never, { vcs: { enabled: true, commitOnFinish: false } } as never);
  const commit = lines.find((l) => l.startsWith('commit ')) ?? '';
  t.truthy('commits off, not "changed no files"', /commits are off for this session, so the changes stay in the working tree/.test(commit) && !/changed no files/.test(commit), commit);
  t.truthy('and the changed file is named', lines.some((l) => /changed, not committed: 1 file\(s\) — src\/a\.js/.test(l)), lines);
  const on = versionControlLines({ ...task, treeChanged: undefined, vcs: { branch: 'cop/t', baseCommit: 'abcdef1234' } } as never, { vcs: { enabled: true } } as never);
  t.truthy('with commits on and nothing changed it still says so', on.some((l) => /none — the task changed no files/.test(l)), on);
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
    // 2026-10-04: the button said the checkout stays exactly as it is, and the update then moved main under it.
    const said = (g.actions.find((a) => a.id === 'snapshot-on-base') as { result?: string } | undefined)?.result ?? '';
    t.truthy('the button says main is brought up to its remote first, moving the checkout', /First brings "main" up to its remote, fast-forward only, which moves your checkout with it/.test(said) && !/stay exactly as they are/.test(said), said);
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

console.log('\n--- 2026-10-04: a file check is judged on the tree the task starts from, not the folder as it is ---');
{
  type BatchView = { sessions: Array<{ sessionId: string; state: string; reason?: string }> };
  const h = await startHarness({});
  try {
    const remote = join(h.base, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    h.git('remote', 'add', 'origin', remote);
    h.git('push', '-q', '-u', 'origin', 'main');
    // main on the remote gains src/units.js; the local main does not have it yet.
    const other = join(h.base, 'other');
    execFileSync('git', ['clone', '-q', remote, other]);
    const og = (...a: string[]): string => execFileSync('git', ['-C', other, ...a], { encoding: 'utf8' }).trim();
    og('config', 'user.email', 'o@example.invalid');
    og('config', 'user.name', 'o');
    mkdirSync(join(other, 'src'), { recursive: true });
    writeFileSync(join(other, 'src', 'units.js'), 'exports.toCelsius = (f) => (f - 32) * 5 / 9;\n');
    og('add', '-A');
    og('commit', '-q', '-m', 'units');
    og('push', '-q', 'origin', 'main');
    // A local branch with a notes file of its own, checked out now.
    h.git('checkout', '-q', '-b', 'feature/notes');
    mkdirSync(join(h.repo, 'notes'), { recursive: true });
    writeFileSync(join(h.repo, 'notes', 'TODO.md'), '- local only note\n');
    h.git('add', '-A');
    h.git('commit', '-q', '-m', 'notes');
    const plans = await session(h, {
      version: 1,
      sessions: [
        { name: 'remote-update', onFailure: 'stop', vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', startFrom: 'branch', baseBranch: 'main', updateFromRemote: true }, review: { enabled: false },
          tasks: [{ title: 'units test', prompt: 'Add test/units.test.js with a node:test test for toCelsius from src/units.js, and run it.', scope: ['test/**'],
            checks: [{ name: 'units from the remote main', expect: 'file-contains', file: 'src/units.js', value: 'toCelsius' }] }] },
        { name: 'notes-existing', onFailure: 'stop', vcs: { enabled: true, repoDir: h.repo, startFrom: 'existing-branch', existingBranch: 'feature/notes', updateFromRemote: false }, review: { enabled: false },
          tasks: [{ title: 'count notes', prompt: 'Add src/count.js that counts the lines starting with a dash in notes/TODO.md.', scope: ['src/**'],
            checks: [{ name: 'the local note', expect: 'file-contains', file: 'notes/TODO.md', value: 'local only note' }] }] },
      ],
    });
    const [u, e] = plans;
    h.chat.script(
      reply.steps("New-Item -ItemType Directory -Force test | Out-Null; Set-Content -Path test/units.test.js -Value 'ok'"), reply.done('I wrote test/units.test.js with a node:test test for toCelsius from src/units.js, and it passes.'),
      reply.steps("Set-Content -Path src/count.js -Value 'ok'"), reply.done('I wrote src/count.js, which counts the dashed lines of notes/TODO.md, and checked it by hand.'),
    );
    const r = await h.call<{ started: boolean; reason?: string }>('POST', '/batch/start', { sessionIds: [u!.id, e!.id], mode: 'unattended' });
    t.check('the batch is not refused for a file the folder lacks now', [r.started, r.reason ?? null], [true, null]);
    await h.idle();
    const su = await h.session(u!.id) as unknown as View;
    const se = await h.session(e!.id) as unknown as View;
    t.check('the first, started from main brought up to the remote, ran', [su.tasks[0]!.status, su.tasks[0]!.reason ?? null], ['done', null]);
    t.check('the second, on its existing branch, was not refused for the first one\'s tree', [se.tasks[0]!.status, se.tasks[0]!.reason ?? null], ['done', null]);
    // Still refused where the start is known and the file is not there: the local main with no remote update.
    h.git('checkout', '-q', 'feature/notes');
    const [w] = await session(h, {
      version: 1,
      sessions: [{ name: 'local-main', onFailure: 'stop', vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', startFrom: 'branch', baseBranch: 'main', updateFromRemote: false }, review: { enabled: false },
        tasks: [{ title: 'needs notes', prompt: 'Add test/x.test.js with a node:test test that reads notes/TODO.md and checks it is not empty.', scope: ['test/**'],
          checks: [{ name: 'notes on main', expect: 'file-contains', file: 'notes/TODO.md', value: 'local only note' }] }] }],
    });
    const refused = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${w!.id}/start`, { mode: 'unattended' });
    t.truthy('a check that fails on the known start (main) is still refused, though the folder has the file', !refused.started && /notes on main/.test(refused.reason ?? ''), refused);
    const batch = await h.call<BatchView>('GET', '/batch');
    t.truthy('the batch record has no refusal', batch.sessions.every((x) => x.state === 'done'), batch);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- 2026-10-04: where the contract\'s file checks are read, and the input files carried onto a start ---');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { contractConflicts } = await import('../src/orchestrator/contract.js');
  const dir = mkdtempSync(join(tmpdir(), 'cop-contract-'));
  try {
    const g = (...a: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), 'x\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    g('checkout', '-q', '-b', 'other');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'units.js'), 'toCelsius\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'units on other');
    const task = { scope: ['test/**'], checks: [{ name: 'units there', expect: 'file-contains' as const, file: 'src/units.js', value: 'toCelsius' }] };
    t.check('on the tree as it is (on other): it passes', (await contractConflicts(task as never, dir, dir, { files: 'tree' })).length, 0);
    t.check('on main, where the task starts: a contradiction', (await contractConflicts(task as never, dir, dir, { files: { ref: 'main' } })).length, 1);
    t.check('not judged when the start is not known yet', (await contractConflicts(task as never, dir, dir, { files: 'unknown' })).length, 0);
    const inputs = { scope: ['docs/**'], checks: [{ name: 'the rate spec', expect: 'file-contains' as const, file: 'specs/rates.json', value: '"GBP": null' }] };
    t.check('an input file missing from the start, without carry: a contradiction', (await contractConflicts(inputs as never, dir, dir, { files: { ref: 'main' } })).length, 1);
    t.check('one the runner carries onto the start is left to the start', (await contractConflicts(inputs as never, dir, dir, { files: { ref: 'main' }, carried: ['specs/**'] })).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n--- 2026-10-04: a session refused at its turn in a batch is on the run\'s record, and not "failed" ---');
{
  type BatchView = { sessions: Array<{ sessionId: string; state: string; reason?: string }> };
  const h = await startHarness({});
  try {
    const plans = await session(h, {
      version: 1,
      sessions: [
        { name: 'first', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
          tasks: [{ title: 'write a', prompt: 'Write the word one into a.txt in the project folder, and nothing else.', checks: [{ name: 'a says one', expect: 'file-contains', file: 'a.txt', value: 'one' }] }] },
        // Judged at its turn, on the tree the first session leaves: a file nobody made, outside its scope.
        { name: 'second', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
          tasks: [{ title: 'write b', prompt: 'Write the word two into src/b.txt in the project folder, and nothing else.', scope: ['src/**'], checks: [{ name: 'never there', expect: 'file-contains', file: 'nowhere.txt', value: 'two' }] }] },
      ],
    });
    const [a, b] = plans;
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done('I wrote the word one into a.txt and read the file back to check it.'));
    const r = await h.call<{ started: boolean; reason?: string }>('POST', '/batch/start', { sessionIds: [a!.id, b!.id], mode: 'unattended' });
    // Head-started sessions after another in the same repository are judged at their turn, not up front.
    t.check('the batch starts', r.started, true);
    await h.idle();
    const batch = await h.call<BatchView>('GET', '/batch');
    const eb = batch.sessions.find((x) => x.sessionId === b!.id);
    t.truthy('the second is skipped with why, not failed', eb?.state === 'skipped' && /contradicts itself/.test(eb.reason ?? ''), eb);
    const sb = await h.session(b!.id) as unknown as View;
    t.check('its task stays queued', sb.tasks[0]!.status, 'queued');
    const exp = await h.call<{ runs?: Record<string, { refusedAtTurn?: string[]; preflight?: Array<{ type: string; data?: { sessions?: string[] } }> }> }>('GET', `/export/bot?session=${b!.id}`).catch(() => null);
    // A queued task edited after the import is on record with the operator's actions, with what it was.
    await h.call('PUT', `/sessions/${b!.id}/tasks/${sb.tasks[0]!.id}`, { checks: [{ name: 'b says two', expect: 'file-contains', file: 'src/b.txt', value: 'two' }] });
    const bot = await h.call<{ operatorActions: Record<string, Array<{ type: string; data?: { changed?: string[]; before?: { checks?: Array<{ name: string }> } } }>> }>('GET', `/export/bot?session=${b!.id}`);
    const edit = bot.operatorActions[b!.id]?.find((x) => x.type === 'task-edited');
    t.check('the edit of the queued task is on record, with the old check', [edit?.data?.changed, edit?.data?.before?.checks?.[0]?.name], [['checks'], 'never there']);
    const run = Object.values(exp?.runs ?? {})[0];
    t.truthy('and the run it was refused in names it in its export, with the refusal in the run log',
      !!run?.refusedAtTurn?.includes(b!.id) && !!run.preflight?.some((e) => e.type === 'run-preflight-refused' && e.data?.sessions?.includes(b!.id)), exp?.runs);
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

console.log('\n--- 2026-10-04: a Restore after "Run again from here" measures what it leaves on the session\'s branch as it is now ---');
{
  type T = Task & { vcs?: { branch?: string; baseCommit?: string; commit?: string } };
  type Preview = { ok: boolean; leftBehind: string[]; keptOn?: string; currentBranch?: string };
  const h = await startHarness({});
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'restart-restore', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [
          { title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one.', checks: [{ name: 'a says one', expect: 'file-contains', file: 'a.txt', value: 'one' }] },
          { title: 'write b', prompt: 'Write b.txt in the project folder holding exactly the word two.', checks: [{ name: 'b says two', expect: 'file-contains', file: 'b.txt', value: 'two' }] },
        ] }],
    });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done(), reply.steps("Set-Content -Path b.txt -Value 'two'"), reply.done());
    await h.run(s!.id, 'unattended');
    let v = await h.session(s!.id) as unknown as { tasks: T[] };
    const oldBranch = v.tasks[1]!.vcs!.branch!;
    const oldB = v.tasks[1]!.vcs!.commit!;
    const restart = await h.call<{ restored?: string[] }>('POST', `/sessions/${s!.id}/tasks/${v.tasks[1]!.id}/restart`, { start: false });
    t.truthy('the restart moved the session to a restore branch', (restart.restored?.length ?? 0) === 1, restart);
    h.chat.script(reply.steps("Set-Content -Path b.txt -Value 'two'"), reply.done());
    await h.run(s!.id, 'unattended');
    v = await h.session(s!.id) as unknown as { tasks: T[] };
    const newBranch = v.tasks[1]!.vcs!.branch!;
    const newB = v.tasks[1]!.vcs!.commit!;
    t.truthy('the second b is on the restore branch', newBranch !== oldBranch && h.git('branch', '--show-current') === newBranch, [newBranch, oldBranch]);
    const p = await h.call<Preview>('GET', `/sessions/${s!.id}/tasks/${v.tasks[0]!.id}/restore`);
    const listed = p.leftBehind.map((l) => l.split(' ')[0]!);
    t.check('it is kept on the branch checked out now', [p.ok, p.keptOn], [true, newBranch]);
    t.truthy('listing the commit made since, not the abandoned one', listed.some((c) => newB.startsWith(c)) && !listed.some((c) => oldB.startsWith(c)), { listed, newB, oldB });
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- 2026-10-04: in a batch, the shared window\'s events are in the transcript of the session using it ---');
{
  const h = await startHarness({});
  try {
    h.chat.emitEvents = true;
    const mk = (name: string, file: string) => ({ name, onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
      tasks: [{ title: `write ${file}`, prompt: `Write ${file} in the project folder holding exactly the word one.`, checks: [{ name: `${file} says one`, expect: 'file-contains', file, value: 'one' }] }] });
    const [a, b] = await session(h, { version: 1, sessions: [mk('first', 'a.txt'), mk('second', 'b.txt')] });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done(), reply.steps("Set-Content -Path b.txt -Value 'one'"), reply.done());
    const r = await h.call<{ started: boolean }>('POST', '/batch/start', { sessionIds: [a!.id, b!.id], mode: 'unattended' });
    t.check('the batch started', r.started, true);
    await h.idle();
    for (const s of [a!, b!]) {
      const task = (await h.session(s.id)).tasks[0] as unknown as { runId: string };
      const lines = readFileSync(join(h.runsDir, task.runId, 'transcript.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"browser:reply-arrived"'));
      t.truthy(`"${s.name}": the window's events are in its own transcript`, lines.length >= 2, lines.length);
    }
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- 2026-10-04: the model the chat ran on, and why not the one asked for, is in the task\'s record ---');
{
  const h = await startHarness({ settings: { copilot: { defaultModel: 'GPT 9 Imaginary' } } });
  try {
    const [s] = await session(h, {
      version: 1,
      sessions: [{ name: 'model-record', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'write a', prompt: 'Write a.txt in the project folder holding exactly the word one.', checks: [{ name: 'a says one', expect: 'file-contains', file: 'a.txt', value: 'one' }] }] }],
    });
    h.chat.script(reply.steps("Set-Content -Path a.txt -Value 'one'"), reply.done());
    await h.run(s!.id, 'unattended');
    const task = (await h.session(s!.id)).tasks[0] as unknown as { runId: string; status: string };
    const line = readFileSync(join(h.runsDir, task.runId, 'transcript.jsonl'), 'utf8').split('\n').find((l) => l.includes('"model-in-use"')) ?? '';
    t.truthy('the transcript says the chat is not on the model asked for, and why', /"ok":false/.test(line) && /GPT 9 Imaginary/.test(line), line);
    const bot = await h.call<{ tasks: Array<{ eventCounts: Record<string, number> }> }>('GET', `/export/bot?session=${s!.id}`);
    t.truthy('and the export counts it', (bot.tasks[0]!.eventCounts['model-in-use'] ?? 0) === 1, bot.tasks[0]!.eventCounts);
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
    t.truthy('both the session model and the review model were asked under the page\'s names', h.chat.modelRequests.includes('GPT 5.6 Sol Think deeper') && h.chat.modelRequests.includes('GPT 5.6 Sol Quick response'), h.chat.modelRequests);
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

console.log('\n--- C24: a plan check the runner refuses for its command line stops the run before the browser opens ---');
{
  const h = await startHarness({});
  try {
    const plan = {
      version: 1,
      sessions: [{ name: 'net-check', onFailure: 'stop', vcs: vcs(h), review: { enabled: false },
        tasks: [{ title: 'docs page', prompt: 'Write docs/index.html in the project folder with a heading that says Hello.', checks: [
          { name: 'the page has the heading', expect: 'file-contains', file: 'docs/index.html', value: 'Hello' },
          { name: 'the published page is reachable', expect: 'exit-zero', run: 'curl -fsS https://example.com/ -o page.html' },
        ] }] }],
    };
    // 2026-10-04: "Check" said ok, and only the start said the check could never run.
    const checked = await h.call<{ ok: boolean; warnings: string[] }>('POST', '/plan/check', { text: JSON.stringify(plan) });
    t.truthy('the plan check already says it', checked.ok && checked.warnings.some((w) => /"the published page is reachable" is refused by the runner for its own command line/.test(w)), checked);
    const [s] = await session(h, plan);
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
    // 2026-10-04: "after 0 task(s)" beside ran 1, and the task's reason the one of an "abort" answer.
    t.truthy('the batch says a task was cut short', /stopped by the operator: 1 task\(s\) cut short/.test(first?.reason ?? ''), first?.reason);
    const stoppedTask = (await h.session(a!.id)).tasks[0]!;
    t.check('and the task says it was stopped, not aborted', [stoppedTask.status, stoppedTask.reason], ['aborted', 'stopped by the operator']);
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

    // 2026-10-04: refused at its turn inside a batch, the reason pointed at the preparation panel, which has nothing for it.
    const [c, d] = await session(h, { version: 1, sessions: [mk('third', 'c.txt', 'branch'), mk('fourth', 'd.txt', 'previous-session')] });
    h.chat.script(reply.steps('Get-ChildItem'), reply.blocked());
    const bs = await h.call<{ started: boolean; reason?: string }>('POST', '/batch/start', { sessionIds: [c!.id, d!.id], mode: 'unattended', onFailure: 'continue' });
    t.check('the batch of the two starts', [bs.started, bs.reason ?? null], [true, null]);
    await h.idle();
    const ed = (await h.call<{ sessions: Array<{ sessionId: string; state: string; reason?: string }> }>('GET', '/batch')).sessions.find((x) => x.sessionId === d!.id);
    t.truthy('the chained one is skipped at its turn, saying why, with no pointer to the panel',
      ed?.state === 'skipped' && /has not finished/.test(ed.reason ?? '') && !/Prepare version control for this run/.test(ed.reason ?? ''), ed);
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
