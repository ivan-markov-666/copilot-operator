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

export type ProfileUser = { pid: number; commandLine: string };

/**
 * Edge processes that currently have this profile open.
 *
 * Windows only, via CIM. A failure to query is reported as "unknown" rather than "none", so
 * a broken check never silently claims the profile is free.
 */
export function findEdgeUsingProfile(profileDir: string): ProfileUser[] | 'unknown' {
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*${profileDir.replace(/\\/g, '\\').replace(/'/g, "''")}*' } | ` +
    `Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`;

  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  if (res.status !== 0 || typeof res.stdout !== 'string') return 'unknown';

  const text = res.stdout.trim();
  if (text.length === 0) return [];
  try {
    const parsed = JSON.parse(text) as
      | { ProcessId: number; CommandLine: string }
      | Array<{ ProcessId: number; CommandLine: string }>;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((p) => ({ pid: p.ProcessId, commandLine: p.CommandLine ?? '' }));
  } catch {
    return 'unknown';
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
