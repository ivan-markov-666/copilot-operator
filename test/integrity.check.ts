/**
 * The runner's own check on the text a task wrote (src/vcs/contentIntegrity.ts): what it finds,
 * and that it blames a task only for what the task added.
 *
 *   npm run check:integrity
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lineEndingRule, newProblems, scanChanges, traitsOf } from '../src/vcs/contentIntegrity.js';
import { Tally } from './support/harness.js';

const t = new Tally();
const b = (s: string): Buffer => Buffer.from(s, 'utf8');
const kinds = (path: string, now: Buffer, before: Buffer | null = null): string[] => newProblems(path, now, before).map((f) => f.kind).sort();

console.log('--- what it finds in a new file ---');
t.check('clean UTF-8 text, Bulgarian included', kinds('a.md', b('# Заглавие\nРабота по задачата: Ра, Ре, Ри.\n')), []);
t.check('a byte-order mark in JSON', kinds('config.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b('{"a":1}\n')])), ['bom']);
t.check('a byte-order mark in a new .txt is left alone', kinds('notes.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b('hello\n')])), []);
t.check('the replacement character', kinds('a.ts', b('const s = "caf�";\n')), ['replacement-char']);
t.check('Latin mojibake (UTF-8 read as Windows-1252)', kinds('a.md', b('CafÃ© and itâ€™s broken\n')), ['mojibake']);
t.check('Cyrillic mojibake (UTF-8 read as Windows-1251)', kinds('a.md', b('Р—Р°РґР°С‡Р°\n')), ['mojibake']);
t.check('Cyrillic mojibake (UTF-8 read as Windows-1252)', kinds('a.md', b('Ð—Ð°Ð´Ð°Ñ‡Ð°\n')), ['mojibake']);
t.check('terminal colour codes', kinds('out.txt', b('\u001B[32mPASS\u001B[0m\n')), ['control-chars']);
t.check('mixed line endings', kinds('a.ts', b('one\r\ntwo\nthree\r\n')), ['mixed-line-endings']);
t.check('all CRLF is fine', kinds('a.ts', b('one\r\ntwo\r\n')), []);
t.check('NUL bytes in a text file', kinds('a.txt', Buffer.from([0x61, 0x00, 0x62])), ['binary-in-text']);
t.check('a picture is not looked into', kinds('logo.png', Buffer.from([0x89, 0x50, 0x00, 0xef, 0xbb, 0xbf])), []);
t.check('a private key', kinds('id.txt', b('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n')), ['secret']);
t.check('a GitHub token', kinds('a.env.ts', b(`const t = "ghp_${'a'.repeat(36)}";\n`)), ['secret']);
t.check('a password in a test fixture is not a secret by shape', kinds('fixture.ts', b('const password = "secret";\n')), []);
t.check('a file over 1 MB', kinds('dump.json', b('x'.repeat(1024 * 1024 + 10))), ['oversized']);

console.log('\n--- only what the task added ---');
const mixed = b('one\r\ntwo\n');
t.check('mixed line endings that were already there', kinds('old.ts', b('one\r\ntwo\nthree\n'), mixed), []);
t.check('a BOM a changed file already had', kinds('old.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b('x\n')]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b('y\n')])), []);
t.check('a BOM a changed .txt did not have', kinds('old.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b('x\n')]), b('y\n')), ['bom']);
t.check('a big file that was already big', kinds('big.json', b('x'.repeat(1024 * 1024 + 20)), b('x'.repeat(1024 * 1024 + 10))), []);

console.log('\n--- the description says what it saw ---');
t.truthy('mojibake is quoted', (traitsOf('a.md', b('CafÃ© and itâ€™s')).mojibake ?? '').includes('Ã©'), traitsOf('a.md', b('CafÃ© and itâ€™s')));

console.log('\n--- line endings against the file before and the repository (live run 2026-10-03) ---');
{
  const ends = (path: string, now: Buffer, before: Buffer | null, rule: Parameters<typeof newProblems>[3]): string[] => newProblems(path, now, before, rule).map((f) => f.kind).sort();
  const lf = { normalized: false, style: 'lf' as const };
  t.check('a whole file turned from LF to CRLF', ends('limits.json', b('{\r\n  "max": 10\r\n}\r\n'), b('{\n  "max": 5\n}\n'), lf), ['line-endings-changed']);
  t.check('and from CRLF to LF', ends('a.txt', b('a\nb\n'), b('a\r\nb\r\n'), { normalized: false }), ['line-endings-changed']);
  t.check('kept as it was', ends('limits.json', b('{\n  "max": 10\n}\n'), b('{\n  "max": 5\n}\n'), lf), []);
  t.check("a new CRLF file is not held to the repository's style (Set-Content writes CRLF)", ends('new.mjs', b('export const a = 1;\r\n'), null, lf), []);
  t.check('a new LF file in an LF repository', ends('new.mjs', b('export const a = 1;\n'), null, lf), []);
  t.check('a new file where the repository has no clear style', ends('new.mjs', b('x\r\n'), null, { normalized: false }), []);
  // What Set-Content does to a here-string: LF lines, then a CRLF it adds after the last one.
  t.check('Set-Content after a here-string: mixed, where git does not convert', ends('cart.mjs', b('a\nb\r\n'), null, lf), ['mixed-line-endings']);
  t.check('nothing about line endings where git converts them on commit', ends('cart.mjs', b('a\nb\r\n'), b('a\n'), { normalized: true }), []);
  t.check('nor a flip there', ends('a.txt', b('a\r\nb\r\n'), b('a\nb\n'), { normalized: true }), []);

  const dir = mkdtempSync(join(tmpdir(), 'cop-eol-'));
  try {
    const git = (...a: string[]): string => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'e@example.invalid');
    git('config', 'user.name', 'e');
    git('config', 'core.autocrlf', 'false');
    for (const n of ['a.js', 'b.js', 'c.json']) writeFileSync(join(dir, n), 'x\ny\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'lf');
    const base = git('rev-parse', 'HEAD');
    t.check('an LF repository is read as LF', await lineEndingRule(dir), { normalized: false, style: 'lf' });
    writeFileSync(join(dir, 'c.json'), 'x\r\ny\r\n');
    t.check('the scan finds the flip', (await scanChanges(dir, ['c.json'], base)).map((f) => f.kind), ['line-endings-changed']);
    git('config', 'core.autocrlf', 'true');
    t.check('with core.autocrlf true, git converts: nothing to say', [await lineEndingRule(dir), (await scanChanges(dir, ['c.json'], base)).map((f) => f.kind)], [{ normalized: true }, []]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

t.finish();
