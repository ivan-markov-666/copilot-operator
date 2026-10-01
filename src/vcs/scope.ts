/**
 * Which files a task may change, and what happens to a change outside them.
 *
 * A prompt that says "change only the tests for the editor page" is advice, and advice is what a
 * model weighs against everything else in the conversation: a task for one suite edited a shared
 * fixture another suite depended on, because it seemed helpful, and the review noticed only later.
 * `scope` on a task is the same sentence as a rule. After every round of steps the runner lists what
 * the working tree has changed since the task started; anything outside the scope is put back —
 * a changed or deleted file restored from the task's starting commit, a new file removed — and the
 * chat is told which, in the same message as the step results, before it writes its next step.
 *
 * It needs version control: the starting commit is what "put back" returns to, and the working tree
 * is known to have been clean when the task began (a task does not start on a dirty tree). Without
 * version control a scope is still sent to the chat as an instruction, and nothing is enforced.
 *
 * Patterns are repository-relative and use `/`: `tests/e2e/editor.spec.ts` is one file,
 * `tests/e2e/` or `tests/e2e/**` is everything under that folder, `*` matches within one folder
 * and `**` across folders. A pattern is read the way a path is: `\` is `/`, a `./` or `/` in front
 * and a `//` or `/./` inside change nothing, `src/../docs` is `docs`, and `.`, `./` or `/` alone is
 * the whole repository. Matching ignores case, as Windows does.
 */
import { readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { git, workingTreePaths } from './git.js';

/**
 * A path or pattern in the one spelling the matching expects: `/` between folders, nothing in front,
 * and no empty, `.` or `..` folder anywhere in it. A plan writes the same folder as `docs`, `./docs`,
 * `/docs`, `.\docs` or `src/../docs`, and they must all cover the same files: each spelling the
 * matching did not expect covered nothing, so every change the task made under it was put back.
 * Cleaning only the front left `src//docs` and `docs/.` the same way, so the whole path is resolved
 * here, as a path would be. The repository itself (`.`, `./`, `/`) comes out as the empty string.
 */
function normalise(p: string): string {
  const n = posix.normalize(p.replace(/\\/g, '/')).replace(/^\/+/, '');
  return n === '.' || n === './' ? '' : n;
}

function toRegExp(pattern: string): RegExp {
  let p = normalise(pattern.trim());
  // A folder, written with or without `**`, is everything under it.
  if (p.endsWith('/')) p += '**';
  let re = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i]!;
    if (c === '*' && p[i + 1] === '*') {
      // `**/` matches zero or more folders; a trailing `**` matches the rest of the path.
      if (p[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Whether a repository-relative path is one the task may change. An empty scope allows everything. */
export function inScope(path: string, scope: readonly string[]): boolean {
  if (scope.length === 0) return true;
  const p = normalise(path);
  return scope.some((pattern) => {
    // A blank entry names nothing, so it covers nothing. It must not read as the repository below,
    // which it would, since normalising it gives the same empty string as `.` does.
    if (pattern.trim() === '') return false;
    const clean = normalise(pattern.trim()).replace(/\/+$/, '');
    // `.`, `./` or `/` is the repository itself, so the whole project: a plan writes it to mean
    // anywhere, and read as a file named `.`, or as no path at all, it covered nothing and every
    // change the task made was put back.
    if (clean === '') return true;
    // A plain folder name without a slash still means the folder: `pages` covers `pages/Home.ts`.
    if (!/[*?]/.test(clean) && p.toLowerCase().startsWith(`${clean.toLowerCase()}/`)) return true;
    return toRegExp(pattern).test(p);
  });
}

/** What one check of the working tree found and did. */
export type ScopeCheck = { outside: string[]; reverted: string[]; failed: Array<{ path: string; why: string }> };

/**
 * Puts back every change outside `scope`. Only for a repository whose tree was clean when the task
 * started, which is why the caller passes the repository only when version control is active.
 */
export async function enforceScope(dir: string, scope: readonly string[], nothing = false): Promise<ScopeCheck> {
  const out: ScopeCheck = { outside: [], reverted: [], failed: [] };
  // An empty scope allows everything; `nothing` is the read-only task, which allows no change at all.
  if (scope.length === 0 && !nothing) return out;
  const changed = await workingTreePaths(dir);
  out.outside = nothing ? changed : changed.filter((p) => !inScope(p, scope));
  const root = resolve(dir);
  for (const rel of out.outside) {
    const abs = resolve(join(dir, rel));
    // Never outside the repository, whatever `git status` printed.
    if (abs !== root && !abs.startsWith(root + sep)) {
      out.failed.push({ path: rel, why: 'not inside the repository' });
      continue;
    }
    const tracked = await git(dir, ['cat-file', '-e', `HEAD:${rel.replace(/\\/g, '/')}`]);
    if (tracked.ok) {
      const back = await git(dir, ['checkout', 'HEAD', '--', rel]);
      if (back.ok) out.reverted.push(rel);
      else out.failed.push({ path: rel, why: back.stderr || 'git could not restore it' });
    } else {
      // Not in the starting commit: the task created it. A file, never a folder tree.
      try {
        await rm(abs, { force: true });
        out.reverted.push(rel);
        // And the folders it made for it, while they are empty: never a folder with anything in it.
        for (let d = dirname(abs); d !== root && d.startsWith(root + sep); d = dirname(d)) {
          if ((await readdir(d).catch(() => ['?'])).length > 0) break;
          await rmdir(d).catch(() => undefined);
        }
      } catch (e) {
        out.failed.push({ path: rel, why: (e as Error).message });
      }
    }
  }
  return out;
}

/** What the chat is told, in the message that carries the step results. */
export function scopeMessage(check: ScopeCheck, scope: readonly string[], readOnly = false): string {
  const list = (paths: string[]): string => paths.slice(0, 15).join(', ') + (paths.length > 15 ? `, and ${paths.length - 15} more` : '');
  const parts = [
    `${readOnly ? 'Changed by a read-only task' : "Outside this task's scope"}, so put back by the runner: ${list(check.reverted)}.`,
    check.failed.length > 0 ? `Could not be put back: ${check.failed.map((f) => `${f.path} (${f.why})`).join('; ')}.` : '',
    readOnly
      ? 'This task is read-only: it may change no file at all. Read, run and report; put what you found in your summary.'
      : `This task may change only: ${scope.join(', ')}. If the work truly needs a file outside that, do not work around it: ` +
        'end with status "blocked", name the file in "needed" and say why.',
  ];
  return parts.filter(Boolean).join(' ');
}

/** The line the opening message carries, so the chat knows the rule before its first step. */
export function scopeNote(scope: readonly string[], enforced: boolean): string {
  if (scope.length === 0) return '';
  return (
    `## Scope\n\nThis task may change only these paths (repository-relative): ${scope.join(', ')}. ` +
    (enforced
      ? 'After every round of steps the runner puts back any change outside them and tells you which.'
      : 'Version control is off for this session, so this is not enforced: keep to it.') +
    ' Reading any file in the project is fine.'
  );
}
