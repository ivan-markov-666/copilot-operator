/**
 * Who is allowed to drive this API.
 *
 * The controller used to say it plainly: "There is no authentication because there is no network:
 * this API runs on the operator's own machine and drives that machine's browser." Every clause of
 * that is true and the conclusion does not follow, because "no network" is not the same as "no
 * callers". Two of them were always reachable.
 *
 * A web page. Any site the operator visits in their ordinary browser can issue requests to
 * `http://127.0.0.1:4000`. CORS stops that page *reading* the answer, which is not the point: a
 * request that starts a session has done its damage before anybody reads anything. And an origin
 * check alone is not enough either, because DNS rebinding exists — the attacker's own domain is
 * made to resolve to 127.0.0.1, and from the browser's point of view the request is then
 * same-origin. The answer to that is the `Host` header, which still carries the attacker's name.
 *
 * Another process on the machine. Anything running locally can POST to the port and queue a task
 * that runs commands. A token in a file readable by the same user does not stop a process running
 * *as* that user — nothing at this layer can — but it does stop everything that cannot read that
 * file: another account, a container, a curious script, and any of the browser cases above.
 *
 * So three checks, cheapest first, and all of them before Nest's routing sees the request:
 *
 *   host      the request must be addressed to this loopback port by name. Defeats rebinding.
 *   origin    a browser always sets it on a cross-origin request and a page cannot forge it, so
 *             an origin that is not the configured UI is refused outright rather than merely
 *             prevented from reading the reply.
 *   token     a per-install secret, in `Authorization: Bearer`, `x-cop-token`, or — for the two
 *             kinds of request that cannot carry a header at all, `EventSource` and a plain
 *             `<a download>` — the `token` query parameter.
 *
 * `/api/health` is deliberately open: `scripts/dev.mjs` polls it to find out whether the API has
 * finished starting, it says nothing but the time, and requiring a token to ask "are you up" would
 * make the start-up race harder to debug for no gain.
 *
 * The honest limit, since this is the file somebody will quote: none of this contains a process
 * already running as the operator. It raises the floor from "anything on this machine, and quite a
 * few things off it" to "something that can read a file in the install". The boundary is still the
 * account the runner runs in.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NextFunction, Request, Response } from 'express';

/** The one path that answers without a token. */
export const OPEN_PATHS = ['/api/health'];

export const TOKEN_FILE = 'api-token';

/**
 * Whether the `Host` header names this loopback port.
 *
 * The header is the attacker's own domain under DNS rebinding, which is exactly why it is worth
 * reading: the address resolves to 127.0.0.1 but it is still called `evil.example`, and a check
 * that only looked at the socket would see nothing wrong at all.
 */
export function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  let hostname = host;
  let hostPort: string | undefined;
  if (host.startsWith('[')) {
    // `[::1]:4000`
    const close = host.indexOf(']');
    if (close < 0) return false;
    hostname = host.slice(1, close);
    const rest = host.slice(close + 1);
    if (rest.startsWith(':')) hostPort = rest.slice(1);
    else if (rest.length > 0) return false;
  } else {
    const colon = host.lastIndexOf(':');
    if (colon >= 0) {
      hostname = host.slice(0, colon);
      hostPort = host.slice(colon + 1);
    }
  }
  const loopback = hostname === '127.0.0.1' || hostname === '::1' || hostname.toLowerCase() === 'localhost';
  if (!loopback) return false;
  return hostPort === undefined || hostPort === String(port);
}

/**
 * Whether a request's `Origin` is one the UI is served from.
 *
 * An absent origin is allowed through to the token check: it means the caller is not a browser —
 * `curl`, the CLI, a script — and for those the token is the whole of the answer. A *present*
 * origin that does not match is refused, because only a browser sets it and only a page on another
 * site would set it to anything else.
 */
export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true;
  const o = origin.trim().toLowerCase().replace(/\/$/, '');
  return allowed.some((a) => a.trim().toLowerCase().replace(/\/$/, '') === o);
}

/** Constant-time comparison, so a wrong token cannot be found one character at a time. */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The token a request presents, from any of the three places one can be carried. */
export function presentedToken(req: Pick<Request, 'headers' | 'query'>): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const header = req.headers['x-cop-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  if (typeof q === 'string' && q.trim()) return q.trim();
  return undefined;
}

/**
 * The install's token, read from `<dataDir>/api-token` and created there if it is not there yet.
 *
 * Generated rather than configured, so a machine that nobody has thought about is not a machine
 * with a default password. Written with owner-only permissions where the platform honours them;
 * on Windows that is a best effort and the file's protection is really the profile's, which is the
 * same protection the session store and the Edge profile already rely on.
 */
export async function ensureApiToken(dataDir: string): Promise<string> {
  const path = join(dataDir, TOKEN_FILE);
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    // Not there yet, or unreadable: make one.
  }
  const token = randomBytes(32).toString('hex');
  await mkdir(dataDir, { recursive: true });
  await writeFile(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

export type GuardOptions = { token: string; port: number; allowedOrigins: string[] };

export type GuardVerdict = { ok: true } | { ok: false; status: number; reason: string; detail: string };

/**
 * The decision, with no Express in it, so the rules can be exercised directly by a check rather
 * than through a running server. `localApiGuard` is the thin wrapper that puts it on the wire.
 */
export function judgeRequest(
  req: { path: string; headers: Record<string, unknown>; query?: Record<string, unknown> },
  opts: GuardOptions,
): GuardVerdict {
  const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
  if (!isLoopbackHost(host, opts.port)) {
    return {
      ok: false,
      status: 421,
      reason: 'host',
      detail: `this API answers only to 127.0.0.1:${opts.port}; the request was addressed to "${host ?? '(none)'}"`,
    };
  }
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!originAllowed(origin, opts.allowedOrigins)) {
    return { ok: false, status: 403, reason: 'origin', detail: `requests from ${origin} are not accepted by this API` };
  }
  if (OPEN_PATHS.includes(req.path)) return { ok: true };
  const presented = presentedToken({ headers: req.headers as Request['headers'], query: (req.query ?? {}) as Request['query'] });
  if (!tokenMatches(presented, opts.token)) {
    return {
      ok: false,
      status: 401,
      reason: 'token',
      detail:
        'this API needs the token kept in data/api-token, as an Authorization: Bearer header, an ' +
        'x-cop-token header, or a token query parameter. Restart with `npm start` and the UI is given it.',
    };
  }
  return { ok: true };
}

/** The guard as Express middleware, mounted before Nest's routing so it covers every route. */
export function localApiGuard(opts: GuardOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    /*
     * A CORS preflight carries no credentials and is answered by the CORS layer; refusing it here
     * would turn every cross-origin refusal into an opaque network error in the page rather than
     * the 401 the UI can actually say something about.
     */
    if (req.method === 'OPTIONS') {
      next();
      return;
    }
    const verdict = judgeRequest({ path: req.path, headers: req.headers as Record<string, unknown>, query: req.query as Record<string, unknown> }, opts);
    if (verdict.ok) {
      next();
      return;
    }
    res.status(verdict.status).json({ error: verdict.reason, message: verdict.detail });
  };
}
