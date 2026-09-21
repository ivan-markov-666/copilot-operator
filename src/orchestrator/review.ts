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
import { describeFindings, findingId, isGrounded, type ReviewFinding } from '../protocol/reviewSchema.js';
import type { Deviation, Dispute } from '../protocol/replySchema.js';
import { runStep, type RunResult } from '../exec/runner.js';
import { describeStep, commandRefusal } from '../exec/policy.js';
import { validateDerivedChecks } from './derivedChecks.js';
import type { StepAuthorizer } from '../exec/authorizer.js';
import { writeReport } from '../exec/reportFile.js';
import { buildCoveringMessage, assertSendable } from '../protocol/reporter.js';
import { Pacer } from '../util/pacing.js';
import type { Session, Task, TaskCheck } from '../session/model.js';

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
  /** Checks the reviewer gave with its findings and that fail on the work as it stands. */
  derivedChecks?: Array<{ findingId: string; check: TaskCheck; what: string; where?: string }>;
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
  /** The closing account, given only when it is the product. See `Deliverable`. */
  deliverable?: Deliverable;
  /** Instructions the implementer says it could not follow as written. Claims, not facts. */
  deviations: Deviation[];
  /** Findings from earlier rounds the implementer says are wrong, by id. Claims, not facts. */
  disputes: Dispute[];
  /** What the round before this one found, when there was one. */
  previous?: PreviousRound;
  /** The repository, for checks that look at it. */
  repoDir?: string;
  /**
   * Earlier tasks of the same session, when they build on each other. What they defined is
   * what this task rests on: a smoke test's labels were named by the page task before it.
   */
  earlier?: Array<{ title: string; prompt: string }>;
  /**
   * Checks from earlier reviews that still fail after the implementer's rounds ran out. The
   * reviewer decides whether the defect is real; a counter does not.
   */
  derivedFailing?: Array<{ name: string; detail: string }>;
  /**
   * Called once the reviewer has a verdict, before its findings are judged. The runner uses
   * it to stop what the review's own steps left running: a reviewer that left its server on
   * the port and then found the port busy gave a check that "failed on the defective state",
   * and the defect was its own.
   */
  beforeVerdict?: () => Promise<void>;
  event: (type: string, data?: Record<string, unknown>, human?: string, level?: 'info' | 'warn' | 'error') => void;
  record: (heading: string, body: string) => Promise<void>;
};

/** A process a review's own steps left running, stopped by the runner. */
export type ReviewLeftover = { name: string; ports: number[] };

/** The findings of the round before this one, as they were sent back to the implementer. */
export type PreviousRound = {
  round: number;
  findings: Array<ReviewFinding & { id?: string; repeated?: boolean }>;
  /** What that reviewer left running. A finding about one of those ports was its own doing. */
  leftovers?: ReviewLeftover[];
};

/** The sentence both sides get when a review left something listening. */
function leftoverNote(leftovers: ReviewLeftover[]): string {
  const listening = leftovers.filter((l) => l.ports.length > 0);
  if (listening.length === 0) return '';
  return (
    `After this review the runner stopped ${listening.length} process(es) the reviewer's own steps had left running: ` +
    listening.map((l) => `${l.name} listening on ${l.ports.join(', ')}`).join('; ') +
    '. A finding about one of those ports is the reviewer\'s own doing, not the work\'s.'
  );
}

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
/**
 * The closing summary, handed to the reviewer as the thing under review.
 *
 * The reviewer is kept blind to the implementer's account on purpose (see the top of this
 * file). That holds when the work is in files: the files are the product and the account is
 * somebody's belief about them. It breaks for a task whose product *is* the account — an
 * audit, a report, a smoke test that changes nothing — because then the reviewer is shown a
 * task, told nothing changed, and left with nothing to judge. On 2026-09-20 a repository audit
 * lost its first review round exactly so: "the required audit summary was not delivered", when
 * the summary was the deliverable and the reviewer had not been given it.
 *
 * So the account travels only when the runner *knows* there is nothing else: version control
 * recorded no change, or the task was declared read-only. A session without version control
 * cannot know, and stays blind. And it travels labelled as what it is — the product, a set of
 * claims to test by running what they say — not as a description to trust.
 */
export type Deliverable = {
  summary: string;
  why: 'no-files-changed' | 'read-only';
};

/** True when the closing account is the product, so the reviewer must be given it. */
export function deliverableFor(
  task: Pick<Task, 'readOnly'>,
  summary: string | undefined,
  tracked: boolean,
  changedFiles: string[],
): Deliverable | undefined {
  const text = (summary ?? '').trim();
  if (!text) return undefined;
  if (task.readOnly) return { summary: text, why: 'read-only' };
  if (tracked && changedFiles.length === 0) return { summary: text, why: 'no-files-changed' };
  return undefined;
}

export function reviewBrief(
  session: Session,
  task: Task,
  changedFiles: string[],
  cwd: string,
  deviations: Deviation[] = [],
  previous?: PreviousRound,
  disputes: Dispute[] = [],
  derivedFailing: Array<{ name: string; detail: string }> = [],
  earlier: Array<{ title: string; prompt: string }> = [],
  deliverable?: Deliverable,
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
    ...(earlier.length > 0
      ? [
          '',
          '## Earlier tasks of this session, for context',
          '',
          'This task builds on the ones below, in the same working tree. They were reviewed already and',
          'are not yours to judge again; they are here because what they defined is what this task rests',
          'on — a label, a port, a route named there is the expectation here. A finding may quote them.',
          '',
          ...earlier.map((e) => `### Earlier task: ${e.title}\n\n${e.prompt.trim()}`),
        ]
      : []),
    '',
    '## Where to look',
    '',
    `Working directory for your commands: ${cwd}`,
    repo ? `Repository: ${repo}` : 'There is no repository for this work.',
    '',
    'Files this task changed:',
    files,
    ...(deliverable
      ? [
          '',
          '## What the implementer delivered',
          '',
          deliverable.why === 'read-only'
            ? 'This task was declared read-only: its product is not a change to files but the account below,'
            : 'This task changed no files (version control recorded none), so its product is the account below,',
          ...(deliverable.why === 'read-only'
            ? [
                '',
                '**Do not give a `check` with a finding about this task.** A check is a command run against the',
                'repository, and this task may not change the repository: whatever the command reports is settled',
                'before the task starts, so no correction it is allowed to make can alter it. A check that instead',
                'freezes a copy of the account below inside itself tests a string you pasted, not the work. Your',
                'findings and your verdict are the whole of your leverage here, and they are enough: the work goes',
                'back with them, and the next review rules on what came back.',
              ]
            : []),
          'written by the conversation that did the work when it closed. You are given it because it is the',
          'thing under review, not because it is to be believed: every statement in it is a claim, and you',
          'test a claim by running what it says and comparing. What the task asked for and the account does',
          'not deliver is a finding; what the account states and the machine contradicts is a finding.',
          '',
          deliverable.summary,
        ]
      : []),
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
                `${i + 1}. ${f.id ? `[${f.id}] ` : ''}${f.what}${f.where ? ` (${f.where})` : ''}${f.repeated ? ' — raised in more than one round already' : ''}`,
            )
            .join('\n'),
          ...(previous.leftovers && leftoverNote(previous.leftovers)
            ? ['', leftoverNote(previous.leftovers).replace('After this review', `After round ${previous.round}`), 'Stop what you start, in the same step, and check the port only after that.']
            : []),
        ]
      : []),
    ...(disputes.length > 0
      ? [
          '',
          '## Findings the implementer disputes',
          '',
          'The implementer says these findings from an earlier round are wrong, and gives its evidence. They',
          'are claims; test them. If a dispute holds, the earlier reviewer was wrong — do not raise that',
          'finding again, and say in your summary what you ran that settles it. If it does not hold, raise',
          "the finding with `\"about\": \"work\"` and say why the implementer's evidence does not show what it",
          'claims. Either way the work is judged against the task as written.',
          '',
          disputes.map((d, i) => `${i + 1}. Finding ${d.finding}: ${d.why}\n   Implementer's evidence: ${d.evidence}`).join('\n\n'),
        ]
      : []),
    ...(derivedFailing.length > 0
      ? [
          '',
          '## Checks from earlier reviews that still fail',
          '',
          'Earlier reviewers gave these checks with their findings, and the implementer has had its rounds:',
          'they still fail. You decide, not a counter. If the defect is real, fail the work with that',
          'finding. If the check is wrong — it tests something the task never asked for, or tests it',
          'badly — judge the work on what you find and say so in your summary; a check you do not',
          'confirm is dropped.',
          '',
          derivedFailing.map((d, i) => `${i + 1}. ${d.name}\n   Last result: ${d.detail}`).join('\n\n'),
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
  /** A check that passes on the defective state is sent back once; after that it is dropped. */
  let derivedRetried = false;
  /** A finding whose basis is not in the task is sent back once; after that it is dropped. */
  let groundingRetried = false;
  /** What a finding may quote: this task, its instructions, and the earlier tasks it was shown. */
  const groundingSources = [task.prompt, task.level2, ...(deps.earlier ?? []).map((e) => e.prompt)];

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
    // The brief is saved as sent. Until it was, whether a later round had been told what the
    // earlier one found could not be checked from the run folder at all.
    const brief = reviewBrief(session, task, deps.changedFiles, deps.cwd, deps.deviations, deps.previous, deps.disputes, deps.derivedFailing, deps.earlier, deps.deliverable);
    await saveReply('00-brief', brief);
    await deps.record(`REVIEW ${round} BRIEF`, brief);
    before = await transport.sendAndConfirm(brief);
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

        /*
         * A finding's check is only worth keeping if it fails on the work as it stands.
         *
         * The reviewer says "this is the test that would have caught it"; the runner runs it
         * now, on the defective state. One that passes captures something else — or nothing —
         * and is sent back once with the result, then dropped. What survives is kept with the
         * task for every attempt after this one.
         */
        // Whatever the review's own steps left running goes first, so that a check given
        // with a finding is judged against the work and not against the reviewer's leftovers.
        await deps.beforeVerdict?.();

        /*
         * A finding has to rest on a sentence somebody wrote.
         *
         * Two reviewers in a row failed a page for label text no task had specified. The basis
         * is checked against what the reviewer was given: not there, and the finding is sent
         * back once for the quote; still not there, and it is dropped as an invented
         * requirement. A review left with nothing grounded has not reviewed anything.
         */
        const ungrounded = review.findings.filter((f) => !isGrounded(f.basis, groundingSources));
        if (ungrounded.length > 0 && !groundingRetried) {
          groundingRetried = true;
          deps.event('review-finding-ungrounded', { round, count: ungrounded.length },
            `${ungrounded.length} finding(s) rest on a sentence that is not in the task; sent back once for the quote`, 'warn');
          await pacer.throttleSend();
          const b = await transport.sendAndConfirm(ungroundedMessage(ungrounded));
          markdown = (await transport.waitForReply(b)).markdown;
          continue;
        }
        const grounded = review.findings.filter((f) => isGrounded(f.basis, groundingSources));
        for (const f of ungrounded) {
          deps.event('review-finding-dropped', { round, what: f.what.slice(0, 120) },
            `dropped as an invented requirement — its basis is not in the task: ${f.what.slice(0, 120)}`, 'warn');
        }
        if (verdict === 'fail' && grounded.length === 0) {
          return {
            verdict: 'error',
            findings: [],
            stepsRun,
            iterations,
            problem: `every finding of round ${round} rested on something the task never asked for, twice; the review is inconclusive`,
          };
        }

        const named = grounded.map((f, i) => ({ ...f, id: findingId(round, i) }));

        /*
         * A read-only task's findings never become gate conditions.
         *
         * A derived check is a command run against the repository, and a read-only task is
         * forbidden to change the repository: whatever such a check reports is fixed before
         * the task starts, so it cannot be satisfied by anything the task is allowed to do.
         * Observed: a reviewer of a smoke test found the delivered testid inventory
         * incomplete — it was — and gave a check that froze the delivered list inside a
         * PowerShell array and compared it with the file. The implementer then delivered the
         * complete inventory, which is exactly what was asked, and the check went on failing,
         * because the list it compares against is a copy of an old summary. Three attempts,
         * two of them in fresh conversations, ended blocked on a condition no action could
         * meet, and the implementer said so with the exact evidence.
         *
         * The reviewer's judgement is not weakened by this: the finding still travels, the
         * verdict still fails the work, and the next reviewer still rules on it. What it may
         * not do is put a condition into a gate that the task has no lever to move.
         */
        if (task.readOnly && named.some((f) => f.check)) {
          deps.event(
            'review-check-not-kept-readonly',
            { round, findings: named.filter((f) => f.check).map((f) => f.id) },
            'this task may not change files, so a check given with a finding could never be satisfied by it; the findings stand, the checks are not kept',
            'warn',
          );
        }
        if (task.readOnly) {
          await deps.record(
            `REVIEW ${round}: ${verdict.toUpperCase()}`,
            [review.summary ?? '', named.length > 0 ? describeFindings(named) : ''].filter(Boolean).join('\n\n'),
          );
          return {
            verdict,
            summary: review.summary,
            findings: named,
            stepsRun,
            iterations,
            chatUrl: (await transport.currentChatId().catch(() => null)) ?? undefined,
          };
        }

        const validation = await validateDerivedChecks(named, {
          cwd: deps.cwd,
          logDir: dir,
          repoDir: deps.repoDir,
          deny: (command, shell) => commandRefusal(command, shell, cfg.execution.denyPatterns),
          signal,
        });
        if (validation.refused.length > 0 && !derivedRetried) {
          derivedRetried = true;
          deps.event('review-check-refused', { round, refused: validation.refused.map((r) => r.finding.id) },
            `${validation.refused.length} check(s) given with findings pass on the work as it is, so they do not capture the defect; sent back once`, 'warn');
          await pacer.throttleSend();
          const b = await transport.sendAndConfirm(refusedChecksMessage(validation.refused.map((r) => ({ id: r.finding.id, detail: r.outcome.detail }))));
          markdown = (await transport.waitForReply(b)).markdown;
          continue;
        }
        for (const r of validation.refused) {
          deps.event('review-check-dropped', { round, finding: r.finding.id }, `the check given with ${r.finding.id} still passes on the defective state; dropped`, 'warn');
        }
        for (const k of validation.kept) {
          deps.event('review-check-kept', { round, finding: k.finding.id, name: k.check.name }, `kept with the task: "${k.check.name}" (from ${k.finding.id})`);
        }

        await deps.record(
          `REVIEW ${round}: ${verdict.toUpperCase()}`,
          [review.summary ?? '', named.length > 0 ? describeFindings(named) : ''].filter(Boolean).join('\n\n'),
        );
        return {
          verdict,
          summary: review.summary,
          findings: named,
          stepsRun,
          iterations,
          chatUrl: (await transport.currentChatId().catch(() => null)) ?? undefined,
          derivedChecks: validation.kept.map((k) => ({ findingId: k.finding.id, check: k.check, what: k.finding.what, where: k.finding.where })),
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

/** Sent once when a finding's basis is not a quote from what the reviewer was given. */
export function ungroundedMessage(findings: ReviewFinding[]): string {
  return [
    `${findings.length === 1 ? 'One of your findings rests' : `${findings.length} of your findings rest`} on a sentence that is not in the task, its project`,
    'instructions, or the earlier tasks you were shown:',
    '',
    findings.map((f) => `- "${f.basis}" — for: ${f.what}`).join('\n'),
    '',
    'A finding must quote the sentence that asks for the thing it says is missing. Quote it exactly, from the',
    'text you were given; if there is no such sentence, the task never asked for it and it is not a finding.',
    'Reply with the same verdict and findings, corrected. This is asked once; a finding still without a basis',
    'in the task is dropped.',
  ].join('\n');
}

/** Sent once when a finding's check passes on the work it is supposed to fail on. */
export function refusedChecksMessage(refused: Array<{ id: string; detail: string }>): string {
  return [
    `The check you gave with ${refused.length === 1 ? 'finding' : 'findings'} ${refused.map((r) => `[${r.id}]`).join(', ')} was run on the work exactly as it is now, and it passed:`,
    '',
    refused.map((r) => `- [${r.id}]: ${r.detail}`).join('\n'),
    '',
    'A check that passes on the defective state does not capture the defect you describe. Give one that',
    'fails now and would pass once the finding is fixed, or leave `check` out of that finding. Reply with the',
    'same verdict and the same findings, corrected. This is asked once; a check that still passes is dropped.',
  ].join('\n');
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
export function findingsMessage(
  outcome: ReviewOutcome,
  round: number,
  maxRounds: number,
  repeated: ReviewFinding[] = [],
  leftovers: ReviewLeftover[] = [],
): string {
  const note = leftoverNote(leftovers);
  return [
    `An independent review of your work found ${outcome.findings.length} problem(s). The reviewer is a`,
    'separate conversation that was given the task and the files you changed, ran the work itself, and',
    'did not see your summary.',
    '',
    outcome.summary ? `What it checked: ${outcome.summary}` : '',
    '',
    describeFindings(outcome.findings, (f) => repeated.includes(f)),
    '',
    ...(note ? [`${note} If that is what a finding is about, dispute it with the evidence from your own step.`, ''] : []),
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
    'If you believe a finding is wrong, say so in `disputed`: its id (the `[r1f2]` in front of it), why it',
    'is wrong, and the evidence that shows it — the command you ran and what came back. A dispute goes to',
    'the next reviewer as a claim to test; a sentence in your summary goes nowhere. Do not change the',
    'thing the reviewer looked at in order to make the objection go away.',
  ].join('\n');
}
