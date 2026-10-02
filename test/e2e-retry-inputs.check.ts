/**
 * A task retried after its input files were missing goes through the whole start again — end to end,
 * with the real runner and the scripted chat.
 *
 * Reported 2026-10-02 on 0.1.18 (run 20261002-175647-kbm1): a session with `dirtyWorktree: snapshot`,
 * `userInputs` and `startFrom: previous-session` was started before the YAML schemas were in the project
 * and refused ("match no file"); the schemas were then added, untracked, and the task retried. The retry
 * found the session's start already fixed by the refused attempt, skipped the snapshot, ran with version
 * control "not active", and ended done with the schemas untracked and no baseline anywhere.
 *
 * A start is now recorded only when the first task gets that far: a refusal before it leaves the session
 * as it was, so the retry is a fresh start — the schemas listed for approval, the baseline commit made,
 * the task cut from it, the sums recorded, and done only with its work committed.
 *
 *   npm run check:e2e-retry-inputs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, Tally } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

type Task = { id: string; status: string; reason?: string; vcs?: { branch?: string; baseCommit?: string; commit?: string; files?: Array<{ path: string }> } };
type View = { tasks: Task[]; vcsBaseCommit?: string; vcsStart?: { kind: string; commit: string; branch?: string; inputs?: { files: Array<{ path: string; sha256: string }> } } };
type Status = { ok: boolean; problem?: string; snapshot?: { needed: boolean; ok: boolean; entries: Array<{ path: string; choice: string | null }> } };

console.log('--- inputs missing at the first try, added, then the task retried ---');
const h = await startHarness({});
try {
  const [s] = await h.importPlan({
    version: 1,
    sessions: [{
      name: 'rules',
      onFailure: 'stop',
      vcs: {
        enabled: true,
        repoDir: h.repo,
        branchMode: 'per-session',
        startFrom: 'previous-session',
        updateFromRemote: false,
        dirtyWorktree: { policy: 'snapshot' },
        userInputs: { paths: ['rules-engine/test-data/schemas/*.yaml'], readOnly: true },
        artifacts: { paths: ['rules-engine/test-evidence/**'] },
      },
      review: { enabled: false },
      tasks: [{ title: 'migrate', prompt: 'Write rules-engine/rules/one.txt holding exactly one, from the schemas, and an evidence report.' }],
    }],
  });
  const sid = s!.id;

  const first = (await h.run(sid)) as unknown as View;
  t.check('without the schemas the task is refused', first.tasks[0]!.status, 'failed');
  t.truthy('saying the pattern matches nothing', /match no file/.test(first.tasks[0]!.reason ?? ''), first.tasks[0]!.reason);
  t.check('and the refusal fixed nothing: no start recorded', [first.vcsBaseCommit ?? null, first.vcsStart ?? null], [null, null]);
  t.check('no message went to the chat', h.chat.sent.length, 0);

  // The operator adds the schemas, untracked, and retries the task.
  mkdirSync(join(h.repo, 'rules-engine', 'test-data', 'schemas'), { recursive: true });
  for (const n of ['a', 'b']) writeFileSync(join(h.repo, 'rules-engine', 'test-data', 'schemas', `${n}.yaml`), `name: ${n}\n`);
  await h.call('POST', `/sessions/${sid}/tasks/${first.tasks[0]!.id}/rerun`, {});

  const pre = await h.call<Status>('GET', `/sessions/${sid}/vcs`);
  t.check('the page lists the schemas for the starting snapshot', (pre.snapshot?.entries ?? []).map((e) => e.path).sort(), ['rules-engine/test-data/schemas/a.yaml', 'rules-engine/test-data/schemas/b.yaml']);
  const unapproved = (await h.run(sid)) as unknown as View;
  t.truthy('a retry before approval is refused, not run without version control', unapproved.tasks[0]!.status === 'failed' && /approved the list/.test(unapproved.tasks[0]!.reason ?? ''), unapproved.tasks[0]!.reason);
  t.check('still nothing sent to the chat', h.chat.sent.length, 0);

  const choices = Object.fromEntries((pre.snapshot?.entries ?? []).map((e) => [e.path, 'include']));
  const took = await h.call<{ ok: boolean; problem?: string; branch?: string; commit?: string }>('POST', `/sessions/${sid}/vcs/snapshot`, { choices });
  t.check('approved: the baseline snapshot is taken', [took.ok, took.problem ?? null], [true, null]);

  await h.call('POST', `/sessions/${sid}/tasks/${first.tasks[0]!.id}/rerun`, {});
  h.chat.script(
    reply.steps(
      "New-Item -ItemType Directory -Force -Path rules-engine/rules | Out-Null; Set-Content -Path rules-engine/rules/one.txt -Value 'one' -Encoding utf8",
      "New-Item -ItemType Directory -Force -Path rules-engine/test-evidence | Out-Null; Set-Content -Path rules-engine/test-evidence/report.txt -Value 'ok' -Encoding utf8",
    ),
    reply.done(),
  );
  const done = (await h.run(sid)) as unknown as View;
  const task = done.tasks[0]!;
  t.check('the retried task is done', [task.status, task.reason ?? null], ['done', null]);
  t.check('the session starts from the baseline snapshot', [done.vcsStart?.kind, done.vcsBaseCommit], ['snapshot', took.commit]);
  t.check('the task was cut from it', h.git('merge-base', '--is-ancestor', took.commit!, task.vcs!.commit!) === '', true);
  t.check('the sums of the schemas are recorded', (done.vcsStart?.inputs?.files ?? []).map((f) => f.path), ['rules-engine/test-data/schemas/a.yaml', 'rules-engine/test-data/schemas/b.yaml']);
  t.check('its commit holds its work, not the schemas or the evidence', (task.vcs?.files ?? []).map((f) => f.path), ['rules-engine/rules/one.txt']);
  t.check('nothing is left untracked', h.git('status', '--porcelain'), '');
  t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h.stop();
}

t.finish();
