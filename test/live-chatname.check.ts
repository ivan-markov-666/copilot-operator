/**
 * Naming a conversation on the real Copilot page, as a run does after the first reply. Not part of
 * `npm run check`: it needs the bot's Edge profile signed in to Copilot and the bot stopped (one browser
 * per profile). It sends one short message, so it leaves one chat, named "op/live-check …", in the history.
 *
 *   npm run check:live-chat
 *
 * Seen on 2026-10-05: the chat's "More" button was under another part of the sidebar, every mouse click
 * went there, and after a minute of retries the chat kept Copilot's own title — so a run could not find
 * its conversation again by name.
 */
import { join } from 'node:path';
import { CopilotTransport } from '../src/transport/copilotTransport.js';
import { installLayout } from '../src/config/layout.js';
import { Url } from '../src/transport/locators.js';
import { Tally } from './support/harness.js';

const t = new Tally();
const events: Array<{ e: string; d?: Record<string, unknown> }> = [];
const c = new CopilotTransport({
  profileDir: process.env.COP_PROFILE ?? join(process.env.LOCALAPPDATA ?? '', 'copilot-operator', 'edge-profile'),
  transportDir: join(installLayout().runsDir, '_models'),
  chatUrl: Url.chat,
  channel: 'msedge',
  headless: false,
  replyTimeoutMs: 180_000,
  signInTimeoutMs: 900_000,
  onEvent: (e, d) => events.push({ e, d }),
});

try {
  await c.open();
  await c.ensureSignedIn();
  await c.newChat();
  const before = await c.sendAndConfirm('Reply with exactly the word: ok');
  await c.waitForReply(before);
  const chatId = await c.currentChatId();
  t.truthy('the conversation has an id', !!chatId, chatId);
  if (chatId) {
    const name = `op/live-check ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const started = Date.now();
    const named = await c.nameChat(chatId, name);
    const took = Date.now() - started;
    t.check('named, and the sidebar shows the name', named, true);
    t.truthy('in seconds', took < 30_000, `${took} ms`);
    t.check('found again by that name', await c.openConversationByName(name), true);
    t.check('and it is the same conversation', await c.currentChatId(), chatId);
    if (!named) console.log('   ', JSON.stringify(events.filter((x) => /chat-name/.test(x.e))));
  }
} finally {
  await c.close();
}

t.finish();
