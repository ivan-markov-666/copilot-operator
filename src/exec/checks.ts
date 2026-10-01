/**
 * The gate a task has to pass before "done" is accepted.
 *
 * Until now a task ended when Copilot said it had ended. The `expected` line of a plan was
 * text: it travelled to the chat, it was read, and nothing ever compared it to the machine.
 * A check is that same expectation written so this runner can decide it for itself — run a
 * command and look at the exit code, look for a string in the output, look for a file — and
 * every kind here was chosen for one reason: a computer can answer it without judgement.
 *
 * That constraint is the whole design. This project drives a language model; it does not have
 * one of its own, and a check whose answer needs an opinion could only be faked. So the
 * judgement stays where it belongs, with whoever wrote the check, and what happens afterwards
 * is mechanical: all pass and the task is done, one fails and the failures go back to the chat
 * as a report, exactly like the output of a step, for Copilot to fix and try again.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createContext, Script, type Context } from 'node:vm';
import { isWithin } from './confinement.js';

import { MAX_CAPTURE_CHARS, runStep, type OutputListener, type RunResult } from './runner.js';
import type { ProcessTracker } from './processes.js';
import { findRedactions, mergeRedactions, redactSecrets, type RedactionHit } from './redaction.js';
import { resolveShell, type Shell, type ShellProblem } from './shells.js';
import { repoState, workingTreePaths } from '../vcs/git.js';
import { findSuspicious, suspiciousDetail } from '../vcs/commitHygiene.js';
import { integrityDetail, scanChanges } from '../vcs/contentIntegrity.js';
import type { TaskCheck } from '../session/model.js';

/**
 * The check the runner adds on its own whenever it is about to commit.
 *
 * It is a constant rather than something a plan writes because it is not a claim about the
 * work: it is what a commit should never carry, whatever the task was.
 */
export const COMMIT_CLEAN_CHECK: TaskCheck = { name: 'nothing installed, built, logged or secret is committed', expect: 'commit-clean' };

/** Its sibling for what is inside the files: encoding damage, stray bytes, credentials. See `contentIntegrity.ts`. */
export const CONTENT_CLEAN_CHECK: TaskCheck = { name: 'the text written is clean: encoding, line endings, no credentials', expect: 'content-clean' };

/** The checks the runner adds by itself before a commit, rather than ones a plan wrote. */
export const RUNNER_CHECK_KINDS: ReadonlySet<TaskCheck['expect']> = new Set(['commit-clean', 'content-clean']);

/** What a check turned out to be, with enough detail to act on when it failed. */
export type CheckOutcome = {
  check: TaskCheck;
  passed: boolean;
  /**
   * Set when the check never ran because the runner refused it: the command on the refused list,
   * or a folder or file outside the project. Not a verdict on the work — a verdict on the check —
   * and a caller deciding whether a check "fails now" must not read it as one.
   */
  refusedBeforeRunning?: boolean;
  /** One sentence saying what was expected and what was found. */
  detail: string;
  exitCode?: number;
  /** Trimmed output of the command, when there was one. */
  output?: string;
  /**
   * What was taken out of `detail` and `output` before anything could quote them, by name; absent
   * when nothing was. Kept because the text is redacted where it is made (see `runCheck`), and once
   * it is, nothing downstream can tell any more that a secret was ever there to say so.
   */
  redactions?: RedactionHit[];
  /** The shell the command was given to, and the executable that was started. */
  shell?: Shell;
  shellPath?: string;
  /**
   * Set when the check could not be decided because of the machine rather than the work: the
   * shell it asked for, or the only shell there was, could not be started.
   *
   * It still counts as failed — a gate that opens when it breaks is the one behaviour a gate
   * must never have — but it is not an attempt at the task, and whoever counts attempts is
   * expected to look at this before counting one.
   */
  environmentProblem?: ShellProblem;
};

export type CheckRunOptions = {
  cwd: string;
  /** Records the shells the checks start, so what they leave running is known to be the bot's. */
  tracker?: ProcessTracker;
  /** Variables a check's command is given beyond the fixed set. See `stepEnv.ts`. */
  passEnv?: string[];
  /** Where the raw output of each check command goes. */
  logDir: string;
  signal?: AbortSignal;
  /** Ceiling per check. Checks are meant to be quick; a slow one is usually a mistake. */
  timeoutMs?: number;
  /**
   * Refuses a command before it runs, the same gate the steps go through. Given the folder the
   * check will really run in — its own `cwd` when it names one — because that is what a relative
   * path in the command is resolved against, and so what decides whether it stays in the project.
   */
  deny?: (command: string, shell: Shell, cwd: string) => string | null;
  /**
   * The project folders. A check's own `cwd`, and the file a file check reads, must lie inside
   * them: a derived check is written by a model, and a `file-contains` on somebody's key would put
   * the key in the report that goes back to the chat. Absent means no confinement, as in a test.
   */
  roots?: string[];
  /** The repository whose working tree `commit-clean` looks at. Absent means the check passes. */
  repoDir?: string;
  /** The commit the task started from, which `content-clean` compares each changed file with. */
  baseCommit?: string;
  /**
   * The shell a check that names none of its own is given.
   *
   * It is passed in rather than worked out here, because the point is that it is the same value
   * a step that names no shell is given: `execution.defaultShell`, already held against what this
   * machine has. Worked out separately the two would agree only by coincidence — set the default
   * to `cmd` on a machine that also has PowerShell 7 and a step would run in `cmd` while the check
   * judging it ran in `pwsh`, which is a gate answering a question nobody asked. Absent means the
   * first shell the machine has, which is what a caller with no configuration to offer wants.
   */
  defaultShell?: Shell;
  /**
   * The operator's own patterns (`report.redactPatterns`), applied to what an outcome says on top of
   * the built-in shapes. Passed in, like `passEnv`, because this module does not read the settings,
   * and applied here because every caller that quotes an outcome — the checks message, the reviewer's
   * brief, the message that turns down a reviewer's check — would otherwise have to remember to.
   */
  redactPatterns?: string[];
};

const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * How much of a command's output travels back to the chat with a failure.
 *
 * Only what travels: a verdict is never taken on this shortened text. An output check is a claim
 * about everything the command printed, and a marker printed after the first few thousand
 * characters — the FAIL line at the end of a test run — is exactly the one it exists to see.
 */
const OUTPUT_KEPT = 4000;

function shorten(text: string, max = OUTPUT_KEPT): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n… (${trimmed.length - max} more characters)` : trimmed;
}

/** Whether a check needs a command run, which decides what it can be asked about. */
function needsCommand(check: TaskCheck): boolean {
  return check.expect === 'exit-zero' || check.expect === 'exit-nonzero' || check.expect.startsWith('output-');
}

/**
 * How long a check's pattern may spend on the output, all of it together, before the check is given
 * up as undecidable.
 *
 * The pattern is written by whoever wrote the check, often a model, and some patterns cost a
 * backtracking engine quadratic time or worse: `.*passed` on one line of 150,000 characters runs for
 * half a minute, and on two full streams for minutes. It runs on the server's event loop, which is
 * also the interface, Stop, the live log and the chat's timers, and every one of them stood still
 * with it. A pattern that suits the output it is tried on is done in milliseconds; one that needs
 * seconds is not going to finish.
 */
const PATTERN_BUDGET_MS = 5_000;

/** Compiles the check's pattern inside its context. `source` is a value there, never code. */
const COMPILE_PATTERN = new Script('re = new RegExp(source, "m")');
/** Whether any of `texts` matches it. */
const TRY_PATTERN = new Script('texts.some((t) => re.test(t))');

/**
 * A check's regular expression, run on a clock.
 *
 * V8 cannot be told to give up on a regular expression, but a script run in a `vm` context can be
 * interrupted when its time is up, and a regular expression running inside one is interrupted with
 * it. So the pattern is compiled and tried there, each try against what is left of one budget. A try
 * that runs out of it, or that the engine abandons by itself, leaves the pattern undecided: whether
 * the output matches is then not known, and the check says so rather than guessing either way.
 */
class TimedPattern {
  private readonly context: Context;
  private leftMs = PATTERN_BUDGET_MS;
  /** Set once any text tried has matched. */
  matched = false;
  /** Why the pattern could not be tried to the end, once it could not. */
  stopped: string | null = null;

  /** Throws, with the engine's own message, when the source is not a regular expression. */
  constructor(source: string) {
    this.context = createContext({ source, texts: [] as string[] });
    COMPILE_PATTERN.runInContext(this.context);
  }

  /** Whether the answer is already known: it matched, or it cannot be found out. */
  get settled(): boolean {
    return this.matched || this.stopped !== null;
  }

  /** Tries the texts unless the answer is already known; true once any text tried has matched. */
  tryOn(texts: string[]): boolean {
    if (this.settled || texts.length === 0) return this.matched;
    if (this.leftMs <= 0) {
      this.stopped = this.overtime();
      return false;
    }
    const started = Date.now();
    this.context.texts = texts;
    try {
      this.matched = TRY_PATTERN.runInContext(this.context, { timeout: this.leftMs }) === true;
    } catch (e) {
      this.stopped =
        (e as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
          ? this.overtime()
          : `the pattern could not be run to the end (${(e as Error).message})`;
    } finally {
      this.leftMs -= Date.now() - started;
      this.context.texts = [];
    }
    return this.matched;
  }

  private overtime(): string {
    return (
      `the pattern ran for more than ${PATTERN_BUDGET_MS / 1000} s on the output and was stopped ` +
      '(a pattern such as `.*x` can take minutes on one long line)'
    );
  }
}

/**
 * What an output check watches: everything the command prints, as it prints it.
 *
 * The runner keeps MAX_CAPTURE_CHARS of each stream in memory and the rest on disk only. A verdict
 * taken on the part kept is a verdict on part of the output: past it an output-omits passed on text
 * nobody had read, and an output-contains could never find the summary a long test run prints last.
 * So a check is handed every piece as the runner decodes it (`onOutput`), whatever the runner keeps,
 * and holds only what its verdict needs.
 */
type OutputWatch = { see: OutputListener; end: () => void };

/**
 * For output-contains and output-omits: whether the text appears anywhere in either stream.
 *
 * Exact, in bounded memory: each piece is searched together with the last `value.length - 1`
 * characters of its stream before it, so a text that arrived cut in two is still found whole.
 */
function watchForText(value: string): OutputWatch & { found: () => boolean } {
  const carried = { out: '', err: '' };
  let found = value === '';
  return {
    found: () => found,
    see: (text, stream) => {
      if (found) return;
      const joined = carried[stream] + text;
      if (joined.includes(value)) found = true;
      else carried[stream] = value.length > 1 ? joined.slice(1 - value.length) : '';
    },
    end: () => undefined,
  };
}

/**
 * For output-matches: the pattern on every line of the output that is not wholly in the part kept.
 *
 * The part kept is tried afterwards as one text, as it always was, so a pattern written to span lines
 * still can there. Past it there is no text, only a stream, and a line is the unit a pattern with `^`
 * and `$` is written against, so each line is tried as it ends. A line longer than MAX_CAPTURE_CHARS
 * is tried as far as that and the rest of it passed over, so memory stays bounded whatever a program
 * prints; `partLine` says when that happened.
 */
function watchForPattern(pattern: TimedPattern): OutputWatch & { partLine: () => boolean } {
  const held = { out: '', err: '' };
  const received = { out: 0, err: 0 };
  const skipping = { out: false, err: false };
  let partLine = false;
  // A line that ends inside the part kept is in the text tried afterwards; trying it here as well
  // would only spend the budget twice.
  const pastKept = (end: number): boolean => end > MAX_CAPTURE_CHARS;
  return {
    partLine: () => partLine,
    see: (text, stream) => {
      const at = received[stream];
      received[stream] += text.length;
      if (pattern.settled) return;
      const ended: string[] = [];
      let start = 0;
      for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', start)) {
        if (skipping[stream]) skipping[stream] = false;
        else if (pastKept(at + nl)) ended.push(held[stream] + text.slice(start, nl));
        held[stream] = '';
        start = nl + 1;
      }
      if (!skipping[stream]) {
        held[stream] += text.slice(start);
        if (held[stream].length > MAX_CAPTURE_CHARS) {
          ended.push(held[stream]);
          held[stream] = '';
          skipping[stream] = true;
          partLine = true;
        }
      }
      pattern.tryOn(ended);
    },
    // The last line of a stream need not end in a newline; it has ended all the same.
    end: () => pattern.tryOn((['out', 'err'] as const).filter((s) => held[s] !== '' && pastKept(received[s])).map((s) => held[s])),
  };
}

/**
 * One check, decided.
 *
 * A check that cannot be evaluated — no command where one is needed, a command the policy
 * refuses, a file it cannot read — counts as failed rather than as passed. The alternative is
 * a gate that opens when it breaks, which is the one behaviour a gate must never have.
 */
export async function runCheck(check: TaskCheck, index: number, opts: CheckRunOptions): Promise<CheckOutcome> {
  /*
   * What an outcome says is quoted to the chat by more than one caller — the checks message, the
   * reviewer's brief ("Last result"), the message that turns down a reviewer's check — and it
   * repeats the value the check looked for and the output it saw. So it is redacted where it is
   * made, once, rather than at each place that happens to quote it — with the operator's own
   * patterns as well as the built-in shapes, which until 2026-10-01 only the checks file got, so a
   * company's key format reached the chat in every message beside it. What was taken out is kept
   * on the outcome, for the event that says so.
   */
  const patterns = opts.redactPatterns ?? [];
  const said = (outcome: CheckOutcome): CheckOutcome => {
    const found = mergeRedactions([
      findRedactions(outcome.detail, patterns),
      outcome.output !== undefined ? findRedactions(outcome.output, patterns) : [],
    ]);
    return {
      ...outcome,
      detail: redactSecrets(outcome.detail, patterns),
      ...(outcome.output !== undefined ? { output: redactSecrets(outcome.output, patterns) } : {}),
      ...(found.length > 0 ? { redactions: found } : {}),
    };
  };
  const fail = (detail: string, extra: Partial<CheckOutcome> = {}): CheckOutcome => said({ check, passed: false, detail, ...extra });
  const pass = (detail: string, extra: Partial<CheckOutcome> = {}): CheckOutcome => said({ check, passed: true, detail, ...extra });

  if (check.expect === 'commit-clean') {
    const dir = (opts.repoDir ?? '').trim();
    if (!dir) return pass('no repository is set for this session, so nothing is committed');
    const state = await repoState(dir).catch(() => null);
    if (!state?.isRepo) return pass(`${dir} is not a git repository, so nothing is committed`);
    // File by file, not folder by folder: a new `api/` with node_modules inside is one line to
    // `git status` and thousands of files to a commit.
    const found = findSuspicious(await workingTreePaths(dir));
    return found.length === 0
      ? pass('nothing in the working tree looks like tool output or secrets')
      : fail(suspiciousDetail(found), { output: found.map((s) => `${s.path}\t${s.reason}`).join('\n') });
  }

  if (check.expect === 'content-clean') {
    const dir = (opts.repoDir ?? '').trim();
    if (!dir) return pass('no repository is set for this session, so nothing is committed');
    const state = await repoState(dir).catch(() => null);
    if (!state?.isRepo) return pass(`${dir} is not a git repository, so nothing is committed`);
    const found = await scanChanges(dir, await workingTreePaths(dir), opts.baseCommit);
    return found.length === 0
      ? pass('the changed files are clean UTF-8 text with one kind of line ending and no credentials')
      : fail(integrityDetail(found), { output: found.map((f) => `${f.path}\t${f.kind}\t${f.detail}`).join('\n') });
  }

  /*
   * Where this check really runs, decided once. The command runs here and a file check's relative
   * path is resolved against it — the same folder for both, so the path confined is the path read.
   * A relative `file` used to be read relative to wherever the runner itself was started, which is
   * this bot's own checkout: it pointed nowhere useful, and it would have made the path checked and
   * the path read two different paths.
   */
  const cwd = resolve(opts.cwd, (check.cwd ?? '').trim() || '.');
  if (opts.roots && opts.roots.length > 0 && !isWithin(cwd, opts.roots)) {
    return fail(`the check was refused before it ran: its working folder ${cwd} is outside the project folders (${opts.roots.join(', ')})`, { refusedBeforeRunning: true });
  }

  if (needsCommand(check)) {
    const command = (check.run ?? '').trim();
    if (!command) return fail('this check asks about a command but names none');

    /*
     * Which shell this check runs in, asked of the same place a task step asks.
     *
     * A check used to fall back to `pwsh` here on its own, which is how a machine without
     * PowerShell 7 came to fail every check with a spawn error while the same commands ran
     * happily in `cmd`. It is resolved before the deny list rather than inside `runStep`
     * because the gate below is told which shell it is screening for, and because a check that
     * cannot run at all should say so without a process being started.
     */
    const chosen = resolveShell(check.shell ?? opts.defaultShell);
    if (!chosen.ok) return fail(chosen.problem.message, { environmentProblem: chosen.problem });
    const { shell, path: shellPath } = chosen.resolved;

    const refused = opts.deny?.(command, shell, cwd);
    if (refused) return fail(`the command was refused before it ran: ${refused}`, { refusedBeforeRunning: true });

    // A pattern that is not one is known before anything runs, and running the command anyway would
    // spend a test suite's minutes on a verdict that cannot be taken.
    const value = check.value ?? '';
    let pattern: TimedPattern | null = null;
    if (check.expect === 'output-matches') {
      try {
        pattern = new TimedPattern(value);
      } catch (e) {
        return fail(`the pattern is not a valid regular expression: ${(e as Error).message}`);
      }
    }
    const text = watchForText(value);
    const lines = pattern ? watchForPattern(pattern) : null;
    const watch: OutputWatch | null = lines ?? (check.expect.startsWith('output-') ? text : null);

    let result: RunResult;
    try {
      result = await runStep(
        {
          id: 900 + index,
          // What the check asked for, or the standing default when it asked for nothing: the
          // runner resolves it again from the same inventory, so the two cannot disagree, and
          // the result then records what was wanted as well as what ran.
          shell: check.shell ?? opts.defaultShell,
          command,
          cwd,
          hardTimeoutMs: opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
          logPath: join(opts.logDir, `check-${index + 1}.txt`),
          passEnv: opts.passEnv,
        },
        { signal: opts.signal, tracker: opts.tracker, onOutput: watch?.see },
      );
    } catch (e) {
      return fail(`the check could not be run: ${(e as Error).message}`);
    }
    watch?.end();

    // What the runner kept: shortened, it is the copy that is reported, and whole it is the one text
    // a pattern is tried on. The verdict on a text is taken by the watch, which saw all of it.
    const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
    const seen = { exitCode: result.exitCode, output: shorten(output), shell: result.shell, shellPath: result.shellPath };

    // The shell was there when the run began and would not start when it was wanted. Nothing
    // about the work has been learned, so this is reported as what it is rather than as a
    // command that failed.
    if (result.shellProblem) {
      return fail(result.shellProblem.message, { ...seen, environmentProblem: result.shellProblem });
    }

    if (result.outcome !== 'completed') {
      return fail(`the command ended ${result.outcome} rather than finishing`, seen);
    }

    switch (check.expect) {
      case 'exit-zero':
        return result.exitCode === 0
          ? pass('the command succeeded', seen)
          : fail(`expected the command to succeed, but it exited ${result.exitCode}`, seen);
      case 'exit-nonzero':
        return result.exitCode !== 0
          ? pass(`the command failed, as expected (exit ${result.exitCode})`, seen)
          : fail('expected the command to fail, but it succeeded', seen);
      case 'output-contains':
        return text.found()
          ? pass(`the output contains "${check.value}"`, seen)
          : fail(`expected the output to contain "${check.value}", and it does not`, seen);
      case 'output-omits':
        return text.found()
          ? fail(`expected the output not to contain "${check.value}", but it does`, seen)
          : pass(`the output does not contain "${check.value}"`, seen);
      case 'output-matches': {
        // The lines past the part kept were tried as they came; the part kept is tried now, as one
        // text. A pattern that cannot be run is a check that fails, never one that passes.
        if (pattern?.tryOn([output])) return pass(`the output matches /${check.value}/`, seen);
        if (pattern?.stopped) return fail(`whether the output matches /${check.value}/ cannot be decided: ${pattern.stopped}`, seen);
        /*
         * Said plainly when it is not the whole truth. Past what the runner keeps, the output was
         * tried a line at a time, so a match spanning lines there, or in a line longer than the
         * runner keeps, was not looked for; the chat is told so, rather than told the text is absent.
         */
        const how = result.truncated
          ? ` (past the first ${MAX_CAPTURE_CHARS} characters of each stream the output was tried a line at a time, so a match ` +
            `spanning lines there was not looked for${lines?.partLine() ? `, nor one past the first ${MAX_CAPTURE_CHARS} characters of a longer line` : ''})`
          : '';
        return fail(`expected the output to match /${check.value}/, and it does not${how}`, seen);
      }
      default:
        return fail(`unknown check kind "${check.expect}"`, seen);
    }
  }

  const named = (check.file ?? '').trim();
  if (!named) return fail('this check asks about a file but names none');
  const file = resolve(cwd, named);
  if (opts.roots && opts.roots.length > 0 && !isWithin(file, opts.roots)) {
    return fail(`the check was refused before it ran: ${file} is outside the project folders (${opts.roots.join(', ')})`, { refusedBeforeRunning: true });
  }

  switch (check.expect) {
    case 'file-exists':
      return existsSync(file) ? pass(`${file} exists`) : fail(`expected ${file} to exist, and it does not`);
    case 'file-missing':
      return existsSync(file) ? fail(`expected ${file} not to exist, but it does`) : pass(`${file} does not exist`);
    case 'file-contains': {
      if (!existsSync(file)) return fail(`expected ${file} to contain "${check.value}", but the file does not exist`);
      let body: string;
      try {
        body = await readFile(file, 'utf8');
      } catch (e) {
        return fail(`${file} could not be read: ${(e as Error).message}`);
      }
      return body.includes(check.value ?? '')
        ? pass(`${file} contains "${check.value}"`)
        : fail(`expected ${file} to contain "${check.value}", and it does not`, { output: shorten(body, 1500) });
    }
    default:
      return fail(`unknown check kind "${check.expect}"`);
  }
}

/** Every check of a task, in order. They all run: a report of one failure at a time is slow. */
export async function runChecks(checks: TaskCheck[], opts: CheckRunOptions): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  for (const [i, check] of checks.entries()) {
    if (opts.signal?.aborted) {
      out.push({ check, passed: false, detail: 'the operator stopped the run before this check ran' });
      continue;
    }
    out.push(await runCheck(check, i, opts));
  }
  return out;
}

/**
 * Whether a round of checks was decided by the machine rather than by the work.
 *
 * The first such problem is the answer: several checks on a machine with no PowerShell 7 all
 * hit the same missing interpreter, and repeating one sentence per check helps nobody. A
 * caller that gets something back here is being told that this round was not an attempt at the
 * task, that it should not cost the task one of its rounds, and that there is nothing worth
 * sending to a language model — an interpreter it cannot install is not a thing it can fix.
 */
export function environmentProblemIn(outcomes: CheckOutcome[]): ShellProblem | null {
  return outcomes.find((o) => o.environmentProblem)?.environmentProblem ?? null;
}

/** A short line per check, for the live log and the task record. */
export function describeCheck(check: TaskCheck): string {
  const what = check.expect === 'commit-clean' ? "the repository's uncommitted files" : needsCommand(check) ? (check.run ?? '') : (check.file ?? '');
  return `${check.name}: ${check.expect}${check.value ? ` "${check.value}"` : ''} — ${what}`;
}

/**
 * What Copilot is told when checks fail.
 *
 * Written as an instruction rather than as a complaint: it says what was asked, what happened,
 * and that the task is not over. The full output is attached as a file by the caller, the same
 * way step output is, because a chat message is the wrong place for a compiler's opinion.
 *
 * It quotes the checks themselves — the command, the value looked for, the detail that repeats
 * it — and a plan may well carry a token in one of them, so it leaves here with every
 * secret-shaped string already redacted (see `redaction.ts`). It used to be redacted only where a
 * caller remembered to, which for this message was nowhere. The operator's own patterns are applied
 * on top when the caller passes them (`report.redactPatterns`; this module does not read the
 * settings): left to the caller, they were applied to the file beside this message and not to it.
 */
export function failureMessage(outcomes: CheckOutcome[], round: number, maxRounds: number, extraPatterns: string[] = []): string {
  const failed = outcomes.filter((o) => !o.passed);
  const lines = [
    '## The task is not finished yet',
    '',
    `You reported the task as done, but ${failed.length} of the ${outcomes.length} checks set for it did not pass.`,
    'These checks are run by the runner, not by you, and they are what decides whether this task is over.',
    '',
  ];

  for (const [i, o] of failed.entries()) {
    lines.push(`### ${i + 1}. ${o.check.name}`);
    lines.push('');
    lines.push(
      o.check.expect === 'commit-clean'
        ? '- What was required: nothing in the commit that is installed, built, logged or secret'
        : `- What was required: \`${o.check.expect}\`${o.check.value ? ` of "${o.check.value}"` : ''}`,
    );
    if (o.check.run) lines.push(`- Command: \`${o.check.run}\``);
    if (o.check.file) lines.push(`- File: \`${o.check.file}\``);
    lines.push(`- What happened: ${o.detail}`);
    if (o.exitCode !== undefined) lines.push(`- Exit code: ${o.exitCode}`);
    lines.push('');
  }

  const passed = outcomes.filter((o) => o.passed);
  if (passed.length > 0) {
    lines.push(`The other ${passed.length} check(s) passed: ${passed.map((o) => o.check.name).join(', ')}.`);
    lines.push('');
  }

  lines.push(
    `Fix what is failing and continue. Send steps as usual; do not report the task as done again until you ` +
      `have reason to believe these checks will pass. This is attempt ${round} of ${maxRounds}: after that the ` +
      'task is closed as failed and the operator reads it.',
  );
  return redactSecrets(lines.join('\n'), extraPatterns);
}

/** The same, as the plain text file that travels with the message, redacted here for the same reason. */
export function failureReport(outcomes: CheckOutcome[], extraPatterns: string[] = []): string {
  return redactSecrets(reportText(outcomes), extraPatterns);
}

/**
 * What a round's checks file and message had taken out, by name, for the event that says so: what
 * each outcome's own words lost where they were made (see `runCheck`), and what the checks' words
 * — the name, the command, the value, the file — lose in the file. The file quotes everything the
 * message does, so it stands for both, and a secret the two of them carry is counted once.
 */
export function failureRedactions(outcomes: CheckOutcome[], extraPatterns: string[] = []): RedactionHit[] {
  return mergeRedactions([...outcomes.map((o) => o.redactions ?? []), findRedactions(reportText(outcomes), extraPatterns)]);
}

/** The checks file before it is redacted. What its outcomes say already is, where it was made. */
function reportText(outcomes: CheckOutcome[]): string {
  const parts = ['CHECKS THAT DID NOT PASS', '='.repeat(60), ''];
  for (const o of outcomes.filter((x) => !x.passed)) {
    parts.push(`CHECK : ${o.check.name}`);
    parts.push(`EXPECT: ${o.check.expect}${o.check.value ? ` "${o.check.value}"` : ''}`);
    if (o.check.run) parts.push(`RUN   : ${o.check.run}`);
    if (o.check.file) parts.push(`FILE  : ${o.check.file}`);
    parts.push(`RESULT: ${o.detail}`);
    if (o.exitCode !== undefined) parts.push(`EXIT  : ${o.exitCode}`);
    if (o.output) {
      parts.push('OUTPUT:');
      parts.push(o.output);
    }
    parts.push('', '-'.repeat(60), '');
  }
  const passed = outcomes.filter((x) => x.passed);
  if (passed.length > 0) {
    parts.push('CHECKS THAT PASSED', '-'.repeat(60));
    for (const o of passed) parts.push(`- ${o.check.name}: ${o.detail}`);
  }
  return parts.join('\n');
}
