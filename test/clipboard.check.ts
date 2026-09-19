/**
 * The guard that keeps the runner off the operator's clipboard.
 *
 * This is checked against a real browser rather than reasoned about, because the whole claim is
 * about what a page can and cannot reach — and a page can reach a lot. The fixture is a button
 * that copies the way a web app copies: `navigator.clipboard.writeText`, the `ClipboardItem`
 * form, and the old hidden-textarea-with-`execCommand` trick. All three have to end up in the
 * variable and none of them anywhere else.
 *
 * It is served over http on 127.0.0.1 rather than from a `data:` URL, because the clipboard API
 * only exists in a secure context and an opaque origin is not one. Loopback is, which is the
 * one bit of ceremony this fixture needs.
 *
 * Nothing here reads or writes the machine's clipboard, on purpose: a test for "we do not touch
 * your clipboard" that touches it to prove the point would be a poor joke. What is checked
 * instead is that the page's own ways of reaching it have been replaced, which is upstream of
 * the clipboard and settles the question before it is asked.
 *
 *   npm run check:clipboard
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { CLIPBOARD_GUARD } from '../src/transport/copilotTransport.js';

const FIXTURE = `<!doctype html><meta charset="utf-8"><title>copy fixture</title>
<button id="modern">modern</button>
<button id="rich">rich</button>
<button id="old">old</button>
<textarea id="hidden" style="position:fixed;left:-9999px"></textarea>
<script>
  document.getElementById('modern').onclick = () =>
    navigator.clipboard.writeText('## the answer\\n\\n\`\`\`ps1\\nGet-Date\\n\`\`\`');
  document.getElementById('rich').onclick = () =>
    navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['rich markdown'], { type: 'text/plain' }) })]);
  document.getElementById('old').onclick = () => {
    const box = document.getElementById('hidden');
    box.value = 'copied the old way';
    box.select();
    document.execCommand('copy');
  };
</script>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(FIXTURE);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext();
await context.addInitScript(CLIPBOARD_GUARD);
const page = await context.newPage();
await page.goto(url);

const read = async (): Promise<{ text: string; seq: number }> =>
  await page.evaluate(() => ({ text: window.__copClipboard?.text ?? '', seq: window.__copClipboard?.seq ?? -1 }));

console.log('--- the guard is installed ---');
console.log('present           :', (await read()).seq === 0, '(expect true)');
console.log(
  'writeText replaced:',
  await page.evaluate(() => !String(navigator.clipboard.writeText).includes('[native code]')),
  '(expect true — the real one can no longer be reached)',
);
console.log(
  'write replaced    :',
  await page.evaluate(() => !String(navigator.clipboard.write).includes('[native code]')),
  '(expect true)',
);
console.log(
  'execCommand hooked:',
  await page.evaluate(() => !String(document.execCommand).includes('[native code]')),
  '(expect true)',
);

console.log('\n--- each of the three ways a page copies ---');
for (const [label, id, expected] of [
  ['navigator.clipboard.writeText', 'modern', '## the answer'],
  ['navigator.clipboard.write', 'rich', 'rich markdown'],
  ["execCommand('copy')", 'old', 'copied the old way'],
] as const) {
  const before = (await read()).seq;
  await page.click(`#${id}`);
  await page.waitForFunction((seq: number) => (window.__copClipboard?.seq ?? -1) > seq, before, { timeout: 5_000 });
  const after = await read();
  console.log(
    `${label.padEnd(30)}:`,
    after.text.startsWith(expected) ? 'captured' : `WRONG (${JSON.stringify(after.text.slice(0, 40))})`,
    `| counter ${before} -> ${after.seq}`,
  );
}

console.log('\n--- fences survive, which is the reason for copying at all ---');
await page.click('#modern');
const markdown = (await read()).text;
console.log('code fence kept    :', markdown.includes('```ps1'), '(expect true)');
console.log('newlines kept      :', markdown.split('\n').length > 1, '(expect true)');

console.log('\n--- a click that copies nothing cannot serve the last answer ---');
const stale = (await read()).seq;
const timedOut = await page
  .waitForFunction((seq: number) => (window.__copClipboard?.seq ?? -1) > seq, stale, { timeout: 1_000 })
  .then(() => false)
  .catch(() => true);
console.log('waits, not reuses  :', timedOut, '(expect true — the runner degrades instead)');

await browser.close();
await new Promise<void>((resolve) => server.close(() => resolve()));
