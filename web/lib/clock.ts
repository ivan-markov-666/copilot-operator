/**
 * How long things took, from the timestamps the record already has.
 *
 * A task carries `startedAt` and `finishedAt`; a run is the tasks that share a `runGroup`.
 * Nothing here is stored, because a duration is arithmetic over two instants the record keeps
 * anyway, and storing it would be one more field that could disagree with them.
 */

export type Timed = { startedAt?: string; finishedAt?: string; status: string };
export type RunLike = { id: string; startedAt: string };

/** Milliseconds between two instants, the second defaulting to `now`. Undefined without a start. */
export function elapsedMs(from?: string, to?: string, now = Date.now()): number | undefined {
  if (!from) return undefined;
  const a = Date.parse(from);
  if (Number.isNaN(a)) return undefined;
  const b = to ? Date.parse(to) : now;
  return Number.isNaN(b) ? undefined : Math.max(0, b - a);
}

/** Whether a task is still going: started, and neither finished nor waiting in the queue. */
export function isLive(t: Timed): boolean {
  return !!t.startedAt && !t.finishedAt && t.status !== 'queued';
}

/**
 * The span of a run: from its start to its last finish — or to now, while any of it runs.
 *
 * `tasks` are the ones the run started; a run whose last task has not started yet is still
 * live from the operator's point of view, which is why liveness is "anything not finished"
 * rather than "anything running".
 */
export function runSpanMs(run: RunLike, tasks: Timed[], now = Date.now()): { ms: number; live: boolean; tasks: number } {
  const live = tasks.some((t) => isLive(t));
  const ends = tasks.map((t) => (t.finishedAt ? Date.parse(t.finishedAt) : NaN)).filter((n) => !Number.isNaN(n));
  const start = Date.parse(run.startedAt);
  const end = live || ends.length === 0 ? now : Math.max(...ends);
  return { ms: Number.isNaN(start) ? 0 : Math.max(0, end - start), live, tasks: tasks.length };
}

/** The most recent run among a session's tasks, with the tasks that belong to it. */
export function latestRun<T extends Timed & { runGroup?: RunLike }>(tasks: T[]): { run: RunLike; tasks: T[] } | null {
  const byId = new Map<string, { run: RunLike; tasks: T[] }>();
  for (const t of tasks) {
    if (!t.runGroup) continue;
    const entry = byId.get(t.runGroup.id) ?? { run: t.runGroup, tasks: [] };
    entry.tasks.push(t);
    byId.set(t.runGroup.id, entry);
  }
  const runs = [...byId.values()].sort((a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt));
  return runs[0] ?? null;
}
