/**
 * A run tried again after its input files were missing goes through the whole start — end to end, with
 * the real runner and the scripted chat.
 *
 * Reported 2026-10-02 on 0.1.18 (run 20261002-175647-kbm1): a session with `dirtyWorktree: snapshot`,
 * `userInputs` and `startFrom: previous-session` was started before the YAML schemas were in the project
 * and refused ("match no file"); the schemas were then added, untracked, and the task retried. The retry
 * found the session's start already fixed by the refused attempt, skipped the snapshot, ran with version
 * control "not active", and ended done with the schemas untracked and no baseline anywhere.
 *
 * Since then version control is checked before the browser opens (see vcs/runPreflight.ts): a pattern that
 * matches nothing, and a snapshot waiting for approval, refuse the start with nothing recorded, nothing
 * opened and nothing sent. Once the files are there and approved, the run starts afresh — the baseline
 * commit made, the task cut from it, the sums recorded — and is done only with its work committed.
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
type Started = { started: boolean; reason?: string };

console.log('--- inputs missing at the first try, added, then the run tried again ---');
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
  const start = async (): Promise<Started> => await h.call<Started>('POST', `/sessions/${sid}/start`, { mode: 'unattended' });

  const first = await start();
  t.check('without the schemas the run is refused', first.started, false);
  t.truthy('saying the pattern matches nothing', /match no file/.test(first.reason ?? ''), first.reason);
  const after = (await h.session(sid)) as unknown as View;
  t.check('and the refusal fixed nothing: no start recorded, the task still queued', [after.vcsBaseCommit ?? null, after.vcsStart ?? null, after.tasks[0]!.status], [null, null, 'queued']);
  t.check('no browser was opened and nothing sent', [h.chat.opened, h.chat.sent.length], [0, 0]);

  // The operator adds the schemas, untracked, and tries again.
  mkdirSync(join(h.repo, 'rules-engine', 'test-data', 'schemas'), { recursive: true });
  for (const n of ['a', 'b']) writeFileSync(join(h.repo, 'rules-engine', 'test-data', 'schemas', `${n}.yaml`), `name: ${n}\n`);

  const pre = await h.call<Status>('GET', `/sessions/${sid}/vcs`);
  t.check('the page lists the schemas for the starting snapshot', (pre.snapshot?.entries ?? []).map((e) => e.path).sort(), ['rules-engine/test-data/schemas/a.yaml', 'rules-engine/test-data/schemas/b.yaml']);
  const unapproved = await start();
  t.truthy('a start before approval is refused, not run without version control', !unapproved.started && /needs your approval|approve/i.test(unapproved.reason ?? ''), unapproved.reason);
  t.check('still nothing opened or sent', [h.chat.opened, h.chat.sent.length], [0, 0]);

  const choices = Object.fromEntries((pre.snapshot?.entries ?? []).map((e) => [e.path, 'include']));
  const took = await h.call<{ ok: boolean; problem?: string; branch?: string; commit?: string }>('POST', `/sessions/${sid}/vcs/snapshot`, { choices });
  t.check('approved: the baseline snapshot is taken', [took.ok, took.problem ?? null], [true, null]);

  h.chat.script(
    reply.steps(
      "New-Item -ItemType Directory -Force -Path rules-engine/rules | Out-Null; Set-Content -Path rules-engine/rules/one.txt -Value 'one' -Encoding utf8",
      "New-Item -ItemType Directory -Force -Path rules-engine/test-evidence | Out-Null; Set-Content -Path rules-engine/test-evidence/report.txt -Value 'ok' -Encoding utf8",
    ),
    reply.done(),
  );
  const done = (await h.run(sid)) as unknown as View;
  const task = done.tasks[0]!;
  t.check('the task is done', [task.status, task.reason ?? null], ['done', null]);
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
