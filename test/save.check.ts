/**
 * Saving a log where the operator can actually reach it.
 *
 * The log is not read in this product, it is handed on: the operator drags it into the chat
 * that orchestrates the whole effort. That makes the file name and the file's survival the
 * two things worth checking. Session names and task titles are prose, so they arrive carrying
 * colons and slashes that Windows will not accept in a name, and a name Windows refuses is a
 * save that fails for a reason nobody watching the browser can act on. And a log saved twice
 * must become two files: the first one may already be attached to a message somewhere, and
 * overwriting it would destroy something the bot has no claim on.
 *
 * Explorer is never launched here. The reveal is injected, so what is under test is that the
 * file lands and that the caller is told the truth about whether the folder was opened —
 * including on a machine that has no Explorer to open, where saving still has to work.
 *
 *   npm run check:save
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { freeName, logFileName, logsDir, sanitiseNamePart, saveAndReveal, LOGS_FOLDER } from '../src/api/saveToDesktop.js';

let wrong = 0;
const check = (label: string, got: unknown, expected: unknown): void => {
  const ok = got === expected;
  if (!ok) wrong += 1;
  console.log(`${ok ? '  ' : '!!'} ${label.padEnd(44)}:`, got, `(expect ${String(expected)})`);
};

// A Desktop of our own, so the real one is left alone and the folder can be watched appearing.
const home = await mkdtemp(join(tmpdir(), 'cop-save-'));
const env = { USERPROFILE: home } as NodeJS.ProcessEnv;
const desktop = join(home, 'Desktop');
const folder = join(desktop, LOGS_FOLDER);
const at = new Date(2026, 8, 22, 14, 30, 12);

console.log('--- the folder the logs go into ---');
console.log('under the Desktop, one folder   :', logsDir(env));
check('not loose on the Desktop itself', logsDir(env), folder);
check('does not exist before the first save', existsSync(folder), false);

console.log('\n--- a name Windows will accept ---');
const nasty = 'rules: engine/v2 <draft> "final"? *';
console.log('as written                      :', nasty);
console.log('as a file name                  :', sanitiseNamePart(nasty));
check('no character NTFS refuses', /[<>:"/\\|?*]/.test(sanitiseNamePart(nasty)), false);
check('a trailing dot is dropped', sanitiseNamePart('the plan.'), 'the plan');
check('a trailing space is dropped', sanitiseNamePart('the plan  '), 'the plan');
check('a name of nothing but punctuation still has one', sanitiseNamePart('///'), '---');
check('an empty name still has one', sanitiseNamePart('   '), 'unnamed');
check('a long name is cut, not refused', sanitiseNamePart('x'.repeat(200)).length <= 60, true);

console.log('\n--- what the name says ---');
const named = logFileName({ session: 'rules: engine', task: 'run the unit tests' }, at);
console.log('the task log                    :', named);
check('the session is in it', named.includes('rules- engine'), true);
check('the task is in it', named.includes('run the unit tests'), true);
check('when it was saved is in it', named.includes('2026-09-22-143012'), true);
check('it is text', named.endsWith('.txt'), true);
check('the attempt is left out when there is only one', named.includes('attempt'), false);

const secondAttempt = logFileName({ session: 's', task: 't', attempt: 2 }, at);
console.log('an earlier attempt              :', secondAttempt);
check('the attempt is named when there are several', secondAttempt.includes('attempt 2'), true);

const report = logFileName({ session: 's', task: 't', file: 'summary.md' }, at);
console.log('one of the task’s own files     :', report);
check('the file keeps its own extension', report.endsWith('.md'), true);
check('and its own name', report.includes('summary'), true);

console.log('\n--- a second save never lands on the first ---');
const taken = new Set([join(folder, 'a.txt'), join(folder, 'a (2).txt')]);
check('the first free name is offered', freeName(folder, 'a.txt', (p) => taken.has(p)), 'a (3).txt');
check('an untaken name is left alone', freeName(folder, 'b.txt', (p) => taken.has(p)), 'b.txt');

console.log('\n--- saving, with Explorer stood in for ---');
const revealedPaths: string[] = [];
const spy = async (p: string): Promise<void> => {
  revealedPaths.push(p);
};

const text = 'TASK: run the unit tests\r\nEVERY LINE\nkept as it was\n';
const first = await saveAndReveal(text, { session: 'rules: engine', task: 'run the unit tests' }, { env, platform: 'win32', reveal: spy, now: at });
console.log('written to                      :', first.path);
check('the folder was created', existsSync(folder), true);
check('the file is there', existsSync(first.path), true);
check('the text written is the text given', readFileSync(first.path, 'utf8'), text);
check('it says it was revealed', first.revealed, true);
check('Explorer was pointed at the file', revealedPaths[0], first.path);
check('nothing to apologise for', first.note, undefined);

const again = await saveAndReveal(text, { session: 'rules: engine', task: 'run the unit tests' }, { env, platform: 'win32', reveal: spy, now: at });
console.log('the same log, saved again       :', again.fileName);
check('a fresh name, same second and all', again.path !== first.path, true);
check('the first file is still there', existsSync(first.path), true);
check('and the second one too', existsSync(again.path), true);

console.log('\n--- a machine with no Explorer to open ---');
const elsewhere = await saveAndReveal('linux still saves', { session: 's', task: 't' }, { env, platform: 'linux', reveal: spy, now: at });
check('the file was still written', existsSync(elsewhere.path), true);
check('with the text given', readFileSync(elsewhere.path, 'utf8'), 'linux still saves');
check('it does not claim to have revealed it', elsewhere.revealed, false);
console.log('what it says instead            :', elsewhere.note);
check('and says revealing is Windows-only', (elsewhere.note ?? '').includes('Windows-only'), true);
check('no reveal was attempted', revealedPaths.length, 2);

console.log('\n--- Explorer refusing is not the save failing ---');
const refused = await saveAndReveal(
  'saved anyway',
  { session: 's', task: 't' },
  { env, platform: 'win32', now: at, reveal: () => Promise.reject(new Error('explorer.exe was not found')) },
);
check('the file is on disk', existsSync(refused.path), true);
check('it does not claim to have revealed it', refused.revealed, false);
console.log('what it says instead            :', refused.note);
check('and names the problem', (refused.note ?? '').includes('explorer.exe was not found'), true);

await rm(home, { recursive: true, force: true });

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
