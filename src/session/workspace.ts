/**
 * The workspace: the project folder the workbench has open (Settings → project folder), read as it is on disk —
 * the working tree, not a commit — for the explorer and the editor, the way an IDE shows the folder it opened
 * (operator's request, 2026-10-17: "like Windsurf"). Read-only: nothing here writes to the folder.
 */
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
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

/** One file of the folder as it is on disk, as text; a binary or very large one is said to be one. */
export async function workspaceFile(dir: string, path: string, maxBytes = 2 * 1024 * 1024): Promise<{ path: string; text: string | null; binary: boolean; tooLarge: boolean; size: number }> {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const full = resolve(dir, clean);
  const rel = relative(resolve(dir), full);
  if (!clean || isAbsolute(clean) || rel.startsWith('..') || rel.split(sep).includes('.git')) throw new Error('That path is not inside the project folder.');
  const st = await stat(full).catch(() => null);
  if (!st?.isFile()) throw new Error(`There is no file ${clean} in the project folder.`);
  if (st.size > maxBytes) return { path: clean, text: null, binary: false, tooLarge: true, size: st.size };
  const bytes = await readFile(full);
  const binary = bytes.subarray(0, 8000).includes(0);
  return { path: clean, text: binary ? null : bytes.toString('utf8').replace(/^﻿/, ''), binary, tooLarge: false, size: st.size };
}
