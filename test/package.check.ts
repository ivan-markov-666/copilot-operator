/**
 * Installed from npm as a project's dev dependency, the bot finds its own files, keeps its records
 * in its own folder (not the project's, since 2026-10-22), serves its interface itself, and refuses
 * a step that reaches for any of it.
 *
 * Three things change when the code moves from a clone into `<project>/node_modules`, and each is
 * held here: where things are (`config/layout.ts`), how the page gets the API's token when the API
 * serves the page (`api/security.ts`), and the fact that the bot is now inside the folders its own
 * steps may write (`exec/network.ts`).
 *
 *   npm run check:package
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chosenHome, defaultHome, installLayout, HOME_CHOICE_FILE, HOME_FOLDER } from '../src/config/layout.js';
import { chooseHome, homeRefusal, moveLegacyHome, movedFrom } from '../src/config/home.js';
import { judgeRequest, presentedToken, tokenCookie, isInterfacePath } from '../src/api/security.js';
import { botSelfRefusal } from '../src/exec/network.js';
import { profileHolder, profileLockOwner } from '../src/transport/profileLock.js';

let wrong = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) wrong += 1;
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

console.log('--- where things are ---');
{
  const base = mkdtempSync(join(tmpdir(), 'cop-layout-'));
  const project = join(base, 'my-app');
  const pkg = join(project, 'node_modules', 'copilot-operator');
  mkdirSync(join(pkg, 'dist', 'web'), { recursive: true });
  writeFileSync(join(pkg, 'dist', 'web', 'index.html'), '<html></html>', 'utf8');

  // The user's local application data, as Windows names it: never the real one in a check.
  const env = { LOCALAPPDATA: join(base, 'AppData', 'Local') };
  const home = join(env.LOCALAPPDATA, 'copilot-operator');
  const inPackage = installLayout(env, join(project, 'somewhere'), pkg); // started from inside the project
  check('inside node_modules is a package install', inPackage.mode, 'package');
  check('the project is the folder holding node_modules', inPackage.projectRoot, project);
  // Operator, 2026-10-22: "no .copilot-operator folder in the project's folder unless the user set it there".
  check("records go to the bot's own folder, in the local application data", [inPackage.homeDir, inPackage.homeFrom], [home, 'default']);
  check('its data and runs are in it', [inPackage.dataDir, inPackage.runsDir], [join(home, 'data'), join(home, 'runs')]);
  check('the folder it used to keep in the project is known, to move from', inPackage.legacyHomeDir, join(project, HOME_FOLDER));
  check('prompts come from the package', inPackage.promptsDir, join(pkg, 'prompts'));
  check('the shipped interface is found', inPackage.webDir, join(pkg, 'dist', 'web'));

  const scoped = join(project, 'node_modules', '@acme', 'copilot-operator');
  mkdirSync(scoped, { recursive: true });
  check('a scoped install finds the same project', installLayout(env, project, scoped).projectRoot, project);
  check('COP_PROJECT_ROOT still wins', installLayout({ ...env, COP_PROJECT_ROOT: base }, base, pkg).projectRoot, base);

  // A global install: the code sits in npm's own node_modules, and `cop start` is run in the
  // project. Found on 2026-09-28: the project used to come out as npm's global folder.
  const globalPkg = join(base, 'AppData', 'Roaming', 'npm', 'node_modules', 'copilot-operator');
  mkdirSync(globalPkg, { recursive: true });
  const pw = join(base, 'playwright-tests');
  const global = installLayout(env, pw, globalPkg);
  check('a global install serves the folder it is started from', global.projectRoot, pw);
  // Started from C:\, it kept everything in C:\.copilot-operator until 2026-10-22.
  check('and keeps its records in its own folder, not where it was started', global.dataDir, join(home, 'data'));
  check('still a package install (prompts and interface from the package)', [global.mode, global.promptsDir], ['package', join(globalPkg, 'prompts')]);

  // The folder the operator chose, read from the default folder's location.json; COP_HOME over it.
  const chosen = join(base, 'D', 'bot');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, HOME_CHOICE_FILE), JSON.stringify({ home: chosen }), 'utf8');
  const picked = installLayout(env, project, pkg);
  check('a chosen folder is used', [picked.homeDir, picked.homeFrom, picked.dataDir], [chosen, 'chosen', join(chosen, 'data')]);
  check('chosenHome reads it', chosenHome(env), chosen);
  const byEnv = installLayout({ ...env, COP_HOME: join(base, 'E') }, project, pkg);
  check('COP_HOME wins over the choice', [byEnv.homeDir, byEnv.homeFrom], [join(base, 'E'), 'env']);
  writeFileSync(join(home, HOME_CHOICE_FILE), JSON.stringify({ home: 'relative\\bot' }), 'utf8');
  check('a choice that is not a whole path is not used', installLayout(env, project, pkg).homeDir, home);
  rmSync(join(home, HOME_CHOICE_FILE), { force: true });
  check('without LOCALAPPDATA, the profile folder\'s AppData\\Local', defaultHome({ USERPROFILE: join(base, 'U') }), join(base, 'U', 'AppData', 'Local', 'copilot-operator'));

  const clone = join(base, 'automate-365');
  mkdirSync(clone, { recursive: true });
  const checkout = installLayout(env, clone, clone);
  check('a clone is a checkout', checkout.mode, 'checkout');
  check('whose records stay beside it', [checkout.dataDir, checkout.homeFrom], [join(clone, 'data'), 'checkout']);
  check('and has no shipped interface', checkout.webDir, null);
  rmSync(base, { recursive: true, force: true });
}

console.log("\n--- the bot's folder: moved out of the project once, chosen on the System page ---");
{
  const base = mkdtempSync(join(tmpdir(), 'cop-home-'));
  const env = { LOCALAPPDATA: join(base, 'Local') };
  const project = join(base, 'my-app');
  const pkg = join(project, 'node_modules', 'copilot-operator');
  mkdirSync(pkg, { recursive: true });
  const legacy = join(project, HOME_FOLDER);
  mkdirSync(join(legacy, 'data', 'sessions'), { recursive: true });
  writeFileSync(join(legacy, 'data', 'settings.json'), '{"execution":{"mode":"autonomous"}}', 'utf8');
  mkdirSync(join(legacy, 'runs', 'r1'), { recursive: true });
  writeFileSync(join(legacy, 'runs', 'r1', 'log.txt'), 'old run', 'utf8');

  const layout = installLayout(env, project, pkg);
  const moved = moveLegacyHome(layout, env);
  check('the records kept in the project are copied to the new folder', moved, { from: legacy, to: layout.homeDir });
  check('settings and runs with them', [readFileSync(join(layout.dataDir, 'settings.json'), 'utf8'), readFileSync(join(layout.runsDir, 'r1', 'log.txt'), 'utf8')], ['{"execution":{"mode":"autonomous"}}', 'old run']);
  check('the old folder is left for the operator to delete', existsSync(join(legacy, 'data', 'settings.json')), true);
  check('and the System page can say where they came from', [movedFrom(layout.homeDir)?.from, movedFrom(layout.homeDir)?.stillThere], [legacy, true]);
  writeFileSync(join(legacy, 'data', 'settings.json'), '{"changed":true}', 'utf8');
  check('only once: the next start finds records of its own and copies nothing', moveLegacyHome(installLayout(env, project, pkg), env), null);
  check('so nothing is overwritten', readFileSync(join(layout.dataDir, 'settings.json'), 'utf8'), '{"execution":{"mode":"autonomous"}}');
  check('not when COP_DATA_DIR places the data', moveLegacyHome(installLayout({ ...env, COP_DATA_DIR: join(base, 'x') }, project, pkg), { ...env, COP_DATA_DIR: join(base, 'x') }), null);

  // Refused: not a whole path, inside the program, inside the bot's folder now or holding it.
  check('a folder that is not a whole path is refused', homeRefusal('bot', layout) !== null, true);
  check('the program\'s own folder is refused', homeRefusal(join(pkg, 'records'), layout) !== null, true);
  check('any node_modules is refused', homeRefusal(join(base, 'other', 'node_modules', 'x'), layout) !== null, true);
  check('a folder inside the bot\'s folder is refused', homeRefusal(join(layout.homeDir, 'inner'), layout) !== null, true);
  check('a folder holding it is refused', homeRefusal(env.LOCALAPPDATA, layout) !== null, true);
  const elsewhere = join(base, 'D', 'bot');
  check('a folder of the operator\'s own is fine', homeRefusal(elsewhere, layout), null);

  // Chosen, with a copy: everything but the pointer; nothing the new folder has is overwritten.
  mkdirSync(join(layout.homeDir, 'edge-profile', 'Default'), { recursive: true });
  writeFileSync(join(layout.homeDir, 'edge-profile', 'Default', 'Cookies'), 'signed in', 'utf8');
  mkdirSync(join(elsewhere, 'runs'), { recursive: true });
  writeFileSync(join(elsewhere, 'runs', 'mine.txt'), 'theirs', 'utf8');
  const result = chooseHome(layout, elsewhere, true, env);
  check('choosing copies what the folder has', [result.home, result.copied.sort(), result.kept], [elsewhere, ['data', 'edge-profile'], ['runs']]);
  check('the Edge profile goes too, so the sign-in stays', readFileSync(join(elsewhere, 'edge-profile', 'Default', 'Cookies'), 'utf8'), 'signed in');
  check('what the new folder had is left as it was', [readFileSync(join(elsewhere, 'runs', 'mine.txt'), 'utf8'), existsSync(join(elsewhere, 'runs', 'r1'))], ['theirs', false]);
  check('neither the pointer nor the moved-from note is copied', [existsSync(join(elsewhere, HOME_CHOICE_FILE)), existsSync(join(elsewhere, 'moved-from.json'))], [false, false]);
  check('the choice is read at the next start', [chosenHome(env), installLayout(env, project, pkg).homeDir], [elsewhere, elsewhere]);
  check('the current folder is left as it was', existsSync(join(layout.dataDir, 'settings.json')), true);

  // Back to the default: the pointer goes.
  const next = installLayout(env, project, pkg);
  const back = chooseHome(next, null, false, env);
  check('back to the default removes the choice', [back.home, chosenHome(env), existsSync(join(defaultHome(env), HOME_CHOICE_FILE))], [defaultHome(env), null, false]);
  check('and copies nothing unless asked', back.copied, []);
  rmSync(base, { recursive: true, force: true });
}

console.log('\n--- whose Edge holds the profile ---');
{
  const api = 4242;
  // A browser is a main process and its children (renderers, GPU); its main process's parent started it.
  const own = [{ pid: 10, parentPid: api, commandLine: 'msedge --user-data-dir=x' }, { pid: 11, parentPid: 10, commandLine: 'msedge --type=renderer' }];
  check('nothing on it is free', profileHolder([], api), 'free');
  check('a failed look is unknown, never free', profileHolder('unknown', api), 'unknown');
  check("an Edge the bot's API started is its own: its run, or its chat window kept open", profileHolder(own, api), 'own');
  check('an Edge started by anything else is another', profileHolder([{ pid: 20, parentPid: 999, commandLine: 'msedge' }, { pid: 21, parentPid: 20, commandLine: 'msedge --type=gpu-process' }], api), 'other');
  check('its own and another together is another', profileHolder([...own, { pid: 30, parentPid: 1, commandLine: 'msedge' }], api), 'other');
  check('a process whose parent was not read is another', profileHolder([{ pid: 40, commandLine: 'msedge' }], api), 'other');
  // `cop doctor` reads the API from the lock it leaves on the profile.
  const dir = mkdtempSync(join(tmpdir(), 'cop-lock-'));
  writeFileSync(join(dir, '.cop-lock.json'), JSON.stringify({ pid: process.pid }), 'utf8');
  check('the lock names the live process holding it', profileLockOwner(dir), process.pid);
  writeFileSync(join(dir, '.cop-lock.json'), JSON.stringify({ pid: 2 ** 22 + 7 }), 'utf8');
  check('a lock left by a process that is gone names nobody', profileLockOwner(dir), null);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n--- the page gets the token without it ever being in a URL or a file ---');
{
  const opts = { token: 'a'.repeat(64), port: 4000, allowedOrigins: ['http://127.0.0.1:4000'], servesInterface: true };
  const page = (path: string, host = '127.0.0.1:4000') => judgeRequest({ path, headers: { host } }, opts);
  check('a page answers with no token', page('/import').ok, true);
  check('the root too', page('/').ok, true);
  check('but not to another host (rebinding)', page('/', 'evil.example:4000').ok, false);
  check('an API route still needs the token', page('/api/sessions').ok, false);
  check('the interface path test', [isInterfacePath('/sessions/view'), isInterfacePath('/api/x'), isInterfacePath('/api')], [true, false, false]);
  const cookie = tokenCookie(opts.token);
  check('the cookie is HttpOnly, SameSite=Strict, for /api only', /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) && /Path=\/api/.test(cookie), true);
  const fromCookie = presentedToken({ headers: { cookie: `x=1; ${cookie.split(';')[0]}` }, query: {} } as never);
  check('and a request carrying it is accepted', judgeRequest({ path: '/api/sessions', headers: { host: '127.0.0.1:4000', cookie: `cop_token=${opts.token}` } }, opts).ok, true);
  check('the token is read back from the cookie', fromCookie, opts.token);
  const notServing = { ...opts, servesInterface: false };
  check('a clone (no served interface) still wants a token for everything', judgeRequest({ path: '/import', headers: { host: '127.0.0.1:4000' } }, notServing).ok, false);
}

console.log('\n--- a step may not touch the bot it runs under ---');
{
  const gate = (cmd: string) => botSelfRefusal(cmd, [4000], 'C:\\nowhere') !== null;
  check('editing the package code', gate("Set-Content .\\node_modules\\copilot-operator\\prompts\\level1.md 'x'"), true);
  check('a scoped package path', gate('Get-ChildItem node_modules/@acme/copilot-operator'), true);
  check('the records folder', gate('Get-Content .copilot-operator\\data\\settings.json'), true);
  check('uninstalling the bot', gate('npm uninstall copilot-operator'), true);
  check('changing its version', gate('npm install -D copilot-operator@0.0.1'), true);
  check('ordinary installs are not', gate('npm install -D vitest'), false);
  check('another package whose name contains it is not', gate('npm install copilot-operator-helpers'), false);
  check('a file that merely mentions it is not a path to it', gate("Select-String -Path .\\README.md -Pattern 'copilot operator'"), false);
}

console.log(wrong === 0 ? '\nall good' : `\n${wrong} wrong`);
process.exit(wrong === 0 ? 0 : 1);
