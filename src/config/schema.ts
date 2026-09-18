/**
 * The run configuration: `run.yaml` for the terminal, `data/settings.json` for the API.
 *
 * Both are the same shape. Defaults are chosen so that a minimal file (a task and nothing
 * else) already produces a safe run: confirm mode on, env files excluded, destructive
 * commands denied.
 */
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Expands a leading `~` and resolves relative paths against a base directory. */
export function expandPath(p: string, baseDir: string): string {
  const expanded = p.startsWith('~') ? join(homedir(), p.slice(1).replace(/^[\\/]/, '')) : p;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

/** Text given inline or as a file path. */
const TextOrFile = z.union([z.string(), z.object({ file: z.string().min(1) })]);

export const RunConfigSchema = z.object({
  copilot: z
    .object({
      url: z.string().default('https://m365.cloud.microsoft/chat'),
      profileDir: z.string().default('~/AppData/Local/copilot-operator/edge-profile'),
      channel: z.enum(['msedge', 'chrome', 'chromium']).default('msedge'),
      /** Word that ends a task when Copilot writes it. */
      stopMarker: z.string().default('Край'),
      /** Short label; becomes the session name when run from the terminal. */
      label: z.string().default('run'),
      replyTimeoutSec: z.number().int().positive().default(900),
      signInTimeoutSec: z.number().int().positive().default(900),
      humanWaitSec: z.number().int().positive().default(900),
      headless: z.boolean().default(false),
    })
    .prefault({}),

  /** Level 1: the contract with the runner. Shipped with the project; editable in the UI. */
  level1File: z.string().default('prompts/level1.md'),
  /** Level 2: the user's project, domain and team instructions for this task. */
  level2: TextOrFile.optional(),
  /** The task. Required for a terminal run; the API supplies it per task. */
  task: TextOrFile.optional(),

  execution: z
    .object({
      mode: z.enum(['confirm', 'unattended']).default('confirm'),
      defaultShell: z.enum(['pwsh', 'powershell', 'cmd']).default('pwsh'),
      cwd: z.string().default('.'),
      commandTimeoutSec: z.number().int().positive().default(300),
      idleTimeoutSec: z.number().int().positive().default(60),
      longCommandTimeoutSec: z.number().int().positive().default(14_400),
      longIdleTimeoutSec: z.number().int().positive().default(900),
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
      redactPatterns: z.array(z.string()).default([]),
    })
    .prefault({}),

  /**
   * Defaults for the project mirror. Which project and which directories is a property of a
   * session; these are the mechanics shared by all of them.
   */
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
  /** Sessions, level-2 presets and the edited level-1 contract live here. */
  dataDir: z.string().default('./data'),
});

export type RunConfig = z.infer<typeof RunConfigSchema>;

export type ResolvedConfig = RunConfig & {
  configPath: string;
  baseDir: string;
  resolved: {
    profileDir: string;
    cwd: string;
    runsDir: string;
    dataDir: string;
    level1Path: string;
    level2Text: string;
    taskText: string;
    mirrorRootDir?: string;
    mirrorTargetDir?: string;
  };
};

async function textOf(value: z.infer<typeof TextOrFile> | undefined, baseDir: string): Promise<string> {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return await readFile(expandPath(value.file, baseDir), 'utf8');
}

/** Turns parsed config plus a base directory into absolute paths and loaded texts. */
export async function resolveConfig(cfg: RunConfig, configPath: string, baseDir: string): Promise<ResolvedConfig> {
  if (cfg.projectMirror.enabled) {
    if (!cfg.projectMirror.rootDir) throw new Error('projectMirror.enabled is true but projectMirror.rootDir is missing.');
    if (cfg.projectMirror.includeDirs.length === 0) {
      throw new Error(
        'projectMirror.enabled is true but includeDirs is empty, so nothing would be copied. ' +
          'List the directories to include, or use ["."] for the whole project.',
      );
    }
  }
  return {
    ...cfg,
    configPath,
    baseDir,
    resolved: {
      profileDir: expandPath(cfg.copilot.profileDir, baseDir),
      cwd: expandPath(cfg.execution.cwd, baseDir),
      runsDir: expandPath(cfg.runsDir, baseDir),
      dataDir: expandPath(cfg.dataDir, baseDir),
      level1Path: expandPath(cfg.level1File, baseDir),
      level2Text: await textOf(cfg.level2, baseDir),
      taskText: await textOf(cfg.task, baseDir),
      mirrorRootDir: cfg.projectMirror.rootDir ? expandPath(cfg.projectMirror.rootDir, baseDir) : undefined,
      mirrorTargetDir: cfg.projectMirror.targetDir ? expandPath(cfg.projectMirror.targetDir, baseDir) : undefined,
    },
  };
}

function formatIssues(issues: z.ZodIssue[]): string {
  return issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

/** Loads a YAML run config from disk. */
export async function loadConfig(configPath: string): Promise<ResolvedConfig> {
  const abs = resolve(configPath);
  const raw = await readFile(abs, 'utf8');
  const parsed = RunConfigSchema.safeParse(parseYaml(raw) ?? {});
  if (!parsed.success) throw new Error(`${abs} is not a valid run config:\n${formatIssues(parsed.error.issues)}`);
  return await resolveConfig(parsed.data, abs, dirname(abs));
}

/** Loads settings from a plain object, as the API does from `data/settings.json`. */
export async function loadConfigObject(value: unknown, baseDir: string, label = 'settings'): Promise<ResolvedConfig> {
  const parsed = RunConfigSchema.safeParse(value ?? {});
  if (!parsed.success) throw new Error(`${label} is not valid:\n${formatIssues(parsed.error.issues)}`);
  return await resolveConfig(parsed.data, label, baseDir);
}
