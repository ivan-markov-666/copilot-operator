/**
 * Where sessions, level-2 presets and the level-1 contract live on disk.
 *
 * JSON files, not a database. A single operator on one machine gets nothing from a
 * database except a dependency, and files can be read, diffed and backed up with nothing
 * installed. Writes go through a temp file and a rename, so a crash mid-write cannot leave a
 * half-written session behind.
 */
import { mkdir, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  Session,
  Task,
  TaskCheck,
  TaskStatus,
  TaskVcsPlan,
  Level2Preset,
  MirrorSettings,
  ModelCatalogue,
  ReviewSettings,
  VersionControl,
} from './model.js';
import { newId, tidyVcsPlan } from './model.js';

/** A task the runner is inside of. It cannot be edited, deleted, or left behind at startup. */
const ACTIVE_STATUSES: TaskStatus[] = ['running', 'waiting-approval'];

/**
 * Version control is on unless the operator turns it off.
 *
 * The recommended state, and the safe one: a bot that edits files with no branch and no commit
 * leaves the operator with no way back except their own memory of what the tree looked like.
 */
/**
 * Work is reviewed unless somebody says otherwise.
 *
 * The same argument as version control being on by default: the case for it is strongest
 * exactly when nobody is thinking about it. The model is left empty, meaning the session's own
 * — a different one makes the review better and is worth setting, but requiring it before the
 * feature works at all would mean most runs go unreviewed.
 */
export const DEFAULT_REVIEW: ReviewSettings = { enabled: true, model: '' };

export const DEFAULT_VCS: VersionControl = {
  enabled: true,
  repoDir: '',
  branchMode: 'per-task',
  commitOnFinish: true,
  branchPrefix: 'cop/',
};

export const DEFAULT_MIRROR: MirrorSettings = {
  enabled: false,
  rootDir: '',
  includeDirs: [],
  excludeDirs: [],
  respectGitignore: true,
  includeEnvFiles: false,
};

export class SessionStore {
  readonly dir: string;
  private readonly sessionsDir: string;
  private readonly presetsDir: string;
  private readonly level1Path: string;
  private readonly modelsPath: string;

  constructor(dataDir: string, private readonly defaultLevel1Path: string) {
    this.dir = resolve(dataDir);
    this.sessionsDir = join(this.dir, 'sessions');
    this.presetsDir = join(this.dir, 'level2');
    this.level1Path = join(this.dir, 'level1.md');
    this.modelsPath = join(this.dir, 'models.json');
  }

  async init(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(this.presetsDir, { recursive: true });
  }

  // --- level 1 --------------------------------------------------------------------------

  /** The contract in force: the user's edited copy if there is one, else the shipped one. */
  async getLevel1(): Promise<{ content: string; customised: boolean }> {
    if (existsSync(this.level1Path)) {
      return { content: await readFile(this.level1Path, 'utf8'), customised: true };
    }
    return { content: await readFile(this.defaultLevel1Path, 'utf8'), customised: false };
  }

  async setLevel1(content: string): Promise<void> {
    await this.atomicWrite(this.level1Path, content);
  }

  async resetLevel1(): Promise<void> {
    await rm(this.level1Path, { force: true });
  }

  // --- the model catalogue ----------------------------------------------------------------

  /** What the chat's picker offered when it was last read, or null if it never was. */
  async getModels(): Promise<ModelCatalogue | null> {
    try {
      return JSON.parse(await readFile(this.modelsPath, 'utf8')) as ModelCatalogue;
    } catch {
      return null;
    }
  }

  async saveModels(catalogue: ModelCatalogue): Promise<void> {
    await this.atomicWrite(this.modelsPath, JSON.stringify(catalogue, null, 2));
  }

  // --- level 2 presets ------------------------------------------------------------------

  async listPresets(): Promise<Level2Preset[]> {
    const names = (await readdir(this.presetsDir).catch(() => [] as string[]))
      .filter((n) => n.endsWith('.md'))
      .sort();
    const out: Level2Preset[] = [];
    for (const n of names) {
      const path = join(this.presetsDir, n);
      const content = await readFile(path, 'utf8');
      const { mtime } = await import('node:fs').then((fs) => fs.statSync(path));
      out.push({ name: n.slice(0, -3), content, updatedAt: mtime.toISOString() });
    }
    return out;
  }

  async savePreset(name: string, content: string): Promise<Level2Preset> {
    const safe = name.replace(/[^\p{L}\p{N}._ -]/gu, '').trim();
    if (!safe) throw new Error('Preset name is empty after removing unsafe characters.');
    await this.atomicWrite(join(this.presetsDir, `${safe}.md`), content);
    return { name: safe, content, updatedAt: new Date().toISOString() };
  }

  async deletePreset(name: string): Promise<void> {
    await rm(join(this.presetsDir, `${name}.md`), { force: true });
  }

  // --- sessions -------------------------------------------------------------------------

  /**
   * Every session, newest first — by when it was made, not by what it is called.
   *
   * This used to sort the file names, which looks equivalent because an id starts with a
   * timestamp. It is not: the timestamp is only accurate to the second, and the four characters
   * after it are random. Sessions made in the same second therefore came back in an order
   * decided by a coin toss — and an import makes all of its sessions in the same second, so a
   * plan of three sessions ran in a random order, which is exactly the thing a plan is for.
   * It happened: an audit session ran before the sessions whose work it was auditing.
   *
   * `createdAt` is accurate to the millisecond and is written by the same call that makes the
   * id, so it says what the name only approximates. The id breaks a tie, so the order is at
   * least stable when even that is not enough to separate two.
   */
  async listSessions(): Promise<Session[]> {
    const files = (await readdir(this.sessionsDir).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
    const out: Session[] = [];
    for (const f of files) {
      const s = await this.readSession(join(this.sessionsDir, f));
      if (s) out.push(s);
    }
    return out.sort((a, b) => {
      const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
      if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
      return b.id.localeCompare(a.id);
    });
  }

  async getSession(id: string): Promise<Session | null> {
    return await this.readSession(join(this.sessionsDir, `${id}.json`));
  }

  async createSession(name: string, mirror: Partial<MirrorSettings> = {}): Promise<Session> {
    const session: Session = {
      id: newId(),
      name: name.trim() || 'untitled',
      createdAt: new Date().toISOString(),
      status: 'idle',
      contractSent: false,
      // A queue is a chain until the operator says otherwise, which is how it has always
      // behaved and the safer of the two.
      onFailure: 'stop',
      vcs: { ...DEFAULT_VCS },
      mirror: { ...DEFAULT_MIRROR, ...mirror },
      tasks: [],
    };
    await this.saveSession(session);
    return session;
  }

  async saveSession(session: Session): Promise<void> {
    await this.atomicWrite(join(this.sessionsDir, `${session.id}.json`), JSON.stringify(session, null, 2));
  }

  async deleteSession(id: string): Promise<void> {
    await rm(join(this.sessionsDir, `${id}.json`), { force: true });
  }

  /** Applies a change under a fresh read, so two writers cannot clobber each other. */
  async updateSession(id: string, mutate: (s: Session) => void): Promise<Session> {
    const s = await this.getSession(id);
    if (!s) throw new Error(`Session ${id} does not exist.`);
    mutate(s);
    await this.saveSession(s);
    return s;
  }

  async addTask(
    sessionId: string,
    input: { title: string; level2: string; prompt: string; vcsPlan?: TaskVcsPlan; checks?: TaskCheck[]; reviewEnabled?: boolean },
  ): Promise<Task> {
    const vcsPlan = tidyVcsPlan(input.vcsPlan);
    const checks = (input.checks ?? []).filter((c) => c.name.trim() !== '');
    const task: Task = {
      id: newId('t-'),
      title: input.title.trim() || input.prompt.trim().slice(0, 60) || 'untitled task',
      level2: input.level2,
      prompt: input.prompt,
      status: 'queued',
      createdAt: new Date().toISOString(),
      iterations: 0,
      // Stored only when there is something to store, so a task made in the UI stays the
      // shape it has always been on disk.
      ...(vcsPlan ? { vcsPlan } : {}),
      ...(checks.length > 0 ? { checks } : {}),
      // Only `false` is worth storing: absent means "whatever the session says", which is on.
      ...(input.reviewEnabled === false ? { reviewEnabled: false } : {}),
    };
    await this.updateSession(sessionId, (s) => {
      s.tasks.push(task);
    });
    return task;
  }

  async updateTask(sessionId: string, taskId: string, mutate: (t: Task) => void): Promise<Task> {
    let found: Task | undefined;
    await this.updateSession(sessionId, (s) => {
      found = s.tasks.find((t) => t.id === taskId);
      if (!found) throw new Error(`Task ${taskId} does not exist in session ${sessionId}.`);
      mutate(found);
    });
    return found as Task;
  }

  /**
   * Removes a task from its session. Anything that is not in flight can go: a queued task the
   * user changed their mind about, and equally a finished one they no longer want in the
   * register. Only a task the runner is inside of is protected, because deleting that one
   * would leave the run writing to a task that no longer exists. The run folder under `runs/`
   * is untouched either way, so the record of what was executed survives the deletion.
   */
  async deleteTask(sessionId: string, taskId: string): Promise<void> {
    await this.updateSession(sessionId, (s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (t && ACTIVE_STATUSES.includes(t.status)) {
        throw new Error('This task is running. Stop the session first.');
      }
      s.tasks = s.tasks.filter((x) => x.id !== taskId);
    });
  }

  /**
   * Sends a finished task back to the queue, keeping what the last attempt did.
   *
   * The attempt is archived rather than overwritten: a task that failed is usually re-run
   * because someone wants to compare, and losing the summary or the reason at the moment of
   * the retry destroys exactly the thing that made the retry interesting. The run folder of
   * the old attempt is untouched too, because the next attempt gets a folder of its own.
   */
  async rerunTask(
    sessionId: string,
    taskId: string,
    patch: Partial<Pick<Task, 'title' | 'level2' | 'prompt' | 'vcsPlan' | 'checks'>> = {},
  ): Promise<Task> {
    let result: Task | undefined;
    await this.updateSession(sessionId, (s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`Task ${taskId} does not exist in session ${sessionId}.`);
      if (t.status === 'queued') throw new Error('This task is already queued.');
      if (ACTIVE_STATUSES.includes(t.status)) throw new Error('This task is running. Stop the session first.');

      t.attempts = [
        ...(t.attempts ?? []),
        {
          runId: t.runId,
          runGroup: t.runGroup,
          status: t.status,
          startedAt: t.startedAt,
          finishedAt: t.finishedAt,
          iterations: t.iterations,
          summary: t.summary,
          reason: t.reason,
          deviations: t.deviations,
          // The text as it was when this attempt ran, before any edit below.
          title: t.title,
          prompt: t.prompt,
          level2: t.level2,
          checkResults: t.checkResults,
          review: t.review,
          vcs: t.vcs,
        },
      ];

      // An edit is applied only after the old attempt has been put beyond its reach.
      if (patch.title !== undefined) t.title = patch.title.trim() || t.title;
      if (patch.prompt !== undefined && patch.prompt.trim()) t.prompt = patch.prompt;
      if (patch.level2 !== undefined) t.level2 = patch.level2;
      if (patch.vcsPlan !== undefined) t.vcsPlan = tidyVcsPlan(patch.vcsPlan);
      if (patch.checks !== undefined) t.checks = patch.checks.filter((c) => c.name.trim() !== '');

      t.attempt = (t.attempt ?? 1) + 1;
      t.status = 'queued';
      t.iterations = 0;
      // Cleared so the next run starts from nothing and gets its own run folder.
      t.runId = undefined;
      t.runGroup = undefined;
      t.startedAt = undefined;
      t.finishedAt = undefined;
      t.summary = undefined;
      t.reason = undefined;
      t.finalReply = undefined;
      t.firstMessage = undefined;
      t.logFile = undefined;
      // The results belong to the attempt that produced them, which is now on the record above.
      t.checkResults = undefined;
      t.review = undefined;
      // The branch of the finished attempt stays in the repository and stays on the record
      // above; the next attempt gets its own, cut from the same commit this one started at.
      t.vcs = undefined;
      result = t;
    });
    return result as Task;
  }

  /**
   * Closes tasks that the previous process left open, and is called once at startup.
   *
   * A task's status lives on disk; the approval it is waiting for lives in the memory of the
   * process that asked for it. When that process ends — a restart, a Ctrl+C, a crash — the
   * approval disappears and the task is left saying "waiting for approval" forever: nothing
   * will ever answer it, it is not queued so no run will pick it up, and the session looks
   * busy when it is not. Each one is marked aborted with the reason, which puts it back in
   * reach: it can be deleted, and its prompt can be copied into a new task.
   *
   * Aborted, not re-queued. The task ran commands on this machine and we do not know how far
   * it got, so re-running it silently could repeat whatever it already did. That is the
   * operator's decision, not ours.
   */
  async recoverInterrupted(): Promise<Array<{ sessionId: string; taskId: string; title: string }>> {
    const recovered: Array<{ sessionId: string; taskId: string; title: string }> = [];

    for (const session of await this.listSessions()) {
      const stuck = session.tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
      const busySession = session.status !== 'idle';
      if (stuck.length === 0 && !busySession) continue;

      for (const t of stuck) {
        t.status = 'aborted';
        t.finishedAt = t.finishedAt ?? new Date().toISOString();
        t.reason = 'The operator stopped while this task was in progress, so it never finished. Nothing was resumed.';
        recovered.push({ sessionId: session.id, taskId: t.id, title: t.title });
      }
      session.status = 'idle';
      await this.saveSession(session);
    }
    return recovered;
  }

  // --- helpers --------------------------------------------------------------------------

  /**
   * Reads one session file, filling in mirror fields added after it was written. Sessions are
   * long-lived JSON on disk, so a new option must never come back as `undefined`.
   */
  private async readSession(path: string): Promise<Session | null> {
    try {
      const s = JSON.parse(await readFile(path, 'utf8')) as Session;
      s.mirror = { ...DEFAULT_MIRROR, ...(s.mirror ?? {}) };
      s.vcs = { ...DEFAULT_VCS, ...(s.vcs ?? {}) };
      // Sessions written before the queue could be told what to do on a failure behave the
      // way they always did: the chain stops.
      s.onFailure ??= 'stop';
      return s;
    } catch {
      return null;
    }
  }

  /**
   * Write through a temp file and a rename, and keep trying when Windows says no.
   *
   * The rename is what makes the write atomic: a crash halfway through leaves the temp file
   * behind and the real one untouched. On Windows it is also the step that fails, because
   * renaming onto a destination that any other process has open is refused outright — and this
   * file is read constantly, by the register polling every few seconds, by the sessions list,
   * and by whatever virus scanner has decided to look inside a JSON file that just changed.
   *
   * The failure is EPERM and it is transient: the handle closes microseconds later. Letting it
   * through unretried meant a task dying mid-run with a message about a temp file, which is
   * what happened — a scaffold that had finished three tasks was killed by a file lock on the
   * fourth. So it is retried, briefly and with a growing pause, and only then given up on.
   */
  private async atomicWrite(path: string, content: string): Promise<void> {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, content, 'utf8');

    const backoffMs = [10, 25, 60, 120, 250, 500];
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmp, path);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? '';
        const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
        if (!transient || attempt >= backoffMs.length) {
          // The temp file is no use to anyone now, and leaving one per failed write behind
          // would slowly fill the folder with them.
          await rm(tmp, { force: true }).catch(() => undefined);
          throw new Error(
            `Could not save ${path}: ${code || (e as Error).message}. ` +
              'Something else is holding the file open — an editor, a sync client or a virus scanner.',
          );
        }
        await new Promise((r) => setTimeout(r, backoffMs[attempt]));
      }
    }
  }
}
