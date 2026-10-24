/**
 * The model picker (`selectModel` in src/transport/copilotTransport.ts), driven in a real browser
 * against a local page that behaves like Copilot's menu — never against Copilot.
 *
 * The page copies what matters from the live one: the picker button (`#gptModeSwitcher`) showing a
 * shortened name, a menu of `menuitemradio` rows marked `aria-checked`, a `GPT` group row that opens
 * a submenu on hover, and the behaviour behind the bug this check was written for: choosing the row
 * that is already chosen does nothing, so the menu stays open over the chat, while Escape closes it.
 * The browser is Playwright's own headless Chromium with a fresh profile; the page is set from a
 * string and loads nothing.
 *
 *   npm run check:modelpicker
 */
import { chromium, type Page } from 'playwright';
import { CopilotTransport } from '../src/transport/copilotTransport.js';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tally } from './support/harness.js';

const t = new Tally();

const PAGE = String.raw`<!doctype html><html><body>
<button id="gptModeSwitcher" aria-label="Model Selector" aria-expanded="false"><span id="shown"></span></button>
<div id="m365-chat-editor-target-element" contenteditable="true" style="margin-top:200px;min-height:40px">composer</div>
<div id="menu" role="menu" style="display:none">
  <div role="menuitemradio" data-name="Auto">Auto<br>Decides how long to think</div>
  <div role="menuitemradio" data-name="Think deeper">Think deeper<br>Takes longer</div>
  <div role="menuitem" id="gpt" aria-haspopup="menu">GPT<br>OpenAI</div>
</div>
<div id="sub" role="menu" style="display:none">
  <div role="menuitemradio" data-name="GPT 5.6 Think deeper" data-short="GPT 5.6 Think">GPT 5.6 Think deeper</div>
  <div role="menuitemradio" data-name="GPT 5.6 Quick response" data-short="GPT 5.6 Quick">GPT 5.6 Quick response</div>
</div>
<script>
  // How this copy of the menu closes: 'any' (Escape anywhere, as the first version of this check
  // assumed), 'focused' (Escape only when focus is inside the menu), 'toggle' (Escape never; the
  // picker button toggles), 'outside' (only a press outside the menu and its button closes it).
  const MODE = '__MODE__';
  let current = 'Auto';
  window.clicksOnChosen = 0;
  const shortOf = (el) => el.dataset.short || el.dataset.name;
  const button = document.getElementById('gptModeSwitcher');
  function render() {
    for (const el of document.querySelectorAll('[role=menuitemradio]')) el.setAttribute('aria-checked', String(el.dataset.name === current));
    const row = [...document.querySelectorAll('[role=menuitemradio]')].find((el) => el.dataset.name === current);
    document.getElementById('shown').textContent = row ? shortOf(row) : current;
  }
  const menu = document.getElementById('menu'), sub = document.getElementById('sub');
  const isOpen = () => menu.style.display !== 'none';
  const open = () => { menu.style.display = 'block'; button.setAttribute('aria-expanded', 'true'); };
  const close = () => { menu.style.display = 'none'; sub.style.display = 'none'; button.setAttribute('aria-expanded', 'false'); };
  button.onclick = () => { if (isOpen() && MODE === 'toggle') close(); else open(); };
  document.getElementById('gpt').onmouseenter = () => { sub.style.display = 'block'; };
  document.getElementById('gpt').onclick = () => { sub.style.display = 'block'; };
  for (const el of document.querySelectorAll('[role=menuitemradio]')) {
    el.tabIndex = -1;
    el.onclick = () => {
      // Copilot's behaviour: the row already in force ignores the click and the menu stays open.
      if (el.dataset.name === current) { window.clicksOnChosen += 1; return; }
      current = el.dataset.name; render(); close();
    };
  }
  menu.tabIndex = -1; sub.tabIndex = -1;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const inMenu = menu.contains(document.activeElement) || sub.contains(document.activeElement);
    if (MODE === 'any' || (MODE === 'focused' && inMenu)) close();
  });
  document.addEventListener('mousedown', (e) => {
    if (MODE !== 'outside' || !isOpen()) return;
    if (!menu.contains(e.target) && !sub.contains(e.target) && !button.contains(e.target)) close();
  });
  window.setModel = (name) => { current = name; render(); };
  render();
</script></body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  for (const mode of ['any', 'focused', 'toggle', 'outside']) {
    console.log(`\n=== a menu that closes on: ${mode} ===`);
    const page = await browser.newPage();
    const transportDir = mkdtempSync(join(tmpdir(), 'cop-picker-'));
    const transport = new CopilotTransport({ profileDir: '', transportDir, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000, modelSettleMs: 50, modelBeforePressMs: 20, modelPollMs: 100, modelAppearMs: 1500, modelAttempts: 3 });
    // The transport is given this page instead of opening Edge; `open()` is never called.
    (transport as unknown as { page: Page }).page = page;
    await page.setContent(PAGE.replace('__MODE__', mode));

    const menuOpen = async (): Promise<boolean> => await page.evaluate(() => [...document.querySelectorAll('[role=menu]')].some((m) => (m as HTMLElement).style.display !== 'none'));
    const clicksOnChosen = async (): Promise<number> => await page.evaluate(() => (window as unknown as { clicksOnChosen: number }).clicksOnChosen);
    const setModel = async (name: string): Promise<void> => await page.evaluate((n) => (window as unknown as { setModel: (x: string) => void }).setModel(n), name);

    let r = await transport.selectModel('Think deeper');
    t.check(`${mode}: a model not chosen yet is chosen, menu closed`, [r.ok, r.current, await menuOpen()], [true, 'Think deeper', false]);

    r = await transport.selectModel('GPT 5.6 Quick response');
    t.check(`${mode}: one inside the GPT group too, menu closed`, [r.ok, r.current, await menuOpen()], [true, 'GPT 5.6 Quick response', false]);

    await setModel('GPT 5.6 Think deeper');
    const before = await clicksOnChosen();
    r = await transport.selectModel('GPT 5.6 Think deeper');
    t.check(`${mode}: already chosen (the button says only "GPT 5.6 Think"): in force, not clicked, menu closed`, [r.ok, r.current, (await clicksOnChosen()) - before, await menuOpen()], [true, 'GPT 5.6 Think deeper', 0, false]);

    await setModel('Think deeper');
    r = await transport.selectModel('Think deeper');
    t.check(`${mode}: a top-level one already chosen: in force, menu closed`, [r.ok, r.current, await menuOpen()], [true, 'Think deeper', false]);

    r = await transport.selectModel('Claude Opus');
    t.check(`${mode}: one the picker does not offer: refused, menu closed, model unchanged`, [r.ok, await menuOpen(), r.current], [false, false, 'Think deeper']);

    const listed = await transport.listModels();
    t.check(`${mode}: reading the whole list leaves the menu closed`, [listed.options.map((o) => o.name), await menuOpen()], [['Auto', 'Think deeper', 'GPT 5.6 Think deeper', 'GPT 5.6 Quick response'], false]);
    // The menu as it was is kept beside the reading (2026-10-01), so a wrong list can be looked into.
    const kept = ['models-top.html', 'models-top.png', 'models-top.json', 'models-group-GPT.json', 'models-result.json'].map((f) => existsSync(join(transportDir, f)));
    t.check(`${mode}: the menu, a picture of it, and what was read from it are kept`, kept, [true, true, true, true, true]);
    const result = JSON.parse(readFileSync(join(transportDir, 'models-result.json'), 'utf8')) as { options: Array<{ name: string }> };
    t.check(`${mode}: the kept result is the list returned`, result.options.map((o) => o.name), listed.options.map((o) => o.name));
    t.truthy(`${mode}: the kept HTML is the menu's`, readFileSync(join(transportDir, 'models-top.html'), 'utf8').includes('Think deeper'), '');
    rmSync(transportDir, { recursive: true, force: true });
    await page.close();
  }

  /*
   * The menu as the live page had it on 2026-10-05: the GPT row carries a test id, its submenu is labelled
   * by it, and once a model of the group is chosen the group's row reads that model's name. Read by text,
   * the group then lost that model, and a run asked for it went on Auto.
   */
  console.log('\n=== the live menu of 2026-10-05: a labelled submenu, and a group row renamed by the choice ===');
  {
    const live = PAGE.replace('__MODE__', 'any')
      .replace('<div role="menuitem" id="gpt" aria-haspopup="menu">GPT<br>OpenAI</div>', '<div role="menuitem" id="gpt" data-test-id="gptSubMenuModelTrigger-OpenAI" aria-haspopup="menu">GPT<br>OpenAI</div>')
      .replace('<div id="sub" role="menu" style="display:none">', '<div id="sub" role="menu" aria-labelledby="gpt" style="display:none">')
      .replace(
        "document.getElementById('shown').textContent = row ? shortOf(row) : current;",
        "document.getElementById('shown').textContent = row ? shortOf(row) : current;\n    const inGroup = row && document.getElementById('sub').contains(row);\n    document.getElementById('gpt').innerHTML = (inGroup ? current : 'GPT') + '<br>OpenAI';",
      );
    const page = await browser.newPage();
    const transportDir = mkdtempSync(join(tmpdir(), 'cop-picker-'));
    const transport = new CopilotTransport({ profileDir: '', transportDir, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000, modelSettleMs: 50, modelBeforePressMs: 20, modelPollMs: 100, modelAppearMs: 1500, modelAttempts: 3 });
    (transport as unknown as { page: Page }).page = page;
    await page.setContent(live);
    const setModel = async (name: string): Promise<void> => await page.evaluate((n) => (window as unknown as { setModel: (x: string) => void }).setModel(n), name);
    const menuOpen = async (): Promise<boolean> => await page.evaluate(() => [...document.querySelectorAll('[role=menu]')].some((m) => (m as HTMLElement).style.display !== 'none'));

    const first = await transport.listModels();
    const quick = first.options.find((o) => o.name === 'GPT 5.6 Quick response');
    const deep = first.options.find((o) => o.name === 'GPT 5.6 Think deeper');
    t.check('the list, each model with its place; the group known by its test id',
      [first.options.map((o) => o.name), deep?.locator, quick?.locator?.index],
      [['Auto', 'Think deeper', 'GPT 5.6 Think deeper', 'GPT 5.6 Quick response'], { role: 'menuitemradio', index: 0, group: { testId: 'gptSubMenuModelTrigger-OpenAI', index: 2, name: 'GPT', vendor: 'OpenAI' } }, 1]);

    await setModel('GPT 5.6 Think deeper');
    const renamed = await transport.listModels();
    t.check('with a model of the group in force (its row reads that name): the group still lists both, under "GPT"',
      [renamed.options.filter((o) => o.group).map((o) => `${o.group} > ${o.name}${o.selected ? ' *' : ''}`), await menuOpen()],
      [['GPT > GPT 5.6 Think deeper *', 'GPT > GPT 5.6 Quick response'], false]);

    let r = await transport.selectModel('GPT 5.6 Quick response', { locator: quick?.locator });
    t.check('the other model of the group chosen at its saved place, while the group row carries the first one\'s name', [r.ok, r.by, r.current, await menuOpen()], [true, 'locator', 'GPT 5.6 Quick response', false]);
    r = await transport.selectModel('GPT 5.6 Think deeper', { locator: deep?.locator });
    t.check('and back again', [r.ok, r.by, r.current], [true, 'locator', 'GPT 5.6 Think deeper']);
    r = await transport.selectModel('Auto', { locator: first.options.find((o) => o.name === 'Auto')?.locator });
    // A menu not shaped as the work page is: the operator's templates find nothing in it, and its saved place is used.
    t.check('and a model of the top menu, at its saved place',[r.ok, r.by, r.current, await menuOpen()], [true, 'locator', 'Auto', false]);

    // The page moved the models since the list was read: the saved place now holds the other one.
    await page.evaluate(() => {
      const sub = document.getElementById('sub')!;
      sub.appendChild(sub.firstElementChild!);
    });
    r = await transport.selectModel('GPT 5.6 Think deeper', { locator: deep?.locator });
    t.check('a model moved within its group is still the one chosen, not the one now at its old place', [r.ok, r.current], [true, 'GPT 5.6 Think deeper']);
    r = await transport.selectModel('Claude Opus', { locator: { role: 'menuitemradio', index: 0 } });
    t.check('a model gone from the page is refused, and the chat stays where it was', [r.ok, r.current, await menuOpen()], [false, 'GPT 5.6 Think', false]);
    rmSync(transportDir, { recursive: true, force: true });
    await page.close();
  }

  /*
   * The operator's work machine (2026-10-05): a Claude group above GPT. Its submenu can be open when the
   * GPT row is hovered — here it opens with the menu — and the reader took the first submenu on screen
   * for GPT's, so GPT's models were Claude's and the run could not choose its model.
   */
  console.log('\n=== two groups: Claude above GPT, its submenu already open ===');
  {
    const two = String.raw`<!doctype html><html><body>
<button id="gptModeSwitcher" aria-label="Model Selector" aria-expanded="false"><span id="shown"></span></button>
<div id="m365-chat-editor-target-element" contenteditable="true" style="margin-top:200px;min-height:40px">composer</div>
<div id="menu" role="menu" aria-labelledby="gptModeSwitcher" style="display:none">
  <div role="menuitemradio" data-name="Auto">Auto<br>Decides how long to think</div>
  <div role="menuitemradio" data-name="Think deeper">Think deeper<br>Takes longer</div>
  <div role="menuitemradio" data-name="Advanced reasoning (Experimental)"><div>Advanced reasoning <span>(Experimental)</span></div><div>Slow and careful</div></div>
  <div role="menuitem" id="claude" data-test-id="gptSubMenuModelTrigger-Claude" aria-haspopup="menu">Claude<br>Anthropic</div>
  <div role="menuitem" id="gpt" data-test-id="gptSubMenuModelTrigger-OpenAI" aria-haspopup="menu">GPT<br>OpenAI</div>
</div>
<div id="sub-claude" role="menu" aria-labelledby="claude" style="display:none">
  <div role="menuitemradio" data-name="Claude Opus 4.7 Think deeper" data-short="Claude Opus 4.7 Think">Claude Opus 4.7 Think deeper</div>
  <div role="menuitemradio" data-name="Claude Sonnet 4.6 Quick response" data-short="Claude Sonnet 4.6 Quick">Claude Sonnet 4.6 Quick response</div>
</div>
<div id="sub-gpt" role="menu" aria-labelledby="gpt" style="display:none">
  <div role="menuitemradio" data-name="GPT-5.6 Sol Quick response" data-short="GPT-5.6 Sol Quick">GPT-5.6 Sol Quick response</div>
  <div role="menuitemradio" data-name="GPT-5.6 Sol Think deeper" data-short="GPT-5.6 Sol Think">GPT-5.6 Sol Think deeper</div>
</div>
<script>
  let current = 'Auto';
  const button = document.getElementById('gptModeSwitcher');
  const menu = document.getElementById('menu');
  const subs = { claude: document.getElementById('sub-claude'), gpt: document.getElementById('sub-gpt') };
  const rows = () => [...document.querySelectorAll('[role=menuitemradio]')];
  function render() {
    for (const el of rows()) el.setAttribute('aria-checked', String(el.dataset.name === current));
    const row = rows().find((el) => el.dataset.name === current);
    document.getElementById('shown').textContent = row ? (row.dataset.short || row.dataset.name) : current;
    // The live page's habit: a group's row reads the model chosen in it.
    for (const [g, sub] of Object.entries(subs)) {
      const inside = row && sub.contains(row);
      document.getElementById(g).innerHTML = (inside ? current : (g === 'gpt' ? 'GPT' : 'Claude')) + '<br>' + (g === 'gpt' ? 'OpenAI' : 'Anthropic');
    }
  }
  const close = () => { menu.style.display = 'none'; for (const s of Object.values(subs)) s.style.display = 'none'; button.setAttribute('aria-expanded', 'false'); };
  // Opening the menu opens Claude's submenu with it: any reason a sibling's submenu is on screen.
  button.onclick = () => { menu.style.display = 'block'; subs.claude.style.display = 'block'; button.setAttribute('aria-expanded', 'true'); };
  for (const g of Object.keys(subs)) {
    const open = () => { for (const s of Object.values(subs)) s.style.display = 'none'; subs[g].style.display = 'block'; };
    document.getElementById(g).onmouseenter = open;
    document.getElementById(g).onclick = open;
  }
  for (const el of rows()) el.onclick = () => { if (el.dataset.name !== current) { current = el.dataset.name; render(); close(); } };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.setModel = (name) => { current = name; render(); };
  render();
</script></body></html>`;
    const page = await browser.newPage();
    const transportDir = mkdtempSync(join(tmpdir(), 'cop-picker-'));
    const transport = new CopilotTransport({ profileDir: '', transportDir, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000, modelSettleMs: 50, modelBeforePressMs: 20, modelPollMs: 100, modelAppearMs: 1500, modelAttempts: 3 });
    (transport as unknown as { page: Page }).page = page;
    await page.setContent(two);
    const menuOpen = async (): Promise<boolean> => await page.evaluate(() => [...document.querySelectorAll('[role=menu]')].some((m) => (m as HTMLElement).style.display !== 'none'));

    const list = await transport.listModels();
    t.check('each group lists its own models', list.options.map((o) => `${o.group ? `${o.group} > ` : ''}${o.name}`), [
      'Auto', 'Think deeper', 'Advanced reasoning (Experimental)',
      'Claude > Claude Opus 4.7 Think deeper', 'Claude > Claude Sonnet 4.6 Quick response',
      'GPT > GPT-5.6 Sol Quick response', 'GPT > GPT-5.6 Sol Think deeper',
    ]);
    const at = (name: string) => list.options.find((o) => o.name === name)?.locator;
    let r = await transport.selectModel('GPT-5.6 Sol Think deeper', { locator: at('GPT-5.6 Sol Think deeper') });
    t.check('a GPT model chosen at its place, though Claude\'s submenu was open', [r.ok, r.by, r.current, await menuOpen()], [true, 'locator', 'GPT-5.6 Sol Think deeper', false]);
    r = await transport.selectModel('Claude Opus 4.7 Think deeper', { locator: at('Claude Opus 4.7 Think deeper') });
    t.check('then a Claude one', [r.ok, r.by, r.current], [true, 'locator', 'Claude Opus 4.7 Think deeper']);
    r = await transport.selectModel('GPT-5.6 Sol Quick response', { locator: at('GPT-5.6 Sol Quick response') });
    t.check('and back to GPT, the Claude row now reading the Claude model', [r.ok, r.by, r.current], [true, 'locator', 'GPT-5.6 Sol Quick response']);
    // A name the page splits over two elements: text() sees "Advanced reasoning " only.
    r = await transport.selectModel('Advanced reasoning (Experimental)', { locator: at('Advanced reasoning (Experimental)') });
    t.check('a model whose name is split over two elements', [r.ok, r.by, r.current], [true, 'locator', 'Advanced reasoning (Experimental)']);
    // With no saved place, as a run with an old list: found by name across both groups.
    r = await transport.selectModel('Claude Sonnet 4.6 Quick response');
    t.check('with no saved place: found by name', [r.ok, r.current], [true, 'Claude Sonnet 4.6 Quick response']);
    const again = await transport.listModels();
    t.check('read again with a Claude model in force: still each group its own', again.options.filter((o) => o.group).map((o) => `${o.group} > ${o.name}${o.selected ? ' *' : ''}`), [
      'Claude > Claude Opus 4.7 Think deeper', 'Claude > Claude Sonnet 4.6 Quick response *',
      'GPT > GPT-5.6 Sol Quick response', 'GPT > GPT-5.6 Sol Think deeper',
    ]);
    rmSync(transportDir, { recursive: true, force: true });
    await page.close();
  }
  /*
   * The operator's own locators, on a copy of the work machine's menu: four models at the top, a Claude group and a
   * GPT group, each opened by pressing it; each name in a div two spans down from its row, as on the work page of
   * 2026-10-24, where the operator's three templates found each row once.
   */
  console.log('\n=== the operator\'s locators, on the work machine\'s menu ===');
  {
    const { templateTarget } = await import('../src/transport/copilotTransport.js');
    const { DefaultPickerLocators, fillLocator, pickerLocatorProblem, resolvePickerLocators, playwrightSelector } = await import('../src/transport/locators.js');
    // The button may drop the last word of the name, no more (2026-10-06): "GPT" alone took every GPT model for set.
    const { buttonShows } = await import('../src/transport/modelMatch.js');
    /** Where each model is, read from the page once, as Settings' list gives a run its places. */
    const placesOf = async (tr: CopilotTransport) => {
      const list = await tr.listModels();
      return (n: string) => list.options.find((o) => o.name === n)?.locator;
    };
    t.check('what the picker button may show for "GPT-5.6 Sol Think deeper"', [
      buttonShows('GPT-5.6 Sol Think deeper', 'GPT-5.6 Sol Think deeper'), buttonShows('GPT-5.6 Sol Think', 'GPT-5.6 Sol Think deeper'),
      buttonShows('GPT-5.6 Sol', 'GPT-5.6 Sol Think deeper'), buttonShows('GPT', 'GPT-5.6 Sol Think deeper'), buttonShows('Think deeper', 'GPT-5.6 Sol Think deeper'),
    ], [true, true, false, false, false]);
    /*
     * The operator's templates (2026-10-24), filled with the names the list read: no model and no provider is
     * written in the code, so any the page offers is found the same way.
     */
    t.check('the defaults are the operator\'s three templates', [DefaultPickerLocators.model, DefaultPickerLocators.provider, DefaultPickerLocators.providerModel], [
      "//div[text()='{$model_name}']/parent::span/parent::span/parent::div",
      "//div[text()='{$provider_name}']/parent::span/parent::span/parent::div[contains(@aria-haspopup, 'menu')]",
      "//div[text()='{$model_name}']/parent::span/parent::span/parent::div[not(contains(@aria-haspopup, 'menu'))]",
    ]);
    const target = (n: string, group?: string) => {
      const x = templateTarget(n, { role: 'menuitem', index: 0, ...(group ? { group: { index: 4, name: group } } : {}) }, DefaultPickerLocators);
      return x ? [x.kind, x.group?.locator ?? null, x.locator] : null;
    };
    t.check('a model of the main menu: its own template, filled', target('Think deeper'), ['model', null, "//div[text()='Think deeper']/parent::span/parent::span/parent::div"]);
    t.check('a model of a provider: the provider\'s, then the model\'s, both filled', target('Opus 5.5', 'Claude'), [
      'providerModel',
      "//div[text()='Claude']/parent::span/parent::span/parent::div[contains(@aria-haspopup, 'menu')]",
      "//div[text()='Opus 5.5']/parent::span/parent::span/parent::div[not(contains(@aria-haspopup, 'menu'))]",
    ]);
    t.check('any provider, not only Claude and GPT', target('Gemini 3 Pro', 'Gemini')?.[1], "//div[text()='Gemini']/parent::span/parent::span/parent::div[contains(@aria-haspopup, 'menu')]");
    t.check('a model whose place is not known yet has no target: the list is read first', templateTarget('Think deeper', undefined, DefaultPickerLocators), null);
    t.check('a name with a quote in it does not break the locator open', [
      fillLocator("//div[text()='{$model_name}']", { model: "Bob's model" }),
      fillLocator("//div[text()='{$model_name}']", { model: 'say "hi" it\'s' }),
      fillLocator('//div[text()="{$provider_name}"]', { provider: 'A "B"' }),
    ], [`//div[text()="Bob's model"]`, `//div[text()=concat('say "hi" it', "'", 's')]`, `//div[text()='A "B"']`]);
    t.check('what is wrong with a locator, said', [
      pickerLocatorProblem('model', "//div[text()='Think deeper']/parent::span"),
      pickerLocatorProblem('provider', "//div[text()='{$model_name}']"),
      pickerLocatorProblem('model', "//div[text()='{$model_name}']/parent:span/parent:span/parent:div"),
      pickerLocatorProblem('button', 'button#gptModeSwitcher'),
      pickerLocatorProblem('providerModel', DefaultPickerLocators.providerModel),
    ], ['it has no {$model_name}: put it where the name goes', 'it has no {$provider_name}: put it where the name goes', '"parent:" needs two colons: parent::', null, null]);
    const resolved = resolvePickerLocators({ model: "//b[text()='{$model_name}']", provider: '//b[text()="no placeholder"]', rows: '  ', button: '#other' });
    t.check("Settings' own where usable, the default where not, and why", [resolved.locators.model, resolved.locators.provider, resolved.locators.rows, resolved.locators.button, resolved.problems], [
      "//b[text()='{$model_name}']", DefaultPickerLocators.provider, DefaultPickerLocators.rows, '#other',
      ['the provider locator in Settings is not used, it has no {$provider_name}: put it where the name goes'],
    ]);
    t.check('an XPath or a CSS selector, as written', [playwrightSelector('//div'), playwrightSelector('(//div)[2]'), playwrightSelector('button#x'), playwrightSelector('css=#y')], ['xpath=//div', 'xpath=(//div)[2]', 'css=button#x', 'css=#y']);

    const row = (name: string, desc = ''): string => `<div role="menuitemradio" data-name="${name}" aria-checked="false"><span class="c"><span class="n"><div>${name}</div></span>${desc ? `<div>${desc}</div>` : ''}</span></div>`;
    const work = String.raw`<!doctype html><html><body>
<button id="gptModeSwitcher" aria-label="Model Selector" aria-expanded="false"><span id="shown">Auto</span></button>
<div id="m365-chat-editor-target-element" contenteditable="true" style="margin-top:200px;min-height:40px">composer</div>
<div id="menu" role="menu" aria-labelledby="gptModeSwitcher" style="display:none">
  ${row('Auto', 'Decides how long to think')}${row('Quick response', 'Answers right away')}${row('Think deeper', 'Think longer')}${row('Advanced reasoning (Experimental)', 'Slow')}
  <div role="menuitem" id="claude" aria-haspopup="menu"><span class="c"><span class="n"><div>Claude</div></span><div>Anthropic</div></span></div>
  <div role="menuitem" id="gpt" aria-haspopup="menu"><span class="c"><span class="n"><div>GPT</div></span><div>OpenAI</div></span></div>
</div>
<div id="sub-claude" role="menu" aria-labelledby="claude" style="display:none">${row('Claude Sonnet 4.6')}${row('Claude Opus 4.7 Think deeper')}</div>
<div id="sub-gpt" role="menu" aria-labelledby="gpt" style="display:none">${row('GPT-5.6 Sol Quick response')}${row('GPT-5.6 Sol Think deeper')}</div>
<script>
  let current = 'Auto';
  const button = document.getElementById('gptModeSwitcher');
  const menu = document.getElementById('menu');
  const subs = { claude: document.getElementById('sub-claude'), gpt: document.getElementById('sub-gpt') };
  const rows = () => [...document.querySelectorAll('[role=menuitemradio]')];
  const close = () => { menu.style.display = 'none'; for (const s of Object.values(subs)) s.style.display = 'none'; button.setAttribute('aria-expanded', 'false'); };
  window.opens = 0;
  button.onclick = () => { window.opens += 1; menu.style.display = 'block'; button.setAttribute('aria-expanded', 'true'); };
  // These groups open on a press only.
  window.ignoreClicks = 0; window.openDelay = 0;
  for (const g of Object.keys(subs)) document.getElementById(g).onclick = () => setTimeout(() => { for (const s of Object.values(subs)) s.style.display = 'none'; subs[g].style.display = 'block'; }, window.openDelay);
  for (const el of rows()) el.onclick = () => {
    // A click the page takes and does nothing with, as a busy page does.
    if (window.ignoreClicks > 0) { window.ignoreClicks -= 1; close(); return; }
    current = el.dataset.name;
    for (const r of rows()) r.setAttribute('aria-checked', String(r.dataset.name === current));
    // As the live button: a grouped model shortened by its last word ("GPT-5.6 Sol Think").
    document.getElementById('shown').textContent = el.closest('#sub-gpt, #sub-claude') ? current.split(' ').slice(0, -1).join(' ') : current;
    close();
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  // The keyboard, as a Fluent menu has it: ArrowRight on a group opens it and focuses its first model,
  // ArrowDown moves the focus (round), Enter chooses. window.clickOpens = false leaves groups to the keyboard only.
  window.clickOpens = true;
  for (const el of rows()) el.tabIndex = -1;
  for (const g of Object.keys(subs)) {
    const trigger = document.getElementById(g);
    trigger.tabIndex = 0;
    const onClick = trigger.onclick;
    trigger.onclick = (ev) => { if (window.clickOpens) onClick.call(trigger, ev); };
  }
  document.addEventListener('keydown', (e) => {
    const el = document.activeElement;
    if (!el) return;
    if (e.key === 'ArrowRight' && el.id in subs && window.keyboardOpens !== false) {
      for (const s of Object.values(subs)) s.style.display = 'none';
      subs[el.id].style.display = 'block';
      subs[el.id].querySelector('[role=menuitemradio]').focus();
    } else if (e.key === 'ArrowDown' && el.getAttribute('role') === 'menuitemradio') {
      const sib = [...el.parentElement.querySelectorAll('[role=menuitemradio]')];
      sib[(sib.indexOf(el) + 1) % sib.length].focus();
    } else if (e.key === 'Enter' && el.getAttribute('role') === 'menuitemradio') {
      el.click();
    }
  });
  window.current = () => current;
</script></body></html>`;
    const page = await browser.newPage();
    const transportDir = mkdtempSync(join(tmpdir(), 'cop-picker-'));
    const transport = new CopilotTransport({ profileDir: '', transportDir, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000, modelSettleMs: 50, modelBeforePressMs: 20, modelPollMs: 100, modelAppearMs: 1500, modelAttempts: 3 });
    (transport as unknown as { page: Page }).page = page;
    await page.setContent(work);
    const inForce = async (): Promise<string> => await page.evaluate(() => (window as unknown as { current: () => string }).current());
    const menuOpen = async (): Promise<boolean> => await page.evaluate(() => [...document.querySelectorAll('[role=menu]')].some((m) => (m as HTMLElement).style.display !== 'none'));
    // Where each model is, as a run has it from the list read in Settings.
    const at = await placesOf(transport);
    for (const name of ['Claude Sonnet 4.6', 'GPT-5.6 Sol Think deeper', 'Claude Opus 4.7 Think deeper', 'Advanced reasoning (Experimental)', 'GPT-5.6 Sol Quick response', 'Think deeper', 'Quick response', 'Auto']) {
      const r = await transport.selectModel(name, { locator: at(name) });
      t.check(`"${name}": chosen by the operator's locators, and in force`, [r.ok, r.by, await inForce(), await menuOpen()], [true, 'operator', name, false]);
    }
    // Back in a conversation already on its model (2026-10-06): the button is looked at first, and the menu is not opened at all.
    const opensBefore = await page.evaluate(() => (window as unknown as { opens: number }).opens);
    const again = await transport.selectModel('Auto');
    t.check('the model already in force: seen on the button, the menu never opened', [again.ok, again.by, (await page.evaluate(() => (window as unknown as { opens: number }).opens)) - opensBefore], [true, 'already', 0]);
    await transport.selectModel('GPT-5.6 Sol Think deeper', { locator: at('GPT-5.6 Sol Think deeper') });
    const opensGpt = await page.evaluate(() => (window as unknown as { opens: number }).opens);
    const stay = await transport.selectModel('GPT-5.6 Sol Think deeper', { locator: at('GPT-5.6 Sol Think deeper') });
    // Shortened on the button, which two models of a group can share (2026-10-07): looked at in the menu once, nothing pressed.
    t.check('a grouped model already in force (the button shows it shortened): checked in the menu, not chosen again', [stay.ok, stay.by, (await page.evaluate(() => (window as unknown as { opens: number }).opens)) - opensGpt, await inForce()], [true, 'operator', 1, 'GPT-5.6 Sol Think deeper']);
    const other = await transport.selectModel('Think deeper', { locator: at('Think deeper') });
    t.check('"Think deeper" is not taken for the GPT model on the button: it is chosen', [other.ok, other.by, await inForce()], [true, 'operator', 'Think deeper']);
    rmSync(transportDir, { recursive: true, force: true });
    await page.close();

    /*
     * The work machine on 2026-10-06: asked for a GPT model, the mouse opened "Claude" — the row above —
     * instead. Here a stretch of the Claude row lies over the GPT row, so anything sent by coordinates
     * lands on Claude; the group is opened on the element itself, and its model must be the one shown.
     */
    console.log('\n=== the mouse aimed at "GPT" lands on "Claude" ===');
    const covered = work.replace(
      '<div role="menuitem" id="claude" aria-haspopup="menu"><span class="c"><span class="n"><div>Claude</div></span><div>Anthropic</div></span></div>',
      '<div role="menuitem" id="claude" aria-haspopup="menu" style="position:relative"><span class="c"><span class="n"><div>Claude</div></span><div>Anthropic</div></span><div style="position:absolute;left:0;right:0;top:100%;height:200px;z-index:5"></div></div>',
    );
    const page2 = await browser.newPage();
    const dir2 = mkdtempSync(join(tmpdir(), 'cop-picker-'));
    const steps: Array<{ e: string; d?: Record<string, unknown> }> = [];
    const t2 = new CopilotTransport({ profileDir: '', transportDir: dir2, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000, modelSettleMs: 50, modelBeforePressMs: 20, modelPollMs: 100, modelAppearMs: 1500, modelAttempts: 3, onEvent: (e, d) => steps.push({ e, d }) });
    (t2 as unknown as { page: Page }).page = page2;
    await page2.setContent(covered);
    t.truthy('the copy is covered as meant', covered !== work, '');
    const at2 = await placesOf(t2);
    // Read with the mouse, GPT's models were Claude's or missing; read with a click on the element, each group's own.
    t.check('read on it, the list has each group\'s own models', (await t2.listModels()).options.filter((o) => o.group).map((o) => `${o.group} > ${o.name}`), [
      'Claude > Claude Sonnet 4.6', 'Claude > Claude Opus 4.7 Think deeper', 'GPT > GPT-5.6 Sol Quick response', 'GPT > GPT-5.6 Sol Think deeper',
    ]);
    const inForce2 = async (): Promise<string> => await page2.evaluate(() => (window as unknown as { current: () => string }).current());
    for (const name of ['GPT-5.6 Sol Think deeper', 'Claude Sonnet 4.6', 'GPT-5.6 Sol Quick response']) {
      steps.length = 0;
      const r = await t2.selectModel(name, { locator: at2(name) });
      t.check(`"${name}": chosen, though the mouse would open Claude`, [r.ok, r.by, await inForce2()], [true, 'operator', name]);
      const how = steps.find((s) => s.e === 'model-selected')?.d?.how ?? steps.find((s) => s.e === 'model-step' && s.d?.step === 'group opened')?.d?.how;
      t.truthy('  its group opened without the mouse (the keyboard, since 2026-10-06), and the record says how', how === 'keyboard' || how === 'click on the element', steps.filter((s) => s.e === 'model-step').map((s) => s.d));
    }
    rmSync(dir2, { recursive: true, force: true });
    await page2.close();
    /*
     * The operator's request (2026-10-06): wait until the element is there, pause after each press, and when
     * the model is not set, choose it again — up to six times on the real page.
     */
    console.log('\n=== a choice the page ignores at first, and a group that opens late ===');
    const page3 = await browser.newPage();
    const dir3 = mkdtempSync(join(tmpdir(), 'cop-picker-'));
    const steps3: Array<{ e: string; d?: Record<string, unknown> }> = [];
    const t3 = new CopilotTransport({ profileDir: '', transportDir: dir3, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000, modelSettleMs: 50, modelBeforePressMs: 20, modelPollMs: 100, modelAppearMs: 4000, modelAttempts: 6, onEvent: (e, d) => steps3.push({ e, d }) });
    (t3 as unknown as { page: Page }).page = page3;
    await page3.setContent(work);
    const at3 = await placesOf(t3);
    const inForce3 = async (): Promise<string> => await page3.evaluate(() => (window as unknown as { current: () => string }).current());
    await page3.evaluate(() => { (window as unknown as { ignoreClicks: number }).ignoreClicks = 2; });
    let r3 = await t3.selectModel('GPT-5.6 Sol Think deeper', { locator: at3('GPT-5.6 Sol Think deeper') });
    const tries = steps3.filter((x) => x.e === 'model-step' && x.d?.step === 'attempt').length;
    // The clicks first: each attempt spends one ignored press, so the third gets through.
    t.check('two presses ignored: chosen on a later attempt, each attempt on record', [r3.ok, r3.by, await inForce3(), tries], [true, 'operator', 'GPT-5.6 Sol Think deeper', 3]);
    steps3.length = 0;
    await page3.evaluate(() => { (window as unknown as { openDelay: number; keyboardOpens: boolean }).openDelay = 2_000; (window as unknown as { keyboardOpens: boolean }).keyboardOpens = false; });
    r3 = await t3.selectModel('Claude Opus 4.7 Think deeper', { locator: at3('Claude Opus 4.7 Think deeper') });
    // The operator's rhythm (2026-10-06): not there → wait and look again; there → pause; then the press.
    const rhythm = steps3.filter((x) => x.e === 'model-step').map((x) => String(x.d?.step));
    const waited = rhythm.indexOf('not there yet, waiting');
    const paused = rhythm.indexOf('there, pausing before the press', waited);
    const pressed = rhythm.indexOf('model pressed', paused);
    t.truthy('the late model: looked for, waited for, paused before, then pressed — in that order', waited >= 0 && paused > waited && pressed > paused, rhythm);
    t.check('a group whose models come two seconds late: waited for, chosen at once',[r3.ok, await inForce3(), steps3.filter((x) => x.e === 'model-step' && x.d?.step === 'attempt').length], [true, 'Claude Opus 4.7 Think deeper', 1]);
    steps3.length = 0;
    await page3.evaluate(() => { (window as unknown as { openDelay: number; ignoreClicks: number }).openDelay = 0; (window as unknown as { ignoreClicks: number }).ignoreClicks = 99; });
    const fullFrom = Date.now();
    r3 = await t3.selectModel('Quick response', { locator: at3('Quick response') });
    const fullMs = Date.now() - fullFrom;
    t.check('never set: refused after six attempts, saying so', [r3.ok, /not chosen after 6 attempts/.test(r3.reason ?? ''), steps3.filter((x) => x.e === 'model-step' && x.d?.step === 'attempt').length], [false, true, 6]);
    /*
     * The run's Stop, pressed while those attempts go on (2026-10-17, "the Stop button seems not to work"): their waits
     * end at once, nothing more is pressed, and the menu is closed, instead of all six attempts being waited out.
     */
    steps3.length = 0;
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 600);
    const stopFrom = Date.now();
    r3 = await t3.selectModel('Quick response', { locator: at3('Quick response'), signal: stop.signal });
    const stopMs = Date.now() - stopFrom;
    const stepsAfterStop = steps3.filter((x) => x.e === 'model-step').map((x) => String(x.d?.step));
    t.check('stopped while choosing: ends with "stopped by the operator"', [r3.ok, r3.reason, stepsAfterStop.at(-1)], [false, 'stopped by the operator', 'stopped by the operator']);
    t.truthy('at once, not after the six attempts', stopMs < 2_000 && stopMs < fullMs / 3, { stopMs, fullMs });
    t.check('and leaves the menu closed', await page3.locator('[role="menu"]:visible').count(), 0);
    t.check('a Stop already pressed opens nothing', [(await t3.selectModel('Quick response', { signal: stop.signal })).reason, steps3.filter((x) => x.e === 'model-step').length], ['stopped by the operator', stepsAfterStop.length]);
    rmSync(dir3, { recursive: true, force: true });
    await page3.close();

    /*
     * At work (2026-10-06) the right model was chosen and the check of it failed: it opened the menu again,
     * and that second walk did not get through. The button shows the model; it is read first.
     */
    console.log('\n=== chosen, and the menu will not open the group a second time: the button shows it ===');
    const page4 = await browser.newPage();
    const dir4 = mkdtempSync(join(tmpdir(), 'cop-picker-'));
    const steps4: Array<{ e: string; d?: Record<string, unknown> }> = [];
    const t4 = new CopilotTransport({ profileDir: '', transportDir: dir4, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000, modelSettleMs: 50, modelBeforePressMs: 300, modelPollMs: 100, modelAppearMs: 1500, modelAttempts: 6, onEvent: (e, d) => steps4.push({ e, d }) });
    (t4 as unknown as { page: Page }).page = page4;
    await page4.setContent(work);
    const at4 = await placesOf(t4);
    // After the first choice in a group, its submenu no longer opens.
    await page4.evaluate(() => {
      const w = window as unknown as { openDelay: number };
      for (const g of ['claude', 'gpt']) {
        const el = document.getElementById(g)!;
        const open = el.onclick!;
        let used = false;
        el.onclick = (ev) => { if (used) return; used = true; return (open as (e: MouseEvent) => unknown).call(el, ev as MouseEvent); };
      }
      w.openDelay = 0;
    });
    const started4 = Date.now();
    const r4 = await t4.selectModel('GPT-5.6 Sol Quick response', { locator: at4('GPT-5.6 Sol Quick response') });
    const took4 = Date.now() - started4;
    const sel = steps4.find((x) => x.e === 'model-selected');
    t.check('chosen at the first attempt, seen on the button, the menu not walked again', [r4.ok, r4.by, sel?.d?.seenOn, steps4.filter((x) => x.e === 'model-step' && x.d?.step === 'attempt').length], [true, 'operator', 'button', 1]);
    t.truthy('a pause before each of the three presses (button, group, model)', took4 >= 900, `${took4} ms`);
    rmSync(dir4, { recursive: true, force: true });
    await page4.close();
    // The operator's choice (2026-10-06): the submenu by the keyboard. Here a group opens by nothing else.
    console.log('\n=== a group that opens only by the keyboard ===');
    const page5 = await browser.newPage();
    const dir5 = mkdtempSync(join(tmpdir(), 'cop-picker-'));
    const steps5: Array<{ e: string; d?: Record<string, unknown> }> = [];
    const t5 = new CopilotTransport({ profileDir: '', transportDir: dir5, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000, modelSettleMs: 50, modelBeforePressMs: 20, modelPollMs: 100, modelAppearMs: 1500, modelAttempts: 3, onEvent: (e, d) => steps5.push({ e, d }) });
    (t5 as unknown as { page: Page }).page = page5;
    await page5.setContent(work);
    const at5 = await placesOf(t5);
    await page5.evaluate(() => { (window as unknown as { clickOpens: boolean }).clickOpens = false; });
    const inForce5 = async (): Promise<string> => await page5.evaluate(() => (window as unknown as { current: () => string }).current());
    for (const name of ['GPT-5.6 Sol Think deeper', 'Claude Opus 4.7 Think deeper', 'GPT-5.6 Sol Quick response']) {
      steps5.length = 0;
      const r5 = await t5.selectModel(name, { locator: at5(name) });
      // The clicks first (2026-10-07); where only the keyboard opens the group, it is what gets there.
      const opened5 = steps5.find((x) => x.e === 'model-step' && x.d?.step === 'group opened')?.d?.how ?? steps5.find((x) => x.e === 'model-selected')?.d?.how;
      t.check(`"${name}": the group opened by the keyboard, the model chosen`, [r5.ok, await inForce5(), opened5], [true, name, 'keyboard']);
    }
    rmSync(dir5, { recursive: true, force: true });
    await page5.close();

    /*
     * The work machine's Claude group as read live on 2026-10-07: "Sonnet 5.5", "Opus 5.5", "Sonnet 5". The
     * operator's locator for Sonnet finds both Sonnets; the one whose name is the chosen one must be pressed.
     */
    console.log('\n=== the live Claude group: "Sonnet 5" beside "Sonnet 5.5" ===');
    const claude = work.replace(row('Claude Sonnet 4.6') + row('Claude Opus 4.7 Think deeper'), row('Sonnet 5.5') + row('Opus 5.5') + row('Sonnet 5'));
    const page6 = await browser.newPage();
    const dir6 = mkdtempSync(join(tmpdir(), 'cop-picker-'));
    const t6 = new CopilotTransport({ profileDir: '', transportDir: dir6, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000, modelSettleMs: 50, modelBeforePressMs: 20, modelPollMs: 100, modelAppearMs: 1500, modelAttempts: 3 });
    (t6 as unknown as { page: Page }).page = page6;
    await page6.setContent(claude);
    const at6 = await placesOf(t6);
    const inForce6 = async (): Promise<string> => await page6.evaluate(() => (window as unknown as { current: () => string }).current());
    for (const name of ['Sonnet 5', 'Sonnet 5.5', 'Opus 5.5', 'Sonnet 5']) {
      const r6 = await t6.selectModel(name, { locator: at6(name) });
      t.check(`"${name}": that one, not the other Sonnet`, [r6.ok, await inForce6()], [true, name]);
    }
    rmSync(dir6, { recursive: true, force: true });
    await page6.close();

    /*
     * The work page of 2026-10-23 (the operator's models-select-failed.json/.html): every row is a `menuitem` —
     * the models too, which were `menuitemradio` — marked by `aria-checked`, the top ones with test ids of their
     * own ("gptSubMenuModelTrigger-Magic" is Auto), the groups told apart only by `aria-haspopup`/`aria-expanded`.
     * Every locator written for `menuitemradio` found nothing, and each run asked the operator to choose by hand.
     */
    console.log('\n=== the work menu of 2026-10-23: every row a menuitem ===');
    const ids: Record<string, string> = { Auto: 'Magic', 'Quick response': 'Chat', 'Think deeper': 'Reasoning', 'Advanced reasoning (Experimental)': 'DeepWork' };
    let menuitems = claude
      .replace(row('GPT-5.6 Sol Quick response') + row('GPT-5.6 Sol Think deeper'), row('GPT-5.6 Sol Quick response') + row('GPT-5.6 Sol Think deeper') + row('GPT-6.1 Sol'))
      .replaceAll('<div role="menuitemradio" data-name=', '<div role="menuitem" tabindex="0" data-name=')
      .replaceAll('[role=menuitemradio]', '[data-name]')
      .replaceAll("el.getAttribute('role') === 'menuitemradio'", "el.hasAttribute('data-name')")
      .replace('<div role="menuitem" id="claude" aria-haspopup="menu">', '<div role="menuitem" id="claude" data-testid="gptSubMenuModelTrigger-Claude" aria-haspopup="menu" aria-expanded="false">')
      .replace('<div role="menuitem" id="gpt" aria-haspopup="menu">', '<div role="menuitem" id="gpt" data-testid="gptSubMenuModelTrigger-OpenAI" aria-haspopup="menu" aria-expanded="false">');
    for (const [name, id] of Object.entries(ids)) menuitems = menuitems.replace(`data-name="${name}"`, `data-name="${name}" data-testid="gptSubMenuModelTrigger-${id}"`);
    t.check('the copy has no menuitemradio left, and every model a test id where the page has one', [menuitems.includes('menuitemradio'), (menuitems.match(/data-testid="gptSubMenuModelTrigger-/g) ?? []).length], [false, 6]);
    const page7 = await browser.newPage();
    const dir7 = mkdtempSync(join(tmpdir(), 'cop-picker-'));
    const t7 = new CopilotTransport({ profileDir: '', transportDir: dir7, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000, modelSettleMs: 50, modelBeforePressMs: 20, modelPollMs: 100, modelAppearMs: 1500, modelAttempts: 2 });
    (t7 as unknown as { page: Page }).page = page7;
    await page7.setContent(menuitems);
    const inForce7 = async (): Promise<string> => await page7.evaluate(() => (window as unknown as { current: () => string }).current());
    const menuOpen7 = async (): Promise<boolean> => await page7.evaluate(() => [...document.querySelectorAll('[role=menu]')].some((m) => (m as HTMLElement).style.display !== 'none'));
    const list7 = await t7.listModels();
    t.check('the list read from it: four at the top, each group its own', list7.options.map((o) => `${o.group ? `${o.group} > ` : ''}${o.name}`), [
      'Auto', 'Quick response', 'Think deeper', 'Advanced reasoning (Experimental)',
      'Claude > Sonnet 5.5', 'Claude > Opus 5.5', 'Claude > Sonnet 5',
      'GPT > GPT-5.6 Sol Quick response', 'GPT > GPT-5.6 Sol Think deeper', 'GPT > GPT-6.1 Sol',
    ]);
    for (const name of ['Think deeper', 'Sonnet 5.5', 'GPT-5.6 Sol Think deeper', 'Opus 5.5', 'Advanced reasoning (Experimental)', 'Quick response', 'Sonnet 5', 'Auto']) {
      const r7 = await t7.selectModel(name, { locator: list7.options.find((o) => o.name === name)?.locator });
      t.check(`"${name}": chosen by the operator's locators, and in force`, [r7.ok, r7.by, await inForce7(), await menuOpen7()], [true, 'operator', name, false]);
    }
    // Named nowhere in the code (the fixed list of 2026-10-05 had only two GPT-5.6): the same templates, its own name.
    const r7 = await t7.selectModel('GPT-6.1 Sol', { locator: list7.options.find((o) => o.name === 'GPT-6.1 Sol')?.locator });
    t.check('"GPT-6.1 Sol", in no list of the code: chosen by the templates all the same', [r7.ok, r7.by, await inForce7(), await menuOpen7()], [true, 'operator', 'GPT-6.1 Sol', false]);
    // The groups by the keyboard alone: a model is a menuitem that opens nothing, not only a menuitemradio.
    await page7.evaluate(() => { (window as unknown as { clickOpens: boolean }).clickOpens = false; });
    for (const name of ['GPT-5.6 Sol Quick response', 'Opus 5.5']) {
      const r = await t7.selectModel(name, { locator: list7.options.find((o) => o.name === name)?.locator });
      t.check(`"${name}": its group opened by the keyboard alone, the model chosen`, [r.ok, await inForce7()], [true, name]);
    }
    rmSync(dir7, { recursive: true, force: true });
    await page7.close();

    /*
     * The operator's own locators, as Settings would have them after the page changed (2026-10-24): another button,
     * rows with no role at all, names in <b>, and providers the code has never heard of. The defaults find nothing
     * here; the operator's five find everything, a provider and its models included.
     */
    console.log('\n=== another page, read and chosen only by the operator\'s locators from Settings ===');
    const otherPage = String.raw`<!doctype html><html><body>
<button id="modelSwitch" aria-label="Choose a model" aria-expanded="false"><span id="shown">Auto</span></button>
<div id="m365-chat-editor-target-element" contenteditable="true" style="margin-top:200px;min-height:40px">composer</div>
<ul id="menu" role="menu" style="display:none">
  <li class="pick" data-name="Auto" aria-checked="true"><b>Auto</b><br><i>Decides</i></li>
  <li class="pick" data-name="Think deeper" aria-checked="false"><b>Think deeper</b></li>
  <li class="prov" id="p-gemini" aria-haspopup="menu"><b>Gemini</b><br><i>Google</i></li>
  <li class="prov" id="p-mistral" aria-haspopup="menu"><b>Mistral</b><br><i>Mistral AI</i></li>
</ul>
<ul id="sub-p-gemini" role="menu" aria-labelledby="p-gemini" style="display:none">
  <li class="pick" data-name="Gemini 3 Pro" aria-checked="false"><b>Gemini 3 Pro</b></li>
  <li class="pick" data-name="Gemini 3 Flash" aria-checked="false"><b>Gemini 3 Flash</b></li>
</ul>
<ul id="sub-p-mistral" role="menu" aria-labelledby="p-mistral" style="display:none">
  <li class="pick" data-name="Large 3" aria-checked="false"><b>Large 3</b></li>
  <li class="pick" data-name="Small 3" aria-checked="false"><b>Small 3</b></li>
</ul>
<script>
  let current = 'Auto';
  const button = document.getElementById('modelSwitch');
  const menus = [...document.querySelectorAll('ul')];
  const close = () => { for (const m of menus) m.style.display = 'none'; button.setAttribute('aria-expanded', 'false'); };
  button.onclick = () => { document.getElementById('menu').style.display = 'block'; button.setAttribute('aria-expanded', 'true'); };
  for (const p of document.querySelectorAll('.prov')) {
    const open = () => { for (const m of menus.slice(1)) m.style.display = 'none'; document.getElementById('sub-' + p.id).style.display = 'block'; };
    p.onclick = open; p.onmouseenter = open;
  }
  for (const el of document.querySelectorAll('.pick')) el.onclick = () => {
    current = el.dataset.name;
    for (const r of document.querySelectorAll('.pick')) r.setAttribute('aria-checked', String(r.dataset.name === current));
    document.getElementById('shown').textContent = current;
    close();
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.current = () => current;
</script></body></html>`;
    const theirs = {
      button: '#modelSwitch',
      rows: "//li[contains(@class, 'pick') or contains(@class, 'prov')]",
      model: "//b[text()='{$model_name}']/parent::li[contains(@class, 'pick')]",
      provider: "//b[text()='{$provider_name}']/parent::li[contains(@class, 'prov')]",
      providerModel: "//b[text()='{$model_name}']/parent::li[contains(@class, 'pick')]",
    };
    const make = (pickerLocators?: Record<string, string>, onEvent?: (e: string, d?: Record<string, unknown>) => void) => {
      const dir = mkdtempSync(join(tmpdir(), 'cop-picker-'));
      return { dir, tr: new CopilotTransport({ profileDir: '', transportDir: dir, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000, modelSettleMs: 50, modelBeforePressMs: 20, modelPollMs: 100, modelAppearMs: 1000, modelAttempts: 2, ...(pickerLocators ? { pickerLocators } : {}), ...(onEvent ? { onEvent } : {}) }) };
    };
    const page8 = await browser.newPage();
    await page8.setContent(otherPage);
    const inForce8 = async (): Promise<string> => await page8.evaluate(() => (window as unknown as { current: () => string }).current());
    const stock = make();
    (stock.tr as unknown as { page: Page }).page = page8;
    const none = await stock.tr.listModels();
    t.check('with the defaults: no picker found, and the note names the button\'s locator', [none.options.length, /button#gptModeSwitcher/.test(none.note ?? '')], [0, true]);
    const own = make(theirs);
    (own.tr as unknown as { page: Page }).page = page8;
    const list8 = await own.tr.listModels();
    t.check('with the operator\'s: the list read, each provider its own', list8.options.map((o) => `${o.group ? `${o.group} > ` : ''}${o.name}`), [
      'Auto', 'Think deeper', 'Gemini > Gemini 3 Pro', 'Gemini > Gemini 3 Flash', 'Mistral > Large 3', 'Mistral > Small 3',
    ]);
    for (const name of ['Gemini 3 Flash', 'Think deeper', 'Small 3', 'Gemini 3 Pro', 'Auto']) {
      const r = await own.tr.selectModel(name, { locator: list8.options.find((o) => o.name === name)?.locator });
      t.check(`"${name}": chosen by the operator's locators`, [r.ok, r.by, await inForce8()], [true, 'operator', name]);
    }
    // A template that finds nothing: given up on at once, the menu kept, with what each locator found.
    const saidWrong: Array<{ e: string; d?: Record<string, unknown> }> = [];
    const wrong = make({ ...theirs, model: "//b[text()='{$model_name}']/parent::li[contains(@class, 'nothing')]" }, (e, d) => saidWrong.push({ e, d }));
    (wrong.tr as unknown as { page: Page }).page = page8;
    const startedWrong = Date.now();
    const rw = await wrong.tr.selectModel('Think deeper', { locator: list8.options.find((o) => o.name === 'Think deeper')?.locator });
    const kept = JSON.parse(readFileSync(join(wrong.dir, 'models-select-failed.json'), 'utf8')) as { asked: string; locators: Array<{ what: string; locator: string; found: number }> };
    t.check('a template that finds nothing: not chosen, and it is the locator the reason names', [rw.ok, (rw.reason ?? '').includes("parent::li[contains(@class, 'nothing')]")], [false, true]);
    t.check('  one attempt, not two, and the menu kept with what each locator found', [saidWrong.filter((x) => x.e === 'model-step' && x.d?.step === 'attempt').length, kept.asked, kept.locators.map((l) => [l.what, l.found])], [1, 'Think deeper', [['model', 0]]]);
    t.truthy('  quickly', Date.now() - startedWrong < 15_000, `${Date.now() - startedWrong} ms`);
    // One saved without its placeholder is not used: the default is, and the record says why.
    const saidBroken: Array<{ e: string; d?: Record<string, unknown> }> = [];
    const broken = make({ ...theirs, provider: "//b[text()='Gemini']" }, (e, d) => saidBroken.push({ e, d }));
    (broken.tr as unknown as { page: Page }).page = page8;
    await broken.tr.listModels();
    t.check('a provider locator without {$provider_name}: not used, and said', saidBroken.filter((x) => x.e === 'model-locator-not-used').map((x) => x.d?.problem), ['the provider locator in Settings is not used, it has no {$provider_name}: put it where the name goes']);
    // The step pictures Settings can ask for (copilot.pickerSteps → modelStepShots).
    const shotsDir = mkdtempSync(join(tmpdir(), 'cop-picker-'));
    const shots = new CopilotTransport({ profileDir: '', transportDir: shotsDir, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000, modelSettleMs: 50, modelBeforePressMs: 20, modelPollMs: 100, modelAppearMs: 1000, modelAttempts: 2, pickerLocators: theirs, modelStepShots: true });
    (shots as unknown as { page: Page }).page = page8;
    await shots.selectModel('Large 3', { locator: list8.options.find((o) => o.name === 'Large 3')?.locator });
    const pictures = readdirSync(shotsDir).filter((f) => /^models-step-\d\d-/.test(f));
    t.truthy('with the step pictures on: a picture and the menu\'s HTML at the steps', pictures.some((f) => f.endsWith('.png')) && pictures.some((f) => f.endsWith('.html')), pictures);
    for (const d of [stock.dir, own.dir, wrong.dir, broken.dir, shotsDir]) rmSync(d, { recursive: true, force: true });
    await page8.close();
  }
} finally {
  await browser.close();
}

t.finish();
