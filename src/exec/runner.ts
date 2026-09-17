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
 */
import { spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type Shell = 'pwsh' | 'powershell' | 'cmd';

export type RunRequest = {
  /** Step id from the Copilot reply, used in logs and in the report. */
  id: number;
  shell: Shell;
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
  shell: Shell;
  command: string;
  exitCode: number;
  /** Why the step ended. */
  outcome: 'completed' | 'hard-timeout' | 'idle-timeout' | 'aborted' | 'spawn-error';
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

function shellInvocation(req: RunRequest): { file: string; args: string[] } {
  const isScript = Array.isArray(req.scriptArgs);
  switch (req.shell) {
    case 'pwsh':
    case 'powershell': {
      const file = req.shell === 'pwsh' ? 'pwsh.exe' : 'powershell.exe';
      const base = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
      return isScript
        ? { file, args: [...base, '-File', req.command, ...(req.scriptArgs ?? [])] }
        : { file, args: [...base, '-Command', req.command] };
    }
    case 'cmd':
      return isScript
        ? { file: 'cmd.exe', args: ['/d', '/c', req.command, ...(req.scriptArgs ?? [])] }
        : { file: 'cmd.exe', args: ['/d', '/s', '/c', req.command] };
  }
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

  await mkdir(dirname(req.logPath), { recursive: true });
  const log: WriteStream = createWriteStream(req.logPath, { flags: 'a' });
  log.write(`# step ${req.id} shell=${req.shell} cwd=${req.cwd}\n# ${req.command}\n`);

  const { file, args } = shellInvocation(req);

  return await new Promise<RunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let bytesOut = 0;
    let truncated = false;
    let lastLine = '';
    let lastOutputAt = Date.now();
    let settled = false;

    const child = spawn(file, args, {
      cwd: req.cwd,
      env: req.env ?? process.env,
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
        shell: req.shell,
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
      log.write(stream === 'err' ? text.replace(/^/gm, '[stderr] ') : text);

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
