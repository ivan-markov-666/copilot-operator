/**
 * The operator's own commit and push from the Git view (operator, 2026-11-11: "add committing and pushing; a commit may
 * not go through, and the operator must be able to see why"; and for the project's hooks, "yes, unless a hook was
 * changed"). Against real repositories, a bare one as the remote — no browser, no Copilot:
 *
 * - files staged and unstaged, only ones the view lists;
 * - a commit: of what is staged, or of everything; refused with why (no message, nothing to commit, no name, a lock),
 *   git's and the hooks' own words kept whole;
 * - the project's hooks: run when they are the project's own (in .git, or committed and unchanged, not by the bot),
 *   named with why when not, and then run only as the operator says — skipped, or run and remembered as they are;
 * - a push: to the upstream, published when there is none, nothing to push, refused when the remote moved on, its
 *   pre-push hook run; no remote, no branch;
 * - through the API: one commit or push at a time, and none of the bot's work starts in the folder meanwhile.
 *
 *   npm run check:operator-git
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAsOperator, commitCause, hooksFor, identityOf, pushAsOperator, pushCause, setIdentity, stageFiles, TrustedHooks, type GitOp, type HookChoice } from '../src/vcs/operatorGit.js';
import { workspaceGit } from '../src/session/workspaceGit.js';
import { RUNNER_EMAIL } from '../src/vcs/git.js';
import { startHarness, Tally, waitFor } from './support/harness.js';

const t = new Tally();
const base = mkdtempSync(join(tmpdir(), 'cop-operator-git-'));
const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const who = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const write = (dir: string, file: string, text: string): void => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), text);
};
const commitAs = (dir: string, file: string, text: string, message: string, as = who): void => {
  write(dir, file, text);
  git(dir, 'add', '-A');
  git(dir, ...as, 'commit', '-q', '-m', message);
};
/** Where the hooks of these checks say they ran: one line per hook. */
const marks = join(base, 'hooks-ran.txt');
process.env.COP_TEST_MARK = marks.replace(/\\/g, '/');
const ran = (): string[] => {
  try {
    return execFileSync('cmd', ['/c', 'type', marks], { encoding: 'utf8' }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
};
const clearMarks = (): void => rmSync(marks, { force: true });
const hook = (said: string, exit = 0): string => `#!/bin/sh\necho "${said}" >> "$COP_TEST_MARK"\n${exit ? `echo "${said}: the check failed in a.txt" >&2\nexit ${exit}\n` : ''}`;

/** A working folder with its own name for git, cloned from a bare remote, with a first commit pushed. */
function setUp(name: string): { work: string; remote: string } {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const work = join(root, 'work');
  execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', '--config', 'core.autocrlf=false', remote, work], { stdio: 'ignore' });
  git(work, 'checkout', '-q', '-b', 'main');
  git(work, 'config', 'user.name', 'Operator');
  git(work, 'config', 'user.email', 'operator@example.com');
  commitAs(work, 'a.txt', 'a\n', 'first');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return { work, remote };
}

/** A commit or a push as the service runs one: its record, as the view would read it at the end. */
async function op(kind: GitOp['kind'], run: (update: (p: Partial<GitOp>) => void) => Promise<void>): Promise<GitOp> {
  const o: GitOp = { id: 'x', kind, state: 'running', startedAt: new Date().toISOString(), command: '', output: '', hooks: 'none' };
  await run((p) => Object.assign(o, p));
  return o;
}
const trusted = new TrustedHooks(join(base, 'data', 'trusted-hooks.json'));
const commit = (dir: string, message: string, extra: { all?: boolean } & HookChoice = {}): Promise<GitOp> => op('commit', (u) => commitAsOperator(dir, { message, ...extra }, trusted, u));
const push = (dir: string, extra: HookChoice = {}): Promise<GitOp> => op('push', (u) => pushAsOperator(dir, extra, trusted, u, null));

try {
  console.log('--- why a commit or a push did not go through, from git\'s words ---');
  t.check('a commit', [
    commitCause('*** Please tell me who you are.\n\nRun\n\n  git config --global user.email', false, false),
    commitCause('fatal: no email was given and auto-detection is disabled', false, false),
    commitCause("fatal: Unable to create 'C:/r/.git/index.lock': File exists.", false, false),
    commitCause('error: gpg failed to sign the data\nfatal: failed to write commit object', false, false),
    commitCause('error: Committing is not possible because you have unmerged files.', false, false),
    commitCause('husky - pre-commit script failed (code 1)', true, false),
    commitCause('something else', false, false),
    commitCause('', true, true),
  ], ['identity', 'identity', 'lock', 'signing', 'unmerged', 'hook', 'unknown', 'timeout']);
  t.check('a push', [
    pushCause(' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs', false, false),
    pushCause('hint: Updates were rejected because the tip of your current branch is behind', false, false),
    pushCause('remote: Permission to x/y.git denied to someone.\nfatal: unable to access ...: The requested URL returned error: 403', false, false),
    pushCause('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', false, false),
    pushCause(' ! [remote rejected] main -> main (protected branch hook declined)\nremote: error: GH006: Protected branch update failed', false, false),
    pushCause('fatal: unable to access \'https://x/\': Could not resolve host: x', false, false),
    pushCause('error: failed to push some refs to \'r\'', true, false),
  ], ['behind', 'behind', 'auth', 'auth', 'refused', 'network', 'hook']);

  console.log('\n--- staged and unstaged: only files the view lists ---');
  {
    const { work } = setUp('stage');
    write(work, 'a.txt', 'a changed\n');
    write(work, 'new.txt', 'new\n');
    await stageFiles(work, 'stage', ['new.txt']);
    let g = await workspaceGit(work);
    t.check('one staged: the new file; the other change left', [g.staged.map((f) => f.path), g.changes.map((f) => f.path)], [['new.txt'], ['a.txt']]);
    await stageFiles(work, 'stage', 'all');
    g = await workspaceGit(work);
    t.check('all staged', [g.staged.map((f) => f.path).sort(), g.changes.length], [['a.txt', 'new.txt'], 0]);
    await stageFiles(work, 'unstage', ['a.txt']);
    g = await workspaceGit(work);
    t.check('one unstaged: back among the changes, the file as it was', [g.staged.map((f) => f.path), g.changes.map((f) => f.path)], [['new.txt'], ['a.txt']]);
    let said = '';
    await stageFiles(work, 'stage', ['../outside.txt', 'not-there.txt']).catch((e: Error) => (said = e.message));
    t.truthy('a file the view does not list is refused, and nothing else is staged', said.startsWith('Not a change of the folder: ../outside.txt, not-there.txt') && (await workspaceGit(work)).staged.length === 1, said);
    await stageFiles(work, 'unstage', 'all');
    t.check('all unstaged, nothing lost', [(await workspaceGit(work)).staged.length, (await workspaceGit(work)).changes.map((f) => f.path).sort()], [0, ['a.txt', 'new.txt']]);
  }

  console.log('\n--- a commit of the operator\'s ---');
  {
    const { work } = setUp('commit');
    t.check('no message: refused, nothing run', [(await commit(work, '  ')).state, (await commit(work, '  ')).cause], ['failed', 'message']);
    write(work, 'a.txt', 'a changed\n');
    const none = await commit(work, 'Change a');
    t.check('nothing staged and not "all": refused, said why', [none.state, none.cause], ['failed', 'nothing']);
    await stageFiles(work, 'stage', ['a.txt']);
    write(work, 'b.txt', 'b\n');
    const msg = 'Change a\n\nWhy: the second line says so.\n# kept, not a comment';
    const one = await commit(work, msg);
    t.check('what was staged is committed, the rest left; the message as written; the operator\'s own name', [one.state, one.cause, git(work, 'log', '-1', '--format=%B').trim(), git(work, 'log', '-1', '--format=%an <%ae>'), git(work, 'status', '--porcelain')], ['done', undefined, msg, 'Operator <operator@example.com>', '?? b.txt']);
    t.check('the commit and the branch are on its record, and no hooks were there to run', [one.commit, one.branch, one.hooks], [git(work, 'rev-parse', 'HEAD'), 'main', 'none']);
    const all = await commit(work, 'Everything', { all: true });
    t.check('"all": the new file too, nothing left', [all.state, git(work, 'show', '--name-only', '--format=', 'HEAD'), git(work, 'status', '--porcelain')], ['done', 'b.txt', '']);
    const nothing = await commit(work, 'Again', { all: true });
    t.check('"all" with nothing changed: refused, said why', [nothing.state, nothing.cause], ['failed', 'nothing']);

    // A lock left by another git: git's own words, and the cause.
    write(work, 'a.txt', 'locked\n');
    writeFileSync(join(work, '.git', 'index.lock'), '');
    const locked = await commit(work, 'Locked', { all: true });
    t.truthy('another git\'s lock: refused, git\'s words kept, said why', locked.state === 'failed' && locked.cause === 'lock' && /index\.lock/.test(locked.output), locked);
    rmSync(join(work, '.git', 'index.lock'));

    // No name for git: said so; set here, then the commit goes through.
    const before = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
    const emptyGlobal = join(base, 'empty.gitconfig');
    writeFileSync(emptyGlobal, '');
    process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    try {
      git(work, 'config', '--unset', 'user.name');
      git(work, 'config', '--unset', 'user.email');
      git(work, 'config', 'user.useConfigOnly', 'true');
      const nameless = await commit(work, 'No name', { all: true });
      t.truthy('git has no name for the operator: refused, said why, git\'s words kept', nameless.state === 'failed' && nameless.cause === 'identity' && /auto-detection is disabled|tell me who you are/i.test(nameless.output), nameless);
      let bad = '';
      await setIdentity(work, { name: 'Ann', email: 'not an address' }).catch((e: Error) => (bad = e.message));
      t.check('an e-mail that is not one is refused', bad, 'Write an e-mail address, as name@example.com.');
      await setIdentity(work, { name: 'Ann Operator', email: 'ann@example.com' });
      t.check('set for this repository', [await identityOf(work), git(work, 'config', '--local', 'user.email')], [{ name: 'Ann Operator', email: 'ann@example.com' }, 'ann@example.com']);
      const named = await commit(work, 'Now with a name', { all: true });
      t.check('and the commit goes through under it', [named.state, git(work, 'log', '-1', '--format=%an <%ae>')], ['done', 'Ann Operator <ann@example.com>']);
    } finally {
      if (before.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = before.global;
      if (before.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = before.nosystem;
    }
  }

  console.log('\n--- the project\'s hooks: its own run, the others are asked about ---');
  {
    const { work } = setUp('hooks-own');
    // In .git, where the chat may not write: the project's own.
    write(work, '.git/hooks/pre-commit', hook('git-hooks pre-commit'));
    clearMarks();
    write(work, 'a.txt', 'one\n');
    const ok = await commit(work, 'With its hook', { all: true });
    t.check('a hook in .git: run without asking, and said so', [ok.state, ok.hooks, ran()], ['done', 'run', ['git-hooks pre-commit']]);
    write(work, '.git/hooks/pre-commit', hook('git-hooks pre-commit', 1));
    clearMarks();
    write(work, 'a.txt', 'two\n');
    const stopped = await commit(work, 'Stopped by its hook', { all: true });
    t.truthy('a hook that says no: the commit stopped, said why, the hook\'s own words kept whole', stopped.state === 'failed' && stopped.cause === 'hook' && stopped.output.includes('git-hooks pre-commit: the check failed in a.txt') && git(work, 'log', '-1', '--format=%s') === 'With its hook', stopped);
    const skipped = await commit(work, 'Without hooks', { all: true, hooks: 'skip' });
    t.check('"without hooks": committed, the hook not run', [skipped.state, skipped.hooks, git(work, 'log', '-1', '--format=%s')], ['done', 'skipped', 'Without hooks']);
    rmSync(join(work, '.git', 'hooks', 'pre-commit'));

    // A hooks folder of the operator's outside the project: theirs.
    const outside = join(base, 'my-hooks');
    write(outside, 'pre-commit', hook('outside pre-commit'));
    git(work, 'config', 'core.hooksPath', outside.replace(/\\/g, '/'));
    clearMarks();
    write(work, 'a.txt', 'three\n');
    const theirs = await commit(work, 'Their own hooks folder', { all: true });
    t.check('a hooks folder outside the project: run without asking', [theirs.state, theirs.hooks, ran()], ['done', 'run', ['outside pre-commit']]);
    git(work, 'config', '--unset', 'core.hooksPath');
  }
  {
    // husky's way: core.hooksPath .husky/_ (ignored), a stub there that runs .husky/pre-commit (committed).
    const { work } = setUp('hooks-husky');
    commitAs(work, '.husky/pre-commit', hook('husky pre-commit'), 'the project\'s pre-commit');
    write(work, '.husky/_/.gitignore', '*\n');
    write(work, '.husky/_/h', '#!/bin/sh\n# husky\'s runner\n');
    write(work, '.husky/_/pre-commit', '#!/bin/sh\nsh .husky/pre-commit\n');
    git(work, 'config', 'core.hooksPath', '.husky/_');
    const found = await hooksFor(work, 'commit');
    t.check('found: the stub and its helper, not committed; the committed hook the stub runs is the project\'s', [found.run, found.flagged.map((f) => [f.path, f.why])], [['.husky/_/pre-commit'], [['.husky/_/h', 'not-committed'], ['.husky/_/pre-commit', 'not-committed']]]);
    clearMarks();
    write(work, 'a.txt', 'one\n');
    const asked = await commit(work, 'First with husky', { all: true });
    t.check('asked: nothing staged, nothing committed, nothing run, each named with why and as it is now', [asked.state, asked.flagged?.map((f) => [f.path, f.why, f.sha.length]), git(work, 'log', '-1', '--format=%s'), git(work, 'status', '--porcelain'), ran()], ['hooks', [['.husky/_/h', 'not-committed', 64], ['.husky/_/pre-commit', 'not-committed', 64]], 'the project\'s pre-commit', 'M a.txt', []]);
    const wrong = await commit(work, 'First with husky', { all: true, trust: [{ path: '.husky/_/pre-commit', sha: 'f'.repeat(64) }, asked.flagged![0]!] });
    t.check('"run them" for a file as it no longer is: asked again about it', [wrong.state, wrong.flagged?.map((f) => f.path)], ['hooks', ['.husky/_/pre-commit']]);
    const yes = await commit(work, 'First with husky', { all: true, trust: asked.flagged!.map((f) => ({ path: f.path, sha: f.sha })) });
    t.check('"run them": the hooks run, the commit made', [yes.state, yes.hooks, ran(), git(work, 'log', '-1', '--format=%s')], ['done', 'run', ['husky pre-commit'], 'First with husky']);
    clearMarks();
    write(work, 'a.txt', 'two\n');
    const again = await commit(work, 'Second with husky', { all: true });
    t.check('remembered as they are: the next commit runs them without asking', [again.state, ran()], ['done', ['husky pre-commit']]);
    write(work, '.husky/_/pre-commit', '#!/bin/sh\nsh .husky/pre-commit\necho "changed stub" >> "$COP_TEST_MARK"\n');
    write(work, 'a.txt', 'three\n');
    const changedStub = await commit(work, 'Third', { all: true });
    t.check('the stub changed since: asked again, about it alone', [changedStub.state, changedStub.flagged?.map((f) => [f.path, f.why])], ['hooks', [['.husky/_/pre-commit', 'not-committed']]]);
    write(work, '.husky/_/pre-commit', '#!/bin/sh\nsh .husky/pre-commit\n');
    // The committed hook changed in the folder: written during the work, as far as anything can tell.
    write(work, '.husky/pre-commit', `${hook('husky pre-commit')}echo "and more" >> "$COP_TEST_MARK"\n`);
    const changedHook = await commit(work, 'Fourth', { all: true });
    t.check('the project\'s hook changed and not committed: asked, "changed"', [changedHook.state, changedHook.flagged?.map((f) => [f.path, f.why])], ['hooks', [['.husky/pre-commit', 'changed']]]);
    // Committed by the bot: written during the work.
    git(work, 'add', '-A');
    git(work, '-c', 'user.name=copilot-operator', '-c', `user.email=${RUNNER_EMAIL}`, '-c', 'core.hooksPath=/nonexistent', 'commit', '-q', '-m', 'the bot committed the hook');
    write(work, 'a.txt', 'five\n');
    const byBot = await commit(work, 'Fifth', { all: true });
    t.check('the hook last committed by the bot: asked, "by-bot"', [byBot.state, byBot.flagged?.map((f) => [f.path, f.why])], ['hooks', [['.husky/pre-commit', 'by-bot']]]);
    clearMarks();
    const noHooks = await commit(work, 'Fifth', { all: true, hooks: 'skip' });
    t.check('"without hooks" there: committed, nothing run', [noHooks.state, noHooks.hooks, ran()], ['done', 'skipped', []]);
  }

  console.log('\n--- a push of the operator\'s ---');
  {
    const { work, remote } = setUp('push');
    const nothing = await push(work);
    t.check('nothing to push: said so, the target named', [nothing.state, nothing.upToDate, nothing.target, nothing.published], ['done', true, 'origin/main', false]);
    commitAs(work, 'a.txt', 'pushed\n', 'to push');
    const one = await push(work);
    t.check('to its upstream: the remote has the commit', [one.state, git(remote, 'rev-parse', 'main'), one.command], ['done', git(work, 'rev-parse', 'HEAD'), 'git push origin HEAD:refs/heads/main']);
    // Somebody else moved the remote's main on.
    const other = join(base, 'push', 'other');
    execFileSync('git', ['clone', '-q', '--config', 'core.autocrlf=false', remote, other], { stdio: 'ignore' });
    commitAs(other, 'other.txt', 'theirs\n', 'the team moved main on');
    git(other, 'push', '-q', 'origin', 'main');
    commitAs(work, 'a.txt', 'mine\n', 'mine');
    const behind = await push(work);
    t.truthy('the remote moved on: refused, never forced, said why, git\'s words kept', behind.state === 'failed' && behind.cause === 'behind' && /\[rejected\]/.test(behind.output) && git(remote, 'log', '-1', '--format=%s', 'main') === 'the team moved main on', behind);
    git(work, 'checkout', '-q', '-b', 'feature/login');
    const published = await push(work);
    t.check('a branch with no upstream: published under its name, and followed from then on', [published.state, published.published, published.target, git(work, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'), git(remote, 'rev-parse', 'feature/login')], ['done', true, 'origin/feature/login', 'origin/feature/login', git(work, 'rev-parse', 'HEAD')]);
    // Its pre-push hook, the project's own (Git LFS's is one such): run; one that says no stops it.
    write(work, '.git/hooks/pre-push', hook('pre-push', 1));
    clearMarks();
    commitAs(work, 'a.txt', 'more\n', 'more');
    const stopped = await push(work);
    t.truthy('a pre-push hook that says no: stopped, said why, its words kept', stopped.state === 'failed' && stopped.cause === 'hook' && stopped.output.includes('pre-push: the check failed in a.txt') && ran().join() === 'pre-push', stopped);
    write(work, '.git/hooks/pre-push', hook('pre-push'));
    clearMarks();
    const passed = await push(work);
    t.check('one that says yes: run, and pushed', [passed.state, passed.hooks, ran(), git(remote, 'rev-parse', 'feature/login')], ['done', 'run', ['pre-push'], git(work, 'rev-parse', 'HEAD')]);
    git(work, 'checkout', '-q', '--detach');
    t.check('no branch (a detached HEAD): refused, said why', [(await push(work)).cause], ['detached']);
    const lone = join(base, 'lone');
    mkdirSync(lone, { recursive: true });
    git(lone, 'init', '-q', '-b', 'main');
    commitAs(lone, 'x.txt', 'x\n', 'x');
    t.check('no remote: refused, said why', [(await push(lone)).cause], ['no-remote']);
  }

  console.log('\n--- through the API: one at a time, and nothing of the bot\'s starts in the folder meanwhile ---');
  {
    const h = await startHarness();
    try {
      h.git('config', 'user.name', 'Operator');
      h.git('config', 'user.email', 'operator@example.com');
      // A slow pre-commit of the project's own, so the commit is still running when the rest is asked for.
      write(h.repo, '.git/hooks/pre-commit', '#!/bin/sh\necho "checking..."\nsleep 4\necho "checked"\n');
      write(h.repo, 'slow.txt', 'slow\n');
      const started = await h.call<GitOp>('POST', '/workspace/git/commit', { message: 'Slow one', all: true });
      t.check('started: answered at once, running', [started.state, started.kind], ['running', 'commit']);
      const second = await h.raw('POST', '/workspace/git/commit', { message: 'Another', all: true });
      const branch = await h.raw('POST', '/workspace/new-branch/preview', { fetch: false });
      const stage = await h.raw('POST', '/workspace/git/stage', { all: true });
      const busy = (r: { status: number; body: unknown }): boolean => r.status === 400 && JSON.stringify(r.body).includes('Git is committing in the project folder');
      t.truthy('meanwhile another commit, staging and a new branch are refused, said why', busy(second) && busy(branch) && busy(stage), [second, branch, stage]);
      const { threadId } = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Say what is in the folder.', model: 'Think deeper' });
      const start = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${threadId}/start`, { mode: 'unattended' });
      t.truthy('and a message of the chat does not start, said why', start.started === false && (start.reason ?? '').includes('Git is committing'), start);
      const seen: string[] = [];
      await waitFor('the commit to end', async () => {
        const now = (await h.call<{ op: GitOp }>('GET', '/workspace/git/op')).op;
        if (now.output && seen.at(-1) !== now.output) seen.push(now.output);
        return now.state !== 'running' ? true : null;
      }, 30_000);
      const end = (await h.call<{ op: GitOp }>('GET', '/workspace/git/op')).op;
      t.check('it ended: committed, its hook run', [end.state, end.hooks, h.git('log', '-1', '--format=%s')], ['done', 'run', 'Slow one']);
      t.truthy('the hook\'s lines were readable while it ran, before it ended', seen.some((o) => o.includes('checking...') && !o.includes('checked\n')) || seen[0]?.includes('checking...'), seen);
      const after = await h.raw('POST', '/workspace/git/stage', { all: true });
      t.check('once it has ended, the folder\'s git is free again', after.status, 201);
    } finally {
      await h.stop();
    }
  }
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  rmSync(base, { recursive: true, force: true });
}
t.finish();
