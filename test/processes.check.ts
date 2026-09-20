/**
 * What a task or a review leaves running is stopped by the runner, and only that.
 *
 * A reviewer left its own `next start` listening and failed the work for it; every plan so far
 * carried checks for ports and node processes because nothing else would. The questions here:
 * is a process tied to the project folder that appeared after the snapshot found, with the
 * port it holds; is it stopped; and is a process that was already there, or one that has
 * nothing to do with the folder, left alone.
 *
 *   npm run check:processes
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { snapshotProcesses, findLeftovers, reapLeftovers, describeLeftovers } from '../src/exec/processes.js';

const dir = await mkdtemp(join(tmpdir(), 'cop-proc-'));
const port = 47_831;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log('--- before anything runs ---');
const before = await snapshotProcesses(dir);
console.log('tied to the folder    :', before.processes.length, '(expect 0)');

// The folder is on the command line, as it would be for `Set-Location <dir>; npm start` or
// `node dist/main.js` started from it. This one also listens, like a server left behind.
const server = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port}); setInterval(() => {}, 1000)`, dir], { stdio: 'ignore', windowsHide: true });
const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
await wait(1500);

console.log('\n--- what appeared since ---');
const found = await findLeftovers(dir, before);
console.log('found the server      :', found.some((l) => l.pid === server.pid), '(expect true)');
console.log('with its port         :', found.find((l) => l.pid === server.pid)?.ports.join(','), `(expect ${port})`);
console.log('not the bystander     :', !found.some((l) => l.pid === bystander.pid), '(expect true — its command line does not name the folder)');
console.log(describeLeftovers(found).split('\n').map((l) => '  ' + l).join('\n'));

console.log('\n--- stopped, and only that ---');
const reaped = await reapLeftovers(dir, before);
await wait(800);
console.log('killed                :', reaped.killed.map((l) => l.pid).join(','), '| failed:', reaped.failed.length);
console.log('server is gone        :', !alive(server.pid as number), '(expect true)');
console.log('bystander still runs  :', alive(bystander.pid as number), '(expect true)');
console.log('nothing left to find  :', (await findLeftovers(dir, before)).length, '(expect 0)');

bystander.kill();
await rm(dir, { recursive: true, force: true });
