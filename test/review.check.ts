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
import { allAboutTheTask, describeFindings, findingId, isRepeat, ReviewSchema } from '../src/protocol/reviewSchema.js';
import { reviewBrief, findingsMessage } from '../src/orchestrator/review.js';
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
show('fail, vague finding', { status: 'fail', steps: [], summary, findings: [{ what: 'broken', evidence: finding.evidence, where: finding.where }] });
show('fail, finding with no where', { status: 'fail', steps: [], summary, findings: [{ what: finding.what, evidence: finding.evidence }] });
show('pass carrying a work finding', { status: 'pass', steps: [], summary, findings: [finding] });
show('pass mixing work and task', { status: 'pass', steps: [], summary, findings: [finding, { ...finding, about: 'task' }] });

/*
 * Right work, wrong task.
 *
 * A README documenting four error messages where the task said three used to end `blocked`
 * — the reviewer's only way to say "the task is wrong" was to fail the work, and the runner
 * stopped the plan behind it. A pass may now carry findings, but only about the task.
 */
console.log('\n--- right work, wrong task: a pass with notes for whoever wrote it ---');
show('pass with a task finding', {
  status: 'pass',
  steps: [],
  summary,
  findings: [{ what: 'The task says three ways to answer 400; the controller has four, all real and all documented.', evidence: 'Four distinct BadRequestException messages; the README lists all four.', where: 'README.md, the errors section', about: 'task' }],
});

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
  where: 'README.md, the errors section',
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

/*
 * A finding that comes back.
 *
 * Rounds one and two of one review pointed at the same `where`; the implementer had reported a
 * fix between them and the checks had passed. The runner had every fact needed to ask the one
 * question that mattered — can fixing the work resolve this at all — and asked nothing.
 * Matching is by place, because two reviewers word one defect differently and a place does not
 * drift; by claim only when neither round named a place.
 */
console.log('\n--- a finding that comes back is recognised by where it points ---');
const round1 = [
  {
    what: 'The task requires jsx preserve, but web\\tsconfig.json sets it to react-jsx.',
    evidence: 'x',
    where: 'C:\\Projects\\calculator-test\\web\\tsconfig.json, compilerOptions.jsx',
    about: 'work' as const,
  },
];
const again = {
  what: 'tsconfig.json uses "jsx": "react-jsx" instead of the task-required "jsx": "preserve".',
  evidence: 'y',
  where: 'c:/projects/calculator-test/web/tsconfig.json,  compilerOptions.jsx',
  about: 'work' as const,
};
const elsewhere = { ...again, where: 'web/app/page.tsx' };
const noPlace = { what: 'The README start command returns 500.', evidence: 'z', where: '' };
console.log('same place, other words    :', isRepeat(round1, again), '(expect true)');
console.log('different place            :', isRepeat(round1, elsewhere), '(expect false)');
console.log('no place, same claim       :', isRepeat([noPlace], { ...noPlace, evidence: 'w' }), '(expect true)');
console.log('no place, other claim      :', isRepeat([noPlace], { what: 'The README install command fails.', evidence: 'w', where: '' }), '(expect false)');
console.log('first round, nothing before:', isRepeat([], again), '(expect false)');
console.log('marked when written out    :', describeFindings([again], () => true).includes('earlier round') ? 'yes' : 'NO');

/*
 * What the second reviewer is told, and what the implementer hears.
 *
 * The brief carries two things it did not before: the implementer's declared deviations, as
 * claims to test, and the previous round's findings, with the demand to decide whose problem a
 * surviving one is. The message back to the implementer names the findings that recurred and
 * points at `deviations` as the honest way out when the instruction cannot be kept.
 */
console.log('\n--- what the second round is told, and what the implementer hears ---');
const brief = reviewBrief(
  { vcs: { enabled: true, repoDir: 'C:\\Projects\\calculator-test' } } as never,
  { prompt: 'Scaffold the front end.', level2: 'No dev servers.', title: 'web-scaffold' } as never,
  ['web/tsconfig.json'],
  'C:\\Projects\\calculator-test',
  [{ instruction: 'jsx preserve', did: 'restored the value after each build', why: 'next build rewrites tsconfig.json' }],
  { round: 1, findings: [{ ...round1[0], repeated: false }] },
);
console.log('brief carries the claim    :', brief.includes('could not be done as written') && brief.includes('jsx preserve') ? 'yes' : 'NO');
console.log('brief carries round 1      :', brief.includes('What review round 1 found') ? 'yes' : 'NO');
console.log('and asks for a decision    :', brief.includes('`about`') && brief.includes('unsatisfiable') ? 'yes' : 'NO');
const plain = reviewBrief({ vcs: { enabled: false } } as never, { prompt: 'p', level2: '', title: 't' } as never, [], 'C:\\x');
console.log('first round says neither   :', !plain.includes('could not be done') && !plain.includes('review round') ? 'yes' : 'NO');
const msg = findingsMessage({ verdict: 'fail', findings: [again], stepsRun: 1, iterations: 1 }, 2, 2, [again]);
console.log('implementer told it recurred:', msg.includes('raised in the previous round') && msg.includes('`deviations`') ? 'yes' : 'NO');
const quiet = findingsMessage({ verdict: 'fail', findings: [again], stepsRun: 1, iterations: 1 }, 1, 2);
console.log('and not when it did not    :', !quiet.includes('previous round as well') ? 'yes' : 'NO');

/*
 * A wrong finding can be answered.
 *
 * The findings message used to say "say so in your summary", and the next reviewer never sees
 * the summary. Findings are now named by the runner, the implementer disputes them by name,
 * and the next brief carries the dispute as a claim to test.
 */
console.log('\n--- a finding has a name, and a dispute uses it ---');
console.log('id                         :', findingId(1, 1), findingId(2, 0), '(expect r1f2 r2f1)');
const namedFindings = [{ ...again, id: findingId(1, 0) }];
console.log('shown when written out     :', describeFindings(namedFindings).startsWith('1. [r1f1] ') ? 'yes' : 'NO');
console.log('message points at disputed :', findingsMessage({ verdict: 'fail', findings: namedFindings, stepsRun: 1, iterations: 1 }, 1, 2).includes('`disputed`') ? 'yes' : 'NO');
const disputedBrief = reviewBrief(
  { vcs: { enabled: false } } as never,
  { prompt: 'p', level2: '', title: 't' } as never,
  [],
  'C:\\x',
  [],
  { round: 1, findings: namedFindings },
  [{ finding: 'r1f1', why: 'The labels are A and B, as the task defines them.', evidence: 'The served HTML contains <label for="a">A</label>.' }],
);
console.log('brief carries the dispute  :', disputedBrief.includes('Findings the implementer disputes') && disputedBrief.includes('r1f1') ? 'yes' : 'NO');
console.log('and names the finding      :', disputedBrief.includes('[r1f1] tsconfig.json') ? 'yes' : 'NO');
