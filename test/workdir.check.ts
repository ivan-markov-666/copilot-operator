/**
 * Where a session's commands run, and where they never run by default.
 *
 * The first step of a nine-task plan ran with cwd = this project's own checkout, and wrote to
 * the right place only because the model used absolute paths — as the plan's author had told
 * it to, compensating for a runner default. The rule under test: the session's project wins,
 * the configured cwd is the fallback, and this checkout is refused as a fallback while being
 * allowed as a deliberate choice.
 *
 *   npm run check:workdir
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { botRootDir, isOwnCheckout, isWorkingDirProblem, workingDirFor, workingDirNote, type WorkingDir } from '../src/exec/workDir.js';

const own = botRootDir();
console.log('--- this checkout is found by its own package.json ---');
console.log('bot root         :', own);
console.log('is copilot-operator:', (JSON.parse(readFileSync(join(own, 'package.json'), 'utf8')) as { name: string }).name === 'copilot-operator' ? 'yes' : 'NO');
console.log('runs/ is inside  :', isOwnCheckout(join(own, 'runs'), own), '(expect true)');
console.log('a sibling is not :', isOwnCheckout(resolve(own, '..', 'calculator-test'), own), '(expect false)');

const elsewhere = resolve('C:/Projects/calculator-test');
const session = (repoDir: string, mirrorRoot: string): Parameters<typeof workingDirFor>[0] =>
  ({ vcs: { enabled: true, repoDir, branchMode: 'per-task', commitOnFinish: true, branchPrefix: 'cop/' }, mirror: { rootDir: mirrorRoot } }) as never;
const show = (label: string, w: ReturnType<typeof workingDirFor>): void => {
  console.log(
    label.padEnd(34),
    isWorkingDirProblem(w) ? `REFUSED   ${w.problem.slice(0, 72)}…` : `${w.source.padEnd(10)} ${w.cwd}${w.ownCheckout ? '  (own checkout, chosen)' : ''}`,
  );
};

console.log("\n--- the session's project wins; the config is the fallback ---");
show('repository set', workingDirFor(session(elsewhere, ''), own, own));
show('mirror only', workingDirFor(session('', elsewhere), own, own));
show('both: repository first', workingDirFor(session(elsewhere, 'C:/other'), own, own));
show('neither, config elsewhere', workingDirFor(session('', ''), 'C:/work', own));

console.log('\n--- this checkout: refused as a default, allowed as a choice ---');
show('neither, config = bot root', workingDirFor(session('', ''), own, own));
show('neither, config inside bot root', workingDirFor(session('', ''), join(own, 'runs'), own));
show('repository = bot root (chosen)', workingDirFor(session(own, ''), 'C:/work', own));
show('case and slashes do not matter', workingDirFor(session('', ''), own.toUpperCase().replace(/\\/g, '/'), own));

console.log('\n--- what the model is told ---');
const told = workingDirFor(session(elsewhere, ''), own, own) as WorkingDir;
console.log(
  workingDirNote(told)
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n'),
);
const chosen = workingDirFor(session(own, ''), 'C:/work', own) as WorkingDir;
console.log('says so when it is the bot   :', workingDirNote(chosen).includes('own checkout') ? 'yes' : 'NO');
console.log('and not when it is not       :', !workingDirNote(told).includes('own checkout') ? 'yes' : 'NO');
