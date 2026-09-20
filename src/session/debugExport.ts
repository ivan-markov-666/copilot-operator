/**
 * Everything that happened across a set of sessions, as one JSON document.
 *
 * The audience is somebody who was not there and has to work out why a run went the way it
 * did — very often that means handing it to another model, which is why this is JSON rather
 * than the prose export next door. `exportRecord.ts` answers "what was asked and what came
 * back" for a person to read; this answers "what actually ran, in what order, with what exit
 * codes, and what did the repository end up with" for someone to analyse.
 *
 * It is assembled from two places. The sessions carry the durable record — the text, the
 * outcome, the checks, what version control did. The run folders carry the sequence: every
 * step the model proposed, whether it ran, and what it exited with. Neither alone is enough to
 * explain a failure, and a run folder that has been cleaned away is not an error here: the
 * task still appears, with its own record and an empty step list.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session, Task } from './model.js';

/** One thing the runner executed, as the transcript recorded it. */
export type DebugStep = {
  id: number;
  description?: string;
  outcome?: string;
  exitCode?: number;
  durationMs?: number;
};

/** One round trip with the chat. */
export type DebugIteration = {
  iteration: number;
  status: string;
  steps: number;
  notes?: string;
};

export type DebugTask = {
  id: string;
  title: string;
  status: string;
  attempt: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  iterations: number;
  runId?: string;
  /** Exactly what was sent, so a wrong answer can be read against the question that caused it. */
  prompt: string;
  level2: string;
  summary?: string;
  reason?: string;
  /** What the model declared it could not do as written. A decision worth reading against the diff. */
  deviations?: Task['deviations'];
  /** Review findings the model disputed. */
  disputes?: Task['disputes'];
  /** Checks reviewers gave with their findings, with their state. */
  reviewChecks?: Task['reviewChecks'];
  /** The machine's tools when the task ran. Read this first when two runs differ. */
  environment?: Task['environment'];
  vcsPlan?: Task['vcsPlan'];
  vcs?: Task['vcs'];
  checks?: Task['checks'];
  checkResults?: Task['checkResults'];
  steps: DebugStep[];
  chatRounds: DebugIteration[];
  /** Anything the transcript logged as an error or a retry, in order. */
  problems: string[];
  earlierAttempts: Array<{
    status: string;
    iterations: number;
    runId?: string;
    reason?: string;
    summary?: string;
    deviations?: Task['deviations'];
    disputes?: Task['disputes'];
    checkResults?: Task['checkResults'];
    vcs?: Task['vcs'];
  }>;
};

export type DebugSession = {
  id: string;
  name: string;
  createdAt: string;
  status: string;
  model?: string;
  modelInUse?: string;
  onFailure?: string;
  chat?: { name: string; url: string };
  vcs?: Session['vcs'];
  vcsBaseCommit?: string;
  mirror: Session['mirror'];
  tasks: DebugTask[];
};

export type DebugExport = {
  exportedAt: string;
  /** What the report is about, so a file that has been emailed around still says so. */
  about: string;
  machine: { node: string; platform: string; cwd: string; runsDir: string };
  totals: { sessions: number; tasks: number; done: number; failed: number; queued: number };
  sessions: DebugSession[];
};

/** How long a command line travels into the report. Enough to recognise, not enough to drown. */
const MAX_COMMAND_CHARS = 600;

function clip(text: string, max = MAX_COMMAND_CHARS): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}… (${t.length - max} more characters)` : t;
}

/**
 * The sequence of what ran, read back out of the transcript.
 *
 * A step appears twice in the transcript — proposed, then finished — so the two are joined on
 * the step id. A step that was proposed and never finished is left with no outcome, which is
 * itself the answer when a run was stopped or the process died in the middle of one.
 */
async function readTranscript(runsDir: string, runId: string): Promise<{
  steps: DebugStep[];
  chatRounds: DebugIteration[];
  problems: string[];
}> {
  const empty = { steps: [], chatRounds: [], problems: [] };
  const raw = await readFile(join(runsDir, runId, 'transcript.jsonl'), 'utf8').catch(() => null);
  if (raw === null) return empty;

  const byId = new Map<number, DebugStep>();
  const chatRounds: DebugIteration[] = [];
  const problems: string[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = String(event.type ?? '');
    if (type === 'step-proposed') {
      const id = Number(event.id);
      byId.set(id, { ...(byId.get(id) ?? { id }), id, description: clip(String(event.description ?? '')) });
    } else if (type === 'step-finished') {
      const id = Number(event.id);
      byId.set(id, {
        ...(byId.get(id) ?? { id }),
        id,
        outcome: String(event.outcome ?? ''),
        exitCode: typeof event.exitCode === 'number' ? event.exitCode : undefined,
        durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined,
      });
    } else if (type === 'reply-parsed') {
      chatRounds.push({
        iteration: Number(event.iteration) || chatRounds.length + 1,
        status: String(event.status ?? ''),
        steps: Number(event.steps) || 0,
        notes: event.notes ? clip(String(event.notes), 300) : undefined,
      });
    } else if (type === 'task-error' || type === 'report-send-failed' || type === 'format-error' || type === 'vcs-problem') {
      problems.push(`${type}: ${clip(String(event.error ?? event.message ?? event.detail ?? ''), 400)}`);
    }
  }

  return { steps: [...byId.values()].sort((a, b) => a.id - b.id), chatRounds, problems };
}

async function taskOf(task: Task, runsDir: string): Promise<DebugTask> {
  const transcript = task.runId ? await readTranscript(runsDir, task.runId) : { steps: [], chatRounds: [], problems: [] };
  const started = task.startedAt ? Date.parse(task.startedAt) : undefined;
  const finished = task.finishedAt ? Date.parse(task.finishedAt) : undefined;

  return {
    id: task.id,
    title: task.title,
    status: task.status,
    attempt: task.attempt ?? 1,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    durationMs: started && finished ? finished - started : undefined,
    iterations: task.iterations,
    runId: task.runId,
    prompt: task.prompt,
    level2: task.level2,
    summary: task.summary,
    reason: task.reason,
    deviations: task.deviations,
    disputes: task.disputes,
    reviewChecks: task.reviewChecks,
    environment: task.environment,
    vcsPlan: task.vcsPlan,
    vcs: task.vcs,
    checks: task.checks,
    checkResults: task.checkResults,
    steps: transcript.steps,
    chatRounds: transcript.chatRounds,
    problems: transcript.problems,
    earlierAttempts: (task.attempts ?? []).map((a) => ({
      status: a.status,
      iterations: a.iterations,
      runId: a.runId,
      reason: a.reason,
      summary: a.summary,
      deviations: a.deviations,
      disputes: a.disputes,
      checkResults: a.checkResults,
      vcs: a.vcs,
    })),
  };
}

/** The whole thing, plus a file name that says what it is without being opened. */
export async function buildDebugExport(input: {
  sessions: Session[];
  runsDir: string;
  cwd: string;
}): Promise<{ fileName: string; content: string; totals: DebugExport['totals'] }> {
  const sessions: DebugSession[] = [];
  const totals = { sessions: input.sessions.length, tasks: 0, done: 0, failed: 0, queued: 0 };

  for (const session of input.sessions) {
    const tasks: DebugTask[] = [];
    for (const task of session.tasks) {
      totals.tasks += 1;
      if (task.status === 'done') totals.done += 1;
      else if (task.status === 'queued') totals.queued += 1;
      else totals.failed += 1;
      tasks.push(await taskOf(task, input.runsDir));
    }

    sessions.push({
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      status: session.status,
      model: session.model,
      modelInUse: session.modelInUse,
      onFailure: session.onFailure,
      chat: session.chat ? { name: session.chat.name, url: session.chat.url } : undefined,
      vcs: session.vcs,
      vcsBaseCommit: session.vcsBaseCommit,
      mirror: session.mirror,
      tasks,
    });
  }

  const report: DebugExport = {
    exportedAt: new Date().toISOString(),
    about:
      'copilot-operator: what ran and what happened, across the selected sessions. Everything here is ' +
      'either the session record on disk or the run transcript; nothing is inferred.',
    machine: { node: process.versions.node, platform: process.platform, cwd: input.cwd, runsDir: input.runsDir },
    totals,
    sessions,
  };

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '').replace(/-/g, '');
  const name =
    input.sessions.length === 1
      ? (input.sessions[0].name.replace(/[^\p{L}\p{N}._ -]/gu, '').trim().replace(/\s+/g, '-') || 'session')
      : `${input.sessions.length}-sessions`;

  return { fileName: `copilot-operator-debug-${name}-${stamp}.json`, content: JSON.stringify(report, null, 2), totals };
}
