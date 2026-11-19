/**
 * One copilot-operator at a time on the same records (second bug hunt, 2026-11-19).
 *
 * Every npm install of the program shares one home folder (%LOCALAPPDATA%\copilot-operator), so a second `cop start`
 * — from another project, or with another port after the first said its port was taken — opened the same records.
 * Starting up, it put the first one's work to rest as a program closed under it would be: the task at work marked
 * stopped, the queue marked not running, which the first one's queue then read and stopped at. And the two wrote the
 * same files from then on.
 *
 * The lock is a file in the data folder with the process and its port. Another process alive and answering on that
 * port holds it: the start is refused, saying where the one running is. A lock whose process is gone, or whose port
 * nothing answers on (its number taken by another program since), is taken over: a crash never leaves the records
 * locked.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

export const API_LOCK_FILE = 'api.lock.json';

/** Said when another copilot-operator runs on the same records. */
export class AlreadyRunning extends Error {
  constructor(
    readonly pid: number,
    readonly port: number,
    dataDir: string,
  ) {
    super(
      `copilot-operator is already running on these records (${dataDir}): process ${pid}, at http://127.0.0.1:${port}/ — open it there. ` +
        'A second one is not started: it would take over that one\'s work, its task at work marked stopped and its queue stopped. Close that one first to start this one.',
    );
    this.name = 'AlreadyRunning';
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: there, but another account's.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function answers(port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const end = (ok: boolean): void => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(timeoutMs, () => end(false));
    socket.once('connect', () => end(true));
    socket.once('error', () => end(false));
  });
}

/** Takes the records for this process, or refuses (`AlreadyRunning`). Released when the process ends. */
export async function acquireApiLock(dataDir: string, port: number): Promise<{ release: () => void }> {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, API_LOCK_FILE);
  if (existsSync(file)) {
    let held: { pid?: unknown; port?: unknown } = {};
    try {
      held = JSON.parse(readFileSync(file, 'utf8')) as typeof held;
    } catch {
      // Unreadable: a crash mid-write, taken over.
    }
    if (typeof held.pid === 'number' && held.pid !== process.pid && typeof held.port === 'number' && alive(held.pid) && (await answers(held.port))) {
      throw new AlreadyRunning(held.pid, held.port, dataDir);
    }
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }), 'utf8');
  const release = (): void => {
    try {
      const now = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown };
      if (now.pid === process.pid) rmSync(file, { force: true });
    } catch {
      // Gone already, or another's now.
    }
  };
  process.once('exit', release);
  return { release };
}
