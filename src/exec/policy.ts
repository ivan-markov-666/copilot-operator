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
import { ownScriptRefusal, scratchScriptRefusal, scriptFileRefusal, type ScriptRun } from './scriptFiles.js';
import type { ScriptRules, WrittenScriptsChoice } from './scriptKinds.js';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readOnlyRefusal, readOnlyUnaskedRefusal, readOnlyUnclearRefusal, readOnlyVerdict } from './readOnly.js';
import { platformReason } from './platforms.js';
import { scanCommandHeads } from './commandHeads.js';

/*
 * `by: 'operator'` marks a decision a person made on the approval screen or at the terminal; without
 * it a skip or an abort is the runner's own refusal. The step's record says which, so the chat is
 * never told a person stopped a step that a rule declined, or the other way round.
 */
export type PolicyDecision =
  | { action: 'run' }
  | { action: 'skip'; reason: string; by?: 'operator' }
  | { action: 'abort'; reason: string; by?: 'operator' };

export type PolicyConfig = {
  mode: 'confirm' | 'unattended';
  denyPatterns: string[];
  /** The programs a command may start. Empty disables the allowlist. See `programs.ts`. */
  allowedPrograms: string[];
  /** What the operator says contains this runner. See `isolation.ts`. Defaults to none. */
  isolation?: IsolationClaim;
  /** An administrator's `policy.lock.json` forbids unattended runs on this machine. */
  lockedToConfirm?: boolean;
  /**
   * What an unattended run does with a step that fetches from the network: put it to the operator,
   * refuse it back to the chat, or run it. Absent means `ask`. A step-by-step run asks about every
   * step whatever this says. See `execution.networkFetch` in `schema.ts`.
   */
  networkFetch?: NetworkFetchChoice;
  /**
   * A command that reaches a platform with the operator's access (`platforms.ts`): put to the operator in every mode,
   * or `allow`ed, when Settings say to agree with what the bot proposes (`execution.questions: agree`).
   */
  platformAccess?: 'ask' | 'allow';
  /**
   * Programs on the allowlist set to read only (2026-10-26): their commands that only read run without a card, the ones
   * that change something are refused, the ones that cannot be read are asked about in every mode. See `readOnly.ts`.
   */
  readOnlyPrograms?: string[];
  /**
   * Programs that reach a platform, set by the operator to run without asking (2026-10-28): not held for the platform.
   */
  runWithoutAsking?: string[];
  /**
   * The operator's boxes for scripts (2026-10-27): for each kind, whether the project's own may run and whether the
   * bot's may. Absent, the defaults: the project's run, the bot's are handed over. See `scriptKinds.ts`.
   */
  scripts?: ScriptRules;
  /**
   * What an unattended run does with a script the bot wrote that its box lets run: put it on a card with its text first
   * (`ask`, the default), or run it as any other step (`run`). A run that asks before every step asks about these too.
   */
  writtenScripts?: WrittenScriptsChoice;
};

export type NetworkFetchChoice = 'ask' | 'refuse' | 'run';

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


/** `git config`'s switches that read, and the ones that take the next word as their value. */
const GIT_CONFIG_READS = /^(?:--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list|-l|get|list)$/;
const GIT_CONFIG_VALUE = /^(?:--type|-t|--file|-f|--blob|--default|--comment|--value)$/;
const GIT_CONFIG_WRITES = /^(?:set|unset|edit|rename-section|remove-section|-e|--edit|--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section)$/;

/** Whether a line runs `git config` in any form that is not plainly a read: one key looked up, or a listing. */
function gitConfigWrites(command: string): boolean {
  for (const call of scanCommandHeads(command, 'pwsh').calls) {
    if (call.head.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase() !== 'git') continue;
    const args = call.args;
    let i = 0;
    // git's own options before the subcommand: `-C dir`, `-c k=v`, `--git-dir x`, `--no-pager`.
    while (i < args.length && args[i]!.literal.startsWith('-')) i += /^(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env)$/.test(args[i]!.literal) ? 2 : 1;
    if (args[i]?.literal.toLowerCase() !== 'config') continue;
    const rest = args.slice(i + 1);
    if (rest.some((a) => a.dynamic)) return true;
    let reads = false;
    const words: string[] = [];
    for (let k = 0; k < rest.length; k++) {
      const w = rest[k]!.literal;
      const flag = w.includes('=') && w.startsWith('-') ? w.slice(0, w.indexOf('=')) : w;
      if (GIT_CONFIG_WRITES.test(flag)) return true;
      if (GIT_CONFIG_READS.test(flag)) {
        reads = true;
        continue;
      }
      if (flag.startsWith('-')) {
        if (!w.includes('=') && GIT_CONFIG_VALUE.test(flag)) k++;
        continue;
      }
      words.push(w);
    }
    // `git config user.name` looks one key up; with a value after it, it sets one.
    if (!reads && words.length !== 1) return true;
    if (reads && words.length > 2) return true;
  }
  return false;
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
  /*
   * A path inside `.git`, and since the audit of 2026-10-27 the folder itself in a line that goes into it or writes:
   * `Set-Location .git; Add-Content config …` and `Add-Content (Join-Path .git config) …` reached the config with no
   * `.git\` in the line. A line that only names it (`Where-Object Name -ne '.git'`) is left alone.
   */
  const intoGitDir =
    /(^|[\s'"=(\\/,;])\.git[\\/]/i.test(command) ||
    (/(^|[\s'"=(\\/,;])\.git(?=$|[\s'"),;|])/i.test(command) &&
      /\b(Set-Location|sl|cd|chdir|pushd|Push-Location|Join-Path|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Remove-Item|Rename-Item|Tee-Object|sc|ac|ni|cp|copy|mv|move|rm|del|ren)\b|>/i.test(command));
  /*
   * A git setting written: every `git config` that is not plainly a read (audit, 2026-10-27). The form that wanted a
   * bare key and a value let `git config "filter.x.clean" "node fmt.js"`, `--type=bool`, `-z`, `git.exe config` and
   * the scopes past, and the runner's own git then ran the filter. `--config-env` sets a key for one command, as -c does.
   */
  const setting = gitConfigWrites(command) || /\bgit(?:\.exe)?\b[^|;\n]*\s--config-env\b/i.test(command);
  // `git -c key=value <command>` sets the key for that one command — and some keys name a program
  // git then starts (hooks, fsmonitor, the pager, the editor, credential helpers, filters, diff and
  // merge drivers, aliases), which the allowlist never sees. Those keys are refused inline as well.
  const inline =
    /\bgit\b[^|;\n]*?\s-c\s*["']?(?:core\.(?:hooksPath|fsmonitor|sshCommand|gitProxy|editor|pager|askPass|alternateRefsCommand|attributesFile)|credential\.|gpg\.|diff\.[^\s=]*\.(?:command|textconv)|difftool\.|mergetool\.|merge\.[^\s=]*\.driver|filter\.|alias\.|sequence\.editor|uploadpack\.|receive\.|http\.proxy|url\.)/i.test(
      command,
    );
  if (!intoGitDir && !setting && !inline) return null;
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
  /** Programs set to read only: a command of theirs that changes something is refused. See `readOnly.ts`. */
  readOnlyPrograms: string[] = [],
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
  const offlist = programRefusal(command, allowedPrograms, shell);
  if (offlist) return offlist;
  // A program on the list but set to read only, asked to change something (2026-10-26).
  const writes = readOnlyRefusal(command, shell, readOnlyPrograms);
  if (writes) return writes;
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
      programRefusal(text, allowedPrograms) ??
      // Inside a script nothing is put to the operator command by command: one that cannot be read as reading is refused.
      readOnlyUnaskedRefusal(text, undefined, readOnlyPrograms),
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
  cfg: Pick<PolicyConfig, 'denyPatterns' | 'allowedPrograms' | 'readOnlyPrograms'> & { questions?: 'ask' | 'agree' },
  confinement: Confinement,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const refusal = commandRefusal(command, shell, cfg.denyPatterns, cfg.allowedPrograms, env, confinement, cfg.readOnlyPrograms ?? []);
  if (refusal) return refusal;
  const access = checkAccessRefusal(command, shell, cfg);
  if (access) return access;
  const network = networkFetchReason(command, confinement.cwd) ?? scriptNetworkReason(command, confinement.cwd);
  return network ? networkFetchRefusal(network) : null;
}

/**
 * The gate for a check the reviewer wrote (audit, 2026-10-27): a check's gate, and the rules for the chat's own steps
 * in a run nobody watches, since such a check is kept and run at every later gate with no one asked — no allowed
 * interpreter evaluating a string, no shell inside a shell, and only the scripts the operator's boxes let run. Refused,
 * the finding stands without its check, as for any check the runner will not run.
 */
export function modelCheckRefusal(
  command: string,
  shell: Shell,
  cfg: Pick<PolicyConfig, 'denyPatterns' | 'allowedPrograms' | 'readOnlyPrograms' | 'scripts'> & { questions?: 'ask' | 'agree' },
  confinement: Confinement,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return (
    checkCommandRefusal(command, shell, cfg, confinement, env) ??
    inlineCodeRefusal(command) ??
    ownScriptRefusal(command, confinement.cwd, confinement.workStartedAt, shell, { rules: cfg.scripts, reviewer: true, screen: writtenScriptScreen(cfg, confinement, env) })
  );
}

/**
 * A check reaching a platform with the operator's access, which a step puts to the operator every time (2026-10-26):
 * a check has nobody to put it to, so it is refused unless Settings agree with what the bot proposes. A program set to
 * read only passes with a command that only reads; one that cannot be read as reading is refused.
 */
export function checkAccessRefusal(command: string, shell: Shell, cfg: Pick<PolicyConfig, 'readOnlyPrograms' | 'runWithoutAsking'> & { questions?: 'ask' | 'agree' }): string | null {
  const reading = readOnlyVerdict(command, shell, cfg.readOnlyPrograms);
  if (reading?.kind === 'unclear') return readOnlyUnclearRefusal(reading.program, reading.why);
  const platform = cfg.questions === 'agree' ? null : platformReason(command, shell, notHeldFor(cfg, reading?.kind === 'reads' ? reading.programs : []));
  if (!platform) return null;
  return `refused: this check reaches ${platform} with the operator's access, which only the operator may allow, and a check runs with nobody asked. Check it another way, or do it in a step, where it is put to the operator.`;
}

/**
 * The gate a script the bot wrote is read through when the operator's box lets it run (2026-10-27): its text, as a
 * line of its own. A `.ps1` is read by `scriptFileRefusal` in every case; a `.cmd` or `.bat` and a script of package.json
 * (which npm hands to cmd) by the whole gate for cmd; a bash script by the rules that read text — refused techniques,
 * the bot's own things, the repository's machinery, the deny list, the project's folders — since what it starts are
 * bash's tools, not Windows programs. A script of package.json may start what the project installed
 * (`node_modules/.bin`). A file of code (`.ts`, `.js`, `.py`) is code, and is not read.
 */
export function writtenScriptScreen(cfg: Pick<PolicyConfig, 'denyPatterns' | 'allowedPrograms' | 'readOnlyPrograms'>, confinement: Confinement, env: NodeJS.ProcessEnv = process.env): (run: ScriptRun, text: string) => string | null {
  return (run, text) => {
    if (run.kind === 'cmd') return commandRefusal(text, 'cmd', cfg.denyPatterns, cfg.allowedPrograms, env, confinement, cfg.readOnlyPrograms ?? []);
    if (run.kind === 'npm') {
      const bin = join(dirname(run.file), 'node_modules', '.bin');
      const installed = existsSync(bin) ? readdirSync(bin).map((n) => n.replace(/\.(?:cmd|ps1|exe)$/i, '')) : [];
      const allowed = cfg.allowedPrograms.length ? [...cfg.allowedPrograms, ...installed] : [];
      return commandRefusal(text, 'cmd', cfg.denyPatterns, allowed, env, confinement, cfg.readOnlyPrograms ?? []);
    }
    if (run.kind === 'sh') {
      const deny = matchDenyPattern(text, cfg.denyPatterns);
      return dangerousRefusal(text) ?? botSelfRefusal(text) ?? repositoryInternalsRefusal(text) ?? (deny ? `refused: matches deny pattern /${deny}/` : null) ?? confinementRefusal(text, confinement);
    }
    return null;
  };
}

/**
 * The programs whose platform a command is not held for: those set to run without asking (2026-10-28), and those set to
 * read only whose every command on the line only reads.
 */
export function notHeldFor(cfg: Pick<PolicyConfig, 'runWithoutAsking'>, reading: readonly string[]): Set<string> | undefined {
  const all = [...(cfg.runWithoutAsking ?? []), ...reading].map((p) => p.trim().toLowerCase().replace(/\.(?:exe|cmd)$/, '')).filter(Boolean);
  return all.length ? new Set(all) : undefined;
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
  /** Whose step: the reviewer is told to check another way, since a review hands nothing over. */
  actor?: string,
): PolicyDecision | null {
  /*
   * The project's own scripts, and the bot's only where the operator's box lets them (2026-10-21, boxes 2026-10-27): a
   * script the chat wrote is otherwise not run, however it is called, and one it is let run is read first. First, so
   * the chat is told that, and not the older advice of the shared gate to write a script in one step and run it in the
   * next. See `scriptFiles.ts`.
   */
  if (confinement) {
    // No script written only to be run (operator, 2026-10-28): one written into .cop-tmp is refused at the writing.
    const scratch = scratchScriptRefusal(step.cmd, actor === 'review');
    if (scratch) return { action: 'skip', reason: scratch };
    const own = ownScriptRefusal(step.cmd, confinement.cwd, confinement.workStartedAt, effectiveShell(step.shell), {
      rules: cfg.scripts,
      reviewer: actor === 'review',
      screen: writtenScriptScreen(cfg, confinement, env),
    });
    if (own) return { action: 'skip', reason: own };
  }
  // Screened against the shell that will actually read it: the traps in `shellExecuteTrap.ts`
  // are shell-specific, so screening for one interpreter and running in another finds nothing.
  const reason = commandRefusal(step.cmd, effectiveShell(step.shell), cfg.denyPatterns, cfg.allowedPrograms, env, confinement, cfg.readOnlyPrograms ?? []);
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
