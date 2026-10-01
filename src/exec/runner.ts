/**
 * Runs one step in a Windows shell and captures everything it produced.
 *
 * The hard case this is built for: a step that runs an automated test suite. Such a step
 * can legitimately take an hour, and a naive wall-clock timeout would kill a perfectly
 * healthy run. So there are two independent clocks:
 *
 *   hardTimeoutMs   absolute ceiling. A run that exceeds it is killed, no matter what.
 *   idleTimeoutMs   how long the process may produce NO output at all before it is
 *                   considered hung. This is the clock that actually matters: a test suite
 *                   printing a line every few seconds resets it forever, while a genuinely
 *                   stuck process trips it quickly.
 *
 * Output is streamed to disk as it arrives, so a killed step still reports everything it
 * managed to print. Nothing is buffered in memory only.
 *
 * Which shell a step runs in is not decided here. It is decided in `shells.ts`, for steps and
 * post-task checks alike, and this module only carries the answer out again in the result —
 * what was asked for, what it ran in, and the executable that was actually started — because a
 * run that behaved oddly is usually a run that was read by an interpreter nobody looked at.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { effectiveShell, invocationFor, missingShellProblem, resolveShell, type ResolvedShell, type Shell, type ShellProblem } from './shells.js';
import { stopTree, type ProcessTracker } from './processes.js';
import { stepEnvironment } from './stepEnv.js';

export type { Shell } from './shells.js';

export type RunRequest = {
  /** Step id from the Copilot reply, used in logs and in the report. */
  id: number;
  /** The shell this was written for. Left out when nothing named one, and then one is chosen. */
  shell?: Shell;
  /** A single command line, or, for a downloaded script, the file to run. */
  command: string;
  /** Present when `command` is a script path rather than an inline command. */
  scriptArgs?: string[];
  cwd: string;
  /** Absolute ceiling. Default 4 hours. */
  hardTimeoutMs?: number;
  /** No-output ceiling. Default 15 minutes. */
  idleTimeoutMs?: number;
  /** Where the raw streams are written. */
  logPath: string;
  env?: NodeJS.ProcessEnv;
  /** Variables to pass beyond the fixed set, by name. See `stepEnv.ts`. */
  passEnv?: string[];
};

export type RunResult = {
  id: number;
  /** The shell the command was given to. */
  shell: Shell;
  /** What was asked for, or null when nothing named a shell and the runner chose one. */
  requestedShell?: Shell | null;
  /** The executable that was started, which is the part a diagnosis usually turns on. */
  shellPath?: string;
  command: string;
  exitCode: number;
  /** Why the step ended. */
  /*
   * `refused` is a step the runner declined — a policy, a deny pattern, a repeat, a missing shell —
   * which never became a process and so has no exit code of its own. It is kept apart from
   * `aborted` (a person stopped or skipped it) and from `completed` with a non-zero exit (it ran
   * and failed), because the three call for different next moves: rewrite the step, wait for the
   * person, or fix what the output shows.
   */
  outcome: 'completed' | 'hard-timeout' | 'idle-timeout' | 'aborted' | 'refused' | 'spawn-error';
  /**
   * Set when the step never ran, or died at birth, because of the machine rather than the work.
   *
   * A caller that sees this must not treat it as a failed attempt at the task: there is nothing
   * for a language model to fix in a missing interpreter.
   */
  shellProblem?: ShellProblem;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** True when the captured text was cut to `maxCaptureChars`. */
  truncated: boolean;
  /** Full, uncut streams on disk. */
  logPath: string;
  /** Milliseconds since the process last printed anything, at the moment it ended. */
  lastOutputAgoMs: number;
};

export type Heartbeat = (info: {
  id: number;
  elapsedMs: number;
  idleMs: number;
  bytesOut: number;
  lastLine: string;
}) => void;

/** One piece of a step's output, decoded, and the stream it came on. */
export type OutputListener = (text: string, stream: 'out' | 'err') => void;

const DEFAULT_HARD_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
/** How often a running step says how it is doing, unless the caller asks for another pace. */
const HEARTBEAT_EVERY_MS = 30_000;
/**
 * Cap on what is held in memory and echoed into the report body, per stream.
 *
 * Exported because whatever decides something from the captured text has to know where it stops:
 * past it the text is not the whole output, and an answer read from it may not be the true one.
 */
export const MAX_CAPTURE_CHARS = 200_000;
/**
 * How much of a line that has not ended yet is carried over to the next chunk, so the last line a
 * heartbeat shows is a whole line. Bounded, because a program can print a megabyte with no newline.
 */
const LINE_CARRIED_CHARS = 2_000;
/** The longest delay a Node timer can hold: 2^31-1 ms, about 24.8 days. */
const LONGEST_TIMER_MS = 2_147_483_647;

/**
 * A delay a timer will really wait.
 *
 * Node does not refuse a delay it cannot hold. Above 2^31-1 ms, Infinity included, and below 1 ms
 * or not a number at all, it sets the timer to 1 ms and prints a warning nobody reads. For the
 * heartbeat that is a beat every millisecond; for the hard clock it is a step killed as it starts,
 * which is what a step allowed a month would get. So a delay too long for a timer becomes the
 * longest one there is, and one that is not a delay at all becomes the default.
 */
function timerDelay(ms: number | undefined, fallback: number): number {
  if (ms === undefined || !(ms >= 1)) return fallback;
  return Math.min(ms, LONGEST_TIMER_MS);
}

/**
 * A piece of stderr as the log shows it: every line marked once, at its start.
 *
 * It used to be marked with `^` in multiline mode, which also counts a `\r` as the end of a line.
 * On Windows each line came out as `[stderr] text\r[stderr] \n`, a piece that ended a line put a
 * mark at its very end, ahead of whatever was written next, and a piece that went on with a line
 * already begun put another in the middle of it. A pipe hands over pieces, not lines, so whether a
 * piece begins a line is known only from the one before it, and the caller says.
 */
function markStderr(text: string, atLineStart: boolean): string {
  return `${atLineStart ? '[stderr] ' : ''}${text.replace(/\n(?=[^])/g, '\n[stderr] ')}`;
}

/**
 * The result of a step that never started because the machine has no shell for it.
 *
 * Shaped like a spawn error, because that is what it would have been a moment later, and with
 * the problem attached so that whoever is counting attempts can see this one does not count.
 */
function unrunnable(req: RunRequest, problem: ShellProblem): RunResult {
  return {
    id: req.id,
    // What it would have run in, which on a machine with nothing installed is only a name.
    shell: effectiveShell(req.shell),
    requestedShell: req.shell ?? null,
    shellPath: '',
    shellProblem: problem,
    command: req.command,
    exitCode: -2,
    outcome: 'spawn-error',
    durationMs: 0,
    stdout: '',
    stderr: `[runner] the command was not run: ${problem.message}\n`,
    truncated: false,
    logPath: '',
    lastOutputAgoMs: 0,
  };
}

/**
 * The result of a step the operator stopped before it began.
 *
 * Shaped like a stop in the middle of a run, because that is what the operator asked for and what
 * whoever reads the result has to act on, but with nothing started and nothing logged: there is no
 * process to account for and no stream to point at. Its duration is the time runStep took to find
 * that out, measured like any other, so that a stop which was slow to be noticed shows as slow.
 */
function stoppedBeforeStart(req: RunRequest, resolved: ResolvedShell, startedAt: number): RunResult {
  return {
    id: req.id,
    shell: resolved.shell,
    requestedShell: resolved.requested,
    shellPath: resolved.path,
    command: req.command,
    exitCode: -3,
    outcome: 'aborted',
    durationMs: Date.now() - startedAt,
    stdout: '',
    stderr: '[runner] the command was not run: the operator stopped the run before it started\n',
    truncated: false,
    logPath: '',
    lastOutputAgoMs: 0,
  };
}

/**
 * The longest a step that is being stopped may take before its result is given anyway. The stop
 * itself is `taskkill /T`, a grace period, then `/F` (see `processes.ts`), which with reading the
 * process table comes to about ten seconds at worst; this is the ceiling on
 * waiting for it, so that a stop that itself hangs cannot hang the task.
 */
const STOP_CEILING_MS = 30_000;

export async function runStep(
  req: RunRequest,
  /**
   * `tracker` records the shell this step starts, which is what later lets the runner tell the
   * processes the bot started from ones the operator started by hand. See `processes.ts`.
   *
   * `heartbeatMs` is how often `onHeartbeat` is called while the step runs. The live log wants a
   * beat every half minute and no more; a caller that needs to see what a beat carries during a
   * step of a few seconds asks for a shorter one, since at the default none would come at all.
   *
   * `onOutput` is given every piece of output as it is decoded, all of it, including what falls
   * past MAX_CAPTURE_CHARS and is kept on disk only. It is how a caller decides something about the
   * whole output (an output check does) without the runner holding the whole output in memory. It
   * is called from the stream's handler, so it has to be quick.
   */
  opts: { signal?: AbortSignal; onHeartbeat?: Heartbeat; heartbeatMs?: number; onOutput?: OutputListener; tracker?: ProcessTracker } = {},
): Promise<RunResult> {
  // Every clock goes through `timerDelay`: a delay Node cannot hold would fire after 1 ms.
  const hardTimeoutMs = timerDelay(req.hardTimeoutMs, DEFAULT_HARD_TIMEOUT_MS);
  const idleTimeoutMs = timerDelay(req.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
  const heartbeatMs = timerDelay(opts.heartbeatMs, HEARTBEAT_EVERY_MS);
  const startedAt = Date.now();

  // Every path into the shell goes through here, which is what makes a step and a post-task
  // check incapable of disagreeing about which interpreter their commands were read by.
  const choice = resolveShell(req.shell);
  if (!choice.ok) return unrunnable(req, choice.problem);
  const resolved = choice.resolved;

  await mkdir(dirname(req.logPath), { recursive: true });
  /*
   * A Stop that came before the step began means the step never begins.
   *
   * The signal is listened to only once the process exists, and 'abort' is fired once: a signal
   * already aborted by then — Stop pressed while the previous step was ending, or during the await
   * just above — never fires again, and the step used to run its whole course, hours under the
   * default ceiling, with the operator's Stop on record. It is asked here, after the last await and
   * before anything is written or started, because from this line to the listener below everything
   * runs in one go: no abort can arrive in between and be missed.
   */
  if (opts.signal?.aborted) return stoppedBeforeStart(req, resolved, startedAt);
  const log: WriteStream = createWriteStream(req.logPath, { flags: 'a' });
  /*
   * A step log that cannot be written must never take the process down with it.
   *
   * Without a listener, a stream error is an unhandled 'error' event, which in Node is an
   * uncaught exception: a full disk, a locked file or a write that lands after the stream has
   * ended would kill the API in the middle of a run. The log is a record of a step, not the
   * step itself, so losing a line of it is the smallest possible failure and is treated as one.
   */
  log.on('error', () => undefined);
  log.write(`# step ${req.id} shell=${resolved.shell} exe=${resolved.path} cwd=${req.cwd}\n# ${req.command}\n`);

  const { file, args } = invocationFor(resolved, req.command, req.scriptArgs);

  return await new Promise<RunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let bytesOut = 0;
    let truncated = false;
    let lastLine = '';
    /*
     * The end of each stream that has no newline yet. A pipe hands over whatever is there, not
     * whole lines, so a line can arrive in two chunks; read chunk by chunk, the last line would be
     * the second half of it, which is text the step never printed on its own.
     */
    const unfinished = { out: '', err: '' };
    let lastOutputAt = Date.now();
    let settled = false;
    /** Set when the shell itself would not start, which is not a failure of the command. */
    let shellProblem: ShellProblem | undefined;

    // PowerShell colours its output with ANSI escapes, which then travel to Copilot inside
    // the report as `ESC[32;1m` noise around every value. NO_COLOR is honoured by
    // PowerShell 7 and by most modern tools, and was verified to produce clean output here.
    const child = spawn(file, args, {
      cwd: req.cwd,
      // Named, not inherited: a step must not see the bot's own token or whatever else the
      // operator's shell holds. See `stepEnv.ts`.
      env: stepEnvironment(req.env ?? process.env, req.passEnv),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) opts.tracker?.started(child.pid);

    /** Set once the runner has decided to stop the step, so the process exiting reports why. */
    let stopping: { outcome: RunResult['outcome']; exitCode: number } | null = null;

    const finish = (outcome: RunResult['outcome'], exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (child.pid) opts.tracker?.ended(child.pid);
      clearInterval(heartbeat);
      clearTimeout(hardTimer);
      clearInterval(idleTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      log.end(`\n# outcome=${outcome} exit=${exitCode} durationMs=${Date.now() - startedAt}\n`);
      resolve({
        id: req.id,
        shell: resolved.shell,
        requestedShell: resolved.requested,
        shellPath: resolved.path,
        shellProblem,
        command: req.command,
        exitCode,
        outcome,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        truncated,
        logPath: req.logPath,
        lastOutputAgoMs: Date.now() - lastOutputAt,
      });
    };

    /*
     * Each stream has a decoder of its own, which holds back the first bytes of a character that a
     * chunk ended in the middle of until the rest arrives. A pipe cuts where it cuts, not between
     * characters, and a chunk decoded by itself turned the two halves of a '✕' or a Cyrillic letter
     * into two replacement characters: in the captured text, the log, the last line, and the output
     * a check is decided on, where an output-omits would then pass on output that did contain it.
     */
    const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };

    const capture = (chunk: Buffer, stream: 'out' | 'err'): void => {
      lastOutputAt = Date.now();
      bytesOut += chunk.length;
      take(decoders[stream].write(chunk), stream);
    };

    const take = (text: string, stream: 'out' | 'err'): void => {
      if (!text) return;
      // Output can still arrive after the child has closed and the step has been settled: the
      // pipes flush independently of the close event. Writing then would be a write to an
      // ended stream, so the tail goes to the captured text and not to the file.
      if (!settled) {
        log.write(stream === 'err' ? markStderr(text, unfinished.err === '') : text);
        /*
         * The caller's listener runs inside this stream handler, where a throw would be an uncaught
         * exception and take the API down in the middle of a run. What it was working out is the
         * caller's to get right; the step itself goes on either way.
         */
        try {
          opts.onOutput?.(text, stream);
        } catch {
          /* the listener's fault, not the step's */
        }
      }

      const joined = unfinished[stream] + text;
      const end = joined.lastIndexOf('\n');
      unfinished[stream] = (end >= 0 ? joined.slice(end + 1) : joined).slice(-LINE_CARRIED_CHARS);
      const trimmed = joined.trimEnd();
      const nl = trimmed.lastIndexOf('\n');
      if (trimmed) lastLine = nl >= 0 ? trimmed.slice(nl + 1) : trimmed;

      const target = stream === 'out' ? stdout : stderr;
      if (target.length >= MAX_CAPTURE_CHARS) {
        truncated = true;
        return;
      }
      const room = MAX_CAPTURE_CHARS - target.length;
      const slice = text.length > room ? text.slice(0, room) : text;
      if (slice.length < text.length) truncated = true;
      if (stream === 'out') stdout += slice;
      else stderr += slice;
    };

    child.stdout.on('data', (c: Buffer) => capture(c, 'out'));
    child.stderr.on('data', (c: Buffer) => capture(c, 'err'));

    child.on('error', (err) => {
      stderr += `\n[runner] failed to start: ${String(err)}\n`;
      /*
       * ENOENT here is usually the interpreter — `spawn` never got as far as reading what it was
       * given — and that is worth saying plainly, because the one thing that must not happen next
       * is the task treating it as work that failed and trying again.
       *
       * It is not always the interpreter, though, and Windows makes the two indistinguishable
       * from the error alone. A `cwd` that does not exist raises ENOENT as well, and Node writes
       * the *executable's* name into the message while doing it: `spawn cmd.exe ENOENT` for a
       * directory that was simply never created. A step or a check pointed at a folder an earlier
       * step was supposed to make would then close the task with a sentence about PowerShell not
       * being installed — false, and worse than false, because an environment fault is never sent
       * back to the chat and the chat is the only thing that could have created the folder. So
       * the two are told apart by the one fact that separates them: whether the executable is
       * still where detection found it.
       */
      const enoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (enoent && !existsSync(resolved.path)) shellProblem = missingShellProblem(resolved);
      finish('spawn-error', -2);
    });
    child.on('close', (code) => {
      // Both streams have ended, so whatever a decoder still holds is the last of its stream: the
      // start of a character the process never finished, given as the replacement character.
      take(decoders.out.end(), 'out');
      take(decoders.err.end(), 'err');
      // While the runner is stopping the step the process exiting is the stop working, not the step
      // completing, so the reason recorded is the runner's.
      if (stopping) finish(stopping.outcome, stopping.exitCode);
      else finish('completed', code ?? -1);
    });

    /*
     * Stops the step's whole tree — `taskkill /T`, then `/F` — and gives the result only
     * once it is down, so the next step does not start while this one still holds a port or a
     * file. It used to be `taskkill /T /F` at once, which is TerminateProcess: no handler runs, and a
     * dev server or a test runner is cut off mid-write.
     */
    const stop = (outcome: RunResult['outcome'], exitCode: number, why: string): void => {
      if (stopping || settled) return;
      stopping = { outcome, exitCode };
      stderr += `\n[runner] ${why}, stopping the process tree (asked to close, then forced)\n`;
      clearTimeout(hardTimer);
      clearInterval(idleTimer);
      const ceiling = setTimeout(() => finish(outcome, exitCode), STOP_CEILING_MS);
      const pid = child.pid;
      void (pid ? stopTree(pid, startedAt) : Promise.resolve())
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(ceiling);
          finish(outcome, exitCode);
        });
    };

    const hardTimer = setTimeout(() => {
      stop('hard-timeout', -1, `hard timeout after ${Math.round(hardTimeoutMs / 1000)}s`);
    }, hardTimeoutMs);

    const idleTimer = setInterval(() => {
      if (Date.now() - lastOutputAt < idleTimeoutMs) return;
      stop('idle-timeout', -1, `no output for ${Math.round(idleTimeoutMs / 1000)}s, treating as hung`);
    }, Math.min(idleTimeoutMs, 30_000));

    const heartbeat = setInterval(() => {
      opts.onHeartbeat?.({
        id: req.id,
        elapsedMs: Date.now() - startedAt,
        idleMs: Date.now() - lastOutputAt,
        bytesOut,
        lastLine,
      });
    }, heartbeatMs);

    const onAbort = (): void => {
      stop('aborted', -3, 'aborted by the user');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
