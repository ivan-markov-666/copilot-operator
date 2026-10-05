/**
 * The model picker on the real Copilot page: the list read with each model's place in it, and a later
 * browser choosing every model at that place. Not part of `npm run check`: it needs the bot's Edge
 * profile signed in to Copilot, and the bot itself stopped (the profile is used by one browser at a time).
 *
 *   npm run check:live-models
 *
 * It follows the operator's way: "Read the list" in Settings is one browser, the run is another, later.
 * Every choice is checked on its own, from a fresh menu, by which row the picker marks as chosen — the
 * button's text is shortened and was what let a wrong model pass. Then a message goes out on the model
 * and the mark is read again after the reply. Seen on 2026-10-05: once a model of the GPT group was
 * chosen, the group's row carried that model's name, and a reader going by text lost the model, so the
 * run went on Auto.
 */
import { join } from 'node:path';
import { CopilotTransport, type ModelOption } from '../src/transport/copilotTransport.js';
import { installLayout } from '../src/config/layout.js';
import { Url } from '../src/transport/locators.js';
import { sameModel } from '../src/transport/modelMatch.js';
import { Tally } from './support/harness.js';

const t = new Tally();
const transport = (): CopilotTransport =>
  new CopilotTransport({
    profileDir: process.env.COP_PROFILE ?? join(process.env.LOCALAPPDATA ?? '', 'copilot-operator', 'edge-profile'),
    transportDir: join(installLayout().runsDir, '_models'),
    chatUrl: Url.chat,
    channel: 'msedge',
    headless: false,
    replyTimeoutMs: 180_000,
    signInTimeoutMs: 900_000,
  });

/** The model the picker marks as chosen, read from a fresh menu, groups included. */
async function ticked(c: CopilotTransport): Promise<string[]> {
  return (await c.listModels()).options.filter((o) => o.selected).map((o) => o.name);
}

console.log('--- 1. "Read the list", as Settings does: every model with its place ---');
let list: ModelOption[] = [];
{
  const a = transport();
  try {
    await a.open();
    await a.ensureSignedIn();
    list = (await a.listModels()).options;
  } finally {
    await a.close();
  }
  for (const o of list) console.log(`    ${o.group ? `${o.group} > ` : ''}${o.name}  ${JSON.stringify(o.locator)}`);
  t.truthy('the picker was read', list.length >= 2, list);
  t.truthy('every model has its place', list.every((o) => !!o.locator), list);
  t.truthy('a grouped model knows its group by its test id', list.filter((o) => o.group).every((o) => !!o.locator?.group?.testId), list.filter((o) => o.group));
  t.check('no model listed twice', new Set(list.map((o) => o.name.toLowerCase())).size, list.length);
}

console.log('\n--- 2. a later browser, as a run: each model chosen at its place, and checked ---');
{
  const grouped = list.filter((o) => o.group && !o.disabled);
  const plain = list.filter((o) => !o.group && !o.disabled);
  // A grouped model first, then another of the same group while the group's row carries the first one's
  // name, the first again, then the plain ones: the order that lost the model on 2026-10-05.
  const order = [...grouped, ...grouped.slice(0, 1), ...plain.filter((o) => !/^auto$/i.test(o.name)), ...plain.filter((o) => /^auto$/i.test(o.name))];
  const b = transport();
  try {
    await b.open();
    await b.ensureSignedIn();
    await b.newChat();
    for (const o of order) {
      const r = await b.selectModel(o.name, { locator: o.locator });
      const marked = await ticked(b);
      t.check(`"${o.name}": chosen at its saved place, and the picker marks it alone`, [r.ok, r.by, marked.length === 1 && sameModel(marked[0], o.name)], [true, 'locator', true]);
      if (!r.ok || !(marked.length === 1 && sameModel(marked[0], o.name))) console.log('      ', JSON.stringify({ reason: r.reason, current: r.current, marked }));
    }

    console.log('\n--- 3. the model holds through a message and its reply ---');
    const target = grouped[0] ?? plain[0];
    if (target) {
      const r = await b.selectModel(target.name, { locator: target.locator });
      const before = await b.sendAndConfirm('Reply with exactly the word: ok');
      await b.waitForReply(before);
      const marked = await ticked(b);
      t.check(`"${target.name}" is still the one marked after the reply`, [r.ok, marked.length === 1 && sameModel(marked[0], target.name)], [true, true]);
    }
  } finally {
    await b.close();
  }
}

t.finish();
