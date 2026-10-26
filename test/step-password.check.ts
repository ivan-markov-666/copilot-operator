/**
 * Git's password window for the chat's own commands (operator, 2026-10-26: "if the chat works with git and needs a
 * password, the bot stops, a window opens for the operator to type it, and the work goes on; every time one is
 * asked"): a step's git and ssh ask through Git's own window, never a terminal; while that window is open the step is
 * waiting for the operator, not hung — its idle clock is held, and it is said, each time it opens and closes; and the
 * page is told, so the chat and the tab say where to look.
 *
 *   npm run check:step-password
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStep } from '../src/exec/runner.js';
import { stepEnvironment } from '../src/exec/stepEnv.js';
import { tabTitle } from '../web/lib/actors.js';
import { Tally } from './support/harness.js';

const t = new Tally();
const base = mkdtempSync(join(tmpdir(), 'cop-step-password-'));
const ASK = 'C:\\Program Files\\Git\\mingw64\\bin\\git-askpass.exe';

try {
  console.log('--- the step\'s environment ---');
  const asking = stepEnvironment({ PATH: 'C:\\bin', COP_API_TOKEN: 'secret' }, [], ASK);
  t.check('with Git\'s window: git and ssh ask through it, never a terminal', [asking.GIT_ASKPASS, asking.SSH_ASKPASS, asking.SSH_ASKPASS_REQUIRE, asking.GIT_TERMINAL_PROMPT, asking.GCM_INTERACTIVE], [ASK, ASK, 'force', '0', 'auto']);
  t.check('and the bot\'s own keys still never reach a step', asking.COP_API_TOKEN, undefined);
  const plain = stepEnvironment({ PATH: 'C:\\bin' }, []);
  t.check('without one (no Git for Windows here): none of it', [plain.GIT_ASKPASS, plain.SSH_ASKPASS], [undefined, undefined]);

  console.log('\n--- a step that waits for the window: held, not hung ---');
  // The window "open" from 1 s to 6 s into a step that is silent for 7 s, with an idle limit of 3 s.
  const said: Array<[boolean, number]> = [];
  let t0 = 0;
  const probe = async (since: number): Promise<boolean> => {
    t0 ||= since;
    const at = Date.now() - since;
    return at > 1_000 && at < 6_000;
  };
  const waited = await runStep(
    { id: 1, shell: 'pwsh', command: 'Start-Sleep -Seconds 7; Write-Output "pushed"', cwd: process.cwd(), logPath: join(base, 'waited.log'), idleTimeoutMs: 3_000, hardTimeoutMs: 60_000, askpass: ASK },
    { passwordProbe: probe, onPasswordWindow: (open) => said.push([open, Date.now() - t0]) },
  );
  t.check('the step ran to its end: its quiet time while the window was open did not count', [waited.outcome, waited.stdout.trim()], ['completed', 'pushed']);
  t.check('said when the window opened, and when it closed', said.map(([open]) => open), [true, false]);
  t.truthy('at about the times it did', said.length === 2 && said[0]![1] < 6_000 && said[1]![1] >= 5_000, said);

  const hung = await runStep(
    { id: 2, shell: 'pwsh', command: 'Start-Sleep -Seconds 30', cwd: process.cwd(), logPath: join(base, 'hung.log'), idleTimeoutMs: 3_000, hardTimeoutMs: 60_000, askpass: ASK },
    { passwordProbe: async () => false },
  );
  t.check('with no window open, a quiet step is still a hung one', hung.outcome, 'idle-timeout');

  // A run with nobody there: the window open, never answered.
  const started = Date.now();
  const unanswered = await runStep(
    { id: 4, shell: 'pwsh', command: 'Start-Sleep -Seconds 60', cwd: process.cwd(), logPath: join(base, 'unanswered.log'), idleTimeoutMs: 3_000, hardTimeoutMs: 60_000, askpass: ASK },
    { passwordProbe: async () => true },
  );
  t.check('a window nobody answers for as long as the idle limit ends the step, and says why', [unanswered.outcome, /Git's password window was not answered for 3s/.test(unanswered.stderr)], ['idle-timeout', true]);
  t.truthy('soon after the limit, not at the hard limit', Date.now() - started < 20_000, Date.now() - started);

  let asked = 0;
  await runStep(
    { id: 3, shell: 'pwsh', command: 'Start-Sleep -Seconds 5', cwd: process.cwd(), logPath: join(base, 'no-askpass.log'), idleTimeoutMs: 60_000, hardTimeoutMs: 60_000 },
    { passwordProbe: async () => ((asked += 1), false) },
  );
  t.check('a step with no window to ask through is not looked at', asked, 0);

  console.log('\n--- the tab ---');
  t.check('the tab says the work waits for a password', tabTitle(0, { running: true, sessions: 1, starting: false, password: true }, 1, false), 'Waiting for your password — copilot-operator');
  t.check('a card waiting comes first', tabTitle(2, { running: true, sessions: 1, starting: false, password: true }, 1, false), 'Waiting for you (2) — copilot-operator');
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  rmSync(base, { recursive: true, force: true });
}
t.finish();
