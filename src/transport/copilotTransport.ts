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
import { chromium, type BrowserContext, type Page, type Locator } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findRecentCrash, describeCrash, type EdgeCrash } from './edgeCrash.js';
import { landed } from './acceptance.js';
import { Blocker, Css, Label, Model, Rename, Sidebar, Signal, Surface, TestId, Upload, Url } from './locators.js';
import { acquireProfileLock, type LockHandle } from './profileLock.js';
import { parseChatId } from './chatSession.js';

export type TransportOptions = {
  profileDir: string;
  downloadsDir: string;
  chatUrl: string;
  channel: 'msedge' | 'chrome' | 'chromium';
  headless: boolean;
  replyTimeoutMs: number;
  signInTimeoutMs: number;
  /** How long to wait for a human to clear a verification challenge. */
  humanWaitMs?: number;
  /** Called with human-readable progress, so the CLI can show what is happening. */
  onEvent?: (event: string, detail?: Record<string, unknown>) => void;
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
};

/** Escapes a model name so it can be matched literally inside a regular expression. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    await mkdir(this.opts.downloadsDir, { recursive: true });

    this.context = await chromium.launchPersistentContext(this.opts.profileDir, {
      channel: this.opts.channel,
      headless: this.opts.headless,
      acceptDownloads: true,
      downloadsPath: this.opts.downloadsDir,
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
    await this.dumpFailure(join(this.opts.downloadsDir, '..', 'failures'), `blocker-${kind}-${Date.now()}`)
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
  async nameChat(chatId: string, name: string): Promise<boolean> {
    const row = this.p.locator(`${Sidebar.conversationLink}[href*="${chatId}"]`).first();
    if ((await row.count()) === 0) return false;

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
      await row.hover();
      const more = row
        .locator('xpath=ancestor-or-self::*[self::li or self::div][1]')
        .getByRole('button', { name: Rename.moreButtonLabel, exact: true })
        .first();
      await more.waitFor({ state: 'visible', timeout: 5_000 });
      await more.click();
      opened = true;

      const item = this.p.getByRole('menuitem', { name: Rename.menuItem, exact: true }).first();
      await item.waitFor({ state: 'visible', timeout: 5_000 });
      await item.click();
      opened = false;

      const input = this.p.locator(Rename.input);
      await input.waitFor({ state: 'visible', timeout: 10_000 });
      await input.fill(name.slice(0, Rename.maxLength));
      await this.p.getByRole('button', { name: Rename.saveText, exact: true }).first().click();
      await input.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);

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
   * translated: a name shown here is the name the chat uses, so clicking it later is an exact
   * match rather than a guess. `raw` keeps the option's whole text, which is where Microsoft
   * puts the one-line description and any "limit reached" notice.
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

    const top = await this.readMenuRows();
    await this.closeMenu();

    const options: ModelOption[] = top.filter((r) => !r.opensSubmenu).map(({ opensSubmenu, ...o }) => o);
    const groups = top.filter((r) => r.opensSubmenu);
    const topNames = new Set(top.map((r) => r.name.toLowerCase()));

    // Each group is opened in its own pass, from a freshly opened menu. Walking several
    // submenus in one pass works until one of them closes the one above it, and then the
    // reader silently returns half a list; re-opening costs a second and cannot go wrong.
    for (const group of groups) {
      const children = await this.readSubmenu(button, group.name, topNames);
      for (const child of children) {
        options.push({ ...child, group: group.name, groupRaw: group.raw });
      }
    }

    this.emit('models-read', { count: options.length, groups: groups.length, current });
    return { options, current };
  }

  /** Every visible menu row right now, across the menu and whatever submenu is open. */
  private async readMenuRows(): Promise<MenuRow[]> {
    return await this.p.evaluate(
      ({ roles, selectedAttrs, submenuAttrs }) => {
        const seen = new Set<string>();
        const out: Array<{ name: string; raw: string; selected: boolean; disabled: boolean; role: string; opensSubmenu: boolean }> = [];

        for (const role of roles) {
          for (const el of Array.from(document.querySelectorAll(`[role="${role}"]`))) {
            // A menu that is closed is still in the DOM, so visibility is what separates
            // what is on screen from what was on screen a moment ago.
            if ((el as HTMLElement).getClientRects().length === 0) continue;

            const raw = ((el as HTMLElement).innerText || '').trim();
            const label = el.getAttribute('aria-label')?.trim() ?? '';
            // The first line is the name; the description sits underneath it.
            const name = (raw.split('\n')[0] || label || '').trim();
            if (!name || seen.has(name.toLowerCase())) continue;
            seen.add(name.toLowerCase());

            out.push({
              name,
              raw,
              selected: selectedAttrs.some((a) => el.getAttribute(a) === 'true'),
              disabled: el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'),
              role,
              opensSubmenu: submenuAttrs.some((a) => {
                const v = el.getAttribute(a);
                return a === 'aria-haspopup' ? v === 'menu' || v === 'true' : v !== null;
              }),
            });
          }
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

  /**
   * Opens one group and reads what is inside it.
   *
   * The children are found by difference: whatever is on screen that was not on the top
   * level belongs to the submenu that was just opened. That avoids having to identify which
   * popup container is which, which is Fluent's business and changes with its internals.
   */
  private async readSubmenu(button: Locator, groupName: string, topNames: Set<string>): Promise<MenuRow[]> {
    await button.click();
    if (!(await this.waitForPopup())) return [];

    const trigger = this.menuRow(groupName);
    if ((await trigger.count()) === 0) {
      await this.closeMenu();
      return [];
    }

    // Hover is how these open; a click is the fallback for a build that wants one.
    await trigger.hover().catch(() => undefined);
    let children = await this.waitForNewRows(topNames);
    if (children.length === 0) {
      await trigger.click().catch(() => undefined);
      children = await this.waitForNewRows(topNames);
    }

    await this.closeMenu();
    return children;
  }

  /** Waits for rows to appear that were not on the top level, and returns them. */
  private async waitForNewRows(known: Set<string>, timeoutMs = 4_000): Promise<MenuRow[]> {
    const deadline = Date.now() + timeoutMs;
    do {
      const rows = (await this.readMenuRows()).filter((r) => !known.has(r.name.toLowerCase()));
      if (rows.length > 0) return rows;
      await this.p.waitForTimeout(250);
    } while (Date.now() < deadline);
    return [];
  }

  /** One visible menu row, matched on the first line of its text. */
  private menuRow(name: string): Locator {
    const selector = Model.optionRoles.map((r) => `[role="${r}"]:visible`).join(', ');
    return this.p.locator(selector).filter({ hasText: new RegExp(`^${escapeForRegExp(name)}`, 'i') }).first();
  }

  /** Closes the picker, submenu included. */
  private async closeMenu(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      await this.p.keyboard.press('Escape').catch(() => undefined);
      await this.p.waitForTimeout(200);
      if ((await this.readMenuRows()).length === 0) return;
    }
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
   * Sets the chat to a model by the exact name the picker showed.
   *
   * Verified by reading the button back rather than by trusting the click, because a menu
   * item that is out of quota can look clicked and change nothing. When it did not take, the
   * caller is told what the chat is actually on, which is the honest answer.
   */
  async selectModel(name: string): Promise<{ ok: boolean; current: string | null; reason?: string }> {
    const button = await this.resolveModelButton();
    if (!button) return { ok: false, current: null, reason: 'This chat does not show a model picker.' };

    const before = await this.currentModel();
    if (before && before.toLowerCase() === name.toLowerCase()) return { ok: true, current: before };

    await button.click();
    if (!(await this.waitForPopup())) return { ok: false, current: before, reason: 'The model picker did not open.' };

    // The menu is walked rather than replayed from a saved path. A cached path goes stale the
    // moment Microsoft moves a model between groups, and a name is what the user chose.
    const top = await this.readMenuRows();
    const wanted = (r: MenuRow): boolean => r.name.toLowerCase() === name.toLowerCase();

    let target = top.find((r) => wanted(r) && !r.opensSubmenu);
    if (!target) {
      const topNames = new Set(top.map((r) => r.name.toLowerCase()));
      for (const group of top.filter((r) => r.opensSubmenu)) {
        const trigger = this.menuRow(group.name);
        await trigger.hover().catch(() => undefined);
        let children = await this.waitForNewRows(topNames);
        if (children.length === 0) {
          await trigger.click().catch(() => undefined);
          children = await this.waitForNewRows(topNames);
        }
        const found = children.find(wanted);
        if (found) {
          target = found;
          break;
        }
      }
    }

    if (!target) {
      await this.closeMenu();
      return { ok: false, current: before, reason: `The picker does not offer "${name}" any more.` };
    }
    if (target.disabled) {
      await this.closeMenu();
      return { ok: false, current: before, reason: `"${name}" is shown but not available right now.` };
    }

    await this.menuRow(target.name).click();
    await this.p.waitForTimeout(1_000);
    const after = await this.currentModel();

    // The button shows the choice, so it is the check. It also **shortens** it: picking
    // "GPT 5.6 Quick response" leaves the button reading "GPT 5.6 Quick". So a shown value
    // that is a piece of the asked one counts as agreement, and the full name is what gets
    // reported back, because that is what was actually chosen and what will be asked for
    // again next time.
    const asked = name.toLowerCase();
    const shown = (after ?? '').toLowerCase();
    if (shown && (shown === asked || shown.includes(asked) || asked.includes(shown))) {
      const settled = asked.includes(shown) ? name : (after as string);
      this.emit('model-selected', { model: settled, buttonShows: after });
      return { ok: true, current: settled };
    }
    return {
      ok: false,
      current: after,
      reason: `The chat reports "${after ?? 'unknown'}" after choosing "${name}".`,
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
      await this.dumpFailure(join(this.opts.downloadsDir, '..', 'failures'), 'reply-timeout').catch(
        () => undefined,
      );
      throw new Error(
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
    const html = await this.p.content().catch(() => '');
    if (html.length > 0) {
      await writeFile(join(dir, `${tag}.html`), html, 'utf8').catch(() => undefined);
    }
    await writeFile(join(dir, `${tag}.url.txt`), this.p.url(), 'utf8').catch(() => undefined);
    this.emit('failure-dumped', { dir, tag, url: this.p.url() });
  }
}
