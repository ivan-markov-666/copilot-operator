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
  if (step.type === 'command') {
    return `[${step.shell ?? 'pwsh'}] ${step.cmd}`;
  }
  const how = step.run ? `run with ${step.shell ?? 'pwsh'}` : 'save only';
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
 * Applies the automatic rules. Returns null when the step is acceptable so far, or a
 * decision when it is refused without asking anyone.
 */
export function staticCheck(step: Step, cfg: PolicyConfig): PolicyDecision | null {
  const subject = step.type === 'command' ? step.cmd : `${step.file} ${step.args.join(' ')}`;

  const hit = matchDenyPattern(subject, cfg.denyPatterns);
  if (hit) return { action: 'skip', reason: `matches deny pattern /${hit}/` };

  if (step.type === 'download' && step.run) {
    const bad = checkScriptExtension(step.file, cfg.allowedScriptExtensions);
    if (bad) return { action: 'skip', reason: bad };
  }
  return null;
}
