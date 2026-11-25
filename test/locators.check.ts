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
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarness, Tally, waitFor } from './support/harness.js';
import { CHAT_LOCATOR_KEYS, DefaultChatLocators, DefaultPickerLocators } from '../src/transport/locators.js';
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

    /*
     * A sign-in on the way (second bug hunt, 2026-11-19): the check waited for it with nothing said, and a box its locator
     * did not find was waited on as a sign-in, fifteen minutes. Said now, on the tab and at the button; a box not found
     * is said at once (see the transport check), which the check and the reading of the models ask for.
     */
    let signedIn!: () => void;
    h.chat.signInAtStart = new Promise<void>((r) => (signedIn = r));
    const asked = h.chat.signInOpts.length;
    const checking = h.call<{ results: unknown[] }>('POST', '/locators/check');
    const waiting = await waitFor('the sign-in to be said', async () => ((await h.call<{ signIn?: boolean }>('GET', '/activity')).signIn ? true : null), 10_000).catch(() => false);
    signedIn();
    await checking;
    t.check('while it waits, the activity says a sign-in; once in, no longer; the box not waited on', [waiting, (await h.call<{ signIn?: boolean }>('GET', '/activity')).signIn ?? false, h.chat.signInOpts[asked]?.boxNotWaited], [true, false, true]);
    await h.call('POST', '/models/refresh');
    t.check('the reading of the models does not wait on a box either', h.chat.signInOpts.at(-1)?.boxNotWaited, true);

    /*
     * Found after all (second bug hunt, 2026-11-19): the box said missing while a slow sign-in was waited for, then found,
     * kept its red. Found now, its failure goes; one whose locator was changed since is not this one's to take away.
     */
    const found = (locator: string) => h.ops.bus.publish({ sessionId: 'found-check', type: 'browser:locator-found', level: 'info', message: 'found', data: { key: 'composer', locator } });
    h.ops.recordLocatorFailure({ key: 'composer', locator: DefaultChatLocators.composer, why: 'while the sign-in was waited for', stopped: false });
    await waitFor('the box kept', async () => ((await h.call<Failure[]>('GET', '/locators/failures')).some((x) => x.key === 'composer') ? true : null), 10_000).catch(() => undefined);
    found('#another-box');
    const stays = await waitFor('a moment', async () => (await h.call<Failure[]>('GET', '/locators/failures')).some((x) => x.key === 'composer'), 2_000).catch(() => false);
    found(DefaultChatLocators.composer);
    const gone = await waitFor('the box failure gone', async () => ((await h.call<Failure[]>('GET', '/locators/failures')).some((x) => x.key === 'composer') ? null : true), 10_000).catch(() => false);
    t.check('found by another locator: kept; found by its own: gone', [stays, gone], [true, true]);

    /*
     * A part of the chat that worked (2026-11-24: "uploaded" stayed red for days after the page took files again): a file
     * seen uploaded, a conversation named, a locator the bot found another way. Not a file sent unconfirmed.
     */
    const keysNow = async (): Promise<string[]> => (await h.call<Failure[]>('GET', '/locators/failures')).map((x) => x.key);
    const say = (event: string, data: Record<string, unknown>) => h.ops.bus.publish({ sessionId: 'worked-check', type: `browser:${event}`, level: 'info', message: event, data });
    for (const key of ['attachmentUploaded', 'renameSave', 'send'] as const) h.ops.recordLocatorFailure({ key, locator: DefaultChatLocators[key], why: 'for the check', stopped: false });
    await waitFor('the three kept', async () => ((await keysNow()).filter((k) => ['attachmentUploaded', 'renameSave', 'send'].includes(k)).length === 3 ? true : null), 10_000).catch(() => undefined);
    say('attached', { name: 'a.txt' });
    await new Promise((r) => setTimeout(r, 700));
    const unconfirmed = (await keysNow()).includes('attachmentUploaded');
    say('attached', { name: 'a.txt', uploaded: true });
    say('chat-named', { chatId: 'x', name: 'op/x/y' });
    const left = await waitFor('the two gone', async () => {
      const k = await keysNow();
      return k.includes('attachmentUploaded') || k.includes('renameSave') ? null : k;
    }, 10_000).catch(() => ['still there']);
    t.check('a file unconfirmed takes nothing away; one uploaded and a conversation named take theirs, not Send', [unconfirmed, left.includes('send'), left.includes('still there')], [true, true, false]);
    say('locator-worked-around', { key: 'send', locator: DefaultChatLocators.send, by: 'another way' });
    t.check('found another way: its own goes', await waitFor('send gone', async () => ((await keysNow()).includes('send') ? null : true), 10_000).catch(() => false), true);

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

console.log('\n--- the model menu\'s locators (2026-11-24): kept as the chat\'s are, gone when the menu is read ---');
{
  const h = await startHarness();
  try {
    const bus = (h.ops as unknown as { bus: EventBus }).bus;
    const failures = join(h.runsDir, 'picker-run', 'failures');
    await mkdir(failures, { recursive: true });
    const page = join(failures, 'locator-picker-button-1.html');
    await writeFile(page, '<!doctype html>\n<html><body><main><button id="newButton">Auto</button></main></body></html>', 'utf8');
    const list = async (): Promise<Failure[]> => await h.call<Failure[]>('GET', '/locators/failures');
    const say = (key: string, locator: string): void => {
      bus.publish({ sessionId: 's1', type: 'browser:locator-missing', level: 'warn', message: 'x', data: { key, locator, why: 'the model button was not on the page', stopped: false, html: page } });
    };
    say('picker:button', 'button#gptModeSwitcher');
    say('picker:model', DefaultPickerLocators.model);
    say('picker:nope', 'x');
    await waitFor('kept', async () => ((await list()).length === 2 ? true : null), 10_000).catch(() => undefined);
    t.check('kept, each under its own key; an unknown one not', (await list()).map((f) => [f.key, f.changed, f.html]).sort(), [['picker:button', false, true], ['picker:model', false, true]]);
    t.truthy('the text for a chatbot says what each is, and keeps the place of the name', (await list()).some((f) => f.key === 'picker:model' && f.prompt.includes('{$model_name} in it where the name goes')) && (await list()).some((f) => f.key === 'picker:button' && f.prompt.includes('opens the menu of models')), JSON.stringify(await list()));
    const res = await fetch(`http://127.0.0.1:${h.api.port}/api/locators/failures/${encodeURIComponent('picker:button')}/chatbot?lang=bg`, { headers: { 'x-cop-token': h.api.token } });
    const text = await res.text();
    t.check('its file for a chatbot: a download, what and where, the page in it', [res.status, /for-chatbot-picker-button-/.test(res.headers.get('content-disposition') ?? ''), text.includes('Settings → "The model menu\'s locators", the field in red'), text.includes('"button" of the model menu'), text.includes('id="newButton"'), text.includes('Speak to the user in Bulgarian')], [200, true, true, true, true, true]);

    // The menu read: its button and its rows work; a template is not said to.
    bus.publish({ sessionId: 's1', type: 'browser:models-read', level: 'info', message: 'x', data: { count: 0 } });
    await new Promise((r) => setTimeout(r, 300));
    t.check('a reading that found none takes nothing away', (await list()).length, 2);
    bus.publish({ sessionId: 's1', type: 'browser:models-read', level: 'info', message: 'x', data: { count: 4 } });
    await waitFor('the button\'s gone', async () => ((await list()).length === 1 ? true : null), 10_000).catch(() => undefined);
    t.check('the models read: the button\'s failure goes, the template\'s stays', (await list()).map((f) => f.key), ['picker:model']);
    const settings = await h.call<{ raw: Record<string, unknown> }>('GET', '/settings');
    await h.call('PUT', '/settings', { ...settings.raw, copilot: { ...((settings.raw.copilot as Record<string, unknown>) ?? {}), pickerLocators: { model: "//div[text()='{$model_name}']" } } });
    t.check('changed in Settings: said as changed', (await list()).map((f) => [f.key, f.changed]), [['picker:model', true]]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- the one file for a chatbot (2026-11-18): downloaded, all it needs in it, the piece of the page first ---');
{
  const h = await startHarness();
  try {
    const failures = join(h.runsDir, 'chatbot-run', 'failures');
    await mkdir(failures, { recursive: true });
    const page = join(failures, 'locator-renameSave-1.html');
    const piece = join(failures, 'locator-renameSave-1.piece.html');
    await writeFile(page, '<!doctype html>\n<html><body><main>the whole page itself</main><div role="dialog"><input id="new-session-name"><button>OK</button></div></body></html>', 'utf8');
    await writeFile(piece, '<div role="dialog"><input id="new-session-name"><button>OK</button></div>', 'utf8');
    h.ops.recordLocatorFailure({ key: 'renameSave', locator: DefaultChatLocators.renameSave, why: 'while the conversation was being named "op/x"', stopped: false, html: page, piece, around: 'the element the "renameInput" locator finds' });
    const get = (key: string, lang?: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${h.api.port}/api/locators/failures/${encodeURIComponent(key)}/chatbot${lang ? `?lang=${lang}` : ''}`, { headers: { 'x-cop-token': h.api.token } });
    const res = await waitFor('the file', async () => {
      const r = await get('renameSave', 'bg');
      return r.status === 200 ? r : null;
    }, 10_000).catch(() => null);
    const cd = res?.headers.get('content-disposition') ?? '';
    t.check('a download, never a page: a .txt named for the locator', [res?.status, res?.headers.get('content-type')?.split(';')[0], /attachment/.test(cd), /for-chatbot-renameSave-\d{8}-\d{6}\.txt/.test(cd), res?.headers.get('x-content-type-options')], [200, 'application/octet-stream', true, true, 'nosniff']);
    const text = res ? await res.text() : '';
    const at = (s: string): number => text.indexOf(s);
    t.check('in it: the goal, what failed, the old locator, the piece in Part 1, the whole page in Part 2, the language', [
      at('**Your goal:**') > 0,
      text.includes('the "Save" button of the dialog that renames a conversation'),
      text.includes(DefaultChatLocators.renameSave),
      at('<div role="dialog"><input id="new-session-name">') > at('## Part 1') && at('<div role="dialog"><input id="new-session-name">') < at('## Part 2'),
      at('<main>the whole page itself</main>') > at('## Part 2'),
      text.includes('Speak to the user in Bulgarian'),
    ], [true, true, true, true, true, true]);
    t.truthy('the list does not give out where the piece is', !JSON.stringify(await h.call('GET', '/locators/failures')).includes('piece.html'));

    // One kept before the piece was, its page outside the runs folder: still a file, with the way by hand.
    h.ops.recordLocatorFailure({ key: 'copy', locator: DefaultChatLocators.copy, why: 'x', stopped: true, html: join(h.base, 'elsewhere.html') });
    await writeFile(join(h.base, 'elsewhere.html'), "<p>not the bot's</p>", 'utf8');
    const old = await waitFor('the second file', async () => {
      const r = await get('copy');
      return r.status === 200 ? await r.text() : null;
    }, 10_000).catch(() => '');
    t.check("no piece, and a page outside the runs folder not read: no Part 1, no page, the way by hand, English", [old.includes('there is no Part 1'), old.includes("not the bot's"), old.includes('The page itself was not saved'), old.includes('Copy outerHTML'), old.includes('Speak to the user in English')], [true, false, true, true, true]);
    const none = await h.raw('GET', '/locators/failures/stop/chatbot');
    t.check('none kept for it: refused, said', [none.status, String(none.body).includes('No failure is kept for the "stop" locator')], [400, true]);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

/*
 * Found 2026-11-19 (second bug hunt): a list of the bot's own read as empty when it could not be read, and the next
 * change wrote that over it. Then (third hunt, 2026-11-20) refused, every failure after it was dropped without a word —
 * no banner, no red field, no file for a chatbot, for good. Now the broken one is moved aside, kept whole beside it, and
 * the list begun again with the failure that came.
 */
console.log('\n--- a list of failures there but not readable: kept aside, never written over, and the list goes on ---');
{
  const dir = mkdtempSync(join(tmpdir(), 'cop-failures-'));
  try {
    const file = join(dir, 'locator-failures.json');
    const broken = '[{"key": "send", "locator": "x", "at": "2026-11-19T00:00:00Z"';
    writeFileSync(file, broken, 'utf8');
    const kept = new LocatorFailures(file);
    const problem = await kept.record({ key: 'composer', locator: 'y', at: '2026-11-19T00:00:01Z', why: 'test', stopped: true }).then(() => '', (e: unknown) => (e as Error).message);
    const aside = readdirSync(dir).filter((n) => n.startsWith('locator-failures.json.unreadable-'));
    t.check('recorded over a broken list: the failure kept; the broken one beside it, as it was', [
      problem,
      (await kept.list()).map((f) => f.key),
      aside.length,
      aside[0] ? readFileSync(join(dir, aside[0]), 'utf8') : null,
    ], ['', ['composer'], 1, broken]);
    writeFileSync(file, '', 'utf8');
    await kept.record({ key: 'send', locator: 'z', at: '2026-11-19T00:00:02Z', why: 'test', stopped: true });
    t.check('an empty one is a list not begun: recorded', (await kept.list()).map((f) => f.key), ['send']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

t.finish();
