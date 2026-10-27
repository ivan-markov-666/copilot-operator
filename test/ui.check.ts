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
 * What it covers is what can only be seen in a page: every page hydrating against its own HTML (read
 * from the built files, and tried with the layout's script held back); the text size steps and that
 * they survive a reload and a bad stored value; that no page scrolls sideways on a phone at the
 * largest size; the import page turning pasted JSON into sessions; a supervised run answered from
 * the banner on another page; the changes view; the register's "Continue in the same chat"; Settings
 * writing what was typed. Everything behind the page is covered, faster, by the e2e-*.check.ts files.
 *
 *   npm run check:ui          (builds the interface first)
 *
 * Set COP_UI_SHOTS to a folder to keep a screenshot of every scenario that fails.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';
import { dict } from '../web/lib/strings.js';
import { themeScript } from '../web/lib/themeScript.js';

const en = dict.en as Record<string, string>;

/**
 * The start window's own button: "Start without asking", or — with one session under version control —
 * the same words naming where the work starts ("… — on main @ 1a2b3c4d"), the operator's report of 2026-10-13.
 */
const goButton = (w: Locator, mode: 'step' | 'unattended'): Locator => {
  const words = en[mode === 'step' ? 'startdlg.goStep' : 'startdlg.goUnattended']!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return w.getByRole('button', { name: new RegExp(`^${words}( — on .+)?$`) });
};

/**
 * The start window every start button opens first (2026-10-13): where the work starts. Its own button
 * starts the run; once it has, the window closes. `started: false` for a start that is meant to be refused.
 */
async function throughStartWindow(page: Page, mode: 'step' | 'unattended', started = true): Promise<Locator> {
  const w = page.getByRole('dialog', { name: en['startdlg.title']! });
  await w.waitFor({ timeout: 10_000 });
  await goButton(w, mode).click();
  if (started) await w.waitFor({ state: 'detached', timeout: 30_000 });
  return w;
}


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

// ---------------------------------------------------------------------------------------------
// What each built page hands React to hydrate, read from the files. A page's HTML carries the
// server's render twice: as markup, and as the data React rebuilds the same tree from in the
// browser. Anything in that data the browser must first fetch is a place where hydration can stop
// and wait. In <head> that is not harmless: React 19 keeps its place in the document in one
// variable while it is inside <head>, overwrites it each time it resumes there, and then compares
// the first element of <body> with the first one of <head>. The hydration fails (React error #418)
// and the whole page is thrown away and drawn again, on whichever load the chunk came late. That is
// how the theme script, imported by the server layout from a 'use client' module, failed
// test/ui-flows.check.ts on 2026-10-02 twice in three runs. This part is exact: no browser, no timing.
// ---------------------------------------------------------------------------------------------

/** The rows of the data React hydrates a built page from (`self.__next_f.push([1, "…"])`), by id. */
const payloadRows = (html: string): Map<string, string> => {
  let text = '';
  for (const m of html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)) {
    const part = JSON.parse(m[1]!) as [number, string?];
    if (part[0] === 1 && typeof part[1] === 'string') text += part[1];
  }
  const rows = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]+):(.*)$/s.exec(line);
    if (m) rows.set(m[1]!, m[2]!);
  }
  return rows;
};
/** A value the browser must resolve before it has it: a lazy part, a promise, another row or a module. */
const waitsFor = (v: unknown): v is string => typeof v === 'string' && /^\$(L|@)?[0-9a-f]+$/.test(v);

console.log('\n--- every built page hydrates <head> from what is in the page ---');
{
  const pages = (readdirSync(webDir, { recursive: true }) as string[])
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => p.endsWith('.html') && !p.startsWith('_next/'));
  const noHead: string[] = [];
  const inHead: string[] = [];
  const inlineCode: string[] = [];
  for (const p of pages) {
    let heads = 0;
    for (const [id, row] of payloadRows(readFileSync(join(webDir, p), 'utf8'))) {
      if (!row.startsWith('{') && !row.startsWith('[')) continue;
      const walk = (v: unknown, at: string, insideHead: boolean): void => {
        if (Array.isArray(v)) {
          const isHead = v[0] === '$' && v[1] === 'head';
          if (isHead) heads++;
          v.forEach((x, i) => walk(x, `${at}[${i}]`, insideHead || isHead));
        } else if (v && typeof v === 'object') {
          for (const [k, x] of Object.entries(v)) {
            if (k === 'dangerouslySetInnerHTML' && x && typeof x === 'object' && typeof (x as { __html?: unknown }).__html !== 'undefined') {
              const code = (x as { __html: unknown }).__html;
              if (typeof code !== 'string' || waitsFor(code)) inlineCode.push(`${p}: ${at}.${k}.__html = ${String(code)}`);
            }
            walk(x, `${at}.${k}`, insideHead);
          }
        } else if (insideHead && waitsFor(v)) inHead.push(`${p}: ${at} = ${v}`);
      };
      walk(JSON.parse(row), `row ${id}`, false);
    }
    if (heads === 0) noHead.push(p);
  }
  // The chat, Settings, System, and the 404 (the Sessions pages went on 2026-10-20, and Level 1, the presets and Appearance with them).
  t.truthy('the build has its pages', pages.length >= 4 && pages.includes('index.html') && pages.includes('settings.html') && pages.includes('defaults.html') && pages.includes('system.html'), pages);
  t.check('and not the pages that went', ['level1.html', 'presets.html', 'appearance.html'].filter((x) => pages.includes(x)), []);
  // Without this the two checks below would pass on a page whose data they could not read at all.
  t.check('pages whose data has no <head> to look at', noHead, []);
  t.check('parts of <head> the browser must fetch before it can hydrate it', inHead, []);
  t.check('inline scripts whose text is a reference rather than the text', inlineCode, []);
  // Under the length React sends as a row of its own, which is what makes it a reference (2026-10-20, at 1 045).
  t.truthy('the pre-paint script stays under 1 024 characters', themeScript.length < 1024, themeScript.length);
}

let browser: Browser | null = null;

async function scenario(title: string, settings: Record<string, unknown>, body: (h: Harness, page: Page, url: (p: string) => string) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings, webDir });
  const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  // With the page it happened on: an error seen once is only worth something if it says where.
  page.on('pageerror', (e) => pageErrors.push(`${page.url().replace(/^https?:\/\/[^/]+/, '')}: ${e.message}`));
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

  /*
   * The same in a browser, where it was seen: every page loaded with the layout's own chunk held back,
   * so that React reaches <head> before the chunk is there. With the theme script still a reference,
   * one load in three or four of these was thrown away and drawn again (which ones, React decides), so
   * two rounds of every page find it nearly always; the check of the built pages above finds it every
   * time. Judged by the markup, not only by the error: a page drawn again has lost the frame the HTML
   * gave it, whatever React reports about it.
   */
  await scenario("every page keeps the markup of its HTML when the layout's script comes late", {}, async (h, page, url) => {
    const { threadId } = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create hello.txt holding hi (late).', model: 'Think deeper' });
    await page.goto(url('/system'));
    await page.evaluate((id) => localStorage.setItem('cop.chat.thread', id), threadId);
    // Held on the network every time: while a route is set, Playwright fetches past the cache.
    await page.route('**/_next/static/chunks/app/layout-*.js', async (r) => {
      await new Promise((res) => setTimeout(res, 500));
      await r.continue();
    });
    // The frame the parser put in, marked as it arrives. A failed hydration replaces it with a new one.
    await page.addInitScript(() => {
      new MutationObserver((records, observer) => {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n instanceof HTMLElement && (n.classList.contains('wrap') || n.classList.contains('wb-root'))) {
              (n as HTMLElement & { fromHtml?: boolean }).fromHtml = true;
              observer.disconnect();
              return;
            }
          }
        }
      }).observe(document, { childList: true, subtree: true });
    });
    const pages = ['/', '/settings', '/system'];
    const redrawn: string[] = [];
    for (let round = 1; round <= 2; round++) {
      for (const p of pages) {
        await page.goto(url(p));
        // The router mounts it once the hydration has committed, as it was or drawn again.
        await page.locator('next-route-announcer').waitFor({ state: 'attached' });
        const kept = await page.evaluate(() => (document.querySelector('div.wrap, div.wb-root') as (HTMLElement & { fromHtml?: boolean }) | null)?.fromHtml === true);
        if (!kept) redrawn.push(`round ${round}: ${p}`);
      }
    }
    t.check('loads whose markup was thrown away and drawn again', redrawn, []);
  });

  /*
   * The text size through the appearance menu at the foot of the chat's left column (2026-10-20: the Appearance page
   * went with the rest; the menu does all of it): five steps by A− and A+, remembered, a bad stored value falling back.
   */
  await scenario('text size: five steps by A− and A+, remembered, and a bad stored value falls back', {}, async (_h, page, url) => {
    await page.goto(url('/'));
    const openMenu = async (): Promise<void> => {
      await page.getByRole('button', { name: en['wb.appearance']!, exact: true }).click();
      await page.getByRole('dialog', { name: en['wb.appearance']! }).waitFor();
    };
    await openMenu();
    const menu = page.getByRole('dialog', { name: en['wb.appearance']! });
    const scaleOf = async (): Promise<[string | null, string]> =>
      await page.evaluate(() => [document.documentElement.dataset.textsize ?? null, getComputedStyle(document.documentElement).getPropertyValue('--scale').trim()]);
    const smaller = menu.getByRole('button', { name: en['ap.smaller']!, exact: true });
    const larger = menu.getByRole('button', { name: en['ap.larger']!, exact: true });
    await smaller.click();
    const seen: Array<[string | null, string]> = [await scaleOf()];
    for (let i = 0; i < 4; i++) {
      await larger.click();
      seen.push(await scaleOf());
    }
    t.check('A− then A+ four times: each step its own scale, smallest first', seen, [['small', '0.9'], ['normal', '1'], ['large', '1.12'], ['huge', '1.28'], ['giant', '1.45']]);
    t.check('at the largest, A+ is off', await larger.isDisabled(), true);
    const body = async (): Promise<number> => await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
    t.check('the body text follows it (15px × 1.45)', Math.round((await body()) * 100) / 100, 21.75);

    await page.reload();
    t.check('the choice survives a reload, before React runs', (await scaleOf())[0], 'giant');
    await openMenu();
    t.truthy('and the menu says it', ((await menu.textContent()) ?? '').includes(en['ap.sizeGiant']!), await menu.textContent());
    // Three more steps below Small (operator, 2026-10-22): from the largest down, each its scale, to the smallest.
    const down: Array<[string | null, string]> = [];
    for (let i = 0; i < 7; i++) {
      await smaller.click();
      down.push(await scaleOf());
    }
    t.check('A− seven times from the largest: every step down to the smallest', down, [['huge', '1.28'], ['large', '1.12'], ['normal', '1'], ['small', '0.9'], ['compact', '0.8'], ['verysmall', '0.7'], ['smallest', '0.6']]);
    t.check('at the smallest, A− is off, and the menu says which', [await smaller.isDisabled(), ((await menu.textContent()) ?? '').includes(en['ap.sizeSmallest']!)], [true, true]);

    await page.evaluate(() => localStorage.setItem('cop.appearance', JSON.stringify({ textSize: 'enormous', theme: 'purple', highContrast: 'yes' })));
    await page.reload();
    t.check('an unknown stored size falls back to normal', (await scaleOf())[0], 'normal');
    t.check('an unknown theme falls back to the machine\'s (light here)', await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  });

  /*
   * The theme before the first paint (2026-10-20): with nothing chosen, the machine's light or dark — "System", the
   * default — and a theme chosen, that one; night light on from the start too. Read with the page's scripts held back,
   * so it is the inline script in <head> that answers, not React after it.
   */
  await scenario('before the first paint: the machine\'s theme unless one was chosen, and night light', {}, async (_h, page, url) => {
    await page.route('**/_next/static/chunks/**', (r) => r.abort());
    const at = async (): Promise<Record<string, string | undefined>> => await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, night: document.documentElement.dataset.night }));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(url('/system'), { waitUntil: 'domcontentloaded' });
    t.check('nothing chosen, the machine dark: dark', (await at()).theme, 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    t.check('nothing chosen, the machine light: light', (await at()).theme, 'light');
    await page.evaluate(() => localStorage.setItem('cop.appearance', JSON.stringify({ theme: 'dark', nightLight: true })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    t.check('dark chosen, on a light machine: dark, and night light on', await at(), { theme: 'dark', night: 'on' });
    await page.evaluate(() => localStorage.setItem('cop.appearance', JSON.stringify({ theme: 'system' })));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    t.check('"system" stored: the machine\'s, dark; no night light', await at(), { theme: 'dark', night: 'off' });
    // Arabic is written right to left: the page is turned before its first paint too (2026-10-20), and only for it.
    const dirOf = async (): Promise<[string, string]> => await page.evaluate(() => [document.documentElement.dir, document.documentElement.lang]);
    await page.evaluate(() => localStorage.setItem('cop.locale', 'ar'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    t.check('Arabic chosen: right to left, and the page says Arabic, before any script of the page', await dirOf(), ['rtl', 'ar']);
    await page.evaluate(() => localStorage.setItem('cop.locale', 'de'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    t.check('German chosen: left to right', (await dirOf())[0], '');
  });

  await scenario('on a phone, at the normal and the largest size, no page scrolls sideways', {}, async (h, page, url) => {
    const { threadId } = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create hello.txt holding hi (phone).', model: 'Think deeper' });
    h.chat.script(reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8"), reply.done());
    await h.run(threadId);
    await page.goto(url('/system'));
    await page.evaluate((id) => localStorage.setItem('cop.chat.thread', id), threadId);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(url('/system'));
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
    t.check('pages wider than the screen (pixels too wide)', wide, {});
  });

  await scenario('on a tablet and a laptop at the largest size, no page scrolls sideways either', {}, async (h, page, url) => {
    const { threadId } = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create hello.txt holding hi (wide).', model: 'Think deeper' });
    await page.goto(url('/system'));
    await page.evaluate((id) => localStorage.setItem('cop.chat.thread', id), threadId);
    await page.goto(url('/system'));
    await page.evaluate(() => localStorage.setItem('cop.appearance', JSON.stringify({ textSize: 'giant' })));
    const wide: Record<string, number> = {};
    for (const [w, hgt] of [[768, 1024], [1280, 800]] as const) {
      await page.setViewportSize({ width: w, height: hgt });
      for (const p of ['/', '/settings']) {
        await page.goto(url(p));
        await page.waitForLoadState('networkidle');
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (over > 1) wide[`${w} ${p}`] = over;
      }
    }
    t.check('pages wider than the window (pixels too wide)', wide, {});
  });

  await scenario('every form field on every page has a name a screen reader can say', {}, async (h, page, url) => {
    const { threadId } = await h.call<{ threadId: string }>('POST', '/chat', { text: 'Create hello.txt holding hi (labels).', model: 'Think deeper' });
    h.chat.script(reply.steps("Set-Content -Path hello.txt -Value 'hi' -Encoding utf8"), reply.done());
    await h.run(threadId);
    await page.goto(url('/system'));
    await page.evaluate((id) => localStorage.setItem('cop.chat.thread', id), threadId);
    const pages = ['/', '/settings', '/system'];
    const unnamed: Record<string, string[]> = {};
    for (const p of pages) {
      await page.goto(url(p));
      await page.waitForLoadState('networkidle');
      // Open every fold, so the fields inside them are judged too.
      await page.evaluate(() => document.querySelectorAll('details').forEach((d) => ((d as HTMLDetailsElement).open = true)));
      await page.waitForTimeout(300);
      const found = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll('input, textarea, select'))) {
          const f = el as HTMLInputElement;
          if (f.type === 'hidden' || f.getClientRects().length === 0) continue;
          const byLabel = f.labels && f.labels.length > 0 && Array.from(f.labels).some((l) => (l.textContent ?? '').trim());
          const named = byLabel || (f.getAttribute('aria-label') ?? '').trim() || f.getAttribute('aria-labelledby') || (f.getAttribute('title') ?? '').trim();
          if (!named) out.push(`${f.tagName.toLowerCase()}${f.type ? `[${f.type}]` : ''}${f.placeholder ? ` "${f.placeholder.slice(0, 40)}"` : ''}`);
        }
        return out;
      });
      if (found.length > 0) unnamed[p.split('?')[0]!] = found;
    }
    t.check('fields with no name, by page', unnamed, {});
  });

  /*
   * Settings as they are since 2026-10-20: the base prompt to read, folded, with what it is said above the fold; each
   * project with its branch and its level 2, saved and carried by Kerrigan; no "Prepare the folder from the remote
   * main branch" any more; and an ⓘ beside the name of every field.
   */
  await scenario('Settings: the base prompt folded, a project\'s branch and level 2, no "prepare", an ⓘ on every field', {}, async (h, page, url) => {
    const git = (...args: string[]): string => execFileSync('git', ['-C', h.repo, ...args], { encoding: 'utf8' }).trim();
    git('checkout', '-q', '-b', 'feature/settings');
    await h.call('PUT', '/project', { rootDir: h.repo, name: 'fixture' });
    await page.goto(url('/settings'));
    await page.getByRole('heading', { name: en['l1.title']!, exact: true }).waitFor();
    const l1 = page.locator('#level1');
    t.truthy('the base prompt: what it is, said where it is seen at once', (await l1.locator('.callout').isVisible()) && ((await l1.locator('.callout').textContent()) ?? '').includes('Kerrigan'), await l1.locator('.callout').textContent());
    t.check('and its text folded', await l1.locator('details').evaluate((d) => (d as HTMLDetailsElement).open), false);
    await l1.getByText(en['l1.show']!, { exact: true }).click();
    await waitFor('the base prompt to be read', async () => ((await l1.locator('pre').textContent()) ?? '').length > 200, 10_000).catch(() => undefined);
    t.truthy('opened, it is the contract the bot ships', ((await l1.locator('pre').textContent()) ?? '').length > 200 && (await l1.locator('textarea').count()) === 0, (await l1.locator('pre').textContent())?.slice(0, 80));
    t.check('nothing on the page prepares a folder from the remote main any more', await page.getByRole('button', { name: /remote main/i }).count(), 0);
    const entry = page.locator('.project-entry').first();
    await entry.locator('.badge.branch').waitFor();
    t.truthy('the project says the branch checked out in it', ((await entry.locator('.badge.branch').textContent()) ?? '').includes('feature/settings'), await entry.locator('.badge.branch').textContent());
    const level2 = entry.getByLabel(en['proj.level2']!, { exact: true });
    await level2.fill('A fixture repository. Tests: none. Never touch README.md.');
    await waitFor('the level 2 to be saved', async () => (await h.call<{ level2: string }>('GET', '/project')).level2.includes('Never touch README.md'), 10_000).catch(() => undefined);
    t.check('the level 2 is saved with the project', (await h.call<{ level2: string }>('GET', '/project')).level2, 'A fixture repository. Tests: none. Never touch README.md.');
    const kerrigan = await h.call<{ text: string }>('GET', '/kerrigan?lang=en');
    t.truthy('and Kerrigan carries it, with the branch', kerrigan.text.includes('Never touch README.md') && kerrigan.text.includes('`feature/settings`'), kerrigan.text.slice(kerrigan.text.indexOf('## The projects'), kerrigan.text.indexOf('## How you help')));
    // For reference only (operator, 2026-10-21): a box on each project, saved at once, said on the project and to Kerrigan.
    const reference = entry.getByRole('checkbox', { name: en['proj.readOnly']!, exact: true });
    t.check('a project is open for work at first', await reference.isChecked(), false);
    await reference.check();
    await waitFor('the box to be saved', async () => (await h.call<{ readOnly: boolean }>('GET', '/project')).readOnly, 10_000).catch(() => undefined);
    t.check('ticked: saved with the project', (await h.call<{ readOnly: boolean }>('GET', '/project')).readOnly, true);
    await entry.locator('.badge.reference').waitFor({ timeout: 5_000 }).catch(() => undefined);
    t.check('and said on it', await entry.locator('.badge.reference').textContent(), en['proj.readOnlyBadge']);
    const marked = await h.call<{ text: string }>('GET', '/kerrigan?lang=en');
    t.truthy('Kerrigan knows it is for reference only', marked.text.includes('**For reference only**'), marked.text.slice(marked.text.indexOf('## The projects'), marked.text.indexOf('## How you help')));
    await reference.uncheck();
    await waitFor('the box to be cleared', async () => !(await h.call<{ readOnly: boolean }>('GET', '/project')).readOnly, 10_000).catch(() => undefined);
    t.check('unticked: open for work again', (await h.call<{ readOnly: boolean }>('GET', '/project')).readOnly, false);
    // Every field has an ⓘ beside its name — a box of the scripts' table, the ⓘ of its column (2026-10-27).
    const bare = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll('main input, main select, main textarea'))) {
        const f = el as HTMLInputElement;
        if (f.type === 'hidden' || f.getClientRects().length === 0) continue;
        const column = f.closest('table.scripts-table') && f.closest('td') ? (f.closest('table') as HTMLTableElement).tHead?.rows[0]?.cells[(f.closest('td') as HTMLTableCellElement).cellIndex] : null;
        const holder = column ?? f.closest('.settings-field, .project-fields > div, .project-level2, .project-readonly');
        const info = holder?.querySelector('.info-btn');
        if (!info) out.push(f.id || f.getAttribute('aria-label') || f.outerHTML.slice(0, 60));
      }
      return out;
    });
    t.check('fields without an ⓘ', bare, []);
    await page.locator('#execution .info-btn').first().click();
    const pop = page.locator('.info-pop');
    await pop.waitFor();
    t.truthy('an ⓘ opens what the field is for', ((await pop.textContent()) ?? '').includes(en['exec.autoContinue']!), await pop.textContent());
    // The fields of a section line up: their controls start at the same place.
    const lefts = await page.locator('#execution .settings-field .field-control').evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().left)))]);
    t.check('the controls of Execution start in one column', lefts.length, 1);
  });

  await scenario('Settings writes what was typed, clamped to its limits', {}, async (h, page, url) => {
    await page.goto(url('/settings'));
    // Exact: the ⓘ beside each field is "About “…”", which a looser match takes as well.
    const iterations = page.getByLabel('Most messages to the chat in one task', { exact: true });
    await iterations.waitFor();
    // Removed on 2026-09-30: nothing on this page copies a project to the Desktop any more.
    t.check('no Desktop copy of the projects is offered', await page.getByText(/on the Desktop/).count(), 0);
    await iterations.fill('2');
    await iterations.blur();
    await waitFor('the limit to be saved', async () => {
      const s = await h.call<{ raw: { limits?: { maxIterations?: number } } }>('GET', '/settings');
      return s.raw.limits?.maxIterations === 5;
    });
    t.check('a value under the minimum is raised to it (5)', await iterations.inputValue(), '5');
    const wait = page.getByLabel('How long to wait for a reply from the chat', { exact: true });
    await wait.fill('1200');
    await wait.blur();
    await waitFor('the reply wait to be saved', async () => {
      const s = await h.call<{ raw: { copilot?: { replyTimeoutSec?: number } } }>('GET', '/settings');
      return s.raw.copilot?.replyTimeoutSec === 1200;
    });
    t.check('the reply wait is saved', (await h.call<{ raw: { copilot?: { replyTimeoutSec?: number } } }>('GET', '/settings')).raw.copilot?.replyTimeoutSec, 1200);
    const approaches = page.getByLabel('Approaches the chat must try before it may give up', { exact: true });
    await approaches.fill('6');
    await approaches.blur();
    await waitFor('the approaches to be saved', async () => {
      const s = await h.call<{ raw: { limits?: { minApproachesBeforeBlocked?: number } } }>('GET', '/settings');
      return s.raw.limits?.minApproachesBeforeBlocked === 6;
    });
    t.truthy('the number of approaches before "blocked" is saved', true);
    await approaches.fill('1');
    await approaches.blur();
    t.check('and cannot go under the format\'s two', await approaches.inputValue(), '2');
    t.check('and the limit set before it was not reverted', (await h.call<{ raw: { limits?: { maxIterations?: number } } }>('GET', '/settings')).raw.limits?.maxIterations, 5);
  });
} finally {
  await browser?.close();
}

t.finish();
