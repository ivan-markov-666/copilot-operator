/**
 * How a fetch the operator asked for gets past a remote that wants a password — without the bot ever
 * seeing it.
 *
 * Found on 2026-10-03 with "Prepare the folder from the remote main branch": the remote is reached over
 * SSH with a key that has a passphrase, and every fetch the bot makes forbids prompts (a prompt in a
 * run nobody watches would hang it), so the fetch failed. The operator asked for a safe way to type the
 * passphrase.
 *
 * Not a field on the bot's page: a password typed there passes through the browser, the API, this
 * process and its memory, and the bot would hold the one secret that unlocks the operator's key. So
 * the bot asks nobody anything. It lets ssh (and git, for HTTPS) ask through Git for Windows' own
 * password window, `git-askpass.exe`: ssh starts the window, the operator types into it, and the
 * answer goes from the window straight back to ssh through a pipe the bot is not part of. Nothing is
 * stored; the next fetch asks again (an ssh-agent, if the operator runs one, answers instead).
 *
 * Only for a fetch the operator just pressed a button for: a run's own fetches stay silent, since a
 * window nobody answers would hold the run until it times out.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { git } from './git.js';
import { psQuote } from './syncCommand.js';

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
 * The environment for a fetch the operator is present for: ssh asks through the password window even
 * with no terminal (`SSH_ASKPASS_REQUIRE=force`; `DISPLAY` for an older ssh that wants one), and git
 * asks through it for an HTTPS user name or password that its credential manager does not answer. No
 * terminal prompt: the bot's console is not where the operator is looking.
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
  const auth = /permission denied|publickey|passphrase|authentication failed|could not read (username|password)|host key verification failed|terminal prompts disabled/i.test(stderr);
  return { detail: lines.slice(0, 3).join(' ') || 'git fetch failed', auth };
}

/** The fetch for the operator to run in their own PowerShell, where ssh can ask them directly. */
export function fetchCommandFor(dir: string, remote: string): string {
  return `git -C ${psQuote(dir)} fetch --prune ${psQuote(remote)}`;
}

