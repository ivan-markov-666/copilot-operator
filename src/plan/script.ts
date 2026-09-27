/**
 * Every message in which Kerrigan asks the operator something, written out word for word.
 *
 * The brief used to describe what to ask — "where work comes from", "the conventions", "interview in
 * small batches" — and leave the wording to the model. Three copies of the same brief, pasted into
 * three new conversations, then opened with three different menus: one lettered its questions A, B,
 * C because a rule said so, two numbered them, one asked about the persona in its first message and
 * two did not, and each grouped the same topics differently. Nothing was wrong with any single reply;
 * what was wrong is that the operator could not learn the conversation, because it was a different
 * conversation every time. A rule saying "be consistent" does not fix that, since each reply is
 * consistent with itself. What fixes it is giving the model nothing to compose: the questions, their
 * order, their numbers and their options are data here, the brief prints them as quotations, and the
 * model is told to copy them.
 *
 * The numbering is digits only. Questions are 1, 2, 3; the options under question 2 are 2.1, 2.2,
 * 2.3, so an answer to a whole message is one line — `1.1 2.2 3.1` — with no letter to mistype and
 * no ambiguity about which question a number belongs to. A message that holds a single choice
 * numbers its options 1, 2, 3, because a lone "1.1" would be numbering for its own sake.
 *
 * The phase line is part of the quotation, not a rule beside it. Given a list of six phase lines to
 * choose from, the model chose by the nearest heading and put the persona questions of the first-run
 * interview under "before phase 1"; a line printed inside the message it belongs to leaves nothing to
 * choose.
 *
 * A question whose answer the operator may not know how to phrase carries hints: a line that says
 * what is wanted, or which files already say it, and a line starting "Example:" that the operator can
 * skip. They were asked for after the first full run through the interview, where "what goes wrong
 * here that is not obvious from the code" and "the templates" were answered by guessing what was
 * meant. Where the usual answers can be listed, the question offers them as options instead, with the
 * free answer last — the operator picks a number rather than writing a convention out from memory.
 *
 * What the model still fills in is marked with {braces}: a project's path, a proposed run name, the
 * verdicts of a validation. Those are facts about this conversation, not wording. The options of
 * the project questions are the machine's own projects, listed here from the same list the brief
 * shows, so they too are the same every time the machine is the same.
 *
 * Both languages sit side by side in each entry, so the English and Bulgarian scripts cannot drift
 * apart in shape: a question added to one is added to the other in the same edit, or the file does
 * not compile. `test/script.check.ts` holds the rendered result to the numbering rules.
 */
import type { KnownProject } from './brief.js';

type Lang = 'en' | 'bg';
type Text = { en: string; bg: string };

/**
 * A question answered in the operator's own words: a fact nobody here knows yet. `hints` are printed
 * under it in italics — what is wanted, which files already hold the answer, and an example.
 */
type Ask = { ask: Text; hints?: Text[] };

/**
 * A question answered by picking. `other` is the last option: by default *something else — say
 * what*, a wording of its own where the free answer needs saying more precisely, or none at all when
 * the choice is closed (the persona question, the approval of a breakdown) or its last listed option
 * is already the free answer. `recommend` says whether the model may mark one option *(recommended)*:
 * never on a question about what the operator has or knows, which is a fact about them and not a
 * thing to advise on.
 */
type Choose = {
  choose: Text;
  options: Text[] | 'projects';
  other?: false | Text;
  recommend?: false;
  hints?: Text[];
};

type Question = Ask | Choose;

/**
 * Where in the conversation a message belongs. `phase0` is the full first-run interview, `persona`
 * the step that asks only for the persona, and the rest are every conversation's.
 */
export type Stage = 'phase0' | 'persona' | 'phase1' | 'phase3' | 'phase4';

/** Which phase line a message opens with. `persona` depends on the state of the brief; see below. */
type PhaseKey = 'p0' | 'p1' | 'p3' | 'p4' | 'persona';

export type ScriptMessage = {
  id: string;
  stages: Stage[];
  phase: PhaseKey;
  /** For the model, not the operator: when this message is sent. Printed as the heading above it. */
  when: Text;
  /** Fixed lines before the questions — a validation, a breakdown, a verdict — with {braces} to fill. */
  lead?: Text[];
  questions: Question[];
};

/**
 * The phase lines, fixed. Left to the model it copied whatever heading was nearest — "Фаза 0 — още
 * нищо не е записано, затова направи това преди всичко останало" is the brief's own section title —
 * and named the same phase three ways in one conversation.
 */
export const PHASE_LINES: Record<'p0' | 'beforeP1' | 'p1' | 'p2' | 'p3' | 'p4', Text> = {
  p0: { en: 'Phase 0 — how work is done here', bg: 'Фаза 0 — как се работи тук' },
  beforeP1: { en: 'Before phase 1 — the approach', bg: 'Преди фаза 1 — подходът' },
  p1: { en: 'Phase 1 — this work', bg: 'Фаза 1 — тази работа' },
  p2: { en: 'Phase 2 — the plan and the run', bg: 'Фаза 2 — планът и пускането' },
  p3: { en: 'Phase 3 — why it did not end done', bg: 'Фаза 3 — защо не завърши готова' },
  p4: { en: 'Phase 4 — the verdict', bg: 'Фаза 4 — присъдата' },
};

/**
 * The marker for an answer the model already has, and the two ways a message carrying one ends.
 *
 * "On record" alone read as a statement, and the operator asked where it came from and why it was
 * being asked again: the answer is that it came from their own documents or an earlier answer in
 * this conversation, and it is shown so they can correct it. The marker now says that in its own
 * words. A message could also carry both answered and unanswered questions, and with only one fixed
 * ending for the all-answered case the model wrote its own for the mixed one.
 */
export const ALREADY_SAID: Text = {
  en: 'Already said — confirm or correct:',
  bg: 'Вече казано — потвърди или поправи:',
};
export const ON_RECORD_ALL: Text = {
  en: 'If everything already said is right, answer `right`; otherwise write only the numbers you change, with the new answer.',
  bg: 'Ако всичко казано е вярно, отговори `вярно`; иначе напиши само номерата, които променяш, с новия отговор.',
};
export const ON_RECORD_MIXED: Text = {
  en: 'Answer under the numbers without "Already said"; where what is already said is right, write nothing under it, otherwise correct it under its number.',
  bg: 'Отговори под номерата без „Вече казано“; където казаното е вярно, не пиши нищо под него, иначе го поправи под номера му.',
};

const OTHER: Text = { en: 'something else — say what', bg: 'друго — напиши какво' };
const OTHER_FOLDER: Text = { en: 'another folder — give its absolute path', bg: 'друга папка — напиши абсолютния ѝ път' };
const OTHER_RULE: Text = { en: 'something else — write the rule and an example', bg: 'друго — напиши правилото и пример' };

export const SCRIPT: ScriptMessage[] = [
  {
    id: 'org-work',
    stages: ['phase0'],
    phase: 'p0',
    when: {
      en: 'Phase 0, the first message: where work comes from and where information lives',
      bg: 'Фаза 0, първото съобщение: откъде идва работата и къде е информацията',
    },
    questions: [
      {
        ask: {
          en: 'Where does work come from: which ticket system do you use (Azure DevOps, Jira, GitHub, email or another), and what does a ticket always carry?',
          bg: 'Откъде идва работата: коя система за ticket-и ползвате (Azure DevOps, Jira, GitHub, имейл или друга) и какво носи винаги един ticket?',
        },
      },
      {
        ask: {
          en: 'What are the acceptance criteria called, and where are they written?',
          bg: 'Как се наричат критериите за приемане и къде са записани?',
        },
      },
      {
        ask: {
          en: 'Where does the information live that I may need (OneDrive, SharePoint, Teams, a wiki, a docs folder)? What may I search from this chat, and what must you give me?',
          bg: 'Къде е информацията, която може да ми потрябва (OneDrive, SharePoint, Teams, wiki, папка с документи)? Кое мога да търся от този чат и кое трябва да ми дадеш?',
        },
      },
      {
        choose: {
          en: 'Which of the projects on this machine do we describe? Several are fine.',
          bg: 'Кои от проектите на тази машина да опишем? Може няколко.',
        },
        options: 'projects',
      },
    ],
  },
  {
    id: 'org-project',
    stages: ['phase0'],
    phase: 'p0',
    when: {
      en: 'Phase 0: one message for each project picked in the first message, with its path in {path}',
      bg: 'Фаза 0: по едно съобщение за всеки проект, избран в първото съобщение, с пътя му в {път}',
    },
    lead: [{ en: 'Project `{path}`:', bg: 'Проект `{път}`:' }],
    questions: [
      {
        ask: { en: 'What does this project do, in one sentence?', bg: 'Какво прави този проект, с едно изречение?' },
        hints: [
          {
            en: 'Example: an orders REST API on Node.js; a Next.js website; Playwright tests for the web application; a .NET library.',
            bg: 'Пример: REST API за поръчки на Node.js; сайт на Next.js; тестове на Playwright за уеб приложението; библиотека на .NET.',
          },
        ],
      },
      {
        ask: { en: 'Which folders in it matter, and what is in them?', bg: 'Кои папки в него имат значение и какво има в тях?' },
        hints: [
          {
            en: 'Example: src — the code; test — the tests; migrations — the database changes; docs — the documentation.',
            bg: 'Пример: src — кодът; test — тестовете; migrations — промените по базата; docs — документацията.',
          },
        ],
      },
      {
        ask: {
          en: 'What must be installed, running or set before it builds and its tests run?',
          bg: 'Какво трябва да е инсталирано, пуснато или зададено, преди да се строи и да се пуснат тестовете?',
        },
        hints: [
          {
            en: 'Easiest: attach or paste the files that already say it — README, package.json (the engines field), .nvmrc, Dockerfile, docker-compose.yml, `*.csproj` or global.json (.NET), pom.xml or build.gradle (Java), requirements.txt or pyproject.toml (Python), go.mod (Go).',
            bg: 'Най-лесно: прикачи или постави файловете, които вече го казват — README, package.json (полето engines), .nvmrc, Dockerfile, docker-compose.yml, `*.csproj` или global.json (.NET), pom.xml или build.gradle (Java), requirements.txt или pyproject.toml (Python), go.mod (Go).',
          },
          {
            en: 'Example: Node.js 20 and TypeScript 5; Playwright with the Chromium browser; the .NET 8 SDK; Java 17 and Maven; Python 3.12 and Poetry; Docker with the postgres:16 and redis:7 images; a Kubernetes cluster for the integration tests; the DATABASE_URL environment variable.',
            bg: 'Пример: Node.js 20 и TypeScript 5; Playwright с браузъра Chromium; .NET 8 SDK; Java 17 и Maven; Python 3.12 и Poetry; Docker с образите postgres:16 и redis:7; Kubernetes клъстер за интеграционните тестове; променливата на средата DATABASE_URL.',
          },
        ],
      },
      {
        choose: { en: 'Which commands build, start and test it?', bg: 'С кои команди се строи, пуска и тества?' },
        options: [
          {
            en: 'I will attach the file that defines them — package.json (scripts), Makefile, `*.csproj` or `*.sln`, pom.xml, build.gradle, pyproject.toml or tox.ini, justfile',
            bg: 'Ще прикача файла, в който са описани — package.json (scripts), Makefile, `*.csproj` или `*.sln`, pom.xml, build.gradle, pyproject.toml или tox.ini, justfile',
          },
          {
            en: 'I will write them here: which command builds, which starts and which tests',
            bg: 'Ще ги напиша тук: коя команда строи, коя пуска и коя тества',
          },
        ],
        other: false,
        recommend: false,
        hints: [
          {
            en: 'Example: npm run build, npm start, npm test; dotnet build, dotnet test; mvn package, mvn test; pytest; go test ./...',
            bg: 'Пример: npm run build, npm start, npm test; dotnet build, dotnet test; mvn package, mvn test; pytest; go test ./...',
          },
        ],
      },
      {
        choose: {
          en: 'What traps are there — things not visible in the code that break the build, the start or the tests? Several are fine.',
          bg: 'Какви капани има тук — неща, които не личат от кода, но чупят build-а, пускането или тестовете? Може няколко.',
        },
        options: [
          { en: 'None that I know of', bg: 'Не знам за такива' },
          {
            en: 'A service must be running separately — a database, a queue, another service (say which and how it starts)',
            bg: 'Трябва услуга, пусната отделно — база, опашка, друг сървис (напиши коя и как се пуска)',
          },
          {
            en: 'A command that looks right but does not work (say which, and what is used instead)',
            bg: 'Команда, която изглежда вярна, но не работи (напиши коя и какво се ползва вместо нея)',
          },
          {
            en: 'Tests that depend on order, time, the network or data (say which)',
            bg: 'Тестове, които зависят от ред, време, мрежа или данни (напиши кои)',
          },
          {
            en: 'A cache or generated files that must be cleared (say which and how)',
            bg: 'Кеш или генерирани файлове, които трябва да се изчистят (напиши кои и как)',
          },
        ],
        recommend: false,
        hints: [
          {
            en: 'This is the knowledge a person gathers the hard way, and it is worth the most of anything here.',
            bg: 'Това е знанието, което човек събира по трудния начин, и то струва най-много от всичко тук.',
          },
          {
            en: 'Example: "npm test does not work, the tests run with …"; "port 3000 is taken by another application"; "after a schema change a migration must be run".',
            bg: 'Пример: „npm test не работи, тестовете се пускат с …“; „портът 3000 е зает от друго приложение“; „след смяна на схемата трябва да се пусне миграция“.',
          },
        ],
      },
      {
        choose: { en: 'How do I read its code from this chat?', bg: 'Как да чета кода му от този чат?' },
        options: [
          { en: 'As files attached to the first message of a task', bg: 'Като прикачени файлове към първото съобщение на задачата' },
          { en: 'Through the Desktop mirror (Desktop/copilot-operator-context/)', bg: 'През огледалото на Desktop-а (Desktop/copilot-operator-context/)' },
          { en: 'Both', bg: 'И двете' },
        ],
      },
      {
        choose: {
          en: 'May the bot make git branches and commits in this project?',
          bg: 'Може ли ботът да прави git клонове и комити в този проект?',
        },
        options: [
          { en: 'Yes — a branch before each task and a commit after it, never a push', bg: 'Да — клон преди всяка задача и комит след нея, без push' },
          { en: 'No — files change in place, with no git', bg: 'Не — файловете се променят на място, без git' },
        ],
        recommend: false,
        hints: [
          {
            en: 'With yes, there is always a way back to the code as it was before a task. With no, files change directly, with no history and no way back.',
            bg: 'При „Да“ винаги има връщане към кода отпреди задачата. При „Не“ файловете се променят направо, без история и без връщане назад.',
          },
        ],
      },
    ],
  },
  {
    id: 'org-conventions',
    stages: ['phase0'],
    phase: 'p0',
    when: { en: 'Phase 0: the conventions', bg: 'Фаза 0: правилата' },
    questions: [
      {
        choose: { en: 'How are git branches named?', bg: 'Как се именуват git клоновете?' },
        options: [
          { en: '`feature/<ticket>-<description>` — for example feature/PBI-123-login-page', bg: '`feature/<ticket>-<описание>` — например feature/PBI-123-login-page' },
          { en: '`<type>/<description>` — for example fix/null-id, chore/update-deps', bg: '`<тип>/<описание>` — например fix/null-id, chore/update-deps' },
          { en: "`cop/<short-name>` — the bot's own prefix, for example cop/calculator-core", bg: '`cop/<кратко-име>` — префиксът на бота, например cop/calculator-core' },
          { en: 'No rule', bg: 'Няма правило' },
        ],
        other: OTHER_RULE,
        recommend: false,
      },
      {
        choose: { en: 'What is the commit message style?', bg: 'Какъв е стилът на комит съобщенията?' },
        options: [
          { en: 'Conventional Commits — for example `feat: add login page`, `fix(api): handle a missing id`', bg: 'Conventional Commits — например `feat: add login page`, `fix(api): handle a missing id`' },
          { en: 'The ticket number first — for example `PBI-123 Add login page`', bg: 'Номерът на ticket-а отпред — например `PBI-123 Add login page`' },
          { en: 'One sentence in the imperative — for example `Add login page`', bg: 'Едно изречение в повелително наклонение — например `Add login page`' },
          { en: 'No rule', bg: 'Няма правило' },
        ],
        other: OTHER_RULE,
        recommend: false,
      },
      {
        choose: { en: 'How does a change reach the main branch?', bg: 'Как промяната стига до основния клон?' },
        options: [
          { en: 'No pull requests — the work stays local on its branches', bg: 'Без pull request-и — работата остава локално в клоновете си' },
          {
            en: 'A pull request on GitHub, Azure DevOps or GitLab, with an approval and a green CI — say who approves and which checks',
            bg: 'Pull request в GitHub, Azure DevOps или GitLab, с одобрение и зелен CI — напиши кой одобрява и кои проверки',
          },
        ],
        recommend: false,
        hints: [
          {
            en: 'That is: is there a pull request, who approves it, and which checks must pass before the merge.',
            bg: 'Тоест: има ли pull request, кой го одобрява и кои проверки трябва да минат преди merge.',
          },
        ],
      },
      {
        ask: {
          en: 'Which command runs the tests, and is there a coverage threshold?',
          bg: 'С коя команда се пускат тестовете и има ли праг за покритие?',
        },
        hints: [
          {
            en: 'Example: npm test; npx playwright test; dotnet test; mvn test; gradle test; pytest; go test ./... — coverage at least 80%.',
            bg: 'Пример: npm test; npx playwright test; dotnet test; mvn test; gradle test; pytest; go test ./... — покритие поне 80%.',
          },
        ],
      },
      {
        ask: {
          en: 'What are the coding standards: language version, linter, formatter?',
          bg: 'Какви са стандартите за код: версия на езика, линтер, форматер?',
        },
        hints: [
          {
            en: 'You may attach their configuration instead: .eslintrc, .prettierrc, .editorconfig, tsconfig.json, pyproject.toml, checkstyle.xml.',
            bg: 'Може вместо това да прикачиш конфигурацията им: .eslintrc, .prettierrc, .editorconfig, tsconfig.json, pyproject.toml, checkstyle.xml.',
          },
          {
            en: 'Example: TypeScript 5 in strict mode with ESLint and Prettier; C# 12 with .editorconfig and dotnet format; Java 17 with Checkstyle; Python 3.12 with ruff and black; Go with gofmt.',
            bg: 'Пример: TypeScript 5 в strict режим с ESLint и Prettier; C# 12 с .editorconfig и dotnet format; Java 17 с Checkstyle; Python 3.12 с ruff и black; Go с gofmt.',
          },
        ],
      },
      {
        ask: { en: 'How are files and folders named?', bg: 'Как се именуват файловете и папките?' },
        hints: [
          {
            en: 'Example: files in kebab-case (user-service.ts); classes in PascalCase (UserService.cs); tests beside the code as .test.ts or .spec.ts, or in a tests folder; Java packages as com.company.module.',
            bg: 'Пример: файловете в kebab-case (user-service.ts); класовете в PascalCase (UserService.cs); тестовете до кода като .test.ts или .spec.ts, или в папка tests; пакетите в Java — com.company.module.',
          },
        ],
      },
      {
        choose: {
          en: 'Are there templates or scaffolds new code starts from?',
          bg: 'Има ли шаблони или скелети, от които тръгва новият код?',
        },
        options: [
          { en: 'No', bg: 'Няма' },
          {
            en: 'Yes — say where: a folder, a repository or a generator (`dotnet new`, `npm create`, Spring Initializr, cookiecutter)',
            bg: 'Да — напиши къде: папка, хранилище или генератор (`dotnet new`, `npm create`, Spring Initializr, cookiecutter)',
          },
        ],
        recommend: false,
        hints: [
          {
            en: 'That is: a ready sample project, a generator or a folder of examples that new code must follow.',
            bg: 'Тоест: готов примерен проект, генератор или папка с образци, които новият код трябва да следва.',
          },
        ],
      },
      {
        choose: {
          en: 'When is a piece of work finished (definition of done)? Several are fine.',
          bg: 'Кога една работа се смята за завършена (definition of done)? Може няколко.',
        },
        options: [
          { en: 'The build passes — npm run build, dotnet build, mvn package, gradle build', bg: 'Build-ът минава — npm run build, dotnet build, mvn package, gradle build' },
          { en: 'All tests pass — npm test, dotnet test, mvn test, pytest, go test ./...', bg: 'Всички тестове минават — npm test, dotnet test, mvn test, pytest, go test ./...' },
          { en: 'New behaviour is covered by a test', bg: 'Новото поведение е покрито с тест' },
          {
            en: 'The linter and formatter pass — eslint, prettier --check, dotnet format --verify-no-changes, ruff, gofmt',
            bg: 'Линтерът и форматерът минават — eslint, prettier --check, dotnet format --verify-no-changes, ruff, gofmt',
          },
          { en: 'Coverage does not drop below the threshold', bg: 'Покритието не пада под прага' },
          { en: 'The documentation is updated — README, CHANGELOG', bg: 'Документацията е обновена — README, CHANGELOG' },
        ],
        recommend: false,
      },
    ],
  },
  {
    id: 'org-people',
    stages: ['phase0'],
    phase: 'p0',
    when: { en: 'Phase 0: people and limits', bg: 'Фаза 0: хората и границите' },
    questions: [
      {
        ask: {
          en: "Which changes must not be made without somebody's agreement first — and whose?",
          bg: 'Кои промени не бива да се правят без нечие предварително съгласие — и чие?',
        },
        hints: [
          {
            en: 'Example: a new external dependency — the tech lead; a database schema change — the architect; a change to the public API — the product owner.',
            bg: 'Пример: нова външна зависимост — tech lead-ът; промяна в схемата на базата — архитектът; промяна в публичното API — продуктовият собственик.',
          },
        ],
      },
      {
        ask: {
          en: 'Who accepts finished work — who does the code review or closes the ticket?',
          bg: 'Кой приема завършената работа — кой прави code review или затваря ticket-а?',
        },
        hints: [
          {
            en: 'Example: every pull request is approved by one senior developer; QA closes the ticket after checking it on staging; nobody, for a test.',
            bg: 'Пример: всеки pull request се одобрява от един senior; QA затваря ticket-а след проверка на staging; за тест — никой.',
          },
        ],
      },
      {
        ask: {
          en: 'What must the bot never change — files, folders, settings?',
          bg: 'Какво ботът никога не бива да променя — файлове, папки, настройки?',
        },
        hints: [
          {
            en: 'Example: .github/workflows and the rest of the CI; migrations already applied; package-lock.json; .env and the secrets; the infra folder; modules owned by another team.',
            bg: 'Пример: .github/workflows и останалия CI; вече пуснати миграции; package-lock.json; .env и тайните; папката infra; модули на друг екип.',
          },
        ],
      },
    ],
  },
  {
    id: 'persona-ask',
    stages: ['phase0', 'persona'],
    phase: 'persona',
    when: {
      en: 'The persona: in phase 0 after "people and limits"; before phase 1 as the first message',
      bg: 'Персоната: във фаза 0 след „хората и границите“; преди фаза 1 — като първо съобщение',
    },
    questions: [
      {
        choose: { en: 'How will the tasks be carried out?', bg: 'Как ще се изпълняват задачите?' },
        options: [
          {
            en: 'I have a persona and will give it to you in my next chat message, for you to validate.',
            bg: 'Имам персона и ще я предоставя в следващото си чат съобщение, за да я валидираш.',
          },
          {
            en: 'I do not have a persona and want you to help me create it.',
            bg: 'Нямам персона и искам да ми помогнеш да я създадем.',
          },
        ],
        other: false,
        recommend: false,
      },
    ],
  },
  {
    id: 'persona-validate',
    stages: ['phase0', 'persona'],
    phase: 'persona',
    when: {
      en: 'The persona, answer 1: once the operator has sent it. Fill each {…} with "clear" or with what is missing',
      bg: 'Персоната, отговор 1: щом операторът я прати. Всяко {…} е „ясно“ или какво липсва',
    },
    lead: [
      { en: 'I checked the persona for the five things it must make clear:', bg: 'Проверих персоната за петте неща, които трябва да са ясни:' },
      { en: '- What the agent is responsible for, and what not: {…}', bg: '- За какво отговаря агентът и за какво не: {…}' },
      { en: '- Its approach: {…}', bg: '- Подходът му: {…}' },
      { en: '- Its phases, and what shows each is done: {…}', bg: '- Фазите му и какво показва, че всяка е свършена: {…}' },
      { en: '- The result it hands back: {…}', bg: '- Резултатът, който предава: {…}' },
      { en: '- No name, not written as a character: {…}', bg: '- Без име и не е написана като герой: {…}' },
    ],
    questions: [
      {
        choose: { en: 'What do we do?', bg: 'Какво правим?' },
        options: [
          { en: 'I will fix it and send it again in my next message.', bg: 'Ще я поправя и ще я пратя пак в следващото си съобщение.' },
          { en: 'We go on with it as it is.', bg: 'Продължаваме с нея, както е.' },
        ],
      },
    ],
  },
  {
    id: 'persona-build-approach',
    stages: ['phase0', 'persona'],
    phase: 'persona',
    when: {
      en: 'The persona, answer 2, first message: responsibilities and approach',
      bg: 'Персоната, отговор 2, първо съобщение: отговорностите и подходът',
    },
    questions: [
      {
        choose: {
          en: 'What is the agent responsible for in this work? Several are fine.',
          bg: 'За какво отговаря агентът в тази работа? Може няколко.',
        },
        options: [
          { en: 'Writes new code and the tests for it', bg: 'Пише нов код и тестовете за него' },
          { en: 'Fixes bugs and proves each fix with a test', bg: 'Поправя бъгове и доказва всяка поправка с тест' },
          {
            en: 'Writes automated tests for existing code — unit, integration, end-to-end (for example Playwright)',
            bg: 'Пише автоматизирани тестове за съществуващ код — unit, интеграционни, end-to-end (например Playwright)',
          },
          { en: 'Refactors without changing behaviour', bg: 'Рефакторира, без да променя поведението' },
          { en: 'Audits or reviews — only reads and reports', bg: 'Прави одит или преглед — само чете и докладва' },
        ],
        recommend: false,
      },
      {
        choose: {
          en: 'What is it NOT responsible for — what does it leave to somebody else? Several are fine.',
          bg: 'За какво НЕ отговаря — какво оставя на някой друг? Може няколко.',
        },
        options: [
          { en: 'Deploying and releasing', bg: 'Deploy и release' },
          { en: 'Anything outside the project folder', bg: 'Нищо извън папката на проекта' },
          { en: 'New external dependencies', bg: 'Нови външни зависимости' },
          { en: 'CI/CD and infrastructure', bg: 'CI/CD и инфраструктурата' },
          { en: 'The database schema and migrations', bg: 'Схемата на базата и миграциите' },
        ],
        recommend: false,
      },
      {
        choose: { en: 'Pace:', bg: 'Темпо:' },
        options: [
          {
            en: 'Cautious — proves every claim with a command before making it',
            bg: 'Предпазливо — доказва всяко твърдение с команда, преди да го направи',
          },
          { en: 'Quick — verifies only at the end', bg: 'Бързо — проверява само накрая' },
        ],
      },
      {
        choose: { en: 'Code:', bg: 'Код:' },
        options: [
          { en: 'May change code', bg: 'Може да променя код' },
          { en: 'Only reads code and reports', bg: 'Само чете код и докладва' },
        ],
      },
      {
        choose: {
          en: 'When does it stop and report rather than guess? Several are fine.',
          bg: 'Кога спира и докладва, вместо да гадае? Може няколко.',
        },
        options: [
          { en: 'When the assignment is unclear or contradicts itself', bg: 'Когато заданието е неясно или си противоречи' },
          {
            en: 'When it needs something outside the project — access, a password, an install',
            bg: 'Когато му трябва нещо извън проекта — достъп, парола, инсталация',
          },
          { en: 'When a test fails for a reason outside its own change', bg: 'Когато тест пада по причина извън неговата промяна' },
          { en: 'When it would have to touch something it is not responsible for', bg: 'Когато трябва да пипне нещо, за което не отговаря' },
        ],
      },
    ],
  },
  {
    id: 'persona-build-phases',
    stages: ['phase0', 'persona'],
    phase: 'persona',
    when: {
      en: 'The persona, answer 2, second message: phases and result',
      bg: 'Персоната, отговор 2, второ съобщение: фазите и резултатът',
    },
    questions: [
      {
        choose: { en: 'Which stages does it work through?', bg: 'През какви етапи минава?' },
        options: [
          {
            en: 'For work that writes code: Understand (reads the assignment and the code; done when it knows what is missing) → Do (writes the code; done when the code is in place) → Prove (writes a test for each behaviour and runs them all; done when they all pass) → Report (writes the summary; done when it names the files and carries the test output)',
            bg: 'За работа, която пише код: Разбери (чете заданието и кода; свършено, когато знае какво липсва) → Направи (пише кода; свършено, когато кодът е на мястото си) → Докажи (пише тест за всяко поведение и пуска всички; свършено, когато всички минават) → Докладвай (пише резюмето; свършено, когато назовава файловете и съдържа изхода от тестовете)',
          },
          {
            en: 'For bugs: Reproduce (writes a test that fails because of the bug; done when it fails) → Fix (changes the code; done when that test passes) → Prove (runs all the tests; done when they all pass) → Report (the cause and the fix, with the test output)',
            bg: 'За бъгове: Възпроизведи (пише тест, който пада заради бъга; свършено, когато тестът пада) → Поправи (променя кода; свършено, когато тестът минава) → Докажи (пуска всички тестове; свършено, когато всички минават) → Докладвай (причината и поправката, с изхода от тестовете)',
          },
          {
            en: 'For an audit, with no changes: Read (reads the code and the documents; done when everything needed is read) → Check (runs commands that prove or disprove each claim; done when each has a result) → Report (the findings, each with its evidence)',
            bg: 'За одит, без промени: Прочети (чете кода и документите; свършено, когато всичко нужно е прочетено) → Провери (пуска команди, които доказват или опровергават всяко твърдение; свършено, когато всяко има резултат) → Докладвай (находките, всяка с доказателството си)',
          },
        ],
        other: { en: 'something else — describe your stages', bg: 'друго — опиши етапите си' },
        hints: [
          {
            en: 'For each stage: what happens in it, and what shows it is done.',
            bg: 'За всеки етап: какво става в него и кое показва, че е свършен.',
          },
        ],
      },
      {
        choose: { en: 'What does it hand back at the end?', bg: 'Какво предава накрая?' },
        options: [
          {
            en: 'A summary: what changed, in which files, with the output of the tests',
            bg: 'Резюме: какво е променено, в кои файлове, с изхода от тестовете',
          },
          { en: 'A report of findings, with no change to the code', bg: 'Доклад с находки, без промени по кода' },
        ],
      },
      {
        choose: {
          en: 'What will the result be judged by? Several are fine.',
          bg: 'По какво ще се съди резултатът? Може няколко.',
        },
        options: [
          { en: 'All tests pass', bg: 'Всички тестове минават' },
          { en: 'Every acceptance criterion has a test', bg: 'Всеки критерий за приемане има тест' },
          { en: 'The build and the linter pass', bg: 'Build-ът и линтерът минават' },
          { en: 'Nothing outside what is allowed has changed', bg: 'Нищо извън позволеното не е променено' },
        ],
      },
    ],
  },
  {
    id: 'work',
    stages: ['phase0'],
    phase: 'p0',
    when: { en: 'Phase 0, after the persona: this work', bg: 'Фаза 0, след персоната: тази работа' },
    questions: [
      {
        ask: {
          en: 'What is the ticket or the assignment? Paste it whole: number, title, acceptance criteria.',
          bg: 'Кой е ticket-ът или заданието? Постави го цял: номер, заглавие, критерии за приемане.',
        },
      },
      {
        ask: {
          en: 'What is the goal, in one or two sentences: what must be true when the work is over?',
          bg: 'Каква е целта, с едно-две изречения: какво трябва да е вярно, когато работата приключи?',
        },
      },
      {
        choose: { en: 'Which projects does it touch? Several are fine.', bg: 'Кои проекти засяга? Може няколко.' },
        options: 'projects',
      },
      { ask: { en: 'What has already been decided or tried?', bg: 'Какво вече е решено или пробвано?' } },
      {
        ask: {
          en: 'What must stay as it is while this work goes on — things others rely on?',
          bg: 'Какво трябва да остане непроменено, докато тече тази работа — неща, на които разчитат други?',
        },
        hints: [
          {
            en: 'Example: the public endpoints of the API; the database schema; the existing tests; the files in .github/; somebody else\'s work on the same branch.',
            bg: 'Пример: публичните endpoint-и на API-то; схемата на базата; съществуващите тестове; файловете в .github/; работата на друг човек в същия клон.',
          },
        ],
      },
      { ask: { en: 'What is still open, and who decides it?', bg: 'Какво още е отворено и кой го решава?' } },
    ],
  },
  {
    id: 'phase1-work',
    stages: ['phase1'],
    phase: 'p1',
    when: { en: 'Phase 1, the first message: this work', bg: 'Фаза 1, първото съобщение: тази работа' },
    questions: [
      {
        ask: {
          en: 'The assignment: paste it as you have it — a ticket, a work item, a document or one sentence.',
          bg: 'Заданието: постави го така, както го имаш — ticket, работен елемент, документ или едно изречение.',
        },
      },
      {
        ask: {
          en: 'How will you know the work is done? List the acceptance criteria.',
          bg: 'Как ще разбереш, че работата е свършена? Изброй критериите за приемане.',
        },
      },
      {
        choose: { en: 'Which project is the work in? Several are fine.', bg: 'В кой проект е работата? Може няколко.' },
        options: 'projects',
      },
      {
        ask: {
          en: 'Which language and tools, and which command runs the tests?',
          bg: 'Кой език и кои инструменти, и с коя команда се пускат тестовете?',
        },
      },
      {
        ask: {
          en: 'What must stay as it is while this work goes on?',
          bg: 'Какво трябва да остане непроменено, докато тече тази работа?',
        },
        hints: [
          {
            en: 'Example: the public endpoints of the API; the database schema; the existing tests; the files in .github/.',
            bg: 'Пример: публичните endpoint-и на API-то; схемата на базата; съществуващите тестове; файловете в .github/.',
          },
        ],
      },
    ],
  },
  {
    id: 'phase1-settings',
    stages: ['phase1'],
    phase: 'p1',
    when: {
      en: 'Phase 1, once the work is clear (and after any follow-up questions): the settings',
      bg: 'Фаза 1, щом работата е ясна (и след уточненията, ако е имало): настройките',
    },
    questions: [
      {
        choose: { en: 'Version control (`vcs`, required):', bg: 'Контрол на версиите (`vcs`, задължително):' },
        options: [
          { en: 'Yes — a branch before each task and a commit after it', bg: 'Да — клон преди всяка задача и комит след нея' },
          { en: 'No — files change in place, and there is no way back', bg: 'Не — файловете се променят на място и няма връщане назад' },
        ],
      },
      {
        choose: { en: 'Branches, if 1.1 (`branchMode`):', bg: 'Клоновете, ако е 1.1 (`branchMode`):' },
        options: [
          {
            en: 'One branch for the whole session — each task builds on the one before (per-session)',
            bg: 'Един клон за цялата сесия — всяка задача стъпва върху предишната (per-session)',
          },
          {
            en: 'A branch per task — each starts from the same point (per-task)',
            bg: 'Отделен клон за всяка задача — всяка тръгва от едно и също място (per-task)',
          },
        ],
      },
      {
        choose: { en: 'If a task fails (`onFailure` of the session, required):', bg: 'Ако задача се провали (`onFailure` на сесията, задължително):' },
        options: [
          { en: 'Stop — the tasks are a chain', bg: 'Спри — задачите са верига' },
          { en: 'Carry on with the next — the tasks are independent', bg: 'Продължи със следващата — задачите са независими' },
        ],
      },
      {
        choose: { en: 'If a whole session fails (`onFailure` of the plan, required; with one session it makes no difference):', bg: 'Ако цяла сесия се провали (`onFailure` на плана, задължително; при една сесия няма значение):' },
        options: [
          { en: 'Stop — the later sessions do not start', bg: 'Спри — по-късните сесии не тръгват' },
          { en: 'Carry on with the next session', bg: 'Продължи със следващата сесия' },
        ],
      },
      {
        choose: { en: 'Chats (`conversation`, required):', bg: 'Чатове (`conversation`, задължително):' },
        options: [
          { en: 'A chat of its own for each session', bg: 'Отделен чат за всяка сесия' },
          { en: 'One shared chat for all sessions', bg: 'Един общ чат за всички сесии' },
        ],
      },
      {
        choose: { en: 'Review (`review`):', bg: 'Рецензия (`review`):' },
        options: [
          { en: "On, with the session's own model", bg: 'Включена, на модела на сесията' },
          { en: 'On, with another model — say which', bg: 'Включена, на друг модел — напиши кой' },
          { en: 'Off', bg: 'Изключена' },
        ],
      },
      {
        choose: { en: 'Project files for the chat (`mirror`):', bg: 'Файлове на проекта към чата (`mirror`):' },
        options: [
          { en: 'No', bg: 'Не' },
          { en: 'Yes — give the root and the folders', bg: 'Да — напиши корена и папките' },
        ],
      },
      {
        choose: { en: 'Name of the run (`plan`):', bg: 'Име на пускането (`plan`):' },
        options: [{ en: '{the name you propose from the goal}', bg: '{името, което предлагаш от целта}' }],
      },
    ],
  },
  {
    id: 'phase1-breakdown',
    stages: ['phase1'],
    phase: 'p1',
    when: {
      en: 'Phase 1, the last message: the breakdown, in prose, and nothing written yet',
      bg: 'Фаза 1, последното съобщение: разбивката с думи, още без JSON',
    },
    lead: [
      { en: 'Sessions: {count}. Tasks: {count}.', bg: 'Сесии: {брой}. Задачи: {брой}.' },
      { en: 'Session `{name}`: {goal}', bg: 'Сесия `{име}`: {цел}' },
      { en: '- Task `{title}`: {what it does}. Checks: {which}.', bg: '- Задача `{заглавие}`: {какво прави}. Проверки: {какви}.' },
      {
        en: 'Criterion → check: {each criterion of the assignment → the check on the output that names it — for a test, "✔ " and the test named after the criterion}.',
        bg: 'Критерий → проверка: {всеки критерий от заданието → проверката по изхода, която го назовава — за тест, „✔ “ и тестът, кръстен на критерия}.',
      },
      {
        en: 'Settings: version control {…}; if a task fails {…}; if a session fails {…}; chats {…}; review {…}; files for the chat {…}; run name {…}.',
        bg: 'Настройки: контрол на версиите {…}; при провал на задача {…}; при провал на сесия {…}; чатове {…}; рецензия {…}; файлове към чата {…}; име на пускането {…}.',
      },
      { en: 'Decided by me without asking you: {the fields, or "nothing"}.', bg: 'Решено от мен, без да съм те питала: {полетата или „нищо“}.' },
    ],
    questions: [
      {
        choose: { en: 'Is this right?', bg: 'Така ли е?' },
        options: [
          { en: 'Right as it is: write the JSON.', bg: 'Така е добре: напиши JSON-а.' },
          { en: 'I want a change — I will say what.', bg: 'Искам промяна — ще напиша каква.' },
        ],
        other: false,
      },
    ],
  },
  ...(['p3', 'p4'] as const).map(
    (phase): ScriptMessage => ({
      id: phase === 'p3' ? 'record-3' : 'record-4',
      stages: [phase === 'p3' ? 'phase3' : 'phase4'],
      phase,
      when:
        phase === 'p3'
          ? {
              en: 'Phase 3, once the operator has said a task did not end done: asking for the record of the tasks you need, named in {tasks}',
              bg: 'Фаза 3, щом операторът е казал, че задача не е завършила готова: искане на записа на задачите, които ти трябват, назовани в {задачите}',
            }
          : {
              en: 'Phase 4, once the operator has said the run finished: asking for the record of the tasks you still need, named in {tasks}',
              bg: 'Фаза 4, щом операторът е казал, че пускането е приключило: искане на записа на задачите, които още ти трябват, назовани в {задачите}',
            },
      lead: [
        { en: 'I need the record of: {tasks}.', bg: 'Трябва ми записът на: {задачите}.' },
        { en: '1. On `/history`, press **"Choose tasks"**.', bg: '1. В `/history` натисни **„Избери задачи“**.' },
        { en: '2. Tick {tasks}.', bg: '2. Отметни {задачите}.' },
        {
          en: '3. Press **"Download plan, work and runner for the {n} chosen, as one file"**.',
          bg: '3. Натисни **„Изтегли план, работа и runner за избраните {n}, в един файл“**.',
        },
        { en: '4. Paste the contents of the file here.', bg: '4. Постави съдържанието на файла тук.' },
      ],
      questions: [],
    }),
  ),
  {
    id: 'phase4-proven',
    stages: ['phase4'],
    phase: 'p4',
    when: {
      en: 'Phase 4, after the table: every criterion proven',
      bg: 'Фаза 4, след таблицата: всеки критерий е доказан',
    },
    lead: [{ en: 'The assignment is carried out: every criterion is proven.', bg: 'Заданието е изпълнено: всеки критерий е доказан.' }],
    questions: [{ ask: { en: 'What is the next piece of work?', bg: 'Коя е следващата работа?' } }],
  },
  {
    id: 'phase4-unproven',
    stages: ['phase4'],
    phase: 'p4',
    when: {
      en: 'Phase 4, after the table: something claimed only or missing',
      bg: 'Фаза 4, след таблицата: нещо е само твърдение или липсва',
    },
    lead: [{ en: 'Not proven: {the criteria}.', bg: 'Не е доказано: {критериите}.' }],
    questions: [
      {
        choose: { en: 'What do we do?', bg: 'Какво правим?' },
        options: [
          {
            en: 'A read-only task that proves what is only claimed, by running it — for "claimed only"',
            bg: 'Задача само за четене, която доказва твърдяното, като го пуска — за „само твърдение“',
          },
          {
            en: 'Change a task and run it again — the work is right for the task, the task was asked wrongly',
            bg: 'Промени задача и я пусни отново — работата е вярна за задачата, задачата е поискана грешно',
          },
          {
            en: 'Put the repository back and solve it differently — the approach is wrong',
            bg: 'Върни хранилището и реши иначе — грешен е подходът',
          },
          {
            en: 'A new session of tasks — what is missing was never asked for',
            bg: 'Нова сесия със задачи — липсващото никога не е било поискано',
          },
        ],
      },
    ],
  },
];

/**
 * Where a conversation starts, by what the brief carries: the greeting that opens it and the one
 * message that follows. Chosen here rather than by the model.
 *
 * The brief used to list five ways to finish the greeting, one for each place a conversation could
 * start, and leave the choice to the model. With every document written and nothing yet run, one
 * conversation opened with "I'll help you with finding out why it did not end done or judging
 * whether the work was done" — two of the five glued together — and went straight to asking for the
 * record of a run that did not exist, its {tasks} and {n} still in braces. The app knows which state
 * the brief is in; the model does not need to guess, and is not given the chance.
 */
export type StartState = 'phase0' | 'persona' | 'phase1';

export const OPENING: Record<StartState, { greeting: Text; firstMessage: string }> = {
  phase0: {
    greeting: {
      en: "Hello, I'm Kerrigan, Queen of Blades! I'll help you with writing down how work is done here, how the tasks should be carried out and what this work is.",
      bg: 'Здравей, аз съм Kerrigan, Queen of Blades! Ще ти помагам с описването на това как се работи тук, как да се изпълняват задачите и каква е тази работа.',
    },
    firstMessage: 'org-work',
  },
  persona: {
    greeting: {
      en: "Hello, I'm Kerrigan, Queen of Blades! I'll help you with settling how the tasks will be carried out.",
      bg: 'Здравей, аз съм Kerrigan, Queen of Blades! Ще ти помагам с уточняването на това как ще се изпълняват задачите.',
    },
    firstMessage: 'persona-ask',
  },
  phase1: {
    greeting: {
      en: "Hello, I'm Kerrigan, Queen of Blades! I'll help you with planning this piece of work, getting it running and checking the result.",
      bg: 'Здравей, аз съм Kerrigan, Queen of Blades! Ще ти помагам с планирането на тази работа, пускането ѝ и проверката на резултата.',
    },
    firstMessage: 'phase1-work',
  },
};

function projectOptions(projects: KnownProject[], lang: Lang): string[] {
  return projects.map((p) => {
    const label = p.name || (lang === 'bg' ? 'проектът по подразбиране' : 'the default project');
    return `${label} — \`${p.rootDir}\``;
  });
}

function isChoose(q: Question): q is Choose {
  return 'choose' in q;
}

/**
 * The last line of a message, which is also its "what happens next". Fixed per shape so the
 * operator reads the same instruction for the same kind of message.
 */
function answerLine(questions: Question[], lang: Lang): string {
  const choices = questions.filter(isChoose).length;
  const asks = questions.length - choices;
  // No questions, or one plain question: the last line already says what happens next.
  if (questions.length === 0 || (questions.length === 1 && choices === 0)) return '';
  if (questions.length === 1 && choices === 1) return lang === 'bg' ? 'Отговори с номера.' : 'Answer with the number.';
  if (choices === 0) {
    return lang === 'bg'
      ? 'Отговори под номера на всеки въпрос; където нямате такова, напиши „няма“.'
      : 'Answer under the number of each question; where you have none, write "none".';
  }
  const first = questions.findIndex(isChoose) + 1;
  if (asks === 0) {
    return lang === 'bg'
      ? `Отговори с номерата на избраните опции, например \`${first}.1 ${first + 1}.2\`.`
      : `Answer with the numbers of the options you pick, for example \`${first}.1 ${first + 1}.2\`.`;
  }
  return lang === 'bg'
    ? `Отговори под номера на всеки въпрос: с думи, а където има опции — с номера им, например \`${first}.1\`.`
    : `Answer under the number of each question: in words, and where there are options, with their number, for example \`${first}.1\`.`;
}

/**
 * The phase line a message opens with. The persona messages are shared by two states: inside the
 * full first-run interview they are phase 0 like the rest of it, and on their own — the organisation
 * written, the persona missing — they are the step before phase 1.
 */
export function phaseLineOf(m: ScriptMessage, stages: Stage[], lang: Lang): string {
  const key = m.phase === 'persona' ? (stages.includes('phase0') ? 'p0' : 'beforeP1') : m.phase;
  return PHASE_LINES[key][lang];
}

/** One message as the operator is to see it, as a list of lines without the quotation marks. */
export function renderMessage(m: ScriptMessage, projects: KnownProject[], lang: Lang, stages: Stage[] = m.stages): string[] {
  const lines: string[] = [phaseLineOf(m, stages, lang)];
  // Two plain lines in a row are one paragraph once a chat renders them, so a breakdown's "Sessions"
  // and "Session" lines would run together, and a plain line straight after a list item is read as
  // part of that item. A blank line keeps them apart; only items of one list stay together.
  const isItem = (l: string): boolean => /^(- |\d+\. )/.test(l);
  for (const l of m.lead ?? []) {
    const prev = lines[lines.length - 1];
    if (prev !== undefined && !(isItem(prev) && isItem(l[lang]))) lines.push('');
    lines.push(l[lang]);
  }
  if (m.questions.length) lines.push('');

  // Hints sit under the question they belong to, indented into its list item and in italics, so the
  // operator sees at a glance which lines they can skip. Each is its own paragraph, a blank line
  // before it: an indented line straight under a list item is, to Markdown, the same paragraph, and
  // the first live run showed every "Example:" glued onto the end of its question.
  const hintLines = (q: Question): string[] => (q.hints ?? []).flatMap((h) => ['', `   *${h[lang]}*`]);
  // The options after hints need the same blank line, or they read as part of the last hint.
  const beforeOptions = (q: Question): string[] => (q.hints?.length ? [''] : []);

  const single = m.questions.length === 1 && isChoose(m.questions[0]!);
  m.questions.forEach((q, i) => {
    const n = i + 1;
    if (!isChoose(q)) {
      lines.push(`${n}. ${q.ask[lang]}`, ...hintLines(q));
      return;
    }
    const listed = q.options === 'projects' ? projectOptions(projects, lang) : q.options.map((o) => o[lang]);
    const last = q.options === 'projects' ? OTHER_FOLDER[lang] : q.other === false ? undefined : (q.other ?? OTHER)[lang];
    const options = last ? [...listed, last] : listed;
    if (single) {
      lines.push(q.choose[lang], ...hintLines(q), ...beforeOptions(q));
      options.forEach((o, j) => lines.push(`${j + 1}. ${o}`));
    } else {
      lines.push(`${n}. ${q.choose[lang]}`, ...hintLines(q), ...beforeOptions(q));
      options.forEach((o, j) => lines.push(`   - ${n}.${j + 1} ${o}`));
    }
  });

  const answer = answerLine(m.questions, lang);
  if (answer) lines.push('', answer);
  return lines;
}

/**
 * The script section of the brief, for the stages this state of the brief can reach.
 *
 * Each message is printed under a heading that is for the model — when to send it — and as a
 * quotation that is for the operator, phase line included. The heading carries no number of its
 * own, so nothing in it can be mistaken for the numbering the operator answers with.
 */
export function scriptSection(stages: Stage[], projects: KnownProject[], lang: Lang): string {
  const wanted = SCRIPT.filter((m) => m.stages.some((s) => stages.includes(s)));
  const blocks = wanted.map((m) => {
    const quoted = renderMessage(m, projects, lang, stages).map((l) => (l ? `> ${l}` : '>'));
    return `### ${m.when[lang]}\n\n${quoted.join('\n')}`;
  });

  const head =
    lang === 'bg'
      ? `## Въпросите, дословно

Всяко съобщение, в което питаш оператора нещо, е тук — дословно, в реда, в който идват. **Копирай го
точно:** същите въпроси, в същия ред, със същите номера, същите опции и същите редове *Пример:*. Не
добавяй въпрос, не махай, не сливай, не разделяй, не преформулирай и не пренареждай — операторът учи
разговора, а това става само ако той е един и същ всеки път. Заглавието над цитата е за теб: казва
кога се праща съобщението; операторът вижда само цитираното, без знака \`>\`.

- **Първият ред на всеки цитат е редът за фазата.** Копираш го както е; не го сменяш и не добавяш
  друг.
- **Номерата са само цифри.** Въпросите са 1, 2, 3; опциите под въпрос 2 са 2.1, 2.2, 2.3. Никога
  букви. Съобщение с един-единствен избор номерира опциите си 1, 2, 3.
- **Попълваш само това в {скоби}** — път, име, брой, присъда — и нищо друго не пишеш наново.
  **Съобщение с непопълнени {скоби} не се изпраща никога**: ако не знаеш с какво да ги попълниш,
  значи съобщението не е за сега.
- **Препоръка:** на въпрос с опции, освен на тези за това какво операторът има или знае, може да
  добавиш след една опция *(препоръчвам — причината в няколко думи)*. Само ако имаш причина.
- **Вече казано:** ако отговорът на въпрос вече е даден — в документите на оператора по-горе или
  по-рано в този разговор — въпросът остава на мястото си, а под него, след празен ред и със същия
  отстъп като редовете *Пример:*, пишеш \`${ALREADY_SAID.bg} …\` с отговора — отделен ред, не в края на
  въпроса; на избор отбелязваш опцията с *(вече казано)*. Отговорът е целият, не етикет: за
  заданието — заглавието, целта и контекстът от „Тази работа“, не само заглавието; за критериите —
  всеки от тях. Операторът потвърждава това, което вижда, и не може да потвърди нещо, което не е
  показано. Последният ред
  на цитата тогава е точно един от тези два: когато всеки въпрос е вече казан — *${ON_RECORD_ALL.bg}*
  — а когато само някои — *${ON_RECORD_MIXED.bg}*
- **Около цитата:** преди него — само поздравът, и то само в първото съобщение; след него — нищо: без
  „Очаквам отговорите ти“ и без „Когато си готов…“. Последният ред на цитата вече казва какво следва.
  Съобщенията, които не питат нищо, също започват с реда за фазата си и свършват на последната си
  стъпка. Редът за фаза 2 е \`${PHASE_LINES.p2.bg}\`.
- **Единственото място за твои въпроси** е мъгляв или липсващ отговор във фаза 1: тогава, преди
  настройките, пращаш едно съобщение с уточнения — редът за фазата, само номерирани въпроси, 1, 2, 3,
  с опции 1.1, 1.2, когато отговорите могат да се изброят, и същия последен ред като тук.

Съобщенията, които не питат нищо — JSON-ът, стъпките в приложението, диагнозата, таблицата с
доказателствата — следват описанието във фазата си.`
      : `## The questions, word for word

Every message in which you ask the operator something is here — word for word, in the order they
come. **Copy it exactly:** the same questions, in the same order, with the same numbers, the same
options and the same *Example:* lines. Do not add a question, drop one, merge, split, reword or
reorder — the operator learns the conversation, and that only works if it is the same every time. The
heading above each quotation is for you: it says when the message is sent; the operator sees only
what is quoted, without the \`>\`.

- **The first line of every quotation is the phase line.** Copy it as it is; do not change it and do
  not add another.
- **Numbers are digits only.** Questions are 1, 2, 3; the options under question 2 are 2.1, 2.2, 2.3.
  Never letters. A message with one single choice numbers its options 1, 2, 3.
- **You fill in only what is in {braces}** — a path, a name, a count, a verdict — and write nothing
  else afresh. **A message with unfilled {braces} is never sent**: if you do not know what goes in
  them, the message is not for now.
- **Recommending:** on a question with options, except those about what the operator has or knows,
  you may add after one option *(recommended — the reason in a few words)*. Only when you have one.
- **Already said:** if a question has already been answered — in the operator's documents above or
  earlier in this conversation — the question stays where it is and, under it, after a blank line
  and indented like the *Example:* lines, you write \`${ALREADY_SAID.en} …\` with the answer — a line
  of its own, not the end of the question; on a choice you mark the option *(already said)*. The
  answer is the whole of it, not a label: for the assignment, the title, the goal and the context from
  "This work", not the title alone; for the criteria, every one of them. The operator confirms what
  they see, and cannot confirm what is not shown.
  The last line of the quotation is then exactly one of these two: when every question is already
  answered — *${ON_RECORD_ALL.en}* — and when only some are — *${ON_RECORD_MIXED.en}*
- **Around the quotation:** before it, only the greeting, and only in the first message; after it,
  nothing: no "I look forward to your answers", no "When you are ready…". The quotation's last line
  already says what happens next. Messages that ask nothing also open with their phase line and end
  on their last step. The phase 2 line is \`${PHASE_LINES.p2.en}\`.
- **The one place for questions of your own** is a vague or missing answer in phase 1: then, before
  the settings, you send one message of follow-ups — the phase line, numbered questions only, 1, 2,
  3, with options 1.1, 1.2 where the answers can be listed, and the same last line as here.

Messages that ask nothing — the JSON, the steps in the app, the diagnosis, the table of evidence —
follow the description in their phase.`;

  return `
${head}

${blocks.join('\n\n')}
`;
}
