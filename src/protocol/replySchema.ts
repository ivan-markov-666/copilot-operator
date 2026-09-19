/**
 * The contract Copilot must answer in, as a schema.
 *
 * The prose version the user pastes into the chat lives in `prompts/level1.md`. This file is
 * the enforcement: anything that does not validate here is rejected and Copilot is asked to
 * resend. Being strict is deliberate. A half-understood reply that still parses is worse
 * than a rejected one, because it runs commands nobody intended.
 */
import { z } from 'zod';

export const ShellSchema = z.enum(['pwsh', 'powershell', 'cmd']);

const CommandStep = z.object({
  id: z.number().int().positive(),
  type: z.literal('command'),
  shell: ShellSchema.optional(),
  cmd: z.string().min(1),
  expect: z.enum(['fast', 'long']).optional(),
  timeoutSec: z.number().int().positive().optional(),
  idleTimeoutSec: z.number().int().positive().optional(),
});

const DownloadStep = z.object({
  id: z.number().int().positive(),
  type: z.literal('download'),
  /** Must match a file attached to the same reply, character for character. */
  file: z.string().min(1),
  run: z.boolean().default(false),
  shell: ShellSchema.optional(),
  args: z.array(z.string()).default([]),
  expect: z.enum(['fast', 'long']).optional(),
  timeoutSec: z.number().int().positive().optional(),
  idleTimeoutSec: z.number().int().positive().optional(),
});

export const StepSchema = z.discriminatedUnion('type', [CommandStep, DownloadStep]);

/**
 * The shortest `summary` that counts as an explanation. Below this it is a label, not the
 * deliverable the user asked for, and the reply is sent back.
 */
export const MIN_SUMMARY_CHARS = 40;

/**
 * How many different approaches must have been tried before a task may be given up on.
 *
 * Two is not a high bar, and that is the point: it is not meant to make giving up hard, it is
 * meant to make it deliberate. A model that has tried one thing has not found a wall, it has
 * found a first attempt, and the field forces that distinction to be written down where a
 * person can read it and disagree.
 */
export const MIN_TRIED_APPROACHES = 2;

export const ReplySchema = z
  .object({
    /**
     * How this reply ends the exchange, or does not.
     *
     * `continue` — here are steps to run, send me the output.
     * `done` — the work is finished and verified, and `summary` says so.
     * `blocked` — the work cannot be finished, and here is what was tried and what is in the way.
     *
     * `blocked` exists because the alternative is worse. Without it a model that has run out of
     * ideas either claims `done` on work it did not do, or keeps sending steps until a limit
     * cuts it off — and the second one has happened for fifteen iterations at a stretch, each
     * costing a message, a reply and a report, and ending in a timeout that says nothing about
     * why. A task that stops with "I tried these three things and this is in the way" is a
     * result. A task that runs out of iterations is not.
     */
    status: z.enum(['continue', 'done', 'blocked']),
    steps: z.array(StepSchema).default([]),
    notes: z.string().optional(),
    /**
     * Required when `status` is `done` or `blocked`: what was done, in what order, what the
     * result is, and what the user should know. Shown in the UI as the outcome of the task.
     */
    summary: z.string().optional(),
    /**
     * Required when `status` is `blocked`: the distinct approaches that were tried, one per
     * entry. "Ran it again" is not an approach.
     */
    tried: z.array(z.string().trim().min(1)).default([]),
    /** What would unblock it: a decision, a credential, a missing file, a corrected task. */
    needed: z.string().optional(),
  })
  .refine((r) => r.status !== 'continue' || r.steps.length > 0, {
    message:
      'status "continue" with an empty steps array would stall the run. ' +
      'Send at least one step, or set status to "done" or "blocked".',
  })
  .refine((r) => r.status === 'continue' || r.steps.length === 0, {
    message:
      'status "done" and status "blocked" both end the task, so they cannot carry steps. ' +
      'Send the steps with status "continue" first, then end.',
  })
  .refine((r) => r.status !== 'done' || (r.summary ?? '').trim().length >= MIN_SUMMARY_CHARS, {
    message:
      'status "done" requires a real summary: several sentences explaining what was done, ' +
      'what the result is, and what the user should know. Put it in the "summary" field.',
  })
  .refine((r) => r.status !== 'blocked' || (r.summary ?? '').trim().length >= MIN_SUMMARY_CHARS, {
    message:
      'status "blocked" requires a summary too: what state the work is in, what is done and ' +
      'what is not, so somebody can pick it up from where you stopped.',
  })
  .refine((r) => r.status !== 'blocked' || r.tried.length >= MIN_TRIED_APPROACHES, {
    message:
      `status "blocked" requires "tried": at least ${MIN_TRIED_APPROACHES} genuinely different ` +
      'approaches you attempted, one per array entry. Running the same command again is not a ' +
      'second approach. If you have only tried one thing, try another before giving up.',
  });

export type Step = z.infer<typeof StepSchema>;
export type CommandStepT = z.infer<typeof CommandStep>;
export type DownloadStepT = z.infer<typeof DownloadStep>;
export type Reply = z.infer<typeof ReplySchema>;

export function isDownloadStep(s: Step): s is DownloadStepT {
  return s.type === 'download';
}
