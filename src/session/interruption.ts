/**
 * Where an attempt was when the bot stopped under it — the power went, the machine shut down,
 * `npm start` was stopped with Ctrl+C, the process crashed — read back from what it had written.
 *
 * Nothing in memory survives that, but the run folder does, and it was written as the work went:
 * the transcript has every reply and every step as it was proposed, started and finished, and each
 * step's output is in its own log under `steps/`. So the last reply the chat sent, which of the
 * steps it asked for had finished (and how), which one was cut off while it ran, which never ran,
 * and whether their results had already gone back to the chat — all of that is on disk. It is what
 * the chat needs to be told to carry on rather than start over, and what the operator needs to see
 * to trust that it can.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseStepLog } from './story.js';

export type InterruptedStep = {
  id: number;
  /** finished: ran to the end; cut: was running when the bot stopped; skipped: refused or skipped; not-run: never reached. */
  state: 'finished' | 'cut' | 'skipped' | 'not-run';
  command?: string;
  exitCode?: number;
  outcome?: string;
  /** The end of what it printed, for the chat to read. */
  outputTail?: string;
};

export type Interruption = {
  /** When the last thing was written before the stop. */
  lastActivity?: string;
  /** The iteration of the chat's last reply, 0 when none had arrived. */
  iteration: number;
  /** What that reply said: continue, done, blocked. */
  replyStatus?: string;
  /** The steps it asked for, as far as they got. */
  steps: InterruptedStep[];
  /** Whether the results of those steps had already been sent back to the chat. */
  resultsSent: boolean;
};

const TAIL_CHARS = 1200;

type Event = Record<string, unknown> & { at?: string; type?: string };

/** Reads an attempt's run folder; null when there is no transcript to read. */
export async function readInterruption(runDir: string): Promise<Interruption | null> {
  const raw = await readFile(join(runDir, 'transcript.jsonl'), 'utf8').catch(() => null);
  if (raw === null) return null;
  const events: Event[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as Event);
    } catch {
      // A line cut in half by the stop itself: the rest is still good.
    }
  }
  const lastActivity = events.at(-1)?.at as string | undefined;
  let replyAt = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === 'reply-parsed') {
      replyAt = i;
      break;
    }
  }
  if (replyAt < 0) return { lastActivity, iteration: 0, steps: [], resultsSent: false };
  const reply = events[replyAt]!;
  const iteration = Number(reply.iteration) || 0;
  const after = events.slice(replyAt + 1);
  const count = Number(reply.steps) || 0;
  const steps: InterruptedStep[] = [];
  for (let id = 1; id <= count; id += 1) {
    const finished = after.find((e) => e.type === 'step-finished' && e.id === id);
    const skipped = after.find((e) => e.type === 'step-skipped' && e.id === id);
    const started = after.some((e) => e.type === 'step-started' && e.id === id);
    const proposed = after.find((e) => e.type === 'step-proposed' && e.id === id);
    const state: InterruptedStep['state'] = finished ? 'finished' : skipped ? 'skipped' : started ? 'cut' : 'not-run';
    const step: InterruptedStep = { id, state };
    if (typeof proposed?.description === 'string') step.command = proposed.description;
    if (finished) {
      step.outcome = String(finished.outcome ?? '');
      if (typeof finished.exitCode === 'number') step.exitCode = finished.exitCode;
    }
    if (state === 'finished' || state === 'cut') {
      const log = await readFile(join(runDir, 'steps', `${iteration}-${id}.log`), 'utf8').catch(() => '');
      const output = parseStepLog(log).output;
      if (output) step.outputTail = output.length > TAIL_CHARS ? `…${output.slice(-TAIL_CHARS)}` : output;
    }
    steps.push(step);
  }
  // Sent back only when the results were written *and* a message went out after them.
  const reportAt = after.findIndex((e) => e.type === 'report-written' && Number(e.iteration) === iteration);
  const resultsSent = reportAt >= 0 && after.slice(reportAt + 1).some((e) => e.type === 'message-sent');
  return { lastActivity, iteration, replyStatus: typeof reply.status === 'string' ? reply.status : undefined, steps, resultsSent };
}

/**
 * What the chat is told about it, in the continuation message: which steps ran, with the end of
 * their output, which was cut off, which never ran — or that the results were already sent.
 */
export function describeInterruption(i: Interruption): string {
  if (i.iteration === 0) return 'It stopped before your first reply arrived, so nothing of this task had been run yet.';
  if (i.resultsSent) {
    return `The results of the steps from your last reply were already sent to you (above), and your answer to them was not received. Carry on from those results.`;
  }
  if (i.replyStatus === 'done' && i.steps.length === 0) {
    return 'Your last reply reported the task done; the runner was checking it when it stopped. If nothing is left, reply again with your summary.';
  }
  if (i.steps.length === 0) return 'Your last reply asked for no steps.';
  const lines = [`Of the ${i.steps.length} step(s) in your last reply:`];
  for (const s of i.steps) {
    const what =
      s.state === 'finished'
        ? `ran to the end (exit ${s.exitCode ?? '?'})`
        : s.state === 'cut'
          ? 'was running when the runner stopped — it may have done only part of its work; check its effect before relying on it'
          : s.state === 'skipped'
            ? 'was not run (refused or skipped)'
            : 'did not run';
    lines.push(`- step ${s.id} ${what}.`);
    if (s.outputTail) lines.push('  Its output ended with:', '  ```', ...s.outputTail.split('\n').map((l) => `  ${l}`), '  ```');
  }
  return lines.join('\n');
}
