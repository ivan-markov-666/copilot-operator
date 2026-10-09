/**
 * Every check in test/ is run by the suite, unless it opens the real Copilot.
 *
 * Three offline checks — settings-precedence, review-evidence, model-help — were written with the change
 * they guard and given an npm script, but never added to `npm run check`. Nothing ran them again: the
 * rule they held (Settings outrank a plan's model, 0.1.33) changed three older checks' answers, those
 * three failed for six releases, and two type errors sat in the unrun files (found 2026-10-09). So the
 * suite is held to the folder:
 *
 * - each `test/*.check.ts` has an npm script that runs it;
 * - each is reached from `npm run check:all`, through `check`, `check:ui` or `check:release`;
 * - except a check whose opening comment says it is not part of `npm run check`, and why: those open
 *   Edge on the operator's real Copilot account and are run by hand, once and announced, because
 *   repeated launches got the account signed out (2026-10-05). Said in the file, not read from its name:
 *   live-fixes is named after the live run its findings came from, and runs on the scripted chat;
 * - and every `npm run …` the suite names is a script that exists.
 *
 *   npm run check:suite
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Tally } from './support/harness.js';

const t = new Tally();
const root = join(import.meta.dirname, '..');
const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

/** The scripts a script runs with `npm run`, and the check files it runs with `tsx` itself. */
const parts = (name: string): { runs: string[]; files: string[] } => {
  const text = scripts[name] ?? '';
  return {
    runs: [...text.matchAll(/npm run (?:-s )?([\w:-]+)/g)].map((m) => m[1]!),
    files: [...text.matchAll(/test\/([\w.-]+\.check\.ts)/g)].map((m) => m[1]!),
  };
};

// Everything `check:all` reaches, followed through every `npm run`.
const reached = new Set<string>();
const files = new Set<string>();
const missingScripts: string[] = [];
const walk = (name: string): void => {
  if (reached.has(name)) return;
  if (!(name in scripts)) {
    missingScripts.push(name);
    return;
  }
  reached.add(name);
  const p = parts(name);
  p.files.forEach((f) => files.add(f));
  p.runs.forEach(walk);
};
walk('check:all');

console.log('--- the suite reaches every check in test/ ---');
const onDisk = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.check.ts')).sort();
/** The file's opening comment as one line of prose: the leading ` * ` of each line dropped. */
const opening = (f: string): string =>
  (readFileSync(join(root, 'test', f), 'utf8').match(/^\/\*\*([\s\S]*?)\*\//)?.[1] ?? '').replace(/^\s*\* ?/gm, '').replace(/\s+/g, ' ');
// The words the hand-run checks open with; matched as written, capital N included.
const live = onDisk.filter((f) => opening(f).includes('Not part of `npm run check`'));
const offline = onDisk.filter((f) => !live.includes(f));
const withScript = (f: string): boolean => Object.values(scripts).some((s) => s.includes(`test/${f}`));
t.check('every check file has an npm script', onDisk.filter((f) => !withScript(f)), []);
t.check('every offline check is run by npm run check:all', offline.filter((f) => !files.has(f)), []);
t.check('no check that says it is run by hand is run by it (they open the real Copilot)', live.filter((f) => files.has(f)), []);
t.check('each of those says why in its opening comment', live.filter((f) => !/Copilot/.test(opening(f))), []);
t.check('every npm run the suite names exists', missingScripts, []);
t.truthy('and the suite is not empty', files.size > 40, files.size);
console.log(`  ${files.size} checks reached; run by hand: ${live.join(', ') || 'none'}`);

t.finish();
