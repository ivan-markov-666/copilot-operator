/**
 * The API in a process of its own, with a scripted chat, for the check that kills it mid-run.
 *
 *   node --import tsx test/support/apiChild.ts <data dir> <replies.json>
 *
 * The replies file is a JSON list of markdown strings, answered in order (see fakeChat.ts). Once the
 * server is listening this prints one line, `{"port":…,"token":"…"}`, and then stays up until it is
 * killed — which is the point: test/e2e-interrupt.check.ts ends it the way Ctrl+C on `npm start`
 * does, the whole process tree at once, while a step is still running.
 */
import { readFileSync } from 'node:fs';
import { setTransportFactory } from '../../src/transport/chatTransport.js';
import { FakeCopilot } from './fakeChat.js';
import { freePort } from './harness.js';

const [dataDir, repliesFile] = process.argv.slice(2);
if (!dataDir || !repliesFile) {
  console.error('usage: apiChild.ts <data dir> <replies.json>');
  process.exit(2);
}

const chat = new FakeCopilot();
chat.script(...(JSON.parse(readFileSync(repliesFile, 'utf8')) as string[]));
setTransportFactory(chat.factory());
process.env.COP_DATA_DIR = dataDir;

const { startApi } = await import('../../src/api/server.js');
const port = await freePort();
const api = await startApi({ port, quiet: true });
process.stdout.write(`${JSON.stringify({ port: api.port, token: api.token })}\n`);
