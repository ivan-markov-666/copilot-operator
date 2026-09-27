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
import type { Step } from '../protocol/replySchema.js';
import { effectiveShell, type Shell } from './shells.js';
import { dangerousRefusal } from './dangerous.js';
import { findShellExecuteTrap } from './shellExecuteTrap.js';
import { inlineCodeRefusal, programRefusal } from './programs.js';
import { unattendedIsolationRefusal, type IsolationClaim } from './isolation.js';
import { confinementRefusal, type Confinement } from './confinement.js';
import { botSelfRefusal, networkFetchReason, networkFetchRefusal } from './network.js';
import { scriptFileRefusal } from './scriptFiles.js';

export type PolicyDecision =
  | { action: 'run' }
  | { action: 'skip'; reason: string }
  | { action: 'abort'; reason: string };

export type PolicyConfig = {
  mode: 'confirm' | 'unattended';
  denyPatterns: string[];
  /** The programs a command may start. Empty disables the allowlist. See `programs.ts`. */
  allowedPrograms: string[];
  /** What the operator says contains this runner. See `isolation.ts`. Defaults to none. */
  isolation?: IsolationClaim;
  /** An administrator's `policy.lock.json` forbids unattended runs on this machine. */
  lockedToConfirm?: boolean;
};

export function describeStep(step: Step): string {
  // The shell it will really be read by, not the one this file used to assume: a line in the
  // log that names an interpreter the machine has not got explains the wrong failure.
  return `[${effectiveShell(step.shell)}] ${step.cmd}`;
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


/**
 * A step that reaches into the repository's own machinery: a path inside `.git`, or a git setting
 * written to stay. Built in, like `dangerous.ts`, because the operator's deny list is editable and
 * this is not a matter of taste.
 *
 * Found on 2026-09-27: the runner's own git — the branch before a task, `add` and `commit` after
 * it, `status` for the commit-clean check — runs whatever hooks, filters and fsmonitor the
 * repository's config names. A step could write `.git\hooks\post-checkout`, or `git config
 * core.fsmonitor <program>`, and the *runner* would then execute it: no approval, no allowlist, no
 * step log. The runner now starts git with those switched off (`src/vcs/git.ts`); this stops the
 * step from setting them up in the first place. Reading history through git is unaffected — the
 * contract already tells the chat to use git commands, never the folder.
 */
export function repositoryInternalsRefusal(command: string): string | null {
  const intoGitDir = /(^|[\s'"=(\\/,;])\.git[\\/]/i.test(command);
  const setting = /\bgit\s+(?:-C\s+\S+\s+)?config\s+(?:(?:--(?:local|global|system|worktree)|--file\s+\S+)\s+)?(?:(?:set|unset)\s+)?[A-Za-z][\w.-]*\s+[^\s|;-]/i.test(command);
  if (!intoGitDir && !setting) return null;
  return (
    "refused: this reaches into the repository's own machinery (the .git folder, or a git setting written to stay). " +
    'The runner owns the repository and runs git itself; hooks and settings placed there would run as the runner. ' +
    'Read history with git commands (git log, git show, git diff) and leave .git alone.'
  );
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
  /**
   * The project folders and where this command runs. Absent only where there is no project to
   * speak of — a check run by hand, a test of some other rule. Every path that runs a command for a
   * task passes it: the implementer's steps and checks, and the reviewer's steps and derived checks.
   */
  confinement?: Confinement,
): string | null {
  // The built-in refusals first, because the operator's list can add to them and must not be
  // able to stand in for them: a config written before they existed, or edited since, still gets
  // them. See `dangerous.ts` for what is on the list and why each one is.
  const technique = dangerousRefusal(command);
  if (technique) return technique;
  // Before the operator's list: no configuration makes it right for a step to drive the bot.
  const self = botSelfRefusal(command);
  if (self) return self;
  const internals = repositoryInternalsRefusal(command);
  if (internals) return internals;
  const hit = matchDenyPattern(command, denyPatterns);
  if (hit) return `matches deny pattern /${hit}/`;
  // Where it reaches, before which program it is: a binary named by a path outside the project is
  // better refused for being outside than for not being on a list, and a cmdlet — which the
  // allowlist never sees — is only caught here. See `confinement.ts`.
  if (confinement) {
    const reach = confinementRefusal(command, confinement);
    if (reach) return reach;
  }
  // The allowlist after the known-bad floor and the operator's deny list, so their precise
  // messages win, and this catches the long tail neither of them was ever going to enumerate: a
  // program that is simply not part of this project's toolchain. See `programs.ts`.
  const offlist = programRefusal(command, allowedPrograms);
  if (offlist) return offlist;
  const trap = findShellExecuteTrap(command, shell, env);
  if (trap) return trap;
  /*
   * The scripts this line runs, read from disk and put through the same gate as the line. Only
   * where the command's folder is known: that is every path that runs a command for a task.
   */
  if (confinement) {
    return scriptFileRefusal(command, confinement.cwd, (text) =>
      dangerousRefusal(text) ??
      botSelfRefusal(text) ??
      repositoryInternalsRefusal(text) ??
      (matchDenyPattern(text, denyPatterns) ? `matches deny pattern /${matchDenyPattern(text, denyPatterns)}/` : null) ??
      confinementRefusal(text, confinement) ??
      programRefusal(text, allowedPrograms),
    );
  }
  return null;
}

/**
 * The gate for a check's command — the task's own checks and the reviewer's — which runs with
 * nobody asked. A download in one is therefore refused rather than held, and the scripts it runs
 * are read like a step's. One function, so the two callers cannot drift apart again (they had: the
 * reviewer's checks refused downloads, the plan's did not).
 */
export function checkCommandRefusal(
  command: string,
  shell: Shell,
  cfg: Pick<PolicyConfig, 'denyPatterns' | 'allowedPrograms'>,
  confinement: Confinement,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const refusal = commandRefusal(command, shell, cfg.denyPatterns, cfg.allowedPrograms, env, confinement);
  if (refusal) return refusal;
  const network = networkFetchReason(command, confinement.cwd) ?? scriptNetworkReason(command, confinement.cwd);
  return network ? networkFetchRefusal(network) : null;
}

/** A fetch inside a script the line runs — held or refused exactly as one on the line would be. */
export function scriptNetworkReason(command: string, cwd: string): string | null {
  let found: string | null = null;
  scriptFileRefusal(command, cwd, (text) => {
    found = networkFetchReason(text, cwd);
    return null;
  });
  return found;
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
export function unattendedPrecondition(cfg: Pick<PolicyConfig, 'mode' | 'allowedPrograms' | 'isolation' | 'lockedToConfirm'>): string | null {
  if (cfg.mode !== 'unattended') return null;
  if (cfg.lockedToConfirm) {
    return 'refused: this machine\'s policy.lock.json forbids unattended runs. Run this task step by step.';
  }
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
export function staticCheck(
  step: Step,
  cfg: PolicyConfig,
  env: NodeJS.ProcessEnv = process.env,
  confinement?: Confinement,
): PolicyDecision | null {
  // Screened against the shell that will actually read it: the traps in `shellExecuteTrap.ts`
  // are shell-specific, so screening for one interpreter and running in another finds nothing.
  const reason = commandRefusal(step.cmd, effectiveShell(step.shell), cfg.denyPatterns, cfg.allowedPrograms, env, confinement);
  if (reason) return { action: 'skip', reason };

  /*
   * Autonomy is graded: an unattended run carries strictly more restrictions than a watched one,
   * because the thing that makes a watched run safe — a person reading each line — is exactly what
   * an unattended run has removed.
   *
   * The precondition is the same one the entrances ask before anything starts; it is asked again
   * here because the entrance is a courtesy and this is the path nothing goes round. The second
   * rule is about an allowlisted interpreter used to evaluate a string, or a shell wrapped in a
   * shell, which escapes the allowlist by construction: watched, a person can judge it; unwatched,
   * it makes the list meaningless.
   */
  if (cfg.mode === 'unattended') {
    const precondition = unattendedPrecondition(cfg);
    if (precondition) return { action: 'skip', reason: precondition };
    const inline = inlineCodeRefusal(step.cmd);
    if (inline) return { action: 'skip', reason: inline };
  }
  return null;
}
