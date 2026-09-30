/**
 * "Bring this project back to the remote main branch" (src/vcs/syncCommand.ts): what the API says
 * would be lost, that it answers only for folders the bot works in, and that the command it hands
 * out does what it says when the operator runs it — here, in a throwaway repository with a bare
 * repository as its remote. The bot itself never runs the command; this check does, to prove it.
 *
 *   npm run check:sync
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { psQuote, syncCommands } from '../src/vcs/syncCommand.js';
import { startHarness, Tally } from './support/harness.js';

const t = new Tally();

console.log('--- the commands, as text ---');
t.check('a path with an apostrophe is quoted for PowerShell', psQuote("C:\\Users\\o'brien\\app"), "'C:\\Users\\o''brien\\app'");
const cmds = syncCommands('C:\\Projects\\app', 'origin', 'origin/main');
t.check(
  'each step only if the one before worked (no && — PowerShell 5.1 has none)',
  cmds.command,
  "git -C 'C:\\Projects\\app' fetch 'origin'; if ($LASTEXITCODE -eq 0) { git -C 'C:\\Projects\\app' reset --hard 'origin/main'; if ($LASTEXITCODE -eq 0) { git -C 'C:\\Projects\\app' clean -fd } }",
);
t.truthy('the preview only reads', !/reset|clean -f/.test(cmds.preview) && cmds.preview.includes('clean -nd'), cmds.preview);

console.log('\n--- a project with work that would be lost ---');
const h = await startHarness();
try {
  const git = (...args: string[]): string => execFileSync('git', ['-C', h.repo, ...args], { encoding: 'utf8' }).trim();
  const remote = join(h.base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git('remote', 'add', 'origin', remote);
  writeFileSync(join(h.repo, '.gitignore'), 'node_modules/\n.env\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'ignore');
  git('push', '-q', 'origin', 'main');
  git('fetch', '-q', 'origin');
  git('remote', 'set-head', 'origin', 'main');

  // A task branch with a commit of its own, a changed tracked file, new files, and ignored ones.
  git('checkout', '-q', '-b', 'cop/task');
  writeFileSync(join(h.repo, 'feature.txt'), 'feature\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'task work');
  writeFileSync(join(h.repo, 'README.md'), '# changed\n');
  writeFileSync(join(h.repo, 'stray.txt'), 'stray\n');
  mkdirSync(join(h.repo, 'newdir'), { recursive: true });
  writeFileSync(join(h.repo, 'newdir', 'x.txt'), 'x\n');
  mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(h.repo, 'node_modules', 'pkg', 'index.js'), '1\n');
  writeFileSync(join(h.repo, '.env'), 'SECRET=1\n');

  type Plan = { ok: boolean; branch?: string; target?: string; lastFetched?: string; willLose: { commits: string[]; changed: string[]; untracked: string[] }; preview: string; command: string };
  const plan = await h.call<Plan>('GET', `/repo/sync?dir=${encodeURIComponent(h.repo)}`);
  t.check('on the task branch, going back to origin/main', [plan.ok, plan.branch, plan.target], [true, 'cop/task', 'origin/main']);
  t.truthy('the commit of its own is named', plan.willLose.commits.length === 1 && plan.willLose.commits[0]!.endsWith('task work'), plan.willLose.commits);
  t.check('the changed tracked file', plan.willLose.changed, ['README.md']);
  t.check('the new files and folder, and not the ignored ones', [...plan.willLose.untracked].sort(), ['newdir/', 'stray.txt']);
  t.truthy('with when it last fetched', !!plan.lastFetched, plan.lastFetched);
  t.check('nothing was touched by asking', [existsSync(join(h.repo, 'stray.txt')), git('rev-parse', '--abbrev-ref', 'HEAD')], [true, 'cop/task']);

  const other = await h.raw('GET', `/repo/sync?dir=${encodeURIComponent(join(h.base, 'somewhere-else'))}`);
  t.truthy('a folder that is not a project of the bot is refused', other.status >= 400, other);

  console.log('\n--- the command, run as the operator would ---');
  // The preview in PowerShell 7, the command in Windows PowerShell 5.1: it is written for both.
  const pwsh = (script: string): string => execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  const ps51 = (script: string): string => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  pwsh(plan.preview);
  t.check('the preview changed nothing', [existsSync(join(h.repo, 'stray.txt')), readFileSync(join(h.repo, 'README.md'), 'utf8')], [true, '# changed\n']);
  ps51(plan.command);
  t.check('the branch is where origin/main is', git('rev-parse', 'HEAD'), git('rev-parse', 'origin/main'));
  t.check('and still the same branch', git('rev-parse', '--abbrev-ref', 'HEAD'), 'cop/task');
  t.check('the change and the new files are gone', [readFileSync(join(h.repo, 'README.md'), 'utf8'), existsSync(join(h.repo, 'stray.txt')), existsSync(join(h.repo, 'newdir'))], ['# fixture\n', false, false]);
  t.check('ignored files are left alone', [existsSync(join(h.repo, 'node_modules', 'pkg', 'index.js')), existsSync(join(h.repo, '.env'))], [true, true]);
  t.check('the tree is clean', git('status', '--porcelain'), '');

  const after = await h.call<Plan>('GET', `/repo/sync?dir=${encodeURIComponent(h.repo)}`);
  t.check('asked again: nothing would be lost', after.willLose, { commits: [], changed: [], untracked: [] });
} finally {
  await h.stop();
}

t.finish();
