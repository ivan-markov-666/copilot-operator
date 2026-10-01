/**
 * Which Windows shell a command is handed to, decided in one place for everything that runs.
 *
 * This module exists because the runner had four opinions about shells and no way to reconcile
 * them. A step carried whatever the parser had filled in, a check fell back to `pwsh` in
 * `checks.ts`, the policy gate assumed `pwsh` while it screened a command for traps, and the
 * runner itself turned all of that into a bare `pwsh.exe` for `spawn`. On the machine the bot
 * was written on those four opinions happened to agree, so nothing ever disagreed loudly enough
 * to be noticed. On a second Windows machine, which has Windows PowerShell and `cmd` but no
 * PowerShell 7, every one of them resolved to an executable that is not there: the tasks and
 * the post-task checks died of `spawn ENOENT` while the very same commands ran perfectly
 * through `cmd`, and the task spent its retry rounds asking a language model to fix an
 * interpreter it cannot install.
 *
 * So the knowledge of what a shell is called, where it lives and how it is invoked is gathered
 * here, and two questions are kept deliberately apart. `resolveShell` answers the executable
 * question — may this run, and with what — and it is allowed to refuse; a shell that was asked
 * for by name and is not installed is a configuration fault, reported as one, and never quietly
 * swapped for a different interpreter that would read the same command differently.
 * `effectiveShell` answers the cheaper question of which shell a command will be read by, which
 * is what a label in the log and the syntax-trap screen need, and it never refuses.
 *
 * Nothing is substituted behind anybody's back, but a machine that has a usable shell does get
 * to use it: when nothing named a shell, the fallback order is PowerShell 7, then Windows
 * PowerShell, then `cmd`, because that is the order of how much of what this bot sends will
 * actually be understood.
 *
 * Detection is a set of file-system lookups rather than a set of child processes, so it costs
 * nothing to do at the start of a run, and it is cached like the rest of the environment probes
 * for the same reason they are: a shell does not appear halfway through a task.
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type Shell = 'pwsh' | 'powershell' | 'cmd';

/**
 * The order a command that named no shell is offered to them in.
 *
 * Most of what reaches this runner is PowerShell, written by a model that was asked for
 * PowerShell, so the two PowerShells come first and the more capable one comes before the
 * older one. `cmd` is last and is a genuine last resort: it is on every Windows machine ever
 * made, which is the only reason it is in the list at all.
 */
export const SHELL_ORDER: readonly Shell[] = ['pwsh', 'powershell', 'cmd'];

/** What each shell is called on disk. */
const EXECUTABLE: Record<Shell, string> = {
  pwsh: 'pwsh.exe',
  powershell: 'powershell.exe',
  cmd: 'cmd.exe',
};

/** What to tell somebody whose machine does not have one, as the second half of a sentence. */
const REMEDY: Record<Shell, string> = {
  pwsh: 'install PowerShell 7 (winget install Microsoft.PowerShell)',
  powershell: 'repair the Windows PowerShell that ships with Windows',
  cmd: 'repair the Windows installation; cmd.exe is part of it',
};

/** Where this machine has each shell, or `null` for the ones it does not have. */
export type ShellInventory = {
  detectedAt: string;
  found: Record<Shell, string | null>;
};

/** One shell, looked for: its executable, or null when this machine has not got it. */
export type ShellProber = (shell: Shell) => string | null;

/** A shell that will actually run something, and the executable that will be started. */
export type ResolvedShell = {
  /** What the step or the check asked for, or null when it named none. */
  requested: Shell | null;
  /** The shell it is going to run in. */
  shell: Shell;
  /** The executable that will be spawned, resolved to a full path. */
  path: string;
};

/**
 * Why nothing can be run, said in a way somebody can act on.
 *
 * This is a fault of the machine rather than of the work, and the difference is the whole
 * point of the type: a caller that can tell the two apart is a caller that will not spend a
 * task's retry rounds on it.
 */
export type ShellProblem = {
  /** The shell that was asked for by name, when one was. */
  requested: Shell | null;
  /** What this machine does have, so the answer is in the message and not in a second step. */
  available: Shell[];
  /** One sentence: what was wanted, what is here, and what to install or set. */
  message: string;
};

export type ShellChoice = { ok: true; resolved: ResolvedShell } | { ok: false; problem: ShellProblem };

let cached: ShellInventory | null = null;

/** The usual places a shell sits when PATH has been trimmed or has not been inherited. */
function wellKnownPaths(shell: Shell, env: NodeJS.ProcessEnv): string[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const systemRoot = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  switch (shell) {
    case 'pwsh':
      // 7 first: a machine with both is a machine that installed 7 on purpose.
      return [join(programFiles, 'PowerShell', '7', 'pwsh.exe'), join(programFiles, 'PowerShell', '6', 'pwsh.exe')];
    case 'powershell':
      return [join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
    case 'cmd':
      return [join(systemRoot, 'System32', 'cmd.exe')];
  }
}

/**
 * Looks one shell up the way the operating system would, and then in the places it lives.
 *
 * PATH is walked by hand rather than asked of `where.exe`, because this runs at the start of
 * every run and a file-system lookup costs nothing next to a child process — and because a
 * machine whose PATH is broken is exactly the machine this is trying to help.
 */
function findOnDisk(shell: Shell, env: NodeJS.ProcessEnv = process.env): string | null {
  const exe = EXECUTABLE[shell];
  const path = env.PATH ?? env.Path ?? '';
  for (const dir of path.split(delimiter)) {
    // A PATH entry may be quoted, and a quoted directory joined as-is finds nothing.
    const clean = dir.trim().replace(/^"|"$/g, '');
    if (!clean) continue;
    const candidate = join(clean, exe);
    if (existsSync(candidate)) return candidate;
  }
  for (const candidate of wellKnownPaths(shell, env)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * What this machine has, collected once and reused.
 *
 * `fresh` re-probes, the way the environment manifest does. `probe` replaces the lookup
 * altogether and also replaces what is cached, which is how a test describes a machine that is
 * not this one — a machine without PowerShell 7 cannot otherwise be reasoned about from a
 * machine that has it, and installing and uninstalling an interpreter to make a point is not a
 * test, it is an afternoon.
 */
export function detectShells(opts: { fresh?: boolean; probe?: ShellProber } = {}): ShellInventory {
  if (cached && !opts.fresh && !opts.probe) return cached;
  const probe = opts.probe ?? ((shell: Shell) => findOnDisk(shell));
  cached = {
    detectedAt: new Date().toISOString(),
    found: {
      pwsh: probe('pwsh'),
      powershell: probe('powershell'),
      cmd: probe('cmd'),
    },
  };
  return cached;
}

/** An inventory of exactly the shells named, for a caller that already knows what is there. */
export function inventoryOf(found: Partial<Record<Shell, string>>): ShellInventory {
  return detectShells({ probe: (shell) => found[shell] ?? null });
}

/** The shells this machine has, in the order a command that named none is offered to them. */
export function availableShells(inventory: ShellInventory = detectShells()): Shell[] {
  return SHELL_ORDER.filter((shell) => inventory.found[shell]);
}

function problemFor(requested: Shell | null, inventory: ShellInventory): ShellProblem {
  const available = availableShells(inventory);
  const here = available.length > 0 ? `what this machine has is ${available.join(', ')}` : 'this machine appears to have no shell at all';
  const message =
    requested === null
      ? `no Windows shell was found on this machine: none of ${SHELL_ORDER.map((s) => EXECUTABLE[s]).join(', ')} is on PATH or in its usual place. ` +
        'Nothing can be run until one of them is.'
      : `${EXECUTABLE[requested]} is not on this machine, and it was asked for by name, so nothing was substituted for it. ` +
        `To run this, ${REMEDY[requested]}, or ask for one of the shells that are here instead — ${here}. ` +
        'A step or a check names its shell in "shell"; the standing default is execution.defaultShell in the config.';
  return { requested, available, message };
}

/**
 * Which shell something runs in, and whether it may run at all.
 *
 * A named shell is honoured or refused, never exchanged: a command written for PowerShell and
 * quietly handed to `cmd` does not fail, it does something else, and finding that out from a
 * task's output costs more than the refusal ever would. A command that named no shell takes
 * the first shell this machine has, in `SHELL_ORDER`.
 */
export function resolveShell(requested?: Shell | null, inventory: ShellInventory = detectShells()): ShellChoice {
  if (requested) {
    const path = inventory.found[requested];
    return path
      ? { ok: true, resolved: { requested, shell: requested, path } }
      : { ok: false, problem: problemFor(requested, inventory) };
  }
  const shell = availableShells(inventory)[0];
  return shell
    ? { ok: true, resolved: { requested: null, shell, path: inventory.found[shell] as string } }
    : { ok: false, problem: problemFor(null, inventory) };
}

/**
 * The same refusal, addressed to the chat instead of to the operator.
 *
 * `problemFor` writes for a person: install PowerShell 7, or set `execution.defaultShell`. Both
 * are true and neither is anything a language model can do, and this runner already knows what
 * happens when a model is handed an instruction it cannot carry out — it tries something else,
 * fails the same way, and spends the round. So a step refused for its shell gets the half of the
 * fact it can act on: what is here, and what to write instead.
 *
 * `fallback` is the shell a step that names none actually gets, which is not always the first one
 * the machine has: `execution.defaultShell` decides it whenever the machine has that shell. The
 * two have to be named by the same value or the message offers a choice between two things it
 * calls equivalent and are not.
 */
export function refusalForChat(problem: ShellProblem, fallback?: Shell): string {
  if (problem.available.length === 0) {
    return (
      'this machine has no Windows shell the runner can find, so nothing can be run on it at all. ' +
      'Do not send more steps: end the task with status "blocked" and say that the machine has no shell.'
    );
  }
  const use = fallback && problem.available.includes(fallback) ? fallback : problem.available[0];
  const named = problem.requested ? `\`${problem.requested}\` is not installed on this machine` : 'the shell this step asked for is not installed on this machine';
  return (
    `${named}, and nothing was substituted for it, because a command written for one shell and read by ` +
    `another does not fail — it does something else. This machine has ${problem.available.map((s) => `\`${s}\``).join(' and ')}. ` +
    `Send this step again with \`"shell": "${use}"\`, or leave \`shell\` out and the runner uses \`${use}\`, and write the ` +
    `command for that shell. Do not ask for anything to be installed: nothing in this conversation can install it.`
  );
}

/**
 * Which shell a command will be read by, for a label or for a screen of its syntax.
 *
 * Never refuses, because neither of those callers is about to start a process: describing a
 * step in the log and deciding whether a command contains a trap both need a name, and a name
 * they can always be given. Whether the thing may actually run is `resolveShell`'s question.
 *
 * A shell that was named and is not installed keeps its name here rather than falling through
 * the order. It is not going to run in anything, so the honest label is the one that says what
 * was asked for — which is also what the refusal, when it comes, will be about.
 */
export function effectiveShell(requested?: Shell | null, inventory: ShellInventory = detectShells()): Shell {
  const choice = resolveShell(requested, inventory);
  return choice.ok ? choice.resolved.shell : (requested ?? SHELL_ORDER[0]);
}

/**
 * The standing default, checked against what is here.
 *
 * `execution.defaultShell` is a preference and not an instruction: nothing wrote it for this
 * task, it is what a step or a check gets when it says nothing at all, and a machine that has
 * not got it should fall through the order rather than fail every command with a spawn error.
 * A shell a reply or a plan named for itself goes through `resolveShell` and is never treated
 * this way.
 */
export function preferredShell(configured: Shell, inventory: ShellInventory = detectShells()): Shell {
  return inventory.found[configured] ? configured : (availableShells(inventory)[0] ?? configured);
}

/**
 * What the chat is told about this machine's shells, or nothing when there is nothing to say.
 *
 * The contract in `prompts/level1.md` shows `"shell": "pwsh"` in its one worked example, and a
 * model writing to an example copies the example. On the machine the bot was written on that is
 * harmless, because `pwsh` is there. On a machine with only Windows PowerShell it is the whole
 * problem: every first reply names an interpreter that does not exist, every step is refused, and
 * a round is spent discovering something the runner knew before the conversation opened.
 *
 * So it is said up front — but only when it is not already true. A machine with PowerShell 7 gets
 * no note at all, which is deliberate: the contract is already right there, and a paragraph
 * repeating it is a paragraph of context spent saying nothing.
 */
export function shellNote(inventory: ShellInventory = detectShells(), fallback?: Shell): string | undefined {
  if (inventory.found.pwsh) return undefined;
  const available = availableShells(inventory);
  const lines =
    available.length === 0
      ? [
          '## Shells on this machine',
          '',
          'This machine has none of pwsh.exe, powershell.exe or cmd.exe where the runner can find them.',
          'No command can be run until that is fixed. End the task with status "blocked", and fill',
          '"tried" — the format wants two entries there — with what you attempted and this refusal.',
        ]
      : (() => {
          const chosen = fallback && inventory.found[fallback] ? fallback : available[0];
          return [
            '## Shells on this machine',
            '',
            `**PowerShell 7 (\`pwsh\`) is not installed here.** This machine has ${available.map((s) => `\`${s}\``).join(' and ')}.`,
            `A step that names \`"shell": "pwsh"\` is refused and has to be written again, so do not name it:`,
            `write \`"shell": "${chosen}"\`, or leave \`shell\` out, and the runner uses \`${chosen}\`.`,
            '',
            chosen === 'cmd'
              ? 'Write the commands for `cmd` rather than for PowerShell: no cmdlets, no pipelines of objects, no `$PSVersionTable`.'
              : 'Windows PowerShell 5.1 is not PowerShell 7: no `??`, no `?.`, no ternary operator, and `Invoke-RestMethod` behaves differently.',
          ];
        })();
  return lines.join('\n');
}

/**
 * How one shell is asked to run one command.
 *
 * The flags are not incidental: no profile so that a machine's own startup script cannot change
 * what a step does, and non-interactive so that a prompt is an error rather than a hang.
 *
 * No `-ExecutionPolicy` at all, since 2026-09-27. It was `Bypass` for the file steps that no longer
 * exist, then `RemoteSigned` for a day. The operator's decision: the machine's own policy applies,
 * whatever it is. On a company laptop that policy is set by the administrators, and a process that
 * overrides it on every command line — even to a value they would agree with — is exactly the
 * process their tooling is told to look at; and a policy the runner cannot change is one more thing
 * a security review can take at face value. The cost is on a machine set to `Restricted` or
 * `AllSigned`: the `.ps1` shims that npm and its kin install are then refused, and the chat is told
 * (in the contract) to call the `.cmd` form of the tool instead.
 *
 * `cmd` is given its command line exactly as written, which is the other thing here that is not
 * incidental. Left to itself, Node quotes every argument by the rules the C runtime splits a command
 * line with, and those rules escape a double quote with a backslash. `cmd` does not split its command
 * line by them and has no such escape, so every quote in a step reached it as `\"`: `echo "hello
 * world"` printed the backslashes, `node -e "console.log(1+1)"` handed node a string literal that
 * printed nothing, and a quoted path such as `"C:\Program Files\nodejs\node.exe"` was looked up with
 * the backslashes in its name and not found. So, as Node does for itself under `shell: true`, the
 * line is passed verbatim and wrapped in one more pair of quotes: with `/s`, `cmd` removes exactly the
 * first and the last quote on the line, which are those two, and reads everything between them as it
 * was written. A script is run the same way, its path quoted and each argument quoted for `cmd` by
 * `cmdArgument`, because nothing else quotes them any more. PowerShell is not touched: it reads its
 * arguments by the C runtime's rules, and Node's quoting is the right quoting for it.
 */
export function invocationFor(
  resolved: ResolvedShell,
  command: string,
  scriptArgs?: string[],
): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  const isScript = Array.isArray(scriptArgs);
  switch (resolved.shell) {
    case 'pwsh':
    case 'powershell': {
      const base = ['-NoProfile', '-NonInteractive'];
      return isScript
        ? { file: resolved.path, args: [...base, '-File', command, ...(scriptArgs ?? [])], windowsVerbatimArguments: false }
        : { file: resolved.path, args: [...base, '-Command', command], windowsVerbatimArguments: false };
    }
    case 'cmd': {
      const line = isScript ? [`"${command}"`, ...(scriptArgs ?? []).map(cmdArgument)].join(' ') : command;
      return { file: resolved.path, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
    }
  }
}

/**
 * One argument to a script run in `cmd`, written so that it arrives as the one argument it is.
 *
 * The line is passed verbatim, so nothing quotes this on the way and it has to be done here, for the
 * reader that is actually there. A space would make one argument two. `&`, `|`, `<` and `>` would
 * make the rest of it a second command or a redirection, `^` would be taken as an escape and the
 * parentheses as a group, and a quote is the only thing that makes `cmd` read any of them as text.
 * `,`, `;` and `=` divide a batch file's arguments the way a space does. `%` quotes an argument too: `%NAME%` is expanded inside quotes as well as outside,
 * as it is anywhere on a `cmd` line, but what it expands to then stays inside this argument.
 *
 * Inside the quotes, a program built on the C runtime gets back exactly what was given. The
 * backslashes in front of a quote are doubled, which its rules ask for, and a quote is written `""`,
 * which it reads as one quote. `\"` would not do: `cmd` counts every quote, with or without a
 * backslash, so it would take that one as the end of the quoted text and run whatever came after it.
 * A batch file sees an inner quote and a closing backslash doubled, which is as near as `cmd` lets
 * anything come.
 */
function cmdArgument(arg: string): string {
  if (arg !== '' && !/[\s"&|<>^(),;=%]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * A shell that was found at detection time and would not start when it was wanted.
 *
 * Rare and worth saying plainly: an interpreter that was uninstalled during the run, a PATH
 * entry pointing at a folder that has gone, an antivirus holding the file. It is the same class
 * of fault as a missing shell — the machine, not the work — so it is reported the same way.
 */
export function missingShellProblem(resolved: ResolvedShell, inventory: ShellInventory = detectShells()): ShellProblem {
  const others = availableShells(inventory).filter((s) => s !== resolved.shell);
  return {
    requested: resolved.requested,
    available: availableShells(inventory),
    message:
      `${resolved.path} would not start, although ${EXECUTABLE[resolved.shell]} was found there when this run began. ` +
      `Check that it is still installed and still on PATH${others.length > 0 ? `, or run this in ${others.join(' or ')} instead` : ''}. ` +
      `If it has gone, ${REMEDY[resolved.shell]}.`,
  };
}
