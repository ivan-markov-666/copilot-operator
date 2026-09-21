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
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from './model.js';

export type StoryEntry =
  | { kind: 'sent'; iteration: number; label: string; text: string }
  | { kind: 'reply'; iteration: number; label: string; text: string; status?: string; notes?: string }
  | { kind: 'step'; iteration: number; id: number; command: string; output: string; outcome?: string; exitCode?: number; durationMs?: number; failed: boolean }
  | { kind: 'review'; round: number; entries: StoryEntry[] };

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

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (${text.length - MAX_TEXT} more characters in the run folder)` : text;
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
function parseStepLog(text: string): { command: string; output: string; outcome?: string; exitCode?: number; durationMs?: number } {
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
      kind: 'step',
      iteration,
      id: Number(m[2]),
      command: parsed.command,
      output: clip(parsed.output),
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
  if (names.includes('00-brief.md')) entries.push({ kind: 'sent', iteration: 0, label: 'brief', text: await read('00-brief.md') });
  const steps = await stepsIn(join(dir, 'steps'));
  const replies = names.filter((n) => /^\d+-review\.md$/.test(n)).sort();
  for (const [i, name] of replies.entries()) {
    const text = await read(name);
    const parsed = parseReply(text);
    entries.push({ kind: 'reply', iteration: i + 1, label: `review ${round}, reply ${i + 1}`, text, ...parsed });
    for (const step of steps.get(i + 1) ?? []) entries.push(step);
    if (names.includes(`iteration-${i + 1}.txt`)) entries.push({ kind: 'sent', iteration: i + 1, label: `results ${i + 1}`, text: await read(`iteration-${i + 1}.txt`) });
  }
  if (names.includes('findings-sent.md')) entries.push({ kind: 'sent', iteration: replies.length, label: 'findings sent to the implementer', text: await read('findings-sent.md') });
  return { kind: 'review', round, entries };
}

export async function buildStory(runsDir: string, runId: string, task: Task, live: boolean): Promise<Story> {
  const dir = join(runsDir, runId);
  const log = await readFile(join(dir, 'task-log.txt'), 'utf8').catch(() => '');
  const sections = sectionsOf(log);
  const entries: StoryEntry[] = [];

  const opening = sections.find((s) => s.name === 'OPENING MESSAGE');
  if (opening) entries.push({ kind: 'sent', iteration: 0, label: 'opening message', text: clip(opening.text) });

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
      if (reports.has(k)) entries.push({ kind: 'sent', iteration: k, label: `results ${k}`, text: clip(reports.get(k)!) });
      lastIteration = k;
    } else if (rv) {
      const round = Number(rv[1]);
      // The steps the last reply proposed ran before the review judged the work.
      for (const step of steps.get(lastIteration + 1) ?? []) entries.push(step);
      if (reports.has(lastIteration + 1)) entries.push({ kind: 'sent', iteration: lastIteration + 1, label: `results ${lastIteration + 1}`, text: clip(reports.get(lastIteration + 1)!) });
      lastIteration += reports.has(lastIteration + 1) ? 1 : 0;
      if (!placedReviews.has(round)) {
        entries.push(await reviewRound(join(dir, 'review', String(round)), round));
        placedReviews.add(round);
      }
    }
    entries.push({ kind: 'reply', iteration: it ? Number(it[1]) : 0, label, text, ...parsed });
  }
  // Steps and results after the last reply (a task that ended without another reply), and
  // review rounds nobody replied to yet (one still going, or the last one that passed).
  for (const [k, list] of [...steps.entries()].sort((a, b) => a[0] - b[0])) {
    if (k > lastIteration) {
      for (const step of list) entries.push(step);
      if (reports.has(k)) entries.push({ kind: 'sent', iteration: k, label: `results ${k}`, text: clip(reports.get(k)!) });
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
