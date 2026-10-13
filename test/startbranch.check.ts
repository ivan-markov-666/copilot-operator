/**
 * The start window (2026-10-13): where the work starts, chosen every time a run is started, and a start
 * that did not happen, said with the files that show why.
 *
 * Against real repositories in a temp folder — a bare "server" repository, a clone of it as the
 * operator's project, and a second clone standing in for a colleague who pushes — and, for the API, the
 * real server with the scripted chat:
 *
 *   - the window is offered the branches as they are here, local and as last fetched, and starts each
 *     session on its own setting made into a choice; a session that has started keeps its start;
 *   - "local" starts from the local branch as it is: nothing fetched, nothing moved;
 *   - "remote" starts from the remote-tracking branch as fetched — not from the local branch of that name,
 *     which is neither read nor moved — and a branch only the server has is fetched by name first;
 *   - "work on it itself" from a remote branch makes the local branch from it, or brings it up to it
 *     (fast-forward only), and refuses a local branch that went its own way, with nothing changed; every
 *     choice of a run is checked before any branch moves;
 *   - the fetch asks for an SSH key's passphrase through the password window, never through the bot;
 *   - a start refused for its branch says so, where it stopped, and offers a file with the error, the
 *     run's record and the console lines of those moments; a run accepted and then unable to open the
 *     browser is recorded as unanswered, for every page to show; the console is offered as a file.
 *
 *   npm run check:startbranch
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore } from '../src/session/store.js';
import { EventBus } from '../src/session/events.js';
import type { Session, VersionControl } from '../src/session/model.js';
import { applyStartChoice, defaultChoice, fetchForStart, repoBranches, startOptions, withChoice, type StartChoice } from '../src/vcs/startChoice.js';
import { describeStart, prepareForTask, sessionStart } from '../src/vcs/taskVcs.js';
import { runVcsPreflight } from '../src/vcs/runPreflight.js';
import { captureTerminal, terminalLines, terminalLogFile } from '../src/log/terminal.js';
import { setTransportFactory, type ChatTransport } from '../src/transport/chatTransport.js';
import { startHarness, Tally, waitFor } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
const base = await mkdtemp(join(tmpdir(), 'cop-startbranch-'));
const g = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const ident = (dir: string): void => {
  g(dir, 'config', 'user.email', 'check@example.invalid');
  g(dir, 'config', 'user.name', 'check');
  g(dir, 'config', 'core.autocrlf', 'false');
};
const commitFile = (dir: string, file: string, text: string, msg: string): string => {
  writeFileSync(join(dir, file), text);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', msg);
  return g(dir, 'rev-parse', 'HEAD');
};
const FEATURE = 'feature/casw-2312-add-okta-validation-tests';

/** A server, the operator's clone of it, and a colleague's clone that pushes to it. */
function world(name: string): { server: string; repo: string; mate: string } {
  const server = join(base, `${name}-server.git`);
  const repo = join(base, `${name}-repo`);
  const mate = join(base, `${name}-mate`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', server]);
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', server, mate]);
  ident(mate);
  g(mate, 'checkout', '-q', '-b', 'main');
  commitFile(mate, 'README.md', '# app\n', 'initial');
  g(mate, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', server, repo]);
  ident(repo);
  return { server, repo, mate };
}

const data = join(base, 'data');
const store = new SessionStore(data, join(process.cwd(), 'prompts', 'level1.md'));
await store.init();
const bus = new EventBus();
const all = (): Promise<Session[]> => store.listSessions();

async function session(name: string, repo: string, vcs: Partial<VersionControl> = {}): Promise<Session> {
  const s = await store.createSession(name);
  await store.updateSession(s.id, (x) => {
    x.vcs = { enabled: true, repoDir: repo, branchMode: 'per-task', commitOnFinish: true, branchPrefix: 'cop/', ...vcs };
  });
  await store.addTask(s.id, { title: `${name} task`, level2: '', prompt: 'p' });
  return (await store.getSession(s.id)) as Session;
}

/** What the run would do with a choice: written as the service writes it. */
async function choose(s: Session, choice: StartChoice): Promise<{ ok: boolean; problem?: string; note?: string; cleared?: boolean; vcs?: VersionControl; restart?: { freshBranch?: string } }> {
  const done = await applyStartChoice(s, choice);
  if (!done.ok) return { ok: false, problem: done.problem };
  if (!done.applied) return { ok: true };
  const applied = done.applied;
  const after = await store.updateSession(s.id, (x) => {
    if (!x.vcs) return;
    x.vcs = withChoice(x.vcs, applied.vcs);
    if (applied.clearStart) {
      x.vcsBaseCommit = undefined;
      x.vcsStart = undefined;
    }
    // As the service writes it: see `applyStartChoices`.
    if (applied.restart) {
      x.startRechosenAt = new Date().toISOString();
      if (applied.restart.freshBranch) {
        x.vcs.branchName = applied.restart.freshBranch;
        x.vcs.branchNameExact = true;
      }
    }
  });
  return { ok: true, note: applied.note, cleared: applied.clearStart, vcs: after.vcs, ...(applied.restart ? { restart: applied.restart } : {}) };
}

/** The session's one task as it would be after it ran and failed, attempt archived, queued again by "Fix the prompt". */
async function ranAndRequeued(s: Session, base: string, branch: string): Promise<Session> {
  const ranAt = new Date(Date.now() - 60_000).toISOString();
  await store.updateSession(s.id, (x) => {
    x.vcsBaseCommit = base;
    x.vcsStart = x.vcs?.startFrom === 'existing-branch' ? { kind: 'existing-branch', commit: base, branch } : { kind: 'branch', commit: base, branch: 'main' };
    const t = x.tasks[0]!;
    t.status = 'failed';
    t.reason = 'the review found the work incomplete';
    t.startedAt = ranAt;
    t.finishedAt = ranAt;
    t.vcs = { branch, baseCommit: base };
  });
  await store.rerunTask(s.id, (await store.getSession(s.id))!.tasks[0]!.id, { prompt: 'Fixed prompt: do the work properly.' });
  return (await store.getSession(s.id)) as Session;
}

try {
  console.log('--- what the window is offered ---');
  {
    const w = world('offer');
    // The colleague moves main on and pushes a feature branch; the operator's clone has not fetched yet.
    const mateMain = commitFile(w.mate, 'server-only.txt', 'from the server\n', 'server work on main');
    g(w.mate, 'push', '-q', 'origin', 'main');
    g(w.mate, 'checkout', '-q', '-b', FEATURE);
    commitFile(w.mate, 'okta.spec.ts', 'test("okta")\n', 'okta tests');
    g(w.mate, 'push', '-q', 'origin', FEATURE);

    const before = await repoBranches(w.repo);
    t.check('the branches as they are here: local main, and origin as last fetched (main only, old)', [before.current, before.local.map((b) => b.name), before.remotes.map((r) => [r.name, r.branches.map((b) => b.name)])], ['main', ['main'], [['origin', ['main']]]]);
    const fetched = await fetchForStart(w.repo, 'origin', null, null);
    t.check('getting the list fetches the whole remote, and nothing local moves', [fetched.ok, fetched.repo?.remotes[0]?.branches.map((b) => b.name).sort(), g(w.repo, 'rev-parse', 'main') === mateMain], [true, [FEATURE, 'main'].sort(), false]);
    t.truthy('and says when it was last fetched', !!fetched.repo?.lastFetched);

    const fresh = await session('fresh', w.repo);
    t.check('a session that never chose is offered its local branch', defaultChoice(fresh, fetched.repo!), { from: 'local', branch: 'main' });
    const named = await session('named', w.repo, { startFrom: 'branch', baseBranch: FEATURE });
    t.check('a branch only the server has is offered from the remote', defaultChoice(named, fetched.repo!), { from: 'remote', remote: 'origin', branch: FEATURE });
    const unfetched = await session('unfetched', w.repo, { startFrom: 'existing-branch', existingBranch: 'feature/pushed-after-the-fetch' });
    t.check('a branch the session names that is not fetched yet is still offered, from the remote, as it was set', defaultChoice(unfetched, fetched.repo!), { from: 'remote', remote: 'origin', branch: 'feature/pushed-after-the-fetch', onBranch: true });
    const remoteBefore = await session('remote-before', w.repo, { startFrom: 'branch', baseBranch: 'main', baseRemote: 'origin' });
    t.check('a remote branch chosen last time is offered again', defaultChoice(remoteBefore, fetched.repo!), { from: 'remote', remote: 'origin', branch: 'main' });
    const onIt = await session('on-it', w.repo, { startFrom: 'existing-branch', existingBranch: 'main' });
    t.check('carrying on a branch is offered as working on it itself', defaultChoice(onIt, fetched.repo!), { from: 'local', branch: 'main', onBranch: true });
    const chain = await session('chain', w.repo, { startFrom: 'previous-session' });
    t.check('a chain is offered as one', defaultChoice(chain, fetched.repo!), { from: 'previous-session' });

    const off = await store.createSession('no-vcs');
    const offered = await startOptions([fresh, chain, (await store.getSession(off.id)) as Session]);
    t.check('per session: version control on or off; the chain offered "the session before it"; one repository listed once', [offered.sessions.map((s) => [s.vcs, s.previousOffered]), offered.repos.length], [[[true, false], [true, true], [false, false]], 1]);

    // A session whose task has run keeps its start.
    const started = await session('started', w.repo, { startFrom: 'branch', baseBranch: 'main' });
    await store.updateSession(started.id, (x) => {
      x.vcsBaseCommit = g(w.repo, 'rev-parse', 'main');
      x.vcsStart = { kind: 'branch', commit: x.vcsBaseCommit, branch: 'main' };
      x.tasks[0]!.startedAt = new Date().toISOString();
    });
    const startedNow = (await store.getSession(started.id)) as Session;
    const fixed = await startOptions([startedNow]);
    // Kept first; another start is offered beside it since the operator's report of 2026-10-13 (see below).
    t.check('a session that has run is shown its start, with another one offered beside it', [!!fixed.sessions[0]?.fixed, fixed.sessions[0]?.choice ?? null, fixed.sessions[0]?.started?.branch], [true, { from: 'local', branch: 'main' }, 'main']);
    t.check('and a choice sent for it anyway changes nothing', await applyStartChoice(startedNow, { from: 'remote', remote: 'origin', branch: FEATURE }), { ok: true });

    // A start prepared before the run (a snapshot approved on the run panel), no task run yet.
    const prepared = await session('prepared-offer', w.repo);
    await store.updateSession(prepared.id, (x) => {
      x.vcsBaseCommit = g(w.repo, 'rev-parse', 'main');
      x.vcsStart = { kind: 'snapshot', commit: x.vcsBaseCommit, branch: 'cop/baseline/p' };
    });
    const prep = await startOptions([(await store.getSession(prepared.id)) as Session]);
    t.check('a start prepared before the run is named, and a choice is still offered beside it', [!!prep.sessions[0]?.prepared, !!prep.sessions[0]?.choice, prep.sessions[0]?.fixed ?? null], [true, true, null]);
  }

  console.log('\n--- local, remote, and the branch itself ---');
  {
    const w = world('choose');
    const oldMain = g(w.repo, 'rev-parse', 'main');
    const serverMain = commitFile(w.mate, 'server-only.txt', 'from the server\n', 'server work on main');
    g(w.mate, 'push', '-q', 'origin', 'main');
    g(w.mate, 'checkout', '-q', '-b', FEATURE);
    const featureTip = commitFile(w.mate, 'okta.spec.ts', 'test("okta")\n', 'okta tests');
    g(w.mate, 'push', '-q', 'origin', FEATURE);

    // Local: as it is here.
    const local = await session('local', w.repo, { updateFromRemote: true });
    const l = await choose(local, { from: 'local', branch: 'main' });
    t.check('local main: start from the branch, nothing fetched', [l.ok, l.vcs?.startFrom, l.vcs?.baseBranch, l.vcs?.baseRemote ?? null, l.vcs?.updateFromRemote], [true, 'branch', 'main', null, false]);
    const ls = await sessionStart((await store.getSession(local.id)) as Session, w.repo, oldMain, all);
    t.check('it starts at the local tip, and the local branch is not brought up to the server', ['start' in ls ? ls.start?.commit : ls, g(w.repo, 'rev-parse', 'main')], [oldMain, oldMain]);
    t.check('a local branch that is not here is refused', (await applyStartChoice(local, { from: 'local', branch: 'nope' })).ok, false);

    // Remote: a branch only the server has, not fetched yet.
    const remote = await session('remote', w.repo);
    const notYet = await applyStartChoice(remote, { from: 'remote', remote: 'origin', branch: FEATURE });
    t.truthy('a remote branch not fetched yet is refused, saying it was not fetched', !notYet.ok && /not fetched/.test(notYet.problem), notYet);
    const f = await fetchForStart(w.repo, 'origin', [FEATURE, 'main'], null);
    t.check('fetching those two by name: both remote-tracking branches, no local branch made', [f.ok, g(w.repo, 'rev-parse', `origin/${FEATURE}`), g(w.repo, 'rev-parse', 'origin/main'), g(w.repo, 'branch', '--list', FEATURE)], [true, featureTip, serverMain, '']);
    const missing = await fetchForStart(w.repo, 'origin', ['no/such-branch'], null);
    t.check('a name the server does not have: not fetched, and named', [missing.ok, missing.missing], [false, ['no/such-branch']]);
    t.check('a remote that is not there is refused before anything runs', [(await fetchForStart(w.repo, 'upstream', null, null)).ok, !!(await fetchForStart(w.repo, 'upstream', null, null)).problem], [false, true]);

    const r = await choose(remote, { from: 'remote', remote: 'origin', branch: FEATURE });
    t.check('remote feature branch: start from the branch, with its remote', [r.ok, r.vcs?.startFrom, r.vcs?.baseBranch, r.vcs?.baseRemote], [true, 'branch', FEATURE, 'origin']);
    const remoteNow = (await store.getSession(remote.id)) as Session;
    const rs = await sessionStart(remoteNow, w.repo, oldMain, all);
    const start = 'start' in rs ? rs.start : undefined;
    t.check('it starts at the remote tip, named as the remote branch', [start?.kind, start?.commit, start?.branch, start?.remote], ['branch', featureTip, `origin/${FEATURE}`, 'origin']);
    t.truthy('and says so', /remote branch origin\/feature/.test(start ? describeStart(start) : ''), start ? describeStart(start) : rs);
    const prepared = await prepareForTask(remoteNow, remoteNow.tasks[0]!, bus, async (m) => void (await store.updateSession(remote.id, m)), all);
    if (!prepared.vcs.branch) console.log('   (problem: ' + (prepared.vcs.problem ?? prepared.refuse ?? '') + ')');
    t.check('the task is cut from it: its files are there, the local main is untouched', [!!prepared.vcs.branch, prepared.vcs.baseCommit, existsSync(join(w.repo, 'okta.spec.ts')), g(w.repo, 'rev-parse', 'main')], [true, featureTip, true, oldMain]);
    t.truthy('and the chat is told it is the server\'s code', /remote branch `origin\/feature/.test(prepared.note), prepared.note.slice(0, 400));
    g(w.repo, 'checkout', '-q', 'main');

    // The preflight reads the remote-tracking branch for a remote start.
    const pre = await session('pre', w.repo, { startFrom: 'branch', baseBranch: FEATURE, baseRemote: 'origin' });
    const [group] = await runVcsPreflight([pre], all);
    if (!group?.ready) console.log('   (problem: ' + (group?.problem ?? '') + ')');
    t.check('the run check reads the remote-tracking branch, by its remote name', [group?.ready, group?.baseBranch, group?.baseHead], [true, `origin/${FEATURE}`, featureTip]);
    const gone = await session('gone', w.repo, { startFrom: 'branch', baseBranch: 'never/fetched', baseRemote: 'origin' });
    const [goneGroup] = await runVcsPreflight([gone], all);
    t.truthy('a remote branch never fetched stops the run before the browser, saying to choose it in the start window', !goneGroup?.ready && /start window/.test(goneGroup?.problem ?? ''), goneGroup?.problem);
    t.check('and the start window can settle it, so the run buttons that open it stay on', goneGroup?.startChoiceCanFix, true);
    writeFileSync(join(w.repo, 'loose.txt'), 'uncommitted\n');
    const [dirtyGroup] = await runVcsPreflight([gone], all);
    t.check('not when something else is in the way too (uncommitted changes)', [dirtyGroup?.ready, dirtyGroup?.startChoiceCanFix ?? false], [false, false]);
    await rm(join(w.repo, 'loose.txt'));

    // The branch itself, from the remote.
    const own = await session('own', w.repo);
    // A tag that reads like the remote branch: git's short-name lookup would take it first.
    g(w.repo, 'tag', `origin/${FEATURE}`, oldMain);
    const dry = await applyStartChoice(own, { from: 'remote', remote: 'origin', branch: FEATURE, onBranch: true }, { dry: true });
    t.check('checked first with nothing moved: no local branch made yet', [dry.ok, g(w.repo, 'branch', '--list', FEATURE)], [true, '']);
    const o = await choose(own, { from: 'remote', remote: 'origin', branch: FEATURE, onBranch: true });
    t.check('working on it: the local branch is made from the remote one, and the session carries it on', [o.ok, g(w.repo, 'rev-parse', FEATURE), o.vcs?.startFrom, o.vcs?.existingBranch, o.vcs?.baseRemote], [true, featureTip, 'existing-branch', FEATURE, 'origin']);
    t.truthy('and it says it made it', /made the local branch/.test(o.note ?? ''), o.note);
    t.check('from the remote branch itself, not a tag that reads like it', g(w.repo, 'rev-parse', FEATURE) === featureTip, true);
    g(w.repo, 'tag', '-d', `origin/${FEATURE}`);
    const newer = commitFile(w.mate, 'okta2.spec.ts', 'test("okta 2")\n', 'more okta tests');
    g(w.mate, 'push', '-q', 'origin', FEATURE);
    await fetchForStart(w.repo, 'origin', [FEATURE], null);
    const again = await choose((await store.getSession(own.id)) as Session, { from: 'remote', remote: 'origin', branch: FEATURE, onBranch: true });
    t.check('the next time: the local branch is brought up to the server, fast-forward', [again.ok, g(w.repo, 'rev-parse', FEATURE)], [true, newer]);
    // Diverged: a local commit, and another one on the server.
    g(w.repo, 'checkout', '-q', FEATURE);
    const mine = commitFile(w.repo, 'mine.txt', 'mine\n', 'local work');
    g(w.repo, 'checkout', '-q', 'main');
    commitFile(w.mate, 'theirs.txt', 'theirs\n', 'server work');
    g(w.mate, 'push', '-q', 'origin', FEATURE);
    await fetchForStart(w.repo, 'origin', [FEATURE], null);
    const diverged = await applyStartChoice((await store.getSession(own.id)) as Session, { from: 'remote', remote: 'origin', branch: FEATURE, onBranch: true });
    t.check('a local branch that went its own way is refused, and left as it was', [diverged.ok, g(w.repo, 'rev-parse', FEATURE)], [false, mine]);
    t.truthy('saying what to do instead', !diverged.ok && /new branch instead/.test(diverged.problem), diverged);

    // A start prepared before the run goes only when the choice moves the start.
    const prep = await session('prepared', w.repo, { startFrom: 'branch', baseBranch: 'main' });
    await store.updateSession(prep.id, (x) => {
      x.vcsBaseCommit = oldMain;
      x.vcsStart = { kind: 'snapshot', commit: oldMain, branch: 'cop/baseline/x' };
    });
    const same = await choose((await store.getSession(prep.id)) as Session, { from: 'local', branch: 'main' });
    t.check('the same branch keeps the starting snapshot prepared before the run', [same.cleared, ((await store.getSession(prep.id)) as Session).vcsBaseCommit], [false, oldMain]);
    const moved = await choose((await store.getSession(prep.id)) as Session, { from: 'remote', remote: 'origin', branch: 'main' });
    t.check('another branch drops it', [moved.cleared, ((await store.getSession(prep.id)) as Session).vcsBaseCommit ?? null], [true, null]);
  }

  /*
   * The operator's report of 2026-10-13: a session that ran on one branch, the team moved on to another
   * (checked out, clean, in step with the remote), the failed task's prompt fixed and run again — and the
   * start window offered only the session's old branch and commit, a re-run going back to them whatever
   * was chosen. Now the window says where things stand and lets another start be chosen, and a re-run
   * starts from it.
   */
  console.log('\n--- a session that has run: another start chosen for it ---');
  {
    const w = world('again');
    const oldMain = g(w.repo, 'rev-parse', 'main');
    g(w.repo, 'branch', 'feature/CASC-277-Rules-Engine-Tiff-Splitting');
    g(w.repo, 'checkout', '-q', '-b', 'feature/casc-277-schema-v2-tiff-splitting');
    const newTip = commitFile(w.repo, 'schema-v2.txt', 'v2\n', 'schema v2');

    // Carrying on an existing branch, as the report's session did.
    const onIt = await ranAndRequeued(
      await session('existing', w.repo, { startFrom: 'existing-branch', existingBranch: 'feature/CASC-277-Rules-Engine-Tiff-Splitting' }),
      oldMain,
      'feature/CASC-277-Rules-Engine-Tiff-Splitting',
    );
    const offered = (await startOptions([onIt])).sessions[0]!;
    t.check('the window says it has run, on which branch, where that is now, and where it started', [!!offered.fixed, offered.started?.mode, offered.started?.branch, offered.started?.tipNow, offered.started?.recorded, offered.rechooseBlocked ?? null], [true, 'existing-branch', 'feature/CASC-277-Rules-Engine-Tiff-Splitting', oldMain, oldMain, null]);
    t.check('and the repository is on another branch, which the window can offer', (await repoBranches(w.repo)).current, 'feature/casc-277-schema-v2-tiff-splitting');
    t.check('a choice sent without "chosen again" changes nothing, as before', await applyStartChoice(onIt, { from: 'local', branch: 'feature/casc-277-schema-v2-tiff-splitting', onBranch: true }), { ok: true });
    const moved = await choose(onIt, { from: 'local', branch: 'feature/casc-277-schema-v2-tiff-splitting', onBranch: true, rechoose: true });
    t.check('chosen again: it carries on the branch checked out now, its recorded start cleared', [moved.ok, moved.vcs?.existingBranch, moved.cleared, moved.restart?.freshBranch ?? null], [true, 'feature/casc-277-schema-v2-tiff-splitting', true, null]);
    const again = (await store.getSession(onIt.id)) as Session;
    const prepared = await prepareForTask(again, again.tasks[0]!, bus, async (m) => void (await store.updateSession(onIt.id, m)), all);
    t.check('the re-run goes on that branch, at its tip — not the old branch and commit', [prepared.vcs.branch, g(w.repo, 'rev-parse', 'HEAD'), ((await store.getSession(onIt.id)) as Session).vcsStart?.branch], ['feature/casc-277-schema-v2-tiff-splitting', newTip, 'feature/casc-277-schema-v2-tiff-splitting']);

    // A branch of the bot's own per task: the re-run used to be cut from where the task first started.
    g(w.repo, 'checkout', '-q', 'feature/casc-277-schema-v2-tiff-splitting');
    const perTask = await ranAndRequeued(await session('per-task', w.repo, { startFrom: 'branch', baseBranch: 'main' }), oldMain, 'cop/per-task/old');
    const rechosen = await choose(perTask, { from: 'local', branch: 'feature/casc-277-schema-v2-tiff-splitting', rechoose: true });
    t.check('per task, chosen again: it starts from the branch chosen now', [rechosen.ok, rechosen.vcs?.startFrom, rechosen.vcs?.baseBranch], [true, 'branch', 'feature/casc-277-schema-v2-tiff-splitting']);
    const pt = (await store.getSession(perTask.id)) as Session;
    const ptPrepared = await prepareForTask(pt, pt.tasks[0]!, bus, async (m) => void (await store.updateSession(perTask.id, m)), all);
    t.check('the re-run is cut from the new start, not from where the task first started', [ptPrepared.vcs.baseCommit, existsSync(join(w.repo, 'schema-v2.txt'))], [newTip, true]);
    g(w.repo, 'checkout', '-q', 'feature/casc-277-schema-v2-tiff-splitting');

    // One branch for the whole session: it goes on under a new name, the old one keeping its work.
    g(w.repo, 'branch', 'cop/one-line', oldMain);
    const perSession = await ranAndRequeued(await session('per-session', w.repo, { startFrom: 'branch', baseBranch: 'main', branchMode: 'per-session', branchName: 'cop/one-line', branchNameExact: true }), oldMain, 'cop/one-line');
    const fresh = await choose(perSession, { from: 'local', branch: 'feature/casc-277-schema-v2-tiff-splitting', rechoose: true });
    t.check('per session, chosen again: a new branch name for the line, the old branch kept', [fresh.ok, fresh.restart?.freshBranch, fresh.vcs?.branchName, g(w.repo, 'rev-parse', 'cop/one-line')], [true, 'cop/one-line-2', 'cop/one-line-2', oldMain]);
    const ps = (await store.getSession(perSession.id)) as Session;
    const psPrepared = await prepareForTask(ps, ps.tasks[0]!, bus, async (m) => void (await store.updateSession(perSession.id, m)), all);
    t.check('and the re-run goes on it, cut from the new start', [psPrepared.vcs.branch, psPrepared.vcs.baseCommit], ['cop/one-line-2', newTip]);
    g(w.repo, 'checkout', '-q', 'feature/casc-277-schema-v2-tiff-splitting');

    // A task that carries an earlier attempt on stays where that attempt is.
    const carrying = await ranAndRequeued(await session('carrying', w.repo, { startFrom: 'branch', baseBranch: 'main' }), oldMain, 'cop/carrying/old');
    await store.updateSession(carrying.id, (x) => {
      x.tasks[0]!.continuing = { fromAttempt: 1, how: 'failed', instruction: 'go on' };
    });
    const c = (await store.getSession(carrying.id)) as Session;
    t.truthy('a session whose queued task carries an earlier attempt on keeps its start, and the window says why', !!(await startOptions([c])).sessions[0]?.rechooseBlocked);
    const refusedAgain = await applyStartChoice(c, { from: 'local', branch: 'main', rechoose: true });
    t.truthy('and choosing again is refused, naming the way that does work', !refusedAgain.ok && /Fix the prompt/.test(refusedAgain.problem), refusedAgain);
  }

  console.log('\n--- the passphrase goes through the password window ---');
  {
    const w = world('pass');
    const sh = (p: string): string => p.replace(/\\/g, '/');
    const fakeSsh = join(base, 'fake-ssh.sh');
    writeFileSync(fakeSsh, [
      '#!/bin/sh',
      'answer=$("$SSH_ASKPASS" "Enter passphrase for key \'id_ed25519\':" 2>/dev/null)',
      'if [ "$answer" != "pa ss!" ]; then echo "git@fake: Permission denied (publickey)." >&2; exit 255; fi',
      'for last; do :; done',
      'exec sh -c "git ${last#git-}"',
      '',
    ].join('\n'));
    const askpass = (answer: string, name: string): string => {
      const path = join(base, name);
      writeFileSync(path, `#!/bin/sh\necho "$1" >> '${sh(join(base, 'asked.txt'))}'\necho '${answer}'\n`);
      return path;
    };
    g(w.repo, 'config', 'core.sshCommand', sh(fakeSsh));
    g(w.repo, 'remote', 'set-url', 'origin', `ssh://git@fake/${sh(w.server).replace(/^([A-Za-z]):/, (_m, d: string) => d.toLowerCase())}`);
    g(w.mate, 'checkout', '-q', '-b', FEATURE);
    const tip = commitFile(w.mate, 'okta.spec.ts', 'x\n', 'okta');
    g(w.mate, 'push', '-q', 'origin', FEATURE);

    const right = await fetchForStart(w.repo, 'origin', [FEATURE], askpass('pa ss!', 'right.sh'));
    t.check('with the window answering, the branch is fetched', [right.ok, right.fetched?.asked, g(w.repo, 'rev-parse', `origin/${FEATURE}`)], [true, true, tip]);
    t.truthy('the passphrase was asked for through the window', readFileSync(join(base, 'asked.txt'), 'utf8').includes('Enter passphrase'));
    t.truthy('and is in nothing the bot got back', !JSON.stringify(right).includes('pa ss!'));
    const wrong = await fetchForStart(w.repo, 'origin', [FEATURE], askpass('nope', 'wrong.sh'));
    t.check('a wrong passphrase: not fetched, said to be about the key, with the command for the operator\'s own PowerShell', [wrong.ok, wrong.fetched?.auth, /fetch --prune 'origin'$/.test(wrong.fetchCommand ?? '')], [false, true, true]);
    t.truthy('and when it last fetched', !!wrong.lastFetched);
  }

  console.log('\n--- the console, kept ---');
  {
    const logs = join(base, 'logs');
    captureTerminal(logs);
    process.stdout.write('\x1b[31mcop-check red line\x1b[0m\n');
    process.stderr.write('cop-check error line\n');
    const lines = terminalLines({ max: 50 }).map((l) => [l.stream, l.text]);
    t.truthy('a console line is kept, colour codes taken out', lines.some(([s, x]) => s === 'out' && x === 'cop-check red line'), lines.slice(-5));
    t.truthy('stderr too', lines.some(([s, x]) => s === 'err' && x === 'cop-check error line'));
    t.truthy('and written to logs\\terminal.log', !!terminalLogFile() && readFileSync(terminalLogFile()!, 'utf8').includes('cop-check error line'));
  }
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
}

console.log('\n--- through the API: a start from a remote branch, a start refused, a browser that would not open ---');
{
  const h = await startHarness({ settings: { execution: { mode: 'unattended', isolation: 'none-accepted' } } });
  try {
    const server = join(h.base, 'server.git');
    execFileSync('git', ['clone', '-q', '--bare', h.repo, server]);
    h.git('remote', 'add', 'origin', server);
    h.git('fetch', '-q', 'origin');
    const mate = join(h.base, 'mate');
    execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', server, mate]);
    ident(mate);
    g(mate, 'checkout', '-q', '-b', FEATURE);
    const featureTip = commitFile(mate, 'okta.spec.ts', 'test("okta")\n', 'okta tests');
    g(mate, 'push', '-q', 'origin', FEATURE);

    const [s] = await h.importPlan({
      version: 1,
      sessions: [{ name: 'okta', onFailure: 'stop', vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', startFrom: 'branch', baseBranch: 'main' }, review: { enabled: false }, tasks: [{ title: 'one', prompt: 'Create the file one.txt in the project folder, holding exactly the word one.' }] }],
    });

    type Options = { repos: Array<{ remotes: Array<{ branches: Array<{ name: string }> }> }>; sessions: Array<{ id: string; choice?: unknown }> };
    const opts = await h.call<Options>('GET', `/start/options?sessions=${s!.id}`);
    t.check('the window is offered the session on its own setting', opts.sessions[0]?.choice, { from: 'local', branch: 'main' });
    type Fetch = { ok: boolean; repo?: { remotes: Array<{ branches: Array<{ name: string }> }> } };
    const listed = await h.call<Fetch>('POST', '/start/fetch', { dir: h.repo, remote: 'origin' });
    t.check('"Get the list of branches from the remote" brings the colleague\'s branch', [listed.ok, listed.repo?.remotes[0]?.branches.map((b) => b.name).includes(FEATURE)], [true, true]);
    const outside = await h.raw('POST', '/start/fetch', { dir: h.base, remote: 'origin' });
    t.check('a folder the bot does not work in is not fetched from here', outside.status, 400);

    type Reply = { started: boolean; reason?: string; failure?: { id: string; stage: string; answered: boolean; message: string } };
    const refused = await h.call<Reply>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended', starts: { [s!.id]: { from: 'local', branch: 'no/such-branch' } } });
    t.check('a branch that is not here: not started, stopped at the branch, answered', [refused.started, refused.failure?.stage, refused.failure?.answered], [false, 'branch', true]);
    t.check('nothing opened', h.chat.opened, 0);
    const report = await h.raw('GET', `/start/failures/${refused.failure?.id}/report`);
    const text = String(report.body);
    t.check('its file downloads as text', [report.status, /What went wrong:/.test(text), text.includes('no/such-branch')], [200, true, true]);
    t.truthy('with where it stopped and the console lines of those moments', /Where it stopped:\s+the branch chosen/.test(text) || /Where it stopped:\s+choosing the branch/.test(text), text.slice(0, 600));
    t.truthy('the console showed the refusal, and the file has it', /\[start\] the work did not start \(branch/.test(text), text.slice(-1500));
    t.check('and it is not shown on every page: the press was answered', (await h.call<unknown[]>('GET', '/start/failures?unanswered=1')).length, 0);

    // Refused whatever the branch (nothing queued): the choice moves nothing, no local branch is made.
    const empty = await h.call<{ id: string }>('POST', '/sessions', { name: 'empty', projectDir: h.repo });
    await h.call('PUT', `/sessions/${empty.id}`, { vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', commitOnFinish: true, branchPrefix: 'cop/' } });
    const nothing = await h.call<Reply>('POST', `/sessions/${empty.id}/start`, { mode: 'unattended', starts: { [empty.id]: { from: 'remote', remote: 'origin', branch: FEATURE, onBranch: true } } });
    t.check('a start refused whatever the branch is refused before the choice moves anything', [nothing.started, nothing.failure?.stage, h.git('branch', '--list', FEATURE), (await h.session(empty.id)).vcs?.startFrom ?? null], [false, 'refused', '', null]);

    h.chat.script(reply.steps("Set-Content -Path one.txt -Value 'one' -Encoding utf8"), reply.done());
    const started = await h.call<Reply>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended', starts: { [s!.id]: { from: 'remote', remote: 'origin', branch: FEATURE } } });
    t.check('from the remote feature branch: started', started.started, true);
    await h.idle();
    const after = await h.session(s!.id);
    t.check('the task ran on a branch cut from the server\'s feature branch, and the session says where it started', [after.tasks[0]?.status, after.tasks[0]?.vcs?.baseCommit, after.vcsStart?.kind, after.vcsStart?.branch], ['done', featureTip, 'branch', `origin/${FEATURE}`]);
    t.check('no local feature branch was made', h.git('branch', '--list', FEATURE), '');
    const runId = (after.tasks[0] as { runId?: string }).runId ?? '';
    const runs = existsSync(join(h.runsDir, '_runs')) ? readdirSync(join(h.runsDir, '_runs')) : [];
    const chosen = runs.some((id) => {
      const p = join(h.runsDir, '_runs', id, 'run.jsonl');
      return existsSync(p) && readFileSync(p, 'utf8').includes('"start-chosen"');
    });
    t.truthy('the run\'s record says where it was chosen to start', chosen, [runId, runs]);

    // A browser that will not open: accepted, then failed — on every page until closed.
    setTransportFactory(() => ({
      open: async () => {
        throw new Error('browserType.launchPersistentContext: the profile is in use by another Edge (check)');
      },
      close: async () => undefined,
    }) as unknown as ChatTransport);
    await h.call('POST', `/sessions/${s!.id}/tasks`, { title: 'two', level2: '', prompt: 'Create the file two.txt in the project folder, holding exactly the word two.' });
    const batch = await h.call<Reply>('POST', '/batch/start', { sessionIds: [s!.id], mode: 'unattended', starts: { [s!.id]: { from: 'local', branch: 'main' } } });
    t.check('the run is accepted', batch.started, true);
    await h.idle();
    const unanswered = await waitFor('the failure to be recorded', async () => {
      const l = await h.call<Array<{ id: string; stage: string; message: string; answered: boolean }>>('GET', '/start/failures?unanswered=1');
      return l.length > 0 ? l : undefined;
    }, 15_000);
    t.check('the browser that would not open is recorded, for every page', [unanswered[0]?.stage, unanswered[0]?.answered, /profile is in use/.test(unanswered[0]?.message ?? '')], ['browser', false, true]);
    const browserReport = String((await h.raw('GET', `/start/failures/${unanswered[0]?.id}/report`)).body);
    t.truthy('its file has the run\'s record up to the browser, and the console line', /browser-launch-requested/.test(browserReport) && /\[start\] the browser could not be opened/.test(browserReport), browserReport.slice(0, 1500));

    const term = await h.raw('GET', '/terminal');
    t.check('the console downloads as a text file', [term.status, /what the terminal showed/.test(String(term.body))], [200, true]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
t.finish();
