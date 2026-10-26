/**
 * How a fetch the operator asked for gets past a remote that wants a password — without the bot ever seeing it.
 *
 * First made on 2026-10-03 (an SSH key with a passphrase); brought back on 2026-10-26 for "New branch from main" in
 * the chat (operator: "if the remote main asks for a password, open a window the bot never reads; the operator types
 * the password there and it goes to version control; dynamic, so no security policy is hit").
 *
 * Not a field on the bot's page: a password typed there passes through the browser, the API, this process and its
 * memory, and the bot would hold the one secret that unlocks the operator's key or account. So the bot asks nobody
 * anything. It lets ssh (and git, for HTTPS) ask through Git for Windows' own password window, `git-askpass.exe` —
 * a program that ships with Git, not a script — or Git Credential Manager's own window: the operator types into it,
 * and the answer goes from the window straight back to ssh or git through a pipe the bot is not part of. The bot reads
 * only what `git fetch` prints. Nothing is stored; the next fetch asks again (an ssh-agent or the credential manager,
 * when the operator has one, answers instead).
 *
 * Only for a fetch the operator just pressed a button for: a run's own fetches stay silent, since a window nobody
 * answers would hold the run until it times out.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { git, gitFetch } from './git.js';

/** No prompt anywhere: what every fetch of a run uses. */
export const QUIET_FETCH_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };

/** Git for Windows' password window, next to the git that runs here; null when there is none. */
export async function askpassProgram(): Promise<string | null> {
  const exec = await git(process.cwd(), ['--exec-path']);
  if (!exec.ok || !exec.stdout) return null;
  // <Git>\mingw64\libexec\git-core → <Git>\mingw64\bin\git-askpass.exe
  const candidate = resolve(exec.stdout, '..', '..', 'bin', 'git-askpass.exe');
  return existsSync(candidate) ? candidate : null;
}

/**
 * The environment for a fetch the operator is present for: ssh asks through the password window even with no terminal
 * (`SSH_ASKPASS_REQUIRE=force`; `DISPLAY` for an older ssh that wants one), and git asks through it — or through the
 * credential manager's own window — for an HTTPS user name or password. No terminal prompt: the bot's console is not
 * where the operator is looking.
 */
export function operatorFetchEnv(askpass: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'auto',
    GIT_ASKPASS: askpass,
    SSH_ASKPASS: askpass,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || 'needs-to-be-defined',
  };
}

/** A failed fetch, said so the operator knows whether it was the password. */
export function describeFetchFailure(stderr: string): { detail: string; auth: boolean } {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const auth = /permission denied|publickey|passphrase|authentication failed|could not read (username|password)|host key verification failed|terminal prompts disabled|cancel/i.test(stderr);
  return { detail: lines.slice(0, 3).join(' ') || 'git fetch failed', auth };
}

/**
 * Closes the password windows of a fetch that was given up on: every process of exactly this program started since
 * `since`. Needed because stopping git and its process tree does not reach them (Git for Windows starts ssh, and ssh
 * the window, whose Windows parent is already gone; seen live on 2026-10-03). Matched by the program's full path and
 * its start time, so nothing else is touched. A command given to PowerShell as it runs, not a script file.
 */
export function closePasswordWindows(program: string, since: Date): Promise<number> {
  if (process.platform !== 'win32') return Promise.resolve(0);
  const script = [
    `$path = '${program.replace(/'/g, "''")}'`,
    `$since = [datetime]::Parse('${since.toISOString()}').ToUniversalTime()`,
    '$n = 0',
    "Get-CimInstance Win32_Process -Filter \"Name='git-askpass.exe' OR Name='$([IO.Path]::GetFileName($path))'\" |",
    '  Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $path -and $_.CreationDate.ToUniversalTime() -ge $since } |',
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }',
    '$n',
  ].join('\n');
  return new Promise((done) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000 }, (_e, stdout) => {
      done(Number.parseInt(String(stdout).trim(), 10) || 0);
    });
  });
}

/** The programs that are Git asking the operator: its password window and its credential manager's. */
const ASKING = ['git-askpass.exe', 'git-credential-manager.exe', 'git-credential-manager-core.exe'];

/**
 * Whether Git is asking the operator for a password now, in a window opened since `sinceMs` (2026-10-26): what holds a
 * step's idle clock and has the chat say where to look. A quick list of the processes first; their start time only
 * when one of them is there — a command given to PowerShell as it runs, not a script file.
 */
export async function passwordWindowOpen(sinceMs: number): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const listed = await new Promise<string>((done) =>
    execFile('tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq git-*'], { windowsHide: true, timeout: 10_000 }, (_e, stdout) => done(String(stdout ?? '').toLowerCase())),
  );
  if (!ASKING.some((n) => listed.includes(`"${n}"`))) return false;
  const filter = ASKING.map((n) => `Name='${n}'`).join(' OR ');
  const script = [
    `$since = [datetime]::Parse('${new Date(sinceMs - 1000).toISOString()}').ToUniversalTime()`,
    `@(Get-CimInstance Win32_Process -Filter "${filter}" | Where-Object { $_.CreationDate.ToUniversalTime() -ge $since }).Count`,
  ].join('\n');
  return await new Promise<boolean>((done) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 }, (_e, stdout) => done((Number.parseInt(String(stdout).trim(), 10) || 0) > 0)),
  );
}

/** How a fetch the operator was present for went: see `fetchAsOperator`. */
export type OperatorFetch = { ok: boolean; detail?: string; auth?: boolean; asked: boolean; retried?: boolean };

/**
 * A fetch the operator just pressed a button for, and is looking at: with Git's password window when there is one
 * (five minutes to type, the window not hidden), quiet otherwise. One connection only; tried once more when the first
 * try fails for another reason than a password given up on (see `gitFetch`); a window left on screen by a fetch that
 * was given up on is closed. `refspecs` fetches only those branches.
 */
export async function fetchAsOperator(repoDir: string, remote: string, opts: { askpass: string | null; refspecs?: string[] }): Promise<OperatorFetch> {
  const asked = !!opts.askpass;
  const env = asked ? operatorFetchEnv(opts.askpass as string) : QUIET_FETCH_ENV;
  const args = [...(asked ? [] : ['-c', 'credential.interactive=false']), 'fetch', '--quiet', '--no-tags', remote, ...(opts.refspecs ?? [])];
  const started = new Date(Date.now() - 1000);
  const f = await gitFetch(repoDir, args, asked ? 300_000 : 120_000, env, { windowsHide: !asked, killTree: true });
  if (!f.ok && asked && /gave up after/.test(f.stderr)) await closePasswordWindows(opts.askpass as string, started);
  if (f.ok) return { ok: true, asked, ...(f.retried ? { retried: true } : {}) };
  const why = describeFetchFailure(f.stderr || f.stdout);
  return { ok: false, detail: why.detail, auth: why.auth, asked };
}
