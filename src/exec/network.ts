/**
 * Commands that fetch something from the network, and why they never run on their own.
 *
 * The operator's rule, stated on 2026-09-27: the bot does not download files. Not because a
 * download is dangerous in itself, but because of what comes after it. A step that saves
 * `https://somewhere/tool.zip` into the project is harmless on the line where it happens; the
 * *next* step, written by the same chat a minute later, can unpack and run it, and by then the
 * thing that runs arrived from outside the conversation, was read by nobody, and is exactly the
 * shape a security team calls a loader. `dangerous.ts` already refuses the one-line form
 * (`iwr … | iex`); this is about the two-step form, which no single line gives away.
 *
 * So a step that fetches is not refused and not run: it is **held for the operator**. It goes to
 * the approval screen ("A step is waiting for your decision") in every mode, *including* an
 * unattended run and a run switched to "run the rest without asking", because those are exactly
 * the runs in which nobody would otherwise see it. Where there is no one to ask — the CLI's
 * unattended mode has no screen — it is refused instead, with the reason. See `authorizer.ts`.
 *
 * What is on the list, and what is deliberately not:
 *
 *   on it    `Invoke-WebRequest`/`iwr`, `Invoke-RestMethod`/`irm`, `curl`, `wget`,
 *            `Start-BitsTransfer` (and the `BitsTransfer` module), .NET's `WebClient`,
 *            `HttpClient` and `WebRequest`, and the file-transfer programs `ftp`, `tftp`, `sftp`,
 *            `scp` and `aria2c`. `bitsadmin` and `certutil -urlcache` are here too in spirit, but
 *            `dangerous.ts` refuses them outright first, which is stronger.
 *   not      `npm`, `pnpm`, `yarn`, `dotnet restore`, `pip` into a `.venv`, `mvn`, `gradle`,
 *            `cargo`, `go`, `git fetch`/`pull`. They fetch too, but they fetch *packages*, the
 *            project's declared dependencies, by the project's own mechanism, from registries the
 *            project already trusts, and refusing them would stop every build. The operator decided
 *            that line (2026-09-27); moving it is their call, not this file's.
 *
 * One exception, and why: a request whose every target is **this machine** — `localhost`,
 * `127.0.0.1`, `[::1]` — is not a download. `curl http://localhost:3000/health` is how a task
 * proves the server it started actually answers, and nothing comes back that the project did not
 * itself produce. Holding every health check for approval would turn an unattended run into one
 * that waits all night on its first test. The exception is narrow on purpose: every `http(s)://`
 * address in the command must be loopback, there must be at least one, and nothing else in the
 * command may look like a host — a bare `example.com` or `10.0.0.5` beside a localhost URL still
 * holds the step, because `iwr` accepts an address without a scheme.
 *
 * The same text is screened whole, not command by command. That is deliberate and it is what
 * closes the obvious way round: writing `Invoke-WebRequest …` into a `.ps1` with `Set-Content` and
 * running the file in the next step. The `Set-Content` step carries the words, so it is the one
 * held, and the operator sees the script before it exists.
 *
 * The honest limit, the same one every rule in this folder states: this is not a boundary. A
 * program the project itself contains can open a socket — a Node script that calls `fetch()` is
 * ordinary application code and nothing here can tell it from a download. What this does is keep
 * the *ordinary* way of downloading, the one a chat reaches for first, in front of a person.
 */

/** One way of fetching: what it is called in the reason, and how it is recognised. */
type NetworkFetcher = { name: string; pattern: RegExp };

const FETCHERS: NetworkFetcher[] = [
  { name: 'Invoke-WebRequest', pattern: /\b(Invoke-WebRequest|iwr)\b/i },
  { name: 'Invoke-RestMethod', pattern: /\b(Invoke-RestMethod|irm)\b/i },
  { name: 'curl', pattern: /\bcurl(\.exe)?\b/i },
  { name: 'wget', pattern: /\bwget2?(\.exe)?\b/i },
  { name: 'Start-BitsTransfer', pattern: /\b(Start-BitsTransfer|BitsTransfer)\b/i },
  // .NET's own clients, however they are spelled: `New-Object Net.WebClient`,
  // `[System.Net.Http.HttpClient]::new()`, `[Net.WebRequest]::Create(...)`.
  { name: '.NET web client', pattern: /\b(WebClient|HttpClient|HttpWebRequest|WebRequest)\b/i },
  // Requires something after the name, so that the word in prose or a path segment is not a hit.
  { name: 'file transfer', pattern: /\b(s?ftp|tftp|scp|aria2c)(\.exe)?\s+\S/i },
];

/** Hosts that are this machine. Anything else is somewhere else. */
function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(h) || h === '::1';
}

/**
 * Extensions a bare `name.ext` token carries when it is a file rather than a host. Only used to
 * decide whether a token beside a loopback URL looks like a *second* address; a file named here is
 * an argument (`-OutFile health.json`), a token not named here is treated as a host, which is the
 * safe direction to be wrong in: the step is held, not run.
 */
const FILE_EXTENSIONS = new Set([
  'json', 'txt', 'log', 'md', 'html', 'htm', 'xml', 'csv', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'map', 'ps1', 'psm1', 'cs', 'py', 'java', 'go', 'rs',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'pdf', 'out', 'tmp', 'bak', 'lock',
  'exe', 'cmd', 'bat', 'dll', 'tar', 'gz', 'tgz',
]);

/**
 * Whether every place this command could reach is this machine. True only when it names at least
 * one `http(s)://` address, all of them loopback, and no other token that reads as a host or an IP.
 */
export function onlyLoopbackTargets(command: string): boolean {
  const urls = [...command.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^\/\s:'"`;|)]+)/gi)];
  if (urls.length === 0) return false;
  if (!urls.every((m) => isLoopback(m[1]!))) return false;
  const rest = command.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  for (const token of rest.split(/[\s'"`=,;|(){}]+/)) {
    const bare = token.replace(/^-+/, '').replace(/[:\/].*$/, '');
    if (!bare) continue;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare) && !isLoopback(bare)) return false;
    const labels = bare.split('.');
    if (labels.length < 2 || labels.some((l) => l === '')) continue;
    const last = labels[labels.length - 1]!.toLowerCase();
    if (!/^[a-z]{2,}$/.test(last)) continue;
    if (FILE_EXTENSIONS.has(last)) continue;
    // PowerShell member access on a variable or a type (`$r.StatusCode`, `System.Net`) is not a host.
    if (token.startsWith('$') || token.startsWith('[')) continue;
    if (/^(system|microsoft|net)$/i.test(labels[0]!)) continue;
    if (isLoopback(bare)) continue;
    return false;
  }
  return true;
}

/**
 * Why this command must be shown to the operator before it runs, or null.
 *
 * The sentence is the one the approval screen and the log print, and — when there is nobody to
 * ask — the one the chat receives, so it says what was recognised and what to do instead.
 */
export function networkFetchReason(command: string): string | null {
  const hit = FETCHERS.find((f) => f.pattern.test(command));
  if (!hit) return null;
  if (onlyLoopbackTargets(command)) return null;
  return (
    `fetches from the network (${hit.name}). The bot does not download files on its own, because a later ` +
    'step could run what arrived; this step waits for the operator to allow it. Requests to this machine ' +
    '(localhost, 127.0.0.1) are not held. Packages come in through the project\'s own tools (npm, dotnet, ' +
    'pip into a .venv), which are not held either.'
  );
}

/** What the chat is told when a fetch was held and nobody was there to allow it. */
export function networkFetchRefusal(reason: string): string {
  return (
    `refused: ${reason} This run has nobody to approve it, so it was not run. Do the work without ` +
    'downloading — write what is needed into the project with a command step, or install it with the ' +
    "project's package manager — or say in `notes` what must be fetched and end `blocked`."
  );
}
