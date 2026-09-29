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
<button id="gptModeSwitcher" aria-label="Model Selector"><span id="shown"></span></button>
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
  let current = 'Auto';
  window.clicksOnChosen = 0;
  const shortOf = (el) => el.dataset.short || el.dataset.name;
  function render() {
    for (const el of document.querySelectorAll('[role=menuitemradio]')) el.setAttribute('aria-checked', String(el.dataset.name === current));
    const row = [...document.querySelectorAll('[role=menuitemradio]')].find((el) => el.dataset.name === current);
    document.getElementById('shown').textContent = row ? shortOf(row) : current;
  }
  const menu = document.getElementById('menu'), sub = document.getElementById('sub');
  const close = () => { menu.style.display = 'none'; sub.style.display = 'none'; };
  document.getElementById('gptModeSwitcher').onclick = () => { menu.style.display = 'block'; };
  document.getElementById('gpt').onmouseenter = () => { sub.style.display = 'block'; };
  document.getElementById('gpt').onclick = () => { sub.style.display = 'block'; };
  for (const el of document.querySelectorAll('[role=menuitemradio]')) {
    el.onclick = () => {
      // Copilot's behaviour: the row already in force ignores the click and the menu stays open.
      if (el.dataset.name === current) { window.clicksOnChosen += 1; return; }
      current = el.dataset.name; render(); close();
    };
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.setModel = (name) => { current = name; render(); };
  render();
</script></body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const transport = new CopilotTransport({ profileDir: '', transportDir: '', chatUrl: 'about:blank', channel: 'chromium', headless: true, replyTimeoutMs: 1000, signInTimeoutMs: 1000 });
  // The transport is given this page instead of opening Edge; `open()` is never called.
  (transport as unknown as { page: Page }).page = page;
  await page.setContent(PAGE);

  const menuOpen = async (): Promise<boolean> => await page.evaluate(() => [...document.querySelectorAll('[role=menu]')].some((m) => (m as HTMLElement).style.display !== 'none'));
  const clicksOnChosen = async (): Promise<number> => await page.evaluate(() => (window as unknown as { clicksOnChosen: number }).clicksOnChosen);
  const setModel = async (name: string): Promise<void> => await page.evaluate((n) => (window as unknown as { setModel: (x: string) => void }).setModel(n), name);

  console.log('--- a model that is not chosen yet ---');
  let r = await transport.selectModel('Think deeper');
  t.check('chosen', [r.ok, r.current], [true, 'Think deeper']);
  t.check('and the menu is closed', await menuOpen(), false);

  r = await transport.selectModel('GPT 5.6 Quick response');
  t.check('one inside the GPT group is chosen too, by its full name', [r.ok, r.current], [true, 'GPT 5.6 Quick response']);
  t.check('and the menu is closed', await menuOpen(), false);

  console.log('\n--- a model that is already chosen ---');
  await setModel('GPT 5.6 Think deeper');
  const before = await clicksOnChosen();
  r = await transport.selectModel('GPT 5.6 Think deeper');
  t.check('reported as in force (the button says only "GPT 5.6 Think")', [r.ok, r.current], [true, 'GPT 5.6 Think deeper']);
  t.check('the row already chosen is not clicked', (await clicksOnChosen()) - before, 0);
  t.check('and the menu is not left open over the chat', await menuOpen(), false);

  await setModel('Think deeper');
  r = await transport.selectModel('Think deeper');
  t.check('a top-level one already chosen: in force, menu closed', [r.ok, r.current, await menuOpen()], [true, 'Think deeper', false]);

  console.log('\n--- a model the picker does not offer ---');
  r = await transport.selectModel('Claude Opus');
  t.check('refused, with the menu closed', [r.ok, await menuOpen()], [false, false]);
  t.check('and the chat stays on what it was', r.current, 'Think deeper');
} finally {
  await browser.close();
}

t.finish();
