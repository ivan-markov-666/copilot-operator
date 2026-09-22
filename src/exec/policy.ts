/**
 * The gate every step passes before it runs.
 *
 * The bot executes commands written by a language model on a real Windows machine, so this
 * file is the difference between a useful tool and an accident. Two layers:
 *
 *   deny list   patterns that are refused outright, in both modes
 *   confirm     in confirm mode a human sees each step and decides
 *
 * The deny list is not a security boundary. A determined model could phrase a destructive
 * command in a way no regex catches. It is a guard against the ordinary case: a plausible
 * suggestion that would wipe a folder. Real isolation is a separate account or a sandbox,
 * which the README recommends.
 */
import { extname } from 'node:path';
import type { Step } from '../protocol/replySchema.js';
import { effectiveShell, type Shell } from './shells.js';
import { findShellExecuteTrap } from './shellExecuteTrap.js';

export type PolicyDecision =
  | { action: 'run' }
  | { action: 'skip'; reason: string }
  | { action: 'abort'; reason: string };

export type PolicyConfig = {
  mode: 'confirm' | 'unattended';
  denyPatterns: string[];
  allowedScriptExtensions: string[];
};

export function describeStep(step: Step, scriptPath?: string): string {
  // The shell it will really be read by, not the one this file used to assume: a line in the
  // log that names an interpreter the machine has not got explains the wrong failure.
  if (step.type === 'command') {
    return `[${effectiveShell(step.shell)}] ${step.cmd}`;
  }
  const how = step.run ? `run with ${effectiveShell(step.shell)}` : 'save only';
  return `[download] ${step.file} (${how}${step.args.length ? ` ${step.args.join(' ')}` : ''})${
    scriptPath ? ` -> ${scriptPath}` : ''
  }`;
}

/** Returns the first deny pattern that matches, or null. */
export function matchDenyPattern(text: string, patterns: string[]): string | null {
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(text)) return p;
    } catch {
      // An invalid pattern in the config must not silently disable the whole deny list.
      if (text.toLowerCase().includes(p.toLowerCase())) return p;
    }
  }
  return null;
}

export function checkScriptExtension(fileName: string, allowed: string[]): string | null {
  const ext = extname(fileName).toLowerCase();
  if (allowed.map((e) => e.toLowerCase()).includes(ext)) return null;
  return `"${fileName}" has extension ${ext || '(none)'}, which is not in allowedScriptExtensions`;
}

/**
 * Why a command line must not run, or null. The one gate for a step's command and for a
 * check's command alike: the deny list, then the forms that are not dangerous but cannot work
 * (see `shellExecuteTrap.ts`) — refused for the same reason a check that would hang is refused,
 * because the alternative is an iteration spent on a symptom.
 */
export function commandRefusal(
  command: string,
  shell: Shell,
  denyPatterns: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const hit = matchDenyPattern(command, denyPatterns);
  if (hit) return `matches deny pattern /${hit}/`;
  return findShellExecuteTrap(command, shell, env);
}

/**
 * Applies the automatic rules. Returns null when the step is acceptable so far, or a
 * decision when it is refused without asking anyone.
 */
export function staticCheck(step: Step, cfg: PolicyConfig, env: NodeJS.ProcessEnv = process.env): PolicyDecision | null {
  if (step.type === 'command') {
    // Screened against the shell that will actually read it: the traps in `shellExecuteTrap.ts`
    // are shell-specific, so screening for one interpreter and running in another finds nothing.
    const reason = commandRefusal(step.cmd, effectiveShell(step.shell), cfg.denyPatterns, env);
    return reason ? { action: 'skip', reason } : null;
  }

  const hit = matchDenyPattern(`${step.file} ${step.args.join(' ')}`, cfg.denyPatterns);
  if (hit) return { action: 'skip', reason: `matches deny pattern /${hit}/` };

  if (step.run) {
    const bad = checkScriptExtension(step.file, cfg.allowedScriptExtensions);
    if (bad) return { action: 'skip', reason: bad };
  }
  return null;
}
