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
import { dangerousInScript, dangerousRefusal } from './dangerous.js';
import { findShellExecuteTrap } from './shellExecuteTrap.js';
import { inlineCodeRefusal, programRefusal } from './programs.js';
import { unattendedIsolationRefusal, type IsolationClaim } from './isolation.js';

export type PolicyDecision =
  | { action: 'run' }
  | { action: 'skip'; reason: string }
  | { action: 'abort'; reason: string };

export type PolicyConfig = {
  mode: 'confirm' | 'unattended';
  denyPatterns: string[];
  allowedScriptExtensions: string[];
  /** The programs a command may start. Empty disables the allowlist. See `programs.ts`. */
  allowedPrograms: string[];
  /** What the operator says contains this runner. See `isolation.ts`. Defaults to none. */
  isolation?: IsolationClaim;
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
  allowedPrograms: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // The built-in refusals first, because the operator's list can add to them and must not be
  // able to stand in for them: a config written before they existed, or edited since, still gets
  // them. See `dangerous.ts` for what is on the list and why each one is.
  const technique = dangerousRefusal(command);
  if (technique) return technique;
  const hit = matchDenyPattern(command, denyPatterns);
  if (hit) return `matches deny pattern /${hit}/`;
  // The allowlist after the known-bad floor and the operator's deny list, so their precise
  // messages win, and this catches the long tail neither of them was ever going to enumerate: a
  // program that is simply not part of this project's toolchain. See `programs.ts`.
  const offlist = programRefusal(command, allowedPrograms);
  if (offlist) return offlist;
  return findShellExecuteTrap(command, shell, env);
}

/**
 * Whether a download step may actually execute its file, rather than only save it.
 *
 * Two gates, and both must agree:
 *   the reply asked for it   `step.run`, written by the model; false by default in the reply schema.
 *   the operator allows it    `execution.allowRunningDownloads`, false by default in the config.
 *
 * The second gate exists because the first is not the model's to give. `step.run` arrives in the
 * same reply as the file it wants run, written by the thing this tool is driving; letting that
 * alone decide whether a freshly fetched file may execute is no gate at all, and it is precisely
 * the shape a security team reads as a loader — a process fetching a script and running it. So a
 * downloaded file runs only when a person has turned execution on, and a machine that never does
 * cannot be talked into running an attachment by any reply, however the reply is phrased.
 *
 * The one place this is decided, so a step and a log and a test cannot disagree about it.
 */
export function downloadWillRun(step: Step, allowRunningDownloads: boolean): boolean {
  return step.type === 'download' && step.run === true && allowRunningDownloads;
}

/**
 * Why a downloaded script must not be run, or null.
 *
 * The gap this closes was the whole of it. A download step was screened on its *file name* and
 * its arguments and never on its contents, so `run.ps1` — an allowed extension, an innocent
 * name — passed the gate carrying anything at all inside it. The runner then started it with
 * `pwsh -File`, and whatever the script did next was a child of this process: to anything
 * watching the machine, this tool ran it. The file name was the one thing about it nobody
 * needed to see.
 */
export function scriptRefusal(fileName: string, body: string, denyPatterns: string[]): string | null {
  const technique = dangerousInScript(fileName, body);
  if (technique) return technique;
  const hit = matchDenyPattern(body, denyPatterns);
  return hit ? `${fileName} matches deny pattern /${hit}/` : null;
}

/**
 * Why an unattended run may not begin at all, or null.
 *
 * Both conditions are about the same thing: an unattended run has given up the person who made
 * every other rule survivable, so the two things that stand in for them have to be there. Nowhere
 * to run and nobody watching is refused outright; an empty allowlist and nobody watching means
 * nothing at all limits a step.
 *
 * Asked in two places on purpose. At the entrance — `start`, `startBatch`, the CLI, and the button
 * that turns a running session unattended — so the operator is told once, before anything begins,
 * what to set and where. And again in `staticCheck`, because the entrance is a courtesy and the
 * step gate is the rule: a path that reached execution another way still finds it there.
 *
 * It is deliberately *not* a warning. The first version of this refused each step as it arrived,
 * which technically held the line and in practice turned the ordinary "Run sessions" button into a
 * run where every step came back refused — a gate that breaks the working bot is a gate that gets
 * switched off, and the fix was to make the condition reachable rather than to soften it.
 */
export function unattendedPrecondition(cfg: Pick<PolicyConfig, 'mode' | 'allowedPrograms' | 'isolation'>): string | null {
  if (cfg.mode !== 'unattended') return null;
  const unisolated = unattendedIsolationRefusal(cfg.mode, cfg.isolation ?? 'none');
  if (unisolated) return unisolated;
  if (!cfg.allowedPrograms || cfg.allowedPrograms.length === 0) {
    return (
      'refused: an unattended run requires execution.allowedPrograms to name the programs this project ' +
      'may start. With the allowlist empty and nobody watching, nothing limits what a step can run. ' +
      'Fill in the allowlist, or run this task step by step.'
    );
  }
  return null;
}

/**
 * Applies the automatic rules. Returns null when the step is acceptable so far, or a
 * decision when it is refused without asking anyone.
 */
export function staticCheck(step: Step, cfg: PolicyConfig, env: NodeJS.ProcessEnv = process.env): PolicyDecision | null {
  if (step.type === 'command') {
    // Screened against the shell that will actually read it: the traps in `shellExecuteTrap.ts`
    // are shell-specific, so screening for one interpreter and running in another finds nothing.
    const reason = commandRefusal(step.cmd, effectiveShell(step.shell), cfg.denyPatterns, cfg.allowedPrograms, env);
    if (reason) return { action: 'skip', reason };
    /*
     * Autonomy is graded: an unattended run carries strictly more restrictions than a watched one,
     * because the thing that makes a watched run safe — a person reading each line — is exactly
     * what an unattended run has removed. Two rules apply only here.
     *
     * First, unattended and an empty allowlist is the one combination nobody should be able to
     * assemble by accident: no list, and no one to notice. The run is stopped on its first step
     * with the reason, rather than quietly becoming the blank cheque this whole round exists to
     * remove.
     *
     * Second, an allowlisted interpreter used to evaluate a string, or a shell wrapped in a shell,
     * escapes the allowlist by construction (see `inlineCodeRefusal`). Watched, that is ordinary
     * and a person can judge it. Unwatched, it makes the list meaningless.
     */
    if (cfg.mode === 'unattended') {
      // The same rule the run was supposed to have been stopped by before it ever started. Kept
      // here as well as at the entrance, because this is the one path nothing can go round.
      const precondition = unattendedPrecondition(cfg);
      if (precondition) return { action: 'skip', reason: precondition };
      const inline = inlineCodeRefusal(step.cmd);
      if (inline) return { action: 'skip', reason: inline };
    }
    return null;
  }

  const hit = matchDenyPattern(`${step.file} ${step.args.join(' ')}`, cfg.denyPatterns);
  if (hit) return { action: 'skip', reason: `matches deny pattern /${hit}/` };

  if (step.run) {
    const bad = checkScriptExtension(step.file, cfg.allowedScriptExtensions);
    if (bad) return { action: 'skip', reason: bad };
  }
  return null;
}
