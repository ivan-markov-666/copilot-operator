/**
 * Runs one task inside a session, and a whole session's queue of tasks in turn.
 *
 * A session is one Copilot conversation. The first task opens it: level 1 goes out on its own
 * and is acknowledged, then level 2 plus the task. Later tasks reuse the conversation with a
 * short reminder that the contract still applies. Every task ends with Copilot's `summary`,
 * which is the deliverable the UI shows.
 *
 * Nothing here knows whether it was started from the terminal or from the web: the
 * authorizer decides who approves steps, the sink decides where events go, and the store
 * persists the task as it moves.
 */
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResolvedConfig } from '../config/schema.js';
import { CopilotTransport, type ReplyCapture } from '../transport/copilotTransport.js';
import { buildChatName, savePointer, type ChatPointer } from '../transport/chatSession.js';
import { parseReply, formatErrorMessage, findLikelyDamage, damageGuidance } from '../protocol/parser.js';
import { isDownloadStep, resolveDeviations, describeDeviations, mergeDisputes, describeDisputes, type Step, type Deviation, type Dispute } from '../protocol/replySchema.js';
import { buildCoveringMessage, assertSendable } from '../protocol/reporter.js';
import { runStep, type RunResult } from '../exec/runner.js';
import { runChecks, failureMessage, failureReport, COMMIT_CLEAN_CHECK, type CheckOutcome } from '../exec/checks.js';
import { activeChecks, suspendDisputed, settleAfterReview, onlyDerivedFailing } from './derivedChecks.js';
import { workingDirFor, isWorkingDirProblem, workingDirNote } from '../exec/workDir.js';
import { redactSecrets } from '../exec/redaction.js';
import { snapshotProcesses, reapLeftovers, describeLeftovers, type ProcessSnapshot } from '../exec/processes.js';
import { collectEnvironment, describeEnvironment } from '../exec/environment.js';
import { describeCrash } from '../transport/edgeCrash.js';
import { runReview, findingsMessage, type ReviewOutcome } from './review.js';
import { allAboutTheTask, isRepeat, findingId, type ReviewFinding } from '../protocol/reviewSchema.js';
import { repoState, workingTreePaths } from '../vcs/git.js';
import { describeStep, matchDenyPattern } from '../exec/policy.js';
import type { StepAuthorizer } from '../exec/authorizer.js';
import { writeReport } from '../exec/reportFile.js';
import { Pacer } from '../util/pacing.js';
import { RunLog } from '../log/runLog.js';
import { composeOpening, READ_ONLY_NOTE } from '../session/compose.js';
import type { SessionStore } from '../session/store.js';
import type { EventBus } from '../session/events.js';
import type { Session, Task, TaskRunGroup, TaskReview, TaskReviewCheck, TaskStatus } from '../session/model.js';
import { mirrorProject, describeMirror } from '../context/projectMirror.js';
import { prepareForTask, commitTaskResult, repoDirOf } from '../vcs/taskVcs.js';
import { defaultExportDir } from '../context/contextFiles.js';

export type TaskOutcome = {
  status: Extract<TaskStatus, 'done' | 'blocked' | 'failed' | 'aborted' | 'limit-reached'>;
  iterations: number;
  summary?: string;
  reason?: string;
};

export type RunDeps = {
  cfg: ResolvedConfig;
  store: SessionStore;
  bus: EventBus;
  authorizer: StepAuthorizer;
  /** Set to stop after the current step. */
  signal?: AbortSignal;
  /**
   * The press of a start button this run belongs to, written onto every task it reaches.
   *
   * It is passed down rather than made here because a run of several sessions is one group
   * across all of them, and only the caller that started them knows that.
   */
  runGroup?: TaskRunGroup;
};

/** Why a task that was reported as done is being closed as failed. */
function checksFailedReason(outcomes: CheckOutcome[]): string {
  const failed = outcomes.filter((o) => !o.passed);
  return failed.length === 0
    ? 'the checks the operator set for this task did not pass'
    : `the task reported itself as done, but these checks did not pass: ${failed
        .map((o) => `${o.check.name} (${o.detail})`)
        .join('; ')}`;
}

/**
 * What a command that has already been run is told, when it is sent again.
 *
 * Addressed to the model, because the model is the only thing that can act on it, and phrased
 * as an instruction rather than a complaint: the useful half of a refusal is what to do next.
 */
function repeatRefusal(count: number, limit: number): string {
  return (
    `this exact command has already run ${count} time(s) in a row in this task and returned the same ` +
    `result each time, which is the limit (maxCommandRepeats ${limit}). Running it again cannot ` +
    'tell you anything new, so it was not run. Do something different in kind: a different ' +
    'command, a different tool, a different way round the problem, or read something you have ' +
    'not read yet. If you have genuinely run out of approaches, end the task with status ' +
    '"blocked" and list in "tried" the different things you attempted.'
  );
}

/**
 * The earlier tasks a reviewer is shown, when tasks build on each other.
 *
 * Only in per-session mode, where the tree carries their work, and only the ones that ran:
 * the last three before this one, prompts capped, because the brief is read by a model with
 * a context to spend and the point is what they defined, not their every word.
 */
export function earlierTasksForReview(session: Session, task: Task, limit = 3, maxChars = 2500): Array<{ title: string; prompt: string }> {
  if (session.vcs?.branchMode !== 'per-session') return [];
  const index = session.tasks.findIndex((t) => t.id === task.id);
  const before = index < 0 ? session.tasks : session.tasks.slice(0, index);
  return before
    .filter((t) => t.status !== 'queued')
    .slice(-limit)
    .map((t) => ({ title: t.title, prompt: t.prompt.length > maxChars ? `${t.prompt.slice(0, maxChars)}\n[… ${t.prompt.length - maxChars} more characters]` : t.prompt }));
}

/**
 * The reason line for a task the model gave up on, built from what it says it tried.
 *
 * The approaches are kept, not summarised away. "Blocked" on its own is no more useful than
 * "failed"; the list of what was attempted is the part somebody reads to decide whether the
 * task was wrong, the environment was wrong, or the model simply missed something obvious.
 */
function blockedReason(tried: string[], needed?: string): string {
  const attempts = tried.map((t, i) => `(${i + 1}) ${t}`).join(' ');
  const needs = needed?.trim();
  return [
    `stopped as blocked after ${tried.length} different approach(es): ${attempts}`,
    needs ? `To unblock it: ${needs}` : '',
  ]
    .filter(Boolean)
    .join(' — ');
}

/** A step that was refused never reaches the shell, but Copilot still has to hear about it. */
function refusedResult(step: Step, reason: string): RunResult {
  return {
    id: step.id,
    shell: (step.shell ?? 'pwsh') as RunResult['shell'],
    command: describeStep(step),
    exitCode: -4,
    outcome: 'aborted',
    durationMs: 0,
    stdout: '',
    stderr: `[policy] step not executed: ${reason}\n`,
    truncated: false,
    logPath: '',
    lastOutputAgoMs: 0,
  };
}

/** One place that writes to the transcript, the console and the live stream at once. */
class Sink {
  constructor(
    private readonly log: RunLog,
    private readonly bus: EventBus,
    private readonly sessionId: string,
    private readonly taskId: string,
  ) {}

  event(type: string, data: Record<string, unknown> = {}, human?: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.log.event(type, data, human, level);
    this.bus.publish({ sessionId: this.sessionId, taskId: this.taskId, type, level, message: human, data });
  }

  say(text: string): void {
    this.log.say(text);
    this.bus.publish({ sessionId: this.sessionId, taskId: this.taskId, type: 'console', level: 'info', message: text.trim() });
  }
}

/**
 * Opens the browser and signs in. Nothing about any particular conversation.
 *
 * Split from entering a conversation so that a run of several sessions can open one window and
 * keep it. Closing the browser between sessions meant a fresh launch, a fresh sign-in check and
 * a fresh profile lock for every one of them — minutes of nothing, repeated, and every one of
 * those launches another chance to hit the failure where a leftover Edge process is still
 * holding the profile.
 */
export async function openBrowser(
  cfg: ResolvedConfig,
  bus: EventBus,
  downloadsDir: string,
  sessionId: string,
): Promise<CopilotTransport> {
  const transport = new CopilotTransport({
    profileDir: cfg.resolved.profileDir,
    downloadsDir,
    chatUrl: cfg.copilot.url,
    channel: cfg.copilot.channel,
    headless: cfg.copilot.headless,
    replyTimeoutMs: cfg.copilot.replyTimeoutSec * 1000,
    signInTimeoutMs: cfg.copilot.signInTimeoutSec * 1000,
    humanWaitMs: cfg.copilot.humanWaitSec * 1000,
    onEvent: (event, detail) => {
      const spoken: Record<string, string> = {
        'sign-in-required': 'The chat is asking you to sign in. Do it in the open Edge window; the run is waiting.',
        'verification-required':
          'The chat is showing a human-verification challenge. Complete it in the open Edge window. ' +
          'The bot will not touch it and is waiting for you.',
        'verification-cleared': 'Verification cleared, continuing.',
        'error-banner': 'The chat reported a transient error; reloading the page.',
      };
      bus.publish({
        sessionId,
        type: `browser:${event}`,
        level: event === 'verification-required' ? 'warn' : 'info',
        message: spoken[event],
        data: detail,
      });
    },
  });

  await transport.open();
  await transport.ensureSignedIn();
  return transport;
}

/**
 * Puts an already-open browser on this session's conversation, or starts one for it.
 *
 * `closeOnFailure` is false when the browser is shared: a conversation that cannot be reopened
 * is this session's problem, and taking the window down with it would end the sessions after it
 * too, for a reason that has nothing to do with them.
 */
export async function enterSessionConversation(
  transport: CopilotTransport,
  session: Session,
  opts: { closeOnFailure: boolean },
): Promise<void> {
  if (session.chat) {
    const ok = await transport.openConversation(session.chat.chatId);
    if (!ok) {
      const byName = await transport.openConversationByName(session.chat.name);
      if (!byName) {
        if (opts.closeOnFailure) await transport.close();
        throw new Error(
          `The session's conversation "${session.chat.name}" could not be reopened. ` +
            'It may have been deleted in Copilot. Start a new session for a fresh conversation.',
        );
      }
    }
  } else {
    await transport.newChat();
  }
}

/**
 * Joins the conversation of another session in the same group, when there is one.
 *
 * Several sessions can be told to share a chat: useful when they are one piece of work split
 * into parts that need to see each other's history, and wasteful to refuse when the tasks were
 * written that way. The first session of a group to run opens the conversation in the ordinary
 * way; every later one adopts the pointer and, with it, the fact that the level-1 contract has
 * already been sent there — sending it twice into the same chat would be both noise and a
 * contradiction, since the contract says it is sent once.
 *
 * A session that already has its own conversation is never moved. Its history is in that chat.
 */
async function joinGroupConversation(store: SessionStore, session: Session, bus: EventBus): Promise<Session> {
  const group = session.conversationGroup?.trim().toLowerCase();
  if (!group || session.chat) return session;

  const others = (await store.listSessions()).filter(
    (s) => s.id !== session.id && s.chat && (s.conversationGroup?.trim().toLowerCase() ?? '') === group,
  );
  if (others.length === 0) return session;

  // The newest conversation in the group, so a group that was restarted carries on in the chat
  // it is actually using rather than in the one it began with months ago.
  const host = others.sort((a, b) => (b.chat?.createdAt ?? '').localeCompare(a.chat?.createdAt ?? ''))[0];

  const updated = await store.updateSession(session.id, (s) => {
    s.chat = host.chat;
    s.contractSent = true;
  });
  bus.publish({
    sessionId: session.id,
    type: 'chat-joined',
    level: 'info',
    message: `sharing the conversation "${host.chat?.name}" with "${host.name}", as both are in the group "${session.conversationGroup}"`,
    data: { group: session.conversationGroup, hostSession: host.id, chatId: host.chat?.chatId },
  });
  return updated;
}

/** The old shape, kept for the terminal path: open a browser and enter the conversation. */
export async function openSessionTransport(
  cfg: ResolvedConfig,
  session: Session,
  bus: EventBus,
  runsDir: string,
): Promise<CopilotTransport> {
  const transport = await openBrowser(cfg, bus, join(runsDir, '_browser'), session.id);
  await enterSessionConversation(transport, session, { closeOnFailure: true });
  return transport;
}

/**
 * Puts the conversation on the model the session asks for, once per run.
 *
 * Applied here rather than per task because the picker belongs to the conversation, and a
 * failure is reported rather than raised: a model that is out of quota or has been withdrawn
 * should not throw away a queue of tasks. The run continues on whatever the chat is actually
 * set to, and the session records that, so the register shows which model did the work rather
 * than which one was asked for.
 */
async function applySessionModel(transport: CopilotTransport, session: Session, bus: EventBus): Promise<string | undefined> {
  if (!session.model?.trim()) return undefined;

  const result = await transport.selectModel(session.model.trim()).catch((e: unknown) => ({
    ok: false as const,
    current: null,
    reason: (e as Error).message,
  }));

  bus.publish({
    sessionId: session.id,
    type: result.ok ? 'model-selected' : 'model-not-selected',
    level: result.ok ? 'info' : 'warn',
    message: result.ok
      ? `model: ${result.current ?? session.model}`
      : `could not switch to "${session.model}": ${result.reason ?? 'unknown reason'}. Continuing on ${result.current ?? 'the chat default'}.`,
    data: { asked: session.model, current: result.current, ok: result.ok },
  });

  return result.current ?? undefined;
}

/** Runs one task to completion inside an already-open transport. */
export async function runTask(
  transport: CopilotTransport,
  session: Session,
  task: Task,
  deps: RunDeps,
): Promise<TaskOutcome> {
  const { cfg, store, bus, authorizer, signal } = deps;
  // Every attempt gets its own folder. The first keeps the original name, so nothing that
  // already exists on disk moves; a re-run adds its attempt number.
  const attempt = task.attempt ?? 1;
  const runId = task.runId ?? `${session.id}-${task.id}${attempt > 1 ? `-a${attempt}` : ''}`;
  const log = new RunLog(runId, cfg.resolved.runsDir);
  const sink = new Sink(log, bus, session.id, task.id);
  const pacer = new Pacer({
    enabled: cfg.pacing.enabled,
    settleMs: cfg.pacing.settleMs,
    maxMessagesPerHour: cfg.pacing.maxMessagesPerHour,
  });

  const artifactsDir = log.path('artifacts');
  const reportsDir = log.path('reports');
  const repliesDir = log.path('replies');
  const taskLogPath = log.path('task-log.txt');
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(repliesDir, { recursive: true });

  /** The consolidated, human-readable record of the whole task, appended as it happens. */
  const record = async (heading: string, body: string): Promise<void> => {
    await appendFile(taskLogPath, `\n${'='.repeat(78)}\n${heading}\n${'='.repeat(78)}\n${body.trimEnd()}\n`, 'utf8');
  };

  let replySeq = 0;
  const saveReply = async (label: string, reply: ReplyCapture): Promise<void> => {
    replySeq += 1;
    const base = join(repliesDir, `${String(replySeq).padStart(2, '0')}-${label}`);
    await writeFile(`${base}.md`, reply.markdown, 'utf8').catch(() => undefined);
    if (reply.codeBlocksDom.length > 0) {
      const rendered = reply.codeBlocksDom
        .map((b, i) => ['--- code block ' + (i + 1) + ' as rendered ---', b].join('\n'))
        .join('\n\n');
      await writeFile(`${base}.onscreen.txt`, rendered, 'utf8').catch(() => undefined);
    }
  };

  const setTask = async (mutate: (t: Task) => void): Promise<void> => {
    await store.updateTask(session.id, task.id, mutate);
  };

  const startedAt = Date.now();
  const deadline = startedAt + cfg.limits.maxRunMinutes * 60_000;
  let iterations = 0;
  /** What the model has declared it could not do as written, merged across every reply. */
  let deviations: Deviation[] = [];
  /** Review findings the model has disputed, by id, merged across every reply. */
  let disputes: Dispute[] = [];
  /** What the runner tells the model in its next message about the reply just processed. */
  let runnerNotes: string[] = [];
  /**
   * Checks earlier reviews gave with their findings — carried over from every attempt before
   * this one, and grown by this one. See `derivedChecks.ts` for the three rules.
   */
  let reviewChecks: TaskReviewCheck[] = task.reviewChecks ?? [];
  /** Derived checks that still failed when the rounds ran out; the reviewer is told. */
  let derivedStillFailing: Array<{ name: string; detail: string }> = [];
  /**
   * What was running before the task, so that what it and its reviews leave running can be
   * told apart and stopped. Taken once the working directory is known; null means "do not".
   */
  let processesBefore: ProcessSnapshot | null = null;
  /** Stops what appeared since a snapshot, tied to the project, writes it on the task, and says what it was. */
  const reap = async (since: ProcessSnapshot | null, by: string): Promise<Array<{ name: string; ports: number[] }>> => {
    if (!since) return [];
    const result = await reapLeftovers(work.cwd, since).catch(() => null);
    if (!result || (result.killed.length === 0 && result.failed.length === 0)) return [];
    const all = [...result.killed, ...result.failed].map((l) => ({ pid: l.pid, name: l.name, command: l.command.slice(0, 300), ports: l.ports, by }));
    await setTask((t) => {
      t.leftovers = [...(t.leftovers ?? []), ...all];
    });
    sink.event('processes-reaped', { by, killed: result.killed.length, failed: result.failed.length, leftovers: all },
      `${by} left ${all.length} process(es) running; stopped ${result.killed.length}` +
        `${result.failed.length > 0 ? `, could not stop ${result.failed.length}` : ''}: ` +
        all.map((l) => `${l.name} pid ${l.pid}${l.ports.length > 0 ? ` (port ${l.ports.join(', ')})` : ''}`).join('; '),
      'warn');
    await record(`LEFT RUNNING BY ${by.toUpperCase()}`, describeLeftovers([...result.killed, ...result.failed]));
    return all.map((l) => ({ name: l.name, ports: l.ports }));
  };

  const finish = async (status: TaskOutcome['status'], reason?: string, summary?: string, finalReply?: string): Promise<TaskOutcome> => {
    await record(`TASK ${status.toUpperCase()}`, [summary ?? '', reason ? `Reason: ${reason}` : ''].filter(Boolean).join('\n\n') || '(no details)');

    // The net under the plan's own checks: whatever the task left running is stopped and named.
    await reap(processesBefore, 'the task');

    /*
     * A read-only task that changed files has failed, whatever it reported.
     *
     * Decided from the working tree, not from the summary, and before the commit: the change
     * is still committed on the task's branch — so it is not lost and the next task starts
     * from a clean tree — but the task ends `failed` with the files named. Only a task that
     * claims `done` is overturned; one that already ended badly keeps its own reason.
     */
    if (task.readOnly && status === 'done' && repoDirOf(session)) {
      const changed = await workingTreePaths(repoDirOf(session)).catch(() => [] as string[]);
      if (changed.length > 0) {
        status = 'failed';
        reason =
          `this task is read-only and it changed ${changed.length} file(s): ${changed.slice(0, 8).join(', ')}` +
          `${changed.length > 8 ? `, and ${changed.length - 8} more` : ''}. The change is committed on the task's branch; nothing is lost.`;
        sink.event('readonly-violated', { files: changed.slice(0, 20) }, reason, 'error');
      }
    }

    // Whatever the outcome, what the task changed goes onto its branch. A failed task that
    // left files behind is exactly when having them committed somewhere is worth the most.
    // The task is re-read first, because the branch was recorded on it after this closure
    // was created.
    const fresh = (await store.getSession(session.id))?.tasks.find((x) => x.id === task.id);
    const vcsAfter = await commitTaskResult(session, { ...task, vcs: fresh?.vcs }, { status, summary, reason, deviations }, bus).catch(
      (e: unknown) => {
        sink.event('vcs-error', { error: String(e) }, `version control failed after the task: ${(e as Error).message}`, 'warn');
        return undefined;
      },
    );
    if (vcsAfter?.branch) {
      await record(
        'VERSION CONTROL',
        [
          `branch : ${vcsAfter.branch}`,
          `commit : ${vcsAfter.commit ?? '(nothing was committed)'}`,
          vcsAfter.problem ? `problem: ${vcsAfter.problem}` : '',
          (vcsAfter.suspicious?.length ?? 0) > 0
            ? `suspicious: ${vcsAfter.suspicious?.map((s) => `${s.path} (${s.reason})`).join('; ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    await setTask((t) => {
      if (vcsAfter) t.vcs = vcsAfter;
      t.status = status;
      t.iterations = iterations;
      t.finishedAt = new Date().toISOString();
      t.summary = summary;
      t.reason = reason;
      t.finalReply = finalReply;
      if (deviations.length > 0) t.deviations = deviations;
      if (disputes.length > 0) t.disputes = disputes;
      if (reviewChecks.length > 0) t.reviewChecks = reviewChecks;
      t.logFile = 'task-log.txt';
    });
    sink.event('task-finished', { status, reason, iterations }, `task "${task.title}" ${status}${reason ? `: ${reason}` : ''}`);
    await log.close();
    return { status, iterations, summary, reason };
  };

  await setTask((t) => {
    t.status = 'running';
    t.runId = runId;
    t.runGroup = deps.runGroup;
    t.startedAt = new Date().toISOString();
  });
  sink.event('task-started', { runId, title: task.title }, `task "${task.title}" starting (run ${runId})`);
  await writeFile(taskLogPath, `TASK: ${task.title}\nSESSION: ${session.name} (${session.id})\nRUN: ${runId}\nSTARTED: ${new Date().toISOString()}\n`, 'utf8');

  // Which world this run got: the machine's tools, so a difference between two runs of one
  // plan has somewhere to be read from. Once per process; the probes are child processes.
  const environment = collectEnvironment();
  await writeFile(log.path('environment.json'), JSON.stringify(environment, null, 2), 'utf8').catch(() => undefined);
  await record('ENVIRONMENT', describeEnvironment(environment));
  await setTask((t) => {
    t.environment = environment;
  });

  /*
   * Where this session's commands run, decided once and before anything is sent.
   *
   * The session's project, else the configured cwd — and never, by default, this runner's own
   * checkout. A session that would land there has no working directory, and a task with no
   * working directory does not start: refusing each step one by one would spend a whole
   * conversation saying the same thing.
   */
  const work = workingDirFor(session, cfg.resolved.cwd);
  if (isWorkingDirProblem(work)) {
    sink.event('workdir-refused', { cwd: work.cwd }, work.problem, 'error');
    return await finish('failed', work.problem);
  }
  sink.event(
    'workdir',
    { cwd: work.cwd, source: work.source, ownCheckout: work.ownCheckout },
    `commands run in ${work.cwd} (${work.source})${work.ownCheckout ? " — this runner's own checkout, as the session was set" : ''}`,
    work.ownCheckout ? 'warn' : 'info',
  );

  // Not when the project is this runner's own checkout: every process of the runner would
  // then look like a leftover.
  processesBefore = work.ownCheckout ? null : await snapshotProcesses(work.cwd).catch(() => null);

  try {
    // --- version control: a branch of this task's own, before anything is touched -------
    const prepared = await prepareForTask(session, task, bus, async (mutate) => {
      await store.updateSession(session.id, mutate);
    });
    if (prepared.vcs.branch || prepared.vcs.problem) {
      await setTask((t) => {
        t.vcs = prepared.vcs;
      });
      await record(
        'VERSION CONTROL',
        prepared.vcs.problem
          ? `not active: ${prepared.vcs.problem}`
          : `branch ${prepared.vcs.branch}, from ${prepared.vcs.baseCommit ?? '(no commits yet)'}`,
      );
    }

    // --- project mirror, attached to the first message of the task ---------------------
    let mirrorFiles: string[] = [];
    if (session.mirror.enabled && session.mirror.rootDir) {
      const targetDir = cfg.resolved.mirrorTargetDir ?? defaultExportDir();
      const result = await mirrorProject({
        rootDir: session.mirror.rootDir,
        includeDirs: session.mirror.includeDirs.length ? session.mirror.includeDirs : ['.'],
        excludeDirs: session.mirror.excludeDirs,
        targetDir,
        separator: cfg.projectMirror.separator,
        txtMode: cfg.projectMirror.txtMode,
        // The session's own switches win: they are what the operator ticked for this project.
        // Settings only supply the fallback for a session saved before they existed.
        respectGitignore: session.mirror.respectGitignore ?? cfg.projectMirror.respectGitignore,
        ignoreDirs: cfg.projectMirror.ignoreDirs,
        includeEnvFiles: session.mirror.includeEnvFiles ?? cfg.projectMirror.includeEnvFiles,
        maxFileBytes: cfg.projectMirror.maxFileBytes,
      });
      sink.event('mirror', { targetDir, ...result }, `project mirror: ${describeMirror(result)}`);
      if (session.mirror.includeEnvFiles) {
        const envCount = Object.keys(result.mapping).filter((p) => /(^|\/)\.env(\.|$)/i.test(p)).length;
        if (envCount > 0) {
          sink.event('mirror-env', { envCount }, `${envCount} .env file(s) are being attached, as configured`, 'warn');
        }
      }
      for (const s of result.skipped.slice(0, 20)) {
        sink.event('mirror-skipped', { ...s }, `not copied: ${s.relPath} (${s.reason})`);
      }
      const all = Object.values(result.mapping).sort();
      mirrorFiles = all.slice(0, cfg.projectMirror.maxAttachedFiles).map((n) => join(targetDir, n));
      if (all.length > mirrorFiles.length) {
        sink.event('mirror-truncated', { total: all.length, attached: mirrorFiles.length },
          `only the first ${mirrorFiles.length} of ${all.length} mirrored files will be attached`, 'warn');
      }
    }

    // --- opening messages -------------------------------------------------------------
    const { content: level1 } = await store.getLevel1();
    const taskNumber = session.tasks.findIndex((t) => t.id === task.id) + 1;
    const opening = composeOpening({
      level1,
      level2: task.level2,
      prompt: task.prompt,
      taskTitle: task.title,
      taskNumber,
      contractAlreadySent: session.contractSent,
      workDirNote: workingDirNote(work),
      vcsNote: prepared.note,
      readOnlyNote: task.readOnly ? READ_ONLY_NOTE : undefined,
    });
    await setTask((t) => {
      t.firstMessage = opening.firstMessage;
    });
    await record('OPENING MESSAGE', opening.firstMessage);

    let lastMarkdown = '';
    for (const [index, message] of opening.messages.entries()) {
      if (signal?.aborted) return await finish('aborted', 'stopped before the task was sent');
      const isFirstOfTask = index === 0;
      const attach = isFirstOfTask && mirrorFiles.length ? mirrorFiles : [];

      await pacer.throttleSend();
      const before = await transport.sendAndConfirm(message, attach);
      sink.event('message-sent', { index, chars: message.length, attached: attach.length },
        `message ${index + 1}/${opening.messages.length} sent`);

      const reply = await transport.waitForReply(before);
      lastMarkdown = reply.markdown;
      await saveReply(`opening-${index + 1}`, reply);
      await pacer.settle();

      // The conversation exists now: register it and name it, once per session.
      if (!session.chat) {
        const chatId = await transport.currentChatId();
        if (chatId) {
          const name = buildChatName(session.id.slice(0, 15), session.name);
          await transport.nameChat(chatId, name).catch(() => false);
          const chat: ChatPointer = {
            chatId,
            url: `${cfg.copilot.url.replace(/\/chat.*$/, '')}/chat/conversation/${chatId}?es=SSR`,
            name,
            runId,
            createdAt: new Date().toISOString(),
          };
          session.chat = chat;
          await store.updateSession(session.id, (s) => {
            s.chat = chat;
          });
          await savePointer(log.path('chat.json'), chat);
          sink.event('chat-registered', { ...chat }, `chat: ${name}`);
        }
      }
    }
    if (!session.contractSent) {
      session.contractSent = true;
      await store.updateSession(session.id, (s) => {
        s.contractSent = true;
      });
    }

    // --- the loop ---------------------------------------------------------------------
    // How many times the checks have been run for this task, and how many times they may be.
    let checkRounds = 0;
    // Kept here rather than read back off the task: `setTask` writes to the store, it does not
    // refresh the object this function is holding, so reading it back would give the state
    // before the checks ran and the reason would come out empty.
    let lastOutcomes: CheckOutcome[] = [];
    const maxCheckRounds = Math.max(1, cfg.limits.maxCheckRounds ?? 3);
    /*
     * The runner's own check, when there is going to be a commit.
     *
     * Whatever the task's checks say, a commit should not carry what is installed, built,
     * logged or secret. Pointed out once and then let through: the second time round the
     * files are committed and marked, because refusing would leave the tree dirty and the next
     * task refusing to start over it.
     */
    const willCommit = !!(session.vcs?.enabled && session.vcs.commitOnFinish && repoDirOf(session));
    let generatedPointedOut = false;

    /**
     * Whether "done" is accepted, decided by the operator's checks rather than by the reply.
     *
     * Returns `accept` when there is nothing to check or everything passed, `retry` when the
     * failures have been sent back for Copilot to fix, and `give-up` when it has had its
     * rounds. The checks run here, at the end, and not as steps: they are not work, they are
     * the question of whether the work happened, and a task cannot be trusted to answer that
     * about itself.
     */
    const gateOnChecks = async (): Promise<'accept' | 'retry' | 'give-up'> => {
      const checks = [...(task.checks ?? []), ...activeChecks(reviewChecks), ...(willCommit ? [COMMIT_CLEAN_CHECK] : [])];
      if (checks.length === 0) return 'accept';

      checkRounds += 1;
      sink.event('checks-started', { round: checkRounds, count: checks.length },
        `checking the task against ${checks.length} condition(s)`);

      const outcomes: CheckOutcome[] = (lastOutcomes = await runChecks(checks, {
        cwd: work.cwd,
        logDir: log.path('checks'),
        signal: deps.signal,
        deny: (command) => matchDenyPattern(command, cfg.execution.denyPatterns),
        repoDir: willCommit ? repoDirOf(session) : undefined,
      }));

      for (const o of outcomes) {
        if (o.check.expect !== 'commit-clean' || o.passed) continue;
        if (generatedPointedOut) {
          o.passed = true;
          o.detail = `still there after being pointed out once; committed and marked as suspicious on the task — ${o.detail}`;
        } else {
          generatedPointedOut = true;
        }
      }

      await setTask((t) => {
        t.checkResults = outcomes.map((o) => ({ name: o.check.name, passed: o.passed, detail: o.detail }));
      });

      for (const o of outcomes) {
        sink.event(o.passed ? 'check-passed' : 'check-failed', { name: o.check.name, detail: o.detail },
          `${o.passed ? 'passed' : 'FAILED'}: ${o.check.name} — ${o.detail}`, o.passed ? 'info' : 'warn');
      }

      const failed = outcomes.filter((o) => !o.passed);
      if (failed.length === 0) {
        sink.event('checks-passed', { count: outcomes.length }, `all ${outcomes.length} check(s) passed`);
        return 'accept';
      }
      if (deps.signal?.aborted) return 'give-up';
      if (checkRounds > maxCheckRounds) {
        /*
         * Only checks from earlier reviews are failing. A reviewer's check is outranked by the
         * next reviewer's judgement, not by a counter: they are suspended, the work goes to
         * review with them named, and the verdict decides whether they come back or go.
         */
        if (onlyDerivedFailing(outcomes)) {
          const failingNames = new Set(failed.map((o) => o.check.name));
          reviewChecks = reviewChecks.map((rc) => (rc.state === 'active' && failingNames.has(rc.check.name) ? { ...rc, state: 'suspended' as const } : rc));
          await setTask((t) => {
            t.reviewChecks = reviewChecks;
          });
          derivedStillFailing = failed.map((o) => ({ name: o.check.name, detail: o.detail }));
          sink.event('checks-derived-deferred', { rounds: checkRounds - 1, checks: failed.map((o) => o.check.name) },
            `${failed.length} check(s) from earlier reviews still fail after ${maxCheckRounds} attempt(s); the work goes to the reviewer with them named`, 'warn');
          return 'accept';
        }
        sink.event('checks-exhausted', { rounds: checkRounds - 1 },
          `${failed.length} check(s) still failing after ${maxCheckRounds} attempt(s); the task is closed as failed`, 'warn');
        return 'give-up';
      }

      // The failures go back exactly the way step output does: a message with a file attached,
      // because a compiler's opinion belongs in a file and not in a chat bubble.
      const path = join(reportsDir, `checks-${checkRounds}.txt`);
      // Check output is uploaded too, so it is redacted the same way a step report is.
      const checkReport = redactSecrets(failureReport(outcomes), cfg.report.redactPatterns);
      await writeFile(path, checkReport, 'utf8');
      await record(`CHECKS ${checkRounds}`, checkReport);
      const message = failureMessage(outcomes, checkRounds, maxCheckRounds);
      await record(`CHECKS ${checkRounds} MESSAGE SENT`, message);

      await pacer.throttleSend();
      const before = await transport.sendAndConfirm(message, [path]);
      const next = await transport.waitForReply(before);
      await saveReply(`checks-${checkRounds}`, next);
      lastMarkdown = next.markdown;
      await pacer.settle();
      return 'retry';
    };

    /*
     * The second opinion.
     *
     * It runs after the checks and only when they have passed, which is the right order for two
     * reasons: the checks are mechanical and free, so spending a whole conversation to discover
     * what a string comparison would have told us is waste; and a reviewer shown work that does
     * not even compile spends its round on that instead of on the things only a reader finds.
     *
     * The reviewer gets its own conversation, in the same browser, and the implementer's is
     * returned to afterwards. What it is told is deliberately narrow — the task, the project
     * instructions and the files that changed — and what it is not told is the implementer's
     * summary, because a reviewer that reads an account of the work starts by trusting the thing
     * it is meant to be checking.
     */
    let reviewRounds = 0;
    let lastReview: ReviewOutcome | null = null;
    /**
     * What the previous round found, as it was sent back. The next reviewer is told, and a
     * finding that comes back is recognised against this — see `isRepeat`.
     */
    let previousFindings: Array<ReviewFinding & { id: string; repeated?: boolean }> = [];
    /** What the previous review's own steps left running, told to both sides. */
    let previousLeftovers: Array<{ name: string; ports: number[] }> = [];

    const reviewWanted = task.reviewEnabled ?? session.review?.enabled ?? true;
    const maxReviewRounds = Math.max(1, cfg.limits.maxReviewRounds ?? 2);

    const saveReview = async (review: TaskReview): Promise<void> => {
      await setTask((t) => {
        t.review = review;
      });
    };

    /**
     * Whether a task that passed its checks is actually finished.
     *
     * `accept` — reviewed and passed, or not reviewed at all.
     * `retry` — the reviewer found problems and they have been sent back to the implementer.
     * `give-up` — the rounds are spent and the findings are still standing.
     */
    const gateOnReview = async (): Promise<'accept' | 'retry' | 'give-up'> => {
      if (!reviewWanted) {
        await saveReview({ verdict: 'skipped', rounds: 0, stepsRun: 0 });
        return 'accept';
      }

      reviewRounds += 1;

      const model = (session.review?.model ?? '').trim();
      const repoDir = session.vcs?.enabled ? (session.vcs.repoDir ?? '').trim() : '';
      /*
       * What changed, read from git rather than from anybody's account of it.
       *
       * The commit happens when the task closes, which is after this, so the task's changes are
       * still sitting in the working tree. That is exactly the list wanted: the branch was cut
       * before this task started, so everything dirty now is this task's doing.
       */
      const changedFiles = repoDir ? (await repoState(repoDir).catch(() => null))?.changed ?? [] : [];

      sink.event('review-started', { round: reviewRounds, model: model || '(the session model)', files: changedFiles.length },
        `an independent review is opening a fresh conversation (round ${reviewRounds} of ${maxReviewRounds})`);

      // What is running before the review, so that what the review leaves is its own.
      const beforeReview: ProcessSnapshot | null = processesBefore ? await snapshotProcesses(work.cwd).catch(() => null) : null;
      let roundLeftovers: Array<{ name: string; ports: number[] }> = [];
      let outcome: ReviewOutcome;
      try {
        await transport.newChat();
        if (model) {
          const picked = await transport.selectModel(model).catch((e: unknown) => ({ ok: false, current: null, reason: (e as Error).message }));
          sink.event(picked.ok ? 'review-model-selected' : 'review-model-not-selected', { asked: model, current: picked.current },
            picked.ok ? `the review runs on ${picked.current ?? model}` : `the review could not switch to "${model}": ${picked.reason ?? 'unknown reason'}`,
            picked.ok ? 'info' : 'warn');
        }

        outcome = await runReview(transport, session, task, {
          cfg,
          authorizer,
          signal,
          pacer,
          dir: log.path('review', String(reviewRounds)),
          round: reviewRounds,
          cwd: work.cwd,
          changedFiles,
          deviations,
          disputes,
          previous: reviewRounds > 1 ? { round: reviewRounds - 1, findings: previousFindings, leftovers: previousLeftovers } : undefined,
          repoDir: willCommit ? repoDirOf(session) : undefined,
          derivedFailing: derivedStillFailing,
          // Before the verdict is judged: a check given with a finding must fail on the work,
          // not on a server the reviewer forgot to stop.
          beforeVerdict: async () => {
            roundLeftovers = [...roundLeftovers, ...(await reap(beforeReview, `review round ${reviewRounds}`))];
          },
          earlier: earlierTasksForReview(session, task),
          event: (type, data, human, level) => sink.event(type, data, human, level),
          record,
        });
      } catch (e) {
        outcome = { verdict: 'error', findings: [], stepsRun: 0, iterations: 0, problem: (e as Error).message };
      } finally {
        // Back to the conversation that did the work, whatever happened in the other one. A
        // task whose implementer chat is lost cannot be fixed, reported on, or closed properly.
        await enterSessionConversation(transport, session, { closeOnFailure: false }).catch((e: unknown) => {
          sink.event('review-return-failed', { error: String(e) },
            `could not return to the task's own conversation after the review: ${(e as Error).message}`, 'error');
        });
      }

      // A reviewer that left its own server listening once failed the work for it.
      roundLeftovers = [...roundLeftovers, ...(await reap(beforeReview, `review round ${reviewRounds}`))];

      /*
       * Which findings an earlier round already raised.
       *
       * Decided before anything else, because it is the fact everything below turns on: a
       * finding that survives a reported fix is the strongest evidence available that the
       * task, not the work, is what cannot be satisfied — and the one fact the runner used to
       * have and throw away.
       */
      const repeated = outcome.findings.filter((f) => isRepeat(previousFindings, f));
      if (repeated.length > 0) {
        sink.event('review-finding-repeated', { round: reviewRounds, count: repeated.length },
          `${repeated.length} finding(s) came back after a reported fix: ${repeated.map((f) => f.where ?? f.what).join('; ')}`, 'warn');
      }
      // Named by the runner — round and position — so a dispute can point at one and the
      // record can show which came back. The same objects are used everywhere below, so
      // `repeated` still identifies them.
      const named = outcome.findings.map((f, i) => ({
        ...f,
        id: (f as { id?: string }).id ?? findingId(reviewRounds, i),
        ...(repeated.includes(f) ? { repeated: true } : {}),
      }));
      outcome = { ...outcome, findings: named };
      const repeatedNamed = named.filter((f) => f.repeated);

      /*
       * What this verdict does to the derived checks: the ones this reviewer gave join the
       * task; the ones suspended by a dispute or by spent rounds come back if the finding was
       * raised again, and go if it was not.
       */
      if (outcome.verdict === 'pass' || outcome.verdict === 'fail') {
        for (const d of outcome.derivedChecks ?? []) {
          reviewChecks = [...reviewChecks, { check: d.check, findingId: d.findingId, what: d.what, where: d.where, round: reviewRounds, attempt, state: 'active' }];
        }
        const settled = settleAfterReview(reviewChecks, outcome.verdict, named);
        reviewChecks = settled.checks;
        if (settled.reactivated.length > 0) {
          sink.event('review-check-reactivated', { findings: settled.reactivated },
            `the review raised the disputed finding(s) again; their checks are back: ${settled.reactivated.join(', ')}`, 'warn');
        }
        if (settled.dropped.length > 0) {
          sink.event('review-check-dropped', { findings: settled.dropped },
            `the review did not raise the finding(s) again; their checks are dropped: ${settled.dropped.join(', ')}`);
        }
        derivedStillFailing = [];
        await setTask((t) => {
          t.reviewChecks = reviewChecks;
        });
      }
      lastReview = outcome;
      await saveReview({
        verdict: outcome.verdict,
        rounds: reviewRounds,
        stepsRun: outcome.stepsRun,
        summary: outcome.summary,
        findings: named,
        problem: outcome.problem,
        model: model || undefined,
      });

      if (outcome.verdict === 'pass') {
        sink.event('review-passed', { round: reviewRounds, stepsRun: outcome.stepsRun },
          `the review passed the work after running ${outcome.stepsRun} command(s)`);
        // The work is right and the task is wrong. The task is done; the findings stay on its
        // record for whoever wrote it, and the plan behind it is not stopped over a sentence.
        if (outcome.findings.length > 0) {
          sink.event('review-task-notes', { round: reviewRounds, findings: outcome.findings.length },
            `the review passed the work and noted ${outcome.findings.length} problem(s) with the task itself: ` +
              outcome.findings.map((f) => f.what).join(' '), 'warn');
        }
        return 'accept';
      }

      /*
       * A review that could not be carried out does not fail the work.
       *
       * The browser closing, the chat refusing a message, the reviewer losing its format — none
       * of that is evidence about the task, and turning good work into a failed task because
       * the machinery stumbled would make the whole mechanism something to switch off. It is
       * said loudly and recorded on the task instead, so "this went unreviewed" is visible.
       */
      if (outcome.verdict === 'error') {
        sink.event('review-error', { round: reviewRounds, problem: outcome.problem },
          `the review could not be carried out: ${outcome.problem ?? 'unknown reason'}. The work is accepted unreviewed.`, 'warn');
        return 'accept';
      }

      /*
       * Nothing here is the work's fault.
       *
       * When every finding is about the task — it contradicts itself, it asks for something the
       * project instructions forbid, or it expects something untrue of this machine — sending it
       * back is asking somebody to fix a sentence they are not allowed to change. The task stops
       * here instead, on the first round, and says which part of its own description is wrong.
       * That is a result for the person who wrote the task; another lap is not.
       */
      if (allAboutTheTask(outcome.findings)) {
        sink.event('review-task-wrong', { round: reviewRounds, findings: outcome.findings.length },
          `the review found ${outcome.findings.length} problem(s) with the task itself, not with the work`, 'warn');
        return 'give-up';
      }

      /*
       * Out of rounds, and only now.
       *
       * The budget counts times the findings are *sent back*, not reviews — so the last fix is
       * always checked before the task is judged. Counting reviews instead cost a task: round
       * two's finding was sent back, the implementer fixed it, the checks passed, and the task
       * was then blocked quoting that finding as "still there" without anybody having looked
       * at the fix. It had been fixed.
       */
      if (reviewRounds > maxReviewRounds) {
        sink.event('review-exhausted', { rounds: maxReviewRounds, findings: outcome.findings.length },
          `the review still has findings after ${maxReviewRounds} round(s) of fixing; the task is closed as blocked`, 'warn');
        return 'give-up';
      }

      sink.event('review-failed', { round: reviewRounds, findings: outcome.findings.length },
        `the review found ${outcome.findings.length} problem(s); sending them back to be fixed`, 'warn');

      await pacer.throttleSend();
      // The reviewer quotes output in its evidence, so the message gets the same treatment.
      // Recorded as sent, because what reached the chat is what the next question is about.
      const findingsSent = redactSecrets(findingsMessage(outcome, reviewRounds, maxReviewRounds, repeatedNamed, roundLeftovers), cfg.report.redactPatterns);
      await writeFile(log.path('review', String(reviewRounds), 'findings-sent.md'), findingsSent, 'utf8').catch(() => undefined);
      await record(`REVIEW ${reviewRounds} FINDINGS SENT`, findingsSent);
      const before = await transport.sendAndConfirm(findingsSent);
      const next = await transport.waitForReply(before);
      await saveReply(`review-${reviewRounds}-findings`, next);
      lastMarkdown = next.markdown;
      await pacer.settle();
      previousFindings = named;
      previousLeftovers = roundLeftovers;
      return 'retry';
    };

    /** Why a task that was reviewed and found wanting is being closed without being done. */
    const reviewBlockedReason = (): string => {
      const findings = lastReview?.findings ?? [];
      const listed = findings.map((f, i) => `(${i + 1}) ${f.what}`).join(' ');
      // The two endings read differently because they ask different things of the reader: one
      // is "the work is not finished", the other is "the task is wrong and needs a decision".
      return allAboutTheTask(findings)
        ? `an independent review found ${findings.length} problem(s) with the task itself rather than with the work, ` +
          `so there was nothing to send back for fixing: ${listed}`
        : `an independent review found ${findings.length} problem(s) that were still there after ` +
          `${maxReviewRounds} round(s) of fixing: ${listed}`;
    };

    let formatRetries = 0;

    /*
     * The anti-spin guards.
     *
     * `seen` counts how often each command has actually run, normalised only for whitespace so
     * that two genuinely different commands never collide. `stalled` counts iterations in which
     * every single step was refused as a repeat — which is the signature of a model going round
     * in a circle, and the thing that turns into a task that ends rather than a task that times
     * out.
     */
    const maxCommandRepeats = Math.max(1, cfg.limits.maxCommandRepeats ?? 3);
    const maxStalledIterations = Math.max(1, cfg.limits.maxStalledIterations ?? 2);
    /**
     * Per command: how many times in a row it has returned exactly the same thing.
     *
     * The count is of *identical results*, not of runs, and the difference matters. A long task
     * legitimately runs `npx tsc --noEmit` five or six times — after each fix, and again after
     * each round of review findings — and every one of those runs is a verification of something
     * that just changed. Counting runs refused the sixth one as a repeat and pushed the model
     * into inventing ways around its own type-checker. Counting identical results refuses only
     * what it was meant to: the same command, returning the same answer, again.
     */
    const seen = new Map<string, { sameInARow: number; signature: string }>();
    const fingerprint = (step: Step): string =>
      step.type === 'command' ? step.cmd.replace(/\s+/g, ' ').trim() : `download:${step.file}:${step.args.join(' ')}`;
    /** What "the same answer" means: the exit code and the output, hashed. */
    const resultSignature = (r: RunResult): string =>
      createHash('sha256').update(`${r.exitCode}\u0000${r.outcome}\u0000${r.stdout}\u0000${r.stderr}`).digest('hex');
    let stalled = 0;

    for (;;) {
      if (signal?.aborted) return await finish('aborted', 'stopped by the operator');
      if (Date.now() > deadline) return await finish('limit-reached', `maxRunMinutes (${cfg.limits.maxRunMinutes}) reached`);
      if (iterations >= cfg.limits.maxIterations) return await finish('limit-reached', `maxIterations (${cfg.limits.maxIterations}) reached`);

      const parsed = parseReply(lastMarkdown, {
        stopMarker: cfg.copilot.stopMarker,
        defaultShell: cfg.execution.defaultShell,
      });

      if (!parsed.ok) {
        formatRetries += 1;
        sink.event('format-error', { reason: parsed.reason, detail: parsed.detail },
          `reply did not match the contract (${parsed.reason}), retry ${formatRetries}/${cfg.limits.maxFormatRetries}`, 'warn');
        if (formatRetries > cfg.limits.maxFormatRetries) {
          await transport.dumpFailure(log.path('failures'), 'format-error');
          return await finish('failed', `Copilot did not keep the output contract: ${parsed.detail}`, undefined, lastMarkdown);
        }
        await pacer.throttleSend();
        const before = await transport.sendAndConfirm(formatErrorMessage(parsed, formatRetries, cfg.limits.maxFormatRetries));
        const again = await transport.waitForReply(before);
        await saveReply(`format-retry-${formatRetries}`, again);
        lastMarkdown = again.markdown;
        continue;
      }

      formatRetries = 0;
      iterations += 1;
      await setTask((t) => {
        t.iterations = iterations;
      });
      const { reply, done, blocked } = parsed;
      sink.event('reply-parsed', { iteration: iterations, status: reply.status, steps: reply.steps.length, notes: reply.notes },
        `iteration ${iterations}: ${reply.steps.length} step(s)${reply.notes ? ` — ${reply.notes}` : ''}`);

      /*
       * A deviation is recorded the moment it is declared, not when the task ends.
       *
       * Merged rather than appended while the task goes on, because the same one tends to be
       * declared twice; replaced by the closing reply's list when it carries one, because that
       * is the final account and a deviation undone since would otherwise stand in the commit.
       * Written to the task at once, because a task that ends `failed` or `aborted` still
       * deviated, and that is still worth knowing about.
       */
      if (reply.deviations.length > 0) {
        deviations = resolveDeviations(deviations, reply.status, reply.deviations);
        await setTask((t) => {
          t.deviations = deviations;
        });
        sink.event('deviation-declared', { count: reply.deviations.length, total: deviations.length },
          `the model says ${reply.deviations.length} instruction(s) could not be followed as written: ` +
            reply.deviations.map((d) => d.instruction).join('; '), 'warn');
        await record('DEVIATIONS DECLARED', describeDeviations(reply.deviations));
      }

      /*
       * A disputed finding goes on the record and to the next reviewer, not into the summary.
       *
       * The alternative was the one the message used to recommend — "say so in your summary"
       * — and the summary is the one thing the next reviewer is never shown.
       */
      if (reply.disputed.length > 0) {
        disputes = mergeDisputes(disputes, reply.disputed);
        await setTask((t) => {
          t.disputes = disputes;
        });
        sink.event('finding-disputed', { count: reply.disputed.length, ids: reply.disputed.map((d) => d.finding) },
          `the model disputes ${reply.disputed.length} review finding(s): ${reply.disputed.map((d) => d.finding).join(', ')}`, 'warn');
        await record('FINDINGS DISPUTED', describeDisputes(reply.disputed));
        // A disputed finding's check does not run again until the next review rules on it.
        const paused = suspendDisputed(reviewChecks, reply.disputed.map((d) => d.finding));
        if (paused.suspended.length > 0) {
          reviewChecks = paused.checks;
          await setTask((t) => {
            t.reviewChecks = reviewChecks;
          });
          sink.event('review-check-suspended', { findings: paused.suspended },
            `check(s) from disputed finding(s) suspended until the next review rules: ${paused.suspended.join(', ')}`);
        }
        /*
         * Said back at once, in the next message. The implementer that disputed a check it
         * could not satisfy, and heard nothing, ended the task `blocked` over that check — it
         * had no way to know the dispute had taken the check out of the gate.
         */
        const ids = reply.disputed.map((d) => d.finding).join(', ');
        runnerNotes.push(
          paused.suspended.length > 0
            ? `Noted: you disputed ${ids}. The check(s) tied to ${paused.suspended.join(', ')} are suspended and will not run ` +
              'until the next review rules on your dispute. When the work is verified, report done again; the next reviewer is told.'
            : `Noted: you disputed ${ids}; no check was tied to those findings. The next reviewer is told. When the work is verified, report done again.`,
        );
      }

      /*
       * The task ends here, and it ends without the checks.
       *
       * Running them would only produce a list of things that are not true, which is already
       * what the reply said, at greater length and one message later. The reason carries the
       * approaches that were tried, and that is what the register shows.
       */
      if (blocked) {
        sink.event('task-blocked', { tried: reply.tried, needed: reply.needed },
          `the task was given up as blocked after ${reply.tried.length} approach(es)`, 'warn');
        return await finish('blocked', blockedReason(reply.tried, reply.needed), reply.summary, lastMarkdown);
      }

      if (done && reply.steps.length === 0) {
        const verdict = await gateOnChecks();
        if (verdict === 'give-up') {
          return await finish('failed', checksFailedReason(lastOutcomes), reply.summary, lastMarkdown);
        }
        if (verdict === 'accept') {
          const reviewed = await gateOnReview();
          if (reviewed === 'accept') return await finish('done', undefined, reply.summary, lastMarkdown);
          if (reviewed === 'give-up') return await finish('blocked', reviewBlockedReason(), reply.summary, lastMarkdown);
        }
        continue;
      }

      /*
       * A download step that names a file the reply does not carry.
       *
       * Copilot says "the attached script writes the files", the runner looks, and there is no
       * attachment at all — it described a file instead of producing one. Caught here, before a
       * single step runs, because the alternative is what happened: the download was refused
       * mid-iteration, the steps after it failed against files that were never written, and the
       * results file that went back was a page of errors about work that had never started. The
       * model then lost track of which task it was on and re-ran the previous one.
       *
       * Only the empty case is treated this way. A name that does not match while exactly one
       * file *is* attached is handled further down, where it is a naming difference rather than
       * a missing file.
       */
      const wantedFiles = reply.steps.filter(isDownloadStep).map((x) => x.file);
      if (wantedFiles.length > 0) {
        const attached = await transport.lastMessageAttachmentNames().catch(() => [] as string[]);
        if (attached.length === 0) {
          formatRetries += 1;
          sink.event('attachment-missing', { wanted: wantedFiles, retry: formatRetries },
            `the reply asks to run ${wantedFiles.join(', ')} but carries no file at all, retry ${formatRetries}/${cfg.limits.maxFormatRetries}`,
            'warn');
          if (formatRetries > cfg.limits.maxFormatRetries) {
            return await finish('failed', `Copilot kept asking to run files it did not attach: ${wantedFiles.join(', ')}`, undefined, lastMarkdown);
          }
          await pacer.throttleSend();
          const askAgain = await transport.sendAndConfirm(
            `Your last reply has a download step for ${wantedFiles.map((f) => `"${f}"`).join(', ')}, but the message ` +
              'carries no attached file at all. Naming a file in the notes does not attach one, and nothing was run. ' +
              'Send the reply again either with the file genuinely attached to the message, or — simpler and usually ' +
              'better for source files — as ordinary command steps that write the file with Set-Content.',
          );
          const retry = await transport.waitForReply(askAgain);
          await saveReply(`attachment-retry-${formatRetries}`, retry);
          lastMarkdown = retry.markdown;
          continue;
        }
      }

      // --- execute -----------------------------------------------------------------
      const results: RunResult[] = [];
      let aborted = false;
      /** How many of this iteration's steps were turned away for being repeats. */
      let repeatsRefused = 0;

      for (const step of reply.steps) {
        if (signal?.aborted) {
          results.push(refusedResult(step, 'stopped by the operator'));
          aborted = true;
          break;
        }
        let scriptPath: string | undefined;

        if (step.type === 'download') {
          const target = join(artifactsDir, `${iterations}-${step.id}-${step.file}`);
          try {
            await transport.downloadAttachment(step.file, target);
            const hash = createHash('sha256').update(await readFile(target)).digest('hex');
            sink.event('download', { file: step.file, path: target, sha256: hash }, `downloaded ${step.file} (sha256 ${hash.slice(0, 12)}…)`);
            scriptPath = target;
          } catch (e) {
            results.push(refusedResult(step, `download failed: ${(e as Error).message}`));
            continue;
          }
          if (!step.run) {
            results.push({ ...refusedResult(step, 'saved only'), exitCode: 0, outcome: 'completed', stderr: '', stdout: `Saved to ${scriptPath}\n` });
            continue;
          }
        }

        if (step.type === 'command') {
          const damage = findLikelyDamage(step.cmd);
          if (damage) {
            sink.event('step-damaged', { id: step.id, cmd: step.cmd, damage }, `step ${step.id} arrived damaged: ${damage}`, 'warn');
            results.push(refusedResult(step, `${damage}. ${damageGuidance()}`));
            continue;
          }
        }

        // Refused before the operator is asked to approve it, because a step that cannot teach
        // anyone anything is not worth a person's attention either.
        const key = fingerprint(step);
        const ran = seen.get(key)?.sameInARow ?? 0;
        if (ran >= maxCommandRepeats) {
          repeatsRefused += 1;
          sink.event('step-repeated', { id: step.id, count: ran, limit: maxCommandRepeats },
            `step ${step.id} refused: already run ${ran} time(s) in this task with the same result`, 'warn');
          results.push(refusedResult(step, repeatRefusal(ran, maxCommandRepeats)));
          continue;
        }

        await setTask((t) => {
          t.status = 'waiting-approval';
        });
        sink.event('step-proposed', { id: step.id, description: describeStep(step, scriptPath) }, `step ${step.id}: ${describeStep(step, scriptPath)}`);
        const decision = await authorizer.authorize(step, { sessionId: session.id, taskId: task.id, iteration: iterations, scriptPath });
        await setTask((t) => {
          t.status = 'running';
        });

        if (decision.action === 'abort') {
          results.push(refusedResult(step, decision.reason));
          aborted = true;
          break;
        }
        if (decision.action === 'skip') {
          sink.event('step-skipped', { id: step.id, reason: decision.reason }, `step ${step.id} skipped: ${decision.reason}`, 'warn');
          results.push(refusedResult(step, decision.reason));
          continue;
        }

        const long = step.expect === 'long';
        const cap = cfg.execution.maxStepTimeoutSec;
        const hard = Math.min(step.timeoutSec ?? (long ? cfg.execution.longCommandTimeoutSec : cfg.execution.commandTimeoutSec), cap);
        const idle = Math.min(step.idleTimeoutSec ?? (long ? cfg.execution.longIdleTimeoutSec : cfg.execution.idleTimeoutSec), cap);

        sink.event('step-started', { id: step.id }, `running step ${step.id}: ${describeStep(step, scriptPath)}`);
        const result = await runStep(
          {
            id: step.id,
            shell: (step.shell ?? cfg.execution.defaultShell) as RunResult['shell'],
            command: step.type === 'command' ? step.cmd : (scriptPath as string),
            scriptArgs: step.type === 'download' ? step.args : undefined,
            cwd: work.cwd,
            hardTimeoutMs: hard * 1000,
            idleTimeoutMs: idle * 1000,
            logPath: log.path('steps', `${iterations}-${step.id}.log`),
          },
          {
            signal,
            onHeartbeat: ({ elapsedMs, idleMs, lastLine }) =>
              sink.event('step-heartbeat', { id: step.id, elapsedMs, idleMs, lastLine },
                `step ${step.id} still running: ${Math.round(elapsedMs / 1000)}s elapsed, ${Math.round(idleMs / 1000)}s since output${lastLine ? ` — ${lastLine.slice(0, 60)}` : ''}`),
          },
        );

        results.push(result);
        // The run counts toward the limit only if it changed nothing about the answer.
        const signature = resultSignature(result);
        const previous = seen.get(key);
        seen.set(key, {
          signature,
          sameInARow: previous && previous.signature === signature ? previous.sameInARow + 1 : 1,
        });
        sink.event('step-finished', { id: step.id, outcome: result.outcome, exitCode: result.exitCode, durationMs: result.durationMs },
          `step ${step.id}: ${result.outcome}, exit ${result.exitCode}, ${(result.durationMs / 1000).toFixed(1)}s`);

        if (cfg.execution.stopOnFailure && result.exitCode !== 0) {
          sink.event('stop-on-failure', { id: step.id }, 'stopping the iteration: stopOnFailure is set', 'warn');
          break;
        }
        await pacer.settle();
      }

      // --- report back ---------------------------------------------------------------
      const report = await writeReport(results, {
        runId,
        task: task.title,
        iteration: iterations,
        dir: reportsDir,
        fileNameTemplate: cfg.report.fileName,
        maxReportBytes: cfg.report.maxReportBytes,
        maxOutputChars: cfg.report.maxOutputChars,
        redactPatterns: cfg.report.redactPatterns,
      });
      await record(`ITERATION ${iterations}`, await readFile(report.paths[0], 'utf8'));
      sink.event('report-written', { iteration: iterations, files: report.names, bytes: report.bytes },
        `report: ${report.names.join(', ')} (${report.bytes < 1024 ? `${report.bytes} bytes` : `${(report.bytes / 1024).toFixed(1)} KB`})`);
      if (report.redactions.length > 0) {
        sink.event('report-redacted', { iteration: iterations, redactions: report.redactions },
          `redacted before upload: ${report.redactions.map((r) => `${r.count}× ${r.name}`).join(', ')}`, 'warn');
      }

      if (aborted) return await finish('aborted', 'the operator aborted the task', undefined, lastMarkdown);

      /*
       * Nothing this iteration did anything.
       *
       * Every step was a repeat of something already run, which means the previous refusal was
       * read and ignored. One of those is the model reacting to the refusal; two in a row is a
       * loop, and the task is ended here rather than left to burn through its iterations and
       * die with a message about a limit that explains nothing.
       */
      if (reply.steps.length > 0 && repeatsRefused === reply.steps.length) {
        stalled += 1;
        sink.event('iteration-stalled', { stalled, limit: maxStalledIterations },
          `every step this iteration was a repeat (${stalled}/${maxStalledIterations})`, 'warn');
        if (stalled >= maxStalledIterations) {
          const repeated = [...seen.entries()]
            .filter(([, v]) => v.sameInARow >= maxCommandRepeats)
            .map(([cmd]) => cmd.slice(0, 120));
          return await finish(
            'blocked',
            `the same command(s) were sent again after being refused for repetition, ${stalled} iteration(s) running, ` +
              `so the task was ended rather than left to run out of iterations. Repeated: ${repeated.join(' | ')}`,
            reply.summary,
            lastMarkdown,
          );
        }
      } else {
        stalled = 0;
      }

      let covering = buildCoveringMessage({ task: task.title, iteration: iterations, results, attachments: report.names, parts: report.parts, notes: runnerNotes });
      runnerNotes = [];
      // Said in the message as well as in the step's own output, because a refusal buried in an
      // attached file is a refusal that gets read after the next command has been written.
      if (repeatsRefused > 0) {
        covering +=
          `\n\n${repeatsRefused} of the ${reply.steps.length} step(s) were not run: they repeat a command ` +
          `that has already run ${maxCommandRepeats} time(s) in this task with the same result. ` +
          'Change the approach rather than the wording. If nothing else is left to try, end with ' +
          'status "blocked" and say in "tried" what you attempted.';
      }
      assertSendable(covering, report.names);

      let sent = false;
      for (let attempt = 0; attempt <= cfg.report.uploadRetries && !sent; attempt += 1) {
        try {
          await pacer.throttleSend();
          const before = await transport.sendAndConfirm(covering, report.paths);
          const next = await transport.waitForReply(before);
          await saveReply(`iteration-${iterations}`, next);
          lastMarkdown = next.markdown;
          sent = true;
        } catch (e) {
          sink.event('report-send-failed', { attempt, error: String(e) }, `sending the report failed (attempt ${attempt + 1}): ${(e as Error).message}`, 'warn');
          if (attempt === cfg.report.uploadRetries) {
            const body = await readFile(report.paths[0], 'utf8');
            const text = `${covering}\n\nThe upload failed, so here is the output as text, truncated:\n\n` +
              body.slice(0, cfg.limits.maxMessageChars - covering.length - 200);
            await pacer.throttleSend();
            const before = await transport.sendAndConfirm(text);
            const next = await transport.waitForReply(before);
            lastMarkdown = next.markdown;
            sent = true;
          } else {
            await new Promise((r) => setTimeout(r, pacer.backoffFor(attempt)));
          }
        }
      }

      if (done) {
        const verdict = await gateOnChecks();
        if (verdict === 'give-up') {
          return await finish('failed', checksFailedReason(lastOutcomes), reply.summary, lastMarkdown);
        }
        if (verdict === 'accept') {
          const reviewed = await gateOnReview();
          if (reviewed === 'accept') return await finish('done', undefined, reply.summary, lastMarkdown);
          if (reviewed === 'give-up') return await finish('blocked', reviewBlockedReason(), reply.summary, lastMarkdown);
        }
        continue;
      }
      await pacer.settle();
    }
  } catch (e) {
    const message = (e as Error).message;
    sink.event('task-error', { error: message, stack: (e as Error).stack }, message, 'error');
    await transport.dumpFailure(log.path('failures'), 'crash').catch(() => undefined);
    /*
     * "Target page, context or browser has been closed" is what every call says once the
     * browser is gone, and it explains nothing. When Edge left a crash report, the reason
     * says so, with the process that died and where the report is.
     */
    const crash = /has been closed/i.test(message) ? await transport.recentCrash().catch(() => null) : null;
    return await finish('failed', crash ? `${describeCrash(crash)}. Then: ${message}` : message);
  }
}

/**
 * Runs every queued task of a session, in order, in one conversation. Stops at the first
 * task that does not end with `done` unless `continueOnFailure` is set, because a failed
 * task usually leaves the machine in a state the next task did not expect.
 */
export async function runSession(
  sessionId: string,
  deps: RunDeps & {
    continueOnFailure?: boolean;
    /**
     * A browser that is already open, to be used and left open.
     *
     * Passed by a run of several sessions, which owns the window for the whole batch. When it
     * is absent this function opens its own and closes it at the end, which is what a single
     * session has always done.
     */
    transport?: CopilotTransport;
  },
): Promise<{ ran: number; lastStatus?: TaskOutcome['status'] }> {
  const { cfg, store, bus } = deps;
  let session = await store.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} does not exist.`);

  const queued = session.tasks.filter((t) => t.status === 'queued');
  if (queued.length === 0) {
    bus.publish({ sessionId, type: 'session-idle', level: 'info', message: 'no queued tasks' });
    return { ran: 0 };
  }

  await store.updateSession(sessionId, (s) => {
    s.status = 'running';
  });
  bus.publish({ sessionId, type: 'session-started', level: 'info', message: `${queued.length} task(s) queued` });

  const sessionRunsDir = join(cfg.resolved.runsDir, session.id);
  await mkdir(sessionRunsDir, { recursive: true });

  const borrowed = deps.transport ?? null;
  let transport: CopilotTransport | null = borrowed;
  let ran = 0;
  let lastStatus: TaskOutcome['status'] | undefined;

  try {
    session = await joinGroupConversation(store, session, bus);

    if (borrowed) {
      bus.publish({ sessionId, type: 'browser-reused', level: 'info', message: 'using the browser window that is already open' });
      await enterSessionConversation(borrowed, session, { closeOnFailure: false });
    } else {
      transport = await openSessionTransport(cfg, session, bus, sessionRunsDir);
    }
    const chat = transport as CopilotTransport;

    // The picker belongs to the conversation, so the session's choice is applied once, here,
    // before the first task goes out. What the chat ended up on is recorded either way.
    const modelInUse = await applySessionModel(chat, session, bus);
    if (session.model?.trim()) {
      await store.updateSession(sessionId, (s) => {
        s.modelInUse = modelInUse;
      });
    }

    for (const queuedTask of queued) {
      if (deps.signal?.aborted) break;
      session = (await store.getSession(sessionId)) as Session;
      const task = session.tasks.find((t) => t.id === queuedTask.id);
      if (!task || task.status !== 'queued') continue;

      const outcome = await runTask(chat, session, task, deps);
      ran += 1;
      lastStatus = outcome.status;
      if (outcome.status !== 'done') {
        if (!deps.continueOnFailure) {
          bus.publish({ sessionId, type: 'session-stopped-early', level: 'warn',
            message: `task "${task.title}" ended ${outcome.status}; the remaining tasks stay queued` });
          break;
        }
        // Saying this out loud matters: carrying on past a failure is a choice the operator
        // made earlier, and the log is where they find out it was taken.
        bus.publish({ sessionId, type: 'session-continuing', level: 'warn',
          message: `task "${task.title}" ended ${outcome.status}; continuing with the next one, as this session is set to` });
      }
    }
  } catch (e) {
    bus.publish({ sessionId, type: 'session-error', level: 'error', message: (e as Error).message });
    throw e;
  } finally {
    // A borrowed window belongs to whoever opened it and stays open for the next session.
    if (!borrowed) await transport?.close();
    await store.updateSession(sessionId, (s) => {
      s.status = 'idle';
    });
    bus.publish({ sessionId, type: 'session-finished', level: 'info', message: `${ran} task(s) ran` });
  }
  return { ran, lastStatus };
}
