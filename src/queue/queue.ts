/**
 * The queue of tasks (operator, 2026-10-24: "an option to prepare several tasks that run in a queue"): tasks written
 * beforehand, each with its own model, run one after another while nobody watches, each in a new chat.
 *
 * The operator's rules, as they asked for them:
 *
 * - each task in a new chat, on its own model (empty: "Model for the worker" in Settings), chosen by the bot;
 * - a task may depend on earlier ones, chosen task by task. When one fails, every task that depends on it — or on a
 *   task skipped for it — is skipped, and the queue goes on with the next one that does not;
 * - a task works in the folder as it is, or on a new branch made from main. The server's main is fetched without a
 *   password or a key's passphrase, which nobody is there to type; when it cannot be, the local main is used, and the
 *   chat is told which it was;
 * - a task may carry one of Settings' skills, sent with it as the chat's box sends one (2026-10-25);
 * - a task added while something else works — a message of the chat, sent there directly — starts after it
 *   (2026-10-25): the queue waits for the browser to be free before it takes the next task;
 * - a task that waits for the operator longer than the queue allows — a plan to approve, a question, a command, a
 *   model to choose, a password — is set aside ("parked") with what it waits for kept, and the queue goes on with the
 *   next (2026-10-26). Answered later, it carries on from where it stopped, before the others waiting; the tasks that
 *   depend on it wait for it rather than being skipped. A task "on a new branch from main" has its branch made when it
 *   is added, brought up to the remote's main when it starts if nothing is on it yet.
 *
 * Kept as `data/queue.json` (see `OperatorService.queue`). This module is the part that needs no browser: the shape,
 * the checks of an edit, and which task is next.
 */
import { branchExists } from '../vcs/git.js';
import type { ParkedAnswer, ParkedKind, PendingApproval, RetryChoice } from '../session/model.js';

export type QueueBranch = 'folder' | 'main';
/** `parked`: set aside while it waited for the operator, until answered (2026-10-26). */
export type QueueStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped' | 'stopped' | 'parked';

export type QueueItem = {
  id: string;
  /** What the list and the picture of the queue call it (2026-10-24); empty: the task's first line. */
  name?: string;
  prompt: string;
  /** The model it runs on, as the picker names it; empty: Settings' "Model for the worker". */
  model: string;
  /** Earlier tasks of the queue this one needs: skipped when one of them did not end done. */
  dependsOn: string[];
  /** The folder as it is, or a new branch from main (see the module's comment). */
  branch: QueueBranch;
  /** A second conversation checks the work, as the chat's REVIEW box does. Not with two chats: the lead judges. */
  review: boolean;
  /** The review's model; empty: Settings' "Model for the review" (2026-10-24). */
  reviewModel?: string;
  /**
   * Two chats, as the chat's box has them (2026-10-24): a lead that directs, on `model`, and a worker that carries out,
   * on `workerModel` (empty: Settings' "Model for the worker", else the lead's).
   */
  lead?: boolean;
  workerModel?: string;
  /** One of Settings' skills, by its name, sent with the task as `/its-name` sends it in the chat (2026-10-25). */
  skill?: string;
  /** "Plan first" (2026-10-26): the plan, the lead's with two chats, is approved by the operator before the work. */
  plan?: boolean;
  /**
   * The branch made for it when it was added (2026-10-26), for a task "on a new branch from main", and the commit of
   * the remote's main it was made at. Given by the bot, not by the operator.
   */
  branchName?: string;
  branchBase?: string;
  /** What it was made from: the remote's main as fetched then (`origin/main`), or the local main when it could not be. */
  branchFrom?: string;
  /** Parked, and what it waits for, as the queue's page shows it (2026-10-26). The answer goes to the task's record. */
  waitsFor?: { kind: ParkedKind; at: string; approval: PendingApproval };
  /** Answered after it was parked: it carries on from where it stopped, at the queue's next turn, before the others. */
  resume?: boolean;
  status: QueueStatus;
  /** Why it failed, was skipped or stopped, in a sentence. */
  why?: string;
  /** The chat it ran in. */
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
};

export type Queue = {
  items: QueueItem[];
  /** The queue is being run: one task at a time until none is waiting, or it is stopped. */
  running: boolean;
  updatedAt: string;
  /** What has the browser now, other than the queue's own task: its next task starts after it. Said, never kept. */
  busy?: QueueBusy;
  /**
   * How long a task may wait for the operator before it is set aside and the queue goes on (2026-10-26), in seconds;
   * 0 waits as long as it takes. Default `DEFAULT_PARK_AFTER_SEC`.
   */
  parkAfterSec?: number;
};

export const DEFAULT_PARK_AFTER_SEC = 120;
export const MAX_PARK_AFTER_SEC = 24 * 60 * 60;

/** How long a task waits for the operator before it is parked, in milliseconds; null: as long as it takes. */
export function parkAfterMs(q: Pick<Queue, 'parkAfterSec'>): number | null {
  const sec = typeof q.parkAfterSec === 'number' && Number.isFinite(q.parkAfterSec) ? Math.max(0, Math.min(MAX_PARK_AFTER_SEC, Math.round(q.parkAfterSec))) : DEFAULT_PARK_AFTER_SEC;
  return sec === 0 ? null : sec * 1000;
}

/** Work that has the browser: a message of the chat (its conversation and what it is), a reading of the models, the sign-in. */
export type QueueBusy = { kind: 'chat'; sessionId: string; title: string } | { kind: 'models' } | { kind: 'login' };

export const MAX_QUEUE_ITEMS = 50;

export function emptyQueue(): Queue {
  return { items: [], running: false, updatedAt: new Date().toISOString() };
}

/** A task's name, or its first line where it has none. */
export function itemTitle(item: Pick<QueueItem, 'prompt' | 'name'>): string {
  return item.name?.trim() || item.prompt.split(/\r?\n/)[0]!.trim().slice(0, 80) || 'task';
}

export const MAX_QUEUE_NAME = 80;

/** An edit of the list as the page sends it, held to the rules, or the sentence that says why it cannot be. */
export function checkItems(items: unknown, maxPromptChars: number): { items: Array<Omit<QueueItem, 'status'> & { status?: QueueStatus }> } | { problem: string } {
  if (!Array.isArray(items)) return { problem: 'The queue comes as a list of tasks.' };
  if (items.length > MAX_QUEUE_ITEMS) return { problem: `A queue holds at most ${MAX_QUEUE_ITEMS} tasks.` };
  const seen = new Set<string>();
  const out: Array<Omit<QueueItem, 'status'> & { status?: QueueStatus }> = [];
  for (const [i, raw] of items.entries()) {
    const x = (raw ?? {}) as Record<string, unknown>;
    const n = i + 1;
    const id = String(x.id ?? '').trim();
    if (!/^[a-z0-9-]{1,40}$/i.test(id)) return { problem: `Task ${n} has no id the queue can keep.` };
    if (seen.has(id)) return { problem: `Two tasks have the id "${id}".` };
    const prompt = String(x.prompt ?? '').trim();
    if (!prompt) return { problem: `Task ${n} says nothing: write what it is to do.` };
    if (prompt.length > maxPromptChars) return { problem: `Task ${n} is ${prompt.length} characters; a task can be at most ${maxPromptChars}.` };
    const dependsOn = Array.isArray(x.dependsOn) ? [...new Set(x.dependsOn.map((d) => String(d)))] : [];
    // On earlier tasks only: they run first, so a task never waits for one after it, and never for itself.
    const late = dependsOn.find((d) => !seen.has(d));
    if (late) return { problem: `Task ${n} depends on ${items.some((o) => (o as { id?: unknown })?.id === late) ? 'a task after it' : `"${late}", which is not in the queue`}: a task can depend only on tasks before it.` };
    const branch = x.branch === 'main' ? 'main' : 'folder';
    const status = typeof x.status === 'string' && ['waiting', 'running', 'done', 'failed', 'skipped', 'stopped', 'parked'].includes(x.status) ? (x.status as QueueStatus) : undefined;
    const text = (v: unknown): string => String(v ?? '').trim();
    const name = text(x.name);
    if (name.length > MAX_QUEUE_NAME) return { problem: `The name of task ${n} is longer than ${MAX_QUEUE_NAME} characters.` };
    const lead = x.lead === true;
    // As typed after "/" in the chat, or as Settings list it: whether it is there is the server's to say.
    const skill = text(x.skill).replace(/^\//, '').toLowerCase();
    out.push({
      id,
      ...(name ? { name } : {}),
      prompt,
      model: text(x.model),
      dependsOn,
      branch,
      // With two chats the lead judges the worker's reports: no review of its own, as in the chat.
      review: !lead && x.review !== false,
      ...(!lead && text(x.reviewModel) ? { reviewModel: text(x.reviewModel) } : {}),
      ...(lead ? { lead: true } : {}),
      ...(lead && text(x.workerModel) ? { workerModel: text(x.workerModel) } : {}),
      ...(skill ? { skill } : {}),
      ...(x.plan === true ? { plan: true } : {}),
      ...(status ? { status } : {}),
    });
    seen.add(id);
  }
  return { items: out };
}

/**
 * The list as edited, onto the queue as it is: a task already there keeps what the runs gave it — its status, why,
 * its chat — unless it is being put back to wait ("Run again"); a task that is running is kept as it is, whatever
 * the edit says; a new one waits.
 */
export function mergeItems(current: QueueItem[], edited: Array<Omit<QueueItem, 'status'> & { status?: QueueStatus }>): { items: QueueItem[] } | { problem: string } {
  const before = new Map(current.map((x) => [x.id, x]));
  const running = current.find((x) => x.status === 'running');
  if (running && !edited.some((x) => x.id === running.id)) return { problem: `"${itemTitle(running)}" is running: stop the queue before taking it out.` };
  const items = edited.map((x): QueueItem => {
    const was = before.get(x.id);
    if (was?.status === 'running') return was;
    if (!was) return { ...x, status: 'waiting' };
    const again = x.status === 'waiting' && was.status !== 'waiting';
    const given = asGiven(x);
    // "Run again" starts it over, on a branch made for it again when it is one of its own.
    if (again) return { ...given, status: 'waiting' };
    // A parked task keeps what it waits for; its answer is given on its card, not by an edit of the list.
    if (was.status === 'parked') return { ...was, ...given, status: 'parked' };
    // Where it works changed: the branch made for it no longer is its.
    if (was.branch !== given.branch) {
      const { branchName: _name, branchBase: _base, ...rest } = was;
      return { ...rest, ...given, status: was.status };
    }
    // What the runs gave it stays; what the operator gives it is the edit's, a field left out of it gone.
    const kept: Partial<QueueItem> = { ...was };
    for (const key of GIVEN) delete kept[key];
    return { ...kept, ...given, status: was.status };
  });
  return { items };
}

/** What the operator gives a task, apart from what its runs give it. */
const GIVEN = ['id', 'name', 'prompt', 'model', 'dependsOn', 'branch', 'review', 'reviewModel', 'lead', 'workerModel', 'skill', 'plan'] as const;
function asGiven(x: Omit<QueueItem, 'status'> & { status?: QueueStatus }): Omit<QueueItem, 'status'> {
  const out: Record<string, unknown> = {};
  for (const key of GIVEN) if (x[key] !== undefined) out[key] = x[key];
  return out as Omit<QueueItem, 'status'>;
}

/**
 * Which of a task's conversations would wait for a model to be chosen by hand, and nobody is there to: its own (the
 * lead's, with two chats) with no model of its own and none in Settings, and its review with none of its own and no
 * "Model for the review" in Settings — a chat that names no model is asked for it by hand (`modelByHand`). The worker
 * of two chats never does: with no model of its own or in Settings, it is on the lead's.
 */
export function waitsByHand(
  item: Pick<QueueItem, 'model' | 'review' | 'reviewModel' | 'lead'>,
  copilot: { defaultModel?: string; defaultLeadModel?: string; defaultReviewModel?: string },
): Array<'model' | 'review'> {
  const set = (v?: string): boolean => !!v?.trim();
  const settingsModel = item.lead ? set(copilot.defaultLeadModel) || set(copilot.defaultModel) : set(copilot.defaultModel);
  return [
    ...(!set(item.model) && !settingsModel ? (['model'] as const) : []),
    ...(!item.lead && item.review && !set(item.reviewModel) && !set(copilot.defaultReviewModel) ? (['review'] as const) : []),
  ];
}

/**
 * What the queue does next: run the first task that waits, or skip it when a task it depends on did not end done
 * (failed, was skipped, was stopped); nothing when no task waits.
 */
export function nextStep(items: QueueItem[]): { run: QueueItem } | { skip: QueueItem; because: QueueItem } | null {
  const byId = new Map(items.map((x) => [x.id, x]));
  // An answered parked task first (2026-10-26): it carries on from where it stopped, before the others waiting.
  const resumed = items.find((x) => x.status === 'waiting' && x.resume);
  if (resumed) return { run: resumed };
  for (const item of items) {
    if (item.status !== 'waiting') continue;
    const needs = item.dependsOn.map((d) => byId.get(d));
    const blocker = needs.find((d) => !d || d.status === 'failed' || d.status === 'skipped' || d.status === 'stopped');
    if (blocker) return { skip: item, because: blocker };
    // One it needs is parked, or waits to carry on: this one waits for it, rather than being skipped.
    if (needs.some((d) => d!.status !== 'done')) continue;
    return { run: item };
  }
  return null;
}

/** Why a task is skipped, in a sentence. */
export function skippedBecause(because: QueueItem): string {
  const what = because.status === 'failed' ? 'failed' : because.status === 'stopped' ? 'was stopped' : because.status === 'skipped' ? 'was skipped' : `has not run (${because.status})`;
  return `it depends on "${itemTitle(because)}", which ${what}`;
}

/** A task's status from how its message ended. */
export function statusOfTask(taskStatus: string | undefined): QueueStatus {
  return taskStatus === 'done' ? 'done' : taskStatus === 'aborted' ? 'stopped' : 'failed';
}

/** The branch a task "on a new branch from main" starts from: `main`, else `master`, as the repository has it. */
export async function mainBranchOf(dir: string): Promise<string | null> {
  for (const name of ['main', 'master']) if (await branchExists(dir, name)) return name;
  return null;
}

/** What a parked task waits for, in the words the queue's page and its log use (2026-10-26). */
export const PARKED_WORDS: Record<ParkedKind, string> = {
  plan: 'its plan, to approve',
  question: 'an answer to its question',
  retry: 'what to do with a subtask that was cut off',
  command: 'your word on a command',
  model: 'the model, to be chosen by hand',
  password: 'a password Git asked for',
};

/** The operator's answer to a parked task, held to what its card offered, or why it cannot be taken. */
export function parkedAnswerFrom(p: { kind: ParkedKind; approval: PendingApproval }, input: Record<string, unknown>): ParkedAnswer | { problem: string } {
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  switch (p.kind) {
    case 'plan':
      if (input.decision === 'approve') return { kind: 'plan', decision: 'approve', ...(text(input.note) ? { note: text(input.note) } : {}) };
      if (input.decision === 'revise') return text(input.note) ? { kind: 'plan', decision: 'revise', note: text(input.note) } : { problem: 'Say what to change in the plan.' };
      return { problem: 'A plan is approved, or sent back for another.' };
    case 'question':
      // Commands handed over (2026-10-26): what they printed, or that the operator did not run them, with a word or none.
      if (p.approval.question?.handoff) {
        if (input.ran === false) return { kind: 'question', answer: text(input.answer), ran: false };
        return text(input.answer) ? { kind: 'question', answer: text(input.answer), ran: true } : { problem: 'Paste what the commands printed first.' };
      }
      return text(input.answer) ? { kind: 'question', answer: text(input.answer) } : { problem: 'Write the answer first.' };
    case 'retry': {
      const choices = p.approval.retry?.choices ?? [];
      return typeof input.choice === 'string' && choices.includes(input.choice as RetryChoice) ? { kind: 'retry', choice: input.choice as RetryChoice } : { problem: `Choose one of: ${choices.join(', ')}.` };
    }
    case 'command':
      return input.decision === 'run' || input.decision === 'skip' ? { kind: 'command', decision: input.decision } : { problem: 'A command is run or skipped.' };
    default:
      return { kind: 'resume' };
  }
}
