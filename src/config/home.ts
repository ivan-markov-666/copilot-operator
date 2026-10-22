/**
 * The bot's folder: its settings, its conversations, its logs and its Edge profile (operator, 2026-10-22: "let the
 * user choose where the bot's profile is kept; with nothing chosen, show the default; no .copilot-operator folder in
 * the project unless it was set there").
 *
 * A package keeps it in `defaultHome()` unless the operator chose another folder, which is written in the default
 * folder's `location.json` and read at start (see `installLayout`). A start that finds the bot's records where they
 * were kept until then — `.copilot-operator` in the folder it was started from — and none yet in its folder copies
 * them over once, and says so; the old folder is left for the operator to delete.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { defaultHome, HOME_CHOICE_FILE, type InstallLayout } from './layout.js';

/** The file in the bot's folder that says where its records were copied from, and when. */
const MOVED_FILE = 'moved-from.json';

const same = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const inside = (dir: string, root: string): boolean => {
  const a = resolve(dir).toLowerCase();
  const b = resolve(root).toLowerCase();
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/** Whether a folder holds the bot's records: its settings or its conversations. */
function holdsRecords(home: string): boolean {
  return existsSync(join(home, 'data', 'settings.json')) || existsSync(join(home, 'data', 'sessions'));
}

/**
 * At start: the records a package kept in the project's `.copilot-operator` until 2026-10-22, copied into the bot's
 * folder when that has none of its own yet. Not when the operator chose the project's folder itself, nor when
 * COP_HOME or COP_DATA_DIR place the records. The old folder is left as it was.
 */
export function moveLegacyHome(layout: InstallLayout, env: NodeJS.ProcessEnv = process.env): { from: string; to: string } | null {
  if (layout.mode !== 'package' || layout.homeFrom === 'env' || env.COP_DATA_DIR?.trim() || !layout.legacyHomeDir) return null;
  const legacy = layout.legacyHomeDir;
  if (same(legacy, layout.homeDir) || !holdsRecords(legacy) || holdsRecords(layout.homeDir)) return null;
  mkdirSync(layout.homeDir, { recursive: true });
  for (const part of ['data', 'runs']) {
    if (existsSync(join(legacy, part))) cpSync(join(legacy, part), join(layout.homeDir, part), { recursive: true, force: false, errorOnExist: false });
  }
  writeFileSync(join(layout.homeDir, MOVED_FILE), JSON.stringify({ from: legacy, at: new Date().toISOString() }, null, 2), 'utf8');
  return { from: legacy, to: layout.homeDir };
}

/** Where the bot's records were copied from into this folder, and when; null when they were not. */
export function movedFrom(home: string): { from: string; at: string; stillThere: boolean } | null {
  try {
    const v = JSON.parse(readFileSync(join(home, MOVED_FILE), 'utf8')) as { from?: unknown; at?: unknown };
    if (typeof v.from !== 'string' || typeof v.at !== 'string') return null;
    return { from: v.from, at: v.at, stillThere: existsSync(v.from) };
  } catch {
    return null;
  }
}

/** Why a folder cannot be the bot's, or null when it can: absolute, not the program's own, writable. */
export function homeRefusal(dir: string, layout: InstallLayout): string | null {
  if (!dir.trim() || !isAbsolute(dir.trim())) return 'Give the whole path of a folder, as C:\\Users\\you\\bot or D:\\bot.';
  const d = resolve(dir.trim());
  if (inside(d, layout.botRoot) || /[\\/]node_modules([\\/]|$)/i.test(d)) return 'That is inside the program itself, which npm replaces on every update: choose a folder of your own.';
  // Copied into itself, or over the folder it is copied from, a copy would never end.
  if (!same(d, layout.homeDir) && (inside(d, layout.homeDir) || inside(layout.homeDir, d))) return `That folder is inside the bot's folder now (${layout.homeDir}), or holds it: choose one beside it.`;
  try {
    mkdirSync(d, { recursive: true });
    const probe = join(d, `.cop-write-test-${process.pid}`);
    writeFileSync(probe, 'x', 'utf8');
    rmSync(probe, { force: true });
  } catch (e) {
    return `That folder cannot be written to: ${(e as Error).message}`;
  }
  return null;
}

/**
 * The operator's choice of folder, written where the next start reads it; `null` back to the default. With `copy`,
 * what is in the folder now — settings, conversations, logs, the Edge profile — is copied into the new one first,
 * leaving out what the new one has already (`kept`): nothing in it is overwritten. Takes effect when the bot starts
 * again.
 */
export function chooseHome(
  layout: InstallLayout,
  dir: string | null,
  copy: boolean,
  env: NodeJS.ProcessEnv = process.env,
): { home: string; copied: string[]; kept: string[] } {
  const target = dir ? resolve(dir.trim()) : defaultHome(env);
  const copied: string[] = [];
  const kept: string[] = [];
  if (copy && !same(target, layout.homeDir) && existsSync(layout.homeDir)) {
    mkdirSync(target, { recursive: true });
    for (const part of readdirSync(layout.homeDir)) {
      if (part === HOME_CHOICE_FILE || part === MOVED_FILE) continue;
      if (existsSync(join(target, part))) {
        kept.push(part);
        continue;
      }
      cpSync(join(layout.homeDir, part), join(target, part), { recursive: true, force: false, errorOnExist: false });
      copied.push(part);
    }
  }
  const pointerDir = defaultHome(env);
  mkdirSync(pointerDir, { recursive: true });
  const pointer = join(pointerDir, HOME_CHOICE_FILE);
  if (same(target, pointerDir)) rmSync(pointer, { force: true });
  else writeFileSync(pointer, JSON.stringify({ home: target }, null, 2), 'utf8');
  return { home: target, copied, kept };
}
