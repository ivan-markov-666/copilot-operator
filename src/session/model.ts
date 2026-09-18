/**
 * The domain the UI and the API talk about.
 *
 * A **session** is one Copilot conversation. Inside it, **tasks** run one after another,
 * each with its own level-2 instructions and its own prompt. Level 1, the contract with the
 * runner, is sent once at the start of the conversation and applies to every task in it.
 *
 * Everything here is plain data that survives a restart: sessions are JSON files under the
 * data directory, and the heavy artefacts of a task (reports, replies, step logs) live in the
 * run folder the task points at.
 */
import type { ChatPointer } from '../transport/chatSession.js';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting-approval'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'limit-reached';

export type SessionStatus = 'idle' | 'running' | 'stopping';

export type Task = {
  id: string;
  title: string;
  /** Level 2: project, domain and team instructions. Written by the user, saved per task. */
  level2: string;
  /** The task itself. */
  prompt: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Folder name under `runs/` holding this task's artefacts, once it has started. */
  runId?: string;
  iterations: number;
  /** The exact text that opened the task in the chat, saved so the UI can show it. */
  firstMessage?: string;
  /** Copilot's closing explanation of what was done and what the result is. */
  summary?: string;
  /** The raw markdown of the last reply, for the record. */
  finalReply?: string;
  /** Why the task ended, when it did not end with `done`. */
  reason?: string;
  /** Path of the consolidated text log of everything executed, relative to the run folder. */
  logFile?: string;
};

export type MirrorSettings = {
  enabled: boolean;
  rootDir: string;
  includeDirs: string[];
  excludeDirs: string[];
};

export type Session = {
  id: string;
  name: string;
  createdAt: string;
  status: SessionStatus;
  /** Set once the conversation exists in Copilot. */
  chat?: ChatPointer;
  /** Whether the level-1 contract has already been sent in this conversation. */
  contractSent: boolean;
  mirror: MirrorSettings;
  tasks: Task[];
};

/** A saved level-2 persona the user can reuse across tasks and sessions. */
export type Level2Preset = {
  name: string;
  content: string;
  updatedAt: string;
};

/** One line of the live event stream the UI subscribes to. */
export type SessionEvent = {
  at: string;
  sessionId: string;
  taskId?: string;
  type: string;
  level: 'info' | 'warn' | 'error';
  message?: string;
  data?: Record<string, unknown>;
};

/** A step waiting for a human decision in confirm mode. */
export type PendingApproval = {
  id: string;
  sessionId: string;
  taskId: string;
  stepId: number;
  description: string;
  createdAt: string;
};

export function newId(prefix = ''): string {
  const now = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${prefix}${stamp}-${rnd}`;
}
