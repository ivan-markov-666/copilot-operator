/**
 * Pacing: the small amount of deliberate waiting the bot actually needs.
 *
 * An earlier version drew delays from a log-normal distribution and occasionally took a
 * long pause, to make the traffic look less mechanical. That was dropped: it changed
 * nothing measurable. The browser still reports `navigator.webdriver === true`, and with
 * the default limits the hourly cap never binds, so the randomness only added a few
 * minutes per run.
 *
 * What is left is the part that does work:
 *
 * - `settle()`   a short fixed pause after an action, as a belt on top of the real
 *                condition waits in the transport (Stop-generating gone, SPO_ prefix on the
 *                attachment chip, Send button present). Those waits are the actual fix for
 *                flaky clicks; this is only a cushion.
 * - `throttleSend()` a hard cap on messages per hour, which is the one thing that protects
 *                against service-side throttling on long runs.
 * - `backoffFor()`   exponential backoff with jitter, so a failing step cannot turn into a
 *                tight retry loop.
 */

export type PacingProfile = {
  /** Disable settle pauses. The send cap and backoff still apply. */
  enabled: boolean;
  /** Fixed pause after an action, in milliseconds. */
  settleMs: number;
  /** Never send more than this many chat messages per hour. */
  maxMessagesPerHour: number;
  /** Seed for the backoff jitter. Omit for a random seed; it is logged. */
  seed?: number;
};

export const DEFAULT_PACING: PacingProfile = {
  enabled: true,
  settleMs: 1_000,
  maxMessagesPerHour: 60,
};

/** Small, fast, seedable PRNG, used only for backoff jitter. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Pacer {
  private readonly rnd: () => number;
  private readonly profile: PacingProfile;
  /** Timestamps of sent messages, for the hourly cap. */
  private readonly sentAt: number[] = [];

  readonly seed: number;

  constructor(profile: Partial<PacingProfile> = {}) {
    this.profile = { ...DEFAULT_PACING, ...profile };
    this.seed = this.profile.seed ?? ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    this.rnd = mulberry32(this.seed);
  }

  /** Short fixed pause after an action. Zero when pacing is disabled. */
  async settle(signal?: AbortSignal): Promise<number> {
    const ms = this.profile.enabled ? this.profile.settleMs : 0;
    if (ms > 0) await sleep(ms, signal);
    return ms;
  }

  /**
   * Wait however long is needed to stay under the hourly message cap, then record that a
   * message is being sent. Call immediately before clicking Send. Returns how long it
   * waited, so the caller can log a visible "throttled for N s".
   */
  async throttleSend(signal?: AbortSignal): Promise<number> {
    const hour = 3_600_000;
    const now = Date.now();
    while (this.sentAt.length && now - this.sentAt[0] > hour) this.sentAt.shift();

    let waited = 0;
    if (this.sentAt.length >= this.profile.maxMessagesPerHour) {
      waited = this.sentAt[0] + hour - now;
      if (waited > 0) await sleep(waited, signal);
    }
    this.sentAt.push(Date.now());
    return Math.max(waited, 0);
  }

  /** Exponential backoff with jitter, for retries after a failure. */
  backoffFor(attempt: number, baseMs = 2_000, capMs = 60_000): number {
    const exp = Math.min(baseMs * 2 ** attempt, capMs);
    return Math.round(exp * (0.5 + this.rnd() * 0.5));
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
