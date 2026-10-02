/**
 * Input files and artifacts through the real runner, with the scripted chat.
 *
 * `inputs.check.ts` holds each part to its promise against git directly; this one holds the runner
 * to using them: a round that changes an input file has it put back before the chat reads the
 * results, and is told so in the next message; the task's commit holds the task's work and not the
 * input; the evidence it wrote is not committed and is kept in the attempt's record with its sum.
 *
 *   npm run check:e2e-inputs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, Tally } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

console.log('--- an input changed by a round, and evidence written ---');
const h = await startHarness({});
try {
  mkdirSync(join(h.repo, 'schemas'), { recursive: true });
  writeFileSync(join(h.repo, 'schemas', 'route.yaml'), 'route: ambulance\n');
  h.git('add', '-A');
  h.git('commit', '-q', '-m', 'the operator commits the schema');
  // Evidence an earlier session left: under the pattern, untouched by this task, so not its evidence.
  mkdirSync(join(h.repo, 'evidence'), { recursive: true });
  writeFileSync(join(h.repo, 'evidence', 'earlier-session.zip'), 'PK');

  const [s] = await h.importPlan({
    version: 1,
    sessions: [{
      name: 'migration',
      onFailure: 'stop',
      vcs: {
        enabled: true,
        repoDir: h.repo,
        branchMode: 'per-session',
        userInputs: { paths: ['schemas/*.yaml'] },
        artifacts: { paths: ['evidence/**'] },
      },
      review: { enabled: false },
      tasks: [{ title: 'migrate', prompt: 'Write migrated.txt holding exactly done, and an evidence report under evidence.' }],
    }],
  });
  h.chat.script(
    (m) => {
      t.truthy('the chat is told the inputs are read-only', /input files are in your working tree.*read-only/s.test(m.text), m.text.slice(0, 400));
      t.truthy('and where evidence goes', /Evidence goes under `evidence\/\*\*`/.test(m.text), '');
      return reply.steps(
        "Set-Content -Path schemas/route.yaml -Value 'route: changed' -Encoding utf8",
        "New-Item -ItemType Directory -Force -Path evidence | Out-Null; Set-Content -Path evidence/report.txt -Value 'all green' -Encoding utf8",
        "Set-Content -Path migrated.txt -Value 'done' -Encoding utf8",
      );
    },
    (m) => {
      t.truthy('the next message says the input was put back', /input files are read-only, so the runner put back: schemas\/route\.yaml/.test(m.text), m.text.slice(0, 600));
      return reply.done();
    },
  );
  const view = await h.run(s!.id);
  const task = view.tasks[0]! as unknown as {
    status: string;
    reason?: string;
    runId?: string;
    inputsRestored?: string[];
    artifactsKept?: Array<{ path: string; sha256: string }>;
    vcs?: { commit?: string; files?: Array<{ path: string }> };
  };
  t.check('done', [task.status, task.reason ?? null], ['done', null]);
  t.check('the input is recorded as put back', task.inputsRestored, ['schemas/route.yaml']);
  t.check('it is as the operator committed it', readFileSync(join(h.repo, 'schemas', 'route.yaml'), 'utf8').replace(/\r\n/g, '\n'), 'route: ambulance\n');
  t.check("the task's commit holds only its work", (task.vcs?.files ?? []).map((f) => f.path), ['migrated.txt']);
  t.check('the evidence this task wrote is kept with the run, not what was there before it', (task.artifactsKept ?? []).map((a) => a.path), ['evidence/report.txt']);
  t.truthy('in the attempt\'s record', !!task.runId && existsSync(join(h.runsDir, task.runId, 'artifacts', 'project', 'evidence', 'report.txt')), task.runId);
  t.check('and not committed', h.git('ls-tree', '-r', '--name-only', task.vcs!.commit!).split('\n').includes('evidence/report.txt'), false);
  t.check('the tree is clean: the evidence is excluded locally, .gitignore untouched', [h.git('status', '--porcelain'), h.git('diff', 'HEAD~2', '--', '.gitignore')], ['', '']);
  t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h.stop();
}

/*
 * Reported 2026-10-02 from a run on 0.1.18 (point 1): input files edited or added once the session had
 * started were "a dirty tree to commit or stash", version control went off and the task ran without
 * it, ending done with nothing committed. Now they are listed for approval and committed on the
 * session's line of work, and the next task starts from them.
 */
type View = { status: string; reason?: string; vcs?: { branch?: string; baseCommit?: string; commit?: string; files?: Array<{ path: string }> } };
type Status = { ok: boolean; problem?: string; snapshot?: { needed: boolean; ok: boolean; entries: Array<{ path: string; choice: string | null }> } };

async function recapture(mode: 'per-task' | 'per-session', approval: boolean): Promise<void> {
  console.log(`\n--- inputs changed after the session started (${mode}, ${approval ? 'approved on the page' : 'requireApproval: false'}) ---`);
  const h = await startHarness({});
  try {
    mkdirSync(join(h.repo, 'schemas'), { recursive: true });
    writeFileSync(join(h.repo, 'schemas', 'route.yaml'), 'route: v1\n');
    h.git('add', '-A');
    h.git('commit', '-q', '-m', 'the operator commits the schema');
    const [s] = await h.importPlan({
      version: 1,
      sessions: [{
        name: `again-${mode}`,
        onFailure: 'stop',
        vcs: { enabled: true, repoDir: h.repo, branchMode: mode, userInputs: { paths: ['schemas/*.yaml'], ...(approval ? {} : { requireApproval: false }) } },
        review: { enabled: false },
        tasks: [{ title: 'first', prompt: 'Write first.txt holding exactly one, from the schema.' }],
      }],
    });
    const sid = s!.id;
    h.chat.script(reply.steps("Set-Content -Path first.txt -Value 'one' -Encoding utf8"), reply.done());
    await h.run(sid);
    // The operator edits an input, adds one, and adds a task to the session.
    writeFileSync(join(h.repo, 'schemas', 'route.yaml'), 'route: v2\n');
    writeFileSync(join(h.repo, 'schemas', 'extra.yaml'), 'extra: 1\n');
    await h.call('POST', `/sessions/${sid}/tasks`, { title: 'second', level2: '', prompt: 'Write second.txt holding exactly two, from the schema.' });

    if (approval) {
      const pre = await h.call<Status>('GET', `/sessions/${sid}/vcs`);
      t.check('the page lists the changed and the new input', (pre.snapshot?.entries ?? []).map((e) => e.path).sort(), ['schemas/extra.yaml', 'schemas/route.yaml']);
      t.truthy('and says they are committed on its line of work', /committed on its line of work/.test(pre.problem ?? ''), pre.problem);
      const choices = Object.fromEntries((pre.snapshot?.entries ?? []).map((e) => [e.path, 'include']));
      const took = await h.call<{ ok: boolean; problem?: string }>('POST', `/sessions/${sid}/vcs/snapshot`, { choices });
      t.check('approving takes them', [took.ok, took.problem ?? null], [true, null]);
      t.check('the tree is clean afterwards', h.git('status', '--porcelain'), '');
    }

    h.chat.script(reply.steps("Set-Content -Path second.txt -Value 'two' -Encoding utf8"), reply.done());
    const view = await h.run(sid);
    const second = view.tasks.find((x) => x.title === 'second') as unknown as View;
    t.check('the next task runs and is done', [second.status, second.reason ?? null], ['done', null]);
    t.check('its commit holds its own work only', (second.vcs?.files ?? []).map((f) => f.path), ['second.txt']);
    const base = second.vcs?.baseCommit ?? '';
    t.check('it starts from the changed inputs', [h.git('show', `${base}:schemas/route.yaml`).trim(), h.git('show', `${base}:schemas/extra.yaml`).trim()], ['route: v2', 'extra: 1']);
    t.truthy('committed as "Capture user-provided inputs"', h.git('log', '--format=%s', base).split('\n').includes('Capture user-provided inputs'), h.git('log', '--oneline', '-5', base));
    t.check('nothing of the operator\'s is lost or left loose', h.git('status', '--porcelain'), '');
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

await recapture('per-task', true);
await recapture('per-session', true);
await recapture('per-task', false);

t.finish();
