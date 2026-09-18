#!/usr/bin/env node
/**
 * `cop` — the command line.
 *
 *   cop login                 sign in once; the Edge profile is reused afterwards
 *   cop doctor [run.yaml]     check the machine before trusting a run to it
 *   cop mirror <run.yaml>     refresh the Desktop folder without touching the chat
 *   cop run <run.yaml>        the loop
 *   cop chat                  print the last run's conversation link
 */
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { loadConfig, expandPath } from './config/schema.js';
import { CopilotTransport } from './transport/copilotTransport.js';
import { runLoop, reopenLastChat } from './orchestrator/machine.js';
import { mirrorProject, describeMirror, listSelectableDirs } from './context/projectMirror.js';
import { defaultExportDir, desktopIsSynced, resolveDesktopDir } from './context/contextFiles.js';
import { Url } from './transport/locators.js';
import { findEdgeUsingProfile } from './transport/profileLock.js';

const program = new Command();
program
  .name('cop')
  .description('Runs a task loop with Microsoft 365 Copilot on a Windows machine.')
  .version('0.1.0');

const DEFAULT_PROFILE = expandPath('~/AppData/Local/copilot-operator/edge-profile', process.cwd());

program
  .command('login')
  .description('open Edge with the bot profile and wait for you to sign in')
  .option('-p, --profile <dir>', 'profile directory', DEFAULT_PROFILE)
  .option('--url <url>', 'chat url', Url.chat)
  .action(async (opts: { profile: string; url: string }) => {
    const transport = new CopilotTransport({
      profileDir: opts.profile,
      downloadsDir: join(opts.profile, '_downloads'),
      chatUrl: opts.url,
      channel: 'msedge',
      headless: false,
      replyTimeoutMs: 60_000,
      signInTimeoutMs: 15 * 60_000,
      humanWaitMs: 15 * 60_000,
      onEvent: (e) => process.stdout.write(`  ${e}\n`),
    });
    await transport.open();
    console.log('Sign in to Microsoft 365 Copilot in the Edge window that just opened.');
    console.log('If a human-verification box appears, complete it yourself; the bot will not.');
    console.log('The bot never types credentials. Waiting for the chat to appear...');
    await transport.ensureSignedIn();
    console.log(`Signed in to Microsoft 365 Copilot. The profile is saved at ${opts.profile}`);
    await transport.close();
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
        `${desktopIsSynced() ? '' : ' — the mirror folder will stay on this machine only'}`,
    );

    if (configPath) {
      try {
        const cfg = await loadConfig(configPath);
        say(true, `config ${cfg.configPath} parsed`);
        say(existsSync(cfg.resolved.cwd), `working directory ${cfg.resolved.cwd}`);
        const profileExists = existsSync(cfg.resolved.profileDir);
        console.log(
          `  ${profileExists ? 'ok  ' : 'note'}  browser profile ${cfg.resolved.profileDir}` +
            `${profileExists ? '' : ' — run "cop login" first'}`,
        );
        if (cfg.projectMirror.enabled) {
          say(existsSync(cfg.resolved.mirrorRootDir as string), `project root ${cfg.resolved.mirrorRootDir}`);
        }
      } catch (e) {
        say(false, (e as Error).message);
      }
    }

    console.log('');
    console.log(problems.length === 0 ? 'Ready.' : `${problems.length} problem(s) to fix first.`);
    process.exitCode = problems.length === 0 ? 0 : 1;
  });

program
  .command('dirs')
  .description('list the directories of a project that can be selected for the mirror')
  .argument('<projectRoot>')
  .action(async (root: string) => {
    const dirs = await listSelectableDirs(root);
    if (dirs.length === 0) console.log('(no selectable directories found)');
    for (const d of dirs) console.log(d);
  });

program
  .command('mirror')
  .description('refresh the Desktop folder from the project, without touching the chat')
  .argument('<config>', 'path to run.yaml')
  .action(async (configPath: string) => {
    const cfg = await loadConfig(configPath);
    if (!cfg.projectMirror.enabled) {
      console.log('projectMirror.enabled is false in this config; nothing to do.');
      return;
    }
    const targetDir = cfg.resolved.mirrorTargetDir ?? defaultExportDir();
    await mkdir(targetDir, { recursive: true });
    const result = await mirrorProject({
      rootDir: cfg.resolved.mirrorRootDir as string,
      includeDirs: cfg.projectMirror.includeDirs,
      excludeDirs: cfg.projectMirror.excludeDirs,
      targetDir,
      separator: cfg.projectMirror.separator,
      txtMode: cfg.projectMirror.txtMode,
      respectGitignore: cfg.projectMirror.respectGitignore,
      ignoreDirs: cfg.projectMirror.ignoreDirs,
      includeEnvFiles: cfg.projectMirror.includeEnvFiles,
      maxFileBytes: cfg.projectMirror.maxFileBytes,
    });
    console.log(`${targetDir}`);
    console.log(describeMirror(result));
    for (const s of result.skipped) console.log(`  skipped ${s.relPath}: ${s.reason}`);
    if (!desktopIsSynced()) {
      console.log('note: the Desktop is not backed up by OneDrive, so these copies stay local.');
    }
  });

program
  .command('run')
  .description('run the Copilot loop')
  .argument('<config>', 'path to run.yaml')
  .option('--unattended', 'do not ask before each step (dangerous)')
  .action(async (configPath: string, opts: { unattended?: boolean }) => {
    const cfg = await loadConfig(configPath);
    if (opts.unattended) cfg.execution.mode = 'unattended';

    if (cfg.execution.mode === 'unattended') {
      console.log('UNATTENDED: commands written by Copilot will run without asking.');
    }
    const outcome = await runLoop(cfg);
    console.log('');
    console.log(`run ${outcome.runId}: ${outcome.status} after ${outcome.iterations} iteration(s)`);
    if (outcome.reason) console.log(outcome.reason);
    if (outcome.chat) console.log(`chat: ${outcome.chat.name} — ${outcome.chat.url}`);
    process.exitCode = outcome.status === 'done' ? 0 : 1;
  });

program
  .command('chat')
  .description("print the last run's conversation")
  .argument('[config]', 'path to run.yaml', 'run.yaml')
  .action(async (configPath: string) => {
    const cfg = await loadConfig(configPath);
    const pointer = await reopenLastChat(cfg);
    if (!pointer) {
      console.log('No chat has been recorded yet.');
      return;
    }
    console.log(`${pointer.name}\n${pointer.url}\nrun ${pointer.runId}, created ${pointer.createdAt}`);
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
