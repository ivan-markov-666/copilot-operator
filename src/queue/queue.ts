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
 *   chat is told which it was.
 *
 * Kept as `data/queue.json` (see `OperatorService.queue`). This module is the part that needs no browser: the shape,
 * the checks of an edit, and which task is next.
 */
import { branchExists } from '../vcs/git.js';

export type QueueBranch = 'folder' | 'main';
export type QueueStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped' | 'stopped';

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
};

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
    const status = typeof x.status === 'string' && ['waiting', 'running', 'done', 'failed', 'skipped', 'stopped'].includes(x.status) ? (x.status as QueueStatus) : undefined;
    const text = (v: unknown): string => String(v ?? '').trim();
    const name = text(x.name);
    if (name.length > MAX_QUEUE_NAME) return { problem: `The name of task ${n} is longer than ${MAX_QUEUE_NAME} characters.` };
    const lead = x.lead === true;
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
    if (again) return { ...given, status: 'waiting' };
    // What the runs gave it stays; what the operator gives it is the edit's, a field left out of it gone.
    const kept: Partial<QueueItem> = { ...was };
    for (const key of GIVEN) delete kept[key];
    return { ...kept, ...given, status: was.status };
  });
  return { items };
}

/** What the operator gives a task, apart from what its runs give it. */
const GIVEN = ['id', 'name', 'prompt', 'model', 'dependsOn', 'branch', 'review', 'reviewModel', 'lead', 'workerModel'] as const;
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
  for (const item of items) {
    if (item.status !== 'waiting') continue;
    const blocker = item.dependsOn.map((d) => byId.get(d)).find((d) => !d || d.status !== 'done');
    if (blocker) return { skip: item, because: blocker };
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
