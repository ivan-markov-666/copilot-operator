import { runStep } from '../src/exec/runner.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = join(tmpdir(), 'cop-runner-check');

async function main() {
  const ok = await runStep({
    id: 1, shell: 'pwsh', command: 'Write-Output "hello"; Write-Output "world"',
    cwd: process.cwd(), logPath: join(base, 'ok.log'),
  });
  console.log('ok        ->', ok.outcome, 'exit', ok.exitCode, JSON.stringify(ok.stdout.trim()));

  const fail = await runStep({
    id: 2, shell: 'cmd', command: 'dir C:\definitely-not-here-12345',
    cwd: process.cwd(), logPath: join(base, 'fail.log'),
  });
  console.log('failing   ->', fail.outcome, 'exit', fail.exitCode, 'stderr?', fail.stderr.trim().length > 0);

  const t0 = Date.now();
  const idle = await runStep({
    id: 3, shell: 'pwsh', command: 'Start-Sleep -Seconds 120',
    cwd: process.cwd(), logPath: join(base, 'idle.log'),
    idleTimeoutMs: 3000, hardTimeoutMs: 600000,
  });
  console.log('idle hang ->', idle.outcome, 'exit', idle.exitCode, 'killed after', Math.round((Date.now()-t0)/1000)+'s');

  const t1 = Date.now();
  let beats = 0;
  const chatty = await runStep({
    id: 4, shell: 'pwsh',
    command: '1..8 | ForEach-Object { Write-Output "suite step $_"; Start-Sleep -Milliseconds 700 }',
    cwd: process.cwd(), logPath: join(base, 'chatty.log'),
    idleTimeoutMs: 3000, hardTimeoutMs: 600000,
  }, { onHeartbeat: () => { beats++; } });
  console.log('chatty    ->', chatty.outcome, 'exit', chatty.exitCode,
    'lines', chatty.stdout.trim().split(/\r?\n/).length, 'ran', Math.round((Date.now()-t1)/1000)+'s (idle timeout 3s never tripped)');

  const t2 = Date.now();
  const hard = await runStep({
    id: 5, shell: 'pwsh',
    command: '1..100 | ForEach-Object { Write-Output "tick $_"; Start-Sleep -Milliseconds 300 }',
    cwd: process.cwd(), logPath: join(base, 'hard.log'),
    idleTimeoutMs: 60000, hardTimeoutMs: 4000,
  });
  console.log('hard cap  ->', hard.outcome, 'exit', hard.exitCode, 'killed after', Math.round((Date.now()-t2)/1000)+'s');
}
main();
