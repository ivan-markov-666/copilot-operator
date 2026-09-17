/**
 * One-time sign-in: opens the bot's own Edge profile, waits for the user to sign in
 * to Microsoft 365 Copilot, then verifies the chat surface is reachable.
 *
 *   npm run login
 *
 * The script never types credentials. It only waits for the composer to appear.
 */
import { chromium, type BrowserContext } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const PROFILE_DIR = process.env.A365_PROFILE ?? resolve(process.cwd(), 'profile');
const CHAT_URL = process.env.A365_URL ?? 'https://m365.cloud.microsoft/chat';
const SIGN_IN_TIMEOUT_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  mkdirSync(PROFILE_DIR, { recursive: true });

  const context: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'msedge',
    headless: false,
    acceptDownloads: true,
    viewport: null,
    args: ['--start-maximized'],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded' });

  console.log('Sign in to Microsoft 365 Copilot in the opened Edge window.');
  console.log('Waiting for the chat composer to appear (up to 15 minutes)...');

  const composer = page.getByRole('textbox').first();
  await composer.waitFor({ state: 'visible', timeout: SIGN_IN_TIMEOUT_MS });

  console.log('Signed in. Profile saved at:', PROFILE_DIR);
  console.log('Current URL:', page.url());
  await context.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
