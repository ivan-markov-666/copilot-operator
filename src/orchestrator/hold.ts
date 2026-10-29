/**
 * "Pause" on the chat (operator, 2026-10-20: a "Pause" button that pauses the work on a task, and turns into
 * "Continue" to go on when the operator sees fit).
 *
 * The task holds where it is. The reply being waited for is waited for and the command running runs to its end —
 * neither can be held halfway — and then nothing more is sent to Copilot and no other command runs until the
 * operator continues. Nothing ends: it is the same task, in the same conversation and the same browser window,
 * after it, and the time it spent held does not count against `maxRunMinutes`.
 *
 * Nor does the time the work waits for the operator (operator, 2026-10-29: "the time the browser session may be used
 * went on while the user had not answered the chat's questions; while the bot waits for the user to type something or
 * answer, it must not count"): a card — a command, a question, a plan, the model to choose, a subtask to try again,
 * commands handed over —, Git's password window, a sign-in or a check that a person is there, each from the moment it
 * waits to the moment it is answered (`waitFor`, `waited`). A pause and a wait, or two waits, at the same time are
 * counted once.
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
  /** What waits for the operator now, by a key of its own (`card:<id>`, `pw:<session>`…), since when. */
  private waits = new Map<string, number>();
  /** The waits that were answered, or went any other way. */
  private waitedSpans: Array<{ from: number; to: number }> = [];

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

  /** Something waits for the operator from now; a second start of the same one changes nothing. */
  waitFor(key: string, at = Date.now()): void {
    if (!this.waits.has(key)) this.waits.set(key, at);
  }

  /** It was answered, or went any other way; nothing when it was not waiting. */
  waited(key: string, at = Date.now()): void {
    const from = this.waits.get(key);
    if (from === undefined) return;
    this.waits.delete(key);
    this.waitedSpans.push({ from, to: Math.max(from, at) });
  }

  /** The time not counted — paused, or waiting for the operator — joined where it overlaps, in order. */
  private notCounted(): Array<{ from: number; to?: number }> {
    return joined([...this.spans, ...this.waitedSpans, ...[...this.waits.values()].map((from) => ({ from }))]);
  }

  /** How long the work was paused or waited for the operator since `since` (ms), what goes on counted to now. */
  pausedSince(since: number, now = Date.now()): number {
    return pausedWithin(this.notCounted(), since, now);
  }

  /** The time not counted, for the page to take it off the minutes it shows: the pauses and the waits, joined. */
  get pauses(): Array<{ from: string; to?: string }> {
    return this.notCounted().map((s) => ({ from: new Date(s.from).toISOString(), ...(s.to !== undefined ? { to: new Date(s.to).toISOString() } : {}) }));
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

/** Spans joined where they overlap or touch, in order; one with no end takes in every span that starts after it. */
export function joined(spans: ReadonlyArray<{ from: number; to?: number }>): Array<{ from: number; to?: number }> {
  const out: Array<{ from: number; to?: number }> = [];
  for (const s of [...spans].sort((a, b) => a.from - b.from)) {
    const last = out.at(-1);
    if (last && (last.to === undefined || s.from <= last.to)) {
      if (last.to !== undefined) {
        if (s.to === undefined) delete last.to;
        else last.to = Math.max(last.to, s.to);
      }
    } else out.push(s.to === undefined ? { from: s.from } : { from: s.from, to: s.to });
  }
  return out;
}

/**
 * The cards that wait for the operator, kept as a map, each starting a wait when it is put in and ending it when it
 * goes — answered, set aside, stopped —, so no card can wait without its time being left out (2026-10-29).
 */
export class WaitsFor<V> extends Map<string, V> {
  constructor(private readonly onWait: (key: string, value: V, begins: boolean) => void) {
    super();
  }

  override set(key: string, value: V): this {
    const fresh = !this.has(key);
    super.set(key, value);
    // `onWait` is not there yet while `super()` runs: Map's constructor puts nothing in, but be sure.
    if (fresh) this.onWait?.(key, value, true);
    return this;
  }

  override delete(key: string): boolean {
    const had = this.has(key);
    const value = this.get(key);
    const gone = super.delete(key);
    if (had && gone) this.onWait(key, value as V, false);
    return gone;
  }

  override clear(): void {
    const all = [...this.entries()];
    super.clear();
    for (const [key, value] of all) this.onWait(key, value, false);
  }
}

/** The time of `spans` that falls between `since` and `now`, a span with no end lasting to `now`. */
export function pausedWithin(spans: ReadonlyArray<{ from: number; to?: number }>, since: number, now: number): number {
  let ms = 0;
  for (const s of spans) ms += Math.max(0, Math.min(s.to ?? now, now) - Math.max(s.from, since));
  return ms;
}
