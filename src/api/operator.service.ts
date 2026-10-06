/**
 * Everything the web UI can do, in one service.
 *
 * The runner itself does not know it is being driven from a browser. This service supplies
 * the three things that differ from the terminal: where approvals come from (a pending list
 * the UI resolves), where events go (the bus, streamed as SSE), and how a run is stopped
 * (an AbortController per session).
 */
import { pageModelFor, sameModel } from '../transport/modelMatch.js';
import { Injectable } from '@nestjs/common';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { installLayout } from '../config/layout.js';

import { SessionStore, DEFAULT_VCS, DEFAULT_REVIEW, applyDefaultProject, applyTaskPatch } from '../session/store.js';
import { EventBus } from '../session/events.js';
import type {
  Session,
  Task,
  Level2Preset,
  PendingApproval,
  SessionEvent,
  ModelCatalogue,
  ReviewSettings,
  TaskReview,
  TaskRunGroup,
  VersionControl,
} from '../session/model.js';
import { freshRetriesOfLatestRun, isContinuable, newId, tidyVcsPlan, type TaskPatch } from '../session/model.js';
import { runSession, openBrowser, queuedToRun } from '../orchestrator/taskRunner.js';
import { buildExport, type ExportVariant } from '../session/exportRecord.js';
import { buildDebugExport } from '../session/debugExport.js';
import { buildPlanExport, buildDomainExport, buildBotExport, buildBundleExport, exportFileName, exportMachine, runScope, taskAtAttempt, taskInRun, withTask, writeAttemptRecord, type ExportKind, type ExportScope } from '../session/exports.js';
import { suggestRunName } from '../session/runName.js';
import { buildStory, type Story } from '../session/story.js';
import type { ContextKind } from '../session/store.js';
import { checkPlan, type Plan, type PlanCheck, type PlanIssue, type PlanSession, type PlanSummary } from '../plan/schema.js';
import { planBrief, type BriefOptions, type UnattendedBlock } from '../plan/brief.js';

/** The folders the operator works in: the default new sessions start on, and the rest by name. */
export type ProjectDefault = {
  rootDir: string;
  /** What the operator calls it. Empty means the folder's own name. */
  name: string;
  repoOk: boolean;
  repoProblem?: string;
  others: Array<{ name: string; rootDir: string; repoOk: boolean; repoProblem?: string }>;
};

/** Windows paths: case and the slash direction do not make two folders. */
function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => p.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  return a.trim() !== '' && norm(a) === norm(b);
}
import { importPlan, plannedSessionSignature, taskSignature, type ImportResult } from '../plan/importPlan.js';
import { readInterruption } from '../session/interruption.js';
import { branchAt, commitInterrupted, repoDirOf, trackedRepoOf, vcsPreflight, restorePoint, restorePreview, restoreToBase, sessionBranches, sessionBranchName, type RestorePreview, type SessionBranches } from '../vcs/taskVcs.js';
import { branchExists, branchNameFrom, changedFilesBetween, fileAt, freeBranchName, git, gitAvailable, localBranches, plannedBranchName, repoUnusableReason, type ChangedFile } from '../vcs/git.js';
import { makeAuthorizer, type StepAuthorizer } from '../exec/authorizer.js';
import type { PolicyDecision } from '../exec/policy.js';
import { pickFolder, type FolderPick } from './folderPicker.js';
import { findEdgeUsingProfile } from '../transport/profileLock.js';
import { assessIsolation, readIsolationSignals, unattendedIsolationRefusal } from '../exec/isolation.js';
import { unattendedPrecondition, type PolicyConfig } from '../exec/policy.js';
import { createTransport, type ChatTransport } from '../transport/chatTransport.js';
import { composeHandoff } from '../session/handoff.js';
import { planSync, type SyncPlan } from '../vcs/syncCommand.js';
import { planPrepare, prepareFromRemote, type PreparePlan, type PrepareResult } from '../vcs/prepareFromRemote.js';
import { askpassProgram } from '../vcs/remoteAuth.js';
import { appendRunLog, appendSessionLog, type RunLogEntry, type RunLogType } from '../session/runLog.js';
import { workingDirFor, isWorkingDirProblem } from '../exec/workDir.js';
import { contractConflicts, type ContractTree } from '../orchestrator/contract.js';
import { checkRefusalForOperator, lineRefusal } from '../orchestrator/taskRunner.js';
import { preferredShell } from '../exec/shells.js';
import { sessionRoots } from '../exec/confinement.js';
import { dirtyPolicy, takeSnapshot, type SnapshotChoice } from '../vcs/snapshot.js';
import { runVcsPreflight, runVcsPrepare, type RunVcsActionId, type RunVcsGroup } from '../vcs/runPreflight.js';
import { inputSettings, normalisePatterns } from '../vcs/inputs.js';
import { coveredByArtifacts } from '../vcs/artifacts.js';
import { botVersion } from '../config/version.js';
import { computeMetrics, type Metrics } from '../session/metrics.js';
import { resolveDesktopDir, desktopIsSynced } from '../context/desktopDir.js';
import { saveAndReveal, type LogNaming, type SavedLog } from './saveToDesktop.js';
import { settingsOf } from './settings.js';
import type { ResolvedConfig } from '../config/schema.js';

/**
 * A run in progress. `mode` is mutable on purpose: the operator can decide, in the middle of
 * a run, that they have seen enough and the rest should not stop for them. Nothing else about
 * the run changes, and the deny list keeps applying either way, because that gate is in the
 * policy and runs before anyone is asked.
 */
type Running = {
  controller: AbortController;
  startedAt: string;
  mode: 'confirm' | 'unattended';
  /** The policy this run started under, so "run the rest without asking" can be judged against it. */
  policy: PolicyConfig;
};

type Waiting = { approval: PendingApproval; resolve: (d: PolicyDecision) => void };

/** Who has the browser profile: a session's run of its own, a batch, or a read of the model list. */
type BrowserHolder = { kind: 'run'; sessionId: string } | { kind: 'batch' } | { kind: 'models' } | { kind: 'login' };

/** Who is asking for the browser, so a refusal can be said in terms of what they pressed. */
type BrowserAsk = { kind: 'run'; sessionId: string } | { kind: 'batch'; sessionIds: string[] } | { kind: 'models' } | { kind: 'login' };

/** How one finished run went, counted over the tasks that were queued when it started. */
export type RunTally = {
  ran: number;
  failed: number;
  /**
   * Tasks the operator stopped (`aborted`): not failures. Counted with the failures, a session stopped in a
   * batch was recorded "failed" and could stop the batch as a broken chain (live run 2026-10-03).
   */
  stopped?: number;
  /** Tasks that never started, because the chain stopped or the operator did. */
  leftQueued: number;
  failedTitles: string[];
  /** Set when the run itself threw, rather than a task inside it failing. */
  error?: string;
  /** Whether the queue stopped because the operator asked it to hold between tasks. */
  paused?: boolean;
  /** Why the session was refused at its turn before anything of it ran (see `RunDeps.vcsGate`); its tasks stay queued. */
  refused?: string;
};

/**
 * One session's place in a batch.
 *
 * `skipped` is not a failure: a session with nothing queued, or one the operator stopped the
 * batch before reaching, has not been judged. Keeping that apart from `failed` is the
 * difference between a report that can be read at a glance and one that has to be decoded.
 */
export type BatchSession = {
  sessionId: string;
  name: string;
  state: 'waiting' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped';
  ran: number;
  failed: number;
  reason?: string;
};

/**
 * A run across several sessions, one after another.
 *
 * There is at most one, and it is held in memory rather than on disk: a batch is a decision
 * about what to do next, and after a restart there is no browser, no conversation and no
 * consent to carry on, so resuming one silently would be the wrong thing to do.
 */
export type BatchState = {
  id: string;
  startedAt: string;
  /** What the operator called the run. See `TaskRunGroup.name`. */
  name?: string;
  /** The tasks this run was limited to, when the operator chose some. See `startBatch`. */
  onlyTasks?: string[];
  finishedAt?: string;
  mode: 'confirm' | 'unattended';
  /** `stop` gives up on the rest when a session fails; `continue` works through them all. */
  onFailure: 'stop' | 'continue';
  stopping: boolean;
  /**
   * Asked to hold after the task that is running, rather than after its current step.
   *
   * Kept apart from `stopping` because the two do different things to the work in flight: a stop
   * cuts in and leaves the task `aborted` halfway through whatever it was doing, while a pause
   * lets it finish, check itself, be reviewed and commit, and only then holds. Both leave the
   * rest of the queue alone; it is the task in the middle that tells them apart.
   */
  pausing: boolean;
  running: boolean;
  sessions: BatchSession[];
};

/**
 * What starting again from one task would do, before anybody agrees to it.
 *
 * A re-run of a single task is already possible and is not this. This is the question people
 * actually ask after a failure in the middle of a run of nine tasks: put the code back to
 * before the one that broke, and do that one and everything after it again — including the
 * tasks that never got their turn and the sessions that were never reached.
 *
 * It is a preview for the same reason `restore` is: it moves a repository and it re-queues
 * finished work, and both of those are things somebody should see written down first.
 */
export type RestartPlan = {
  ok: boolean;
  problem?: string;
  /** The run the task belonged to, when it belonged to one. */
  runId?: string;
  runStartedAt?: string;
  /** The task everything starts again from. */
  from: { sessionId: string; sessionName: string; taskId: string; title: string; status: Task['status'] };
  /** Every task that would be queued again, in the order they would run. */
  tasks: Array<{
    sessionId: string;
    sessionName: string;
    taskId: string;
    title: string;
    status: Task['status'];
    /** Already queued, so it is re-run by being left alone rather than by being reset. */
    alreadyQueued: boolean;
  }>;
  /** The sessions those tasks belong to, in the order the run had them. */
  sessions: Array<{ id: string; name: string; tasks: number }>;
  /**
   * One per repository among them: what going back would do to it.
   *
   * Several sessions usually share one repository, and then there is one entry here. When they
   * do not, each is taken back to before the earliest of its own affected tasks, which is the
   * same rule applied per repository rather than a rule about the first one only.
   */
  restores: Array<{
    repoDir: string;
    ok: boolean;
    problem?: string;
    forTask: string;
    baseCommit?: string;
    branchName?: string;
    leftBehind: string[];
    keptOn?: string;
  }>;
  /**
   * How the original run was started, which is how this one will be unless told otherwise. A run
   * with no record of its own — `cop run` from the terminal, or one from before runs were recorded —
   * is `confirm`.
   */
  mode: 'confirm' | 'unattended';
  /**
   * Why this machine would refuse the run unattended now, when `mode` says it was: isolation no
   * longer accepted here, a policy lock added since. `restartFrom` refuses that run before anything
   * moves; the dialog offers it step by step instead, which is always allowed, and says why.
   */
  unattendedRefused?: string;
  onFailure: 'stop' | 'continue';
};

/** A session the store already holds that a plan would create all over again. */
export type PlanDuplicate = { name: string; sessionId: string; createdAt: string; tasks: number };

/** A checked plan, plus what importing it would duplicate. */
export type PlanCheckResult = PlanCheck & { duplicates: PlanDuplicate[] };

/**
 * One task, with the session it belongs to, for the registry page. The registry is the one
 * place that answers "what has run, what is running and what is next" across every session,
 * so it carries the session's identity on every row rather than making the page join them.
 */
export type RegistryEntry = {
  sessionId: string;
  sessionName: string;
  sessionStatus: Session['status'];
  sessionRunning: boolean;
  /** Whether the session is one chain (a failed task stops the rest) or independent tasks. */
  sessionOnFailure: 'stop' | 'continue';
  /** Where the session sat in the last run that selected it, so a continuation keeps that order. */
  sessionRunOrder?: number;
  chatUrl?: string;
  taskId: string;
  title: string;
  status: Task['status'];
  /** 1-based position in the session's task list, which is also the order they run in. */
  position: number;
  /** 1-based position among the session's still-queued tasks; absent once it has started. */
  queuePosition?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  iterations: number;
  summary?: string;
  reason?: string;
  runId?: string;
  /** The press of a start button this task ran under, once it has run. */
  runGroup?: TaskRunGroup;
  /** What an independent review concluded, in the short form a row has space for. */
  review?: { verdict: TaskReview['verdict']; findings: number; stepsRun: number };
  /** How many instructions the model declared it could not follow as written. */
  deviations?: number;
  /** How many review findings the model disputed. */
  disputes?: number;
  /** The task must not change files. */
  readOnly?: boolean;
  /** The paths the task may change; absent means anywhere. */
  scope?: string[];
  stopCode?: Task['stopCode'];
  /** The setting whose limit ended the attempt, when one did. See `TaskLimit`. */
  limit?: Task['limit'];
  /** "Continue" can carry it on where it stopped, in its chat and on its branch. See `isContinuable`. */
  continuable?: boolean;
  /** This attempt's branch, the commit its work was put in, and why nothing was, for "Continue" to say. */
  branch?: string;
  commit?: string;
  vcsProblem?: string;
  /** The session is set aside (`Session.active` false): its tasks are not offered to run. */
  sessionInactive?: boolean;
  /** How many times the runner ran it again in a fresh chat after it blocked, on its own, in the run of its latest attempt. */
  autoRetries?: number;
  /** Which attempt the row describes. 1 unless the task has been run again. */
  attempt?: number;
  /**
   * The attempts that came before this one, oldest first.
   *
   * On the row rather than a click away, because the question a re-run raises is always the
   * same one — what happened the last time, and why did it not work — and the register is
   * where a re-run is started from. Each attempt keeps its own run folder, so the log of the
   * attempt that failed is still there to be read next to the one that replaced it.
   */
  attempts?: Array<{
    attempt: number;
    status: Task['status'];
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    iterations: number;
    summary?: string;
    reason?: string;
    runId?: string;
    branch?: string;
    /** How many files that attempt's commit changed; absent when it committed nothing. */
    changedFiles?: number;
  }>;
  /** How many files this attempt's commit changed; absent when it committed nothing. */
  changedFiles?: number;
  /** Aborted because the bot itself stopped under it, and not continued yet. */
  interrupted?: boolean;
};

/**
 * Why the browser cannot be had now, said in terms of what was pressed. The sentences a start, a
 * batch and the model picker gave before there was one rule for all three are kept where they still
 * apply, so the page reads as it did.
 */
function browserRefusal(held: BrowserHolder, ask: BrowserAsk): string {
  const modelsWhileRunning = 'A session is running and it is using the browser profile. Stop it first, then read the models.';
  const loginWhileBusy = 'The browser profile is in use right now. Sign in once the run, or the reading of the models, has finished.';
  // The sign-in window holds the profile until the operator has signed in and it closes.
  if (held.kind === 'login') {
    return ask.kind === 'login'
      ? 'The sign-in window is already open. Finish signing in there.'
      : 'the sign-in window is open and has the browser profile; finish signing in first';
  }
  if (ask.kind === 'login') return loginWhileBusy;
  if (held.kind === 'batch') {
    if (ask.kind === 'models') return modelsWhileRunning;
    return ask.kind === 'batch' ? 'a batch is already running' : 'a batch of sessions is running';
  }
  if (held.kind === 'models') {
    return ask.kind === 'models'
      ? 'The model list is already being read.'
      : 'the model list is being read from the chat, which has the browser; start this once it has finished';
  }
  // A session running on its own.
  if (ask.kind === 'models') return modelsWhileRunning;
  if (ask.kind === 'run') {
    return ask.sessionId === held.sessionId
      ? 'already running'
      : 'another session is running, and the browser takes one run at a time; start this one once it has finished';
  }
  return ask.sessionIds.includes(held.sessionId)
    ? 'one of the selected sessions is already running on its own'
    : 'a session is running on its own, and the browser takes one run at a time; start the batch once it has finished';
}

/** A folder as compared: absolute, forward slashes, no trailing slash, and case folded as Windows does. */
function normaliseDir(dir: string): string {
  if (!dir.trim()) return '';
  return resolve(dir.trim()).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** The repository a planned session will work in, read the way `repoDirOf` reads an imported one. */
function plannedRepoDir(session: PlanSession): string {
  return session.vcs?.repoDir?.trim() || session.projectDir?.trim() || session.mirror?.rootDir?.trim() || '';
}

/**
 * The branches a planned session will make by name when it runs, as `prepareForTask` names them.
 *
 * None with version control off, and none when it carries on an existing branch, which makes
 * nothing. In per-session mode the one `branchName`; in per-task mode the branch each task names,
 * since `branchName` is ignored there. A branch named for the session's id is not known before the
 * import, and is not one a plan can ask to carry on.
 */
function branchesMadeBy(session: PlanSession): string[] {
  const vcs = session.vcs;
  if (!vcs || vcs.enabled === false || vcs.startFrom === 'existing-branch' || vcs.existingBranch?.trim()) return [];
  const prefix = vcs.branchPrefix?.trim() || 'cop/';
  if (vcs.branchMode === 'per-session') return vcs.branchName?.trim() ? [plannedBranchName(vcs.branchName, prefix)] : [];
  return session.tasks.flatMap((t) => (t.vcs?.branch?.trim() ? [plannedBranchName(t.vcs.branch, prefix)] : []));
}

/** One repository "Run again from here" takes back, the task that decides where to, and why it cannot. */
type RestoreTarget = { dir: string; session: Session; task: Task; problem?: string };

/**
 * The one restore each repository gets when a run starts again from a task: the rule, in one place,
 * for the preview and for the restore itself, which used to keep a copy each and drifted apart.
 *
 * One per repository, keyed on the folder as compared rather than on the path as written or on the
 * session: three sessions working in one repository must not take it back three times to three
 * different commits. The earliest affected task that ran is the one that decides, because that is
 * the state the whole re-run starts from.
 *
 * A repository whose affected tasks never ran has nothing to go back to: the run never touched it.
 * Taking "no base commit recorded" as a refusal blocked "run again from here" for every plan whose
 * later sessions had not started yet — which is the usual shape of a run that stopped in the middle.
 *
 * A session that carries on an existing branch cannot be taken back: its run checks that branch out
 * again before the first task, so a restore branch would be left the moment it was made, and going
 * back on the branch itself would take a reset, which this tool never does. That holds for every
 * session of the repository the run reached, not only the one that decides where it goes back to:
 * a later one carrying on a branch would run its tasks again on top of what they did the first
 * time, which is not "the code goes back first" either. So the repository's restore carries the
 * problem of the first such session, and the preview and the restart refuse before anything moves.
 */
function restoreTargets(tasks: Array<{ session: Session; task: Task }>): RestoreTarget[] {
  const byRepo = new Map<string, RestoreTarget>();
  for (const { session, task } of tasks) {
    if (!session.vcs?.enabled || !task.startedAt) continue;
    const dir = repoDirOf(session);
    const key = normaliseDir(dir);
    if (!key) continue;
    const target = byRepo.get(key) ?? { dir, session, task };
    byRepo.set(key, target);
    const existing = session.vcs.startFrom === 'existing-branch' ? (session.vcs.existingBranch ?? '').trim() : '';
    if (existing && !target.problem) {
      target.problem =
        `"${session.name}" carries on the existing branch ${existing}, and its run checks that branch out again, so the code ` +
        `would not stay back; going back on ${existing} itself would take a reset, which this tool never does. ` +
        `Queue its tasks again with "Run again" on each, which carries on ${existing} as it is, or move that branch yourself first.`;
    }
  }
  return [...byRepo.values()];
}

/** Whether two folders, as `normaliseDir` gives them, are one folder or one is inside the other. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * The reason a restart stopped, with what it had already done by then.
 *
 * A repository taken back and tasks queued again stay so when a later step refuses — nothing here
 * undoes them — and the reason is the one thing the page shows. Said only in the result, they were
 * left for the operator to find in git and in the queue.
 */
function afterMoves(reason: string, restored: string[], requeued: number): string {
  const done = [...restored.map((r) => `taken back ${r}`), ...(requeued > 0 ? [`${requeued} task(s) queued again`] : [])];
  return done.length > 0 ? `${reason} Already done, and left as it is: ${done.join('; ')}.` : reason;
}

@Injectable()
export class OperatorService {
  /** Where this install keeps its prompts and its records. See `config/layout.ts`. */
  readonly layout = installLayout();
  readonly projectRoot = this.layout.projectRoot;
  readonly dataDir = this.layout.dataDir;
  readonly settings = settingsOf(this.layout);
  readonly store = new SessionStore(this.dataDir, join(this.layout.promptsDir, 'level1.md'));
  readonly bus = new EventBus();

  private readonly running = new Map<string, Running>();
  private readonly waiting = new Map<string, Waiting>();
  /** The batch in progress, or the last one that finished. At most one ever exists. */
  private batch: BatchState | null = null;
  private ready: Promise<void> | null = null;
  /**
   * What has the browser now: one session's run, a batch, or a read of the model list.
   *
   * The Edge profile takes one writer, and every way into a chat window goes through here: a
   * start, a batch, and reading the models. Each used to look only at its own kind — a start
   * refused only while a batch ran, a batch only a second batch — so while one session ran on its
   * own, starting another or a batch of others opened a second window on the same profile, which
   * fails minutes later with a message about a closed browser. The profile lock is no help inside
   * one process: it waves through a lock this process already holds.
   *
   * Taken at the entrance before its first wait, so two presses that arrive together cannot both
   * find it free, and given back when the window it was taken for has closed or the entrance has
   * refused. See `claimBrowser`.
   */
  private browser: BrowserHolder | null = null;

  /**
   * One-time startup work, run lazily on the first request that needs the store.
   *
   * The recovery pass is part of it on purpose: no request should ever see a task still
   * claiming to wait for an approval that died with the previous process.
   */
  private init(): Promise<void> {
    this.ready ??= (async () => {
      await this.store.init();
      const recovered = await this.store.recoverInterrupted();
      for (const r of recovered) {
        this.bus.publish({
          sessionId: r.sessionId,
          taskId: r.taskId,
          type: 'task-recovered',
          level: 'warn',
          message: `"${r.title}" was left unfinished by an earlier run and has been marked aborted`,
        });
        // What it had changed goes onto its branch, and its record into its run folder, as a
        // finished task's would. See `commitInterrupted` and `writeAttemptRecord`.
        await this.settleRecovered(r.sessionId, r.taskId).catch((e: unknown) =>
          console.warn(`[api] could not settle "${r.title}": ${(e as Error).message}`),
        );
      }
      if (recovered.length > 0) {
        console.log(`[api] closed ${recovered.length} task(s) left unfinished by an earlier run`);
      }
    })();
    return this.ready;
  }

  /**
   * Closes the loose ends of one task the previous process left unfinished: commits its work on its
   * branch, says so on the task, and writes the attempt's plan, work and runner into its run folder.
   */
  private async settleRecovered(sessionId: string, taskId: string): Promise<void> {
    const session = await this.store.getSession(sessionId);
    const task = session?.tasks.find((t) => t.id === taskId);
    if (!session || !task) return;
    const vcs = await commitInterrupted(session, task, task.reason ?? 'interrupted', this.bus);
    const cfg = await this.settings.load();
    // Where it had got to, from its run folder, so "Continue" can tell the chat exactly that.
    const interruption = task.runId ? await readInterruption(join(cfg.resolved.runsDir, task.runId)) : null;
    const settled = await this.store.updateSession(sessionId, (s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (!t) return;
      if (interruption) t.interruption = interruption;
      if (vcs?.commit) {
        t.vcs = vcs;
        t.reason = `${t.reason ?? ''} What it had changed is committed on ${vcs.branch} as ${vcs.commit?.slice(0, 8)}.`.trim();
      }
      // The same fixed-shape ending a task the runner finished gets; the steps the bot never
      // reached are the interruption's own record of them.
      t.handoff = composeHandoff(
        t,
        (interruption?.steps ?? [])
          .filter((x) => x.state !== 'finished')
          .map((x) => ({ command: x.command ?? `step ${x.id}`, why: x.state === 'cut' ? 'cut off when the bot stopped' : 'not reached before the bot stopped' })),
      );
    });
    const ended = settled.tasks.find((t) => t.id === taskId);
    if (!ended) return;
    await writeAttemptRecord(settled, ended, cfg.resolved.runsDir, exportMachine(cfg));
  }

  /** Runs the startup work now, so it does not wait for the first request. */
  bootstrap(): Promise<void> {
    return this.init();
  }

  // --- level 1 --------------------------------------------------------------------------

  async getLevel1(): Promise<{ content: string; customised: boolean }> {
    await this.init();
    return await this.store.getLevel1();
  }

  async setLevel1(content: string): Promise<void> {
    await this.init();
    await this.store.setLevel1(content);
  }

  async resetLevel1(): Promise<{ content: string; customised: boolean }> {
    await this.init();
    await this.store.resetLevel1();
    return await this.store.getLevel1();
  }

  // --- the organisation's part of the plan persona -------------------------------------

  async getContext(kind: ContextKind, lang: string): Promise<{ content: string; customised: boolean; example: string }> {
    await this.init();
    return await this.store.getContext(kind, lang === 'bg' ? 'bg' : 'en');
  }

  async setContext(kind: ContextKind, content: string): Promise<void> {
    await this.init();
    await this.store.setContext(kind, content);
  }

  async resetContext(kind: ContextKind, lang: string): Promise<{ content: string; customised: boolean; example: string }> {
    await this.init();
    await this.store.resetContext(kind);
    return await this.store.getContext(kind, lang === 'bg' ? 'bg' : 'en');
  }

  // --- level 2 presets ------------------------------------------------------------------

  async listPresets(): Promise<Level2Preset[]> {
    await this.init();
    return await this.store.listPresets();
  }

  async savePreset(name: string, content: string): Promise<Level2Preset> {
    await this.init();
    return await this.store.savePreset(name, content);
  }

  async deletePreset(name: string): Promise<void> {
    await this.init();
    await this.store.deletePreset(name);
  }

  // --- named personas for the import page -----------------------------------------------

  async listPersonas(): Promise<Level2Preset[]> {
    await this.init();
    return await this.store.listPersonas();
  }

  async savePersona(name: string, content: string): Promise<Level2Preset> {
    await this.init();
    return await this.store.savePersona(name, content);
  }

  async deletePersona(name: string): Promise<void> {
    await this.init();
    await this.store.deletePersona(name);
  }

  // --- sessions and tasks ---------------------------------------------------------------

  /** The operator's order for the sessions list, top to bottom. See `SessionStore.reorderSessions`. */
  async reorderSessions(ids: unknown): Promise<Array<Session & { running: boolean }>> {
    await this.init();
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw new Error('ids must be a list of session ids.');
    await this.store.reorderSessions(ids as string[]);
    return await this.listSessions();
  }

  async listSessions(): Promise<Array<Session & { running: boolean }>> {
    await this.init();
    const all = await this.store.listSessions();
    return all.map((s) => ({ ...s, running: this.running.has(s.id) }));
  }

  async getSession(
    id: string,
  ): Promise<(Session & { running: boolean; pending: PendingApproval[]; runMode?: 'confirm' | 'unattended' }) | null> {
    await this.init();
    const s = await this.store.getSession(id);
    if (!s) return null;
    const pending = [...this.waiting.values()].filter((w) => w.approval.sessionId === id).map((w) => w.approval);
    return { ...s, running: this.running.has(id), pending, runMode: this.running.get(id)?.mode };
  }

  async createSession(name: string, folder?: string): Promise<Session> {
    await this.init();
    // Read before the session is made: a settings file that cannot be read refuses the request,
    // and a refusal must leave nothing behind, or each retry adds a session with no project.
    const cfg = await this.settings.load();
    const session = await this.store.createSession(name, folder ?? '');

    /*
     * The models are not written onto a new session. A session with no model of its own uses the
     * one chosen in Settings at the time it runs (see `effectiveModels` in taskRunner.ts), so
     * choosing a model there reaches every such session, the ones created before it included.
     * It used to be copied here, which meant a model chosen after an import reached nothing.
     */
    const projectDir = (cfg.project?.rootDir ?? '').trim();
    return await this.store.updateSession(session.id, (s) => {
      /*
       * A folder given here is the session's repository too, in the shape a session made on the
       * Project page's folder has: both fields, one folder. Left empty, every reader that follows
       * `repoDirOf` found the folder, but the review read `vcs.repoDir` itself, and was told there
       * was no repository and no changed files for work committed in that folder. The review asks
       * `trackedRepoOf` now, so a session saved with `repoDir` empty is read right as well; this
       * keeps the record saying what the session works in.
       */
      if (s.projectDir.trim() && s.vcs && !s.vcs.repoDir.trim()) s.vcs.repoDir = s.projectDir;
      // The same rule an import applies, for a session given no folder; see `applyDefaultProject`.
      applyDefaultProject(s, projectDir);
    });
  }

  async updateSession(
    id: string,
    patch: {
      name?: string;
      model?: string;
      onFailure?: 'stop' | 'continue';
      conversationGroup?: string;
      projectDir?: string;
      vcs?: Partial<VersionControl>;
      review?: Partial<ReviewSettings>;
      active?: boolean;
    },
  ): Promise<Session> {
    await this.init();
    if (patch.active !== undefined && this.running.has(id)) {
      throw new Error('This session is running; its status can be changed once it has stopped.');
    }
    return await this.store.updateSession(id, (s) => {
      if (patch.name !== undefined) s.name = patch.name.trim() || s.name;
      if (patch.active === true) delete s.active;
      else if (patch.active === false) s.active = false;
      if (patch.onFailure === 'stop' || patch.onFailure === 'continue') s.onFailure = patch.onFailure;
      // An empty string is a real choice here: it means "leave the chat on whatever it is".
      if (patch.model !== undefined) {
        s.model = patch.model.trim() || undefined;
        // Chosen on the session's page: the operator's own word, which outranks Settings.
        s.modelSource = s.model ? 'operator' : undefined;
      }
      // The same for the group: clearing it gives this session its conversation back. It does
      // not move the conversation it is already in; that history is where it is.
      if (patch.conversationGroup !== undefined) s.conversationGroup = patch.conversationGroup.trim() || undefined;
      if (patch.review) {
        // Empty model means "the session's own", which is a real choice and not a missing one.
        const merged = { ...DEFAULT_REVIEW, ...s.review, ...patch.review };
        s.review = { enabled: merged.enabled !== false, model: (merged.model ?? '').trim() };
        if (patch.review.model !== undefined) s.reviewModelSource = s.review.model ? 'operator' : undefined;
      }
      if (patch.projectDir !== undefined) s.projectDir = patch.projectDir.trim();
      if (patch.vcs) {
        const merged = { ...DEFAULT_VCS, ...s.vcs, ...patch.vcs };
        // A prefix is what makes the bot's branches recognisable in `git branch`, so an empty
        // one is treated as "I did not mean to change this" rather than as a choice.
        merged.branchPrefix = merged.branchPrefix.trim() || DEFAULT_VCS.branchPrefix;
        merged.repoDir = merged.repoDir.trim();
        if (merged.enabled) {
          const reason = repoUnusableReason(merged.repoDir || s.projectDir || '');
          if (reason) throw new Error(reason);
        }
        if (merged.baseBranch !== undefined) merged.baseBranch = merged.baseBranch.trim();
        if (merged.existingBranch !== undefined) merged.existingBranch = merged.existingBranch.trim();
        // Only the two known fields, and absent when it says what absent says: reject, asking first.
        const dirty = dirtyPolicy(merged);
        if (dirty.policy === 'reject') delete merged.dirtyWorktree;
        else merged.dirtyWorktree = { policy: dirty.policy, ...(dirty.requireApproval ? {} : { requireApproval: false }) };
        // Input files and artifacts: patterns as the matching reads them, absent when there are none.
        const inputPaths = normalisePatterns(merged.userInputs?.paths ?? []);
        if (inputPaths.length === 0) delete merged.userInputs;
        else {
          merged.userInputs = {
            paths: inputPaths,
            ...(merged.userInputs?.readOnly === false ? { readOnly: false } : {}),
            ...(merged.userInputs?.requireApproval === false ? { requireApproval: false } : {}),
          };
        }
        const artifactPaths = normalisePatterns(merged.artifacts?.paths ?? []);
        if (artifactPaths.length === 0) delete merged.artifacts;
        else merged.artifacts = { paths: artifactPaths };
        // Artifacts are kept out of git; one that covers the input files would keep them out too.
        const hidden = coveredByArtifacts(merged.userInputs?.paths ?? [], artifactPaths);
        if (hidden.length > 0) {
          throw new Error(
            `An artifacts pattern covers the input files ${hidden.map((h) => `"${h}"`).join(', ')}: artifacts are kept out of git, so the inputs would be too. ` +
              'Name only the folders the evidence is written to, not a whole project folder.',
          );
        }
        // New inputs are settled again at the next task: the recorded ones are no longer the whole list.
        if (JSON.stringify(merged.userInputs ?? null) !== JSON.stringify(s.vcs?.userInputs ?? null) && s.vcsStart?.inputs) {
          s.vcsStart = { ...s.vcsStart, inputs: undefined };
        }
        // Only the program marks a name as one of its own branches, and a name changed is not that one.
        const stillOwn = !!s.vcs?.branchNameExact && (merged.branchName ?? '').trim() === (s.vcs.branchName ?? '').trim();
        if (stillOwn) merged.branchNameExact = true;
        else delete merged.branchNameExact;
        /*
         * Where the session starts is fixed at its first run. A new choice clears that record, so
         * the next task to run is cut from what was chosen now; the tasks that already ran keep
         * their own base commits, which is what a re-run of them goes back to.
         */
        const startChanged =
          (merged.startFrom ?? 'head') !== (s.vcs?.startFrom ?? 'head') ||
          (merged.baseBranch || 'main') !== (s.vcs?.baseBranch || 'main') ||
          (merged.existingBranch ?? '') !== (s.vcs?.existingBranch ?? '') ||
          (merged.updateFromRemote !== false) !== (s.vcs?.updateFromRemote !== false) ||
          merged.repoDir.toLowerCase() !== (s.vcs?.repoDir ?? '').trim().toLowerCase();
        if (startChanged) {
          s.vcsBaseCommit = undefined;
          s.vcsStart = undefined;
        }
        s.vcs = merged;
      }
    });
  }

  async deleteSession(id: string): Promise<void> {
    await this.init();
    if (this.running.has(id)) throw new Error('Stop the session before deleting it.');
    await this.store.deleteSession(id);
  }

  async addTask(sessionId: string, input: { title: string; level2: string; prompt: string }): Promise<Task> {
    await this.init();
    if (!input.prompt?.trim()) throw new Error('A task needs a prompt.');
    return await this.store.addTask(sessionId, input);
  }

  /**
   * Edits a queued task, including the names it carries into git.
   *
   * Everything an imported plan can set, the form can change: a task that arrived as JSON is
   * the same object as one typed in by hand, and the moment the two diverge is the moment an
   * import becomes a thing you cannot correct without editing a file.
   */
  async updateTask(
    sessionId: string,
    taskId: string,
    patch: TaskPatch,
  ): Promise<Task> {
    await this.init();
    let before: Task | undefined;
    const task = await this.store.updateTask(sessionId, taskId, (t) => {
      if (t.status !== 'queued') throw new Error('Only a queued task can be edited.');
      before = structuredClone(t);
      applyTaskPatch(t, patch);
    });
    /*
     * On record with the operator's other actions: a check or the prompt changed after the import is a
     * different contract from the plan's, and the export showed only the new one (live run 2026-10-04).
     */
    const changed = (Object.keys(patch) as Array<keyof Task>).filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(task[k]));
    if (changed.length > 0) {
      const cfg = await this.settings.load();
      await appendSessionLog(cfg.resolved.runsDir, sessionId, {
        type: 'task-edited',
        message: `"${task.title}" edited while queued: ${changed.join(', ')} changed`,
        data: { taskId, changed, before: Object.fromEntries(changed.map((k) => [k, before?.[k] ?? null])) },
      }).catch(() => undefined);
    }
    return task;
  }

  async deleteTask(sessionId: string, taskId: string): Promise<void> {
    await this.init();
    await this.store.deleteTask(sessionId, taskId);
  }

  /**
   * Puts a finished task back in the queue, keeping the record of what it already did.
   *
   * An optional patch is how a finished task is edited: the attempt that ran is archived with
   * the text it ran with, and only then is the new text applied. Editing in place would leave
   * the old attempt's summary sitting under a question that was never asked.
   */
  /** "Continue" on a task that stopped before it finished — a limit from the settings, the bot stopping, the operator: same chat, same branch, fresh count. */
  async continueTask(sessionId: string, taskId: string): Promise<Task> {
    await this.init();
    /*
     * An attempt the operator stopped: which of its last steps ran, and what they printed, read from its
     * run folder, so "Continue" can tell the chat. Without it the chat was told only that it had been
     * stopped, and ran its inspection steps again (live run 2026-10-03).
     */
    const before = (await this.store.getSession(sessionId))?.tasks.find((t) => t.id === taskId);
    const cfg = await this.settings.load();
    const stoppedAt = before?.status === 'aborted' && !before.interruption && before.runId ? await readInterruption(join(cfg.resolved.runsDir, before.runId)).catch(() => null) : null;
    const task = await this.store.continueTask(sessionId, taskId, stoppedAt);
    await appendSessionLog(cfg.resolved.runsDir, sessionId, { type: 'continue', message: `"${task.title}" queued to continue as attempt ${task.attempt ?? 1}`, data: { taskId, attempt: task.attempt } }).catch(() => undefined);
    this.bus.publish({
      sessionId,
      taskId,
      type: 'task-requeued',
      level: 'info',
      message: `"${task.title}" is queued to continue where it stopped (attempt ${task.attempt ?? 1})`,
      data: { attempt: task.attempt, continuing: true },
    });
    return task;
  }

  async rerunTask(
    sessionId: string,
    taskId: string,
    patch: TaskPatch = {},
    /**
     * A new prompt for a task that ended done builds on what it did: the next attempt works on
     * that attempt's branch. Only for a done task — a failed attempt's work is what is being
     * replaced, so a re-run of one starts again from where the task first started.
     */
    opts: { buildOnFinished?: boolean } = {},
  ): Promise<Task> {
    await this.init();
    const before = (await this.store.getSession(sessionId))?.tasks.find((t) => t.id === taskId);
    const buildsOn = opts.buildOnFinished && before?.status === 'done' ? { fromAttempt: before.attempt ?? 1 } : undefined;
    /*
     * A new prompt is a new change: the plan's commit subject was written for the old one, and two
     * different commits went out under it (live run 2026-10-03). Dropped unless the edit names one.
     */
    // A correction added to the old prompt is not a new change, and keeps the subject (live run 2026-10-04).
    const appended = !!before && !!patch.prompt && patch.prompt.trim().startsWith(before.prompt.trim().split('\n### Expected result')[0]!.trim());
    if (patch.prompt?.trim() && before && patch.prompt.trim() !== before.prompt.trim() && !appended && before.vcsPlan?.commitMessage && !patch.vcsPlan?.commitMessage) {
      patch = { ...patch, vcsPlan: { ...before.vcsPlan, ...(patch.vcsPlan ?? {}), commitMessage: undefined } };
    }
    const task = await this.store.rerunTask(sessionId, taskId, patch, undefined, buildsOn);
    {
      const cfg = await this.settings.load();
      const changed = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
      await appendSessionLog(cfg.resolved.runsDir, sessionId, { type: 'rerun', message: `"${task.title}" queued again as attempt ${task.attempt ?? 1}${buildsOn ? `, building on attempt ${buildsOn.fromAttempt}` : ''}${changed.length > 0 ? `, with ${changed.join(', ')} changed` : ''}`, data: { taskId, attempt: task.attempt, changed, ...(buildsOn ? { buildsOn } : {}) } }).catch(() => undefined);
    }
    this.bus.publish({
      sessionId,
      taskId,
      type: 'task-requeued',
      level: 'info',
      message: buildsOn
        ? `"${task.title}" is queued again with a new prompt that builds on attempt ${buildsOn.fromAttempt} (attempt ${task.attempt ?? 1})`
        : `"${task.title}" is queued again (attempt ${task.attempt ?? 1})`,
      data: { attempt: task.attempt, ...(buildsOn ? { buildsOn } : {}) },
    });
    return task;
  }

  /**
   * The consolidated text log of a task, or null when it has not produced one.
   *
   * `runId` asks for one particular attempt. It is checked against the run ids this task
   * actually owns, so the parameter cannot be used to read another task's folder, or any
   * other folder on the machine.
   */
  async taskLog(sessionId: string, taskId: string, runId?: string): Promise<string | null> {
    const cfg = await this.settings.load();
    const s = await this.store.getSession(sessionId);
    const t = s?.tasks.find((x) => x.id === taskId);
    const chosen = resolveRunId(t, runId);
    if (!chosen) return null;
    const path = join(cfg.resolved.runsDir, chosen, 'task-log.txt');
    return existsSync(path) ? await readFile(path, 'utf8') : null;
  }

  /**
   * The story of one attempt, assembled from its run folder: what was sent, what the chat
   * answered, what ran with its output, the review rounds, how it ended. Read while it runs
   * (the page polls) and afterwards; `runId` picks an earlier attempt.
   */
  async taskStory(sessionId: string, taskId: string, runId?: string): Promise<Story | null> {
    const cfg = await this.settings.load();
    const s = await this.store.getSession(sessionId);
    const t = s?.tasks.find((x) => x.id === taskId);
    const chosen = resolveRunId(t, runId);
    if (!t || !chosen) return null;
    const current = chosen === t.runId;
    // An earlier attempt is read with its own record, so the closing summary is that attempt's.
    const attempt = current ? t : (t.attempts ?? []).find((a) => a.runId === chosen);
    const view: Task = current || !attempt ? t : { ...t, ...attempt, status: attempt.status, attempts: undefined };
    const live = current && this.running.has(sessionId) && (t.status === 'running' || t.status === 'waiting-approval');
    return await buildStory(cfg.resolved.runsDir, chosen, view, live);
  }

  /** Files a task produced, so the UI can list reports and downloaded scripts. */
  /**
   * What a task changed in the repository: the files, between the commit it started from and the
   * commit it produced. `runId` picks an earlier attempt. Read from git each time rather than kept
   * on the record, so what is shown is the repository's own account; the record only says which
   * two commits to compare.
   *
   * There is something to show only when version control was on and the task committed: a task
   * that changed nothing, or ran with version control off, left no commit to compare, and the
   * answer says which.
   */
  async taskChanges(
    sessionId: string,
    taskId: string,
    runId?: string,
  ): Promise<{ ok: boolean; problem?: string; repoDir?: string; branch?: string; base?: string; commit?: string; files: ChangedFile[] }> {
    const found = await this.changesOf(sessionId, taskId, runId);
    if ('problem' in found) return { ok: false, problem: found.problem, files: [] };
    const listed = await changedFilesBetween(found.dir, found.base, found.commit);
    if (listed.problem) return { ok: false, problem: `the repository no longer has these commits: ${listed.problem}`, files: [] };
    return { ok: true, repoDir: found.dir, branch: found.branch, base: found.base, commit: found.commit, files: listed.files };
  }

  /**
   * One changed file, before and after, as text. Only a file the task changed can be asked for:
   * the path is checked against that list, so this cannot be used to read anything else in the
   * repository's history. A binary file, or one over 2 MB on either side, is said to be so rather
   * than returned.
   */
  async taskChangeFile(
    sessionId: string,
    taskId: string,
    path: string,
    runId?: string,
  ): Promise<{ path: string; oldPath?: string; status: string; before: string | null; after: string | null; binary: boolean; tooLarge: boolean }> {
    const found = await this.changesOf(sessionId, taskId, runId);
    if ('problem' in found) throw new Error(found.problem);
    const listed = await changedFilesBetween(found.dir, found.base, found.commit);
    const file = listed.files.find((f) => f.path === path);
    if (!file) throw new Error('That file is not one this task changed.');
    const MAX = 2 * 1024 * 1024;
    const before = file.status === 'A' ? { bytes: null, tooLarge: false } : await fileAt(found.dir, found.base, file.oldPath ?? file.path, MAX);
    const after = file.status === 'D' ? { bytes: null, tooLarge: false } : await fileAt(found.dir, found.commit, file.path, MAX);
    // Git's own test for binary: a NUL byte in the first 8000.
    const binary = [before.bytes, after.bytes].some((b) => !!b && b.subarray(0, 8000).includes(0));
    const text = (b: Buffer | null): string | null => (b === null || binary ? null : b.toString('utf8').replace(/^\uFEFF/, ''));
    return {
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status,
      before: text(before.bytes),
      after: text(after.bytes),
      binary,
      tooLarge: before.tooLarge || after.tooLarge,
    };
  }

  /** The repository and the two commits a task's changes lie between, or why there are none. */
  private async changesOf(
    sessionId: string,
    taskId: string,
    runId?: string,
  ): Promise<{ dir: string; base: string; commit: string; branch?: string } | { problem: string }> {
    await this.init();
    const session = await this.store.getSession(sessionId);
    const task = session?.tasks.find((t) => t.id === taskId);
    if (!session || !task) return { problem: 'No such task.' };
    const chosen = runId ? resolveRunId(task, runId) : task.runId;
    if (runId && !chosen) return { problem: 'That attempt is not one of this task\'s.' };
    const vcs = !chosen || chosen === task.runId ? task.vcs : (task.attempts ?? []).find((a) => a.runId === chosen)?.vcs;
    if (!vcs?.baseCommit || !vcs.commit) {
      return {
        problem: vcs?.branch
          ? 'This attempt committed nothing, so there are no changes to show.'
          : 'Version control was not on for this attempt, so its changes were not recorded.',
      };
    }
    const dir = repoDirOf(session);
    if (!dir) return { problem: 'The session has no repository folder set.' };
    return { dir, base: vcs.baseCommit, commit: vcs.commit, branch: vcs.branch };
  }

  async taskFiles(
    sessionId: string,
    taskId: string,
    runId?: string,
  ): Promise<{ reports: string[]; artifacts: string[]; replies: string[] }> {
    const cfg = await this.settings.load();
    const s = await this.store.getSession(sessionId);
    const t = s?.tasks.find((x) => x.id === taskId);
    const empty = { reports: [], artifacts: [], replies: [] };
    const chosen = resolveRunId(t, runId);
    if (!chosen) return empty;
    const base = join(cfg.resolved.runsDir, chosen);
    const ls = async (sub: string): Promise<string[]> =>
      (await readdir(join(base, sub)).catch(() => [] as string[])).filter((n) => !n.startsWith('_')).sort();
    return { reports: await ls('reports'), artifacts: await ls('artifacts'), replies: await ls('replies') };
  }

  async taskFile(
    sessionId: string,
    taskId: string,
    kind: 'reports' | 'artifacts' | 'replies',
    name: string,
    runId?: string,
  ): Promise<string | null> {
    if (name.includes('..') || name.includes('/') || name.includes('\\')) return null;
    const cfg = await this.settings.load();
    const s = await this.store.getSession(sessionId);
    const t = s?.tasks.find((x) => x.id === taskId);
    const chosen = resolveRunId(t, runId);
    if (!chosen) return null;
    const path = join(cfg.resolved.runsDir, chosen, kind, name);
    return existsSync(path) ? await readFile(path, 'utf8') : null;
  }

  /**
   * The same log, written to the Desktop and shown in Explorer instead of to the browser.
   *
   * What the operator does with a log is hand it to the chat that orchestrates the effort, so
   * the useful end of the journey is a file under the cursor, not a page in a tab. The reading
   * is delegated to `taskLog` rather than repeated here: that method already decides which run
   * folder this task is allowed to open, and a second copy of that decision is a second place
   * for it to be got wrong.
   */
  async saveTaskLog(sessionId: string, taskId: string, runId?: string): Promise<SavedLog | null> {
    const text = await this.taskLog(sessionId, taskId, runId);
    if (text === null) return null;
    return await saveAndReveal(text, await this.namingFor(sessionId, taskId, runId));
  }

  /** One of a task's own files, saved and revealed the same way. They are logs by another name. */
  async saveTaskFile(
    sessionId: string,
    taskId: string,
    kind: 'reports' | 'artifacts' | 'replies',
    name: string,
    runId?: string,
  ): Promise<SavedLog | null> {
    const text = await this.taskFile(sessionId, taskId, kind, name, runId);
    if (text === null) return null;
    return await saveAndReveal(text, { ...(await this.namingFor(sessionId, taskId, runId)), file: name });
  }

  /**
   * What a saved file is named after.
   *
   * An earlier attempt is named from its own snapshot rather than from the task as it stands
   * now: a task can be edited between attempts, and a file called after today's title would
   * claim the old log answered a question it was never asked.
   */
  private async namingFor(sessionId: string, taskId: string, runId?: string): Promise<LogNaming> {
    const s = await this.store.getSession(sessionId);
    const t = s?.tasks.find((x) => x.id === taskId);
    const chosen = resolveRunId(t, runId);
    const earlier = chosen && t && chosen !== t.runId ? (t.attempts ?? []).findIndex((a) => a.runId === chosen) : -1;
    const attempt = earlier >= 0 ? earlier + 1 : (t?.attempt ?? 1);
    return {
      session: s?.name ?? sessionId,
      task: (earlier >= 0 ? t?.attempts?.[earlier]?.title : t?.title) ?? taskId,
      // A task that has only ever run once has nothing to be told apart from.
      attempt: attempt > 1 ? attempt : undefined,
    };
  }

  /**
   * The record of selected tasks as one downloadable document.
   *
   * `taskIds` empty means every task of the session that has actually run. A queued task has
   * nothing to say yet, and silently including it would put an empty section in a document
   * someone is about to send to a colleague.
   */
  async exportTasks(
    sessionId: string,
    taskIds: string[],
    variant: ExportVariant,
  ): Promise<{ fileName: string; content: string }> {
    await this.init();
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error('No such session.');

    const wanted = taskIds.length > 0 ? session.tasks.filter((t) => taskIds.includes(t.id)) : session.tasks;
    const tasks = wanted.filter((t) => t.status !== 'queued');
    if (tasks.length === 0) {
      throw new Error('None of the selected tasks has run yet, so there is nothing to export.');
    }

    const cfg = await this.settings.load();
    return await buildExport({ session, tasks, variant, runsDir: cfg.resolved.runsDir });
  }

  /**
   * Everything that happened across a set of sessions, as one JSON document.
   *
   * Given no ids it exports the sessions of the last batch, because the commonest moment for
   * wanting this is right after a run of several went wrong and the operator wants to hand the
   * whole thing to somebody who was not watching.
   */
  async debugExport(sessionIds: string[]): Promise<{ fileName: string; content: string }> {
    await this.init();
    const wanted = sessionIds.map((x) => x.trim()).filter(Boolean);
    const ids = wanted.length > 0 ? wanted : (this.batch?.sessions ?? []).map((s) => s.sessionId);
    if (ids.length === 0) {
      throw new Error('No sessions were named, and no batch has run in this process to fall back on.');
    }

    const sessions = [];
    for (const id of ids) {
      const session = await this.store.getSession(id);
      if (session) sessions.push(session);
    }
    if (sessions.length === 0) throw new Error('None of those sessions exists any more.');

    const cfg = await this.settings.load();
    return await buildDebugExport({ sessions, runsDir: cfg.resolved.runsDir, cwd: cfg.resolved.cwd });
  }

  /**
   * One of the three JSON views (plan, domain, bot) of one task, one session or one run.
   *
   * A run is everything that one press of a start button set off, across sessions: the tasks
   * stamped with its id, and the sessions that were part of it even where a task never got its
   * turn. The file is named after the run's own name when it has one, because a file called
   * `run-r-abc123` is not something anyone can find again.
   */
  async exportView(kind: ExportKind, where: { sessionId?: string; taskId?: string; runId?: string }): Promise<{ fileName: string; content: string }> {
    await this.init();
    let scope: ExportScope;
    if (where.runId) {
      const runId = where.runId;
      const all = await this.store.listSessions();
      const sessions = all
        .filter((s) => s.runGroup?.id === runId || s.tasks.some((t) => t.runGroup?.id === runId || t.attempts?.some((a) => a.runGroup?.id === runId)))
        .sort((a, b) => (a.runGroup?.id === runId ? (a.runGroup.order ?? 0) : 0) - (b.runGroup?.id === runId ? (b.runGroup.order ?? 0) : 0));
      if (sessions.length === 0) throw new Error(`No session took part in run ${runId}.`);
      /*
       * The run's name and start, from a session's own record of the run — or, once a later run has
       * replaced that record, from a task that ran in it, which carries both. Without the second,
       * the earlier run's file was called "run-" with nothing after it, the kind of name nobody
       * finds again.
       */
      const group =
        sessions.map((s) => s.runGroup).find((g) => g?.id === runId) ??
        sessions.flatMap((s) => s.tasks.map((t) => taskInRun(t, runId)?.runGroup)).find((g) => g?.id === runId);
      const name = group?.name?.trim() || `run-${(group?.startedAt ?? '').slice(0, 16).replace(/[:T]/g, '-')}`;
      // Each task as it ended in this run, not as it is now; see `runScope`.
      scope = runScope(sessions, runId, name);
    } else if (where.sessionId) {
      const session = await this.store.getSession(where.sessionId);
      if (!session) throw new Error('No such session.');
      if (where.taskId) {
        const task = session.tasks.find((t) => t.id === where.taskId);
        if (!task) throw new Error('No such task.');
        scope = { sessions: [session], taskFilter: (_s, t) => t.id === task.id, label: `${session.name}-${task.title}` };
      } else {
        scope = { sessions: [session], label: session.name };
      }
    } else {
      throw new Error('Name a run, a session or a task.');
    }

    const cfg = await this.settings.load();
    const document =
      kind === 'plan'
        ? buildPlanExport(scope)
        : kind === 'domain'
          ? await buildDomainExport(scope, cfg.resolved.runsDir)
          : await buildBotExport(scope, cfg.resolved.runsDir, exportMachine(cfg));
    return { fileName: exportFileName(kind, scope.label), content: JSON.stringify(document, null, 2) };
  }

  /**
   * All three views of a set of tasks the operator picked by hand, in one file.
   *
   * The pairs carry their session because a selection spans runs and sessions — that is the
   * point of it — so a task id on its own would not say which session's task it is. Unknown
   * pairs are dropped rather than refused: a register left open while a session is deleted
   * elsewhere should still hand over the tasks that are still there, and the document says
   * which ones it holds.
   */
  async exportBundle(pairs: Array<{ sessionId: string; taskId: string; attempt?: number }>): Promise<{ fileName: string; content: string }> {
    await this.init();
    if (pairs.length === 0) throw new Error('Choose at least one task.');

    const wanted = new Map<string, Set<string>>();
    for (const { sessionId, taskId } of pairs) {
      const set = wanted.get(sessionId) ?? new Set<string>();
      set.add(taskId);
      wanted.set(sessionId, set);
    }

    /*
     * A pair may name one attempt of its task — the button beside an earlier attempt does. That
     * task is then exported as it stood for that attempt (`taskAtAttempt`): its text, its outcome,
     * its run folder, and only the attempts before it.
     */
    const sessions: Session[] = [];
    for (const sessionId of wanted.keys()) {
      let session = await this.store.getSession(sessionId);
      if (!session) continue;
      for (const pair of pairs.filter((x) => x.sessionId === sessionId && x.attempt !== undefined)) {
        const task = session.tasks.find((t) => t.id === pair.taskId);
        const asItWas = task ? taskAtAttempt(task, pair.attempt as number) : null;
        if (task && !asItWas) throw new Error(`"${task.title}" has no attempt ${pair.attempt}.`);
        if (asItWas) session = withTask(session, asItWas);
      }
      sessions.push(session);
    }
    const found = sessions.flatMap((s) => s.tasks.filter((t) => wanted.get(s.id)?.has(t.id)));
    if (found.length === 0) throw new Error('None of the chosen tasks still exists.');

    // Named after what was chosen rather than after a run, because a selection is not a run: it
    // may be one task of one, or a task from each of three.
    const one = pairs.length === 1 ? pairs[0] : undefined;
    const label =
      found.length === 1 && sessions.length === 1
        ? `${sessions[0].name}-${found[0].title}${one?.attempt !== undefined ? `-attempt-${one.attempt}` : ''}`
        : sessions.length === 1
          ? `${sessions[0].name}-${found.length}-tasks`
          : `${found.length}-tasks-${sessions.length}-sessions`;

    const cfg = await this.settings.load();
    const document = await buildBundleExport(
      { sessions, taskFilter: (s, t) => !!wanted.get(s.id)?.has(t.id), label },
      cfg.resolved.runsDir,
      exportMachine(cfg),
    );
    return { fileName: exportFileName('bundle', label), content: JSON.stringify(document, null, 2) };
  }

  // --- running --------------------------------------------------------------------------

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /**
   * Takes the browser for `ask`, or says why it cannot have it. Synchronous on purpose (see
   * `browser`). What it hands back is what `releaseBrowser` is given, so a release that comes late
   * cannot free a browser somebody else has taken since.
   */
  private claimBrowser(ask: BrowserAsk): { holder: BrowserHolder } | { refused: string } {
    if (this.browser) return { refused: browserRefusal(this.browser, ask) };
    const holder: BrowserHolder = ask.kind === 'run' ? { kind: 'run', sessionId: ask.sessionId } : { kind: ask.kind };
    this.browser = holder;
    return { holder };
  }

  private releaseBrowser(holder: BrowserHolder): void {
    if (this.browser === holder) this.browser = null;
  }

  /**
   * Starts the session's queued tasks in the background. Returns immediately; progress
   * arrives on the event stream. One run at a time, of this session or any other.
   */
  async start(sessionId: string, mode: 'confirm' | 'unattended' = 'confirm', name?: string): Promise<{ started: boolean; reason?: string }> {
    // One conversation at a time is not a policy, it is the browser profile: a second run
    // does not get a second browser, it gets an error about a closed one. Whatever has the
    // browser now — a batch, another session, a read of the models — the start is refused where
    // the reason can still be read, rather than three minutes later in a stack trace.
    const claim = this.claimBrowser({ kind: 'run', sessionId });
    if ('refused' in claim) return { started: false, reason: claim.refused };
    try {
      // A run nobody named is named after what it is a run of, rather than left to show up in the
      // register as "Unnamed run" beside five others of the same description.
      const chosenName = name?.trim() || (await this.suggestRunName([sessionId]));
      const runGroup: TaskRunGroup = { id: newId('r-'), startedAt: new Date().toISOString(), sessions: 1, name: chosenName };
      // A run of one is still a run, and it records the same thing a batch does, so that going
      // back and starting again from a task works the same whether one session was started or six.
      // Recorded by `beginRun` once the start is accepted, not here: see `recordOnSession`.
      // Version control first, before anything opens the browser: see `vcs/runPreflight.ts`.
      const notReady = await this.runPreflight(runGroup.id, [sessionId]);
      if (notReady) {
        this.releaseBrowser(claim.holder);
        return { started: false, reason: notReady };
      }
      const begun = await this.beginRun(sessionId, mode, undefined, runGroup, undefined, { recordOnSession: true });
      if (!begun.started) {
        this.releaseBrowser(claim.holder);
        return { started: false, reason: begun.reason };
      }
      // The window closes before the run's promise settles (see `runSession`), so the browser is
      // free again exactly when it is.
      void begun.done.finally(() => this.releaseBrowser(claim.holder));
      return { started: true };
    } catch (e) {
      this.releaseBrowser(claim.holder);
      throw e;
    }
  }

  /**
   * The same thing `start` does, but it also hands back a promise that settles when the run
   * is over and says how it went.
   *
   * A batch needs that promise and a single session does not, which is the only difference
   * between the two callers. The sessions of a batch still run one at a time through here,
   * and they have to: the browser profile is single-writer, so two conversations at once is
   * not slower, it is a failure with a message about a closed browser.
   */
  private async beginRun(
    sessionId: string,
    mode: 'confirm' | 'unattended',
    /** A browser that is already open. A batch passes its own; a single run opens one. */
    transport?: ChatTransport,
    /** The press of a start button this belongs to, stamped onto every task it reaches. */
    runGroup?: TaskRunGroup,
    /** Only these queued tasks, when the operator chose some; the rest stay queued. */
    onlyTasks?: ReadonlySet<string>,
    how: {
      /**
       * Write `runGroup` onto the session as its run (`Session.runGroup`), with the tasks it is
       * taking — once every reason to refuse the start has been looked at, and only then.
       *
       * A single start wrote it before anything was checked, so a start refused for having nothing
       * queued, for an unattended precondition, or for running already left a run on the session
       * that never happened: it replaced the record of a batch the session belonged to, which
       * "start again from here" reads, or of the run actually in progress; and for a session that
       * does not exist, the write threw and the start answered 500. A batch records its runs itself,
       * on every session it selected, before it starts (see `runBatch`), and does not ask for this.
       */
      recordOnSession?: boolean;
      /**
       * Whether to hold the queue between tasks. Only a batch has a pause, so only a batch passes
       * one, and it answers for itself: a run of its own reads nobody's pause. It used to read the
       * batch record, which outlives the batch, so a pause left on when a batch ended held every
       * later run of any session before its first task.
       */
      shouldPause?: () => boolean;
    } = {},
  ): Promise<{ started: boolean; reason?: string; done: Promise<RunTally> }> {
    await this.init();
    const idle: RunTally = { ran: 0, failed: 0, leftQueued: 0, failedTitles: [] };
    if (this.running.has(sessionId)) return { started: false, reason: 'already running', done: Promise.resolve(idle) };
    const session = await this.store.getSession(sessionId);
    if (!session) return { started: false, reason: 'no such session', done: Promise.resolve(idle) };
    // Set aside by the operator on the Sessions page: not started by anything until made active.
    if (session.active === false) {
      return { started: false, reason: 'the session is inactive; make it active on the Sessions page to run it', done: Promise.resolve(idle) };
    }
    const queuedIds = queuedToRun(session, onlyTasks).map((t) => t.id);
    if (queuedIds.length === 0) return { started: false, reason: 'no queued tasks', done: Promise.resolve(idle) };

    const cfg = await this.settings.load();
    const policy = {
      mode,
      denyPatterns: cfg.execution.denyPatterns,
      allowedPrograms: cfg.execution.allowedPrograms,
      isolation: cfg.execution.isolation,
      lockedToConfirm: cfg.policyLock?.maxMode === 'confirm',
      // Read once per run like the rest of the policy: a change in Settings applies from the next start.
      networkFetch: cfg.execution.networkFetch,
    };
    /*
     * An unattended run that cannot legally execute anything is stopped here, where the operator
     * is looking, rather than starting and returning every step refused. The step gate holds the
     * same rule and is what actually enforces it; this is so the answer arrives once, before a
     * browser is opened and a conversation is started, and names the setting to change.
     */
    const precondition = unattendedPrecondition(policy);
    if (precondition) return { started: false, reason: precondition, done: Promise.resolve(idle) };
    if (how.recordOnSession && runGroup) {
      // The tasks this run takes, as worked out above, so the record and the run cannot disagree.
      await this.store.updateSession(sessionId, (s) => {
        s.runGroup = { ...runGroup, order: 0, taskIds: queuedIds, mode, onFailure: s.onFailure === 'continue' ? 'continue' : 'stop' };
      });
    }
    const controller = new AbortController();
    /*
     * The same authorizer in both modes. It used to be `unattendedAuthorizer` here for an unattended
     * run, which has no way to ask anybody; but a step that fetches from the network is put to the
     * operator whatever the mode (see `network.ts`), and the approval screen is where that happens.
     * `makeAuthorizer` reads `policy.mode` on every step, so an unattended run still asks about
     * nothing else.
     */
    const authorizer: StepAuthorizer = this.webAuthorizer(policy, controller.signal);

    this.running.set(sessionId, { controller, startedAt: new Date().toISOString(), mode, policy });
    this.bus.publish({ sessionId, type: 'run-requested', level: 'info', message: `starting in ${mode} mode` });
    // Said at the start of every run, in both modes, because it is the one fact about this tool a
    // data-protection team needs and the one an operator forgets: the reports leave the machine.
    this.bus.publish({
      sessionId,
      type: 'upload-notice',
      level: 'info',
      message:
        // Project files are no longer mirrored to the chat (removed in 0.1.14): only the reports go (live run 2026-10-03).
        "every report of this run — each step's terminal output, the check results, the reviewer's transcripts — is " +
        "uploaded into the Copilot chat and stored in the signed-in account's OneDrive and Copilot history, inside the " +
        'tenant; secret-shaped strings are redacted first',
    });

    const done = runSession(sessionId, {
      cfg: { ...cfg, execution: { ...cfg.execution, mode } } as ResolvedConfig,
      store: this.store,
      bus: this.bus,
      authorizer,
      signal: controller.signal,
      // Read between tasks, so the one in flight finishes properly first. The batch that owns
      // this run answers it, because a pause is about the whole run and not about this session.
      shouldPause: how.shouldPause,
      // The mode as it is now, not as it was: "run the rest without asking" changes it mid-run,
      // and the policy.json of a later task must say so.
      currentMode: () => this.running.get(sessionId)?.mode ?? mode,
      // The Desktop copies follow the work while it happens, not only before the run.
      // The session decides whether its tasks are one chain or a set of independent checks.
      continueOnFailure: session.onFailure === 'continue',
      transport,
      runGroup,
      onlyTasks,
      vcsGate: async (s) => {
        const refused = await this.sessionVcsGate(s, onlyTasks);
        // In the run's own log, where the export finds it: it was only in the live events (live run 2026-10-04).
        if (refused && runGroup) {
          await appendRunLog(cfg.resolved.runsDir, runGroup.id, [
            { at: new Date().toISOString(), type: 'run-preflight-refused', message: `refused at its turn: ${refused}`, data: { sessions: [s.id], atTurn: true } },
          ]).catch(() => undefined);
        }
        return refused;
      },
      ...(transport || !runGroup ? {} : { beforeBrowser: () => this.browserRequested(runGroup.id, [sessionId]) }),
      // The page is the source of the model names: Settings and the saved list follow it (see `ModelHooks`).
      models: {
        locate: async (name) => (await this.store.getModels())?.options.find((o) => sameModel(o.name, name))?.locator,
        askHelp: (ask) => this.askModelHelp(ask, controller.signal),
        renamedDefault: async (which, from, to) => {
          const now = (await this.settings.load()).copilot;
          if (which === 'model' && (now.defaultModel ?? '').trim() === from) await this.setDefaultModel(to);
          if (which === 'review' && (now.defaultReviewModel ?? '').trim() === from) await this.setDefaultReviewModel(to);
        },
        seen: async (options, current) => {
          await this.store.saveModels({ options, current: current ?? undefined, readAt: new Date().toISOString() });
        },
      },
    })
      .then(async (outcome) => ({ ...(await this.tally(sessionId, queuedIds)), paused: outcome.paused, ...(outcome.refused ? { refused: outcome.refused } : {}) }))
      .catch(async (e: unknown) => {
        this.bus.publish({ sessionId, type: 'run-failed', level: 'error', message: (e as Error).message });
        return { ...(await this.tally(sessionId, queuedIds)), error: (e as Error).message };
      })
      .finally(() => {
        this.running.delete(sessionId);
        for (const [id, w] of this.waiting) {
          if (w.approval.sessionId === sessionId) {
            w.resolve({ action: 'abort', reason: 'the run ended' });
            this.waiting.delete(id);
          }
        }
      });

    return { started: true, done };
  }

  /**
   * How a finished run went, read from the tasks it was given rather than from its return
   * value.
   *
   * Only the tasks that were queued when the run began are counted, so a session that already
   * held a failure from last week does not make today's run look failed.
   */
  private async tally(sessionId: string, taskIds: string[]): Promise<RunTally> {
    const session = await this.store.getSession(sessionId);
    const tally: RunTally = { ran: 0, failed: 0, leftQueued: 0, failedTitles: [] };
    for (const id of taskIds) {
      const task = session?.tasks.find((t) => t.id === id);
      if (!task) continue;
      if (task.status === 'queued') {
        tally.leftQueued += 1;
        continue;
      }
      tally.ran += 1;
      if (task.status === 'aborted') {
        tally.stopped = (tally.stopped ?? 0) + 1;
        continue;
      }
      if (task.status !== 'done') {
        tally.failed += 1;
        tally.failedTitles.push(task.title);
      }
    }
    return tally;
  }

  /** Asks the run to stop after the current step. Pending approvals are aborted at once. */
  async stop(sessionId: string): Promise<{ stopping: boolean }> {
    const r = this.running.get(sessionId);
    if (!r) return { stopping: false };
    r.controller.abort();
    for (const [id, w] of this.waiting) {
      if (w.approval.sessionId === sessionId) {
        w.resolve({ action: 'abort', reason: 'stopped by the operator', by: 'operator' });
        this.waiting.delete(id);
      }
    }
    await this.store.updateSession(sessionId, (s) => {
      s.status = 'stopping';
    });
    // The running step is cut off, not waited for: said as it is (live run 2026-10-03).
    this.bus.publish({ sessionId, type: 'stop-requested', level: 'warn', message: 'stopping now: nothing more is sent, and a step still running is cut off' });
    return { stopping: true };
  }

  // --- running several sessions in turn -------------------------------------------------

  /**
   * Whether the bot is working right now, and nothing else.
   *
   * Every page asks this on a timer so the register's own button can say `live`, which is the
   * only reason it is separate from the registry: the registry reads every session off disk to
   * answer a question this one answers from two fields already in memory. A poll that costs a
   * directory walk every few seconds, on every page, to light up a dot would be a bad trade.
   */
  activity(): { running: boolean; sessions: number; batch: boolean; starting: boolean } {
    /*
     * A run being started — its version control checked before the browser opens — is not running yet
     * and not idle either: `starting` says so, so "nothing is happening" is not read in that moment.
     */
    const starting = this.running.size === 0 && !this.batch?.running && (this.browser?.kind === 'run' || this.browser?.kind === 'batch');
    return { running: this.running.size > 0, sessions: this.running.size, batch: this.batch?.running === true, starting };
  }

  /** The batch in progress, or the last one that ran, or null if none ever has. */
  batchState(): BatchState | null {
    return this.batch ? { ...this.batch, sessions: this.batch.sessions.map((s) => ({ ...s })) } : null;
  }

  /**
   * Runs the queued tasks of several sessions, one session after another.
   *
   * The order is the order the ids arrive in, which is the order the operator ticked them.
   * `onFailure` is the same question the task queue already asks, one level up: `stop` treats
   * the sessions as a chain, `continue` treats them as separate pieces of work that happen to
   * have been started together.
   */
  /**
   * What to call a run nobody named. The rule and the reasoning are in `session/runName.ts`;
   * this only fetches the sessions it needs to answer over.
   */
  async suggestRunName(sessionIds: string[], about?: string): Promise<string> {
    return suggestRunName(await this.store.listSessions(), sessionIds, about);
  }

  async startBatch(
    sessionIds: string[],
    mode: 'confirm' | 'unattended' = 'confirm',
    onFailure: 'stop' | 'continue' = 'stop',
    model?: string,
    /**
     * The model the independent review runs on, for every session in this run.
     *
     * Separate from `model` because they are separate decisions, and the interesting case is
     * precisely when they differ: a review is worth most when it is not the same mind that did
     * the work, and a run panel that could only set one model made that the hard path.
     */
    reviewModel?: string,
    /** What to call the run. Offered from the plan's name; empty means it goes by its id. */
    name?: string,
    /**
     * The queued tasks to run, when not every queued task of those sessions: what the operator
     * ticked in the register. A session none of whose chosen tasks is queued is skipped; the
     * tasks nobody chose stay queued exactly as they were. Absent means every queued task.
     */
    taskIds?: string[],
  ): Promise<{ started: boolean; reason?: string; batch?: BatchState }> {
    const wanted = [...new Set(sessionIds.map((s) => s.trim()).filter(Boolean))];
    // Before anything is waited for (see `browser`): a second batch, a session running on its own
    // — one of these or any other — and a read of the models all have the browser already.
    const claim = this.claimBrowser({ kind: 'batch', sessionIds: wanted });
    if ('refused' in claim) return { started: false, reason: claim.refused };
    return await this.startBatchHolding(claim.holder, wanted, mode, onFailure, model, reviewModel, name, taskIds);
  }

  /**
   * `startBatch` for a caller that has claimed the browser already, and the claim with it: handed on
   * to the batch once it is under way (`runBatch` gives it back), and given back here on every
   * refusal. "Run again from here" claims it before it moves anything and starts through this, so
   * one claim covers the restore, the requeue and the run.
   */
  private async startBatchHolding(
    holder: BrowserHolder,
    wanted: string[],
    mode: 'confirm' | 'unattended',
    onFailure: 'stop' | 'continue',
    model: string | undefined,
    reviewModel: string | undefined,
    name: string | undefined,
    taskIds: string[] | undefined,
  ): Promise<{ started: boolean; reason?: string; batch?: BatchState }> {
    const onlyTasks = taskIds && taskIds.length > 0 ? new Set(taskIds.map((t) => t.trim()).filter(Boolean)) : undefined;
    let handedOn = false;
    try {
      await this.init();
      if (wanted.length === 0) return { started: false, reason: 'no sessions were selected' };
      // Version control first, before anything opens the browser: see `vcs/runPreflight.ts`.
      // The batch's id first, so the preflight is recorded under the run it decides about.
      const batchId = newId('b-');
      const notReady = await this.runPreflight(batchId, wanted, onlyTasks);
      if (notReady) return { started: false, reason: notReady };
      const begun = await this.prepareBatch(wanted, onlyTasks, mode, onFailure, model, reviewModel, name, batchId);
      if (!begun.batch) return { started: false, reason: begun.reason };
      this.batch = begun.batch;
      handedOn = true;
      void this.runBatch(begun.batch, holder);
      return { started: true, batch: this.batchState() as BatchState };
    } finally {
      if (!handedOn) this.releaseBrowser(holder);
    }
  }

  /**
   * Why a batch in this mode may not begin on this machine now, or null when it may: the entrance
   * rule (`unattendedPrecondition`) asked of the settings as they are at this moment. One place, for
   * the batch and for "Run again from here", which has to ask it before it moves anything.
   */
  private async unattendedRefusal(mode: 'confirm' | 'unattended'): Promise<string | null> {
    const cfg = await this.settings.load();
    return unattendedPrecondition({
      mode,
      allowedPrograms: cfg.execution.allowedPrograms,
      isolation: cfg.execution.isolation,
      lockedToConfirm: cfg.policyLock?.maxMode === 'confirm',
    });
  }

  /**
   * Everything `startBatch` decides before the batch exists: which sessions it has work in, whether
   * an unattended run may begin, and the models the run panel chose. A refusal comes back as the
   * reason; nothing is started here.
   */
  private async prepareBatch(
    wanted: string[],
    onlyTasks: Set<string> | undefined,
    mode: 'confirm' | 'unattended',
    onFailure: 'stop' | 'continue',
    model: string | undefined,
    reviewModel: string | undefined,
    name: string | undefined,
    /** The id its preflight was recorded under; a new one when there was none. */
    id: string = newId('b-'),
  ): Promise<{ batch: BatchState; reason?: undefined } | { batch?: undefined; reason: string }> {
    // Worked out here rather than asked of the operator again: every way into this — the run
    // panel, continuing after a failure, "Run again from here" — either has a field they may
    // have left empty or has no field at all.
    const chosenName = name?.trim() || (await this.suggestRunName(wanted));

    const sessions: BatchSession[] = [];
    for (const id of wanted) {
      const s = await this.store.getSession(id);
      if (!s) {
        sessions.push({ sessionId: id, name: id, state: 'skipped', ran: 0, failed: 0, reason: 'no such session' });
        continue;
      }
      const queued = queuedToRun(s, onlyTasks).length;
      sessions.push(
        queued === 0
          ? { sessionId: id, name: s.name, state: 'skipped', ran: 0, failed: 0, reason: onlyTasks ? 'none of its chosen tasks is queued' : 'nothing queued' }
          : { sessionId: id, name: s.name, state: 'waiting', ran: 0, failed: 0 },
      );
    }

    if (!sessions.some((s) => s.state === 'waiting')) {
      return { reason: 'none of the selected sessions has a queued task' };
    }

    /*
     * The same entrance rule `start` has, asked here too and for the same reason: before a browser
     * is opened. It was missing, and the rule was only met inside the loop, per session, after the
     * window was already up — so on a machine with no isolation the operator pressed the run
     * button, watched Edge open, begin loading the chat and close again, and was told nothing: the
     * session was quietly skipped with the reason held in a batch state nobody was looking at. Asked
     * here, the refusal is the answer to the press, shown under the button that caused it.
     */
    const blocked = await this.unattendedRefusal(mode);
    if (blocked) return { reason: blocked };

    // One model for the whole run, chosen here rather than opened on every session first. It
    // is written onto the sessions instead of being held for the run, so what the session says
    // it will use and what it used are the same thing afterwards — including for anyone who
    // opens one of them tomorrow and wonders which model produced that summary.
    const wantedModel = model?.trim();
    const wantedReviewModel = reviewModel?.trim();
    if (wantedModel || wantedReviewModel) {
      /*
       * The panel starts on the models chosen in Settings. A session that follows Settings and is
       * run on exactly that model is left following it, so choosing another model in Settings
       * later still reaches it; only a different choice, or a session with a model of its own,
       * is written.
       */
      const settingsNow = await this.settings.load();
      const followModel = (settingsNow.copilot.defaultModel ?? '').trim();
      const followReview = (settingsNow.copilot.defaultReviewModel ?? '').trim();
      for (const entry of sessions) {
        if (entry.state !== 'waiting') continue;
        await this.store.updateSession(entry.sessionId, (s) => {
          if (wantedModel && (s.model?.trim() || wantedModel !== followModel)) {
            s.model = wantedModel;
            s.modelSource = 'operator';
          }
          // Only the model is set here, never whether the review happens: a run panel is about
          // this run, and silently switching a session's review on or off from it would be a
          // change to the session that outlives the run.
          if (wantedReviewModel && (s.review?.model?.trim() || wantedReviewModel !== followReview)) {
            s.review = { ...DEFAULT_REVIEW, ...s.review, model: wantedReviewModel };
            s.reviewModelSource = 'operator';
          }
        });
      }
    }

    return {
      batch: {
        id,
        startedAt: new Date().toISOString(),
        name: chosenName,
        ...(onlyTasks ? { onlyTasks: [...onlyTasks] } : {}),
        mode,
        onFailure,
        stopping: false,
        pausing: false,
        running: true,
        sessions,
      },
    };
  }

  /** Stops the session that is running now and leaves the rest of the batch unstarted. */
  /**
   * Holds the run after the task that is running, and lets that task finish first.
   *
   * Not a stop: the task in flight runs its checks, is reviewed and commits, exactly as it would
   * have. What is held is the queue behind it, and the sessions after this one, both of which
   * stay as they are — so continuing is the same act it always was, and the button for it is the
   * one already on the register.
   *
   * It does not release the browser early either. The run ends when the current task does, and
   * the window closes with it, because the Edge profile is single-writer and a run that sat
   * holding it would stop every other session from doing anything at all.
   */
  async pauseBatch(): Promise<{ pausing: boolean }> {
    const batch = this.batch;
    if (!batch?.running || batch.stopping) return { pausing: false };
    batch.pausing = true;
    this.bus.publish({
      sessionId: batch.sessions.find((s) => s.state === 'running')?.sessionId ?? batch.id,
      type: 'batch-pausing',
      level: 'info',
      message: 'pausing: the task that is running will finish, and the rest of the queue stays as it is',
      data: { batchId: batch.id },
    });
    return { pausing: true };
  }

  /** Takes the hold off a run that has not ended yet, so the queue carries on where it was. */
  async resumeBatch(): Promise<{ pausing: boolean }> {
    const batch = this.batch;
    if (!batch?.running || !batch.pausing) return { pausing: false };
    batch.pausing = false;
    this.bus.publish({
      sessionId: batch.sessions.find((s) => s.state === 'running')?.sessionId ?? batch.id,
      type: 'batch-resumed',
      level: 'info',
      message: 'the hold is off; the queue carries on',
      data: { batchId: batch.id },
    });
    return { pausing: false };
  }

  async stopBatch(): Promise<{ stopping: boolean }> {
    const batch = this.batch;
    if (!batch?.running) return { stopping: false };
    batch.stopping = true;
    const current = batch.sessions.find((s) => s.state === 'running');
    if (current) await this.stop(current.sessionId);
    return { stopping: true };
  }

  /**
   * Runs a batch that has just been started, and ends what only the batch may end: its hold and
   * its claim on the browser. Both are let go here, once, however the loop came out — finished,
   * stopped, failed, or never able to open its window.
   */
  private async runBatch(batch: BatchState, holder: BrowserHolder): Promise<void> {
    try {
      await this.batchLoop(batch);
    } finally {
      // A pause holds this batch's queue and nothing after it. Left on, it read as "pausing" on a
      // batch that had ended, and it was what every later run read, so each stopped before its
      // first task (see `shouldPause` in `beginRun`).
      batch.pausing = false;
      // The batch's window is closed by now, in the loop's own ending.
      this.releaseBrowser(holder);
    }
  }

  /**
   * The batch loop. Nothing here runs in parallel, on purpose: see `beginRun`.
   *
   * Each session is judged by the tasks it was given. A session that ran everything without a
   * failure is `done`; one with a failed task is `failed`; one the operator stopped, or one
   * whose chain stopped early with no failure of its own, is `stopped`.
   */
  private async batchLoop(batch: BatchState): Promise<void> {
    /*
     * One browser for the whole batch.
     *
     * Every session used to open its own window and close it again: a fresh launch, a fresh
     * sign-in check and a fresh grab at the profile lock, several times over, for a machine
     * that can only have one of them open at a time anyway. The window is opened here, handed
     * to each session in turn, and closed when the last one is done — so between sessions the
     * only thing that changes is which conversation is on screen.
     */
    let browser: ChatTransport | null = null;
    try {
      const cfg = await this.settings.load();
      await this.browserRequested(batch.id, batch.sessions.filter((x) => x.state === 'waiting').map((x) => x.sessionId));
      browser = await openBrowser(cfg, this.bus, join(cfg.resolved.runsDir, '_browser'), batch.id);
      this.bus.publish({
        sessionId: batch.sessions[0]?.sessionId ?? batch.id,
        type: 'batch-browser-open',
        level: 'info',
        message: `one browser window for all ${batch.sessions.length} session(s) in this run`,
        data: { batchId: batch.id },
      });
    } catch (e) {
      // Without a window nothing can run, and saying so once is better than failing every
      // session in turn with the same message.
      for (const entry of batch.sessions) {
        if (entry.state === 'waiting') {
          entry.state = 'failed';
          entry.reason = `the browser could not be opened: ${(e as Error).message}`;
        }
      }
      batch.running = false;
      batch.finishedAt = new Date().toISOString();
      this.bus.publish({
        sessionId: batch.id,
        type: 'batch-error',
        level: 'error',
        message: `the browser could not be opened: ${(e as Error).message}`,
      });
      return;
    }

    try {
      /*
       * One group for the whole batch, made before the loop rather than per session.
       *
       * That is the entire point of it: the register can then draw one line around everything
       * this press of the button set off, across sessions, which is the question a list of
       * tasks sorted by time cannot answer.
       */
      const runGroup: TaskRunGroup = {
        id: batch.id,
        startedAt: batch.startedAt,
        sessions: batch.sessions.filter((s) => s.state === 'waiting').length,
        ...(batch.name ? { name: batch.name } : {}),
      };

      /*
       * The same run, recorded on each session, with what it was asked to do.
       *
       * Written before the first session starts and for every session including the ones the
       * run may never reach, because that is precisely the case it exists for: a failure in
       * session one leaves sessions two and three with no tasks stamped and no way to know
       * they were ever part of this. Going back afterwards and running the rest again needs
       * the whole list, and this is the only place it is still true.
       */
      let order = 0;
      for (const entry of batch.sessions) {
        if (entry.state !== 'waiting') continue;
        const at = order;
        order += 1;
        await this.store.updateSession(entry.sessionId, (s) => {
          s.runGroup = {
            ...runGroup,
            order: at,
            // What this run was asked to do: the chosen tasks, when some were chosen.
            taskIds: queuedToRun(s, batch.onlyTasks).map((t) => t.id),
            mode: batch.mode,
            onFailure: batch.onFailure,
          };
        });
      }

      for (const entry of batch.sessions) {
        if (entry.state !== 'waiting') continue;
        if (batch.stopping) {
          entry.state = 'skipped';
          entry.reason = 'the batch was stopped before this session started';
          continue;
        }
        // A hold applies to the sessions that have not started as well as to the queue inside
        // the one that has. They are left exactly as they were, which is what makes continuing
        // afterwards the same act as continuing after anything else.
        if (batch.pausing) {
          entry.state = 'skipped';
          entry.reason = 'the run was paused before this session started; its tasks are still queued';
          continue;
        }

        entry.state = 'running';
        this.bus.publish({
          sessionId: entry.sessionId,
          type: 'batch-session-started',
          level: 'info',
          message: `starting as part of a batch of ${batch.sessions.length} session(s), in ${batch.mode} mode`,
          data: { batchId: batch.id },
        });

        // In the batch's mode as it is now: "run the rest without asking" in an earlier session
        // switched the batch with it (see `setRunMode`). The hold is this batch's own.
        const begun = await this.beginRun(entry.sessionId, batch.mode, browser, runGroup, batch.onlyTasks ? new Set(batch.onlyTasks) : undefined, {
          shouldPause: () => batch.pausing,
        });
        if (!begun.started) {
          entry.state = 'skipped';
          entry.reason = begun.reason;
          continue;
        }

        const tally = await begun.done;
        entry.ran = tally.ran;
        entry.failed = tally.failed;

        if (tally.refused) {
          // Refused at its turn, before anything of it ran: not a failure of its tasks, which stay queued.
          entry.state = 'skipped';
          entry.reason = tally.refused;
        } else if (tally.error) {
          entry.state = 'failed';
          entry.reason = tally.error;
        } else if (tally.failed > 0) {
          entry.state = 'failed';
          entry.reason = `${tally.failed} task(s) did not finish: ${tally.failedTitles.join(', ')}`;
        } else if ((tally.stopped ?? 0) > 0) {
          entry.state = 'stopped';
          // The task cut short is counted as what it is: "after 0 task(s)" beside ran 1 read as if nothing ran (live run 2026-10-04).
          const finished = tally.ran - (tally.stopped ?? 0);
          entry.reason = `stopped by the operator: ${tally.stopped} task(s) cut short${finished > 0 ? `, after ${finished} that finished` : ''}; ${tally.leftQueued} still queued`;
        } else if (tally.paused) {
          entry.state = 'stopped';
          entry.reason = `paused after ${tally.ran} task(s); ${tally.leftQueued} still queued`;
        } else if (batch.stopping || tally.leftQueued > 0) {
          entry.state = 'stopped';
          entry.reason = `${tally.leftQueued} task(s) never started`;
        } else {
          entry.state = 'done';
        }

        this.bus.publish({
          sessionId: entry.sessionId,
          type: 'batch-session-finished',
          level: entry.state === 'failed' || tally.refused ? 'warn' : 'info',
          message: tally.refused ? 'this session was refused at its turn inside the batch; its tasks stay queued' : `this session ended ${entry.state} inside the batch`,
          data: { batchId: batch.id, ran: entry.ran, failed: entry.failed },
        });

        // A session refused at its turn breaks a chain as a failed one does.
        if ((entry.state === 'failed' || tally.refused) && batch.onFailure === 'stop') {
          batch.stopping = true;
          this.bus.publish({
            sessionId: entry.sessionId,
            type: 'batch-stopped-early',
            level: 'warn',
            message: 'the batch is set to stop on a failure, so the sessions after this one stay as they are',
            data: { batchId: batch.id },
          });
        }
      }
    } catch (e) {
      // Nothing above is expected to throw: a failing run resolves rather than rejects. If
      // something does, the batch has to end here and say so, because this promise is not
      // awaited anywhere and an escaping rejection would take the whole API process down.
      const current = batch.sessions.find((s) => s.state === 'running');
      if (current) {
        current.state = 'failed';
        current.reason = (e as Error).message;
      }
      this.bus.publish({
        sessionId: current?.sessionId ?? batch.id,
        type: 'batch-error',
        level: 'error',
        message: (e as Error).message,
      });
    } finally {
      for (const entry of batch.sessions) {
        if (entry.state === 'waiting' || entry.state === 'running') {
          entry.state = 'skipped';
          entry.reason ??= 'the batch ended before this session ran';
        }
      }
      // The window outlived every session in the batch; it does not outlive the batch.
      await browser?.close().catch(() => undefined);
      batch.running = false;
      batch.finishedAt = new Date().toISOString();
    }
  }

  // --- plans ----------------------------------------------------------------------------

  /** The brief the operator hands to a chat model, in the language the interface is in. */
  /**
   * The persona, assembled: the software part (fixed, this project's), the machine's projects
   * by path, and the organisation's part (the operator's, edited on the plan page). Returned
   * whole for copying and in parts for showing, so the page can say which is which.
   */
  async planBrief(opts: BriefOptions): Promise<{
    text: string;
    software: string;
    organisation: string;
    customised: boolean;
    example: string;
    persona: string;
    personaCustomised: boolean;
    personaExample: string;
    work: string;
    workCustomised: boolean;
    workExample: string;
  }> {
    // The machine's projects go into the brief by absolute path, so a plan across a front
    // end, a back end and a test suite is written with the folders that exist rather than
    // with three paths the chat model had to ask for and the operator typed from memory.
    const lang = opts.lang === 'bg' ? 'bg' : 'en';
    const project = await this.project();
    const projects = [
      ...(project.rootDir ? [{ name: project.name, rootDir: project.rootDir, repo: project.repoOk, isDefault: true }] : []),
      ...project.others.map((o) => ({ name: o.name, rootDir: o.rootDir, repo: o.repoOk, isDefault: false })),
    ];
    const [organisation, persona, work] = await Promise.all([
      this.getContext('organisation', lang),
      this.getContext('persona', lang),
      this.getContext('work', lang),
    ]);
    /*
     * Whether a run with nobody watching can start here, asked of the same rule the runner applies
     * at the entrance — so the brief cannot tell Kerrigan the unattended button works while the run
     * refuses it, which is exactly what the first test of her did.
     */
    const cfg = await this.settings.load();
    const unattendedRule = { mode: 'unattended' as const, allowedPrograms: cfg.execution.allowedPrograms, isolation: cfg.execution.isolation, lockedToConfirm: cfg.policyLock?.maxMode === 'confirm' };
    /*
     * Which of its refusals it is, asked in the order the rule asks them: the lock, then isolation,
     * then the allowlist. Anything that was not isolation used to be told as an empty allowlist, so
     * under a policy lock the brief sent the operator to fill in a list that was already full.
     */
    const unattendedBlocked: UnattendedBlock | undefined = !unattendedPrecondition(unattendedRule)
      ? undefined
      : unattendedRule.lockedToConfirm
        ? 'lock'
        : unattendedIsolationRefusal('unattended', cfg.execution.isolation)
          ? 'isolation'
          : 'allowlist';
    return {
      text: planBrief({
        lang,
        projects,
        organisation: organisation.content,
        organisationExample: organisation.example,
        persona: persona.content,
        personaExample: persona.example,
        work: work.content,
        workExample: work.example,
        unattendedBlocked,
      }),
      software: planBrief({ lang, projects }),
      organisation: organisation.content,
      customised: organisation.customised,
      example: organisation.example,
      persona: persona.content,
      personaCustomised: persona.customised,
      personaExample: persona.example,
      work: work.content,
      workCustomised: work.customised,
      workExample: work.example,
    };
  }

  /**
   * Reads a pasted plan and says what it means, or what is wrong with it.
   *
   * A valid plan is also checked against what the store already holds, because the most
   * likely mistake with this page is not a malformed document: it is pressing the button
   * twice, or pasting the plan that is already imported instead of the corrected one. That is
   * reported, not refused — importing the same work twice is a thing people legitimately do.
   */
  async checkPlan(text: string): Promise<PlanCheckResult> {
    await this.init();
    const check = checkPlan(text ?? '');
    if (!check.ok) return { ...check, duplicates: [] };

    /*
     * A plan can ask for version control in a folder that is not a repository on this machine.
     * The document is not wrong; this machine is not ready for it. It is refused all the same,
     * and the message says which of the two it is, because importing it would create sessions
     * that claim a way back they do not have.
     */
    const repoIssues: PlanIssue[] = [];
    check.plan.sessions.forEach((session, i) => {
      if (session.vcs?.enabled === false) {
        // Without version control the project folder must still be there (live run 2026-10-03: not looked at).
        const folder = (session.projectDir ?? '').trim();
        if (folder && !existsSync(folder)) repoIssues.push({ path: `sessions[${i}].projectDir`, message: `${folder} does not exist. Name the session's project folder, or create it.` });
        return;
      }
      const dir = plannedRepoDir(session);
      const reason = repoUnusableReason(dir);
      if (reason) repoIssues.push({ path: `sessions[${i}].vcs.repoDir`, message: reason });
      else if (!dir) {
        repoIssues.push({
          path: `sessions[${i}].vcs.repoDir`,
          message:
            'This session asks for version control but names no repository. Give it the absolute path of a git ' +
            'repository, or set "enabled": false for it.',
        });
      }
    });
    if (repoIssues.length > 0) return { ok: false, issues: repoIssues, warnings: check.warnings, duplicates: [] };

    /*
     * A branch to carry on must be there to carry on — unless a session before it in this same plan
     * is the one that makes it, in this same repository. Refused now, with the branches that are
     * there, rather than at the first run with a task refused.
     *
     * The repository is part of the question. A branch is a branch of one repository, and the name
     * alone let a branch an earlier session makes somewhere else count here: the plan was accepted,
     * and the session failed at its first task with "no such local branch" — the failure this check
     * exists to bring forward.
     */
    for (const [i, session] of check.plan.sessions.entries()) {
      const wanted = session.vcs?.enabled === false ? '' : (session.vcs?.existingBranch ?? '').trim();
      if (!wanted) continue;
      const dir = plannedRepoDir(session);
      const here = normaliseDir(dir);
      const madeEarlier = check.plan.sessions
        .slice(0, i)
        .some((e) => normaliseDir(plannedRepoDir(e)) === here && branchesMadeBy(e).includes(wanted));
      if (madeEarlier || (await branchExists(dir, wanted))) continue;
      const have = await localBranches(dir);
      repoIssues.push({
        path: `sessions[${i}].vcs.existingBranch`,
        message:
          `${dir} has no local branch "${wanted}" to carry on. ` +
          (have.length > 0 ? `Its branches: ${have.slice(0, 20).join(', ')}.` : 'It has no branches yet.') +
          ' Give the exact name, or use startFrom "branch" to start a new one.',
      });
    }
    if (repoIssues.length > 0) return { ok: false, issues: repoIssues, warnings: check.warnings, duplicates: [] };

    /*
     * A check the runner refuses for its own command line under these Settings: every start of its task
     * is refused for it, so it is said here, at the check, and not only at the start (live run 2026-10-04:
     * "check" said ok and the first start was refused). A warning, since the Settings may be changed.
     */
    const cfg = await this.settings.load();
    const shell = preferredShell(cfg.execution.defaultShell);
    const others = [cfg.project.rootDir, ...cfg.project.others.map((o) => o.rootDir)];
    const lineWarnings: string[] = [];
    check.plan.sessions.forEach((session, i) => {
      const cwd = (session.vcs?.enabled === false ? '' : plannedRepoDir(session)) || (session.projectDir ?? '').trim() || cfg.resolved.cwd;
      const roots = sessionRoots(cwd, others);
      session.tasks.forEach((task, j) => {
        for (const c of task.checks ?? []) {
          const run = c.run?.trim();
          if (!run) continue;
          const why = lineRefusal(run, c.shell ?? shell, c.cwd ? resolve(cwd, c.cwd) : cwd, cfg.execution, roots);
          if (why) lineWarnings.push(`sessions[${i}].tasks[${j}] ("${task.title}"): the check "${c.name}" is refused by the runner for its own command line, so the task cannot start until it is changed: ${checkRefusalForOperator(why)}.`);
        }
      });
    });

    return { ...check, warnings: [...check.warnings, ...lineWarnings], duplicates: await this.findDuplicates(check.plan) };
  }

  /**
   * Sessions the store already holds that this plan would create again, task for task.
   *
   * Matched on the name and on the text that would actually be sent, in order. Not on the
   * level 2, the model or the branch names: those are edited on a session after an import, and
   * a session whose instructions were tightened by hand is still the same session this plan
   * describes.
   */
  private async findDuplicates(plan: Plan): Promise<PlanDuplicate[]> {
    const existing = await this.store.listSessions();
    const out: PlanDuplicate[] = [];

    for (const planned of plan.sessions) {
      const wanted = plannedSessionSignature(planned);
      const match = existing.find(
        (s) =>
          s.name.trim().toLowerCase() === planned.name.trim().toLowerCase() &&
          s.tasks.length === planned.tasks.length &&
          s.tasks.map((t) => taskSignature(t)).join('\u0001') === wanted,
      );
      if (match) {
        out.push({ name: match.name, sessionId: match.id, createdAt: match.createdAt, tasks: match.tasks.length });
      }
    }
    return out;
  }

  /**
   * Validates a plan and creates everything in it. Nothing is started.
   *
   * A plan that does not validate is refused as a whole rather than imported in part: half a
   * plan in the session list is harder to recognise, and harder to undo, than none of it.
   */
  async importPlan(
    text: string,
  ): Promise<
    | { ok: true; result: ImportResult; summary: PlanSummary; duplicates: PlanDuplicate[] }
    | { ok: false; check: PlanCheckResult }
  > {
    await this.init();
    const check = await this.checkPlan(text);
    if (!check.ok) return { ok: false, check };

    const cfg = await this.settings.load();
    /*
     * The persona in force right now is the one this import carries. Read here, once, and written
     * into every task, so a session keeps the approach it was created with: changing the field
     * afterwards changes the next import, not work already queued. The content does not depend on
     * the language asked for; only the shipped example does.
     */
    const persona = (await this.getContext('persona', 'en')).content;
    // No default models passed: a session the plan gives no model follows Settings at run time.
    // The default project is passed, so a session the plan gives no folder works where one made
    // on the Sessions page would, and not in execution.cwd.
    const result = await importPlan(this.store, check.plan, '', '', persona, (cfg.project?.rootDir ?? '').trim());
    return {
      ok: true,
      result: { ...result, warnings: [...check.warnings, ...result.warnings] },
      summary: check.summary,
      // The sessions this import has just made a second copy of, reported after the fact for
      // the same reason it is reported before: so nobody has to notice it in a list.
      duplicates: check.duplicates,
    };
  }

  // --- approvals ------------------------------------------------------------------------

  /**
   * Asks the operator to choose the model in the Copilot window, when the runner could not (operator's
   * request, 2026-10-06). It waits on the approvals card like a held step, in every mode, until it is
   * answered or the run is stopped.
   */
  askModelHelp(
    ask: { sessionId: string; asked: string; shown: string | null; why: string; tries: number },
    signal: AbortSignal,
  ): Promise<'recheck' | 'continue' | 'stop'> {
    return new Promise((resolveAnswer) => {
      if (signal.aborted) {
        resolveAnswer('stop');
        return;
      }
      const approval: PendingApproval = {
        id: newId('a-'),
        sessionId: ask.sessionId,
        taskId: '',
        stepId: 0,
        description: `Choose "${ask.asked}" in the Copilot window`,
        createdAt: new Date().toISOString(),
        model: { asked: ask.asked, shown: ask.shown, why: ask.why, tries: ask.tries },
      };
      this.waiting.set(approval.id, {
        approval,
        resolve: (d) => resolveAnswer(d.action === 'run' ? 'recheck' : d.action === 'skip' ? 'continue' : 'stop'),
      });
      this.bus.publish({ sessionId: ask.sessionId, type: 'approval-requested', level: 'warn',
        message: `choose "${ask.asked}" in the Copilot window, then answer on the card`, data: { approvalId: approval.id, model: approval.model } });
    });
  }

  pendingApprovals(sessionId?: string): PendingApproval[] {
    return [...this.waiting.values()].map((w) => w.approval).filter((a) => !sessionId || a.sessionId === sessionId);
  }

  /**
   * Answers one pending approval.
   *
   * `run-all` is `run` plus a decision about everything after it: the run stops asking. It is
   * here rather than as a separate endpoint because it is the answer to the question on
   * screen, and because the step in front of the operator is the one that earns their trust
   * in the rest. The deny list is untouched by it.
   */
  decide(approvalId: string, action: 'run' | 'skip' | 'abort' | 'run-all'): { ok: boolean } {
    const w = this.waiting.get(approvalId);
    if (!w) return { ok: false };
    this.waiting.delete(approvalId);

    if (action === 'run-all') this.setRunMode(w.approval.sessionId, 'unattended');

    const decision: PolicyDecision =
      action === 'run' || action === 'run-all'
        ? { action: 'run' }
        : action === 'skip'
          ? { action: 'skip', reason: 'skipped by the operator', by: 'operator' }
          : { action: 'abort', reason: 'aborted by the operator', by: 'operator' };
    w.resolve(decision);
    this.bus.publish({ sessionId: w.approval.sessionId, taskId: w.approval.taskId, type: 'approval-decided', level: 'info',
      message: `step ${w.approval.stepId}: ${action}`, data: { approvalId, action } });
    return { ok: true };
  }

  /**
   * Switches a run between asking and not asking, while it is running.
   *
   * Going to `unattended` also releases whatever is already waiting, because leaving a step
   * on screen asking a question nobody will answer again is the one outcome this must not
   * produce. Going back to `confirm` only affects steps that have not been proposed yet.
   */
  setRunMode(sessionId: string, mode: 'confirm' | 'unattended'): { ok: boolean; mode?: 'confirm' | 'unattended'; reason?: string } {
    const run = this.running.get(sessionId);
    if (!run) return { ok: false };
    if (run.mode === mode) return { ok: true, mode };

    /*
     * "Run the rest without asking" is a request to become an unattended run, so it answers to the
     * same preconditions as one started that way. Refusing here keeps the button honest: it cannot
     * hand out an autonomy the run would not have been allowed to start with.
     */
    if (mode === 'unattended') {
      const blocked = unattendedPrecondition({ ...run.policy, mode });
      if (blocked) return { ok: false, reason: blocked };
    }

    run.mode = mode;
    /*
     * The authorizer's rules read the mode from this same policy object, so it changes with the run.
     * Without this line "run the rest without asking" stopped the asking but left the rules believing
     * a person was watching: the extra unattended rule — no allowed interpreter evaluating a string,
     * no shell inside a shell — was never applied to the steps that followed, exactly the steps no
     * one would read.
     */
    run.policy.mode = mode;
    /*
     * A batch is one run. The dialog behind "run the rest without asking" says "until this run
     * ends", and the run the operator started is the batch: the switch used to reach only the
     * session on screen, and the next session started in the batch's old mode and asked again. So
     * the sessions the batch has not reached yet start in the mode it is switched to — and back,
     * when the asking is switched on again. Each still meets the unattended precondition as it
     * starts (see `beginRun`), under the settings of that moment, and the run recorded on it
     * (`Session.runGroup`) keeps the mode it was started in.
     */
    const batch = this.batch?.running && this.batch.sessions.some((e) => e.sessionId === sessionId && e.state === 'running') ? this.batch : null;
    if (batch) batch.mode = mode;
    this.bus.publish({
      sessionId,
      type: 'run-mode-changed',
      level: mode === 'unattended' ? 'warn' : 'info',
      message:
        mode === 'unattended'
          ? `the rest of this run${batch ? ', the sessions of the batch after this one included,' : ''} will execute without asking; denied patterns are still refused`
          : `every further step${batch ? ', in this session and the ones of the batch after it,' : ''} will be shown for approval again`,
      data: { mode, ...(batch ? { batchId: batch.id } : {}) },
    });

    if (mode === 'unattended') {
      for (const [id, w] of this.waiting) {
        if (w.approval.sessionId !== sessionId) continue;
        // A fetch waits for its own answer: "run the rest without asking" is not an answer to it.
        if (w.approval.network || w.approval.model) continue;
        this.waiting.delete(id);
        w.resolve({ action: 'run' });
      }
    }
    return { ok: true, mode };
  }

  runMode(sessionId: string): 'confirm' | 'unattended' | undefined {
    return this.running.get(sessionId)?.mode;
  }


  private webAuthorizer(policy: PolicyConfig, signal: AbortSignal): StepAuthorizer {
    return makeAuthorizer(policy, (step, ctx, held) =>
      new Promise<PolicyDecision>((resolvePromise) => {
        // A stopped run answers before anything else, the mode included: "run the rest without
        // asking" is permission to run the steps of a run that is going, not of one that was stopped.
        if (signal.aborted) {
          resolvePromise({ action: 'abort', reason: 'stopped by the operator', by: 'operator' });
          return;
        }
        // The operator may have pressed "run the rest without asking" on an earlier step.
        // This is checked per step rather than captured once, which is what makes the switch
        // take effect from the very next step instead of the next run. A held step is the
        // exception: it is asked about in an unattended run too, which is the point of holding it.
        if (!held && this.running.get(ctx.sessionId ?? '')?.mode === 'unattended') {
          resolvePromise({ action: 'run' });
          return;
        }

        const approval: PendingApproval = {
          id: newId('a-'),
          sessionId: ctx.sessionId ?? '',
          taskId: ctx.taskId ?? '',
          stepId: step.id,
          description: `[${step.shell ?? 'pwsh'}] ${step.cmd}`,
          createdAt: new Date().toISOString(),
          ...(held ? { network: held.network } : {}),
        };
        this.waiting.set(approval.id, { approval, resolve: resolvePromise });
        this.bus.publish({ sessionId: approval.sessionId, taskId: approval.taskId, type: 'approval-requested', level: 'warn',
          message: held
            ? `held for the operator — ${held.network}: ${approval.description}`
            : `waiting for approval: ${approval.description}`,
          data: { ...approval } });
      }),
      signal,
    );
  }

  // --- events ---------------------------------------------------------------------------

  recentEvents(sessionId: string): SessionEvent[] {
    return this.bus.recent(sessionId);
  }

  subscribe(sessionId: string, handler: (e: SessionEvent) => void): () => void {
    return this.bus.subscribe(sessionId, handler);
  }

  // --- version control ----------------------------------------------------------------------

  /**
   * Version control for the sessions of a run, one group per repository, with what can be done about
   * it from the run screen. See `vcs/runPreflight.ts`. Only sessions that have something queued count.
   */
  async runVcs(sessionIds: string[], onlyTasks?: ReadonlySet<string>): Promise<RunVcsGroup[]> {
    await this.init();
    const sessions: Session[] = [];
    for (const id of sessionIds) {
      const s = await this.store.getSession(id);
      if (s && queuedToRun(s, onlyTasks).length > 0) sessions.push(s);
    }
    return await runVcsPreflight(sessions, () => this.store.listSessions());
  }

  /**
   * The run's version control preflight: why the run may not start, said before anything opens the
   * browser, creates a task attempt or emits `task-started`; null when it may.
   *
   * Recorded as it happens, in the run's own log (`session/runLog.ts`) and on each session's event
   * stream: `run-preflight-started`, one `repository-preflight` per repository, `baseline-created` for
   * a starting snapshot taken on the run screen, `snapshot-approval-required` where the operator has a
   * fix to press, then `run-preflight-passed` or `run-preflight-refused`. The browser is asked for
   * only after a pass (`browser-launch-requested`), so the export can show the order.
   */
  private async runPreflight(runId: string, sessionIds: string[], onlyTasks?: ReadonlySet<string>): Promise<string | null> {
    const cfg = await this.settings.load();
    const log: RunLogEntry[] = [];
    const note = (type: RunLogType, message: string, data: Record<string, unknown>, ids: string[], level: 'info' | 'warn' = 'info'): void => {
      log.push({ at: new Date().toISOString(), type, message, data });
      for (const id of ids) this.bus.publish({ sessionId: id, type, level, message, data: { runId, ...data } });
    };
    note('run-preflight-started', `version control preflight for ${sessionIds.length} session(s), before the browser opens`, { sessions: sessionIds }, sessionIds);
    const groups = await this.runVcs(sessionIds, onlyTasks);
    for (const g of groups) {
      const ids = g.sessions.map((x) => x.id);
      const first = ids[0] ? await this.store.getSession(ids[0]) : null;
      const start = first?.vcsStart;
      // Said once, in the first run after the snapshot: a re-run clears `startedAt`, so earlier attempts count too.
      const untouched = !!first && !first.tasks.some((t) => t.startedAt || (t.attempts ?? []).some((a) => a.startedAt));
      if (start?.kind === 'snapshot' && start.snapshot?.approved && untouched) {
        note('baseline-created', `starting snapshot ${start.commit.slice(0, 8)} on ${start.branch ?? '?'}, approved ${start.snapshot.approvedAt ?? ''}${start.snapshot.onBase ? ` on top of "${start.snapshot.fromBranch}"` : ''}`, {
          repoDir: g.repoDir,
          commit: start.commit,
          branch: start.branch,
          approvedAt: start.snapshot.approvedAt,
          onBase: !!start.snapshot.onBase,
          included: start.snapshot.included.length,
        }, ids);
      }
      note('repository-preflight', `${g.repoDir}: ${g.ready ? 'ready' : g.problem ?? 'needs your approval'}`, {
        repoDir: g.repoDir,
        ready: g.ready,
        branch: g.branch,
        head: g.head,
        ...(g.baseBranch ? { baseBranch: g.baseBranch, baseHead: g.baseHead } : {}),
        ...(g.workBranch ? { workBranch: g.workBranch } : {}),
        ...(g.carry ? { carry: g.carry } : {}),
        sessions: g.sessions.map((x) => ({ id: x.id, name: x.name, startFrom: x.startFrom, role: x.role, started: x.started })),
        inputPatterns: g.inputPatterns,
        inputs: g.inputs.map((e) => e.path),
        unrelated: g.unrelated.map((u) => u.path),
        ...(g.problem ? { problem: g.problem } : {}),
      }, ids, g.ready ? 'info' : 'warn');
      const fixes = g.actions.filter((a) => a.available && a.id !== 'review-inputs').map((a) => a.id);
      if (!g.ready && fixes.length > 0) {
        const label: Record<string, string> = {
          'snapshot-on-base': `Create starting snapshot on ${g.baseBranch ?? 'the base branch'}`,
          'snapshot-here': `Create starting snapshot on ${g.branch ?? 'HEAD'}`,
          'use-current-branch': `Use the current branch instead of ${g.baseBranch ?? 'the base branch'}`,
          'allow-snapshot': 'Take uncommitted changes as a starting snapshot',
        };
        note('snapshot-approval-required', `${g.repoDir}: nothing runs until one of these is pressed under "Prepare version control for this run" on the Sessions page: ${fixes.map((f) => `"${label[f] ?? f}"`).join(', ')}`, { repoDir: g.repoDir, actions: fixes }, ids, 'warn');
      }
    }
    const open = groups.filter((g) => !g.ready);
    // A task that contradicts itself, said here too: found at its start, it had already cut a branch and used an attempt.
    const contradictions: string[] = [];
    const reposBefore = new Set<string>();
    for (const id of sessionIds) {
      const s = await this.store.getSession(id);
      const repo = s ? trackedRepoOf(s) : '';
      const afterOthers = !!repo && reposBefore.has(resolve(repo).toLowerCase());
      if (repo) reposBefore.add(resolve(repo).toLowerCase());
      const said = s ? await this.contractRefusal(s, onlyTasks, afterOthers) : null;
      if (said) {
        contradictions.push(said);
        // Said once here as what it is; the refusal below names it again with everything else in the way.
        note('task-contract-refused', said, { session: id, contract: true }, [id], 'warn');
      }
    }
    const parts = [
      ...(open.length > 0
        ? [
            'Version control is not ready for this run, so nothing was opened or sent. ' +
              open.map((g) => `${g.repoDir}: ${g.problem ?? 'it needs your approval'}`).join(' ') +
              ' Fix it under "Prepare version control for this run" on the Sessions page.',
          ]
        : []),
      ...(contradictions.length > 0 ? [`${open.length > 0 ? '' : 'Nothing was opened or sent. '}${contradictions.join(' ')}`] : []),
    ];
    const reason = parts.length === 0 ? null : parts.join(' ');
    if (reason) note('run-preflight-refused', reason, { repositories: open.map((g) => g.repoDir) }, sessionIds, 'warn');
    else note('run-preflight-passed', `version control is ready in ${groups.length} repositor${groups.length === 1 ? 'y' : 'ies'}; the browser may open`, { repositories: groups.map((g) => g.repoDir) }, sessionIds);
    await appendRunLog(cfg.resolved.runsDir, runId, log).catch(() => undefined);
    return reason;
  }

  /**
   * Why the session's next task cannot start because it contradicts itself — read-only and scoped, or
   * a file check that needs a change the task may not make — or null. The part of the contract that
   * depends on the branch the runner will choose is checked at the task's start, once that is known.
   */
  private async contractRefusal(session: Session, onlyTasks?: ReadonlySet<string>, afterOthers = false): Promise<string | null> {
    const next = queuedToRun(session, onlyTasks)[0];
    if (!next) return null;
    const cfg = await this.settings.load();
    const work = workingDirFor(session, cfg.resolved.cwd);
    if (isWorkingDirProblem(work)) return null;
    /*
     * The branch the task will be on, where that is known before the run: so a check that expects another
     * branch is refused here too, not after the browser opened and a branch was cut (live run 2026-10-04).
     */
    const prefix = session.vcs?.branchPrefix || 'cop/';
    const attempt = next.attempt ?? 1;
    const branch = !session.vcs?.enabled
      ? undefined
      : session.vcs.startFrom === 'existing-branch'
        ? session.vcs.existingBranch?.trim() || undefined
        : session.vcs.branchMode === 'per-session'
          ? sessionBranchName(session)
          : next.vcsPlan?.branch?.trim()
            ? plannedBranchName(next.vcsPlan.branch, prefix, attempt)
            : branchNameFrom([session.name, next.title, attempt > 1 ? `a${attempt}` : undefined], prefix);
    const files = await this.contractTree(session, afterOthers).catch((): ContractTree => 'unknown');
    // Input files are carried onto a first start from their last capture: not judged before it (see `contract.ts`).
    const carried = !session.vcsBaseCommit ? inputSettings(session.vcs)?.patterns : undefined;
    const conflicts = await contractConflicts(next, work.cwd, repoDirOf(session) || work.cwd, { branch, files, carried }).catch(() => [] as string[]);
    // A plan check the runner refuses for its own command line can never run: the task could never pass.
    const roots = sessionRoots(work.cwd, [cfg.project.rootDir, ...cfg.project.others.map((o) => o.rootDir)]);
    const shell = preferredShell(cfg.execution.defaultShell);
    for (const c of next.checks ?? []) {
      const run = c.run?.trim();
      if (!run) continue;
      const why = lineRefusal(run, c.shell ?? shell, c.cwd ? resolve(work.cwd, c.cwd) : work.cwd, cfg.execution, roots);
      if (why) conflicts.push(`The check "${c.name}" is refused by the runner for its own command line, so it can never run and the task could never pass: ${checkRefusalForOperator(why)}.`);
    }
    return conflicts.length === 0
      ? null
      : `The task "${next.title}" of "${session.name}" contradicts itself, so it was not started and stays queued: ${conflicts.join(' ')} Change the prompt, the checks, the scope or read-only on the session's page, and start again.`;
  }

  /**
   * Where the next task's file checks can be judged before the run: see `ContractTree`. The folder holds
   * the task's tree only when nothing is still to happen to it first — no update from a remote, no
   * earlier session of the batch in the same repository (`afterOthers`) — and otherwise the commit the
   * task starts from is read where it is already known, or the checks wait for the task's start.
   */
  private async contractTree(session: Session, afterOthers: boolean): Promise<ContractTree> {
    const repo = trackedRepoOf(session);
    if (!repo) return 'tree';
    if (session.vcsBaseCommit) {
      if (session.vcs?.branchMode !== 'per-session') return { ref: session.vcsBaseCommit };
      // A started session goes on from where its last task left its branch: the folder, when still on it.
      const last = [...session.tasks].reverse().find((t) => t.vcs?.branch)?.vcs?.branch;
      const now = await git(repo, ['branch', '--show-current']);
      return last && now.ok && now.stdout === last ? 'tree' : 'unknown';
    }
    if (session.vcsStart?.commit) return { ref: session.vcsStart.commit };
    const how = session.vcs?.startFrom ?? 'head';
    if (how === 'head') return afterOthers ? 'unknown' : 'tree';
    if (how === 'previous-session') return 'unknown';
    const branch = how === 'existing-branch' ? session.vcs?.existingBranch?.trim() : session.vcs?.baseBranch?.trim() || 'main';
    if (!branch) return 'unknown';
    // Brought up to its remote first: what that brings is known only then.
    if (session.vcs?.updateFromRemote !== false) {
      const remotes = await git(repo, ['remote']);
      if (!remotes.ok || remotes.stdout.trim() !== '') return 'unknown';
    }
    const tip = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    return tip.ok && tip.stdout ? { ref: tip.stdout } : 'unknown';
  }

  /**
   * The same rule for one session that has not started, when its turn comes: see `RunDeps.vcsGate`.
   * A session that has started is past its first preparation; its tasks are prepared as they come.
   */
  private async sessionVcsGate(session: Session, onlyTasks?: ReadonlySet<string>): Promise<string | null> {
    const contradiction = await this.contractRefusal(session, onlyTasks);
    if (contradiction) return contradiction;
    if (!session.vcs?.enabled || session.vcsBaseCommit) return null;
    if (queuedToRun(session, onlyTasks).length === 0) return null;
    const [group] = await runVcsPreflight([session], () => this.store.listSessions());
    if (!group || group.ready) return null;
    // The panel is named only where it has a fix to offer: for a chain waiting on its predecessor the remedy is that one's Continue (live run 2026-10-04).
    const panel = group.actions.some((a) => a.available && a.id !== 'review-inputs');
    return `Version control is not ready for "${session.name}", so it did not start and its tasks stay queued: ${group.problem ?? 'it needs your approval'}${panel ? ' Fix it under "Prepare version control for this run" on the Sessions page.' : ''}`;
  }

  /** Recorded in the run's log just before the browser is opened for it: see `runPreflight`. */
  private async browserRequested(runId: string, sessionIds: string[]): Promise<void> {
    const cfg = await this.settings.load();
    const entry: RunLogEntry = { at: new Date().toISOString(), type: 'browser-launch-requested', message: 'the version control preflight passed; opening the browser', data: { sessions: sessionIds } };
    for (const id of sessionIds) this.bus.publish({ sessionId: id, type: entry.type, level: 'info', message: entry.message, data: { runId, ...entry.data } });
    await appendRunLog(cfg.resolved.runsDir, runId, [entry]).catch(() => undefined);
  }

  /** One action of "Prepare version control for this run". Refused while anything runs in that repository. */
  async runVcsPrepare(sessionIds: string[], repoDir: string, action: RunVcsActionId, choices: Record<string, SnapshotChoice>): Promise<{ ok: boolean; problem?: string; result?: string }> {
    await this.init();
    if (this.batch?.running) return { ok: false, problem: 'A run is going. Stop it before preparing version control.' };
    const other = await this.runningIn(repoDir);
    if (other) return { ok: false, problem: `Session "${other.name}" is running in this repository. Stop it first.` };
    const sessions: Session[] = [];
    for (const id of sessionIds) {
      const s = await this.store.getSession(id);
      if (s && queuedToRun(s).length > 0) sessions.push(s);
    }
    const done = await runVcsPrepare(
      sessions,
      repoDir,
      action,
      choices && typeof choices === 'object' ? choices : {},
      this.bus,
      async (id, mutate) => void (await this.store.updateSession(id, mutate)),
      () => this.store.listSessions(),
    );
    // Kept on every session the action was for, with what it did: see `appendSessionLog`.
    if (done.ok && action !== 'review-inputs') {
      const cfg = await this.settings.load();
      for (const s of sessions.filter((x) => normaliseDir(repoDirOf(x)) === normaliseDir(repoDir))) {
        const message = `run screen: "${action}" in ${repoDir}: ${done.result}`;
        await appendSessionLog(cfg.resolved.runsDir, s.id, { type: 'run-screen-action', message, data: { action, repoDir, before: { startFrom: s.vcs?.startFrom, baseBranch: s.vcs?.baseBranch } } }).catch(() => undefined);
        this.bus.publish({ sessionId: s.id, type: 'run-screen-action', level: 'info', message, data: { action, repoDir } });
      }
    }
    return done.ok ? { ok: true, result: done.result } : { ok: false, problem: done.problem };
  }

  /** Whether version control can do its job in this session, asked before a run. */
  async vcsStatus(
    sessionId: string,
  ): Promise<{ ok: boolean; repoDir: string; branch?: string; problem?: string; git?: string | null; work?: SessionBranches; branches?: string[] }> {
    await this.init();
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error('No such session.');
    const git = await gitAvailable();
    if (!git) return { ok: false, repoDir: '', problem: "git is not installed, or not on this machine's PATH.", git: null };
    // `branch` is where HEAD is; `work` is where the session's work is. After a per-task run
    // those differ, and the second is the one the operator is asking about.
    const preflight = await vcsPreflight(session, () => this.store.listSessions());
    // The local branches, so "carry on an existing branch" can offer them rather than be typed blind.
    const branches = preflight.repoDir ? await localBranches(preflight.repoDir) : [];
    return { ...preflight, git, work: sessionBranches(session), branches };
  }

  /**
   * The operator's approval of the starting snapshot: their uncommitted changes become the commit the
   * session starts from, each file taken or left out as they chose on the list. See `vcs/snapshot.ts`.
   * Refused while anything could be working in the repository, as a restore is: it changes branches.
   */
  async vcsSnapshot(sessionId: string, choices: Record<string, SnapshotChoice>): Promise<{ ok: boolean; problem?: string; branch?: string; commit?: string }> {
    await this.init();
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error('No such session.');
    const refused = await this.restoreRefusal(session);
    if (refused) return { ok: false, problem: refused };
    const taken = await takeSnapshot(
      session,
      { approved: true, choices: choices && typeof choices === 'object' ? choices : {} },
      this.bus,
      async (mutate) => void (await this.store.updateSession(sessionId, mutate)),
      () => this.store.listSessions(),
    );
    return taken.ok ? { ok: true, branch: taken.start.branch, commit: taken.start.commit } : { ok: false, problem: taken.problem };
  }

  /**
   * What going back to before a task would do, and then doing it.
   *
   * Two calls rather than one because the operator has to read the consequence before they
   * agree to it: which commits the restored branch will not have, and which branch keeps them.
   */
  async restorePreview(sessionId: string, taskId: string): Promise<RestorePreview> {
    await this.init();
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error('No such session.');
    const task = session.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('No such task.');
    const preview = await restorePreview(session, task);
    // Said in the preview too, so the dialog refuses before the operator agrees to anything,
    // rather than showing what would happen and refusing when they say yes.
    const refused = await this.restoreRefusal(session);
    return refused ? { ...preview, ok: false, problem: refused } : preview;
  }

  async restore(
    sessionId: string,
    taskId: string,
  ): Promise<{ ok: boolean; problem?: string; branch?: string; commit?: string; leftBehind?: string[]; keptOn?: string }> {
    await this.init();
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error('No such session.');
    const task = session.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('No such task.');
    const refused = await this.restoreRefusal(session);
    if (refused) return { ok: false, problem: refused };
    const done = await restoreToBase(session, task, this.bus);
    // On record with the operator's other actions: it made a branch and moved the checkout (live run 2026-10-04).
    if (done.ok) {
      const cfg = await this.settings.load();
      await appendSessionLog(cfg.resolved.runsDir, session.id, { type: 'restore', message: `restored the code as it was before "${task.title}" on ${done.branch} at ${(done.commit ?? '').slice(0, 8)}`, data: { taskId, branch: done.branch, commit: done.commit, leftBehind: done.leftBehind, keptOn: done.keptOn } }).catch(() => undefined);
    }
    /*
     * In per-session mode the session's one branch is where its next task goes, so a Restore moves the
     * session onto the restore branch, as "Run again from here" does. Without that the next run checked
     * the old session branch out again and the restore did not hold (live run 2026-10-03).
     */
    if (done.ok && done.branch && session.vcs?.branchMode === 'per-session' && session.vcs.startFrom !== 'existing-branch') {
      const left = sessionBranchName(session);
      await this.store.updateSession(session.id, (s) => {
        if (s.vcs) {
          s.vcs.branchName = done.branch;
          s.vcs.branchNameExact = true;
        }
      });
      this.bus.publish({ sessionId: session.id, taskId: task.id, type: 'vcs-session-branch', level: 'info',
        message: `the session carries on from ${done.branch}, the code as it was before "${task.title}"; ${left} keeps the work that came after`,
        data: { branch: done.branch, left } });
    }
    return done;
  }

  /**
   * Why the repository of this session cannot be moved to another branch now, or null when it can.
   *
   * Anything that may be working in that folder at this moment: the session itself, a batch (which
   * may reach a session in it next), and any other session running there on its own. Only the first
   * two used to be asked, so a restore checked out a branch under another session in the middle of
   * its task — and that session then found its repository moved, and left its work uncommitted.
   * Version control being off for the other session does not make it safe: its commands still run
   * in that folder.
   */
  private async restoreRefusal(session: Session): Promise<string | null> {
    if (this.running.has(session.id)) return 'This session is running. Stop it before moving the repository to another branch.';
    if (this.batch?.running) return 'A batch is running. Stop it before moving the repository to another branch.';
    const other = await this.runningIn(repoDirOf(session));
    return other
      ? `Session "${other.name}" is running in this repository. Stop it before moving the repository to another branch.`
      : null;
  }

  /**
   * A session running right now whose commands run in this folder, inside it, or in a folder around it.
   *
   * By where its commands run, the rule `workingDirFor` decides it by: the repository, else the
   * project folder, else `execution.cwd`. Compared as folders, not as equal paths: an audit with
   * version control off whose project is the repository's `web` folder works in the tree a checkout
   * rewrites, and so does a session whose folder holds the repository. Only the same path used to
   * count, and a restore changed files under such a session in the middle of its task.
   */
  private async runningIn(dir: string): Promise<Session | undefined> {
    const here = normaliseDir(dir);
    if (!here) return undefined;
    for (const id of this.running.keys()) {
      const s = await this.store.getSession(id);
      if (!s) continue;
      const there = normaliseDir(repoDirOf(s) || (await this.settings.load()).resolved.cwd);
      if (there && overlaps(here, there)) return s;
    }
    return undefined;
  }

  /**
   * Everything one run was asked to do, from a given task onward, in the order it would run.
   *
   * The run's own record on each session is what makes this answerable. Tasks are stamped when
   * they start, so after a failure the tasks that never ran carry nothing and the sessions that
   * were never reached carry nothing either — asking the tasks would return the half of the run
   * that already happened, which is the opposite of what is wanted.
   */
  private async affectedByRestart(
    session: Session,
    task: Task,
  ): Promise<{ sessions: Session[]; tasks: Array<{ session: Session; task: Task }>; group?: Session['runGroup'] }> {
    const group = session.runGroup;

    /** The tasks a session was asked to do in that run, in its own order, falling back to all. */
    const askedOf = (s: Session): Task[] => {
      const ids = s.runGroup?.id === group?.id ? (s.runGroup?.taskIds ?? []) : [];
      return ids.length > 0 ? s.tasks.filter((t) => ids.includes(t.id)) : s.tasks;
    };

    if (!group) {
      // No run on record — an older session, or one whose tasks were started by hand. Then the
      // honest scope is this session alone, from this task onward.
      const from = session.tasks.findIndex((t) => t.id === task.id);
      return { sessions: [session], tasks: session.tasks.slice(Math.max(0, from)).map((t) => ({ session, task: t })) };
    }

    const all = await this.store.listSessions();
    const inRun = all.filter((s) => s.runGroup?.id === group.id).sort((a, b) => (a.runGroup?.order ?? 0) - (b.runGroup?.order ?? 0));

    const out: Array<{ session: Session; task: Task }> = [];
    const sessions: Session[] = [];
    for (const s of inRun) {
      // Sessions the run had already finished with are none of this restart's business.
      if ((s.runGroup?.order ?? 0) < (group.order ?? 0)) continue;

      const mine = s.id === session.id;
      /*
       * The session the task is in starts from that task; every session after it starts from
       * the top, because it was either never reached or its work is downstream of this one.
       *
       * The pivot is looked for in what the run was asked to do, and then in the session's own
       * list. The second lookup is not redundant: a task added since the run is not in the
       * run's list, and skipping its session because of that would quietly drop the very
       * session the operator pressed the button on.
       */
      let scope = askedOf(s);
      let start = 0;
      if (mine) {
        start = scope.findIndex((t) => t.id === task.id);
        if (start < 0) {
          scope = s.tasks;
          start = scope.findIndex((t) => t.id === task.id);
          if (start < 0) continue;
        }
      }

      const slice = scope.slice(start);
      if (slice.length === 0) continue;
      sessions.push(s);
      for (const t of slice) out.push({ session: s, task: t });
    }

    return { sessions, tasks: out, group };
  }

  /** What starting again from this task would re-queue, and what it would do to the code. */
  async restartPlan(sessionId: string, taskId: string): Promise<RestartPlan> {
    await this.init();
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error('No such session.');
    const task = session.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('No such task.');

    const { sessions, tasks, group } = await this.affectedByRestart(session, task);
    const from = { sessionId: session.id, sessionName: session.name, taskId: task.id, title: task.title, status: task.status };

    const plan: RestartPlan = {
      ok: tasks.length > 0,
      problem: tasks.length === 0 ? 'There is nothing to run again from this task.' : undefined,
      runId: group?.id,
      runStartedAt: group?.startedAt,
      from,
      tasks: tasks.map(({ session: s, task: t }) => ({
        sessionId: s.id,
        sessionName: s.name,
        taskId: t.id,
        title: t.title,
        status: t.status,
        alreadyQueued: t.status === 'queued',
      })),
      sessions: sessions.map((s) => ({ id: s.id, name: s.name, tasks: tasks.filter((x) => x.session.id === s.id).length })),
      restores: [],
      /*
       * Nothing on record says a run with no record of its own ever went unattended, and taken for
       * one, it was refused on every machine that refuses unattended runs, the default among them:
       * the dialog has no other mode to offer, so its button could never do anything for such a task.
       */
      mode: group?.mode ?? 'confirm',
      onFailure: group?.onFailure ?? session.onFailure ?? 'stop',
    };
    // Asked of the machine as it is now, as `restartFrom` will ask it; see `unattendedRefused`.
    if (plan.mode === 'unattended') plan.unattendedRefused = (await this.unattendedRefusal('unattended')) ?? undefined;

    for (const target of restoreTargets(tasks)) {
      const preview = await restorePreview(target.session, target.task);
      // What would stop the restore itself, asked here as well, so the dialog says it before the
      // operator agrees rather than after.
      const refused = target.problem ?? (await this.restoreRefusal(target.session));
      plan.restores.push({
        repoDir: preview.repoDir || target.dir,
        ok: preview.ok && !refused,
        problem: refused ?? preview.problem,
        forTask: target.task.title,
        baseCommit: preview.baseCommit,
        branchName: preview.branchName,
        leftBehind: preview.leftBehind,
        keptOn: preview.keptOn,
      });
    }
    /*
     * The plan is "ok" only when the restart it describes can happen: a refused restore refuses the
     * restart, as `restartFrom` does and the dialog says, so a caller reading only `ok` is not told
     * otherwise (live run 2026-10-04: ok true beside its only restore refused).
     */
    const refusedRestores = plan.restores.filter((r) => !r.ok);
    if (plan.ok && refusedRestores.length > 0) {
      plan.ok = false;
      plan.problem = refusedRestores.map((r) => `${r.repoDir}: ${r.problem ?? 'the restore cannot be made'}`).join(' ');
    }

    return plan;
  }

  /**
   * Put the code back, queue the task and everything after it, and start the run again.
   *
   * The order matters and is not negotiable: restore first, then queue, then start. Queueing
   * before restoring would leave a window in which a run could pick up a task against a tree
   * that has not moved yet, and starting before queueing would run an empty batch.
   *
   * `restore` can be turned off, for the case where the repository is already where it should
   * be, or where version control was never on. `start` can be turned off to do the first two
   * and stop there, leaving a queue and an untouched Start button — the same shape an import
   * has, and the same reason: the moment before a run is the one worth being able to stop at.
   */
  async restartFrom(
    sessionId: string,
    taskId: string,
    opts: { restore?: boolean; start?: boolean; mode?: 'confirm' | 'unattended'; onFailure?: 'stop' | 'continue' } = {},
  ): Promise<{ started: boolean; reason?: string; requeued: number; restored: string[]; batch?: BatchState }> {
    await this.init();
    const idle = { started: false, requeued: 0, restored: [] as string[] };
    if (this.batch?.running) return { ...idle, reason: 'A run is in progress. Stop it first.' };

    const plan = await this.restartPlan(sessionId, taskId);
    // A refused restore stops the restart only when the restore is asked for: `restore: false` queues without one.
    const onlyRestoreRefused = plan.tasks.length > 0 && plan.restores.some((r) => !r.ok);
    if (!plan.ok && !(opts.restore === false && onlyRestoreRefused)) return { ...idle, reason: plan.problem };
    if (plan.sessions.some((s) => this.running.has(s.id))) {
      return { ...idle, reason: 'One of these sessions is running on its own. Stop it first.' };
    }
    /*
     * Claimed before anything is moved, and held until the run it ends in has the browser: that run
     * needs it, and another session running on its own, or a read of the models, may have it. Found
     * out only at the start, the repositories were already taken back and the tasks queued, with
     * nothing to run them; and only looked at here, the browser could still be taken by a start that
     * came in while the repositories were being taken back, to the same end. Given back on every way
     * out that does not start the run.
     */
    const ids = plan.sessions.map((s) => s.id);
    if (opts.start === false) return await this.restartMoves(sessionId, taskId, plan, opts);
    /*
     * The run's entrance rule, asked before anything moves, for the same reason as the browser
     * below. Asked only when the batch began, a machine that no longer lets this run go unattended
     * (a policy lock added since, isolation no longer accepted) took the repositories back and
     * queued the tasks, and only then refused the run they were moved for. The plan says so first
     * (`unattendedRefused`), so the dialog asks for the run step by step instead.
     */
    const blocked = await this.unattendedRefusal(opts.mode ?? plan.mode);
    if (blocked) return { ...idle, reason: blocked };
    const claim = this.claimBrowser({ kind: 'batch', sessionIds: ids });
    if ('refused' in claim) return { ...idle, reason: claim.refused };
    let handedOn = false;
    try {
      const moved = await this.restartMoves(sessionId, taskId, plan, opts);
      if (moved.reason !== undefined) return moved;
      // Named after the task it goes back to, which is the one thing this run is about and the
      // only thing a heading could usefully say. There is no field to type into on a task card,
      // so leaving it to the operator meant leaving it blank every time.
      const runName = await this.suggestRunName(ids, plan.from.title);
      // From here the claim is the batch's to give back, whichever way its start goes.
      handedOn = true;
      /*
       * Exactly the tasks the preview listed, which are the tasks the run was asked to do from this
       * one on. Started with none named, the batch took every queued task of these sessions, so a
       * task the run never chose — queued beside it, or added since — was sent to the chat as well.
       */
      const taskIds = plan.tasks.map((x) => x.taskId);
      const started = await this.startBatchHolding(claim.holder, ids, opts.mode ?? plan.mode, opts.onFailure ?? plan.onFailure, undefined, undefined, runName, taskIds);
      // A start refused now leaves the moves in place, and says so with its reason.
      const reason = started.started || started.reason === undefined ? started.reason : afterMoves(started.reason, moved.restored, moved.requeued);
      return { started: started.started, reason, requeued: moved.requeued, restored: moved.restored, batch: started.batch };
    } finally {
      if (!handedOn) this.releaseBrowser(claim.holder);
    }
  }

  /**
   * What `restartFrom` moves before its run starts: the repositories taken back, then the tasks
   * queued again. A refusal, and "prepared, not started", come back with their reason; with none,
   * everything is in place for the run.
   */
  private async restartMoves(
    sessionId: string,
    taskId: string,
    plan: RestartPlan,
    opts: { restore?: boolean; start?: boolean },
  ): Promise<{ started: boolean; reason?: string; requeued: number; restored: string[] }> {
    const idle = { started: false, requeued: 0, restored: [] as string[] };
    const restored: string[] = [];
    if (opts.restore !== false) {
      for (const entry of plan.restores) {
        if (!entry.ok) return { ...idle, reason: `${entry.repoDir}: ${entry.problem ?? 'the restore could not be prepared.'}` };
      }
      /*
       * Re-read each repository's own pivot and do it for real. The preview above is what the
       * operator agreed to; this is the same choice (`restoreTargets`), one step further. It was
       * worked out a second time here, by a copy of the rule that had not been given the preview's
       * "never started" skip, so a run whose later repository was never reached failed on it after
       * the first repository had already been moved — and queued nothing.
       *
       * A refusal part-way still says what was already moved, in the result and in its reason (the
       * one thing the page shows): a repository taken back is the operator's to know about, whatever
       * happened after it.
       */
      const session = (await this.store.getSession(sessionId)) as Session;
      const task = session.tasks.find((t) => t.id === taskId) as Task;
      const { tasks } = await this.affectedByRestart(session, task);
      for (const target of restoreTargets(tasks)) {
        // Asked again at the moment of moving: a session may have started in this folder since.
        const refused = target.problem ?? (await this.restoreRefusal(target.session));
        if (refused) return { ...idle, restored, reason: afterMoves(`${target.dir}: ${refused}`, restored, 0) };
        const done = await restoreToBase(target.session, target.task, this.bus);
        if (!done.ok || !done.branch) {
          return { ...idle, restored, reason: afterMoves(`${target.dir}: ${done.problem ?? 'the restore failed.'}`, restored, 0) };
        }
        restored.push(`${target.dir} -> ${done.branch}`);
        await this.rerunFromRestore(target, done.branch, tasks);
      }
    }

    let requeued = 0;
    for (const t of plan.tasks) {
      if (t.alreadyQueued) continue;
      try {
        await this.store.rerunTask(t.sessionId, t.taskId);
        requeued += 1;
      } catch (e) {
        // One task refusing to be queued again must not leave the rest half-reset with no
        // explanation, so it stops here and says which one and why — and what was done before it.
        return { ...idle, restored, requeued, reason: afterMoves(`"${t.title}" could not be queued again: ${(e as Error).message}`, restored, requeued) };
      }
    }

    this.bus.publish({
      sessionId,
      taskId,
      type: 'run-restarted',
      level: 'info',
      message:
        `${opts.start === false ? 'prepared to start again' : 'starting again'} from "${plan.from.title}": ${plan.tasks.length} task(s) in ${plan.sessions.length} session(s)` +
        (restored.length > 0 ? `, after taking ${restored.length} repository(ies) back` : '') +
        (opts.start === false ? '; press a run button to start' : ''),
      data: { requeued, restored },
    });

    if (opts.start === false) return { started: false, reason: 'prepared, not started', requeued, restored };
    return { started: false, requeued, restored };
  }

  /**
   * Makes a restore hold for the run that follows it.
   *
   * The restore puts the repository on a new branch at the pivot task's starting commit, and the
   * re-run then puts each session on its own branch. In per-task mode that is right: a re-run cuts
   * a fresh branch from where the task first started, which is the restore commit. In per-session
   * mode it undid the restore: the session's one branch was checked out again, with the failed
   * attempt's commit still on it, so the attempt that was to start from the code as it was began on
   * the work it was meant to replace, and committed it a second time. So the pivot's session now
   * works on the restore branch — the code as it was before that task, with the tasks before it —
   * and its old branch keeps the attempt that failed, as the confirmation says.
   *
   * A per-session session after it in the same repository that this run reached has the same
   * problem whatever it started from: its one branch carries what its tasks did in this run, and
   * checked out again it would start them over on their own first attempt. So it gets a branch of
   * its own, and the old one keeps what it did. Where that branch starts depends on where the
   * session began. From a named branch: where its first task in this run began, as a restore of
   * that task would go back to, and the session's start stays as recorded. From where the
   * repository was, or from the session before it: that start was work this run is now redoing, so
   * it is forgotten, to be worked out again when the session is reached (for a `previous-session`
   * chain, from the work done again), and the branch is cut from that. A session the run never
   * reached holds nothing of this run and is left alone.
   *
   * A later per-task session is left as it is. From a named branch that is right: each re-run is
   * cut from where its task first started, that branch's commit. Chained on this run's work it is
   * not, and is not solved here: its tasks first started on the work being redone, so their re-runs
   * are cut from it again. Telling that apart from an operator's new "Start from", whose re-runs go
   * back to where each task first started on purpose (see `updateSession`), needs the restart
   * written on the session, and the session's record has no field for it.
   */
  private async rerunFromRestore(target: RestoreTarget, branch: string, tasks: Array<{ session: Session; task: Task }>): Promise<void> {
    if (target.session.vcs?.branchMode === 'per-session') {
      const left = sessionBranchName(target.session);
      // The restore branch exists by this name, so the name is kept as it is (see `branchNameExact`).
      await this.store.updateSession(target.session.id, (s) => {
        if (s.vcs) {
          s.vcs.branchName = branch;
          s.vcs.branchNameExact = true;
        }
      });
      this.bus.publish({
        sessionId: target.session.id,
        taskId: target.task.id,
        type: 'vcs-session-branch',
        level: 'info',
        message: `the session carries on from ${branch}, the code as it was before "${target.task.title}"; ${left} keeps the work that came after`,
        data: { branch, left },
      });
    }

    const here = normaliseDir(target.dir);
    const inOrder = [...new Map(tasks.map(({ session }) => [session.id, session])).values()];
    const later = inOrder.slice(inOrder.findIndex((s) => s.id === target.session.id) + 1);
    for (const s of later) {
      // One that carries on an existing branch never gets here: `restoreTargets` refuses the restart.
      if (!s.vcs?.enabled || s.vcs.branchMode !== 'per-session' || s.vcs.startFrom === 'existing-branch') continue;
      // No base recorded: version control never got as far as making its branch.
      if (!s.vcsBaseCommit || normaliseDir(repoDirOf(s)) !== here) continue;
      const first = tasks.find((x) => x.session.id === s.id && x.task.startedAt)?.task;
      if (!first) continue;
      const left = sessionBranchName(s);
      const fresh = await freeBranchName(target.dir, left);
      // No record of the start is read as chained, the reading that cannot bring undone work back.
      const chained = s.vcsStart?.kind !== 'branch';
      const at = chained ? undefined : restorePoint(s, first);
      if (at) {
        const made = await branchAt(target.dir, fresh, at);
        // Not made: left to the run, which cuts it from the session's start when it is reached.
        if (!made.ok) {
          this.bus.publish({ sessionId: s.id, type: 'vcs-problem', level: 'warn', message: `${fresh} could not be made at ${at.slice(0, 8)}: ${made.problem}` });
        }
      }
      await this.store.updateSession(s.id, (x) => {
        if (chained) {
          x.vcsBaseCommit = undefined;
          x.vcsStart = undefined;
        }
        if (x.vcs) {
          x.vcs.branchName = fresh;
          x.vcs.branchNameExact = true;
        }
      });
      this.bus.publish({
        sessionId: s.id,
        type: 'vcs-session-branch',
        level: 'info',
        message: chained
          ? `the session began from work this run is doing again, so it starts again when it is reached, on a new branch ${fresh}; ${left} keeps what it did before`
          : `the session starts its tasks again on a new branch ${fresh}, from where "${first.title}" began; ${left} keeps what it did before`,
        data: { branch: fresh, left },
      });
    }
  }

  /** Why a folder cannot be used for version control, or null when it can. */
  repoProblem(dir: string): string | null {
    return repoUnusableReason(dir);
  }

  /**
   * What bringing a project back to its remote's main branch would lose, and the command that does
   * it — for the operator to run. See `vcs/syncCommand.ts`; nothing here writes.
   *
   * Only for a folder this bot already works in: a project in Settings or the repository of a
   * session. The answer lists file names and commit subjects, and a local page asking about any
   * folder on the disk is not a question this API should answer.
   */
  async syncPlan(dir: string): Promise<SyncPlan> {
    await this.init();
    await this.knownProjectFolder(dir, 'no command is offered for it');
    return await planSync(resolve(dir.trim()));
  }

  /** Throws unless the folder is a project in Settings or the repository of a session. */
  private async knownProjectFolder(dir: string, otherwise: string): Promise<void> {
    const wanted = normaliseDir(dir);
    const cfg = await this.settings.load();
    const known = new Set(
      [cfg.project?.rootDir ?? '', ...(cfg.project?.others ?? []).map((o) => o.rootDir), ...(await this.store.listSessions()).flatMap((s) => [s.vcs?.repoDir ?? '', s.projectDir ?? ''])]
        .filter((d) => d.trim())
        .map(normaliseDir),
    );
    if (!wanted || !known.has(wanted)) {
      throw new Error(`That folder is not one of the projects in Settings or the repository of a session, so ${otherwise}.`);
    }
  }

  /**
   * "Prepare the folder from the remote main branch", first half: fetches and says what would be
   * kept where and what the folder would be. See `vcs/prepareFromRemote.ts`.
   */
  async preparePreview(dir: string, fetch = true): Promise<PreparePlan> {
    await this.init();
    await this.knownProjectFolder(dir, 'it is not prepared from here');
    // The operator pressed the button and is looking: the remote may ask for a password through Git's own window.
    return await planPrepare(resolve(dir.trim()), { fetch, askpass: fetch ? await askpassProgram() : null });
  }

  /**
   * The second half: does it, if the folder is still what the preview showed. Refused while anything
   * runs, or is being started, in that folder or one around it: it moves the checkout.
   */
  async prepareProject(dir: string, fingerprint: string, names: { savedBranch?: string; savedMainBranch?: string } = {}): Promise<PrepareResult> {
    await this.init();
    await this.knownProjectFolder(dir, 'it is not prepared from here');
    if (this.batch?.running) return { ok: false, problem: 'A run is going. Stop it before preparing the folder; nothing was changed.' };
    if (this.browser?.kind === 'run' || this.browser?.kind === 'batch') return { ok: false, problem: 'A run is being started. Wait for it, or stop it, before preparing the folder; nothing was changed.' };
    const other = await this.runningIn(dir);
    if (other) return { ok: false, problem: `Session "${other.name}" is running in this folder. Stop it before preparing the folder; nothing was changed.` };
    const done = await prepareFromRemote(resolve(dir.trim()), String(fingerprint ?? ''), { names });
    // Kept on every session working in that folder: it moved the checkout and made saved branches.
    if (done.ok) {
      const cfg = await this.settings.load();
      const here = normaliseDir(dir);
      for (const s of (await this.store.listSessions()).filter((x) => normaliseDir(repoDirOf(x)) === here)) {
        const message = `the folder was prepared from ${done.target}: ${done.result}`;
        await appendSessionLog(cfg.resolved.runsDir, s.id, { type: 'folder-prepared', message, data: { target: done.target, commit: done.commit, branch: done.branch, saved: done.saved, removedFromFolder: done.removedFromFolder } }).catch(() => undefined);
        this.bus.publish({ sessionId: s.id, type: 'folder-prepared', level: 'info', message, data: { target: done.target, commit: done.commit, saved: done.saved } });
      }
    }
    return done;
  }

  // --- the project being worked on ---------------------------------------------------------

  /**
   * The folder new sessions start pointed at, and whether it can carry version control.
   *
   * The repository check travels with it because the two questions are always asked together:
   * somewhere to work, and whether that somewhere can be branched and committed.
   */
  async project(): Promise<ProjectDefault> {
    const cfg = await this.settings.load();
    const rootDir = (cfg.project?.rootDir ?? '').trim();
    const problem = repoUnusableReason(rootDir);
    const others = (cfg.project?.others ?? []).map((o) => {
      const p = repoUnusableReason(o.rootDir);
      return { name: o.name, rootDir: o.rootDir, repoOk: p === null, ...(p ? { repoProblem: p } : {}) };
    });
    return {
      rootDir,
      name: (cfg.project?.name ?? '').trim(),
      repoOk: rootDir !== '' && problem === null,
      ...(problem ? { repoProblem: problem } : {}),
      others,
    };
  }

  /**
   * Stores the project folder and the other folders the operator works in. A field left out
   * of the patch is kept; an empty `rootDir` clears the default, which is a real choice: it
   * means new sessions go back to starting with nothing chosen.
   *
   * A folder that is not a git repository is allowed here, because this setting is about where
   * the work is, not about version control. What it cannot do is silently promise version
   * control, so the answer says, for each folder, whether it can carry it. What is refused is a
   * folder that is not there, a name used twice, and the default listed again among the others
   * — each of those would be a setting that looks filled in and points nowhere.
   */
  async setProject(patch: {
    rootDir?: string;
    name?: string;
    others?: Array<{ name: string; rootDir: string }>;
  }): Promise<ProjectDefault> {
    // Worked out from the file in its turn (see `Settings.update`), so a model chosen at the same
    // moment is kept, and a refusal below leaves the file as it was.
    await this.settings.update((raw) => {
      const current = ((raw.project as Record<string, unknown>) ?? {}) as {
        rootDir?: string;
        name?: string;
        others?: Array<{ name: string; rootDir: string }>;
      };
      const rootDir = patch.rootDir !== undefined ? patch.rootDir.trim() : (current.rootDir ?? '').trim();
      const name = patch.name !== undefined ? patch.name.trim() : (current.name ?? '').trim();
      if (rootDir && !existsSync(rootDir)) throw new Error(`The folder ${rootDir} does not exist on this machine.`);

      const others = (patch.others ?? current.others ?? []).map((o) => ({
        name: (o.name ?? '').trim(),
        rootDir: (o.rootDir ?? '').trim(),
      }));
      const seen = new Set<string>();
      for (const o of others) {
        if (!o.name) throw new Error(`Every other project needs a name; the one at ${o.rootDir || '(no folder)'} has none.`);
        if (!o.rootDir) throw new Error(`The project "${o.name}" needs a folder.`);
        if (!existsSync(o.rootDir)) throw new Error(`The folder ${o.rootDir} for "${o.name}" does not exist on this machine.`);
        if (sameFolder(o.rootDir, rootDir)) throw new Error(`${o.rootDir} is already the default project; it does not need listing again.`);
        const key = o.name.toLowerCase();
        if (seen.has(key)) throw new Error(`Two projects are named "${o.name}". Names are how the folders are told apart, so each needs its own.`);
        seen.add(key);
      }

      // What the removed Desktop copies left in the stored project is dropped with the next save.
      const { mirror: _m, desktop: _d, mirrorToDesktop: _t, ...rest } = current as typeof current & { mirror?: unknown; desktop?: unknown; mirrorToDesktop?: unknown };
      return { ...raw, project: { ...rest, rootDir, name, others } };
    });
    return await this.project();
  }

  // --- the model catalogue ----------------------------------------------------------------

  /**
   * What the picker offered when it was last read, plus the model new sessions start on.
   *
   * The two travel together because the UI shows them in one place: a list to choose from,
   * and which of them is the standing choice.
   */
  async models(): Promise<
    (ModelCatalogue & { defaultModel: string; defaultReviewModel: string }) | { defaultModel: string; defaultReviewModel: string; options: []; readAt: null }
  > {
    await this.init();
    const cfg = await this.settings.load();
    const cached = await this.store.getModels();
    const defaultModel = cfg.copilot.defaultModel ?? '';
    const defaultReviewModel = cfg.copilot.defaultReviewModel ?? '';
    return cached ? { ...cached, defaultModel, defaultReviewModel } : { defaultModel, defaultReviewModel, options: [], readAt: null };
  }

  /**
   * Sets the model a new session's independent review starts on. An empty name clears it,
   * which means the review runs on the session's own model — the weaker choice, and the one
   * every session had before this existed.
   */
  async setDefaultReviewModel(name: string): Promise<{ defaultReviewModel: string }> {
    await this.init();
    await this.settings.update((raw) => ({ ...raw, copilot: { ...((raw.copilot as Record<string, unknown>) ?? {}), defaultReviewModel: name.trim() } }));
    this.bus.publish({
      sessionId: '*',
      type: 'default-review-model-changed',
      level: 'info',
      message: name.trim() ? `new sessions will be reviewed by ${name.trim()}` : 'new sessions will be reviewed by their own model',
    });
    return { defaultReviewModel: name.trim() };
  }

  /**
   * Sets the model new sessions will start on. An empty name clears it.
   *
   * Stored in `data/settings.json` next to the rest of the configuration rather than in the
   * model cache, because it is a preference of this operator, not a fact about the chat: a
   * refresh of the list must not be able to change it, and clearing the cache must not lose it.
   */
  async setDefaultModel(name: string): Promise<{ defaultModel: string }> {
    await this.init();
    await this.settings.update((raw) => ({ ...raw, copilot: { ...((raw.copilot as Record<string, unknown>) ?? {}), defaultModel: name.trim() } }));
    this.bus.publish({
      sessionId: '*',
      type: 'default-model-changed',
      level: 'info',
      message: name.trim() ? `new sessions will start on ${name.trim()}` : 'new sessions will start on the chat default',
    });
    return { defaultModel: name.trim() };
  }

  /**
   * Reads the model picker from the live chat and caches what it says.
   *
   * Expensive and exclusive: it launches the browser with the bot profile, which is the same
   * profile a run needs, so it cannot happen while a session is running. That is also why the
   * UI never does this by itself — the user asks for it, and knows a window will open.
   *
   * Nothing here decides what a "valid" model is. Whatever the chat lists is what the user
   * gets to choose from, which is the only way this keeps working when Microsoft changes the
   * line-up.
   */
  /**
   * "Sign in" from Settings: what `cop login` does, from the page.
   *
   * Opens Edge with the bot's own profile — the one in Settings, which is the one every run uses —
   * and waits for the operator to sign in to Microsoft 365 Copilot. With an account, the profile is
   * signed out first and the chat asked for that account, because Edge on a work machine otherwise
   * signs the profile in with whatever account Windows knows. The bot never types a credential:
   * the person signs in, completes any verification, and the window closes once the chat is there.
   *
   * The request stays open until then (up to `copilot.signInTimeoutSec`). It takes the browser like
   * a run does, so it is refused while a run or a reading of the models has it, and they are while
   * it is open.
   */
  async login(account?: string): Promise<{ ok: boolean; accounts: string[]; account?: string; matched?: boolean; message: string }> {
    const upn = account?.trim() || undefined;
    if (upn && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(upn)) {
      throw new Error(`"${upn}" is not an account address. Give the work or school address, for example name@company.com, or leave it empty.`);
    }
    const claim = this.claimBrowser({ kind: 'login' });
    if ('refused' in claim) throw new Error(claim.refused);
    let transport: ChatTransport | null = null;
    try {
      await this.init();
      const cfg = await this.settings.load();
      transport = createTransport({
        profileDir: cfg.resolved.profileDir,
        transportDir: join(cfg.resolved.runsDir, '_login'),
        chatUrl: cfg.copilot.url,
        channel: cfg.copilot.channel,
        // Always on screen, whatever Settings say: a person has to see the window to sign in.
        headless: false,
        replyTimeoutMs: 60_000,
        signInTimeoutMs: cfg.copilot.signInTimeoutSec * 1000,
        humanWaitMs: cfg.copilot.signInTimeoutSec * 1000,
        keepFailurePage: cfg.copilot.keepFailurePage,
      });
      await transport.open();
      if (upn) {
        await transport.signOut();
        await transport.gotoChatAs(upn, cfg.copilot.url);
      }
      await transport.ensureSignedIn(upn ? undefined : cfg.copilot.url);
      const accounts = await transport.findAccountsInPage();
      if (!upn) {
        return {
          ok: true,
          accounts,
          message: accounts.length > 0 ? `Signed in. The page shows: ${accounts.join(', ')}.` : 'Signed in.',
        };
      }
      const matched = accounts.some((a) => a.toLowerCase() === upn.toLowerCase());
      if (matched) return { ok: true, accounts, account: upn, matched, message: `Signed in as ${upn}.` };
      if (accounts.length > 0) {
        return {
          ok: false,
          accounts,
          account: upn,
          matched,
          message: `Signed in, but not as ${upn}: the page shows ${accounts.join(', ')}. Sign in again and choose "Use another account".`,
        };
      }
      return { ok: true, accounts, account: upn, message: `Signed in. The account could not be read from the page, so ${upn} is not confirmed.` };
    } finally {
      // Always closed: a window left open keeps the profile locked, and the next run would fail on it.
      await transport?.close().catch(() => undefined);
      this.releaseBrowser(claim.holder);
    }
  }

  async refreshModels(): Promise<ModelCatalogue> {
    // Asked of the one claim every window goes through (see `browser`), before anything is waited
    // for. It used to count the sessions running, which is none in the moment between two
    // sessions of a batch, while the batch's window is still open.
    const claim = this.claimBrowser({ kind: 'models' });
    if ('refused' in claim) throw new Error(claim.refused);
    let transport: ChatTransport | null = null;
    try {
      await this.init();
      const cfg = await this.settings.load();
      transport = createTransport({
        profileDir: cfg.resolved.profileDir,
        transportDir: join(cfg.resolved.runsDir, '_models'),
        chatUrl: cfg.copilot.url,
        channel: cfg.copilot.channel,
        headless: cfg.copilot.headless,
        replyTimeoutMs: cfg.copilot.replyTimeoutSec * 1000,
        signInTimeoutMs: cfg.copilot.signInTimeoutSec * 1000,
        humanWaitMs: cfg.copilot.humanWaitSec * 1000,
        keepFailurePage: cfg.copilot.keepFailurePage,
      });
      await transport.open();
      await transport.ensureSignedIn();
      const { options, current, note } = await transport.listModels();
      const catalogue: ModelCatalogue = { options, current: current ?? undefined, readAt: new Date().toISOString(), note };
      await this.store.saveModels(catalogue);
      // A saved choice the page now offers under another name follows it here, as a run does (see `modelMatch.ts`).
      const saved = cfg.copilot;
      const work = (saved.defaultModel ?? '').trim();
      const review = (saved.defaultReviewModel ?? '').trim();
      const workNow = work ? pageModelFor(work, options) : null;
      const reviewNow = review ? pageModelFor(review, options) : null;
      if (workNow && !sameModel(workNow.name, work)) await this.setDefaultModel(workNow.name);
      if (reviewNow && !sameModel(reviewNow.name, review)) await this.setDefaultReviewModel(reviewNow.name);
      return catalogue;
    } finally {
      await transport?.close().catch(() => undefined);
      this.releaseBrowser(claim.holder);
    }
  }

  // --- the registry ---------------------------------------------------------------------

  /**
   * Every task of every session in one flat list, newest session first and, inside a session,
   * in the order the tasks run. The page splits it into what is done, what is running and
   * what is still ahead; doing the flattening here keeps that split honest, because the
   * queue position is only knowable from the session's own list.
   */
  /** How well the bot is doing, added up from every task on record. See `session/metrics.ts`. */
  async metrics(): Promise<Metrics> {
    await this.init();
    return computeMetrics(await this.store.listSessions());
  }

  async taskRegistry(): Promise<RegistryEntry[]> {
    await this.init();
    const sessions = await this.store.listSessions();
    const out: RegistryEntry[] = [];

    for (const s of sessions) {
      let queueSeen = 0;
      s.tasks.forEach((t, i) => {
        if (t.status === 'queued') queueSeen += 1;
        const started = t.startedAt ? Date.parse(t.startedAt) : undefined;
        const finished = t.finishedAt ? Date.parse(t.finishedAt) : undefined;
        out.push({
          sessionId: s.id,
          sessionName: s.name,
          sessionStatus: s.status,
          sessionOnFailure: s.onFailure === 'continue' ? 'continue' : 'stop',
          sessionRunOrder: s.runGroup?.order,
          sessionRunning: this.running.has(s.id),
          chatUrl: s.chat?.url,
          taskId: t.id,
          title: t.title,
          status: t.status,
          position: i + 1,
          queuePosition: t.status === 'queued' ? queueSeen : undefined,
          createdAt: t.createdAt,
          startedAt: t.startedAt,
          finishedAt: t.finishedAt,
          durationMs: started && finished ? finished - started : undefined,
          iterations: t.iterations,
          summary: t.summary,
          reason: t.reason,
          runId: t.runId,
          runGroup: t.runGroup,
          review: t.review
            ? { verdict: t.review.verdict, findings: t.review.findings?.length ?? 0, stepsRun: t.review.stepsRun }
            : undefined,
          deviations: t.deviations?.length || undefined,
          disputes: t.disputes?.length || undefined,
          readOnly: t.readOnly || undefined,
          scope: t.scope?.length ? t.scope : undefined,
          stopCode: t.stopCode,
          limit: t.limit,
          continuable: isContinuable(t) || undefined,
          branch: t.vcs?.branch,
          commit: t.vcs?.commit,
          vcsProblem: t.vcs?.problem,
          sessionInactive: s.active === false || undefined,
          autoRetries: freshRetriesOfLatestRun(t) || undefined,
          attempt: t.attempt,
          changedFiles: t.vcs?.commit && t.vcs.baseCommit ? (t.vcs.files?.length ?? 0) : undefined,
          interrupted: t.status === 'aborted' && !!t.interruption ? true : undefined,
          attempts: (t.attempts ?? []).map((a, n) => {
            const from = a.startedAt ? Date.parse(a.startedAt) : undefined;
            const to = a.finishedAt ? Date.parse(a.finishedAt) : undefined;
            return {
              attempt: n + 1,
              status: a.status,
              startedAt: a.startedAt,
              finishedAt: a.finishedAt,
              durationMs: from && to ? to - from : undefined,
              iterations: a.iterations,
              summary: a.summary,
              reason: a.reason,
              runId: a.runId,
              branch: a.vcs?.branch,
              // Why the runner stopped this attempt, whether it was a fresh-chat retry, and its commit (live run 2026-10-03).
              stopCode: a.stopCode,
              freshRetry: a.freshRetry,
              commit: a.vcs?.commit,
              changedFiles: a.vcs?.commit && a.vcs.baseCommit ? (a.vcs.files?.length ?? 0) : undefined,
            };
          }),
        });
      });
    }
    return out;
  }

  // --- environment ----------------------------------------------------------------------

  /** Opens the machine's own folder dialog and reports what was picked. */
  async browseFolder(start?: string): Promise<FolderPick> {
    return await pickFolder(start);
  }

  async doctor(): Promise<Record<string, unknown>> {
    const cfg = await this.settings.load();
    const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
    const holders = findEdgeUsingProfile(cfg.resolved.profileDir);
    return {
      // Which copilot-operator this is: `cop --version` without a terminal.
      version: botVersion(),
      node: process.versions.node,
      edge: edge ?? null,
      profileDir: cfg.resolved.profileDir,
      profileExists: existsSync(cfg.resolved.profileDir),
      profileHeldBy: Array.isArray(holders) ? holders.map((h) => h.pid) : 'unknown',
      /*
       * Whether the bot itself is what holds the profile. While a run is going, Edge is open
       * on that profile *by the runner*, and the warning "close this Edge window, a run would
       * fail" was shown in exactly the moment it was false. The page says which it is.
       */
      botRunning: this.running.size > 0 || this.batch?.running === true,
      desktop: resolveDesktopDir(),
      desktopSynced: desktopIsSynced(),
      cwd: cfg.resolved.cwd,
      runsDir: cfg.resolved.runsDir,
      dataDir: this.dataDir,
      mode: cfg.execution.mode,
      /*
       * Where the bot is running. The only thing that actually contains a command once it runs, and
       * until now the one thing the System page could not show: a machine that ignored the README's
       * recommendation looked exactly like one that had followed it. The claim is the operator's and
       * is shown as a claim; the signals are what can be read. See `exec/isolation.ts`.
       */
      isolation: assessIsolation(cfg.execution.isolation, readIsolationSignals()),
      folderDialog: process.platform === 'win32',
    };
  }
}

/**
 * Which run folder a request may read.
 *
 * Without a `runId` it is the task's current one. With one, it must be a run this task owns:
 * the current attempt or one of the archived ones. Anything else returns null rather than a
 * path, so a crafted id cannot walk out of the task's own history.
 */
function resolveRunId(task: Task | undefined, requested?: string): string | null {
  if (!task) return null;
  if (!requested) return task.runId ?? null;
  const owned = [task.runId, ...(task.attempts ?? []).map((a) => a.runId)].filter(Boolean) as string[];
  return owned.includes(requested) ? requested : null;
}

