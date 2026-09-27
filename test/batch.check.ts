/**
 * A run of several sessions is refused at the entrance, not after the browser is open.
 *
 * On a machine with no isolation claimed, "Run 1 session(s)" opened Edge, began loading the chat and
 * closed it again, with nothing said: the unattended rule was met only inside the loop, per session,
 * after the window was up, and the session was skipped with its reason held in a batch state nobody
 * was looking at. The single-session `start` had always asked first. This holds `startBatch` to the
 * same: refused, with the reason, and no batch begun — so no browser either.
 *
 * The data folder is a fresh temporary one, whose settings are the defaults: isolation "none", the
 * shipped allowlist. That is the machine the report came from.
 *
 *   npm run check:batch
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperatorService } from '../src/api/operator.service.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = got === want;
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

const data = await mkdtemp(join(tmpdir(), 'cop-batch-'));
process.env.COP_DATA_DIR = data;

try {
  const ops = new OperatorService();
  await ops.store.init();
  const s = await ops.store.createSession('one', { enabled: false, rootDir: '' });
  await ops.store.addTask(s.id, { title: 'a-task', level2: '', prompt: 'A prompt that is comfortably long enough to be a real task.' });

  console.log('--- an unattended run with no isolation is refused before anything opens ---');
  const r = await ops.startBatch([s.id], 'unattended', 'stop');
  check('not started', r.started, false);
  check('and says why — the isolation setting', /isolation|isolated|sandbox|separate/i.test(r.reason ?? ''), true);
  check('no batch was begun, so no browser was opened', r.batch, undefined);
  const after = await ops.store.getSession(s.id);
  check('the task is still queued', after?.tasks[0]?.status, 'queued');
  check('and no run was stamped on the session', after?.runGroup, undefined);
} finally {
  await rm(data, { recursive: true, force: true });
}

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
