/**
 * What a task or a review leaves running, found and stopped by the runner — and how anything the
 * runner stops is stopped.
 *
 * "Anything you start, you stop" is in both contracts, and it is advice: in one run the reviewer
 * left its own `next start` listening on 4310 and then failed the work for it, and every plan
 * written so far has carried its own checks for ports and node processes because nothing else
 * would. The runner can own this. It takes a snapshot of the process table and of the ports being
 * listened on before a task and before each review; afterwards, what is new *and was started by
 * the bot* is stopped and written on the task with where it came from. The plan's own checks still
 * run first — a server the implementer forgot goes back to the chat as a failed check — and this
 * is the net under them.
 *
 * Two things changed on 2026-09-27, both at the operator's request.
 *
 * **Whose processes.** The first version stopped every new process whose command line named the
 * project folder. That is a description of a place, not of an owner: a server the operator started
 * by hand in the same folder while a run was going matched it exactly, and was killed. Now a
 * process is the bot's only if it descends from a step the bot itself started — every shell
 * `runStep` spawns is recorded in a `ProcessTracker`, with when it started and ended, and a
 * process belongs to the run if its chain of parents reaches one of them. Windows does not
 * re-parent an orphan, so a server left behind by `Start-Process` still names the step's shell as
 * its parent after that shell has exited; the times are what stop a *reused* process id from
 * passing for it — a child is only accepted as a step's if it was created while that step's shell
 * was alive, and a parent that is alive is only followed if it is older than the child. What is new
 * in the folder but not provably the bot's is **reported and left running**. The honest limit: a
 * program started through a wrapper that exits at once (`cmd /c start …`) leaves a process whose
 * parent is gone and was never recorded; it is reported, not stopped.
 *
 * **How.** It used to be `taskkill /T /F`, which is TerminateProcess: no handler runs, a server
 * cannot close its sockets or flush its files, and a browser under Playwright is cut off mid-write
 * to its profile. Now it is what a person at the console does first — Ctrl+C — then, for whatever
 * is still there after a grace period, Ctrl+Break, and only then `/F`. See `signalConsoles` for why
 * both keys, and for what was verified on this machine.
 */
import { spawn } from 'node:child_process';

export type ProjectProcess = { pid: number; parent: number; name: string; command: string };
export type Listener = { port: number; pid: number };
/** A row of the process table: `created` is milliseconds since the epoch, 0 when Windows would not say. */
export type ProcessRow = ProjectProcess & { created: number };
export type ProcessSnapshot = { processes: ProcessRow[]; listeners: Listener[] };

/** How a process came to be stopped. */
export type StopHow = 'already-gone' | 'ctrl-c' | 'ctrl-break' | 'forced' | 'failed';
export type Leftover = ProjectProcess & { ports: number[]; how?: StopHow };
/**
 * `killed` and `failed` are the bot's own; `notOurs` is what appeared in the project folder during
 * the same time and could not be tied to a step the bot started, and so was left running.
 */
export type ReapResult = { killed: Leftover[]; failed: Leftover[]; notOurs: Leftover[] };

/** How long a process is given to act on Ctrl+C, and then on Ctrl+Break, before `/F`. */
export const CTRL_C_GRACE_MS = 5_000;
export const CTRL_BREAK_GRACE_MS = 3_000;

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

/** Runs PowerShell with the script on stdin, and returns its stdout, or null when it cannot. */
function powershell(script: string, timeoutMs = 20_000): Promise<string | null> {
  return new Promise((resolve) => {
    // The script goes in on stdin rather than as an argument. An argument would have to be quoted
    // for the Windows command line, and the other way round it, `-EncodedCommand`, is the first
    // thing a security team's tooling flags — rightly, see `dangerous.ts`.
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true });
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
    child.stdin.on('error', () => undefined);
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? out : null);
    });
    child.stdin.end(`${script}\n`);
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

/** Every process on the machine, with its parent and when it was created. */
export async function processTable(): Promise<ProcessRow[]> {
  const text = await powershell(
    'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, ' +
      "@{n='Created';e={ if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 } }} | ConvertTo-Json -Compress",
  );
  return parseJsonList<{ ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null; Created: number }>(text).map((p) => ({
    pid: p.ProcessId,
    parent: p.ParentProcessId,
    name: p.Name ?? '',
    command: p.CommandLine ?? '',
    created: fromFileTime(p.Created),
  }));
}

/** Slack either side of a recorded start or end: the table's clock and ours are read separately. */
const SLACK_MS = 2_000;

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

/**
 * Sends Ctrl+C or Ctrl+Break to the console each target is attached to, and says what happened.
 *
 * Windows has no signal to send another process. What it has is the console: a key pressed there
 * reaches every process attached to it, and a helper can attach to a process's console and raise
 * the event itself (`AttachConsole` + `GenerateConsoleCtrlEvent`). That is what this does, in a
 * short-lived Windows PowerShell with the four kernel32 calls declared through `Add-Type`.
 *
 * Verified on this machine on 2026-09-27 against a real Node HTTP server whose SIGINT and SIGBREAK
 * handlers write down which one arrived, in the four shapes a step leaves a server in: spawned
 * directly by the runner, run in the foreground of a step's shell, left behind by `Start-Process`
 * in a console of its own, and by `Start-Process -NoNewWindow` in the dead step's console. Ctrl+Break
 * stopped all four through their own handlers. Ctrl+C stopped none of them *there*, because the
 * process that launched the experiment had Ctrl+C switched off and every descendant inherits that
 * flag; with the flag cleared, the same server stopped on Ctrl+C. A bot started with `npm start`
 * from a terminal normally has it on, but nothing guarantees it, which is why Ctrl+Break follows:
 * it cannot be switched off, and for a Node process with no handler it still ends the process
 * through the normal exit path rather than TerminateProcess.
 *
 * Two refusals, because a console key reaches *everyone* on the console. A console that `protect`
 * is on — the bot itself, the process that started it — is never signalled. And when `allowed` is
 * given, a console with any process on it outside that list is not signalled either: the key is
 * only pressed where every process that will feel it is one being stopped anyway. A refused target
 * is simply left to the next stage.
 */
export async function signalConsoles(
  targets: number[],
  event: 'ctrl-c' | 'ctrl-break',
  opts: { protect: number[]; allowed?: number[] },
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (targets.length === 0 || process.platform !== 'win32') return result;
  const list = (xs: number[]): string => (xs.length ? xs.map((x) => String(Math.trunc(x))).join(',') : '');
  const script = `
$ErrorActionPreference = 'Continue'
Add-Type -Namespace CopStop -Name Con -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList(uint[] list, uint count);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool add);
public delegate bool Handler(uint ev);
public static Handler Keep = delegate(uint ev) { return true; };
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(Handler h, bool add);
'@
[CopStop.Con]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $true) | Out-Null
[CopStop.Con]::SetConsoleCtrlHandler([CopStop.Con]::Keep, $true) | Out-Null
$targets = @(${list(targets)})
$protect = @(${list(opts.protect)})
$allowed = ${opts.allowed ? `@(${list(opts.allowed)})` : '$null'}
$done = @{}
$lines = New-Object System.Collections.Generic.List[string]
foreach ($t in $targets) {
  [CopStop.Con]::FreeConsole() | Out-Null
  if (-not [CopStop.Con]::AttachConsole([uint32]$t)) { $lines.Add("$t|no-console"); continue }
  $buf = New-Object 'uint32[]' 128
  $n = [CopStop.Con]::GetConsoleProcessList($buf, 128)
  if ($n -gt 128 -or $n -eq 0) { $lines.Add("$t|unreadable"); continue }
  $on = @($buf[0..($n - 1)] | Where-Object { $_ -ne $PID })
  $key = (($on | Sort-Object) -join ',')
  if (@($on | Where-Object { $protect -contains $_ }).Count -gt 0) { $lines.Add("$t|protected"); continue }
  if ($allowed -ne $null) {
    $strangers = @($on | Where-Object { $allowed -notcontains $_ })
    if ($strangers.Count -gt 0) { $lines.Add("$t|shared:" + ($strangers -join ' ')); continue }
  }
  if ($done.ContainsKey($key)) { $lines.Add("$t|sent"); continue }
  if ([CopStop.Con]::GenerateConsoleCtrlEvent([uint32]${event === 'ctrl-c' ? 0 : 1}, 0)) { $done[$key] = $true; $lines.Add("$t|sent") } else { $lines.Add("$t|failed") }
  Start-Sleep -Milliseconds 150
}
[CopStop.Con]::FreeConsole() | Out-Null
$lines -join [char]10
`;
  const out = await powershell(script, 30_000);
  for (const line of (out ?? '').split(/\r?\n/)) {
    const [pid, what] = line.split('|');
    if (pid && what) result.set(Number(pid), what.trim());
  }
  return result;
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

function forceKill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Stops exactly these processes: Ctrl+C, a grace period, Ctrl+Break, another, then `taskkill /F`.
 *
 * The list is the whole set, worked out by the caller before anything is signalled — not a root to
 * be expanded with `/T` — because a tree whose root has already exited is invisible to `/T`, and
 * that is precisely the shape of a server left behind by `Start-Process`. `/T` is still passed at
 * the last stage, for whatever a process managed to start while it was being asked to stop.
 *
 * `protect` is always joined by this process and its parent, so a caller cannot forget them.
 */
export async function stopProcesses(
  pids: number[],
  opts: { protect?: number[]; allowed?: number[]; ctrlCGraceMs?: number; ctrlBreakGraceMs?: number } = {},
): Promise<Map<number, StopHow>> {
  const how = new Map<number, StopHow>();
  const protect = [...(opts.protect ?? []), process.pid, process.ppid];
  let live = [...new Set(pids)].filter((p) => !protect.includes(p));
  for (const p of pids) if (!isAlive(p)) how.set(p, 'already-gone');
  live = live.filter(isAlive);

  const stage = async (event: 'ctrl-c' | 'ctrl-break', grace: number): Promise<void> => {
    if (live.length === 0) return;
    await signalConsoles(live, event, { protect, allowed: opts.allowed });
    // Waited for whether or not the key could be pressed: a process sharing the operator's own
    // console received the operator's Ctrl+C directly and may already be on its way out.
    await waitGone(live, grace);
    for (const p of live) if (!isAlive(p)) how.set(p, event);
    live = live.filter(isAlive);
  };
  await stage('ctrl-c', opts.ctrlCGraceMs ?? CTRL_C_GRACE_MS);
  await stage('ctrl-break', opts.ctrlBreakGraceMs ?? CTRL_BREAK_GRACE_MS);

  for (const p of live) await forceKill(p);
  await waitGone(live, 2_000);
  for (const p of live) how.set(p, isAlive(p) ? 'failed' : 'forced');
  return how;
}

/**
 * Stops a process and everything under it that is still running — the form the runner uses for a
 * step that timed out, went silent or was aborted. The tree is read from the process table first;
 * when the table cannot be read, it falls back to `taskkill /T /F`, which is what it always did.
 */
export async function stopTree(rootPid: number, opts: { ctrlCGraceMs?: number; ctrlBreakGraceMs?: number } = {}): Promise<Map<number, StopHow>> {
  const table = await processTable();
  const root = table.find((r) => r.pid === rootPid);
  if (!root) {
    await forceKill(rootPid);
    return new Map([[rootPid, isAlive(rootPid) ? 'failed' : 'forced']]);
  }
  const tree = descendantsOf(table, [{ pid: rootPid, from: root.created }]).map((r) => r.pid);
  return await stopProcesses(tree, { ...opts, allowed: tree });
}

/** Folded for comparison: Windows paths are case-insensitive and can use either slash. */
const fold = (s: string): string => s.replace(/\//g, '\\').toLowerCase();

/** The whole process table, and every port being listened on, right now. */
export async function snapshotProcesses(_projectDir?: string): Promise<ProcessSnapshot> {
  const processes = (await processTable()).filter((p) => p.pid !== process.pid);
  const ports = await powershell(
    `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort, OwningProcess | ConvertTo-Json -Compress`,
  );
  return {
    processes,
    listeners: parseJsonList<{ LocalPort: number; OwningProcess: number }>(ports).map((l) => ({ port: l.LocalPort, pid: l.OwningProcess })),
  };
}

/**
 * What is running now that was not before: the part of it the bot started (`ours`), and the part
 * that names the project folder but cannot be tied to a step (`notOurs`), each with its ports.
 * Without a tracker nothing is the bot's, and everything new in the folder is `notOurs`.
 */
export async function findLeftovers(
  projectDir: string,
  before: ProcessSnapshot,
  tracker?: ProcessTracker,
): Promise<{ ours: Leftover[]; notOurs: Leftover[] }> {
  const now = await snapshotProcesses();
  // A process is "the same" only if its id *and* its creation time match: an id alone is reused.
  const known = new Set(before.processes.map((p) => `${p.pid}@${p.created}`));
  // The console host of a server's own window is its child in the table, and goes when the last
  // process on that console does; listing it would only be noise beside the server it belongs to.
  const fresh = now.processes.filter((p) => !known.has(`${p.pid}@${p.created}`) && p.name.toLowerCase() !== 'conhost.exe');
  const mine = new Set(tracker ? descendantsOf(now.processes, tracker.roots).map((r) => r.pid) : []);
  const folder = fold(projectDir);
  const withPorts = (p: ProcessRow): Leftover => ({
    pid: p.pid,
    parent: p.parent,
    name: p.name,
    command: p.command,
    ports: now.listeners.filter((l) => l.pid === p.pid).map((l) => l.port),
  });
  return {
    ours: fresh.filter((p) => mine.has(p.pid)).map(withPorts),
    // The query that read the table names nothing, since it no longer filters by folder; but keep
    // the reaper from reporting its own PowerShell should that ever change.
    notOurs: fresh
      .filter((p) => !mine.has(p.pid) && folder !== '' && fold(p.command).includes(folder))
      .filter((p) => !p.command.includes('Get-CimInstance Win32_Process'))
      .map(withPorts),
  };
}

/** Stops what the bot left running since the snapshot, and says what it stopped and what it did not. */
export async function reapLeftovers(projectDir: string, before: ProcessSnapshot, tracker?: ProcessTracker): Promise<ReapResult> {
  const { ours, notOurs } = await findLeftovers(projectDir, before, tracker);
  const result: ReapResult = { killed: [], failed: [], notOurs };
  if (ours.length === 0) return result;
  const pids = ours.map((l) => l.pid);
  const how = await stopProcesses(pids, { allowed: pids });
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
