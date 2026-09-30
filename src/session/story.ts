/**
 * The story of one task attempt: what was asked, what was said, what ran, how it ended —
 * assembled from the run folder for a person to read while it happens and afterwards.
 *
 * The run folder already has every piece: the task log holds what the runner sent (the
 * opening message, every results file, the review briefs and findings); `replies/` holds
 * what the chat answered, in order; `steps/` holds every command with its output and exit
 * code; `review/N/` holds the same for each review round. This puts them in the order they
 * happened, because a folder listing is not a story and the task log alone has no output
 * and no replies.
 *
 * Nothing here is inferred. An entry is a file, or a section of the task log, or a field of
 * the task record; the reader decides what it means.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from './model.js';

export type StoryEntry =
  | { kind: 'sent'; iteration: number; label: string; text: string; at?: string }
  | { kind: 'reply'; iteration: number; label: string; text: string; status?: string; notes?: string; at?: string }
  | { kind: 'step'; iteration: number; id: number; command: string; output: string; outcome?: string; exitCode?: number; durationMs?: number; failed: boolean; at?: string }
  | { kind: 'review'; round: number; entries: StoryEntry[]; at?: string };

export type Story = {
  runId: string;
  title: string;
  status: string;
  /** The task text, exactly as it was given to the chat. Always shown. */
  prompt: string;
  level2: string;
  entries: StoryEntry[];
  /** How it ended: the closing summary, or the reason it did not end done. Always shown. */
  close?: { status: string; summary?: string; reason?: string; checks?: Task['checkResults'] };
  /** Whether the attempt is still going, so the reader polls. */
  live: boolean;
};

const MAX_TEXT = 60_000;

/*
 * When each thing happened.
 *
 * Every entry of the story is a file the runner wrote at the moment it happened: a reply is saved
 * as it arrives, a step's log is opened as the step starts, a results file is written just before
 * it is sent. So a file's creation time is the entry's time, for runs recorded long before anyone
 * asked for times as much as for new ones — nothing had to be recorded differently. The modification
 * time is the fallback on a file system that keeps no creation time. The opening message has no file
 * of its own and takes its time from the transcript's first "message-sent".
 */
async function createdAt(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(() => null);
  if (!info) return undefined;
  const ms = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
  return new Date(ms).toISOString();
}

async function firstSentAt(dir: string): Promise<string | undefined> {
  const text = await readFile(join(dir, 'transcript.jsonl'), 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (!line.includes('"message-sent"')) continue;
    try {
      const e = JSON.parse(line) as { at?: string; type?: string };
      if (e.type === 'message-sent' && e.at) return e.at;
    } catch {
      /* a line cut off by a crash */
    }
  }
  return undefined;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (${text.length - MAX_TEXT} more characters in the run folder)` : text;
}

/**
 * A command's output keeps its end instead, the way a terminal does. What is at the end of a long
 * output — the test summary, the error that stopped it — is what anyone reads it for, and while a
 * step is still running the end is where the new lines arrive: a head-kept clip froze a live view
 * of a long test run at its first 60 000 characters, and nothing after that ever appeared.
 */
function clipTail(text: string): string {
  return text.length > MAX_TEXT ? `… (${text.length - MAX_TEXT} earlier characters in the run folder)\n${text.slice(-MAX_TEXT)}` : text;
}

/** The task log's sections: a name between two rules, then the text until the next rule. */
function sectionsOf(log: string): Array<{ name: string; text: string }> {
  const rule = /^=+\s*$/;
  const lines = log.split('\n');
  const out: Array<{ name: string; text: string }> = [];
  let i = 0;
  while (i < lines.length) {
    if (rule.test(lines[i]!) && i + 2 < lines.length && rule.test(lines[i + 2]!)) {
      const name = lines[i + 1]!.trim();
      i += 3;
      const body: string[] = [];
      while (i < lines.length && !(rule.test(lines[i]!) && i + 2 < lines.length && rule.test(lines[i + 2]!))) {
        body.push(lines[i]!);
        i += 1;
      }
      out.push({ name, text: body.join('\n').trim() });
    } else {
      i += 1;
    }
  }
  return out;
}

/** A step log: two header lines, the output, one footer line. */
export function parseStepLog(text: string): { command: string; output: string; outcome?: string; exitCode?: number; durationMs?: number } {
  const lines = text.split('\n');
  const command = lines[1]?.replace(/^# /, '') ?? '';
  const footer = lines.map((l) => l.match(/^# outcome=(\S+) exit=(-?\d+) durationMs=(\d+)/)).filter(Boolean).pop() as RegExpMatchArray | undefined;
  const body = lines.slice(2).filter((l) => !/^# outcome=/.test(l)).join('\n').trim();
  return {
    command,
    output: body,
    outcome: footer?.[1],
    exitCode: footer ? Number(footer[2]) : undefined,
    durationMs: footer ? Number(footer[3]) : undefined,
  };
}

async function stepsIn(dir: string): Promise<Map<number, StoryEntry[]>> {
  const byIteration = new Map<number, StoryEntry[]>();
  for (const name of (await readdir(dir).catch(() => [] as string[])).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const m = name.match(/^(\d+)-(\d+)\.log$/);
    if (!m) continue;
    const iteration = Number(m[1]);
    const parsed = parseStepLog(await readFile(join(dir, name), 'utf8').catch(() => ''));
    const entry: StoryEntry = {
      at: await createdAt(join(dir, name)),
      kind: 'step',
      iteration,
      id: Number(m[2]),
      command: parsed.command,
      output: clipTail(parsed.output),
      outcome: parsed.outcome,
      exitCode: parsed.exitCode,
      durationMs: parsed.durationMs,
      failed: parsed.outcome !== undefined && (parsed.outcome !== 'completed' || parsed.exitCode !== 0),
    };
    byIteration.set(iteration, [...(byIteration.get(iteration) ?? []), entry]);
  }
  return byIteration;
}

function parseReply(text: string): { status?: string; notes?: string } {
  const m = text.match(/```json\s*([\s\S]*?)```/) ?? [null, text];
  try {
    const j = JSON.parse((m[1] ?? '').trim()) as { status?: unknown; notes?: unknown };
    return { status: typeof j.status === 'string' ? j.status : undefined, notes: typeof j.notes === 'string' ? j.notes : undefined };
  } catch {
    return {};
  }
}

/** One review round's folder as a story of its own: brief, replies, steps, reports, findings. */
async function reviewRound(dir: string, round: number): Promise<StoryEntry> {
  const entries: StoryEntry[] = [];
  const read = async (name: string): Promise<string> => clip(await readFile(join(dir, name), 'utf8').catch(() => ''));
  const names = (await readdir(dir).catch(() => [] as string[])).sort();
  if (names.includes('00-brief.md')) entries.push({ kind: 'sent', iteration: 0, label: 'brief', text: await read('00-brief.md'), at: await createdAt(join(dir, '00-brief.md')) });
  const steps = await stepsIn(join(dir, 'steps'));
  /*
   * The replies, by what they answer. `00-opening.md` is the answer to the brief — the one that
   * proposes the first steps — and `NN-review.md` the answer to the results of iteration NN (the
   * review saves it after sending them). So after reply k come the steps of iteration k + 1 and
   * their results, then reply k + 1. The story used to read only the `NN-review` files and put each
   * before the steps it came after; the times on the entries are what showed it.
   */
  const replyFor = new Map<number, string>();
  if (names.includes('00-opening.md')) replyFor.set(0, '00-opening.md');
  for (const n of names) {
    const m = n.match(/^(\d+)-review\.md$/);
    if (m) replyFor.set(Number(m[1]), n);
  }
  const last = Math.max(0, ...replyFor.keys(), ...steps.keys());
  for (let k = 0; k <= last; k += 1) {
    const name = replyFor.get(k);
    if (name) {
      const text = await read(name);
      entries.push({ kind: 'reply', iteration: k, label: `review ${round}, reply ${k + 1}`, text, ...parseReply(text), at: await createdAt(join(dir, name)) });
    }
    for (const step of steps.get(k + 1) ?? []) entries.push(step);
    if (names.includes(`iteration-${k + 1}.txt`)) {
      entries.push({ kind: 'sent', iteration: k + 1, label: `results ${k + 1}`, text: await read(`iteration-${k + 1}.txt`), at: await createdAt(join(dir, `iteration-${k + 1}.txt`)) });
    }
  }
  const replies = [...replyFor.values()];
  if (names.includes('findings-sent.md')) {
    entries.push({ kind: 'sent', iteration: replies.length, label: 'findings sent to the implementer', text: await read('findings-sent.md'), at: await createdAt(join(dir, 'findings-sent.md')) });
  }
  return { kind: 'review', round, entries, at: entries.find((e) => e.at)?.at };
}

export async function buildStory(runsDir: string, runId: string, task: Task, live: boolean): Promise<Story> {
  const dir = join(runsDir, runId);
  const log = await readFile(join(dir, 'task-log.txt'), 'utf8').catch(() => '');
  const sections = sectionsOf(log);
  const entries: StoryEntry[] = [];

  const opening = sections.find((s) => s.name === 'OPENING MESSAGE');
  if (opening) entries.push({ kind: 'sent', iteration: 0, label: 'opening message', text: clip(opening.text), at: (await firstSentAt(dir)) ?? task.startedAt });
  /** The results file of iteration k, as the report writer names it by default; its creation is when it was sent. */
  const resultsAt = async (k: number): Promise<string | undefined> => await createdAt(join(dir, 'reports', `iteration-${k}.txt`));

  const steps = await stepsIn(join(dir, 'steps'));
  const reports = new Map<number, string>();
  for (const s of sections) {
    const m = s.name.match(/^ITERATION (\d+)$/);
    if (m) reports.set(Number(m[1]), s.text);
  }
  const reviewsSent = new Map<number, Array<{ name: string; text: string }>>();
  for (const s of sections) {
    const m = s.name.match(/^REVIEW (\d+) /);
    if (m) reviewsSent.set(Number(m[1]), [...(reviewsSent.get(Number(m[1])) ?? []), s]);
  }

  /*
   * The replies are the spine: they are numbered in the order they arrived. What ran and what
   * was sent back sit between them — the steps a reply proposed, then the results file that
   * answered them, then the next reply. A reply to a review's findings is preceded by that
   * review round in full.
   */
  const replyNames = (await readdir(join(dir, 'replies')).catch(() => [] as string[])).filter((n) => n.endsWith('.md')).sort();
  const reviewDirs = (await readdir(join(dir, 'review')).catch(() => [] as string[])).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
  const placedReviews = new Set<number>();
  let lastIteration = 0;
  for (const name of replyNames) {
    const text = clip(await readFile(join(dir, 'replies', name), 'utf8').catch(() => ''));
    const parsed = parseReply(text);
    const label = name.replace(/^\d+-/, '').replace(/\.md$/, '');
    const it = label.match(/iteration-(\d+)/);
    const rv = label.match(/review-(\d+)/);
    if (it) {
      const k = Number(it[1]);
      for (const step of steps.get(k) ?? []) entries.push(step);
      if (reports.has(k)) entries.push({ kind: 'sent', iteration: k, label: `results ${k}`, text: clip(reports.get(k)!), at: await resultsAt(k) });
      lastIteration = k;
    } else if (rv) {
      const round = Number(rv[1]);
      // The steps the last reply proposed ran before the review judged the work.
      for (const step of steps.get(lastIteration + 1) ?? []) entries.push(step);
      if (reports.has(lastIteration + 1)) entries.push({ kind: 'sent', iteration: lastIteration + 1, label: `results ${lastIteration + 1}`, text: clip(reports.get(lastIteration + 1)!), at: await resultsAt(lastIteration + 1) });
      lastIteration += reports.has(lastIteration + 1) ? 1 : 0;
      if (!placedReviews.has(round)) {
        entries.push(await reviewRound(join(dir, 'review', String(round)), round));
        placedReviews.add(round);
      }
    }
    entries.push({ kind: 'reply', iteration: it ? Number(it[1]) : 0, label, text, ...parsed, at: await createdAt(join(dir, 'replies', name)) });
  }
  // Steps and results after the last reply (a task that ended without another reply), and
  // review rounds nobody replied to yet (one still going, or the last one that passed).
  for (const [k, list] of [...steps.entries()].sort((a, b) => a[0] - b[0])) {
    if (k > lastIteration) {
      for (const step of list) entries.push(step);
      if (reports.has(k)) entries.push({ kind: 'sent', iteration: k, label: `results ${k}`, text: clip(reports.get(k)!), at: await resultsAt(k) });
    }
  }
  for (const round of reviewDirs) {
    if (!placedReviews.has(round)) entries.push(await reviewRound(join(dir, 'review', String(round)), round));
  }

  const ended = task.status !== 'queued' && task.status !== 'running' && task.status !== 'waiting-approval';
  return {
    runId,
    title: task.title,
    status: task.status,
    prompt: task.prompt,
    level2: task.level2,
    entries,
    close: ended ? { status: task.status, summary: task.summary, reason: task.reason, checks: task.checkResults } : undefined,
    live,
  };
}
