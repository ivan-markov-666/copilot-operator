/**
 * Who may drive the API.
 *
 * The three cases worth pinning are the three that were open before. A page on another site could
 * POST to the port and CORS would not stop the *request*, only the reading of its reply. DNS
 * rebinding could make that page same-origin, so the origin check alone was never enough and the
 * `Host` header is what catches it. And any local process could call the port at all, which is
 * what the token is for. The fourth property is the boring one that keeps the tool working:
 * `/api/health` still answers without a token, because `scripts/dev.mjs` asks it whether the API
 * has finished starting.
 */
import { isLoopbackHost, judgeRequest, originAllowed, presentedToken, tokenMatches } from '../src/api/security.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const TOKEN = 'a'.repeat(64);
const OPTS = { token: TOKEN, port: 4000, allowedOrigins: ['http://localhost:3210', 'http://127.0.0.1:3210'] };
const good = (extra: Record<string, unknown> = {}) => ({ host: '127.0.0.1:4000', ...extra });

console.log('--- the Host header is what catches DNS rebinding ---');
check('the loopback address', isLoopbackHost('127.0.0.1:4000', 4000), true);
check('localhost by name', isLoopbackHost('localhost:4000', 4000), true);
check('IPv6 loopback', isLoopbackHost('[::1]:4000', 4000), true);
check('no port at all', isLoopbackHost('127.0.0.1', 4000), true);
check("an attacker's domain resolving here is refused", isLoopbackHost('evil.example:4000', 4000), false);
check('a look-alike host is refused', isLoopbackHost('127.0.0.1.evil.example:4000', 4000), false);
check('another port is refused', isLoopbackHost('127.0.0.1:9999', 4000), false);
check('no header at all is refused', isLoopbackHost(undefined, 4000), false);

console.log('\n--- a browser on another site sets Origin and cannot forge it ---');
check('the UI is allowed', originAllowed('http://localhost:3210', OPTS.allowedOrigins), true);
check('the 127.0.0.1 form too', originAllowed('http://127.0.0.1:3210', OPTS.allowedOrigins), true);
check('a trailing slash is the same origin', originAllowed('http://localhost:3210/', OPTS.allowedOrigins), true);
check('another site is refused', originAllowed('https://evil.example', OPTS.allowedOrigins), false);
check('a non-browser caller (no Origin) reaches the token check', originAllowed(undefined, OPTS.allowedOrigins), true);

console.log('\n--- the token is compared whole, in constant time ---');
check('the right token', tokenMatches(TOKEN, TOKEN), true);
check('a wrong token of the same length', tokenMatches('b'.repeat(64), TOKEN), false);
check('a prefix of the right token', tokenMatches('a'.repeat(63), TOKEN), false);
check('nothing at all', tokenMatches(undefined, TOKEN), false);
check('an empty expected token never matches', tokenMatches('', ''), false);

console.log('\n--- a token may arrive in any of the three places ---');
check('Authorization: Bearer', presentedToken({ headers: { authorization: `Bearer ${TOKEN}` }, query: {} } as never), TOKEN);
check('lower-case bearer too', presentedToken({ headers: { authorization: `bearer ${TOKEN}` }, query: {} } as never), TOKEN);
check('the x-cop-token header', presentedToken({ headers: { 'x-cop-token': TOKEN }, query: {} } as never), TOKEN);
check('the query parameter, for EventSource and <a download>', presentedToken({ headers: {}, query: { token: TOKEN } } as never), TOKEN);
check('nothing when there is nothing', presentedToken({ headers: {}, query: {} } as never), undefined);

console.log('\n--- the whole verdict, in order ---');
check('a good request passes', judgeRequest({ path: '/api/sessions', headers: good({ 'x-cop-token': TOKEN }) }, OPTS).ok, true);
const rebind = judgeRequest({ path: '/api/sessions', headers: { host: 'evil.example:4000', 'x-cop-token': TOKEN } }, OPTS);
check('a rebound host is refused even with a good token', rebind.ok, false);
check('and named as the host', rebind.ok === false && rebind.reason, 'host');
const cross = judgeRequest({ path: '/api/sessions', headers: good({ origin: 'https://evil.example', 'x-cop-token': TOKEN }) }, OPTS);
check('another origin is refused even with a good token', cross.ok, false);
check('and named as the origin', cross.ok === false && cross.reason, 'origin');
const noToken = judgeRequest({ path: '/api/sessions', headers: good() }, OPTS);
check('a local process with no token is refused', noToken.ok, false);
check('and told where the token is', noToken.ok === false && noToken.detail.includes('data/api-token'), true);

console.log('\n--- health stays open, so starting up can still be diagnosed ---');
check('health needs no token', judgeRequest({ path: '/api/health', headers: good() }, OPTS).ok, true);
check('but still not from another host', judgeRequest({ path: '/api/health', headers: { host: 'evil.example' } }, OPTS).ok, false);
check('nor from another origin', judgeRequest({ path: '/api/health', headers: good({ origin: 'https://evil.example' }) }, OPTS).ok, false);

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
