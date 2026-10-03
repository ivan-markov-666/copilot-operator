/**
 * The bug report of 2026-10-03 (run 20261003-085052, on 0.1.20) and the button asked for with it.
 *
 * The report: the operator had put files on a branch of their own and the plan started from "main". The
 * run emitted `task-started`, set up the shell, opened Edge and collected artifacts, and only then said
 * "the repository has uncommitted changes … Nothing was run" — a failed attempt with zero iterations,
 * and an export that recorded the run as unattended although it was started step by step. Here, with
 * the real API and runner and the scripted chat:
 *
 *   - a start refused by the preflight opens nothing, creates no attempt and emits no `task-started`;
 *     the run log has run-preflight-started, repository-preflight, snapshot-approval-required and
 *     run-preflight-refused, and no browser-launch-requested;
 *   - once fixed on the run screen, the run's log shows baseline-created, run-preflight-passed and only
 *     then browser-launch-requested, and the runner export proves that order;
 *   - a run started step by step is `policy.mode: step-by-step` in the export, whatever Settings offers
 *     first; the Settings default is named as such;
 *   - files that were there before and untouched do not produce `artifacts-kept`;
 *   - a session reached later in a batch whose version control is not ready does not start: its task
 *     stays queued, with no attempt.
 *
 * The button, "Prepare the folder from the remote main branch": the preview fetches and changes nothing
 * else; Confirm keeps uncommitted changes and new files on a saved branch, commits of the local main the
 * remote lacks on another, puts the folder on main at the remote with nothing uncommitted, leaves ignored
 * files and the branch it was on alone, and refuses when the folder changed since the preview, for a
 * folder the bot does not work in, and while a run works there.
 *
 *   npm run check:prepare
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startHarness, Tally, waitFor, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

type Group = { ready: boolean; repoDir: string; actions: Array<{ id: string; available: boolean }>; entries: Array<{ path: string; choice?: string }> };
type Entry = { type: string; at: string; data?: Record<string, unknown> };
const runLog = (h: Harness, runId: string): Entry[] => {
  const path = join(h.runsDir, '_runs', runId, 'run.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry) : [];
};
const runIds = (h: Harness): string[] => (existsSync(join(h.runsDir, '_runs')) ? readdirSync(join(h.runsDir, '_runs')) : []);

const plan = (h: Harness, extra: Record<string, unknown> = {}): unknown => ({
  version: 1,
  sessions: [
    {
      name: 'from-main',
      onFailure: 'stop',
      vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', startFrom: 'branch', baseBranch: 'main', updateFromRemote: false, artifacts: { paths: ['reports/**'] }, ...extra },
      review: { enabled: false },
      tasks: [{ title: 'one', prompt: 'Write one.txt holding exactly one.' }],
    },
  ],
});

console.log('--- the report: files on a branch of their own, the plan starting from main ---');
{
  // Settings offer "unattended" first; the run is started step by step.
  const h = await startHarness({ settings: { execution: { mode: 'unattended', isolation: 'none-accepted' } } });
  try {
    // An artifact that was there before the run and is never touched.
    mkdirSync(join(h.repo, 'reports'), { recursive: true });
    writeFileSync(join(h.repo, 'reports', 'old.txt'), 'old\n');
    writeFileSync(join(h.repo, '.gitignore'), 'reports/\n');
    h.git('add', '.gitignore');
    h.git('commit', '-q', '-m', 'ignore reports');
    h.git('checkout', '-q', '-b', 'feature/mine');
    writeFileSync(join(h.repo, 'Helper.cs'), 'class Helper {}\n');
    const [s] = await h.importPlan(plan(h));

    const refused = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' });
    t.check('the start is refused', refused.started, false);
    t.check('nothing was opened or sent', [h.chat.opened, h.chat.sent.length], [0, 0]);
    const after = await h.session(s!.id);
    t.check('no attempt: the task is still queued, never started', [after.tasks[0]!.status, (after.tasks[0] as { runId?: string }).runId ?? null, (after.tasks[0] as { startedAt?: string }).startedAt ?? null], ['queued', null, null]);
    const events = await h.call<Array<{ type: string }>>('GET', `/sessions/${s!.id}/events`);
    t.check('no task-started, no shell, no artifacts', events.filter((e) => ['task-started', 'workdir', 'confinement', 'artifacts-kept', 'browser-launch-requested'].includes(e.type)).map((e) => e.type), []);
    const ids = runIds(h);
    t.check('one run log, for the refused start', ids.length, 1);
    const refusedLog = runLog(h, ids[0]!).map((e) => e.type);
    t.check('which says what happened, in order', refusedLog, ['run-preflight-started', 'repository-preflight', 'snapshot-approval-required', 'run-preflight-refused']);

    // The fix on the run screen: start from the current branch, take the file as the starting snapshot.
    const groups = () => h.call<Group[]>('GET', `/batch/vcs?ids=${s!.id}`);
    const g = (await groups())[0]!;
    const press = async (action: string, choices: Record<string, string> = {}) =>
      h.call<{ ok: boolean; problem?: string }>('POST', '/batch/vcs/prepare', { sessionIds: [s!.id], repoDir: g.repoDir, action, choices });
    t.check('"Use the current branch instead of main" is offered', g.actions.some((a) => a.id === 'use-current-branch' && a.available), true);
    t.check('pressed', (await press('use-current-branch')).ok, true);
    let next = (await groups())[0]!;
    if (next.actions.some((a) => a.id === 'allow-snapshot' && a.available)) {
      t.check('then "take them as a starting snapshot"', (await press('allow-snapshot')).ok, true);
      next = (await groups())[0]!;
    }
    const took = await press('snapshot-here', Object.fromEntries(next.entries.filter((e) => e.choice).map((e) => [e.path, e.choice!])));
    t.check('the starting snapshot is taken', [took.ok, took.problem ?? null], [true, null]);
    t.check('the panel is ready', (await groups())[0]!.ready, true);

    // Step by step: every step approved here, as the operator would.
    h.chat.script(reply.steps("Set-Content -Path one.txt -Value 'one' -Encoding utf8"), reply.done());
    const started = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' });
    t.check('the run starts', [started.started, started.reason ?? null], [true, null]);
    let approved = 0;
    await waitFor('every step approved and the run ended', async () => {
      for (const a of await h.call<Array<{ id: string }>>('GET', '/approvals')) {
        await h.call('POST', `/approvals/${a.id}`, { action: 'run' });
        approved += 1;
      }
      const act = await h.call<{ running: boolean; starting?: boolean }>('GET', '/activity');
      return !act.running && !act.starting;
    }, 120_000);
    t.truthy('each step was asked about', approved >= 1, approved);
    const done = await h.session(s!.id);
    t.check('the task is done', done.tasks[0]!.status, 'done');

    const runId = (done.tasks[0] as { runGroup?: { id: string } }).runGroup?.id ?? '';
    const passedLog = runLog(h, runId).map((e) => e.type);
    t.check('the run\'s log: baseline, pass, then the browser', passedLog, ['run-preflight-started', 'baseline-created', 'repository-preflight', 'run-preflight-passed', 'browser-launch-requested']);

    type Bot = {
      machine: { limits: { execution: Record<string, unknown> } };
      runs: Record<string, { preflight: Entry[]; order: { browserOnlyAfterPreflight: boolean | null } }>;
      tasks: Array<{ run?: { id: string }; policy?: { mode: string }; eventCounts: Record<string, number> }>;
    };
    const bot = await h.call<Bot>('GET', `/export/bot?session=${s!.id}`);
    const task = bot.tasks[0]!;
    t.check('the export proves the browser was asked for only after the preflight passed', [task.run?.id, bot.runs[runId]?.order.browserOnlyAfterPreflight], [runId, true]);
    t.check('a run started step by step is recorded step by step', task.policy?.mode, 'step-by-step');
    t.check('the Settings default is named as a default, not as the run\'s mode', [bot.machine.limits.execution.defaultModeInSettings, 'mode' in bot.machine.limits.execution], ['unattended', false]);
    t.check('an artifact that was there and untouched is not "kept"', [task.eventCounts['artifacts-kept'] ?? 0, task.eventCounts['artifacts-none'] ?? 0], [0, 1]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- a batch: the second session is not ready when its turn comes ---');
{
  const h = await startHarness({});
  try {
    // Version control off, working in the same folder: what it writes stays uncommitted for the next session.
    const one = { name: 'no-vcs', onFailure: 'continue', projectDir: h.repo, vcs: { enabled: false }, review: { enabled: false },
      tasks: [{ title: 'leaves a file', prompt: 'Write one.txt in the project folder, holding exactly one.' }] };
    const two = { name: 'later', onFailure: 'stop', vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', startFrom: 'head', updateFromRemote: false, commitOnFinish: true }, review: { enabled: false },
      tasks: [{ title: 'two', prompt: 'Write two.txt in the project folder, holding exactly two.' }] };
    const [a, b] = await h.importPlan({ version: 1, sessions: [one, two] });
    h.chat.script(reply.steps("Set-Content -Path one.txt -Value 'one' -Encoding utf8"), reply.done());
    const started = await h.call<{ started: boolean; reason?: string }>('POST', '/batch/start', { sessionIds: [a!.id, b!.id], mode: 'unattended', onFailure: 'continue' });
    t.check('the batch starts', [started.started, started.reason ?? null], [true, null]);
    await h.idle();
    const later = await h.session(b!.id);
    t.check('the first is done', (await h.session(a!.id)).tasks[0]!.status, 'done');
    t.check('the later one did not start: queued, no attempt', [later.tasks[0]!.status, (later.tasks[0] as { runId?: string }).runId ?? null], ['queued', null]);
    const events = await h.call<Array<{ type: string }>>('GET', `/sessions/${b!.id}/events`);
    t.check('it says why, and no task-started', [events.some((e) => e.type === 'run-preflight-refused'), events.some((e) => e.type === 'task-started')], [true, false]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- "Prepare the folder from the remote main branch" ---');
{
  const h = await startHarness({});
  try {
    const remote = join(h.base, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    h.git('remote', 'add', 'origin', remote);
    writeFileSync(join(h.repo, '.gitignore'), 'node_modules/\n.env\n');
    h.git('add', '-A');
    h.git('commit', '-q', '-m', 'ignore');
    h.git('push', '-q', 'origin', 'main');
    // Someone else moves the remote's main on: the preview must fetch to see it.
    const other = join(h.base, 'other');
    execFileSync('git', ['clone', '-q', remote, other]);
    const og = (...args: string[]): string => execFileSync('git', ['-C', other, ...args], { encoding: 'utf8' }).trim();
    og('config', 'user.email', 'o@example.invalid');
    og('config', 'user.name', 'o');
    writeFileSync(join(other, 'team.txt'), 'team\n');
    og('add', '-A');
    og('commit', '-q', '-m', 'team work');
    og('push', '-q', 'origin', 'main');
    const remoteMain = og('rev-parse', 'HEAD');

    // Here: a local main commit the remote does not have, then a branch with work, changes and new files.
    writeFileSync(join(h.repo, 'local.txt'), 'local\n');
    h.git('add', '-A');
    h.git('commit', '-q', '-m', 'local only');
    h.git('checkout', '-q', '-b', 'feature/mine');
    writeFileSync(join(h.repo, 'feature.txt'), 'feature\n');
    h.git('add', '-A');
    h.git('commit', '-q', '-m', 'feature work');
    const featureHead = h.git('rev-parse', 'HEAD');
    writeFileSync(join(h.repo, 'README.md'), '# changed\n');
    mkdirSync(join(h.repo, 'src'), { recursive: true });
    writeFileSync(join(h.repo, 'src', 'Helper.cs'), 'class Helper {}\n');
    mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(h.repo, 'node_modules', 'pkg', 'index.js'), '1\n');
    writeFileSync(join(h.repo, '.env'), 'SECRET=1\n');

    type Plan = { ok: boolean; problem?: string; target?: string; targetCommit?: string; branch?: string; localBranch?: string; changed: string[]; untracked: string[]; mainOnlyCommits: string[]; branchOnlyCommits: string[]; savedBranch?: string; savedMainBranch?: string; fingerprint?: string; alreadyThere?: boolean };
    type Done = { ok: boolean; problem?: string; result?: string; saved?: Array<{ branch: string; commit: string }> };
    const refusedDir = await h.raw('POST', '/repo/prepare/preview', { dir: h.base });
    t.truthy('a folder the bot does not work in is refused', refusedDir.status >= 400 && /not one of the projects/.test(JSON.stringify(refusedDir.body)), refusedDir.body);

    const p = await h.call<Plan>('POST', '/repo/prepare/preview', { dir: h.repo });
    t.check('the preview fetched: the remote main as it is now', [p.ok, p.target, p.targetCommit, p.localBranch], [true, 'origin/main', remoteMain, 'main']);
    t.check('what is uncommitted, ignored files left out', [p.changed, p.untracked], [['README.md'], ['src/Helper.cs']]);
    t.check('the local main\'s own commit, and the branch\'s', [p.mainOnlyCommits.length, p.branchOnlyCommits.length], [1, 2]);
    t.truthy('with where each is kept', /^cop\/saved\//.test(p.savedBranch ?? '') && /^cop\/saved\/.*-main$/.test(p.savedMainBranch ?? ''), [p.savedBranch, p.savedMainBranch]);
    t.check('the preview changed nothing else', [h.git('branch', '--show-current'), h.git('rev-parse', 'HEAD'), existsSync(join(h.repo, 'src', 'Helper.cs'))], ['feature/mine', featureHead, true]);

    // The folder changes after the preview: refused, nothing done.
    writeFileSync(join(h.repo, 'late.txt'), 'late\n');
    const stale = await h.call<Done>('POST', '/repo/prepare', { dir: h.repo, fingerprint: p.fingerprint });
    t.truthy('a folder that changed since the preview is refused', !stale.ok && /changed since the preview/.test(stale.problem ?? ''), stale);
    t.check('and nothing was done', [h.git('branch', '--show-current'), h.git('branch', '--list', 'cop/saved/*')], ['feature/mine', '']);

    const p2 = await h.call<Plan>('POST', '/repo/prepare/preview', { dir: h.repo });
    const done = await h.call<Done>('POST', '/repo/prepare', { dir: h.repo, fingerprint: p2.fingerprint });
    t.check('prepared', [done.ok, done.problem ?? null], [true, null]);
    t.check('the folder is on main at the remote main, nothing uncommitted', [h.git('branch', '--show-current'), h.git('rev-parse', 'HEAD'), h.git('status', '--porcelain')], ['main', remoteMain, '']);
    t.check('main follows the remote', h.git('rev-parse', '--abbrev-ref', 'main@{upstream}'), 'origin/main');
    t.check('the new files left the folder', [existsSync(join(h.repo, 'src', 'Helper.cs')), existsSync(join(h.repo, 'late.txt')), readFileSync(join(h.repo, 'README.md'), 'utf8')], [false, false, '# fixture\n']);
    t.check('ignored files are not touched', [existsSync(join(h.repo, 'node_modules', 'pkg', 'index.js')), existsSync(join(h.repo, '.env'))], [true, true]);
    const saved = done.saved ?? [];
    const work = saved.find((x) => !x.branch.endsWith('-main'));
    const mainKept = saved.find((x) => x.branch.endsWith('-main'));
    t.check('the uncommitted work is on the saved branch, whole', work ? [h.git('show', `${work.branch}:README.md`), h.git('show', `${work.branch}:src/Helper.cs`), h.git('show', `${work.branch}:late.txt`), h.git('rev-parse', `${work.branch}^`)] : null, ['# changed', 'class Helper {}', 'late', featureHead]);
    t.truthy('and no ignored file went into it', !!work && !h.git('ls-tree', '-r', '--name-only', work.branch).split('\n').some((f) => f.startsWith('node_modules/') || f === '.env'));
    t.check('the local main\'s own commit is kept', mainKept ? h.git('log', '-1', '--format=%s', mainKept.branch) : null, 'local only');
    t.check('the branch it was on keeps its commits', h.git('rev-parse', 'feature/mine'), featureHead);

    const again = await h.call<Plan>('POST', '/repo/prepare/preview', { dir: h.repo });
    t.check('pressed again: already there', [again.ok, again.alreadyThere], [true, true]);

    // Then the operator's files on top, and a session from main: the run screen offers the snapshot.
    writeFileSync(join(h.repo, 'Helper.cs'), 'class Helper {}\n');
    const [s] = await h.importPlan(plan(h, { artifacts: undefined }));
    const g = (await h.call<Group[]>('GET', `/batch/vcs?ids=${s!.id}`))[0]!;
    t.truthy('the run screen offers a starting snapshot for the new file', !g.ready && g.actions.some((a) => (a.id === 'allow-snapshot' || a.id === 'snapshot-here') && a.available), g.actions);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

t.finish();
