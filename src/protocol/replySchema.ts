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
  /*
   * The only kind of step there is.
   *
   * There used to be a second, `download`: the chat attached a file and the runner fetched it and
   * ran it. That is gone — not disabled, removed — because a process that fetches a file and
   * executes it is a loader whatever its intentions, and it is what put a security team on the
   * phone. The message below is what a chat still writing the old form is told, since the reply
   * comes straight back to it and "invalid literal" would teach it nothing.
   */
  type: z.literal('command', {
    error:
      'this runner has no file steps: it never fetches or runs a file the chat provides. Every step is ' +
      'a `command`. For something too long for one line, write the file with Set-Content in one command ' +
      'step and run it with its interpreter in the next.',
  }),
  shell: ShellSchema.optional(),
  cmd: z.string().min(1),
  expect: z.enum(['fast', 'long']).optional(),
  timeoutSec: z.number().int().positive().optional(),
  idleTimeoutSec: z.number().int().positive().optional(),
});


export const StepSchema = CommandStep;

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

/**
 * One instruction that was not followed as written, and what was done instead.
 *
 * The field exists because the alternative was prose, and prose is where two real decisions
 * went to die in one run. A task required `moduleResolution node`; the TypeScript that
 * `npm install` fetched had removed it, so the implementer pinned an older TypeScript in one
 * package of a repository whose other package kept the new one, and said so in `notes`. A task
 * required `jsx preserve`; `next build` rewrote the file after every run, so the implementer
 * restored the value after each build, and said so in `notes`. Nobody reads `notes`: not the
 * reviewer, which is denied the implementer's account on purpose; not the commit message; not
 * the register. Both were product decisions taken by a model and recorded nowhere anyone
 * would look.
 *
 * As data, a deviation goes three places: onto the task and into the commit, where a person
 * finds it; and to the reviewer, as a claim to test rather than an account to trust. A true
 * claim is a finding about the task; a false one is a finding about the work. Either way the
 * `about: task` path finally has an entrance that does not depend on the reviewer noticing on
 * its own.
 */
export const DeviationSchema = z.object({
  /** The instruction, quoted or closely paraphrased, so it can be found in the task text. */
  instruction: z.string().trim().min(1),
  /** What was done instead. */
  did: z.string().trim().min(1),
  /** Why the instruction could not be followed as written: the error, the version, the fact. */
  why: z.string().trim().min(1),
});

export type Deviation = z.infer<typeof DeviationSchema>;

/**
 * A review finding the implementer says is wrong, with what shows it.
 *
 * The findings message used to say "if you believe a finding is wrong, say so in your summary
 * with the evidence" — and the next reviewer never sees the summary, on purpose. So a wrong
 * finding had no way to be answered: in one run a reviewer searched the page for label text
 * the task never specified, found none, and the implementer — having objected once, in prose,
 * to nobody — renamed the labels to match. As data, a dispute goes to the next reviewer as a
 * claim to test, and to the record. The finding is named by the id the runner gave it.
 */
export const DisputeSchema = z.object({
  /** The finding's id as it was given: `r1f2`. */
  finding: z.string().trim().min(1),
  /** Why it is wrong. */
  why: z.string().trim().min(1),
  /** What shows it: the command run and what came back, quoted. */
  evidence: z.string().trim().min(1),
});

export type Dispute = z.infer<typeof DisputeSchema>;

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
    /**
     * Instructions that could not be followed as written, with what was done instead and why.
     * Accepted on any reply, because a deviation is made when it is made, not at the end; the
     * runner keeps them for the task and merges repeats by instruction.
     */
    deviations: z.array(DeviationSchema).default([]),
    /**
     * Review findings the implementer says are wrong, by id, with evidence. Accepted on any
     * reply; the runner keeps them for the task and hands them to the next reviewer.
     */
    disputed: z.array(DisputeSchema).default([]),
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
export type Reply = z.infer<typeof ReplySchema>;


/** What makes two deviations the same one: the instruction, ignoring case and spacing. */
function deviationKey(d: Deviation): string {
  return d.instruction.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The deviations a task has declared so far, with a new reply's merged in.
 *
 * A deviation reported in iteration 5 must survive a `done` in iteration 12 that does not
 * repeat it, and a `done` that does repeat it must not list it twice. The instruction keeps
 * the wording it was first declared with — that is the one written when it happened — while
 * `did` and `why` take the latest, so a reason refined as the work goes on is not lost.
 */
export function mergeDeviations(existing: Deviation[], incoming: Deviation[]): Deviation[] {
  const merged = new Map<string, Deviation>();
  for (const d of [...existing, ...incoming]) {
    const key = deviationKey(d);
    merged.set(key, { instruction: merged.get(key)?.instruction ?? d.instruction, did: d.did, why: d.why });
  }
  return [...merged.values()];
}

/** The deviations written out, for the commit message and the record. */
export function describeDeviations(deviations: Deviation[]): string {
  return deviations
    .map((d, i) => `${i + 1}. Instruction: ${d.instruction}\n   Did instead: ${d.did}\n   Because: ${d.why}`)
    .join('\n\n');
}

/**
 * The deviations a task carries after a reply.
 *
 * A `continue` adds to the list. A `done` or `blocked` that carries deviations replaces it,
 * because the closing reply is the final account: a deviation declared mid-way and undone
 * since — `moduleResolution` set to Node16, then back to `node` once TypeScript was pinned —
 * stood in the commit as a fact. A closing reply that names none keeps what was declared,
 * because forgetting to repeat is more common than meaning to retract.
 */
export function resolveDeviations(existing: Deviation[], status: Reply['status'], incoming: Deviation[]): Deviation[] {
  if (status !== 'continue' && incoming.length > 0) return mergeDeviations([], incoming);
  return mergeDeviations(existing, incoming);
}

/** Disputes so far with a reply's merged in: one per finding id, latest wording wins. */
export function mergeDisputes(existing: Dispute[], incoming: Dispute[]): Dispute[] {
  const merged = new Map<string, Dispute>();
  for (const d of [...existing, ...incoming]) merged.set(d.finding.toLowerCase().trim(), d);
  return [...merged.values()];
}

/** The disputes written out, for the record and the next reviewer. */
export function describeDisputes(disputes: Dispute[]): string {
  return disputes.map((d, i) => `${i + 1}. Finding ${d.finding}: ${d.why}\n   Evidence: ${d.evidence}`).join('\n\n');
}
