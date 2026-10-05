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
import { join, resolve } from 'node:path';

import type { ResolvedConfig } from '../config/schema.js';
import type { ModelChoice, ModelLocator, ModelOption, ReplyCapture } from '../transport/copilotTransport.js';
import { createTransport, isReplyTimeout, type ChatTransport } from '../transport/chatTransport.js';
import { buildChatName, chatCode, loadPointer, savePointer, type ChatPointer } from '../transport/chatSession.js';
import { parseReply, formatErrorMessage, findLikelyDamage, damageGuidance } from '../protocol/parser.js';
import { resolveDeviations, describeDeviations, mergeDisputes, describeDisputes, type Step, type Deviation, type Dispute } from '../protocol/replySchema.js';
import { buildCoveringMessage, assertSendable } from '../protocol/reporter.js';
import { runStep, type RunResult } from '../exec/runner.js';
import { availableShells, detectShells, effectiveShell, preferredShell, refusalForChat, resolveShell, shellNote, type Shell, type ShellProblem } from '../exec/shells.js';
import { runChecks, failureMessage, failureRedactions, failureReport, environmentProblemIn, COMMIT_CLEAN_CHECK, CONTENT_CLEAN_CHECK, RUNNER_CHECK_KINDS, type CheckOutcome } from '../exec/checks.js';
import { activeChecks, suspendDisputed, settleAfterReview, onlyDerivedFailing, isDerivedCheck, withAttemptIds } from './derivedChecks.js';
import { workingDirFor, isWorkingDirProblem, workingDirNote } from '../exec/workDir.js';
import { redactSecrets } from '../exec/redaction.js';
import { snapshotProcesses, reapLeftovers, describeLeftovers, ProcessTracker, type ProcessSnapshot } from '../exec/processes.js';
import { collectEnvironment, describeEnvironment } from '../exec/environment.js';
import { describeCrash } from '../transport/edgeCrash.js';
import { runReview, findingsMessage, deliverableFor, type ReviewOutcome } from './review.js';
import { allAboutTheTask, isRepeat, findingId, type ReviewFinding } from '../protocol/reviewSchema.js';
import { repoState, workingTreePaths } from '../vcs/git.js';
import { describeStep, checkCommandRefusal, commandRefusal, type PolicyConfig } from '../exec/policy.js';
import { networkFetchReason } from '../exec/network.js';
import { collectPolicyManifest, describePolicyManifest } from '../exec/policyManifest.js';
import { assessIsolation, readIsolationSignals } from '../exec/isolation.js';
import { confinementRefusal, projectRoots, sessionRoots, type Confinement } from '../exec/confinement.js';
import type { StepAuthorizer } from '../exec/authorizer.js';
import { writeReport } from '../exec/reportFile.js';
import { Pacer } from '../util/pacing.js';
import { RunLog } from '../log/runLog.js';
import { composeOpening, readOnlyNote } from '../session/compose.js';
import { MIN_TRIED_APPROACHES } from '../protocol/replySchema.js';
import { enforceScope, scopeMessage, scopeNote } from '../vcs/scope.js';
import { composeHandoff, type NotRun } from '../session/handoff.js';
import { ProgressWatch } from './progress.js';
import { contractConflicts, readsTreeClean } from './contract.js';
import { treeFingerprint } from '../vcs/git.js';
import type { TaskStats } from '../session/model.js';
import type { SessionStore } from '../session/store.js';
import type { EventBus } from '../session/events.js';
import type { Session, SessionStart, Task, TaskAttempt, TaskCheck, TaskLimit, TaskRunGroup, TaskReview, TaskReviewCheck, TaskStatus } from '../session/model.js';
import { prepareForTask, commitTaskResult, commitShortfall, repoDirOf, trackedRepoOf, whereLeft } from '../vcs/taskVcs.js';
import { protectInputs, inputsMessage, inputsAtCommit, untrackedInputs, blobOfFile, type InputsCheck } from '../vcs/inputs.js';
import { artifactPatterns, artifactState, keepArtifacts, type ArtifactState } from '../vcs/artifacts.js';
import { exportMachine, writeAttemptRecord } from '../session/exports.js';

export type TaskOutcome = {
  status: Extract<TaskStatus, 'done' | 'blocked' | 'failed' | 'aborted' | 'limit-reached'>;
  iterations: number;
  summary?: string;
  reason?: string;
  /** Why the runner itself stopped the task, when it did. See `Task.stopCode`. */
  stopCode?: Task['stopCode'];
};

/**
 * Causes no conversation can change: the task contradicts itself, the machine lacks what a step needs,
 * a check can never run. A fresh chat is no cure for these, and retrying them in one only repeats the
 * verdict with empty branches and conversations behind it (seen live on 2026-10-03: a contract
 * conflict decided before any message was retried twice in fresh chats).
 */
export const NOT_THE_CHATS: ReadonlyArray<NonNullable<Task['stopCode']>> = ['contract-conflict', 'environment', 'invalid-check'];

export type RunDeps = {
  cfg: ResolvedConfig;
  store: SessionStore;
  bus: EventBus;
  authorizer: StepAuthorizer;
  /** Set to stop after the current step. The task it interrupts ends `aborted`. */
  signal?: AbortSignal;
  /**
   * Asked between tasks: whether to hold the queue here.
   *
   * The difference from `signal` is what happens to the task that is running, and it is the
   * whole reason both exist. Aborting is for stopping something that has gone wrong — it cuts
   * in after the current step, the task ends `aborted`, and whatever it was halfway through
   * doing stays halfway done. Pausing is for a person who wants to think: the task finishes
   * properly, its checks run, its review runs, it commits, and only then does the queue stop,
   * with the rest of it still queued and a conversation that can be re-entered.
   *
   * So this is read here and nowhere deeper. Pushing it down into the step loop would make it
   * the other thing.
   */
  shouldPause?: () => boolean;
  /**
   * The press of a start button this run belongs to, written onto every task it reaches.
   *
   * It is passed down rather than made here because a run of several sessions is one group
   * across all of them, and only the caller that started them knows that.
   */
  runGroup?: TaskRunGroup;
  /**
   * The queued tasks this run is to take, when not all of them. The operator picks them in the
   * register — typically the one task whose prompt was just fixed — and every other queued task
   * of the session stays queued, untouched, for another run. Absent means the whole queue.
   */
  onlyTasks?: ReadonlySet<string>;
  /**
   * The mode the run is in as this task begins. "Run the rest without asking" switches a run to
   * unattended half-way, and until 2026-09-27 the policy.json of every later task still said a
   * person had approved each step. The service that holds the switch answers this.
   */
  currentMode?: () => 'confirm' | 'unattended';
  /**
   * Version control for a session that has not started yet, asked before its browser or conversation
   * is touched and before any task is marked started: why it may not start, or null. The run as a
   * whole is checked before it begins (see the service's `runPreflight`); this holds the same rule for
   * a session reached later in a batch, whose repository the sessions before it may have changed. A
   * refusal leaves every task queued — no attempt, no `task-started`.
   */
  vcsGate?: (session: Session) => Promise<string | null>;
  /** Said just before this run opens a browser of its own (not a borrowed one): see `runLog.ts`. */
  beforeBrowser?: () => Promise<void>;
  /** What the picker on the page says about the models: see `ModelHooks`. */
  models?: ModelHooks;
};

/**
 * The page is the source of the model names (see `transport/modelMatch.ts`). `renamedDefault`: a model
 * from Settings is offered under a new name, so Settings follows the page. `seen`: the line-up was read
 * on the way, so the saved catalogue follows it too.
 */
export type ModelHooks = {
  /** Where the model of this name sat when the operator read the list: chosen there first (see `ModelLocator`). */
  locate?: (name: string) => Promise<ModelLocator | undefined>;
  renamedDefault?: (which: 'model' | 'review', from: string, to: string) => Promise<void>;
  seen?: (options: ModelOption[], current: string | null) => Promise<void>;
};

/**
 * Records a model the page offers under a new name where it was chosen — the session, or Settings — and
 * the line-up read on the way. Returns the sentence that says so, or ''.
 */
async function followPageModels(
  which: 'model' | 'review',
  wanted: string,
  result: ModelChoice,
  session: Session,
  store: SessionStore | undefined,
  hooks: ModelHooks | undefined,
): Promise<string> {
  if (result.options?.length) await hooks?.seen?.(result.options, result.current).catch(() => undefined);
  if (!result.ok || !result.matched) return '';
  const own = which === 'model' ? session.model?.trim() : session.review?.model?.trim();
  if (own) {
    await store
      ?.updateSession(session.id, (s) => {
        if (which === 'model') s.model = result.matched;
        else s.review = { ...(s.review ?? {}), model: result.matched } as typeof s.review;
      })
      .catch(() => undefined);
  } else {
    await hooks?.renamedDefault?.(which, wanted, result.matched!).catch(() => undefined);
  }
  return `"${wanted}" is no longer offered under that name; the page offers it as "${result.matched}", which was chosen, and ${own ? "the session's" : 'Settings\''} ${which === 'model' ? 'model' : 'review model'} now says so`;
}

/** Why a task that was reported as done is being closed as failed. */
function checksFailedReason(outcomes: CheckOutcome[]): string {
  const failed = outcomes.filter((o) => !o.passed);
  return failed.length === 0
    ? 'the checks the operator set for this task did not pass'
    : `the task reported itself as done, but these checks did not pass: ${failed
        .map((o) => `${o.check.name} (${o.detail})`)
        .join('; ')}`;
}

/** A package runner (`npx` and its kin): it fetches the tool it names unless the project has it installed. */
const PACKAGE_RUNNER = /\b(?:npx|pnpx|bunx)(?:\.cmd|\.exe)?\s|\b(?:pnpm|yarn)(?:\.cmd)?\s+dlx\s|\bnpm(?:\.cmd)?\s+exec\s/i;

/**
 * Why a check's command line is refused for itself, or null when the gate refuses it, if at all,
 * only for what the project's files hold now.
 *
 * `checkCommandRefusal` is the gate; this is the part of it that nothing in the tree decides — the
 * command's own words, the settings, the folders it reaches. The other two parts read the files,
 * and the work can change both: the scripts the command runs, refused while missing or while they
 * hold a line the gate refuses (see `scriptFiles.ts`), and a package runner, held only while its
 * tool is not installed in the project (see `network.ts`). A command with a package runner in it is
 * left to them whatever else it fetches: ending a task on a check the work could still have made
 * run is the worse mistake of the two.
 */
/**
 * A check's refusal in the operator's words. The gate's reasons are written for the chat about a step —
 * "this step waits for the operator to allow it" — which is untrue of a check: checks run with nobody
 * asked, so a refused one can never run (live run 2026-10-03, copied into records and a commit body).
 */
export function checkRefusalForOperator(why: string): string {
  const text = why.replace(/^refused: /, '');
  if (/fetches from the network/i.test(text)) {
    const what = /\(([^)]+)\)/.exec(text)?.[1];
    return `it fetches from the network${what ? ` (${what})` : ''}; checks run without anyone being asked, so the runner never runs it — change or remove the check`;
  }
  return text;
}

export function lineRefusal(command: string, shell: Shell, cwd: string, cfg: Pick<PolicyConfig, 'denyPatterns' | 'allowedPrograms'>, roots: string[]): string | null {
  return (
    commandRefusal(command, shell, cfg.denyPatterns, cfg.allowedPrograms) ??
    confinementRefusal(command, { roots, cwd }) ??
    (PACKAGE_RUNNER.test(command) ? null : networkFetchReason(command, cwd))
  );
}

/**
 * Why a task ended because of the machine rather than because of the work.
 *
 * Said in the task's own reason, in full, because this is the one failure whose fix is not in
 * the repository: somebody has to install an interpreter or change a setting, and a reason that
 * only said "the checks did not pass" would send them looking in the wrong place entirely.
 */
function shellProblemReason(problem: ShellProblem | null): string {
  return problem
    ? `this machine could not run it: ${problem.message}`
    : 'this machine could not run the commands this task needed, and no usable shell was found';
}

/**
 * What a command that has already been run is told, when it is sent again.
 *
 * Addressed to the model, because the model is the only thing that can act on it, and phrased
 * as an instruction rather than a complaint: the useful half of a refusal is what to do next.
 */
function repeatRefusal(count: number, limit: number): string {
  return (
    `this exact command has already run ${count} time(s) in this task, each time with the same result, and ` +
    `nothing in the working tree has changed since it last ran, which is the limit (maxCommandRepeats ${limit}). ` +
    'Running it again cannot tell you anything new, so it was not run. Do something different in kind: a different ' +
    'command, a different tool, a different way round the problem, or read something you have ' +
    'not read yet. If you have genuinely run out of approaches, end the task with status ' +
    '"blocked" and list in "tried" the different things you attempted.'
  );
}

/**
 * The working tree's uncommitted paths and what each holds, as git would hash it ('-' for a deleted file).
 *
 * The read-only verdict and the scope used to judge the tree as it is at the end, which is wrong both
 * ways (live run 2026-10-03): it blamed a read-only task for files another session had left before it
 * started, and for a report a plan's own check wrote at the gate. What a task changed is the difference
 * between two of these: at its start and just before its checks.
 */
async function treeState(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of await workingTreePaths(dir).catch(() => [] as string[])) out.set(path, (await blobOfFile(dir, path)) ?? '-');
  return out;
}

/** The paths whose content differs between two tree states. */
function changedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((p) => (before.get(p) ?? 'committed') !== (after.get(p) ?? 'committed')).sort();
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
 * Parts of a reason joined as the sentences they are: every part that another follows ends with a
 * full stop unless it already ends as a sentence does, and an empty part is left out.
 *
 * A reason is mostly written as a clause — "stopped by the operator before the review" — so that it
 * reads inside other sentences too, and one followed by the next with only a space between them ran
 * into it: "… before the review After that, the runner committed …". A part that already ends with
 * its own full stop is not given a second one, and the last part is left as it was written, so a
 * reason of one clause reads as it always has.
 */
function sentences(...parts: Array<string | undefined>): string {
  const kept = parts.map((p) => (p ?? '').trim()).filter(Boolean);
  return kept.map((p, i) => (i === kept.length - 1 || /[.!?…]["'”’)\]]*$/.test(p) ? p : `${p}.`)).join(' ');
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

/**
 * A step that was not run never reaches the shell, but Copilot still has to hear about it — and
 * hear who declined it: the runner (`refused`: a rule, so rewrite the step) or the operator
 * (`aborted`: a person stopped or skipped it).
 */
function refusedResult(step: Step, reason: string, by: 'runner' | 'operator' = 'runner', skippedAfter?: number): RunResult {
  return {
    ...(skippedAfter !== undefined ? { skippedAfter } : {}),
    id: step.id,
    shell: effectiveShell(step.shell),
    command: describeStep(step),
    exitCode: -4,
    outcome: by === 'operator' ? 'aborted' : 'refused',
    durationMs: 0,
    stdout: '',
    stderr: `[policy] step not executed: ${reason}\n`,
    truncated: false,
    logPath: '',
    lastOutputAgoMs: 0,
  };
}

/**
 * The same chat, refusing to send once the run has been stopped.
 *
 * Handed to the review, whose own loop looks at the signal at the top of each round and after a
 * step it ran. Every other message it sends — a format repair, a refused "pass", a turned-down
 * check — goes out before it looks again, and a Stop pressed while the reviewer was answering would
 * have one more sent and its answer waited for, a Stop that took as long as a reply. Refused here,
 * the review ends at the send, and the runner, seeing the Stop, ends the task `aborted` (see
 * `gateOnReview`). Everything else is the chat itself, unchanged.
 */
function sendsUntilStopped(transport: ChatTransport, signal: AbortSignal | undefined): ChatTransport {
  if (!signal) return transport;
  return new Proxy(transport, {
    get(target, key) {
      if (key === 'sendAndConfirm') {
        return (...args: Parameters<ChatTransport['sendAndConfirm']>) =>
          signal.aborted ? Promise.reject(new Error('the run was stopped; nothing more is sent')) : target.sendAndConfirm(...args);
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** One place that writes to the transcript, the console and the live stream at once. */
class Sink {
  constructor(
    private readonly log: RunLog,
    private readonly bus: EventBus,
    private readonly sessionId: string,
    private readonly taskId: string,
  ) {}

  /** True while this sink is publishing, so the mirror below does not write its own events twice. */
  publishing = false;

  event(type: string, data: Record<string, unknown> = {}, human?: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.log.event(type, data, human, level);
    this.publishing = true;
    try {
      this.bus.publish({ sessionId: this.sessionId, taskId: this.taskId, type, level, message: human, data });
    } finally {
      this.publishing = false;
    }
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
/**
 * Who a shared window speaks for: the session using it now. A window opened for a batch said everything
 * under the batch's id, so the browser's events of a session in a batch were in no transcript of its own
 * (live run 2026-10-04). `speakFor` moves it; the id it was opened under still hears every event.
 */
const speakers = new WeakMap<ChatTransport, { id: string }>();

export function speakFor(transport: ChatTransport, sessionId: string): void {
  const speaker = speakers.get(transport);
  if (speaker) speaker.id = sessionId;
}

export async function openBrowser(
  cfg: ResolvedConfig,
  bus: EventBus,
  transportDir: string,
  sessionId: string,
): Promise<ChatTransport> {
  const speaker = { id: sessionId };
  const transport = createTransport({
    profileDir: cfg.resolved.profileDir,
    transportDir,
    chatUrl: cfg.copilot.url,
    channel: cfg.copilot.channel,
    headless: cfg.copilot.headless,
    replyTimeoutMs: cfg.copilot.replyTimeoutSec * 1000,
    signInTimeoutMs: cfg.copilot.signInTimeoutSec * 1000,
    humanWaitMs: cfg.copilot.humanWaitSec * 1000,
    keepFailurePage: cfg.copilot.keepFailurePage,
    onEvent: (event, detail) => {
      const spoken: Record<string, string> = {
        'sign-in-required': 'The chat is asking you to sign in. Do it in the open Edge window; the run is waiting.',
        'verification-required':
          'The chat is showing a human-verification challenge. Complete it in the open Edge window. ' +
          'The bot will not touch it and is waiting for you.',
        'verification-cleared': 'Verification cleared, continuing.',
        'error-banner': 'The chat reported a transient error; reloading the page.',
        'reply-files-ignored':
          'The reply came with a file attached. It was not downloaded and will not be run: the runner takes only the text of a reply.',
        'model-menu-stuck':
          'The model menu would not close — Escape, the menu button and a click outside all left it open. Close it in the Edge window; the run goes on.',
      };
      for (const id of new Set([speaker.id, sessionId])) {
        bus.publish({
          sessionId: id,
          type: `browser:${event}`,
          level: event === 'verification-required' || event === 'reply-files-ignored' || event === 'model-menu-stuck' ? 'warn' : 'info',
          // An event with no sentence of its own is named, not said as "undefined".
          message: spoken[event] ?? event.replace(/-/g, ' '),
          data: detail,
        });
      }
    },
  });
  speakers.set(transport, speaker);

  /*
   * A window that opened and then failed to reach the chat — sign-in not done in time, a
   * verification challenge not cleared, the consumer Copilot — is closed here, since nobody else
   * holds it: the caller has no transport yet, so its own `finally` closes nothing. Left open, the
   * run ended and gave up its claim on the browser with Edge still on the profile, and the next start
   * or read of the models, the one the error asks for, was refused as "Edge is already running with
   * this profile" until the window was closed by hand.
   */
  try {
    await transport.open();
    await transport.ensureSignedIn();
  } catch (e) {
    await transport.close().catch(() => undefined);
    throw e;
  }
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
  transport: ChatTransport,
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
 * Whether an attempt's task reached a conversation, and which, as its run folder records it.
 *
 * `chat.json` is written the moment the message that carries the task has gone into a conversation
 * (see `runTask`), and never before: not when the attempt starts, and not when a new conversation
 * answers the contract, which is a message earlier. The transcript answers for an attempt that has
 * no `chat.json`. It records every opening message as it is sent (`message-sent`), and since
 * 2026-10-01 how many the opening had and whether this one carried the task. So an attempt that sent
 * nothing at all never delivered its task, whenever it ran; one that sent the second message of an
 * opening delivered it, since the task is always the last and an opening has two at most. Only an
 * older attempt that sent one message without saying more cannot be told: one message is a whole
 * opening into a conversation that had the contract, or the contract alone, stopped before the task.
 */
async function deliveryOf(runDir: string): Promise<{ sent: true; pointer: ChatPointer | null } | { sent: false } | { sent: 'unknown' }> {
  const pointer = await loadPointer(join(runDir, 'chat.json'));
  if (pointer) return { sent: true, pointer };
  const raw = await readFile(join(runDir, 'transcript.jsonl'), 'utf8').catch(() => null);
  if (raw === null) return { sent: 'unknown' };
  const sent: Array<{ index?: unknown; of?: unknown; task?: unknown }> = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('"message-sent"')) continue;
    try {
      const e = JSON.parse(line) as { type?: string; index?: unknown; of?: unknown; task?: unknown };
      if (e.type === 'message-sent') sent.push(e);
    } catch {
      // A line cut in half by a crash: the lines around it still answer.
    }
  }
  if (sent.length === 0) return { sent: false };
  if (sent.some((e) => e.task === true || (typeof e.of !== 'number' && Number(e.index) >= 1))) return { sent: true, pointer: null };
  return sent.every((e) => typeof e.of === 'number') ? { sent: false } : { sent: 'unknown' };
}

/**
 * Where the assignment a "Continue" carries on is, against the conversation the session is in now.
 *
 * `here` — in the session's conversation, or nothing on record says otherwise; `elsewhere` — in
 * another one, with its pointer when the attempt kept one; `nowhere` — no conversation was ever given
 * it, because the attempt was stopped before its task was sent (see `deliveryOf`), and so was every
 * attempt it continued. Then the assignment started with the first of those, and `buildsOn` is what
 * that one was told about the work before it.
 *
 * The newest attempt that delivered its task is the one whose conversation has the assignment and
 * the latest work on it; an undelivered continuation added nothing to any chat, so the one it
 * continued is asked instead. An attempt whose record cannot say is answered from the session's own
 * pointer, as far as that goes: a conversation registered by another attempt after this one started
 * cannot hold it. That is what a later task's retry in a fresh conversation leaves behind (see
 * `runSession`), the one thing that moves a session.
 */
async function conversationOfAttempt(
  runsDir: string,
  attempts: readonly TaskAttempt[],
  current: ChatPointer | undefined,
): Promise<{ where: 'here' } | { where: 'elsewhere'; pointer: ChatPointer | null } | { where: 'nowhere'; buildsOn?: Task['buildsOn'] }> {
  const fromThePointer = (a: TaskAttempt): { where: 'here' } | { where: 'elsewhere'; pointer: null } =>
    current && current.runId !== a.runId && !!a.startedAt && Date.parse(current.createdAt) > Date.parse(a.startedAt)
      ? { where: 'elsewhere', pointer: null }
      : { where: 'here' };
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const a = attempts[i]!;
    const delivered = a.runId ? await deliveryOf(join(runsDir, a.runId)) : ({ sent: 'unknown' } as const);
    if (delivered.sent === true) {
      if (!delivered.pointer) return fromThePointer(a);
      return current?.chatId === delivered.pointer.chatId ? { where: 'here' } : { where: 'elsewhere', pointer: delivered.pointer };
    }
    if (delivered.sent === 'unknown') return fromThePointer(a);
    if (!a.continuing) return { where: 'nowhere', buildsOn: a.buildsOn };
  }
  return { where: 'here' };
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
): Promise<ChatTransport> {
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
/**
 * The models a session runs on: its own, or else the ones chosen in Settings at this moment.
 * A session gets a model of its own from the plan or from its own picker; one that has none
 * follows Settings, so a model chosen there after the session was made still reaches it.
 */
export function effectiveModels(session: Pick<Session, 'model' | 'review'>, cfg: Pick<ResolvedConfig, 'copilot'>): { model: string; reviewModel: string } {
  return {
    model: (session.model ?? '').trim() || (cfg.copilot.defaultModel ?? '').trim(),
    reviewModel: (session.review?.model ?? '').trim() || (cfg.copilot.defaultReviewModel ?? '').trim(),
  };
}

async function applySessionModel(
  transport: ChatTransport,
  session: Session,
  bus: EventBus,
  cfg: Pick<ResolvedConfig, 'copilot'>,
  store?: SessionStore,
  hooks?: ModelHooks,
): Promise<{ current?: string; refused?: string }> {
  const wanted = effectiveModels(session, cfg).model;
  if (!wanted) return {};

  const locator = await hooks?.locate?.(wanted).catch(() => undefined);
  const result: ModelChoice = await transport.selectModel(wanted, { locator }).catch((e: unknown) => ({
    ok: false as const,
    current: null,
    reason: (e as Error).message,
  }));
  const renamed = await followPageModels('model', wanted, result, session, store, hooks);
  if (renamed) bus.publish({ sessionId: session.id, type: 'model-renamed', level: 'warn', message: renamed, data: { asked: wanted, chosen: result.matched } });

  bus.publish({
    sessionId: session.id,
    type: result.ok ? 'model-selected' : 'model-not-selected',
    level: result.ok ? 'info' : 'warn',
    message: result.ok
      ? `model: ${result.current ?? wanted}${session.model?.trim() ? '' : ' (from Settings)'}`
      : `could not switch to "${wanted}"${session.model?.trim() ? '' : ' (the default model in Settings)'}: ${(result.reason ?? 'unknown reason').replace(/[.\s]+$/, '')}. Nothing is sent on ${result.current ?? 'the chat default'} instead.`,
    data: { asked: wanted, fromSettings: !session.model?.trim(), current: result.current, ok: result.ok, by: result.by ?? null, savedLocator: !!locator },
  });
  // Kept on the session, so each task's record says which model it ran on and why (see `runTask`).
  await store
    ?.updateSession(session.id, (s) => {
      s.modelSelection = {
        asked: wanted,
        current: result.current ?? null,
        ok: result.ok,
        fromSettings: !session.model?.trim(),
        ...(result.matched ? { renamedTo: result.matched } : {}),
        ...(result.ok ? {} : { reason: (result.reason ?? 'unknown reason').replace(/[.\s]+$/, '') }),
        at: new Date().toISOString(),
      };
    })
    .catch(() => undefined);

  /*
   * A model the operator chose and the chat is not on is not worked around: the run went on Auto with a
   * warning nobody saw, and its work was then taken for the chosen model's (2026-10-05). Nothing goes out.
   */
  if (!result.ok) {
    return {
      current: result.current ?? undefined,
      refused:
        `The chat could not be put on the chosen model "${wanted}"${session.model?.trim() ? '' : ' (Settings)'}: ${(result.reason ?? 'unknown reason').replace(/[.\s]+$/, '')}. ` +
        'Nothing was sent. Read the list again under Settings → Model, choose the model there, and start again.',
    };
  }
  return { current: result.current ?? undefined };
}

/** Runs one task to completion inside an already-open transport. */
export async function runTask(
  transport: ChatTransport,
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
  /*
   * What other parts publish about this task while it runs — version control, the browser and the
   * model picker, approvals, Stop, retries — written into its transcript too. They went to the live
   * event stream only, which keeps the last 500 events in memory, so the exports and the run folder
   * never had them (live run 2026-10-03: no vcs-*, model-* or approval events in any transcript).
   */
  /*
   * Every message this task sends, kept: its text in `messages/NN.md` and a `message-sent` event. Only the
   * opening was recorded, so the results of each round with the runner's notes, the checks' and the
   * review's feedback were in no file, and the export counted 2 messages where 15 went out (live run
   * 2026-10-03). The opening keeps its own event, with its index; the rest are said here.
   */
  let sentCount = 0;
  let inOpening = false;
  /*
   * A conversation Copilot had not yet put in its sidebar when it was registered is named before a later
   * message goes out in it: the row comes some seconds after the first reply, and fifteen were not always
   * enough (live run 2026-10-05), which left the chat under Copilot's own title, where a later run looking
   * for it by name could not find it. A few tries, only while the page is on that conversation.
   */
  let nameTries = 0;
  const nameIfStillUnnamed = async (target: ChatTransport): Promise<void> => {
    const chat = session.chat;
    if (!chat || chat.named !== false || nameTries >= 3) return;
    if ((await target.currentChatId().catch(() => null)) !== chat.chatId) return;
    nameTries += 1;
    const named = await target.nameChat(chat.chatId, chat.name, { waitMs: 5_000 }).catch(() => false);
    if (!named) return;
    const { named: _was, ...done } = chat;
    session.chat = done;
    await store.updateSession(session.id, (s) => {
      if (s.chat?.chatId === chat.chatId) s.chat = { ...s.chat, named: undefined };
    }).catch(() => undefined);
    await savePointer(log.path('chat.json'), done).catch(() => undefined);
    sink.event('chat-named-later', { chatId: chat.chatId, name: chat.name, tries: nameTries }, `chat named "${chat.name}" in Copilot's sidebar, now that it is there`);
  };
  const chatOf = transport;
  transport = new Proxy(chatOf, {
    get(target, key) {
      if (key !== 'sendAndConfirm') return Reflect.get(target, key);
      return async (...args: Parameters<ChatTransport['sendAndConfirm']>) => {
        await nameIfStillUnnamed(target);
        const before = await target.sendAndConfirm(...args);
        sentCount += 1;
        const [text, attachments] = args;
        await mkdir(log.path('messages'), { recursive: true }).catch(() => undefined);
        await writeFile(log.path('messages', `${String(sentCount).padStart(2, '0')}.md`), text, 'utf8').catch(() => undefined);
        if (!inOpening) {
          sink.event('message-sent', { n: sentCount, chars: text.length, attachments: (attachments ?? []).map((a) => a.replace(/^.*[\\/]/, '')), chatId: session.chat?.chatId ?? null },
            `message ${sentCount} sent (${text.length} chars${attachments?.length ? `, ${attachments.length} file(s) attached` : ''})`);
        }
        return before;
      };
    },
  });
  const unmirror = bus.subscribe(session.id, (e) => {
    if (sink.publishing || e.type === 'console' || (e.taskId && e.taskId !== task.id)) return;
    log.event(e.type, { ...(e.data ?? {}), ...(e.message ? { message: e.message } : {}), mirrored: true }, undefined, e.level);
  });
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
  /*
   * Made here, not left to the first step report. The report writer creates it as a side effect, so
   * a chat that answered "done" before running a single step reached the failed-checks report with
   * no folder to write it into, and the task ended "failed" on an ENOENT about checks-1.txt instead
   * of telling the chat which check failed. Found by the end-to-end checks (test/e2e-run.check.ts).
   */
  await mkdir(reportsDir, { recursive: true });

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
  /** Steps the chat sent that were not run, for the handoff at the end. */
  const notRun: NotRun[] = [];
  /**
   * How many different approaches "blocked" needs, from Settings, never below the format's own two.
   * A "blocked" with fewer is sent back; after `MAX_EARLY_BLOCKS` of them in a row with nothing tried
   * in between the verdict is accepted, so a chat that cannot think of anything else does not spend
   * the rest of the iterations saying so.
   */
  const minApproaches = Math.max(MIN_TRIED_APPROACHES, cfg.limits.minApproachesBeforeBlocked ?? MIN_TRIED_APPROACHES);
  const MAX_EARLY_BLOCKS = 3;
  let earlyBlocks = 0;
  /** What went wrong on the way, counted for the register's figures. See `TaskStats`. */
  const stats: TaskStats = { formatErrors: 0, doneRejected: 0, repeatsRefused: 0, stepsRefused: 0, operatorStops: 0, reviewRejections: 0, scopeReverts: 0 };
  /** Loops the older guards do not see; see `progress.ts`. */
  const progress = new ProgressWatch({ noProgress: Math.max(2, cfg.limits.maxNoProgressRounds ?? 3), oscillations: 2 });
  /** Set when a check round shows no progress; the give-up then ends the task blocked with it. */
  let noProgressReason: string | null = null;
  /** The scope as enforced on the task's own branch, once known; `finish` holds the commit to it too. */
  let enforcement: { scope: string[]; readOnly: boolean } | null = null;
  /**
   * The tree when the task started, and just before its checks last ran: see `treeState`. Taken for a
   * read-only task, and for one whose work no commit will record, so its changed files are on record.
   */
  let startState: Map<string, string> | null = null;
  let preGateState: Map<string, string> | null = null;
  /** Whether the runner commits this task's work; when it does not, `treeChanged` records what changed. */
  const commitsWork = !!(session.vcs?.enabled && session.vcs.commitOnFinish !== false && trackedRepoOf(session));
  const watchesTree = !!repoDirOf(session) && (!!task.readOnly || !commitsWork);
  /**
   * Why the attempt stopped, when the status alone does not say: a format the chat could not keep,
   * a task contract that contradicts itself, a loop, a check that could never run, a machine that
   * lacks a shell. Written by `finish`. See `Task.stopCode`.
   */
  let stopCode: Task['stopCode'];
  /** The setting whose limit ended the attempt, when one did. Written by `finish`. See `TaskLimit`. */
  let limitHit: TaskLimit | undefined;
  /**
   * Checks that the working tree is clean, decided after the runner's commit rather than at the gate.
   * The chat may not commit, so before that commit such a check could only fail (2026-09-30: failed,
   * and then the commit left the tree clean). Set by the gate, run by `finish`. See `readsTreeClean`.
   */
  let afterCommitChecks: TaskCheck[] = [];
  let runAfterCommit: ((checks: TaskCheck[]) => Promise<CheckOutcome[]>) | null = null;
  /**
   * Checks earlier reviews gave with their findings — carried over from every attempt before
   * this one, and grown by this one. See `derivedChecks.ts` for the three rules. Ones written before
   * a finding's id carried its attempt are renamed here, before anything finds one by id or name.
   */
  let reviewChecks: TaskReviewCheck[] = withAttemptIds(task.reviewChecks ?? []);
  /** Derived checks that still failed when the rounds ran out; the reviewer is told. */
  let derivedStillFailing: Array<{ name: string; detail: string }> = [];
  /**
   * What was running before the task, so that what it and its reviews leave running can be
   * told apart and stopped. Taken once the working directory is known; null means "do not".
   */
  let processesBefore: ProcessSnapshot | null = null;
  /**
   * Every shell this task starts — its steps, its checks, its reviews' steps and checks — so that
   * what is stopped afterwards is what the bot started, and nothing the operator started by hand in
   * the same folder. See `processes.ts`.
   */
  const tracker = new ProcessTracker();
  /** Stops what appeared since a snapshot, tied to the project, writes it on the task, and says what it was. */
  const reap = async (since: ProcessSnapshot | null, by: string): Promise<Array<{ name: string; ports: number[] }>> => {
    if (!since) return [];
    const result = await reapLeftovers(work.cwd, since, tracker).catch(() => null);
    if (!result) return [];
    if (result.notOurs.length > 0) {
      sink.event('processes-not-ours', { by, count: result.notOurs.length, pids: result.notOurs.map((l) => l.pid) },
        `${result.notOurs.length} new process(es) in the project folder were not started by the bot, so they were left running: ` +
          result.notOurs.map((l) => `${l.name} pid ${l.pid}${l.ports.length > 0 ? ` (port ${l.ports.join(', ')})` : ''}`).join('; '),
        'info');
    }
    if (result.killed.length === 0 && result.failed.length === 0) return [];
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

  /** The session's read-only input files and the commit they are put back from, once the task is on its own branch. */
  let inputsGuard: { base: string; inputs: NonNullable<SessionStart['inputs']>; keep: Set<string> } | null = null;
  /** The artifact files as they were when the task started; what is kept afterwards is what changed. */
  let artifactsBefore: ArtifactState | undefined;
  /** Puts back whatever a round did to the input files, and tells the chat and the record. */
  const guardInputs = async (iteration?: number): Promise<InputsCheck | null> => {
    if (!inputsGuard) return null;
    const guard = inputsGuard;
    const check = await protectInputs(repoDirOf(session), guard.base, guard.inputs, guard.keep).catch((e: unknown): InputsCheck => ({
      changed: ['(the input files)'],
      restored: [],
      failed: [{ path: '(the input files)', why: (e as Error).message }],
    }));
    if (check.changed.length > 0) {
      sink.event('inputs-restored', { iteration, restored: check.restored, failed: check.failed },
        `the operator's input files are read-only; put back: ${check.restored.join(', ') || '(none)'}` +
          (check.failed.length > 0 ? `; could not be put back: ${check.failed.map((f) => f.path).join(', ')}` : ''),
        'warn');
      runnerNotes.push(inputsMessage(check));
      await setTask((t) => {
        t.inputsRestored = [...new Set([...(t.inputsRestored ?? []), ...check.restored])];
      });
    }
    return check;
  };

  const finish = async (status: TaskOutcome['status'], reason?: string, summary?: string, finalReply?: string): Promise<TaskOutcome> => {
    // How it ended as reported; the runner's own checks below can still change it, and the final word is written at the end.
    await record(`ENDING: ${status.toUpperCase()}`, [summary ?? '', reason ? `Reason: ${reason}` : ''].filter(Boolean).join('\n\n') || '(no details)');

    // The net under the plan's own checks: whatever the task left running is stopped and named.
    await reap(processesBefore, 'the task');

    /*
     * The operator's input files, once more before the commit: put back what the last round changed,
     * so it is not committed as the task's work. One that cannot be put back fails a done task. See
     * `vcs/inputs.ts`.
     */
    if (inputsGuard) {
      const check = await guardInputs();
      if (check && check.failed.length > 0 && status === 'done') {
        status = 'failed';
        reason = `the operator's input file(s) ${check.failed.map((f) => f.path).join(', ')} were changed and could not be put back as they were: ${check.failed.map((f) => f.why).join('; ')}.`;
      }
      // Said on the record either way: the inputs as the task leaves them, against their recorded sums.
      if (check && check.failed.length === 0) {
        sink.event('inputs-verified', { files: inputsGuard.inputs.files.length },
          `${inputsGuard.inputs.files.length} input file(s) are as the session's start recorded them: same sums`);
      }
    }

    /*
     * The session's artifacts, whatever the outcome: copied into this attempt's record, so the
     * evidence of each attempt is kept even after a later one overwrites it. See `vcs/artifacts.ts`.
     */
    const patterns = artifactPatterns(session.vcs);
    const projectRoot = repoDirOf(session) || session.projectDir?.trim() || '';
    // Only after the task started: one refused before it ran made nothing, and what is there is not its own.
    if ((patterns.length > 0 || (task.outputs?.length ?? 0) > 0) && projectRoot && artifactsBefore) {
      // Only what this task made or changed, inside its scope, or declared as its outputs.
      const kept = await keepArtifacts(projectRoot, patterns, join(artifactsDir, 'project'), { before: artifactsBefore, scope: task.scope, outputs: task.outputs })
        .catch((e: unknown) => ({ kept: [], skipped: [`(all: ${(e as Error).message})`], unchanged: 0, outsideScope: [] as string[] }));
      /*
       * `artifacts-kept` only when something was: files that were there before and untouched are not this
       * task's evidence, and an event of that name with nothing in it read as if they had been collected.
       */
      sink.event(kept.kept.length > 0 || kept.skipped.length > 0 ? 'artifacts-kept' : 'artifacts-none', { kept: kept.kept.length, skipped: kept.skipped, unchanged: kept.unchanged, outsideScope: kept.outsideScope.slice(0, 20) },
        `artifacts kept with the run: ${kept.kept.length} file(s) this task made or changed` +
          `${kept.unchanged > 0 ? `; ${kept.unchanged} already there and untouched, not kept` : ''}` +
          `${kept.outsideScope.length > 0 ? `; ${kept.outsideScope.length} outside the task's scope, not kept` : ''}` +
          `${kept.skipped.length > 0 ? `; not kept: ${kept.skipped.slice(0, 5).join('; ')}` : ''}`,
        kept.skipped.length > 0 ? 'warn' : 'info');
      await setTask((t) => {
        t.artifactsKept = kept.kept.length > 0 ? kept.kept : undefined;
      });
    }

    /*
     * A read-only task that changed files has failed, whatever it reported.
     *
     * Decided from the working tree, not from the summary, and before the commit: the change
     * is still committed on the task's branch — so it is not lost and the next task starts
     * from a clean tree — but the task ends `failed` with the files named. Only a task that
     * claims `done` is overturned; one that already ended badly keeps its own reason.
     */
    // What the task did, judged before what the checks and the review wrote after its last round.
    const taskEndState = watchesTree ? (preGateState ?? (await treeState(repoDirOf(session)))) : null;
    /*
     * The scope holds for the commit too. Put back each round, it still let through what the checks and
     * the independent review wrote after the last one (live run 2026-10-03: a docs build run by a check
     * and by the reviewer was committed with a scoped task's work).
     */
    if (enforcement && repoDirOf(session)) {
      const last = await enforceScope(repoDirOf(session), enforcement.scope, enforcement.readOnly).catch(() => null);
      if (last && last.reverted.length + last.failed.length > 0) {
        sink.event('scope-reverted', { phase: 'finish', reverted: last.reverted, failed: last.failed },
          `outside the task's ${enforcement.readOnly ? 'read-only rule' : 'scope'}, put back before the commit (written after the last round, by the checks or the review): ${last.reverted.join(', ') || '(none)'}` +
            (last.failed.length > 0 ? `; could not be put back: ${last.failed.map((f) => f.path).join(', ')}` : ''),
          'warn');
      }
    }
    if (task.readOnly && status === 'done' && repoDirOf(session) && startState && taskEndState) {
      const changed = changedBetween(startState, taskEndState);
      if (changed.length > 0) {
        const commits = !!(session.vcs?.enabled && session.vcs.commitOnFinish !== false && trackedRepoOf(session));
        status = 'failed';
        reason =
          `this task is read-only and it changed ${changed.length} file(s): ${changed.slice(0, 8).join(', ')}` +
          `${changed.length > 8 ? `, and ${changed.length - 8} more` : ''}.` +
          (commits ? " The change is committed on the task's branch; nothing is lost." : ' Nothing is committed: the change is in the working tree.');
        sink.event('readonly-violated', { files: changed.slice(0, 20) }, reason, 'error');
      }
    }
    /*
     * With no commit to read them from, the files the task changed are recorded from the tree, so the
     * record does not say "no files changed" beside a verdict that names them (live run 2026-10-04).
     */
    if (!commitsWork && startState && taskEndState) {
      const changed = changedBetween(startState, taskEndState);
      await setTask((t) => {
        t.treeChanged = changed.length > 0 ? changed : undefined;
      });
    }

    // Whatever the outcome, what the task changed goes onto its branch. A failed task that
    // left files behind is exactly when having them committed somewhere is worth the most.
    // The task is re-read first, because the branch was recorded on it after this closure
    // was created.
    const fresh = (await store.getSession(session.id))?.tasks.find((x) => x.id === task.id);
    let vcsError: string | undefined;
    const vcsAfter = await commitTaskResult(session, { ...task, vcs: fresh?.vcs }, { status, summary, reason, deviations }, bus).catch(
      (e: unknown) => {
        vcsError = (e as Error).message;
        sink.event('vcs-error', { error: String(e) }, `version control failed after the task: ${(e as Error).message}`, 'warn');
        return undefined;
      },
    );
    /*
     * With version control on, a task is done only when its work is committed. The commit used to
     * fail — on the branch it was moved off, on a git error, on uncommitted files left behind — and
     * the task still ended done, its work loose in the tree and the next task refusing to start over
     * it. Now it ends failed with why; the work stays in the working tree, nothing is lost.
     */
    if (status === 'done') {
      const uncommitted = await commitShortfall(session, fresh?.vcs ?? task.vcs, vcsAfter, vcsError);
      if (uncommitted) {
        status = 'failed';
        reason = uncommitted;
        sink.event('commit-failed', { problem: vcsAfter?.problem ?? vcsError, uncommitted: vcsAfter?.afterCommit?.changed?.slice(0, 20) }, uncommitted, 'error');
      }
    }
    /*
     * The checks about a clean tree, now that the runner has committed. A done task whose tree is
     * still not clean after the commit has failed; any other ending keeps its own reason, and the
     * results are recorded all the same.
     *
     * Not once the operator has stopped the run, for the reason a stopped round at the gate records
     * nothing: these checks cannot run then, and one cut short or never started reads as failed ("the
     * operator stopped the run before this check ran"). Such rows were recorded as the task's results
     * and named as failures in its handoff, and a done task was failed on them. A Stop is no verdict
     * on the work, whether it came before these checks or while they ran: they decide nothing, and a
     * task that was done but whose tree was never judged ends `aborted`, as every Stop ends a task,
     * which "Continue" carries on to be judged.
     */
    let afterCommitResults: Array<{ name: string; passed: boolean; detail: string }> = [];
    if (afterCommitChecks.length > 0 && runAfterCommit) {
      const outcomes = signal?.aborted
        ? []
        : await runAfterCommit(afterCommitChecks).catch((e: unknown) => {
            sink.event('checks-after-commit-error', { error: String(e) }, `the checks after the commit could not run: ${(e as Error).message}`, 'warn');
            return [] as CheckOutcome[];
          });
      if (signal?.aborted) {
        sink.event('checks-after-commit-stopped', { checks: afterCommitChecks.map((c) => c.name) },
          `the operator stopped the run, so the check(s) after the commit decide nothing: ${afterCommitChecks.map((c) => c.name).join(', ')}`, 'warn');
        if (status === 'done') {
          status = 'aborted';
          reason = 'stopped by the operator before the checks after the commit had decided';
        }
      } else {
        afterCommitResults = outcomes.map((o) => ({ name: `${o.check.name} (after the commit)`, passed: o.passed, detail: o.detail }));
        for (const o of outcomes) {
          sink.event(o.passed ? 'check-passed' : 'check-failed', { name: o.check.name, detail: o.detail, afterCommit: true },
            `${o.passed ? 'passed' : 'FAILED'} after the commit: ${o.check.name} — ${o.detail}`, o.passed ? 'info' : 'warn');
        }
        const failedAfter = outcomes.filter((o) => !o.passed);
        if (status === 'done' && failedAfter.length > 0) {
          status = 'failed';
          reason =
            `after the runner's commit${vcsAfter?.commit ? ` (${vcsAfter.commit.slice(0, 8)})` : ''}${vcsAfter?.problem ? `, which did not happen: ${vcsAfter.problem}` : ''}, ` +
            `${failedAfter.length} check(s) about the working tree still failed: ${failedAfter.map((o) => `${o.check.name} (${o.detail})`).join('; ')}`;
        }
      }
    }
    /*
     * What the task said about the repository was written before the commit. When it did not end
     * done and the runner then committed its changes, the reason says so, so "not committed, the
     * tree is dirty" is not left standing beside a commit on the record.
     */
    if (status !== 'done' && vcsAfter?.commit && vcsAfter.commit !== task.vcs?.commit) {
      reason = sentences(
        reason,
        `After that, the runner committed the task's changes as ${vcsAfter.commit.slice(0, 8)} on ${vcsAfter.branch}` +
          `${vcsAfter.afterCommit ? (vcsAfter.afterCommit.clean ? '; the working tree is clean' : `; still uncommitted: ${vcsAfter.afterCommit.changed.slice(0, 8).join(', ')}`) : ''}.`,
      );
    }
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
      t.stats = stats;
      if (stopCode) t.stopCode = stopCode;
      if (limitHit) t.limit = limitHit;
      if (afterCommitResults.length > 0) t.checkResults = [...(t.checkResults ?? []), ...afterCommitResults];
      // A review that was asked for and never ran says why, instead of reading as zero rounds.
      if (!t.review && (task.reviewEnabled ?? session.review?.enabled ?? true) && status !== 'done') {
        t.review = {
          verdict: 'skipped',
          rounds: 0,
          stepsRun: 0,
          skippedBecause: `the task ended ${status} before its work reached the review; the review runs only on work reported done whose checks pass`,
        };
      }
    });
    // The end in one fixed shape, read off the record just written. See `session/handoff.ts`.
    await setTask((t) => {
      t.handoff = composeHandoff(t, notRun);
    });
    // The final status, after the read-only, commit and clean-tree checks (an unverified finding of 2026-10-03: "TASK DONE" for a failed task).
    await record(`TASK ${status.toUpperCase()}`, reason ? `Reason: ${reason}` : '(no reason: it ended as reported)');
    sink.event('task-finished', { status, reason, iterations }, `task "${task.title}" ${status}${reason ? `: ${reason}` : ''}`);
    unmirror();
    await log.close();
    /*
     * An attempt that did not end done leaves its plan, work and runner views in its own folder,
     * written after the transcript is closed so they carry all of it. See `writeAttemptRecord`.
     * A failure to write them is reported and changes nothing about the outcome.
     */
    if (status !== 'done') {
      const now = await store.getSession(session.id);
      const ended = now?.tasks.find((x) => x.id === task.id);
      if (now && ended) {
        await writeAttemptRecord(now, ended, cfg.resolved.runsDir, exportMachine(cfg))
          .then((dir) => {
            if (dir) {
              bus.publish({ sessionId: session.id, taskId: task.id, type: 'attempt-record', level: 'info',
                message: `plan, work and runner of this attempt saved in ${dir}`, data: { dir } });
            }
          })
          .catch((e: unknown) =>
            bus.publish({ sessionId: session.id, taskId: task.id, type: 'attempt-record', level: 'warn',
              message: `could not save the plan, work and runner of this attempt: ${(e as Error).message}` }),
          );
      }
    }
    return { status, iterations, summary, reason, ...(stopCode ? { stopCode } : {}) };
  };

  await setTask((t) => {
    t.status = 'running';
    t.runId = runId;
    t.runGroup = deps.runGroup;
    t.startedAt = new Date().toISOString();
    // The kept checks under the ids this run uses (`withAttemptIds`), so the record names them as the gate does.
    if (reviewChecks.length > 0) t.reviewChecks = reviewChecks;
  });
  sink.event('task-started', { runId, title: task.title }, `task "${task.title}" starting (run ${runId})`);
  {
    const sel = (await store.getSession(session.id))?.modelSelection;
    if (sel) {
      sink.event('model-in-use', sel,
        sel.ok
          ? `the chat is on ${sel.current ?? sel.asked}${sel.fromSettings ? ' (from Settings)' : ''}`
          : `the chat is on ${sel.current ?? 'its default'}, not "${sel.asked}"${sel.fromSettings ? ' (the default model in Settings)' : ''}: ${sel.reason ?? 'the picker refused it'}`,
        sel.ok ? 'info' : 'warn');
    }
  }
  await writeFile(taskLogPath, `TASK: ${task.title}\nSESSION: ${session.name} (${session.id})\nRUN: ${runId}\nSTARTED: ${new Date().toISOString()}\n`, 'utf8');

  /*
   * Which shell a step or a check gets when it names none, decided here and once.
   *
   * The configured default is a preference and not an instruction — nothing about this task
   * chose it — so on a machine that has not got it the run falls through the order rather than
   * spending the task on spawn errors. It is said out loud when it happens: a run whose commands
   * were written for PowerShell and were read by `cmd` is a run somebody will want to know about
   * before they start reading the output.
   */
  const shells = detectShells();
  const defaultShell = preferredShell(cfg.execution.defaultShell, shells);
  if (defaultShell !== cfg.execution.defaultShell) {
    sink.event('shell-fallback', { configured: cfg.execution.defaultShell, using: defaultShell, available: availableShells(shells) },
      `${cfg.execution.defaultShell} is not installed on this machine, so anything that names no shell runs in ${defaultShell} ` +
        `(found: ${availableShells(shells).join(', ') || 'nothing'})`, 'warn');
  }

  // Which world this run got: the machine's tools, so a difference between two runs of one
  // plan has somewhere to be read from. Once per process; the probes are child processes.
  const environment = collectEnvironment();
  await writeFile(log.path('environment.json'), JSON.stringify(environment, null, 2), 'utf8').catch(() => undefined);
  await record('ENVIRONMENT', describeEnvironment(environment, defaultShell));
  await setTask((t) => {
    // The shell this run resolved to, kept with the rest of the machine, so the export and the
    // manifest read one fact rather than each deciding it again from a config neither has.
    t.environment = { ...environment, defaultShell };
  });

  /** A shell that could not be started, kept so the task can end on it rather than retry it. */
  let environmentProblem: ShellProblem | null = null;

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

  /*
   * What was allowed, recorded beside what was run.
   *
   * The run folder has always held the commands and their exit codes, and never the rules they
   * were judged against, so answering "what was this permitted to do at the time" meant reading a
   * config that had been edited since. Written here rather than with the environment above because
   * the working directory is part of the answer and is only settled now. See `policyManifest.ts`.
   */
  /*
   * The project folders, decided once for the whole task: this session's own, and every folder
   * registered in Settings, because work across a front end, a back end and its tests is one piece
   * of work and a test suite legitimately starts the application next door. Every command this task
   * runs — the implementer's steps and checks, the reviewer's steps and derived checks — is held to
   * them. Built here and handed down rather than rebuilt at each gate, so no gate can have a
   * different idea of where the project ends. See `confinement.ts`.
   */
  const confinement: Confinement = {
    roots: sessionRoots(work.cwd, [cfg.project.rootDir, ...cfg.project.others.map((o) => o.rootDir)]),
    cwd: work.cwd,
  };
  sink.event('confinement', { roots: confinement.roots }, `commands are confined to ${confinement.roots.join(', ')}`);

  const isolation = assessIsolation(cfg.execution.isolation, readIsolationSignals());
  for (const concern of isolation.warnings) {
    sink.event('isolation', { claim: isolation.claim, elevated: isolation.signals.elevated }, concern, 'warn');
  }
  const manifest = collectPolicyManifest({
    isolation,
    confinedTo: confinement.roots,
    mode: deps.currentMode?.() ?? cfg.execution.mode,
    networkFetch: cfg.execution.networkFetch,
    allowedPrograms: cfg.execution.allowedPrograms,
    denyPatterns: cfg.execution.denyPatterns,
    cwd: work.cwd,
    lock: cfg.policyLock,
  });
  await writeFile(log.path('policy.json'), JSON.stringify(manifest, null, 2), 'utf8').catch(() => undefined);
  await record('POLICY', describePolicyManifest(manifest));
  sink.event(
    'policy',
    { mode: manifest.mode, allowlist: manifest.allowlist.enforced, allowlistDigest: manifest.allowlist.digest },
    `policy: ${manifest.mode}, allowlist ${manifest.allowlist.enforced ? `${manifest.allowlist.count} programs (${manifest.allowlist.digest})` : 'NOT ENFORCED'}, ` +
      'the chat cannot supply files',
    manifest.mode === 'unattended' || !manifest.allowlist.enforced ? 'warn' : 'info',
  );

  // Not when the project is this runner's own checkout: every process of the runner would
  // then look like a leftover.
  processesBefore = work.ownCheckout ? null : await snapshotProcesses(work.cwd).catch(() => null);

  try {
    // --- version control: a branch of this task's own, before anything is touched -------
    const prepared = await prepareForTask(
      session,
      task,
      bus,
      async (mutate) => {
        await store.updateSession(session.id, mutate);
      },
      () => store.listSessions(),
    );
    if (prepared.refuse) {
      await setTask((t) => {
        t.vcs = prepared.vcs;
      });
      return await finish('failed', prepared.refuse);
    }
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
    /*
     * The paths this task may change. Enforced only on a branch of the task's own, which is what
     * makes "put back" safe: the tree was clean when the branch was made, so every change in it
     * is the task's, and the starting commit is what a change goes back to.
     */
    const scope = task.scope ?? [];
    const onOwnBranch = !!prepared.vcs.branch && !prepared.vcs.problem && !!prepared.vcs.baseCommit;
    /*
     * A read-only task is a scope of nothing, and is enforced the same way: whatever a round changed
     * is put back before the chat reads the results. It used to be judged only at the end, so an
     * audit that edited a file "to check something" kept the edit through every later round and its
     * findings described a tree that was not the one it had been asked to audit.
     */
    const scopeEnforced = (scope.length > 0 || !!task.readOnly) && onOwnBranch;
    if (scopeEnforced) enforcement = { scope, readOnly: !!task.readOnly };
    if (watchesTree) startState = await treeState(repoDirOf(session));
    // The operator's input files, read-only on a branch of the task's own; see `vcs/inputs.ts`.
    const startNow = (await store.getSession(session.id))?.vcsStart;
    if (onOwnBranch && startNow?.inputs?.readOnly && startNow.inputs.files.length > 0) {
      /*
       * Held to the inputs as this task's own starting commit has them, not the session's record: a
       * re-run is cut from where the task first started, before any inputs changed since. And what is
       * under the patterns untracked now is the operator's, never removed by the guard.
       */
      const baseCommit = prepared.vcs.baseCommit as string;
      inputsGuard = {
        base: baseCommit,
        inputs: await inputsAtCommit(repoDirOf(session), baseCommit, startNow.inputs),
        keep: await untrackedInputs(repoDirOf(session), startNow.inputs.patterns),
      };
    }
    // Before the first step: what is under the artifact patterns now is not this task's evidence.
    const artifactRoot = repoDirOf(session) || session.projectDir?.trim() || '';
    const artifactPatternsNow = [...artifactPatterns(session.vcs), ...(task.outputs ?? [])];
    if (artifactRoot && artifactPatternsNow.length > 0) artifactsBefore = await artifactState(artifactRoot, artifactPatternsNow).catch(() => undefined);
    /** The working tree's fingerprint, when the task is on a branch of its own; null otherwise. */
    const treeNow = async (): Promise<string | null> =>
      prepared.vcs.branch && !prepared.vcs.problem && prepared.vcs.baseCommit ? await treeFingerprint(repoDirOf(session)).catch(() => null) : null;

    /*
     * The task's contract, checked before a single message is sent.
     *
     * A task can be written so that no answer satisfies it: read-only and still given paths to
     * change, or a check that needs a file to change while the task may not change it. Sent as it
     * is, the chat works for rounds, the check fails at the end, and the task goes blocked on a
     * finding the chat could never have fixed. The contradiction is named instead, now, and nothing
     * is run. See `orchestrator/contract.ts`.
     */
    const conflicts = await contractConflicts(task, work.cwd, repoDirOf(session) || work.cwd, {
      branch: prepared.vcs.problem ? undefined : prepared.vcs.branch,
    });
    if (conflicts.length > 0) {
      stopCode = 'contract-conflict';
      sink.event('contract-conflict', { conflicts }, `the task contradicts itself: ${conflicts.join(' | ')}`, 'error');
      return await finish('blocked', `the task contradicts itself, so it was not started: ${conflicts.join(' ')} Change the prompt, the checks, the scope or read-only, and queue it again.`);
    }
    /*
     * A plan check the runner refuses for its own command line can never run, so the task can never
     * pass: said now, before a message is sent, and not at the first "done" (live run 2026-10-03: eight
     * iterations and two and a half minutes for a curl to the internet the checks may not make).
     */
    const neverRun = (task.checks ?? [])
      .filter((c) => !!c.run?.trim())
      .map((c) => ({ c, why: lineRefusal((c.run ?? '').trim(), c.shell ?? defaultShell, c.cwd ? resolve(work.cwd, c.cwd) : work.cwd, cfg.execution, confinement.roots) }))
      .filter((x): x is { c: TaskCheck; why: string } => !!x.why);
    if (neverRun.length > 0) {
      stopCode = 'invalid-check';
      const said = neverRun.map((x) => `"${x.c.name}": ${checkRefusalForOperator(x.why)}`).join(' ');
      sink.event('checks-invalid', { round: 0, checks: neverRun.map((x) => x.c.name) }, `the runner refuses ${neverRun.length} of the task's checks for their command line, so it was not started: ${said}`, 'error');
      return await finish('failed', `the runner refuses ${neverRun.length} of this task's checks for their own command line, so the task could never pass and was not started: ${said} Change those checks and queue it again.`);
    }

    /*
     * "Continue" carries a task on in the conversation that has it, which is the session's own
     * unless the session has moved since — a later task's retry in a fresh conversation moves it.
     * Then "carry on; the assignment is the one you were given above", sent where the session is
     * now, landed in a conversation that had never seen the task. So the attempt's own conversation
     * is opened again and the session goes back to it, the later queued tasks with it; where that
     * cannot be done, a fresh one is opened and the task goes out in full, with the contract,
     * saying that it continues an earlier attempt (see `composeOpening`).
     *
     * An attempt stopped before its task was sent gave it to no conversation at all, so "carry on"
     * has nothing to point at anywhere: the task goes out in full where the session is, as it would
     * have the first time, since no chat has done any of it. See `conversationOfAttempt`.
     */
    /** What the opening says about the attempts before this one; see `composeOpening`. */
    let continuing = task.continuing;
    let buildsOn = task.buildsOn;
    if (task.continuing) {
      const found = await conversationOfAttempt(cfg.resolved.runsDir, task.attempts ?? [], session.chat);
      if (found.where === 'nowhere') {
        continuing = undefined;
        buildsOn = found.buildsOn;
        sink.event('continue-never-sent', { fromAttempt: task.continuing.fromAttempt },
          'the attempt this continues was stopped before its task reached any conversation, so the task goes out in full');
      }
      if (found.where === 'elsewhere') {
        const own = found.pointer;
        // By its id only. Every conversation of a session carries the session's name, the fresh
        // ones a retry opens included, so the name would find one of those just as readily.
        const back = !!own && (await transport.openConversation(own.chatId).catch(() => false));
        if (!back) await transport.newChat();
        const chat = back && own ? own : undefined;
        session.chat = chat;
        session.contractSent = !!chat;
        await store.updateSession(session.id, (s) => {
          s.chat = chat;
          s.contractSent = !!chat;
        });
        sink.event(
          back ? 'chat-returned' : 'chat-fresh-for-continue',
          { chatId: chat?.chatId ?? null, from: own?.chatId ?? null },
          back
            ? `continuing in the task's own conversation "${own?.name}", where it was stopped; the session carries on there`
            : `the conversation this task was stopped in is not the session's any more and ${own ? 'could not be opened again' : 'is not on record'}, so it continues in a fresh one, sent in full`,
          back ? 'info' : 'warn',
        );
        /*
         * The picker belongs to the conversation, and the run applied the session's model to the one
         * it started in, not to this one: a fresh conversation opens on the chat's default, and the
         * record would go on naming the model the session asked for. Applied again here, as the
         * fresh-chat retry in `runSession` does for the same reason.
         */
        const modelNow = await applySessionModel(transport, session, bus, cfg, store, deps.models);
        if (effectiveModels(session, cfg).model) {
          await store.updateSession(session.id, (s) => {
            s.modelInUse = modelNow.current;
          });
        }
        if (modelNow.refused) {
          stopCode = 'environment';
          return await finish('blocked', modelNow.refused);
        }
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
      // Said of the session's conversation, so with none on record nothing has had it: this run
      // entered a fresh one (see `enterSessionConversation`), whatever an older record says.
      contractAlreadySent: session.contractSent && !!session.chat,
      continuing,
      buildsOn,
      workDirNote: workingDirNote(work),
      vcsNote: prepared.note,
      // What is said about a commit is true only where one happens (live run 2026-10-03: promised with commits off).
      readOnlyNote: task.readOnly ? readOnlyNote(!!(session.vcs?.enabled && session.vcs.commitOnFinish !== false && trackedRepoOf(session)), artifactPatterns(session.vcs)) : undefined,
      scopeNote: [
        scopeNote(scope, scopeEnforced, {
          artifacts: artifactPatterns(session.vcs),
          outputs: task.outputs ?? [],
          // The real reason it is not enforced, not always "version control is off" (live run 2026-10-03).
          why: !session.vcs?.enabled
            ? 'Version control is off for this session'
            : prepared.vcs.problem
              // Said here in full: the chat is never shown the results' "Version control" section (live run 2026-10-04).
              ? `This task has no branch of its own: version control could not prepare one (${prepared.vcs.problem.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')})`
              : 'This task has no branch of its own',
        }),
        (task.outputs?.length ?? 0) > 0
          ? `## Outputs\n\nThis task is to produce: ${(task.outputs ?? []).map((o) => `\`${o}\``).join(', ')}. What it creates or changes there is kept with the run's record as its evidence.`
          : '',
      ].filter(Boolean).join('\n\n'),
      approachesNote:
        minApproaches > MIN_TRIED_APPROACHES
          ? `## Giving up\n\nThis task may end with status "blocked" only after at least ${minApproaches} genuinely different approaches, ` +
            `each listed in "tried". With fewer, the runner asks you for another approach instead of accepting it.`
          : undefined,
      shellNote: shellNote(shells, defaultShell),
    });
    await setTask((t) => {
      t.firstMessage = opening.firstMessage;
    });
    await record('OPENING MESSAGE', opening.firstMessage);

    let lastMarkdown = '';
    // The task is always in the last message of the opening; a first one before it is the contract.
    const taskIndex = opening.messages.length - 1;
    /** Whether this opening's contract has been answered, to be recorded once the conversation is. */
    let contractAnswered = false;
    inOpening = true;
    for (const [index, message] of opening.messages.entries()) {
      if (signal?.aborted) return await finish('aborted', 'stopped before the task was sent');
      await pacer.throttleSend();
      const before = await transport.sendAndConfirm(message);
      const carriesTask = index === taskIndex;
      sink.event('message-sent', { index, of: opening.messages.length, task: carriesTask, chatId: session.chat?.chatId ?? null, chars: message.length },
        `message ${index + 1}/${opening.messages.length} sent`);
      /*
       * Where this attempt's task is, kept in its run folder once the message carrying it is in a
       * conversation, and not before: what "Continue" goes back to (see `conversationOfAttempt`). It
       * was kept as soon as the attempt entered a conversation, so an attempt stopped before its task
       * went out — or after a new conversation had answered only the contract — left a record saying
       * the task was there, and "Continue" told that chat to carry on with an assignment it never had.
       * A new conversation is known only once it answers, and is kept where it is registered, below.
       */
      if (carriesTask && session.chat) await savePointer(log.path('chat.json'), session.chat);

      const reply = await transport.waitForReply(before);
      lastMarkdown = reply.markdown;
      await saveReply(`opening-${index + 1}`, reply);
      await pacer.settle();

      // The conversation exists now: register it and name it, once per session.
      if (!session.chat) {
        const chatId = await transport.currentChatId();
        if (chatId) {
          // A fresh-chat retry, or any later attempt, says so in the name: the abandoned chat had the same one (live run 2026-10-03).
          // Only a retry in a fresh chat is named apart; a first conversation is not, whatever the attempt number.
          const name = buildChatName(`${chatCode(session.id)}${task.freshRetry ? `/a${attempt}` : ''}`, session.name);
          const named = await transport.nameChat(chatId, name).catch(() => false);
          const chat: ChatPointer = {
            chatId,
            url: `${cfg.copilot.url.replace(/\/chat.*$/, '')}/chat/conversation/${chatId}?es=SSR`,
            name,
            ...(named ? {} : { named: false }),
            runId,
            createdAt: new Date().toISOString(),
          };
          session.chat = chat;
          await store.updateSession(session.id, (s) => {
            s.chat = chat;
          });
          if (carriesTask) await savePointer(log.path('chat.json'), chat);
          sink.event('chat-registered', { ...chat }, `chat: ${name}${named ? '' : " (not renamed in Copilot's sidebar: it keeps Copilot's own title)"}`, named ? 'info' : 'warn');
        }
      }
      /*
       * The contract is in the conversation once its message has been answered, whether or not the
       * task follows. Recorded only after the whole opening, a Stop between the two left a
       * conversation that had the contract on record as one that had not, and the next task sent it
       * a second time.
       *
       * And recorded once that conversation is on record itself, which may be a message later: its
       * id is read from the page's address, which may not have changed yet when the contract is
       * answered (the registration above tries again after the task). Recorded before, a Stop in
       * between left a session with no conversation that said it had the contract, and the next
       * task opened a fresh one and sent it only the reminder that the contract "still applies".
       */
      if (index < taskIndex) contractAnswered = true;
      if (contractAnswered && session.chat && !session.contractSent) {
        session.contractSent = true;
        await store.updateSession(session.id, (s) => {
          s.contractSent = true;
        });
      }
    }
    inOpening = false;

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
    const willCommit = !!(session.vcs?.commitOnFinish && trackedRepoOf(session));
    /** The runner's own checks that have been pointed out to the chat once already. */
    /** Per runner check, the findings the chat has been shown: "path<TAB>kind", the first two columns of its output. */
    const pointedOut = new Map<string, Set<string>>();

    /**
     * Whether "done" is accepted, decided by the operator's checks rather than by the reply.
     *
     * Returns `accept` when there is nothing to check or everything passed, `retry` when the
     * failures have been sent back for Copilot to fix, `give-up` when it has had its rounds,
     * `environment` when the machine could not run the checks at all, `invalid` when every
     * failing check was refused for good (see `refusedForGood`), and `stopped` when the operator
     * stopped the run while they ran. The checks run here, at the end, and not as steps: they are
     * not work, they are the question of whether the work happened, and a task cannot be trusted
     * to answer that about itself.
     */
    const gateOnChecks = async (): Promise<'accept' | 'retry' | 'give-up' | 'environment' | 'invalid' | 'stopped'> => {
      const every = [...(task.checks ?? []), ...activeChecks(reviewChecks)];
      // Whether the tree is clean is decided after the runner's commit; see `afterCommitChecks`.
      const deferred = willCommit ? every.filter(readsTreeClean) : [];
      if (deferred.length > 0 && afterCommitChecks.length === 0) {
        sink.event('checks-after-commit', { checks: deferred.map((c) => c.name) },
          `${deferred.length} check(s) about a clean working tree are decided after the runner commits the work: ${deferred.map((c) => c.name).join(', ')}`);
      }
      afterCommitChecks = deferred;
      const checks = [...every.filter((c) => !deferred.includes(c)), ...(willCommit ? [COMMIT_CLEAN_CHECK, CONTENT_CLEAN_CHECK] : [])];
      if (checks.length === 0) return 'accept';

      // Counted only once the round turns out to have been a real attempt. A round that died of
      // a missing interpreter asked nothing of the work and must not cost the task one.
      const round = checkRounds + 1;
      if (watchesTree) preGateState = await treeState(repoDirOf(session));
      sink.event('checks-started', { round, count: checks.length },
        `checking the task against ${checks.length} condition(s)`);

      /** The commands this round refused only for what the project's files hold now; see `lineRefusal`. */
      const refusedForTheFiles = new Set<string>();
      const checkOptions: Parameters<typeof runChecks>[1] = {
        cwd: work.cwd,
        tracker,
        passEnv: cfg.execution.passEnv,
        logDir: log.path('checks'),
        signal: deps.signal,
        /*
         * A check runs at the gate with nobody asked, so a download in one — a plan's own check or a
         * reviewer's — is refused rather than held: there is no approval screen here. Requests to
         * this machine are not downloads and still run. See `network.ts`.
         */
        deny: (command, shell, cwd) => {
          const refused = checkCommandRefusal(command, shell, cfg.execution, { roots: confinement.roots, cwd });
          if (refused && !lineRefusal(command, shell, cwd, cfg.execution, confinement.roots)) refusedForTheFiles.add(command);
          return refused;
        },
        roots: confinement.roots,
        repoDir: willCommit ? repoDirOf(session) : undefined,
        baseCommit: prepared.vcs.baseCommit,
        // The same shell a step that named none is given, so the gate and the work it judges
        // cannot have been read by different interpreters.
        defaultShell,
        // What a check says is quoted to the chat — here, and in a reviewer's brief — so the
        // operator's own patterns are applied where it is said, with the built-in shapes.
        redactPatterns: cfg.report.redactPatterns,
      };
      runAfterCommit = (cs) => runChecks(cs, checkOptions);
      const ran: CheckOutcome[] = await runChecks(checks, checkOptions);

      /*
       * The operator stopped the run, which is not a verdict on the work. The check in flight was
       * killed and the ones after it never ran, so what this round "found" is only the Stop: it is
       * not recorded as the task's results, not counted as a rejected "done", and the task ends
       * `aborted` — continuable, like every other Stop. It used to be read as a failed round and
       * end the task `failed`, which "Continue" does not offer.
       */
      if (deps.signal?.aborted) {
        sink.event('checks-stopped', { round }, 'the operator stopped the run while the checks ran; this round decides nothing', 'warn');
        return 'stopped';
      }

      /** Refused before it ran for its own command line, which nothing in the tree decides; see `lineRefusal`. */
      const refusedForGood = (o: CheckOutcome): boolean => !!o.refusedBeforeRunning && !refusedForTheFiles.has((o.check.run ?? '').trim());

      /*
       * A reviewer's check the runner now refuses for its own line: dropped, and the round judged on
       * the others. The review keeps no check the runner refuses (see `validateDerivedChecks`), but
       * one it kept can be refused later — a deny pattern added in Settings, the allowlist narrowed,
       * the project folders changed — and it then outlives every attempt, Continue and a rerun
       * included. Read as a check of the task's that can never run, it ended each of them at the
       * first "done" as `invalid-check`, with no way out; before that it was sent back as work to
       * fix. The finding stands without it, as at the review, and the next reviewer judges the work.
       */
      const unrunnable = ran.filter((o) => isDerivedCheck(o.check) && refusedForGood(o));
      if (unrunnable.length > 0) {
        const why = new Map(unrunnable.map((o) => [o.check.name, o.detail]));
        reviewChecks = reviewChecks.map((rc) =>
          rc.state === 'active' && why.has(rc.check.name)
            ? { ...rc, state: 'dropped' as const, droppedBecause: `the runner refuses it now, before it runs: ${why.get(rc.check.name)}` }
            : rc,
        );
        await setTask((t) => {
          t.reviewChecks = reviewChecks;
        });
        for (const o of unrunnable) {
          sink.event('review-check-blocked', { round, name: o.check.name, detail: o.detail },
            `the check "${o.check.name}" is refused by the runner now and never ran; dropped, the finding stands without it — ${o.detail}`, 'warn');
        }
      }
      const outcomes = ran.filter((o) => !unrunnable.includes(o));
      lastOutcomes = outcomes;

      /*
       * The runner's own checks are advice given once, not a gate: a second "done" with the finding
       * still there is committed and the finding stays on the task. Refusing instead would leave the
       * tree dirty and the next task unable to start. Each check is pointed out once on its own, so a
       * content problem found after the paths were settled still gets its one mention.
       */
      /*
       * Once per finding, not once per kind of check: keyed by kind, a problem in a file the chat wrote
       * after the only mention passed as "still there after being pointed out once" without ever being
       * shown (live run 2026-10-03, helper scripts with mixed line endings committed unseen).
       */
      for (const o of outcomes) {
        if (!RUNNER_CHECK_KINDS.has(o.check.expect) || o.passed) continue;
        const keys = (o.output ?? o.detail).split('\n').map((l) => l.split('\t').slice(0, 2).join('\t').trim()).filter(Boolean);
        const shown = pointedOut.get(o.check.expect) ?? new Set<string>();
        const fresh = keys.filter((k) => !shown.has(k));
        if (fresh.length === 0) {
          const files = [...new Set(keys.map((k) => k.split('\t')[0]))].join(', ');
          o.passed = true;
          o.detail = `still there after being pointed out once (${files}); committed and kept on the task — ${o.detail}`;
        } else {
          for (const k of keys) shown.add(k);
          pointedOut.set(o.check.expect, shown);
        }
      }

      await setTask((t) => {
        t.checkResults = outcomes.map((o) => ({ name: o.check.name, passed: o.passed, detail: o.detail }));
      });

      /*
       * The machine, not the work.
       *
       * Sending this back to the chat would be asking a language model to install an
       * interpreter, and it would do what it always does with an instruction it cannot carry
       * out: try something else, fail the same way, and use up the rounds. So the round is not
       * counted, nothing is sent, and the task ends on a reason that names what is missing. It
       * is reported once even when every check hit the same wall, because one sentence about
       * one missing interpreter is the whole of what there is to say.
       */
      const problem = environmentProblemIn(outcomes);
      if (problem) {
        environmentProblem = problem;
        sink.event('checks-environment', { round, requested: problem.requested, available: problem.available, checks: outcomes.filter((o) => o.environmentProblem).map((o) => o.check.name) },
          problem.message, 'error');
        return 'environment';
      }

      /*
       * The checks, not the work — the same reasoning as the machine above.
       *
       * Every check still failing was refused before it ran, for its own command line, the
       * settings, or a folder or file outside the project: nothing the chat does can make it run.
       * These are the plan's checks and the runner's own; a reviewer's is dropped instead (above).
       * Sending it back as "the task is not finished yet" spent the rounds on it, and with version
       * control on the second "done" with an unchanged tree ended the task `blocked` as no progress,
       * to be retried in fresh conversations that could not fix it either. So nothing is sent, the
       * round is not counted, and the task ends `failed` with `invalid-check`. A check refused only
       * for what a script it runs holds, or for a tool not installed yet, still goes back: those the
       * work can change (see `lineRefusal`).
       */
      const failed = outcomes.filter((o) => !o.passed);
      /*
       * One check that can never run is enough: the task can never pass it, whatever else the chat fixes.
       * Waiting until it was the only failure sent it to the chat as work, with advice to end blocked, and
       * spent a round on it (live run 2026-10-03).
       */
      const never = failed.filter(refusedForGood);
      if (never.length > 0) {
        stopCode = 'invalid-check';
        for (const o of failed) {
          sink.event('check-failed', { name: o.check.name, detail: o.detail }, `FAILED: ${o.check.name} — ${o.detail}`, 'warn');
        }
        sink.event('checks-invalid', { round, checks: never.map((o) => o.check.name) },
          `${never.length} check(s) were refused before they ran (${never.map((o) => `"${o.check.name}"`).join(', ')}), and nothing the chat does can change that; the task ends on the checks, not on the work`, 'error');
        return 'invalid';
      }
      checkRounds = round;

      for (const o of outcomes) {
        sink.event(o.passed ? 'check-passed' : 'check-failed', { name: o.check.name, detail: o.detail },
          `${o.passed ? 'passed' : 'FAILED'}: ${o.check.name} — ${o.detail}`, o.passed ? 'info' : 'warn');
      }
      /*
       * What the checks themselves wrote outside the scope is put back now, before anything is sent: the
       * next round then starts clean, and the chat is never told it broke the scope for a file a check
       * wrote (live run 2026-10-03).
       */
      if (scopeEnforced) {
        const after = await enforceScope(repoDirOf(session), scope, !!task.readOnly).catch(() => null);
        if (after && after.reverted.length + after.failed.length > 0) {
          sink.event('scope-reverted', { phase: 'checks', round, reverted: after.reverted, failed: after.failed },
            `written by the checks outside the task's ${task.readOnly ? 'read-only rule' : 'scope'}, put back: ${after.reverted.join(', ') || '(none)'}`, 'info');
        }
      }

      if (failed.length === 0) {
        sink.event('checks-passed', { count: outcomes.length }, `all ${outcomes.length} check(s) passed`);
        return 'accept';
      }
      stats.doneRejected += 1;
      // The same failures as last time, and not a file changed since they were reported.
      const stuck = progress.afterFailedChecks(await treeNow(), failed.map((o) => ({ name: o.check.name, detail: o.detail })));
      if (stuck) {
        noProgressReason = stuck;
        stats.stoppedFor = 'no-progress';
        stopCode = 'no-progress';
        sink.event('no-progress', { kind: 'checks' }, stuck, 'warn');
        return 'give-up';
      }
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
        limitHit = { setting: 'maxCheckRounds', value: maxCheckRounds };
        sink.event('checks-exhausted', { rounds: checkRounds - 1 },
          `${failed.length} check(s) still failing after ${maxCheckRounds} attempt(s); the task is closed as failed`, 'warn');
        return 'give-up';
      }
      // A Stop that came after every check had run: the round stands, and nothing more is sent.
      if (deps.signal?.aborted) return 'stopped';

      // The failures go back exactly the way step output does: a message with a file attached,
      // because a compiler's opinion belongs in a file and not in a chat bubble.
      const path = join(reportsDir, `checks-${checkRounds}.txt`);
      /*
       * Check output is uploaded too, so it is redacted the same way a step report is — the file and
       * the message beside it alike, with the operator's patterns on top of the built-in shapes. The
       * message quotes each failing check's command and value, and it used to get the shapes only,
       * so a key in a company's own format went to the chat in it while the file beside it hid it.
       */
      const checkReport = failureReport(outcomes, cfg.report.redactPatterns);
      await writeFile(path, checkReport, 'utf8');
      await record(`CHECKS ${checkRounds}`, checkReport);
      const message = failureMessage(outcomes, checkRounds, maxCheckRounds, cfg.report.redactPatterns);
      await record(`CHECKS ${checkRounds} MESSAGE SENT`, message);
      // Said as a step report's redaction is, so a checks round that hid something is not silent.
      const redactions = failureRedactions(outcomes, cfg.report.redactPatterns);
      if (redactions.length > 0) {
        sink.event('report-redacted', { round: checkRounds, iteration: iterations, checks: true, redactions },
          `redacted from the checks of round ${checkRounds} before upload: ${redactions.map((r) => `${r.count}× ${r.name}`).join(', ')}`, 'warn');
      }

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
     * `stopped` — the operator stopped the run while the review was going.
     */
    const gateOnReview = async (closing: string | undefined): Promise<'accept' | 'retry' | 'give-up' | 'stopped'> => {
      if (!reviewWanted) {
        await saveReview({ verdict: 'skipped', rounds: 0, stepsRun: 0, skippedBecause: `the review is switched off for this ${task.reviewEnabled === false ? 'task' : 'session'}` });
        return 'accept';
      }

      reviewRounds += 1;

      const model = effectiveModels(session, cfg).reviewModel;
      const repoDir = trackedRepoOf(session);
      /*
       * What changed, read from git rather than from anybody's account of it.
       *
       * The commit happens when the task closes, which is after this, so the task's changes are
       * still sitting in the working tree. That is exactly the list wanted: the branch was cut
       * before this task started, so everything dirty now is this task's doing.
       */
      const changedFiles = repoDir ? (await repoState(repoDir).catch(() => null))?.changed ?? [] : [];
      // When nothing changed, or nothing was allowed to, the closing account is the product and
      // the reviewer is given it — as claims to test. See `Deliverable` in review.ts.
      const deliverable = deliverableFor(task, closing, repoDir !== '', changedFiles);

      sink.event('review-started', { round: reviewRounds, model: model || '(the session model)', files: changedFiles.length, deliverable: deliverable?.why },
        `an independent review is opening a fresh conversation (round ${reviewRounds} of ${maxReviewRounds})` +
          (deliverable ? `; the closing summary goes with it as the product (${deliverable.why})` : ''));

      // What is running before the review, so that what the review leaves is its own.
      const beforeReview: ProcessSnapshot | null = processesBefore ? await snapshotProcesses(work.cwd, processesBefore.since).catch(() => null) : null;
      let roundLeftovers: Array<{ name: string; ports: number[] }> = [];
      let outcome: ReviewOutcome;
      try {
        await transport.newChat();
        if (model) {
          const reviewLocator = await deps.models?.locate?.(model).catch(() => undefined);
          const picked: ModelChoice = await transport.selectModel(model, { locator: reviewLocator }).catch((e: unknown) => ({ ok: false, current: null, reason: (e as Error).message }));
          const renamed = await followPageModels('review', model, picked, session, store, deps.models);
          if (renamed) sink.event('model-renamed', { asked: model, chosen: picked.matched, review: true }, renamed, 'warn');
          sink.event(picked.ok ? 'review-model-selected' : 'review-model-not-selected', { asked: model, current: picked.current },
            picked.ok ? `the review runs on ${picked.current ?? model}` : `the review could not switch to "${model}": ${picked.reason ?? 'unknown reason'}`,
            picked.ok ? 'info' : 'warn');
        }

        outcome = await runReview(sendsUntilStopped(transport, signal), session, task, {
          cfg,
          authorizer,
          signal,
          pacer,
          dir: log.path('review', String(reviewRounds)),
          round: reviewRounds,
          cwd: work.cwd,
          roots: confinement.roots,
          tracker,
          changedFiles,
          deliverable,
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
       * Stopped by the operator: neither a verdict on the work nor the machinery failing.
       *
       * The review reports a Stop the way it reports a broken browser — an error, "the run was
       * stopped" — and an error accepts the work unreviewed (below), so a task stopped in its
       * review was closed `done` and committed, and "Continue" could not carry it on. The round is
       * recorded as cut short, and the task ends `aborted`, as every Stop ends it.
       */
      if (signal?.aborted) {
        await saveReview({
          verdict: 'error',
          rounds: reviewRounds,
          stepsRun: outcome.stepsRun,
          problem: `the run was stopped by the operator during review round ${reviewRounds}, before a verdict was acted on`,
          model: model || undefined,
        });
        sink.event('review-stopped', { round: reviewRounds, stepsRun: outcome.stepsRun },
          `the operator stopped the run during review round ${reviewRounds}; the work is neither accepted nor sent back`, 'warn');
        return 'stopped';
      }

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
        id: (f as { id?: string }).id ?? findingId(reviewRounds, i, attempt),
        ...(repeated.includes(f) ? { repeated: true } : {}),
      }));
      outcome = { ...outcome, findings: named };
      const repeatedNamed = named.filter((f) => f.repeated);

      /*
       * What this verdict does to the derived checks: the ones this reviewer gave join the
       * task; the ones suspended by a dispute or by spent rounds come back if the finding was
       * raised again, and go if it was not.
       */
      if (outcome.verdict === 'fail') stats.reviewRejections += 1;
      if (outcome.verdict === 'pass' || outcome.verdict === 'fail') {
        for (const d of outcome.derivedChecks ?? []) {
          reviewChecks = [...reviewChecks, { check: d.check, findingId: d.findingId, what: d.what, where: d.where, round: reviewRounds, attempt, state: 'active' }];
        }
        const settled = settleAfterReview(reviewChecks, outcome.verdict, named);
        reviewChecks = settled.checks;
        /*
         * A read-only task never carries an active derived check, whatever a review says.
         *
         * New ones are not kept (see review.ts), and one kept before this rule — or before the
         * task was marked read-only — must not be revived by a later round either: it is a
         * command against a repository the task may not touch, so raising the finding again
         * does not give the task a lever, it only puts the same immovable condition back in
         * the gate. The finding itself still travels and still fails the work.
         */
        if (task.readOnly) {
          const revived = reviewChecks.filter((rc) => rc.state === 'active').map((rc) => rc.findingId);
          if (revived.length > 0) {
            sink.event('review-check-not-kept-readonly', { findings: revived },
              `this task may not change files, so the check(s) from ${revived.join(', ')} stay out of the gate; the finding(s) stand`, 'warn');
          }
          reviewChecks = reviewChecks.map((rc) => (rc.state === 'active' ? { ...rc, state: 'suspended' as const } : rc));
        }
        if (settled.reactivated.length > 0 && !task.readOnly) {
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
        limitHit = { setting: 'maxReviewRounds', value: maxReviewRounds };
        sink.event('review-exhausted', { rounds: maxReviewRounds, findings: outcome.findings.length },
          `the review still has findings after ${maxReviewRounds} round(s) of fixing; the task is closed as blocked`, 'warn');
        return 'give-up';
      }

      sink.event('review-failed', { round: reviewRounds, findings: outcome.findings.length },
        `the review found ${outcome.findings.length} problem(s); sending them back to be fixed`, 'warn');
      // A Stop that came after the verdict: it stands on the record, and nothing more is sent.
      if (signal?.aborted) return 'stopped';

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

    /**
     * What a reported "done" comes to: the checks, then the review, either of which may end the
     * task here. Null means the work went back to the chat and the loop goes on.
     *
     * One place for both ways a "done" arrives — on its own, and after the report of its last
     * steps — which used to be two copies of the same lines, and the Stop has to be answered the
     * same way in both. A Stop while the checks run, or during the review, ends the task `aborted`;
     * one that comes after the checks have accepted the work ends it before a review conversation
     * is opened for it. A verdict the checks reached on their own — out of rounds, no progress,
     * checks that cannot run — stands.
     *
     * With the review switched off there is no conversation to keep from opening, and nothing left
     * to judge once the checks have accepted the work: a Stop then leaves the task done, its review
     * recorded as skipped. Ended `aborted` "before the review", it named a review that did not
     * exist, and a batch that stops on a failure counted it as one and skipped the sessions after.
     */
    const settleDone = async (summary: string | undefined): Promise<TaskOutcome | null> => {
      const verdict = await gateOnChecks();
      if (verdict === 'stopped') return await finish('aborted', 'stopped by the operator while the checks ran', summary, lastMarkdown);
      if (verdict === 'environment') {
        stopCode = 'environment';
        return await finish('failed', shellProblemReason(environmentProblem), summary, lastMarkdown);
      }
      // Its stop code is set by the gate: every failing check was refused for good.
      if (verdict === 'invalid') return await finish('failed', checksFailedReason(lastOutcomes), summary, lastMarkdown);
      if (verdict === 'give-up') {
        if (noProgressReason) return await finish('blocked', noProgressReason, summary, lastMarkdown);
        // Every failing check was refused before it ran: a verdict on the checks, not on the work.
        if (lastOutcomes.some((o) => !o.passed) && lastOutcomes.every((o) => o.passed || o.refusedBeforeRunning)) stopCode = 'invalid-check';
        return await finish('failed', checksFailedReason(lastOutcomes), summary, lastMarkdown);
      }
      if (verdict === 'retry') return null;
      if (reviewWanted && signal?.aborted) return await finish('aborted', 'stopped by the operator before the review', summary, lastMarkdown);
      const reviewed = await gateOnReview(summary);
      if (reviewed === 'stopped') return await finish('aborted', 'stopped by the operator during the review', summary, lastMarkdown);
      if (reviewed === 'accept') return await finish('done', undefined, summary, lastMarkdown);
      if (reviewed === 'give-up') return await finish('blocked', reviewBlockedReason(), summary, lastMarkdown);
      return null;
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
    /*
     * With each command, the working tree as it was after it ran and how many steps had run by then. A
     * repeat is refused only when nothing has changed since: found live on 2026-10-03, a read-back right
     * after a step had rewritten the file was refused as "the same result", judged from history alone.
     */
    const seen = new Map<string, { sameInARow: number; signature: string; tree: string | null; stepNo: number }>();
    /** Steps that ran in this attempt, of any kind; a "blocked" before the first one is not an approach. */
    let stepsRunThisAttempt = 0;
    const fingerprint = (step: Step): string => step.cmd.replace(/\s+/g, ' ').trim();
    /** What "the same answer" means: the exit code and the output, hashed. */
    const resultSignature = (r: RunResult): string =>
      createHash('sha256').update(`${r.exitCode}\u0000${r.outcome}\u0000${r.stdout}\u0000${r.stderr}`).digest('hex');
    let stalled = 0;

    for (;;) {
      if (signal?.aborted) return await finish('aborted', 'stopped by the operator');
      if (Date.now() > deadline) {
        limitHit = { setting: 'maxRunMinutes', value: cfg.limits.maxRunMinutes };
        return await finish('limit-reached', `maxRunMinutes (${cfg.limits.maxRunMinutes}) reached`);
      }
      if (iterations >= cfg.limits.maxIterations) {
        limitHit = { setting: 'maxIterations', value: cfg.limits.maxIterations };
        return await finish('limit-reached', `maxIterations (${cfg.limits.maxIterations}) reached`);
      }

      const parsed = parseReply(lastMarkdown, {
        stopMarker: cfg.copilot.stopMarker,
        defaultShell,
      });

      if (!parsed.ok) {
        formatRetries += 1;
        stats.formatErrors += 1;
        sink.event('format-error', { reason: parsed.reason, detail: parsed.detail },
          `reply did not match the contract (${parsed.reason}), retry ${formatRetries}/${cfg.limits.maxFormatRetries}`, 'warn');
        /*
         * Out of format retries: stopped at a limit, not failed.
         *
         * Nothing about the work went wrong here — the steps that ran are recorded, their output is
         * in the run folder, and the rejected replies ran nothing. So the task ends `limit-reached`,
         * marked `format-repair-exhausted`, which is what lets "Continue in the same chat" carry it
         * on from exactly here instead of the operator having to run it again from the start. It
         * used to end `failed`, which read as a verdict on the work and offered only a fresh start.
         */
        if (formatRetries > cfg.limits.maxFormatRetries) {
          await transport.dumpFailure(log.path('failures'), 'format-error');
          stopCode = 'format-repair-exhausted';
          limitHit = { setting: 'maxFormatRetries', value: cfg.limits.maxFormatRetries };
          return await finish(
            'limit-reached',
            // The parser's detail is a sentence of its own, often with its own full stop.
            sentences(
              `format repair exhausted: ${formatRetries} replies in a row did not match the format (maxFormatRetries ${cfg.limits.maxFormatRetries}), ` +
                `the last one refused for this: ${parsed.detail}`,
              'Nothing from those replies was run; the work so far is kept.',
            ),
            undefined,
            lastMarkdown,
          );
        }
        await pacer.throttleSend();
        const before = await transport.sendAndConfirm(formatErrorMessage(parsed, formatRetries, cfg.limits.maxFormatRetries));
        const again = await transport.waitForReply(before);
        await saveReply(`format-retry-${formatRetries}`, again);
        lastMarkdown = again.markdown;
        continue;
      }

      formatRetries = 0;
      if (parsed.coerced) {
        sink.event('format-coerced', { fields: parsed.coerced },
          `read as text: ${parsed.coerced.join(', ')} arrived in another shape; nothing in them is run, so the reply was taken as it was`);
      }
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
      if (!blocked && reply.steps.length > 0) earlyBlocks = 0;
      /*
       * "Blocked" before a single step ran in this attempt: what it lists as tried was thinking, not
       * trying. Seen live on 2026-10-03, twice: a chat that said it cannot "operate under an external
       * runner" blocked on its first reply with two free-text entries in `tried`, which passed the
       * two-approaches floor, and the task went to a fresh chat. It is told what the runner is first.
       */
      if (blocked && stepsRunThisAttempt === 0 && earlyBlocks < MAX_EARLY_BLOCKS) {
        earlyBlocks += 1;
        stats.blockedTooEarly = (stats.blockedTooEarly ?? 0) + 1;
        sink.event('blocked-before-any-step', { tried: reply.tried.length, time: earlyBlocks },
          '"blocked" before any step ran in this task, so the chat is told how the runner works and asked for a first step', 'warn');
        /*
         * A continued task has run steps before, in its earlier attempt, and a chat that blocks there has
         * usually lost the assignment, said "above": it is given again rather than told nothing ran (live run 2026-10-04).
         */
        const message = task.continuing
          ? 'Not yet: this task is being continued, and nothing has run since. The assignment is this one, unchanged:\n\n' +
            `${task.prompt.length > 6000 ? `${task.prompt.slice(0, 6000)}…` : task.prompt}\n\n` +
            'Carry on from where it stopped: send your next step now with status "continue", for example a command that shows ' +
            'the state of the files the task works on. A task may end "blocked" only after steps that ran.'
          : 'Not yet: nothing has been run in this task. You do not need to operate anything yourself — this runner executes ' +
            'the commands you send in "steps", on the operator\'s machine in the project folder, and sends you back what they printed. ' +
            'Send your first step now with status "continue", for example a command that lists the project\'s files ' +
            '(Get-ChildItem -Recurse -File | Select-Object -First 50 FullName). A task may end "blocked" only after steps that ran.';
        await record('BLOCKED BEFORE ANY STEP — MESSAGE SENT', message);
        await pacer.throttleSend();
        const before = await transport.sendAndConfirm(message);
        const next = await transport.waitForReply(before);
        await saveReply(`blocked-before-any-step-${earlyBlocks}`, next);
        lastMarkdown = next.markdown;
        await pacer.settle();
        continue;
      }
      if (blocked && reply.tried.length < minApproaches && earlyBlocks < MAX_EARLY_BLOCKS) {
        /*
         * Too early to give up, by the operator's own measure (Settings → Execution). Sent back as a
         * request for another approach rather than accepted: the format only knows that two is the
         * floor, the operator decided this work deserves more tries than that.
         */
        earlyBlocks += 1;
        stats.blockedTooEarly = (stats.blockedTooEarly ?? 0) + 1;
        sink.event('blocked-too-early', { tried: reply.tried.length, needed: minApproaches, time: earlyBlocks },
          `"blocked" after ${reply.tried.length} approach(es); Settings ask for ${minApproaches}, so the chat is asked for another`, 'warn');
        const message =
          `Not yet. This task is given up only after at least ${minApproaches} genuinely different approaches, and your reply lists ` +
          `${reply.tried.length}: ${reply.tried.map((x, i) => `(${i + 1}) ${x}`).join(' ')}. Try a different approach now — not one of ` +
          'these again, and not the same command reworded — and send its steps with status "continue". If it fails too, add it to ' +
          '"tried" and try another. Nothing you listed is lost: the runner keeps what has been tried.';
        await record('BLOCKED TOO EARLY — MESSAGE SENT', message);
        await pacer.throttleSend();
        const before = await transport.sendAndConfirm(message);
        const next = await transport.waitForReply(before);
        await saveReply(`blocked-too-early-${earlyBlocks}`, next);
        lastMarkdown = next.markdown;
        await pacer.settle();
        continue;
      }
      if (blocked) {
        sink.event('task-blocked', { tried: reply.tried, needed: reply.needed },
          `the task was given up as blocked after ${reply.tried.length} approach(es)`, 'warn');
        const early = reply.tried.length < minApproaches
          ? `It gave up after ${reply.tried.length} of the ${minApproaches} approaches Settings ask for, having been asked ${earlyBlocks} time(s) for another.`
          : '';
        return await finish('blocked', sentences(blockedReason(reply.tried, reply.needed), early), reply.summary, lastMarkdown);
      }

      if (done && reply.steps.length === 0) {
        const ended = await settleDone(reply.summary);
        if (ended) return ended;
        continue;
      }


      // --- execute -----------------------------------------------------------------
      const results: RunResult[] = [];
      let aborted = false;
      /** How many of this iteration's steps were turned away for being repeats. */
      let repeatsRefused = 0;
      /** Steps refused because they named a shell this machine has not got. */
      let shellRefused = 0;

      /*
       * The step of this reply that was refused, once one was: the steps after it are not run. They were,
       * and the chat got test results from a tree its own plan had not produced — a write refused, the
       * tests run on the old code (live run 2026-10-03).
       */
      let refusedAt: number | null = null;
      for (const step of reply.steps) {
        if (signal?.aborted) {
          results.push(refusedResult(step, 'stopped by the operator', 'operator'));
          aborted = true;
          break;
        }
        if (refusedAt !== null) {
          sink.event('step-skipped', { id: step.id, reason: `step ${refusedAt} was refused`, by: 'runner', after: refusedAt }, `step ${step.id} not run: step ${refusedAt} was refused`, 'info');
          results.push(refusedResult(step, `not run, because step ${refusedAt} of this reply was refused: it would have run on a tree your plan did not produce. Send it again after step ${refusedAt} is replaced.`, 'runner', refusedAt));
          continue;
        }

        {
          const damage = findLikelyDamage(step.cmd);
          if (damage) {
            sink.event('step-damaged', { id: step.id, cmd: step.cmd, damage }, `step ${step.id} arrived damaged: ${damage}`, 'warn');
            results.push(refusedResult(step, `${damage}. ${damageGuidance()}`));
            refusedAt = step.id;
            continue;
          }
        }

        /*
         * The step named a shell this machine has not got.
         *
         * Refused, never substituted — a command written for PowerShell and quietly handed to
         * `cmd` does not fail, it does something else — but refused the way a deny pattern is
         * refused, as one step, and not the way a missing shell under a *check* is: as the end of
         * the task. The difference is who chose the shell. A check's shell is the operator's, set
         * in a plan the chat cannot edit, so nothing the chat does next can help and the task
         * stops on it. A step's shell is the chat's own, and the contract it works to shows
         * `"shell": "pwsh"` in its one example, so on a machine without PowerShell 7 the chat will
         * write that on its first try almost every time. Telling it what the machine actually has
         * and letting it write the step again is the whole mechanism of this bot; killing the task
         * instead would make the machine this change was written for worse off than before it.
         */
        const named = resolveShell(step.shell);
        if (!named.ok) {
          shellRefused += 1;
          sink.event('step-shell-missing', { id: step.id, requested: named.problem.requested, available: named.problem.available },
            `step ${step.id} asked for a shell this machine has not got: ${named.problem.message}`, 'warn');
          results.push(refusedResult(step, refusalForChat(named.problem, defaultShell)));
          continue;
        }

        // Refused before the operator is asked to approve it, because a step that cannot teach
        // anyone anything is not worth a person's attention either.
        const key = fingerprint(step);
        const last = seen.get(key);
        let ran = last?.sameInARow ?? 0;
        if (ran >= maxCommandRepeats && last) {
          // Something changed since it last ran — the tree, or (without a tree to compare) another step ran: not a repeat.
          const nowTree = await treeNow();
          const changed = last.tree !== null && nowTree !== null ? last.tree !== nowTree : stepsRunThisAttempt > last.stepNo;
          if (changed) {
            seen.set(key, { ...last, sameInARow: 0 });
            ran = 0;
          }
        }
        if (ran >= maxCommandRepeats) {
          repeatsRefused += 1;
          stats.repeatsRefused += 1;
          sink.event('step-repeated', { id: step.id, count: ran, limit: maxCommandRepeats, command: describeStep(step) },
            `step ${step.id} refused: already run ${ran} time(s) in this task with the same result`, 'warn');
          results.push(refusedResult(step, repeatRefusal(ran, maxCommandRepeats)));
          continue;
        }

        await setTask((t) => {
          t.status = 'waiting-approval';
        });
        sink.event('step-proposed', { id: step.id, description: describeStep(step) }, `step ${step.id}: ${describeStep(step)}`);
        const decided = await authorizer.authorize(step, { sessionId: session.id, taskId: task.id, iteration: iterations, confinement });
        await setTask((t) => {
          t.status = 'running';
        });
        // A Stop can land while the answer is awaited or written down, after the look at the signal
        // above; whatever was decided, a stopped run does not start the step.
        const decision: typeof decided = decided.action === 'run' && signal?.aborted
          ? { action: 'abort', reason: 'stopped by the operator', by: 'operator' }
          : decided;

        if (decision.action === 'abort') {
          results.push(refusedResult(step, decision.reason, decision.by === 'operator' ? 'operator' : 'runner'));
          aborted = true;
          break;
        }
        if (decision.action === 'skip') {
          sink.event('step-skipped', { id: step.id, reason: decision.reason, by: decision.by ?? 'runner' }, `step ${step.id} skipped: ${decision.reason}`, 'warn');
          results.push(refusedResult(step, decision.reason, decision.by === 'operator' ? 'operator' : 'runner'));
          refusedAt = step.id;
          continue;
        }

        const long = step.expect === 'long';
        const cap = cfg.execution.maxStepTimeoutSec;
        const hard = Math.min(step.timeoutSec ?? (long ? cfg.execution.longCommandTimeoutSec : cfg.execution.commandTimeoutSec), cap);
        const idle = Math.min(step.idleTimeoutSec ?? (long ? cfg.execution.longIdleTimeoutSec : cfg.execution.idleTimeoutSec), cap);

        sink.event('step-started', { id: step.id, shell: step.shell ?? defaultShell }, `running step ${step.id}: ${describeStep(step)}`);
        const result = await runStep(
          {
            id: step.id,
            shell: step.shell ?? defaultShell,
            command: step.cmd,
            cwd: work.cwd,
            hardTimeoutMs: hard * 1000,
            idleTimeoutMs: idle * 1000,
            logPath: log.path('steps', `${iterations}-${step.id}.log`),
            passEnv: cfg.execution.passEnv,
          },
          {
            signal,
            tracker,
            onHeartbeat: ({ elapsedMs, idleMs, lastLine }) =>
              sink.event('step-heartbeat', { id: step.id, elapsedMs, idleMs, lastLine },
                `step ${step.id} still running: ${Math.round(elapsedMs / 1000)}s elapsed, ${Math.round(idleMs / 1000)}s since output${lastLine ? ` — ${lastLine.slice(0, 60)}` : ''}`),
          },
        );

        results.push(result);
        stepsRunThisAttempt += 1;
        // The run counts toward the limit only if it changed nothing about the answer.
        const signature = resultSignature(result);
        const previous = seen.get(key);
        const sameInARow = previous && previous.signature === signature ? previous.sameInARow + 1 : 1;
        // The tree is read only for a command at the limit, the one case it is asked about.
        seen.set(key, { signature, sameInARow, tree: sameInARow >= maxCommandRepeats ? await treeNow() : null, stepNo: stepsRunThisAttempt });
        sink.event('step-finished', { id: step.id, outcome: result.outcome, exitCode: result.exitCode, durationMs: result.durationMs, shell: result.shell, requestedShell: result.requestedShell ?? null, shellPath: result.shellPath ?? '' },
          `step ${step.id}: ${result.outcome}, exit ${result.exitCode}, ${(result.durationMs / 1000).toFixed(1)}s`);

        /*
         * Stopped while it ran. The signal is looked at before each step, and after the last one
         * there is no next one to look before: the cut-short step's report was uploaded and the
         * chat's answer waited for before the top of the loop ended the task, a Stop that took as
         * long as a reply. It ends here instead, the way a Stop between steps does: the report is
         * written for the record, and nothing more is sent.
         */
        if (signal?.aborted) {
          aborted = true;
          break;
        }

        /*
         * The shell itself would not start. The same rule as in the check gate applies, for the
         * same reason: nothing was learned about the work, and the next message would be asking
         * the model to fix an interpreter. The iteration stops here and the task ends on it.
         */
        if (result.shellProblem) {
          environmentProblem = result.shellProblem;
          sink.event('step-environment', { id: step.id, requested: result.requestedShell ?? null, available: result.shellProblem.available },
            result.shellProblem.message, 'error');
          break;
        }

        if (cfg.execution.stopOnFailure && result.exitCode !== 0) {
          sink.event('stop-on-failure', { id: step.id }, 'stopping the iteration: stopOnFailure is set', 'warn');
          break;
        }
        await pacer.settle();
      }

      for (const r of results) {
        if (r.outcome !== 'refused' && r.outcome !== 'aborted') continue;
        if (r.outcome === 'refused') stats.stepsRefused += 1;
        else stats.operatorStops += 1;
        const why = (r.stderr.split('\n')[0] ?? '').replace(/^\[policy\] step not executed: /, '').trim();
        notRun.push({ command: r.command.slice(0, 200), why: why.slice(0, 300) || r.outcome });
      }

      // Ended before the report is written and sent: there is nobody to send it to who could
      // do anything with it, and the reason on the task says what to install or set instead.
      if (environmentProblem) {
        stopCode = 'environment';
        return await finish('failed', shellProblemReason(environmentProblem), reply.summary, lastMarkdown);
      }

      /*
       * The task's scope, as a rule rather than a sentence (see `vcs/scope.ts`): whatever this round
       * changed outside it is put back now, before the chat reads the results and builds on them,
       * and the chat is told in the same message.
       */
      if (scopeEnforced) {
        const check = await enforceScope(repoDirOf(session), scope, !!task.readOnly).catch((e: unknown) => ({
          outside: [] as string[],
          reverted: [] as string[],
          failed: [{ path: '(the working tree)', why: (e as Error).message }],
        }));
        if (check.outside.length > 0 || check.failed.length > 0) {
          sink.event('scope-reverted', { iteration: iterations, reverted: check.reverted, failed: check.failed },
            `${task.readOnly ? 'changed by a read-only task' : "outside the task's scope"}, put back: ${check.reverted.join(', ') || '(none)'}` +
              (check.failed.length > 0 ? `; could not be put back: ${check.failed.map((f) => f.path).join(', ')}` : ''),
            'warn');
          runnerNotes.push(scopeMessage(check, scope, !!task.readOnly));
          stats.scopeReverts += check.reverted.length;
          await setTask((t) => {
            t.scopeReverted = [...new Set([...(t.scopeReverted ?? []), ...check.reverted])];
          });
        }
      }
      await guardInputs(iterations);

      // --- report back ---------------------------------------------------------------
      const report = await writeReport(results, {
        runId,
        task: task.title,
        taskText: task.prompt,
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

      // A Stop said as one, apart from "abort" given to a step: the record could not tell them apart (live run 2026-10-04).
      if (aborted) return await finish('aborted', signal?.aborted ? 'stopped by the operator' : 'the operator aborted the task', undefined, lastMarkdown);

      // A loop in which every round looks new: see `progress.ts`. After the report is written, so
      // the evidence the diagnosis points at is on disk.
      const stuck = progress.afterRound(await treeNow(), results);
      if (stuck) {
        stats.stoppedFor = 'no-progress';
        stopCode = 'no-progress';
        sink.event('no-progress', { kind: 'rounds', iteration: iterations }, stuck, 'warn');
        return await finish('blocked', stuck, reply.summary, lastMarkdown);
      }

      /*
       * Nothing this iteration did anything.
       *
       * Every step was a repeat of something already run, which means the previous refusal was
       * read and ignored. One of those is the model reacting to the refusal; two in a row is a
       * loop, and the task is ended here rather than left to burn through its iterations and
       * die with a message about a limit that explains nothing.
       */
      // A whole iteration of steps naming an interpreter that is not here is the same signature
      // as a whole iteration of repeats: the refusal was read and written past. Counted with
      // them rather than given a mechanism of its own, because the answer is the same one.
      const refusedEverything = repeatsRefused + shellRefused;
      /*
       * Which of the two it was, when it has to be said in a sentence.
       *
       * An iteration can be all repeats, all missing shells, or one of each — and the third case
       * is the one that lies if it is not named. Reported as "every step was a repeat" it also
       * printed an empty list of repeated commands, because the shell-refused step never reached
       * the fingerprint and there was nothing to list.
       */
      const allRepeats = shellRefused === 0;
      const allNamedAMissingShell = repeatsRefused === 0;
      if (reply.steps.length > 0 && refusedEverything === reply.steps.length) {
        stalled += 1;
        sink.event('iteration-stalled', { stalled, limit: maxStalledIterations },
          `every step this iteration ${allRepeats ? 'was a repeat' : allNamedAMissingShell ? 'named a shell this machine has not got' : 'was a repeat or named a shell this machine has not got'} (${stalled}/${maxStalledIterations})`, 'warn');
        if (stalled >= maxStalledIterations) {
          const repeated = [...seen.entries()]
            .filter(([, v]) => v.sameInARow >= maxCommandRepeats)
            .map(([cmd]) => cmd.slice(0, 120));
          return await finish(
            'blocked',
            allRepeats
              ? `the same command(s) were sent again after being refused for repetition, ${stalled} iteration(s) running, ` +
                `so the task was ended rather than left to run out of iterations. Repeated: ${repeated.join(' | ')}`
              : allNamedAMissingShell
                ? `every step named a shell this machine has not got, ${stalled} iteration(s) running, after the chat was ` +
                  'told which shells are here. The task was ended rather than left to run out of iterations.'
                : `every step was either a repeat or named a shell this machine has not got, ${stalled} iteration(s) ` +
                  `running, so the task was ended rather than left to run out of iterations.` +
                  (repeated.length > 0 ? ` Repeated: ${repeated.join(' | ')}` : ''),
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
      if (shellRefused > 0) {
        const here = availableShells(shells);
        covering +=
          here.length === 0
            ? `\n\n${shellRefused} of the ${reply.steps.length} step(s) were not run: this machine has no Windows ` +
              'shell the runner can find, so nothing can be run on it. End the task with status "blocked", and fill ' +
              '"tried" — the format wants two entries there — with what you attempted and this refusal.'
            : `\n\n${shellRefused} of the ${reply.steps.length} step(s) were not run: they named a shell this ` +
              `machine has not got. This machine has ${here.join(' and ')}. Send the same work again with ` +
              `"shell": "${defaultShell}", or leave "shell" out — both give you ${defaultShell} — and write the ` +
              'commands for that shell.';
      }
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
          /*
           * The report went out and the chat is still answering it. Sending it again would stack a
           * second copy under a reply in progress; this is the reply wait from the settings running
           * out, which ends the task at that limit (see the catch at the end), not an upload to retry.
           */
          if (isReplyTimeout(e)) throw e;
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
        const ended = await settleDone(reply.summary);
        if (ended) return ended;
        continue;
      }
      await pacer.settle();
    }
  } catch (e) {
    const message = (e as Error).message;
    /*
     * The chat took longer than Settings allow for a reply. A limit, not a fault: the conversation
     * and the work are where they were, and "Continue" carries the task on in that chat.
     */
    if (isReplyTimeout(e)) {
      sink.event('reply-timeout', { seconds: e.seconds }, message, 'warn');
      limitHit = { setting: 'replyTimeoutSec', value: e.seconds };
      return await finish('limit-reached', `replyTimeoutSec (${e.seconds}) reached: ${message}`);
    }
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
 * The queued tasks of a session a run takes: all of them, or only the ones the operator chose.
 * One rule for the run itself and for every place that counts or records what a run will do, so
 * the batch entrance, the run's record and the run cannot disagree about it.
 */
export function queuedToRun(session: Session, onlyTasks?: ReadonlySet<string> | readonly string[]): Task[] {
  const only = onlyTasks ? new Set(onlyTasks) : undefined;
  return session.tasks.filter((t) => t.status === 'queued' && (!only || only.has(t.id)));
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
    transport?: ChatTransport;
  },
): Promise<{ ran: number; lastStatus?: TaskOutcome['status']; paused: boolean; refused?: string }> {
  const { cfg, store, bus } = deps;
  let session = await store.getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} does not exist.`);

  const queued = queuedToRun(session, deps.onlyTasks);
  if (queued.length === 0) {
    bus.publish({ sessionId, type: 'session-idle', level: 'info', message: 'no queued tasks' });
    return { ran: 0, paused: false };
  }

  // Version control before anything else: a session that may not start is refused with its tasks queued.
  const refused = deps.vcsGate ? await deps.vcsGate(session) : null;
  if (refused) {
    bus.publish({ sessionId, type: 'run-preflight-refused', level: 'warn', message: refused, data: { queued: queued.length } });
    return { ran: 0, paused: false, refused };
  }

  await store.updateSession(sessionId, (s) => {
    s.status = 'running';
  });
  bus.publish({ sessionId, type: 'session-started', level: 'info', message: `${queued.length} task(s) queued` });

  const sessionRunsDir = join(cfg.resolved.runsDir, session.id);
  await mkdir(sessionRunsDir, { recursive: true });

  const borrowed = deps.transport ?? null;
  let transport: ChatTransport | null = borrowed;
  let ran = 0;
  let lastStatus: TaskOutcome['status'] | undefined;
  /** Whether the queue stopped because the operator asked it to hold, rather than because it ended. */
  let paused = false;

  try {
    session = await joinGroupConversation(store, session, bus);

    if (borrowed) {
      speakFor(borrowed, session.id);
      bus.publish({ sessionId, type: 'browser-reused', level: 'info', message: 'using the browser window that is already open' });
      await enterSessionConversation(borrowed, session, { closeOnFailure: false });
    } else {
      await deps.beforeBrowser?.();
      transport = await openSessionTransport(cfg, session, bus, sessionRunsDir);
    }
    const chat = transport as ChatTransport;

    // The picker belongs to the conversation, so the session's choice is applied once, here,
    // before the first task goes out. What the chat ended up on is recorded either way.
    const modelInUse = await applySessionModel(chat, session, bus, cfg, store, deps.models);
    if (effectiveModels(session, cfg).model) {
      await store.updateSession(sessionId, (s) => {
        s.modelInUse = modelInUse.current;
      });
    }
    // Refused before a task is marked started: its tasks stay queued, and the run says why.
    if (modelInUse.refused) throw new Error(modelInUse.refused);

    for (const queuedTask of queued) {
      if (deps.signal?.aborted) break;
      if (deps.shouldPause?.()) {
        paused = true;
        bus.publish({ sessionId, type: 'session-paused', level: 'info',
          message: `paused by the operator after ${ran} task(s); the rest stay queued and the conversation is kept` });
        break;
      }
      session = (await store.getSession(sessionId)) as Session;
      let task = session.tasks.find((t) => t.id === queuedTask.id);
      if (!task || task.status !== 'queued') continue;
      /*
       * A task taken from the queue was started by the operator, never by the retry loop below, which
       * runs its own. A fresh-retry mark on it is left from a retry that was queued and never ran —
       * the new chat failed to open, the program was closed — and counted as this run's, it added the
       * old run's retry to this one's (`freshRetriesOfLatestRun`).
       */
      if (task.freshRetry) {
        session = await store.updateSession(sessionId, (s) => {
          const t = s.tasks.find((x) => x.id === queuedTask.id);
          if (t) t.freshRetry = undefined;
        });
        task = session.tasks.find((t) => t.id === queuedTask.id) as Task;
      }

      let outcome = await runTask(chat, session, task, deps);
      ran += 1;

      /*
       * A blocked task is run again in a fresh conversation, up to the configured number of
       * times, before the verdict stands.
       *
       * No judgement is made about why it blocked; none can be. The move is the one thing that
       * separates the causes: a new chat, with the contract sent again and nothing else in it,
       * cures a cause that lived in the conversation (Copilot no longer seeing the early turns;
       * a history it argued itself into) and cures nothing else. So a task that comes back done
       * was blocked by the chat, and a task that blocks again — in nearly the same words, with
       * both attempts on its record — was not. The operator reads which from the register.
       */
      const retriesAllowed = cfg.limits.retryBlockedInFreshChat ?? 0;
      let retried = 0;
      while (outcome.status === 'blocked' && retried < retriesAllowed && !deps.signal?.aborted && !(outcome.stopCode && NOT_THE_CHATS.includes(outcome.stopCode))) {
        retried += 1;
        bus.publish({
          sessionId,
          taskId: task.id,
          type: 'task-retry-fresh-chat',
          level: 'warn',
          message: `"${task.title}" ended blocked; running it again in a fresh conversation (${retried} of ${retriesAllowed})`,
          data: { attempt: retried, of: retriesAllowed, reason: outcome.reason },
        });
        await store.rerunTask(sessionId, task.id, {});
        // The conversation pointer is dropped, so the next message opens a new chat, registers
        // it and sends the contract again. The old chat stays where it is, readable.
        session = await store.updateSession(sessionId, (s) => {
          s.chat = undefined;
          s.contractSent = false;
          // Marked, not counted: how many retries this run made is read back from the marks
          // (`freshRetriesOfLatestRun`), so a later run cannot add to an earlier one's count.
          const again = s.tasks.find((x) => x.id === task.id);
          if (again) again.freshRetry = true;
        });
        await chat.newChat();
        /*
         * The picker belongs to the conversation, so a new conversation has lost the choice.
         *
         * The model is applied once, before the first task, because that is where the
         * conversation is opened — and this is the other place one is opened, so it has to be
         * applied again here. Without it a session that asked for a particular model ran its
         * retries on whatever the chat opens on, which is "Auto", and the record went on saying
         * it was the model the session asked for. The review has always done this for its own
         * fresh conversations a few hundred lines up; this path simply never did.
         */
        const freshModel = await applySessionModel(chat, session, bus, cfg, store, deps.models);
        if (effectiveModels(session, cfg).model) {
          session = await store.updateSession(sessionId, (s) => {
            s.modelInUse = freshModel.current;
          });
        }
        if (freshModel.refused) throw new Error(freshModel.refused);
        const fresh = session.tasks.find((x) => x.id === task.id);
        if (!fresh) break;
        outcome = await runTask(chat, session, fresh, deps);
        ran += 1;
      }
      if (retried > 0) {
        bus.publish({
          sessionId,
          taskId: task.id,
          // "recovered" only when it ended done: a failure after a retry is not a recovery.
          type: outcome.status === 'blocked' ? 'task-retry-exhausted' : outcome.status === 'done' ? 'task-retry-recovered' : 'task-retry-ended',
          level: outcome.status === 'blocked' ? 'error' : outcome.status === 'done' ? 'info' : 'warn',
          message:
            outcome.status === 'blocked'
              ? `"${task.title}" blocked again after ${retried} fresh conversation(s): the cause is not the chat — read the task text, the checks and the machine`
              : outcome.status === 'done'
                ? `"${task.title}" ended done in a fresh conversation after blocking ${retried} time(s): the earlier block was the chat's`
                : `"${task.title}" ended ${outcome.status} in a fresh conversation after blocking ${retried} time(s)`,
          data: { retried, status: outcome.status },
        });
      }
      lastStatus = outcome.status;
      if (outcome.status !== 'done') {
        if (!deps.continueOnFailure) {
          bus.publish({ sessionId, type: 'session-stopped-early', level: 'warn',
            message: (() => {
              const left = queued.length - queued.findIndex((q) => q.id === queuedTask.id) - 1;
              return left > 0
                ? `task "${task.title}" ended ${outcome.status}; the ${left} task(s) after it stay queued`
                : `task "${task.title}" ended ${outcome.status}; it was the session's last queued task`;
            })() });
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
    const distinct = new Set(queued.map((q) => q.id)).size;
    bus.publish({ sessionId, type: 'session-finished', level: 'info', message: `${Math.min(ran, distinct)} task(s) ran${ran > distinct ? ` (${ran} attempts, with retries)` : ''}`, data: { attempts: ran } });
    const left = await whereLeft((await store.getSession(sessionId)) ?? session).catch(() => null);
    if (left) bus.publish({ sessionId, type: 'vcs-left-on', level: 'warn', message: left });
  }
  return { ran, lastStatus, paused };
}
