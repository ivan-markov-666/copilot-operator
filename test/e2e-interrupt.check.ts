/**
 * The bot stopping under a run — Ctrl+C on `npm start`, a crash, the power — and the run carried on
 * afterwards from where it stopped, end to end with a scripted chat in place of Copilot.
 *
 * The first server runs in a process of its own (test/support/apiChild.ts) and is killed with its
 * whole process tree while a step is sleeping, exactly as `scripts/dev.mjs` ends the API on Ctrl+C.
 * A second server is then started on the same data folder, in this process. What must hold:
 *
 * - startup recovery settles the task that was left "running" as `aborted`, with a record of which
 *   steps finished, which was cut off and which never ran;
 * - the work the finished steps did is committed on the task's own branch, not lost;
 * - "Continue" carries the task on in the same conversation, and the chat is told what ran;
 * - the continued attempt finishes on the same branch.
 *
 *   npm run check:e2e-interrupt
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { makeDirs, startHarness, waitFor, Tally, type SessionView } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();
const dirs = await makeDirs();
const git = (...args: string[]): string => execFileSync('git', ['-C', dirs.repo, ...args], { encoding: 'utf8' }).trim();

const plan = {
  version: 1,
  sessions: [
    {
      name: 'cut',
      onFailure: 'stop',
      vcs: { enabled: true, repoDir: dirs.repo, branchMode: 'per-session', branchName: 'cut' },
      review: { enabled: false },
      tasks: [
        {
          title: 'three-files',
          prompt: 'Create first.txt holding one and third.txt holding three in the repository root, and nothing else.',
          checks: [
            { name: 'first written', expect: 'file-contains', file: 'first.txt', value: 'one' },
            { name: 'third written', expect: 'file-contains', file: 'third.txt', value: 'three' },
          ],
        },
      ],
    },
  ],
};

let child: ReturnType<typeof spawn> | null = null;
try {
  console.log('--- the first server, killed in the middle of a step ---');
  const repliesFile = join(dirs.base, 'replies.json');
  await writeFile(
    repliesFile,
    JSON.stringify([reply.steps("Set-Content -Path first.txt -Value 'one' -Encoding utf8", 'Start-Sleep -Seconds 60', "Set-Content -Path third.txt -Value 'three' -Encoding utf8")]),
    'utf8',
  );
  child = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'support', 'apiChild.ts'), dirs.dataDir, repliesFile], {
    cwd: join(import.meta.dirname, '..'),
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const first = await new Promise<{ port: number; token: string }>((resolve, reject) => {
    const lines = createInterface({ input: child!.stdout! });
    lines.on('line', (line) => {
      if (line.startsWith('{"port"')) resolve(JSON.parse(line) as { port: number; token: string });
    });
    child!.once('exit', (code) => reject(new Error(`the first server exited early (${code})`)));
  });
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`http://127.0.0.1:${first.port}/api${path}`, {
      method,
      headers: { 'x-cop-token': first.token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  };

  await call('POST', '/plan/import', { text: JSON.stringify(plan) });
  const [s] = await call<SessionView[]>('GET', '/sessions');
  const started = await call<{ started: boolean }>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  t.check('the run started', started.started, true);
  await waitFor('the first step to have written its file', async () => existsSync(join(dirs.repo, 'first.txt')));
  // Into the sleep, so the second step is the one cut off.
  await new Promise((r) => setTimeout(r, 1500));
  execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await new Promise((r) => child!.once('exit', r));
  child = null;
  t.check('the third step never ran', existsSync(join(dirs.repo, 'third.txt')), false);

  console.log('\n--- the second server, on the same data ---');
  const h = await startHarness({ dirs, own: true });
  try {
    const recovered = (await h.session(s!.id)).tasks[0]!;
    t.check('startup recovery settles the task as aborted', recovered.status, 'aborted');
    t.check('with a record of each step: finished, cut off, never run', recovered.interruption?.steps?.map((x) => `${x.id}:${x.state}`), ['1:finished', '2:cut', '3:not-run']);
    t.check('the finished step\'s work is committed on the task\'s branch', h.git('show', 'cop/cut:first.txt'), 'one');
    t.check('the session is idle, not stuck "running"', (await h.session(s!.id)).status, 'idle');
    t.check('its handoff names the two steps that did not run', recovered.handoff?.notExecuted.length, 2);

    const queued = await h.call<{ status: string; continuing?: { how?: string } }>('POST', `/sessions/${s!.id}/tasks/${recovered.id}/continue`);
    t.check('"Continue" queues it as a continuation after an interruption', [queued.status, queued.continuing?.how], ['queued', 'interrupted']);

    // Copilot keeps the conversation the first server started; this server's chat has to know it.
    const chat = (await h.session(s!.id)).chat!;
    h.chat.adopt(chat.chatId, chat.name);
    h.chat.script(
      (m) => {
        t.check('the continuation goes into the conversation the first server started', m.chatId, chat.chatId);
        t.truthy('the chat is told the bot stopped in the middle', /stopped/i.test(m.text), m.text.slice(0, 600));
        t.truthy('and which steps ran', /step 1/i.test(m.text) && /step 2/i.test(m.text) && /step 3/i.test(m.text), m.text.slice(0, 900));
        return reply.steps("Set-Content -Path third.txt -Value 'three' -Encoding utf8");
      },
      reply.done(),
    );
    const after = (await h.run(s!.id)).tasks[0]!;
    t.check('the continued task finishes', after.status, 'done');
    t.check('on the same branch, with both files', [after.vcs?.branch, h.git('show', 'cop/cut:first.txt'), h.git('show', 'cop/cut:third.txt')], ['cop/cut', 'one', 'three']);
    t.check('the scripted chat was never asked for more', h.chat.problems, []);
  } finally {
    await h.stop();
  }
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  if (child?.pid) {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
  await rm(dirs.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}

t.finish();
