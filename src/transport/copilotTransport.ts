/**
 * Drives the Microsoft 365 Copilot web app through Playwright.
 *
 * Every DOM fact this file relies on was captured from the live, signed-in app and is
 * recorded in `docs/locators-findings.md`. The three that shape the code:
 *
 *   1. Code blocks are virtualized and interleave line numbers with the code, and have been
 *      observed dropping a chunk of a valid JSON reply. Replies are therefore read by
 *      clicking "Copy Response" and reading the clipboard, never by scraping the DOM.
 *   2. Enter does not submit the composer. The Send button has to be clicked.
 *   3. A message cannot consist of an attachment alone; Send stays disabled without text.
 */
import { buttonShows, normModel, pageModelFor, sameModel } from './modelMatch.js';
import { chromium, type BrowserContext, type ElementHandle, type Page, type Locator } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findRecentCrash, describeCrash, type EdgeCrash } from './edgeCrash.js';
import { landed } from './acceptance.js';
import {
  Blocker,
  CHAT_ID,
  CHAT_LOCATOR_KEYS,
  ChatLocatorGroupOf,
  ChatLocatorNear,
  ChatLocatorWhat,
  Css,
  DefaultChatLocators,
  fillFileLocator,
  fillLocator,
  Label,
  Model,
  NearPlaces,
  ModelPicking,
  pageQuery,
  playwrightSelector,
  Rename,
  resolveChatLocators,
  resolvePickerLocators,
  Sidebar,
  Signal,
  StepNear,
  Surface,
  TestId,
  Url,
  type ChatLocatorKey,
  type ChatLocators,
  PickerLocatorNear,
  pickerFailureKey,
  type NearPlace,
  type PickerLocatorKey,
  type PickerLocators,
} from './locators.js';
import { acquireProfileLock, type LockHandle } from './profileLock.js';
import { chatNameForms, parseChatId } from './chatSession.js';
import { strippedPageHtml } from './pageHtml.js';
import { DefaultBuiltInSteps, stepKey, usableSteps, type BuiltInSteps, type ChatStep, type StepWhen } from './chatSteps.js';

/**
 * The chat did not finish a reply within `copilot.replyTimeoutSec`.
 *
 * Its own class because it is a limit from the settings, not a fault: the runner ends the task
 * `limit-reached` on it, so "Continue" carries the task on in the same chat, where the reply may
 * well have finished by then. Any other error from the transport still fails the task.
 */
export class ReplyTimeoutError extends Error {
  constructor(
    readonly seconds: number,
    message: string,
  ) {
    super(message);
    this.name = 'ReplyTimeoutError';
  }
}

/** Recognised by name as well: a copy of this module loaded twice makes `instanceof` miss its own class. */
export function isReplyTimeout(e: unknown): e is ReplyTimeoutError {
  return e instanceof ReplyTimeoutError || (e instanceof Error && e.name === 'ReplyTimeoutError' && typeof (e as ReplyTimeoutError).seconds === 'number');
}

export type TransportOptions = {
  profileDir: string;
  transportDir: string;
  chatUrl: string;
  channel: 'msedge' | 'chrome' | 'chromium';
  headless: boolean;
  replyTimeoutMs: number;
  signInTimeoutMs: number;
  /** How long to wait for a human to clear a verification challenge. */
  humanWaitMs?: number;
  /** Called with human-readable progress, so the CLI can show what is happening. */
  onEvent?: (event: string, detail?: Record<string, unknown>) => void;
  /** For checks only: shorter pauses, waits and fewer attempts when choosing a model than `ModelPicking`. */
  modelSettleMs?: number;
  modelBeforePressMs?: number;
  modelPollMs?: number;
  /**
   * A numbered picture and the menu's HTML at each step of choosing a model: the diagnosis command sets it, and
   * Settings' `copilot.pickerSteps` (2026-10-24).
   */
  modelStepShots?: boolean;
  /** The model menu's locators saved in Settings (`copilot.pickerLocators`); each one left out is the default. */
  pickerLocators?: Partial<Record<PickerLocatorKey, string>>;
  /** The chat page's locators saved in Settings (`copilot.chatLocators`, 2026-11-17): the box to write in; left out, the default. */
  chatLocators?: Partial<Record<ChatLocatorKey, string>>;
  /** The bot's own steps that can be switched off, and the operator's own steps on the way to the chat (2026-11-17, `chatSteps.ts`). */
  builtInSteps?: Partial<BuiltInSteps>;
  extraSteps?: ChatStep[];
  modelAppearMs?: number;
  modelAttempts?: number;
  /** Whether a failure dump keeps the page's HTML as well as a screenshot. See `copilot.keepFailurePage`. */
  keepFailurePage?: boolean;
};

export type ReplyCapture = {
  /** Raw markdown of the answer, from the clipboard. */
  markdown: string;
  /** True when the clipboard was unavailable and the DOM text was used instead. */
  degraded: boolean;
  /** File names Copilot attached to this answer. */
  attachments: string[];
  /**
   * What each code block looks like in the DOM, gutter numbers and all.
   *
   * Kept purely so the clipboard text can be compared against what is on screen. A live run
   * produced a PowerShell command where `[math]::Round` arrived as `:Round`, and without
   * both copies of the same answer there is no way to tell whether Copilot wrote it that
   * way or something between Copilot and the parser dropped it.
   */
  codeBlocksDom: string[];
};

/**
 * Which Copilot an address is, by its host — not by whether the text appears anywhere in it: the
 * consumer Copilot and a sign-in page carry the work chat's address in their query (`ru=`,
 * `redirect_uri=`), and a check of the whole URL took them for each other. `work` here only says the
 * host is the work Copilot's; `surface()` also looks for its composer.
 */
export function surfaceOfUrl(url: string): 'work' | 'consumer' | 'sign-in' | 'unknown' {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  const on = (h: string): boolean => host === h || host.endsWith(`.${h}`);
  if (on(Signal.loginHost)) return 'sign-in';
  if (Surface.consumerHosts.some(on)) return 'consumer';
  if (Surface.workHosts.some(on)) return 'work';
  return 'unknown';
}

/** Whether an address is the work Copilot's chat — a new chat, a conversation, the list of chats — on either of its hosts. */
export function isWorkChatAddress(url: string): boolean {
  if (surfaceOfUrl(url) !== 'work') return false;
  const path = new URL(url).pathname.replace(/\/+$/, '');
  return path === '/chat' || path.startsWith('/chat/');
}

/**
 * Whether an address is another page of the work Copilot, not its chat: its home page
 * (`copilot.cloud.microsoft/home?es=SSR&redirfrom=mcmToCcm`, where the work machine's start ended on 2026-11-17), or any
 * other of its own. Signed in, then — a sign-in page is on Microsoft's sign-in host — and only away from the chat.
 */
export function isCopilotOtherPage(url: string): boolean {
  return surfaceOfUrl(url) === 'work' && !isWorkChatAddress(url);
}

/**
 * One entry of the model picker, exactly as the chat offered it.
 *
 * `name` is what is clicked and what is stored on a session; `raw` is the option's whole text,
 * which is where the description and any quota notice live. Nothing is normalised, because the
 * list belongs to Microsoft and differs per tenant and per day.
 */
/**
 * What choosing a model came to. `matched`: the name was no longer offered and this one, the same model under
 * its new name, was chosen instead (see `modelMatch.ts`). `options`: the line-up read from the page on the way.
 */
export type ModelChoice = {
  ok: boolean;
  current: string | null;
  reason?: string;
  matched?: string;
  options?: ModelOption[];
  /** How it was found: at the saved locator, at a fresh one after the saved one missed, or by name with no saved one. */
  by?: 'already' | 'operator' | 'locator' | 'reread' | 'name' | 'hand';
  /** When the saved locator missed and a fresh reading found the model: why it missed. */
  locatorMiss?: string;
};

/**
 * Where a model sits in the picker: read with the list (`listModels`) and kept with it, so a run goes
 * straight to the row the operator chose from (`selectModel`). The group is held by its test id, which
 * is stable, then by its place; the row by its place in its menu, with its name as the check.
 */
export type ModelLocator = {
  role: string;
  index: number;
  /** `vendor`: the second line of the group's row ("OpenAI"), which stays when a choice renames the first. */
  group?: { testId?: string; index: number; name: string; vendor?: string };
};

export type ModelOption = {
  name: string;
  raw: string;
  selected: boolean;
  disabled: boolean;
  /** The ARIA role the option carried, kept because it is the first thing to check if this breaks. */
  role: string;
  /** The submenu this option lives in, when it is not on the top level. Live example: `GPT`. */
  group?: string;
  /** The group row's whole text, which carries the vendor: `GPT\nOpenAI`. */
  groupRaw?: string;
  /** Where it sits in the picker, to choose it again; see `ModelLocator`. */
  locator?: ModelLocator;
};

/** One row of the open menu, before it is decided whether it is a choice or a group. */
type MenuRow = {
  name: string;
  raw: string;
  selected: boolean;
  disabled: boolean;
  role: string;
  /** True when the row opens a submenu rather than choosing a model. */
  opensSubmenu: boolean;
  /** Its place among the rows of its own menu. */
  index: number;
  /** The `aria-labelledby` of its menu: a submenu is labelled by the id of the row that opens it. */
  menuOf: string;
  /** `data-test-id` (or `data-testid`), which the group rows carry: `gptSubMenuModelTrigger-OpenAI`. */
  testId: string;
  /** The element's id, which the group rows carry; it changes from page to page. */
  elId: string;
};

/**
 * A group's name for the list. Its row reads the group ("GPT") until a model in it is chosen, and then
 * that model's name; then the name comes from its test id (`gptSubMenuModelTrigger-OpenAI` → "GPT").
 */
/**
 * The operator's locators for one model: its own, and its provider's when it is in one; each with what it is, for
 * the record of what was tried.
 */
type OperatorTarget = {
  model: string;
  locator: string;
  kind: 'model' | 'providerModel';
  group?: { name: string; locator: string; at: NonNullable<ModelLocator['group']> };
};

/**
 * The operator's locators for a model, from the templates in force and where the list read from the page found it
 * (operator, 2026-10-24): a model of the main menu by the template for those; one in a provider's menu by the
 * provider's template, with the provider's name as the list read it, and then the template for a model there. Null
 * when the model's place is not known: the list is read first (see `chooseModel`).
 */
export function templateTarget(name: string, place: ModelLocator | undefined, locators: PickerLocators): OperatorTarget | null {
  if (!place) return null;
  if (!place.group) return { model: name, locator: fillLocator(locators.model, { model: name }), kind: 'model' };
  const provider = place.group.name;
  return {
    model: name,
    locator: fillLocator(locators.providerModel, { model: name, provider }),
    kind: 'providerModel',
    group: { name: provider, locator: fillLocator(locators.provider, { provider }), at: place.group },
  };
}

/** The second line of a group's row: its vendor ("OpenAI", "Anthropic"). */
function vendorOf(row: { raw: string }): string {
  return row.raw.split('\n')[1]?.trim() ?? '';
}

/** Whether a row's text holds the model's name as whole words, however the page spells it. */
function containsModel(text: string, name: string): boolean {
  const t = ` ${normModel(text)} `;
  const n = normModel(name);
  return n.length > 0 && t.includes(` ${n} `);
}

function groupLabel(group: MenuRow, children: MenuRow[]): string {
  if (!children.some((c) => sameModel(c.name, group.name))) return group.name;
  /*
   * The work machine's ids (2026-10-07) are "gptSubMenuModelTrigger-Claude" and "gptSubMenuModelTrigger-OpenAI":
   * the start is "gpt" for every group, the end names the group — unless the end is the vendor, as for GPT.
   */
  const suffix = /-([A-Za-z0-9]+)$/.exec(group.testId)?.[1];
  if (suffix && !/^(openai|anthropic|microsoft|google|meta|mistral|xai)$/i.test(suffix)) return suffix;
  const fromId = /^([a-z0-9]+?)SubMenu/i.exec(group.testId)?.[1];
  // "gpt" reads GPT, "claude" reads Claude: short ids are acronyms.
  if (fromId) return fromId.length <= 3 ? fromId.toUpperCase() : fromId.charAt(0).toUpperCase() + fromId.slice(1);
  return vendorOf(group) || 'Models';
}

/**
 * What the blocker detector saw, and why it thinks so.
 *
 * The reason is carried rather than thrown away because a detector that can only say "yes"
 * is impossible to debug. The first live failure was logged as "verification" with no
 * evidence of what matched, which left a guess where a fact was needed.
 */
export type BlockerFinding = {
  kind: 'verification' | 'error-banner' | 'none';
  reason: string;
};

/**
 * The chat refused the message: it never became a turn, so no reply is coming.
 *
 * Distinct from a timeout on purpose. A timeout means "it is taking too long"; this means
 * "it will never arrive", and the caller can retry the send instead of waiting.
 */
export class SendRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendRejectedError';
  }
}

/**
 * The run was stopped while the transport was in one of its long waits: the model picker's looks and pauses, or
 * the sign-in. Thrown by `hold` and the sign-in wait, so a Stop is not left waiting minutes for them to end.
 */
export class StoppedByOperator extends Error {
  constructor(message = 'stopped by the operator') {
    super(message);
    this.name = 'StoppedByOperator';
  }
}

/**
 * The operator closed the window with its X (2026-10-19) before the run had it: while it opened, while the sign-in
 * was awaited, while the conversation was entered. A stop, said as one, rather than the error every call on a
 * closed page gives.
 */
export class WindowClosed extends Error {
  constructor(message = 'the browser window was closed') {
    super(message);
    this.name = 'WindowClosed';
  }
}

/** Said when a window closed under the work cannot be put back on its conversation: it had no address yet. */
export const NO_ADDRESS_YET =
  'the browser window was closed before its conversation had an address, so it could not be found again; nothing more was sent';

/** How many times Edge is started again on the profile when a window is reopened, and the pause between (see `reopen`). */
const REOPEN_TRIES = 10;
const REOPEN_PAUSE_MS = 1_500;
/** How long the box is waited for on the work Copilot's host before the page is said not to be its chat. */
const SURFACE_WAIT_MS = 5_000;

/** Where a window sent to the chat ended up (see `arrive`). */
type Arrival = 'chat' | 'elsewhere' | 'no-box';

/**
 * The window had left the conversation the bot put it on, and could not be put back (operator, 2026-11-09; see
 * `ensureOnChat`): the conversation does not open again, or the sign-in the page asked for first was not done in time.
 * Nothing was sent: not to it, and not to the page the window was on instead, another conversation or a new one on
 * Copilot's home page. Nothing that sends again gets past it either, so a caller's retries do not try (see `runTask`).
 */
export class ChatLost extends Error {
  constructor(
    readonly chatId: string,
    /** Where the window was: its address without the query. */
    readonly found: string,
    message?: string,
  ) {
    super(
      message ??
        `Copilot's window was no longer on this conversation (${chatId}): it showed ${found}. The conversation could not be ` +
          'opened again, by its address or by its name in the sidebar, so nothing was sent, and nothing went into another chat. ' +
          "Look in Copilot's sidebar in the Edge window to see whether the conversation is still there.",
    );
    this.name = 'ChatLost';
  }
}

/** Where `ensureOnChat` found the window: on its conversation, put back on it, or with no conversation expected of it. */
export type OnChat =
  | { at: 'here' | 'unknown' }
  | { at: 'returned'; chatId: string; from: string; by: 'address' | 'name'; signedIn: boolean };

/** An address without its query and fragment, which may carry an account's name: what a record says of where a page was. */
export function whereIs(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'about:' ? url : `${u.origin}${u.pathname}`;
  } catch {
    return url.replace(/[?#].*$/, '').slice(0, 200);
  }
}

/**
 * A card drawn over the chat's page (see `showNotice`): a heading, the message it is about, a few lines, one button.
 * `tone` picks the mark beside the heading: a tick, a stop, or a warning.
 */
export type WindowNotice = { tone: 'done' | 'stopped' | 'failed'; title: string; subject?: string; lines: string[]; button: string; /** Right to left (Arabic). */ dir?: 'rtl' };

/** The id of the notice's element in the chat's page, so the next one, and `clearNotice`, find it. */
const NOTICE_ID = 'copilot-operator-notice';

/**
 * Takes the copy button off the operator's clipboard.
 *
 * Reading a reply means clicking Copilot's "Copy Response" and taking the raw markdown, which
 * is the only lossless way to get it: the rendered DOM mangles code fences. The obvious
 * implementation — click, then read the clipboard — quietly makes the machine unusable while a
 * run is going. Every reply overwrites whatever the person had copied, so their next paste is a
 * page of somebody else's markdown; and in the gap between the click and the read, anything
 * *they* copy is what the runner picks up and parses as Copilot's answer. Both have happened.
 *
 * So the clipboard is removed from the path entirely. This script replaces the page's own way
 * of copying with one that hands the text to a variable on `window` and never calls through, so
 * pressing copy in this browser writes nothing anywhere on the machine. The runner then reads
 * the variable. Nothing is written to the system clipboard and nothing is read from it, which
 * means the person can copy and paste all day while a run is in progress and neither can reach
 * the other.
 *
 * Both routes a web page has are covered: the modern `navigator.clipboard` calls and the older
 * hidden-textarea-plus-`execCommand('copy')` trick. The counter is what makes a stale read
 * impossible — the runner notes it before the click and waits for it to move, so a copy that
 * did not happen reads as a failure rather than as the previous answer.
 */
export const CLIPBOARD_GUARD = `(() => {
  const state = { text: '', seq: 0 };
  try {
    Object.defineProperty(window, '__copClipboard', { value: state, enumerable: false });
  } catch (e) {
    window.__copClipboard = state;
  }

  const remember = (text) => {
    if (typeof text !== 'string' || text.length === 0) return;
    state.text = text;
    state.seq += 1;
  };

  const clip = navigator.clipboard;
  if (clip) {
    try {
      Object.defineProperty(clip, 'writeText', {
        configurable: true,
        writable: true,
        value: (text) => {
          remember(String(text));
          return Promise.resolve();
        },
      });
    } catch (e) { /* a frame that will not let its clipboard be replaced reads as a failure later */ }

    try {
      Object.defineProperty(clip, 'write', {
        configurable: true,
        writable: true,
        value: async (items) => {
          for (const item of items || []) {
            try {
              if (item && item.types && item.types.indexOf('text/plain') >= 0) {
                remember(await (await item.getType('text/plain')).text());
              }
            } catch (e) { /* one unreadable item is not a reason to drop the rest */ }
          }
        },
      });
    } catch (e) { /* as above */ }
  }

  // The old way: select text in a hidden field, then execCommand('copy'). The selection is
  // exactly the text being copied, so it is taken and the command is never run.
  try {
    const realExec = document.execCommand.bind(document);
    document.execCommand = (command, ...rest) => {
      if (String(command).toLowerCase() === 'copy') {
        const selected = String(window.getSelection() || '');
        if (selected.length > 0) {
          remember(selected);
          return true;
        }
      }
      return realExec(command, ...rest);
    };
  } catch (e) { /* as above */ }
})();`;

/**
 * What `CLIPBOARD_GUARD` leaves on the page for this process to read.
 *
 * Declared so the two page-side functions below can be written as ordinary code rather than as
 * casts: they run in the browser, but they are type-checked here like everything else.
 */
declare global {
  interface Window {
    __copClipboard?: { text: string; seq: number };
  }
}

/**
 * A locator of the chat that found nothing where the bot needed it (operator, 2026-11-17: "a mechanism that detects
 * which locator exactly the bot failed on, so we can easily see which locator has to be updated"): which one, as it
 * was in force, and the page's HTML and picture kept for finding the right one. The runner says it like any other
 * error; the transport has said it already (`locator-missing`), which the API keeps for Settings (`LocatorFailures`).
 */
export class LocatorMissing extends Error {
  constructor(
    /** A chat locator's key, or `step:<id>` for one of the operator's own steps (see `chatSteps.ts`). */
    readonly key: ChatLocatorKey | `step:${string}`,
    readonly locator: string,
    message: string,
    readonly html?: string,
    readonly picture?: string,
  ) {
    super(message);
    this.name = 'LocatorMissing';
  }
}

/**
 * What "Check the locators" found for one of the chat's locators (2026-11-17): something (`found`, how many), nothing
 * (`none`: its field goes red), or not looked for because what it finds was not on the page then (`not-here`): Stop
 * shows only while Copilot writes (`writing`), the rename dialog is not opened (`dialog`), no conversation to look in
 * (`noConversation`), no "More" button to open its menu with (`noMenu`). `byName`: the default "More" locator found
 * nothing and the button was found by its name in the conversation's row, as the bot finds it then.
 */
export type LocatorCheck = {
  /** A chat locator's key, or `step:<id>` for one of the operator's own steps. */
  key: ChatLocatorKey | `step:${string}`;
  status: 'found' | 'none' | 'not-here';
  count: number;
  note?: 'writing' | 'dialog' | 'noConversation' | 'noMenu' | 'byName' | 'noChat' | 'attach' | 'optional' | 'gone';
};

export class CopilotTransport {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lock: LockHandle | null = null;
  /**
   * The run's Stop, while a choice of model is being made (see `selectModel`). The picker's waits add up to minutes
   * — six attempts, each looking up to twenty seconds for each of its rows, in four ways — and a Stop pressed in them
   * did nothing until they ended (2026-10-17: "the Stop button seems not to work").
   */
  private stop: AbortSignal | null = null;
  /** Set while `close` closes the window, so a window this code closed is not taken for one the operator closed. */
  private closing = false;
  /** The window went away without `close`: its X pressed, or Edge ended (2026-10-19). */
  private gone = false;
  /** The model menu's locators in force: Settings' own, else the defaults (see `resolvePickerLocators`). */
  private locators: PickerLocators;
  /** The chat page's locators in force — the box to write in: Settings' own, else the default (see `resolveChatLocators`). */
  private chatLocators: ChatLocators;
  /** The bot's own steps as Settings switch them, the operator's own steps taken, and why one saved is not (2026-11-17). */
  private builtIn: BuiltInSteps;
  private steps: ChatStep[];
  private stepProblems: string[];
  /** A picture at each step of choosing a model (Settings' `pickerSteps`). */
  private stepShots: boolean;
  /** Said once a window: the conversation is not named (its step switched off); a step passed over that is not required. */
  private nameOffSaid = false;
  /** Why a chat locator saved in Settings is not used; said once, when the chat is first opened. */
  private chatLocatorProblems: string[];
  /** Why a locator saved in Settings is not used; said once, at the first choice or reading of the models. */
  private locatorProblems: string[];
  /** Whether the rows' locator has been said not to work in the page (see `readMenuRows`). */
  private rowsLocatorFailed = false;
  /**
   * The conversation the bot itself put this window on (operator, 2026-11-09: a task paused, or waiting on a card, for
   * some days went on in a new chat on Auto — the page had left its conversation meanwhile, and the next message went
   * wherever the page was). `{ id }` once the conversation has an address; `'new'` for a new one not yet answered, which
   * gets its address with its first answer (`waitForReply`); null where none is expected, as on Copilot's home page after
   * a sign-in, before a run enters its conversation. Set only by what moves the page on purpose — `newChat`,
   * `openConversation`, `openConversationByName`, `ensureSignedIn`, `gotoChatAs`, `signOut` — and read by `ensureOnChat`.
   */
  private onChat: { id: string } | 'new' | null = null;
  /** The name each conversation was given, or found by, in the sidebar: the way back to it when its address does not open it. */
  private readonly chatNames = new Map<string, string>();
  /** How long a page is given to show the composer before it is taken to be asking for a sign-in. */
  private firstLookMs = 15_000;
  /**
   * The host the chat was last found on, which the chat's addresses are opened on (2026-11-17): the address set in
   * Settings when it is the work Copilot's, else the old host, until the chat is found on the new one. Going through
   * the old host's redirect is what ended the work machine's start on Copilot's home page.
   */
  private chatOrigin: string;
  /** How long the box to write in must stay before the page is taken for the chat: one that showed on its way elsewhere is not. */
  private settleMs = 2_000;
  /** How long another page of the work Copilot is given to turn into its chat on its own before the bot opens the chat. */
  private otherPageMs = 3_000;
  /** How long the answer is waited for with not one message of the conversation found, before the `turn` locator is said. */
  private turnsGraceMs = 20_000;
  /** How long Copilot's newest answer may stand still, not written and not finished, before its locator is said. */
  private answerStillMs = 60_000;
  /** The locators said already in this window, where the work went on without them: said once. */
  private readonly warned = new Set<ChatLocatorKey>();
  /** The same for the model menu's (2026-11-24). */
  private readonly pickerWarned = new Set<PickerLocatorKey>();
  /** How long Send is waited for once the message is in the box. */
  private sendWaitMs = 20_000;
  /** How long a message sent is waited for in the conversation before it is taken as not accepted. */
  private acceptMs = 30_000;

  constructor(private readonly opts: TransportOptions) {
    const { locators, problems } = resolvePickerLocators(opts.pickerLocators);
    this.locators = locators;
    const chat = resolveChatLocators(opts.chatLocators);
    this.chatLocators = chat.locators;
    this.chatLocatorProblems = chat.problems;
    this.locatorProblems = problems;
    this.builtIn = { ...DefaultBuiltInSteps, ...(opts.builtInSteps ?? {}) };
    const own = usableSteps(opts.extraSteps);
    this.steps = own.steps;
    this.stepProblems = own.problems;
    this.stepShots = !!opts.modelStepShots;
    this.chatOrigin = surfaceOfUrl(opts.chatUrl) === 'work' ? new URL(opts.chatUrl).origin : Url.origin;
  }

  /**
   * Settings saved since this window opened (2026-11-17): the locators, the model menu's and the chat's, and the steps
   * on the way to the chat. The chat's window is kept open between messages, and a locator fixed in Settings went on
   * being looked for as it was until the window closed; each message's run hands the window what Settings say now, and
   * a save while a message is at work does the same. What cannot be used is said as when a window opens.
   */
  takeSettings(o: Pick<TransportOptions, 'pickerLocators' | 'chatLocators' | 'modelStepShots' | 'builtInSteps' | 'extraSteps'> & Partial<Pick<TransportOptions, 'replyTimeoutMs' | 'signInTimeoutMs' | 'humanWaitMs'>>): void {
    /*
     * The waits too (bug hunt 2026-11-18): the window kept open between messages went on, for days, with the reply,
     * sign-in and verification waits it was opened with, though Settings had changed them.
     */
    if (o.replyTimeoutMs !== undefined) this.opts.replyTimeoutMs = o.replyTimeoutMs;
    if (o.signInTimeoutMs !== undefined) this.opts.signInTimeoutMs = o.signInTimeoutMs;
    if (o.humanWaitMs !== undefined) this.opts.humanWaitMs = o.humanWaitMs;
    const picker = resolvePickerLocators(o.pickerLocators);
    this.locators = picker.locators;
    this.locatorProblems = picker.problems;
    const chat = resolveChatLocators(o.chatLocators);
    if (JSON.stringify(chat.locators) !== JSON.stringify(this.chatLocators)) this.warned.clear();
    this.chatLocators = chat.locators;
    this.chatLocatorProblems = chat.problems;
    this.builtIn = { ...DefaultBuiltInSteps, ...(o.builtInSteps ?? {}) };
    const own = usableSteps(o.extraSteps);
    this.steps = own.steps;
    this.stepProblems = own.problems;
    this.stepShots = !!o.modelStepShots;
    this.emit('settings-taken', { steps: this.steps.length, builtIn: this.builtIn });
  }

  /** Says, once, which locators saved in Settings could not be used and why. */
  private sayLocatorProblems(): void {
    for (const problem of this.locatorProblems) this.emit('model-locator-not-used', { problem });
    this.locatorProblems = [];
  }

  /** A pause of the model picker that ends early, with `StoppedByOperator`, once the run is stopped. */
  private async hold(ms: number): Promise<void> {
    const until = Date.now() + ms;
    for (;;) {
      if (this.stop?.aborted) throw new StoppedByOperator();
      const left = until - Date.now();
      if (left <= 0) return;
      await this.p.waitForTimeout(Math.min(250, left));
    }
  }

  private emit(event: string, detail?: Record<string, unknown>): void {
    this.opts.onEvent?.(event, detail);
  }

  private get p(): Page {
    if (!this.page) throw new Error('Transport is not open. Call open() first.');
    return this.page;
  }

  async open(): Promise<void> {
    // Fails loudly when another Edge holds the profile, instead of letting Playwright
    // report a closed browser with no explanation.
    this.lock = acquireProfileLock(this.opts.profileDir);
    await mkdir(this.opts.profileDir, { recursive: true });
    await mkdir(this.opts.transportDir, { recursive: true });

    this.context = await chromium.launchPersistentContext(this.opts.profileDir, {
      channel: this.opts.channel,
      headless: this.opts.headless,
      /*
       * No downloads, at the level of the browser itself. The runner takes a reply as text only —
       * the JSON of command steps, copied out of the answer — and has taken nothing else since file
       * steps were removed. Nothing in this code clicks a download link, but the window was still
       * opened willing to accept one, so a click from anywhere would have saved a file the bot had no
       * business having. Refused here, a download is cancelled by the browser before it is written.
       */
      acceptDownloads: false,
      /*
       * Edge keeps its own sandbox. Playwright starts Chromium with `--no-sandbox` unless told
       * otherwise, and a browser without its sandbox, started by node.exe with a debugging channel
       * open, is the shape endpoint tooling looks for when a program is after the cookies of a
       * signed-in session. The automation does not need the sandbox off.
       */
      chromiumSandbox: true,
      viewport: null,
      args: ['--start-maximized'],
    });

    // Replies are captured without the machine's clipboard ever being touched. See CLIPBOARD_GUARD.
    await this.context.addInitScript(CLIPBOARD_GUARD).catch(() => this.emit('clipboard-guard-failed'));

    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.page.setDefaultTimeout(60_000);
    this.watchWindow();
    this.emit('browser-opened', { profileDir: this.opts.profileDir });
  }

  /**
   * The operator may close the window with its X at any moment (2026-10-19), and the chat's window is left open
   * between messages for exactly that to be theirs to do. Noted when it happens, so a run in it stops as a run the
   * operator stopped, and the next message opens a new one, rather than either failing on a closed page.
   */
  private watchWindow(): void {
    const opened = this.context;
    if (!opened || !this.page) return;
    this.gone = false;
    const went = (): void => {
      // Not when `close` is closing it, and not for a window closed already and since let go of.
      if (this.closing || this.gone || this.context !== opened) return;
      this.gone = true;
      this.emit('window-closed');
    };
    opened.on('close', went);
    this.page.on('close', went);
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.context?.close().catch(() => undefined);
    } finally {
      this.closing = false;
    }
    this.context = null;
    this.page = null;
    this.lock?.release();
    this.lock = null;
  }

  /** Whether the window is there to be used: not before `open`, not after `close`, not once the operator closed it. */
  isOpen(): boolean {
    return !!this.context && !!this.page && !this.gone && !this.page.isClosed();
  }

  /** Whether the window went away without this code closing it: its X was pressed, or Edge ended. */
  closedOutside(): boolean {
    return this.gone;
  }

  /**
   * The window again, after it was closed under the work (operator, 2026-11-13: "if I close the browser with the chat by
   * accident, the bot should carry the task on from where it got to"). Edge is started again on the same profile, and
   * the window put back on the conversation it was on: by its address, after a sign-in when the page asks for one, or by
   * its name in the sidebar (see `ensureOnChat`). The Edge that was closed may still be on its way out and holding the
   * profile, so the start is tried again for a while. A conversation that had no address yet — closed before its first
   * answer — cannot be found again: `WindowClosed`, with the new window open on nothing. When and how often this is done
   * is the runner's (`KeptWindow` in keptWindow.ts); this only does it.
   */
  async reopen(opts: { signal?: AbortSignal } = {}): Promise<OnChat> {
    // What `close` leaves alone, kept: the conversation the window was on, and the names given to conversations.
    const want = this.onChat;
    await this.close();
    for (let tries = 1; ; tries += 1) {
      try {
        await this.open();
        break;
      } catch (e) {
        await this.close().catch(() => undefined);
        const busy = /already running with this profile|already in use by copilot-operator/i.test((e as Error).message);
        if (!busy || tries >= REOPEN_TRIES || opts.signal?.aborted) throw e;
        await new Promise((r) => setTimeout(r, REOPEN_PAUSE_MS));
      }
    }
    this.onChat = want;
    if (!want || want === 'new') throw new WindowClosed(NO_ADDRESS_YET);
    await this.p.goto(this.chatAddress(Url.conversationPath(want.id)), { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    // On it, as nearly always: waited for until its box is there to write in. Elsewhere (a sign-in): `ensureOnChat`.
    if (parseChatId(this.p.url()) === want.id) await this.composerWithin(this.firstLookMs, opts.signal, 'stopped by the operator while the window was opened again');
    return await this.ensureOnChat(opts);
  }

  /**
   * A card over the chat's page with one button that takes it away (2026-10-19: "when the chat is done, let the
   * browser show a message — the task has finished — and an OK under it"). The window of the workbench's chat is
   * left open for the next message, and without it a window the work has finished in looks just like one it is still
   * going on in. Drawn in a shadow root, so the page's styles do not reach it, and over everything; nothing of the
   * page itself is touched, and the next run takes it away before anything else (`clearNotice`).
   */
  async showNotice(notice: WindowNotice): Promise<void> {
    await this.p.evaluate(
      ([id, n]) => {
        document.getElementById(id)?.remove();
        const host = document.createElement('div');
        host.id = id;
        const root = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = [
          ':host{all:initial}',
          '.back{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.38);font-family:"Segoe UI",system-ui,sans-serif}',
          '.card{box-sizing:border-box;width:calc(100% - 48px);max-width:470px;background:#fff;color:#1f2937;border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.28);padding:24px 28px 20px}',
          'h2{display:flex;align-items:center;gap:12px;margin:0 0 14px;font-size:20px;font-weight:600;line-height:1.3}',
          '.mark{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;color:#fff;font-size:16px;font-weight:700}',
          '.done{background:#16a34a}.stopped{background:#64748b}.failed{background:#d97706}',
          'p{margin:0 0 8px;font-size:14px;line-height:1.5;overflow-wrap:anywhere}',
          'p.subject{font-weight:600}',
          '.row{display:flex;justify-content:flex-end;margin-top:18px}',
          'button{font:inherit;font-size:14px;font-weight:600;min-width:96px;padding:8px 24px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer}',
          'button:hover{background:#1d4ed8}button:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}',
          '@media (prefers-color-scheme:dark){.card{background:#1f2937;color:#f3f4f6}}',
        ].join('\n');
        const back = document.createElement('div');
        back.className = 'back';
        const card = document.createElement('div');
        card.className = 'card';
        card.setAttribute('role', 'alertdialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-labelledby', 'title');
        if (n.dir) card.setAttribute('dir', n.dir);
        const h = document.createElement('h2');
        h.id = 'title';
        const mark = document.createElement('span');
        mark.className = `mark ${n.tone}`;
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = n.tone === 'done' ? '✓' : n.tone === 'stopped' ? '■' : '!';
        h.append(mark, document.createTextNode(n.title));
        card.append(h);
        if (n.subject) {
          const s = document.createElement('p');
          s.className = 'subject';
          s.textContent = n.subject;
          card.append(s);
        }
        for (const line of n.lines) {
          const p = document.createElement('p');
          p.textContent = line;
          card.append(p);
        }
        const row = document.createElement('div');
        row.className = 'row';
        const ok = document.createElement('button');
        ok.type = 'button';
        ok.textContent = n.button;
        // No function given a name in here: run through tsx, a named one is wrapped in a helper the page has not got.
        ok.addEventListener('click', () => host.remove());
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') host.remove();
        });
        row.append(ok);
        card.append(row);
        back.append(card);
        root.append(style, back);
        document.documentElement.append(host);
        ok.focus();
      },
      [NOTICE_ID, notice] as const,
    );
    await this.p.bringToFront().catch(() => undefined);
  }

  /** Takes away a card `showNotice` left, if the operator has not pressed its button. Nothing when there is none. */
  async clearNotice(): Promise<void> {
    if (!this.isOpen()) return;
    await this.p.evaluate((id) => document.getElementById(id)?.remove(), NOTICE_ID).catch(() => undefined);
  }

  /** True when the composer is visible, i.e. we are signed in and the chat is usable. */
  async isChatReady(timeoutMs = 5_000): Promise<boolean> {
    try {
      await this.composer().waitFor({ state: 'visible', timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The box to write in, by the chat's locator in force (Settings' own, else the default; 2026-11-17). What it finds is
   * taken if it can be written in, else the first box inside it that can: a locator copied from the page's inspector for
   * an element around the box (the operator's of 2026-11-17 named the box's wrapper, `data-chat-input-pill`) finds it all
   * the same.
   */
  private composer(): Locator {
    return this.p
      .locator(this.sel('composer'))
      .first()
      .locator("xpath=descendant-or-self::*[(@contenteditable and @contenteditable != 'false') or self::textarea]")
      .first();
  }

  /** What the message says when the box is not found: its locator in force, and where Settings has it. */
  private composerHint(): string {
    return (
      `If the picture shows the chat with its box to write in, the box's locator does not find it: ${this.chatLocators.composer} ` +
      '(Settings → "The chat\'s locators" → "Box to write in").'
    );
  }

  /** A chat locator in force, as Playwright takes it; `chatId` goes where a template has its place. */
  private sel(key: ChatLocatorKey, chatId?: string): string {
    const s = this.chatLocators[key];
    return playwrightSelector(chatId === undefined ? s : s.split(CHAT_ID).join(chatId));
  }

  /** What a chat locator in force finds in the page. */
  private el(key: ChatLocatorKey, chatId?: string): Locator {
    return this.p.locator(this.sel(key, chatId));
  }

  /**
   * A locator that found nothing where the bot needed it (2026-11-17): a picture of the page and its HTML for a chatbot
   * to find the right one in (scripts, styles and the sidebar out — see `pageHtml.ts`), kept in the failures folder, and
   * said (`locator-missing`, which the API keeps so Settings can show the field in red). The error to throw when the
   * work cannot go on without it; `stopped: false` when it goes on (a conversation's name). `message` is given the
   * sentence naming the files.
   */
  private async locatorMissing(
    key: ChatLocatorKey,
    why: string,
    opts: { stopped?: boolean; chatId?: string; file?: string; message?: (files: string) => string } = {},
  ): Promise<LocatorMissing> {
    const stopped = opts.stopped ?? true;
    const locator = this.chatLocators[key];
    const { picture, html, url, piece, around } = await this.keepPage(`locator-${key}-${Date.now()}`, ChatLocatorGroupOf[key] === 'conversations', {
      near: ChatLocatorNear[key],
      ...(opts.chatId ? { chatId: opts.chatId } : {}),
      ...(opts.file ? { file: opts.file } : {}),
    });
    this.emit('locator-missing', { key, locator, why, stopped, ...(html ? { html } : {}), ...(picture ? { picture } : {}), ...(url ? { url } : {}), ...(piece ? { piece, around } : {}) });
    const files = [picture ? `A picture of the page: ${picture}.` : '', html ? `The page's HTML, for a chatbot to find the right locator in: ${html}.` : ''].filter(Boolean).join(' ');
    const message =
      opts.message?.(files) ??
      `Not found on Copilot's page: ${ChatLocatorWhat[key]}. The "${key}" locator found nothing ${why}. In force: ${locator} ` +
        `(Settings → "The chat's locators"). ${files}`.trim();
    return new LocatorMissing(key, locator, message, html, picture);
  }

  /**
   * One of the model menu's locators that found nothing (operator, 2026-11-24: the models could not be read at work, and
   * nothing was kept to say why): said and kept as the chat's are, with the page as it is now — the menu still open,
   * when there is one. The work goes on (the model is asked of the operator); said once a window for each.
   */
  private async pickerMissing(key: PickerLocatorKey, why: string): Promise<void> {
    if (this.pickerWarned.has(key) || !this.page || this.page.isClosed()) return;
    this.pickerWarned.add(key);
    const { picture, html, url, piece, around } = await this.keepPage(`locator-picker-${key}-${Date.now()}`, false, { near: PickerLocatorNear[key] });
    this.emit('locator-missing', { key: pickerFailureKey(key), locator: this.locators[key], why, stopped: false, ...(html ? { html } : {}), ...(picture ? { picture } : {}), ...(url ? { url } : {}), ...(piece ? { piece, around } : {}) });
  }

  /**
   * A picture of the page and its HTML for a chatbot (see `pageHtml.ts`), in the failures folder; where the page was.
   * With `near` (2026-11-18), also the piece of the page where the element not found most likely is: around the first
   * of those that finds something (`ChatLocatorNear`), and what that was (`around`).
   */
  private async keepPage(
    tag: string,
    keepSidebar: boolean,
    near?: { near: Array<ChatLocatorKey | NearPlace>; chatId?: string; file?: string },
  ): Promise<{ picture?: string; html?: string; url?: string; piece?: string; around?: string }> {
    if (!this.page || this.page.isClosed()) return {};
    const dir = join(this.opts.transportDir, '..', 'failures');
    await mkdir(dir, { recursive: true }).catch(() => undefined);
    const out: { picture?: string; html?: string; url?: string; piece?: string; around?: string } = { url: whereIs(this.p.url()) };
    const png = join(dir, `${tag}.png`);
    if (await this.p.screenshot({ path: png, fullPage: true }).then(() => true, () => false)) out.picture = png;
    const anchor = near ? await this.nearAnchor(near).catch(() => null) : null;
    const kept = await this.p.evaluate(strippedPageHtml, { keepSidebar, anchor: anchor?.handle ?? null, cap: 40_000 }).catch(() => ({ page: '', piece: '' }));
    await anchor?.handle.dispose().catch(() => undefined);
    const file = join(dir, `${tag}.html`);
    if (kept.page && (await writeFile(file, kept.page, 'utf8').then(() => true, () => false))) out.html = file;
    const pieceFile = join(dir, `${tag}.piece.html`);
    if (anchor && kept.piece && (await writeFile(pieceFile, kept.piece, 'utf8').then(() => true, () => false))) {
      out.piece = pieceFile;
      out.around = anchor.what;
    }
    return out;
  }

  /** The first of `near` that finds something on the page: the element (the newest of a conversation's), and what it is. */
  private async nearAnchor(near: { near: Array<ChatLocatorKey | NearPlace>; chatId?: string; file?: string }): Promise<{ handle: ElementHandle; what: string } | null> {
    for (const n of near.near) {
      const place = (NearPlaces as Record<string, { selector: string; what: string }>)[n];
      const key = place ? null : (n as ChatLocatorKey);
      let found: Locator;
      if (place) found = this.p.locator(place.selector);
      else if (key === 'attachment' || key === 'attachmentUploaded') {
        if (!near.file) continue;
        found = this.fileEl(key, near.file);
      } else if (key === 'chatMore') {
        if (!near.chatId) continue;
        found = this.el(key, near.chatId);
      } else found = this.el(key as ChatLocatorKey);
      const newest = key === 'answer' || key === 'turn' || key === 'userMessage' || key === 'copy';
      // One that shows first; a hidden one (the file input) only when none shows.
      for (const which of [found.filter({ visible: true }), found]) {
        if ((await which.count().catch(() => 0)) === 0) continue;
        const handle = await (newest ? which.last() : which.first()).elementHandle({ timeout: 1_000 }).catch(() => null);
        if (handle) return { handle, what: place ? place.what : `the element the "${key}" locator finds: ${ChatLocatorWhat[key as ChatLocatorKey]}` };
      }
    }
    return null;
  }

  /**
   * The operator's own steps for `when` (2026-11-17, see `chatSteps.ts`), in their order: "if this is on the page, do
   * this". One that must be there and is not, within its seconds, stops the work like a locator that found nothing,
   * said by its name; one that need not be is passed over.
   */
  private async runSteps(when: StepWhen, signal?: AbortSignal, lookOnly = false): Promise<void> {
    for (const problem of this.stepProblems.splice(0)) this.emit('chat-step-not-used', { problem });
    for (const step of this.steps) {
      if (step.when !== when) continue;
      if (signal?.aborted) throw new StoppedByOperator('stopped by the operator during a step on the way to the chat');
      /*
       * `lookOnly`: "Check the locators", which only reads (bug hunt 2026-11-18). A step that must be there and is not
       * stopped the opening of the newest conversation, so what only a conversation holds was not looked for, and it was
       * said as having stopped the work. Taken as one that need not be; the check looks for each step itself.
       */
      await this.runStep(lookOnly ? { ...step, must: false } : step);
    }
  }

  private async runStep(step: ChatStep): Promise<void> {
    const ms = Math.max(0, step.waitSec ?? 2) * 1000;
    const shown = this.p.locator(playwrightSelector(step.locator)).filter({ visible: true }).first();
    const said = { id: step.id, name: step.name, when: step.when, action: step.action };
    if (step.action === 'gone') {
      // Waited for to go, when it is there: a spinner, a banner that leaves by itself.
      if ((await shown.count().catch(() => 0)) === 0) return this.emit('chat-step', { ...said, did: 'not-there' });
      const went = ms > 0 && (await shown.waitFor({ state: 'hidden', timeout: ms }).then(() => true, () => false));
      if (went) return this.emit('chat-step', { ...said, did: 'gone' });
      if (step.must) throw await this.stepMissing(step, `was still on the page after ${Math.round(ms / 1000)} s`);
      return this.emit('chat-step', { ...said, did: 'still-there' });
    }
    // 0 seconds: only a look at the page as it is (a wait of no time would see nothing, even what is there).
    const there =
      ms === 0
        ? (await shown.count().catch(() => 0)) > 0
        : await shown.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
    if (!there) {
      if (step.must) throw await this.stepMissing(step, `found nothing within ${Math.round(ms / 1000)} s`);
      return this.emit('chat-step', { ...said, did: 'not-there' });
    }
    try {
      if (step.action === 'click') await shown.click({ timeout: 10_000 });
      else if (step.action === 'press') await this.p.keyboard.press((step.key ?? '').trim());
      this.emit('chat-step', { ...said, did: step.action === 'appear' ? 'appeared' : step.action === 'press' ? 'pressed' : 'clicked' });
    } catch (e) {
      if (step.must) throw await this.stepMissing(step, `was found, and ${step.action === 'press' ? 'the key could not be pressed' : 'could not be clicked'}: ${(e as Error).message.split('\n')[0]}`);
      this.emit('chat-step', { ...said, did: 'failed', error: (e as Error).message.split('\n')[0] });
    }
  }

  /** One of the operator's own steps that must be there and is not: said like a locator that found nothing. */
  private async stepMissing(step: ChatStep, why: string, stopped = true): Promise<LocatorMissing> {
    const key = stepKey(step.id) as `step:${string}`;
    const { picture, html, url, piece, around } = await this.keepPage(`step-${step.id}-${Date.now()}`, false, { near: StepNear });
    const when = step.when === 'open' ? 'when the chat opened' : 'before a message';
    this.emit('locator-missing', { key, name: step.name, locator: step.locator, why: `${when}: ${why}`, stopped, ...(html ? { html } : {}), ...(picture ? { picture } : {}), ...(url ? { url } : {}), ...(piece ? { piece, around } : {}) });
    const files = [picture ? `A picture of the page: ${picture}.` : '', html ? `The page's HTML, for a chatbot to find the right locator in: ${html}.` : ''].filter(Boolean).join(' ');
    return new LocatorMissing(
      key,
      step.locator,
      `Your step "${step.name || step.locator}" must be there, and ${when} its locator ${why}. In force: ${step.locator} ` +
        `(Settings → "Steps to the chat"; switch the step off there, or make it not required, to go on without it). ${files}`.trim(),
      html,
      picture,
    );
  }

  /** A locator that found nothing where the work goes on without it (a conversation's name): said once a window. */
  private async warnLocator(key: ChatLocatorKey, why: string, chatId?: string): Promise<void> {
    if (this.warned.has(key) || !this.page || this.page.isClosed()) return;
    if ((await this.el(key, chatId).count().catch(() => 1)) > 0) return;
    this.warned.add(key);
    await this.locatorMissing(key, why, { stopped: false, ...(chatId ? { chatId } : {}) });
  }

  /**
   * Looks for each of the chat's locators in force in the page (operator, 2026-11-17: "make the 'Check the locators'
   * button too"), and says for each what it found. Only reads and looks:
   * - the chat as it was opened: its box, and its Send (one letter typed and taken out again, if Send shows only with
   *   text; nothing is sent);
   * - the sidebar;
   * - the newest conversation in it, opened by its address: its messages, its answers, their Copy;
   * - its "More" button, whose menu is opened and closed again with Escape, for "Rename".
   * The rename dialog is not opened, and Stop shows only while Copilot writes: those are said as not on the page then.
   * One that finds nothing is said as a failure the work went on without (`locator-missing`, its HTML kept), so its
   * field goes red in Settings.
   */
  async checkLocators(): Promise<LocatorCheck[]> {
    const out = new Map<ChatLocatorKey, LocatorCheck>();
    const why = 'when the locators were checked ("Check the locators" in Settings)';
    const count = async (key: ChatLocatorKey, chatId?: string): Promise<number> => await this.el(key, chatId).count().catch(() => 0);
    const record = async (key: ChatLocatorKey, n: number, chatId?: string, note?: LocatorCheck['note']): Promise<number> => {
      out.set(key, { key, status: n > 0 ? 'found' : 'none', count: n, ...(note ? { note } : {}) });
      if (n === 0) await this.locatorMissing(key, why, { stopped: false, ...(chatId ? { chatId } : {}) }).catch(() => undefined);
      return n;
    };
    const look = async (key: ChatLocatorKey, chatId?: string): Promise<number> => await record(key, await count(key, chatId), chatId);
    const notHere = (key: ChatLocatorKey, note: NonNullable<LocatorCheck['note']>): void => {
      out.set(key, { key, status: 'not-here', count: 0, note });
    };

    // The chat as it was opened: its box, and its Send.
    const box = await look('composer');
    let send = await count('send');
    if (send === 0 && box > 0) {
      // Send shown only once the box holds text: one letter, taken out again. Nothing is sent.
      await this.composer().fill('x').catch(() => undefined);
      await this.p.waitForTimeout(500);
      send = await count('send');
      await this.composer().fill('').catch(() => undefined);
    }
    await record('send', send);
    // The box's file input (hidden: counted, not looked at). An attached file shows only once one is, and none is here.
    await look('uploadInput');
    notHere('attachment', 'attach');
    notHere('attachmentUploaded', 'attach');
    // Copilot's bar of a refused upload shows only when an upload is refused.
    notHere('uploadError', 'attach');
    // Stop shows only while Copilot writes.
    const stop = await count('stop');
    if (stop > 0) out.set('stop', { key: 'stop', status: 'found', count: stop });
    else notHere('stop', 'writing');

    // The sidebar, and the newest conversation in it, opened by its address: only read.
    const links = await look('conversationLink');
    const href = links > 0 ? await this.el('conversationLink').first().getAttribute('href').catch(() => null) : null;
    const chatId = href ? parseChatId(href) : null;
    const opened = chatId ? await this.openConversation(chatId, { stepsLookOnly: true }).catch(() => false) : false;
    if (opened && chatId) {
      for (const key of ['turn', 'userMessage', 'answer', 'copy'] as const) await look(key);
      // Its "More" button: by the locator; at its default and finding nothing, by its name in the row, as the bot does.
      let more = this.el('chatMore', chatId).first();
      let found = await count('chatMore', chatId);
      let note: LocatorCheck['note'];
      if (found === 0 && this.chatLocators.chatMore === DefaultChatLocators.chatMore) {
        const row = this.el('conversationLink').and(this.p.locator(`[href*="${chatId}"]`)).first();
        const byName = row.locator('xpath=ancestor-or-self::*[self::li or self::div][1]').getByRole('button', { name: Rename.moreButtonLabel, exact: true });
        const n = await byName.count().catch(() => 0);
        if (n > 0) {
          more = byName.first();
          found = n;
          note = 'byName';
        }
      }
      await record('chatMore', found, chatId, note);
      if (found > 0) {
        await this.press(more).catch(() => undefined);
        await this.el('renameItem').first().waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
        await look('renameItem');
        await this.dismissOpenMenu().catch(() => undefined);
      } else notHere('renameItem', 'noMenu');
    } else {
      for (const key of ['turn', 'userMessage', 'answer', 'copy', 'chatMore', 'renameItem'] as const) notHere(key, 'noConversation');
    }
    // The rename dialog is not opened: renaming is not this check's to do.
    notHere('renameInput', 'dialog');
    notHere('renameSave', 'dialog');
    // The operator's own steps (2026-11-17): what each finds now; one required not found is in red, the rest as they are.
    const ownSteps: LocatorCheck[] = [];
    for (const step of this.steps) {
      const key = stepKey(step.id) as `step:${string}`;
      const n = await this.p.locator(playwrightSelector(step.locator)).filter({ visible: true }).count().catch(() => 0);
      if (n > 0) ownSteps.push({ key, status: 'found', count: n });
      else if (step.action === 'gone') ownSteps.push({ key, status: 'not-here', count: 0, note: 'gone' });
      else if (step.must) {
        ownSteps.push({ key, status: 'none', count: 0 });
        await this.stepMissing(step, 'found nothing when the locators were checked', false).catch(() => undefined);
      } else ownSteps.push({ key, status: 'not-here', count: 0, note: 'optional' });
    }
    for (const c of ownSteps) out.set(c.key as ChatLocatorKey, c);
    this.emit('locators-checked', { found: [...out.values()].filter((c) => c.status === 'found').length, none: [...out.values()].filter((c) => c.status === 'none').map((c) => c.key) });
    return [...CHAT_LOCATOR_KEYS.map((k) => out.get(k) ?? ({ key: k, status: 'not-here', count: 0 } as LocatorCheck)), ...ownSteps];
  }

  /** Whether the box to write in is empty: a message clicked away with Send leaves it so. */
  private async boxIsEmpty(): Promise<boolean> {
    return ((await this.composer().innerText({ timeout: 2_000 }).catch(() => 'unread')) ?? '').trim() === '';
  }

  /** Whether the composer shows within `ms`, looked for a second at a time; a Stop ends the wait with `StoppedByOperator`. */
  private async composerWithin(ms: number, signal: AbortSignal | undefined, stopped: string): Promise<boolean> {
    const until = Date.now() + ms;
    for (;;) {
      if (signal?.aborted) throw new StoppedByOperator(stopped);
      try {
        await this.composer().waitFor({ state: 'visible', timeout: Math.max(1, Math.min(1_000, until - Date.now())) });
        return true;
      } catch (e) {
        // Only "not yet": a closed window or page ends the wait as it always did, at once.
        if ((e as Error).name !== 'TimeoutError') throw e;
        if (Date.now() >= until) return false;
      }
    }
  }

  /** One of the chat's addresses (`Url.newChatPath`, `Url.conversationPath`) on the host the chat was last found on. */
  private chatAddress(path: string): string {
    return `${this.chatOrigin}${path}`;
  }

  /**
   * Keeps the host the chat was found on — its box there, and staying — when it is the work Copilot's: the chat's
   * addresses are opened there from then on. Whatever the path: on 2026-11-17 the work machine's chat was at `/home`.
   */
  private learnChatOrigin(): void {
    const url = this.p.url();
    if (surfaceOfUrl(url) === 'work') this.chatOrigin = new URL(url).origin;
  }

  /** Whether the box to write in is still there, on the same page, after `settleMs`: one that showed on the way elsewhere is not. */
  private async boxStays(): Promise<boolean> {
    const at = whereIs(this.p.url());
    await this.p.waitForTimeout(this.settleMs);
    return whereIs(this.p.url()) === at && (await this.composer().isVisible().catch(() => false));
  }

  /**
   * After the window was sent to the chat (`path`, one of its addresses): whether it got there. Operator, 2026-11-17:
   * the start ended on "The page is not the Microsoft 365 Copilot chat" at
   * `copilot.cloud.microsoft/home?es=SSR&redirfrom=mcmToCcm` — the box to write in had shown, and a few seconds later the
   * page was Copilot's home page, with none, and the bot neither waited nor went to the chat from there.
   *
   * - `chat`: the box is there and stays (`boxStays`). The host it is on is the chat's from then on (`learnChatOrigin`).
   * - `elsewhere`: the page is another of the work Copilot's own (`isCopilotOtherPage`), and stayed one after the chat
   *   was opened from it — by `path` on the page's own host, then, for a new chat, by the page's link to its chat. It
   *   is not a sign-in, and is not waited on as one.
   * - `no-box`: anything else with no box within `firstLookMs` — a sign-in page, the consumer Copilot, a chat slow to
   *   load — left to the caller, as before.
   *
   * Looked at a second at a time, so a Stop ends it at once; another of Copilot's pages is given `otherPageMs` to turn
   * into the chat on its own, not the whole first look.
   */
  private async arrive(path: string, signal: AbortSignal | undefined, stopped: string): Promise<Arrival> {
    for (let move = 0; ; move += 1) {
      const until = Date.now() + this.firstLookMs;
      let otherSince = 0;
      for (;;) {
        if ((await this.composerWithin(Math.max(1, Math.min(1_000, until - Date.now())), signal, stopped)) && (await this.boxStays())) {
          this.learnChatOrigin();
          return 'chat';
        }
        const other = isCopilotOtherPage(this.p.url());
        otherSince = other ? otherSince || Date.now() : 0;
        if (other && Date.now() - otherSince >= this.otherPageMs) break;
        if (Date.now() >= until) {
          if (other) break;
          return 'no-box';
        }
      }
      if (move >= 2) return 'elsewhere';
      const found = whereIs(this.p.url());
      if (move === 0) {
        const to = `${new URL(this.p.url()).origin}${path}`;
        this.emit('chat-page-elsewhere', { found, by: 'address', to: whereIs(to) });
        await this.p.goto(to, { waitUntil: 'domcontentloaded' });
      } else {
        // A conversation's address is the only way to it: a link to the chat would open a new one.
        if (path !== Url.newChatPath) return 'elsewhere';
        const link = await this.chatLink();
        if (!link) return 'elsewhere';
        this.emit('chat-page-elsewhere', { found, by: 'link', to: whereIs(link.href) });
        await link.at.click({ timeout: 5_000 }).catch(() => undefined);
      }
    }
  }

  /**
   * The page's own link to its chat, for another of Copilot's pages that the chat's address did not get past: an anchor
   * on the page's host to `/chat`, shown, and opening in this window. Nothing else on the page is clicked.
   */
  private async chatLink(): Promise<{ at: Locator; href: string } | null> {
    const found = await this.p
      .evaluate(() => {
        const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')];
        const i = links.findIndex((a) => {
          let u: URL;
          try {
            u = new URL(a.href);
          } catch {
            return false;
          }
          const box = a.getBoundingClientRect();
          const shown = box.width > 0 && box.height > 0 && getComputedStyle(a).visibility !== 'hidden';
          return u.origin === location.origin && u.pathname.replace(/\/+$/, '') === '/chat' && (!a.target || a.target === '_self') && shown;
        });
        return i < 0 ? null : { i, href: links[i]!.href };
      })
      .catch(() => null);
    return found ? { at: this.p.locator('a[href]').nth(found.i), href: found.href } : null;
  }

  /**
   * The error for a window that would not go to the chat from another of Copilot's pages (`arrive`'s `elsewhere`), with
   * a picture of the page — a screenshot always, its HTML when Settings keep it — so the next look is at what it showed.
   */
  private async notTheChat(): Promise<Error> {
    const url = this.p.url();
    // Most likely the box itself (2026-11-17: Copilot's chat was at /home, its box changed): said as the box's locator.
    return await this.locatorMissing('composer', `on ${whereIs(url)}, which did not turn into the chat`, {
      message: (files) =>
        `Copilot showed its page ${whereIs(url)} instead of the chat, and the chat did not open from there ` +
        `(by its address on that host, nor by a link to it on the page). Nothing was sent. ${files} ${this.composerHint()}
Current URL: ${url}`,
    });
  }

  /**
   * Which Copilot we actually landed on.
   *
   * `m365.cloud.microsoft` silently redirects to the consumer Copilot when the profile is
   * not signed in with a work account. Both have a message box, so "the composer is visible"
   * is not proof. It matters because the consumer surface runs human verification and the
   * work surface does not, so ending up there looks exactly like being detected as a bot
   * when it is really a sign-in problem.
   */
  async surface(): Promise<'work' | 'consumer' | 'sign-in' | 'unknown'> {
    const where = surfaceOfUrl(this.p.url());
    if (where !== 'work') return where;
    // The box by the chat's locator in force (2026-11-17: the work page's box changed, and Settings may name it).
    const hasWorkComposer = (await this.composer().count().catch(() => 0)) > 0;
    return hasWorkComposer ? 'work' : 'unknown';
  }

  /**
   * Email addresses visible in the page, as a way to tell which account is signed in.
   *
   * There is no supported API for "who is signed in to this web app", and the account
   * flyout's markup is not something to depend on, so this scrapes the rendered HTML for
   * address-shaped strings. It is a diagnostic, not a security check: it exists so that
   * signing in as the wrong user is caught immediately instead of three failures later.
   */
  async findAccountsInPage(): Promise<string[]> {
    return await this.p
      .evaluate(() => {
        const html = document.documentElement.innerHTML;
        const found = html.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
        const junk = /(\.png|\.jpg|\.svg|\.gif|@2x|@3x|sentry|example\.com|microsoft\.com$)/i;
        return [...new Set(found.filter((e) => !junk.test(e)))].slice(0, 10);
      })
      .catch(() => [] as string[]);
  }

  /**
   * Signs the browser out of Microsoft, so the next visit cannot silently reuse a session.
   *
   * Needed because Edge on a domain-joined machine will happily sign the profile in with
   * whatever account Windows knows about, which is how the wrong user ends up in the chat
   * without anyone choosing it.
   */
  async signOut(): Promise<void> {
    this.onChat = null;
    this.emit('signing-out');
    await this.p
      .goto('https://login.microsoftonline.com/common/oauth2/v2.0/logout', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      })
      .catch(() => undefined);
    await this.p.waitForTimeout(3_000);
    await this.context?.clearCookies().catch(() => undefined);
    this.emit('signed-out');
  }

  /**
   * Opens the chat asking for a specific account.
   *
   * `login_hint` tells Microsoft which account to use and `prompt=select_account` stops it
   * picking one for you. Neither is a guarantee, so the caller still verifies afterwards.
   */
  async gotoChatAs(upn: string | undefined, url = this.opts.chatUrl): Promise<void> {
    const target = new URL(url);
    if (upn) {
      target.searchParams.set('login_hint', upn);
      target.searchParams.set('prompt', 'select_account');
    }
    this.onChat = null;
    await this.p.goto(target.toString(), { waitUntil: 'domcontentloaded' });
  }

  /**
   * Throws with an explanation when the profile is not on the work Copilot. On the work Copilot's host with no box to
   * write in, the box is waited for a few seconds rather than looked for once (2026-11-17: the page was changing); a
   * page that is still not the chat leaves a picture of itself, since its address alone does not say what it showed.
   */
  async assertWorkSurface(): Promise<void> {
    let where = await this.surface();
    if (where === 'unknown' && surfaceOfUrl(this.p.url()) === 'work') {
      await this.composerWithin(SURFACE_WAIT_MS, undefined, '');
      where = await this.surface();
    }
    if (where === 'work') return;
    const url = this.p.url();
    const explain: Record<string, string> = {
      consumer:
        'This is the consumer Copilot, not Microsoft 365 Copilot. The profile is signed in ' +
        'with a personal account, or not signed in with a work account at all. Run ' +
        '"cop login" and sign in with the work or school account.',
      'sign-in': 'The profile is signed out. Run "cop login".',
      unknown: 'The page is not the Microsoft 365 Copilot chat.',
    };
    if (where === 'unknown') {
      throw await this.locatorMissing('composer', `on ${whereIs(url)}`, { message: (files) => `${explain.unknown} ${files} ${this.composerHint()}
Current URL: ${url}` });
    }
    throw new Error(`${explain[where] ?? explain.unknown}
Current URL: ${url}`);
  }

  /**
   * Something in the page that only a person can clear.
   *
   * The bot never clicks a verification checkbox and never attempts a challenge. It reports
   * what it sees and waits for the human, which is the difference between a run that pauses
   * with a clear instruction and one that times out with a confusing error.
   */
  async detectBlocker(): Promise<BlockerFinding> {
    try {
      const text = (await this.p.locator('body').innerText({ timeout: 5_000 }).catch(() => '')) ?? '';

      const phrase = Blocker.verificationText.find((t) => text.includes(t));
      if (phrase) return { kind: 'verification', reason: `page text contains "${phrase}"` };

      const frames = this.p.frames().map((f) => f.url());
      const frame = frames.find((u) => Blocker.challengeFrameHosts.some((h) => u.includes(h)));
      if (frame) return { kind: 'verification', reason: `challenge iframe: ${frame.slice(0, 120)}` };

      const banner = Blocker.errorBannerText.find((t) => text.includes(t));
      if (banner) return { kind: 'error-banner', reason: `page text contains "${banner}"` };
    } catch {
      /* a closed or navigating page is handled by the caller */
    }
    return { kind: 'none', reason: '' };
  }

  /**
   * Waits for a human to clear a challenge, or clears a transient error banner itself.
   *
   * Returns true when the page became usable again. The checkbox is deliberately left
   * untouched: completing a human-verification check is the human's part of this.
   */
  async handleBlocker(found: BlockerFinding): Promise<boolean> {
    const { kind, reason } = found;
    // Evidence first: whatever happens next, there is a picture of what the page looked like.
    await this.dumpFailure(join(this.opts.transportDir, '..', 'failures'), `blocker-${kind}-${Date.now()}`)
      .catch(() => undefined);

    if (kind === 'error-banner') {
      this.emit('error-banner', { action: 'reloading', reason });
      const refresh = this.p.getByRole('button', { name: Blocker.refreshLabel, exact: true });
      if ((await refresh.count()) > 0) await refresh.first().click().catch(() => undefined);
      else await this.p.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await this.p.waitForTimeout(3_000);
      return (await this.detectBlocker()).kind === 'none';
    }

    const waitMs = this.opts.humanWaitMs ?? 15 * 60_000;
    this.emit('verification-required', { waitMs, reason });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await this.p.waitForTimeout(3_000);
      if ((await this.detectBlocker()).kind === 'none') {
        this.emit('verification-cleared');
        return true;
      }
    }
    return false;
  }

  /** Detects a blocker and waits it out. Throws when it is still there after the wait. */
  private async clearBlockers(): Promise<void> {
    /*
     * Both of these run before every message, not only when a conversation is opened.
     *
     * Edge's first-run dialogs and the consent banner do not wait for a convenient moment; they
     * appear when they appear, sit over the chat, and block the composer. A run that met one
     * mid-task did not fail at the dialog — it failed several steps later, looking like
     * something else. Declining them before each send costs two locator lookups.
     */
    await this.dismissPopups().catch(() => undefined);
    await this.dismissFeedbackPanel().catch(() => undefined);
    for (let i = 0; i < 3; i += 1) {
      const found = await this.detectBlocker();
      if (found.kind === 'none') return;
      const cleared = await this.handleBlocker(found);
      if (cleared) return;
      if (found.kind === 'verification') {
        throw new Error(
          'The chat is showing a human-verification challenge and it was not cleared in time. ' +
            'Complete it in the open Edge window, then start the run again. ' +
            'The bot does not attempt verification challenges by design.',
        );
      }
    }
    throw new Error('The chat kept reporting an error after several reloads.');
  }

  /**
   * Opens the chat and, if the tenant has signed us out, waits for the human. The bot never
   * types credentials; it only waits for the composer to appear.
   */
  /**
   * `boxNotWaited`: for a reading that only looks — the models, "Check the locators" — a box not found on Copilot's own
   * chat page, no sign-in page in sight, is said at once as the box's locator, not waited on for the whole sign-in time
   * (second bug hunt, 2026-11-19: the operator, at Settings, waited fifteen minutes with nothing said). A sign-in page is
   * still waited on.
   */
  async ensureSignedIn(url = this.opts.chatUrl, opts: { signal?: AbortSignal; stepsLookOnly?: boolean; boxNotWaited?: boolean } = {}): Promise<void> {
    // A box locator saved in Settings that cannot be used: said once, before the box is looked for with the default.
    for (const problem of this.chatLocatorProblems.splice(0)) this.emit('chat-locator-not-used', { problem });
    // Copilot's home page, where no conversation is expected until the run enters one.
    this.onChat = null;
    await this.p.goto(url, { waitUntil: 'domcontentloaded' });

    /*
     * Looked for a second at a time, so a Stop pressed while the page loads or the operator has not signed in yet
     * ends the wait at once, rather than after the whole sign-in timeout, fifteen minutes by default (2026-10-17).
     */
    const stoppedHere = 'stopped by the operator while waiting for the sign-in';
    /*
     * The chat; or another of Copilot's own pages, which the chat is opened from (2026-11-17: Copilot's home page, where
     * the work machine's start ended); or a page asking for a sign-in, the only one waited on for the operator.
     */
    let at = await this.arrive(Url.newChatPath, opts.signal, stoppedHere);
    if (at === 'no-box') {
      this.emit('sign-in-required', { url: this.p.url() });
      /*
       * On Copilot's own chat page, no sign-in page in sight, and still no box after a while (2026-11-18): most likely the
       * box's locator, which finds nothing on a page Copilot changed — and the bot waited the whole sign-in time (15
       * minutes by default) and then said "the sign-in was not completed", with no locator named. Said once, then, as the
       * box's locator, the page's file for a chatbot kept; the wait for a sign-in goes on, since Copilot may also ask for
       * one on its own page.
       */
      const firstLook = Math.min(this.boxSuspectMs, this.opts.signInTimeoutMs);
      const soon = await this.composerWithin(firstLook, opts.signal, stoppedHere);
      if (!soon && opts.boxNotWaited && isWorkChatAddress(this.p.url())) {
        this.warned.add('composer');
        throw await this.locatorMissing('composer', `on ${whereIs(this.p.url())}, Copilot's own chat page and not a sign-in page, for ${Math.round(firstLook / 1000)} s`);
      }
      let suspected = false;
      if (!soon && isWorkChatAddress(this.p.url()) && !this.warned.has('composer')) {
        this.warned.add('composer');
        suspected = true;
        await this.locatorMissing('composer', `on ${whereIs(this.p.url())}, Copilot's own chat page and not a sign-in page, for ${Math.round(firstLook / 1000)} s: if you are signed in, the box's locator is the one to fix (the bot goes on waiting for a sign-in meanwhile)`, { stopped: false }).catch(() => undefined);
      }
      if (!soon && !(await this.composerWithin(Math.max(1, this.opts.signInTimeoutMs - firstLook), opts.signal, stoppedHere))) {
        throw new Error(
          `The sign-in was not completed within ${Math.round(this.opts.signInTimeoutMs / 1000)} s (Settings → copilot.signInTimeoutSec). ` +
            'Sign in in the open Edge window, then start again.' +
            (this.warned.has('composer') && isWorkChatAddress(this.p.url())
              ? ` If you were signed in, the box to write in was not found on Copilot's chat page: fix "Box to write in" in Settings → "The chat's locators" (its notice has the file for a chatbot). In force: ${this.chatLocators.composer}`
              : ''),
        );
      }
      /*
       * Found after all, once the sign-in was done (second bug hunt, 2026-11-19): the box's locator was not at fault, and
       * the red field and the banner it had been given stayed, saying so.
       */
      if (suspected) {
        this.warned.delete('composer');
        this.emit('locator-found', { key: 'composer', locator: this.chatLocators.composer });
      }
      this.emit('signed-in');
      // A sign-in may come back to Copilot's home page rather than to its chat.
      at = await this.arrive(Url.newChatPath, opts.signal, stoppedHere);
    }
    if (at === 'elsewhere') throw await this.notTheChat();

    await this.clearBlockers();
    // The page may have moved on while the blockers were looked at, as the work machine's did: once more to the chat.
    if ((await this.surface()) !== 'work' && (await this.arrive(Url.newChatPath, opts.signal, stoppedHere)) === 'elsewhere') {
      throw await this.notTheChat();
    }
    await this.assertWorkSurface();
    await this.runSteps('open', opts.signal, opts.stepsLookOnly);
  }

  async newChat(): Promise<void> {
    this.onChat = null;
    await this.p.goto(this.chatAddress(Url.newChatPath), { waitUntil: 'domcontentloaded' });
    // Another of Copilot's pages instead (2026-11-17): the chat opened from it, and said so when it would not.
    if ((await this.arrive(Url.newChatPath, undefined, '')) === 'elsewhere') throw await this.notTheChat();
    // A chat slow to load: the rest of the minute it was always given (the page's default timeout); none by then, said.
    await this.composer()
      .waitFor({ state: 'visible', timeout: 45_000 })
      .catch(async (e: unknown) => {
        if ((e as Error).name !== 'TimeoutError') throw e;
        throw await this.locatorMissing('composer', 'on a new chat, within a minute');
      });
    await this.dismissPopups();
    await this.runSteps('open');
    this.onChat = 'new';
  }

  /** Reopens a conversation by its id. Returns false when it no longer opens. */
  async openConversation(chatId: string, opts: { stepsLookOnly?: boolean } = {}): Promise<boolean> {
    this.onChat = null;
    const path = Url.conversationPath(chatId);
    await this.p.goto(this.chatAddress(path), { waitUntil: 'domcontentloaded' });
    const at = await this.arrive(path, undefined, '');
    if (at === 'elsewhere' || (at === 'no-box' && !(await this.isChatReady(5_000)))) return false;
    const there = parseChatId(this.p.url()) === chatId;
    if (there) {
      this.onChat = { id: chatId };
      await this.runSteps('open', undefined, opts.stepsLookOnly);
    }
    return there;
  }

  /** Finds a conversation by its exact name in the sidebar. */
  async openConversationByName(name: string): Promise<boolean> {
    const row = this.el('conversationLink').and(this.p.locator(`[aria-label="${name.replace(/"/g, '\\"')}"]`));
    if ((await row.count()) === 0) return false;
    // The conversation it is, from the link's own address: the page's follows a moment after the click.
    const href = await row.first().getAttribute('href').catch(() => null);
    this.onChat = null;
    await row.first().click();
    if (!(await this.isChatReady(20_000))) return false;
    const id = parseChatId(href ?? '') ?? parseChatId(this.p.url());
    if (id) {
      this.onChat = { id };
      this.chatNames.set(id, name);
    }
    await this.runSteps('open');
    return true;
  }

  async currentChatId(): Promise<string | null> {
    return parseChatId(this.p.url());
  }

  /** The conversation id in the page's address, waited for up to `ms`: null when it shows none by then. */
  private async addressId(ms: number): Promise<string | null> {
    const until = Date.now() + ms;
    for (;;) {
      const id = parseChatId(this.p.url());
      if (id || Date.now() >= until) return id;
      await this.p.waitForTimeout(200);
    }
  }

  /**
   * Puts the window back on the conversation the bot put it on, when it has left it (operator, 2026-11-09: "after every
   * return to the bot — an action taken, a pause ended — check that we are on the right chat, by the address taken at
   * its start; if not, go back to it and carry on from there"). The runner asks this before every message it sends
   * (`staysOnItsChat` in taskRunner.ts), which is every moment the work goes on after a wait: a pause, a card answered,
   * commands handed over, a sign-in.
   *
   * What is compared is the conversation's id in the page's address, a uuid, the one the run keeps on record: unique,
   * and the same whatever the conversation is called. When the page shows another, or none — Copilot's home page, a new
   * chat on Auto, the sign-in page of a session that ran out, a conversation the operator opened from the sidebar — the
   * conversation is opened again by its address, and when the page asks for a sign-in first, the operator signing in is
   * waited for as at the start (`sign-in-required`; the run's Stop ends the wait); then by the name it was given in the
   * sidebar. The page is never written in where it was found: a conversation that will not open again ends with
   * `ChatLost`, and the next message is not sent anywhere either.
   *
   * A new conversation has no address until its first answer, so before that nothing can be compared; it takes the one
   * the page shows from then on.
   */
  async ensureOnChat(opts: { signal?: AbortSignal } = {}): Promise<OnChat> {
    const want = this.onChat;
    if (!want) return { at: 'unknown' };
    const now = parseChatId(this.p.url());
    if (want === 'new') {
      if (now) this.onChat = { id: now };
      return { at: 'here' };
    }
    if (now === want.id) return { at: 'here' };

    const from = whereIs(this.p.url());
    this.emit('chat-left', { chatId: want.id, found: from });
    const stopped = 'stopped by the operator while waiting for the sign-in';
    let signedIn = false;
    const path = Url.conversationPath(want.id);
    for (let tries = 0; tries < 3; tries += 1) {
      await this.p.goto(this.chatAddress(path), { waitUntil: 'domcontentloaded' });
      // Another of Copilot's pages, the conversation's address not getting past it (2026-11-17): by its name, not a sign-in.
      const at = await this.arrive(path, opts.signal, stopped);
      if (at === 'elsewhere') break;
      if (at === 'chat') {
        if (parseChatId(this.p.url()) !== want.id) break;
        this.onChat = want;
        await this.dismissPopups().catch(() => undefined);
        await this.runSteps('open', opts.signal);
        this.emit('chat-returned', { chatId: want.id, by: 'address', signedIn, from });
        return { at: 'returned', chatId: want.id, from, by: 'address', signedIn };
      }
      // No composer: the session ran out while the window waited, and the page asks for a sign-in — the operator's.
      this.emit('sign-in-required', { url: whereIs(this.p.url()) });
      await this.p.bringToFront().catch(() => undefined);
      if (!(await this.composerWithin(this.opts.signInTimeoutMs, opts.signal, stopped))) {
        this.onChat = want;
        throw new ChatLost(
          want.id,
          from,
          `The chat asked for a sign-in before going back to this conversation, and it was not completed within ${Math.round(this.opts.signInTimeoutMs / 1000)} s ` +
            '(Settings → copilot.signInTimeoutSec). Nothing was sent. Sign in in the open Edge window, then continue the task.',
        );
      }
      this.emit('signed-in');
      signedIn = true;
      // A sign-in comes back to Copilot's home page, not to the conversation: its address is opened again.
    }

    const name = this.chatNames.get(want.id);
    if (name && (await this.openConversationByName(name).catch(() => false)) && (await this.addressId(5_000)) === want.id) {
      this.emit('chat-returned', { chatId: want.id, by: 'name', name, signedIn, from });
      return { at: 'returned', chatId: want.id, from, by: 'name', signedIn };
    }
    // Still the one expected: the next message is not sent to the page found either.
    this.onChat = want;
    this.emit('chat-lost', { chatId: want.id, found: from });
    throw new ChatLost(want.id, from);
  }

  /**
   * Best-effort dismissal of first-run dialogs. Unknown ones are left alone and reported.
   *
   * Every label here **declines**, and that is the whole rule. Edge's own first-run dialog
   * offers "Confirm" next to "Set later", and confirming makes Edge the machine's default
   * browser — a system setting, changed by a bot, because a task happened to start while the
   * dialog was open. The consent banner underneath it offers "I Accept" next to "Reject All",
   * and accepting agrees to tracking on the operator's behalf. So: "Set later", never
   * "Confirm"; "Reject All", never "I Accept". A dialog whose only option is to agree to
   * something is not dismissed at all — it is reported and left for a person.
   *
   * This matters more than it looks. The dialogs sit over the chat and block the composer, so a
   * run that meets one does not fail cleanly; it fails somewhere further on, looking like
   * something else entirely.
   */
  async dismissPopups(): Promise<void> {
    // Switched off in Settings → "Steps to the chat" (2026-11-17).
    if (!this.builtIn.popups) return;
    for (const name of ['Got it', 'Close', 'Dismiss', 'No thanks', 'Skip', 'Set later', 'Not now', 'Maybe later', 'Reject All', 'Reject all']) {
      const b = this.p.getByRole('button', { name, exact: true });
      if ((await b.count()) > 0 && (await b.first().isVisible().catch(() => false))) {
        await b.first().click().catch(() => undefined);
        this.emit('popup-dismissed', { name });
      }
    }
  }

  /**
   * Renames the current conversation. The sidebar row's overflow menu holds "Rename", the
   * dialog holds an input and a Save button, and Enter does not submit it.
   */
  /**
   * Renames the conversation in Copilot's sidebar. Returns the name it now has — the one asked for, or a shorter form
   * of it when Copilot's dialog refused that one (see `chatNameForms`) — or false when it could not be renamed.
   */
  async nameChat(chatId: string, name: string, opts: { waitMs?: number } = {}): Promise<string | false> {
    // Switched off in Settings → "Steps to the chat" (2026-11-17): the conversation keeps Copilot's own title.
    if (!this.builtIn.nameChat) {
      if (!this.nameOffSaid) this.emit('chat-name-off', { chatId, name });
      this.nameOffSaid = true;
      return false;
    }
    const row = this.el('conversationLink').and(this.p.locator(`[href*="${chatId}"]`)).first();
    // Waited for, like everything below: a new chat's row appears in the sidebar some seconds after the
    // reply, and `count()` read it as missing and returned without a word (live run 2026-10-03). The run
    // tries again later when it is still not there (see `nameIfStillUnnamed` in taskRunner.ts).
    const waitMs = opts.waitMs ?? 15_000;
    try {
      await row.waitFor({ state: 'attached', timeout: waitMs });
    } catch {
      this.emit('chat-name-failed', { chatId, name, error: `the conversation did not appear in the sidebar within ${Math.round(waitMs / 1000)} s` });
      // Not one conversation in the sidebar by its locator: the locator's, said; this one not there yet is not.
      await this.warnLocator('conversationLink', 'in the sidebar, while the conversation was to be named').catch(() => undefined);
      return false;
    }

    /*
     * Every step here waits for what it is about to click.
     *
     * `count()` does not wait. It was used for both the overflow button and the menu item, so
     * a menu that had not finished rendering read as "not there", the method returned false —
     * and left the menu standing open over the sidebar, on whichever chat it had been opened
     * for. The rename then silently never happened, which is why conversations kept Copilot's
     * own auto-generated titles instead of the name this runner gave them.
     */
    let opened = false;
    // Which locator the step under way looks for: the one said when it finds nothing.
    let step: ChatLocatorKey = 'chatMore';
    try {
      await row.scrollIntoViewIfNeeded().catch(() => undefined);
      // Briefly: a hover the sidebar takes waits out the page's whole timeout otherwise.
      await row.hover({ timeout: 2_000 }).catch(() => undefined);
      /*
       * The chat's own overflow button, by the chat id it carries; through the row only in a build without
       * that attribute. A mouse click on it was taken by the sidebar over it — the chat's link, the sticky
       * section header — and Playwright retried for the whole minute (live 2026-10-05), so `press` clicks
       * the element itself when the mouse cannot reach it.
       */
      const byChat = this.el('chatMore', chatId).first();
      // Through the row by its name only while the locator is the default: one set in Settings is the one used.
      const more = (await byChat.count()) > 0 || this.chatLocators.chatMore !== DefaultChatLocators.chatMore
        ? byChat
        : row.locator('xpath=ancestor-or-self::*[self::li or self::div][1]').getByRole('button', { name: Rename.moreButtonLabel, exact: true }).first();
      await more.waitFor({ state: 'attached', timeout: 5_000 });
      await this.press(more);
      opened = true;

      step = 'renameItem';
      const item = await this.renamePart('renameItem', 5_000);
      await this.press(item);
      opened = false;

      step = 'renameInput';
      const input = await this.renamePart('renameInput', 10_000);
      step = 'renameSave';
      /*
       * Offered in shorter forms until the dialog takes one. Copilot refuses a name it counts as longer than 50
       * characters, by a count that is not always ours, and its dialog then stays open over the chat (2026-10-17: "the
       * bot tries to save a chat name longer than 50 characters, and it breaks its logic"). A dialog that takes none is
       * closed with Cancel, never left standing.
       */
      let wanted: string | null = null;
      const refused: string[] = [];
      // What the sidebar calls it: its row's label is the chat's name.
      const shows = async (): Promise<string> => ((await row.getAttribute('aria-label', { timeout: 1_000 }).catch(() => null)) ?? '').trim();
      for (const form of chatNameForms(name)) {
        await input.fill(form);
        const save = await this.renameSaveOf(input);
        /*
         * Its Save not found (work, 2026-11-18: role=button[name="Save"] found nothing, and the dialog was left open
         * over the chat): the name given with Enter, which such a field takes. Once only: a dialog that takes no Enter is
         * said, with its HTML while it is still open, and closed with Cancel below. A name taken is not said as a
         * failure (2026-11-24): there is nothing for the operator to do.
         */
        if (!save) {
          await input.press('Enter').catch(() => undefined);
          if (await this.renameTaken(input, null, async () => (await shows()) === form)) {
            wanted = form;
            this.emit('locator-worked-around', { key: 'renameSave', locator: this.chatLocators.renameSave, by: 'Enter in the name field' });
          } else {
            await this.warnLocator('renameSave', `while the conversation was being named "${name}"`, chatId).catch(() => undefined);
            refused.push(form);
          }
          break;
        }
        await this.press(save);
        if (await this.renameTaken(input, save, async () => (await shows()) === form)) {
          wanted = form;
          break;
        }
        refused.push(form);
        this.emit('chat-name-refused', { chatId, name: form, says: await this.renameSays(input) });
      }
      if (wanted === null) {
        await this.press(this.p.getByRole('button', { name: Rename.cancelText, exact: true }).first()).catch(() => undefined);
        await input.waitFor({ state: 'detached', timeout: 3_000 }).catch(async () => {
          await this.p.keyboard.press('Escape').catch(() => undefined);
        });
        this.emit('chat-name-failed', { chatId, name, error: `Copilot's rename dialog took none of ${refused.map((f) => `"${f}"`).join(', ')}; it was closed with Cancel` });
        return false;
      }

      // Taken, and its dialog still open (2026-11-25): closed, so it is not left over the chat.
      if (await input.isVisible().catch(() => false)) {
        const cancel = this.p.getByRole('button', { name: Rename.cancelText, exact: true }).first();
        await cancel.click({ timeout: 1_500 }).catch(() => undefined);
        await input.waitFor({ state: 'detached', timeout: 1_500 }).catch(async () => {
          await this.p.keyboard.press('Escape').catch(() => undefined);
        });
      }

      // Named only when the sidebar says so.
      const deadline = Date.now() + 8_000;
      while ((await shows()) !== wanted && Date.now() < deadline) await this.p.waitForTimeout(250);
      if ((await shows()) !== wanted) {
        this.emit('chat-name-failed', { chatId, name, error: `the sidebar still shows "${await shows()}"` });
        return false;
      }
      this.emit('chat-named', { chatId, name: wanted, ...(wanted !== name ? { asked: name } : {}) });
      this.chatNames.set(chatId, wanted);
      return wanted;
    } catch (e) {
      this.emit('chat-name-failed', { chatId, name, error: (e as Error).message });
      // The step's locator, when it finds nothing: said (the name is the work's convenience; the work goes on).
      await this.warnLocator(step, `while the conversation was being named "${name}"`, chatId).catch(() => undefined);
      // A rename dialog it stopped in is not left open over the chat (work, 2026-11-18): closed, after its HTML is kept.
      if (step === 'renameInput' || step === 'renameSave') await this.p.keyboard.press('Escape').catch(() => undefined);
      return false;
    } finally {
      // Whatever happened, the sidebar is left as it was found. A menu left hanging over the
      // chat list is not only untidy: it covers the rows and swallows the next click.
      if (opened) await this.dismissOpenMenu();
    }
  }

  /**
   * A part of the rename — the menu's "Rename", the dialog's field — once it shows: by its locator in force, else by the
   * bot's own ways to it (operator, 2026-11-24: "I had to change it again today"): the default, for one replaced in
   * Settings on a page that changed once more, then what it is on the page. The other ways are taken only when the
   * locator in force finds nothing that shows for `waitMs`, and said in the log (`locator-worked-around`).
   */
  private async renamePart(key: 'renameItem' | 'renameInput', waitMs: number): Promise<Locator> {
    const set = this.el(key).filter({ visible: true }).first();
    const problem = await set.waitFor({ state: 'visible', timeout: waitMs }).then(() => null, (e: unknown) => e as Error);
    if (!problem) return set;
    const ways =
      key === 'renameItem'
        ? [DefaultChatLocators.renameItem, '[role="menu"] :text-is("Rename")']
        : [DefaultChatLocators.renameInput, '[role="dialog"] input[type="text"], [role="dialog"] input:not([type]), [role="dialog"] [role="textbox"]'];
    for (const way of ways) {
      if (way === this.chatLocators[key]) continue;
      const found = this.p.locator(playwrightSelector(way)).filter({ visible: true }).first();
      if ((await found.count().catch(() => 0)) === 0) continue;
      this.emit('locator-worked-around', { key, locator: this.chatLocators[key], by: way });
      return found;
    }
    throw problem;
  }

  /**
   * The rename dialog's Save, or null. The one in the same dialog as the field, by its locator in force; else by the
   * default; else the dialog's one button that is neither Cancel nor a close. Only then one elsewhere on the page that
   * the locator in force finds (a dialog the bot does not know as one).
   */
  private async renameSaveOf(input: Locator): Promise<Locator | null> {
    const box = input.locator('xpath=ancestor::*[@role="dialog" or @role="alertdialog" or self::dialog or self::form][last()]');
    const boxed = (await box.count().catch(() => 0)) > 0;
    const set = this.el('renameSave').filter({ visible: true });
    const inBox = (l: Locator): Locator => l.and(box.locator('*')).first();
    const first = boxed ? inBox(set) : set.first();
    if (await first.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) return first;
    if (!boxed) return null;
    const around = (by: string): void => this.emit('locator-worked-around', { key: 'renameSave', locator: this.chatLocators.renameSave, by });
    const byDefault = inBox(this.p.locator(playwrightSelector(DefaultChatLocators.renameSave)).filter({ visible: true }));
    if (this.chatLocators.renameSave !== DefaultChatLocators.renameSave && (await byDefault.count().catch(() => 0)) > 0) {
      around(DefaultChatLocators.renameSave);
      return byDefault;
    }
    const buttons = box.locator('button, [role="button"], input[type="submit"]').filter({ visible: true });
    const others: number[] = [];
    const n = await buttons.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const says = await buttons
        .nth(i)
        .evaluate((el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('value'), el.textContent].map((x) => (x ?? '').trim()).filter(Boolean))
        .catch(() => [] as string[]);
      // Cancel, a close button whatever it is called, and one with no words at all (an icon) are not the Save.
      if (says.length === 0 || says.some((x) => /^(cancel|close|dismiss|clear|delete|back|help|info)\b|^[x×✕✖]$/i.test(x))) continue;
      others.push(i);
    }
    if (others.length === 1) {
      around("the dialog's one button that is not Cancel");
      return buttons.nth(others[0]!);
    }
    return (await set.count().catch(() => 0)) > 0 ? set.first() : null;
  }

  /**
   * Whether the rename dialog took the name it was given: it closes. A refusal it shows — the input marked invalid,
   * an alert in the dialog, the Save button disabled — ends the wait at once; one it does not show, after ten seconds.
   * A Save disabled while it is saving (aria-busy, or for less than a second and a half) is no refusal. Nor is a dialog
   * that stays open with the conversation already under that name in the sidebar (`named`): live on 2026-11-25 one said
   * nothing and stood for ten seconds, a shorter form and Cancel after it, and the name asked for was there.
   */
  private async renameTaken(input: Locator, save: Locator | null, named: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    let disabledSince: number | null = null;
    while (Date.now() < deadline) {
      if ((await input.count().catch(() => 0)) === 0 || !(await input.isVisible().catch(() => false))) return true;
      if (await named()) return true;
      const shown = await input
        .evaluate((el) => {
          const box = el.closest('[role="dialog"]') ?? el.parentElement;
          return el.getAttribute('aria-invalid') === 'true' || !!box?.querySelector('[role="alert"]');
        })
        .catch(() => false);
      if (shown) return false;
      const off =
        save !== null &&
        (await save
          .evaluate((el) => ((el as unknown as { disabled?: boolean }).disabled === true || el.getAttribute('aria-disabled') === 'true') && el.getAttribute('aria-busy') !== 'true', undefined, { timeout: 500 })
          .catch(() => false));
      if (!off) disabledSince = null;
      else {
        disabledSince ??= Date.now();
        if (Date.now() - disabledSince >= 1_500) return false;
      }
      await this.p.waitForTimeout(250);
    }
    return false;
  }

  /** What the rename dialog says, for the record of a refusal. */
  private async renameSays(input: Locator): Promise<string> {
    const text = await input.evaluate((el) => (el.closest('[role="dialog"]') ?? el.parentElement)?.textContent ?? '').catch(() => '');
    return text.replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  /**
   * Clicks an element: with the mouse when it can reach it, else on the element itself. A short wait
   * for the mouse, not the page's minute: in the sidebar another element lies over the target and
   * takes the click, which no amount of retrying changes.
   */
  private async press(target: Locator): Promise<void> {
    try {
      await target.click({ timeout: 3_000 });
    } catch {
      await target.evaluate((el) => (el as HTMLElement).click(), undefined, { timeout: 5_000 });
    }
  }

  /**
   * Closes whatever menu or dialog is open, without caring which one it is.
   *
   * Escape first, because it is what the UI itself listens for; a click on a dead area of the
   * page as the fallback for a menu that ignores it. Neither is allowed to throw: this runs in
   * a `finally`, and a cleanup that can fail the operation it is cleaning up after is worse
   * than the mess it was trying to tidy.
   */
  private async dismissOpenMenu(): Promise<void> {
    try {
      await this.p.keyboard.press('Escape');
      await this.hold(150);
      const open = this.p.locator('[role="menu"]');
      if ((await open.count()) > 0) {
        await this.p.mouse.click(4, 4);
        await this.hold(150);
      }
    } catch {
      /* the page may be navigating; a leftover menu is not worth an exception */
    }
  }

  // --- the model picker ---------------------------------------------------------------

  /**
   * Which model the chat is set to, as the picker button reports it.
   *
   * Returns null when the picker is not in the page at all, which is a real state: some
   * tenants do not expose a choice, and that is worth showing to the user as "this tenant
   * offers no choice" rather than as an error.
   */
  async currentModel(): Promise<string | null> {
    const button = await this.resolveModelButton(5_000);
    if (!button) return null;
    const text = ((await button.innerText().catch(() => '')) ?? '').trim();
    const label = (await button.getAttribute('aria-label').catch(() => null)) ?? '';
    // The aria-label is the control's name ("Model Selector"); the text is the value ("Auto").
    return text.length > 0 ? text.split('\n')[0].trim() : label.replace(Model.buttonLabel, '').trim() || null;
  }

  /** The picker button by the locator in force (Settings' own since 2026-10-24, else `button#gptModeSwitcher`). */
  private modelButton(): Locator {
    return this.p.locator(playwrightSelector(this.locators.button));
  }

  /**
   * The picker button, by id if it is there, otherwise by its accessible name.
   *
   * It waits rather than looking once. The composer is ready well before the toolbar around
   * it finishes hydrating, so an immediate check after `ensureSignedIn` finds nothing and
   * reports "this tenant has no model picker" about a tenant that plainly does. That is
   * exactly what the first live read did, and a four-second pause in a probe is what showed
   * it. Waiting is also the right answer for a slow morning on a cold profile.
   */
  private async resolveModelButton(timeoutMs = 15_000): Promise<Locator | null> {
    const deadline = Date.now() + timeoutMs;
    do {
      // One that shows first (2026-11-24): a page with Chat and Cowork can keep the button of the part not shown.
      for (const found of [this.modelButton(), this.p.getByRole('button', { name: Model.buttonLabel, exact: false })]) {
        const shown = found.filter({ visible: true });
        if ((await shown.count().catch(() => 0)) > 0) return shown.first();
      }
      await this.hold(500);
    } while (Date.now() < deadline);
    const hidden = this.modelButton();
    return (await hidden.count().catch(() => 0)) > 0 ? hidden.first() : null;
  }

  /**
   * Opens the picker and reads what it offers, then closes it again without choosing.
   *
   * The list is whatever this tenant shows today. Nothing is filtered and nothing is
   * translated: a name shown here is the name the chat uses. `raw` keeps the option's whole text,
   * which is where Microsoft puts the one-line description and any "limit reached" notice.
   *
   * Each option comes with its `locator`: where it sits in the picker, read here and used to choose
   * it again at the start of a run (see `selectModel`). A group is known by its test id and its place,
   * not by its text: once a model of a group is chosen, Copilot writes that model's name on the
   * group's row ("GPT" reads "GPT-5.6 Sol Think deeper"), and read by text the group lost that very
   * model, so the run could not choose it and went on Auto (2026-10-05).
   */
  async listModels(): Promise<{ options: ModelOption[]; current: string | null; note?: string }> {
    this.sayLocatorProblems();
    const button = await this.resolveModelButton();
    if (!button) {
      await this.pickerMissing('button', 'the model button was not on the page when the list of models was read');
      return { options: [], current: null, note: `This chat does not show a model picker, so there is nothing to choose (the picker button's locator: ${this.locators.button}). The page is kept: Settings → "The model menu's locators" has the file for a chatbot.` };
    }

    const current = await this.currentModel();
    const pressed = await this.pressPicker(button, 15_000).then(() => '', (e: unknown) => {
      if (e instanceof StoppedByOperator) throw e;
      return ((e as Error).message.split('\n')[0] ?? '').trim() || 'it could not be pressed';
    });
    if (pressed) {
      await this.pickerMissing('button', `what the model button's locator finds could not be pressed when the list of models was read (${pressed})`);
      return { options: [], current, note: `What the picker button's locator finds (${this.locators.button}) could not be pressed. The page is kept: Settings → "The model menu's locators" has the file for a chatbot.` };
    }
    if (!(await this.waitForPopup())) {
      await this.pickerMissing('rows', 'the model button was pressed and no menu opened in which they find anything (when no menu opened at all, the button\'s locator is the one to look at)');
      await this.captureMenu('top', []);
      await this.closeMenu();
      return { options: [], current, note: 'The model picker opened nothing that could be read. The page is kept: Settings → "The model menu\'s locators" has the file for a chatbot.' };
    }

    // The top menu only: a group's submenu can be on screen with it (2026-10-05, Claude's above GPT's).
    const shown = await this.rowsShown();
    const top = this.topRows(shown);
    await this.captureMenu('top', shown);
    if (shown.length === 0) await this.pickerMissing('rows', 'the model menu opened, and no row was found in it');
    await this.closeMenu();
    if (shown.length === 0) {
      return { options: [], current, note: `The model menu opened, and its rows' locator found nothing in it (${this.locators.rows}). Settings → "The model menu's locators" has it; the menu is kept as models-top.html/.png.` };
    }

    const strip = (r: MenuRow): ModelOption => ({ name: r.name, raw: r.raw, selected: r.selected, disabled: r.disabled, role: r.role });
    const options: ModelOption[] = top.filter((r) => !r.opensSubmenu).map((r) => ({ ...strip(r), locator: { role: r.role, index: r.index } }));
    const groups = top.filter((r) => r.opensSubmenu);

    // Each group is opened in its own pass, from a freshly opened menu. Walking several
    // submenus in one pass works until one of them closes the one above it, and then the
    // reader silently returns half a list; re-opening costs a second and cannot go wrong.
    for (const group of groups) {
      const where = { testId: group.testId || undefined, index: group.index, name: group.name, ...(vendorOf(group) ? { vendor: vendorOf(group) } : {}) };
      const children = await this.readSubmenu(button, where);
      const name = groupLabel(group, children);
      for (const child of children) {
        options.push({ ...strip(child), group: name, groupRaw: group.raw, locator: { role: child.role, index: child.index, group: { ...where, name } } });
      }
    }

    this.emit('models-read', { count: options.length, groups: groups.length, current });
    await this.captureMenu('result', top, { current, options }).catch(() => undefined);
    return { options, current };
  }

  /**
   * What the picker showed, kept beside the reading: the menu as HTML, a picture of it, and the rows
   * that were read from it.
   *
   * The picker is Microsoft's markup and it changes without notice; when "Read the list from
   * Copilot" comes back with the wrong models, the only way to see why is the menu as it was at that
   * moment. Written to this transport's folder (runs/_models for that button), overwritten by the
   * next reading, and never a reason for the reading to fail. Nothing personal is in a model menu.
   */
  private async captureMenu(label: string, rows: MenuRow[], extra?: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(this.opts.transportDir, { recursive: true });
      const base = join(this.opts.transportDir, `models-${label}`);
      if (label !== 'result') {
        const html = await this.p
          .evaluate((selectors) => {
            const parts: string[] = [];
            for (const sel of selectors) {
              for (const el of Array.from(document.querySelectorAll(sel))) {
                if ((el as HTMLElement).getClientRects().length > 0) parts.push(`<!-- ${sel} -->\n${el.outerHTML}`);
              }
            }
            return parts.join('\n\n');
          }, [...Model.popupSelectors])
          .catch((e: unknown) => `<!-- could not read the menu: ${String(e)} -->`);
        await writeFile(`${base}.html`, html, 'utf8');
        await this.p.screenshot({ path: `${base}.png` }).catch(() => undefined);
      }
      await writeFile(`${base}.json`, JSON.stringify({ at: new Date().toISOString(), rows, ...(extra ?? {}) }, null, 2), 'utf8');
    } catch {
      /* a diagnostic, never the reason a reading fails */
    }
  }

  /**
   * Presses the picker button, marking first what is on the page before its menu opens (2026-11-24): what looks like a
   * menu's row or a menu, and is there already, is not the model menu's. A switch between Chat and Cowork made of
   * `radio`s was read as the list of models ("Chat", "Cowork"), and one in a `group` was taken for the open menu before
   * the menu was there. Not marked: what is in a menu this bot has read, which may still be on its way out; and nothing
   * while the button says its menu is open.
   */
  private async pressPicker(button: Locator, timeoutMs?: number): Promise<void> {
    const open = (await button.getAttribute('aria-expanded', { timeout: 5_000 }).catch(() => null)) === 'true';
    if (!open) {
      await this.p
        .evaluate(
          ({ query, popups }) => {
            for (const el of Array.from(document.querySelectorAll('[data-cop-page]'))) el.removeAttribute('data-cop-page');
            const found: Element[] = Array.from(document.querySelectorAll(popups.join(',')));
            try {
              if (query.xpath) {
                const snap = document.evaluate(query.text, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                for (let i = 0; i < snap.snapshotLength; i += 1) {
                  const node = snap.snapshotItem(i);
                  if (node instanceof Element) found.push(node);
                }
              } else found.push(...Array.from(document.querySelectorAll(query.text)));
            } catch {
              /* said by the reading of the rows */
            }
            for (const el of found) {
              if ((el as HTMLElement).getClientRects().length === 0) continue;
              if (el.hasAttribute('data-cop-row')) continue;
              if (el.matches('[role="menu"],[role="listbox"]') && el.querySelector('[data-cop-row]')) continue;
              el.setAttribute('data-cop-page', '');
            }
          },
          { query: pageQuery(this.locators.rows), popups: [...Model.popupSelectors] },
        )
        .catch(() => undefined);
    }
    await button.click(timeoutMs === undefined ? undefined : { timeout: timeoutMs });
  }

  /** The rows of the menu just opened, given a moment to be drawn: a menu's box can be there before its rows. */
  private async rowsShown(timeoutMs = 3_000): Promise<MenuRow[]> {
    const deadline = Date.now() + timeoutMs;
    let rows = await this.readMenuRows();
    while (rows.length === 0 && Date.now() < deadline) {
      await this.hold(200);
      rows = await this.readMenuRows();
    }
    return rows;
  }

  /**
   * Every visible menu row right now, across the menu and whatever submenu is open, in page order. Not what was on the
   * page before the menu opened (see `pressPicker`).
   *
   * Each row says which menu it is in (`menuOf`, the menu's `aria-labelledby`: a submenu is labelled by
   * the row that opens it) and its place there (`index`), so the same row can be found again without
   * going by its text. Rows are not merged by name: the group row and the model chosen in it carry the
   * same name once that model is in force.
   *
   * The rows are what the rows' locator in force finds (Settings' own since 2026-10-24), an XPath or a CSS selector.
   */
  private async readMenuRows(): Promise<MenuRow[]> {
    const read = await this.p.evaluate(
      ({ query, selectedAttrs, submenuAttrs }) => {
        const out: Array<{ name: string; raw: string; selected: boolean; disabled: boolean; role: string; opensSubmenu: boolean; index: number; menuOf: string; testId: string; elId: string }> = [];
        let found: Element[];
        try {
          if (query.xpath) {
            const snap = document.evaluate(query.text, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            found = [];
            for (let i = 0; i < snap.snapshotLength; i += 1) {
              const node = snap.snapshotItem(i);
              if (node instanceof Element) found.push(node);
            }
          } else {
            found = Array.from(document.querySelectorAll(query.text));
          }
        } catch (e) {
          return { rows: out, error: String((e as Error)?.message ?? e) };
        }
        const counted = new Map<Element | null, number>();
        // A menu's key: what labels it (a submenu is labelled by the row that opens it), else a mark put
        // on it here, so a menu with no label is told apart from the others all the same.
        // (Written inline: a named function in here is wrapped by the bundler in a helper the page does not have.)
        const w = window as unknown as { __copMenus?: number };
        for (const el of found) {
          // A menu that is closed is still in the DOM, so visibility is what separates
          // what is on screen from what was on screen a moment ago.
          if ((el as HTMLElement).getClientRects().length === 0) continue;
          if (el.hasAttribute('data-cop-page')) continue;
          const menu = el.closest('[role="menu"],[role="listbox"]');
          const index = counted.get(menu) ?? 0;
          counted.set(menu, index + 1);
          if (menu && !menu.getAttribute('aria-labelledby') && !menu.getAttribute('data-cop-menu')) {
            w.__copMenus = (w.__copMenus ?? 0) + 1;
            menu.setAttribute('data-cop-menu', `cop-menu-${w.__copMenus}`);
          }
          const menuOf = menu ? (menu.getAttribute('aria-labelledby') || menu.getAttribute('data-cop-menu') || '') : '';
          // Marked, so the row can be pointed at in this page without its text.
          el.setAttribute('data-cop-row', `${menuOf}#${index}`);

          const raw = ((el as HTMLElement).innerText || '').trim();
          const label = el.getAttribute('aria-label')?.trim() ?? '';
          // The first line is the name; the description sits underneath it.
          const name = (raw.split('\n')[0] || label || '').trim();
          if (!name) continue;
          out.push({
            name,
            raw,
            selected: selectedAttrs.some((a) => el.getAttribute(a) === 'true'),
            disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'),
            role: el.getAttribute('role') ?? '',
            opensSubmenu: submenuAttrs.some((a) => {
              const v = el.getAttribute(a);
              return a === 'aria-haspopup' ? v === 'menu' || v === 'true' : v !== null;
            }),
            index,
            menuOf,
            testId: el.getAttribute('data-test-id') ?? el.getAttribute('data-testid') ?? '',
            elId: el.id ?? '',
          });
        }
        return { rows: out, error: '' };
      },
      {
        query: pageQuery(this.locators.rows),
        selectedAttrs: [...Model.selectedAttributes],
        submenuAttrs: [...Model.submenuAttributes],
      },
    );
    // Said once: the menu is read many times a choice (whether it is still open, among them).
    if (read.error && !this.rowsLocatorFailed) {
      this.rowsLocatorFailed = true;
      this.emit('model-rows-locator-failed', { locator: this.locators.rows, error: read.error });
    }
    return read.rows;
  }

  /** The rows of the top menu, read while only it is open: the menu its first row is in. */
  private topRows(rows: MenuRow[]): MenuRow[] {
    const key = rows[0]?.menuOf;
    return key === undefined ? [] : rows.filter((r) => r.menuOf === key);
  }

  /**
   * A group's row among the rows read: by its test id; else by the vendor its row names ("OpenAI"), which a choice
   * does not change; else by its text, as it reads or contains; else by its place.
   */
  private groupRowIn(shown: MenuRow[], group: { testId?: string; index: number; name: string; vendor?: string }): MenuRow | undefined {
    const groups = this.topRows(shown).filter((r) => r.opensSubmenu);
    return (
      (group.testId ? groups.find((r) => r.testId === group.testId) : undefined) ??
      (group.vendor ? groups.find((r) => vendorOf(r) && sameModel(vendorOf(r), group.vendor)) : undefined) ??
      groups.find((r) => sameModel(r.name, group.name)) ??
      groups.find((r) => containsModel(r.raw, group.name)) ??
      groups.find((r) => r.index === group.index)
    );
  }

  /** A group's row in the open menu, found where the list read it (see `groupRowIn`), as an element to press. */
  private async groupRowAt(group: { testId?: string; index: number; name: string; vendor?: string }): Promise<Locator | null> {
    const row = this.groupRowIn(await this.readMenuRows().catch(() => []), group);
    if (!row) return null;
    const el = this.p.locator(`[data-cop-row="${row.menuOf}#${row.index}"]`).first();
    return (await el.isVisible().catch(() => false)) ? el : null;
  }

  /**
   * Opens one group of the open picker and returns the key of its submenu (see `readMenuRows`), or null.
   * The group's row is found by its test id, else by its place among the top rows, else by its text. Its
   * submenu is the menu labelled by that row, or, in a build that does not label it, the menu that
   * appeared when the row was hovered.
   */
  private async openGroup(group: { testId?: string; index: number; name: string; vendor?: string }): Promise<string | null> {
    const shown = await this.readMenuRows();
    const row = this.groupRowIn(shown, group);
    if (!row) return null;
    const trigger = this.p.locator(`[data-cop-row="${row.menuOf}#${row.index}"]`).first();
    // Submenus already on screen are not this group's, whatever opened them; nor is one labelled by another group's row.
    const before = new Set(shown.filter((r) => r.menuOf !== row.menuOf).map((r) => r.menuOf));
    const others = new Set(this.topRows(shown).filter((r) => r.opensSubmenu && r.elId && r.elId !== row.elId).map((r) => r.elId));
    const opened = async (ms: number): Promise<string | null> => {
      const started = Date.now();
      do {
        const rows = (await this.readMenuRows()).filter((r) => r.menuOf !== row.menuOf);
        // The menu labelled by this group's row is its own; a build that labels none gets the one that
        // appeared, never one that was already there (2026-10-05: Claude's was taken for GPT's).
        if (row.elId && rows.some((r) => r.menuOf === row.elId)) return row.elId;
        const fresh = rows.find((r) => !before.has(r.menuOf) && r.menuOf !== row.elId && !others.has(r.menuOf));
        if (fresh && (!row.elId || Date.now() - started > 1_500)) return fresh.menuOf;
        await this.hold(200);
      } while (Date.now() - started < ms);
      return null;
    };
    /*
     * A click sent to the element itself first, as a choice opens a group (2026-10-06): the mouse goes to coordinates,
     * and on a menu that moves while it opens, a hover or a click meant for "GPT" opened "Claude" — read so, the list
     * had no GPT models, and a run had nowhere to look for them (2026-10-24). Then hover, then the mouse.
     */
    await trigger.evaluate((el) => (el as HTMLElement).click(), undefined, { timeout: 3_000 }).catch(() => undefined);
    const clicked = await opened(4_000);
    if (clicked) return clicked;
    await trigger.hover({ timeout: 3_000 }).catch(() => undefined);
    const hovered = await opened(4_000);
    if (hovered) return hovered;
    await trigger.click({ timeout: 3_000 }).catch(() => undefined);
    return await opened(4_000);
  }

  /** Opens a fresh menu, then the group, and reads what is in it. */
  private async readSubmenu(button: Locator, group: { testId?: string; index: number; name: string; vendor?: string }): Promise<MenuRow[]> {
    await this.pressPicker(button);
    if (!(await this.waitForPopup())) return [];
    await this.rowsShown();
    const key = await this.openGroup(group);
    const children = key ? (await this.readMenuRows()).filter((r) => r.menuOf === key) : [];
    await this.captureMenu(`group-${group.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40)}`, children);
    await this.closeMenu();
    return children;
  }

  /**
   * The visible row a locator finds for a text, waited for — an XPath of `Model`, or the operator's (an XPath or a CSS
   * selector): the one whose own first line is the text when several contain it ("Think deeper" is in "GPT-5.6 Sol
   * Think deeper" too), else the first.
   */
  private async rowBy(locator: string, text: string, waitMs: number): Promise<Locator | null> {
    const all = this.p.locator(playwrightSelector(locator));
    const deadline = Date.now() + waitMs;
    do {
      let first: Locator | null = null;
      const n = await all.count().catch(() => 0);
      for (let i = 0; i < n; i += 1) {
        const el = all.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const line = ((await el.innerText().catch(() => '')) ?? '').split('\n')[0]?.trim() ?? '';
        if (sameModel(line, text)) return el;
        if (!first || (!containsModel(await first.innerText().catch(() => ''), text) && containsModel(line, text))) first = el;
      }
      if (first) return first;
      await this.hold(200);
    } while (Date.now() < deadline);
    return null;
  }

  /**
   * Opens the picker, and the group when the model is in one, and finds the model's row by its text
   * (`Model.modelRowXPath`, `Model.groupRowXPath`). The menu is left open.
   */
  private async openToModel(name: string, group: string | undefined): Promise<{ row: Locator } | { problem: string }> {
    const button = await this.resolveModelButton();
    if (!button) return { problem: 'This chat does not show a model picker.' };
    await this.pressPicker(button);
    if (!(await this.waitForPopup())) return { problem: 'The model picker did not open.' };
    if (group) {
      const trigger = await this.rowBy(`${Model.groupRowXPath(group)} | ${Model.groupRowByAllText(group)}`, group, 4_000);
      if (!trigger) return { problem: `the picker has no "${group}" group.` };
      // Hover is how these open; a click on it is the fallback.
      await trigger.hover({ timeout: 3_000 }).catch(() => undefined);
      let row = await this.rowBy(`${Model.modelRowXPath(name)} | ${Model.modelRowByAllText(name)}`, name, 4_000);
      if (!row) {
        await this.press(trigger).catch(() => undefined);
        row = await this.rowBy(`${Model.modelRowXPath(name)} | ${Model.modelRowByAllText(name)}`, name, 4_000);
      }
      return row ? { row } : { problem: `"${name}" is not in the "${group}" group.` };
    }
    const row = await this.rowBy(`${Model.modelRowXPath(name)} | ${Model.modelRowByAllText(name)}`, name, 4_000);
    return row ? { row } : { problem: `"${name}" is not in the picker.` };
  }

  /**
   * Chooses a model by its text and reads its row again from a fresh menu: chosen only when the row
   * itself is marked (`aria-checked`). The button's text is no proof — it is shortened, and it is the
   * same for a model and its group.
   */
  private async chooseAt(name: string, locator: ModelLocator): Promise<ModelChoice> {
    const group = locator.group?.name;
    const before = await this.currentModel();
    const found = await this.openToModel(name, group);
    if ('problem' in found) {
      await this.closeMenu();
      return { ok: false, current: before, reason: found.problem };
    }
    const mark = async (row: Locator): Promise<{ checked: boolean; disabled: boolean }> => ({
      checked: (await row.getAttribute('aria-checked').catch(() => null)) === 'true',
      disabled: (await row.getAttribute('aria-disabled').catch(() => null)) === 'true',
    });
    const now = await mark(found.row);
    if (now.disabled) {
      await this.closeMenu();
      return { ok: false, current: before, reason: `"${name}" is shown but not available right now.` };
    }
    if (now.checked) {
      await this.closeMenu();
      this.emit('model-already-selected', { model: name, buttonShows: before, by: 'locator' });
      return { ok: true, current: name, by: 'locator' };
    }
    await this.press(found.row).catch(() => undefined);
    await this.hold(800);
    // Whatever the click did, the menu is not left open over the chat.
    await this.closeMenu();
    const again = await this.openToModel(name, group);
    const checked = 'row' in again ? (await mark(again.row)).checked : false;
    await this.closeMenu();
    const after = await this.currentModel();
    if (checked) {
      this.emit('model-selected', { model: name, buttonShows: after, by: 'locator' });
      return { ok: true, current: name, by: 'locator' };
    }
    return {
      ok: false,
      current: after,
      reason: 'problem' in again ? `after choosing "${name}", ${again.problem}` : `"${name}" was clicked, but the picker does not mark it as chosen (the button shows "${after ?? 'nothing'}").`,
    };
  }

  /**
   * Chooses a model by the operator's own locators (`templateTarget`): the picker button, then the model; for a model
   * in a provider's menu, the provider first, then — once its models are on screen — the model. The choice counts
   * only when the model's row is marked chosen, read again the same way.
   *
   * A locator that finds nothing at all, after the whole wait of the first attempt, is not tried five times more
   * (2026-10-24): it is the locator, not the page being slow, and the ways that do not need it are tried at once. A
   * provider's row its locator does not find is looked for where the list read it (its test id, its vendor, its
   * place): its row reads the model chosen in it, once one is (2026-10-05), and its name is then not on it.
   */
  private async chooseByOperatorLocators(name: string, target: OperatorTarget): Promise<ModelChoice> {
    const before = await this.currentModel();
    // What was looked for, for the record kept when nothing worked (models-select-failed.json).
    const tried: Array<{ what: string; locator: string }> = [
      ...(target.group ? [{ what: 'provider', locator: target.group.locator }] : []),
      { what: target.kind, locator: target.locator },
    ];
    const keepFailure = async (): Promise<void> => {
      const found = await Promise.all(tried.map(async (x) => ({ ...x, found: await this.p.locator(playwrightSelector(x.locator)).count().catch((e: unknown) => `not usable: ${(e as Error).message.split('\n')[0]}`) })));
      await this.captureMenu('select-failed', await this.readMenuRows().catch(() => []), { asked: name, locators: found }).catch(() => undefined);
    };
    const textOf = async (el: Locator): Promise<string> => (((await el.innerText().catch(() => '')) ?? '').split('\n')[0] ?? '').trim();
    // A fixed pause after every opening and every press (see `ModelPicking`); the checks give it less.
    const settle = (): Promise<void> => this.hold(this.opts.modelSettleMs ?? ModelPicking.settleMs);
    const pause = this.opts.modelBeforePressMs ?? ModelPicking.beforePressMs;
    const poll = this.opts.modelPollMs ?? ModelPicking.pollMs;
    const appear = this.opts.modelAppearMs ?? ModelPicking.appearMs;
    let shot = 0;
    /** With `modelStepShots`, a picture and the menu's HTML at each step, numbered, beside the transport's files. */
    const picture = async (label: string): Promise<void> => {
      if (!this.stepShots) return;
      shot += 1;
      await this.captureMenu(`step-${String(shot).padStart(2, '0')}-${label.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40)}`, await this.readMenuRows().catch(() => [])).catch(() => undefined);
    };
    /*
     * The operator's rhythm for every element of the picker (2026-10-06): look for it; while it is not
     * there, wait two seconds and look again; once it is there, wait two seconds more, then press it.
     * Each look and each pause is in the record with its time, so the pauses can be seen.
     */
    const waitThenFind = async (label: string, find: () => Promise<Locator | null>): Promise<Locator | null> => {
      const deadline = Date.now() + appear;
      let looks = 1;
      let el = await find();
      while (!el && Date.now() < deadline) {
        this.emit('model-step', { step: 'not there yet, waiting', what: label, look: looks, waitMs: poll });
        await this.hold(poll);
        looks += 1;
        el = await find();
      }
      if (!el) {
        this.emit('model-step', { step: 'never appeared', what: label, looks });
        return null;
      }
      this.emit('model-step', { step: 'there, pausing before the press', what: label, look: looks, text: await textOf(el), pauseMs: pause });
      await this.hold(pause);
      await picture(`before-${label}`);
      return el;
    };
    const visible = async (el: Locator | null): Promise<Locator | null> => (el && (await el.isVisible().catch(() => false)) ? el : null);
    /** The provider's row: by its locator, else where the list read it (see above). */
    const providerRow = async (): Promise<Locator | null> => {
      const g = target.group!;
      const byLocator = await this.rowBy(g.locator, g.name, 0);
      if (byLocator) return byLocator;
      const atPlace = await this.groupRowAt(g.at);
      /*
       * Said of the locator only when its row is in the menu under the very name it was filled with (2026-11-24): the
       * row of a provider reads the model chosen in it, and its name is then not there for any locator to find.
       */
      if (atPlace && sameModel(await textOf(atPlace), g.name) && !(await this.rowBy(g.locator, g.name, 500))) {
        await this.pickerMissing('provider', `the row "${g.name}" is in the model menu, and the provider's locator filled with it finds nothing (${g.locator})`);
      }
      if (atPlace) this.emit('model-step', { step: 'provider found where the list read it, not by its locator', provider: g.name, locator: g.locator });
      return atPlace;
    };
    /**
     * A template that does not find its model: said of the locator only when the model is in the menu, as the rows read
     * it — not when the page does not offer it any more, or under another name, which no locator can help.
     */
    const templateMissed = async (rows: MenuRow[]): Promise<void> => {
      if (!rows.some((r) => !r.opensSubmenu && sameModel(r.name, target.model))) return;
      const where = target.group ? `the menu of "${target.group.name}"` : 'the model menu';
      await this.pickerMissing(target.kind, `"${target.model}" is in ${where}, and the locator filled with it finds nothing (${target.locator})`);
    };
    /** `missing`: what was looked for first was never there, whatever the wait — the locator finds nothing. */
    const reach = async (): Promise<{ row: Locator } | { problem: string; missing?: boolean }> => {
      const button = await waitThenFind('the picker button', async () => visible(await this.resolveModelButton(1_000)));
      if (!button) return { problem: 'This chat does not show a model picker.' };
      await this.pressPicker(button, 5_000).catch(() => undefined);
      await settle();
      if (!(await this.waitForPopup())) return { problem: 'The model picker did not open.' };
      this.emit('model-step', { step: 'picker opened' });
      if (target.group) {
        const group = await waitThenFind(`the "${target.group.name}" provider`, providerRow);
        if (!group) {
          await keepFailure();
          return { problem: `the "${target.group.name}" row was not found by the provider's locator (${target.group.locator}), nor where the list read it; the menu is kept as models-select-failed.html/.png`, missing: true };
        }
        /*
         * Opened without the mouse first: a mouse click goes to coordinates, and the picker moves while it
         * opens, so on the work machine a press meant for "GPT" (now second) opened "Claude" (now first)
         * (2026-10-06). A click sent to the element itself cannot land on another row; then the keyboard
         * (focus, ArrowRight opens a submenu); the mouse only last. Each time, its model must appear.
         */
        const ways: Array<[string, () => Promise<void>]> = [
          ['click on the element', async () => { await group.evaluate((el) => (el as HTMLElement).click(), undefined, { timeout: 3_000 }); }],
          ['keyboard', async () => { await group.focus({ timeout: 3_000 }); await this.p.keyboard.press('ArrowRight'); }],
          ['hover', async () => { await group.hover({ timeout: 3_000 }); }],
          ['mouse click', async () => { await group.click({ timeout: 3_000 }); }],
        ];
        for (const [how, act] of ways) {
          await act().catch(() => undefined);
          await settle();
          const row = await waitThenFind(`"${target.model}"`, () => this.rowBy(target.locator, name, 0));
          if (row) {
            this.emit('model-step', { step: 'group opened', how, model: await textOf(row) });
            return { row };
          }
          // Its menu is open and the model's locator finds nothing in it, after the whole wait: the locator's doing.
          const shownNow = await this.readMenuRows().catch(() => []);
          if (shownNow.some((r) => r.menuOf !== shownNow[0]?.menuOf)) {
            this.emit('model-step', { step: "provider's menu open, the model's locator finds nothing in it", how, locator: target.locator });
            await keepFailure();
            await templateMissed(shownNow.filter((r) => r.menuOf !== shownNow[0]?.menuOf));
            return { problem: `"${target.model}" was not found in the "${target.group.name}" menu by the locator for a model in a provider's menu (${target.locator}); the menu is kept as models-select-failed.html/.png`, missing: true };
          }
          this.emit('model-step', { step: 'group not opened', how });
          await this.hold(pause);
        }
        await keepFailure();
        return { problem: `"${target.model}" did not appear after opening "${target.group.name}" every way (the locator for a model in a provider's menu: ${target.locator}); the menu is kept as models-select-failed.html/.png` };
      }
      const row = await waitThenFind(`"${target.model}"`, () => this.rowBy(target.locator, name, 0));
      if (!row) {
        await keepFailure();
        await templateMissed(this.topRows(await this.readMenuRows().catch(() => [])));
        return { problem: `"${target.model}" was not found by the locator for a model of the main menu (${target.locator}); the menu is kept as models-select-failed.html/.png`, missing: true };
      }
      return { row };
    };
    /*
     * A model in a group, by the keyboard (operator's choice, 2026-10-06: the submenu failed when it was
     * expanded by click or hover). The picker opened, the group's row is focused, ArrowRight opens its
     * submenu and puts the focus in it, ArrowDown moves the focus until it is on the model — read from the
     * focused row's own text — and Enter chooses it. No hover, no coordinates.
     */
    const byKeyboard = async (attempt: number): Promise<boolean> => {
      if (!target.group) return false;
      const button = await waitThenFind('the picker button', async () => visible(await this.resolveModelButton(1_000)));
      if (!button) return false;
      await this.pressPicker(button, 5_000).catch(() => undefined);
      await settle();
      if (!(await this.waitForPopup())) return false;
      const group = await waitThenFind(`the "${target.group.name}" provider`, providerRow);
      if (!group) {
        await this.closeMenu();
        return false;
      }
      await group.focus({ timeout: 3_000 }).catch(() => undefined);
      await this.p.keyboard.press('ArrowRight');
      this.emit('model-step', { step: 'group opened by the keyboard (ArrowRight)', attempt });
      await settle();
      // A model's row, which is a menuitemradio or, since 2026-10-23, a menuitem that opens nothing (`Model.modelRowCss`).
      const focused = (): Promise<{ text: string; radio: boolean }> =>
        this.p.evaluate((modelRow) => {
          const el = document.activeElement as HTMLElement | null;
          const row = el?.closest('[role="menuitemradio"],[role="menuitem"]') as HTMLElement | null;
          return { text: (row?.innerText ?? '').trim(), radio: !!el?.closest(modelRow) };
        }, Model.modelRowCss);
      for (let presses = 0; presses < 12; presses += 1) {
        const now = await focused();
        const line = now.text.split('\n')[0]?.trim() ?? '';
        // The chosen model's own name: "Sonnet" alone would stop at "Sonnet 5.5" when "Sonnet 5" is asked for.
        if (now.radio && (sameModel(line, name) || containsModel(now.text, name))) {
          this.emit('model-step', { step: 'model reached by the keyboard, pausing before Enter', attempt, text: line, presses, pauseMs: pause });
          await this.hold(pause);
          await picture('before-enter');
          await this.p.keyboard.press('Enter');
          await settle();
          return true;
        }
        await this.p.keyboard.press('ArrowDown');
        await this.hold(400);
      }
      this.emit('model-step', { step: 'model not reached by the keyboard', attempt });
      await this.closeMenu();
      await settle();
      return false;
    };
    const checked = async (row: Locator): Promise<boolean> => (await row.getAttribute('aria-checked').catch(() => null)) === 'true';

    /*
     * The whole choice, tried again from a closed menu while the picker does not show the model as chosen,
     * up to `ModelPicking.attempts` times (operator's request, 2026-10-06: "if it is not set, try again").
     */
    const attempts = this.opts.modelAttempts ?? ModelPicking.attempts;
    let why = '';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      this.emit('model-step', { step: 'attempt', attempt, of: attempts, model: name });
      const found = await reach();
      if ('problem' in found) {
        why = found.problem;
        this.emit('model-step', { step: 'not reached', attempt, why });
        await this.closeMenu();
        await settle();
        // The locator finds nothing: the other ways are tried now, not after five more attempts with it.
        if (found.missing) {
          this.emit('model-step', { step: 'the locator finds nothing; the other ways now', attempt });
          return { ok: false, current: await this.currentModel(), reason: why };
        }
        /*
         * The keyboard only when the clicks did not get there. Tried first on 2026-10-06, the live page did
         * not move the focus into the submenu (2026-10-07: "model not reached by the keyboard", 6.5 s lost),
         * while a click on the group's element opened it and the model was chosen at the first attempt.
         */
        if (target.group && (await byKeyboard(attempt))) {
          await this.closeMenu();
          await settle();
          const shownNow = await this.currentModel();
          if (buttonShows(shownNow, name)) {
            this.emit('model-selected', { model: name, buttonShows: shownNow, by: 'operator', attempt, seenOn: 'button', how: 'keyboard' });
            return { ok: true, current: name, by: 'operator' };
          }
        }
        continue;
      }
      if (await checked(found.row)) {
        await this.closeMenu();
        this.emit('model-already-selected', { model: name, buttonShows: before, by: 'operator', attempt });
        return { ok: true, current: name, by: 'operator' };
      }
      // The names in the model's own menu, read before the press closes it: what a shortened button may mean.
      const siblings: string[] = await found.row
        .evaluate((el, modelRow) =>
          Array.from(el.closest('[role="menu"],[role="listbox"]')?.querySelectorAll(modelRow) ?? []).map((r) => ((r as HTMLElement).innerText || '').split('\n')[0]!.trim()),
          Model.modelRowCss,
        )
        .catch(() => [] as string[]);
      // On the element itself, for the same reason as the group; the mouse only when that does nothing.
      this.emit('model-step', { step: 'model pressed', attempt, text: await textOf(found.row) });
      await found.row.evaluate((el) => (el as HTMLElement).click(), undefined, { timeout: 3_000 }).catch(() => undefined);
      await settle();
      if ((await this.modelMenuOpen()) && !(await checked(found.row))) {
        await this.hold(pause);
        await found.row.click({ timeout: 3_000 }).catch(() => undefined);
        await settle();
      }
      await picture('after-press');
      await this.closeMenu();
      await settle();
      /*
       * Is it set? The picker button first: it shows the model in force, shortened by words dropped from
       * its end, and reading it opens nothing. The menu was opened again to read the row's mark, and at
       * work that second walk failed with the right model chosen (2026-10-06); it is now only the second
       * witness, when the button does not show the model. Nothing here reloads the page: a choice not
       * set is made again from the button, in the same page.
       */
      const shownNow = await this.currentModel();
      // The whole name, or a shortened one that no other model of the same menu reads as ("Sonnet" is both Sonnets).
      const alsoMeant = siblings.filter((n) => !sameModel(n, name) && buttonShows(shownNow, n));
      if (sameModel(shownNow, name) || (buttonShows(shownNow, name) && alsoMeant.length === 0)) {
        this.emit('model-selected', { model: name, buttonShows: shownNow, by: 'operator', attempt, seenOn: 'button' });
        return { ok: true, current: name, by: 'operator' };
      }
      const again = await reach();
      const ok = 'row' in again && (await checked(again.row));
      await this.closeMenu();
      const after = await this.currentModel();
      if (ok) {
        this.emit('model-selected', { model: name, buttonShows: after, by: 'operator', attempt, seenOn: 'menu' });
        return { ok: true, current: name, by: 'operator' };
      }
      why = 'problem' in again ? `after pressing "${target.model}": ${again.problem}` : `"${target.model}" was pressed, but the picker does not mark it as chosen (the button shows "${after ?? 'nothing'}")`;
      this.emit('model-step', { step: 'not set, trying again', attempt, why });
      await settle();
    }
    return { ok: false, current: await this.currentModel(), reason: `not chosen after ${attempts} attempts: ${why}` };
  }

  /**
   * Whether the model picker is open: its button says so (`aria-expanded`), or its rows are on screen.
   * Both, because either alone has been wrong: rows can be mid-animation after the menu closed, and a
   * button re-rendered by the page can lose the attribute while the menu is still up.
   */
  private async modelMenuOpen(): Promise<boolean> {
    const button = await this.resolveModelButton(1_000);
    const expanded = button ? await button.getAttribute('aria-expanded').catch(() => null) : null;
    if (expanded === 'true') return true;
    return (await this.readMenuRows()).length > 0;
  }

  /**
   * Closes the picker, submenu included, and makes sure it is closed.
   *
   * Escape pressed on the page was all this did, three times, and then it gave up without a word.
   * Live, that left the model list open over the chat after a check of the model: Escape goes to
   * whatever has focus, and after a click dispatched on a row, or no click at all because the model
   * was already chosen, focus was not in the menu, so nothing heard it. Each way a person would close
   * it is tried in turn, and the menu is looked at after each: Escape; Escape sent to the menu itself;
   * the picker button again (it toggles); a click outside the menu, in the composer, which a Fluent
   * popup takes as "close". A menu still open after all of them is reported, not passed over.
   */
  private async closeMenu(): Promise<void> {
    const ways: Array<[string, () => Promise<void>]> = [
      ['escape', async () => await this.p.keyboard.press('Escape')],
      [
        'escape in the menu',
        async () => {
          for (const selector of Model.popupSelectors.slice(0, 2)) {
            const menu = this.p.locator(`${selector}:visible`).last();
            if ((await menu.count()) > 0) {
              await menu.press('Escape', { timeout: 2_000 });
              return;
            }
          }
        },
      ],
      [
        'the picker button',
        async () => {
          const button = await this.resolveModelButton(1_000);
          // Only while the button itself says the menu is open: clicking it otherwise would open it.
          if (button && (await button.getAttribute('aria-expanded').catch(() => null)) === 'true') await button.click({ timeout: 3_000 });
        },
      ],
      [
        'a click outside',
        async () => {
          const composer = this.composer();
          if ((await composer.count().catch(() => 0)) > 0 && (await composer.isVisible().catch(() => false))) await composer.click({ timeout: 3_000 });
          else await this.p.mouse.click(4, 4);
        },
      ],
    ];
    for (const [how, act] of ways) {
      if (!(await this.modelMenuOpen())) return;
      await act().catch(() => undefined);
      await this.hold(250);
      if (!(await this.modelMenuOpen())) {
        if (how !== 'escape') this.emit('model-menu-closed', { how });
        return;
      }
    }
    if (await this.modelMenuOpen()) this.emit('model-menu-stuck', { tried: ways.map(([how]) => how) });
  }

  /** The first popup container that becomes visible after the picker is clicked. */
  private async waitForPopup(timeoutMs = 8_000): Promise<Locator | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of Model.popupSelectors) {
        const candidate = this.p.locator(`${selector}:not([data-cop-page])`);
        const n = await candidate.count().catch(() => 0);
        for (let i = 0; i < n; i += 1) {
          const one = candidate.nth(i);
          if (await one.isVisible().catch(() => false)) return one;
        }
      }
      await this.hold(250);
    }
    /*
     * No menu of a kind known here, and rows that were not on the page before (2026-11-24): the rows' locator, which the
     * operator can write, finds the menu whatever it is made of; before, no locator in Settings could.
     */
    const row = (await this.readMenuRows().catch(() => []))[0];
    return row ? this.p.locator(`[data-cop-row="${row.menuOf}#${row.index}"]`).first() : null;
  }

  /**
   * Sets the chat to a model.
   *
   * With a `locator` from the list the operator read (see `listModels`), the row is gone to directly.
   * Without one, or when the page moved it, the line-up is read again with fresh locators and the model
   * is found there by name — or under its new name when the page renamed it (see `modelMatch.ts`). The
   * choice counts only when the picker marks the row as chosen, read again from a fresh menu, because a
   * menu item that is out of quota can look clicked and change nothing; when it did not take, the
   * caller is told what the chat is actually on.
   */
  async selectModel(name: string, opts: { locator?: ModelLocator; signal?: AbortSignal } = {}): Promise<ModelChoice> {
    if (opts.signal?.aborted) return { ok: false, current: null, reason: 'stopped by the operator' };
    this.stop = opts.signal ?? null;
    try {
      return await this.chooseModel(name, opts);
    } catch (e) {
      if (!(e instanceof StoppedByOperator)) throw e;
      this.stop = null;
      this.emit('model-step', { step: 'stopped by the operator', model: name });
      await this.closeMenu().catch(() => undefined);
      return { ok: false, current: await this.currentModel().catch(() => null), reason: 'stopped by the operator' };
    } finally {
      this.stop = null;
    }
  }

  private async chooseModel(name: string, opts: { locator?: ModelLocator }): Promise<ModelChoice> {
    const button = await this.resolveModelButton();
    if (!button) {
      await this.pickerMissing('button', `the model button was not on the page when "${name}" was to be chosen`);
      return { ok: false, current: null, reason: 'This chat does not show a model picker.' };
    }

    /*
     * Looked at before anything is opened: a conversation the run comes back to is usually on its model
     * already, and choosing it again was a menu walk for nothing (operator's request, 2026-10-06). The
     * button shows the model, shortened by words dropped from its end ("GPT-5.6 Sol Think"), and
     * `buttonShows` takes only that, so "Think deeper" is never taken for "GPT-5.6 Sol Think deeper".
     */
    const shown = await this.currentModel();
    /*
     * Only the whole name: the button shortens a grouped model by its last word, and the live Claude group
     * has "Sonnet 5.5" and "Sonnet 5", both "Sonnet" on the button (2026-10-07). A shortened name is looked
     * at in the menu instead, where the row's own mark says it, and nothing is pressed when it is chosen.
     */
    if (sameModel(shown, name)) {
      this.emit('model-already-selected', { model: name, buttonShows: shown, by: 'button' });
      return { ok: true, current: name, by: 'already' };
    }

    this.sayLocatorProblems();
    /*
     * The operator's own locators first (2026-10-24): the templates in force, filled for this model from where the
     * list read it — the saved list's place, else the place a fresh reading finds — each place tried once.
     */
    const tried = new Set<string>();
    const byTemplates = async (model: string, place: ModelLocator): Promise<ModelChoice | null> => {
      const target = templateTarget(model, place, this.locators);
      if (!target) return null;
      const key = `${target.group?.locator ?? ''}|${target.locator}`;
      if (tried.has(key)) return null;
      tried.add(key);
      return await this.chooseByOperatorLocators(model, target);
    };
    let first: ModelChoice | null = null;
    if (opts.locator) {
      first = await byTemplates(name, opts.locator);
      if (first?.ok) return first;
      const second = await this.chooseAt(name, opts.locator);
      if (second.ok) return { ...second, ...(first?.reason ? { locatorMiss: first.reason } : {}) };
      first = first ?? second;
    }

    // The line-up as the page shows it now, each model with its place in it. A Stop pressed while it is read stops.
    const read = await this.listModels().catch((e: unknown) => {
      if (e instanceof StoppedByOperator) throw e;
      return null;
    });
    const options = read?.options ?? [];
    const match = options.find((o) => sameModel(o.name, name)) ?? pageModelFor(name, options);
    const which = (): string => (tried.size > 0 ? "by the operator's locators" : 'at the saved place');
    if (!match?.locator) {
      const offered = options.filter((o) => !o.disabled).map((o) => o.name);
      return {
        ok: false,
        current: await this.currentModel(),
        reason:
          `The picker does not offer "${name}" any more${offered.length > 0 ? `; it offers ${offered.map((o) => `"${o}"`).join(', ')}` : ''}.` +
          (first?.reason ? ` (${which().replace(/^./, (c) => c.toUpperCase())}: ${first.reason})` : ''),
        ...(options.length > 0 ? { options } : {}),
      };
    }
    // Where the list has just read it: its provider and its name as the page shows them now.
    const fresh = await byTemplates(match.name, match.locator);
    if (fresh?.ok) return { ...fresh, ...(!sameModel(match.name, name) ? { matched: match.name } : {}), ...(first?.reason ? { locatorMiss: first.reason } : {}), options };
    if (fresh && !first) first = fresh;
    const chosen = await this.chooseAt(match.name, match.locator);
    return {
      ...chosen,
      // When both ways failed, why the operator's locators did is said too: that is the one to fix.
      ...(!chosen.ok && first?.reason ? { reason: `${chosen.reason ?? 'not chosen'} (${which()}: ${first.reason})` } : {}),
      ...(chosen.ok && !sameModel(match.name, name) ? { matched: match.name } : {}),
      ...(chosen.ok ? { by: opts.locator ? 'reread' : 'name' } : {}),
      // Why the saved locator missed, kept: what to look at when the page has changed.
      ...(first && !first.ok && first.reason ? { locatorMiss: first.reason } : {}),
      options,
    };
  }

  /**
   * How many messages the conversation holds — not how many the page has rendered.
   *
   * Copilot virtualises a long conversation: a saved page of a 48-message chat held four turn
   * elements, each carrying `aria-setsize="48"`. Acceptance and reply detection used to be
   * "the number of turn elements went up", which stops being true the moment the window is
   * full. After re-entering a long chat for the third task of a session, a findings message
   * landed — twice, and drew a reply — and was declared "not accepted", and the task failed.
   * The app says the real size itself, in the accessibility attribute; that is what is
   * counted, with the rendered count as the fallback for a page that does not carry it.
   */
  private async turnCount(): Promise<number> {
    // By the `turn` locator in force (2026-11-17), whatever its kind: CSS, XPath or Playwright's own.
    return await this.el('turn').evaluateAll((nodes: Element[]) => {
      let size = 0;
      for (const n of nodes) {
        const carrier = n.matches('[aria-setsize]') ? n : (n.querySelector('[aria-setsize]') ?? n.closest('[aria-setsize]'));
        const v = carrier ? Number(carrier.getAttribute('aria-setsize')) : NaN;
        if (!Number.isNaN(v) && v > size) size = v;
      }
      return size > 0 ? size : nodes.length;
    });
  }

  /** The newest user message as shown, for telling "landed but not counted" from "not sent". */
  private async lastUserTurnText(): Promise<string> {
    const all = this.el('userMessage');
    const n = await all.count().catch(() => 0);
    return n > 0 ? ((await all.nth(n - 1).innerText({ timeout: 2_000 }).catch(() => '')) ?? '') : '';
  }

  /** Puts text in the composer and clicks Send. Enter is not used: it does not submit. */
  async send(text: string, attachments: string[] = []): Promise<void> {
    if (text.trim().length === 0) {
      throw new Error('Refusing to send an empty message: the composer requires text.');
    }
    await this.clearBlockers();
    await this.runSteps('message');
    const refused = attachments.length > 0 ? await this.attach(attachments) : [];
    // A file Copilot would not take, after its tries: its text goes in the message itself, said as such.
    if (refused.length > 0) text = await this.withRefusedFiles(text, refused);

    const composer = this.composer();
    // The box, before it is clicked: none, its locator is said, rather than a minute's wait on the click.
    if (!(await this.composerWithin(10_000, undefined, ''))) throw await this.locatorMissing('composer', 'when a message was to be written in it');
    await composer.click();
    await composer.fill(text);

    const send = await this.sendButton();
    await send.waitFor({ state: 'visible', timeout: this.sendWaitMs }).catch(async (e: unknown) => {
      if ((e as Error).name !== 'TimeoutError') throw e;
      throw await this.locatorMissing('send', `after the message was written in the box, within ${Math.round(this.sendWaitMs / 1000)} s`);
    });
    await send.click();
    this.emit('message-sent', { chars: text.length, attachments: attachments.length });
  }

  /**
   * The composer's own Send button, and nothing else called Send.
   *
   * Asking the page for "the button named Send" used to be enough. It is not: the Office
   * feedback panel brings its own, and the moment it opens the lookup matches two elements and
   * the run dies on a strict mode violation. So the search is scoped to the composer, with two
   * fallbacks that narrow by a different signal each time, because the thing most likely to
   * change here is the attribute name rather than the button.
   */
  private async sendButton(): Promise<Locator> {
    // Settings' own; or the default — the Send in the box's wrapper — wherever the wrapper is on the page.
    if (this.chatLocators.send !== DefaultChatLocators.send || (await this.p.locator(Css.composerWrapper).count()) > 0) {
      return this.el('send').first();
    }

    const submit = this.p.locator(Css.composerSendSubmit);
    if ((await submit.count()) > 0) {
      this.emit('send-button-wrapper-missing', { using: Css.composerSendSubmit });
      return submit.first();
    }

    // Last resort, and `.first()` rather than a bare locator: an unscoped match that finds two
    // buttons should pick one and carry on, not end the run.
    this.emit('send-button-unscoped');
    return this.p.getByRole('button', { name: Label.send, exact: true }).first();
  }

  /**
   * Closes the Office feedback panel if it has appeared over the chat.
   *
   * Escape and nothing else. The panel's own controls send an opinion from the operator's
   * account, and a program that has no opinion must not be the thing that submits one. If
   * Escape does not clear it, that is said out loud and the run carries on: the Send button is
   * scoped now, so the panel being open is untidy rather than fatal.
   */
  private async dismissFeedbackPanel(): Promise<void> {
    if (!this.builtIn.feedbackPanel) return;
    const panel = this.p.locator(Css.feedbackPanel);
    if ((await panel.count()) === 0) return;
    this.emit('feedback-panel-open');
    await this.p.keyboard.press('Escape').catch(() => undefined);
    await this.p.waitForTimeout(500);
    if ((await panel.count()) > 0) this.emit('feedback-panel-stuck');
    else this.emit('feedback-panel-dismissed');
  }

  /**
   * Sends and confirms the message was actually accepted.
   *
   * Clicking Send is not the same as the message arriving. A rejected request leaves the
   * text sitting in the composer and shows an error banner, and the old code then waited
   * fifteen minutes for a reply that could never come. Acceptance is defined as the turn
   * count going up, which is the only thing that really means "the chat took it".
   *
   * On a verification challenge the human clears it and the message is sent again, because
   * the rejected one was never delivered. The bot does not attempt the challenge itself.
   */
  async sendAndConfirm(text: string, attachments: string[] = [], maxAttempts = 3): Promise<number> {
    let lastProblem = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const before = await this.turnCount();
      const shownBefore = await this.lastUserTurnText();
      // A retry after a message that did land would put it in the chat twice — which is
      // exactly what happened before the size was read from the app. Look first.
      if (attempt > 1 && landed(text, shownBefore, this.retryBaseline)) {
        this.emit('send-landed-after-all', { attempt });
        return this.retryBaselineTurns;
      }
      if (attempt === 1) {
        this.retryBaseline = shownBefore;
        this.retryBaselineTurns = before;
      }
      await this.send(text, attachments);

      const accepted = await this.waitForAccepted(before, this.acceptMs, text, shownBefore);
      if (accepted) return before;

      const found = await this.detectBlocker();
      lastProblem = found.kind === 'none' ? 'the message did not appear in the chat' : `${found.kind}: ${found.reason}`;
      this.emit('send-not-accepted', { attempt, problem: lastProblem });
      /*
       * Sent — the box is empty — and neither a message of the conversation nor the one sent is found: the locators, not
       * the chat (2026-11-17). Said, and not sent again: a message that did land would be in the chat twice.
       */
      if (
        found.kind === 'none' &&
        (await this.boxIsEmpty()) &&
        (await this.el('turn').count().catch(() => 0)) === 0 &&
        (await this.el('userMessage').count().catch(() => 0)) === 0
      ) {
        throw await this.locatorMissing('turn', "after a message was sent: the box emptied, and neither the conversation's messages nor the message sent were found (the userMessage locator found nothing either)");
      }

      if (found.kind !== 'none') {
        const cleared = await this.handleBlocker(found);
        if (!cleared) {
          throw new SendRejectedError(
            `The chat is blocking messages (${lastProblem}) and it was not cleared in time. ` +
              'If this is a human-verification challenge, complete it in the Edge window and run again.',
          );
        }
      }
      // Clear whatever is left in the composer before trying again.
      await this.composer().fill('').catch(() => undefined);
      await this.p.waitForTimeout(2_000);
    }

    throw new SendRejectedError(
      `The chat did not accept the message after ${maxAttempts} attempts (${lastProblem}).`,
    );
  }

  /** What the newest user message said before the first attempt, for the retry check. */
  private retryBaseline = '';
  private retryBaselineTurns = 0;

  /**
   * True once the chat really took the message: the conversation grew, or the newest user
   * message is now the one that was sent. Two signals, because the first is what the app
   * reports and the second is what a person would look at.
   */
  private async waitForAccepted(previousTurns: number, timeoutMs: number, text: string, shownBefore: string): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.p.isClosed()) return false;
      const now = await this.turnCount().catch(() => previousTurns);
      if (now > previousTurns) return true;
      if (landed(text, await this.lastUserTurnText(), shownBefore)) return true;
      const found = await this.detectBlocker();
      if (found.kind !== 'none') return false;
      await this.p.waitForTimeout(1_000);
    }
    return false;
  }

  /**
   * Uploads files through the hidden input the composer keeps in the DOM, so no native
   * Windows file dialog is ever involved. Waits until each chip's id carries the `SPO_`
   * prefix, which is the signal that the upload actually finished.
   */
  async attach(paths: string[]): Promise<string[]> {
    const refused: string[] = [];
    /*
     * By the chat's locators in force (2026-11-17: the work page showed the attached file as a card of its own, and the
     * old `div.fx-Attachment[aria-label=<name>]`, written in the code, waited two minutes and ended the message with
     * Playwright's own words). Each can be set in Settings → "The chat's locators" → "Attaching a file"; one that finds
     * nothing is said by its name, with the page's HTML, like the others.
     */
    const input = this.el('uploadInput').first();
    const there = await input.waitFor({ state: 'attached', timeout: this.inputWaitMs }).then(() => true, () => false);
    if (!there) throw await this.locatorMissing('uploadInput', 'when a file was to be attached to the message');
    await input.setInputFiles(paths);
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop() as string;
      const shown = await this.fileEl('attachment', path)
        .filter({ visible: true })
        .first()
        .waitFor({ state: 'visible', timeout: this.attachWaitMs })
        .then(() => true, (e: unknown) => {
          if ((e as Error).name !== 'TimeoutError') throw e;
          return false;
        });
      if (!shown) {
        throw await this.locatorMissing('attachment', `after the file ${name} was put in the box's file input, within ${Math.round(this.attachWaitMs / 1000)} s`);
      }
      // Uploaded: the locator finds it, and goes on finding it for a moment (a spinner can come a little after the card).
      const uploaded = await this.uploadOrRefusal(path);
      if (uploaded === 'refused') {
        refused.push(path);
        this.emit('attached', { name });
        continue;
      }
      if (!uploaded) {
        // As before: the message goes on (Send waits while it cannot be pressed); what found nothing is said once a window.
        this.emit('attachment-upload-unconfirmed', { name });
        if (!this.warned.has('attachmentUploaded')) {
          this.warned.add('attachmentUploaded');
          await this.locatorMissing('attachmentUploaded', `for ${Math.round(this.uploadWaitMs / 1000)} s after the file ${name} was attached`, { stopped: false, file: path }).catch(() => undefined);
        }
      }
      this.emit('attached', { name, ...(uploaded ? { uploaded: true } : {}) });
    }
    return refused;
  }

  /**
   * Waits for an attached file to finish uploading — or for Copilot to say it refused it (live test 2026-11-23: "The
   * upload service is busy right now. Wait a moment, then try again." showed at once, and the bot waited two minutes
   * for an upload that had already failed, then sent the message without the file; Copilot, told to read it, asked for
   * the same command again). A refusal is answered with the bar's own "Try again", up to `uploadRetriesMs.length`
   * times, waiting longer each time so as not to press a busy service; still refused, 'refused'. True once uploaded;
   * false when neither showed (the `attachmentUploaded` locator likely found nothing).
   *
   * A bar is a refusal when it offers to try again. One that does not is a notice ("Uploading from device will send a
   * copy to OneDrive … Manage uploads", with the first file of a window: live test 2026-11-25, and 11-23 before it) —
   * taken for a refusal, it cost the wait and the file went in the text, uploaded as it was. The upload is waited for
   * under it; not seen by `uploadNoticeMs`, it is taken for a refusal that offers nothing.
   */
  private async uploadOrRefusal(path: string): Promise<boolean | 'refused'> {
    const name = path.split(/[\\/]/).pop() as string;
    const anyBar = (): Locator => this.el('uploadError').filter({ visible: true });
    // A locator of the operator's own is taken at its word: whatever it finds is a refusal.
    const bar = (): Locator =>
      this.chatLocators.uploadError !== DefaultChatLocators.uploadError
        ? anyBar().first()
        : anyBar().filter({ has: this.p.locator('button:not([aria-label])') }).filter({ hasNotText: /manage uploads/i }).first();
    const own = this.chatLocators.attachmentUploaded !== DefaultChatLocators.attachmentUploaded;
    const byDefault = this.p.locator(playwrightSelector(fillFileLocator(DefaultChatLocators.attachmentUploaded, path)));
    for (let attempt = 0; ; attempt++) {
      const until = Date.now() + this.uploadWaitMs;
      let since: number | null = null;
      let sinceDefault: number | null = null;
      let refusal: string | null = null;
      let noticeSince: number | null = null;
      let offersNothing = false;
      while (Date.now() < until) {
        if (this.p.isClosed()) return false;
        if ((await bar().count().catch(() => 0)) > 0) {
          refusal = ((await bar().innerText({ timeout: 1_000 }).catch(() => '')) || 'the upload was refused').replace(/\s+/g, ' ').trim();
          break;
        }
        if ((await this.fileEl('attachmentUploaded', path).count().catch(() => 0)) > 0) {
          since ??= Date.now();
          if (Date.now() - since >= 2_000) return true;
        } else since = null;
        if (since === null && (await anyBar().count().catch(() => 0)) > 0) {
          if (noticeSince === null) {
            const said = (await anyBar().first().innerText({ timeout: 1_000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
            this.emit('attachment-upload-notice', { name, said: said.slice(0, 300) });
          }
          noticeSince ??= Date.now();
          if (Date.now() - noticeSince >= this.uploadNoticeMs) {
            refusal = ((await anyBar().first().innerText({ timeout: 1_000 }).catch(() => '')) || 'the upload was refused').replace(/\s+/g, ' ').trim();
            offersNothing = true;
            break;
          }
        }
        /*
         * One set in Settings that finds nothing (work, 2026-11-20: two minutes on every message with a file): by the
         * default, held much longer — the operator replaced it, so it is trusted less.
         */
        if (since === null && own && (await byDefault.count().catch(() => 0)) > 0) {
          sinceDefault ??= Date.now();
          if (Date.now() - sinceDefault >= this.uploadDefaultHoldMs) {
            this.emit('locator-worked-around', { key: 'attachmentUploaded', locator: this.chatLocators.attachmentUploaded, by: DefaultChatLocators.attachmentUploaded });
            return true;
          }
        } else sinceDefault = null;
        await this.p.waitForTimeout(500);
      }
      if (refusal === null) return false;
      const wait = offersNothing ? undefined : this.uploadRetriesMs[attempt];
      this.emit('attachment-upload-refused', { name, said: refusal.slice(0, 300), attempt: attempt + 1, ...(wait !== undefined ? { retryInSec: Math.round(wait / 1000) } : {}) });
      if (wait === undefined) {
        // Given up: the bar is closed, so it does not stand over the message that goes without the file.
        await (offersNothing ? anyBar().first() : bar()).locator('button[aria-label]').first().click({ timeout: 2_000 }).catch(() => undefined);
        return 'refused';
      }
      // A Stop ends the wait: no more tries, and the message goes as it would after the last one.
      const resume = Date.now() + wait;
      while (Date.now() < resume && !this.stop?.aborted && !this.p.isClosed()) await this.p.waitForTimeout(Math.min(250, resume - Date.now()));
      if (this.stop?.aborted || this.p.isClosed()) return 'refused';
      // The bar's own "Try again": its button without a label of its own (the other one, labelled, dismisses it).
      const again = bar().locator('button:not([aria-label])').first();
      if (!(await again.click({ timeout: 2_000 }).then(() => true, () => false))) {
        await bar().locator('button[aria-label]').first().click({ timeout: 2_000 }).catch(() => undefined);
        return 'refused';
      }
      await this.p.waitForTimeout(1_000);
    }
  }

  /**
   * The message with the text of each file Copilot refused to upload put after it (live test 2026-11-23). The message
   * still says "in the attached file"; the note says the file could not be attached and its text follows. Longer than
   * `inlineRefusedMaxChars` together, each file keeps its start and its end, and says what was cut.
   */
  private async withRefusedFiles(text: string, files: string[]): Promise<string> {
    const room = Math.max(2_000, this.inlineRefusedMaxChars - text.length);
    const each = Math.floor(room / files.length);
    const parts: string[] = [text];
    for (const file of files) {
      const name = file.split(/[\\/]/).pop() as string;
      let body = await readFile(file, 'utf8').catch((e: unknown) => `(the file could not be read: ${(e as Error).message})`);
      if (body.length > each) {
        const head = Math.floor(each * 0.6);
        const tail = each - head;
        body = `${body.slice(0, head)}\n\n[… ${body.length - head - tail} characters cut here: the message has room for no more …]\n\n${body.slice(-tail)}`;
      }
      const fence = body.includes('```') ? '~~~~' : '```';
      parts.push(`Copilot's upload service refused the file ${name} (it said the service was busy), so it is not attached: its text follows here instead.\n\n${fence}\n${body}\n${fence}`);
      this.emit('attachment-inlined', { name, chars: body.length });
    }
    return parts.join('\n\n');
  }

  /** How long the text of refused files may make a message, all told (a field, for the checks). */
  inlineRefusedMaxChars = 100_000;

  /** How long an attached file may take to show in the box, and to finish uploading (fields, for the checks). */
  inputWaitMs = 10_000;
  attachWaitMs = 30_000;
  uploadWaitMs = 120_000;
  /** How long the default must say "uploaded" where the one set in Settings finds nothing (a field, for the checks). */
  uploadDefaultHoldMs = 15_000;
  /** How long a bar that offers no "Try again" may stand with the file not seen uploaded (a field, for the checks). */
  uploadNoticeMs = 30_000;
  /** The waits before each "Try again" of an upload Copilot refused; one more refusal after the last, and it goes in the text. */
  uploadRetriesMs = [15_000, 30_000, 60_000];
  /** How long Copilot's own chat page may show no box before its locator is said as the likely cause (a field, for the checks). */
  boxSuspectMs = 30_000;

  /** An attached file's locator in force, with the file's name put in its place (see `fillFileLocator`). */
  private fileEl(key: 'attachment' | 'attachmentUploaded', file: string): Locator {
    return this.p.locator(playwrightSelector(fillFileLocator(this.chatLocators[key], file)));
  }

  /** Whether `test` comes true within `ms` and stays true for `steadyMs`, looked at every half second. */
  private async holds(test: () => Promise<boolean>, ms: number, steadyMs: number): Promise<boolean> {
    const until = Date.now() + ms;
    let since: number | null = null;
    while (Date.now() < until) {
      if (this.p.isClosed()) return false;
      if (await test()) {
        since ??= Date.now();
        if (Date.now() - since >= steadyMs) return true;
      } else since = null;
      await this.p.waitForTimeout(500);
    }
    return false;
  }

  /**
   * Waits for the answer to finish streaming, then returns its raw markdown.
   *
   * This polls rather than using one long `waitForFunction`, for three reasons that all
   * showed up in practice:
   *
   *   - a human-verification challenge can appear mid-wait, and the run should pause with an
   *     instruction rather than time out fifteen minutes later,
   *   - if the browser window is closed, Playwright's message is
   *     "Target page, context or browser has been closed", which explains nothing,
   *   - a stalled reply is worth reporting with how long it waited and what it saw.
   */
  async waitForReply(previousTurns: number): Promise<ReplyCapture> {
    const startedAt = Date.now();
    const deadline = startedAt + this.opts.replyTimeoutMs;

    /*
     * Through the chat's locators in force (2026-11-17: each can be set in Settings): the conversation's size as the app
     * reports it (see turnCount), whether Copilot is still writing, and whether its newest answer is finished — its Copy
     * button there — with how long that answer's text is, to tell one standing still.
     */
    const state = async (): Promise<{ turns: number; streaming: boolean; finished: boolean; answers: number; chars: number }> => {
      const turns = await this.turnCount();
      const streaming = (await this.el('stop').count()) > 0;
      const answers = this.el('answer');
      const n = await answers.count();
      const newest = n > 0 ? answers.nth(n - 1) : null;
      const chars = newest ? await newest.evaluate((el) => (el.textContent ?? '').length).catch(() => 0) : 0;
      const finished = !streaming && !!newest && (await newest.locator(this.sel('copy')).count()) > 0;
      return { turns, streaming, finished, answers: n, chars };
    };

    let sawNewTurn = false;
    let last = { turns: previousTurns, streaming: false, finished: false, answers: 0, chars: 0 };
    // Since when Copilot's newest answer has stood still, not written and not finished (see below).
    let still = { since: Date.now(), chars: -1, answers: -1 };

    while (Date.now() < deadline) {
      if (this.p.isClosed()) {
        throw new Error(
          'The browser window was closed while waiting for a reply. If you did not close it, ' +
            'another Edge process was probably already using the bot profile; ' +
            'close every Edge window on that profile and run again.',
        );
      }

      try {
        last = await state();
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('closed')) {
          throw new Error(
            'The browser closed while waiting for a reply. Close any other Edge window using ' +
              'the bot profile, then run again.',
          );
        }
        // A navigation can make one poll fail; try again.
        await this.p.waitForTimeout(1_000);
        continue;
      }

      if (last.turns > previousTurns) sawNewTurn = true;
      if (sawNewTurn && last.finished) break;

      /*
       * What a locator that no longer finds its element looks like (2026-11-17), said rather than waiting out the whole
       * reply time: not one message of the conversation found, though the message sent is in it; or Copilot's answer
       * begun, then standing still — not written any more, never finished — with no answer found at all, or no Copy
       * button anywhere on the page. A Copy missing from the newest answer alone is Copilot's, not the locator's.
       */
      if (last.turns === 0 && Date.now() - startedAt >= this.turnsGraceMs) {
        throw await this.locatorMissing('turn', 'while the answer was awaited: not one message of the conversation was found, though the message sent is in it');
      }
      if (sawNewTurn && !last.streaming) {
        if (last.chars !== still.chars || last.answers !== still.answers) still = { since: Date.now(), chars: last.chars, answers: last.answers };
        else if (Date.now() - still.since >= this.answerStillMs) {
          if (last.answers === 0) {
            throw await this.locatorMissing('answer', `while the answer was awaited: Copilot's turn began and, ${Math.round((Date.now() - startedAt) / 1000)} s on, no answer was found`);
          }
          if ((await this.el('copy').count().catch(() => 1)) === 0) {
            throw await this.locatorMissing('copy', `in Copilot's answers: the newest had not changed for ${Math.round(this.answerStillMs / 1000)} s, was not being written, and no answer had a Copy button`);
          }
        }
      } else still = { since: Date.now(), chars: -1, answers: -1 };

      // Only look for blockers while nothing is streaming, so the check stays cheap.
      if (!last.streaming) {
        const blocker = await this.detectBlocker();
        if (blocker.kind !== 'none') {
          this.emit('blocker-during-reply', { blocker: blocker.kind, reason: blocker.reason });
          await this.clearBlockers();
          // The request that triggered the blocker was rejected, so no reply is coming.
          // Say so instead of waiting out the whole timeout.
          if (!sawNewTurn) {
            throw new SendRejectedError(
              `The chat blocked the request (${blocker.kind}: ${blocker.reason}). ` +
                'The message was not accepted, so no reply will arrive.',
            );
          }
        }
      }

      await this.p.waitForTimeout(1_000);
    }

    if (!sawNewTurn || !last.finished) {
      await this.dumpFailure(join(this.opts.transportDir, '..', 'failures'), 'reply-timeout').catch(
        () => undefined,
      );
      throw new ReplyTimeoutError(
        Math.round(this.opts.replyTimeoutMs / 1000),
        `Copilot did not finish a reply within ${Math.round(this.opts.replyTimeoutMs / 1000)}s ` +
          `(new turn seen: ${sawNewTurn}, still streaming: ${last.streaming}). ` +
          'A screenshot and an HTML dump are in the run folder.',
      );
    }

    // Let the text settle: the widget re-renders briefly after the stream ends.
    let previousText = '';
    for (let i = 0; i < 20; i += 1) {
      const now = await this.lastMessageText();
      if (now === previousText && now.length > 0) break;
      previousText = now;
      await this.p.waitForTimeout(400);
    }

    const attachments = await this.lastMessageAttachmentNames();
    // A reply that carries a file is told nothing by being ignored, and neither is the operator; the
    // file is not fetched, and the log says so by name. The contract already tells the chat why.
    if (attachments.length) this.emit('reply-files-ignored', { files: attachments });
    const codeBlocksDom = await this.lastAnswerCodeBlocks();
    const { markdown, degraded } = await this.copyLastReply();
    // A new conversation has its address once it has answered: from now on, the one `ensureOnChat` holds the page to.
    if (this.onChat === 'new') {
      const id = parseChatId(this.p.url());
      if (id) this.onChat = { id };
    }
    this.emit('reply-received', {
      chars: markdown.length,
      degraded,
      attachments: attachments.length,
      codeBlocks: codeBlocksDom.length,
      waitedMs: Date.now() - startedAt,
    });
    return { markdown, degraded, attachments, codeBlocksDom };
  }

  /**
   * The newest answer, as a whole.
   *
   * `copilot-message-div` rather than `lastChatMessage`, because the latter is only the
   * answer body: the toolbar with the copy button is its sibling, not its child. Anchoring
   * on the wrapper is what makes the copy button, the code blocks and the download anchors
   * all reachable from one locator.
   */
  private lastAnswer(): Locator {
    return this.el('answer').last();
  }

  private async lastMessageText(): Promise<string> {
    return (await this.lastAnswer().innerText().catch(() => '')) ?? '';
  }

  /** The on-screen text of each code block in the newest answer, for comparison only. */
  async lastAnswerCodeBlocks(): Promise<string[]> {
    const blocks = this.lastAnswer().locator(Css.codeBlock);
    const n = await blocks.count().catch(() => 0);
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) {
      out.push((await blocks.nth(i).innerText().catch(() => '')) ?? '');
    }
    return out;
  }

  async lastMessageAttachmentNames(): Promise<string[]> {
    const links = this.lastAnswer().locator(Css.downloadLink);
    const n = await links.count();
    const names: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const name = await links.nth(i).getAttribute('download');
      if (name) names.push(name);
    }
    return names;
  }

  /**
   * Clicks "Copy Response" and takes what the page tried to copy, which is the whole answer as
   * raw markdown with the fences intact.
   *
   * What it does not do is touch the machine's clipboard: `CLIPBOARD_GUARD` has already put
   * the page's copy call somewhere only this process reads. Falls back to the DOM text, flagged
   * as degraded, because that text is known to be lossy.
   */
  private async copyLastReply(): Promise<{ markdown: string; degraded: boolean }> {
    const copy = this.lastAnswer().locator(this.sel('copy')).first();
    try {
      /*
       * Two guards around one click, both about the neighbours.
       *
       * The answer toolbar is a row of small buttons — copy, like, dislike, retry — and the
       * copy button is the first of them. So before clicking, the button's own label is read
       * and it has to look like a copy control: if the test id ever moves to a different
       * button, the click is skipped rather than landing on "like", which would be a rating
       * left on somebody's account by a program that has no opinion.
       */
      const label = ((await copy.getAttribute('aria-label')) ?? (await copy.getAttribute('title')) ?? '').toLowerCase();
      if (label && !label.includes('copy')) {
        this.emit('copy-button-moved', { label });
        throw new Error(`the copy test id now points at a button labelled "${label}"`);
      }

      /*
       * The counter is read before the click and waited on afterwards, so what comes back is
       * necessarily what this click produced. A copy that silently did nothing times out and
       * degrades; it can never be served the answer from the iteration before.
       */
      const before = await this.p.evaluate(() => window.__copClipboard?.seq ?? -1);
      if (before < 0) throw new Error('the clipboard guard is not installed on this page');

      await copy.click({ timeout: 15_000 });
      // And afterwards the pointer is parked away from the toolbar. Left where it was, it
      // hovers whichever button the re-render slides under it, which shows a tooltip over the
      // answer and puts the mouse one stray event away from a button nobody meant to press.
      await this.p.mouse.move(2, 2).catch(() => undefined);

      const captured = await this.p.waitForFunction(
        (seq: number) => {
          const state = window.__copClipboard;
          return state && state.seq > seq ? state.text : null;
        },
        before,
        { timeout: 15_000 },
      );
      const text = await captured.jsonValue();
      if (text && text.trim().length > 0) return { markdown: text, degraded: false };
    } catch {
      /* fall through */
    }
    this.emit('clipboard-unavailable');
    return { markdown: await this.lastMessageText(), degraded: true };
  }

  /**
   * Downloads one file Copilot attached to the last answer.
   *
   * The attachment is an ordinary anchor with a `blob:` href, a `download` attribute and
   * `target="_blank"`, which is exactly why hovering shows nothing useful. The download event
   * has to be registered before the click, and the popup case is covered too.
   */

  /** An Edge crash written to the profile in the last few minutes, if there is one. */
  async recentCrash(): Promise<EdgeCrash | null> {
    return await findRecentCrash(this.opts.profileDir).catch(() => null);
  }

  async turnCountNow(): Promise<number> {
    return await this.turnCount();
  }

  /**
   * Screenshot plus HTML dump, for when a locator stops matching.
   *
   * When the page is already gone the dump would be an empty file, which is worse than
   * nothing because it looks like evidence. In that case a note is written instead.
   */
  async dumpFailure(dir: string, tag: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    const { writeFile } = await import('node:fs/promises');

    if (!this.page || this.page.isClosed()) {
      // A closed page reads the same whether the window was closed, another Edge took the
      // profile, or Edge crashed. Only the last leaves a minidump, and it says which process.
      const crash = await this.recentCrash();
      await writeFile(
        join(dir, `${tag}.txt`),
        crash
          ? `${describeCrash(crash)}\n\nThe page was already closed when the failure was recorded, so there is nothing else to capture.`
          : 'The page was already closed when the failure was recorded, so there is nothing to ' +
              'capture. No Edge crash report was written in the last minutes, so this usually means ' +
              'the browser window was closed, or another Edge process was using the same profile.',
        'utf8',
      ).catch(() => undefined);
      if (crash) this.emit('browser-crashed', { dir, tag, ...crash });
      else this.emit('failure-dump-empty', { dir, tag });
      return;
    }

    await this.p.screenshot({ path: join(dir, `${tag}.png`), fullPage: true }).catch(() => undefined);
    // The page's HTML carries the account's other conversation titles and its sign-in state, so it
    // is written only when the operator has asked for it; the screenshot and the URL always are.
    if (this.opts.keepFailurePage) {
      const html = await this.p.content().catch(() => '');
      if (html.length > 0) {
        await writeFile(join(dir, `${tag}.html`), html, 'utf8').catch(() => undefined);
      }
    }
    await writeFile(join(dir, `${tag}.url.txt`), this.p.url(), 'utf8').catch(() => undefined);
    this.emit('failure-dumped', { dir, tag, url: this.p.url() });
  }
}
