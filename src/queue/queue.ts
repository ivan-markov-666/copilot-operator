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
import { handoffOutcomeOf } from '../orchestrator/handoff.js';
import { chosenAnswer } from '../orchestrator/chosenAnswers.js';
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
  /**
   * A task on "the folder as it is" waiting to carry on: what it had not committed, put aside by a task after it that
   * works on a branch of its own (`cop/saved/…`, 2026-11-18), put back when it carries on.
   */
  setAside?: string[];
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
export type QueueBusy = { kind: 'chat'; sessionId: string; title: string } | { kind: 'models' } | { kind: 'login' } | { kind: 'locators' };

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
    /*
     * A task that carries on in its own chat (`resume`: the queue stopped or the bot closed under it, or answered after it
     * was set aside) carries on as it was given there, so an edit of what it does was kept and never used (bug hunt
     * 2026-11-18). Such an edit starts it over, as "Run again" does, with the edit; its name and what it depends on are
     * the queue's own, and leave it carrying on.
     */
    if (was.resume && WHAT_IT_DOES.some((key) => asSaid(was[key]) !== asSaid(given[key]))) return { ...given, status: 'waiting' };
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

/** A task as an edit of the list gives it. */
export type QueueEdit = Omit<QueueItem, 'status'> & { status?: QueueStatus };

/**
 * An edit a page made on the list it had read (`seen`), put onto the queue as it is now (second bug hunt, 2026-11-19).
 * The page sends the whole list, and a list read before a change — a second tab, or a page that had not read again yet —
 * dropped a task added since, put back one taken out since (to run again), and undid an edit made elsewhere. What this
 * page changed is taken; what it did not touch stays as the queue has it now:
 * - a task added since stays, after the tasks it came after;
 * - one taken out since stays out;
 * - a field this page did not change keeps the queue's value, so an edit made elsewhere is not undone;
 * - the order is this page's when it moved something, else the queue's.
 * A new task whose id was given meanwhile to another gets one of its own.
 */
export function rebaseEdit(current: QueueItem[], seen: QueueEdit[], edited: QueueEdit[]): QueueEdit[] {
  const saw = new Map(seen.map((x) => [x.id, x]));
  const now = new Map(current.map((x) => [x.id, x]));
  const taken = new Set([...current.map((x) => x.id), ...seen.map((x) => x.id)]);
  const renamed = new Map<string, string>();
  const kept = new Map<string, QueueEdit>();
  const fresh: QueueEdit[] = [];
  const pageOrder: string[] = [];
  for (const e of edited) {
    const was = saw.get(e.id);
    if (!was) {
      let id = e.id;
      while (taken.has(id)) id = `${id}x`;
      taken.add(id);
      if (id !== e.id) renamed.set(e.id, id);
      const dependsOn = e.dependsOn.map((d) => renamed.get(d) ?? d);
      fresh.push({ ...e, id, dependsOn });
      pageOrder.push(id);
      continue;
    }
    const is = now.get(e.id);
    if (!is) continue;
    const out: Record<string, unknown> = { id: e.id };
    for (const key of GIVEN) {
      if (key === 'id') continue;
      const v = asSaid(e[key]) === asSaid(was[key]) ? is[key] : e[key];
      if (v !== undefined) out[key] = v;
    }
    if (e.status) out.status = e.status;
    kept.set(e.id, out as QueueEdit);
    pageOrder.push(e.id);
  }
  const knownOnPage = pageOrder.filter((id) => kept.has(id));
  const moved = knownOnPage.join('\n') !== seen.map((x) => x.id).filter((id) => kept.has(id)).join('\n');
  const since = current.filter((x) => !saw.has(x.id));
  let order: string[];
  if (moved) {
    order = [...pageOrder];
    // After every task it came after: one added at the end stays at the end.
    for (const x of since) {
      const i = current.indexOf(x);
      const at = Math.max(0, ...current.slice(0, i).map((o) => order.indexOf(o.id) + 1));
      order.splice(at, 0, x.id);
    }
  } else {
    order = [...current.filter((x) => kept.has(x.id) || !saw.has(x.id)).map((x) => x.id), ...fresh.map((x) => x.id)];
  }
  const byId = new Map<string, QueueEdit>([...kept, ...fresh.map((x) => [x.id, x] as const), ...since.map((x) => [x.id, asGiven(x)] as const)]);
  // What a task depends on is a task before it that is still there.
  const before = new Set<string>();
  return order.map((id) => {
    const x = byId.get(id)!;
    const dependsOn = x.dependsOn.filter((d) => before.has(d));
    before.add(id);
    return dependsOn.length === x.dependsOn.length ? x : { ...x, dependsOn };
  });
}

/**
 * Whether an edit leaves a task carrying on in its own chat, as `mergeItems` keeps it: one that carries on, with nothing
 * of what it does changed. It goes on as it was given there, its skill sent with it already, so a skill taken out of
 * Settings since is not its concern (second bug hunt, 2026-11-19: it blocked every edit of the queue).
 */
export function carriesOn(was: QueueItem, edit: QueueEdit): boolean {
  if (!was.resume || was.status !== 'waiting') return false;
  const given = asGiven(edit);
  return !WHAT_IT_DOES.some((key) => asSaid(was[key]) !== asSaid(given[key]));
}

/** What the operator gives a task, apart from what its runs give it. */
const GIVEN = ['id', 'name', 'prompt', 'model', 'dependsOn', 'branch', 'review', 'reviewModel', 'lead', 'workerModel', 'skill', 'plan'] as const;
/** Of what is given, what the task's chat is told: an edit of it starts over a task that carries on. */
const WHAT_IT_DOES = ['prompt', 'model', 'branch', 'review', 'reviewModel', 'lead', 'workerModel', 'skill', 'plan'] as const;
/** A field as an edit says it: off, empty or left out are the same. */
const asSaid = (v: unknown): string => JSON.stringify(v === false || v === '' || v === null ? undefined : v) ?? '';
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

/**
 * Whether the queue holds a chat for this task: set aside with its card, or carrying on in it at its next turn. A task
 * the queue lets go of — taken out, run again, started over — has its chat's card closed (2026-11-19).
 */
export function holdsChat(x: Pick<QueueItem, 'sessionId' | 'status' | 'resume'>): boolean {
  return !!x.sessionId && (x.status === 'parked' || (x.status === 'waiting' && x.resume === true));
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
      // Commands handed over (2026-10-26): what they printed, sent back with what to correct (2026-10-27), or not run.
      if (p.approval.question?.handoff) {
        const outcome = handoffOutcomeOf(input.outcome, input.ran);
        if (outcome === 'declined') return { kind: 'question', answer: text(input.answer), ran: false, outcome };
        if (outcome === 'revise') return text(input.answer) ? { kind: 'question', answer: text(input.answer), outcome } : { problem: 'Say what to correct first.' };
        return text(input.answer) ? { kind: 'question', answer: text(input.answer), ran: true, outcome } : { problem: 'Paste what the commands printed first.' };
      }
      // A question of several answers (2026-11-02): the ones chosen, by their place, and any text besides.
      if (input.chosen !== undefined && p.approval.question) {
        const many = chosenAnswer(p.approval.question, input.chosen, text(input.answer));
        return 'problem' in many ? many : { kind: 'question', ...many };
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
