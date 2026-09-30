/**
 * The project mirror never deletes the copies the chat works from because of a selection it could
 * not resolve, and finds a folder a plan named in the repository when the root is the folder above.
 *
 * Seen live on 2026-09-30: `rules-engine` was reported "not a directory under the project root"
 * although the repository had it, and the mirror then deleted the whole context folder (totalBytes 0).
 *
 *   npm run check:mirrorsafety
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorProject, MirrorSelectionError, resolveIncludeDirs } from '../src/context/projectMirror.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const scratch = await mkdtemp(join(tmpdir(), 'cop-mirrorsafety-'));
const put = async (path: string, body: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
};
const refusal = async (p: Promise<unknown>): Promise<string | null> =>
  p.then(() => null, (e: unknown) => (e instanceof MirrorSelectionError ? e.message : `other error: ${(e as Error).message}`));

try {
  const root = join(scratch, 'project');
  const repo = join(root, 'rules-tests');
  const target = join(scratch, 'desktop', 'project');
  await put(join(root, 'docs', 'readme.md'), '# docs\n');
  await put(join(repo, 'rules-engine', 'engine.ts'), 'export const e = 1;\n');
  await put(join(repo, 'rules-engine', 'rules', 'a.yaml'), 'a: 1\n');
  await mkdir(join(root, 'empty'), { recursive: true });

  console.log('--- a selection that resolves is copied ---');
  const first = await mirrorProject({ rootDir: root, includeDirs: ['docs'], targetDir: target });
  check('the files are copied', first.added, ['docs--readme.md.txt']);
  const before = (await readdir(target)).sort();

  console.log('\n--- a folder that is nowhere: nothing copied, nothing deleted ---');
  const missing = await refusal(mirrorProject({ rootDir: root, includeDirs: ['rules-engine'], targetDir: target }));
  check('it is refused, naming the folder', /"rules-engine" is not a folder under the project root/.test(missing ?? ''), true);
  check('and saying the copies were kept', /left as they are/.test(missing ?? ''), true);
  check('the copies already there are all still there', (await readdir(target)).sort(), before);
  const mixed = await refusal(mirrorProject({ rootDir: root, includeDirs: ['docs', 'nowhere'], targetDir: target }));
  check('one good folder and one missing: still refused, not half-copied', mixed !== null && (await readdir(target)).sort().join() === before.join(), true);

  console.log('\n--- a selection with no file in it: nothing deleted ---');
  const empty = await refusal(mirrorProject({ rootDir: root, includeDirs: ['empty'], targetDir: target }));
  check('refused as holding no file', /holds no file/.test(empty ?? ''), true);
  check('the copies are still there', (await readdir(target)).sort(), before);

  console.log('\n--- the folder a plan named, found in the repository ---');
  const resolved = await resolveIncludeDirs(root, ['rules-engine', 'docs'], [repo]);
  check('taken from the repository, as a path under the root', resolved.found, ['rules-tests/rules-engine', 'docs']);
  check('and said', resolved.moved, [{ asked: 'rules-engine', used: 'rules-tests/rules-engine' }]);
  const fromRepo = await mirrorProject({ rootDir: root, includeDirs: ['rules-engine'], targetDir: target, alsoUnder: [repo] });
  check('the repository folder is copied', fromRepo.added.sort(), ['rules-tests--rules-engine--engine.ts.txt', 'rules-tests--rules-engine--rules--a.yaml.txt']);

  const outside = join(scratch, 'elsewhere');
  await put(join(outside, 'rules-engine', 'x.ts'), 'x\n');
  const notInside = await refusal(mirrorProject({ rootDir: root, includeDirs: ['rules-engine'], targetDir: target, alsoUnder: [outside] }));
  check('found only outside the root: refused, saying where it is', /not inside the project root/.test(notInside ?? ''), true);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log(wrong === 0 ? '\nall good' : `\n${wrong} wrong`);
process.exit(wrong === 0 ? 0 : 1);
