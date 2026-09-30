/**
 * The project is no longer copied anywhere nor attached to the chat (removed on 2026-09-30 at the
 * operator's request: it misbehaved, and the chat reads the project by running commands instead).
 *
 * - a session saved before the removal is read with its old files' root as its project folder;
 * - a plan that still asks for project files imports, with a warning, and nothing is attached;
 * - a task's commands run in the session's project folder;
 * - the contract tells the chat that no file is attached and to read the project with commands.
 *
 *   npm run check:noattach
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/session/store.js';
import { startHarness, Tally } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

console.log('--- a session saved before the removal ---');
{
  const dir = await mkdtemp(join(tmpdir(), 'cop-noattach-'));
  try {
    await mkdir(join(dir, 'sessions'), { recursive: true });
    const old = {
      id: '20260901-120000-abcd',
      name: 'old one',
      createdAt: '2026-09-01T12:00:00.000Z',
      status: 'idle',
      contractSent: false,
      onFailure: 'stop',
      vcs: { enabled: false, repoDir: '', branchMode: 'per-task', commitOnFinish: true, branchPrefix: 'cop/' },
      mirror: { enabled: true, rootDir: 'C:\\Projects\\app', includeDirs: ['src'], excludeDirs: [], respectGitignore: true, includeEnvFiles: false },
      tasks: [],
    };
    await writeFile(join(dir, 'sessions', `${old.id}.json`), JSON.stringify(old), 'utf8');
    const store = new SessionStore(dir, join(dir, 'level1.md'));
    await store.init();
    const read = (await store.getSession(old.id)) as unknown as Record<string, unknown>;
    t.check('its old files root is its project folder', read.projectDir, 'C:\\Projects\\app');
    t.check('and nothing of the files setting is left', 'mirror' in read, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('\n--- a plan that still asks for project files ---');
{
  const h = await startHarness();
  try {
    const plan = {
      version: 1,
      sessions: [{
        name: 'old-plan',
        onFailure: 'stop',
        vcs: { enabled: false, repoDir: '' },
        review: { enabled: false },
        mirror: { enabled: true, rootDir: h.repo, includeDirs: ['.'], excludeDirs: [] },
        tasks: [{ title: 'write-here', prompt: 'Create here.txt in the project folder holding exactly here, and nothing else.' }],
      }],
    };
    const imported = await h.call<{ ok: boolean; summary?: unknown; result?: { warnings: string[] } }>('POST', '/plan/import', { text: JSON.stringify(plan) });
    t.truthy('it imports, warning that project files are no longer attached', imported.ok && (imported.result?.warnings ?? []).some((w) => /no longer exists/.test(w) && /running commands/.test(w)), imported);
    const s = (await h.call<Array<{ id: string; name: string; projectDir?: string }>>('GET', '/sessions')).find((x) => x.name === 'old-plan')!;
    t.check('its root became the project folder', s.projectDir, h.repo);

    h.chat.script(reply.steps("Set-Content -Path here.txt -Value 'here' -Encoding utf8"), reply.done());
    const ran = await h.run(s.id);
    t.check('the task ran', ran.tasks[0]!.status, 'done');
    t.check('nothing was attached to any message', h.chat.sent.filter((m) => m.attachments.some((a) => !/iteration-\d+\.txt$/.test(a))).length, 0);
    t.check('its commands ran in the project folder', existsSync(join(h.repo, 'here.txt')), true);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

console.log('\n--- what the chat is told ---');
{
  const level1 = await readFile(join(import.meta.dirname, '..', 'prompts', 'level1.md'), 'utf8');
  t.truthy('no file of the project is attached; it is read with commands', /No file of the project is attached/.test(level1) && /running commands in its folder/.test(level1), '');
}

t.finish();
