import { mirrorProject, collectFiles, listSelectableDirs, flattenName, unflattenName, describeMirror, findSelectionConflicts, describeConflicts, DEFAULT_SEPARATOR } from '../src/context/projectMirror.js';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(tmpdir(), 'cop-mirror-src');
const target = join(tmpdir(), 'cop-mirror-dst');
await rm(root, { recursive: true, force: true });
await rm(target, { recursive: true, force: true });

const w = async (rel: string, body: string) => {
  const p = join(root, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, body);
};
await w('src/test/example-test.spec.ts', 'describe("x", () => {});\n');
await w('src/app.ts', 'export const a = 1;\n');
await w('src/lib/util.java', 'class U {}\n');
await w('docs/readme.md', '# hi\n');
await w('secrets/.env', 'TOKEN=abc\n');
await w('node_modules/pkg/index.js', 'module.exports = 1;\n');
await w('dist/bundle.js', 'bundled\n');
await w('scripts/deploy.php', '<?php ?>\n');
await writeFile(join(root, '.gitignore'), 'ignored-folder/\n*.log\n');
await w('ignored-folder/x.ts', 'nope\n');
await w('src/debug.log', 'noise\n');

console.log('--- naming convention ---');
const used = new Set<string>();
console.log('src/test/example-test.spec.ts ->', flattenName('src/test/example-test.spec.ts', used));
console.log('back again                   ->', unflattenName('src--test--example-test.spec.ts.txt'));
const u2 = new Set<string>();
console.log('collision a/b.ts             ->', flattenName('a/b.ts', u2));
console.log('collision a--b.ts            ->', flattenName('a--b.ts', u2), '(suffix added)');
console.log('replace mode                 ->', flattenName('src/app.ts', new Set(), DEFAULT_SEPARATOR, 'replace'));

console.log('\n--- selectable directories ---');
console.log((await listSelectableDirs(root)).join(', '));

console.log('\n--- selection: only src and docs ---');
const cfg = { rootDir: root, includeDirs: ['src', 'docs'], targetDir: target };
const picked = await collectFiles(cfg);
console.log('files  :', picked.files.join(', '));
console.log('skipped:', picked.skipped.map((s) => `${s.relPath} (${s.reason})`).join(', ') || '(none)');

console.log('\n--- run 1 ---');
let r = await mirrorProject(cfg);
console.log(describeMirror(r));
console.log('folder :', (await readdir(target)).join(', '));

console.log('\n--- run 2, nothing edited ---');
r = await mirrorProject(cfg);
console.log(describeMirror(r));

console.log('\n--- run 3: edit one, add one, delete one ---');
await w('src/app.ts', 'export const a = 999;\n');
await w('src/new-file.ts', 'export const n = 0;\n');
await rm(join(root, 'docs/readme.md'));
r = await mirrorProject(cfg);
console.log(describeMirror(r));
console.log('added   :', r.added.join(', '));
console.log('updated :', r.updated.join(', '));
console.log('deleted :', r.deleted.join(', '));

console.log('\n--- run 4: user deselects docs, selects scripts ---');
r = await mirrorProject({ ...cfg, includeDirs: ['src', 'scripts'] });
console.log(describeMirror(r), '| added:', r.added.join(', '));

console.log('\n--- whole project with an exclusion ---');
r = await mirrorProject({ ...cfg, includeDirs: ['.'], excludeDirs: ['secrets'] });
console.log(describeMirror(r));
console.log('folder :', (await readdir(target)).sort().join(', '));

// ---------------------------------------------------------------------------------------
// The two switches: .gitignore, and .env files which .gitignore may not decide
// ---------------------------------------------------------------------------------------

console.log('\n--- .gitignore that also lists the env files ---');
await writeFile(join(root, '.gitignore'), 'ignored-folder/\n*.log\n.env\n.env.*\nsecrets/\n');
await w('.env', 'ROOT_TOKEN=1\n');
await w('.env.local', 'LOCAL=2\n');
await w('secrets/.env.prod', 'PROD=3\n');

const whole = { rootDir: root, includeDirs: ['.'], targetDir: target };
const envOf = (r: { files: string[] }) => r.files.filter((f) => f.includes('.env')).join(', ') || '(none)';

let r2 = await collectFiles({ ...whole, respectGitignore: true, includeEnvFiles: false });
console.log('gitignore on,  env off -> env files copied:', envOf(r2));
console.log('                          reported as skipped:', r2.skipped.filter((s) => s.relPath.includes('.env')).map((s) => s.relPath).join(', ') || '(none)');

r2 = await collectFiles({ ...whole, respectGitignore: true, includeEnvFiles: true });
console.log('gitignore on,  env on  -> env files copied:', envOf(r2), '(.gitignore lists them and is overruled)');
console.log('                          ignored-folder pulled in too?', r2.files.some((f) => f.startsWith('ignored-folder/')) ? 'yes (wrong)' : 'no');
console.log('                          taken from ignored secrets/:', r2.files.filter((f) => f.startsWith('secrets/')).join(', '));

r2 = await collectFiles({ ...whole, respectGitignore: false, includeEnvFiles: false });
console.log('gitignore off, env off -> env files copied:', envOf(r2), '(the env switch stands alone)');
console.log('                          gitignored log copied?', r2.files.includes('src/debug.log') ? 'yes' : 'no');

r2 = await collectFiles({ ...whole, respectGitignore: false, includeEnvFiles: true });
console.log('gitignore off, env on  -> env files copied:', envOf(r2));

console.log('\n--- the same directory in both lists ---');
for (const [inc, exc] of [
  [['src', 'docs'], ['src']],
  [['src/lib'], ['src']],
  [['src'], ['src/generated']],
  [['.'], ['secrets']],
] as Array<[string[], string[]]>) {
  const conflicts = findSelectionConflicts(inc, exc);
  console.log(`include [${inc}] exclude [${exc}] ->`, conflicts.length ? describeConflicts(conflicts) : 'fine');
}
console.log('case and slashes :', describeConflicts(findSelectionConflicts(['Src'], ['.\\src\\'])) || 'not caught (wrong)');

try {
  await collectFiles({ ...whole, includeDirs: ['src'], excludeDirs: ['src'] });
  console.log('mirroring it     : not refused (wrong)');
} catch (e) {
  console.log('mirroring it     :', (e as Error).message);
}

await rm(root, { recursive: true, force: true });
await rm(target, { recursive: true, force: true });
