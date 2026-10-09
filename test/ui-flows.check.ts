/**
 * The browser flows that start, hold and undo work, and the release gate that should keep them honest.
 *
 * test/ui.check.ts covers what a page looks like: text sizes, widths, labels. This file covers what a
 * page *does* when the operator presses the buttons that give the bot autonomy or take it back — the
 * places where a wrong click costs a night of unattended commands or a branch moved under somebody:
 *
 * - the release: `.github/workflows/publish.yml` must run `npm run check:ui` (and install the browser
 *   it drives) before `npm publish`, or no browser check guards a release; `check:ui` runs
 *   test/ui.check.ts and this file, and the workflow runs every other part of `check:all` too;
 * - an unattended start asks "are you sure" unless Settings say not to, and Cancel changes nothing;
 * - the approvals banner: "run the rest without asking" really switches the run, "Abort task" really
 *   stops it, a download is never offered "the rest", and the card names the session;
 * - the run panel on the Sessions page: tick order, moving, the name, "carry on", an inactive session
 *   left out, a refusal said where it cannot be missed, dead buttons that say why;
 * - the import page handing its sessions to the run panel once, and naming a duplicate before making it;
 * - pause, take the hold off and stop, from the page, with the next session left untouched;
 * - Restore on a register row: the question, Cancel, and the answer under that row only;
 * - Settings that gate autonomy, and the number fields that used to fight the typing;
 * - the task card's editor, which used to start from a stale prompt;
 * - a queued task started from its own row or card: the run offered in the dialog that saved its fix,
 *   surviving the register's reload; this one and the ones after it, earlier tasks untouched; a task that
 *   contradicts itself offered its smallest fix, stale choices refused; an inactive session refused before
 *   any browser; two tasks of one title told apart; the status marker saying it is not a button;
 * - the rarer parts of a task card (review, scope put back, foreign commit, suspicious file, fresh-chat
 *   retry) rendering without an error;
 * - both languages having the same keys and placeholders, and Bulgarian fitting on a phone;
 * - the changes view by keyboard.
 *
 * The browser is Playwright's headless Chromium with a fresh profile, pointed only at the loopback port
 * of the check's own API, which serves the static build in `dist/web` exactly as `npx cop start` does.
 * The chat is the scripted one of test/support/fakeChat.ts; the steps it sends run for real in a
 * throwaway repository. Nothing here opens Edge or Copilot or touches the operator's data.
 *
 *   npm run check:ui            (builds the package, then runs test/ui.check.ts and this file)
 *   npm run check:ui-flows      (this file alone, on an interface already built with `npm run build:package`)
 *
 * Set COP_UI_SHOTS to a folder to keep a screenshot of every scenario that fails.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Response as PwResponse } from 'playwright';
import { startHarness, waitFor, Tally, type Harness, type SessionView } from './support/harness.js';
import { reply } from './support/fakeChat.js';
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
type Batch = {
  name?: string;
  mode: string;
  onFailure: string;
  running: boolean;
  pausing: boolean;
  stopping: boolean;
  sessions: Array<{ sessionId: string; name: string; state: string; reason?: string }>;
};
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
    const a = await h.call<{ running: boolean; batch: boolean }>('GET', '/activity').catch(() => ({ running: false, batch: false }));
    if (!a.running && !a.batch) return;
    await h.call('POST', '/batch/stop').catch(() => undefined);
    for (const s of await h.call<Array<{ id: string; running?: boolean }>>('GET', '/sessions').catch(() => [])) {
      if (s.running) await h.call('POST', `/sessions/${s.id}/stop`).catch(() => undefined);
    }
    for (const w of await h.call<Approval[]>('GET', '/approvals').catch(() => [])) {
      await h.call('POST', `/approvals/${w.id}`, { action: 'abort' }).catch(() => undefined);
    }
    await sleep(300);
  }
}

const batchOf = async (h: Harness): Promise<Batch> => await h.call<Batch>('GET', '/batch');
const settingsOf = async (h: Harness): Promise<Raw['raw']> => (await h.call<Raw>('GET', '/settings')).raw;
/** The session names in the run panel's order list, without their queued counts. */
const runOrder = async (page: Page): Promise<string[]> =>
  await page.locator('ol.run-order > li').evaluateAll((els) => els.map((li) => (li.querySelector('span')?.textContent ?? '').replace(/\s*\(\d+\)\s*$/, '').trim()));
/** Whether an element shows up within `ms`, without failing when it does not. */
const appears = async (loc: ReturnType<Page['locator']>, ms: number): Promise<boolean> => await loc.waitFor({ timeout: ms }).then(() => true, () => false);
/**
 * Every POST the page sends from now on, by path. A Cancel is judged by what the page asked the API
 * to do, not by waiting to see whether an effect lands: a request goes out the moment the code goes
 * ahead, while its effect (a file written, a checkout) may come after any sleep on a loaded machine.
 * Emptied with `sent.length = 0`.
 */
const recordPosts = (page: Page): string[] => {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST') sent.push(new URL(r.url()).pathname);
  });
  return sent;
};

try {
  browser = await chromium.launch({ headless: true });

  /*
   * "Continue without asking" starts commands nobody will read. The question before it is the one
   * safety the operator has on that button, so it must come every time — unless Settings → Execution
   * says an unattended start needs no question, and then it must not come at all.
   */
  const toTheLimit = async (h: Harness): Promise<string> => {
    const [s] = await h.importPlan(planFor(h, 'limit'));
    for (let i = 1; i <= 6; i++) h.chat.script(reply.steps(`Write-Output 'round ${i}'`));
    const stopped = await h.run(s!.id);
    h.chat.discard();
    t.check('the task stopped at the limit', stopped.tasks[0]!.status, 'limit-reached');
    return s!.id;
  };
  const openContinueHere = async (page: Page, url: (p: string) => string): Promise<ReturnType<Page['locator']>> => {
    await page.goto(url('/history'));
    await page.waitForLoadState('networkidle');
    const row = page.locator('ol.flow > li', { hasText: 'write-greeting' }).first();
    // The panel reads Settings when it opens; the click below is judged against what it read.
    const read = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/settings' && r.request().method() === 'GET');
    await row.getByRole('button', { name: 'Continue where it stopped' }).click();
    await read;
    const panel = row.getByRole('group', { name: 'Continue “write-greeting” where it stopped' });
    await panel.waitFor();
    await sleep(200);
    return panel;
  };

  await scenario('an unattended start is asked about, and Cancel changes nothing', { limits: { maxIterations: 5 } }, async (h, page, url) => {
    const id = await toTheLimit(h);
    const sentBefore = h.chat.sent.length;
    const panel = await openContinueHere(page, url);
    const posts = recordPosts(page);
    // What going ahead would send: the task queued to carry on, then a run of it started.
    const startRequests = (): string[] => posts.filter((p) => p.endsWith('/continue') || p.endsWith('/batch/start'));
    const button = panel.getByRole('button', { name: 'Continue without asking' });
    await button.click();
    const dialog = page.getByRole('alertdialog');
    const asked = await appears(dialog, 3_000);
    t.check('an "are you sure" dialog appears within 3 s', asked, true);
    if (!asked) return;
    t.truthy('it says the commands will run without asking', ((await dialog.textContent()) ?? '').includes('without asking you'), await dialog.textContent());
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    t.check('Cancel sends neither "continue" nor "start"', startRequests(), []);
    t.check('Cancel leaves the task where it stopped', (await cards(h, id))[0]!.status, 'limit-reached');
    t.check('and nothing was started or sent to the chat', [(await h.call<{ running: boolean }>('GET', '/activity')).running, h.chat.sent.length - sentBefore], [false, 0]);

    // The next deliberate click, answered OK. Had Cancel gone ahead late, its requests were issued
    // before this click and are counted here too: exactly one of each means Cancel sent none.
    h.chat.script(reply.steps(write('hello.txt', 'hi')), reply.done());
    await button.click();
    await dialog.waitFor({ timeout: 3_000 });
    await dialog.getByRole('button', { name: 'OK' }).click();
    const left = await waitFor('the task to leave limit-reached', async () => (await cards(h, id))[0]!.status !== 'limit-reached', 15_000).then(() => true, () => false);
    t.truthy('OK: the task leaves limit-reached', left);
    // Queued first, then started once version control is checked (before the browser opens): wait for
    // the run, not for "nothing running", which is also true in the moment between the two.
    await waitFor('the task to be carried on to done', async () => (await cards(h, id))[0]!.status === 'done', 30_000).catch(() => undefined);
    await h.idle();
    t.check('and is carried on to done', (await cards(h, id))[0]!.status, 'done');
    t.check('with one "continue" and one "start" in all, both from OK', startRequests().map((p) => p.replace(/^.*\//, '')), ['continue', 'start']);
  });

  await scenario('with Settings saying "do not ask", the same button starts at once', { limits: { maxIterations: 5 }, execution: { mode: 'unattended' } }, async (h, page, url) => {
    const id = await toTheLimit(h);
    const panel = await openContinueHere(page, url);
    h.chat.script(reply.steps(write('hello.txt', 'hi')), reply.done());
    await panel.getByRole('button', { name: 'Continue without asking' }).click();
    const dialog = page.getByRole('alertdialog');
    const asked = await appears(dialog, 1_000);
    t.check('no dialog within 1 s', asked, false);
    if (asked) await dialog.getByRole('button', { name: 'OK' }).click();
    const left = await waitFor('the task to leave limit-reached', async () => (await cards(h, id))[0]!.status !== 'limit-reached', 15_000).then(() => true, () => false);
    t.truthy('the task left limit-reached', left);
    await h.idle();
    t.check('and was carried on to done', (await cards(h, id))[0]!.status, 'done');
  });

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
    await page.goto(url('/history'));
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
   * The run panel on the Sessions page. A tick puts a session in the list's order, top to bottom, not in
   * click order (since 2026-10-01 the list is the operator's order, and each import comes in on top, so
   * three plans imported alpha, bravo, charlie list charlie first); the arrows reorder; the name and
   * "carry on" reach the run; an inactive session cannot be ticked and leaves the selection.
   */
  await scenario('the run panel: tick order, moving, the name and "carry on" reach the run, an inactive session is left out', {}, async (h, page, url) => {
    const ids: Record<string, string> = {};
    for (const name of ['alpha', 'bravo', 'charlie']) {
      ids[name] = (await h.importPlan(planFor(h, name, [task(`${name}-task`, `${name}.txt`)])))[0]!.id;
      await sleep(30);
    }
    await page.goto(url('/'));
    const tick = (name: string) => page.getByRole('checkbox', { name, exact: true });
    await tick('charlie').waitFor();
    await tick('charlie').check();
    await tick('alpha').check();
    t.check('ticked alpha after charlie: listed as the list shows them, top to bottom', await runOrder(page), ['charlie', 'alpha']);
    await tick('bravo').check();
    t.check('bravo takes its place between them', await runOrder(page), ['charlie', 'bravo', 'alpha']);

    await page.getByRole('checkbox', { name: 'Manage bravo' }).check();
    await page.getByRole('button', { name: 'Make inactive' }).click();
    await page.getByText(/1 session\(s\) are inactive/).waitFor();
    // The message is set before the list is read again; the checkbox turns off only once that read lands.
    const disabled = await waitFor('bravo to be disabled', async () => await tick('bravo').isDisabled(), 5_000).then(() => true, () => false);
    t.truthy('made inactive, bravo cannot be ticked', disabled);
    t.check('and it left the selection', [await tick('bravo').isChecked(), await runOrder(page)], [false, ['charlie', 'alpha']]);

    await page.getByRole('button', { name: 'Move charlie down', exact: true }).click();
    t.check('↓ on charlie puts it after alpha', await runOrder(page), ['alpha', 'charlie']);
    await page.locator('#batch-run-name').fill('nightly');
    await page.getByRole('radio', { name: 'Carry on with the next session' }).check();

    h.chat.script(reply.steps('Write-Output charlie'));
    await page.getByRole('button', { name: 'Step by step' }).click();
    const b = await waitFor('the run to start', async () => {
      const x = await h.call<Batch | null>('GET', '/batch');
      return x?.running ? x : null;
    }, 15_000);
    t.check('the run has the sessions in the order shown', b.sessions.map((s) => s.name), ['alpha', 'charlie']);
    t.check('its name and "carry on" are the ones chosen, step by step', [b.name, b.onFailure, b.mode], ['nightly', 'continue', 'confirm']);
    t.check('bravo is not in it', b.sessions.some((s) => s.sessionId === ids.bravo), false);
    await waitFor('the first step to wait', async () => (await h.call<Approval[]>('GET', '/approvals')).length > 0, 30_000);
    // Only teardown: what the stop answers is pinned in the hold scenario below, not here, so a
    // failure of it must not end this scenario; settle() clears whatever is left.
    await h.call('POST', '/batch/stop').catch(() => undefined);
    await h.idle();
  });

  await scenario('the run panel: dead buttons say why, and a refused start is said where it cannot be missed', { execution: { isolation: 'none' } }, async (h, page, url) => {
    await h.importPlan(planFor(h, 'solo', [task('solo-task', 'solo.txt')]));
    await page.goto(url('/'));
    const run = page.getByRole('button', { name: /^Run \d+ session\(s\)$/ });
    const step = page.getByRole('button', { name: 'Step by step' });
    await run.waitFor();
    t.check('nothing ticked: both start buttons are disabled', [await run.isDisabled(), await step.isDisabled()], [true, true]);
    t.truthy('and the notice says to pick sessions first', await page.getByText(en['batch.pickFirst']!).isVisible());
    t.truthy('and how', await page.getByText(en['batch.pickFirstWhy']!).isVisible());

    await page.getByRole('checkbox', { name: 'solo', exact: true }).check();
    await page.getByRole('button', { name: 'Run 1 session(s)' }).click();
    const confirm = page.getByRole('alertdialog');
    await confirm.waitFor({ timeout: 3_000 });
    await confirm.getByRole('button', { name: 'OK' }).click();
    const alert = page.getByRole('alert').filter({ hasText: en['batch.notStartedTitle']! });
    await alert.waitFor();
    const said = (await alert.textContent()) ?? '';
    t.truthy('the refusal is shown as an alert, with the reason', /execution\.isolation/.test(said) && said.includes('refused'), said);
    const toSettings = alert.getByRole('link', { name: en['batch.notStartedIsolation']! });
    t.truthy('with a link to Settings', /\/defaults\/?$/.test((await toSettings.getAttribute('href')) ?? ''), await toSettings.getAttribute('href'));
    t.check('and nothing ran: no batch, no chat opened', [await h.call<unknown>('GET', '/batch'), h.chat.opened], [null, 0]);
  });

  /*
   * An import hands its sessions to the run panel through the address once, then removes the query so a
   * later visit does not re-tick them. The same plan pasted twice is named before a second copy is made.
   */
  await scenario('import hands its sessions to the run panel once, and a duplicate paste is named first', {}, async (h, page, url) => {
    const plan: Plan = {
      version: 1,
      onFailure: 'continue',
      sessions: [session(h, 'first', [task('first-task', 'first.txt')]), session(h, 'second', [task('second-task', 'second.txt')])],
    };
    const text = JSON.stringify(plan, null, 2);
    const named = async (name: string): Promise<number> => (await h.call<Array<{ name: string }>>('GET', '/sessions')).filter((s) => s.name === name).length;

    await page.goto(url('/import'));
    const box = page.getByRole('textbox', { name: en['plan.placeholder']! });
    await box.fill(text);
    await page.getByRole('button', { name: 'Create the sessions and tasks' }).click();
    await page.getByText(/Created 2 session\(s\) with 2 task\(s\)/).waitFor();
    await page.getByRole('link', { name: 'Run these sessions' }).click();
    await waitFor('the Sessions page with the query removed', async () => {
      const u = new URL(page.url());
      return u.pathname === '/' && u.search === '';
    }, 10_000);
    await page.locator('ol.run-order > li').first().waitFor();
    t.check('its sessions are ticked, in plan order', await runOrder(page), ['first', 'second']);
    t.check('"Carry on with the next session" is chosen, as the plan said', await page.getByRole('radio', { name: 'Carry on with the next session' }).isChecked(), true);
    t.check('and the address is plain /', [new URL(page.url()).pathname, new URL(page.url()).search], ['/', '']);
    await page.reload();
    await page.getByRole('checkbox', { name: 'first', exact: true }).waitFor();
    await sleep(500);
    t.check('a reload does not tick them again', [await page.locator('ol.run-order > li').count(), await page.getByRole('checkbox', { name: 'first', exact: true }).isChecked()], [0, false]);

    await page.goto(url('/import'));
    await box.fill(text);
    const posts = recordPosts(page);
    const imports = (): string[] => posts.filter((p) => p.endsWith('/plan/import'));
    await page.getByRole('button', { name: 'Create the sessions and tasks' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor({ timeout: 5_000 });
    const question = (await dialog.textContent()) ?? '';
    t.truthy('the question names the sessions that already exist', question.includes('• first (1)') && question.includes('• second (1)'), question);
    posts.length = 0;
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    t.check('Cancel sends no import', imports(), []);
    t.check('Cancel: still one session called first', await named('first'), 1);
    await page.getByRole('button', { name: 'Create the sessions and tasks' }).click();
    await dialog.waitFor({ timeout: 5_000 });
    await dialog.getByRole('button', { name: 'OK' }).click();
    await waitFor('the second copy', async () => (await named('first')) === 2, 10_000).catch(() => undefined);
    t.check('OK: a second copy is made', await named('first'), 2);
    // Counted from before Cancel: a late import from Cancel would have been sent before this OK.
    t.check('one import in all since Cancel, the one OK sent', imports().length, 1);

    await box.fill('{"version":1}');
    await page.getByRole('button', { name: 'Check it' }).click();
    const invalid = page.locator('.panel', { has: page.getByText(en['plan.invalid']!) });
    await invalid.waitFor();
    const listed = (await invalid.locator('pre').textContent()) ?? '';
    const expected = await h.call<{ ok: boolean; issues?: Array<{ path?: string; message: string }> }>('POST', '/plan/check', { text: '{"version":1}' });
    const issues = expected.issues ?? [];
    t.truthy(
      'the invalid panel lists every issue with its path',
      issues.length > 0 && issues.some((i) => i.path) && issues.every((i) => listed.includes(i.path ? `- ${i.path}: ${i.message}` : `- ${i.message}`)),
      { listed, issues },
    );
  });

  /*
   * Pause holds the queue after the task in flight, which then finishes properly; the next session is
   * left exactly as it was. "Take the hold off" and "Stop after the current step" are pressed on the
   * same page and must reach the API.
   */
  await scenario('a run held from the Sessions page: pause, take the hold off, pause again, then stop', {}, async (h, page, url) => {
    const [one, two] = await h.importPlan({ version: 1, sessions: [session(h, 'hold-one', [task('held-task', 'held.txt')]), session(h, 'hold-two', [task('untouched-task', 'untouched.txt')])] });
    h.chat.script(reply.steps(write('held.txt', 'held')), reply.done());
    await h.call('POST', '/batch/start', { sessionIds: [one!.id, two!.id], mode: 'confirm' });
    const waiting = await waitFor('the first step to wait', async () => (await h.call<Approval[]>('GET', '/approvals'))[0], 30_000);
    await page.goto(url('/'));
    // The button's own request, answered whatever its status: the state read after it is the state that
    // request left, and a refused request is reported by its status instead of as a timeout.
    const request = (path: string) =>
      page.waitForResponse((r) => new URL(r.url()).pathname === `/api/batch/${path}` && r.request().method() === 'POST');
    const accepted = async (what: string, r: PwResponse): Promise<void> =>
      t.truthy(what, r.status() < 300, `HTTP ${r.status()}: ${(await r.text().catch(() => '')).slice(0, 300)}`);

    const pause = page.getByRole('button', { name: 'Pause after this task' });
    await pause.waitFor();
    const [paused] = await Promise.all([request('pause'), pause.click()]);
    await accepted('Pause is accepted', paused);
    t.check('Pause: the run is holding', (await batchOf(h)).pausing, true);
    const resume = page.getByRole('button', { name: 'Take the hold off' });
    await resume.waitFor();
    const [resumed] = await Promise.all([request('resume'), resume.click()]);
    await accepted('Take the hold off is accepted', resumed);
    t.check('Take the hold off: it is not holding any more', [(await batchOf(h)).pausing, (await batchOf(h)).running], [false, true]);
    await pause.waitFor();
    const [pausedAgain] = await Promise.all([request('pause'), pause.click()]);
    await accepted('Pause again is accepted', pausedAgain);
    t.check('Pause again: holding', (await batchOf(h)).pausing, true);

    await h.call('POST', `/approvals/${waiting.id}`, { action: 'run' });
    await h.idle();
    const held = await batchOf(h);
    t.check('the task in flight finished, and the run ended there', [held.running, (await cards(h, one!.id))[0]!.status], [false, 'done']);
    const second = held.sessions.find((s) => s.sessionId === two!.id);
    t.truthy('the second session was not started, and the run says it was paused', second?.state === 'skipped' && /paused/.test(second.reason ?? ''), second);
    const untouched = (await cards(h, two!.id))[0]!;
    t.check('its task is still queued and never started', [untouched.status, untouched.startedAt ?? null, untouched.runId ?? null], ['queued', null, null]);
    t.check('only one conversation was ever opened', h.chat.conversations.size, 1);

    h.chat.script(reply.steps(write('stopped.txt', 'no')));
    await h.call('POST', '/batch/start', { sessionIds: [two!.id], mode: 'confirm' });
    await waitFor('its step to wait', async () => (await h.call<Approval[]>('GET', '/approvals')).length > 0, 30_000);
    const stop = page.getByRole('button', { name: 'Stop after the current step' });
    await stop.waitFor();
    const [stopResponse] = await Promise.all([request('stop'), stop.click()]);
    /*
     * "Stop after the current step" says the task it interrupts ends aborted. `stop()` answers the waiting
     * step with abort and, in the same breath, writes `status: 'stopping'` to the session file, while the
     * runner writes the aborted task to the same file. The store takes the two writes in turn, each through
     * a temporary file of its own. When both went through one `<file>.<pid>.tmp`, one rename found the temp
     * file already renamed away, and which side lost varied from run to run: either the stop's own save
     * threw and the page's Stop was answered 500, or the task died "failed: Could not save …: ENOENT".
     * Both sides are pinned by name, so a race brought back is reported whichever way it lands, and every
     * other check below still runs.
     */
    await accepted('Stop is accepted, not a 500 from the save race', stopResponse);
    t.check('Stop: the run is stopping', (await batchOf(h)).stopping, true);
    await h.idle();
    const stopped = await batchOf(h);
    t.check('and then over, its waiting step never run', [stopped.running, existsSync(join(h.repo, 'stopped.txt'))], [false, false]);
    const cut = (await cards(h, two!.id))[0]!;
    // The runner's write of the aborted task is taken in its turn after the stop's, not lost to it.
    t.check('the interrupted task ends aborted, not failed on a save', [cut.status, /Could not save/.test(cut.reason ?? '')], ['aborted', false]);
  });

  /*
   * Restore moves the repository to a new branch at the commit a task started from. The question must
   * say which commit and which branch the later work stays on; Cancel must move nothing; the answer
   * must appear under the row that was pressed and no other (one hook serves the whole list).
   */
  await scenario('Restore on a register row: named commit and branch, Cancel moves nothing, the answer under that row only', {}, async (h, page, url) => {
    const [s] = await h.importPlan(planFor(h, 'undo', [task('first-file', 'one.txt'), task('second-file', 'two.txt')]));
    h.chat.script(reply.steps(write('one.txt', 'one')), reply.done(), reply.steps(write('two.txt', 'two')), reply.done());
    const ran = await h.run(s!.id);
    t.check('both tasks done', ran.tasks.map((x) => x.status), ['done', 'done']);
    const base = ran.tasks[0]!.vcs?.baseCommit ?? '';
    const branch = ran.tasks[0]!.vcs?.branch ?? '';
    const head = h.git('rev-parse', 'HEAD');
    t.check('the repository is left on the session branch', [h.git('branch', '--show-current'), branch], ['cop/undo', 'cop/undo']);

    await page.goto(url('/history'));
    const row1 = page.locator('ol.flow > li', { hasText: 'first-file' }).first();
    const row2 = page.locator('ol.flow > li', { hasText: 'second-file' }).first();
    const posts = recordPosts(page);

    /*
     * "Run again from here" names the commits it moves aside and what becomes of each task before it
     * asks, not only how many (operator feedback 2026-10-08). Cancel moves nothing.
     */
    await row1.getByRole('button', { name: 'Run again from here', exact: true }).click();
    const again = page.getByRole('alertdialog');
    await again.waitFor();
    const asked = (await again.textContent()) ?? '';
    const moved = h.git('log', '--oneline', `${base}..cop/undo`).split('\n').filter(Boolean);
    t.truthy('the question lists every commit that leaves the line, by hash and subject', moved.length === 2 && moved.every((c) => asked.includes(c)), { moved, asked });
    t.check('and says each finished task runs again', asked.split('(done — runs again').length - 1, 2);
    await again.getByRole('button', { name: 'Cancel', exact: true }).click();
    await again.waitFor({ state: 'detached' });
    t.check('Cancel sends no restart', posts.filter((p) => p.endsWith('/restart')), []);
    posts.length = 0;
    // The question is asked after a GET of what would happen; only a POST to this path moves anything.
    const restores = (): string[] => posts.filter((p) => p.endsWith(`/tasks/${ran.tasks[0]!.id}/restore`));
    await row1.getByRole('button', { name: 'Restore', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    const question = (await dialog.textContent()) ?? '';
    t.truthy('the question names the 8-character base commit and the branch the work stays on', base.length === 40 && question.includes(base.slice(0, 8)) && question.includes(branch), question);
    posts.length = 0;
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    t.check('Cancel sends no restore', restores(), []);
    t.check('Cancel: HEAD and the branch unchanged', [h.git('rev-parse', 'HEAD'), h.git('branch', '--show-current')], [head, 'cop/undo']);

    await row1.getByRole('button', { name: 'Restore', exact: true }).click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'OK' }).click();
    const answer = row1.getByText(/^The repository is on /);
    await answer.waitFor();
    // Counted from before Cancel: a late restore from Cancel would have been sent before this OK,
    // and the OK below ends on a cop/restore- branch either way, so only the count can tell.
    t.check('one restore in all since Cancel, the one OK sent', restores().length, 1);
    t.truthy('the answer is under that row', ((await answer.textContent()) ?? '').includes('cop/restore-'), await answer.textContent());
    t.check('and under no other', await row2.getByText(/The repository is on /).count(), 0);
    t.truthy('the repository is on a new cop/restore- branch at the base commit', h.git('branch', '--show-current').startsWith('cop/restore-') && h.git('rev-parse', 'HEAD') === base, [h.git('branch', '--show-current'), h.git('rev-parse', 'HEAD')]);
    t.check('and the work is still on the session branch', h.git('rev-parse', 'cop/undo'), head);
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
    await page.locator('nav a[href="/"]').click();
    await waitFor('the Sessions page', async () => new URL(page.url()).pathname === '/', 10_000);
    await waitFor('the retry count to be saved', async () => (await settingsOf(h)).limits?.retryBlockedInFreshChat === 3, 10_000).catch(() => undefined);
    const after = await settingsOf(h);
    t.check('a value typed just before leaving is saved (3)', after.limits?.retryBlockedInFreshChat, 3);
    t.check('the default model chosen meanwhile is still set', after.copilot?.defaultModel, 'Think deeper');
    t.check('and the choices above are still as made', [after.execution?.networkFetch, after.execution?.mode, after.execution?.isolation], ['refuse', 'unattended', 'vm']);
  });

  /*
   * The task card's editor. A queued task is edited in place; a task whose prompt was changed from the
   * register must open with the new text (it used to open with the text the card first rendered, and
   * "Save" wrote the old prompt back); a done task's edit queues it again as a new attempt.
   */
  await scenario('the task card editor: edit a queued task, open on the prompt the register changed, requeue a done one', { limits: { retryBlockedInFreshChat: 0 } }, async (h, page, url, context) => {
    const plan = planFor(h, 'edits', [task('done-task', 'done.txt'), task('blocked-task', 'blocked.txt')]);
    plan.sessions[0]!.onFailure = 'continue';
    const [s] = await h.importPlan(plan);
    h.chat.script(reply.steps(write('done.txt', 'done')), reply.done(), ...reply.triedThenBlocked());
    const ran = await h.run(s!.id);
    t.check('one done, one blocked', ran.tasks.map((x) => x.status), ['done', 'blocked']);
    await h.call('POST', `/sessions/${s!.id}/tasks`, { title: 'queued-task', prompt: 'Create queued.txt in the repository root holding exactly the word queued.' });
    const [done, blocked, queued] = await cards(h, s!.id);

    await page.goto(url(`/sessions/view?id=${s!.id}`));
    const card = (id: string) => page.locator(`div.task[id="${id}"]`);
    // The prompt's box is the one after the "Task" label; the level 2 editor above it is a textarea too.
    const promptBox = (c: ReturnType<typeof card>) => c.locator('label', { hasText: /^Task$/ }).locator('xpath=following-sibling::textarea[1]');

    // A queued task: prompt changed, a check added, saved in place.
    const q = card(queued!.id);
    await q.getByRole('button', { name: 'Edit', exact: true }).click();
    await promptBox(q).fill('Create queued.txt in the repository root holding exactly the word edited.');
    await q.getByRole('button', { name: 'Add a check' }).click();
    await q.getByRole('textbox', { name: 'What it checks' }).fill('says ok');
    t.check('a new check is "the command succeeds"', await q.getByRole('combobox', { name: 'Must be' }).inputValue(), 'exit-zero');
    await q.getByRole('textbox', { name: 'Command' }).fill('echo ok');
    await q.getByRole('button', { name: 'Save', exact: true }).click();
    await waitFor('the edit to be saved', async () => (await cards(h, s!.id))[2]!.checks?.[0]?.run === 'echo ok', 10_000).catch(() => undefined);
    const edited = (await cards(h, s!.id))[2]!;
    t.check('saved: the new prompt and checks[0] running "echo ok"', [edited.prompt, edited.checks?.[0]?.run, edited.checks?.[0]?.expect, edited.status], ['Create queued.txt in the repository root holding exactly the word edited.', 'echo ok', 'exit-zero', 'queued']);

    // The blocked task: opened once with the old prompt, then the prompt is fixed from the register in another tab.
    const b = card(blocked!.id);
    await b.getByRole('button', { name: 'Edit', exact: true }).click();
    t.check('the editor opens on the prompt as it is', await promptBox(b).inputValue(), blocked!.prompt);
    await b.getByRole('button', { name: 'Cancel', exact: true }).click();
    const fixed = 'Create blocked.txt in the repository root holding exactly the word fixed. The file name is right this time.';
    const other = await context.newPage();
    await other.goto(url('/history'));
    const row = other.locator('ol.flow > li', { hasText: 'blocked-task' }).first();
    await row.getByRole('button', { name: 'Fix the prompt and queue it again' }).click();
    const fix = other.getByRole('dialog');
    const box = fix.locator('textarea.prose');
    await waitFor('the fix dialog to read the task', async () => (await box.count()) > 0 && (await box.inputValue()) !== '', 10_000);
    await box.fill(fixed);
    await fix.getByRole('button', { name: 'Save and queue again' }).click();
    await waitFor('the fixed prompt to be queued', async () => {
      const x = (await cards(h, s!.id))[1]!;
      return x.status === 'queued' && x.prompt === fixed;
    }, 10_000);
    await other.close();
    await waitFor('the card to show the task queued again', async () => ((await b.locator('.badge').first().textContent()) ?? '') === en['status.queued'], 20_000);
    await b.getByRole('button', { name: 'Edit', exact: true }).click();
    t.check('reopened, the editor holds the prompt the register wrote', await promptBox(b).inputValue(), fixed);
    await b.getByRole('button', { name: 'Cancel', exact: true }).click();

    // The done task: an edit is saved as a new attempt.
    const d = card(done!.id);
    await d.getByRole('button', { name: 'Edit', exact: true }).click();
    await d.getByRole('button', { name: 'Save and queue it again' }).click();
    const confirm = page.getByRole('alertdialog');
    await confirm.waitFor({ timeout: 3_000 });
    await confirm.getByRole('button', { name: 'OK' }).click();
    await waitFor('the done task to be queued again', async () => (await cards(h, s!.id))[0]!.status === 'queued', 10_000).catch(() => undefined);
    const again = (await cards(h, s!.id))[0]!;
    t.check('queued again, with the run it had kept as attempt 1', [again.status, again.attempts?.length], ['queued', 1]);
  });

  /*
   * A queued task is started from its own row (operator feedback 2026-10-08: a task fixed and put back in
   * the queue had no way to start on its own; the marker beside it looked like a button and did nothing).
   * "Save and queue again" asks, in the same dialog, whether to run it now — and the dialog survives the
   * register's 6-second reload, which moves the row to another list (review of 2026-10-09: it did not).
   * The panel offers this task alone or with the queued ones after it, says what is left alone, and the
   * run takes exactly what it listed. Two tasks of one title in two sessions each say where the other is.
   */
  await scenario('a queued task runs from its own row: run offered after a fix, this one and the ones after it, earlier ones untouched', { execution: { mode: 'unattended' }, limits: { retryBlockedInFreshChat: 0 } }, async (h, page, url) => {
    const [s] = await h.importPlan(planFor(h, 'chain', [task('first-file', 'one.txt'), task('second-file', 'two.txt'), task('third-file', 'three.txt')]));
    await sleep(30);
    const [copy] = await h.importPlan(planFor(h, 'chain-copy', [task('third-file', 'three.txt')]));
    h.chat.script(reply.steps(write('one.txt', 'first')), reply.done(), ...reply.triedThenBlocked());
    const ran = await h.run(s!.id);
    t.check('first done, second blocked, third still waiting', ran.tasks.map((x) => x.status), ['done', 'blocked', 'queued']);
    const first = ran.tasks[0]!;

    await page.goto(url('/history'));
    const inSession = (title: string, name: string) =>
      page.locator('ol.flow > li', { hasText: title }).filter({ has: page.locator('.when a', { hasText: new RegExp(`^${name}$`) }) }).first();
    const third = inSession('third-file', 'chain');
    await third.waitFor();
    const mark = third.locator('.flow-mark');
    t.truthy('the status marker says it is only a marker', ((await mark.getAttribute('title')) ?? '').includes('not a button'), await mark.getAttribute('title'));
    t.check('and no circle is drawn beside the row any more', await third.evaluate((li) => getComputedStyle(li, '::before').content), 'none');
    t.check('the queued row has a start of its own', await third.getByRole('button', { name: en['runq.button']!, exact: true }).count(), 1);
    const twinChips = async (row: ReturnType<typeof inSession>): Promise<string[]> => await row.locator('.chip.twin').allTextContents();
    const mine = await twinChips(third);
    t.truthy('a task whose title another session has says so, naming that session, when it was added, its status and attempt',
      mine[0] === 'same title in 1 other session(s)' && /^"chain-copy", added .+: queued, attempt 1$/.test(mine[1] ?? ''), mine);
    const theirs = await twinChips(inSession('third-file', 'chain-copy'));
    t.truthy('and the other one says the same of this one', theirs.length === 2 && /^"chain", added .+: queued, attempt 1$/.test(theirs[1] ?? ''), theirs);

    const second = inSession('second-file', 'chain');
    await second.getByRole('button', { name: 'Fix the prompt and queue it again' }).click();
    const fix = page.getByRole('dialog');
    const box = fix.locator('textarea.prose');
    await waitFor('the fix dialog to read the task', async () => (await box.count()) > 0 && (await box.inputValue()) !== '', 10_000);
    await box.fill('Create two.txt in the repository root holding exactly the word second. This time it works.');
    await fix.getByRole('button', { name: 'Save and queue again' }).click();
    const panel = fix.getByRole('group', { name: 'Run "second-file"' });
    await panel.waitFor();
    t.truthy('saved, the same dialog asks to run it now', ((await panel.textContent()) ?? '').includes(en['runq.ask']!), await panel.textContent());
    t.check('and nothing has started yet', [(await h.call<{ running: boolean }>('GET', '/activity')).running, (await cards(h, s!.id))[1]!.status], [false, 'queued']);
    const go = panel.getByRole('button', { name: en['runq.go']!, exact: true });
    const focused = await waitFor('the keyboard on the first start button', async () => await go.evaluate((b) => b === document.activeElement), 5_000).then(() => true, () => false);
    t.check('the keyboard is on its first start button', focused, true);
    t.check('which says it starts only what is listed', await go.getAttribute('title'), en['runq.goWhy']);
    // The register reloads every 6 s, and this reload moves the requeued row out of the list it was in.
    await sleep(7_000);
    t.check('the dialog is still there after the register reloaded', await panel.isVisible(), true);
    t.check('"only this task" is chosen first', await panel.getByRole('radio', { name: en['runq.onlyThis']! }).isChecked(), true);
    t.check('what runs: this one', await panel.locator('ol > li').allTextContents(), ['second-file']);
    await panel.getByRole('radio', { name: 'This one and the 1 queued after it in "chain"' }).check();
    t.check('what runs follows the choice', await panel.locator('ol > li').allTextContents(), ['second-file', 'third-file']);
    t.truthy('the earlier task is said to be left alone', ((await panel.textContent()) ?? '').includes('1 earlier task(s) of this session have already run'), await panel.textContent());

    h.chat.script(reply.steps(write('two.txt', 'second')), reply.done(), reply.steps(write('three.txt', 'third')), reply.done());
    await panel.getByRole('button', { name: en['runq.unattended']!, exact: true }).click();
    const b = await waitFor('the run to start', async () => await h.call<(Batch & { onlyTasks?: string[] }) | null>('GET', '/batch'), 15_000);
    t.check('the run takes exactly those two, in order', b.onlyTasks, [ran.tasks[1]!.id, ran.tasks[2]!.id]);
    await fix.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);
    t.check('and the dialog closed once it started', await fix.count(), 0);
    await waitFor('both to finish', async () => (await cards(h, s!.id)).every((x) => x.status === 'done'), 30_000).catch(() => undefined);
    await h.idle();
    const after = await cards(h, s!.id);
    t.check('both ran to done', after.map((x) => x.status), ['done', 'done', 'done']);
    t.check('the earlier task was not touched: same attempt, same run', [after[0]!.attempt ?? 1, after[0]!.runId, after[0]!.attempts?.length ?? 0], [first.attempt ?? 1, first.runId, 0]);
    t.check('and the copy in the other session still waits', (await cards(h, copy!.id))[0]!.status, 'queued');
  });

  /*
   * Escape on the "are you sure" box of "Run without asking", inside the dialog that saved a prompt,
   * answers that box only — also after the register's 6-second reload, which re-registered the dialog's
   * own Escape behind the box's and let one key close both (review of 2026-10-09).
   */
  await scenario('Escape on the "are you sure" box inside the prompt dialog closes that box only, after a reload too', { limits: { retryBlockedInFreshChat: 0 } }, async (h, page, url) => {
    const [s] = await h.importPlan(planFor(h, 'escape', [task('lone-file', 'lone.txt')]));
    h.chat.script(...reply.triedThenBlocked());
    const ran = await h.run(s!.id);
    t.check('the task blocked', ran.tasks[0]!.status, 'blocked');
    await page.goto(url('/history'));
    const row = page.locator('ol.flow > li:visible', { hasText: 'lone-file' }).first();
    await row.getByRole('button', { name: 'Fix the prompt and queue it again' }).click();
    const fix = page.getByRole('dialog');
    const box = fix.locator('textarea.prose');
    await waitFor('the fix dialog to read the task', async () => (await box.count()) > 0 && (await box.inputValue()) !== '', 10_000);
    await fix.getByRole('button', { name: 'Save and queue again' }).click();
    const panel = fix.getByRole('group', { name: 'Run "lone-file"' });
    await panel.waitFor();
    const posts = recordPosts(page);
    await panel.getByRole('button', { name: en['runq.unattended']!, exact: true }).click();
    const sure = page.getByRole('alertdialog');
    await sure.waitFor({ timeout: 3_000 });
    await sleep(7_000);
    await page.keyboard.press('Escape');
    await sure.waitFor({ state: 'detached', timeout: 5_000 });
    await sleep(300);
    t.check('the "are you sure" box is gone, the prompt dialog and its offer are not', [await fix.count(), await panel.isVisible()], [1, true]);
    t.check('and nothing was started', posts.filter((p) => p.endsWith('/batch/start')), []);
  });

  /*
   * A task that contradicts itself — scoped away from the file its own check needs — stops before it
   * starts. Its row opens a dialog with the smallest fix (the file added to its scope), applies it with
   * one press, queues the task with it and offers, in the same dialog, to run it; the run then passes.
   * Choices made for other contradictions than the task has now are refused, and change nothing.
   */
  await scenario('a task that contradicts itself is offered its smallest fix, queued with it, and runs', { execution: { mode: 'unattended' }, limits: { retryBlockedInFreshChat: 0 } }, async (h, page, url) => {
    const scoped = { title: 'scoped-greeting', prompt: greeting.prompt, scope: ['notes/'], checks: greeting.checks };
    const [s] = await h.importPlan(planFor(h, 'scoped', [scoped]));
    /*
     * The task as the runner leaves it when the contradiction is found only at the task's start (the tree
     * it starts from was not known before the run): blocked, contract-conflict, nothing sent. A run's own
     * refusal keeps a task queued instead (the next scenario), so this end state is written as the runner
     * writes it.
     */
    const file = join(h.dataDir, 'sessions', `${s!.id}.json`);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { tasks: Array<Record<string, unknown>> };
    const at = new Date().toISOString();
    Object.assign(stored.tasks[0]!, {
      status: 'blocked',
      stopCode: 'contract-conflict',
      startedAt: at,
      finishedAt: at,
      reason: 'the task contradicts itself, so it was not started: The check "greeting written" fails now and can only pass if hello.txt changes, but the task\'s scope (notes/) leaves that file out.',
    });
    writeFileSync(file, JSON.stringify(stored, null, 2), 'utf8');
    const blocked = (await cards(h, s!.id))[0]!;
    t.check('it is blocked for contradicting itself, before any round', [blocked.status, blocked.stopCode, blocked.iterations], ['blocked', 'contract-conflict', 0]);

    const stale = await h.raw('POST', `/sessions/${s!.id}/tasks/${blocked.id}/contract-fix`, { choices: [0], expect: ['a contradiction this task does not have'] });
    t.truthy('choices made for other contradictions are refused', stale.status >= 400 && /not the ones shown/.test(JSON.stringify(stale.body)), stale);
    t.check('and change nothing', [(await cards(h, s!.id))[0]!.status, (await cards(h, s!.id))[0]!.scope], ['blocked', ['notes/']]);

    await page.goto(url('/history'));
    const row = page.locator('ol.flow > li:visible', { hasText: 'scoped-greeting' }).first();
    await row.getByRole('button', { name: en['cfix.button']!, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: en['cfix.button']! });
    const fixPanel = dialog.getByRole('group', { name: 'How "scoped-greeting" contradicts itself' });
    await fixPanel.waitFor();
    const smallest = fixPanel.getByRole('radio', { name: /Add hello\.txt to the paths it may change/ });
    await smallest.waitFor();
    t.check('the smallest fix is chosen first', await smallest.isChecked(), true);
    t.check('and offered beside it: dropping the check', await fixPanel.getByRole('radio', { name: 'Drop the check "greeting written"' }).count(), 1);
    t.check('nothing changed before Apply', (await cards(h, s!.id))[0]!.scope, ['notes/']);
    await fixPanel.getByRole('button', { name: en['cfix.apply']!, exact: true }).click();
    await waitFor('the task to be queued with the fix', async () => (await cards(h, s!.id))[0]!.status === 'queued', 10_000).catch(() => undefined);
    const fixed = (await cards(h, s!.id))[0]!;
    t.check('queued again as attempt 2, hello.txt added to its scope, its check and prompt kept', [fixed.status, fixed.attempt, fixed.scope, fixed.checks?.map((c) => c.name), fixed.prompt], ['queued', 2, ['notes/', 'hello.txt'], ['greeting written'], greeting.prompt]);

    const panel = dialog.getByRole('group', { name: 'Run "scoped-greeting"' });
    await panel.waitFor();
    t.truthy('running it is offered at once, in the same dialog, saying what changed', ((await panel.textContent()) ?? '').includes(`Changed: may change only notes/, hello.txt. ${en['runq.savedOffer']}`), await panel.textContent());
    h.chat.script(reply.steps(write('hello.txt', 'hi')), reply.done());
    await panel.getByRole('button', { name: en['runq.unattended']!, exact: true }).click();
    await waitFor('the fixed task to finish', async () => (await cards(h, s!.id))[0]!.status === 'done', 30_000).catch(() => undefined);
    await h.idle();
    t.check('and it ran to done', (await cards(h, s!.id))[0]!.status, 'done');
  });

  /*
   * The same from the session page, for a task a run would refuse at its start (it never ran, so it is
   * still queued). Its fixes show as "Run this task" opens — not only after a press bound to be refused.
   * Two contradictions: one fixed and one left, the panel stays with what is left and what was changed;
   * the second fixed, the panel goes and the change is said beside the start buttons. An inactive session
   * is refused before any browser, and its offered panel is shut, saying why (review of 2026-10-09).
   */
  await scenario('a queued task on its card: its contradictions fixed in the run panel, one at a time, then run', { execution: { mode: 'unattended' } }, async (h, page, url) => {
    const checks = [...greeting.checks, { name: 'farewell written', expect: 'file-contains', file: 'bye.txt', value: 'bye' }];
    const prompt = 'Create hello.txt holding exactly the word hi and bye.txt holding exactly the word bye, both in the repository root, and nothing else.';
    const [s] = await h.importPlan(planFor(h, 'card', [{ title: 'scoped-greeting', prompt, scope: ['notes/'], checks }]));
    const [only] = await cards(h, s!.id);
    // Set aside: a start is refused before any browser opens, saying why — not with the contradiction a
    // preflight of a session that will not run would find, and not "started" (review of 2026-10-09).
    await h.call('PUT', `/sessions/${s!.id}`, { active: false });
    const refused = await h.call<{ started: boolean; reason?: string }>('POST', '/batch/start', { sessionIds: [s!.id], mode: 'unattended', onFailure: 'stop', taskIds: [only!.id] });
    t.truthy('an inactive session is refused up front, for being inactive', !refused.started && /inactive/.test(refused.reason ?? '') && !/contradicts/.test(refused.reason ?? ''), refused);
    const single = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
    t.truthy('and so is its own Start', !single.started && /inactive/.test(single.reason ?? ''), single);
    t.check('and no chat was opened for it', h.chat.opened, 0);
    await h.call('PUT', `/sessions/${s!.id}`, { active: true });

    await page.goto(url(`/sessions/view?id=${s!.id}`));
    const card = page.locator(`div.task[id="${only!.id}"]`);
    await card.getByRole('button', { name: en['runq.button']!, exact: true }).click();
    const panel = card.getByRole('group', { name: 'Run "scoped-greeting"' });
    await panel.waitFor();
    const fixPanel = panel.getByRole('group', { name: 'How "scoped-greeting" contradicts itself' });
    const shownAtOnce = await appears(fixPanel, 5_000);
    t.check('its fixes are shown as the panel opens, before any start is pressed', [shownAtOnce, h.chat.opened], [true, 0]);
    await fixPanel.locator('fieldset').nth(1).getByRole('radio', { name: en['cfix.leave']! }).check();
    await fixPanel.getByRole('button', { name: en['cfix.applyQueued']!, exact: true }).click();
    await waitFor('the first fix to be applied', async () => ((await cards(h, s!.id))[0]!.scope ?? []).includes('hello.txt'), 10_000).catch(() => undefined);
    t.check('edited where it waits: same attempt, hello.txt in its scope, bye.txt not', [(await cards(h, s!.id))[0]!.attempt ?? 1, (await cards(h, s!.id))[0]!.scope], [1, ['notes/', 'hello.txt']]);
    await fixPanel.getByText(/It still contradicts itself in 1 way/).waitFor();
    t.truthy('the panel stays, with what changed and what is left', ((await fixPanel.textContent()) ?? '').includes('Changed: may change only notes/, hello.txt.') && (await fixPanel.locator('fieldset').count()) === 1, await fixPanel.textContent());
    await fixPanel.getByRole('button', { name: en['cfix.applyQueued']!, exact: true }).click();
    await fixPanel.waitFor({ state: 'detached', timeout: 10_000 });
    t.truthy('nothing left: the fix panel goes, and the change is said beside the start buttons', ((await panel.textContent()) ?? '').includes('Changed: may change only notes/, hello.txt, bye.txt.'), await panel.textContent());

    h.chat.script(reply.steps(write('hello.txt', 'hi'), write('bye.txt', 'bye')), reply.done());
    await panel.getByRole('button', { name: en['runq.unattended']!, exact: true }).click();
    await waitFor('the task to finish', async () => (await cards(h, s!.id))[0]!.status === 'done', 30_000).catch(() => undefined);
    await h.idle();
    t.check('and it ran to done', (await cards(h, s!.id))[0]!.status, 'done');

    // Set aside again, then queued again from the card: the panel it offers is shut, and says why.
    await h.call('PUT', `/sessions/${s!.id}`, { active: false });
    await waitFor('the card to show the task done', async () => ((await card.locator('.badge').first().textContent()) ?? '') === en['status.done'], 20_000).catch(() => undefined);
    await card.getByRole('button', { name: en['task.rerun']!, exact: true }).click();
    const sure = page.getByRole('alertdialog');
    await sure.waitFor({ timeout: 3_000 });
    await sure.getByRole('button', { name: 'OK' }).click();
    const offered = card.getByRole('group', { name: 'Run "scoped-greeting"' });
    await offered.getByText(en['runq.sessionInactive']!).waitFor({ timeout: 15_000 });
    t.check('an inactive session\'s offered panel: both start buttons shut', [await offered.getByRole('button', { name: en['runq.go']!, exact: true }).isDisabled(), await offered.getByRole('button', { name: en['runq.unattended']!, exact: true }).isDisabled()], [true, true]);
  });

  /*
   * The parts of a task card that only a few tasks ever have. Each was once a string nothing rendered,
   * or a render nobody had seen; a page error in any of them would blank the whole session page.
   */
  await scenario('rare parts of a task render: review passed, scope put back, a foreign commit, a suspicious file, a fresh-chat retry', { limits: { retryBlockedInFreshChat: 1 } }, async (h, page, url) => {
    const reviewedPlan = planFor(h, 'reviewed', [{ ...greeting, title: 'scoped-work', scope: ['hello.txt'] }]);
    reviewedPlan.sessions[0]!.review = { enabled: true };
    const [reviewed] = await h.importPlan(reviewedPlan);
    h.chat.script(reply.steps(write('hello.txt', 'hi'), write('README.md', 'rewritten')), reply.done(), reply.steps('Get-Content hello.txt'), reply.pass());
    const scoped = (await h.run(reviewed!.id)).tasks[0] as Card;
    t.check('scoped-work: done, review passed, README.md put back', [scoped.status, scoped.review?.verdict, scoped.scopeReverted], ['done', 'pass', ['README.md']]);

    const [rare] = await h.importPlan(planFor(h, 'rare', [
      task('foreign-work', 'foreign.txt'),
      { title: 'build-state', prompt: 'Build the web folder with incremental TypeScript and leave the project building.', checks: [] },
      task('retry-fresh', 'retry.txt'),
    ]));
    h.chat.script(
      reply.steps(write('foreign.txt', 'mine')),
      () => {
        // Somebody commits on the task's branch while the task is open.
        h.git('-c', 'user.email=someone@example.invalid', '-c', 'user.name=someone', 'commit', '-q', '--allow-empty', '-m', 'sneaked in');
        return reply.done();
      },
      reply.steps("New-Item -ItemType Directory -Force -Path web | Out-Null; Set-Content -Path web/tsconfig.tsbuildinfo -Value 'incremental' -Encoding utf8"),
      reply.done(),
      reply.done(),
      ...reply.triedThenBlocked(),
      reply.steps(write('retry.txt', 'again')),
      reply.done(),
    );
    const [foreign, build, retry] = (await h.run(rare!.id)).tasks as Card[];
    const sha = (foreign!.vcs?.foreignCommits?.[0] ?? '').split(' ')[0] ?? '';
    t.truthy('foreign-work: done, with the foreign commit recorded', foreign!.status === 'done' && sha.length >= 7 && foreign!.vcs!.foreignCommits![0]!.includes('sneaked in'), foreign!.vcs);
    t.truthy('build-state: done, its build state marked suspicious', build!.status === 'done' && build!.vcs?.suspicious?.[0]?.path === 'web/tsconfig.tsbuildinfo', build!.vcs);
    t.check('retry-fresh: done after one retry in a fresh chat, the blocked attempt kept', [retry!.status, retry!.freshRetry, retry!.attempts?.length, retry!.attempt], ['done', true, 1, 2]);
    // The count is derived from the marks for the register, not stored on the task (it used to add up across runs).
    const freshRow = (await h.call<Array<{ taskId: string; autoRetries?: number }>>('GET', '/tasks')).find((r) => r.taskId === retry!.id);
    t.check('retry-fresh: the register counts one fresh chat', freshRow?.autoRetries, 1);

    await page.goto(url(`/sessions/view?id=${reviewed!.id}`));
    const scopedCard = page.locator('div.task', { hasText: 'scoped-work' });
    const putBack = await scopedCard.getByText(/Put back because outside the task’s scope \(1\): README\.md/).waitFor().then(() => true, () => false);
    t.truthy('the card says what was put back', putBack, await scopedCard.first().textContent().catch(() => null));
    t.truthy('and shows the review verdict badge', await scopedCard.locator('.badge.done', { hasText: en['review.verdict.pass']! }).first().isVisible());

    await page.goto(url(`/sessions/view?id=${rare!.id}`));
    const foreignCard = page.locator('div.task', { hasText: 'foreign-work' });
    await foreignCard.locator('code', { hasText: sha }).first().waitFor();
    t.truthy('the foreign commit is listed by its short sha', await foreignCard.locator('code', { hasText: sha }).first().isVisible(), sha);
    // The folded list of committed files names the same path; the warning is the block that says why.
    const warning = page.locator('div.task', { hasText: 'build-state' }).locator('div.err', { hasText: 'Committed although it looks like tool output or secrets (1)' });
    const why = build!.vcs?.suspicious?.[0]?.reason ?? '(no reason recorded)';
    t.truthy('the suspicious file is listed with why', (await warning.isVisible()) && ((await warning.textContent()) ?? '').includes(`web/tsconfig.tsbuildinfo — ${why}`), await warning.textContent().catch(() => null));
    const retryCard = page.locator('div.task', { hasText: 'retry-fresh' });
    await retryCard.getByText('earlier attempts (1)').click();
    t.truthy('the retried task shows attempt 1 in its earlier attempts', await retryCard.getByText(/^attempt 1$/i).first().isVisible());

    await page.goto(url('/history'));
    const scopedRow = page.locator('ol.flow > li', { hasText: 'scoped-work' }).first();
    await scopedRow.waitFor({ state: 'attached' });
    // Only the newest run is unfolded; scoped-work ran in the one before.
    const fold = page.locator('details.run-fold', { has: scopedRow });
    if (!(await fold.evaluate((d) => (d as HTMLDetailsElement).open))) await fold.locator('summary').first().click();
    await scopedRow.waitFor();
    t.truthy('the register row shows the review verdict', await scopedRow.locator('.badge', { hasText: en['review.verdict.pass']! }).isVisible());
    const retryRow = page.locator('ol.flow > li', { hasText: 'retry-fresh' }).first();
    t.truthy('and the fresh-chat retry', await retryRow.getByText(en['reg.retriedFreshDone']!.replace('{n}', '1')).isVisible(), await retryRow.textContent());
    await retryRow.locator('details > summary').first().click();
    t.truthy('with attempt 1 under it', await retryRow.getByText(/^attempt 1$/i).first().isVisible(), await retryRow.textContent());
  });

  /*
   * Bulgarian: chosen from the nav, said to the browser as lang="bg" for screen readers, remembered
   * across a reload, and — being longer than English almost everywhere — still fitting on a phone.
   */
  await scenario('in Bulgarian: chosen, remembered, and no page scrolls sideways on a phone', {}, async (h, page, url) => {
    const [s] = await h.importPlan(planFor(h, 'phone-bg'));
    h.chat.script(reply.steps(write('hello.txt', 'hi')), reply.done());
    await h.run(s!.id);
    await page.goto(url('/'));
    const sessionsLink = page.locator('nav a[href="/"]');
    await sessionsLink.waitFor();
    await page.locator('nav select').selectOption({ label: 'Български' });
    const lang = async (): Promise<[string, string]> => [((await sessionsLink.textContent()) ?? '').trim(), await page.evaluate(() => document.documentElement.lang)];
    await waitFor('the nav in Bulgarian', async () => (await lang())[0] === bg['nav.sessions'], 5_000).catch(() => undefined);
    t.check('the nav speaks Bulgarian and the page says lang="bg"', await lang(), [bg['nav.sessions'], 'bg']);
    await page.reload();
    await waitFor('the language to come back', async () => (await lang())[1] === 'bg', 5_000).catch(() => undefined);
    t.check('both survive a reload', await lang(), [bg['nav.sessions'], 'bg']);

    await page.setViewportSize({ width: 360, height: 780 });
    const pages = ['/', `/sessions/view?id=${s!.id}`, '/history', '/import', '/defaults', '/presets', '/level1', '/appearance', '/system'];
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
  await scenario('the changes view by keyboard: n, ], a folded stretch, Escape', {}, async (h, page, url) => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(h.repo, 'a-lines.txt'), `${lines.join('\r\n')}\r\n`);
    h.git('add', '-A');
    h.git('commit', '-q', '-m', 'sixty lines');
    const [s] = await h.importPlan(planFor(h, 'diffkeys', [{ title: 'edit-two-places', prompt: 'Change line 10 and line 50 of a-lines.txt, and create b-new.txt.', checks: [] }]));
    h.chat.script(
      reply.steps(
        "$l = Get-Content a-lines.txt; $l[9] = 'line 10 changed'; $l[49] = 'line 50 changed'; Set-Content -Path a-lines.txt -Value $l -Encoding utf8",
        write('b-new.txt', 'brand new'),
      ),
      reply.done(),
    );
    const ran = (await h.run(s!.id)).tasks[0] as Card;
    t.check('done, both files committed', [ran.status, (ran.vcs?.files ?? []).map((f) => f.path).sort()], ['done', ['a-lines.txt', 'b-new.txt']]);

    await page.goto(url('/history'));
    const row = page.locator('ol.flow > li', { hasText: 'edit-two-places' }).first();
    await row.getByRole('button', { name: /See the changes \(2 file\(s\)\)/ }).click();
    const view = page.getByRole('dialog');
    await view.locator('tr.diff-row').first().waitFor();
    const counter = async (): Promise<string> => ((await view.locator('.diff-toolbar').textContent()) ?? '').match(/change \S+ of \d+/i)?.[0] ?? '';
    t.check('two changes, none chosen yet', await counter(), 'change – of 2');
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
