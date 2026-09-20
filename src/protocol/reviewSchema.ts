/**
 * The contract a reviewing conversation answers in.
 *
 * A review is a second conversation, opened after a task has finished and its checks have
 * passed, that is shown the task and the result and asked whether the one satisfies the other.
 * It is deliberately a different contract from the implementer's, because it is a different
 * job with a different failure mode. An implementer that ends wrongly says "done" when it is
 * not; a reviewer that ends wrongly says "pass" when it has not looked.
 *
 * So the shape of this schema is almost entirely about making "pass" expensive and "fail"
 * useful:
 *
 * - `pass` needs a summary that says what was checked, not that it was checked. The runner
 *   adds the part a schema cannot see — a review that ran no commands at all cannot pass,
 *   whatever it writes here.
 * - `fail` needs findings, and every finding needs evidence: the command and what it
 *   returned. A reviewer that only has opinions cannot fail anything either, which is the
 *   same rule from the other side.
 *
 * The prose version the reviewer is sent lives in `prompts/review1.md`.
 */
import { z } from 'zod';
import { CheckInput } from '../plan/schema.js';
import { StepSchema } from './replySchema.js';

export const MIN_REVIEW_SUMMARY_CHARS = 40;

/**
 * One thing that is wrong, with what proves it.
 *
 * Both halves are required and neither can be waved through. "The README is wrong" is not
 * actionable; "the README says to start the API with `npx tsx src/main.ts`, and running it
 * returns HTTP 500 on every request" is a defect somebody can fix without repeating the work.
 */
const Finding = z.object({
  what: z
    .string()
    .trim()
    .min(15, 'A finding needs a sentence naming what is wrong, specifically enough to act on.'),
  evidence: z
    .string()
    .trim()
    .min(10, 'A finding needs evidence: the command you ran and what it actually returned.'),
  /** The file, the endpoint, the line — wherever the defect lives. */
  /**
   * Required, because it is how the same defect is recognised between rounds. Two reviewers
   * word one problem differently; a file and a place in it do not drift. A first-round
   * finding without one made a second-round repeat invisible, and the loop ran a third time.
   */
  where: z.string().trim().min(3, {
    message: 'A finding needs "where": the file and the place in it, or the URL, that the finding is about.',
  }),
  /**
   * The mechanical test that would have caught this, in the plan's own check shape.
   *
   * A review is judgement, and judgement varies: the same missing `@HttpCode(200)` was found
   * in one run and missed in the next. A finding that carries its check turns the one thing
   * the reviewer noticed into arithmetic the runner repeats on every later attempt. The runner
   * runs it at once, on the work as it stands: a check that passes on the defective state does
   * not capture the defect, and is refused.
   */
  check: CheckInput.optional(),
  /**
   * Whose problem this is, and the only field here that changes what happens next.
   *
   * `work` — the work does not do what the task asked. Somebody can fix it, so it goes back.
   * `task` — the work is right and the **task** is wrong: it contradicts itself, it demands
   *   something the project instructions forbid, or it expects something that is not true of
   *   this machine. Nobody downstream can fix that, so the task stops and says so.
   *
   * Without this, a reviewer holding a contradictory task had only one move — fail the work —
   * and the implementer, who may not change the task, had only one answer: it cannot. Two
   * rounds of that and the task blocked with a finding that was never about the work. Three
   * such findings in one run: a README documenting four error messages where the task said
   * three (the code has four), a README whose start commands could not be run because the
   * project instructions forbid starting servers, and an audit expected to find no git remote
   * in a repository that has one.
   */
  about: z.enum(['work', 'task']).default('work'),
});

export type ReviewFinding = z.infer<typeof Finding>;

export const ReviewSchema = z
  .object({
    /**
     * `continue` — steps to run, send me the output.
     * `pass` — I checked it by running things, and it does what the task asked.
     * `fail` — I checked it by running things, and here is what is wrong.
     *
     * There is no "blocked" here. A reviewer that cannot check something says so as a finding
     * and fails: "I could not verify X because Y" is information the operator needs, and
     * quietly passing work nobody could check is the one outcome worth ruling out.
     */
    status: z.enum(['continue', 'pass', 'fail']),
    steps: z.array(StepSchema).default([]),
    notes: z.string().optional(),
    /** Required on `pass` and `fail`: what you checked, how, and what you saw. */
    summary: z.string().optional(),
    findings: z.array(Finding).default([]),
  })
  .refine((r) => r.status !== 'continue' || r.steps.length > 0, {
    message: 'status "continue" with no steps would stall the review. Send steps, or reach a verdict.',
  })
  .refine((r) => r.status === 'continue' || r.steps.length === 0, {
    message: 'A verdict ends the review, so "pass" and "fail" cannot carry steps. Run them first with "continue".',
  })
  .refine((r) => r.status === 'continue' || (r.summary ?? '').trim().length >= MIN_REVIEW_SUMMARY_CHARS, {
    message:
      'A verdict requires a summary: what you checked, what you ran, and what you saw. ' +
      'Not "it looks correct" — the commands and their output.',
  })
  .refine((r) => r.status !== 'fail' || r.findings.length > 0, {
    message: 'status "fail" requires at least one entry in "findings", each with "what" and "evidence".',
  })
  /*
   * A pass may carry findings about the task, and only about the task.
   *
   * Without this the reviewer holding right work and a wrong task had one move — fail the
   * work — and the runner then ended the task `blocked` over a sentence that was never in the
   * work, stopping the plan behind it. A README documenting four error messages where the task
   * said three is `done`, with a note for whoever wrote "three"; it is not a failure.
   */
  .refine((r) => r.status !== 'pass' || r.findings.every((f) => f.about === 'task'), {
    message:
      'status "pass" can carry findings only with "about": "task" — the work is right and the task is wrong. ' +
      'A finding about the work makes the verdict "fail"; a minor point goes in "summary", not in "findings".',
  });

export type Review = z.infer<typeof ReviewSchema>;

/** The findings written out for whoever has to act on them. */
export function describeFindings(findings: ReviewFinding[], isRepeated?: (f: ReviewFinding) => boolean): string {
  return findings
    .map((f, i) => {
      const id = (f as { id?: string }).id;
      const where = f.where?.trim() ? ` (${f.where.trim()})` : '';
      const about = f.about === 'task' ? ' [about the task, not the work]' : '';
      const again = isRepeated?.(f) ? ' [raised in an earlier round too]' : '';
      return `${i + 1}. ${id ? `[${id}] ` : ''}${f.what}${where}${about}${again}\n   Evidence: ${f.evidence}`;
    })
    .join('\n\n');
}

/**
 * The name a finding is referred to by, once the runner has it: round and position.
 *
 * Given by the runner rather than the reviewer so that it is unique across rounds and cannot
 * be forgotten. It is what the implementer names in `disputed`, and what the record shows.
 */
export function findingId(round: number, index: number): string {
  return `r${round}f${index + 1}`;
}

/** True when nothing the reviewer found is something the implementer could fix. */
export function allAboutTheTask(findings: ReviewFinding[]): boolean {
  return findings.length > 0 && findings.every((f) => f.about === 'task');
}

/** A `where`, normalised enough that two reviewers describing the same place agree. */
function placeKey(where: string | undefined): string {
  return (where ?? '').toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
}

function claimKey(what: string): string {
  return what.toLowerCase().replace(/[`"'*_]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Whether a finding is one an earlier round already raised.
 *
 * Two reviewers are two conversations, so the wording of `what` drifts between rounds; the
 * `where` does not, because it names a file and a place in it. So a finding is the same
 * finding when it points at the same place, and only when neither round said where, when it
 * makes the same claim word for word. The signal this feeds is one the runner otherwise threw
 * away: in one run the same `where` came back in rounds one and two, the implementer had
 * reported it fixed in between, the checks had passed, and nobody was asked the only question
 * that mattered — whether fixing the work could resolve it at all.
 */
export function isRepeat(previous: ReviewFinding[], finding: ReviewFinding): boolean {
  const place = placeKey(finding.where);
  if (place) return previous.some((p) => placeKey(p.where) === place);
  const claim = claimKey(finding.what);
  return previous.some((p) => !placeKey(p.where) && claimKey(p.what) === claim);
}
