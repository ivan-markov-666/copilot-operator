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

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { botRootDir } from './workDir.js';

/** One way of fetching: what it is called in the reason, how it is recognised, what to do instead. */
type NetworkFetcher = { name: string; pattern: RegExp; instead?: string };

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
  /*
   * Package managers fetching something that is not a package from the project's registry: a
   * package named by URL or by a git address, a runner (`npx`, `pnpm dlx`, `bunx`) given a package
   * that is not installed in the project, a Go module run by address, a container image. Each
   * downloads code and runs it in the same breath, which is the two-step form in one step.
   * `npx <installed tool>` is the ordinary way to run a project's own tools and is not held: whether
   * the tool is installed is checked on disk (`installedInProject`).
   */
  {
    name: 'a package from a URL or a repository',
    pattern: /\b(npm|pnpm|yarn|bun|pip3?|uv|poetry)(\.cmd|\.exe)?\s+(install|add|i)\b[^|;\n]*?(https?:\/\/|git\+|github:|gitlab:|bitbucket:|git:\/\/|ssh:\/\/|git@)/i,
    instead: "name the package as the registry knows it, or say in `notes` what is needed and end `blocked`",
  },
  {
    name: 'a package runner fetching a package',
    // Any argument at all, flags included: whether the tool is installed decides, not the spelling.
    pattern: /\b(npx|pnpx|bunx)(\.cmd|\.exe)?\s+\S|\b(pnpm|yarn)(\.cmd)?\s+dlx\s+|\bnpm(\.cmd)?\s+exec\s+/i,
    instead: 'install the tool into the project first (`npm install -D <tool>`); a tool that is installed is run without asking',
  },
  { name: 'go run of a module by address', pattern: /\bgo(\.exe)?\s+run\s+\S+@/i, instead: 'add the module to go.mod and run it from there' },
  {
    name: 'a container image',
    pattern: /\bdocker(\.exe)?\s+(pull|run|create|build)\b|\bdocker(\.exe)?\s+compose\s+(up|run|build|pull)\b/i,
    instead: 'say in `notes` which image is needed; the operator pulls it',
  },
];

/**
 * Whether the tool `npx` (or its kin) is asked to run is already installed in the project, found by
 * walking up from `cwd` the way npx itself does. Absent, npx downloads it — and that is the case
 * that waits for the operator.
 */
function installedInProject(command: string, cwd: string | undefined): boolean {
  if (!cwd) return false;
  const m = /\b(?:npx|pnpx|bunx)(?:\.cmd|\.exe)?\s+(?:(?:--yes|-y|--no|--quiet|-q)\s+)*(?:(?:-p|--package)\s+\S+\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(command)
    ?? /\b(?:pnpm|yarn)(?:\.cmd)?\s+dlx\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(command)
    ?? /\bnpm(?:\.cmd)?\s+exec\s+(?:--\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(command);
  if (!m) return false;
  if (/\s(-p|--package)\s/i.test(command)) return false;
  const spec = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  if (!spec || spec.startsWith('-')) return false;
  // `tsx@4.19` names a version; `@scope/name` starts with `@`. Strip a trailing version only.
  const name = spec.startsWith('@') ? spec.replace(/(.)@[^@]*$/, '$1') : spec.replace(/@.*$/, '');
  if (/[\\/:]/.test(name.replace(/^@[^/]+\//, ''))) return false;
  const bin = name.startsWith('@') ? name.split('/')[1] ?? '' : name;
  let dir = resolve(cwd);
  for (let i = 0; i < 12; i += 1) {
    const modules = join(dir, 'node_modules');
    if (existsSync(join(modules, name, 'package.json')) || existsSync(join(modules, '.bin', `${bin}.cmd`)) || existsSync(join(modules, '.bin', bin))) return true;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

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
export function networkFetchReason(command: string, cwd?: string): string | null {
  const hit = FETCHERS.find((f) => f.pattern.test(command));
  if (!hit) return null;
  if (hit.name === 'a package runner fetching a package' && installedInProject(command, cwd)) return null;
  if (onlyLoopbackTargets(command)) return null;
  return (
    `fetches from the network (${hit.name}). The bot does not download files on its own, because a later ` +
    'step could run what arrived; this step waits for the operator to allow it. Requests to this machine ' +
    '(localhost, 127.0.0.1) are not held. Packages come in through the project\'s own tools (npm, dotnet, ' +
    'pip into a .venv), which are not held either.' +
    (hit.instead ? ` Instead: ${hit.instead}.` : '')
  );
}

/**
 * The bot's own API and UI, and the file that holds their key. The loopback exemption above exists
 * so a task can check a server *it* started; it must not become the way a step reaches the process
 * that approves its steps. Found on 2026-09-27: with the token in its environment, a step could call
 * `127.0.0.1:4000` and answer its own held download. The token is no longer passed (`stepEnv.ts`);
 * this refuses the attempt as well, so a step that goes looking gets a reason instead of a 401.
 */
export function botSelfRefusal(command: string, ports: number[] = botPorts(), root: string = botRootDir()): string | null {
  const port = `(?:${ports.map((p) => String(Math.trunc(p))).join('|')})`;
  const host = String.raw`(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0|::1)`;
  // The folders the bot keeps its records in, by path: its data, its runs, its update backups.
  const folded = command.replace(/\//g, '\\').toLowerCase();
  const own = root.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '');
  const reachesRecords = ['data', 'runs', 'data-backups'].some((d) => folded.includes(`${own}\\${d}`));
  if (reachesRecords || new RegExp(String.raw`${host}\s*:\s*${port}(?!\d)`, 'i').test(command) || /\bapi-token\b|\bdev-pids\.json\b/i.test(command)) {
    return (
      'refused: this reaches the bot itself — its API, its web page or its key. A task works on its own project; ' +
      'the bot that runs it is not part of the work. Use a different port for a server the task starts.'
    );
  }
  return null;
}

/** The ports the bot's API and web page listen on. */
export function botPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const api = Number(env.COP_API_PORT ?? 4000);
  return [...new Set([Number.isFinite(api) ? api : 4000, 4000, 3210])];
}

/** What the chat is told when a fetch was held and nobody was there to allow it. */
export function networkFetchRefusal(reason: string): string {
  return (
    `refused: ${reason} This run has nobody to approve it, so it was not run. Do the work without ` +
    'downloading — write what is needed into the project with a command step, or install it with the ' +
    "project's package manager — or say in `notes` what must be fetched and end `blocked`."
  );
}
