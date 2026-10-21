/**
 * Projects for reference only (operator, 2026-10-21): "a checkbox on each project in Settings — whether it may be
 * developed in, or is only for reference. Marked for reference, nothing may be changed there while the bot works."
 *
 * The rule is held after the fact rather than guessed at before it. What a command will write cannot be read off
 * its text — a build, a test run, an install, a git command, a program the project starts — but what it wrote can
 * be seen. So when a task begins each project for reference is photographed: its files as they stand (every one
 * git does not ignore, untracked ones too), its branches, tags and stash, where HEAD points, and what is staged.
 * After every step it is photographed again; whatever differs is put back as it was, and the chat is told.
 *
 * The photograph leaves nothing in the project. It is a repository of its own in a temporary folder whose work
 * tree is the project's (`GIT_DIR` there, `GIT_WORK_TREE` here), storing every file as its exact bytes — no line
 * ending or filter conversion — so a file put back is the file that was there. The project's own repository is
 * only read (`rev-parse`, `for-each-ref`, `ls-files`, with optional locks off) until something must be put back;
 * then its refs, HEAD and index are written back as they were. A folder that is not a repository is photographed
 * all the same, without the git part.
 *
 * Not seen, and said so: files git ignores — node_modules, build output, a `.env` listed in .gitignore.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git, type GitResult } from './git.js';

export type ReferenceProject = { name: string; dir: string };

/** What a step changed in a project for reference, and whether it was put back. */
export type ReferenceChange = {
  name: string;
  dir: string;
  /** Files, by their path in the project, with how they changed: `added`, `changed`, `removed`. */
  files: Array<{ path: string; how: 'added' | 'changed' | 'removed' }>;
  /** The repository's own state: a branch moved, a new one, HEAD elsewhere, something staged. */
  git: string[];
  putBack: boolean;
  problem?: string;
};

type State = { tree: string; head: string; symbolic: string; refs: Map<string, string>; staged: string };

/** How a step's change is said in a line: the files first, then the repository. */
export function describeChange(c: ReferenceChange, max = 12): string {
  const files = c.files.slice(0, max).map((f) => `${f.path} (${f.how})`);
  const more = c.files.length > max ? [`and ${c.files.length - max} more`] : [];
  return [...files, ...more, ...c.git].join(', ') || 'nothing that can be named';
}

/** One project for reference: its photograph's repository, its index, and how it was when the task began. */
class Watched {
  private start: State | null = null;

  private constructor(
    readonly project: ReferenceProject,
    private readonly photoDir: string,
    private readonly ownIndex: string,
    private readonly sharedIndex: string,
    private readonly repo: { indexPath: string; indexBytes: Buffer | null } | null,
  ) {}

  /** The photograph's repository, kept across tasks in the temporary folder so a photograph after the first is quick. */
  static async open(project: ReferenceProject, runId: string): Promise<Watched | { problem: string }> {
    const dir = resolve(project.dir);
    if (!existsSync(dir)) return { problem: `${dir} does not exist` };
    const key = createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 16);
    const photoDir = join(tmpdir(), 'copilot-operator-reference', key);
    const gitDir = join(photoDir, '.git');
    if (!existsSync(gitDir)) {
      await mkdir(photoDir, { recursive: true });
      const init = await git(photoDir, ['init', '-q']);
      if (!init.ok) return { problem: `git could not prepare the photograph: ${init.stderr}` };
    }
    // Every file as its bytes: nothing converted on the way in, so nothing converted on the way back.
    for (const [k, v] of [['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['core.longpaths', 'true'], ['core.quotepath', 'false'], ['gc.auto', '0']]) {
      await git(photoDir, ['config', k!, v!]);
    }
    await mkdir(join(gitDir, 'info'), { recursive: true });
    await writeFile(join(gitDir, 'info', 'attributes'), '* -text -filter -ident -working-tree-encoding\n', 'utf8');
    // Its own index for this task, from the shared one, so two tasks watching one project do not share a lock.
    const sharedIndex = join(gitDir, 'index');
    const ownIndex = join(gitDir, `index-${runId.replace(/[^\w-]/g, '_')}`);
    if (existsSync(sharedIndex)) await copyFile(sharedIndex, ownIndex).catch(() => undefined);

    let repo: { indexPath: string; indexBytes: Buffer | null } | null = null;
    const top = await git(dir, ['rev-parse', '--show-toplevel']);
    if (top.ok && top.stdout && resolve(top.stdout).toLowerCase() === dir.toLowerCase()) {
      const indexPath = resolve(dir, (await git(dir, ['rev-parse', '--git-path', 'index'])).stdout || '.git/index');
      repo = { indexPath, indexBytes: existsSync(indexPath) ? await readFile(indexPath) : null };
    }
    const w = new Watched({ name: project.name, dir }, photoDir, ownIndex, sharedIndex, repo);
    const first = await w.capture();
    if ('problem' in first) return first;
    w.start = first;
    return w;
  }

  /** The photograph's git: its repository, the project as its work tree, this task's index. */
  private photo(args: string[], index = this.ownIndex): Promise<GitResult> {
    const env = { ...process.env, GIT_DIR: join(this.photoDir, '.git'), GIT_WORK_TREE: this.project.dir, GIT_INDEX_FILE: index };
    return git(this.project.dir, args, 300_000, env);
  }

  private async capture(): Promise<State | { problem: string }> {
    const add = await this.photo(['add', '-A', '--', '.']);
    if (!add.ok) return { problem: `the folder could not be read: ${add.stderr.split('\n')[0]}` };
    const tree = await this.photo(['write-tree']);
    if (!tree.ok) return { problem: `the folder could not be recorded: ${tree.stderr.split('\n')[0]}` };
    if (!this.repo) return { tree: tree.stdout, head: '', symbolic: '', refs: new Map(), staged: '' };
    const dir = this.project.dir;
    const [head, symbolic, refs, staged] = await Promise.all([
      git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']),
      git(dir, ['symbolic-ref', '--quiet', 'HEAD']),
      git(dir, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags', 'refs/stash']),
      git(dir, ['ls-files', '--stage']),
    ]);
    const map = new Map<string, string>();
    for (const line of refs.stdout.split('\n')) {
      const [sha, ref] = line.trim().split(' ');
      if (sha && ref) map.set(ref, sha);
    }
    return {
      tree: tree.stdout,
      head: head.ok ? head.stdout : '',
      symbolic: symbolic.ok ? symbolic.stdout : '',
      refs: map,
      // Only what is staged, not the stat data a `git status` refreshes.
      staged: createHash('sha1').update(staged.stdout).digest('hex'),
    };
  }

  /** What changed since the task began: files, then the repository. Empty when nothing did. */
  private async differences(now: State): Promise<Pick<ReferenceChange, 'files' | 'git'>> {
    const start = this.start!;
    const files: ReferenceChange['files'] = [];
    if (now.tree !== start.tree) {
      const diff = await this.photo(['diff-tree', '-r', '--no-renames', '--name-status', start.tree, now.tree]);
      for (const line of diff.stdout.split('\n')) {
        const m = /^([AMDT])\t(.+)$/.exec(line.trim());
        if (m) files.push({ path: m[2]!, how: m[1] === 'A' ? 'added' : m[1] === 'D' ? 'removed' : 'changed' });
      }
    }
    const gitChanges: string[] = [];
    if (this.repo) {
      if (now.symbolic !== start.symbolic) gitChanges.push(`HEAD moved from ${short(start.symbolic) || start.head.slice(0, 8)} to ${short(now.symbolic) || now.head.slice(0, 8)}`);
      else if (!start.symbolic && now.head !== start.head) gitChanges.push(`HEAD moved from ${start.head.slice(0, 8)} to ${now.head.slice(0, 8)}`);
      for (const [ref, sha] of now.refs) {
        if (!start.refs.has(ref)) gitChanges.push(`${short(ref)} made`);
        else if (start.refs.get(ref) !== sha) gitChanges.push(`${short(ref)} moved`);
      }
      for (const ref of start.refs.keys()) if (!now.refs.has(ref)) gitChanges.push(`${short(ref)} deleted`);
      if (now.staged !== start.staged) gitChanges.push('what is staged');
    }
    return { files, git: gitChanges };
  }

  /** After a step: what it changed, put back as it was. Null when it changed nothing. */
  async check(): Promise<ReferenceChange | null> {
    const now = await this.capture();
    if ('problem' in now) return { ...this.project, files: [], git: [], putBack: false, problem: now.problem };
    const found = await this.differences(now);
    if (found.files.length === 0 && found.git.length === 0) return null;
    const problem = await this.putBack(found.files, now);
    const after = await this.capture();
    const still = 'problem' in after ? null : await this.differences(after);
    const left = still ? still.files.length + still.git.length : 1;
    return {
      ...this.project,
      ...found,
      putBack: !problem && left === 0,
      ...(problem || left > 0 ? { problem: problem ?? `${left} change(s) could not be put back${still ? `: ${describeChange({ ...this.project, ...still, putBack: false })}` : ''}` } : {}),
    };
  }

  private async putBack(files: ReferenceChange['files'], now: State): Promise<string | null> {
    const start = this.start!;
    const dir = this.project.dir;
    const problems: string[] = [];
    if (this.repo) {
      // Branches, tags and the stash as they were; then HEAD; then what was staged, byte for byte.
      for (const ref of now.refs.keys()) if (!start.refs.has(ref)) await note(problems, git(dir, ['update-ref', '-d', ref]), `${short(ref)} could not be deleted`);
      for (const [ref, sha] of start.refs) if (now.refs.get(ref) !== sha) await note(problems, git(dir, ['update-ref', ref, sha]), `${short(ref)} could not be put back`);
      if (start.symbolic && now.symbolic !== start.symbolic) await note(problems, git(dir, ['symbolic-ref', 'HEAD', start.symbolic]), 'HEAD could not be put back');
      if (!start.symbolic && start.head && (now.symbolic || now.head !== start.head)) await note(problems, git(dir, ['update-ref', '--no-deref', 'HEAD', start.head]), 'HEAD could not be put back');
      if (now.staged !== start.staged) {
        try {
          if (this.repo.indexBytes) await writeFile(this.repo.indexPath, this.repo.indexBytes);
          else await unlink(this.repo.indexPath).catch(() => undefined);
        } catch (e) {
          problems.push(`what was staged could not be put back: ${(e as Error).message}`);
        }
      }
    }
    // Files the step made go; files it changed or removed come back from the photograph, as their bytes.
    for (const f of files.filter((x) => x.how === 'added')) {
      await rm(join(dir, f.path), { force: true }).catch((e: unknown) => problems.push(`${f.path} could not be removed: ${(e as Error).message}`));
    }
    const back = files.filter((x) => x.how !== 'added').map((x) => x.path);
    if (back.length > 0) {
      const restoreIndex = join(this.photoDir, '.git', `restore-${process.pid}`);
      const read = await this.photo(['read-tree', start.tree], restoreIndex);
      if (!read.ok) problems.push(`the files could not be read back: ${read.stderr.split('\n')[0]}`);
      else {
        for (let i = 0; i < back.length; i += 100) {
          await note(problems, this.photo(['checkout-index', '-f', '--', ...back.slice(i, i + 100)], restoreIndex), 'files could not be put back');
        }
      }
      await rm(restoreIndex, { force: true }).catch(() => undefined);
    }
    return problems.length > 0 ? problems.join('; ') : null;
  }

  /** Keeps this task's index as the shared one, so the next task's first photograph is quick, and lets go of it. */
  async close(): Promise<void> {
    await copyFile(this.ownIndex, this.sharedIndex).catch(() => undefined);
    await rm(this.ownIndex, { force: true }).catch(() => undefined);
  }
}

const short = (ref: string): string => ref.replace(/^refs\/(heads|tags)\//, '').replace(/^refs\/stash$/, 'the stash');

async function note(problems: string[], r: Promise<GitResult>, what: string): Promise<void> {
  const res = await r;
  if (!res.ok) problems.push(`${what}: ${(res.stderr || res.stdout).split('\n')[0]}`);
}

/**
 * Every project for reference a task can reach, watched for the length of the task. `unwatched` are the ones that
 * could not be photographed, with why — the chat is still told to leave them alone.
 */
export class ReferenceGuard {
  private constructor(
    private readonly watched: Watched[],
    readonly unwatched: Array<ReferenceProject & { problem: string }>,
  ) {}

  static async start(projects: ReferenceProject[], runId: string): Promise<ReferenceGuard> {
    const watched: Watched[] = [];
    const unwatched: Array<ReferenceProject & { problem: string }> = [];
    for (const p of projects) {
      const w = await Watched.open(p, runId).catch((e: unknown) => ({ problem: (e as Error).message }));
      if ('problem' in w) unwatched.push({ ...p, problem: w.problem });
      else watched.push(w);
    }
    return new ReferenceGuard(watched, unwatched);
  }

  get active(): boolean {
    return this.watched.length > 0;
  }

  get projects(): ReferenceProject[] {
    return this.watched.map((w) => w.project);
  }

  /** After a step: each project's changes, put back. Empty when the step changed nothing in any of them. */
  async check(): Promise<ReferenceChange[]> {
    const out: ReferenceChange[] = [];
    for (const w of this.watched) {
      const c = await w.check().catch((e: unknown): ReferenceChange => ({ ...w.project, files: [], git: [], putBack: false, problem: (e as Error).message }));
      if (c) out.push(c);
    }
    return out;
  }

  async close(): Promise<void> {
    for (const w of this.watched) await w.close();
  }
}

/** What the chat is told about the projects for reference, before it starts. Empty when there are none. */
export function referenceNote(projects: ReferenceProject[], workDir: string): string {
  if (projects.length === 0) return '';
  const here = projects.some((p) => resolve(p.dir).toLowerCase() === resolve(workDir).toLowerCase());
  return [
    '## Projects for reference only',
    '',
    'The operator marked these for reference only: read them, run what only reads, and change nothing in them — no',
    'file written, moved or removed, nothing installed or built into them, no git command that changes something.',
    'After every step the runner compares them with how they were when this task began, puts back whatever changed,',
    'and does not run the rest of that round.',
    ...(here ? ['', 'The folder you work in is one of them: this task can only read, run what reads, and report.'] : []),
    '',
    ...projects.map((p) => `- ${p.name}: ${p.dir}`),
  ].join('\n');
}

/** What the chat is told after a step changed a project for reference. */
export function referenceMessage(changes: ReferenceChange[]): string {
  return changes
    .map((c) =>
      c.putBack
        ? `The last step changed ${c.name} (${c.dir}), which is for reference only: ${describeChange(c)}. The runner put it back as it was and did not run the rest of the round. Change nothing there; if the work needs a change in it, say so in "notes".`
        : `The last step changed ${c.name} (${c.dir}), which is for reference only: ${describeChange(c)}. The runner could not put all of it back (${c.problem ?? 'no reason given'}); the operator has been told. Change nothing there.`,
    )
    .join('\n\n');
}
