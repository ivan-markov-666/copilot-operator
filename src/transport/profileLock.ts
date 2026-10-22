/**
 * Guards the browser profile directory.
 *
 * Chromium profiles are single-writer. If any Edge process already has this profile open,
 * a second launch does not get its own browser: it hands the request to the running one and
 * exits, which Playwright then reports as
 *
 *   Target page, context or browser has been closed
 *
 * a message that says nothing about the actual cause. That failure has already been seen in
 * practice, with leftover `msedge.exe` processes still holding the profile from an earlier
 * run. So the profile is checked and locked before the browser is launched, and the error
 * says what to do.
 */
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { winPsEnv } from '../exec/winps.js';

export type ProfileUser = { pid: number; commandLine: string; /** The process that started it. */ parentPid?: number };

/**
 * Edge processes that currently have this profile open.
 *
 * Windows only, via CIM. A failure to query is reported as "unknown" rather than "none", so
 * a broken check never silently claims the profile is free.
 */
export function findEdgeUsingProfile(profileDir: string): ProfileUser[] | 'unknown' {
  // The folder as text, not a pattern: -like read a [ or ] in a path as a wildcard (2026-10-22).
  const script =
    `$dir = '${profileDir.replace(/'/g, "''")}'; ` +
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
    `Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($dir, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ` +
    `Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress`;

  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: winPsEnv(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  if (res.status !== 0 || typeof res.stdout !== 'string') return 'unknown';

  const text = res.stdout.trim();
  if (text.length === 0) return [];
  try {
    type Row = { ProcessId: number; ParentProcessId?: number; CommandLine: string };
    const parsed = JSON.parse(text) as Row | Row[];
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((p) => ({ pid: p.ProcessId, commandLine: p.CommandLine ?? '', ...(typeof p.ParentProcessId === 'number' ? { parentPid: p.ParentProcessId } : {}) }));
  } catch {
    return 'unknown';
  }
}

/**
 * Whose the Edge holding the profile is (2026-10-22: the System page called the bot's own chat window — kept open
 * between messages — a stray Edge that "would make a run fail"). Edge's main process is the one whose parent is not
 * itself an Edge holding the profile; the others are its children. When every main process was started by `owner` —
 * the bot's API, whose browser Playwright launches as its child — it is the bot's own.
 */
export function profileHolder(users: ProfileUser[] | 'unknown', owner: number): 'free' | 'own' | 'other' | 'unknown' {
  if (users === 'unknown') return 'unknown';
  if (users.length === 0) return 'free';
  const pids = new Set(users.map((u) => u.pid));
  const mains = users.filter((u) => u.parentPid === undefined || !pids.has(u.parentPid));
  return mains.length > 0 && mains.every((m) => m.parentPid === owner) ? 'own' : 'other';
}

/** The bot process whose lock is on the profile, while it is alive: the API that opened the browser on it. */
export function profileLockOwner(profileDir: string): number | null {
  try {
    const held = JSON.parse(readFileSync(join(profileDir, '.cop-lock.json'), 'utf8')) as { pid?: unknown };
    if (typeof held.pid !== 'number') return null;
    process.kill(held.pid, 0);
    return held.pid;
  } catch {
    return null;
  }
}

export type LockHandle = { release: () => void };

/**
 * Takes the lock, or explains why it cannot.
 *
 * A stale lock file (its process is gone) is taken over rather than treated as fatal,
 * because a crashed run would otherwise leave the profile unusable until someone deleted a
 * file they have never heard of.
 */
export function acquireProfileLock(profileDir: string): LockHandle {
  mkdirSync(profileDir, { recursive: true });
  const lockPath = join(profileDir, '.cop-lock.json');

  if (existsSync(lockPath)) {
    try {
      const held = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; startedAt: string };
      let alive = false;
      try {
        process.kill(held.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive && held.pid !== process.pid) {
        throw new Error(
          `The browser profile at ${profileDir} is already in use by copilot-operator ` +
            `(process ${held.pid}, started ${held.startedAt}). Wait for that run to finish, or stop it.`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('The browser profile')) throw e;
      // An unreadable lock file is stale by definition; take it over.
    }
  }

  const users = findEdgeUsingProfile(profileDir);
  if (Array.isArray(users) && users.length > 0) {
    const pids = users.map((u) => u.pid).join(', ');
    throw new Error(
      `Microsoft Edge is already running with this profile (process ${pids}), so a new ` +
        `browser cannot be launched and Playwright would fail with "Target page, context or ` +
        `browser has been closed".\n` +
        `Close that Edge window, or end those processes:\n` +
        `  Stop-Process -Id ${users.map((u) => u.pid).join(',')} -Force\n` +
        `Profile: ${profileDir}`,
    );
  }

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');

  return {
    release: () => {
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    },
  };
}
