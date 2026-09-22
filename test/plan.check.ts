/**
 * Plans: reading a document a chat model wrote, and turning it into sessions and tasks.
 *
 * The questions here are the ones the feature was asked for. Does the example the brief hands
 * to the model actually validate — in both the version-control and the no-version-control
 * variant? Does a paste with prose and a code fence around it still work? Does a broken
 * document come back with something a person can hand back to the chat? Does a plan's branch
 * name and commit message survive all the way to the text git will be given? And does an
 * import produce a queue that is ready to run and nothing that is running?
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkPlan, describeIssues, extractJson } from '../src/plan/schema.js';
import { planExample, planBrief } from '../src/plan/brief.js';
import { importPlan, plannedSessionSignature, taskSignature } from '../src/plan/importPlan.js';
import { SessionStore } from '../src/session/store.js';
import { plannedBranchName } from '../src/vcs/git.js';
import { commitMessage } from '../src/vcs/taskVcs.js';
import type { Task } from '../src/session/model.js';

const data = await mkdtemp(join(tmpdir(), 'cop-plan-'));
const store = new SessionStore(data, join(process.cwd(), 'prompts', 'level1.md'));
await store.init();

console.log('--- the example in the brief is a valid plan ---');
const withGit = checkPlan(JSON.stringify(planExample()));
console.log('valid             :', withGit.ok, '| warnings:', withGit.ok ? withGit.warnings.length : '-', '(expect true, 0)');
if (!withGit.ok) console.log(describeIssues(withGit.issues));
console.log('summary           :', withGit.ok ? `${withGit.summary.sessions.length} sessions, ${withGit.summary.taskCount} tasks` : '-');
console.log(
  'teaches both      :',
  withGit.ok && withGit.plan.sessions[0].vcs.enabled === true && withGit.plan.sessions[1].vcs.enabled === false,
  '(expect true — one session commits, one does not, and both say so)',
);

console.log('\n--- the brief makes the model ask about git rather than assuming ---');
for (const lang of ['en', 'bg'] as const) {
  const brief = planBrief({ lang });
  console.log(
    `${lang} brief          :`,
    `${brief.length} chars |`,
    'names the git fields:', brief.includes('vcs.commitMessage') && brief.includes('branchMode'),
    '| shows a branch:', brief.includes('"branch"'),
    '| shows a session with it off:', brief.includes('"enabled": false'),
  );
  console.log(
    `${lang} asks           :`,
    'about version control:', /ask|Питай|питаш/.test(brief) && /no default|по подразбиране/.test(brief),
    '| about the repository:', brief.includes('repoDir'),
    '| says a plan without it is refused:', brief.includes('refus') || brief.includes('отказва'),
  );
}

/*
 * The machine's projects go into the brief by path.
 *
 * A plan across a front end, a back end and a test suite used to be written with three paths
 * the chat model asked for and the operator typed from memory. With the folders listed, the
 * model is told to use them as written and still to ask which of them the work is about.
 */
/*
 * The persona has three jobs, and the operator's part of it is two texts.
 *
 * Planning the JSON was the whole brief; a task that failed then left the operator alone with
 * the register. The software part now also says how to read the three exports and the failure
 * words, and how to check the finished run against the ticket. The operator's part is split:
 * the organisation with its projects, written once and read for months, and this work, replaced
 * whenever the work is. While either is empty the brief interviews first and asks for both back
 * as JSON, naming the field each goes in.
 */
console.log('\n--- the persona plans, runs and validates, and carries the operator two texts ---');
for (const lang of ['en', 'bg'] as const) {
  const withOrg = planBrief({ lang, organisation: 'Tickets come from JIRA-PAY. Search the Payments wiki first.', work: 'PBI-77: add the export button.' });
  const bare = planBrief({ lang });
  console.log(
    `${lang}`,
    '| reads exports:', /whyItFailed/.test(withOrg) ? 'yes' : 'NO',
    '| failure words:', /limit-reached/.test(withOrg) && /blocked/.test(withOrg) ? 'yes' : 'NO',
    '| validates against the ticket:', /(claimed only|само твърдение)/.test(withOrg) ? 'yes' : 'NO',
    '| takes a ticket:', /(acceptance\s+criteria|критериите\s+за\s+приемане)/.test(withOrg) ? 'yes' : 'NO',
    '| always says what is next:', /(End every message by saying what happens next|Завършвай всяко съобщение с това какво следва)/.test(withOrg) ? 'yes' : 'NO',
  );
  console.log(
    `${lang} two texts`,
    '| organisation in:', withOrg.includes('JIRA-PAY') && /(## The organisation and the projects|## Организацията и проектите)/.test(withOrg) ? 'yes' : 'NO',
    '| work in:', withOrg.includes('PBI-77') && /(## This work|## Тази работа)/.test(withOrg) ? 'yes' : 'NO',
    '| organisation first:', withOrg.indexOf('JIRA-PAY') < withOrg.indexOf(lang === 'en' ? '## Your job, in order' : '## Какво трябва да направиш') ? 'yes' : 'NO',
    '| neither when not given:', !bare.includes('JIRA-PAY') && !bare.includes('PBI-77') ? 'yes' : 'NO',
  );
  const asking = planBrief({ lang, organisationExample: '{ "organisation": "EXAMPLE-ONLY" }', workExample: '{ "work": "WORK-EXAMPLE-ONLY" }' });
  const notAsking = planBrief({ lang, organisation: 'Real text.', organisationExample: 'EXAMPLE-ONLY', workExample: 'WORK-EXAMPLE-ONLY' });
  console.log(
    `${lang} interview`,
    '| asks when empty:', /(before anything else|преди всичко останало)/.test(asking) ? 'yes' : 'NO',
    '| shows both examples:', asking.includes('EXAMPLE-ONLY') && asking.includes('WORK-EXAMPLE-ONLY') ? 'yes' : 'NO',
    '| asks for two JSON documents:', /(exactly two JSON documents|точно два JSON документа)/.test(asking) ? 'yes' : 'NO',
    '| says where each goes:', /(Plan from JSON|План от JSON)/.test(asking) && /(This work|Тази работа)/.test(asking) ? 'yes' : 'NO',
    '| names the conventions:', /(branch naming|именуване на клонове)/.test(asking) && /(pull request)/.test(asking) ? 'yes' : 'NO',
    '| silent once written:', !/(before anything else|преди всичко останало)/.test(notAsking) && !notAsking.includes('EXAMPLE-ONLY') ? 'yes' : 'NO',
    '| is Kerrigan:', /Kerrigan/.test(asking) ? 'yes' : 'NO',
  );
}

console.log('\n--- the brief lists the projects it was given, and only then ---');
const known = [
  { name: '', rootDir: 'C:\\Projects\\rules-tests', repo: true, isDefault: true },
  { name: 'api', rootDir: 'C:\\Projects\\rules-api', repo: true, isDefault: false },
  { name: 'scratch', rootDir: 'C:\\Projects\\scratch', repo: false, isDefault: false },
];
for (const lang of ['en', 'bg'] as const) {
  const listed = planBrief({ lang, projects: known });
  const bare = planBrief({ lang });
  console.log(
    `${lang} lists them     :`,
    listed.includes('C:\\Projects\\rules-tests') && listed.includes('**api**') && listed.includes('C:\\Projects\\scratch') ? 'yes' : 'NO',
    '| default marked:', /Default project|по подразбиране \(новите/.test(listed) ? 'yes' : 'NO',
    '| says which is a repo:', /scratch`[^\n]*(not a git|не е git)/.test(listed) ? 'yes' : 'NO',
    '| bare brief has no such section:', !bare.includes('rules-tests') && !/Projects on this machine|Проектите на тази машина/.test(bare) ? 'yes' : 'NO',
  );
}

/*
 * The "not part of the format" warning must agree with the schema.
 *
 * The known-key list was written by hand and missed `readOnly`, so every plan that used the
 * flag was told it had been ignored while the importer applied it. The keys now come from the
 * schemas themselves; this keeps them honest: a real field draws no warning, an invented one does.
 */
console.log('\n--- an invented field is warned about; a real one is not ---');
const flagged = JSON.parse(JSON.stringify(planExample())) as { sessions: Array<{ tasks: Array<Record<string, unknown>> }> };
flagged.sessions[0]!.tasks[0]!.readOnly = true;
flagged.sessions[0]!.tasks[0]!.owner = 'somebody';
const flaggedCheck = checkPlan(JSON.stringify(flagged));
const flaggedWarnings = flaggedCheck.ok ? flaggedCheck.warnings : [];
console.log('valid             :', flaggedCheck.ok);
console.log('readOnly accepted :', flaggedCheck.ok && flaggedCheck.plan.sessions[0]!.tasks[0]!.readOnly === true ? 'yes' : 'NO');
console.log('warnings          :', flaggedWarnings.length, '(expect 1) —', flaggedWarnings.join(' | '));
console.log('about owner only  :', flaggedWarnings.length === 1 && flaggedWarnings[0]!.includes('owner') && !flaggedWarnings.some((w) => w.includes('readOnly')) ? 'yes' : 'NO');

/*
 * A check against the git index for a file the task writes cannot pass before the commit.
 *
 * The rules-engine plan asked `git ls-files` to list the seed the task had just created; the
 * task ended blocked with the file on disk and the work complete. The validator now says so at
 * import; the negative form for node_modules stays silent.
 */
console.log('\n--- a check that asks the index about a new file is warned about ---');
const indexed = JSON.parse(JSON.stringify(planExample())) as { sessions: Array<{ tasks: Array<{ checks?: unknown[] }> }> };
indexed.sessions[0]!.tasks[0]!.checks = [
  { name: 'the seed is tracked', expect: 'output-contains', run: 'git --no-pager -C C:\\x ls-files data', value: 'data/seed.json' },
  { name: 'dependencies are not tracked', expect: 'output-omits', run: 'git --no-pager -C C:\\x ls-files', value: 'node_modules' },
  { name: 'the seed exists', expect: 'file-exists', file: 'C:\\x\\data\\seed.json' },
];
const indexedCheck = checkPlan(JSON.stringify(indexed));
const indexWarnings = indexedCheck.ok ? indexedCheck.warnings.filter((w) => w.includes('ls-files')) : [];
console.log('valid             :', indexedCheck.ok);
console.log('warned once       :', indexWarnings.length === 1 && indexWarnings[0]!.includes('the seed is tracked') ? 'yes' : `NO (${indexWarnings.length})`);
console.log('names the fix     :', indexWarnings[0]?.includes('file-exists') ? 'yes' : 'NO');

console.log('\n--- what a chat actually pastes: prose, a fence, then more prose ---');
const wrapped = `Sure! Here is the plan you asked for:

\`\`\`json
${JSON.stringify(planExample(), null, 2)}
\`\`\`

Let me know if you want me to split the second session further.`;
console.log('extracted starts  :', extractJson(wrapped).slice(0, 14).replace(/\s+/g, ' '));
console.log('valid             :', checkPlan(wrapped).ok, '(expect true)');

console.log('\n--- documents that should be refused, and what the user is told ---');
const broken: Array<[string, string]> = [
  ['not json at all', 'I would suggest three tasks: first, ...'],
  ['wrong version', JSON.stringify({ version: 2, sessions: [] })],
  ['no sessions', JSON.stringify({ version: 1, sessions: [] })],
  [
    'session with no tasks',
    JSON.stringify({ version: 1, sessions: [{ name: 'a-session', onFailure: 'stop', vcs: { enabled: false }, tasks: [] }] }),
  ],
  [
    'a task that says nothing',
    JSON.stringify({
      version: 1,
      sessions: [{ name: 'a-session', onFailure: 'stop', vcs: { enabled: false }, tasks: [{ title: 'do it', prompt: 'fix the bug' }] }],
    }),
  ],
  [
    'onFailure invented',
    JSON.stringify({
      version: 1,
      sessions: [
        {
          name: 'a-session',
          onFailure: 'maybe',
          vcs: { enabled: false },
          tasks: [{ title: 'a real title', prompt: 'A prompt that is definitely long enough to be a real instruction.' }],
        },
      ],
    }),
  ],
  [
    'branchMode invented',
    JSON.stringify({
      version: 1,
      sessions: [
        {
          name: 'a-session',
          onFailure: 'stop',
          vcs: { enabled: true, repoDir: 'C:\\Projects\\billing', branchMode: 'per-feature' },
          tasks: [{ title: 'a real title', prompt: 'A prompt that is definitely long enough to be a real instruction.' }],
        },
      ],
    }),
  ],
  [
    'never asked about git',
    JSON.stringify({
      version: 1,
      sessions: [
        {
          name: 'a-session',
          onFailure: 'stop',
          tasks: [{ title: 'a real title', prompt: 'A prompt that is definitely long enough to be a real instruction.' }],
        },
      ],
    }),
  ],
  [
    'git on, no repository',
    JSON.stringify({
      version: 1,
      sessions: [
        {
          name: 'a-session',
          onFailure: 'stop',
          vcs: { enabled: true, repoDir: '   ' },
          tasks: [{ title: 'a real title', prompt: 'A prompt that is definitely long enough to be a real instruction.' }],
        },
      ],
    }),
  ],
  [
    'git neither on nor off',
    JSON.stringify({
      version: 1,
      sessions: [
        {
          name: 'a-session',
          onFailure: 'stop',
          vcs: { repoDir: 'C:\\Projects\\billing' },
          tasks: [{ title: 'a real title', prompt: 'A prompt that is definitely long enough to be a real instruction.' }],
        },
      ],
    }),
  ],
];
for (const [label, text] of broken) {
  const result = checkPlan(text);
  const first = result.ok ? '(accepted!)' : describeIssues(result.issues).split('\n')[0];
  console.log(`${label.padEnd(24)}:`, first.slice(0, 130));
}

console.log('\n--- fields a model invented are warnings, not refusals ---');
const invented = checkPlan(
  JSON.stringify({
    version: 1,
    plan: 'p',
    priority: 'high',
    sessions: [
      {
        name: 'a-session',
        onFailure: 'stop',
        estimate: '2h',
        vcs: { enabled: false },
        tasks: [
          {
            title: 'a real title',
            prompt: 'A prompt that is definitely long enough to be a real instruction.',
            owner: 'ivan',
            vcs: { branch: 'fine', tag: 'v1' },
          },
        ],
      },
    ],
  }),
);
console.log('valid             :', invented.ok, '(expect true)');
console.log('warnings          :\n  ' + (invented.ok ? invented.warnings.join('\n  ') : '-'));

console.log('\n--- two sessions with one name ---');
const twins = checkPlan(
  JSON.stringify({
    version: 1,
    sessions: ['a-session', 'A-Session'].map((name) => ({
      name,
      onFailure: 'stop',
      vcs: { enabled: false },
      tasks: [{ title: 'a real title', prompt: 'A prompt that is definitely long enough to be a real instruction.' }],
    })),
  }),
);
console.log('valid             :', twins.ok, '| warning:', twins.ok ? twins.warnings[0] : '-');

console.log('\n--- importing the example ---');
if (!withGit.ok) throw new Error('the example must validate before it can be imported');
const imported = await importPlan(store, withGit.plan, 'Default Model');
console.log('sessions created  :', imported.sessions.map((s) => `${s.name} (${s.tasks})`).join(', '));
console.log('tasks in total    :', imported.taskCount, '(expect 4)');
console.log('warnings          :', imported.warnings.length, '(expect 0)');

const [first, second] = await Promise.all(imported.sessions.map((s) => store.getSession(s.id)));
console.log('\n--- what the first session looks like on disk ---');
console.log('name              :', first?.name);
console.log('every task queued :', first?.tasks.every((t) => t.status === 'queued'), '(expect true — an import starts nothing)');
console.log('order kept        :', first?.tasks.map((t) => t.title).join(' -> '));
console.log('onFailure         :', first?.onFailure, '(expect stop)');
console.log('model             :', first?.model, '(expect Default Model — the plan named none)');
console.log('vcs repo          :', first?.vcs?.repoDir, '| mode:', first?.vcs?.branchMode, '| commits:', first?.vcs?.commitOnFinish);
console.log('mirror root       :', first?.mirror.rootDir, '| dirs:', first?.mirror.includeDirs.join(','), '| env files:', first?.mirror.includeEnvFiles);

const task1 = first?.tasks[0];
console.log('\n--- one task, as Copilot will receive it ---');
console.log('prompt keeps ask  :', task1?.prompt.includes('add a CSV writer'));
console.log('bar is appended   :', task1?.prompt.includes('### Expected result'), '|', task1?.prompt.includes('npx tsc --noEmit'));
console.log('level2 has goal   :', task1?.level2.startsWith('## Goal of this session'));
console.log('level2 has project:', task1?.level2.includes('Run tests with'));

console.log('\n--- the names the plan chose reach git ---');
console.log('branch asked for  :', task1?.vcsPlan?.branch, '| commit asked for:', task1?.vcsPlan?.commitMessage);
console.log('branch git gets   :', plannedBranchName(task1?.vcsPlan?.branch ?? '', 'cop/'));
console.log('prefix not doubled:', plannedBranchName('cop/invoice-csv-writer', 'cop/'), '(expect cop/invoice-csv-writer)');
console.log('a re-run differs  :', plannedBranchName('invoice-csv-writer', 'cop/', 2));
console.log('slashes flattened :', plannedBranchName('feature/CSV Writer!', 'cop/'));
const message = commitMessage(first?.tasks[1] as Task, { status: 'done', summary: 'Added the endpoint and the flag.' });
console.log('commit subject    :', message.split('\n')[0]);
console.log('planned body kept :', message.includes('stays off by default'));

/*
 * A read-only task is a flag, not a sentence.
 *
 * A smoke-test task told in prose to change nothing renamed the page's labels when a reviewer
 * asked. The flag travels from the plan to the stored task, where the runner enforces it from
 * the working tree.
 */
console.log('\n--- a read-only task: a flag the runner enforces ---');
const roPlan = JSON.parse(JSON.stringify(planExample())) as { sessions: Array<{ name: string; tasks: Array<Record<string, unknown>> }> };
roPlan.sessions[0].name = 'read-only probe';
roPlan.sessions[0].tasks[0].readOnly = true;
const ro = checkPlan(JSON.stringify(roPlan));
console.log('valid             :', ro.ok, '(expect true)');
const roImported = ro.ok ? await importPlan(store, ro.plan, 'Default Model') : null;
const roSession = roImported ? await store.getSession(roImported.sessions[0].id) : null;
console.log('flag reaches task :', roSession?.tasks[0]?.readOnly, '| the next task:', roSession?.tasks[1]?.readOnly, '(expect true | undefined)');
console.log('default is off    :', first?.tasks[0]?.readOnly, '(expect undefined)');
const roBad = checkPlan(JSON.stringify({ ...roPlan, sessions: [{ ...roPlan.sessions[0], tasks: [{ ...roPlan.sessions[0].tasks[0], readOnly: 'yes' }] }] }));
console.log('not a boolean     :', roBad.ok ? 'ACCEPTED' : 'refused', '(expect refused)');
console.log('summary underneath:', message.includes('Added the endpoint and the flag.'));
console.log('trailer           :', message.trim().split('\n').slice(-1)[0]);
const derived = commitMessage({ title: 'a task with no plan', attempt: 1 } as Task, { status: 'done', summary: 's' });
console.log('no plan, no change:', derived.split('\n')[0], '(expect the title)');

console.log('\n--- the second session is the independent one ---');
console.log('onFailure         :', second?.onFailure, '(expect continue)');
console.log('vcs               :', second?.vcs?.enabled ? 'on' : 'off', '(expect off)');
console.log('mirror            :', second?.mirror.enabled ? 'on' : 'off', '(expect off — the plan named none)');
console.log('no git names kept :', second?.tasks.every((t) => t.vcsPlan === undefined), '(expect true)');

console.log('\n--- the plan says what a failed session means for the rest ---');
console.log('example            :', withGit.ok ? withGit.summary.onFailure : '-', '(expect continue — its two sessions are unrelated)');
const noTop = checkPlan(
  JSON.stringify({
    version: 1,
    sessions: [
      {
        name: 'a-session',
        onFailure: 'continue',
        vcs: { enabled: false },
        tasks: [{ title: 'a real title', prompt: 'A prompt that is definitely long enough to be a real instruction.' }],
      },
    ],
  }),
);
console.log('left out           :', noTop.ok ? noTop.summary.onFailure : '-', '(expect stop — the safe default)');
console.log('not the same field :', noTop.ok ? noTop.plan.sessions[0].onFailure : '-', '(the session said continue; the plan said nothing)');
const badTop = checkPlan(JSON.stringify({ version: 1, onFailure: 'sometimes', sessions: [] }));
console.log('refusal            :', badTop.ok ? '-' : describeIssues(badTop.issues).split('\n')[0].slice(0, 120));

console.log('\n--- importing the same plan twice is spotted, not prevented ---');
const stored = await store.listSessions();
const plannedAgain = withGit.ok ? withGit.plan.sessions[0] : null;
if (plannedAgain) {
  const wanted = plannedSessionSignature(plannedAgain);
  const match = stored.find(
    (x) =>
      x.name.trim().toLowerCase() === plannedAgain.name.trim().toLowerCase() &&
      x.tasks.length === plannedAgain.tasks.length &&
      x.tasks.map((t) => taskSignature(t)).join('\u0001') === wanted,
  );
  console.log('found the original :', match?.name, `(${match?.tasks.length} tasks)`);
  const edited = {
    ...plannedAgain,
    tasks: [{ ...plannedAgain.tasks[0], prompt: `${plannedAgain.tasks[0].prompt} And one more sentence.` }, plannedAgain.tasks[1]],
  };
  console.log('an edited plan     :', plannedSessionSignature(edited) !== wanted ? 'is not a duplicate' : 'looks the same (wrong)');
  const renamedBranch = {
    ...plannedAgain,
    tasks: plannedAgain.tasks.map((t) => ({ ...t, vcs: { branch: 'something-else', commitMessage: 'Different subject' } })),
  };
  console.log(
    'only git names off :',
    plannedSessionSignature(renamedBranch) === wanted ? 'still a duplicate (right)' : 'counted as new (wrong)',
  );
}

console.log('\n--- a per-session plan names the one branch ---');
const chained = checkPlan(
  JSON.stringify({
    version: 1,
    sessions: [
      {
        name: 'chained',
        onFailure: 'stop',
        vcs: { enabled: true, repoDir: 'C:\\Projects\\billing', branchMode: 'per-session', branchName: 'invoice-export' },
        tasks: [{ title: 'a real title', prompt: 'A prompt that is definitely long enough to be a real instruction.' }],
      },
    ],
  }),
);
if (chained.ok) {
  const result = await importPlan(store, chained.plan);
  const session = await store.getSession(result.sessions[0].id);
  console.log('branch mode       :', session?.vcs?.branchMode, '| branch name:', session?.vcs?.branchName);
  console.log('prefix kept       :', session?.vcs?.branchPrefix);
}

console.log('\n--- a session that asks for files without a root ---');
const noRoot = checkPlan(
  JSON.stringify({
    version: 1,
    sessions: [
      {
        name: 'no-root',
        onFailure: 'stop',
        mirror: { enabled: true },
        vcs: { enabled: false, repoDir: '' },
        tasks: [{ title: 'a real title', prompt: 'A prompt that is definitely long enough to be a real instruction.' }],
      },
    ],
  }),
);
if (noRoot.ok) {
  const result = await importPlan(store, noRoot.plan);
  console.log('imported anyway   :', result.sessions.length === 1);
  console.log('warnings          :\n  ' + result.warnings.join('\n  '));
  const session = await store.getSession(result.sessions[0].id);
  console.log('files left off    :', session?.mirror.enabled === false, '(expect true)');
}

console.log('\n--- sessions in the store ---');
console.log('total             :', (await store.listSessions()).length, '(expect 4)');
console.log('none running      :', (await store.listSessions()).every((s) => s.status === 'idle'));

await rm(data, { recursive: true, force: true });
