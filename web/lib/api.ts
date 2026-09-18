/**
 * The browser side of the API. One place that knows the base URL and how errors come back.
 */
export const API = process.env.NEXT_PUBLIC_COP_API ?? 'http://127.0.0.1:4000/api';

export type TaskStatus = 'queued' | 'running' | 'waiting-approval' | 'done' | 'failed' | 'aborted' | 'limit-reached';

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
  logFile?: string;
};

export type Mirror = { enabled: boolean; rootDir: string; includeDirs: string[]; excludeDirs: string[] };

export type Chat = { chatId: string; url: string; name: string; runId: string; createdAt: string };

export type Session = {
  id: string;
  name: string;
  createdAt: string;
  status: 'idle' | 'running' | 'stopping';
  chat?: Chat;
  contractSent: boolean;
  mirror: Mirror;
  tasks: Task[];
  running: boolean;
  pending?: Approval[];
};

export type Approval = { id: string; sessionId: string; taskId: string; stepId: number; description: string; createdAt: string };

export type Preset = { name: string; content: string; updatedAt: string };

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
  updateSession: (id: string, patch: { name?: string; mirror?: Partial<Mirror> }) =>
    call<Session>(`/sessions/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteSession: (id: string) => call<{ ok: true }>(`/sessions/${id}`, { method: 'DELETE' }),

  addTask: (id: string, task: { title: string; level2: string; prompt: string }) =>
    call<Task>(`/sessions/${id}/tasks`, { method: 'POST', body: JSON.stringify(task) }),
  updateTask: (id: string, taskId: string, patch: Partial<Pick<Task, 'title' | 'level2' | 'prompt'>>) =>
    call<Task>(`/sessions/${id}/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteTask: (id: string, taskId: string) => call<{ ok: true }>(`/sessions/${id}/tasks/${taskId}`, { method: 'DELETE' }),
  taskFiles: (id: string, taskId: string) =>
    call<{ reports: string[]; artifacts: string[]; replies: string[] }>(`/sessions/${id}/tasks/${taskId}/files`),
  taskLogUrl: (id: string, taskId: string) => `${API}/sessions/${id}/tasks/${taskId}/log`,
  taskFileUrl: (id: string, taskId: string, kind: string, name: string) =>
    `${API}/sessions/${id}/tasks/${taskId}/files/${kind}/${encodeURIComponent(name)}`,

  start: (id: string, mode: 'confirm' | 'unattended') =>
    call<{ started: boolean; reason?: string }>(`/sessions/${id}/start`, { method: 'POST', body: JSON.stringify({ mode }) }),
  stop: (id: string) => call<{ stopping: boolean }>(`/sessions/${id}/stop`, { method: 'POST', body: '{}' }),
  decide: (approvalId: string, action: 'run' | 'skip' | 'abort') =>
    call<{ ok: boolean }>(`/approvals/${approvalId}`, { method: 'POST', body: JSON.stringify({ action }) }),
  streamUrl: (id: string) => `${API}/sessions/${id}/stream`,

  dirs: (root: string) => call<string[]>(`/dirs?root=${encodeURIComponent(root)}`),
};

export function fmtTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { hour12: false });
}
