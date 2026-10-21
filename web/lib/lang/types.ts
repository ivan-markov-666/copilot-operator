import type { en } from './en';

/** A key of the dictionary: every language has the same ones as `en.ts`. */
export type Key = keyof typeof en;

/** A whole language: a text for every key. */
export type Dictionary = Record<Key, string>;
