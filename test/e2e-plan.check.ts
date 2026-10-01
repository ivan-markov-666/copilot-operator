/**
 * Plans, sessions and the operator's own data, through the API the interface uses, with the scripted
 * chat of test/support/fakeChat.ts in place of Copilot.
 *
 * A plan arrives from a chat model nobody here controls, and everything the operator keeps — sessions,
 * presets, the contract, the settings — is JSON on disk that the same API rewrites. So this pins:
 *
 * - `checkPlan` answers every document and never throws, and every refusal names the path a person
 *   (or the chat that wrote the plan) has to fix;
 * - the schema, its warnings and the brief handed to the chat model agree about which fields exist;
 * - what an import stamps on the tasks it makes: the persona in force, the expected result, the model,
 *   the plan's name, the review;
 * - sessions that share one conversation, and where a session's commands run;
 * - that a plan is checked against the machine and imported whole or not at all, and says what it
 *   would duplicate;
 * - that the store keeps every write when several arrive at once, and survives a broken file;
 * - the task routes: edit, add, delete, run again, continue — and what a re-run keeps on the record;
 * - level 1 and the context texts, the text export's headers, the run exports and the live events.
 *
 * Checks marked `// DEFECT:` fail today on purpose: each names a defect in the product, and passes
 * once that defect is fixed. Checks marked as a decision pin hold behaviour that was chosen.
 *
 *   npm run check:e2e-plan        (or: npx tsx test/e2e-plan.check.ts)
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startHarness, makeRepo, waitFor, Tally, type Harness, type TaskView, type SessionView } from './support/harness.js';
import { reply } from './support/fakeChat.js';
import { checkPlan, describeIssues, extractJson, PlanSchema, CheckInput, type PlanCheck } from '../src/plan/schema.js';
import { planBrief, planExample } from '../src/plan/brief.js';

const t = new Tally();
const started = Date.now();

// --- helpers -------------------------------------------------------------------------------

/** A scenario on a fresh program of its own; an exception is a failure, never a silent pass. */
async function scenario(title: string, settings: Record<string, unknown>, body: (h: Harness) => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  const h = await startHarness({ settings });
  try {
    await body(h);
    // A reply left over means the run ended early or skipped a stage the script expected (a review
    // that never happened, a second round never asked), which no other assertion may happen to see.
    t.check(`${title}: every scripted reply was used`, h.chat.pending, 0);
    t.check(`${title}: the chat was never asked for a reply it had no script for`, h.chat.problems, []);
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  } finally {
    h.chat.discard();
    await h.stop();
  }
}

/** The same, for checks that need no program at all. */
function unit(title: string, body: () => void): void {
  console.log(`\n--- ${title} ---`);
  try {
    body();
  } catch (e) {
    t.truthy(`${title}: ran without throwing`, false, (e as Error).stack ?? String(e));
  }
}

type Issue = { path: string; message: string };
type Duplicate = { name: string; sessionId: string; createdAt: string; tasks: number };
type CheckAnswer = { ok: boolean; issues?: Issue[]; warnings?: string[]; duplicates?: Duplicate[] };
type ImportAnswer = { ok: boolean; check?: CheckAnswer; duplicates?: Duplicate[]; result?: { warnings: string[] } };
/** A task as the API returns it: the whole record, more than `TaskView` names. */
type FullTask = Omit<TaskView, 'attempts' | 'review' | 'stats'> & {
  level2: string;
  finalReply?: string;
  stopCode?: string;
  checkResults?: unknown[];
  reviewChecks?: Array<{ findingId: string; check: { name: string }; state: string; droppedBecause?: string }>;
  review?: { verdict?: string; rounds?: number };
  stats?: Record<string, unknown>;
  runGroup?: { id: string };
  attempts?: Array<Record<string, unknown>>;
};
type FullSession = Omit<SessionView, 'tasks'> & {
  tasks: FullTask[];
  createdAt: string;
  conversationGroup?: string;
  planName?: string;
  projectDir?: string;
  runGroup?: { id: string };
};
const full = (h: Harness, id: string): Promise<FullSession> => h.call<FullSession>('GET', `/sessions/${id}`);
const issuesOf = (r: PlanCheck | CheckAnswer | undefined): Issue[] => (r && !r.ok && 'issues' in r ? (r.issues ?? []) : []);
const message = (body: unknown): string => (typeof body === 'object' && body && 'message' in body ? String((body as { message: unknown }).message) : String(body));

const write = (file: string, text: string): string => reply.steps(`Set-Content -Path ${file} -Value '${text}' -Encoding utf8`);
/** A reply exactly as given, for shapes the `reply` helpers do not make. */
const rawJson = (v: unknown): string => 'Here is my answer.\n\n```json\n' + JSON.stringify(v, null, 2) + '\n```\n';

const LONG_PROMPT = 'Create hello.txt in the project folder holding exactly the word hi, and nothing else.';

/** A task that writes one file, with the check that proves it (a lone file-exists would be refused as weak). */
const fileTask = (title: string, file: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  title,
  prompt: `Create ${file} in the repository root holding exactly the text ${text}, and nothing else.`,
  checks: [{ name: `${file} written`, expect: 'file-contains', file, value: text }],
  ...extra,
});

/** A session on its own branch of the harness repository, cut from main, with no review and no fetch. */
const onBranch = (h: Harness, name: string, tasks: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  onFailure: 'stop',
  vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: name, startFrom: 'branch', baseBranch: 'main', updateFromRemote: false },
  review: { enabled: false },
  tasks,
  ...extra,
});
const planOf = (...sessions: unknown[]): Record<string, unknown> => ({ version: 1, sessions });

// --- 1. checkPlan never throws ------------------------------------------------------------------

unit('checkPlan answers every document, and never throws', () => {
  // A null where a session should be is a malformed document, which is exactly what checkPlan exists
  // to explain. Its own comment promises "Never throws".
  let nullSession: PlanCheck | undefined;
  let thrown: string | undefined;
  try {
    nullSession = checkPlan('{"version":1,"sessions":[null]}');
  } catch (e) {
    thrown = (e as Error).message;
  }
  // DEFECT: collectWarnings reads null.vcs, so sessions:[null] throws a TypeError instead of being refused
  t.truthy('sessions:[null] is answered, not thrown', thrown === undefined, thrown);
  // DEFECT: the same throw: no refusal comes back for sessions:[null] at all
  t.truthy('sessions:[null] is refused at a path under sessions[0]', issuesOf(nullSession).some((i) => i.path.startsWith('sessions[0]')), nullSession ?? thrown);

  // The same null one level down, and two levels down: the warning walk already guards these.
  const deeper = {
    'tasks:[null]': { version: 1, sessions: [{ name: 'nulls', vcs: { enabled: false }, tasks: [null] }] },
    'checks:[null]': { version: 1, sessions: [{ name: 'nulls', vcs: { enabled: false }, tasks: [{ title: 'abc', prompt: LONG_PROMPT, checks: [null] }] }] },
  };
  for (const [what, doc] of Object.entries(deeper)) {
    let r: PlanCheck | undefined;
    let err: string | undefined;
    try {
      r = checkPlan(JSON.stringify(doc));
    } catch (e) {
      err = (e as Error).message;
    }
    t.truthy(`${what}: answered, refused at a path under sessions[0]`, !err && issuesOf(r).some((i) => i.path.startsWith('sessions[0]')), r ?? err);
  }

  // Nothing at all, and the commonest broken JSON a chat produces.
  t.check('an empty paste: one issue, no path, saying there is nothing', issuesOf(checkPlan('')), [{ path: '', message: 'There is nothing here to import.' }]);
  const comma = checkPlan('{"version":1,}');
  t.truthy('a trailing comma: refused, and the message names the likely cause', !comma.ok && issuesOf(comma).some((i) => i.message.includes('trailing comma')), comma);

  // What a chat actually sends: the JSON wrapped in prose and a fence, labelled or not. The prose
  // around each fence holds braces of its own, as a chat's prose does ("Draft {v2}", "{anything}"):
  // then the fallback — first brace to last — takes in prose and is not JSON, so only the fence can
  // find the plan. Without those braces the fallback would find the same body, and these cases would
  // pass with fence extraction gone.
  const body = JSON.stringify(planExample(), null, 2);
  const fencedCases = {
    'prose and a ```json fence': `Draft {v2}: here is the plan you asked for.\n\n\`\`\`json\n${body}\n\`\`\`\n\nTell me if {anything} should change.`,
    'an unlabelled fence': `The plan:\n\n\`\`\`\n${body}\n\`\`\`\n\nTell me if {anything} should change.`,
    'a ```jsonc fence': `\`\`\`jsonc\n${body}\n\`\`\`\n\nTell me if {anything} should change.`,
  };
  for (const [what, text] of Object.entries(fencedCases)) {
    t.check(`the example plan in ${what}: the fence's body is what is extracted`, extractJson(text) === body, true);
    const r = checkPlan(text);
    t.truthy(`the example plan in ${what} is found and accepted`, r.ok, issuesOf(r));
    // The control: the same text with the fence markers taken away is refused, so the case above
    // cannot have been accepted by the fallback.
    const unfenced = checkPlan(text.replace(/```(?:jsonc?)?/g, ''));
    t.truthy(`${what} with the fence markers taken away is not accepted (the case above rests on the fence)`, !unfenced.ok, unfenced.ok ? 'accepted' : undefined);
  }
  // No fence at all: the first brace to the last is the plan.
  const bare = `Sure — ${body} — that is all of it.`;
  t.check('bare JSON inside prose: the braces and what is between them are extracted', extractJson(bare) === body, true);
  const bareCheck = checkPlan(bare);
  t.truthy('the example plan as bare JSON inside prose is found and accepted', bareCheck.ok, issuesOf(bareCheck));
});

await scenario('POST /plan/check with a document that used to throw', {}, async (h) => {
  const r = await h.raw('POST', '/plan/check', { text: '{"version":1,"sessions":[null]}' });
  // A malformed plan is an answer (2xx, ok:false) the page shows, not a request error.
  // DEFECT: the TypeError from checkPlan escapes and the route answers 400 with it, instead of ok:false and the issue
  t.truthy('answered 2xx with ok:false and an issue under sessions[0]', r.status >= 200 && r.status < 300 && (r.body as CheckAnswer).ok === false &&
    ((r.body as CheckAnswer).issues ?? []).some((i) => i.path.startsWith('sessions[0]')), r);
});

// --- 2. the refusal table -------------------------------------------------------------------------

unit('every refusal names the path to fix', () => {
  type Doc = { version: unknown; plan?: string; conversation?: unknown; onFailure?: unknown; sessions: Array<Record<string, unknown>> };
  /** A plan that is accepted as it is: one session without version control, one task. */
  const base = (): Doc => ({ version: 1, sessions: [{ name: 'table', vcs: { enabled: false }, tasks: [{ title: 'abc', prompt: LONG_PROMPT }] }] });
  const task0 = (d: Doc): Record<string, unknown> => (d.sessions[0]!.tasks as Array<Record<string, unknown>>)[0]!;
  const run = (mutate: (d: Doc) => void): PlanCheck => {
    const d = base();
    mutate(d);
    return checkPlan(JSON.stringify(d));
  };
  const refused = (what: string, mutate: (d: Doc) => void, path: string, says?: string): void => {
    const r = run(mutate);
    const hit = issuesOf(r).find((i) => i.path === path && (says === undefined || i.message.includes(says)));
    t.truthy(`${what}: refused at ${path}${says ? ` saying "${says}"` : ''}`, !r.ok && !!hit, r.ok ? 'accepted' : issuesOf(r));
  };
  const accepted = (what: string, mutate: (d: Doc) => void): void => {
    const r = run(mutate);
    t.truthy(`${what}: accepted`, r.ok, issuesOf(r));
  };

  accepted('the base plan', () => undefined);
  refused('no sessions', (d) => { d.sessions = []; }, 'sessions');
  refused('a session with no tasks', (d) => { d.sessions[0]!.tasks = []; }, 'sessions[0].tasks');
  refused('a prompt of three words', (d) => { task0(d).prompt = 'fix the bug'; }, 'sessions[0].tasks[0].prompt');
  refused('a two-letter title', (d) => { task0(d).title = 'ab'; }, 'sessions[0].tasks[0].title');
  accepted('a three-letter title', (d) => { task0(d).title = 'abc'; });
  refused('a 121-character title', (d) => { task0(d).title = 'x'.repeat(121); }, 'sessions[0].tasks[0].title');
  refused('a 29-character prompt', (d) => { task0(d).prompt = 'x'.repeat(29); }, 'sessions[0].tasks[0].prompt');
  accepted('a 30-character prompt', (d) => { task0(d).prompt = 'x'.repeat(30); });
  refused('readOnly as a word', (d) => { task0(d).readOnly = 'yes'; }, 'sessions[0].tasks[0].readOnly');
  refused('a blank scope entry', (d) => { task0(d).scope = [' ']; }, 'sessions[0].tasks[0].scope[0]');
  refused('version 2', (d) => { d.version = 2; }, 'version', 'version 1');
  refused('onFailure "maybe"', (d) => { d.sessions[0]!.onFailure = 'maybe'; }, 'sessions[0].onFailure');
  refused('conversation "both"', (d) => { d.conversation = 'both'; }, 'conversation');
  refused('branchMode "per-feature"', (d) => { d.sessions[0]!.vcs = { enabled: false, branchMode: 'per-feature' }; }, 'sessions[0].vcs.branchMode');
  refused('no vcs at all: the question is handed back', (d) => { delete d.sessions[0]!.vcs; }, 'sessions[0].vcs', 'Ask the user');
  refused('vcs with no answer to "on or off"', (d) => { d.sessions[0]!.vcs = { repoDir: 'C:/x' }; }, 'sessions[0].vcs.enabled');
  refused('vcs on with a blank repository', (d) => { d.sessions[0]!.vcs = { enabled: true, repoDir: '   ' }; }, 'sessions[0].vcs.repoDir');
  refused('startFrom existing-branch naming no branch', (d) => { d.sessions[0]!.vcs = { enabled: false, startFrom: 'existing-branch' }; },
    'sessions[0].vcs.existingBranch', 'must name the local branch');
  refused('existingBranch with startFrom "branch"', (d) => { d.sessions[0]!.vcs = { enabled: false, startFrom: 'branch', existingBranch: 'main' }; },
    'sessions[0].vcs.existingBranch', 'Keep one');

  const withCheck = (check: Record<string, unknown>) => (d: Doc): void => { task0(d).checks = [check]; };
  refused('exit-zero with no command', withCheck({ name: 'it runs', expect: 'exit-zero' }), 'sessions[0].tasks[0].checks[0].run');
  refused('file-exists with no file', withCheck({ name: 'it exists', expect: 'file-exists' }), 'sessions[0].tasks[0].checks[0].file');
  refused('output-contains with nothing to look for', withCheck({ name: 'it says', expect: 'output-contains', run: 'echo hi' }), 'sessions[0].tasks[0].checks[0].value');
  refused('output-matches with a broken pattern', withCheck({ name: 'it matches', expect: 'output-matches', run: 'echo hi', value: '(' }),
    'sessions[0].tasks[0].checks[0].value', 'not a valid regular expression');
  refused('an expect that is not one of the kinds', withCheck({ name: 'it runs', expect: 'exit-0', run: 'echo hi' }), 'sessions[0].tasks[0].checks[0].expect');
  refused('a shell that is not offered', withCheck({ name: 'it says', expect: 'output-contains', run: 'echo hi', value: 'hi', shell: 'bash' }), 'sessions[0].tasks[0].checks[0].shell');
  refused('a two-letter check name', withCheck({ name: 'ab', expect: 'output-contains', run: 'echo hi', value: 'hi' }), 'sessions[0].tasks[0].checks[0].name');

  // What is left out is filled in, the safe way: a chain that stops, a conversation per session.
  const defaults = checkPlan(JSON.stringify(base()));
  t.check('left out: onFailure "stop" at both levels, conversation "per-session"',
    defaults.ok ? [defaults.plan.onFailure, defaults.plan.sessions[0]!.onFailure, defaults.plan.conversation] : issuesOf(defaults),
    ['stop', 'stop', 'per-session']);

  // The block the page offers to copy back to the chat, one line per issue.
  t.check('describeIssues: a path when there is one, the bare message when not',
    describeIssues([{ path: 'a', message: 'm' }, { path: '', message: 'n' }]), '- a: m\n- n');
});

// --- 3. warnings and the brief agree with the schema --------------------------------------------

unit('warnings and the brief agree with the schema', () => {
  // One invented key at each of the seven levels the warning walk visits. Each must be named by its
  // path, because "something was ignored" is not something a chat can fix.
  const invented = {
    version: 1,
    x_plan: 1,
    sessions: [{
      name: 'invented',
      x_session: 1,
      vcs: { enabled: false, x_vcs: 1 },
      review: { enabled: false, x_review: 1 },
      tasks: [{
        title: 'abc',
        prompt: LONG_PROMPT,
        x_task: 1,
        vcs: { branch: 'b', x_taskvcs: 1 },
        checks: [{ name: 'hello says hi', expect: 'file-contains', file: 'hello.txt', value: 'hi', x_check: 1 }],
      }],
    }],
  };
  const paths = ['plan.x_plan', 'sessions[0].x_session', 'sessions[0].vcs.x_vcs', 'sessions[0].review.x_review', 'sessions[0].tasks[0].x_task',
    'sessions[0].tasks[0].vcs.x_taskvcs', 'sessions[0].tasks[0].checks[0].x_check'];
  const inv = checkPlan(JSON.stringify(invented));
  const warnings = inv.warnings;
  t.check('invented keys: still imported, with exactly seven warnings', [inv.ok, warnings.length], [true, 7]);
  t.check('each warning names its own path', paths.map((p) => warnings.filter((w) => w.startsWith(`${p} `)).length), paths.map(() => 1));

  // Every optional field the format has, on the brief's own example: none of them may be warned about.
  const everything = planExample() as { sessions: Array<Record<string, unknown> & { vcs: Record<string, unknown>; tasks: Array<Record<string, unknown>> }> };
  const [first, second] = everything.sessions;
  first!.vcs = { ...first!.vcs, startFrom: 'existing-branch', existingBranch: 'main', updateFromRemote: false, branchName: 'invoice-export' };
  first!.projectDir = 'C:\\Projects\\billing';
  first!.conversationGroup = 'billing';
  first!.tasks[0]!.scope = ['src/invoices/'];
  (first!.tasks[0]!.checks as Array<Record<string, unknown>>)[0]!.shell = 'powershell';
  first!.tasks[1]!.review = false;
  second!.tasks[0]!.readOnly = true;
  second!.review = { enabled: false, model: '' };
  const all = checkPlan(JSON.stringify(everything));
  t.check('the example with every optional field: accepted, no warnings', [all.ok, all.warnings], [true, []]);

  const example = checkPlan(JSON.stringify(planExample()));
  t.check('the example as shipped: accepted, no warnings, vcs on then off',
    example.ok ? [example.warnings, example.plan.sessions[0]!.vcs.enabled, example.plan.sessions[1]!.vcs.enabled] : issuesOf(example), [[], true, false]);

  const twins = checkPlan(JSON.stringify({ version: 1, sessions: [
    { name: 'a-session', vcs: { enabled: false }, tasks: [{ title: 'abc', prompt: LONG_PROMPT }] },
    { name: 'A-Session', vcs: { enabled: false }, tasks: [{ title: 'abc', prompt: LONG_PROMPT }] },
  ] }));
  t.check('two sessions whose names differ only in case: one warning', twins.warnings.filter((w) => w.includes('Two sessions are both called')).length, 1);

  // The brief is the only thing the chat model reads about the format. A field the importer accepts
  // and the brief never names is a field no plan will ever use on purpose.
  type Shaped = { shape: Record<string, unknown> };
  const planShape = (PlanSchema as unknown as Shaped).shape;
  const sessionShape = (planShape.sessions as { element: Shaped }).element.shape;
  const taskShape = (sessionShape.tasks as { element: Shaped }).element.shape;
  const vcsShape = (sessionShape.vcs as Shaped).shape;
  const checkShape = (CheckInput as unknown as Shaped).shape;
  const legacy = new Set(['mirror', 'earlierAttempts']);
  const keys = [...new Set([planShape, sessionShape, taskShape, vcsShape, checkShape].flatMap((s) => Object.keys(s)))].filter((k) => !legacy.has(k));
  const expectKinds = [...(checkShape.expect as { options: string[] }).options].sort();
  const startFromValues = (vcsShape.startFrom as { unwrap: () => { options: string[] } }).unwrap().options;

  for (const lang of ['en', 'bg']) {
    const brief = planBrief({ lang });
    // Named the way the brief names fields: in code, in quotes, in a table cell, or as vcs.<field>.
    const named = (k: string): boolean => new RegExp(`(?:\`|"|\\| |vcs\\.)${k}(?:\`|"|:| \\|)`).test(brief);
    // DEFECT: the brief never mentions projectDir, the field that says where a session without version control works
    t.check(`${lang}: the brief names every field of the format`, keys.filter((k) => !named(k)), []);

    const start = brief.indexOf('| expect |');
    const rows = start < 0 ? [] : brief.slice(start).split('\n').slice(2).filter((_, i, a) => a.slice(0, i + 1).every((l) => l.startsWith('|')))
      .map((l) => l.split('|')[1]!.trim());
    t.check(`${lang}: the checks table lists exactly the kinds the schema accepts`, [...rows].sort(), expectKinds);

    const at = brief.indexOf('**startFrom**');
    const section = at < 0 ? '' : brief.slice(at, brief.indexOf('\n\n**', at + 5) > 0 ? brief.indexOf('\n\n**', at + 5) : undefined);
    const listed = [...section.matchAll(/^- `"([a-z-]+)"`/gm)].map((m) => m[1]!);
    t.truthy(`${lang}: every startFrom the brief offers is one the schema accepts`, listed.length >= 3 && listed.every((v) => startFromValues.includes(v)), { listed, startFromValues });
    // Decision pin: "head" is accepted but deliberately not offered. It is what leaving startFrom out
    // already means (session/model.ts calls it "the one to avoid"), and the brief says so in words.
    t.check(`${lang}: "head" is accepted and not offered (decision pin)`, [startFromValues.includes('head'), listed.includes('head')], [true, false]);
  }
});

// --- 4. what an import stamps on tasks ------------------------------------------------------------

await scenario('what an import stamps on the tasks it makes', { copilot: { defaultModel: 'GPT 5.6 Think deeper' } }, async (h) => {
  const PERSONA = '## How to carry out this work';
  const twoTasks = (name: string): Record<string, unknown> => planOf(onBranch(h, name, [fileTask('first-task', 'one.txt', 'one'), fileTask('second-task', 'two.txt', 'two')]));

  // The persona in force at the moment of import goes into every task's level 2.
  await h.call('PUT', '/context/persona', { content: 'APPROACH-X' });
  const [x] = await h.importPlan(twoTasks('persona-x'));
  const xTasks = (await full(h, x!.id)).tasks;
  t.truthy('every task opens its level 2 with the persona, and carries it', xTasks.length === 2 && xTasks.every((k) => k.level2.startsWith(PERSONA) && k.level2.includes('APPROACH-X')), xTasks.map((k) => k.level2));

  // Changing it changes the next import, never work already queued.
  await h.call('PUT', '/context/persona', { content: 'APPROACH-Y' });
  const xAgain = (await full(h, x!.id)).tasks;
  t.truthy('the session imported before the change keeps its persona', xAgain.every((k) => k.level2.includes('APPROACH-X') && !k.level2.includes('APPROACH-Y')), xAgain.map((k) => k.level2));
  const [y] = await h.importPlan(twoTasks('persona-y'));
  const yTasks = (await full(h, y!.id)).tasks;
  t.truthy('the next import carries only the new one', yTasks.every((k) => k.level2.includes('APPROACH-Y') && !k.level2.includes('APPROACH-X')), yTasks.map((k) => k.level2));
  await h.call('DELETE', '/context/persona');
  const [none] = await h.importPlan(twoTasks('persona-none'));
  const noneTasks = (await full(h, none!.id)).tasks;
  t.truthy('with the persona cleared, no task gets the heading', noneTasks.every((k) => !k.level2.includes(PERSONA)), noneTasks.map((k) => k.level2));

  // The expected result, the model, the plan's name and the review, seen from what reaches the chat.
  const [s] = await h.importPlan({
    version: 1,
    plan: 'Invoice export',
    sessions: [{
      name: 'stamped',
      model: 'Think deeper',
      onFailure: 'stop',
      vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'stamped', startFrom: 'branch', baseBranch: 'main', updateFromRemote: false },
      // No "review" key: absent means reviewed.
      tasks: [fileTask('greeting', 'hello.txt', 'hi', { expected: 'hello.txt holds hi' })],
    }],
  });
  t.check('the plan\'s name is on the session', (await full(h, s!.id)).planName, 'Invoice export');
  let opening = '';
  let reviewChat = '';
  h.chat.script(
    (m) => {
      opening = m.text;
      return write('hello.txt', 'hi');
    },
    reply.done(),
    (m) => {
      reviewChat = m.chatId;
      return reply.steps('Get-Content hello.txt');
    },
    reply.pass(),
  );
  const before = h.chat.conversations.size;
  const ran = (await h.run(s!.id)) as unknown as FullSession;
  const task = ran.tasks[0]!;
  t.check('the task is done', task.status, 'done');
  t.truthy('its first message carries the expected result under its heading', opening.includes('### Expected result') && opening.includes('hello.txt holds hi'), opening.slice(-600));
  t.check('the session\'s own model wins over the one in Settings', h.chat.modelRequests, ['Think deeper']);
  t.truthy('a session with no review key was reviewed, in a conversation of its own', task.review?.verdict === 'pass' && reviewChat !== '' && reviewChat !== ran.chat?.chatId, task.review);
  t.check('two conversations: the task\'s and the review\'s', h.chat.conversations.size - before, 2);

  // review:false on one task of a reviewed session: that task is not reviewed, so one conversation.
  const [u] = await h.importPlan(planOf({ ...onBranch(h, 'unreviewed', [fileTask('quiet', 'quiet.txt', 'quiet', { review: false })]), review: undefined }));
  const unreviewed = (await full(h, u!.id)) as unknown as { review?: { enabled?: boolean } };
  t.check('the session itself is reviewed', unreviewed.review?.enabled, true);
  h.chat.script(write('quiet.txt', 'quiet'), reply.done());
  const beforeQuiet = h.chat.conversations.size;
  const quiet = ((await h.run(u!.id)) as unknown as FullSession).tasks[0]!;
  t.check('the task is done, its review skipped', [quiet.status, quiet.review?.verdict], ['done', 'skipped']);
  t.check('and only one conversation was opened', h.chat.conversations.size - beforeQuiet, 1);
  // The control for "wins over": this session names no model, so the Settings default is what it asks
  // for. Without it, ['Think deeper'] above could as well mean the setting is never read.
  t.check('a session with no model of its own asks for the one in Settings', h.chat.modelRequests, ['Think deeper', 'GPT 5.6 Think deeper']);
});

// --- 5. shared conversations ----------------------------------------------------------------------

await scenario('sessions of a plan that share one conversation', {}, async (h) => {
  const [a, b, c] = await h.importPlan({
    version: 1,
    plan: 'Shared run',
    conversation: 'shared',
    sessions: [
      onBranch(h, 'part-a', [fileTask('a-task', 'a.txt', 'a')]),
      onBranch(h, 'part-b', [fileTask('b-task', 'b.txt', 'b')]),
      onBranch(h, 'part-c', [fileTask('c-task', 'c.txt', 'c')], { conversationGroup: 'apart' }),
    ],
  });
  const groups = await Promise.all([a, b, c].map(async (s) => (await full(h, s!.id)).conversationGroup));
  t.check('A and B are grouped under the plan\'s name, C keeps its own group', groups, ['Shared run', 'Shared run', 'apart']);

  h.chat.script(write('a.txt', 'a'), reply.done());
  const ranA = await full(h, (await h.run(a!.id)).id);
  let bFirst = '';
  h.chat.script((m) => {
    bFirst = m.chatId;
    return write('b.txt', 'b');
  }, reply.done());
  const ranB = await h.run(b!.id);
  t.check('both done', [ranA.tasks[0]!.status, ranB.tasks[0]!.status], ['done', 'done']);
  t.check('B\'s first message went into A\'s conversation', bFirst, ranA.chat?.chatId);
  t.check('and B records that conversation as its own', ranB.chat?.chatId, ranA.chat?.chatId);
  t.check('the contract went once for the two of them', h.chat.sent.filter((m) => m.contract === 'task').length, 1);

  let cFirst = '';
  h.chat.script((m) => {
    cFirst = m.chatId;
    return write('c.txt', 'c');
  }, reply.done());
  const ranC = await h.run(c!.id);
  t.truthy('C, in a group of its own, opened a new conversation', ranC.tasks[0]!.status === 'done' && cFirst !== '' && cFirst !== ranA.chat?.chatId, { cFirst, a: ranA.chat?.chatId });

  // A shared plan with no name is grouped under the moment it was imported.
  const [unnamed] = await h.importPlan({ version: 1, conversation: 'shared', sessions: [onBranch(h, 'unnamed-part', [fileTask('u-task', 'u.txt', 'u')])] });
  const unnamedGroup = (await full(h, unnamed!.id)).conversationGroup ?? '';
  t.truthy('without a plan name the group is plan-<yyyymmddhhmm>', /^plan-\d{12}$/.test(unnamedGroup), unnamedGroup);

  // Decision pin: the same plan name imported again joins the conversation that name already has —
  // no new chat and no second contract — because the group is only a name (joinGroupConversation).
  const [again] = await h.importPlan({ version: 1, plan: 'Shared run', conversation: 'shared', sessions: [onBranch(h, 'part-d', [fileTask('d-task', 'd.txt', 'd')])] });
  const contractsBefore = h.chat.sent.filter((m) => m.contract === 'task').length;
  let dFirst = '';
  h.chat.script((m) => {
    dFirst = m.chatId;
    return write('d.txt', 'd');
  }, reply.done());
  const ranD = await h.run(again!.id);
  t.check('re-imported under the same name: done in the old conversation, no new contract (decision pin)',
    [ranD.tasks[0]!.status, dFirst === ranA.chat?.chatId, h.chat.sent.filter((m) => m.contract === 'task').length - contractsBefore], ['done', true, 0]);
});

// --- 6. where an imported session works ------------------------------------------------------------

{
  // execution.cwd is pointed at a folder of this check's own, so a session that falls through to it
  // writes there — never into this checkout — and the check can say where the file went.
  const configCwd = mkdtempSync(join(tmpdir(), 'cop-plan-cwd-'));
  await scenario('where an imported session\'s commands run', { execution: { cwd: configCwd } }, async (h) => {
    const elsewhere = join(h.base, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const [p] = await h.importPlan(planOf({
      name: 'in-project-dir',
      onFailure: 'stop',
      vcs: { enabled: false },
      projectDir: elsewhere,
      review: { enabled: false },
      tasks: [{ title: 'write-x', prompt: 'Create x.txt in the project folder holding exactly x, and nothing else.' }],
    }));
    h.chat.script(write('x.txt', 'x'), reply.done());
    const ranP = await h.run(p!.id);
    t.check('vcs off with a projectDir: the step wrote x.txt there, and only there',
      [ranP.tasks[0]!.status, existsSync(join(elsewhere, 'x.txt')), existsSync(join(h.repo, 'x.txt'))], ['done', true, false]);

    // No projectDir and version control off: the Project page's folder (project.rootDir, the harness
    // repository) is where a session made by hand works, and an imported one should too.
    const [d] = await h.importPlan(planOf({
      name: 'default-folder',
      onFailure: 'stop',
      vcs: { enabled: false },
      review: { enabled: false },
      tasks: [{ title: 'write-y', prompt: 'Create y.txt in the project folder holding exactly y, and nothing else.' }],
    }));
    const imported = await full(h, d!.id);
    // DEFECT: importPlan does not fill the Project page's folder into projectDir (createSession in the service does), so it stays ''
    t.check('an imported session with no folder gets the Project page\'s folder', imported.projectDir, h.repo);
    h.chat.script(write('y.txt', 'y'), reply.done());
    await h.run(d!.id);
    // DEFECT: with projectDir empty the session runs in execution.cwd, not in the project the operator chose
    t.truthy('and its step wrote y.txt in that project', existsSync(join(h.repo, 'y.txt')),
      `y.txt in the project: ${existsSync(join(h.repo, 'y.txt'))}; in execution.cwd (${configCwd}): ${existsSync(join(configCwd, 'y.txt'))}`);
  });
  rmSync(configCwd, { recursive: true, force: true });
}

// --- 7. repository checks at import, and all or nothing -----------------------------------------------

await scenario('a plan is checked against this machine, and imported whole or not at all', {}, async (h) => {
  // Before anything else in this program: a refused import must leave no session behind.
  const halfGood = planOf(onBranch(h, 'good-half', [fileTask('good-task', 'g.txt', 'g')]), { name: 'bad-half', tasks: [fileTask('bad-task', 'b.txt', 'b')] });
  const imp = await h.call<ImportAnswer>('POST', '/plan/import', { text: JSON.stringify(halfGood) });
  t.check('the second session lacks vcs: refused, pointing at it', [imp.ok, imp.check?.issues?.[0]?.path], [false, 'sessions[1].vcs']);
  t.check('and nothing of the first session was created', await h.call('GET', '/sessions'), []);

  const withVcs = (vcs: Record<string, unknown>): string => JSON.stringify(planOf({ name: 'where', onFailure: 'stop', vcs, review: { enabled: false }, tasks: [fileTask('where-task', 'w.txt', 'w')] }));
  const check = (vcs: Record<string, unknown>): Promise<CheckAnswer> => h.call<CheckAnswer>('POST', '/plan/check', { text: withVcs(vcs) });

  const missing = await check({ enabled: true, repoDir: join(h.base, 'nope') });
  t.truthy('a repository folder that is not there: refused on repoDir, saying so', !missing.ok && missing.issues?.[0]?.path === 'sessions[0].vcs.repoDir' && /does not exist/.test(missing.issues[0].message), missing);
  const notGit = await check({ enabled: true, repoDir: h.base });
  t.truthy('a folder that is not a repository: refused on repoDir, saying so', !notGit.ok && notGit.issues?.[0]?.path === 'sessions[0].vcs.repoDir' && /is not a git repository/.test(notGit.issues[0].message), notGit);
  mkdirSync(join(h.repo, 'sub'), { recursive: true });
  const sub = await check({ enabled: true, repoDir: join(h.repo, 'sub') });
  t.truthy('a folder inside a repository is not the repository: refused', !sub.ok && sub.issues?.[0]?.path === 'sessions[0].vcs.repoDir', sub);
  const off = await check({ enabled: false, repoDir: h.base });
  t.truthy('version control off: the folder is not judged', off.ok, off);
  const offBranch = await check({ enabled: false, existingBranch: 'no-such-branch' });
  t.truthy('an existingBranch on a session without version control is not looked for', offBranch.ok, offBranch);
});

// --- 8. duplicates, and a branch made earlier in the same plan ---------------------------------------

await scenario('what a plan would duplicate, and a branch an earlier session makes', {}, async (h) => {
  const P = (level2 = '', prompt?: string): Record<string, unknown> =>
    planOf(onBranch(h, 'dup-session', [fileTask('dup-task', 'dup.txt', 'dup', prompt ? { prompt } : {})], { level2 }));
  const [first] = await h.importPlan(P());
  const created = (await full(h, first!.id)).createdAt;
  const dupsOf = async (plan: unknown): Promise<unknown[]> =>
    ((await h.call<CheckAnswer>('POST', '/plan/check', { text: JSON.stringify(plan) })).duplicates ?? []).map((d) => [d.name, d.sessionId, d.tasks, d.createdAt]);
  t.check('checking it again names the session it would duplicate', await dupsOf(P()), [['dup-session', first!.id, 1, created]]);
  t.check('a different level 2 is still the same work', (await dupsOf(P('Different project notes for the second paste.'))).length, 1);
  t.check('a changed prompt is not a duplicate', await dupsOf(P('', 'Create dup.txt in the repository root holding exactly dup, and a second line.')), []);
  const second = await h.call<ImportAnswer>('POST', '/plan/import', { text: JSON.stringify(P()) });
  t.check('importing it twice is allowed, and says what it duplicated', [second.ok, (second.duplicates ?? []).map((d) => d.sessionId)], [true, [first!.id]]);
  t.check('two sessions of that name now exist', (await h.call<FullSession[]>('GET', '/sessions')).filter((s) => s.name === 'dup-session').length, 2);

  // A session may carry on the branch an earlier session of the same plan makes: it is not there at import.
  const stages = planOf(
    { ...onBranch(h, 'stage-one', [fileTask('stage-one-task', 'one.txt', 'one')]), vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'stage-1', startFrom: 'branch', baseBranch: 'main', updateFromRemote: false } },
    { ...onBranch(h, 'stage-two', [fileTask('stage-two-task', 'two.txt', 'two')]), vcs: { enabled: true, repoDir: h.repo, existingBranch: 'cop/stage-1', updateFromRemote: false } },
  );
  const staged = await h.call<CheckAnswer>('POST', '/plan/check', { text: JSON.stringify(stages) });
  t.truthy('existingBranch made by an earlier session of the plan: accepted', staged.ok, staged);
  const [one, two] = await h.importPlan(stages);
  h.chat.script(write('one.txt', 'one'), reply.done());
  const ranOne = (await h.run(one!.id)).tasks[0]!;
  h.chat.script(write('two.txt', 'two'), reply.done());
  const ranTwo = (await h.run(two!.id)).tasks[0]!;
  t.check('both done, the second on the first one\'s branch', [ranOne.status, ranTwo.status, ranOne.vcs?.branch, ranTwo.vcs?.branch], ['done', 'done', 'cop/stage-1', 'cop/stage-1']);
  t.check('the second task\'s commit sits on the first one\'s', ranTwo.vcs?.commit ? h.git('rev-parse', `${ranTwo.vcs.commit}^`) : null, ranOne.vcs?.commit);

  // The same name made in another repository is not a branch of this one.
  const repo2 = join(h.base, 'repo2');
  mkdirSync(repo2, { recursive: true });
  await makeRepo(repo2);
  const elsewhere = planOf(
    { ...onBranch(h, 'stage-far', [fileTask('far-task', 'far.txt', 'far')]), vcs: { enabled: true, repoDir: repo2, branchMode: 'per-session', branchName: 'stage-9', startFrom: 'branch', baseBranch: 'main', updateFromRemote: false } },
    { ...onBranch(h, 'stage-near', [fileTask('near-task', 'near.txt', 'near')]), vcs: { enabled: true, repoDir: h.repo, existingBranch: 'cop/stage-9', updateFromRemote: false } },
  );
  const far = await h.call<CheckAnswer>('POST', '/plan/check', { text: JSON.stringify(elsewhere) });
  // DEFECT: madeEarlier compares branch names only, not repositories, so a branch made in repo2 lets a session in another repository pass the import check
  t.truthy('a branch an earlier session makes in another repository does not count: refused', !far.ok && (far.issues ?? []).some((i) => i.path === 'sessions[1].vcs.existingBranch'), far);
});

// --- 9. store integrity under concurrent writers -------------------------------------------------------

await scenario('the store keeps every write when several arrive at once', {}, async (h) => {
  const [s] = await h.importPlan(planOf(onBranch(h, 'busy', [fileTask('t-zero', 'zero.txt', 'zero')])));
  const t0 = s!.tasks[0]!.id;
  // Edits from the interface at the same moment — eight adds and a rename — as double clicks or two
  // open tabs produce. Each is a read-modify-write of the same session file. Eight rather than two so
  // that, once the store queues its writes, a race brought back is seen even when a loaded machine
  // staggers the requests: with two or three, some of them could land one after another by chance.
  const titles = Array.from({ length: 8 }, (_, i) => `task-${String.fromCharCode(97 + i)}`);
  const answers = await Promise.all([
    ...titles.map((title) => h.raw('POST', `/sessions/${s!.id}/tasks`, { title, prompt: `Create ${title}.txt in the repository root holding exactly ${title}, and nothing else.` })),
    h.raw('PUT', `/sessions/${s!.id}/tasks/${t0}`, { title: 'z' }),
  ]);
  const after = await full(h, s!.id);
  // The store takes the writes of one file in turn, each through a temporary file of its own. With
  // one temporary name per process, two writes at once renamed each other's file away and one failed.
  t.truthy('all nine writes were accepted', answers.every((a) => a.status < 300), answers.map((a) => (a.status < 300 ? a.status : `${a.status} ${message(a.body)}`)));
  // And each write reads the session in its turn, after the one before has landed: read all at once,
  // every write but the last was undone by the next.
  t.check('the session has every new task and the rename', [titles.filter((title) => !after.tasks.some((k) => k.title === title)), after.tasks.find((k) => k.id === t0)?.title],
    [[], 'z']);

  // The operator edits the queue while a task of the same session is waiting on the chat. The runner's
  // own writes afterwards must not put back what it read before the edits, nor leave the task running.
  const [q] = await h.importPlan(planOf(onBranch(h, 'held', [fileTask('held-task', 'held.txt', 'held'), fileTask('later-task', 'later.txt', 'later')])));
  const [running, later] = q!.tasks;
  let asked = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  h.chat.script(async () => {
    asked = true;
    await gate;
    return write('held.txt', 'held');
  }, reply.done());
  const begun = await h.call<{ started: boolean }>('POST', '/batch/start', { sessionIds: [q!.id], mode: 'unattended', taskIds: [running!.id] });
  t.check('the run of the first task started', begun.started, true);
  // Released whatever happens in between: an edit that hits the very race this scenario is about
  // throws out of here, and the runner must not stay parked on the gate, holding this program's
  // transport and store, for the rest of the file.
  let added: { id: string };
  try {
    await waitFor('the chat to be waiting on the held reply', async () => asked);
    await h.call('PUT', `/sessions/${q!.id}/tasks/${later!.id}`, { title: 'later-edited' });
    added = await h.call<{ id: string }>('POST', `/sessions/${q!.id}/tasks`, { title: 'added-meanwhile', prompt: 'Create m.txt in the repository root holding exactly m, and nothing else.' });
  } finally {
    release();
  }
  await h.idle();
  const settled = await full(h, q!.id);
  t.check('after the release the running task is done, not stuck', settled.tasks.find((k) => k.id === running!.id)?.status, 'done');
  t.check('the edit made meanwhile stands, and the added task is there', [settled.tasks.find((k) => k.id === later!.id)?.title, settled.tasks.some((k) => k.id === added.id)], ['later-edited', true]);
  t.check('nothing is left running', settled.tasks.filter((k) => k.status === 'running' || k.status === 'waiting-approval').length, 0);
});

// --- 10. store robustness ---------------------------------------------------------------------------------

await scenario('a broken file, odd preset names, a refused setting', {}, async (h) => {
  const [kept] = await h.importPlan(planOf(onBranch(h, 'kept', [fileTask('kept-task', 'k.txt', 'k')])));
  writeFileSync(join(h.dataDir, 'sessions', 'broken.json'), '{', 'utf8');
  const listed = await h.raw('GET', '/sessions');
  t.truthy('a session file holding "{" does not take the list down: 200, the others listed', listed.status === 200 && Array.isArray(listed.body) && (listed.body as FullSession[]).some((s) => s.id === kept!.id), listed.status);

  // A preset saved under a name must be deletable under the name the save answered with. Either end
  // may be where a fix lands: a name refused at the save (4xx) is as good as one deleted afterwards,
  // and a save that tidies the name is judged by the name it answers with, not by the one asked for.
  type RoundTrip = { saveStatus: number; saved?: string; deleted?: number; gone?: boolean };
  const roundTrip = async (asked: string): Promise<RoundTrip> => {
    const save = await h.raw('PUT', `/presets/${encodeURIComponent(asked)}`, { content: `the ${asked} preset` });
    if (save.status < 200 || save.status >= 300) return { saveStatus: save.status };
    const saved = (save.body as { name: string }).name;
    const del = await h.raw('DELETE', `/presets/${encodeURIComponent(saved)}`);
    const left = await h.call<Array<{ name: string }>>('GET', '/presets');
    return { saveStatus: save.status, saved, deleted: del.status, gone: !left.some((p) => p.name === saved) };
  };
  const refusedOrDeleted = (r: RoundTrip): boolean => (r.saveStatus >= 400 && r.saveStatus < 500) || (r.deleted === 200 && r.gone === true);
  const payments = await roundTrip('Payments team!');
  t.check('"Payments team!" is saved as "Payments team" and deleted by that name', [payments.saved, payments.deleted, payments.gone], ['Payments team', 200, true]);
  const env = await roundTrip('.env');
  // The save applies the delete's rule (safePresetName): it used to keep a leading dot, which the
  // delete refuses, so ".env" was saved and could never be deleted (500).
  t.truthy('".env" is refused at the save, or deleted by the name it was saved under', refusedOrDeleted(env), env);
  const dots = await roundTrip('a..b');
  // The same for "..", which the save kept and the delete refuses.
  t.truthy('"a..b" is refused at the save, or deleted by the name it was saved under', refusedOrDeleted(dots), dots);
  // A preset saved under such a name before the save refused it is still on disk, and listed: it
  // must be deletable by the name the list shows, without letting a name reach outside the folder.
  writeFileSync(join(h.dataDir, 'level2', '.env.md'), 'saved before the rule', 'utf8');
  const listedBefore = (await h.call<Array<{ name: string }>>('GET', '/presets')).some((p) => p.name === '.env');
  const legacy = await h.raw('DELETE', `/presets/${encodeURIComponent('.env')}`);
  t.check('an old ".env" preset already on disk is listed, and deleted by that name',
    [listedBefore, legacy.status, existsSync(join(h.dataDir, 'level2', '.env.md'))], [true, 200, false]);
  writeFileSync(join(h.dataDir, 'kept.md'), 'outside the presets folder', 'utf8');
  const climb = await h.raw('DELETE', `/presets/${encodeURIComponent('..\\kept')}`);
  t.check('a name that climbs out of the folder is still refused, and the file it names is kept',
    [climb.status >= 400, existsSync(join(h.dataDir, 'kept.md'))], [true, true]);

  // A setting the schema refuses is refused before anything is written.
  const settingsFile = join(h.dataDir, 'settings.json');
  const bytes = readFileSync(settingsFile);
  const zero = await h.raw('PUT', '/settings', { limits: { maxIterations: 0 } });
  t.check('maxIterations 0 is refused', zero.status, 400);
  t.truthy('and settings.json is unchanged, byte for byte', readFileSync(settingsFile).equals(bytes), readFileSync(settingsFile, 'utf8').slice(0, 200));
});

await scenario('a settings file that no longer parses', {}, async (h) => {
  // Last in its own program: with the file broken, nothing else here may run.
  const settingsFile = join(h.dataDir, 'settings.json');
  writeFileSync(settingsFile, '{broken', 'utf8');
  const r = await h.raw('PUT', '/models/default', { model: 'X' });
  const now = readFileSync(settingsFile, 'utf8');
  // A backup is any other file anywhere under the data folder (a fix may well keep them in a folder
  // of their own) that still holds the broken text.
  const backups = readdirSync(h.dataDir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => join(f.parentPath, f.name))
    .filter((p) => resolve(p) !== resolve(settingsFile) && readFileSync(p, 'utf8').includes('{broken'));
  // DEFECT: Settings.raw() reads a broken file as {}, and the save writes {copilot:{defaultModel}} over it: every other setting is silently gone, with no backup
  t.truthy('the broken file is refused, or kept aside, not silently replaced', (r.status >= 400 && now === '{broken') || backups.length > 0,
    { status: r.status, settingsNow: now.slice(0, 120), backups });
});

// --- 11. the task routes -----------------------------------------------------------------------------------

await scenario('editing, adding, deleting and re-running tasks through the routes', {}, async (h) => {
  const [s] = await h.importPlan(planOf(onBranch(h, 'crud', [fileTask('crud-task', 'old.txt', 'old')])));
  const tid = s!.tasks[0]!.id;
  const NEW = 'Create a/new.txt holding exactly the word new, making the folder a first if it is not there.';
  const edited = await h.raw('PUT', `/sessions/${s!.id}/tasks/${tid}`, {
    prompt: NEW,
    scope: ['a/'],
    checks: [{ name: 'the new file is written', expect: 'file-contains', file: 'a/new.txt', value: 'new' }],
  });
  t.check('a queued task can be edited', edited.status, 200);
  let opening = '';
  h.chat.script((m) => {
    opening = m.text;
    return reply.steps('New-Item -ItemType Directory -Force -Path a', "Set-Content -Path a/new.txt -Value 'new' -Encoding utf8");
  }, reply.done());
  const ran = (await h.run(s!.id)).tasks[0]!;
  t.check('the edited task ran and is done', ran.status, 'done');
  t.truthy('its opening message holds the new prompt and the scope', opening.includes(NEW) && opening.includes('## Scope'), opening.slice(-800));

  const late = await h.raw('PUT', `/sessions/${s!.id}/tasks/${tid}`, { prompt: 'Something else entirely, long enough to count as a real prompt.' });
  t.check('a finished task cannot be edited in place', [late.status, message(late.body)], [400, 'Only a queued task can be edited.']);
  t.check('and its prompt is what it ran with', (await full(h, s!.id)).tasks[0]!.prompt, NEW);
  const blank = await h.raw('POST', `/sessions/${s!.id}/tasks`, { prompt: '  ' });
  t.check('a task with a blank prompt is refused', [blank.status, message(blank.body)], [400, 'A task needs a prompt.']);

  // While a step waits for the operator, the task is in flight: it can be neither deleted nor re-queued.
  const second = await h.call<{ id: string }>('POST', `/sessions/${s!.id}/tasks`, { title: 'asked-task', prompt: 'Create asked.txt in the repository root holding exactly asked, and nothing else.' });
  h.chat.script(write('asked.txt', 'asked'), reply.done());
  await h.call('POST', `/sessions/${s!.id}/start`, { mode: 'confirm' });
  const approval = await waitFor('the step to wait for approval', async () => (await h.call<Array<{ id: string; taskId: string }>>('GET', '/approvals'))[0]);
  const del = await h.raw('DELETE', `/sessions/${s!.id}/tasks/${second.id}`);
  const rerun = await h.raw('POST', `/sessions/${s!.id}/tasks/${second.id}/rerun`, {});
  const waiting = (await full(h, s!.id)).tasks.find((k) => k.id === second.id)?.status;
  t.truthy('delete and re-run of the waiting task are refused', del.status >= 400 && del.status < 500 && rerun.status >= 400 && rerun.status < 500, [del, rerun]);
  t.check('and it is still waiting for the operator', waiting, 'waiting-approval');
  await h.call('POST', `/approvals/${approval.id}`, { action: 'run' });
  await h.idle();

  const done = (await full(h, s!.id)).tasks.find((k) => k.id === second.id)!;
  t.check('the approved task finished', done.status, 'done');
  const gone = await h.raw('DELETE', `/sessions/${s!.id}/tasks/${second.id}`);
  t.check('a finished task can be deleted', gone.status, 200);
  t.check('it is gone from the session', (await full(h, s!.id)).tasks.some((k) => k.id === second.id), false);
  t.truthy('and its run folder is still on disk', !!done.runId && existsSync(join(h.runsDir, done.runId)), done.runId);

  const queued = await h.call<{ id: string }>('POST', `/sessions/${s!.id}/tasks`, { title: 'still-queued', prompt: 'Create q.txt in the repository root holding exactly q, and nothing else.' });
  const twice = await h.raw('POST', `/sessions/${s!.id}/tasks/${queued.id}/rerun`, {});
  t.truthy('re-running a task that is already queued is refused', twice.status === 400 && /already queued/.test(message(twice.body)), twice);
});

// --- 12. what a re-run keeps ------------------------------------------------------------------------------

await scenario('a re-run archives the attempt it replaces, faithfully', { limits: { maxFormatRetries: 0, retryBlockedInFreshChat: 0 } }, async (h) => {
  const [s] = await h.importPlan(planOf({ ...onBranch(h, 'archive', [fileTask('greeting', 'hello.txt', 'hi', { prompt: LONG_PROMPT })]), review: { enabled: true } }));
  // The check a reviewer gives with its finding. It fails on hello.txt as a plain Set-Content writes
  // it (the word, then a line break), so the runner keeps it with the task: a finding without one
  // would leave reviewChecks empty, and "kept as they were" would compare nothing with nothing.
  const noBreak = { name: 'hello.txt is the word and nothing more', expect: 'exit-zero', run: "if ((Get-Content -Raw hello.txt) -cne 'hi') { exit 1 }" };
  const failedWithCheck = (basis: string): string => rawJson({
    status: 'fail',
    steps: [],
    summary: 'I read hello.txt with Get-Content -Raw and compared it with the task: the file holds the word and then a line break.',
    findings: [{
      what: 'hello.txt holds a line break after the word hi, so it is not exactly the word and nothing else.',
      evidence: 'Get-Content -Raw hello.txt returned "hi" followed by a carriage return and a line feed.',
      where: 'hello.txt, the end of the file',
      basis,
      about: 'work',
      check: noBreak,
    }],
  });
  const rerun = async (patch: Record<string, unknown>): Promise<FullTask> => {
    await h.call('POST', `/sessions/${s!.id}/tasks/${s!.tasks[0]!.id}/rerun`, patch);
    return (await full(h, s!.id)).tasks[0]!;
  };

  // Attempt 1: done, reviewed and failed by the reviewer with a check, then a reply out of format with
  // no retries left. It ends at a limit with stats, a reason, a stop code, a review and a kept check —
  // and with no summary, since a limit ends it before the chat gives one.
  h.chat.script(
    write('hello.txt', 'hi'),
    reply.done(),
    reply.steps('Get-Content -Raw hello.txt'),
    failedWithCheck('holding exactly the word hi, and nothing else'),
    reply.prose('Sorry, I will fix that right away.'),
  );
  const ended = (await full(h, (await h.run(s!.id)).id)).tasks[0]!;
  const endedChecks = ended.reviewChecks ?? [];
  t.truthy('the attempt ended after a review round, with a run, stats, a reason, a stop code, the review and the reviewer\'s check kept',
    ended.status === 'limit-reached' && ended.review?.verdict === 'fail' && !!ended.runId && !!ended.stats && !!ended.reason &&
      ended.stopCode === 'format-repair-exhausted' && !!ended.handoff && endedChecks.length > 0 && endedChecks.every((rc) => rc.state === 'active'),
    { status: ended.status, review: ended.review, runId: ended.runId, stats: ended.stats, stopCode: ended.stopCode, reason: ended.reason, reviewChecks: ended.reviewChecks });
  const metricsBefore = (await h.call<{ rows: Array<Record<string, unknown>> }>('GET', '/metrics')).rows[0]!;

  // Re-run with a new prompt.
  const NEW = 'Create hello.txt in the repository root holding exactly the word hi, with no line break after it.';
  const live = await rerun({ prompt: NEW });
  const archived = live.attempts?.[0] ?? {};
  t.check('the archived attempt holds the old prompt, status, run, reason, review, stats and stop code',
    [archived.prompt, archived.status, archived.runId, archived.reason, archived.review, archived.stats, archived.stopCode],
    [ended.prompt, ended.status, ended.runId, ended.reason, ended.review, ended.stats, ended.stopCode]);
  t.check('the live task has the new prompt, attempt 2, no iterations, queued', [live.prompt, live.attempt, live.iterations, live.status], [NEW, 2, 0, 'queued']);
  t.check('its handoff, review, stats, check results, stop code and last reply are cleared',
    [live.handoff, live.review, live.stats, live.checkResults, live.stopCode, live.finalReply].map((v) => v === undefined), [true, true, true, true, true, true]);
  // The checks reviews gave stay on the task, but a new prompt is a new question: every one of them is
  // dropped, with the reason beside it (applyTaskPatch), and none is lost from the record.
  const liveChecks = live.reviewChecks ?? [];
  t.check('the checks reviews gave are all still there, for the same findings', liveChecks.map((rc) => [rc.findingId, rc.check.name]), endedChecks.map((rc) => [rc.findingId, rc.check.name]));
  t.truthy('and a new prompt drops every one of them, saying why', liveChecks.length === endedChecks.length && liveChecks.every((rc) => rc.state === 'dropped' && !!rc.droppedBecause), liveChecks);

  const metricsAfter = (await h.call<{ rows: Array<Record<string, unknown>> }>('GET', '/metrics')).rows[0]!;
  t.check('the metrics count the archived attempt once: one attempt with stats, one review rejection',
    [metricsAfter.attempts, metricsAfter.withStats, metricsAfter.reviewRejection], [1, 1, { n: 1, of: 1 }]);
  t.check('and the same as before the re-run', [metricsAfter.attempts, metricsAfter.withStats, metricsAfter.reviewRejection],
    [metricsBefore.attempts, metricsBefore.withStats, metricsBefore.reviewRejection]);

  // Attempt 2 ends done, with the chat's summary, and with a check of its own kept beside the dropped
  // one: written with the line break again, failed by the reviewer with the same check (active this
  // time), fixed, and passed on the second round. The dropped check from attempt 1 is not run by the
  // gate: if it were, its failure would take the reply scripted for the reviewer.
  const SUMMARY = 'I wrote hello.txt holding the word hi, then rewrote it with no line break after the word, as the reviewer found.';
  h.chat.script(
    write('hello.txt', 'hi'),
    reply.done(),
    reply.steps('Get-Content -Raw hello.txt'),
    failedWithCheck('with no line break after it'),
    reply.steps("Set-Content -NoNewline -Path hello.txt -Value 'hi'"),
    reply.done(SUMMARY),
    reply.steps('Get-Content -Raw hello.txt'),
    reply.pass(),
  );
  await h.run(s!.id);
  const second = (await full(h, s!.id)).tasks[0]!;
  const secondChecks = second.reviewChecks ?? [];
  t.truthy('attempt 2 is done, with the chat\'s summary, and a check of its own active beside the dropped one',
    second.status === 'done' && second.summary === SUMMARY && !!second.runId &&
      secondChecks.some((rc) => rc.state === 'dropped') && secondChecks.some((rc) => rc.state === 'active'),
    { status: second.status, summary: second.summary, reason: second.reason, reviewChecks: secondChecks });

  // Re-run with the same prompt: the same question asked again, so everything reviews gave is kept as is.
  const third = await rerun({});
  t.check('the second archived attempt holds its summary, run and status', [third.attempts?.[1]?.summary, third.attempts?.[1]?.runId, third.attempts?.[1]?.status],
    [second.summary, second.runId, 'done']);
  t.check('a re-run with the same prompt keeps the checks reviews gave exactly as they were', third.reviewChecks, second.reviewChecks);
  t.check('it is attempt 3, queued, with the prompt unchanged', [third.attempt, third.status, third.prompt], [3, 'queued', NEW]);
});

// --- 13. level 1 and the context texts ------------------------------------------------------------------------

await scenario('level 1 and the context texts', {}, async (h) => {
  const short = await h.raw('PUT', '/level1', { content: 'short' });
  t.check('a level 1 of a few words is refused', short.status, 400);
  const custom = 'You are driven by a runner. MARKER-L1-7Q. Reply in the JSON format the runner gives you, one fenced block per reply.'.padEnd(150, '.');
  await h.call('PUT', '/level1', { content: custom });
  t.check('a real one is stored, and marked customised', (await h.call<{ customised: boolean }>('GET', '/level1')).customised, true);

  const [s] = await h.importPlan(planOf(onBranch(h, 'contract', [fileTask('contract-task', 'c.txt', 'c')])));
  let firstMessage = '';
  // The fake chat recognises only the shipped contract, so the customised one is answered here.
  h.chat.script((m) => {
    firstMessage = m.text;
    return 'Understood. Send the task.';
  }, write('c.txt', 'c'), reply.done());
  const ran = (await h.run(s!.id)).tasks[0]!;
  t.truthy('a run\'s first message is the customised contract', ran.status === 'done' && firstMessage.includes('MARKER-L1-7Q'), firstMessage.slice(0, 200));

  const reset = await h.call<{ content: string; customised: boolean }>('DELETE', '/level1');
  const shipped = readFileSync(join(import.meta.dirname, '..', 'prompts', 'level1.md'), 'utf8');
  t.check('reset: not customised, and the shipped text again', [reset.customised, reset.content === shipped], [false, true]);

  const work = await h.call<{ content: string; customised: boolean; example: string }>('GET', '/context/work?lang=bg');
  t.check('the work text starts empty, with an example beside it', [work.content, work.customised, work.example.trim().length > 0], ['', false, true]);
  await h.call('PUT', '/context/work', { content: 'WORK-TEXT for this group of tasks.' });
  t.check('once written it is customised', (await h.call<{ customised: boolean }>('GET', '/context/work?lang=bg')).customised, true);
  const cleared = await h.call<{ content: string; customised: boolean }>('DELETE', '/context/work?lang=bg');
  t.check('reset: empty again', [cleared.content, cleared.customised], ['', false]);
  t.check('a kind that is not one of the three is refused', (await h.raw('GET', '/context/secrets')).status, 400);
});

// --- 14. exports and live events ----------------------------------------------------------------------------------

await scenario('the exports and the live events', { limits: { maxFormatRetries: 0, retryBlockedInFreshChat: 0 } }, async (h) => {
  const origin = `http://127.0.0.1:${h.api.port}/api`;
  const [s] = await h.importPlan(planOf({ ...onBranch(h, 'тест4', [fileTask('export-task', 'e.txt', 'e')]), vcs: { enabled: true, repoDir: h.repo, branchMode: 'per-session', branchName: 'test4', startFrom: 'branch', baseBranch: 'main', updateFromRemote: false } }));
  h.chat.script(write('e.txt', 'e'), reply.done());
  t.check('the task is done', (await h.run(s!.id)).tasks[0]!.status, 'done');

  // A name in Cyrillic once made Node refuse the header, and the download failed with no word about why.
  const res = await fetch(`${origin}/sessions/${s!.id}/export?variant=full`, { headers: { 'x-cop-token': h.api.token } });
  const text = await res.text();
  const disposition = res.headers.get('content-disposition') ?? '';
  t.check('the full record downloads as text', [res.status, /^text\/plain/.test(res.headers.get('content-type') ?? '')], [200, true]);
  t.truthy('with an ASCII filename="…" for old clients', /filename="[\x20-\x7e]+"/.test(disposition), disposition);
  t.truthy('and the real name, percent-encoded, in filename*', disposition.includes("filename*=UTF-8''%D1%82%D0%B5%D1%81%D1%824"), disposition);
  const conv = text.indexOf('THE WHOLE CONVERSATION, IN ORDER');
  t.truthy('the conversation section is there, and what was received comes after its heading', conv >= 0 && text.indexOf('RECEIVED') > conv, text.slice(0, 300));
  const outcome = await fetch(`${origin}/sessions/${s!.id}/export?variant=outcome`, { headers: { 'x-cop-token': h.api.token } });
  const outcomeText = await outcome.text();
  t.check('the outcome variant has no conversation section', [outcome.status, outcomeText.includes('THE WHOLE CONVERSATION'), outcomeText.includes('RECEIVED —')], [200, false, false]);
  const [queuedOnly] = await h.importPlan(planOf(onBranch(h, 'never-ran', [fileTask('never-task', 'n.txt', 'n')])));
  t.check('a session with only queued tasks has nothing to export', (await h.raw('GET', `/sessions/${queuedOnly!.id}/export?variant=full`)).status, 400);

  // A failure, then "run again": the export of the run it failed in must still say why it failed.
  h.git('branch', 'feature/soon-gone');
  const [f] = await h.importPlan(planOf({ ...onBranch(h, 'will-fail', [fileTask('fail-task', 'f.txt', 'f')]), vcs: { enabled: true, repoDir: h.repo, existingBranch: 'feature/soon-gone', updateFromRemote: false } }));
  h.git('branch', '-D', 'feature/soon-gone');
  await h.run(f!.id);
  const failedSession = await full(h, f!.id);
  const failed = failedSession.tasks[0]!;
  const runId = failedSession.runGroup?.id ?? '';
  t.truthy('the task failed before anything was sent', failed.status === 'failed' && runId !== '', { status: failed.status, reason: failed.reason, runId });
  await h.call('POST', `/sessions/${f!.id}/tasks/${failed.id}/rerun`, {});
  const domain = await h.raw('GET', `/export/domain?run=${encodeURIComponent(runId)}`);
  type DomainTask = { task: { id: string }; whyItFailed?: unknown; earlierAttempts?: Array<{ whyItFailed?: unknown }> };
  const doc = domain.body as { counts?: { failed: number }; tasks?: DomainTask[] };
  const entry = (doc.tasks ?? []).find((x) => x.task.id === failed.id);
  t.truthy('the run\'s domain export still holds the task, with the failure on its earlier attempt', domain.status === 200 && !!entry?.earlierAttempts?.[0]?.whyItFailed, domain.status);
  // DEFECT: a run's export describes the task as it is now (queued, attempt 2), so the failure that happened in that run has no whyItFailed of its own
  t.truthy('and the task, as it ended in that run, says why it failed', !!entry?.whyItFailed, entry);
  // DEFECT: for the same reason the run's counts say nothing failed in it
  t.check('the run\'s counts say one task failed in it', doc.counts?.failed, 1);
  t.check('an export kind that does not exist is refused', (await h.raw('GET', '/export/zzz?session=x')).status, 400);

  // The live events: what the page reads when it opens mid-run, and the stream itself.
  const events = await h.call<Array<{ type: string }>>('GET', `/sessions/${s!.id}/events`);
  t.check('the events hold the task\'s ending and the notice about uploads', [events.some((e) => e.type === 'task-finished'), events.some((e) => e.type === 'upload-notice')], [true, true]);
  const [c] = await h.importPlan(planOf(onBranch(h, 'will-stop', [fileTask('stop-task', 'st.txt', 'st')])));
  h.chat.script(reply.prose('Sure! I will get right on that.'));
  const stopped = (await h.run(c!.id)).tasks[0]!;
  t.check('a reply out of format with no retries left stops at a limit', stopped.status, 'limit-reached');
  await h.call('POST', `/sessions/${c!.id}/tasks/${stopped.id}/continue`);
  const afterContinue = await h.call<Array<{ type: string }>>('GET', `/sessions/${c!.id}/events`);
  t.truthy('after "Continue" the events say it was queued again', afterContinue.some((e) => e.type === 'task-requeued'), afterContinue.map((e) => e.type).slice(-5));

  // EventSource cannot send a header, so the stream takes the token in the query. What arrives first is
  // the history, as SSE: the first event's data line is a session event in JSON. (Nest writes a blank
  // line and an `id:` line before each `data:` line, so the first bytes are not "data: {"; EventSource
  // reads them the same way, and so does this check.)
  //
  // The deadline aborts the request itself: a stream that sends its headers and then nothing (the
  // regression this guards) would otherwise leave a read waiting for ever and hang the whole file.
  // And a data line counts only once its line break has arrived, so an event split across chunks is
  // read whole rather than parsed half-way.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  let status = 0;
  let received = '';
  let streamProblem = '';
  const decoder = new TextDecoder();
  try {
    const stream = await fetch(`${origin}/sessions/${s!.id}/stream?token=${h.api.token}`, { signal: abort.signal });
    status = stream.status;
    const reader = stream.body!.getReader();
    try {
      while (!/^data: .*\r?\n/m.test(received)) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch (e) {
    streamProblem = abort.signal.aborted ? 'no complete data line within 10 s' : (e as Error).message;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  const firstData = /^data: (.*?)\r?\n/m.exec(received)?.[1] ?? '';
  let firstEvent: { type?: string } | null = null;
  try {
    firstEvent = JSON.parse(firstData) as { type?: string };
  } catch {
    firstEvent = null;
  }
  t.truthy('the stream answers the token in the query, and its first event is a JSON session event', status === 200 && firstData.startsWith('{') && typeof firstEvent?.type === 'string',
    { status, streamProblem, received: received.slice(0, 200) });
});

console.log(`\nran in ${Math.round((Date.now() - started) / 1000)} s`);
t.finish();
