/**
 * The run configuration: `run.yaml`.
 *
 * Everything the bot does for one run comes from here. Defaults are chosen so that a
 * minimal file (a project root, a task and nothing else) already produces a safe run:
 * confirm mode on, env files excluded, destructive commands denied.
 */
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Expands a leading `~` and resolves relative paths against the config file's folder. */
export function expandPath(p: string, baseDir: string): string {
  const expanded = p.startsWith('~') ? join(homedir(), p.slice(1).replace(/^[\\/]/, '')) : p;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

const OpeningMessage = z.union([
  z.object({ text: z.string().min(1) }),
  z.object({ file: z.string().min(1) }),
]);

export const RunConfigSchema = z.object({
  copilot: z
    .object({
      url: z.string().default('https://m365.cloud.microsoft/chat'),
      profileDir: z.string().default('~/AppData/Local/copilot-operator/edge-profile'),
      /** Chromium channel. `msedge` uses the installed Edge. */
      channel: z.enum(['msedge', 'chrome', 'chromium']).default('msedge'),
      /** Word that ends the loop when Copilot writes it. */
      stopMarker: z.string().default('Край'),
      /** Short label that goes into the chat name. */
      label: z.string().default('run'),
      /** How long to wait for one reply to finish streaming. */
      replyTimeoutSec: z.number().int().positive().default(900),
      /** How long to wait for the human to sign in. */
      signInTimeoutSec: z.number().int().positive().default(900),
      /** How long to wait for a human to clear a verification challenge. */
      humanWaitSec: z.number().int().positive().default(900),
      headless: z.boolean().default(false),
    })
    .prefault({}),

  openingMessages: z.array(OpeningMessage).min(1),

  execution: z
    .object({
      mode: z.enum(['confirm', 'unattended']).default('confirm'),
      defaultShell: z.enum(['pwsh', 'powershell', 'cmd']).default('pwsh'),
      cwd: z.string().default('.'),
      commandTimeoutSec: z.number().int().positive().default(300),
      idleTimeoutSec: z.number().int().positive().default(60),
      longCommandTimeoutSec: z.number().int().positive().default(14_400),
      longIdleTimeoutSec: z.number().int().positive().default(900),
      /** Ceiling on whatever Copilot asks for. */
      maxStepTimeoutSec: z.number().int().positive().default(28_800),
      stopOnFailure: z.boolean().default(false),
      allowedScriptExtensions: z.array(z.string()).default(['.ps1', '.cmd', '.bat']),
      denyPatterns: z
        .array(z.string())
        .default([
          'Remove-Item[^|]*-Recurse',
          '\\bformat\\s+[a-zA-Z]:',
          '\\breg\\s+(add|delete)\\b',
          'Stop-Computer|Restart-Computer|shutdown\\b',
          'Set-ExecutionPolicy\\s+Unrestricted',
          'diskpart|bcdedit|vssadmin',
          'Disable-WindowsOptionalFeature',
          'net\\s+user\\s+\\w+\\s+/add',
        ]),
    })
    .prefault({}),

  report: z
    .object({
      fileName: z.string().default('iteration-{n}.txt'),
      maxReportBytes: z.number().int().positive().default(8 * 1024 * 1024),
      maxOutputChars: z.number().int().positive().default(200_000),
      uploadRetries: z.number().int().nonnegative().default(2),
      /** Regexes replaced with [REDACTED] before the report leaves the machine. */
      redactPatterns: z.array(z.string()).default([]),
    })
    .prefault({}),

  projectMirror: z
    .object({
      enabled: z.boolean().default(false),
      rootDir: z.string().optional(),
      includeDirs: z.array(z.string()).default([]),
      excludeDirs: z.array(z.string()).default([]),
      targetDir: z.string().optional(),
      separator: z.string().default('--'),
      txtMode: z.enum(['append', 'replace', 'none']).default('append'),
      respectGitignore: z.boolean().default(true),
      ignoreDirs: z.array(z.string()).default([]),
      includeEnvFiles: z.boolean().default(false),
      maxFileBytes: z.number().int().positive().default(2 * 1024 * 1024),
      /** Attach the mirrored files to the first message of the run. */
      attachToFirstMessage: z.boolean().default(true),
      maxAttachedFiles: z.number().int().positive().default(20),
    })
    .prefault({}),

  pacing: z
    .object({
      enabled: z.boolean().default(true),
      settleMs: z.number().int().nonnegative().default(1000),
      maxMessagesPerHour: z.number().int().positive().default(60),
    })
    .prefault({}),

  limits: z
    .object({
      maxIterations: z.number().int().positive().default(30),
      maxRunMinutes: z.number().int().positive().default(120),
      maxFormatRetries: z.number().int().nonnegative().default(2),
      maxMessageChars: z.number().int().positive().default(100_000),
    })
    .prefault({}),

  runsDir: z.string().default('./runs'),
});

export type RunConfig = z.infer<typeof RunConfigSchema>;

/** A config with every path already absolute, which is what the rest of the code wants. */
export type ResolvedConfig = RunConfig & {
  configPath: string;
  baseDir: string;
  resolved: {
    profileDir: string;
    cwd: string;
    runsDir: string;
    mirrorRootDir?: string;
    mirrorTargetDir?: string;
    openingMessages: string[];
  };
};

export async function loadConfig(configPath: string): Promise<ResolvedConfig> {
  const abs = resolve(configPath);
  const raw = await readFile(abs, 'utf8');
  const parsed = RunConfigSchema.safeParse(parseYaml(raw));

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`${abs} is not a valid run config:\n${issues}`);
  }

  const cfg = parsed.data;
  const baseDir = dirname(abs);

  const openingMessages: string[] = [];
  for (const m of cfg.openingMessages) {
    if ('text' in m) openingMessages.push(m.text);
    else openingMessages.push(await readFile(expandPath(m.file, baseDir), 'utf8'));
  }

  if (cfg.projectMirror.enabled) {
    if (!cfg.projectMirror.rootDir) {
      throw new Error('projectMirror.enabled is true but projectMirror.rootDir is missing.');
    }
    if (cfg.projectMirror.includeDirs.length === 0) {
      throw new Error(
        'projectMirror.enabled is true but includeDirs is empty, so nothing would be copied. ' +
          'List the directories to include, or use ["."] for the whole project.',
      );
    }
  }

  return {
    ...cfg,
    configPath: abs,
    baseDir,
    resolved: {
      profileDir: expandPath(cfg.copilot.profileDir, baseDir),
      cwd: expandPath(cfg.execution.cwd, baseDir),
      runsDir: expandPath(cfg.runsDir, baseDir),
      mirrorRootDir: cfg.projectMirror.rootDir
        ? expandPath(cfg.projectMirror.rootDir, baseDir)
        : undefined,
      mirrorTargetDir: cfg.projectMirror.targetDir
        ? expandPath(cfg.projectMirror.targetDir, baseDir)
        : undefined,
      openingMessages,
    },
  };
}
