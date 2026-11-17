/**
 * The chat's locators that found nothing where the bot needed them (operator, 2026-11-17: "a mechanism that detects
 * which locator exactly the bot failed on, so we can easily see which locator has to be updated"), the last time for
 * each. Kept in the data folder, so a failure seen before a restart is still shown; read by the banner on every page
 * and by Settings, where the locator's field is in red, until the locator is changed there or the operator closes it.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { CHAT_LOCATOR_KEYS, type ChatLocatorKey } from '../transport/locators.js';

export type LocatorFailure = {
  key: ChatLocatorKey;
  /** The locator that found nothing, as it was in force then. */
  locator: string;
  /** When. */
  at: string;
  /** What the bot was doing, in a sentence. */
  why: string;
  /** Whether the work stopped on it (the box, Send, the answer) or went on without it (a conversation's name). */
  stopped: boolean;
  /** The page's HTML for a chatbot (see `transport/pageHtml.ts`), and a picture of the page: files in the failures folder. */
  html?: string;
  picture?: string;
  /** Where the page was, without its query. */
  url?: string;
};

const isKey = (k: unknown): k is ChatLocatorKey => typeof k === 'string' && (CHAT_LOCATOR_KEYS as readonly string[]).includes(k);

export class LocatorFailures {
  /** One write at a time: two failures in the same second are both kept. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async list(): Promise<LocatorFailure[]> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter((f): f is LocatorFailure => !!f && typeof f === 'object' && isKey((f as LocatorFailure).key) && typeof (f as LocatorFailure).locator === 'string' && typeof (f as LocatorFailure).at === 'string');
    } catch {
      return [];
    }
  }

  async get(key: string): Promise<LocatorFailure | null> {
    return (await this.list()).find((f) => f.key === key) ?? null;
  }

  /** Kept as the one for its locator: the newest replaces the one before. */
  async record(failure: LocatorFailure): Promise<void> {
    await this.change((all) => [failure, ...all.filter((f) => f.key !== failure.key)]);
  }

  /** Closed by the operator. True when there was one. */
  async dismiss(key: string): Promise<boolean> {
    let had = false;
    await this.change((all) => {
      had = all.some((f) => f.key === key);
      return all.filter((f) => f.key !== key);
    });
    return had;
  }

  private async change(edit: (all: LocatorFailure[]) => LocatorFailure[]): Promise<void> {
    const run = async () => {
      const next = edit(await this.list());
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
      await rename(tmp, this.file);
    };
    const done = this.queue.then(run, run);
    this.queue = done.catch(() => undefined);
    await done;
  }
}
