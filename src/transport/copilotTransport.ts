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
import { chromium, type BrowserContext, type Page, type Locator } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findRecentCrash, describeCrash, type EdgeCrash } from './edgeCrash.js';
import { landed } from './acceptance.js';
import { Blocker, Css, Label, Model, ModelPicking, OperatorModelLocators, Rename, Sidebar, Signal, Surface, TestId, Upload, Url } from './locators.js';
import { acquireProfileLock, type LockHandle } from './profileLock.js';
import { parseChatId } from './chatSession.js';

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
  /** A numbered picture and the menu's HTML at each step of choosing a model (the diagnosis command sets it). */
  modelStepShots?: boolean;
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

const ORIGIN = 'https://m365.cloud.microsoft';

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
/** One of the operator's locators for a model: the model's own, and its group's when it is in one. */
type OperatorTarget = { model: string; xpath: string; group?: { name: string; xpath: string } };

/**
 * Which of the operator's locators a chosen model is. Groups first, by the word the locator is written
 * with ("Sonnet", "Opus", "GPT-5.6 Sol Think deeper") contained in the name, longest first; then the
 * models at the top, by their name ("Think deeper" is in "GPT-5.6 Sol Think deeper" too, so they come
 * last). Null for a model the operator gave no locator for.
 */
export function operatorTargetFor(name: string): OperatorTarget | null {
  const n = ` ${normModel(name)} `;
  const has = (word: string): boolean => n.includes(` ${normModel(word)} `);
  const inGroups = OperatorModelLocators.groups
    .flatMap((g) => g.models.map((m) => ({ model: m.model, xpath: m.xpath, group: { name: g.group, xpath: g.xpath } })))
    .sort((a, b) => b.model.length - a.model.length);
  const grouped = inGroups.find((m) => has(m.model));
  if (grouped) return grouped;
  const top = OperatorModelLocators.top.find((m) => sameModel(m.model, name));
  return top ? { model: top.model, xpath: top.xpath } : null;
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

export class CopilotTransport {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lock: LockHandle | null = null;

  constructor(private readonly opts: TransportOptions) {}

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
    this.emit('browser-opened', { profileDir: this.opts.profileDir });
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.page = null;
    this.lock?.release();
    this.lock = null;
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

  private composer(): Locator {
    return this.p.locator(Css.composer).first();
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
    const url = this.p.url();
    if (url.includes(Signal.loginHost)) return 'sign-in';
    if (Surface.consumerHosts.some((h) => url.includes(h))) return 'consumer';
    if (url.includes(Surface.workHost)) {
      const hasWorkComposer = (await this.p.locator(Surface.workMarkers[0]).count()) > 0;
      return hasWorkComposer ? 'work' : 'unknown';
    }
    return 'unknown';
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
    await this.p.goto(target.toString(), { waitUntil: 'domcontentloaded' });
  }

  /** Throws with an explanation when the profile is not on the work Copilot. */
  async assertWorkSurface(): Promise<void> {
    const where = await this.surface();
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
  async ensureSignedIn(url = this.opts.chatUrl): Promise<void> {
    await this.p.goto(url, { waitUntil: 'domcontentloaded' });

    if (!(await this.isChatReady(15_000))) {
      this.emit('sign-in-required', { url: this.p.url() });
      await this.composer().waitFor({ state: 'visible', timeout: this.opts.signInTimeoutMs });
      this.emit('signed-in');
    }

    await this.clearBlockers();
    await this.assertWorkSurface();
  }

  async newChat(): Promise<void> {
    await this.p.goto(Url.newChat, { waitUntil: 'domcontentloaded' });
    await this.composer().waitFor({ state: 'visible' });
    await this.dismissPopups();
  }

  /** Reopens a conversation by its id. Returns false when it no longer opens. */
  async openConversation(chatId: string): Promise<boolean> {
    await this.p.goto(Url.conversation(chatId), { waitUntil: 'domcontentloaded' });
    if (!(await this.isChatReady(20_000))) return false;
    return parseChatId(this.p.url()) === chatId;
  }

  /** Finds a conversation by its exact name in the sidebar. */
  async openConversationByName(name: string): Promise<boolean> {
    const row = this.p.locator(`${Sidebar.conversationLink}[aria-label="${name.replace(/"/g, '\\"')}"]`);
    if ((await row.count()) === 0) return false;
    await row.first().click();
    return await this.isChatReady(20_000);
  }

  async currentChatId(): Promise<string | null> {
    return parseChatId(this.p.url());
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
  async nameChat(chatId: string, name: string, opts: { waitMs?: number } = {}): Promise<boolean> {
    const row = this.p.locator(`${Sidebar.conversationLink}[href*="${chatId}"]`).first();
    // Waited for, like everything below: a new chat's row appears in the sidebar some seconds after the
    // reply, and `count()` read it as missing and returned without a word (live run 2026-10-03). The run
    // tries again later when it is still not there (see `nameIfStillUnnamed` in taskRunner.ts).
    const waitMs = opts.waitMs ?? 15_000;
    try {
      await row.waitFor({ state: 'attached', timeout: waitMs });
    } catch {
      this.emit('chat-name-failed', { chatId, name, error: `the conversation did not appear in the sidebar within ${Math.round(waitMs / 1000)} s` });
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
      const byChat = this.p.locator(Rename.moreButtonForChat(chatId)).first();
      const more = (await byChat.count()) > 0
        ? byChat
        : row.locator('xpath=ancestor-or-self::*[self::li or self::div][1]').getByRole('button', { name: Rename.moreButtonLabel, exact: true }).first();
      await more.waitFor({ state: 'attached', timeout: 5_000 });
      await this.press(more);
      opened = true;

      const item = this.p.getByRole('menuitem', { name: Rename.menuItem, exact: true }).first();
      await item.waitFor({ state: 'visible', timeout: 5_000 });
      await this.press(item);
      opened = false;

      const input = this.p.locator(Rename.input);
      await input.waitFor({ state: 'visible', timeout: 10_000 });
      const wanted = name.slice(0, Rename.maxLength);
      await input.fill(wanted);
      await this.press(this.p.getByRole('button', { name: Rename.saveText, exact: true }).first());
      await input.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);

      // Named only when the sidebar says so: its row's label is the chat's name.
      const shows = async (): Promise<string> => ((await row.getAttribute('aria-label').catch(() => null)) ?? '').trim();
      const deadline = Date.now() + 8_000;
      while ((await shows()) !== wanted && Date.now() < deadline) await this.p.waitForTimeout(250);
      if ((await shows()) !== wanted) {
        this.emit('chat-name-failed', { chatId, name, error: `the sidebar still shows "${await shows()}"` });
        return false;
      }
      this.emit('chat-named', { chatId, name });
      return true;
    } catch (e) {
      this.emit('chat-name-failed', { chatId, name, error: (e as Error).message });
      return false;
    } finally {
      // Whatever happened, the sidebar is left as it was found. A menu left hanging over the
      // chat list is not only untidy: it covers the rows and swallows the next click.
      if (opened) await this.dismissOpenMenu();
    }
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
      await this.p.waitForTimeout(150);
      const open = this.p.locator('[role="menu"]');
      if ((await open.count()) > 0) {
        await this.p.mouse.click(4, 4);
        await this.p.waitForTimeout(150);
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

  private modelButton(): Locator {
    const byId = this.p.locator(Model.button);
    return byId;
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
      const byId = this.modelButton();
      if ((await byId.count().catch(() => 0)) > 0) return byId.first();

      const byLabel = this.p.getByRole('button', { name: Model.buttonLabel, exact: false });
      if ((await byLabel.count().catch(() => 0)) > 0) return byLabel.first();

      await this.p.waitForTimeout(500);
    } while (Date.now() < deadline);
    return null;
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
    const button = await this.resolveModelButton();
    if (!button) {
      return { options: [], current: null, note: 'This chat does not show a model picker, so there is nothing to choose.' };
    }

    const current = await this.currentModel();
    await button.click();
    if (!(await this.waitForPopup())) {
      await this.closeMenu();
      return { options: [], current, note: 'The model picker opened nothing that could be read.' };
    }

    // The top menu only: a group's submenu can be on screen with it (2026-10-05, Claude's above GPT's).
    const shown = await this.readMenuRows();
    const top = this.topRows(shown);
    await this.captureMenu('top', shown);
    await this.closeMenu();

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
   * Every visible menu row right now, across the menu and whatever submenu is open, in page order.
   *
   * Each row says which menu it is in (`menuOf`, the menu's `aria-labelledby`: a submenu is labelled by
   * the row that opens it) and its place there (`index`), so the same row can be found again without
   * going by its text. Rows are not merged by name: the group row and the model chosen in it carry the
   * same name once that model is in force.
   */
  private async readMenuRows(): Promise<MenuRow[]> {
    return await this.p.evaluate(
      ({ roles, selectedAttrs, submenuAttrs }) => {
        const out: Array<{ name: string; raw: string; selected: boolean; disabled: boolean; role: string; opensSubmenu: boolean; index: number; menuOf: string; testId: string; elId: string }> = [];
        const selector = roles.map((r) => `[role="${r}"]`).join(',');
        const counted = new Map<Element | null, number>();
        // A menu's key: what labels it (a submenu is labelled by the row that opens it), else a mark put
        // on it here, so a menu with no label is told apart from the others all the same.
        // (Written inline: a named function in here is wrapped by the bundler in a helper the page does not have.)
        const w = window as unknown as { __copMenus?: number };
        for (const el of Array.from(document.querySelectorAll(selector))) {
          // A menu that is closed is still in the DOM, so visibility is what separates
          // what is on screen from what was on screen a moment ago.
          if ((el as HTMLElement).getClientRects().length === 0) continue;
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
        return out;
      },
      {
        roles: [...Model.optionRoles],
        selectedAttrs: [...Model.selectedAttributes],
        submenuAttrs: [...Model.submenuAttributes],
      },
    );
  }

  /** The rows of the top menu, read while only it is open: the menu its first row is in. */
  private topRows(rows: MenuRow[]): MenuRow[] {
    const key = rows[0]?.menuOf;
    return key === undefined ? [] : rows.filter((r) => r.menuOf === key);
  }

  /**
   * Opens one group of the open picker and returns the key of its submenu (see `readMenuRows`), or null.
   * The group's row is found by its test id, else by its place among the top rows, else by its text. Its
   * submenu is the menu labelled by that row, or, in a build that does not label it, the menu that
   * appeared when the row was hovered.
   */
  private async openGroup(group: { testId?: string; index: number; name: string; vendor?: string }): Promise<string | null> {
    const shown = await this.readMenuRows();
    const groups = this.topRows(shown).filter((r) => r.opensSubmenu);
    // By its test id; else by the vendor its row names ("OpenAI"), which a choice does not change; else by
    // its text, as it reads or contains; else by its place.
    const row =
      (group.testId ? groups.find((r) => r.testId === group.testId) : undefined) ??
      (group.vendor ? groups.find((r) => vendorOf(r) && sameModel(vendorOf(r), group.vendor)) : undefined) ??
      groups.find((r) => sameModel(r.name, group.name)) ??
      groups.find((r) => containsModel(r.raw, group.name)) ??
      groups.find((r) => r.index === group.index);
    if (!row) return null;
    const trigger = this.p.locator(`[data-cop-row="${row.menuOf}#${row.index}"]`).first();
    // Submenus already on screen are not this group's, whatever opened them.
    const before = new Set(shown.filter((r) => r.menuOf !== row.menuOf).map((r) => r.menuOf));
    const opened = async (ms: number): Promise<string | null> => {
      const started = Date.now();
      do {
        const rows = (await this.readMenuRows()).filter((r) => r.menuOf !== row.menuOf);
        // The menu labelled by this group's row is its own; a build that labels none gets the one that
        // appeared, never one that was already there (2026-10-05: Claude's was taken for GPT's).
        if (row.elId && rows.some((r) => r.menuOf === row.elId)) return row.elId;
        const fresh = rows.find((r) => !before.has(r.menuOf) && r.menuOf !== row.elId);
        if (fresh && (!row.elId || Date.now() - started > 1_500)) return fresh.menuOf;
        await this.p.waitForTimeout(200);
      } while (Date.now() - started < ms);
      return null;
    };
    // Hover is how these open; a click is the fallback for a build that wants one.
    await trigger.hover({ timeout: 3_000 }).catch(() => undefined);
    const hovered = await opened(4_000);
    if (hovered) return hovered;
    await trigger.click({ timeout: 3_000 }).catch(() => undefined);
    return await opened(4_000);
  }

  /** Opens a fresh menu, then the group, and reads what is in it. */
  private async readSubmenu(button: Locator, group: { testId?: string; index: number; name: string; vendor?: string }): Promise<MenuRow[]> {
    await button.click();
    if (!(await this.waitForPopup())) return [];
    const key = await this.openGroup(group);
    const children = key ? (await this.readMenuRows()).filter((r) => r.menuOf === key) : [];
    await this.captureMenu(`group-${group.name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40)}`, children);
    await this.closeMenu();
    return children;
  }

  /**
   * The visible row an XPath of `Model` finds for a text, waited for: the one whose own first line is
   * the text when several contain it ("Think deeper" is in "GPT-5.6 Sol Think deeper" too), else the first.
   */
  private async rowByXPath(xpath: string, text: string, waitMs: number): Promise<Locator | null> {
    const all = this.p.locator(`xpath=${xpath}`);
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
      await this.p.waitForTimeout(200);
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
    await button.click();
    if (!(await this.waitForPopup())) return { problem: 'The model picker did not open.' };
    if (group) {
      const trigger = await this.rowByXPath(`${Model.groupRowXPath(group)} | ${Model.groupRowByAllText(group)}`, group, 4_000);
      if (!trigger) return { problem: `the picker has no "${group}" group.` };
      // Hover is how these open; a click on it is the fallback.
      await trigger.hover({ timeout: 3_000 }).catch(() => undefined);
      let row = await this.rowByXPath(`${Model.modelRowXPath(name)} | ${Model.modelRowByAllText(name)}`, name, 4_000);
      if (!row) {
        await this.press(trigger).catch(() => undefined);
        row = await this.rowByXPath(`${Model.modelRowXPath(name)} | ${Model.modelRowByAllText(name)}`, name, 4_000);
      }
      return row ? { row } : { problem: `"${name}" is not in the "${group}" group.` };
    }
    const row = await this.rowByXPath(`${Model.modelRowXPath(name)} | ${Model.modelRowByAllText(name)}`, name, 4_000);
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
    await this.p.waitForTimeout(800);
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
   * Chooses a model by the operator's own locators (`OperatorModelLocators`): the picker button, then the
   * model; for a model in a group, the group first, then — once its models are on screen — the model. The
   * choice counts only when the model's row is marked chosen, read again the same way.
   */
  private async chooseByOperatorLocators(name: string, target: OperatorTarget): Promise<ModelChoice> {
    const before = await this.currentModel();
    const textOf = async (el: Locator): Promise<string> => (((await el.innerText().catch(() => '')) ?? '').split('\n')[0] ?? '').trim();
    // A fixed pause after every opening and every press (see `ModelPicking`); the checks give it less.
    const settle = (): Promise<void> => this.p.waitForTimeout(this.opts.modelSettleMs ?? ModelPicking.settleMs);
    const pause = this.opts.modelBeforePressMs ?? ModelPicking.beforePressMs;
    const poll = this.opts.modelPollMs ?? ModelPicking.pollMs;
    const appear = this.opts.modelAppearMs ?? ModelPicking.appearMs;
    let shot = 0;
    /** With `modelStepShots`, a picture and the menu's HTML at each step, numbered, beside the transport's files. */
    const picture = async (label: string): Promise<void> => {
      if (!this.opts.modelStepShots) return;
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
        await this.p.waitForTimeout(poll);
        looks += 1;
        el = await find();
      }
      if (!el) {
        this.emit('model-step', { step: 'never appeared', what: label, looks });
        return null;
      }
      this.emit('model-step', { step: 'there, pausing before the press', what: label, look: looks, text: await textOf(el), pauseMs: pause });
      await this.p.waitForTimeout(pause);
      await picture(`before-${label}`);
      return el;
    };
    const visible = async (el: Locator | null): Promise<Locator | null> => (el && (await el.isVisible().catch(() => false)) ? el : null);
    const reach = async (): Promise<{ row: Locator } | { problem: string }> => {
      const button = await waitThenFind('the picker button', async () => visible(await this.resolveModelButton(1_000)));
      if (!button) return { problem: 'This chat does not show a model picker.' };
      await button.click({ timeout: 5_000 }).catch(() => undefined);
      await settle();
      if (!(await this.waitForPopup())) return { problem: 'The model picker did not open.' };
      this.emit('model-step', { step: 'picker opened' });
      if (target.group) {
        const group = await waitThenFind(`the "${target.group.name}" group`, () => this.rowByXPath(target.group!.xpath, target.group!.name, 0));
        if (!group) return { problem: `the "${target.group.name}" row was not found by ${target.group.xpath}` };
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
          const row = await waitThenFind(`"${target.model}"`, () => this.rowByXPath(target.xpath, target.model, 0));
          if (row) {
            this.emit('model-step', { step: 'group opened', how, model: await textOf(row) });
            return { row };
          }
          this.emit('model-step', { step: 'group not opened', how });
          await this.p.waitForTimeout(pause);
        }
        await this.captureMenu('select-failed', await this.readMenuRows().catch(() => [])).catch(() => undefined);
        return { problem: `"${target.model}" did not appear after opening "${target.group.name}" every way (${target.xpath}); the menu is kept as models-select-failed.html/.png` };
      }
      const row = await waitThenFind(`"${target.model}"`, () => this.rowByXPath(target.xpath, target.model, 0));
      if (!row) {
        await this.captureMenu('select-failed', await this.readMenuRows().catch(() => [])).catch(() => undefined);
        return { problem: `"${target.model}" was not found by ${target.xpath}; the menu is kept as models-select-failed.html/.png` };
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
      await button.click({ timeout: 5_000 }).catch(() => undefined);
      await settle();
      if (!(await this.waitForPopup())) return false;
      const group = await waitThenFind(`the "${target.group.name}" group`, () => this.rowByXPath(target.group!.xpath, target.group!.name, 0));
      if (!group) {
        await this.closeMenu();
        return false;
      }
      await group.focus({ timeout: 3_000 }).catch(() => undefined);
      await this.p.keyboard.press('ArrowRight');
      this.emit('model-step', { step: 'group opened by the keyboard (ArrowRight)', attempt });
      await settle();
      const focused = (): Promise<{ text: string; radio: boolean }> =>
        this.p.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          const row = el?.closest('[role="menuitemradio"],[role="menuitem"]') as HTMLElement | null;
          return { text: (row?.innerText ?? '').trim(), radio: !!el?.closest('[role="menuitemradio"]') };
        });
      for (let presses = 0; presses < 12; presses += 1) {
        const now = await focused();
        const line = now.text.split('\n')[0]?.trim() ?? '';
        if (now.radio && (sameModel(line, name) || sameModel(line, target.model) || containsModel(now.text, target.model))) {
          this.emit('model-step', { step: 'model reached by the keyboard, pausing before Enter', attempt, text: line, presses, pauseMs: pause });
          await this.p.waitForTimeout(pause);
          await picture('before-enter');
          await this.p.keyboard.press('Enter');
          await settle();
          return true;
        }
        await this.p.keyboard.press('ArrowDown');
        await this.p.waitForTimeout(400);
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
      // On the element itself, for the same reason as the group; the mouse only when that does nothing.
      this.emit('model-step', { step: 'model pressed', attempt, text: await textOf(found.row) });
      await found.row.evaluate((el) => (el as HTMLElement).click(), undefined, { timeout: 3_000 }).catch(() => undefined);
      await settle();
      if ((await this.modelMenuOpen()) && !(await checked(found.row))) {
        await this.p.waitForTimeout(pause);
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
      if (buttonShows(shownNow, name) || buttonShows(shownNow, target.model)) {
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
      await this.p.waitForTimeout(250);
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
        const candidate = this.p.locator(selector);
        const n = await candidate.count().catch(() => 0);
        for (let i = 0; i < n; i += 1) {
          const one = candidate.nth(i);
          if (await one.isVisible().catch(() => false)) return one;
        }
      }
      await this.p.waitForTimeout(250);
    }
    return null;
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
  async selectModel(name: string, opts: { locator?: ModelLocator } = {}): Promise<ModelChoice> {
    const button = await this.resolveModelButton();
    if (!button) return { ok: false, current: null, reason: 'This chat does not show a model picker.' };

    /*
     * Looked at before anything is opened: a conversation the run comes back to is usually on its model
     * already, and choosing it again was a menu walk for nothing (operator's request, 2026-10-06). The
     * button shows the model, shortened by words dropped from its end ("GPT-5.6 Sol Think"), and
     * `buttonShows` takes only that, so "Think deeper" is never taken for "GPT-5.6 Sol Think deeper".
     */
    const shown = await this.currentModel();
    if (buttonShows(shown, name)) {
      this.emit('model-already-selected', { model: name, buttonShows: shown, by: 'button' });
      return { ok: true, current: name, by: 'already' };
    }

    // The operator's own locators first, for the models they cover (see `OperatorModelLocators`).
    const target = operatorTargetFor(name);
    let first: ModelChoice | null = null;
    if (target) {
      first = await this.chooseByOperatorLocators(name, target);
      if (first.ok) return first;
    }
    if (opts.locator) {
      const second = await this.chooseAt(name, opts.locator);
      if (second.ok) return { ...second, ...(first?.reason ? { locatorMiss: first.reason } : {}) };
      first = first ?? second;
    }

    // The line-up as the page shows it now, each model with its place in it.
    const read = await this.listModels().catch(() => null);
    const options = read?.options ?? [];
    const match = options.find((o) => sameModel(o.name, name)) ?? pageModelFor(name, options);
    if (!match?.locator) {
      const offered = options.filter((o) => !o.disabled).map((o) => o.name);
      return {
        ok: false,
        current: await this.currentModel(),
        reason:
          `The picker does not offer "${name}" any more${offered.length > 0 ? `; it offers ${offered.map((o) => `"${o}"`).join(', ')}` : ''}.` +
          (first?.reason ? ` (${target ? "By the operator's locators" : 'At the place the list was read'}: ${first.reason})` : ''),
        ...(options.length > 0 ? { options } : {}),
      };
    }
    const chosen = await this.chooseAt(match.name, match.locator);
    return {
      ...chosen,
      // When both ways failed, why the operator's locators did is said too: that is the one to fix.
      ...(!chosen.ok && first?.reason ? { reason: `${chosen.reason ?? 'not chosen'} (${target ? "by the operator's locators" : 'at the saved place'}: ${first.reason})` } : {}),
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
    return await this.p.evaluate((turnSel: string) => {
      const nodes = Array.from(document.querySelectorAll(turnSel));
      let size = 0;
      for (const n of nodes) {
        const carrier = n.matches('[aria-setsize]') ? n : (n.querySelector('[aria-setsize]') ?? n.closest('[aria-setsize]'));
        const v = carrier ? Number(carrier.getAttribute('aria-setsize')) : NaN;
        if (!Number.isNaN(v) && v > size) size = v;
      }
      return size > 0 ? size : nodes.length;
    }, `[data-testid="${TestId.turn}"]`);
  }

  /** The newest user message as shown, for telling "landed but not counted" from "not sent". */
  private async lastUserTurnText(): Promise<string> {
    return await this.p
      .evaluate(() => {
        const nodes = document.querySelectorAll('[id^="user-message-"]');
        const last = nodes[nodes.length - 1] as HTMLElement | undefined;
        return last ? last.innerText : '';
      })
      .catch(() => '');
  }

  /** Puts text in the composer and clicks Send. Enter is not used: it does not submit. */
  async send(text: string, attachments: string[] = []): Promise<void> {
    if (text.trim().length === 0) {
      throw new Error('Refusing to send an empty message: the composer requires text.');
    }
    await this.clearBlockers();
    if (attachments.length > 0) await this.attach(attachments);

    const composer = this.composer();
    await composer.click();
    await composer.fill(text);

    const send = await this.sendButton();
    await send.waitFor({ state: 'visible', timeout: 20_000 });
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
    const wrapper = this.p.locator(Css.composerWrapper);
    if ((await wrapper.count()) > 0) {
      return wrapper.first().getByRole('button', { name: Label.send, exact: true }).first();
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

      const accepted = await this.waitForAccepted(before, 30_000, text, shownBefore);
      if (accepted) return before;

      const found = await this.detectBlocker();
      lastProblem = found.kind === 'none' ? 'the message did not appear in the chat' : `${found.kind}: ${found.reason}`;
      this.emit('send-not-accepted', { attempt, problem: lastProblem });

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
  async attach(paths: string[]): Promise<void> {
    await this.p.setInputFiles(Upload.input, paths);
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop() as string;
      const chip = this.p.locator(`${Upload.chip}[aria-label="${name.replace(/"/g, '\\"')}"]`);
      await chip.first().waitFor({ state: 'visible', timeout: 120_000 });
      await this.p
        .waitForFunction(
          ({ sel, prefix }) => {
            const el = document.querySelector(sel);
            return !!el && (el.id || '').startsWith(prefix);
          },
          { sel: `${Upload.chip}[aria-label="${name.replace(/"/g, '\\"')}"]`, prefix: Upload.uploadedIdPrefix },
          { timeout: 120_000 },
        )
        .catch(() => this.emit('attachment-upload-unconfirmed', { name }));
      this.emit('attached', { name });
    }
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

    const state = async (): Promise<{ turns: number; streaming: boolean; finished: boolean }> =>
      await this.p.evaluate(
        ({ turnSel, stopLabel, wrapperSel, copySel }) => {
          // The conversation's size as the app reports it, not the rendered count: see turnCount.
          const nodes = Array.from(document.querySelectorAll(turnSel));
          let size = 0;
          for (const n of nodes) {
            const carrier = n.matches('[aria-setsize]') ? n : (n.querySelector('[aria-setsize]') ?? n.closest('[aria-setsize]'));
            const v = carrier ? Number(carrier.getAttribute('aria-setsize')) : NaN;
            if (!Number.isNaN(v) && v > size) size = v;
          }
          const turns = size > 0 ? size : nodes.length;
          const streaming = Array.from(document.querySelectorAll('button')).some(
            (b) => b.getAttribute('aria-label') === stopLabel,
          );
          const wrappers = document.querySelectorAll(wrapperSel);
          const last = wrappers[wrappers.length - 1];
          return { turns, streaming, finished: !streaming && !!last && !!last.querySelector(copySel) };
        },
        {
          turnSel: `[data-testid="${TestId.turn}"]`,
          stopLabel: Label.stopGenerating,
          wrapperSel: Signal.answerWrapper,
          copySel: Signal.copyButtonInAnswer,
        },
      );

    let sawNewTurn = false;
    let last = { turns: previousTurns, streaming: false, finished: false };

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
    return this.p.getByTestId(TestId.assistantMessage).last();
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
    const copy = this.lastAnswer().getByTestId(TestId.copyResponse).first();
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
