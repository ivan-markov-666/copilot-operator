/**
 * Locator probe: opens the Copilot chat with the bot's Edge profile and dumps
 * everything we need to pin down stable locators.
 *
 *   npm run probe
 *
 * Outputs into runs/probe-<timestamp>/:
 *   page.html         full DOM (after the chat has rendered)
 *   screenshot.png    full-page screenshot
 *   candidates.json   scored candidates for composer / send / stop / messages / code / attachments
 *   aria.txt          the accessibility snapshot
 *
 * Nothing is typed into the chat unless A365_PROBE_PROMPT is set.
 */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const PROFILE_DIR = process.env.A365_PROFILE ?? resolve(process.cwd(), 'profile');
const CHAT_URL = process.env.A365_URL ?? 'https://m365.cloud.microsoft/chat';
const PROBE_PROMPT = process.env.A365_PROBE_PROMPT ?? '';

type Candidate = {
  role: string | null;
  name: string | null;
  tag: string;
  testId: string | null;
  id: string | null;
  automationId: string | null;
  classes: string;
  visible: boolean;
  cssPath: string;
  xpath: string;
};

const COLLECT = `(() => {
  const cssPath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 8; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + '#' + n.id); break; }
      const testId = n.getAttribute('data-testid') || n.getAttribute('data-test-id');
      if (testId) { parts.unshift(s + '[data-testid="' + testId + '"]'); break; }
      const sib = n.parentElement ? Array.from(n.parentElement.children).filter(c => c.tagName === n.tagName) : [];
      if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(n) + 1) + ')';
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const xpath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const sib = n.parentElement ? Array.from(n.parentElement.children).filter(c => c.tagName === n.tagName) : [];
      const idx = sib.length > 1 ? '[' + (sib.indexOf(n) + 1) + ']' : '';
      parts.unshift(n.tagName.toLowerCase() + idx);
      if (parts.length > 12) break;
    }
    return '/' + parts.join('/');
  };
  const describe = (el) => ({
    role: el.getAttribute('role'),
    name: el.getAttribute('aria-label') || el.getAttribute('title') || (el.innerText || '').trim().slice(0, 80) || null,
    tag: el.tagName.toLowerCase(),
    testId: el.getAttribute('data-testid') || el.getAttribute('data-test-id'),
    id: el.id || null,
    automationId: el.getAttribute('data-automation-id') || el.getAttribute('data-automationid'),
    classes: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 160),
    visible: !!(el.getBoundingClientRect().width || el.getBoundingClientRect().height),
    cssPath: cssPath(el),
    xpath: xpath(el),
  });
  const pick = (sel) => Array.from(document.querySelectorAll(sel)).slice(0, 40).map(describe);
  return {
    url: location.href,
    composer: pick('textarea, [contenteditable="true"], input[type="text"], [role="textbox"]'),
    buttons: pick('button, [role="button"]'),
    messages: pick('[data-testid*="message" i], [class*="message" i], [role="listitem"], [data-content*="message" i]'),
    code: pick('pre, code, [class*="code" i]'),
    attachments: pick('[class*="attach" i], [class*="citation" i], [class*="file" i], [download], a[href^="blob:"]'),
    iframes: Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, name: f.name, id: f.id })),
  };
})()`;

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(process.cwd(), 'runs', `probe-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  const context: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'msedge',
    headless: false,
    acceptDownloads: true,
    downloadsPath: join(outDir, 'downloads'),
    viewport: null,
    args: ['--start-maximized'],
  });

  const page: Page = context.pages()[0] ?? (await context.newPage());
  page.on('download', (d) => console.log('DOWNLOAD EVENT:', d.suggestedFilename(), d.url().slice(0, 60)));

  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded' });

  const composer = page.getByRole('textbox').first();
  await composer.waitFor({ state: 'visible', timeout: 5 * 60 * 1000 });
  await page.waitForTimeout(2000);

  if (PROBE_PROMPT) {
    await composer.fill(PROBE_PROMPT);
    await composer.press('Enter');
    console.log('Prompt sent, waiting 45s for the reply to stream...');
    await page.waitForTimeout(45_000);
  }

  const data = (await page.evaluate(COLLECT)) as Record<string, Candidate[] | unknown>;
  writeFileSync(join(outDir, 'candidates.json'), JSON.stringify(data, null, 2), 'utf8');
  writeFileSync(join(outDir, 'page.html'), await page.content(), 'utf8');
  await page.screenshot({ path: join(outDir, 'screenshot.png'), fullPage: true });

  const aria = await page.locator('body').ariaSnapshot().catch(() => 'aria snapshot unavailable');
  writeFileSync(join(outDir, 'aria.txt'), aria, 'utf8');

  console.log('Probe written to', outDir);
  console.log('Close the browser window when you are done inspecting.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
