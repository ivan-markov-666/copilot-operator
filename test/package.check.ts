/**
 * Installed from npm as a project's dev dependency, the bot finds its own files, keeps its records
 * in the project, serves its interface itself, and refuses a step that reaches for any of it.
 *
 * Three things change when the code moves from a clone into `<project>/node_modules`, and each is
 * held here: where things are (`config/layout.ts`), how the page gets the API's token when the API
 * serves the page (`api/security.ts`), and the fact that the bot is now inside the folders its own
 * steps may write (`exec/network.ts`).
 *
 *   npm run check:package
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLayout, HOME_FOLDER } from '../src/config/layout.js';
import { judgeRequest, presentedToken, tokenCookie, isInterfacePath } from '../src/api/security.js';
import { botSelfRefusal } from '../src/exec/network.js';

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

  const inPackage = installLayout({}, join(project, 'somewhere'), pkg); // started from inside the project
  check('inside node_modules is a package install', inPackage.mode, 'package');
  check('the project is the folder holding node_modules', inPackage.projectRoot, project);
  check('records go to the project', inPackage.dataDir, join(project, HOME_FOLDER, 'data'));
  check('runs too', inPackage.runsDir, join(project, HOME_FOLDER, 'runs'));
  check('prompts come from the package', inPackage.promptsDir, join(pkg, 'prompts'));
  check('the shipped interface is found', inPackage.webDir, join(pkg, 'dist', 'web'));

  const scoped = join(project, 'node_modules', '@acme', 'copilot-operator');
  mkdirSync(scoped, { recursive: true });
  check('a scoped install finds the same project', installLayout({}, project, scoped).projectRoot, project);
  check('COP_PROJECT_ROOT still wins', installLayout({ COP_PROJECT_ROOT: base }, base, pkg).projectRoot, base);

  // A global install: the code sits in npm's own node_modules, and `cop start` is run in the
  // project. Found on 2026-09-28: the project used to come out as npm's global folder.
  const globalPkg = join(base, 'AppData', 'Roaming', 'npm', 'node_modules', 'copilot-operator');
  mkdirSync(globalPkg, { recursive: true });
  const pw = join(base, 'playwright-tests');
  const global = installLayout({}, pw, globalPkg);
  check('a global install serves the folder it is started from', global.projectRoot, pw);
  check('and keeps its records there', global.dataDir, join(pw, HOME_FOLDER, 'data'));
  check('still a package install (prompts and interface from the package)', [global.mode, global.promptsDir], ['package', join(globalPkg, 'prompts')]);

  const clone = join(base, 'automate-365');
  mkdirSync(clone, { recursive: true });
  const checkout = installLayout({}, clone, clone);
  check('a clone is a checkout', checkout.mode, 'checkout');
  check('whose records stay beside it', checkout.dataDir, join(clone, 'data'));
  check('and has no shipped interface', checkout.webDir, null);
  rmSync(base, { recursive: true, force: true });
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
