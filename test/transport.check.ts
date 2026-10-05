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
import { chromium, type Browser, type Page } from 'playwright';
import {
  CLIPBOARD_GUARD,
  CopilotTransport,
  SendRejectedError,
  isReplyTimeout,
  type TransportOptions,
} from '../src/transport/copilotTransport.js';
import { acquireProfileLock, findEdgeUsingProfile } from '../src/transport/profileLock.js';
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
  const SIDEBAR = (withRename: boolean, closesOn: 'escape' | 'outside'): string => `${COUNT}
    <style>.row .more { visibility: hidden } .row:hover .more { visibility: visible }</style>
    <nav><ul>
      <li class="row"><a href="/chat/conversation/OTHER-1" aria-label="another chat">another chat</a> <button class="more" aria-label="More" data-count="More OTHER-1">...</button></li>
      <li class="row"><a href="/chat/conversation/ID-42" aria-label="old">old</a> <button class="more" aria-label="More" data-count="More ID-42">...</button></li>
    </ul></nav>
    ${COMPOSER}
    <script>
      const WITH_RENAME = ${withRename}, CLOSES_ON = '${closesOn}';
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
        d.querySelector('[data-count="Save"]').addEventListener('click', () => {
          const name = d.querySelector('input').value;
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
    t.check('nameChat returns true', await f.transport.nameChat('ID-42', name), true);
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
    t.check('renamed, though the mouse cannot reach the button', [ok, await f.page.locator('a[href="/chat/conversation/ID-42"]').getAttribute('aria-label')], [true, 'op/ab/covered']);
    t.truthy('in seconds, not the minute of retries', took < 20_000, `${took} ms`);
    const c = await clicks(f.page);
    t.check('that chat\'s More only, then Rename and Save', [c['More ID-42'] ?? 0, c['More OTHER-1'] ?? 0, c['Rename'] ?? 0, c['Save'] ?? 0], [1, 0, 1, 1]);
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
} catch (e) {
  t.truthy('setup: a temp dir, a loopback server and a headless Chromium', false, (e as Error).stack ?? String(e));
} finally {
  await browser?.close().catch(() => undefined);
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (base) await rm(base, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\nran in ${Math.round((Date.now() - startedAt) / 1000)} s`);
t.finish();
