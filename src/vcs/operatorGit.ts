/**
 * The operator's own git in the open folder, from the Git view (operator, 2026-11-11: "add committing and pushing; a
 * commit may not go through, and the operator must be able to see why"): files staged and unstaged, a commit, a push.
 *
 * On the real git, as the operator's terminal or VS Code would run it — no git rewritten in JavaScript, which has no
 * hooks, no SSH and no credential manager — so the operator's name, their signing, their credential manager and the
 * project's hooks all work as they do there. What git prints is the operator's to read, all of it: the view follows
 * it as it comes, and a commit or push that did not go through says why in a sentence too (`GitCause`), with git's own
 * words under it.
 *
 * The project's hooks (operator, 2026-11-11: "yes, unless a hook was changed"): every other git of the bot runs with
 * hooks pointed at nowhere (`SAFE_GIT`), since a hook is code in the repository and the chat's steps write in it. A
 * commit and a push of the operator's run them, as git would — pre-commit and commit-msg checks, Git LFS's pre-push —
 * once each hook file that would run is found to be the project's own (`hooksFor`): outside the project's folder (in
 * `.git`, where the chat may not write, or a hooks folder of the operator's elsewhere), or committed, unchanged since,
 * and not last committed by the bot. Any other — not committed, changed since its commit, committed by the bot — is
 * named to the operator with why, and nothing runs until they say: without the hooks, run them all the same (remembered
 * for that file as it is now, `TrustedHooks`), or not at all.
 *
 * Nothing is forced and nothing is rewritten: no `--force`, no `--amend`, no reset. A push goes to the branch's
 * upstream, or publishes the branch on the remote under its own name when it has none.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { git, gitLive, RUNNER_EMAIL } from './git.js';
import { askpassProgram, closePasswordWindows, operatorFetchEnv, passwordWindowOpen } from './remoteAuth.js';
import { workspaceGit } from '../session/workspaceGit.js';
import { readStoreJson, writeFileAtomically } from '../session/store.js';

/** Why a hook file that would run is not taken as the project's own. */
export type HookWhy = 'not-committed' | 'changed' | 'by-bot';

/** A hook file that would run and is not the project's own: where it is, why, and its content's hash as it is now. */
export type FlaggedHook = { path: string; why: HookWhy; sha: string };

/** What git would run for a commit or a push: the hooks folder, the hook files in it that would run, and those not the project's own. */
export type HookCheck = { dir: string | null; run: string[]; flagged: FlaggedHook[] };

/** Why a commit or a push did not go through, as far as git's words say it. */
export type GitCause =
  | 'message'
  | 'nothing'
  | 'identity'
  | 'unmerged'
  | 'lock'
  | 'signing'
  | 'hook'
  | 'detached'
  | 'no-remote'
  | 'behind'
  | 'auth'
  | 'refused'
  | 'network'
  | 'timeout'
  | 'unknown';

/** A commit or a push of the operator's, as the Git view follows it. */
export type GitOp = {
  id: string;
  kind: 'commit' | 'push';
  /** `hooks`: waiting for the operator to say what to do about hooks that are not the project's own. */
  state: 'running' | 'done' | 'failed' | 'hooks';
  startedAt: string;
  endedAt?: string;
  /** What ran, as it would be typed. */
  command: string;
  /** git's own output, stdout and stderr together; the last part of it when it was very long (`cut`). */
  output: string;
  cut?: boolean;
  /** Whether the project's hooks ran: `none` when there were none to run, or nothing ran yet. */
  hooks: 'run' | 'skipped' | 'none';
  flagged?: FlaggedHook[];
  cause?: GitCause;
  /** The branch it was on, and for a commit the commit made. */
  branch?: string;
  commit?: string;
  /** A push: where to (`origin/feature`), whether the branch was published there, whether there was nothing to push. */
  target?: string;
  published?: boolean;
  upToDate?: boolean;
  /** Git's password window is open, waiting for the operator. */
  passwordWindow?: boolean;
  /** A commit's request, to make it again from the hooks card. */
  message?: string;
  all?: boolean;
};

/** What the operator asked for about hooks: as found (`auto`), none of them (`skip`), or these ones run although flagged. */
export type HookChoice = { hooks?: 'auto' | 'skip'; trust?: Array<{ path: string; sha: string }> };

const MINUTES = 60_000;
/** Long enough for a project's pre-commit checks or a big push; the view shows every line meanwhile. */
const OP_TIMEOUT_MS = 15 * MINUTES;

/** The hooks a commit may run, and a push. Git runs a hook only by its exact name. */
const COMMIT_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'reference-transaction', 'post-index-change'];
const PUSH_HOOKS = ['pre-push', 'reference-transaction'];
/** Every name git runs a hook by (githooks(5)): a file of another name in the folder is a helper the hooks may read. */
const HOOK_NAMES = new Set([
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit',
  'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update',
  'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'post-index-change',
]);

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const sha256 = (p: string): string => {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex');
  } catch {
    return '';
  }
};
const slash = (p: string): string => p.replace(/\\/g, '/');
/** A repository as a key: its top folder, absolute, forward slashes, case folded as Windows does. */
const repoKey = (top: string): string => slash(resolve(top)).replace(/\/+$/, '').toLowerCase();

/**
 * The hook files the operator said to run although they were not the project's own, each as it was then (its hash):
 * a file changed since is asked about again. Kept in the bot's records, one list per repository.
 */
export class TrustedHooks {
  constructor(private readonly file: string) {}

  /** As kept; one there but not readable is refused (2026-11-19), so an addition never writes the others over. */
  private async read(): Promise<Record<string, Record<string, string>>> {
    const data = await readStoreJson<unknown>(this.file);
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, Record<string, string>>) : {};
  }

  /** Not readable: not trusted, so the hook is asked about again. */
  async has(top: string, path: string, sha: string): Promise<boolean> {
    return !!sha && (await this.read().catch(() => ({}) as Record<string, Record<string, string>>))[repoKey(top)]?.[path] === sha;
  }

  async add(top: string, hooks: FlaggedHook[]): Promise<void> {
    if (hooks.length === 0) return;
    const all = await this.read();
    const mine = { ...(all[repoKey(top)] ?? {}) };
    for (const h of hooks) mine[h.path] = h.sha;
    all[repoKey(top)] = mine;
    await mkdir(dirname(this.file), { recursive: true });
    // Through a temporary file and a rename, retried as Windows needs (2026-11-19): written in place, a crash left it cut.
    await writeFileAtomically(this.file, `${JSON.stringify(all, null, 2)}\n`);
  }
}

/** The repository's top folder, or null when the folder is not in one. */
async function topOf(dir: string): Promise<string | null> {
  if (!dir || !existsSync(dir)) return null;
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') return null;
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  return top.ok && top.stdout ? resolve(top.stdout) : null;
}

/** Why a hook file is not the project's own, or null when it is (see the head of this file). */
async function notOwn(top: string, full: string): Promise<HookWhy | null> {
  const rel = relative(top, full);
  // Outside the project's folder: where the operator keeps hooks, which the chat's steps do not reach.
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const path = slash(rel);
  // In `.git`: the chat's steps may not write there (`repositoryInternalsRefusal`).
  if (path === '.git' || path.startsWith('.git/')) return null;
  if (!(await git(top, ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', path])).ok) return 'not-committed';
  const diff = await git(top, ['--literal-pathspecs', 'diff', '--quiet', 'HEAD', '--', path]);
  if (diff.code === 1 || !diff.ok) return 'changed';
  const last = await git(top, ['--literal-pathspecs', 'log', '-1', '--format=%ae', '--', path]);
  if (last.stdout.trim().toLowerCase() === RUNNER_EMAIL) return 'by-bot';
  return null;
}

/**
 * The hooks a commit or a push would run in this repository, and those of them that are not the project's own. The
 * hooks folder is git's own answer, `core.hooksPath` included (read without the bot's own setting over it); with a
 * hook in it, the other files there are taken in too, as a hook may read them (husky's `h`), and for a folder named
 * `_` — husky's — the hook of the same name in the folder above, which husky's runs.
 */
export async function hooksFor(dir: string, kind: 'commit' | 'push'): Promise<HookCheck> {
  const top = (await topOf(dir)) ?? dir;
  const where = await git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], 30_000, undefined, { ownHooks: true });
  const hooksDir = where.ok && where.stdout ? resolve(where.stdout) : null;
  if (!hooksDir || !existsSync(hooksDir)) return { dir: hooksDir, run: [], flagged: [] };
  const names = kind === 'commit' ? COMMIT_HOOKS : PUSH_HOOKS;
  const hooks = names.map((n) => join(hooksDir, n)).filter(isFile);
  if (hooks.length === 0) return { dir: hooksDir, run: [], flagged: [] };
  const files = new Set(hooks);
  let entries: string[] = [];
  try {
    entries = readdirSync(hooksDir);
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (e.startsWith('.') || e.endsWith('.sample') || HOOK_NAMES.has(e)) continue;
    if (isFile(join(hooksDir, e))) files.add(join(hooksDir, e));
  }
  if (basename(hooksDir) === '_') {
    for (const h of hooks) {
      const above = join(dirname(hooksDir), basename(h));
      if (isFile(above)) files.add(above);
    }
  }
  const flagged: FlaggedHook[] = [];
  for (const full of files) {
    const why = await notOwn(top, full);
    if (!why) continue;
    const rel = relative(top, full);
    flagged.push({ path: rel && !rel.startsWith('..') && !isAbsolute(rel) ? slash(rel) : slash(full), why, sha: sha256(full) });
  }
  flagged.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { dir: hooksDir, run: hooks.map((h) => slash(relative(top, h).startsWith('..') ? h : relative(top, h))), flagged };
}

/**
 * The hooks as the operator chose: those flagged and neither remembered nor chosen now are what the operator is asked
 * about. A choice to run them counts for a file only as it was shown (its hash then), and is remembered so.
 */
async function decideHooks(top: string, kind: 'commit' | 'push', choice: HookChoice, trusted: TrustedHooks): Promise<{ run: boolean; ask: FlaggedHook[] }> {
  if (choice.hooks === 'skip') return { run: false, ask: [] };
  const found = await hooksFor(top, kind);
  if (found.run.length === 0) return { run: false, ask: [] };
  const ask: FlaggedHook[] = [];
  const chosen: FlaggedHook[] = [];
  for (const f of found.flagged) {
    if (await trusted.has(top, f.path, f.sha)) continue;
    if (choice.trust?.some((t) => t.path === f.path && t.sha === f.sha)) chosen.push(f);
    else ask.push(f);
  }
  if (ask.length > 0) return { run: false, ask };
  await trusted.add(top, chosen);
  return { run: true, ask: [] };
}

/** The first lines of a message, as a command line shows it. */
function quoted(message: string): string {
  const first = message.trim().split(/\r?\n/)[0] ?? '';
  const shown = first.length > 72 ? `${first.slice(0, 71)}…` : first;
  return `"${shown.replace(/"/g, '\\"')}"${message.trim().includes('\n') ? ' …' : ''}`;
}

/** Why a commit did not go through, from what git and the hooks said. */
export function commitCause(output: string, hooksRan: boolean, timedOut: boolean): GitCause {
  if (timedOut) return 'timeout';
  if (/please tell me who you are|author identity unknown|unable to auto-detect email address|empty ident name|committer identity unknown|no (name|email) was given and auto-detection is disabled/i.test(output)) return 'identity';
  if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(output)) return 'nothing';
  if (/aborting commit due to empty commit message/i.test(output)) return 'message';
  if (/unmerged files|resolve your current index first|fix conflicts and then commit|you have not concluded your merge/i.test(output)) return 'unmerged';
  if (/index\.lock'?:? file exists|unable to create '.*\.lock'|another git process seems to be running/i.test(output)) return 'lock';
  if (/gpg failed to sign|failed to sign the data|error: gpg|signing failed|ssh-keygen.*sign|couldn't load public key|error: load key/i.test(output)) return 'signing';
  if (hooksRan) return 'hook';
  return 'unknown';
}

/** Why a push did not go through. */
export function pushCause(output: string, hooksRan: boolean, timedOut: boolean): GitCause {
  if (timedOut) return 'timeout';
  if (/\[rejected\][^\n]*\((fetch first|non-fast-forward)\)|updates were rejected because the (remote contains work|tip of your current branch is behind)/i.test(output)) return 'behind';
  if (/authentication failed|could not read (username|password)|permission denied \(publickey|access denied|terminal prompts disabled|invalid username or password|the requested url returned error: 40[13]|host key verification failed|repository not found/i.test(output)) return 'auth';
  if (/\[remote rejected\]|pre-receive hook declined|protected branch|GH0\d\d|push declined|denied to|remote: error/i.test(output)) return 'refused';
  if (/could not resolve host|unable to access|failed to connect|connection (timed out|refused|reset)|network is unreachable|could not read from remote repository|the remote end hung up/i.test(output)) return 'network';
  if (hooksRan) return 'hook';
  return 'unknown';
}

/** The update a commit or push makes to its `GitOp`, as it goes and when it ends. */
export type OpUpdate = (patch: Partial<GitOp>) => void;

/**
 * The operator's commit: the staged changes — or, with `all`, every change and new file, staged first — under the
 * operator's own git name, with the message as written. The project's hooks run as `decideHooks` says; when some of
 * them are not the project's own, nothing is staged or committed and the operator is asked (`state: 'hooks'`).
 */
export async function commitAsOperator(dir: string, req: { message: string; all?: boolean } & HookChoice, trusted: TrustedHooks, update: OpUpdate): Promise<void> {
  const message = req.message.replace(/\r\n/g, '\n').trim();
  const end = (patch: Partial<GitOp>): void => update({ endedAt: new Date().toISOString(), ...patch });
  if (!message) return end({ state: 'failed', cause: 'message' });
  const top = await topOf(dir);
  if (!top) return end({ state: 'failed', cause: 'unknown', output: `${dir} is not a git repository.\n` });
  const branch = (await git(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout || undefined;
  update({ ...(branch ? { branch } : {}) });

  const head = (await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok;
  const staged = await git(top, ['diff', '--cached', '--name-only', head ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904']);
  const anyStaged = staged.ok && staged.stdout.trim() !== '';
  if (!anyStaged && !req.all) return end({ state: 'failed', cause: 'nothing' });
  if (!anyStaged) {
    const changed = await git(top, ['status', '--porcelain', '--untracked-files=all']);
    if (!changed.stdout.trim()) return end({ state: 'failed', cause: 'nothing' });
  }

  const hooks = await decideHooks(top, 'commit', req, trusted);
  if (hooks.ask.length > 0) return end({ state: 'hooks', flagged: hooks.ask, hooks: 'none' });

  let output = '';
  if (req.all) {
    const added = await git(top, ['add', '-A', '--', '.'], 5 * MINUTES);
    output = [added.stdout, added.stderr].filter(Boolean).join('\n');
    if (!added.ok) return end({ state: 'failed', cause: commitCause(output, false, false), output: `${output || 'git add failed'}\n` });
    if (output) output += '\n';
  }
  const command = `git ${req.all ? 'add -A && git ' : ''}commit -m ${quoted(message)}`;
  update({ command, hooks: hooks.run ? 'run' : req.hooks === 'skip' ? 'skipped' : 'none', output });
  const ran = await gitLive(top, ['commit', '-m', message], {
    ownHooks: hooks.run,
    timeoutMs: OP_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    onOutput: (o, cut) => update({ output: output + o, ...(cut ? { cut } : {}) }),
  });
  const all = output + ran.output;
  if (!ran.ok) return end({ state: 'failed', cause: commitCause(all, hooks.run, ran.timedOut), output: all });
  const made = (await git(top, ['rev-parse', 'HEAD'])).stdout;
  end({ state: 'done', output: all, ...(made ? { commit: made } : {}) });
}

/**
 * The operator's push of the branch the folder is on: to its upstream, or — a branch that has none — published on the
 * remote (`origin`, else the only one) under its own name and followed from then on. With Git's own password window
 * when the remote asks (`remoteAuth.ts`), which the bot never reads; the view says while it is open. Never forced.
 */
export async function pushAsOperator(
  dir: string,
  req: HookChoice,
  trusted: TrustedHooks,
  update: OpUpdate,
  /** Git's password window; looked for next to git when not given. null: none, as a check that pops no window gives. */
  askpassGiven?: string | null,
): Promise<void> {
  const end = (patch: Partial<GitOp>): void => update({ endedAt: new Date().toISOString(), ...patch });
  const top = await topOf(dir);
  if (!top) return end({ state: 'failed', cause: 'unknown', output: `${dir} is not a git repository.\n` });
  const branch = (await git(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout;
  if (!branch) return end({ state: 'failed', cause: 'detached' });
  update({ branch });
  let remote = (await git(top, ['config', '--get', `branch.${branch}.remote`])).stdout.trim();
  const merge = (await git(top, ['config', '--get', `branch.${branch}.merge`])).stdout.trim();
  let target = merge.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : '';
  let publish = false;
  if (!remote || remote === '.' || !target) {
    const remotes = (await git(top, ['remote'])).stdout.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
    remote = remotes.includes('origin') ? 'origin' : (remotes[0] ?? '');
    if (!remote) return end({ state: 'failed', cause: 'no-remote' });
    target = branch;
    publish = true;
  }
  update({ target: `${remote}/${target}`, published: publish });

  const hooks = await decideHooks(top, 'push', req, trusted);
  if (hooks.ask.length > 0) return end({ state: 'hooks', flagged: hooks.ask, hooks: 'none' });

  const askpass = askpassGiven === undefined ? await askpassProgram() : askpassGiven;
  const env = askpass ? operatorFetchEnv(askpass) : { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'auto' };
  const args = ['push', ...(publish ? ['--set-upstream'] : []), remote, `HEAD:refs/heads/${target}`];
  update({ command: `git ${args.join(' ')}`, hooks: hooks.run ? 'run' : req.hooks === 'skip' ? 'skipped' : 'none' });
  const started = new Date(Date.now() - 1000);
  let watching = !!askpass && process.platform === 'win32';
  const watch = async (): Promise<void> => {
    while (watching) {
      await new Promise((r) => setTimeout(r, 2_000));
      if (!watching) break;
      const open = await passwordWindowOpen(started.getTime()).catch(() => false);
      if (watching) update({ passwordWindow: open });
    }
  };
  void watch();
  const ran = await gitLive(top, args, {
    ownHooks: hooks.run,
    timeoutMs: OP_TIMEOUT_MS,
    env,
    windowsHide: !askpass,
    onOutput: (o, cut) => update({ output: o, ...(cut ? { cut } : {}) }),
  });
  watching = false;
  if (ran.timedOut && askpass) await closePasswordWindows(askpass, started).catch(() => 0);
  if (!ran.ok) return end({ state: 'failed', cause: pushCause(ran.output, hooks.run, ran.timedOut), output: ran.output, passwordWindow: false });
  end({ state: 'done', output: ran.output, passwordWindow: false, upToDate: /everything up-to-date/i.test(ran.output) });
}

/**
 * Files staged (`stage`) or taken back out of the index (`unstage`), as the Git view lists them: each named one must be
 * one of the list it is in — a change for staging, a staged change for unstaging — so nothing else of the repository
 * is reached; `all` takes the whole list. Nothing in the working tree is changed either way.
 */
export async function stageFiles(dir: string, how: 'stage' | 'unstage', which: string[] | 'all'): Promise<void> {
  const top = await topOf(dir);
  if (!top) throw new Error('The project folder is not a git repository.');
  const state = await workspaceGit(dir);
  const list = how === 'stage' ? state.changes : state.staged;
  // The untracked ones are named from the folder, the rest from the repository's top: all from the top here.
  const fromTop = (f: { path: string; status: string }): string => (f.status === 'U' ? slash(relative(top, resolve(dir, f.path))) : f.path);
  const chosen = which === 'all' ? list : list.filter((f) => which.includes(f.path));
  if (which !== 'all') {
    const unknown = which.filter((p) => !list.some((f) => f.path === p));
    if (unknown.length > 0) throw new Error(`${how === 'stage' ? 'Not a change of the folder' : 'Not a staged change'}: ${unknown.slice(0, 3).join(', ')}. Read the folder again.`);
  }
  const paths = [...new Set(chosen.flatMap((f) => [fromTop(f), ...(f.oldPath ? [f.oldPath] : [])]))];
  if (paths.length === 0) return;
  const head = (await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok;
  for (let i = 0; i < paths.length; i += 100) {
    const some = paths.slice(i, i + 100);
    const args =
      how === 'stage'
        ? ['--literal-pathspecs', 'add', '-A', '--', ...some]
        : head
          ? ['--literal-pathspecs', 'restore', '--staged', '--', ...some]
          : ['--literal-pathspecs', 'rm', '--cached', '-r', '-q', '--', ...some];
    const r = await git(top, args, 5 * MINUTES);
    if (!r.ok) throw new Error(`git ${args[1]} did not go through: ${(r.stderr || r.stdout).split(/\r?\n/).slice(0, 3).join(' ')}`);
  }
}

/** The operator's name and e-mail for git, in this repository or for all of theirs (`global`): what a first commit asks for. */
export async function setIdentity(dir: string, input: { name: string; email: string; global?: boolean }): Promise<void> {
  const top = await topOf(dir);
  if (!top) throw new Error('The project folder is not a git repository.');
  const name = input.name.trim();
  const email = input.email.trim();
  if (!name || name.length > 200 || /[\r\n<>]/.test(name)) throw new Error('Write your name as git should put it on a commit.');
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(email) || email.length > 200) throw new Error('Write an e-mail address, as name@example.com.');
  for (const [key, value] of [['user.name', name], ['user.email', email]] as const) {
    const r = await git(top, ['config', ...(input.global ? ['--global'] : ['--local']), key, value]);
    if (!r.ok) throw new Error(`git config ${key} did not go through: ${r.stderr || r.stdout}`);
  }
}

/** The operator's name and e-mail as git has them for this repository, and where from; empty when git has none. */
export async function identityOf(dir: string): Promise<{ name: string; email: string }> {
  const top = (await topOf(dir)) ?? dir;
  return { name: (await git(top, ['config', 'user.name'])).stdout.trim(), email: (await git(top, ['config', 'user.email'])).stdout.trim() };
}
