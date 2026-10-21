/**
 * The workspace: the project folder the workbench has open (Settings → project folder), read as it is on disk —
 * the working tree, not a commit — for the explorer and the editor, the way an IDE shows the folder it opened
 * (operator's request, 2026-10-17: "like Windsurf"). One thing writes to it: the editor saving a file the operator
 * changed (2026-10-20, `saveWorkspaceFile`), and only a file that is already there, as it was when it was opened.
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { git, looksLikeRepo, repoState } from '../vcs/git.js';

export type WorkspaceInfo = { dir: string; name: string; ok: boolean; isRepo: boolean; branch?: string; problem?: string };

export async function workspaceInfo(dir: string, name = ''): Promise<WorkspaceInfo> {
  const d = dir.trim();
  if (!d) return { dir: '', name: '', ok: false, isRepo: false, problem: 'No project folder is open. Choose one with "Open a folder".' };
  if (!existsSync(d) || !statSync(d).isDirectory()) return { dir: d, name: name || basename(d), ok: false, isRepo: false, problem: `The folder ${d} does not exist.` };
  const isRepo = looksLikeRepo(d);
  const state = isRepo ? await repoState(d) : null;
  return { dir: d, name: name || basename(d), ok: true, isRepo, ...(state?.branch ? { branch: state.branch } : {}) };
}

/** Folders never worth listing: what a build or an install writes, and git's own. */
const SKIP = new Set(['.git', 'node_modules', '.next', '.next-export', 'dist', 'build', 'out', 'coverage', '.venv', 'venv', '__pycache__', 'bin', 'obj', '.vs', '.idea', '.copilot-operator']);
const MAX_FILES = 20_000;

/**
 * Every file of the folder, as repository-relative paths with forward slashes. In a repository, git's own list —
 * what it tracks and what it would add, ignored files left out — so the explorer shows the project and not what
 * a build left; elsewhere a walk that skips the usual build folders.
 */
export async function workspaceFiles(dir: string): Promise<{ files: string[]; truncated: boolean }> {
  if (looksLikeRepo(dir)) {
    const r = await git(dir, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], 60_000);
    if (r.ok) {
      const all = [...new Set(r.stdout.split('\0').filter(Boolean))].filter((p) => existsSync(join(dir, p)));
      return { files: all.slice(0, MAX_FILES).sort(), truncated: all.length > MAX_FILES };
    }
  }
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    if (files.length >= MAX_FILES) return;
    const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(p);
      } else if (e.isFile()) files.push(p);
      if (files.length >= MAX_FILES) return;
    }
  };
  await walk('');
  return { files: files.sort(), truncated: files.length >= MAX_FILES };
}

/** The largest file the editor reads and writes. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

/** A path of the folder, cleaned, and where it is on disk; anything outside it, or in git's own folder, is refused. */
function insideFolder(dir: string, path: string): { clean: string; full: string } {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const full = resolve(dir, clean);
  const rel = relative(resolve(dir), full);
  if (!clean || isAbsolute(clean) || rel.startsWith('..') || rel.split(sep).includes('.git')) throw new Error('That path is not inside the project folder.');
  return { clean, full };
}

/** A file's bytes as a short fingerprint: which version of it an edit was made on (see `saveWorkspaceFile`). */
function versionOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 20);
}

/** One file of the folder as it is on disk, as text; a binary or very large one is said to be one. */
export async function workspaceFile(dir: string, path: string, maxBytes = MAX_EDIT_BYTES): Promise<{ path: string; text: string | null; binary: boolean; tooLarge: boolean; size: number; version?: string }> {
  const { clean, full } = insideFolder(dir, path);
  const st = await stat(full).catch(() => null);
  if (!st?.isFile()) throw new Error(`There is no file ${clean} in the project folder.`);
  if (st.size > maxBytes) return { path: clean, text: null, binary: false, tooLarge: true, size: st.size };
  const bytes = await readFile(full);
  const binary = bytes.subarray(0, 8000).includes(0);
  return { path: clean, text: binary ? null : bytes.toString('utf8').replace(/^\ufeff/, ''), binary, tooLarge: false, size: st.size, version: versionOf(bytes) };
}

/** The pictures a Markdown preview may show from the folder, by extension, with the type they are served as. */
const PICTURES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif',
};
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;

/**
 * A picture of the folder as its bytes (2026-10-21), for an image a Markdown preview shows: only pictures, only inside
 * the folder, at most 10 MB. Anything else is refused, so this is not a way to read the folder's files whole.
 */
export async function workspaceRaw(dir: string, path: string): Promise<{ bytes: Buffer; type: string }> {
  const { clean, full } = insideFolder(dir, path);
  const ext = clean.split('.').pop()?.toLowerCase() ?? '';
  const type = PICTURES[ext];
  if (!type) throw new Error(`${clean} is not a picture this view shows.`);
  const st = await stat(full).catch(() => null);
  if (!st?.isFile()) throw new Error(`There is no file ${clean} in the project folder.`);
  if (st.size > MAX_PICTURE_BYTES) throw new Error(`${clean} is larger than a preview shows.`);
  return { bytes: await readFile(full), type };
}

/** Said when the file changed on disk after the editor read it; the page offers to read it again or to save anyway. */
export const CHANGED_ON_DISK = 'changed-on-disk';

/**
 * Saves the editor's text over a file of the folder (2026-10-20: "clicking a file, it can be edited"). Only a file that
 * is there already and is text; and only over the version the edit was made on (`base`), so a change the chat made to
 * it meanwhile is not overwritten without the operator knowing — without `base` it is saved whatever is there. The
 * file keeps its own line endings and its byte-order mark: the editor works in LF, and a CRLF file stays CRLF.
 */
export async function saveWorkspaceFile(dir: string, path: string, text: string, base?: string): Promise<{ path: string; version: string; size: number }> {
  const { clean, full } = insideFolder(dir, path);
  const st = await stat(full).catch(() => null);
  if (!st?.isFile()) throw new Error(`There is no file ${clean} in the project folder.`);
  if (st.size > MAX_EDIT_BYTES) throw new Error(`${clean} is too large to edit here.`);
  const before = await readFile(full);
  if (before.subarray(0, 8000).includes(0)) throw new Error(`${clean} is not a text file.`);
  if (base && versionOf(before) !== base) {
    throw Object.assign(new Error(`${clean} changed on disk after it was opened. Read it again to see the change, or save over it.`), { code: CHANGED_ON_DISK });
  }
  const old = before.toString('utf8');
  const bom = old.startsWith('\ufeff') ? '\ufeff' : '';
  const crlf = (old.match(/\r\n/g)?.length ?? 0) > (old.match(/(?<!\r)\n/g)?.length ?? 0);
  const lf = text.replace(/\r\n/g, '\n');
  const bytes = Buffer.from(bom + (crlf ? lf.replace(/\n/g, '\r\n') : lf), 'utf8');
  if (bytes.length > MAX_EDIT_BYTES) throw new Error(`The text is too large to save (${bytes.length} bytes).`);
  // Written beside it and moved over it, so a file is never left half written.
  const temp = `${full}.cop-save-${process.pid}`;
  await writeFile(temp, bytes);
  await rename(temp, full);
  return { path: clean, version: versionOf(bytes), size: bytes.length };
}
