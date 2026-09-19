/**
 * Builds what goes back to Copilot after a set of steps has run.
 *
 * Two artefacts, and they are not interchangeable:
 *
 *   the report file     the whole terminal output, uncut, uploaded as .txt
 *   the covering text   a short message that travels with the attachment
 *
 * The covering text is not decoration. **A message consisting only of an attachment cannot
 * be sent**: the composer keeps the Send button disabled until there is text. So the bot
 * must always write something, and since it has to write something anyway, it may as well
 * carry the information Copilot needs to decide whether to open the file: which iteration
 * this is, how many steps ran, and how each one ended.
 */
import type { RunResult } from '../exec/runner.js';

/** Never send an attachment without text. This is the fallback if everything else is empty. */
export const MINIMUM_COVERING_TEXT = 'Ето отговора от терминала. Файлът е прикачен.';

export type CoveringMessageInput = {
  /**
   * The task this output belongs to, by the name it was given in the conversation.
   *
   * Said in the message rather than only in the attached file, because several tasks share one
   * conversation and "iteration 2" on its own belongs to whichever of them the reader guesses.
   */
  task?: string;
  iteration: number;
  results: RunResult[];
  /** File names actually attached, in order. */
  attachments: string[];
  /** Set when the report had to be split. */
  parts?: number;
};

/**
 * A non-zero exit with nothing printed at all.
 *
 * In PowerShell that is what a cmdlet that found nothing looks like — `Get-NetTCPConnection`
 * on a free port, `Get-Process` with no match — and the free port is the good outcome. Twice
 * in one run a step ended this way at the exact moment the task had succeeded, and the model
 * spent iterations proving with netstat that nothing was wrong. The runner cannot change the
 * exit code; it can say what it sees.
 */
export function silentFailure(r: RunResult): boolean {
  return r.outcome === 'completed' && r.exitCode !== 0 && r.stdout.trim() === '' && r.stderr.trim() === '';
}

function outcomeSummary(r: RunResult): string {
  switch (r.outcome) {
    case 'completed':
      return silentFailure(r) ? `step ${r.id} exit ${r.exitCode} with no output at all` : `step ${r.id} exit ${r.exitCode}`;
    case 'hard-timeout':
      return `step ${r.id} hit its time limit`;
    case 'idle-timeout':
      return `step ${r.id} produced no output and was stopped`;
    case 'aborted':
      return `step ${r.id} aborted by the operator`;
    case 'spawn-error':
      return `step ${r.id} could not be started`;
  }
}

/**
 * The covering message. Deliberately short: it can never approach the roughly 120 000
 * character limit of the composer, because the output it describes is in the attachment.
 */
export function buildCoveringMessage(input: CoveringMessageInput): string {
  const { task, iteration, results, attachments, parts } = input;
  const what = task?.trim() ? `"${task.trim()}", iteration ${iteration}` : `iteration ${iteration}`;

  if (attachments.length === 0) {
    // Should not happen, but an empty message is unsendable, so never return one.
    return `${MINIMUM_COVERING_TEXT} (${what}, no file was produced)`;
  }

  const lines: string[] = [];
  lines.push(
    `Terminal output for ${what}: ${results.length} step(s), ` +
      `${results.map(outcomeSummary).join('; ')}.`,
  );

  if (parts && parts > 1) {
    lines.push(
      `The output is split across ${parts} attached files: ${attachments.join(', ')}. ` +
        `Read all of them, in order, before deciding the next steps.`,
    );
  } else {
    lines.push(
      `The full output is in the attached file ${attachments[0]}. ` +
        `Read the whole file before deciding the next steps.`,
    );
  }

  const stopped = results.filter((r) => r.outcome === 'idle-timeout' || r.outcome === 'hard-timeout');
  if (stopped.length > 0) {
    lines.push(
      `Note: ${stopped.map((r) => `step ${r.id}`).join(', ')} was stopped by the runner, not by the command itself.`,
    );
  }

  const silent = results.filter(silentFailure);
  if (silent.length > 0) {
    lines.push(
      `Note: ${silent.map((r) => `step ${r.id}`).join(', ')} exited non-zero without printing anything. In PowerShell ` +
        'that is usually a cmdlet that found nothing — a free port, no matching process — not a command that failed. ' +
        'Decide from what the step was asking, not from the code alone.',
    );
  }

  return lines.join(' ');
}

/** Guard used right before clicking Send. Throws rather than sending an unsendable message. */
export function assertSendable(text: string, attachments: string[]): void {
  if (text.trim().length === 0) {
    throw new Error(
      `Refusing to send: the composer requires text, and ${attachments.length} attachment(s) alone cannot be sent.`,
    );
  }
}
