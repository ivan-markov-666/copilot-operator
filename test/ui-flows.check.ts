/**
 * The browser flows of the workbench — the chat and Kerrigan, which is what is left since 2026-10-20 — and the release
 * gate that should keep them honest.
 *
 * test/ui.check.ts covers what a page looks like: text sizes, widths, labels. This file covers what a page *does*:
 *
 * - the release: `.github/workflows/publish.yml` must run `npm run check:ui` (and install the browser it drives)
 *   before `npm publish`, or no browser check guards a release;
 * - both languages having the same keys and placeholders, and Bulgarian fitting on a phone;
 * - the approvals banner: "run the rest without asking" really switches the run, "Abort task" really stops it, a
 *   download is never offered "the rest", and the card names the session;
 * - a start that could not begin, said on every page with what happened as a file;
 * - Settings that gate autonomy, and the number fields that used to fight the typing;
 * - the chat: commands in the conversation, copy, the exchange as JSON, going back, "New chat", the panel under the
 *   editor; plan mode, asked about in the conversation; a long message folded; a long ending with "Copy" under it;
 *   the drop-downs' arrows off their text;
 * - the home screen: only the chat, Kerrigan saved and copied, the "i"s;
 * - the appearance menu on the left: System, light and dark, A− and A+, night light and the reading aids;
 * - the editor: colour by language, an edit kept across tabs and saved, a change on disk asked about;
 * - the Git view, and the changes of a message by keyboard, their buttons in pairs.
 *
 * The browser is Playwright's headless Chromium with a fresh profile, pointed only at the loopback port of the check's
 * own API, which serves the static build in `dist/web` exactly as `npx cop start` does. The chat is the scripted one
 * of test/support/fakeChat.ts; the steps it sends run for real in a throwaway repository. Nothing here opens Edge or
 * Copilot or touches the operator's data.
 *
 *   npm run check:ui            (builds the package, then runs test/ui.check.ts and this file)
 *   npm run check:ui-flows      (this file alone, on an interface already built with `npm run build:package`)
 *
 * Set COP_UI_SHOTS to a folder to keep a screenshot of every scenario that fails; COP_UI_ONLY to run only the
 * scenarios whose title has that text.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Response as PwResponse } from 'playwright';
import { startHarness, waitFor, Tally, type Harness, type SessionView } from './support/harness.js';
import { reply } from './support/fakeChat.js';
import { setTransportFactory, type ChatTransport } from '../src/transport/chatTransport.js';
import { dict } from '../web/lib/strings.js';

const t = new Tally();
const root = join(import.meta.dirname, '..');
const webDir = join(root, 'dist', 'web');
const shots = process.env.COP_UI_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const en = dict.en as Record<string, string>;
const bg = dict.bg as Record<string, string>;

type Plan = { version: 1; onFailure?: 'stop' | 'continue'; sessions: Array<Record<string, unknown>> };
type Approval = { id: string; sessionId: string; stepId: number; description: string; network?: string };
type Raw = { raw: { execution?: Record<string, unknown>; limits?: Record<string, unknown>; copilot?: Record<string, unknown> } };
type Card = SessionView['tasks'][number] & {
  startedAt?: string;
  scope?: string[];
  stopCode?: string;
  checks?: Array<{ name: string; expect: string; run?: string }>;
  scopeReverted?: string[];
  freshRetry?: boolean;
  vcs?: { branch?: string; baseCommit?: string; commit?: string; files?: Array<{ path: string }>; foreignCommits?: string[]; suspicious?: Array<{ path: string; reason: string }> };
};
const cards = async (h: Harness, id: string): Promise<Card[]> => (await h.session(id)).tasks as Card[];

const greeting = {
  title: 'write-greeting',
  prompt: 'Create hello.txt in the repository root holding exactly the word hi, and nothing else.',
  checks: [{ name: 'greeting written', expect: 'file-contains', file: 'hello.txt', value: 'hi' }],
};
/** A task that writes one file, with no checks of its own. */
const task = (title: string, file: string): Record<string, unknown> => ({
  title,
  prompt: `Create ${file} in the repository root holding exactly the word ${title.split('-')[0]}, and nothing else.`,
  checks: [],
});
const session = (h: Harness, name: string, tasks: unknown[] = [greeting]): Record<string, unknown> => ({
  name,
  onFailure: 'stop',
  vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: name },
  review: { enabled: false },
  tasks,
});
const planFor = (h: Harness, name: string, tasks: unknown[] = [greeting]): Plan => ({ version: 1, sessions: [session(h, name, tasks)] });
const write = (file: string, text: string): string => `Set-Content -Path ${file} -Value '${text}' -Encoding utf8`;

// ---------------------------------------------------------------------------------------------
// The release gate. Read first: if publishing never runs the browser checks, every browser check
// guards only the machines where somebody remembered to run them. The gate is `npm run check:ui`,
// the name the plain `check:all` already uses for them.
// ---------------------------------------------------------------------------------------------

console.log('\n--- release gate: publishing runs the browser checks ---');
{
  const workflow = readFileSync(join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
  const lines = workflow.split(/\r?\n/);
  // A command counts on any line that is not a comment, with or without `run:` in front of it, so a
  // step written as one `run: |` block with the commands on lines of their own counts the same, and
  // so does an install with flags (`npx playwright install --with-deps chromium`).
  const at = (re: RegExp): number => lines.findIndex((l) => !/^\s*#/.test(l) && re.test(l));
  const plainCheck = at(/\bnpm run check\s*$/);
  const install = at(/\bnpx playwright install\b.*\bchromium\b/);
  const ui = at(/\bnpm run check:ui\b/);
  const publish = at(/\bnpm publish\b/);
  t.truthy('publish.yml runs the plain checks before publishing', plainCheck >= 0 && publish > plainCheck, { plainCheck, publish });
  // Without this step a release went out with not one browser check run.
  t.truthy('publish.yml runs npm run check:ui', ui >= 0, 'no "npm run check:ui" step in .github/workflows/publish.yml');
  // A fresh windows-latest runner has no Chromium, and the browser checks cannot start without one.
  t.truthy('it installs Chromium first, after npm run check and before npm publish', install > plainCheck && ui > install && publish > ui, { plainCheck, install, ui, publish });

  // The same question for every check, not only the browser ones: whatever `check:all` runs, the
  // workflow runs before it publishes, so a check added there cannot be left out of the release.
  const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  const parts = (scripts['check:all'] ?? '').split('&&').map((p) => p.trim()).filter(Boolean);
  t.truthy('package.json has a check:all that runs the checks', parts.length > 0, scripts['check:all']);
  const command = (l: string): string => l.trim().replace(/^-\s*/, '').replace(/^run:\s*/, '').trim();
  const missing = parts.filter((p) => {
    const i = lines.findIndex((l) => !/^\s*#/.test(l) && command(l) === p);
    return i < 0 || i > publish;
  });
  t.check('publish.yml runs every part of check:all before npm publish', missing, []);
  // And this file is one of them: check:ui is the gate that runs it.
  t.truthy('check:ui runs this file', /\btest\/ui-flows\.check\.ts\b/.test(scripts['check:ui'] ?? ''), scripts['check:ui']);
}

// ---------------------------------------------------------------------------------------------
// The two languages, as data. A key in one and not the other shows the raw key, or English in the
// middle of a Bulgarian page; a placeholder in one and not the other shows "{n}" or drops a number.
// ---------------------------------------------------------------------------------------------

console.log('\n--- languages: the same keys and the same placeholders in English and Bulgarian ---');
{
  const onlyEn = Object.keys(en).filter((k) => !(k in bg));
  const onlyBg = Object.keys(bg).filter((k) => !(k in en));
  t.check('keys only in English', onlyEn, []);
  t.check('keys only in Bulgarian', onlyBg, []);
  const holes = (s: string): string => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',');
  const differ = Object.keys(en)
    .filter((k) => k in bg && holes(en[k]!) !== holes(bg[k]!))
    .map((k) => `${k}: en {${holes(en[k]!)}} bg {${holes(bg[k]!)}}`);
  t.check('keys whose placeholders differ between the languages', differ, []);
}

if (!existsSync(join(webDir, 'index.html'))) {
  console.error('dist/web has no built interface: run `npm run build:package` first.');
  t.truthy('the interface is built', false, 'dist/web/index.html is missing');
  t.finish();
}

let browser: Browser | null = null;

/**
 * One scenario: a harness of its own, a fresh browser context, and every uncaught page error failing
 * it — an error seen in a page nobody asserted on is still a page that broke.
 */
async function scenario(
  title: string,
  settings: Record<string, unknown>,
  body: (h: Harness, page: Page, url: (p: string) => string, context: BrowserContext) => Promise<void>,
): Promise<void> {
  // COP_UI_ONLY runs only the scenarios whose title has this text, while working on one; the release gate sets none.
  if (process.env.COP_UI_ONLY && !title.includes(process.env.COP_UI_ONLY)) return;
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings, webDir });
  const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
  const pageErrors: string[] = [];
  context.on('page', (p) => p.on('pageerror', (e) => pageErrors.push(`${p.url().replace(/^https?:\/\/[^/]+/, '')}: ${e.message}`)));
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const url = (p: string): string => `http://127.0.0.1:${h.api.port}${p}`;
  try {
    await body(h, page, url, context);
    t.check('the pages threw no uncaught errors', pageErrors, []);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
    if (pageErrors.length > 0) console.log(`      page errors: ${JSON.stringify(pageErrors)}`);
    if (shots) await page.screenshot({ path: join(shots, `${title.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.png`), fullPage: true }).catch(() => undefined);
  } finally {
    await settle(h);
    await context.close();
    await h.stop();
  }
}

/** Leaves nothing running before the server goes: a waiting step aborted, a run stopped. */
async function settle(h: Harness): Promise<void> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const a = await h.call<{ running: boolean }>('GET', '/activity').catch(() => ({ running: false }));
    if (!a.running) return;
    for (const s of await h.call<Array<{ id: string; running?: boolean }>>('GET', '/sessions').catch(() => [])) {
      if (s.running) await h.call('POST', `/sessions/${s.id}/stop`).catch(() => undefined);
    }
    for (const w of await h.call<Approval[]>('GET', '/approvals').catch(() => [])) {
      await h.call('POST', `/approvals/${w.id}`, { action: 'abort' }).catch(() => undefined);
    }
    await sleep(300);
  }
}

const settingsOf = async (h: Harness): Promise<Raw['raw']> => (await h.call<Raw>('GET', '/settings')).raw;
/** Whether an element shows up within `ms`, without failing when it does not. */
const appears = async (loc: ReturnType<Page['locator']>, ms: number): Promise<boolean> => await loc.waitFor({ timeout: ms }).then(() => true, () => false);
try {
  browser = await chromium.launch({ headless: true });

  /*
   * The banner is where the operator decides, from any page. "Run the rest without asking" must turn
   * the run unattended, not only answer the step on screen; "Abort task" must stop the task before the
   * next step; a download is never offered "the rest" and says why it is being asked about; and in a
   * run of several the card must say which session is asking, by name.
   */
  await scenario('the approvals banner: run the rest, abort, a download on its own, the session by name', {}, async (h, page, url) => {
    const [rest, abort, fetcher] = await h.importPlan({
      version: 1,
      sessions: [session(h, 'run-rest', [task('both-steps', 'one.txt')]), session(h, 'abort-me', [task('never-two', 'a.txt')]), session(h, 'fetcher', [task('fetch-it', 'x')])],
    });

    // Two steps in one reply; the results are held at the chat until the run mode has been read.
    let reached = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    h.chat.script(reply.steps(write('one.txt', 'one'), write('two.txt', 'two')), async () => {
      reached = true;
      await gate;
      return reply.done();
    });
    await h.call('POST', `/sessions/${rest!.id}/start`, { mode: 'confirm' });
    await page.goto(url('/defaults'));
    const card = page.locator('.approval-banner .approval').first();
    await card.waitFor();
    const link = card.getByRole('link');
    await waitFor('the card to name its session', async () => (await link.textContent()) === 'run-rest', 10_000).catch(() => undefined);
    t.check('the card shows the session name, not its id', await link.textContent(), 'run-rest');
    await card.getByRole('button', { name: 'Run this and the rest without asking' }).click();
    const confirm = page.getByRole('alertdialog');
    await confirm.waitFor({ timeout: 3_000 });
    await confirm.getByRole('button', { name: 'OK' }).click();
    try {
      await waitFor('both steps to run and their results to reach the chat', async () => reached, 30_000);
      const now = await h.call<{ runMode?: string; running?: boolean }>('GET', `/sessions/${rest!.id}`);
      t.check('the run is now unattended', [now.running, now.runMode], [true, 'unattended']);
      t.check('both steps ran, the second without a question', [existsSync(join(h.repo, 'one.txt')), existsSync(join(h.repo, 'two.txt'))], [true, true]);
    } finally {
      release();
    }
    await h.idle();
    t.check('and the task finished', (await cards(h, rest!.id))[0]!.status, 'done');

    // Abort: the task stops at the step on screen, and the one after it never runs.
    h.chat.script(reply.steps(write('a.txt', 'a'), write('b.txt', 'b')));
    await h.call('POST', `/sessions/${abort!.id}/start`, { mode: 'confirm' });
    const abortCard = page.locator('.approval-banner .approval', { hasText: 'abort-me' });
    await abortCard.waitFor();
    await abortCard.getByRole('button', { name: 'Abort task' }).click();
    await h.idle();
    t.check('Abort ends the task aborted, and neither step ran', [(await cards(h, abort!.id))[0]!.status, existsSync(join(h.repo, 'a.txt')), existsSync(join(h.repo, 'b.txt'))], ['aborted', false, false]);

    // A download: asked about on its own, never "the rest".
    h.chat.script(reply.steps('curl https://example.com -o x'));
    await h.call('POST', `/sessions/${fetcher!.id}/start`, { mode: 'confirm' });
    const fetchCard = page.locator('.approval-banner .approval', { hasText: 'curl https://example.com' });
    await fetchCard.waitFor();
    await waitFor('the fetch card to name its session', async () => (await fetchCard.getByRole('link').textContent()) === 'fetcher', 10_000).catch(() => undefined);
    t.check('its card names the session', await fetchCard.getByRole('link').textContent(), 'fetcher');
    t.check('the network note is shown', await fetchCard.getByText(en['approval.network']!).isVisible(), true);
    t.check('and there is no "run the rest" button on it', await fetchCard.getByRole('button', { name: 'Run this and the rest without asking' }).count(), 0);
    t.check('only Run, Skip and Abort task', await fetchCard.getByRole('button').allTextContents(), ['Run', 'Skip', 'Abort task']);
    await fetchCard.getByRole('button', { name: 'Abort task' }).click();
    await h.idle();
    t.check('aborted, and nothing was fetched', [(await cards(h, fetcher!.id))[0]!.status, existsSync(join(h.repo, 'x'))], ['aborted', false]);
  });

  /*
   * A run accepted and then unable to begin — here the browser would not open — is said on every page, with
   * the error, where it stopped and the files, until it is closed (2026-10-13).
   */
  await scenario('a run that could not begin is said on every page, with what happened as a file', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h, page, url) => {
    const sent = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create hello.txt holding hi.', model: 'Think deeper' });
    setTransportFactory(() => ({
      open: async () => {
        throw new Error('browserType.launchPersistentContext: the profile is in use by another Edge (ui check)');
      },
      close: async () => undefined,
      // Never open, so never closed with its X: what the runner asks of a window that failed (2026-10-19).
      isOpen: () => false,
      closedOutside: () => false,
    }) as unknown as ChatTransport);
    t.check('the chat\'s start is accepted', (await h.call<{ started: boolean }>('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' })).started, true);
    await h.idle();
    await page.goto(url('/appearance'));
    const notice = page.getByRole('alert').filter({ hasText: en['startfail.later']! });
    await notice.waitFor({ timeout: 15_000 });
    const said = (await notice.textContent()) ?? '';
    t.truthy('on another page: the run could not begin, the error, and where it stopped', said.includes('profile is in use by another Edge') && said.includes(en['startfail.stage.browser']!), said);
    const href = (await notice.getByRole('link', { name: en['startfail.download']! }).getAttribute('href')) ?? '';
    const file = await page.request.get(href.startsWith('http') ? href : url(href.replace(/^https?:\/\/[^/]+/, '')));
    const text = await file.text();
    t.truthy('its file has the error, the run\'s record and the console', file.ok() && text.includes('profile is in use') && /browser-launch-requested/.test(text) && /What the terminal showed/.test(text), text.slice(0, 800));
    t.check('nothing of the message ran', (await cards(h, sent.threadId))[0]!.status, 'queued');
    await notice.getByRole('button', { name: en['startfail.dismiss']!, exact: true }).click();
    await notice.waitFor({ state: 'detached' });
    await page.goto(url('/presets'));
    await sleep(6_000);
    t.check('closed, it does not come back', await page.getByRole('alert').filter({ hasText: en['startfail.later']! }).count(), 0);
  });

  /*
   * The Execution settings: the three choices that decide how much a run may do alone are written as
   * chosen and read back; the number fields let a value be typed without being clamped under the cursor,
   * clamp once when left, and a value still waiting to be saved is saved when the page is left. Each write
   * starts from the settings as they are now, so a model chosen elsewhere is not put back.
   */
  await scenario('Settings that gate autonomy, number fields typed freely, a pending value saved on leaving', {}, async (h, page, url) => {
    await page.goto(url('/defaults'));
    const fetchSel = page.locator('#network-fetch');
    await waitFor('the settings to load', async () => !(await fetchSel.isDisabled()), 10_000);
    // Chosen after the page read the settings, as another section or another tab would.
    await h.call('PUT', '/models/default', { model: 'Think deeper' });
    await fetchSel.selectOption('refuse');
    await page.locator('#start-mode').selectOption('unattended');
    await page.locator('#isolation').selectOption('vm');
    const exec = await waitFor('the three choices to be saved', async () => {
      const e = (await settingsOf(h)).execution ?? {};
      return e.networkFetch === 'refuse' && e.mode === 'unattended' && e.isolation === 'vm' ? e : null;
    }, 15_000).catch(async () => (await settingsOf(h)).execution ?? {});
    t.check('raw.execution holds them', [exec.networkFetch, exec.mode, exec.isolation], ['refuse', 'unattended', 'vm']);
    await page.reload();
    await waitFor('the settings to load again', async () => !(await fetchSel.isDisabled()), 10_000);
    t.check('after a reload the selects show them', [await fetchSel.inputValue(), await page.locator('#start-mode').inputValue(), await page.locator('#isolation').inputValue()], ['refuse', 'unattended', 'vm']);

    const minutes = page.locator('#max-minutes');
    await minutes.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('10');
    t.check('max minutes: select all and type 10 keeps 10 while focused', [await minutes.inputValue(), await page.evaluate(() => document.activeElement?.id)], ['10', 'max-minutes']);
    await page.keyboard.press('Tab');
    t.check('and 10 once left', await minutes.inputValue(), '10');
    await waitFor('max minutes to be saved', async () => (await settingsOf(h)).limits?.maxRunMinutes === 10, 10_000).catch(() => undefined);
    t.check('saved as 10', (await settingsOf(h)).limits?.maxRunMinutes, 10);

    const replyWait = page.locator('#reply-timeout');
    await replyWait.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('99999');
    await page.keyboard.press('Tab');
    t.check('the reply wait: 99999 becomes 10800 when left', await replyWait.inputValue(), '10800');
    await waitFor('the reply wait to be saved', async () => (await settingsOf(h)).copilot?.replyTimeoutSec === 10800, 10_000).catch(() => undefined);
    t.check('saved as 10800', (await settingsOf(h)).copilot?.replyTimeoutSec, 10800);

    const retries = page.locator('#retry-blocked');
    await retries.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('3');
    // Straight to another page, inside the pause before the save.
    await page.locator('nav a[href="/presets"]').click();
    await waitFor('the presets page', async () => new URL(page.url()).pathname === '/presets', 10_000);
    await waitFor('the retry count to be saved', async () => (await settingsOf(h)).limits?.retryBlockedInFreshChat === 3, 10_000).catch(() => undefined);
    const after = await settingsOf(h);
    t.check('a value typed just before leaving is saved (3)', after.limits?.retryBlockedInFreshChat, 3);
    t.check('the default model chosen meanwhile is still set', after.copilot?.defaultModel, 'Think deeper');
    t.check('and the choices above are still as made', [after.execution?.networkFetch, after.execution?.mode, after.execution?.isolation], ['refuse', 'unattended', 'vm']);
  });

  /*
   * The workbench's chat, like an IDE's (2026-10-17): written to, it works in the open folder on the branch it is
   * on, asking nothing about branches — the commands run there and show in the conversation with their output, the
   * summary and the changed files after them, the file opens in the editor; the next message goes on in the same
   * conversation; going back to before a message puts the folder as it was and takes the later messages out.
   */
  await scenario('the chat works in the open folder: commands in the conversation, the file opens, the next message goes on', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h, page, url) => {
    await page.goto(url('/'));
    const input = page.getByRole('textbox', { name: en['chat.input']! });
    await input.waitFor();
    await page.getByRole('tree', { name: en['wb.files']! }).getByRole('button', { name: 'README.md' }).waitFor();
    t.truthy('the explorer shows the open folder\'s files, and the chat what it works on', ((await page.locator('.cs-welcome').textContent()) ?? '').includes(h.repo), await page.locator('.cs-welcome').textContent());
    t.check('commands run as Settings say, here without asking', await page.getByRole('combobox', { name: en['chat.mode']! }).inputValue(), 'unattended');
    // No model in Settings: the model is set by hand, the entry that replaced "Whatever the chat is on" (2026-10-17).
    const picker = page.getByRole('combobox', { name: en['chat.model']! });
    t.check('with no model in Settings the picker is on "Set the model by hand", its first entry', [(await picker.locator('option:checked').textContent())?.trim(), (await picker.locator('option').first().textContent())?.trim()], [en['chat.modelByHand'], en['chat.modelByHand']]);

    h.chat.script(reply.steps(write('hi.txt', 'hi')), reply.done('I wrote hi.txt holding the word hi and read it back to check it.'));
    await input.fill('Create hi.txt holding the word hi.');
    await input.press('Enter');
    const chat = page.locator('.cs-body');
    // Signed in, the run waits on the card at the top of the workbench while the model is chosen in the Copilot window.
    const banner = page.locator('.approval-banner');
    await banner.getByText(en['approval.manualTitle']!).waitFor({ timeout: 30_000 });
    t.check('signed in, it waits on the card at the top of the workbench, with nothing sent', h.chat.sent.length, 0);
    // One way on, not two that did the same (2026-10-19), and Stop.
    t.check('the card offers "Ready — continue" and "Stop", nothing else', await banner.locator('.approval').last().getByRole('button').allTextContents(), [en['approval.manualReady'], en['approval.modelStop']]);
    h.chat.currentModel = 'GPT 5.6 Sol Think deeper';
    await banner.getByRole('button', { name: en['approval.manualReady']!, exact: true }).click();
    await chat.getByText('I wrote hi.txt holding the word hi').waitFor({ timeout: 30_000 });
    const thread = (await h.call<Array<{ id: string }>>('GET', '/chat/threads'))[0]!.id;
    t.check('"Ready" pressed, it ran on the model chosen by hand', (await h.call<{ modelInUse?: string }>('GET', `/sessions/${thread}`)).modelInUse, 'GPT 5.6 Sol Think deeper');
    t.check('it worked on main, the branch the folder is on, and committed nothing', [h.git('rev-parse', '--abbrev-ref', 'HEAD'), h.git('log', '--format=%s')], ['main', 'initial']);
    t.truthy('the model is chosen under the box, with a button to read the latest ones', (await page.getByRole('combobox', { name: en['chat.model']! }).count()) === 1 && (await page.getByRole('button', { name: en['chat.readModels']! }).count()) === 1);
    // The command's card comes with the task's story, read on a poll of its own: it can follow the summary by a moment.
    await chat.locator('.cs-cmd').first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    t.truthy('the message, its command and the summary are in the conversation', ((await chat.textContent()) ?? '').includes('Create hi.txt holding the word hi.') && (await chat.locator('.cs-cmd').count()) === 1 && ((await chat.locator('.cs-cmd').textContent()) ?? '').includes('Set-Content -Path hi.txt'), await chat.textContent());
    // Copy on a message (2026-10-19): the message itself on the clipboard, and the button says so.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url('') });
    const copyMine = chat.locator('.cs-turn').first().getByRole('button', { name: en['chat.copyMessage']!, exact: true });
    await copyMine.click();
    t.check('"Copy" on your message: the message on the clipboard, and "Copied" on the button', [await page.evaluate(() => navigator.clipboard.readText()), ((await copyMine.textContent()) ?? '').trim()], ['Create hi.txt holding the word hi.', en['copy.copied']]);
    const copyCommand = chat.locator('.cs-cmd').first().getByRole('button', { name: en['chat.copyCommand']!, exact: true });
    await copyCommand.click();
    // A command that printed nothing is copied as the command alone, ready to paste into a terminal.
    t.check('and on a command that printed nothing: the command itself', await page.evaluate(() => navigator.clipboard.readText()), write('hi.txt', 'hi'));

    // The message's whole exchange with Copilot, as a file of its own (2026-10-18).
    const [exchangeFile] = await Promise.all([page.waitForEvent('download'), chat.locator('.cs-turn').first().getByRole('link', { name: en['chat.exchange']! }).click()]);
    const exchange = JSON.parse(readFileSync((await exchangeFile.path())!, 'utf8')) as { task: { message: string }; attempts: Array<{ entries: Array<{ kind: string; command?: string; exitCode?: number }> }> };
    t.check('"⤓ JSON" on the message saves its exchange: the message, and the command that ran with its exit code', [exchange.task.message, exchange.attempts[0]?.entries.filter((e) => e.kind === 'command').map((e) => [e.command, e.exitCode])], ['Create hi.txt holding the word hi.', [[write('hi.txt', 'hi'), 0]]]);
    t.truthy('named for its conversation and message', /^copilot-operator-exchange-.+-01-.+\.json$/.test(exchangeFile.suggestedFilename()), exchangeFile.suggestedFilename());
    await chat.getByRole('button', { name: /^hi\.txt/ }).click();
    const editor = page.locator('.wb-file-pane:not([hidden])');
    await editor.locator('.ed-input').waitFor();
    t.check('the changed file opens in the editor, as it is on disk', (await editor.locator('.ed-input').inputValue()).trim(), 'hi');
    await page.getByRole('button', { name: en['wb.refresh']!, exact: true }).first().click();
    await page.getByRole('tree', { name: en['wb.files']! }).getByRole('button', { name: 'hi.txt' }).waitFor();
    t.truthy('and is in the explorer', true);

    let firstChat = '';
    firstChat = h.chat.sent.find((m) => m.contract === 'task')?.chatId ?? '';
    h.chat.script(
      (m) => {
        t.check('the next message goes into the same Copilot conversation', m.chatId, firstChat);
        return reply.steps(write('bye.txt', 'bye'));
      },
      reply.done('I wrote bye.txt holding the word bye and read it back to check it.'),
    );
    await input.fill('Now bye.txt holding bye.');
    await input.press('Enter');
    await chat.getByText('I wrote bye.txt holding the word bye').waitFor({ timeout: 30_000 });
    t.check('two messages in the conversation, both files in the folder', [await chat.locator('.cs-turn').count(), existsSync(join(h.repo, 'hi.txt')), existsSync(join(h.repo, 'bye.txt'))], [2, true, true]);
    const askedFor = (await h.call<Array<{ type: string }>>('GET', `/sessions/${thread}/events`)).filter((e) => e.type === 'model-help-asked').length;
    t.check('the model was asked for once: the second message, in the same conversation, was not held', askedFor, 1);
    t.check('and the conversation is in the list', await page.getByRole('combobox', { name: en['chat.thread']! }).locator('option').allTextContents(), [en['chat.newThread'], 'Create hi.txt holding the word hi.']);

    // Back to before the second message: its file gone, the message out of the conversation and back in the box.
    await chat.locator('.cs-turn').nth(1).getByRole('button', { name: en['chat.rewind']! }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'OK' }).click();
    await waitFor('the second message to be gone', async () => (await chat.locator('.cs-turn').count()) === 1, 10_000).catch(() => undefined);
    t.check('back to before it: one message left, its file gone, the first one\'s kept', [await chat.locator('.cs-turn').count(), existsSync(join(h.repo, 'bye.txt')), existsSync(join(h.repo, 'hi.txt'))], [1, false, true]);
    t.check('and the message is back in the box, to send again or change', await input.inputValue(), 'Now bye.txt holding bye.');

    // The panel under the editor shows this chat's commands; a new chat clears it (2026-10-19).
    const panelTab = (key: string) => page.getByRole('tablist', { name: en['wb.panel']! }).getByRole('tab', { name: en[key]! });
    const panelBody = page.locator('.wb-bottom-body');
    await panelTab('wb.terminal').click();
    await panelBody.getByText('Set-Content -Path hi.txt', { exact: false }).first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    t.truthy('before: the terminal shows this chat\'s command', ((await panelBody.textContent()) ?? '').includes('Set-Content -Path hi.txt'), await panelBody.textContent());

    // "New chat", by its name (it was a bare "+"): an empty conversation, the one before kept in the list.
    const newChat = page.getByRole('button', { name: en['chat.newChat']!, exact: true });
    await newChat.click();
    await panelBody.getByText(en['wb.newChatTerminal']!).waitFor({ timeout: 10_000 }).catch(() => undefined);
    const terminalNow = (await panelBody.textContent()) ?? '';
    await panelTab('wb.problems').click();
    const problemsNow = (await panelBody.textContent()) ?? '';
    t.check('"New chat" clears the terminal and the problems of the chat before', [terminalNow.includes(en['wb.newChatTerminal']!), terminalNow.includes('hi.txt'), problemsNow.includes(en['wb.newChatProblems']!)], [true, false, true]);
    await panelTab('wb.terminal').click();
    await page.locator('.cs-welcome').waitFor();
    const threadPicker = page.getByRole('combobox', { name: en['chat.thread']! });
    t.check('"New chat": a new, empty conversation, the one before still in the list', [await threadPicker.inputValue(), await chat.locator('.cs-turn').count(), (await threadPicker.locator('option').allTextContents()).includes('Create hi.txt holding the word hi.')], ['', 0, true]);
    t.check('and, already on a new one, it has nothing more to do', await newChat.isDisabled(), true);
  });

  /*
   * The Git view (2026-10-19: "let the Commits button show Git as VS Code does"): the open folder's changes, each file
   * with its letter, opening its two versions side by side in the editor; and the branch's commits, each opening to
   * its files, which open the same way.
   */
  await scenario('the Git view: the changes and the commits, each file opening its two versions in the editor', {}, async (h, page, url) => {
    writeFileSync(join(h.repo, 'README.md'), '# fixture\nmore\n', 'utf8');
    writeFileSync(join(h.repo, 'new.txt'), 'brand new\n', 'utf8');
    await page.goto(url('/'));
    await page.getByRole('button', { name: en['wb.viewCommits']!, exact: true }).click();
    const side = page.locator('.wb-side');
    await side.getByRole('button', { name: new RegExp(`^${en['git.changes']!}`) }).waitFor();
    const rows = side.locator('.wb-git-files li');
    await rows.nth(1).waitFor({ timeout: 10_000 }).catch(() => undefined);
    const listed = await rows.evaluateAll((els) => els.map((li) => [li.querySelector('.wb-row-name')?.textContent ?? '', li.querySelector('.wb-git-status')?.textContent ?? '']));
    t.check('the changes: the file changed (M) and the one git does not track (U)', listed, [['README.md', 'M'], ['new.txt', 'U']]);
    t.truthy('on the branch it is on', ((await side.locator('.wb-git-branch').textContent()) ?? '').includes('main'), await side.locator('.wb-git-branch').textContent());

    await rows.first().getByRole('button').click();
    const tab = page.getByRole('tablist', { name: en['wb.openTabs']! }).getByRole('tab', { name: `README.md (${en['git.workingTree']})` });
    await tab.waitFor();
    const editor = page.locator('.wb-gitdiff');
    await editor.locator('.diff-row').first().waitFor();
    const sides = await editor.locator('.diff-row').evaluateAll((trs) => trs.map((tr) => [tr.querySelector('.code.l')?.textContent ?? '', tr.querySelector('.code.r')?.textContent ?? '']));
    t.check('a changed file opens in the editor: as it was on the left, as it is on the right', sides, [['# fixture', '# fixture'], ['', 'more']]);

    const commits = side.locator('.wb-commits > li');
    t.check('the commits of the branch', await commits.locator('.wb-row-name').allTextContents(), ['initial']);
    await commits.first().getByRole('button', { name: /initial/ }).click();
    const files = commits.first().locator('.wb-git-files li');
    await files.first().waitFor();
    t.check('a commit opens to its files', await files.evaluateAll((els) => els.map((li) => [li.querySelector('.wb-row-name')?.textContent ?? '', li.querySelector('.wb-git-status')?.textContent ?? ''])), [['README.md', 'A']]);
    await files.first().getByRole('button').click();
    const short = h.git('rev-parse', '--short=7', 'HEAD');
    await page.getByRole('tablist', { name: en['wb.openTabs']! }).getByRole('tab', { name: `README.md (${short})` }).waitFor();
    await page.locator('.wb-gitdiff .diff-row').first().waitFor();
    t.check('and its file opens the same way: nothing before, the commit\'s version after', await page.locator('.wb-gitdiff .diff-row').evaluateAll((trs) => trs.map((tr) => [tr.querySelector('.code.l')?.textContent ?? '', tr.querySelector('.code.r')?.textContent ?? ''])), [['', '# fixture']]);
    t.check('reading it changed nothing in the repository', h.git('status', '--porcelain').split('\n').map((l) => l.trim()).sort(), ['?? new.txt', 'M README.md']);
  });

  /*
   * The conversation open in the chat is forgotten only when the API no longer has it (2026-10-20). Any failed read
   * forgot it: the page reloaded while its first read was out, or the bot was restarting, and the chat came back on a
   * new conversation — the checks that open one through this browser's storage and reload failed on it.
   */
  await scenario('the open conversation outlives a read that failed; only one the API does not have is forgotten', {}, async (h, page, url) => {
    const { threadId } = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Keep me open.', model: 'Think deeper' });
    await page.goto(url('/'));
    await page.locator('#cs-thread').waitFor();
    await page.evaluate((id) => localStorage.setItem('cop.chat.thread', id), threadId);
    let failed = 0;
    const route = `**/api/sessions/${threadId}`;
    await page.route(route, async (r) => {
      if (r.request().method() === 'GET' && failed < 2) {
        failed += 1;
        await r.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"the bot is restarting"}' });
      } else await r.fallback();
    });
    await page.reload();
    await waitFor('the reads to fail', async () => failed >= 2, 10_000).catch(() => undefined);
    t.check('two reads failed on the way', failed, 2);
    t.check('the conversation is still the one kept in this browser', await page.evaluate(() => localStorage.getItem('cop.chat.thread')), threadId);
    await page.locator('.cs-turn').first().waitFor({ timeout: 15_000 });
    t.check('and the next read opens it', await page.locator('#cs-thread').inputValue(), threadId);
    await page.unroute(route);
    await page.evaluate(() => localStorage.setItem('cop.chat.thread', '20200101-000000-gone'));
    await page.reload();
    await waitFor('the unknown conversation to be forgotten', async () => (await page.evaluate(() => localStorage.getItem('cop.chat.thread'))) === null, 10_000).catch(() => undefined);
    t.check('one the API does not have (404) is forgotten, and the chat is on a new conversation', [await page.evaluate(() => localStorage.getItem('cop.chat.thread')), await page.locator('#cs-thread').inputValue()], [null, '']);
  });

  /*
   * A long message of the operator's folds to its first three lines, fading out, with an arrow that opens it and
   * closes it again; a short one shows as it is (2026-10-19). "Copy" copies all of it, folded or not.
   */
  await scenario('a long message in the chat folds to three lines, and the arrow opens it', {}, async (h, page, url) => {
    const long = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long instruction for the chat.`).join('\n');
    const { threadId } = await h.call<{ threadId: string }>('POST', '/chat', { text: long, model: 'Think deeper' });
    await h.call('POST', '/chat', { text: 'Short one.', threadId });
    await page.goto(url('/'));
    await page.evaluate((id) => localStorage.setItem('cop.chat.thread', id), threadId);
    await page.reload();
    const turns = page.locator('.cs-turn');
    await turns.nth(1).waitFor();
    const first = turns.first();
    const fold = first.locator('.cs-fold');
    await first.getByRole('button', { name: en['chat.foldOpen']!, exact: true }).waitFor();
    const shut = await fold.evaluate((el) => ({ shown: el.clientHeight, whole: el.scrollHeight, line: parseFloat(getComputedStyle(el).lineHeight) }));
    t.truthy('folded: about three lines of twelve shown, blurring out', shut.shown <= shut.line * 3 + 2 && shut.whole > shut.shown * 2 && (await first.locator('.cs-fold-blur').count()) === 1, shut);
    await first.getByRole('button', { name: en['chat.foldOpen']!, exact: true }).click();
    const opened = await fold.evaluate((el) => ({ shown: el.clientHeight, whole: el.scrollHeight }));
    const close = first.getByRole('button', { name: en['chat.foldClose']!, exact: true });
    t.truthy('the arrow opens it whole', opened.shown >= opened.whole - 1 && (await close.getAttribute('aria-expanded')) === 'true' && (await first.locator('.cs-fold-blur').count()) === 0, opened);
    await close.click();
    t.check('and folds it again', await first.getByRole('button', { name: en['chat.foldOpen']!, exact: true }).getAttribute('aria-expanded'), 'false');
    t.check('a short message: no arrow, nothing hidden', [await turns.nth(1).locator('.cs-fold-toggle').count(), await turns.nth(1).locator('.cs-fold.folded').count()], [0, 0]);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url('') });
    await first.getByRole('button', { name: en['chat.copyMessage']!, exact: true }).click();
    // The Windows clipboard hands the lines back with CRLF; the text is what counts.
    t.check('folded, "Copy" still copies all of it', (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), long);
  });

  /*
   * The home screen after 2026-10-20: only the chat in the right panel, no Sessions, task register or plan from JSON
   * anywhere; Kerrigan on the home screen, saved as a file or copied, in the page's language; and an "i" beside the
   * panel's three tabs and beside Kerrigan, each saying what it is.
   */
  await scenario('the home screen: only the chat, Kerrigan saved and copied, and the "i"s say what each part is', {}, async (h, page, url) => {
    await page.goto(url('/'));
    const kerrigan = page.getByRole('button', { name: en['kerrigan.button']!, exact: true });
    await kerrigan.waitFor();
    t.check('the right panel has the chat alone', await page.getByRole('tablist', { name: en['wb.chatPanel']! }).getByRole('tab').allTextContents(), [en['wb.chatTab']]);
    t.check('the bar on top links Settings, and nothing of the sessions', await page.locator('.wb-menu a').allTextContents(), [en['nav.defaults']]);
    t.check('no "Write in the chat", "Import a plan" or "Ask Kerrigan" on the home screen', await page.locator('.wb-welcome').getByRole('button').allTextContents(), [`${en['kerrigan.button']} ▾`, 'i']);

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url('') });
    await kerrigan.click();
    const menu = page.getByRole('menu', { name: en['kerrigan.menu']! });
    await menu.waitFor();
    t.check('Kerrigan opens two ways to take her', await menu.getByRole('menuitem').allTextContents(), [en['kerrigan.save'], en['kerrigan.copy']]);
    await menu.getByRole('menuitem', { name: en['kerrigan.copy']! }).click();
    await page.getByRole('status').filter({ hasText: /Copied \(\d+ characters\)/ }).waitFor();
    const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    t.truthy('copied: the persona, what copilot-operator is and how to write a task for it', copied.startsWith('# Kerrigan') && copied.includes('## What copilot-operator is') && copied.includes('## How you help') && copied.includes('"New chat"'), copied.slice(0, 300));
    t.check('with this machine\'s limits in it', /at most 60 messages to Copilot and 240 minutes per task/.test(copied), true);

    await kerrigan.click();
    const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('menu').getByRole('menuitem', { name: en['kerrigan.save']! }).click()]);
    t.check('saved as a Markdown file named for her and the language', file.suggestedFilename(), 'kerrigan-copilot-operator.en.md');
    t.check('holding the same text', readFileSync((await file.path())!, 'utf8').replace(/\r\n/g, '\n'), copied);

    await page.getByRole('button', { name: en['kerrigan.infoLabel']!, exact: true }).click();
    const about = page.getByRole('dialog', { name: en['kerrigan.infoLabel']! });
    await about.waitFor();
    t.truthy('the "i" beside her says what she is, and that she is optional', ((await about.textContent()) ?? '').includes('works just as well without her'), await about.textContent());
    await page.keyboard.press('Escape');
    await about.waitFor({ state: 'detached' });
    t.check('Escape closes it and gives the keyboard back to the "i"', await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), en['kerrigan.infoLabel']);

    for (const [label, info] of [['wb.terminalInfoLabel', 'wb.terminalInfo'], ['wb.problemsInfoLabel', 'wb.problemsInfo'], ['wb.outputInfoLabel', 'wb.outputInfo']] as const) {
      await page.getByRole('button', { name: en[label]!, exact: true }).click();
      const box = page.getByRole('dialog', { name: en[label]! });
      await box.waitFor();
      const first = en[info]!.split('\n\n')[0]!;
      t.truthy(`"${en[label]}": its "i" says what it shows`, ((await box.textContent()) ?? '').includes(first), await box.textContent());
      // A click elsewhere closes it too.
      await page.locator('.wb-welcome h2').click();
      await box.waitFor({ state: 'detached' });
    }

    await page.locator('nav select').first().selectOption({ label: 'Български' });
    await page.getByRole('button', { name: bg['kerrigan.button']!, exact: true }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: bg['kerrigan.copy']! }).click();
    await page.getByRole('status').filter({ hasText: /Копирано/ }).waitFor();
    t.truthy('in Bulgarian, she is in Bulgarian', (await page.evaluate(() => navigator.clipboard.readText())).startsWith('# Кериган'), '');

    await page.goto(url('/defaults'));
    await page.locator('nav').first().waitFor();
    const navLinks = await page.locator('header nav a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    t.check('the other pages\' navigation has no Sessions, task register or plan from JSON', navLinks.filter((x) => x === '/sessions' || x === '/history' || x === '/import'), []);
    for (const gone of ['/sessions', '/history', '/import']) {
      const r = await page.request.get(url(gone));
      t.truthy(`${gone} is not a page any more`, r.status() === 404 || !(await r.text()).includes('<main'), r.status());
    }
  });

  /*
   * How the page looks, from the last icon on the left (2026-10-20): the theme — System by default, which follows
   * the machine — Light and Dark; the text a step smaller or larger; night light and the reading aids.
   */
  await scenario('the appearance menu on the left: System by default, light and dark, A− and A+, night light and the reading aids', {}, async (_h, page, url) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(url('/'));
    const html = (name: string): Promise<string | undefined> => page.evaluate((n) => document.documentElement.dataset[n], name);
    await page.getByRole('button', { name: en['wb.appearance']!, exact: true }).waitFor();
    t.check('nothing chosen: the theme is the machine\'s, here dark, before and after the page has loaded', await html('theme'), 'dark');
    await page.getByRole('button', { name: en['wb.appearance']!, exact: true }).click();
    const menu = page.getByRole('dialog', { name: en['wb.appearance']! });
    await menu.waitFor();
    const theme = (key: string) => menu.getByRole('button', { name: en[key]!, exact: true });
    t.check('System is the one pressed', await theme('theme.system').getAttribute('aria-pressed'), 'true');
    await theme('theme.light').click();
    t.check('Light: the page is light', await html('theme'), 'light');
    await theme('theme.system').click();
    t.check('System again: dark, as the machine is', await html('theme'), 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await waitFor('the page to follow the machine', async () => (await html('theme')) === 'light', 5_000).catch(() => undefined);
    t.check('and it follows the machine when that changes', await html('theme'), 'light');
    await theme('theme.dark').click();
    t.check('Dark: dark whatever the machine', await html('theme'), 'dark');

    const larger = menu.getByRole('button', { name: en['ap.larger']!, exact: true });
    const smaller = menu.getByRole('button', { name: en['ap.smaller']!, exact: true });
    t.check('the A− and A+ buttons read so', [((await smaller.textContent()) ?? '').trim(), ((await larger.textContent()) ?? '').trim()], ['A−', 'A+']);
    await larger.click();
    await larger.click();
    t.check('A+ twice: two steps larger', await html('textsize'), 'huge');
    for (let i = 0; i < 3; i++) await smaller.click();
    t.check('A− three times: the smallest', [await html('textsize'), await smaller.isDisabled()], ['small', true]);

    const aid = (key: string) => menu.getByRole('checkbox', { name: en[key]! });
    await aid('ap.night').check();
    const veil = await page.evaluate(() => getComputedStyle(document.documentElement, '::after').getPropertyValue('content'));
    t.check('night light: on, a warm veil over the page', [await html('night'), veil !== 'none' && veil !== ''], ['on', true]);
    t.truthy('and the page is still pressed through it', await page.getByRole('button', { name: en['kerrigan.button']!, exact: true }).isEnabled(), '');
    await aid('ap.links').check();
    await aid('ap.motion').check();
    t.check('underlined links and less motion', [await html('links'), await html('motion')], ['underline', 'reduced']);
    await page.reload();
    t.check('kept in this browser, from before the first paint', [await html('theme'), await html('textsize'), await html('night'), await html('links')], ['dark', 'small', 'on', 'underline']);
    await page.getByRole('button', { name: en['wb.appearance']!, exact: true }).click();
    await page.getByRole('dialog', { name: en['wb.appearance']! }).getByRole('button', { name: en['ap.reset']! }).click();
    t.check('back to the defaults: the machine\'s theme, normal text, no veil', [await html('theme'), await html('textsize'), await html('night')], ['light', 'normal', 'off']);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: en['wb.appearance']! }).waitFor({ state: 'detached' });
    t.check('Escape closes the menu', true, true);
    t.check('it is not a link to Settings', await page.getByRole('button', { name: en['wb.appearance']!, exact: true }).evaluate((b) => b.tagName), 'BUTTON');

    await page.goto(url('/appearance'));
    await page.getByRole('group', { name: en['ap.theme']! }).waitFor();
    t.check('the Appearance page offers the same three', await page.getByRole('group', { name: en['ap.theme']! }).getByRole('button').allTextContents(), [en['theme.system'], en['theme.light'], en['theme.dark']]);
  });

  /*
   * The editor (2026-10-20, "as an IDE"): a file opens in colour by its language, found by itself; edited, it is
   * marked on its tab, keeps the edit across a change of tab, and is saved with Ctrl+S, keeping its line endings; a
   * change on disk under an edit is asked about, and one with no edit is followed.
   */
  await scenario('the editor: coloured by its language, edited, kept across tabs, saved; a change on disk asked about', {}, async (h, page, url) => {
    const ts = join(h.repo, 'greet.ts');
    writeFileSync(ts, 'export const a = 1;\r\nexport function f(): number {\r\n  return a; // the answer\r\n}\r\n');
    writeFileSync(join(h.repo, 'notes.txt'), 'plain\n');
    await page.goto(url('/'));
    const files = page.getByRole('tree', { name: en['wb.files']! });
    await files.getByRole('button', { name: 'greet.ts' }).click();
    const pane = page.locator('.wb-file-pane:not([hidden])');
    const box = pane.locator('.ed-input');
    await box.waitFor();
    t.check('found by itself: TypeScript', ((await pane.locator('.ed-lang option:checked').textContent()) ?? '').trim(), en['ed.langAuto']!.replace('{name}', 'TypeScript'));
    t.truthy('in colour: keywords, a number, a comment', (await pane.locator('.ed-shown .hl-kw').count()) >= 3 && (await pane.locator('.ed-shown .hl-num').count()) >= 1 && (await pane.locator('.ed-shown .hl-com').count()) === 1, await pane.locator('.ed-shown').innerHTML());
    t.check('with line numbers', ((await pane.locator('.ed-gutter').textContent()) ?? '').trim().split('\n'), ['1', '2', '3', '4', '5']);
    t.check('and an icon of its kind on its tab', await page.getByRole('tab', { name: /greet\.ts/ }).locator('svg.file-ico').count(), 1);
    await pane.locator('.ed-lang').selectOption('plain');
    t.check('chosen by hand, plain text: no colours', await pane.locator('.ed-shown .hl-kw').count(), 0);
    await pane.locator('.ed-lang').selectOption('auto');

    await box.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// edited');
    await page.getByRole('tab', { name: /greet\.ts/ }).locator('.wb-unsaved').waitFor();
    t.check('edited: "Not saved", and a dot on its tab', ((await pane.locator('.ed-bar [role="status"]').textContent()) ?? '').trim(), en['ed.unsaved']);
    await files.getByRole('button', { name: 'notes.txt' }).click();
    await page.locator('.wb-file-pane:not([hidden]) .ed-input').waitFor();
    await page.getByRole('tab', { name: /greet\.ts/ }).click();
    t.truthy('another tab and back: the edit is still there', (await page.locator('.wb-file-pane:not([hidden]) .ed-input').inputValue()).endsWith('// edited'), '');
    await page.locator('.wb-file-pane:not([hidden]) .ed-input').click();
    await page.keyboard.press('Control+S');
    await page.locator('.wb-file-pane:not([hidden]) .ed-bar').getByText(en['ed.saved']!).waitFor();
    const onDisk = readFileSync(ts, 'utf8');
    t.check('Ctrl+S: saved on disk, its CRLF line endings kept', [onDisk.endsWith('}\r\n// edited'), (onDisk.match(/\r\n/g) ?? []).length, onDisk.includes('\n') && !/[^\r]\n/.test(onDisk)], [true, 4, true]);
    t.check('and the dot is gone', await page.getByRole('tab', { name: /greet\.ts/ }).locator('.wb-unsaved').count(), 0);

    // A change on disk with no edit: followed. Under an edit: asked about.
    writeFileSync(ts, 'export const a = 2;\r\n');
    await waitFor('the editor to follow the disk', async () => (await page.locator('.wb-file-pane:not([hidden]) .ed-input').inputValue()) === 'export const a = 2;\n', 10_000).catch(() => undefined);
    t.check('no edit: it follows the change on disk', await page.locator('.wb-file-pane:not([hidden]) .ed-input').inputValue(), 'export const a = 2;\n');
    await page.locator('.wb-file-pane:not([hidden]) .ed-input').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// mine');
    writeFileSync(ts, 'export const a = 3;\r\n');
    const conflict = page.locator('.wb-file-pane:not([hidden]) .ed-conflict');
    await conflict.waitFor({ timeout: 10_000 });
    t.truthy('under an edit: it says the file changed on disk, and asks', ((await conflict.textContent()) ?? '').includes(en['ed.changedOnDisk']!), await conflict.textContent());
    await conflict.getByRole('button', { name: en['ed.saveOver']! }).click();
    await page.locator('.wb-file-pane:not([hidden]) .ed-bar').getByText(en['ed.saved']!).waitFor();
    t.check('"Save over it": the edit is on disk', readFileSync(ts, 'utf8'), 'export const a = 2;\r\n// mine');

    // Tab indents, through the browser's own edit.
    await page.locator('.wb-file-pane:not([hidden]) .ed-input').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Tab');
    t.truthy('Tab indents the line', (await page.locator('.wb-file-pane:not([hidden]) .ed-input').inputValue()).startsWith('  export'), '');
    await page.keyboard.press('Control+Z');
    t.truthy('and Ctrl+Z takes it back', (await page.locator('.wb-file-pane:not([hidden]) .ed-input').inputValue()).startsWith('export'), '');
  });

  /*
   * Plan mode in the chat (2026-10-20, "as in Claude Code"): turned on under the box, the message first gets a plan,
   * asked about in the conversation — even with commands run without asking — and the work only after it is approved.
   */
  await scenario('plan mode in the chat: the plan asked about in the conversation, then the work', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h, page, url) => {
    await h.call('PUT', '/models/default', { model: 'Think deeper' });
    await page.goto(url('/'));
    const input = page.getByRole('textbox', { name: en['chat.input']! });
    await input.waitFor();
    const plan = page.getByRole('checkbox', { name: en['chat.planMode']! });
    t.check('plan mode is off at first', await plan.isChecked(), false);
    await plan.check();
    const note = 'Keep it to one word.';
    h.chat.script(
      reply.plan({ files: ['planned.txt'] }),
      (m) => {
        t.truthy('the approval and its note reach the chat', m.text.startsWith('The operator approved your plan.') && m.text.includes(note), m.text.slice(0, 300));
        return reply.steps(write('planned.txt', 'planned'));
      },
      reply.done('I wrote planned.txt as the plan said and read it back to check it.'),
    );
    await input.fill('Create planned.txt holding the word planned.');
    await input.press('Enter');
    const card = page.locator('.cs-plan-ask .approval');
    await card.waitFor({ timeout: 30_000 });
    t.truthy('the plan is asked about in the conversation, though commands run without asking', ((await card.textContent()) ?? '').includes('create the file'), await card.textContent());
    t.check('with its three answers', await card.getByRole('button').allTextContents(), [en['pm.approve'], en['pm.revise'], en['pm.stop']]);
    t.check('and not in the banner over the workbench', await page.locator('.approval-banner .approval').count(), 0);
    t.check('nothing was changed before it is approved', existsSync(join(h.repo, 'planned.txt')), false);
    await card.getByRole('textbox', { name: en['pm.note']! }).fill(note);
    await card.getByRole('button', { name: en['pm.approve']!, exact: true }).click();
    await page.locator('.cs-body').getByText('I wrote planned.txt as the plan said').waitFor({ timeout: 30_000 });
    t.check('approved: the work, then done', [existsSync(join(h.repo, 'planned.txt'))], [true]);
    const shown = page.locator('details.cs-plan');
    await shown.waitFor();
    t.check('the approved plan stays under the message, folded', ((await shown.locator('summary').textContent()) ?? '').trim(), en['chat.planShown']!.replace('{v}', '1'));
    const thread = (await h.call<Array<{ id: string }>>('GET', '/chat/threads'))[0]!.id;
    t.check('the conversation keeps plan mode', (await h.call<{ planMode?: string }>('GET', `/sessions/${thread}`)).planMode, 'approve');
    // The box answers the click at once, before the API has; `uncheck` fails on a box that waits for the server.
    await plan.uncheck();
    await waitFor('plan mode off for the conversation', async () => ((await h.call<{ planMode?: string }>('GET', `/sessions/${thread}`)).planMode === 'off' ? true : null), 10_000).catch(() => undefined);
    t.check('turned off under the box, for this conversation', (await h.call<{ planMode?: string }>('GET', `/sessions/${thread}`)).planMode, 'off');
  });

  /*
   * "Pause" turns into "Continue" (operator, 2026-10-20): pressed, the work holds and the chat and the status bar
   * say so; "Continue" goes on to the end.
   */
  await scenario('"Pause" holds the chat\'s work and turns into "Continue", which goes on', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h, page, url) => {
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    const { threadId } = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create later.txt holding later.', model: 'Think deeper' });
    h.chat.script(
      async () => {
        await answered;
        return reply.steps(write('later.txt', 'later'));
      },
      reply.done('I wrote later.txt holding the word later and read it back to check that it is there.'),
    );
    await h.call('POST', `/sessions/${threadId}/start`, { mode: 'unattended' });
    await page.goto(url('/'));
    await page.locator('#cs-thread').waitFor();
    await page.evaluate((id) => localStorage.setItem('cop.chat.thread', id), threadId);
    await page.reload();
    const pause = page.getByRole('button', { name: en['chat.pause']!, exact: true });
    const resume = page.getByRole('button', { name: en['chat.resume']!, exact: true });
    await pause.waitFor({ timeout: 15_000 });
    t.check('while it works: "Pause" beside "Stop"', await page.locator('.cs-bar button').allTextContents().then((all) => all.filter((x) => x === en['chat.pause'] || x === en['chat.stop'])), [en['chat.pause'], en['chat.stop']]);
    await pause.click();
    t.truthy('pressed, it turns into "Continue" at once', await appears(resume, 1_000), await page.locator('.cs-compose').textContent());
    t.truthy('the conversation says it is paused', await appears(page.locator('.cs-paused'), 5_000), null);
    t.check('the server holds it', (await h.call<{ paused?: boolean }>('GET', `/sessions/${threadId}`)).paused, true);
    t.truthy('and the status bar says so', await appears(page.locator('.wb-statusbar .wb-paused'), 10_000), await page.locator('.wb-statusbar').textContent());
    answer();
    await waitFor('the reply to be held before its command', async () => (await h.call<Array<{ type: string }>>('GET', `/sessions/${threadId}/events`)).some((e) => e.type === 'task-paused'), 15_000).catch(() => undefined);
    t.check('its command does not run while paused', existsSync(join(h.repo, 'later.txt')), false);
    await resume.click();
    await page.locator('.cs-body').getByText('I wrote later.txt holding the word later and read it back to check that it is there.').waitFor({ timeout: 30_000 });
    t.check('"Continue": the work went on to its end', readFileSync(join(h.repo, 'later.txt'), 'utf8').trim(), 'later');
    await waitFor('the buttons to go', async () => (await pause.count()) + (await resume.count()) === 0, 10_000).catch(() => undefined);
    t.check('ended: neither button is left, nor the note', [await pause.count(), await resume.count(), await page.locator('.cs-paused').count()], [0, 0, 0]);
  });

  /*
   * The controls under the chat's box and on a message (2026-10-20): the arrow of a drop-down sits after its text,
   * not on it; a long ending has "Copy" under it too, a short one only beside it.
   */
  await scenario('the chat\'s drop-downs keep their arrow off the text, and a long ending has "Copy" under it too', {}, async (h, page, url) => {
    const long = Array.from({ length: 14 }, (_, i) => `Sentence ${i + 1} of what was done, which goes on for a while so the ending is long.`).join('\n\n');
    const { threadId } = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Do a long thing.', model: 'Think deeper' });
    h.chat.script(reply.steps('Get-ChildItem -Name'), reply.done(long));
    t.check('it runs', (await h.call<{ started: boolean }>('POST', `/sessions/${threadId}/start`, { mode: 'unattended' })).started, true);
    await h.idle();
    await h.call('POST', '/chat', { text: 'And a short one.', threadId });
    h.chat.script(reply.steps('Get-ChildItem -Name'), reply.done());
    await h.call('POST', `/sessions/${threadId}/start`, { mode: 'unattended' });
    await h.idle();
    await page.goto(url('/'));
    await page.evaluate((id) => localStorage.setItem('cop.chat.thread', id), threadId);
    await page.reload();
    const ends = page.locator('.cs-end');
    await ends.nth(1).waitFor();
    const copies = async (i: number): Promise<number> => await ends.nth(i).getByRole('button', { name: en['chat.copySummary']!, exact: true }).count();
    await waitFor('the long ending to be measured', async () => (await copies(0)) === 2, 5_000).catch(() => undefined);
    t.check('a long ending: "Copy" beside it and under it; a short one: beside it only', [await copies(0), await copies(1)], [2, 1]);
    for (const id of ['cs-model', 'cs-mode', 'cs-thread']) {
      const room = await page.locator(`#${id}`).evaluate((el) => {
        const s = getComputedStyle(el);
        return { right: parseFloat(s.paddingRight), arrowAt: parseFloat(s.backgroundPositionX) || 0 };
      });
      t.truthy(`#${id}: room on the right for its arrow`, room.right >= 22, room);
    }
  });

  /*
   * Bulgarian: chosen from the nav, said to the browser as lang="bg" for screen readers, remembered
   * across a reload, and — being longer than English almost everywhere — still fitting on a phone.
   */
  await scenario('in Bulgarian: chosen, remembered, and no page scrolls sideways on a phone', {}, async (h, page, url) => {
    const sent = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create hello.txt holding hi.', model: 'Think deeper' });
    h.chat.script(reply.steps(write('hello.txt', 'hi')), reply.done());
    await h.run(sent.threadId);
    await page.goto(url('/defaults'));
    const sessionsLink = page.locator('nav a[href="/defaults"]');
    await sessionsLink.waitFor();
    await page.locator('nav select').selectOption({ label: 'Български' });
    const lang = async (): Promise<[string, string]> => [((await sessionsLink.textContent()) ?? '').trim(), await page.evaluate(() => document.documentElement.lang)];
    await waitFor('the nav in Bulgarian', async () => (await lang())[0] === bg['nav.defaults'], 5_000).catch(() => undefined);
    t.check('the nav speaks Bulgarian and the page says lang="bg"', await lang(), [bg['nav.defaults'], 'bg']);
    await page.reload();
    await waitFor('the language to come back', async () => (await lang())[1] === 'bg', 5_000).catch(() => undefined);
    t.check('both survive a reload', await lang(), [bg['nav.defaults'], 'bg']);

    await page.setViewportSize({ width: 360, height: 780 });
    await page.evaluate((id) => localStorage.setItem('cop.chat.thread', id), sent.threadId);
    const pages = ['/', '/defaults', '/presets', '/level1', '/appearance', '/system'];
    const wide: Record<string, number> = {};
    for (const size of ['normal', 'giant']) {
      await page.evaluate((textSize) => localStorage.setItem('cop.appearance', JSON.stringify({ textSize })), size);
      for (const p of pages) {
        await page.goto(url(p));
        await page.waitForLoadState('networkidle');
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (over > 1) wide[`${size} ${p}`] = over;
      }
    }
    t.check('in Bulgarian, pages wider than a phone screen (pixels too wide)', wide, {});
    t.check('and it was Bulgarian throughout', await page.evaluate(() => document.documentElement.lang), 'bg');
  });

  /*
   * The changes view, by keyboard only once it is open: n walks the changes and marks the one it is on,
   * ] moves to the next file, a folded stretch opens on a click, Escape closes and puts the focus back
   * on the button that opened it.
   */
  await scenario('the changes of a message, by keyboard: n, ], a folded stretch, Escape; its buttons in pairs', {}, async (h, page, url) => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(h.repo, 'a-lines.txt'), `${lines.join('\r\n')}\r\n`);
    h.git('add', '-A');
    h.git('commit', '-q', '-m', 'sixty lines');
    const sent = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Change line 10 and line 50 of a-lines.txt, and create b-new.txt.', model: 'Think deeper' });
    h.chat.script(
      reply.steps(
        "$l = Get-Content a-lines.txt; $l[9] = 'line 10 changed'; $l[49] = 'line 50 changed'; Set-Content -Path a-lines.txt -Value $l -Encoding utf8",
        write('b-new.txt', 'brand new'),
      ),
      reply.done(),
    );
    const ran = (await h.run(sent.threadId)).tasks[0] as Card;
    t.check('done, both files on its record', [ran.status, (ran.vcs?.files ?? []).map((f) => f.path).sort()], ['done', ['a-lines.txt', 'b-new.txt']]);

    await page.goto(url('/'));
    await page.evaluate((id) => localStorage.setItem('cop.chat.thread', id), sent.threadId);
    await page.reload();
    const row = page.locator('.cs-turn').first();
    await row.getByRole('button', { name: /See the changes \(2 file\(s\)\)/ }).click();
    const view = page.getByRole('dialog');
    await view.locator('tr.diff-row').first().waitFor();
    const counter = async (): Promise<string> => ((await view.locator('thead .diff-where').textContent()) ?? '').trim();
    t.check('two changes, none chosen yet, said right above "Before" and "After"', await counter(), 'change – of 2');
    const where = await view.locator('thead tr').evaluateAll((trs) => trs.map((tr) => tr.textContent?.trim() ?? ''));
    t.check('the counter is the heading\'s first row, over "Before" and "After"', [where[0], where[1]], ['change – of 2', `${en['diff.before']}${en['diff.after']}`]);
    // In pairs that keep together (2026-10-20): each pair on one line while the view has the room.
    const top = async (name: string): Promise<number> => Math.round((await view.getByRole('button', { name, exact: true }).boundingBox())!.y);
    const topOf = async (text: string): Promise<number> => Math.round((await view.locator('label.option-inline', { hasText: text }).boundingBox())!.y);
    t.check('"Previous change" and "Next change" on one line', (await top(en['diff.prevChange']!)) === (await top(en['diff.nextChange']!)), true);
    t.check('"Show the whole file" and "Wrap long lines" on one line', (await topOf(en['diff.whole']!)) === (await topOf(en['diff.wrap']!)), true);
    await page.keyboard.press('n');
    await page.keyboard.press('n');
    t.check('n twice: change 2 of 2', (await counter()).toLowerCase(), 'change 2 of 2');
    const current = view.locator('tr.diff-row.current');
    t.check('one row is marked as the current change, the second one', [await current.count(), ((await current.textContent()) ?? '').includes('line 50 changed')], [1, true]);
    const inView = await waitFor('the current change to be scrolled into view', async () =>
      page.evaluate(() => {
        const r = document.querySelector('tr.diff-row.current')?.getBoundingClientRect();
        const b = document.querySelector('.diff-scroll')?.getBoundingClientRect();
        return !!r && !!b && r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
      }), 5_000).catch(() => false);
    t.check('and it is visible in the scrolled pane', inView, true);

    const middle = view.locator('td.code.l').filter({ hasText: /^line 30$/ });
    t.check('line 30 is folded away at first', await middle.count(), 0);
    const gaps = await view.locator('tr.diff-gap button').allTextContents();
    const widest = gaps.map((g) => Number(g.match(/(\d+)/)?.[1] ?? 0)).reduce((a, b) => Math.max(a, b), 0);
    await view.locator('tr.diff-gap button', { hasText: new RegExp(`\\b${widest} unchanged`) }).click();
    await middle.first().waitFor({ timeout: 5_000 }).catch(() => undefined);
    t.check('clicking the fold between the changes shows its lines', await middle.count(), 1);

    await page.keyboard.press(']');
    t.truthy('] selects the second file', ((await view.locator('.diff-file.on').textContent()) ?? '').includes('b-new.txt') && (await view.locator('.diff-name').textContent()) === 'b-new.txt', await view.locator('.diff-file.on').textContent());
    await page.keyboard.press('Escape');
    await view.waitFor({ state: 'detached' });
    t.truthy('Escape closes it and the focus is back on "See the changes"', /^See the changes/.test((await page.evaluate(() => document.activeElement?.textContent?.trim())) ?? ''), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200)));
  });
} finally {
  await browser?.close();
}

t.finish();
