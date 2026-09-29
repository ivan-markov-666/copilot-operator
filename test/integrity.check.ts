/**
 * The runner's own check on the text a task wrote (src/vcs/contentIntegrity.ts): what it finds,
 * and that it blames a task only for what the task added.
 *
 *   npm run check:integrity
 */
import { newProblems, traitsOf } from '../src/vcs/contentIntegrity.js';
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

t.finish();
