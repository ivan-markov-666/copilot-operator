/**
 * A log, on the Desktop, with Explorer already pointing at it.
 *
 * The operator does not read these logs in a browser. They run the bot, and then they hand
 * what came out of it to a separate chat that orchestrates the whole effort. Offering the log
 * as a page in a new tab was answering a question nobody had: getting it from that tab into
 * the chat meant save-as, then remembering where the browser put it, then finding it again,
 * then dragging it. Four steps, every one of them somewhere else on the screen.
 *
 * So the log is written as a file instead, and Explorer is opened on it with the file already
 * selected. One press, and the thing the operator wants to drag is under the cursor. The
 * browser is not asked to be a file manager, because it is not one.
 *
 * The files go into one folder under the Desktop rather than loose on it. A Desktop that
 * slowly fills with task logs is a worse outcome than the tab ever was, and a folder that is
 * always the same one is also a place the operator learns, so the second log is found without
 * being revealed at all.
 *
 * Nothing here overwrites. A log that was saved once may already have been dragged into a
 * chat, attached to a message or renamed by somebody; writing over it because the same button
 * was pressed twice would destroy a file the bot has no claim on. Every save earns its own
 * name, and the timestamp in that name is what tells two saves of one attempt apart.
 *
 * Revealing is a Windows idea and this module says so plainly anywhere else, in the manner of
 * `folderPicker.ts`: the file is still written, and the caller is told where, so the feature
 * degrades to something useful rather than to an error.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { resolveDesktopDir } from '../context/contextFiles.js';

/** The one folder under the Desktop that every saved log lands in. */
export const LOGS_FOLDER = 'copilot-operator-logs';

/** Where the file went, and whether Explorer was actually opened on it. */
export type SavedLog = {
  /** The absolute path of the file that was written, for the UI to name back to the operator. */
  path: string;
  /** The folder it went into, so a caller can say "the folder is open" without parsing the path. */
  dir: string;
  /** The name it was given, which is not necessarily the name that was asked for. */
  fileName: string;
  /** True when Explorer was asked to open on the file with it selected. */
  revealed: boolean;
  /** Set when the file was saved but not revealed, saying plainly why. */
  note?: string;
};

/** What a saved log is named after: where it came from and which attempt it belongs to. */
export type LogNaming = {
  /** The session, as the operator named it. */
  session: string;
  /** The task title. */
  task: string;
  /** Which attempt this is the log of; left out when the task has only ever run once. */
  attempt?: number;
  /**
   * For one of a task's own files rather than its consolidated log, the file's name in the
   * run folder. Its extension is kept, because a `.md` report opened as `.txt` is a report
   * nobody can read comfortably.
   */
  file?: string;
};

/** Opening Explorer, kept as a value so a test can watch for the call without launching one. */
export type Reveal = (path: string) => Promise<void>;

/** What the module needs from the world, all of it replaceable in a test. */
export type SaveOptions = {
  reveal?: Reveal;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: Date;
};

/** The folder every saved log goes into. */
export function logsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDesktopDir(env), LOGS_FOLDER);
}

/**
 * One part of a file name, made safe for NTFS.
 *
 * Session names and task titles are prose written by a human, so they carry colons, slashes
 * and quotation marks as a matter of course — every one of them illegal in a Windows file
 * name. A name Windows refuses is a save that fails for a reason the operator cannot act on,
 * so the illegal characters become dashes rather than a refusal. The trailing dots and spaces
 * go too: Windows silently drops them, which would leave the path the caller was told about
 * and the file actually on disk disagreeing.
 */
export function sanitiseNamePart(part: string, limit = 60): string {
  const cleaned = part
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
    .replace(/[. ]+$/, '');
  return cleaned.length > 0 ? cleaned : 'unnamed';
}

/** The timestamp in a file name: sortable, readable, and legal, so local time with no colons. */
function stampOf(at: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}` +
    `-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`
  );
}

/**
 * The name a saved log is given: the session, the task, the attempt and when it was saved.
 *
 * All four are there because the operator ends up with a folder of these and has to tell them
 * apart by sight, in the drag-and-drop list of a chat, without opening any of them.
 */
export function logFileName(naming: LogNaming, at: Date = new Date()): string {
  const parts = [sanitiseNamePart(naming.session, 40), sanitiseNamePart(naming.task, 60)];
  if (naming.attempt !== undefined) parts.push(`attempt ${naming.attempt}`);

  // A task's own file keeps its extension; the consolidated log is text and says so.
  const extension = naming.file ? extname(naming.file) || '.txt' : '.txt';
  if (naming.file) {
    const stem = naming.file.slice(0, naming.file.length - extname(naming.file).length);
    parts.push(sanitiseNamePart(stem, 50));
  }

  parts.push(stampOf(at));
  return `${parts.join(' - ')}${extension}`;
}

/**
 * The asked-for name, or the first free variation of it.
 *
 * Two saves inside the same second collide on the timestamp, and so does a folder restored
 * from a backup. Windows' own ` (2)` suffix is used because the operator has seen it before
 * and knows what it means.
 */
export function freeName(dir: string, fileName: string, taken: (path: string) => boolean = existsSync): string {
  if (!taken(join(dir, fileName))) return fileName;
  const extension = extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken(join(dir, candidate))) return candidate;
  }
  // A thousand collisions is not a folder anyone is still reading, so stop guessing politely.
  return `${stem} (${Date.now()})${extension}`;
}

/**
 * Explorer, opened on the folder with the file selected.
 *
 * `explorer.exe` exits with a non-zero code when it has done exactly what was asked, which is
 * long-standing and documented behaviour rather than a bug to work around, so the exit code is
 * ignored entirely. Only a failure to start the process at all means the reveal did not
 * happen. The arguments go through verbatim because Explorer parses `/select,"<path>"` itself
 * and Node's own quoting of an argument with spaces in it would leave it parsing something
 * else.
 *
 * `windowsHide` is deliberately not set, unlike everywhere else in this codebase that starts a
 * process: it asks Windows to start the child with its window hidden, and a hidden window is
 * the exact opposite of the point here. Explorer is a windowed program with no console of its
 * own, so nothing flashes for leaving it off.
 */
export const revealInExplorer: Reveal = (path) =>
  new Promise((settle, fail) => {
    const child = spawn('explorer.exe', [`/select,"${path}"`], {
      windowsVerbatimArguments: true,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', fail);
    // Explorer outlives the API process; nothing here waits for it to close.
    child.on('spawn', () => {
      child.unref();
      settle();
    });
  });

/**
 * Writes the text to the Desktop folder and opens Explorer on it.
 *
 * Failing to reveal is not failing to save. The file is on disk either way and the caller is
 * told where, because a path the operator can paste into an address bar is still most of what
 * they wanted.
 */
export async function saveAndReveal(text: string, naming: LogNaming, options: SaveOptions = {}): Promise<SavedLog> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const dir = logsDir(env);

  await mkdir(dir, { recursive: true });
  const fileName = freeName(dir, logFileName(naming, options.now ?? new Date()));
  const path = join(dir, fileName);
  await writeFile(path, text, 'utf8');

  if (platform !== 'win32') {
    return { path, dir, fileName, revealed: false, note: 'Opening the folder is Windows-only. The file was saved.' };
  }

  const reveal = options.reveal ?? revealInExplorer;
  try {
    await reveal(path);
    return { path, dir, fileName, revealed: true };
  } catch (e) {
    return { path, dir, fileName, revealed: false, note: `The file was saved, but Explorer did not open: ${(e as Error).message}` };
  }
}
