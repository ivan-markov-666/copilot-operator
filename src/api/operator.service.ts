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
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chosenHome, defaultHome, installLayout } from '../config/layout.js';
import { chooseHome, homeRefusal, movedFrom } from '../config/home.js';

import { SessionStore, DEFAULT_VCS, DEFAULT_REVIEW, writeFileAtomically } from '../session/store.js';
import { checkItems, emptyQueue, itemTitle, mainBranchOf, mergeItems, nextStep, skippedBecause, statusOfTask, waitsByHand, type Queue, type QueueItem, type QueueStatus } from '../queue/queue.js';
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
import { MAX_INSTRUCTION_CHARS, newId, type Acting, type Actor, type PlanMode, type RetryChoice, type TaskPlan } from '../session/model.js';
import { runSession, queuedToRun, failedWhileOpening, pickerOptions } from '../orchestrator/taskRunner.js';
import { Hold } from '../orchestrator/hold.js';
import { exportFileName, exportMachine, writeAttemptRecord } from '../session/exports.js';
import { suggestRunName } from '../session/runName.js';
import { buildStory, type Story } from '../session/story.js';
import { buildTaskExchange } from '../session/taskExchange.js';
import { chatNotice } from '../session/chatNotice.js';
import { kerriganFileName, kerriganPersona } from '../plan/kerrigan.js';
import { branchChanges, workspaceCommit, workspaceGit, workspaceGitVersions, type GitArea } from '../session/workspaceGit.js';
import { chatCode } from '../transport/chatSession.js';
import { type PlanCheck } from '../plan/schema.js';

/** The folders the operator works in: the default new sessions start on, and the rest by name. */
/** The longest level 2 a project may have: Kerrigan carries each one whole. */
export const MAX_PROJECT_LEVEL2 = 8000;

/** A skill (2026-10-21): instructions for a kind of task, sent with the message it is chosen for. */
export type Skill = { name: string; description: string; text: string; projectDir: string };
/*
 * Its instructions have no limit of their own (operator, 2026-10-25: "remove the limit; say how many characters there
 * are instead"): the message they go with is held to Settings' `limits.maxMessageChars` like every other — longer, its
 * beginning goes as text and the whole of it attached.
 */
export const MAX_SKILL_DESCRIPTION = 300;
export const MAX_SKILLS = 50;
/** What follows `/` at the start of a message: lowercase letters, digits and hyphens, 2 to 40 of them. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** One project as Settings show it: its folder, whether it is a repository and on which branch, and its level 2. */
export type ProjectEntry = {
  name: string;
  rootDir: string;
  repoOk: boolean;
  repoProblem?: string;
  /** The branch checked out there now; 'HEAD' when it is on none (a detached HEAD). Absent outside a repository. */
  branch?: string;
  /** What the operator wrote about the project, for Kerrigan. */
  level2: string;
  /** For reference only: nothing in it may change while the bot works (see `vcs/referenceGuard.ts`). */
  readOnly: boolean;
};

export type ProjectDefault = ProjectEntry & { others: ProjectEntry[] };

/**
 * A settings file or a policy lock that cannot be used: answered 409 with its own message on every route
 * (see `server.ts`), so a start passes it on rather than answering it as a start that did not happen.
 */
function unusableConfig(e: unknown): boolean {
  return e instanceof SettingsUnusableError || e instanceof PolicyLockUnusableError;
}

/** `20261013-102231` from an ISO time, in this machine's time as the file's contents are, for a file name. */
function fileStamp(iso: string): string {
  return localTime(iso).replace(/[-:]/g, '').replace(/\..*$/, '').replace(' ', '-');
}

/** Windows paths: case and the slash direction do not make two folders. */
function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => p.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  return a.trim() !== '' && norm(a) === norm(b);
}
import { saveWorkspaceFile, workspaceFile, workspaceFiles, workspaceInfo, workspaceRaw, type WorkspaceInfo } from '../session/workspace.js';
import { searchWorkspace, type SearchOptions, type SearchResult } from '../session/workspaceSearch.js';
import { restoreCheckpoint } from '../session/checkpoint.js';
import { readInterruption } from '../session/interruption.js';
import { baseRefOf, commitInterrupted, nextAttemptBranch, repoDirOf, trackedRepoOf, sessionBranchName } from '../vcs/taskVcs.js';
import { changedFilesBetween, fileAt, git, repoUnusableReason, type ChangedFile } from '../vcs/git.js';
import { makeAuthorizer, type StepAuthorizer } from '../exec/authorizer.js';
import type { PolicyDecision } from '../exec/policy.js';
import { pickFolder, type FolderPick } from './folderPicker.js';
import { findEdgeUsingProfile, profileHolder } from '../transport/profileLock.js';
import { assessIsolation, readIsolationSignals } from '../exec/isolation.js';
import { unattendedPrecondition, type PolicyConfig } from '../exec/policy.js';
import { createTransport, type ChatTransport } from '../transport/chatTransport.js';
import { composeHandoff } from '../session/handoff.js';
import { appendRunLog, appendSessionLog, readRunLog, type RunLogEntry, type RunLogType } from '../session/runLog.js';
import { StartFailures, failureReport, refOf, type StartFailureRef, type StartStage } from '../session/startFailure.js';
import { formatTerminal, localTime, terminalLines, terminalLogFile } from '../log/terminal.js';
import { redactSecrets } from '../exec/redaction.js';
import { workingDirFor, isWorkingDirProblem } from '../exec/workDir.js';
import { contractConflictsWithFixes, type ContractConflict, type ContractTree } from '../orchestrator/contract.js';
import { checkRefusalForOperator, lineRefusal } from '../orchestrator/taskRunner.js';
import { preferredShell } from '../exec/shells.js';
import { sessionRoots } from '../exec/confinement.js';
import { dirtyPolicy } from '../vcs/snapshot.js';
import { runVcsPreflight, type RunVcsGroup } from '../vcs/runPreflight.js';
import { inputSettings, normalisePatterns } from '../vcs/inputs.js';
import { coveredByArtifacts } from '../vcs/artifacts.js';
import { botVersion } from '../config/version.js';
import { exportEntries, exportFileName as homeExportName, exportSizes } from '../config/exportHome.js';
import { createZip } from '../util/zip.js';
import { settingsOf, SettingsUnusableError } from './settings.js';
import { PolicyLockUnusableError } from '../config/lockedPolicy.js';
import { chatDenyPatterns, type ResolvedConfig } from '../config/schema.js';

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
  /** "Pause" and "Continue" on the chat: see `Hold`. */
  hold: Hold;
};

/**
 * Something waiting for the operator. `resolvePlan`: a plan waiting for approval, answered with the
 * operator's note; the plain `resolve` reaches it too — a stop, the end of the run, "run the rest without
 * asking" — and is read as stop, stop and approve.
 */
type Waiting = {
  approval: PendingApproval;
  resolve: (d: PolicyDecision) => void;
  resolvePlan?: (a: { decision: 'approve' | 'revise' | 'stop'; note?: string }) => void;
  /** The lead's question (two chats): the operator's answer, or a stop. */
  resolveAnswer?: (a: { answer: string } | 'stop') => void;
  /** A subtask that failed for a technical reason (two chats, 2026-10-25): what the operator chose for it, or a stop. */
  resolveRetry?: (choice: RetryChoice | 'stop') => void;
};

/** Who has the browser profile: a conversation's run, a read of the model list, or the sign-in. */
type BrowserHolder = { kind: 'run'; sessionId: string } | { kind: 'models' } | { kind: 'login' };

/** Who is asking for the browser, so a refusal can be said in terms of what they pressed. */
type BrowserAsk = BrowserHolder;

/**
 * The answer to a start: started, or why not — with the failure on record when it did not, so the page
 * can offer what happened as a file (see `session/startFailure.ts`).
 */
export type StartReply = { started: boolean; reason?: string; failure?: StartFailureRef };

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
    /**
     * Later sessions of the run in the same repository that the restart moves onto a new branch (see
     * `rerunFromRestore`), each with its own commits that stay on the branch it leaves. Listed apart from
     * `leftBehind`, which holds only the first session's line; a commit is named once.
     */
    laterSessions?: Array<{ sessionName: string; branch: string; commits: string[] }>;
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
  /** A session it would run is set aside on the Sessions page: refused before anything moves, whatever is asked. */
  inactive?: boolean;
};

const INACTIVE_REASON = 'the session is inactive; make it active on the Sessions page to run it';

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
  if (held.kind === 'models') {
    return ask.kind === 'models'
      ? 'The model list is already being read.'
      : 'the model list is being read from the chat, which has the browser; start this once it has finished';
  }
  // A conversation running.
  if (ask.kind === 'models') return modelsWhileRunning;
  return ask.sessionId === held.sessionId
    ? 'already running'
    : 'another conversation is running, and the browser takes one run at a time; start this one once it has finished';
}

/** A folder as compared: absolute, forward slashes, no trailing slash, and case folded as Windows does. */
function normaliseDir(dir: string): string {
  if (!dir.trim()) return '';
  return resolve(dir.trim()).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Whether two folders, as `normaliseDir` gives them, are one folder or one is inside the other. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
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
  /** Starts that did not get as far as a first task, for the page to show and offer as a file. */
  readonly startFailures = new StartFailures();

  private readonly running = new Map<string, Running>();
  /**
   * Who is at work in each session's message now, as its runner says it (2026-10-22: "show clearly who works"):
   * for `activity`, which every page asks on a timer and answers from memory. Gone when the message ends.
   */
  private readonly acting = new Map<string, Acting>();
  /**
   * How the last message ended (2026-10-23: the tab reads "Done", "Error" and the like when the work stops, for an
   * operator in another window): a worker's subtask is not the message.
   */
  private lastOutcome: { status: string; at: string; sessionId: string } | null = null;
  private readonly followsActing = this.bus.subscribe('*', (e) => {
    if (e.type === 'acting' && e.data) this.acting.set(e.sessionId, e.data as Acting);
    else if (e.type === 'task-finished') {
      this.acting.delete(e.sessionId);
      const status = (e.data as { status?: unknown } | undefined)?.status;
      if (typeof status === 'string' && !this.workerLeads.has(e.sessionId)) this.lastOutcome = { status, at: e.at, sessionId: e.sessionId };
    }
  });
  private readonly waiting = new Map<string, Waiting>();
  /**
   * The workers of the two-chat mode, by the session of the lead they work for (2026-10-20). A worker's steps and cards
   * carry its own session's id, while the run, its mode and its Stop are the lead's: they are looked up through this.
   */
  private readonly workerLeads = new Map<string, string>();

  /** The session whose run a session's steps belong to: its own, or its lead's for a worker. */
  private runKey(sessionId: string): string {
    return this.running.has(sessionId) ? sessionId : (this.workerLeads.get(sessionId) ?? sessionId);
  }
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
   * The workbench chat's window, left open when the work on a message has ended (2026-10-19: "when the work on one
   * chat message is done, the browser is not to close, so that if the work goes on with another message it is open
   * already"). Given to the chat's next message, in this conversation or a new one, so it does not open again.
   *
   * Not a claim on the browser (`browser`): nothing is using it. Whatever takes the browser next and is not a message
   * of the chat — a session's run, a batch, signing in, reading the models — closes it first (`closeChatWindow`),
   * since the profile takes one window. The operator closes it with its X whenever they like; that is found when it
   * is next wanted (`keptChatWindow`), and it is closed when the program is.
   */
  private chatWindow: ChatTransport | null = null;

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

  async getLevel1(): Promise<{ content: string }> {
    await this.init();
    return await this.store.getLevel1();
  }

  // --- sessions and tasks ---------------------------------------------------------------

  async listSessions(): Promise<Array<Session & { running: boolean; paused: boolean; pauses?: Array<{ from: string; to?: string }> }>> {
    await this.init();
    const all = await this.store.listSessions();
    // The pauses of the run going on, for the page to take them off the minutes it shows (2026-10-21).
    return all.map((s) => ({ ...s, running: this.running.has(s.id), paused: this.running.get(s.id)?.hold.held ?? false, ...this.pausesOf(s.id) }));
  }

  async getSession(
    id: string,
  ): Promise<(Session & { running: boolean; paused: boolean; pauses?: Array<{ from: string; to?: string }>; pending: PendingApproval[]; runMode?: 'confirm' | 'unattended' }) | null> {
    await this.init();
    const s = await this.store.getSession(id);
    if (!s) return null;
    const pending = [...this.waiting.values()].filter((w) => w.approval.sessionId === id).map((w) => w.approval);
    return { ...s, running: this.running.has(id), paused: this.running.get(id)?.hold.held ?? false, ...this.pausesOf(id), pending, runMode: this.running.get(id)?.mode };
  }

  /** The pauses of the run going on in a session, from "Pause" to "Continue"; none when nothing runs or it was never paused. */
  private pausesOf(id: string): { pauses?: Array<{ from: string; to?: string }> } {
    const pauses = this.running.get(id)?.hold.pauses ?? [];
    return pauses.length > 0 ? { pauses } : {};
  }

  async updateSession(
    id: string,
    patch: {
      name?: string;
      model?: string;
      /** The model set by hand in the Copilot window; see `Session.manualModel`. */
      manualModel?: boolean;
      onFailure?: 'stop' | 'continue';
      conversationGroup?: string;
      projectDir?: string;
      vcs?: Partial<VersionControl>;
      review?: Partial<ReviewSettings>;
      active?: boolean;
      /** Plan mode for this session; empty follows Settings. See `PlanMode`. */
      planMode?: PlanMode | '';
      /** Two chats: the worker's model, or by hand. */
      workerModel?: string;
      workerManualModel?: boolean;
    },
  ): Promise<Session> {
    await this.init();
    if (patch.active !== undefined && this.running.has(id)) {
      throw new Error('This session is running; its status can be changed once it has stopped.');
    }
    const updated = await this.store.updateSession(id, (s) => {
      const before = { model: s.model, manualModel: s.manualModel };
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
      if (typeof patch.manualModel === 'boolean') {
        if (patch.manualModel) s.manualModel = true;
        else delete s.manualModel;
      }
      // Another choice of model: what was set by hand in the conversation is not what is asked for any more.
      if ((patch.model !== undefined || typeof patch.manualModel === 'boolean') && (s.model !== before.model || !!s.manualModel !== !!before.manualModel)) {
        delete s.modelByHand;
      }
      // The worker's model (two chats), kept on the lead's session and given to its worker below.
      if (s.lead && (patch.workerModel !== undefined || typeof patch.workerManualModel === 'boolean')) {
        const manual = typeof patch.workerManualModel === 'boolean' ? patch.workerManualModel : !!s.lead.workerManualModel;
        const model = patch.workerModel !== undefined ? patch.workerModel.trim() : (s.lead.workerModel ?? '');
        s.lead = { ...s.lead, workerManualModel: manual || undefined, workerModel: manual ? undefined : model || undefined };
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
      if (patch.planMode !== undefined) {
        if (patch.planMode === 'off' || patch.planMode === 'auto' || patch.planMode === 'approve') s.planMode = patch.planMode;
        else delete s.planMode;
      }
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
        /*
         * The session page names local branches: a start or a branch changed there is a local one, and
         * the remote the start window chose it from last time no longer applies (see `baseRemote`).
         */
        const pointMoved =
          (patch.vcs.startFrom !== undefined && patch.vcs.startFrom !== s.vcs?.startFrom) ||
          (patch.vcs.baseBranch !== undefined && patch.vcs.baseBranch.trim() !== (s.vcs?.baseBranch ?? '').trim()) ||
          (patch.vcs.existingBranch !== undefined && patch.vcs.existingBranch.trim() !== (s.vcs?.existingBranch ?? '').trim());
        if (pointMoved && patch.vcs.baseRemote === undefined) delete merged.baseRemote;
        if (merged.baseRemote !== undefined && !merged.baseRemote.trim()) delete merged.baseRemote;
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
          (merged.baseRemote ?? '') !== (s.vcs?.baseRemote ?? '') ||
          (merged.updateFromRemote !== false) !== (s.vcs?.updateFromRemote !== false) ||
          merged.repoDir.toLowerCase() !== (s.vcs?.repoDir ?? '').trim().toLowerCase();
        if (startChanged) {
          s.vcsBaseCommit = undefined;
          s.vcsStart = undefined;
        }
        s.vcs = merged;
      }
    });
    // The worker's model (two chats): given to the worker's session too, which asks again for one chosen by hand.
    const workerId = updated.lead?.workerSessionId;
    if (workerId && (patch.workerModel !== undefined || typeof patch.workerManualModel === 'boolean')) {
      await this.store
        .updateSession(workerId, (w) => {
          w.manualModel = updated.lead?.workerManualModel ? true : undefined;
          w.model = updated.lead?.workerManualModel ? undefined : updated.lead?.workerModel;
          w.modelSource = w.model ? 'operator' : undefined;
          delete w.modelByHand;
        })
        .catch(() => undefined);
    }
    return updated;
  }

  /**
   * A note to the chat about a task (2026-10-14): queued, running or waiting, it goes out with the task's
   * next message — at once, in effect, for a task that is running. See `Task.notes`.
   */
  async addTaskNote(sessionId: string, taskId: string, text: string): Promise<Task> {
    await this.init();
    const task = await this.store.addTaskNote(sessionId, taskId, text);
    const running = this.running.has(sessionId) && ['running', 'waiting-approval'].includes(task.status);
    this.bus.publish({ sessionId, taskId, type: 'task-note-added', level: 'info',
      message: running ? 'a note from the operator; it goes to the chat with the next report' : 'a note from the operator; it goes to the chat when the task runs next',
      data: { length: text.trim().length, running } });
    return task;
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

  /**
   * Everything that passed between the bot and Copilot for one task — every message sent, every reply, every
   * command with its whole output — every attempt of it and nothing of the tasks around it (2026-10-18: one JSON per
   * message of the chat). See `taskExchange.ts`.
   */
  async taskExchange(sessionId: string, taskId: string): Promise<{ fileName: string; content: string }> {
    await this.init();
    const session = await this.store.getSession(sessionId);
    const task = session?.tasks.find((t) => t.id === taskId);
    if (!session || !task) throw new Error('No such task.');
    const cfg = await this.settings.load();
    const document = await buildTaskExchange(cfg.resolved.runsDir, session, task);
    // The conversation's code and the message's place in it, then its first words: findable among a day's files.
    const label = `${chatCode(session.id)}-${String(session.tasks.indexOf(task) + 1).padStart(2, '0')}-${task.title}`;
    return { fileName: exportFileName('exchange', label), content: JSON.stringify(document, null, 2) };
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

  /** The window the chat left open, if it is still there; one the operator closed with its X is let go of. */
  private async keptChatWindow(): Promise<ChatTransport | undefined> {
    const window = this.chatWindow;
    if (!window) return undefined;
    if (window.isOpen()) return window;
    this.chatWindow = null;
    await window.close().catch(() => undefined);
    return undefined;
  }

  private keepChatWindow(window: ChatTransport): void {
    // One at a time, as the profile allows: an earlier one still held is closed rather than lost open.
    const earlier = this.chatWindow;
    this.chatWindow = window;
    if (earlier && earlier !== window) void earlier.close().catch(() => undefined);
  }

  /** Closes the window the chat left open, before something else takes the browser. Said on the console. */
  private async closeChatWindow(why: string): Promise<void> {
    const window = this.chatWindow;
    if (!window) return;
    this.chatWindow = null;
    if (window.isOpen()) console.log(`[chat] the window the chat left open is closed: ${why}`);
    await window.close().catch(() => undefined);
  }

  /** The card in the chat's window once the work on a message has ended (see `session/chatNotice.ts`). */
  private async chatWindowNotice(sessionId: string, tally: RunTally): Promise<void> {
    const window = this.chatWindow;
    if (!window?.isOpen()) return;
    const s = await this.store.getSession(sessionId);
    if (!s) return;
    const ids = new Set(s.runGroup?.taskIds ?? []);
    const tasks = s.tasks.filter((t) => ids.has(t.id)).map((t) => ({ title: t.title, status: t.status, reason: t.reason, summary: t.summary }));
    if (tasks.length === 0) return;
    // Refused at its turn, nothing of it began: said as a start that could not happen, not as a stop.
    await window.showNotice(chatNotice(s.lang || 'en', tasks, tally.error ?? tally.refused)).catch(() => undefined);
  }

  /** The program is closing: so is the window the chat left open. */
  async onModuleDestroy(): Promise<void> {
    // The queue's loop lets go; its file still says running, and the next start says what was in flight (`recoverQueue`).
    this.queueClosing = true;
    await this.closeChatWindow('the program is closing');
  }

  /**
   * Starts the session's queued tasks in the background. Returns immediately; progress
   * arrives on the event stream. One run at a time, of this session or any other.
   */
  async start(
    sessionId: string,
    mode: 'confirm' | 'unattended' = 'confirm',
  ): Promise<StartReply> {
    const pressedAt = new Date().toISOString();
    // One conversation at a time is not a policy, it is the browser profile: a second run
    // does not get a second browser, it gets an error about a closed one. Whatever has the
    // browser now — another conversation, a read of the models, the sign-in — the start is refused where
    // the reason can still be read, rather than three minutes later in a stack trace.
    const claim = this.claimBrowser({ kind: 'run', sessionId });
    if ('refused' in claim) return await this.notStarted({ stage: 'refused', message: claim.refused, sessionIds: [sessionId], pressedAt });
    let runId: string | undefined;
    try {
      // Set aside: said first, before the preflight judges a session that will not run.
      if ((await this.store.getSession(sessionId))?.active === false) {
        this.releaseBrowser(claim.holder);
        return await this.notStarted({ stage: 'refused', message: INACTIVE_REASON, sessionIds: [sessionId], pressedAt });
      }
      // Named after what it is a run of.
      const chosenName = await this.suggestRunName([sessionId]);
      const runGroup: TaskRunGroup = { id: newId('r-'), startedAt: new Date().toISOString(), sessions: 1, name: chosenName };
      runId = runGroup.id;
      const before = await this.store.getSession(sessionId);
      const earlyRefusal = !before ? 'no such session' : queuedToRun(before).length === 0 ? 'no queued tasks' : await this.unattendedRefusal(mode);
      if (earlyRefusal) {
        this.releaseBrowser(claim.holder);
        // No run log for a session that does not exist: the id is the caller's, and may be anything.
        return await this.notStarted({ stage: 'refused', message: earlyRefusal, sessionIds: [sessionId], pressedAt, ...(before ? { runId } : {}) });
      }
      // Recorded by `beginRun` once the start is accepted, not here: see `recordOnSession`.
      // Version control first, before anything opens the browser: see `vcs/runPreflight.ts`.
      const notReady = await this.runPreflight(runGroup.id, [sessionId]);
      if (notReady) {
        this.releaseBrowser(claim.holder);
        return await this.notStarted({ stage: 'preflight', message: notReady, sessionIds: [sessionId], pressedAt, runId });
      }
      // A message of the chat is given the window the last one left open, while it is still there (see `chatWindow`).
      const chat = before?.kind === 'chat';
      const lent = chat ? await this.keptChatWindow() : undefined;
      const begun = await this.beginRun(sessionId, mode, lent, runGroup, undefined, { recordOnSession: true, pressedAt, chatWindow: chat });
      if (!begun.started) {
        this.releaseBrowser(claim.holder);
        return await this.notStarted({ stage: 'refused', message: begun.reason ?? 'not started', sessionIds: [sessionId], pressedAt, runId });
      }
      // The window closes before the run's promise settles (see `runSession`), so the browser is
      // free again exactly when it is. The chat's stays open, and says in it that the work has ended.
      void begun.done
        .then((tally) => (chat ? this.chatWindowNotice(sessionId, tally) : undefined))
        .catch(() => undefined)
        .finally(() => this.releaseBrowser(claim.holder));
      return { started: true };
    } catch (e) {
      this.releaseBrowser(claim.holder);
      if (unusableConfig(e)) throw e;
      // Said with the error itself, and on record with the console of those moments, rather than as a bare 500.
      console.error('[start] the session could not be started:', (e as Error).stack ?? (e as Error).message);
      return await this.notStarted({ stage: 'error', message: (e as Error).message, sessionIds: [sessionId], pressedAt, runId });
    }
  }

  /**
   * A start that did not happen, put on record (`session/startFailure.ts`) and in the run's log when it
   * had a run, and said on the console, so the terminal shows it as well. `answered`: the reply to the
   * press carries it; false for one found after the start was accepted, which every page then shows.
   */
  private async notStarted(f: {
    stage: StartStage;
    message: string;
    sessionIds: string[];
    pressedAt: string;
    runId?: string;
    answered?: boolean;
  }): Promise<{ started: false; reason: string; failure: StartFailureRef }> {
    const sessions: Array<{ id: string; name: string }> = [];
    for (const id of f.sessionIds) {
      const s = await this.store.getSession(id).catch(() => null);
      sessions.push({ id, name: s?.name ?? id });
    }
    const recorded = this.startFailures.record({
      pressedAt: f.pressedAt,
      stage: f.stage,
      message: f.message,
      ...(f.runId ? { runId: f.runId } : {}),
      sessions,
      answered: f.answered !== false,
    });
    console.warn(`[start] the work did not start (${f.stage}${f.runId ? `, run ${f.runId}` : ''}): ${f.message}`);
    if (f.runId) {
      const cfg = await this.settings.load().catch(() => null);
      if (cfg) {
        await appendRunLog(cfg.resolved.runsDir, f.runId, [
          { at: recorded.at, type: 'start-failed', message: f.message, data: { stage: f.stage, failure: recorded.id, sessions: f.sessionIds } },
        ]).catch(() => undefined);
      }
    }
    return { started: false, reason: f.message, failure: refOf(recorded) };
  }

  /** The starts that did not get as far as a first task, newest first: see `session/startFailure.ts`. */
  recentStartFailures(unansweredOnly: boolean): StartFailureRef[] {
    return this.startFailures.recent({ unansweredOnly }).slice(0, 10).map(refOf);
  }

  /**
   * One of them as a file: what failed and where, the run's record, the sessions' events from the press,
   * and the console lines from the press to a few seconds after — secret-shaped text taken out.
   */
  async startFailureReport(id: string): Promise<{ fileName: string; content: string }> {
    await this.init();
    const f = this.startFailures.get(id);
    if (!f) throw new Error('That failed start is not known to this process (was the bot restarted since?). Its console is still in the terminal log: System → "Download what the terminal showed".');
    const cfg = await this.settings.load();
    const from = new Date(new Date(f.pressedAt).getTime() - 2_000).toISOString();
    const to = new Date(new Date(f.at).getTime() + 5_000).toISOString();
    const events = f.sessions.flatMap((s) => this.bus.recent(s.id)).filter((e) => e.at >= from).sort((a, b) => a.at.localeCompare(b.at));
    const text = failureReport(f, {
      runLog: await readRunLog(cfg.resolved.runsDir, f.runId),
      events,
      terminal: terminalLines({ from, to, max: 2_000 }),
      terminalFile: terminalLogFile(),
      version: botVersion(),
    });
    return { fileName: `copilot-operator-not-started-${fileStamp(f.at)}.txt`, content: redactSecrets(text, cfg.report.redactPatterns) };
  }

  /** What the bot's console showed: the latest lines kept in memory, as a file. See `log/terminal.ts`. */
  /** How much an export of the bot's folder would hold (2026-10-23): its data, and its runs' records. */
  exportSizes(): { data: number; dataFiles: number; runs: number; runsFiles: number } {
    return exportSizes(this.layout);
  }

  /**
   * Everything the bot has kept, as one .zip (operator, 2026-10-23): `data/` — the key and the Edge profile left out,
   * the manifest says why — and `runs/` when asked for.
   */
  exportHome(runs: boolean): { fileName: string; content: Buffer } {
    const now = new Date();
    return { fileName: homeExportName(now), content: createZip(exportEntries(this.layout, { runs, version: botVersion(), now })) };
  }

  async terminalReport(): Promise<{ fileName: string; content: string }> {
    const cfg = await this.settings.load();
    const lines = terminalLines({ max: 5_000 });
    const file = terminalLogFile();
    const head = [
      "copilot-operator — what the terminal showed (the bot's console)",
      `Version: ${botVersion()}`,
      `${lines.length} line(s), the latest kept in memory${file ? `; everything since the bot started is in ${file}` : ''}.`,
      '',
      '',
    ].join('\n');
    return { fileName: `copilot-operator-terminal-${fileStamp(new Date().toISOString())}.txt`, content: redactSecrets(`${head}${formatTerminal(lines)}\n`, cfg.report.redactPatterns) };
  }

  /**
   * Begins the run `start` asked for, and hands back a promise that settles when it is over and says how it went.
   * One at a time: the browser profile is single-writer, so two conversations at once is not slower, it is a
   * failure with a message about a closed browser.
   */
  private async beginRun(
    sessionId: string,
    mode: 'confirm' | 'unattended',
    /** A browser that is already open: the one the chat left open (see `chatWindow`); otherwise the run opens one. */
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
       * that never happened: it replaced the record of the run actually in progress; and for a session that
       * does not exist, the write threw and the start answered 500.
       */
      recordOnSession?: boolean;
      /** When the start was asked for; a run that fails before its first task is recorded from then. */
      pressedAt?: string;
      /** A message of the workbench's chat: the window it opens is kept for the next one (see `chatWindow`). */
      chatWindow?: boolean;
    } = {},
  ): Promise<{ started: boolean; reason?: string; done: Promise<RunTally> }> {
    await this.init();
    const idle: RunTally = { ran: 0, failed: 0, leftQueued: 0, failedTitles: [] };
    if (this.running.has(sessionId)) return { started: false, reason: 'already running', done: Promise.resolve(idle) };
    const session = await this.store.getSession(sessionId);
    if (!session) return { started: false, reason: 'no such session', done: Promise.resolve(idle) };
    // Set aside by the operator on the Sessions page: not started by anything until made active.
    if (session.active === false) {
      return { started: false, reason: INACTIVE_REASON, done: Promise.resolve(idle) };
    }
    const queuedIds = queuedToRun(session, onlyTasks).map((t) => t.id);
    if (queuedIds.length === 0) return { started: false, reason: 'no queued tasks', done: Promise.resolve(idle) };

    const loaded = await this.settings.load();
    // A chat conversation's git is the operator's: switching branches and committing are allowed there (2026-10-17).
    const cfg: ResolvedConfig = session.kind === 'chat' ? { ...loaded, execution: { ...loaded.execution, denyPatterns: chatDenyPatterns(loaded.execution.denyPatterns) } } : loaded;
    const policy = {
      mode,
      denyPatterns: cfg.execution.denyPatterns,
      allowedPrograms: cfg.execution.allowedPrograms,
      isolation: cfg.execution.isolation,
      lockedToConfirm: cfg.policyLock?.maxMode === 'confirm',
      // Read once per run like the rest of the policy: a change in Settings applies from the next start.
      networkFetch: cfg.execution.networkFetch,
      platformAccess: cfg.execution.questions === 'agree' ? ('allow' as const) : ('ask' as const),
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

    const startedAt = new Date().toISOString();
    const hold = new Hold();
    this.running.set(sessionId, { controller, startedAt, mode, policy, hold });
    // Who was at work in a run of it that ended without saying so is not who is at work in this one.
    this.acting.delete(sessionId);
    {
      const asLead = await this.store.getSession(sessionId);
      if (asLead?.lead?.workerSessionId) this.workerLeads.set(asLead.lead.workerSessionId, sessionId);
    }
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
      // Opening a window of its own: the one the chat left open goes first, since the profile takes one.
      ...(transport
        ? {}
        : {
            beforeBrowser: async () => {
              await this.closeChatWindow('another run needs the browser');
              if (runGroup) await this.browserRequested(runGroup.id, [sessionId]);
            },
          }),
      ...(how.chatWindow ? { chatWindow: { keep: (window: ChatTransport) => this.keepChatWindow(window) } } : {}),
      // The page is the source of the model names: Settings and the saved list follow it (see `ModelHooks`).
      models: {
        locate: async (name) => (await this.store.getModels())?.options.find((o) => sameModel(o.name, name))?.locator,
        askHelp: (ask) => this.askModelHelp(ask, controller.signal),
        renamedDefault: async (which, from, to) => {
          const now = (await this.settings.load()).copilot;
          if (which === 'model' && (now.defaultModel ?? '').trim() === from) await this.setDefaultModel(to);
          if (which === 'review' && (now.defaultReviewModel ?? '').trim() === from) await this.setDefaultReviewModel(to);
          if (which === 'lead' && (now.defaultLeadModel ?? '').trim() === from) await this.setDefaultLeadModel(to);
        },
        seen: async (options, current) => {
          await this.store.saveModels({ options, current: current ?? undefined, readAt: new Date().toISOString() });
        },
      },
      // Plan mode `approve`: the plan is put to the operator on the approvals card.
      approvePlan: (ask) => this.askPlanApproval(ask, controller.signal),
      // The two-chat mode (2026-10-20): the lead's questions, and the worker the run speaks for too.
      askQuestion: (ask) => this.askLeadQuestion(ask, controller.signal),
      askSubtaskRetry: (ask) => this.askSubtaskRetry(ask, controller.signal),
      onWorker: (workerId) => this.workerLeads.set(workerId, sessionId),
      hold,
    })
      .then(async (outcome) => {
        const tally = { ...(await this.tally(sessionId, queuedIds)), paused: outcome.paused, ...(outcome.refused ? { refused: outcome.refused } : {}) };
        // Refused at its turn in a run that was going: nothing of it began, and nobody was answered with it.
        if (outcome.refused && tally.ran === 0) {
          await this.notStarted({ stage: 'at-turn', message: outcome.refused, sessionIds: [sessionId], pressedAt: how.pressedAt ?? startedAt, ...(runGroup ? { runId: runGroup.id } : {}), answered: false });
        }
        return tally;
      })
      .catch(async (e: unknown) => {
        this.bus.publish({ sessionId, type: 'run-failed', level: 'error', message: (e as Error).message });
        const tally = { ...(await this.tally(sessionId, queuedIds)), error: (e as Error).message };
        /*
         * Failed before any task of it began — the browser, the profile, the sign-in, the model: the start
         * was answered "started" already, so the failure is shown on every page, with the console (2026-10-13).
         */
        // Not when the operator stopped it: that is an answer, not a failure to show.
        if (tally.ran === 0 && !controller.signal.aborted) {
          console.error('[start] the run ended before its first task:', (e as Error).stack ?? (e as Error).message);
          await this.notStarted({ stage: failedWhileOpening(e) ? 'browser' : 'run', message: (e as Error).message, sessionIds: [sessionId], pressedAt: how.pressedAt ?? startedAt, ...(runGroup ? { runId: runGroup.id } : {}), answered: false });
        }
        return tally;
      })
      .finally(() => {
        for (const [id, w] of this.waiting) {
          if (this.runKey(w.approval.sessionId) === sessionId) {
            w.resolve({ action: 'abort', reason: 'the run ended' });
            this.waiting.delete(id);
          }
        }
        this.running.delete(sessionId);
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
  /**
   * "Pause" on the chat (operator, 2026-10-20): the running work holds at its next message to Copilot or its next
   * command, and the button becomes "Continue". A reply being written and a command running are let finish.
   */
  pause(sessionId: string): { paused: boolean } {
    const r = this.running.get(sessionId);
    if (!r) throw new Error('Nothing of this conversation is running, so there is nothing to pause.');
    if (r.hold.pause()) {
      this.bus.publish({ sessionId, type: 'pause-asked', level: 'info', message: 'paused by the operator: the work holds at its next message or command, until Continue' });
    }
    return { paused: true };
  }

  /** "Continue": the paused work goes on from where it held. A run that has ended meanwhile has nothing to go on with. */
  resume(sessionId: string): { paused: boolean } {
    const r = this.running.get(sessionId);
    if (r?.hold.resume()) this.bus.publish({ sessionId, type: 'resume-asked', level: 'info', message: 'continued by the operator' });
    return { paused: false };
  }

  async stop(sessionId: string): Promise<{ stopping: boolean }> {
    const r = this.running.get(sessionId);
    if (!r) return { stopping: false };
    r.controller.abort();
    for (const [id, w] of this.waiting) {
      if (this.runKey(w.approval.sessionId) === sessionId) {
        w.resolve({ action: 'abort', reason: 'stopped by the operator', by: 'operator' });
        this.waiting.delete(id);
      }
    }
    await this.store.updateSession(sessionId, (s) => {
      s.status = 'stopping';
    });
    // The running step is cut off, not waited for: said as it is (live run 2026-10-03). An answer the chat is writing
    // is waited for, so the conversation is left whole; the choice of model and the sign-in end at once (2026-10-17).
    this.bus.publish({ sessionId, type: 'stop-requested', level: 'warn', message: 'stopping now: nothing more is sent, a step still running is cut off, and an answer Copilot is writing is waited for first' });
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
  activity(): { running: boolean; sessions: number; starting: boolean; acting?: Acting; paused?: boolean; last?: { status: string; at: string } } {
    /*
     * A run being started — its version control checked before the browser opens — is not running yet
     * and not idle either: `starting` says so, so "nothing is happening" is not read in that moment.
     */
    const starting = this.running.size === 0 && this.browser?.kind === 'run';
    // Who is at work in the run going now — the lead's session says when its worker is (2026-10-22) — and whether it is held.
    const [id, run] = [...this.running.entries()][0] ?? [];
    const acting = id ? this.acting.get(id) : undefined;
    return {
      running: this.running.size > 0,
      sessions: this.running.size,
      starting,
      ...(acting ? { acting } : {}),
      ...(run?.hold?.held ? { paused: true } : {}),
      // How the last message ended, while nothing runs: what the tab says until the operator has looked.
      ...(this.running.size === 0 && this.lastOutcome ? { last: { status: this.lastOutcome.status, at: this.lastOutcome.at } } : {}),
    };
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

  // --- plans ----------------------------------------------------------------------------

  // --- the workspace and its chat (2026-10-17, "like Windsurf") ------------------------------

  /** The project folder the workbench has open: Settings → the default project. */
  async workspace(): Promise<WorkspaceInfo> {
    await this.init();
    const cfg = await this.settings.load();
    return await workspaceInfo(cfg.project?.rootDir ?? '', cfg.project?.name ?? '');
  }

  /** The open folder's code, searched as VS Code's Search view does (2026-10-21, see `workspaceSearch.ts`). */
  async workspaceSearch(query: string, opts: SearchOptions): Promise<SearchResult> {
    const ws = await this.workspace();
    if (!ws.ok) throw new Error(ws.problem ?? 'No project folder is open.');
    return await searchWorkspace(ws.dir, query, opts);
  }

  /** A file of the open folder as its bytes, with its type: an image a Markdown preview shows (2026-10-21). */
  async workspaceRaw(path: string): Promise<{ bytes: Buffer; type: string }> {
    const ws = await this.workspace();
    if (!ws.ok) throw new Error(ws.problem ?? 'No project folder is open.');
    return await workspaceRaw(ws.dir, path);
  }

  async workspaceFiles(): Promise<{ dir: string; files: string[]; truncated: boolean }> {
    const ws = await this.workspace();
    if (!ws.ok) throw new Error(ws.problem ?? 'No project folder is open.');
    return { dir: ws.dir, ...(await workspaceFiles(ws.dir)) };
  }

  async workspaceFile(path: string): Promise<{ path: string; text: string | null; binary: boolean; tooLarge: boolean; size: number; version?: string }> {
    const ws = await this.workspace();
    if (!ws.ok) throw new Error(ws.problem ?? 'No project folder is open.');
    return await workspaceFile(ws.dir, path);
  }

  /** The editor's text saved over a file of the open folder, over the version it was made on (see `saveWorkspaceFile`). */
  async saveWorkspaceFile(path: string, text: string, base?: string): Promise<{ path: string; version: string; size: number }> {
    const ws = await this.workspace();
    if (!ws.ok) throw new Error(ws.problem ?? 'No project folder is open.');
    const saved = await saveWorkspaceFile(ws.dir, path, text, base);
    console.log(`[editor] saved ${saved.path} (${saved.size} bytes)`);
    return saved;
  }

  /** The open folder's git, as an IDE's Source Control view shows it (see `workspaceGit.ts`). Read-only. */
  async workspaceGit(): Promise<Awaited<ReturnType<typeof workspaceGit>>> {
    const ws = await this.workspace();
    if (!ws.ok) throw new Error(ws.problem ?? 'No project folder is open.');
    return await workspaceGit(ws.dir);
  }

  /** Everything the branch changed against a base, as a pull request shows it (see `branchChanges`). Read-only. */
  async workspaceBranch(base?: string): Promise<Awaited<ReturnType<typeof branchChanges>>> {
    const ws = await this.workspace();
    if (!ws.ok) throw new Error(ws.problem ?? 'No project folder is open.');
    return await branchChanges(ws.dir, base);
  }

  async workspaceCommit(sha: string): Promise<Awaited<ReturnType<typeof workspaceCommit>>> {
    const ws = await this.workspace();
    if (!ws.ok) throw new Error(ws.problem ?? 'No project folder is open.');
    return await workspaceCommit(ws.dir, sha);
  }

  async workspaceGitFile(area: GitArea, path: string, commit?: string): Promise<Awaited<ReturnType<typeof workspaceGitVersions>>> {
    const ws = await this.workspace();
    if (!ws.ok) throw new Error(ws.problem ?? 'No project folder is open.');
    return await workspaceGitVersions(ws.dir, area, path, commit);
  }

  /**
   * Kerrigan (2026-10-20): the persona the operator may give to a chat of their own, in the language asked for, with
   * this machine's limits in it and the projects of Settings — each one's folder, its branch now, and the level 2 the
   * operator wrote for it. Nothing is sent anywhere: the page saves it or copies it. See `plan/kerrigan.ts`; in a
   * language she is not written out in, the page fills in the names of the controls (`filled: false`).
   */
  async kerrigan(lang: string): Promise<{ lang: string; fileName: string; text: string; filled: boolean }> {
    const cfg = await this.settings.load();
    const p = await this.project();
    const projects = [
      ...(p.rootDir ? [{ name: p.name, rootDir: p.rootDir, ...(p.branch ? { branch: p.branch } : {}), level2: p.level2, chat: true, ...(p.readOnly ? { readOnly: true } : {}) }] : []),
      ...p.others.map((o) => ({ name: o.name, rootDir: o.rootDir, ...(o.branch ? { branch: o.branch } : {}), level2: o.level2, ...(o.readOnly ? { readOnly: true } : {}) })),
    ];
    // The skills, each with the name of the project it is for.
    const nameOf = (dir: string): string => [{ name: p.name || p.rootDir, rootDir: p.rootDir }, ...p.others].find((x) => x.rootDir && sameFolder(x.rootDir, dir))?.name ?? dir;
    const skills = (await this.skills()).skills.map((k) => ({ name: k.name, description: k.description, ...(k.projectDir ? { project: nameOf(k.projectDir) } : {}) }));
    const text = kerriganPersona(lang, {
      version: botVersion(),
      skills,
      maxIterations: cfg.limits.maxIterations,
      maxRunMinutes: cfg.limits.maxRunMinutes,
      autoContinue: cfg.limits.autoContinue ?? 0,
      maxReviewRounds: cfg.limits.maxReviewRounds ?? 2,
      maxSubtasks: cfg.limits.maxSubtasks ?? 20,
      projects,
    });
    return { lang, fileName: kerriganFileName(lang), text, filled: lang === 'en' || lang === 'bg' };
  }

  /** The chat's conversations, newest first. */
  async chatThreads(): Promise<Array<{ id: string; name: string; createdAt: string; status: Session['status']; turns: number; running: boolean; repoDir: string }>> {
    await this.init();
    return (await this.store.listSessions())
      // A worker's session (two chats) is not a conversation of the list: it is shown under its lead's messages.
      .filter((s) => s.kind === 'chat' && !s.workerOf)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => ({ id: s.id, name: s.name, createdAt: s.createdAt, status: s.status, turns: s.tasks.length, running: this.running.has(s.id), repoDir: s.vcs?.repoDir || s.projectDir }));
  }

  /**
   * A message written in the chat. With no conversation yet, one is made in the open project folder: a session of
   * kind `chat`, one branch for all of it, reviewed by a conversation of its own unless "Review" under the box is
   * unticked (2026-10-20), plan mode as chosen there, so each message is answered as it would be in an IDE's chat. The message becomes a task of it, queued; the caller starts it (the start window
   * the first time, where the work starts being asked once). While the conversation is working, the message is a
   * note to the task in flight, which the chat gets with its next report.
   */
  async chatSend(input: { text: string; threadId?: string; model?: string; manualModel?: boolean; lang?: string; planMode?: boolean; review?: boolean; reviewModel?: string; lead?: boolean; workerModel?: string; workerManualModel?: boolean; skill?: string }): Promise<{ threadId: string; taskId: string; noted?: boolean; needsStart: boolean }> {
    await this.init();
    const text = (input.text ?? '').trim();
    if (!text) throw new Error('The message is empty.');
    if (text.length > MAX_INSTRUCTION_CHARS) throw new Error(`The message is ${text.length} characters; it can be at most ${MAX_INSTRUCTION_CHARS}.`);
    let session = input.threadId ? await this.store.getSession(input.threadId) : null;
    if (input.threadId && (!session || session.kind !== 'chat')) throw new Error('That conversation is not there any more. Start a new one.');
    // The skill chosen for this message, as it reads now: the task keeps this copy whatever is edited later.
    const skill = input.skill?.trim() ? await this.skillFor(input.skill, session?.projectDir ?? (await this.workspace()).dir) : undefined;
    if (session) {
      const inFlight = session.tasks.find((t) => t.status === 'running' || t.status === 'waiting-approval');
      if (inFlight && this.running.has(session.id)) {
        if (skill) throw new Error(`A skill goes with a new message, and this one would be a note to the message at work. Send /${skill.name} when it has finished.`);
        await this.addTaskNote(session.id, inFlight.id, text);
        return { threadId: session.id, taskId: inFlight.id, noted: true, needsStart: false };
      }
    } else {
      const ws = await this.workspace();
      if (!ws.ok) throw new Error(ws.problem ?? 'No project folder is open.');
      const title = text.split(/\r?\n/)[0]!.trim().slice(0, 60);
      const created = await this.store.createSession(`chat: ${title}`, ws.dir);
      session = await this.store.updateSession(created.id, (s) => {
        s.kind = 'chat';
        s.onFailure = 'continue';
        /*
         * The review as chosen under the box (operator, 2026-10-20): the box is on unless unticked, and the page always
         * says which. A second conversation checks the work when it says it is done, and sends back what it finds; it
         * was off for the chat from 2026-10-17. Asked for without the box — the API on its own, a script — it stays off.
         */
        s.review = { enabled: input.review === true, model: input.reviewModel?.trim() ?? '' };
        // The review's model chosen beside the box (2026-10-21) is the operator's word, as the work's is.
        if (s.review.model) s.reviewModelSource = 'operator';
        // Plan mode as chosen under the box (2026-10-20, "as in Claude Code"): the plan first, approved by the operator.
        s.planMode = input.planMode ? 'approve' : 'off';
        /*
         * No version control of the bot's own (2026-10-17): no branch, no commit, no question about where the work
         * starts. The chat works on the branch the folder is on, with what is in it, as an IDE's chat does; each
         * message is photographed before it runs instead, so the operator can go back to before it.
         */
        s.vcs = { ...(s.vcs ?? DEFAULT_VCS), enabled: false, repoDir: '' };
        s.projectDir = ws.dir;
        /*
         * Two chats (operator, 2026-10-20): this conversation is the lead's, and a worker carries out its subtasks. The
         * lead judges the worker's reports, so there is no review of its own.
         */
        if (input.lead) {
          s.lead = {
            ...(input.workerManualModel ? { workerManualModel: true } : {}),
            ...(!input.workerManualModel && input.workerModel?.trim() ? { workerModel: input.workerModel.trim() } : {}),
          };
          s.review = { enabled: false, model: '' };
        }
        // The model chosen in the chat for this conversation: the operator's word, which outranks Settings.
        if (input.manualModel) s.manualModel = true;
        else if (input.model?.trim()) {
          s.model = input.model.trim();
          s.modelSource = 'operator';
        }
      });
      this.bus.publish({ sessionId: session.id, type: 'chat-started', level: 'info', message: `a conversation in ${ws.dir}` });
    }
    const task = await this.store.addTask(session.id, {
      title: text.split(/\r?\n/)[0]!.trim().slice(0, 80) || 'message',
      level2: '',
      prompt: text,
      ...(skill ? { skill: { name: skill.name, description: skill.description, text: skill.text } } : {}),
    });
    // The language the workbench is in, for what the chat's window says when the work has ended (`chatWindowNotice`).
    if (input.lang && session.lang !== input.lang) {
      await this.store.updateSession(session.id, (s) => {
        s.lang = input.lang;
      });
    }
    // After going back, the conversation is told with this message: it still holds what was undone.
    const pending = (await this.store.getSession(session.id))?.rewindNote;
    if (pending) {
      await this.store.addTaskNote(session.id, task.id, pending);
      await this.store.updateSession(session.id, (s) => {
        s.rewindNote = undefined;
      });
    }
    return { threadId: session.id, taskId: task.id, needsStart: false };
  }

  // --- the queue of tasks (2026-10-24) ----------------------------------------------------------------
  //
  // Tasks written beforehand, each run in a new chat on its own model while nobody watches; one that failed takes
  // the tasks that depend on it with it, and the queue goes on with the next. See `queue/queue.ts`.

  private readonly queueFile = join(this.dataDir, 'queue.json');
  private queueTurn: Promise<unknown> = Promise.resolve();
  private queueLoop: Promise<void> | null = null;
  private queueRecovered = false;
  /** The program is closing: the queue's loop stops where it is. */
  private queueClosing = false;

  /** The queue as it is on disk; one that cannot be read is an empty one, said in the console. */
  private async readQueue(): Promise<Queue> {
    try {
      const q = JSON.parse(await readFile(this.queueFile, 'utf8')) as Partial<Queue>;
      return { items: Array.isArray(q.items) ? q.items : [], running: q.running === true, updatedAt: q.updatedAt ?? '' };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[queue] data/queue.json could not be read:', (e as Error).message);
      return emptyQueue();
    }
  }

  /** Changes the queue in a turn of its own, so two changes never write over each other. */
  private changeQueue(change: (q: Queue) => void): Promise<Queue> {
    const run = async () => {
      const q = await this.readQueue();
      change(q);
      q.updatedAt = new Date().toISOString();
      await writeFileAtomically(this.queueFile, JSON.stringify(q, null, 2));
      return q;
    };
    const done = this.queueTurn.then(run, run);
    this.queueTurn = done.catch(() => undefined);
    return done;
  }

  private setQueueItem(q: Queue, id: string, patch: Partial<QueueItem>): void {
    const item = q.items.find((x) => x.id === id);
    if (!item) return;
    Object.assign(item, patch);
    for (const key of Object.keys(patch) as Array<keyof QueueItem>) if (patch[key] === undefined) delete item[key];
  }

  /** A queue that was running when the bot last closed: not running now, and its task in flight stopped. */
  private async recoverQueue(): Promise<void> {
    if (this.queueRecovered) return;
    this.queueRecovered = true;
    const q = await this.readQueue();
    if (!q.running && !q.items.some((x) => x.status === 'running')) return;
    await this.changeQueue((x) => {
      x.running = false;
      for (const item of x.items) {
        if (item.status === 'running') Object.assign(item, { status: 'stopped', why: 'the bot was closed while it ran', endedAt: new Date().toISOString() });
      }
    });
  }

  async queue(): Promise<Queue> {
    await this.recoverQueue();
    return await this.readQueue();
  }

  /** The list as the page edits it: added, changed, moved, taken out, put back to wait ("Run again"). */
  async setQueue(items: unknown): Promise<Queue> {
    await this.recoverQueue();
    const checked = checkItems(items, MAX_INSTRUCTION_CHARS);
    if ('problem' in checked) throw new Error(checked.problem);
    let problem: string | undefined;
    const q = await this.changeQueue((x) => {
      const merged = mergeItems(x.items, checked.items);
      if ('problem' in merged) problem = merged.problem;
      else x.items = merged.items;
    });
    if (problem) throw new Error(problem);
    return q;
  }

  /** Runs the waiting tasks one after another, in the background; the page follows `queue()`. */
  async runQueue(): Promise<Queue> {
    await this.init();
    await this.recoverQueue();
    if (this.queueLoop) throw new Error('The queue is running already.');
    const q = await this.readQueue();
    if (!nextStep(q.items)) throw new Error('No task in the queue is waiting. Add one, or put one back with "Run again".');
    const ws = await this.workspace();
    if (!ws.ok) throw new Error(ws.problem ?? 'No project folder is open: open one in the chat first.');
    const unnamed = this.queueWithoutModel(q.items.filter((x) => x.status === 'waiting'), await this.settings.load());
    if (unnamed) throw new Error(unnamed);
    const started = await this.changeQueue((x) => {
      x.running = true;
    });
    this.queueLoop = this.runQueueLoop()
      .catch((e: unknown) => console.error('[queue] the queue stopped:', (e as Error).stack ?? (e as Error).message))
      .finally(() => {
        this.queueLoop = null;
        void this.changeQueue((x) => {
          x.running = false;
        });
      });
    return started;
  }

  /**
   * Tasks that would wait for the operator to choose their model by hand: none of their own, and no "Model for the
   * worker" in Settings — a chat that names no model is asked for it by hand (`modelByHand`), and nobody is there.
   */
  private queueWithoutModel(items: QueueItem[], cfg: Pick<ResolvedConfig, 'copilot'>): string | null {
    const said = items.flatMap((x) =>
      waitsByHand(x, cfg.copilot).map((part) =>
        part === 'model'
          ? `"${itemTitle(x)}" has no model of its own, and Settings have no "${x.lead ? 'Model for the lead' : 'Model for the worker'}"`
          : `"${itemTitle(x)}" is reviewed, with no model for the review of its own, and Settings have no "Model for the review"`,
      ),
    );
    if (said.length === 0) return null;
    return `${said.join('; ')}: ${said.length === 1 ? 'it' : 'they'} would wait for you to choose a model by hand. Choose the model in the task, or in Settings.`;
  }

  /** Stops the queue: the task at work is stopped as the chat's Stop does, and the rest wait. */
  async stopQueue(): Promise<Queue> {
    const q = await this.changeQueue((x) => {
      x.running = false;
    });
    const at = q.items.find((x) => x.status === 'running');
    if (at?.sessionId) await this.stop(at.sessionId).catch(() => undefined);
    return q;
  }

  private async runQueueLoop(): Promise<void> {
    const now = () => new Date().toISOString();
    for (;;) {
      if (this.queueClosing) return;
      const q = await this.readQueue();
      if (!q.running) return;
      const step = nextStep(q.items);
      if (!step) return;
      if ('skip' in step) {
        await this.changeQueue((x) => this.setQueueItem(x, step.skip.id, { status: 'skipped', why: skippedBecause(step.because), endedAt: now() }));
        continue;
      }
      const item = step.run;
      await this.changeQueue((x) => this.setQueueItem(x, item.id, { status: 'running', startedAt: now(), why: undefined, endedAt: undefined, sessionId: undefined }));
      const ended = await this.runQueueItem(item).catch((e: unknown): { status: QueueStatus; why: string } => ({ status: 'failed', why: (e as Error).message }));
      await this.changeQueue((x) => this.setQueueItem(x, item.id, { ...ended, endedAt: now() }));
      // Stopped — from the queue, or the chat's Stop: the rest wait for the operator.
      if (ended.status === 'stopped') return;
    }
  }

  /** One task of the queue, in a new chat, to its end. */
  private async runQueueItem(item: QueueItem): Promise<{ status: QueueStatus; why?: string; sessionId?: string }> {
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const stillRunning = async () => (await this.readQueue()).running;
    // Read afresh each time: the browser is let go of by other work while this waits.
    const holder = (): BrowserHolder | null => this.browser;
    // The browser may be the chat's, or a reading of the models': the task waits its turn.
    while (holder()) {
      if (this.queueClosing || !(await stillRunning())) return { status: 'stopped', why: 'the queue was stopped before it began' };
      await pause(1_000);
    }
    const ws = await this.workspace();
    if (!ws.ok) return { status: 'failed', why: ws.problem ?? 'no project folder is open' };
    // Settings may have changed since the queue was started.
    const unnamed = this.queueWithoutModel([item], await this.settings.load());
    if (unnamed) return { status: 'failed', why: unnamed };
    const base = item.branch === 'main' ? await mainBranchOf(ws.dir) : null;
    if (item.branch === 'main' && !base) return { status: 'failed', why: `${ws.dir} has no main (or master) branch to make a new branch from` };
    // As the chat's box sends a first message: the model, the review and its model, or two chats and the worker's model.
    const sent = await this.chatSend({
      text: item.prompt,
      ...(item.model ? { model: item.model } : {}),
      review: item.review,
      ...(item.reviewModel ? { reviewModel: item.reviewModel } : {}),
      ...(item.lead ? { lead: true, ...(item.workerModel ? { workerModel: item.workerModel } : {}) } : {}),
    });
    const sessionId = sent.threadId;
    await this.store.updateSession(sessionId, (s) => {
      s.name = `queue: ${itemTitle(item)}`;
      s.queueItem = item.id;
      /*
       * A new branch from main (2026-10-24): the runner's own version control, as a session of the bot's has it — the
       * branch cut from main, brought up to date from the server first when that needs no password (`updateFromRemote`
       * asks nobody anything; it fails, and the local main is used), and the work committed on it. The chat is told
       * which main it was (`noteFor`).
       */
      if (base) {
        s.vcs = { ...DEFAULT_VCS, enabled: true, repoDir: ws.dir, branchMode: 'per-session', commitOnFinish: true, startFrom: 'branch', baseBranch: base, updateFromRemote: true };
      }
    });
    await this.changeQueue((x) => this.setQueueItem(x, item.id, { sessionId }));
    const cfg = await this.settings.load();
    const reply = await this.start(sessionId, cfg.execution.mode);
    if (!reply.started) return { status: 'failed', why: reply.reason ?? 'it did not start', sessionId };
    // Until its run has ended and its window let the browser go, so the next one can have it.
    let asked = false;
    while (this.running.has(sessionId) || (holder()?.kind === 'run' && (holder() as { sessionId?: string }).sessionId === sessionId)) {
      if (this.queueClosing) return { status: 'stopped', why: 'the bot was closed while it ran', sessionId };
      if (!asked && !(await stillRunning())) {
        asked = true;
        await this.stop(sessionId).catch(() => undefined);
      }
      await pause(1_000);
    }
    const task = (await this.store.getSession(sessionId))?.tasks.find((t) => t.id === sent.taskId);
    const status = statusOfTask(task?.status);
    return { status, ...(status !== 'done' ? { why: task?.reason ?? `it ended ${task?.status ?? 'without a record'}` } : {}), sessionId };
  }

  // --- skills (2026-10-21) ----------------------------------------------------------------------------

  /** The skills in Settings, and how long what each is for may be. */
  async skills(): Promise<{ skills: Skill[]; maxDescription: number }> {
    const cfg = await this.settings.load();
    return {
      skills: (cfg.skills ?? []).map((k) => ({ name: k.name, description: k.description ?? '', text: k.text ?? '', projectDir: k.projectDir ?? '' })),
      maxDescription: MAX_SKILL_DESCRIPTION,
    };
  }

  /**
   * Stores the list as given, held to the rules: a name to type after `/` — lowercase, digits and hyphens, each used
   * once — instructions that are there, of any length, a project that is one of Settings' or every project.
   */
  async setSkills(list: Array<Record<string, unknown>>): Promise<{ skills: Skill[]; maxDescription: number }> {
    if (!Array.isArray(list)) throw new Error('The skills come as a list.');
    if (list.length > MAX_SKILLS) throw new Error(`There can be at most ${MAX_SKILLS} skills.`);
    const cfg = await this.settings.load();
    const folders = [cfg.project.rootDir, ...cfg.project.others.map((o) => o.rootDir)].filter((d) => d?.trim());
    const seen = new Set<string>();
    const skills: Skill[] = list.map((k) => {
      const name = String(k?.name ?? '').trim().toLowerCase();
      if (!SKILL_NAME.test(name)) throw new Error(`"${name || '(no name)'}" cannot be a skill's name: 2 to 40 lowercase letters, digits and hyphens, as typed after / — new-test, new-entity, db-migration.`);
      if (seen.has(name)) throw new Error(`Two skills are named "${name}". The name is how a message calls one, so each needs its own.`);
      seen.add(name);
      const description = String(k?.description ?? '').trim();
      if (description.length > MAX_SKILL_DESCRIPTION) throw new Error(`What "${name}" is for is longer than ${MAX_SKILL_DESCRIPTION} characters; one line is enough.`);
      const text = String(k?.text ?? '');
      if (!text.trim()) throw new Error(`The skill "${name}" has no instructions: write what the chat should know and do for this kind of task.`);
      const projectDir = String(k?.projectDir ?? '').trim();
      if (projectDir && !folders.some((f) => sameFolder(f, projectDir))) throw new Error(`The skill "${name}" is for ${projectDir}, which is not one of the projects in Settings.`);
      return { name, description, text, projectDir };
    });
    await this.settings.update((raw) => ({ ...raw, skills }));
    return await this.skills();
  }

  /** The skill a message calls, for the folder it works in: one for every project, or one for this one. */
  private async skillFor(asked: string, dir: string): Promise<Skill> {
    const name = asked.trim().replace(/^\//, '').toLowerCase();
    const { skills } = await this.skills();
    const fits = skills.filter((k) => !k.projectDir || (dir && sameFolder(k.projectDir, dir)));
    const found = fits.find((k) => k.name === name);
    if (found) return found;
    const other = skills.find((k) => k.name === name);
    if (other) throw new Error(`The skill "${name}" is for ${other.projectDir}, not for the folder this chat works in.`);
    throw new Error(`There is no skill called "${name}"${fits.length > 0 ? `; there are ${fits.map((k) => k.name).join(', ')}` : ''}. Skills are written in Settings → Skills.`);
  }

  /**
   * Back to before a message of the chat (2026-10-17): the folder put back exactly as it was just before that
   * message ran — branch, commit, uncommitted changes — and that message and every one after it taken out of the
   * conversation, because they did not happen. They stay on the record (`Session.rewound`), and the folder as it
   * was before going back is kept as a safety photograph. The Copilot conversation still holds them, so its next
   * message says what was undone. See `session/checkpoint.ts`.
   */
  async chatRewind(threadId: string, taskId: string): Promise<{ ok: boolean; problem?: string; message?: string; text?: string; safety?: string }> {
    await this.init();
    const session = await this.store.getSession(threadId);
    if (!session || session.kind !== 'chat') return { ok: false, problem: 'That conversation is not there any more.' };
    if (this.running.has(threadId) || session.status !== 'idle') return { ok: false, problem: 'The conversation is working. Stop it first, then go back.' };
    const at = session.tasks.findIndex((t) => t.id === taskId);
    if (at < 0) return { ok: false, problem: 'That message is not in the conversation.' };
    const task = session.tasks[at]!;
    // A message that never ran changed nothing: it is only taken out, with the ones after it.
    const firstRan = session.tasks.slice(at).find((t) => t.checkpoint);
    const dir = session.projectDir?.trim() || '';
    let safety: string | undefined;
    if (firstRan?.checkpoint) {
      const other = await this.runningIn(dir);
      if (other) return { ok: false, problem: `Session "${other.name}" is running in this folder. Stop it first.` };
      const done = await restoreCheckpoint(dir, firstRan.checkpoint);
      if (!done.ok) return { ok: false, problem: done.problem };
      safety = done.safety;
    }
    const removed = session.tasks.slice(at);
    const titles = removed.map((t) => `"${t.title}"`).join(', ');
    await this.store.updateSession(threadId, (s) => {
      s.tasks = s.tasks.slice(0, at);
      s.rewound = [...(s.rewound ?? []), { at: new Date().toISOString(), toBefore: taskId, safety: safety ?? '', tasks: removed }];
      s.rewindNote =
        `The operator went back to before the message "${task.title}": the folder is again exactly as it was then` +
        `${firstRan?.checkpoint ? ` (on ${firstRan.checkpoint.branch || 'commit ' + firstRan.checkpoint.head.slice(0, 8)})` : ''}, and that message and the ` +
        `${removed.length > 1 ? `${removed.length - 1} after it were` : 'ones after it were'} undone (${titles}). Forget what was done for them; ` +
        'work from the folder as it is now.';
    });
    const message = `went back to before "${task.title}": ${removed.length} message(s) taken out${safety ? `, the folder as it was is kept as ${safety.slice(0, 8)}` : ''}`;
    const cfg = await this.settings.load();
    await appendSessionLog(cfg.resolved.runsDir, threadId, { type: 'chat-rewind', message, data: { taskId, removed: removed.map((t) => t.id), safety } }).catch(() => undefined);
    this.bus.publish({ sessionId: threadId, type: 'chat-rewind', level: 'info', message, data: { taskId, removed: removed.length, safety } });
    return { ok: true, message, text: task.prompt, ...(safety ? { safety } : {}) };
  }

  // --- the repository, read-only, for the workbench (2026-10-14) ------------------------------

  // --- Kerrigan: what happened, and her changes to existing work (2026-10-14) ---------------------

  // --- approvals ------------------------------------------------------------------------

  /**
   * Asks the operator to choose the model in the Copilot window, when the runner could not (operator's
   * request, 2026-10-06). It waits on the approvals card like a held step, in every mode, until it is
   * answered or the run is stopped.
   */
  askModelHelp(
    ask: { sessionId: string; asked: string; shown: string | null; why: string; tries: number; manual?: boolean; review?: boolean; role?: 'lead' | 'worker'; actor?: Actor },
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
        description: `${ask.asked ? `Choose "${ask.asked}" in the Copilot window` : 'Choose the model in the Copilot window'}${ask.review ? ' for the review' : ask.role ? ` for the ${ask.role}` : ''}`,
        createdAt: new Date().toISOString(),
        ...(ask.actor ? { actor: ask.actor } : {}),
        model: { asked: ask.asked, shown: ask.shown, why: ask.why, tries: ask.tries, ...(ask.manual ? { manual: true } : {}), ...(ask.review ? { review: true } : {}), ...(ask.role ? { role: ask.role } : {}) },
      };
      this.waiting.set(approval.id, {
        approval,
        resolve: (d) => resolveAnswer(d.action === 'run' ? 'recheck' : d.action === 'skip' ? 'continue' : 'stop'),
      });
      this.bus.publish({ sessionId: ask.sessionId, type: 'approval-requested', level: 'warn',
        message: `choose "${ask.asked}" in the Copilot window, then answer on the card`, data: { approvalId: approval.id, model: approval.model } });
    });
  }

  /**
   * The lead's question for the operator (two chats, 2026-10-20): what only a person can decide, on a card in the
   * conversation, waiting in every mode — an unattended run included, since nobody else can answer it — until it is
   * answered or the task is stopped.
   */
  askLeadQuestion(
    ask: { sessionId: string; taskId: string; question: string; why?: string; options: string[]; commands?: Array<string | null>; actor?: Actor },
    signal: AbortSignal,
  ): Promise<{ answer: string } | 'stop'> {
    return new Promise((resolveAnswer) => {
      if (signal.aborted) {
        resolveAnswer('stop');
        return;
      }
      const approval: PendingApproval = {
        id: newId('a-'),
        sessionId: ask.sessionId,
        taskId: ask.taskId,
        stepId: 0,
        description: `${(ask.actor ?? 'lead') === 'lead' ? 'The lead asks' : 'The chat asks'}: ${ask.question}`,
        createdAt: new Date().toISOString(),
        // The lead's, or since 2026-10-23 the chat's own (plan mode's or the worker's).
        actor: ask.actor ?? 'lead',
        question: { text: ask.question, ...(ask.why ? { why: ask.why } : {}), options: ask.options, ...(ask.commands?.some(Boolean) ? { commands: ask.commands } : {}) },
      };
      this.waiting.set(approval.id, {
        approval,
        // A stop, the end of the run, "abort" on the card: the task stops at the question.
        resolve: () => resolveAnswer('stop'),
        resolveAnswer,
      });
      this.bus.publish({ sessionId: ask.sessionId, taskId: ask.taskId, type: 'approval-requested', level: 'warn',
        message: `the lead asks the operator: ${ask.question}`, data: { approvalId: approval.id, question: approval.question } });
    });
  }

  /** The operator's answer to the lead's question. */
  /**
   * A subtask of two chats that failed for a technical reason, put to the operator (2026-10-25): a card under the subtask
   * with why, which attempt it was, what it left, and the choices; it waits until one is chosen, or the task is stopped.
   * Answered with `answerRetry`; "abort" on the card, a Stop or the end of the run stop the task.
   */
  askSubtaskRetry(ask: { sessionId: string; taskId: string; retry: NonNullable<PendingApproval['retry']> }, signal: AbortSignal): Promise<RetryChoice | 'stop'> {
    return new Promise((resolveRetry) => {
      if (signal.aborted) {
        resolveRetry('stop');
        return;
      }
      const approval: PendingApproval = {
        id: newId('a-'),
        sessionId: ask.sessionId,
        taskId: ask.taskId,
        stepId: 0,
        description: `Subtask ${ask.retry.n} (${ask.retry.title}) did not finish, attempt ${ask.retry.attempt} of ${ask.retry.maxAttempts}: ${ask.retry.reason || ask.retry.category}`,
        createdAt: new Date().toISOString(),
        actor: 'lead',
        retry: ask.retry,
      };
      this.waiting.set(approval.id, { approval, resolve: () => resolveRetry('stop'), resolveRetry });
      this.bus.publish({ sessionId: ask.sessionId, taskId: ask.taskId, type: 'approval-requested', level: 'warn',
        message: `subtask ${ask.retry.n} did not finish (attempt ${ask.retry.attempt} of ${ask.retry.maxAttempts}): the operator is asked what to do`, data: { approvalId: approval.id, retry: ask.retry } });
    });
  }

  /** The operator's choice for a subtask that failed for a technical reason: one of the card's own. */
  answerRetry(approvalId: string, choice: string): { ok: boolean; problem?: string } {
    const w = this.waiting.get(approvalId);
    if (!w?.resolveRetry || !w.approval.retry) return { ok: false, problem: 'No subtask is waiting for a choice under that id.' };
    if (!w.approval.retry.choices.includes(choice as RetryChoice)) return { ok: false, problem: `"${choice}" is not one of this card's choices: ${w.approval.retry.choices.join(', ')}.` };
    this.waiting.delete(approvalId);
    w.resolveRetry(choice as RetryChoice);
    this.bus.publish({ sessionId: w.approval.sessionId, taskId: w.approval.taskId, type: 'approval-decided', level: 'info',
      message: `the operator chose for subtask ${w.approval.retry.n}: ${choice}`, data: { approvalId, retry: choice } });
    return { ok: true };
  }

  /**
   * Two chats, after a Stop (2026-10-25): "do not start a task again by itself after Stop; when the operator carries on in
   * the same conversation, let a chosen failed subtask be tried again, with the plan and the reports kept". The message
   * is carried on with that subtask first (`TaskContinuation.retrySubtask`), then the lead goes on; the run is started
   * as a message of the chat is.
   */
  async chatRetrySubtask(threadId: string, taskId: string, n: number, fresh: boolean): Promise<StartReply> {
    await this.init();
    const session = await this.store.getSession(threadId);
    if (!session || session.kind !== 'chat') throw new Error('That conversation is not there any more.');
    if (this.running.has(threadId)) throw new Error('The conversation is working: stop it first, or let it finish.');
    const task = session.tasks.find((t) => t.id === taskId);
    if (!task?.lead) throw new Error('That message is not one of two chats.');
    if (task.status !== 'aborted') throw new Error('Only a message that was stopped has a subtask to try again: the others carry on by themselves, or end.');
    const sub = [...task.lead.rounds].reverse().find((r) => r.subtask?.n === n)?.subtask;
    if (!sub) throw new Error(`The message has no subtask ${n}.`);
    const last = sub.attempts?.at(-1);
    if (last?.status === 'done') throw new Error(`Subtask ${n} was done; it is not done again.`);
    await this.store.rerunTask(threadId, taskId, {}, { fromAttempt: task.attempt ?? 1, stoppedBecause: task.reason, how: 'stopped', retrySubtask: { n, ...(fresh ? { fresh: true } : {}) } });
    const cfg = await this.settings.load();
    return await this.start(threadId, cfg.execution.mode);
  }

  answerQuestion(approvalId: string, text: string): { ok: boolean; problem?: string } {
    const w = this.waiting.get(approvalId);
    if (!w?.resolveAnswer) return { ok: false, problem: 'No question of the lead is waiting under that id.' };
    if (!text.trim()) return { ok: false, problem: 'Write the answer first.' };
    this.waiting.delete(approvalId);
    w.resolveAnswer({ answer: text.trim() });
    this.bus.publish({ sessionId: w.approval.sessionId, taskId: w.approval.taskId, type: 'approval-decided', level: 'info',
      message: 'the operator answered the lead', data: { approvalId, question: true } });
    return { ok: true };
  }

  /**
   * A task's plan, put to the operator (plan mode `approve`, in a run that asks before each command): it
   * waits on the approvals card, on every page, until it is approved, sent back for another, or the task
   * is stopped. See `PlanMode`.
   */
  askPlanApproval(ask: { sessionId: string; taskId: string; title: string; plan: TaskPlan; actor?: Actor }, signal: AbortSignal): Promise<{ decision: 'approve' | 'revise' | 'stop'; note?: string }> {
    return new Promise((resolveAnswer) => {
      if (signal.aborted) {
        resolveAnswer({ decision: 'stop' });
        return;
      }
      const approval: PendingApproval = {
        id: newId('a-'),
        sessionId: ask.sessionId,
        taskId: ask.taskId,
        stepId: 0,
        description: `The plan of "${ask.title}" (version ${ask.plan.version})`,
        createdAt: new Date().toISOString(),
        // The chat that wrote it in plan mode, or the lead's plan of two chats.
        actor: ask.actor ?? 'plan',
        plan: { title: ask.title, plan: ask.plan },
      };
      this.waiting.set(approval.id, {
        approval,
        resolve: (d) => resolveAnswer(d.action === 'run' ? { decision: 'approve' } : { decision: 'stop' }),
        resolvePlan: resolveAnswer,
      });
      this.bus.publish({ sessionId: ask.sessionId, taskId: ask.taskId, type: 'approval-requested', level: 'warn',
        message: `the plan of "${ask.title}" (version ${ask.plan.version}) is waiting for you to approve it`, data: { approvalId: approval.id, plan: true } });
    });
  }

  /**
   * Answers a plan waiting for approval: approve it (with a note the chat is given beside it), ask for
   * another (saying what to change), or stop the task.
   */
  decidePlan(approvalId: string, action: 'approve' | 'revise' | 'stop', note?: string): { ok: boolean; problem?: string } {
    const w = this.waiting.get(approvalId);
    if (!w || !w.resolvePlan) return { ok: false, problem: 'That plan is not waiting any more.' };
    const text = (note ?? '').trim();
    if (action === 'revise' && !text) return { ok: false, problem: 'Say what to change in the plan, so the chat knows what the next one must do differently.' };
    if (text.length > MAX_INSTRUCTION_CHARS) return { ok: false, problem: `The note is ${text.length} characters; it can be at most ${MAX_INSTRUCTION_CHARS}.` };
    this.waiting.delete(approvalId);
    w.resolvePlan({ decision: action, ...(text ? { note: text } : {}) });
    this.bus.publish({ sessionId: w.approval.sessionId, taskId: w.approval.taskId, type: 'approval-decided', level: 'info',
      message: `plan: ${action}${text ? ' (with a note)' : ''}`, data: { approvalId, action, plan: true } });
    return { ok: true };
  }

  /** What waits for the operator; of one session, its worker's included (two chats: they are asked in its conversation). */
  pendingApprovals(sessionId?: string): PendingApproval[] {
    return [...this.waiting.values()].map((w) => w.approval).filter((a) => !sessionId || a.sessionId === sessionId || this.workerLeads.get(a.sessionId) === sessionId);
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

    if (action === 'run-all') this.setRunMode(this.runKey(w.approval.sessionId), 'unattended');

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
    this.bus.publish({
      sessionId,
      type: 'run-mode-changed',
      level: mode === 'unattended' ? 'warn' : 'info',
      message:
        mode === 'unattended'
          ? 'the rest of this run will execute without asking; denied patterns are still refused'
          : 'every further step will be shown for approval again',
      data: { mode },
    });

    if (mode === 'unattended') {
      for (const [id, w] of this.waiting) {
        if (this.runKey(w.approval.sessionId) !== sessionId) continue;
        // A fetch waits for its own answer: "run the rest without asking" is not an answer to it; nor is a question.
        if (w.approval.network || w.approval.model || w.approval.question || w.approval.plan) continue;
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
        if (!held && this.running.get(this.runKey(ctx.sessionId ?? ''))?.mode === 'unattended') {
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
          ...(ctx.actor ? { actor: ctx.actor } : {}),
          ...(held?.network ? { network: held.network } : {}),
          ...(held?.platform ? { platform: held.platform } : {}),
        };
        this.waiting.set(approval.id, { approval, resolve: resolvePromise });
        this.bus.publish({ sessionId: approval.sessionId, taskId: approval.taskId, type: 'approval-requested', level: 'warn',
          message: held
            ? `held for the operator — ${[held.platform ? `it reaches ${held.platform} with the operator's access` : '', held.network ?? ''].filter(Boolean).join('; ')}: ${approval.description}`
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

  // --- version control ----------------------------------------------------------------------

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
   * Why the session's next task cannot start because it contradicts itself — read-only and scoped, or
   * a file check that needs a change the task may not make — or null. The part of the contract that
   * depends on the branch the runner will choose is checked at the task's start, once that is known.
   */
  private async contractRefusal(session: Session, onlyTasks?: ReadonlySet<string>, afterOthers = false): Promise<string | null> {
    const next = queuedToRun(session, onlyTasks)[0];
    if (!next) return null;
    const conflicts = await this.contractFor(session, next, afterOthers);
    return conflicts.length === 0
      ? null
      : `The task "${next.title}" of "${session.name}" contradicts itself, so it was not started and stays queued: ${conflicts.map((c) => c.text).join(' ')} Press "Run this task" on it, in the register or on the session's page, and the smallest change that removes it is offered there; or change the prompt, the checks, the scope or read-only on the session's page, and start again.`;
  }

  /**
   * Each way the task contradicts itself, judged as its next attempt would start, with the ways out
   * (see `ContractFix`). The one judgement behind the refusal at a run's start and behind the fixes
   * the pages offer, so a fix offered is a fix for the refusal the operator was shown.
   */
  private async contractFor(session: Session, next: Task, afterOthers = false): Promise<ContractConflict[]> {
    const cfg = await this.settings.load();
    const work = workingDirFor(session, cfg.resolved.cwd);
    if (isWorkingDirProblem(work)) return [];
    /*
     * The branch the task will be on, where that is known before the run: so a check that expects another
     * branch is refused here too, not after the browser opened and a branch was cut (live run 2026-10-04).
     */
    const prefix = session.vcs?.branchPrefix || 'cop/';
    // By the runner's own rules for the attempt's branch; a task that has run is judged as the attempt it would be queued as.
    const branch = !session.vcs?.enabled
      ? undefined
      : session.vcs.startFrom === 'existing-branch'
        ? session.vcs.existingBranch?.trim() || undefined
        : session.vcs.branchMode === 'per-session'
          ? sessionBranchName(session)
          : nextAttemptBranch({ ...session, vcs: { ...session.vcs, branchPrefix: prefix } }, next);
    const files = await this.contractTree(session, afterOthers).catch((): ContractTree => 'unknown');
    // Input files are carried onto a first start from their last capture: not judged before it (see `contract.ts`).
    const carried = !session.vcsBaseCommit ? inputSettings(session.vcs)?.patterns : undefined;
    const conflicts = await contractConflictsWithFixes(next, work.cwd, repoDirOf(session) || work.cwd, { branch, files, carried }).catch(() => [] as ContractConflict[]);
    // A plan check the runner refuses for its own command line can never run: the task could never pass.
    const roots = sessionRoots(work.cwd, [cfg.project.rootDir, ...cfg.project.others.map((o) => o.rootDir)]);
    const shell = preferredShell(cfg.execution.defaultShell);
    for (const c of next.checks ?? []) {
      const run = c.run?.trim();
      if (!run) continue;
      const why = lineRefusal(run, c.shell ?? shell, c.cwd ? resolve(work.cwd, c.cwd) : work.cwd, cfg.execution, roots);
      if (why) {
        conflicts.push({
          text: `The check "${c.name}" is refused by the runner for its own command line, so it can never run and the task could never pass: ${checkRefusalForOperator(why)}.`,
          fixes: [{ kind: 'drop-check', check: c.name }],
        });
      }
    }
    return conflicts;
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
    // A remote branch chosen in the start window: its remote-tracking branch, as that window fetched it.
    const ref = how === 'branch' ? baseRefOf(session.vcs).ref : `refs/heads/${branch}`;
    // Brought up to its remote first: what that brings is known only then.
    if (session.vcs?.updateFromRemote !== false && !(how === 'branch' && session.vcs?.baseRemote)) {
      const remotes = await git(repo, ['remote']);
      if (!remotes.ok || remotes.stdout.trim() !== '') return 'unknown';
    }
    const tip = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
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
    /*
     * The branch each folder is on now (operator, 2026-10-20: "show which branch is chosen"), read from git each
     * time, since the operator switches it by hand and the chat works on whatever is checked out.
     */
    const entry = async (name: string, dir: string, level2: string, readOnly: boolean): Promise<ProjectEntry> => {
      const problem = dir ? repoUnusableReason(dir) : 'no folder';
      const branch = dir && problem === null ? await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null) : null;
      return {
        name,
        rootDir: dir,
        repoOk: dir !== '' && problem === null,
        ...(dir && problem ? { repoProblem: problem } : {}),
        ...(branch?.ok && branch.stdout ? { branch: branch.stdout } : {}),
        level2,
        readOnly,
      };
    };
    const main = await entry((cfg.project?.name ?? '').trim(), rootDir, cfg.project?.level2 ?? '', cfg.project?.readOnly === true);
    const others = await Promise.all((cfg.project?.others ?? []).map((o) => entry(o.name, o.rootDir, o.level2 ?? '', o.readOnly === true)));
    return { ...main, others };
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
    level2?: string;
    readOnly?: boolean;
    others?: Array<{ name: string; rootDir: string; level2?: string; readOnly?: boolean }>;
  }): Promise<ProjectDefault> {
    // Worked out from the file in its turn (see `Settings.update`), so a model chosen at the same
    // moment is kept, and a refusal below leaves the file as it was.
    await this.settings.update((raw) => {
      const current = ((raw.project as Record<string, unknown>) ?? {}) as {
        rootDir?: string;
        name?: string;
        level2?: string;
        readOnly?: boolean;
        others?: Array<{ name: string; rootDir: string; level2?: string; readOnly?: boolean }>;
      };
      const rootDir = patch.rootDir !== undefined ? patch.rootDir.trim() : (current.rootDir ?? '').trim();
      const readOnly = patch.readOnly !== undefined ? patch.readOnly === true : current.readOnly === true;
      const name = patch.name !== undefined ? patch.name.trim() : (current.name ?? '').trim();
      const level2 = patch.level2 !== undefined ? patch.level2 : (current.level2 ?? '');
      // Each goes into Kerrigan whole, and she is pasted into a chat: bounded, so one project cannot crowd out the rest.
      const tooLong = [{ name: name || rootDir, level2 }, ...(patch.others ?? [])].find((o) => (o.level2 ?? '').length > MAX_PROJECT_LEVEL2);
      if (tooLong) throw new Error(`The level 2 of "${tooLong.name}" is longer than ${MAX_PROJECT_LEVEL2.toLocaleString('en')} characters; keep it to what a chat needs to know about the project.`);
      if (rootDir && !existsSync(rootDir)) throw new Error(`The folder ${rootDir} does not exist on this machine.`);

      /*
       * A project's level 2 is kept with it when the list comes without one — renamed or moved, or saved by a page that
       * does not know the field — matched by its folder, then by its name.
       */
      const before = current.others ?? [];
      const others = (patch.others ?? before).map((o) => {
        const was = before.find((b) => sameFolder(b.rootDir ?? '', o.rootDir ?? '')) ?? before.find((b) => (b.name ?? '').trim() === (o.name ?? '').trim());
        return {
          name: (o.name ?? '').trim(),
          rootDir: (o.rootDir ?? '').trim(),
          level2: o.level2 !== undefined ? o.level2 : (was?.level2 ?? ''),
          // Kept like the level 2 when the list comes without it: a page that does not know the box must not clear it.
          readOnly: o.readOnly !== undefined ? o.readOnly === true : was?.readOnly === true,
        };
      });
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
      return { ...raw, project: { ...rest, rootDir, name, level2, readOnly, others } };
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
    | (ModelCatalogue & { defaultModel: string; defaultLeadModel: string; defaultReviewModel: string })
    | { defaultModel: string; defaultLeadModel: string; defaultReviewModel: string; options: []; readAt: null }
  > {
    await this.init();
    const cfg = await this.settings.load();
    const cached = await this.store.getModels();
    const defaultModel = cfg.copilot.defaultModel ?? '';
    const defaultReviewModel = cfg.copilot.defaultReviewModel ?? '';
    const defaultLeadModel = cfg.copilot.defaultLeadModel ?? '';
    return cached ? { ...cached, defaultModel, defaultLeadModel, defaultReviewModel } : { defaultModel, defaultLeadModel, defaultReviewModel, options: [], readAt: null };
  }

  /**
   * Sets the model a new session's independent review starts on. An empty name clears it,
   * which means the review runs on the session's own model — the weaker choice, and the one
   * every session had before this existed.
   */
  /** Sets the model the lead of two chats starts on (2026-10-23). An empty name leaves its chat on whatever it is. */
  async setDefaultLeadModel(name: string): Promise<{ defaultLeadModel: string }> {
    await this.init();
    await this.settings.update((raw) => ({ ...raw, copilot: { ...((raw.copilot as Record<string, unknown>) ?? {}), defaultLeadModel: name.trim() } }));
    this.bus.publish({
      sessionId: '*',
      type: 'default-lead-model-changed',
      level: 'info',
      message: name.trim() ? `the lead of two chats will start on ${name.trim()}` : 'the lead of two chats leaves the chat on its model',
    });
    return { defaultLeadModel: name.trim() };
  }

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
      await this.closeChatWindow('signing in needs the browser');
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
        // The rows' locator reads the names (Settings' own, 2026-10-24).
        ...pickerOptions(cfg),
      });
      await this.closeChatWindow('reading the models needs the browser');
      await transport.open();
      await transport.ensureSignedIn();
      const { options, current, note } = await transport.listModels();
      const catalogue: ModelCatalogue = { options, current: current ?? undefined, readAt: new Date().toISOString(), note };
      await this.store.saveModels(catalogue);
      // A saved choice the page now offers under another name follows it here, as a run does (see `modelMatch.ts`).
      const saved = cfg.copilot;
      const work = (saved.defaultModel ?? '').trim();
      const review = (saved.defaultReviewModel ?? '').trim();
      const lead = (saved.defaultLeadModel ?? '').trim();
      const workNow = work ? pageModelFor(work, options) : null;
      const reviewNow = review ? pageModelFor(review, options) : null;
      const leadNow = lead ? pageModelFor(lead, options) : null;
      if (workNow && !sameModel(workNow.name, work)) await this.setDefaultModel(workNow.name);
      if (reviewNow && !sameModel(reviewNow.name, review)) await this.setDefaultReviewModel(reviewNow.name);
      if (leadNow && !sameModel(leadNow.name, lead)) await this.setDefaultLeadModel(leadNow.name);
      return catalogue;
    } finally {
      await transport?.close().catch(() => undefined);
      this.releaseBrowser(claim.holder);
    }
  }

  // --- the registry ---------------------------------------------------------------------

  // --- environment ----------------------------------------------------------------------

  /** Opens the machine's own folder dialog and reports what was picked. */
  async browseFolder(start?: string): Promise<FolderPick> {
    return await pickFolder(start);
  }

  /**
   * The bot's folder chosen on the System page (operator, 2026-10-22): `dir`, or `null` for the default; with `copy`,
   * what is in the folder now goes there too. Read at the next start; refused while work goes on, for a clone, or for
   * a folder that cannot be the bot's.
   */
  async setHome(dir: string | null, copy: boolean): Promise<{ home: string; copied: string[]; kept: string[]; restart: true }> {
    const layout = this.layout;
    if (layout.mode !== 'package') throw new Error('A clone keeps its records in the clone (data/ and runs/); start it with COP_DATA_DIR set to keep them elsewhere.');
    if (layout.homeFrom === 'env') throw new Error(`COP_HOME places the bot's folder (${layout.homeDir}); change or remove it where it is set.`);
    if (this.running.size > 0) throw new Error('Work is going on: stop it, or let it end, before moving the bot\'s folder.');
    if (dir !== null) {
      const refused = homeRefusal(dir, layout);
      if (refused) throw new Error(refused);
    }
    if (copy) {
      // Its files are in use while its window is open: closed first, as another run would close it.
      await this.closeChatWindow('the bot\'s folder is being copied');
      const cfg = await this.settings.load();
      const holders = findEdgeUsingProfile(cfg.resolved.profileDir);
      if (Array.isArray(holders) && holders.length > 0) throw new Error(`Edge has the bot's profile open (pid ${holders.slice(0, 4).map((h) => h.pid).join(', ')}): close that window, then copy.`);
    }
    /*
     * A profile the settings name in the folder left behind would stay there: it follows the folder instead. Before the
     * copy, so the settings copied over say so too; for this process it is the same folder, the default one.
     */
    await this.settings.update((raw) => {
      const copilot = (raw.copilot as Record<string, unknown> | undefined) ?? {};
      if (typeof copilot.profileDir === 'string' && resolve(copilot.profileDir).toLowerCase() === resolve(join(layout.homeDir, 'edge-profile')).toLowerCase()) {
        const { profileDir: _gone, ...rest } = copilot;
        return { ...raw, copilot: rest };
      }
      return raw;
    });
    const chosen = chooseHome(layout, dir, copy);
    console.log(`[home] the bot's folder will be ${chosen.home} from its next start${chosen.copied.length ? ` (copied: ${chosen.copied.join(', ')})` : ''}`);
    return { ...chosen, restart: true };
  }

  async doctor(): Promise<Record<string, unknown>> {
    const cfg = await this.settings.load();
    const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
    const holders = findEdgeUsingProfile(cfg.resolved.profileDir);
    // Whose Edge it is: the bot's own — a run's, or its chat window kept open between messages — or another's.
    const holder = profileHolder(holders, process.pid);
    const layout = this.layout;
    return {
      // Which copilot-operator this is: `cop --version` without a terminal.
      version: botVersion(),
      node: process.versions.node,
      edge: edge ?? null,
      profileDir: cfg.resolved.profileDir,
      profileExists: existsSync(cfg.resolved.profileDir),
      profileHeldBy: Array.isArray(holders) ? holders.map((h) => h.pid) : 'unknown',
      /*
       * Whose Edge holds the profile (2026-10-22). While a run is going, Edge is open on it by the runner; between
       * messages the chat's window stays open by the bot too, and the warning "close this Edge window, a run would
       * fail" was shown then, when it was false: it counted only runs. An Edge the bot's API started is its own.
       */
      profileHolder: holder === 'own' ? (this.running.size > 0 ? 'own-run' : 'own-window') : holder,
      botRunning: this.running.size > 0,
      // The bot's folder (2026-10-22): where it is, where it would be by default, and what was chosen for the next start.
      install: layout.mode,
      home: layout.homeDir,
      homeFrom: layout.homeFrom,
      homeDefault: layout.mode === 'package' ? defaultHome() : null,
      homeNext: layout.mode === 'package' && layout.homeFrom !== 'env' ? (chosenHome() ?? defaultHome()) : null,
      homeMovedFrom: movedFrom(layout.homeDir),
      settingsFile: join(this.dataDir, 'settings.json'),
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

