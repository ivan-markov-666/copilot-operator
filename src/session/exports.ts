/**
 * Three JSON views of the same work, for handing to whoever — or whatever — has to reason
 * about it next. Each answers one question and nothing else, because a file that answers all
 * three is the debug export next door, and the person debugging one task does not want to
 * scroll past the machine's PATH to find the prompt.
 *
 *   plan    What was asked. The sessions and tasks in the plan format, as they are *now*: a
 *           plan written by a chat model and then edited in the UI comes back out with the
 *           edits, and a queue built by hand comes out as a plan that never existed as a file.
 *           It re-imports.
 *   domain  What happened to the work. The task as it was given, what the chat tried, what
 *           was actually done to the repository, and why it did not end done — in the words
 *           of the task, not of the runner.
 *   bot     What the runner did. The environment, every transcript event, every step with its
 *           exit code and duration, the transport's retries, what was reaped, what the review
 *           machinery went through. Nothing about the domain that is not needed to read it.
 *
 * All three exist for one task and for one run, because those are the two sizes a question
 * comes in: "why did this one fail" and "what did this whole run do".
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session, Task, TaskCheck } from './model.js';

export type ExportKind = 'plan' | 'domain' | 'bot';

/** Which tasks of which sessions, and what to call the file. */
export type ExportScope = {
  sessions: Session[];
  /** Absent means every task of every session in scope. */
  taskFilter?: (session: Session, task: Task) => boolean;
  /** Goes into the file name and the document's own `about`. */
  label: string;
};

const EXPECTED_HEADER = '### Expected result';
const GOAL_HEADER = '## Goal of this session';
const MAX_STRING_CHARS = 2000;

function clip(text: string, max = MAX_STRING_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
}

function tasksOf(scope: ExportScope): Array<{ session: Session; task: Task }> {
  const out: Array<{ session: Session; task: Task }> = [];
  for (const session of scope.sessions) {
    for (const task of session.tasks) {
      if (!scope.taskFilter || scope.taskFilter(session, task)) out.push({ session, task });
    }
  }
  return out;
}

function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '').replace(/-/g, '');
}

function fileLabel(label: string): string {
  return label.replace(/[^\p{L}\p{N}._ -]/gu, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'export';
}

export function exportFileName(kind: ExportKind, label: string): string {
  return `copilot-operator-${kind}-${fileLabel(label)}-${stamp()}.json`;
}

// ------------------------------------------------------------------------------------------
// plan: what was asked, in the format that goes back in
// ------------------------------------------------------------------------------------------

/** The prompt as stored is the plan's prompt with `expected` appended under a heading. */
function splitPrompt(prompt: string): { prompt: string; expected: string } {
  const i = prompt.indexOf(`\n\n${EXPECTED_HEADER}\n\n`);
  if (i < 0) return { prompt, expected: '' };
  return { prompt: prompt.slice(0, i).trim(), expected: prompt.slice(i + EXPECTED_HEADER.length + 4).trim() };
}

/** The session's level 2 is the plan's level 2 with the goal on top under a heading. */
function splitLevel2(level2: string): { goal: string; level2: string } {
  const text = level2.trim();
  if (!text.startsWith(GOAL_HEADER)) return { goal: '', level2: text };
  const body = text.slice(GOAL_HEADER.length).trim();
  const gap = body.indexOf('\n\n');
  if (gap < 0) return { goal: body, level2: '' };
  return { goal: body.slice(0, gap).trim(), level2: body.slice(gap).trim() };
}

/** The level 2 most of a session's tasks carry, which is the one the plan gave the session. */
function commonLevel2(tasks: Task[]): string {
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.level2.trim(), (counts.get(t.level2.trim()) ?? 0) + 1);
  let best = '';
  let n = 0;
  for (const [text, count] of counts) {
    if (count > n) {
      best = text;
      n = count;
    }
  }
  return best;
}

function planCheck(c: TaskCheck): Record<string, unknown> {
  const out: Record<string, unknown> = { name: c.name, expect: c.expect };
  if (c.run) out.run = c.run;
  if (c.shell) out.shell = c.shell;
  if (c.cwd) out.cwd = c.cwd;
  if (c.file) out.file = c.file;
  if (c.value !== undefined && c.value !== '') out.value = c.value;
  return out;
}

export function buildPlanExport(scope: ExportScope): Record<string, unknown> {
  const sessions = scope.sessions.filter((s) => s.tasks.some((t) => !scope.taskFilter || scope.taskFilter(s, t)));
  const groups = new Set(sessions.map((s) => (s.conversationGroup ?? '').trim()));
  const shared = sessions.length > 1 && groups.size === 1 && !groups.has('');
  const runFailure = sessions.find((s) => s.runGroup?.onFailure)?.runGroup?.onFailure ?? 'stop';

  return {
    version: 1,
    plan: scope.label,
    notes:
      `Exported from copilot-operator on ${new Date().toISOString()}: the sessions and tasks as they are now, ` +
      'including anything edited in the UI after the original plan (if there was one) was imported. ' +
      'Task outcomes are not part of this file; it is the plan, and it can be imported again.',
    onFailure: runFailure,
    conversation: shared ? 'shared' : 'per-session',
    sessions: sessions.map((s) => {
      const tasks = s.tasks.filter((t) => !scope.taskFilter || scope.taskFilter(s, t));
      const level2 = commonLevel2(tasks);
      const split = splitLevel2(level2);
      const session: Record<string, unknown> = {
        name: s.name,
        goal: split.goal,
        model: s.model ?? '',
        onFailure: s.onFailure ?? 'stop',
        level2: split.level2,
        conversationGroup: shared ? '' : (s.conversationGroup ?? ''),
        vcs: {
          enabled: s.vcs?.enabled ?? false,
          repoDir: s.vcs?.repoDir ?? '',
          branchMode: s.vcs?.branchMode ?? 'per-task',
          commitOnFinish: s.vcs?.commitOnFinish ?? true,
          branchPrefix: s.vcs?.branchPrefix ?? 'cop/',
          branchName: (s.vcs as { branchName?: string } | undefined)?.branchName ?? '',
        },
        review: { enabled: s.review?.enabled !== false, model: s.review?.model ?? '' },
        mirror: {
          enabled: s.mirror.enabled,
          rootDir: s.mirror.rootDir,
          includeDirs: s.mirror.includeDirs,
          excludeDirs: s.mirror.excludeDirs,
          respectGitignore: s.mirror.respectGitignore ?? true,
          includeEnvFiles: s.mirror.includeEnvFiles ?? false,
        },
        tasks: tasks.map((t) => {
          const p = splitPrompt(t.prompt);
          const task: Record<string, unknown> = { title: t.title, prompt: p.prompt, expected: p.expected };
          if (t.level2.trim() !== level2) task.level2 = t.level2.trim();
          if (t.vcsPlan?.branch || t.vcsPlan?.commitMessage) {
            task.vcs = { ...(t.vcsPlan.branch ? { branch: t.vcsPlan.branch } : {}), ...(t.vcsPlan.commitMessage ? { commitMessage: t.vcsPlan.commitMessage } : {}) };
          }
          if (t.checks && t.checks.length > 0) task.checks = t.checks.map(planCheck);
          if (t.reviewEnabled === false) task.review = false;
          if (t.readOnly) task.readOnly = true;
          return task;
        }),
      };
      return session;
    }),
  };
}

// ------------------------------------------------------------------------------------------
// the transcript, read once for both of the other two
// ------------------------------------------------------------------------------------------

type Event = Record<string, unknown> & { at?: string; type?: string; level?: string };

async function readEvents(runsDir: string, runId: string | undefined): Promise<Event[]> {
  if (!runId) return [];
  const raw = await readFile(join(runsDir, runId, 'transcript.jsonl'), 'utf8').catch(() => null);
  if (raw === null) return [];
  const out: Event[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Event);
    } catch {
      // A half-written last line when the process died is not a reason to lose the rest.
    }
  }
  return out;
}

/** Every string in an event cut to a readable length; the run folder keeps the full text. */
function trimmed(event: Event): Event {
  const out: Event = {};
  for (const [k, v] of Object.entries(event)) {
    out[k] = typeof v === 'string' ? clip(v, 600) : v;
  }
  return out;
}

type StepRecord = {
  id: number;
  iteration?: number;
  description?: string;
  outcome?: string;
  exitCode?: number;
  durationMs?: number;
  refused?: string;
};

/** Steps joined from proposed/started/finished/skipped, in the order they were proposed. */
function stepsOf(events: Event[]): StepRecord[] {
  const byKey = new Map<string, StepRecord>();
  let iteration = 0;
  for (const e of events) {
    if (e.type === 'reply-parsed') iteration = Number(e.iteration ?? iteration + 1);
    const id = typeof e.id === 'number' ? e.id : undefined;
    if (id === undefined) continue;
    const key = `${iteration}:${id}`;
    if (e.type === 'step-proposed') {
      byKey.set(key, { id, iteration, description: typeof e.description === 'string' ? clip(e.description, 600) : undefined });
    } else if (e.type === 'step-finished') {
      const s = byKey.get(key) ?? { id, iteration };
      byKey.set(key, { ...s, outcome: String(e.outcome ?? ''), exitCode: typeof e.exitCode === 'number' ? e.exitCode : undefined, durationMs: typeof e.durationMs === 'number' ? e.durationMs : undefined });
    } else if (e.type === 'step-skipped' || e.type === 'step-repeated' || e.type === 'step-damaged') {
      const s = byKey.get(key) ?? { id, iteration };
      byKey.set(key, { ...s, refused: String(e.reason ?? e.message ?? e.type) });
    }
  }
  return [...byKey.values()];
}

// ------------------------------------------------------------------------------------------
// domain: what happened to the work
// ------------------------------------------------------------------------------------------

/** What a closing `blocked` reply said it tried and needed, read back out of the reply. */
function blockedDetail(finalReply?: string): { tried?: string[]; needed?: string } | undefined {
  if (!finalReply) return undefined;
  const m = finalReply.match(/```json\s*([\s\S]*?)```/) ?? [null, finalReply];
  try {
    const j = JSON.parse((m[1] ?? '').trim()) as { tried?: unknown; needed?: unknown };
    const tried = Array.isArray(j.tried) ? j.tried.map(String) : undefined;
    const needed = typeof j.needed === 'string' ? j.needed : undefined;
    return tried || needed ? { tried, needed } : undefined;
  } catch {
    return undefined;
  }
}

async function domainTask(session: Session, task: Task, runsDir: string): Promise<Record<string, unknown>> {
  const events = await readEvents(runsDir, task.runId);
  const steps = stepsOf(events);
  const rounds = events
    .filter((e) => e.type === 'reply-parsed')
    .map((e) => ({
      iteration: e.iteration,
      status: e.status,
      notes: typeof e.notes === 'string' ? clip(e.notes, 1000) : undefined,
      steps: steps.filter((s) => s.iteration === e.iteration).map((s) => ({ id: s.id, ran: s.description, outcome: s.refused ? `refused: ${s.refused}` : s.outcome, exitCode: s.exitCode })),
    }));
  const p = splitPrompt(task.prompt);
  const failed = task.status !== 'done' && task.status !== 'queued' && task.status !== 'running' && task.status !== 'waiting-approval';
  const started = task.startedAt ? Date.parse(task.startedAt) : NaN;
  const finished = task.finishedAt ? Date.parse(task.finishedAt) : NaN;

  const out: Record<string, unknown> = {
    session: { id: session.id, name: session.name },
    task: {
      id: task.id,
      title: task.title,
      attempt: task.attempt ?? 1,
      readOnly: task.readOnly ?? false,
      prompt: p.prompt,
      expected: p.expected,
      level2: task.level2,
      checks: (task.checks ?? []).map(planCheck),
    },
    outcome: {
      status: task.status,
      reason: task.reason,
      summary: task.summary,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      durationMs: Number.isFinite(started) && Number.isFinite(finished) ? finished - started : undefined,
      iterations: task.iterations,
      checks: task.checkResults,
    },
    whatTheChatTried: rounds,
    whatWasActuallyDone: {
      repository: task.vcs,
      deviations: task.deviations,
      disputes: task.disputes,
      filesAttachedFirst: undefined,
    },
    review: task.review
      ? {
          verdict: task.review.verdict,
          rounds: task.review.rounds,
          stepsRun: task.review.stepsRun,
          model: task.review.model,
          summary: task.review.summary,
          findings: task.review.findings,
          problem: task.review.problem,
        }
      : undefined,
  };

  if (failed) {
    out.whyItFailed = {
      status: task.status,
      reason: task.reason,
      failingChecks: (task.checkResults ?? []).filter((c) => !c.passed),
      blocked: blockedDetail(task.finalReply),
      reviewFindings: task.review?.verdict === 'fail' ? task.review.findings : undefined,
      leftovers: task.leftovers,
      lastRound: rounds.at(-1),
    };
  }

  /*
   * The attempts before this one, each with its own transcript.
   *
   * After "fix the prompt and queue it again" the task on the record is queued and the failure
   * that prompted the fix lives only here — so an export taken then, which is exactly when
   * somebody wants to hand the failure to a model, has to carry what the earlier attempt tried
   * and why it ended, not just that it did.
   */
  if (task.attempts && task.attempts.length > 0) {
    const earlier = [];
    for (const [i, a] of task.attempts.entries()) {
      const aEvents = await readEvents(runsDir, a.runId);
      const aSteps = stepsOf(aEvents);
      const aRounds = aEvents
        .filter((e) => e.type === 'reply-parsed')
        .map((e) => ({
          iteration: e.iteration,
          status: e.status,
          notes: typeof e.notes === 'string' ? clip(e.notes, 1000) : undefined,
          steps: aSteps.filter((s) => s.iteration === e.iteration).map((s) => ({ id: s.id, ran: s.description, outcome: s.refused ? `refused: ${s.refused}` : s.outcome, exitCode: s.exitCode })),
        }));
      const aFailed = a.status !== 'done';
      earlier.push({
        attempt: i + 1,
        runId: a.runId,
        status: a.status,
        reason: a.reason,
        summary: a.summary,
        iterations: a.iterations,
        startedAt: a.startedAt,
        finishedAt: a.finishedAt,
        prompt: a.prompt !== task.prompt ? splitPrompt(a.prompt).prompt : undefined,
        whatTheChatTried: aRounds,
        whatWasActuallyDone: { repository: a.vcs, deviations: a.deviations, disputes: a.disputes },
        whyItFailed: aFailed
          ? { status: a.status, reason: a.reason, failingChecks: (a.checkResults ?? []).filter((c) => !c.passed), lastRound: aRounds.at(-1) }
          : undefined,
      });
    }
    out.earlierAttempts = earlier;
  }
  return out;
}

export async function buildDomainExport(scope: ExportScope, runsDir: string): Promise<Record<string, unknown>> {
  const pairs = tasksOf(scope);
  const tasks = [];
  for (const { session, task } of pairs) tasks.push(await domainTask(session, task, runsDir));
  const counts = { tasks: pairs.length, done: 0, failed: 0, open: 0 };
  for (const { task } of pairs) {
    if (task.status === 'done') counts.done += 1;
    else if (task.status === 'queued' || task.status === 'running' || task.status === 'waiting-approval') counts.open += 1;
    else counts.failed += 1;
  }
  return {
    exportedAt: new Date().toISOString(),
    about: `copilot-operator, the work: ${scope.label}. What each task asked, what the chat tried, what was done to the repository, and why a task did not end done. Nothing about the runner itself; that is the bot export.`,
    counts,
    tasks,
  };
}

// ------------------------------------------------------------------------------------------
// bot: what the runner did
// ------------------------------------------------------------------------------------------

const TRANSPORT_TYPES = new Set(['message-sent', 'format-error', 'report-written', 'report-redacted', 'report-send-failed', 'attachment-missing', 'chat-registered', 'download']);

async function botTask(session: Session, task: Task, runsDir: string): Promise<Record<string, unknown>> {
  const events = await readEvents(runsDir, task.runId);
  const steps = stepsOf(events);
  const byType = new Map<string, number>();
  for (const e of events) byType.set(String(e.type), (byType.get(String(e.type)) ?? 0) + 1);
  const problems = events.filter((e) => e.level === 'error' || e.level === 'warn').map(trimmed);
  const reviewEvents = events.filter((e) => String(e.type).startsWith('review-') || String(e.type).startsWith('finding-'));

  return {
    session: { id: session.id, name: session.name, model: session.model, modelInUse: session.modelInUse, reviewModel: session.review?.model },
    task: { id: task.id, title: task.title, attempt: task.attempt ?? 1, status: task.status, runId: task.runId, runFolder: task.runId ? join(runsDir, task.runId) : undefined, logFile: task.logFile },
    timing: { startedAt: task.startedAt, finishedAt: task.finishedAt, iterations: task.iterations },
    environment: task.environment,
    transport: {
      counts: Object.fromEntries([...byType.entries()].filter(([t]) => TRANSPORT_TYPES.has(t))),
      events: events.filter((e) => TRANSPORT_TYPES.has(String(e.type))).map(trimmed),
    },
    steps: steps.map((s) => ({ iteration: s.iteration, id: s.id, command: s.description, outcome: s.outcome, exitCode: s.exitCode, durationMs: s.durationMs, refused: s.refused })),
    checks: {
      results: task.checkResults,
      rounds: byType.get('checks-started') ?? 0,
      fromReviews: task.reviewChecks,
    },
    processes: { leftovers: task.leftovers, reaped: events.filter((e) => e.type === 'processes-reaped').map(trimmed) },
    mirror: events.filter((e) => String(e.type).startsWith('mirror')).map(trimmed),
    review: {
      verdict: task.review?.verdict,
      rounds: task.review?.rounds,
      stepsRun: task.review?.stepsRun,
      model: task.review?.model,
      problem: task.review?.problem,
      formatErrors: byType.get('review-format-error') ?? 0,
      events: reviewEvents.map(trimmed),
    },
    problems,
    eventCounts: Object.fromEntries(byType.entries()),
    events: events.map(trimmed),
    // Earlier attempts with their own run folders: the same technical record, per attempt,
    // because a task queued again after a failure has no transcript of its own yet.
    earlierAttempts: await Promise.all(
      (task.attempts ?? []).map(async (a, i) => {
        const aEvents = await readEvents(runsDir, a.runId);
        return {
          attempt: i + 1,
          runId: a.runId,
          runFolder: a.runId ? join(runsDir, a.runId) : undefined,
          status: a.status,
          steps: stepsOf(aEvents).map((s) => ({ iteration: s.iteration, id: s.id, command: s.description, outcome: s.outcome, exitCode: s.exitCode, durationMs: s.durationMs, refused: s.refused })),
          problems: aEvents.filter((e) => e.level === 'error' || e.level === 'warn').map(trimmed),
          events: aEvents.map(trimmed),
        };
      }),
    ),
  };
}

export async function buildBotExport(
  scope: ExportScope,
  runsDir: string,
  machine: { node: string; platform: string; cwd: string; limits: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const pairs = tasksOf(scope);
  const tasks = [];
  for (const { session, task } of pairs) tasks.push(await botTask(session, task, runsDir));
  return {
    exportedAt: new Date().toISOString(),
    about: `copilot-operator, the runner: ${scope.label}. The environment, every transcript event, every step with its exit code, the transport's retries, what was reaped, what the review machinery did. Read the domain export for what the task was about.`,
    machine,
    tasks,
  };
}
