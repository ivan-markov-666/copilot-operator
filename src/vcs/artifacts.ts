/**
 * Evidence the work produces — reports, ZIP archives, test results — kept with the run, not in git.
 *
 * Found in a real run: evidence a task wrote was either committed with the work or, to stop that,
 * `.gitignore` had to be changed for it, and a later session that needed an earlier one's discovery
 * report had nothing reliable to read. `vcs.artifacts.paths` names those files, and:
 *
 *   - they are never committed: the patterns go into the repository's own `.git/info/exclude`
 *     (local, never committed, `.gitignore` untouched) when the session's first task starts, so the
 *     runner's commit and a task's scope both leave them alone. A file git already tracks is not
 *     affected by an exclude, and is said so;
 *   - when each task ends, whatever its outcome, the files are copied into the attempt's record,
 *     `artifacts/project/<path>`, with their sizes and SHA-256 sums on the task — so the evidence of
 *     each attempt is kept even after a later one overwrites it in the project.
 *
 * Works with version control off too: then nothing is excluded, only kept.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import type { Session, VersionControl } from '../session/model.js';
import { looksGenerated } from './commitHygiene.js';
import { git } from './git.js';
import { normalisePatterns } from './inputs.js';
import { inScope } from './scope.js';

/**
 * The patterns among `patterns` whose files an artifact pattern would cover, and so keep out of git.
 * Judged by a path the pattern stands for (`**` and `*` filled in). Found in a run on 0.1.18: an
 * artifact pattern of a whole project folder covered the input files and the task's own work, every
 * file the task wrote was ignored, and "nothing to commit" ended it done.
 */
export function coveredByArtifacts(patterns: string[], artifacts: string[]): string[] {
  const arts = normalisePatterns(artifacts);
  if (arts.length === 0) return [];
  return normalisePatterns(patterns).filter((p) => {
    const sample = p.replace(/\/+$/, '/f').replace(/\*\*/g, 'a/b').replace(/[*?]/g, 'x');
    return inScope(sample, arts);
  });
}

/** The session's artifact patterns, without ones that name the whole project. */
export function artifactPatterns(vcs: VersionControl | undefined): string[] {
  return normalisePatterns(vcs?.artifacts?.paths ?? []);
}

/** A pattern for `.git/info/exclude`: anchored at the repository's top, as a scope pattern is. */
function excludeLine(pattern: string): string {
  return `/${pattern.replace(/^\/+/, '')}`;
}

/**
 * Writes the session's artifact patterns into `.git/info/exclude`, once each. Returns the files
 * matching them that git already tracks, which an exclude does not stop from being committed.
 */
export async function excludeArtifacts(dir: string, session: Session): Promise<{ problem?: string; tracked: string[] }> {
  const patterns = artifactPatterns(session.vcs);
  if (patterns.length === 0) return { tracked: [] };
  const where = await git(dir, ['rev-parse', '--git-path', 'info/exclude']);
  if (!where.ok || !where.stdout) return { problem: "the repository's exclude file could not be found", tracked: [] };
  const top = (await git(dir, ['rev-parse', '--show-toplevel'])).stdout || dir;
  const file = resolve(dir, where.stdout);
  const before = await readFile(file, 'utf8').catch(() => '');
  const have = new Set(before.split(/\r?\n/).map((l) => l.trim()));
  const add = patterns.map(excludeLine).filter((l) => !have.has(l));
  if (add.length > 0) {
    try {
      await mkdir(dirname(file), { recursive: true });
      const block = [`# copilot-operator: artifacts of session "${session.name.replace(/[\r\n]+/g, ' ')}" (${session.id}) — kept with the run, never committed`, ...add, ''].join('\n');
      await writeFile(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${block}`, 'utf8');
    } catch (e) {
      return { problem: `the exclude file could not be written: ${(e as Error).message}`, tracked: [] };
    }
  }
  const tracked = (await git(resolve(top), ['ls-files'])).stdout.split('\n').filter((p) => p && inScope(p, patterns));
  return { tracked };
}

export type KeptArtifact = { path: string; size: number; sha256: string };

const LIMITS = { files: 1000, fileBytes: 100 * 1024 * 1024, totalBytes: 500 * 1024 * 1024, listed: 20_000 };

/** Each matching file's size and modification time, read when a task starts. */
export type ArtifactState = Map<string, string>;

/**
 * The artifact files as they are before a task, so that what is kept afterwards is what the task
 * made or changed. Found in a real run: a broad pattern kept every file already under it, evidence
 * of earlier sessions included, as if this task had produced it.
 */
export async function artifactState(root: string, patterns: string[]): Promise<ArtifactState> {
  const state: ArtifactState = new Map();
  if (patterns.length === 0 || !root) return state;
  for (const rel of await matching(root, patterns)) {
    const info = await stat(join(root, rel)).catch(() => null);
    if (info) state.set(rel, `${info.size}:${info.mtimeMs}`);
  }
  return state;
}

/** Files under `root` matching the patterns, found on disk: git's view does not matter for evidence. */
async function matching(root: string, patterns: string[]): Promise<string[]> {
  const out: string[] = [];
  const starts = new Set(
    patterns.map((p) => {
      const fixed: string[] = [];
      for (const part of p.replace(/\/+$/, '').split('/')) {
        if (/[*?[]/.test(part)) break;
        fixed.push(part);
      }
      return fixed.join('/');
    }),
  );
  const walk = async (rel: string): Promise<void> => {
    if (out.length > LIMITS.listed) return;
    const abs = join(root, rel);
    const info = await stat(abs).catch(() => null);
    if (!info) return;
    if (info.isFile()) {
      if (inScope(rel, patterns)) out.push(rel);
      return;
    }
    if (!info.isDirectory()) return;
    const name = rel.split('/').pop() ?? '';
    if (name === '.git' || name === 'node_modules' || name === '.copilot-operator') return;
    for (const child of await readdir(abs).catch(() => [] as string[])) await walk(rel ? `${rel}/${child}` : child);
  };
  for (const start of starts) await walk(start);
  return [...new Set(out)].sort();
}

/**
 * Copies into the attempt's record, `<dest>/<path>`, the artifact files this task made or changed:
 * under the session's artifact patterns or the task's own `outputs`, new or changed since `before`
 * (`artifactState` at the task's start), and inside the task's scope when it has one (its outputs
 * always count). A file already there and untouched is not this task's evidence and is not kept.
 * Secrets are never copied; past the limits the rest is skipped and said.
 */
export async function keepArtifacts(
  root: string,
  patterns: string[],
  dest: string,
  opts: { before?: ArtifactState; scope?: string[]; outputs?: string[] } = {},
): Promise<{ kept: KeptArtifact[]; skipped: string[]; unchanged: number; outsideScope: string[] }> {
  const kept: KeptArtifact[] = [];
  const skipped: string[] = [];
  const outsideScope: string[] = [];
  let unchanged = 0;
  const outputs = normalisePatterns(opts.outputs ?? []);
  const scope = opts.scope ?? [];
  const all = [...new Set([...patterns, ...outputs])];
  if (all.length === 0 || !root) return { kept, skipped, unchanged, outsideScope };
  let total = 0;
  const base = resolve(root);
  for (const rel of await matching(root, all)) {
    const from = resolve(join(root, rel));
    if (!from.startsWith(base + sep)) continue;
    if (looksGenerated(rel)?.reason === 'a secrets file') {
      skipped.push(`${rel} (a secrets file)`);
      continue;
    }
    const info = await stat(from).catch(() => null);
    if (!info) continue;
    if (opts.before && opts.before.get(rel) === `${info.size}:${info.mtimeMs}`) {
      unchanged += 1;
      continue;
    }
    if (scope.length > 0 && !inScope(rel, scope) && !(outputs.length > 0 && inScope(rel, outputs))) {
      outsideScope.push(rel);
      continue;
    }
    if (kept.length >= LIMITS.files || info.size > LIMITS.fileBytes || total + info.size > LIMITS.totalBytes) {
      skipped.push(`${rel} (past the limit of ${LIMITS.files} files, ${LIMITS.fileBytes / 1048576} MB a file, ${LIMITS.totalBytes / 1048576} MB in all)`);
      continue;
    }
    const to = join(dest, rel);
    try {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
      const bytes = await readFile(to);
      kept.push({ path: rel, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      total += info.size;
    } catch (e) {
      skipped.push(`${rel} (${(e as Error).message})`);
    }
  }
  return { kept, skipped, unchanged, outsideScope };
}
