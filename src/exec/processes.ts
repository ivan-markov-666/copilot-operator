/**
 * What a task or a review leaves running, found and stopped by the runner — and how anything the
 * runner stops is stopped.
 *
 * "Anything you start, you stop" is in both contracts, and it is advice: in one run the reviewer
 * left its own `next start` listening on 4310 and then failed the work for it, and every plan
 * written so far has carried its own checks for ports and node processes because nothing else
 * would. The runner can own this. It notes when a task and each review began; afterwards, what was
 * created since *and was started by the bot* is stopped and written on the task with where it came
 * from. The plan's own checks still run first — a server the implementer forgot goes back to the
 * chat as a failed check — and this is the net under them.
 *
 * **Whose processes** (2026-09-27, at the operator's request). The first version stopped every new
 * process whose command line named the project folder. That is a description of a place, not of an
 * owner: a server the operator started by hand in the same folder while a run was going matched it
 * exactly, and was killed. Now a process is the bot's only if it descends from a step the bot itself
 * started — every shell `runStep` spawns is recorded in a `ProcessTracker`, with when it started and
 * ended, and a process belongs to the run if its chain of parents reaches one of them. Windows does
 * not re-parent an orphan, so a server left behind by `Start-Process` still names the step's shell
 * as its parent after that shell has exited; the times are what stop a *reused* process id from
 * passing for it. What is new in the folder but not provably the bot's is **reported and left
 * running**. The honest limit: a program started through a wrapper that exits at once (`cmd /c
 * start …`) leaves a process whose parent is gone and was never recorded; it is reported, not
 * stopped.
 *
 * **How it looks from the outside.** This runs on company laptops whose security tooling watches
 * every process the bot starts, so what the bot itself does here is kept to the plainest forms:
 *
 *   - The process table is read only for processes *created since* the task or step began (a WMI
 *     filter on `CreationDate`), not the whole machine with every command line, and the listening
 *     ports only for the processes found. Reading everyone's command lines several times a task is
 *     what discovery tooling does, and the bot has no need to know about anything older than its
 *     own work.
 *   - Stopping is `taskkill /T` first — the polite form, which asks a windowed program to close — a
 *     grace period, and `taskkill /T /F` only for what is still there. A day's version of this file
 *     sent a real Ctrl+C by compiling kernel32 calls through `Add-Type`; it worked, and it was
 *     removed the same day at the operator's decision, because runtime-compiled C# calling
 *     `AttachConsole` in another process's console is exactly what endpoint protection is built to
 *     flag. The cost is honest: a console server (node, dotnet) is still ended by `/F`. It is only
 *     ever one the bot started, which is what matters more.
 *   - The PowerShell that reads the table is given its script on the command line, where anyone
 *     reading the process list can see all of it — never on stdin, and never encoded.
 */
import { spawn } from 'node:child_process';
import { winPsEnv } from './winps.js';

export type ProjectProcess = { pid: number; parent: number; name: string; command: string };
export type Listener = { port: number; pid: number };
/** A row of the process table: `created` is milliseconds since the epoch, 0 when Windows would not say. */
export type ProcessRow = ProjectProcess & { created: number };
/**
 * When the watching began, and what was already running from then that the bot's work cannot have
 * started. `since` is what the queries are filtered on; `processes` are the rows seen at that
 * moment, which only matters for a snapshot taken after work has already begun (before a review).
 */
export type ProcessSnapshot = { since: number; processes: ProcessRow[]; listeners: Listener[] };

/** How a process came to be stopped. */
export type StopHow = 'already-gone' | 'closed' | 'forced' | 'failed';
export type Leftover = ProjectProcess & { ports: number[]; how?: StopHow };
/**
 * `killed` and `failed` are the bot's own; `notOurs` is what appeared in the project folder during
 * the same time and could not be tied to a step the bot started, and so was left running.
 */
export type ReapResult = { killed: Leftover[]; failed: Leftover[]; notOurs: Leftover[] };

/** How long a process is given to close after the polite `taskkill`, before `/F`. */
export const CLOSE_GRACE_MS = 5_000;

/**
 * The shells the bot has started, with when each started and ended.
 *
 * One per task, handed to every `runStep` the task makes — its steps, its checks, its reviews — so
 * that "the bot's processes" means this task's, and a second session running at the same time in
 * another project is somebody else. A list rather than a map because Windows reuses process ids,
 * and two steps of one task can be given the same one.
 */
export class ProcessTracker {
  readonly roots: Array<{ pid: number; from: number; to?: number }> = [];
  started(pid: number, at = Date.now()): void {
    this.roots.push({ pid, from: at });
  }
  ended(pid: number, at = Date.now()): void {
    for (let i = this.roots.length - 1; i >= 0; i -= 1) {
      const r = this.roots[i]!;
      if (r.pid === pid && r.to === undefined) {
        r.to = at;
        return;
      }
    }
  }
}

/** Runs one PowerShell expression, visible on the command line, and returns its stdout or null. */
function powershell(script: string, timeoutMs = 20_000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: winPsEnv() });
    let out = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? out : null);
    });
  });
}

function parseJsonList<T>(text: string | null): T[] {
  if (!text?.trim()) return [];
  try {
    const parsed = JSON.parse(text) as T | T[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Windows FILETIME (100 ns since 1601) to milliseconds since 1970. */
const fromFileTime = (ft: number): number => (ft > 0 ? Math.round(ft / 10_000 - 11_644_473_600_000) : 0);

/**
 * A moment as WMI's own datetime literal, `yyyymmddHHMMSS.mmmmmm+000`, in UTC. Built here rather
 * than by PowerShell's ManagementDateTimeConverter, which Constrained Language Mode does not allow
 * and which corporate machines commonly enforce (verified 2026-09-27). Exported for the check.
 */
export function dmtfOf(ms: number): string {
  const d = new Date(Math.max(0, ms));
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000+000`
  );
}

/** Slack either side of a recorded start or end: the table's clock and ours are read separately. */
const SLACK_MS = 2_000;

/**
 * The processes created at or after `since`, with their parents. Filtered in WMI itself, so rows
 * older than the bot's work are never read at all.
 */
export async function processTable(since: number): Promise<ProcessRow[]> {
  const from = dmtfOf(since - SLACK_MS);
  const text = await powershell(
    `Get-CimInstance Win32_Process -Filter "CreationDate >= '${from}'" | Select-Object ProcessId, ParentProcessId, Name, CommandLine, ` +
      "@{n='Created';e={ if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 } }} | ConvertTo-Json -Compress",
  );
  return parseJsonList<{ ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null; Created: number }>(text)
    .map((p) => ({
      pid: p.ProcessId,
      parent: p.ParentProcessId,
      name: p.Name ?? '',
      command: p.CommandLine ?? '',
      created: fromFileTime(p.Created),
    }))
    .filter((p) => p.pid !== process.pid);
}

/** The ports these processes are listening on — asked about them only, not the whole machine. */
async function listenersOf(pids: number[]): Promise<Listener[]> {
  if (pids.length === 0) return [];
  const text = await powershell(
    `Get-NetTCPConnection -State Listen -OwningProcess ${pids.map((p) => Math.trunc(p)).join(',')} -ErrorAction SilentlyContinue | ` +
      'Select-Object LocalPort, OwningProcess | ConvertTo-Json -Compress',
  );
  return parseJsonList<{ LocalPort: number; OwningProcess: number }>(text).map((l) => ({ port: l.LocalPort, pid: l.OwningProcess }));
}

/**
 * The rows that descend from one of `roots` — including a root itself while it is alive.
 *
 * A parent that is still alive is followed only when it is older than the child; if it is younger,
 * its id was reused after the child's real parent died, and the recorded windows are consulted
 * instead. A dead parent counts only when it is a recorded root and the child was created while
 * that root was running — a process cannot be created by one that has already exited.
 */
export function descendantsOf(table: ProcessRow[], roots: ProcessTracker['roots']): ProcessRow[] {
  const byPid = new Map(table.map((r) => [r.pid, r]));
  const memo = new Map<number, boolean>();
  const within = (pid: number, created: number): boolean =>
    roots.some((r) => r.pid === pid && created >= r.from - SLACK_MS && (r.to === undefined || created <= r.to + SLACK_MS));
  const isRoot = (row: ProcessRow): boolean => roots.some((r) => r.pid === row.pid && Math.abs(row.created - r.from) <= SLACK_MS);
  const ours = (row: ProcessRow, depth: number): boolean => {
    const known = memo.get(row.pid);
    if (known !== undefined) return known;
    if (depth > 64) return false;
    memo.set(row.pid, false); // a cycle in reused ids is not ownership
    let result = isRoot(row);
    if (!result && row.parent !== row.pid) {
      const parent = byPid.get(row.parent);
      // An older parent that is still alive *is* the parent, ours or not; only when it is gone, or
      // its id now belongs to a younger process, do the recorded windows decide.
      if (parent && parent.created <= row.created + SLACK_MS) result = parent.pid !== 0 && ours(parent, depth + 1);
      else result = within(row.parent, row.created);
    }
    memo.set(row.pid, result);
    return result;
  };
  return table.filter((row) => ours(row, 0));
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists and belongs to someone else, which is still "there".
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitGone(pids: number[], ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && pids.some(isAlive)) await new Promise((r) => setTimeout(r, 200));
}

function taskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    try {
      const args = ['/pid', String(pid), '/T', ...(force ? ['/F'] : [])];
      const child = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Stops exactly these processes: `taskkill /T`, a grace period, then `taskkill /T /F`.
 *
 * The list is the whole set, worked out by the caller before anything is stopped — not a root to be
 * expanded with `/T` — because a tree whose root has already exited is invisible to `/T`, and that
 * is precisely the shape of a server left behind by `Start-Process`. `/T` is still passed, for
 * whatever a process managed to start while it was being stopped.
 *
 * This process and its parent are never on the list, whatever a caller passes.
 */
export async function stopProcesses(pids: number[], opts: { graceMs?: number } = {}): Promise<Map<number, StopHow>> {
  const how = new Map<number, StopHow>();
  const protect = new Set([process.pid, process.ppid]);
  const wanted = [...new Set(pids)].filter((p) => !protect.has(p));
  for (const p of wanted) if (!isAlive(p)) how.set(p, 'already-gone');
  let live = wanted.filter(isAlive);

  if (live.length > 0) {
    for (const p of live) await taskkill(p, false);
    await waitGone(live, opts.graceMs ?? CLOSE_GRACE_MS);
    for (const p of live) if (!isAlive(p)) how.set(p, 'closed');
    live = live.filter(isAlive);
  }
  for (const p of live) await taskkill(p, true);
  await waitGone(live, 2_000);
  for (const p of live) how.set(p, isAlive(p) ? 'failed' : 'forced');
  return how;
}

/**
 * Stops a process the runner started and everything under it that is still running — the form the
 * runner uses for a step that timed out, went silent or was aborted. `since` is when it was started,
 * so only processes from then on are read. When the table cannot be read, it falls back to
 * `taskkill /T /F` on the root, which is what it always did.
 */
export async function stopTree(rootPid: number, since: number, opts: { graceMs?: number } = {}): Promise<Map<number, StopHow>> {
  const table = await processTable(since);
  const root = table.find((r) => r.pid === rootPid);
  if (!root) {
    await taskkill(rootPid, true);
    return new Map([[rootPid, isAlive(rootPid) ? 'failed' : 'forced']]);
  }
  const tree = descendantsOf(table, [{ pid: rootPid, from: root.created }]).map((r) => r.pid);
  return await stopProcesses(tree, opts);
}

/** Folded for comparison: Windows paths are case-insensitive and can use either slash. */
const fold = (s: string): string => s.replace(/\//g, '\\').toLowerCase();

/**
 * The moment watching begins. Taken at the start of a task it reads nothing — nothing the task
 * started exists yet. Taken before a review it reads what the task's own work started since `from`,
 * so the review is answerable only for what it adds.
 */
export async function snapshotProcesses(_projectDir?: string, from?: number): Promise<ProcessSnapshot> {
  const since = Date.now();
  if (from === undefined) return { since, processes: [], listeners: [] };
  return { since: from, processes: await processTable(from), listeners: [] };
}

/**
 * What was created since the snapshot: the part of it the bot started (`ours`), and the part that
 * names the project folder but cannot be tied to a step (`notOurs`), each with its ports. Without a
 * tracker nothing is the bot's, and everything new in the folder is `notOurs`.
 */
export async function findLeftovers(
  projectDir: string,
  before: ProcessSnapshot,
  tracker?: ProcessTracker,
): Promise<{ ours: Leftover[]; notOurs: Leftover[] }> {
  const now = await processTable(before.since);
  // A process is "the same" only if its id *and* its creation time match: an id alone is reused.
  const known = new Set(before.processes.map((p) => `${p.pid}@${p.created}`));
  // The console host of a server's own window is its child in the table, and goes when the last
  // process on that console does; listing it would only be noise beside the server it belongs to.
  const fresh = now.filter((p) => !known.has(`${p.pid}@${p.created}`) && p.name.toLowerCase() !== 'conhost.exe');
  const mine = new Set(tracker ? descendantsOf(now, tracker.roots).map((r) => r.pid) : []);
  const folder = fold(projectDir);
  const ours = fresh.filter((p) => mine.has(p.pid));
  const notOurs = fresh
    .filter((p) => !mine.has(p.pid) && folder !== '' && fold(p.command).includes(folder))
    // The runner's own table query names nothing of the project, but keep it out regardless.
    .filter((p) => !p.command.includes('Get-CimInstance Win32_Process'));
  const listeners = await listenersOf([...ours, ...notOurs].map((p) => p.pid));
  const withPorts = (p: ProcessRow): Leftover => ({
    pid: p.pid,
    parent: p.parent,
    name: p.name,
    command: p.command,
    ports: listeners.filter((l) => l.pid === p.pid).map((l) => l.port),
  });
  return { ours: ours.map(withPorts), notOurs: notOurs.map(withPorts) };
}

/** Stops what the bot left running since the snapshot, and says what it stopped and what it did not. */
export async function reapLeftovers(projectDir: string, before: ProcessSnapshot, tracker?: ProcessTracker): Promise<ReapResult> {
  const { ours, notOurs } = await findLeftovers(projectDir, before, tracker);
  const result: ReapResult = { killed: [], failed: [], notOurs };
  if (ours.length === 0) return result;
  const how = await stopProcesses(ours.map((l) => l.pid));
  for (const l of ours) {
    const h = how.get(l.pid) ?? 'failed';
    (h === 'failed' ? result.failed : result.killed).push({ ...l, how: h });
  }
  return result;
}

/** One line per leftover, for the event and the record. */
export function describeLeftovers(leftovers: Leftover[]): string {
  return leftovers
    .map(
      (l) =>
        `${l.name} (pid ${l.pid}${l.ports.length > 0 ? `, listening on ${l.ports.join(', ')}` : ''}${l.how ? `, ${l.how}` : ''}): ` +
        l.command.slice(0, 160),
    )
    .join('\n');
}
