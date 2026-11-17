/**
 * CopilotTransport (src/transport/copilotTransport.ts) driven in a real browser against local pages
 * that copy the parts of Copilot's DOM it relies on — never against Copilot, never in Edge.
 *
 * The transport is the one piece of the program that clicks things on the operator's account, so
 * what is pinned here is mostly about what it must NOT click and what it must NOT take for an answer:
 *
 *   - first-run dialogs and the consent banner are only ever declined ("Set later", "Reject All"),
 *     never confirmed or accepted: confirming makes Edge the default browser, accepting agrees to
 *     tracking on the operator's behalf;
 *   - Send is the composer's own button, never the Office feedback panel's, which would submit an
 *     opinion from the operator's account;
 *   - a message that landed late is not sent a second time;
 *   - a reply is taken only once the new answer has finished streaming, from the new answer;
 *   - a human-verification challenge is never touched, only waited out;
 *   - naming a chat leaves no menu hanging over the sidebar, and finds a chat by its exact name;
 *   - the reply is read through the clipboard guard, never from the machine's clipboard, and a copy
 *     button that has turned into "Like" is not pressed;
 *   - failure dumps keep the page's HTML only when asked (it carries the account's chat titles),
 *     and a dead browser is named as a crash when Edge left a report;
 *   - the profile lock refuses a live run's profile and a live Edge, and takes over a dead run's.
 *
 * The browser is Playwright's own headless Chromium, one fresh context per page. Each page is first
 * pointed at a blank page served on 127.0.0.1 (a free port) and then given its fixture with
 * setContent: the clipboard API exists only in a secure context and about:blank is not one, nor does
 * it run init scripts. The transport is handed the page; `open()` is never called, so no profile, no
 * Edge and nothing from the network is involved.
 *
 * Three waits in the transport are fixed numbers, not options: 30 s for a message to be accepted,
 * 15 s for a copy to reach the clipboard guard, and the Edge process query is a real PowerShell run.
 * Rather than wait them out or change the product, this file shortens or answers them from the test
 * side, and says so where it does: the acceptance wait through the instance's own waitForAccepted
 * (called with a shorter limit), the copy wait through the page object the transport holds, and the
 * Edge query by standing in for spawnSync (node:module syncBuiltinESMExports, so profileLock's own
 * import sees the stand-in). Only how long is waited, or what PowerShell printed, is replaced; every
 * decision made on it is the product's.
 *
 *   npm run check:transport        (until it is registered: npx tsx test/transport.check.ts)
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  CLIPBOARD_GUARD,
  ChatLost,
  CopilotTransport,
  NO_ADDRESS_YET,
  SendRejectedError,
  isReplyTimeout,
  type TransportOptions,
} from '../src/transport/copilotTransport.js';
import { acquireProfileLock, findEdgeUsingProfile } from '../src/transport/profileLock.js';
import { DefaultChatLocators } from '../src/transport/locators.js';
import type { ChatStep } from '../src/transport/chatSteps.js';
import { buildChatName, chatNameForms, parseChatId } from '../src/transport/chatSession.js';
import { Tally } from './support/harness.js';

const t = new Tally();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = Date.now();

// Set up inside the try below, so a browser that fails to start still leaves no temp dir behind.
let base = '';
let blank = '';
let browser: Browser | undefined;

// The one page the browser ever loads: blank, on loopback, so the page is a secure context.
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>blank</title>');
});

// ---------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------

type Seen = { event: string; detail?: Record<string, unknown> };
type Fixture = { page: Page; transport: CopilotTransport; events: Seen[]; failures: string };

/** The private parts a check reaches into. `open()` would set `page`; here the fixture does. */
type Internals = {
  page: Page | null;
  context: BrowserContext | null;
  watchWindow(): void;
  clearBlockers(): Promise<void>;
  copyLastReply(): Promise<{ markdown: string; degraded: boolean }>;
};
const internals = (x: CopilotTransport): Internals => x as unknown as Internals;

const theBrowser = (): Browser => {
  if (!browser) throw new Error('the browser was not started');
  return browser;
};

const pages: Page[] = [];

function transportFor(dir: string, opts: Partial<TransportOptions>, events: Seen[]): CopilotTransport {
  return new CopilotTransport({
    profileDir: '',
    transportDir: join(dir, 'transport'),
    chatUrl: 'about:blank',
    channel: 'chromium',
    headless: true,
    replyTimeoutMs: 4_000,
    signInTimeoutMs: 1_000,
    ...opts,
    onEvent: (event, detail) => {
      events.push({ event, detail });
      opts.onEvent?.(event, detail);
    },
  });
}

/** A page holding `html`, with the clipboard guard installed the way `open()` installs it, and a transport on it. */
async function fixture(name: string, html: string, opts: Partial<TransportOptions> = {}): Promise<Fixture> {
  const page = await theBrowser().newPage();
  pages.push(page);
  await page.addInitScript(CLIPBOARD_GUARD);
  await page.goto(blank);
  await page.setContent(html);
  const dir = await mkdtemp(join(base, `${name}-`));
  const events: Seen[] = [];
  const transport = transportFor(dir, opts, events);
  internals(transport).page = page;
  return { page, transport, events, failures: join(dir, 'failures') };
}

/**
 * sendAndConfirm waits 30 s (a literal, not an option) for each attempt to be accepted. The late
 * case needs that wait to run out once; this makes the instance's own waitForAccepted run with at
 * most `ms` instead, and records what it was asked for so a check can see the shortcut was taken.
 */
type AcceptanceWait = (previousTurns: number, timeoutMs: number, text: string, shownBefore: string) => Promise<boolean>;
function shortenAcceptanceWait(x: CopilotTransport, ms: number): number[] {
  const inner = x as unknown as { waitForAccepted: AcceptanceWait };
  const real = inner.waitForAccepted.bind(x) as AcceptanceWait;
  const asked: number[] = [];
  inner.waitForAccepted = async (previousTurns, timeoutMs, text, shownBefore) => {
    asked.push(timeoutMs);
    return await real(previousTurns, Math.min(timeoutMs, ms), text, shownBefore);
  };
  return asked;
}

/** Every fixture counts clicks on anything carrying `data-count`, in the capture phase so nothing hides one. */
const COUNT = `<script>
  window.clicks = {};
  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-count]') : null;
    if (el) window.clicks[el.dataset.count] = (window.clicks[el.dataset.count] || 0) + 1;
  }, true);
</script>`;

const clicks = async (page: Page): Promise<Record<string, number>> =>
  await page.evaluate(() => (window as unknown as { clicks: Record<string, number> }).clicks);
const value = async <T>(page: Page, name: string): Promise<T> =>
  (await page.evaluate((n) => (window as unknown as Record<string, unknown>)[n], name)) as T;
const pageCall = async (page: Page, name: string, ...args: unknown[]): Promise<void> => {
  await page.evaluate(({ name, args }) => {
    (window as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args);
  }, { name, args });
};
const named = (events: Seen[], name: string): Seen[] => events.filter((e) => e.event === name);
async function rejection(p: Promise<unknown>): Promise<Error | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as Error;
  }
}

/** Runs one scenario; an exception in it is a failure of that scenario, and the rest still run. */
async function section(title: string, body: () => Promise<void>): Promise<void> {
  // One section alone, while a fix is being made: SECTION=<part of its title>.
  if (process.env.SECTION && !title.includes(process.env.SECTION)) return;
  console.log(`\n--- ${title} ---`);
  try {
    await body();
  } catch (e) {
    t.truthy(`${title}: ran to the end`, false, (e as Error).stack ?? String(e));
  } finally {
    for (const p of pages.splice(0)) await p.close().catch(() => undefined);
  }
}

/** The composer, as a contenteditable span, the way Copilot has it. */
const COMPOSER =
  '<span id="m365-chat-editor-target-element" contenteditable="true" role="textbox" aria-label="Message Copilot" ' +
  'style="display:inline-block;min-width:320px;min-height:24px;border:1px solid #888"></span>';

/** What "Copy Response" hands the page's clipboard call: the answer's raw markdown, fences intact. */
const MD = '```json\n{"status":"done"}\n```';

/**
 * profileLock runs `powershell` through spawnSync and parses what it prints. This answers that
 * call with `answer` instead of running PowerShell, for the length of `body`, and records the
 * command it was given. profileLock imports spawnSync as an ES binding; syncBuiltinESMExports is
 * Node's documented way to make such bindings follow a change to the builtin's exports object.
 */
const childProcessExports = createRequire(import.meta.url)('node:child_process') as { spawnSync: unknown };
function withEdgeQueryAnswering<T>(answer: { status: number | null; stdout: string }, body: () => T): { value: T; calls: string[][] } {
  const real = childProcessExports.spawnSync;
  const calls: string[][] = [];
  childProcessExports.spawnSync = (command: string, args: readonly string[] = []) => {
    calls.push([command, ...args]);
    return { pid: 0, output: [null, answer.stdout, ''], stdout: answer.stdout, stderr: '', status: answer.status, signal: null };
  };
  syncBuiltinESMExports();
  try {
    return { value: body(), calls };
  } finally {
    childProcessExports.spawnSync = real;
    syncBuiltinESMExports();
  }
}

try {
  base = await mkdtemp(join(tmpdir(), 'cop-transport-'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  blank = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await chromium.launch({ headless: true });

  // -------------------------------------------------------------------------------------------
  await section('the source keeps its safety settings (next to dangerous.check\'s download pins)', async () => {
    /*
     * Three properties that no local page can show, because `open()` is where they live and it
     * launches Edge: the browser keeps its sandbox, every page gets the clipboard guard before any
     * script of the chat runs, and the profile is locked before a browser is started on it.
     */
    const src = readFileSync(join(root, 'src', 'transport', 'copilotTransport.ts'), 'utf8');
    t.truthy('the browser keeps its sandbox (chromiumSandbox: true)', /chromiumSandbox:\s*true/.test(src));
    t.truthy('every page gets the clipboard guard (addInitScript(CLIPBOARD_GUARD))', /addInitScript\(CLIPBOARD_GUARD\)/.test(src));

    const openStart = src.indexOf('async open(): Promise<void> {');
    const openEnd = src.indexOf('async close(): Promise<void>', openStart);
    const openBody = openStart >= 0 && openEnd > openStart ? src.slice(openStart, openEnd) : '';
    const lockAt = openBody.indexOf('acquireProfileLock(');
    const launchAt = openBody.indexOf('launchPersistentContext(');
    t.check('open() takes the profile lock, then launches the browser', [lockAt >= 0, launchAt >= 0, lockAt < launchAt], [true, true, true]);

    // The decline-only rule, read off the list itself: a label added to it later that agrees to
    // something fails here before it ever reaches a dialog.
    const list = /async dismissPopups\(\)[\s\S]*?for \(const name of \[([^\]]*)\]\)/.exec(src)?.[1] ?? '';
    const names = [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    t.truthy('dismissPopups has its list of labels', names.length >= 5, names);
    t.check('none of them confirms, accepts, allows or agrees', names.filter((n) => /accept|confirm|allow|agree/i.test(n)), []);
    t.check('and the two decliners the comment names are in it', ['Set later', 'Reject All'].every((n) => names.includes(n)), true);
  });

  // -------------------------------------------------------------------------------------------
  await section('the sign-in wait ends on the run\'s Stop, on a closed window, and says when it ran out', async () => {
    /*
     * Waited for in one piece, up to the sign-in timeout (fifteen minutes by default), a Stop pressed while the
     * operator had not signed in yet did nothing until it ran out (2026-10-17: "the Stop button seems not to work").
     * The page here is blank: no composer ever shows.
     */
    const timed = async (run: () => Promise<unknown>): Promise<{ ms: number; error: Error | null }> => {
      const from = Date.now();
      const error = await run().then(() => null, (e: unknown) => e as Error);
      return { ms: Date.now() - from, error };
    };
    const stop = new AbortController();
    const a = await fixture('signin-stop', '<p>sign in</p>', { signInTimeoutMs: 60_000 });
    setTimeout(() => stop.abort(), 1_500);
    const stopped = await timed(() => a.transport.ensureSignedIn(blank, { signal: stop.signal }));
    t.check('stopped while waiting: it ends with the stop', [stopped.error?.name, stopped.error?.message], ['StoppedByOperator', 'stopped by the operator while waiting for the sign-in']);
    t.truthy('at once, not when the sign-in time runs out', stopped.ms < 4_000, `${stopped.ms} ms`);

    const b = await fixture('signin-closed', '<p>sign in</p>', { signInTimeoutMs: 60_000 });
    setTimeout(() => void b.page.close(), 1_500);
    const closed = await timed(() => b.transport.ensureSignedIn(blank));
    t.truthy('the window closed while waiting: it ends at once, as before', !!closed.error && closed.ms < 4_000, `${closed.ms} ms, ${closed.error?.message.split('\n')[0]}`);

    const c = await fixture('signin-out', '<p>sign in</p>', { signInTimeoutMs: 1_000 });
    const out = await timed(() => c.transport.ensureSignedIn(blank));
    t.truthy('not signed in in time: said in words, with the setting', /The sign-in was not completed within 1 s \(Settings → copilot\.signInTimeoutSec\)/.test(out.error?.message ?? ''), out.error?.message);
    t.truthy('after the page\'s own fifteen seconds and the second of the setting', out.ms >= 15_500 && out.ms < 20_000, `${out.ms} ms`);
  });

  // -------------------------------------------------------------------------------------------
  await section('dismissPopups only declines', async () => {
    /*
     * Edge's first-run dialog offers "Confirm" beside "Set later"; confirming makes Edge the
     * machine's default browser. The consent banner offers "I Accept" beside "Reject All". Both
     * sit over the chat, so the transport clears them before every message — and must pick the
     * declining button every time.
     *
     * A "Got it" that is in the accessibility tree but has no size is not on screen, so it is not
     * pressed. It has to be zero-size rather than display:none: getByRole already leaves a
     * display:none button out, and then the visibility check would never be what decides. Without
     * that check the click would wait (2 s here) and fail, and "Got it" would still be reported.
     */
    const f = await fixture('popups', `${COUNT}
      <div role="dialog" aria-label="Default browser"><p>Make Microsoft Edge your default browser?</p>
        <button data-count="Confirm">Confirm</button> <button data-count="Set later">Set later</button></div>
      <div role="dialog" aria-label="Cookies"><p>We use optional cookies.</p>
        <button data-count="I Accept">I Accept</button> <button data-count="Reject All">Reject All</button>
        <button data-count="Allow all">Allow all</button> <button data-count="Agree">Agree</button></div>
      <button data-count="hidden Got it" style="width:0;height:0;padding:0;border:0;overflow:hidden">Got it</button>`);
    f.page.setDefaultTimeout(2_000);
    const gotIt = f.page.getByRole('button', { name: 'Got it', exact: true });
    t.check('(the hidden "Got it" is in the accessibility tree, and not visible)', [await gotIt.count(), await gotIt.isVisible()], [1, false]);

    await f.transport.dismissPopups();
    const c = await clicks(f.page);
    t.check('Confirm and I Accept: never clicked', [c['Confirm'] ?? 0, c['I Accept'] ?? 0], [0, 0]);
    t.check('Set later and Reject All: clicked once each', [c['Set later'] ?? 0, c['Reject All'] ?? 0], [1, 1]);
    t.check('nothing that allows or agrees is clicked', [c['Allow all'] ?? 0, c['Agree'] ?? 0], [0, 0]);
    t.check('a hidden "Got it" is left alone', c['hidden Got it'] ?? 0, 0);
    t.check('what was dismissed is reported by name, and only that', named(f.events, 'popup-dismissed').map((e) => e.detail?.name), ['Set later', 'Reject All']);
  });

  // -------------------------------------------------------------------------------------------
  await section('send clicks the composer\'s own Send', async () => {
    /*
     * The Office feedback panel brings a button called Send of its own. A page-wide lookup then
     * finds two, and either dies on a strict-mode violation or — worse — submits the operator's
     * "opinion" of Copilot. The panel here hears Escape and stays open, which is the harder case:
     * its Send is still on the page when the composer's is looked up.
     */
    const PANEL = '<div data-testid="obf-panel" role="dialog" aria-label="Feedback"><p>How was your experience?</p>' +
      '<button type="button" aria-label="Send" data-count="panel Send">Send</button></div>';
    const SPY = `<script>
      window.panelEscapes = 0;
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.querySelector('[data-testid^="obf-"]')) window.panelEscapes += 1; });
      window.sent = [];
      document.addEventListener('click', (e) => {
        const b = e.target instanceof Element ? e.target.closest('[data-count="composer Send"]') : null;
        if (b) window.sent.push(document.getElementById('m365-chat-editor-target-element').innerText);
      }, true);
    </script>`;
    const WRAPPED = `${COUNT}${PANEL}<div data-test-id="chat-input-wrapper">${COMPOSER}` +
      `<button type="button" aria-label="Send" data-count="composer Send">Send</button></div>${SPY}`;
    // No wrapper: the composer's Send is its form's submit control; the panel's is a plain button,
    // and it comes first in the page, so an unscoped "first Send" would be the wrong one.
    const SUBMIT = `${COUNT}${PANEL}<form onsubmit="event.preventDefault()">${COMPOSER}` +
      `<button type="submit" aria-label="Send" data-count="composer Send">Send</button></form>${SPY}`;

    const f = await fixture('send', WRAPPED);
    await f.transport.send('hi');
    let c = await clicks(f.page);
    t.check('the composer\'s Send is clicked once, with the text in the composer', [c['composer Send'] ?? 0, await value<string[]>(f.page, 'sent')], [1, ['hi']]);
    t.check('the feedback panel\'s Send is never clicked', c['panel Send'] ?? 0, 0);
    t.check('the panel was sent Escape, once', await value<number>(f.page, 'panelEscapes'), 1);
    t.check('and its staying open is reported, not fatal', named(f.events, 'feedback-panel-stuck').length, 1);

    const empty = await rejection(f.transport.send('   '));
    t.truthy('an empty message is refused', /Refusing to send an empty message/.test(empty?.message ?? ''), empty?.message ?? 'it was sent');
    t.check('and nothing is clicked for it', (await clicks(f.page))['composer Send'] ?? 0, 1);

    await f.page.setContent(SUBMIT);
    f.events.length = 0;
    await f.transport.send('hi again');
    c = await clicks(f.page);
    t.check('without the wrapper, the submit-type Send is the one clicked', [c['composer Send'] ?? 0, c['panel Send'] ?? 0], [1, 0]);
    t.check('with the text in the composer', await value<string[]>(f.page, 'sent'), ['hi again']);
    t.check('and the missing wrapper is reported', named(f.events, 'send-button-wrapper-missing').length, 1);
  });

  // -------------------------------------------------------------------------------------------
  /*
   * A conversation with one turn and a composer. How the chat takes a message is the mode:
   * 'at-once' adds a turn on Send. The two late modes show nothing and keep the text in the
   * composer; the message turns up only once the sender has given up waiting — which is the moment
   * it clears the composer to try again. 'late' adds the bubble inside the existing turn, so the
   * size of the conversation never goes up: the virtualised case that sent findings twice.
   * 'late-new-turn' adds it as a new turn (size 1 -> 2), so the second attempt's own "before"
   * already counts the message and differs from the first attempt's.
   */
  const CONVERSATION = (mode: 'at-once' | 'late' | 'late-new-turn'): string => `${COUNT}
    <div data-testid="MessageListContainer" id="list">
      <div data-testid="m365-chat-llm-web-ui-chat-message">
        <div data-testid="chatQuestion" id="question-1"><div id="user-message-1">an earlier message</div></div>
        <div data-testid="chatOutput"><div data-testid="copilot-message-div">an earlier answer</div></div>
      </div>
    </div>
    <div data-test-id="chat-input-wrapper">${COMPOSER}<button type="button" aria-label="Send" data-count="Send">Send</button></div>
    <script>
      const MODE = '${mode}';
      const composer = document.getElementById('m365-chat-editor-target-element');
      let waiting = null, bubbles = 1;
      window.landedLate = false;
      const bubble = (text) => { bubbles += 1; const b = document.createElement('div'); b.id = 'user-message-' + bubbles; b.textContent = text; return b; };
      const addTurn = (text) => {
        const turn = document.createElement('div');
        turn.dataset.testid = 'm365-chat-llm-web-ui-chat-message';
        turn.appendChild(bubble(text));
        document.getElementById('list').appendChild(turn);
      };
      document.querySelector('[data-count="Send"]').addEventListener('click', () => {
        const text = composer.innerText;
        if (MODE === 'at-once') {
          addTurn(text);
          composer.textContent = '';
        } else {
          waiting = text;
        }
      });
      setInterval(() => {
        if (waiting !== null && composer.innerText.trim() === '') {
          if (MODE === 'late-new-turn') addTurn(waiting);
          else document.getElementById('question-1').appendChild(bubble(waiting));
          waiting = null;
          window.landedLate = true;
        }
      }, 100);
    </script>`;

  await section('sendAndConfirm: a message the chat takes at once', async () => {
    // The baseline the late case is measured against: one click, and the size before the send.
    const f = await fixture('confirm-at-once', CONVERSATION('at-once'));
    const turns = await f.transport.sendAndConfirm('the findings for task 3');
    t.check('resolves with the size before the send, after one click', [turns, (await clicks(f.page))['Send'] ?? 0], [1, 1]);
    t.check('and no attempt was called a failure', named(f.events, 'send-not-accepted').length, 0);
  });

  await section('sendAndConfirm never re-sends a message that landed late', async () => {
    /*
     * The first attempt gives up after the acceptance wait; the message then shows up. The second
     * attempt must look before it sends, see its own text as the newest user message, and stop —
     * a second Send here is the same findings in the chat twice, each drawing its own reply.
     * (The 30 s acceptance wait is cut to 1 s: see shortenAcceptanceWait.)
     */
    const f = await fixture('confirm-late', CONVERSATION('late'));
    const asked = shortenAcceptanceWait(f.transport, 1_000);
    const turns = await f.transport.sendAndConfirm('the findings for task 3');
    t.check('(the acceptance wait was shortened: one wait, for attempt 1)', asked.length, 1);
    t.check('Send was clicked once, not twice', (await clicks(f.page))['Send'] ?? 0, 1);
    t.check('the call resolves with the size before the first attempt', turns, 1);
    t.check('the message did land, late', await value<boolean>(f.page, 'landedLate'), true);
    t.check('attempt 1 was reported as not accepted', named(f.events, 'send-not-accepted').map((e) => e.detail?.attempt), [1]);
    t.check('attempt 2 saw it had landed after all', named(f.events, 'send-landed-after-all').map((e) => e.detail?.attempt), [2]);
    t.check('and sent nothing', named(f.events, 'message-sent').length, 1);
  });

  await section('sendAndConfirm: a late message that arrives as a new turn resolves with the first baseline', async () => {
    /*
     * What sendAndConfirm returns is the size waitForReply counts from, and in Copilot one turn
     * holds a question and its answer: the reply is awaited as the turn that holds this message.
     * Here the late message is itself that new turn, so by attempt 2 the conversation is 2 and
     * that attempt's own "before" is 2. Returning it would have the caller wait for a third turn,
     * which never comes — the answer arrives inside the second. The right answer is attempt 1's
     * baseline, 1. (In the 'late' mode both are 1, so only this mode tells them apart.)
     */
    const f = await fixture('confirm-late-new-turn', CONVERSATION('late-new-turn'));
    const asked = shortenAcceptanceWait(f.transport, 1_000);
    const turns = await f.transport.sendAndConfirm('the findings for task 3');
    t.check('(the acceptance wait was shortened: one wait, for attempt 1)', asked.length, 1);
    t.check('the late message did become a second turn', [await value<boolean>(f.page, 'landedLate'), await f.transport.turnCountNow()], [true, 2]);
    t.check('resolves with 1, the size before the first attempt — not 2, attempt 2\'s own "before"', turns, 1);
    t.check('Send was clicked once', (await clicks(f.page))['Send'] ?? 0, 1);
    t.check('attempt 2 saw it had landed after all', named(f.events, 'send-landed-after-all').map((e) => e.detail?.attempt), [2]);
  });

  // -------------------------------------------------------------------------------------------
  /*
   * A conversation for waiting on replies, `turns` of them rendered. `setsize` is the
   * conversation's real size as the page's aria-setsize reports it (0: the page does not carry it),
   * and `carrier` is where the attribute sits — on the turn element, on the first element inside
   * it, or on a wrapper around it: the three places the transport's size code looks.
   *
   * Every rendered answer is finished and has its copy button, because an old finished answer must
   * never pass for the new reply. `startReply` begins one: at 500 ms a new turn with a Stop button,
   * whose answer copies as "partial" while it streams; when the Stop button goes the answer is
   * final and copies as MD. The Stop button goes at 1.5 s, or — `copyEarly`, where the copy button
   * is on the answer from the start — at 5 s, so a copy pressed while the answer still streams
   * cannot land after the Stop button by luck, and would copy "partial".
   */
  type Carrier = 'turn' | 'inner' | 'outer';
  const REPLY = (turns: number, sized: { setsize: number; carrier: Carrier } = { setsize: 0, carrier: 'turn' }): string => `${COUNT}
    <div data-testid="MessageListContainer" id="list"></div>
    <div data-test-id="chat-input-wrapper" id="wrapper">${COMPOSER}<button type="button" aria-label="Send">Send</button></div>
    <script>
      const MD = __MD__;
      const CARRIER = '${sized.carrier}';
      const list = document.getElementById('list');
      let setsize = ${sized.setsize};
      window.copies = [];
      window.stopGoneAt = null;
      window.challengeClicks = 0;
      // The element of one list entry that carries aria-setsize. With 'outer' the entries are
      // wrappers around the turns; otherwise they are the turns themselves.
      const carrierOf = (item) => CARRIER === 'inner' ? item.firstElementChild : item;
      function addCopy(div) {
        const b = document.createElement('button');
        b.dataset.testid = 'CopyButtonTestId';
        b.setAttribute('aria-label', 'Copy Response');
        b.textContent = 'copy';
        div.appendChild(b);
      }
      function turn(id, answer, md, withCopy) {
        const el = document.createElement('div');
        el.dataset.testid = 'm365-chat-llm-web-ui-chat-message';
        el.innerHTML = '<div data-testid="chatQuestion"><div id="user-message-' + id + '">question ' + id + '</div></div>' +
          '<div data-testid="chatOutput"><div data-testid="copilot-message-div" data-id="' + id + '"><div class="body">' + answer + '</div></div></div>';
        const div = el.querySelector('[data-testid="copilot-message-div"]');
        div.dataset.md = md;
        if (withCopy) addCopy(div);
        let item = el;
        if (CARRIER === 'outer') { item = document.createElement('div'); item.setAttribute('role', 'listitem'); item.appendChild(el); }
        if (setsize) carrierOf(item).setAttribute('aria-setsize', String(setsize));
        list.appendChild(item);
        return div;
      }
      document.addEventListener('click', (e) => {
        if (e.target instanceof Element && e.target.closest('#challenge')) window.challengeClicks += 1;
        const b = e.target instanceof Element ? e.target.closest('[data-testid="CopyButtonTestId"]') : null;
        if (!b) return;
        const div = b.closest('[data-testid="copilot-message-div"]');
        window.copies.push({ id: div.dataset.id, streaming: !!document.querySelector('button[aria-label="Stop generating"]') });
        navigator.clipboard.writeText(div.dataset.md);
      }, true);
      for (let i = 1; i <= ${turns}; i += 1) turn(String(i), 'answer ' + i, 'markdown of answer ' + i, true);
      window.startReply = (copyEarly) => {
        setTimeout(() => {
          // Virtualised: the window slides — the oldest rendered entry goes, the new one comes, and
          // only aria-setsize says the conversation grew.
          if (setsize) {
            setsize += 1;
            for (const item of list.children) carrierOf(item).setAttribute('aria-setsize', String(setsize));
            list.firstElementChild.remove();
          }
          window.streamingDiv = turn('new', 'Working on it', 'partial', copyEarly);
          const stop = document.createElement('button');
          stop.setAttribute('aria-label', 'Stop generating');
          stop.textContent = 'stop';
          document.getElementById('wrapper').appendChild(stop);
        }, 500);
        setTimeout(() => {
          document.querySelector('button[aria-label="Stop generating"]').remove();
          window.stopGoneAt = Date.now();
          window.streamingDiv.querySelector('.body').textContent = 'status: done';
          window.streamingDiv.dataset.md = MD;
          if (!window.streamingDiv.querySelector('[data-testid="CopyButtonTestId"]')) addCopy(window.streamingDiv);
        }, copyEarly ? 5000 : 1500);
      };
      window.challenge = () => {
        const c = document.createElement('div');
        c.id = 'challenge';
        c.setAttribute('role', 'dialog');
        c.innerHTML = '<h2>Verify you are human</h2><label><input type="checkbox" data-count="challenge checkbox"> I am human</label> ' +
          '<button data-count="challenge Verify">Verify</button>';
        document.body.appendChild(c);
      };
      window.clearChallenge = () => { const c = document.getElementById('challenge'); if (c) c.remove(); };
    </script>`.replace('__MD__', () => JSON.stringify(MD));

  await section('waitForReply (a): resolves when the new answer has finished, with its markdown', async () => {
    /*
     * "Finished" is three things together: the conversation grew, no Stop button, and the newest
     * answer shows its copy button. The reply is read by clicking that copy button, so a click on
     * it while the answer still streams would return half an answer.
     */
    const f = await fixture('reply', REPLY(1), { replyTimeoutMs: 20_000 });
    const before = await f.transport.turnCountNow();
    await pageCall(f.page, 'startReply', false);
    const reply = await f.transport.waitForReply(before);
    t.check('the markdown of the new answer, from the clipboard guard, not degraded', [reply.markdown, reply.degraded], [MD, false]);
    t.check('copied once, from the new answer, after streaming ended', await value<unknown[]>(f.page, 'copies'), [{ id: 'new', streaming: false }]);
    t.truthy('and the answer did stream first (the Stop button came and went)', (await value<number | null>(f.page, 'stopGoneAt')) !== null);

    // The same, with the copy button already on the answer while it streams (for 4.5 s): the Stop
    // button alone must hold the read back. A copy pressed early copies "partial" while streaming.
    const g = await fixture('reply-copy-early', REPLY(1), { replyTimeoutMs: 20_000 });
    await pageCall(g.page, 'startReply', true);
    const early = await g.transport.waitForReply(1);
    t.check('a copy button shown during streaming is not pressed until the Stop button is gone', [early.markdown, await value<unknown[]>(g.page, 'copies')], [MD, [{ id: 'new', streaming: false }]]);
  });

  await section('waitForReply (b): no new turn times out as the settings\' limit, with a dump', async () => {
    /*
     * The finished answer already on the page must not be taken for the reply. When nothing comes,
     * the error is the ReplyTimeoutError the runner turns into "limit-reached" (so Continue can pick
     * the task up), it carries the configured seconds, and there is a picture of the page.
     */
    const f = await fixture('reply-timeout', REPLY(1));
    const t0 = Date.now();
    const e = await rejection(f.transport.waitForReply(1));
    const waited = Date.now() - t0;
    t.check('rejects as a reply timeout of 4 s', [isReplyTimeout(e), (e as { seconds?: number } | null)?.seconds], [true, 4]);
    t.truthy('after waiting the limit out, and not much longer', waited >= 3_500 && waited < 30_000, `${waited} ms`);
    t.check('a screenshot and the URL are in transportDir/../failures', [existsSync(join(f.failures, 'reply-timeout.png')), existsSync(join(f.failures, 'reply-timeout.url.txt'))], [true, true]);
    t.check('the page HTML is not, by default', existsSync(join(f.failures, 'reply-timeout.html')), false);
    t.check('the old answer was never copied', await value<unknown[]>(f.page, 'copies'), []);
  });

  await section('waitForReply (c): a challenge instead of a turn is waited out and never touched', async () => {
    /*
     * The chat answered the send with a human-verification challenge. The bot does not attempt it:
     * it waits for the person. Once they clear it, the reply wait ends at once with SendRejectedError
     * (the message never became a turn, so no reply is coming) rather than running out the timeout.
     * The "person" here removes the challenge half a second after the bot says it is waiting.
     */
    let human: Page | null = null;
    const f = await fixture('reply-challenge', REPLY(1), {
      replyTimeoutMs: 60_000,
      humanWaitMs: 30_000,
      onEvent: (event) => {
        if (event === 'verification-required') setTimeout(() => void human?.evaluate(() => (window as unknown as { clearChallenge: () => void }).clearChallenge()).catch(() => undefined), 500);
      },
    });
    human = f.page;
    await pageCall(f.page, 'challenge');
    const t0 = Date.now();
    const e = await rejection(f.transport.waitForReply(1));
    t.truthy('rejects with SendRejectedError', e instanceof SendRejectedError && e.name === 'SendRejectedError', e ? `${e.name}: ${e.message}` : 'it resolved');
    t.truthy('saying no reply will arrive', /not accepted/.test(e?.message ?? ''), e?.message);
    t.truthy('well before the reply timeout', Date.now() - t0 < 30_000, `${Date.now() - t0} ms`);
    t.check('nothing in the challenge was clicked', [await value<number>(f.page, 'challengeClicks'), (await clicks(f.page))['challenge checkbox'] ?? 0], [0, 0]);
    t.check('the wait was announced, then its end', [named(f.events, 'verification-required').length, named(f.events, 'verification-cleared').length], [1, 1]);
    t.truthy('with a picture of the challenge first', (await readdir(f.failures).catch(() => [] as string[])).some((n) => n.startsWith('blocker-verification-')));

    /*
     * Not cleared within humanWaitMs. Pinned as it is today: the error is clearBlockers' "complete
     * it in the Edge window and start the run again", a plain Error rather than SendRejectedError.
     * Retrying cannot clear a challenge — a person has to — and this message says so; nothing in
     * the program treats the two classes differently.
     */
    const g = await fixture('reply-challenge-stays', REPLY(1), { replyTimeoutMs: 60_000, humanWaitMs: 2_000 });
    await pageCall(g.page, 'challenge');
    const stays = await rejection(g.transport.waitForReply(1));
    t.truthy('a challenge that stays: rejects with the human-verification message, not a timeout', /human-verification challenge/.test(stays?.message ?? '') && !isReplyTimeout(stays), stays?.message ?? 'it resolved');
    t.check('and nothing in it was clicked', [await value<number>(g.page, 'challengeClicks'), (await clicks(g.page))['challenge checkbox'] ?? 0], [0, 0]);
  });

  // -------------------------------------------------------------------------------------------
  await section('blockers are never attempted', async () => {
    /*
     * The same rule from the other entry point: clearBlockers runs before every message. A
     * challenge that stays is refused with an explanation and its checkbox is never touched. A
     * transient error banner is different — it is not a person's job — and its Refresh is pressed.
     */
    const f = await fixture('blocker-challenge', `${COUNT}${COMPOSER}
      <div id="challenge" role="dialog"><h2>Verify you are human</h2>
        <label><input type="checkbox" data-count="checkbox"> I am human</label></div>`, { humanWaitMs: 2_000 });
    const found = await f.transport.detectBlocker();
    t.check('the challenge is recognised, with the evidence', found, { kind: 'verification', reason: 'page text contains "Verify you are human"' });
    const e = await rejection(internals(f.transport).clearBlockers());
    t.truthy('clearBlockers rejects with the human-verification message', /human-verification challenge/.test(e?.message ?? ''), e?.message ?? 'it resolved');
    t.check('and the checkbox has 0 clicks', (await clicks(f.page))['checkbox'] ?? 0, 0);

    const g = await fixture('blocker-banner', `${COUNT}${COMPOSER}
      <div id="banner" role="alert">Your request couldn't be completed. <button data-count="Refresh">Refresh</button></div>
      <script>document.querySelector('[data-count="Refresh"]').addEventListener('click', () => document.getElementById('banner').remove());</script>`);
    const banner = await g.transport.detectBlocker();
    t.check('the error banner is recognised as one', banner.kind, 'error-banner');
    t.check('handleBlocker presses Refresh once and reports the page usable', [await g.transport.handleBlocker(banner), (await clicks(g.page))['Refresh'] ?? 0], [true, 1]);
  });

  // -------------------------------------------------------------------------------------------
  /*
   * A sidebar of two chats. Each row's "More" shows on hover and opens a menu; "Rename" (when
   * the menu has it) opens a dialog with #new-session-name and Save. The menu closes on Escape, or
   * — `closesOn: 'outside'` — only on a press outside it, which is the fallback nameChat relies on.
   */
  /*
   * `refuse`, the source of a function of the name: the dialog's Save then refuses the names it returns true for, as
   * Copilot's does a name it counts as too long — an alert in the dialog, which stays open until Cancel.
   */
  const SIDEBAR = (withRename: boolean, closesOn: 'escape' | 'outside', refuse = 'null'): string => `${COUNT}
    <style>.row .more { visibility: hidden } .row:hover .more { visibility: visible }</style>
    <nav><ul>
      <li class="row"><a href="/chat/conversation/OTHER-1" aria-label="another chat">another chat</a> <button class="more" aria-label="More" data-count="More OTHER-1">...</button></li>
      <li class="row"><a href="/chat/conversation/ID-42" aria-label="old">old</a> <button class="more" aria-label="More" data-count="More ID-42">...</button></li>
    </ul></nav>
    ${COMPOSER}
    <script>
      const WITH_RENAME = ${withRename}, CLOSES_ON = '${closesOn}', REFUSE = ${refuse};
      let menu = null, target = null;
      const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };
      for (const a of document.querySelectorAll('a')) a.addEventListener('click', (e) => e.preventDefault());
      for (const b of document.querySelectorAll('.more')) {
        b.addEventListener('click', () => {
          closeMenu();
          target = b.parentElement.querySelector('a');
          menu = document.createElement('div');
          menu.setAttribute('role', 'menu');
          menu.innerHTML = (WITH_RENAME ? '<div role="menuitem" data-count="Rename">Rename</div>' : '') +
            '<div role="menuitem" data-count="Share">Share</div><div role="menuitem" data-count="Delete">Delete</div>';
          document.body.appendChild(menu);
          const rename = menu.querySelector('[data-count="Rename"]');
          if (rename) rename.addEventListener('click', openDialog);
        });
      }
      function openDialog() {
        closeMenu();
        const d = document.createElement('div');
        d.setAttribute('role', 'dialog');
        d.innerHTML = '<input id="new-session-name" aria-label="Chat name"> <button data-count="Save">Save</button> <button data-count="Cancel">Cancel</button>';
        d.querySelector('input').value = target.getAttribute('aria-label');
        d.querySelector('[data-count="Cancel"]').addEventListener('click', () => d.remove());
        d.querySelector('[data-count="Save"]').addEventListener('click', () => {
          const name = d.querySelector('input').value;
          if (REFUSE && REFUSE(name)) {
            if (!d.querySelector('[role="alert"]')) d.insertAdjacentHTML('beforeend', '<div role="alert">Your Copilot chat name can not be longer than 50 characters</div>');
            return;
          }
          target.setAttribute('aria-label', name);
          target.textContent = name;
          d.remove();
        });
        document.body.appendChild(d);
      }
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && CLOSES_ON === 'escape') closeMenu(); });
      document.addEventListener('mousedown', (e) => {
        if (menu && !menu.contains(e.target) && !(e.target instanceof Element && e.target.closest('.more'))) closeMenu();
      });
    </script>`;

  await section('nameChat renames through the row\'s own menu, and leaves no menu behind', async () => {
    /*
     * A chat is found again after a re-login by its name, so the rename has to happen — on the
     * right row, capped at the UI's 50 characters. When it cannot (no Rename in the menu), it says
     * so, and the menu it opened does not stay over the sidebar swallowing the next click.
     * (Each no-Rename case waits out the transport's fixed 5 s for the menu item.)
     */
    const name = 'op/x/' + 'y'.repeat(60);
    const f = await fixture('name', SIDEBAR(true, 'escape'));
    t.check('nameChat returns the name it gave', await f.transport.nameChat('ID-42', name), name.slice(0, 50));
    const label = await f.page.locator('a[href="/chat/conversation/ID-42"]').getAttribute('aria-label');
    t.check('the link\'s aria-label is the name, cut to 50 characters', [label?.length, label], [50, name.slice(0, 50)]);
    const c = await clicks(f.page);
    t.check('only that row\'s More was opened, and only Rename and Save were chosen', [c['More ID-42'] ?? 0, c['More OTHER-1'] ?? 0, c['Rename'] ?? 0, c['Save'] ?? 0, c['Delete'] ?? 0, c['Share'] ?? 0], [1, 0, 1, 1, 0, 0]);
    t.check('the other chat keeps its name', await f.page.locator('a[href="/chat/conversation/OTHER-1"]').getAttribute('aria-label'), 'another chat');
    t.check('no menu and no dialog remain', [await f.page.locator('[role="menu"]:visible').count(), await f.page.locator('#new-session-name').count()], [0, 0]);

    for (const closesOn of ['escape', 'outside'] as const) {
      const g = await fixture(`name-no-rename-${closesOn}`, SIDEBAR(false, closesOn));
      t.check(`no Rename in the menu (closes on ${closesOn}): false`, await g.transport.nameChat('ID-42', 'op/x/new'), false);
      t.check(`  and no visible [role=menu] remains`, await g.page.locator('[role="menu"]:visible').count(), 0);
      const gc = await clicks(g.page);
      t.check('  nothing in the menu was chosen instead', [gc['Delete'] ?? 0, gc['Share'] ?? 0], [0, 0]);
      t.check('  the name is unchanged and the failure reported', [await g.page.locator('a[href="/chat/conversation/ID-42"]').getAttribute('aria-label'), named(g.events, 'chat-name-failed').length], ['old', 1]);
    }
  });

  await section('nameChat: the sidebar over the "More" button takes the mouse (live 2026-10-05)', async () => {
    /*
     * As the live page had it: the chat's overflow button carries the chat's id, and another part of the
     * sidebar (the chat's link, a sticky header) lies over it and takes every mouse click. Playwright
     * retried for its whole minute and the chat kept Copilot's own title. Now the button is found by the
     * chat id and clicked on the element itself, and a rename counts only when the sidebar shows it.
     */
    const covered = SIDEBAR(true, 'escape')
      .replace('data-count="More ID-42"', 'data-count="More ID-42" data-chat-history-more-button-conversation-id="ID-42"')
      .replace('<nav><ul>', '<div id="cover" style="position:fixed;inset:0;z-index:10;background:transparent"></div><nav><ul>')
      // The cover takes the mouse; the menu and the dialog it opens stay above it, as the live page's do.
      .replace("document.body.appendChild(menu);", "menu.style.cssText = 'position:relative;z-index:20'; document.body.appendChild(menu);")
      .replace("document.body.appendChild(d);", "d.style.cssText = 'position:relative;z-index:20'; document.body.appendChild(d);");
    const f = await fixture('name-covered', covered);
    const started = Date.now();
    const ok = await f.transport.nameChat('ID-42', 'op/ab/covered');
    const took = Date.now() - started;
    t.check('renamed, though the mouse cannot reach the button', [ok, await f.page.locator('a[href="/chat/conversation/ID-42"]').getAttribute('aria-label')], ['op/ab/covered', 'op/ab/covered']);
    t.truthy('in seconds, not the minute of retries', took < 20_000, `${took} ms`);
    const c = await clicks(f.page);
    t.check('that chat\'s More only, then Rename and Save', [c['More ID-42'] ?? 0, c['More OTHER-1'] ?? 0, c['Rename'] ?? 0, c['Save'] ?? 0], [1, 0, 1, 1]);
  });

  await section('nameChat: a name Copilot refuses as too long is offered shorter, and the dialog is never left open', async () => {
    /*
     * The operator saw the bot try to save a chat name longer than 50 characters, and it broke the run (2026-10-17):
     * Copilot's dialog refused it and stayed open over the chat. Here the dialog counts UTF-8 bytes, so a Bulgarian
     * session's name of 50 letters is too long for it. The next, shorter form is taken, and that is the name returned.
     */
    // A name with Cyrillic in it, as one was made before names were put in Latin letters (see `buildChatName`).
    const asked = 'op/ab/' + 'Създай-калкулатор-с-тестове-и-документация-за-потребителя'.slice(0, 44);
    const forms = chatNameForms(asked);
    const made = buildChatName('ab', 'Създай калкулатор с тестове и документация за потребителя');
    t.check('the bot\'s own name for a Bulgarian session: Latin letters, 50 at most', [made, /^[\x20-\x7e]+$/.test(made), made.length <= 50], ['op/ab/Sazday-kalkulator-s-testove-i-dokumentatsiya', true, true]);
    t.truthy('the name asked for is 50 characters, and more than 50 bytes', asked.length <= 50 && Buffer.byteLength(asked, 'utf8') > 50, { asked, letters: asked.length, bytes: Buffer.byteLength(asked, 'utf8') });
    const bytes = await fixture('name-bytes', SIDEBAR(true, 'escape', "(n) => new TextEncoder().encode(n).length > 50"));
    const took = await bytes.transport.nameChat('ID-42', asked);
    const shown = await bytes.page.locator('a[href="/chat/conversation/ID-42"]').getAttribute('aria-label');
    t.check('the shorter form the dialog takes is the chat\'s name, and what is returned', [took, shown], [forms[1], forms[1]]);
    t.truthy('a form of the same name: its prefix, code and start kept, 50 bytes at most', !!forms[1] && asked.startsWith(forms[1]) && forms[1].startsWith('op/ab/') && Buffer.byteLength(forms[1], 'utf8') <= 50, forms);
    t.check('the refusal is on record, and no dialog or menu remains', [named(bytes.events, 'chat-name-refused').length, await bytes.page.locator('#new-session-name').count(), await bytes.page.locator('[role="menu"]:visible').count()], [1, 0, 0]);

    // A dialog that takes nothing: every form offered, then Cancel; the chat keeps its name and the run is told.
    const none = await fixture('name-none', SIDEBAR(true, 'escape', '() => true'));
    t.check('no form taken: false', await none.transport.nameChat('ID-42', asked), false);
    t.check('every form was offered, then the dialog was closed with Cancel', [named(none.events, 'chat-name-refused').length, (await clicks(none.page))['Cancel'] ?? 0, await none.page.locator('#new-session-name').count()], [forms.length, 1, 0]);
    t.check('the name is unchanged and the failure said', [await none.page.locator('a[href="/chat/conversation/ID-42"]').getAttribute('aria-label'), named(none.events, 'chat-name-failed').length], ['old', 1]);
  });

  await section('openConversationByName matches the whole name', async () => {
    /*
     * Chat names share prefixes: "op/ab/x" and "op/ab/x-2" are two tasks' chats. The one that comes
     * first in the sidebar must not be taken for the one asked for. A quote in a name must not break
     * the lookup, and a name that is not there is a plain false.
     */
    const f = await fixture('by-name', `${COUNT}<nav>
      <a href="/chat/conversation/A2" aria-label="op/ab/x-2" data-count="op/ab/x-2">op/ab/x-2</a>
      <a href="/chat/conversation/A1" aria-label="op/ab/x" data-count="op/ab/x">op/ab/x</a>
      <a href="/chat/conversation/Q1" aria-label='say "hi"' data-count='say "hi"'>say "hi"</a>
    </nav>${COMPOSER}
    <script>for (const a of document.querySelectorAll('a')) a.addEventListener('click', (e) => e.preventDefault());</script>`);
    t.check('op/ab/x opens op/ab/x, not op/ab/x-2', [await f.transport.openConversationByName('op/ab/x'), await clicks(f.page)], [true, { 'op/ab/x': 1 }]);
    const quoted = await f.transport.openConversationByName('say "hi"').then((ok) => String(ok), (e: Error) => `threw: ${e.message}`);
    t.check('a name with a double quote does not throw, and is found', [quoted, (await clicks(f.page))['say "hi"'] ?? 0], ['true', 1]);
    t.check('an unknown name returns false and clicks nothing', [await f.transport.openConversationByName('op/ab/none'), Object.values(await clicks(f.page)).reduce((a, b) => a + b, 0)], [false, 2]);
  });

  // -------------------------------------------------------------------------------------------
  await section('ensureOnChat: a window that left its conversation is put back on it, or nothing is sent', async () => {
    /*
     * Operator, 2026-11-09: a task left paused, or waiting on a card, for some days went on in a new chat on Auto. The
     * window is held to the conversation the bot put it on, by the uuid in its address. Copilot's addresses are served
     * here by the page's own routes: a conversation, the home page (a new chat), a sign-in page that sends the operator
     * back to the home page once they have signed in, and a conversation that no longer opens (it goes to the home page).
     */
    const A = '11111111-2222-3333-4444-555555555555';
    const B = '22222222-3333-4444-5555-666666666666';
    const C = '33333333-4444-5555-6666-777777777777';
    const HOME = 'https://m365.cloud.microsoft/chat?es=SSR';
    const conv = (id: string): string => `https://m365.cloud.microsoft/chat/conversation/${id}?es=SSR`;
    const state = { signInFirst: 0, signInForever: false, gone: new Set<string>(), served: [] as string[] };
    const f = await fixture('on-chat', COMPOSER, { signInTimeoutMs: 4_000 });
    await f.page.route(/^https:\/\/m365\.cloud\.microsoft\//, async (route) => {
      const url = route.request().url();
      if (route.request().resourceType() !== 'document') return await route.fulfill({ status: 204, body: '' });
      const id = parseChatId(url);
      state.served.push(url.replace(/\?.*$/, ''));
      const html = (body: string): Promise<void> => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8">${body}` });
      if (id && (state.signInForever || state.signInFirst > 0)) {
        if (!state.signInForever) state.signInFirst -= 1;
        // The operator signs in, and Microsoft brings them back to Copilot's home page, not to the conversation.
        return await html(`<title>Sign in</title><p>Pick an account</p>${state.signInForever ? '' : `<script>setTimeout(() => location.href = ${JSON.stringify(HOME)}, 1200)</script>`}`);
      }
      if (id && state.gone.has(id)) return await html(`<script>location.replace(${JSON.stringify(HOME)})</script>`);
      if (id) return await html(`<title>conversation</title>${COMPOSER}<p id="conv">${id}</p>`);
      // The home page: a new chat, and the sidebar, whose link moves the page without loading it, as Copilot's does.
      return await html(`<title>Copilot</title>${COMPOSER}<nav><a href="/chat/conversation/${A}" aria-label="op/ab/away">op/ab/away</a></nav>
        <script>document.querySelector('nav a').addEventListener('click', (e) => { e.preventDefault(); history.pushState({}, '', ${JSON.stringify(`/chat/conversation/${A}?es=SSR`)}); });</script>`);
    });
    const tr = f.transport;
    type Held = { onChat: { id: string } | 'new' | null; firstLookMs: number; chatNames: Map<string, string> };
    const held = tr as unknown as Held;
    const events = (from: number): string[] => f.events.slice(from).map((e) => e.event);

    t.check('a window nobody put on a conversation is not held to one', await tr.ensureOnChat(), { at: 'unknown' });
    t.check('opened on A', await tr.openConversation(A), true);
    let served = state.served.length;
    t.check('on A: nothing to do, and nothing loaded', [await tr.ensureOnChat(), state.served.length - served], [{ at: 'here' }, 0]);

    // The page went to Copilot's home page: a new chat, on the default model.
    await f.page.goto(HOME);
    let seen = f.events.length;
    t.check('on the home page: put back on A by its address',
      [await tr.ensureOnChat(), parseChatId(f.page.url())],
      [{ at: 'returned', chatId: A, from: 'https://m365.cloud.microsoft/chat', by: 'address', signedIn: false }, A]);
    t.check('said as it happened: left, then back', [events(seen), f.events[seen]?.detail], [['chat-left', 'chat-returned'], { chatId: A, found: 'https://m365.cloud.microsoft/chat' }]);

    // The operator opened another conversation in the window.
    await f.page.goto(conv(B));
    t.check('on another conversation: put back on A', [(await tr.ensureOnChat()).at, parseChatId(f.page.url())], ['returned', A]);

    // The session ran out while the window waited: the page asks for a sign-in, which the operator does.
    held.firstLookMs = 1_000;
    await f.page.goto(HOME);
    state.signInFirst = 1;
    seen = f.events.length;
    const signedIn = await rejection(tr.ensureOnChat({}).then((r) => {
      t.check('after the sign-in, put back on A by its address, saying a sign-in came first', [r, parseChatId(f.page.url())], [{ at: 'returned', chatId: A, from: 'https://m365.cloud.microsoft/chat', by: 'address', signedIn: true }, A]);
    }));
    t.check('the sign-in waited for, never done by the bot', [signedIn?.message ?? null, events(seen)], [null, ['chat-left', 'sign-in-required', 'signed-in', 'chat-returned']]);
    t.check('the sign-in page\'s address is said without its query', f.events.find((e, i) => i >= seen && e.event === 'sign-in-required')?.detail, { url: `https://m365.cloud.microsoft/chat/conversation/${A}` });

    // A Stop while the sign-in is waited for ends the wait at once.
    state.signInForever = true;
    await f.page.goto(HOME);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 1_500);
    const from = Date.now();
    const stopped = await rejection(tr.ensureOnChat({ signal: stop.signal }));
    t.check('Stop while the sign-in is waited for: it ends with the stop', [stopped?.name, stopped?.message], ['StoppedByOperator', 'stopped by the operator while waiting for the sign-in']);
    t.truthy('at once, not when the sign-in time runs out', Date.now() - from < 4_000, `${Date.now() - from} ms`);
    t.check('and the window is still held to A', held.onChat, { id: A });
    // Not signed in in time.
    await f.page.goto(HOME);
    const late = await rejection(tr.ensureOnChat());
    t.truthy('a sign-in not done in time: said, with the setting, and that nothing was sent', /it was not completed within 4 s \(Settings → copilot\.signInTimeoutSec\)\. Nothing was sent/.test(late?.message ?? ''), late?.message);
    state.signInForever = false;

    // A no longer opens by its address: found by the name it was given in the sidebar.
    state.gone.add(A);
    held.chatNames.set(A, 'op/ab/away');
    await f.page.goto(conv(B));
    seen = f.events.length;
    t.check('its address takes the page elsewhere: put back on A by its name', [await tr.ensureOnChat(), parseChatId(f.page.url())], [{ at: 'returned', chatId: A, from: `https://m365.cloud.microsoft/chat/conversation/${B}`, by: 'name', signedIn: false }, A]);

    // And with no name to find it by: nothing is sent, and the page found is not taken for it.
    held.chatNames.clear();
    await f.page.goto(HOME);
    seen = f.events.length;
    served = state.served.length;
    const lostErr = await rejection(tr.ensureOnChat());
    t.check('it will not open again: ChatLost, naming the conversation and where the window was', [lostErr instanceof ChatLost, (lostErr as ChatLost | null)?.chatId, (lostErr as ChatLost | null)?.found], [true, A, 'https://m365.cloud.microsoft/chat']);
    t.truthy('its message says nothing was sent and nothing went into another chat', /could not be opened again, by its address or by its name in the sidebar, so nothing was sent, and nothing went into another chat/.test(lostErr?.message ?? ''), lostErr?.message);
    t.check('said as it happened: left, then lost', events(seen), ['chat-left', 'chat-lost']);
    t.check('the window is still held to A: the next message is refused the same way', [held.onChat, (await rejection(tr.ensureOnChat()))?.name], [{ id: A }, 'ChatLost']);
    state.gone.clear();

    // A new conversation has no address until its first answer; from then on it is held to the one it got.
    await tr.newChat();
    t.check('a new conversation, before its first answer: nothing to compare', [await tr.ensureOnChat(), held.onChat], [{ at: 'here' }, 'new']);
    await f.page.evaluate((id) => history.pushState({}, '', `/chat/conversation/${id}?es=SSR`), C);
    t.check('answered, it takes the address the page shows', [await tr.ensureOnChat(), held.onChat], [{ at: 'here' }, { id: C }]);
    await f.page.goto(HOME);
    t.check('and is put back on it when the page leaves it', [(await tr.ensureOnChat()).at, parseChatId(f.page.url())], ['returned', C]);

    // Signing in again, as at the start of a message, expects no conversation until the run enters one.
    await tr.ensureSignedIn(HOME);
    t.check('after ensureSignedIn: not held to one', await tr.ensureOnChat(), { at: 'unknown' });
  });

  // -------------------------------------------------------------------------------------------
  await section("Copilot's home page instead of the chat: the chat is opened from it, on the host it is on", async () => {
    /*
     * Operator, 2026-11-17: the start ended on "The page is not the Microsoft 365 Copilot chat. Current URL:
     * https://copilot.cloud.microsoft/home?es=SSR&redirfrom=mcmToCcm". The box to write in had shown — no sign-in was asked
     * for — and seven seconds after the window opened the page was Copilot's home page, with none; the bot looked once and
     * gave up. Served here by the page's routes, on both hosts: the old host's chat shows the box and moves to the new
     * host's home page a moment later (`flicker`), or at once with no box (as a server's redirect would); the home page
     * has no box, and a link to its chat that moves the page without loading it, as Copilot's own links do (`homeLink`);
     * the new host's chat has the box, or, loaded by its address, sends to the home page as well (`chatBounces`).
     * The transport's waits are shortened from the test side: the first look, the box staying, the other page's grace.
     */
    const OLD = 'https://m365.cloud.microsoft';
    const NEW = 'https://copilot.cloud.microsoft';
    const HOME = `${NEW}/home?es=SSR&redirfrom=mcmToCcm`;
    const A = '55555555-6666-7777-8888-999999999999';
    const state = { flicker: true, homeLink: true, chatBounces: false, served: [] as string[] };
    const f = await fixture('copilot-home', '<p>blank</p>', { signInTimeoutMs: 3_000 });
    const tr = f.transport;
    type Timing = { firstLookMs: number; settleMs: number; otherPageMs: number; chatOrigin: string };
    const held = tr as unknown as Timing;
    held.firstLookMs = 6_000;
    held.settleMs = 800;
    held.otherPageMs = 800;
    const link = `<nav><a id="to-chat" href="/chat?es=SSR">Chat</a></nav><script>
      document.getElementById('to-chat').addEventListener('click', (e) => {
        e.preventDefault();
        history.pushState({}, '', '/chat?es=SSR');
        document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(COMPOSER)});
      });</script>`;
    await f.page.route(/^https:\/\/(m365|copilot)\.cloud\.microsoft\//, async (route) => {
      if (route.request().resourceType() !== 'document') return await route.fulfill({ status: 204, body: '' });
      const url = new URL(route.request().url());
      state.served.push(`${url.origin}${url.pathname}`);
      const html = (body: string): Promise<void> => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8">${body}` });
      const toHome = (ms: number): string => `<script>setTimeout(() => location.replace(${JSON.stringify(HOME)}), ${ms})</script>`;
      if (url.origin === OLD) return await html(state.flicker ? `${COMPOSER}${toHome(300)}` : toHome(0));
      if (url.pathname === '/home') return await html(`<title>Copilot</title><p>Recent files</p>${state.homeLink ? link : ''}`);
      if (state.chatBounces) return await html(toHome(0));
      return await html(`<title>Copilot</title>${COMPOSER}<p id="conv">${parseChatId(url.href) ?? 'new'}</p>`);
    });
    const at = (): string => f.page.url().replace(/\?.*$/, '');
    const box = async (): Promise<boolean> => await f.page.locator('#m365-chat-editor-target-element').isVisible();
    const timed = async (run: () => Promise<unknown>): Promise<{ ms: number; error: Error | null }> => {
      const from = Date.now();
      const error = await run().then(() => null, (e: unknown) => e as Error);
      return { ms: Date.now() - from, error };
    };

    // As on the work machine: the box shows, then the page is Copilot's home page.
    let seen = f.events.length;
    let served = state.served.length;
    const flick = await timed(() => tr.ensureSignedIn(`${OLD}/chat`));
    t.check('the box shown, then the home page: signed in, not refused as "not the Microsoft 365 Copilot chat"', flick.error?.message ?? null, null);
    t.check('on the new host\'s chat, with its box', [at(), await box()], [`${NEW}/chat`, true]);
    t.check('the chat opened by its address on the host the home page is on, and said', [named(f.events.slice(seen), 'chat-page-elsewhere').map((e) => e.detail), state.served.slice(served)], [[{ found: `${NEW}/home`, by: 'address', to: `${NEW}/chat` }], [`${OLD}/chat`, `${NEW}/home`, `${NEW}/chat`]]);
    t.check('not taken for a sign-in', named(f.events.slice(seen), 'sign-in-required').length, 0);

    // From then on, the chat's addresses on the host it was found on: not through the old host's redirect.
    t.check('the host the chat was found on is kept', held.chatOrigin, NEW);
    served = state.served.length;
    await tr.newChat();
    t.check('a new chat: straight to the new host', [state.served.slice(served), at()], [[`${NEW}/chat`], `${NEW}/chat`]);
    served = state.served.length;
    t.check('a conversation: straight to the new host, and opened', [await tr.openConversation(A), state.served.slice(served), parseChatId(f.page.url())], [true, [`${NEW}/chat/conversation/${A}`], A]);

    // A redirect with no box at all: Copilot's home page is not waited on as a sign-in for the whole first look.
    state.flicker = false;
    seen = f.events.length;
    const direct = await timed(() => tr.ensureSignedIn(`${OLD}/chat`));
    t.check('no box at all on the way: on the chat all the same, no sign-in asked for', [direct.error?.message ?? null, at(), named(f.events.slice(seen), 'sign-in-required').length], [null, `${NEW}/chat`, 0]);
    t.truthy('and without waiting out the first look', direct.ms < 5_000, `${direct.ms} ms`);

    // The chat's address sends to the home page as well: the page's own link to its chat is followed.
    state.flicker = true;
    state.chatBounces = true;
    seen = f.events.length;
    const byLink = await timed(() => tr.ensureSignedIn(`${OLD}/chat`));
    t.check('its address sends to the home page too: the home page\'s link to the chat', [byLink.error?.message ?? null, at(), await box()], [null, `${NEW}/chat`, true]);
    t.check('said both ways, in order', named(f.events.slice(seen), 'chat-page-elsewhere').map((e) => e.detail?.by), ['address', 'link']);

    // Neither gets past the home page: said as what it is, with a picture of it — not a sign-in, not fifteen minutes.
    state.homeLink = false;
    seen = f.events.length;
    const stuck = await timed(() => tr.ensureSignedIn(`${OLD}/chat`));
    t.truthy('neither way: refused, naming the page found and what was tried', /^Copilot showed its page https:\/\/copilot\.cloud\.microsoft\/home instead of the chat, and the chat did not open from there \(by its address on that host, nor by a link to it on the page\)\. Nothing was sent\./.test(stuck.error?.message ?? ''), stuck.error?.message);
    t.truthy('with the full address last, as before', (stuck.error?.message ?? '').endsWith(`\nCurrent URL: ${HOME}`), stuck.error?.message);
    const pictures = await readdir(f.failures).catch(() => [] as string[]);
    const png = pictures.find((x) => /^locator-composer-\d+\.png$/.test(x));
    const html = pictures.find((x) => /^locator-composer-\d+\.html$/.test(x));
    t.truthy('a picture of the page and its HTML are kept, and the message says where', !!png && !!html && (stuck.error?.message ?? '').includes(join(f.failures, png)) && (stuck.error?.message ?? '').includes(join(f.failures, html)), { pictures, message: stuck.error?.message });
    t.check("said as the box's locator (2026-11-17: it was the box)", [stuck.error?.name, (stuck.error as { key?: string } | null)?.key, named(f.events.slice(seen), 'locator-missing').map((e) => [e.detail?.key, e.detail?.stopped])], ['LocatorMissing', 'composer', [['composer', true]]]);
    t.check('not taken for a sign-in, and over in seconds', [named(f.events.slice(seen), 'sign-in-required').length, stuck.ms < 10_000], [0, true]);
    t.truthy('a new chat: refused the same way', /^Copilot showed its page https:\/\/copilot\.cloud\.microsoft\/home instead of the chat/.test((await rejection(tr.newChat()))?.message ?? ''));
    const lost = await timed(() => tr.openConversation(A).then((ok) => { if (ok) throw new Error('opened'); }));
    t.check('a conversation: not opened — the caller looks for it by its name — in seconds', [lost.error?.message ?? null, lost.ms < 10_000], [null, true]);
  });

  // -------------------------------------------------------------------------------------------
  await section('the box to write in of 17 November 2026, and the box\'s locator in Settings', async () => {
    /*
     * Operator, 2026-11-17, with 0.1.88: "Copilot showed its page https://copilot.cloud.microsoft/home instead of the chat"
     * — and its picture showed the chat. Copilot's chat is at /home now (its /chat goes there), and its box to write in is
     * no longer the span with the id `m365-chat-editor-target-element`: it is a Lexical editor, as the operator's
     * inspector showed it, inside the same wrapper as before. Served here as the work page has it: the old host's chat
     * goes to the new host's /home, and so does the new host's /chat. The box's locator is Settings' own when set
     * (`copilot.chatLocators.composer`), else the default, which finds the old box and this one.
     */
    const OLD = 'https://m365.cloud.microsoft';
    const NEW = 'https://copilot.cloud.microsoft';
    const BOX = '<span role="textbox" contenteditable="true" tabindex="0" aria-label="Message Copilot" aria-multiline="true" data-copilot-initial-focus="" data-lexical-editor="true" style="display:inline-block;min-width:320px;min-height:24px;border:1px solid #888"><p><br></p></span>';
    // The work page's box, in its wrapper, with Send beside it; `own` puts a box of another shape outside the wrapper instead.
    const page = (own: boolean): string =>
      `<title>Copilot</title><h1><span>Hi, how can I help?</span></h1><script>window.sent = [];</script>
      <div data-test-id="chat-input-wrapper" id="m365-chat-input-shared-container"><div><div class="azFuQXgw" data-chat-input-root><div class="MXYyX0cx" data-chat-input-pill>
        <div class="UWtvTmFf"><span aria-hidden="true" class="TFlDcUdq">Message Copilot</span><div class="cFhyQ01M"><span class="fai-EditorInput">${own ? '' : BOX}</span></div></div>
        <button aria-label="Send" onclick="window.sent.push((document.querySelector('[data-lexical-editor], #my-box') || {}).innerText)">send</button>
      </div></div></div></div>${own ? '<div id="my-box" contenteditable="true" style="min-width:320px;min-height:24px;border:1px solid #888"></div>' : ''}`;
    const state = { own: false };
    const open = async (name: string, chatLocators?: Record<string, string>): Promise<Fixture> => {
      const f = await fixture(name, '<p>blank</p>', { signInTimeoutMs: 2_000, ...(chatLocators ? { chatLocators } : {}) });
      const held = f.transport as unknown as { firstLookMs: number; settleMs: number; otherPageMs: number };
      held.firstLookMs = 4_000;
      held.settleMs = 600;
      held.otherPageMs = 600;
      await f.page.route(/^https:\/\/(m365|copilot)\.cloud\.microsoft\//, async (route) => {
        if (route.request().resourceType() !== 'document') return await route.fulfill({ status: 204, body: '' });
        const url = new URL(route.request().url());
        const html = (body: string): Promise<void> => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8">${body}` });
        // The old host's chat, and the new host's, both go to the new host's /home, where the chat is.
        if (url.pathname !== '/home') return await html(`<script>location.replace(${JSON.stringify(`${NEW}/home?es=SSR&redirfrom=mcmToCcm`)})</script>`);
        return await html(page(state.own));
      });
      return f;
    };
    const at = (f: Fixture): string => f.page.url().replace(/\?.*$/, '');

    // The default: the work page's new box is found, at /home, which is the chat.
    const a = await open('box-2026-11-17');
    const signedIn = await rejection(a.transport.ensureSignedIn(`${OLD}/chat`));
    t.check('the new box, by the default locator: signed in on /home, not refused', [signedIn?.message ?? null, at(a)], [null, `${NEW}/home`]);
    t.check('nothing taken for a sign-in, no move away from the chat', [named(a.events, 'sign-in-required').length, named(a.events, 'chat-page-elsewhere').length], [0, 0]);
    t.check('the host the chat was found on is kept, though its address is /home', (a.transport as unknown as { chatOrigin: string }).chatOrigin, NEW);
    t.check('a new chat: on /home, its box there', [await rejection(a.transport.newChat()).then((e) => e?.message ?? null), at(a)], [null, `${NEW}/home`]);
    await a.transport.send('hello from the bot');
    t.check('a message is written in the new box and sent with its Send', await value<string[]>(a.page, 'sent'), ['hello from the bot']);

    // A box the default does not find: refused, saying the box's locator in force and where Settings has it.
    state.own = true;
    const b = await open('box-own-default');
    const refused = await rejection(b.transport.ensureSignedIn(`${OLD}/chat`));
    t.truthy('a box the default does not find: the message names the locator in force and the Settings field', (refused?.message ?? '').includes(`the box's locator does not find it: ${DefaultChatLocators.composer} (Settings → "The chat's locators" → "Box to write in").`), refused?.message);

    // Settings' locator for it: found, and written in.
    const c = await open('box-own-settings', { composer: '  #my-box ' });
    t.check("Settings' locator: signed in, and the message goes in that box", [await rejection(c.transport.ensureSignedIn(`${OLD}/chat`)).then((e) => e?.message ?? null), await c.transport.send('in my box').then(() => value<string[]>(c.page, 'sent'))], [null, ['in my box']]);

    // The operator's own locator from the inspector named the box's wrapper: the box inside it is the one written in.
    state.own = false;
    const d = await open('box-wrapper', { composer: '#m365-chat-input-shared-container > div > div > div.MXYyX0cx' });
    t.check("a locator of the box's wrapper: the box inside it is used", [await rejection(d.transport.ensureSignedIn(`${OLD}/chat`)).then((e) => e?.message ?? null), await d.transport.send('through the wrapper').then(() => value<string[]>(d.page, 'sent'))], [null, ['through the wrapper']]);

    // One saved that cannot be used: said, and the default is used.
    const e = await open('box-bad-xpath', { composer: '//div/parent:span' });
    t.check('a saved locator that cannot be used: the default, and said why', [await rejection(e.transport.ensureSignedIn(`${OLD}/chat`)).then((x) => x?.message ?? null), named(e.events, 'chat-locator-not-used').map((x) => x.detail?.problem)], [null, ['the chat\'s composer locator in Settings is not used, "parent:" needs two colons: parent::']]);
  });

  // -------------------------------------------------------------------------------------------
  await section("a locator that finds nothing: which one, the page's HTML for a chatbot, and a message never sent twice", async () => {
    /*
     * Operator, 2026-11-17: "a mechanism that detects which locator exactly the bot failed on … the bot saves the page's
     * HTML and gives it to the user, to give to a chatbot". Every place the bot needs an element of the chat says, when
     * its locator finds nothing, which locator it was (`LocatorMissing`, `locator-missing`), and keeps a picture and the
     * page's HTML with scripts, styles, handlers and the sidebar's conversation names taken out. The transport's waits are
     * shortened from the test side.
     */
    type Waits = { sendWaitMs: number; acceptMs: number; turnsGraceMs: number; answerStillMs: number };
    const shorten = (x: CopilotTransport): void => {
      Object.assign(x as unknown as Waits, { sendWaitMs: 1_000, acceptMs: 1_500, turnsGraceMs: 800, answerStillMs: 1_000 });
    };
    const BOX = '<div data-test-id="chat-input-wrapper"><span id="m365-chat-editor-target-element" contenteditable="true" style="display:inline-block;min-width:200px;min-height:20px"></span>';
    const SIDE = '<nav><a href="/chat/conversation/11111111-2222-3333-4444-555555555555" aria-label="Payroll secrets">Payroll secrets</a></nav>';
    const EXTRA = '<script>window.ran = 1;</script><style>.x{color:red}</style><div onclick="window.ran = 2" style="color:blue" id="keep-me">x</div>';
    const filesOf = async (f: Fixture, key: string): Promise<{ png?: string; html?: string }> => {
      const all = await readdir(f.failures).catch(() => [] as string[]);
      const png = all.find((x) => new RegExp(`^locator-${key}-\\d+\\.png$`).test(x));
      const html = all.find((x) => new RegExp(`^locator-${key}-\\d+\\.html$`).test(x));
      return { ...(png ? { png: join(f.failures, png) } : {}), ...(html ? { html: join(f.failures, html) } : {}) };
    };

    // Send: no button by its locator.
    const a = await fixture('loc-send', `${SIDE}${BOX}</div>${EXTRA}`);
    shorten(a.transport);
    const noSend = await rejection(a.transport.send('hello'));
    t.check('no Send: LocatorMissing for "send", said as stopping the work', [noSend?.name, (noSend as { key?: string } | null)?.key, named(a.events, 'locator-missing').map((e) => [e.detail?.key, e.detail?.stopped])], ['LocatorMissing', 'send', [['send', true]]]);
    t.truthy('its message: what it is, the locator in force, where Settings has it', /^Not found on Copilot's page: the button that sends the typed message.*The "send" locator found nothing after the message was written in the box, within 1 s\. In force: \[data-test-id="chat-input-wrapper"\] >> role=button\[name="Send"\] \(Settings → "The chat's locators"\)\./s.test(noSend?.message ?? ''), noSend?.message);
    const sendFiles = await filesOf(a, 'send');
    const page = sendFiles.html ? await readFile(sendFiles.html, 'utf8') : '';
    t.truthy('a picture and the HTML kept, and named in the message', !!sendFiles.png && !!sendFiles.html && (noSend?.message ?? '').includes(sendFiles.html), { sendFiles, message: noSend?.message });
    t.check('the HTML: the box and its wrapper kept; no script, no style, no handler, no conversation name', [page.includes('chat-input-wrapper'), page.includes('id="keep-me"'), /<script/i.test(page), /<style/i.test(page), /onclick/i.test(page), /style=/i.test(page), page.includes('Payroll secrets')], [true, true, false, false, false, false, false]);
    t.check('and the page itself untouched', await a.page.evaluate(() => [document.querySelectorAll('script').length > 0, !!document.querySelector('nav')]), [true, true]);

    // The same page with Send by Settings' own locator.
    const b = await fixture('loc-send-own', `${BOX}</div><button id="my-send" onclick="window.sent = (window.sent || 0) + 1">go</button>`, { chatLocators: { send: '#my-send' } });
    await b.transport.send('hello');
    t.check("Settings' own Send locator: used", await value<number>(b.page, 'sent'), 1);

    // Sent — the box emptied — and nothing of the conversation found: said, and not sent a second time.
    const c = await fixture('loc-turn', `${BOX}<button aria-label="Send" onclick="window.sends = (window.sends || 0) + 1; document.getElementById('m365-chat-editor-target-element').textContent = ''; document.body.insertAdjacentHTML('beforeend', '<div class=&quot;msg&quot;>hello</div>')">send</button></div>`);
    shorten(c.transport);
    const noTurn = await rejection(c.transport.sendAndConfirm('hello'));
    t.check('nothing of the conversation found after a send: LocatorMissing for "turn"', [noTurn?.name, (noTurn as { key?: string } | null)?.key], ['LocatorMissing', 'turn']);
    t.check('and the message was sent once, not again', await value<number>(c.page, 'sends'), 1);

    // The answer: begun, then standing still with no Copy anywhere.
    const d = await fixture('loc-copy', `${BOX}</div><div data-testid="m365-chat-llm-web-ui-chat-message">you</div><div data-testid="copilot-message-div">An answer, written and done.</div>`);
    shorten(d.transport);
    const noCopy = await rejection(d.transport.waitForReply(0));
    t.check('an answer standing still with no Copy anywhere: LocatorMissing for "copy", before the reply time', [noCopy?.name, (noCopy as { key?: string } | null)?.key], ['LocatorMissing', 'copy']);
    const e = await fixture('loc-answer', `${BOX}</div><div data-testid="m365-chat-llm-web-ui-chat-message">you</div><div class="reply">An answer the locator does not find.</div>`);
    shorten(e.transport);
    t.check('a turn begun and no answer found at all: LocatorMissing for "answer"', ((await rejection(e.transport.waitForReply(0))) as { key?: string } | null)?.key, 'answer');
    const g = await fixture('loc-turns-none', `${BOX}</div><div class="msg">you</div>`);
    shorten(g.transport);
    t.check('not one message of the conversation found while the answer is awaited: LocatorMissing for "turn"', ((await rejection(g.transport.waitForReply(0))) as { key?: string } | null)?.key, 'turn');
    // A Copy missing from the newest answer only is Copilot's, not the locator's: the wait goes on to the reply time.
    const h = await fixture('loc-copy-elsewhere', `${BOX}</div><div data-testid="m365-chat-llm-web-ui-chat-message">you</div><div data-testid="copilot-message-div">old <button data-testid="CopyButtonTestId" aria-label="Copy">c</button></div><div data-testid="m365-chat-llm-web-ui-chat-message">2</div><div data-testid="copilot-message-div">new, no copy yet</div>`, { replyTimeoutMs: 2_500 });
    shorten(h.transport);
    t.check('a Copy only the newest answer lacks: the reply time, not the locator', (await rejection(h.transport.waitForReply(1)))?.name, 'ReplyTimeoutError');

    // A conversation's name: the work goes on, and the locator is said once, as not stopping it; the sidebar is kept, names out.
    const k = await fixture('loc-rename', `${BOX}</div>${SIDE}`);
    shorten(k.transport);
    const named1 = await k.transport.nameChat('11111111-2222-3333-4444-555555555555', 'op/x/name', { waitMs: 1_000 });
    t.check('naming without its "More" button: not named, the work goes on', named1, false);
    const said = named(k.events, 'locator-missing');
    t.check('said once, as the "More" locator, not stopping the work', said.map((x) => [x.detail?.key, x.detail?.stopped]), [['chatMore', false]]);
    const sideHtml = said[0]?.detail?.html ? await readFile(String(said[0]!.detail!.html), 'utf8') : '';
    t.check("the sidebar kept for a sidebar locator, the conversation's name put out", [sideHtml.includes('/chat/conversation/11111111-2222-3333-4444-555555555555'), sideHtml.includes('Payroll secrets'), sideHtml.includes('chat title')], [true, false, true]);
    await k.transport.nameChat('11111111-2222-3333-4444-555555555555', 'op/x/name', { waitMs: 1_000 });
    t.check('a second try in the same window: not said again', named(k.events, 'locator-missing').length, 1);
  });

  // -------------------------------------------------------------------------------------------
  await section('an attached file: the work page\'s new card and the old chip both found, and one that is not said by its locator', async () => {
    /*
     * Work, 2026-11-17: a message over the length sent as text goes with its whole as message-01-in-full.txt. The page
     * took the file and showed it as a card ("message-01-in-full", "Text file"); the bot waited two minutes for the old
     * `div.fx-Attachment[aria-label="message-01-in-full.txt"]`, written in the code, and the message ended with
     * Playwright's own words, colours and all. The three are locators in Settings now (uploadInput, attachment,
     * attachmentUploaded), their defaults find both looks, and one that finds nothing is said like the others.
     */
    type Waits = { inputWaitMs: number; attachWaitMs: number; uploadWaitMs: number };
    const shorten = (x: CopilotTransport, w: Partial<Waits> = {}): void => {
      Object.assign(x as unknown as Waits, { inputWaitMs: 500, attachWaitMs: 1_000, uploadWaitMs: 4_000, ...w });
    };
    const dir = await mkdtemp(join(base, 'attach-file-'));
    const file = join(dir, 'message-01-in-full.txt');
    await writeFile(file, 'the whole message', 'utf8');
    const WRAP = '<div data-test-id="chat-input-wrapper"><span role="textbox" contenteditable="true" data-lexical-editor="true" style="display:inline-block;min-width:200px;min-height:20px"></span>';
    const INPUT = '<input type="file" id="upload-file-button" multiple style="display:none">';
    const onPick = (body: string): string =>
      `<script>document.getElementById('upload-file-button').addEventListener('change', (ev) => { const f = ev.target.files[0]; const wrap = document.querySelector('[data-test-id="chat-input-wrapper"]'); ${body} });</script>`;

    // The new card (2026-11-17): the name without its extension, "Text file", a spinner while it uploads.
    const NEW_CARD =
      "const stem = f.name.replace(/\\.[^.]*$/, ''); wrap.insertAdjacentHTML('afterbegin', '<div class=\"card\"><span class=\"nm\">' + stem + '</span><span>Text file</span><div role=\"progressbar\" id=\"spin\"></div></div>');";
    const a = await fixture('attach-new', `${WRAP}${INPUT}</div>${onPick(`${NEW_CARD} setTimeout(() => document.getElementById('spin').remove(), 1200);`)}`);
    shorten(a.transport);
    const startedA = Date.now();
    await a.transport.attach([file]);
    t.check('the new card: attached, nothing said missing', [named(a.events, 'attached').map((e) => e.detail?.name), named(a.events, 'locator-missing').length, named(a.events, 'attachment-upload-unconfirmed').length], [['message-01-in-full.txt'], 0, 0]);
    t.truthy('and only once its spinner had gone', (await a.page.evaluate(() => document.getElementById('spin') === null)) && Date.now() - startedA >= 1_200, Date.now() - startedA);

    // The old chip: the name in its label, its id SPO_… once uploaded.
    const OLD_CHIP =
      "wrap.insertAdjacentHTML('afterbegin', '<div class=\"fx-AttachmentList\"><div class=\"fx-Attachment\" id=\"tmp-1\" aria-label=\"' + f.name + '\">' + f.name + '</div></div>'); setTimeout(() => { document.getElementById('tmp-1').id = 'SPO_abc'; }, 900);";
    const b = await fixture('attach-old', `${WRAP}${INPUT}</div>${onPick(OLD_CHIP)}`);
    shorten(b.transport);
    await b.transport.attach([file]);
    t.check('the old chip: attached once its id says uploaded', [named(b.events, 'attached').length, named(b.events, 'locator-missing').length, await b.page.evaluate(() => !!document.getElementById('SPO_abc'))], [1, 0, true]);

    // The page takes the file and shows nothing the locator finds: said by its name, the work stopped, the HTML kept.
    const c = await fixture('attach-none', `${WRAP}${INPUT}</div>${onPick("wrap.insertAdjacentHTML('afterbegin', '<div class=\"other\">a picture of a file</div>');")}`);
    shorten(c.transport);
    const none = await rejection(c.transport.attach([file]));
    const saidC = named(c.events, 'locator-missing');
    t.check('nothing found: LocatorMissing for "attachment", said as stopping the work', [none?.name, (none as { key?: string } | null)?.key, saidC.map((e) => [e.detail?.key, e.detail?.stopped, e.detail?.locator])], ['LocatorMissing', 'attachment', [['attachment', true, DefaultChatLocators.attachment]]]);
    t.truthy('its message names the locator and Settings, in plain words (no terminal colours)', /^Not found on Copilot's page: the file attached to the message.*The "attachment" locator found nothing after the file message-01-in-full\.txt was put in the box's file input, within 1 s\..*Settings → "The chat's locators"/s.test(none?.message ?? '') && !(none?.message ?? '').includes(String.fromCharCode(27)), none?.message);
    t.truthy('the HTML kept, with the box and what the page showed', !!saidC[0]?.detail?.html && (await readFile(String(saidC[0]!.detail!.html), 'utf8')).includes('a picture of a file'), saidC[0]?.detail);

    // No file input: said as uploadInput.
    const d = await fixture('attach-noinput', `${WRAP}</div>`);
    shorten(d.transport);
    const noInput = await rejection(d.transport.attach([file]));
    t.check('no file input: LocatorMissing for "uploadInput"', [noInput?.name, (noInput as { key?: string } | null)?.key], ['LocatorMissing', 'uploadInput']);

    // Shown, never uploaded: the message goes on, as before, and the locator is said once, not stopping the work.
    const e = await fixture('attach-spinning', `${WRAP}${INPUT}</div>${onPick(NEW_CARD)}`);
    shorten(e.transport, { uploadWaitMs: 1_500 });
    await e.transport.attach([file]);
    t.check('a spinner that never goes: attached, unconfirmed, "attachmentUploaded" said not stopping', [named(e.events, 'attached').length, named(e.events, 'attachment-upload-unconfirmed').length, named(e.events, 'locator-missing').map((x) => [x.detail?.key, x.detail?.stopped])], [1, 1, [['attachmentUploaded', false]]]);

    // Settings' own, by the name without its extension.
    const f = await fixture(
      'attach-own',
      `${WRAP}${INPUT}</div>${onPick("const stem = f.name.replace(/\\.[^.]*$/, ''); wrap.insertAdjacentHTML('afterbegin', '<div data-file=\"' + stem + '\" data-done=\"1\">x</div>');")}`,
      { chatLocators: { attachment: '[data-file="{$file_stem}"]', attachmentUploaded: '[data-file="{$file_stem}"][data-done="1"]' } },
    );
    shorten(f.transport);
    await f.transport.attach([file]);
    t.check("Settings' own locators, with {$file_stem}: used", [named(f.events, 'attached').length, named(f.events, 'locator-missing').length], [1, 0]);
  });

  // -------------------------------------------------------------------------------------------
  await section('the steps on the way to the chat: the bot\'s own switched off, the operator\'s own taken, one required and missing said', async () => {
    /*
     * Operator, 2026-11-17: "what happens if we want to add or remove a step? Some steps will drop out in future and new
     * ones will appear to reach the chat". Settings → "Steps to the chat": the bot's own that can be done without, each
     * switched off; and the operator's own, "if this is on the page, do this", when the chat opens or before each
     * message. One that must be there and is not stops the work like a locator that found nothing, said by its name.
     */
    type Steps = { runSteps(when: 'open' | 'message'): Promise<void> };
    const steps = (x: CopilotTransport): Steps => x as unknown as Steps;
    const BOX = '<div data-test-id="chat-input-wrapper"><span id="m365-chat-editor-target-element" contenteditable="true" style="display:inline-block;min-width:200px;min-height:20px"></span>' +
      '<button aria-label="Send" onclick="window.sent = (window.sent || 0) + 1">send</button></div>';
    const MODE = '<button id="mode-chat" aria-pressed="false" onclick="this.setAttribute(\'aria-pressed\', \'true\'); window.modeClicks = (window.modeClicks || 0) + 1">Chat</button>';
    const ESC = '<div id="banner">Uploads go to OneDrive</div><script>document.addEventListener(\'keydown\', (e) => { if (e.key === \'Escape\') window.escapes = (window.escapes || 0) + 1; });</script>';
    const step = (s: Partial<ChatStep> & { id: string }): ChatStep => ({ name: s.id, when: 'message', locator: '#none', action: 'click', waitSec: 0, ...s });

    // Click: the mode toggle, only while it is not chosen; pressed through `send`, before the message is written.
    const a = await fixture('steps-click', `${MODE}${BOX}`, { extraSteps: [step({ id: 'mode', name: 'Chat mode', locator: '#mode-chat[aria-pressed="false"]' })] });
    await a.transport.send('hello');
    await a.transport.send('again');
    t.check('a click step: clicked before the first message, not again once the toggle is chosen', [await value<number>(a.page, 'modeClicks'), await value<number>(a.page, 'sent')], [1, 2]);
    t.check('said each time: clicked, then not there', named(a.events, 'chat-step').map((e) => e.detail?.did), ['clicked', 'not-there']);

    // Press a key while the banner is there; wait for one to show; wait for a spinner to go.
    const b = await fixture(
      'steps-keys',
      `${ESC}${BOX}<div id="spin">loading</div><script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<div id=\\'late\\'>ready</div>'), 300); setTimeout(() => document.getElementById('spin').remove(), 500);</script>`,
      {
        extraSteps: [
          step({ id: 'esc', locator: '#banner', action: 'press', key: 'Escape' }),
          step({ id: 'late', locator: '#late', action: 'appear', waitSec: 3 }),
          step({ id: 'spin', locator: '#spin', action: 'gone', waitSec: 3 }),
        ],
      },
    );
    await steps(b.transport).runSteps('message');
    t.check('press, appear, gone: each done, in their order', [await value<number>(b.page, 'escapes'), named(b.events, 'chat-step').map((e) => [e.detail?.id, e.detail?.did])], [1, [['esc', 'pressed'], ['late', 'appeared'], ['spin', 'gone']]]);
    t.check('the "open" steps are not taken before a message', named(b.events, 'chat-step').every((e) => e.detail?.when === 'message'), true);

    // Required and not there: the work stops, said by the step's name, with the page kept; one not required is passed over.
    const c = await fixture('steps-must', `${BOX}<p id="keep">the page</p>`, {
      extraSteps: [step({ id: 'opt', name: 'Optional banner', locator: '#banner' }), step({ id: 'need', name: 'Chat mode', locator: '#mode-chat', must: true, waitSec: 1 })],
    });
    const missing = await rejection(steps(c.transport).runSteps('message'));
    const said = named(c.events, 'locator-missing');
    t.check('required and missing: LocatorMissing for "step:need", said with its name, stopping the work', [missing?.name, (missing as { key?: string } | null)?.key, said.map((e) => [e.detail?.key, e.detail?.name, e.detail?.stopped])], ['LocatorMissing', 'step:need', [['step:need', 'Chat mode', true]]]);
    t.truthy('its message: the step by name, its locator, where Settings has it', /^Your step "Chat mode" must be there, and before a message its locator found nothing within 1 s\. In force: #mode-chat \(Settings → "Steps to the chat"/.test(missing?.message ?? ''), missing?.message);
    t.truthy("the page's HTML kept for a chatbot", !!said[0]?.detail?.html && (await readFile(String(said[0]!.detail!.html), 'utf8')).includes('id="keep"'), said[0]?.detail);
    t.check('the one not required: passed over first', named(c.events, 'chat-step').map((e) => [e.detail?.id, e.detail?.did]), [['opt', 'not-there']]);

    // Switched off, or one that cannot be taken: not taken; the latter said once.
    const d = await fixture('steps-off', `${MODE}${BOX}`, {
      extraSteps: [step({ id: 'off', locator: '#mode-chat', off: true }), step({ id: 'badkey', locator: '#mode-chat', action: 'press', key: 'Hyper' }), step({ id: 'empty', locator: '  ' })],
    });
    await steps(d.transport).runSteps('message');
    await steps(d.transport).runSteps('message');
    t.check('off: kept, not taken; a bad key and an empty locator: not taken, each said once', [await value<number>(d.page, 'modeClicks'), named(d.events, 'chat-step').length, named(d.events, 'chat-step-not-used').map((e) => /step (2|3) /.test(String(e.detail?.problem)))], [undefined, 0, [true, true]]);

    // The bot's own: the first-run dialogs left alone when switched off; closed (declined) when on.
    const POPUP = '<div role="dialog"><button onclick="window.gotIt = (window.gotIt || 0) + 1">Got it</button></div>';
    const e1 = await fixture('steps-popups-off', `${POPUP}${BOX}`, { builtInSteps: { popups: false } });
    await e1.transport.dismissPopups();
    const e2 = await fixture('steps-popups-on', `${POPUP}${BOX}`);
    await e2.transport.dismissPopups();
    t.check('first-run dialogs: left when switched off, closed when on (the default)', [await value<number>(e1.page, 'gotIt'), await value<number>(e2.page, 'gotIt')], [undefined, 1]);
    const f = await fixture('steps-name-off', `${BOX}<nav><a href="/chat/conversation/abc">x</a></nav>`, { builtInSteps: { nameChat: false } });
    const named1 = await f.transport.nameChat('abc', 'op/x/name', { waitMs: 500 });
    await f.transport.nameChat('abc', 'op/x/name', { waitMs: 500 });
    t.check('naming switched off: not named, said once, nothing looked for', [named1, named(f.events, 'chat-name-off').length, named(f.events, 'chat-name-failed').length, named(f.events, 'locator-missing').length], [false, 1, 0, 0]);

    // Settings saved while the window is open: its locators and steps taken at once (the chat's window is kept open).
    const g = await fixture('steps-take', `${MODE}<div data-test-id="chat-input-wrapper"><span id="m365-chat-editor-target-element" contenteditable="true" style="display:inline-block;min-width:200px;min-height:20px"></span><button id="go" onclick="window.sent = (window.sent || 0) + 1">go</button></div>`, { chatLocators: { send: '#nowhere' } });
    Object.assign(g.transport as unknown as { sendWaitMs: number }, { sendWaitMs: 500 });
    const before = await rejection(g.transport.send('one'));
    g.transport.takeSettings({ chatLocators: { send: '#go' }, extraSteps: [step({ id: 'mode', locator: '#mode-chat[aria-pressed="false"]' })] });
    await g.transport.send('two');
    t.check("a window open takes Settings' locators and steps: Send found by the new one, the new step taken", [(before as { key?: string } | null)?.key, await value<number>(g.page, 'sent'), await value<number>(g.page, 'modeClicks')], ['send', 1, 1]);

    // When the chat opens: taken after the chat is reached, as the work machine's start reaches it.
    const HOME = 'https://m365.cloud.microsoft/chat?es=SSR';
    const h = await fixture('steps-open', '<p>blank</p>', { signInTimeoutMs: 2_000, extraSteps: [step({ id: 'welcome', when: 'open', locator: '#welcome-close', waitSec: 2 }), step({ id: 'msg', locator: '#welcome-close' })] });
    Object.assign(h.transport as unknown as { firstLookMs: number; settleMs: number }, { firstLookMs: 4_000, settleMs: 300 });
    await h.page.route(/^https:\/\/m365\.cloud\.microsoft\//, async (route) => {
      if (route.request().resourceType() !== 'document') return await route.fulfill({ status: 204, body: '' });
      return await route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta charset="utf-8">${BOX}<button id="welcome-close" onclick="window.welcomed = (window.welcomed || 0) + 1; this.remove()">OK, thanks</button>`,
      });
    });
    await h.transport.ensureSignedIn(HOME);
    t.check('a step for when the chat opens: taken once the chat is reached; the message one not', [await value<number>(h.page, 'welcomed'), named(h.events, 'chat-step').map((e) => [e.detail?.id, e.detail?.did])], [1, [['welcome', 'clicked']]]);
  });

  // -------------------------------------------------------------------------------------------
  await section('"Check the locators": each looked for in the chat, the newest conversation and its menu, only read', async () => {
    /*
     * Operator, 2026-11-17: "make the 'Check the locators' button too". Served by the page's routes as Copilot has it: a
     * new chat whose Send shows only once the box holds text, a sidebar with two conversations, the newest one's page
     * with its messages, answer and Copy, and its "More" button opening a menu with "Rename". The check reads and looks:
     * the letter typed for Send is taken out again, nothing is sent, the menu is closed again, the dialog never opened.
     */
    const A = '66666666-7777-8888-9999-aaaaaaaaaaaa';
    const B = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
    const HOME = 'https://m365.cloud.microsoft/chat?es=SSR';
    const state = { conversations: true };
    const side = (): string => (state.conversations ? `<nav><a href="/chat/conversation/${A}" aria-label="newest">newest</a><a href="/chat/conversation/${B}" aria-label="older">older</a></nav>` : '<nav></nav>');
    const chat = (): string =>
      `<script>window.sends = 0;</script>${side()}<div data-test-id="chat-input-wrapper"><span id="m365-chat-editor-target-element" contenteditable="true" style="display:inline-block;min-width:200px;min-height:20px"></span>` +
      `<button aria-label="Send" hidden onclick="window.sends += 1">send</button><input type="file" id="upload-file-button" multiple style="display:none"></div>` +
      `<script>const box = document.getElementById('m365-chat-editor-target-element'); box.addEventListener('input', () => { document.querySelector('[aria-label=Send]').hidden = !box.textContent.trim(); });</script>`;
    const conversation = (): string =>
      `${chat()}<div data-testid="m365-chat-llm-web-ui-chat-message"><div id="user-message-1">hello</div></div><div data-testid="m365-chat-llm-web-ui-chat-message"><div data-testid="copilot-message-div">hi <button data-testid="CopyButtonTestId" aria-label="Copy">c</button></div></div>` +
      `<button data-chat-history-more-button-conversation-id="${A}" aria-label="More" onclick="document.body.insertAdjacentHTML('beforeend', '<div role=&quot;menu&quot;><div role=&quot;menuitem&quot;>Rename</div></div>')">…</button>` +
      `<script>document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelector('[role=menu]')?.remove(); });</script>`;
    const open = async (name: string, chatLocators?: Record<string, string>): Promise<Fixture> => {
      const f = await fixture(name, '<p>blank</p>', { signInTimeoutMs: 2_000, ...(chatLocators ? { chatLocators } : {}) });
      Object.assign(f.transport as unknown as { firstLookMs: number; settleMs: number }, { firstLookMs: 4_000, settleMs: 300 });
      await f.page.route(/^https:\/\/m365\.cloud\.microsoft\//, async (route) => {
        if (route.request().resourceType() !== 'document') return await route.fulfill({ status: 204, body: '' });
        const id = parseChatId(route.request().url());
        return await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8">${id ? conversation() : chat()}` });
      });
      await f.transport.ensureSignedIn(HOME);
      return f;
    };
    const table = (rs: Array<{ key: string; status: string; count: number; note?: string }>): string[] => rs.map((r) => `${r.key}:${r.status}${r.count ? `:${r.count}` : ''}${r.note ? `:${r.note}` : ''}`);

    const a = await open('check-all');
    const found = await a.transport.checkLocators();
    t.check('each looked for: found where it is, the rest said as not on the page then, and why', table(found), [
      'composer:found:1', 'send:found:1', 'userMessage:found:1', 'turn:found:2', 'answer:found:1', 'copy:found:1', 'stop:not-here:writing',
      'conversationLink:found:2', 'chatMore:found:1', 'renameItem:found:1', 'renameInput:not-here:dialog', 'renameSave:not-here:dialog',
      // The box's file input is there (hidden); an attached file shows only once one is, and the check attaches none.
      'uploadInput:found:1', 'attachment:not-here:attach', 'attachmentUploaded:not-here:attach',
    ]);
    t.check('only read: nothing sent, the letter for Send taken out, the menu closed, on the newest conversation', [await value<number>(a.page, 'sends'), await a.page.locator('#m365-chat-editor-target-element').innerText(), await a.page.locator('[role=menu]').count(), parseChatId(a.page.url())], [0, '', 0, A]);
    t.check('nothing said as missing', named(a.events, 'locator-missing').length, 0);

    // One set in Settings that finds nothing: said, as a failure the work went on without, its HTML kept.
    const b = await open('check-bad', { copy: '[data-testid="NoSuchCopy"]' });
    const bad = await b.transport.checkLocators();
    t.check("Settings' own Copy finding nothing: not found, and said", [table(bad).find((x) => x.startsWith('copy:')), named(b.events, 'locator-missing').map((e) => [e.detail?.key, e.detail?.stopped, !!e.detail?.html])], ['copy:none', [['copy', false, true]]]);

    // No conversation in the sidebar: what only a conversation holds is not looked for, and said so.
    state.conversations = false;
    const c = await open('check-empty');
    const empty = await c.transport.checkLocators();
    t.check('no conversation: the sidebar\'s link not found; the answer\'s and the menu\'s not on the page then', table(empty).filter((x) => /^(conversationLink|turn|userMessage|answer|copy|chatMore|renameItem):/.test(x)), [
      'userMessage:not-here:noConversation', 'turn:not-here:noConversation', 'answer:not-here:noConversation', 'copy:not-here:noConversation',
      'conversationLink:none', 'chatMore:not-here:noConversation', 'renameItem:not-here:noConversation',
    ]);
    state.conversations = true;
  });

  // -------------------------------------------------------------------------------------------
  await section('copyLastReply goes through the clipboard guard', async () => {
    /*
     * The reply is the markdown the page tries to copy, caught by CLIPBOARD_GUARD before it reaches
     * the machine's clipboard. The guard's counter is what makes a stale read impossible, so its
     * arithmetic is pinned: an empty write is not a copy, and one copy is exactly one step. The
     * guard also wraps document.execCommand, and must not break the commands it does not own.
     */
    const COPY = `${COUNT}
      <div data-testid="copilot-message-div" id="older">an older answer <button data-testid="CopyButtonTestId" aria-label="Copy Response" data-count="older copy">copy</button></div>
      <div data-testid="copilot-message-div" id="last"><div>status: done</div><span id="tools"><button data-testid="CopyButtonTestId" aria-label="Copy Response" data-count="copy">copy</button></span></div>
      <div id="editor" contenteditable="true">make me bold</div>
      <script>
        window.copyMode = 'write';
        document.getElementById('older').dataset.md = 'the older answer';
        document.getElementById('last').dataset.md = __MD__;
        document.addEventListener('click', (e) => {
          const b = e.target instanceof Element ? e.target.closest('[data-testid="CopyButtonTestId"]') : null;
          if (!b || window.copyMode !== 'write') return;
          navigator.clipboard.writeText(b.closest('[data-testid="copilot-message-div"]').dataset.md);
        });
        window.relabel = () => { document.getElementById('tools').innerHTML = '<button data-testid="CopyButtonTestId" aria-label="Like" data-count="Like">like</button>'; };
      </script>`.replace('__MD__', () => JSON.stringify(MD));
    const f = await fixture('copy', COPY);
    const seq = async (): Promise<number> => await f.page.evaluate(() => window.__copClipboard?.seq ?? -1);

    const steps = await f.page.evaluate(async () => {
      const c = window.__copClipboard;
      if (!c) return null;
      const s0 = c.seq;
      await navigator.clipboard.writeText('');
      const s1 = c.seq;
      await navigator.clipboard.writeText('a');
      const s2 = c.seq;
      await navigator.clipboard.writeText('b');
      return { empty: s1 - s0, each: [s2 - s1, c.seq - s2], text: c.text };
    });
    t.check('the guard is on the page; writeText(\'\') leaves seq unchanged; each write is +1', steps, { empty: 0, each: [1, 1], text: 'b' });

    const s0 = await seq();
    const first = await internals(f.transport).copyLastReply();
    const s1 = await seq();
    t.check('the last answer\'s markdown, fence included, not degraded', [first.markdown, first.markdown.includes('```json'), first.degraded], [MD, true, false]);
    const second = await internals(f.transport).copyLastReply();
    t.check('each copy moves the counter by exactly one', [s1 - s0, (await seq()) - s1, second.markdown], [1, 1, MD]);
    t.check('only the last answer\'s copy button was pressed', [(await clicks(f.page))['copy'] ?? 0, (await clicks(f.page))['older copy'] ?? 0], [2, 0]);

    const exec = await f.page.evaluate(() => {
      const ed = document.getElementById('editor') as HTMLElement;
      ed.focus();
      const range = document.createRange();
      range.selectNodeContents(ed);
      const sel = window.getSelection() as Selection;
      sel.removeAllRanges();
      sel.addRange(range);
      const bold = document.execCommand('bold');
      const bolded = ed.querySelector('b, strong') !== null || /font-weight/.test(ed.innerHTML);
      const before = window.__copClipboard?.seq ?? -1;
      const copied = document.execCommand('copy');
      return { bold, bolded, copied, step: (window.__copClipboard?.seq ?? -1) - before, text: window.__copClipboard?.text };
    });
    t.check('execCommand(\'bold\') still does the real thing and says so', [exec.bold, exec.bolded], [true, true]);
    t.check('execCommand(\'copy\') of a selection is caught by the guard, one step', [exec.copied, exec.step, exec.text], [true, 1, 'make me bold']);

    /*
     * A press of "copy" that copies nothing: the counter does not move, and after the copy wait
     * the read degrades to the DOM text instead of serving what was copied before. The copy wait
     * is a fixed 15 s; for this one read it is cut to 1.5 s on the page object the transport holds
     * (its waitForFunction), which changes how long it waits and nothing about what it decides.
     */
    await f.page.evaluate(() => { (window as unknown as { copyMode: string }).copyMode = 'nothing'; });
    type WaitForFunction = (fn: unknown, arg: unknown, options?: { timeout?: number }) => Promise<unknown>;
    const pageWaits = f.page as unknown as { waitForFunction: WaitForFunction };
    const realWaitForFunction = pageWaits.waitForFunction.bind(f.page) as WaitForFunction;
    const askedCopyWaits: Array<number | undefined> = [];
    pageWaits.waitForFunction = async (fn, arg, options) => {
      askedCopyWaits.push(options?.timeout);
      return await realWaitForFunction(fn, arg, { ...options, timeout: 1_500 });
    };
    let nothing: { markdown: string; degraded: boolean };
    try {
      nothing = await internals(f.transport).copyLastReply();
    } finally {
      Reflect.deleteProperty(f.page, 'waitForFunction');
    }
    t.check('(the copy wait was shortened: one wait)', askedCopyWaits.length, 1);
    t.check('a copy that copied nothing degrades to the page text, never the previous capture', [nothing.degraded, nothing.markdown.includes('status: done'), nothing.markdown === MD, nothing.markdown === 'make me bold'], [true, true, false, false]);

    await pageCall(f.page, 'relabel');
    f.events.length = 0;
    const moved = await internals(f.transport).copyLastReply();
    t.check('the copy test id on a "Like" button: degraded, and Like has 0 clicks', [moved.degraded, (await clicks(f.page))['Like'] ?? 0], [true, 0]);
    t.check('and the move is reported', named(f.events, 'copy-button-moved').map((e) => e.detail?.label), ['like']);
  });

  // -------------------------------------------------------------------------------------------
  await section('conversation size is what the app says, not what it rendered', async () => {
    /*
     * Copilot virtualises a long chat: a 48-message conversation rendered four turn elements, each
     * carrying aria-setsize="48". Counting elements there calls every new message "not accepted"
     * and every reply "not started". Two places count — turnCount (acceptance, via turnCountNow)
     * and the reply wait's own copy of the same code — and the size can sit in three places. Each
     * place is checked through both: turnCountNow directly, and a reply that arrives while the
     * window slides (48 -> 49, still 4 rendered). The reply wait is handed 48 itself, not what
     * turnCountNow said, so a mistake in its copy cannot be hidden by the same mistake in the other:
     * reading 4 there, it never sees the reply and times out.
     */
    const plain = await fixture('size-plain', REPLY(4));
    t.check('no aria-setsize anywhere: the rendered count, 4', await plain.transport.turnCountNow(), 4);

    const where: Record<Carrier, string> = {
      turn: 'the turn element',
      inner: 'an element inside the turn',
      outer: 'a wrapper around the turn',
    };
    for (const carrier of ['turn', 'inner', 'outer'] as const) {
      const f = await fixture(`size-${carrier}`, REPLY(4, { setsize: 48, carrier }), { replyTimeoutMs: 20_000 });
      t.check(`aria-setsize=48 on ${where[carrier]}, 4 rendered: turnCountNow() is 48`, await f.transport.turnCountNow(), 48);
      await pageCall(f.page, 'startReply', false);
      const reply = await f.transport.waitForReply(48).then(
        (r) => ({ markdown: r.markdown, degraded: r.degraded }),
        (e: Error) => ({ markdown: `rejected: ${e.message.slice(0, 160)}`, degraded: true }),
      );
      const rendered = await f.page.locator('[data-testid="m365-chat-llm-web-ui-chat-message"]').count();
      t.check(`  and the reply wait sees 48 -> 49 there (still 4 rendered), and reads the reply`, [rendered, reply.markdown, reply.degraded], [4, MD, false]);
    }
  });

  // -------------------------------------------------------------------------------------------
  await section('dumpFailure respects privacy and names crashes', async () => {
    /*
     * With the page gone there is nothing to picture, and "the page was closed" reads the same for
     * a closed window, a second Edge on the profile and a crash. Only a crash leaves a minidump in
     * the profile, so when one is fresh the note says Edge's browser process crashed.
     */
    const profile = await mkdtemp(join(base, 'profile-crash-'));
    await mkdir(join(profile, 'Crashpad', 'reports'), { recursive: true });
    await writeFile(join(profile, 'Crashpad', 'reports', 'x.dmp'), 'minidump');
    await writeFile(join(profile, 'Crashpad', 'watson_metadata'), 'ApplicationName=msedge.exe;ApplicationVersion=153.0.4234.32;ProcessType=browser;SubCode=0x80000003;', 'latin1');
    const events: Seen[] = [];
    const gone = transportFor(await mkdtemp(join(base, 'gone-')), { profileDir: profile }, events);
    const crashDir = join(base, 'dumps-crash');
    await gone.dumpFailure(crashDir, 't');
    const note = await readFile(join(crashDir, 't.txt'), 'utf8').catch(() => '(no t.txt)');
    t.truthy('page null, fresh crash report: t.txt says Edge\'s browser process crashed', note.includes("Edge's browser process crashed"), note);
    t.check('nothing pretends to be a picture of it', [existsSync(join(crashDir, 't.png')), existsSync(join(crashDir, 't.html'))], [false, false]);
    t.check('and the crash is an event', named(events, 'browser-crashed').length, 1);

    // A closed page is the same as no page.
    const closed = await theBrowser().newPage();
    await closed.close();
    internals(gone).page = closed;
    const closedDir = join(base, 'dumps-closed');
    await gone.dumpFailure(closedDir, 't');
    t.truthy('a closed page with a fresh report: named as the crash too', (await readFile(join(closedDir, 't.txt'), 'utf8').catch(() => '')).includes("Edge's browser process crashed"));

    const clean = await mkdtemp(join(base, 'profile-clean-'));
    const cleanEvents: Seen[] = [];
    const noCrash = transportFor(await mkdtemp(join(base, 'gone-clean-')), { profileDir: clean }, cleanEvents);
    const cleanDir = join(base, 'dumps-clean');
    await noCrash.dumpFailure(cleanDir, 't');
    const plain = await readFile(join(cleanDir, 't.txt'), 'utf8').catch(() => '(no t.txt)');
    t.truthy('no report: the note says so, and does not claim a crash', plain.includes('No Edge crash report') && !plain.includes('crashed'), plain);
    t.check('and the empty dump is an event', named(cleanEvents, 'failure-dump-empty').length, 1);

    // The page's HTML carries the account's other chat titles and its sign-in state: written only
    // when the operator asked for it. The screenshot and the URL always are.
    const PAGE = '<nav><a href="/chat/conversation/1" aria-label="Q3 salary review">Q3 salary review</a></nav><p>the chat</p>';
    const f = await fixture('dump', PAGE, { keepFailurePage: false });
    const plainDir = join(base, 'dumps-page');
    await f.transport.dumpFailure(plainDir, 't');
    t.check('keepFailurePage false: t.png and t.url.txt, no t.html', [existsSync(join(plainDir, 't.png')), existsSync(join(plainDir, 't.url.txt')), existsSync(join(plainDir, 't.html'))], [true, true, false]);
    t.check('  t.url.txt holds the page\'s address', await readFile(join(plainDir, 't.url.txt'), 'utf8').catch(() => ''), blank);
    const g = await fixture('dump-keep', PAGE, { keepFailurePage: true });
    const keepDir = join(base, 'dumps-keep');
    await g.transport.dumpFailure(keepDir, 't');
    t.check('keepFailurePage true: t.html too, with the page in it', (await readFile(join(keepDir, 't.html'), 'utf8').catch(() => '')).includes('Q3 salary review'), true);
  });

  // -------------------------------------------------------------------------------------------
  await section('the profile lock', async () => {
    /*
     * Chromium profiles are single-writer: a second launch on a profile in use hands itself to the
     * running browser and exits, and Playwright reports "Target page, context or browser has been
     * closed". The lock turns that into a sentence. A lock whose process is gone — a crashed run —
     * must not leave the profile unusable, and neither must an unreadable one.
     */
    const lockOf = (dir: string): string => join(dir, '.cop-lock.json');
    const holder = (dir: string): unknown => {
      try {
        return (JSON.parse(readFileSync(lockOf(dir), 'utf8')) as { pid?: unknown }).pid;
      } catch {
        return existsSync(lockOf(dir)) ? 'unreadable' : 'none';
      }
    };
    const take = (dir: string): { handle: { release: () => void } | null; error: string } => {
      try {
        return { handle: acquireProfileLock(dir), error: '' };
      } catch (e) {
        return { handle: null, error: (e as Error).message };
      }
    };

    // A pid that is certainly gone: a child that has already exited. (999999 is not safe on Windows,
    // which ignores the two low bits of a pid, so it can alias a live 999996.)
    const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
    const stale = await mkdtemp(join(base, 'lock-stale-'));
    writeFileSync(lockOf(stale), JSON.stringify({ pid: dead, startedAt: '2026-09-01T00:00:00.000Z' }), 'utf8');
    const a = take(stale);
    t.check('a lock left by a process that is gone is taken over; the file now holds this pid', [a.error, holder(stale)], ['', process.pid]);
    a.handle?.release();
    t.check('release() removes the file', existsSync(lockOf(stale)), false);

    const live = await mkdtemp(join(base, 'lock-live-'));
    writeFileSync(lockOf(live), JSON.stringify({ pid: process.ppid, startedAt: '2026-09-30T00:00:00.000Z' }), 'utf8');
    const b = take(live);
    t.truthy('a lock held by a live process is refused: "already in use by copilot-operator"', /already in use by copilot-operator/.test(b.error), b.error || 'it was taken');
    t.check('and that run\'s lock is left as it was', holder(live), process.ppid);
    b.handle?.release();

    const garbage = await mkdtemp(join(base, 'lock-garbage-'));
    writeFileSync(lockOf(garbage), 'garbage', 'utf8');
    const c = take(garbage);
    t.check('an unreadable lock file is taken over', [c.error, holder(garbage)], ['', process.pid]);
    c.handle?.release();

    // A profile path with a quote in it is interpolated into the PowerShell query; it must still be
    // a query, answering "nobody", rather than a broken script answering "unknown". (Real PowerShell.)
    const quoted = await mkdtemp(join(base, "lock-it's-"));
    t.check('a profile path with an apostrophe: the Edge query still answers []', findEdgeUsingProfile(quoted), []);

    /*
     * What the Edge query makes of what PowerShell prints. ConvertTo-Json prints one process as an
     * object and several as an array, a process whose command line it cannot read with
     * "CommandLine": null, and nothing at all when there is no match. A slip here either ignores a
     * live Edge — and the launch dies on "has been closed" — or crashes on one. PowerShell is not
     * run for these: spawnSync answers with the text (see withEdgeQueryAnswering).
     */
    const parseProfile = await mkdtemp(join(base, 'lock-parse-'));
    const one = withEdgeQueryAnswering({ status: 0, stdout: '{"ProcessId":5,"CommandLine":null}\r\n' }, () => findEdgeUsingProfile(parseProfile));
    t.check('(the query went to powershell, and named this profile)', [one.calls.length, one.calls[0]?.[0], one.calls[0]?.at(-1)?.includes(parseProfile) ?? false], [1, 'powershell', true]);
    t.check('one process, CommandLine null: [{pid:5, commandLine:""}]', one.value, [{ pid: 5, commandLine: '' }]);
    const two = withEdgeQueryAnswering(
      { status: 0, stdout: '[{"ProcessId":5,"CommandLine":"msedge.exe --user-data-dir=P"},{"ProcessId":6,"CommandLine":"msedge.exe --type=renderer"}]' },
      () => findEdgeUsingProfile(parseProfile),
    );
    t.check('an array of two: both, in order', two.value, [{ pid: 5, commandLine: 'msedge.exe --user-data-dir=P' }, { pid: 6, commandLine: 'msedge.exe --type=renderer' }]);
    t.check('nothing printed: [] (nobody has the profile)', withEdgeQueryAnswering({ status: 0, stdout: '' }, () => findEdgeUsingProfile(parseProfile)).value, []);
    t.check('output that is not JSON: "unknown", never []', withEdgeQueryAnswering({ status: 0, stdout: 'not json' }, () => findEdgeUsingProfile(parseProfile)).value, 'unknown');
    t.check('powershell failing (exit 1): "unknown", never []', withEdgeQueryAnswering({ status: 1, stdout: '' }, () => findEdgeUsingProfile(parseProfile)).value, 'unknown');

    // And the lock acts on it: a live Edge on the profile is refused by pid, whether it came as one
    // object or an array, and no lock file is left claiming a profile this run could not have.
    const edgeOne = await mkdtemp(join(base, 'lock-edge-one-'));
    const refusedOne = withEdgeQueryAnswering({ status: 0, stdout: '{"ProcessId":5,"CommandLine":null}' }, () => take(edgeOne)).value;
    t.truthy('one Edge process on the profile: refused, naming process 5', /Microsoft Edge is already running with this profile \(process 5\)/.test(refusedOne.error), refusedOne.error || 'it was taken');
    t.check('  and no lock file is written', holder(edgeOne), 'none');
    refusedOne.handle?.release();
    const edgeTwo = await mkdtemp(join(base, 'lock-edge-two-'));
    const refusedTwo = withEdgeQueryAnswering(
      { status: 0, stdout: '[{"ProcessId":5,"CommandLine":"a"},{"ProcessId":6,"CommandLine":"b"}]' },
      () => take(edgeTwo),
    ).value;
    t.truthy('two: refused, with both pids and the command to end them', /\(process 5, 6\)/.test(refusedTwo.error) && refusedTwo.error.includes('Stop-Process -Id 5,6 -Force'), refusedTwo.error || 'it was taken');
    refusedTwo.handle?.release();
    const nobody = await mkdtemp(join(base, 'lock-nobody-'));
    const free = withEdgeQueryAnswering({ status: 0, stdout: '' }, () => take(nobody)).value;
    t.check('nobody on it: the lock is taken', [free.error, holder(nobody)], ['', process.pid]);
    free.handle?.release();

    /*
     * Pinned as today's behaviour: when the Edge query cannot answer ("unknown"), acquireProfileLock
     * takes the lock anyway. It is a pre-launch guard; refusing on "unknown" would stop every run on
     * a machine where CIM or PowerShell is broken, and the plain `npm start` flow must not break.
     * The places that report to the operator (cop doctor, the System page) do tell "could not
     * check" from "nobody". Both ways to "unknown" are pinned: output that does not parse, and
     * powershell that cannot be started at all (not on PATH).
     */
    const unparsed = await mkdtemp(join(base, 'lock-unparsed-'));
    const e = withEdgeQueryAnswering({ status: 0, stdout: 'not json' }, () => take(unparsed)).value;
    t.check('output that does not parse ("unknown") does not stop the lock being taken (pinned)', [e.error, holder(unparsed)], ['', process.pid]);
    e.handle?.release();

    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    const savedPath = process.env[pathKey];
    const unknownProfile = await mkdtemp(join(base, 'lock-unknown-'));
    process.env[pathKey] = await mkdtemp(join(base, 'no-powershell-'));
    let unknown: unknown;
    let d: { handle: { release: () => void } | null; error: string };
    try {
      unknown = findEdgeUsingProfile(unknownProfile);
      d = take(unknownProfile);
    } finally {
      process.env[pathKey] = savedPath;
    }
    t.check('with powershell unreachable, the Edge query answers "unknown"', unknown, 'unknown');
    t.check('and "unknown" does not stop the lock being taken (pinned)', [d.error, holder(unknownProfile)], ['', process.pid]);
    d.handle?.release();
  });

  // -------------------------------------------------------------------------------------------
  await section('reopen: a window closed under the work is started again and put back on its conversation', async () => {
    /*
     * Operator, 2026-11-13: "if I close the browser with the chat by accident, carry the task on from where it got to".
     * `reopen` starts Edge again on the profile — tried again while the Edge that was closed still holds it — and puts
     * the window back on the conversation it was on, by its address. Edge itself is not started here: `open` is the
     * check's own, a page of this browser that Copilot's addresses are served to by its routes.
     */
    const A = '44444444-5555-6666-7777-888888888888';
    const f = await fixture('reopen', COMPOSER, { signInTimeoutMs: 3_000 });
    const tr = f.transport;
    type Held = Internals & { onChat: { id: string } | 'new' | null; firstLookMs: number; open: () => Promise<void> };
    const held = tr as unknown as Held;
    held.firstLookMs = 2_000;
    const served: string[] = [];
    let starts = 0;
    /** What the next starts find: the profile still held by the Edge that was closed, or another failure. */
    const next: string[] = [];
    held.open = async () => {
      starts += 1;
      const problem = next.shift();
      if (problem) throw new Error(problem);
      const page = await theBrowser().newPage();
      pages.push(page);
      await page.route(/^https:\/\/m365\.cloud\.microsoft\//, async (route) => {
        if (route.request().resourceType() !== 'document') return await route.fulfill({ status: 204, body: '' });
        const url = route.request().url();
        served.push(url.replace(/\?.*$/, ''));
        const id = parseChatId(url);
        return await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8">${COMPOSER}<p id="conv">${id ?? 'home'}</p>` });
      });
      held.context = page.context();
      held.page = page;
      held.watchWindow();
    };
    await tr.open();
    t.check('opened, and put on A', [await tr.openConversation(A), parseChatId(held.page!.url())], [true, A]);

    // The operator's X, then the window again: the first two starts find the profile still held.
    await held.page!.close();
    t.check('closed by hand', [tr.isOpen(), tr.closedOutside()], [false, true]);
    const held2 = 'Microsoft Edge is already running with this profile (process 4242), so a new browser cannot be launched';
    next.push(held2, held2);
    const startsBefore = starts;
    const servedBefore = served.length;
    const from = Date.now();
    const back = await tr.reopen();
    t.check('started again — the third time, once the profile was let go — and back on A by its address', [starts - startsBefore, back, parseChatId(held.page!.url()), served.slice(servedBefore)], [3, { at: 'here' }, A, [`https://m365.cloud.microsoft/chat/conversation/${A}`]]);
    t.truthy('waiting between the starts', Date.now() - from >= 2_500, `${Date.now() - from} ms`);
    t.check('open, not closed by hand, still held to A, and its box there to write in', [tr.isOpen(), tr.closedOutside(), held.onChat, await held.page!.locator('#m365-chat-editor-target-element').isVisible()], [true, false, { id: A }, true]);
    await held.page!.close();
    t.check('closed by hand again, said again', named(f.events, 'window-closed').length, 2);

    // A start that fails for another reason is not tried again: said at once.
    next.push('the profile folder could not be read');
    const startsNow = starts;
    const other = await rejection(tr.reopen());
    t.check('another failure to start: said at once, not tried again', [other?.message, starts - startsNow], ['the profile folder could not be read', 1]);

    // A Stop while the profile is held: no more tries.
    next.push(held2, held2, held2);
    const stop = new AbortController();
    stop.abort();
    const startsStop = starts;
    const stopped = await rejection(tr.reopen({ signal: stop.signal }));
    t.check('stopped: the first failure said, no more tries', [stopped?.message, starts - startsStop], [held2, 1]);
    next.length = 0;

    // A conversation with no address yet — closed before its first answer — cannot be found again.
    await tr.reopen();
    held.onChat = 'new';
    await held.page!.close();
    const lost = await rejection(tr.reopen());
    t.check('closed before its conversation had an address: WindowClosed, saying so, with the new window open on nothing', [lost?.name, lost?.message, tr.isOpen()], ['WindowClosed', NO_ADDRESS_YET, true]);
  });

  // -------------------------------------------------------------------------------------------
  await section('the chat\'s window: a card that says the work has ended, its OK, and a window closed by hand told apart', async () => {
    /*
     * The workbench chat's window is left open between messages (2026-10-19), and says in it, over the page, that
     * the work on a message has ended, with an OK under it. The operator may close the window with its X at any
     * moment; that is told apart from this code closing it, so a run in it stops as a stop rather than an error.
     */
    const f = await fixture('notice', '<!doctype html><body><div id="app" style="height:100vh">chat</div></body>');
    internals(f.transport).context = f.page.context();
    internals(f.transport).watchWindow();
    t.check('a window it holds is open, and not closed by hand', [f.transport.isOpen(), f.transport.closedOutside()], [true, false]);

    const card = { tone: 'done' as const, title: 'Заданието е изпълнено', subject: '„<b>hi.txt</b>“', lines: ['Copilot го завърши.', 'Прозорецът остава отворен.'], button: 'ОК' };
    await f.transport.showNotice(card);
    type Shown = { title?: string | null; subject?: string | null; lines: Array<string | null>; button?: string | null; focused?: string; marked: boolean; atCentre?: string; role?: string | null };
    const shown = async (): Promise<Shown | null> =>
      await f.page.evaluate(() => {
        const host = document.getElementById('copilot-operator-notice');
        const root = host?.shadowRoot;
        if (!root) return null;
        return {
          title: root.querySelector('h2')?.textContent,
          subject: root.querySelector('.subject')?.textContent,
          lines: [...root.querySelectorAll('p:not(.subject)')].map((p) => p.textContent),
          button: root.querySelector('button')?.textContent,
          focused: root.activeElement?.tagName,
          // Text, never markup: a message's title is the operator's own words, shown as they wrote them.
          marked: !!root.querySelector('b'),
          atCentre: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.id,
          role: root.querySelector('.card')?.getAttribute('role'),
        };
      });
    t.check('the card: its heading with a tick, the message as text, its lines, the OK focused, over the page', await shown(), {
      title: '✓Заданието е изпълнено',
      subject: '„<b>hi.txt</b>“',
      lines: ['Copilot го завърши.', 'Прозорецът остава отворен.'],
      button: 'ОК',
      focused: 'BUTTON',
      marked: false,
      atCentre: 'copilot-operator-notice',
      role: 'alertdialog',
    });
    t.check('the page under it is left as it was', await f.page.locator('#app').textContent(), 'chat');
    await f.page.getByRole('button', { name: 'ОК' }).click();
    t.check('its OK takes it away', await shown(), null);

    await f.transport.showNotice({ ...card, tone: 'failed', title: 'one' });
    await f.transport.showNotice({ ...card, tone: 'stopped', title: 'two' });
    t.check('a card shown again replaces the one up: one at a time', [await f.page.evaluate(() => document.querySelectorAll('#copilot-operator-notice').length), (await shown())?.title], [1, '■two']);
    await f.page.keyboard.press('Escape');
    t.check('Escape takes it away as well', await shown(), null);
    await f.transport.showNotice(card);
    await f.transport.clearNotice();
    t.check('one left up is taken away by the next run', await shown(), null);
    await f.transport.clearNotice();
    t.check('and with none up, that does nothing', await shown(), null);

    // The operator's X: the window's page closes without `close`.
    await f.page.close();
    t.check('closed by hand: not open, closed outside, and said once', [f.transport.isOpen(), f.transport.closedOutside(), named(f.events, 'window-closed').length], [false, true, 1]);
    t.check('a card asked for in a closed window is refused, and taking one away does nothing', [!!(await rejection(f.transport.showNotice(card))), await rejection(f.transport.clearNotice())], [true, null]);

    // This code closing it is not the operator's X.
    const g = await fixture('notice-close', '<!doctype html><body>chat</body>');
    internals(g.transport).context = g.page.context();
    internals(g.transport).watchWindow();
    await g.transport.close();
    t.check('closed by close(): not open, not closed outside, nothing said', [g.transport.isOpen(), g.transport.closedOutside(), named(g.events, 'window-closed').length], [false, false, 0]);
  });
} catch (e) {
  t.truthy('setup: a temp dir, a loopback server and a headless Chromium', false, (e as Error).stack ?? String(e));
} finally {
  await browser?.close().catch(() => undefined);
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (base) await rm(base, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\nran in ${Math.round((Date.now() - startedAt) / 1000)} s`);
t.finish();
