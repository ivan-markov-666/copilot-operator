/**
 * The open project folder's git, as the workbench's Source Control view reads it (2026-10-19: "see which files
 * changed and how — the diff; let the Commits button show Git as VS Code does"), through the API, against a real
 * repository: what is staged and what is not, the files git does not track, each with its lines; a file's two
 * versions; the branch's commits and the files of one. Read-only: reading it changes nothing in the repository.
 *
 *   npm run check:workspace-git
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, Tally, type Harness } from './support/harness.js';

const t = new Tally();
type File = { path: string; oldPath?: string; status: string; added: number; removed: number };
type Git = { isRepo: boolean; branch?: string; head?: string; staged: File[]; changes: File[]; commits: Array<{ sha: string; short: string; subject: string; author: string }>; moreCommits: boolean };
type Versions = { path: string; status: string; before: string | null; after: string | null; binary: boolean };
const brief = (files: File[]): string[] => files.map((f) => `${f.status} ${f.oldPath ? `${f.oldPath} -> ` : ''}${f.path} +${f.added} -${f.removed}`);
type Counts = { isRepo: boolean; uncommitted: number; branch: number | null; base?: string; problem?: string };
/** The files the Source Control view lists, staged or not, each once: what the Git button's first number counts. */
const uniqueFiles = (g: Git): number => new Set([...g.staged, ...g.changes].map((f) => f.path)).size;

let h: Harness | null = null;
try {
  h = await startHarness();
  const repo = h.repo;
  const put = (p: string, text: string): void => {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), text, 'utf8');
  };

  console.log('\n--- a clean folder: the branch and its one commit, nothing changed ---');
  let g = await h.call<Git>('GET', '/workspace/git');
  t.check('a repository on main, nothing staged or changed', [g.isRepo, g.branch, g.staged, g.changes], [true, 'main', [], []]);
  t.check('its commits, newest first', g.commits.map((c) => [c.subject, c.author, c.short.length >= 7]), [['initial', 'check', true]]);

  console.log('\n--- changes staged and not, and a file git does not track ---');
  put('README.md', '# fixture\nmore\n');
  put('docs/new.md', 'one\ntwo\nthree\n');
  put('staged.txt', 'in the index\n');
  h.git('add', 'staged.txt');
  const statusBefore = h.git('status', '--porcelain');
  g = await h.call<Git>('GET', '/workspace/git');
  t.check('staged: the file added to the index', brief(g.staged), ['A staged.txt +1 -0']);
  t.check('changes: the file changed, and the one git does not track, with their lines', brief(g.changes), ['M README.md +1 -0', 'U docs/new.md +3 -0']);
  /*
   * The two numbers on the Git button (operator, 2026-10-27): the files not committed, each once, as the view lists
   * them; on main with no other branch, nothing to compare with, so no number for the branch.
   */
  let n = await h.call<Counts>('GET', '/workspace/git/counts');
  t.check('the Git button: three files not committed, as the view lists them; no branch to compare with', [n.isRepo, n.uncommitted, uniqueFiles(g), n.branch, n.problem], [true, 3, 3, null, 'no-base']);

  const readme = await h.call<Versions>('GET', '/workspace/git/file?area=changes&path=README.md');
  t.check('a changed file: as it is in the index, and as it is on disk', [readme.status, readme.before, readme.after], ['M', '# fixture\n', '# fixture\nmore\n']);
  const fresh = await h.call<Versions>('GET', `/workspace/git/file?area=changes&path=${encodeURIComponent('docs/new.md')}`);
  t.check('a file git does not track: nothing before, the file after', [fresh.status, fresh.before, fresh.after], ['U', null, 'one\ntwo\nthree\n']);
  const inIndex = await h.call<Versions>('GET', '/workspace/git/file?area=staged&path=staged.txt');
  t.check('a staged file: nothing in HEAD, the index after', [inIndex.status, inIndex.before, inIndex.after], ['A', null, 'in the index\n']);

  console.log('\n--- a commit and its files, a rename among them ---');
  h.git('add', '-A');
  h.git('mv', 'README.md', 'READ.md');
  h.git('commit', '-q', '-m', 'second: docs and a rename');
  g = await h.call<Git>('GET', '/workspace/git');
  t.check('committed: nothing left to show, two commits', [g.staged, g.changes, g.commits.map((c) => c.subject)], [[], [], ['second: docs and a rename', 'initial']]);
  n = await h.call<Counts>('GET', '/workspace/git/counts');
  t.check('the Git button after the commit: nothing not committed', n.uncommitted, 0);
  type Commit = { sha: string; subject: string; files: File[] };
  const second = await h.call<Commit>('GET', `/workspace/git/commit?sha=${g.commits[0]!.sha}`);
  t.check('the commit\'s files, the rename with its old name', brief(second.files).sort(), ['A docs/new.md +3 -0', 'A staged.txt +1 -0', 'R README.md -> READ.md +1 -0'].sort());
  const renamed = await h.call<Versions>('GET', `/workspace/git/file?area=commit&commit=${g.commits[0]!.short}&path=READ.md`);
  t.check('a file of the commit: its parent\'s version under the old name, and the commit\'s', [renamed.status, renamed.before, renamed.after], ['R', '# fixture\n', '# fixture\nmore\n']);
  const first = await h.call<Commit>('GET', `/workspace/git/commit?sha=${g.commits[1]!.sha}`);
  t.check('the first commit, against nothing', brief(first.files), ['A README.md +1 -0']);

  console.log('\n--- what it refuses, and that reading changes nothing ---');
  t.check('a path out of the folder', (await h.raw('GET', `/workspace/git/file?area=changes&path=${encodeURIComponent('../outside.txt')}`)).status, 400);
  t.check('git\'s own folder', (await h.raw('GET', `/workspace/git/file?area=commit&commit=${g.commits[0]!.sha}&path=${encodeURIComponent('.git/config')}`)).status, 400);
  t.check('a file the list does not name', (await h.raw('GET', '/workspace/git/file?area=changes&path=READ.md')).status, 400);
  t.check('something that is not a commit', (await h.raw('GET', `/workspace/git/commit?sha=${encodeURIComponent('HEAD; rm')}`)).status, 400);
  t.check('an area that is not one', (await h.raw('GET', '/workspace/git/file?area=stash&path=READ.md')).status, 400);
  put('later.txt', 'x\n');
  h.git('add', 'later.txt');
  const before = [h.git('status', '--porcelain'), h.git('rev-parse', 'HEAD'), h.git('stash', 'list')];
  await h.call('GET', '/workspace/git');
  await h.call('GET', '/workspace/git/file?area=staged&path=later.txt');
  await h.call('GET', `/workspace/git/commit?sha=${g.commits[0]!.sha}`);
  t.check('reading it staged, committed and stashed nothing', [h.git('status', '--porcelain'), h.git('rev-parse', 'HEAD'), h.git('stash', 'list')], before);
  t.truthy('(the earlier status was read as it was)', statusBefore.includes('A  staged.txt'), statusBefore);

  /*
   * Everything the branch changed, as a pull request shows it (operator, 2026-10-22: "all the files changed on this
   * branch, not only the ones not committed; and of them, which are not committed yet").
   */
  console.log('\n--- on this branch: its commits and what is not committed, against the branch it left ---');
  type BFile = File & { committed: boolean; uncommitted?: string };
  type Branch = { branch?: string; base?: string; bases: string[]; mergeBase?: string; ahead: number; behind: number; commits: string[]; files: BFile[]; problem?: string };
  const onMain = await h.call<Branch>('GET', '/workspace/git/branch');
  t.check('on main with no other branch: nothing to compare with, said so', [onMain.branch, onMain.problem, onMain.bases], ['main', 'no-base', []]);
  h.git('commit', '-q', '-m', 'third: later');
  const left = h.git('rev-parse', 'HEAD');
  h.git('checkout', '-q', '-b', 'feature');
  put('READ.md', '# fixture\nmore\nfeature\n');
  put('feat.txt', 'a\nb\n');
  h.git('add', '-A');
  h.git('commit', '-q', '-m', 'feature work');
  h.git('checkout', '-q', 'main');
  put('main-only.txt', 'main\n');
  h.git('add', '-A');
  h.git('commit', '-q', '-m', 'main moves on');
  h.git('checkout', '-q', 'feature');
  // Not committed: a committed file changed again, a new file staged, one staged and changed since, one git does not track.
  put('feat.txt', 'a\nb\nc\n');
  put('staged2.txt', 'x\n');
  h.git('add', 'staged2.txt');
  put('docs/new.md', 'one\ntwo\nthree\nfour\n');
  h.git('add', 'docs/new.md');
  put('docs/new.md', 'one\ntwo\nthree\nfour\nfive\n');
  put('loose.txt', 'loose\n');
  const quiet = [h.git('status', '--porcelain'), h.git('rev-parse', 'HEAD')];
  const b = await h.call<Branch>('GET', '/workspace/git/branch');
  t.check(
    'against main, where the branch left it: one commit ahead, one behind',
    [b.branch, b.base, b.bases.includes('main') && !b.bases.includes('feature'), b.mergeBase, b.ahead, b.behind, b.commits.length],
    ['feature', 'main', true, left, 1, 1, 1],
  );
  t.check(
    'every file of the branch, committed and not, each marked; not main\'s own',
    b.files.map((f) => `${f.status} ${f.path} +${f.added} -${f.removed} ${f.committed ? 'committed' : '-'} ${f.uncommitted ?? '-'}`),
    [
      'M READ.md +1 -0 committed -',
      'M docs/new.md +2 -0 - mixed',
      'A feat.txt +3 -0 committed changes',
      'A loose.txt +1 -0 - untracked',
      'A staged2.txt +1 -0 - staged',
    ],
  );
  const feat = await h.call<Versions>('GET', '/workspace/git/file?area=branch&commit=main&path=feat.txt');
  t.check('a file of the branch: nothing where it began, as it is now after', [feat.status, feat.before, feat.after], ['A', null, 'a\nb\nc\n']);
  const read = await h.call<Versions>('GET', '/workspace/git/file?area=branch&commit=main&path=READ.md');
  t.check('another: as it was where the branch began, and as it is now', [read.before, read.after], ['# fixture\nmore\n', '# fixture\nmore\nfeature\n']);
  const odd = await h.call<Branch>('GET', `/workspace/git/branch?base=${encodeURIComponent('--output=x')}`);
  t.check('a base that is no branch is not passed on: the default is used', [odd.base, odd.files.length], ['main', 5]);
  t.check('main\'s own file is not one of the branch\'s', (await h.raw('GET', '/workspace/git/file?area=branch&commit=main&path=main-only.txt')).status, 400);

  // The Git button's numbers are the views' own: the files not committed, and every file "On this branch" lists.
  g = await h.call<Git>('GET', '/workspace/git');
  n = await h.call<Counts>('GET', '/workspace/git/counts');
  t.check(
    'the Git button on the branch: four not committed and five on the branch, as the two views list them',
    [n.uncommitted, uniqueFiles(g), b.files.filter((f) => f.uncommitted).length, n.branch, b.files.length, n.base],
    [4, 4, 4, 5, 5, 'main'],
  );
  t.check('a file staged and changed again is one file, not two', [g.staged.some((f) => f.path === 'docs/new.md'), g.changes.some((f) => f.path === 'docs/new.md')], [true, true]);
  // Committed on the branch and undone in the working tree: still one of the branch's, as the view keeps it.
  put('READ.md', '# fixture\nmore\n');
  const undone = await h.call<Branch>('GET', '/workspace/git/branch');
  n = await h.call<Counts>('GET', '/workspace/git/counts');
  t.check('a committed change undone: still counted on the branch, as the view lists it', [n.branch, undone.files.length, undone.files.some((f) => f.path === 'READ.md'), n.uncommitted], [5, 5, true, 5]);
  put('READ.md', '# fixture\nmore\nfeature\n');
  n = await h.call<Counts>('GET', `/workspace/git/counts?base=${encodeURIComponent('--output=x')}`);
  t.check('the counts, too: a base that is no branch is not passed on', [n.base, n.branch], ['main', 5]);
  t.check('reading the branch and its counts changed nothing', [h.git('status', '--porcelain'), h.git('rev-parse', 'HEAD')], quiet);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h?.stop();
}
t.finish();
