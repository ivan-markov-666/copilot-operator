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
 * - the appearance menu in the bar on top: System, light and dark, A− and A+, night light and the reading aids;
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
import { LANGUAGES } from '../web/lib/lang/languages.js';
import { RIGHT_TO_LEFT } from '../web/lib/themeScript.js';

const t = new Tally();
const root = join(import.meta.dirname, '..');
const webDir = join(root, 'dist', 'web');
const shots = process.env.COP_UI_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const en = dict.en as Record<string, string>;
const bg = dict.bg as Record<string, string>;

/*
 * The editor of a file is VS Code's (Monaco, 2026-10-22), whose text is not in a textarea of the page: read through
 * the editor itself, which its element carries as `copEditor` (web/app/workbench/codeEditor.tsx).
 */
type MonacoLike = { getValue(): string; getSelection(): { positionLineNumber: number } | null; getModel(): { getValueInRange(r: unknown): string } | null };
/** The text of the editor shown in `scope`, once it is ready. */
async function editorText(scope: Locator): Promise<string> {
  const host = scope.locator('.ed-monaco[data-ready]');
  await host.waitFor({ timeout: 30_000 });
  return await host.evaluate((el) => (el as unknown as { copEditor: MonacoLike }).copEditor.getValue());
}
/** Where its cursor is: the line, and the text chosen. */
async function editorCursor(scope: Locator): Promise<{ line: number; chosen: string }> {
  const host = scope.locator('.ed-monaco[data-ready]');
  await host.waitFor({ timeout: 30_000 });
  return await host.evaluate((el) => {
    const e = (el as unknown as { copEditor: MonacoLike }).copEditor;
    const s = e.getSelection();
    return { line: s?.positionLineNumber ?? 0, chosen: s ? (e.getModel()?.getValueInRange(s) ?? '') : '' };
  });
}

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

console.log('\n--- languages: every one has English\'s keys and placeholders, and "Language" stays in English ---');
{
  const holes = (text: string): string => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',');
  const codes = LANGUAGES.map((l) => l.code);
  t.check('every language of the list has its dictionary', codes.filter((c) => !(c in dict)), []);
  t.check('and nine of them (2026-10-20)', codes, ['en', 'bg', 'de', 'es', 'fr', 'pt', 'ja', 'ko', 'ar']);
  // The script that turns the page before its first paint keeps its own list; it must be the registry's.
  t.check('the pre-paint script\'s right-to-left languages are the registry\'s', RIGHT_TO_LEFT, LANGUAGES.filter((l) => l.dir === 'rtl').map((l) => l.code));
  for (const code of codes.filter((c) => c !== 'en')) {
    const other = (dict as unknown as Record<string, Record<string, string>>)[code] ?? {};
    const missing = Object.keys(en).filter((k) => !(k in other));
    const extra = Object.keys(other).filter((k) => !(k in en));
    const differ = Object.keys(en).filter((k) => k in other && holes(en[k]!) !== holes(other[k]!)).map((k) => `${k}: en {${holes(en[k]!)}} ${code} {${holes(other[k]!)}}`);
    const empty = Object.keys(other).filter((k) => !(other[k] ?? '').trim());
    t.check(`${code}: keys missing, keys extra, placeholders that differ, texts left empty`, [missing, extra, differ, empty], [[], [], [], []]);
    t.check(`${code}: "Language" is "Language"`, other['lang.label'], 'Language');
  }
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
  /*
   * The chat's "Review" off, as the box remembers it, in every scenario but the one about it: a review is a
   * conversation of its own with replies of its own, and a scenario about something else scripts none for it.
   */
  if (!title.includes('REVIEW')) await context.addInitScript(() => {
    try {
      if (localStorage.getItem('cop.chat.review') === null) localStorage.setItem('cop.chat.review', 'off');
    } catch {
      /* no storage: the box is on, and the scenario says so by failing */
    }
  });
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
    await page.goto(url('/settings'));
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
    await page.goto(url('/system'));
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
    await page.goto(url('/settings'));
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
    await page.goto(url('/settings'));
    const fetchSel = page.locator('#network-fetch');
    await waitFor('the settings to load', async () => !(await fetchSel.isDisabled()), 10_000);
    // Chosen after the page read the settings, as another section or another tab would.
    await h.call('PUT', '/models/default', { model: 'Think deeper' });
    await fetchSel.selectOption('refuse');
    /*
     * How commands run is chosen here only (operator, 2026-10-23: the chat's menu removed): running without asking is
     * confirmed first, and "Cancel" keeps asking before each command.
     */
    await page.locator('#start-mode').selectOption('unattended');
    const sure = page.getByRole('alertdialog');
    await sure.waitFor({ timeout: 5_000 });
    t.truthy('running commands without asking is confirmed first', ((await sure.textContent()) ?? '').includes(en['exec.modeAutoConfirm']!.split('.')[0]!), await sure.textContent());
    await sure.getByRole('button', { name: en['dialog.cancel']!, exact: true }).click();
    await sure.waitFor({ state: 'detached' });
    t.check('"Cancel": it still asks before each command, and nothing is saved', [await page.locator('#start-mode').inputValue(), (await settingsOf(h)).execution?.mode === 'unattended'], ['confirm', false]);
    await page.locator('#start-mode').selectOption('unattended');
    await page.getByRole('alertdialog').getByRole('button', { name: 'OK' }).click();
    // The bot's questions (2026-10-23): agreeing with what it proposes is confirmed too, and "Cancel" keeps asking.
    t.check('"Questions from the bot": "Ask me" by default', await page.locator('#questions').inputValue(), 'ask');
    await page.locator('#questions').selectOption('agree');
    const agreeing = page.getByRole('alertdialog');
    await agreeing.waitFor({ timeout: 5_000 });
    t.truthy('agreeing with what the bot proposes is confirmed first', ((await agreeing.textContent()) ?? '').includes(en['exec.questionsAgreeConfirm']!.split('.')[0]!), await agreeing.textContent());
    await agreeing.getByRole('button', { name: en['dialog.cancel']!, exact: true }).click();
    await agreeing.waitFor({ state: 'detached' });
    t.check('"Cancel": it still asks', [await page.locator('#questions').inputValue(), (await settingsOf(h)).execution?.questions === 'agree'], ['ask', false]);
    await page.locator('#questions').selectOption('agree');
    await page.getByRole('alertdialog').getByRole('button', { name: 'OK' }).click();
    await waitFor('agreeing to be saved', async () => ((await settingsOf(h)).execution?.questions === 'agree' ? true : null), 10_000).catch(() => undefined);
    t.check('"OK": saved', (await settingsOf(h)).execution?.questions, 'agree');
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

    // A subtask cut off, with two chats (2026-10-25): "Ask me", 2 and 15 at first; at most 3; the three kept in `limits`.
    t.check('"Retrying an interrupted subtask": Ask me, 2 and 15 at first', [await page.locator('#subtask-retry-mode').inputValue(), await page.locator('#subtask-retries').inputValue(), await page.locator('#subtask-retry-wait').inputValue()], ['ask', '2', '15']);
    await page.locator('#subtask-retry-mode').selectOption('fresh');
    const subRetries = page.locator('#subtask-retries');
    await subRetries.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('9');
    await page.keyboard.press('Tab');
    t.check('at most 3 technical retries: 9 becomes 3 when left', await subRetries.inputValue(), '3');
    const subWait = page.locator('#subtask-retry-wait');
    await subWait.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('30');
    await page.keyboard.press('Tab');
    const kept = await waitFor('the three to be saved', async () => {
      const l = (await settingsOf(h)).limits ?? {};
      return l.subtaskRetryMode === 'fresh' && l.subtaskRetries === 3 && l.subtaskRetryWaitSec === 30 ? l : null;
    }, 10_000).catch(async () => (await settingsOf(h)).limits ?? {});
    t.check('saved in limits', [kept.subtaskRetryMode, kept.subtaskRetries, kept.subtaskRetryWaitSec], ['fresh', 3, 30]);

    const retries = page.locator('#retry-blocked');
    await retries.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('3');
    // Straight to another page, inside the pause before the save.
    await page.locator('nav a[href="/system"]').click();
    await waitFor('the System page', async () => new URL(page.url()).pathname === '/system', 10_000);
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
    // How commands run is Settings' alone (2026-10-23): the chat has no menu for it, and runs as Settings say (here without asking).
    t.check('no menu for how commands run under the chat', await page.locator('#cs-mode').count(), 0);
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
    t.check('the changed file opens in the editor, as it is on disk', (await editorText(editor)).trim(), 'hi');
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
   * "On this branch" (operator, 2026-10-22: "show all the files changed on this branch, as a pull request does, not
   * only the ones not committed; and of them, which are not committed yet"): against main, the branch's files committed
   * and not, a dot on the ones not committed, a filter, a file opening as the pull request shows it, the branch's
   * commits marked with a line where it began; another base chosen and kept.
   */
  await scenario('the Git view, "On this branch": every file the branch changed as a pull request shows it, the ones not committed marked', {}, async (h, page, url) => {
    const initial = h.git('rev-parse', '--short=7', 'HEAD');
    h.git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(h.repo, 'feat.txt'), 'a\n', 'utf8');
    h.git('add', 'feat.txt');
    h.git('-c', 'user.name=op', '-c', 'user.email=op@example.com', 'commit', '-q', '-m', 'feature work');
    h.git('branch', 'other');
    writeFileSync(join(h.repo, 'feat.txt'), 'a\nb\n', 'utf8');
    writeFileSync(join(h.repo, 'loose.txt'), 'loose\n', 'utf8');
    await page.goto(url('/'));
    await page.getByRole('button', { name: en['wb.viewCommits']!, exact: true }).click();
    const side = page.locator('.wb-side');
    const branch = side.locator('.wb-branch');
    await branch.locator('.wb-git-files li').nth(1).waitFor({ timeout: 15_000 });
    const rows = async (): Promise<string[][]> =>
      await branch.locator('.wb-git-files li').evaluateAll((els) => els.map((li) => [li.querySelector('.wb-row-name')?.textContent ?? '', li.querySelector('.wb-git-status')?.textContent ?? '', li.querySelector('.wb-uncommitted')?.className ?? '']));
    t.check(
      'against main: the branch\'s files, committed and not, a dot on the ones not committed',
      [await side.locator('#wb-branch-base').inputValue(), await branch.locator('.wb-branch-counts > span').allTextContents(), await rows()],
      ['main', [en['git.branchCounts']!.replace('{ahead}', '1').replace('{behind}', '0'), `${en['git.branchFiles']!.replace('{files}', '2')} · +3 −0`], [['feat.txt', 'A', 'wb-uncommitted u-changes'], ['loose.txt', 'A', 'wb-uncommitted u-untracked']]],
    );
    const filter = branch.getByRole('tablist', { name: en['git.filter']! });
    await filter.getByRole('tab', { name: en['git.filterCommitted']!.replace('{n}', '1') }).click();
    t.check('"Committed": the one in a commit of the branch', (await rows()).map((r) => r[0]), ['feat.txt']);
    await filter.getByRole('tab', { name: en['git.filterUncommitted']!.replace('{n}', '2') }).click();
    t.check('"Not committed": the two with something not committed', (await rows()).map((r) => r[0]), ['feat.txt', 'loose.txt']);
    await filter.getByRole('tab', { name: en['git.filterAll']!.replace('{n}', '2') }).click();

    await branch.locator('.wb-git-files li').first().getByRole('button').click();
    await page.getByRole('tablist', { name: en['wb.openTabs']! }).getByRole('tab', { name: 'feat.txt (⎇ main)' }).waitFor();
    await page.locator('.wb-gitdiff .diff-row').first().waitFor();
    t.check(
      'a file opens as the pull request shows it: nothing where the branch began, all of it as it is now',
      await page.locator('.wb-gitdiff .diff-row').evaluateAll((trs) => trs.map((tr) => [tr.querySelector('.code.l')?.textContent ?? '', tr.querySelector('.code.r')?.textContent ?? ''])),
      [['', 'a'], ['', 'b']],
    );
    const commits = side.locator('.wb-commits > li');
    t.check(
      'the branch\'s own commit marked, and a line where it left main',
      [await commits.evaluateAll((lis) => lis.map((li) => [li.querySelector('.wb-row-name')?.textContent ?? '', li.classList.contains('on-branch')])), ((await side.locator('.wb-branch-start').textContent()) ?? '').trim()],
      [[['feature work', true], ['initial', false]], en['git.branchStart']!.replace('{base}', 'main').replace('{sha}', initial)],
    );

    await side.locator('#wb-branch-base').selectOption('other');
    const against = en['git.branchCounts']!.replace('{ahead}', '0').replace('{behind}', '0');
    await waitFor('the counts against "other"', async () => (await branch.locator('.wb-branch-ahead').textContent()) === against, 10_000).catch(() => undefined);
    t.check('against another branch: only what is not committed is new to it', await branch.locator('.wb-branch-counts > span').allTextContents(), [against, `${en['git.branchFiles']!.replace('{files}', '2')} · +2 −0`]);
    await page.reload();
    await page.getByRole('button', { name: en['wb.viewCommits']!, exact: true }).click();
    await side.locator('#wb-branch-base').waitFor();
    await waitFor('the base to be read', async () => (await side.locator('#wb-branch-base').inputValue()) === 'other', 10_000).catch(() => undefined);
    t.check('the base chosen is kept for the folder', await side.locator('#wb-branch-base').inputValue(), 'other');
    t.check('reading it changed nothing in the repository', h.git('status', '--porcelain').split('\n').map((l) => l.trim()).sort(), ['?? loose.txt', 'M feat.txt']);
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
   * System (2026-10-22): no Desktop row; whose Edge has the profile, said by whose it is — the chat's own window, kept
   * open between messages, was shown as "a run would fail; close that window"; and the bot's folder, chosen there for
   * the next start. The API under the check is a clone, which keeps its records in the clone, so the page is shown an
   * installed copy's report; what the API does with the choice is release.check's and package.check's.
   */
  await scenario("System: the bot's folder chosen for the next start, whose Edge has the profile, and no Desktop", {}, async (h, page, url) => {
    const fill = (key: string, vars: Record<string, string | number>): string => en[key]!.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
    const real = await h.call<Record<string, unknown>>('GET', '/doctor');
    const home = 'C:\\Users\\op\\AppData\\Local\\copilot-operator';
    let report: Record<string, unknown> = {
      ...real,
      install: 'package',
      home,
      homeFrom: 'default',
      homeDefault: home,
      homeNext: home,
      homeMovedFrom: { from: 'C:\\.copilot-operator', at: '2026-10-22T07:00:00.000Z', stillThere: true },
      profileDir: `${home}\\edge-profile`,
      profileExists: true,
      profileHolder: 'own-window',
      profileHeldBy: [101, 102, 103],
      folderDialog: true,
    };
    const puts: Array<{ dir: string | null; copy: boolean }> = [];
    await page.route('**/api/doctor', (r) => r.fulfill({ json: report }));
    await page.route('**/api/home', async (r) => {
      const body = r.request().postDataJSON() as { dir: string | null; copy: boolean };
      puts.push(body);
      report = { ...report, homeNext: body.dir ?? home };
      await r.fulfill({ json: { home: body.dir ?? home, copied: body.copy ? ['data', 'edge-profile'] : [], kept: [], restart: true } });
    });
    await page.route('**/api/browse-folder', (r) => r.fulfill({ json: { ok: true, path: 'D:\\bot' } }));

    await page.goto(url('/system'));
    const row = page.locator('tr.sys-home');
    await row.waitFor();
    t.check('no Desktop on the page any more', (await page.locator('th').allTextContents()).filter((x) => /desktop/i.test(x)), []);
    t.check("the bot's folder, by default", [await row.locator('.sys-home-dir').textContent(), await row.locator('.badge').textContent()], [home, en['sys.homeFromDefault']]);
    t.truthy('where its records were copied from, for the operator to delete', ((await row.locator('.sys-home-moved').textContent()) ?? '').includes('C:\\.copilot-operator'), await row.textContent());
    // When, in the page's language (English's dates are en-GB), not the browser's: it read 10/22/2026 on a Bulgarian page.
    const when = await page.evaluate(() => new Date('2026-10-22T07:00:00.000Z').toLocaleString('en-GB', { hour12: false }));
    t.truthy("and when, as the page's language writes dates", ((await row.locator('.sys-home-moved').textContent()) ?? '').includes(when), `${when} in ${await row.locator('.sys-home-moved').textContent()}`);
    const use = page.locator('tr.sys-profile-use td');
    t.check("the chat's own window is said as the bot's own, nothing to close", [await use.textContent(), await use.locator('.err').count()], [fill('sys.profileOwnWindow', { n: 3 }), 0]);
    t.check('no "Back to the default" while the default is used', await row.locator('.sys-home-reset').count(), 0);

    await row.getByRole('button', { name: en['sys.homeChange']!, exact: true }).click();
    const ask = row.locator('.sys-home-ask');
    await ask.waitFor();
    t.check('Change… asks, starting from the folder in use', await ask.locator('input.sys-home-input').inputValue(), home);
    await ask.getByRole('button', { name: en['mirror.browse']!, exact: true }).click();
    await waitFor('the picked folder in the field', async () => (await ask.locator('input.sys-home-input').inputValue()) === 'D:\\bot', 10_000);
    t.check('copying what is there is offered, and on', await ask.locator('input.sys-home-copy').isChecked(), true);
    t.truthy('the question names the folder', ((await ask.textContent()) ?? '').includes(fill('sys.homeAsk', { dir: 'D:\\bot' })), await ask.textContent());
    await ask.getByRole('button', { name: en['sys.homeUse']!, exact: true }).click();
    await row.locator('.sys-home-saved').waitFor();
    t.check('Use this folder sends the folder, with the copy', puts, [{ dir: 'D:\\bot', copy: true }]);
    t.check('and says to start the bot again', await row.locator('.sys-home-saved').textContent(), fill('sys.homeSaved', { dir: 'D:\\bot' }));
    await waitFor('the next start named', async () => (await row.locator('.sys-home-next').count()) === 1, 10_000);
    t.check('the row says which folder the next start uses, this one still in use', [await row.locator('.sys-home-next').textContent(), await row.locator('.sys-home-dir').textContent()], [fill('sys.homeNext', { dir: 'D:\\bot' }), home]);

    await row.getByRole('button', { name: en['sys.homeReset']!, exact: true }).click();
    t.check('Back to the default asks the same, for the default folder', await row.locator('input.sys-home-input').inputValue(), home);
    await row.locator('input.sys-home-copy').uncheck();
    await row.getByRole('button', { name: en['sys.homeUse']!, exact: true }).click();
    await waitFor('the default chosen', async () => puts.length === 2, 10_000);
    t.check('the default is sent as null, without the copy when it is off', puts[1], { dir: null, copy: false });
    await waitFor('the next-start note gone', async () => (await row.locator('.sys-home-next').count()) === 0, 10_000);

    // Everything the bot keeps, as one .zip (2026-10-23): offered here, its runs only when ticked.
    const exportLink = page.locator('a.sys-export-link');
    t.truthy('System offers an export of everything the bot keeps', /\/api\/home\/export(\?token=|$)/.test((await exportLink.getAttribute('href')) ?? ''), await exportLink.getAttribute('href'));
    await page.locator('#export-runs').check();
    t.truthy('with every run\'s records when ticked', ((await exportLink.getAttribute('href')) ?? '').includes('runs=1'), await exportLink.getAttribute('href'));

    // Another Edge, a run's own, and a look that failed: each said for what it is.
    for (const [holder, key, err] of [
      ['other', 'sys.profileHeld', 1],
      ['own-run', 'sys.profileBot', 0],
      ['unknown', 'sys.profileUnknown', 0],
      ['free', 'sys.profileFree', 0],
    ] as const) {
      report = { ...report, profileHolder: holder, profileHeldBy: holder === 'free' ? [] : holder === 'unknown' ? 'unknown' : [7, 8] };
      await page.reload();
      await use.waitFor();
      t.check(`whose Edge — ${holder}`, [await use.textContent(), await use.locator('.err').count()], [fill(key, { n: 2, pids: '7, 8' }), err]);
    }

    // COP_HOME and a clone: no Change…, and the badge says why.
    for (const [install, from, badge] of [['package', 'env', 'sys.homeFromEnv'], ['checkout', 'checkout', 'sys.homeFromCheckout']] as const) {
      report = { ...report, install, homeFrom: from, homeNext: null, homeDefault: install === 'package' ? home : null, homeMovedFrom: null };
      await page.reload();
      await row.waitFor();
      t.check(`set by ${from}: said, and not changed here`, [await row.locator('.badge').textContent(), await row.getByRole('button').count()], [en[badge], 0]);
    }
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
    t.check('the bar on top links the queue, Settings and System, and nothing of the sessions', await page.locator('.wb-menu a').allTextContents(), [en['nav.queue'], en['nav.defaults'], en['nav.system']]);
    t.check('no "Write in the chat", "Import a plan" or "Ask Kerrigan" on the home screen', await page.locator('.wb-welcome').getByRole('button').allTextContents(), [`${en['kerrigan.button']} ▾`, 'i']);
    // The tab's icon (2026-10-22): the aeroplane, named by the page and served with it.
    const iconHref = await page.locator('head link[rel="icon"]').first().getAttribute('href');
    t.truthy('the page names its icon, the aeroplane', !!iconHref && /icon\.svg/.test(iconHref), iconHref);
    const icon = await page.request.get(url(iconHref ?? '/icon.svg'));
    t.check('and it is served as an SVG', [icon.status(), (icon.headers()['content-type'] ?? '').split(';')[0]], [200, 'image/svg+xml']);
    t.truthy('the logo is beside the name in the bar on top', (await page.locator('.wb-brand svg.brand-logo').count()) === 1, await page.locator('.wb-brand').innerHTML());
    // What Kerrigan is, in the room under her button (operator, 2026-10-22: "short and clear; no empty space there").
    const aboutBox = page.locator('.wb-welcome .kerrigan-about');
    t.check('under her button: what Kerrigan is, and three things she is for', [await aboutBox.getByRole('heading').textContent(), await aboutBox.locator('li').count()], [en['kerrigan.aboutTitle'], 3]);
    const aboutText = (await aboutBox.textContent()) ?? '';
    t.truthy('and how to use her, by the names of her menu\'s items', aboutText.includes(`“${en['kerrigan.copy']}”`) && aboutText.includes(`“${en['kerrigan.save']}”`) && aboutText.includes(en['kerrigan.aboutNote']!), aboutText);
    t.check(
      'right under the button',
      await page.evaluate(() => document.querySelector('.wb-welcome .kerrigan-about')!.getBoundingClientRect().top >= document.querySelector('.wb-welcome .kerrigan')!.getBoundingClientRect().bottom - 1),
      true,
    );

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

    const chooseLanguage = async (native: RegExp): Promise<void> => {
      await page.getByRole('button', { name: 'Language', exact: true }).first().click();
      await page.getByRole('menuitemradio', { name: native }).click();
    };
    await chooseLanguage(/Български/);
    await page.getByRole('button', { name: bg['kerrigan.button']!, exact: true }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: bg['kerrigan.copy']! }).click();
    await page.getByRole('status').filter({ hasText: /Копирано/ }).waitFor();
    t.truthy('in Bulgarian, she is in Bulgarian', (await page.evaluate(() => navigator.clipboard.readText())).startsWith('# Кериган'), '');
    /*
     * In a language she is not written out in (German): her prose is English, and the names she quotes are the ones on
     * this screen, in German, filled in by the page (2026-10-20).
     */
    const de = (dict as unknown as Record<string, Record<string, string>>).de!;
    await chooseLanguage(/Deutsch/);
    await page.getByRole('button', { name: de['kerrigan.button']!, exact: true }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: de['kerrigan.copy']! }).click();
    await page.getByRole('status').filter({ hasText: de['kerrigan.copied']!.split('{')[0]!.trim().slice(0, 12) }).waitFor();
    const german = await page.evaluate(() => navigator.clipboard.readText());
    t.truthy('in German: the controls by their German names, none left unfilled', german.includes(`**"${de['chat.newChat']}"**`) && german.includes(`**"${de['chat.pause']}"**`) && !german.includes('⟦'), german.slice(0, 300));
    await chooseLanguage(/English/);

    await page.goto(url('/settings'));
    await page.locator('nav').first().waitFor();
    const navLinks = await page.locator('header nav a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    t.check('the other pages\' navigation has no Sessions, task register or plan from JSON', navLinks.filter((x) => x === '/sessions' || x === '/history' || x === '/import'), []);
    // The queue between the chat and Settings since 2026-10-24.
    t.check('the navigation: the chat, the queue, Settings and System, nothing else (2026-10-20; the queue 2026-10-24)', navLinks.filter((x) => x !== null), ['/', '/queue', '/settings', '/system']);
    t.check('the other pages have the logo beside the name too', await page.locator('header .brand-link svg.brand-logo').count(), 1);
    for (const gone of ['/sessions', '/history', '/import', '/level1', '/presets', '/appearance']) {
      const r = await page.request.get(url(gone));
      t.truthy(`${gone} is not a page any more`, r.status() === 404 || !(await r.text()).includes('<main'), r.status());
    }
  });

  /*
   * How the page looks, from the bar on top, between Settings and System (2026-10-21; it was the last icon on the left):
   * the theme — System by default, which follows the machine — Light and Dark; the text a step smaller or larger;
   * night light and the reading aids, the system's cursor among them.
   */
  await scenario('the appearance menu in the bar on top: System by default, light and dark, A− and A+, night light and the reading aids', {}, async (_h, page, url) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(url('/'));
    const html = (name: string): Promise<string | undefined> => page.evaluate((n) => document.documentElement.dataset[n], name);
    await page.getByRole('button', { name: en['wb.appearance']!, exact: true }).waitFor();
    const order = await page.locator('.wb-menu').evaluate((nav) => Array.from(nav.children).map((c) => (c.textContent ?? '').trim()));
    // System and Appearance swapped (operator, 2026-10-22): Settings, System, Appearance, then the language; the queue first (2026-10-24).
    t.check('in the bar on top, after the queue, Settings and System, with the language', [order.slice(0, 3), order[3]!.startsWith(en['nav.appearance']!) && order[3]!.includes('Language')], [[en['nav.queue'], en['nav.defaults'], en['nav.system']], true]);
    t.check('and no longer in the column of icons', await page.locator('.wb-activity').getByRole('button', { name: en['wb.appearance']!, exact: true }).count(), 0);
    // Cursors of the page's own, by the theme; the system's when asked for (2026-10-21).
    t.truthy('the page draws its own cursor', (await page.evaluate(() => getComputedStyle(document.body).cursor)).includes('url('), await page.evaluate(() => getComputedStyle(document.body).cursor));
    // Over what can be clicked, a hand, the fingertip its spot (operator, 2026-10-21: "a click hand"); elsewhere the
    // arrow, its tip the spot. Not the same picture in other colours.
    {
      const arrow = await page.evaluate(() => getComputedStyle(document.body).cursor);
      const hand = await page.getByRole('button', { name: en['wb.appearance']!, exact: true }).evaluate((b) => getComputedStyle(b).cursor);
      const shape = (c: string): string => c.replace(/%23[0-9a-f]{6}/gi, '');
      t.truthy('a hand over a button, the arrow elsewhere: two pictures, each with its spot', / 10 2, pointer$/.test(hand) && / 5 3, default$/.test(arrow) && shape(hand) !== shape(arrow), { hand: hand.slice(-30), arrow: arrow.slice(-30) });
    }
    t.check('nothing chosen: the theme is the machine\'s, here dark, before and after the page has loaded', await html('theme'), 'dark');
    await page.getByRole('button', { name: en['wb.appearance']!, exact: true }).click();
    const menu = page.getByRole('dialog', { name: en['wb.appearance']! });
    await menu.waitFor();
    const theme = (key: string) => menu.getByRole('button', { name: en[key]!, exact: true });
    t.check('System is the one pressed', await theme('theme.system').getAttribute('aria-pressed'), 'true');
    await theme('theme.light').click();
    t.check('Light: the page is light', await html('theme'), 'light');
    // The logo in the theme's colours (2026-10-22): dark blue on light; on dark, light with a sky-blue orbit.
    const logo = async (): Promise<string[]> => [
      await page.locator('.wb-brand .brand-plane').evaluate((p) => getComputedStyle(p).fill),
      await page.locator('.wb-brand ellipse').evaluate((e) => getComputedStyle(e).stroke),
    ];
    t.check('the logo beside the name, dark blue on light', await logo(), ['rgb(13, 42, 66)', 'rgb(13, 42, 66)']);
    await theme('theme.system').click();
    t.check('System again: dark, as the machine is', await html('theme'), 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await waitFor('the page to follow the machine', async () => (await html('theme')) === 'light', 5_000).catch(() => undefined);
    t.check('and it follows the machine when that changes', await html('theme'), 'light');
    await theme('theme.dark').click();
    t.check('Dark: dark whatever the machine', await html('theme'), 'dark');
    t.check('the logo on dark: the aeroplane light, its orbit sky blue', await logo(), ['rgb(227, 238, 249)', 'rgb(90, 182, 244)']);

    const larger = menu.getByRole('button', { name: en['ap.larger']!, exact: true });
    const smaller = menu.getByRole('button', { name: en['ap.smaller']!, exact: true });
    t.check('the A− and A+ buttons read so', [((await smaller.textContent()) ?? '').trim(), ((await larger.textContent()) ?? '').trim()], ['A−', 'A+']);
    await larger.click();
    await larger.click();
    t.check('A+ twice: two steps larger', await html('textsize'), 'huge');
    for (let i = 0; i < 6; i++) await smaller.click();
    t.check('A− six times: the smallest of the eight', [await html('textsize'), await smaller.isDisabled()], ['smallest', true]);

    const aid = (key: string) => menu.getByRole('checkbox', { name: en[key]! });
    await aid('ap.night').check();
    const veil = await page.evaluate(() => getComputedStyle(document.documentElement, '::after').getPropertyValue('content'));
    t.check('night light: on, a warm veil over the page', [await html('night'), veil !== 'none' && veil !== ''], ['on', true]);
    t.truthy('and the page is still pressed through it', await page.getByRole('button', { name: en['kerrigan.button']!, exact: true }).isEnabled(), '');
    await aid('ap.links').check();
    await aid('ap.motion').check();
    t.check('underlined links and less motion', [await html('links'), await html('motion')], ['underline', 'reduced']);
    const darkCursor = await page.evaluate(() => getComputedStyle(document.body).cursor);
    await aid('ap.systemCursor').check();
    t.check('the system\'s cursor: the page\'s own is put away', [await html('cursor'), await page.evaluate(() => getComputedStyle(document.body).cursor)], ['system', 'default']);
    await aid('ap.systemCursor').uncheck();
    await theme('theme.light').click();
    const lightCursor = await page.evaluate(() => getComputedStyle(document.body).cursor);
    t.truthy('and its own again, drawn for each theme', lightCursor.includes('url(') && darkCursor.includes('url(') && lightCursor !== darkCursor, { lightCursor: lightCursor.slice(0, 80), darkCursor: darkCursor.slice(0, 80) });
    await theme('theme.dark').click();
    await page.reload();
    t.check('kept in this browser, from before the first paint', [await html('theme'), await html('textsize'), await html('night'), await html('links')], ['dark', 'smallest', 'on', 'underline']);
    await page.getByRole('button', { name: en['wb.appearance']!, exact: true }).click();
    await page.getByRole('dialog', { name: en['wb.appearance']! }).getByRole('button', { name: en['ap.reset']! }).click();
    t.check('back to the defaults: the machine\'s theme, normal text, no veil', [await html('theme'), await html('textsize'), await html('night')], ['light', 'normal', 'off']);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: en['wb.appearance']! }).waitFor({ state: 'detached' });
    t.check('Escape closes the menu', true, true);
    t.check('it is not a link to Settings', await page.getByRole('button', { name: en['wb.appearance']!, exact: true }).evaluate((b) => b.tagName), 'BUTTON');

    // The Appearance page went (2026-10-20): the menu is where all of it is.
    await page.goto(url('/settings'));
    t.check('no page of its own in the navigation', await page.locator('nav a[href="/appearance"]').count(), 0);
    const pages = await page.locator('header nav').first().evaluate((nav) => Array.from(nav.children).map((c) => (c.textContent ?? '').trim()));
    // After System, Appearance and the language as one (2026-10-24).
    const pair = pages.findIndex((p) => p.startsWith(en['nav.appearance']!) && p.includes('Language'));
    t.truthy('on the other pages too, after System, with the language', pages.indexOf(en['nav.system']!) === pages.indexOf(en['nav.defaults']!) + 1 && pair === pages.indexOf(en['nav.system']!) + 1, pages);
    // The old address of Settings goes on to the new one, with its #part.
    await page.goto(url('/defaults#skills'));
    await page.waitForURL(/\/settings(\.html)?#skills$/, { timeout: 10_000 }).catch(() => undefined);
    t.truthy('/defaults goes on to /settings, its #part kept', /\/settings(\.html)?#skills$/.test(page.url()), page.url());
  });

  /*
   * The panels moved as in VS Code (operator, 2026-10-21: "the chat where 'Open a file from the explorer' is, and that
   * one where the chat was"): a grip dragged onto another panel swaps the two; its menu puts a panel in a place; the
   * order is kept; the palette puts it back.
   */
  await scenario('the panels: dragged onto another they swap, the grip\'s menu moves one, the order is kept, the palette puts it back', {}, async (_h, page, url) => {
    await page.goto(url('/'));
    await page.locator('.wb-chat .wb-grip').waitFor();
    const places = async (): Promise<string[]> =>
      await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('.wb-body > [data-area]'))
          .filter((e) => !e.hidden)
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
          .map((e) => e.dataset.area ?? ''),
      );
    t.check('as they start: the files, the editor, the chat', await places(), ['side', 'center', 'chat']);
    await page.locator('.wb-chat .wb-grip').dragTo(page.locator('.wb-center'));
    await waitFor('the two to swap', async () => (await places()).join() === 'side,chat,center', 5_000).catch(() => undefined);
    t.check('the chat dragged onto the editor: the two swap', await places(), ['side', 'chat', 'center']);
    const chatBox = await page.locator('.wb-chat').boundingBox();
    const editorBox = await page.locator('.wb-center').boundingBox();
    t.truthy('the middle takes what is left: the chat is now the wide one', !!chatBox && !!editorBox && chatBox.width > editorBox.width, { chatBox, editorBox });
    await page.reload();
    await page.locator('.wb-chat .wb-grip').waitFor();
    t.check('kept in this browser', await places(), ['side', 'chat', 'center']);
    await page.locator('.wb-side .wb-grip').click();
    const menu = page.getByRole('menu', { name: en['wb.move']!.replace('{name}', en['wb.explorer']!) });
    await menu.waitFor();
    t.check('the grip\'s menu: the three places, the one it is in not offered', [await menu.getByRole('menuitem').allTextContents(), await menu.getByRole('menuitem', { name: en['wb.moveLeft']! }).isDisabled()], [[en['wb.moveLeft'], en['wb.moveCenter'], en['wb.moveRight']], true]);
    await menu.getByRole('menuitem', { name: en['wb.moveRight']! }).click();
    await waitFor('the explorer to move right', async () => (await places()).at(-1) === 'side', 5_000).catch(() => undefined);
    t.check('"To the right": the files go right, and what was there takes their place', await places(), ['center', 'chat', 'side']);
    await page.keyboard.press('Control+k');
    await page.getByRole('option', { name: en['wb.cmdResetLayout']! }).or(page.getByRole('button', { name: en['wb.cmdResetLayout']! })).first().click();
    await waitFor('the panels to be put back', async () => (await places()).join() === 'side,center,chat', 5_000).catch(() => undefined);
    t.check('the palette puts them back where they were', await places(), ['side', 'center', 'chat']);
  });

  /*
   * What each setting is for (operator, 2026-10-21: "more information in the i of the Execution options; it must be clear
   * what each one is for; look at the other options too"): every ⓘ of Settings opens and says something; in Execution,
   * each number's says its default, and each list's names every one of its choices.
   */
  /*
   * The three models (operator, 2026-10-23): the worker's, the lead's, the review's — alike, each with the choices the
   * model for new conversations had, and its own "by hand"; and "Saving." "Saving.." "Saving..." under a section after
   * a change, where "saved as you type" was.
   */
  await scenario('Settings: the worker\'s, the lead\'s and the review\'s model alike, each its own "by hand", and "Saving..." after a change', {}, async (h, page, url) => {
    // The list read from the scripted chat, as "Read the list from Copilot" does.
    await h.call('POST', '/models/refresh');
    await page.goto(url('/settings'));
    const sections = ['model', 'lead-model', 'review'];
    await page.locator('section#lead-model select').waitFor();
    t.check('three sections, in order: the worker, the lead, the review', await page.locator('section.panel h2').evaluateAll((hs) => hs.map((x) => x.textContent ?? '')).then((all) => all.filter((x) => [en['def.modelTitle'], en['def.leadTitle'], en['def.reviewTitle']].includes(x))), [en['def.modelTitle'], en['def.leadTitle'], en['def.reviewTitle']]);
    const options = async (id: string): Promise<string[]> => await page.locator(`section#${id} select option`).allTextContents();
    const [worker, lead, review] = await Promise.all(sections.map(options));
    t.truthy('the same choices in each, the first leaving the chat as it is', JSON.stringify(worker) === JSON.stringify(lead) && JSON.stringify(lead) === JSON.stringify(review) && worker[0] === en['def.modelNone'], { worker, lead, review });
    const controls = async (id: string): Promise<string[]> => await page.locator(`section#${id} button:not(.info-btn)`).allTextContents();
    t.check('and the same buttons, the list\'s date, and a "by hand" of its own', [await controls('lead-model'), await controls('review'), await page.locator('section#lead-model .field-after').count(), await page.locator('section input[type="checkbox"][id^="manual-"]').count()], [await controls('model'), await controls('model'), 1, 3]);
    t.check('no "saved as you type" under any section', await page.getByText('saved as you type').count(), 0);

    await page.locator('section#lead-model select').selectOption('Think deeper');
    const note = page.locator('section#lead-model .saving');
    await note.waitFor({ timeout: 3_000 });
    const seen = new Set<string>();
    const until = Date.now() + 1_400;
    while (Date.now() < until) {
      const text = await note.textContent().catch(() => null);
      if (text) seen.add(text);
      await page.waitForTimeout(90);
    }
    t.check('"Saving" with its dots going one, two, three', [...seen].filter((x) => /^Saving\.{1,3}$/.test(x)).sort(), ['Saving.', 'Saving..', 'Saving...']);
    await waitFor('the lead\'s model saved', async () => ((await h.call<{ defaultLeadModel: string }>('GET', '/models')).defaultLeadModel === 'Think deeper' ? true : null), 10_000).catch(() => undefined);
    t.check("the lead's model saved, the worker's untouched", [(await h.call<{ defaultLeadModel: string; defaultModel: string }>('GET', '/models')).defaultLeadModel, (await h.call<{ defaultModel: string }>('GET', '/models')).defaultModel], ['Think deeper', '']);
    await note.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    t.check('and the dots go once it is saved', await note.count(), 0);

    // Each part's own "by hand" (the harness has the worker's off): the lead's ticked, the worker's left as it was.
    t.check("the lead's and the review's, not set, show the worker's", [await page.locator('#manual-model').isChecked(), await page.locator('#manual-lead-model').isChecked(), await page.locator('#manual-review-model').isChecked()], [false, false, false]);
    await page.locator('#manual-lead-model').check();
    await page.locator('section#lead-model .saving').waitFor({ timeout: 3_000 });
    await waitFor('the lead\'s by hand saved', async () => (((await settingsOf(h)).copilot as { leadManualModel?: boolean } | undefined)?.leadManualModel === true ? true : null), 10_000).catch(() => undefined);
    const copilot = ((await settingsOf(h)).copilot ?? {}) as { manualModel?: boolean; leadManualModel?: boolean; reviewManualModel?: boolean };
    t.check("a tick saves that part's alone, with \"Saving...\" under it", [copilot.leadManualModel, copilot.manualModel, copilot.reviewManualModel], [true, false, undefined]);
  });

  /*
   * The model menu's locators (operator, 2026-10-24: "an option in Settings to edit the general locators … help for each
   * value and how it can be found … an option to keep what the inspection finds"): five fields with their ⓘ and their
   * defaults shown; a locator checked as it is typed and not saved while something is wrong with it; a good one saved,
   * shown filled with a name from the list read; "Default" puts the default back; the step pictures saved as ticked.
   */
  await scenario("Settings: the model menu's locators, checked as typed, saved, put back to the default; the step pictures", {}, async (h, page, url) => {
    const { DefaultPickerLocators } = await import('../src/transport/locators.js');
    await h.call('POST', '/models/refresh');
    await page.goto(url('/settings'));
    const section = page.locator('section#picker-locators');
    await section.locator('#picker-model').waitFor();
    t.check('the section, after the three models', await page.locator('section.panel').evaluateAll((all) => all.map((s) => s.id).filter((id) => ['review', 'picker-locators', 'execution'].includes(id))), ['review', 'picker-locators', 'execution']);
    const fields = section.locator('input.picker-locator');
    t.check('five locators, in order, each with its ⓘ', [await fields.evaluateAll((els) => els.map((e) => e.id)), await section.locator('.picker-field .info-btn').count()], [
      ['picker-button', 'picker-rows', 'picker-model', 'picker-provider', 'picker-providerModel'], 5,
    ]);
    t.check('each empty, with its default shown in it', await fields.evaluateAll((els) => els.map((e) => [(e as HTMLInputElement).value, (e as HTMLInputElement).placeholder])), [
      ['', DefaultPickerLocators.button], ['', DefaultPickerLocators.rows], ['', DefaultPickerLocators.model], ['', DefaultPickerLocators.provider], ['', DefaultPickerLocators.providerModel],
    ]);
    // The list read from the scripted chat: Auto first, GPT's "GPT 5.6 Think deeper" in a provider.
    const noteOf = (id: string) => section.locator(`.picker-field:has(#${id}) .picker-note`);
    t.check('each template shown filled with a name from the list read', [await noteOf('picker-model').textContent(), await noteOf('picker-provider').textContent(), await noteOf('picker-providerModel').textContent()], [
      `${en['loc.isDefault']} ${en['loc.example'].replace('{name}', 'Auto')} //div[text()='Auto']/parent::span/parent::span/parent::div`,
      `${en['loc.isDefault']} ${en['loc.example'].replace('{name}', 'GPT')} //div[text()='GPT']/parent::span/parent::span/parent::div[contains(@aria-haspopup, 'menu')]`,
      `${en['loc.isDefault']} ${en['loc.example'].replace('{name}', 'GPT 5.6 Think deeper')} //div[text()='GPT 5.6 Think deeper']/parent::span/parent::span/parent::div[not(contains(@aria-haspopup, 'menu'))]`,
    ]);
    const saved = async (): Promise<Record<string, string> | undefined> => ((await settingsOf(h)).copilot as { pickerLocators?: Record<string, string> } | undefined)?.pickerLocators;
    const errorOf = (id: string) => section.locator(`.picker-field:has(#${id}) .err`);

    await page.locator('#picker-model').fill("//div[text()='{$model_name}']/parent:span");
    t.check('one colon for an axis: said at once', await errorOf('picker-model').textContent(), en['loc.twoColons'].split('{axis}').join('parent'));
    await page.locator('#picker-model').fill("//div[text()='Think deeper']/parent::span");
    t.check('no placeholder: said, with the one it needs', await errorOf('picker-model').textContent(), en['loc.noPlaceholder'].replace('{ph}', '{$model_name}'));
    await page.locator('#picker-model').fill("//div[text()='{$model_name}'");
    t.truthy('an XPath the browser cannot read: said', ((await errorOf('picker-model').textContent()) ?? '').startsWith(en['loc.badXPath'].replace('{msg}', '')), await errorOf('picker-model').textContent());
    await page.locator('#picker-button').fill('button[');
    t.truthy('a CSS selector the browser cannot read: said', ((await errorOf('picker-button').textContent()) ?? '').startsWith(en['loc.badCss'].replace('{msg}', '')), await errorOf('picker-button').textContent());
    await page.waitForTimeout(1_600);
    t.check('none of them saved', await saved(), undefined);

    await page.locator('#picker-button').fill('');
    await page.locator('#picker-model').fill("//b[text()='{$model_name}']/parent::li");
    t.check('a good one: no error, and shown filled', [await errorOf('picker-model').count(), await noteOf('picker-model').textContent()], [0, `${en['loc.example'].replace('{name}', 'Auto')} //b[text()='Auto']/parent::li`]);
    await waitFor('the locator saved', async () => ((await saved())?.model ? true : null), 10_000).catch(() => undefined);
    t.check('saved after the typing stops, the others left out', await saved(), { model: "//b[text()='{$model_name}']/parent::li" });
    await section.locator('.picker-field:has(#picker-model) button', { hasText: en['loc.default'] }).click();
    await waitFor('the default put back', async () => ((await saved()) === undefined ? true : null), 10_000).catch(() => undefined);
    t.check('"Default": the field empty, nothing saved for it', [await page.locator('#picker-model').inputValue(), await saved()], ['', undefined]);

    t.check('the step pictures: off by default', await page.locator('#picker-steps').isChecked(), false);
    await page.locator('#picker-steps').check();
    await waitFor('the step pictures saved', async () => (((await settingsOf(h)).copilot as { pickerSteps?: boolean } | undefined)?.pickerSteps === true ? true : null), 10_000).catch(() => undefined);
    const where = (await section.locator('.picker-dirs').textContent()) ?? '';
    t.check('ticked, saved; and where they are kept is said', [((await settingsOf(h)).copilot as { pickerSteps?: boolean }).pickerSteps, /_browser/.test(where) && /_models/.test(where)], [true, true]);
  });

  /*
   * The bars on top in narrow windows (operator, 2026-10-24: "the Queue button is not seen on the chat's page; see that
   * the navigation wraps well on small screens; Appearance and Language always on one line together, unless there is not
   * room for both"): every link and both buttons on screen at every width, wrapped rather than hidden or scrolled away,
   * the two buttons side by side, and no page wider than its window.
   */
  await scenario('the bars on top in narrow windows: every link on screen, Appearance and Language together', {}, async (_h, page, url) => {
    for (const lang of ['en', 'bg']) {
      await page.evaluate((l) => localStorage.setItem('cop.locale', l), lang).catch(() => undefined);
      for (const [path, bar] of [['/', '.wb-menu'], ['/settings', '.top nav']] as const) {
        await page.goto(url(path));
        await page.locator(`${bar} .nav-pair`).waitFor();
        for (const width of [360, 480, 640, 900, 1280]) {
          await page.setViewportSize({ width, height: 800 });
          await page.waitForTimeout(150);
          // Written inline: a named function in here is wrapped by the bundler in a helper the page does not have.
          const seen = await page.evaluate((sel) => {
            const nav = document.querySelector(sel)!;
            const parts = [...nav.querySelectorAll(':scope > a'), ...nav.querySelectorAll('.nav-pair > *')];
            const onScreen = parts.every((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().left >= -1 && el.getBoundingClientRect().right <= window.innerWidth + 1 && getComputedStyle(el).display !== 'none');
            const [a, b] = [...nav.querySelectorAll('.nav-pair > *')].map((el) => el.getBoundingClientRect());
            const room = nav.getBoundingClientRect().width >= a!.width + b!.width + 4;
            return { onScreen, together: !room || Math.abs(a!.top - b!.top) < 4, over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
          }, bar);
          t.check(`${lang} ${path} at ${width}px: every link and both buttons on screen, the two together, nothing wider than the window`, [seen.onScreen, seen.together, seen.over <= 1], [true, true, true]);
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  /*
   * The queue of tasks (operator, 2026-10-24): written on its page — what to do, its model, where it works, the earlier
   * tasks it depends on — then run; one that fails takes the one that depends on it with it, the rest are said as they
   * end, each with its chat to open; "Run again", editing and taking one out.
   */
  await scenario('the queue: tasks written with their model and what they depend on, run, one failed and the one after it skipped', { execution: { mode: 'unattended', isolation: 'none-accepted' }, copilot: { defaultModel: 'Auto' }, limits: { retryBlockedInFreshChat: 0 } }, async (h, page, url) => {
    await h.call('POST', '/models/refresh');
    await page.goto(url('/queue'));
    await page.locator('#queue-prompt').waitFor();
    t.check('"Queue" in the bar, after "Chat", and it is this page', [await page.locator('nav a').evaluateAll((as) => as.map((a) => a.textContent?.trim() ?? '').slice(0, 3)), await page.locator('nav a[aria-current="page"]').textContent()], [[en['nav.workbench'], en['nav.queue'], en['nav.defaults']], en['nav.queue']]);
    t.check('empty, said so; nothing to run', [await page.locator('#queue').getByText(en['q.empty']).count(), await page.getByRole('button', { name: en['q.run'] }).isDisabled()], [1, true]);

    // Nothing earlier to depend on: no "Depends on" at all (operator, 2026-10-24: its "no earlier task" said nothing).
    t.check('the first task: no "Depends on"', await page.locator('.queue-depends').count(), 0);
    // Two chats: the model is the lead's, the worker's own beside it, and no review of its own (the lead judges).
    await page.locator('#queue-lead').check();
    t.check('"Two chats": the lead\'s model, the worker\'s, and no review', [await page.locator('label[for="queue-model"]').textContent(), await page.locator('#queue-worker-model').count(), await page.locator('#queue-review').count()], [en['q.leadModel'], 1, 0]);
    await page.locator('#queue-lead').uncheck();
    t.check('one chat: the review, and its model while it is ticked', [await page.locator('#queue-review').isChecked(), await page.locator('#queue-review-model').count(), await page.locator('#queue-worker-model').count()], [true, 1, 0]);
    await page.locator('#queue-name').fill('Summary');
    await page.locator('#queue-prompt').fill('Find the old report and summarise it.');
    await page.locator('#queue-model').selectOption('Think deeper');
    await page.locator('#queue-review').uncheck();
    t.check('unticked, the review\'s model goes', await page.locator('#queue-review-model').count(), 0);
    await page.getByRole('button', { name: en['q.add'] }).click();
    await page.locator('.queue-item').first().waitFor();
    await page.locator('#queue-prompt').fill('Turn the summary into a slide.');
    await page.locator('#queue-lead').check();
    await page.locator('#queue-worker-model').selectOption('Think deeper');
    t.check('a second task: "Depends on" offers the first, by its name', await page.locator('.queue-dep').allTextContents(), ['#1 Summary']);
    await page.locator('.queue-dep input').first().check();
    await page.getByRole('button', { name: en['q.add'] }).click();
    await page.locator('.queue-item').nth(1).waitFor();
    const meta = await page.locator('.queue-item .queue-meta').allTextContents();
    t.check('two tasks, waiting; the first by its name, on its model; the second two chats, depending on the first', [
      await page.locator('.queue-item .queue-status').allTextContents(),
      await page.locator('.queue-item .queue-title').allTextContents(),
      meta[0]!.includes('Think deeper'),
      meta[1]!.includes(en['q.leadOn']) && meta[1]!.includes(en['q.workerIs'].replace('{model}', 'Think deeper')) && meta[1]!.includes(en['q.dependsOnList'].replace('{list}', '#1')),
    ], [[en['q.waiting'], en['q.waiting']], ['Summary', 'Turn the summary into a slide.'], true, true]);
    const saved = (await h.call<{ items: Array<Record<string, unknown>> }>('GET', '/queue')).items;
    t.check('kept as written: the name, two chats with the worker\'s model, no review', [saved[0]!.name, saved[0]!.review, saved[1]!.lead, saved[1]!.workerModel, saved[1]!.review], ['Summary', false, true, 'Think deeper', false]);
    t.check('the form empty again for the next', [await page.locator('#queue-prompt').inputValue(), await page.locator('#queue-name').inputValue()], ['', '']);

    // The picture: a dot a task, a thread from the first to the second, the names when asked for, one on pointing.
    const graph = page.locator('.queue-graph');
    t.check('the picture: two dots, numbered, and one thread between them', [await graph.locator('.qg-task').count(), await graph.locator('.qg-n').allTextContents(), await graph.locator('svg[role="img"] path.qg-thread').count()], [2, ['1', '2'], 1]);
    t.check('no names on it until asked for', await graph.locator('.qg-name').count(), 0);
    await graph.locator('.qg-task').first().hover();
    t.check('pointing at a dot: its number and name', ((await graph.locator('.qg-tip strong').textContent()) ?? '').replace(/\s+/g, ' ').trim(), '1. Summary');
    await page.mouse.move(0, 0);
    await graph.getByLabel(en['q.showNames']).check();
    t.check('"Show all names": every name under its dot', await graph.locator('.qg-name').allTextContents(), ['Summary', 'Turn the summa…']);

    // Editing a task: its words in the form, under its number; "Cancel" leaves it as it was.
    await page.locator('.queue-item').nth(1).getByRole('button', { name: en['q.edit'] }).click();
    t.check('"Edit": the task in the form, under its number', [await page.locator('#queue-add-title').textContent(), await page.locator('#queue-prompt').inputValue()], [en['q.editTitle'].replace('{n}', '2'), 'Turn the summary into a slide.']);
    await page.getByRole('button', { name: en['q.cancel'] }).click();

    h.chat.script(reply.steps('Get-ChildItem'), reply.blocked());
    await page.getByRole('button', { name: en['q.run'] }).click();
    await page.getByRole('button', { name: en['q.stop'] }).waitFor({ timeout: 10_000 }).catch(() => undefined);
    await waitFor('the queue to end', async () => ((await h.call<{ running: boolean }>('GET', '/queue')).running ? null : true), 60_000).catch(() => undefined);
    await page.getByRole('button', { name: en['q.run'] }).waitFor({ timeout: 15_000 });
    await page.locator('.queue-item.is-skipped').waitFor({ timeout: 15_000 });
    t.check('the first failed, the second skipped for it, and why', [await page.locator('.queue-item .queue-status').allTextContents(), await page.locator('.queue-item').nth(1).locator('.queue-why').textContent()], [
      [en['q.failed'], en['q.skipped']],
      'it depends on "Summary", which failed',
    ]);
    t.check('the one that ran has its chat to open; the skipped one none', [await page.locator('.queue-item').nth(0).getByRole('link', { name: en['q.openChat'] }).count(), await page.locator('.queue-item').nth(1).getByRole('link', { name: en['q.openChat'] }).count()], [1, 0]);
    t.check('said under the button', await page.locator('.queue-controls [role="status"]').textContent(), en['q.counts'].replace('{waiting}', '0').replace('{done}', '0').replace('{failed}', '2'));

    await page.locator('.queue-item').nth(1).getByRole('button', { name: en['q.again'] }).click();
    await page.locator('.queue-item.is-waiting').waitFor({ timeout: 5_000 });
    t.check('"Run again": the skipped one waits again', await page.locator('.queue-item .queue-status').allTextContents(), [en['q.failed'], en['q.waiting']]);
    await page.locator('.queue-item').nth(0).getByRole('button', { name: en['q.remove'] }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'OK' }).click();
    await waitFor('the first taken out', async () => ((await h.call<{ items: unknown[] }>('GET', '/queue')).items.length === 1 ? true : null), 10_000).catch(() => undefined);
    const left = (await h.call<{ items: Array<{ prompt: string; dependsOn: string[] }> }>('GET', '/queue')).items;
    t.check('"Remove": taken out, and the one that depended on it no longer does', left.map((x) => [x.prompt, x.dependsOn]), [['Turn the summary into a slide.', []]]);
    await page.locator('.queue-item').nth(1).waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    t.check('and the page agrees', await page.locator('.queue-item').count(), 1);
  });

  await scenario('Settings: every ⓘ says what its field is for; in Execution each number its default, each list all its choices', {}, async (h, page, url) => {
    await page.goto(url('/settings'));
    await page.locator('#execution input#max-iterations').waitFor();
    await page.locator('#gap-on').check();
    await page.locator('#gap-random').check();
    await page.locator('#gap-max').waitFor();
    /** The ⓘ of the field whose control has this id, opened: its text; closed again after. */
    const tipOf = async (id: string): Promise<string> => {
      const button = page.locator('.settings-field').filter({ has: page.locator(`[id="${id}"]`) }).locator('.info-btn').first();
      await button.click();
      const pop = page.locator('.info-pop');
      await pop.waitFor({ timeout: 3_000 });
      const text = ((await pop.textContent()) ?? '').trim();
      await button.click();
      await pop.waitFor({ state: 'detached', timeout: 3_000 }).catch(() => undefined);
      return text;
    };
    const defaults: Record<string, number> = { 'auto-continue': 3, 'min-approaches': 2, 'max-review-rounds': 2, 'retry-blocked': 2, 'max-iterations': 60, 'max-minutes': 240, 'max-subtasks': 20, 'reply-timeout': 900, 'max-message-chars': 120000, 'gap-sec': 60, 'gap-max': 90 };
    const noDefault: string[] = [];
    for (const [id, value] of Object.entries(defaults)) {
      const text = await tipOf(id);
      if (!new RegExp(`Default[^.:]*: ${value}\\b`).test(text)) noDefault.push(`${id}: ${text.slice(-80)}`);
    }
    t.check('each number of Execution says its default in its ⓘ', noDefault, []);
    const unnamed: string[] = [];
    for (const id of ['isolation', 'start-mode', 'network-fetch']) {
      const text = await tipOf(id);
      for (const label of await page.locator(`select#${id} option`).allTextContents()) {
        const head = label.split(' — ')[0]!.trim();
        if (!text.includes(head)) unnamed.push(`${id}: ${head}`);
      }
    }
    t.check('each list of Execution names every one of its choices in its ⓘ', unnamed, []);
    {
      const button = page.locator('.settings-field').filter({ has: page.locator('[id="network-fetch"]') }).locator('.info-btn').first();
      await button.click();
      const bold = await page.locator('.info-pop strong').allTextContents();
      await button.click();
      const heads = (await page.locator('select#network-fetch option').allTextContents()).map((l) => l.split(' — ')[0]!.trim());
      t.truthy('a choice that opens its paragraph is in bold', heads.every((x) => bold.includes(x)), { bold, heads });
    }
    const buttons = page.locator('main .info-btn');
    const thin: string[] = [];
    const n = await buttons.count();
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      await b.scrollIntoViewIfNeeded();
      await b.click();
      const pop = page.locator('.info-pop');
      await pop.waitFor({ timeout: 3_000 });
      const title = ((await pop.locator('.pop-title').textContent()) ?? '').trim();
      const body = ((await pop.textContent()) ?? '').replace(title, '').trim();
      if (body.length < 80) thin.push(`${title}: ${body}`);
      await b.click();
      await pop.waitFor({ state: 'detached', timeout: 3_000 }).catch(() => undefined);
    }
    t.truthy('every ⓘ on the page opens', n >= 25, n);
    t.check('and says more than a few words', thin, []);
  });

  /*
   * Skills (operator, 2026-10-21): written in Settings, chosen under the chat's box or with /its-name at the start of a
   * message; the message shows which; an unknown name is said, not sent.
   */
  await scenario('skills: written in Settings, chosen under the box or with /its-name, shown on the message', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h, page, url) => {
    await h.call('PUT', '/models/default', { model: 'Think deeper' });
    /*
     * The way there from the chat (operator, 2026-10-23): "+ Skills" beside the skills, with none yet too, opens
     * Settings at its skills, which light up for a moment to show where they are.
     */
    await page.goto(url('/'));
    const toSkills = page.getByRole('link', { name: en['chat.skillsLink']!, exact: true });
    await toSkills.waitFor();
    t.check('with no skill yet: no picker, but the way to add one', [await page.locator('#cs-skill').count(), await toSkills.getAttribute('title')], [0, en['chat.skillsLinkWhy']]);
    await toSkills.click();
    await waitFor('Settings at its skills', async () => new URL(page.url()).pathname === '/settings' || null, 10_000);
    const section = page.locator('section#skills');
    await waitFor('the skills to light up', async () => (await section.getAttribute('class'))?.includes('spotlight') || null, 10_000).catch(() => undefined);
    t.check('it opens Settings at its skills', [new URL(page.url()).pathname, new URL(page.url()).hash], ['/settings', '#skills']);
    t.check('which light up, are in view and have the focus', [
      ((await section.getAttribute('class')) ?? '').includes('spotlight'),
      await section.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; }),
      await section.evaluate((el) => document.activeElement === el),
    ], [true, true, true]);
    await waitFor('the light to go out', async () => !((await section.getAttribute('class')) ?? '').includes('spotlight') || null, 8_000).catch(() => undefined);
    t.check('for a moment only', ((await section.getAttribute('class')) ?? '').includes('spotlight'), false);
    const add = page.locator('.skill-new');
    await add.waitFor();
    await add.getByLabel(en['skills.name']!, { exact: true }).fill('new-test');
    await add.getByLabel(en['skills.description']!, { exact: true }).fill('Adding an automated test');
    // No limit to the instructions (operator, 2026-10-25): how many characters there are is said under them instead.
    const instructions = add.getByLabel(en['skills.text']!, { exact: true });
    const long = 'Keep each test to one behaviour. '.repeat(300);
    await instructions.fill(long);
    t.check(
      'the instructions take more than the 8 000 there were, and say how many there are',
      [await instructions.getAttribute('maxlength'), (await instructions.inputValue()).length, ((await add.locator('.skill-count').textContent()) ?? '').trim()],
      [null, long.length, en['skills.count']!.replace('{n}', long.length.toLocaleString('en'))],
    );
    await instructions.fill('Tests live in tests/e2e, one file per page.');
    await page.getByRole('button', { name: en['skills.add']!, exact: true }).click();
    await waitFor('the skill to be saved', async () => (await h.call<{ skills: Array<{ name: string }> }>('GET', '/skills')).skills.length === 1, 10_000).catch(() => undefined);
    t.check('added in Settings', (await h.call<{ skills: Array<{ name: string; text: string }> }>('GET', '/skills')).skills.map((k) => [k.name, k.text]), [['new-test', 'Tests live in tests/e2e, one file per page.']]);
    t.check('and listed there, the form empty again', [await page.locator('.skill-entry:not(.skill-new)').count(), await add.getByLabel(en['skills.name']!, { exact: true }).inputValue()], [1, '']);

    await page.goto(url('/'));
    const pick = page.locator('#cs-skill');
    await pick.waitFor();
    // By name alone (operator, 2026-10-23); what it is for on hover.
    t.check('under the chat\'s box: none, or the skill, by its name alone', await pick.locator('option').allTextContents(), [en['chat.skillNone'], '/new-test']);
    t.check('what it is for, on hover', await pick.locator('option').nth(1).getAttribute('title'), 'Adding an automated test');
    t.check('and beside it, still, the way to Settings', await page.getByRole('link', { name: en['chat.skillsLink']!, exact: true }).count(), 1);
    // Right beside the menu (operator, 2026-10-23: "closer to the Skills drop-down"), not at the far end of the line.
    const menuBox = await pick.boundingBox();
    const linkBox = await page.getByRole('link', { name: en['chat.skillsLink']!, exact: true }).boundingBox();
    t.truthy('"+ Skills" right after the menu', !!menuBox && !!linkBox && linkBox.x - (menuBox.x + menuBox.width) >= 0 && linkBox.x - (menuBox.x + menuBox.width) <= 12, { menuBox, linkBox });
    const input = page.getByRole('textbox', { name: en['chat.input']! });
    await input.fill('/nope do it');
    await input.press('Enter');
    await page.locator('.cs-system').getByText('/nope').waitFor({ timeout: 5_000 }).catch(() => undefined);
    t.truthy('an unknown name is said, with the ones there are, and nothing is sent', ((await page.locator('.cs-body').textContent()) ?? '').includes('/new-test') && h.chat.sent.length === 0, await page.locator('.cs-body').textContent());
    h.chat.script(reply.done('The test was added where the skill says; it passes, as its output shows.'));
    await input.fill('/new-test add a test for the login page');
    await input.press('Enter');
    await page.locator('.cs-skill-chip').waitFor({ timeout: 30_000 });
    t.check('the message shows its skill, and is the rest of what was typed', [((await page.locator('.cs-skill-chip').textContent()) ?? '').trim(), ((await page.locator('.cs-user').first().textContent()) ?? '').includes('add a test for the login page')], [en['chat.skillUsed']!.replace('{name}', 'new-test'), true]);
    await page.locator('.cs-end').waitFor({ timeout: 30_000 });
    t.truthy('and Copilot was given the skill with it', h.chat.sent.some((m) => m.text.includes('## Skill: new-test')), h.chat.sent.map((m) => m.text.slice(0, 80)));
    t.check('the next message starts without a skill', await pick.inputValue(), '');

    // Deleted from Settings (operator, 2026-10-21: "an option to delete a skill"): Delete at the top of its card, named
    // for it, asks first; No keeps it, Delete deletes it.
    await page.goto(url('/settings'));
    const del = page.getByRole('button', { name: en['skills.removeOne']!.replace('{name}', 'new-test'), exact: true });
    await del.waitFor();
    t.check('Delete is on top of the skill, beside its name', [((await page.locator('.skill-entry:not(.skill-new) .skill-head').textContent()) ?? '').trim(), await del.isVisible()], [`/new-test${en['skills.remove']}`, true]);
    await del.click();
    const ask = page.getByRole('alertdialog');
    await ask.waitFor({ timeout: 3_000 });
    t.truthy('it asks first, naming the skill', ((await ask.textContent()) ?? '').includes(en['skills.removeConfirm']!.replace('{name}', 'new-test')), await ask.textContent());
    await ask.getByRole('button', { name: en['dialog.cancel']!, exact: true }).click();
    t.check('answered no: kept', (await h.call<{ skills: unknown[] }>('GET', '/skills')).skills.length, 1);
    await del.click();
    await page.getByRole('alertdialog').getByRole('button', { name: en['skills.remove']!, exact: true }).click();
    await waitFor('the skill to be deleted', async () => (await h.call<{ skills: unknown[] }>('GET', '/skills')).skills.length === 0, 10_000).catch(() => undefined);
    // And from the page, which redraws after the answer: under the whole suite's load, a moment after the API.
    await page.locator('.skill-entry:not(.skill-new)').first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);
    t.check('answered Delete: gone from the settings and the page', [(await h.call<{ skills: unknown[] }>('GET', '/skills')).skills.length, await page.locator('.skill-entry:not(.skill-new)').count()], [0, 0]);
  });

  /*
   * Go to File and the Search view, as in VS Code (operator, 2026-10-21): Ctrl+P finds a file by a few letters and opens
   * it, at a line with :N; Ctrl+Shift+F searches the code, its toggles narrow it, a result opens its file at the match.
   */
  await scenario('Go to File (Ctrl+P) and the Search view (Ctrl+Shift+F), as in VS Code', {}, async (h, page, url) => {
    mkdirSync(join(h.repo, 'src', 'deep'), { recursive: true });
    writeFileSync(join(h.repo, 'src', 'deep', 'thing.ts'), 'const a = 1;\nconst b = 2;\nexport const needle = a + b;\nconst Needle2 = needle;\n');
    await page.goto(url('/'));
    await page.locator('.wb-side .file-ico').first().waitFor();
    t.check('the files are shown, and the Search view is not, until asked for', await page.locator('.sv').isVisible(), false);
    await page.keyboard.press('Control+p');
    const quick = page.getByRole('dialog', { name: en['quick.label']! });
    await quick.waitFor();
    await quick.getByRole('combobox').fill('thng');
    const first = quick.getByRole('option').first();
    t.truthy('a few letters of the name find the file, the letters marked, its folder beside it', ((await first.textContent()) ?? '').includes('thing.ts') && ((await first.textContent()) ?? '').includes('src/deep') && (await first.locator('mark.qo-hit').count()) > 0, await first.textContent());
    await quick.getByRole('combobox').fill('thing:3');
    await quick.getByRole('combobox').press('Enter');
    const pane = page.locator('.wb-file-pane:not([hidden])');
    // Named for its file, as the textarea was: Monaco's own input takes the label it is given (it is not drawn: attached).
    await page.getByRole('textbox', { name: en['ed.label']!.replace('{path}', 'src/deep/thing.ts') }).waitFor({ state: 'attached', timeout: 30_000 });
    const at = async (): Promise<number> => (await editorCursor(pane)).line;
    await waitFor('the cursor to be on line 3', async () => (await at()) === 3, 5_000).catch(() => undefined);
    t.check('name:3 opens it at line 3', await at(), 3);

    await page.keyboard.press('Control+Shift+f');
    const box = page.getByRole('textbox', { name: en['search.input']!, exact: true });
    await box.waitFor();
    await waitFor('the box to take the keys', async () => await box.evaluate((el) => el === document.activeElement), 3_000).catch(() => undefined);
    t.check('Ctrl+Shift+F: the Search view, its box ready', await box.evaluate((el) => el === document.activeElement), true);
    await box.fill('needle');
    const status = page.locator('.sv-message').first();
    await waitFor('the results', async () => /results in/.test((await status.textContent()) ?? ''), 10_000).catch(() => undefined);
    t.check('found as one types, any case: how many in how many files', (await status.textContent())?.trim(), en['search.results']!.replace('{n}', '3').replace('{files}', '1'));
    t.check('the file with its count, the matches marked', [await page.locator('.sv-file-head .sv-count').first().textContent(), await page.locator('.sv-match mark.sv-hit').count()], ['3', 3]);
    await page.getByRole('button', { name: en['search.matchCase']!, exact: true }).click();
    await waitFor('Match Case to narrow it', async () => ((await status.textContent()) ?? '').startsWith('2 '), 10_000).catch(() => undefined);
    t.check('Match Case narrows it', (await status.textContent())?.trim(), en['search.results']!.replace('{n}', '2').replace('{files}', '1'));
    await page.getByRole('button', { name: en['search.matchCase']!, exact: true }).click();
    await waitFor('back to any case', async () => ((await status.textContent()) ?? '').startsWith('3 '), 10_000).catch(() => undefined);
    await page.getByRole('button', { name: en['search.wholeWord']!, exact: true }).click();
    await waitFor('Match Whole Word to narrow it', async () => ((await status.textContent()) ?? '').startsWith('2 '), 10_000).catch(() => undefined);
    t.check('Match Whole Word: needle, not Needle2', (await status.textContent())?.trim(), en['search.results']!.replace('{n}', '2').replace('{files}', '1'));
    await page.locator('.sv-match').nth(1).click();
    await waitFor('the file to open at the match', async () => (await at()) === 4, 5_000).catch(() => undefined);
    const chosen = (await editorCursor(pane)).chosen;
    t.check('a result opens its file at that line, the match chosen', [await at(), chosen], [4, 'needle']);
    await page.getByRole('button', { name: en['search.regex']!, exact: true }).click();
    await box.fill('needle(');
    await waitFor('the pattern to be refused', async () => ((await status.textContent()) ?? '').includes(en['search.problem']!.split('{why}')[0]!), 10_000).catch(() => undefined);
    t.truthy('a regular expression that is not valid is said under the box', ((await status.textContent()) ?? '').startsWith(en['search.problem']!.split('{why}')[0]!), await status.textContent());
    // The panel has one grip, the shown view's: the Search view kept while the files are shown carries none.
    t.check('one grip for the side panel while searching', await page.locator('.wb-side .wb-grip').count(), 1);
    await page.keyboard.press('Control+Shift+e');
    await page.locator('.wb-side .file-ico').first().waitFor();
    t.check('one grip for the side panel back on the files, the Search view kept but hidden', [await page.locator('.wb-side .wb-grip').count(), await page.locator('.sv').count(), await page.locator('.sv').isVisible()], [1, 1, false]);
  });

  /*
   * A Markdown file as it reads (operator, 2026-10-21), mermaid diagrams drawn: by default as it reads; Code shows its
   * text; Side by side both; a link to another file of the folder opens it.
   */
  await scenario('Markdown as it reads: headings, a table, code, a mermaid diagram drawn; Code and side by side', {}, async (h, page, url) => {
    mkdirSync(join(h.repo, 'docs'), { recursive: true });
    writeFileSync(join(h.repo, 'docs', 'other.md'), '# The other one\n');
    writeFileSync(
      join(h.repo, 'docs', 'guide.md'),
      [
        '# The guide',
        '',
        'Some **bold** and `code`, and [the other file](other.md).',
        '',
        '- one',
        '- [x] done',
        '',
        '| Name | Count |',
        '|:-----|------:|',
        '| a    |     1 |',
        '',
        '```ts',
        'const x: number = 1;',
        '```',
        '',
        '```mermaid',
        'flowchart LR',
        '  A[Start] --> B{Ready?}',
        '  B -->|yes| C[Go]',
        '```',
        '',
      ].join('\n'),
    );
    await page.goto(url('/'));
    await page.locator('.wb-side .file-ico').first().waitFor();
    await page.keyboard.press('Control+p');
    const quick = page.getByRole('dialog', { name: en['quick.label']! });
    await quick.getByRole('combobox').fill('guide.md');
    await quick.getByRole('combobox').press('Enter');
    const md = page.locator('.ed-preview .md');
    await md.waitFor();
    t.check('opened as it reads: the heading, the list with its box, the table aligned, the code coloured', [
      await md.locator('h1').textContent(),
      await md.locator('li.md-task input[type=checkbox]').isChecked(),
      await md.locator('td').nth(1).evaluate((el) => (el as HTMLElement).style.textAlign),
      (await md.locator('pre.md-code span').count()) > 0,
    ], ['The guide', true, 'right', true]);
    await md.locator('.md-mermaid svg').waitFor({ timeout: 30_000 }).catch(() => undefined);
    t.truthy('the mermaid block drawn as its diagram', (await md.locator('.md-mermaid svg').count()) === 1 && ((await md.locator('.md-mermaid').textContent()) ?? '').includes('Ready?'), await md.locator('.md-mermaid').innerHTML().catch(() => ''));
    t.check('and not as its text', await page.locator('.ed-body.ed-show-preview .ed-code').isVisible(), false);
    await page.getByRole('button', { name: en['ed.viewCode']!, exact: true }).click();
    await page.locator('.ed-monaco[data-ready]').waitFor({ timeout: 30_000 });
    t.check('Code: its text to edit', [await page.locator('.ed-code .ed-monaco').isVisible(), await page.locator('.ed-preview').count()], [true, 0]);
    await page.getByRole('button', { name: en['ed.viewSplit']!, exact: true }).click();
    await page.locator('.ed-monaco[data-ready]').waitFor({ timeout: 30_000 });
    t.check('Side by side: both', [await page.locator('.ed-code .ed-monaco').isVisible(), await page.locator('.ed-preview .md').isVisible()], [true, true]);
    await page.getByRole('button', { name: en['ed.viewPreview']!, exact: true }).click();
    await md.getByRole('link', { name: 'the other file' }).click();
    await page.locator('.wb-tab').filter({ hasText: 'other.md' }).waitFor({ timeout: 5_000 }).catch(() => undefined);
    t.check('a link to another file of the folder opens it', await page.locator('.wb-tab').filter({ hasText: 'other.md' }).count(), 1);
  });

  /*
   * The pause between messages, in Settings (operator, 2026-10-21): a box; ticked, the seconds and a second box for a
   * random time; that one ticked, the longest.
   */
  await scenario('Settings: the pause between messages, its seconds and a random time appearing as the boxes are ticked', {}, async (h, page, url) => {
    await page.goto(url('/settings'));
    const on = page.getByRole('checkbox', { name: en['exec.gap']!, exact: true });
    await on.waitFor();
    t.check('off at first, nothing under it', [await on.isChecked(), await page.locator('#gap-sec').count(), await page.locator('#gap-random').count()], [false, 0, 0]);
    await on.check();
    await page.locator('#gap-sec').waitFor();
    t.check('ticked: the seconds, 60, and the box for a random time', [await page.locator('#gap-sec').inputValue(), await page.locator('#gap-random').count(), await page.locator('#gap-max').count()], ['60', 1, 0]);
    await page.getByRole('checkbox', { name: en['exec.gapRandom']!, exact: true }).check();
    await page.locator('#gap-max').waitFor();
    t.check('a random time: the longest, 90', await page.locator('#gap-max').inputValue(), '90');
    await waitFor('the settings to be saved', async () => {
      const p = ((await h.call<{ raw: Record<string, unknown> }>('GET', '/settings')).raw.pacing ?? {}) as { gapEnabled?: boolean; gapRandom?: boolean };
      return p.gapEnabled === true && p.gapRandom === true;
    }, 10_000).catch(() => undefined);
    const saved = ((await h.call<{ raw: Record<string, unknown> }>('GET', '/settings')).raw.pacing ?? {}) as Record<string, unknown>;
    t.check('saved', [saved.gapEnabled, saved.gapRandom], [true, true]);
    await on.uncheck();
    t.check('unticked: the rest goes', [await page.locator('#gap-sec').count(), await page.locator('#gap-random').count()], [0, 0]);
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
    const shown = (): Locator => page.locator('.wb-file-pane:not([hidden]) .ed-monaco');
    // The editor of VS Code (Monaco, 2026-10-22): its colours are its tokens' classes, its line numbers its own.
    const colours = async (): Promise<number> => await shown().locator('.view-lines').evaluate((el) => new Set([...el.querySelectorAll('span span')].flatMap((s) => s.className.match(/\bmtk\d+\b/g) ?? [])).size);
    await editorText(pane);
    t.check('found by itself: TypeScript', ((await pane.locator('.ed-lang option:checked').textContent()) ?? '').trim(), en['ed.langAuto']!.replace('{name}', 'TypeScript'));
    await waitFor('the colours', async () => (await colours()) >= 4, 10_000).catch(() => undefined);
    t.truthy('in colour: keywords, a number, a comment, each its own', (await colours()) >= 4, await shown().locator('.view-lines').innerHTML());
    t.check('with line numbers', (await shown().locator('.line-numbers').allTextContents()).map((n) => n.trim()), ['1', '2', '3', '4', '5']);
    t.check('and an icon of its kind on its tab', await page.getByRole('tab', { name: /greet\.ts/ }).locator('svg.file-ico').count(), 1);
    await pane.locator('.ed-lang').selectOption('plain');
    await waitFor('plain text', async () => (await colours()) <= 1, 10_000).catch(() => undefined);
    t.check('chosen by hand, plain text: no colours', await colours(), 1);
    await pane.locator('.ed-lang').selectOption('auto');

    await shown().locator('.view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// edited');
    await page.getByRole('tab', { name: /greet\.ts/ }).locator('.wb-unsaved').waitFor();
    t.check('edited: "Not saved", and a dot on its tab', ((await pane.locator('.ed-bar [role="status"]').textContent()) ?? '').trim(), en['ed.unsaved']);
    await files.getByRole('button', { name: 'notes.txt' }).click();
    await editorText(page.locator('.wb-file-pane:not([hidden])'));
    await page.getByRole('tab', { name: /greet\.ts/ }).click();
    t.truthy('another tab and back: the edit is still there', (await editorText(page.locator('.wb-file-pane:not([hidden])'))).endsWith('// edited'), '');
    await shown().locator('.view-lines').click();
    await page.keyboard.press('Control+S');
    await page.locator('.wb-file-pane:not([hidden]) .ed-bar').getByText(en['ed.saved']!).waitFor();
    const onDisk = readFileSync(ts, 'utf8');
    t.check('Ctrl+S: saved on disk, its CRLF line endings kept', [onDisk.endsWith('}\r\n// edited'), (onDisk.match(/\r\n/g) ?? []).length, onDisk.includes('\n') && !/[^\r]\n/.test(onDisk)], [true, 4, true]);
    t.check('and the dot is gone', await page.getByRole('tab', { name: /greet\.ts/ }).locator('.wb-unsaved').count(), 0);

    // A change on disk with no edit: followed. Under an edit: asked about.
    writeFileSync(ts, 'export const a = 2;\r\n');
    // As on disk, its line endings too: VS Code's editor keeps a file's CRLF, where the textarea before it showed LF.
    await waitFor('the editor to follow the disk', async () => (await editorText(pane)) === 'export const a = 2;\r\n', 10_000).catch(() => undefined);
    t.check('no edit: it follows the change on disk', await editorText(pane), 'export const a = 2;\r\n');
    await shown().locator('.view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// mine');
    writeFileSync(ts, 'export const a = 3;\r\n');
    const conflict = page.locator('.wb-file-pane:not([hidden]) .ed-conflict');
    await conflict.waitFor({ timeout: 10_000 });
    t.truthy('under an edit: it says the file changed on disk, and asks', ((await conflict.textContent()) ?? '').includes(en['ed.changedOnDisk']!), await conflict.textContent());
    await conflict.getByRole('button', { name: en['ed.saveOver']! }).click();
    await page.locator('.wb-file-pane:not([hidden]) .ed-bar').getByText(en['ed.saved']!).waitFor();
    t.check('"Save over it": the edit is on disk', readFileSync(ts, 'utf8'), 'export const a = 2;\r\n// mine');

    // Tab indents, and Ctrl+Z takes it back, as in VS Code.
    await shown().locator('.view-lines').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Tab');
    t.truthy('Tab indents the line', (await editorText(pane)).startsWith('  export'), await editorText(pane));
    await page.keyboard.press('Control+Z');
    t.truthy('and Ctrl+Z takes it back', (await editorText(pane)).startsWith('export'), await editorText(pane));

    /*
     * Typed fast, it stays as typed (2026-10-22: the text handed up and back a render later was put back into the
     * editor, and a burst of keys came out scrambled), and "Revert my changes" still puts the file back.
     */
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nconst quick = [1, 2, 3].map((n) => n * 2);', { delay: 0 });
    await sleep(500);
    t.truthy('typed fast: exactly as typed, where it was typed', (await editorText(pane)).endsWith('\nconst quick = [1, 2, 3].map((n) => n * 2);'), await editorText(pane));
    await pane.getByRole('button', { name: en['ed.revert']!, exact: true }).click();
    await waitFor('the file put back', async () => (await editorText(pane)) === readFileSync(ts, 'utf8'), 5_000).catch(() => undefined);
    t.check('"Revert my changes": the file as it is on disk again', await editorText(pane), readFileSync(ts, 'utf8'));

    /*
     * The editor of VS Code (operator, 2026-10-22: Monaco): IntelliSense for TypeScript, from its worker — a member of a
     * type offered after the dot, with its type.
     */
    writeFileSync(join(h.repo, 'user.ts'), 'interface User {\n  name: string;\n  email: string;\n}\nconst u: User = { name: "a", email: "b" };\n');
    await files.getByRole('button', { name: 'user.ts' }).click();
    const userPane = page.locator('.wb-file-pane:not([hidden])');
    await editorText(userPane);
    await userPane.locator('.ed-monaco .view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('u.');
    const suggest = page.locator('.suggest-widget .monaco-list-row');
    await suggest.first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    t.truthy('IntelliSense: the members of the type, after the dot', (await suggest.allTextContents()).some((s) => s.startsWith('email')) && (await suggest.allTextContents()).some((s) => s.startsWith('name')), await suggest.allTextContents());
    await page.keyboard.press('Escape');

    /*
     * No problems underlined (operator, 2026-10-23: "it does not see node_modules; hide the underlining altogether"):
     * a package the editor cannot see, and a type that is wrong, are not marked — before, both were, in red.
     */
    writeFileSync(join(h.repo, 'wrong.ts'), "import { thing } from 'a-package-in-node-modules';\nconst n: number = 'text';\nexport { thing, n };\n");
    await files.getByRole('button', { name: 'wrong.ts' }).click();
    const wrongPane = page.locator('.wb-file-pane:not([hidden])');
    await editorText(wrongPane);
    // The language service answers within a second or two; given three.
    await page.waitForTimeout(3_000);
    t.check('nothing underlined, of any kind', await wrongPane.locator('.squiggly-error, .squiggly-warning, .squiggly-info, .squiggly-hint').count(), 0);
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
    t.check('with its three answers', await card.locator('button:not(.copy-btn)').allTextContents(), [en['pm.approve'], en['pm.revise'], en['pm.stop']]);
    t.check('and says who asks: plan mode', await card.locator('.actor-chip').textContent(), 'Asked by: Plan mode');
    // "Copy" on the plan (operator, 2026-10-21): the whole plan, under its headings, at its top and at its foot.
    t.check('"Copy" at the plan\'s top and at its foot', await card.locator('.plan-view .copy-btn').count(), 2);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url('') });
    await card.locator('.plan-view .copy-btn').first().click();
    const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    t.truthy(
      'it copies the plan whole: what is there, the approach, the steps numbered, the files, how it is shown done',
      copied.startsWith(`## ${en['pm.existing']}\n\nOnly README.md`) && copied.includes(`## ${en['pm.steps']}\n\n1. create the file\n2. read it back`) && copied.includes('- `planned.txt`') && copied.includes(`## ${en['pm.verification']}`),
      copied,
    );
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
   * Who works, said everywhere (operator, 2026-10-22: "show clearly what the bot is doing and who works"; "a LIVE mark
   * beside Chat while the bot works"; "and in the tab that says copilot-operator"; "make it easier to see where my
   * prompts are"): LIVE beside Chat saying who, the tab's title, the working line and the status bar naming the
   * worker, the command card saying who asks, the operator's own message headed and kept in sight; all of it gone
   * when the work ends.
   */
  await scenario('who works, said: LIVE beside Chat, the tab\'s title, the working line, the card; the operator\'s message headed', { execution: { mode: 'confirm' } }, async (h, page, url) => {
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    const { threadId } = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create live.txt holding live.', model: 'Think deeper' });
    h.chat.script(
      async () => {
        await answered;
        return reply.steps(write('live.txt', 'live'));
      },
      reply.done('I wrote live.txt holding the word live and read it back to check that it is there.'),
    );
    await page.goto(url('/'));
    await page.locator('#cs-thread').waitFor();
    await page.evaluate((id) => localStorage.setItem('cop.chat.thread', id), threadId);
    await page.reload();
    const tab = page.getByRole('tablist', { name: en['wb.chatPanel']! }).getByRole('tab');
    const badge = tab.locator('.wb-live-badge');
    await page.locator('.cs-turn').first().waitFor();
    t.check('idle: no LIVE beside Chat, and the tab is the name alone', [await badge.count(), await page.title()], [0, 'copilot-operator']);
    const head = page.locator('.cs-turn').first().locator('.cs-user-head');
    t.check("the operator's message is headed: You, Your message 1, and its time", [await head.locator('.cs-user-who').textContent(), await head.locator('.cs-user-n').textContent(), /^\d{2}:\d{2}$/.test((await head.locator('time').textContent()) ?? '')], [en['chat.you'], 'Your message 1', true]);
    // It moves with the conversation (2026-10-23: it stayed on top, which the operator did not want), and is filled.
    t.check('it moves with the conversation, not kept on top', await page.locator('.cs-user-row').first().evaluate((el) => getComputedStyle(el).position), 'static');
    const filled = await page.locator('.cs-user').first().evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--you-bg)';
      document.body.append(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(el).backgroundColor, want, getComputedStyle(el).color];
    });
    t.check('and filled in its own colour, white on the accent', [filled[0] === filled[1], filled[2]], [true, 'rgb(255, 255, 255)']);

    await h.call('POST', `/sessions/${threadId}/start`, { mode: 'confirm' });
    await badge.waitFor({ timeout: 15_000 });
    await waitFor('who is at work to be said', async () => ((await badge.getAttribute('aria-label')) ?? '').includes(en['actor.worker']!) || null, 15_000).catch(() => undefined);
    t.check('working: LIVE beside Chat, saying who', [await badge.textContent(), await badge.getAttribute('aria-label')], ['LIVE', 'The bot is working — Worker']);
    // "Working." "Working.." "Working..." in the tab, going round (2026-10-23).
    const titles = new Set<string>();
    for (const until = Date.now() + 2_000; Date.now() < until; ) {
      titles.add(await page.title());
      await page.waitForTimeout(120);
    }
    t.check('the tab says the bot is working, its dots going round', [...titles].filter((x) => /^Working\.{1,3} — copilot-operator$/.test(x)).sort(), ['Working. — copilot-operator', 'Working.. — copilot-operator', 'Working... — copilot-operator']);
    await page.locator('.cs-working .actor-chip').waitFor();
    t.check('the working line and the status bar name the worker', [await page.locator('.cs-working .actor-chip').textContent(), await page.locator('.wb-statusbar .actor-chip').textContent()], [en['actor.worker'], en['actor.worker']]);

    answer();
    const ask = page.locator('.cs-ask');
    await ask.waitFor({ timeout: 20_000 });
    t.check('the command card says who asks', await ask.locator('.actor-chip').textContent(), 'Asked by: Worker');
    await waitFor('the tab to say something waits', async () => (await page.title()) === 'Waiting for you (1) — copilot-operator' || null, 10_000).catch(() => undefined);
    t.check('the tab says first that something waits for the operator', await page.title(), 'Waiting for you (1) — copilot-operator');
    await ask.getByRole('button', { name: en['chat.askRun']!, exact: true }).click();
    await page.locator('.cs-body').getByText('I wrote live.txt holding the word live').waitFor({ timeout: 30_000 });
    await waitFor('LIVE to go', async () => (await badge.count()) === 0 || null, 15_000).catch(() => undefined);
    await waitFor('the tab to say it is done', async () => (await page.title()) === 'Done — copilot-operator' || null, 10_000).catch(() => undefined);
    t.check('ended: no LIVE, the tab says "Done", no working line', [await badge.count(), await page.title(), await page.locator('.cs-working').count()], [0, 'Done — copilot-operator', 0]);
  });

  /*
   * The chat's question (operator, 2026-10-23: "answers to click; a command the chat wants run by hand is a button,
   * and the bot runs it"): a card in the conversation, asked by the worker, its recommended answer first and
   * highlighted, the command an answer carries said on it; clicked, the bot runs it and the work goes on.
   */
  await scenario('the chat asks: its answers to click, the recommended first, one that runs a command run by the bot', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h, page, url) => {
    const { threadId } = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Write asked.txt once I agree.', model: 'Think deeper' });
    h.chat.script(
      reply.ask('Shall I write asked.txt now?', [{ answer: 'Yes, write it', run: write('asked.txt', 'yes') }, 'Not yet']),
      reply.done('asked.txt was written by the command of the answer chosen, and read back: it holds yes.'),
    );
    await h.call('POST', `/sessions/${threadId}/start`, { mode: 'unattended' });
    await page.goto(url('/'));
    await page.locator('#cs-thread').waitFor();
    await page.evaluate((id) => localStorage.setItem('cop.chat.thread', id), threadId);
    await page.reload();
    const card = page.locator('.cs-question');
    await card.waitFor({ timeout: 30_000 });
    t.check('the card: the chat asks, and says who', [((await card.locator('.cs-ask-head strong').textContent()) ?? '').trim(), await card.locator('.actor-chip').textContent()], [en['chat.question'], 'Asked by: Worker']);
    const options = card.locator('.cs-options button');
    t.check('its answers in order, the first the recommended one, highlighted', [await options.count(), await options.first().getAttribute('title'), ((await options.first().getAttribute('class')) ?? '').includes('primary')], [2, en['chat.optionRecommended'], true]);
    t.truthy('the answer that carries a command says what it runs', ((await options.first().locator('.cs-option-run').textContent()) ?? '').includes("Set-Content -Path asked.txt"), await options.first().textContent());
    await options.first().click();
    await page.locator('.cs-body').getByText('asked.txt was written by the command').waitFor({ timeout: 30_000 });
    t.check('clicked: the bot ran it, and the work went on to its end', existsSync(join(h.repo, 'asked.txt')) ? readFileSync(join(h.repo, 'asked.txt'), 'utf8').trim() : null, 'yes');
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
    for (const id of ['cs-model', 'cs-thread']) {
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
    await page.goto(url('/settings'));
    const sessionsLink = page.locator('nav a[href="/settings"]');
    await sessionsLink.waitFor();
    await page.getByRole('button', { name: 'Language', exact: true }).first().click();
    await page.getByRole('menuitemradio', { name: /Български/ }).click();
    const lang = async (): Promise<[string, string]> => [((await sessionsLink.textContent()) ?? '').trim(), await page.evaluate(() => document.documentElement.lang)];
    await waitFor('the nav in Bulgarian', async () => (await lang())[0] === bg['nav.defaults'], 5_000).catch(() => undefined);
    t.check('the nav speaks Bulgarian and the page says lang="bg"', await lang(), [bg['nav.defaults'], 'bg']);
    await page.reload();
    await waitFor('the language to come back', async () => (await lang())[1] === 'bg', 5_000).catch(() => undefined);
    t.check('both survive a reload', await lang(), [bg['nav.defaults'], 'bg']);

    await page.setViewportSize({ width: 360, height: 780 });
    await page.evaluate((id) => localStorage.setItem('cop.chat.thread', id), sent.threadId);
    const pages = ['/', '/settings', '/system'];
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
   * The chat's controls of 2026-10-20: "Review" on by default and sent with the first message; "New chat" off on a chat
   * not begun and while a task runs, each time saying why when pointed at; "Pause", "Stop" and "Add to it" on one line;
   * the review's model asked by hand on a card that says so plainly; the files' icons without a frame.
   */
  await scenario('the chat\'s REVIEW box, "New chat" off while it works, "Pause", "Stop" and "Add to it" on one line', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h, page, url) => {
    await h.call('PUT', '/models/default', { model: 'Think deeper' });
    await page.goto(url('/'));
    const review = page.getByRole('checkbox', { name: en['chat.review']! });
    await review.waitFor();
    t.check('"Review" is on by default', await review.isChecked(), true);
    const newChat = page.getByRole('button', { name: en['chat.newChat']!, exact: true });
    t.check('a new chat not begun: "New chat" off', await newChat.getAttribute('aria-disabled'), 'true');
    await newChat.hover();
    t.truthy('and it says why when pointed at', await appears(page.locator('#cs-new-tip').filter({ hasText: en['chat.newChatFresh']! }), 3_000), await page.locator('#cs-new-tip').textContent().catch(() => ''));
    await page.locator('.wb-side .file-ico').first().waitFor();
    t.check('the files have their icons without a frame', [await page.locator('.wb-side .file-ico').count() > 0, await page.locator('.wb-side .file-ico rect').count()], [true, 0]);

    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    h.chat.script(
      async () => {
        await answered;
        return reply.steps(write('checked.txt', 'checked'));
      },
      reply.done('I created checked.txt holding the word checked and read it back to check that it is there.'),
      reply.steps('Get-Content -Path checked.txt'),
      reply.pass('I read checked.txt and it holds exactly the word checked, as the task asked for.'),
    );
    const input = page.getByRole('textbox', { name: en['chat.input']! });
    await input.fill('Create checked.txt holding the word checked.');
    await input.press('Enter');
    const pause = page.getByRole('button', { name: en['chat.pause']!, exact: true });
    await pause.waitFor({ timeout: 20_000 });
    const thread = (await h.call<Array<{ id: string }>>('GET', '/chat/threads'))[0]!.id;
    t.check('the first message took "Review" with it', (await h.call<{ review?: { enabled: boolean } }>('GET', `/sessions/${thread}`)).review?.enabled, true);
    await waitFor('"New chat" to go off', async () => (await newChat.getAttribute('aria-disabled')) === 'true', 10_000).catch(() => undefined);
    t.check('while it works: "New chat" off', await newChat.getAttribute('aria-disabled'), 'true');
    await newChat.hover();
    t.truthy('saying it comes on once it is stopped or its window closed', await appears(page.locator('#cs-new-tip').filter({ hasText: en['chat.newChatRunning']! }), 3_000), await page.locator('#cs-new-tip').textContent().catch(() => ''));
    await newChat.click({ force: true });
    t.check('pressed anyway, it does nothing: the conversation stays', await page.locator('#cs-thread').inputValue(), thread);
    const rows = await Promise.all([pause, page.getByRole('button', { name: en['chat.stop']!, exact: true }), page.getByRole('button', { name: en['chat.sendNote']!, exact: true })].map(async (b) => Math.round((await b.boundingBox())?.y ?? -1)));
    t.truthy('"Pause", "Stop" and "Add to it" on one line', rows.every((y) => y === rows[0] && y >= 0), rows);
    answer();

    // The review's conversation: its model chosen by hand (none named for it), on a card that says it is the review's.
    const card = page.locator('.approval').filter({ has: page.locator('.approval-review') });
    await card.waitFor({ timeout: 30_000 });
    t.truthy('the card says plainly it is the review\'s, and why another, stronger model', ((await card.locator('.approval-review').textContent()) ?? '').includes(en['approval.reviewModelTitle']!) && ((await card.locator('.approval-review').textContent()) ?? '').includes('stronger'), await card.textContent());
    await card.getByRole('button', { name: en['approval.manualReady']!, exact: true }).click();
    await page.locator('.cs-body').getByText('I created checked.txt holding the word checked').waitFor({ timeout: 30_000 });
    await waitFor('the work to end', async () => (await h.call<{ running: boolean }>('GET', `/sessions/${thread}`)).running === false, 30_000).catch(() => undefined);
    const ended = (await h.call<{ tasks: Array<{ status: string; review?: { verdict: string } }> }>('GET', `/sessions/${thread}`)).tasks[0];
    t.check('reviewed and passed', [ended?.status, ended?.review?.verdict], ['done', 'pass']);
    await waitFor('"New chat" to come on', async () => (await newChat.getAttribute('aria-disabled')) === null, 10_000).catch(() => undefined);
    t.check('ended: "New chat" on again', await newChat.getAttribute('aria-disabled'), null);
    await review.uncheck();
    await waitFor('the review off for the conversation', async () => (await h.call<{ review?: { enabled: boolean } }>('GET', `/sessions/${thread}`)).review?.enabled === false, 10_000).catch(() => undefined);
    t.check('unticked: off for this conversation', (await h.call<{ review?: { enabled: boolean } }>('GET', `/sessions/${thread}`)).review?.enabled, false);
  });

  /*
   * The review's model in the chat (operator, 2026-10-21: "is the review model used by the chat? If so, put it in the
   * chat as an option, with its drop-down"): under the work's while "Review" is ticked; Settings' one unless another is
   * chosen; the choice goes with the first message, the review runs on it, and an open conversation's can be changed.
   */
  await scenario("the review's model beside the work's in the chat: Settings' unless chosen here, and the review runs on it", { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h, page, url) => {
    await h.call('PUT', '/models/default', { model: 'Think deeper' });
    await h.call('POST', '/models/refresh');
    await h.call('PUT', '/models/review-default', { model: 'Think deeper' });
    await page.goto(url('/'));
    const review = page.getByRole('checkbox', { name: en['chat.review']! });
    await review.waitFor();
    t.check('"Review" unticked: no model for it', [await review.isChecked(), await page.locator('#cs-review-model').count()], [false, 0]);
    await review.check();
    const pick = page.locator('#cs-review-model');
    await pick.waitFor();
    t.check(
      "ticked: the review's model under the work's, Settings' one chosen",
      [await page.locator('.cs-models .cs-pick-label').allTextContents(), ((await pick.locator('option').first().textContent()) ?? '').trim(), await pick.inputValue()],
      [[en['chat.workModel'], en['chat.reviewModel']], en['chat.reviewModelDefault']!.replace('{model}', 'Think deeper'), ''],
    );
    await pick.selectOption('GPT 5.6 Think deeper');
    h.chat.script(
      reply.steps(write('hello.txt', 'hello')),
      reply.done('I created hello.txt holding the word hello and read it back to check that it is there.'),
      reply.steps('Get-Content -Path hello.txt'),
      reply.pass('I read hello.txt and it holds exactly the word hello, as the message asked for.'),
    );
    const input = page.getByRole('textbox', { name: en['chat.input']! });
    await input.fill('Create hello.txt holding the word hello.');
    /*
     * The start answering late, as it does on a busy machine: the conversation's first read comes back before it, and
     * the read "Send" makes when it is done must not blank the chat to the welcome (2026-10-21: it read the conversation
     * of the render before the message made one; a review model chosen then went to the next new conversation).
     */
    await page.route('**/sessions/*/start', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && /\/sessions\/[^/]+\/start$/.test(new URL(r.url()).pathname), { timeout: 20_000 });
    await input.press('Enter');
    await started;
    await page.waitForTimeout(400);
    t.check('the first message answered late: its conversation stays on the screen', [await page.locator('.cs-welcome').count(), await page.locator('.cs-user').count() > 0], [0, true]);
    await page.unroute('**/sessions/*/start');
    const thread = await waitFor('the conversation', async () => (await h.call<Array<{ id: string }>>('GET', '/chat/threads'))[0]?.id, 20_000);
    type Rev = { review?: { enabled: boolean; model: string }; reviewModelSource?: string; running?: boolean };
    const first = await h.call<Rev>('GET', `/sessions/${thread}`);
    t.check("the first message took the review's model with it, as the operator's", [first.review?.enabled, first.review?.model, first.reviewModelSource], [true, 'GPT 5.6 Think deeper', 'operator']);
    type Ended = Rev & { tasks: Array<{ status: string; review?: { verdict: string } }> };
    const ended = async (): Promise<Ended> => await h.call<Ended>('GET', `/sessions/${thread}`);
    await waitFor('the work and its review to end', async () => { const e = await ended(); return e.tasks[0]?.status === 'done' && e.running === false; }, 45_000).catch(() => undefined);
    const task = (await ended()).tasks[0];
    t.check('reviewed and passed', [task?.status, task?.review?.verdict], ['done', 'pass']);
    t.truthy("and the review was put on the model chosen here, not Settings' one", h.chat.modelRequests.includes('GPT 5.6 Think deeper'), { asked: h.chat.modelRequests });
    await pick.selectOption('');
    await waitFor("the conversation to follow Settings' again", async () => (await h.call<Rev>('GET', `/sessions/${thread}`)).review?.model === '', 10_000).catch(() => undefined);
    const after = await h.call<Rev>('GET', `/sessions/${thread}`);
    t.check("Settings' one chosen again on the open conversation: its own is cleared", [after.review?.model, after.reviewModelSource ?? null, await pick.inputValue()], ['', null, '']);
  });

  /*
   * Two chats (operator, 2026-10-20): ticked for a new conversation, the message goes to a lead, whose understanding of
   * it, notes, subtasks (each a fold with the worker's commands) and question are shown in the conversation; the
   * question is answered on its card; the result is the message's ending. The worker is not a conversation of the
   * list, and the panel follows its commands.
   */
  await scenario('two chats: the lead understands, the worker\'s subtask is folded under it, its question answered on a card', { execution: { mode: 'unattended', isolation: 'none-accepted' } }, async (h, page, url) => {
    await h.call('PUT', '/models/default', { model: 'Think deeper' });
    await page.goto(url('/'));
    const two = page.getByRole('checkbox', { name: en['chat.lead']! });
    await two.waitFor();
    t.check('"Two chats" is off at first, and "Review" is there', [await two.isChecked(), await page.getByRole('checkbox', { name: en['chat.review']! }).count()], [false, 1]);
    await two.check();
    t.check('ticked: the worker\'s model beside the lead\'s, and no "Review" (the lead judges the worker)', [await page.locator('#cs-worker-model').count(), await page.getByRole('checkbox', { name: en['chat.review']! }).count()], [1, 0]);
    // The two pickers one under the other, lined up, whatever the length of "Lead" and "Worker" in the language.
    const lead = await page.locator('#cs-model').boundingBox();
    const worker = await page.locator('#cs-worker-model').boundingBox();
    t.truthy('the lead\'s model and the worker\'s, one under the other and lined up', !!lead && !!worker && Math.abs(lead.x - worker.x) < 1 && worker.y > lead.y, JSON.stringify({ lead, worker }));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let releaseWorker!: () => void;
    const workerHeld = new Promise<void>((r) => (releaseWorker = r));
    h.chat.script(
      reply.lead.delegate(
        { title: 'Survey the project' },
        {
          understanding: 'Create done.txt holding done; report it in one sentence.',
          notes: 'First I look at what is there.',
          todo: [{ title: 'Survey the project', status: 'running', phase: 'Survey' }, { title: 'Write done.txt', status: 'planned', phase: 'Work' }, { title: 'Read it back', status: 'planned', phase: 'Verification' }],
        },
      ),
      async () => {
        await workerHeld;
        return reply.steps('Get-ChildItem -Name');
      },
      reply.done('The project folder holds README.md at its root, and nothing else that the assignment names.'),
      reply.lead.ask('Should done.txt go at the root, or in a folder of its own?', ['at the root', 'in a folder'], {
        notes: 'The assignment does not say where.',
        todo: [{ title: 'Survey the project', status: 'done', phase: 'Survey' }, { title: 'Write done.txt', status: 'planned', phase: 'Work' }, { title: 'Read it back', status: 'planned', phase: 'Verification' }, { title: 'Say it in one sentence', status: 'planned', phase: 'Report' }],
      }),
      async (m) => {
        t.truthy('the answer chosen on the card reached the lead', m.text.includes('at the root'), m.text.slice(0, 200));
        await held;
        return reply.lead.done('Nothing needed writing: the survey showed the folder, and the operator chose the root; done.txt is to go there.');
      },
    );
    const input = page.getByRole('textbox', { name: en['chat.input']! });
    await input.fill('Create done.txt holding done, and say in one sentence what was done.');
    await input.press('Enter');
    await page.locator('.cs-lead-say').filter({ hasText: 'Create done.txt holding done; report it in one sentence.' }).waitFor({ timeout: 30_000 });
    t.truthy('the lead\'s understanding of the task, said as such', ((await page.locator('.cs-lead-say').first().textContent()) ?? '').includes(en['lead.understood']!), await page.locator('.cs-lead-say').first().textContent());
    const gap = await page.locator('.cs-lead-say').first().evaluate((el) => parseFloat(getComputedStyle(el).paddingInlineStart));
    t.truthy('what the lead says keeps off the line beside it', gap >= 6, `padding-inline-start ${gap}px`);
    // While the worker works: the subtask by its title — "Subtask 1 of 3 planned" is its place in the plan, not a number.
    const workingOn = en['lead.workingOn']!.replace('{title}', 'Survey the project');
    await page.locator('.cs-working').filter({ hasText: workingOn }).waitFor({ timeout: 30_000 }).catch(() => undefined);
    t.check(
      'while the worker works: what it is on, by its title, and the place of it in the plan',
      [((await page.locator('.cs-working').textContent()) ?? '').includes(workingOn), (await page.locator('.cs-lead-progress strong').first().textContent())?.trim()],
      [true, en['lead.subtaskOf']!.replace('{n}', '1').replace('{total}', '3')],
    );
    releaseWorker();
    const sub = page.locator('details.cs-subtask').first();
    await sub.waitFor({ timeout: 30_000 });
    t.truthy('the subtask, folded under the lead\'s message, marked as only reading', ((await sub.locator('summary').textContent()) ?? '').includes(en['lead.subtask']!.replace('{n}', '1').replace('{title}', 'Survey the project')) && ((await sub.locator('summary').textContent()) ?? '').includes(en['lead.readOnly']!), await sub.locator('summary').textContent());
    const card = page.locator('.cs-question');
    await card.waitFor({ timeout: 30_000 });
    // Who asks, on the card (2026-10-22); and who is at work, on the line under the message: the lead, waiting for the answer.
    t.check('the question says it is the lead who asks', await card.locator('.actor-chip').textContent(), 'Asked by: Lead');
    await waitFor('the lead at work on the line', async () => (await page.locator('.cs-lead-turn .cs-working .actor-chip').textContent().catch(() => '')) === en['actor.lead'] || null, 10_000).catch(() => undefined);
    t.check('and the working line names the lead', await page.locator('.cs-lead-turn .cs-working .actor-chip').textContent(), en['actor.lead']);
    await sub.locator('summary').click();
    t.truthy('in it, the worker\'s command', ((await sub.textContent()) ?? '').includes('Get-ChildItem -Name'), await sub.textContent());
    // Both chats' messages and their sum (operator, 2026-10-21), along the bottom and under the message.
    await waitFor('the status bar to count both chats', async () => /messages: lead \d+, worker \d+, \d+ in all/.test((await page.locator('.wb-statusbar').textContent()) ?? ''), 10_000).catch(() => undefined);
    const line = (await page.locator('.wb-statusbar').textContent()) ?? '';
    const [, ld, wk, all] = /messages: lead (\d+), worker (\d+), (\d+) in all/.exec(line) ?? [];
    t.truthy('the status bar counts the lead\'s messages, the worker\'s, and the two together', !!ld && Number(ld) > 0 && Number(wk) > 0 && Number(all) === Number(ld) + Number(wk), line);
    t.truthy('and so does the message', /Messages: lead \d+ · worker \d+ · \d+ in all/.test((await page.locator('.cs-lead-count').textContent()) ?? ''), await page.locator('.cs-lead-count').textContent());
    /*
     * Where the work is against the lead's plan (operator's feedback, 2026-10-21: "1 of 20 subtasks" read as twenty
     * planned): the lead's own list — its phase, the subtasks done of the planned, the ones left — and the limit apart.
     */
    await waitFor('the list to change', async () => (await page.locator('.cs-ledger-change').count()) === 2, 10_000).catch(() => undefined);
    t.check(
      'where the list was made, and where it changed, said in the conversation',
      await page.locator('.cs-ledger-change').allTextContents(),
      [en['lead.ledgerFirst']!.replace('{n}', '3'), en['lead.ledgerChanged']!.replace('{v}', '2').replace('{what}', en['lead.ledgerAdded']!.replace('{n}', '1'))],
    );
    const progress = page.locator('.cs-lead-progress');
    t.check(
      'the phase, the subtasks done of the planned, the ones left, and the limit apart',
      [(await progress.locator('.cs-lead-phase').textContent())?.trim(), (await progress.locator('strong').first().textContent())?.trim(), (await progress.locator('p.muted').textContent())?.trim()],
      [en['lead.phase']!.replace('{n}', '2').replace('{total}', '4').replace('{title}', 'Work'), en['lead.doneOf']!.replace('{done}', '1').replace('{total}', '4'), en['lead.left']!.replace('{left}', '3').replace('{max}', '20')],
    );
    t.truthy('and no count of the limit as if it were the plan', !/\b\d+ of 20 subtasks\b/.test((await page.locator('.cs-lead-turn').textContent()) ?? ''), await page.locator('.cs-lead-turn').textContent());
    await progress.locator('details.cs-ledger > summary').click();
    t.check(
      'the list under its fold, by phase, each with what it is at',
      await progress.locator('.cs-todo').evaluateAll((els) => els.map((el) => [el.querySelector('.cs-todo-mark')?.textContent, el.querySelector('.cs-todo-title')?.textContent])),
      [['✓', 'Survey the project'], ['○', 'Write done.txt'], ['○', 'Read it back'], ['○', 'Say it in one sentence']],
    );
    t.truthy('the lead\'s question, with its choices',((await card.textContent()) ?? '').includes('Should done.txt go at the root') && (await card.getByRole('button', { name: 'at the root', exact: true }).count()) === 1, await card.textContent());
    /*
     * Answered, the card goes at once (2026-10-20: it stayed, answered, until the next read of the list) — here every
     * read of the list is the API's answer at the time it was asked, arriving late, so neither the next read nor one
     * already on its way when the answer went may decide it.
     */
    const lists = /\/api\/approvals(\?|$)/;
    let onTheWay = 0;
    await page.route(lists, async (r) => {
      if (r.request().method() !== 'GET') return r.fallback();
      const res = await r.fetch();
      onTheWay += 1;
      await sleep(2_500);
      onTheWay -= 1;
      await r.fulfill({ response: res }).catch(() => undefined);
    });
    // A read with the question in it is on its way, and lands a while before any read made after the answer.
    await waitFor('a read of the list to be on its way', async () => onTheWay > 0, 10_000);
    await sleep(1_000);
    await card.getByRole('button', { name: 'at the root', exact: true }).click();
    t.truthy('answered, the card goes at once', await card.waitFor({ state: 'detached', timeout: 1_000 }).then(() => true, () => false), await page.locator('.cs-lead-turn').textContent());
    let back = 0;
    for (const until = Date.now() + 3_000; Date.now() < until; await sleep(100)) back = Math.max(back, await card.count());
    t.check('and the read that was on its way when the answer went does not bring it back', back, 0);
    await page.unroute(lists);
    release();
    await page.locator('.cs-end').getByText('Nothing needed writing').waitFor({ timeout: 30_000 });
    t.truthy('asked and answered, on the record of the message', ((await page.locator('.cs-lead-qa').textContent()) ?? '').includes('at the root'), await page.locator('.cs-lead-qa').textContent());
    t.check('the worker is not a conversation of the list', await page.locator('#cs-thread option').count(), 2);
    t.check('the started conversation shows how it began: "Two chats" ticked and fixed', [await two.isChecked(), await two.isDisabled()], [true, true]);
    await page.getByRole('tab', { name: en['wb.terminal']!, exact: true }).click();
    await waitFor('the panel to show the worker\'s command', async () => ((await page.locator('.wb-terminal').textContent()) ?? '').includes('Get-ChildItem'), 10_000).catch(() => undefined);
    t.truthy('the panel follows the worker\'s commands', ((await page.locator('.wb-terminal').textContent()) ?? '').includes('Get-ChildItem'), await page.locator('.wb-terminal').textContent());
  });

  /*
   * A subtask cut off, tried again (operator, 2026-10-25): with Settings' "Ask me", a card under the subtask with the
   * reason, the kind and "Attempt 1 of 3", and its three buttons; still there after the page is reloaded; "Try again"
   * runs it under the same number — "Retry 2 of 3" while it runs, "Done at attempt 2" after, the attempt before folded
   * under it with how it ended. Never shown as a subtask of its own.
   */
  const retrySettings = { execution: { mode: 'unattended', isolation: 'none-accepted' }, limits: { retryBlockedInFreshChat: 0, subtaskRetryWaitSec: 0 }, report: { uploadRetries: 0 } };
  const retryWorkerDone = 'I wrote result.txt in the project folder and read it back: it holds exactly the word hello, as the subtask asked.';
  const retryLeadDone = 'The work is finished: the worker wrote result.txt and read it back, and it holds exactly the word hello, as the assignment asked.';
  const cutOff = (): string => {
    throw new Error('net::ERR_CONNECTION_RESET: the answer stopped coming');
  };
  const openThread = async (page: Page, url: (p: string) => string, id: string): Promise<void> => {
    await page.goto(url('/'));
    await page.evaluate((x) => localStorage.setItem('cop.chat.thread', x), id);
    await page.reload();
  };
  await scenario('two chats: a subtask cut off asks on a card that outlives a reload, is tried again, its attempts shown', retrySettings, async (h, page, url) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    h.chat.script(
      reply.lead.delegate({ title: 'Write result.txt', readOnly: false, goal: 'Create result.txt holding exactly the word hello.' }, { understanding: 'A file result.txt holding hello; said what was done.' }),
      cutOff,
      async () => {
        await held;
        return reply.steps(write('result.txt', 'hello'));
      },
      reply.done(retryWorkerDone),
      reply.lead.done(retryLeadDone),
    );
    const sent = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create result.txt holding hello, and say what was done.', model: 'Think deeper', lead: true });
    await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
    await openThread(page, url, sent.threadId);
    const card = page.locator('.cs-retry');
    await card.waitFor({ timeout: 30_000 });
    const sub = page.locator('details.cs-subtask');
    t.check(
      'the card: which subtask, "Attempt 1 of 3", the kind of failure, the reason, and its three choices',
      [
        (await card.locator('.cs-ask-head strong').textContent())?.trim(),
        await card.locator('.badge').allTextContents(),
        ((await card.textContent()) ?? '').includes('ERR_CONNECTION_RESET'),
        await card.getByRole('button').allTextContents(),
      ],
      [en['retry.title']!.replace('{n}', '1'), [en['retry.attempt']!.replace('{k}', '1').replace('{m}', '3'), en['retry.catTransient']], true, [en['retry.same'], en['retry.fresh'], en['retry.accept']]],
    );
    // The worker's session is read on its own, every second and a half: its attempt ended a moment before the card.
    t.truthy('beside the subtask\'s title too: "Attempt 1 of 3"', await appears(sub.locator(':scope > summary .cs-attempt').filter({ hasText: en['retry.attempt']!.replace('{k}', '1').replace('{m}', '3') }), 10_000), await sub.locator(':scope > summary').textContent());
    // The page reloaded under it (14): the card is asked for again and is there, the run still waiting on it.
    await page.reload();
    t.truthy('after a reload, the card is still there', await appears(page.locator('.cs-retry'), 15_000), await page.locator('.cs-lead-turn').textContent().catch(() => ''));
    await page.locator('.cs-retry').getByRole('button', { name: en['retry.same']!, exact: true }).click();
    t.truthy('chosen, the card goes', await page.locator('.cs-retry').waitFor({ state: 'detached', timeout: 5_000 }).then(() => true, () => false), '');
    const retrying = en['retry.retrying']!.replace('{k}', '2').replace('{m}', '3');
    t.truthy('while it is tried again: "Retry 2 of 3"', await appears(sub.locator(':scope > summary .cs-attempt').filter({ hasText: retrying }), 15_000), await sub.locator(':scope > summary').textContent());
    t.check('and the attempt before folded under it', ((await sub.locator('.cs-attempts > summary').textContent()) ?? '').trim(), en['retry.earlier']!.replace('{n}', '1'));
    release();
    await page.locator('.cs-end').filter({ hasText: 'The work is finished' }).waitFor({ timeout: 30_000 });
    await waitFor('"Done at attempt 2"', async () => ((await sub.locator(':scope > summary').textContent()) ?? '').includes(en['retry.doneAt']!.replace('{k}', '2')) || null, 10_000).catch(() => undefined);
    t.check('one subtask, not two: done at attempt 2', [await sub.count(), ((await sub.locator(':scope > summary').textContent()) ?? '').includes(en['retry.doneAt']!.replace('{k}', '2'))], [1, true]);
    if (!(await sub.evaluate((d) => (d as HTMLDetailsElement).open))) await sub.locator(':scope > summary').first().click();
    await sub.locator('.cs-attempts > summary').click();
    const before = sub.locator('.cs-attempt-line').first();
    t.truthy(
      'the attempt before: its number, how it ended, what it ran, and that the folder did not change',
      ((await before.textContent()) ?? '').includes(en['retry.attempt']!.replace('{k}', '1').replace('{m}', '3')) &&
        ((await before.textContent()) ?? '').includes(en['retry.catTransient']!) &&
        ((await before.textContent()) ?? '').includes(en['retry.commands']!.replace('{started}', '0').replace('{completed}', '0')) &&
        ((await before.textContent()) ?? '').includes(en['retry.repoSame']!),
      await before.textContent(),
    );
  });

  /*
   * After a Stop (2026-10-25): the subtask is not tried again by itself; under it, "Try again" and "Try with a new worker"
   * carry the message on with it first, under its own number, and the lead goes on.
   */
  await scenario('two chats: after Stop, a subtask that did not finish is tried again from under it', retrySettings, async (h, page, url) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    h.chat.script(
      reply.lead.delegate({ title: 'Write result.txt', readOnly: false, goal: 'Create result.txt holding exactly the word hello.' }, { understanding: 'A file result.txt holding hello; said what was done.' }),
      async () => {
        await held;
        return reply.steps(write('result.txt', 'hello'));
      },
    );
    const sent = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create result.txt holding hello, and say what was done.', model: 'Think deeper', lead: true });
    await h.call('POST', `/sessions/${sent.threadId}/start`, { mode: 'unattended' });
    await waitFor('the worker to be answering', async () => h.chat.pending === 0 || null, 20_000);
    await h.call('POST', `/sessions/${sent.threadId}/stop`, {});
    release();
    await h.idle();
    await openThread(page, url, sent.threadId);
    const group = page.getByRole('group', { name: en['retry.afterStop']! });
    t.truthy('under the stopped subtask: try it again, or with a new worker', await appears(group, 15_000) && (await group.getByRole('button').allTextContents()).join('|') === [en['retry.same'], en['retry.fresh']].join('|'), await page.locator('.cs-lead-turn').textContent());
    t.check('nothing was tried again by itself', (await h.call<{ tasks: Array<{ status: string }> }>('GET', `/sessions/${sent.threadId}`)).tasks.map((x) => x.status), ['aborted']);
    h.chat.script(reply.steps(write('result.txt', 'hello')), reply.done(retryWorkerDone), reply.lead.done(retryLeadDone));
    await group.getByRole('button', { name: en['retry.same']!, exact: true }).click();
    await page.locator('.cs-end').filter({ hasText: 'The work is finished' }).waitFor({ timeout: 30_000 });
    const sub = page.locator('details.cs-subtask');
    await waitFor('"Done at attempt 2"', async () => ((await sub.locator(':scope > summary').textContent()) ?? '').includes(en['retry.doneAt']!.replace('{k}', '2')) || null, 10_000).catch(() => undefined);
    t.check('done at attempt 2, one subtask, and no "try again" under it any more', [await sub.count(), ((await sub.locator(':scope > summary').textContent()) ?? '').includes(en['retry.doneAt']!.replace('{k}', '2')), await page.getByRole('group', { name: en['retry.afterStop']! }).count()], [1, true, 0]);
    if (!(await sub.evaluate((d) => (d as HTMLDetailsElement).open))) await sub.locator(':scope > summary').first().click();
    await sub.locator('.cs-attempts > summary').click();
    t.truthy('the attempt the Stop ended, kept: "Stopped"', ((await sub.locator('.cs-attempt-line').first().textContent()) ?? '').includes(en['retry.catStopped']!), await sub.locator('.cs-attempt-line').first().textContent());
  });

  /*
   * "Language" (operator, 2026-10-20): the button reads "Language" in every language, opens the nine with their flags,
   * each in its own name, the one in use ticked; Arabic turns the page right to left and back. On the chat's screen,
   * System is beside Settings in the bar on top.
   */
  await scenario('the "Language" menu: nine languages with flags, "Language" in every one, Arabic right to left', {}, async (_h, page, url) => {
    await page.goto(url('/'));
    const top = page.locator('.wb-menu');
    await top.getByRole('link', { name: en['nav.system']!, exact: true }).waitFor();
    t.check('on the chat\'s screen: the queue, Settings and System on top', await top.getByRole('link').evaluateAll((as) => as.map((a) => a.getAttribute('href'))), ['/queue', '/settings', '/system']);
    const button = top.getByRole('button', { name: 'Language', exact: true });
    await button.click();
    const items = page.getByRole('menuitemradio');
    t.check('nine languages, each with its flag', [await items.count(), await page.locator('.lang-list .flag').count()], [9, 9]);
    t.check('the one in use is ticked', await page.getByRole('menuitemradio', { checked: true }).allTextContents().then((x) => x.map((v) => v.replace(/✓/g, '').trim())), ['English']);
    t.check('flags drawn, not emoji', await page.locator('.lang-list .flag').first().evaluate((el) => el.tagName.toLowerCase()), 'svg');
    const ja = (dict as unknown as Record<string, Record<string, string>>).ja!;
    await page.getByRole('menuitemradio', { name: /日本語/ }).click();
    await waitFor('the page in Japanese', async () => (await page.evaluate(() => document.documentElement.lang)) === 'ja', 10_000).catch(() => undefined);
    t.check('chosen Japanese: the page in Japanese, and "Language" still in English', [await page.evaluate(() => document.documentElement.lang), ((await top.getByRole('link', { name: ja['nav.defaults']!, exact: true }).textContent()) ?? '').trim(), await button.textContent().then((x) => (x ?? '').replace('▾', '').trim())], ['ja', ja['nav.defaults'], 'Language']);
    await button.click();
    await page.getByRole('menuitemradio', { name: /العربية/ }).click();
    await waitFor('the page right to left', async () => (await page.evaluate(() => document.documentElement.dir)) === 'rtl', 10_000).catch(() => undefined);
    t.check('chosen Arabic: right to left', await page.evaluate(() => [document.documentElement.dir, document.documentElement.lang]), ['rtl', 'ar']);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    t.truthy('and nothing scrolls sideways', over <= 1, over);
    await page.reload();
    await waitFor('the language to come back', async () => (await page.evaluate(() => document.documentElement.lang)) === 'ar', 10_000).catch(() => undefined);
    t.check('remembered: still Arabic and right to left after a reload', await page.evaluate(() => [document.documentElement.dir, document.documentElement.lang]), ['rtl', 'ar']);
    await top.getByRole('button', { name: 'Language', exact: true }).click();
    await page.getByRole('menuitemradio', { name: /English/ }).click();
    await waitFor('the page left to right', async () => (await page.evaluate(() => document.documentElement.dir)) === 'ltr', 10_000).catch(() => undefined);
    t.check('back to English: left to right', await page.evaluate(() => [document.documentElement.dir, document.documentElement.lang]), ['ltr', 'en']);
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
