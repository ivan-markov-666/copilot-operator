/**
 * With version control on, a task is done only when its work is committed — end to end, with the
 * real runner and the scripted chat.
 *
 * Reported 2026-10-02 from a run on 0.1.18: "the commit fails, and the task still becomes done".
 * Two ways that happened, both held here:
 *
 *   - the runner's commit failed after the task (here git cannot take the index lock) and the task
 *     ended done anyway, its work loose in the tree; now it ends failed, saying why, the work left
 *     in the working tree;
 *   - the tree was dirty when the task started, version control went "on but inactive", the task
 *     ran, nothing was committed, and it ended done; now the run is refused before the browser opens.
 *
 *   npm run check:e2e-commit
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

async function scenario(title: string, body: (h: Harness) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({});
  try {
    await body(h);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

const plan = (h: Harness, name: string): unknown => ({
  version: 1,
  sessions: [{
    name,
    onFailure: 'stop',
    vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session' },
    review: { enabled: false },
    tasks: [{ title: `${name}-task`, prompt: 'Create result.txt in the repository root holding exactly the word done, and nothing else.' }],
  }],
});

type Ended = { status: string; reason?: string; vcs?: { branch?: string; commit?: string; problem?: string } };

await scenario('a commit that fails after the task fails the task', async (h) => {
  const [s] = await h.importPlan(plan(h, 'lock'));
  const lock = join(h.repo, '.git', 'index.lock');
  h.chat.script(
    reply.steps("Set-Content -Path result.txt -Value 'done' -Encoding utf8"),
    () => {
      // Another git holding the index when the runner commits: the add cannot take the lock.
      writeFileSync(lock, '');
      return reply.done();
    },
  );
  const ended = (await h.run(s!.id)).tasks[0]! as unknown as Ended;
  if (existsSync(lock)) rmSync(lock);
  t.check('the task is failed, not done', ended.status, 'failed');
  t.truthy('the reason says the work was not committed, and why', /could not commit the task's work/.test(ended.reason ?? ''), ended.reason);
  t.check('nothing was committed on its branch', ended.vcs?.commit, undefined);
  t.truthy('the work is left in the working tree', existsSync(join(h.repo, 'result.txt')), h.git('status', '--porcelain'));
});

await scenario('a dirty tree refuses the run before the browser opens', async (h) => {
  writeFileSync(join(h.repo, 'mine.txt'), "the operator's work in progress\n");
  const [s] = await h.importPlan(plan(h, 'dirty'));
  // Since 2026-10-02 version control is checked before anything opens the browser: the start itself is refused.
  const r = await h.call<{ started: boolean; reason?: string }>('POST', `/sessions/${s!.id}/start`, { mode: 'unattended' });
  t.check('the run does not start', r.started, false);
  t.truthy('the reason names the file and where to fix it', /uncommitted changes \(mine\.txt\)/.test(r.reason ?? '') && /Prepare version control for this run/.test(r.reason ?? ''), r.reason);
  t.check('no browser was opened and nothing sent', [h.chat.opened, h.chat.sent.length], [0, 0]);
  t.check('the task is still queued', (await h.session(s!.id)).tasks[0]!.status, 'queued');
  t.check("the operator's file is untouched and still uncommitted", h.git('status', '--porcelain'), '?? mine.txt');
});

/*
 * From the feedback of 2026-10-02: a task that failed before it ran reported an artifact that was
 * already there, untouched, as kept. Nothing ran, so nothing is its evidence.
 */
await scenario('a task refused before it runs keeps no artifacts', async (h) => {
  mkdirSync(join(h.repo, 'evidence'), { recursive: true });
  writeFileSync(join(h.repo, 'evidence', 'earlier.txt'), 'from an earlier session\n');
  h.git('add', '-A');
  h.git('commit', '-q', '-m', 'earlier evidence');
  const [s] = await h.importPlan({
    version: 1,
    sessions: [{
      name: 'badname',
      onFailure: 'stop',
      vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'feature/work.lock', artifacts: { paths: ['evidence/**'] } },
      review: { enabled: false },
      tasks: [{ title: 'never', prompt: 'Create result.txt in the repository root holding exactly the word done, and nothing else.' }],
    }],
  });
  const ended = (await h.run(s!.id)).tasks[0]! as unknown as Ended & { artifactsKept?: unknown[] };
  t.check('the task is refused before it runs', [ended.status, h.chat.sent.length], ['failed', 0]);
  t.check('and keeps nothing as its evidence', ended.artifactsKept ?? null, null);
});

t.finish();
