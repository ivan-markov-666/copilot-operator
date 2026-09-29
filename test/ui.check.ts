/**
 * The interface in a real browser, against the real API, with the scripted chat of
 * test/support/fakeChat.ts where Copilot would be.
 *
 * The browser is Playwright's own headless Chromium, started with a fresh profile and pointed only
 * at the loopback port the check's API listens on. It is not Edge, it is not the operator's
 * profile, it never loads a Microsoft page and it never shows a window. The page is the static
 * build a package serves (`dist/web`, made by `npm run build:package`), on the same origin as the
 * API, exactly as `npx cop start` runs it.
 *
 * What it covers is what can only be seen in a page: the text size steps and that they survive a
 * reload and a bad stored value; that no page scrolls sideways on a phone at the largest size; the
 * import page turning pasted JSON into sessions; a supervised run answered from the banner on
 * another page; the changes view; the register's "Continue in the same chat"; Settings writing what
 * was typed. Everything behind the page is covered, faster, by the e2e-*.check.ts files.
 *
 *   npm run check:ui          (builds the interface first)
 *
 * Set COP_UI_SHOTS to a folder to keep a screenshot of every scenario that fails.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
const root = join(import.meta.dirname, '..');
const webDir = join(root, 'dist', 'web');
if (!existsSync(join(webDir, 'index.html'))) {
  console.error('dist/web has no built interface: run `npm run build:package` first (npm run check:ui does).');
  process.exit(1);
}
const shots = process.env.COP_UI_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const greeting = {
  title: 'write-greeting',
  prompt: 'Create hello.txt in the repository root holding exactly the word hi, and nothing else.',
  checks: [{ name: 'greeting written', expect: 'file-contains', file: 'hello.txt', value: 'hi' }],
};
const planFor = (h: Harness, name: string, tasks: unknown[] = [greeting]): Record<string, unknown> => ({
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
});

let browser: Browser | null = null;

async function scenario(title: string, settings: Record<string, unknown>, body: (h: Harness, page: Page, url: (p: string) => string) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings, webDir });
  const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.setDefaultTimeout(15_000);
  const url = (p: string): string => `http://127.0.0.1:${h.api.port}${p}`;
  try {
    await body(h, page, url);
    t.check('the page threw no uncaught errors', pageErrors, []);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
    if (shots) await page.screenshot({ path: join(shots, `${title.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.png`), fullPage: true }).catch(() => undefined);
  } finally {
    await context.close();
    await h.stop();
  }
}

try {
  browser = await chromium.launch({ headless: true });

  await scenario('text size: five steps, remembered, and a bad stored value falls back', {}, async (_h, page, url) => {
    await page.goto(url('/appearance'));
    const group = page.getByRole('group', { name: 'Text size' });
    const names = await group.getByRole('button').allTextContents();
    t.check('five sizes, smallest first', names, ['Small', 'Normal', 'Large', 'Larger', 'Largest']);
    const scaleOf = async (): Promise<[string | null, string]> =>
      await page.evaluate(() => [document.documentElement.dataset.textsize ?? null, getComputedStyle(document.documentElement).getPropertyValue('--scale').trim()]);
    const seen: Array<[string | null, string]> = [];
    for (const n of names) {
      await group.getByRole('button', { name: n, exact: true }).click();
      seen.push(await scaleOf());
    }
    t.check('each step sets its own scale', seen, [['small', '0.9'], ['normal', '1'], ['large', '1.12'], ['huge', '1.28'], ['giant', '1.45']]);
    const body = async (): Promise<number> => await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
    t.check('the body text follows it (15px × 1.45)', Math.round((await body()) * 100) / 100, 21.75);

    await page.reload();
    t.check('the choice survives a reload, before React runs', (await scaleOf())[0], 'giant');
    t.check('and its button is the pressed one', await group.getByRole('button', { pressed: true }).allTextContents(), ['Largest']);

    await page.evaluate(() => localStorage.setItem('cop.appearance', JSON.stringify({ textSize: 'enormous', theme: 'purple', highContrast: 'yes' })));
    await page.reload();
    t.check('an unknown stored size falls back to normal', (await scaleOf())[0], 'normal');
    t.check('and Normal shows as chosen', await group.getByRole('button', { pressed: true }).allTextContents(), ['Normal']);
    t.check('an unknown theme falls back to light', await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  });

  await scenario('on a phone, at the normal and the largest size, no page scrolls sideways', {}, async (h, page, url) => {
    const [s] = await h.importPlan(planFor(h, 'phone'));
    h.chat.script(reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8"), reply.done());
    await h.run(s!.id);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(url('/appearance'));
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
    t.check('pages wider than the screen (pixels too wide)', wide, {});
  });

  await scenario('on a tablet and a laptop at the largest size, no page scrolls sideways either', {}, async (h, page, url) => {
    const [s] = await h.importPlan(planFor(h, 'wide'));
    await page.goto(url('/appearance'));
    await page.evaluate(() => localStorage.setItem('cop.appearance', JSON.stringify({ textSize: 'giant' })));
    const wide: Record<string, number> = {};
    for (const [w, hgt] of [[768, 1024], [1280, 800]] as const) {
      await page.setViewportSize({ width: w, height: hgt });
      for (const p of ['/', `/sessions/view?id=${s!.id}`, '/history', '/import', '/defaults']) {
        await page.goto(url(p));
        await page.waitForLoadState('networkidle');
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (over > 1) wide[`${w} ${p}`] = over;
      }
    }
    t.check('pages wider than the window (pixels too wide)', wide, {});
  });

  await scenario('a double click adds one task, and a dialog keeps and returns the focus', {}, async (h, page, url) => {
    const [s] = await h.importPlan(planFor(h, 'clicks'));
    await page.goto(url(`/sessions/view?id=${s!.id}`));
    await page.getByLabel('Task', { exact: true }).fill('Create extra.txt in the repository root holding exactly the word extra, and nothing else.');
    await page.getByRole('button', { name: 'Add to queue', exact: true }).dblclick();
    await waitFor('the task list to settle', async () => (await h.session(s!.id)).tasks.length >= 2);
    await new Promise((r) => setTimeout(r, 800));
    t.check('one task was added, not two', (await h.session(s!.id)).tasks.length, 2);

    const del = page.getByRole('button', { name: 'Delete', exact: true }).first();
    await del.click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    t.truthy('the dialog reads out its question, not only its title', ((await dialog.getAttribute('aria-describedby')) ?? '') !== '', await dialog.getAttribute('aria-describedby'));
    for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
    t.check('Tab stays inside the dialog', await page.evaluate(() => Boolean(document.activeElement?.closest('[role="alertdialog"]'))), true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    t.check('Escape closes it and nothing was deleted', (await h.call<unknown[]>('GET', '/sessions')).length, 1);
    t.check('and the focus is back on the button that opened it', await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Delete');
  });

  await scenario('a brief too long to paste is offered as a file, with the message to send with it', {}, async (h, page, url) => {
    // A long organisation text, as a big company's would be, pushes the brief past what Copilot takes in a message.
    await h.call('PUT', '/context/organisation', { content: `# Our organisation\n\n${'We write every rule down. '.repeat(6000)}` });
    await page.goto(url('/import'));
    await page.getByText(/more than Copilot takes in one message/).waitFor();
    t.truthy('the page says why', true);
    const save = page.getByRole('button', { name: 'Save the brief as a file' });
    t.check('saving the file is now the main button', await save.getAttribute('class'), 'primary');
    const [download] = await Promise.all([page.waitForEvent('download'), save.click()]);
    const saved = await download.path().then((p) => (p ? readFileSync(p, 'utf8') : ''));
    t.truthy('the file holds the whole brief, organisation text included', saved.length > 120_000 && saved.includes('We write every rule down.'), saved.length);
    t.truthy('and the one-line message for the chat can be copied', await page.getByRole('button', { name: 'Copy the message for the file' }).isVisible());
  });

  await scenario('the import page turns pasted JSON into sessions', {}, async (h, page, url) => {
    await page.goto(url('/import'));
    await page.getByPlaceholder(/json/i).first().fill(JSON.stringify(planFor(h, 'imported')));
    await page.getByRole('button', { name: 'Check it' }).click();
    await page.getByRole('button', { name: 'Create the sessions and tasks' }).click();
    await page.getByText(/Created 1 session\(s\) with 1 task\(s\)/).waitFor();
    const sessions = await h.call<Array<{ name: string; tasks: Array<{ status: string }> }>>('GET', '/sessions');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save the brief as a file' }).click()]);
    t.check('the brief can be saved as a .txt file', download.suggestedFilename(), 'copilot-operator-brief.en.txt');
    t.check('one session, its task queued, nothing started', sessions.map((s) => [s.name, s.tasks.map((x) => x.status)]), [['imported', ['queued']]]);
    await page.goto(url('/'));
    await page.getByRole('link', { name: 'imported' }).first().waitFor();
    t.truthy('the sessions page lists it', true);
  });

  await scenario('a supervised run, answered from the banner on another page, then its changes', {}, async (h, page, url) => {
    const [s] = await h.importPlan(planFor(h, 'banner'));
    h.chat.script(reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8"), reply.done());
    await page.goto(url(`/sessions/view?id=${s!.id}`));
    await page.getByRole('button', { name: 'Step by step' }).click();
    const confirm = page.getByRole('alertdialog');
    if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button', { name: 'OK' }).click();

    await page.goto(url('/appearance'));
    const banner = page.locator('.approval-banner');
    await banner.waitFor();
    t.truthy('the waiting step is shown on a page that has nothing to do with the run', (await banner.textContent())?.includes('hello.txt'), await banner.textContent());
    await waitFor('the tab title to say something is waiting', async () => /\(1\)/.test(await page.title()));
    t.truthy('the tab title says one step is waiting', /\(1\)/.test(await page.title()), await page.title());
    await banner.getByRole('button', { name: 'Run', exact: true }).click();
    await banner.waitFor({ state: 'detached' });
    await h.idle();
    t.check('the task finished', (await h.session(s!.id)).tasks[0]!.status, 'done');

    await page.goto(url(`/sessions/view?id=${s!.id}`));
    await page.getByText("How it ended — from the runner's records").waitFor();
    t.truthy('the card shows how it ended, from the runner records', (await page.locator('.handoff').textContent())?.includes('hello.txt'), await page.locator('.handoff').textContent());
    await page.getByRole('button', { name: /See the changes \(1 file\(s\)\)/ }).first().click();
    const diff = page.getByRole('dialog');
    await diff.getByText('hello.txt').first().waitFor();
    t.truthy('the changes view lists the file', (await diff.textContent())?.includes('hello.txt'), (await diff.textContent())?.slice(0, 300));
    await diff.getByText('hi', { exact: true }).first().waitFor();
    t.truthy('and shows what it now holds', true);
    await page.keyboard.press('Escape');
    await diff.waitFor({ state: 'detached' });
    t.truthy('Escape closes it', true);
  });

  await scenario('the register continues a task stopped at the limit, in the same chat', { limits: { maxIterations: 5 } }, async (h, page, url) => {
    const [s] = await h.importPlan(planFor(h, 'limit'));
    for (let i = 1; i <= 6; i++) h.chat.script(reply.steps(`Write-Output 'round ${i}'`));
    const stopped = await h.run(s!.id);
    t.check('the task stopped at the limit', stopped.tasks[0]!.status, 'limit-reached');

    h.chat.script(reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8"), reply.done());
    await page.goto(url(`/sessions/view?id=${s!.id}`));
    await page.getByRole('button', { name: 'Continue in the same chat' }).first().click();
    const confirm = page.getByRole('alertdialog');
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'OK' }).click();
    await waitFor('the task to be queued again', async () => (await h.session(s!.id)).tasks[0]!.status === 'queued');
    t.check('it is queued as a continuation', (await h.session(s!.id)).tasks[0]!.continuing?.how, 'limit');

    await page.goto(url('/history'));
    const figures = page.locator('.metrics');
    await figures.getByText('How the bot is doing').waitFor();
    const firstRow = await figures.locator('tr', { hasText: 'Done at the first attempt' }).textContent();
    t.truthy('the register shows the figures: none done at the first attempt yet', /0 \/ 1 \(0%\)/.test(firstRow ?? ''), firstRow);
  });

  await scenario('a new prompt for a done task: its old checks are offered, unticked, and it can be made read-only', {}, async (h, page, url) => {
    const [s] = await h.importPlan(planFor(h, 'newprompt'));
    h.chat.script(reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8"), reply.done());
    await h.run(s!.id);
    await page.goto(url('/history'));
    await page.getByRole('button', { name: 'Give it a new prompt and queue it again' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Checks that still apply to the new prompt').waitFor();
    const oldCheck = dialog.getByRole('checkbox', { name: 'greeting written' });
    t.check('the old check is listed, and unticked for a done task', await oldCheck.isChecked(), false);
    await dialog.getByRole('textbox').first().fill('Audit hello.txt and say in your summary what it holds. Change nothing.');
    t.truthy('a changed prompt says what happens to the old checks', await dialog.getByText(/A new prompt is a new question/).isVisible());
    await dialog.getByRole('checkbox', { name: 'Read-only: this task must not change any file' }).check();
    await dialog.getByRole('button', { name: 'Save and queue again' }).click();
    await waitFor('the task to be queued again', async () => (await h.session(s!.id)).tasks[0]!.status === 'queued');
    const queued = (await h.session(s!.id)).tasks[0]! as unknown as { checks?: unknown[]; readOnly?: boolean; prompt: string };
    t.check('queued read-only, with no old checks and the new prompt', [queued.readOnly, queued.checks ?? [], queued.prompt.startsWith('Audit hello.txt')], [true, [], true]);
  });

  await scenario('Settings writes what was typed, clamped to its limits', {}, async (h, page, url) => {
    await page.goto(url('/defaults'));
    const iterations = page.getByLabel('Most messages to the chat in one task');
    await iterations.fill('2');
    await iterations.blur();
    await waitFor('the limit to be saved', async () => {
      const s = await h.call<{ raw: { limits?: { maxIterations?: number } } }>('GET', '/settings');
      return s.raw.limits?.maxIterations === 5;
    });
    t.check('a value under the minimum is raised to it (5)', await iterations.inputValue(), '5');
    const wait = page.getByLabel('How long to wait for a reply from the chat');
    await wait.fill('1200');
    await wait.blur();
    await waitFor('the reply wait to be saved', async () => {
      const s = await h.call<{ raw: { copilot?: { replyTimeoutSec?: number } } }>('GET', '/settings');
      return s.raw.copilot?.replyTimeoutSec === 1200;
    });
    t.check('the reply wait is saved', (await h.call<{ raw: { copilot?: { replyTimeoutSec?: number } } }>('GET', '/settings')).raw.copilot?.replyTimeoutSec, 1200);
    t.check('and the limit set before it was not reverted', (await h.call<{ raw: { limits?: { maxIterations?: number } } }>('GET', '/settings')).raw.limits?.maxIterations, 5);
  });
} finally {
  await browser?.close();
}

t.finish();
