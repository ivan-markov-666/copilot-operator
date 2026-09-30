/**
 * Where the Desktop is, and whether it is backed up by OneDrive.
 *
 * Used by "save the log to the Desktop" and by `cop doctor`. What else once lived next to this — the
 * project copied to a Desktop folder and its files attached to the chat, and the bridge to Context
 * Picker — was removed on 2026-09-30 at the operator's request; the bot no longer hands the chat any
 * of the project's files.
 */
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/**
 * The Desktop folder.
 *
 * Candidates are tried in order and the first that exists wins, which is what makes this
 * correct under OneDrive's Known Folder Move: when the Desktop is backed up, the real
 * Desktop is `<OneDrive>\Desktop` and `%USERPROFILE%\Desktop` may not exist at all. No
 * registry read is needed for that.
 */
export function resolveDesktopDir(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.OneDriveCommercial ? join(env.OneDriveCommercial, 'Desktop') : null,
    env.OneDrive ? join(env.OneDrive, 'Desktop') : null,
    join(env.USERPROFILE ?? homedir(), 'Desktop'),
  ].filter((c): c is string => Boolean(c));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[candidates.length - 1];
}

/** Whether the resolved Desktop is inside OneDrive, so what is saved there also reaches the cloud. */
export function desktopIsSynced(env: NodeJS.ProcessEnv = process.env): boolean {
  return isInsideOneDrive(resolveDesktopDir(env), env);
}

/** Whether a folder sits inside a local OneDrive root. */
export function isInsideOneDrive(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const roots = [env.OneDriveCommercial, env.OneDrive, env.OneDriveConsumer].filter(
    (r): r is string => Boolean(r && r.trim()),
  );
  const target = resolve(dir).toLowerCase();
  return roots.some((r) => {
    const root = resolve(r).toLowerCase();
    return target === root || target.startsWith(root + sep);
  });
}
