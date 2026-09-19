/**
 * The reviewer's contract, and the two rules that make it worth having.
 *
 * A review is only useful if "pass" is expensive and "fail" is actionable. Everything checked
 * here is one of those two claims:
 *
 * - A verdict needs a real summary, a `fail` needs findings, and every finding needs evidence.
 *   A reviewer with opinions and no commands cannot fail anything, which is the same rule as
 *   the one that stops it passing anything.
 * - `pass` with nothing run is refused — by the runner, not the schema, because only the runner
 *   knows how many commands were actually executed. That rule is exercised here against the
 *   real limits so a change to either half shows up.
 *
 *   npm run check:review
 */
import { parseReview } from '../src/protocol/parser.js';
import { allAboutTheTask, describeFindings, ReviewSchema } from '../src/protocol/reviewSchema.js';
import { RunConfigSchema } from '../src/config/schema.js';

const opts = { defaultShell: 'pwsh' as const };
const block = (obj: unknown): string => '```json\n' + JSON.stringify(obj) + '\n```';

const summary =
  'Built the API with npx tsc and started it with node dist/main.js; all four operations answered correctly and division by zero returned HTTP 400.';
const finding = {
  what: 'The README tells the reader to start the API with a command that returns HTTP 500 for every request.',
  evidence: 'npx tsx src/main.ts, then POST /calculate returned {"statusCode":500}; the log shows the service was never injected.',
  where: 'README.md, the Run section',
};

const show = (label: string, obj: unknown): void => {
  const r = parseReview(block(obj), opts);
  if (r.ok) {
    console.log(`${label.padEnd(34)} ok   verdict=${r.verdict.padEnd(8)} steps=${r.review.steps.length} findings=${r.review.findings.length}`);
  } else {
    console.log(`${label.padEnd(34)} FAIL ${r.detail.slice(0, 96)}`);
  }
};

console.log('--- what a reviewer is allowed to say ---');
show('continue, with steps', { status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'npm test' }] });
show('pass, properly', { status: 'pass', steps: [], summary });
show('fail, with a finding', { status: 'fail', steps: [], summary, findings: [finding] });

console.log('\n--- and what it is not ---');
show('continue with no steps', { status: 'continue', steps: [] });
show('a verdict carrying steps', { status: 'pass', steps: [{ id: 1, type: 'command', cmd: 'npm test' }], summary });
show('pass with no summary', { status: 'pass', steps: [] });
show('pass with "looks fine"', { status: 'pass', steps: [], summary: 'Looks correct.' });
show('fail with no findings', { status: 'fail', steps: [], summary });
show('fail, finding with no evidence', { status: 'fail', steps: [], summary, findings: [{ what: finding.what, evidence: '' }] });
show('fail, vague finding', { status: 'fail', steps: [], summary, findings: [{ what: 'broken', evidence: finding.evidence }] });
show('pass carrying findings', { status: 'pass', steps: [], summary, findings: [finding] });

console.log('\n--- there is no way to give up without a verdict ---');
show('blocked, as the implementer would', { status: 'blocked', steps: [], summary });

console.log('\n--- findings, written out for whoever has to fix them ---');
const parsed = ReviewSchema.safeParse({ status: 'fail', steps: [], summary, findings: [finding] });
console.log(parsed.success ? describeFindings(parsed.data.findings) : 'FAIL');

/*
 * Whose problem it is.
 *
 * The distinction that was missing, and the reason two sound tasks blocked after arguing with
 * their reviewer for two rounds: the work was right and the task was wrong, and the contract
 * had no way to say so. A finding about the task ends the task at once, because nobody
 * downstream is allowed to change the sentence that is wrong.
 */
console.log('\n--- a finding says whose problem it is ---');
const aboutWork = { ...finding, about: 'work' as const };
const aboutTask = {
  what: 'The task requires the three ways the API answers 400, but the controller has four, all of them real.',
  evidence: 'The controller throws four distinct BadRequestException messages; the README documents all four.',
  about: 'task' as const,
};
const defaulted = ReviewSchema.safeParse({ status: 'fail', steps: [], summary, findings: [finding] });
console.log('defaults to work    :', defaulted.success ? defaulted.data.findings[0].about : 'FAIL', '(expect work)');
console.log('all about the task  :', allAboutTheTask([aboutTask]), '(expect true — the task ends here)');
console.log('one of each         :', allAboutTheTask([aboutWork, aboutTask]), '(expect false — the work half goes back)');
console.log('nothing found       :', allAboutTheTask([]), '(expect false)');
console.log('written out         :');
console.log(
  describeFindings([aboutWork, aboutTask])
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n'),
);

console.log('\n--- the limits the loop is bounded by ---');
const limits = RunConfigSchema.parse({}).limits;
console.log('review rounds     :', limits.maxReviewRounds, '(expect 2 — then the task ends blocked)');
console.log('review iterations :', limits.maxReviewIterations, '(expect 12 — then the review is inconclusive)');

console.log('\n--- a reviewer that ran nothing cannot pass ---');
/*
 * The rule itself lives in the runner, where the count is known. What is asserted here is the
 * shape of the decision, so that a change to the condition has to change this line too.
 */
const wouldRefuse = (verdict: string, stepsRun: number): boolean => verdict === 'pass' && stepsRun === 0;
for (const [verdict, stepsRun] of [
  ['pass', 0],
  ['pass', 3],
  ['fail', 0],
] as const) {
  console.log(`  ${verdict} after ${stepsRun} command(s) :`, wouldRefuse(verdict, stepsRun) ? 'sent back' : 'accepted');
}
