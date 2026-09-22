/**
 * A downloaded file is saved, not executed, unless two independent gates both agree: the reply
 * asked for it (`step.run`) and the operator allowed it (`execution.allowRunningDownloads`). The
 * model's flag alone must never be enough — a process that fetches a file and then runs it because
 * the fetched-for reply said to is the exact shape a security team reads as a loader, which is how
 * this project came to be answering a GSOC incident. `downloadWillRun` is the one place that
 * decision is made, so this check pins it where a later edit cannot quietly widen it.
 */
import { downloadWillRun } from '../src/exec/policy.js';
import type { Step } from '../src/protocol/replySchema.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const asked: Step = { id: 1, type: 'download', file: 'x.ps1', run: true, shell: 'pwsh', args: [] };
const notAsked: Step = { id: 2, type: 'download', file: 'x.ps1', run: false, shell: 'pwsh', args: [] };
const command: Step = { id: 3, type: 'command', shell: 'pwsh', cmd: 'Get-Date' };

console.log('--- a downloaded file runs only when both gates agree ---');
check('model asked, operator forbids -> save only', downloadWillRun(asked, false), false);
check('model asked, operator allows  -> runs', downloadWillRun(asked, true), true);
check('model did not ask, operator allows  -> save only', downloadWillRun(notAsked, true), false);
check('model did not ask, operator forbids -> save only', downloadWillRun(notAsked, false), false);
check('a command step is not a download and never matches', downloadWillRun(command, true), false);

console.log('\n--- the default posture ---');
// The value the config ships with is `false`; the point of the whole change is that this line,
// the one a fresh machine takes, never runs a downloaded file whatever the reply asked.
check('a fresh machine (execution.allowRunningDownloads defaults false) never runs a download', downloadWillRun(asked, false), false);

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
