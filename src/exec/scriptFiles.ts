/**
 * The script files a command line runs, read so that what is in them passes the same gate as the
 * line itself.
 *
 * The contract tells the chat to write a long script into the project with `Set-Content` and run
 * it in the next step with `pwsh -File`. The file's text is then screened twice: once as the text
 * of the step that wrote it, and — since 2026-09-27 — again here, as the file on disk, when a step
 * runs it. The second reading is the one that counts: it sees the file as it is, not as it was
 * described.
 *
 * Two rules follow from that:
 *
 *   - A step that both writes a script and runs it is refused. The contract already says write in
 *     one step, run in the next; only then does the file exist to be read at the gate.
 *   - A step that runs a script the gate cannot read — the file is missing, or larger than a step's
 *     worth of text — is refused with that reason rather than run on trust.
 *
 * Covered: PowerShell scripts given to `-File`, dot-sourced, or called with `&` or by path. Not
 * covered, and stated so: a `.js`, `.py` or `.cs` file a project's own tools run. Those are the
 * project's code, and this runner has never claimed to read it; the boundary there is isolation.
 *
 * And since 2026-10-21, for the chat's steps, a third rule (`ownScriptRefusal`): only the project's own scripts run
 * at all. The operator: "I do not want the project to run scripts downloaded from the internet, or ones it created
 * itself — everything is dynamic, not from files", then "that is for scripts from the internet; the ones that are
 * part of it and needed stay", and "npm and the like of course; I mean only scripts from files, not whether the bot
 * runs the tests or the back end". What the chat writes comes from Copilot, a service on the internet, so a script
 * it wrote is a script from the internet. A script file a step runs must therefore be the project's own: committed
 * in its repository, unchanged since, last committed by someone other than the runner and before the work began;
 * nothing is run from `.cop-tmp`. What a step does it says in the step itself, which may be several lines.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { gitSync, RUNNER_EMAIL } from '../vcs/git.js';

/** Larger than this is not a step's script; it is not read, and running it is refused. */
const MAX_SCRIPT_BYTES = 256 * 1024;

export type ScriptFile = { path: string; text: string | null; problem?: string };

/** Paths of PowerShell scripts this command line runs, as written. */
export function scriptPathsRun(command: string): string[] {
  const paths = new Set<string>();
  const patterns = [
    /\b(?:pwsh|powershell)(?:\.exe)?\b[^|;\n]*?\s-(?:File|f)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/gi,
    /(?:^|[|;&(\n{]\s*)(?:[.&]\s+)?(?:"([^"]+\.ps1)"|'([^']+\.ps1)'|(\S+\.ps1))(?=\s|$)/gi,
  ];
  for (const re of patterns) {
    for (const m of command.matchAll(re)) {
      const p = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      if (p && /\.ps1$/i.test(p)) paths.add(p);
    }
  }
  return [...paths];
}

/** Whether the command also writes a PowerShell script — with a cmdlet or a redirection. */
export function writesScript(command: string): boolean {
  return /\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|sc|ac|cp|copy|mv|move|ren|ni)\b[^|;\n]*\.ps1\b|>\s*["']?[^\s"']*\.ps1\b/i.test(command);
}

/** Reads the scripts a command runs, relative to `cwd`. */
export function scriptFilesRun(command: string, cwd: string): ScriptFile[] {
  return scriptPathsRun(command).map((p) => {
    const path = isAbsolute(p) ? p : resolve(cwd, p);
    try {
      const size = statSync(path).size;
      if (size > MAX_SCRIPT_BYTES) return { path, text: null, problem: `${path} is ${size} bytes, larger than a step's script` };
      return { path, text: readFileSync(path, 'utf8') };
    } catch {
      return { path, text: null, problem: `${path} does not exist yet, so its contents cannot be read before it runs` };
    }
  });
}

/**
 * Why the scripts this line runs must not run, or null. `screen` is the gate applied to each
 * script's text — the same one the command line went through.
 */
export function scriptFileRefusal(command: string, cwd: string, screen: (text: string) => string | null): string | null {
  const paths = scriptPathsRun(command);
  if (paths.length === 0) return null;
  if (writesScript(command)) {
    return (
      'refused: this step writes a script and runs it in the same line. Write the file in one step and run it in the ' +
      'next, so that what is in the file can be read before it runs.'
    );
  }
  for (const file of scriptFilesRun(command, cwd)) {
    if (file.text === null) return `refused: ${file.problem}. Write the file in an earlier step, then run it.`;
    const reason = screen(file.text);
    if (reason) return `${reason} (in the script ${file.path})`;
  }
  return null;
}

/** The folder for scratch files (`vcs/artifacts.ts` keeps it out of every commit); nothing in it is run. */
const SCRATCH = '.cop-tmp';
/** A program that runs a file it is given: the shells, the scripting runtimes, the TypeScript runners. */
const RUNS_A_FILE = String.raw`(?:node|nodejs|python3?|py|pwsh|powershell|cmd|tsx|ts-node|deno|bun|ruby|perl|php|cscript|wscript|bash|sh|java|dotnet|npx|vitest|jest|mocha)`;

/**
 * The script files a command line runs — PowerShell's `.ps1` and `.psm1`, cmd's `.cmd` and `.bat`, bash's `.sh`,
 * Windows Script Host's `.vbs`, `.wsf` and the rest — as full paths:
 * given to `-File`, dot-sourced, called with `&` or by a path, passed to `cmd /c`, started with Start-Process, or
 * imported as a module. A bare name counts only when that file is in the folder, where cmd and Start-Process look
 * first; otherwise it is a program found on PATH — `npm.cmd`, `npx.cmd` — and not one of the project's files.
 */
export function shellScriptsRun(command: string, cwd: string): string[] {
  const named = new Set<string>(scriptPathsRun(command));
  const patterns = [
    /(?:^|[|;&(\n{]\s*)(?:[.&]\s+)?(?:"([^"]+\.(?:ps1|psm1|cmd|bat))"|'([^']+\.(?:ps1|psm1|cmd|bat))'|(\S+\.(?:ps1|psm1|cmd|bat)))(?=\s|$)/gi,
    /\bcmd(?:\.exe)?\b[^|;\n]*?\s\/[ck]\s+(?:"([^"]+\.(?:cmd|bat))"|'([^']+\.(?:cmd|bat))'|(\S+\.(?:cmd|bat)))/gi,
    /\b(?:Start-Process|saps)\b[^|;\n]*?(?:"([^"]+\.(?:ps1|cmd|bat))"|'([^']+\.(?:ps1|cmd|bat))'|([^\s'",]+\.(?:ps1|cmd|bat)))/gi,
    /\b(?:Import-Module|ipmo)\b[^|;\n]*?(?:"([^"]+\.psm1)"|'([^']+\.psm1)'|(\S+\.psm1))/gi,
    // A shell script for bash and its kin (Git Bash, WSL), by a path or given to the shell.
    /(?:^|[|;&(\n{]\s*)(?:"([^"]+\.(?:sh|bash|zsh))"|'([^']+\.(?:sh|bash|zsh))'|(\S+\.(?:sh|bash|zsh)))(?=\s|$)/gi,
    /\b(?:bash|sh|zsh|ksh|dash|wsl)(?:\.exe)?\b[^|;\n]*?\s(?:"([^"]+\.(?:sh|bash|zsh))"|'([^']+\.(?:sh|bash|zsh))'|(\S+\.(?:sh|bash|zsh)))/gi,
    // Windows Script Host's scripts.
    /\b(?:wscript|cscript)(?:\.exe)?\b[^|;\n]*?\s(?:"([^"]+\.(?:vbs|vbe|js|jse|wsf|wsh))"|'([^']+\.(?:vbs|vbe|js|jse|wsf|wsh))'|(\S+\.(?:vbs|vbe|js|jse|wsf|wsh)))/gi,
    /(?:^|[|;&(\n{]\s*)(?:[.&]\s+)?(?:"([^"]+\.(?:vbs|vbe|wsf|wsh|hta))"|'([^']+\.(?:vbs|vbe|wsf|wsh|hta))'|(\S+\.(?:vbs|vbe|wsf|wsh|hta)))(?=\s|$)/gi,
  ];
  for (const re of patterns) {
    for (const m of command.matchAll(re)) {
      const p = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      if (p) named.add(p);
    }
  }
  const files = new Set<string>();
  for (const p of named) {
    const full = isAbsolute(p) ? p : resolve(cwd, p);
    if (!/[\\/]/.test(p) && !existsSync(full)) continue;
    files.add(full);
  }
  return [...files];
}

/** Whether a path lies in the scratch folder, at any depth. */
const inScratch = (path: string): boolean => path.split(/[\\/]+/).some((part) => part.toLowerCase() === SCRATCH);

/**
 * Why a script is not one of the project's own, or null when it is: in its repository, committed, unchanged since,
 * last committed by someone other than the runner and, when `since` is known, before the work began.
 */
export function notTheProjects(file: string, since?: string): string | null {
  if (inScratch(file)) return `it is in ${SCRATCH}, the folder for scratch files, and nothing there is run`;
  if (!existsSync(file)) return 'it does not exist';
  const top = gitSync(dirname(file), ['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.stdout) return 'it is not in a git repository, so nothing tells it apart from a script written during the work';
  const rel = relative(top.stdout, file);
  const path = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : file;
  if (!gitSync(top.stdout, ['ls-files', '--error-unmatch', '--', path]).ok) return 'it is not committed in its repository';
  const diff = gitSync(top.stdout, ['diff', '--quiet', 'HEAD', '--', path]);
  if (diff.code === 1) return 'it was changed since it was last committed';
  if (!diff.ok) return `git could not compare it with its last commit${diff.stderr ? ` (${diff.stderr.split('\n')[0]})` : ''}`;
  const last = gitSync(top.stdout, ['log', '-1', '--format=%ae%x09%ct', '--', path]);
  const [email = '', time = ''] = last.stdout.split('\t');
  if (email.trim().toLowerCase() === RUNNER_EMAIL) return 'its last commit was made by copilot-operator, so it was written during the work';
  const began = since ? Date.parse(since) : NaN;
  if (Number.isFinite(began) && Number(time) * 1000 >= began - 1000) return 'it was committed after this work began, so it was written during the work';
  return null;
}

/**
 * Why a chat's step must not run a script, or null: a shell script that is not one of the project's own (see
 * `notTheProjects`), or any file in `.cop-tmp` given to a program that runs it. Only for the chat's steps, the
 * implementer's and the reviewer's: the operator's own checks are theirs to point at whatever they choose.
 */
export function ownScriptRefusal(command: string, cwd: string, since?: string): string | null {
  // A file of code in it, given to a program that runs files — not its output written there (`node x.js > .cop-tmp\out.txt`).
  const scratch = new RegExp(
    String.raw`\b${RUNS_A_FILE}(?:\.exe|\.cmd)?\b[^|;\n]*?(?:^|[\s'"=(,:])(?:\.[\\/])?(?:[^\s'"|;]*[\\/])?\.cop-tmp[\\/][^\s'"|;]*\.(?:ps1|psm1|cmd|bat|js|mjs|cjs|jsx|ts|mts|cts|tsx|py|rb|pl|php|vbs|vbe|wsf|sh|jar|dll|exe|csx)\b`,
    'i',
  );
  const why = (file: string, reason: string): string =>
    `refused: ${relative(cwd, file) || file} is not one of the project's own scripts — ${reason}. A script written or ` +
    'changed during the work is not run, nor anything in .cop-tmp (the operator\'s rule). Put what it does in the ' +
    'step itself: a command may be several lines. If the script is meant to be part of the project, say so in "notes", ' +
    'and the operator can commit it.';
  for (const file of shellScriptsRun(command, cwd)) {
    const reason = notTheProjects(file, since);
    if (reason) return why(file, reason);
  }
  if (scratch.test(command)) {
    return (
      'refused: this runs a file in .cop-tmp, the folder for scratch files — nothing there is run (the operator\'s rule). ' +
      'Put what it does in the step itself: a command may be several lines.'
    );
  }
  return null;
}
