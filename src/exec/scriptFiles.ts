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
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { gitSync, RUNNER_EMAIL } from '../vcs/git.js';
import { scanCommandHeads, type CallArg, type CommandCall } from './commandHeads.js';
import { packageScriptsRun, packageScriptWritten, writesPackageScripts } from './npmScripts.js';
import { DEFAULT_SCRIPT_RULES, kindForChat, kindOfFile, type ScriptKind, type ScriptRule, type ScriptRules } from './scriptKinds.js';

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
  if (inScratch(file)) return `it is in ${SCRATCH}, the folder for scratch files`;
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

/** The runtimes a file of code is given to, by the program's name. */
const CODE_RUNTIMES = new Set(['node', 'nodejs', 'tsx', 'ts-node', 'ts-node-esm', 'python', 'python3', 'pythonw', 'py', 'deno', 'bun', 'ruby', 'perl', 'php']);
/** What a package runner starts that runs a file of code: `npx ts-node x.ts`, `npx tsx x.ts`. */
const RUN_THROUGH = new Set(['npx', 'pnpx', 'bunx']);
/** A package manager's word that makes it a package runner: `npm exec`, `pnpm exec`, `pnpm dlx`, `yarn dlx`, `yarn exec`. */
const RUNNER_WORDS: Record<string, ReadonlySet<string>> = { npm: new Set(['exec', 'x']), pnpm: new Set(['exec', 'dlx']), yarn: new Set(['exec', 'dlx']) };
/** A package runner's switches that take the next word: `--package tsx`, `-p tsx`. */
const RUNNER_VALUE = /^(?:-p|--package|-w|--workspace|--prefix|-C|--dir|--cwd|--filter|-F)$/;
/** A runtime's switches whose value is a file of code it loads before the one it runs: `node -r ./hook.js x.js`. */
const LOADS_CODE = /^(?:-r|--require|--import|--loader|--experimental-loader|--preload)$/;
/** A runtime's other switches that take the next word, which is not the file it runs. */
const RUNTIME_VALUE = /^(?:-m|--title|--env-file|--inspect-port|--max-old-space-size|--conditions|-C|--input-type|--tsconfig|--project|-P)$/;
const CODE_FILE = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|py|pyw|rb|pl|php)$/i;

const programOf = (head: string): string => head.replace(/^.*[\\/]/, '').replace(/\.(?:exe|cmd)$/i, '').toLowerCase();

/** `Start-Process node -ArgumentList 'tools/x.js'`: the program it starts and the words it is given, as a call of its own. */
function startedProcesses(command: string): CommandCall[] {
  const calls: CommandCall[] = [];
  for (const m of command.matchAll(/\b(?:Start-Process|saps)\b([^|;\n]*)/gi)) {
    const words = [...m[1]!.matchAll(/"([^"]*)"|'([^']*)'|([^\s,]+)/g)].map((w) => w[1] ?? w[2] ?? w[3] ?? '');
    let program: string | undefined;
    const args: CallArg[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (/^-(?:FilePath|f)$/i.test(w)) program = words[++i];
      else if (/^-(?:ArgumentList|Args|a)$/i.test(w)) {
        while (i + 1 < words.length && !/^-[A-Za-z]+$/.test(words[i + 1]!)) args.push({ literal: words[++i]!, dynamic: /^\$/.test(words[i]!) });
        // A value that is itself a list of words: `-ArgumentList 'tools/x.js --flag'`.
        if (args.length === 1 && /\s/.test(args[0]!.literal)) args.splice(0, 1, ...args[0]!.literal.split(/\s+/).map((l) => ({ literal: l, dynamic: false })));
      } else if (/^-[A-Za-z]+$/.test(w)) {
        // A switch of Start-Process's own (`-Wait`, `-NoNewWindow`, `-WorkingDirectory dir`): its value is skipped where it has one.
        if (/^-(?:WorkingDirectory|RedirectStandard\w+|Verb|WindowStyle|Credential)$/i.test(w)) i++;
      } else if (program === undefined) program = w;
    }
    if (program) calls.push({ head: program, args });
  }
  return calls;
}

/**
 * The files of code a line gives straight to a runtime (2026-10-26): `node tools/x.js`, `npx ts-node tools/x.ts`,
 * `tsx x.ts`, `python x.py`, `deno run x.ts`, as full paths — and since the audit of 2026-10-27 every way of saying it
 * found then: a package runner named as a word of npm, pnpm or yarn (`npm exec -- tsx x.ts`), a runner's switch with a
 * value (`npx --package tsx tsx x.ts`), a file loaded before the one run (`node -r ./hook.js x.js`) and a runtime
 * started with Start-Process (`Start-Process node -ArgumentList x.js`). The first argument that is not a switch is the
 * file; a line whose first one is not a file of code (`node --version`, `python -m pytest`) gives none. The project's
 * test runners are not this (operator, 2026-10-26: "tests as before"): `node --test` is left alone, as are `npm test`,
 * `npx playwright test` and the rest, which are not runtimes given a file.
 */
export function codeFilesRun(command: string, cwd: string, shell?: string): string[] {
  const files = new Set<string>();
  const add = (literal: string): void => void files.add(isAbsolute(literal) ? literal : resolve(cwd, literal));
  for (const call of [...scanCommandHeads(command, shell ?? 'pwsh').calls, ...startedProcesses(command)]) {
    let program = programOf(call.head);
    let args = call.args;
    // `npm exec -- tsx x.ts`, `pnpm dlx tsx x.ts`: from here on, a package runner.
    if (RUNNER_WORDS[program]?.has(args[0]?.literal.toLowerCase() ?? '')) {
      program = 'npx';
      args = args.slice(1);
    }
    if (RUN_THROUGH.has(program)) {
      let first = -1;
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!.literal;
        if (a === '--') continue;
        if (a.startsWith('-')) {
          if (RUNNER_VALUE.test(a)) i++;
          continue;
        }
        first = i;
        break;
      }
      if (first < 0) continue;
      program = programOf(args[first]!.literal);
      args = args.slice(first + 1);
    }
    if (!CODE_RUNTIMES.has(program)) continue;
    if (args.some((a) => /^--test\b/.test(a.literal))) continue;
    const rest = (program === 'deno' || program === 'bun') && args[0]?.literal === 'run' ? args.slice(1) : args;
    let file: CallArg | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      const [flag, inline] = a.literal.startsWith('-') && a.literal.includes('=') ? [a.literal.slice(0, a.literal.indexOf('=')), a.literal.slice(a.literal.indexOf('=') + 1)] : [a.literal, undefined];
      if (flag === '--') continue;
      if (flag.startsWith('-')) {
        if (LOADS_CODE.test(flag)) {
          const value = inline ?? rest[++i]?.literal;
          if (value && CODE_FILE.test(value) && /^(?:\.|[A-Za-z]:|[\\/])|[\\/]/.test(value)) add(value);
        } else if (inline === undefined && RUNTIME_VALUE.test(flag)) {
          // `python -m pytest`: a module, not a file — the line runs no file of its own.
          if (flag === '-m') break;
          i++;
        }
        continue;
      }
      file = a;
      break;
    }
    if (!file || file.dynamic || !CODE_FILE.test(file.literal)) continue;
    add(file.literal);
  }
  return [...files];
}

/**
 * Why a file of code was written during this work, or null when it was the project's before the work began: added
 * to the repository by someone else before then, or, not committed, made on disk before then. A file of the project
 * changed by the work is still the project's — the application started after a change is the work, run the way the
 * project runs it; a file that was not there is a script the work wrote.
 */
export function writtenDuringTheWork(file: string, since?: string): string | null {
  if (!existsSync(file)) return null;
  const began = since ? Date.parse(since) : NaN;
  const top = gitSync(dirname(file), ['rev-parse', '--show-toplevel']);
  if (top.ok && top.stdout) {
    const rel = relative(top.stdout, file);
    const path = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : file;
    const added = gitSync(top.stdout, ['log', '--diff-filter=A', '--format=%ae%x09%ct', '-1', '--', path]);
    if (added.ok && added.stdout.trim()) {
      const [email = '', time = ''] = added.stdout.trim().split('\t');
      if (email.trim().toLowerCase() === RUNNER_EMAIL) return 'it was added by copilot-operator, so it was written during the work';
      if (Number.isFinite(began) && Number(time) * 1000 >= began - 1000) return 'it was added after this work began';
      return null;
    }
  }
  if (!Number.isFinite(began)) return 'it is not committed, and nothing tells when it was written';
  let born = NaN;
  try {
    born = statSync(file).birthtimeMs;
  } catch {
    /* unreadable: the runtime will say so */
  }
  return Number.isFinite(born) && born >= began - 1000 ? 'it was made after this work began and is not committed' : null;
}

/** One script a line runs, judged: whose it is, and which of the operator's boxes decides it (2026-10-27). */
export type ScriptRun = {
  /** The file, in full; for a script of package.json, the package.json. */
  file: string;
  /** Its kind; null for one no box decides: the Windows Script Host's, or a file in .cop-tmp of no kind at all. */
  kind: ScriptKind | null;
  /** Why it was written during the work, or null when it is the project's own. */
  written: string | null;
  /** A shell script, run by a shell or the script host (`shellScriptsRun`), as opposed to a file of code given to a runtime. */
  shell?: boolean;
  /** A script of package.json: its name, and its command line (null when package.json has none by that name). */
  script?: { name: string; command: string | null };
};

/** A file in .cop-tmp given to a program that runs files — not output written there (`node x.js > .cop-tmp\out.txt`). */
const SCRATCH_RUN = new RegExp(
  String.raw`\b${RUNS_A_FILE}(?:\.exe|\.cmd)?\b[^|;\n]*?(?:^|[\s'"=(,:])((?:\.[\\/])?(?:[^\s'"|;]*[\\/])?\.cop-tmp[\\/][^\s'"|;]*\.(?:ps1|psm1|cmd|bat|js|mjs|cjs|jsx|ts|mts|cts|tsx|py|rb|pl|php|vbs|vbe|wsf|sh|jar|dll|exe|csx))\b`,
  'gi',
);

/** Whether the line itself writes a file by that name: a cmdlet, an alias or a redirection naming it. */
function writesFileNamed(command: string, file: string): boolean {
  const name = basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    String.raw`\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Tee-Object|sc|ac|cp|copy|mv|move|ren|ni|tee)\b[^|;\n]*${name}\b|>\s*["']?[^\s"']*${name}\b`,
    'i',
  ).test(command);
}

/** A script the line writes and runs at once: never run, whatever the boxes say, since nothing could be read before it ran. */
const SAME_LINE = 'this same line writes it';

/**
 * Every script the line runs, each judged: a shell script (`shellScriptsRun`) by `notTheProjects`, a file of code given
 * to a runtime (`codeFilesRun`) by `writtenDuringTheWork`, anything else in .cop-tmp a program is given, and the scripts
 * of package.json it runs (`npmScripts.ts`).
 */
export function scriptsRun(command: string, cwd: string, since?: string, shell?: string): ScriptRun[] {
  const out: ScriptRun[] = [];
  const seen = new Set<string>();
  const first = (file: string): boolean => {
    const key = file.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  for (const file of shellScriptsRun(command, cwd)) {
    if (first(file)) out.push({ file, kind: kindOfFile(file, /\.jse?$/i.test(file)), written: notTheProjects(file, since), shell: true });
  }
  for (const file of codeFilesRun(command, cwd, shell)) {
    if (!first(file)) continue;
    const written = inScratch(file) ? `it is in ${SCRATCH}, the folder for scratch files` : writesFileNamed(command, file) ? SAME_LINE : writtenDuringTheWork(file, since);
    out.push({ file, kind: kindOfFile(file), written });
  }
  for (const m of command.matchAll(SCRATCH_RUN)) {
    const file = resolve(cwd, m[1]!);
    if (first(file)) out.push({ file, kind: kindOfFile(file), written: `it is in ${SCRATCH}, the folder for scratch files` });
  }
  const sameLine = writesPackageScripts(command);
  for (const run of packageScriptsRun(command, cwd, shell)) {
    const written = packageScriptWritten(run, since, sameLine);
    // No such script and nothing writes it: npm says so, and nothing runs.
    if (run.command === null && written === null) continue;
    out.push({ file: run.pkg, kind: 'npm', written: written === 'this same line writes it into package.json' ? SAME_LINE : written, script: { name: run.name, command: run.command } });
  }
  return out;
}

/** No box decides it: the project's own may run, the work's may not. */
const FIXED: ScriptRule = { own: true, written: false };

/** How a script is named in a refusal. */
function named(run: ScriptRun, cwd: string): string {
  const path = relative(cwd, run.file) || run.file;
  return run.script ? `the script "${run.script.name}" of ${path}` : path;
}

/** The most of one script read for the card. */
const MAX_SHOWN_BYTES = 64 * 1024;

/** A script's text as the gate and the card read it, or why it cannot be. */
export function scriptText(run: ScriptRun): { text: string; cut?: boolean } | { problem: string } {
  if (run.script) return run.script.command === null ? { problem: 'package.json has no script by that name' } : { text: run.script.command };
  try {
    const size = statSync(run.file).size;
    if (size > MAX_SCRIPT_BYTES) return { problem: `it is ${Math.round(size / 1024)} KB, larger than a step's script` };
    const text = readFileSync(run.file, 'utf8');
    return text.length > MAX_SHOWN_BYTES ? { text: text.slice(0, MAX_SHOWN_BYTES), cut: true } : { text };
  } catch {
    return { problem: 'it does not exist yet' };
  }
}

export type ScriptGateOptions = {
  /** The operator's boxes (Settings, "Scripts"); the defaults when absent. */
  rules?: ScriptRules;
  /** The reviewer's step: told to check another way, since a review hands nothing over. */
  reviewer?: boolean;
  /**
   * The gate a script the bot wrote is read through when its box lets it run: its text, as the line's own. Absent,
   * nothing is read here (a `.ps1`'s text is read by `scriptFileRefusal` in every case).
   */
  screen?: (run: ScriptRun, text: string) => string | null;
};

/**
 * Why a chat's step must not run a script, or null (2026-10-21, boxes since 2026-10-27). Each script the line runs is
 * the project's own or the work's (`scriptsRun`); the operator's box for its kind says whether either may run. A box
 * left empty is a refusal, and the chat is told to hand the script over; a script of the work let run is read through
 * `screen` first. A script written and run in one line is refused whatever the boxes say. Only for the chat's steps,
 * the implementer's and the reviewer's: the operator's own checks are theirs to point at whatever they choose.
 */
export function ownScriptRefusal(command: string, cwd: string, since?: string, shell?: string, opts: ScriptGateOptions = {}): string | null {
  const rules = opts.rules ?? DEFAULT_SCRIPT_RULES;
  const instead = opts.reviewer ? REVIEW_INSTEAD : HAND_IT_OVER;
  for (const run of scriptsRun(command, cwd, since, shell)) {
    const rule = run.kind ? rules[run.kind] : FIXED;
    const name = named(run, cwd);
    if (run.written === null) {
      if (!rule.own && run.kind) {
        return `refused: ${name} is one of the project's own scripts, and the operator does not let the runner run the project's own scripts of this kind (${kindForChat(run.kind)}; the operator's rule). ${instead}`;
      }
      continue;
    }
    if (run.written === SAME_LINE) {
      return `refused: ${name} is written and run in this same line, so nothing could read it before it ran. Write it in one step and run it in the next. ${instead}`;
    }
    if (!rule.written) {
      if (run.shell) {
        return (
          `refused: ${name} is not one of the project's own scripts — ${run.written}. A script written or changed during the work is run by ` +
          `the operator, not by the runner, nor is anything in ${SCRATCH} (the operator's rule). ${instead}`
        );
      }
      if (run.written.includes(SCRATCH)) {
        return `refused: this runs a file in ${SCRATCH}, the folder for scratch files — the runner does not run the scripts written there (the operator's rule). ${instead}`;
      }
      return `refused: ${name} is a script written during this work — ${run.written} — and such a script is run by the operator, not by the runner (the operator's rule). ${instead} The project's tests run as steps, as before.`;
    }
    // The work's, and the operator lets this kind run: what is in it passes the gate the line passed.
    if (opts.screen) {
      const read = scriptText(run);
      if ('problem' in read) return `refused: ${name} cannot be read before it runs — ${read.problem}. Write it in an earlier step, then run it.`;
      const reason = opts.screen(run, read.text);
      if (reason) return `${reason} (in ${name}, written during this work)`;
    }
  }
  return null;
}

/** The scripts of the work a line runs that the operator's boxes let run: shown on the card that asks about them. */
export function writtenScriptsLetRun(command: string, cwd: string, since: string | undefined, shell: string | undefined, rules: ScriptRules): ScriptRun[] {
  return scriptsRun(command, cwd, since, shell).filter((r) => r.written !== null && r.written !== SAME_LINE && r.kind !== null && rules[r.kind].written);
}

/** What the chat is told to do instead (2026-10-26). */
const HAND_IT_OVER =
  'Put what it does in the step itself — a command may be several lines — or hand it to the operator with status "handoff": ' +
  'the commands, the folder, what they should see and the script; the operator runs it and you get what it printed.';

/** What the reviewer is told instead: a review hands nothing over. */
const REVIEW_INSTEAD =
  'A review runs commands only: check what it would show with commands of your own, written out in the step itself, or say in a finding that the operator has to run it.';
