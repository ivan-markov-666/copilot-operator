/**
 * Kerrigan directs (operator, 2026-11-12): "I copy Kerrigan into a chat — the project's description, the skills, all of
 * it set in Settings. She says she is Kerrigan, give her the tasks. I give her the task and we start: she gives me a
 * prompt for the bot and says whether plan mode, two chats, the reviewer, which skill. I do that by hand and start the
 * bot. When the bot asks me something, I take its question with its answers to her, and she tells me what to press and
 * what to add; the bot goes on. At the end she reads the result; if there is a problem she goes on with a new prompt,
 * for a new chat or the same one — she decides. I give the task; from there she very rarely needs me." And, the same
 * day: "not that it never asks — fewer questions: have it look in the internal sources first, mail, chats,
 * transcripts, shared files, the code, the Azure CLI."
 *
 * So a message of such a conversation is run here. The conversation is hers: she is given her contract
 * (`prompts/kerrigan1.md`) and the facts of this machine (`kerriganBrief`), then the person's task, and every reply of
 * hers is one decision in the shape `protocol/kerriganSchema.ts` holds it to. A message she writes for a chat becomes a
 * task of a chat of its own (`Session.directedBy`), a conversation in the same Copilot window, run as any chat message
 * is — by `runTask`, or by `runLeadTask` when she asked for two chats — with its plan mode, review and skill as she
 * chose. The chats are conversations of the list: the person can open one and follow it as it works.
 *
 * The chat's cards that are hers (the person's choice, 2026-11-12: "questions, plans, retries; the commands as Settings
 * say") go to her while it waits: the window goes to her conversation, she answers — or leaves the card to the person,
 * with why and what she would choose — and goes back to the chat's before the card is answered, so the chat goes on
 * where it was. The person may answer a card first; theirs is taken, hers is not. Commands, platform access, scripts
 * handed over, passwords, sign-ins and models chosen by hand never come to her. When the chat's work on her message has
 * ended, its result goes to her: how it ended, the summary, the commands and their exit codes, the files, the review.
 * She goes on, or delivers her report, which is the message's summary.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { ChatLost, isReplyTimeout, WindowClosed, type ChatTransport } from '../transport/chatTransport.js';
import { CLOSED_NOT_REOPENED } from '../transport/keptWindow.js';
import { buildChatName, chatCode, savePointer, type ChatPointer } from '../transport/chatSession.js';
import { RunLog } from '../log/runLog.js';
import { gapFrom, Pacer } from '../util/pacing.js';
import { takeAfter, takeCheckpoint } from '../session/checkpoint.js';
import { commitFiles } from '../vcs/git.js';
import { buildTaskExchange } from '../session/taskExchange.js';
import { redactSecrets } from '../exec/redaction.js';
import { operatorNotesSection } from '../session/compose.js';
import { KERRIGAN_UNDERSTANDING_FIRST, kerriganFormatErrorMessage, parseKerriganReply, type KerriganReply } from '../protocol/kerriganSchema.js';
import { cardCopyText, endingCopyText } from './cardText.js';
import { chosenSaid } from './chosenAnswers.js';
import { runLeadTask } from './leadRunner.js';
import {
  applySessionModel,
  enterSessionConversation,
  holdsWhilePaused,
  limitsMessageLength,
  redactsMessages,
  runTask,
  Sink,
  speakFor,
  spokenFor,
  staysOnItsChat,
  StoppedSend,
  type CardHandle,
  type PlanAnswer,
  type QuestionAnswer,
  type RunDeps,
  type TaskOutcome,
} from './taskRunner.js';
import type { Acting, Actor, KerriganRecord, KerriganRound, PendingApproval, RetryChoice, Session, Task, TaskLimit, TaskPlan } from '../session/model.js';
import { DEFAULT_VCS } from '../session/store.js';

const RETRY_WORDS: Record<RetryChoice, string> = {
  same: 'try it again in the same worker\'s conversation',
  fresh: 'try it again in a new worker conversation',
  continue: 'carry on from the folder as it is',
  restore: 'put the folder back to how it was when the subtask began, and try again',
  accept: 'go back to the lead with what was done',
};

/** How a chat's work on a message ended, in a few words. */
function endedAs(status: TaskOutcome['status'] | Task['status']): string {
  switch (status) {
    case 'done':
      return 'done — the chat says it is finished';
    case 'blocked':
      return 'blocked — the chat could not take it further';
    case 'failed':
      return 'failed — the run itself failed';
    case 'aborted':
      return 'stopped';
    case 'limit-reached':
      return 'limit-reached — a limit of Settings stopped it; it can be carried on in the same chat';
    default:
      return String(status);
  }
}

/** A card of a chat she directs, as it reached her. */
type Card =
  | { kind: 'question'; ask: { sessionId: string; taskId: string; question: string; why?: string; options: string[]; commands?: Array<string | null>; multiple?: boolean; actor?: Actor }; card: CardHandle<QuestionAnswer> }
  | { kind: 'plan'; ask: { sessionId: string; taskId: string; title: string; plan: TaskPlan; actor?: Actor }; card: CardHandle<PlanAnswer> }
  | { kind: 'retry'; ask: { sessionId: string; taskId: string; retry: NonNullable<PendingApproval['retry']> }; card: CardHandle<RetryChoice> };

/**
 * The window, while she has it for a card: the chat whose card it is waits for it before it goes on, should the person
 * answer the card while she still writes.
 */
class WindowLease {
  private held: { done: Promise<void>; release: () => void } | null = null;

  take(): void {
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.held = { done, release };
  }

  release(): void {
    const held = this.held;
    this.held = null;
    held?.release();
  }

  /** Resolves once nobody holds the window; at once on Stop. */
  async free(signal?: AbortSignal): Promise<void> {
    while (this.held && !signal?.aborted) {
      const held = this.held;
      await new Promise<void>((resolve) => {
        void held.done.then(resolve);
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  }
}

/** Her reply was not one that could be acted on, past the retries Settings allow. */
class FormatLimit extends Error {}

/** The most of a chat message's exchange she is sent, as characters of its JSON; the rest is cut, and said so. */
export const MAX_EXCHANGE_CHARS = 2_000_000;

/** A text fenced with more backticks than any run in it, so it is shown as it is. */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((x) => x.length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}text\n${text.trim()}\n${f}`;
}

/** The opening: the person's task, with what the runner tells her about it. */
export function kerriganTaskMessage(task: Pick<Task, 'prompt' | 'skill' | 'continuing'>, n: number, facts: { maxSends: number; chat?: { name: string; title?: string } }, again: boolean): string {
  return [
    again
      ? 'A new task from the person, in this same conversation. Your contract and the facts you were given at the start still apply unchanged: the same format, the same rules. Restate this task in "understanding" in your first reply to it.'
      : '',
    task.continuing
      ? `The person asks you to carry on with this task (message ${n} of this conversation), which stopped before it was done${task.continuing.stoppedBecause ? `: ${task.continuing.stoppedBecause}` : ''}. What was done is above, in this conversation; the folder is as it was left.`
      : `The person's task (message ${n} of this conversation):`,
    '',
    task.prompt.trim(),
    '',
    /*
     * The skill the task is for (2026-11-12: "the information Kerrigan needs for the task is loaded: we already know it is
     * for such a skill"): its instructions whole, as the bot sends them with each message of its kind.
     */
    ...(task.skill
      ? [
          `The task is for the skill \`${task.skill.name}\`${task.skill.description ? ` (${task.skill.description})` : ''}: send every message of its kind with \`"skill": "${task.skill.name}"\`, and write in it only what is particular to the message — the skill's instructions go with it. Its instructions, as the bot sends them, so you know its phases, the result it leads to and what it needs:`,
          '',
          fenced(task.skill.text),
          '',
        ]
      : []),
    `You may send at most ${facts.maxSends} message(s) to chats for it.`,
    facts.chat
      ? `A chat of yours is there to carry on: "${facts.chat.name}"${facts.chat.title ? `, which worked last on "${facts.chat.title}"` : ''} — "same" sends to it.`
      : 'No chat of yours is there yet: your first message goes to a "new" one.',
    '',
    'Find out what you can first (your contract, "Where to look"), then reply in your format.',
  ]
    .filter((line, i) => i > 0 || line)
    .join('\n');
}

export async function runKerriganTask(transport: ChatTransport, session: Session, task: Task, deps: RunDeps): Promise<TaskOutcome> {
  const { cfg, store, bus, signal } = deps;
  const attempt = task.attempt ?? 1;
  const runId = task.runId ?? `${session.id}-${task.id}${attempt > 1 ? `-a${attempt}` : ''}`;
  const log = new RunLog(runId, cfg.resolved.runsDir);
  const sink = new Sink(log, bus, session.id, task.id);
  const taskLogPath = log.path('task-log.txt');
  await mkdir(log.path('replies'), { recursive: true });
  await mkdir(log.path('messages'), { recursive: true });
  const record = async (heading: string, body: string): Promise<void> => {
    await appendFile(taskLogPath, `\n${'='.repeat(78)}\n${heading}\n${'='.repeat(78)}\n${body.trimEnd()}\n`, 'utf8').catch(() => undefined);
  };
  const setTask = async (mutate: (t: Task) => void): Promise<void> => {
    await store.updateTask(session.id, task.id, mutate);
  };
  const actingNow = async (actor: Actor, more: Omit<Acting, 'actor' | 'since'> = {}): Promise<void> => {
    const acting: Acting = { actor, since: new Date().toISOString(), ...more };
    await setTask((t) => {
      t.acting = acting;
    });
    sink.event('acting', acting, `at work now: ${actor === 'kerrigan' ? 'Kerrigan' : actor}`);
  };
  const maxSends = (): number => Math.max(1, cfg.limits.maxKerriganSends ?? 6);
  /*
   * Carried on (2026-11-18): the attempt before, of this same message — its chats, and how many messages she sent. Each
   * attempt started from none, so "same" was refused ("no chat of yours is there yet"), the chat she was directing was
   * lost with its conversation, and the most messages she may send began again.
   */
  const before = task.continuing ? task.attempts?.at(-1)?.kerrigan : undefined;
  const k: KerriganRecord = { rounds: [], sent: before?.sent ?? 0, maxSends: maxSends(), messages: 0, chats: [...(before?.chats ?? [])] };
  const save = async (): Promise<void> => {
    const copy = JSON.parse(JSON.stringify(k)) as KerriganRecord;
    await setTask((t) => {
      t.kerrigan = copy;
      t.iterations = copy.rounds.length;
    });
  };

  const startedAt = Date.now();
  await setTask((t) => {
    t.status = 'running';
    t.runId = runId;
    t.runGroup = deps.runGroup;
    t.startedAt = new Date().toISOString();
    t.kerrigan = { rounds: [], sent: 0, maxSends: maxSends(), messages: 0, chats: [] };
  });
  await writeFile(taskLogPath, `TASK: ${task.title}\nSESSION: ${session.name} (${session.id})\nRUN: ${runId}\nSTARTED: ${new Date().toISOString()}\nMODE: Kerrigan directs\n`, 'utf8');
  sink.event('task-started', { runId, title: task.title, kerrigan: true }, `task "${task.title}" starting, directed by Kerrigan (run ${runId})`);
  await actingNow('kerrigan');

  // The folder before the message, for "go back" and for what the whole of it changed.
  const chatDir = session.projectDir?.trim() ?? '';
  let checkpoint = task.checkpoint;
  if (!checkpoint && chatDir) {
    const cp = await takeCheckpoint(chatDir, task.id).catch((e: unknown) => ({ problem: (e as Error).message }));
    if ('problem' in cp) sink.event('chat-checkpoint-missing', { problem: cp.problem }, `no way back to before this message: ${cp.problem}`, 'warn');
    else {
      checkpoint = cp;
      await setTask((t) => {
        t.checkpoint = cp;
      });
      sink.event('chat-checkpoint', { commit: cp.commit, branch: cp.branch, head: cp.head }, `the folder before this message is kept as ${cp.commit.slice(0, 8)} (on ${cp.branch || cp.head.slice(0, 8)})`);
    }
  }

  const pacer = new Pacer({
    enabled: cfg.pacing.enabled,
    settleMs: cfg.pacing.settleMs,
    maxMessagesPerHour: cfg.pacing.maxMessagesPerHour,
    gapMs: gapFrom(cfg.pacing),
    signal,
    onGap: (ms) => sink.event('pacing-gap', { ms, kerrigan: true }, `the next message to Kerrigan waits ${Math.ceil(ms / 1000)} s: Settings ask for a pause between messages`),
  });
  const unlive =
    deps.live?.onChange(() =>
      pacer.retune({ enabled: cfg.pacing.enabled, settleMs: cfg.pacing.settleMs, maxMessagesPerHour: cfg.pacing.maxMessagesPerHour, gapMs: gapFrom(cfg.pacing) }),
    ) ?? (() => undefined);
  let limitHit: TaskLimit | undefined;

  const holdHere = async (): Promise<boolean> => {
    const hold = deps.hold;
    if (!hold?.held || signal?.aborted) return false;
    const from = Date.now();
    sink.event('task-paused', { before: 'message', kerrigan: true }, 'paused by the operator: nothing more is sent to Kerrigan until Continue');
    await hold.until(signal);
    const stopped = !!signal?.aborted;
    sink.event('task-resumed', { heldMs: Date.now() - from, stopped }, stopped ? 'stopped while paused' : 'continued by the operator');
    return stopped;
  };
  // Each message into her own conversation, the window put back on it when it has left it (2026-11-09).
  const herChat = redactsMessages(limitsMessageLength(holdsWhilePaused(staysOnItsChat(transport, signal), holdHere), {
    get max() {
      return cfg.limits.maxMessageChars;
    },
    dir: log.path('messages'),
    onLong: ({ chars, max, file }) =>
      sink.event('message-long', { chars, max, file, kerrigan: true }, `a message to Kerrigan of ${chars} characters is over the ${max} sent as text: its beginning is sent, the whole of it attached as ${file}`, 'warn'),
  }), {
    patterns: cfg.report.redactPatterns,
    onRedacted: (hits) => sink.event('message-redacted', { redactions: hits, kerrigan: true }, `secrets taken out of a message to Kerrigan before it was sent: ${hits.map((h) => `${h.name} ×${h.count}`).join(', ')}`, 'warn'),
  });

  let replies = 0;
  /**
   * One message to her, and her reply. `files`: attached — the whole exchange of a chat's message with its result
   * (2026-11-12: "I copy the whole JSON, or the one message, and send it to Kerrigan"); one that cannot be attached, the
   * message goes without it, saying so.
   */
  const tell = async (text: string, files: string[] = []): Promise<string> => {
    await pacer.throttleSend();
    // The person's notes written while the work goes on ("Add to it") go to her with her next message.
    const notes = await store.takeUnsentNotes(session.id, task.id).catch(() => []);
    const message = notes.length > 0 ? `${text}\n\n${operatorNotesSection(notes, true)}` : text;
    if (notes.length > 0) sink.event('operator-note-sent', { notes: notes.length, with: 'kerrigan' }, `${notes.length} note(s) from the operator go to Kerrigan`);
    let before: number;
    try {
      before = await herChat.sendAndConfirm(message, files);
    } catch (e) {
      if (files.length === 0 || e instanceof StoppedSend || e instanceof ChatLost || e instanceof WindowClosed || signal?.aborted) throw e;
      sink.event('kerrigan-attach-failed', { files, error: (e as Error).message }, `the exchange could not be attached to the message to Kerrigan; it goes without it: ${(e as Error).message}`, 'warn');
      before = await herChat.sendAndConfirm(`${message}\n\n(The whole exchange of the message could not be attached: ${(e as Error).message}. Judge from the above.)`);
    }
    k.messages += 1;
    await save();
    await writeFile(log.path('messages', `${String(k.messages).padStart(2, '0')}.md`), message, 'utf8').catch(() => undefined);
    sink.event('message-sent', { n: k.messages, chars: message.length, kerrigan: true, chatId: session.chat?.chatId ?? null }, `message ${k.messages} sent to Kerrigan (${message.length} chars)`);
    await record(`TO KERRIGAN (${k.messages})`, message);
    const reply = await herChat.waitForReply(before);
    replies += 1;
    await writeFile(log.path('replies', `${String(replies).padStart(2, '0')}-kerrigan.md`), reply.markdown, 'utf8').catch(() => undefined);
    await record(`FROM KERRIGAN (${replies})`, reply.markdown);
    await pacer.settle();
    await registerHerChat();
    return reply.markdown;
  };

  /** Her conversation, put on record and named once it exists. */
  const registerHerChat = async (): Promise<void> => {
    if (session.chat) return;
    const chatId = await transport.currentChatId().catch(() => null);
    if (!chatId) return;
    const asked = buildChatName(chatCode(session.id), session.name);
    const saved = await transport.nameChat(chatId, asked).catch(() => false as const);
    const chat: ChatPointer = {
      chatId,
      url: `${cfg.copilot.url.replace(/\/chat.*$/, '')}/chat/conversation/${chatId}?es=SSR`,
      name: saved || asked,
      ...(saved !== false ? {} : { named: false }),
      runId,
      createdAt: new Date().toISOString(),
    };
    session.chat = chat;
    await store.updateSession(session.id, (s) => {
      s.chat = chat;
    });
    await savePointer(log.path('chat.json'), chat).catch(() => undefined);
  };

  const maxFormat = (): number => Math.max(0, cfg.limits.maxFormatRetries ?? 2);
  /**
   * Her reply to `text`, in her format and one that can be acted on here (`fits`): asked again with the reason when it is
   * not, up to Settings' retries.
   */
  const askHer = async (text: string, fits: (r: KerriganReply) => string | null | Promise<string | null>, files: string[] = []): Promise<KerriganReply> => {
    let markdown = await tell(text, files);
    let retries = 0;
    for (;;) {
      const parsed = parseKerriganReply(markdown);
      const problem = parsed.ok ? await fits(parsed.reply) : null;
      if (parsed.ok && !problem) return parsed.reply;
      retries += 1;
      const detail = parsed.ok ? problem! : parsed.detail;
      if (retries > maxFormat()) throw new FormatLimit(detail);
      sink.event('kerrigan-format-retry', { detail, retry: retries }, `Kerrigan's reply could not be acted on, asked again (${retries} of ${maxFormat()}): ${detail}`, 'warn');
      markdown = await tell(parsed.ok ? `${problem}\n\nNothing from your last reply was acted on. Send it again, in your format (retry ${retries} of ${maxFormat()}).` : kerriganFormatErrorMessage(parsed, retries, maxFormat()));
    }
  };

  /** Back in her conversation, on her model, the window speaking for her. */
  const toHer = async (): Promise<void> => {
    speakFor(transport, session.id);
    const now = ((await store.getSession(session.id)) ?? session) as Session;
    await enterSessionConversation(transport, now, { closeOnFailure: false });
    const back = await applySessionModel(transport, now, bus, cfg, store, deps.models, false, signal);
    if (back.refused && !signal?.aborted) throw new Error(`Kerrigan's conversation could not be put on its model again: ${back.refused}`);
  };

  /** The chat she sent to last: in this message, or in an earlier one of this conversation. */
  let lastChat: Session | null = null;
  let lastTitle = '';
  {
    // This message's own attempt before, when it is carried on; else the last message of hers that sent to a chat.
    const earlier = (before?.chats.length ?? 0) > 0 ? { kerrigan: before! } : [...session.tasks].reverse().find((x) => x.id !== task.id && (x.kerrigan?.chats.length ?? 0) > 0);
    const id = earlier?.kerrigan?.chats.at(-1);
    const found = id ? await store.getSession(id) : null;
    if (found) {
      lastChat = found;
      lastTitle = [...(earlier!.kerrigan!.rounds)].reverse().find((r) => r.send?.sessionId === id)?.send?.title ?? '';
    }
  }

  const lease = new WindowLease();
  /** Who is at work in the chat of hers at work now, for the line under her message. */
  let actorNow: Actor = 'worker';
  /** Her rounds of cards, one at a time. */
  let cards: Promise<void> = Promise.resolve();
  const chatName = async (sessionId: string): Promise<string> => {
    const s = await store.getSession(sessionId);
    const top = s?.workerOf ? await store.getSession(s.workerOf) : s;
    return (top?.name ?? sessionId).replace(/^chat: /, '');
  };

  /**
   * The card, as she is told it: what its "Copy all" gives (operator, 2026-11-12: "where she is needed, 'Copy all', or
   * 'Copy' where there is none"), and how to answer it in her format.
   */
  const cardMessage = async (c: Card): Promise<string> => {
    const name = await chatName(c.ask.sessionId);
    const copy =
      c.kind === 'question'
        ? cardCopyText({ actor: c.ask.actor ?? 'worker', question: { text: c.ask.question, ...(c.ask.why ? { why: c.ask.why } : {}), options: c.ask.options, ...(c.ask.commands ? { commands: c.ask.commands } : {}), ...(c.ask.multiple ? { multiple: true } : {}) } })
        : c.kind === 'plan'
          ? cardCopyText({ actor: c.ask.actor ?? 'plan', plan: { title: c.ask.title, plan: c.ask.plan } })
          : cardCopyText({ actor: 'lead', retry: c.ask.retry });
    const how =
      c.kind === 'question'
        ? `Answer it with status "answer" — "option", the number of one of the answers offered${c.ask.multiple ? ', "options", the numbers of the ones you choose,' : ''} or "text" in your own words — and "why". An answer that runs a command does not run it by your word: it is asked about as the person's Settings say.`
        : c.kind === 'plan'
          ? 'Approve it with status "answer" and "decision": "approve" (a "note" beside it if you like), or send it back with "decision": "revise" and a "note" that says what to change.'
          : 'Answer it with status "answer" and "option", the number of one of the answers offered, and "why".';
    return [
      `A card of the chat "${name}" waits for an answer. What its "Copy all" gives:`,
      '',
      '---',
      copy ?? '',
      '---',
      '',
      how,
      'Or leave it to the person with status "ask", "why" and "suggestion".',
    ].join('\n');
  };

  /** Whether her reply answers this card, and the answer it gives; or why not. */
  const answerOf = (c: Card, r: KerriganReply): { problem: string } | { said: string; give: () => { ok: boolean; problem?: string } } => {
    const why = (r.why ?? r.notes ?? '').trim();
    if (c.kind === 'question') {
      const opts = c.ask.options;
      const many = (r.options ?? []).map((x) => (typeof x === 'number' ? x : Number(/\d+/.exec(String(x))?.[0] ?? NaN)));
      if (r.option !== undefined) {
        if (r.option < 1 || r.option > opts.length) return { problem: `"option" is the number of one of the card's answers, 1 to ${opts.length}.` };
        const text = opts[r.option - 1]!;
        return { said: text, give: () => c.card.answer({ text }, why) };
      }
      if (many.length > 0) {
        if (!c.ask.multiple) return { problem: 'This question takes one answer: give "option", or "text".' };
        if (many.some((x) => !Number.isInteger(x) || x < 1 || x > opts.length)) return { problem: `"options" are numbers of the card's answers, 1 to ${opts.length}.` };
        const chosen = [...new Set(many)].map((x) => x - 1);
        const text = (r.text ?? '').trim();
        return { said: chosenSaid({ chosen: chosen.map((x) => opts[x]!), ...(text ? { written: text } : {}) }), give: () => c.card.answer({ text, chosen }, why) };
      }
      const text = (r.text ?? '').trim();
      if (!text) return { problem: opts.length > 0 ? 'Answer the question with "option" (the number of one of its answers), "options" when more than one may be chosen, or "text" in your own words.' : 'Answer the question in "text".' };
      return { said: text, give: () => c.card.answer({ text }, why) };
    }
    if (c.kind === 'plan') {
      if (!r.decision) return { problem: 'Answer the plan with "decision": "approve", or "revise" with a "note".' };
      const note = (r.note ?? '').trim();
      if (r.decision === 'revise' && !note) return { problem: '"decision": "revise" needs a "note" that says what to change in the plan.' };
      return { said: r.decision === 'approve' ? `approved${note ? ` — ${note}` : ''}` : `another plan asked for: ${note}`, give: () => c.card.answer({ decision: r.decision!, ...(note ? { note } : {}) }, why) };
    }
    const choices = c.ask.retry.choices;
    // By its number among the answers offered, as "Copy all" numbers them, or by its word.
    const byNumber = r.option !== undefined ? choices[r.option - 1] : undefined;
    if (r.option !== undefined && !byNumber) return { problem: `"option" is the number of one of the answers offered, 1 to ${choices.length}.` };
    if (!byNumber && (!r.choice || !choices.includes(r.choice))) return { problem: `Answer with "option", the number of one of the answers offered, 1 to ${choices.length}.` };
    const choice = (byNumber ?? r.choice)!;
    return { said: `${choice} — ${RETRY_WORDS[choice]}`, give: () => c.card.answer(choice, why) };
  };

  /** A card the chat put up, answered by her in the person's place, or left to them; the chat's conversation given back. */
  const answerCard = async (c: Card): Promise<void> => {
    if (signal?.aborted || !c.card.open()) return;
    c.card.mark({ state: 'thinking', at: new Date().toISOString() });
    lease.take();
    const speaker = spokenFor(transport);
    const round: KerriganRound = {
      status: 'answer',
      at: new Date().toISOString(),
      card: {
        id: c.card.id,
        kind: c.kind,
        sessionId: c.ask.sessionId,
        taskId: c.ask.taskId,
        ...(c.kind !== 'retry' && c.ask.actor ? { actor: c.ask.actor } : {}),
        text: c.kind === 'question' ? c.ask.question : c.kind === 'plan' ? `The plan of "${c.ask.title}" (version ${c.ask.plan.version})` : `Subtask ${c.ask.retry.n} ("${c.ask.retry.title}") did not finish: ${c.ask.retry.reason || c.ask.retry.category}`,
        ...(c.kind === 'question' && c.ask.options.length > 0 ? { options: c.ask.options } : {}),
      },
    };
    k.rounds.push(round);
    await save();
    sink.event('kerrigan-card', { card: c.card.id, kind: c.kind }, `a card of the chat goes to Kerrigan: ${round.card!.text}`);
    let give: (() => { ok: boolean; problem?: string }) | null = null;
    try {
      await actingNow('kerrigan');
      await toHer();
      const message = await cardMessage(c);
      const r = await askHer(message, (x) => {
        if (x.status !== 'answer' && x.status !== 'ask') return 'A card is waiting: answer it with status "answer", or leave it to the person with status "ask", "why" and "suggestion".';
        if (x.status === 'ask') return (x.why ?? '').trim() ? null : 'Leaving a card to the person needs "why": what makes it theirs alone, and what you looked at.';
        const a = answerOf(c, x);
        return 'problem' in a ? a.problem : null;
      });
      round.status = r.status;
      if (r.notes) round.notes = r.notes;
      if (r.sources.length > 0) round.sources = r.sources;
      if (r.status === 'answer') {
        const a = answerOf(c, r) as { said: string; give: () => { ok: boolean; problem?: string } };
        round.card!.answer = a.said;
        give = a.give;
      } else {
        round.card!.yours = { why: r.why!, ...(r.suggestion ? { suggestion: r.suggestion } : {}) };
        c.card.mark({ state: 'yours', at: new Date().toISOString(), why: r.why!, ...(r.suggestion ? { suggestion: r.suggestion } : {}) });
        sink.event('kerrigan-left-card', { card: c.card.id }, `Kerrigan leaves the card to the operator: ${r.why}`, 'warn');
      }
    } catch (e) {
      const why = e instanceof FormatLimit ? `her replies could not be acted on (${e.message})` : (e as Error).message;
      round.status = 'ask';
      round.card!.yours = { why: `Kerrigan could not answer it: ${why}` };
      if (!signal?.aborted) c.card.mark({ state: 'yours', at: new Date().toISOString(), why: round.card!.yours.why });
      sink.event('kerrigan-card-failed', { card: c.card.id, error: why }, `Kerrigan could not answer the card; it is left to the operator: ${why}`, 'warn');
    }
    // The chat's conversation given back before the chat goes on, whoever answers the card.
    try {
      if (!signal?.aborted) {
        const theirs = (await store.getSession(c.ask.sessionId)) as Session | null;
        if (theirs) {
          speakFor(transport, speaker ?? theirs.id);
          await enterSessionConversation(transport, theirs, { closeOnFailure: false });
          await applySessionModel(transport, theirs, bus, cfg, store, deps.models, false, signal);
        }
      }
    } catch (e) {
      sink.event('kerrigan-return-failed', { card: c.card.id, error: (e as Error).message }, `the window could not be put back on the chat's conversation: ${(e as Error).message}`, 'warn');
    }
    if (give) {
      const done = give();
      round.card!.by = done.ok ? 'kerrigan' : 'operator';
      if (!done.ok) {
        delete round.card!.answer;
        sink.event('kerrigan-too-late', { card: c.card.id }, 'the operator answered the card before Kerrigan did: theirs is taken');
      } else sink.event('kerrigan-answered', { card: c.card.id, answer: round.card!.answer }, `Kerrigan answered the card: ${round.card!.answer}`);
    } else if (!c.card.open()) round.card!.by = 'operator';
    await save();
    lease.release();
    await actingNow(actorNow).catch(() => undefined);
  };
  const cardToHer = (c: Card): void => {
    cards = cards.then(() => answerCard(c)).catch((e: unknown) => {
      lease.release();
      sink.event('kerrigan-card-failed', { error: (e as Error).message }, `a card could not be put to Kerrigan: ${(e as Error).message}`, 'warn');
    });
  };

  /**
   * A card that went to her and was answered by the person — before her, or after she left it to them: on her record as
   * theirs, with their answer.
   */
  const answeredByPerson = async (id: string, answer: string | null): Promise<void> => {
    const round = [...k.rounds].reverse().find((r) => r.card?.id === id);
    if (!round?.card || round.card.by === 'kerrigan') return;
    round.card.by = 'operator';
    if (answer !== null) round.card.answer = answer;
    else delete round.card.answer;
    await save();
  };

  /** The deps a chat of hers runs with: its cards that are hers go to her; its worker is its own. */
  const chatDeps = (chatId: string): RunDeps => ({
    ...deps,
    directed: true,
    kerrigan: undefined,
    onWorker: (workerId, parent) => deps.onWorker?.(workerId, parent ?? chatId),
    ...(deps.askQuestion
      ? {
          askQuestion: async (ask) => {
            // Commands handed over to run are the person's, never hers.
            if (ask.handoff) return await deps.askQuestion!(ask);
            let id = '';
            const got = await deps.askQuestion!({
              ...ask,
              onCard: (card) => {
                id = card.id;
                cardToHer({ kind: 'question', ask, card });
              },
            });
            await lease.free(signal);
            if (id && got !== 'stop' && got.by !== 'kerrigan') await answeredByPerson(id, got.answer);
            return got;
          },
        }
      : {}),
    ...(deps.approvePlan
      ? {
          approvePlan: async (ask) => {
            let id = '';
            const got = await deps.approvePlan!({
              ...ask,
              onCard: (card) => {
                id = card.id;
                cardToHer({ kind: 'plan', ask, card });
              },
            });
            await lease.free(signal);
            if (id && got.decision !== 'stop' && got.by !== 'kerrigan') await answeredByPerson(id, got.decision === 'approve' ? `approved${got.note ? ` — ${got.note}` : ''}` : `another plan asked for: ${got.note ?? ''}`);
            return got;
          },
        }
      : {}),
    ...(deps.askSubtaskRetry
      ? {
          askSubtaskRetry: async (ask) => {
            let id = '';
            let hers = false;
            const got = await deps.askSubtaskRetry!({
              ...ask,
              onCard: (card) => {
                id = card.id;
                // Her answer is told apart by the card itself: a retry's choice says nothing of who chose it.
                const answer = card.answer.bind(card);
                card.answer = (a, why) => {
                  const done = answer(a, why);
                  if (done.ok) hers = true;
                  return done;
                };
                cardToHer({ kind: 'retry', ask, card });
              },
            });
            await lease.free(signal);
            if (id && got !== 'stop' && !hers) await answeredByPerson(id, `${got} — ${RETRY_WORDS[got]}`);
            return got;
          },
        }
      : {}),
  });

  /** A chat for her message: a new one with the settings she chose, or the one she sent to last, set as she chose now. */
  const chatFor = async (r: KerriganReply, n: number): Promise<Session> => {
    const planMode = r.planMode ? 'approve' : 'off';
    if (r.chat === 'same' && lastChat) {
      return await store.updateSession(lastChat.id, (s) => {
        s.planMode = planMode;
        if (!s.lead) s.review = { ...(s.review ?? { model: '' }), enabled: !!r.review };
      });
    }
    const title = (r.title ?? '').trim() || r.prompt!.split(/\r?\n/)[0]!.trim().slice(0, 60);
    const made = await store.createSession(`Kerrigan ${n}: ${title}`.slice(0, 120), session.projectDir ?? '');
    const own = (await store.getSession(session.id))?.kerrigan ?? {};
    return await store.updateSession(made.id, (s) => {
      s.kind = 'chat';
      s.directedBy = session.id;
      s.onFailure = 'continue';
      // No version control of its own, as the chat has none: it works on the branch the folder is on (see `chatSend`).
      s.vcs = { ...(s.vcs ?? DEFAULT_VCS), enabled: false, repoDir: '' };
      s.projectDir = session.projectDir ?? '';
      s.planMode = planMode;
      s.review = { enabled: !!r.review && !r.twoChats, model: '' };
      // The model of her chats, as chosen under the chat's box; none, Settings'. With two chats it is the worker's, and the
      // lead's is Settings' model for the lead.
      if (r.twoChats) {
        s.lead = {
          ...(own.chatManualModel ? { workerManualModel: true } : {}),
          ...(!own.chatManualModel && own.chatModel?.trim() ? { workerModel: own.chatModel.trim() } : {}),
        };
      } else if (own.chatManualModel) s.manualModel = true;
      else if (own.chatModel?.trim()) {
        s.model = own.chatModel.trim();
        s.modelSource = 'operator';
      }
      if (session.lang) s.lang = session.lang;
    });
  };

  /** Why a "send" cannot be carried out as it stands, or null. */
  const sendProblem = async (r: KerriganReply): Promise<string | null> => {
    if (r.chat === 'same' && !lastChat) return 'There is no chat of yours to carry on yet: send to a "new" one.';
    if (r.chat === 'same' && lastChat && !!r.twoChats !== !!lastChat.lead) {
      return `"twoChats" is set when a chat begins: the chat you sent to last is ${lastChat.lead ? 'one of two chats' : 'one chat'}. Send with "twoChats": ${!!lastChat.lead}, or to a "new" chat.`;
    }
    const skill = (r.skill ?? '').trim();
    if (skill && !(await deps.kerrigan?.skill(skill, chatDir))) return `There is no skill called "${skill}" for this folder: use one of the facts' list, or "".`;
    return null;
  };

  /** Her message to a chat, carried out there to its end; the result, as she is told it. */
  const sendToChat = async (r: KerriganReply, round: KerriganRound): Promise<{ text: string; files: string[] } | 'stopped'> => {
    k.sent += 1;
    const n = k.sent;
    const chat = await chatFor(r, n);
    const title = (r.title ?? '').trim() || r.prompt!.split(/\r?\n/)[0]!.trim().slice(0, 80);
    const skill = (r.skill ?? '').trim() ? await deps.kerrigan?.skill(r.skill!.trim(), chatDir) : null;
    const made = await store.addTask(chat.id, { title, level2: '', prompt: r.prompt!, ...(skill ? { skill } : {}) });
    await store.updateTask(chat.id, made.id, (t) => {
      t.fromKerrigan = { sessionId: session.id, taskId: task.id, n };
    });
    if (!k.chats.includes(chat.id)) k.chats.push(chat.id);
    round.send = {
      n,
      title,
      prompt: r.prompt!,
      chat: r.chat === 'same' && lastChat ? 'same' : 'new',
      planMode: !!r.planMode,
      twoChats: !!chat.lead,
      review: !!chat.review?.enabled,
      ...(skill ? { skill: skill.name } : {}),
      sessionId: chat.id,
      taskId: made.id,
      status: 'running',
    };
    await save();
    sink.event('kerrigan-sent', { n, sessionId: chat.id, taskId: made.id, chat: round.send.chat, planMode: round.send.planMode, twoChats: round.send.twoChats, review: round.send.review, skill: skill?.name ?? null },
      `Kerrigan's message ${n} goes to the chat "${chat.name}": ${title}`);
    deps.onWorker?.(chat.id, session.id);
    actorNow = chat.lead ? 'lead' : chat.planMode === 'approve' ? 'plan' : 'worker';
    await actingNow(actorNow);

    speakFor(transport, chat.id);
    const fresh = !chat.chat;
    await enterSessionConversation(transport, chat, { closeOnFailure: false });
    const model = await applySessionModel(transport, chat, bus, cfg, store, deps.models, fresh, signal);
    if (model.refused) {
      speakFor(transport, session.id);
      if (signal?.aborted) return 'stopped';
      throw new Error(`The chat's conversation could not be put on its model: ${model.refused}`);
    }
    const current = (await store.getSession(chat.id)) as Session;
    const its = current.tasks.find((x) => x.id === made.id) as Task;
    const out = current.lead ? await runLeadTask(transport, current, its, chatDeps(chat.id)) : await runTask(transport, current, its, chatDeps(chat.id));
    // A card she was still on when the chat ended: her round of it is let finish before her conversation is used again.
    await cards;
    speakFor(transport, session.id);
    if (transport.closedOutside()) throw new WindowClosed();
    lastChat = (await store.getSession(chat.id)) ?? chat;
    lastTitle = title;
    const ended = lastChat.tasks.find((x) => x.id === made.id);
    round.send.status = ended?.status ?? out.status;
    const summary = (ended?.summary ?? out.summary ?? '').trim();
    if (summary) round.send.summary = summary.slice(0, 4000);
    await save();
    sink.event('kerrigan-result', { n, status: out.status }, `the chat's work on Kerrigan's message ${n} ended: ${out.status}`);
    if (signal?.aborted) return 'stopped';
    await actingNow('kerrigan');
    // The whole exchange only when Settings say so (2026-11-12); by default she is given what "Copy" gives.
    const file = cfg.execution.kerriganResult === 'exchange' ? await exchangeOf(chat.id, made.id, n) : null;
    await toHer();
    const name = file ? file.replace(/^.*[\\/]/, '') : undefined;
    return { text: await resultOf(lastChat, made.id, out, n, title, name), files: file ? [file] : [] };
  };

  /**
   * The whole exchange of a chat's message, as its "JSON" button gives it (`taskExchange.ts`): every message, every reply,
   * every command with all it printed. Written out for her, secrets taken out first, as every report is.
   */
  const exchangeOf = async (chatId: string, taskId: string, n: number): Promise<string | null> => {
    const s = await store.getSession(chatId);
    const t = s?.tasks.find((x) => x.id === taskId);
    if (!s || !t) return null;
    try {
      let text = redactSecrets(JSON.stringify(await buildTaskExchange(cfg.resolved.runsDir, s, t), null, 2), cfg.report.redactPatterns);
      if (text.length > MAX_EXCHANGE_CHARS) text = `${text.slice(0, MAX_EXCHANGE_CHARS)}\n… (cut here: the whole of it is ${text.length} characters)`;
      // As text: the chat window takes a .txt as the reports go; it is JSON, and she is told so.
      const file = log.path('messages', `exchange-of-message-${n}.txt`);
      await writeFile(file, text, 'utf8');
      return file;
    } catch (e) {
      sink.event('kerrigan-exchange-missing', { n, error: (e as Error).message }, `the exchange of Kerrigan's message ${n} could not be written out: ${(e as Error).message}`, 'warn');
      return null;
    }
  };

  /**
   * The result of her message, as she is told it: how it ended, and what "Copy" under its ending gives — the chat's
   * summary of what was done, tried and how it went (operator, 2026-11-12: "the last message must be enough, just
   * copied") — with the whole exchange attached when Settings say so.
   */
  const resultOf = async (chat: Session, taskId: string, out: TaskOutcome, n: number, title: string, attached?: string): Promise<string> => {
    const t = chat.tasks.find((x) => x.id === taskId);
    const status = t?.status ?? out.status;
    const copied = endingCopyText({ status, summary: t?.summary ?? out.summary, reason: t?.reason ?? out.reason });
    const lines: string[] = [
      `The result of your message ${n} ("${title}") in the chat "${chat.name.replace(/^chat: /, '')}": ${endedAs(status)}.`,
      '',
      'What "Copy" under its ending gives:',
      '',
      '---',
      copied || '(it gave no summary)',
      '---',
    ];
    if (attached) lines.push('', `Attached, \`${attached}\`: the whole exchange of this message, as JSON — every message the chat was sent, every reply of its, every command with all it printed. Read it where the summary above is not enough.`);
    lines.push('', `Messages to chats left: ${Math.max(0, k.maxSends - k.sent)} of ${k.maxSends}.`, 'Reply in your format: the next message (send), your report (done), a question for the person (ask), or blocked.');
    return lines.join('\n');
  };

  const finish = async (status: TaskOutcome['status'], reason?: string, summary?: string): Promise<TaskOutcome> => {
    // What the whole of the message changed: the folder against its photograph from before it.
    let vcs: Task['vcs'];
    if (checkpoint && chatDir) {
      const after = await takeAfter(chatDir, task.id, checkpoint).catch((e: unknown) => ({ problem: (e as Error).message }));
      if (!('problem' in after)) vcs = { baseCommit: checkpoint.commit, commit: after.commit, files: await commitFiles(chatDir, after.commit).catch(() => []) };
    }
    await save();
    await setTask((t) => {
      if (vcs) t.vcs = vcs;
      t.status = status;
      delete t.acting;
      t.finishedAt = new Date().toISOString();
      const held = deps.hold?.pausedSince(startedAt) ?? 0;
      if (held > 0) t.pausedMs = held;
      t.summary = summary;
      t.reason = reason;
      t.logFile = 'task-log.txt';
      if (limitHit) t.limit = limitHit;
    });
    await record(`TASK ${status.toUpperCase()}`, [summary ?? '', reason ? `Reason: ${reason}` : ''].filter(Boolean).join('\n\n') || '(no details)');
    sink.event('task-finished', { status, reason, iterations: k.rounds.length, sent: k.sent, kerrigan: true }, `task "${task.title}" ${status}${reason ? `: ${reason}` : ''}`);
    unlive();
    await log.close();
    return { status, iterations: k.rounds.length, summary, reason };
  };

  try {
    const n = session.tasks.findIndex((x) => x.id === task.id) + 1;
    if (!session.contractSent) {
      const contract = (await store.getKerrigan1()).content.trim();
      const brief = (await deps.kerrigan?.brief()) ?? '';
      const opening = brief ? `${contract}\n\n---\n\n${brief}` : contract;
      await setTask((t) => {
        t.firstMessage = opening;
      });
      if (signal?.aborted) return await finish('aborted', 'stopped before anything was sent to Kerrigan');
      // Her acknowledgement is not read: what she does begins with the task.
      await tell(opening);
      session.contractSent = true;
      await store.updateSession(session.id, (s) => {
        s.contractSent = true;
      });
    }
    const opening = kerriganTaskMessage(task, n || 1, { maxSends: maxSends(), ...(lastChat ? { chat: { name: lastChat.name.replace(/^chat: /, ''), ...(lastTitle ? { title: lastTitle } : {}) } } : {}) }, k.messages === 0 && !!session.chat);
    await record('THE TASK', opening);
    if (signal?.aborted) return await finish('aborted', 'stopped before the task was sent to Kerrigan');

    /** Her next decision in the work: not an answer to a card, which only a card takes. */
    let understood = !!task.continuing;
    const decides = async (x: KerriganReply): Promise<string | null> => {
      if (x.status === 'answer') return 'No card is waiting for an answer now: reply with "send", "ask", "done" or "blocked".';
      if (!understood && !x.understanding) return KERRIGAN_UNDERSTANDING_FIRST;
      if (x.status === 'ask' && (x.question ?? '').trim().length < 10) return 'status "ask" needs a "question" for the person: what only they can decide, said in full, with "why" and "options".';
      if (x.status === 'send') return await sendProblem(x);
      return null;
    };
    let r = await askHer(opening, decides);
    const maxRounds = (): number => Math.max(1, cfg.limits.maxIterations);
    for (;;) {
      understood = true;
      if (signal?.aborted) return await finish('aborted', 'stopped by the operator');
      if (k.rounds.length >= maxRounds()) {
        limitHit = { setting: 'maxIterations', value: maxRounds() };
        return await finish('limit-reached', `maxIterations (${maxRounds()}) reached: Kerrigan's replies`);
      }
      const round: KerriganRound = {
        status: r.status,
        at: new Date().toISOString(),
        ...(r.understanding ? { understanding: r.understanding } : {}),
        ...(r.notes ? { notes: r.notes } : {}),
        ...(r.sources.length > 0 ? { sources: r.sources } : {}),
      };
      k.rounds.push(round);
      await save();
      sink.event('kerrigan-reply', { round: k.rounds.length, status: r.status }, `Kerrigan: ${r.status}${r.title ? ` — ${r.title}` : ''}`);

      switch (r.status) {
        case 'send': {
          if (k.sent >= k.maxSends) {
            r = await askHer(`You have sent the ${k.maxSends} message(s) to chats you may for this task. Deliver what you have now — status "done" with your report, what is missing said plainly — or "blocked".`, async (x) => (x.status === 'send' ? 'No message to a chat is left: reply "done" or "blocked".' : await decides(x)));
            break;
          }
          const ran = await sendToChat(r, round);
          if (ran === 'stopped') return await finish('aborted', 'stopped by the operator');
          r = await askHer(ran.text, decides, ran.files);
          break;
        }
        case 'ask': {
          round.question = { text: r.question!, ...(r.why ? { why: r.why } : {}), options: r.options?.map(String) ?? [], ...(r.multiple ? { multiple: true } : {}) };
          await save();
          if (!deps.askQuestion) {
            r = await askHer('Nobody can answer a question in this run: decide it yourself, the way that keeps the most options open, say the assumption in "notes", and go on.', decides);
            break;
          }
          sink.event('kerrigan-question', { question: r.question }, `Kerrigan asks the operator: ${r.question}`, 'warn');
          const options = (r.options ?? []).map(String).filter((o) => o.trim());
          const got = await deps.askQuestion({ sessionId: session.id, taskId: task.id, question: r.question!, ...(r.why ? { why: r.why } : {}), options, ...(r.multiple && options.length >= 2 ? { multiple: true } : {}), actor: 'kerrigan' });
          if (got === 'stop' || signal?.aborted) return await finish('aborted', 'the operator stopped the task at Kerrigan\'s question');
          round.question.answer = got.answer;
          await save();
          sink.event('kerrigan-question-answered', {}, 'the operator answered Kerrigan');
          await actingNow('kerrigan');
          const said = got.chosen ? `The person answered your question, ${chosenSaid({ chosen: got.chosen, ...(got.written ? { written: got.written } : {}) })}` : `The person answers your question:\n\n${got.answer.trim()}`;
          r = await askHer(`${said}\n\nGo on in your format. Messages to chats left: ${Math.max(0, k.maxSends - k.sent)} of ${k.maxSends}.`, decides);
          break;
        }
        case 'done': {
          round.report = r.report!;
          if (r.evidence.length > 0) round.evidence = r.evidence;
          return await finish('done', undefined, r.report);
        }
        case 'blocked': {
          round.report = r.summary!;
          round.needed = r.needed!;
          return await finish('blocked', `Kerrigan could not take it further: ${r.needed ?? ''}`.trim(), r.summary);
        }
        case 'answer':
          // Refused by `decides` before it gets here.
          r = await askHer('No card is waiting for an answer now: reply with "send", "ask", "done" or "blocked".', decides);
          break;
      }
    }
  } catch (e) {
    const message = (e as Error).message;
    if (e instanceof StoppedSend || signal?.aborted) return await finish('aborted', 'stopped by the operator; nothing more was sent');
    if (e instanceof FormatLimit) {
      limitHit = { setting: 'maxFormatRetries', value: maxFormat() };
      return await finish('limit-reached', `maxFormatRetries (${maxFormat()}) reached: Kerrigan's replies could not be acted on (${message})`);
    }
    if (isReplyTimeout(e)) {
      limitHit = { setting: 'replyTimeoutSec', value: e.seconds };
      return await finish('limit-reached', `replyTimeoutSec (${e.seconds}) reached: ${message}`);
    }
    // Why, as the kept window says it (2026-11-13): not opened again by Settings, past the times allowed, or not found.
    if (e instanceof WindowClosed || transport.closedOutside()) return await finish('aborted', e instanceof WindowClosed ? e.message : CLOSED_NOT_REOPENED);
    // A conversation the window could not be put back on, nothing sent: stopped, and Continue tries it again (2026-11-18).
    if (e instanceof ChatLost) {
      sink.event('chat-lost', { chatId: e.chatId, found: e.found }, message, 'warn');
      return await finish('aborted', message);
    }
    sink.event('task-error', { error: message, stack: (e as Error).stack }, message, 'error');
    return await finish('failed', message);
  }
}
