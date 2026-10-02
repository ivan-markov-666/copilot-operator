/**
 * The operator's input files: in every session's starting commit, and not the bot's to change.
 *
 * Found in a real run: YAML schemas the work was built from were put into the project by hand and
 * left untracked. Branches did not carry them predictably, a task could not tell "input from the
 * operator" from "change made by the bot", and a session started from `main` began without them
 * although they were in other commits. `vcs.userInputs` names them, and three things follow:
 *
 *   - Before a session's first task they are in the commit it starts from. New, changed or ignored
 *     ones go into the starting snapshot (`snapshot.ts`), with the operator's approval. A session
 *     whose start lacks them — `startFrom: "branch"` after a session that captured them — has them
 *     committed on top of that start, "Capture user-provided inputs" on `<prefix>input/<session id>`,
 *     from where they were last committed: the repository's HEAD, else the latest session in the same
 *     repository that recorded them. Every session of a run sees the same inputs.
 *   - Their SHA-256 sums are recorded on the session's start, for the record and the exports.
 *   - Read-only, unless switched off: after every round of steps a changed, removed or added input
 *     file is put back from the task's starting commit and the chat is told; a task that ends with
 *     one that could not be put back fails.
 *
 * The commit on top of a start is made without touching the working tree or the index (a temporary
 * index, `commit-tree`), so the operator's checkout is never disturbed to make it.
 */
import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import type { InputFile, Session, SessionStart, UserInputs, VersionControl } from '../session/model.js';
import { looksGenerated } from './commitHygiene.js';
import { branchNameFrom, freeBranchName, git, gitBytes, isValidBranchName, RUNNER_EMAIL } from './git.js';
import { inScope } from './scope.js';

/** The session's input settings with defaults filled in, or null when it names no inputs. */
export function inputSettings(vcs: VersionControl | undefined): (Required<UserInputs> & { patterns: string[] }) | null {
  const patterns = normalisePatterns(vcs?.userInputs?.paths ?? []);
  if (patterns.length === 0) return null;
  return { paths: patterns, patterns, readOnly: vcs?.userInputs?.readOnly !== false, requireApproval: vcs?.userInputs?.requireApproval !== false };
}

/**
 * Patterns as the matching expects them, without the ones that name everything: an input is a file
 * the operator can point at, and "the whole repository" would make every change the bot makes a
 * change to an input.
 */
export function normalisePatterns(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of paths) {
    const p = raw.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!p || p === '.' || /^[*/]+$/.test(p)) continue;
    out.add(p);
  }
  return [...out];
}

/** Whether a pattern names everything, which an input pattern may not. */
export function namesEverything(pattern: string): boolean {
  const p = pattern.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');
  return !p || p === '.' || /^[*/]+$/.test(p);
}

/** The folder part of a pattern before its first wildcard, for narrowing what git lists. */
function literalPrefix(pattern: string): string {
  const parts = pattern.replace(/\/+$/, '').split('/');
  const fixed: string[] = [];
  for (const part of parts) {
    if (/[*?[]/.test(part)) break;
    fixed.push(part);
  }
  return fixed.join('/');
}

function pathspecs(patterns: string[]): string[] {
  const prefixes = [...new Set(patterns.map(literalPrefix))];
  return prefixes.includes('') ? [] : prefixes.map((p) => `:(icase)${p}`);
}

const list = async (top: string, args: string[]): Promise<string[]> => {
  const r = await gitBytes(top, args, 60_000, 64 * 1024 * 1024);
  return r.ok ? r.stdout.toString('utf8').split('\0').filter(Boolean) : [];
};

/** The input files in the working tree, each with what git thinks of it. */
export async function inputFilesInTree(top: string, patterns: string[]): Promise<Array<{ path: string; kind: 'tracked' | 'untracked' | 'ignored' }>> {
  const specs = pathspecs(patterns);
  const tail = specs.length > 0 ? ['--', ...specs] : [];
  const seen = new Map<string, 'tracked' | 'untracked' | 'ignored'>();
  for (const path of await list(top, ['ls-files', '-z', '--cached', ...tail])) seen.set(path, 'tracked');
  for (const path of await list(top, ['ls-files', '-z', '--others', '--exclude-standard', ...tail])) if (!seen.has(path)) seen.set(path, 'untracked');
  for (const path of await list(top, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', ...tail])) {
    // Installed or built folders are never inputs, however wide the pattern.
    if (!seen.has(path) && !looksGenerated(path)?.key.endsWith('/')) seen.set(path, 'ignored');
  }
  const out: Array<{ path: string; kind: 'tracked' | 'untracked' | 'ignored' }> = [];
  for (const [path, kind] of seen) {
    if (!inScope(path, patterns)) continue;
    // A tracked file deleted from the tree is still listed by --cached; it is not there to read.
    if (kind === 'tracked' && !(await stat(join(top, path)).catch(() => null))?.isFile()) continue;
    out.push({ path, kind });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The input files in one commit: path, mode and blob. */
async function inputsAt(top: string, commit: string, patterns: string[]): Promise<Array<{ path: string; mode: string; blob: string }>> {
  const specs = pathspecs(patterns);
  const out: Array<{ path: string; mode: string; blob: string }> = [];
  for (const rec of await list(top, ['ls-tree', '-r', '-z', '--full-tree', commit, ...(specs.length > 0 ? ['--', ...specs.map((s) => s.replace(':(icase)', ''))] : [])])) {
    const tab = rec.indexOf('\t');
    const [mode = '', type = '', blob = ''] = rec.slice(0, tab).split(' ');
    const path = rec.slice(tab + 1);
    if (type === 'blob' && inScope(path, patterns)) out.push({ path, mode, blob });
  }
  // `ls-tree` pathspecs are case-sensitive; a pattern written in another case is matched in full.
  if (out.length === 0 && specs.length > 0) {
    for (const rec of await list(top, ['ls-tree', '-r', '-z', '--full-tree', commit])) {
      const tab = rec.indexOf('\t');
      const [mode = '', type = '', blob = ''] = rec.slice(0, tab).split(' ');
      const path = rec.slice(tab + 1);
      if (type === 'blob' && inScope(path, patterns)) out.push({ path, mode, blob });
    }
  }
  return out;
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The sums of the input files as one commit has them. */
export async function inputSumsAt(top: string, commit: string, patterns: string[]): Promise<InputFile[]> {
  const out: InputFile[] = [];
  for (const f of await inputsAt(top, commit, patterns)) {
    const r = await gitBytes(top, ['cat-file', 'blob', f.blob], 120_000, 512 * 1024 * 1024);
    if (r.ok) out.push({ path: f.path, sha256: sha(r.stdout), size: r.stdout.length, blob: f.blob });
  }
  return out;
}

/**
 * The blob id the working-tree file would be committed as, or null when it is not there.
 *
 * Compared by git's own hashing, with its line-ending conversion, rather than by the bytes: with
 * `core.autocrlf` — usual on Windows — a checked-out file has CRLF where the commit has LF, and a
 * byte comparison called every untouched input changed, every round.
 */
export async function blobOfFile(top: string, path: string): Promise<string | null> {
  if (!(await stat(join(top, path)).catch(() => null))?.isFile()) return null;
  const r = await git(top, ['hash-object', `--path=${path}`, '--', join(top, path)]);
  return r.ok && r.stdout ? r.stdout : null;
}

const norm = (dir: string): string => dir.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();

/**
 * Makes `parent` plus the given files one commit, on a new branch, without touching the working
 * tree or the index: a temporary index is read from `parent`, the files are set in it, and the
 * tree is committed with `commit-tree`.
 */
async function commitOnto(top: string, parent: string, files: Array<{ path: string; mode: string; blob: string }>, message: string, branch: string): Promise<{ commit: string } | { problem: string }> {
  const index = join(tmpdir(), `cop-inputs-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    const read = await git(top, ['read-tree', parent], 60_000, env);
    if (!read.ok) return { problem: read.stderr || 'git read-tree failed' };
    for (const f of files) {
      const set = await git(top, ['update-index', '--add', '--cacheinfo', `${f.mode},${f.blob},${f.path}`], 60_000, env);
      if (!set.ok) return { problem: `${f.path}: ${set.stderr || 'git update-index failed'}` };
    }
    const tree = await git(top, ['write-tree'], 60_000, env);
    if (!tree.ok || !tree.stdout) return { problem: tree.stderr || 'git write-tree failed' };
    const commit = await git(top, ['-c', 'user.name=copilot-operator', '-c', `user.email=${RUNNER_EMAIL}`, 'commit-tree', tree.stdout, '-p', parent, '-m', message]);
    if (!commit.ok || !commit.stdout) return { problem: commit.stderr || 'git commit-tree failed' };
    const made = await git(top, ['branch', branch, commit.stdout]);
    if (!made.ok) return { problem: made.stderr || `the branch ${branch} could not be made` };
    return { commit: commit.stdout };
  } finally {
    await rm(index, { force: true });
  }
}

/**
 * Makes sure the commit a session starts from has the operator's input files, and records their
 * sums on the start. Returns the start to use — the same one, or one whose commit has the inputs
 * committed on top — or why the session cannot start.
 *
 * Called once the start is known and the working tree holds nothing uncommitted of the inputs (new
 * or changed ones went into the snapshot before this). Where the inputs are taken from: the
 * repository's HEAD for every pattern it has files for, else the latest session in this same
 * repository whose start recorded files for that pattern.
 */
export async function settleInputs(
  session: Session,
  dir: string,
  start: SessionStart,
  allSessions: () => Promise<Session[]>,
): Promise<{ start: SessionStart } | { problem: string }> {
  const settings = inputSettings(session.vcs);
  if (!settings) return { start };
  const topR = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!topR.ok || !topR.stdout) return { problem: `${dir} is not a git repository.` };
  const top = resolve(topR.stdout);
  const head = (await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD'])).stdout;

  // Where each pattern's files are: HEAD first, then the latest earlier capture in this repository.
  const wanted: Array<{ path: string; mode: string; blob: string }> = [];
  const sources = new Set<string>();
  const missing: string[] = [];
  const atHead = head ? await inputsAt(top, head, settings.patterns) : [];
  const earlier = (await allSessions())
    .filter((s) => s.id !== session.id && s.vcsStart?.inputs && norm(s.vcs?.repoDir || s.projectDir || '') === norm(dir))
    // The newest first: a later capture is the operator's later word on the inputs.
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .map((s) => s.vcsStart as SessionStart);
  for (const pattern of settings.patterns) {
    let found = atHead.filter((f) => inScope(f.path, [pattern]));
    let from = head;
    // The start itself next: a snapshot approved on the page has them, wherever HEAD has moved since.
    if (found.length === 0) {
      found = (await inputsAt(top, start.commit, [pattern])).filter((f) => inScope(f.path, [pattern]));
      from = start.commit;
    }
    for (const s of earlier) {
      if (found.length > 0) break;
      found = (await inputsAt(top, s.commit, [pattern])).filter((f) => inScope(f.path, [pattern]));
      from = s.commit;
    }
    if (found.length === 0) missing.push(pattern);
    else sources.add(from);
    for (const f of found) if (!wanted.some((w) => w.path === f.path)) wanted.push(f);
  }
  if (missing.length > 0) {
    return {
      problem:
        `the input file pattern(s) ${missing.map((m) => `"${m}"`).join(', ')} match no file: not in the working tree, not in the repository's HEAD, ` +
        'and no earlier session in this repository captured them. Put the files in the project (they will be listed for your approval), or correct "Input files".',
    };
  }

  // What the start has already, file by file; only what differs is committed on top.
  const inStart = new Map((await inputsAt(top, start.commit, settings.patterns)).map((f) => [f.path, f]));
  const differ = wanted.filter((w) => inStart.get(w.path)?.blob !== w.blob);
  let commit = start.commit;
  let carried: { onto: string; from: string; branch: string } | undefined;
  if (differ.length > 0) {
    const branch = await freeBranchName(top, `${branchNameFrom(['input'], session.vcs?.branchPrefix || 'cop/')}/${session.id}`);
    if (!(await isValidBranchName(top, branch))) return { problem: `"${branch}" is not a name git accepts.` };
    const from = [...sources].map((s) => s.slice(0, 8)).join(', ');
    const message = [
      'Capture user-provided inputs',
      '',
      `The operator's input files for session "${session.name}", which the commit it starts from (${start.commit.slice(0, 8)}) did not have,`,
      `taken from ${from}, where they were last committed. They are inputs: the work reads them and does not change them.`,
      '',
      ...differ.slice(0, 200).map((f) => `- ${f.path}`),
      '',
      'Committed by copilot-operator. Not pushed.',
      '',
    ].join('\n');
    const made = await commitOnto(top, start.commit, differ, message, branch);
    if ('problem' in made) return { problem: `the input files could not be committed on top of the session's start: ${made.problem}` };
    commit = made.commit;
    carried = { onto: start.commit, from, branch };
  }
  const files = await inputSumsAt(top, commit, settings.patterns);
  return { start: { ...start, commit, inputs: { patterns: settings.patterns, files, readOnly: settings.readOnly, ...(carried ? { carried } : {}) } } };
}

/** What one check of the input files found and did. */
export type InputsCheck = { changed: string[]; restored: string[]; failed: Array<{ path: string; why: string }> };

/**
 * Puts the input files back as the task's starting commit has them: a changed or removed one from
 * that commit, a new one matching an input pattern removed. Only on the task's own branch, whose
 * starting commit has the inputs (see `settleInputs`).
 */
export async function protectInputs(dir: string, base: string, inputs: NonNullable<SessionStart['inputs']>): Promise<InputsCheck> {
  const out: InputsCheck = { changed: [], restored: [], failed: [] };
  const topR = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!topR.ok || !topR.stdout) return out;
  const top = resolve(topR.stdout);
  const known = new Map(inputs.files.map((f) => [f.path, f.blob]));
  for (const f of inputs.files) {
    if ((await blobOfFile(top, f.path)) === f.blob) continue;
    out.changed.push(f.path);
    const back = await git(top, ['checkout', base, '--', f.path]);
    if (back.ok && (await blobOfFile(top, f.path)) === f.blob) out.restored.push(f.path);
    else out.failed.push({ path: f.path, why: back.stderr || 'it is not as the starting commit has it' });
  }
  // A file the task added under an input pattern: inputs are the operator's, so it goes.
  for (const { path, kind } of await inputFilesInTree(top, inputs.patterns)) {
    if (known.has(path) || kind === 'tracked') continue;
    out.changed.push(path);
    const abs = resolve(join(top, path));
    if (!abs.startsWith(resolve(top) + sep)) {
      out.failed.push({ path, why: 'not inside the repository' });
      continue;
    }
    try {
      await rm(abs, { force: true });
      out.restored.push(path);
    } catch (e) {
      out.failed.push({ path, why: (e as Error).message });
    }
  }
  return out;
}

/** What the chat is told when input files were put back. */
export function inputsMessage(check: InputsCheck): string {
  const names = (paths: string[]): string => paths.slice(0, 15).join(', ') + (paths.length > 15 ? `, and ${paths.length - 15} more` : '');
  return [
    `The operator's input files are read-only, so the runner put back: ${names(check.restored)}.`,
    check.failed.length > 0 ? `Could not be put back: ${check.failed.map((f) => `${f.path} (${f.why})`).join('; ')}.` : '',
    'Read them as they are; do not change, move, delete or add to them. If the work truly needs a different input, end with status "blocked" and say which and why.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** The lines the version-control note carries about the inputs. */
export function inputsNote(inputs: SessionStart['inputs']): string {
  if (!inputs || inputs.files.length === 0) return '';
  const shown = inputs.files.slice(0, 20).map((f) => `\`${f.path}\``).join(', ');
  return (
    `The operator's input files are in your working tree, committed in the starting commit: ${shown}` +
    `${inputs.files.length > 20 ? `, and ${inputs.files.length - 20} more` : ''}. ` +
    (inputs.readOnly
      ? 'They are read-only: read them, never change, move or delete them, and add nothing under their paths. The runner puts them back after every round of steps.'
      : 'They are the work\'s input; change them only if the task says so.')
  );
}
