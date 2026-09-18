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
import { chromium, type BrowserContext, type Page, type Download, type Locator } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Blocker, Css, Label, Rename, Sidebar, Signal, Surface, TestId, Upload, Url } from './locators.js';
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
};

const ORIGIN = 'https://m365.cloud.microsoft';

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

    // Required for reading replies: the page's own clipboard read is denied otherwise.
    await this.context
      .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN })
      .catch(() => this.emit('clipboard-permission-failed'));

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
  async detectBlocker(): Promise<'verification' | 'error-banner' | 'none'> {
    try {
      const text = (await this.p.locator('body').innerText({ timeout: 5_000 }).catch(() => '')) ?? '';
      if (Blocker.verificationText.some((t) => text.includes(t))) return 'verification';

      const frames = this.p.frames().map((f) => f.url());
      if (frames.some((u) => Blocker.challengeFrameHosts.some((h) => u.includes(h)))) return 'verification';

      if (Blocker.errorBannerText.some((t) => text.includes(t))) return 'error-banner';
    } catch {
      /* a closed or navigating page is handled by the caller */
    }
    return 'none';
  }

  /**
   * Waits for a human to clear a challenge, or clears a transient error banner itself.
   *
   * Returns true when the page became usable again. The checkbox is deliberately left
   * untouched: completing a human-verification check is the human's part of this.
   */
  async handleBlocker(kind: 'verification' | 'error-banner'): Promise<boolean> {
    if (kind === 'error-banner') {
      this.emit('error-banner', { action: 'reloading' });
      const refresh = this.p.getByRole('button', { name: Blocker.refreshLabel, exact: true });
      if ((await refresh.count()) > 0) await refresh.first().click().catch(() => undefined);
      else await this.p.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await this.p.waitForTimeout(3_000);
      return (await this.detectBlocker()) === 'none';
    }

    const waitMs = this.opts.humanWaitMs ?? 15 * 60_000;
    this.emit('verification-required', { waitMs });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await this.p.waitForTimeout(3_000);
      if ((await this.detectBlocker()) === 'none') {
        this.emit('verification-cleared');
        return true;
      }
    }
    return false;
  }

  /** Detects a blocker and waits it out. Throws when it is still there after the wait. */
  private async clearBlockers(): Promise<void> {
    for (let i = 0; i < 3; i += 1) {
      const kind = await this.detectBlocker();
      if (kind === 'none') return;
      const cleared = await this.handleBlocker(kind);
      if (cleared) return;
      if (kind === 'verification') {
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

  /** Best-effort dismissal of first-run dialogs. Unknown ones are left alone and reported. */
  async dismissPopups(): Promise<void> {
    for (const name of ['Got it', 'Close', 'Dismiss', 'No thanks', 'Skip']) {
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

    await row.hover();
    const more = row
      .locator('xpath=ancestor-or-self::*[self::li or self::div][1]')
      .getByRole('button', { name: Rename.moreButtonLabel, exact: true });
    if ((await more.count()) === 0) return false;
    await more.first().click();

    const item = this.p.getByRole('menuitem', { name: Rename.menuItem, exact: true });
    if ((await item.count()) === 0) return false;
    await item.first().click();

    const input = this.p.locator(Rename.input);
    await input.waitFor({ state: 'visible', timeout: 10_000 });
    await input.fill(name.slice(0, Rename.maxLength));
    await this.p.getByRole('button', { name: Rename.saveText, exact: true }).first().click();
    await input.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);

    this.emit('chat-named', { chatId, name });
    return true;
  }

  private async turnCount(): Promise<number> {
    return await this.p.getByTestId(TestId.turn).count();
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

    const send = this.p.getByRole('button', { name: Label.send, exact: true });
    await send.waitFor({ state: 'visible', timeout: 20_000 });
    await send.click();
    this.emit('message-sent', { chars: text.length, attachments: attachments.length });
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
          const turns = document.querySelectorAll(turnSel).length;
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
        if (blocker !== 'none') {
          this.emit('blocker-during-reply', { blocker });
          await this.clearBlockers();
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
    const { markdown, degraded } = await this.copyLastReply();
    this.emit('reply-received', {
      chars: markdown.length,
      degraded,
      attachments: attachments.length,
      waitedMs: Date.now() - startedAt,
    });
    return { markdown, degraded, attachments };
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
   * Clicks "Copy Response" and reads the clipboard, which yields the whole answer as raw
   * markdown with the fences intact. Falls back to the DOM text, flagged as degraded,
   * because that text is known to be lossy.
   */
  private async copyLastReply(): Promise<{ markdown: string; degraded: boolean }> {
    const copy = this.lastAnswer().getByTestId(TestId.copyResponse).first();
    try {
      await copy.click({ timeout: 15_000 });
      await this.p.waitForTimeout(300);
      const text = await this.p.evaluate(async () => await navigator.clipboard.readText());
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
  async downloadAttachment(fileName: string, saveAs: string): Promise<string> {
    const link = this.lastAnswer()
      .locator(`${Css.downloadLink}[download="${fileName.replace(/"/g, '\\"')}"]`)
      .first();
    if ((await link.count()) === 0) {
      throw new Error(`Copilot did not attach a file named "${fileName}" to its last reply.`);
    }

    const fromPage = this.p.waitForEvent('download', { timeout: 120_000 });
    const fromPopup = this.context
      ?.waitForEvent('page', { timeout: 120_000 })
      .then((pg) => pg.waitForEvent('download', { timeout: 120_000 }));

    await link.click();

    const download: Download = await Promise.race(
      [fromPage, fromPopup].filter(Boolean) as Array<Promise<Download>>,
    );
    await download.saveAs(saveAs);
    this.emit('downloaded', { fileName, saveAs });
    return saveAs;
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
      await writeFile(
        join(dir, `${tag}.txt`),
        'The page was already closed when the failure was recorded, so there is nothing to ' +
          'capture. This usually means the browser window was closed, or another Edge process ' +
          'was using the same profile.',
        'utf8',
      ).catch(() => undefined);
      this.emit('failure-dump-empty', { dir, tag });
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
