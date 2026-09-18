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
import type { Step } from '../protocol/replySchema.js';
import { buildCoveringMessage, assertSendable } from '../protocol/reporter.js';
import { runStep, type RunResult } from '../exec/runner.js';
import { describeStep } from '../exec/policy.js';
import type { StepAuthorizer } from '../exec/authorizer.js';
import { writeReport } from '../exec/reportFile.js';
import { Pacer } from '../util/pacing.js';
import { RunLog } from '../log/runLog.js';
import { composeOpening } from '../session/compose.js';
import type { SessionStore } from '../session/store.js';
import type { EventBus } from '../session/events.js';
import type { Session, Task, TaskStatus } from '../session/model.js';
import { mirrorProject, describeMirror } from '../context/projectMirror.js';
import { defaultExportDir } from '../context/contextFiles.js';

export type TaskOutcome = {
  status: Extract<TaskStatus, 'done' | 'failed' | 'aborted' | 'limit-reached'>;
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
};

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
 * Opens the browser for a session: signs in, then either reopens the session's conversation
 * or starts a new one. Shared by every task in the session.
 */
export async function openSessionTransport(
  cfg: ResolvedConfig,
  session: Session,
  bus: EventBus,
  runsDir: string,
): Promise<CopilotTransport> {
  const transport = new CopilotTransport({
    profileDir: cfg.resolved.profileDir,
    downloadsDir: join(runsDir, '_browser'),
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
        sessionId: session.id,
        type: `browser:${event}`,
        level: event === 'verification-required' ? 'warn' : 'info',
        message: spoken[event],
        data: detail,
      });
    },
  });

  await transport.open();
  await transport.ensureSignedIn();

  if (session.chat) {
    const ok = await transport.openConversation(session.chat.chatId);
    if (!ok) {
      const byName = await transport.openConversationByName(session.chat.name);
      if (!byName) {
        await transport.close();
        throw new Error(
          `The session's conversation "${session.chat.name}" could not be reopened. ` +
            'It may have been deleted in Copilot. Start a new session for a fresh conversation.',
        );
      }
    }
  } else {
    await transport.newChat();
  }
  return transport;
}

/** Runs one task to completion inside an already-open transport. */
export async function runTask(
  transport: CopilotTransport,
  session: Session,
  task: Task,
  deps: RunDeps,
): Promise<TaskOutcome> {
  const { cfg, store, bus, authorizer, signal } = deps;
  const runId = task.runId ?? `${session.id}-${task.id}`;
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

  const finish = async (status: TaskOutcome['status'], reason?: string, summary?: string, finalReply?: string): Promise<TaskOutcome> => {
    await record(`TASK ${status.toUpperCase()}`, [summary ?? '', reason ? `Reason: ${reason}` : ''].filter(Boolean).join('\n\n') || '(no details)');
    await setTask((t) => {
      t.status = status;
      t.iterations = iterations;
      t.finishedAt = new Date().toISOString();
      t.summary = summary;
      t.reason = reason;
      t.finalReply = finalReply;
      t.logFile = 'task-log.txt';
    });
    sink.event('task-finished', { status, reason, iterations }, `task "${task.title}" ${status}${reason ? `: ${reason}` : ''}`);
    await log.close();
    return { status, iterations, summary, reason };
  };

  await setTask((t) => {
    t.status = 'running';
    t.runId = runId;
    t.startedAt = new Date().toISOString();
  });
  sink.event('task-started', { runId, title: task.title }, `task "${task.title}" starting (run ${runId})`);
  await writeFile(taskLogPath, `TASK: ${task.title}\nSESSION: ${session.name} (${session.id})\nRUN: ${runId}\nSTARTED: ${new Date().toISOString()}\n`, 'utf8');

  try {
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
        respectGitignore: cfg.projectMirror.respectGitignore,
        ignoreDirs: cfg.projectMirror.ignoreDirs,
        includeEnvFiles: cfg.projectMirror.includeEnvFiles,
        maxFileBytes: cfg.projectMirror.maxFileBytes,
      });
      sink.event('mirror', { targetDir, ...result }, `project mirror: ${describeMirror(result)}`);
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
    let formatRetries = 0;

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
      const { reply, done } = parsed;
      sink.event('reply-parsed', { iteration: iterations, status: reply.status, steps: reply.steps.length, notes: reply.notes },
        `iteration ${iterations}: ${reply.steps.length} step(s)${reply.notes ? ` — ${reply.notes}` : ''}`);

      if (done && reply.steps.length === 0) {
        return await finish('done', undefined, reply.summary, lastMarkdown);
      }

      // --- execute -----------------------------------------------------------------
      const results: RunResult[] = [];
      let aborted = false;

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
            cwd: cfg.resolved.cwd,
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

      if (aborted) return await finish('aborted', 'the operator aborted the task', undefined, lastMarkdown);

      const covering = buildCoveringMessage({ iteration: iterations, results, attachments: report.names, parts: report.parts });
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

      if (done) return await finish('done', undefined, reply.summary, lastMarkdown);
      await pacer.settle();
    }
  } catch (e) {
    const message = (e as Error).message;
    sink.event('task-error', { error: message, stack: (e as Error).stack }, message, 'error');
    await transport.dumpFailure(log.path('failures'), 'crash').catch(() => undefined);
    return await finish('failed', message);
  }
}

/**
 * Runs every queued task of a session, in order, in one conversation. Stops at the first
 * task that does not end with `done` unless `continueOnFailure` is set, because a failed
 * task usually leaves the machine in a state the next task did not expect.
 */
export async function runSession(
  sessionId: string,
  deps: RunDeps & { continueOnFailure?: boolean },
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

  let transport: CopilotTransport | null = null;
  let ran = 0;
  let lastStatus: TaskOutcome['status'] | undefined;

  try {
    transport = await openSessionTransport(cfg, session, bus, sessionRunsDir);

    for (const queuedTask of queued) {
      if (deps.signal?.aborted) break;
      session = (await store.getSession(sessionId)) as Session;
      const task = session.tasks.find((t) => t.id === queuedTask.id);
      if (!task || task.status !== 'queued') continue;

      const outcome = await runTask(transport, session, task, deps);
      ran += 1;
      lastStatus = outcome.status;
      if (outcome.status !== 'done' && !deps.continueOnFailure) {
        bus.publish({ sessionId, type: 'session-stopped-early', level: 'warn',
          message: `task "${task.title}" ended ${outcome.status}; the remaining tasks stay queued` });
        break;
      }
    }
  } catch (e) {
    bus.publish({ sessionId, type: 'session-error', level: 'error', message: (e as Error).message });
    throw e;
  } finally {
    await transport?.close();
    await store.updateSession(sessionId, (s) => {
      s.status = 'idle';
    });
    bus.publish({ sessionId, type: 'session-finished', level: 'info', message: `${ran} task(s) ran` });
  }
  return { ran, lastStatus };
}
