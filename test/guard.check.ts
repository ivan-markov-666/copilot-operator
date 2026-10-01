/**
 * The API door, on the real server: the guard as it is wired in front of every route, the cookie the
 * served interface hands out, the refusal every entrance gives an unattended run it may not start,
 * the step that tries to reach the bot itself, and the path guards on a task's own files.
 *
 * `security.check.ts` and `package.check.ts` hold the rules as functions. This holds them as they
 * are mounted: a rule that is right in `judgeRequest` and wrong on the wire — a middleware mounted
 * after the router, a path compared in one case and routed in another — protects nothing, and only a
 * request to the running server finds that out. Every request here goes through `node:http` rather than `fetch`, because
 * `fetch` silently drops a `Host` header and the rebinding check is about exactly that header.
 *
 * What is real: the API, its guard, CORS, the static interface, the session store, the runner, the
 * step gate, the shells and git. What is scripted: only the chat (test/support/fakeChat.ts). Each
 * harness has its own data folder, runs folder, repository and a free port; nothing touches the
 * operator's own data, and no browser is opened.
 *
 *   npm run check:guard
 */
import { request, type IncomingHttpHeaders } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';
import { ensureApiToken, judgeRequest } from '../src/api/security.js';
import { principalsInSddl } from '../src/api/dataAcl.js';
import { installLayout } from '../src/config/layout.js';
import { readPolicyLocks } from '../src/config/lockedPolicy.js';
import { loadConfigObject, RunConfigSchema } from '../src/config/schema.js';
import { botSelfRefusal } from '../src/exec/network.js';
import { winPsEnv } from '../src/exec/winps.js';

const t = new Tally();
const started = Date.now();

/*
 * The variables that would change what the server listens on, which origin it accepts and where it
 * looks for a policy lock. Cleared in this process only, so the answers below do not depend on the
 * terminal the check happened to be started from.
 */
for (const k of ['COP_API_PORT', 'COP_WEB_ORIGIN', 'COP_PROJECT_ROOT']) delete process.env[k];

// --- helpers ---------------------------------------------------------------------------------

type Wire = { status: number; headers: IncomingHttpHeaders; text: string; json: Record<string, unknown> | undefined };

/**
 * One raw request to the running server. `host` defaults to the loopback name the guard expects and
 * can be overridden, which is the whole reason this exists instead of `fetch`.
 */
function wire(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string, timeoutMs = 30_000): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> | undefined;
          try {
            json = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    // A stream the guard failed to refuse would stay open; a timeout turns that into a status of 0.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${path} did not answer within ${timeoutMs} ms`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

type Opts = { settings?: Record<string, unknown>; webDir?: string };

/**
 * One harness per scenario, as in e2e-run.check.ts, plus the check that every scripted reply was
 * used: a reply left in the queue means the runner stopped talking earlier than the scenario says.
 *
 * The "no reply it had no script for" check below is also how a way round the token shows up in the
 * served-interface scenario: a request with no token that started a run would make that run talk to
 * a chat nobody scripted.
 */
async function scenario(title: string, opts: Opts, body: (h: Harness) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  let h: Harness | undefined;
  try {
    h = await startHarness(opts);
    await body(h);
    t.check('every scripted reply was used', h.chat.pending, 0);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
    t.check('every chat window opened was closed again', h.chat.opened, h.chat.closed);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    if (h) {
      await h.idle().catch(() => undefined);
      h.chat.discard();
      await h.stop();
    }
  }
}

function plan(h: Harness, name: string, tasks: unknown[]): unknown {
  return {
    version: 1,
    sessions: [
      {
        name,
        onFailure: 'stop',
        vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: name },
        review: { enabled: false },
        tasks,
      },
    ],
  };
}

/** A task that writes one file, with the check that proves it. */
const writes = (title: string, file: string, text: string): unknown => ({
  title,
  prompt: `Create ${file} in the repository root holding exactly the word ${text}, and nothing else.`,
  checks: [{ name: `${file} written`, expect: 'file-contains', file, value: text }],
});
const write = (file: string, text: string): string => reply.steps(`Set-Content -Path ${file} -Value '${text}' -Encoding utf8`);

type Approval = { id: string; sessionId: string; stepId: number; description: string };
type Refusal = { started: boolean; reason?: string };
type RunState = { runGroup?: unknown; runMode?: string; status: string; tasks: Array<{ status: string }> };

async function rejects(what: string, run: () => Promise<unknown>, want: RegExp): Promise<void> {
  try {
    await run();
    t.truthy(what, false, 'it resolved');
  } catch (e) {
    const message = (e as Error).message;
    t.truthy(what, want.test(message), message.slice(0, 400));
  }
}

/** This account's SID, from Windows' own whoami (not a shell's), so it is the one `icacls` granted. */
function currentSid(): string {
  const whoami = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
  const r = spawnSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return /"(S-1-[0-9-]+)"\s*$/.exec(r.stdout.trim())?.[1] ?? '';
}

/** A folder's ACL as SDDL, read the way `dataAcl.ts` reads it: Get-Acl in Windows PowerShell. */
function sddlOf(dir: string): string {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Acl -LiteralPath '${dir.replace(/'/g, "''")}').Sddl`], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: winPsEnv(process.env),
  });
  return r.stdout.trim();
}

// --- the wire ----------------------------------------------------------------------------------

/*
 * The three refusals, cheapest first, as the running server gives them — and the two things that
 * must not be refused: the health probe `scripts/dev.mjs` polls, and the CORS preflight of the dev
 * UI, which carries no credentials and would otherwise turn every request of the page into an
 * opaque network error. Each refusal has a control beside it, the same request made correctly,
 * so a 421 or a 403 cannot come from a route that simply does not exist.
 */
await scenario('the guard on the wire: host, origin, the open health path, CORS', {}, async (h) => {
  const { port, token } = h.api;
  const [s] = await h.importPlan(plan(h, 'wire', [writes('write-hello', 'hello.txt', 'hi')]));

  const control = await wire(port, 'GET', '/api/sessions', { 'x-cop-token': token });
  t.check('control: the right host and the token list the sessions', control.status, 200);

  // DNS rebinding: the attacker's name resolved to 127.0.0.1. The token does not help it past this.
  const rebound = await wire(port, 'GET', '/api/sessions', { host: `evil.example:${port}`, 'x-cop-token': token });
  t.check('a request addressed to another name is refused with 421 and error "host", token or not', [rebound.status, rebound.json?.error], [421, 'host']);

  // A page on another site: refused outright, not merely prevented from reading the answer.
  const foreign = await wire(port, 'GET', '/api/sessions', { origin: 'https://evil.example', 'x-cop-token': token });
  t.check('a request from another origin is refused with 403 and error "origin", token or not', [foreign.status, foreign.json?.error], [403, 'origin']);

  const health = await wire(port, 'GET', '/api/health');
  t.check('/api/health answers with no token: 200, ok, and the time', [health.status, health.json?.ok, typeof health.json?.time], [200, true, 'string']);

  const preflight = await wire(port, 'OPTIONS', '/api/sessions', { origin: 'http://localhost:3210', 'access-control-request-method': 'GET' });
  t.truthy('the dev UI\'s preflight is answered 2xx, not refused by the guard', preflight.status >= 200 && preflight.status < 300, preflight.status);
  t.check('and allows that origin', preflight.headers['access-control-allow-origin'], 'http://localhost:3210');

  // EventSource cannot send a header, so the stream takes the token as a query parameter — and a wrong one is a 401.
  const stream = await wire(port, 'GET', `/api/sessions/${s!.id}/stream?token=${'0'.repeat(64)}`, {}, undefined, 15_000);
  t.check('the event stream with a wrong token in the query is refused with 401 and an error field', [stream.status, typeof stream.json?.error], [401, 'string']);

  /*
   * The page reads the file name of a download from this header; across origins it must be exposed
   * by name. The session runs first, so the export is a real download carrying the header, not the
   * 400 a session with nothing run answers (which would only show the CORS setting, not its use).
   */
  h.chat.script(write('hello.txt', 'hi'), reply.done());
  const ran = await h.run(s!.id);
  t.check('control: the session ran, so it has something to export', ran.tasks[0]!.status, 'done');
  const exported = await wire(port, 'GET', `/api/sessions/${s!.id}/export`, { origin: 'http://localhost:3210', 'x-cop-token': token });
  t.check('the export to the dev UI is a download: 200', exported.status, 200);
  t.check('carrying a content-disposition header', typeof exported.headers['content-disposition'], 'string');
  const exposed = String(exported.headers['access-control-expose-headers'] ?? '');
  t.truthy('which is exposed to the dev UI\'s origin', /(^|,\s*)content-disposition(\s*,|$)/i.test(exposed), { status: exported.status, exposed });
});

// --- the served interface -------------------------------------------------------------------------

/*
 * Installed from npm, the API serves the prebuilt interface itself, and every page hands the browser
 * the token as a cookie that script cannot read and no other site's page can send. The cookie is
 * the token and nothing else: the right flags, scoped to /api, and accepted there on its own.
 *
 * The upper-case paths were the way round it. Express routes without regard to case, so
 * `/API/sessions` is the sessions route; the guard once decided "is this the interface or the API"
 * with a case-sensitive `startsWith('/api/')` and called it a page, which needs no token. The guard
 * now compares in lower case, as the router does, and only a read is ever a page: a request that
 * writes needs the token whatever its path, so the next such disagreement cannot start a run.
 */
{
  const web = mkdtempSync(join(tmpdir(), 'cop-guard-web-'));
  writeFileSync(join(web, 'index.html'), '<p>ui</p>', 'utf8');
  try {
    await scenario('the served interface: the cookie, and no way round the token by case', { webDir: web }, async (h) => {
      const { port, token } = h.api;
      const page = await wire(port, 'GET', '/');
      t.check('the page answers with no token', page.status, 200);
      t.truthy('and is the served file', page.text.includes('<p>ui</p>'), page.text.slice(0, 200));
      const cookies = page.headers['set-cookie'] ?? [];
      t.check('it sets exactly one cookie', cookies.length, 1);
      const cookie = /^cop_token=([0-9a-f]{64}); HttpOnly; SameSite=Strict; Path=\/api$/.exec(cookies[0] ?? '');
      t.truthy('cop_token, HttpOnly, SameSite=Strict, Path=/api and nothing else', cookie, (cookies[0] ?? '').replace(/=[0-9a-f]{64}/, '=<token>'));
      t.truthy('and its value is the API token', cookie?.[1] === token);

      const withCookie = await wire(port, 'GET', '/api/sessions', { cookie: `cop_token=${cookie?.[1] ?? ''}` });
      t.check('the cookie alone opens the API', withCookie.status, 200);
      const bare = await wire(port, 'GET', '/api/sessions');
      t.check('no cookie and no header: 401', [bare.status, bare.json?.error], [401, 'token']);

      const [s] = await h.importPlan(plan(h, 'upper', [writes('write-hello', 'hello.txt', 'hi')]));
      const upperList = await wire(port, 'GET', '/API/sessions');
      // The router's case is the guard's case: an upper-case API path is an API path and needs the token.
      t.check('GET /API/sessions with no token is refused (401)', upperList.status, 401);
      const mixedList = await wire(port, 'GET', '/Api/sessions/');
      t.check('GET /Api/sessions/ (mixed case, trailing slash) with no token is refused (401)', mixedList.status, 401);
      const upperStart = await wire(port, 'POST', `/API/sessions/${s!.id}/start`, { 'content-type': 'application/json' }, JSON.stringify({ mode: 'confirm' }));
      // Nor can it start a run: a started run would also show up as a chat problem below, since nothing was scripted.
      t.check('POST /API/sessions/<id>/start with no token is refused (401)', upperStart.status, 401);
      await h.idle();
      const after = (await h.session(s!.id)) as unknown as RunState;
      // What a start with no token would have done: open the chat and end the task.
      t.check('the session stays idle: its task still queued, no chat opened', [after.status, after.tasks[0]?.status, h.chat.opened], ['idle', 'queued', 0]);
      // The open health path is open in any case too, as the router answers it.
      const upperHealth = await wire(port, 'GET', '/API/health');
      t.check('GET /API/health answers with no token, as /api/health does', [upperHealth.status, upperHealth.json?.ok], [200, true]);

      /*
       * Only a read is a page. The interface is static files; a request that writes is never one of
       * them, so it needs the token on any path and is handed no cookie. A HEAD of the page is a read.
       */
      const posted = await wire(port, 'POST', '/', { 'content-type': 'application/json' }, '{}');
      t.check('POST / with no token is refused (401)', [posted.status, posted.json?.error], [401, 'token']);
      t.check('and is handed no cookie', posted.headers['set-cookie'] ?? null, null);
      const deleted = await wire(port, 'DELETE', '/sessions/view');
      t.check('DELETE of an interface path with no token is refused (401)', deleted.status, 401);
      const head = await wire(port, 'HEAD', '/');
      t.check('HEAD / is a read of the page: 200, with the cookie', [head.status, (head.headers['set-cookie'] ?? []).length], [200, 1]);

      // The same rules without the server, so a fix can be seen in the function as well as on the wire.
      const served = { servesInterface: true, token, port, allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`] };
      const verdict = judgeRequest({ path: '/API/sessions', headers: { host: `127.0.0.1:${port}` } }, served);
      t.check('judgeRequest refuses /API/sessions without a token when the interface is served', verdict.ok, false);
      t.check('judgeRequest refuses a POST to an interface path without a token', judgeRequest({ method: 'POST', path: '/import', headers: { host: `127.0.0.1:${port}` } }, served).ok, false);
      t.check('judgeRequest lets a GET of an interface path through without one', judgeRequest({ method: 'GET', path: '/import', headers: { host: `127.0.0.1:${port}` } }, served).ok, true);
    });
  } finally {
    rmSync(web, { recursive: true, force: true });
  }
}

// --- a checkout does not serve the interface -----------------------------------------------------

/*
 * A clone is started with `npm start`, which runs the Next.js dev server and builds the token into
 * its page (scripts/dev.mjs). A clone's API never serves the prebuilt interface — and so never hands
 * the token to whatever loads the API's root — however `dist/web` came to be there: `npm run
 * check:ui` and `build:package` both leave a built interface in the clone. The layout once served it
 * whenever the file existed, so on a machine that ran either, the API of `npm start` gave the token
 * to any GET /, a second way to it beside the dev server. The layout check builds such a clone in a
 * temporary folder, so it holds on every machine; the wire check holds for this checkout, built or
 * not.
 */
console.log('\n--- a checkout never hands the token out by accident (layout) ---');
{
  const base = mkdtempSync(join(tmpdir(), 'cop-guard-clone-'));
  const clone = join(base, 'automate-365');
  mkdirSync(join(clone, 'dist', 'web'), { recursive: true });
  writeFileSync(join(clone, 'dist', 'web', 'index.html'), '<p>built</p>', 'utf8');
  try {
    const layout = installLayout({}, clone, clone);
    t.check('a clone with a built dist/web is still a checkout', layout.mode, 'checkout');
    // A built interface left in a clone is not served: the clone's interface is the dev server.
    t.check('and serves no interface of its own (webDir null)', layout.webDir, null);
    // The control: the same build inside a package install is the interface it ships, and is served.
    const pkg = join(base, 'my-app', 'node_modules', 'copilot-operator');
    mkdirSync(join(pkg, 'dist', 'web'), { recursive: true });
    writeFileSync(join(pkg, 'dist', 'web', 'index.html'), '<p>built</p>', 'utf8');
    const installed = installLayout({}, join(base, 'my-app'), pkg);
    t.check('control: a package with the same build serves it', [installed.mode, installed.webDir], ['package', join(pkg, 'dist', 'web')]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

await scenario('a checkout never hands the token out by accident (on the wire)', {}, async (h) => {
  const builtHere = existsSync(join(import.meta.dirname, '..', 'dist', 'web', 'index.html'));
  console.log(`      (this checkout ${builtHere ? 'has' : 'has no'} dist/web/index.html)`);
  const root = await wire(h.api.port, 'GET', '/');
  // A checkout serves no page of its own, built or not, so the root is an unknown path that needs the token.
  t.check('GET / with no token and no webDir is refused (401)', root.status, 401);
  // And so the token is never handed out as a cookie to whoever asks for the root.
  t.check('and sets no cookie', root.headers['set-cookie']?.map((c) => c.replace(/=[0-9a-f]{64}/, '=<token>')) ?? null, null);
});

/*
 * And what a checkout's start-up says. `cop start` run in a clone starts this same API, which serves
 * no page there, so its lines must not send the operator to an address on the API's port that
 * answers 401; they name the dev server `npm start` runs, where a clone's interface is.
 */
console.log('\n--- a checkout says where its interface is ---');
{
  // Imported here, as the harness imports the server: once the environment it reads has been set.
  const { startupLines } = await import('../src/api/server.js');
  const common = { port: 4000, webOrigin: 'http://localhost:3210', projectRoot: 'C:\\p', homeDir: 'C:\\p', tokenFile: 'C:\\p\\data\\api-token' };
  const clone = startupLines({ ...common, served: false, mode: 'checkout' }).join('\n');
  t.truthy("a checkout's start-up does not send the browser to the API's port", !clone.includes('open http://127.0.0.1:4000/'), clone);
  t.truthy('and names the dev server npm start runs', clone.includes('the dev server npm start runs, at http://localhost:3210'), clone);
  // The control: a package that serves its interface sends the browser to its own port.
  const served = startupLines({ ...common, served: true, mode: 'package' }).join('\n');
  t.truthy('control: a package serving its interface says to open its own port', served.includes('open http://127.0.0.1:4000/'), served);
}

// --- the token file and the folders' permissions --------------------------------------------------

/*
 * The token is generated, not configured, and a blank file is not a token: an empty string would be
 * a password everybody knows. And a token any local account can read guards nothing, so the folders
 * the API keeps it and the run output in are narrowed to this account and SYSTEM at start — read back
 * here by SID, independently of the code that set them.
 */
console.log('\n--- the token file ---');
{
  const dir = mkdtempSync(join(tmpdir(), 'cop-guard-token-'));
  try {
    const first = await ensureApiToken(dir);
    t.truthy('a new token is 64 lower-case hex characters', /^[0-9a-f]{64}$/.test(first), first.length);
    t.truthy('asked again, it is the same token', (await ensureApiToken(dir)) === first);
    await writeFile(join(dir, 'api-token'), '  \n', 'utf8');
    const fresh = await ensureApiToken(dir);
    t.truthy('a blank token file is replaced by a new 64-hex token', /^[0-9a-f]{64}$/.test(fresh) && fresh !== first, fresh.length);
    t.truthy('and the file now holds that token', (await readFile(join(dir, 'api-token'), 'utf8')).trim() === fresh);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await scenario('the data and runs folders are this account\'s and SYSTEM\'s alone', {}, async (h) => {
  const me = currentSid();
  t.truthy('this account\'s SID was read', /^S-1-5-/.test(me), me);
  for (const [name, dir] of [['data', h.dataDir], ['runs', h.runsDir]] as Array<[string, string]>) {
    const sddl = sddlOf(dir);
    const principals = [...new Set(principalsInSddl(sddl))].sort();
    t.check(`${name}: granted to exactly this account and SYSTEM`, principals, [me, 'S-1-5-18'].sort());
  }
});

// --- the unattended precondition at every entrance -------------------------------------------------

/*
 * An unattended run on a machine with no isolation claimed is refused — at the start button, at the
 * batch button, and at the two buttons that turn a running session unattended ("Continue without
 * asking" and "Run this and the rest without asking"). Refused means refused before anything
 * happens: no chat opened, and nothing written onto the session as if a run had begun.
 */
await scenario('no isolation: every entrance refuses an unattended run', { settings: { execution: { isolation: 'none' } } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'noiso', [writes('write-one', 'one.txt', 'a')]));
  const id = s!.id;

  const single = await h.call<Refusal>('POST', `/sessions/${id}/start`, { mode: 'unattended' });
  t.check('start unattended is refused', single.started, false);
  t.truthy('naming execution.isolation', (single.reason ?? '').includes('execution.isolation'), single.reason);
  t.check('and no chat was opened', h.chat.opened, 0);
  const untouched = (await h.session(id)) as unknown as RunState;
  // The run is written onto the session only once every reason to refuse it has been looked at.
  t.truthy('and no run was recorded on the session (runGroup still absent)', untouched.runGroup === undefined, untouched.runGroup);

  const batch = await h.call<Refusal>('POST', '/batch/start', { sessionIds: [id], mode: 'unattended' });
  t.check('batch start unattended is refused', batch.started, false);
  t.truthy('with the same reason', (batch.reason ?? '').includes('execution.isolation'), batch.reason);
  t.check('still no chat opened', h.chat.opened, 0);

  // A supervised run, then the two ways of turning it unattended while it runs.
  h.chat.script(
    reply.steps("Set-Content -Path one.txt -Value 'a' -Encoding utf8", "Set-Content -Path two.txt -Value 'b' -Encoding utf8"),
    reply.done(),
  );
  const confirm = await h.call<Refusal>('POST', `/sessions/${id}/start`, { mode: 'confirm' });
  t.check('a supervised start is allowed', confirm.started, true);
  const first = await waitFor('the first step to wait for approval', async () => {
    const list = await h.call<Approval[]>('GET', '/approvals');
    return list.length === 1 ? list[0] : undefined;
  });
  t.check('it waits on step 1', first.stepId, 1);

  const switched = await h.call<{ ok: boolean; reason?: string }>('POST', `/sessions/${id}/mode`, { mode: 'unattended' });
  t.check('"continue without asking" is refused', switched.ok, false);
  t.truthy('naming the isolation', /isolation/.test(switched.reason ?? ''), switched.reason);

  await h.call('POST', `/approvals/${first.id}`, { action: 'run-all' });
  const second = await waitFor('step 2 to wait for approval', async () => (await h.call<Approval[]>('GET', '/approvals')).find((a) => a.stepId === 2));
  t.check('"run this and the rest": step 1 ran', existsSync(join(h.repo, 'one.txt')), true);
  t.check('but step 2 is still asked about, and has not run', [second.sessionId, existsSync(join(h.repo, 'two.txt'))], [id, false]);
  t.check('and the run is still supervised', ((await h.session(id)) as unknown as RunState).runMode, 'confirm');

  await h.call('POST', `/approvals/${second.id}`, { action: 'run' });
  await h.idle();
  t.check('the supervised run finishes', (await h.session(id)).tasks[0]!.status, 'done');
  t.check('nothing is left waiting', await h.call('GET', '/approvals'), []);
});

await scenario('isolation claimed but no allowlist: an unattended start is refused', { settings: { execution: { isolation: 'sandbox', allowedPrograms: [] } } }, async (h) => {
  const [s] = await h.importPlan(plan(h, 'nolist', [writes('write-one', 'one.txt', 'a')]));
  const single = await h.call<Refusal>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  t.check('start unattended is refused', single.started, false);
  t.truthy('naming execution.allowedPrograms', (single.reason ?? '').includes('execution.allowedPrograms'), single.reason);
  const batch = await h.call<Refusal>('POST', '/batch/start', { sessionIds: [s!.id], mode: 'unattended' });
  t.truthy('and so is the batch, for the same reason', !batch.started && (batch.reason ?? '').includes('execution.allowedPrograms'), batch);
  t.check('no chat was opened', h.chat.opened, 0);
});

// --- the policy lock, through the API ---------------------------------------------------------------

/*
 * `policy.lock.json` beside the install says `maxMode: confirm`, and the settings file says
 * unattended. The lock wins everywhere a run can be made unattended — the API takes the mode from
 * the request, so rewriting the setting alone never stopped the button (found 2026-09-27).
 *
 * The effective mode is read from GET /doctor, the route the System page shows: GET /settings
 * carries only the resolved *paths* under `resolved`, by design (see web/app/defaults/page.tsx).
 */
{
  const lockDir = mkdtempSync(join(tmpdir(), 'cop-guard-lock-'));
  writeFileSync(join(lockDir, 'policy.lock.json'), JSON.stringify({ maxMode: 'confirm' }), 'utf8');
  process.env.COP_PROJECT_ROOT = lockDir;
  try {
    await scenario('a policy lock of confirm, through every entrance', { settings: { execution: { mode: 'unattended' } } }, async (h) => {
      const settings = await h.call<{ raw: { execution?: { mode?: string } } }>('GET', '/settings');
      t.check('the settings file still says unattended', settings.raw.execution?.mode, 'unattended');
      const doctor = await h.call<{ mode: string }>('GET', '/doctor');
      t.check('but the effective mode is confirm', doctor.mode, 'confirm');

      const [s] = await h.importPlan(plan(h, 'locked', [writes('write-one', 'one.txt', 'a')]));
      const id = s!.id;
      const single = await h.call<Refusal>('POST', `/sessions/${id}/start`, { mode: 'unattended' });
      t.truthy('start unattended is refused, naming policy.lock.json', !single.started && /policy\.lock\.json/.test(single.reason ?? ''), single);
      const batch = await h.call<Refusal>('POST', '/batch/start', { sessionIds: [id], mode: 'unattended' });
      t.truthy('batch start unattended is refused the same way', !batch.started && /policy\.lock\.json/.test(batch.reason ?? ''), batch);
      t.check('no chat was opened', h.chat.opened, 0);

      h.chat.script(write('one.txt', 'a'), reply.done());
      const confirm = await h.call<Refusal>('POST', `/sessions/${id}/start`, { mode: 'confirm' });
      t.check('a supervised start is allowed', confirm.started, true);
      const step = await waitFor('the step to wait for approval', async () => (await h.call<Approval[]>('GET', '/approvals'))[0]);
      const switched = await h.call<{ ok: boolean; reason?: string }>('POST', `/sessions/${id}/mode`, { mode: 'unattended' });
      t.truthy('switching the running session to unattended is refused, naming the lock', !switched.ok && /policy\.lock\.json/.test(switched.reason ?? ''), switched);
      await h.call('POST', `/approvals/${step.id}`, { action: 'run' });
      await h.idle();
      t.check('the supervised run finishes', (await h.session(id)).tasks[0]!.status, 'done');

      // The brief a chat model writes the plan from must not send the operator to a button that says no.
      const brief = await h.call<{ text: string }>('GET', '/plan/brief?lang=en');
      t.truthy('the plan brief says runs with nobody watching are refused here', brief.text.includes('runs with nobody watching are refused'), brief.text.slice(0, 300));
      // The reason is the one the run gives, asked in the same order: a lock is a lock. Every refusal
      // that was not isolation used to be told as an empty allowlist, which sent the operator to fill
      // in a list that was already full.
      t.truthy('and does not blame an allowlist that is not empty', !brief.text.includes('the list of allowed programs is empty'));
      const why = brief.text.split('runs with nobody watching are refused')[1]?.slice(0, 600) ?? '';
      t.truthy('it names the lock as the reason', why.includes('policy.lock.json'), why);
      const briefBg = await h.call<{ text: string }>('GET', '/plan/brief?lang=bg');
      const whyBg = briefBg.text.split('пускане без надзор се отказва')[1]?.slice(0, 600) ?? '';
      t.truthy('and so does the Bulgarian brief, without blaming the allowlist',
        whyBg.includes('policy.lock.json') && !whyBg.includes('списъкът с позволени програми е празен'), whyBg);
    });
  } finally {
    delete process.env.COP_PROJECT_ROOT;
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/*
 * A lock that is present and malformed is an error, never a shrug: a deployment that meant to lock
 * something down and mistyped it must not run unlocked. Both the reader and the one function every
 * configuration passes through refuse it.
 */
console.log('\n--- a malformed lock refuses to load ---');
{
  const dir = mkdtempSync(join(tmpdir(), 'cop-guard-badlock-'));
  const lock = join(dir, 'policy.lock.json');
  try {
    writeFileSync(lock, '{not json', 'utf8');
    await rejects('a lock that is not JSON: readPolicyLocks rejects, saying so', () => readPolicyLocks(dir, {}), /is not valid JSON/);
    await rejects('and so does loadConfigObject', () => loadConfigObject({}, dir), /is not valid JSON/);
    writeFileSync(lock, JSON.stringify({ maxMode: 'whenever' }), 'utf8');
    await rejects('a lock with maxMode "whenever": rejected, naming maxMode', () => readPolicyLocks(dir, {}), /is not a valid policy lock[\s\S]*maxMode/);
    await rejects('and so does loadConfigObject', () => loadConfigObject({}, dir), /is not a valid policy lock[\s\S]*maxMode/);
    // The declined lock field for execution.networkFetch is pinned once, in gate.check.ts, not here.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- a step cannot reach the bot ---------------------------------------------------------------------

/*
 * The loopback exemption lets a task check a server it started; it must not become the way a step
 * reaches the process that approves its steps. The refusal matches the bot's port, which
 * `botPorts()` reads from COP_API_PORT (falling back to 4000) — and in every way the program is
 * really started that variable is the port the API bound: `main.ts` passes no port, so the API
 * listens on COP_API_PORT ?? 4000, and `cop start --port N` sets COP_API_PORT before it imports
 * main.js. Only the harness hands `startApi` a port without setting the variable, so this scenario
 * sets it to the bound port first, the way those entrances do, and puts it back afterwards (the
 * harnesses of this file run one after another in this process, so nothing else sees it).
 *
 * The API's port is a random free one here, never 4000 or 3210, so the refusal can only come from
 * the port the variable names — not from the fixed defaults.
 */
await scenario('a step cannot reach this API on the port it bound', {}, async (h) => {
  const port = h.api.port;
  const before = process.env.COP_API_PORT;
  process.env.COP_API_PORT = String(port);
  try {
    t.truthy('control: the port is not one of the fixed defaults', port !== 4000 && port !== 3210, port);
    const cmd = `Invoke-RestMethod http://127.0.0.1:${port}/api/health`;
    const [s] = await h.importPlan(
      plan(h, 'selfreach', [{ title: 'probe-health', prompt: 'Check that the local service answers on its health route and report what it says.' }]),
    );
    h.chat.script(reply.steps(cmd), (m) => {
      const told = `${m.text}\n${Object.values(m.attached).join('\n')}`;
      t.truthy('the chat is told the step reaches the bot itself', told.includes('reaches the bot itself'), told.slice(0, 600));
      return reply.done();
    });
    const after = await h.run(s!.id);
    const task = after.tasks[0]!;
    t.check('the task ends done', task.status, 'done');
    t.truthy('the handoff lists the command as not executed', (task.handoff?.notExecuted ?? []).some((n) => n.includes(cmd)), task.handoff?.notExecuted);
  } finally {
    if (before === undefined) delete process.env.COP_API_PORT;
    else process.env.COP_API_PORT = before;
  }
  // The other half of "the bot itself": its records by path, whatever port it listens on.
  t.truthy('botSelfRefusal refuses reading the bot\'s own pid file by path', botSelfRefusal('Get-Content C:\\bot\\dev-pids.json', [4000], 'C:\\bot') !== null);
});

// --- a task's files, by path and by owner -------------------------------------------------------------

/*
 * The routes that read a task's run folder take a run id and a file name from the URL. A run id must
 * be one this task owns — not a sibling's, not a path — and a file name must be a name. A session id
 * that is a path is refused as a bad request, not answered with a crash.
 */
await scenario('path and ownership guards on a task\'s files', {}, async (h) => {
  const { port, token } = h.api;
  const get = (path: string): Promise<Wire> => wire(port, 'GET', path, { 'x-cop-token': token });
  const [s0] = await h.importPlan(plan(h, 'paths', [writes('task-a', 'a.txt', 'alpha'), writes('task-b', 'b.txt', 'beta')]));
  h.chat.script(write('a.txt', 'alpha'), reply.done(), write('b.txt', 'beta'), reply.done());
  const s = await h.run(s0!.id);
  const a = s.tasks.find((x) => x.title === 'task-a')!;
  const b = s.tasks.find((x) => x.title === 'task-b')!;
  t.check('both tasks are done', [a.status, b.status], ['done', 'done']);
  t.truthy('each has a run of its own', !!a.runId && !!b.runId && a.runId !== b.runId, [a.runId, b.runId]);

  const A = `/api/sessions/${s.id}/tasks/${a.id}`;
  // Controls: the task's own records are there, so the 404s below are refusals and not absences.
  t.check('control: A\'s own log', (await get(`${A}/log`)).status, 200);
  t.check('control: A\'s own story by its own run id', (await get(`${A}/story?run=${a.runId}`)).status, 200);
  /*
   * A name starting with `_` is the bot's own bookkeeping and never listed. Nothing a run writes
   * today puts one in a reports folder, so one is put there (in this harness's own runs folder),
   * or the filter could go and the list would not change.
   */
  writeFileSync(join(h.runsDir, a.runId!, 'reports', '_internal.txt'), 'x', 'utf8');
  const files = (await get(`${A}/files`)).json as { reports?: string[] } | undefined;
  t.truthy('A\'s reports list its first iteration', (files?.reports ?? []).includes('iteration-1.txt'), files);
  t.truthy('but not the _-prefixed file beside it', !(files?.reports ?? []).includes('_internal.txt'), files?.reports);
  t.check('control: A\'s report by name', (await get(`${A}/files/reports/iteration-1.txt`)).status, 200);

  t.check('A\'s log with B\'s run id: 404', (await get(`${A}/log?run=${b.runId}`)).status, 404);
  t.check('A\'s story with a path for a run id: 404', (await get(`${A}/story?run=..%5C..`)).status, 404);
  /*
   * A file name that climbs out of the run folder. Three levels up from <runs>/<runId>/reports is
   * the harness's base folder, so the name lands on data/settings.json, which exists: without the
   * name guard the route would answer 200 with the settings file, not a 404 for a missing file.
   */
  const climb = '..\\..\\..\\data\\settings.json';
  t.truthy('control: that name would reach data/settings.json', existsSync(join(h.runsDir, a.runId!, 'reports', climb)), join(h.runsDir, a.runId!, 'reports', climb));
  const escaped = await get(`${A}/files/reports/${encodeURIComponent(climb)}`);
  t.check('A\'s file with a path for a name: 404', escaped.status, 404);
  t.truthy('and the answer holds nothing of the settings file', !escaped.text.includes('pacing') && !escaped.text.includes(h.runsDir), escaped.text.slice(0, 200));
  t.check('A\'s file of a kind that is not one: 400', (await get(`${A}/files/secrets/x`)).status, 400);

  const c = await h.call<{ id: string }>('POST', `/sessions/${s.id}/tasks`, {
    title: 'task-c',
    prompt: 'Create c.txt in the repository root holding exactly the word gamma, and nothing else.',
  });
  const C = `/api/sessions/${s.id}/tasks/${c.id}`;
  t.check('a queued task has no log: 404', (await get(`${C}/log`)).status, 404);
  t.check('and no story: 404', (await get(`${C}/story`)).status, 404);

  const pathGet = await get('/api/sessions/..%5C..%5Cx');
  // An id that could not be a session's file name names no session: the store answers it as missing.
  t.truthy('GET /sessions/<a path> is 400 or 404, never 500', pathGet.status === 400 || pathGet.status === 404, pathGet.status);
  // So is every route that only reads a session, not only the session's own: exactly as it answers a
  // well-formed id that names no session — a 404 for the log and the story, and for the list of a
  // task's files the empty lists any task it does not know gets.
  const answers: Record<string, { status: number; json?: unknown }> = {
    'tasks/x/log': { status: 404 },
    'tasks/x/story': { status: 404 },
    'tasks/x/files': { status: 200, json: { reports: [], artifacts: [], replies: [] } },
  };
  for (const [sub, want] of Object.entries(answers)) {
    const res = await get(`/api/sessions/..%5C..%5Cx/${sub}`);
    const missing = await get(`/api/sessions/20000101-000000-none/${sub}`);
    const shape = (w: Wire): { status: number; json?: unknown } => (want.json === undefined ? { status: w.status } : { status: w.status, json: w.json });
    t.check(`GET /sessions/<a path>/${sub} answers ${want.status}`, shape(res), want);
    t.check(`as it answers an id that names no session`, shape(res), shape(missing));
  }
  /*
   * A session id that climbs one level out of data/sessions: the store deletes `<id>.json`, so
   * `..\settings` names data/settings.json — a real file, so a missing guard would show as a
   * deleted settings file and a 200, not as nothing happening.
   */
  t.truthy('control: that id would name data/settings.json', existsSync(join(h.dataDir, 'sessions', '..\\settings.json')));
  const pathDelete = await wire(port, 'DELETE', `/api/sessions/${encodeURIComponent('..\\settings')}`, { 'x-cop-token': token });
  t.truthy('DELETE /sessions/<a path> is 400 or 404, never 200 or 500', pathDelete.status === 400 || pathDelete.status === 404, pathDelete.status);
  t.truthy('and data/settings.json is still there', existsSync(join(h.dataDir, 'settings.json')));
});

// --- the safe defaults ------------------------------------------------------------------------------

/*
 * What an empty settings file means. Each of these is a decision somebody made for a reason written
 * beside it in schema.ts; pinned here so that changing one is a deliberate edit of this file too.
 */
console.log('\n--- safe defaults cannot flip silently ---');
{
  const d = RunConfigSchema.parse({});
  t.check('execution.mode is confirm', d.execution.mode, 'confirm');
  t.check('execution.networkFetch is ask', d.execution.networkFetch, 'ask');
  t.check('execution.isolation is none', d.execution.isolation, 'none');
  t.check('copilot.keepFailurePage is false', d.copilot.keepFailurePage, false);
  t.truthy('execution.denyPatterns is not empty', d.execution.denyPatterns.length > 0, d.execution.denyPatterns.length);
  t.check('limits.maxReviewRounds is 2', d.limits.maxReviewRounds, 2);
  t.check('limits.retryBlockedInFreshChat is 2', d.limits.retryBlockedInFreshChat, 2);
}

console.log(`\n(${Math.round((Date.now() - started) / 1000)} s)`);
t.finish();
