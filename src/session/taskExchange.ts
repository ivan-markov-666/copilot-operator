/**
 * Everything that passed between the bot and Copilot for one task, as one JSON document.
 *
 * Asked for on 2026-10-18 for the workbench's chat: "a JSON with the whole communication between the bot and
 * Copilot, every terminal command that ran and every response from them — one per task the user gives, not for
 * the whole chat session, only what happened since that message". A task here is one message of the chat (or one
 * task of a session), with every attempt of it in order: the retries in a fresh conversation, the continuations.
 * Nothing from the messages before it or after it.
 *
 * Read from the attempt's run folder, file by file, and nothing is clipped or inferred:
 *
 * - `messages/NN.md` is every message the bot sent into the conversation, in the order it went out, the opening
 *   included; the files attached to it are named by the transcript and read from `reports/`;
 * - `replies/NN-<label>.md` is every reply, as it was copied from the chat;
 * - `steps/<iteration>-<step>.log` is every command that ran, with its shell, its folder, its whole output, its
 *   exit code and how long it took; the command itself is the one the transcript recorded as proposed, since a
 *   command of several lines spills into the log's output;
 * - a step that was not run (refused, skipped) is in the transcript only, and is listed with why;
 * - `checks/` holds the runner's own checks after "done", in the same form as a step;
 * - `review/N/` holds a review round's conversation, in the same form again;
 * - `transcript.jsonl` is the run's own record of everything, kept whole beside the rest as `events`.
 *
 * Each entry's time is its file's creation time (when the runner wrote it, which is when it happened; see
 * `story.ts`), or the transcript's time for what has no file. Entries are in time order.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session, Task } from './model.js';

export type ExchangeCommand = {
  kind: 'command';
  at?: string;
  /** The round of the conversation it was proposed in, and its number in that reply. */
  iteration: number;
  step: number;
  shell?: string;
  cwd?: string;
  command: string;
  /** Everything it printed, stdout and stderr as they came. */
  output: string;
  outcome?: string;
  exitCode?: number;
  durationMs?: number;
};

export type ExchangeEntry =
  | { kind: 'sent'; at?: string; n: number; text: string; attachments: Array<{ name: string; text: string | null }> }
  | { kind: 'reply'; at?: string; n: number; label: string; text: string }
  | ExchangeCommand
  | { kind: 'not-run'; at?: string; step: number; command?: string; reason: string; by?: string }
  | ({ kind: 'check'; file: string } & Omit<ExchangeCommand, 'kind' | 'iteration' | 'step'>)
  | { kind: 'review'; at?: string; round: number; entries: ExchangeEntry[] };

export type ExchangeAttempt = {
  attempt: number;
  runId: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  reason?: string;
  /** The Copilot conversation it ran in, as the run folder recorded it. */
  conversation: { chatId: string; name?: string; url?: string } | null;
  counts: { sent: number; replies: number; commands: number; failed: number; notRun: number; checks: number };
  entries: ExchangeEntry[];
  /** The run's transcript, every event as it was written. */
  events: Array<Record<string, unknown>>;
};

export type TaskExchange = {
  format: 'copilot-operator.task-exchange';
  version: 1;
  exportedAt: string;
  session: { id: string; name: string; kind?: string; projectDir?: string };
  task: {
    id: string;
    title: string;
    /** The operator's message, exactly as written. */
    message: string;
    status: string;
    reason?: string;
    summary?: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    /** What the operator added while it worked, and when it reached the chat. */
    notes: Array<{ text: string; at: string; sentAt?: string }>;
    changedFiles: string[];
  };
  attempts: ExchangeAttempt[];
};

async function createdAt(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(() => null);
  if (!info) return undefined;
  return new Date(info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs).toISOString();
}

const names = async (dir: string): Promise<string[]> =>
  (await readdir(dir).catch(() => [] as string[])).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const text = async (path: string): Promise<string | null> => await readFile(path, 'utf8').catch(() => null);

async function eventsOf(dir: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of ((await text(join(dir, 'transcript.jsonl'))) ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* a line cut off by a crash */
    }
  }
  return out;
}

/**
 * A step's or a check's log: `# step <id> shell=<s> exe=<path> cwd=<dir>`, `# <command>`, the output, and the footer
 * `# outcome=<o> exit=<n> durationMs=<ms>`. With the command as proposed, the lines of a command of several lines
 * are taken off the front of the output, where the log put them.
 */
export function readStepLog(log: string, proposed?: string): Omit<ExchangeCommand, 'kind' | 'iteration' | 'step' | 'at'> {
  const lines = log.replace(/\r\n/g, '\n').split('\n');
  const head = /^# step \S+ shell=(\S+) exe=.*? cwd=(.*)$/.exec(lines[0] ?? '');
  let command = (lines[1] ?? '').replace(/^# /, '');
  let body = lines.slice(2);
  const more = proposed?.replace(/\r\n/g, '\n').split('\n') ?? [];
  if (more.length > 1 && more[0] === command && more.slice(1).every((l, i) => body[i] === l)) {
    command = more.join('\n');
    body = body.slice(more.length - 1);
  }
  const footerAt = body.map((l) => /^# outcome=(\S+) exit=(-?\d+) durationMs=(\d+)/.test(l)).lastIndexOf(true);
  const footer = footerAt >= 0 ? /^# outcome=(\S+) exit=(-?\d+) durationMs=(\d+)/.exec(body[footerAt]!) : null;
  if (footerAt >= 0) body = body.slice(0, footerAt);
  return {
    ...(head ? { shell: head[1], cwd: head[2]!.trim() } : {}),
    command,
    output: body.join('\n').replace(/^\n+|\n+$/g, ''),
    ...(footer ? { outcome: footer[1], exitCode: Number(footer[2]), durationMs: Number(footer[3]) } : {}),
  };
}

/** The commands the transcript recorded as proposed, by step number, in order: `[shell] command` taken apart. */
function proposals(events: Array<Record<string, unknown>>): Array<{ at?: string; step: number; shell?: string; command: string }> {
  return events
    .filter((e) => e.type === 'step-proposed' && typeof e.description === 'string')
    .map((e) => {
      const m = /^\[([^\]]+)\] ([\s\S]*)$/.exec(e.description as string);
      return { at: e.at as string | undefined, step: Number(e.id), ...(m ? { shell: m[1], command: m[2]! } : { command: e.description as string }) };
    });
}

/** The commands of a folder of step logs, each with the command as proposed when the transcript has it. */
async function commandsIn(dir: string, proposed: ReturnType<typeof proposals>): Promise<ExchangeCommand[]> {
  const out: ExchangeCommand[] = [];
  for (const name of await names(dir)) {
    const m = /^(\d+)-(\d+)\.log$/.exec(name);
    if (!m) continue;
    const at = await createdAt(join(dir, name));
    const step = Number(m[2]);
    // The latest proposal of this step number before its log was opened: step numbers start again each round.
    const before = proposed.filter((p) => p.step === step && (!at || !p.at || p.at <= at)).at(-1);
    out.push({ kind: 'command', at, iteration: Number(m[1]), step, ...readStepLog((await text(join(dir, name))) ?? '', before?.command) });
  }
  return out;
}

/** The steps that were not run, from the transcript: refused by the runner or the operator, or skipped after one was. */
function notRun(events: Array<Record<string, unknown>>, proposed: ReturnType<typeof proposals>): ExchangeEntry[] {
  return events
    .filter((e) => e.type === 'step-skipped')
    .map((e) => {
      const step = Number(e.id);
      const at = e.at as string | undefined;
      const before = proposed.filter((p) => p.step === step && (!at || !p.at || p.at <= at)).at(-1);
      return { kind: 'not-run' as const, at, step, ...(before ? { command: before.command } : {}), reason: String(e.reason ?? ''), ...(e.by ? { by: String(e.by) } : {}) };
    });
}

async function checksIn(dir: string, under = ''): Promise<ExchangeEntry[]> {
  const out: ExchangeEntry[] = [];
  for (const name of await names(dir)) {
    const path = join(dir, name);
    if ((await stat(path).catch(() => null))?.isDirectory()) {
      out.push(...(await checksIn(path, `${under}${name}/`)));
      continue;
    }
    if (!name.endsWith('.txt') && !name.endsWith('.log')) continue;
    out.push({ kind: 'check', at: await createdAt(path), file: `${under}${name}`, ...readStepLog((await text(path)) ?? '') });
  }
  return out;
}

const byTime = (a: { at?: string }, b: { at?: string }): number => (a.at ?? '').localeCompare(b.at ?? '');

/** A review round's own conversation: the brief and the results it was sent, its replies, the commands it ran. */
async function reviewRound(dir: string, round: number): Promise<ExchangeEntry> {
  const entries: ExchangeEntry[] = [];
  let n = 0;
  for (const name of await names(dir)) {
    const path = join(dir, name);
    if (name === '00-brief.md' || /^iteration-\d+\.txt$/.test(name) || name === 'findings-sent.md') {
      n += 1;
      entries.push({ kind: 'sent', at: await createdAt(path), n, text: (await text(path)) ?? '', attachments: [] });
    } else if (name === '00-opening.md' || /^\d+-review\.md$/.test(name)) {
      entries.push({ kind: 'reply', at: await createdAt(path), n: entries.filter((e) => e.kind === 'reply').length + 1, label: name.replace(/\.md$/, ''), text: (await text(path)) ?? '' });
    }
  }
  entries.push(...(await commandsIn(join(dir, 'steps'), [])));
  entries.sort(byTime);
  return { kind: 'review', at: entries[0]?.at, round, entries };
}

/** One attempt, from its run folder. */
export async function readAttempt(runsDir: string, runId: string): Promise<Omit<ExchangeAttempt, 'attempt' | 'status' | 'startedAt' | 'finishedAt' | 'summary' | 'reason'>> {
  const dir = join(runsDir, runId);
  const events = await eventsOf(dir);
  const proposed = proposals(events);
  const entries: ExchangeEntry[] = [];

  // The files each message carried, by the number the transcript gives the message.
  const attachedTo = new Map<number, string[]>();
  for (const e of events) {
    if (e.type === 'message-sent' && typeof e.n === 'number' && Array.isArray(e.attachments)) attachedTo.set(e.n, e.attachments.map(String));
  }
  for (const name of await names(join(dir, 'messages'))) {
    const m = /^(\d+)\.md$/.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    const attachments: Array<{ name: string; text: string | null }> = [];
    for (const file of attachedTo.get(n) ?? []) {
      attachments.push({ name: file, text: (await text(join(dir, 'reports', file))) ?? (await text(join(dir, file))) });
    }
    entries.push({ kind: 'sent', at: await createdAt(join(dir, 'messages', name)), n, text: (await text(join(dir, 'messages', name))) ?? '', attachments });
  }
  let replies = 0;
  for (const name of await names(join(dir, 'replies'))) {
    const m = /^(\d+)-(.+)\.md$/.exec(name);
    if (!m) continue;
    replies += 1;
    entries.push({ kind: 'reply', at: await createdAt(join(dir, 'replies', name)), n: Number(m[1]), label: m[2]!, text: (await text(join(dir, 'replies', name))) ?? '' });
  }
  const commands = await commandsIn(join(dir, 'steps'), proposed);
  entries.push(...commands, ...notRun(events, proposed), ...(await checksIn(join(dir, 'checks'))));
  for (const name of await names(join(dir, 'review'))) {
    if (/^\d+$/.test(name)) entries.push(await reviewRound(join(dir, 'review', name), Number(name)));
  }
  entries.sort(byTime);

  const pointer = JSON.parse((await text(join(dir, 'chat.json'))) ?? 'null') as { chatId?: string; name?: string; url?: string } | null;
  return {
    runId,
    conversation: pointer?.chatId ? { chatId: pointer.chatId, ...(pointer.name ? { name: pointer.name } : {}), ...(pointer.url ? { url: pointer.url } : {}) } : null,
    counts: {
      sent: entries.filter((e) => e.kind === 'sent').length,
      replies,
      commands: commands.length,
      failed: commands.filter((c) => c.outcome !== undefined && (c.outcome !== 'completed' || c.exitCode !== 0)).length,
      notRun: entries.filter((e) => e.kind === 'not-run').length,
      checks: entries.filter((e) => e.kind === 'check').length,
    },
    entries,
    events,
  };
}

/** Every attempt of the task, oldest first, each read from its own run folder. */
export async function buildTaskExchange(runsDir: string, session: Session, task: Task, now = new Date()): Promise<TaskExchange> {
  const attempts: ExchangeAttempt[] = [];
  const earlier = task.attempts ?? [];
  for (const [i, a] of earlier.entries()) {
    if (!a.runId) continue;
    attempts.push({ attempt: i + 1, status: a.status, startedAt: a.startedAt, finishedAt: a.finishedAt, summary: a.summary, reason: a.reason, ...(await readAttempt(runsDir, a.runId)) });
  }
  if (task.runId && !earlier.some((a) => a.runId === task.runId)) {
    attempts.push({ attempt: task.attempt ?? earlier.length + 1, status: task.status, startedAt: task.startedAt, finishedAt: task.finishedAt, summary: task.summary, reason: task.reason, ...(await readAttempt(runsDir, task.runId)) });
  }
  return {
    format: 'copilot-operator.task-exchange',
    version: 1,
    exportedAt: now.toISOString(),
    session: { id: session.id, name: session.name, ...(session.kind ? { kind: session.kind } : {}), ...(session.projectDir ? { projectDir: session.projectDir } : {}) },
    task: {
      id: task.id,
      title: task.title,
      message: task.prompt,
      status: task.status,
      ...(task.reason ? { reason: task.reason } : {}),
      ...(task.summary ? { summary: task.summary } : {}),
      createdAt: task.createdAt,
      ...(task.startedAt ? { startedAt: task.startedAt } : {}),
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      notes: (task.notes ?? []).map((x) => ({ text: x.text, at: x.at, ...(x.sentAt ? { sentAt: x.sentAt } : {}) })),
      changedFiles: (task.vcs?.files ?? []).map((f) => f.path),
    },
    attempts,
  };
}
