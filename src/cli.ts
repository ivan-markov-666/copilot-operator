#!/usr/bin/env node
/**
 * `cop` — the command line.
 *
 *   cop login                 sign in once; the Edge profile is reused afterwards
 *   cop doctor [run.yaml]     check the machine before trusting a run to it
 *   cop run <run.yaml>        the loop
 *   cop chat                  print the last run's conversation link
 */
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { installLayout } from './config/layout.js';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { loadConfig, expandPath } from './config/schema.js';
import { CopilotTransport } from './transport/copilotTransport.js';
import { runSession } from './orchestrator/taskRunner.js';
import { SessionStore } from './session/store.js';
import { settingsOf, SettingsUnusableError } from './api/settings.js';
import { PolicyLockUnusableError } from './config/lockedPolicy.js';
import { EventBus } from './session/events.js';
import { terminalAuthorizer, unattendedAuthorizer } from './exec/authorizer.js';
import { unattendedPrecondition } from './exec/policy.js';
import { botRootDir, isOwnCheckout } from './exec/workDir.js';
import { desktopIsSynced, resolveDesktopDir } from './context/desktopDir.js';
import { Url } from './transport/locators.js';
import { botVersion } from './config/version.js';
import { findEdgeUsingProfile } from './transport/profileLock.js';
import { assessIsolation, readIsolationSignals, type IsolationClaim } from './exec/isolation.js';

/** The running version; see `config/version.ts`. */
const ownVersion = botVersion;

const program = new Command();
program
  .name('cop')
  .description('Runs a task loop with Microsoft 365 Copilot on a Windows machine.')
  .version(ownVersion());

const DEFAULT_PROFILE = expandPath('~/AppData/Local/copilot-operator/edge-profile', process.cwd());

program
  .command('start')
  .description(
    "start copilot-operator for this project on 127.0.0.1: the API, and the web interface the package ships (a clone's interface comes from npm start)",
  )
  .option('--port <port>', 'the port to listen on', '4000')
  .option('--open', 'open the interface in the default browser once it is up (an installed package; not in a clone)')
  .action(async (opts: { port: string; open?: boolean }) => {
    process.env.COP_API_PORT = String(Number(opts.port) || 4000);
    /*
     * A clone's API serves no web interface (see `installLayout`): its interface is the dev server
     * `npm start` runs, which builds the token into its page. So `cop start` in a clone is the API
     * alone, and it says so before anything else rather than leave the operator looking for a page;
     * and --open is not followed there, because the page it would open on this port answers a
     * browser with 401.
     */
    const clone = installLayout().mode === 'checkout';
    if (clone) {
      console.log("cop start in a clone of copilot-operator starts the API only: a clone's web interface comes from npm start, which runs the API and the interface together.");
      if (opts.open) {
        console.log('--open is not followed in a clone: this port serves no page there and would answer the browser with 401. npm run dev starts both and opens the interface.');
      }
    }
    // The API runs in this process; importing it starts it. See src/api/main.ts.
    await import('./api/main.js');
    if (opts.open && !clone) {
      const url = `http://127.0.0.1:${process.env.COP_API_PORT}/`;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const up = await fetch(`${url}api/health`).then((r) => r.ok).catch(() => false);
        if (up) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      // Explorer hands an address to the default browser; no shell, no `start`.
      spawn('explorer.exe', [url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    }
  });

program
  .command('logout')
  .description("sign the bot's browser profile out of Microsoft 365; the profile itself stays")
  .option('-p, --profile <dir>', 'profile directory', DEFAULT_PROFILE)
  .action(async (opts: { profile: string }) => {
    const transport = new CopilotTransport({
      profileDir: opts.profile,
      transportDir: join(opts.profile, '_transport'),
      chatUrl: 'https://m365.cloud.microsoft/chat',
      channel: 'msedge',
      headless: false,
      replyTimeoutMs: 60_000,
      signInTimeoutMs: 60_000,
      humanWaitMs: 60_000,
      onEvent: (e) => process.stdout.write(`  ${e}\n`),
    });
    await transport.open();
    try {
      await transport.signOut();
      console.log('Signed out. The profile folder is still there; `cop login --fresh` deletes it.');
    } finally {
      await transport.close();
    }
  });

program
  .command('login')
  .description('open Edge with the bot profile and wait for you to sign in')
  .option('-p, --profile <dir>', 'profile directory', DEFAULT_PROFILE)
  .option('--url <url>', 'chat url', Url.chat)
  .option(
    '-a, --account <upn>',
    'the account to sign in as, e.g. 155676@365kit.org. Signs out first and asks for this one.',
  )
  .option('--fresh', 'delete the bot profile first, so nothing is remembered from before')
  .action(async (opts: { profile: string; url: string; account?: string; fresh?: boolean }) => {
    if (opts.fresh) {
      if (existsSync(opts.profile)) {
        console.log(`This will delete the bot's browser profile:\n  ${opts.profile}`);
        console.log('It only contains the bot\'s own browser session. Your normal Edge is untouched.');
        const rl = createInterface({ input: stdin, output: stdout });
        const answer = (await rl.question('Delete it? [y/N] ')).trim().toLowerCase();
        rl.close();
        if (answer !== 'y' && answer !== 'yes') {
          console.log('Left it alone. Run without --fresh to keep the existing profile.');
          return;
        }
        await rm(opts.profile, { recursive: true, force: true });
        console.log('Profile deleted.');
      } else {
        console.log('No existing profile to delete.');
      }
    }

    const transport = new CopilotTransport({
      profileDir: opts.profile,
      transportDir: join(opts.profile, '_transport'),
      chatUrl: opts.url,
      channel: 'msedge',
      headless: false,
      replyTimeoutMs: 60_000,
      signInTimeoutMs: 15 * 60_000,
      humanWaitMs: 15 * 60_000,
      onEvent: (e) => process.stdout.write(`  ${e}\n`),
    });
    await transport.open();
    try {
      if (opts.account) {
        // Edge on a Windows machine will sign the profile in with whatever account the OS
        // knows, which is how the wrong user ends up in the chat without anyone choosing.
        // Signing out first, then asking for this specific account, is what stops that.
        console.log(`Signing out first, then asking for ${opts.account}.`);
        await transport.signOut();
        await transport.gotoChatAs(opts.account, opts.url);
      }
      console.log('Sign in to Microsoft 365 Copilot in the Edge window that just opened.');
      if (opts.account) {
        console.log(`Use ${opts.account}. If Edge offers a different account, choose`);
        console.log('"Use another account" and type this one.');
      }
      console.log('If a human-verification box appears, complete it yourself; the bot will not.');
      console.log('The bot never types credentials. Waiting for the chat to appear...');
      await transport.ensureSignedIn(opts.account ? undefined : opts.url);

      const accounts = await transport.findAccountsInPage();
      if (opts.account) {
        const wanted = opts.account.toLowerCase();
        const match = accounts.some((a) => a.toLowerCase() === wanted);
        if (match) {
          console.log(`Signed in as ${opts.account}.`);
        } else if (accounts.length > 0) {
          throw new Error(
            `Signed in, but not as ${opts.account}. The page shows: ${accounts.join(', ')}.\n` +
              'Run "cop login --account <upn> --fresh" to wipe the profile and start clean.',
          );
        } else {
          console.log(`Signed in. Could not read the account from the page, so ${opts.account} is unverified.`);
        }
      } else if (accounts.length > 0) {
        console.log(`Signed in. The page shows: ${accounts.join(', ')}`);
      }
      console.log(`Profile saved at ${opts.profile}`);
    } finally {
      // Always close. A left-open Edge keeps the profile locked, and the next run would
      // then fail with a message about a closed browser that explains nothing.
      await transport.close();
    }
  });

program
  .command('open')
  .description("open the bot's own browser and leave it to you, for testing by hand")
  .option('-p, --profile <dir>', 'profile directory', DEFAULT_PROFILE)
  .option('--url <url>', 'chat url', Url.chat)
  .action(async (opts: { profile: string; url: string }) => {
    const transport = new CopilotTransport({
      profileDir: opts.profile,
      transportDir: join(opts.profile, '_transport'),
      chatUrl: opts.url,
      channel: 'msedge',
      headless: false,
      replyTimeoutMs: 60_000,
      signInTimeoutMs: 15 * 60_000,
      humanWaitMs: 15 * 60_000,
      onEvent: (e, d) => process.stdout.write(`  ${e}${d && Object.keys(d).length ? ' ' + JSON.stringify(d) : ''}
`),
    });
    await transport.open();
    try {
      await transport.ensureSignedIn();
      const where = await transport.surface();
      console.log('');
      console.log("This is the bot's own browser. Nothing is automated from here.");
      console.log(`  profile : ${opts.profile}`);
      console.log(`  surface : ${where === 'work' ? 'Microsoft 365 Copilot (work)' : where}`);
      console.log('  windows : this profile has no extensions, so if you can see a Grammarly');
      console.log('            or similar icon, you are looking at a different Edge window.');
      console.log('');
      console.log('Type a long message here by hand and send it. That tells us whether the');
      console.log('chat treats the bot differently from you, in the same browser.');
      console.log('');
      const rl = createInterface({ input: stdin, output: stdout });
      await rl.question('Press Enter here when you are done, to close the browser... ');
      rl.close();
    } finally {
      await transport.close();
    }
  });

program
  .command('doctor')
  .description('check that this machine can run the bot')
  .argument('[config]', 'path to run.yaml')
  .action(async (configPath?: string) => {
    const problems: string[] = [];
    const say = (ok: boolean, text: string): void => {
      console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${text}`);
      if (!ok) problems.push(text);
    };

    const node = process.versions.node;
    say(Number(node.split('.')[0]) >= 20, `Node.js ${node} (20 or newer required)`);

    const edge = [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ].find((p) => existsSync(p));
    say(Boolean(edge), edge ? `Microsoft Edge at ${edge}` : 'Microsoft Edge not found');

    const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8',
    });
    const winps = spawnSync('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8',
    });
    say(
      pwsh.status === 0 || winps.status === 0,
      pwsh.status === 0
        ? `PowerShell 7 (${pwsh.stdout.trim()})`
        : winps.status === 0
          ? `Windows PowerShell (${winps.stdout.trim()}); pwsh not found`
          : 'no PowerShell found',
    );

    /*
     * The three things a machine that is not this one has failed on, or would.
     *
     * git: version control runs `git` from PATH for every task; a laptop with git only inside
     * an IDE has none there. npm: every plan's first task is `npm install`, and a corporate proxy
     * that is not configured for npm fails it with a message the chat model then spends an
     * iteration reading. Models: the picker's names belong to the tenant, so the defaults saved
     * here ("GPT 5.6 Think deeper") may not exist on another account — the run then goes on with
     * whatever the chat is set to, and says so in a warning nobody reads until the review turns
     * out to have run on the same model as the work.
     */
    const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
    say(git.status === 0, git.status === 0 ? git.stdout.trim() : 'git not found on PATH — version control cannot branch or commit');

    // One command string through the shell: on Windows npm is npm.cmd, which Node will not
    // spawn without a shell, and a shell with an args array is what Node deprecates.
    const registry = spawnSync('npm config get registry', { encoding: 'utf8', shell: true }).stdout?.trim() || '(unknown registry)';
    const ping = spawnSync('npm ping --fetch-timeout=15000 --fetch-retries=0', { encoding: 'utf8', timeout: 25_000, shell: true });
    say(
      ping.status === 0,
      ping.status === 0
        ? `npm reaches ${registry}`
        : `npm cannot reach ${registry} — behind a proxy, set it for npm (npm config set proxy / https-proxy) or HTTPS_PROXY; every plan starts with npm install`,
    );

    const layout = installLayout();
    const dataDir = layout.dataDir;
    const readJson = (file: string): Record<string, unknown> | null => {
      try {
        return JSON.parse(readFileSync(join(dataDir, file), 'utf8')) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    /*
     * The settings, read the way the API reads them: a file that is there and cannot be used is the
     * problem to report, since the API will not start on it, not a file to take for empty. Taken for
     * empty, doctor said "isolation: none" and "no default model is set" of a file that may say
     * otherwise, and never that it was broken. The checks below that read it wait until it is mended.
     *
     * Read by the API's own `Settings` and loaded as the API loads them before it opens its port,
     * which reads the policy locks too. Parsed and checked here on its own, the file was all doctor
     * looked at: a lock that did not parse stopped `npm start` while doctor said "Ready.".
     */
    const store = settingsOf(layout);
    let settings: Record<string, unknown> | null = null;
    try {
      const value = await store.raw();
      await store.load();
      settings = value;
    } catch (e) {
      if (e instanceof SettingsUnusableError) say(false, `${e.path} ${e.problem}; the API will not start until it is mended or deleted`);
      // Not the operator's to delete: an administrator placed it (see `PolicyLockUnusableError`).
      else if (e instanceof PolicyLockUnusableError) say(false, `${e.path} ${e.problem}; the API will not start until it is mended`);
      else say(false, `the settings in ${join(dataDir, 'settings.json')} could not be loaded (${(e as Error).message}); the API will not start until that is put right`);
    }

    if (settings) {
      /*
       * Where the bot is running, which is the only thing that actually contains a command once it
       * runs. Reported here rather than left to the README, because a machine that ignored the
       * recommendation looked exactly like one that had followed it. The claim is the operator's;
       * `doctor` only says what it can see and where the two disagree. See `exec/isolation.ts`.
       */
      const posture = assessIsolation(
        (settings.execution as { isolation?: IsolationClaim } | undefined)?.isolation ?? 'none',
        readIsolationSignals(),
      );
      say(
        posture.warnings.length === 0,
        `isolation: ${posture.claim}, running as ${posture.signals.user}${posture.signals.elevated === true ? ' (ELEVATED)' : ''}`,
      );
      for (const concern of posture.warnings) say(false, `  ${concern}`);
      const models = readJson('models.json') as { options?: Array<{ name: string }> } | null;
      const copilot = (settings.copilot as { defaultModel?: string; defaultReviewModel?: string } | undefined) ?? {};
      const wanted: Array<[string, string]> = [
        ['default model', (copilot.defaultModel ?? '').trim()],
        ['default review model', (copilot.defaultReviewModel ?? '').trim()],
      ].filter(([, name]) => name !== '') as Array<[string, string]>;
      if (wanted.length === 0) {
        console.log('  note  no default model is set; sessions leave the chat on whatever it shows');
      } else if (!models?.options?.length) {
        console.log(`  note  ${wanted.map(([w, n]) => `${w} "${n}"`).join(', ')} set, but the picker has never been read here — read it from the Settings page before trusting them`);
      } else {
        const names = new Set(models.options.map((o) => o.name));
        for (const [what, name] of wanted) {
          say(names.has(name), names.has(name) ? `${what} "${name}" is in the picker read on this machine` : `${what} "${name}" is not in the picker read on this machine (${models.options.length} option(s)) — the run would fall back to whatever the chat shows`);
        }
        if (wanted.length === 2 && wanted[0]![1] === wanted[1]![1]) {
          console.log('  note  the review runs on the same model as the work; a different one catches more');
        }
      }
    }

    const edgeUsers = findEdgeUsingProfile(DEFAULT_PROFILE);
    if (Array.isArray(edgeUsers) && edgeUsers.length > 0) {
      const pids = edgeUsers.map((u) => u.pid);
      say(
        false,
        `Edge is already running with the bot profile (${pids.length} process(es)). A run would ` +
          `fail with "Target page, context or browser has been closed". Close that Edge window, or:`,
      );
      console.log(`          Stop-Process -Id ${pids.join(',')} -Force`);
    } else if (edgeUsers === 'unknown') {
      console.log('  note  could not check whether Edge is holding the bot profile');
    } else {
      console.log('  ok    no Edge process is holding the bot profile');
    }

    const desktop = resolveDesktopDir();
    say(existsSync(desktop), `Desktop at ${desktop}`);
    console.log(
      `  ${desktopIsSynced() ? 'ok  ' : 'note'}  Desktop ${desktopIsSynced() ? 'is' : 'is NOT'} backed up by OneDrive` +
        `${desktopIsSynced() ? '' : ' — logs saved there stay on this machine only'}`,
    );

    if (configPath) {
      try {
        const cfg = await loadConfig(configPath);
        say(true, `config ${cfg.configPath} parsed`);
        // The configured cwd is only the fallback — a session's commands run in its project —
        // and this checkout is refused as a fallback, so say so here rather than at run time.
        const ownCwd = isOwnCheckout(cfg.resolved.cwd);
        say(
          existsSync(cfg.resolved.cwd) && !ownCwd,
          `fallback working directory ${cfg.resolved.cwd}` +
            (ownCwd ? " — this is the runner's own checkout; a session with no project folder will refuse to run" : ''),
        );
        const profileExists = existsSync(cfg.resolved.profileDir);
        console.log(
          `  ${profileExists ? 'ok  ' : 'note'}  browser profile ${cfg.resolved.profileDir}` +
            `${profileExists ? '' : ' — run "cop login" first'}`,
        );
      } catch (e) {
        say(false, (e as Error).message);
      }
    }

    console.log('');
    console.log(problems.length === 0 ? 'Ready.' : `${problems.length} problem(s) to fix first.`);
    process.exitCode = problems.length === 0 ? 0 : 1;
  });

program
  .command('models')
  .description('read the chat\'s model picker and print what it offers right now')
  .option('-p, --profile <dir>', 'profile directory', DEFAULT_PROFILE)
  .option('--url <url>', 'chat url', Url.chat)
  .option('--json', 'print the raw list, for pasting into an issue')
  .option('--set <name>', 'also switch the chat to this model, by its exact name')
  .option('--steps', 'with --set: print each step of the choice with its time, and keep a picture of each in runs/_models')
  .action(async (opts: { profile: string; url: string; json?: boolean; set?: string; steps?: boolean }) => {
    const transport = new CopilotTransport({
      profileDir: opts.profile,
      transportDir: join(installLayout().runsDir, '_models'),
      chatUrl: opts.url,
      channel: 'msedge',
      headless: false,
      replyTimeoutMs: 60_000,
      signInTimeoutMs: 900_000,
      // The time of each step, to the millisecond: the pauses between them are what is being looked at.
      onEvent: (e, d) => console.log(`  ${new Date().toISOString().slice(11, 23)} [${e}]${d ? ' ' + JSON.stringify(d) : ''}`),
      ...(opts.steps ? { modelStepShots: true } : {}),
    });

    try {
      await transport.open();
      await transport.ensureSignedIn();
      const { options, current, note } = await transport.listModels();

      if (opts.json) {
        console.log(JSON.stringify({ current, note, options }, null, 2));
      } else {
        console.log(`\ncurrently on: ${current ?? '(the picker did not say)'}`);
        if (note) console.log(note);
        if (options.length === 0) console.log('(no options could be read from the picker)');
        for (const o of options) {
          const marks = [o.selected ? 'selected' : '', o.disabled ? 'unavailable' : ''].filter(Boolean).join(', ');
          const where = o.group ? `${o.group} > ` : '';
          console.log(`  - ${where}${o.name}${marks ? `  [${marks}]` : ''}`);
          const extra = o.raw.split('\n').slice(1).join(' ').trim();
          if (extra) console.log(`      ${extra.slice(0, 120)}`);
        }
      }

      if (opts.set) {
        const result = await transport.selectModel(opts.set);
        console.log(result.ok ? `switched to: ${result.current}` : `not switched: ${result.reason}`);
        // Said, because where this is depends on the folder the command was run from (2026-10-07: looked for in the wrong one).
        if (opts.steps) console.log(`pictures and the menu's HTML of each step: ${join(installLayout().runsDir, '_models')}`);
      }
    } finally {
      await transport.close();
    }
  });

program
  .command('run')
  .description('run one task from a run.yaml: creates a session, runs it, prints the summary')
  .argument('<config>', 'path to run.yaml')
  .option('--unattended', 'do not ask before each step (dangerous)')
  .action(async (configPath: string, opts: { unattended?: boolean }) => {
    const cfg = await loadConfig(configPath);
    if (opts.unattended) cfg.execution.mode = 'unattended';
    if (!cfg.resolved.taskText.trim()) {
      throw new Error(`${cfg.configPath} has no "task". Add one, inline or as { file: ... }.`);
    }
    if (cfg.execution.mode === 'unattended') {
      /*
       * Refused here rather than a hundred lines later as a run whose every step comes back
       * refused. The step gate holds the same rule; this is so the answer arrives before a browser
       * is opened, and names the setting to change. See `unattendedPrecondition`.
       */
      const blocked = unattendedPrecondition({
        mode: 'unattended',
        allowedPrograms: cfg.execution.allowedPrograms,
        isolation: cfg.execution.isolation,
      lockedToConfirm: cfg.policyLock?.maxMode === 'confirm',
      });
      if (blocked) throw new Error(`${blocked}\n\nOr drop --unattended and approve the steps as they come.`);
      console.log('UNATTENDED: commands written by Copilot will run without asking.');
    }

    const store = new SessionStore(cfg.resolved.dataDir, cfg.resolved.level1Path);
    await store.init();
    // No project folder of its own: its commands run in `execution.cwd`. See `workingDirFor`.
    const session = await store.createSession(cfg.copilot.label);
    await store.updateSession(session.id, (s) => {
      s.onFailure = cfg.execution.continueOnFailure ? 'continue' : 'stop';
    });
    const task = await store.addTask(session.id, {
      title: cfg.copilot.label,
      level2: cfg.resolved.level2Text,
      prompt: cfg.resolved.taskText,
    });

    const bus = new EventBus();
    // Task-level events are already printed by the run log; session-level ones are not.
    bus.subscribe(session.id, (e) => {
      if (!e.taskId && e.message) console.log(`  ${e.message}`);
    });

    const policy = {
      mode: cfg.execution.mode,
      denyPatterns: cfg.execution.denyPatterns,
      allowedPrograms: cfg.execution.allowedPrograms,
      isolation: cfg.execution.isolation,
      lockedToConfirm: cfg.policyLock?.maxMode === 'confirm',
      networkFetch: cfg.execution.networkFetch,
    };
    const authorizer =
      cfg.execution.mode === 'unattended'
        ? unattendedAuthorizer(policy)
        : terminalAuthorizer(policy, (line) => console.log(line));

    await runSession(session.id, { cfg, store, bus, authorizer });

    const final = await store.getSession(session.id);
    const done = final?.tasks.find((t) => t.id === task.id);
    console.log('');
    console.log(`task "${done?.title}": ${done?.status} after ${done?.iterations ?? 0} iteration(s)`);
    if (done?.summary) console.log(`
Summary:
${done.summary}`);
    if (done?.reason) console.log(`
Reason: ${done.reason}`);
    if (final?.chat) console.log(`
chat: ${final.chat.name} — ${final.chat.url}`);
    if (done?.runId) console.log(`log: ${join(cfg.resolved.runsDir, done.runId, 'task-log.txt')}`);
    process.exitCode = done?.status === 'done' ? 0 : 1;
  });

program
  .command('chat')
  .description("print the most recent session's conversation")
  .argument('[config]', 'path to run.yaml', 'run.yaml')
  .action(async (configPath: string) => {
    const cfg = await loadConfig(configPath);
    const store = new SessionStore(cfg.resolved.dataDir, cfg.resolved.level1Path);
    const sessions = await store.listSessions();
    const withChat = sessions.find((s) => s.chat);
    if (!withChat?.chat) {
      console.log('No session has a conversation yet.');
      return;
    }
    const c = withChat.chat;
    console.log(`${c.name}
${c.url}
session ${withChat.id}, ${withChat.tasks.length} task(s), created ${c.createdAt}`);
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
