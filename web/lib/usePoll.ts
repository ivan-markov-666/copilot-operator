'use client';

/**
 * Asks the API the same question over and over, one question at a time.
 *
 * Every page used to poll with `setInterval`, which fires on the clock whether or not the previous
 * request has come back. While the API answers in milliseconds that makes no difference; while it
 * is busy — a long git command, a big session file, a laptop waking from sleep — the requests pile
 * up, and a browser allows only about six at a time to one host. The approvals banner, the nav, the
 * register and the session page together then filled every slot, and the one request that
 * mattered, the operator pressing Run on a waiting step, queued behind them. So the next call is
 * scheduled `everyMs` after the previous one has finished, never on a fixed beat, and a page that
 * unmounts stops the chain.
 *
 * `read` may change on every render (it usually closes over state); the loop always calls the latest
 * one without restarting, so a new render never fires an extra request.
 */
import { useEffect, useRef } from 'react';

export function usePoll(read: () => Promise<unknown>, everyMs: number, enabled = true): void {
  const latest = useRef(read);
  latest.current = read;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      try {
        await latest.current();
      } catch {
        /* the caller shows its own errors; the loop goes on either way */
      } finally {
        if (!stopped) timer = setTimeout(() => void tick(), everyMs);
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [everyMs, enabled]);
}
