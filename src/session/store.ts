/**
 * Where sessions, level-2 presets and the level-1 contract live on disk.
 *
 * JSON files, not a database. A single operator on one machine gets nothing from a
 * database except a dependency, and files can be read, diffed and backed up with nothing
 * installed. Writes go through a temp file and a rename, so a crash mid-write cannot leave a
 * half-written session behind, and the writes of one file wait their turn (see `inTurn`), so two
 * at once cannot fail each other or undo each other's change.
 */
import { mkdir, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type {
  Session,
  Task,
  TaskCheck,
  TaskStatus,
  TaskVcsPlan,
  Level2Preset,
  ModelCatalogue,
  ReviewSettings,
  VersionControl,
} from './model.js';
import { isContinuable, newId, tidyVcsPlan, type TaskPatch } from './model.js';

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

/**
 * The three standing texts the operator gives the plan persona: the parts of Kerrigan that come
 * from the person using her rather than from this project. Kept apart because they change at
 * different rates and answer different questions.
 *
 * `organisation` is the slow one: what anybody doing a task here would need to know — how things
 * are built and tested, the conventions, where information lives, what must not be touched.
 * Written once and read for months. Deliberately not "who the company is": the name of an
 * organisation or a project helps with no task, and a field that asked for it filled up with it.
 *
 * `persona` is the approach: what the agent that carries out the tasks is responsible for, the
 * phases it works through, and what it hands back at the end. Nameless on purpose — it is a way of
 * working, not a character — and swappable, because a refactor, an audit and a test suite each
 * want a different one. It is the one text of the three that reaches execution directly: it is
 * written into every task's level 2 when a plan is imported (see `composeLevel2`).
 *
 * `work` is the fast one: what this group of tasks is about, which ticket, which constraints —
 * replaced whenever the work changes. Kept in one field with the others they were edited
 * together, and the parts that never change were rewritten every time the one that does did.
 */
export type ContextKind = 'organisation' | 'persona' | 'work';

export const DEFAULT_VCS: VersionControl = {
  enabled: true,
  repoDir: '',
  branchMode: 'per-task',
  commitOnFinish: true,
  branchPrefix: 'cop/',
};

/**
 * Points a new session that names no folder at the default project, the one on the Project page.
 *
 * The one rule for every way a session is made: on the Sessions page and by importing a plan. The
 * import used to skip it, so a plan's session with version control off and no `projectDir` — the
 * brief's own example has one — kept an empty folder and ran its commands in `execution.cwd`,
 * somewhere the operator never chose, while the same session made by hand worked in their project.
 *
 * Both fields, because they answer different questions about the same folder: where the work is
 * and where the branches go. Version control is not switched on by being filled in. A session that
 * names either keeps what it named and gets nothing here: a plan's repository with the default
 * project beside it as its folder would say the work is in two places.
 */
export function applyDefaultProject(session: Session, defaultDir: string): void {
  const dir = defaultDir.trim();
  if (!dir || session.projectDir.trim() || session.vcs?.repoDir.trim()) return;
  session.projectDir = dir;
  if (session.vcs) session.vcs.repoDir = dir;
}

/**
 * Applies an edit to a task: the one place the rule about a new intent lives.
 *
 * A task given a new prompt is a new question. The checks the reviews of its earlier attempts
 * added were findings about the old question, and inheriting them gated the new one on work it
 * no longer asks for: a maintenance task rewritten as an audit still had to pass "the build uses
 * the new config", and went blocked on an artificial finding. So a changed prompt drops them, with
 * the reason kept beside each, and they stay on the record. The plan's own checks are not guessed
 * at: whoever writes the new prompt says which still apply (the edit form and the new-prompt
 * dialog both show them), and `checks` in the patch is that answer. A re-run with the same prompt
 * keeps everything, because it is the same question asked again.
 */
export function applyTaskPatch(t: Task, patch: TaskPatch): void {
  const newPrompt = patch.prompt !== undefined && patch.prompt.trim() !== '' && patch.prompt.trim() !== t.prompt.trim();
  if (patch.title !== undefined) t.title = patch.title.trim() || t.title;
  if (patch.prompt !== undefined && patch.prompt.trim()) t.prompt = patch.prompt;
  if (patch.level2 !== undefined) t.level2 = patch.level2;
  if (patch.vcsPlan !== undefined) t.vcsPlan = tidyVcsPlan(patch.vcsPlan);
  if (patch.checks !== undefined) t.checks = patch.checks.filter((c) => c.name.trim() !== '');
  if (patch.readOnly !== undefined) {
    if (patch.readOnly) t.readOnly = true;
    else delete t.readOnly;
  }
  if (patch.scope !== undefined) {
    const scope = patch.scope.map((p) => p.trim()).filter(Boolean);
    if (scope.length > 0) t.scope = scope;
    else delete t.scope;
  }
  if (newPrompt && t.reviewChecks?.length) {
    t.reviewChecks = t.reviewChecks.map((rc) =>
      rc.state === 'dropped' ? rc : { ...rc, state: 'dropped' as const, droppedBecause: 'the task was given a new prompt; this was a finding about the old one' },
    );
  }
}

export class SessionStore {
  readonly dir: string;
  private readonly sessionsDir: string;
  private readonly presetsDir: string;
  /** Named personas the operator keeps for the import page, one file each. */
  private readonly personasDir: string;
  private readonly level1Path: string;
  private readonly modelsPath: string;

  constructor(dataDir: string, private readonly defaultLevel1Path: string) {
    this.dir = resolve(dataDir);
    this.sessionsDir = join(this.dir, 'sessions');
    this.presetsDir = join(this.dir, 'level2');
    this.personasDir = join(this.dir, 'personas');
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
    await writeFileAtomically(this.level1Path, content);
  }

  async resetLevel1(): Promise<void> {
    await removeFile(this.level1Path);
  }

  // --- the organisation's part of the plan persona -------------------------------------

  /**
   * The operator's own part of the plan brief: where tickets come from, what to search, how
   * the machine is laid out. One customised copy in `data/organisation.md`, whatever language
   * it is written in; the shipped default comes per language from the prompts folder.
   */
  async getContext(kind: ContextKind, lang: 'en' | 'bg'): Promise<{ content: string; customised: boolean; example: string }> {
    const custom = join(this.dir, `context-${kind}.md`);
    const shipped = join(this.defaultLevel1Path, '..', `${kind}.${lang}.md`);
    const example = await readFile(shipped, 'utf8').catch(() => '');
    if (existsSync(custom)) return { content: await readFile(custom, 'utf8'), customised: true, example };
    // Nothing until the operator writes it: an empty field is what makes the persona ask.
    // The shipped text is the example it is shown, not the answer.
    return { content: '', customised: false, example };
  }

  async setContext(kind: ContextKind, content: string): Promise<void> {
    await writeFileAtomically(join(this.dir, `context-${kind}.md`), content);
  }

  async resetContext(kind: ContextKind): Promise<void> {
    await removeFile(join(this.dir, `context-${kind}.md`));
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
    await writeFileAtomically(this.modelsPath, JSON.stringify(catalogue, null, 2));
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

  /**
   * Saves a preset under the name it can later be deleted by.
   *
   * Stripping the characters a file name cannot hold is not enough on its own: a leading dot and
   * ".." survive it, and `safePresetName` refuses both, so ".env" and "a..b" were saved and then
   * could never be deleted. The name goes through the same rule as the delete, the way a persona's
   * always has, so a name that could not be removed is refused here instead.
   */
  async savePreset(name: string, content: string): Promise<Level2Preset> {
    const safe = name.replace(/[^\p{L}\p{N}._ -]/gu, '').trim();
    if (!safe) throw new Error('Preset name is empty after removing unsafe characters.');
    await writeFileAtomically(join(this.presetsDir, `${safePresetName(safe)}.md`), content);
    return { name: safe, content, updatedAt: new Date().toISOString() };
  }

  async deletePreset(name: string): Promise<void> {
    await removeFile(await namedFile(this.presetsDir, name));
  }

  // --- named personas -------------------------------------------------------------------
  //
  // "How the tasks are carried out" is one box on the import page, and the persona in it depends
  // on the kind of work: a Playwright suite wants a different agent from an API service. These
  // are saved copies of that box under a name, so switching is one choice instead of pasting a
  // JSON back in. The box itself (`context-persona.md`) stays the one that is in force.

  async listPersonas(): Promise<Level2Preset[]> {
    const names = (await readdir(this.personasDir).catch(() => [] as string[]))
      .filter((n) => n.endsWith('.md'))
      .sort((a, b) => a.localeCompare(b));
    const out: Level2Preset[] = [];
    for (const n of names) {
      const path = join(this.personasDir, n);
      const content = await readFile(path, 'utf8');
      const { mtime } = await import('node:fs').then((fs) => fs.statSync(path));
      out.push({ name: n.slice(0, -3), content, updatedAt: mtime.toISOString() });
    }
    return out;
  }

  async savePersona(name: string, content: string): Promise<Level2Preset> {
    const safe = name.replace(/[^\p{L}\p{N}._ -]/gu, '').trim();
    if (!safe) throw new Error('The persona name is empty after removing unsafe characters.');
    await mkdir(this.personasDir, { recursive: true });
    await writeFileAtomically(join(this.personasDir, `${safePresetName(safe)}.md`), content);
    return { name: safe, content, updatedAt: new Date().toISOString() };
  }

  async deletePersona(name: string): Promise<void> {
    await removeFile(await namedFile(this.personasDir, name));
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

  /**
   * The session of this id, or null when there is none.
   *
   * An id that could not be a session's file name — a path, `..`, anything `safeName` refuses —
   * names no session, and is answered as one that does not exist. It used to throw here, so every
   * route that only reads a session (the session itself, a task's log, story or files, a start)
   * answered a path for an id with a 500 rather than the 404 or "no such session" a missing one
   * gets. A write or a delete of such an id is still refused outright: those go through
   * `sessionPath` themselves.
   */
  async getSession(id: string): Promise<Session | null> {
    let path: string;
    try {
      path = this.sessionPath(id);
    } catch {
      return null;
    }
    return await this.readSession(path);
  }

  async createSession(name: string, projectDir = ''): Promise<Session> {
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
      projectDir: projectDir.trim(),
      tasks: [],
    };
    await this.saveSession(session);
    return session;
  }

  async saveSession(session: Session): Promise<void> {
    await writeFileAtomically(this.sessionPath(session.id), JSON.stringify(session, null, 2));
  }

  async deleteSession(id: string): Promise<void> {
    await removeFile(this.sessionPath(id));
  }

  /**
   * Applies a change under a fresh read, so two writers cannot clobber each other.
   *
   * The read, the change and the write happen in the file's turn, with nothing else of this
   * process writing the session in between. A fresh read alone did not keep that promise: Stop
   * writes "stopping" at the moment it answers an approval, and the runner it has just woken
   * writes the task at the same moment. Both read the session before either had written, so
   * whichever wrote second put back what the first had changed, or, when both renamed at once,
   * one of them failed and took the stop or the task down with it.
   */
  async updateSession(id: string, mutate: (s: Session) => void): Promise<Session> {
    const path = this.sessionPath(id);
    return await inTurn(path, async () => {
      const s = await this.readSession(path);
      if (!s) throw new Error(`Session ${id} does not exist.`);
      mutate(s);
      await replaceFile(path, JSON.stringify(s, null, 2));
      return s;
    });
  }

  async addTask(
    sessionId: string,
    input: {
      title: string;
      level2: string;
      prompt: string;
      vcsPlan?: TaskVcsPlan;
      checks?: TaskCheck[];
      reviewEnabled?: boolean;
      readOnly?: boolean;
      scope?: string[];
    },
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
      // Only `true` is worth storing: a task may change files unless a plan said otherwise.
      ...(input.readOnly === true ? { readOnly: true } : {}),
      // Stored only when it limits something: absent means anywhere, as before scopes existed.
      ...((input.scope ?? []).filter((p) => p.trim()).length > 0 ? { scope: (input.scope ?? []).map((p) => p.trim()).filter(Boolean) } : {}),
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
  /**
   * Queues a task that stopped before it finished to carry on where it stopped: the same
   * conversation, the same branch, a fresh count of messages. The attempt that stopped is kept on
   * the record like any other.
   *
   * Two kinds of stop qualify. The runner's limit (`limit-reached`), and a stop that was not the
   * task's doing (`aborted`): the bot itself stopping under it — power, a shutdown, Ctrl+C, a crash,
   * recorded in `interruption` at the next start — or the operator stopping it. A task that failed
   * or blocked has a verdict on its work, and carrying that work on would carry the verdict's cause
   * on with it; those are run again — unless what ended them was a limit from the settings (out of
   * rounds of fixing checks or review findings), which is a counter, not the verdict. See `TaskLimit`.
   */
  async continueTask(sessionId: string, taskId: string): Promise<Task> {
    const current = (await this.getSession(sessionId))?.tasks.find((x) => x.id === taskId);
    if (!current) throw new Error(`Task ${taskId} does not exist in session ${sessionId}.`);
    if (!isContinuable(current)) {
      throw new Error('Only a task that stopped before it finished, or at a limit from the settings, can be continued; run this one again instead.');
    }
    const how = current.status === 'limit-reached' || current.limit ? 'limit' : current.interruption ? 'interrupted' : 'stopped';
    return await this.rerunTask(sessionId, taskId, {}, {
      fromAttempt: current.attempt ?? 1,
      stoppedBecause: current.reason,
      how,
      ...(current.limit ? { limit: current.limit } : {}),
      ...(current.interruption ? { interruption: current.interruption } : {}),
    });
  }

  async rerunTask(
    sessionId: string,
    taskId: string,
    patch: TaskPatch = {},
    /** Present when the new attempt carries on from the last one (see `continueTask`). */
    continuing?: Task['continuing'],
    /** Present when a finished task's new prompt builds on its work (see `Task.buildsOn`). */
    buildsOn?: Task['buildsOn'],
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
          disputes: t.disputes,
          // The text as it was when this attempt ran, before any edit below.
          title: t.title,
          prompt: t.prompt,
          level2: t.level2,
          checkResults: t.checkResults,
          checks: t.checks,
          vcsPlan: t.vcsPlan,
          review: t.review,
          stats: t.stats,
          continuing: t.continuing,
          buildsOn: t.buildsOn,
          freshRetry: t.freshRetry,
          stopCode: t.stopCode,
          limit: t.limit,
          scope: t.scope,
          scopeReverted: t.scopeReverted,
          vcs: t.vcs,
        },
      ];

      // An edit is applied only after the old attempt has been put beyond its reach.
      applyTaskPatch(t, patch);

      t.attempt = (t.attempt ?? 1) + 1;
      t.status = 'queued';
      t.iterations = 0;
      t.continuing = continuing;
      t.buildsOn = buildsOn;
      // Where the attempt that stopped had got to belongs to that attempt; the next one starts clean.
      t.interruption = undefined;
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
      // Declared by the attempt above, and kept there. The checks reviews gave stay: they are
      // the one thing a new attempt should inherit.
      t.deviations = undefined;
      t.disputes = undefined;
      // Counts, the ending and what was put back belong to the attempt above too. A fresh-chat retry
      // marks itself again after this, in the runner.
      t.stats = undefined;
      t.handoff = undefined;
      t.scopeReverted = undefined;
      t.freshRetry = undefined;
      t.stopCode = undefined;
      t.limit = undefined;
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

    for (const listed of await this.listSessions()) {
      if (listed.status === 'idle' && !listed.tasks.some((t) => ACTIVE_STATUSES.includes(t.status))) continue;

      // Read again in the file's turn, like any other change, so a write that landed since the
      // list was read is kept rather than replaced by the copy in the list.
      const path = this.sessionPath(listed.id);
      await inTurn(path, async () => {
        const session = await this.readSession(path);
        if (!session) return;
        for (const t of session.tasks.filter((x) => ACTIVE_STATUSES.includes(x.status))) {
          t.status = 'aborted';
          t.finishedAt = t.finishedAt ?? new Date().toISOString();
          t.reason =
            'The bot stopped while this task was in progress (the program was closed, the machine went off, or it crashed), so it never finished. ' +
            'Its work so far is kept; "Continue in the same chat" carries it on where it stopped.';
          recovered.push({ sessionId: session.id, taskId: t.id, title: t.title });
        }
        session.status = 'idle';
        await replaceFile(path, JSON.stringify(session, null, 2));
      });
    }
    return recovered;
  }

  // --- helpers --------------------------------------------------------------------------

  /**
   * Reads one session file, filling in fields added after it was written. Sessions are
   * long-lived JSON on disk, so a new option must never come back as `undefined`.
   */
  private async readSession(path: string): Promise<Session | null> {
    try {
      const s = JSON.parse(await readFile(path, 'utf8')) as Session & { mirror?: { rootDir?: string } };
      // Written before the project-files feature was removed: its root is the project folder.
      s.projectDir = (s.projectDir ?? s.mirror?.rootDir ?? '').trim();
      delete s.mirror;
      s.vcs = { ...DEFAULT_VCS, ...(s.vcs ?? {}) };
      // Sessions written before the queue could be told what to do on a failure behave the
      // way they always did: the chain stops.
      s.onFailure ??= 'stop';
      return s;
    } catch {
      return null;
    }
  }

  private sessionPath(id: string): string {
    return join(this.sessionsDir, `${safeName(id)}.json`);
  }
}

// --- writing a file -------------------------------------------------------------------------

/**
 * The work queued on each file, by the file's full path: the tail of its chain.
 *
 * Kept for the module, not for one store, because every store in a process writes the same
 * files: the API has one, but a check or the terminal may make another over the same folder,
 * and a queue each would let their writes meet again.
 */
const queued = new Map<string, Promise<void>>();

/**
 * Runs `work` once everything queued earlier on the same file has finished, failed or not.
 *
 * Every write of the store goes through here, and `updateSession` holds the turn across its read
 * as well, as does a write worked out from the file (see `writeFileAtomically`), so a change is
 * always made to what the last write left. `work` must not wait for another turn on the same file,
 * which would wait for itself; nothing here does, and a session's `mutate` is synchronous, so it
 * cannot.
 *
 * In this process only: another process writing the same file at the same time is not waited
 * for. The one that might, a run from the terminal, makes a session of its own and writes only that.
 */
function inTurn<T>(path: string, work: () => Promise<T>): Promise<T> {
  const full = resolve(path);
  // Windows treats `A.json` and `a.json` as one file, so they share one queue there.
  const key = process.platform === 'win32' ? full.toLowerCase() : full;
  const run = (queued.get(key) ?? Promise.resolve()).then(work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queued.set(key, tail);
  // Forgotten once nothing is queued behind it, so the map holds only the files being written.
  void tail.then(() => {
    if (queued.get(key) === tail) queued.delete(key);
  });
  return run;
}

/**
 * Writes a file whole, in its turn: a crash, or another write of the same file, cannot leave it
 * half written or lose either write. For any file the program keeps, not only the store's.
 *
 * `content` may be a function instead, for a write worked out from what the file holds: it is
 * called in the file's turn, so what it reads is what the last write left, and nothing else of this
 * process writes the file until its answer has landed. Read first and written here, a change of one
 * setting put back whatever another had changed in between. If it throws, nothing is written. Like
 * any work in a turn, it must not wait for another turn on the same file (see `inTurn`).
 */
export async function writeFileAtomically(path: string, content: string | (() => Promise<string>)): Promise<void> {
  await inTurn(path, async () => replaceFile(path, typeof content === 'string' ? content : await content()));
}

/** Removes a file in its turn, so a delete and a write of it land in the order they were asked for. */
async function removeFile(path: string): Promise<void> {
  await inTurn(path, () => rm(path, { force: true }));
}

/**
 * Write through a temp file and a rename, and keep trying when Windows says no. Not queued: the
 * caller holds the file's turn (see `inTurn`).
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
 *
 * Each write has a temp file of its own. One name per process was shared by every write of the
 * same file, so when two overlapped, the first rename took the temp file the second was about to
 * rename, and the second failed with ENOENT — reported as a lock it was not.
 */
async function replaceFile(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
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
          transient
            ? `Could not save ${path}: ${code}. Something else is holding the file open — an editor, a sync client or a virus scanner.`
            : `Could not save ${path}: ${(e as Error).message}`,
        );
      }
      await new Promise((r) => setTimeout(r, backoffMs[attempt]));
    }
  }
}

/**
 * The file a preset or persona of this name is kept in, for removing it.
 *
 * A name `safePresetName` accepts, or one that is already a file in the folder. The save did not
 * always apply that rule, so a preset called ".env" or "a..b" may be on disk from before; without
 * the second way it is listed and can never be deleted. A name matched against the folder's own
 * listing is a file name, which cannot hold a separator, so it cannot reach outside the folder.
 */
async function namedFile(dir: string, name: string): Promise<string> {
  const onDisk = await readdir(dir).catch(() => [] as string[]);
  if (onDisk.includes(`${name}.md`)) return join(dir, `${name}.md`);
  return join(dir, `${safePresetName(name)}.md`);
}

/**
 * A session id as it may appear in a file name, or an error.
 *
 * Ids, and preset names (see `safePresetName`), arrive from URL parameters. Found on 2026-09-27: `DELETE /sessions/:id` and `DELETE
 * /presets/:name` joined them straight into a path, and Express decodes `%5C` and `%2F`, so
 * `..\..\<anything>` reached a `.json` or `.md` file anywhere the process could write. The ids this
 * store makes are letters, digits, `-`, `_` and `.` (not leading); anything else is not one of them.
 */
export function safeName(value: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/.test(value) || value.includes('..')) {
    throw new Error(`Not a valid name: ${JSON.stringify(value).slice(0, 80)}`);
  }
  return value;
}

/** A preset name as `savePreset` allows it — letters in any script, digits, space, `.`, `_`, `-` — never a path. */
export function safePresetName(value: string): string {
  if (!/^[\p{L}\p{N}_ -][\p{L}\p{N}._ -]{0,199}$/u.test(value) || value.includes('..')) {
    throw new Error(`Not a valid preset name: ${JSON.stringify(value).slice(0, 80)}`);
  }
  return value;
}
