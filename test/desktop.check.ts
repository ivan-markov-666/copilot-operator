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

t.finish();
