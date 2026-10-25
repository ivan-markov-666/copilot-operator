/**
 * Trying a subtask of two chats again (operator's specification, 2026-10-25): "when a subtask fails for a temporary
 * problem of the browser, the connection, Copilot's answer or the transport, the operator may repeat only it" — under
 * its own number, the plan and the subtasks done kept, the failed attempt on record, in the same worker's conversation
 * or a fresh one; never by itself after a real failure of the work, a refused command or the operator's Stop; never
 * running again what an attempt already did.
 *
 * This module is the part that needs no browser: how an attempt ended (`classifySubtaskEnd`), what it left behind
 * (`sideEffectsOf`), what to do next (`retryPlan`), and what the next attempt is told (`retryMessage`). The lead's runner
 * (`leadRunner.ts`) carries it out.
 */
import type { RetryChoice, SideEffects, SubtaskAttempt, SubtaskFailure, Task } from '../session/model.js';
import type { StoryEntry } from '../session/story.js';

/** What Settings say to do with a subtask that failed for a technical reason (`limits.subtaskRetryMode`). */
export type RetryMode = 'ask' | 'same' | 'fresh' | 'lead';

/** The commands of an attempt: how many began, how many finished, which were cut off, and what finished. */
export type StepFacts = {
  started: number;
  completed: number;
  /** Cut off while they ran (Stop, a timeout): what they did is not known. */
  cutOff: string[];
  /** Finished, with their exit codes: what the next attempt must not run again. */
  done: Array<{ command: string; exitCode?: number }>;
};

type StepEntry = Extract<StoryEntry, { kind: 'step' }>;

/** The steps of an attempt's story, its review's included. */
export function stepsOf(entries: StoryEntry[]): StepEntry[] {
  return entries.flatMap((e) => (e.kind === 'step' ? [e] : e.kind === 'review' ? (e.entries.filter((x) => x.kind === 'step') as StepEntry[]) : []));
}

/** A command that began: one refused, or that the shell could not start, never did. */
const BEGAN = (s: StepEntry): boolean => s.outcome !== undefined && s.outcome !== 'refused' && s.outcome !== 'spawn-error';
/** A command cut off while it ran. */
const CUT = (s: StepEntry): boolean => s.outcome === 'aborted' || s.outcome === 'hard-timeout' || s.outcome === 'idle-timeout';

export function stepFacts(steps: StepEntry[]): StepFacts {
  const began = steps.filter(BEGAN);
  return {
    started: began.length,
    completed: began.filter((s) => s.outcome === 'completed').length,
    cutOff: began.filter(CUT).map((s) => s.command),
    done: began.filter((s) => s.outcome === 'completed').map((s) => ({ command: s.command, ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}) })),
  };
}

/**
 * How an attempt ended, as a category, or null when it ended done. Read from what the runner recorded, never from the
 * words of a reason: a Stop or the window closed (`aborted`); the shell missing (`stopCode: environment`); the chat's
 * answers out of their format however often it was asked again, or an answer that never came (the limits on those); a
 * fault of the chat or the browser under the work (`failure: transport`). Anything else is the work's own end — a
 * check or a test that fails, a blocker, a refused command, a limit of rounds or minutes — which the lead decides on.
 */
export function classifySubtaskEnd(task: Pick<Task, 'status' | 'limit' | 'stopCode' | 'failure'>, opts: { stopped?: boolean } = {}): SubtaskFailure | null {
  if (task.status === 'done') return null;
  if (opts.stopped || task.status === 'aborted') return 'USER_STOPPED';
  if (task.stopCode === 'environment' || task.failure?.kind === 'shell') return 'COMMAND_INFRASTRUCTURE_FAILURE';
  if (task.stopCode === 'format-repair-exhausted' || task.limit?.setting === 'maxFormatRetries') return 'TRANSIENT_CHAT_FAILURE';
  if (task.limit?.setting === 'replyTimeoutSec') return 'TRANSIENT_CHAT_FAILURE';
  if (task.failure?.kind === 'transport') return 'TRANSIENT_CHAT_FAILURE';
  return 'TASK_EVIDENCE_FAILURE';
}

/** Whether a category is a fault of the means, which may be tried again: the chat's, or the commands' runner. */
export function isTechnical(category: SubtaskFailure | null): boolean {
  return category === 'TRANSIENT_CHAT_FAILURE' || category === 'COMMAND_INFRASTRUCTURE_FAILURE' || category === 'UNKNOWN_SIDE_EFFECT_STATE';
}

/**
 * What an attempt left behind. The folder is compared with its photograph from the attempt's start (the chat's
 * checkpoint, and the photograph after it): nothing changed and nothing cut off is `none`, safe to run again as it was;
 * changes made by commands that finished are `changed`, to be carried on from, those commands not run again; a command
 * cut off while it ran (a read-only subtask's apart, whose changes are put back), or a folder that could not be
 * compared, is `unknown`, which the operator decides on.
 */
export function sideEffectsOf(task: Pick<Task, 'vcs' | 'checkpoint' | 'readOnly'>, steps: StepFacts): { state: SideEffects; changed: string[]; why: string } {
  const changed = (task.vcs?.files ?? []).map((f) => f.path);
  if (steps.started === 0 && changed.length === 0) return { state: 'none', changed, why: 'no command ran, and nothing in the folder changed' };
  if (steps.cutOff.length > 0 && !task.readOnly) {
    return { state: 'unknown', changed, why: `a command was cut off while it ran, so what it did is not known: ${steps.cutOff.slice(0, 3).map((c) => `\`${c.replace(/\s+/g, ' ').slice(0, 120)}\``).join(', ')}` };
  }
  if (!task.checkpoint || !task.vcs?.commit) return { state: 'unknown', changed, why: 'the folder could not be compared with how it was when the subtask began' };
  if (changed.length > 0) return { state: 'changed', changed, why: `commands that finished changed ${changed.length} file(s)` };
  return { state: 'none', changed, why: 'nothing in the folder changed' };
}

export type RetryPlan =
  | { do: 'retry'; choice: 'same' | 'fresh'; continued: boolean }
  | { do: 'ask'; choices: RetryChoice[]; category: SubtaskFailure }
  | { do: 'lead'; why: string };

/**
 * What to do after an attempt, by its category, what it left, Settings and the attempts left. Tried again by itself
 * only for a proven, temporary fault of the chat (`TRANSIENT_CHAT_FAILURE`) with Settings saying so: one of the
 * commands' runner is put to the operator, as is anything after which the folder is not known; without anybody to ask,
 * the lead decides, as it did before there were attempts.
 */
export function retryPlan(input: { category: SubtaskFailure | null; sideEffects: SideEffects; mode: RetryMode; attempt: number; maxAttempts: number; canAsk: boolean }): RetryPlan {
  const { category, sideEffects, mode, attempt, maxAttempts, canAsk } = input;
  if (!category) return { do: 'lead', why: 'it ended done' };
  if (category === 'USER_STOPPED') return { do: 'lead', why: 'the operator stopped it; it is not started again by itself' };
  if (category === 'TASK_EVIDENCE_FAILURE') return { do: 'lead', why: 'the work itself ended so; the lead decides what comes next' };
  if (attempt >= maxAttempts) return { do: 'lead', why: `all ${maxAttempts} attempt(s) were used` };
  if (mode === 'lead') return { do: 'lead', why: 'Settings leave it to the lead' };
  if (sideEffects === 'unknown') {
    return canAsk ? { do: 'ask', choices: ['continue', 'restore', 'accept'], category: 'UNKNOWN_SIDE_EFFECT_STATE' } : { do: 'lead', why: 'what it changed is not known, and nobody is here to decide' };
  }
  if (mode === 'ask' || category === 'COMMAND_INFRASTRUCTURE_FAILURE') {
    return canAsk ? { do: 'ask', choices: ['same', 'fresh', 'accept'], category } : { do: 'lead', why: mode === 'ask' ? 'nobody is here to ask' : 'the commands could not be run, which is not proven temporary' };
  }
  return { do: 'retry', choice: mode, continued: sideEffects === 'changed' };
}

/** What a category is, in the words the lead and the record use. */
export const FAILURE_WORDS: Record<SubtaskFailure, string> = {
  TRANSIENT_CHAT_FAILURE: 'a temporary failure of the chat or the browser',
  COMMAND_INFRASTRUCTURE_FAILURE: 'the commands could not be run',
  TASK_EVIDENCE_FAILURE: 'the work itself',
  USER_STOPPED: 'stopped by the operator',
  UNKNOWN_SIDE_EFFECT_STATE: 'interrupted after a possible change',
};

/** A reason for the record: one line, no longer than it needs, nothing of the machine's secrets. */
export function sanitizedReason(reason: string | undefined): string {
  return (reason ?? '')
    .replace(/\r?\n[\s\S]*$/, '')
    .replace(/(token|password|secret|key)=\S+/gi, '$1=…')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\AppData\\Local\\copilot-operator\\edge-profile\S*/gi, '(the bot\'s Edge profile)')
    .trim()
    .slice(0, 300);
}

/**
 * The message an attempt after the first is given (the lead's subtask as it was, `prompt`, then this): which attempt it
 * is and why, and what it starts from — the folder put back to the subtask's start; or the folder as the last attempt
 * left it, with what finished there, not to be run again; or, in a fresh conversation, the reports of the subtasks done
 * before it, which it has not seen. Never to redo the assignment's other subtasks; the report as the lead asked for it.
 */
export function retryMessage(prompt: string, input: {
  n: number;
  attempt: number;
  maxAttempts: number;
  why: string;
  continued: boolean;
  restored: boolean;
  fresh: boolean;
  done: StepFacts['done'];
  cutOff: string[];
  changed: string[];
  predecessors: Array<{ n: number; title: string; report: string }>;
}): string {
  const cmd = (c: string): string => `\`${c.replace(/\s+/g, ' ').slice(0, 160)}\``;
  return [
    prompt,
    '',
    `## Attempt ${input.attempt} of ${input.maxAttempts} at subtask ${input.n}`,
    '',
    `The attempt before this one did not end: ${input.why}. This is the same subtask, given again — not a new one.`,
    '',
    ...(input.restored
      ? ['The folder was put back to how it was when the subtask began, at the operator\'s word: start it from the beginning.', '']
      : input.continued
        ? [
            'Carry on from the folder as the last attempt left it: what it did is there. Do not run again the commands that finished; check what they left instead, and do what is still missing.',
            ...(input.changed.length > 0 ? ['', `Files changed so far in this subtask: ${input.changed.slice(0, 40).join(', ')}${input.changed.length > 40 ? ` and ${input.changed.length - 40} more` : ''}.`] : []),
            ...(input.done.length > 0 ? ['', 'Commands that finished in the last attempt — do not run them again:', ...input.done.slice(-25).map((d) => `- ${cmd(d.command)}${d.exitCode !== undefined ? ` → exit ${d.exitCode}` : ''}`)] : []),
            ...(input.cutOff.length > 0 ? ['', 'Cut off while they ran, so what they did is not known — look before you run them again:', ...input.cutOff.slice(-10).map((c) => `- ${cmd(c)}`)] : []),
            '',
          ]
        : ['Nothing in the folder changed in the last attempt: do the subtask as it is given above.', '']),
    ...(input.fresh && input.predecessors.length > 0
      ? [
          'This is a fresh conversation. What the subtasks done before this one reported, for what you need of it:',
          '',
          ...input.predecessors.slice(-6).flatMap((p) => [`### Subtask ${p.n}: ${p.title}`, p.report.trim().slice(0, 1500), '']),
        ]
      : []),
    'Do only this subtask: the assignment\'s other subtasks are not yours, and the ones done are not to be done again. Report back exactly as asked under "Report back" above.',
  ].join('\n');
}

/** How a subtask's attempts went, for the lead's report: the last's ending, and the earlier ones in a line each. */
export function describeAttempts(attempts: SubtaskAttempt[], maxAttempts: number): string {
  if (attempts.length <= 1) return '';
  const last = attempts.at(-1)!;
  return [
    last.status === 'done' ? `It was done at attempt ${last.attempt} of ${maxAttempts}.` : `It ended at attempt ${last.attempt} of ${maxAttempts}.`,
    ...attempts.slice(0, -1).map((a) => `- Attempt ${a.attempt}: ${a.status}${a.category ? ` (${FAILURE_WORDS[a.category]})` : ''}${a.reason ? ` — ${a.reason}` : ''}.`),
  ].join('\n');
}
