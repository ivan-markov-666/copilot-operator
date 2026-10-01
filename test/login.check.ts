/**
 * "Sign in to Copilot" from Settings (POST /api/login): what `cop login` does, from the page.
 *
 * Asked for on 2026-10-01. The window is the scripted chat's here, so what is pinned is the order
 * of things and what the page is told: it opens, it is closed again whatever happened, an account
 * signs the profile out and is asked for by name, the page says which account it found, and the
 * sign-in takes the browser like a run does, so neither can open a second window on the profile.
 *
 *   npm run check:login
 */
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

type Login = { ok: boolean; accounts: string[]; account?: string; matched?: boolean; message: string };

async function scenario(title: string, body: (h: Harness) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness();
  try {
    await body(h);
    t.check('every window opened was closed again', h.chat.opened, h.chat.closed);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

await scenario('signing in with no account: the window opens, waits, closes, and says who is in', async (h) => {
  h.chat.accounts = ['ivan@company.com'];
  const r = await h.call<Login>('POST', '/login', {});
  t.check('signed in', [r.ok, r.accounts], [true, ['ivan@company.com']]);
  t.truthy('and the page is told which account the chat shows', /ivan@company\.com/.test(r.message), r.message);
  t.check('it waited for the sign-in once, and signed nothing out', [h.chat.signIns, h.chat.signOuts, h.chat.askedAccounts], [1, 0, []]);
  t.check('one window, closed again', [h.chat.opened, h.chat.closed], [1, 1]);
});

await scenario('signing in as a named account: signed out first, asked for by name, confirmed', async (h) => {
  h.chat.accounts = ['someone@company.com'];
  const r = await h.call<Login>('POST', '/login', { account: ' Someone@Company.com ' });
  t.check('the profile was signed out and that account asked for', [h.chat.signOuts, h.chat.askedAccounts], [1, ['Someone@Company.com']]);
  t.check('confirmed, whatever the letter case', [r.ok, r.matched, r.account], [true, true, 'Someone@Company.com']);
});

await scenario('signed in as somebody else: said, not passed off as success', async (h) => {
  h.chat.accounts = ['other@company.com'];
  const r = await h.call<Login>('POST', '/login', { account: 'wanted@company.com' });
  t.check('not ok, and not matched', [r.ok, r.matched], [false, false]);
  t.truthy('the message names who is signed in and what to do', /other@company\.com/.test(r.message) && /Use another account/.test(r.message), r.message);
});

await scenario('an account that is not an address is refused before any window opens', async (h) => {
  const r = await h.raw('POST', '/login', { account: 'not an address' });
  t.check('refused as a bad request', r.status, 400);
  t.truthy('saying what to give', /not an account address/.test(JSON.stringify(r.body)), r.body);
  t.check('and no window was opened', h.chat.opened, 0);
});

await scenario('a run has the browser: the sign-in is refused until it is done', async (h) => {
  // A run whose first reply is held, so it keeps the browser while the sign-in is asked for.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const [s] = await h.importPlan({
    version: 1,
    sessions: [{ name: 'busy', onFailure: 'stop', vcs: { enabled: false, repoDir: '' }, review: { enabled: false },
      tasks: [{ title: 'held', prompt: 'Create here.txt in the project folder holding exactly here, and nothing else.' }] }],
  });
  h.chat.script(async () => {
    await gate;
    return reply.steps("Set-Content -Path here.txt -Value 'here' -Encoding utf8");
  }, reply.done());
  const started = await h.call<{ started: boolean }>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  t.check('the run started', started.started, true);
  await waitFor('the run to hold its reply', async () => h.chat.pending > 0);
  const during = await h.raw('POST', '/login', {});
  t.check('a sign-in while the run has the browser is refused', during.status, 400);
  t.truthy('saying the profile is in use', /in use/.test(JSON.stringify(during.body)), during.body);
  release();
  await h.idle();
  t.check('the run finished', (await h.session(s!.id)).tasks[0]!.status, 'done');
  t.check('and only its own window was ever opened', h.chat.opened, 1);
});

t.finish();
