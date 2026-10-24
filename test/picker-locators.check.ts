/**
 * The model menu's locators (operator, 2026-10-24: "an option in Settings to edit the general locators"): what the
 * Settings page says of a locator is what the bot does with it.
 *
 * - the page's rules (`web/lib/pickerLocators.ts`) and the bot's (`src/transport/locators.ts`) refuse the same
 *   locators — a template without its placeholder, an axis with one colon — and fill a name in the same way;
 * - a locator saved in Settings reaches the transport: `pickerOptions` gives every window that picks a model the
 *   saved locators and, with `copilot.pickerSteps`, the step pictures;
 * - `/api/settings` gives the page the defaults and the folders the pictures go to.
 *
 *   npm run check:picker-locators
 */
import { join } from 'node:path';
import { DefaultPickerLocators, fillLocator as botFill, pickerLocatorProblem, PICKER_LOCATOR_KEYS } from '../src/transport/locators.js';
import { fillLocator as pageFill, locatorProblem, PICKER_KEYS, PLACEHOLDER } from '../web/lib/pickerLocators.js';
import { pickerOptions } from '../src/orchestrator/taskRunner.js';
import { RunConfigSchema } from '../src/config/schema.js';
import { startHarness, Tally } from './support/harness.js';

const t = new Tally();

console.log('--- the page and the bot, one set of rules ---');
t.check('the same five locators, the same placeholders', [PICKER_KEYS, PICKER_KEYS.map((k) => PLACEHOLDER[k])], [[...PICKER_LOCATOR_KEYS], [null, null, '{$model_name}', '{$provider_name}', '{$model_name}']]);
const samples: Array<[(typeof PICKER_KEYS)[number], string]> = [
  ['model', DefaultPickerLocators.model],
  ['model', "//div[text()='Think deeper']/parent::span"],
  ['model', "//div[text()='{$model_name}']/parent:span/parent:span/parent:div"],
  ['provider', DefaultPickerLocators.provider],
  ['provider', "//div[text()='{$model_name}']"],
  ['providerModel', DefaultPickerLocators.providerModel],
  ['providerModel', "//div[text()='{$provider_name}']"],
  ['button', 'button#gptModeSwitcher'],
  ['button', '//button[@aria-label="Model Selector"]'],
  ['rows', "//div[@role='menuitem' or @role='menuitemradio']"],
  ['rows', 'div:has(> span)'],
  ['model', ''],
  ['model', "css=[data-name='{$model_name}']"],
];
t.check(
  'each sample refused by both, or by neither',
  samples.map(([k, s]) => [k, s, pickerLocatorProblem(k, s) !== null]),
  samples.map(([k, s]) => [k, s, locatorProblem(k, s) !== null]),
);
t.check('what is refused', samples.map(([k, s]) => locatorProblem(k, s)?.kind ?? null), [null, 'placeholder', 'colons', null, 'placeholder', null, 'placeholder', null, null, null, null, null, null]);
const names = [{ model: 'Think deeper' }, { model: "Bob's" }, { model: 'say "hi" it\'s' }, { provider: 'Claude' }, { model: 'Opus 5.5', provider: 'Claude' }];
const templates = [DefaultPickerLocators.model, DefaultPickerLocators.provider, DefaultPickerLocators.providerModel, '//b[text()="{$model_name}"]', "[data-p='{$provider_name}'] [data-m='{$model_name}']"];
t.check(
  'a name filled in the same way',
  templates.flatMap((tp) => names.map((n) => pageFill(tp, n))),
  templates.flatMap((tp) => names.map((n) => botFill(tp, n))),
);

console.log('\n--- from Settings to the window that picks the model ---');
const cfg = RunConfigSchema.parse({ copilot: { pickerLocators: { model: "//b[text()='{$model_name}']" }, pickerSteps: true } });
t.check('the saved locators, and the step pictures when asked for', pickerOptions(cfg), { pickerLocators: { model: "//b[text()='{$model_name}']" }, modelStepShots: true });
t.check('nothing saved: nothing passed, the defaults stand', pickerOptions(RunConfigSchema.parse({})), {});

console.log('\n--- what the Settings page is given ---');
const h = await startHarness({});
try {
  const s = await h.call<{ picker?: { defaults: Record<string, string>; dirs: { run: string; read: string } }; resolved: { runsDir: string } }>('GET', '/settings');
  t.check('the defaults, as the bot has them', s.picker?.defaults, DefaultPickerLocators);
  t.check('where the pictures are kept', s.picker?.dirs, { run: join(s.resolved.runsDir, '_browser'), read: join(s.resolved.runsDir, '_models') });
  // Saved the way the page saves it, and read back as the bot reads it.
  const raw = (await h.call<{ raw: Record<string, unknown> }>('GET', '/settings')).raw;
  await h.call('PUT', '/settings', { ...raw, copilot: { ...((raw.copilot as Record<string, unknown>) ?? {}), pickerLocators: { provider: "//b[text()='{$provider_name}']" }, pickerSteps: true } });
  const loaded = await h.ops.settings.load();
  t.check('saved, it is what a run is given', pickerOptions(loaded), { pickerLocators: { provider: "//b[text()='{$provider_name}']" }, modelStepShots: true });
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h.stop();
}

t.finish();
