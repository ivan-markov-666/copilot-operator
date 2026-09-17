/**
 * Project files as chat context, via Context Picker.
 *
 * The user already maintains https://github.com/ivan-markov-666/context-picker, a VS Code
 * and Visual Studio extension for ticking the files a project should hand to an LLM. It is
 * not merely reusable here, it was clearly built with this exact case in mind. Its
 * `copySelectionToDir` already carries:
 *
 *   appendTxtExtension  "so that tools which block source extensions (e.g. Microsoft 365
 *                        Copilot) accept the uploads" - exactly the constraint we hit,
 *                        since the chat's upload input rejects .ps1, .ts and friends
 *   pathInName          flattens src/lib/app.ts into src--lib--app.ts, "lets a flat upload
 *                        (e.g. OneDrive) keep the original folder structure in the name"
 *   syncOnly            mirrors instead of wiping, "minimises churn for a synced folder
 *                        such as OneDrive"
 *
 * So this module does not reimplement any of that. It shells out to the extension's own
 * bridge CLI and then treats the export folder as the bot's context source.
 *
 * **Everything here happens in the file system, never through the browser.** The user points
 * at the project root, ticks files in the extension, and the extension copies them into one
 * folder on the Desktop. No Playwright, no upload form, no web picker in this path.
 *
 * **The folder is updated incrementally.** The extension's `syncOnly` mode writes only new
 * and changed files and deletes the ones no longer selected, so a re-export does not rewrite
 * a folder full of unchanged files. On top of that this module keeps a manifest of content
 * hashes, so the bot can tell what actually changed since the last run and avoid handing the
 * chat the same files again.
 *
 * If the Desktop happens to be backed up by OneDrive (Known Folder Move), the same folder
 * also ends up in the cloud at no extra cost. That is a bonus, not the mechanism:
 * `desktopIsSynced()` reports it, and nothing depends on it.
 *
 * Division of labour, which is the point of the request: **the human chooses the files** in
 * the extension's checkbox UI, so they know exactly what the chat can see. The bot never
 * decides what to expose.
 */
import { spawn } from 'node:child_process';
import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/**
 * Extensions the Copilot upload input accepts, restricted to what a code project produces.
 * Taken from the live `accept` attribute of `#upload-file-button`.
 *
 * Note what is absent: .ts, .ps1, .sh, .go, .rb, .yml are not all there, which is precisely
 * why Context Picker's `appendTxtExtension` exists. Exported files end in `.txt` and keep
 * their original extension visible in the name, e.g. `src--app.ts.txt`.
 * The flattening itself lives in `projectMirror.ts`; this module only consumes the folder.
 */
export const COPILOT_ACCEPTED = new Set([
  '.txt', '.md', '.json', '.csv', '.tsv', '.xml', '.log', '.ini', '.config',
  '.html', '.htm', '.css', '.js', '.jsx', '.py', '.java', '.cs', '.cpp', '.c', '.h',
  '.sql', '.php', '.pl', '.rs', '.lua', '.dart', '.yaml', '.sh', '.bash', '.tsx',
  '.pdf', '.docx', '.xlsx', '.pptx',
]);

export type ContextConfig = {
  /**
   * Folder Context Picker exports into. Should live inside the local OneDrive folder, so
   * the same files are both on disk for the bot and in the cloud for the human.
   */
  exportDir: string;
  /** Path to the extension's bundled bridge, `dist-cli/scan-selection.js`. */
  bridgePath?: string;
  /** Project root, needed when `pathInName` is used. */
  rootDir?: string;
  /** Absolute paths the user ticked. Only needed for bridge mode. */
  includedFiles?: string[];
  stripComments?: boolean;
  removeBlankLines?: boolean;
  /** Never true unless the user insists: it would upload secrets. */
  includeEnvFiles?: boolean;
  /** Guard rails for what may be attached in one go. */
  maxFiles?: number;
  maxTotalBytes?: number;
};

export const DEFAULT_MAX_FILES = 20;
export const DEFAULT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/**
 * The local OneDrive root.
 *
 * Windows sets `OneDrive` for the signed-in account, plus `OneDriveCommercial` for a work
 * or school account when both are present. Work first: that is the tenant the chat lives in.
 */
export function resolveOneDriveRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.OneDriveCommercial, env.OneDrive, env.OneDriveConsumer];
  for (const c of candidates) {
    if (c && c.trim()) return c;
  }
  const guess = join(homedir(), 'OneDrive');
  return guess;
}

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

/** Default export folder: one folder on the Desktop. */
export function defaultExportDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDesktopDir(env), 'copilot-operator-context');
}

/**
 * Whether the resolved Desktop is inside OneDrive, i.e. whether the export folder also
 * reaches the cloud for free. Informational only: nothing in the bot depends on it.
 */
export function desktopIsSynced(env: NodeJS.ProcessEnv = process.env): boolean {
  return isInsideOneDrive(resolveDesktopDir(env), env);
}

/**
 * Whether a folder sits inside a local OneDrive root, i.e. whether saving into it will
 * actually reach the cloud. This is the whole mechanism, so it is worth checking loudly:
 * an export folder outside OneDrive silently produces local-only copies, and the mistake
 * only shows up later as a chat that cannot see the project.
 */
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

export type ContextFile = {
  path: string;
  name: string;
  bytes: number;
  /** False when the chat's upload input would reject this extension. */
  accepted: boolean;
};

/** Lists what is currently in the export folder, newest-agnostic, sorted by name. */
export async function listContextFiles(exportDir: string): Promise<ContextFile[]> {
  let names: string[];
  try {
    names = await readdir(exportDir);
  } catch {
    return [];
  }
  const out: ContextFile[] = [];
  for (const name of names.sort()) {
    const path = join(exportDir, name);
    const s = await stat(path).catch(() => null);
    if (!s?.isFile()) continue;
    out.push({
      path,
      name,
      bytes: s.size,
      accepted: COPILOT_ACCEPTED.has(extname(name).toLowerCase()),
    });
  }
  return out;
}

export type SelectionCheck = {
  ok: boolean;
  files: ContextFile[];
  totalBytes: number;
  /** Blocking. The selection is not usable until these are resolved. */
  problems: string[];
  /** Worth telling the user, but not blocking. */
  notes: string[];
};

/**
 * Validates an export folder before anything is attached. Refusing early is much better
 * than a half-uploaded selection, because a partial context makes Copilot answer
 * confidently about files it never saw.
 */
export async function checkSelection(
  exportDir: string,
  cfg: Pick<ContextConfig, 'maxFiles' | 'maxTotalBytes'> = {},
): Promise<SelectionCheck> {
  const maxFiles = cfg.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = cfg.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const files = await listContextFiles(exportDir);
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  const problems: string[] = [];

  if (files.length === 0) {
    problems.push(`No files in ${exportDir}. Export a selection from Context Picker first.`);
  }
  if (files.length > maxFiles) {
    problems.push(`${files.length} files exceeds maxFiles=${maxFiles}.`);
  }
  if (totalBytes > maxTotalBytes) {
    problems.push(`${(totalBytes / 1048576).toFixed(1)} MB exceeds maxTotalBytes.`);
  }
  const rejected = files.filter((f) => !f.accepted);
  if (rejected.length > 0) {
    problems.push(
      `The chat upload rejects ${rejected.length} file(s): ${rejected.map((f) => f.name).join(', ')}. ` +
        `Re-export with Context Picker's "append .txt" option.`,
    );
  }
  const env = files.filter((f) => /(^|__|\.)env(\.|$)/i.test(f.name));
  if (env.length > 0) {
    problems.push(`Refusing to attach what look like env files: ${env.map((f) => f.name).join(', ')}.`);
  }
  const notes: string[] = [];
  if (!isInsideOneDrive(exportDir)) {
    // Not a problem: the Desktop is the target, and the bot reads it locally. It only means
    // the folder is not additionally backed up to the cloud.
    notes.push(
      `${exportDir} is not inside OneDrive, so these copies stay on this machine only. ` +
        `Turn on OneDrive's Desktop backup, or point exportDir under ` +
        `${resolveOneDriveRoot() ?? 'your OneDrive root'}, if you also want them in the cloud.`,
    );
  }

  return { ok: problems.length === 0, files, totalBytes, problems, notes };
}

/**
 * Content manifest of the export folder: file name -> sha256 of its bytes.
 *
 * The extension's `syncOnly` already avoids rewriting unchanged files on disk. The manifest
 * answers the next question, which is the bot's: what changed since the chat last saw this
 * folder. Without it the bot would re-attach the whole selection every iteration, which
 * wastes uploads, fills the user's chat with duplicates and makes Copilot re-read files that
 * did not move.
 *
 * Hashes, not timestamps: a re-export can rewrite a byte-identical file and bump its mtime.
 */
export type Manifest = {
  updatedAt: string;
  exportDir: string;
  files: Record<string, { sha256: string; bytes: number }>;
};

export const MANIFEST_NAME = '.cop-manifest.json';

async function sha256OfFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

export async function buildManifest(exportDir: string): Promise<Manifest> {
  const files: Manifest['files'] = {};
  for (const f of await listContextFiles(exportDir)) {
    if (f.name === MANIFEST_NAME) continue;
    files[f.name] = { sha256: await sha256OfFile(f.path), bytes: f.bytes };
  }
  return { updatedAt: new Date().toISOString(), exportDir: resolve(exportDir), files };
}

export async function readManifest(manifestPath: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

export async function writeManifest(manifestPath: string, manifest: Manifest): Promise<void> {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

export type ContextDiff = {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
  /** What the bot should attach: added plus changed. Empty means nothing to send. */
  toAttach: string[];
};

/** Compares the folder as it is now against the manifest from the previous run. */
export function diffAgainstManifest(current: Manifest, previous: Manifest | null): ContextDiff {
  const prev = previous?.files ?? {};
  const added: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const [name, info] of Object.entries(current.files)) {
    const before = prev[name];
    if (!before) added.push(name);
    else if (before.sha256 !== info.sha256) changed.push(name);
    else unchanged.push(name);
  }
  const removed = Object.keys(prev).filter((name) => !(name in current.files));

  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
    unchanged: unchanged.sort(),
    toAttach: [...added, ...changed].sort(),
  };
}

/** One line for the log and for the covering message to Copilot. */
export function describeDiff(diff: ContextDiff): string {
  if (diff.toAttach.length === 0 && diff.removed.length === 0) {
    return 'Project context unchanged since the last run.';
  }
  const bits: string[] = [];
  if (diff.added.length) bits.push(`${diff.added.length} new`);
  if (diff.changed.length) bits.push(`${diff.changed.length} changed`);
  if (diff.removed.length) bits.push(`${diff.removed.length} removed`);
  if (diff.unchanged.length) bits.push(`${diff.unchanged.length} unchanged`);
  return `Project context: ${bits.join(', ')}.`;
}

/** The JSON request shape of Context Picker's bridge CLI, copyfiles mode. */
export type CopyFilesRequest = {
  mode: 'copyfiles';
  rootDir: string;
  targetDir: string;
  includedFiles: string[];
  appendTxt: boolean;
  pathInName: boolean;
  separator?: string;
  syncOnly: boolean;
  stripComments?: boolean;
  removeBlankLines?: boolean;
  includeEnvFiles?: boolean;
};

/**
 * Bridge mode: re-export a saved selection by invoking Context Picker's own CLI, so a run
 * always starts from current file contents without the user re-ticking anything.
 *
 * Defaults are chosen for this use case and should not be changed lightly:
 *   appendTxt   true   the chat rejects source extensions
 *   pathInName  true   a flat folder otherwise loses which `index.ts` is which
 *   syncOnly    true   OneDrive should not re-upload files that did not change
 *   includeEnvFiles false  never ship secrets to a cloud chat
 */
export async function exportSelection(cfg: ContextConfig): Promise<{ written: number; raw: string }> {
  if (!cfg.bridgePath) throw new Error('contextPicker.bridgePath is not configured');
  if (!cfg.rootDir) throw new Error('contextPicker.rootDir is required when pathInName is used');

  const request: CopyFilesRequest = {
    mode: 'copyfiles',
    rootDir: resolve(cfg.rootDir),
    targetDir: resolve(cfg.exportDir),
    includedFiles: (cfg.includedFiles ?? []).map((f) => resolve(f)),
    appendTxt: true,
    pathInName: true,
    separator: '__',
    syncOnly: true,
    stripComments: cfg.stripComments ?? false,
    removeBlankLines: cfg.removeBlankLines ?? false,
    includeEnvFiles: cfg.includeEnvFiles ?? false,
  };

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cfg.bridgePath as string], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`context-picker bridge exited ${code}: ${err.trim()}`));
      const written = Number.parseInt(out.trim(), 10);
      resolvePromise({ written: Number.isFinite(written) ? written : 0, raw: out.trim() });
    });
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}
