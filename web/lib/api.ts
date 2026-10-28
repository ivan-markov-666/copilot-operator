/**
 * The browser side of the API. One place that knows the base URL and how errors come back.
 */
import type { PickerKey } from './pickerLocators';

export const API = process.env.NEXT_PUBLIC_COP_API ?? 'http://127.0.0.1:4000/api';

/** The address of a session's page, with an optional in-page anchor (a task id, `new-task`). */
export function sessionHref(id: string, anchor?: string): string {
  return `/sessions/view?id=${encodeURIComponent(id)}${anchor ? `#${anchor}` : ''}`;
}

/** Where this browser keeps the token once it has been handed over. */
const TOKEN_KEY = 'cop-api-token';

/**
 * The API's per-install token, as this browser was given it.
 *
 * Where it comes from depends on what serves the page. The static interface of the npm package
 * (`npx cop start`) carries it in no file: scripts/build-package.mjs compiles the fallback below to
 * '' and refuses a build that holds a token, and the API hands that page the token as the
 * `cop_token` cookie, which the browser sends with each request and no script can read.
 *
 * The dev server of `npm start` is different, by the operator's decision: scripts/dev.mjs gives the
 * web process NEXT_PUBLIC_COP_TOKEN, and Next compiles it into the dev chunks, so anything able to
 * ask `localhost:3210` for a script can read it there. That includes a command step the bot runs,
 * which could then drive the API that approves its own steps. A step is not handed the token
 * (src/exec/stepEnv.ts drops every NEXT_PUBLIC_COP_* and COP_* name, whatever its case), and one
 * that writes out the address of the API or the page is refused (src/exec/network.ts). That
 * refusal matches the address as it is written, in the command or in a script file the command
 * runs, though: a step that computes the port (`3200+10`) is not caught, and can read the token
 * from the dev chunks. That is the accepted cost of the operator's decision. Only the package's
 * static interface keeps the token out of every file it serves.
 *
 * A `#token=…` link is read as well, for a link someone writes by hand: nothing prints one. The part
 * after `#` never leaves the browser (it is not sent to the server and not logged), and the page
 * moves it into this browser's storage and removes it from the address bar. See
 * `src/api/security.ts` for what the token guards.
 */
export function apiToken(): string {
  if (typeof window === 'undefined') return process.env.NEXT_PUBLIC_COP_TOKEN ?? '';
  try {
    const m = /(?:^#|&)token=([0-9a-f]{16,})/i.exec(window.location.hash);
    if (m) {
      window.localStorage.setItem(TOKEN_KEY, m[1]!);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      return m[1]!;
    }
    // A key handed over by the #token= link wins; otherwise the one `npm start` built in.
    return window.localStorage.getItem(TOKEN_KEY) || (process.env.NEXT_PUBLIC_COP_TOKEN ?? '');
  } catch {
    return '';
  }
}

/**
 * The token as a query parameter, for the two kinds of request that cannot carry a header:
 * `EventSource`, which has no way to set one, and a plain `<a download>`, which is the browser
 * fetching a URL on its own. Everything else sends it as a header instead.
 */
export function withToken(url: string): string {
  const token = apiToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting-approval'
  | 'done'
  /** Reached its end without the work being done, and said what it tried and what is in the way. */
  | 'blocked'
  | 'failed'
  | 'aborted'
  | 'limit-reached';

/** One finished attempt of a task, kept when the task is queued again. */
export type TaskAttempt = {
  runId?: string;
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
  /** What the independent review concluded about this attempt. */
  review?: TaskReview;
  /** What this attempt ran with, so an edit cannot rewrite what was already asked. */
  title?: string;
  prompt?: string;
  level2?: string;
  vcs?: TaskVcs;
  /** The plan this attempt made (plan mode). */
  plan?: TaskPlan;
  /** Undone by the operator: `this` its work taken out, `back` the line put back to before it. */
  undone?: { how: 'this' | 'back'; at: string; commit?: string; branch?: string; byTask?: string };
  accepted?: { at: string; note?: string; was: TaskStatus; reason?: string };
};

/** What "Undo only this task" would do; see `UndoThisPreview` on the server. */
export type UndoThisPreview = {
  ok: boolean;
  problem?: string;
  repoDir: string;
  perTask?: boolean;
  branch?: string;
  commits: string[];
  files: string[];
  later: string[];
  nothing?: string;
  baseCommit?: string;
};

/** Kerrigan's changes, read against the sessions as they are; see `plan/changes.ts`. */
export type ChangesCheck =
  | { ok: true; notes: string; changes: Array<{ index: number; says: string; sessionId: string; sessionName: string; taskId?: string; taskTitle?: string }>; warnings: string[] }
  | { ok: false; issues: Array<{ path: string; message: string }>; warnings: string[] };

/** The project folder the workbench has open; see `session/workspace.ts`. */
export type Workspace = { dir: string; name: string; ok: boolean; isRepo: boolean; branch?: string; problem?: string };
/** "New branch from main" (2026-10-26): what it would start from. See `NewBranchPlan` in src/vcs/newBranch.ts. */
export type NewBranchPlan = {
  ok: boolean;
  problem?: string;
  repoDir: string;
  branch?: string | null;
  head?: string;
  remote?: string;
  target?: string;
  targetCommit?: string;
  targetSubject?: string;
  fetched?: { ok: boolean; detail?: string; auth?: boolean; asked: boolean };
  lastFetched?: string;
  changed: string[];
  untracked: string[];
  suggested?: string;
  fingerprint?: string;
};
/** What is not committed: taken to the new branch, put aside on a branch of its own, or committed on the branch it is on. */
export type NewBranchCarry = 'take' | 'aside' | 'commit';
export type NewBranchResult =
  | { ok: true; branch: string; commit: string; target: string; saved?: { branch: string; commit: string; files: number }; committed?: { branch: string; commit: string; files: number }; carried: number; result: string }
  | { ok: false; problem: string; conflict?: boolean };
/** `version` is a fingerprint of the file as read; saving over it is refused once the file changed on disk. */
export type WorkspaceFile = { path: string; text: string | null; binary: boolean; tooLarge: boolean; size: number; version?: string };
export type ChatThread = { id: string; name: string; createdAt: string; status: 'idle' | 'running' | 'stopping'; turns: number; running: boolean; repoDir: string };
export type ChatSent = { threadId: string; taskId: string; noted?: boolean; needsStart: boolean };
/** A task of the queue (2026-10-24), as `src/queue/queue.ts` keeps it. */
export type QueueItem = {
  id: string;
  /** Its name in the list and the picture (2026-10-24); empty: the task's first line. */
  name?: string;
  prompt: string;
  model: string;
  dependsOn: string[];
  branch: 'folder' | 'main';
  review: boolean;
  reviewModel?: string;
  /** Two chats: a lead on `model`, a worker on `workerModel` (2026-10-24). */
  lead?: boolean;
  workerModel?: string;
  /** One of Settings' skills, by its name, sent with the task (2026-10-25). */
  skill?: string;
  /** "Plan first" (2026-10-26): its plan, the lead's with two chats, approved by the operator before the work. */
  plan?: boolean;
  /** The branch made for it when it was added, the commit it was made at, and what from (2026-10-26). */
  branchName?: string;
  branchBase?: string;
  branchFrom?: string;
  /** Parked: what it waits for (2026-10-26). See `Parked`. */
  waitsFor?: Parked;
  /** Answered after it was parked: it carries on at the queue's next turn, before the others. */
  resume?: boolean;
  /** `parked`: set aside while it waited for the operator, until answered (2026-10-26). */
  status: 'waiting' | 'running' | 'done' | 'failed' | 'skipped' | 'stopped' | 'parked';
  why?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
};
/** What a task of the queue waited for when it was set aside (2026-10-26). See `Parked` in src/session/model.ts. */
export type ParkedKind = 'plan' | 'question' | 'retry' | 'command' | 'model' | 'password';
export type Parked = { kind: ParkedKind; at: string; approval: Approval; answer?: { kind: string; at: string } };
/** The operator's answer to it, as the card sends it; `{ stop: true }` stops the task. */
/**
 * Commands the chat handed to the operator to run themselves (2026-10-26; revisions 2026-10-27): the lines, the folder,
 * what should be seen and how it should end, what the chat says they reach and change, the scripts in full, what the bot
 * reads in them, the lines and scripts the bot would refuse, the revision. See the server's `HandoffCard`.
 */
export type HandoffCard = {
  revision?: number;
  why?: string;
  commands: string[];
  cwd: string;
  expect: string;
  exit?: string;
  network?: string;
  platforms?: string;
  changes?: string;
  files: Array<{ path: string; abs?: string; text?: string; cut?: boolean; problem?: string }>;
  seen?: { network?: string; platform?: string };
  outside?: boolean;
  warnings?: string[];
};
/** How the operator answered a handoff: ran it, sent it back for a correction, or will not run it. */
export type HandoffOutcome = 'ran' | 'revise' | 'declined';

export type ParkedAnswerInput =
  | { decision: 'approve' | 'revise'; note?: string }
  | { answer: string; /** A handoff: false when the operator did not run the commands. */ ran?: boolean; /** A handoff: how it was answered. */ outcome?: HandoffOutcome }
  | { choice: RetryChoice }
  | { decision: 'run' | 'skip' }
  | { resume: true }
  | { stop: true };
/** What has the browser now, other than the queue's own task: the queue's next task starts after it (2026-10-25). */
export type QueueBusy = { kind: 'chat'; sessionId: string; title: string } | { kind: 'models' } | { kind: 'login' };
/** `parkAfterSec`: how long a task may wait for the operator before it is set aside (2026-10-26); 0: as long as it takes. */
export type Queue = { items: QueueItem[]; running: boolean; updatedAt: string; busy?: QueueBusy; parkAfterSec?: number };

export type RepoTree = { ref: string; label: string; path: string; entries: Array<{ name: string; path: string; type: 'dir' | 'file'; size?: number }> };
export type RepoFile = { ref: string; label: string; path: string; text: string | null; binary: boolean; tooLarge: boolean };
export type RepoLog = { ref: string; label: string; commits: Array<{ sha: string; subject: string; author: string; at: string; taskId?: string; taskTitle?: string }> };


/** One condition that has to hold before a task is allowed to end. */
export type TaskCheck = {
  name: string;
  expect:
    | 'exit-zero'
    | 'exit-nonzero'
    | 'output-contains'
    | 'output-omits'
    | 'output-matches'
    | 'file-exists'
    | 'file-missing'
    | 'file-contains';
  run?: string;
  shell?: 'pwsh' | 'powershell' | 'cmd';
  cwd?: string;
  file?: string;
  value?: string;
};

/** Whether a session's work is checked by a second, independent conversation, and on what. */
export type ReviewSettings = { enabled: boolean; model: string };

/** One thing an independent review found wrong, with what proves it. */
export type ReviewFinding = {
  /** Round and position, `r1f2`, with the attempt from the second on, `a2r1f2`: what a dispute names. */
  id?: string;
  what: string;
  evidence: string;
  where?: string;
  /** Whose problem it is: the work, or the task that asked for it. */
  about?: 'work' | 'task';
  /** An earlier round raised the same finding at the same place, and it came back. */
  repeated?: boolean;
};

/** One instruction the model could not follow as written: which, what it did instead, and why. */
export type TaskDeviation = { instruction: string; did: string; why: string };

/** One review finding the model said was wrong: which (by id), why, and what shows it. */
export type TaskDispute = { finding: string; why: string; evidence: string };

/** A check a reviewer gave with a finding, kept with the task for every later attempt. */
export type TaskReviewCheck = {
  check: TaskCheck;
  findingId: string;
  what: string;
  where?: string;
  round: number;
  attempt: number;
  /** suspended: disputed, until the next review rules; dropped: the next review did not raise it again. */
  state: 'active' | 'suspended' | 'dropped';
};

/** What an independent review concluded about a task. */
export type TaskReview = {
  verdict: 'pass' | 'fail' | 'error' | 'skipped';
  /** For `skipped`: why no review ran. */
  skippedBecause?: string;
  rounds: number;
  /** How many commands the reviewer ran. A pass with none is refused before it reaches here. */
  stepsRun: number;
  summary?: string;
  findings?: ReviewFinding[];
  /** Set when the review could not be carried out, which is not the work's fault. */
  problem?: string;
  model?: string;
};

/** How one check turned out the last time it ran. */
export type TaskCheckResult = { name: string; passed: boolean; detail: string };

/** The kinds that ask about a command rather than about a file. */
export const CHECK_KINDS: TaskCheck['expect'][] = [
  'exit-zero',
  'exit-nonzero',
  'output-contains',
  'output-omits',
  'output-matches',
  'file-exists',
  'file-missing',
  'file-contains',
];

export function checkNeedsCommand(expect: TaskCheck['expect']): boolean {
  return expect.startsWith('exit-') || expect.startsWith('output-');
}

export function checkNeedsValue(expect: TaskCheck['expect']): boolean {
  return expect === 'output-contains' || expect === 'output-omits' || expect === 'output-matches' || expect === 'file-contains';
}

export type Task = {
  id: string;
  title: string;
  level2: string;
  prompt: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  runId?: string;
  iterations: number;
  firstMessage?: string;
  summary?: string;
  finalReply?: string;
  reason?: string;
  /** Instructions the model could not follow as written, with what it did instead and why. */
  deviations?: TaskDeviation[];
  /** Review findings the model disputed, with its evidence. */
  disputes?: TaskDispute[];
  /** Checks reviewers gave with their findings; not cleared by a re-run. */
  reviewChecks?: TaskReviewCheck[];
  /** Processes left running by the task or a review and stopped by the runner, with where they came from. */
  leftovers?: Array<{ pid: number; name: string; command: string; ports: number[]; by: string }>;
  /** The machine's tools when the task ran. */
  environment?: {
    collectedAt: string;
    os: string;
    node: string;
    npm: string | null;
    git: string | null;
    pwsh: string | null;
    powershell: string | null;
    edge: { path: string; version: string | null } | null;
  };
  logFile?: string;
  /** 1 for the first run, one higher after every re-run. */
  attempt?: number;
  continuing?: {
    fromAttempt: number;
    stoppedBecause?: string;
    how?: 'limit' | 'interrupted' | 'stopped' | 'failed';
    /** The operator's new prompt for this attempt. */
    instruction?: string;
    /** How the attempt it carries on ended, as the chat was told. */
    ended?: { status: TaskStatus; reason?: string; summary?: string; failedChecks?: Array<{ name: string; detail: string }>; findings?: Array<{ what: string; where?: string; evidence: string }> };
  };
  /** Attempts that already finished, oldest first. */
  attempts?: TaskAttempt[];
  /** The press of a start button this task ran under. Tasks sharing one ran together. */
  runGroup?: TaskRunGroup;
  vcs?: TaskVcs;
  /** The branch and commit message this task was asked to use, when someone chose them. */
  vcsPlan?: { branch?: string; commitMessage?: string };
  /** What must be true before this task is allowed to end. */
  checks?: TaskCheck[];
  /** How those checks turned out the last time they ran. */
  checkResults?: TaskCheckResult[];
  /** Turns the independent review off for this one task. Absent means the session decides. */
  reviewEnabled?: boolean;
  /** The task must not change files; the runner fails it if the tree changed. */
  readOnly?: boolean;
  /** The paths the task may change; the runner puts back changes outside them. Absent means anywhere. */
  scope?: string[];
  /** What the runner put back because it was outside `scope`. */
  scopeReverted?: string[];
  /** The operator's input files the runner put back because the task changed them. */
  inputsRestored?: string[];
  /** Evidence files kept with the attempt's record, never committed. */
  artifactsKept?: Array<{ path: string; size: number; sha256: string }>;
  /** How the attempt ended, in one fixed shape the runner put together from its own records. */
  handoff?: Handoff;
  /** Why it stopped, when the status alone does not say. See `Task.stopCode` in src/session/model.ts. */
  stopCode?: StopCode;
  /** The setting whose limit ended the attempt, when one did. */
  limit?: TaskLimit;
  /** What the independent review concluded, once it has run. */
  review?: TaskReview;
  /** The plan this attempt made before changing anything (plan mode). */
  plan?: TaskPlan;
  /** A task of the queue set aside while it waited for the operator, and the answer once given (2026-10-26). */
  parked?: Parked;
  /** Who is at work on it right now; gone when the attempt ends. */
  acting?: Acting;
  /** The operator's notes to the chat about this task; each goes out with the task's next message. */
  notes?: Array<{ id: string; text: string; at: string; sentAt?: string; attempt?: number }>;
  /** Accepted as done by the operator though it did not end so. */
  accepted?: { at: string; note?: string; was: TaskStatus; reason?: string };
  /** A chat message: the folder as it was before it first ran, which "go back" puts back. */
  checkpoint?: { commit: string; head: string; branch: string; at: string };
  /** Two chats (2026-10-20): what the lead of this message did. See `LeadRecord`. */
  lead?: LeadRecord;
  /** A worker's subtask: the lead's message it is part of. */
  fromLead?: { sessionId: string; taskId: string; n: number };
  /** The skill the message was sent with, as it read then (2026-10-21). */
  skill?: { name: string; description: string; text: string };
};

export type VersionControl = {
  enabled: boolean;
  repoDir: string;
  branchMode: 'per-task' | 'per-session';
  commitOnFinish: boolean;
  branchPrefix: string;
  /** The one branch a per-session run works on. Empty means it is derived from the name. */
  branchName?: string;
  /** Where the session's first branch is cut from. Absent means wherever the repository is. */
  startFrom?: 'branch' | 'previous-session' | 'head' | 'existing-branch';
  /** The local branch `startFrom: branch` starts from; `main` when empty. */
  baseBranch?: string;
  /** The remote the start window chose `baseBranch` (or `existingBranch`) from: the remote branch, as fetched there. */
  baseRemote?: string;
  /** For `startFrom: existing-branch`: the branch every task works on, exactly as named. */
  existingBranch?: string;
  /** Fetch and fast-forward the starting branch before the session's first branch. Absent means yes. */
  updateFromRemote?: boolean;
  /** Uncommitted changes before the first task: kept out (absent), or taken as a starting snapshot. */
  dirtyWorktree?: { policy: 'reject' | 'snapshot' | 'tracked-only-snapshot'; requireApproval?: boolean };
  /** The operator's input files: in every session's start, read-only unless `readOnly` is false. */
  userInputs?: { paths: string[]; readOnly?: boolean; requireApproval?: boolean };
  /** Evidence kept with the run and never committed. */
  artifacts?: { paths: string[] };
};

/** Where a session's first branch was actually cut from, recorded at its first run. */
export type SessionStart = {
  kind: 'branch' | 'previous-session' | 'head' | 'existing-branch' | 'snapshot';
  /** What bringing the starting branch up to its remote did. */
  update?: { branch: string; remote?: string; outcome: string; from?: string; to?: string; detail?: string };
  commit: string;
  branch?: string;
  /** For `branch`: the remote whose branch it started from; `branch` is then `origin/x`. */
  remote?: string;
  fromSession?: { id: string; name: string };
  note?: string;
  /** For `snapshot`: where the operator's changes were taken from, and what went in. */
  snapshot?: { fromBranch?: string; fromCommit: string; included: string[]; leftOut: string[]; approved: boolean };
  /** The input files in the start, with their sums; `carried` when the runner committed them on top of it. */
  inputs?: {
    patterns: string[];
    files: Array<{ path: string; sha256: string; size: number; blob: string }>;
    readOnly: boolean;
    carried?: { onto: string; from: string; branch: string };
  };
};

/** One uncommitted file on the starting-snapshot list, and what may be done with it. */
export type SnapshotEntry = {
  path: string;
  from?: string;
  kind: 'tracked' | 'untracked' | 'ignored';
  allowed: Array<'include' | 'leave-out'>;
  choice: 'include' | 'leave-out' | null;
  reason?: string;
  input?: boolean;
  size?: number;
};

export type RunVcsActionId = 'review-inputs' | 'snapshot-on-base' | 'snapshot-here' | 'use-current-branch' | 'allow-snapshot';

/** Version control for a run, per repository; see src/vcs/runPreflight.ts. */
export type RunVcsGroup = {
  repoDir: string;
  ready: boolean;
  problem?: string;
  branch: string | null;
  head: string | null;
  baseBranch?: string;
  baseHead?: string | null;
  sessions: Array<{ id: string; name: string; startFrom: string; started: boolean; hasStart: boolean; role: 'first' | 'shares' | 'inherits' | 'own' }>;
  workBranch?: { name: string; head: string | null };
  /** Not ready only because of where a session starts: the start window can choose past it. */
  startChoiceCanFix?: boolean;
  inputPatterns: string[];
  inputs: SnapshotEntry[];
  unrelated: Array<{ path: string; reason?: string }>;
  entries: SnapshotEntry[];
  actions: Array<{ id: RunVcsActionId; available: boolean; recommended?: boolean; result: string; why?: string }>;
};

export type SnapshotPlan = {
  needed: boolean;
  ok: boolean;
  problem?: string;
  policy: 'reject' | 'snapshot' | 'tracked-only-snapshot';
  requireApproval: boolean;
  repoDir: string;
  branch: string | null;
  head: string | null;
  baselineBranch?: string;
  entries: SnapshotEntry[];
};

/** What version control did for one attempt of a task. */
export type TaskVcs = {
  branch?: string;
  baseCommit?: string;
  commit?: string;
  commits?: string[];
  /** The files that commit touched. -1 for either count means a binary file. */
  files?: Array<{ path: string; added: number; removed: number }>;
  /** Committed files that look like tool output or secrets, pointed out once and left in place. */
  suspicious?: Array<{ path: string; reason: string }>;
  foreignCommits?: string[];
  problem?: string;
};

/** What going back to the code from before a task would do. */
export type RestorePreview = {
  ok: boolean;
  problem?: string;
  repoDir: string;
  baseCommit?: string;
  currentBranch?: string;
  /** Commits the restored branch will not have, newest first. */
  leftBehind: string[];
  /** The branch those commits stay on. Nothing is deleted. */
  keptOn?: string;
  branchName?: string;
};

export type RestoreResult = {
  ok: boolean;
  problem?: string;
  branch?: string;
  commit?: string;
  leftBehind?: string[];
  keptOn?: string;
};

/** Whether version control can do its job in a session right now. */
export type VcsStatus = {
  ok: boolean;
  repoDir: string;
  /** The branch HEAD is on right now, which after a per-task run is only the last task's. */
  branch?: string;
  problem?: string;
  git?: string | null;
  /** The repository's local branches, for "carry on an existing branch". */
  branches?: string[];
  /** Before the first task, under a snapshot policy: the uncommitted files to approve. */
  snapshot?: SnapshotPlan;
  /** Where the session's work is: one branch, or one per task. */
  work?: {
    mode: 'per-task' | 'per-session';
    complete?: string;
    branches: Array<{ title: string; branch: string; commit?: string; status: string }>;
  };
};

/** What "Sign in" from Settings found once the chat was there. */
export type LoginResult = { ok: boolean; accounts: string[]; account?: string; matched?: boolean; message: string };

export type FolderPick = { ok: true; path: string } | { ok: false; cancelled: boolean; reason?: string };

/** One task of one session, as the registry page lists it. */
export type RegistryEntry = {
  sessionId: string;
  sessionName: string;
  sessionStatus: 'idle' | 'running' | 'stopping';
  sessionRunning: boolean;
  /** Whether the session is one chain (a failed task stops the rest) or independent tasks. */
  sessionOnFailure: 'stop' | 'continue';
  /** Where the session sat in the last run that selected it, so a continuation keeps that order. */
  sessionRunOrder?: number;
  chatUrl?: string;
  taskId: string;
  title: string;
  status: TaskStatus;
  position: number;
  queuePosition?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  iterations: number;
  summary?: string;
  reason?: string;
  runId?: string;
  runGroup?: TaskRunGroup;
  /** What an independent review concluded, in the short form a row has space for. */
  review?: { verdict: TaskReview['verdict']; findings: number; stepsRun: number };
  /** How many instructions the model declared it could not follow as written. */
  deviations?: number;
  /** How many review findings the model disputed. */
  disputes?: number;
  /** The task must not change files. */
  readOnly?: boolean;
  /** The paths the task may change. */
  scope?: string[];
  stopCode?: StopCode;
  /** The session is set aside: its tasks are not offered to run. */
  sessionInactive?: boolean;
  /** Which attempt this row describes. 1 unless the task has been run again. */
  attempt?: number;
  /** How many times the runner ran it again in a fresh chat after it blocked, on its own. */
  autoRetries?: number;
  /** The attempts before it, oldest first, each with its own run folder and log. */
  attempts?: Array<{
    attempt: number;
    status: TaskStatus;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    iterations: number;
    summary?: string;
    reason?: string;
    runId?: string;
    branch?: string;
    /** How many files that attempt's commit changed; absent when it committed nothing. */
    changedFiles?: number;
  }>;
  /** How many files this attempt's commit changed; absent when it committed nothing. */
  changedFiles?: number;
  /** Aborted because the bot itself stopped under it (power, Ctrl+C, a crash), not continued yet. */
  interrupted?: boolean;
  /** The setting whose limit ended the attempt, when one did. */
  limit?: TaskLimit;
  /** "Continue" can carry it on where it stopped, in its chat and on its branch. */
  continuable?: boolean;
  /** This attempt's branch, the commit its work was put in, and why nothing was. */
  branch?: string;
  commit?: string;
  vcsProblem?: string;
};

/**
 * The press of a start button a task ran under.
 *
 * Several sessions started together share one, which is what lets the register say which
 * tasks went out as a single decision rather than merely at a similar time.
 */
export type TaskRunGroup = { id: string; startedAt: string; sessions: number; name?: string };

/** Whether the bot is working. Cheap enough to ask from every page on a timer. */
/**
 * Who works, or asks (2026-10-22): the chat writing its plan in plan mode, the lead of two chats, the worker — the chat
 * doing the work, the worker of two chats or the one chat — and the independent reviewer.
 */
export type Actor = 'plan' | 'lead' | 'worker' | 'review';
/** Who is at work on a task now, and since when; the subtask the worker is on, or the review's round. */
export type Acting = { actor: Actor; since: string; subtask?: number; round?: number };

/** Whether the bot is working, and who in the run going now (answered from memory: polling it is fine). */
export type Activity = {
  running: boolean;
  sessions: number;
  starting: boolean;
  acting?: Acting;
  paused?: boolean;
  /** Git asks for a password in its own window, and the work waits for it (2026-10-26). */
  password?: boolean;
  /** How the last message ended, while nothing runs (2026-10-23). */
  last?: { status: string; at: string };
};

export type RunMode = 'confirm' | 'unattended';
export type OnFailure = 'stop' | 'continue';

/**
 * What starting again from one task would do.
 *
 * Not the same as re-running that task. This is the answer to what happens after a failure in
 * the middle of a run: the code goes back to before the task that broke, and that task and
 * everything after it across the whole run — including tasks that never got their turn and
 * sessions that were never reached — is queued and started again.
 */
export type RestartPlan = {
  ok: boolean;
  problem?: string;
  runId?: string;
  runStartedAt?: string;
  from: { sessionId: string; sessionName: string; taskId: string; title: string; status: TaskStatus };
  tasks: Array<{
    sessionId: string;
    sessionName: string;
    taskId: string;
    title: string;
    status: TaskStatus;
    alreadyQueued: boolean;
  }>;
  sessions: Array<{ id: string; name: string; tasks: number }>;
  restores: Array<{
    repoDir: string;
    ok: boolean;
    problem?: string;
    forTask: string;
    baseCommit?: string;
    branchName?: string;
    leftBehind: string[];
    keptOn?: string;
    /** Later sessions in this repository moved onto a new branch, with their own commits that stay behind. */
    laterSessions?: Array<{ sessionName: string; branch: string; commits: string[] }>;
  }>;
  /** How the run it repeats was started; `confirm` when it left no record of its own. */
  mode: RunMode;
  /**
   * Why this machine would refuse that run unattended now, when it was: the dialog then offers it
   * step by step, saying this.
   */
  unattendedRefused?: string;
  onFailure: OnFailure;
};

/** The smallest change to a task's contract that removes one contradiction; see `ContractFix` in the API. */
export type ContractFix =
  | { kind: 'add-to-scope'; path: string }
  | { kind: 'not-read-only'; scope: string[] }
  | { kind: 'drop-scope' }
  | { kind: 'drop-check'; check: string };

/** One way a task contradicts itself, and the ways out of it, least change first. */
export type ContractConflict = { text: string; fixes: ContractFix[] };

export type RestartResult = {
  started: boolean;
  reason?: string;
  requeued: number;
  restored: string[];
};

export type Chat = { chatId: string; url: string; name: string; runId: string; createdAt: string };

export type ModelOption = {
  name: string;
  raw: string;
  selected: boolean;
  disabled: boolean;
  role: string;
  /** The submenu it lives in, when the picker nests it under a vendor. */
  group?: string;
  groupRaw?: string;
};

/** What the chat's own picker offered when it was last read. Never a hard-coded list. */
export type ModelCatalogue = {
  options: ModelOption[];
  current?: string;
  readAt: string | null;
  note?: string;
  /** The model a newly created session starts on. Empty means the chat is left alone. */
  defaultModel: string;
  /** The model a new session's independent review runs on. Empty means the session's own. */
  defaultReviewModel: string;
  /** The model the lead of two chats starts on (2026-10-23). Empty leaves its chat on whatever it is. */
  defaultLeadModel: string;
};

export type Session = {
  /** `false` when set aside on the Sessions page: not started by anything until made active. */
  active?: boolean;
  /** Where it sits in the sessions list, smaller higher; the API returns the list in this order. */
  position?: number;
  id: string;
  name: string;
  createdAt: string;
  status: 'idle' | 'running' | 'stopping';
  chat?: Chat;
  contractSent: boolean;
  /** The model this conversation should run on, by the picker's exact name. */
  model?: string;
  /** The model is set by hand in the Copilot window; the run waits on a card after signing in. */
  manualModel?: boolean;
  /** When the operator last set it by hand in this conversation, and what the picker showed then. */
  modelByHand?: { at: string; shown: string | null; asked?: string };
  /** Who chose `model` / the review's model: the plan, or the operator here. Settings outrank the plan's. */
  modelSource?: 'plan' | 'operator';
  reviewModelSource?: 'plan' | 'operator';
  /** What the picker reported after the last run applied that choice. */
  modelInUse?: string;
  /** Whether the queue is one chain ('stop') or a set of independent tasks ('continue'). */
  onFailure?: 'stop' | 'continue';
  /** Sessions with the same group share one Copilot conversation. */
  conversationGroup?: string;
  /** Plan mode for this session's tasks; absent follows Settings. */
  planMode?: 'off' | 'auto' | 'approve';
  /** A conversation of the workbench's chat: each message is a task of it. */
  kind?: 'chat';
  /** Two chats (2026-10-20): this conversation is the lead's; its worker is a session of its own. */
  lead?: { workerSessionId?: string; workerModel?: string; workerManualModel?: boolean };
  /** A worker's session: the lead's it works for. */
  workerOf?: string;
  /** A conversation the queue made for one of its tasks: that task's id in the queue (2026-10-24). */
  queueItem?: string;
  /** The name of the plan this session was imported from, offered as the run's name. */
  planName?: string;
  vcs?: VersionControl;
  vcsBaseCommit?: string;
  vcsStart?: SessionStart;
  /** Whether a second, independent conversation checks the work. On unless said otherwise. */
  review?: ReviewSettings;
  /** The folder the session's work is about: where its commands run, and its repository when none is set. */
  projectDir: string;
  tasks: Task[];
  running: boolean;
  /** Paused by the operator ("Pause"): the run holds at its next message or command until "Continue". */
  paused?: boolean;
  /** The run's pauses, from "Pause" to "Continue" (the last open while paused): not counted in a task's minutes. */
  pauses?: Array<{ from: string; to?: string }>;
  /** How the run in progress is answering approvals right now. Absent when nothing runs. */
  runMode?: 'confirm' | 'unattended';
  pending?: Approval[];
};

export type Approval = {
  id: string;
  sessionId: string;
  taskId: string;
  stepId: number;
  description: string;
  createdAt: string;
  /** Who asks: the chat writing its plan, the lead, the worker or the reviewer. Absent on older cards. */
  actor?: Actor;
  /** Set when the step was held because it downloads; asked about even in an unattended run. */
  network?: string;
  /** Set when the step reaches a platform with the operator's access (Azure, AWS, GitHub…); asked about in every run. */
  platform?: string;
  /** Set when its program is set to read only and this command could not be read as only reading: why, in English. */
  readOnly?: string;
  /** Scripts the bot wrote that this step runs, which Settings let it run, each with its text (2026-10-27). */
  scripts?: Array<{ path: string; kind: string; text?: string; cut?: boolean; problem?: string; script?: string }>;
  /** Set when this asks the operator to choose the model in the Copilot window; see the server's `PendingApproval`. */
  /** `review`: the model of the review's own conversation, best another, stronger one than the work's. */
  model?: { asked: string; shown: string | null; why: string; tries: number; manual?: boolean; review?: boolean; role?: 'lead' | 'worker' };
  /** Set when this is a task's plan waiting for approval (plan mode). */
  plan?: { title: string; plan: TaskPlan };
  /** Two chats: the lead's question for the operator, answered with text. */
  /** `commands`: by answer, the command the bot runs when that one is chosen, or null. */
  question?: { text: string; why?: string; options: string[]; commands?: Array<string | null>; handoff?: HandoffCard };
  /** Two chats: a subtask that ended for a technical reason, and what to do with it; see the server's `PendingApproval`. */
  retry?: { n: number; title: string; attempt: number; maxAttempts: number; category: SubtaskFailure; reason: string; sideEffects: SideEffects; changed: string[]; choices: RetryChoice[] };
};

/** Why a subtask's attempt ended without its work (two chats, 2026-10-25). See `SubtaskFailure` in src/session/model.ts. */
export type SubtaskFailure = 'TRANSIENT_CHAT_FAILURE' | 'COMMAND_INFRASTRUCTURE_FAILURE' | 'TASK_EVIDENCE_FAILURE' | 'USER_STOPPED' | 'UNKNOWN_SIDE_EFFECT_STATE';
/** What an attempt left in the folder: nothing, changes the next one carries on from, or not known. */
export type SideEffects = 'none' | 'changed' | 'unknown';
/** The operator's answer for a subtask that ended for a technical reason. */
export type RetryChoice = 'same' | 'fresh' | 'continue' | 'restore' | 'accept';
/** One attempt at a subtask: each its own task of the worker. See `SubtaskAttempt` on the server. */
export type SubtaskAttempt = {
  attempt: number;
  taskId: string;
  status: TaskStatus;
  category?: SubtaskFailure;
  reason?: string;
  chatId?: string;
  startedAt?: string;
  endedAt?: string;
  commands: { started: number; completed: number };
  repoChanged: boolean | null;
  sideEffects?: SideEffects;
  retryOf?: number;
  fresh?: boolean;
  continued?: boolean;
  restored?: boolean;
  by?: 'settings' | 'operator' | 'after-stop';
};

/** One reply of the lead (two chats): what it decided, and what came of it. */
export type LeadRound = {
  n: number;
  at: string;
  status: 'delegate' | 'plan' | 'ask' | 'done' | 'blocked';
  understanding?: string;
  notes?: string;
  /** `taskId` is the latest attempt's; `attempts` once there was more than one way to end (2026-10-25). */
  subtask?: { n: number; taskId: string; title: string; readOnly?: boolean; fresh?: boolean; attempts?: SubtaskAttempt[]; maxAttempts?: number };
  question?: { text: string; why?: string; options?: string[]; answer?: string; at?: string };
  /** This reply made the list of subtasks or changed it: its version, how many came and went, how many in all. */
  ledger?: { revision: number; added: number; removed: number; total: number };
};

/** One subtask of the lead's list as it plans them (2026-10-21); `n` once it has been given to the worker. */
export type LeadTodo = { title: string; status: 'done' | 'running' | 'planned' | 'blocked' | 'failed'; phase?: string; n?: number };
/** The lead's list of subtasks: its version, the subtasks, and what its last change added and dropped. */
export type LeadLedger = { revision: number; items: LeadTodo[]; at: string; added?: string[]; removed?: string[] };

/** What the lead of a message did, as the chat shows it. */
export type LeadRecord = { rounds: LeadRound[]; subtasks: number; maxSubtasks: number; evidence?: string[]; workerSessionId?: string; messages?: { lead: number; worker: number }; ledger?: LeadLedger };

/** A task's plan, in plan mode: see `TaskPlan` on the server. */
export type TaskPlan = {
  existing: string;
  approach: string;
  steps: string[];
  files: string[];
  verification: string;
  risks?: string;
  version: number;
  at: string;
  approved?: { by: 'operator' | 'auto'; at: string; note?: string; why?: string };
  revisions?: Array<{ version: number; comment: string; at: string }>;
};

/** One thing wrong with a pasted plan, with the place in the document it is wrong at. */
export type PlanIssue = { path: string; message: string };

export type PlanSummary = {
  plan: string;
  notes: string;
  /** What a run across these sessions does when a whole session fails. */
  onFailure: 'stop' | 'continue';
  /** Whether the sessions share one Copilot conversation. */
  conversation: 'per-session' | 'shared';
  sessions: Array<{ name: string; tasks: string[]; model: string; onFailure: 'stop' | 'continue'; repoDir: string }>;
  taskCount: number;
};

/** A session that already exists with exactly the tasks this plan would create again. */
export type PlanDuplicate = { name: string; sessionId: string; createdAt: string; tasks: number };

/** What a plan means, or what is wrong with it. Both are answers the operator is shown. */
export type PlanCheck =
  | { ok: true; warnings: string[]; summary: PlanSummary; duplicates: PlanDuplicate[] }
  | { ok: false; issues: PlanIssue[]; warnings: string[]; duplicates: PlanDuplicate[] };

export type ImportResult = {
  sessions: Array<{ id: string; name: string; tasks: number; titles: string[] }>;
  taskCount: number;
  warnings: string[];
};

export type PlanImport =
  | { ok: true; result: ImportResult; summary: PlanSummary; duplicates: PlanDuplicate[] }
  | { ok: false; check: PlanCheck };

/** One session's place in a run across several sessions. */
export type BatchSession = {
  sessionId: string;
  name: string;
  state: 'waiting' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped';
  ran: number;
  failed: number;
  reason?: string;
};

export type BatchState = {
  id: string;
  startedAt: string;
  finishedAt?: string;
  mode: 'confirm' | 'unattended';
  /** Whether the sessions are a chain ('stop') or separate pieces of work ('continue'). */
  onFailure: 'stop' | 'continue';
  stopping: boolean;
  /** Asked to hold after the task that is running, rather than after its current step. */
  pausing: boolean;
  running: boolean;
  sessions: BatchSession[];
};

/** One of the other folders the operator works in, by name, with whether it can carry version control. */
/** One project as Settings show it: its folder, whether it is a repository and on which branch, and its level 2. */
export type ProjectEntry = {
  name: string;
  rootDir: string;
  repoOk: boolean;
  repoProblem?: string;
  /** The branch checked out there now; 'HEAD' on none. Absent outside a repository. */
  branch?: string;
  /** What the operator wrote about the project, for Kerrigan. */
  level2: string;
  /** For reference only: the bot changes nothing in it (2026-10-21). */
  readOnly: boolean;
};
export type OtherProject = ProjectEntry;

/** The folder's code searched (2026-10-21): see `workspaceSearch.ts` on the server. */
export type SearchResult = {
  files: Array<{ path: string; matches: Array<{ line: number; text: string; ranges: Array<[number, number]>; column?: number; length?: number }> }>;
  total: number;
  truncated: boolean;
  ms: number;
  problem?: string;
};

/** A skill (2026-10-21): instructions for a kind of task, sent with the message it is chosen for. */
export type Skill = { name: string; description: string; text: string; projectDir: string };
export type SkillList = { skills: Skill[]; maxDescription: number };

/** The chat's folder, the first project, and the others by name. */
export type ProjectDefault = ProjectEntry & { others: ProjectEntry[] };

/** One thing that happened in a task attempt, as the run folder recorded it. */
export type StoryEntry =
  | { kind: 'sent'; iteration: number; label: string; text: string; at?: string }
  | { kind: 'reply'; iteration: number; label: string; text: string; status?: string; notes?: string; at?: string }
  | { kind: 'step'; iteration: number; id: number; command: string; output: string; outcome?: string; exitCode?: number; durationMs?: number; failed: boolean; at?: string }
  | { kind: 'review'; round: number; entries: StoryEntry[]; at?: string }
  /** Commands handed to the operator: the card as it was shown, and how it was answered (2026-10-27). */
  | { kind: 'handoff'; revision: number; card: HandoffCard; outcome: string; answer?: string; at?: string; answeredAt?: string };

/** A file a task changed. `added`/`removed` are -1 for a binary file. */
export type ChangedFile = { path: string; oldPath?: string; status: string; added: number; removed: number };

/** Its two versions as text; null where it did not exist, or was binary or too large to show. */
export type ChangedFileContent = {
  path: string;
  oldPath?: string;
  status: string;
  before: string | null;
  after: string | null;
  binary: boolean;
  tooLarge: boolean;
};

/** One file of the open folder's git, as the Source Control view lists it. */
export type GitFile = { path: string; oldPath?: string; status: string; added: number; removed: number };
export type GitCommit = { sha: string; short: string; author: string; at: string; subject: string };
export type WorkspaceGit = {
  dir: string;
  isRepo: boolean;
  branch?: string;
  head?: string;
  upstream?: { name: string; ahead: number; behind: number };
  staged: GitFile[];
  changes: GitFile[];
  commits: GitCommit[];
  moreCommits: boolean;
};
export type GitArea = 'staged' | 'changes' | 'commit' | 'branch';
/** The two numbers on the Git button (2026-10-27): files not committed; files on this branch, null with nothing to compare. */
export type GitCounts = { isRepo: boolean; uncommitted: number; branch: number | null; base?: string; problem?: string };
/** A file the branch changed, as a pull request lists it, and what of it is not committed yet (2026-10-22). */
export type BranchFile = GitFile & { committed: boolean; uncommitted?: 'staged' | 'changes' | 'untracked' | 'mixed' };
/** Everything the branch changed against a base: its commits and what is not committed yet together. */
export type BranchChanges = {
  dir: string;
  isRepo: boolean;
  branch?: string;
  base?: string;
  bases: string[];
  mergeBase?: string;
  ahead: number;
  behind: number;
  commits: string[];
  files: BranchFile[];
  moreFiles: boolean;
  problem?: 'no-commit' | 'no-base' | 'no-common';
};

export type Story = {
  runId: string;
  title: string;
  status: string;
  prompt: string;
  level2: string;
  entries: StoryEntry[];
  close?: { status: string; summary?: string; reason?: string; checks?: TaskCheckResult[] };
  live: boolean;
};

/**
 * Where a log went when it was saved rather than opened.
 *
 * `revealed` is false and `note` says why on a machine that has no Explorer to open: the file
 * is on disk either way, and the path is most of what the operator wanted.
 */
export type SavedLog = {
  path: string;
  dir: string;
  fileName: string;
  revealed: boolean;
  note?: string;
};

/** Which of the operator's two standing texts: the slow one, or the one per group of tasks. */
/** The three parts of Kerrigan that come from the operator. See `ContextKind` in the store. */
export type ContextKind = 'organisation' | 'persona' | 'work';
export type ContextText = { content: string; customised: boolean; example: string };

/** Where one session's work starts, as the start window chooses it. See src/vcs/startChoice.ts. */
export type StartChoice =
  | { from: 'local'; branch: string; onBranch?: boolean; rechoose?: boolean }
  | { from: 'remote'; remote: string; branch: string; onBranch?: boolean; rechoose?: boolean }
  | { from: 'previous-session'; rechoose?: boolean };

export type BranchTip = { name: string; commit: string };

/** One repository as the start window shows it: its branches, local and as last fetched. */
export type RepoBranches = {
  repoDir: string;
  problem?: string;
  current: string | null;
  head: string | null;
  local: BranchTip[];
  remotes: Array<{ name: string; branches: BranchTip[] }>;
  lastFetched?: string;
};

/** One session of the run in the start window. */
export type StartOptionSession = {
  id: string;
  name: string;
  vcs: boolean;
  repoDir?: string;
  /** The start is fixed already: what it is. Kept unless another start is chosen for it. */
  fixed?: string;
  /** For a session that has run: the branch its work is on, its recorded start, and where that branch is now. */
  started?: {
    mode: 'existing-branch' | 'per-session' | 'per-task';
    branch?: string;
    recorded?: string;
    tipNow?: string | null;
    remote?: { name: string; commit: string };
  };
  /** Why another start cannot be chosen now: the queued tasks that carry an earlier attempt on. */
  rechooseBlocked?: string;
  /** A start prepared before the run, which another choice drops. */
  prepared?: string;
  choice?: StartChoice;
  previousOffered: boolean;
};

export type StartOptions = { repos: RepoBranches[]; sessions: StartOptionSession[] };

/** How a fetch from the start window went. */
export type StartFetch = {
  ok: boolean;
  problem?: string;
  fetched?: { ok: boolean; detail?: string; auth?: boolean; asked: boolean; retried?: boolean };
  missing: string[];
  fetchCommand?: string;
  lastFetched?: string;
  repo?: RepoBranches;
};

/** Where a start that did not get as far as a first task stopped. See src/session/startFailure.ts. */
export type StartStage = 'refused' | 'branch' | 'preflight' | 'browser' | 'run' | 'at-turn' | 'error';

export type StartFailureRef = {
  id: string;
  at: string;
  stage: StartStage;
  message: string;
  runId?: string;
  answered: boolean;
  sessions: string[];
};

/** The answer to a start button. */
export type StartReply = { started: boolean; reason?: string; batch?: BatchState; failure?: StartFailureRef };

export type StopCode = 'format-repair-exhausted' | 'contract-conflict' | 'no-progress' | 'invalid-check' | 'environment';

/** A limit from the settings that ended an attempt. See `TaskLimit` in src/session/model.ts. */
export type TaskLimit = {
  setting: 'maxRunMinutes' | 'maxIterations' | 'replyTimeoutSec' | 'maxFormatRetries' | 'maxCheckRounds' | 'maxReviewRounds';
  value: number;
};

/** Whether "Continue" may carry a task on where it stopped. The same rule as `isContinuable` in src/session/model.ts. */
export function isContinuable(t: { status: TaskStatus; limit?: TaskLimit }): boolean {
  return t.status === 'limit-reached' || t.status === 'aborted' || (!!t.limit && (t.status === 'failed' || t.status === 'blocked'));
}

/** See `canFollowUp` in src/session/model.ts: a task that failed or blocked on its work, carried on with a new prompt. */
export function canFollowUp(t: { status: TaskStatus; stopCode?: string }): boolean {
  return (t.status === 'failed' || t.status === 'blocked') && t.stopCode !== 'contract-conflict';
}

/** See `src/session/handoff.ts`: every entry is something the runner recorded, not the model's words. */
export type Handoff = {
  outcome: { status: TaskStatus; reason?: string };
  changedFiles: Array<{ path: string; added: number; removed: number }>;
  validation: Array<{ name: string; passed: boolean }>;
  review?: { verdict: string; open: number; skippedBecause?: string };
  /** The repository in the order things happened. See `Handoff.lifecycle` in src/session/handoff.ts. */
  lifecycle?: {
    preCommitState?: { changed: string[] };
    checksResult: Array<{ name: string; passed: boolean }>;
    commitResult: { branch?: string; commit?: string; files: number; problem?: string };
    postCommitState?: { branch?: string; head?: string; clean: boolean; uncommitted: string[] };
  };
  knownIssues: string[];
  evidence: { runId?: string; checks: number; reviewRounds: number };
  vcs: { branch?: string; commit?: string; pushed: false; problem?: string };
  manual: string[];
  notExecuted: string[];
};

/** See `src/session/metrics.ts`: counts the runner recorded, as "so many of so many". */
export type Ratio = { n: number; of: number };
export type MetricsRow = {
  group: string;
  tasks: number;
  attempts: number;
  firstPass: Ratio;
  doneInTheEnd: Ratio;
  ended: Partial<Record<TaskStatus, number>>;
  freshRetries: number;
  manualInterventions: number;
  falseCompletion: Ratio;
  reviewRejection: Ratio;
  repeatedCommands: Ratio;
  scopeViolation: Ratio;
  noProgress: Ratio;
  unrelatedDiff: Ratio;
  resumed: Ratio;
  withStats: number;
};
export type Metrics = { rows: MetricsRow[]; computedAt: string };

export type SessionEvent = {
  at: string;
  sessionId: string;
  taskId?: string;
  type: string;
  level: 'info' | 'warn' | 'error';
  message?: string;
  data?: Record<string, unknown>;
};

/**
 * How long a request may take before the page gives up on it and says so.
 *
 * Without a limit a hung API hung the page: the request never ended, its button stayed disabled
 * and, with every poller on the page waiting the same way, the browser's handful of connections to
 * the API were all taken. Thirty seconds is far longer than anything this API does for an ordinary
 * request. The few that wait on something outside it — a folder picker the operator is looking at,
 * the chat's model list read through a browser window — pass `timeoutMs: null`.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

async function call<T>(path: string, init?: RequestInit, opts: { timeoutMs?: number | null } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      ...(timeoutMs !== null && !init?.signal ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      headers: {
        'content-type': 'application/json',
        ...(apiToken() ? { 'x-cop-token': apiToken() } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') {
      throw new Error(`The API did not answer within ${Math.round((timeoutMs ?? 0) / 1000)} s (${path.split('?')[0]}). It may be busy; try again.`);
    }
    throw e;
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (body?.message) message = Array.isArray(body.message) ? body.message.join('; ') : body.message;
    } catch {
      /* not json */
    }
    // The status goes with it, for a caller that answers one differently: the editor's "changed on disk" is a 409.
    throw Object.assign(new Error(message), { status: res.status });
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Kerrigan's text, as `GET /kerrigan` gives it. */
export type KerriganText = { lang: string; fileName: string; text: string; /** False when the names of the controls are left as ⟦key⟧ for the page. */ filled: boolean };

export const api = {
  doctor: () => call<Record<string, unknown>>('/doctor'),
  settings: () =>
    call<{
      raw: Record<string, unknown>;
      defaults: unknown;
      resolved: Record<string, unknown>;
      /** The model menu's locators' defaults, and where a choice's pictures are kept (2026-10-24). */
      picker?: { defaults: Record<PickerKey, string>; dirs: { run: string; read: string } };
      /**
       * The programs the bot may start (2026-10-26): the platform each reaches with the operator's access, by program;
       * the ones that can be set to read only; the list in force, which a policy lock may have narrowed.
       */
      programs?: { platforms: Record<string, string>; readOnly: string[]; inForce: string[] };
      /** The scripts the bot may run, as in force: a policy lock may have emptied the boxes for its own (2026-10-27). */
      scripts?: { inForce: Record<string, { own: boolean; written: boolean }>; writtenScripts: 'ask' | 'run' };
    }>('/settings'),
  /** Writes the whole raw settings object back; the API validates it before saving. */
  saveSettings: (raw: Record<string, unknown>) => call<{ ok: true }>('/settings', { method: 'PUT', body: JSON.stringify(raw) }),

  /** The base prompt as it ships: shown in Settings to read. */
  level1: () => call<{ content: string }>('/level1'),

  sessions: () => call<Session[]>('/sessions'),
  session: (id: string) => call<Session>(`/sessions/${id}`),
  updateSession: (
    id: string,
    patch: {
      active?: boolean;
      name?: string;
      model?: string;
      /** The model set by hand in the Copilot window. */
      manualModel?: boolean;
      onFailure?: 'stop' | 'continue';
      conversationGroup?: string;
      review?: Partial<ReviewSettings>;
      projectDir?: string;
      vcs?: Partial<VersionControl>;
      /** Plan mode for this session; empty follows Settings. */
      planMode?: '' | 'off' | 'auto' | 'approve';
      /** Two chats: the worker's model, or by hand. */
      workerModel?: string;
      workerManualModel?: boolean;
    },
  ) =>
    call<Session>(`/sessions/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  /** What an attempt changed in the repository: the files between its start and its commit. `runId` asks for an earlier attempt. */
  taskChanges: (id: string, taskId: string, runId?: string) =>
    call<{ ok: boolean; problem?: string; repoDir?: string; branch?: string; base?: string; commit?: string; files: ChangedFile[] }>(
      `/sessions/${id}/tasks/${taskId}/changes${runId ? `?run=${encodeURIComponent(runId)}` : ''}`,
    ),
  /** One of those files, before and after. */
  taskChangeFile: (id: string, taskId: string, path: string, runId?: string) =>
    call<ChangedFileContent>(
      `/sessions/${id}/tasks/${taskId}/changes/file?path=${encodeURIComponent(path)}${runId ? `&run=${encodeURIComponent(runId)}` : ''}`,
    ),
  /** The attempt as a story: sent, answered, run, ended. Polled while live. */
  taskStory: (id: string, taskId: string, runId?: string) =>
    call<Story>(`/sessions/${id}/tasks/${taskId}/story${runId ? `?run=${encodeURIComponent(runId)}` : ''}`),
  start: (id: string, mode: 'confirm' | 'unattended') =>
    call<StartReply>(`/sessions/${id}/start`, { method: 'POST', body: JSON.stringify({ mode }) }, { timeoutMs: 120_000 }),
  /** Starts that did not get as far as a first task, newest first. */
  startFailures: (unansweredOnly = false) => call<StartFailureRef[]>(`/start/failures${unansweredOnly ? '?unanswered=1' : ''}`),
  /** One of them as a text file: the error, the run's record, the events and the console of those moments. */
  startFailureUrl: (id: string) => withToken(`${API}/start/failures/${encodeURIComponent(id)}/report`),
  /** What the bot's console showed, the latest lines, as a text file. */
  terminalUrl: () => withToken(`${API}/terminal`),
  /** Everything the bot has kept, as a .zip (2026-10-23); with `runs`, every run's records too. */
  homeExportUrl: (runs: boolean) => withToken(`${API}/home/export${runs ? '?runs=1' : ''}`),
  homeExportSize: () => call<{ data: number; dataFiles: number; runs: number; runsFiles: number }>('/home/export/size'),
  stop: (id: string) => call<{ stopping: boolean }>(`/sessions/${id}/stop`, { method: 'POST', body: '{}' }),
  /** "Pause": the running work holds at its next message to Copilot or its next command. */
  pause: (id: string) => call<{ paused: boolean }>(`/sessions/${id}/pause`, { method: 'POST', body: '{}' }),
  /** "Continue": the paused work goes on from where it held. */
  resume: (id: string) => call<{ paused: boolean }>(`/sessions/${id}/resume`, { method: 'POST', body: '{}' }),
  /** Every step waiting for a decision right now, or only one session's. */
  approvals: (sessionId?: string) =>
    call<Approval[]>(`/approvals${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`),
  /** The open project folder, as it is on disk: what it is, its files, one of them. */
  workspace: () => call<Workspace>('/workspace'),
  /** "New branch from main": `fetch` fetches the remote's main first, which may wait for Git's own password window. */
  newBranchPreview: (fetch: boolean) => call<NewBranchPlan>('/workspace/new-branch/preview', { method: 'POST', body: JSON.stringify({ fetch }) }, { timeoutMs: null }),
  /** `message`: the commit's, when what is not committed is committed on the branch the folder is on. */
  newBranchCreate: (name: string, carry: NewBranchCarry, fingerprint: string, message?: string) =>
    call<NewBranchResult>('/workspace/new-branch', { method: 'POST', body: JSON.stringify({ name, carry, fingerprint, ...(message?.trim() ? { message } : {}) }) }, { timeoutMs: null }),
  /** The queue of tasks (2026-10-24): read, edited as a whole list, run, stopped. */
  queue: () => call<Queue>('/queue'),
  setQueue: (items: Array<Omit<QueueItem, 'status'> & { status?: QueueItem['status'] }>) => call<Queue>('/queue', { method: 'PUT', body: JSON.stringify({ items }) }),
  runQueue: () => call<Queue>('/queue/run', { method: 'POST', body: '{}' }),
  stopQueue: () => call<Queue>('/queue/stop', { method: 'POST', body: '{}' }),
  /** How long a task may wait for the operator before the queue sets it aside and goes on (2026-10-26). */
  setQueueSettings: (parkAfterSec: number) => call<Queue>('/queue/settings', { method: 'PUT', body: JSON.stringify({ parkAfterSec }) }),
  /** The answer to a task the queue set aside while it waited; it carries on at the queue's next turn. */
  answerParked: (itemId: string, answer: ParkedAnswerInput) => call<Queue>(`/queue/items/${encodeURIComponent(itemId)}/answer`, { method: 'POST', body: JSON.stringify(answer) }),
  workspaceFiles: () => call<{ dir: string; files: string[]; truncated: boolean }>('/workspace/files'),
  workspaceSearch: (q: string, o: { matchCase: boolean; wholeWord: boolean; regex: boolean; include: string; exclude: string }) =>
    call<SearchResult>(
      `/workspace/search?${new URLSearchParams({ q, case: o.matchCase ? '1' : '', word: o.wholeWord ? '1' : '', regex: o.regex ? '1' : '', include: o.include, exclude: o.exclude }).toString()}`,
    ),
  workspaceFile: (path: string) => call<WorkspaceFile>(`/workspace/file?path=${encodeURIComponent(path)}`),
  /** The editor's text over a file of the folder, over `base`, the version it was opened at (409 when it changed since). */
  saveWorkspaceFile: (path: string, text: string, base?: string) =>
    call<{ path: string; version: string; size: number }>('/workspace/file', { method: 'PUT', body: JSON.stringify({ path, text, ...(base ? { base } : {}) }) }),
  /** The open folder's git: what changed, staged and not, and the branch's commits. Read-only. */
  workspaceGit: () => call<WorkspaceGit>('/workspace/git'),
  /** Everything the branch changed against `base` (one of the branches it lists), as a pull request shows it. */
  workspaceBranch: (base?: string) => call<BranchChanges>(`/workspace/git/branch${base ? `?base=${encodeURIComponent(base)}` : ''}`),
  /** The two numbers on the Git button: files not committed, and files on this branch against `base`. */
  workspaceGitCounts: (base?: string) => call<GitCounts>(`/workspace/git/counts${base ? `?base=${encodeURIComponent(base)}` : ''}`),
  workspaceCommit: (sha: string) => call<GitCommit & { body: string; files: GitFile[] }>(`/workspace/git/commit?sha=${encodeURIComponent(sha)}`),
  /** A file of those lists, as it was before and after: for the side-by-side view. */
  workspaceGitFile: (area: GitArea, path: string, commit?: string) =>
    call<ChangedFileContent>(`/workspace/git/file?area=${area}&path=${encodeURIComponent(path)}${commit ? `&commit=${encodeURIComponent(commit)}` : ''}`),
  /** The chat: its conversations, and a message — a task of the conversation, or a note while it works. */
  chatThreads: () => call<ChatThread[]>('/chat/threads'),
  /** `planMode` for a new conversation: the plan first, approved in the chat (an existing one's is set with `updateSession`). */
  /** `review`: whether a new conversation's messages are reviewed (the box under the chat); left out, they are not. */
  /** `two`: a new conversation with a lead and a worker (two chats, 2026-10-20), and the worker's model. */
  /** `reviewModel`: the model of a new conversation's review, chosen beside the box (2026-10-21); left out, Settings' one. */
  chatSend: (text: string, threadId?: string, model?: string, manualModel?: boolean, lang?: string, planMode?: boolean, review?: boolean, two?: { workerModel?: string; workerManualModel?: boolean }, skill?: string, reviewModel?: string) =>
    call<ChatSent>('/chat', {
      method: 'POST',
      body: JSON.stringify({
        text,
        ...(threadId ? { threadId } : {}),
        ...(model ? { model } : {}),
        ...(manualModel ? { manualModel: true } : {}),
        ...(lang ? { lang } : {}),
        ...(planMode ? { planMode: true } : {}),
        ...(review !== undefined ? { review } : {}),
        ...(two ? { lead: true, ...(two.workerManualModel ? { workerManualModel: true } : two.workerModel ? { workerModel: two.workerModel } : {}) } : {}),
        ...(skill ? { skill } : {}),
        ...(reviewModel ? { reviewModel } : {}),
      }),
    }),
  /** The lead's question (two chats): the operator's answer. */
  /** `outcome`: for commands handed over, how the operator answered — ran them, sent them back for a correction, will not run them. */
  answerQuestion: (approvalId: string, text: string, outcome?: HandoffOutcome) =>
    call<{ ok: boolean }>(`/approvals/${approvalId}/answer`, { method: 'POST', body: JSON.stringify(outcome === undefined ? { text } : { text, outcome, ran: outcome === 'ran' }) }),
  /** A subtask that ended for a technical reason (two chats): try it again, with a new worker, from where it is, or not. */
  answerRetry: (approvalId: string, choice: RetryChoice) => call<{ ok: boolean }>(`/approvals/${approvalId}/retry`, { method: 'POST', body: JSON.stringify({ choice }) }),
  /** After a Stop (two chats): the stopped message carried on, its subtask `n` tried again first, by a new worker if `fresh`. */
  chatRetrySubtask: (threadId: string, taskId: string, n: number, fresh: boolean) =>
    call<StartReply>(`/chat/${threadId}/tasks/${taskId}/retry-subtask`, { method: 'POST', body: JSON.stringify({ n, fresh }) }),
  /** Back to before a message: the folder as it was then; that message and the ones after it taken out. */
  chatRewind: (threadId: string, taskId: string) =>
    call<{ ok: boolean; message: string; text: string; safety?: string }>(`/chat/${threadId}/rewind`, { method: 'POST', body: JSON.stringify({ taskId }) }),
  /** The session's recent events, newest last. */
  sessionEvents: (id: string) => call<SessionEvent[]>(`/sessions/${id}/events`),
  /** A plan waiting for approval: approve (with a note), ask for another (saying what to change), or stop the task. */
  decidePlan: (approvalId: string, action: 'approve' | 'revise' | 'stop', note?: string) =>
    call<{ ok: boolean }>(`/approvals/${approvalId}/plan`, {
      method: 'POST',
      body: JSON.stringify({ action, ...(note?.trim() ? { note } : {}) }),
    }),
  /** `run-all` runs this step and stops asking for the rest of the run. */
  decide: (approvalId: string, action: 'run' | 'skip' | 'abort' | 'run-all') =>
    call<{ ok: boolean }>(`/approvals/${approvalId}`, { method: 'POST', body: JSON.stringify({ action }) }),
  /** Opens the machine's own folder dialog. Resolves when the operator picks or cancels. */
  // Open until the operator closes the folder picker.
  browseFolder: (start?: string) => call<FolderPick>('/browse-folder', { method: 'POST', body: JSON.stringify({ start }) }, { timeoutMs: null }),
  /**
   * The bot's folder from its next start: `dir`, or null for the default; `copy` copies what is in the folder now
   * (`kept` names what the new folder had already, left as it was).
   */
  setHome: (dir: string | null, copy: boolean) =>
    call<{ home: string; copied: string[]; kept: string[]; restart: true }>('/home', { method: 'PUT', body: JSON.stringify({ dir, copy }) }),

  /** Is anything running right now? Answered from memory, so polling it is fine. */
  activity: () => call<Activity>('/activity'),

  /**
   * Kerrigan, the persona to give another chat (2026-10-20): what copilot-operator is and how a task is best written
   * for its chat, in the page's language, with the name to save it under.
   */
  /** `skill`: the one chosen beside her button, whose instructions go with her text (2026-10-26). */
  kerrigan: (lang: string, skill?: string) => call<KerriganText>(`/kerrigan?lang=${encodeURIComponent(lang)}${skill ? `&skill=${encodeURIComponent(skill)}` : ''}`),
  /** One task's whole exchange with Copilot — messages, replies, commands and their output — as a JSON file. */
  taskExchangeUrl: (id: string, taskId: string) => withToken(`${API}/sessions/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/exchange`),
  /** The projects: the chat's folder first, then the others, each with its branch and its level 2. */
  project: () => call<ProjectDefault>('/project'),
  /** A field left out is kept; an empty `rootDir` clears the chat's folder. */
  setProject: (patch: {
    rootDir?: string;
    name?: string;
    level2?: string;
    readOnly?: boolean;
    others?: Array<{ name: string; rootDir: string; level2?: string; readOnly?: boolean }>;
  }) => call<ProjectDefault>('/project', { method: 'PUT', body: JSON.stringify(patch) }),

  skills: () => call<SkillList>('/skills'),
  setSkills: (skills: Skill[]) => call<SkillList>('/skills', { method: 'PUT', body: JSON.stringify({ skills }) }),

  models: () => call<ModelCatalogue>('/models'),
  /** Stores the model new sessions start on. An empty name clears it. */
  setDefaultModel: (model: string) => call<{ defaultModel: string }>('/models/default', { method: 'PUT', body: JSON.stringify({ model }) }),
  setDefaultLeadModel: (model: string) => call<{ defaultLeadModel: string }>('/models/lead-default', { method: 'PUT', body: JSON.stringify({ model }) }),
  setDefaultReviewModel: (model: string) =>
    call<{ defaultReviewModel: string }>('/models/review-default', { method: 'PUT', body: JSON.stringify({ model }) }),
  /** Opens the browser and re-reads the picker. Slow, and refused while a session runs. */
  // Opens the chat in a browser window and signs in first: minutes, not seconds.
  refreshModels: () => call<ModelCatalogue>('/models/refresh', { method: 'POST', body: '{}' }, { timeoutMs: null }),
  /** Opens the bot's Edge and waits until the operator has signed in: open as long as that takes. */
  login: (account?: string) =>
    call<LoginResult>('/login', { method: 'POST', body: JSON.stringify({ account: account?.trim() || undefined }) }, { timeoutMs: null }),
};

/** Bytes as something a person reads, not a number to decode. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A duration in the largest unit that still says something useful. */
export function fmtDuration(ms?: number): string {
  if (ms === undefined) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { hour12: false });
}
