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
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h?.stop();
}
t.finish();
