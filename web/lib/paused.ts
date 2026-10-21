/**
 * The minutes a task has run, its pauses not counted (operator, 2026-10-21: "when paused, the time must stop being
 * measured"): from its start to now, less the time from each "Pause" to its "Continue" — the one going on counted to
 * now, so the minutes stand still while it is paused. As the runner counts them against the limit (`Hold` in
 * src/orchestrator/hold.ts).
 */
export function workedMs(startedAt: string | undefined, pauses: ReadonlyArray<{ from: string; to?: string }> | undefined, now: number): number {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return 0;
  let held = 0;
  for (const p of pauses ?? []) {
    const from = Date.parse(p.from);
    const to = p.to ? Date.parse(p.to) : now;
    if (Number.isFinite(from) && Number.isFinite(to)) held += Math.max(0, Math.min(to, now) - Math.max(from, start));
  }
  return Math.max(0, now - start - held);
}
