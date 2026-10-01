/**
 * How one step is run and how a task's checks are decided — the two things every other part of the
 * runner stands on — held as asserting checks rather than as printed lines somebody has to read.
 *
 * This replaces `runner.check.ts` and `checks.check.ts`, which printed "(expect r1f2)" beside what
 * they got and passed whatever happened. It pins:
 *
 *   - the two clocks of `runStep`: a silent step is stopped by the idle clock, a chatty one never is,
 *     and the hard clock takes the step's whole tree down, so the port it held is free again;
 *   - an operator's stop, including one that came before the step began;
 *   - the output cap, the step log's shape, and the named (not inherited) environment;
 *   - what a heartbeat carries while a step runs;
 *   - `stopTree`'s fallback and `stopProcesses` never touching this process or its parent;
 *   - every check kind, output checks judged on the whole output, the checks that cannot be evaluated
 *     failing rather than passing, the gate refusing a download in a check, the messages the chat
 *     gets and the secrets kept out of them, derived checks, and commit-clean.
 *
 * Only `powershell` and `cmd` are used, which every Windows machine has: the old runner check asked
 * for `pwsh` and died of `spawn ENOENT` on a machine without PowerShell 7. Everything is written
 * under one temporary folder; nothing reaches the network. The one command that would fetch is
 * refused by the gate, a guard refuses it again should the gate ever let it through, and its address
 * is under `.invalid` (RFC 2606), which never resolves — so even a check that stopped asking the gate
 * at all would cost a failed name lookup, not a download.
 *
 * The heartbeat checks ask for a beat every fraction of a second through `heartbeatMs`, beside
 * `onHeartbeat`: at the live log's own pace of one every 30 s, none would come during a short step.
 *
 *   npx tsx test/exec.check.ts        (npm run check:exec, once package.json names it)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStep, type RunRequest } from '../src/exec/runner.js';
import { isAlive, ProcessTracker, stopProcesses, stopTree } from '../src/exec/processes.js';
import { COMMIT_CLEAN_CHECK, describeCheck, failureMessage, failureReport, runCheck, runChecks, type CheckOutcome } from '../src/exec/checks.js';
import { checkCommandRefusal } from '../src/exec/policy.js';
import { writeReport } from '../src/exec/reportFile.js';
import { derivedCheckName, onlyDerivedFailing, settleAfterReview, suspendDisputed, validateDerivedChecks } from '../src/orchestrator/derivedChecks.js';
import type { TaskCheck, TaskReviewCheck } from '../src/session/model.js';
import { freePort, makeRepo, Tally } from './support/harness.js';

const t = new Tally();
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const base = await mkdtemp(join(tmpdir(), 'cop-exec-'));
const logs = join(base, 'logs');
await mkdir(logs, { recursive: true });

let nextId = 0;
/** One step, in the temporary folder, with a log of its own. */
function step(shell: 'cmd' | 'powershell', command: string, extra: Partial<RunRequest> = {}, opts: Parameters<typeof runStep>[1] = {}) {
  nextId += 1;
  return runStep({ id: nextId, shell, command, cwd: base, logPath: join(logs, `step-${nextId}.log`), ...extra }, opts);
}

/**
 * The step log once its closing line is on disk.
 *
 * `runStep` resolves in the same moment it ends the log stream, and the stream's last write lands a
 * moment later; reading at once can miss the `# outcome=` line. Nothing in the product reads the log
 * back straight away (it is for a person, later), so this waits for it rather than calling it a fault.
 */
async function settledLog(path: string): Promise<string> {
  const until = Date.now() + 5_000;
  for (;;) {
    const text = existsSync(path) ? await readFile(path, 'utf8') : '';
    if (/# outcome=/.test(text) || Date.now() > until) return text;
    await wait(50);
  }
}

async function scenario(title: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  try {
    await body();
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  }
}

/** Whether a TCP port on the loopback can be listened on right now. */
function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

try {
  /*
   * The idle clock is the one that matters for a test suite that runs for an hour: it must trip on a
   * process that has gone quiet, and never on one that keeps printing, however long it runs.
   */
  /*
   * How long a stop takes, and why the bound is 15 s. A stop is `taskkill /T`, a grace of
   * CLOSE_GRACE_MS (5 s), then `/F` (processes.ts), after reading the process table; runner.ts puts
   * it at "about ten seconds at worst". A step's tree is console processes with no window, which the
   * polite `taskkill` cannot close ("can only be terminated forcefully"), so today every stop spends
   * the whole grace: an idle stop at 1.5 s ends near 6-7 s. The command runs for 29 s on its own, so
   * ending well under 15 s is what shows the tree was stopped rather than waited out.
   */
  const STOP_BOUND_MS = 15_000;

  await scenario('a silent step is stopped by the idle clock; a chatty one is not', async () => {
    const hung = await step('cmd', 'ping -n 30 127.0.0.1 >nul', { idleTimeoutMs: 1_500, hardTimeoutMs: 60_000 });
    t.check('the silent step ended idle-timeout', hung.outcome, 'idle-timeout');
    t.check('with exit -1', hung.exitCode, -1);
    t.truthy(`it was stopped long before its own 29 s end (took ${hung.durationMs} ms, bound ${STOP_BOUND_MS})`, hung.durationMs < STOP_BOUND_MS);
    t.truthy('stderr says it was treated as hung', hung.stderr.includes('treating as hung'), hung.stderr);

    // A line every 500 ms for about 6 s: twice the idle limit, and every line resets the clock. The
    // limit is 3 s rather than 1.5 s only because PowerShell's own start, before its first line, can
    // take over a second on a loaded machine, and that is not what this is about.
    const chatty = await step('powershell', '1..12 | ForEach-Object { Write-Output "suite step $_"; Start-Sleep -Milliseconds 500 }', {
      idleTimeoutMs: 3_000,
      hardTimeoutMs: 60_000,
    });
    t.check('the chatty step completed', chatty.outcome, 'completed');
    t.check('with exit 0', chatty.exitCode, 0);
    t.truthy(`and it ran longer than the idle limit (${chatty.durationMs} ms)`, chatty.durationMs > 3_000);
    t.truthy('every line it printed was captured', chatty.stdout.includes('suite step 1') && chatty.stdout.includes('suite step 12'), chatty.stdout);
  });

  /*
   * A step that hits its ceiling with a server in the foreground: the shell is the process the runner
   * started, the server is its child. Killing only the shell would leave the server holding its port
   * and the next step failing with EADDRINUSE, so the whole tree has to be down when the result comes.
   */
  await scenario('the hard clock takes the whole tree down', async () => {
    const port = await freePort();
    const server = join(base, 'server.cjs');
    /*
     * The server ends itself after 45 s: longer than the hard clock plus the runner's 30 s stop
     * ceiling, so it is never gone by its own hand before the check looks, and short enough that a
     * regression (the tree stop leaving it running) does not leave a node process behind for good.
     */
    await writeFile(
      server,
      `const net = require('node:net');
const port = Number(process.argv[2]);
net.createServer().listen(port, '127.0.0.1', () => console.log('pid=' + process.pid + ' listening ' + port));
setInterval(() => console.log('tick ' + Date.now()), 200);
setTimeout(() => process.exit(0), 45_000);
`,
      'utf8',
    );
    let pid = 0;
    try {
      // 6 s, not 3: the ceiling has to cover Windows PowerShell's cold start and node's before the
      // server prints its first line, which on a loaded machine can come near 3 s by itself. The step
      // never ends on its own, so a longer ceiling changes nothing that is asserted.
      const hard = await step('powershell', `& '${process.execPath}' '${server}' ${port}`, { hardTimeoutMs: 6_000, idleTimeoutMs: 60_000 });
      t.check('the step ended hard-timeout', hard.outcome, 'hard-timeout');
      t.truthy('the server was listening while the step ran', hard.stdout.includes(`listening ${port}`), hard.stdout.slice(0, 400));
      // The node process's own word for its pid, printed as it started: reading the process table
      // while the step runs would race the very timeout under test.
      pid = Number(/pid=(\d+)/.exec(hard.stdout)?.[1] ?? 0);
      t.truthy('the server said its pid', pid > 0, hard.stdout.slice(0, 400));
      t.check('the server (the shell\'s child) is gone when runStep resolves', pid > 0 && isAlive(pid), false);
      t.check('and its port can be listened on again', await canListen(port), true);
    } finally {
      // Only when the check above has already failed: the server is this file's own process, and
      // left running it would hold the port and the temporary folder (its cwd) after the run.
      if (pid > 0 && isAlive(pid)) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    }
  });

  /*
   * The operator's Stop reaches a running step through an AbortSignal. And a signal that was already
   * aborted before the step began — the operator pressed Stop while the previous step was ending —
   * has to mean the step never starts at all.
   */
  await scenario('an abort stops the step; an abort that came first stops it before it starts', async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 500);
    const aborted = await step('cmd', 'ping -n 30 127.0.0.1', { idleTimeoutMs: 60_000, hardTimeoutMs: 60_000 }, { signal: ac.signal });
    clearTimeout(timer);
    t.check('the step ended aborted', aborted.outcome, 'aborted');
    t.check('with exit -3', aborted.exitCode, -3);
    // The same stop as the idle clock's, grace included: see STOP_BOUND_MS.
    t.truthy(`it was stopped long before its own 29 s end (took ${aborted.durationMs} ms, bound ${STOP_BOUND_MS})`, aborted.durationMs < STOP_BOUND_MS);
    t.truthy('stderr says the user aborted it', aborted.stderr.includes('aborted by the user'), aborted.stderr);

    const logPath = join(logs, 'pre-aborted.log');
    const preTracker = new ProcessTracker();
    const pre = await runStep(
      { id: 99, shell: 'cmd', command: 'ping -n 3 127.0.0.1', cwd: base, logPath, idleTimeoutMs: 60_000, hardTimeoutMs: 60_000 },
      { signal: AbortSignal.abort(), tracker: preTracker },
    );
    const log = existsSync(logPath) ? await readFile(logPath, 'utf8') : '';
    // 'abort' fires once, so a signal aborted before runStep listens never fires for it: runStep asks
    // the signal itself after its last await, before the log is opened or the shell is started.
    t.check('an already-aborted signal ends the step aborted', pre.outcome, 'aborted');
    t.truthy(`and at once (took ${pre.durationMs} ms)`, pre.durationMs < 500);
    t.check('and no process was started (the log has no "# step" header)', log.includes('# step'), false);
    t.check('and none was recorded as started', preTracker.roots.length, 0);
    t.truthy('stderr says the operator stopped it before it started', pre.stderr.includes('before it started'), pre.stderr);

    /*
     * The same Stop a moment later: pressed after runStep was called, while it is still preparing the
     * step's log folder and before it listens. That await is the window an abort used to fall into;
     * the step must not start either.
     */
    const lateLog = join(logs, 'late-abort', 'step.log');
    const lateAc = new AbortController();
    const lateTracker = new ProcessTracker();
    const lateRun = runStep(
      { id: 98, shell: 'cmd', command: 'ping -n 3 127.0.0.1', cwd: base, logPath: lateLog, idleTimeoutMs: 60_000, hardTimeoutMs: 60_000 },
      { signal: lateAc.signal, tracker: lateTracker },
    );
    lateAc.abort();
    const late = await lateRun;
    t.check('an abort right after the call ends the step aborted', late.outcome, 'aborted');
    t.truthy(`and at once (took ${late.durationMs} ms)`, late.durationMs < 500);
    t.check('and no process was started for it', lateTracker.roots.length, 0);
  });

  /*
   * What is held in memory, and echoed into the report, is capped; the log on disk is not. A report
   * that cut the output has to say so and point at the full stream, or the chat reasons about half of it.
   */
  await scenario('output beyond the cap is cut in memory, kept on disk, and said in the report', async () => {
    const big = await step('powershell', "'x'*250000", { hardTimeoutMs: 60_000 });
    t.check('the step completed', big.outcome, 'completed');
    t.check('it is marked truncated', big.truncated, true);
    t.check('stdout holds exactly the cap', big.stdout.length, 200_000);
    await settledLog(big.logPath);
    const size = (await stat(big.logPath)).size;
    t.truthy(`the log on disk holds all of it (${size} bytes)`, size > 250_000);
    const written = await writeReport([big], {
      runId: 'exec-check',
      iteration: 1,
      dir: join(base, 'report'),
      fileNameTemplate: 'iteration-{n}.txt',
      maxReportBytes: 10_000_000,
      maxOutputChars: 50_000,
      redactPatterns: [],
    });
    const report = await readFile(written.paths[0]!, 'utf8');
    t.truthy('the report says the output was truncated', report.includes('output was truncated'), report.slice(0, 300));
    t.truthy('and names the log with the full stream', report.includes(big.logPath));
  });

  /*
   * The step log is what the operator opens when a step behaved oddly: which shell, which executable,
   * which folder, both streams told apart, and how it ended. And the environment a step gets is named,
   * not inherited — the bot's own token was once readable by any step (2026-09-27).
   */
  await scenario('the step log says what ran and how it ended; the environment is named', async () => {
    const r = await step('cmd', 'echo out & echo err 1>&2');
    t.check('the step completed with exit 0', [r.outcome, r.exitCode], ['completed', 0]);
    const log = await settledLog(r.logPath);
    const lines = log.split(/\r?\n/);
    t.truthy('the first line names the shell, the executable and the folder', /^# step .*shell=.*exe=.*cwd=/.test(lines[0] ?? ''), lines[0]);
    // The printed line itself, not the word: the header (`# echo out & ...`) and the closing
    // `# outcome=` line both contain "out" whether or not the stream reached the log. cmd prints
    // "out " with the space before the `&`.
    const outAt = lines.findIndex((l) => /^out\s*$/.test(l));
    const outcomeAt = lines.findIndex((l) => l.startsWith('# outcome='));
    t.truthy('stdout is in the log, as its own line before the outcome', outAt > 0 && outcomeAt > outAt, log);
    t.truthy('stderr is in the log, marked', log.includes('[stderr] err'), log);
    const last = log.trimEnd().split(/\r?\n/).pop() ?? '';
    t.truthy('the last line is the outcome', /# outcome=completed exit=0/.test(last), last);

    // A command that ran and failed is `completed` with its own exit code, not a runner outcome:
    // the next move after it is to read the output and fix the work.
    const failed = await step('cmd', 'dir C:\\definitely-not-here-12345');
    t.check('a failing command still completed', failed.outcome, 'completed');
    t.truthy(`with its own non-zero exit (${failed.exitCode})`, failed.exitCode > 0);
    t.truthy('and its complaint in stderr', failed.stderr.trim().length > 0, failed.stderr);

    const env = await step('cmd', 'echo [%NEXT_PUBLIC_COP_TOKEN%][%NO_COLOR%][%npm_config_ignore_scripts%][%MY_DB%]', {
      env: { ...process.env, NEXT_PUBLIC_COP_TOKEN: 'tok123', MY_DB: 'db1' },
      passEnv: ['MY_DB'],
    });
    t.truthy("the bot's token never reaches a step", !env.stdout.includes('tok123'), env.stdout);
    t.truthy('NO_COLOR is set to 1', env.stdout.includes('[1]'), env.stdout);
    t.truthy('install scripts are off', env.stdout.includes('[true]'), env.stdout);
    t.truthy('a variable named in passEnv passes', env.stdout.includes('[db1]'), env.stdout);
  });

  /*
   * The heartbeat is what the live log shows during a long step: how long it has run, how much it has
   * printed, and the last line it printed. The step prints a numbered line with its own clock every
   * 300 ms for about 2.5 s, and the beat comes every 500 ms, so a beat that says anything true has to
   * carry a line printed before it and not long before it — not a stale one, and not one it made up.
   *
   * The interval is asked for through `heartbeatMs`. The live log's own pace is a beat every 30 s, at
   * which none would come while this step runs, and what a beat carries could not be checked at all.
   */
  await scenario('a heartbeat says how long, how much, and the last line printed', async () => {
    const beats: Array<{ elapsedMs: number; idleMs: number; bytesOut: number; lastLine: string; at: number }> = [];
    const hbOpts: Parameters<typeof runStep>[1] = {
      heartbeatMs: 500,
      onHeartbeat: (b) => beats.push({ ...b, at: Date.now() }),
    };
    const r = await step(
      'powershell',
      '1..8 | % { "beat-line $_ " + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); Start-Sleep -Milliseconds 300 }',
      { idleTimeoutMs: 60_000, hardTimeoutMs: 60_000 },
      hbOpts,
    );
    t.check('the step completed', r.outcome, 'completed');
    const stamp = (line: string): number => Number(/^beat-line \d+ (\d+)$/.exec(line)?.[1] ?? NaN);
    const good = beats.find((b) => b.elapsedMs > 0 && b.bytesOut > 0 && /^beat-line \d+ \d+$/.test(b.lastLine));
    t.truthy(`a beat carried the time run, the bytes printed and a printed line (${beats.length} beats)`, good !== undefined, beats);
    // The clocks are the same system clock; 20 ms is only its resolution. A line printed more than a
    // second before the beat would be one the beat kept after newer lines had come (they come every 300 ms).
    t.truthy(
      "that beat's line was printed before it, and less than a second before it",
      good !== undefined && stamp(good.lastLine) <= good.at + 20 && good.at - stamp(good.lastLine) < 1_000,
      good,
    );
    // A pipe hands over chunks, not lines; the beat carries the line the step printed, never the
    // second half of one that arrived in two chunks.
    t.truthy("and it is a whole line of the step's stdout", good !== undefined && r.stdout.split(/\r?\n/).some((l) => l.trimEnd() === good.lastLine), r.stdout);
    // Every beat, not just the one picked above: none carries text the step did not print as a line.
    const lines = new Set(r.stdout.split(/\r?\n/).map((l) => l.trimEnd()));
    t.truthy('every beat with a line carries a whole printed line', beats.every((b) => b.lastLine === '' || lines.has(b.lastLine)), beats.map((b) => b.lastLine));

    /*
     * The same rule where it is easy to break: one line printed in two pieces a second apart (`set /p`
     * prints without a newline), then a second of quiet, so beats come on both sides of the join.
     * Before the join the beat shows the line as far as it has come; after it, the whole line, not
     * only its second piece. No space before an `&`: cmd prints it as part of the text.
     */
    const split: string[] = [];
    const halves = await step('cmd', '<nul set /p =first-half-& ping -n 2 127.0.0.1 >nul & echo second-half& ping -n 2 127.0.0.1 >nul', { idleTimeoutMs: 60_000, hardTimeoutMs: 60_000 }, {
      heartbeatMs: 200,
      onHeartbeat: (b) => split.push(b.lastLine),
    });
    t.check('the two-piece step completed', halves.outcome, 'completed');
    t.truthy('a beat after the join carries the whole line', split.includes('first-half-second-half'), split);
    t.truthy('and no beat carries only its second piece', !split.includes('second-half'), split);
  });

  /*
   * `stopTree` reads the table from the step's start; when the root is not in it (the table could not
   * be read, or the process predates it) it falls back to forcing the root. And whatever a caller
   * passes, `stopProcesses` never stops the bot itself or whatever started it.
   */
  await scenario('stopping processes', async () => {
    const ping = spawn('ping', ['-n', '60', '127.0.0.1'], { detached: true, stdio: 'ignore', windowsHide: true });
    try {
      const pid = ping.pid ?? 0;
      t.truthy('the detached process started', pid > 0 && isAlive(pid));
      // A `since` in the future filters the root out of the table, which is what forces the fallback.
      const how = await stopTree(pid, Date.now() + 60_000);
      t.check('the fallback forced it', how.get(pid), 'forced');
      t.check('and it is gone', isAlive(pid), false);
    } finally {
      try {
        ping.kill();
      } catch {
        /* already gone */
      }
    }

    const self = await stopProcesses([process.pid, process.ppid], { graceMs: 1_000 });
    t.check('asked to stop this process and its parent, it stops nothing', [...self.entries()], []);
    t.check('this process and its parent are still alive', [isAlive(process.pid), isAlive(process.ppid)], [true, true]);
  });

  const checksDir = join(base, 'checks');
  await mkdir(join(checksDir, 'work'), { recursive: true });
  await writeFile(join(checksDir, 'report.txt'), 'total: 2\nREADME.md\nnotes.txt\n', 'utf8');
  await writeFile(join(checksDir, 'work', 'inner.txt'), 'inside\n', 'utf8');
  const checkLogs = join(base, 'check-logs');
  const opts = { cwd: checksDir, logDir: checkLogs };
  const cmd = (run: string): Partial<TaskCheck> => ({ run, shell: 'cmd' as const, cwd: checksDir });

  /*
   * Every kind decides what it claims to, one case each way. Commands run through `cmd`, so what is
   * tested is the check engine rather than whether a particular shell is installed.
   */
  await scenario('every check kind decides correctly', async () => {
    const cases: Array<[TaskCheck, boolean]> = [
      [{ name: 'a command that succeeds', expect: 'exit-zero', ...cmd('echo fine') }, true],
      [{ name: 'a command that fails', expect: 'exit-zero', ...cmd('exit /b 3') }, false],
      [{ name: 'a failure that was wanted', expect: 'exit-nonzero', ...cmd('exit /b 3') }, true],
      [{ name: 'a success where failure was wanted', expect: 'exit-nonzero', ...cmd('echo fine') }, false],
      [{ name: 'output contains it', expect: 'output-contains', value: 'hello', ...cmd('echo hello world') }, true],
      [{ name: 'output does not contain it', expect: 'output-contains', value: 'missing', ...cmd('echo hello world') }, false],
      [{ name: 'output omits it', expect: 'output-omits', value: 'node_modules', ...cmd('echo src/app.ts') }, true],
      [{ name: 'output should have omitted it', expect: 'output-omits', value: 'node_modules', ...cmd('echo node_modules/x') }, false],
      [{ name: 'output matches a pattern', expect: 'output-matches', value: '^total: [0-9]+$', ...cmd('echo total: 2') }, true],
      [{ name: 'output does not match', expect: 'output-matches', value: '^total: [0-9]+$', ...cmd('echo nothing') }, false],
      // `^` and `$` are per line (the `m` flag): a line in the middle of the output matches.
      [{ name: 'a middle line matches', expect: 'output-matches', value: '^total: [0-9]+$', ...cmd('echo first&echo total: 2&echo last') }, true],
      [{ name: 'the file is there', expect: 'file-exists', file: join(checksDir, 'report.txt') }, true],
      [{ name: 'the file is not there', expect: 'file-exists', file: join(checksDir, 'nope.txt') }, false],
      [{ name: 'the file is absent, as wanted', expect: 'file-missing', file: join(checksDir, 'nope.txt') }, true],
      [{ name: 'the file should have been absent', expect: 'file-missing', file: join(checksDir, 'report.txt') }, false],
      [{ name: 'the file says it', expect: 'file-contains', file: join(checksDir, 'report.txt'), value: 'total: 2' }, true],
      [{ name: 'the file does not say it', expect: 'file-contains', file: join(checksDir, 'report.txt'), value: 'total: 9' }, false],
      // A relative file is read from the check's own folder — the folder its command would run in —
      // not from wherever the runner itself was started.
      [{ name: "a relative file, from the check's cwd", expect: 'file-exists', file: 'inner.txt', cwd: 'work' }, true],
      [{ name: 'the same relative file, without that cwd', expect: 'file-exists', file: 'inner.txt' }, false],
    ];
    for (const [check, shouldPass] of cases) {
      const outcome = await runCheck(check, 0, opts);
      t.check(`${check.name} -> ${shouldPass ? 'passed' : 'failed'}`, outcome.passed, shouldPass);
    }
  });

  /*
   * An output check is a claim about everything the command printed. The output is shortened to 4000
   * characters for the report that goes back to the chat; the verdict must not be taken on that
   * shortened text, or a marker printed after the first 4000 characters is never seen. The padding is
   * about 110,000 characters — far past any plausible report limit, under the runner's 200,000 cap —
   * so a fix that only raised the limit, or judged the first N characters, still fails here. And the
   * other half of the fix is held too: what is reported stays short.
   */
  await scenario('output checks judge the whole output', async () => {
    const long = "1..6000 | % { 'padding-line-' + $_ }; 'MARKER'";
    const ps = { shell: 'powershell' as const, run: long, cwd: checksDir };
    const contains = await runCheck({ name: 'marker after the padding', expect: 'output-contains', value: 'MARKER', ...ps }, 0, opts);
    const omits = await runCheck({ name: 'marker should be absent', expect: 'output-omits', value: 'MARKER', ...ps }, 0, opts);
    const matches = await runCheck({ name: 'marker on its own line', expect: 'output-matches', value: '^MARKER$', ...ps }, 0, opts);
    // The verdict is taken on everything the runner kept; only the reported copy is shortened.
    t.check('output-contains finds a marker printed after 4000 characters', contains.passed, true);
    t.check('output-omits fails when the marker was printed after 4000 characters', omits.passed, false);
    t.check('output-matches finds a line printed after 4000 characters', matches.passed, true);
    t.truthy(`the reported output is still shortened (${(contains.output ?? '').length} characters)`, (contains.output ?? '').length < 5_000);

    /*
     * The same rule one layer down. The runner keeps 200,000 characters of each stream in memory and
     * the rest on disk only, so past that the output a verdict would need was never read. Finding the
     * text in the part kept still decides; not finding it decides nothing, and the check fails saying
     * so — above all output-omits, which passing here would open the gate on output nobody read.
     */
    const huge = "'x' * 250000; 'LATE-MARKER'";
    const big = { shell: 'powershell' as const, run: huge, cwd: checksDir };
    const lateOmits = await runCheck({ name: 'late marker should be absent', expect: 'output-omits', value: 'LATE-MARKER', ...big }, 0, opts);
    const lateContains = await runCheck({ name: 'late marker present', expect: 'output-contains', value: 'LATE-MARKER', ...big }, 0, opts);
    const lateMatches = await runCheck({ name: 'late marker on its line', expect: 'output-matches', value: '^LATE-MARKER$', ...big }, 0, opts);
    const earlyContains = await runCheck({ name: 'early text present', expect: 'output-contains', value: 'xxxxxxxx', ...big }, 0, opts);
    t.check('output-omits past the capture limit fails rather than passing on the part kept', lateOmits.passed, false);
    t.truthy('and says the rest was never read', /never read/.test(lateOmits.detail), lateOmits.detail);
    t.check('output-contains past the capture limit fails', lateContains.passed, false);
    t.truthy('saying it cannot be decided, not that the text is missing', /cannot be decided/.test(lateContains.detail), lateContains.detail);
    t.check('output-matches past the capture limit fails', lateMatches.passed, false);
    t.truthy('saying it cannot be decided', /cannot be decided/.test(lateMatches.detail), lateMatches.detail);
    t.check('text found in the part kept still passes output-contains', earlyContains.passed, true);
  });

  /*
   * A gate that opens when it breaks is worse than no gate: a check that cannot be evaluated fails.
   */
  await scenario('a check that cannot be evaluated fails', async () => {
    const broken: Array<[string, TaskCheck, number?]> = [
      ['no command given', { name: 'no command', expect: 'exit-zero' }],
      ['no file given', { name: 'no file', expect: 'file-exists' }],
      ['a pattern that is not one', { name: 'bad pattern', expect: 'output-matches', value: '([unclosed', ...cmd('echo x') }],
      ['a kind that does not exist', { name: 'bogus', expect: 'bogus' as TaskCheck['expect'] }],
      ['a kind that does not exist, with a file', { name: 'bogus with file', expect: 'bogus' as TaskCheck['expect'], file: join(checksDir, 'report.txt') }],
      ['file-contains on a folder', { name: 'a folder', expect: 'file-contains', file: checksDir, value: 'x' }],
    ];
    for (const [what, check] of broken) {
      const outcome = await runCheck(check, 0, opts);
      t.check(`${what} -> failed`, outcome.passed, false);
    }

    const slow = await runCheck({ name: 'slow', expect: 'exit-zero', ...cmd('ping -n 5 127.0.0.1') }, 0, { ...opts, timeoutMs: 1_000 });
    t.check('a command past its time limit -> failed', slow.passed, false);
    t.truthy('and the detail says it ended hard-timeout', /ended hard-timeout/.test(slow.detail), slow.detail);

    /*
     * The gate a check's command goes through is the one the task runner and the reviewer use. A
     * download in a check is refused outright, because a check runs with nobody asked. The guard after
     * `??` is this file's own: should the gate ever let the fetch through, the check is still refused
     * (and fails the assertion below) rather than reaching the network. That guard only works while
     * runCheck calls `deny`, so the address is under `.invalid`, which never resolves: the gate refuses
     * every address that is not loopback all the same, and a runCheck that stopped asking it would
     * fail a name lookup rather than download anything.
     */
    const gateCfg = { denyPatterns: [] as string[], allowedPrograms: ['cmd', 'powershell', 'curl'] };
    const deny = (command: string, shell: 'pwsh' | 'powershell' | 'cmd', cwd: string): string =>
      checkCommandRefusal(command, shell, gateCfg, { roots: [base], cwd }) ?? 'GUARD OF exec.check.ts: the gate let a network fetch through';
    const fetches = await runCheck({ name: 'downloads a page', expect: 'exit-zero', run: 'curl https://example.invalid/x.html -o x.html', shell: 'powershell', cwd: checksDir }, 0, {
      ...opts,
      deny,
    });
    t.check('a check that downloads -> failed', fetches.passed, false);
    t.check('refused before running', fetches.refusedBeforeRunning, true);
    t.truthy('the detail says it was refused before it ran', fetches.detail.includes('refused before it ran'), fetches.detail);
    t.truthy('and that it fetches from the network', fetches.detail.includes('fetches from the network'), fetches.detail);
  });

  /*
   * Every check runs, so the chat hears about every failure at once. A Stop pressed before the checks
   * means none of them runs, and none counts as passed. And what the chat is told when checks fail says
   * the task is not over, how many failed, which attempt this is, and what did pass.
   */
  await scenario('runChecks and what the chat is told', async () => {
    const failing: TaskCheck = { name: 'typescript compiles', expect: 'exit-zero', ...cmd('exit /b 2') };
    const passing: TaskCheck = { name: 'the report exists', expect: 'file-exists', file: join(checksDir, 'report.txt') };
    const both = await runChecks([failing, passing], opts);
    t.check('two checks, two outcomes', both.length, 2);
    t.check('the first failed, the second passed', both.map((o) => o.passed), [false, true]);

    const stoppedLogs = join(base, 'stopped-logs');
    const stopped = await runChecks([failing, passing, { name: 'an output check', expect: 'output-contains', value: 'x', ...cmd('echo x') }], {
      cwd: checksDir,
      logDir: stoppedLogs,
      signal: AbortSignal.abort(),
    });
    t.check('after a Stop every outcome is failed', stopped.map((o) => o.passed), [false, false, false]);
    t.truthy(
      'and each says the operator stopped the run first',
      stopped.every((o) => o.detail === 'the operator stopped the run before this check ran'),
      stopped.map((o) => o.detail),
    );
    const stoppedFiles = existsSync(stoppedLogs) ? await readdir(stoppedLogs) : [];
    t.check('and no check command was run (no check-*.txt)', stoppedFiles.filter((f) => /^check-.*\.txt$/.test(f)), []);

    const three = await runChecks(
      [failing, passing, { name: 'the endpoint is registered', expect: 'output-contains', value: 'CalculatorController', ...cmd('echo nothing here') }],
      opts,
    );
    t.check('two of the three fail', three.map((o) => o.passed), [false, true, false]);
    const message = failureMessage(three, 1, 3);
    t.truthy('the message says the task is not finished yet', message.includes('not finished yet'), message);
    t.truthy('it says 2 of the 3 did not pass', message.includes('2 of the 3'), message);
    t.truthy('it says which attempt this is', message.includes('attempt 1 of 3'), message);
    t.truthy('it names the check that passed', message.includes('the report exists'), message);
    t.truthy('it names both that failed', message.includes('typescript compiles') && message.includes('the endpoint is registered'), message);
    const report = failureReport(three);
    t.truthy('the attached report carries the exit code', report.includes('EXIT  : 2'), report);
    t.truthy('and lists the checks that passed', report.includes('CHECKS THAT PASSED'), report);
    // One line per check for the live log and the task card: its name, its kind and what it runs.
    t.check('a check in one line', describeCheck(failing), 'typescript compiles: exit-zero — exit /b 2');

    /*
     * The message and its file quote the checks — the command, the value looked for, and the detail
     * that repeats that value — so a token in any of them is redacted where the text is written, not
     * only where a caller remembers to.
     */
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const key = 'sk-live-0123456789abcdefghij';
    const secretive = await runChecks(
      [
        { name: 'the token command fails', expect: 'exit-nonzero', ...cmd(`echo token=${token}`) },
        { name: 'the key is printed', expect: 'output-contains', value: key, ...cmd('echo nothing') },
      ],
      opts,
    );
    t.check('both secret-carrying checks fail', secretive.map((o) => o.passed), [false, false]);
    // The outcome itself, which the reviewer's brief and the reply to a reviewer's check quote too.
    t.truthy('the detail of an outcome carries no key', !secretive[1]!.detail.includes('sk-live-0123') && secretive[1]!.detail.includes('[REDACTED'), secretive[1]!.detail);
    t.truthy('nor the output it kept', !(secretive[0]!.output ?? '').includes('ghp_abcdef') && (secretive[0]!.output ?? '').includes('[REDACTED'), secretive[0]!.output);
    const told = failureMessage(secretive, 1, 3);
    t.truthy('a token in a check command is redacted in the message', !told.includes('ghp_abcdef') && told.includes('[REDACTED'), told);
    t.truthy('a key in a check value, and in the detail quoting it, is redacted in the message', !told.includes('sk-live-0123'), told);
    const attached = failureReport(secretive);
    t.truthy('and both are redacted in the attached report', !attached.includes('ghp_abcdef') && !attached.includes('sk-live-0123'), attached);
  });

  /*
   * A review finding's check, and the three rules that keep it from becoming a wall: kept only if it
   * fails on the work as it stands; suspended by a dispute until the next review rules; never the
   * reason a task ends on its own.
   */
  await scenario('derived checks', async () => {
    const findingWithBadCheck = {
      id: 'r1f1', what: 'x', evidence: 'y', basis: 'the build must pass', where: 'z', about: 'work' as const,
      check: { name: 'always fine', expect: 'exit-zero' as const, run: 'echo fine', shell: 'cmd' as const, cwd: checksDir },
    };
    const findingWithGoodCheck = {
      id: 'r1f2', what: 'the build fails', evidence: 'y', basis: 'the build must pass', where: 'api/src', about: 'work' as const,
      check: { name: 'the build passes', expect: 'exit-zero' as const, run: 'exit /b 3', shell: 'cmd' as const, cwd: checksDir },
    };
    const findingWithout = { id: 'r1f3', what: 'no check given', evidence: 'y', basis: 'the build must pass', where: 'w', about: 'work' as const };
    const validated = await validateDerivedChecks([findingWithBadCheck, findingWithGoodCheck, findingWithout], { cwd: checksDir, logDir: checkLogs });
    t.check('kept: the check that fails now', validated.kept.map((k) => k.finding.id), ['r1f2']);
    t.check('refused: the check that passes on the defective work', validated.refused.map((r) => r.finding.id), ['r1f1']);
    t.check('blocked: none', validated.blocked.length, 0);
    t.check('named so it cannot clash', validated.kept[0]?.check.name, derivedCheckName('r1f2', 'the build passes'));

    // A refused check's detail goes back to the reviewer's chat; a token it looked for is not in it.
    const leaky = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const findingWithSecret = {
      id: 'r1f5', what: 'x', evidence: 'y', basis: 'the build must pass', where: 'z', about: 'work' as const,
      check: { name: 'prints the token', expect: 'output-contains' as const, value: leaky, run: `echo ${leaky}`, shell: 'cmd' as const, cwd: checksDir },
    };
    const leakyValidated = await validateDerivedChecks([findingWithSecret], { cwd: checksDir, logDir: checkLogs });
    t.check('a check that passes on the work as it is is refused', leakyValidated.refused.map((r) => r.finding.id), ['r1f5']);
    const shown = leakyValidated.refused[0]?.outcome.detail ?? '';
    t.truthy('and the detail the reviewer is shown carries no token', shown !== '' && !shown.includes('ghp_abcdef'), shown);

    const other: TaskReviewCheck = {
      check: { name: derivedCheckName('r1f4', 'the page renders'), expect: 'exit-zero', run: 'exit /b 1', shell: 'cmd' },
      findingId: 'r1f4', what: 'the page is blank', where: 'web/app', round: 1, attempt: 1, state: 'active',
    };
    const kept: TaskReviewCheck[] = [
      ...validated.kept.map((k) => ({ check: k.check, findingId: k.finding.id, what: k.finding.what, where: k.finding.where, round: 1, attempt: 1, state: 'active' as const })),
      other,
    ];
    const paused = suspendDisputed(kept, ['R1F2', 'r9f9']);
    t.check('a dispute suspends only the disputed finding\'s check', paused.suspended, ['r1f2']);
    t.check('states after the dispute', paused.checks.map((c) => [c.findingId, c.state]), [['r1f2', 'suspended'], ['r1f4', 'active']]);

    // Both suspended now, so the next review rules on each: r1f2 raised again, r1f4 not.
    const bothSuspended = suspendDisputed(kept, ['r1f2', 'r1f4']).checks;
    const settled = settleAfterReview(bothSuspended, 'fail', [
      { what: 'the build still fails', evidence: 'e', basis: 'the build must pass', where: 'api/src', about: 'work' },
    ]);
    t.check('raised again -> reactivated', settled.reactivated, ['r1f2']);
    t.check('not raised -> dropped', settled.dropped, ['r1f4']);
    t.check('states after the review', settled.checks.map((c) => [c.findingId, c.state]), [['r1f2', 'active'], ['r1f4', 'dropped']]);
    const passedReview = settleAfterReview(bothSuspended, 'pass', []);
    t.check('a passing review drops every suspended check', passedReview.dropped, ['r1f2', 'r1f4']);

    const planCheck: TaskCheck = { name: 'a command that succeeds', expect: 'exit-zero', ...cmd('echo fine') };
    const derivedFail: CheckOutcome = { check: kept[0]!.check, passed: false, detail: 'd' };
    const planFail: CheckOutcome = { check: planCheck, passed: false, detail: 'd' };
    const planPass: CheckOutcome = { check: planCheck, passed: true, detail: 'd' };
    t.check('only derived checks failing -> goes to the reviewer', onlyDerivedFailing([derivedFail, planPass]), true);
    t.check('a plan check failing too -> the task fails', onlyDerivedFailing([derivedFail, planFail]), false);
    t.check('nothing failing -> false', onlyDerivedFailing([planPass]), false);
  });

  /*
   * The check the runner adds before every commit. Installed, built and secret files are named — file
   * by file, since a new `node_modules/` is one line to `git status` and thousands of files to a commit
   * — and once they are ignored the check passes. A folder that is not a repository has nothing to commit.
   */
  await scenario('commit-clean, through runCheck', async () => {
    const repo = join(base, 'hygiene');
    await mkdir(repo, { recursive: true });
    await makeRepo(repo);
    await mkdir(join(repo, 'node_modules'), { recursive: true });
    await mkdir(join(repo, 'web'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'x.js'), 'module.exports = 1;\n', 'utf8');
    await writeFile(join(repo, 'web', 'tsconfig.tsbuildinfo'), '{}\n', 'utf8');
    await writeFile(join(repo, '.env'), 'SECRET=1\n', 'utf8');
    const dirty = await runCheck(COMMIT_CLEAN_CHECK, 0, { cwd: repo, logDir: checkLogs, repoDir: repo });
    t.check('with tool output and a secrets file in the tree -> failed', dirty.passed, false);
    t.truthy('the detail names node_modules/', dirty.detail.includes('node_modules/'), dirty.detail);
    t.truthy('the detail names web/tsconfig.tsbuildinfo', dirty.detail.includes('web/tsconfig.tsbuildinfo'), dirty.detail);
    t.truthy('the detail names .env', dirty.detail.includes('.env ('), dirty.detail);

    await writeFile(join(repo, '.gitignore'), 'node_modules/\n*.tsbuildinfo\n.env\n', 'utf8');
    const clean = await runCheck(COMMIT_CLEAN_CHECK, 0, { cwd: repo, logDir: checkLogs, repoDir: repo });
    t.check('once .gitignore lists them -> passed', clean.passed, true);

    const plain = await mkdtemp(join(tmpdir(), 'cop-exec-norepo-'));
    try {
      const none = await runCheck(COMMIT_CLEAN_CHECK, 0, { cwd: plain, logDir: checkLogs, repoDir: plain });
      t.check('a folder with no repository -> passed', none.passed, true);
    } finally {
      await rm(plain, { recursive: true, force: true }).catch(() => undefined);
    }
  });
} finally {
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => undefined);
}

t.finish();
