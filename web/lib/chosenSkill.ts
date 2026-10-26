'use client';

/**
 * The skill chosen for what is written next (operator, 2026-10-26): one choice shown in two places — under the chat's
 * box, and beside Kerrigan's button, whose text then carries it — so choosing it in either changes the other. Kept for
 * the page only, as the chat's choice always was: a reload starts without, and a message sent with it lets it go.
 */
import { useSyncExternalStore } from 'react';

let chosen = '';
const listeners = new Set<() => void>();

export function setChosenSkill(name: string): void {
  if (name === chosen) return;
  chosen = name;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The skill chosen, '' for none, and how to choose another. */
export function useChosenSkill(): [string, (name: string) => void] {
  return [useSyncExternalStore(subscribe, () => chosen, () => ''), setChosenSkill];
}
