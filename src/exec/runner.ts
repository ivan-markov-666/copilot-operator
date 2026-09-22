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

import { effectiveShell, invocationFor, missingShellProblem, resolveShell, type Shell, type ShellProblem } from './shells.js';

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
  outcome: 'completed' | 'hard-timeout' | 'idle-timeout' | 'aborted' | 'spawn-error';
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

const DEFAULT_HARD_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const HEARTBEAT_EVERY_MS = 30_000;
/** Cap on what is held in memory and echoed into the report body. */
const MAX_CAPTURE_CHARS = 200_000;

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
 * Kills the whole process tree.
 *
 * `child.kill()` only signals the shell. A test runner spawns node, java, dotnet and
 * friends underneath it, and those survive and keep holding the console. On Windows the
 * only reliable answer is taskkill with /T.
 */
function killTree(pid: number): void {
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    /* the process is already gone */
  }
}

export async function runStep(
  req: RunRequest,
  opts: { signal?: AbortSignal; onHeartbeat?: Heartbeat } = {},
): Promise<RunResult> {
  const hardTimeoutMs = req.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS;
  const idleTimeoutMs = req.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const startedAt = Date.now();

  // Every path into the shell goes through here, which is what makes a step and a post-task
  // check incapable of disagreeing about which interpreter their commands were read by.
  const choice = resolveShell(req.shell);
  if (!choice.ok) return unrunnable(req, choice.problem);
  const resolved = choice.resolved;

  await mkdir(dirname(req.logPath), { recursive: true });
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
    let lastOutputAt = Date.now();
    let settled = false;
    /** Set when the shell itself would not start, which is not a failure of the command. */
    let shellProblem: ShellProblem | undefined;

    // PowerShell colours its output with ANSI escapes, which then travel to Copilot inside
    // the report as `ESC[32;1m` noise around every value. NO_COLOR is honoured by
    // PowerShell 7 and by most modern tools, and was verified to produce clean output here.
    const child = spawn(file, args, {
      cwd: req.cwd,
      env: { NO_COLOR: '1', TERM: 'dumb', ...(req.env ?? process.env) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (outcome: RunResult['outcome'], exitCode: number): void => {
      if (settled) return;
      settled = true;
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

    const capture = (chunk: Buffer, stream: 'out' | 'err'): void => {
      const text = chunk.toString('utf8');
      lastOutputAt = Date.now();
      bytesOut += chunk.length;
      // Output can still arrive after the child has closed and the step has been settled: the
      // pipes flush independently of the close event. Writing then would be a write to an
      // ended stream, so the tail goes to the captured text and not to the file.
      if (!settled) log.write(stream === 'err' ? text.replace(/^/gm, '[stderr] ') : text);

      const trimmed = text.trimEnd();
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
    child.on('close', (code) => finish('completed', code ?? -1));

    const hardTimer = setTimeout(() => {
      stderr += `\n[runner] hard timeout after ${Math.round(hardTimeoutMs / 1000)}s, killing process tree\n`;
      if (child.pid) killTree(child.pid);
      finish('hard-timeout', -1);
    }, hardTimeoutMs);

    const idleTimer = setInterval(() => {
      if (Date.now() - lastOutputAt < idleTimeoutMs) return;
      stderr += `\n[runner] no output for ${Math.round(idleTimeoutMs / 1000)}s, treating as hung, killing process tree\n`;
      if (child.pid) killTree(child.pid);
      finish('idle-timeout', -1);
    }, Math.min(idleTimeoutMs, 30_000));

    const heartbeat = setInterval(() => {
      opts.onHeartbeat?.({
        id: req.id,
        elapsedMs: Date.now() - startedAt,
        idleMs: Date.now() - lastOutputAt,
        bytesOut,
        lastLine,
      });
    }, HEARTBEAT_EVERY_MS);

    const onAbort = (): void => {
      stderr += '\n[runner] aborted by the user\n';
      if (child.pid) killTree(child.pid);
      finish('aborted', -3);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
