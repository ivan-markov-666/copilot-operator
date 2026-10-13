/**
 * Where the work starts, chosen in the start window every time a run is started.
 *
 * Asked for on 2026-10-13: pressing a start button always opens a form first, in which the operator
 * picks the branch the work starts from — `main` as it is here, `main` as it is on the server (fetched
 * there and then, through Git's own password window when the SSH key has a passphrase), or any other
 * local or remote branch, `feature/casw-2312-add-okta-validation-tests` and the like. Until then the
 * start was whatever the session's page said, the remote was reached only by a fetch that may not ask
 * for anything (and so failed on a key with a passphrase), and a branch that existed only on the server
 * could not be started from at all.
 *
 * The choice is the session's start (`VersionControl.startFrom`), written on the session when the run
 * is started, so the session's page, the run's checks and the record all read the same thing:
 *
 *   local    `startFrom: branch` from the local branch as it is — nothing fetched, nothing moved
 *   remote   `startFrom: branch` from `<remote>/<branch>` as the start window fetched it; the local
 *            branch of that name is neither read nor moved (`VersionControl.baseRemote`)
 *   …on it   (`onBranch`) no new branch: `existing-branch` on that branch itself. From a remote branch
 *            the local branch is made from it, or brought up to it — fast-forward only — first.
 *   previous-session   carries on the session before it in the same repository, as before
 *
 * A session whose start is already fixed — it has a recorded start and a task of it has run — keeps it:
 * its tasks carry on from there, and the window says so instead of offering a choice.
 */
import type { Session, VersionControl } from '../session/model.js';
import { git, isAncestor, isValidBranchName, lastFetchedAt } from './git.js';
import { fetchAsOperator, fetchCommandFor, type OperatorFetch } from './remoteAuth.js';
import { describeStart, remoteTip, repoDirOf } from './taskVcs.js';

export type StartChoice =
  | { from: 'local'; branch: string; onBranch?: boolean }
  | { from: 'remote'; remote: string; branch: string; onBranch?: boolean }
  | { from: 'previous-session' };

export type BranchTip = { name: string; commit: string };

/** What the start window offers for one repository: its branches, local and as last fetched. */
export type RepoBranches = {
  repoDir: string;
  /** Why the folder cannot be read as a repository; nothing else is filled then. */
  problem?: string;
  /** The branch checked out, null on a detached HEAD. */
  current: string | null;
  head: string | null;
  local: BranchTip[];
  /** Each remote with its branches as they were last fetched here (no network). */
  remotes: Array<{ name: string; branches: BranchTip[] }>;
  /** When anything was last fetched here, when that can be told. */
  lastFetched?: string;
};

/** One session of the run, as the start window shows it. */
export type StartOptionSession = {
  id: string;
  name: string;
  /** Version control is on: without it the runner does no git, and there is nothing to choose. */
  vcs: boolean;
  repoDir?: string;
  /** The start is fixed already; what it is, in a sentence. Nothing is offered then. */
  fixed?: string;
  /** A start prepared before the run (a starting snapshot), which another choice drops. */
  prepared?: string;
  /** What the window offers first: the session's own setting, made into one of the choices. */
  choice?: StartChoice;
  /** "Carry on from the session before it" makes sense here: set so, or an earlier session of the run is in this repository. */
  previousOffered: boolean;
};

const lines = (s: string): string[] => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const norm = (dir: string): string => dir.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();

/** A task of the session has run: a start recorded since then is the one its work stands on. */
export function startIsFixed(session: Session): boolean {
  const ran = session.tasks.some((t) => !!t.startedAt || (t.attempts ?? []).some((a) => !!a.startedAt));
  return !!session.vcsBaseCommit && ran;
}

/** The branches of the repository at `dir`, read without touching the network. */
export async function repoBranches(dir: string): Promise<RepoBranches> {
  const empty = (problem: string): RepoBranches => ({ repoDir: dir, problem, current: null, head: null, local: [], remotes: [] });
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') return empty(`${dir} is not a git repository.`);
  const current = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const head = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const refs = await git(dir, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes']);
  const remoteNames = lines((await git(dir, ['remote'])).stdout);
  const local: BranchTip[] = [];
  const byRemote = new Map<string, BranchTip[]>(remoteNames.map((r) => [r, []]));
  for (const line of refs.ok ? lines(refs.stdout) : []) {
    const [commit, ref] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)];
    if (ref.startsWith('refs/heads/')) local.push({ name: ref.slice('refs/heads/'.length), commit });
    else if (ref.startsWith('refs/remotes/')) {
      const rest = ref.slice('refs/remotes/'.length);
      const remote = remoteNames.find((r) => rest.startsWith(`${r}/`));
      const name = remote ? rest.slice(remote.length + 1) : '';
      // `origin/HEAD` points at a branch; it is not one.
      if (!remote || !name || name === 'HEAD') continue;
      byRemote.get(remote)?.push({ name, commit });
    }
  }
  const gitDir = (await git(dir, ['rev-parse', '--absolute-git-dir'])).stdout;
  const fetched = gitDir ? lastFetchedAt(gitDir) : undefined;
  return {
    repoDir: dir,
    current: current.ok && current.stdout ? current.stdout : null,
    head: head.ok && head.stdout ? head.stdout : null,
    local,
    remotes: [...byRemote.entries()].map(([name, branches]) => ({ name, branches })),
    ...(fetched ? { lastFetched: fetched } : {}),
  };
}

/** The remote a branch is most likely wanted from: `origin`, else the first one. */
export function defaultRemote(repo: RepoBranches): string | undefined {
  return repo.remotes.find((r) => r.name === 'origin')?.name ?? repo.remotes[0]?.name;
}

/**
 * What the start window offers first for a session: its own setting, as one of the choices. A local
 * branch that is not here is offered from the remote when the remote has it, else the branch the
 * repository is on — a start from wherever it happens to be (`head`) is offered as that branch, which
 * is what it would have been.
 */
export function defaultChoice(session: Session, repo: RepoBranches): StartChoice {
  const vcs = session.vcs;
  const how = vcs?.startFrom ?? 'head';
  if (how === 'previous-session') return { from: 'previous-session' };
  const onBranch = how === 'existing-branch';
  // A branch the session names, as against one assumed (`main`, or wherever the repository is).
  const named = (how === 'head' ? '' : (onBranch ? vcs?.existingBranch : vcs?.baseBranch)?.trim()) ?? '';
  const wanted = named || (how === 'head' ? repo.current ?? '' : 'main');
  const remote = vcs?.baseRemote?.trim();
  const hasRemote = (r: string, b: string): boolean => !!repo.remotes.find((x) => x.name === r)?.branches.some((x) => x.name === b);
  if (remote && hasRemote(remote, wanted)) return { from: 'remote', remote, branch: wanted, ...(onBranch ? { onBranch } : {}) };
  if (wanted && repo.local.some((b) => b.name === wanted)) return { from: 'local', branch: wanted, ...(onBranch ? { onBranch } : {}) };
  const other = remote && repo.remotes.some((x) => x.name === remote) ? remote : defaultRemote(repo);
  if (other && wanted && hasRemote(other, wanted)) return { from: 'remote', remote: other, branch: wanted, ...(onBranch ? { onBranch } : {}) };
  /*
   * Named, and neither here nor fetched yet — a branch a colleague pushed after the last fetch: offered from
   * the remote all the same, which the window fetches by name. Offered as the branch the repository is on,
   * it was started from that instead with one press, and the session's own branch was written over.
   */
  if (named && other) return { from: 'remote', remote: other, branch: named, ...(onBranch ? { onBranch } : {}) };
  return { from: 'local', branch: repo.current ?? repo.local[0]?.name ?? wanted };
}

/**
 * The sessions of a run as the start window shows them, in run order, with the branches of each
 * repository they work in.
 */
export async function startOptions(sessions: Session[]): Promise<{ repos: RepoBranches[]; sessions: StartOptionSession[] }> {
  const repos = new Map<string, RepoBranches>();
  const out: StartOptionSession[] = [];
  const seenRepos = new Set<string>();
  for (const s of sessions) {
    const dir = s.vcs?.enabled ? repoDirOf(s) : '';
    if (!dir) {
      out.push({ id: s.id, name: s.name, vcs: false, previousOffered: false });
      continue;
    }
    const key = norm(dir);
    if (!repos.has(key)) repos.set(key, await repoBranches(dir));
    const repo = repos.get(key) as RepoBranches;
    const earlierHere = seenRepos.has(key);
    seenRepos.add(key);
    const entry: StartOptionSession = {
      id: s.id,
      name: s.name,
      vcs: true,
      repoDir: repo.repoDir,
      previousOffered: s.vcs?.startFrom === 'previous-session' || earlierHere,
    };
    if (startIsFixed(s) && s.vcsStart) entry.fixed = describeStart(s.vcsStart);
    else if (startIsFixed(s)) entry.fixed = `it started from ${s.vcsBaseCommit?.slice(0, 8)}`;
    else {
      if (s.vcsStart) entry.prepared = describeStart(s.vcsStart);
      if (!repo.problem) entry.choice = defaultChoice(s, repo);
    }
    out.push(entry);
  }
  return { repos: [...repos.values()], sessions: out };
}

/** What choosing a start does to a session: its version control fields, and whether its recorded start goes. */
export type AppliedChoice = {
  /** The fields to set; `undefined` takes a field away. */
  vcs: Partial<VersionControl>;
  /** The start recorded so far (a starting snapshot made before the run) no longer applies. */
  clearStart: boolean;
  /** Said in the run's record: what was done to a local branch, or what was left as it was and why. */
  note?: string;
  /** In a sentence, for the record: where the work starts now. */
  said: string;
};

/**
 * Checks a choice against the repository and works out what it sets. Nothing is written to the session
 * here; for `remote` with `onBranch` the local branch is made, or moved forward, since that is the
 * choice — and only then, after everything else about it has been checked, and never with `dry`, which
 * only says whether it could be done (every session of a run is checked so before any branch moves).
 */
export async function applyStartChoice(
  session: Session,
  choice: StartChoice,
  opts: { dry?: boolean } = {},
): Promise<{ ok: true; applied?: AppliedChoice } | { ok: false; problem: string }> {
  // Nothing to choose without version control, or once the start is fixed: see `startIsFixed`.
  if (!session.vcs?.enabled || startIsFixed(session)) return { ok: true };
  const dir = repoDirOf(session);
  const before = pointOf(session.vcs);

  if (choice.from === 'previous-session') {
    const vcs: Partial<VersionControl> = { startFrom: 'previous-session' };
    return { ok: true, applied: { vcs, clearStart: changed(before, { ...session.vcs, ...vcs }) && !!session.vcsBaseCommit, said: `"${session.name}" carries on the session before it in this repository` } };
  }

  const name = choice.branch.trim();
  if (!name || !(await isValidBranchName(dir, name))) return { ok: false, problem: `"${choice.branch}" is not a branch name git accepts.` };

  if (choice.from === 'local') {
    const tip = (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`])).stdout;
    if (!tip) return { ok: false, problem: `${dir} has no local branch "${name}". Choose one it has, or the remote branch of that name.` };
    const vcs: Partial<VersionControl> = choice.onBranch
      ? { startFrom: 'existing-branch', existingBranch: name, baseRemote: undefined, updateFromRemote: false }
      : { startFrom: 'branch', baseBranch: name, baseRemote: undefined, existingBranch: undefined, updateFromRemote: false };
    return {
      ok: true,
      applied: {
        vcs,
        clearStart: changed(before, { ...session.vcs, ...vcs }) && !!session.vcsBaseCommit,
        said: choice.onBranch
          ? `"${session.name}" works on the local branch ${name} itself (${tip.slice(0, 8)}), as it is here`
          : `"${session.name}" starts from the local branch ${name} (${tip.slice(0, 8)}), as it is here`,
      },
    };
  }

  const remote = choice.remote.trim();
  const remotes = lines((await git(dir, ['remote'])).stdout);
  if (!remotes.includes(remote)) return { ok: false, problem: `${dir} has no remote called "${remote}"${remotes.length > 0 ? ` (it has: ${remotes.join(', ')})` : ''}.` };
  const theirs = await remoteTip(dir, remote, name);
  if (!theirs) return { ok: false, problem: `${remote}/${name} is not known here: it was not fetched. Start again, and it is fetched first.` };

  if (!choice.onBranch) {
    const vcs: Partial<VersionControl> = { startFrom: 'branch', baseBranch: name, baseRemote: remote, existingBranch: undefined, updateFromRemote: false };
    return {
      ok: true,
      applied: {
        vcs,
        clearStart: changed(before, { ...session.vcs, ...vcs }) && !!session.vcsBaseCommit,
        said: `"${session.name}" starts from the remote branch ${remote}/${name} (${theirs.slice(0, 8)}), as fetched now; the local branch ${name} is not touched`,
      },
    };
  }

  // Work on the branch itself: the local branch made from the remote one, or brought up to it.
  const ours = (await git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`])).stdout;
  let note: string;
  if (!ours) {
    // By its full name: `origin/x` alone is looked up among tags and local branches first.
    const made = opts.dry ? { ok: true, stdout: '', stderr: '' } : await git(dir, ['branch', '--track', name, `refs/remotes/${remote}/${name}`]);
    if (!made.ok) return { ok: false, problem: `the local branch ${name} could not be made from ${remote}/${name}: ${(made.stderr || made.stdout).split(/\r?\n/)[0]}` };
    note = `made the local branch ${name} from ${remote}/${name} (${theirs.slice(0, 8)})`;
  } else if (ours === theirs) {
    note = `the local branch ${name} is already where ${remote}/${name} is (${theirs.slice(0, 8)})`;
  } else if (await isAncestor(dir, ours, theirs)) {
    const current = (await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout;
    if (current === name) {
      const dirty = (await git(dir, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
      if (dirty) return { ok: false, problem: `${name} is checked out with uncommitted changes, so it cannot be brought up to ${remote}/${name}. Commit or stash them first; nothing was changed.` };
    }
    const moved = opts.dry
      ? { ok: true, stdout: '', stderr: '' }
      : current === name
        ? await git(dir, ['merge', '--ff-only', '--quiet', theirs])
        : await git(dir, ['update-ref', '-m', `copilot-operator: brought up to ${remote}/${name} in the start window`, `refs/heads/${name}`, theirs, ours]);
    if (!moved.ok) return { ok: false, problem: `${name} could not be brought up to ${remote}/${name}: ${(moved.stderr || moved.stdout).split(/\r?\n/)[0]}. Nothing else was changed.` };
    note = `brought the local branch ${name} up to ${remote}/${name}: ${ours.slice(0, 8)} → ${theirs.slice(0, 8)}, fast-forward`;
  } else if (await isAncestor(dir, theirs, ours)) {
    note = `the local branch ${name} has commits ${remote}/${name} does not; it was left as it is (${ours.slice(0, 8)}) and the work goes on top of them`;
  } else {
    return {
      ok: false,
      problem:
        `the local branch ${name} (${ours.slice(0, 8)}) and ${remote}/${name} (${theirs.slice(0, 8)}) have each gone their own way, so working on it would mean choosing one of them. ` +
        `Nothing was changed. Start from ${remote}/${name} on a new branch instead, or bring the two together yourself first.`,
    };
  }
  const vcs: Partial<VersionControl> = { startFrom: 'existing-branch', existingBranch: name, baseRemote: remote, updateFromRemote: false };
  return {
    ok: true,
    applied: {
      vcs,
      clearStart: changed(before, { ...session.vcs, ...vcs }) && !!session.vcsBaseCommit,
      note,
      said: `"${session.name}" works on the branch ${name} itself, from ${remote}/${name} as fetched now`,
    },
  };
}

/** Where a session's settings say it starts: the fields that decide the commit, nothing else. */
function pointOf(vcs: Partial<VersionControl> | undefined): string {
  return JSON.stringify([vcs?.startFrom ?? 'head', vcs?.baseBranch?.trim() || 'main', vcs?.baseRemote?.trim() ?? '', vcs?.existingBranch?.trim() ?? '']);
}

function changed(before: string, after: Partial<VersionControl>): boolean {
  return before !== pointOf(after);
}

/** The fields of an `AppliedChoice` written onto a session's version control: `undefined` removes one. */
export function withChoice(vcs: VersionControl, patch: Partial<VersionControl>): VersionControl {
  const out = { ...vcs } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as VersionControl;
}

/**
 * The refspecs that fetch exactly these branches of `remote` into their remote-tracking branches, or
 * why one of the names cannot be fetched.
 */
export async function refspecsFor(dir: string, remote: string, branches: string[]): Promise<{ refspecs: string[] } | { problem: string }> {
  const refspecs: string[] = [];
  for (const b of [...new Set(branches.map((x) => x.trim()).filter(Boolean))]) {
    if (!(await isValidBranchName(dir, b))) return { problem: `"${b}" is not a branch name git accepts.` };
    refspecs.push(`+refs/heads/${b}:refs/remotes/${remote}/${b}`);
  }
  return { refspecs };
}

/** The branch names a failed fetch said the remote does not have. */
export function missingOnRemote(detail: string): string[] {
  return [...detail.matchAll(/couldn't find remote ref (?:refs\/heads\/)?(\S+)/gi)].map((m) => m[1]!.replace(/[.,;:]+$/, ''));
}

/** Where git keeps the repository's records, for `lastFetchedAt`. */
export async function gitDirOf(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--absolute-git-dir']);
  return r.ok && r.stdout ? r.stdout : null;
}

/** How a fetch from the start window went, and the branches as they are after it. */
export type StartFetch = {
  ok: boolean;
  /** Why nothing was fetched at all: a remote that is not there, a name git does not accept. */
  problem?: string;
  fetched?: OperatorFetch;
  /** Branches asked for that the remote does not have. */
  missing: string[];
  /** The fetch for the operator's own PowerShell, when the bot's could not get through. */
  fetchCommand?: string;
  /** When the remote was last fetched here before this one, for "go on with what was last fetched". */
  lastFetched?: string;
  repo?: RepoBranches;
};

/**
 * Fetches `branches` of `remote` — or the whole remote, pruned, when none are named — for the start
 * window, where the operator is looking: through Git's password window when there is one (`askpass`).
 * Only remote-tracking branches move; no local branch, no checkout.
 */
export async function fetchForStart(dir: string, remote: string, branches: string[] | null, askpass: string | null): Promise<StartFetch> {
  const remotes = lines((await git(dir, ['remote'])).stdout);
  if (!remotes.includes(remote)) return { ok: false, problem: `${dir} has no remote called "${remote}"${remotes.length > 0 ? ` (it has: ${remotes.join(', ')})` : ''}.`, missing: [] };
  const specs = branches && branches.length > 0 ? await refspecsFor(dir, remote, branches) : { refspecs: [] as string[] };
  if ('problem' in specs) return { ok: false, problem: specs.problem, missing: [] };
  const gitDir = await gitDirOf(dir);
  // Read before fetching: a fetch that fails empties FETCH_HEAD, and with it the time of the last one that worked.
  const lastBefore = gitDir ? lastFetchedAt(gitDir) : undefined;
  const fetched = await fetchAsOperator(dir, remote, { askpass, refspecs: specs.refspecs });
  const missing = fetched.ok ? [] : missingOnRemote(fetched.detail ?? '');
  return {
    ok: fetched.ok,
    fetched,
    missing,
    ...(fetched.ok ? {} : { fetchCommand: fetchCommandFor(dir, remote), ...(lastBefore ? { lastFetched: lastBefore } : {}) }),
    repo: await repoBranches(dir),
  };
}
