/**
 * Mirrors selected parts of a project into one flat folder on the Desktop.
 *
 * Why flat, and why renamed. The folder is meant to sit inside a OneDrive-backed Desktop so
 * the copies reach the cloud with no user action, and the chat's upload input rejects source
 * extensions outright. So the directory structure cannot be kept as folders and the
 * extensions cannot be kept as-is. Both problems are solved by encoding the path into the
 * file name and giving everything a `.txt` tail:
 *
 *   src/test/example-test.spec.ts   ->   src--test--example-test.spec.ts.txt
 *
 * The convention is taken from the user's own Context Picker
 * (https://github.com/ivan-markov-666/context-picker, MIT), specifically
 * `copySelectionToDir` in `src/scan-core.ts`, so that a folder produced here and a folder
 * produced by the extension are interchangeable:
 *
 *   - relative path, forward slashes, joined with the separator
 *   - name collisions get `<sep><n>` appended, starting at 2, compared case-insensitively
 *   - `.txt` appended last, after the collision suffix
 *   - sync mode writes only files whose bytes differ and deletes what is no longer selected
 *
 * The difference from the extension is the input. There the user ticks individual files in
 * an editor UI. Here the user names the project root and the directories to include, and
 * selecting a directory takes everything beneath it.
 */
import { readFile, writeFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { join, relative, resolve, sep as osSep, basename, extname } from 'node:path';
import ignore, { type Ignore } from 'ignore';

/**
 * Directories that are never useful as chat context, pruned at any depth even when there is
 * no `.gitignore`. Same list as Context Picker's `DEFAULT_IGNORE`, plus the obvious
 * JavaScript and Python build output.
 */
export const DEFAULT_IGNORE_DIRS = [
  'node_modules',
  '.git',
  'bin',
  'obj',
  '.vs',
  '.idea',
  'dist',
  'build',
  'out',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
];

export const DEFAULT_SEPARATOR = '--';
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export type TxtMode =
  /** `app.ts` -> `app.ts.txt`. Keeps the real extension visible. Matches Context Picker. */
  | 'append'
  /** `app.ts` -> `app.txt`. Shorter, but loses the original extension. */
  | 'replace'
  /** Leave the name alone. The chat upload will reject most source files. */
  | 'none';

export type MirrorConfig = {
  /** The project root the user points at. */
  rootDir: string;
  /**
   * Directories to include, relative to `rootDir`. Selecting a directory includes every
   * file beneath it, at any depth. `['.']` means the whole project. An empty list means
   * nothing is copied, which is treated as a configuration error rather than a no-op.
   */
  includeDirs: string[];
  /** Directories to carve back out, relative to `rootDir`. Applied after `includeDirs`. */
  excludeDirs?: string[];
  /** The flat folder on the Desktop that only this program owns. */
  targetDir: string;
  /**
   * Put in front of every flattened name, as if the project sat in a folder of that name:
   * `rules-api--src--main.ts.txt`. With several projects mirrored, the chat sees only file
   * names, and `src--main.ts.txt` from two repositories is one file to it.
   */
  namePrefix?: string;
  /** Path separator replacement in the flattened name. */
  separator?: string;
  txtMode?: TxtMode;
  respectGitignore?: boolean;
  /** Extra directory names pruned at any depth, on top of `DEFAULT_IGNORE_DIRS`. */
  ignoreDirs?: string[];
  /** `.env` files are skipped unless this is explicitly true. */
  includeEnvFiles?: boolean;
  /** Files above this size are skipped and reported. */
  maxFileBytes?: number;
};

export type SkippedFile = { relPath: string; reason: string };

/**
 * A directory that was asked to be both included and excluded.
 *
 * `same` is the plain case: the identical path in both lists, which has no sensible reading.
 * `excluded-parent` is the same mistake one level up: excluding `src` while including
 * `src/app` would leave nothing to copy. Excluding a directory *below* an included one is
 * not a conflict at all; that is the normal way to carve out `src/generated`.
 */
export type SelectionConflict = { include: string; exclude: string; kind: 'same' | 'excluded-parent' };

/** `.\Src\Foo\` and `src/foo` are the same directory. This is the form both lists compare in. */
export function normalizeDirPath(dir: string): string {
  const cleaned = dir
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  return cleaned === '' ? '.' : cleaned;
}

function isUnder(child: string, parent: string): boolean {
  if (parent === '.') return child !== '.';
  return child.toLowerCase().startsWith(`${parent.toLowerCase()}/`);
}

/** Every contradiction between the two lists, so a UI can refuse to save and say why. */
export function findSelectionConflicts(includeDirs: string[], excludeDirs: string[]): SelectionConflict[] {
  const includes = includeDirs.map(normalizeDirPath).filter(Boolean);
  const excludes = excludeDirs.map(normalizeDirPath).filter(Boolean);
  const out: SelectionConflict[] = [];

  for (const inc of includes) {
    for (const exc of excludes) {
      if (inc.toLowerCase() === exc.toLowerCase()) {
        out.push({ include: inc, exclude: exc, kind: 'same' });
      } else if (isUnder(inc, exc)) {
        out.push({ include: inc, exclude: exc, kind: 'excluded-parent' });
      }
    }
  }
  return out;
}

/** One sentence per conflict, for a message box or a thrown error. */
export function describeConflicts(conflicts: SelectionConflict[]): string {
  return conflicts
    .map((c) =>
      c.kind === 'same'
        ? `"${c.include}" is in both the include and the exclude list.`
        : `"${c.exclude}" is excluded but "${c.include}" is included, and lies under it.`,
    )
    .join(' ');
}

export type MirrorResult = {
  /** Target file names, relative to `targetDir`. */
  added: string[];
  updated: string[];
  deleted: string[];
  unchanged: string[];
  skipped: SkippedFile[];
  /** Source path -> target name, for every file that is currently mirrored. */
  mapping: Record<string, string>;
  totalBytes: number;
};

/** Files the program owns in the target folder and must never delete as "stale". */
const RESERVED_TARGET_NAMES = new Set(['.cop-manifest.json']);

function isEnvFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === '.env' || name.startsWith('.env.');
}

/**
 * Flattens a relative path into a single file name.
 *
 * `used` carries the names already taken, lower-cased, and is mutated. Collisions are
 * possible because two different paths can flatten to the same string once separators are
 * substituted, so the suffix is not optional.
 */
export function flattenName(
  relPath: string,
  used: Set<string>,
  separator = DEFAULT_SEPARATOR,
  txtMode: TxtMode = 'append',
): string {
  const normalized = relPath.split(/[\\/]/).join(separator);

  let candidate = normalized;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${normalized}${separator}${i}`;
    i += 1;
  }
  used.add(candidate.toLowerCase());

  switch (txtMode) {
    case 'append':
      return `${candidate}.txt`;
    case 'replace': {
      const ext = extname(candidate);
      return ext ? `${candidate.slice(0, -ext.length)}.txt` : `${candidate}.txt`;
    }
    case 'none':
      return candidate;
  }
}

async function loadGitignore(rootDir: string, respect: boolean): Promise<Ignore | null> {
  if (!respect) return null;
  try {
    const content = await readFile(join(rootDir, '.gitignore'), 'utf8');
    return ignore().add(content);
  } catch {
    return null;
  }
}

/**
 * Depth-first walk of one directory, returning file paths relative to `rootDir`.
 *
 * Two rules about `.env` files are enforced here, and nowhere else:
 *
 *   - `.gitignore` never decides an env file. Almost every project ignores `.env`, so letting
 *     the gitignore option hide them would make the env option meaningless. Env files are
 *     always handed to `collectFiles`, which keeps or drops them by the env option alone.
 *   - When env files are wanted, a directory that only `.gitignore` hides is still descended
 *     into, but nothing except env files is taken from it. That is how an env file inside an
 *     ignored folder still reaches the selection without dragging the folder along with it.
 *
 * `DEFAULT_IGNORE_DIRS` and the user's own exclusions are absolute: they are never descended
 * into, env files or not.
 */
async function walk(
  rootDir: string,
  dirRel: string,
  ig: Ignore | null,
  ignoreDirs: Set<string>,
  excluded: Set<string>,
  out: string[],
  opts: { includeEnvFiles: boolean; inGitignored?: boolean },
): Promise<void> {
  const abs = join(rootDir, dirRel);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const childRel = dirRel === '.' ? entry.name : `${dirRel}/${entry.name}`;
    const posixRel = childRel.split(osSep).join('/');

    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name.toLowerCase())) continue;
      if (excluded.has(posixRel.toLowerCase())) continue;
      const gitignored = opts.inGitignored === true || (ig?.ignores(`${posixRel}/`) ?? false);
      if (gitignored && !opts.includeEnvFiles) continue;
      await walk(rootDir, childRel, ig, ignoreDirs, excluded, out, { ...opts, inGitignored: gitignored });
    } else if (entry.isFile()) {
      if (isEnvFile(entry.name)) {
        out.push(posixRel);
        continue;
      }
      if (opts.inGitignored) continue;
      if (ig?.ignores(posixRel)) continue;
      out.push(posixRel);
    }
  }
}

/**
 * Lists the directories under `rootDir` that are worth offering for selection, so a CLI or
 * a UI can present the same kind of choice the extension's checkbox tree does. Pruned by the
 * same rules as the mirror itself, so what is listed is what can actually be copied.
 */
export async function listSelectableDirs(
  rootDir: string,
  opts: { respectGitignore?: boolean; ignoreDirs?: string[]; maxDepth?: number } = {},
): Promise<string[]> {
  const ig = await loadGitignore(resolve(rootDir), opts.respectGitignore ?? true);
  const ignoreDirs = new Set(
    [...DEFAULT_IGNORE_DIRS, ...(opts.ignoreDirs ?? [])].map((d) => d.toLowerCase()),
  );
  const maxDepth = opts.maxDepth ?? 4;
  const found: string[] = [];

  const recurse = async (dirRel: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(join(resolve(rootDir), dirRel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (ignoreDirs.has(entry.name.toLowerCase())) continue;
      const childRel = dirRel === '.' ? entry.name : `${dirRel}/${entry.name}`;
      if (ig?.ignores(`${childRel}/`)) continue;
      found.push(childRel);
      await recurse(childRel, depth + 1);
    }
  };

  await recurse('.', 1);
  return found.sort();
}

/**
 * Collects the files the configuration selects, as paths relative to `rootDir`, sorted and
 * de-duplicated. Exported separately so a caller can preview a selection without writing
 * anything.
 */
export async function collectFiles(cfg: MirrorConfig): Promise<{ files: string[]; skipped: SkippedFile[] }> {
  const rootDir = resolve(cfg.rootDir);
  if (cfg.includeDirs.length === 0) {
    throw new Error('includeDirs is empty: nothing would be copied. Select at least one directory.');
  }

  const conflicts = findSelectionConflicts(cfg.includeDirs, cfg.excludeDirs ?? []);
  if (conflicts.length > 0) {
    throw new Error(`The include and exclude lists contradict each other. ${describeConflicts(conflicts)}`);
  }

  const includeEnvFiles = cfg.includeEnvFiles ?? false;
  const ig = await loadGitignore(rootDir, cfg.respectGitignore ?? true);
  const ignoreDirs = new Set(
    [...DEFAULT_IGNORE_DIRS, ...(cfg.ignoreDirs ?? [])].map((d) => d.toLowerCase()),
  );
  const excluded = new Set((cfg.excludeDirs ?? []).map((d) => normalizeDirPath(d).toLowerCase()));

  const collected = new Set<string>();
  const skipped: SkippedFile[] = [];

  for (const dir of cfg.includeDirs) {
    const dirRel = normalizeDirPath(dir);
    const abs = join(rootDir, dirRel);
    const s = await stat(abs).catch(() => null);
    if (!s?.isDirectory()) {
      skipped.push({ relPath: dirRel, reason: 'not a directory under the project root' });
      continue;
    }
    const found: string[] = [];
    await walk(rootDir, dirRel, ig, ignoreDirs, excluded, found, { includeEnvFiles });
    for (const f of found) collected.add(f);
  }

  const maxBytes = cfg.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const files: string[] = [];
  for (const rel of [...collected].sort()) {
    if (!includeEnvFiles && isEnvFile(rel)) {
      skipped.push({ relPath: rel, reason: 'env file, excluded to protect secrets' });
      continue;
    }
    const s = await stat(join(rootDir, rel)).catch(() => null);
    if (!s) continue;
    if (s.size > maxBytes) {
      skipped.push({ relPath: rel, reason: `larger than ${Math.round(maxBytes / 1024)} KB` });
      continue;
    }
    files.push(rel);
  }

  return { files, skipped };
}

/**
 * Brings `targetDir` in line with the selection.
 *
 * Incremental by construction: a file is written only when its bytes differ from what is
 * already there, and target files that are no longer part of the selection are deleted.
 * Unchanged files are left untouched, which is what keeps OneDrive from re-uploading a whole
 * project every time one file is edited.
 */
export async function mirrorProject(cfg: MirrorConfig): Promise<MirrorResult> {
  const rootDir = resolve(cfg.rootDir);
  const targetDir = resolve(cfg.targetDir);
  const separator = cfg.separator ?? DEFAULT_SEPARATOR;
  const txtMode = cfg.txtMode ?? 'append';

  const { files, skipped } = await collectFiles(cfg);
  await mkdir(targetDir, { recursive: true });

  const used = new Set<string>();
  const desired = new Set<string>();
  const mapping: Record<string, string> = {};
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  let totalBytes = 0;

  for (const rel of files) {
    const targetName = flattenName(cfg.namePrefix ? `${cfg.namePrefix}/${rel}` : rel, used, separator, txtMode);
    desired.add(targetName);
    mapping[rel] = targetName;

    const source = join(rootDir, rel);
    const dest = join(targetDir, targetName);
    const bytes = await readFile(source);
    totalBytes += bytes.length;

    const existing = await readFile(dest).catch(() => null);
    if (existing === null) {
      await writeFile(dest, bytes);
      added.push(targetName);
    } else if (existing.equals(bytes)) {
      unchanged.push(targetName);
    } else {
      await writeFile(dest, bytes);
      updated.push(targetName);
    }
  }

  const deleted: string[] = [];
  for (const entry of await readdir(targetDir).catch(() => [] as string[])) {
    if (desired.has(entry) || RESERVED_TARGET_NAMES.has(entry)) continue;
    await rm(join(targetDir, entry), { recursive: true, force: true });
    deleted.push(entry);
  }

  return {
    added: added.sort(),
    updated: updated.sort(),
    deleted: deleted.sort(),
    unchanged: unchanged.sort(),
    skipped,
    mapping,
    totalBytes,
  };
}

/** One line for the console and the run log. */
export function describeMirror(r: MirrorResult): string {
  const bits = [
    `${r.added.length} added`,
    `${r.updated.length} updated`,
    `${r.deleted.length} deleted`,
    `${r.unchanged.length} unchanged`,
  ];
  if (r.skipped.length) bits.push(`${r.skipped.length} skipped`);
  return bits.join(', ');
}

/** Recovers the original relative path from a mirrored file name. */
export function unflattenName(
  targetName: string,
  separator = DEFAULT_SEPARATOR,
  txtMode: TxtMode = 'append',
): string {
  let name = targetName;
  if (txtMode === 'append' && name.toLowerCase().endsWith('.txt')) {
    name = name.slice(0, -4);
  }
  return name.split(separator).join('/');
}

/** `relative()` re-exported for callers building configs from absolute paths. */
export { relative as relativePath };
