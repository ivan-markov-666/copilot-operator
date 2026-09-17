/**
 * The contract Copilot must answer in, as a schema.
 *
 * The prose version the user pastes into the chat lives in `prompts/02-format.md`. This file
 * is the enforcement: anything that does not validate here is rejected and Copilot is asked
 * to resend. Being strict is deliberate. A half-understood reply that still parses is worse
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

export const ReplySchema = z
  .object({
    status: z.enum(['continue', 'done']),
    steps: z.array(StepSchema).default([]),
    notes: z.string().optional(),
  })
  .refine((r) => r.status === 'done' || r.steps.length > 0, {
    message:
      'status "continue" with an empty steps array would stall the run. ' +
      'Send at least one step, or set status to "done".',
  });

export type Step = z.infer<typeof StepSchema>;
export type CommandStepT = z.infer<typeof CommandStep>;
export type DownloadStepT = z.infer<typeof DownloadStep>;
export type Reply = z.infer<typeof ReplySchema>;

export function isDownloadStep(s: Step): s is DownloadStepT {
  return s.type === 'download';
}
