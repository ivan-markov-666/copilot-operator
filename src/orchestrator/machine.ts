/**
 * The loop.
 *
 * One run owns one Copilot conversation. The opening messages set up the persona, the output
 * contract and the task; from then on every iteration is the same four moves: read the reply,
 * download what it attached, run what it asked for, send back the terminal output as a file.
 * It ends when Copilot says it is done, when a limit is reached, or when something breaks in
 * a way that would make continuing dishonest.
 */
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResolvedConfig } from '../config/schema.js';
import { CopilotTransport } from '../transport/copilotTransport.js';
import {
  buildChatName,
  makeRunId,
  savePointer,
  loadPointer,
  type ChatPointer,
} from '../transport/chatSession.js';
import { parseReply, formatErrorMessage, findLikelyDamage, damageGuidance } from '../protocol/parser.js';
import type { Step } from '../protocol/replySchema.js';
import { buildCoveringMessage, assertSendable } from '../protocol/reporter.js';
import { runStep, type RunResult } from '../exec/runner.js';
import { authorizeStep, describeStep } from '../exec/policy.js';
import { writeReport } from '../exec/reportFile.js';
import { Pacer } from '../util/pacing.js';
import { RunLog } from '../log/runLog.js';
import { mirrorProject, describeMirror } from '../context/projectMirror.js';
import { defaultExportDir, desktopIsSynced } from '../context/contextFiles.js';

export type RunOutcome = {
  runId: string;
  status: 'done' | 'limit-reached' | 'failed' | 'aborted';
  iterations: number;
  reason?: string;
  chat?: ChatPointer;
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

export async function runLoop(cfg: ResolvedConfig): Promise<RunOutcome> {
  const runId = makeRunId();
  const log = new RunLog(runId, cfg.resolved.runsDir);
  const pacer = new Pacer({
    enabled: cfg.pacing.enabled,
    settleMs: cfg.pacing.settleMs,
    maxMessagesPerHour: cfg.pacing.maxMessagesPerHour,
  });

  const artifactsDir = log.path('artifacts');
  const reportsDir = log.path('reports');
  const repliesDir = log.path('replies');
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(repliesDir, { recursive: true });

  /**
   * Keeps every reply exactly as it arrived, plus the on-screen version of its code blocks.
   *
   * Without this a defect in what the chat hands over is invisible: the transcript only
   * recorded how many characters came back, which is not enough to tell a mangled command
   * from one Copilot wrote badly.
   */
  let replySeq = 0;
  const saveReply = async (label: string, reply: { markdown: string; degraded: boolean; codeBlocksDom: string[] }): Promise<void> => {
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

  log.event('run-started', { runId, config: cfg.configPath, mode: cfg.execution.mode },
    `run ${runId} starting in ${cfg.execution.mode} mode`);

  const transport = new CopilotTransport({
    profileDir: cfg.resolved.profileDir,
    downloadsDir: join(artifactsDir, '_browser'),
    chatUrl: cfg.copilot.url,
    channel: cfg.copilot.channel,
    headless: cfg.copilot.headless,
    replyTimeoutMs: cfg.copilot.replyTimeoutSec * 1000,
    signInTimeoutMs: cfg.copilot.signInTimeoutSec * 1000,
    humanWaitMs: cfg.copilot.humanWaitSec * 1000,
    onEvent: (event, detail) => {
      // Most browser events belong only in the transcript. These four need a human to see
      // them while the run is waiting, so they are printed as well.
      const spoken: Record<string, string> = {
        'sign-in-required': 'The chat is asking you to sign in. Do it in the open Edge window; the run is waiting.',
        'verification-required':
          'The chat is showing a human-verification challenge. Complete it in the open Edge window. ' +
          'The bot will not touch it and is waiting for you.',
        'verification-cleared': 'Verification cleared, continuing.',
        'error-banner': 'The chat reported a transient error; reloading the page.',
      };
      log.event(`browser:${event}`, detail ?? {}, spoken[event], event === 'verification-required' ? 'warn' : 'info');
    },
  });

  const startedAt = Date.now();
  const deadline = startedAt + cfg.limits.maxRunMinutes * 60_000;
  let iterations = 0;
  let chat: ChatPointer | undefined;

  const finish = async (status: RunOutcome['status'], reason?: string): Promise<RunOutcome> => {
    log.event('run-finished', { status, reason, iterations },
      `run ${runId} ${status}${reason ? `: ${reason}` : ''}`);
    await transport.close();
    await log.close();
    return { runId, status, iterations, reason, chat };
  };

  try {
    // --- project mirror -------------------------------------------------------------
    let mirrorFiles: string[] = [];
    if (cfg.projectMirror.enabled) {
      const targetDir = cfg.resolved.mirrorTargetDir ?? defaultExportDir();
      const result = await mirrorProject({
        rootDir: cfg.resolved.mirrorRootDir as string,
        includeDirs: cfg.projectMirror.includeDirs,
        excludeDirs: cfg.projectMirror.excludeDirs,
        targetDir,
        separator: cfg.projectMirror.separator,
        txtMode: cfg.projectMirror.txtMode,
        respectGitignore: cfg.projectMirror.respectGitignore,
        ignoreDirs: cfg.projectMirror.ignoreDirs,
        includeEnvFiles: cfg.projectMirror.includeEnvFiles,
        maxFileBytes: cfg.projectMirror.maxFileBytes,
      });
      log.event('mirror', { targetDir, ...result }, `project mirror: ${describeMirror(result)}`);
      if (!desktopIsSynced()) {
        log.say('  note: the Desktop is not backed up by OneDrive, so the mirror stays local.');
      }
      const all = Object.values(result.mapping).sort();
      mirrorFiles = all.slice(0, cfg.projectMirror.maxAttachedFiles).map((n) => join(targetDir, n));
      if (all.length > mirrorFiles.length) {
        log.event('mirror-truncated', { total: all.length, attached: mirrorFiles.length },
          `only the first ${mirrorFiles.length} of ${all.length} mirrored files will be attached`,
          'warn');
      }
    }

    // --- browser and session --------------------------------------------------------
    await transport.open();
    await transport.ensureSignedIn();
    await transport.newChat();
    await pacer.settle();

    // --- opening messages -----------------------------------------------------------
    let lastMarkdown = '';
    let lastAttachments: string[] = [];

    for (const [index, message] of cfg.resolved.openingMessages.entries()) {
      const isFirst = index === 0;
      const attach =
        isFirst && cfg.projectMirror.enabled && cfg.projectMirror.attachToFirstMessage
          ? mirrorFiles
          : [];

      await pacer.throttleSend();
      const before = await transport.sendAndConfirm(message, attach);
      log.event('opening-message-sent', { index, chars: message.length, attached: attach.length },
        `opening message ${index + 1}/${cfg.resolved.openingMessages.length} sent`);

      const reply = await transport.waitForReply(before);
      lastMarkdown = reply.markdown;
      lastAttachments = reply.attachments;
      await saveReply(`opening-${index + 1}`, reply);
      log.event('opening-reply', { index, chars: reply.markdown.length, degraded: reply.degraded });
      await pacer.settle();

      if (isFirst) {
        const chatId = await transport.currentChatId();
        if (chatId) {
          const name = buildChatName(runId, cfg.copilot.label);
          await transport.nameChat(chatId, name).catch(() => false);
          chat = {
            chatId,
            url: `${cfg.copilot.url.replace(/\/chat.*$/, '')}/chat/conversation/${chatId}?es=SSR`,
            name,
            runId,
            createdAt: new Date().toISOString(),
          };
          await savePointer(log.path('chat.json'), chat);
          await savePointer(join(cfg.resolved.runsDir, 'last-chat.json'), chat);
          log.event('chat-registered', { ...chat }, `chat: ${name}`);
        }
      }
    }

    // --- the loop -------------------------------------------------------------------
    let formatRetries = 0;

    for (;;) {
      if (Date.now() > deadline) {
        return await finish('limit-reached', `maxRunMinutes (${cfg.limits.maxRunMinutes}) reached`);
      }
      if (iterations >= cfg.limits.maxIterations) {
        return await finish('limit-reached', `maxIterations (${cfg.limits.maxIterations}) reached`);
      }

      const parsed = parseReply(lastMarkdown, {
        stopMarker: cfg.copilot.stopMarker,
        defaultShell: cfg.execution.defaultShell,
      });

      if (!parsed.ok) {
        formatRetries += 1;
        log.event('format-error', { reason: parsed.reason, detail: parsed.detail },
          `reply did not match the contract (${parsed.reason}), retry ${formatRetries}/${cfg.limits.maxFormatRetries}`,
          'warn');
        if (formatRetries > cfg.limits.maxFormatRetries) {
          await transport.dumpFailure(log.path('failures'), 'format-error');
          return await finish('failed', `Copilot did not keep the output contract: ${parsed.detail}`);
        }
        await pacer.throttleSend();
        const before = await transport.sendAndConfirm(
          formatErrorMessage(parsed, formatRetries, cfg.limits.maxFormatRetries),
        );
        const again = await transport.waitForReply(before);
        await saveReply(`format-retry-${formatRetries}`, again);
        lastMarkdown = again.markdown;
        lastAttachments = again.attachments;
        continue;
      }

      formatRetries = 0;
      iterations += 1;
      const { reply, done } = parsed;
      log.event('reply-parsed', { iteration: iterations, status: reply.status, steps: reply.steps.length,
        notes: reply.notes }, `iteration ${iterations}: ${reply.steps.length} step(s)${reply.notes ? ` — ${reply.notes}` : ''}`);

      if (done && reply.steps.length === 0) {
        return await finish('done', reply.notes ?? 'Copilot reported the task as finished');
      }

      // --- execute -------------------------------------------------------------------
      const results: RunResult[] = [];
      let aborted = false;

      for (const step of reply.steps) {
        let scriptPath: string | undefined;

        if (step.type === 'download') {
          const target = join(artifactsDir, `${iterations}-${step.id}-${step.file}`);
          try {
            await transport.downloadAttachment(step.file, target);
            const hash = createHash('sha256').update(await readFile(target)).digest('hex');
            log.event('download', { file: step.file, path: target, sha256: hash },
              `downloaded ${step.file} (sha256 ${hash.slice(0, 12)}…)`);
            scriptPath = target;
          } catch (e) {
            results.push(refusedResult(step, `download failed: ${(e as Error).message}`));
            continue;
          }
          if (!step.run) {
            results.push({
              ...refusedResult(step, 'saved only, not executed (run was false)'),
              exitCode: 0,
              outcome: 'completed',
              stderr: '',
              stdout: `Saved to ${scriptPath}\n`,
            });
            continue;
          }
        }

        // A command whose type literal was eaten in transit is not a command Copilot wrote,
        // so running it would be running something nobody intended. Refuse and explain.
        if (step.type === 'command') {
          const damage = findLikelyDamage(step.cmd);
          if (damage) {
            log.event('step-damaged', { id: step.id, cmd: step.cmd, damage },
              `step ${step.id} arrived damaged: ${damage}`, 'warn');
            results.push(refusedResult(step, `${damage}. ${damageGuidance()}`));
            continue;
          }
        }

        const decision = await authorizeStep(step, {
          mode: cfg.execution.mode,
          denyPatterns: cfg.execution.denyPatterns,
          allowedScriptExtensions: cfg.execution.allowedScriptExtensions,
        }, { scriptPath, print: (s) => log.say(s) });

        if (decision.action === 'abort') {
          results.push(refusedResult(step, decision.reason));
          aborted = true;
          break;
        }
        if (decision.action === 'skip') {
          log.event('step-skipped', { id: step.id, reason: decision.reason },
            `step ${step.id} skipped: ${decision.reason}`, 'warn');
          results.push(refusedResult(step, decision.reason));
          continue;
        }

        const long = step.expect === 'long';
        const cap = cfg.execution.maxStepTimeoutSec;
        const hard = Math.min(step.timeoutSec ?? (long ? cfg.execution.longCommandTimeoutSec : cfg.execution.commandTimeoutSec), cap);
        const idle = Math.min(step.idleTimeoutSec ?? (long ? cfg.execution.longIdleTimeoutSec : cfg.execution.idleTimeoutSec), cap);

        log.say(`  running step ${step.id}: ${describeStep(step, scriptPath)}`);
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
            onHeartbeat: ({ elapsedMs, idleMs, lastLine }) =>
              log.say(
                `    step ${step.id} still running: ${Math.round(elapsedMs / 1000)}s elapsed, ` +
                  `${Math.round(idleMs / 1000)}s since output${lastLine ? ` — ${lastLine.slice(0, 60)}` : ''}`,
              ),
          },
        );

        results.push(result);
        log.event('step-finished', { id: step.id, outcome: result.outcome, exitCode: result.exitCode,
          durationMs: result.durationMs },
          `step ${step.id}: ${result.outcome}, exit ${result.exitCode}, ${(result.durationMs / 1000).toFixed(1)}s`);

        if (cfg.execution.stopOnFailure && result.exitCode !== 0) {
          log.event('stop-on-failure', { id: step.id }, 'stopping the iteration: stopOnFailure is set', 'warn');
          break;
        }
        await pacer.settle();
      }

      if (aborted) return await finish('aborted', 'the operator aborted the run');

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
      log.event('report-written', { iteration: iterations, files: report.names, bytes: report.bytes },
        `report: ${report.names.join(', ')} (${report.bytes < 1024 ? `${report.bytes} bytes` : `${(report.bytes / 1024).toFixed(1)} KB`})`);

      const covering = buildCoveringMessage({
        iteration: iterations,
        results,
        attachments: report.names,
        parts: report.parts,
      });
      assertSendable(covering, report.names);

      let sent = false;
      for (let attempt = 0; attempt <= cfg.report.uploadRetries && !sent; attempt += 1) {
        try {
          await pacer.throttleSend();
          const before = await transport.sendAndConfirm(covering, report.paths);
          const next = await transport.waitForReply(before);
          await saveReply(`iteration-${iterations}`, next);
          lastMarkdown = next.markdown;
          lastAttachments = next.attachments;
          sent = true;
        } catch (e) {
          log.event('report-send-failed', { attempt, error: String(e) },
            `sending the report failed (attempt ${attempt + 1}): ${(e as Error).message}`, 'warn');
          if (attempt === cfg.report.uploadRetries) {
            // Last resort: the output as text, clipped to the composer's limit.
            const body = await readFile(report.paths[0], 'utf8');
            const text = `${covering}\n\nThe upload failed, so here is the output as text, truncated:\n\n` +
              body.slice(0, cfg.limits.maxMessageChars - covering.length - 200);
            await pacer.throttleSend();
            const before = await transport.sendAndConfirm(text);
            const next = await transport.waitForReply(before);
            lastMarkdown = next.markdown;
            lastAttachments = next.attachments;
            sent = true;
          } else {
            await new Promise((r) => setTimeout(r, pacer.backoffFor(attempt)));
          }
        }
      }

      if (done) {
        return await finish('done', reply.notes ?? 'Copilot reported the task as finished');
      }
      void lastAttachments;
      await pacer.settle();
    }
  } catch (e) {
    const message = (e as Error).message;
    log.event('run-error', { error: message, stack: (e as Error).stack }, message, 'error');
    await transport.dumpFailure(log.path('failures'), 'crash').catch(() => undefined);
    return await finish('failed', message);
  }
}

/** Reopens the chat of a previous run, for `cop resume` and for manual inspection. */
export async function reopenLastChat(cfg: ResolvedConfig): Promise<ChatPointer | null> {
  return await loadPointer(join(cfg.resolved.runsDir, 'last-chat.json'));
}
