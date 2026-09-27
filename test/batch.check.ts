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

  /*
   * "Run the rest without asking", pressed during a watched run, must bring the unattended rules with
   * it. It used to stop the asking while the rules went on believing a person was reading each line,
   * so an allowed interpreter evaluating a string — the one thing the unattended rules add — ran
   * unread. Driven through the service's own wiring: the same policy object the authorizer holds.
   */
  console.log('\n--- switching a watched run to unattended brings the unattended rules ---');
  const internals = ops as unknown as {
    running: Map<string, unknown>;
    webAuthorizer(p: unknown, signal: AbortSignal): { authorize(step: unknown, ctx: unknown): Promise<{ action: string; reason?: string }> };
  };
  const policy = { mode: 'confirm' as 'confirm' | 'unattended', denyPatterns: [], allowedPrograms: ['node'], isolation: 'none-accepted' as const };
  const controller = new AbortController();
  const authorizer = internals.webAuthorizer(policy, controller.signal);
  internals.running.set('switched', { controller, startedAt: new Date().toISOString(), mode: 'confirm', policy });
  const switched = ops.setRunMode('switched', 'unattended');
  check('the switch is allowed (risk accepted, allowlist present)', switched.ok, true);
  const inline = await authorizer.authorize({ id: 1, type: 'command', cmd: 'node -e "require(\'fs\')"' }, { sessionId: 'switched', iteration: 1 });
  check('an interpreter evaluating a string is now refused', inline.action, 'skip');
  const plain = await authorizer.authorize({ id: 2, type: 'command', cmd: 'node --test' }, { sessionId: 'switched', iteration: 1 });
  check('an ordinary command still runs without asking', plain.action, 'run');
  internals.running.delete('switched');
} finally {
  await rm(data, { recursive: true, force: true });
}

console.log('\nwrong:', wrong, '(expect 0)');
if (wrong > 0) process.exitCode = 1;
