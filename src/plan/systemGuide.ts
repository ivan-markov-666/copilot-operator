/**
 * What this application's screens are called, written down once so the persona can quote them.
 *
 * Kerrigan plans the work, walks the operator through running it and validates what came back,
 * and it does all of that blind: it is a conversation in somebody else's chat window, with no
 * view of the browser the operator is looking at. Left to itself it speaks in generalities —
 * "open the import page and paste the plan there" — and the operator has to translate that into
 * the button in front of them. This module removes the translation step. It records, screen by
 * screen, the exact words printed on every control the operator is ever told to press or read,
 * in both languages the interface speaks, with one sentence saying what each of them does. The
 * brief embeds the rendered form of it, so the persona can say press "Create the sessions and
 * tasks" and be quoting the screen rather than describing it.
 *
 * The labels are duplicated here rather than imported, and that is deliberate. `src/` is the
 * Node ESM server build; `web/lib/strings.ts` is a browser module inside the Next workspace,
 * and this file has to stay importable by the API with no bundler in the way. Duplication of
 * this kind normally rots, so it is pinned instead of trusted: `test/guide.check.ts` holds
 * every label below against that dictionary, key by key, in English and in Bulgarian, and
 * fails the moment the two disagree. A label renamed in the interface therefore breaks a check
 * that names the key, which is how whoever renamed it learns that the persona's script has to
 * follow.
 *
 * The guide is read by a language model inside a prompt that is already long, so it is a
 * selection and not an inventory: the controls an operator is actually told to press, the
 * badges they are told to read back, and nothing else. Add to it when a new control is one the
 * persona would name — and when adding one, take the label from `web/lib/strings.ts` character
 * for character, because the check is unforgiving about it.
 */

/** The shape of a control, in the words a person would use for it rather than the HTML element. */
export type ControlKind =
  | 'button'
  | 'link'
  | 'field'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'tab'
  | 'badge'
  | 'disclosure'
  | 'note';

export type GuideControl = {
  /** The key in `dict`, which is what the check holds the two labels against. */
  key: string;
  kind: ControlKind;
  /** The label exactly as `dict.en[key]` reads. */
  en: string;
  /** The label exactly as `dict.bg[key]` reads. */
  bg: string;
  doesEn: string;
  doesBg: string;
};

export type GuideSection = {
  /**
   * The key of the heading printed above this group. Null where the screen genuinely has no
   * heading there — the strip of buttons beside a session's name, for instance — in which case
   * `en` and `bg` are a plain description and the check has nothing to pin.
   */
  headingKey: string | null;
  en: string;
  bg: string;
  controls: GuideControl[];
};

export type GuideScreen = {
  /** The route as the address bar shows it, which is how the operator is told where to go. */
  route: string;
  nameEn: string;
  nameBg: string;
  purposeEn: string;
  purposeBg: string;
  sections: GuideSection[];
};

/**
 * The screens in the order the operator meets them: the navigation that reaches everything,
 * then the import page that hands out the brief, the sessions list, one session, the register
 * where a run is watched and continued, and last the pages that are set once and left alone.
 */
export const SYSTEM_GUIDE: readonly GuideScreen[] = [
  {
    route: 'every page',
    nameEn: 'The header and the navigation',
    nameBg: 'Заглавната лента и навигацията',
    purposeEn:
      'The links down the side of every page, the language switch, and the two buttons of the box that asks before anything irreversible.',
    purposeBg:
      'Връзките отстрани на всяка страница, смяната на езика и двата бутона на прозореца, който пита преди нещо необратимо.',
    sections: [
      {
        headingKey: 'nav.label',
        en: 'Main',
        bg: 'Основно',
        controls: [
          {
            key: 'nav.sessions',
            kind: 'link',
            en: 'Sessions',
            bg: 'Сесии',
            doesEn: 'Opens the sessions list at /, where sessions are created and a run is started.',
            doesBg: 'Отваря списъка със сесии на /, откъдето се създават сесии и се пуска изпълнение.',
          },
          {
            key: 'nav.import',
            kind: 'link',
            en: 'Plan from JSON',
            bg: 'План от JSON',
            doesEn: 'Opens the page that hands out the brief and turns the JSON back into sessions and tasks.',
            doesBg: 'Отваря страницата, която дава заданието и превръща JSON-а обратно в сесии и задачи.',
          },
          {
            key: 'nav.history',
            kind: 'link',
            en: 'Task register',
            bg: 'Регистър на задачите',
            doesEn: 'Opens the register of every task, where a run is watched and continued.',
            doesBg: 'Отваря регистъра на всички задачи, откъдето се следи и продължава едно изпълнение.',
          },
          {
            key: 'nav.defaults',
            kind: 'link',
            en: 'Settings',
            bg: 'Настройки',
            doesEn: 'Opens what every new session starts with: the project folders and the two models.',
            doesBg: 'Отваря това, с което тръгва всяка нова сесия: папките на проектите и двата модела.',
          },
          {
            key: 'nav.level1',
            kind: 'link',
            en: 'Level 1 prompt',
            bg: 'Основен prompt',
            doesEn: 'Opens the base prompt sent once at the start of every conversation.',
            doesBg: 'Отваря основния prompt, изпращан веднъж в началото на всеки разговор.',
          },
          {
            key: 'nav.presets',
            kind: 'link',
            en: 'Level 2 presets',
            bg: 'Шаблони ниво 2',
            doesEn: 'Opens the saved level 2 instruction blocks that a task can be given.',
            doesBg: 'Отваря запазените блокове с инструкции от ниво 2, които може да се дадат на задача.',
          },
          {
            key: 'nav.appearance',
            kind: 'link',
            en: 'Appearance',
            bg: 'Изглед',
            doesEn: 'Opens the theme, text size and accessibility options for this browser only.',
            doesBg: 'Отваря темата, размера на текста и настройките за достъпност само за този браузър.',
          },
          {
            key: 'nav.system',
            kind: 'link',
            en: 'System',
            bg: 'Система',
            doesEn: "Opens the read-only report on this machine: Node, Edge and the bot's browser profile.",
            doesBg: 'Отваря отчета за тази машина, само за четене: Node, Edge и профилът на браузъра на бота.',
          },
          {
            key: 'lang.label',
            kind: 'select',
            en: 'Language',
            bg: 'Език',
            doesEn: 'Switches the whole interface, and the brief it hands out, between English and Bulgarian.',
            doesBg: 'Превключва целия интерфейс и заданието, което дава, между английски и български.',
          },
        ],
      },
      {
        headingKey: 'dialog.confirmTitle',
        en: 'Are you sure?',
        bg: 'Сигурни ли сте?',
        controls: [
          {
            key: 'dialog.ok',
            kind: 'button',
            en: 'OK',
            bg: 'Добре',
            doesEn: 'Confirms the question and lets the action that asked it go ahead.',
            doesBg: 'Потвърждава въпроса и пуска действието, което го е задало.',
          },
          {
            key: 'dialog.cancel',
            kind: 'button',
            en: 'Cancel',
            bg: 'Отказ',
            doesEn: 'Closes the question and does nothing; the action is abandoned.',
            doesBg: 'Затваря въпроса и не прави нищо; действието се отказва.',
          },
        ],
      },
    ],
  },

  {
    route: '/import',
    nameEn: 'Plan from JSON',
    nameBg: 'План от JSON',
    purposeEn:
      'Where the brief is copied out to a chat and the JSON it writes is brought back, checked and turned into sessions and tasks. Nothing is started from here.',
    purposeBg:
      'Оттук се копира заданието към чата и тук се връща JSON-ът, който той е написал: проверява се и става сесии и задачи. Нищо не се стартира от тази страница.',
    sections: [
      {
        headingKey: 'plan.step1',
        en: '1. Take this to the chat',
        bg: '1. Занесете това в чата',
        controls: [
          {
            key: 'plan.copyBrief',
            kind: 'button',
            en: 'Copy the brief',
            bg: 'Копирай заданието',
            doesEn: 'Puts the whole brief on the clipboard; paste it into a fresh chat conversation.',
            doesBg: 'Слага цялото задание в клипборда; поставете го в нов разговор с чат модел.',
          },
          {
            key: 'plan.softwarePart',
            kind: 'disclosure',
            en: 'Software level (fixed)',
            bg: 'Софтуерно ниво (фиксирано)',
            doesEn: 'Unfolds the fixed part of the brief, the part that belongs to this project; read-only.',
            doesBg: 'Разгъва фиксираната част на заданието — тази на самия проект; само за четене.',
          },
          {
            key: 'plan.briefLang',
            kind: 'note',
            en: 'The brief is in the language this interface is in.',
            bg: 'Заданието е на езика, на който е този интерфейс.',
            doesEn: 'Switch the language in the header first if the brief should come out in the other one.',
            doesBg: 'Ако заданието трябва да излезе на другия език, първо сменете езика в заглавната лента.',
          },
        ],
      },
      {
        headingKey: 'plan.orgPart',
        en: 'The organisation and the projects',
        bg: 'Организацията и проектите',
        controls: [
          {
            key: 'plan.ctxEmpty',
            kind: 'badge',
            en: 'empty — Kerrigan will ask',
            bg: 'празно — Kerrigan ще пита',
            doesEn: 'Beside the heading while the box is blank: the brief will interview the operator about it.',
            doesBg: 'До заглавието, докато полето е празно: заданието ще разпита оператора за него.',
          },
          {
            key: 'plan.ctxWritten',
            kind: 'badge',
            en: 'written',
            bg: 'написано',
            doesEn: 'Beside the heading once something is saved: every copy of the brief carries it and the questions stop.',
            doesBg: 'До заглавието, щом има запазен текст: всяко копие на заданието го носи и въпросите спират.',
          },
          {
            key: 'plan.ctxClear',
            kind: 'button',
            en: 'Empty this',
            bg: 'Изпразни',
            doesEn: 'Wipes the saved text after one confirmation, so the brief asks about it again.',
            doesBg: 'Изтрива запазения текст след едно потвърждение, за да пита заданието пак за него.',
          },
          {
            key: 'def.savedAutomatically',
            kind: 'note',
            en: 'saved as you type',
            bg: 'запазва се, докато пишете',
            doesEn: 'The box writes itself; there is no save button to look for.',
            doesBg: 'Полето се запазва само; няма бутон за запазване, който да търсите.',
          },
        ],
      },
      {
        headingKey: 'plan.workPart',
        en: 'This work',
        bg: 'Тази работа',
        controls: [
          {
            key: 'plan.ctxClear',
            kind: 'button',
            en: 'Empty this',
            bg: 'Изпразни',
            doesEn: 'The same button under the second box: wipes the description of the work in hand.',
            doesBg: 'Същият бутон под второто поле: изтрива описанието на текущата работа.',
          },
        ],
      },
      {
        headingKey: 'plan.step2',
        en: '2. Bring the answer back',
        bg: '2. Върнете отговора тук',
        controls: [
          {
            key: 'plan.placeholder',
            kind: 'field',
            en: 'Paste the JSON the chat model wrote…',
            bg: 'Поставете JSON-а, който чат моделът е написал…',
            doesEn: 'The large box. Prose and code fences around the JSON are stripped, so paste the reply whole.',
            doesBg: 'Голямото поле. Текстът и ограждащите блокове около JSON-а се махат, така че поставете отговора цял.',
          },
          {
            key: 'plan.browse',
            kind: 'button',
            en: 'Choose a file…',
            bg: 'Изберете файл…',
            doesEn: 'Reads a .json or text file into that box instead of pasting.',
            doesBg: 'Прочита .json или текстов файл в полето, вместо да поставяте текст.',
          },
          {
            key: 'plan.check',
            kind: 'button',
            en: 'Check it',
            bg: 'Провери',
            doesEn: 'Validates the JSON and creates nothing: it reports either the errors or what would be created.',
            doesBg: 'Проверява JSON-а, без да създава нищо: показва или грешките, или какво би било създадено.',
          },
          {
            key: 'plan.import',
            kind: 'button',
            en: 'Create the sessions and tasks',
            bg: 'Създай сесиите и задачите',
            doesEn: 'Creates the sessions and their tasks. Nothing is started, and the box is emptied afterwards.',
            doesBg: 'Създава сесиите и задачите им. Нищо не се стартира, а полето се изпразва накрая.',
          },
          {
            key: 'plan.clear',
            kind: 'button',
            en: 'Clear',
            bg: 'Изчисти',
            doesEn: 'Empties the box and drops the check result, without creating or deleting anything.',
            doesBg: 'Изпразва полето и маха резултата от проверката, без да създава или изтрива нищо.',
          },
        ],
      },
      {
        headingKey: 'plan.issues',
        en: 'What is wrong',
        bg: 'Какво не е наред',
        controls: [
          {
            key: 'plan.copyIssues',
            kind: 'button',
            en: 'Copy the errors',
            bg: 'Копирай грешките',
            doesEn: 'Copies every error with the path of the field it is about, to paste back into the same conversation.',
            doesBg: 'Копира всяка грешка с пътя до полето, за което е, за да я върнете в същия разговор.',
          },
        ],
      },
      {
        headingKey: 'plan.preview',
        en: 'What will be created',
        bg: 'Какво ще бъде създадено',
        controls: [
          {
            key: 'plan.valid',
            kind: 'note',
            en: 'This is a plan this system can read: {sessions} session(s), {tasks} task(s).',
            bg: 'Това е план, който системата разбира: {sessions} сесия(и), {tasks} задача(и).',
            doesEn: 'The line that says the check passed, with the table of sessions and tasks below it.',
            doesBg: 'Редът, който казва, че проверката е минала, с таблицата на сесиите и задачите отдолу.',
          },
        ],
      },
      {
        headingKey: 'plan.step3',
        en: '3. Check it, then start it yourself',
        bg: '3. Прегледайте и стартирайте сами',
        controls: [
          {
            key: 'plan.runThese',
            kind: 'button',
            en: 'Run these sessions',
            bg: 'Пусни тези сесии',
            doesEn: 'Opens the sessions list with exactly the new sessions ticked; the run still has to be started there.',
            doesBg: 'Отваря списъка със сесии с отметнати точно новите; пускането пак се стартира оттам.',
          },
          {
            key: 'plan.toSessions',
            kind: 'button',
            en: 'To the sessions list',
            bg: 'Към списъка със сесии',
            doesEn: 'Opens the sessions list with nothing ticked.',
            doesBg: 'Отваря списъка със сесии, без нищо отметнато.',
          },
        ],
      },
    ],
  },

  {
    route: '/',
    nameEn: 'Sessions',
    nameBg: 'Сесии',
    purposeEn:
      'The list of every session on this machine: where one is created, where several are ticked and started one after another, and where a stopped step waits for a decision.',
    purposeBg:
      'Списъкът с всички сесии на машината: тук се създава сесия, тук се отмятат няколко и тръгват една след друга, и тук спряна стъпка чака решение.',
    sections: [
      {
        headingKey: 'home.new',
        en: 'New session',
        bg: 'Нова сесия',
        controls: [
          {
            key: 'home.namePlaceholder',
            kind: 'field',
            en: 'Session name, e.g. payments-service',
            bg: 'Име на сесията, напр. payments-service',
            doesEn: 'The name of the session to create; Enter creates it just as the button does.',
            doesBg: 'Името на сесията, която ще се създаде; Enter я създава също като бутона.',
          },
          {
            key: 'home.create',
            kind: 'button',
            en: 'Create',
            bg: 'Създай',
            doesEn: 'Creates the session under that name and opens its own page.',
            doesBg: 'Създава сесията с това име и отваря нейната страница.',
          },
        ],
      },
      {
        headingKey: 'batch.title',
        en: 'Run several sessions',
        bg: 'Пускане на няколко сесии',
        controls: [
          {
            key: 'batch.selectQueued',
            kind: 'button',
            en: 'Select every session with something queued',
            bg: 'Избери всички сесии с нещо в опашката',
            doesEn: 'Ticks every session that still has a queued task, oldest first, replacing whatever was ticked.',
            doesBg: 'Отмята всяка сесия с чакаща задача, от най-старата нататък, и заменя досегашния избор.',
          },
          {
            key: 'batch.runName',
            kind: 'field',
            en: 'Name of this run',
            bg: 'Име на това пускане',
            doesEn: 'Names the run: the register groups its tasks under this name and the exports are named after it.',
            doesBg: 'Дава име на пускането: под него регистърът групира задачите му и по него се именуват изтеглянията.',
          },
          {
            key: 'batch.model',
            kind: 'select',
            en: 'Model for this run',
            bg: 'Модел за това изпълнение',
            doesEn: 'The Copilot model this run works on; the choice is written onto every ticked session before it starts.',
            doesBg: 'Моделът на Copilot за това пускане; изборът се записва върху всяка отметната сесия преди старта.',
          },
          {
            key: 'batch.reviewModel',
            kind: 'select',
            en: 'Model that reviews the work',
            bg: 'Модел, който проверява работата',
            doesEn: 'The model that reviews each task afterwards, chosen separately from the one doing the work.',
            doesBg: 'Моделът, който проверява всяка задача после, избран отделно от този, който върши работата.',
          },
          {
            key: 'batch.run',
            kind: 'button',
            en: 'Run {n} session(s)',
            bg: 'Пусни {n} сесия(и)',
            doesEn: 'Starts the ticked sessions one after another and runs every command without asking; it confirms once first.',
            doesBg: 'Пуска отметнатите сесии една след друга и изпълнява всяка команда без питане; първо иска едно потвърждение.',
          },
          {
            key: 'batch.runStep',
            kind: 'button',
            en: 'Step by step',
            bg: 'Стъпка по стъпка',
            doesEn: 'Starts the same sessions but stops before every command and waits for a decision.',
            doesBg: 'Пуска същите сесии, но спира преди всяка команда и чака решение.',
          },
          {
            key: 'batch.stop',
            kind: 'button',
            en: 'Stop after the current step',
            bg: 'Спри след текущата стъпка',
            doesEn: 'Shown while a run is going: ends it once the step in progress finishes. The task it interrupts ends "not done", part-done — say so, and offer the pause instead when the operator only wants to think.',
            doesBg: 'Показва се по време на пускане: спира го след текущата стъпка. Задачата, която прекъсва, завършва „неизпълнена“, наполовина — кажи го и предложи паузата, ако операторът само иска да помисли.',
          },
          {
            key: 'batch.pause',
            kind: 'button',
            en: 'Pause after this task',
            bg: 'Пауза след тази задача',
            doesEn: 'Holds the run without losing anything: the task that is running finishes properly — its checks, its review, its commit — and the rest stays queued. This is what to press after a failure, before deciding anything.',
            doesBg: 'Спира пускането, без да се губи нищо: задачата, която върви, приключва както трябва — проверките ѝ, рецензията ѝ, комитът ѝ — а останалото си стои в опашката. Това се натиска след провал, преди каквото и да е решение.',
          },
          {
            key: 'batch.resume',
            kind: 'button',
            en: 'Take the hold off',
            bg: 'Махни паузата',
            doesEn: 'Replaces the pause button once it is pressed. Carries on with the queue, if the paused task is still running.',
            doesBg: 'Заменя бутона за пауза, след като е натиснат. Продължава с опашката, ако паузираната задача още върви.',
          },
          {
            key: 'batch.debug',
            kind: 'link',
            en: 'Download everything as JSON',
            bg: 'Изтегли всичко като JSON',
            doesEn: 'One JSON file with every step, exit code, summary, review and commit of those sessions.',
            doesBg: 'Един JSON файл с всяка стъпка, код на изход, обяснение, рецензия и комит на тези сесии.',
          },
          {
            key: 'batch.finished',
            kind: 'note',
            en: 'Finished: {done} done, {failed} failed, {skipped} not run.',
            bg: 'Приключи: {done} успешни, {failed} провалени, {skipped} неизпълнени.',
            doesEn: 'The line that appears when a run ends; it is the first thing to read back after one.',
            doesBg: 'Редът, който се появява в края на пускането; той се чете пръв след него.',
          },
        ],
      },
      {
        headingKey: 'batch.onFailure',
        en: 'If a session fails',
        bg: 'Ако сесия се провали',
        controls: [
          {
            key: 'batch.chain',
            kind: 'radio',
            en: 'Stop, and leave the rest as they are',
            bg: 'Спри и остави останалите както са',
            doesEn: 'A failed session stops the run; the sessions queued after it are never started.',
            doesBg: 'Провалена сесия спира пускането; сесиите след нея изобщо не тръгват.',
          },
          {
            key: 'batch.independent',
            kind: 'radio',
            en: 'Carry on with the next session',
            bg: 'Продължи със следващата сесия',
            doesEn: 'The run goes on to the next session even after one fails.',
            doesBg: 'Пускането продължава със следващата сесия дори след провал.',
          },
        ],
      },
      {
        headingKey: 'approval.waitingHere',
        en: 'A step is waiting for your decision',
        bg: 'Стъпка чака вашето решение',
        controls: [
          {
            key: 'approval.run',
            kind: 'button',
            en: 'Run',
            bg: 'Изпълни',
            doesEn: 'Runs that one command now and lets the task carry on to its next step.',
            doesBg: 'Изпълнява точно тази команда сега и пуска задачата към следващата ѝ стъпка.',
          },
          {
            key: 'approval.runAll',
            kind: 'button',
            en: 'Run this and the rest without asking',
            bg: 'Изпълни без да питаш повече',
            doesEn: 'Runs it and stops asking about every command after it until this run ends.',
            doesBg: 'Изпълнява я и спира да пита за следващите команди до края на това пускане.',
          },
          {
            key: 'approval.skip',
            kind: 'button',
            en: 'Skip',
            bg: 'Пропусни',
            doesEn: 'Leaves that command unrun and moves the task on to its next step.',
            doesBg: 'Оставя командата неизпълнена и мести задачата към следващата ѝ стъпка.',
          },
          {
            key: 'approval.abort',
            kind: 'button',
            en: 'Abort task',
            bg: 'Прекрати задачата',
            doesEn: 'Ends the whole task here; its remaining steps are not run.',
            doesBg: 'Прекратява цялата задача тук; останалите ѝ стъпки не се изпълняват.',
          },
        ],
      },
      {
        headingKey: 'home.sessions',
        en: 'Sessions',
        bg: 'Сесии',
        controls: [
          {
            key: 'home.tickForBoth',
            kind: 'note',
            en: 'The ticks choose what to run and what to delete. Only sessions with something queued can be run.',
            bg: 'Отметките избират какво да се пусне и какво да се изтрие. Пускат се само сесии с нещо в опашката.',
            doesEn: 'One set of tick boxes serves both the run panel above and the delete button here.',
            doesBg: 'Един набор отметки обслужва и панела за пускане горе, и бутона за изтриване тук.',
          },
          {
            key: 'home.deleteSelected',
            kind: 'button',
            en: 'Delete the {n} selected',
            bg: 'Изтрий избраните {n}',
            doesEn: 'Deletes every ticked session after one question; the run folders and the chats survive.',
            doesBg: 'Изтрива всички отметнати сесии след един въпрос; папките под runs/ и разговорите остават.',
          },
          {
            key: 'home.delete',
            kind: 'button',
            en: 'Delete',
            bg: 'Изтрий',
            doesEn: 'Removes that one session from the list; a running session has to be stopped first.',
            doesBg: 'Маха точно тази сесия от списъка; работеща сесия първо трябва да се спре.',
          },
          {
            key: 'state.running',
            kind: 'badge',
            en: 'running',
            bg: 'работи',
            doesEn: 'That session is working right now, so it cannot be ticked, deleted or added to a run.',
            doesBg: 'Сесията работи в момента, затова не може да се отмята, изтрива или включва в пускане.',
          },
          {
            key: 'state.idle',
            kind: 'badge',
            en: 'idle',
            bg: 'свободна',
            doesEn: 'Not working: it either has tasks waiting in its queue or has never been run.',
            doesBg: 'Не работи: или има задачи в опашката си, или изобщо не е пускана.',
          },
          {
            key: 'state.completed',
            kind: 'badge',
            en: 'completed',
            bg: 'завършена',
            doesEn: 'Every task of that session ended done and nothing is queued.',
            doesBg: 'Всяка задача на сесията е приключила готова и нищо не чака в опашката.',
          },
          {
            key: 'state.ended',
            kind: 'badge',
            en: 'ended, with failures',
            bg: 'приключила, с провали',
            doesEn: 'Every task ended, but some did not end done; nothing is queued.',
            doesBg: 'Всички задачи са приключили, но някои не са готови; нищо не чака в опашката.',
          },
        ],
      },
    ],
  },

  {
    route: '/sessions/[id]',
    nameEn: 'One session',
    nameBg: 'Една сесия',
    purposeEn:
      'Everything about one session: how it is configured, the queue of tasks with what each of them did, and the buttons that start, stop, edit and re-run the work.',
    purposeBg:
      'Всичко за една сесия: как е настроена, опашката със задачите и какво е свършила всяка от тях, плюс бутоните, с които работата тръгва, спира, се редактира и се пуска отново.',
    sections: [
      {
        headingKey: null,
        en: 'The strip beside the session name, at the top of the page',
        bg: 'Лентата до името на сесията, в началото на страницата',
        controls: [
          {
            key: 'session.run',
            kind: 'button',
            en: 'Run {n} task(s)',
            bg: 'Пусни {n} задача(и)',
            doesEn: 'Starts the queued tasks and runs every command without asking; it confirms once first.',
            doesBg: 'Пуска чакащите задачи и изпълнява всяка команда без питане; първо иска едно потвърждение.',
          },
          {
            key: 'session.runStep',
            kind: 'button',
            en: 'Step by step',
            bg: 'Стъпка по стъпка',
            doesEn: 'Starts the same queue but stops before every command and waits for a decision.',
            doesBg: 'Пуска същата опашка, но спира преди всяка команда и чака решение.',
          },
          {
            key: 'session.stop',
            kind: 'button',
            en: 'Stop after current step',
            bg: 'Спри след текущата стъпка',
            doesEn: 'Stops the run as soon as the command now executing finishes; the rest stay queued.',
            doesBg: 'Спира пускането, щом текущата команда приключи; останалите задачи остават да чакат.',
          },
          {
            key: 'session.askAgain',
            kind: 'button',
            en: 'Ask me again on every step',
            bg: 'Питай ме пак на всяка стъпка',
            doesEn: 'Puts a running session back to asking for approval before every further command.',
            doesBg: 'Връща работеща сесия към питане за одобрение преди всяка следваща команда.',
          },
          {
            key: 'session.openChat',
            kind: 'link',
            en: 'open chat: {name}',
            bg: 'отвори чата: {name}',
            doesEn: "Opens this session's Copilot conversation in a new browser tab.",
            doesBg: 'Отваря разговора на сесията в Copilot в нов таб на браузъра.',
          },
        ],
      },
      {
        headingKey: 'model.title',
        en: 'Copilot model',
        bg: 'Модел на Copilot',
        controls: [
          {
            key: 'model.refresh',
            kind: 'button',
            en: 'Read the list from Copilot',
            bg: 'Прочети списъка от Copilot',
            doesEn: "Opens the bot's Edge window, reads the chat's own model list and fills this picker with it.",
            doesBg: 'Отваря прозореца на Edge на бота, прочита списъка с модели от чата и попълва с него избора.',
          },
        ],
      },
      {
        headingKey: 'l1.title',
        en: 'Level 1: the base prompt',
        bg: 'Ниво 1: основен prompt',
        controls: [
          {
            key: 'l1.edit',
            kind: 'link',
            en: 'edit',
            bg: 'редактирай',
            doesEn: 'Opens the page where the base prompt itself is changed.',
            doesBg: 'Отваря страницата, на която се променя самият основен prompt.',
          },
        ],
      },
      {
        headingKey: 'vcs.title',
        en: 'Version control',
        bg: 'Контрол на версиите',
        controls: [
          {
            key: 'vcs.repoField',
            kind: 'field',
            en: 'Project folder',
            bg: 'Папка на проекта',
            doesEn: 'The git repository the tasks work in; it is saved when the field loses focus.',
            doesBg: 'Git хранилището, в което работят задачите; запазва се, щом излезете от полето.',
          },
          {
            key: 'mirror.browse',
            kind: 'button',
            en: 'Browse…',
            bg: 'Избери папка…',
            doesEn: "Opens the machine's folder dialog and saves whichever folder is picked.",
            doesBg: 'Отваря диалога за папки на машината и запазва избраната папка.',
          },
          {
            key: 'vcs.enable',
            kind: 'checkbox',
            en: 'Work on branches and commit what was changed',
            bg: 'Работи по клонове и комитвай промененото',
            doesEn: 'Makes the runner branch before each task and commit what changed; it needs a real git repository above.',
            doesBg: 'Кара изпълнителя да прави клон преди всяка задача и да комитва промененото; иска истинско git хранилище горе.',
          },
          {
            key: 'vcs.perTask',
            kind: 'radio',
            en: 'A branch of its own for every task',
            bg: 'Отделен клон за всяка задача',
            doesEn: 'Every task branches from the same starting point, so none of them sees the previous one’s changes.',
            doesBg: 'Всяка задача тръгва от една и съща точка и не вижда промените на предишната.',
          },
          {
            key: 'vcs.perSession',
            kind: 'radio',
            en: 'One branch for the whole session',
            bg: 'Един клон за цялата сесия',
            doesEn: 'Every task continues on the branch the task before it left, so later work builds on earlier work.',
            doesBg: 'Всяка задача продължава на клона от предишната, така че по-късната работа стъпва на по-ранната.',
          },
          {
            key: 'vcs.commit',
            kind: 'checkbox',
            en: 'Commit when a task finishes',
            bg: 'Комит при приключване на задача',
            doesEn: 'One local commit per task whatever the outcome; unticked leaves the changes loose in the working tree.',
            doesBg: 'По един локален комит на задача, независимо от изхода; без отметка промените остават свободни в работното дърво.',
          },
        ],
      },
      {
        headingKey: 'review.title',
        en: 'Independent review',
        bg: 'Независима рецензия',
        controls: [
          {
            key: 'review.enable',
            kind: 'checkbox',
            en: 'Check every task with a second conversation',
            bg: 'Проверявай всяка задача с втори разговор',
            doesEn: 'Opens a separate reviewing conversation after each task; it takes effect only after Save below.',
            doesBg: 'Отваря отделен рецензиращ разговор след всяка задача; влиза в сила чак след Запази отдолу.',
          },
          {
            key: 'review.modelField',
            kind: 'select',
            en: 'Model for the review',
            bg: 'Модел за рецензията',
            doesEn: 'Which model does the reviewing; it takes effect only after Save below.',
            doesBg: 'Кой модел прави рецензията; влиза в сила чак след Запази отдолу.',
          },
          {
            key: 'review.save',
            kind: 'button',
            en: 'Save',
            bg: 'Запази',
            doesEn: 'Stores the review switch and the review model onto this session.',
            doesBg: 'Записва отметката за рецензия и модела за нея върху тази сесия.',
          },
        ],
      },
      {
        headingKey: 'mirror.title',
        en: 'Project files for the chat',
        bg: 'Файлове на проекта за чата',
        controls: [
          {
            key: 'mirror.enable',
            kind: 'checkbox',
            en: 'attach project files',
            bg: 'прикачай файловете на проекта',
            doesEn: 'Attaches the selected files to the first message of every task; it takes effect only after Save below.',
            doesBg: 'Прикача избраните файлове към първото съобщение на всяка задача; влиза в сила чак след Запази отдолу.',
          },
          {
            key: 'mirror.root',
            kind: 'field',
            en: 'Project root',
            bg: 'Корен на проекта',
            doesEn: 'The folder the include and exclude lists below are relative to.',
            doesBg: 'Папката, спрямо която са списъците за включване и изключване отдолу.',
          },
          {
            key: 'tree.load',
            kind: 'button',
            en: 'Show the folders',
            bg: 'Покажи папките',
            doesEn: 'Reads the project folder and draws its tree, so folders can be ticked instead of typed.',
            doesBg: 'Прочита папката на проекта и показва дървото ѝ, за да се избират папки с клик, вместо да се пишат.',
          },
          {
            key: 'mirror.gitignore',
            kind: 'checkbox',
            en: 'Leave out what .gitignore lists',
            bg: 'Не добавяй това, което е в .gitignore',
            doesEn: 'Keeps everything .gitignore names out of the files sent to the chat.',
            doesBg: 'Държи всичко от .gitignore извън файловете, пратени в чата.',
          },
          {
            key: 'mirror.env',
            kind: 'checkbox',
            en: 'Copy .env files as well',
            bg: 'Копирай и .env файловете',
            doesEn: 'Sends the .env files too; it asks for confirmation first, because they usually hold passwords and keys.',
            doesBg: 'Праща и .env файловете; първо иска потвърждение, защото в тях обикновено има пароли и ключове.',
          },
          {
            key: 'mirror.save',
            kind: 'button',
            en: 'Save',
            bg: 'Запази',
            doesEn: 'Stores the switch, the project root and both lists onto this session.',
            doesBg: 'Записва отметката, корена на проекта и двата списъка върху тази сесия.',
          },
        ],
      },
      {
        headingKey: 'tasks.title',
        en: 'Tasks',
        bg: 'Задачи',
        controls: [
          {
            key: 'chain.stop',
            kind: 'radio',
            en: 'Stop the queue at the first failure',
            bg: 'Спри опашката при първата провалена',
            doesEn: 'The first task that does not finish stops the queue and leaves the rest waiting.',
            doesBg: 'Първата задача, която не приключи, спира опашката и оставя останалите да чакат.',
          },
          {
            key: 'chain.continue',
            kind: 'radio',
            en: 'Carry on with the next task',
            bg: 'Продължи със следващата задача',
            doesEn: 'A failure is passed over and the next task starts anyway.',
            doesBg: 'Провалът се подминава и следващата задача тръгва въпреки него.',
          },
          {
            key: 'story.show',
            kind: 'button',
            en: 'What happened',
            bg: 'Какво се случи',
            doesEn: 'Opens the whole run of that task under its card: every message, every command and its output, live while it runs.',
            doesBg: 'Отваря под картата цялото изпълнение на задачата: всяко съобщение, всяка команда с изхода ѝ, на живо докато върви.',
          },
          {
            key: 'story.showLive',
            kind: 'button',
            en: 'What is happening now',
            bg: 'Какво се случва в момента',
            doesEn: 'The same button while the task is still running — it says this instead, and pulses. Tell the operator to watch here.',
            doesBg: 'Същият бутон, докато задачата още върви — пише това и пулсира. Кажи на оператора да гледа тук.',
          },
          {
            key: 'task.edit',
            kind: 'button',
            en: 'Edit',
            bg: 'Редактирай',
            doesEn: "Opens the form for that task's title, level 2, task text, git names and checks.",
            doesBg: 'Отваря формата за заглавието, ниво 2, текста, git имената и проверките на задачата.',
          },
          {
            key: 'task.rerun',
            kind: 'button',
            en: 'Run again',
            bg: 'Пусни отново',
            doesEn: 'Puts a finished task back in the queue unchanged; the earlier attempt is kept with its own log.',
            doesBg: 'Връща приключила задача в опашката без промяна; предишният опит се пази със собствен дневник.',
          },
          {
            key: 'restore.button',
            kind: 'button',
            en: 'Restore',
            bg: 'Върни',
            doesEn: 'Puts the repository back to the code as it was before that task started, on a new branch. Nothing is deleted.',
            doesBg: 'Връща хранилището към кода отпреди тази задача, на нов клон. Нищо не се изтрива.',
          },
          {
            key: 'restart.button',
            kind: 'button',
            en: 'Run again from here',
            bg: 'Пусни отново оттук',
            doesEn: 'Puts the code back, queues that task and every task after it again, and starts the run.',
            doesBg: 'Връща кода, нарежда отново тази задача и всички след нея и пуска изпълнението.',
          },
          {
            key: 'task.delete',
            kind: 'button',
            en: 'Delete',
            bg: 'Изтрий',
            doesEn: 'Takes that task out of the session; what it already executed stays on disk under runs/.',
            doesBg: 'Маха задачата от сесията; вече изпълненото остава на диска под runs/.',
          },
          {
            key: 'save.log',
            kind: 'button',
            en: 'save the log',
            bg: 'запази log-а',
            doesEn: 'Writes the whole run of that task, as plain text, into copilot-operator-logs on the Desktop and opens Explorer with the file selected, ready to drag into a chat. This is the file to ask for when the work is being validated.',
            doesBg: 'Записва цялото изпълнение на задачата като чист текст в copilot-operator-logs на десктопа и отваря Explorer с избран файл, готов за влачене в чат. Това е файлът, който се иска при проверка на свършеното.',
          },
          {
            key: 'status.queued',
            kind: 'badge',
            en: 'queued',
            bg: 'чака',
            doesEn: 'The task is waiting its turn and has not started.',
            doesBg: 'Задачата чака реда си и още не е започнала.',
          },
          {
            key: 'status.running',
            kind: 'badge',
            en: 'running',
            bg: 'работи',
            doesEn: 'The task is being executed right now.',
            doesBg: 'Задачата се изпълнява в момента.',
          },
          {
            key: 'status.waiting-approval',
            kind: 'badge',
            en: 'waiting for approval',
            bg: 'чака одобрение',
            doesEn: 'The task has stopped and a command is waiting for a decision.',
            doesBg: 'Задачата е спряла и команда чака решение.',
          },
          {
            key: 'status.done',
            kind: 'badge',
            en: 'done',
            bg: 'готова',
            doesEn: 'The task finished with a summary and its checks passed. This is the only ending that counts as success.',
            doesBg: 'Задачата е приключила с обяснение и проверките ѝ са минали. Това е единственият край, който значи успех.',
          },
          {
            key: 'status.blocked',
            kind: 'badge',
            en: 'not done',
            bg: 'неизпълнена',
            doesEn: 'The task ended without the work being done and says what stood in the way; read that reason first.',
            doesBg: 'Задачата е приключила, без работата да е свършена, и казва какво е попречило; тази причина се чете първа.',
          },
          {
            key: 'status.failed',
            kind: 'badge',
            en: 'failed',
            bg: 'провалена',
            doesEn: 'The task broke down and never reached an ending of its own.',
            doesBg: 'Задачата се е счупила и не е стигнала до собствен край.',
          },
          {
            key: 'status.aborted',
            kind: 'badge',
            en: 'aborted',
            bg: 'прекратена',
            doesEn: 'The task was ended by hand from an approval step.',
            doesBg: 'Задачата е прекратена на ръка от стъпка за одобрение.',
          },
          {
            key: 'status.limit-reached',
            kind: 'badge',
            en: 'limit reached',
            bg: 'достигнат лимит',
            doesEn: 'The task ran out of its allowed iterations before it could close.',
            doesBg: 'Задачата е изчерпала позволените си итерации, преди да приключи.',
          },
          {
            key: 'review.verdict.pass',
            kind: 'badge',
            en: 'review passed',
            bg: 'рецензията мина',
            doesEn: 'The second, independent conversation ran the work and found nothing wrong.',
            doesBg: 'Вторият, независим разговор е изпълнил работата и не е намерил проблем.',
          },
          {
            key: 'review.verdict.fail',
            kind: 'badge',
            en: 'review found problems',
            bg: 'рецензията намери проблеми',
            doesEn: 'The review found problems; the number beside it says how many and the task card lists them.',
            doesBg: 'Рецензията е намерила проблеми; числото до нея казва колко, а картата на задачата ги изброява.',
          },
          {
            key: 'review.verdict.error',
            kind: 'badge',
            en: 'review did not run',
            bg: 'рецензията не се проведе',
            doesEn: 'The review could not be carried out, so the work was accepted unreviewed.',
            doesBg: 'Рецензията не е могла да се проведе и работата е приета без нея.',
          },
        ],
      },
      {
        headingKey: 'form.title',
        en: 'Add a task',
        bg: 'Добави задача',
        controls: [
          {
            key: 'form.titleLabel',
            kind: 'field',
            en: 'Title',
            bg: 'Заглавие',
            doesEn: 'The short name the task is listed under.',
            doesBg: 'Краткото име, под което задачата стои в списъка.',
          },
          {
            key: 'l2.label',
            kind: 'field',
            en: 'Level 2: project, domain and team instructions for this task',
            bg: 'Ниво 2: инструкции за проекта, домейна и екипа за тази задача',
            doesEn: 'What the operator knows and the runner does not; it is sent with this one task.',
            doesBg: 'Това, което операторът знае, а изпълнителят не; изпраща се с точно тази задача.',
          },
          {
            key: 'l2.loadPreset',
            kind: 'select',
            en: 'load a preset…',
            bg: 'зареди шаблон…',
            doesEn: 'Replaces that text with a preset saved earlier.',
            doesBg: 'Заменя този текст с по-рано запазен шаблон.',
          },
          {
            key: 'form.taskLabel',
            kind: 'field',
            en: 'Task',
            bg: 'Задача',
            doesEn: 'The task text itself: what to do, what the result should be, what is out of bounds.',
            doesBg: 'Самият текст на задачата: какво да се направи, какъв да е резултатът, какво е извън обхвата.',
          },
          {
            key: 'form.add',
            kind: 'button',
            en: 'Add to queue',
            bg: 'Добави в опашката',
            doesEn: "Puts the new task at the end of this session's queue; it starts nothing.",
            doesBg: 'Слага новата задача в края на опашката на сесията; не пуска нищо.',
          },
          {
            key: 'task.saveAndRerun',
            kind: 'button',
            en: 'Save and queue it again',
            bg: 'Запази и върни в опашката',
            doesEn: 'On a task that has already run: stores the edit and puts the task back in the queue with the new text.',
            doesBg: 'При вече изпълнена задача: записва промяната и връща задачата в опашката с новия текст.',
          },
        ],
      },
      {
        headingKey: 'checks.title',
        en: 'Checks',
        bg: 'Проверки',
        controls: [
          {
            key: 'checks.name',
            kind: 'field',
            en: 'What it checks',
            bg: 'Какво проверява',
            doesEn: 'What this check is called, in the words a person would use.',
            doesBg: 'Как се казва проверката, с човешки думи.',
          },
          {
            key: 'checks.kind',
            kind: 'select',
            en: 'Must be',
            bg: 'Трябва',
            doesEn: 'What has to be true: a command succeeding or failing, its output, or a file existing or containing something.',
            doesBg: 'Какво трябва да е вярно: командата да успее или да се провали, изходът ѝ, или файл да съществува или да съдържа нещо.',
          },
          {
            key: 'checks.run',
            kind: 'field',
            en: 'Command',
            bg: 'Команда',
            doesEn: 'The command the runner executes for this check.',
            doesBg: 'Командата, която изпълнителят пуска за тази проверка.',
          },
          {
            key: 'checks.add',
            kind: 'button',
            en: 'Add a check',
            bg: 'Добави проверка',
            doesEn: 'Adds one more empty check to the task. A task with no check has nothing gating it.',
            doesBg: 'Добавя още една празна проверка към задачата. Задача без проверка няма какво да я спре.',
          },
        ],
      },
      {
        headingKey: 'export.title',
        en: 'Download the work',
        bg: 'Изтегли свършената работа',
        controls: [
          {
            key: 'export.outcome',
            kind: 'link',
            en: 'Expected and actual ({n})',
            bg: 'Очаквано и получено ({n})',
            doesEn: 'The short record: for each chosen task, the message that opened it and the answer that closed it.',
            doesBg: 'Краткият запис: за всяка избрана задача първото съобщение и отговорът, с който приключва.',
          },
          {
            key: 'export.full',
            kind: 'link',
            en: 'The whole conversation ({n})',
            bg: 'Целият разговор ({n})',
            doesEn: 'The whole conversation of the chosen tasks, with every report and reply in between.',
            doesBg: 'Целият разговор на избраните задачи, с всички отчети и отговори помежду им.',
          },
        ],
      },
    ],
  },

  {
    route: '/history',
    nameEn: 'Task register',
    nameBg: 'Регистър на задачите',
    purposeEn:
      'Every task of every session in one place — running now, queued next, already done — with the filters, the log downloads and the one button that continues the queue.',
    purposeBg:
      'Всички задачи от всички сесии на едно място — какво върви сега, какво чака и какво е направено — с филтрите, изтеглянията на log-овете и единствения бутон, който продължава опашката.',
    sections: [
      {
        headingKey: 'reg.title',
        en: 'Task register',
        bg: 'Регистър на задачите',
        controls: [
          {
            key: 'reg.refresh',
            kind: 'button',
            en: 'Refresh',
            bg: 'Обнови',
            doesEn: 'Reads the task list from the server at once; the page also re-reads it by itself every few seconds.',
            doesBg: 'Прочита списъка със задачи от сървъра веднага; страницата и без това се обновява сама на няколко секунди.',
          },
          {
            key: 'reg.total',
            kind: 'badge',
            en: 'tasks',
            bg: 'задачи',
            doesEn: 'The counter for every task in the register, whatever the filters are set to.',
            doesBg: 'Броячът на всички задачи в регистъра, независимо какво са филтрите.',
          },
          {
            key: 'reg.done',
            kind: 'badge',
            en: 'done',
            bg: 'готови',
            doesEn: 'The counter for the tasks that ended with the work actually done.',
            doesBg: 'Броячът на задачите, приключили с наистина свършена работа.',
          },
          {
            key: 'reg.runningCount',
            kind: 'badge',
            en: 'running now',
            bg: 'в момента',
            doesEn: 'The counter for the tasks being worked on, including one stopped for approval.',
            doesBg: 'Броячът на задачите, по които се работи, включително спряна за одобрение.',
          },
          {
            key: 'reg.open',
            kind: 'badge',
            en: 'ahead',
            bg: 'предстоят',
            doesEn: 'The counter for the tasks that have not started and are still waiting in a queue.',
            doesBg: 'Броячът на задачите, които още не са започнали и чакат в опашка.',
          },
          {
            key: 'reg.failedCount',
            kind: 'badge',
            en: 'did not finish',
            bg: 'не са приключили',
            doesEn: 'The counter for every ending that is not done: not done, failed, aborted or out of limit.',
            doesBg: 'Броячът на всички краища, различни от готова: неизпълнени, провалени, прекратени или с достигнат лимит.',
          },
        ],
      },
      {
        headingKey: 'reg.filterSession',
        en: 'Session',
        bg: 'Сесия',
        controls: [
          {
            key: 'reg.filterStatus',
            kind: 'select',
            en: 'Status',
            bg: 'Състояние',
            doesEn: 'Narrows the page to the tasks in one state, using the same words as the badges.',
            doesBg: 'Свива страницата до задачите в едно състояние, със същите думи като етикетите.',
          },
          {
            key: 'reg.search',
            kind: 'field',
            en: 'Search in the titles and the summaries',
            bg: 'Търсене в заглавията и обясненията',
            doesEn: 'Keeps only the rows whose title, summary, stop reason or session name contains what is typed.',
            doesBg: 'Оставя само редовете, в чието заглавие, обяснение, причина за спиране или име на сесия се среща написаното.',
          },
          {
            key: 'reg.clear',
            kind: 'button',
            en: 'Clear the filters',
            bg: 'Изчисти филтрите',
            doesEn: 'Empties the session, status and search filters in one press.',
            doesBg: 'Изчиства наведнъж филтрите по сесия, по състояние и търсенето.',
          },
        ],
      },
      {
        headingKey: 'reg.viewLabel',
        en: 'View',
        bg: 'Изглед',
        controls: [
          {
            key: 'reg.viewFlow',
            kind: 'tab',
            en: 'Flow',
            bg: 'Поток',
            doesEn: 'Shows the register as three threads: running now, what is next, what has been done.',
            doesBg: 'Показва регистъра като три нишки: какво върви сега, какво следва, какво е направено.',
          },
          {
            key: 'reg.groupBy',
            kind: 'tab',
            en: 'By run',
            bg: 'По изпълнение',
            doesEn: 'Regroups the same tasks under the run that started them, newest run first.',
            doesBg: 'Прегрупира същите задачи под пускането, което ги е стартирало, най-новото отгоре.',
          },
          {
            key: 'reg.viewList',
            kind: 'tab',
            en: 'List',
            bg: 'Списък',
            doesEn: 'Shows the same tasks as one table, for scanning many of them at once.',
            doesBg: 'Показва същите задачи като една таблица, за да се преглеждат много наведнъж.',
          },
        ],
      },
      {
        headingKey: 'reg.activeNow',
        en: 'Running now',
        bg: 'В момента',
        controls: [
          {
            key: 'save.log',
            kind: 'button',
            en: 'save the log',
            bg: 'запази log-а',
            doesEn: "Saves the runner's log of that task's latest attempt to the Desktop and opens Explorer on it.",
            doesBg: 'Запазва log-а на runner-а от последния опит на задачата на десктопа и отваря Explorer върху него.',
          },
          {
            key: 'reg.exportPlan',
            kind: 'link',
            en: 'plan',
            bg: 'план',
            doesEn: 'Downloads what was asked: the task in the plan format, with the edits made in the interface. Imports again.',
            doesBg: 'Изтегля какво е поискано: задачата във формата на плана, с редакциите от интерфейса. Внася се отново.',
          },
          {
            key: 'reg.exportDomain',
            kind: 'link',
            en: 'work',
            bg: 'работа',
            doesEn: 'Downloads what happened to the work: what the chat tried, what was done, and why it did not end done.',
            doesBg: 'Изтегля какво се случи с работата: какво е пробвал чатът, какво е направено и защо не е завършила готова.',
          },
          {
            key: 'reg.exportBot',
            kind: 'link',
            en: 'runner',
            bg: 'runner',
            doesEn: 'Downloads what the runner did: the environment, every event and step with its exit code, the review machinery.',
            doesBg: 'Изтегля какво е направил runner-ът: средата, всяко събитие и стъпка с кода на изход, механиката на рецензията.',
          },
          {
            key: 'story.show',
            kind: 'button',
            en: 'What happened',
            bg: 'Какво се случи',
            doesEn: 'Unfolds the whole story under the row, live while the task runs.',
            doesBg: 'Разгъва цялата история под реда, на живо докато задачата върви.',
          },
          {
            key: 'story.showLive',
            kind: 'button',
            en: 'What is happening now',
            bg: 'Какво се случва в момента',
            doesEn: 'The same button while the task is still running — it says this instead, and pulses. Tell the operator to watch here.',
            doesBg: 'Същият бутон, докато задачата още върви — пише това и пулсира. Кажи на оператора да гледа тук.',
          },
          {
            key: 'reg.pick',
            kind: 'button',
            en: 'Choose tasks',
            bg: 'Избери задачи',
            doesEn: 'Above the finished tasks. Puts a tick box on every task that ran, across every run, so several can be picked at once.',
            doesBg: 'Над свършените задачи. Слага отметка на всяка изпълнена задача, през всички пускания, за да могат да се изберат няколко наведнъж.',
          },
          {
            key: 'reg.bundle',
            kind: 'button',
            en: 'Download plan, work and runner for the {n} chosen, as one file',
            bg: 'Изтегли план, работа и runner за избраните {n}, в един файл',
            doesEn: 'One JSON holding all three views of exactly the ticked tasks. Ask for this rather than three separate files when you want to work out why something went the way it did — and say how many tasks to tick.',
            doesBg: 'Един JSON с трите изгледа на точно отметнатите задачи. Искай него вместо три отделни файла, когато трябва да се разбере защо нещо е тръгнало така — и кажи колко задачи да се отметнат.',
          },
          {
            key: 'row.info',
            kind: 'button',
            en: 'What are these?',
            bg: 'Какво са тези?',
            doesEn: "A small round i at the end of the row. Opens a panel saying what each of the row's links gives you, and which of the three JSON files to reach for first.",
            doesBg: 'Малко кръгло i в края на реда. Отваря панел, който казва какво дава всяка от връзките на реда и кой от трите JSON файла да се вземе първи.',
          },
        ],
      },
      {
        headingKey: 'reg.upcoming',
        en: 'What is next',
        bg: 'Какво следва',
        controls: [
          {
            key: 'reg.continue',
            kind: 'button',
            en: 'Continue: run the {n} queued task(s) in {s} session(s)',
            bg: 'Продължи: пусни {n} чакащи задачи в {s} сесии',
            doesEn: 'Opens a panel listing exactly which queued tasks in which sessions would be started. It starts nothing yet.',
            doesBg: 'Отваря панел, който изброява точно кои чакащи задачи в кои сесии ще тръгнат. Още нищо не пуска.',
          },
          {
            key: 'reg.continueWithFailed',
            kind: 'button',
            en: 'Continue: run {f} failed and {n} queued task(s) in {s} session(s)',
            bg: 'Продължи: пусни {f} провалили се и {n} чакащи задачи в {s} сесии',
            doesEn: 'The same button when a failed task would go back into the queue alongside the queued ones.',
            doesBg: 'Същият бутон, когато провалена задача се връща в опашката заедно с чакащите.',
          },
          {
            key: 'reg.continuePanelTitle',
            kind: 'note',
            en: 'Before it continues',
            bg: 'Преди да продължи',
            doesEn: 'The heading of that panel; the two start buttons and the tick boxes are inside it.',
            doesBg: 'Заглавието на този панел; двата бутона за старт и отметките са в него.',
          },
          {
            key: 'reg.continueUnattended',
            kind: 'button',
            en: 'Continue without asking',
            bg: 'Продължи без да пита',
            doesEn: 'Starts the listed sessions and runs every command without asking again; it confirms once first.',
            doesBg: 'Пуска изброените сесии и изпълнява всяка команда без повече питане; първо иска едно потвърждение.',
          },
          {
            key: 'reg.continueGo',
            kind: 'button',
            en: 'Continue, asking before each command',
            bg: 'Продължи, с питане преди всяка команда',
            doesEn: 'Starts the same sessions but stops for approval before every command.',
            doesBg: 'Пуска същите сесии, но спира за одобрение преди всяка команда.',
          },
          {
            key: 'reg.fixPrompt',
            kind: 'button',
            en: 'Fix the prompt and queue it again',
            bg: 'Поправи prompt-а и върни в опашката',
            doesEn: "Opens the failed task's text alone for rewriting, before it goes back into the queue.",
            doesBg: 'Отваря само текста на провалената задача за пренаписване, преди тя да се върне в опашката.',
          },
        ],
      },
      {
        headingKey: 'reg.past',
        en: 'What has been done',
        bg: 'Какво е направено',
        controls: [
          {
            key: 'reg.stopped',
            kind: 'note',
            en: 'stopped: {reason}',
            bg: 'спряна: {reason}',
            doesEn: 'In red on the row: why that task or attempt stopped without the work being done.',
            doesBg: 'В червено на реда: защо задачата или опитът е спрял, без работата да е свършена.',
          },
          {
            key: 'save.attemptLog',
            kind: 'button',
            en: "save this attempt's log",
            bg: 'запази log-а на този опит',
            doesEn: 'Saves the log of one earlier attempt, rather than of the latest one, to the Desktop.',
            doesBg: 'Запазва на десктопа log-а на конкретен по-ранен опит, а не на последния.',
          },
          {
            key: 'reg.retriedFreshDone',
            kind: 'badge',
            en: 'blocked, then done in a fresh chat ({n}×)',
            bg: 'блокира, после готова в нов чат ({n}×)',
            doesEn: 'The task was blocked and then finished in a new conversation, so the chat was the cause, not the task.',
            doesBg: 'Задачата е блокирала и после е станала готова в нов разговор — значи чатът е бил причината, не задачата.',
          },
          {
            key: 'reg.retriedFreshStill',
            kind: 'badge',
            en: 'still blocked after {n} fresh chat(s)',
            bg: 'още блокирана след {n} нови чата',
            doesEn: 'Fresh conversations did not help, so the cause is in the task text, the checks or the machine.',
            doesBg: 'Новите разговори не са помогнали — причината е в текста на задачата, в проверките или в машината.',
          },
        ],
      },
      {
        headingKey: 'reg.fixPromptTitle',
        en: 'The prompt of "{title}"',
        bg: 'Prompt-ът на „{title}"',
        controls: [
          {
            key: 'reg.fixPromptSave',
            kind: 'button',
            en: 'Save and queue again',
            bg: 'Запази и върни в опашката',
            doesEn: 'Saves the rewritten task text and puts the task back into its queue with it. Level 2, the checks and the git names are untouched.',
            doesBg: 'Запазва пренаписания текст и връща задачата в опашката с него. Ниво 2, проверките и git имената остават каквито са.',
          },
        ],
      },
    ],
  },

  {
    route: '/defaults',
    nameEn: 'Settings',
    nameBg: 'Настройки',
    purposeEn:
      'What every new session starts with: the project folders, the model that does the work and the model that reviews it. Every field saves itself; there is no save button.',
    purposeBg:
      'С какво тръгва всяка нова сесия: папките на проектите, моделът, който върши работата, и моделът, който я проверява. Всяко поле се запазва само; няма бутон за запазване.',
    sections: [
      {
        headingKey: 'proj.title',
        en: 'The project you are working on',
        bg: 'Проектът, по който се работи',
        controls: [
          {
            key: 'def.autoSave',
            kind: 'note',
            en: 'Everything on this page saves itself as you change it. There is nothing to press.',
            bg: 'Всичко на тази страница се запазва само, докато го променяте. Няма какво да натискате.',
            doesEn: 'Do not look for a save button on this page; there is none.',
            doesBg: 'Не търсете бутон за запазване на тази страница; такъв няма.',
          },
          {
            key: 'proj.entryName',
            kind: 'field',
            en: 'Name',
            bg: 'Име',
            doesEn: 'The short name this project carries everywhere else, including in the list the brief hands to the chat.',
            doesBg: 'Краткото име, с което проектът се води навсякъде другаде, включително в списъка, който заданието дава на чата.',
          },
          {
            key: 'proj.entryDir',
            kind: 'field',
            en: 'Folder',
            bg: 'Папка',
            doesEn: 'The folder every new session starts pointed at; it saves a moment after the typing stops.',
            doesBg: 'Папката, към която тръгва всяка нова сесия; запазва се малко след като спрете да пишете.',
          },
          {
            key: 'mirror.browse',
            kind: 'button',
            en: 'Browse…',
            bg: 'Избери папка…',
            doesEn: 'Opens a folder-picking window and saves whichever folder is chosen.',
            doesBg: 'Отваря прозорец за избор на папка и запазва избраната.',
          },
          {
            key: 'proj.clear',
            kind: 'button',
            en: 'Clear',
            bg: 'Изчисти',
            doesEn: 'Empties that field, so new sessions start with nothing chosen.',
            doesBg: 'Изпразва полето, така че новите сесии тръгват без избрано.',
          },
          {
            key: 'proj.mirrorToDesktop',
            kind: 'checkbox',
            en: 'Keep the projects on the Desktop',
            bg: 'Дръж проектите на Desktop-а',
            doesEn: 'Copies every project on this page to its own Desktop folder before each run, which is how the files reach the chat.',
            doesBg: 'Копира всеки проект от тази страница в собствена папка на Desktop-а преди всяко пускане — така файловете стигат до чата.',
          },
        ],
      },
      {
        headingKey: 'proj.addTitle',
        en: 'Add another project',
        bg: 'Добави още един проект',
        controls: [
          {
            key: 'proj.entryName',
            kind: 'field',
            en: 'Name',
            bg: 'Име',
            doesEn: 'The short name of another folder worked in; the brief lists it with its path.',
            doesBg: 'Краткото име на друга работна папка; заданието я изброява с пътя ѝ.',
          },
          {
            key: 'proj.entryDir',
            kind: 'field',
            en: 'Folder',
            bg: 'Папка',
            doesEn: 'The path of that other project.',
            doesBg: 'Пътят до тази друга папка.',
          },
          {
            key: 'proj.otherAdd',
            kind: 'button',
            en: 'Add',
            bg: 'Добави',
            doesEn: 'Saves the typed name and folder as another project; it stays dead until both boxes are filled.',
            doesBg: 'Запазва въведените име и папка като още един проект; неактивен е, докато и двете полета не са попълнени.',
          },
        ],
      },
      {
        headingKey: 'def.modelTitle',
        en: 'Model for new sessions',
        bg: 'Модел за новите сесии',
        controls: [
          {
            key: 'def.modelField',
            kind: 'select',
            en: 'Model',
            bg: 'Модел',
            doesEn: 'The model every new session starts on, named exactly as the chat’s own picker shows it.',
            doesBg: 'Моделът, с който тръгва всяка нова сесия, с точното име от менюто на самия чат.',
          },
          {
            key: 'def.modelNone',
            kind: 'select',
            en: 'Leave the chat on whatever it is set to',
            bg: 'Остави чата на каквото е настроен',
            doesEn: 'The empty choice: new sessions do not touch the chat’s model at all.',
            doesBg: 'Празният избор: новите сесии изобщо не пипат модела в чата.',
          },
          {
            key: 'model.refresh',
            kind: 'button',
            en: 'Read the list from Copilot',
            bg: 'Прочети списъка от Copilot',
            doesEn: 'Reads the model list out of the chat itself; it cannot run while a session is running.',
            doesBg: 'Прочита списъка с модели от самия чат; не може да се изпълни, докато сесия работи.',
          },
        ],
      },
      {
        headingKey: 'def.reviewTitle',
        en: 'Model for the review',
        bg: 'Модел за рецензията',
        controls: [
          {
            key: 'def.reviewField',
            kind: 'select',
            en: 'Review model',
            bg: 'Модел за рецензията',
            doesEn: 'The model a new session’s independent review starts on. A different model from the working one catches more.',
            doesBg: 'Моделът, с който тръгва независимата рецензия на новата сесия. Различен от работещия хваща повече.',
          },
          {
            key: 'def.reviewNone',
            kind: 'select',
            en: "The session's own model",
            bg: 'Собственият модел на сесията',
            doesEn: 'The empty choice: the review is done by whichever model the session itself is on.',
            doesBg: 'Празният избор: рецензията се прави от модела, на който е самата сесия.',
          },
        ],
      },
      {
        headingKey: 'exec.title',
        en: 'Execution',
        bg: 'Изпълнение',
        controls: [
          {
            key: 'exec.retryBlocked',
            kind: 'field',
            en: 'When a task ends blocked, run it again in a fresh conversation',
            bg: 'Когато задача завърши блокирана, пусни я отново в нов разговор',
            doesEn: 'How many times a blocked task is retried in a brand-new chat before the verdict stands; 0 turns it off.',
            doesBg: 'Колко пъти блокирана задача се пуска отново в нов чат, преди присъдата да остане; 0 го изключва.',
          },
          {
            key: 'exec.isolation',
            kind: 'field',
            en: 'Where the bot runs',
            bg: 'Къде върви ботът',
            doesEn:
              "The operator's statement about what contains this runner: this account, a separate low-privilege Windows account, Windows Sandbox, or a VM. It gates unattended runs — while it says this account, a run with nobody watching is refused — and it is recorded with every run beside the account the process actually held.",
            doesBg:
              'Твърдението на оператора какво огражда този runner: този акаунт, отделен Windows акаунт с малки права, Windows Sandbox или виртуална машина. То управлява пусканията без надзор — докато казва „този акаунт“, пускане без човек се отказва — и се записва с всяко пускане до акаунта, който процесът наистина е държал.',
          },
        ],
      },
    ],
  },

  {
    route: '/level1',
    nameEn: 'Level 1: the base prompt',
    nameBg: 'Ниво 1: основен prompt',
    purposeEn:
      'The base prompt sent once at the start of every conversation, before any project instructions. The runner parses exactly the reply format described in it.',
    purposeBg:
      'Основният prompt, изпращан веднъж в началото на всеки разговор, преди инструкциите за проекта. Runner-ът парсва точно описания в него формат на отговора.',
    sections: [
      {
        headingKey: 'l1page.title',
        en: 'Level 1: the base prompt',
        bg: 'Ниво 1: основен prompt',
        controls: [
          {
            key: 'l1page.unsaved',
            kind: 'badge',
            en: 'unsaved changes',
            bg: 'незапазени промени',
            doesEn: 'Appears as soon as the editor differs from what is stored, and goes when it is saved.',
            doesBg: 'Появява се, щом редакторът се различи от запазеното, и изчезва при запазване.',
          },
          {
            key: 'l1page.save',
            kind: 'button',
            en: 'Save',
            bg: 'Запази',
            doesEn: 'Writes the editor to data/level1.md; the new prompt applies only to sessions started after it.',
            doesBg: 'Записва редактора в data/level1.md; новият prompt важи само за сесии, започнати след това.',
          },
          {
            key: 'l1page.reset',
            kind: 'button',
            en: 'Reset to shipped',
            bg: 'Върни оригинала',
            doesEn: 'Throws the edited copy away and puts the prompt shipped with the project back, after one question.',
            doesBg: 'Изхвърля редактираното копие и връща оригиналния prompt на проекта, след един въпрос.',
          },
        ],
      },
    ],
  },

  {
    route: '/presets',
    nameEn: 'Level 2 presets',
    nameBg: 'Шаблони за ниво 2',
    purposeEn:
      'The reusable level 2 instruction blocks — the project knowledge — saved under a name so a task can be given one instead of having it retyped.',
    purposeBg:
      'Многократно използваемите блокове с инструкции от ниво 2 — знанието за проекта — запазени с име, за да се дадат на задача, вместо да се пишат наново.',
    sections: [
      {
        headingKey: 'presets.title',
        en: 'Level 2 presets',
        bg: 'Шаблони за ниво 2',
        controls: [
          {
            key: 'presets.name',
            kind: 'field',
            en: 'Name',
            bg: 'Име',
            doesEn: 'The name this preset is saved and later picked under; an existing name is overwritten.',
            doesBg: 'Името, под което шаблонът се запазва и после се избира; съществуващо име се презаписва.',
          },
          {
            key: 'presets.content',
            kind: 'field',
            en: 'Instructions',
            bg: 'Инструкции',
            doesEn: 'The level 2 text sent with every task that uses this preset.',
            doesBg: 'Текстът от ниво 2, който се изпраща с всяка задача, ползваща този шаблон.',
          },
          {
            key: 'presets.save',
            kind: 'button',
            en: 'Save preset',
            bg: 'Запази шаблона',
            doesEn: 'Stores the name and the instructions and refreshes the list below.',
            doesBg: 'Записва името и инструкциите и опреснява списъка отдолу.',
          },
        ],
      },
      {
        headingKey: 'presets.list',
        en: 'Saved',
        bg: 'Запазени',
        controls: [
          {
            key: 'presets.edit',
            kind: 'button',
            en: 'Edit',
            bg: 'Редактирай',
            doesEn: 'Copies that preset back into the two boxes above, to change it and save over it.',
            doesBg: 'Връща шаблона в двете полета горе, за да го промените и запазите върху него.',
          },
          {
            key: 'presets.delete',
            kind: 'button',
            en: 'Delete',
            bg: 'Изтрий',
            doesEn: 'Removes that preset from the list for good, after a confirmation.',
            doesBg: 'Маха шаблона от списъка завинаги, след потвърждение.',
          },
        ],
      },
    ],
  },

  {
    route: '/appearance',
    nameEn: 'Appearance',
    nameBg: 'Изглед',
    purposeEn: 'The theme, the text size and the accessibility options. Everything here is kept in this browser and affects nothing a session does.',
    purposeBg:
      'Темата, размерът на текста и настройките за достъпност. Всичко тук се пази в този браузър и не влияе на нищо, което прави сесия.',
    sections: [
      {
        headingKey: 'ap.title',
        en: 'Appearance',
        bg: 'Изглед',
        controls: [
          {
            key: 'theme.light',
            kind: 'radio',
            en: 'Light',
            bg: 'Светла',
            doesEn: 'Switches the interface to the light theme at once and remembers it in this browser.',
            doesBg: 'Превключва интерфейса към светлата тема веднага и я запомня в този браузър.',
          },
          {
            key: 'theme.dark',
            kind: 'radio',
            en: 'Dark',
            bg: 'Тъмна',
            doesEn: 'Switches the interface to the dark theme at once and remembers it in this browser.',
            doesBg: 'Превключва интерфейса към тъмната тема веднага и я запомня в този браузър.',
          },
        ],
      },
    ],
  },

  {
    route: '/system',
    nameEn: 'System',
    nameBg: 'Система',
    purposeEn:
      'A read-only report on this machine: Node, Edge, the folders and whether anything is holding the bot’s browser profile. There is nothing here to press, and it is the first page to read when a run will not start.',
    purposeBg:
      'Отчет за тази машина, само за четене: Node, Edge, папките и дали нещо държи профила на браузъра на бота. Тук няма какво да се натиска, а страницата се чете първа, когато пускане не тръгва.',
    sections: [
      {
        headingKey: 'sys.machine',
        en: 'This machine',
        bg: 'Тази машина',
        controls: [
          {
            key: 'sys.profileHeld',
            kind: 'note',
            en: 'Edge is holding the profile (pids {pids}). A run would fail. Close that Edge window.',
            bg: 'Edge държи профила (pid {pids}). Изпълнение би се провалило. Затворете този прозорец на Edge.',
            doesEn: 'The line to look for when a run will not start: a stray Edge window has the profile open.',
            doesBg: 'Редът, който се търси, когато пускане не тръгва: чужд прозорец на Edge държи профила отворен.',
          },
        ],
      },
    ],
  },
];

/** What a control is called in the rendered guide, in each language. */
const KIND_WORDS: Record<ControlKind, { en: string; bg: string }> = {
  button: { en: 'button', bg: 'бутон' },
  link: { en: 'link', bg: 'връзка' },
  field: { en: 'field', bg: 'поле' },
  checkbox: { en: 'checkbox', bg: 'отметка' },
  radio: { en: 'radio', bg: 'радио бутон' },
  select: { en: 'menu', bg: 'меню' },
  tab: { en: 'tab', bg: 'раздел' },
  badge: { en: 'badge', bg: 'етикет' },
  disclosure: { en: 'fold', bg: 'разгъване' },
  note: { en: 'line on screen', bg: 'ред на екрана' },
};

const INTRO_EN =
  'Every label in quotes below is the exact text on the screen. Name the control by that text — press "Check it" — instead of describing it, and give the route so the operator knows which page they are on. A label with {braces} in it is filled in with numbers or names at the time.';

const INTRO_BG =
  'Всеки надпис в кавички по-долу е точният текст на екрана. Назовавай контрола с този текст — натисни „Провери“ — вместо да го описваш, и казвай маршрута, за да знае операторът на коя страница е. Надпис с {скоби} се попълва с числа или имена в момента.';

/**
 * The guide as the Markdown section the brief embeds. Dense on purpose: the brief is pasted
 * into a chat window by hand and read by a model, so the words and what they do earn their
 * place and nothing else does.
 */
export function systemGuideSection(lang: 'en' | 'bg'): string {
  const bg = lang === 'bg';
  const lines: string[] = [];

  lines.push(bg ? '## Екраните и точните имена по тях' : '## The screens, and what everything on them is called');
  lines.push('');
  lines.push(bg ? INTRO_BG : INTRO_EN);

  for (const screen of SYSTEM_GUIDE) {
    lines.push('');
    lines.push(`### \`${screen.route}\` — ${bg ? screen.nameBg : screen.nameEn}`);
    lines.push(bg ? screen.purposeBg : screen.purposeEn);
    for (const section of screen.sections) {
      lines.push('');
      lines.push(`**${bg ? section.bg : section.en}**`);
      for (const control of section.controls) {
        const word = KIND_WORDS[control.kind][lang];
        lines.push(`- "${bg ? control.bg : control.en}" (${word}) — ${bg ? control.doesBg : control.doesEn}`);
      }
    }
  }

  return lines.join('\n');
}
