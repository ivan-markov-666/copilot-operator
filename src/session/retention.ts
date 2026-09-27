/**
 * How long a session's run folder is kept.
 *
 * A run folder holds every step's raw output, the reports that were uploaded, the reviewer's
 * transcripts and, on a failure, a screenshot of the signed-in page. Nothing used to remove any of
 * it, which for an operator's own machine is a choice and for a company is a gap: a retention
 * rule says how long such records may exist, and a tool that keeps them forever cannot follow it.
 *
 * `runsRetentionDays` in the config is the rule; 0, the default, keeps everything, because nothing
 * here should delete an operator's records without their say. When set, the API removes at start
 * every session folder whose last change is older than that. Folders whose name begins with `_`
 * are the bot's own working folders (`_browser`, `_models`) and are left alone.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Removes the session run folders older than `keepDays`; returns the names removed. */
export async function pruneRuns(runsDir: string, keepDays: number, now = Date.now()): Promise<string[]> {
  if (!Number.isFinite(keepDays) || keepDays <= 0) return [];
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const path = join(runsDir, entry.name);
    const s = await stat(path).catch(() => null);
    if (!s || s.mtimeMs >= cutoff) continue;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    removed.push(entry.name);
  }
  return removed;
}
