/**
 * "New branch from main", in the chat (operator, 2026-10-26): the remote's main fetched, a new local branch made at it
 * for the next task, not tracking it; what was not committed taken to it or put aside, as the operator chooses; a
 * folder that cannot simply change branch said so, with nothing moved; a remote that cannot be fetched said so, with
 * what was last fetched to go on from. Against real repositories, a bare one as the remote — no browser, no Copilot.
 *
 *   npm run check:new-branch
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchNameProblem, createNewBranch, planNewBranch } from '../src/vcs/newBranch.js';
import { describeFetchFailure, operatorFetchEnv } from '../src/vcs/remoteAuth.js';
import { reply } from './support/fakeChat.js';
import { startHarness, Tally, waitFor, type Harness } from './support/harness.js';

const t = new Tally();
const base = mkdtempSync(join(tmpdir(), 'cop-new-branch-'));
const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (dir: string, ...args: string[]): boolean => {
  try {
    git(dir, ...args);
    return true;
  } catch {
    return false;
  }
};
const who = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const commit = (dir: string, file: string, text: string, message: string): void => {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', '-A');
  git(dir, ...who, 'commit', '-q', '-m', message);
};

/** A remote, a working folder cloned from it, and the remote's main moved on by somebody else. */
function setUp(name: string): { work: string; remote: string; other: string } {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const work = join(root, 'work');
  // Line endings as written, whatever this machine's git does with them on a checkout.
  execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', '--config', 'core.autocrlf=false', remote, work], { stdio: 'ignore' });
  git(work, 'checkout', '-q', '-b', 'main');
  commit(work, 'README.md', 'first\n', 'first');
  commit(work, 'a.txt', 'a\n', 'a');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  const other = join(root, 'other');
  execFileSync('git', ['clone', '-q', '--config', 'core.autocrlf=false', remote, other], { stdio: 'ignore' });
  commit(other, 'README.md', 'first\nmoved on by somebody else\n', 'the team moved main on');
  git(other, 'push', '-q', 'origin', 'main');
  return { work, remote, other };
}

try {
  console.log('--- the rules of a fetch the operator is at ---');
  const env = operatorFetchEnv('C:\\Git\\mingw64\\bin\\git-askpass.exe');
  t.check('ssh and git ask through Git\'s own window, never the bot\'s console', [env.SSH_ASKPASS, env.GIT_ASKPASS, env.SSH_ASKPASS_REQUIRE, env.GIT_TERMINAL_PROMPT, env.GCM_INTERACTIVE], ['C:\\Git\\mingw64\\bin\\git-askpass.exe', 'C:\\Git\\mingw64\\bin\\git-askpass.exe', 'force', '0', 'auto']);
  t.check('a password not given is said as such; a network that is down is not', [
    describeFetchFailure('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.').auth,
    describeFetchFailure('fatal: could not read Username for \'https://example.com\': terminal prompts disabled').auth,
    describeFetchFailure('fatal: unable to access: Could not resolve host: example.com').auth,
  ], [true, true, false]);

  console.log('\n--- a clean folder: the new branch at the remote\'s main, not tracking it ---');
  {
    const { work, other } = setUp('clean');
    const before = git(work, 'rev-parse', 'main');
    const plan = await planNewBranch(work, { fetch: true, askpass: null });
    t.check('read: fetched, the remote\'s main as it is now, nothing uncommitted, a free name offered', [plan.ok, plan.fetched?.ok, plan.target, plan.targetCommit, plan.targetSubject, plan.changed, plan.untracked, /^task\/\d{8}-\d{4}$/.test(plan.suggested ?? '')], [true, true, 'origin/main', git(other, 'rev-parse', 'HEAD'), 'the team moved main on', [], [], true]);
    t.check('a name in use, or one git will not take, is refused', [await branchNameProblem(work, 'main'), await branchNameProblem(work, 'bad name'), await branchNameProblem(work, '-x'), await branchNameProblem(work, 'task/ok')], [
      'There is a branch called "main" already; choose another name.',
      '"bad name" cannot be a branch\'s name: no spaces, no "..", and not starting or ending with "/" or ".".',
      '"-x" cannot be a branch\'s name: no spaces, no "..", and not starting or ending with "/" or ".".',
      null,
    ]);
    writeFileSync(join(work, 'late.txt'), 'late\n');
    t.check('the folder changed since it was read: refused, nothing moved', [(await createNewBranch(work, { name: 'task/one', carry: 'take', fingerprint: plan.fingerprint! })).ok, git(work, 'symbolic-ref', '--short', 'HEAD')], [false, 'main']);
    rmSync(join(work, 'late.txt'));
    const made = await createNewBranch(work, { name: 'task/one', carry: 'take', fingerprint: plan.fingerprint! });
    t.check('made: on the new branch, at the remote\'s main', [made.ok, git(work, 'symbolic-ref', '--short', 'HEAD'), git(work, 'rev-parse', 'HEAD'), readFileSync(join(work, 'README.md'), 'utf8')], [true, 'task/one', git(other, 'rev-parse', 'HEAD'), 'first\nmoved on by somebody else\n']);
    t.check('not tracking main, so a push of its work never goes there; the local main as it was', [tryGit(work, 'rev-parse', '--abbrev-ref', 'task/one@{upstream}'), git(work, 'rev-parse', 'main')], [false, before]);
    t.truthy('said in a sentence', made.ok && made.result.startsWith('The folder is on the new branch task/one, made from origin/main ('), made);
  }

  console.log('\n--- uncommitted changes: taken to the new branch, or put aside ---');
  {
    const { work } = setUp('dirty');
    writeFileSync(join(work, 'a.txt'), 'a, changed\n');
    writeFileSync(join(work, 'new.txt'), 'new\n');
    const plan = await planNewBranch(work, { fetch: true, askpass: null });
    t.check('read: what is not committed', [plan.changed, plan.untracked], [['a.txt'], ['new.txt']]);
    const taken = await createNewBranch(work, { name: 'task/take', carry: 'take', fingerprint: plan.fingerprint! });
    t.check('"Take them": on the new branch, the changes with it', [taken.ok, taken.ok && taken.carried, git(work, 'symbolic-ref', '--short', 'HEAD'), readFileSync(join(work, 'a.txt'), 'utf8'), existsSync(join(work, 'new.txt'))], [true, 2, 'task/take', 'a, changed\n', true]);
  }
  {
    const { work } = setUp('conflict');
    // The same file the remote's main changed: git will not carry it across.
    writeFileSync(join(work, 'README.md'), 'first\nmine, not committed\n');
    writeFileSync(join(work, 'new.txt'), 'new\n');
    const plan = await planNewBranch(work, { fetch: true, askpass: null });
    const taken = await createNewBranch(work, { name: 'task/clash', carry: 'take', fingerprint: plan.fingerprint! });
    t.check('"Take them" when the remote\'s main changed the same file: refused, said as such, nothing moved', [taken.ok, !taken.ok && taken.conflict, git(work, 'symbolic-ref', '--short', 'HEAD'), readFileSync(join(work, 'README.md'), 'utf8'), tryGit(work, 'rev-parse', '--verify', '--quiet', 'refs/heads/task/clash')], [false, true, 'main', 'first\nmine, not committed\n', false]);
    const aside = await createNewBranch(work, { name: 'task/clash', carry: 'aside', fingerprint: plan.fingerprint! });
    const saved = aside.ok ? aside.saved?.branch ?? '' : '';
    t.check('"Put them aside": on the new branch, the folder clean', [aside.ok, git(work, 'symbolic-ref', '--short', 'HEAD'), git(work, 'status', '--porcelain'), existsSync(join(work, 'new.txt'))], [true, 'task/clash', '', false]);
    t.check('and every change kept on a branch of its own, nothing lost', [/^cop\/saved\/\d{8}-\d{4}$/.test(saved), git(work, 'show', `${saved}:README.md`), git(work, 'show', `${saved}:new.txt`), aside.ok && aside.saved?.files], [true, 'first\nmine, not committed', 'new', 2]);
  }

  console.log('\n--- uncommitted changes committed on the branch the folder is on (2026-10-28) ---');
  {
    const { work } = setUp('commit-here');
    // The same file the remote's main changed, which "take them" cannot carry: committing where they are can.
    writeFileSync(join(work, 'README.md'), 'first\nmine, not committed\n');
    writeFileSync(join(work, 'new.txt'), 'new\n');
    git(work, 'config', 'user.name', 'Operator');
    git(work, 'config', 'user.email', 'operator@example.com');
    const before = git(work, 'rev-parse', 'main');
    const plan = await planNewBranch(work, { fetch: true, askpass: null });
    const made = await createNewBranch(work, { name: 'task/after', carry: 'commit', fingerprint: plan.fingerprint!, message: 'My work so far' });
    t.check('"Commit them on main": on the new branch, the folder clean', [made.ok, git(work, 'symbolic-ref', '--short', 'HEAD'), git(work, 'status', '--porcelain'), existsSync(join(work, 'new.txt'))], [true, 'task/after', '', false]);
    const on = made.ok ? made.committed : undefined;
    t.check('one commit on main on top of where it was, with every change, the new file too', [on?.branch, on?.files, git(work, 'rev-parse', 'main') === on?.commit, git(work, 'rev-parse', 'main~1'), git(work, 'show', 'main:README.md'), git(work, 'show', 'main:new.txt')], ['main', 2, true, before, 'first\nmine, not committed', 'new']);
    t.check('under the operator\'s own git name, with their message and the files listed', [git(work, 'log', '-1', '--format=%an <%ae>', 'main'), git(work, 'log', '-1', '--format=%s', 'main'), /- changed: README\.md[\s\S]*- new: new\.txt/.test(git(work, 'log', '-1', '--format=%b', 'main'))], ['Operator <operator@example.com>', 'My work so far', true]);
    t.check('not pushed: the remote\'s main is not it', git(work, 'rev-parse', 'origin/main') !== on?.commit, true);
    t.truthy('said in a sentence', made.ok && made.result.includes(`committed on main as ${on?.commit.slice(0, 8)} (2 file(s)), not pushed`), made);
  }
  {
    const { work } = setUp('commit-default');
    writeFileSync(join(work, 'a.txt'), 'a, changed\n');
    // No git name here, whatever this machine's own git config says: the bot's own, and the default message.
    const blank = join(base, 'no-global.gitconfig');
    writeFileSync(blank, '');
    const kept = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.GIT_CONFIG_GLOBAL = blank;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const plan = await planNewBranch(work, { fetch: true, askpass: null });
    const made = await createNewBranch(work, { name: 'task/default', carry: 'commit', fingerprint: plan.fingerprint! });
    for (const [k, v] of [['GIT_CONFIG_GLOBAL', kept.global], ['GIT_CONFIG_NOSYSTEM', kept.system]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    t.check('no message written: the default; no git name: the bot\'s', [made.ok, git(work, 'log', '-1', '--format=%s', 'main'), git(work, 'log', '-1', '--format=%ae', 'main')], [true, 'Work in progress, before a new branch from main', 'copilot-operator@localhost']);
  }
  {
    const { work } = setUp('commit-detached');
    git(work, 'checkout', '-q', '--detach');
    writeFileSync(join(work, 'a.txt'), 'a, changed\n');
    const plan = await planNewBranch(work, { fetch: true, askpass: null });
    const made = await createNewBranch(work, { name: 'task/detached', carry: 'commit', fingerprint: plan.fingerprint! });
    t.check('on a detached HEAD: refused, said why, nothing moved', [made.ok, !made.ok && /detached HEAD/.test(made.problem), readFileSync(join(work, 'a.txt'), 'utf8'), git(work, 'status', '--porcelain')], [false, true, 'a, changed\n', 'M a.txt']);
  }
  {
    const { work } = setUp('commit-staged');
    // What the operator had staged stays staged, unstaged stays unstaged, until the commit is whole.
    writeFileSync(join(work, 'a.txt'), 'a, staged\n');
    git(work, 'add', 'a.txt');
    writeFileSync(join(work, 'a.txt'), 'a, staged, then changed again\n');
    const plan = await planNewBranch(work, { fetch: true, askpass: null });
    const stale = await createNewBranch(work, { name: 'task/stale', carry: 'commit', fingerprint: 'not-the-one' });
    t.check('the folder changed since it was read: refused, the index as it was', [stale.ok, git(work, 'diff', '--cached', '--name-only'), git(work, 'show', ':a.txt')], [false, 'a.txt', 'a, staged']);
    const made = await createNewBranch(work, { name: 'task/staged', carry: 'commit', fingerprint: plan.fingerprint! });
    t.check('committed as the folder has it — the file as last written, not as staged', [made.ok, git(work, 'show', 'main:a.txt')], [true, 'a, staged, then changed again']);
  }

  console.log('\n--- what cannot go: half a merge, no remote, a remote that cannot be fetched ---');
  {
    const { work } = setUp('busy');
    const gitDir = git(work, 'rev-parse', '--absolute-git-dir');
    writeFileSync(join(gitDir, 'MERGE_HEAD'), git(work, 'rev-parse', 'HEAD'));
    t.check('in the middle of a merge: refused, said why', (await planNewBranch(work, { fetch: false })).problem, 'The repository is in the middle of a merge. Finish it or abort it first; nothing was changed.');
    rmSync(join(gitDir, 'MERGE_HEAD'));
    // Fetched once here, then the remote out of reach.
    await planNewBranch(work, { fetch: true, askpass: null });
    git(work, 'remote', 'set-url', 'origin', join(base, 'busy', 'gone.git'));
    const unreachable = await planNewBranch(work, { fetch: true, askpass: null });
    t.check('a remote that cannot be fetched: said, and the main last fetched here offered to go on from', [unreachable.ok, unreachable.fetched?.ok, unreachable.fetched?.auth, unreachable.target, typeof unreachable.lastFetched], [true, false, false, 'origin/main', 'string']);
    const fromLast = await planNewBranch(work, { fetch: false });
    const made = await createNewBranch(work, { name: 'task/offline', carry: 'take', fingerprint: fromLast.fingerprint! });
    t.check('going on from it: made at the main as it was last fetched', [made.ok, git(work, 'rev-parse', 'HEAD'), git(work, 'rev-parse', 'origin/main')], [true, git(work, 'rev-parse', 'origin/main'), git(work, 'rev-parse', 'HEAD')]);
    const lone = join(base, 'lone');
    mkdirSync(lone);
    execFileSync('git', ['init', '-q', '-b', 'main', lone]);
    commit(lone, 'x.txt', 'x\n', 'x');
    t.check('no remote: refused, said why', (await planNewBranch(lone, { fetch: true, askpass: null })).problem, 'The repository has no remote, so there is no remote main to make the branch from.');
    t.check('not a repository: said so', (await planNewBranch(base, { fetch: false })).problem?.endsWith('is not a git repository, so there is no main to make a branch from.'), true);
  }

  console.log('\n--- through the API: refused while a task works; made when it has ended ---');
  let h: Harness | null = null;
  try {
    h = await startHarness({ settings: { execution: { mode: 'unattended', isolation: 'none-accepted' } } });
    const remote = join(h.base, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    h.git('remote', 'add', 'origin', remote);
    h.git('push', '-q', '-u', 'origin', 'main');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    h.chat.script(async () => {
      await held;
      return reply.done('I looked at the folder: it holds README.md and nothing else the message names.');
    });
    const sent = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Say what is in the folder.', model: 'Think deeper' });
    await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
    await waitFor('the message to be at work', async () => ((await h!.call<{ running: boolean }>('GET', '/activity')).running ? true : null), 20_000);
    const busy = await h.raw('POST', '/workspace/new-branch/preview', { fetch: true });
    t.check('while a task works: refused, said why', [busy.status, (busy.body as { message?: string }).message], [400, 'A task is working: stop it or let it finish first; the branch is not changed under it.']);
    release();
    await h.idle();
    const plan = await h.call<{ ok: boolean; target: string; fingerprint: string; suggested: string }>('POST', '/workspace/new-branch/preview', { fetch: true });
    t.check('ended: read, with the remote\'s main', [plan.ok, plan.target], [true, 'origin/main']);
    const made = await h.call<{ ok: boolean; branch: string }>('POST', '/workspace/new-branch', { name: plan.suggested, carry: 'take', fingerprint: plan.fingerprint });
    t.check('made through the API, and the folder is on it', [made.ok, made.branch, h.git('symbolic-ref', '--short', 'HEAD')], [true, plan.suggested, plan.suggested]);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } finally {
    await h?.stop();
  }
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  rmSync(base, { recursive: true, force: true });
}
t.finish();
