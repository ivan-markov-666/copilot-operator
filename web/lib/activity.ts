'use client';

/**
 * Whether the bot is working, and who (operator, 2026-10-22: "show clearly what the bot is doing and who works"; "a
 * LIVE mark beside Chat while the bot works"; "and in the tab that says copilot-operator"). One poll of
 * `/api/activity` for the whole page, however many parts of it ask; the API answers it from memory.
 */
import { useEffect, useState } from 'react';
import { api, type Activity } from './api';

const EVERY_MS = 2000;
let last: Activity | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(a: Activity | null) => void>();

async function poll(): Promise<void> {
  try {
    last = await api.activity();
  } catch {
    // A missed poll keeps the last answer: a mark that blinks off because one request failed says something false.
    return;
  }
  for (const tell of listeners) tell(last);
}

export function useActivity(): Activity | null {
  const [now, setNow] = useState<Activity | null>(last);
  useEffect(() => {
    listeners.add(setNow);
    if (!timer) {
      void poll();
      timer = setInterval(() => void poll(), EVERY_MS);
    } else {
      setNow(last);
    }
    return () => {
      listeners.delete(setNow);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return now;
}

export { isWorking } from './actors';
