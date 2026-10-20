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

  /** Whether the operator has asked the task to hold. */
  get held(): boolean {
    return this.paused;
  }

  /** Asks the task to hold at its next message or command. False when it was held already. */
  pause(): boolean {
    if (this.paused) return false;
    this.paused = true;
    return true;
  }

  /** Lets the task go on. False when it was not held. */
  resume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    for (const go of this.waiting.splice(0)) go();
    return true;
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
