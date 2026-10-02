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
  t.check('the evidence is kept with the run', (task.artifactsKept ?? []).map((a) => a.path), ['evidence/report.txt']);
  t.truthy('in the attempt\'s record', !!task.runId && existsSync(join(h.runsDir, task.runId, 'artifacts', 'project', 'evidence', 'report.txt')), task.runId);
  t.check('and not committed', h.git('ls-tree', '-r', '--name-only', task.vcs!.commit!).split('\n').includes('evidence/report.txt'), false);
  t.check('the tree is clean: the evidence is excluded locally, .gitignore untouched', [h.git('status', '--porcelain'), h.git('diff', 'HEAD~2', '--', '.gitignore')], ['', '']);
  t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await h.stop();
}

t.finish();
