'use client';

/**
 * The branch the open folder's branch is compared with (2026-10-22): chosen in the Git view's "On this branch", kept
 * in this browser for the folder. One choice for the view and for the number on the Git button (2026-10-27), so
 * choosing another in the view changes the button's number at once. '' is the one a pull request would go into.
 */
import { useSyncExternalStore } from 'react';

const kept = new Map<string, string>();
const listeners = new Set<() => void>();
const keyOf = (dir: string): string => `cop.git.base:${dir}`;

function baseOf(dir: string): string {
  const known = kept.get(dir);
  if (known !== undefined) return known;
  let saved = '';
  try {
    saved = window.localStorage.getItem(keyOf(dir)) ?? '';
  } catch {
    /* nothing kept in this browser */
  }
  kept.set(dir, saved);
  return saved;
}

function setBase(dir: string, base: string): void {
  kept.set(dir, base);
  try {
    window.localStorage.setItem(keyOf(dir), base);
  } catch {
    /* kept for this visit only */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The base chosen for the folder `dir`, '' for the default, and how to choose another. */
export function useGitBase(dir: string): [string, (base: string) => void] {
  const base = useSyncExternalStore(subscribe, () => baseOf(dir), () => '');
  return [base, (b: string) => setBase(dir, b)];
}
