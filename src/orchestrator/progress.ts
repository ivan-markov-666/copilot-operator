/**
 * Whether a task is still getting anywhere, judged from what happened rather than from what the
 * chat says about it.
 *
 * The runner already stops two kinds of loop: the same command sent again with the same result
 * (`maxCommandRepeats`), and a whole round of steps it refused (`maxStalledIterations`). What those
 * miss is the loop in which every round looks new: a different command each time that fails the
 * same way while no file changes; changes made in one round and undone in the next, over and over;
 * "done" said again with the same checks failing and nothing touched since they were reported. Each
 * of those ran until the iteration limit and ended "limit reached" with a reason that explained
 * nothing. Here each is recognised and ends the task `blocked` with a diagnosis saying which one it
 * was and what the evidence is, so the operator knows what to change before running it again.
 *
 * "No file changed" is read from the working tree (`treeFingerprint` in git.ts), so these signals
 * are only on when the session works in a git repository. Without one this watches nothing and
 * the older guards still apply.
 */

/** One step as far as this cares: how it ended and what it printed. */
export type StepEnd = { outcome: string; exitCode: number; stdout: string; stderr: string };

export type ProgressLimits = {
  /** Rounds in a row that fail the same way with no file changed, before the task is stopped. */
  noProgress: number;
  /** Times the tree returns to the state of two rounds before, before the task is stopped. */
  oscillations: number;
};

/** The failure a round ended with, reduced to what stays the same when only the wording changes. */
export function failureSignature(results: StepEnd[]): string | null {
  if (results.length === 0) return null;
  // A round in which anything ran and succeeded made progress of some kind.
  if (results.some((r) => r.outcome === 'completed' && r.exitCode === 0)) return null;
  const failed = results.filter((r) => r.outcome === 'completed' && r.exitCode !== 0);
  if (failed.length === 0) return null;
  return failed
    .map((r) => {
      const text = (r.stderr.trim() || r.stdout.trim()).slice(-600);
      // Numbers are masked (times, line numbers, process ids) and space collapsed: a different
      // command that dies of the same error still reads the same.
      return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    })
    .sort()
    .join('\n');
}

export class ProgressWatch {
  private readonly trees: string[] = [];
  private oscillations = 0;
  private lastFailure: { signature: string; tree: string } | null = null;
  private sameFailure = 1;
  private lastChecks: { key: string; tree: string } | null = null;

  constructor(private readonly limits: ProgressLimits) {}

  /**
   * After a round of steps. `tree` is the working tree's fingerprint after it, or null when there is
   * no repository to read. Returns why the task should stop, or null to go on.
   */
  afterRound(tree: string | null, results: StepEnd[]): string | null {
    if (tree === null) return null;

    const previous = this.trees.at(-1);
    const beforeThat = this.trees.at(-2);
    if (beforeThat !== undefined && tree === beforeThat && tree !== previous) {
      this.oscillations += 1;
      if (this.oscillations >= this.limits.oscillations) {
        return (
          `no progress: the files went back to how they were two rounds earlier ${this.oscillations} times — ` +
          'changes made in one round and undone in the next. The task was stopped rather than left to run out of iterations. ' +
          'The two approaches it switches between are in the iteration reports; decide between them in the prompt.'
        );
      }
    }
    this.trees.push(tree);

    const signature = failureSignature(results);
    if (signature === null) {
      this.lastFailure = null;
      this.sameFailure = 1;
      return null;
    }
    if (this.lastFailure && this.lastFailure.signature === signature && this.lastFailure.tree === tree) {
      this.sameFailure += 1;
    } else {
      this.sameFailure = 1;
    }
    this.lastFailure = { signature, tree };
    if (this.sameFailure >= this.limits.noProgress) {
      const example = signature.split('\n')[0]!.slice(-240);
      return (
        `no progress: ${this.sameFailure} rounds in a row ended with the same error and no file changed, ` +
        `though the commands differed. The error: "${example}". The task was stopped rather than left to run out of iterations; ` +
        'the cause is probably outside what the chat can change — read the last report.'
      );
    }
    return null;
  }

  /**
   * After "done" was answered with failing checks. Returns why the task should stop when this is the
   * same failure as last time with nothing changed in between.
   */
  afterFailedChecks(tree: string | null, failing: Array<{ name: string; detail: string }>): string | null {
    if (tree === null) return null;
    const key = failing
      .map((f) => `${f.name}\u0000${f.detail.toLowerCase().replace(/\d+/g, '#')}`)
      .sort()
      .join('\n');
    const same = this.lastChecks && this.lastChecks.key === key && this.lastChecks.tree === tree;
    this.lastChecks = { key, tree };
    if (!same) return null;
    return (
      `no progress: "done" was said again with the same ${failing.length} check(s) failing ` +
      `(${failing.map((f) => f.name).join(', ')}) and no file changed since they were reported. ` +
      'The task was stopped rather than spend its remaining check rounds the same way.'
    );
  }
}
