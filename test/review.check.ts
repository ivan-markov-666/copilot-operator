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
import { allAboutTheTask, describeFindings, findingId, isGrounded, isRepeat, ReviewSchema } from '../src/protocol/reviewSchema.js';
import { reviewBrief, findingsMessage, ungroundedMessage, deliverableFor } from '../src/orchestrator/review.js';
import { earlierTasksForReview } from '../src/orchestrator/taskRunner.js';
import { RunConfigSchema } from '../src/config/schema.js';

const opts = { defaultShell: 'pwsh' as const };
const block = (obj: unknown): string => '```json\n' + JSON.stringify(obj) + '\n```';

const summary =
  'Built the API with npx tsc and started it with node dist/main.js; all four operations answered correctly and division by zero returned HTTP 400.';
const finding = {
  what: 'The README tells the reader to start the API with a command that returns HTTP 500 for every request.',
  evidence: 'npx tsx src/main.ts, then POST /calculate returned {"statusCode":500}; the log shows the service was never injected.',
  basis: 'run the commands it tells a reader to run, exactly as written, and show that they work',
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
show('fail, finding with no where', { status: 'fail', steps: [], summary, findings: [{ what: finding.what, evidence: finding.evidence, basis: finding.basis }] });
show('fail, finding with no basis', { status: 'fail', steps: [], summary, findings: [{ what: finding.what, evidence: finding.evidence, where: finding.where }] });
show('fail, finding with a check', { status: 'fail', steps: [], summary, findings: [{ ...finding, check: { name: 'the start command answers', expect: 'output-contains', run: 'curl -s http://127.0.0.1:4300/calculate', value: '200' } }] });
show('fail, malformed check', { status: 'fail', steps: [], summary, findings: [{ ...finding, check: { name: 'the start command answers', expect: 'output-contains' } }] });
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
  findings: [{ what: 'The task says three ways to answer 400; the controller has four, all real and all documented.', evidence: 'Four distinct BadRequestException messages; the README lists all four.', basis: 'the three ways it refuses', where: 'README.md, the errors section', about: 'task' }],
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
  basis: 'every way it answers 400, with the message each one gives',
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
    basis: 'jsx preserve, module esnext',
    where: 'C:\\Projects\\calculator-test\\web\\tsconfig.json, compilerOptions.jsx',
    about: 'work' as const,
  },
];
const again = {
  what: 'tsconfig.json uses "jsx": "react-jsx" instead of the task-required "jsx": "preserve".',
  evidence: 'y',
  basis: 'jsx preserve, module esnext',
  where: 'c:/projects/calculator-test/web/tsconfig.json,  compilerOptions.jsx',
  about: 'work' as const,
};
const elsewhere = { ...again, where: 'web/app/page.tsx' };
const noPlace = { what: 'The README start command returns 500.', evidence: 'z', basis: 'run the commands it tells', where: '' };
console.log('same place, other words    :', isRepeat(round1, again), '(expect true)');
console.log('different place            :', isRepeat(round1, elsewhere), '(expect false)');
console.log('no place, same claim       :', isRepeat([noPlace], { ...noPlace, evidence: 'w' }), '(expect true)');
console.log('no place, other claim      :', isRepeat([noPlace], { what: 'The README install command fails.', evidence: 'w', basis: 'run the commands it tells', where: '' }), '(expect false)');
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

/*
 * A task whose product is its closing account.
 *
 * A repository audit changed no files, so the reviewer — blind to summaries by design — was
 * shown a task and an empty change list, and failed it for "not delivering the audit summary"
 * that the implementer had in fact written. The account travels only when the runner knows
 * there is nothing else: version control saw no change, or the task was read-only. Without
 * version control it cannot know, and the reviewer stays blind.
 */
console.log('\n--- the closing account is the product when nothing changed ---');
const audit = 'Branches: main at 096fab9. 8 commits, 18 tracked files, clean tree, nothing pushed.';
const noFiles = deliverableFor({ readOnly: false }, audit, true, []);
const someFiles = deliverableFor({ readOnly: false }, audit, true, ['README.md']);
const readOnly = deliverableFor({ readOnly: true }, audit, true, ['web/page.tsx']);
const untracked = deliverableFor({ readOnly: false }, audit, false, []);
const empty = deliverableFor({ readOnly: true }, '   ', true, []);
console.log('no files, tracked          :', noFiles?.why === 'no-files-changed' ? 'delivered' : 'NOT delivered (wrong)');
console.log('files changed              :', someFiles === undefined ? 'blind' : 'DELIVERED (wrong)');
console.log('read-only, files changed   :', readOnly?.why === 'read-only' ? 'delivered' : 'NOT delivered (wrong)');
console.log('no version control         :', untracked === undefined ? 'blind' : 'DELIVERED (wrong)');
console.log('blank summary              :', empty === undefined ? 'nothing to deliver' : 'DELIVERED (wrong)');
const auditBrief = reviewBrief(
  { vcs: { enabled: true, repoDir: 'C:\\x' } } as never,
  { prompt: 'Audit the repository and report.', level2: '', title: 'repo-audit' } as never,
  [],
  'C:\\x',
  [],
  undefined,
  [],
  [],
  [],
  noFiles,
);
console.log('brief carries the account  :', auditBrief.includes('What the implementer delivered') && auditBrief.includes(audit) ? 'yes' : 'NO');
console.log('as claims to test          :', auditBrief.includes('every statement in it is a claim') ? 'yes' : 'NO');
console.log('and not otherwise          :', !plain.includes('What the implementer delivered') ? 'yes' : 'NO');
const msg = findingsMessage({ verdict: 'fail', findings: [again], stepsRun: 1, iterations: 1 }, 2, 2, [again]);
console.log('implementer told it recurred:', msg.includes('raised in the previous round') && msg.includes('`deviations`') ? 'yes' : 'NO');
const quiet = findingsMessage({ verdict: 'fail', findings: [again], stepsRun: 1, iterations: 1 }, 1, 2);
console.log('and not when it did not    :', !quiet.includes('previous round as well') ? 'yes' : 'NO');

/*
 * A reviewer that leaves its own server listening and then finds the port busy.
 *
 * Twice in one task: round one and round two each left `next start` on 4310, found 4310 busy,
 * and gave a check that "failed on the defective state" — the defect being its own. Both
 * sides are now told what the review left running, and the check is judged only after the
 * runner has stopped it.
 */
console.log('\n--- what a review left running is said to both sides ---');
const portFinding = { ...again, what: 'Port 4310 was still listening after the server was stopped.', where: 'runtime verification on port 4310' };
const withLeftover = findingsMessage({ verdict: 'fail', findings: [portFinding], stepsRun: 1, iterations: 1 }, 1, 2, [], [{ name: 'node.exe', ports: [4310] }]);
console.log('implementer is told        :', withLeftover.includes("reviewer's own doing") && withLeftover.includes('4310') ? 'yes' : 'NO');
const noPorts = findingsMessage({ verdict: 'fail', findings: [portFinding], stepsRun: 1, iterations: 1 }, 1, 2, [], [{ name: 'esbuild.exe', ports: [] }]);
console.log('not for a silent leftover  :', !noPorts.includes('own doing') ? 'yes' : 'NO');
const nextBrief = reviewBrief(
  { vcs: { enabled: false } } as never,
  { prompt: 'p', level2: '', title: 't' } as never,
  [],
  'C:\\x',
  [],
  { round: 1, findings: [{ ...portFinding, id: 'r1f1' }], leftovers: [{ name: 'node.exe', ports: [4310] }] },
);
console.log('next reviewer is told      :', nextBrief.includes('After round 1') && nextBrief.includes('4310') && nextBrief.includes('Stop what you start') ? 'yes' : 'NO');

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

/*
 * A finding rests on a sentence somebody wrote.
 *
 * Two reviewers in a row failed a page for label text no task had specified — "First number",
 * where the page task said "labelled A and B" and the smoke-test task said only "both input
 * labels". The basis is checked against the task, its instructions, and the earlier tasks the
 * reviewer was shown; a paraphrase or an invention does not ground.
 */
console.log('\n--- a finding must quote the sentence it rests on ---');
const pageTask = 'Write the calculator page. It has two number inputs, labelled A and B, each a real <label> tied to its input; four buttons, one per operation.';
const smokeTask = 'Prove the page is served: fetch the HTML and check it contains the four operation buttons and both input labels.';
console.log('exact quote                :', isGrounded('check it contains the four operation buttons and both input labels', [smokeTask]), '(expect true)');
console.log('case, spaces, backticks    :', isGrounded('`Two number inputs, labelled   A and B`', [pageTask]), '(expect true)');
console.log('from an earlier task       :', isGrounded('labelled A and B, each a real <label>', [smokeTask, pageTask]), '(expect true)');
console.log('paraphrase                 :', isGrounded('the inputs must be labelled First number and Second number', [smokeTask, pageTask]), '(expect false)');
console.log('too short to mean anything :', isGrounded('labelled', [pageTask]), '(expect false)');
const askedAgain = ungroundedMessage([{ ...again, basis: 'the labels must read First number and Second number' }]);
console.log('asked for the quote once   :', askedAgain.includes('quote the sentence') && askedAgain.includes('First number') ? 'yes' : 'NO');

console.log('\n--- which earlier tasks the reviewer is shown ---');
const chain = {
  vcs: { enabled: true, branchMode: 'per-session' },
  tasks: [
    { id: 'a', title: 'scaffold', prompt: 'p1', status: 'done' },
    { id: 'b', title: 'page', prompt: pageTask, status: 'done' },
    { id: 'c', title: 'skipped', prompt: 'p3', status: 'queued' },
    { id: 'd', title: 'smoke', prompt: smokeTask, status: 'running' },
    { id: 'e', title: 'later', prompt: 'p5', status: 'queued' },
  ],
} as never;
const shown = earlierTasksForReview(chain, { id: 'd' } as never);
console.log('the ones that ran, before  :', shown.map((e) => e.title).join(', '), '(expect scaffold, page)');
console.log('not in per-task mode       :', earlierTasksForReview({ ...(chain as object), vcs: { enabled: true, branchMode: 'per-task' } } as never, { id: 'd' } as never).length, '(expect 0)');
const contextBrief = reviewBrief({ vcs: { enabled: false } } as never, { prompt: smokeTask, level2: '', title: 'smoke' } as never, [], 'C:\\x', [], undefined, [], [], shown);
console.log('brief carries them         :', contextBrief.includes('Earlier tasks of this session') && contextBrief.includes('labelled A and B') ? 'yes' : 'NO');
