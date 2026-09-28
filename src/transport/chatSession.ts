/**
 * Identifying the bot's chat across sessions.
 *
 * The bot must be able to find its own conversation again after the session expires and the
 * user signs in a second time. Two handles are kept, because they fail differently:
 *
 *   conversation id   `/chat/conversation/<uuid>`. Exact, survives renames, and lets the
 *                     bot navigate straight back. This is the primary handle.
 *   chat name         Set by the bot right after the first message. Used when the id is
 *                     missing or no longer opens, and it is what makes the run findable by
 *                     a human scrolling the sidebar.
 *
 * The id alone is not enough: a person looking at a list of chats called "You are Operator,
 * a Windows systems engineer worki" cannot tell which run is which. The name alone is not
 * enough either, because names are not unique and the sidebar truncates.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The UI rejects anything longer. Verified live: "Your Copilot chat name can't be longer than 50 characters". */
export const MAX_CHAT_NAME = 50;

export const CHAT_URL_RE = /\/chat\/conversation\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export type ChatPointer = {
  /** Conversation uuid from the URL. */
  chatId: string;
  /** Absolute URL to reopen the conversation. */
  url: string;
  /** The name the bot gave the chat. */
  name: string;
  runId: string;
  createdAt: string;
};

/**
 * The short code a session's chats are named with: the random tail of its id
 * (`20260928-073140-ujdt` gives `ujdt`), which the session page's address shows too.
 *
 * It replaced the date and time (`20260928-073140`), which took 15 of the 50 characters Copilot
 * allows and left the session's own name 31; with the code it keeps 42 (asked for 2026-09-28).
 * An id without such a tail gives its last six letters and digits.
 */
export function chatCode(sessionId: string): string {
  const tail = /-([a-z0-9]{3,8})$/i.exec(sessionId)?.[1];
  return (tail ?? sessionId.replace(/[^a-z0-9]/gi, '').slice(-6)).toLowerCase();
}

/**
 * Builds the chat name. Shape:
 *
 *   op/<code>/<label>
 *
 * The `op/` prefix makes every bot chat greppable in the sidebar and separates them from
 * the user's own chats. The code ties the chat to its session (see `chatCode`). The label is
 * the session's name.
 *
 * The whole thing is squeezed into 50 characters: the prefix and the code are kept intact
 * because they are what makes the chat findable, and the label absorbs the truncation.
 */
export function buildChatName(runId: string, label: string): string {
  const prefix = `op/${runId}/`;
  if (prefix.length >= MAX_CHAT_NAME) {
    // Pathological run id. Keep the tail, which is the part that varies.
    return `op/${runId}`.slice(0, MAX_CHAT_NAME);
  }
  const room = MAX_CHAT_NAME - prefix.length;
  // Unicode-aware on purpose: `\w` is ASCII-only in JavaScript, so a Cyrillic label would
  // be stripped down to a row of dashes.
  const clean = label
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, room);
  return (prefix + clean).replace(/\/$/, '').slice(0, MAX_CHAT_NAME);
}

/** Compact run id, e.g. `20260917-1912`. Stable, sortable, short enough to fit the name. */
export function makeRunId(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}`
  );
}

export function parseChatId(url: string): string | null {
  return CHAT_URL_RE.exec(url)?.[1] ?? null;
}

export async function savePointer(path: string, pointer: ChatPointer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(pointer, null, 2), 'utf8');
}

export async function loadPointer(path: string): Promise<ChatPointer | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const p = JSON.parse(raw) as ChatPointer;
    return p.chatId && p.url ? p : null;
  } catch {
    return null;
  }
}

/**
 * How the orchestrator reattaches after a lost session, in order. Each step is cheap and
 * the next one only runs when the previous fails.
 *
 * 1. Navigate to `pointer.url`. Success means the composer is visible and the sidebar entry
 *    for `pointer.chatId` is marked current. This is the normal path.
 * 2. If that 404s or redirects to a new chat, look for a sidebar link whose `aria-label`
 *    equals `pointer.name` exactly, and click it.
 * 3. If that fails, search chats (`/chat/all`) for the name.
 * 4. If nothing matches, do not silently start a new chat. A fresh chat has none of the
 *    persona or the format contract, so the run would misbehave in a way that is hard to
 *    spot. Fail with a message naming the chat that could not be found, and let the human
 *    decide between resuming manually and starting over.
 */
export type ReattachOutcome = 'by-url' | 'by-name-sidebar' | 'by-name-search' | 'not-found';
