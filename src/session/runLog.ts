/**
 * What a run did before any of its tasks began: the version control preflight, repository by
 * repository, and the moment the browser was asked for.
 *
 * From the bug report of 2026-10-03 (run on 0.1.20): a run refused for uncommitted files had already
 * emitted `task-started`, set up the shell, opened Edge and collected artifacts, and its export could
 * not show in which order any of it happened. The preflight now runs before all of that, and this is
 * its record: one file per run (`<runs>/_runs/<run id>/run.jsonl`), written by the service before the
 * browser opens and read back by the runner export, which can then show that `browser-launch-requested`
 * came after `run-preflight-passed` — or that a refused run never asked for a browser at all.
 */
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type RunLogType =
  | 'run-preflight-started'
  | 'repository-preflight'
  | 'snapshot-approval-required'
  | 'baseline-created'
  | 'run-preflight-passed'
  | 'run-preflight-refused'
  | 'browser-launch-requested';

export type RunLogEntry = { at: string; type: RunLogType; message: string; data?: Record<string, unknown> };

/** A run id as a folder name: what the service makes (`r-…`, `b-…`), and nothing that walks out of `_runs`. */
const safe = (runId: string): string => runId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

export function runLogPath(runsDir: string, runId: string): string {
  return join(runsDir, '_runs', safe(runId), 'run.jsonl');
}

export async function appendRunLog(runsDir: string, runId: string, entries: RunLogEntry[]): Promise<void> {
  if (!runId || entries.length === 0) return;
  const path = runLogPath(runsDir, runId);
  await mkdir(join(path, '..'), { recursive: true });
  await appendFile(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

export async function readRunLog(runsDir: string, runId: string | undefined): Promise<RunLogEntry[]> {
  if (!runId) return [];
  try {
    const text = await readFile(runLogPath(runsDir, runId), 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as RunLogEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * Whether the browser was asked for only after the preflight passed, read from the record rather
 * than claimed: the position of each in the file, which is written in the order things happened.
 */
export function browserAfterPreflight(entries: RunLogEntry[]): {
  preflightPassedAt?: string;
  browserLaunchRequestedAt?: string;
  browserOnlyAfterPreflight: boolean | null;
} {
  const passed = entries.findIndex((e) => e.type === 'run-preflight-passed');
  const browser = entries.findIndex((e) => e.type === 'browser-launch-requested');
  return {
    ...(passed >= 0 ? { preflightPassedAt: entries[passed]!.at } : {}),
    ...(browser >= 0 ? { browserLaunchRequestedAt: entries[browser]!.at } : {}),
    // No browser asked for: nothing to prove. A browser with no passed preflight before it: false.
    browserOnlyAfterPreflight: browser < 0 ? null : passed >= 0 && passed < browser,
  };
}

/**
 * The runs refused for a session before any task of it began: their logs are the only record of them,
 * since a refused run is written on no task. Found by reading the run logs under `_runs`.
 */
export async function refusedRunsOf(runsDir: string, sessionId: string): Promise<string[]> {
  const out: string[] = [];
  const ids = await readdir(join(runsDir, '_runs')).catch(() => [] as string[]);
  for (const id of ids) {
    const entries = await readRunLog(runsDir, id);
    const refused = entries.some((e) => e.type === 'run-preflight-refused');
    const browser = entries.some((e) => e.type === 'browser-launch-requested');
    const mine = entries.some((e) => e.type === 'run-preflight-started' && Array.isArray(e.data?.sessions) && (e.data!.sessions as unknown[]).includes(sessionId));
    if (refused && !browser && mine) out.push(id);
  }
  return out.sort();
}

/** Something the operator did to a session's repository or start outside a run: see `appendSessionLog`. */
export type OperatorAction = { at: string; type: string; message: string; data?: Record<string, unknown> };

/**
 * A durable record of what the operator did to a session outside any run — a fix pressed on the run
 * screen, the folder prepared from the remote. These change the repository or where the session starts,
 * and were in nothing but the live event stream and git's reflog (live run 2026-10-03). One file per
 * session, `<runs>/_sessions/<session id>/actions.jsonl`, read back by the runner export.
 */
export async function appendSessionLog(runsDir: string, sessionId: string, entry: Omit<OperatorAction, 'at'>): Promise<void> {
  const dir = join(runsDir, '_sessions', safe(sessionId));
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, 'actions.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}

export async function readSessionLog(runsDir: string, sessionId: string): Promise<OperatorAction[]> {
  const text = await readFile(join(runsDir, '_sessions', safe(sessionId), 'actions.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter((l) => l.trim()).flatMap((l) => {
    try {
      return [JSON.parse(l) as OperatorAction];
    } catch {
      return [];
    }
  });
}
