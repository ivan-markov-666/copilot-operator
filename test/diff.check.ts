/**
 * The side-by-side diff: the line diff is correct and shortest, the rows pair an edited line with
 * what it became, unchanged stretches fold, and the server lists and reads a task's changed files
 * from a real repository — renames, additions, deletions, a binary file, and a path it was not
 * asked about refused.
 *
 *   npm run check:diff
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { changedSpan, diffLines, foldRows, linesOf, sideBySide } from '../web/lib/lineDiff.js';
import { changedFilesBetween, commitAll, fileAt, git } from '../src/vcs/git.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

/** The length of the longest common subsequence, by the textbook table: the minimum to compare to. */
function lcs(a: string[], b: string[]): number {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) t[i]![j] = a[i - 1] === b[j - 1] ? t[i - 1]![j - 1]! + 1 : Math.max(t[i - 1]![j]!, t[i]![j - 1]!);
  return t[a.length]![b.length]!;
}

console.log('--- the line diff is right and shortest ---');
{
  let seed = 7;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  let rebuiltAll = true;
  let shortestAll = true;
  for (let round = 0; round < 500; round += 1) {
    const a = Array.from({ length: rand(30) }, () => 'abcde'[rand(5)]!);
    const b = Array.from({ length: rand(30) }, () => 'abcde'[rand(5)]!);
    const ops = diffLines(a, b);
    const fromA = ops.filter((o) => o.kind !== 'add').map((o) => a[o.a!]);
    const toB = ops.filter((o) => o.kind !== 'del').map((o) => b[o.b!]);
    const sameOk = ops.filter((o) => o.kind === 'same').every((o) => a[o.a!] === b[o.b!]);
    if (JSON.stringify(fromA) !== JSON.stringify(a) || JSON.stringify(toB) !== JSON.stringify(b) || !sameOk) rebuiltAll = false;
    if (ops.filter((o) => o.kind === 'same').length !== lcs(a, b)) shortestAll = false;
  }
  check('500 random pairs: both texts are rebuilt from the operations', rebuiltAll, true);
  check('and it keeps as many lines as the longest common subsequence', shortestAll, true);
  check('identical texts: nothing but same lines', diffLines(['x', 'y'], ['x', 'y']).every((o) => o.kind === 'same'), true);
  check('a trailing newline is not a line', linesOf('a\nb\n'), ['a', 'b']);
  check('CRLF lines read as the same lines', linesOf('a\r\nb'), ['a', 'b']);
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  const bigAfter = big.map((l, i) => (i % 2 === 0 ? `${l} changed` : l));
  const t0 = Date.now();
  const bigOps = diffLines(big, bigAfter);
  check('a file with 2500 changed lines still rebuilds', bigOps.filter((o) => o.kind !== 'del').length, 5000);
  check(`and is fast (${Date.now() - t0} ms)`, Date.now() - t0 < 3000, true);
}

console.log('\n--- the side-by-side rows ---');
{
  const rows = sideBySide(['a', 'b', 'c'], ['a', 'B', 'c', 'd']);
  check('an edited line sits opposite what it became', rows.map((r) => r.kind), ['same', 'change', 'same', 'add']);
  check('with both line numbers', [rows[1]!.left!.no, rows[1]!.right!.no, rows[3]!.right!.no], [2, 2, 4]);
  const long = sideBySide(Array.from({ length: 40 }, (_, i) => `l${i}`), Array.from({ length: 40 }, (_, i) => (i === 20 ? 'changed' : `l${i}`)));
  const folded = foldRows(long, 3);
  check('unchanged stretches fold, three lines of context kept', folded.map((f) => (f.type === 'gap' ? `gap${f.count}` : f.row.kind)).join(','), `gap17,same,same,same,change,same,same,same,gap16`);
  const opened = foldRows(long, 3, new Set([0]));
  check('an opened gap shows its lines', opened.filter((f) => f.type === 'gap').length, 1);
  check('"whole file" shows every row', foldRows(long, 3, new Set(), true).length, 40);
  check('the changed part of a line', changedSpan('const a = 1;', 'const a = 12;'), { start: 11, leftEnd: 11, rightEnd: 12 });
}

console.log('\n--- a real repository ---');
{
  const repo = await mkdtemp(join(tmpdir(), 'cop-diff-'));
  try {
    await git(repo, ['init', '-b', 'main']);
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', 'keep.ts'), '  indented first line\nexport const a = 1;\n');
    await writeFile(join(repo, 'old name.ts'), 'moved content\nstays the same\nfor a rename\n');
    await writeFile(join(repo, 'gone.ts'), 'bye\n');
    await commitAll(repo, 'base');
    const base = (await git(repo, ['rev-parse', 'HEAD'])).stdout;
    await writeFile(join(repo, 'src', 'keep.ts'), '  indented first line\nexport const a = 2;\n');
    await git(repo, ['mv', 'old name.ts', 'new name.ts']);
    await git(repo, ['rm', '-q', 'gone.ts']);
    await writeFile(join(repo, 'added.ts'), 'hello\n');
    await writeFile(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]));
    await commitAll(repo, 'task');
    const commit = (await git(repo, ['rev-parse', 'HEAD'])).stdout;

    const { files } = await changedFilesBetween(repo, base, commit);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    check('a modified file', [byPath['src/keep.ts']?.status, byPath['src/keep.ts']?.added, byPath['src/keep.ts']?.removed], ['M', 1, 1]);
    check('a rename, with a space in the name', [byPath['new name.ts']?.status, byPath['new name.ts']?.oldPath], ['R', 'old name.ts']);
    check('an addition and a deletion', [byPath['added.ts']?.status, byPath['gone.ts']?.status], ['A', 'D']);
    check('a binary file counts no lines', [byPath['blob.bin']?.added, byPath['blob.bin']?.removed], [-1, -1]);
    const before = await fileAt(repo, base, 'src/keep.ts', 1_000_000);
    check('file contents come back untrimmed', before.bytes?.toString('utf8'), '  indented first line\nexport const a = 1;\n');
    check('a file that did not exist is null', (await fileAt(repo, base, 'added.ts', 1_000_000)).bytes, null);
    check('a file over the limit is said to be', (await fileAt(repo, commit, 'src/keep.ts', 5)).tooLarge, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

console.log('\n--- the service: only a changed file can be read ---');
{
  const repo = await mkdtemp(join(tmpdir(), 'cop-diff-svc-'));
  const data = await mkdtemp(join(tmpdir(), 'cop-diff-data-'));
  process.env.COP_DATA_DIR = data;
  try {
    await git(repo, ['init', '-b', 'main']);
    await writeFile(join(repo, 'secret.txt'), 'not for this viewer\n');
    await writeFile(join(repo, 'a.ts'), 'one\n');
    await commitAll(repo, 'base');
    const base = (await git(repo, ['rev-parse', 'HEAD'])).stdout;
    await writeFile(join(repo, 'a.ts'), 'two\n');
    await commitAll(repo, 'task');
    const commit = (await git(repo, ['rev-parse', 'HEAD'])).stdout;
    const { OperatorService } = await import('../src/api/operator.service.js');
    const ops = new OperatorService();
    await ops.store.init();
    const s = await ops.store.createSession('diffs');
    await ops.store.updateSession(s.id, (x) => {
      x.vcs = { enabled: true, repoDir: repo, branchMode: 'per-task', commitOnFinish: true, branchPrefix: 'cop/' };
    });
    const t = await ops.store.addTask(s.id, { title: 'edit a', level2: '', prompt: 'p' });
    await ops.store.updateTask(s.id, t.id, (x) => {
      x.status = 'done';
      x.runId = 'run-1';
      x.vcs = { branch: 'cop/diffs-edit-a', baseCommit: base, commit, files: [{ path: 'a.ts', added: 1, removed: 1 }] };
    });
    const changes = await ops.taskChanges(s.id, t.id);
    check('the task lists its one changed file', changes.files.map((f) => f.path), ['a.ts']);
    const file = await ops.taskChangeFile(s.id, t.id, 'a.ts');
    check('and reads it before and after', [file.before, file.after], ['one\n', 'two\n']);
    let refused = '';
    await ops.taskChangeFile(s.id, t.id, 'secret.txt').catch((e: Error) => (refused = e.message));
    check('a file the task did not change is refused', /not one this task changed/.test(refused), true);
    const other = await ops.store.addTask(s.id, { title: 'no vcs', level2: '', prompt: 'p' });
    const none = await ops.taskChanges(s.id, other.id);
    check('a task with no commit says why', [none.ok, /not on/.test(none.problem ?? '')], [false, true]);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
}

console.log(`\nwrong: ${wrong} (expect 0)`);
if (wrong > 0) process.exitCode = 1;
