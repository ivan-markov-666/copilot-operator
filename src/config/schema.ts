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
import { applyPolicyLock, readPolicyLock, type LockOutcome } from './lockedPolicy.js';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Expands a leading `~` and resolves relative paths against a base directory. */
export function expandPath(p: string, baseDir: string): string {
  const expanded = p.startsWith('~') ? join(homedir(), p.slice(1).replace(/^[\\/]/, '')) : p;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

/** Text given inline or as a file path. */
const TextOrFile = z.union([z.string(), z.object({ file: z.string().min(1) })]);

/*
 * GIT_WRITE_NOTE — why the deny list knows about git.
 *
 * Version control here is the runner's job: it cuts the branch before a task and makes the
 * commit after it, and level 1 tells Copilot in plain words that git is not its business. That
 * was prose, and prose is advice. It broke: a task with a badly written check — "nothing has
 * been pushed", tested by looking for the word origin in `git remote -v` — could not pass in a
 * repository that legitimately had a remote. The failure went back to the chat, Copilot spent
 * fifteen iterations proving the check was wrong, and then ran `git remote remove origin` to
 * make it pass. It did pass. The repository lost its remote.
 *
 * That is the shape of the problem and it is not about one bad check: a failing check applies
 * pressure toward making it pass, and the cheapest way to satisfy a claim about a repository is
 * often to change the repository. So the rule stops being advice. A step that would change
 * anything in git is refused before it reaches the shell, whatever the chat has concluded.
 *
 * Read-only git stays allowed, and deliberately so — auditing a repository is real work a task
 * may be given. The patterns therefore match on the subcommand's own position, after git's
 * global options, rather than anywhere in the line: `git log --grep=commit` is a question and
 * `git commit` is a change, and a regex that cannot tell them apart would make the audit
 * impossible in order to make the audit safe.
 *
 * The runner's own git does not pass through here. It runs through `execFile` in `vcs/git.ts`
 * with an argument list and no shell, so nothing in this list can stop the branch and the
 * commit that are supposed to happen.
 */

/** One of git's own options, before the subcommand: `-C <path>`, `--no-pager`, `-c k=v`. */
const GIT_GLOBAL_OPTION =
  '(?:--no-pager|--paginate|--bare|--literal-pathspecs|--exec-path=\\S*|-c\\s+\\S+|' +
  '-C\\s+(?:"[^"]*"|\'[^\']*\'|\\S+)|--git-dir[= ]\\S+|--work-tree[= ]\\S+)';

/** Subcommands that have no read-only form at all. */
const GIT_ALWAYS_WRITES =
  'commit|push|reset|rebase|merge|cherry-pick|revert|clean|checkout|switch|restore|stash|' +
  'am|apply|init|clone|filter-branch|filter-repo|update-ref|update-index|gc|prune|repack|' +
  'submodule|worktree|mv|rm|add|pull';

/** Subcommands that read by default and write with these arguments. */
const GIT_SOMETIMES_WRITES =
  'remote\\s+(?:add|remove|rm|rename|set-url|set-head|set-branches|prune)\\b|' +
  'branch\\s+(?:-[dDmMfu]\\b|--(?:delete|move|copy|force|set-upstream-to|unset-upstream))|' +
  'tag\\s+(?:-d\\b|-f\\b|--(?:delete|force))|' +
  'config\\s+(?:--unset|--unset-all|--replace-all|--add|--rename-section|--remove-section|--edit)|' +
  'reflog\\s+(?:delete|expire)|' +
  'notes\\s+(?:add|append|edit|remove|copy|prune)';

/** Which directories of one project are copied to the Desktop, and how. */
const ProjectMirrorSelection = z.object({
  includeDirs: z.array(z.string()).default([]),
  excludeDirs: z.array(z.string()).default([]),
  respectGitignore: z.boolean().default(true),
  includeEnvFiles: z.boolean().default(false),
});
export type ProjectMirrorSelection = z.infer<typeof ProjectMirrorSelection>;

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
      /**
       * The model a new session starts on, by the exact name the chat's picker shows.
       *
       * Not an enum, and not validated against a list: the list belongs to Microsoft, differs
       * per tenant and changes without notice. An empty value means the chat is left on
       * whatever it is already set to, which is the behaviour this project had before models
       * could be chosen at all.
       */
      defaultModel: z.string().default(''),
      /**
       * The model a new session's independent review starts on. Empty means the session's own
       * model reviews its own work, which is the weaker choice: a fresh conversation removes
       * attachment to the work, not the model's blind spots. Kept apart from `defaultModel`
       * because the two are chosen for opposite reasons — one for the work, one for being
       * different from whatever did the work.
       */
      defaultReviewModel: z.string().default(''),
      replyTimeoutSec: z.number().int().positive().default(900),
      signInTimeoutSec: z.number().int().positive().default(900),
      humanWaitSec: z.number().int().positive().default(900),
      headless: z.boolean().default(false),
    })
    .prefault({}),

  /** Level 1: the base prompt about how the runner works. Shipped with the project; editable in the UI. */
  level1File: z.string().default('prompts/level1.md'),
  /** Level 2: the user's project, domain and team instructions for this task. */
  level2: TextOrFile.optional(),
  /** The task. Required for a terminal run; the API supplies it per task. */
  task: TextOrFile.optional(),

  execution: z
    .object({
      mode: z.enum(['confirm', 'unattended']).default('confirm'),
      /**
       * The shell a step or a check runs in when it names none of its own.
       *
       * A preference rather than an instruction. A machine without PowerShell 7 falls through to
       * Windows PowerShell and then to `cmd` rather than failing every command with a spawn
       * error over a default nobody chose for this particular task. A shell that a reply or a
       * plan does name for itself is honoured or refused and never exchanged — see `exec/shells.ts`.
       */
      defaultShell: z.enum(['pwsh', 'powershell', 'cmd']).default('pwsh'),
      cwd: z.string().default('.'),
      commandTimeoutSec: z.number().int().positive().default(300),
      idleTimeoutSec: z.number().int().positive().default(60),
      longCommandTimeoutSec: z.number().int().positive().default(14_400),
      longIdleTimeoutSec: z.number().int().positive().default(900),
      maxStepTimeoutSec: z.number().int().positive().default(28_800),
      stopOnFailure: z.boolean().default(false),
      /**
       * What a queue of tasks does when one of them does not end with a summary.
       *
       * False, the default, makes the queue a chain: the rest stay queued. True treats the
       * tasks as independent. Sessions carry their own copy of this choice; this is the value
       * a session created from the terminal starts with.
       */
      continueOnFailure: z.boolean().default(false),
      /**
       * What the operator has arranged to contain this runner. An assertion, recorded as one.
       *
       * Every other setting here is a rule about what a command may say; this one is about the only
       * thing that contains a command once it runs. A process cannot see the boundary it is inside,
       * so it cannot check this — it can only record what was claimed, note the account it actually
       * holds, and say when the two disagree. See `exec/isolation.ts`.
       *
       * `none` is the default because it is the truth on a machine where nobody has arranged
       * anything, and a default that flattered the situation would be worse than none. Its one
       * consequence: an unattended run will not start while it is `none`, because nobody watching
       * and nothing containing is the combination this runner refuses to be.
       */
      isolation: z.enum(['none', 'separate-account', 'sandbox', 'vm']).default('none'),
      /**
       * The external programs a command may start. The one gate in this runner that names what is
       * allowed rather than what is not: for a tool whose whole job is to build and test software,
       * the toolchain is a finite, nameable set, where the things that could go wrong are not. A
       * command whose head is a program not on this list is refused and sent back to the chat with
       * the reason, so a legitimate tool this project happens to need is a one-line addition here,
       * not a hole to be left open for everyone. See `exec/programs.ts` for how a head is found and
       * why a cmdlet, an alias or a keyword is never mistaken for a program.
       *
       * This is not a boundary — allowing `node` allows `node -e`, and it sits on top of
       * `dangerous.ts`, never instead of it. It raises the floor against the unknown binary and the
       * living-off-the-land tool the deny list has not caught up with. An empty list turns it off.
       *
       * The default covers the common JavaScript, .NET, Java, Python, Go and Rust toolchains, the
       * shells, git, and the handful of Windows utilities a build or test legitimately reaches for.
       * A project that needs more adds it; a machine that wants none clears the list.
       */
      allowedPrograms: z
        .array(z.string())
        .default([
          // shells (a step may wrap one; the inner text is still screened by dangerous.ts)
          'pwsh', 'powershell', 'cmd',
          // JavaScript / TypeScript
          'node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'corepack', 'deno', 'bun',
          'tsc', 'tsx', 'ts-node', 'vite', 'next', 'eslint', 'prettier',
          'jest', 'vitest', 'mocha', 'playwright', 'cypress',
          // .NET
          'dotnet',
          // Java / JVM
          'java', 'javac', 'mvn', 'mvnw', 'gradle', 'gradlew',
          // Python
          'python', 'python3', 'py', 'pip', 'pip3', 'pytest', 'poetry', 'uv', 'ruff', 'black', 'mypy',
          // Go / Rust
          'go', 'gofmt', 'cargo', 'rustc', 'rustup',
          // version control
          'git',
          // ordinary Windows inspection and housekeeping a build or test reaches for
          'where', 'findstr', 'tasklist', 'taskkill', 'netstat', 'robocopy', 'xcopy', 'tar', 'curl', 'docker', 'docker-compose',
        ]),
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
          // git that changes something. See GIT_WRITE_NOTE below.
          `\\bgit\\s+(?:${GIT_GLOBAL_OPTION}\\s+)*(?:${GIT_ALWAYS_WRITES})\\b`,
          `\\bgit\\s+(?:${GIT_GLOBAL_OPTION}\\s+)*(?:${GIT_SOMETIMES_WRITES})`,
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
   * The project being worked on, remembered once instead of typed into every session.
   *
   * It is a default rather than a lock: a new session starts pointed at it, and any session
   * can then be pointed somewhere else. Nothing here changes what an existing session does,
   * because a setting that quietly redirected running work would be the worst kind.
   */
  project: z
    .object({
      /** Absolute path to the project folder. Empty means no default has been chosen. */
      rootDir: z.string().default(''),
      /**
       * What to call it. Empty means the folder's own name, which is what this used to be
       * always — fine until the Desktop mirror started naming a folder per project and the
       * plan brief started listing them, where "rules-tests" is a path and "the test suite"
       * is what the operator calls it. The other projects have had a name from the start; the
       * default one had nowhere to put it.
       */
      name: z.string().trim().default(''),
      /**
       * The other folders this operator works in, each with a short name: a front end, a back
       * end, the test suite. They are not defaults — a new session still starts on `rootDir` —
       * and they are not sessions. They exist for two readers: every folder field in the app
       * offers them with a button, and the plan brief lists them by absolute path, so a chat
       * model writing a plan across three repositories is told where they are instead of asking
       * for each one and being given a path from memory.
       */
      others: z
        .array(
          z.object({
            name: z.string().trim().min(1),
            rootDir: z.string().trim().min(1),
            /** Which of this project's directories go to the Desktop. See `mirror` below. */
            mirror: ProjectMirrorSelection.optional(),
          }),
        )
        .default([]),
      /**
       * Keep a copy of every project's selected directories on the Desktop, one folder per
       * project under `copilot-operator-context`, refreshed before every run.
       *
       * The Desktop is the way into OneDrive, and OneDrive is the way into the chat's file
       * picker. This is the switch for it: on, every project listed here is mirrored, with its
       * own selection; off, the project folders are removed from the Desktop, because a stale
       * copy of a code base sitting in the cloud is worse than none.
       */
      mirrorToDesktop: z.boolean().default(false),
      /** The default project's own selection. */
      mirror: ProjectMirrorSelection.optional(),
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
      /**
       * How many times a task may be sent back because its checks did not pass.
       *
       * Three, because the first round is usually a real mistake worth fixing, the second is
       * the fix not working, and a third failure means the task is wrong rather than the work.
       * Past that the loop is no longer productive and the operator should read it.
       */
      maxCheckRounds: z.number().int().positive().default(3),
      /**
       * How many times one command may be run inside a single task before it is refused.
       *
       * Three, and the third is generous. A command that returned the same thing twice will
       * return it a third time; the model repeating it is not being thorough, it is stuck, and
       * the loop costs a message, a reply and a report each time round. Observed: fifteen
       * consecutive iterations of `git remote -v`, each one concluding that the answer had not
       * changed. Refusing the fourth is what turns "stuck" into "tried something else", and the
       * refusal says so in as many words.
       */
      maxCommandRepeats: z.number().int().positive().default(3),
      /**
       * How many iterations may pass with nothing but refused repeats before the task is ended.
       *
       * Two. The first is the model meeting the refusal and reacting to it, which is the whole
       * point of the refusal; the second means it did not react, and a third would be the same
       * again. The task then ends as `blocked` rather than running to `maxIterations`, because
       * "it stopped repeating itself and said what was in the way" is a result and "it ran out
       * of turns" is not.
       */
      maxStalledIterations: z.number().int().positive().default(2),
      /**
       * How many times a task may be sent back because an independent review found problems.
       *
       * Two. The first round is the review finding what the implementer missed, which is the
       * whole point; the second is the fix being checked. A third failing round means the two
       * conversations disagree about what the task means, and that is a question for a person
       * rather than another lap — the task then ends `blocked` with what is still outstanding.
       */
      maxReviewRounds: z.number().int().positive().default(2),
      /** How many iterations one review may take before it is abandoned as inconclusive. */
      maxReviewIterations: z.number().int().positive().default(12),
      /**
       * How many times a task that ends `blocked` is run again, in a fresh conversation, before
       * that verdict is accepted.
       *
       * The runner cannot tell why a task blocked: the prompt, the machine, or the chat itself
       * — a long conversation whose early turns Copilot can no longer see, which is how a task
       * once asked for "the original task text" ninety seconds after receiving it. What it can
       * do is mechanical: run the same task again in a new chat, contract and all. A cause in
       * the chat goes away; a cause in the prompt or the machine blocks again, in nearly the
       * same words, and after this many tries the task stays blocked with both attempts on
       * its record. Zero turns it off.
       */
      retryBlockedInFreshChat: z.number().int().nonnegative().default(2),
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
  /** What `policy.lock.json` tightened, or that there was none. See `lockedPolicy.ts`. */
  policyLock: LockOutcome;
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
  /*
   * The administrator's floor, applied here because this is the one function both the terminal's
   * `run.yaml` and the API's `data/settings.json` pass through. Applying it anywhere further in
   * would mean applying it twice and trusting both; applying it further out would mean one of the
   * two entrances missing it, which is how a gate comes to be enforced on the surface somebody
   * happened to test. See `lockedPolicy.ts` for what a lock may and may not do.
   */
  const lock = await readPolicyLock(baseDir);
  const { policy, outcome } = applyPolicyLock(
    {
      mode: cfg.execution.mode,
      allowedPrograms: cfg.execution.allowedPrograms,
      denyPatterns: cfg.execution.denyPatterns,
    },
    lock,
  );

  return {
    ...cfg,
    execution: { ...cfg.execution, ...policy },
    configPath,
    baseDir,
    policyLock: outcome,
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
