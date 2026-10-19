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
  /** False when the rename in Copilot's sidebar did not happen: the chat keeps Copilot's own title. */
  named?: boolean;
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

/** Cyrillic letters in Latin ones: the Bulgarian streamlined system, with the Russian and Ukrainian letters it lacks. */
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y',
  ю: 'yu', я: 'ya', ё: 'yo', ы: 'y', э: 'e', є: 'ye', і: 'i', ї: 'yi', ґ: 'g',
};

/** A text in Latin letters: Cyrillic transliterated, accents taken off; what is left of other scripts is kept. */
export function latin(text: string): string {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const mapped = CYRILLIC[lower];
    if (mapped === undefined) out += ch;
    else out += ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
  }
  return out.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
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
  /*
   * In Latin letters, Cyrillic transliterated ("Създай калкулатор" gives "Sazday-kalkulator"). Copilot's rename dialog
   * refused a Bulgarian name of 50 letters, and then the same cut to 50 bytes, and took only a short Latin one: two
   * refusals before every first message of a new chat (operator, 2026-10-19: "why two attempts — should it not be
   * one?"). An ASCII name is the same length by any count, so the first name offered is the one it takes; the shorter
   * forms of `chatNameForms` stay for a refusal nobody expects.
   */
  const clean = latin(label)
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, room);
  return (prefix + clean).replace(/\/$/, '').slice(0, MAX_CHAT_NAME);
}

/**
 * The forms of a chat name to offer Copilot's rename dialog, longest first, each shorter than the one before.
 *
 * The dialog refuses a name it counts as longer than 50 characters, and its count is not always this file's: the
 * operator saw the bot try to save a longer one (2026-09-30, again 2026-10-17), while every name made here is 50
 * UTF-16 units at most. A counter of UTF-8 bytes takes a Cyrillic letter as two, so a Bulgarian session's name of 50
 * letters is a hundred to it. Rather than guess which count the page keeps, the dialog is offered these in turn and
 * the first it takes is the chat's name (see `nameChat`): 50 letters, cut whole (a letter outside the BMP is not
 * split in two); 50 bytes of UTF-8; the same in ASCII alone; the prefix and the session code alone, `op/<code>`,
 * which is what makes the chat findable and which every count agrees is short.
 */
export function chatNameForms(name: string): string[] {
  const forms: string[] = [];
  const add = (form: string): void => {
    const tidy = form.replace(/[-._/]+$/, '');
    if (tidy && !forms.includes(tidy)) forms.push(tidy);
  };
  const letters = (s: string, n: number): string => Array.from(s).slice(0, n).join('');
  const bytes = (s: string, n: number): string => {
    let out = '';
    for (const ch of s) {
      if (Buffer.byteLength(out + ch, 'utf8') > n) break;
      out += ch;
    }
    return out;
  };
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/-{2,}/g, '-').replace(/\/-+/g, '/');
  add(letters(name, MAX_CHAT_NAME));
  add(bytes(name, MAX_CHAT_NAME));
  add(bytes(ascii, MAX_CHAT_NAME));
  const code = /^op\/[a-z0-9]+(?:\/a\d+)?/i.exec(name)?.[0];
  if (code) add(code);
  return forms;
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
