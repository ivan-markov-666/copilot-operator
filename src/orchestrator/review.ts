/**
 * The second opinion: a fresh conversation that checks the work by running it.
 *
 * A task that has finished and passed its checks has cleared two bars, and both of them were
 * set by somebody who already knew what they were looking for. The checks test the claims the
 * operator thought to write down; the implementer's own verification tests the claims the
 * implementer thought to make. Neither catches the defect nobody anticipated — and the shape
 * of that defect is always the same: a gap between what was made and what it promises.
 *
 * So the work goes to a conversation that had no part in it. It is given the task, the project
 * instructions and the list of files that changed, and nothing else. In particular it is not
 * given the implementer's summary, because the summary is an account of what somebody believes
 * they did, and a reviewer reading it starts by trusting the very thing under review.
 *
 * It is not a second brain. The same model has the same blind spots in either conversation,
 * which is why the reviewer can be put on a different model, and why the contract is built
 * around forcing execution rather than inviting an opinion: a review that ran nothing cannot
 * pass, whatever it writes. What independence buys is the absence of attachment — the reviewer
 * has no idea what the work was meant to be, only what it is.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config/schema.js';
import { CopilotTransport } from '../transport/copilotTransport.js';
import { parseReview, formatErrorMessage, findLikelyDamage, damageGuidance } from '../protocol/parser.js';
import { describeFindings, type ReviewFinding } from '../protocol/reviewSchema.js';
import type { Deviation } from '../protocol/replySchema.js';
import { runStep, type RunResult } from '../exec/runner.js';
import { describeStep } from '../exec/policy.js';
import type { StepAuthorizer } from '../exec/authorizer.js';
import { writeReport } from '../exec/reportFile.js';
import { buildCoveringMessage, assertSendable } from '../protocol/reporter.js';
import { Pacer } from '../util/pacing.js';
import type { Session, Task } from '../session/model.js';

/** How a review ended. `error` is the review itself failing, which is not the work's fault. */
export type ReviewOutcome = {
  verdict: 'pass' | 'fail' | 'error';
  summary?: string;
  findings: ReviewFinding[];
  /** How many commands the reviewer actually ran. A pass with 0 is refused. */
  stepsRun: number;
  iterations: number;
  /** Set when the review could not be carried out at all. */
  problem?: string;
  chatUrl?: string;
};

export type ReviewDeps = {
  cfg: ResolvedConfig;
  authorizer: StepAuthorizer;
  signal?: AbortSignal;
  pacer: Pacer;
  /** Where this review's reports and replies go. Already inside the task's run folder. */
  dir: string;
  /** Which round this is, from 1. */
  round: number;
  /** Where the reviewer's commands run: the session's project, the same as the implementer's. */
  cwd: string;
  /** The files the task changed, as version control recorded them. */
  changedFiles: string[];
  /** Instructions the implementer says it could not follow as written. Claims, not facts. */
  deviations: Deviation[];
  /** What the round before this one found, when there was one. */
  previous?: PreviousRound;
  event: (type: string, data?: Record<string, unknown>, human?: string, level?: 'info' | 'warn' | 'error') => void;
  record: (heading: string, body: string) => Promise<void>;
};

/** The findings of the round before this one, as they were sent back to the implementer. */
export type PreviousRound = { round: number; findings: Array<ReviewFinding & { repeated?: boolean }> };

/**
 * What the reviewer is told about the work.
 *
 * Everything here is either the instruction the implementer was given or an observable fact
 * about the repository — with one deliberate exception. The implementer's declared deviations
 * are its own account, and they are passed on anyway, framed as claims to test rather than
 * facts to rely on: "this instruction cannot be followed on this machine" is falsifiable by
 * running things, and it is exactly the input the `about: task` verdict was missing. In the
 * run that motivated this the reviewer wrote in its own evidence that the build rewrites the
 * required value, and still filed the finding as the work's fault, twice.
 *
 * The previous round's findings are process facts, not the implementer's account: what another
 * reviewer found, and that a fix was reported. The new reviewer is asked to verify them afresh
 * and, if one is still there, to decide whose problem it is instead of raising it a third time.
 */
export function reviewBrief(
  session: Session,
  task: Task,
  changedFiles: string[],
  cwd: string,
  deviations: Deviation[] = [],
  previous?: PreviousRound,
): string {
  const repo = session.vcs?.enabled ? session.vcs.repoDir?.trim() : '';
  const files = changedFiles.length > 0 ? changedFiles.map((f) => `- ${f}`).join('\n') : '(version control recorded no file changes for this task)';

  return [
    '## The task that was given',
    '',
    task.prompt.trim(),
    '',
    '## The project instructions that applied',
    '',
    task.level2.trim() || '(none)',
    '',
    '## Where to look',
    '',
    `Working directory for your commands: ${cwd}`,
    repo ? `Repository: ${repo}` : 'There is no repository for this work.',
    '',
    'Files this task changed:',
    files,
    ...(deviations.length > 0
      ? [
          '',
          '## What the implementer says could not be done as written',
          '',
          'The implementer declared that these instructions could not be followed literally, and says',
          'what it did instead. These are claims, not facts, and you are given them for one reason: to',
          'test them. For each, establish whether the instruction really cannot be satisfied on this',
          'machine, with these tools, inside the project instructions. If it cannot, the task asks for',
          'something impossible and that is a finding with `"about": "task"`. If it can, the work',
          'deviated for no good reason and that is a finding with `"about": "work"`. Do not take the',
          "implementer's word either way; the work is still judged against the task as written.",
          '',
          deviations
            .map((d, i) => `${i + 1}. Instruction: ${d.instruction}\n   Did instead: ${d.did}\n   Claimed reason: ${d.why}`)
            .join('\n\n'),
        ]
      : []),
    ...(previous
      ? [
          '',
          `## What review round ${previous.round} found`,
          '',
          'A previous reviewer, in another conversation, failed this work with the findings below. They',
          'were sent to the implementer, which reports having fixed them, and the checks passed again.',
          'You are not bound by that verdict: verify each one afresh, by running things. If one is still',
          'there, do not simply raise it again. Decide, and say in `about`, whether fixing the work can',
          'resolve it at all — a finding that survives a reported fix is often one the task itself made',
          'unsatisfiable: an instruction a tool overwrites, a setting a version removed.',
          '',
          previous.findings
            .map(
              (f, i) =>
                `${i + 1}. ${f.what}${f.where ? ` (${f.where})` : ''}${f.repeated ? ' — raised in more than one round already' : ''}`,
            )
            .join('\n'),
        ]
      : []),
    '',
    '## Your job',
    '',
    'Decide whether the work does what the task asked, by running it. Start now: your next',
    'reply should be steps, not a verdict. Remember that a verdict of "pass" is refused if you',
    'have run nothing, and that anything the work tells a human to run is a claim you must test',
    'by running exactly that.',
  ].join('\n');
}

/**
 * Runs one review to a verdict, in the conversation the transport is currently in.
 *
 * The caller owns the conversation: it opens a fresh one before calling this and returns to
 * the implementer's afterwards. That split is deliberate — moving between conversations is the
 * part that can fail in ways only the caller can recover from, and it should not be buried
 * inside the loop that reads verdicts.
 */
export async function runReview(
  transport: CopilotTransport,
  session: Session,
  task: Task,
  deps: ReviewDeps,
): Promise<ReviewOutcome> {
  const { cfg, authorizer, signal, pacer, dir, round } = deps;
  await mkdir(dir, { recursive: true });

  const contract = await readFile(join(process.cwd(), 'prompts', 'review1.md'), 'utf8').catch(() => '');
  if (!contract.trim()) {
    return { verdict: 'error', findings: [], stepsRun: 0, iterations: 0, problem: 'the reviewer contract (prompts/review1.md) could not be read' };
  }

  let stepsRun = 0;
  let iterations = 0;
  let formatRetries = 0;

  const saveReply = async (label: string, markdown: string): Promise<void> => {
    await writeFile(join(dir, `${label}.md`), markdown, 'utf8').catch(() => undefined);
  };

  try {
    // The contract first, on its own, exactly as a session does it: the handshake reply is not
    // parsed, it only proves the conversation is alive and listening.
    await pacer.throttleSend();
    let before = await transport.sendAndConfirm(contract);
    await transport.waitForReply(before);

    await pacer.throttleSend();
    before = await transport.sendAndConfirm(reviewBrief(session, task, deps.changedFiles, deps.cwd, deps.deviations, deps.previous));
    let markdown = (await transport.waitForReply(before)).markdown;
    await saveReply('00-opening', markdown);

    for (;;) {
      if (signal?.aborted) return { verdict: 'error', findings: [], stepsRun, iterations, problem: 'the run was stopped' };
      if (iterations >= cfg.limits.maxReviewIterations) {
        return {
          verdict: 'error',
          findings: [],
          stepsRun,
          iterations,
          problem: `the review used its ${cfg.limits.maxReviewIterations} iterations without reaching a verdict`,
        };
      }

      const parsed = parseReview(markdown, { defaultShell: cfg.execution.defaultShell });
      if (!parsed.ok) {
        formatRetries += 1;
        deps.event('review-format-error', { round, reason: parsed.reason, detail: parsed.detail },
          `the reviewer's reply did not match its contract (${parsed.reason}), retry ${formatRetries}/${cfg.limits.maxFormatRetries}`, 'warn');
        if (formatRetries > cfg.limits.maxFormatRetries) {
          return { verdict: 'error', findings: [], stepsRun, iterations, problem: `the reviewer would not keep its output contract: ${parsed.detail}` };
        }
        await pacer.throttleSend();
        const b = await transport.sendAndConfirm(formatErrorMessage(parsed, formatRetries, cfg.limits.maxFormatRetries));
        markdown = (await transport.waitForReply(b)).markdown;
        continue;
      }

      formatRetries = 0;
      iterations += 1;
      const { review, verdict } = parsed;
      deps.event('review-parsed', { round, iteration: iterations, verdict, steps: review.steps.length, notes: review.notes },
        `review ${round}, iteration ${iterations}: ${verdict}${review.steps.length > 0 ? `, ${review.steps.length} step(s)` : ''}${review.notes ? ` — ${review.notes}` : ''}`);

      if (verdict !== 'continue') {
        /*
         * The rule a schema cannot express.
         *
         * "Pass" from a reviewer that never ran anything is the exact failure this whole
         * mechanism exists to prevent, and it is mechanically detectable: the runner knows how
         * many commands it executed in this conversation. So it is sent back once, in as many
         * words. A "fail" is allowed to stand without steps — refusing to review something is
         * itself a finding, and the contract requires evidence for it either way.
         */
        if (verdict === 'pass' && stepsRun === 0) {
          deps.event('review-passed-nothing-run', { round }, 'the reviewer passed the work without running anything; sending it back', 'warn');
          await pacer.throttleSend();
          const b = await transport.sendAndConfirm(
            'You reached a verdict of "pass" without running a single command in this review. ' +
              'That is refused: reading tells you what a file contains, not whether the work does what the task ' +
              'asked. Run it — build it, start it, call it, and run anything the work tells a human to run — ' +
              'then give a verdict based on what came back.',
          );
          markdown = (await transport.waitForReply(b)).markdown;
          continue;
        }

        await deps.record(
          `REVIEW ${round}: ${verdict.toUpperCase()}`,
          [review.summary ?? '', review.findings.length > 0 ? describeFindings(review.findings) : ''].filter(Boolean).join('\n\n'),
        );
        return {
          verdict,
          summary: review.summary,
          findings: review.findings,
          stepsRun,
          iterations,
          chatUrl: (await transport.currentChatId().catch(() => null)) ?? undefined,
        };
      }

      // --- run what the reviewer asked for ------------------------------------------------
      const results: RunResult[] = [];
      for (const step of review.steps) {
        if (signal?.aborted) break;
        if (step.type !== 'command') {
          results.push(refused(step.id, 'a review runs commands only; it does not download or execute files'));
          continue;
        }

        const damage = findLikelyDamage(step.cmd);
        if (damage) {
          results.push(refused(step.id, `${damage}. ${damageGuidance()}`, step.cmd));
          continue;
        }

        deps.event('review-step-proposed', { round, id: step.id, description: describeStep(step) }, `review step ${step.id}: ${describeStep(step)}`);
        const decision = await authorizer.authorize(step, { sessionId: session.id, taskId: task.id, iteration: iterations });
        if (decision.action !== 'run') {
          results.push(refused(step.id, decision.reason, step.cmd));
          if (decision.action === 'abort') break;
          continue;
        }

        const long = step.expect === 'long';
        const cap = cfg.execution.maxStepTimeoutSec;
        const hard = Math.min(step.timeoutSec ?? (long ? cfg.execution.longCommandTimeoutSec : cfg.execution.commandTimeoutSec), cap);
        const idle = Math.min(step.idleTimeoutSec ?? (long ? cfg.execution.longIdleTimeoutSec : cfg.execution.idleTimeoutSec), cap);

        const result = await runStep(
          {
            id: step.id,
            shell: (step.shell ?? cfg.execution.defaultShell) as RunResult['shell'],
            command: step.cmd,
            cwd: deps.cwd,
            hardTimeoutMs: hard * 1000,
            idleTimeoutMs: idle * 1000,
            logPath: join(dir, 'steps', `${iterations}-${step.id}.log`),
          },
          { signal },
        );
        stepsRun += 1;
        results.push(result);
        deps.event('review-step-finished', { round, id: step.id, outcome: result.outcome, exitCode: result.exitCode },
          `review step ${step.id}: ${result.outcome}, exit ${result.exitCode}, ${(result.durationMs / 1000).toFixed(1)}s`);
        await pacer.settle();
      }

      const report = await writeReport(results, {
        runId: `review-${round}`,
        task: `review of "${task.title}"`,
        iteration: iterations,
        dir,
        fileNameTemplate: cfg.report.fileName,
        maxReportBytes: cfg.report.maxReportBytes,
        maxOutputChars: cfg.report.maxOutputChars,
        redactPatterns: cfg.report.redactPatterns,
      });
      await deps.record(`REVIEW ${round}, ITERATION ${iterations}`, await readFile(report.paths[0], 'utf8'));
      if (report.redactions.length > 0) {
        deps.event('report-redacted', { round, iteration: iterations, redactions: report.redactions },
          `redacted before upload: ${report.redactions.map((r) => `${r.count}× ${r.name}`).join(', ')}`, 'warn');
      }

      const covering = buildCoveringMessage({
        task: `review of "${task.title}"`,
        iteration: iterations,
        results,
        attachments: report.names,
        parts: report.parts,
      });
      assertSendable(covering, report.names);
      await pacer.throttleSend();
      const b = await transport.sendAndConfirm(covering, report.paths);
      markdown = (await transport.waitForReply(b)).markdown;
      await saveReply(`${String(iterations).padStart(2, '0')}-review`, markdown);
      await pacer.settle();
    }
  } catch (e) {
    return { verdict: 'error', findings: [], stepsRun, iterations, problem: (e as Error).message };
  }
}

/** A step the review did not run, in the shape the reporter expects. */
function refused(id: number, reason: string, command = '(not run)'): RunResult {
  return {
    id,
    shell: 'pwsh',
    command,
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

/**
 * The message that carries a review's findings back to the conversation that did the work.
 *
 * `repeated` are the findings an earlier round already raised. They get a paragraph of their
 * own, because fixing the same thing the same way a second time is the loop this exists to
 * break: the implementer is asked to decide whether the fix did not hold or the instruction
 * cannot be kept, and to declare the second case in `deviations`, where it reaches the reviewer
 * and the person who wrote the task.
 */
export function findingsMessage(outcome: ReviewOutcome, round: number, maxRounds: number, repeated: ReviewFinding[] = []): string {
  return [
    `An independent review of your work found ${outcome.findings.length} problem(s). The reviewer is a`,
    'separate conversation that was given the task and the files you changed, ran the work itself, and',
    'did not see your summary.',
    '',
    outcome.summary ? `What it checked: ${outcome.summary}` : '',
    '',
    describeFindings(outcome.findings, (f) => repeated.includes(f)),
    '',
    ...(repeated.length > 0
      ? [
          `${repeated.length} of these ${repeated.length === 1 ? 'was' : 'were'} raised in the previous round as well: you reported a fix,`,
          'and a fresh reviewer found the same thing at the same place. Before fixing it the same way again,',
          'decide which of two things is true. Either the fix did not hold — then fix it differently, and show',
          'in the summary what you ran that proves it holds after the exact verification the task requires.',
          'Or the instruction cannot be satisfied as written — a tool rewrites the file, a version removed the',
          'option — then say so in `deviations`: the instruction, what you did instead, and why. That is the',
          'honest answer, and it is the only one that reaches the person who wrote the task.',
          '',
        ]
      : []),
    `Fix these, then verify as usual and close the task again. This is review round ${round} of ${maxRounds};`,
    'after that the task is closed as blocked with whatever is still outstanding.',
    '',
    'If you believe a finding is wrong, say so in your summary with the evidence that shows it —',
    'do not change the thing the reviewer looked at in order to make the objection go away.',
  ].join('\n');
}
