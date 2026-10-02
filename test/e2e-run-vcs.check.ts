/**
 * "Prepare version control for this run", end to end with the real API and runner and the scripted
 * chat, from the feedback of 2026-10-02.
 *
 * The operator's repository is on a feature branch with the input YAMLs untracked; the plan's sessions
 * start from "main", the second carrying on the first. Before: the run screen repeated the problem per
 * session, the run buttons stayed on, a start opened the browser and only then found version control
 * not ready. Now:
 *
 *   - one group for the repository, not ready, with the files, the branches and the fixes, each saying
 *     what it does — "Create starting snapshot on main" recommended;
 *   - a start is refused before the browser opens;
 *   - the snapshot on main is the main tree plus the approved inputs only, made without switching
 *     branches: the feature branch, HEAD and the untracked files stay exactly as they were;
 *   - the run then goes: the first session starts from the snapshot, the second carries it on, the
 *     commits hold only each task's work, nothing is left loose;
 *   - the work export names the baseline, the target base, the inputs with their sums, the approval,
 *     the sessions, and which inherited it;
 *   - with another uncommitted file in the tree the snapshot on main is not offered, and says why;
 *     "Use the current branch instead" changes where the sessions start, and nothing else.
 *
 *   npm run check:e2e-run-vcs
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

type Action = { id: string; available: boolean; recommended?: boolean; result: string; why?: string };
type Group = { repoDir: string; ready: boolean; problem?: string; branch: string | null; head: string | null; baseBranch?: string; baseHead?: string | null;
  sessions: Array<{ name: string; role: string }>; inputs: Array<{ path: string; kind: string; size?: number }>; unrelated: Array<{ path: string }>; actions: Action[] };
type View = { id: string; vcs?: { startFrom?: string }; vcsBaseCommit?: string; vcsStart?: { kind: string; commit: string; baseline?: { commit: string } };
  tasks: Array<{ id: string; status: string; reason?: string; vcs?: { baseCommit?: string; commit?: string; files?: Array<{ path: string }> } }> };

function setUp(h: Harness): void {
  h.git('checkout', '-q', '-b', 'feature/operator-work');
  mkdirSync(join(h.repo, 'rules-engine', 'test-data', 'schemas'), { recursive: true });
  for (const n of ['a', 'b']) writeFileSync(join(h.repo, 'rules-engine', 'test-data', 'schemas', `${n}.yaml`), `name: ${n}\n`);
}

const plan = (h: Harness): unknown => {
  const vcs = (extra: Record<string, unknown>): Record<string, unknown> => ({
    enabled: true,
    repoDir: h.repo,
    branchMode: 'per-session',
    baseBranch: 'main',
    updateFromRemote: false,
    userInputs: { paths: ['rules-engine/test-data/schemas/*.yaml'] },
    ...extra,
  });
  return {
    version: 1,
    sessions: [
      { name: 'first', onFailure: 'stop', vcs: vcs({ startFrom: 'branch' }), review: { enabled: false }, tasks: [{ title: 'one', prompt: 'Write one.txt holding exactly one, from the schemas.' }] },
      { name: 'second', onFailure: 'stop', vcs: vcs({ startFrom: 'previous-session' }), review: { enabled: false }, tasks: [{ title: 'two', prompt: 'Write two.txt holding exactly two, from the schemas.' }] },
    ],
  };
};

console.log('--- inputs untracked on a feature branch, the plan starting from main ---');
{
  const h = await startHarness({});
  try {
    setUp(h);
    const featureHead = h.git('rev-parse', 'HEAD');
    const mainHead = h.git('rev-parse', 'main');
    const [first, second] = await h.importPlan(plan(h));
    const ids = [first!.id, second!.id];

    const groups = await h.call<Group[]>('GET', `/batch/vcs?ids=${ids.join(',')}`);
    const g = groups[0]!;
    t.check('one group for the repository, not one per session', [groups.length, g.sessions.map((s) => `${s.name}:${s.role}`)], [1, ['first:first', 'second:inherits']]);
    t.check('not ready', g.ready, false);
    t.check('it says where the repository is and where the plan wants it', [g.branch, g.head, g.baseBranch, g.baseHead], ['feature/operator-work', featureHead, 'main', mainHead]);
    t.check('the input files with status and size', g.inputs.map((e) => [e.path, e.kind, e.size]), [['rules-engine/test-data/schemas/a.yaml', 'untracked', 8], ['rules-engine/test-data/schemas/b.yaml', 'untracked', 8]]);
    const onBase = g.actions.find((a) => a.id === 'snapshot-on-base');
    t.check('"Create starting snapshot on main" is offered and recommended', [onBase?.available, onBase?.recommended], [true, true]);
    t.truthy('saying exactly what it does', /on top of "main".*without switching branches/.test(onBase?.result ?? ''), onBase?.result);
    t.truthy('and "Use the current branch instead" too', g.actions.some((a) => a.id === 'use-current-branch' && a.available), g.actions.map((a) => a.id));

    const refused = await h.call<{ started: boolean; reason?: string }>('POST', '/batch/start', { sessionIds: ids, mode: 'unattended', onFailure: 'stop' });
    t.check('a start is refused', refused.started, false);
    t.truthy('before the browser opens', h.chat.opened === 0 && h.chat.sent.length === 0, [h.chat.opened, h.chat.sent.length]);
    t.truthy('pointing at the panel', /Prepare version control for this run/.test(refused.reason ?? ''), refused.reason);

    const choices = Object.fromEntries(g.inputs.map((e) => [e.path, 'include']));
    const took = await h.call<{ ok: boolean; problem?: string; result?: string }>('POST', '/batch/vcs/prepare', { sessionIds: ids, repoDir: g.repoDir, action: 'snapshot-on-base', choices });
    t.check('the snapshot on main is taken', [took.ok, took.problem ?? null], [true, null]);
    t.check('without switching branches: still on the feature branch at the same commit', [h.git('branch', '--show-current'), h.git('rev-parse', 'HEAD')], ['feature/operator-work', featureHead]);
    t.check('the input files still untracked where they were', h.git('status', '--porcelain', '--untracked-files=all').split('\n').sort(), ['?? rules-engine/test-data/schemas/a.yaml', '?? rules-engine/test-data/schemas/b.yaml']);
    const s1 = await h.call<View>('GET', `/sessions/${first!.id}`);
    const baseline = s1.vcsBaseCommit!;
    t.check('the snapshot sits on main', h.git('rev-parse', `${baseline}^`), mainHead);
    t.check('and adds the approved inputs only', h.git('diff', '--name-only', mainHead, baseline).split('\n').sort(), ['rules-engine/test-data/schemas/a.yaml', 'rules-engine/test-data/schemas/b.yaml']);
    t.check('the panel is ready now', (await h.call<Group[]>('GET', `/batch/vcs?ids=${ids.join(',')}`))[0]!.ready, true);

    h.chat.script(
      reply.steps("Set-Content -Path one.txt -Value 'one' -Encoding utf8"), reply.done(),
      reply.steps("Set-Content -Path two.txt -Value 'two' -Encoding utf8"), reply.done(),
    );
    const started = await h.call<{ started: boolean; reason?: string }>('POST', '/batch/start', { sessionIds: ids, mode: 'unattended', onFailure: 'stop' });
    t.check('the run starts', [started.started, started.reason ?? null], [true, null]);
    await h.idle();
    const a = await h.call<View>('GET', `/sessions/${first!.id}`);
    const b = await h.call<View>('GET', `/sessions/${second!.id}`);
    t.check('both done', [a.tasks[0]!.status, b.tasks[0]!.status], ['done', 'done']);
    t.check('the first starts from the snapshot', a.tasks[0]!.vcs?.baseCommit, baseline);
    t.check('the second carries it on', [b.vcsStart?.kind, b.vcsStart?.baseline?.commit], ['previous-session', baseline]);
    t.check('each commit holds only its own work', [(a.tasks[0]!.vcs?.files ?? []).map((f) => f.path), (b.tasks[0]!.vcs?.files ?? []).map((f) => f.path)], [['one.txt'], ['two.txt']]);
    t.check('nothing is left loose', h.git('status', '--porcelain'), '');
    t.check('the feature branch is untouched', h.git('rev-parse', 'feature/operator-work'), featureHead);

    type Exported = { tasks: Array<{ session: { name: string; baseline?: { commit: string; inherited: boolean; targetBaseCommit?: string; onBaseBranch?: boolean; approval?: { approved: boolean; at?: string }; sessions?: Array<{ name: string }>; approvedInputs: Array<{ path: string; sha256: string }> } } }> };
    const one = (await h.call<Exported>('GET', `/export/domain?session=${first!.id}`)).tasks[0]!.session.baseline;
    const two = (await h.call<Exported>('GET', `/export/domain?session=${second!.id}`)).tasks[0]!.session.baseline;
    t.check('the export names the baseline and the target base, made on main', [one?.commit, one?.targetBaseCommit, one?.onBaseBranch, one?.inherited], [baseline, mainHead, true, false]);
    t.check('the approved inputs with their sums', (one?.approvedInputs ?? []).map((f) => [f.path, f.sha256.length]), [['rules-engine/test-data/schemas/a.yaml', 64], ['rules-engine/test-data/schemas/b.yaml', 64]]);
    t.truthy('the approval and the sessions it was approved for', one?.approval?.approved === true && !!one.approval.at && (one.sessions ?? []).map((s) => s.name).includes('first'), one);
    t.check('and that the second inherited it', [two?.commit, two?.inherited], [baseline, true]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- another uncommitted file in the tree ---');
{
  const h = await startHarness({});
  try {
    setUp(h);
    writeFileSync(join(h.repo, 'notes.md'), 'the operator\'s own\n');
    const [first, second] = await h.importPlan(plan(h));
    const ids = [first!.id, second!.id];
    const g = (await h.call<Group[]>('GET', `/batch/vcs?ids=${ids.join(',')}`))[0]!;
    t.check('it is listed apart from the inputs', g.unrelated.map((u) => u.path), ['notes.md']);
    const onBase = g.actions.find((a) => a.id === 'snapshot-on-base');
    t.truthy('the snapshot on main is not offered, and says why', onBase?.available === false && /other uncommitted changes \(notes\.md\)/.test(onBase.why ?? ''), onBase);
    const used = await h.call<{ ok: boolean; result?: string }>('POST', '/batch/vcs/prepare', { sessionIds: ids, repoDir: g.repoDir, action: 'use-current-branch', choices: {} });
    t.check('"Use the current branch instead" changes where they start', [used.ok, (await h.call<View>('GET', `/sessions/${first!.id}`)).vcs?.startFrom], [true, 'head']);
    t.check('and nothing else: no commit, no branch, the files as they were', [h.git('for-each-ref', '--format=%(refname:short)', 'refs/heads/cop/'), existsSync(join(h.repo, 'notes.md'))], ['', true]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

t.finish();
