/**
 * The whole program, started for a check: the real API on a free loopback port, a data folder and
 * a runs folder of its own, a throwaway git repository to work in, and the scripted chat of
 * `fakeChat.ts` where Copilot would be.
 *
 * Everything the operator's interface does goes through the same HTTP routes here, with the same
 * token and the same guard in front of them, so a check drives the program exactly as the UI does:
 * start a run, answer the approval, read the changes. Only the chat is scripted.
 *
 * Sessions are made from a plan in this process (`importPlan`), straight into the server's own store:
 * the page and the route that imported plans went on 2026-10-20, and a plan is now only the checks' way
 * of writing down the sessions and tasks they run. `ops` is the server's service, for the few checks
 * that set a state up the interface no longer offers. The steps the scripted chat sends are run for real, in the real shells, inside the
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
import { OperatorService } from '../../src/api/operator.service.js';
import { checkPlan, describeIssues } from '../../src/plan/schema.js';
import { importPlan as importPlanInto } from '../../src/plan/importPlan.js';
import { readInterruption } from '../../src/session/interruption.js';

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
  /** Makes the sessions and tasks of a plan in the server's store and returns them, in plan order. */
  importPlan: (plan: unknown) => Promise<SessionView[]>;
  /** The server's own service, in this process. */
  ops: OperatorService;
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
  stats?: { formatErrors: number; doneRejected: number; repeatsRefused: number; stepsRefused: number; operatorStops: number; reviewRejections: number; scopeReverts: number; stoppedFor?: string; blockedTooEarly?: number };
  handoff?: {
    outcome: { status: string; reason?: string; stopCode?: string };
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
  vcs?: { enabled?: boolean; startFrom?: string; existingBranch?: string; branchMode?: string };
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
    /*
     * A limit stops the task, as the checks of each limit expect; carrying on by itself (`limits.autoContinue`,
     * on by default) is checked where it is under test, by giving it a value there.
     */
    limits: { autoContinue: 0, ...((settings.limits as object | undefined) ?? {}) },
    /*
     * The runner chooses the model itself, as the checks of choosing it expect; choosing it by hand (on by default
     * since 2026-10-17) is checked where it is under test, by giving it a value there.
     */
    copilot: { manualModel: false, ...((settings.copilot as object | undefined) ?? {}) },
  };
  await writeFile(join(dirs.dataDir, 'settings.json'), JSON.stringify(written, null, 2), 'utf8');
  return dirs;
}

/**
 * The sessions and tasks of a plan, written into the store of a data folder no server has open yet — for a check that
 * starts its server in another process. Returns their ids, in plan order.
 */
export async function seedPlan(dataDir: string, plan: unknown, projectDir = ''): Promise<string[]> {
  const check = checkPlan(JSON.stringify(plan));
  if (!check.ok) throw new Error(`the plan does not check: ${describeIssues(check.issues)}`);
  const { SessionStore } = await import('../../src/session/store.js');
  const store = new SessionStore(dataDir, join(import.meta.dirname, '..', '..', 'prompts', 'level1.md'));
  await store.init();
  return (await importPlanInto(store, check.plan, '', '', '', projectDir)).sessions.map((s) => s.id);
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

  const ops = api.app.get(OperatorService);
  /*
   * Three ways of setting a task up that the interface had and no longer has (2026-10-20): adding a task to a
   * session, "Run again" and "Continue". The checks of the runner set their tasks up with them, and the runner still
   * does both itself — a fresh conversation for a blocked task, a task stopped at a limit carried on. So they are done
   * here, in this process, with the store's own methods the runner uses, under the paths the checks always used.
   */
  const shim = async (method: string, path: string, body: unknown): Promise<{ status: number; body: unknown } | null> => {
    if (method !== 'POST') return null;
    const b = (body ?? {}) as Record<string, unknown>;
    const fail = (e: unknown) => ({ status: 400, body: { message: (e as Error).message } });
    let m = /^\/sessions\/([^/]+)\/tasks$/.exec(path);
    if (m) {
      return await ops.store
        .addTask(m[1]!, { title: String(b.title ?? ''), level2: String(b.level2 ?? ''), prompt: String(b.prompt ?? '') })
        .then((task) => ({ status: 201, body: task as unknown }), fail);
    }
    m = /^\/sessions\/([^/]+)\/tasks\/([^/]+)\/(continue|rerun)$/.exec(path);
    if (!m) return null;
    const [, sessionId, taskId, what] = m;
    try {
      if (what === 'rerun') {
        const { buildOnFinished: _built, ...patch } = b;
        return { status: 201, body: await ops.store.rerunTask(sessionId!, taskId!, patch) };
      }
      // Where an attempt the operator stopped had got to, as "Continue" read it from its run folder.
      const before = (await ops.store.getSession(sessionId!))?.tasks.find((x) => x.id === taskId);
      const stoppedAt = before?.status === 'aborted' && !before.interruption && before.runId ? await readInterruption(join(runsDir, before.runId)).catch(() => null) : null;
      return { status: 201, body: await ops.store.continueTask(sessionId!, taskId!, stoppedAt, typeof b.instruction === 'string' ? b.instruction : undefined) };
    } catch (e) {
      return fail(e);
    }
  };
  const raw = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> => {
    const done = await shim(method, path, body);
    if (done) return done;
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
      const a = await call<{ running: boolean; starting?: boolean }>('GET', '/activity');
      return !a.running && !a.starting;
    });
  };

  return {
    chat,
    api,
    ops,
    importPlan: async (plan: unknown) => {
      const check = checkPlan(JSON.stringify(plan));
      if (!check.ok) throw new Error(`the plan does not check: ${describeIssues(check.issues)}`);
      // The sessions a plan names no folder for work in the project folder, as the import page had them.
      const settings = await call<{ raw: { project?: { rootDir?: string } } }>('GET', '/settings');
      // Read once, so the server has opened its store (and recovered what a crash left) before this writes to it.
      await call('GET', '/sessions');
      const result = await importPlanInto(ops.store, check.plan, '', '', '', (settings.raw.project?.rootDir ?? '').trim());
      return await Promise.all(result.sessions.map((s) => session(s.id)));
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
    /*
     * A moment before exiting, the loop held still (2026-10-24): work the thread pool still had — the last removal of
     * a check's temporary folder — finished while Node was closing, and it died with "Assertion failed:
     * !(handle->flags & UV_HANDLE_CLOSING)" (exit 127) after every check had passed, one run in four, which stopped
     * `check:all` there. Held still, that work ends first, and the exit has nothing left to be in the way of.
     */
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    process.exit(this.wrong === 0 ? 0 : 1);
  }
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
