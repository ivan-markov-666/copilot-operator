/**
 * A start that did not get as far as the first task, kept so the operator can see why and download
 * what happened.
 *
 * Asked for on 2026-10-13: "if something fails and the bot does not start at all, I want to see what
 * the error is — the specific error, and a place to download what happened in the terminal". Some of
 * these were answered under the button that was pressed, in a sentence; others were not answered at
 * all: a run accepted, then the browser would not open, and the reason was in the console and in a
 * table row further down the page. Each one is now recorded here with where it stopped, the message,
 * the run and its sessions, and the page offers a file that puts the run's own record, the sessions'
 * events and the console lines of those moments in one place.
 *
 * Kept in memory only, for this process: the files it points at (the run log, the terminal log) are
 * what stays.
 */
import { randomBytes } from 'node:crypto';

import type { RunLogEntry } from './runLog.js';
import type { SessionEvent } from './model.js';
import { formatTerminal, localTime, type TerminalLine } from '../log/terminal.js';

/**
 * Where a start stopped:
 *
 *   refused    it was not let in: another run has the browser, the session is set aside, an unattended
 *              run this machine does not allow, nothing queued
 *   branch     the branch chosen in the start window could not be used
 *   preflight  version control was not ready, or a task contradicts itself; nothing was opened
 *   browser    Edge, the profile or the chat would not open
 *   run        the run ended with an error before its first task began
 *   at-turn    a later session of the run was refused when its turn came
 *   error      the bot itself failed while starting
 */
export type StartStage = 'refused' | 'branch' | 'preflight' | 'browser' | 'run' | 'at-turn' | 'error';

export type StartFailure = {
  id: string;
  /** When it failed. */
  at: string;
  /** When the start was asked for: where the console lines of the download begin. */
  pressedAt: string;
  stage: StartStage;
  message: string;
  runId?: string;
  sessions: Array<{ id: string; name: string }>;
  /**
   * Given as the answer to the press, under the button or in the start window. One that is not — the
   * run was accepted and failed afterwards — is shown on every page until it is closed.
   */
  answered: boolean;
};

/** What the page is told about one, without the long parts. */
export type StartFailureRef = Pick<StartFailure, 'id' | 'at' | 'stage' | 'message' | 'runId' | 'answered'> & { sessions: string[] };

const STAGE_SAID: Record<StartStage, string> = {
  refused: 'the start was not let in, before anything opened',
  branch: 'choosing the branch the work starts from',
  preflight: 'the version control check, before the browser opened',
  browser: 'opening the browser (Edge), its profile or the chat',
  run: 'the run, before its first task began',
  'at-turn': "the session's turn in the run, before its first task",
  error: 'the bot itself, while starting',
};

export function describeStage(stage: StartStage): string {
  return STAGE_SAID[stage];
}

const KEEP = 50;

export class StartFailures {
  private readonly list: StartFailure[] = [];

  record(f: Omit<StartFailure, 'id' | 'at'> & { at?: string }): StartFailure {
    const full: StartFailure = { ...f, id: `sf-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, at: f.at ?? new Date().toISOString() };
    this.list.push(full);
    if (this.list.length > KEEP) this.list.splice(0, this.list.length - KEEP);
    return full;
  }

  get(id: string): StartFailure | undefined {
    return this.list.find((f) => f.id === id);
  }

  /** The newest first; only those nobody was answered with, when asked for. */
  recent(opts: { unansweredOnly?: boolean } = {}): StartFailure[] {
    return [...this.list].reverse().filter((f) => !opts.unansweredOnly || !f.answered);
  }
}

export function refOf(f: StartFailure): StartFailureRef {
  return { id: f.id, at: f.at, stage: f.stage, message: f.message, ...(f.runId ? { runId: f.runId } : {}), answered: f.answered, sessions: f.sessions.map((s) => s.name) };
}

/**
 * The file the page offers: what failed and where, then the run's own record, the sessions' events,
 * and what the console printed from the press to a few seconds after the failure. Plain text, so it
 * opens anywhere and can be pasted into a message; the caller redacts it.
 */
export function failureReport(
  f: StartFailure,
  parts: { runLog: RunLogEntry[]; events: SessionEvent[]; terminal: TerminalLine[]; terminalFile: string | null; version?: string },
): string {
  const out: string[] = [];
  out.push('copilot-operator — the work did not start');
  out.push('');
  out.push(`When:              ${localTime(f.at)} (pressed ${localTime(f.pressedAt)})`);
  out.push(`Where it stopped:  ${describeStage(f.stage)} [${f.stage}]`);
  if (f.runId) out.push(`Run:               ${f.runId}`);
  if (f.sessions.length > 0) out.push(`Sessions:          ${f.sessions.map((s) => `"${s.name}" (${s.id})`).join(', ')}`);
  if (parts.version) out.push(`Version:           ${parts.version}`);
  out.push('');
  out.push('What went wrong:');
  out.push(...f.message.split(/\r?\n/).map((l) => `  ${l}`));
  out.push('');
  out.push(`The run's record (${parts.runLog.length} entr${parts.runLog.length === 1 ? 'y' : 'ies'}):`);
  if (parts.runLog.length === 0) out.push('  (none: the start stopped before the run was recorded)');
  for (const e of parts.runLog) out.push(`  ${localTime(e.at)}  ${e.type}  ${e.message}`);
  out.push('');
  out.push(`The sessions' events since the press (${parts.events.length}):`);
  if (parts.events.length === 0) out.push('  (none)');
  for (const e of parts.events) out.push(`  ${localTime(e.at)}  ${e.level === 'info' ? '    ' : e.level.toUpperCase().padEnd(4)}  ${e.type}  ${e.message ?? ''}`);
  out.push('');
  out.push(`What the terminal showed (the bot's console, ${parts.terminal.length} line(s) from the press to a few seconds after):`);
  out.push(parts.terminal.length > 0 ? formatTerminal(parts.terminal) : '  (nothing was printed)');
  out.push('');
  if (parts.terminalFile) out.push(`The whole console is kept in ${parts.terminalFile}; past 5 MB the older part goes to terminal.1.log beside it.`);
  out.push('');
  return out.join('\n');
}
