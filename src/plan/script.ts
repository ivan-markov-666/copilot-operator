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

/** A question answered in the operator's own words: a fact nobody here knows yet. */
type Ask = { ask: Text };

/**
 * A question answered by picking. `other` is the last option, *something else — say what*, unless
 * the choice is closed (the persona question, the approval of a breakdown). `recommend` says whether
 * the model may mark one option *(recommended)*: never on a question about what the operator has or
 * knows, which is a fact about them and not a thing to advise on.
 */
type Choose = {
  choose: Text;
  options: Text[] | 'projects';
  other?: false;
  recommend?: false;
};

type Question = Ask | Choose;

/**
 * Where in the conversation a message belongs. `phase0` is the full first-run interview, `persona`
 * the step that asks only for the persona, and the rest are every conversation's.
 */
export type Stage = 'phase0' | 'persona' | 'phase1' | 'record' | 'phase4';

export type ScriptMessage = {
  id: string;
  stages: Stage[];
  /** For the model, not the operator: when this message is sent. Printed as the heading above it. */
  when: Text;
  /** Fixed lines before the questions — a validation, a breakdown, a verdict — with {braces} to fill. */
  lead?: Text[];
  questions: Question[];
};

const OTHER: Text = { en: 'something else — say what', bg: 'друго — напиши какво' };
const OTHER_FOLDER: Text = { en: 'another folder — give its absolute path', bg: 'друга папка — напиши абсолютния ѝ път' };

export const SCRIPT: ScriptMessage[] = [
  {
    id: 'org-work',
    stages: ['phase0'],
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
    when: {
      en: 'Phase 0: one message for each project picked in the first message, with its path in {path}',
      bg: 'Фаза 0: по едно съобщение за всеки проект, избран в първото съобщение, с пътя му в {път}',
    },
    lead: [{ en: 'Project `{path}`:', bg: 'Проект `{път}`:' }],
    questions: [
      { ask: { en: 'What does this project do, in one sentence?', bg: 'Какво прави този проект, с едно изречение?' } },
      { ask: { en: 'Which folders in it matter, and what is in them?', bg: 'Кои папки в него имат значение и какво има в тях?' } },
      {
        ask: {
          en: 'What must be installed, running or set before it builds?',
          bg: 'Какво трябва да е инсталирано, пуснато или зададено, преди да се строи?',
        },
      },
      { ask: { en: 'Which commands build, start and test it?', bg: 'С кои команди се строи, пуска и тества?' } },
      {
        ask: {
          en: 'What goes wrong here that is not obvious from the code, and what do you do then?',
          bg: 'Какво се чупи тук, без да личи от кода, и какво се прави тогава?',
        },
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
        choose: { en: 'May the runner make branches and commits here?', bg: 'Може ли runner-ът да прави клонове и комити тук?' },
        options: [
          { en: 'Yes', bg: 'Да' },
          { en: 'No — files change in place, with no git', bg: 'Не — файловете се променят на място, без git' },
        ],
        recommend: false,
      },
    ],
  },
  {
    id: 'org-conventions',
    stages: ['phase0'],
    when: { en: 'Phase 0: the conventions', bg: 'Фаза 0: правилата' },
    questions: [
      { ask: { en: 'How are branches named? Give an example.', bg: 'Как се именуват клоновете? Дай пример.' } },
      { ask: { en: 'What is the commit message style? Give an example.', bg: 'Какъв е стилът на комит съобщенията? Дай пример.' } },
      {
        ask: {
          en: 'How is a pull request made, who reviews it, and what must be green?',
          bg: 'Как се прави pull request, кой го преглежда и какво трябва да е зелено?',
        },
      },
      {
        ask: {
          en: 'Which command runs the tests, and is there a coverage rule?',
          bg: 'С коя команда се пускат тестовете и има ли правило за покритие?',
        },
      },
      {
        ask: {
          en: 'What are the coding standards: language version, linter, formatter?',
          bg: 'Какви са стандартите за код: версия на езика, линтер, форматер?',
        },
      },
      { ask: { en: 'How are files and folders named?', bg: 'Как се именуват файловете и папките?' } },
      {
        ask: {
          en: 'Which templates and scaffolds must be used, and where are they?',
          bg: 'Кои шаблони и скелети трябва да се ползват и къде са?',
        },
      },
      {
        ask: {
          en: 'When is a piece of work considered finished (definition of done)?',
          bg: 'Кога една работа се смята за завършена (definition of done)?',
        },
      },
    ],
  },
  {
    id: 'org-people',
    stages: ['phase0'],
    when: { en: 'Phase 0: people and limits', bg: 'Фаза 0: хората и границите' },
    questions: [
      {
        ask: {
          en: "Which changes need somebody's agreement before they are made, and whose?",
          bg: 'Кои промени искат нечие съгласие, преди да се направят, и чие?',
        },
      },
      { ask: { en: 'Who signs off finished work?', bg: 'Кой одобрява завършената работа?' } },
      { ask: { en: 'What must the bot never touch?', bg: 'Какво ботът никога не бива да пипа?' } },
    ],
  },
  {
    id: 'persona-ask',
    stages: ['phase0', 'persona'],
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
    when: {
      en: 'The persona, answer 2, first message: responsibilities and approach',
      bg: 'Персоната, отговор 2, първо съобщение: отговорностите и подходът',
    },
    questions: [
      { ask: { en: 'What is the agent responsible for in this work?', bg: 'За какво отговаря агентът в тази работа?' } },
      {
        ask: {
          en: 'What is it not responsible for — what must it leave to somebody else?',
          bg: 'За какво не отговаря — какво трябва да остави на някой друг?',
        },
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
        ask: {
          en: 'When does it stop and report rather than guess?',
          bg: 'Кога спира и докладва, вместо да гадае?',
        },
      },
    ],
  },
  {
    id: 'persona-build-phases',
    stages: ['phase0', 'persona'],
    when: {
      en: 'The persona, answer 2, second message: phases and result',
      bg: 'Персоната, отговор 2, второ съобщение: фазите и резултатът',
    },
    questions: [
      {
        ask: {
          en: 'Which stages does it work through? For each: what happens in it, and what shows it is done.',
          bg: 'През какви етапи минава? За всеки: какво става в него и какво показва, че е свършен.',
        },
      },
      { ask: { en: 'What does it hand back at the end, and in what form?', bg: 'Какво предава накрая и в какъв вид?' } },
      { ask: { en: 'What will the result be judged by?', bg: 'По какво ще се съди резултатът?' } },
    ],
  },
  {
    id: 'work',
    stages: ['phase0'],
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
          en: 'What must not change while this work is going on?',
          bg: 'Какво не бива да се променя, докато тече тази работа?',
        },
      },
      { ask: { en: 'What is still open, and who decides it?', bg: 'Какво още е отворено и кой го решава?' } },
    ],
  },
  {
    id: 'phase1-work',
    stages: ['phase1'],
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
      { ask: { en: 'What must not be touched?', bg: 'Какво не бива да се пипа?' } },
    ],
  },
  {
    id: 'phase1-settings',
    stages: ['phase1'],
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
    when: {
      en: 'Phase 1, the last message: the breakdown, in prose, and nothing written yet',
      bg: 'Фаза 1, последното съобщение: разбивката с думи, още без JSON',
    },
    lead: [
      { en: 'Sessions: {count}. Tasks: {count}.', bg: 'Сесии: {брой}. Задачи: {брой}.' },
      { en: 'Session `{name}`: {goal}', bg: 'Сесия `{име}`: {цел}' },
      { en: '- Task `{title}`: {what it does}. Checks: {which}.', bg: '- Задача `{заглавие}`: {какво прави}. Проверки: {какви}.' },
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
  {
    id: 'record',
    stages: ['record'],
    when: {
      en: 'Phase 3 and phase 4: asking for the record of the tasks you still need, named in {tasks}',
      bg: 'Фаза 3 и фаза 4: искане на записа на задачите, които още ти трябват, назовани в {задачите}',
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
  },
  {
    id: 'phase4-proven',
    stages: ['phase4'],
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

/** One message as the operator is to see it, as a list of lines without the quotation marks. */
export function renderMessage(m: ScriptMessage, projects: KnownProject[], lang: Lang): string[] {
  const lines: string[] = [];
  // Two plain lines in a row are one paragraph once a chat renders them, so a breakdown's "Sessions"
  // and "Session" lines would run together, and a plain line straight after a list item is read as
  // part of that item. A blank line keeps them apart; only items of one list stay together.
  const isItem = (l: string): boolean => /^(- |\d+\. )/.test(l);
  for (const l of m.lead ?? []) {
    const prev = lines[lines.length - 1];
    if (prev !== undefined && !(isItem(prev) && isItem(l[lang]))) lines.push('');
    lines.push(l[lang]);
  }
  if (m.lead?.length && m.questions.length) lines.push('');

  const single = m.questions.length === 1 && isChoose(m.questions[0]!);
  m.questions.forEach((q, i) => {
    const n = i + 1;
    if (!isChoose(q)) {
      lines.push(`${n}. ${q.ask[lang]}`);
      return;
    }
    const listed = q.options === 'projects' ? projectOptions(projects, lang) : q.options.map((o) => o[lang]);
    const last = q.options === 'projects' ? OTHER_FOLDER[lang] : q.other === false ? undefined : OTHER[lang];
    const options = last ? [...listed, last] : listed;
    if (single) {
      lines.push(q.choose[lang]);
      options.forEach((o, j) => lines.push(`${j + 1}. ${o}`));
    } else {
      lines.push(`${n}. ${q.choose[lang]}`);
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
 * quotation that is for the operator. The heading carries no number of its own, so nothing in it can
 * be mistaken for the numbering the operator answers with.
 */
export function scriptSection(stages: Stage[], projects: KnownProject[], lang: Lang): string {
  const wanted = SCRIPT.filter((m) => m.stages.some((s) => stages.includes(s)));
  const blocks = wanted.map((m) => {
    const quoted = renderMessage(m, projects, lang).map((l) => (l ? `> ${l}` : '>'));
    return `### ${m.when[lang]}\n\n${quoted.join('\n')}`;
  });

  const head =
    lang === 'bg'
      ? `## Въпросите, дословно

Всяко съобщение, в което питаш оператора нещо, е тук — дословно, в реда, в който идват. **Копирай го
точно:** същите въпроси, в същия ред, със същите номера и същите опции. Не добавяй въпрос, не махай, не
сливай, не разделяй, не преформулирай и не пренареждай — операторът учи разговора, а това става само
ако той е един и същ всеки път. Заглавието над цитата е за теб: казва кога се праща съобщението;
операторът вижда само цитираното, без знака \`>\`.

- **Номерата са само цифри.** Въпросите са 1, 2, 3; опциите под въпрос 2 са 2.1, 2.2, 2.3. Никога
  букви. Съобщение с един-единствен избор номерира опциите си 1, 2, 3.
- **Попълваш само това в {скоби}** — път, име, брой, присъда — и нищо друго не пишеш наново.
- **Препоръка:** на въпрос с опции, освен на тези за това какво операторът има или знае, може да
  добавиш след една опция *(препоръчвам — причината в няколко думи)*. Само ако имаш причина.
- **Вече известно:** ако отговорът на въпрос вече е в документите на оператора по-горе, въпросът
  остава на мястото си, а под него пишеш \`Записано: …\`; на избор отбелязваш опцията с *(записано)*.
  Операторът отговаря само ако иска да го промени.
- **Около цитата:** преди него — поздравът (само в първото съобщение) и редът за фазата; след него —
  нищо. Последният му ред е това какво следва.
- **Единственото място за твои въпроси** е мъгляв или липсващ отговор във фаза 1: тогава, преди
  настройките, пращаш едно съобщение с уточнения — само номерирани въпроси, 1, 2, 3, с опции 1.1, 1.2,
  когато отговорите могат да се изброят, и същия последен ред като тук.

Съобщенията, които не питат нищо — JSON-ът, стъпките в приложението, диагнозата, таблицата с
доказателствата — следват описанието във фазата си.`
      : `## The questions, word for word

Every message in which you ask the operator something is here — word for word, in the order they
come. **Copy it exactly:** the same questions, in the same order, with the same numbers and the same
options. Do not add a question, drop one, merge, split, reword or reorder — the operator learns the
conversation, and that only works if it is the same every time. The heading above each quotation is
for you: it says when the message is sent; the operator sees only what is quoted, without the \`>\`.

- **Numbers are digits only.** Questions are 1, 2, 3; the options under question 2 are 2.1, 2.2, 2.3.
  Never letters. A message with one single choice numbers its options 1, 2, 3.
- **You fill in only what is in {braces}** — a path, a name, a count, a verdict — and write nothing
  else afresh.
- **Recommending:** on a question with options, except those about what the operator has or knows,
  you may add after one option *(recommended — the reason in a few words)*. Only when you have one.
- **Already known:** if the answer to a question is already in the operator's documents above, the
  question stays where it is and you write \`On record: …\` under it; on a choice you mark the option
  *(on record)*. The operator answers only to change it.
- **Around the quotation:** before it, the greeting (first message only) and the phase line; after
  it, nothing. Its last line is what happens next.
- **The one place for questions of your own** is a vague or missing answer in phase 1: then, before
  the settings, you send one message of follow-ups — numbered questions only, 1, 2, 3, with options
  1.1, 1.2 where the answers can be listed, and the same last line as here.

Messages that ask nothing — the JSON, the steps in the app, the diagnosis, the table of evidence —
follow the description in their phase.`;

  return `
${head}

${blocks.join('\n\n')}
`;
}
