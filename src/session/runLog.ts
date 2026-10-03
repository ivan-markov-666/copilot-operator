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
import { appendFile, mkdir, readFile } from 'node:fs/promises';
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
