/**
 * The domain the UI and the API talk about.
 *
 * A **session** is one Copilot conversation. Inside it, **tasks** run one after another,
 * each with its own level-2 instructions and its own prompt. Level 1, the contract with the
 * runner, is sent once at the start of the conversation and applies to every task in it.
 *
 * Everything here is plain data that survives a restart: sessions are JSON files under the
 * data directory, and the heavy artefacts of a task (reports, replies, step logs) live in the
 * run folder the task points at.
 */
import type { ChatPointer } from '../transport/chatSession.js';
import type { ShellInventory } from '../exec/shells.js';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting-approval'
  | 'done'
  /**
   * The task reached its end and the work was not done, because something was in the way.
   *
   * Kept apart from `failed` on purpose. `failed` is the machine's word: a command died, the
   * contract was broken, a check would not pass. `blocked` is a judgement reported by the model
   * doing the work — it tried several approaches, none of them worked, and it says which ones
   * and what it needs. That is a result somebody can act on, and burying it in `failed` would
   * throw away the one part of the outcome that was worth reading.
   */
  | 'blocked'
  | 'failed'
  | 'aborted'
  | 'limit-reached';

export type SessionStatus = 'idle' | 'running' | 'stopping';

/** One instruction not followed as written: which, what was done instead, and why. */
export type TaskDeviation = { instruction: string; did: string; why: string };

/** One review finding the model said was wrong: which (by id), why, and what shows it. */
export type TaskDispute = { finding: string; why: string; evidence: string };

/** The machine's tools at the time a task ran. `null` is "not found on this machine". */
export type TaskEnvironment = {
  collectedAt: string;
  os: string;
  node: string;
  npm: string | null;
  git: string | null;
  pwsh: string | null;
  powershell: string | null;
  /**
   * Which shells the machine had, and where. Optional because a task recorded before the runner
   * looked for them has no answer to give, and inventing one would be worse than the gap.
   */
  shells?: ShellInventory;
  /**
   * Which shell a step or a check that named none actually got on this run.
   *
   * Optional for the same reason `shells` is, and worth storing rather than deriving: deriving it
   * needs `execution.defaultShell`, which is not in the record, and two readers deriving it
   * separately is how the environment manifest and the export came to name different shells for
   * one run.
   */
  defaultShell?: 'pwsh' | 'powershell' | 'cmd';
  edge: { path: string; version: string | null } | null;
};

/**
 * A check a reviewer gave with a finding, kept with the task for every later attempt.
 *
 * `active` runs in the gate with the operator's checks. `suspended` is what a dispute does to
 * it: not run until the next review rules — reactivated if that review raises the finding
 * again, dropped if it does not. A derived check sends the work back like any other, but it
 * never ends a task on its own: with the rounds spent and only derived checks failing, the
 * work goes to the reviewer with those failures named, because a check written by one
 * reviewer is outranked by the next reviewer's judgement, not by a counter.
 */
export type TaskReviewCheck = {
  check: TaskCheck;
  /** The finding it came from, `r1f2`, and what that finding said. */
  findingId: string;
  what: string;
  where?: string;
  round: number;
  /** Which attempt of the task the finding was made on. */
  attempt: number;
  state: 'active' | 'suspended' | 'dropped';
};

export type Task = {
  id: string;
  title: string;
  /** Level 2: project, domain and team instructions. Written by the user, saved per task. */
  level2: string;
  /** The task itself. */
  prompt: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Folder name under `runs/` holding this task's artefacts, once it has started. */
  runId?: string;
  iterations: number;
  /** The exact text that opened the task in the chat, saved so the UI can show it. */
  firstMessage?: string;
  /** Copilot's closing explanation of what was done and what the result is. */
  summary?: string;
  /** The raw markdown of the last reply, for the record. */
  finalReply?: string;
  /** Why the task ended, when it did not end with `done`. */
  reason?: string;
  /**
   * Instructions the model could not follow as written, with what it did instead and why.
   * Declared by the model in its replies and kept here, because a decision taken in a chat
   * and written only in a note is a decision nobody made.
   */
  deviations?: TaskDeviation[];
  /** Review findings the model disputed, with its evidence. The next reviewer was told. */
  disputes?: TaskDispute[];
  /**
   * Checks that reviewers gave with their findings. Not cleared by a re-run: what one review
   * noticed is arithmetic for every attempt after it.
   */
  reviewChecks?: TaskReviewCheck[];
  /**
   * Processes tied to the project that were still running when the task, or one of its
   * reviews, ended — stopped by the runner and written down with where they came from.
   */
  leftovers?: Array<{ pid: number; name: string; command: string; ports: number[]; by: string }>;
  /**
   * The machine's tools as they were when the task ran: the layer under the project's
   * lockfile. Two runs of one plan a day apart got different major versions of everything
   * `npm install` fetched, and this is where that difference is read from.
   */
  environment?: TaskEnvironment;
  /** Path of the consolidated text log of everything executed, relative to the run folder. */
  logFile?: string;
  /**
   * Which attempt the fields above describe. 1 for the first run, and one higher every time
   * the task is sent back to the queue. It is also what keeps the attempts apart on disk:
   * each one gets its own folder under `runs/`, so re-running never overwrites the record of
   * what happened last time.
   */
  attempt?: number;
  /** Attempts that have already finished, oldest first. */
  attempts?: TaskAttempt[];
  /** The press of a start button this attempt belonged to. */
  runGroup?: TaskRunGroup;
  /** What version control did for the current attempt. */
  vcs?: TaskVcs;
  /** What version control was *asked* to do for this task, as opposed to what it did. */
  vcsPlan?: TaskVcsPlan;
  /**
   * What must be true before this task is allowed to end.
   *
   * Empty or absent means the task ends when Copilot says it has, which is how every task
   * behaved before checks existed.
   */
  checks?: TaskCheck[];
  /** How the checks turned out the last time they ran. */
  checkResults?: TaskCheckResult[];
  /** Turns the independent review off for this one task. Absent means the session decides. */
  reviewEnabled?: boolean;
  /**
   * How many times the runner ran this task again in a fresh conversation after it ended
   * `blocked`, on its own (`limits.retryBlockedInFreshChat`). A row that says "retried in a
   * fresh chat, then done" means the chat was the cause; one that says "retried twice, still
   * blocked" means it was not.
   */
  autoRetries?: number;
  /**
   * The task must not change files. The runner fails it if the working tree changed when it
   * ends, and still commits the change on its branch so nothing is lost. A flag rather than a
   * sentence, because a sentence is advice: a smoke test told to change nothing renamed the
   * page's labels when a reviewer asked.
   */
  readOnly?: boolean;
  /** What the independent review concluded, once it has run. */
  review?: TaskReview;
};

/**
 * The press of a start button that a task ran under.
 *
 * Tasks do not remember who started them, and by the time anyone reads the register the batch
 * that ran them is gone: it lives in memory and does not survive a restart. So the fact is
 * written onto each task as it starts. It answers the question the register could not: which
 * of these ran together, in one window, as one decision — as opposed to happening to sit next
 * to each other because they were both queued.
 *
 * A session started on its own gets one of these too, with `sessions: 1`. There is no such
 * thing as a task that ran outside a run; there are only runs of different sizes.
 */
export type TaskRunGroup = {
  /** Shared by every task of every session started together. */
  id: string;
  startedAt: string;
  /** How many sessions that press of the button started. */
  sessions: number;
  /**
   * What the operator called this run, when they did. A plan's name is offered as the default;
   * the register groups by it, and the exports are named after it, because a file called after
   * an id is one nobody finds again.
   */
  name?: string;
};

/**
 * The same run, written onto the session rather than onto a task.
 *
 * It exists because the tasks cannot answer the question that matters after a failure: *what
 * was this run asked to do*. A task is only stamped when it starts, so a run that stopped at
 * the second task of the first session leaves no trace on the seven tasks that never got their
 * turn, nor on the two sessions that were never reached. Going back and running the rest again
 * needs all of them, so the run records its own intent here, on every session it selected, at
 * the moment it starts.
 *
 * `mode` and `onFailure` are kept for the same reason: running it again should mean running it
 * the way it was run, not the way some form happens to be set an hour later.
 */
export type SessionRunGroup = {
  id: string;
  startedAt: string;
  sessions: number;
  /** See `TaskRunGroup.name`. */
  name?: string;
  /** Where this session sat in the run's order, from 0. */
  order: number;
  /** The tasks that were queued when the run began: what this session was asked to do. */
  taskIds: string[];
  mode: 'confirm' | 'unattended';
  onFailure: 'stop' | 'continue';
};

/**
 * The names a task carries into git, when someone chose them rather than letting them be
 * derived.
 *
 * An imported plan is the reason this exists: the model that wrote the plan already knows
 * what each task is for, and "cop/invoice-csv-writer" with a commit message written in the
 * imperative reads better in `git log` than a branch named after a title someone typed into a
 * form. Both are optional and both are suggestions: the runner still sanitises the branch
 * name, still adds the prefix, and still refuses to overwrite a branch that exists.
 */
export type TaskVcsPlan = {
  /** A branch name for this task, without the prefix. Sanitised before git ever sees it. */
  branch?: string;
  /** The subject, and optionally the body, of the commit this task ends with. */
  commitMessage?: string;
};

/**
 * What has to be true before a task counts as finished.
 *
 * Every kind here is one a machine can decide on its own: an exit code, a string in some
 * output, a file on disk. That is not a limitation to work around, it is the point — this
 * runner has no language model of its own, so a check whose answer needed judgement could only
 * ever be guessed at. The judgement belongs to whoever writes the check; what happens after it
 * is arithmetic.
 */
export type TaskCheck = {
  /** What this is checking, in a few words. It travels to the chat when the check fails. */
  name: string;
  expect:
    | 'exit-zero'
    | 'exit-nonzero'
    | 'output-contains'
    | 'output-omits'
    | 'output-matches'
    | 'file-exists'
    | 'file-missing'
    | 'file-contains'
    /**
     * Nothing in the working tree that looks like tool output or secrets. Added by the runner
     * itself whenever it is going to commit; not offered to plans, because it is not a claim
     * about the work but a fact about what a commit should not carry. See `commitHygiene.ts`.
     */
    | 'commit-clean';
  /** The command, for the exit-code and output kinds. */
  run?: string;
  shell?: 'pwsh' | 'powershell' | 'cmd';
  /** Where to run it. Empty means the session's working directory. */
  cwd?: string;
  /** The file, for the file kinds. */
  file?: string;
  /** The string, or the regular expression, the kind is asking about. */
  value?: string;
};

/**
 * Whether a session's work is checked by a second, independent conversation, and on what.
 *
 * On by default. The reasoning is the same one that makes checks worth having and then goes a
 * step further: a check tests the claims somebody thought to write down, and the implementer's
 * own verification tests the claims the implementer thought to make. Neither catches the defect
 * nobody anticipated. A conversation that had no part in the work, shown the task and the
 * result and made to run them, catches a different class — and it is cheap enough to be the
 * default rather than something remembered on the days it matters.
 */
export type ReviewSettings = {
  enabled: boolean;
  /**
   * The model the review runs on. Empty means the session's own.
   *
   * Worth setting. A fresh conversation removes attachment to the work, which is most of the
   * value, but it does not remove the model's own blind spots — the reviewer can be wrong about
   * exactly the thing the implementer was wrong about, for exactly the same reason. A different
   * model is the cheapest way to make the second opinion genuinely second.
   */
  model: string;
};

/** What an independent review concluded about a task, kept on the task as part of its record. */
export type TaskReview = {
  verdict: 'pass' | 'fail' | 'error' | 'skipped';
  /** How many review rounds the task went through. */
  rounds: number;
  /** How many commands the last reviewer ran. A pass with none is refused before it gets here. */
  stepsRun: number;
  summary?: string;
  findings?: Array<{
    /** Round and position, `r1f2`: what a dispute names. Absent on records older than this. */
    id?: string;
    what: string;
    evidence: string;
    where?: string;
    /** Whose problem it is: the work, or the task that asked for it. */
    about?: 'work' | 'task';
    /** An earlier round raised the same finding at the same place, and it came back. */
    repeated?: boolean;
  }>;
  /** Set when the review itself could not be carried out, which is not the work's fault. */
  problem?: string;
  /** What the review actually ran on, when it differed from the session's model. */
  model?: string;
};

/** How one check turned out, kept on the task so the record says why it ended as it did. */
export type TaskCheckResult = {
  name: string;
  passed: boolean;
  detail: string;
};

/**
 * A plan with its blanks removed, or nothing at all when both are blank.
 *
 * One function rather than three, because a task made in the form, a task made by an import
 * and a task edited afterwards all have to end up in the same shape on disk. An empty string
 * is how the form says "I do not want a name here", and it must leave no trace behind.
 */
export function tidyVcsPlan(plan: TaskVcsPlan | undefined): TaskVcsPlan | undefined {
  const branch = plan?.branch?.trim();
  const commitMessage = plan?.commitMessage?.trim();
  if (!branch && !commitMessage) return undefined;
  return { ...(branch ? { branch } : {}), ...(commitMessage ? { commitMessage } : {}) };
}

/**
 * What one finished attempt looked like.
 *
 * Kept on the task rather than only in the run folder, so the UI can show the history of a
 * task without reading anything from disk, and so a deleted run folder does not erase the
 * knowledge that the attempt happened at all.
 */
export type TaskAttempt = {
  runId?: string;
  /** The run this attempt belonged to. */
  runGroup?: TaskRunGroup;
  status: TaskStatus;
  startedAt?: string;
  finishedAt?: string;
  iterations: number;
  summary?: string;
  reason?: string;
  /** What this attempt declared it could not do as written. */
  deviations?: TaskDeviation[];
  /** Review findings this attempt disputed. */
  disputes?: TaskDispute[];
  /**
   * What this attempt actually ran with.
   *
   * Snapshotted because a finished task can be edited and queued again, and without the text
   * it ran with, the record of the old attempt would claim it was asked something it never
   * was. The summary underneath it would then be an answer to a question nobody had asked.
   */
  title: string;
  prompt: string;
  level2: string;
  /** How the checks turned out for this attempt. */
  checkResults?: TaskCheckResult[];
  /** What the independent review concluded about this attempt. */
  review?: TaskReview;
  /**
   * What version control did for this attempt, including the commit it started from.
   *
   * This is what makes a re-run able to go back: the branch of the new attempt is cut from
   * the base commit recorded here, so it starts where the first attempt started rather than
   * where the last one ended.
   */
  vcs?: TaskVcs;
};

export type MirrorSettings = {
  enabled: boolean;
  rootDir: string;
  includeDirs: string[];
  excludeDirs: string[];
  /**
   * Skip whatever the project's `.gitignore` lists. On by default: build output and local
   * scratch files are noise in a chat. It has no say over `.env` files.
   */
  respectGitignore: boolean;
  /**
   * Copy `.env` files. Off by default, and the only thing that decides them: neither the
   * gitignore option nor the contents of `.gitignore` can turn it on or off, because every
   * project ignores `.env` and that would make this switch meaningless.
   */
  includeEnvFiles: boolean;
};

/**
 * How a session treats the repository it works in.
 *
 * On by default, because the alternative is a bot editing a working tree with no way back.
 * The runner does the git itself; level 1 tells Copilot that branches and commits are not its
 * job, so the two do not fight over the same repository.
 */
export type VersionControl = {
  enabled: boolean;
  /** The repository to work in. Empty means the project the files are mirrored from. */
  repoDir: string;
  /**
   * `per-task` gives every task its own branch, all cut from the same starting point, so a
   * task never sees the previous task's changes. `per-session` puts the whole queue on one
   * branch, so each task builds on the one before it.
   */
  branchMode: 'per-task' | 'per-session';
  /** Commit what the task changed when it ends. Off means the changes are left in the tree. */
  commitOnFinish: boolean;
  /** What every branch this project creates starts with, so they are obvious in `git branch`. */
  branchPrefix: string;
  /**
   * The name of the one branch a `per-session` run works on, without the prefix.
   *
   * Empty means it is derived from the session's name, which is what it always was. A plan
   * can set it so the branch says what the work is rather than what the session was called.
   * It has no effect in `per-task` mode, where the name comes from each task.
   */
  branchName?: string;
};

/** What version control did for one task, recorded so a re-run can go back to where it began. */
export type TaskVcs = {
  branch?: string;
  /** The commit the task started from. A re-run branches from exactly this. */
  baseCommit?: string;
  /** Where the branch ended up, when something was committed. */
  commit?: string;
  /** One line per commit the task produced. */
  commits?: string[];
  /**
   * The files that commit touched, with lines added and removed.
   *
   * Recorded so the question "did this task actually change anything" has an answer on the
   * task card, without opening the repository or trusting the summary's word for it. -1 means
   * a binary file, which git counts in neither direction.
   */
  files?: Array<{ path: string; added: number; removed: number }>;
  /**
   * Committed files that look like tool output or secrets, each with why it looks that way.
   * They were pointed out to the model once and left in place, so a person should look.
   */
  suspicious?: Array<{ path: string; reason: string }>;
  /** Set when version control was on but could not do its part, with the reason. */
  problem?: string;
};

export type Session = {
  id: string;
  name: string;
  createdAt: string;
  status: SessionStatus;
  /** Set once the conversation exists in Copilot. */
  chat?: ChatPointer;
  /** Whether the level-1 contract has already been sent in this conversation. */
  contractSent: boolean;
  /**
   * A name that lets several sessions share one Copilot conversation.
   *
   * Sessions with the same group run in the same chat: the first of them to run opens it, and
   * the rest join it instead of starting their own. Empty, which is the default, means this
   * session has a conversation of its own — which is what a session is, most of the time.
   *
   * It is a name rather than a session id because it has to be writable by a plan, and a plan
   * is written before any of these sessions exists.
   */
  conversationGroup?: string;
  /**
   * The name of the plan this session was imported from, if any. Offered as the run's name
   * when the session is started, so a run is called what its plan was called.
   */
  planName?: string;
  /**
   * The Copilot model this conversation should run on, by the exact name the chat's own
   * picker shows. Empty means "whatever the chat is already set to", which is how every
   * session behaved before this existed and is still the default.
   *
   * The names are not an enum here on purpose: the list belongs to Microsoft, differs per
   * tenant and changes without notice, so it is read from the live picker and cached rather
   * than declared.
   */
  model?: string;
  /** What the picker actually reported after the last run applied the choice. */
  modelInUse?: string;
  /**
   * What the queue does when a task does not end with a summary.
   *
   * `stop` treats the queue as one chain: a task that fails leaves the rest queued, because a
   * failed task usually leaves the machine in a state the next one did not expect, and the
   * later tasks were written assuming the earlier ones worked. This is the default and was
   * the only behaviour before the choice existed.
   *
   * `continue` treats the tasks as independent checks that happen to share a conversation:
   * one failing says nothing about the next, so the run carries on and the failures are read
   * afterwards from the register.
   */
  onFailure?: 'stop' | 'continue';
  /** Whether the work is checked by a second, independent conversation. On unless said otherwise. */
  review?: ReviewSettings;
  /** How this session treats the repository it works in. */
  vcs?: VersionControl;
  /** The commit every per-task branch of this session is cut from. Set by the first run. */
  vcsBaseCommit?: string;
  /** The last run this session was part of, and what that run asked of it. */
  runGroup?: SessionRunGroup;
  mirror: MirrorSettings;
  tasks: Task[];
};

/**
 * What the chat's model picker offered the last time it was read, cached under `data/`.
 *
 * Reading it costs a browser launch and holds the profile lock, so it cannot happen on every
 * page load. The cache is what the UI shows; refreshing it is an explicit act by the user.
 */
export type ModelCatalogue = {
  options: Array<{ name: string; raw: string; selected: boolean; disabled: boolean; role: string }>;
  /** What the picker was set to when the list was read. */
  current?: string;
  readAt: string;
  /** Set when the picker was missing or unreadable, so the UI can say why the list is empty. */
  note?: string;
};

/** A saved level-2 persona the user can reuse across tasks and sessions. */
export type Level2Preset = {
  name: string;
  content: string;
  updatedAt: string;
};

/** One line of the live event stream the UI subscribes to. */
export type SessionEvent = {
  at: string;
  sessionId: string;
  taskId?: string;
  type: string;
  level: 'info' | 'warn' | 'error';
  message?: string;
  data?: Record<string, unknown>;
};

/** A step waiting for a human decision in confirm mode. */
export type PendingApproval = {
  id: string;
  sessionId: string;
  taskId: string;
  stepId: number;
  description: string;
  /**
   * The text of the script this step is about to run, when it is about to run one.
   *
   * The description names the file; this is what is in it. Both are needed, and only the
   * second one is the decision: a person shown `[download] collect-logs.ps1 (run)` has been
   * asked to approve a name, which is the same blind spot the automated gate had.
   *
   * Clipped before it leaves the runner — an approval box is not a file viewer, and the whole
   * file is kept, hashed, in the run's artifacts folder either way.
   */
  script?: string;
  createdAt: string;
};

export function newId(prefix = ''): string {
  const now = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${prefix}${stamp}-${rnd}`;
}
