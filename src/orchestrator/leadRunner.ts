/**
 * The two-chat mode (operator, 2026-10-20): "chat A takes the whole, complex task — it breaks it into steps, checks
 * that it understands it, plans, and directs; chat B carries out the small technical tasks — reads files, runs tests,
 * debugs, whatever it takes — and reports back to A. One LLM controls the process at a high level and knows what is to
 * be achieved; the other does the separate technical tasks. The browser is not closed between the two chats."
 *
 * So a message of such a conversation is run here, not by `runTask`. The conversation of the chat's session is the
 * lead's (A): it is given the lead's contract (`prompts/lead1.md`) and the assignment, and every reply of it is one
 * decision in the shape `protocol/leadSchema.ts` holds it to — a subtask for the worker, the plan, a question for the
 * operator, the result, or a stop. The worker (B) is a session of its own (`Session.workerOf`), made at the first
 * subtask, with a conversation of its own in the same Copilot window; each subtask is a task of it, run by `runTask`
 * as any chat message is, with everything that comes with that — commands asked about or not, Pause, Stop, the
 * checkpoint of the folder, the limits. The window goes from one conversation to the other and back (as the review's
 * does); it is never closed between them. The worker keeps its conversation across subtasks, so what it learnt of
 * the project stays with it, unless the lead asks for a fresh one.
 *
 * What the operator sees is the lead's record on the message (`Task.lead`): its understanding of the assignment, its
 * notes, its plan, the subtasks with the worker's commands under each, its questions with their answers, and the
 * result, which is the message's summary. The folder is photographed before the message and after it, so its changes
 * are shown and "go back" works for the whole of it.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isReplyTimeout, WindowClosed, type ChatTransport } from '../transport/chatTransport.js';
import type { ReplyCapture } from '../transport/copilotTransport.js';
import { buildChatName, chatCode, savePointer, type ChatPointer } from '../transport/chatSession.js';
import { RunLog } from '../log/runLog.js';
import { gapFrom, Pacer } from '../util/pacing.js';
import { takeAfter, takeCheckpoint } from '../session/checkpoint.js';
import { commitFiles } from '../vcs/git.js';
import { buildStory } from '../session/story.js';
import { operatorNotesSection, whyItStopped } from '../session/compose.js';
import { describeDeviations } from '../protocol/replySchema.js';
import { leadFormatErrorMessage, parseLeadReply, UNDERSTANDING_FIRST, type Subtask } from '../protocol/leadSchema.js';
import { describePlan, planFrom } from './planMode.js';
import { closeLedger, describeLedger, nextLedger } from './leadLedger.js';
import { ACTOR_WORDS, applySessionModel, enterSessionConversation, holdsWhilePaused, limitsMessageLength, runTask, Sink, speakFor, StoppedSend, type RunDeps, type TaskOutcome } from './taskRunner.js';
import type { Acting, Actor, LeadRecord, LeadRound, Session, Task, TaskLimit, TaskPlan } from '../session/model.js';
import { DEFAULT_VCS } from '../session/store.js';

/** The facts the assignment is sent with. */
export type AssignmentFacts = {
  workDir: string;
  maxSubtasks: number;
  maxIterations: number;
  maxRunMinutes: number;
  /** Whether the operator approves the lead's plan before the work goes on. */
  planApproval: boolean;
  /** The projects for reference only (2026-10-21): the worker reads them and changes nothing there. */
  reference?: Array<{ name: string; dir: string }>;
};

/** The assignment as the lead is given it: the operator's message, and what the runner tells it about the work. */
export function assignmentMessage(task: Pick<Task, 'title' | 'prompt' | 'skill'>, n: number, facts: AssignmentFacts, again: boolean): string {
  return [
    again
      ? 'New assignment in this same conversation. The lead\'s contract you were given at the start still applies unchanged: the same format, the same rules. Restate this assignment in "understanding" in your first reply to it.'
      : '',
    `## Assignment ${n}: ${task.title.trim() || 'untitled'}`,
    '',
    task.prompt.trim(),
    '',
    // The operator's skill for this kind of work (2026-10-21): the lead plans by it, and every subtask carries it to the worker.
    ...(task.skill?.text.trim()
      ? [
          `## Skill: ${task.skill.name}`,
          '',
          ...(task.skill.description.trim() ? [`For: ${task.skill.description.trim()}`, ''] : []),
          'The operator\'s instructions for this kind of work. Plan and judge the work by them; the worker is given them with every subtask.',
          '',
          task.skill.text.trim(),
          '',
        ]
      : []),
    '## What the runner tells you',
    '',
    `- The project folder, where the worker's commands run: ${facts.workDir || '(none is open)'}.`,
    `- You may give the worker at most ${facts.maxSubtasks} subtask(s) for this assignment. Each subtask may take the worker up to ${facts.maxIterations} messages and ${facts.maxRunMinutes} minutes.`,
    facts.planApproval
      ? '- The operator approves plans: when you send "plan", the work waits for their answer.'
      : '- Plans are not put to the operator here: send "plan" all the same, so it is on record; the work goes on at once.',
    ...((facts.reference?.length ?? 0) > 0
      ? [
          `- For reference only, changed by nothing: ${facts.reference!.map((p) => `${p.name} (${p.dir})`).join(', ')}. The worker may read them and run what only reads; whatever it changes there is put back. Plan no change in them; if the result needs one, say so to the operator.`,
        ]
      : []),
    '- Reply in the lead\'s format.',
  ]
    .filter((l, i) => l !== '' || i > 0)
    .join('\n')
    .trim();
}

/**
 * "Continue" on a message of the lead's that stopped before its result (a limit, Stop, the bot closed): in the same
 * conversation, told why it stopped, to carry on from where the work got to — the subtasks and their reports are above
 * it — rather than to start the assignment again.
 */
export function continuationMessage(task: Pick<Task, 'title' | 'continuing'>, n: number, facts: AssignmentFacts): string {
  const instruction = task.continuing?.instruction?.trim();
  return [
    `Continue assignment ${n}: ${task.title.trim() || 'untitled'}, in this same conversation. ${task.continuing ? whyItStopped(task.continuing) : ''}`.trim(),
    '',
    'Do not start over: the subtasks so far and the worker\'s reports are above in this conversation. Say in "notes" where the work got to, and carry on from there in the lead\'s format.',
    ...(instruction ? ['', 'The operator adds this, which wins where it and the assignment disagree:', '', instruction] : []),
    '',
    `You may give the worker up to ${facts.maxSubtasks} more subtask(s) for it.`,
  ].join('\n');
}

/** A subtask, as the worker is given it: a task of its own, written so that someone who knows nothing else can do it. */
export function subtaskPrompt(sub: Subtask, n: number): string {
  return [
    `This task comes from the lead of the work, not straight from the operator: it is subtask ${n} of a larger assignment. Your closing summary is your report to the lead — put in it exactly what the lead asks for under "Report back", with the evidence (commands, their output, files and lines), not only your conclusions.`,
    '',
    `## Goal`,
    sub.goal.trim(),
    ...(sub.context.trim() ? ['', '## What you need to know', sub.context.trim()] : []),
    ...(sub.steps.length > 0 ? ['', '## How to go about it', ...sub.steps.map((s, i) => `${i + 1}. ${s}`)] : []),
    '',
    '## Report back',
    sub.report.trim(),
    ...(sub.doneWhen.trim() ? ['', '## Done when', sub.doneWhen.trim()] : []),
    ...(sub.readOnly ? ['', 'This subtask changes nothing: read, run and diagnose, but do not create, change or delete a file.'] : []),
  ].join('\n');
}

/** How a subtask ended, in the report's words. */
function endedAs(status: TaskOutcome['status']): string {
  switch (status) {
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked — the worker could not finish it';
    case 'limit-reached':
      return 'stopped at a limit of the settings, unfinished';
    case 'aborted':
      return 'stopped';
    default:
      return 'failed';
  }
}

/** What the lead is told when it has no subtask left. */
export function noSubtasksLeft(max: number): string {
  return [
    `No subtask is left: all ${max} of this assignment have been used. Do not send "delegate" again.`,
    'Deliver what the work has found (status "done", with what is missing said plainly in "answer"), or stop (status "blocked", with what would let it go on in "needed").',
  ].join('\n');
}

/** The plan, as the lead is told it was approved. */
export function leadPlanApproved(approval: NonNullable<TaskPlan['approved']>, left: number): string {
  return [
    approval.by === 'operator' ? 'The operator approved your plan.' : 'Your plan is on record; the operator is not asked about plans in this conversation.',
    ...(approval.note?.trim() ? ['', 'With this from the operator, which wins where it and the plan disagree:', '', approval.note.trim()] : []),
    '',
    `Carry it out now: give the worker the first subtask of it (status "delegate"). Subtasks left: ${left}.`,
  ].join('\n');
}

/** The operator asked the lead for another plan. */
export function leadPlanRevise(comment: string, version: number): string {
  return [
    `The operator read version ${version} of your plan and asks for another. What to change:`,
    '',
    comment.trim(),
    '',
    'Send the whole revised plan (status "plan"), not only what changed. You may give the worker a subtask first if you need to find something out for it.',
  ].join('\n');
}

/** The operator's answer to the lead's question. */
export function operatorAnswerMessage(answer: string, left: number): string {
  return ['The operator answers your question:', '', answer.trim(), '', `Go on in the lead's format. Subtasks left: ${left}.`].join('\n');
}

/** Nobody can answer the lead's question (a run with no page to ask on). */
export const NOBODY_TO_ASK =
  'Nobody can answer a question in this run: decide it yourself, the way that keeps the most options open, say the assumption in "notes", and go on.';

export async function runLeadTask(transport: ChatTransport, session: Session, task: Task, deps: RunDeps): Promise<TaskOutcome> {
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
  // Who is at work on the message now (2026-10-22): the lead, or the worker on a subtask it was given.
  const actingNow = async (actor: Actor, more: Omit<Acting, 'actor' | 'since'> = {}): Promise<void> => {
    const acting: Acting = { actor, since: new Date().toISOString(), ...more };
    await setTask((t) => {
      t.acting = acting;
    });
    sink.event('acting', acting, `at work now: ${ACTOR_WORDS[actor]}${more.subtask ? ` (subtask ${more.subtask})` : ''}`);
  };
  const max = Math.max(1, cfg.limits.maxSubtasks ?? 20);
  const lead: LeadRecord = { rounds: [], subtasks: 0, maxSubtasks: max };
  const saveLead = async (): Promise<void> => {
    const copy = JSON.parse(JSON.stringify(lead)) as LeadRecord;
    await setTask((t) => {
      t.lead = copy;
      t.iterations = copy.rounds.length;
    });
  };

  // From here the message's minutes are counted, its pauses taken off (2026-10-21).
  const leadStartedAt = Date.now();
  await setTask((t) => {
    t.status = 'running';
    t.runId = runId;
    t.runGroup = deps.runGroup;
    t.startedAt = new Date().toISOString();
    t.lead = { rounds: [], subtasks: 0, maxSubtasks: max };
  });
  await writeFile(taskLogPath, `TASK: ${task.title}\nSESSION: ${session.name} (${session.id})\nRUN: ${runId}\nSTARTED: ${new Date().toISOString()}\nMODE: lead and worker\n`, 'utf8');
  sink.event('task-started', { runId, title: task.title, lead: true }, `task "${task.title}" starting with a lead and a worker (run ${runId})`);
  await actingNow('lead');

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
    onGap: (ms) => sink.event('pacing-gap', { ms, lead: true }, `the next message to the lead waits ${Math.ceil(ms / 1000)} s: Settings ask for a pause between messages`),
  });
  let limitHit: TaskLimit | undefined;

  /*
   * Paused (see `Hold`): the lead's next message waits, as the worker's do in `runTask`. True when the run was stopped
   * while it was held.
   */
  const holdHere = async (): Promise<boolean> => {
    const hold = deps.hold;
    if (!hold?.held || signal?.aborted) return false;
    const from = Date.now();
    sink.event('task-paused', { before: 'message', lead: true }, 'paused by the operator: nothing more is sent to the lead until Continue');
    await hold.until(signal);
    const stopped = !!signal?.aborted;
    sink.event('task-resumed', { heldMs: Date.now() - from, stopped }, stopped ? 'stopped while paused' : 'continued by the operator');
    return stopped;
  };
  // No message to the lead longer than Settings allow as text: the rest goes attached (2026-10-22).
  const leadChat = limitsMessageLength(holdsWhilePaused(transport, holdHere), {
    max: cfg.limits.maxMessageChars,
    dir: log.path('messages'),
    onLong: ({ chars, max, file }) =>
      sink.event('message-long', { chars, max, file, lead: true }, `a message to the lead of ${chars} characters is over the ${max} sent as text: its beginning is sent, the whole of it attached as ${file}`, 'warn'),
  });

  let sent = 0;
  let replies = 0;
  /** One message to the lead, and its reply. */
  const tell = async (text: string): Promise<string> => {
    await pacer.throttleSend();
    // The operator's notes written while the work goes on ("Add to it") go to the lead with its next message.
    const notes = await store.takeUnsentNotes(session.id, task.id).catch(() => []);
    const message = notes.length > 0 ? `${text}\n\n${operatorNotesSection(notes, true)}` : text;
    if (notes.length > 0) sink.event('operator-note-sent', { notes: notes.length, with: 'lead' }, `${notes.length} note(s) from the operator go to the lead`);
    const before = await leadChat.sendAndConfirm(message);
    sent += 1;
    // Counted for the operator, with the worker's (2026-10-21): shown under the message and in the status bar.
    lead.messages = { lead: sent, worker: lead.messages?.worker ?? 0 };
    await saveLead();
    await writeFile(log.path('messages', `${String(sent).padStart(2, '0')}.md`), message, 'utf8').catch(() => undefined);
    sink.event('message-sent', { n: sent, chars: message.length, lead: true, chatId: session.chat?.chatId ?? null }, `message ${sent} sent to the lead (${message.length} chars)`);
    await record(`TO THE LEAD (${sent})`, message);
    const reply: ReplyCapture = await leadChat.waitForReply(before);
    replies += 1;
    await writeFile(log.path('replies', `${String(replies).padStart(2, '0')}-lead.md`), reply.markdown, 'utf8').catch(() => undefined);
    await record(`FROM THE LEAD (${replies})`, reply.markdown);
    await pacer.settle();
    await registerLeadChat();
    return reply.markdown;
  };

  /** The lead's conversation, put on record and named once it exists. */
  const registerLeadChat = async (): Promise<void> => {
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
    sink.event('chat-registered', { ...chat, lead: true }, `the lead's chat: ${chat.name}`);
  };

  const finish = async (status: TaskOutcome['status'], reason?: string, summary?: string): Promise<TaskOutcome> => {
    // What the whole of the message changed: the folder against its photograph from before it.
    let vcs: Task['vcs'];
    if (checkpoint && chatDir) {
      const after = await takeAfter(chatDir, task.id, checkpoint).catch((e: unknown) => ({ problem: (e as Error).message }));
      if (!('problem' in after)) vcs = { baseCommit: checkpoint.commit, commit: after.commit, files: await commitFiles(chatDir, after.commit).catch(() => []) };
    }
    await saveLead();
    await setTask((t) => {
      if (vcs) t.vcs = vcs;
      t.status = status;
      delete t.acting;
      t.finishedAt = new Date().toISOString();
      const held = deps.hold?.pausedSince(leadStartedAt) ?? 0;
      if (held > 0) t.pausedMs = held;
      t.summary = summary;
      t.reason = reason;
      t.logFile = 'task-log.txt';
      if (limitHit) t.limit = limitHit;
    });
    await record(`TASK ${status.toUpperCase()}`, [summary ?? '', reason ? `Reason: ${reason}` : ''].filter(Boolean).join('\n\n') || '(no details)');
    sink.event('task-finished', { status, reason, iterations: lead.rounds.length, subtasks: lead.subtasks, lead: true }, `task "${task.title}" ${status}${reason ? `: ${reason}` : ''}`);
    await log.close();
    return { status, iterations: lead.rounds.length, summary, reason };
  };

  /** The worker's session: made at the first subtask, with the chat's folder and the worker's model. */
  const workerSession = async (): Promise<Session> => {
    const now = await store.getSession(session.id);
    const id = now?.lead?.workerSessionId;
    const existing = id ? await store.getSession(id) : null;
    if (existing) {
      deps.onWorker?.(existing.id);
      lead.workerSessionId = existing.id;
      return existing;
    }
    const made = await store.createSession(`worker: ${session.name.replace(/^chat: /, '')}`, session.projectDir ?? '');
    const lead2 = now?.lead ?? {};
    const worker = await store.updateSession(made.id, (s) => {
      s.kind = 'chat';
      s.workerOf = session.id;
      s.onFailure = 'continue';
      /*
       * No version control of its own, as the chat has none (2026-10-17): the worker works on the branch the folder is
       * on, and each subtask is photographed instead. A session is made with it on, and the first worker made a branch
       * of the operator's repository and committed on it (found by the check, 2026-10-20).
       */
      s.vcs = { ...(s.vcs ?? DEFAULT_VCS), enabled: false, repoDir: '' };
      s.projectDir = session.projectDir ?? '';
      // The lead judges the worker's reports; there is no review of its own.
      s.review = { enabled: false, model: '' };
      s.planMode = 'off';
      /*
       * The worker's model as chosen under the chat's box; with none chosen, the lead's — by hand when the lead's is.
       * A worker with no model of its own would be asked about by hand on every conversation that named one.
       */
      const own = lead2.workerModel?.trim();
      if (lead2.workerManualModel || (!own && now?.manualModel)) s.manualModel = true;
      else if (own || now?.model?.trim()) {
        s.model = own || now?.model?.trim();
        s.modelSource = 'operator';
      }
      if (session.lang) s.lang = session.lang;
    });
    await store.updateSession(session.id, (s) => {
      s.lead = { ...(s.lead ?? {}), workerSessionId: worker.id };
    });
    lead.workerSessionId = worker.id;
    deps.onWorker?.(worker.id);
    sink.event('worker-made', { workerSessionId: worker.id }, 'a worker for the lead\'s subtasks');
    return worker;
  };

  /** The worker's report of a subtask, as the lead is given it. */
  const reportOf = async (workerId: string, taskId: string, out: TaskOutcome, n: number, title: string): Promise<string> => {
    const w = await store.getSession(workerId);
    const t = w?.tasks.find((x) => x.id === taskId);
    const story = t?.runId ? await buildStory(cfg.resolved.runsDir, t.runId, t, false).catch(() => null) : null;
    const steps = (story?.entries ?? []).flatMap((e) => (e.kind === 'step' ? [e] : e.kind === 'review' ? e.entries.filter((x) => x.kind === 'step') : [])) as Array<Extract<NonNullable<typeof story>['entries'][number], { kind: 'step' }>>;
    const commands = steps.slice(-25).map((s) => `- \`${s.command.replace(/\s+/g, ' ').slice(0, 160)}\` → ${s.exitCode ?? s.outcome ?? '?'}`);
    const files = (t?.vcs?.files ?? []).map((f) => f.path);
    return [
      `Report of subtask ${n} (${title}): ${endedAs(out.status)}.`,
      '',
      '### The worker\'s report',
      (t?.summary ?? out.summary ?? '').trim() || '(the worker gave no summary)',
      ...(out.status !== 'done' && (t?.reason ?? out.reason) ? ['', `### Why it ended so`, (t?.reason ?? out.reason ?? '').trim()] : []),
      ...(commands.length > 0 ? ['', `### The commands it ran, and their exit codes${steps.length > 25 ? ` (the last 25 of ${steps.length})` : ''}`, ...commands] : ['', 'It ran no command.']),
      '',
      files.length > 0 ? `Files it changed: ${files.join(', ')}.` : 'It changed no file.',
      ...((t?.deviations?.length ?? 0) > 0 ? ['', describeDeviations(t!.deviations!)] : []),
      '',
      `Subtasks left: ${max - lead.subtasks} of ${max}.`,
      // Its own list, as it sent it last, to send again with the next subtask (2026-10-21).
      ...(lead.ledger ? ['', describeLedger(lead.ledger, lead.subtasks, max)] : []),
      'Reply in the lead\'s format: the next subtask, the plan, a question for the operator, or the result.',
    ].join('\n');
  };

  /** One subtask: to the worker's conversation, carried out there as a task, and back to the lead with its report. */
  const runSubtask = async (sub: Subtask, round: LeadRound): Promise<{ report: string } | 'stopped'> => {
    lead.subtasks += 1;
    const n = lead.subtasks;
    let worker = await workerSession();
    if (sub.freshWorker && worker.chat) {
      worker = await store.updateSession(worker.id, (s) => {
        s.chat = undefined;
        s.contractSent = false;
        s.modelByHand = undefined;
      });
      sink.event('worker-fresh', { n }, `subtask ${n} goes to a fresh worker conversation`);
    }
    const made = await store.addTask(worker.id, { title: `${n}. ${sub.title}`, level2: '', prompt: subtaskPrompt(sub, n), reviewEnabled: false, readOnly: sub.readOnly, ...(task.skill ? { skill: task.skill } : {}) });
    await store.updateTask(worker.id, made.id, (t) => {
      t.fromLead = { sessionId: session.id, taskId: task.id, n };
    });
    round.subtask = { n, taskId: made.id, title: sub.title, ...(sub.readOnly ? { readOnly: true } : {}), ...(sub.freshWorker ? { fresh: true } : {}) };
    await saveLead();
    sink.event('subtask-given', { n, taskId: made.id, title: sub.title, readOnly: sub.readOnly, fresh: sub.freshWorker }, `subtask ${n} to the worker: ${sub.title}`);
    await actingNow('worker', { subtask: n });

    // To the worker's conversation, in the same window.
    speakFor(transport, worker.id);
    const fresh = !worker.chat;
    await enterSessionConversation(transport, worker, { closeOnFailure: false });
    const model = await applySessionModel(transport, worker, bus, cfg, store, deps.models, fresh, signal);
    if (model.refused) {
      speakFor(transport, session.id);
      if (signal?.aborted) return 'stopped';
      throw new Error(`The worker's conversation could not be put on its model: ${model.refused}`);
    }
    const current = (await store.getSession(worker.id)) as Session;
    const subtask = current.tasks.find((x) => x.id === made.id) as Task;
    // Every message the worker's task sends is counted as the worker's, as it goes.
    const counted = new Proxy(transport, {
      get(target, key) {
        if (key === 'sendAndConfirm') {
          return async (...args: Parameters<ChatTransport['sendAndConfirm']>) => {
            const r = await target.sendAndConfirm(...args);
            lead.messages = { lead: lead.messages?.lead ?? sent, worker: (lead.messages?.worker ?? 0) + 1 };
            await saveLead();
            return r;
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const out = await runTask(counted, current, subtask, { ...deps, approvePlan: undefined });
    speakFor(transport, session.id);
    if (transport.closedOutside()) throw new WindowClosed();
    if (signal?.aborted) return 'stopped';
    sink.event('subtask-ended', { n, status: out.status }, `subtask ${n} ${out.status}`);
    await actingNow('lead');

    // Back to the lead's conversation.
    const leadNow = (await store.getSession(session.id)) as Session;
    await enterSessionConversation(transport, leadNow, { closeOnFailure: false });
    const back = await applySessionModel(transport, leadNow, bus, cfg, store, deps.models, false, signal);
    if (back.refused) {
      if (signal?.aborted) return 'stopped';
      throw new Error(`The lead's conversation could not be put on its model again: ${back.refused}`);
    }
    return { report: await reportOf(worker.id, made.id, out, n, sub.title) };
  };

  try {
    const facts: AssignmentFacts = {
      workDir: chatDir,
      maxSubtasks: max,
      maxIterations: cfg.limits.maxIterations,
      maxRunMinutes: cfg.limits.maxRunMinutes,
      planApproval: session.planMode === 'approve' && !!deps.approvePlan,
      reference: [
        ...(cfg.project.readOnly && cfg.project.rootDir ? [{ name: cfg.project.name || cfg.project.rootDir, dir: cfg.project.rootDir }] : []),
        ...cfg.project.others.filter((o) => o.readOnly).map((o) => ({ name: o.name, dir: o.rootDir })),
      ],
    };
    const n = session.tasks.findIndex((x) => x.id === task.id) + 1;
    const contract = (await store.getLead1()).content.trim();
    // Carried on in its own conversation: told why it stopped, and to go on from there (see `continuationMessage`).
    const carryingOn = !!task.continuing && !!session.contractSent;
    const assignment = carryingOn ? continuationMessage(task, n || 1, facts) : assignmentMessage(task, n || 1, facts, !!session.contractSent);
    await setTask((t) => {
      t.firstMessage = session.contractSent ? assignment : `${contract}\n\n---\n\n${assignment}`;
    });
    await record('OPENING MESSAGE', session.contractSent ? assignment : `${contract}\n\n---\n\n${assignment}`);

    if (signal?.aborted) return await finish('aborted', 'stopped before the assignment was sent');
    let markdown: string;
    if (!session.contractSent) {
      await tell(contract);
      session.contractSent = true;
      await store.updateSession(session.id, (s) => {
        s.contractSent = true;
      });
    }
    markdown = await tell(assignment);

    const maxFormat = Math.max(0, cfg.limits.maxFormatRetries ?? 2);
    let formatRetries = 0;
    // A message carried on was restated when it began: its first reply now need not do it again.
    let understood = carryingOn;
    let planVersion = 0;
    let revisions: TaskPlan['revisions'] = [];
    const maxRounds = Math.max(1, cfg.limits.maxIterations);

    for (;;) {
      if (signal?.aborted) return await finish('aborted', 'stopped by the operator');
      if (lead.rounds.length >= maxRounds) {
        limitHit = { setting: 'maxIterations', value: maxRounds };
        return await finish('limit-reached', `maxIterations (${maxRounds}) reached: the lead's replies`);
      }
      const parsed = parseLeadReply(markdown);
      if (!parsed.ok) {
        formatRetries += 1;
        if (formatRetries > maxFormat) {
          limitHit = { setting: 'maxFormatRetries', value: maxFormat };
          return await finish('limit-reached', `maxFormatRetries (${maxFormat}) reached: the lead's replies did not match its format (${parsed.detail})`);
        }
        sink.event('lead-format-retry', { reason: parsed.reason, detail: parsed.detail, retry: formatRetries }, `the lead's reply did not match its format, asked again (${formatRetries} of ${maxFormat})`, 'warn');
        markdown = await tell(leadFormatErrorMessage(parsed, formatRetries, maxFormat));
        continue;
      }
      const r = parsed.reply;
      if (!understood && !r.understanding) {
        formatRetries += 1;
        if (formatRetries > maxFormat) {
          limitHit = { setting: 'maxFormatRetries', value: maxFormat };
          return await finish('limit-reached', `maxFormatRetries (${maxFormat}) reached: the lead did not restate the assignment`);
        }
        markdown = await tell(UNDERSTANDING_FIRST);
        continue;
      }
      formatRetries = 0;
      understood = true;
      const round: LeadRound = {
        n: lead.rounds.length + 1,
        at: new Date().toISOString(),
        status: r.status,
        ...(r.understanding ? { understanding: r.understanding } : {}),
        ...(r.notes ? { notes: r.notes } : {}),
      };
      lead.rounds.push(round);
      // Its list of subtasks, as this reply sends it (2026-10-21); the subtask given now is the running one.
      const giving = r.status === 'delegate' && r.subtask && lead.subtasks < max ? { title: r.subtask.title, n: lead.subtasks + 1 } : undefined;
      const listed = nextLedger(lead.ledger, r.todo, round.at, giving);
      lead.ledger = listed.ledger;
      if (listed.change) {
        round.ledger = listed.change;
        const { revision, added, removed, total } = listed.change;
        sink.event(
          'lead-ledger',
          { round: round.n, ...listed.change },
          revision === 1
            ? `the lead's list: ${total} subtask(s)`
            : `the lead's list changed (version ${revision}): ${total} subtask(s)${added > 0 ? `, ${added} new` : ''}${removed > 0 ? `, ${removed} dropped` : ''}${added === 0 && removed === 0 ? ', in another order' : ''}`,
        );
      }
      await saveLead();
      sink.event('lead-reply', { round: round.n, status: r.status }, `the lead: ${r.status}${r.subtask ? ` — ${r.subtask.title}` : ''}`);

      switch (r.status) {
        case 'delegate': {
          if (lead.subtasks >= max) {
            markdown = await tell(noSubtasksLeft(max));
            break;
          }
          const ran = await runSubtask(r.subtask!, round);
          if (ran === 'stopped') return await finish('aborted', 'stopped by the operator');
          markdown = await tell(ran.report);
          break;
        }
        case 'plan': {
          planVersion += 1;
          const plan = planFrom(r.plan!, planVersion, revisions);
          await setTask((t) => {
            t.plan = plan;
          });
          await record(`THE LEAD'S PLAN (version ${planVersion})`, describePlan(plan));
          let approved: NonNullable<TaskPlan['approved']>;
          if (facts.planApproval && deps.approvePlan) {
            const answer = await deps.approvePlan({ sessionId: session.id, taskId: task.id, title: task.title, plan, actor: 'lead' });
            if (answer.decision === 'stop' || signal?.aborted) return await finish('aborted', 'the operator stopped the task at the lead\'s plan');
            if (answer.decision === 'revise') {
              revisions = [...(revisions ?? []), { version: planVersion, comment: answer.note ?? '', at: new Date().toISOString() }];
              await setTask((t) => {
                if (t.plan) t.plan.revisions = revisions;
              });
              markdown = await tell(leadPlanRevise(answer.note ?? '', planVersion));
              break;
            }
            approved = { by: 'operator', at: new Date().toISOString(), ...(answer.note?.trim() ? { note: answer.note.trim() } : {}) };
          } else {
            approved = { by: 'auto', at: new Date().toISOString(), why: 'plans are not put to the operator in this conversation' };
          }
          await setTask((t) => {
            if (t.plan) t.plan.approved = approved;
          });
          markdown = await tell(leadPlanApproved(approved, max - lead.subtasks));
          break;
        }
        case 'ask': {
          round.question = { text: r.question!, ...(r.why ? { why: r.why } : {}), ...(r.options.length > 0 ? { options: r.options } : {}) };
          await saveLead();
          if (!deps.askQuestion) {
            markdown = await tell(NOBODY_TO_ASK);
            break;
          }
          sink.event('lead-question', { round: round.n, question: r.question }, `the lead asks the operator: ${r.question}`, 'warn');
          const got = await deps.askQuestion({ sessionId: session.id, taskId: task.id, question: r.question!, ...(r.why ? { why: r.why } : {}), options: r.options });
          if (got === 'stop' || signal?.aborted) return await finish('aborted', 'the operator stopped the task at the lead\'s question');
          round.question.answer = got.answer;
          round.question.at = new Date().toISOString();
          await saveLead();
          sink.event('lead-question-answered', { round: round.n }, 'the operator answered the lead');
          markdown = await tell(operatorAnswerMessage(got.answer, max - lead.subtasks));
          break;
        }
        case 'done': {
          lead.evidence = r.evidence;
          // Delivered: the subtask it was on was accepted with it.
          lead.ledger = closeLedger(lead.ledger, 'done');
          return await finish('done', undefined, r.answer);
        }
        case 'blocked': {
          lead.ledger = closeLedger(lead.ledger, 'blocked');
          return await finish('blocked', `the lead could not take it further: ${r.needed ?? ''}`.trim(), r.summary);
        }
      }
    }
  } catch (e) {
    const message = (e as Error).message;
    if (e instanceof StoppedSend || signal?.aborted) return await finish('aborted', 'stopped by the operator; nothing more was sent');
    if (isReplyTimeout(e)) {
      limitHit = { setting: 'replyTimeoutSec', value: e.seconds };
      return await finish('limit-reached', `replyTimeoutSec (${e.seconds}) reached: ${message}`);
    }
    if (e instanceof WindowClosed || transport.closedOutside()) return await finish('aborted', 'the browser window was closed; nothing more was sent');
    sink.event('task-error', { error: message, stack: (e as Error).stack }, message, 'error');
    return await finish('failed', message);
  }
}
