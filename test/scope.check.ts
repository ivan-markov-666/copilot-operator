/**
 * A task's scope (src/vcs/scope.ts): which paths the patterns cover, and that a change outside them
 * is put back — a changed file restored, a deleted one brought back, a new one removed — while the
 * changes inside stay.
 *
 *   npm run check:scope
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { enforceScope, inScope } from '../src/vcs/scope.js';
import { makeRepo, Tally } from './support/harness.js';

const t = new Tally();

console.log('--- what a scope covers ---');
const suite = ['tests/e2e/editor.spec.ts', 'pages/EditorPage.ts'];
t.check('a file named exactly', inScope('pages/EditorPage.ts', suite), true);
t.check('ignoring case, as Windows does', inScope('Pages/editorpage.ts', suite), true);
t.check('another file beside it is not', inScope('pages/HomePage.ts', suite), false);
t.check('a folder with a slash covers everything under it', inScope('tests/e2e/deep/a.spec.ts', ['tests/e2e/']), true);
t.check('a folder without one too', inScope('tests/e2e/a.spec.ts', ['tests/e2e']), true);
t.check('but not a folder that only starts the same', inScope('tests/e2e-old/a.spec.ts', ['tests/e2e']), false);
t.check('* stays inside one folder', [inScope('src/a.ts', ['src/*.ts']), inScope('src/x/a.ts', ['src/*.ts'])], [true, false]);
t.check('** crosses folders', [inScope('src/x/y/a.ts', ['src/**/*.ts']), inScope('src/a.ts', ['src/**/*.ts'])], [true, true]);
t.check('backslashes in a path are the same path', inScope('tests\\e2e\\a.spec.ts', ['tests/e2e/']), true);
t.check('an empty scope allows everything', inScope('anything/at/all.txt', []), true);

console.log('\n--- what is put back ---');
const base = await mkdtemp(join(tmpdir(), 'cop-scope-'));
try {
  await makeRepo(base);
  const git = (...args: string[]): string => execFileSync('git', ['-C', base, ...args], { encoding: 'utf8' }).trim();
  mkdirSync(join(base, 'tests'), { recursive: true });
  mkdirSync(join(base, 'shared'), { recursive: true });
  writeFileSync(join(base, 'tests', 'a.spec.ts'), 'old test\n');
  writeFileSync(join(base, 'shared', 'fixture.ts'), 'shared\n');
  writeFileSync(join(base, 'shared', 'keep.ts'), 'keep\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'files');

  // The task: inside its scope it edits a test and adds one; outside it edits a fixture, deletes a
  // file and creates two new ones, one in a new folder.
  writeFileSync(join(base, 'tests', 'a.spec.ts'), 'new test\n');
  writeFileSync(join(base, 'tests', 'b.spec.ts'), 'added test\n');
  writeFileSync(join(base, 'shared', 'fixture.ts'), 'changed by the task\n');
  rmSync(join(base, 'shared', 'keep.ts'));
  writeFileSync(join(base, 'stray.txt'), 'stray\n');
  mkdirSync(join(base, 'newdir'), { recursive: true });
  writeFileSync(join(base, 'newdir', 'x.ts'), 'x\n');

  const r = await enforceScope(base, ['tests/']);
  t.check('everything outside was found', [...r.outside].sort(), ['newdir/x.ts', 'shared/fixture.ts', 'shared/keep.ts', 'stray.txt']);
  t.check('and put back', [...r.reverted].sort(), ['newdir/x.ts', 'shared/fixture.ts', 'shared/keep.ts', 'stray.txt']);
  t.check('nothing failed', r.failed, []);
  t.check('the changed file has its old text', readFileSync(join(base, 'shared', 'fixture.ts'), 'utf8'), 'shared\n');
  t.check('the deleted file is back', existsSync(join(base, 'shared', 'keep.ts')), true);
  t.check('the new files are gone, with the folder made for them', [existsSync(join(base, 'stray.txt')), existsSync(join(base, 'newdir'))], [false, false]);
  t.check('the work inside the scope is untouched', [readFileSync(join(base, 'tests', 'a.spec.ts'), 'utf8'), readFileSync(join(base, 'tests', 'b.spec.ts'), 'utf8')], ['new test\n', 'added test\n']);
  t.check('and it is all that is left changed', git('status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.trim()).sort(), ['?? tests/b.spec.ts', 'M tests/a.spec.ts']);
} finally {
  await rm(base, { recursive: true, force: true }).catch(() => undefined);
}

t.finish();
