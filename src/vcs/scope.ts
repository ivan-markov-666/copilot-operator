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
 * and `**` across folders. Matching ignores case, as Windows does.
 */
import { readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { git, workingTreePaths } from './git.js';

function toRegExp(pattern: string): RegExp {
  let p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
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
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return scope.some((pattern) => {
    const clean = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    // A plain folder name without a slash still means the folder: `pages` covers `pages/Home.ts`.
    if (clean && !/[*?]/.test(clean) && p.toLowerCase().startsWith(`${clean.toLowerCase()}/`)) return true;
    return toRegExp(pattern).test(p);
  });
}

/** What one check of the working tree found and did. */
export type ScopeCheck = { outside: string[]; reverted: string[]; failed: Array<{ path: string; why: string }> };

/**
 * Puts back every change outside `scope`. Only for a repository whose tree was clean when the task
 * started, which is why the caller passes the repository only when version control is active.
 */
export async function enforceScope(dir: string, scope: readonly string[]): Promise<ScopeCheck> {
  const out: ScopeCheck = { outside: [], reverted: [], failed: [] };
  if (scope.length === 0) return out;
  const changed = await workingTreePaths(dir);
  out.outside = changed.filter((p) => !inScope(p, scope));
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
export function scopeMessage(check: ScopeCheck, scope: readonly string[]): string {
  const list = (paths: string[]): string => paths.slice(0, 15).join(', ') + (paths.length > 15 ? `, and ${paths.length - 15} more` : '');
  const parts = [
    `Outside this task's scope, so put back by the runner: ${list(check.reverted)}.`,
    check.failed.length > 0 ? `Could not be put back: ${check.failed.map((f) => `${f.path} (${f.why})`).join('; ')}.` : '',
    `This task may change only: ${scope.join(', ')}. If the work truly needs a file outside that, do not work around it: ` +
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
