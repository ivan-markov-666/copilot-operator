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
    const transport = new CopilotTransport({ profileDir: '', transportDir: '', chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000 });
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
    await page.close();
  }
} finally {
  await browser.close();
}

t.finish();
