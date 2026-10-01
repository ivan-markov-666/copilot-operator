/**
 * The pure rules of the program, as assertions rather than as printed lines.
 *
 * parser, review, damage, report, chat, crash, pacing, clock and part of vcs print what these
 * functions return and leave it to a person to compare the output with "(expect ...)". Nobody
 * reads it: a line that says "FAIL" in the middle of forty lines exits 0 all the same, and the
 * checks above pass whatever the rule does. This file holds the same rules — and a few the prints
 * never covered — as checks that set the exit code. Every case parser, damage, chat, crash, pacing
 * and clock print is here; review, report and vcs also exercise the runner, the policy and real
 * git, and only their pure parts are:
 *
 * - the reply and review contracts (what is sent back, and with which words), the stop marker and
 *   the citation markers, deviations and disputes, what a finding must carry;
 * - the damaged-command detector;
 * - the covering message and the report files that travel to the chat, and what is redacted from them;
 * - the chat's name, its id, how a sent message is recognised as landed, the reply-timeout error;
 * - Edge's crash report, the pacer and the clock of the UI;
 * - branch names, the commit message, what a task is told about the repository, and the hygiene,
 *   integrity and scope rules that decide what a commit may carry.
 *
 * All of it is pure, or writes only into its own temporary folder: nothing here starts the API,
 * opens a browser or touches the operator's data. The only process it starts is git, on a
 * throwaway repository of its own: to ask what a restore would name its branch, and whether the
 * branch names built here are ones git accepts.
 *
 * A check marked `// DEFECT:` fails on purpose until the product is fixed; see the comment on it.
 *
 *   npm run check:pins      (not wired into package.json yet: npx tsx test/pins.check.ts)
 */
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tally, makeRepo } from './support/harness.js';
import { parseReply, parseReview, extractFencedBlocks, stripLineNumbers, formatErrorMessage, findLikelyDamage, type ParseFail } from '../src/protocol/parser.js';
import { MIN_SUMMARY_CHARS, MIN_TRIED_APPROACHES, mergeDeviations, describeDeviations, resolveDeviations, mergeDisputes, describeDisputes } from '../src/protocol/replySchema.js';
import { allAboutTheTask, describeFindings, findingId, isGrounded, isRepeat, type ReviewFinding } from '../src/protocol/reviewSchema.js';
import { buildCoveringMessage, assertSendable, MINIMUM_COVERING_TEXT } from '../src/protocol/reporter.js';
import { writeReport, clip, stripAnsi } from '../src/exec/reportFile.js';
import { redactSecrets } from '../src/exec/redaction.js';
import type { RunResult } from '../src/exec/runner.js';
import { RunConfigSchema } from '../src/config/schema.js';
import { buildChatName, chatCode, makeRunId, parseChatId, MAX_CHAT_NAME } from '../src/transport/chatSession.js';
import { landed, sentTextHead } from '../src/transport/acceptance.js';
import { isReplyTimeout } from '../src/transport/copilotTransport.js';
import { Url } from '../src/transport/locators.js';
import { parseWatsonMetadata, findRecentCrash, describeCrash } from '../src/transport/edgeCrash.js';
import { Pacer, sleep } from '../src/util/pacing.js';
import { elapsedMs, isLive, runSpanMs, latestRun } from '../web/lib/clock.js';
import { branchNameFrom, plannedBranchName, porcelainPaths } from '../src/vcs/git.js';
import { commitMessage, noteFor, restorePreview, updateWarns } from '../src/vcs/taskVcs.js';
import { looksGenerated, findSuspicious } from '../src/vcs/commitHygiene.js';
import { traitsOf, newProblems } from '../src/vcs/contentIntegrity.js';
import { inScope } from '../src/vcs/scope.js';
import type { Session, SessionStart, Task } from '../src/session/model.js';

const t = new Tally();
const started = Date.now();
const work = await mkdtemp(join(tmpdir(), 'cop-pins-'));

const opts = { stopMarker: 'Край', defaultShell: 'pwsh' as const };
const block = (obj: unknown): string => '```json\n' + JSON.stringify(obj) + '\n```';
const oneStep = { status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'Get-Date' }] };
const oneStepJson = JSON.stringify(oneStep);
const summary = 'Checked the Windows Update service, collected the pending list, found nothing waiting. Nothing further is needed.';
const tried = [
  'Connected with the connection string in the task; the server refused with host not found.',
  'Checked whether the host resolves with Resolve-DnsName; it does not.',
];

/** How a parse ended, in the few words a check compares. */
const stepsOf = (md: string, o: { stopMarker: string; defaultShell: 'pwsh' | 'powershell' | 'cmd' } = opts): string[] | string => {
  const r = parseReply(md, o);
  return r.ok ? r.reply.steps.map((s) => s.cmd) : `FAIL ${r.reason}: ${r.detail}`;
};
const detailOf = (md: string): string => {
  const r = parseReply(md, opts);
  return r.ok ? 'ACCEPTED' : r.detail;
};

try {
  /*
   * Where the JSON is found.
   *
   * The reply is the raw markdown of the chat's answer, and the chat does not fence its JSON the
   * same way twice: untagged, tagged in capitals, with tildes, with a longer fence, or not at all.
   * Each of these has come back from a live chat, and each one refused would be a format round
   * spent on nothing. A reply that shows a PowerShell block first and the JSON second must run the
   * JSON, never the illustration.
   */
  console.log('--- where the JSON is found ---');
  /*
   * With no qualifying fence the parser falls back to the text between the first `{` and the last
   * `}` of the whole reply, and a reply holding one JSON object and no other brace would parse that
   * way whatever became of the fence handling. So each fenced form carries a brace outside its
   * fence — prose after it, or braces in the block before it — that makes the fallback invalid
   * JSON: these parse only because the fence itself was found.
   */
  const tail = '\n\nThen run it and send me {the output}.';
  t.check('an untagged ``` fence', stepsOf('```\n' + oneStepJson + '\n```' + tail), ['Get-Date']);
  t.check('bare JSON inside prose', stepsOf('Sure: ' + oneStepJson + ' done.'), ['Get-Date']);
  t.check('a ~~~json fence', stepsOf('~~~json\n' + oneStepJson + '\n~~~' + tail), ['Get-Date']);
  t.check('a ```JSON fence, in capitals', stepsOf('```JSON\n' + oneStepJson + '\n```' + tail), ['Get-Date']);
  t.check('a four-backtick fence', stepsOf('````json\n' + oneStepJson + '\n````' + tail), ['Get-Date']);
  t.check(
    'a powershell block, then the json: the json is what runs',
    stepsOf('```powershell\nGet-ChildItem | ForEach-Object { $_.Name }\n```\n\n' + block(oneStep)),
    ['Get-Date'],
  );
  t.check('a plain json block after prose', stepsOf('Here you go.\n\n' + block(oneStep)), ['Get-Date']);
  // The fallback cannot rescue these: without the fence the reply is not JSON at all.
  t.check('control: the same object with the fence broken is refused', stepsOf('~~json\n' + oneStepJson + '\n~~' + tail).slice(0, 4), 'FAIL');
  t.check('every fenced block is found, with its language', extractFencedBlocks('```ts\na\n```\n```json\n{}\n```').map((b) => b.lang), ['ts', 'json']);
  // Each fence form, read directly: tildes, a tag in capitals (lower-cased), a longer fence.
  for (const md of ['~~~json\n{}\n~~~', '```JSON\n{}\n```', '````json\n{}\n````']) {
    t.check(`one json block out of ${JSON.stringify(md.split('\n')[0])}`, extractFencedBlocks(md), [{ lang: 'json', body: '{}\n' }]);
  }

  /*
   * What the chat is told when there is nothing to parse.
   *
   * The message names what was wrong and nothing else: a reply with no JSON at all has no field
   * to describe, so the "What those fields must be" part would only be noise. A reply whose fields
   * were wrong gets each field's shape once, however many entries of that field were wrong.
   */
  console.log('\n--- the message that asks for a reformatted reply ---');
  const prose = parseReply('I think you should reboot.', opts);
  t.check('prose only is refused as no-json-block', prose.ok ? 'ACCEPTED' : { ok: prose.ok, reason: prose.reason }, { ok: false, reason: 'no-json-block' });
  if (!prose.ok) {
    const msg = formatErrorMessage(prose, 1, 2);
    t.truthy('it says there was no fenced json block', msg.includes('There was no fenced json code block'), msg);
    t.truthy('it counts the retry', msg.includes('format retry 1 of 2'), msg);
    t.truthy('it lists no field shapes, since no field was wrong', !msg.includes('What those fields must be'), msg);
  }
  const shaped = formatErrorMessage({ ok: false, reason: 'invalid-json', detail: 'tried.0: expected string', paths: ['tried.0', 'tried.1', 'deviations.0.why'] } satisfies ParseFail, 2, 3);
  const triedShape = '"tried" is a list of plain strings, one sentence per approach';
  t.truthy('the second retry says so', shaped.includes('format retry 2 of 3'), shaped);
  t.check('the tried shape is said once for two wrong entries', shaped.split(triedShape).length - 1, 1);
  t.truthy('the deviations shape is said too', shaped.includes('"deviations" is a list of {"instruction"'), shaped);

  /*
   * Line numbers from the chat's code widget.
   *
   * The repair is a last resort for text read from the page, and it must not touch a block whose
   * numbers are data: one number on its own line in real JSON is a value, not a gutter.
   */
  console.log('\n--- line-number repair ---');
  t.check('a lone number line in real JSON is left alone', stripLineNumbers('{"n":\n5\n}'), '{"n":\n5\n}');
  const gutter = '1\n{"status":"continue","steps":[\n2\n{"id":1,"type":"command","cmd":"Get-Date"}]}';
  t.check('a real gutter is stripped and the reply parses', stepsOf('```json\n' + gutter + '\n```'), ['Get-Date']);

  /*
   * The implementer's contract.
   *
   * Each rule is a way a run went wrong before it existed: a `continue` with nothing to run stalls
   * the loop; a `done` carrying steps would end the task with commands nobody ran; a summary under
   * forty characters is a label, not the deliverable; `blocked` after one attempt is a first try,
   * not a wall. The words sent back are pinned too, because they are what the chat learns from.
   */
  console.log('\n--- the reply contract ---');
  t.truthy('continue with no steps would stall the run', detailOf(block({ status: 'continue', steps: [] })).includes('would stall the run'), detailOf(block({ status: 'continue', steps: [] })));
  t.truthy('done carrying a step is refused', detailOf(block({ status: 'done', steps: oneStep.steps, summary })).includes('cannot carry steps'), detailOf(block({ status: 'done', steps: oneStep.steps, summary })));
  t.truthy('blocked carrying a step is refused', detailOf(block({ status: 'blocked', steps: oneStep.steps, tried, summary })).includes('cannot carry steps'), detailOf(block({ status: 'blocked', steps: oneStep.steps, tried, summary })));
  t.check('the summary bar is 40 characters', MIN_SUMMARY_CHARS, 40);
  t.check('the tried bar is 2 approaches', MIN_TRIED_APPROACHES, 2);
  t.check('done with a 39-character summary is refused', parseReply(block({ status: 'done', steps: [], summary: 'a'.repeat(39) }), opts).ok, false);
  t.check('done with a 40-character summary is accepted', parseReply(block({ status: 'done', steps: [], summary: 'a'.repeat(40) }), opts).ok, true);
  t.check('blocked with one approach is refused', parseReply(block({ status: 'blocked', steps: [], tried: [tried[0]], summary }), opts).ok, false);
  t.check('blocked with two approaches and no summary is refused', parseReply(block({ status: 'blocked', steps: [], tried }), opts).ok, false);
  // The step type that no longer exists. A chat that learned the old contract still writes it, and
  // what it hears back has to be the way to do it now, not "invalid literal".
  const download = detailOf(block({ status: 'continue', steps: [{ id: 1, type: 'download', file: 'x.ps1', run: true }] }));
  t.truthy('a download step is told there are no file steps', download.includes('this runner has no file steps'), download);
  t.truthy('and how to do it instead, with Set-Content', download.includes('Set-Content'), download);
  const bash = parseReply(block({ status: 'continue', steps: [{ id: 1, type: 'command', shell: 'bash', cmd: 'ls' }] }), opts);
  t.check('shell bash is refused at steps.0.shell', bash.ok ? 'ACCEPTED' : (bash.paths ?? []).includes('steps.0.shell'), true);
  t.check('a fractional timeoutSec is refused', parseReply(block({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'npm test', timeoutSec: 1.5 }] }), opts).ok, false);
  const cmdDefault = parseReply(block(oneStep), { stopMarker: 'Край', defaultShell: 'cmd' });
  t.check('a step with no shell takes the default shell given', cmdDefault.ok ? cmdDefault.reply.steps[0]!.shell : 'FAIL', 'cmd');
  const pwshDefault = parseReply(block(oneStep), opts);
  t.check('and pwsh when that is the default', pwshDefault.ok ? pwshDefault.reply.steps[0]!.shell : 'FAIL', 'pwsh');
  // A long step says so, and keeps the limits it asked for.
  const longStep = parseReply(block({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'npm test', expect: 'long', timeoutSec: 7200, idleTimeoutSec: 600 }] }), opts);
  t.check('a long step keeps expect, timeoutSec and idleTimeoutSec', longStep.ok ? [longStep.reply.steps[0]!.expect, longStep.reply.steps[0]!.timeoutSec, longStep.reply.steps[0]!.idleTimeoutSec] : 'FAIL', ['long', 7200, 600]);
  t.check('done with no summary is refused, marker or not', parseReply('Край\n\n' + block({ status: 'done', steps: [], notes: 'all good' }), opts).ok, false);
  t.check('done with "done." as its summary is refused', parseReply(block({ status: 'done', steps: [], summary: 'done.' }), opts).ok, false);
  t.check('blocked with no tried at all is refused', parseReply(block({ status: 'blocked', steps: [], summary }), opts).ok, false);
  const honest = parseReply(block({ status: 'blocked', steps: [], tried, summary, needed: 'The real host name.' }), opts);
  t.check('blocked, done properly: blocked, not done, two approaches', honest.ok ? [honest.blocked, honest.done, honest.reply.tried.length] : 'FAIL', [true, false, 2]);

  /*
   * The stop word.
   *
   * It ends a task only with a summary, and never turns a giving-up reply into a success: a model
   * that writes the word under an explanation of why it cannot finish has ended the task, not
   * completed it.
   */
  console.log('\n--- the stop marker ---');
  const withSteps = { status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'echo hi' }] };
  const doneOf = (md: string, o = opts): unknown => {
    const r = parseReply(md, o);
    return r.ok ? { done: r.done, blocked: r.blocked } : 'FAIL';
  };
  t.check('continue + steps + summary + marker ends the task', doneOf(block({ ...withSteps, summary }) + '\nКрай'), { done: true, blocked: false });
  t.check('the marker without a summary does not', doneOf(block(withSteps) + '\nКрай'), { done: false, blocked: false });
  t.check('a summary without the marker does not', doneOf(block({ ...withSteps, summary })), { done: false, blocked: false });
  t.check('the marker cannot turn blocked into done', doneOf(block({ status: 'blocked', steps: [], tried, summary }) + '\nКрай'), { done: false, blocked: true });
  t.check('done with a summary and the marker is done', doneOf('All finished. Край\n\n' + block({ status: 'done', steps: [], summary })), { done: true, blocked: false });
  /*
   * An empty stop word.
   *
   * `copilot.stopMarker` is a free string in the settings, and `markdown.includes('')` is true for
   * every reply: with the word emptied, any `continue` that carries a summary counts as done, its
   * steps are never run, and the task closes as a success. Either the settings refuse an empty
   * word or the parser ignores one; today neither does.
   */
  // The refusal has to be the stop marker's: settings refused for some other field would say
  // nothing about the word, so only an issue at copilot.stopMarker counts, and the same settings
  // with a real word must go through.
  const emptyParsed = RunConfigSchema.safeParse({ copilot: { stopMarker: '' } });
  const emptyRejected = !emptyParsed.success && emptyParsed.error.issues.some((i) => i.path.join('.') === 'copilot.stopMarker');
  t.check('the same settings with a real marker are accepted', RunConfigSchema.safeParse({ copilot: { stopMarker: 'Край' } }).success, true);
  const emptyIgnored = doneOf(block({ ...withSteps, summary }), { stopMarker: '', defaultShell: 'pwsh' });
  // DEFECT: an empty copilot.stopMarker is accepted and makes every continue reply with a summary "done" (parser.ts: markdown.includes('')).
  t.check('an empty stop marker is refused by the settings or ignored by the parser', emptyRejected || JSON.stringify(emptyIgnored) === JSON.stringify({ done: false, blocked: false }), true);

  /*
   * Citation markers.
   *
   * Copilot appends 【1-8313d0】 to prose it grounded in a file. The markers mean nothing outside
   * the chat and would end up on the task card and in the commit, so both contracts drop them and
   * the space they leave.
   */
  console.log('\n--- citation markers ---');
  const cited = 'Built it 【1-8313d0】 and ran the tests; all of them passed on this machine. 【2-aa】';
  const clean = 'Built it and ran the tests; all of them passed on this machine.';
  const citedReply = parseReply(block({ status: 'done', steps: [], summary: cited }), opts);
  t.check('parseReply drops the markers and the space before them', citedReply.ok ? citedReply.reply.summary : 'FAIL', clean);
  const citedReview = parseReview(block({ status: 'pass', steps: [], summary: cited }), { defaultShell: 'pwsh' });
  t.check('parseReview does the same', citedReview.ok ? citedReview.review.summary : 'FAIL', clean);
  t.truthy('no marker and no trailing space is left', citedReply.ok && citedReview.ok && ![citedReply.reply.summary, citedReview.review.summary].some((s) => (s ?? '').includes('【') || (s ?? '').endsWith(' ')));

  /*
   * Deviations and disputes, as data.
   *
   * A deviation repeated in a later reply is the same deviation: the instruction keeps its first
   * wording, the reason takes the latest. The closing reply is the final account when it gives one
   * and not when it forgets to. A dispute is keyed by the finding's id, whatever its case.
   */
  console.log('\n--- deviations and disputes ---');
  const deviation = {
    instruction: 'tsconfig.json with moduleResolution node',
    did: 'moduleResolution bundler',
    why: 'TS5108: moduleResolution=node10 has been removed; TypeScript 6.0.3 was installed',
  };
  const merged = mergeDeviations(
    [deviation],
    [
      { ...deviation, instruction: '  TSCONFIG.JSON with   moduleResolution node ', why: 'refined: TypeScript 6 removed node10' },
      { instruction: 'jsx preserve', did: 'restored the value after each build', why: 'next build rewrites tsconfig.json' },
    ],
  );
  t.check('a repeated deviation is merged: 2 entries', merged.length, 2);
  t.check('the first wording of the instruction is kept', merged[0]?.instruction, deviation.instruction);
  t.truthy('the refined reason wins', merged[0]?.why.startsWith('refined'), merged[0]);
  const midWay = [{ instruction: 'moduleResolution node', did: 'Node16', why: 'TS5108' }];
  const closing = [{ instruction: 'typescript latest', did: 'pinned 5.9.2', why: 'TS5108 under 6' }];
  t.check('a done that names deviations replaces the list', resolveDeviations(midWay, 'done', closing), closing);
  t.check('a done that names none keeps the list', resolveDeviations(midWay, 'done', []).length, 1);
  t.check('a deviation with a blank why is refused', parseReply(block({ status: 'done', steps: [], summary, deviations: [{ ...deviation, why: '  ' }] }), opts).ok, false);
  const devCount = (obj: unknown): number | string => {
    const r = parseReply(block(obj), opts);
    return r.ok ? r.reply.deviations.length : 'FAIL';
  };
  t.check('a deviation is accepted on continue, on done, and absent', [
    devCount({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'npx tsc --noEmit' }], deviations: [deviation] }),
    devCount({ status: 'done', steps: [], summary, deviations: [deviation] }),
    devCount({ status: 'done', steps: [], summary }),
  ], [1, 1, 0]);
  t.check('a deviation missing why is refused', devCount({ status: 'done', steps: [], summary, deviations: [{ instruction: 'x', did: 'y' }] }), 'FAIL');
  t.check('a continue adds to the list', resolveDeviations(midWay, 'continue', closing).length, 2);
  t.check('a blocked that names deviations replaces the list', resolveDeviations(midWay, 'blocked', closing), closing);
  t.truthy(
    'deviations are written out as instruction, did instead, because',
    describeDeviations(merged).startsWith(`1. Instruction: ${deviation.instruction}\n   Did instead: ${deviation.did}\n   Because: refined`),
    describeDeviations(merged),
  );
  const dispute = { finding: 'r1f2', why: 'The labels are A and B, as the task defines them.', evidence: 'Invoke-WebRequest returned <label for="a">A</label>.' };
  const disputes = mergeDisputes([dispute], [{ ...dispute, finding: 'R1F2', why: 'refined: the review searched for text the task never gave' }, { finding: 'r1f1', why: 'x', evidence: 'y' }]);
  t.check('disputes merge by id, ignoring case: 2 entries', disputes.length, 2);
  t.truthy('r1f2 carries the refined reason', disputes.find((d) => d.finding.toLowerCase() === 'r1f2')?.why.startsWith('refined'), disputes);
  t.check('a dispute without evidence is refused', parseReply(block({ status: 'done', steps: [], summary, disputed: [{ finding: 'r1f2', why: 'wrong' }] }), opts).ok, false);
  const disCount = (obj: unknown): number | string => {
    const r = parseReply(block(obj), opts);
    return r.ok ? r.reply.disputed.length : 'FAIL';
  };
  t.check('a dispute is accepted on continue and on done', [
    disCount({ status: 'continue', steps: [{ id: 1, type: 'command', cmd: 'npx next build' }], disputed: [dispute] }),
    disCount({ status: 'done', steps: [], summary, disputed: [dispute] }),
  ], [1, 1]);
  const disputesText = describeDisputes(disputes);
  t.truthy('disputes are written out by finding, with the evidence', disputesText.startsWith('1. Finding R1F2: refined') && disputesText.includes('\n   Evidence: ') && disputesText.includes('2. Finding r1f1: x'), disputesText);

  /*
   * The reviewer's contract: "pass" expensive, "fail" actionable.
   *
   * A verdict needs a summary that says what was checked; a fail needs findings; a pass may carry
   * findings only about the task. There is no `blocked`: a reviewer that cannot check something
   * fails with a finding saying so.
   */
  console.log('\n--- the review contract ---');
  const rOpts = { defaultShell: 'pwsh' as const };
  const rSummary = 'Built the API with npx tsc and started it with node dist/main.js; all four operations answered correctly and division by zero returned HTTP 400.';
  const finding = {
    what: 'The README tells the reader to start the API with a command that returns HTTP 500 for every request.',
    evidence: 'npx tsx src/main.ts, then POST /calculate returned {"statusCode":500}; the log shows the service was never injected.',
    basis: 'run the commands it tells a reader to run, exactly as written, and show that they work',
    where: 'README.md, the Run section',
  };
  const taskFinding = { ...finding, about: 'task' };
  const reviewOk = (obj: unknown): boolean => parseReview(block(obj), rOpts).ok;
  t.check('pass without a summary is refused', reviewOk({ status: 'pass', steps: [] }), false);
  t.check('pass with "Looks correct." is refused', reviewOk({ status: 'pass', steps: [], summary: 'Looks correct.' }), false);
  t.check('fail without findings is refused', reviewOk({ status: 'fail', steps: [], summary: rSummary }), false);
  t.check('a verdict carrying steps is refused', reviewOk({ status: 'pass', steps: [{ id: 1, type: 'command', cmd: 'npm test' }], summary: rSummary }), false);
  t.check('continue without steps is refused', reviewOk({ status: 'continue', steps: [] }), false);
  t.check('status blocked does not exist for a reviewer', reviewOk({ status: 'blocked', steps: [], summary: rSummary }), false);
  const passWork = parseReview(block({ status: 'pass', steps: [], summary: rSummary, findings: [finding] }), rOpts);
  t.truthy('a pass with a work finding is told findings must be about the task', !passWork.ok && passWork.detail.includes('can carry findings only with "about": "task"'), passWork.ok ? 'ACCEPTED' : passWork.detail);
  t.check('a pass mixing work and task findings is refused', reviewOk({ status: 'pass', steps: [], summary: rSummary, findings: [finding, taskFinding] }), false);
  const passTask = parseReview(block({ status: 'pass', steps: [], summary: rSummary, findings: [taskFinding] }), rOpts);
  t.check('a pass with only task findings is a pass', passTask.ok ? passTask.verdict : 'FAIL', 'pass');

  console.log('\n--- what a finding must carry ---');
  const failWith = (f: unknown): boolean => reviewOk({ status: 'fail', steps: [], summary: rSummary, findings: [f] });
  t.check('a vague "broken" is refused', failWith({ ...finding, what: 'broken' }), false);
  t.check('a finding without where is refused', failWith({ what: finding.what, evidence: finding.evidence, basis: finding.basis }), false);
  t.check('a finding without basis is refused', failWith({ what: finding.what, evidence: finding.evidence, where: finding.where }), false);
  t.check('a check without run is refused', failWith({ ...finding, check: { name: 'the start command answers', expect: 'output-contains', value: '200' } }), false);
  t.check('a valid check is accepted', failWith({ ...finding, check: { name: 'the start command answers', expect: 'output-contains', run: 'curl -s http://127.0.0.1:4300/calculate', value: '200' } }), true);
  const defaulted = parseReview(block({ status: 'fail', steps: [], summary: rSummary, findings: [finding] }), rOpts);
  t.check('a finding with no about is about the work', defaulted.ok ? defaulted.review.findings[0]!.about : 'FAIL', 'work');

  /*
   * A finding rests on a sentence somebody wrote.
   *
   * Two reviewers in a row failed a page for label text no task had specified. The basis must be a
   * quote — case, spacing and markdown dressing aside — from the task or an earlier one; a
   * paraphrase does not ground, and neither does a word too short to mean anything.
   */
  console.log('\n--- grounding, repeats and names ---');
  const pageTask = 'Write the calculator page. It has two number inputs, labelled A and B, each a real <label> tied to its input; four buttons, one per operation.';
  const smokeTask = 'Prove the page is served: fetch the HTML and check it contains the four operation buttons and both input labels.';
  t.check('an exact quote grounds', isGrounded('check it contains the four operation buttons and both input labels', [smokeTask]), true);
  t.check('case, spacing, backticks and curly quotes are ignored', isGrounded('`Two number inputs, “labelled”   A and B`', [pageTask]), true);
  t.check('a quote from an earlier task grounds', isGrounded('labelled A and B, each a real <label>', [smokeTask, pageTask]), true);
  t.check('a paraphrase does not', isGrounded('the inputs must be labelled First number and Second number', [smokeTask, pageTask]), false);
  t.check('"labelled" alone is too short to ground', isGrounded('labelled', [pageTask]), false);

  const round1: ReviewFinding[] = [{
    what: 'The task requires jsx preserve, but web\\tsconfig.json sets it to react-jsx.',
    evidence: 'x',
    basis: 'jsx preserve, module esnext',
    where: 'C:\\Projects\\calculator-test\\web\\tsconfig.json, compilerOptions.jsx',
    about: 'work',
  }];
  const again: ReviewFinding = {
    what: 'tsconfig.json uses "jsx": "react-jsx" instead of the task-required "jsx": "preserve".',
    evidence: 'y',
    basis: 'jsx preserve, module esnext',
    where: 'c:/projects/calculator-test/web/tsconfig.json,  compilerOptions.jsx',
    about: 'work',
  };
  const noPlace: ReviewFinding = { what: 'The README start command returns 500.', evidence: 'z', basis: 'run the commands it tells', where: '', about: 'work' };
  t.check('same place, backslash vs slash and case: a repeat', isRepeat(round1, again), true);
  t.check('a different place is not', isRepeat(round1, { ...again, where: 'web/app/page.tsx' }), false);
  t.check('no place, the same claim: a repeat', isRepeat([noPlace], { ...noPlace, evidence: 'w' }), true);
  t.check('no place, another claim: not', isRepeat([noPlace], { ...noPlace, what: 'The README install command fails.' }), false);
  t.check('nothing before: not a repeat', isRepeat([], again), false);
  t.check('finding ids are round and position', findingId(1, 1), 'r1f2');
  t.check('no findings are not all about the task', allAboutTheTask([]), false);
  const named = [{ ...again, id: 'r1f1', about: 'task' as const }];
  const written = describeFindings(named, () => true);
  t.truthy('written out with its id first', written.startsWith('1. [r1f1] '), written);
  t.truthy('marked as about the task', written.includes('[about the task, not the work]'), written);
  t.truthy('marked as raised before', written.includes('[raised in an earlier round too]'), written);

  /*
   * Commands that arrived damaged.
   *
   * The chat eats a `[label]:` sequence, so `[math]::Round(...)` reaches the runner as
   * `:Round(...)`. The six damaged commands are the ones seen live; the twelve intact ones are the
   * forms that must keep running — including git's `%(refname:short)`, a colon in a format string.
   */
  console.log('\n--- damaged commands ---');
  const damage: Array<[string, boolean]> = [
    ["@{Name='FreeSpaceGB';Expression={:Round($_.Free/1GB,2)}}", true],
    ['[pscustomobject]@{FreeSpaceGB=:Round($c.FreeSpace/1GB,2)}', true],
    ["Write-Output ('FreeSpaceGB=' + :Round($c.Free/1GB,2))", true],
    ["ForEach-Object { :Matches((Get-Content $_ -Raw), \"getByTestId\\('([^']+)'\\)\") }", true],
    ['$_ -match "\\|$(:Escape($remote))/"', true],
    ['$lines[($start - 1)..(:Min($start + 24, $lines.Count - 1))]', true],
    ['[math]::Round($c.FreeSpace/1GB,2)', false],
    ['$re = [regex]; $re::Escape($name)', false],
    ["git for-each-ref --format='%(refname:short)|%(upstream:track)' refs/heads", false],
    ['Select-String -Pattern $p -AllMatches', false],
    ['[System.Math]::Round($x, 2)', false],
    ['$m = [math]; $m::Round($x, 2)', false],
    ['"{0:N2}" -f $x', false],
    ['(3.14).ToString("N2")', false],
    ['Get-Service | Where-Object Status -eq Running', false],
    ['Get-ChildItem C:\\Windows -Filter *.log', false],
    ['Get-Process -Name pwsh -ErrorAction:SilentlyContinue', false],
    ['[pscustomobject]@{Edition=$os.ProductName}', false],
    // A time format is not a static call, and a damaged call at the very start of a line still is.
    ['Get-Date -Format HH:mm', false],
    ['::Min(1,2)', true],
  ];
  for (const [cmd, flagged] of damage) t.check(`${flagged ? 'flagged ' : 'left alone'}: ${cmd.slice(0, 60)}`, findLikelyDamage(cmd) !== null, flagged);

  /*
   * The covering message.
   *
   * It travels with the attachment because a message of an attachment alone cannot be sent, and
   * since it has to say something it says how each step ended — in words that tell a refused step
   * (rewrite it) from a failed one (fix the work) from one a person skipped (carry on without it).
   */
  console.log('\n--- the covering message ---');
  const mk = (id: number, outcome: RunResult['outcome'], exitCode: number, stdout = '', stderr = ''): RunResult => ({
    id, shell: 'pwsh', command: `cmd-${id}`, exitCode, outcome, durationMs: 1200, stdout, stderr, truncated: false, logPath: `C:/logs/${id}.log`, lastOutputAgoMs: 0,
  });
  const every = buildCoveringMessage({
    task: 'calc-service',
    iteration: 2,
    results: [
      mk(1, 'completed', 2, 'error\n'),
      mk(2, 'hard-timeout', -1, 'partial\n'),
      mk(3, 'idle-timeout', -1, 'partial\n'),
      mk(4, 'refused', -1),
      mk(5, 'aborted', -4),
      mk(6, 'aborted', -2),
      mk(7, 'spawn-error', -3),
    ],
    attachments: ['iteration-2.txt'],
  });
  for (const part of [
    'step 1 exit 2',
    'step 2 hit its time limit',
    'step 3 produced no output and was stopped',
    'step 4 was refused by the runner and never ran',
    'step 5 was not run: the operator skipped',
    'step 6 aborted by the operator',
    'step 7 could not be started',
  ]) t.truthy(`says "${part}"`, every.includes(part), every);
  t.check('the stopped-by-the-runner note names exactly the timed-out steps', /Note: (.*?) was stopped by the runner, not by the command itself/.exec(every)?.[1], 'step 2, step 3');
  const single = buildCoveringMessage({ task: 'calc-service', iteration: 2, results: [mk(1, 'completed', 0, 'ok\n')], attachments: ['x.txt'] });
  t.truthy('it starts with the task, the iteration and the step count', single.startsWith('Terminal output for "calc-service", iteration 2: 1 step(s)'), single);
  t.truthy('one file: "attached file x.txt"', single.includes('attached file x.txt'), single);
  const untitled = buildCoveringMessage({ iteration: 3, results: [mk(1, 'completed', 0, 'ok\n'), mk(2, 'completed', 1, 'no\n')], attachments: ['iteration-3.txt'] });
  t.truthy('without a task name it starts with the iteration alone', untitled.startsWith('Terminal output for iteration 3: 2 step(s), step 1 exit 0; step 2 exit 1.'), untitled);
  const twoParts = buildCoveringMessage({ iteration: 7, results: [mk(1, 'completed', 0, 'ok\n')], attachments: ['a-part1.txt', 'a-part2.txt'], parts: 2 });
  t.truthy('two parts are named in order', twoParts.includes('split across 2 attached files: a-part1.txt, a-part2.txt'), twoParts);
  t.truthy('and all of them are to be read, in order', twoParts.includes('Read all of them, in order'), twoParts);

  // Exit 1 with nothing printed: in PowerShell, a cmdlet that found nothing — often the good outcome.
  const silentOf = (r: RunResult): boolean => buildCoveringMessage({ iteration: 3, results: [r], attachments: ['x.txt'] }).includes('found nothing');
  t.check('exit 1 with no output says a cmdlet found nothing', silentOf(mk(1, 'completed', 1)), true);
  t.check('not when it printed output', silentOf(mk(1, 'completed', 1, 'error: nope\n')), false);
  t.check('not when it printed to stderr only', silentOf(mk(1, 'completed', 1, '', 'error: nope\n')), false);
  t.check('not on exit 0', silentOf(mk(1, 'completed', 0)), false);
  const noted = buildCoveringMessage({ iteration: 5, results: [mk(1, 'completed', 0, 'ok\n')], attachments: ['x.txt'], notes: ['First note.', 'Second note.'] });
  const [atFile, atFirst, atSecond] = [noted.indexOf('attached file'), noted.indexOf('First note.'), noted.indexOf('Second note.')];
  t.truthy('notes come after the file, in the order given', atFile >= 0 && atFile < atFirst && atFirst < atSecond, noted);
  let threw = '';
  try {
    assertSendable('   ', ['f.txt']);
  } catch (e) {
    threw = (e as Error).message;
  }
  t.truthy('a blank message is refused before Send', /Refusing to send/.test(threw), threw || 'did not throw');
  let threwOnText = false;
  try {
    assertSendable('ok', []);
  } catch {
    threwOnText = true;
  }
  t.check('a message with text passes the guard', threwOnText, false);
  const bare = buildCoveringMessage({ iteration: 9, results: [], attachments: [] });
  t.truthy('no attachment: still never empty', bare.startsWith(MINIMUM_COVERING_TEXT) && bare.includes('no file was produced'), bare);

  /*
   * The report file.
   *
   * Colour codes go, PowerShell's own brackets stay. A report too big for one file is split on step
   * boundaries only, each part says which part it is, and an over-long stream keeps both ends.
   */
  console.log('\n--- the report file ---');
  const ESC = String.fromCharCode(27);
  t.check('colour codes are stripped', stripAnsi(ESC + '[32;1mA' + ESC + '[0m'), 'A');
  const psText = '[pscustomobject]@{A=1}; [double]$x';
  t.check("PowerShell's brackets are not", stripAnsi(psText), psText);
  const reportDir = join(work, 'reports');
  const base = { runId: 'r1', dir: reportDir, fileNameTemplate: 'iteration-{n}.txt', maxOutputChars: 100_000, redactPatterns: [] as string[] };
  const big = 'x'.repeat(5000);
  const split = await writeReport([mk(1, 'completed', 0, big), mk(2, 'completed', 0, big), mk(3, 'completed', 0, big)], { ...base, iteration: 4, maxReportBytes: 7000 });
  t.check('three steps of 5000 characters in 7000 bytes: three files', split.names, ['iteration-4-part1.txt', 'iteration-4-part2.txt', 'iteration-4-part3.txt']);
  for (const [i, path] of split.paths.entries()) {
    const text = await readFile(path, 'utf8');
    t.truthy(`part ${i + 1} says part=${i + 1}/3 on its first line`, text.split('\n')[0]!.includes(`part=${i + 1}/3`), text.split('\n')[0]);
    t.truthy(`part ${i + 1} holds step ${i + 1} whole, and only it`, (text.match(/^--- step \d+ /gm) ?? []).length === 1 && text.includes(`--- step ${i + 1} `) && text.includes(big) && text.trimEnd().endsWith('END RESULTS'));
  }
  // The two ends are different letters, so a clip that kept the head twice, or any run of one
  // letter around the word "omitted", cannot pass. 500 in 200: (200 - 80) / 2 = 60 a side, 380 dropped.
  const clipped = clip('h'.repeat(250) + 't'.repeat(250), 200);
  t.truthy('an over-long stream keeps its head', clipped.startsWith('h'.repeat(60)) && !clipped.slice(0, 60).includes('t'), clipped);
  t.truthy('and its tail', clipped.endsWith('t'.repeat(60)), clipped);
  t.truthy('and says how much was omitted', clipped.includes('[... 380 characters omitted ...]'), clipped);
  t.check('a stream within the limit is untouched', clip('short', 200), 'short');
  const headed = await writeReport([mk(1, 'completed', 0, 'ok\n')], { ...base, runId: 'folder-id', task: 'x', taskText: 'Write the thing.', iteration: 1, fileNameTemplate: 'headed-{n}.txt', maxReportBytes: 8e6 });
  const headedText = await readFile(headed.paths[0]!, 'utf8');
  t.truthy('the header names the task and the iteration', /^RESULTS task="x" iteration=1/.test(headedText), headedText.split('\n')[0]);
  t.truthy('the task text travels with the file', headedText.includes('THE TASK, AS GIVEN'), headedText.slice(0, 300));
  t.truthy('how to read the file comes before the first step', headedText.indexOf('--- HOW TO READ THIS FILE ---') >= 0 && headedText.indexOf('--- HOW TO READ THIS FILE ---') < headedText.indexOf('--- step 1'));

  /*
   * What never leaves the machine.
   *
   * The report is uploaded to the chat as a file; on a work machine what a step prints is real.
   * The fake secrets are built from pieces so that no scanner mistakes this file for a leak.
   */
  console.log('\n--- redaction ---');
  const leaks: Array<[string, string, string]> = [
    ['JWT', 'Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJ'],
    ['bearer', 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123"', 'abcdefghij'],
    ['AWS key', 'aws_access_key_id AKIA' + 'IOSFODNN7EXAMPLE', 'IOSFODNN7'],
    ['GitHub token', 'remote: ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', 'ABCDEFGHIJKLMNOP'],
    ['Slack token', 'slack says xox' + 'b-123456789012-abcdefghijKL', 'abcdefghijKL'],
    ['Azure key', 'DefaultEndpointsProtocol=https;AccountName=acct;Account' + 'Key=' + 'Zm9vYmFy'.repeat(5) + '==;EndpointSuffix=core.windows.net', 'Zm9vYmFy'],
    ['SAS signature', 'https://acct.blob.core.windows.net/c/b.txt?sv=2022-11-02&s' + 'ig=' + 'AbCdEfGhIjKlMnOpQrStUv%2B%3D', 'AbCdEfGhIjKl'],
    ['Google key', 'maps AI' + 'za' + 'SyDx0123456789abcdefghijklmnopqrstu', 'SyDx0123'],
    ['npm token', 'published with np' + 'm_' + 'a1B2c3D4e5'.repeat(4), 'a1B2c3D4e5'],
    ['password=', 'ConnectionString=Server=db;User=app;Password=Sup3rS3cret!;', 'Sup3rS3cret'],
    ['URL credentials', 'fetching https://ivan:hunter2pass@git.example.com/repo.git', 'hunter2'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nQ==\n-----END RSA PRIVATE KEY-----', 'MIIEow'],
  ];
  for (const [label, text, secret] of leaks) {
    const out = redactSecrets(text);
    t.truthy(`${label}: the secret is gone and says REDACTED`, !out.includes(secret) && out.includes('REDACTED'), out);
  }
  // And the other side: text that only names a secret, or looks a little like one, is left exactly
  // as it was. A redactor loosened to eat every "password" or "token" would pass the table above
  // and blank out the code and the error messages the chat needs to read.
  for (const text of ['interface User { password: string; token?: string }', 'the token was rejected', 'Password: required', 'https://example.com/path']) {
    t.check(`left alone: ${text}`, redactSecrets(text), text);
  }
  t.check("the operator's own pattern applies on top", redactSecrets('ticket=abc user=x', ['ticket=\\w+']), '[REDACTED] user=x');
  t.truthy('a pattern that is not a valid regex is applied as text', redactSecrets('a([b', ['([']).includes('[REDACTED]'), redactSecrets('a([b', ['([']));
  const leaky = await writeReport([mk(1, 'completed', 0, 'Account' + 'Key=abcdef0123456789==;\n')], { ...base, runId: 'leak', iteration: 1, fileNameTemplate: 'leak-{n}.txt', maxReportBytes: 8e6 });
  t.check('the written file has no secret in it', (await readFile(leaky.paths[0]!, 'utf8')).includes('abcdef0123456789'), false);
  t.check('and the report says what was taken out', leaky.redactions, [{ name: 'Azure key', count: 1 }]);

  /*
   * The chat's name and id.
   *
   * The name is how a person finds the bot's chat in the sidebar and how the bot finds it again
   * after a new sign-in: `op/<code>/<label>`, at most 50 characters (the app's own limit), the
   * prefix and code intact and the label absorbing the cut. The id is the uuid in the address.
   */
  console.log('\n--- the chat: name, id, acceptance ---');
  const runId = makeRunId(new Date('2026-09-17T19:12:00'));
  for (const label of ['windows-update', 'run the full regression test suite for the payments service', 'тест на кирилица и интервали']) {
    const n = buildChatName(runId, label);
    t.truthy(`"${label.slice(0, 30)}": within 50 and under op/<code>/`, n.length <= MAX_CHAT_NAME && n.startsWith(`op/${runId}/`), n);
  }
  t.check('an empty label: just op/<code>', buildChatName(runId, ''), `op/${runId}`);
  t.check('Cyrillic is kept, spaces become dashes', buildChatName('abcd', 'тест на кирилица'), 'op/abcd/тест-на-кирилица');
  t.check('no label, no trailing slash', buildChatName('abcd', ''), 'op/abcd');
  t.check('a pathological code is still cut to 50', buildChatName('x'.repeat(60), 'y').length, 50);
  t.check("a session id's random tail is its code", chatCode('20260928-073140-ujdt'), 'ujdt');
  t.check('and the long name fits after it', buildChatName('ujdt', 'casualty-gl-datacapture-regression-suite'), 'op/ujdt/casualty-gl-datacapture-regression-suite');
  t.check('an id with no tail gives its last six letters and digits', chatCode('SESSION_ID'), 'sionid');
  const uuid = '8cdb5dc4-f45b-4ce7-846a-f851bff59534';
  t.check('the id is read out of a conversation address', parseChatId(`https://m365.cloud.microsoft/chat/conversation/${uuid}?es=SSR`), uuid);
  t.check('a new chat has no id', parseChatId('https://m365.cloud.microsoft/chat?es=SSR'), null);
  t.check('upper-case hex is accepted', parseChatId(`https://m365.cloud.microsoft/chat/conversation/${uuid.toUpperCase()}`), uuid.toUpperCase());
  t.check('the address the bot navigates to reads back as the same id', parseChatId(Url.conversation(uuid)), uuid);

  /*
   * Whether a sent message landed.
   *
   * The newest user bubble must have changed since before the send and begin with what was sent,
   * on collapsed whitespace and the first 120 characters: that is what keeps a retry from sending
   * a message twice, and an earlier message that starts the same way from counting as this one.
   */
  const sent = 'An independent review of your work found 1 problem(s). The reviewer is a\nseparate conversation that was given the task.\n\nWhat it checked: ...';
  const shownAfter = 'An independent review of your work found 1 problem(s). The reviewer is a separate conversation that was given the task. What it checked: ... iteration-6.txt';
  t.check('changed and matching: landed', landed(sent, shownAfter, 'Terminal output for "web-smoke", iteration 6'), true);
  t.check('unchanged since before: not landed', landed(sent, shownAfter, shownAfter), false);
  t.check('changed but different: not landed', landed(sent, 'Terminal output for "web-smoke", iteration 7', 'x'), false);
  t.check('nothing shown now: not landed', landed(sent, '', 'x'), false);
  t.check('nothing sent: not landed', landed('   ', shownAfter, 'x'), false);
  // Two review rounds' findings messages begin the same way; the newest bubble has not changed.
  t.check('the same beginning, another round, bubble unchanged: not landed', landed(shownAfter.replace(' iteration-6.txt', ' Round 2.'), shownAfter, shownAfter), false);
  const head = sentTextHead('a\n\n b'.repeat(100));
  t.truthy('the head is 120 characters of collapsed whitespace', head.length === 120 && !head.includes('  ') && !head.includes('\n'), head);

  // The reply-timeout error is recognised by name too, since a module loaded twice breaks instanceof.
  t.check('a ReplyTimeoutError by name and seconds is one', isReplyTimeout(Object.assign(new Error('x'), { name: 'ReplyTimeoutError', seconds: 5 })), true);
  t.check('a plain Error is not', isReplyTimeout(new Error('x')), false);
  t.check('a plain object that looks like one is not', isReplyTimeout({ name: 'ReplyTimeoutError', seconds: 1 }), false);

  /*
   * Edge's crash report.
   *
   * "Target page, context or browser has been closed" reads the same for a closed window, a second
   * Edge on the profile and a crash; the minidump next to the profile tells them apart.
   */
  console.log("\n--- Edge's crash report ---");
  // The binary head is kept, NUL bytes and all, as Edge writes it: the fields are read out of it.
  const meta =
    'NSTW\u0000\u0001garbage\u0000crashpad_exp ApplicationName=msedge.exe;ApplicationVersion=153.0.4234.32;ModuleName=msedge.dll;' +
    'ModuleOffset=70984128;ProcessType=browser;SubCode=0x80000003;StackHash=0; Channel=;OfficialBuild=1; process_id=9072;';
  t.check('the metadata is read', parseWatsonMetadata(meta), { processType: 'browser', version: '153.0.4234.32', subCode: '0x80000003' });
  t.check('the last value of a field wins', parseWatsonMetadata('ProcessType=renderer;x ProcessType=browser;').processType, 'browser');
  t.check('text with no fields gives none', Object.values(parseWatsonMetadata('plain text')).filter((v) => v !== undefined), []);
  const profile = join(work, 'edge-profile');
  t.check('a profile with no Crashpad folder: no crash', await findRecentCrash(profile), null);
  await mkdir(join(profile, 'Crashpad', 'reports'), { recursive: true });
  await writeFile(join(profile, 'Crashpad', 'watson_metadata'), meta, 'latin1');
  const old = join(profile, 'Crashpad', 'reports', 'old.dmp');
  await writeFile(old, 'x');
  const past = new Date(Date.now() - 60 * 60_000);
  await utimes(old, past, past);
  t.check('only an old report: no crash', await findRecentCrash(profile), null);
  await writeFile(join(profile, 'Crashpad', 'reports', 'fresh.dmp'), 'y');
  const crash = await findRecentCrash(profile);
  t.truthy('a fresh report is found', crash?.report.endsWith('fresh.dmp'), crash);
  t.truthy('and described in one sentence', !!crash && describeCrash(crash).startsWith("Edge's browser process crashed (Edge 153.0.4234.32, code 0x80000003)"), crash ? describeCrash(crash) : 'none');

  /*
   * Pacing.
   *
   * What is left of it does work: backoff that cannot become a tight loop, jitter that a seed makes
   * repeatable, and an hourly cap that waits rather than sends. The cap is tested with a stubbed
   * clock so that "an hour later" takes no hour.
   */
  console.log('\n--- pacing ---');
  t.check('settle is 0 when pacing is off', await new Pacer({ enabled: false }).settle(), 0);
  t.check('and the settle time when it is on', await new Pacer({ settleMs: 50 }).settle(), 50);
  const pacer = new Pacer({ seed: 42 });
  const outOfRange: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const exp = Math.min(2000 * 2 ** i, 60_000);
    const v = pacer.backoffFor(i);
    if (v < exp * 0.5 || v > exp) outOfRange.push(`${i}: ${v} not in [${exp * 0.5}, ${exp}]`);
  }
  t.check('every backoff is between half and all of min(2000*2^i, 60000)', outOfRange, []);
  const seq = (p: Pacer): number[] => [0, 1, 2, 3, 4, 5].map((i) => p.backoffFor(i));
  t.check('two pacers with seed 7 agree', seq(new Pacer({ seed: 7 })), seq(new Pacer({ seed: 7 })));
  const aborted = new AbortController();
  aborted.abort();
  const sleepStart = Date.now();
  const slept = await sleep(10_000, aborted.signal).then(() => 'resolved', (e: Error) => e.message);
  t.check('sleep on an aborted signal rejects "aborted"', slept, 'aborted');
  t.truthy('at once', Date.now() - sleepStart < 5_000, `${Date.now() - sleepStart} ms`);

  /*
   * Only Date.now is stubbed; the wait itself is a real timer. So every send that must not wait is
   * given a signal that gives up after two seconds: a cap that broke would show as "aborted" here
   * instead of holding the check for an hour.
   */
  const soon = (): AbortSignal => AbortSignal.timeout(2_000);
  const outcome = (p: Promise<number>): Promise<number | string> => p.then((ms) => ms, (e: Error) => e.message);
  const realNow = Date.now;
  let fake = 1_900_000_000_000;
  Date.now = () => fake;
  try {
    const capped = new Pacer({ maxMessagesPerHour: 3, enabled: false });
    const firstThree = [await outcome(capped.throttleSend(soon())), await outcome(capped.throttleSend(soon())), await outcome(capped.throttleSend(soon()))];
    t.check('three sends under a cap of 3 do not wait', firstThree, [0, 0, 0]);
    const ac = new AbortController();
    let settled = false;
    const fourth = capped.throttleSend(ac.signal).then(
      (ms) => `resolved after ${ms}`,
      (e: Error) => e.message,
    ).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    t.check('the fourth send waits', settled, false);
    ac.abort();
    t.check('and rejects when aborted', await fourth, 'aborted');
    fake += 3_600_001;
    t.check('an hour and a millisecond later it does not wait', await outcome(capped.throttleSend(soon())), 0);
    /*
     * The old sends have left the window, not merely aged. Two more sends at the new time fill the
     * cap of 3 again, so a sixth must wait a full hour. Were the three sends of an hour ago still
     * counted, the oldest would say "you may send 1 ms ago" and this one would go at once.
     */
    t.check('two more at the same time do not wait either', [await outcome(capped.throttleSend(soon())), await outcome(capped.throttleSend(soon()))], [0, 0]);
    t.check('the next one waits: the sends of an hour ago were dropped from the count', await outcome(capped.throttleSend(AbortSignal.timeout(300))), 'aborted');
  } finally {
    Date.now = realNow;
  }

  /*
   * The clock of the UI: durations from the two instants the record keeps, nothing stored.
   */
  console.log('\n--- the clock ---');
  const t0 = Date.parse('2026-09-20T09:00:00.000Z');
  const at = (s: number): string => new Date(t0 + s * 1000).toISOString();
  t.check('a finished task', elapsedMs(at(0), at(272)), 272_000);
  t.check('a task still running, now=+61 s', elapsedMs(at(0), undefined, t0 + 61_000), 61_000);
  t.check('not started', elapsedMs(undefined), undefined);
  t.check('never negative', elapsedMs(at(10), at(0)), 0);
  t.check('live: running, finished, queued', [isLive({ startedAt: at(0), status: 'running' }), isLive({ startedAt: at(0), finishedAt: at(5), status: 'done' }), isLive({ status: 'queued' })], [true, false, false]);
  const run = { id: 'r-1', startedAt: at(0) };
  const done = [
    { startedAt: at(1), finishedAt: at(300), status: 'done', runGroup: run },
    { startedAt: at(301), finishedAt: at(900), status: 'done', runGroup: run },
    { startedAt: at(901), finishedAt: at(1500), status: 'failed', runGroup: run },
  ];
  t.check('a finished run spans to its last finish', runSpanMs(run, done, t0 + 99_999_000), { ms: 1_500_000, live: false, tasks: 3 });
  const inFlight = [done[0]!, done[1]!, { startedAt: at(901), status: 'running', runGroup: run }];
  const going = runSpanMs(run, inFlight, t0 + 1_000_000);
  t.check('a run still going spans to now', [going.ms, going.live], [1_000_000, true]);
  const withQueued = [done[0]!, { status: 'queued', runGroup: run }];
  const notYet = runSpanMs(run, withQueued, t0 + 400_000);
  t.check('a queued task is not live; the span ends at the last finish', [notYet.live, notYet.ms], [false, 300_000]);
  const older = { id: 'r-0', startedAt: at(-5000) };
  const latest = latestRun([{ startedAt: at(-4999), finishedAt: at(-4000), status: 'done', runGroup: older }, ...done, { status: 'queued' }]);
  t.check('the latest run is the newest, with its tasks', [latest?.run.id, latest?.tasks.length], ['r-1', 3]);
  t.check('no run at all: null', latestRun([{ status: 'queued' }]), null);

  /*
   * Branch names.
   *
   * A derived name is reduced to a conservative alphabet — letters of any script, digits, `.`, `_`
   * and `-` — each part cut at 40 and the whole at 200. A planned name with its own namespace is
   * the team's convention and is used as written; one without gets the prefix. git itself is
   * asked whether every name built here is one it accepts.
   */
  console.log('\n--- branch names ---');
  const names: string[] = [];
  const keep = (n: string): string => (names.push(n), n);
  t.check('mixed scripts and punctuation', keep(branchNameFrom(['My Session!', 'Задача с кирилица', 'a2'])), 'cop/my-session-задача-с-кирилица-a2');
  t.check('dots and blanks are dropped', keep(branchNameFrom(['..bad..', '  '])), 'cop/bad');
  t.check('nothing at all: cop/task', keep(branchNameFrom([])), 'cop/task');
  t.check('a part is cut at 40', keep(branchNameFrom(['a'.repeat(60)])), 'cop/' + 'a'.repeat(40));
  const long = keep(branchNameFrom(Array.from({ length: 10 }, (_, i) => `${i}${'b'.repeat(59)}`)));
  t.truthy('the whole name is at most 200', long.length <= 200, long.length);
  t.check('a planned name carrying the prefix is not doubled', keep(plannedBranchName('cop/invoice-csv-writer', 'cop/')), 'cop/invoice-csv-writer');
  // Decision pin (ab344bc): a planned name with a "/" is a namespace the plan chose and is used as
  // written, case and all, so "COP/Thing" stays "COP/Thing" rather than being read as the prefix.
  // Only a name without a "/" is given the prefix.
  t.check('a prefix typed in another case is a namespace, kept as written (pinned)', keep(plannedBranchName('COP/Thing', 'cop/')), 'COP/Thing');
  t.check('a second attempt gets -a2', keep(plannedBranchName('invoice-csv-writer', 'cop/', 2)), 'cop/invoice-csv-writer-a2');
  t.check('its own namespace is kept, made safe, in its case', keep(plannedBranchName('feature/CSV Writer!', 'cop/')), 'feature/CSV-Writer');
  t.check('a namespaced third attempt gets -a3', keep(plannedBranchName('recovery/apz', 'cop/', 3)), 'recovery/apz-a3');
  // Decision pin: any "/" makes a namespace, so a plan's descriptive "restore-api/auth" becomes a
  // branch of that name, outside cop/, rather than cop/restore-api-auth. That is today's rule.
  t.check('a slash in a plain name is read as a namespace (pinned)', keep(plannedBranchName('restore-api/auth', 'cop/')), 'restore-api/auth');
  const refRepo = join(work, 'refs');
  await mkdir(refRepo, { recursive: true });
  await makeRepo(refRepo);
  /*
   * The restore branch is named from the task's title, and the title goes through the same
   * plannedBranchName. A title is a label, not a branch name anybody chose, yet the namespace rule
   * above applies to it: a "/" in the title puts the restore branch outside the session's prefix,
   * in the title's case. A title without one gives cop/restore-<slug>, which is the control.
   */
  const baseCommit = execFileSync('git', ['-C', refRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const restoreSession = { vcs: { enabled: true, repoDir: refRepo, branchMode: 'per-task', commitOnFinish: true, branchPrefix: 'cop/' } } as unknown as Session;
  const restoreName = async (title: string): Promise<string | undefined> => {
    const preview = await restorePreview(restoreSession, { title, vcs: { baseCommit } } as unknown as Task);
    return preview.ok ? keep(preview.branchName ?? '') : `not ok: ${preview.problem}`;
  };
  t.check('a restore branch is cop/restore-<the title, made safe>', await restoreName('Add CI pipeline'), 'cop/restore-add-ci-pipeline');
  const slashed = await restoreName('Add CI/CD pipeline');
  // DEFECT: restorePreview (taskVcs.ts:717) passes the task's title through plannedBranchName, so a title with "/" gives the restore branch "restore-Add-CI/CD-pipeline", outside the session's cop/ prefix.
  t.truthy('a title with a "/" still gives a restore branch under cop/, one level deep', !!slashed?.startsWith('cop/') && slashed.split('/').length === 2, slashed);
  const refused = names.filter((n) => {
    try {
      execFileSync('git', ['-C', refRepo, 'check-ref-format', '--branch', n], { stdio: 'pipe' });
      return false;
    } catch {
      return true;
    }
  });
  t.check('git accepts every name built here', refused, []);

  /*
   * The paths out of `git status --porcelain`, raw and after this runner's trim, which eats the
   * leading space of the first line: the status characters are matched, not counted.
   */
  const rawStatus = ' M rules-engine/docs/a.md\n?? node_modules/x.js\nM  src/b.ts\nMM src/c.ts\nR  old.ts -> new.ts\n D gone.ts\nUU conflict.ts';
  const expected = ['rules-engine/docs/a.md', 'node_modules/x.js', 'src/b.ts', 'src/c.ts', 'old.ts -> new.ts', 'gone.ts', 'conflict.ts'];
  t.check('porcelain paths, as git prints them', porcelainPaths(rawStatus), expected);
  t.check('porcelain paths, trimmed', porcelainPaths(rawStatus.trim()), expected);
  t.check('no output, no paths', porcelainPaths(''), []);

  /*
   * The commit message: the plan's subject and body first, then what only the end can know —
   * the summary, the deviations, how it ended — and the trailer that says nothing was pushed.
   */
  console.log('\n--- the commit message ---');
  const msg = commitMessage(
    { title: 'csv-writer', attempt: 2, vcsPlan: { commitMessage: 'Add CSV writer\n\nKeeps the flag off.' } } as Task,
    { status: 'failed', summary: 'Wrote the writer; one test still fails.', reason: 'a check failed', deviations: [{ instruction: 'use csv-stringify', did: 'wrote it by hand', why: 'no network' }] },
  );
  const lines = msg.split('\n');
  t.check('the planned subject is line 0, then a blank line', [lines[0], lines[1]], ['Add CSV writer', '']);
  const order = ['Keeps the flag off.', 'Wrote the writer; one test still fails.', 'Not as the task said:', 'Ended failed: a check failed', 'Task: csv-writer', 'Attempt: 2', 'Not pushed.'].map((p) => msg.indexOf(p));
  t.truthy('the paragraphs come in order', order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1]!)), { order, msg });
  t.check('a 100-character title makes a 72-character subject', commitMessage({ title: 'y'.repeat(100) } as Task, { status: 'done' }).split('\n')[0]!.length, 72);
  t.check('an empty title has a subject still', commitMessage({ title: '' } as Task, { status: 'done' }).split('\n')[0], 'copilot-operator task');
  t.truthy('every message says it was not pushed', [msg, commitMessage({ title: 'x' } as Task, { status: 'done' })].every((m) => m.includes('Not pushed.')));

  /*
   * What a task is told about the repository: whose work is in its tree and whose is not, said
   * outright, and that pushing is the operator's.
   */
  console.log('\n--- what the task is told about the repository ---');
  const perSession = noteFor('C:\\repo', { branch: 'cop/s' }, { mode: 'per-session', earlier: [{ title: 'a', branch: 'cop/s' }, { title: 'b', branch: 'cop/s' }] });
  t.truthy('per-session: the earlier work is in the tree', perSession.includes('already carries the work of 2 earlier task(s)'), perSession);
  const perTask = noteFor('C:\\repo', { branch: 'cop/b' }, { mode: 'per-task', earlier: [{ title: 'a', branch: 'cop/a' }] });
  t.truthy('per-task: says where the earlier work is', perTask.includes('"a" is on `cop/a`'), perTask);
  t.truthy('and that it is not in the tree', perTask.includes('NOT in your working tree'), perTask);
  const first = noteFor('C:\\repo', { branch: 'cop/s' }, { mode: 'per-session', earlier: [] });
  t.truthy('the first task is told so', first.includes('This is the first task on this branch.'), first);
  t.check('no branch: nothing to say', noteFor('C:\\repo', {}), '');
  t.truthy('every note forbids pushing', [perSession, perTask, first].every((n) => n.includes('Do not push anything.')));
  const warns = (outcome: NonNullable<SessionStart['update']>['outcome']): boolean => updateWarns({ kind: 'branch', commit: 'abc1234', branch: 'main', update: { branch: 'main', outcome } });
  t.check('an update that did not bring the branch up warns', (['diverged', 'ahead', 'fetch-failed', 'failed'] as const).map(warns), [true, true, true, true]);
  t.check('one that did, or had nothing to do, does not', (['updated', 'up-to-date', 'no-remote'] as const).map(warns), [false, false, false]);

  /*
   * What a commit may carry.
   *
   * Installed, built and cached output is reported by its folder, once; `.env` files other than the
   * ones meant to be committed are secrets; a file named like a build folder is not one.
   */
  console.log('\n--- hygiene, integrity, scope ---');
  t.check('a file under node_modules is reported by its folder', looksGenerated('api/node_modules/zod/index.js')?.key, 'api/node_modules/');
  t.check('.next too', looksGenerated('web/.next/BUILD_ID')?.key, 'web/.next/');
  t.check('.env.local is a secrets file', looksGenerated('.env.local')?.reason, 'a secrets file');
  t.check('work files are not reported', ['.env.example', 'src/build.ts', 'web/next-env.d.ts', 'README.md'].map((p) => looksGenerated(p)), [null, null, null, null]);
  t.check('three node_modules files are one entry', findSuspicious(['api/node_modules/a.js', 'api/node_modules/b/c.js', 'api/node_modules/d.js']).length, 1);

  // Credentials by an issuer's own prefix; mojibake needs two sequences; a BOM breaks YAML.
  const kinds = (path: string, text: string | Buffer): string[] => Object.keys(traitsOf(path, typeof text === 'string' ? Buffer.from(text, 'utf8') : text));
  t.check('an AWS key id is a secret', kinds('a.txt', 'aws = AKIA' + 'ABCDEFGHIJKLMNOP\n'), ['secret']);
  t.check('an Anthropic key is a secret', kinds('a.txt', 'key: sk-' + 'ant-' + 'a1b2c3d4e5'.repeat(4) + '\n'), ['secret']);
  t.check('an Azure account key is a secret', kinds('a.txt', 'Account' + 'Key=' + 'Zm9vYmFy'.repeat(5) + 'AbC=\n'), ['secret']);
  t.check('a Google key is a secret', kinds('a.txt', 'key: AI' + 'za' + 'b'.repeat(35) + '\n'), ['secret']);
  t.check('one mojibake pair alone is not mojibake', kinds('a.md', 'CafÃ© only once'), []);
  t.check('two mojibake pairs are mojibake', kinds('a.md', 'CafÃ© and naÃ¯ve'), ['mojibake']);
  const bomYaml = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('name: deploy\n', 'utf8')]);
  t.check('a BOM in deploy.yml is a bom', kinds('deploy.yml', bomYaml), ['bom']);
  t.check('and a new deploy.yml with one is reported', newProblems('deploy.yml', bomYaml, null).map((p) => p.kind), ['bom']);

  // A task's scope: `?` is one character, and a folder may be written with ./ or / in front.
  t.check('? matches one character', inScope('src/a1.ts', ['src/a?.ts']), true);
  t.check('and not two', inScope('src/a12.ts', ['src/a?.ts']), false);
  t.check('./docs/ covers a file under docs', inScope('docs/x.md', ['./docs/']), true);
  // DEFECT: a scope folder written "/docs" (no trailing slash) covers nothing under it, while "docs", "docs/" and "/docs/" do: inScope's plain-folder test does not strip the leading "/".
  t.check('/docs covers a file under docs', inScope('docs/x.md', ['/docs']), true);
} catch (e) {
  t.truthy('ran without throwing', false, (e as Error).stack ?? String(e));
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)} s)`);
t.finish();
