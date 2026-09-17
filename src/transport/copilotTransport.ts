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
import { Css, Label, Rename, Sidebar, Signal, TestId, Upload, Url } from './locators.js';
import { parseChatId } from './chatSession.js';

export type TransportOptions = {
  profileDir: string;
  downloadsDir: string;
  chatUrl: string;
  channel: 'msedge' | 'chrome' | 'chromium';
  headless: boolean;
  replyTimeoutMs: number;
  signInTimeoutMs: number;
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

  constructor(private readonly opts: TransportOptions) {}

  private emit(event: string, detail?: Record<string, unknown>): void {
    this.opts.onEvent?.(event, detail);
  }

  private get p(): Page {
    if (!this.page) throw new Error('Transport is not open. Call open() first.');
    return this.page;
  }

  async open(): Promise<void> {
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
   * Opens the chat and, if the tenant has signed us out, waits for the human. The bot never
   * types credentials; it only waits for the composer to appear.
   */
  async ensureSignedIn(url = this.opts.chatUrl): Promise<void> {
    await this.p.goto(url, { waitUntil: 'domcontentloaded' });
    if (await this.isChatReady(15_000)) return;

    this.emit('sign-in-required', { url: this.p.url() });
    await this.composer().waitFor({ state: 'visible', timeout: this.opts.signInTimeoutMs });
    this.emit('signed-in');
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

  /** Waits for the answer to finish streaming, then returns its raw markdown. */
  async waitForReply(previousTurns: number): Promise<ReplyCapture> {
    const deadline = Date.now() + this.opts.replyTimeoutMs;

    // 1. A new turn appears.
    await this.p.waitForFunction(
      ({ testId, n }) => document.querySelectorAll(`[data-testid="${testId}"]`).length > n,
      { testId: TestId.turn, n: previousTurns },
      { timeout: this.opts.replyTimeoutMs },
    );

    // 2. Streaming ends: the Stop button disappears and the newest answer exposes its copy
    //    button. The copy button is NOT inside `lastChatMessage` (that is only the answer
    //    body); both live inside `copilot-message-div`, so that is the anchor. And
    //    `[data-testid="loading-message"]` is not usable at all: it stays in the DOM.
    await this.p.waitForFunction(
      ({ stopLabel, wrapperSel, copySel }) => {
        const streaming = Array.from(document.querySelectorAll('button')).some(
          (b) => b.getAttribute('aria-label') === stopLabel,
        );
        const wrappers = document.querySelectorAll(wrapperSel);
        const last = wrappers[wrappers.length - 1];
        return !streaming && !!last && !!last.querySelector(copySel);
      },
      {
        stopLabel: Label.stopGenerating,
        wrapperSel: Signal.answerWrapper,
        copySel: Signal.copyButtonInAnswer,
      },
      { timeout: Math.max(5_000, deadline - Date.now()) },
    );

    // 3. Let the text settle: the widget re-renders briefly after the stream ends.
    let previous = '';
    for (let i = 0; i < 20; i += 1) {
      const now = await this.lastMessageText();
      if (now === previous && now.length > 0) break;
      previous = now;
      await this.p.waitForTimeout(400);
    }

    const attachments = await this.lastMessageAttachmentNames();
    const { markdown, degraded } = await this.copyLastReply();
    this.emit('reply-received', { chars: markdown.length, degraded, attachments: attachments.length });
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

  /** Screenshot plus HTML dump, for when a locator stops matching. */
  async dumpFailure(dir: string, tag: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await this.p.screenshot({ path: join(dir, `${tag}.png`), fullPage: true }).catch(() => undefined);
    const html = await this.p.content().catch(() => '');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, `${tag}.html`), html, 'utf8').catch(() => undefined);
    this.emit('failure-dumped', { dir, tag });
  }
}
