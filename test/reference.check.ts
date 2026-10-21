/**
 * Projects for reference only (operator, 2026-10-21): "a checkbox on each project in Settings — whether it may be
 * developed in or is only for reference. Marked for reference, nothing may be changed there while the bot works."
 *
 * Held here:
 *   - the guard (`src/vcs/referenceGuard.ts`) on a real repository: files changed, made and removed are put back as
 *     their exact bytes, uncommitted changes and untracked files included; a branch made, a commit, a stash, another
 *     branch checked out and something staged are undone; the photographs leave nothing in the repository; a folder
 *     that is not a repository is watched for its files; what git ignores is not watched, as said;
 *   - Settings keep the box, for the chat's folder and for the others, and a list saved without it keeps it;
 *   - a chat message, end to end: the chat is told which projects are for reference before it starts, a step that
 *     writes into one is put back, the rest of its round is not run, and Copilot is told why; on the chat's own
 *     folder marked so, the same.
 *
 *   npm run check:reference
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReferenceGuard, referenceNote } from '../src/vcs/referenceGuard.js';
import { startHarness, Tally } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
const base = await mkdtemp(join(tmpdir(), 'cop-reference-'));
process.once('exit', () => rmSync(base, { recursive: true, force: true }));

const gitIn = (dir: string) => (...args: string[]): string =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=operator', '-c', 'user.email=operator@example.com', ...args], { encoding: 'utf8' }).trim();

/** A repository as an operator keeps one: committed files, one changed and not committed, one untracked, an ignored folder. */
function makeRepo(dir: string): (...args: string[]) => string {
  mkdirSync(join(dir, 'src'), { recursive: true });
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'line one\r\nline two\r\n');
  writeFileSync(join(dir, 'src', 'b.js'), 'export const b = 1;\n');
  writeFileSync(join(dir, 'dirty.txt'), 'as committed\n');
  writeFileSync(join(dir, '.gitignore'), 'out/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  writeFileSync(join(dir, 'dirty.txt'), 'changed by the operator, not committed\n');
  writeFileSync(join(dir, 'notes.txt'), 'untracked, the operator\'s\n');
  mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(join(dir, 'out', 'build.txt'), 'built\n');
  return git;
}

const bytes = (p: string): string => (existsSync(p) ? readFileSync(p).toString('hex') : '(missing)');

console.log('--- the guard, on a repository ---');
{
  const dir = join(base, 'tests-repo');
  const git = makeRepo(dir);
  const before = {
    a: bytes(join(dir, 'a.txt')),
    b: bytes(join(dir, 'src', 'b.js')),
    dirty: bytes(join(dir, 'dirty.txt')),
    notes: bytes(join(dir, 'notes.txt')),
    refs: git('for-each-ref'),
    head: git('rev-parse', 'HEAD'),
    objects: git('count-objects', '-v'),
    index: bytes(join(dir, '.git', 'index')),
    gitFiles: readdirSync(join(dir, '.git')).sort().join(','),
  };
  const guard = await ReferenceGuard.start([{ name: 'tests', dir }], 'check-1');
  t.truthy('watched', guard.active && guard.unwatched.length === 0, guard.unwatched);
  t.check('nothing changed: nothing to say', await guard.check(), []);
  t.check(
    'the photographs leave nothing in the repository: no object, ref, index or file in .git',
    [git('count-objects', '-v'), git('for-each-ref'), bytes(join(dir, '.git', 'index')), readdirSync(join(dir, '.git')).sort().join(',')],
    [before.objects, before.refs, before.index, before.gitFiles],
  );

  // A step that writes into it.
  writeFileSync(join(dir, 'a.txt'), 'line one\nrewritten\n');
  writeFileSync(join(dir, 'new.txt'), 'made by a step\n');
  rmSync(join(dir, 'src', 'b.js'));
  writeFileSync(join(dir, 'dirty.txt'), 'changed again by a step\n');
  rmSync(join(dir, 'notes.txt'));
  const files = await guard.check();
  const c = files[0];
  t.check(
    'what the step did, file by file',
    (c?.files ?? []).map((f) => `${f.path}:${f.how}`).sort(),
    ['a.txt:changed', 'dirty.txt:changed', 'new.txt:added', 'notes.txt:removed', 'src/b.js:removed'],
  );
  t.check('and put back', [c?.putBack, c?.problem], [true, undefined]);
  t.check(
    'as their exact bytes — the line endings, the uncommitted change, the untracked file — and the made one gone',
    [bytes(join(dir, 'a.txt')), bytes(join(dir, 'src', 'b.js')), bytes(join(dir, 'dirty.txt')), bytes(join(dir, 'notes.txt')), existsSync(join(dir, 'new.txt'))],
    [before.a, before.b, before.dirty, before.notes, false],
  );
  t.check('then nothing more to say', await guard.check(), []);

  // A step that uses git in it.
  git('branch', 'side');
  git('stash', 'push', '-q', '-m', 'a step\'s stash', '--', 'dirty.txt');
  git('checkout', '-q', '-b', 'other');
  writeFileSync(join(dir, 'c.txt'), 'committed by a step\n');
  git('add', 'c.txt');
  git('commit', '-q', '-m', 'a step commits');
  writeFileSync(join(dir, 'a.txt'), 'staged by a step\n');
  git('add', 'a.txt');
  const gits = await guard.check();
  const g = gits[0];
  t.truthy('a branch made, the stash, HEAD moved, what is staged: all said', !!g && ['side made', 'other made', 'the stash made', 'HEAD moved from main to other', 'what is staged'].every((x) => g.git.includes(x)), g?.git);
  t.check('and put back', [g?.putBack, g?.problem], [true, undefined]);
  t.check(
    'on main at its commit, no branch or stash of the step\'s, nothing staged, the files as they were',
    [git('symbolic-ref', '--short', 'HEAD'), git('rev-parse', 'HEAD'), git('for-each-ref'), git('diff', '--cached', '--name-only'), bytes(join(dir, 'a.txt')), bytes(join(dir, 'dirty.txt')), existsSync(join(dir, 'c.txt'))],
    ['main', before.head, before.refs, '', before.a, before.dirty, false],
  );

  // What git ignores is not watched, as said.
  writeFileSync(join(dir, 'out', 'build.txt'), 'rebuilt\n');
  t.check('a file git ignores is not watched (said in the ⓘ and the guard)', await guard.check(), []);
  await guard.close();
}

console.log('\n--- a folder that is not a repository ---');
{
  const dir = join(base, 'loose');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'data.csv'), 'a,b\r\n1,2\r\n');
  const was = bytes(join(dir, 'data.csv'));
  const guard = await ReferenceGuard.start([{ name: 'data', dir }], 'check-2');
  writeFileSync(join(dir, 'data.csv'), 'a,b\n9,9\n');
  writeFileSync(join(dir, 'extra.csv'), 'x\n');
  const [c] = await guard.check();
  t.check('its files are watched and put back', [c?.putBack, bytes(join(dir, 'data.csv')) === was, existsSync(join(dir, 'extra.csv')), c?.git], [true, true, false, []]);
  t.check('and nothing was written into it', readdirSync(dir).sort(), ['data.csv']);
  await guard.close();
  const missing = await ReferenceGuard.start([{ name: 'gone', dir: join(base, 'not-there') }], 'check-3');
  t.check('one that is not there: not watched, with why', missing.unwatched.map((u) => u.name), ['gone']);
}

console.log('\n--- what the chat is told ---');
{
  const note = referenceNote([{ name: 'tests', dir: 'C:\\x\\tests' }], 'C:\\x\\app');
  t.truthy('the projects and the rule', note.includes('## Projects for reference only') && note.includes('- tests: C:\\x\\tests') && note.includes('puts back whatever changed'), note);
  t.truthy('the chat\'s own folder among them: it can only read', referenceNote([{ name: 'app', dir: 'C:\\x\\app' }], 'C:\\x\\app').includes('The folder you work in is one of them'), referenceNote([{ name: 'app', dir: 'C:\\x\\app' }], 'C:\\x\\app'));
}

console.log('\n--- Settings, and a chat message end to end ---');
{
  const h = await startHarness({ settings: { execution: { mode: 'unattended', isolation: 'none-accepted' } } });
  try {
    const ref = join(h.base, 'the-tests');
    makeRepo(ref);
    type Project = { readOnly: boolean; others: Array<{ name: string; readOnly: boolean }> };
    const saved = await h.call<Project>('PUT', '/project', { others: [{ name: 'the tests', rootDir: ref, readOnly: true }] });
    t.check('saved: the other project is for reference, the chat\'s is not', [saved.readOnly, saved.others[0]?.readOnly], [false, true]);
    const renamed = await h.call<Project>('PUT', '/project', { others: [{ name: 'the tests, renamed', rootDir: ref }] });
    t.check('a list saved without the box keeps it', renamed.others[0]?.readOnly, true);

    const aBefore = bytes(join(ref, 'a.txt'));
    h.chat.script(
      reply.steps(`Set-Content -Path '${join(ref, 'a.txt')}' -Value 'changed by the chat'`, 'Write-Output "the next step ran"'),
      reply.done('The tests project is for reference only, so nothing was changed there; the work stays in this folder.'),
    );
    const sent = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Fix the typo in the tests project.', model: 'Think deeper' });
    await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
    await h.idle();
    const told = h.chat.sent.map((m) => [m.text, ...Object.values(m.attached)].join('\n'));
    t.truthy('before it starts, the chat is told which projects are for reference', told.slice(0, 2).some((x) => x.includes('## Projects for reference only') && x.includes(ref)), told[1]?.slice(0, 900));
    t.check('the step\'s change is put back', bytes(join(ref, 'a.txt')), aBefore);
    const report = told.find((x) => x.includes('which is for reference only')) ?? '';
    t.truthy('Copilot is told what was changed, that it was put back, and to change nothing there', report.includes('a.txt (changed)') && report.includes('put it back') && report.includes('Change nothing there'), report.slice(0, 900));
    t.truthy('and the rest of that round did not run', !told.some((x) => x.includes('the next step ran')), told.at(-1)?.slice(0, 600));
    const session = await h.call<{ tasks: Array<{ status: string }> }>('GET', `/sessions/${sent.threadId}`);
    t.check('the message ended as the chat said', session.tasks[0]?.status, 'done');

    // The chat's own folder for reference only: a message can only read.
    await h.call('PUT', '/project', { readOnly: true });
    const readmeBefore = bytes(join(h.repo, 'README.md'));
    h.chat.script(
      reply.steps("Set-Content -Path README.md -Value 'rewritten'"),
      reply.done('This folder is for reference only, so the README was put back; nothing here can be changed.'),
    );
    const second = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Rewrite the README.', model: 'Think deeper' });
    await h.call('POST', `/sessions/${second.threadId}/start`, { mode: 'unattended' });
    await h.idle();
    const told2 = h.chat.sent.slice(told.length).map((m) => [m.text, ...Object.values(m.attached)].join('\n'));
    t.truthy('the chat is told its own folder is one of them', told2.slice(0, 2).some((x) => x.includes('The folder you work in is one of them')), told2[1]?.slice(0, 700));
    t.check('and the README is as it was', bytes(join(h.repo, 'README.md')), readmeBefore);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } finally {
    await h.stop();
  }
}

t.finish();
