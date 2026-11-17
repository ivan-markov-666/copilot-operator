/**
 * The chat's locators that found nothing, as the API keeps and serves them (operator, 2026-11-17: "a mechanism that
 * detects which locator exactly the bot failed on, so we can easily see which locator has to be updated … the bot saves
 * the page's HTML and gives it to the user"), with the real API and the scripted chat:
 *
 *   - a `browser:locator-missing` on the bus is kept, the last one for each locator, across a restart of the store;
 *   - the list says whether the locator has been changed in Settings since (then the banner and the red go), whether
 *     the page's HTML is there, and the text for a chatbot; it gives out no file's place;
 *   - the HTML downloads as a file, never as a page of this origin, and only from the bot's runs folder;
 *   - closing one takes it away.
 *
 *   npm run check:locators
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startHarness, Tally, waitFor } from './support/harness.js';
import { CHAT_LOCATOR_KEYS, DefaultChatLocators } from '../src/transport/locators.js';
import { LocatorFailures } from '../src/session/locatorFailures.js';
import type { EventBus } from '../src/session/events.js';

const t = new Tally();

type Failure = { key: string; locator: string; at: string; why: string; stopped: boolean; html: boolean; changed: boolean; prompt: string; picture?: unknown };

console.log('\n--- a locator that found nothing: kept, listed, its HTML downloaded, closed ---');
{
  const h = await startHarness();
  try {
    const failures = join(h.runsDir, 'some-run', 'failures');
    await mkdir(failures, { recursive: true });
    const html = join(failures, 'locator-send-1.html');
    await writeFile(html, '<!doctype html>\n<html><body><div data-test-id="chat-input-wrapper"></div></body></html>', 'utf8');
    const bus = (h.ops as unknown as { bus: EventBus }).bus;
    t.check('nothing kept at first', await h.call<Failure[]>('GET', '/locators/failures'), []);

    // As a run's window says it: on the bus, for its session.
    bus.publish({ sessionId: 's1', type: 'browser:locator-missing', level: 'error', message: 'x', data: { key: 'send', locator: DefaultChatLocators.send, why: 'after the message was written in the box', stopped: true, html, picture: join(failures, 'locator-send-1.png'), url: 'https://copilot.cloud.microsoft/home' } });
    const listed = await waitFor('the failure kept', async () => {
      const l = await h.call<Failure[]>('GET', '/locators/failures');
      return l.length ? l : null;
    }, 10_000).catch(() => [] as Failure[]);
    const f = listed[0];
    t.check('kept: which locator, as it was in force, what the bot was doing, that the work stopped', [listed.length, f?.key, f?.locator, f?.why, f?.stopped], [1, 'send', DefaultChatLocators.send, 'after the message was written in the box', true]);
    t.check('its HTML is there; the locator not changed since; no file place given out', [f?.html, f?.changed, 'picture' in (f ?? {}), typeof f?.html], [true, false, false, 'boolean']);
    t.truthy('with the text for a chatbot', !!f && f.prompt.includes('the button that sends the typed message') && f.prompt.includes(DefaultChatLocators.send), f?.prompt);

    // Kept in the data folder: a new store on the same file reads it.
    t.check('kept in the data folder', (await new LocatorFailures(join(h.dataDir, 'locator-failures.json')).list()).map((x) => x.key), ['send']);

    // The HTML, downloaded: a file, not a page of this origin.
    const res = await fetch(`http://127.0.0.1:${h.api.port}/api/locators/failures/send/html`, { headers: { 'x-cop-token': h.api.token } });
    t.check('downloaded as a file, never shown as a page', [res.status, res.headers.get('content-type')?.split(';')[0], /attachment/.test(res.headers.get('content-disposition') ?? ''), /copilot-page-send-\d{8}-\d{6}\.html/.test(res.headers.get('content-disposition') ?? ''), res.headers.get('x-content-type-options')], [200, 'application/octet-stream', true, true, 'nosniff']);
    t.truthy('the HTML as it was kept', (await res.text()).includes('chat-input-wrapper'));

    // One whose file is not in the runs folder is not served.
    h.ops.recordLocatorFailure({ key: 'copy', locator: DefaultChatLocators.copy, why: 'x', stopped: true, html: join(h.base, 'elsewhere.html') });
    await writeFile(join(h.base, 'elsewhere.html'), '<p>not the bot\'s</p>', 'utf8');
    await waitFor('the second kept', async () => ((await h.call<Failure[]>('GET', '/locators/failures')).length === 2 ? true : null), 10_000).catch(() => undefined);
    const outside = await h.raw('GET', '/locators/failures/copy/html');
    t.check("a file outside the bot's runs folder: refused", [outside.status, String(outside.body).includes("not in the bot's runs folder")], [400, true]);
    const unknown = await h.raw('GET', '/locators/failures/stop/html');
    t.check('none kept for it: refused, said', [unknown.status, String(unknown.body).includes('No HTML is kept for the "stop" locator')], [400, true]);
    // A key that is not a locator, or a failure the bus says without one: not kept.
    h.ops.recordLocatorFailure({ key: 'nope', locator: 'x' });
    bus.publish({ sessionId: 's1', type: 'browser:locator-missing', level: 'error', message: 'x', data: { locator: 'x' } });
    await new Promise((r) => setTimeout(r, 300));
    t.check('only known locators are kept', (await h.call<Failure[]>('GET', '/locators/failures')).map((x) => x.key).sort(), ['copy', 'send']);

    // Changed in Settings: no longer the one that found nothing.
    const settings = await h.call<{ raw: Record<string, unknown> }>('GET', '/settings');
    const copilot = { ...((settings.raw.copilot as Record<string, unknown>) ?? {}), chatLocators: { send: '#new-send' } };
    await h.call('PUT', '/settings', { ...settings.raw, copilot });
    const after = await h.call<Failure[]>('GET', '/locators/failures');
    t.check('the locator changed in Settings: said as changed; the other not', after.map((x) => [x.key, x.changed]).sort(), [['copy', false], ['send', true]]);

    // Closed.
    t.check('closed', await h.call<{ dismissed: boolean }>('DELETE', '/locators/failures/send'), { dismissed: true });
    t.check('and gone; closing it again says there was none', [(await h.call<Failure[]>('GET', '/locators/failures')).map((x) => x.key), await h.call<{ dismissed: boolean }>('DELETE', '/locators/failures/send')], [['copy'], { dismissed: false }]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- "Check the locators": through the API, a window opened and closed; found ones lose their failure ---');
{
  const h = await startHarness();
  try {
    // An old failure of Send, and a check that finds Send now and not Copy.
    h.ops.recordLocatorFailure({ key: 'send', locator: DefaultChatLocators.send, why: 'x', stopped: true });
    await waitFor('kept', async () => ((await h.call<Failure[]>('GET', '/locators/failures')).length ? true : null), 10_000).catch(() => undefined);
    h.chat.locatorFinds = { copy: { key: 'copy', status: 'none', count: 0 } };
    const opened = h.chat.opened;
    const r = await h.call<{ checkedAt: string; results: Array<{ key: string; status: string; count: number }> }>('POST', '/locators/check');
    t.check('every locator answered, in order', r.results.map((x) => x.key), [...CHAT_LOCATOR_KEYS]);
    t.check('as the window found them', [r.results.find((x) => x.key === 'send')?.status, r.results.find((x) => x.key === 'copy')?.status], ['found', 'none']);
    t.check('one window, opened and closed', [h.chat.opened - opened, h.chat.locatorChecks, h.chat.windows.filter((w) => w.isOpen()).length], [1, 1, 0]);
    const after = await waitFor('the failures as the check left them', async () => {
      const l = await h.call<Failure[]>('GET', '/locators/failures');
      return l.some((x) => x.key === 'copy') ? l : null;
    }, 10_000).catch(() => [] as Failure[]);
    t.check('Send, found now, lost its failure; Copy, not found, has one, as not stopping the work', after.map((x) => [x.key, x.stopped]), [['copy', false]]);

    // A step of the operator's own (2026-11-17): checked with the chat's, after them; one required not found is kept by its name.
    const settings = await h.call<{ raw: Record<string, unknown> }>('GET', '/settings');
    const step = { id: 'mode', name: 'Chat mode', when: 'message', locator: '#mode-chat', action: 'click', must: true, waitSec: 2, off: false };
    await h.call('PUT', '/settings', { ...settings.raw, copilot: { ...((settings.raw.copilot as Record<string, unknown>) ?? {}), extraSteps: [step] } });
    h.chat.locatorFinds = {};
    h.chat.stepFinds = { mode: 'none' };
    const r2 = await h.call<{ checkedAt: string; results: Array<{ key: string; status: string }> }>('POST', '/locators/check');
    t.check("the operator's step answered after the chat's locators", r2.results.slice(-1), [{ key: 'step:mode', status: 'none', count: 0 }]);
    const withStep = await waitFor('the step kept', async () => {
      const l = await h.call<Array<Failure & { name?: string }>>('GET', '/locators/failures');
      return l.find((x) => x.key === 'step:mode') ?? null;
    }, 10_000).catch(() => null);
    t.check('kept as the step, by its name, its locator; not changed', [withStep?.name, withStep?.locator, withStep?.changed], ['Chat mode', '#mode-chat', false]);
    t.truthy('the text for a chatbot says what the step is for', !!withStep && withStep.prompt.includes('"Chat mode"') && withStep.prompt.includes('#mode-chat'), withStep?.prompt);
    const s2 = await h.call<{ raw: Record<string, unknown> }>('GET', '/settings');
    await h.call('PUT', '/settings', { ...s2.raw, copilot: { ...((s2.raw.copilot as Record<string, unknown>) ?? {}), extraSteps: [{ ...step, locator: 'role=button[name="Chat"]' }] } });
    const changed = (await h.call<Failure[]>('GET', '/locators/failures')).find((x) => x.key === 'step:mode');
    t.check('its locator changed in Settings: changed (the banner and the red go)', changed?.changed, true);
    const s3 = await h.call<{ raw: Record<string, unknown> }>('GET', '/settings');
    await h.call('PUT', '/settings', { ...s3.raw, copilot: { ...((s3.raw.copilot as Record<string, unknown>) ?? {}), extraSteps: [{ ...step, off: true }] } });
    t.check('the same step switched off: changed too', (await h.call<Failure[]>('GET', '/locators/failures')).find((x) => x.key === 'step:mode')?.changed, true);
    // Its HTML downloads under a file name Windows takes: no colon.
    const failuresDir = join(h.runsDir, 'step-run', 'failures');
    await mkdir(failuresDir, { recursive: true });
    await writeFile(join(failuresDir, 'step-mode-1.html'), '<p>step page</p>', 'utf8');
    h.ops.recordLocatorFailure({ key: 'step:mode', name: 'Chat mode', locator: '#mode-chat', why: 'x', stopped: true, html: join(failuresDir, 'step-mode-1.html') });
    const dl = await waitFor('its HTML', async () => {
      const res = await fetch(`http://127.0.0.1:${h.api.port}/api/locators/failures/${encodeURIComponent('step:mode')}/html`, { headers: { 'x-cop-token': h.api.token } });
      return res.status === 200 ? res : null;
    }, 10_000).catch(() => null);
    t.truthy("a step's HTML: downloaded under a name with no colon", /copilot-page-step-mode-\d{8}-\d{6}\.html/.test(dl?.headers.get('content-disposition') ?? ''), dl?.headers.get('content-disposition'));
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

t.finish();
