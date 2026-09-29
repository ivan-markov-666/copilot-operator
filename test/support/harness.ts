/**
 * The whole program, started for a check: the real API on a free loopback port, a data folder and
 * a runs folder of its own, a throwaway git repository to work in, and the scripted chat of
 * `fakeChat.ts` where Copilot would be.
 *
 * Everything the operator's interface does goes through the same HTTP routes here, with the same
 * token and the same guard in front of them, so a check drives the program exactly as the UI does:
 * import a plan, start a run, answer the approval, continue a task, read the changes. Only the chat
 * is scripted. The steps the scripted chat sends are run for real, in the real shells, inside the
 * throwaway repository — which is the point: a check that faked the runner as well would prove
 * nothing about the runner.
 *
 * Nothing here touches the operator's own data: `COP_DATA_DIR` points at a new temporary folder
 * before the server is created, and `runsDir` in its settings points at another. The port is asked
 * of the system, so a check never collides with a running `npm start` on 4000.
 */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { setTransportFactory } from '../../src/transport/chatTransport.js';
import { FakeCopilot } from './fakeChat.js';
import type { StartedApi } from '../../src/api/server.js';

export type Harness = {
  chat: FakeCopilot;
  api: StartedApi;
  base: string;
  dataDir: string;
  runsDir: string;
  repo: string;
  /** A JSON request to the API, as the UI makes it. Throws with the server's message on a non-2xx. */
  call: <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;
  /** Same, but returns the status and body instead of throwing. */
  raw: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: unknown }>;
  git: (...args: string[]) => string;
  /** Imports a plan through the import page's route and returns the new sessions, in plan order. */
  importPlan: (plan: unknown) => Promise<SessionView[]>;
  session: (id: string) => Promise<SessionView>;
  /** Starts one session and waits until nothing is running any more. */
  run: (sessionId: string, mode?: 'confirm' | 'unattended') => Promise<SessionView>;
  /** Waits until no session and no batch is running. */
  idle: () => Promise<void>;
  stop: () => Promise<void>;
};

/** The parts of a session the checks read. The API returns the whole record. */
export type TaskView = {
  id: string;
  title: string;
  prompt: string;
  status: string;
  reason?: string;
  summary?: string;
  iterations: number;
  attempt?: number;
  runId?: string;
  continuing?: { fromAttempt: number; how?: string; stoppedBecause?: string };
  buildsOn?: unknown;
  interruption?: { steps?: Array<{ id: number; state: string }>; resultsSent?: boolean };
  attempts?: Array<{ status: string; runId?: string; vcs?: { branch?: string } }>;
  review?: { verdict?: string };
  stats?: { formatErrors: number; doneRejected: number; repeatsRefused: number; stepsRefused: number; operatorStops: number; reviewRejections: number; scopeReverts: number; stoppedFor?: string };
  handoff?: {
    outcome: { status: string; reason?: string };
    changedFiles: Array<{ path: string }>;
    validation: Array<{ name: string; passed: boolean }>;
    knownIssues: string[];
    vcs: { branch?: string; commit?: string; pushed: false };
    manual: string[];
    notExecuted: string[];
  };
  vcs?: { branch?: string; baseCommit?: string; commit?: string; files?: Array<{ path: string }>; problem?: string; foreignCommits?: string[] };
};
export type SessionView = {
  id: string;
  name: string;
  status: string;
  chat?: { chatId: string; name: string };
  modelInUse?: string;
  vcsStart?: { kind?: string; commit?: string; branch?: string; fromSession?: { id: string; name: string } };
  vcsBaseCommit?: string;
  tasks: TaskView[];
};

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** A git repository with one commit on `main`, the way the operator's projects start. */
export async function makeRepo(dir: string): Promise<void> {
  const git = (...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'check@example.invalid');
  git('config', 'user.name', 'check');
  git('config', 'core.autocrlf', 'false');
  await writeFile(join(dir, 'README.md'), '# fixture\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
}

/** The folders of one harness: made once, and reusable by a second server started on the same data. */
export type HarnessDirs = { base: string; dataDir: string; runsDir: string; repo: string };

export async function makeDirs(settings: Record<string, unknown> = {}): Promise<HarnessDirs> {
  const base = await mkdtemp(join(tmpdir(), 'cop-e2e-'));
  const dirs = { base, dataDir: join(base, 'data'), runsDir: join(base, 'runs'), repo: join(base, 'repo') };
  await mkdir(dirs.dataDir, { recursive: true });
  await mkdir(dirs.repo, { recursive: true });
  await makeRepo(dirs.repo);
  const written = {
    runsDir: dirs.runsDir,
    project: { rootDir: dirs.repo },
    // No waits between messages: the chat answers at once, and the hourly cap is not what is tested.
    pacing: { enabled: false, settleMs: 0, maxMessagesPerHour: 10_000 },
    ...settings,
    // No isolation, accepted: the machine running the checks is the operator's own, as in real use.
    execution: { isolation: 'none-accepted', ...((settings.execution as object | undefined) ?? {}) },
  };
  await writeFile(join(dirs.dataDir, 'settings.json'), JSON.stringify(written, null, 2), 'utf8');
  return dirs;
}

/**
 * Starts the API with a scripted chat. With `dirs`, on folders an earlier server already used —
 * which is how a check restarts the program after killing it — and those are left in place on
 * `stop` unless `own` makes this harness the one that cleans them up.
 */
export async function startHarness(opts: { settings?: Record<string, unknown>; dirs?: HarnessDirs; own?: boolean; webDir?: string } = {}): Promise<Harness> {
  const dirs = opts.dirs ?? (await makeDirs(opts.settings));
  const own = opts.own ?? !opts.dirs;
  const { base, dataDir, runsDir, repo } = dirs;

  const chat = new FakeCopilot();
  setTransportFactory(chat.factory());
  process.env.COP_DATA_DIR = dataDir;

  const { startApi } = await import('../../src/api/server.js');
  const port = await freePort();
  const api = await startApi({ port, quiet: true, webDir: opts.webDir });
  const origin = `http://127.0.0.1:${port}`;

  const raw = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${origin}/api${path}`, {
      method,
      headers: { 'x-cop-token': api.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* not JSON: kept as text */
    }
    return { status: res.status, body: parsed };
  };
  const call = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await raw(method, path, body);
    if (r.status < 200 || r.status >= 300) {
      const msg = typeof r.body === 'object' && r.body && 'message' in r.body ? (r.body as { message: unknown }).message : r.body;
      throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(msg)}`);
    }
    return r.body as T;
  };

  const session = (id: string): Promise<SessionView> => call<SessionView>('GET', `/sessions/${id}`);
  const idle = async (): Promise<void> => {
    await waitFor('the run to end', async () => {
      const a = await call<{ running: boolean; batch: boolean }>('GET', '/activity');
      return !a.running && !a.batch;
    });
  };

  return {
    chat,
    api,
    importPlan: async (plan: unknown) => {
      const before = new Set((await call<SessionView[]>('GET', '/sessions')).map((s) => s.id));
      await call('POST', '/plan/import', { text: JSON.stringify(plan) });
      const after = await call<Array<SessionView & { createdAt?: string }>>('GET', '/sessions');
      const fresh = after.filter((s) => !before.has(s.id));
      const names = (plan as { sessions: Array<{ name: string }> }).sessions.map((s) => s.name);
      return await Promise.all(names.map((n) => session(fresh.find((s) => s.name === n)!.id)));
    },
    session,
    run: async (sessionId, mode = 'unattended') => {
      const r = await call<{ started: boolean; reason?: string }>('POST', `/sessions/${sessionId}/start`, { mode });
      if (!r.started) throw new Error(`the run did not start: ${r.reason}`);
      await idle();
      return await session(sessionId);
    },
    idle,
    base,
    dataDir,
    runsDir,
    repo,
    call,
    raw,
    git: (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim(),
    stop: async () => {
      await api.close().catch(() => undefined);
      setTransportFactory(null);
      if (own) await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    },
  };
}

/** Polls until `get` returns something truthy, or fails with `what` after `ms`. */
export async function waitFor<T>(what: string, get: () => Promise<T | undefined | null | false>, ms = 60_000): Promise<T> {
  const until = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await get();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ''}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A small tally, printed the way every other check in this folder prints. */
export class Tally {
  wrong = 0;
  check(what: string, got: unknown, want: unknown): void {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) this.wrong += 1;
    console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  }
  truthy(what: string, got: unknown, detail?: unknown): void {
    if (!got) this.wrong += 1;
    console.log(`${got ? 'ok   ' : 'WRONG'} ${what}${got ? '' : detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
  finish(): never {
    console.log(`\nfailures: ${this.wrong} (expect 0)`);
    process.exit(this.wrong === 0 ? 0 : 1);
  }
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
