/**
 * Checks that come from review findings, and what happens to them over a task's life.
 *
 * A review is judgement, and judgement varies between runs: the same missing `@HttpCode(200)`
 * was found by one reviewer and missed by the next. So a reviewer may give, with a finding,
 * the mechanical test that would have caught it, in the plan's own check shape — and from
 * then on the runner repeats it, on this attempt and on every later one. Three rules keep that
 * from turning a wrong finding into a permanent wall:
 *
 *   - A check is kept only if it fails on the work as it stands. One that passes on the
 *     defective state does not capture the defect; it is refused, and the reviewer is told.
 *   - A dispute suspends the finding's check until the next review rules: raised again, the
 *     check comes back; not raised, it is dropped. A counter never overrules a person.
 *   - A derived check sends the work back like any other, but never ends the task by itself.
 *     With the rounds spent and only derived checks failing, the work goes to the reviewer
 *     with those failures named. The next reviewer's judgement outranks the last one's check.
 */
import { join } from 'node:path';
import { runCheck, type CheckOutcome, type CheckRunOptions } from '../exec/checks.js';
import { isRepeat, type ReviewFinding } from '../protocol/reviewSchema.js';
import type { TaskCheck, TaskReviewCheck } from '../session/model.js';

/** How a derived check is named in the gate, so its result is recognisable and cannot clash. */
export function derivedCheckName(findingId: string, name: string): string {
  return `review ${findingId}: ${name}`;
}

export function isDerivedCheck(check: TaskCheck): boolean {
  return /^review (?:a\d+)?r\d+f\d+: /.test(check.name);
}

/**
 * Kept checks written before a finding's id carried its attempt, given the id it carries now.
 *
 * Those records hold `r1f1` for attempt 1's first finding and again for attempt 2's, under one check
 * name, and a dispute, a deferral or a drop aimed at one acted on both. Renamed from the attempt each
 * was made on (see `findingId`), check name included, so the gate and the implementer see the same
 * name a dispute can then use. A check of the first attempt, and one already renamed, is left as it is.
 */
export function withAttemptIds(reviewChecks: TaskReviewCheck[]): TaskReviewCheck[] {
  return reviewChecks.map((rc) => {
    if ((rc.attempt ?? 1) <= 1 || !/^r\d+f\d+$/.test(rc.findingId)) return rc;
    const id = `a${rc.attempt}${rc.findingId}`;
    const before = derivedCheckName(rc.findingId, '');
    const name = rc.check.name.startsWith(before) ? derivedCheckName(id, rc.check.name.slice(before.length)) : rc.check.name;
    return { ...rc, findingId: id, check: { ...rc.check, name } };
  });
}

export type DerivedValidation = {
  kept: Array<{ finding: ReviewFinding & { id: string }; check: TaskCheck; outcome: CheckOutcome }>;
  /** The check passed on the work as it is, so it does not capture the defect. */
  refused: Array<{ finding: ReviewFinding & { id: string }; check: TaskCheck; outcome: CheckOutcome }>;
  /**
   * The runner refused the check itself — outside the project, or a refused command — so it never
   * ran. It is kept out of both lists above: "kept only if it fails now" would have kept it, since a
   * refusal reports as a failure, and a check that can never run would then fail the task forever.
   * The finding stands without it.
   */
  blocked: Array<{ finding: ReviewFinding & { id: string }; check: TaskCheck; outcome: CheckOutcome }>;
};

/**
 * Runs each finding's check on the current state. Kept if it fails now, refused if it passes.
 */
export async function validateDerivedChecks(
  findings: Array<ReviewFinding & { id: string }>,
  opts: {
    cwd: string;
    logDir: string;
    repoDir?: string;
    deny?: CheckRunOptions['deny'];
    roots?: CheckRunOptions['roots'];
    signal?: AbortSignal;
    defaultShell?: CheckRunOptions['defaultShell'];
    tracker?: CheckRunOptions['tracker'];
    passEnv?: CheckRunOptions['passEnv'];
    redactPatterns?: CheckRunOptions['redactPatterns'];
  },
): Promise<DerivedValidation> {
  const out: DerivedValidation = { kept: [], refused: [], blocked: [] };
  for (const [i, finding] of findings.entries()) {
    if (!finding.check) continue;
    const check: TaskCheck = { ...finding.check, name: derivedCheckName(finding.id, finding.check.name) };
    const outcome = await runCheck(check, 500 + i, {
      cwd: opts.cwd,
      logDir: join(opts.logDir, 'derived'),
      repoDir: opts.repoDir,
      deny: opts.deny,
      roots: opts.roots,
      signal: opts.signal,
      defaultShell: opts.defaultShell,
      tracker: opts.tracker,
      passEnv: opts.passEnv,
      redactPatterns: opts.redactPatterns,
    });
    if (outcome.refusedBeforeRunning) out.blocked.push({ finding, check, outcome });
    else (outcome.passed ? out.refused : out.kept).push({ finding, check, outcome });
  }
  return out;
}

/** The derived checks that run in the gate. */
export function activeChecks(reviewChecks: TaskReviewCheck[]): TaskCheck[] {
  return reviewChecks.filter((rc) => rc.state === 'active').map((rc) => rc.check);
}

/** A dispute of a finding suspends its check until the next review rules. */
export function suspendDisputed(reviewChecks: TaskReviewCheck[], disputedIds: string[]): { checks: TaskReviewCheck[]; suspended: string[] } {
  const ids = new Set(disputedIds.map((d) => d.trim().toLowerCase()));
  const suspended: string[] = [];
  const checks = reviewChecks.map((rc) => {
    if (rc.state !== 'active' || !ids.has(rc.findingId.toLowerCase())) return rc;
    suspended.push(rc.findingId);
    return { ...rc, state: 'suspended' as const };
  });
  return { checks, suspended };
}

/**
 * What a review's verdict does to suspended checks: raised again, back to active; not raised,
 * dropped — the dispute stood. On a pass every suspended one is dropped.
 */
export function settleAfterReview(
  reviewChecks: TaskReviewCheck[],
  verdict: 'pass' | 'fail',
  newFindings: ReviewFinding[],
): { checks: TaskReviewCheck[]; reactivated: string[]; dropped: string[] } {
  const reactivated: string[] = [];
  const dropped: string[] = [];
  const checks = reviewChecks.map((rc) => {
    if (rc.state !== 'suspended') return rc;
    const raisedAgain = verdict === 'fail' && newFindings.some((f) => isRepeat([{ what: rc.what, evidence: '', basis: '', where: rc.where ?? '', about: 'work' as const }], f));
    if (raisedAgain) {
      reactivated.push(rc.findingId);
      return { ...rc, state: 'active' as const };
    }
    dropped.push(rc.findingId);
    return { ...rc, state: 'dropped' as const };
  });
  return { checks, reactivated, dropped };
}

/** Whether the failures left are all derived, which is when the work goes to the reviewer anyway. */
export function onlyDerivedFailing(outcomes: CheckOutcome[]): boolean {
  const failed = outcomes.filter((o) => !o.passed);
  return failed.length > 0 && failed.every((o) => isDerivedCheck(o.check));
}
