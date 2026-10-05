/**
 * A scripted stand-in for Microsoft 365 Copilot, for the end-to-end checks.
 *
 * The real chat is a signed-in Edge window (`CopilotTransport`). Nothing in these checks may open
 * one: a check that did would need a person at the keyboard to sign in, would spend the hourly
 * message allowance and would put test tasks into the operator's real Copilot history. So every
 * check that runs a task installs this in its place through `setTransportFactory`, and this answers
 * from a script. It never starts a process, never opens a window and never touches the network.
 *
 * What it keeps is the shape of a chat that matters to the runner: conversations with ids and
 * names, a turn count that grows by one per exchange, a model picker, and replies as markdown with
 * a fenced JSON block in them. What it records is everything the runner sent — the text, the files
 * attached, and the contents of those files — so a check can assert on what the chat was told, not
 * only on what the runner did.
 *
 * The replies come from one queue, in order. The two contracts (level1.md at the start of a task
 * conversation, review1.md at the start of a review) are answered on their own with a short
 * acknowledgement and never take an entry from the queue, because neither reply is read by the
 * runner and a script that had to account for them would break every time the conversation's
 * opening changed. A message that finds the queue empty is an error in the check, reported as such
 * rather than answered with something invented.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatTransport, TransportFactory } from '../../src/transport/chatTransport.js';
import type { ModelChoice, ModelLocator, ModelOption, ReplyCapture, TransportOptions } from '../../src/transport/copilotTransport.js';
import { pageModelFor, sameModel } from '../../src/transport/modelMatch.js';

/** One message the runner sent, with the text of every file it attached. */
export type Sent = {
  chatId: string;
  text: string;
  attachments: string[];
  attached: Record<string, string>;
  /** Which kind of opening this was, when it was one. */
  contract?: 'task' | 'review';
};

/** What a scripted reply sees: the message it answers and every conversation so far. */
export type Incoming = Sent & { chat: FakeConversation; world: FakeCopilot };

export type Script = string | ((m: Incoming) => string | Promise<string>);

export type FakeConversation = { id: string; name?: string; messages: Sent[]; review: boolean };

const repoRoot = join(import.meta.dirname, '..', '..');

/** The first line of a contract file, which is how a message is recognised as that contract. */
function firstLine(file: string): string {
  const path = join(repoRoot, 'prompts', file);
  if (!existsSync(path)) return '\u0000never';
  return readFileSync(path, 'utf8').split(/\r?\n/).find((l) => l.trim())?.trim() ?? '\u0000never';
}

export class FakeCopilot {
  readonly sent: Sent[] = [];
  readonly conversations = new Map<string, FakeConversation>();
  /** Problems found while the chat was being used; a check asserts this stays empty. */
  readonly problems: string[] = [];
  /** How many chat windows were opened and closed, to show a run cleans up after itself. */
  opened = 0;
  closed = 0;
  /** Whether the window reports each reply as a browser event, as the real one reports what it sees. */
  emitEvents = false;
  /** How many naming tries find the conversation not yet in the sidebar (as live, 2026-10-05). */
  sidebarLate = 0;
  /** How many times a conversation was asked to be named. */
  nameTries = 0;
  models: ModelOption[] = [
    { name: 'Auto', raw: 'Auto', selected: true, disabled: false, role: 'menuitemradio' },
    { name: 'Think deeper', raw: 'Think deeper', selected: false, disabled: false, role: 'menuitemradio' },
    { name: 'GPT 5.6 Think deeper', raw: 'GPT 5.6 Think deeper', selected: false, disabled: false, role: 'menuitemradio', group: 'GPT' },
  ];
  currentModel = 'Auto';
  /** Every model the runner asked for, in order. */
  readonly modelRequests: string[] = [];
  /** Every model chosen, and how it was found: at the saved locator, at a fresh one, or by name. */
  readonly modelPicks: Array<{ name: string; by: 'locator' | 'reread' | 'name' }> = [];
  /** The accounts the page shows once signed in, for "Sign in" from Settings. */
  accounts: string[] = [];
  /** How often the sign-in was waited for and the profile signed out, and which accounts were asked for. */
  signIns = 0;
  signOuts = 0;
  readonly askedAccounts: string[] = [];

  private readonly queue: Script[] = [];
  private nextChat = 1;
  private readonly taskContract = firstLine('level1.md');
  private readonly reviewContract = firstLine('review1.md');

  /** Adds replies to the end of the queue. */
  script(...replies: Script[]): this {
    this.queue.push(...replies);
    return this;
  }

  /** Drops the replies nobody asked for, and says how many there were. */
  discard(): number {
    return this.queue.splice(0).length;
  }

  /** How many scripted replies have not been used yet. */
  get pending(): number {
    return this.queue.length;
  }

  /** The factory to hand to `setTransportFactory`. Every chat it makes shares this one "Copilot". */
  factory(): TransportFactory {
    return (opts) => new FakeChat(this, opts);
  }

  /** Messages that were not contracts: the ones the scripted replies answered. */
  get exchanged(): Sent[] {
    return this.sent.filter((m) => !m.contract);
  }

  /**
   * A conversation this "Copilot" did not start but has, the way the real one keeps every chat in
   * the account's history: for a second server that picks up the chat of a first one it replaced.
   */
  adopt(id: string, name?: string): FakeConversation {
    const c: FakeConversation = { id, name, messages: [], review: false };
    this.conversations.set(id, c);
    return c;
  }

  newConversation(): FakeConversation {
    const c: FakeConversation = { id: `fake-${String(this.nextChat++).padStart(4, '0')}`, messages: [], review: false };
    this.conversations.set(c.id, c);
    return c;
  }

  async answer(chat: FakeConversation, m: Sent): Promise<string> {
    if (m.text.includes(this.reviewContract)) {
      chat.review = true;
      m.contract = 'review';
      return 'Understood. I will review the work and answer in the required JSON format.';
    }
    if (chat.messages.length === 1 && m.text.includes(this.taskContract)) {
      m.contract = 'task';
      return 'Understood. Send the task.';
    }
    const next = this.queue.shift();
    if (next === undefined) {
      const problem = `the chat was sent a message the script has no reply for: ${m.text.slice(0, 160).replace(/\s+/g, ' ')}`;
      this.problems.push(problem);
      throw new Error(problem);
    }
    return typeof next === 'string' ? next : await next({ ...m, chat, world: this });
  }
}

/** One open "window": the transport the runner holds. */
class FakeChat implements ChatTransport {
  private current: FakeConversation | null = null;
  private waiting: Promise<string> | null = null;
  private isOpen = false;

  constructor(
    private readonly world: FakeCopilot,
    readonly opts: TransportOptions,
  ) {}

  async open(): Promise<void> {
    this.world.opened += 1;
    this.isOpen = true;
  }

  async close(): Promise<void> {
    if (this.isOpen) this.world.closed += 1;
    this.isOpen = false;
  }

  async ensureSignedIn(): Promise<void> {
    if (!this.isOpen) throw new Error('ensureSignedIn before open');
    this.world.signIns += 1;
  }

  async signOut(): Promise<void> {
    if (!this.isOpen) throw new Error('signOut before open');
    this.world.signOuts += 1;
  }

  async gotoChatAs(upn: string | undefined): Promise<void> {
    if (!this.isOpen) throw new Error('gotoChatAs before open');
    this.world.askedAccounts.push(upn ?? '');
  }

  async findAccountsInPage(): Promise<string[]> {
    return [...this.world.accounts];
  }

  async newChat(): Promise<void> {
    this.current = this.world.newConversation();
  }

  async openConversation(chatId: string): Promise<boolean> {
    const c = this.world.conversations.get(chatId);
    if (!c) return false;
    this.current = c;
    return true;
  }

  async openConversationByName(name: string): Promise<boolean> {
    const c = [...this.world.conversations.values()].find((x) => x.name === name);
    if (!c) return false;
    this.current = c;
    return true;
  }

  async currentChatId(): Promise<string | null> {
    return this.current?.messages.length ? this.current.id : null;
  }

  async nameChat(chatId: string, name: string): Promise<boolean> {
    const c = this.world.conversations.get(chatId);
    this.world.nameTries += 1;
    if (!c) return false;
    // As the live sidebar: a new conversation's row comes some seconds late, so the first tries find nothing.
    if (this.world.sidebarLate > 0) {
      this.world.sidebarLate -= 1;
      return false;
    }
    c.name = name;
    return true;
  }

  /** The line-up as the real picker reads it: each model with its place (see `ModelLocator`). */
  private lineUp(): ModelOption[] {
    const groups = [...new Set(this.world.models.filter((m) => m.group).map((m) => m.group!))];
    const top = this.world.models.filter((m) => !m.group);
    return this.world.models.map((m) => {
      if (!m.group) return { ...m, locator: { role: m.role, index: top.indexOf(m) } };
      const inGroup = this.world.models.filter((x) => x.group === m.group);
      const g = groups.indexOf(m.group);
      return { ...m, locator: { role: m.role, index: inGroup.indexOf(m), group: { testId: `${m.group.toLowerCase()}SubMenuModelTrigger`, index: top.length + g, name: m.group } } };
    });
  }

  async selectModel(name: string, opts: { locator?: ModelLocator } = {}): Promise<ModelChoice> {
    this.world.modelRequests.push(name);
    const line = this.lineUp();
    const at = (l: ModelLocator): ModelOption | undefined =>
      line.find((o) => o.locator && o.locator.index === l.index && (o.locator.group?.testId ?? '') === (l.group?.testId ?? '') && sameModel(o.name, name));
    const choose = (o: ModelOption, by: 'locator' | 'reread' | 'name'): ModelChoice => {
      this.world.currentModel = o.name;
      for (const m of this.world.models) m.selected = m.name === o.name;
      this.world.modelPicks.push({ name: o.name, by });
      return { ok: true, current: o.name, by };
    };
    if (opts.locator) {
      const hit = at(opts.locator);
      if (hit) return choose(hit, 'locator');
    }
    // As the real picker does: the line-up read again, and the model found by name, or under its new name.
    const match = line.find((o) => sameModel(o.name, name)) ?? pageModelFor(name, line);
    if (!match) return { ok: false, current: this.world.currentModel, reason: `The picker does not offer "${name}" any more; it offers ${line.filter((o) => !o.disabled).map((o) => `"${o.name}"`).join(', ')}.`, options: line };
    return { ...choose(match, opts.locator ? 'reread' : 'name'), ...(sameModel(match.name, name) ? {} : { matched: match.name }), options: line };
  }

  async listModels(): Promise<{ options: ModelOption[]; current: string | null; note?: string }> {
    return { options: this.lineUp(), current: this.world.currentModel };
  }

  async sendAndConfirm(text: string, attachments: string[] = []): Promise<number> {
    if (!this.isOpen) throw new Error('send on a closed chat');
    if (this.waiting) this.world.problems.push('a message was sent before the reply to the previous one was read');
    if (!this.current) this.current = this.world.newConversation();
    const chat = this.current;
    const before = chat.messages.length;
    const attached: Record<string, string> = {};
    for (const p of attachments) attached[p] = existsSync(p) ? readFileSync(p, 'utf8') : '(missing)';
    const m: Sent = { chatId: chat.id, text, attachments, attached };
    chat.messages.push(m);
    this.world.sent.push(m);
    this.waiting = this.world.answer(chat, m);
    // A rejection is read by waitForReply; this keeps it from being reported as unhandled first.
    this.waiting.catch(() => undefined);
    return before;
  }

  async waitForReply(): Promise<ReplyCapture> {
    if (this.world.emitEvents) this.opts.onEvent?.('reply-arrived', { chatId: this.current?.id ?? null });
    if (!this.waiting) throw new Error('waitForReply with nothing sent');
    const pending = this.waiting;
    this.waiting = null;
    const markdown = await pending;
    return { markdown, degraded: false, attachments: [], codeBlocksDom: [] };
  }

  async dumpFailure(): Promise<void> {
    /* nothing to capture: there is no page */
  }

  async recentCrash(): Promise<null> {
    return null;
  }
}

// --- replies -------------------------------------------------------------------------------

function fenced(value: unknown): string {
  return `Here is my answer.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

type StepIn = string | { cmd: string; shell?: 'pwsh' | 'powershell' | 'cmd'; expect?: 'fast' | 'long' };

/** Replies in the format of prompts/level1.md and prompts/review1.md. */
export const reply = {
  steps(...steps: StepIn[]): string {
    return fenced({
      status: 'continue',
      notes: 'Plan: 1. do the work 2. check it',
      steps: steps.map((s, i) => ({ id: i + 1, type: 'command', ...(typeof s === 'string' ? { cmd: s } : s) })),
    });
  },
  done(summary = 'The work is finished. I created the files the task asked for and checked that they are there and hold the right text.'): string {
    return fenced({ status: 'done', summary });
  },
  blocked(summary = 'I could not finish: the file the task names is not in the repository, and nothing I tried brought it back.'): string {
    return fenced({ status: 'blocked', summary, tried: ['looked for the file by name', 'searched the whole tree for it'], needed: 'the missing file' });
  },
  pass(summary = 'I read the changed files and ran the checks: the file exists and holds exactly the text the task asked for.'): string {
    return fenced({ status: 'pass', summary });
  },
  /**
   * One step, then "blocked": a chat that tried and gave up. A "blocked" before any step ran is sent back
   * by the runner (live-fixes C5), so a script that means "this attempt gives up" uses these two.
   */
  triedThenBlocked(): string[] {
    return [reply.steps('Get-ChildItem'), reply.blocked()];
  },
  /** Not JSON at all: what a chat that forgot the format sends. */
  prose(text = 'Sure! I will get right on that.'): string {
    return text;
  },
};
