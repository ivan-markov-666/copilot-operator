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
import { dirname, join, resolve } from 'node:path';
import type { Interruption } from './interruption.js';
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
import { endingOf, isContinuable, MAX_INSTRUCTION_CHARS, newId, tidyVcsPlan, type TaskNote, type TaskPatch, type TaskSkill } from './model.js';

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
 * Where a session sits in the list: its position, or, for one saved before the list could be
 * arranged, minus the time it was created — which keeps those newest first, as they always were,
 * and above any arranged session only if they are newer than the list's top was.
 */
export function sessionListKey(s: Pick<Session, 'position' | 'createdAt'>): number {
  if (typeof s.position === 'number' && Number.isFinite(s.position)) return s.position;
  const t = Date.parse(s.createdAt);
  return Number.isNaN(t) ? 0 : -t;
}

/** The sessions list's order: by position, then newest first, then by id so it never wobbles. */
export function bySessionList(a: Session, b: Session): number {
  const byKey = sessionListKey(a) - sessionListKey(b);
  if (byKey !== 0) return byKey;
  const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return b.id.localeCompare(a.id);
}

/**
 * What `rerunTask` does with every field of a task when a new attempt begins — Run again, Continue,
 * a new prompt, the runner's own fresh-chat retry.
 *
 *   archived  belongs to the attempt that ended: copied onto its `TaskAttempt`, cleared on the task
 *   cleared   belongs to that attempt and is not kept on the record: cleared
 *   reset     given the new attempt's starting value (status queued, iterations 0, attempt + 1, …)
 *   kept      the task's own, across attempts: its definition, or something every attempt inherits
 *
 * A record over every key of `Task`, so a field added to the task without a decision here does not
 * compile. Fields that were left out of `rerunTask` by default were counted on by the next attempt:
 * the fresh-chat retry count said 2, then 4, then 6 while each run had retried twice, and what an
 * attempt left running was listed under every attempt after it. `npm run check:attempts` holds
 * `rerunTask` to this table.
 */
export const TASK_FIELD_ON_RERUN: Record<keyof Task, 'archived' | 'cleared' | 'reset' | 'kept'> = {
  id: 'kept',
  title: 'kept',
  level2: 'kept',
  prompt: 'kept',
  createdAt: 'kept',
  checks: 'kept',
  vcsPlan: 'kept',
  reviewEnabled: 'kept',
  readOnly: 'kept',
  scope: 'kept',
  outputs: 'kept',
  // What one review noticed is arithmetic for every attempt after it.
  reviewChecks: 'kept',
  attempts: 'kept',
  status: 'reset',
  iterations: 'reset',
  attempt: 'reset',
  continuing: 'reset',
  buildsOn: 'reset',
  runId: 'archived',
  runGroup: 'archived',
  startedAt: 'archived',
  finishedAt: 'archived',
  summary: 'archived',
  reason: 'archived',
  deviations: 'archived',
  disputes: 'archived',
  checkResults: 'archived',
  review: 'archived',
  stats: 'archived',
  freshRetry: 'archived',
  stopCode: 'archived',
  limit: 'archived',
  scopeReverted: 'archived',
  treeChanged: 'archived',
  inputsRestored: 'archived',
  artifactsKept: 'archived',
  vcs: 'archived',
  leftovers: 'archived',
  environment: 'archived',
  handoff: 'archived',
  plan: 'archived',
  accepted: 'archived',
  // Every note stays with the task; the ones not sent yet go out with the next attempt's opening.
  notes: 'kept',
  // The folder before the message first ran: the point "go back" returns to, whatever attempt came after.
  checkpoint: 'kept',
  // The lead's rounds belong to the attempt that made them (two chats, 2026-10-20); which lead a subtask serves, to the task.
  lead: 'archived',
  fromLead: 'kept',
  // The kind of task it is: every attempt is sent with the same skill.
  skill: 'kept',
  interruption: 'cleared',
  finalReply: 'cleared',
  firstMessage: 'cleared',
  logFile: 'cleared',
};

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
  private readonly modelsPath: string;

  constructor(dataDir: string, private readonly defaultLevel1Path: string) {
    this.dir = resolve(dataDir);
    this.sessionsDir = join(this.dir, 'sessions');
    this.modelsPath = join(this.dir, 'models.json');
  }

  async init(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
  }

  // --- level 1 --------------------------------------------------------------------------

  /**
   * The contract in force: the one that ships with the bot, always (operator, 2026-10-20: "it no longer needs changing;
   * it changes at system level, when the bot is updated"). An edited copy an earlier version kept in the data folder
   * (`level1.md` there) is not read any more, and the page that edited it is gone.
   */
  async getLevel1(): Promise<{ content: string }> {
    return { content: await readFile(this.defaultLevel1Path, 'utf8') };
  }

  /** The lead's contract (two chats, 2026-10-20): `lead1.md`, beside the base prompt it ships with. */
  async getLead1(): Promise<{ content: string }> {
    return { content: await readFile(join(dirname(this.defaultLevel1Path), 'lead1.md'), 'utf8') };
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
    return out.sort(bySessionList);
  }

  /**
   * Puts these sessions at the top of the list, in this order.
   *
   * An import calls it with the plan's sessions, so they appear as the plan wrote them. Before
   * this, the list was newest first, and a plan whose sessions were created one after another
   * read upside down.
   */
  async placeOnTop(ids: string[]): Promise<void> {
    const wanted = new Set(ids);
    const others = (await this.listSessions()).filter((s) => !wanted.has(s.id));
    const top = others.length > 0 ? Math.min(...others.map(sessionListKey)) : 0;
    for (const [i, id] of ids.entries()) {
      await this.updateSession(id, (s) => {
        s.position = top - ids.length + i;
      });
    }
  }

  /**
   * The operator's own order: every session, top to bottom.
   *
   * The whole list is given, not one move, so two pages moving rows at once cannot leave positions
   * that contradict each other: the last order sent is the order there is. A list that names a
   * session that does not exist, or leaves one out, is refused rather than guessed at.
   */
  async reorderSessions(ids: string[]): Promise<Session[]> {
    const all = await this.listSessions();
    const known = new Set(all.map((s) => s.id));
    const given = new Set(ids);
    if (given.size !== ids.length) throw new Error('The order names a session twice.');
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`The order names a session that does not exist: ${unknown.join(', ')}.`);
    const missing = all.filter((s) => !given.has(s.id)).map((s) => s.name);
    if (missing.length > 0) throw new Error(`The order leaves out ${missing.length} session(s): ${missing.slice(0, 5).join(', ')}. Reload the list and try again.`);
    for (const [i, id] of ids.entries()) {
      await this.updateSession(id, (s) => {
        s.position = i;
      });
    }
    return await this.listSessions();
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
    // A new session goes on top of the list, where it is looked for.
    const existing = await this.listSessions();
    const session: Session = {
      id: newId(),
      name: name.trim() || 'untitled',
      createdAt: new Date().toISOString(),
      position: existing.length > 0 ? Math.min(...existing.map(sessionListKey)) - 1 : 0,
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
      outputs?: string[];
      skill?: TaskSkill;
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
      ...((input.outputs ?? []).filter((p) => p.trim()).length > 0 ? { outputs: (input.outputs ?? []).map((p) => p.trim()).filter(Boolean) } : {}),
      ...(input.skill ? { skill: { name: input.skill.name, description: input.skill.description, text: input.skill.text } } : {}),
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
  async continueTask(
    sessionId: string,
    taskId: string,
    /** Where an attempt the operator stopped had got to, read from its run folder by the caller. */
    stoppedAt?: Interruption | null,
    /**
     * The operator's new prompt (2026-10-13): what carries a task that failed or blocked on from where
     * it got to, and may come with any other Continue. See `TaskContinuation.instruction`.
     */
    instruction?: string,
  ): Promise<Task> {
    const current = (await this.getSession(sessionId))?.tasks.find((x) => x.id === taskId);
    if (!current) throw new Error(`Task ${taskId} does not exist in session ${sessionId}.`);
    const text = instruction?.trim() || undefined;
    if (text && text.length > MAX_INSTRUCTION_CHARS) throw new Error(`The new prompt is ${text.length} characters; it can be at most ${MAX_INSTRUCTION_CHARS}.`);
    if (!isContinuable(current)) {
      if (current.status === 'failed' || current.status === 'blocked') {
        if (current.stopCode === 'contract-conflict') {
          throw new Error('This task never started its work: it contradicts itself. Fix the contradiction ("Fix the contradiction"), then run it.');
        }
        if (!text) throw new Error('A task that failed is carried on with a new prompt: say what to do now. To run it again as it is, use "Run again".');
        // The task as it ended, before the attempt is archived: what the chat is told about it.
        return await this.rerunTask(sessionId, taskId, {}, {
          fromAttempt: current.attempt ?? 1,
          stoppedBecause: current.reason,
          how: 'failed',
          instruction: text,
          ended: endingOf(current),
        });
      }
      throw new Error('Only a task that stopped before it finished, at a limit from the settings, or that failed can be continued; run this one again instead.');
    }
    const how = current.status === 'limit-reached' || current.limit ? 'limit' : current.interruption ? 'interrupted' : 'stopped';
    return await this.rerunTask(sessionId, taskId, {}, {
      fromAttempt: current.attempt ?? 1,
      stoppedBecause: current.reason,
      how,
      ...(current.limit ? { limit: current.limit } : {}),
      ...(current.interruption ? { interruption: current.interruption } : how === 'stopped' && stoppedAt ? { interruption: stoppedAt } : {}),
      ...(text ? { instruction: text } : {}),
    });
  }

  /**
   * A note from the operator to the chat about this task (2026-10-14): it goes out with the next message the
   * task sends — the opening of its next attempt, or the next report while it runs. See `Task.notes`.
   */
  async addTaskNote(sessionId: string, taskId: string, text: string): Promise<Task> {
    const note = text.trim();
    if (!note) throw new Error('The note is empty.');
    if (note.length > MAX_INSTRUCTION_CHARS) throw new Error(`The note is ${note.length} characters; it can be at most ${MAX_INSTRUCTION_CHARS}.`);
    let result: Task | undefined;
    await this.updateSession(sessionId, (s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`Task ${taskId} does not exist in session ${sessionId}.`);
      t.notes = [...(t.notes ?? []), { id: newId('n-'), text: note, at: new Date().toISOString() }];
      result = t;
    });
    return result as Task;
  }

  /** Marks notes as sent with this attempt's message; returns the ones it marked. */
  async takeUnsentNotes(sessionId: string, taskId: string): Promise<TaskNote[]> {
    let taken: TaskNote[] = [];
    await this.updateSession(sessionId, (s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (!t?.notes?.some((n) => !n.sentAt)) return;
      const at = new Date().toISOString();
      taken = t.notes.filter((n) => !n.sentAt);
      t.notes = t.notes.map((n) => (n.sentAt ? n : { ...n, sentAt: at, attempt: t.attempt ?? 1 }));
    });
    return taken;
  }

  /**
   * The operator accepts a task as done though it did not end so (2026-10-14): what it was is kept beside it,
   * and the run's chain goes on past it as past any done task.
   */
  async acceptTask(sessionId: string, taskId: string, note?: string): Promise<Task> {
    const text = note?.trim() || undefined;
    if (text && text.length > MAX_INSTRUCTION_CHARS) throw new Error(`The note is ${text.length} characters; it can be at most ${MAX_INSTRUCTION_CHARS}.`);
    let result: Task | undefined;
    await this.updateSession(sessionId, (s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`Task ${taskId} does not exist in session ${sessionId}.`);
      if (!['failed', 'blocked', 'limit-reached', 'aborted'].includes(t.status)) {
        throw new Error(t.status === 'done' ? 'This task is done already.' : 'Only a task that ended without being done can be accepted as done.');
      }
      t.accepted = { at: new Date().toISOString(), was: t.status, ...(t.reason ? { reason: t.reason } : {}), ...(text ? { note: text } : {}) };
      t.status = 'done';
      result = t;
    });
    return result as Task;
  }

  /**
   * What a new attempt does with each field of a task — see `TASK_FIELD_ON_RERUN`.
   */
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
          leftovers: t.leftovers,
          environment: t.environment,
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
          readOnly: t.readOnly,
          scopeReverted: t.scopeReverted,
          treeChanged: t.treeChanged,
          handoff: t.handoff,
          inputsRestored: t.inputsRestored,
          artifactsKept: t.artifactsKept,
          vcs: t.vcs,
          plan: t.plan,
          accepted: t.accepted,
          // Two chats: the lead's rounds and subtasks of this attempt (the next one counts its own from nothing).
          lead: t.lead,
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
      t.plan = undefined;
      t.accepted = undefined;
      t.lead = undefined;
      t.scopeReverted = undefined;
      t.treeChanged = undefined;
      t.inputsRestored = undefined;
      t.artifactsKept = undefined;
      t.freshRetry = undefined;
      t.stopCode = undefined;
      t.limit = undefined;
      // What this attempt left running and the machine it ran on are this attempt's, as the rest:
      // left in place, the next attempt's list was added to this one's and read as its own.
      t.leftovers = undefined;
      t.environment = undefined;
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
      // A counter that added up across runs, written before it was derived (`freshRetriesOfLatestRun`).
      for (const t of s.tasks ?? []) delete (t as Task & { autoRetries?: number }).autoRetries;
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
 * A session id as it may appear in a file name, or an error.
 *
 * Ids arrive from URL parameters. Found on 2026-09-27: `DELETE /sessions/:id` and `DELETE
 * /presets/:name` (the presets went on 2026-10-20) joined them straight into a path, and Express decodes `%5C` and `%2F`, so
 * `..\..\<anything>` reached a `.json` or `.md` file anywhere the process could write. The ids this
 * store makes are letters, digits, `-`, `_` and `.` (not leading); anything else is not one of them.
 */
export function safeName(value: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/.test(value) || value.includes('..')) {
    throw new Error(`Not a valid name: ${JSON.stringify(value).slice(0, 80)}`);
  }
  return value;
}

