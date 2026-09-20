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
import { join } from 'node:path';

import { runStep, type RunResult, type Shell } from './runner.js';
import { repoState, workingTreePaths } from '../vcs/git.js';
import { findSuspicious, suspiciousDetail } from '../vcs/commitHygiene.js';
import type { TaskCheck } from '../session/model.js';

/**
 * The check the runner adds on its own whenever it is about to commit.
 *
 * It is a constant rather than something a plan writes because it is not a claim about the
 * work: it is what a commit should never carry, whatever the task was.
 */
export const COMMIT_CLEAN_CHECK: TaskCheck = { name: 'nothing installed, built, logged or secret is committed', expect: 'commit-clean' };

/** What a check turned out to be, with enough detail to act on when it failed. */
export type CheckOutcome = {
  check: TaskCheck;
  passed: boolean;
  /** One sentence saying what was expected and what was found. */
  detail: string;
  exitCode?: number;
  /** Trimmed output of the command, when there was one. */
  output?: string;
};

export type CheckRunOptions = {
  cwd: string;
  /** Where the raw output of each check command goes. */
  logDir: string;
  signal?: AbortSignal;
  /** Ceiling per check. Checks are meant to be quick; a slow one is usually a mistake. */
  timeoutMs?: number;
  /** Refuses a command before it runs, the same gate the steps go through. */
  deny?: (command: string, shell: Shell) => string | null;
  /** The repository whose working tree `commit-clean` looks at. Absent means the check passes. */
  repoDir?: string;
};

const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
/** How much of a command's output travels back to the chat with a failure. */
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
 * One check, decided.
 *
 * A check that cannot be evaluated — no command where one is needed, a command the policy
 * refuses, a file it cannot read — counts as failed rather than as passed. The alternative is
 * a gate that opens when it breaks, which is the one behaviour a gate must never have.
 */
export async function runCheck(check: TaskCheck, index: number, opts: CheckRunOptions): Promise<CheckOutcome> {
  const fail = (detail: string, extra: Partial<CheckOutcome> = {}): CheckOutcome => ({ check, passed: false, detail, ...extra });
  const pass = (detail: string, extra: Partial<CheckOutcome> = {}): CheckOutcome => ({ check, passed: true, detail, ...extra });

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

  if (needsCommand(check)) {
    const command = (check.run ?? '').trim();
    if (!command) return fail('this check asks about a command but names none');

    const shell = (check.shell ?? 'pwsh') as Shell;
    const refused = opts.deny?.(command, shell);
    if (refused) return fail(`the command was refused before it ran: ${refused}`);

    let result: RunResult;
    try {
      result = await runStep(
        {
          id: 900 + index,
          shell,
          command,
          cwd: (check.cwd ?? '').trim() || opts.cwd,
          hardTimeoutMs: opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
          logPath: join(opts.logDir, `check-${index + 1}.txt`),
        },
        { signal: opts.signal },
      );
    } catch (e) {
      return fail(`the check could not be run: ${(e as Error).message}`);
    }

    const output = shorten(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`);
    const seen = { exitCode: result.exitCode, output };

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
        return output.includes(check.value ?? '')
          ? pass(`the output contains "${check.value}"`, seen)
          : fail(`expected the output to contain "${check.value}", and it does not`, seen);
      case 'output-omits':
        return output.includes(check.value ?? '')
          ? fail(`expected the output not to contain "${check.value}", but it does`, seen)
          : pass(`the output does not contain "${check.value}"`, seen);
      case 'output-matches': {
        let re: RegExp;
        try {
          re = new RegExp(check.value ?? '', 'm');
        } catch (e) {
          return fail(`the pattern is not a valid regular expression: ${(e as Error).message}`, seen);
        }
        return re.test(output)
          ? pass(`the output matches /${check.value}/`, seen)
          : fail(`expected the output to match /${check.value}/, and it does not`, seen);
      }
      default:
        return fail(`unknown check kind "${check.expect}"`, seen);
    }
  }

  const file = (check.file ?? '').trim();
  if (!file) return fail('this check asks about a file but names none');

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
 */
export function failureMessage(outcomes: CheckOutcome[], round: number, maxRounds: number): string {
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
  return lines.join('\n');
}

/** The same, as the plain text file that travels with the message. */
export function failureReport(outcomes: CheckOutcome[]): string {
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
