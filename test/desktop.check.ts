/**
 * The projects kept on the Desktop (src/context/desktopMirror.ts): that the copies follow the work
 * while a run goes on, not only before it, and that each project has its own tick under the master
 * switch. The "Desktop" here is a folder inside the check's own temporary folder
 * (`projectMirror.targetDir`); the operator's real Desktop is never touched.
 *
 *   npm run check:desktop
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, waitFor, Tally, type Harness } from './support/harness.js';
import { reply } from './support/fakeChat.js';

const t = new Tally();

/** Every file under a folder, with its text, by name. */
function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const full = join(e.parentPath, e.name);
    out[full.slice(dir.length + 1).replace(/\\/g, '/')] = readFileSync(full, 'utf8');
  }
  return out;
}
const holds = (dir: string, needle: string): boolean => Object.values(filesUnder(dir)).some((text) => text.includes(needle));

async function withHarness(title: string, body: (h: Harness, desktop: string) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness();
  const desktop = join(h.base, 'desktop');
  try {
    const other = join(h.base, 'other');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'notes.txt'), 'other project notes\n');
    const all = { includeDirs: ['.'], excludeDirs: [], respectGitignore: true, includeEnvFiles: false };
    const current = await h.call<{ raw: Record<string, unknown> }>('GET', '/settings');
    await h.call('PUT', '/settings', { ...current.raw, projectMirror: { targetDir: desktop } });
    await h.call('PUT', '/project', { rootDir: h.repo, name: 'app', mirror: all, others: [{ name: 'other', rootDir: other, mirror: all }], mirrorToDesktop: true });
    await body(h, desktop);
    t.check('the chat was never asked for a reply it had no script for', h.chat.problems, []);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    await h.stop();
  }
}

await withHarness('the Desktop copy follows the work while the run goes on', async (h, desktop) => {
  t.truthy('switched on, both projects are on the Desktop at once', existsSync(join(desktop, 'app')) && holds(join(desktop, 'other'), 'other project notes'), filesUnder(desktop));
  const [s] = await h.importPlan({
    version: 1,
    sessions: [{ name: 'live', onFailure: 'stop', vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'live' }, review: { enabled: false }, tasks: [{ title: 'two-rounds', prompt: 'Write first.txt, then second.txt, in the repository root, one per round.' }] }],
  });
  h.chat.script(
    reply.steps("Set-Content -Path first.txt -Value 'written in round one' -Encoding utf8"),
    reply.steps("Set-Content -Path second.txt -Value 'written in round two' -Encoding utf8"),
    reply.done(),
  );
  await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' });
  type Approval = { id: string; stepId: number };
  const first = await waitFor('round one to ask', async () => (await h.call<Approval[]>('GET', '/approvals'))[0]);
  await h.call('POST', `/approvals/${first.id}`, { action: 'run' });
  // Round two waits for its approval: the run is in the middle, and round one's file is on the Desktop.
  const second = await waitFor('round two to ask', async () => (await h.call<Approval[]>('GET', '/approvals')).find((a) => a.id !== first.id));
  await waitFor('round one on the Desktop', async () => holds(join(desktop, 'app'), 'written in round one'), 15_000).catch(() => false);
  t.truthy('mid-run, the file round one wrote is already on the Desktop', holds(join(desktop, 'app'), 'written in round one'), Object.keys(filesUnder(join(desktop, 'app'))));
  t.check('the running session is still running', (await h.session(s!.id)).tasks[0]!.status === 'running' || (await h.session(s!.id)).tasks[0]!.status === 'waiting-approval', true);
  await h.call('POST', `/approvals/${second.id}`, { action: 'run' });
  await h.idle();
  await waitFor('round two on the Desktop', async () => holds(join(desktop, 'app'), 'written in round two'), 15_000).catch(() => false);
  t.truthy('at the end, round two is there too', holds(join(desktop, 'app'), 'written in round two'), Object.keys(filesUnder(join(desktop, 'app'))));
});

await withHarness('each project has its own tick under the master switch', async (h, desktop) => {
  const other = join(h.base, 'other');
  const all = { includeDirs: ['.'], excludeDirs: [], respectGitignore: true, includeEnvFiles: false };
  type Project = { desktop: boolean; others: Array<{ name: string; desktop: boolean }> };
  let p = await h.call<Project>('PUT', '/project', { others: [{ name: 'other', rootDir: other, mirror: all, desktop: false }] });
  t.check('the other project is off, the default stays on', [p.desktop, p.others[0]!.desktop], [true, false]);
  t.check('its Desktop folder is gone, the default\'s is not', [existsSync(join(desktop, 'other')), existsSync(join(desktop, 'app'))], [false, true]);

  p = await h.call<Project>('PUT', '/project', { desktop: false, others: [{ name: 'other', rootDir: other, mirror: all }] });
  t.check('the default off and the other back on', [p.desktop, p.others[0]!.desktop], [false, true]);
  t.check('the Desktop follows', [existsSync(join(desktop, 'app')), holds(join(desktop, 'other'), 'other project notes')], [false, true]);

  const raw = (await h.call<{ raw: { project?: { desktop?: boolean; others?: Array<{ desktop?: boolean }> } } }>('GET', '/settings')).raw.project;
  t.check('stored only when off', [raw?.desktop, raw?.others?.[0]?.desktop], [false, undefined]);

  await h.call('PUT', '/project', { mirrorToDesktop: false });
  t.check('the master switch off removes every project folder', [existsSync(join(desktop, 'app')), existsSync(join(desktop, 'other'))], [false, false]);
  await h.call('PUT', '/project', { mirrorToDesktop: true });
  t.check('and on again brings back only the ticked ones', [existsSync(join(desktop, 'app')), existsSync(join(desktop, 'other'))], [false, true]);
});

/*
 * The Desktop copy and a task's attachments no longer share a folder (2026-09-30). The Desktop copy
 * holds the whole project; a task attaching only src used to delete everything else from it before its
 * first message, and every round put it back — a storm of deletions and uploads in a OneDrive Desktop
 * while the chat uploaded the attachments. Now the attachments come from the run folder, and the
 * Desktop copy is not touched by the task.
 */
await withHarness('a task attaching some folders leaves the whole-project Desktop copy alone', async (h, desktop) => {
  mkdirSync(join(h.repo, 'src'), { recursive: true });
  mkdirSync(join(h.repo, 'docs'), { recursive: true });
  writeFileSync(join(h.repo, 'src', 'app.ts'), 'export const app = 1;\n');
  writeFileSync(join(h.repo, 'docs', 'guide.md'), '# the guide\n');
  h.git('add', '-A');
  h.git('commit', '-q', '-m', 'src and docs');
  // The Desktop copy is refreshed at the start of the run; this one only makes sure it is there now.
  await h.call('PUT', '/project', { mirrorToDesktop: true });
  const before = Object.keys(filesUnder(join(desktop, 'app'))).sort();
  t.truthy('the Desktop copy holds the whole project, docs included', before.some((f) => f.includes('docs--guide.md')), before);

  const [s] = await h.importPlan({
    version: 1,
    sessions: [{
      name: 'attach',
      onFailure: 'stop',
      vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'attach' },
      review: { enabled: false },
      mirror: { enabled: true, rootDir: h.repo, includeDirs: ['src'], excludeDirs: [] },
      tasks: [{ title: 'read-src', prompt: 'Read the attached source and write seen.txt in the repository root holding exactly seen.' }],
    }],
  });
  h.chat.script(
    () => {
      // The attachments go with the first message of the task, which the scripted chat answers itself.
      const m = h.chat.sent.find((x) => x.attachments.length > 0);
      t.truthy('the first message carried attachments', !!m, h.chat.sent.map((x) => x.attachments.length));
      if (!m) return reply.steps("Set-Content -Path seen.txt -Value 'seen' -Encoding utf8");
      t.truthy('the first message attaches the task\'s folder only, from the run folder', m.attachments.every((a) => a.includes('attachments') && a.includes('src--app.ts')), m.attachments);
      t.truthy('every attachment is there when it is sent', Object.values(m.attached).every((text) => text !== '(missing)'), m.attached);
      const now = Object.keys(filesUnder(join(desktop, 'app'))).sort();
      t.check('the Desktop copy still holds everything it held', before.every((f) => now.includes(f)), true);
      return reply.steps("Set-Content -Path seen.txt -Value 'seen' -Encoding utf8");
    },
    reply.done(),
  );
  const task = (await h.run(s!.id)).tasks[0]!;
  t.check('the task ran', task.status, 'done');
});

/*
 * The case in the screenshot of 2026-09-30: the session's files to attach had as their root the bot's
 * own Desktop copy of the project (copilot-operator-context\<project>), not the project. With the
 * Desktop on, the mirror read the folder it was writing; with it off, the folder was not there and the
 * task was refused ("." is not inside the project root). The copy now stands for the project it is a
 * copy of; a folder there that is the copy of nothing is refused, saying what to choose.
 */
async function copyAsRoot(h: Harness, desktop: string, name: string, root: string): Promise<{ status: string; reason?: string }> {
  mkdirSync(join(h.repo, 'src'), { recursive: true });
  writeFileSync(join(h.repo, 'src', 'app.ts'), 'export const app = 1;\n');
  h.git('add', '-A');
  h.git('commit', '-q', '-m', 'src');
  const [s] = await h.importPlan({
    version: 1,
    sessions: [{
      name,
      onFailure: 'stop',
      vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: name },
      review: { enabled: false },
      mirror: { enabled: true, rootDir: root, includeDirs: ['.'], excludeDirs: [] },
      tasks: [{ title: `${name}-task`, prompt: 'Read the attached source and write seen.txt in the repository root holding exactly seen.' }],
    }],
  });
  const before = Object.keys(filesUnder(join(desktop, 'app'))).sort();
  h.chat.script(
    () => {
      const m = h.chat.sent.find((x) => x.attachments.length > 0);
      t.truthy(`${name}: the project's own files are attached, from the run folder`, !!m && m.attachments.some((a) => a.includes('attachments') && a.includes('src--app.ts')), m?.attachments);
      t.truthy(`${name}: not a copy of a copy`, !!m && m.attachments.every((a) => !/app--app--/.test(a)), m?.attachments);
      // Refreshed at the start of the run (src/app.ts is new), and nothing taken out of it.
      const now = Object.keys(filesUnder(join(desktop, 'app')));
      t.truthy(`${name}: nothing was deleted from the Desktop copy`, before.every((f) => now.includes(f)) && now.includes('app--src--app.ts.txt'), now);
      return reply.steps("Set-Content -Path seen.txt -Value 'seen' -Encoding utf8");
    },
    reply.done(),
  );
  return (await h.run(s!.id)).tasks[0]! as unknown as { status: string; reason?: string };
}

await withHarness('the bot\'s Desktop copy named as the root means the project, with the Desktop on', async (h, desktop) => {
  const task = await copyAsRoot(h, desktop, 'copy-on', join(desktop, 'app'));
  t.check('the task ran', [task.status, task.reason ?? null], ['done', null]);
});

await withHarness('the same with the Desktop off, when the copy folder is not there at all', async (h, desktop) => {
  await h.call('PUT', '/project', { mirrorToDesktop: false });
  t.check('no Desktop copy', existsSync(join(desktop, 'app')), false);
  h.chat.script(
    () => {
      const m = h.chat.sent.find((x) => x.attachments.length > 0);
      t.truthy('the project\'s files are attached all the same', !!m && m.attachments.some((a) => a.includes('src--app.ts')), m?.attachments);
      return reply.steps("Set-Content -Path seen.txt -Value 'seen' -Encoding utf8");
    },
    reply.done(),
  );
  mkdirSync(join(h.repo, 'src'), { recursive: true });
  writeFileSync(join(h.repo, 'src', 'app.ts'), 'export const app = 1;\n');
  h.git('add', '-A');
  h.git('commit', '-q', '-m', 'src');
  const [s] = await h.importPlan({
    version: 1,
    sessions: [{
      name: 'copy-off',
      onFailure: 'stop',
      vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'copy-off' },
      review: { enabled: false },
      mirror: { enabled: true, rootDir: join(desktop, 'app'), includeDirs: ['.'], excludeDirs: [] },
      tasks: [{ title: 'copy-off-task', prompt: 'Read the attached source and write seen.txt in the repository root holding exactly seen.' }],
    }],
  });
  const task = (await h.run(s!.id)).tasks[0]! as unknown as { status: string; reason?: string };
  t.check('the task ran instead of being refused', [task.status, task.reason ?? null], ['done', null]);
});

await withHarness('a folder in the Desktop area that is the copy of no project is refused, saying what to choose', async (h, desktop) => {
  const stray = join(desktop, 'someone-elses');
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, 'x.txt'), 'x\n');
  const [s] = await h.importPlan({
    version: 1,
    sessions: [{
      name: 'stray',
      onFailure: 'stop',
      vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'stray' },
      review: { enabled: false },
      mirror: { enabled: true, rootDir: stray, includeDirs: ['.'], excludeDirs: [] },
      tasks: [{ title: 'stray-task', prompt: 'Read the attached source and write seen.txt in the repository root holding exactly seen.' }],
    }],
  });
  const task = (await h.run(s!.id)).tasks[0]! as unknown as { status: string; reason?: string };
  t.truthy('failed before anything was sent, saying to choose the project\'s own folder', task.status === 'failed' && /not the copy of any project/.test(task.reason ?? '') && h.chat.sent.length === 0, task);
});

t.finish();
