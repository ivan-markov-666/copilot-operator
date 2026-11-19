/**
 * The chat's window, kept for the work while a message is at work (operator, 2026-11-13: "if I close the browser with
 * the chat on Microsoft 365 Copilot by accident, I want the bot to carry the task on from where it got to").
 *
 * Every chat the runner works through — one chat, the lead and its worker, Kerrigan and the chats she directs, the
 * review — gets its window from `createTransport`, and so through this. While a message is at work (`holdWindow`), a
 * window closed under it — its X, or Edge ending — is opened again at once, on the conversation it was on (`reopen` of
 * the window itself: by its address, after a sign-in, or by its name), up to `limits.reopenWindow` times for one
 * message; then the work goes on there:
 *
 *   - what was to be sent is sent in the window opened again: a report of commands that ran meanwhile, an answer given
 *     on a card, a note — nothing of it is lost, since none of it lived in the page;
 *   - a message the window closed on while it was being sent is sent again, saying it is a copy, since whether it
 *     reached the chat cannot be told;
 *   - an answer the chat was writing when the window closed did not reach the window, and is not read from the page
 *     opened again either — what that page shows of a cut-off answer cannot be trusted — so the chat is asked to send it
 *     again, in full.
 *
 * Past that number, or when the window cannot be put back on its conversation, the work on the message stops as it did
 * before 2026-11-13, with why (`WindowClosed`), and "Continue" carries it on from where it got to. Between messages
 * nothing is held: a window closed then is the next message's to open, as it always was.
 *
 * Kept apart from `CopilotTransport` so that the scripted chat of the checks goes through the same rules as the real
 * window: what is checked is this, not a copy of it.
 */
import type { CopilotTransport, OnChat, ReplyCapture, TransportOptions } from './copilotTransport.js';
import { WindowClosed } from './copilotTransport.js';

/** What a window itself does: the real Copilot window, or the scripted chat of the checks. */
export type ChatWindow = Pick<
  CopilotTransport,
  | 'open'
  | 'close'
  | 'reopen'
  | 'isOpen'
  | 'closedOutside'
  | 'showNotice'
  | 'clearNotice'
  | 'ensureSignedIn'
  | 'newChat'
  | 'openConversation'
  | 'openConversationByName'
  | 'currentChatId'
  | 'ensureOnChat'
  | 'nameChat'
  | 'selectModel'
  | 'currentModel'
  | 'listModels'
  | 'checkLocators'
  | 'takeSettings'
  | 'sendAndConfirm'
  | 'waitForReply'
  | 'dumpFailure'
  | 'recentCrash'
  | 'signOut'
  | 'gotoChatAs'
  | 'findAccountsInPage'
>;

/** The chat asked for the answer it was writing when the window closed. */
export const ASK_AGAIN =
  'The browser window was closed while you were writing your answer to my last message, so your answer did not reach ' +
  'me. Send that answer again, in full and in the same format as before.';

/** Put before a message sent again after the window closed while it was being sent. */
export const SENT_AGAIN =
  '(Sent again: the browser window was closed while this message was being sent. If it reached you already, answer ' +
  'this copy only.)';

/** Why a message stopped when its window was closed and Settings say not to open it again. */
export const CLOSED_NOT_REOPENED = 'the browser window was closed; nothing more was sent';

type Speak = (event: string, detail?: Record<string, unknown>) => void;

export class KeptWindow implements ChatWindow {
  /** Whether a message is at work: only then is a window closed under it opened again. */
  private atWork = false;
  /** How many times it may still be opened again for the message at work, of how many. */
  /** Times opened again for the message at work. */
  private used = 0;
  /** How many Settings allow, read each time: saved during the message, it counts at once (bug hunt 2026-11-18). */
  private allowed: () => number = () => 0;
  private signal: AbortSignal | undefined;
  /** It is being opened again now. */
  private back: Promise<void> | null = null;
  /** Why the work on the message cannot go on in it: closed past the number, or not put back on its conversation. */
  private gaveUp: WindowClosed | null = null;
  /** How many times it has gone, so a call can tell it went while it ran. */
  private generation = 0;
  /** Which of those the last message sent went out in: an answer is read only from the window its message went in. */
  private sentIn = -1;

  constructor(
    private readonly inner: ChatWindow,
    private readonly speak: Speak = () => undefined,
  ) {}

  /**
   * A message is at work: a window closed under it is opened again up to `times` times (`limits.reopenWindow`; 0 is
   * none, as before 2026-11-13), and its Stop ends a reopening under way. Called for each message the runner takes.
   */
  holdWindow(times: number | (() => number), signal?: AbortSignal): void {
    this.atWork = true;
    this.allowed = () => Math.max(0, Math.floor(typeof times === 'function' ? times() : times));
    this.used = 0;
    this.signal = signal;
    this.gaveUp = null;
  }

  /**
   * No message at work any more: a window closed now is the next message's to open. Waits for a reopening under way; the
   * window is then what it is — open, or gone — for whoever holds it next.
   */
  async releaseWindow(): Promise<void> {
    this.atWork = false;
    await this.back?.catch(() => undefined);
    this.gaveUp = null;
  }

  /** How many times the window was opened again for the message at work. */
  reopenedTimes(): number {
    return this.used;
  }

  /** Told by the window when it went (its `window-closed`): opened again at once while a message is at work. */
  windowWent(): void {
    this.generation += 1;
    if (!this.atWork || this.back) return;
    this.back = this.bringBack().finally(() => {
      this.back = null;
    });
  }

  private async bringBack(): Promise<void> {
    for (;;) {
      if (this.signal?.aborted) {
        this.gaveUp = new WindowClosed('the browser window was closed, and the work was stopped before it was opened again; nothing more was sent');
        return;
      }
      const allowed = this.allowed();
      if (this.used >= allowed) {
        this.gaveUp = new WindowClosed(
          this.used === 0
            ? CLOSED_NOT_REOPENED
            : `the browser window was closed ${this.used + 1} times while this message was at work; it was opened again ${this.used} time(s), ` +
                `${this.used === allowed ? 'as many as Settings allow' : `and Settings now allow ${allowed}`} for one message (limits.reopenWindow), so nothing more was sent`,
        );
        this.speak('window-not-reopened', { reason: this.gaveUp.message, times: this.used });
        return;
      }
      this.used += 1;
      const time = this.used;
      const gen = this.generation;
      this.speak('window-reopening', { time, of: allowed });
      try {
        const at: OnChat = await this.inner.reopen({ signal: this.signal });
        if (this.generation !== gen) continue;
        this.speak('window-reopened', { time, of: allowed, ...('chatId' in at ? { chatId: at.chatId } : {}) });
        return;
      } catch (e) {
        // Closed again while it was being opened: another time, if there is one left.
        if (this.generation !== gen && !this.signal?.aborted) continue;
        const why = (e as Error).message;
        this.gaveUp = new WindowClosed(
          e instanceof WindowClosed
            ? why
            : this.signal?.aborted
              ? 'the browser window was closed, and the work was stopped while it was being opened again; nothing more was sent'
              : `the browser window was closed, and it could not be opened again on its conversation: ${why}`,
        );
        this.speak('window-not-reopened', { reason: this.gaveUp.message, times: time });
        return;
      }
    }
  }

  /** Before a call that needs the window: one being opened again is waited for; one that cannot be, said. */
  private async ready(): Promise<void> {
    if (!this.back && this.atWork && !this.gaveUp && this.inner.closedOutside()) this.windowWent();
    if (this.back) await this.back;
    if (this.gaveUp) throw this.gaveUp;
  }

  /**
   * A call on the window, made again when the window went while it ran and was opened again; `again` says it is the
   * second time. Bounded by the number of times it may be opened: past it, `ready` throws.
   */
  private async withWindow<T>(call: (again: boolean) => Promise<T>): Promise<T> {
    let again = false;
    for (;;) {
      await this.ready();
      const gen = this.generation;
      try {
        return await call(again);
      } catch (e) {
        const went = gen !== this.generation || this.inner.closedOutside();
        if (!went || !this.atWork) throw e;
        again = true;
      }
    }
  }

  async sendAndConfirm(text: string, attachments: string[] = [], maxAttempts?: number): Promise<number> {
    let wentIn = -1;
    const before = await this.withWindow(async (again) => {
      wentIn = this.generation;
      if (again) this.speak('message-sent-again', { chars: text.length });
      return await this.inner.sendAndConfirm(again ? `${SENT_AGAIN}\n\n${text}` : text, attachments, maxAttempts);
    });
    // The window it went out in: closed as it was taken, its answer is asked for again (see `waitForReply`).
    this.sentIn = wentIn;
    return before;
  }

  async waitForReply(previousTurns: number): Promise<ReplyCapture> {
    return await this.withWindow(async (again) => {
      if (!again && this.sentIn === this.generation) return await this.inner.waitForReply(previousTurns);
      // The window its message went out in is gone, and with it the answer being written: asked for again.
      const asked = this.generation;
      const before = await this.inner.sendAndConfirm(ASK_AGAIN);
      this.sentIn = asked;
      this.speak('reply-asked-again', { text: ASK_AGAIN });
      if (this.generation !== asked) throw new WindowClosed('closed again as the answer was asked for');
      return await this.inner.waitForReply(before);
    });
  }

  /** Whether the window is gone for the work: closed, and not being opened again, or past opening again. */
  closedOutside(): boolean {
    if (this.gaveUp) return true;
    if (this.back) return false;
    return this.inner.closedOutside();
  }

  // --- the rest, as the window does them; made again in a window opened again under the work ----------------------

  open(): Promise<void> {
    return this.inner.open();
  }
  async close(): Promise<void> {
    this.atWork = false;
    await this.back?.catch(() => undefined);
    await this.inner.close();
  }
  reopen(opts?: { signal?: AbortSignal }): Promise<OnChat> {
    return this.inner.reopen(opts);
  }
  isOpen(): boolean {
    return this.inner.isOpen();
  }
  ensureSignedIn(...a: Parameters<ChatWindow['ensureSignedIn']>): ReturnType<ChatWindow['ensureSignedIn']> {
    return this.inner.ensureSignedIn(...a);
  }
  signOut(...a: Parameters<ChatWindow['signOut']>): ReturnType<ChatWindow['signOut']> {
    return this.inner.signOut(...a);
  }
  gotoChatAs(...a: Parameters<ChatWindow['gotoChatAs']>): ReturnType<ChatWindow['gotoChatAs']> {
    return this.inner.gotoChatAs(...a);
  }
  findAccountsInPage(...a: Parameters<ChatWindow['findAccountsInPage']>): ReturnType<ChatWindow['findAccountsInPage']> {
    return this.inner.findAccountsInPage(...a);
  }
  dumpFailure(...a: Parameters<ChatWindow['dumpFailure']>): ReturnType<ChatWindow['dumpFailure']> {
    return this.inner.dumpFailure(...a);
  }
  recentCrash(...a: Parameters<ChatWindow['recentCrash']>): ReturnType<ChatWindow['recentCrash']> {
    return this.inner.recentCrash(...a);
  }
  showNotice(...a: Parameters<ChatWindow['showNotice']>): ReturnType<ChatWindow['showNotice']> {
    return this.withWindow(() => this.inner.showNotice(...a));
  }
  clearNotice(...a: Parameters<ChatWindow['clearNotice']>): ReturnType<ChatWindow['clearNotice']> {
    return this.withWindow(() => this.inner.clearNotice(...a));
  }
  newChat(...a: Parameters<ChatWindow['newChat']>): ReturnType<ChatWindow['newChat']> {
    return this.withWindow(() => this.inner.newChat(...a));
  }
  openConversation(...a: Parameters<ChatWindow['openConversation']>): ReturnType<ChatWindow['openConversation']> {
    return this.withWindow(() => this.inner.openConversation(...a));
  }
  openConversationByName(...a: Parameters<ChatWindow['openConversationByName']>): ReturnType<ChatWindow['openConversationByName']> {
    return this.withWindow(() => this.inner.openConversationByName(...a));
  }
  currentChatId(...a: Parameters<ChatWindow['currentChatId']>): ReturnType<ChatWindow['currentChatId']> {
    return this.withWindow(() => this.inner.currentChatId(...a));
  }
  ensureOnChat(...a: Parameters<ChatWindow['ensureOnChat']>): ReturnType<ChatWindow['ensureOnChat']> {
    return this.withWindow(() => this.inner.ensureOnChat(...a));
  }
  nameChat(...a: Parameters<ChatWindow['nameChat']>): ReturnType<ChatWindow['nameChat']> {
    return this.withWindow(() => this.inner.nameChat(...a));
  }
  selectModel(...a: Parameters<ChatWindow['selectModel']>): ReturnType<ChatWindow['selectModel']> {
    return this.withWindow(() => this.inner.selectModel(...a));
  }
  currentModel(...a: Parameters<ChatWindow['currentModel']>): ReturnType<ChatWindow['currentModel']> {
    return this.withWindow(() => this.inner.currentModel(...a));
  }
  listModels(...a: Parameters<ChatWindow['listModels']>): ReturnType<ChatWindow['listModels']> {
    return this.withWindow(() => this.inner.listModels(...a));
  }

  checkLocators(...a: Parameters<ChatWindow['checkLocators']>): ReturnType<ChatWindow['checkLocators']> {
    return this.withWindow(() => this.inner.checkLocators(...a));
  }

  /** Settings saved since the window opened: taken by it, open or not (a window opened again is the same one). */
  takeSettings(...a: Parameters<ChatWindow['takeSettings']>): void {
    this.inner.takeSettings(...a);
  }
}

/** A window kept for the work, its `window-closed` heard as it happens. */
export function keptWindow(make: (opts: TransportOptions) => ChatWindow, opts: TransportOptions): KeptWindow {
  let kept: KeptWindow | null = null;
  const inner = make({
    ...opts,
    onEvent: (event, detail) => {
      opts.onEvent?.(event, detail);
      if (event === 'window-closed') kept?.windowWent();
    },
  });
  kept = new KeptWindow(inner, (event, detail) => opts.onEvent?.(event, detail));
  return kept;
}
