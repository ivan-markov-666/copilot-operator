/**
 * "Pause" on the chat (operator, 2026-10-20: a "Pause" button that pauses the work on a task, and turns into
 * "Continue" to go on when the operator sees fit).
 *
 * The task holds where it is. The reply being waited for is waited for and the command running runs to its end —
 * neither can be held halfway — and then nothing more is sent to Copilot and no other command runs until the
 * operator continues. Nothing ends: it is the same task, in the same conversation and the same browser window,
 * after it, and the time it spent held does not count against `maxRunMinutes`.
 *
 * Not `RunDeps.shouldPause`, which holds a queue between tasks, after the task running has ended properly.
 */
export class Hold {
  private paused = false;
  private waiting: Array<() => void> = [];
  /**
   * Each pause, from "Pause" pressed to "Continue" (operator, 2026-10-21: "when paused, the time must stop being
   * measured"): the clock stops at the press, not at the point the work reaches a little later, and the time it was
   * paused is taken off a task's minutes — its limit, and the minutes the page shows.
   */
  private spans: Array<{ from: number; to?: number }> = [];

  /** Whether the operator has asked the task to hold. */
  get held(): boolean {
    return this.paused;
  }

  /** Asks the task to hold at its next message or command. False when it was held already. */
  pause(): boolean {
    if (this.paused) return false;
    this.paused = true;
    this.spans.push({ from: Date.now() });
    return true;
  }

  /** Lets the task go on. False when it was not held. */
  resume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    const open = this.spans.at(-1);
    if (open && open.to === undefined) open.to = Date.now();
    for (const go of this.waiting.splice(0)) go();
    return true;
  }

  /** How long the work was paused since `since` (ms), the pause going on counted to now. */
  pausedSince(since: number, now = Date.now()): number {
    return pausedWithin(this.spans, since, now);
  }

  /** The pauses, for the page to take them off the minutes it shows. */
  get pauses(): Array<{ from: string; to?: string }> {
    return this.spans.map((s) => ({ from: new Date(s.from).toISOString(), ...(s.to !== undefined ? { to: new Date(s.to).toISOString() } : {}) }));
  }

  /** Resolves at once when not held; otherwise when the operator continues, or the run is stopped. */
  until(signal?: AbortSignal): Promise<void> {
    if (!this.paused || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const go = (): void => {
        signal?.removeEventListener('abort', go);
        this.waiting = this.waiting.filter((w) => w !== go);
        resolve();
      };
      this.waiting.push(go);
      signal?.addEventListener('abort', go, { once: true });
    });
  }
}

/** The time of `spans` that falls between `since` and `now`, a span with no end lasting to `now`. */
export function pausedWithin(spans: ReadonlyArray<{ from: number; to?: number }>, since: number, now: number): number {
  let ms = 0;
  for (const s of spans) ms += Math.max(0, Math.min(s.to ?? now, now) - Math.max(s.from, since));
  return ms;
}
