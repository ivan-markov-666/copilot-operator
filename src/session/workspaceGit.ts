/**
 * The open project folder's git, as an IDE's Source Control view shows it (operator's request, 2026-10-19: "see
 * which files changed and how — the diff; let the Commits button show Git as VS Code does"):
 *
 * - the changes: what is staged (the index against HEAD) and what is not (the working tree against the index), the
 *   files git does not track yet among them, each with its letter and its lines added and removed;
 * - the history of the branch, newest first, and for a commit the files it changed;
 * - for any of those files, its two versions, for the side-by-side view.
 *
 * Read-only, every command of it: nothing here stages, commits, checks out or writes a file. A file's two versions
 * are given only for a file the list itself names, so the view cannot be pointed at anything else in the repository
 * or outside it.
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileAt, git, gitBytes, looksLikeRepo } from '../vcs/git.js';

/** git's empty tree: what a repository with no commit yet is compared with. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_FILE = 2 * 1024 * 1024;
const MAX_COMMITS = 200;

export type GitArea = 'staged' | 'changes' | 'commit' | 'branch';

export type GitFile = {
  path: string;
  /** The path before a rename or a copy. */
  oldPath?: string;
  /** M modified, A added, D deleted, R renamed, C copied, T type changed, U untracked, ! in conflict. */
  status: string;
  /** Lines added and removed; -1 for a binary file. */
  added: number;
  removed: number;
};

export type GitCommit = { sha: string; short: string; author: string; at: string; subject: string };

export type WorkspaceGit = {
  dir: string;
  isRepo: boolean;
  branch?: string;
  head?: string;
  /** The branch it follows, and how far apart they are, when it follows one. */
  upstream?: { name: string; ahead: number; behind: number };
  staged: GitFile[];
  changes: GitFile[];
  commits: GitCommit[];
  /** Whether there are older commits than the ones listed. */
  moreCommits: boolean;
};

export type GitFileVersions = { path: string; oldPath?: string; status: string; before: string | null; after: string | null; binary: boolean; tooLarge: boolean };

const SHA = /^[0-9a-f]{7,40}$/i;

async function hasHead(dir: string): Promise<boolean> {
  return (await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok;
}

/** `--name-status -z` read into files, renames and copies with both their paths. */
function nameStatus(out: string): GitFile[] {
  const tokens = out.split('\0');
  const files: GitFile[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i] ?? '';
    if (!status) break;
    const letter = status[0]!;
    if (letter === 'R' || letter === 'C') {
      files.push({ status: letter, oldPath: tokens[i + 1] ?? '', path: tokens[i + 2] ?? '', added: 0, removed: 0 });
      i += 3;
    } else {
      files.push({ status: letter, path: tokens[i + 1] ?? '', added: 0, removed: 0 });
      i += 2;
    }
  }
  return files;
}

/** `--numstat -z` counted into the files it names. */
function addCounts(files: GitFile[], out: string): void {
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; ) {
    const head = parts[i] ?? '';
    if (!head) break;
    const [added = '0', removed = '0', path = ''] = head.split('\t');
    // A rename is "added<TAB>removed<TAB>" followed by the old path and the new one.
    const newPath = path === '' ? (parts[i + 2] ?? '') : path;
    i += path === '' ? 3 : 1;
    const file = files.find((f) => f.path === newPath);
    if (file) {
      file.added = added === '-' ? -1 : Number(added) || 0;
      file.removed = removed === '-' ? -1 : Number(removed) || 0;
    }
  }
}

async function diffFiles(dir: string, args: string[]): Promise<GitFile[]> {
  const names = await gitBytes(dir, ['diff', '--name-status', '-M', '-z', ...args]);
  if (!names.ok) return [];
  const files = nameStatus(names.stdout.toString('utf8'));
  const counts = await gitBytes(dir, ['diff', '--numstat', '-M', '-z', ...args]);
  if (counts.ok) addCounts(files, counts.stdout.toString('utf8'));
  return files;
}

/** A file git does not track yet: all of it added, counted in lines when it is text. */
async function untracked(dir: string, path: string): Promise<GitFile> {
  const full = join(dir, path);
  const info = await stat(full).catch(() => null);
  let added = 0;
  if (info?.isFile() && info.size <= MAX_FILE) {
    const bytes = await readFile(full).catch(() => Buffer.alloc(0));
    if (bytes.subarray(0, 8000).includes(0)) added = -1;
    else {
      const text = bytes.toString('utf8');
      added = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    }
  }
  return { status: 'U', path, added, removed: added < 0 ? -1 : 0 };
}

/** The folder's git as the Source Control view shows it. */
export async function workspaceGit(dir: string): Promise<WorkspaceGit> {
  const none: WorkspaceGit = { dir, isRepo: false, staged: [], changes: [], commits: [], moreCommits: false };
  if (!dir || !looksLikeRepo(dir)) return none;
  const head = await hasHead(dir);
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout || undefined;
  const sha = head ? (await git(dir, ['rev-parse', 'HEAD'])).stdout : undefined;

  const staged = await diffFiles(dir, ['--cached', head ? 'HEAD' : EMPTY_TREE]);
  const unstaged = await diffFiles(dir, []);
  // In conflict: git's `U` in `--name-status`, said as the IDE says it.
  for (const f of [...staged, ...unstaged]) if (f.status === 'U') f.status = '!';
  const others = await gitBytes(dir, ['ls-files', '--others', '--exclude-standard', '-z']);
  const fresh = others.ok ? others.stdout.toString('utf8').split('\0').filter(Boolean).sort().slice(0, 2000) : [];
  const changes = [...unstaged, ...(await Promise.all(fresh.map((p) => untracked(dir, p))))];

  let upstream: WorkspaceGit['upstream'];
  const up = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (up.ok && up.stdout) {
    const counts = await git(dir, ['rev-list', '--left-right', '--count', `${up.stdout}...HEAD`]);
    const [behind = '0', ahead = '0'] = counts.stdout.split(/\s+/);
    upstream = { name: up.stdout, ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
  }

  const commits: GitCommit[] = [];
  if (head) {
    const log = await gitBytes(dir, ['log', `-n${MAX_COMMITS + 1}`, '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e']);
    if (log.ok) {
      for (const record of log.stdout.toString('utf8').split('\x1e')) {
        const [full = '', short = '', author = '', at = '', subject = ''] = record.trim().split('\x1f');
        if (full) commits.push({ sha: full, short, author, at, subject });
      }
    }
  }
  return {
    dir,
    isRepo: true,
    ...(branch ? { branch } : {}),
    ...(sha ? { head: sha } : {}),
    ...(upstream ? { upstream } : {}),
    staged,
    changes,
    commits: commits.slice(0, MAX_COMMITS),
    moreCommits: commits.length > MAX_COMMITS,
  };
}

/**
 * A file the branch changed, as a pull request lists it, and whether some of it is not committed yet: staged, not
 * staged, not tracked by git at all, or staged and changed again since ("mixed").
 */
export type BranchFile = GitFile & { committed: boolean; uncommitted?: 'staged' | 'changes' | 'untracked' | 'mixed' };

export type BranchChanges = {
  dir: string;
  isRepo: boolean;
  branch?: string;
  /** The branch compared with, and the ones it may be. */
  base?: string;
  bases: string[];
  /** Where the branch left the base: what a pull request is compared from. */
  mergeBase?: string;
  /** Commits of the branch the base has not, and of the base the branch has not. */
  ahead: number;
  behind: number;
  /** The branch's own commits, newest first (at most `MAX_BRANCH_COMMITS`). */
  commits: string[];
  files: BranchFile[];
  /** Whether there were more files than the ones listed. */
  moreFiles: boolean;
  /** Why there is nothing to compare: no other branch, no common history. */
  problem?: string;
};

const MAX_BRANCH_COMMITS = 500;
const MAX_BRANCH_FILES = 3000;

/** Every branch, local and remote, a branch can be compared with: not the one it is, not a remote's HEAD. */
async function branchRefs(dir: string, current: string): Promise<string[]> {
  const r = await git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']);
  if (!r.ok) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && x !== current && !/\/HEAD$/.test(x) && x !== 'HEAD');
}

/** The branch a pull request of this one would go into: the remote's default, else main, master or develop. */
async function defaultBase(dir: string, refs: string[]): Promise<string | undefined> {
  const head = await git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && refs.includes(head.stdout.trim())) return head.stdout.trim();
  return ['origin/main', 'origin/master', 'main', 'master', 'origin/develop', 'develop'].find((b) => refs.includes(b)) ?? refs[0];
}

/**
 * Everything the branch changed, as a pull request shows it (operator, 2026-10-22: "show all the files changed on this
 * branch, as a pull request does, not only the ones not committed; and of them, which are not committed yet"): each
 * file against where the branch left `base` — its commits and what is not committed yet together, the files git does
 * not track among them — marked with whether it is in a commit of the branch, and what of it is not committed. `base`
 * must be one of the branches there are; left out, the one a pull request would go into. Read-only.
 */
export async function branchChanges(dir: string, base?: string): Promise<BranchChanges> {
  const none: BranchChanges = { dir, isRepo: false, bases: [], ahead: 0, behind: 0, commits: [], files: [], moreFiles: false };
  if (!dir || !looksLikeRepo(dir)) return none;
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout || undefined;
  const out: BranchChanges = { ...none, isRepo: true, ...(branch ? { branch } : {}) };
  if (!(await hasHead(dir))) return { ...out, problem: 'no-commit' };
  const bases = await branchRefs(dir, branch ?? '');
  out.bases = bases;
  // Only a branch the list names: nothing else of the request reaches git.
  const chosen = base && bases.includes(base) ? base : await defaultBase(dir, bases);
  if (!chosen) return { ...out, problem: 'no-base' };
  out.base = chosen;
  const mb = await git(dir, ['merge-base', chosen, 'HEAD']);
  if (!mb.ok || !mb.stdout) return { ...out, problem: 'no-common' };
  const mergeBase = mb.stdout.trim();
  out.mergeBase = mergeBase;
  const counts = await git(dir, ['rev-list', '--left-right', '--count', `${chosen}...HEAD`]);
  const [behind = '0', ahead = '0'] = counts.stdout.split(/\s+/);
  out.ahead = Number(ahead) || 0;
  out.behind = Number(behind) || 0;
  const list = await git(dir, ['rev-list', `--max-count=${MAX_BRANCH_COMMITS}`, `${mergeBase}..HEAD`]);
  out.commits = list.ok ? list.stdout.split(/\s+/).filter(Boolean) : [];

  // The branch's commits; the whole of it against the working tree; and what is not committed, by where it is.
  const committed = await diffFiles(dir, [mergeBase, 'HEAD']);
  const net = await diffFiles(dir, [mergeBase]);
  const staged = new Set((await diffFiles(dir, ['--cached', 'HEAD'])).flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]));
  const unstaged = new Set((await diffFiles(dir, [])).flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]));
  const others = await gitBytes(dir, ['ls-files', '--others', '--exclude-standard', '-z']);
  const fresh = others.ok ? others.stdout.toString('utf8').split('\0').filter(Boolean) : [];
  const inCommits = new Set(committed.flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]));

  const files: GitFile[] = [...net, ...(await Promise.all(fresh.slice(0, MAX_BRANCH_FILES).map((p) => untracked(dir, p)))).map((f) => ({ ...f, status: 'A' }))];
  // Committed on the branch and undone since in the working tree: still the branch's, nothing of it left against the base.
  for (const c of committed) if (!files.some((f) => f.path === c.path)) files.push({ ...c, added: 0, removed: 0 });
  const untrackedSet = new Set(fresh);
  const marked: BranchFile[] = files.map((f) => {
    const keys = [f.path, ...(f.oldPath ? [f.oldPath] : [])];
    const isStaged = keys.some((k) => staged.has(k));
    const isUnstaged = keys.some((k) => unstaged.has(k));
    const uncommitted: BranchFile['uncommitted'] = untrackedSet.has(f.path) ? 'untracked' : isStaged && isUnstaged ? 'mixed' : isStaged ? 'staged' : isUnstaged ? 'changes' : undefined;
    return { ...f, committed: keys.some((k) => inCommits.has(k)), ...(uncommitted ? { uncommitted } : {}) };
  });
  marked.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  out.files = marked.slice(0, MAX_BRANCH_FILES);
  out.moreFiles = marked.length > MAX_BRANCH_FILES || fresh.length > MAX_BRANCH_FILES;
  return out;
}

/** One commit: who, when, what it says, and the files it changed (a first commit against nothing). */
export async function workspaceCommit(dir: string, sha: string): Promise<GitCommit & { body: string; files: GitFile[] }> {
  if (!SHA.test(sha)) throw new Error('That is not a commit.');
  if (!looksLikeRepo(dir)) throw new Error('The project folder is not a git repository.');
  const info = await gitBytes(dir, ['show', '-s', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b', sha]);
  if (!info.ok) throw new Error(`There is no commit ${sha} in the project folder.`);
  const [full = '', short = '', author = '', at = '', subject = '', body = ''] = info.stdout.toString('utf8').split('\x1f');
  const parent = await git(dir, ['rev-parse', '--verify', '--quiet', `${full}^`]);
  const files = await diffFiles(dir, [parent.ok ? `${full}^` : EMPTY_TREE, full]);
  return { sha: full, short, author, at, subject, body: body.trim(), files };
}

/** A path the view was given, as git writes it, or why it is not one. */
function cleanPath(dir: string, path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const rel = relative(resolve(dir), resolve(dir, clean));
  if (!clean || isAbsolute(clean) || rel.startsWith('..') || rel.split(sep).includes('.git')) throw new Error('That path is not inside the project folder.');
  return clean;
}

/**
 * The two versions of one file the view lists: for a staged change, HEAD and the index; for a change not staged, the
 * index and the working tree (a file git does not track: nothing, and the file on disk); for a commit's file, its
 * parent's version and the commit's.
 */
export async function workspaceGitVersions(dir: string, area: GitArea, path: string, commit?: string): Promise<GitFileVersions> {
  const want = cleanPath(dir, path);
  let file: GitFile | undefined;
  let before: { bytes: Buffer | null; tooLarge: boolean } = { bytes: null, tooLarge: false };
  let after: { bytes: Buffer | null; tooLarge: boolean } = { bytes: null, tooLarge: false };
  if (area === 'branch') {
    // As a pull request shows it: where the branch left the base, against the file as it is now, committed or not.
    const b = await branchChanges(dir, commit);
    if (!b.mergeBase) throw new Error('This branch has nothing to compare with.');
    file = b.files.find((f) => f.path === want);
    if (!file) throw new Error('That file is not one this branch changed.');
    if (file.status !== 'A') before = await fileAt(dir, b.mergeBase, file.oldPath ?? file.path, MAX_FILE);
    if (file.status !== 'D') {
      const info = await stat(join(dir, file.path)).catch(() => null);
      if (info?.isFile()) after = info.size > MAX_FILE ? { bytes: null, tooLarge: true } : { bytes: await readFile(join(dir, file.path)), tooLarge: false };
    }
  } else if (area === 'commit') {
    const c = await workspaceCommit(dir, commit ?? '');
    file = c.files.find((f) => f.path === want);
    if (!file) throw new Error('That file is not one this commit changed.');
    const parent = await git(dir, ['rev-parse', '--verify', '--quiet', `${c.sha}^`]);
    if (file.status !== 'A' && parent.ok) before = await fileAt(dir, `${c.sha}^`, file.oldPath ?? file.path, MAX_FILE);
    if (file.status !== 'D') after = await fileAt(dir, c.sha, file.path, MAX_FILE);
  } else {
    const state = await workspaceGit(dir);
    file = (area === 'staged' ? state.staged : state.changes).find((f) => f.path === want);
    if (!file) throw new Error(area === 'staged' ? 'That file has no staged change.' : 'That file has no change in the working tree.');
    if (area === 'staged') {
      if (file.status !== 'A' && state.head) before = await fileAt(dir, 'HEAD', file.oldPath ?? file.path, MAX_FILE);
      if (file.status !== 'D') after = await fileAt(dir, '', file.path, MAX_FILE);
    } else {
      // Against the index, which is HEAD's version where nothing is staged; a file git does not track has neither.
      if (file.status !== 'U') before = await fileAt(dir, '', file.oldPath ?? file.path, MAX_FILE);
      if (file.status !== 'D') {
        const info = await stat(join(dir, file.path)).catch(() => null);
        if (info?.isFile()) after = info.size > MAX_FILE ? { bytes: null, tooLarge: true } : { bytes: await readFile(join(dir, file.path)), tooLarge: false };
      }
    }
  }
  const binary = [before.bytes, after.bytes].some((b) => !!b && b.subarray(0, 8000).includes(0));
  const text = (b: Buffer | null): string | null => (b === null || binary ? null : b.toString('utf8').replace(/^﻿/, ''));
  return {
    path: file.path,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    status: file.status,
    before: text(before.bytes),
    after: text(after.bytes),
    binary,
    tooLarge: before.tooLarge || after.tooLarge,
  };
}
