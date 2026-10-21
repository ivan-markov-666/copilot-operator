/**
 * Searching the open folder's code, as VS Code's Search view does (operator, 2026-10-21). Held here on a real
 * repository: the default finds any case; Match Case, Match Whole Word and a regular expression narrow it; the files
 * to include and to exclude are globs as VS Code takes them; what .gitignore leaves out and files that are not text
 * are not searched, files not committed yet are; a long line is cut around its match, with where the match is in the
 * line itself; a pattern that is not valid is said; a folder that is not a repository is searched as it is; the API
 * route takes the options and refuses to run with no folder; a picture of the folder is served for a preview, nothing
 * else.
 *
 *   npm run check:search
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchWorkspace, rangesIn } from '../src/session/workspaceSearch.js';
import { startHarness, Tally } from './support/harness.js';

const t = new Tally();
const base = await mkdtemp(join(tmpdir(), 'cop-search-'));
process.once('exit', () => rmSync(base, { recursive: true, force: true }));

const repo = join(base, 'repo');
mkdirSync(join(repo, 'src', 'api'), { recursive: true });
mkdirSync(join(repo, 'dist'), { recursive: true });
mkdirSync(join(repo, 'docs'), { recursive: true });
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, '-c', 'user.name=op', '-c', 'user.email=op@example.com', ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, '.gitignore'), 'dist/\n*.log\n');
writeFileSync(join(repo, 'src', 'app.ts'), 'export function loginUser(name: string) {\n  return LoginUser(name);\n}\nconst login = 1;\n');
writeFileSync(join(repo, 'src', 'api', 'routes.ts'), 'router.get("/login", login);\n');
writeFileSync(join(repo, 'docs', 'notes.md'), '# Login\nHow to log in: `login --user`.\n');
writeFileSync(join(repo, 'dist', 'bundle.js'), 'function login(){}\n');
writeFileSync(join(repo, 'debug.log'), 'login failed\n');
writeFileSync(join(repo, 'image.bin'), Buffer.from([0, 1, 2, 108, 111, 103, 105, 110, 0]));
git('add', '-A');
git('commit', '-q', '-m', 'first');
writeFileSync(join(repo, 'src', 'new.ts'), 'login(); // not committed yet\n');
writeFileSync(join(repo, 'src', 'long.ts'), `${'x'.repeat(400)}login${'y'.repeat(400)}\n`);

const paths = (r: { files: Array<{ path: string }> }): string[] => r.files.map((f) => f.path).sort();

console.log('--- the search, as VS Code does it ---');
const any = await searchWorkspace(repo, 'login');
t.check(
  'any case, in every text file git keeps or will keep — not what .gitignore leaves out, not a binary file',
  paths(any),
  ['docs/notes.md', 'src/api/routes.ts', 'src/app.ts', 'src/long.ts', 'src/new.ts'],
);
t.check('the matches of a file, by line', any.files.find((f) => f.path === 'src/app.ts')?.matches.map((m) => m.line), [1, 2, 4]);
const first = any.files.find((f) => f.path === 'src/app.ts')!.matches[0]!;
t.check('each line with where its matches are', [first.text, first.ranges], ['export function loginUser(name: string) {', [[16, 21]]]);
t.check('Match Case', paths(await searchWorkspace(repo, 'LoginUser', { matchCase: true })), ['src/app.ts']);
t.check('and its line is only the one with the capitals', (await searchWorkspace(repo, 'LoginUser', { matchCase: true })).files[0]?.matches.map((m) => m.line), [2]);
t.check('Match Whole Word: login, not loginUser', (await searchWorkspace(repo, 'login', { wholeWord: true })).files.find((f) => f.path === 'src/app.ts')?.matches.map((m) => m.line), [4]);
t.check('a regular expression', (await searchWorkspace(repo, 'log(in|ged) ?--user', { regex: true })).files.map((f) => f.path), ['docs/notes.md']);
const bad = await searchWorkspace(repo, 'a(', { regex: true });
t.truthy('a pattern that is not valid is said', !!bad.problem && bad.total === 0, bad.problem);
t.check('files to include: *.ts in any folder', paths(await searchWorkspace(repo, 'login', { include: '*.ts' })), ['src/api/routes.ts', 'src/app.ts', 'src/long.ts', 'src/new.ts']);
t.check('a folder by its name', paths(await searchWorkspace(repo, 'login', { include: 'api' })), ['src/api/routes.ts']);
t.check('from the root, with a slash', paths(await searchWorkspace(repo, 'login', { include: 'docs/**' })), ['docs/notes.md']);
t.check('files to exclude', paths(await searchWorkspace(repo, 'login', { exclude: 'src' })), ['docs/notes.md']);
t.check('both, separated by commas', paths(await searchWorkspace(repo, 'login', { include: '*.ts, *.md', exclude: 'long.ts, new.ts' })), ['docs/notes.md', 'src/api/routes.ts', 'src/app.ts']);
const long = any.files.find((f) => f.path === 'src/long.ts')!.matches[0]!;
t.truthy('a long line is cut around its match, the match still marked', long.text.length < 260 && long.text.startsWith('…') && long.text.slice(long.ranges[0]![0], long.ranges[0]![1]) === 'login', long.text);
t.check('with where the match is in the line itself', [long.column, long.length], [400, 5]);
t.check('nothing to search for: nothing found, and git not asked', await searchWorkspace(repo, ''), { files: [], total: 0, truncated: false, ms: 0 });
t.check('the marks of a regular expression, as JavaScript reads it', rangesIn('a1 b22 c333', '\\d+', { regex: true }), [[1, 2], [4, 6], [8, 11]]);

const loose = join(base, 'loose');
mkdirSync(loose, { recursive: true });
writeFileSync(join(loose, 'readme.txt'), 'nothing here but login\n');
t.check('a folder that is not a repository is searched as it is', paths(await searchWorkspace(loose, 'login')), ['readme.txt']);

console.log('\n--- through the API ---');
{
  const h = await startHarness({});
  try {
    writeFileSync(join(h.repo, 'found.md'), 'The Needle is here.\n![a picture](pic.png)\n');
    writeFileSync(join(h.repo, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    type R = { files: Array<{ path: string; matches: Array<{ line: number }> }>; total: number };
    const r = await h.call<R>('GET', '/workspace/search?q=needle&case=&word=1&regex=&include=*.md&exclude=');
    t.check('the route takes the options', [r.total, r.files[0]?.path, r.files[0]?.matches[0]?.line], [1, 'found.md', 1]);
    t.check('Match Case through the route', (await h.call<R>('GET', '/workspace/search?q=needle&case=1')).total, 0);
    const pic = await h.raw('GET', '/workspace/raw?path=pic.png');
    t.check('a picture of the folder is served for a preview', pic.status, 200);
    const text = await h.raw('GET', '/workspace/raw?path=found.md');
    t.truthy('anything that is not a picture is not', text.status >= 400, text.status);
    const out = await h.raw('GET', '/workspace/raw?path=../outside.png');
    t.truthy('nor anything outside the folder', out.status >= 400, out.status);
  } finally {
    await h.stop();
  }
}

t.finish();
