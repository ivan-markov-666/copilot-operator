'use client';

import { useEffect, useState } from 'react';

/**
 * "." ".." "..." going round while `on` (operator, 2026-10-26: "Stopping." then "Stopping.." then "Stopping..." and
 * again from the start), one at first and again when it stops.
 */
export function useDots(on: boolean, ms = 450): string {
  const [n, setN] = useState(1);
  useEffect(() => {
    if (!on) {
      setN(1);
      return;
    }
    const id = window.setInterval(() => setN((x) => (x % 3) + 1), ms);
    return () => window.clearInterval(id);
  }, [on, ms]);
  return '.'.repeat(n);
}
