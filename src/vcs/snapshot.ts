/**
 * The operator's uncommitted changes, taken as the commit a session starts from.
 *
 * Version control used to have one answer to a dirty tree before a session's first task: not ours
 * to decide, so no branch at all. That stopped real work for the wrong reason — the YAML files a
 * migration needed as input were untracked, the runner kept the repository clean and changed
 * nothing, and the session could not do its job until the operator committed prerequisites by hand.
 *
 * `dirtyWorktree.policy: "snapshot"` makes it a decision the operator takes once, with the list in
 * front of them: the changes become one commit, "Capture operator baseline before run", on a branch
 * of its own (`<prefix>baseline/<session id>`), and the session's branches are cut from it. Nothing
 * is lost (the changes are a commit), the starting state can be gone back to, and every task's
 * commit shows only the task's work.
 *
 * What never goes in, whatever is chosen: secrets and tool output (`commitHygiene.ts`), files
 * outside the session's project folder, and ignored files that no task's scope names. A file that
 * does not go in cannot stay loose in the tree either — the first task's commit takes everything
 * (`commitAll`) and a scope removes a new file outside it — so it is "left out": written to the
 * repository's own `.git/info/exclude`, which is local, never committed, and leaves `.gitignore`
 * alone. A tracked change cannot be left out that way; one that may not go in refuses the snapshot.
 *
 * Like the rest of `vcs/`: nothing is reset, stashed, deleted or rewritten. The snapshot adds a
 * branch and a commit.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { EventBus } from '../session/events.js';
import type { DirtyWorktree, Session, SessionStart, VersionControl } from '../session/model.js';
import { looksGenerated } from './commitHygiene.js';
import { branchNameFrom, freeBranchName, git, gitBytes, isValidBranchName, RUNNER_EMAIL } from './git.js';
import { repoDirOf, sessionBranchName, sessionStart } from './taskVcs.js';
import { inputChanges, inputFilesInTree, inputSettings, inputSumsAt, missingInputPatterns, recaptureInputs } from './inputs.js';
import { artifactPatterns } from './artifacts.js';
import { inScope } from './scope.js';

export type SnapshotChoice = 'include' | 'leave-out';

/** One uncommitted file, what it is, and what may be done with it. */
export type SnapshotEntry = {
  path: string;
  /** The path before a rename, which goes into the commit with it. */
  from?: string;
  kind: 'tracked' | 'untracked' | 'ignored';
  /** What the operator may choose. Empty: neither — the snapshot is refused while it is there. */
  allowed: SnapshotChoice[];
  /** What happens unless the operator chooses otherwise; null when nothing is allowed. */
  choice: SnapshotChoice | null;
  /** Why it is not taken by default, or why it cannot be taken at all. */
  reason?: string;
  /** One of the operator's input files (`vcs.userInputs`): taken, or the snapshot is not. */
  input?: boolean;
  /** Its size in the working tree, in bytes; absent for a file that was deleted. */
  size?: number;
};

/** What a snapshot would do now, for the page and for the runner. */
export type SnapshotPlan = {
  /** The session wants a snapshot and the repository has something to take. */
  needed: boolean;
  /** A snapshot can be taken. False with `problem` when something stands in the way. */
  ok: boolean;
  problem?: string;
  policy: DirtyWorktree['policy'];
  requireApproval: boolean;
  repoDir: string;
  branch: string | null;
  head: string | null;
  /** The branch the snapshot would be committed on. */
  baselineBranch?: string;
  entries: SnapshotEntry[];
  /**
   * The session has already started and these are input files changed or added since: they are
   * committed on its line of work (`recaptureInputs`), not as a starting snapshot.
   */
  recapture?: { parent: string; ffBranch?: string; newBranch?: string };
};

/** The session's dirty-tree policy, absent fields filled in: reject, and asking first. */
export function dirtyPolicy(vcs: VersionControl | undefined): Required<DirtyWorktree> {
  const policy = vcs?.dirtyWorktree?.policy;
  return {
    policy: policy === 'snapshot' || policy === 'tracked-only-snapshot' ? policy : 'reject',
    requireApproval: vcs?.dirtyWorktree?.requireApproval !== false,
  };
}

/** A shortened list of paths for a message. */
export function someOf(paths: string[], n = 5): string {
  return `${paths.slice(0, n).join(', ')}${paths.length > n ? `, and ${paths.length - n} more` : ''}`;
}

/** What `git status` says is uncommitted, file by file, read raw so no path loses a character. */
async function statusEntries(top: string): Promise<Array<{ path: string; from?: string; untracked: boolean }> | null> {
  const r = await gitBytes(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!r.ok) return null;
  const parts = r.stdout.toString('utf8').split('\0');
  const out: Array<{ path: string; from?: string; untracked: boolean }> = [];
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i] ?? '';
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    // A rename or a copy is followed by the path it came from, as a record of its own.
    if (xy[0] === 'R' || xy[0] === 'C') {
      out.push({ path, from: parts[i + 1] || undefined, untracked: false });
      i += 1;
    } else out.push({ path, untracked: xy === '??' });
  }
  return out;
}

/**
 * The patterns of the session's task scopes that name files explicitly enough to let an ignored
 * file in. "The whole repository" (`.`, `**`, `*`) names nothing in particular.
 */
function scopedPatterns(session: Session): string[] {
  const out = new Set<string>();
  for (const task of session.tasks) {
    for (const raw of task.scope ?? []) {
      let p = raw.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');
      if (p.endsWith('/')) p += '**';
      if (!p || p === '.' || /^[*/]+$/.test(p)) continue;
      out.add(p);
    }
  }
  return [...out];
}

/** Ignored files a task's scope names, for the operator to tick. */
async function scopedIgnored(top: string, patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) return [];
  const r = await gitBytes(top, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...patterns.map((p) => `:(glob,icase)${p}`)], 60_000, 32 * 1024 * 1024);
  if (!r.ok) return [];
  return r.stdout.toString('utf8').split('\0').filter(Boolean).slice(0, 2000);
}

/** The repository's top folder, which every path git prints is relative to. */
async function topOf(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--show-toplevel']);
  return r.ok && r.stdout ? resolve(r.stdout) : null;
}

/**
 * Whether the session's start allows a snapshot, and why not. A snapshot is taken where the changes
 * are — on HEAD — so the session has to start from HEAD: `head`, or a branch or previous session
 * whose tip HEAD is. Asked without updating from the remote: a fetch is not the question here.
 */
async function startProblem(session: Session, dir: string, branch: string | null, head: string, allSessions: () => Promise<Session[]>): Promise<string | undefined> {
  const how = session.vcs?.startFrom ?? 'head';
  if (how === 'head') return undefined;
  const where = `${branch ? `the branch ${branch}` : 'a detached HEAD'} at ${head.slice(0, 8)}`;
  if (how === 'existing-branch') {
    return (
      `this session carries on the existing branch "${session.vcs?.existingBranch ?? ''}", and a starting snapshot is a branch of its own, ` +
      'so the work would not be on the branch you named. Commit the changes on that branch yourself, or choose another "Start from".'
    );
  }
  const offline = { ...session, vcs: { ...(session.vcs as VersionControl), updateFromRemote: false } };
  const resolved = await sessionStart(offline, dir, head, allSessions);
  if ('problem' in resolved) return resolved.problem;
  const commit = resolved.start?.commit;
  if (!commit || commit === head) return undefined;
  const wanted = resolved.start?.kind === 'previous-session' ? `the end of "${resolved.start.fromSession?.name ?? ''}"'s branch ${resolved.start.branch}` : `the local branch ${resolved.start?.branch ?? ''}`;
  return (
    `the changes are on ${where}, and this session is set to start from ${wanted} (${commit.slice(0, 8)}). ` +
    'A snapshot is taken where the changes are, so the session would not start where it was told to. ' +
    `Put the repository on ${resolved.start?.branch ?? 'that branch'} first, or choose "From wherever the repository is (as until now)".`
  );
}

/**
 * What a snapshot of the repository would take now, and what may be done with each file.
 *
 * Not needed when the session has no snapshot policy, already has its start, or the tree is clean.
 */
export async function planSnapshot(session: Session, allSessions: () => Promise<Session[]> = async () => []): Promise<SnapshotPlan> {
  const { policy, requireApproval } = dirtyPolicy(session.vcs);
  const inputs = inputSettings(session.vcs);
  const repoDir = repoDirOf(session);
  const plan: SnapshotPlan = { needed: false, ok: false, policy, requireApproval, repoDir, branch: null, head: null, entries: [] };
  if (!session.vcs?.enabled || (policy === 'reject' && !inputs)) return plan;
  if (session.vcsBaseCommit && (!inputs || session.vcs.startFrom === 'existing-branch')) return plan;
  const top = repoDir ? await topOf(repoDir) : null;
  if (!top) return { ...plan, problem: `${repoDir || 'The repository folder'} is not a git repository.` };
  if (session.vcsBaseCommit) return await planRecapture(session, top, plan);

  const status = await statusEntries(top);
  if (!status) return { ...plan, problem: 'git status could not be read.' };
  const branchR = await git(top, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headR = await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  plan.branch = branchR.ok && branchR.stdout !== 'HEAD' ? branchR.stdout : null;
  plan.head = headR.ok && headR.stdout ? headR.stdout : null;

  // The project folder, when it is a folder inside the repository: a change outside it is not this session's.
  const project = session.projectDir?.trim() ? relative(top, resolve(session.projectDir.trim())).replace(/\\/g, '/') : '';
  const inProject = (p: string): boolean => !project || project.startsWith('..') || isAbsolute(project) || p.toLowerCase() === project.toLowerCase() || p.toLowerCase().startsWith(`${project.toLowerCase()}/`);
  const size = async (p: string): Promise<number | undefined> => (await stat(join(top, p)).catch(() => null))?.size;

  /*
   * The operator's input files that are not committed as they are: new, changed, or ignored. They
   * are taken whatever the dirty-tree policy, or the snapshot is not; the rest of the tree is the
   * policy's. A secrets file or one outside the project is never an input.
   */
  const inputPaths = new Set<string>();
  if (inputs) {
    const dirtyNow = new Set(status.map((s) => s.path));
    for (const f of await inputFilesInTree(top, inputs.patterns)) {
      if (f.kind === 'tracked' && !dirtyNow.has(f.path)) continue;
      inputPaths.add(f.path);
      const blocked = looksGenerated(f.path)?.reason === 'a secrets file' ? 'a secrets file is never taken as an input' : !inProject(f.path) ? `outside the project folder ${project}` : undefined;
      plan.entries.push({ path: f.path, kind: f.kind, input: true, size: await size(f.path), allowed: blocked ? [] : ['include'], choice: blocked ? null : 'include', reason: blocked ?? 'an input file: committed with the starting snapshot, then read-only' });
    }
  }
  const others = status.filter((s) => !inputPaths.has(s.path));
  if (policy === 'reject') {
    if (plan.entries.length === 0) return plan;
    plan.needed = true;
    if (others.length > 0) {
      plan.problem =
        `besides the input files there are other uncommitted changes (${someOf(others.map((o) => o.path))}). ` +
        'Commit them yourself, or choose "Take them as a starting snapshot" under "Uncommitted changes".';
      return plan;
    }
  }
  if (plan.entries.length === 0 && others.length === 0) return plan;
  plan.needed = true;
  plan.requireApproval = (others.length > 0 && requireApproval) || (plan.entries.some((e) => e.input) && !!inputs?.requireApproval);

  for (const s of policy === 'reject' ? [] : others) {
    const generated = looksGenerated(s.path);
    const outside = !inProject(s.path);
    if (!s.untracked) {
      const blocked =
        generated?.reason === 'a secrets file'
          ? `a secrets file with uncommitted changes; it is tracked, so it cannot be left out. Commit or undo that change yourself`
          : outside
            ? `outside the project folder ${project}; it is tracked, so it cannot be left out. Commit or undo that change yourself`
            : undefined;
      plan.entries.push({ path: s.path, ...(s.from ? { from: s.from } : {}), kind: 'tracked', size: await size(s.path), allowed: blocked ? [] : ['include'], choice: blocked ? null : 'include', ...(blocked ? { reason: blocked } : {}) });
      continue;
    }
    const artifact = artifactPatterns(session.vcs).length > 0 && inScope(s.path, artifactPatterns(session.vcs));
    /*
     * A name that looks temporary (scratch.txt, tmp-x, a .bak) is the operator's to decide: left out unless
     * ticked, not forced out. The rule was written for the chat's own scratch copies, and it took the choice
     * away from an operator's own note (live run 2026-10-04).
     */
    if (!artifact && !outside && /^a (temporary copy|scratch folder)/.test(generated?.reason ?? '')) {
      plan.entries.push({ path: s.path, kind: 'untracked', size: await size(s.path), allowed: ['include', 'leave-out'], choice: 'leave-out', reason: 'looks like a temporary or scratch file: left out unless you include it' });
      continue;
    }
    const why = artifact
      ? 'an artifact: kept with the run, never committed'
      : generated ? generated.reason : outside ? `outside the project folder ${project}` : policy === 'tracked-only-snapshot' ? 'a new file, and this session takes tracked changes only' : undefined;
    plan.entries.push({ path: s.path, kind: 'untracked', size: await size(s.path), allowed: why ? ['leave-out'] : ['include', 'leave-out'], choice: why ? 'leave-out' : 'include', ...(why ? { reason: why } : {}) });
  }
  if (policy === 'snapshot') {
    for (const path of await scopedIgnored(top, scopedPatterns(session))) {
      if (looksGenerated(path) || !inProject(path) || inputPaths.has(path)) continue;
      plan.entries.push({ path, kind: 'ignored', allowed: ['include', 'leave-out'], choice: 'leave-out', reason: "ignored by git, and a task's scope names it: taken only when you tick it" });
    }
  }

  const blocked = plan.entries.filter((e) => e.allowed.length === 0);
  // A pattern that matches nothing anywhere is said now, before anything is committed for approval.
  const missing = inputs ? await missingInputPatterns(session, repoDir, top, allSessions) : [];
  if (missing.length > 0) {
    plan.problem =
      `the input file pattern(s) ${missing.map((m) => `"${m}"`).join(', ')} match no file in the project, and nothing earlier captured them. ` +
      'Correct "Input files" (a "*" stays inside one folder; "**" crosses folders), or put the files in the project.';
  } else if (!plan.head) plan.problem = 'the repository has no commit yet, so there is nothing for a snapshot to sit on. Make the first commit yourself.';
  else if (blocked.length > 0) plan.problem = `${blocked.length} change(s) can be neither taken nor left out: ${blocked.map((e) => `${e.path} (${e.reason})`).join('; ')}.`;
  // The session's own spelling of the folder, which is what other sessions are matched by.
  else plan.problem = await startProblem(session, repoDir, plan.branch, plan.head, allSessions);
  if (!plan.problem) {
    const prefix = session.vcs.branchPrefix || 'cop/';
    plan.baselineBranch = await freeBranchName(top, branchNameFrom(['baseline'], prefix) + `/${session.id}`);
    if (!(await isValidBranchName(top, plan.baselineBranch))) plan.problem = `"${plan.baselineBranch}" is not a name git accepts.`;
  }
  plan.ok = !plan.problem;
  return plan;
}

/**
 * After the session's start: the input files changed or added since it was recorded, to be taken
 * onto its line of work (see `recaptureInputs`). Anything else uncommitted is in the way, as it is
 * before a task, and refuses.
 */
async function planRecapture(session: Session, top: string, plan: SnapshotPlan): Promise<SnapshotPlan> {
  const inputs = inputSettings(session.vcs);
  if (!inputs || !session.vcsBaseCommit) return plan;
  const branchR = await git(top, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headR = await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  plan.branch = branchR.ok && branchR.stdout !== 'HEAD' ? branchR.stdout : null;
  plan.head = headR.ok && headR.stdout ? headR.stdout : null;
  const changes = await inputChanges(top, inputs.patterns, session.vcsStart?.inputs?.files);
  if (changes.length === 0) return plan;
  plan.needed = true;
  plan.requireApproval = inputs.requireApproval;

  const project = session.projectDir?.trim() ? relative(top, resolve(session.projectDir.trim())).replace(/\\/g, '/') : '';
  const inProject = (p: string): boolean => !project || project.startsWith('..') || isAbsolute(project) || p.toLowerCase() === project.toLowerCase() || p.toLowerCase().startsWith(`${project.toLowerCase()}/`);
  for (const c of changes) {
    const blocked = looksGenerated(c.path)?.reason === 'a secrets file' ? 'a secrets file is never taken as an input' : !inProject(c.path) ? `outside the project folder ${project}` : undefined;
    plan.entries.push({
      path: c.path,
      kind: c.kind,
      input: true,
      size: (await stat(join(top, c.path)).catch(() => null))?.size,
      allowed: blocked ? [] : ['include'],
      choice: blocked ? null : 'include',
      reason: blocked ?? 'an input file changed or added after the session started: committed on its line of work, then read-only',
    });
  }
  const changed = new Set(changes.map((c) => c.path));
  const others = ((await statusEntries(top)) ?? []).filter((s) => !changed.has(s.path)).map((s) => s.path);
  const blocked = plan.entries.filter((e) => e.allowed.length === 0);
  if (others.length > 0) {
    plan.problem = `besides the input files there are other uncommitted changes (${someOf(others)}). Commit or stash them yourself first.`;
  } else if (blocked.length > 0) {
    plan.problem = `${blocked.length} file(s) cannot be taken as inputs: ${blocked.map((e) => `${e.path} (${e.reason})`).join('; ')}.`;
  }

  // Where they go: on the session's one branch when it has it, else on the commit tasks are cut from.
  const sessionBranch = sessionBranchName(session);
  const tip = session.vcs?.branchMode === 'per-session' ? (await git(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${sessionBranch}^{commit}`])).stdout : '';
  if (tip) {
    plan.recapture = { parent: tip, ffBranch: sessionBranch };
    plan.baselineBranch = sessionBranch;
  } else {
    const newBranch = await freeBranchName(top, `${branchNameFrom(['input'], session.vcs?.branchPrefix || 'cop/')}/${session.id}`);
    plan.recapture = { parent: session.vcsBaseCommit, newBranch };
    plan.baselineBranch = newBranch;
  }
  plan.ok = !plan.problem;
  return plan;
}

/** A path as a pattern for `.git/info/exclude` that matches that one file and nothing else. */
function excludePattern(path: string): string {
  return `/${path.replace(/[\\*?[]/g, (c) => `\\${c}`).replace(/ $/, '\\ ')}`;
}

/** Adds the files to the repository's own exclude list, under a line that says who and why. */
/**
 * Why an approval does not match the list it answers, said as what is wrong, or null when it matches.
 * Every mismatch used to read "the files changed since the list was shown", also when the approval only
 * left a file without a choice and nothing had changed (live run 2026-10-03).
 */
export function approvalMismatch(listed: string[], choices: Record<string, unknown>, opts: { allMustBeIncluded?: boolean } = {}): string | null {
  const given = Object.keys(choices);
  const missing = listed.filter((p) => !(p in choices));
  const unknown = given.filter((p) => !listed.includes(p));
  const leftOut = opts.allMustBeIncluded ? listed.filter((p) => p in choices && choices[p] !== 'include') : [];
  const some = (paths: string[]): string => paths.slice(0, 5).join(', ') + (paths.length > 5 ? ` and ${paths.length - 5} more` : '');
  const parts = [
    ...(unknown.length > 0 ? [`${some(unknown)} ${unknown.length === 1 ? 'is' : 'are'} not on the list any more — the files changed since it was shown`] : []),
    ...(missing.length > 0 ? [`the approval has no choice for ${some(missing)}`] : []),
    ...(leftOut.length > 0 ? [`every input file is taken into this snapshot, and ${some(leftOut)} ${leftOut.length === 1 ? 'was' : 'were'} left out`] : []),
  ];
  return parts.length === 0 ? null : `${parts.join('; ')}. Look at the list again; nothing was done.`;
}

/**
 * Writes the left-out files into `.git/info/exclude`. `undo` puts the file back as it was, for every way
 * the snapshot can still fail afterwards: the failure says the repository is back as it was, and a
 * left-out file silently gone from `git status` would make that untrue.
 */
async function leaveOut(top: string, session: Session, paths: string[]): Promise<{ problem?: string; undo: () => Promise<void> }> {
  const nothing = { undo: async () => undefined };
  if (paths.length === 0) return nothing;
  const where = await git(top, ['rev-parse', '--git-path', 'info/exclude']);
  if (!where.ok || !where.stdout) return { ...nothing, problem: 'the repository\'s exclude file could not be found' };
  const file = resolve(top, where.stdout);
  await mkdir(dirname(file), { recursive: true });
  const existed = await readFile(file, 'utf8').then(() => true, () => false);
  const before = await readFile(file, 'utf8').catch(() => '');
  const undo = async (): Promise<void> => {
    if (existed) await writeFile(file, before, 'utf8').catch(() => undefined);
    else await rm(file, { force: true }).catch(() => undefined);
  };
  const block = [
    `# copilot-operator: left out of the starting snapshot of session "${session.name.replace(/[\r\n]+/g, ' ')}" (${session.id}), ${new Date().toISOString()}`,
    ...paths.map(excludePattern),
    '',
  ].join('\n');
  try {
    await writeFile(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${block}`, 'utf8');
  } catch (err) {
    await undo();
    return { ...nothing, problem: `the exclude file could not be written: ${(err as Error).message}` };
  }
  return { undo };
}

/** The commit message: what was taken, what was left out, from where, and on whose word. */
function snapshotMessage(session: Session, plan: SnapshotPlan, taken: SnapshotEntry[], leftOut: string[], approved: boolean): string {
  const list = (paths: string[]): string => [...paths.slice(0, 200).map((p) => `- ${p}`), ...(paths.length > 200 ? [`- and ${paths.length - 200} more`] : [])].join('\n');
  const inputs = taken.filter((e) => e.input);
  const rest = taken.filter((e) => !e.input).map((e) => e.path);
  const onlyInputs = rest.length === 0;
  return [
    onlyInputs ? 'Capture user-provided inputs' : 'Capture operator baseline before run',
    '',
    `The ${onlyInputs ? "operator's input files" : 'uncommitted changes in the repository'} of session "${session.name}", ${approved ? 'approved by the operator and ' : ''}committed before its first task so that`,
    "the session starts from them and every task's commit shows only that task's work.",
    ...(inputs.length > 0
      ? ['', `Input files, read by the work and not changed by it (${inputs.length}):`, list(inputs.map((e) => `${e.path}${e.size !== undefined ? ` (${e.size} bytes, ${e.kind})` : ''}`))]
      : []),
    ...(rest.length > 0 ? ['', `Taken (${rest.length}):`, list(rest)] : []),
    ...(leftOut.length > 0 ? ['', `Left out, in .git/info/exclude (${leftOut.length}):`, list(leftOut)] : []),
    '',
    `Taken from ${plan.branch ?? 'a detached HEAD'} at ${(plan.head ?? '').slice(0, 8)}, ${approved ? "on the operator's approval of this list" : 'automatically (requireApproval: false)'}.`,
    'Committed by copilot-operator. Not pushed.',
    '',
  ].join('\n');
}

export type SnapshotResult = { ok: true; start: SessionStart } | { ok: false; problem: string };

/**
 * Takes the snapshot: leaves out what is to be left out, cuts the baseline branch, commits the rest.
 *
 * `choices` is the operator's answer, one per file of the list they were shown; a list that no
 * longer matches the repository is refused, because what was approved is not what is there. Without
 * `approved`, every file takes its default and anything to be left out refuses (see `DirtyWorktree`).
 */
export async function takeSnapshot(
  session: Session,
  opts: { approved: boolean; choices?: Record<string, SnapshotChoice> },
  bus: EventBus,
  saveSession: (mutate: (s: Session) => void) => Promise<void>,
  allSessions: () => Promise<Session[]> = async () => [],
): Promise<SnapshotResult> {
  if (dirtyPolicy(session.vcs).policy === 'reject' && !inputSettings(session.vcs)) {
    return { ok: false, problem: 'this session does not take uncommitted changes as a snapshot. Choose that under Version control → "Uncommitted changes" first.' };
  }
  if (session.vcsBaseCommit) {
    // Started already: only input files changed or added since can be taken, onto its line of work.
    const plan = await planSnapshot(session, allSessions);
    if (!plan.needed || !plan.recapture) {
      return { ok: false, problem: 'this session has already started, and no input file has changed since: a snapshot is taken only before its first task.' };
    }
    if (!plan.ok) return { ok: false, problem: plan.problem ?? 'the input files cannot be taken.' };
    const paths = plan.entries.map((e) => e.path);
    if (opts.approved) {
      const wrong = approvalMismatch(paths, opts.choices ?? {}, { allMustBeIncluded: true });
      if (wrong) {
        return { ok: false, problem: wrong };
      }
    }
    const made = await recaptureInputs(session, plan.repoDir, paths, plan.recapture);
    if ('problem' in made) return { ok: false, problem: made.problem };
    const settings = inputSettings(session.vcs);
    const top = (await topOf(plan.repoDir)) as string;
    const before = session.vcsStart as SessionStart;
    const start: SessionStart = {
      ...before,
      inputs: {
        patterns: settings?.patterns ?? [],
        files: await inputSumsAt(top, made.commit, settings?.patterns ?? []),
        readOnly: settings?.readOnly ?? true,
        ...(before.inputs?.carried ? { carried: before.inputs.carried } : {}),
        recaptured: [...(before.inputs?.recaptured ?? []), { commit: made.commit, branch: made.branch, paths: paths.slice(0, 200), approved: opts.approved }],
      },
    };
    await saveSession((s) => {
      s.vcsStart = start;
      // A commit tasks are cut from moves to the inputs' commit; a session branch moved forward itself.
      if (plan.recapture?.newBranch) s.vcsBaseCommit = made.commit;
    });
    bus.publish({
      sessionId: session.id,
      type: 'vcs-inputs-recaptured',
      level: 'info',
      message: `${paths.length} input file(s) changed or added since the session started are now the commit ${made.commit.slice(0, 8)} on ${made.branch}; the next task starts from it`,
      data: { commit: made.commit, branch: made.branch, paths: paths.slice(0, 50) },
    });
    return { ok: true, start };
  }
  const plan = await planSnapshot(session, allSessions);
  if (!plan.needed) return { ok: false, problem: 'there is nothing uncommitted to take.' };
  if (!plan.ok || !plan.baselineBranch || !plan.head) return { ok: false, problem: plan.problem ?? 'the snapshot cannot be taken.' };

  const chosen = new Map<string, SnapshotChoice>();
  if (opts.approved) {
    const choices = opts.choices ?? {};
    const wrong = approvalMismatch(plan.entries.map((e) => e.path), choices);
    if (wrong) return { ok: false, problem: wrong };
    for (const e of plan.entries) {
      const c = choices[e.path];
      if (!c || !e.allowed.includes(c)) return { ok: false, problem: `${e.path} cannot be "${c ?? 'nothing'}": ${e.reason ?? 'not allowed'}. Nothing was done.` };
      chosen.set(e.path, c);
    }
  } else {
    for (const e of plan.entries) chosen.set(e.path, e.choice as SnapshotChoice);
    const toExclude = plan.entries.filter((e) => e.kind === 'untracked' && chosen.get(e.path) === 'leave-out');
    if (toExclude.length > 0) {
      return {
        ok: false,
        problem:
          `${toExclude.length} new file(s) would have to be left out of the snapshot (${toExclude.slice(0, 5).map((e) => `${e.path}: ${e.reason}`).join('; ')}), ` +
          "and that writes to the repository's .git/info/exclude, which needs your approval. Approve the list on the session's page, or deal with the files yourself.",
      };
    }
  }

  const top = (await topOf(plan.repoDir)) as string;
  const take = plan.entries.filter((e) => chosen.get(e.path) === 'include');
  const leaveOutPaths = plan.entries.filter((e) => e.kind === 'untracked' && chosen.get(e.path) === 'leave-out').map((e) => e.path);
  const leftOutAll = plan.entries.filter((e) => chosen.get(e.path) === 'leave-out').map((e) => e.path);
  if (take.length === 0) return { ok: false, problem: 'nothing would be taken: every file is left out. Leave them out yourself, or take at least one.' };

  const excluded = await leaveOut(top, session, leaveOutPaths);
  if (excluded.problem) return { ok: false, problem: excluded.problem };

  // With the left-out files gone from git's view, what is uncommitted must be exactly what is taken.
  const after = await statusEntries(top);
  const wanted = new Set(take.filter((e) => e.kind !== 'ignored').map((e) => e.path));
  const stray = (after ?? []).filter((s) => !wanted.has(s.path)).map((s) => s.path);
  if (!after || stray.length > 0) {
    await excluded.undo();
    return { ok: false, problem: `the repository changed while the snapshot was being taken (${someOf(stray)}). Nothing was committed; look at the list again.` };
  }

  const branch = plan.baselineBranch;
  const cut = await git(top, ['checkout', '-b', branch]);
  if (!cut.ok) {
    await excluded.undo();
    return { ok: false, problem: `the branch ${branch} could not be made: ${cut.stderr || cut.stdout}` };
  }

  const back = async (why: string): Promise<SnapshotResult> => {
    if (plan.branch) await git(top, ['checkout', plan.branch]);
    await excluded.undo();
    return { ok: false, problem: `${why} Nothing was committed; the repository is back on ${plan.branch ?? 'where it was'} with your changes as they were.` };
  };
  // Literal paths from a file: no glob in a name is read as a pattern, and no command line gets too long.
  const list = join(tmpdir(), `cop-snapshot-${process.pid}-${Date.now()}.txt`);
  const add = async (paths: string[], force: boolean): Promise<string | undefined> => {
    if (paths.length === 0) return undefined;
    await writeFile(list, `${paths.join('\0')}\0`, 'utf8');
    const r = await git(top, ['--literal-pathspecs', 'add', ...(force ? ['-f'] : ['-A']), `--pathspec-from-file=${list}`, '--pathspec-file-nul']);
    return r.ok ? undefined : r.stderr || r.stdout || 'git add failed';
  };
  try {
    const plain = take.filter((e) => e.kind !== 'ignored').flatMap((e) => (e.from ? [e.path, e.from] : [e.path]));
    const failed = (await add(plain, false)) ?? (await add(take.filter((e) => e.kind === 'ignored').map((e) => e.path), true));
    if (failed) return await back(`the files could not be staged: ${failed}.`);
  } finally {
    await rm(list, { force: true });
  }

  const message = snapshotMessage(session, plan, take, leftOutAll, opts.approved);
  const commit = await git(top, ['-c', 'user.name=copilot-operator', '-c', `user.email=${RUNNER_EMAIL}`, 'commit', '--no-verify', '-q', '-m', message]);
  if (!commit.ok) return await back(`the snapshot could not be committed: ${commit.stderr || commit.stdout}.`);
  const sha = (await git(top, ['rev-parse', 'HEAD'])).stdout;

  const start: SessionStart = {
    kind: 'snapshot',
    commit: sha,
    branch,
    snapshot: {
      ...(plan.branch ? { fromBranch: plan.branch } : {}),
      fromCommit: plan.head,
      included: take.map((e) => e.path).slice(0, 500),
      leftOut: leftOutAll.slice(0, 500),
      approved: opts.approved,
      // When, so the record and the run log say it (live run 2026-10-03: never timestamped).
      ...(opts.approved ? { approvedAt: new Date().toISOString() } : {}),
    },
  };
  await saveSession((s) => {
    s.vcsBaseCommit = sha;
    s.vcsStart = start;
  });
  bus.publish({
    sessionId: session.id,
    type: 'vcs-snapshot',
    level: 'info',
    message:
      `your uncommitted changes are now the commit ${sha.slice(0, 8)} on ${branch} (${take.length} file(s)` +
      `${leftOutAll.length > 0 ? `, ${leftOutAll.length} left out` : ''}); ${plan.branch ?? 'the branch you were on'} itself is unchanged. ` +
      'The session starts from that commit.',
    data: { branch, commit: sha, included: take.length, leftOut: leftOutAll.length },
  });
  return { ok: true, start };
}
