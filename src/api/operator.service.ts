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

import { SessionStore } from '../session/store.js';
import { EventBus } from '../session/events.js';
import type { Session, Task, Level2Preset, PendingApproval, SessionEvent, MirrorSettings } from '../session/model.js';
import { newId } from '../session/model.js';
import { runSession } from '../orchestrator/taskRunner.js';
import { makeAuthorizer, unattendedAuthorizer, type StepAuthorizer } from '../exec/authorizer.js';
import type { PolicyDecision } from '../exec/policy.js';
import { listSelectableDirs } from '../context/projectMirror.js';
import { findEdgeUsingProfile } from '../transport/profileLock.js';
import { resolveDesktopDir, desktopIsSynced } from '../context/contextFiles.js';
import { Settings } from './settings.js';
import type { ResolvedConfig } from '../config/schema.js';

type Running = { controller: AbortController; startedAt: string; mode: 'confirm' | 'unattended' };

type Waiting = { approval: PendingApproval; resolve: (d: PolicyDecision) => void };

@Injectable()
export class OperatorService {
  readonly projectRoot = resolve(process.env.COP_PROJECT_ROOT ?? process.cwd());
  readonly dataDir = resolve(process.env.COP_DATA_DIR ?? join(this.projectRoot, 'data'));
  readonly settings = new Settings(this.projectRoot, this.dataDir);
  readonly store = new SessionStore(this.dataDir, join(this.projectRoot, 'prompts', 'level1.md'));
  readonly bus = new EventBus();

  private readonly running = new Map<string, Running>();
  private readonly waiting = new Map<string, Waiting>();
  private ready: Promise<void> | null = null;

  private init(): Promise<void> {
    this.ready ??= this.store.init();
    return this.ready;
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

  async getSession(id: string): Promise<(Session & { running: boolean; pending: PendingApproval[] }) | null> {
    await this.init();
    const s = await this.store.getSession(id);
    if (!s) return null;
    const pending = [...this.waiting.values()].filter((w) => w.approval.sessionId === id).map((w) => w.approval);
    return { ...s, running: this.running.has(id), pending };
  }

  async createSession(name: string, mirror?: Partial<MirrorSettings>): Promise<Session> {
    await this.init();
    return await this.store.createSession(name, mirror);
  }

  async updateSession(id: string, patch: { name?: string; mirror?: Partial<MirrorSettings> }): Promise<Session> {
    await this.init();
    return await this.store.updateSession(id, (s) => {
      if (patch.name !== undefined) s.name = patch.name.trim() || s.name;
      if (patch.mirror) s.mirror = { ...s.mirror, ...patch.mirror };
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

  async updateTask(sessionId: string, taskId: string, patch: Partial<Pick<Task, 'title' | 'level2' | 'prompt'>>): Promise<Task> {
    await this.init();
    return await this.store.updateTask(sessionId, taskId, (t) => {
      if (t.status !== 'queued') throw new Error('Only a queued task can be edited.');
      if (patch.title !== undefined) t.title = patch.title;
      if (patch.level2 !== undefined) t.level2 = patch.level2;
      if (patch.prompt !== undefined) t.prompt = patch.prompt;
    });
  }

  async deleteTask(sessionId: string, taskId: string): Promise<void> {
    await this.init();
    await this.store.deleteTask(sessionId, taskId);
  }

  /** The consolidated text log of a task, or null when it has not produced one. */
  async taskLog(sessionId: string, taskId: string): Promise<string | null> {
    const cfg = await this.settings.load();
    const s = await this.store.getSession(sessionId);
    const t = s?.tasks.find((x) => x.id === taskId);
    if (!t?.runId) return null;
    const path = join(cfg.resolved.runsDir, t.runId, 'task-log.txt');
    return existsSync(path) ? await readFile(path, 'utf8') : null;
  }

  /** Files a task produced, so the UI can list reports and downloaded scripts. */
  async taskFiles(sessionId: string, taskId: string): Promise<{ reports: string[]; artifacts: string[]; replies: string[] }> {
    const cfg = await this.settings.load();
    const s = await this.store.getSession(sessionId);
    const t = s?.tasks.find((x) => x.id === taskId);
    const empty = { reports: [], artifacts: [], replies: [] };
    if (!t?.runId) return empty;
    const base = join(cfg.resolved.runsDir, t.runId);
    const ls = async (sub: string): Promise<string[]> =>
      (await readdir(join(base, sub)).catch(() => [] as string[])).filter((n) => !n.startsWith('_')).sort();
    return { reports: await ls('reports'), artifacts: await ls('artifacts'), replies: await ls('replies') };
  }

  async taskFile(sessionId: string, taskId: string, kind: 'reports' | 'artifacts' | 'replies', name: string): Promise<string | null> {
    if (name.includes('..') || name.includes('/') || name.includes('\\')) return null;
    const cfg = await this.settings.load();
    const s = await this.store.getSession(sessionId);
    const t = s?.tasks.find((x) => x.id === taskId);
    if (!t?.runId) return null;
    const path = join(cfg.resolved.runsDir, t.runId, kind, name);
    return existsSync(path) ? await readFile(path, 'utf8') : null;
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
    await this.init();
    if (this.running.has(sessionId)) return { started: false, reason: 'already running' };
    const session = await this.store.getSession(sessionId);
    if (!session) return { started: false, reason: 'no such session' };
    if (!session.tasks.some((t) => t.status === 'queued')) return { started: false, reason: 'no queued tasks' };

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

    void runSession(sessionId, { cfg: { ...cfg, execution: { ...cfg.execution, mode } } as ResolvedConfig, store: this.store, bus: this.bus, authorizer, signal: controller.signal })
      .catch((e: unknown) => {
        this.bus.publish({ sessionId, type: 'run-failed', level: 'error', message: (e as Error).message });
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

    return { started: true };
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

  // --- approvals ------------------------------------------------------------------------

  pendingApprovals(sessionId?: string): PendingApproval[] {
    return [...this.waiting.values()].map((w) => w.approval).filter((a) => !sessionId || a.sessionId === sessionId);
  }

  decide(approvalId: string, action: 'run' | 'skip' | 'abort'): { ok: boolean } {
    const w = this.waiting.get(approvalId);
    if (!w) return { ok: false };
    this.waiting.delete(approvalId);
    const decision: PolicyDecision =
      action === 'run'
        ? { action: 'run' }
        : action === 'skip'
          ? { action: 'skip', reason: 'skipped by the operator' }
          : { action: 'abort', reason: 'aborted by the operator' };
    w.resolve(decision);
    this.bus.publish({ sessionId: w.approval.sessionId, taskId: w.approval.taskId, type: 'approval-decided', level: 'info',
      message: `step ${w.approval.stepId}: ${action}`, data: { approvalId, action } });
    return { ok: true };
  }

  private webAuthorizer(policy: { mode: 'confirm' | 'unattended'; denyPatterns: string[]; allowedScriptExtensions: string[] }, signal: AbortSignal): StepAuthorizer {
    return makeAuthorizer(policy, (step, ctx) =>
      new Promise<PolicyDecision>((resolvePromise) => {
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

  // --- environment ----------------------------------------------------------------------

  async dirs(root: string): Promise<string[]> {
    return await listSelectableDirs(root);
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
    };
  }
}
