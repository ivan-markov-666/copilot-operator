/**
 * The browser side of the API. One place that knows the base URL and how errors come back.
 */
export const API = process.env.NEXT_PUBLIC_COP_API ?? 'http://127.0.0.1:4000/api';

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
};

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
  /** Round and position, `r1f2`: what a dispute names. */
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
  /** What the independent review concluded, once it has run. */
  review?: TaskReview;
};

export type Mirror = {
  enabled: boolean;
  rootDir: string;
  includeDirs: string[];
  excludeDirs: string[];
  /** Skip what .gitignore lists. Has no say over .env files. */
  respectGitignore: boolean;
  /** Copy .env files. The only thing that decides them. */
  includeEnvFiles: boolean;
};

export type VersionControl = {
  enabled: boolean;
  repoDir: string;
  branchMode: 'per-task' | 'per-session';
  commitOnFinish: boolean;
  branchPrefix: string;
  /** The one branch a per-session run works on. Empty means it is derived from the name. */
  branchName?: string;
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
  /** Where the session's work is: one branch, or one per task. */
  work?: {
    mode: 'per-task' | 'per-session';
    complete?: string;
    branches: Array<{ title: string; branch: string; commit?: string; status: string }>;
  };
};

export type MirrorPreview = {
  files: string[];
  skipped: Array<{ relPath: string; reason: string }>;
  envFiles: string[];
  totalBytes: number;
};

export type FolderPick = { ok: true; path: string } | { ok: false; cancelled: boolean; reason?: string };

/** One task of one session, as the registry page lists it. */
export type RegistryEntry = {
  sessionId: string;
  sessionName: string;
  sessionStatus: 'idle' | 'running' | 'stopping';
  sessionRunning: boolean;
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
  /** Which attempt this row describes. 1 unless the task has been run again. */
  attempt?: number;
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
  }>;
};

/**
 * The press of a start button a task ran under.
 *
 * Several sessions started together share one, which is what lets the register say which
 * tasks went out as a single decision rather than merely at a similar time.
 */
export type TaskRunGroup = { id: string; startedAt: string; sessions: number; name?: string };

/** Whether the bot is working. Cheap enough to ask from every page on a timer. */
export type Activity = { running: boolean; sessions: number; batch: boolean };

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
  }>;
  mode: RunMode;
  onFailure: OnFailure;
};

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
};

export type Session = {
  id: string;
  name: string;
  createdAt: string;
  status: 'idle' | 'running' | 'stopping';
  chat?: Chat;
  contractSent: boolean;
  /** The model this conversation should run on, by the picker's exact name. */
  model?: string;
  /** What the picker reported after the last run applied that choice. */
  modelInUse?: string;
  /** Whether the queue is one chain ('stop') or a set of independent tasks ('continue'). */
  onFailure?: 'stop' | 'continue';
  /** Sessions with the same group share one Copilot conversation. */
  conversationGroup?: string;
  /** The name of the plan this session was imported from, offered as the run's name. */
  planName?: string;
  vcs?: VersionControl;
  vcsBaseCommit?: string;
  /** Whether a second, independent conversation checks the work. On unless said otherwise. */
  review?: ReviewSettings;
  mirror: Mirror;
  tasks: Task[];
  running: boolean;
  /** How the run in progress is answering approvals right now. Absent when nothing runs. */
  runMode?: 'confirm' | 'unattended';
  pending?: Approval[];
};

export type Approval = { id: string; sessionId: string; taskId: string; stepId: number; description: string; createdAt: string };

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
  running: boolean;
  sessions: BatchSession[];
};

/** Which directories of one project go to the Desktop, and how. */
export type ProjectMirrorSelection = { includeDirs: string[]; excludeDirs: string[]; respectGitignore: boolean; includeEnvFiles: boolean };

/** One of the other folders the operator works in, by name, with whether it can carry version control. */
export type OtherProject = { name: string; rootDir: string; repoOk: boolean; repoProblem?: string; mirror?: ProjectMirrorSelection };

/** The project folder new sessions start pointed at, whether it can carry version control, and the other folders by name. */
export type ProjectDefault = {
  rootDir: string;
  repoOk: boolean;
  repoProblem?: string;
  others: OtherProject[];
  /** Whether every project's selection is kept on the Desktop, refreshed before each run. */
  mirrorToDesktop: boolean;
  /** The default project's selection. */
  mirror?: ProjectMirrorSelection;
  /** The Desktop folder that holds one subfolder per project. */
  contextRoot: string;
};

export type Preset = { name: string; content: string; updatedAt: string };

/** One thing that happened in a task attempt, as the run folder recorded it. */
export type StoryEntry =
  | { kind: 'sent'; iteration: number; label: string; text: string }
  | { kind: 'reply'; iteration: number; label: string; text: string; status?: string; notes?: string }
  | { kind: 'step'; iteration: number; id: number; command: string; output: string; outcome?: string; exitCode?: number; durationMs?: number; failed: boolean }
  | { kind: 'review'; round: number; entries: StoryEntry[] };

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

export type SessionEvent = {
  at: string;
  sessionId: string;
  taskId?: string;
  type: string;
  level: 'info' | 'warn' | 'error';
  message?: string;
  data?: Record<string, unknown>;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (body?.message) message = Array.isArray(body.message) ? body.message.join('; ') : body.message;
    } catch {
      /* not json */
    }
    throw new Error(message);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  health: () => call<{ ok: boolean }>('/health'),
  doctor: () => call<Record<string, unknown>>('/doctor'),
  settings: () => call<{ raw: Record<string, unknown>; defaults: unknown; resolved: Record<string, unknown> }>('/settings'),

  level1: () => call<{ content: string; customised: boolean }>('/level1'),
  setLevel1: (content: string) => call<{ ok: true }>('/level1', { method: 'PUT', body: JSON.stringify({ content }) }),
  resetLevel1: () => call<{ content: string; customised: boolean }>('/level1', { method: 'DELETE' }),

  presets: () => call<Preset[]>('/presets'),
  savePreset: (name: string, content: string) =>
    call<Preset>(`/presets/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  deletePreset: (name: string) => call<{ ok: true }>(`/presets/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  sessions: () => call<Session[]>('/sessions'),
  session: (id: string) => call<Session>(`/sessions/${id}`),
  createSession: (name: string, mirror?: Partial<Mirror>) =>
    call<Session>('/sessions', { method: 'POST', body: JSON.stringify({ name, mirror }) }),
  updateSession: (
    id: string,
    patch: {
      name?: string;
      model?: string;
      onFailure?: 'stop' | 'continue';
      conversationGroup?: string;
      review?: Partial<ReviewSettings>;
      mirror?: Partial<Mirror>;
      vcs?: Partial<VersionControl>;
    },
  ) =>
    call<Session>(`/sessions/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteSession: (id: string) => call<{ ok: true }>(`/sessions/${id}`, { method: 'DELETE' }),

  addTask: (id: string, task: { title: string; level2: string; prompt: string }) =>
    call<Task>(`/sessions/${id}/tasks`, { method: 'POST', body: JSON.stringify(task) }),
  updateTask: (id: string, taskId: string, patch: Partial<Pick<Task, 'title' | 'level2' | 'prompt' | 'vcsPlan' | 'checks'>>) =>
    call<Task>(`/sessions/${id}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteTask: (id: string, taskId: string) => call<{ ok: true }>(`/sessions/${id}/tasks/${taskId}`, { method: 'DELETE' }),
  /** Queues a finished task again, keeping the earlier attempt on the record. */
  rerunTask: (id: string, taskId: string, patch: Partial<Pick<Task, 'title' | 'level2' | 'prompt' | 'vcsPlan' | 'checks'>> = {}) =>
    call<Task>(`/sessions/${id}/tasks/${taskId}/rerun`, { method: 'POST', body: JSON.stringify(patch) }),
  /** `runId` asks for one earlier attempt instead of the current one. */
  /** The attempt as a story: sent, answered, run, ended. Polled while live. */
  taskStory: (id: string, taskId: string, runId?: string) =>
    call<Story>(`/sessions/${id}/tasks/${taskId}/story${runId ? `?run=${encodeURIComponent(runId)}` : ''}`),
  taskFiles: (id: string, taskId: string, runId?: string) =>
    call<{ reports: string[]; artifacts: string[]; replies: string[] }>(
      `/sessions/${id}/tasks/${taskId}/files${runId ? `?run=${encodeURIComponent(runId)}` : ''}`,
    ),
  taskLogUrl: (id: string, taskId: string, runId?: string) =>
    `${API}/sessions/${id}/tasks/${taskId}/log${runId ? `?run=${encodeURIComponent(runId)}` : ''}`,
  taskFileUrl: (id: string, taskId: string, kind: string, name: string, runId?: string) =>
    `${API}/sessions/${id}/tasks/${taskId}/files/${kind}/${encodeURIComponent(name)}${runId ? `?run=${encodeURIComponent(runId)}` : ''}`,

  start: (id: string, mode: 'confirm' | 'unattended', name?: string) =>
    call<{ started: boolean; reason?: string }>(`/sessions/${id}/start`, { method: 'POST', body: JSON.stringify({ mode, name }) }),
  stop: (id: string) => call<{ stopping: boolean }>(`/sessions/${id}/stop`, { method: 'POST', body: '{}' }),
  /** Every step waiting for a decision right now, or only one session's. */
  approvals: (sessionId?: string) =>
    call<Approval[]>(`/approvals${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`),
  /** `run-all` runs this step and stops asking for the rest of the run. */
  decide: (approvalId: string, action: 'run' | 'skip' | 'abort' | 'run-all') =>
    call<{ ok: boolean }>(`/approvals/${approvalId}`, { method: 'POST', body: JSON.stringify({ action }) }),
  setRunMode: (id: string, mode: 'confirm' | 'unattended') =>
    call<{ ok: boolean; mode?: string }>(`/sessions/${id}/mode`, { method: 'POST', body: JSON.stringify({ mode }) }),
  streamUrl: (id: string) => `${API}/sessions/${id}/stream`,

  /** The batch in progress, or the last one that ran. Null when none ever has. */
  batch: () => call<BatchState | null>('/batch').then((b) => b ?? null),
  /** Runs the queued tasks of several sessions, one session after another, in this order. */
  startBatch: (
    sessionIds: string[],
    mode: 'confirm' | 'unattended',
    onFailure: 'stop' | 'continue',
    model?: string,
    /** The model the independent review runs on, written onto every selected session. */
    reviewModel?: string,
    /** What to call the run; the register groups by it and the exports are named after it. */
    name?: string,
  ) =>
    call<{ started: boolean; reason?: string; batch?: BatchState }>('/batch/start', {
      method: 'POST',
      // An absent model leaves every session on the one it already has; a name is written
      // onto all of them before the run starts.
      body: JSON.stringify({ sessionIds, mode, onFailure, model, reviewModel, name }),
    }),
  stopBatch: () => call<{ stopping: boolean }>('/batch/stop', { method: 'POST', body: '{}' }),

  /**
   * The text to hand to a chat model so it writes a plan.
   *
   * The language is the only thing that varies. Version control and the folder used to be
   * chosen here and baked in; the brief now tells the model to ask about them, because they
   * belong to a session rather than to the whole document.
   */
  /** The persona whole (`text`), and in its two parts: the software's (fixed) and the organisation's (editable). */
  planBrief: (lang: string) =>
    call<{ text: string; software: string; organisation: string; customised: boolean; example: string }>(`/plan/brief?lang=${encodeURIComponent(lang)}`),
  organisation: (lang: string) => call<{ content: string; customised: boolean; example: string }>(`/organisation?lang=${encodeURIComponent(lang)}`),
  setOrganisation: (content: string) => call<{ ok: true }>('/organisation', { method: 'PUT', body: JSON.stringify({ content }) }),
  resetOrganisation: (lang: string) =>
    call<{ content: string; customised: boolean; example: string }>(`/organisation?lang=${encodeURIComponent(lang)}`, { method: 'DELETE' }),
  /** Checks a pasted plan and imports nothing. */
  checkPlan: (text: string) => call<PlanCheck>('/plan/check', { method: 'POST', body: JSON.stringify({ text }) }),
  /** Creates everything the plan describes, and starts none of it. */
  importPlan: (text: string) => call<PlanImport>('/plan/import', { method: 'POST', body: JSON.stringify({ text }) }),

  dirs: (root: string, respectGitignore = true) =>
    call<string[]>(`/dirs?root=${encodeURIComponent(root)}&gitignore=${respectGitignore ? '1' : '0'}`),

  /** Opens the machine's own folder dialog. Resolves when the operator picks or cancels. */
  browseFolder: (start?: string) => call<FolderPick>('/browse-folder', { method: 'POST', body: JSON.stringify({ start }) }),

  previewMirror: (m: Pick<Mirror, 'rootDir' | 'includeDirs' | 'excludeDirs' | 'respectGitignore' | 'includeEnvFiles'>) =>
    call<MirrorPreview>('/mirror/preview', { method: 'POST', body: JSON.stringify(m) }),

  tasks: () => call<RegistryEntry[]>('/tasks'),

  /** Is anything running right now? Answered from memory, so polling it is fine. */
  activity: () => call<Activity>('/activity'),

  /**
   * A link to one JSON file holding everything that happened across these sessions.
   *
   * A URL rather than a call, because the browser downloading it is the whole point: the file
   * is then on disk, ready to be handed to whoever has to work out what went wrong.
   */
  /**
   * One of the three JSON views: `plan` (what was asked, importable again), `domain` (what
   * happened to the work), `bot` (what the runner did) — of a task, a session or a whole run.
   */
  exportUrl: (kind: 'plan' | 'domain' | 'bot', where: { run?: string; session?: string; task?: string }) => {
    const q = new URLSearchParams();
    if (where.run) q.set('run', where.run);
    if (where.session) q.set('session', where.session);
    if (where.task) q.set('task', where.task);
    return `${API}/export/${kind}?${q.toString()}`;
  },
  debugExportUrl: (sessionIds: string[]) =>
    `${API}/debug/export${sessionIds.length > 0 ? `?sessions=${encodeURIComponent(sessionIds.join(','))}` : ''}`,

  /** Can version control do its job in this session right now? */
  vcsStatus: (id: string) => call<VcsStatus>(`/sessions/${id}/vcs`),

  /** What going back to before this task would do. Changes nothing. */
  restorePreview: (id: string, taskId: string) => call<RestorePreview>(`/sessions/${id}/tasks/${taskId}/restore`),
  /** Does it: a new branch at the commit that task started from, checked out. */
  restore: (id: string, taskId: string) =>
    call<RestoreResult>(`/sessions/${id}/tasks/${taskId}/restore`, { method: 'POST', body: '{}' }),

  /** What starting the whole run again from this task would re-queue, and do to the code. */
  restartPlan: (id: string, taskId: string) => call<RestartPlan>(`/sessions/${id}/tasks/${taskId}/restart`),
  /** Restores the code, queues this task and everything after it, and starts them. */
  restartFrom: (id: string, taskId: string, opts: { restore?: boolean; mode?: RunMode; onFailure?: OnFailure } = {}) =>
    call<RestartResult>(`/sessions/${id}/tasks/${taskId}/restart`, { method: 'POST', body: JSON.stringify(opts) }),
  /** Whether a folder could be used for version control at all, asked before turning it on. */
  repoCheck: (dir: string) => call<{ ok: boolean; problem?: string }>(`/repo?dir=${encodeURIComponent(dir)}`),

  /** The folder new sessions start pointed at. */
  project: () => call<ProjectDefault>('/project'),
  /** Stores it; an empty path clears it. */
  /** A field left out is kept; an empty `rootDir` clears the default. */
  setProject: (patch: {
    rootDir?: string;
    others?: Array<{ name: string; rootDir: string; mirror?: ProjectMirrorSelection }>;
    mirrorToDesktop?: boolean;
    mirror?: ProjectMirrorSelection;
  }) => call<ProjectDefault>('/project', { method: 'PUT', body: JSON.stringify(patch) }),

  models: () => call<ModelCatalogue>('/models'),
  /** Stores the model new sessions start on. An empty name clears it. */
  setDefaultModel: (model: string) => call<{ defaultModel: string }>('/models/default', { method: 'PUT', body: JSON.stringify({ model }) }),
  setDefaultReviewModel: (model: string) =>
    call<{ defaultReviewModel: string }>('/models/review-default', { method: 'PUT', body: JSON.stringify({ model }) }),
  /** Opens the browser and re-reads the picker. Slow, and refused while a session runs. */
  refreshModels: () => call<ModelCatalogue>('/models/refresh', { method: 'POST', body: '{}' }),
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
