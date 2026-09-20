'use client';

import { useEffect, useState } from 'react';

/**
 * The current time, ticking every second while `active`, frozen otherwise.
 *
 * A running duration has to move or it is not a clock; a finished one has no reason to
 * re-render anything. The caller says which it is, so a page full of finished tasks costs
 * nothing and a page with one running task ticks once a second.
 */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [active, everyMs]);
  return now;
}
