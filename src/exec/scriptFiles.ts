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
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

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
