/**
 * The brief: what the user hands to a chat model so it can write a plan for this system.
 *
 * This text is the whole interface to a model nobody here controls. It has to do three things
 * at once — say what the runner actually is, make the model interview the user instead of
 * guessing, and pin the output format exactly — and it has to do them in a single paste,
 * because the user is copying it into some other chat window with no tooling on our side.
 *
 * Version control used to be a switch on the import page, and the brief was rebuilt around
 * whatever it was set to. It is not any more, and that is the point of this text: the operator
 * should not have to answer, on a form, a question about work that has not been described yet.
 * The model asks instead — it is the one holding the conversation — and its answer travels in
 * the JSON, per session, where a plan can sensibly say that one session commits and another
 * only reads. So this brief describes both, and says plainly that skipping the question gets
 * the document refused.
 *
 * The example below is parsed by the plan tests, so a field renamed in `schema.ts` without
 * being renamed here fails the check rather than quietly teaching every future plan the wrong
 * shape.
 */
import { PLAN_VERSION } from './schema.js';

export type BriefOptions = {
  lang?: string;
};

/**
 * A filled-in plan, used as the example in every language.
 *
 * Deliberately not minimal: it shows two sessions, a dependent and an independent one, one
 * that does version control and one that does not, because a model shown only the required
 * fields writes plans that use only the required fields. The second session is the whole
 * lesson about `vcs`: it is written out with `enabled: false` rather than left off, because
 * leaving it off is what this format refuses.
 */
export function planExample(): Record<string, unknown> {
  const root = 'C:\\Projects\\billing';

  const firstTasks: Array<Record<string, unknown>> = [
    {
      title: 'csv-writer',
      prompt:
        `In ${root}, add a CSV writer for invoices at src/invoices/csv.ts. It takes the existing Invoice[] ` +
        'type and returns a string with a header row and one row per invoice, with the columns number, date, ' +
        'customer, net, vat, gross. Amounts use a dot as the decimal separator and no thousands separator. Do not ' +
        'wire it into anything yet.',
      expected:
        '`npx tsc --noEmit` passes and a new unit test that writes two invoices produces exactly the six columns ' +
        'above, in that order.',
      level2: '',
      checks: [
        { name: 'typescript compiles', expect: 'exit-zero', run: 'npx tsc --noEmit', cwd: root },
        { name: 'the writer exists', expect: 'file-exists', file: `${root}\\src\\invoices\\csv.ts` },
        { name: 'the unit tests pass', expect: 'exit-zero', run: 'npm test', cwd: root },
      ],
      vcs: { branch: 'invoice-csv-writer', commitMessage: 'Add a CSV writer for invoices' },
    },
    {
      title: 'export-endpoint',
      prompt:
        'Expose the CSV writer from task 1 as GET /invoices/export in the existing Express router at ' +
        'src/invoices/router.ts. It must be behind the feature flag INVOICE_CSV_EXPORT, off by default, and ' +
        'respond with content-type text/csv and a content-disposition filename of invoices.csv.',
      expected:
        'With the flag off the endpoint returns 404; with it on it returns 200, text/csv and the header row. ' +
        '`npm test` passes.',
      level2: '',
      vcs: {
        branch: 'invoice-csv-endpoint',
        commitMessage: 'Expose the invoice CSV export endpoint\n\nBehind INVOICE_CSV_EXPORT, which stays off by default.',
      },
    },
  ];

  const secondTasks: Array<Record<string, unknown>> = [
    {
      title: 'outdated-deps',
      prompt:
        `In ${root}, run \`npm outdated\` and report the result. Change nothing. Quote the full table in ` +
        'the summary and say which of the outdated packages are a major version behind.',
      expected: 'The summary contains the table verbatim and a list of the major-version-behind packages.',
      level2: '',
      checks: [{ name: 'nothing in the repository changed', expect: 'output-omits', run: 'git --no-pager status --porcelain', cwd: root, value: 'M ' }],
    },
    {
      review: false,
      title: 'test-duration',
      prompt:
        `In ${root}, run \`npm test\` once and report how long it took and how many tests ran. Change ` +
        'nothing. If the suite fails, report the failures rather than fixing them.',
      expected: 'The summary states the duration, the number of tests, and the pass or fail result.',
      level2: '',
    },
  ];

  return {
    version: PLAN_VERSION,
    plan: 'Invoice export, first pass',
    notes:
      'The user confirmed the service already has a working test suite. Session 2 is deliberately independent: ' +
      'the two checks in it say nothing about each other.',
    onFailure: 'continue',
    conversation: 'per-session',
    sessions: [
      {
        name: 'invoice-export',
        goal: 'Add CSV export to the invoice service, behind the existing feature-flag mechanism.',
        model: '',
        onFailure: 'stop',
        level2:
          `TypeScript, Node 20, npm. The project is at ${root}. Run tests with \`npm test\`. Follow the ` +
          'existing folder layout; do not add dependencies without saying why in the summary.',
        vcs: {
          enabled: true,
          repoDir: root,
          branchMode: 'per-task',
          commitOnFinish: true,
          branchPrefix: 'cop/',
        },
        review: { enabled: true, model: '' },
        mirror: {
          enabled: true,
          rootDir: root,
          includeDirs: ['src/invoices'],
          excludeDirs: [],
          respectGitignore: true,
          includeEnvFiles: false,
        },
        tasks: firstTasks,
      },
      {
        name: 'billing-health',
        goal: 'Two independent checks on the billing service, run for the record.',
        model: '',
        onFailure: 'continue',
        level2: `Read-only work. Do not change any file in ${root}.`,
        vcs: { enabled: false, repoDir: '', branchMode: 'per-task', commitOnFinish: false, branchPrefix: 'cop/' },
        tasks: secondTasks,
      },
    ],
  };
}

const FIELD_ROWS_EN = [
  ['version', 'top', 'yes', `Always ${PLAN_VERSION}.`],
  ['plan', 'top', 'no', 'A short name for the whole plan.'],
  ['notes', 'top', 'no', 'Assumptions you made, open questions, why the order is what it is. The operator reads this.'],
  [
    'onFailure',
    'top',
    'yes',
    'What a run of these sessions does when a whole **session** fails. "stop" = the plan is one piece of work in order. "continue" = the sessions are independent of each other.',
  ],
  [
    'conversation',
    'top',
    'yes',
    '"per-session" = each session gets its own Copilot chat, which is the usual answer. "shared" = all of them talk in one chat and see each other\'s history.',
  ],
  ['sessions', 'top', 'yes', 'At least one. Each session is one Copilot conversation, unless the plan shares them.'],
  ['name', 'session', 'yes', 'Short, latin letters, digits and hyphens.'],
  ['goal', 'session', 'no', 'One or two sentences: what this whole session is for.'],
  ['model', 'session', 'no', 'The chat model by the exact name the picker shows. Leave "" unless the user named one.'],
  [
    'onFailure',
    'session',
    'yes',
    '"stop" = the tasks are one chain, a failure leaves the rest queued. "continue" = the tasks are independent.',
  ],
  [
    'level2',
    'session',
    'no',
    'Project and team instructions for every task in this session: language, tooling, conventions, how to run the tests, what not to touch.',
  ],
  [
    'conversationGroup',
    'session',
    'no',
    'Overrides the setting above for this one session: give the same name to the sessions that should share a chat, and leave it "" for a session that should have its own.',
  ],
  [
    'review',
    'session',
    'no',
    'Whether a second, independent conversation checks the work by running it. On when left out. `{ "enabled": true, "model": "" }`; a different model makes the review better.',
  ],
  ['review', 'task', 'no', 'Set to `false` to skip the review for one task. Absent means the session decides.'],
  ['readOnly', 'task', 'no', '`true` for a task that must not change files — an audit, a smoke test, a report. The runner fails it if the tree changed, and still commits the change on its branch so nothing is lost.'],
  ['mirror', 'session', 'no', 'Which project files are copied into the chat as context.'],
  ['tasks', 'session', 'yes', 'At least one, in the order they must run.'],
  ['title', 'task', 'yes', '3 to 120 characters. Short, latin, hyphenated.'],
  ['prompt', 'task', 'yes', 'The task itself, at least 30 characters. This is what Copilot reads.'],
  [
    'expected',
    'task',
    'no, but always write it',
    'What must be true once the task is done. This is the bar the operator holds the result to.',
  ],
  ['level2', 'task', 'no', "Instructions for this one task, replacing the session's. Leave \"\" to inherit."],
  [
    'checks',
    'task',
    'no, but write them wherever you can',
    'The same bar as `expected`, written so the runner can decide it. See below: if they fail, the task is sent back to you to fix.',
  ],
];

const FIELD_ROWS_BG = [
  ['version', 'горе', 'да', `Винаги ${PLAN_VERSION}.`],
  ['plan', 'горе', 'не', 'Кратко име на целия план.'],
  ['notes', 'горе', 'не', 'Допусканията, които си направил, отворените въпроси, защо редът е такъв. Операторът чете това.'],
  [
    'onFailure',
    'горе',
    'да',
    'Какво прави изпълнението на тези сесии, когато цяла **сесия** се провали. "stop" = планът е една работа, подредена по ред. "continue" = сесиите са независими една от друга.',
  ],
  [
    'conversation',
    'горе',
    'да',
    '"per-session" = всяка сесия получава собствен чат с Copilot, което е обичайният отговор. "shared" = всички говорят в един чат и виждат историята си една на друга.',
  ],
  ['sessions', 'горе', 'да', 'Поне една. Всяка сесия е един разговор с Copilot, освен ако планът не ги обедини.'],
  ['name', 'сесия', 'да', 'Кратко, латиница, цифри и тирета.'],
  ['goal', 'сесия', 'не', 'Едно-две изречения: за какво служи цялата сесия.'],
  ['model', 'сесия', 'не', 'Моделът на чата, с точното име от менюто. Остави "", освен ако потребителят не е посочил.'],
  [
    'onFailure',
    'сесия',
    'да',
    '"stop" = задачите са верига, при провал останалите остават в опашката. "continue" = задачите са независими.',
  ],
  [
    'level2',
    'сесия',
    'не',
    'Инструкции за проекта и екипа, валидни за всяка задача в сесията: език, инструменти, конвенции, как се пускат тестовете, какво да не се пипа.',
  ],
  [
    'conversationGroup',
    'сесия',
    'не',
    'Отменя настройката горе само за тази сесия: дай едно и също име на сесиите, които да споделят чат, и остави "" на онази, която да е сама.',
  ],
  [
    'review',
    'сесия',
    'не',
    'Дали втори, независим разговор проверява работата, като я изпълни. Включено, ако се пропусне. `{ "enabled": true, "model": "" }`; друг модел прави рецензията по-добра.',
  ],
  ['review', 'задача', 'не', 'Сложи `false`, за да се пропусне рецензията само за тази задача. Липсата значи каквото казва сесията.'],
  ['readOnly', 'задача', 'не', '`true` за задача, която не бива да променя файлове — одит, smoke тест, доклад. Runner-ът я проваля, ако дървото е променено, и пак комитва промяната на клона ѝ, за да не се губи нищо.'],
  ['mirror', 'сесия', 'не', 'Кои файлове от проекта се прикачат към чата като контекст.'],
  ['tasks', 'сесия', 'да', 'Поне една, в реда, в който трябва да се изпълнят.'],
  ['title', 'задача', 'да', 'От 3 до 120 знака. Кратко, латиница, с тирета.'],
  ['prompt', 'задача', 'да', 'Самата задача, поне 30 знака. Това чете Copilot.'],
  [
    'expected',
    'задача',
    'не, но винаги го пиши',
    'Какво трябва да е вярно, след като задачата приключи. Това е мярката, с която операторът мери резултата.',
  ],
  ['level2', 'задача', 'не', 'Инструкции само за тази задача, вместо тези на сесията. Остави "", за да наследи.'],
  [
    'checks',
    'задача',
    'не, но пиши ги, където можеш',
    'Същата мярка като `expected`, но написана така, че runner-ът да я реши сам. Виж по-долу: ако не минат, задачата се връща при теб за поправка.',
  ],
];

const VCS_ROWS_EN = [
  ['vcs', 'session', 'yes, always', 'Whether the runner does version control for this session, and where. See below. A session without it is refused.'],
  ['vcs.branch', 'task', 'yes in per-task mode', 'The branch this task works on, without the prefix.'],
  ['vcs.commitMessage', 'task', 'yes', 'The commit this task ends with. Imperative, first line under 72 characters.'],
];

const VCS_ROWS_BG = [
  ['vcs', 'сесия', 'да, винаги', 'Дали runner-ът прави контрол на версиите за тази сесия и къде. Виж по-долу. Сесия без него се отказва.'],
  ['vcs.branch', 'задача', 'да, в режим per-task', 'Клонът, по който работи задачата, без представката.'],
  ['vcs.commitMessage', 'задача', 'да', 'Комитът, с който задачата завършва. В повелително наклонение, първият ред под 72 знака.'],
];

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

const VCS_DETAIL_EN = `
**vcs on a session**: \`enabled\` (true here), \`repoDir\` (absolute path to the git repository),
\`branchMode\`, \`commitOnFinish\` (true unless the user says otherwise), \`branchPrefix\` (leave it
"cop/"), and \`branchName\` — used **only** in per-session mode, for the one branch the whole
session works on, without the prefix.

**branchMode** is a real choice and you should make it deliberately:

- \`"per-task"\` — every task branches from the same starting commit, so no task sees what the
  one before it changed. Use it for independent checks or alternatives. Give **each task** a
  \`vcs.branch\`. A task that reads, checks or documents what an earlier task wrote does
  **not** belong in a per-task session: it will not find the files.
- \`"per-session"\` — one branch for the whole queue, each task building on the last. Use it for
  work that is one change made in steps. Give **the session** a \`vcs.branchName\` and leave the
  tasks' \`vcs.branch\` out; it is ignored in this mode.

Either way, give every task a \`vcs.commitMessage\`. The runner commits after the task with that
message as the subject and Copilot's own summary underneath it, so write the subject the way a
commit is written: imperative, short, about the change rather than about the task.

**A session that should not touch git** still needs the field, written out in full:
\`"vcs": { "enabled": false, "repoDir": "", "branchMode": "per-task", "commitOnFinish": false, "branchPrefix": "cop/" }\`.
Then give its tasks no \`vcs\` at all — no branch, no commit message — because there is nothing
to name. Read-only work, audits and reports are the usual reason. Say in \`notes\` why you turned
it off, so the operator can disagree with you.

**Do not leave \`vcs\` out of a session.** The system refuses the whole document and hands the
user a line saying so, and you will have to ask the question then anyway — after wasting their
time. Ask it before you write any JSON.
`.trim();

const VCS_DETAIL_BG = `
**vcs на сесия**: \`enabled\` (тук true), \`repoDir\` (абсолютен път до git хранилището),
\`branchMode\`, \`commitOnFinish\` (true, освен ако потребителят не каже друго), \`branchPrefix\`
(остави "cop/") и \`branchName\` — използва се **само** в режим per-session, за единствения клон,
по който работи цялата сесия, без представката.

**branchMode** е истински избор и трябва да го направиш съзнателно:

- \`"per-task"\` — всяка задача тръгва от един и същ начален комит и не вижда какво е променила
  предишната. За независими проверки или алтернативи. Дай на **всяка задача** \`vcs.branch\`.
  Задача, която чете, проверява или документира написаното от по-ранна задача, **не** е за
  per-task сесия: няма да намери файловете.
- \`"per-session"\` — един клон за цялата опашка, всяка задача стъпва върху предишната. За работа,
  която е една промяна, направена на стъпки. Дай на **сесията** \`vcs.branchName\` и не пиши
  \`vcs.branch\` по задачите; в този режим се игнорира.

И в двата случая давай на всяка задача \`vcs.commitMessage\`. Runner-ът комитва след задачата с
този текст като заглавен ред, а отдолу слага резюмето на Copilot — затова пиши заглавния ред
както се пише комит: повелително, кратко, за промяната, не за задачата.

**Сесия, която не бива да пипа git**, пак иска полето, изписано изцяло:
\`"vcs": { "enabled": false, "repoDir": "", "branchMode": "per-task", "commitOnFinish": false, "branchPrefix": "cop/" }\`.
На нейните задачи не давай \`vcs\` изобщо — нито клон, нито текст на комит — защото няма какво да
се именува. Обичайната причина е работа само за четене, одит или отчет. Напиши в \`notes\` защо си
го изключил, за да може операторът да не се съгласи с теб.

**Не пропускай \`vcs\` в сесия.** Системата отказва целия документ и връща на потребителя ред,
който го казва, а ти пак ще трябва да зададеш въпроса — след като си му загубил времето. Задай
го, преди да си написал какъвто и да е JSON.
`.trim();

const CHECKS_EN = `
**checks** is what makes \`expected\` enforceable. \`expected\` is a sentence a person reads;
a check is the same claim written so this runner can settle it on its own, with no model
involved. When a task has checks, Copilot saying "done" is not the end of it: the runner runs
them, and if any fails the failure goes back into the chat with its output attached and the
task carries on until they pass or it runs out of attempts.

Each check is \`{ "name": "...", "expect": "...", ... }\`, where \`expect\` is one of:

| expect | Needs | Passes when |
|---|---|---|
| exit-zero | run | the command exits 0 |
| exit-nonzero | run | the command exits non-zero — for proving something is refused |
| output-contains | run, value | the command's output contains value |
| output-omits | run, value | it does not contain value |
| output-matches | run, value | it matches value as a regular expression |
| file-exists | file | the file is there |
| file-missing | file | it is not |
| file-contains | file, value | the file contains value |

\`run\` may also take \`cwd\` and \`shell\` ("pwsh" by default). Write checks that are cheap and
certain: a compile, a test run, a file that must exist, a string that must appear. Do not try
to check things that need judgement — "the code is clean", "the summary is good" — because
nothing here can decide them, and a check that cannot fail is worse than no check.
`.trim();

const CHECKS_BG = `
**checks** е това, което прави \`expected\` проверимо. \`expected\` е изречение, което човек чете;
проверката е същото твърдение, написано така, че runner-ът да го реши сам, без никакъв модел.
Когато задачата има проверки, „done“ от Copilot не я приключва: runner-ът ги изпълнява и ако
някоя не мине, провалът се връща в чата с изхода си прикачен, а задачата продължава, докато не
минат или не ѝ свършат опитите.

Всяка проверка е \`{ "name": "...", "expect": "...", ... }\`, където \`expect\` е едно от:

| expect | Иска | Минава, когато |
|---|---|---|
| exit-zero | run | командата излиза с 0 |
| exit-nonzero | run | командата излиза с различно от 0 — за да се докаже, че нещо се отказва |
| output-contains | run, value | изходът на командата съдържа value |
| output-omits | run, value | не го съдържа |
| output-matches | run, value | съвпада с value като регулярен израз |
| file-exists | file | файлът го има |
| file-missing | file | няма го |
| file-contains | file, value | файлът съдържа value |

При \`run\` може да зададеш и \`cwd\`, и \`shell\` ("pwsh" по подразбиране). Пиши проверки, които са
евтини и сигурни: компилация, пускане на тестове, файл, който трябва да съществува, низ, който
трябва да се появи. Не се опитвай да проверяваш неща, които искат преценка — „кодът е чист“,
„резюмето е добро“ — защото нищо тук не може да ги реши, а проверка, която не може да падне, е
по-лоша от никаква проверка.
`.trim();

const MIRROR_EN = `
**mirror**: \`enabled\`, \`rootDir\` (absolute), \`includeDirs\` and \`excludeDirs\` (paths relative to
the root, forward slashes), \`respectGitignore\` (leave it true), \`includeEnvFiles\` (leave it false
unless the user insists — it copies secrets into a chat).
`.trim();

const MIRROR_BG = `
**mirror**: \`enabled\`, \`rootDir\` (абсолютен), \`includeDirs\` и \`excludeDirs\` (пътища спрямо корена,
с наклонени черти напред), \`respectGitignore\` (остави го true), \`includeEnvFiles\` (остави го false,
освен ако потребителят не настоява — копира тайни в чат).
`.trim();

const VCS_RULE_EN =
  '- **Version control is yours to ask about, and there is no default.** With it on, the runner makes a branch\n' +
  '  before each task and a commit after it, using the names you give, and it never pushes; Copilot must not touch\n' +
  '  git itself. With it off, files are changed where they lie and there is no way back. Ask the user which it is,\n' +
  '  and which git repository the work happens in, and write both into every session.';

const VCS_RULE_BG =
  '- **Контролът на версиите е нещо, за което трябва да питаш, и няма стойност по подразбиране.** Когато е\n' +
  '  включен, runner-ът прави клон преди всяка задача и комит след нея, с имената, които ти зададеш, и никога не\n' +
  '  пуши; самият Copilot не бива да пипа git. Когато е изключен, файловете се променят на място и няма връщане\n' +
  '  назад. Питай потребителя кое от двете е и в кое git хранилище се работи, и запиши и двете във всяка сесия.';

/** The field table, with the git rows in the places they belong among the others. */
function rowsEn(): string[][] {
  return [...FIELD_ROWS_EN.slice(0, -2), ...VCS_ROWS_EN.slice(0, 1), ...FIELD_ROWS_EN.slice(-2), ...VCS_ROWS_EN.slice(1)];
}

function rowsBg(): string[][] {
  return [...FIELD_ROWS_BG.slice(0, -2), ...VCS_ROWS_BG.slice(0, 1), ...FIELD_ROWS_BG.slice(-2), ...VCS_ROWS_BG.slice(1)];
}

function buildEn(): string {
  const rows = rowsEn();

  return `
# Brief: write a task plan for copilot-operator

You are helping someone plan work for **copilot-operator**, a bot that runs on their own
Windows machine. Here is what it actually does, because it changes what a good task looks like:

- A **session** is one conversation with Microsoft 365 Copilot. The tasks in a session run one
  after another in that same conversation, so a later task can build on an earlier one.
- For each task, Copilot decides the steps and writes them as PowerShell commands. The runner
  executes them on the real machine and sends the raw terminal output back to Copilot, which
  reads it and decides the next step. This repeats until Copilot writes a final summary.
- Nothing is interactive. A command that waits for a keypress, opens an editor or needs a
  browser login will hang the task.
${VCS_RULE_EN}
- The operator approves each command before it runs, unless they turned that off.

## Your job, in order

1. **Interview the user first.** Do not write any JSON until you can answer all of these:
   - What is the goal, and how will they know it worked?
   - Which folders and repositories, by absolute Windows path?
   - **Should the runner do version control for this work — a branch per task and a commit at
     the end — or not?** Ask it in those words. There is no default, and the system refuses a
     plan that does not say.
   - **If yes: which git repository, by absolute path?** It has to be a folder that already has
     a \`.git\` in it; the system refuses the plan otherwise, naming the folder.
   - What language, tooling and test command?
   - What must not be touched?
   - Is this one chain of dependent steps, or several independent pieces of work?
   Ask in small batches. Ask about anything you would otherwise have to invent — especially
   paths, commands and names. If the user gives you a vague answer, ask again. If they will not
   answer the version-control question, say that you cannot write the plan without it, and why:
   the two answers produce different work, and one of them cannot be undone.
2. **Propose the split, in prose, before the JSON.** Say how many sessions and how many tasks,
   what each one does, and why they are in that order. Let the user correct you.
3. **Then write the JSON**, in one fenced \`\`\`json block, with nothing after it.

## How to split the work

- One task is one outcome that can be checked. If you cannot write its \`expected\` in a
  sentence, it is two tasks.
- Tasks that depend on each other belong in **one session**, in order, with
  \`"onFailure": "stop"\`.
- Work that is genuinely separate — a different repository, a different goal, checks that say
  nothing about each other — belongs in **its own session**. Independent checks inside one
  session get \`"onFailure": "continue"\`.
- One chat or several is a separate decision from one session or several. Sessions in one chat
  see each other's history, which helps when they are parts of one piece of work and hurts when
  they are not: an unrelated session then starts with pages of context that has nothing to do
  with it. Default to \`"per-session"\` and choose \`"shared"\` deliberately.
- The same question is asked twice, at two levels, and they are not the same answer. The
  \`onFailure\` **on a session** is about its tasks. The \`onFailure\` **at the top of the
  document** is about the sessions themselves: whether a later session is still worth running
  after an earlier one failed. A plan of one chain split into stages is \`"stop"\` at both
  levels; a plan of unrelated jobs is \`"continue"\` at the top and whatever each session needs
  inside it.
- Prefer 2 to 6 tasks per session. A task whose prompt is longer than about 15 lines is
  usually two tasks.
- Write every path absolutely. Never write "the project folder" or "the repo".

## The format

${table(['Field', 'Where', 'Required', 'What it is'], rows)}

${VCS_DETAIL_EN}

${MIRROR_EN}

${CHECKS_EN}

## A filled-in example

\`\`\`json
${JSON.stringify(planExample(), null, 2)}
\`\`\`

## Hard rules for the output

- Plain JSON, one fenced block, nothing after it. No comments, no trailing commas, straight
  quotes only.
- Windows paths inside JSON strings need doubled backslashes: \`"C:\\\\Projects\\\\billing"\`.
- Every field spelled exactly as above. Unknown fields are ignored and reported as warnings.
- The user pastes your JSON into the system, which validates it. **If they come back with a
  list of errors, fix those exact points and print the whole corrected JSON again** — not a
  fragment, and not an explanation of what you would change.
`.trim();
}

function buildBg(): string {
  const rows = rowsBg();

  return `
# Задание: напиши план със задачи за copilot-operator

Помагаш на човек да планира работа за **copilot-operator** — бот, който работи на неговата
собствена Windows машина. Ето какво прави той в действителност, защото това определя коя
задача е добра:

- **Сесия** е един разговор с Microsoft 365 Copilot. Задачите в сесията се изпълняват една
  след друга в същия разговор, така че по-късна задача може да стъпи върху по-ранна.
- За всяка задача Copilot решава стъпките и ги пише като PowerShell команди. Runner-ът ги
  изпълнява на реалната машина и връща суровия изход от терминала обратно на Copilot, който го
  чете и решава следващата стъпка. Това се повтаря, докато Copilot не напише финално резюме.
- Нищо не е интерактивно. Команда, която чака клавиш, отваря редактор или иска вход през
  браузър, ще увисне.
${VCS_RULE_BG}
- Операторът одобрява всяка команда преди изпълнение, освен ако не е изключил това.

## Какво трябва да направиш, по ред

1. **Първо разпитай потребителя.** Не пиши никакъв JSON, докато не можеш да отговориш на
   всичко от това:
   - Каква е целта и как ще разберем, че е постигната?
   - Кои папки и хранилища, с абсолютен Windows път?
   - **Runner-ът да прави ли контрол на версиите за тази работа — клон за всяка задача и комит
     накрая — или не?** Питай точно това. Няма стойност по подразбиране и системата отказва
     план, който не го казва.
   - **Ако да: кое git хранилище, с абсолютен път?** Трябва да е папка, в която вече има \`.git\`;
     иначе системата отказва плана и назовава папката.
   - Какъв език, какви инструменти, с коя команда се пускат тестовете?
   - Какво не бива да се пипа?
   - Това една верига от зависими стъпки ли е, или няколко независими парчета работа?
   Питай на малки групи въпроси. Питай за всичко, което иначе би трябвало да измислиш — най-вече
   пътища, команди и имена. Ако отговорът е мъгляв, питай пак. Ако потребителят не иска да
   отговори за контрола на версиите, кажи му, че без това не можеш да напишеш плана, и защо:
   двата отговора водят до различна работа, а единият от тях не се връща назад.
2. **Предложи разбивката с думи, преди JSON-а.** Кажи колко сесии и колко задачи, какво прави
   всяка и защо са в този ред. Дай на потребителя да те поправи.
3. **Чак тогава напиши JSON-а**, в един ограден \`\`\`json блок, без нищо след него.

## Как се разбива работата

- Една задача е един резултат, който може да се провери. Ако не можеш да напишеш \`expected\` в
  едно изречение, това са две задачи.
- Задачи, които зависят една от друга, влизат в **една сесия**, по ред, с
  \`"onFailure": "stop"\`.
- Работа, която наистина е отделна — друго хранилище, друга цел, проверки, които не си говорят —
  влиза в **своя собствена сесия**. Независими проверки в рамките на една сесия получават
  \`"onFailure": "continue"\`.
- Един чат или няколко е отделно решение от една сесия или няколко. Сесиите в един чат виждат
  историята си една на друга — което помага, когато са части от една работа, и пречи, когато не
  са: несвързана сесия тогава тръгва със страници контекст, който няма нищо общо с нея. По
  подразбиране \`"per-session"\`, а \`"shared"\` се избира съзнателно.
- Един и същ въпрос се задава два пъти, на две нива, и отговорът не е непременно един и същ.
  \`onFailure\` **на сесия** е за нейните задачи. \`onFailure\` **най-горе в документа** е за
  самите сесии: дали по-късна сесия изобщо си струва да се пуска, след като по-ранна се е
  провалила. План, който е една верига, разделена на етапи, е \`"stop"\` и на двете нива; план
  от несвързани работи е \`"continue"\` най-горе и каквото трябва във всяка сесия.
- Гледай да са между 2 и 6 задачи в сесия. Задача, чийто prompt е по-дълъг от около 15 реда,
  обикновено са две задачи.
- Пиши всеки път абсолютно. Никога „папката на проекта“ или „хранилището“.

## Форматът

${table(['Поле', 'Къде', 'Задължително', 'Какво е'], rows)}

${VCS_DETAIL_BG}

${MIRROR_BG}

${CHECKS_BG}

## Попълнен пример

\`\`\`json
${JSON.stringify(planExample(), null, 2)}
\`\`\`

## Твърди правила за изхода

- Чист JSON, един ограден блок, нищо след него. Без коментари, без запетая след последния
  елемент, само прави кавички.
- Windows пътищата вътре в JSON низ искат удвоени обратни наклонени черти:
  \`"C:\\\\Projects\\\\billing"\`.
- Всяко поле — изписано точно както горе. Непознатите полета се игнорират и се съобщават като
  предупреждения.
- Потребителят поставя твоя JSON в системата, която го проверява. **Ако се върне със списък от
  грешки, поправи точно тези места и разпечатай целия поправен JSON отново** — не парче и не
  обяснение какво би променил.
`.trim();
}

/**
 * The brief, in the language the interface is in.
 *
 * Nothing else varies any more. The questions it used to be built around — version control,
 * and which folder — are now questions it asks, which is where they belonged: the model is the
 * one having the conversation, and its answers travel in the JSON per session rather than
 * being fixed for the whole document by a form filled in beforehand.
 *
 * Unknown languages get English rather than nothing.
 */
export function planBrief(opts: BriefOptions | string = {}): string {
  const lang = typeof opts === 'string' ? opts : opts.lang;
  return lang === 'bg' ? buildBg() : buildEn();
}
