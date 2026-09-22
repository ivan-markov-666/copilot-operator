#!/usr/bin/env node
/**
 * Bring this checkout up to date with the repository, without touching what the operator put in.
 *
 *   npm run update              back up, pull, install, build
 *   npm run update -- --check   say what would happen and change nothing
 *
 * The fear this exists to answer is a real one and a wrong one, and it is worth writing down
 * which is which. **A pull cannot lose your work.** Everything this program records lives in
 * `data/` (settings, sessions, level 2 presets, a customised level 1, the organisation and work
 * texts, the model list) and `runs/` (every log, report and artifact of every task), and both
 * are in `.gitignore`. Nothing the program writes goes anywhere else: every write in `src/`
 * lands in one of those two or on the Desktop. Git does not know those folders exist, and cannot
 * overwrite, merge or delete them.
 *
 * What a pull can do is refuse to start, saying local changes would be overwritten — and the
 * usual reason is not that anybody edited anything. It is line endings: two Windows machines,
 * one with `core.autocrlf` set and one without, disagreeing about files whose content is
 * identical. `.gitattributes` settles that; this script says plainly when something else is the
 * cause, and puts it aside somewhere it can be got back from rather than discarding it.
 *
 * Hence the order: make the safety net first and say where it is, refuse while the bot is
 * running, fast-forward only — never a merge nobody asked for — then reinstall and rebuild,
 * because a checkout whose `dist/` is older than its `src/` runs the previous version and
 * reports the previous version's bugs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, cpSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const checkOnly = process.argv.includes('--check');

const log = (tag, line) => process.stdout.write('[' + tag + '] ' + line + '\n');
const die = (line, hint) => {
  log('stop', line);
  if (hint) log('stop', hint);
  process.exit(1);
};

/*
 * npm is a `.cmd` on Windows, which `spawn` cannot start by that name. The usual answer is
 * `shell: true`, and Node now warns about it for good reason: with a shell, the arguments are
 * concatenated rather than escaped. Naming the `.cmd` directly gets the same result with no
 * shell and no warning.
 */
const NPM = isWin ? 'npm.cmd' : 'npm';

/** A command, run here, with its output captured. No shell is ever involved. */
function run(file, args, opts = {}) {
  const r = spawnSync(file, args, { cwd: root, encoding: 'utf8', windowsHide: true, ...opts });
  // `raw` as well as `out`, because trimming is right for a one-line answer and wrong for
  // `git status --porcelain`: its first two columns are the status and either may be a space,
  // so a trimmed first line loses that space and with it the first character of the file name.
  const raw = r.stdout ?? '';
  return { ok: r.status === 0, out: raw.trim(), raw, err: (r.stderr ?? '').trim() };
}

const git = (...args) => run('git', args);

// --- 0. is this even a checkout -------------------------------------------------------------
if (!git('rev-parse', '--is-inside-work-tree').ok) die('This folder is not a git checkout, so there is nothing to update from.');
const remote = git('remote');
if (!remote.out) die('This checkout has no remote, so there is nowhere to update from.', 'Add one with: git remote add origin <url>');

const branch = git('rev-parse', '--abbrev-ref', 'HEAD').out || 'HEAD';
log('update', 'checkout at ' + root);
log('update', 'branch ' + branch + (checkOnly ? '   (checking only; nothing will be changed)' : ''));

// --- 1. refuse while the bot is running -----------------------------------------------------
/*
 * Swapping the code under a run in flight is the one genuinely destructive thing this script
 * could do: the API holds the Edge profile and a conversation part-way through a task, and a
 * rebuild underneath leaves a half-old process driving a half-new contract. Ports are the honest
 * test, because a port is what actually conflicts.
 */
if (isWin) {
  const script = [
    '$ports = 4000, 3210',
    '$conns = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }',
    'foreach ($c in $conns) {',
    '  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)"',
    '  $cmd = if ($p) { $p.CommandLine } else { "" }',
    '  Write-Output ("{0}|{1}" -f $c.LocalPort, $cmd)',
    '}',
  ].join('\n');
  const here = root.replace(/\\/g, '/').toLowerCase();
  const held = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
    .out.split(/\r?\n/)
    .filter((l) => l.includes('|'))
    .filter((l) => (l.split('|')[1] ?? '').replace(/\\/g, '/').toLowerCase().includes(here))
    .map((l) => l.split('|')[0]);
  if (held.length > 0) {
    die('the bot is running here (port ' + held.join(', ') + ').', 'Stop it first — Ctrl+C in the window running npm start — then run this again.');
  }
}

// --- 2. the safety net, before anything else ------------------------------------------------
const dataDir = join(root, 'data');
let backupName = null;
if (existsSync(dataDir) && readdirSync(dataDir).length > 0) {
  backupName = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  if (checkOnly) {
    log('backup', 'would copy data/ to data-backups/' + backupName + '/');
  } else {
    const target = join(root, 'data-backups', backupName);
    mkdirSync(target, { recursive: true });
    cpSync(dataDir, target, { recursive: true });
    log('backup', 'data/ copied to data-backups/' + backupName + '/');
  }
} else {
  log('backup', 'data/ is empty or absent; nothing to back up');
}
log('backup', 'runs/ is not copied: it is large, and a pull cannot touch it either — both are in .gitignore');

// --- 3. what is waiting ----------------------------------------------------------------------
if (!git('fetch', '--quiet').ok) die('could not reach the remote.', 'Check the network, or the credentials for the remote.');

const upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
if (!upstream.ok) die('branch ' + branch + ' is not tracking anything on the remote.', 'Set it with: git branch --set-upstream-to=origin/' + branch);

const incoming = git('log', '--oneline', 'HEAD..' + upstream.out).out;
const ahead = git('log', '--oneline', upstream.out + '..HEAD').out;
if (ahead) {
  log('update', 'this checkout has ' + ahead.split('\n').length + ' commit(s) the remote does not:');
  for (const line of ahead.split('\n')) log('update', '    ' + line);
  log('update', 'they are kept; push them when you are ready');
}
if (!incoming) {
  log('update', 'already up to date with the remote');
} else {
  log('update', incoming.split('\n').length + ' commit(s) to bring in:');
  for (const line of incoming.split('\n').slice(0, 20)) log('update', '    ' + line);
}

// --- 4. local edits to tracked files ----------------------------------------------------------
const dirty = git('status', '--porcelain', '--untracked-files=no').raw;
if (dirty.trim()) {
  // Two status columns, one space, then the path — and a rename arrives as "old -> new".
  const files = dirty
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.slice(3).replace(/^.* -> /, ''));
  log('local', files.length + ' tracked file(s) differ from the last commit here:');
  for (const f of files.slice(0, 20)) log('local', '    ' + f);
  if (checkOnly) {
    log('local', 'they would be put aside in a named git stash, and the command to bring them back printed');
  } else {
    const label = 'before update ' + new Date().toISOString().slice(0, 16);
    if (!git('stash', 'push', '--message', label).ok) die('could not put the local changes aside.', 'Deal with them by hand, then run this again.');
    log('local', 'put aside as a stash called "' + label + '"');
    log('local', 'bring them back with:  git stash pop');
  }
} else {
  log('local', 'no local edits to tracked files');
}

if (checkOnly) {
  log('update', 'checked only; nothing was changed');
  process.exit(0);
}

// --- 5. the pull itself ------------------------------------------------------------------------
/*
 * Fast-forward only, on purpose. A merge here would be a merge nobody asked for, made by a
 * script, in a checkout somebody is about to run the bot from. If the two histories have really
 * diverged, that is a decision for a person with the log in front of them.
 */
const before = git('rev-parse', 'HEAD').out;
if (incoming) {
  if (!git('pull', '--ff-only').ok) {
    die('the pull could not fast-forward.', 'This checkout and the remote have both moved. Look with: git log --oneline --graph --all -20');
  }
  log('update', 'now at ' + git('log', '--oneline', '-1').out);
}

/** What the pull actually changed, so the slow steps can be skipped when they would do nothing. */
const changed = incoming ? git('diff', '--name-only', before, 'HEAD').raw.split(/\r?\n/).filter(Boolean) : [];
const depsChanged = changed.some((f) => /(^|\/)package(-lock)?\.json$/.test(f));

// --- 6. dependencies and the build --------------------------------------------------------------
/*
 * Skipped when nothing came in, because then there is nothing to install or build and the two
 * of them are the slow half of this. `--rebuild` forces them, for the case where the checkout is
 * current but something about it is not: a `dist/` from a half-finished build, a `node_modules`
 * someone deleted.
 */
if (!incoming && !process.argv.includes('--rebuild')) {
  log('update', 'nothing came in, so nothing was installed or rebuilt');
  log('update', 'force it with:  npm run update -- --rebuild');
  log('update', 'start it with:  npm start');
  process.exit(0);
}

/*
 * `npm ci` when the dependencies moved, and nothing at all when they did not.
 *
 * `npm install` is the friendlier command and the wrong one here, for the reason this script
 * exists: it is allowed to rewrite `package-lock.json`, and a rewritten lockfile is a tracked
 * file that now differs from the commit — so the next update reports a local change nobody made
 * and puts it in a stash. `npm ci` installs exactly what the lockfile says and never edits it.
 * It is slower, because it empties `node_modules` first; that only matters on the rare pull that
 * actually moves a dependency, and this skips it entirely on the ones that do not.
 */
if (!depsChanged && incoming && !process.argv.includes('--rebuild')) {
  log('install', 'no dependency changed in what came in; nothing to install');
} else {
  log('install', 'npm ci');
  if (!run(NPM, ['ci'], { stdio: 'inherit' }).ok) {
    die('npm ci failed; the checkout is updated but not usable yet.', 'If it complains that the lockfile is out of step, run: npm install');
  }
}

/*
 * The build is not optional, and skipping it is the mistake that looks like a bug in the new
 * code. `npm start` does build — but anything that reads `dist/` before that does not:
 * `npm run api:start`, a process still up from before, a request against a port that never went
 * down. All of them quietly answer with the previous version.
 */
log('build', 'npm run build');
if (!run(NPM, ['run', 'build'], { stdio: 'inherit' }).ok) {
  die('the build failed. The update is in place; the error above is in the new code.');
}

log('update', 'done');
if (backupName) log('update', 'your data is untouched, and there is a copy at data-backups/' + backupName + '/');
log('update', 'start it with:  npm start');
