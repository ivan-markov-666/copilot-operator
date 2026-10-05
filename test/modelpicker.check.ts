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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    const transport = new CopilotTransport({ profileDir: '', transportDir, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000 });
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
    const transport = new CopilotTransport({ profileDir: '', transportDir, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000 });
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
    t.check('and a model of the top menu', [r.ok, r.by, r.current, await menuOpen()], [true, 'locator', 'Auto', false]);

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
  <div role="menuitem" id="claude" data-test-id="claudeSubMenuModelTrigger-Anthropic" aria-haspopup="menu">Claude<br>Anthropic</div>
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
    const transport = new CopilotTransport({ profileDir: '', transportDir, chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000 });
    (transport as unknown as { page: Page }).page = page;
    await page.setContent(two);
    const menuOpen = async (): Promise<boolean> => await page.evaluate(() => [...document.querySelectorAll('[role=menu]')].some((m) => (m as HTMLElement).style.display !== 'none'));

    const list = await transport.listModels();
    t.check('each group lists its own models', list.options.map((o) => `${o.group ? `${o.group} > ` : ''}${o.name}`), [
      'Auto', 'Think deeper',
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
} finally {
  await browser.close();
}

t.finish();
