/**
 * What a task or a review leaves running is stopped by the runner — only what the bot started, and
 * by asking first.
 *
 * A reviewer left its own `next start` listening and failed the work for it; every plan so far
 * carried checks for ports and node processes because nothing else would. The first reaper stopped
 * every new process whose command line named the project folder, with `taskkill /T /F`. Two things
 * were wrong with that, and this holds both:
 *
 *   - a server the operator started by hand in the same folder matched the description and was
 *     killed. Now only a process that descends from a shell `runStep` started is the bot's; the
 *     operator's is reported and left running;
 *   - `/F` is TerminateProcess: no handler runs. Now `taskkill /T` first, then `/F` for what is
 *     left. A console server has no window to close politely, so it still ends forced — the
 *     honest cost of not compiling console signalling at run time on a watched laptop. The servers
 *     here write down whether a handler ran, so the test says which stop it got rather than assume.
 *
 * Real processes throughout: a real Node HTTP server, left behind by a real step the way chats
 * leave them (`Start-Process`), and a real step that times out with its server in the foreground.
 *
 *   npm run check:processes
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ProcessTracker,
  descendantsOf,
  describeLeftovers,
  isAlive,
  reapLeftovers,
  snapshotProcesses,
  type ProcessRow,
} from '../src/exec/processes.js';
import { runStep } from '../src/exec/runner.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log('--- whose process it is, from the table alone ---');
{
  const row = (pid: number, parent: number, created: number, command = ''): ProcessRow => ({ pid, parent, name: 'node.exe', command, created });
  const roots = [{ pid: 100, from: 10_000, to: 20_000 }];
  const table = [
    row(1, 0, 0),
    row(50, 1, 5_000), // the bot itself, say
    row(200, 100, 15_000), // left by the step: its shell (100) is gone, it was born while 100 ran
    row(201, 200, 16_000), // and what that started
    row(300, 100, 60_000), // parent id 100 again, but born long after the step ended: a reused id
    row(100, 1, 50_000), // the reused id itself, alive now, somebody else's
    row(301, 100, 55_000), // a child of that somebody else
    row(400, 1, 17_000, 'node C:\\proj\\server.js'), // the operator's, in the same folder
  ];
  const ours = descendantsOf(table, roots).map((r) => r.pid).sort((a, b) => a - b);
  check('the orphan the step left, and its child', ours, [200, 201]);
  check('a process under a reused id is not ours', ours.includes(300) || ours.includes(301) || ours.includes(100), false);
  check("the operator's process in the same folder is not ours", ours.includes(400), false);
  const live = descendantsOf([row(1, 0, 0), row(100, 1, 10_100), row(101, 100, 11_000)], [{ pid: 100, from: 10_000 }]);
  check('a step still running is ours with what is under it', live.map((r) => r.pid), [100, 101]);
}

if (process.platform !== 'win32') {
  console.log('\n(the live part needs Windows)');
  process.exit(wrong === 0 ? 0 : 1);
}

const dir = await mkdtemp(join(tmpdir(), 'cop-proc-'));
const server = join(dir, 'server.js');
await writeFile(
  server,
  `const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const port = Number(process.argv[2]);
const s = http.createServer((_q, r) => r.end('ok')).listen(port, () => console.log('listening ' + port));
for (const sig of ['SIGINT', 'SIGBREAK', 'SIGTERM']) process.on(sig, () => {
  fs.writeFileSync(path.join(__dirname, 'ended-' + port + '.txt'), sig);
  s.close(() => process.exit(0));
});
`,
  'utf8',
);
const ended = (port: number): string | null => {
  const f = join(dir, `ended-${port}.txt`);
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
};
const LEFT = 47_831;
const MINE = 47_832;
const HUNG = 47_833;

try {
  console.log('\n--- a server a step left behind, and one the operator started by hand ---');
  const before = await snapshotProcesses(dir);
  const tracker = new ProcessTracker();

  // The operator's: not started through the runner, and its command line names the folder — which
  // is all the old reaper looked at.
  const operators = spawn(process.execPath, [server, String(MINE)], { stdio: 'ignore', windowsHide: true });

  // The bot's: a step that starts a server and exits, exactly how chats leave them.
  const step = await runStep(
    {
      id: 1,
      shell: 'powershell',
      command: `Start-Process -FilePath '${process.execPath}' -ArgumentList '"${server}"',${LEFT} -WindowStyle Hidden`,
      cwd: dir,
      hardTimeoutMs: 30_000,
      logPath: join(dir, 'step-1.log'),
    },
    { tracker },
  );
  check('the step itself finished', step.outcome, 'completed');
  await wait(2_500);

  const reaped = await reapLeftovers(dir, before, tracker);
  console.log(describeLeftovers([...reaped.killed, ...reaped.failed, ...reaped.notOurs]).split('\n').map((l) => '      ' + l).join('\n'));
  const leftServer = reaped.killed.find((l) => l.ports.includes(LEFT));
  check("the step's server was found, with its port", leftServer !== undefined, true);
  check('and stopped, one way or the other', leftServer?.how === 'closed' || leftServer?.how === 'forced', true);
  console.log(`      (how: ${leftServer?.how}; handler ran: ${ended(LEFT) !== null})`);
  check('nothing the bot started failed to stop', reaped.failed.length, 0);
  check("the operator's server is still running", isAlive(operators.pid!), true);
  check('and it was not signalled', ended(MINE), null);
  check('it is reported as not ours', reaped.notOurs.some((l) => l.pid === operators.pid), true);
  operators.kill();

  console.log('\n--- a step that times out is asked to stop before it is made to ---');
  const hung = await runStep(
    { id: 2, shell: 'powershell', command: `& '${process.execPath}' '${server}' ${HUNG}`, cwd: dir, hardTimeoutMs: 4_000, logPath: join(dir, 'step-2.log') },
    { tracker },
  );
  check('the outcome is the timeout, not "completed"', hung.outcome, 'hard-timeout');
  check('the log says how it was stopped', /asked to close, then forced/.test(hung.stderr), true);
  console.log(`      (handler ran: ${ended(HUNG) !== null})`);
} finally {
  await wait(300);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

console.log(wrong === 0 ? '\nall good' : `\n${wrong} wrong`);
process.exit(wrong === 0 ? 0 : 1);
