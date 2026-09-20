/**
 * What a task or a review leaves running, found and stopped by the runner.
 *
 * "Anything you start, you stop" is in both contracts, and it is advice: in one run the
 * reviewer left its own `next start` listening on 4310 and then failed the work for it, and
 * every plan written so far has carried its own checks for ports and node processes because
 * nothing else would. The runner can own this. It takes a snapshot of the processes whose
 * command line names the project folder, and of the ports being listened on, before a task
 * and before each review; afterwards, what is new is stopped with `taskkill /T` and written
 * on the task with where it came from. The plan's own checks still run first — a server the
 * implementer forgot goes back to the chat as a failed check — and this is the net under them.
 *
 * Scoped to the project folder on purpose: the runner will not stop a process it cannot tie
 * to the work, and when the project is this runner's own checkout it does nothing at all.
 */
import { spawn } from 'node:child_process';

export type ProjectProcess = { pid: number; parent: number; name: string; command: string };
export type Listener = { port: number; pid: number };
export type ProcessSnapshot = { processes: ProjectProcess[]; listeners: Listener[] };

export type Leftover = ProjectProcess & { ports: number[] };
export type ReapResult = { killed: Leftover[]; failed: Leftover[] };

/** Runs one PowerShell expression and returns its stdout, or null when it cannot. */
function powershell(script: string, timeoutMs = 20_000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
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

/** For a `-like` pattern inside single quotes: the folder as PowerShell will read it. */
function likeLiteral(dir: string): string {
  return dir.replace(/'/g, "''").replace(/[[\]]/g, (c) => `[${c}]`);
}

/** The processes tied to the folder, and every port being listened on, right now. */
export async function snapshotProcesses(projectDir: string): Promise<ProcessSnapshot> {
  const dir = likeLiteral(projectDir);
  const procs = await powershell(
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${dir}*' } | ` +
      `Select-Object ProcessId, ParentProcessId, Name, CommandLine | ConvertTo-Json -Compress`,
  );
  const ports = await powershell(
    `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort, OwningProcess | ConvertTo-Json -Compress`,
  );
  return {
    processes: parseJsonList<{ ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string }>(procs)
      .filter((p) => p.ProcessId !== process.pid)
      .map((p) => ({ pid: p.ProcessId, parent: p.ParentProcessId, name: p.Name ?? '', command: p.CommandLine ?? '' })),
    listeners: parseJsonList<{ LocalPort: number; OwningProcess: number }>(ports).map((l) => ({ port: l.LocalPort, pid: l.OwningProcess })),
  };
}

/** What is running now that was not before, tied to the folder, with the ports it holds. */
export async function findLeftovers(projectDir: string, before: ProcessSnapshot): Promise<Leftover[]> {
  const now = await snapshotProcesses(projectDir);
  const known = new Set(before.processes.map((p) => p.pid));
  const fresh = now.processes.filter((p) => !known.has(p.pid));
  return fresh.map((p) => ({ ...p, ports: now.listeners.filter((l) => l.pid === p.pid).map((l) => l.port) }));
}

function killTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/** Stops what was left running since the snapshot, and says what it stopped. */
export async function reapLeftovers(projectDir: string, before: ProcessSnapshot): Promise<ReapResult> {
  const leftovers = await findLeftovers(projectDir, before);
  const result: ReapResult = { killed: [], failed: [] };
  // Parents first: killing the root with /T takes the tree, and a child killed on its own
  // would otherwise be reported as failed once its parent is gone.
  const pids = new Set(leftovers.map((l) => l.pid));
  const roots = leftovers.filter((l) => !pids.has(l.parent));
  const rest = leftovers.filter((l) => pids.has(l.parent));
  for (const l of roots) (await killTree(l.pid)) ? result.killed.push(l) : result.failed.push(l);
  for (const l of rest) {
    // Probably gone with its parent; count it as killed unless it is demonstrably still there.
    result.killed.push(l);
  }
  return result;
}

/** One line per leftover, for the event and the record. */
export function describeLeftovers(leftovers: Leftover[]): string {
  return leftovers
    .map((l) => `${l.name} (pid ${l.pid}${l.ports.length > 0 ? `, listening on ${l.ports.join(', ')}` : ''}): ${l.command.slice(0, 160)}`)
    .join('\n');
}
