/**
 * Whether a task can be satisfied at all, decided before anything is sent to the chat.
 *
 * A task is a contract: a prompt, the checks that say when it is done, and what it may change
 * (`readOnly`, `scope`). The three are written at different times — a plan, an edit, a new prompt on
 * a finished task — and they can end up contradicting each other: an audit made read-only that
 * still carries the old "the file now says X" check; a task scoped to its tests that must change
 * the config to pass. Run as it is, such a task spends its rounds and ends blocked on a check the
 * chat could never have met. This names the contradiction instead, before the first message.
 *
 * Only what can be known without running anything is judged: the flags against each other, and
 * the file checks against the tree the task starts from (see `ContractTree`). A file check that already passes needs no change;
 * one that fails needs its file changed, which a read-only task, or a scope that leaves the file
 * out, forbids. Command checks are not judged: whether a command will pass depends on work the
 * task is allowed to do elsewhere.
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Task, TaskCheck } from '../session/model.js';
import { inScope } from '../vcs/scope.js';
import { gitBytes } from '../vcs/git.js';

/**
 * Where the task's file checks are judged: the working tree as it is ('tree'), the commit the task will
 * start from ({ ref }), or nowhere yet ('unknown'), when that commit is decided only as the session starts —
 * an update from the remote still to come, an earlier session of the batch still to run. Before the run the
 * tree in the folder is often not the task's: the live run of 2026-10-04 refused a task for a file its start,
 * main brought up to the remote, would have had, judging the branch the folder happened to be on.
 */
export type ContractTree = 'tree' | 'unknown' | { ref: string };

async function fileCheckPassesNow(check: TaskCheck, cwd: string, repoDir: string, at: Exclude<ContractTree, 'unknown'>): Promise<{ passes: boolean; path: string }> {
  const path = resolve(cwd, (check.cwd ?? '').trim() || '.', (check.file ?? '').trim());
  const rel = relative(resolve(repoDir), path).replace(/\\/g, '/');
  const inRepo = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  let exists: boolean;
  let text = '';
  if (at !== 'tree' && inRepo) {
    const shown = await gitBytes(repoDir, ['show', `${at.ref}:${rel}`]).catch(() => null);
    exists = !!shown?.ok;
    text = exists ? shown!.stdout.toString('utf8') : '';
  } else {
    const info = await stat(path).catch(() => null);
    exists = !!info?.isFile();
    text = exists && check.expect === 'file-contains' ? await readFile(path, 'utf8').catch(() => '') : '';
  }
  if (check.expect === 'file-exists') return { passes: exists, path };
  if (check.expect === 'file-missing') return { passes: !exists, path };
  return { passes: exists && text.includes(check.value ?? ''), path };
}

/** `git` with the global options that may come before its subcommand. */
const GIT = String.raw`\bgit(?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|--no-pager|-c\s+\S+))*\s+`;

/** A check whose command asks which branch is checked out. */
export function readsCurrentBranch(check: TaskCheck): boolean {
  return !!check.run && new RegExp(`${GIT}(?:branch\\s+--show-current|rev-parse\\s+--abbrev-ref\\s+HEAD|symbolic-ref\\s+(?:-q\\s+)?(?:--short\\s+)?HEAD|name-rev\\s+--name-only\\s+HEAD)`, 'i').test(check.run);
}

/**
 * A check whose command asks whether the working tree is clean: `git status --porcelain`/`--short`,
 * `git diff --quiet`/`--exit-code`. With version control on, the runner commits the task's changes
 * after its checks — and the chat may not commit — so such a check is decided after that commit.
 */
export function readsTreeClean(check: TaskCheck): boolean {
  return !!check.run && new RegExp(`${GIT}(?:status\\b[^|;&\\n]*(?:--porcelain|--short|\\s-s\\b)|diff\\b[^|;&\\n]*(?:--quiet|--exit-code))`, 'i').test(check.run);
}

/**
 * Whether a check about the checked-out branch can pass on `branch`, the one the runner chose.
 * `null` when it cannot be told without running it.
 */
function branchCheckPasses(check: TaskCheck, branch: string): boolean | null {
  const value = check.value ?? '';
  if (check.expect === 'output-contains') return value === '' || branch.includes(value);
  if (check.expect === 'output-omits') return value === '' || !branch.includes(value);
  if (check.expect === 'output-matches') {
    try {
      return new RegExp(value).test(branch);
    } catch {
      return null;
    }
  }
  // A comparison written into the command: `(git branch --show-current) -eq 'recovery/x'`.
  const named = [...(check.run ?? '').matchAll(/['"]([\w.-]+(?:\/[\w.-]+)+)['"]/g)].map((m) => m[1]!);
  if (named.length > 0) return named.includes(branch);
  return null;
}

/** Each contradiction in the task, as a sentence; empty when it can be satisfied. */
export async function contractConflicts(
  task: Pick<Task, 'readOnly' | 'scope' | 'checks' | 'reviewChecks'>,
  cwd: string,
  repoDir: string,
  /** The branch version control put the task on, when it is on; where its file checks are judged (see `ContractTree`). */
  vcs: { branch?: string; files?: ContractTree; carried?: string[] } = {},
): Promise<string[]> {
  const out: string[] = [];
  const scope = task.scope ?? [];
  /*
   * A check that the task is on a branch the runner did not choose can never pass: the chat may not
   * switch branches. Seen on 2026-09-30, a check still expecting the recovery branch the session had
   * been started from, while the runner worked on its own. Named before the start, with the check
   * that does what was meant: that the earlier work is in this branch.
   */
  if (vcs.branch) {
    const all = [...(task.checks ?? []), ...(task.reviewChecks ?? []).filter((rc) => rc.state === 'active').map((rc) => rc.check)];
    for (const check of all.filter(readsCurrentBranch)) {
      if (branchCheckPasses(check, vcs.branch) !== false) continue;
      out.push(
        `The check "${check.name}" expects another branch, but version control put this task on ${vcs.branch}, and the chat may not switch branches. ` +
          'To check that earlier work is included, check its commit instead: git merge-base --is-ancestor <commit> HEAD.',
      );
    }
  }
  if (task.readOnly && scope.length > 0) {
    out.push(`It is read-only, which allows no change, and also scoped to ${scope.join(', ')}, which allows changes there.`);
  }
  if (!task.readOnly && scope.length === 0) return out;

  const checks = [
    ...(task.checks ?? []),
    ...(task.reviewChecks ?? []).filter((rc) => rc.state === 'active').map((rc) => rc.check),
  ].filter((c) => c.expect === 'file-exists' || c.expect === 'file-missing' || c.expect === 'file-contains');
  const at = vcs.files ?? 'tree';
  // Judged when the task starts, on its own tree, once that is known.
  if (at === 'unknown') return out;
  for (const check of checks) {
    const { passes, path } = await fileCheckPassesNow(check, cwd, repoDir, at);
    if (passes) continue;
    const rel = relative(resolve(repoDir), path).replace(/\\/g, '/');
    const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    /*
     * An input file the runner carries onto the task's start from its last capture is not in the tree
     * judged here, and needs no change to be there: judged at the task's start (live run 2026-10-04).
     */
    if (inside && (vcs.carried?.length ?? 0) > 0 && inScope(rel, vcs.carried!)) continue;
    if (task.readOnly) {
      out.push(`The check "${check.name}" fails now and can only pass if ${rel || path} changes, but the task is read-only.`);
    } else if (inside && !inScope(rel, scope)) {
      out.push(`The check "${check.name}" fails now and can only pass if ${rel} changes, but the task's scope (${scope.join(', ')}) leaves that file out.`);
    }
  }
  return out;
}
