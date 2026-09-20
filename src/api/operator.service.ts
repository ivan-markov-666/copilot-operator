/**
 * Everything the web UI can do, in one service.
 *
 * The runner itself does not know it is being driven from a browser. This service supplies
 * the three things that differ from the terminal: where approvals come from (a pending list
 * the UI resolves), where events go (the bus, streamed as SSE), and how a run is stopped
 * (an AbortController per session).
 */
import { Injectable } from '@nestjs/common';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SessionStore, DEFAULT_VCS, DEFAULT_REVIEW } from '../session/store.js';
import { EventBus } from '../session/events.js';
import type {
  Session,
  Task,
  Level2Preset,
  PendingApproval,
  SessionEvent,
  MirrorSettings,
  ModelCatalogue,
  ReviewSettings,
  TaskReview,
  TaskRunGroup,
  VersionControl,
} from '../session/model.js';
import { newId, tidyVcsPlan } from '../session/model.js';
import { runSession, openBrowser } from '../orchestrator/taskRunner.js';
import { buildExport, type ExportVariant } from '../session/exportRecord.js';
import { buildDebugExport } from '../session/debugExport.js';
import { checkPlan, type Plan, type PlanCheck, type PlanIssue, type PlanSummary } from '../plan/schema.js';
import { planBrief, type BriefOptions } from '../plan/brief.js';
import { importPlan, plannedSessionSignature, taskSignature, type ImportResult } from '../plan/importPlan.js';
import { vcsPreflight, restorePreview, restoreToBase, sessionBranches, type RestorePreview, type SessionBranches } from '../vcs/taskVcs.js';
import { gitAvailable, repoUnusableReason } from '../vcs/git.js';
import { makeAuthorizer, unattendedAuthorizer, type StepAuthorizer } from '../exec/authorizer.js';
import type { PolicyDecision } from '../exec/policy.js';
import { listSelectableDirs, collectFiles, findSelectionConflicts, describeConflicts, DEFAULT_IGNORE_DIRS } from '../context/projectMirror.js';
import { pickFolder, type FolderPick } from './folderPicker.js';
import { findEdgeUsingProfile } from '../transport/profileLock.js';
import { CopilotTransport } from '../transport/copilotTransport.js';
import { resolveDesktopDir, desktopIsSynced } from '../context/contextFiles.js';
import { Settings } from './settings.js';
import type { ResolvedConfig } from '../config/schema.js';

/**
 * A run in progress. `mode` is mutable on purpose: the operator can decide, in the middle of
 * a run, that they have seen enough and the rest should not stop for them. Nothing else about
 * the run changes, and the deny list keeps applying either way, because that gate is in the
 * policy and runs before anyone is asked.
 */
type Running = { controller: AbortController; startedAt: string; mode: 'confirm' | 'unattended' };

type Waiting = { approval: PendingApproval; resolve: (d: PolicyDecision) => void };

/** How one finished run went, counted over the tasks that were queued when it started. */
export type RunTally = {
  ran: number;
  failed: number;
  /** Tasks that never started, because the chain stopped or the operator did. */
  leftQueued: number;
  failedTitles: string[];
  /** Set when the run itself threw, rather than a task inside it failing. */
  error?: string;
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
  finishedAt?: string;
  mode: 'confirm' | 'unattended';
  /** `stop` gives up on the rest when a session fails; `continue` works through them all. */
  onFailure: 'stop' | 'continue';
  stopping: boolean;
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
  /** How the original run was started, which is how this one will be unless told otherwise. */
  mode: 'confirm' | 'unattended';
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
  }>;
};

@Injectable()
export class OperatorService {
  readonly projectRoot = resolve(process.env.COP_PROJECT_ROOT ?? process.cwd());
  readonly dataDir = resolve(process.env.COP_DATA_DIR ?? join(this.projectRoot, 'data'));
  readonly settings = new Settings(this.projectRoot, this.dataDir);
  readonly store = new SessionStore(this.dataDir, join(this.projectRoot, 'prompts', 'level1.md'));
  readonly bus = new EventBus();

  private readonly running = new Map<string, Running>();
  private readonly waiting = new Map<string, Waiting>();
  /** The batch in progress, or the last one that finished. At most one ever exists. */
  private batch: BatchState | null = null;
  private ready: Promise<void> | null = null;
  /** One model read at a time: it launches a browser and holds the profile lock. */
  private readingModels = false;

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
      }
      if (recovered.length > 0) {
        console.log(`[api] closed ${recovered.length} task(s) left unfinished by an earlier run`);
      }
    })();
    return this.ready;
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

  // --- sessions and tasks ---------------------------------------------------------------

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

  async createSession(name: string, mirror?: Partial<MirrorSettings>): Promise<Session> {
    await this.init();
    if (mirror) assertMirrorIsCoherent(mirror);
    const session = await this.store.createSession(name, mirror);

    // A new session starts on the standing choice, if there is one. It is copied onto the
    // session rather than read at run time, so changing the default later cannot silently
    // change what an existing session does.
    const cfg = await this.settings.load();
    const defaultModel = (cfg.copilot.defaultModel ?? '').trim();
    const projectDir = (cfg.project?.rootDir ?? '').trim();
    if (!defaultModel && !projectDir) return session;

    return await this.store.updateSession(session.id, (s) => {
      if (defaultModel) s.model = defaultModel;
      if (projectDir) {
        // Both fields, because they answer different questions about the same folder: where the
        // files are and where the branches go. Neither is switched on by being filled in.
        if (!s.mirror.rootDir.trim()) s.mirror.rootDir = projectDir;
        if (s.vcs && !s.vcs.repoDir.trim()) s.vcs.repoDir = projectDir;
      }
    });
  }

  async updateSession(
    id: string,
    patch: {
      name?: string;
      model?: string;
      onFailure?: 'stop' | 'continue';
      conversationGroup?: string;
      mirror?: Partial<MirrorSettings>;
      vcs?: Partial<VersionControl>;
      review?: Partial<ReviewSettings>;
    },
  ): Promise<Session> {
    await this.init();
    return await this.store.updateSession(id, (s) => {
      if (patch.name !== undefined) s.name = patch.name.trim() || s.name;
      if (patch.onFailure === 'stop' || patch.onFailure === 'continue') s.onFailure = patch.onFailure;
      // An empty string is a real choice here: it means "leave the chat on whatever it is".
      if (patch.model !== undefined) s.model = patch.model.trim() || undefined;
      // The same for the group: clearing it gives this session its conversation back. It does
      // not move the conversation it is already in; that history is where it is.
      if (patch.conversationGroup !== undefined) s.conversationGroup = patch.conversationGroup.trim() || undefined;
      if (patch.review) {
        // Empty model means "the session's own", which is a real choice and not a missing one.
        const merged = { ...DEFAULT_REVIEW, ...s.review, ...patch.review };
        s.review = { enabled: merged.enabled !== false, model: (merged.model ?? '').trim() };
      }
      if (patch.mirror) {
        const merged = { ...s.mirror, ...patch.mirror };
        assertMirrorIsCoherent(merged);
        s.mirror = merged;
      }
      if (patch.vcs) {
        const merged = { ...DEFAULT_VCS, ...s.vcs, ...patch.vcs };
        // A prefix is what makes the bot's branches recognisable in `git branch`, so an empty
        // one is treated as "I did not mean to change this" rather than as a choice.
        merged.branchPrefix = merged.branchPrefix.trim() || DEFAULT_VCS.branchPrefix;
        merged.repoDir = merged.repoDir.trim();
        if (merged.enabled) {
          const reason = repoUnusableReason(merged.repoDir || s.mirror.rootDir || '');
          if (reason) throw new Error(reason);
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
    patch: Partial<Pick<Task, 'title' | 'level2' | 'prompt' | 'vcsPlan' | 'checks'>>,
  ): Promise<Task> {
    await this.init();
    return await this.store.updateTask(sessionId, taskId, (t) => {
      if (t.status !== 'queued') throw new Error('Only a queued task can be edited.');
      if (patch.title !== undefined) t.title = patch.title;
      if (patch.level2 !== undefined) t.level2 = patch.level2;
      if (patch.prompt !== undefined) t.prompt = patch.prompt;
      if (patch.vcsPlan !== undefined) t.vcsPlan = tidyVcsPlan(patch.vcsPlan);
      if (patch.checks !== undefined) t.checks = patch.checks.filter((c) => c.name.trim() !== '');
    });
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
  async rerunTask(
    sessionId: string,
    taskId: string,
    patch: Partial<Pick<Task, 'title' | 'level2' | 'prompt' | 'vcsPlan' | 'checks'>> = {},
  ): Promise<Task> {
    await this.init();
    const task = await this.store.rerunTask(sessionId, taskId, patch);
    this.bus.publish({
      sessionId,
      taskId,
      type: 'task-requeued',
      level: 'info',
      message: `"${task.title}" is queued again (attempt ${task.attempt ?? 1})`,
      data: { attempt: task.attempt },
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

  /** Files a task produced, so the UI can list reports and downloaded scripts. */
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

  // --- running --------------------------------------------------------------------------

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /**
   * Starts the session's queued tasks in the background. Returns immediately; progress
   * arrives on the event stream. One run per session at a time.
   */
  async start(sessionId: string, mode: 'confirm' | 'unattended' = 'confirm'): Promise<{ started: boolean; reason?: string }> {
    // One conversation at a time is not a policy, it is the browser profile: a second run
    // does not get a second browser, it gets an error about a closed one. A batch already
    // holds that turn, so a single session asking for it now is refused where the reason can
    // still be read, rather than three minutes later in a stack trace.
    if (this.batch?.running) return { started: false, reason: 'a batch of sessions is running' };
    const runGroup = { id: newId('r-'), startedAt: new Date().toISOString(), sessions: 1 };
    // A run of one is still a run, and it records the same thing a batch does, so that going
    // back and starting again from a task works the same whether one session was started or six.
    await this.store.updateSession(sessionId, (s) => {
      s.runGroup = {
        ...runGroup,
        order: 0,
        taskIds: s.tasks.filter((t) => t.status === 'queued').map((t) => t.id),
        mode,
        onFailure: s.onFailure === 'continue' ? 'continue' : 'stop',
      };
    });
    const begun = await this.beginRun(sessionId, mode, undefined, runGroup);
    return { started: begun.started, reason: begun.reason };
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
    transport?: CopilotTransport,
    /** The press of a start button this belongs to, stamped onto every task it reaches. */
    runGroup?: TaskRunGroup,
  ): Promise<{ started: boolean; reason?: string; done: Promise<RunTally> }> {
    await this.init();
    const idle: RunTally = { ran: 0, failed: 0, leftQueued: 0, failedTitles: [] };
    if (this.running.has(sessionId)) return { started: false, reason: 'already running', done: Promise.resolve(idle) };
    const session = await this.store.getSession(sessionId);
    if (!session) return { started: false, reason: 'no such session', done: Promise.resolve(idle) };
    const queuedIds = session.tasks.filter((t) => t.status === 'queued').map((t) => t.id);
    if (queuedIds.length === 0) return { started: false, reason: 'no queued tasks', done: Promise.resolve(idle) };

    const cfg = await this.settings.load();
    const policy = {
      mode,
      denyPatterns: cfg.execution.denyPatterns,
      allowedScriptExtensions: cfg.execution.allowedScriptExtensions,
    };
    const controller = new AbortController();
    const authorizer: StepAuthorizer =
      mode === 'unattended' ? unattendedAuthorizer(policy) : this.webAuthorizer(policy, controller.signal);

    this.running.set(sessionId, { controller, startedAt: new Date().toISOString(), mode });
    this.bus.publish({ sessionId, type: 'run-requested', level: 'info', message: `starting in ${mode} mode` });

    const done = runSession(sessionId, {
      cfg: { ...cfg, execution: { ...cfg.execution, mode } } as ResolvedConfig,
      store: this.store,
      bus: this.bus,
      authorizer,
      signal: controller.signal,
      // The session decides whether its tasks are one chain or a set of independent checks.
      continueOnFailure: session.onFailure === 'continue',
      transport,
      runGroup,
    })
      .then(() => this.tally(sessionId, queuedIds))
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
        w.resolve({ action: 'abort', reason: 'stopped by the operator' });
        this.waiting.delete(id);
      }
    }
    await this.store.updateSession(sessionId, (s) => {
      s.status = 'stopping';
    });
    this.bus.publish({ sessionId, type: 'stop-requested', level: 'warn', message: 'stopping after the current step' });
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
  activity(): { running: boolean; sessions: number; batch: boolean } {
    return { running: this.running.size > 0, sessions: this.running.size, batch: this.batch?.running === true };
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
  ): Promise<{ started: boolean; reason?: string; batch?: BatchState }> {
    await this.init();
    if (this.batch?.running) return { started: false, reason: 'a batch is already running' };
    const wanted = [...new Set(sessionIds.map((s) => s.trim()).filter(Boolean))];
    if (wanted.length === 0) return { started: false, reason: 'no sessions were selected' };
    if (wanted.some((id) => this.running.has(id))) {
      return { started: false, reason: 'one of the selected sessions is already running on its own' };
    }

    const sessions: BatchSession[] = [];
    for (const id of wanted) {
      const s = await this.store.getSession(id);
      if (!s) {
        sessions.push({ sessionId: id, name: id, state: 'skipped', ran: 0, failed: 0, reason: 'no such session' });
        continue;
      }
      const queued = s.tasks.filter((t) => t.status === 'queued').length;
      sessions.push(
        queued === 0
          ? { sessionId: id, name: s.name, state: 'skipped', ran: 0, failed: 0, reason: 'nothing queued' }
          : { sessionId: id, name: s.name, state: 'waiting', ran: 0, failed: 0 },
      );
    }

    if (!sessions.some((s) => s.state === 'waiting')) {
      return { started: false, reason: 'none of the selected sessions has a queued task' };
    }

    // One model for the whole run, chosen here rather than opened on every session first. It
    // is written onto the sessions instead of being held for the run, so what the session says
    // it will use and what it used are the same thing afterwards — including for anyone who
    // opens one of them tomorrow and wonders which model produced that summary.
    const wantedModel = model?.trim();
    const wantedReviewModel = reviewModel?.trim();
    if (wantedModel || wantedReviewModel) {
      for (const entry of sessions) {
        if (entry.state !== 'waiting') continue;
        await this.store.updateSession(entry.sessionId, (s) => {
          if (wantedModel) s.model = wantedModel;
          // Only the model is set here, never whether the review happens: a run panel is about
          // this run, and silently switching a session's review on or off from it would be a
          // change to the session that outlives the run.
          if (wantedReviewModel) s.review = { ...DEFAULT_REVIEW, ...s.review, model: wantedReviewModel };
        });
      }
    }

    this.batch = {
      id: newId('b-'),
      startedAt: new Date().toISOString(),
      mode,
      onFailure,
      stopping: false,
      running: true,
      sessions,
    };
    void this.runBatch();
    return { started: true, batch: this.batchState() as BatchState };
  }

  /** Stops the session that is running now and leaves the rest of the batch unstarted. */
  async stopBatch(): Promise<{ stopping: boolean }> {
    const batch = this.batch;
    if (!batch?.running) return { stopping: false };
    batch.stopping = true;
    const current = batch.sessions.find((s) => s.state === 'running');
    if (current) await this.stop(current.sessionId);
    return { stopping: true };
  }

  /**
   * The batch loop. Nothing here runs in parallel, on purpose: see `beginRun`.
   *
   * Each session is judged by the tasks it was given. A session that ran everything without a
   * failure is `done`; one with a failed task is `failed`; one the operator stopped, or one
   * whose chain stopped early with no failure of its own, is `stopped`.
   */
  private async runBatch(): Promise<void> {
    const batch = this.batch;
    if (!batch) return;

    /*
     * One browser for the whole batch.
     *
     * Every session used to open its own window and close it again: a fresh launch, a fresh
     * sign-in check and a fresh grab at the profile lock, several times over, for a machine
     * that can only have one of them open at a time anyway. The window is opened here, handed
     * to each session in turn, and closed when the last one is done — so between sessions the
     * only thing that changes is which conversation is on screen.
     */
    let browser: CopilotTransport | null = null;
    try {
      const cfg = await this.settings.load();
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
            taskIds: s.tasks.filter((t) => t.status === 'queued').map((t) => t.id),
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

        entry.state = 'running';
        this.bus.publish({
          sessionId: entry.sessionId,
          type: 'batch-session-started',
          level: 'info',
          message: `starting as part of a batch of ${batch.sessions.length} session(s), in ${batch.mode} mode`,
          data: { batchId: batch.id },
        });

        const begun = await this.beginRun(entry.sessionId, batch.mode, browser, runGroup);
        if (!begun.started) {
          entry.state = 'skipped';
          entry.reason = begun.reason;
          continue;
        }

        const tally = await begun.done;
        entry.ran = tally.ran;
        entry.failed = tally.failed;

        if (tally.error) {
          entry.state = 'failed';
          entry.reason = tally.error;
        } else if (tally.failed > 0) {
          entry.state = 'failed';
          entry.reason = `${tally.failed} task(s) did not finish: ${tally.failedTitles.join(', ')}`;
        } else if (batch.stopping || tally.leftQueued > 0) {
          entry.state = 'stopped';
          entry.reason = `${tally.leftQueued} task(s) never started`;
        } else {
          entry.state = 'done';
        }

        this.bus.publish({
          sessionId: entry.sessionId,
          type: 'batch-session-finished',
          level: entry.state === 'failed' ? 'warn' : 'info',
          message: `this session ended ${entry.state} inside the batch`,
          data: { batchId: batch.id, ran: entry.ran, failed: entry.failed },
        });

        if (entry.state === 'failed' && batch.onFailure === 'stop') {
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
  planBrief(opts: BriefOptions): string {
    return planBrief({ lang: opts.lang === 'bg' ? 'bg' : 'en' });
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
      if (session.vcs?.enabled === false) return;
      const dir = session.vcs?.repoDir?.trim() || session.mirror?.rootDir?.trim() || '';
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

    return { ...check, duplicates: await this.findDuplicates(check.plan) };
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
    const result = await importPlan(this.store, check.plan, (cfg.copilot.defaultModel ?? '').trim());
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
          ? { action: 'skip', reason: 'skipped by the operator' }
          : { action: 'abort', reason: 'aborted by the operator' };
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
  setRunMode(sessionId: string, mode: 'confirm' | 'unattended'): { ok: boolean; mode?: 'confirm' | 'unattended' } {
    const run = this.running.get(sessionId);
    if (!run) return { ok: false };
    if (run.mode === mode) return { ok: true, mode };

    run.mode = mode;
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
        if (w.approval.sessionId !== sessionId) continue;
        this.waiting.delete(id);
        w.resolve({ action: 'run' });
      }
    }
    return { ok: true, mode };
  }

  runMode(sessionId: string): 'confirm' | 'unattended' | undefined {
    return this.running.get(sessionId)?.mode;
  }

  private webAuthorizer(policy: { mode: 'confirm' | 'unattended'; denyPatterns: string[]; allowedScriptExtensions: string[] }, signal: AbortSignal): StepAuthorizer {
    return makeAuthorizer(policy, (step, ctx) =>
      new Promise<PolicyDecision>((resolvePromise) => {
        // The operator may have pressed "run the rest without asking" on an earlier step.
        // This is checked per step rather than captured once, which is what makes the switch
        // take effect from the very next step instead of the next run.
        if (this.running.get(ctx.sessionId ?? '')?.mode === 'unattended') {
          resolvePromise({ action: 'run' });
          return;
        }

        const approval: PendingApproval = {
          id: newId('a-'),
          sessionId: ctx.sessionId ?? '',
          taskId: ctx.taskId ?? '',
          stepId: step.id,
          description: step.type === 'command' ? `[${step.shell ?? 'pwsh'}] ${step.cmd}` : `[download] ${step.file}${step.run ? ' (run)' : ''}${ctx.scriptPath ? ` -> ${ctx.scriptPath}` : ''}`,
          createdAt: new Date().toISOString(),
        };
        if (signal.aborted) {
          resolvePromise({ action: 'abort', reason: 'stopped by the operator' });
          return;
        }
        this.waiting.set(approval.id, { approval, resolve: resolvePromise });
        this.bus.publish({ sessionId: approval.sessionId, taskId: approval.taskId, type: 'approval-requested', level: 'warn',
          message: `waiting for approval: ${approval.description}`, data: { ...approval } });
      }),
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

  /** Whether version control can do its job in this session, asked before a run. */
  async vcsStatus(
    sessionId: string,
  ): Promise<{ ok: boolean; repoDir: string; branch?: string; problem?: string; git?: string | null; work?: SessionBranches }> {
    await this.init();
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error('No such session.');
    const git = await gitAvailable();
    if (!git) return { ok: false, repoDir: '', problem: "git is not installed, or not on this machine's PATH.", git: null };
    // `branch` is where HEAD is; `work` is where the session's work is. After a per-task run
    // those differ, and the second is the one the operator is asking about.
    return { ...(await vcsPreflight(session)), git, work: sessionBranches(session) };
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
    return await restorePreview(session, task);
  }

  async restore(
    sessionId: string,
    taskId: string,
  ): Promise<{ ok: boolean; problem?: string; branch?: string; commit?: string; leftBehind?: string[]; keptOn?: string }> {
    await this.init();
    if (this.running.has(sessionId)) {
      return { ok: false, problem: 'This session is running. Stop it before moving the repository to another branch.' };
    }
    if (this.batch?.running) {
      return { ok: false, problem: 'A batch is running. Stop it before moving the repository to another branch.' };
    }
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error('No such session.');
    const task = session.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('No such task.');
    return await restoreToBase(session, task, this.bus);
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
      mode: group?.mode ?? 'unattended',
      onFailure: group?.onFailure ?? session.onFailure ?? 'stop',
    };

    /*
     * One restore per repository, keyed on the folder rather than on the session.
     *
     * Three sessions working in one repository must not take it back three times to three
     * different commits; the earliest affected task is the one that decides, because that is
     * the state the whole re-run starts from.
     */
    const byRepo = new Map<string, { session: Session; task: Task }>();
    for (const entry of tasks) {
      const dir = (entry.session.vcs?.enabled ? entry.session.vcs.repoDir : '')?.trim();
      if (!dir) continue;
      if (!byRepo.has(dir)) byRepo.set(dir, entry);
    }
    for (const [dir, entry] of byRepo) {
      const preview = await restorePreview(entry.session, entry.task);
      plan.restores.push({
        repoDir: preview.repoDir || dir,
        ok: preview.ok,
        problem: preview.problem,
        forTask: entry.task.title,
        baseCommit: preview.baseCommit,
        branchName: preview.branchName,
        leftBehind: preview.leftBehind,
        keptOn: preview.keptOn,
      });
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
    if (!plan.ok) return { ...idle, reason: plan.problem };
    if (plan.sessions.some((s) => this.running.has(s.id))) {
      return { ...idle, reason: 'One of these sessions is running on its own. Stop it first.' };
    }

    const restored: string[] = [];
    if (opts.restore !== false) {
      for (const entry of plan.restores) {
        if (!entry.ok) return { ...idle, reason: `${entry.repoDir}: ${entry.problem ?? 'the restore could not be prepared.'}` };
      }
      // Re-read each repository's own pivot and do it for real. The preview above is what the
      // operator agreed to; this is the same call, one step further.
      const session = (await this.store.getSession(sessionId)) as Session;
      const task = session.tasks.find((t) => t.id === taskId) as Task;
      const { tasks } = await this.affectedByRestart(session, task);
      const seenRepo = new Set<string>();
      for (const entry of tasks) {
        const dir = (entry.session.vcs?.enabled ? entry.session.vcs.repoDir : '')?.trim();
        if (!dir || seenRepo.has(dir)) continue;
        seenRepo.add(dir);
        const done = await restoreToBase(entry.session, entry.task, this.bus);
        if (!done.ok) return { ...idle, reason: `${dir}: ${done.problem ?? 'the restore failed.'}` };
        restored.push(`${dir} -> ${done.branch ?? ''}`);
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
        // explanation, so it stops here and says which one and why.
        return { ...idle, restored, reason: `"${t.title}" could not be queued again: ${(e as Error).message}` };
      }
    }

    this.bus.publish({
      sessionId,
      taskId,
      type: 'run-restarted',
      level: 'info',
      message:
        `starting again from "${plan.from.title}": ${plan.tasks.length} task(s) in ${plan.sessions.length} session(s)` +
        (restored.length > 0 ? `, after taking ${restored.length} repository(ies) back` : ''),
      data: { requeued, restored },
    });

    if (opts.start === false) return { started: false, reason: 'prepared, not started', requeued, restored };

    const started = await this.startBatch(
      plan.sessions.map((x) => x.id),
      opts.mode ?? plan.mode,
      opts.onFailure ?? plan.onFailure,
    );
    return { started: started.started, reason: started.reason, requeued, restored, batch: started.batch };
  }

  /** Why a folder cannot be used for version control, or null when it can. */
  repoProblem(dir: string): string | null {
    return repoUnusableReason(dir);
  }

  // --- the project being worked on ---------------------------------------------------------

  /**
   * The folder new sessions start pointed at, and whether it can carry version control.
   *
   * The repository check travels with it because the two questions are always asked together:
   * somewhere to work, and whether that somewhere can be branched and committed.
   */
  async project(): Promise<{ rootDir: string; repoOk: boolean; repoProblem?: string }> {
    const cfg = await this.settings.load();
    const rootDir = (cfg.project?.rootDir ?? '').trim();
    const problem = repoUnusableReason(rootDir);
    return { rootDir, repoOk: rootDir !== '' && problem === null, ...(problem ? { repoProblem: problem } : {}) };
  }

  /**
   * Stores the project folder. An empty value clears it, which is a real choice: it means new
   * sessions go back to starting with nothing chosen.
   *
   * A folder that is not a git repository is allowed here, because this setting is about where
   * the work is, not about version control. What it cannot do is silently promise version
   * control, so the answer says whether it can carry it.
   */
  async setProject(rootDir: string): Promise<{ rootDir: string; repoOk: boolean; repoProblem?: string }> {
    const value = (rootDir ?? '').trim();
    if (value && !existsSync(value)) throw new Error(`The folder ${value} does not exist on this machine.`);
    const raw = await this.settings.raw();
    await this.settings.save({ ...raw, project: { ...((raw.project as object) ?? {}), rootDir: value } });
    return await this.project();
  }

  // --- the model catalogue ----------------------------------------------------------------

  /**
   * What the picker offered when it was last read, plus the model new sessions start on.
   *
   * The two travel together because the UI shows them in one place: a list to choose from,
   * and which of them is the standing choice.
   */
  async models(): Promise<(ModelCatalogue & { defaultModel: string }) | { defaultModel: string; options: []; readAt: null }> {
    await this.init();
    const cfg = await this.settings.load();
    const cached = await this.store.getModels();
    const defaultModel = cfg.copilot.defaultModel ?? '';
    return cached ? { ...cached, defaultModel } : { defaultModel, options: [], readAt: null };
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
    const raw = await this.settings.raw();
    const copilot = { ...((raw.copilot as Record<string, unknown>) ?? {}), defaultModel: name.trim() };
    await this.settings.save({ ...raw, copilot });
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
  async refreshModels(): Promise<ModelCatalogue> {
    await this.init();
    if (this.running.size > 0) {
      throw new Error('A session is running and it is using the browser profile. Stop it first, then read the models.');
    }
    if (this.readingModels) throw new Error('The model list is already being read.');

    this.readingModels = true;
    const cfg = await this.settings.load();
    const transport = new CopilotTransport({
      profileDir: cfg.resolved.profileDir,
      downloadsDir: join(cfg.resolved.runsDir, '_models'),
      chatUrl: cfg.copilot.url,
      channel: cfg.copilot.channel,
      headless: cfg.copilot.headless,
      replyTimeoutMs: cfg.copilot.replyTimeoutSec * 1000,
      signInTimeoutMs: cfg.copilot.signInTimeoutSec * 1000,
      humanWaitMs: cfg.copilot.humanWaitSec * 1000,
    });

    try {
      await transport.open();
      await transport.ensureSignedIn();
      const { options, current, note } = await transport.listModels();
      const catalogue: ModelCatalogue = { options, current: current ?? undefined, readAt: new Date().toISOString(), note };
      await this.store.saveModels(catalogue);
      return catalogue;
    } finally {
      await transport.close().catch(() => undefined);
      this.readingModels = false;
    }
  }

  // --- the registry ---------------------------------------------------------------------

  /**
   * Every task of every session in one flat list, newest session first and, inside a session,
   * in the order the tasks run. The page splits it into what is done, what is running and
   * what is still ahead; doing the flattening here keeps that split honest, because the
   * queue position is only knowable from the session's own list.
   */
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
          attempt: t.attempt,
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
            };
          }),
        });
      });
    }
    return out;
  }

  // --- environment ----------------------------------------------------------------------

  async dirs(root: string, respectGitignore = true): Promise<string[]> {
    return await listSelectableDirs(root, { respectGitignore });
  }

  /** Opens the machine's own folder dialog and reports what was picked. */
  async browseFolder(start?: string): Promise<FolderPick> {
    return await pickFolder(start);
  }

  /**
   * What the current selection would copy, without writing anything. This is how the two
   * switches become checkable: turn the env one on and the `.env` files move from the skipped
   * list into the copied one, whatever `.gitignore` says about them.
   */
  async previewMirror(input: Partial<MirrorSettings> & { rootDir: string }): Promise<{
    files: string[];
    skipped: Array<{ relPath: string; reason: string }>;
    envFiles: string[];
    totalBytes: number;
    conflicts: ReturnType<typeof findSelectionConflicts>;
  }> {
    const conflicts = findSelectionConflicts(input.includeDirs ?? [], input.excludeDirs ?? []);
    if (conflicts.length > 0) throw new Error(describeConflicts(conflicts));

    const cfg = await this.settings.load();
    const { files, skipped } = await collectFiles({
      rootDir: input.rootDir,
      includeDirs: input.includeDirs?.length ? input.includeDirs : ['.'],
      excludeDirs: input.excludeDirs ?? [],
      targetDir: '',
      respectGitignore: input.respectGitignore ?? true,
      includeEnvFiles: input.includeEnvFiles ?? false,
      ignoreDirs: cfg.projectMirror.ignoreDirs,
      maxFileBytes: cfg.projectMirror.maxFileBytes,
    });

    let totalBytes = 0;
    for (const rel of files) {
      const s = await import('node:fs/promises').then((fs) => fs.stat(join(input.rootDir, rel)).catch(() => null));
      if (s) totalBytes += s.size;
    }
    return { files, skipped, envFiles: files.filter(isEnvPath), totalBytes, conflicts };
  }

  async doctor(): Promise<Record<string, unknown>> {
    const cfg = await this.settings.load();
    const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
    const holders = findEdgeUsingProfile(cfg.resolved.profileDir);
    return {
      node: process.versions.node,
      edge: edge ?? null,
      profileDir: cfg.resolved.profileDir,
      profileExists: existsSync(cfg.resolved.profileDir),
      profileHeldBy: Array.isArray(holders) ? holders.map((h) => h.pid) : 'unknown',
      desktop: resolveDesktopDir(),
      desktopSynced: desktopIsSynced(),
      cwd: cfg.resolved.cwd,
      runsDir: cfg.resolved.runsDir,
      dataDir: this.dataDir,
      mode: cfg.execution.mode,
      folderDialog: process.platform === 'win32',
      alwaysIgnoredDirs: DEFAULT_IGNORE_DIRS,
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

function isEnvPath(relPath: string): boolean {
  const name = relPath.split('/').pop()?.toLowerCase() ?? '';
  return name === '.env' || name.startsWith('.env.');
}

/**
 * Refuses a selection that contradicts itself, at the point it is saved rather than at the
 * point it runs. A contradiction is cheap to fix while the form is open and expensive to
 * discover an hour later, when the first task of a run fails on it.
 */
function assertMirrorIsCoherent(mirror: Partial<MirrorSettings>): void {
  const conflicts = findSelectionConflicts(mirror.includeDirs ?? [], mirror.excludeDirs ?? []);
  if (conflicts.length > 0) {
    throw new Error(`The include and exclude lists contradict each other. ${describeConflicts(conflicts)}`);
  }
  if (mirror.enabled && mirror.rootDir !== undefined && !mirror.rootDir.trim()) {
    throw new Error('Attaching project files needs a project root.');
  }
}
