/**
 * Edits not saved, and the tabs that hold them, kept in this browser by folder (second bug hunt, 2026-11-19).
 *
 * They lived only in the page: leaving the workbench — Settings or the queue in the bar on top, "+ Skills", a command of
 * Ctrl+K, the page opening Settings by itself at a locator that found nothing, a reload — lost every edit not saved,
 * without a word. And "Open a folder" kept the tabs of the folder before, whose Ctrl+S then wrote one folder's edit
 * into the other's file of the same name. Now each folder keeps its own tabs, and each edit is kept as it is typed,
 * with the version of the file it was made on: back in the editor when the folder and the file are open again — the
 * file changed on disk meanwhile is said, as under any edit, and not saved over without asking.
 *
 * A browser that keeps nothing (storage blocked or full) loses nothing silently either: the page asks before it is
 * left while such an edit is open (`hasUnkept`).
 */

const DRAFTS_KEY = 'cop.drafts.v1';
const TABS_KEY = 'cop.tabs.v1';

export type Draft = { text: string; version?: string; at: string };
export type KeptTab = { kind: 'file'; path: string; preview?: boolean };
type Drafts = Record<string, Record<string, Draft>>;
type Tabs = Record<string, { tabs: KeptTab[]; active: string }>;

/** Edits that could not be kept in this browser, by folder and file: the page asks before it is left while one is open. */
const unkept = new Set<string>();
/** Edits thrown away on closing their tab: a late keep of the closing editor does not bring them back. */
const discarded = new Set<string>();
const at = (dir: string, path: string): string => `${dir}\n${path}`;

function readAll<T>(key: string): T {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    return (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as T;
  } catch {
    return {} as T;
  }
}

function writeAll(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** The edit kept for a file of a folder, if there is one. */
export function readDraft(dir: string, path: string): Draft | null {
  discarded.delete(at(dir, path));
  const d = readAll<Drafts>(DRAFTS_KEY)[dir]?.[path];
  return d && typeof d.text === 'string' ? d : null;
}

/** Keeps an edit; false when this browser could not keep it (then the page asks before it is left). */
export function keepDraft(dir: string, path: string, text: string, version?: string): boolean {
  if (discarded.has(at(dir, path))) return true;
  const all = readAll<Drafts>(DRAFTS_KEY);
  all[dir] = { ...(all[dir] ?? {}), [path]: { text, ...(version ? { version } : {}), at: new Date().toISOString() } };
  const kept = writeAll(DRAFTS_KEY, all);
  if (kept) unkept.delete(at(dir, path));
  else unkept.add(at(dir, path));
  return kept;
}

/** The edit saved, put back, or read over from disk: nothing kept for it any more. */
export function dropDraft(dir: string, path: string): void {
  unkept.delete(at(dir, path));
  const all = readAll<Drafts>(DRAFTS_KEY);
  if (!all[dir]?.[path]) return;
  delete all[dir]![path];
  if (Object.keys(all[dir]!).length === 0) delete all[dir];
  writeAll(DRAFTS_KEY, all);
}

/** The edit thrown away as its tab closes, after the operator said so. */
export function discardDraft(dir: string, path: string): void {
  discarded.add(at(dir, path));
  dropDraft(dir, path);
}

/** Whether an edit is open that this browser could not keep. */
export function hasUnkept(): boolean {
  return unkept.size > 0;
}

/** The tabs of a folder as they were left, and which was in front. */
export function readTabs(dir: string): { tabs: KeptTab[]; active: string } {
  const kept = readAll<Tabs>(TABS_KEY)[dir];
  const tabs = Array.isArray(kept?.tabs) ? kept.tabs.filter((x) => x && x.kind === 'file' && typeof x.path === 'string') : [];
  return { tabs, active: typeof kept?.active === 'string' ? kept.active : '' };
}

/** The tabs of a folder, kept as they are now. */
export function keepTabs(dir: string, tabs: KeptTab[], active: string): void {
  const all = readAll<Tabs>(TABS_KEY);
  if (tabs.length === 0) delete all[dir];
  else all[dir] = { tabs, active };
  writeAll(TABS_KEY, all);
}
