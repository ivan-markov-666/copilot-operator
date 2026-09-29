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
 * It is an inventory, and was not always. It began as a selection — the controls an operator is
 * usually told to press — on the reasoning that the prompt is long; but Kerrigan is also told
 * never to name a control the guide does not list, so every control left out was one she would
 * say did not exist. An audit on 2026-09-29 found 144 of 283 labelled controls missing, most of
 * them the newest ones. Now `test/guide.check.ts` reads every page and fails on a control that is
 * neither here nor exempted there with a reason, and it holds the brief under the size a chat will
 * accept. Keep the sentences short: every one of them is pasted into a chat. Take each label from
 * `web/lib/strings.ts` character for character, because the check is unforgiving about it, and say
 * when a control is only there under a condition (a view, a tick, a state).
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
      'The links down the side of every page, the language switch, the round to-the-top and to-the-bottom buttons of a long page, the box that asks before anything irreversible, and the banner of steps waiting for a decision, which appears on every page.',
    purposeBg:
      'Връзките отстрани на всяка страница, смяната на езика, кръглите бутони към началото и края на дълга страница, прозорецът, който пита преди нещо необратимо, и лентата със стъпки, чакащи решение, която се появява на всяка страница.',
    sections: [
      {
        headingKey: 'nav.label',
        en: 'Main',
        bg: 'Основно',
        controls: [
          {
            key: 'a11y.skip',
            kind: 'link',
            en: 'Skip to the content',
            bg: 'Към съдържанието',
            doesEn:
              'For keyboard users: the first Tab on a page jumps past the navigation to the content.',
            doesBg:
              'За клавиатура: първото Tab на страницата прескача навигацията към съдържанието.',
          },
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
          {
            key: 'scroll.top',
            kind: 'button',
            en: 'To the top of the page',
            bg: 'Най-горе на страницата',
            doesEn: 'The round ↑ button at the right edge of a page more than two screens long, such as the register: back to the top.',
            doesBg: 'Кръглият бутон ↑ в десния край на страница, по-дълга от два екрана, например регистъра: обратно най-горе.',
          },
          {
            key: 'scroll.bottom',
            kind: 'button',
            en: 'To the bottom of the page',
            bg: 'Най-долу на страницата',
            doesEn: 'The round ↓ button under it: to the bottom of the page.',
            doesBg: 'Кръглият бутон ↓ под него: най-долу на страницата.',
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
          {
            key: 'dialog.noticeTitle',
            kind: 'note',
            en: 'Notice',
            bg: 'Съобщение',
            doesEn:
              'The title of a box that only informs; its one button is "OK".',
            doesBg:
              'Заглавието на прозорец, който само съобщава; единственият му бутон е „Добре“.',
          },
        ],
      },
      {
        headingKey: 'approval.waitingHere',
        en: 'A step is waiting for your decision',
        bg: 'Стъпка чака вашето решение',
        controls: [
          {
            key: 'approval.title',
            kind: 'note',
            en: 'Step {n} is waiting for you',
            bg: 'Стъпка {n} чака вашето решение',
            doesEn:
              'At the top of every page: one card per waiting step, with its session (a link) and the exact command. The browser tab shows "(n) waiting for you".',
            doesBg:
              'Горе на всяка страница: по една карта за всяка чакаща стъпка, със сесията ѝ (връзка) и точната команда. Разделът на браузъра показва „(n) чака вас“.',
          },
          {
            key: 'approval.run',
            kind: 'button',
            en: 'Run',
            bg: 'Изпълни',
            doesEn:
              'Runs that one command now and lets the task carry on to its next step.',
            doesBg:
              'Изпълнява тази една команда сега и оставя задачата да продължи към следващата си стъпка.',
          },
          {
            key: 'approval.runAll',
            kind: 'button',
            en: 'Run this and the rest without asking',
            bg: 'Изпълни без да питаш повече',
            doesEn:
              'Runs it and stops asking until this run ends, after an "are you sure". A downloading command then follows Settings → Execution. Not offered on one.',
            doesBg:
              'Изпълнява я и спира да пита до края на пускането, след „сигурен ли си“. Команда, която тегли, после следва Настройки → Изпълнение. Не се предлага на такава.',
          },
          {
            key: 'approval.network',
            kind: 'note',
            en: 'This command downloads from the internet. A run that does not ask still stops for this one (unless Settings → Execution says otherwise), because a later step could run what arrived. Run it only if you know what it fetches and why.',
            bg: 'Тази команда тегли от интернет. Пускане без питане също спира за нея (освен ако Настройки → Изпълнение не казва друго), защото следваща стъпка може да пусне изтегленото. Изпълнете я само ако знаете какво тегли и защо.',
            doesEn:
              'On a step that downloads: it waits here even in a run that does not ask, unless Settings → Execution says to refuse or run it. localhost and npm or dotnet installs never wait.',
            doesBg:
              'На стъпка, която тегли: чака тук дори при пускане без питане, освен ако Настройки → Изпълнение казва да се отказва или изпълнява. localhost и инсталации през npm или dotnet никога не чакат.',
          },
          {
            key: 'approval.skip',
            kind: 'button',
            en: 'Skip',
            bg: 'Пропусни',
            doesEn:
              'Leaves that command unrun and moves the task on to its next step; the chat is told a person skipped it.',
            doesBg:
              'Оставя командата неизпълнена и придвижва задачата към следващата стъпка; чатът научава, че човек я е пропуснал.',
          },
          {
            key: 'approval.abort',
            kind: 'button',
            en: 'Abort task',
            bg: 'Прекрати задачата',
            doesEn:
              'Ends the whole task here, aborted; its remaining steps are not run.',
            doesBg:
              'Прекратява цялата задача тук; останалите ѝ стъпки не се изпълняват.',
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
            key: 'plan.title',
            kind: 'note',
            en: 'A plan written by a chat model',
            bg: 'План, написан от чат модел',
            doesEn:
              'The heading of the page.',
            doesBg:
              'Заглавието на страницата.',
          },
          {
            key: 'plan.briefAsks',
            kind: 'note',
            en: 'The brief does the asking',
            bg: 'Заданието пита вместо вас',
            doesEn:
              'Says the brief itself asks the questions; the operator only copies it into a chat.',
            doesBg:
              'Казва, че заданието само задава въпросите; операторът само го копира в чат.',
          },
          {
            key: 'plan.persona',
            kind: 'note',
            en: 'Kerrigan, the persona: two levels',
            bg: 'Kerrigan, персоната: две нива',
            doesEn:
              'The heading above "Software level (fixed)" and the three editable boxes below it.',
            doesBg:
              'Заглавието над „Софтуерно ниво (фиксирано)“ и трите полета за редакция под него.',
          },
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
        en: 'How work is done here: the organisation and the projects',
        bg: 'Как се работи тук: организацията и проектите',
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
        headingKey: 'plan.personaPart',
        en: 'How the tasks are carried out: the agent\'s persona',
        bg: 'Как се изпълняват задачите: персоната на агента',
        controls: [
          {
            key: 'plan.personaPick',
            kind: 'select',
            en: 'choose one to put it in the box',
            bg: 'изберете, за да я поставите в полето',
            doesEn:
              'The empty choice of the saved-persona menu; picking a persona puts its text in the box (after a question if the box has text).',
            doesBg:
              'Празният избор в менюто със запазени персони; изборът на персона слага текста ѝ в полето (след въпрос, ако полето има текст).',
          },
          {
            key: 'plan.personaNone',
            kind: 'select',
            en: 'none saved yet',
            bg: 'още няма запазени',
            doesEn:
              'Shown in that menu while no persona has been saved.',
            doesBg:
              'Показва се в менюто, докато няма запазена персона.',
          },
          {
            key: 'plan.personaSaved',
            kind: 'select',
            en: 'Saved personas',
            bg: 'Запазени персони',
            doesEn: 'Chooses a saved persona and puts it in the box below, which is saved at once; the choice shows which saved persona the box matches.',
            doesBg: 'Избира запазена персона и я поставя в полето отдолу, което се запазва веднага; изборът показва на коя запазена персона отговаря полето.',
          },
          {
            key: 'plan.personaNamePlaceholder',
            kind: 'field',
            en: 'a name for the persona in the box, e.g. playwright-tests',
            bg: 'име за персоната в полето, напр. playwright-tests',
            doesEn: 'The name to keep the persona in the box under.',
            doesBg: 'Името, под което да се запази персоната от полето.',
          },
          {
            key: 'plan.personaSaveAs',
            kind: 'button',
            en: 'Save under this name',
            bg: 'Запази под това име',
            doesEn: 'Keeps a copy of the persona in the box under that name, replacing one of the same name after asking.',
            doesBg: 'Запазва копие на персоната от полето под това име, като пита, преди да замени персона със същото име.',
          },
          {
            key: 'plan.personaDelete',
            kind: 'button',
            en: 'Delete the chosen one',
            bg: 'Изтрий избраната',
            doesEn: 'Deletes the saved persona the box matches; the box itself is not changed.',
            doesBg: 'Изтрива запазената персона, на която отговаря полето; самото поле не се променя.',
          },
          {
            key: 'plan.ctxClear',
            kind: 'button',
            en: 'Empty this',
            bg: 'Изпразни',
            doesEn:
              'The same button under the second box: wipes the persona, so the brief asks for one again before any plan is written. A session already imported keeps the persona it was created with.',
            doesBg:
              'Същият бутон под второто поле: изтрива персоната, за да поиска заданието нова, преди да се пише план. Вече импортирана сесия пази персоната, с която е създадена.',
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
            doesEn: 'The same button under the third box: wipes the description of the work in hand.',
            doesBg: 'Същият бутон под третото поле: изтрива описанието на текущата работа.',
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
            key: 'plan.drop',
            kind: 'field',
            en: 'Drop a .json file here',
            bg: 'Пуснете .json файл тук',
            doesEn:
              'The answer box also takes a .json file dropped onto it.',
            doesBg:
              'Полето за отговора приема и .json файл, пуснат върху него.',
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
            key: 'plan.notes',
            kind: 'note',
            en: 'Notes from the model',
            bg: 'Бележки от модела',
            doesEn:
              'After "Check it": what the chat model wrote for the operator in the plan.',
            doesBg:
              'След „Провери“: какво е написал чат моделът за оператора в плана.',
          },
          {
            key: 'plan.warnings',
            kind: 'note',
            en: 'Worth knowing',
            bg: 'Добре е да знаете',
            doesEn:
              'After "Check it": things that do not stop the import but are worth reading.',
            doesBg:
              'След „Провери“: неща, които не спират внасянето, но е добре да се прочетат.',
          },
          {
            key: 'plan.duplicates',
            kind: 'note',
            en: 'This is already here',
            bg: 'Това вече го има',
            doesEn:
              'After "Check it": the same sessions were imported before; "Create the sessions and tasks" then asks before creating copies. Each row links to the earlier session.',
            doesBg:
              'След „Провери“: същите сесии вече са внасяни; „Създай сесиите и задачите“ тогава пита, преди да създаде копия. Всеки ред води към по-ранната сесия.',
          },
          {
            key: 'plan.duplicateRow',
            kind: 'link',
            en: '{name} — {tasks} identical task(s), imported {when}',
            bg: '{name} — {tasks} еднакви задачи, внесени {when}',
            doesEn:
              'One row per earlier copy: opens that session.',
            doesBg:
              'По един ред за всяко по-ранно копие: отваря тази сесия.',
          },
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
            key: 'plan.imported',
            kind: 'note',
            en: 'Created {sessions} session(s) with {tasks} task(s). Nothing has started.',
            bg: 'Създадени са {sessions} сесия(и) с {tasks} задача(и). Нищо не е стартирано.',
            doesEn:
              'After creating: how many sessions and tasks were made. Nothing has started — the operator starts them.',
            doesBg:
              'След създаването: колко сесии и задачи са направени. Нищо не е пуснато — операторът ги пуска.',
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
        headingKey: null,
        en: 'Shown only when this browser has not been given the API key',
        bg: 'Показва се само когато този браузър още няма ключа за API-то',
        controls: [
          {
            key: 'home.noToken',
            kind: 'note',
            en: 'This browser does not have the key to the API yet.',
            bg: 'Този браузър още няма ключа за API-то.',
            doesEn: 'The page was started without the API key; start it with npm start, which hands the key over.',
            doesBg: 'Страницата е пусната без ключа за API-то; пуснете я с npm start, който го предава.',
          },
        ],
      },
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
            key: 'batch.selectNone',
            kind: 'button',
            en: 'Select none',
            bg: 'Изчисти избора',
            doesEn:
              'Clears every tick.',
            doesBg:
              'Маха всички отметки.',
          },
          {
            key: 'batch.modelKeep',
            kind: 'select',
            en: 'Each session keeps its own',
            bg: 'Всяка сесия със своя',
            doesEn:
              'The empty choice of both model menus: every session keeps the model it has.',
            doesBg:
              'Празният избор в двете менюта за модел: всяка сесия запазва модела си.',
          },
          {
            key: 'batch.reviewModelKeep',
            kind: 'select',
            en: 'Each session keeps its own',
            bg: 'Всяка сесия си остава със своя',
            doesEn:
              'The same empty choice in the review model menu.',
            doesBg:
              'Същият празен избор в менюто за модела на рецензията.',
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
            doesEn:
              'Starts the ticked sessions one after another and runs every command without asking. It asks "are you sure" first, unless Settings → Execution → "Starting a run without supervision" is "Start it without asking".',
            doesBg:
              'Пуска отметнатите сесии една след друга и изпълнява всяка команда без питане. Първо пита „сигурен ли си“, освен ако Настройки → Изпълнение → „Пускане без надзор“ е „Пускай, без да питаш“.',
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
            key: 'batch.notStartedTitle',
            kind: 'note',
            en: 'The run did not start',
            bg: 'Пускането не тръгна',
            doesEn:
              'The box over the two run buttons when a press was refused, with the reason under it. Nothing was opened and nothing ran; read the reason before pressing again.',
            doesBg:
              'Карето над двата бутона за пускане, когато натискането е отказано, с причината под него. Нищо не е отваряно и нищо не е пускано; прочети причината, преди да натиснеш пак.',
          },
          {
            key: 'batch.notStartedIsolation',
            kind: 'link',
            en: 'Settings → "Where the bot runs": choose where the bot runs, or accept unattended runs without isolation',
            bg: 'Настройки → „Къде върви ботът“: изберете къде върви ботът или приемете пускане без надзор без изолация',
            doesEn:
              'Under that box when the refusal is about isolation: opens /defaults, where "Where the bot runs" decides whether a run with nobody watching may start here.',
            doesBg:
              'Под това каре, когато отказът е заради изолацията: отваря /defaults, където „Къде върви ботът“ решава дали тук може да тръгне пускане без надзор.',
          },
          {
            key: 'batch.stop',
            kind: 'button',
            en: 'Stop after the current step',
            bg: 'Спри след текущата стъпка',
            doesEn:
              'While a run is going: ends it after the current step. The task it interrupts ends aborted, part-done — offer the pause instead when the operator only wants to think.',
            doesBg:
              'Докато върви пускане: спира го след текущата стъпка. Прекъснатата задача завършва прекратена, наполовина — предложи паузата, ако операторът само иска да помисли.',
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
        headingKey: 'home.sessions',
        en: 'Sessions',
        bg: 'Сесии',
        controls: [
          {
            key: 'home.selectAll',
            kind: 'checkbox',
            en: 'Select every session',
            bg: 'Избери всички сесии',
            doesEn:
              'The tick box in the table heading: ticks every session that is not running. Each row has its own tick box, and the session name is a link to its page.',
            doesBg:
              'Отметката в заглавието на таблицата: отметва всички сесии, които не вървят. Всеки ред има своя отметка, а името на сесията е връзка към страницата ѝ.',
          },
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
    route: '/sessions/view?id=…',
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
            key: 'session.crumb',
            kind: 'link',
            en: 'Sessions',
            bg: 'Сесии',
            doesEn:
              'Above the name, back to the sessions list on `/`.',
            doesBg:
              'Над името, обратно към списъка със сесии на `/`.',
          },
          {
            key: 'session.group',
            kind: 'field',
            en: 'Share a conversation',
            bg: 'Споделяне на разговор',
            doesEn:
              'Sessions with the same name here share one Copilot conversation; empty gives this one its own.',
            doesBg:
              'Сесиите с едно и също име тук споделят един разговор в Copilot; празно дава на тази собствен.',
          },
          {
            key: 'session.run',
            kind: 'button',
            en: 'Run {n} task(s)',
            bg: 'Пусни {n} задача(и)',
            doesEn:
              'Starts the queued tasks and runs every command without asking. It asks "are you sure" first, unless Settings → Execution → "Starting a run without supervision" is "Start it without asking".',
            doesBg:
              'Пуска чакащите задачи и изпълнява всяка команда без питане. Първо пита „сигурен ли си“, освен ако Настройки → Изпълнение → „Пускане без надзор“ е „Пускай, без да питаш“.',
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
            key: 'session.modeUnattended',
            kind: 'badge',
            en: 'not asking any more',
            bg: 'вече не пита',
            doesEn:
              'Beside "Stop after current step" while this run no longer asks before each command.',
            doesBg:
              'До „Спри след текущата стъпка“, докато това пускане вече не пита преди всяка команда.',
          },
          {
            key: 'home.delete',
            kind: 'button',
            en: 'Delete',
            bg: 'Изтрий',
            doesEn:
              'Deletes this session after one question; not while it runs. The run folders and the chats stay.',
            doesBg:
              'Изтрива тази сесия след един въпрос; не докато върви. Папките на пусканията и чатовете остават.',
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
            key: 'model.followsDefault',
            kind: 'select',
            en: 'from Settings: {name}',
            bg: 'от Настройки: {name}',
            doesEn:
              'The first choice of the model menu: this session follows the model chosen in Settings, whatever it is at run time.',
            doesBg:
              'Първият избор в менюто за модел: сесията следва модела, избран в Настройки, какъвто е при пускането.',
          },
          {
            key: 'model.default',
            kind: 'select',
            en: 'whatever the chat is set to (default)',
            bg: 'каквото е настроено в чата (по подразбиране)',
            doesEn:
              'Leaves the chat on whatever model it is already set to.',
            doesBg:
              'Оставя чата на модела, на който вече е.',
          },
          {
            key: 'model.makeDefault',
            kind: 'button',
            en: 'Start new sessions on {name}',
            bg: 'Новите сесии да тръгват с {name}',
            doesEn:
              'Makes the model chosen here the one every new session starts on (Settings → "Model for new sessions").',
            doesBg:
              'Прави избрания тук модел този, с който тръгва всяка нова сесия (Настройки → „Модел за новите сесии“).',
          },
          {
            key: 'model.clearDefault',
            kind: 'button',
            en: 'Stop setting a model on new sessions',
            bg: 'Да не се задава модел на новите сесии',
            doesEn:
              'Stops Settings from setting a model on new sessions.',
            doesBg:
              'Спира Настройки да задават модел на новите сесии.',
          },
          {
            key: 'model.showDetails',
            kind: 'disclosure',
            en: 'show what the picker said',
            bg: 'покажи какво каза изборът',
            doesEn:
              'Unfolds what Copilot\'s model picker showed when it was last read.',
            doesBg:
              'Разгъва какво е показал изборът на модел в Copilot при последното четене.',
          },
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
            key: 'l1.show',
            kind: 'disclosure',
            en: 'show the prompt',
            bg: 'покажи prompt-а',
            doesEn:
              'Unfolds the base prompt this session sends first.',
            doesBg:
              'Разгъва основния prompt, който тази сесия изпраща първи.',
          },
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
            key: 'vcs.branches',
            kind: 'note',
            en: 'How branches are made',
            bg: 'Как се правят клоновете',
            doesEn:
              'The heading above the two branch radios; they, "Where this session starts" and "Commit when a task finishes" appear only once "Work on branches and commit what was changed" is ticked.',
            doesBg:
              'Заглавието над двата радио бутона за клони; те, „Откъде тръгва тази сесия“ и „Комит при приключване на задача“ се появяват само след отметка на „Работи по клонове…“.',
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
            key: 'vcs.branchName',
            kind: 'field',
            en: 'Name of that one branch',
            bg: 'Име на този един клон',
            doesEn:
              'Only with "One branch for the whole session": the name of that branch, without the prefix; empty builds it from the session name.',
            doesBg:
              'Само с „Един клон за цялата сесия“: името на този клон, без представката; празно го сглобява от името на сесията.',
          },
          {
            key: 'vcs.startFrom',
            kind: 'note',
            en: 'Where this session starts',
            bg: 'Откъде тръгва тази сесия',
            doesEn:
              'The heading above the three start radios.',
            doesBg:
              'Заглавието над трите радио бутона за начало.',
          },
          {
            key: 'vcs.startBranch',
            kind: 'radio',
            en: 'From a local branch (main)',
            bg: 'От локален клон (main)',
            doesEn:
              'The session starts from the local branch in "Local branch to start from" (main when empty). In a plan: "startFrom": "branch" with "baseBranch".',
            doesBg:
              'Сесията тръгва от локалния клон в „Локален клон, от който да тръгне“ (main, ако е празно). В план: "startFrom": "branch" с "baseBranch".',
          },
          {
            key: 'vcs.startPrevious',
            kind: 'radio',
            en: 'From the previous session’s branch',
            bg: 'От клона на предната сесия',
            doesEn:
              'The session carries on from the end of the branch of the session that last committed work in the same repository — in a run, the one before it. In a plan: "startFrom": "previous-session".',
            doesBg:
              'Сесията продължава от края на клона на сесията, която последна е комитнала работа в същото хранилище — при пускане, предната. В план: "startFrom": "previous-session".',
          },
          {
            key: 'vcs.startHead',
            kind: 'radio',
            en: 'From wherever the repository is (as until now)',
            bg: 'Откъдето е хранилището (както досега)',
            doesEn: 'The old behaviour, and what a session without a choice does: whatever branch is checked out at its first run, often the one the previous session left.',
            doesBg: 'Старото поведение и това, което прави сесия без избор: какъвто клон е избран при първото ѝ пускане, често оставеният от предната сесия.',
          },
          {
            key: 'vcs.baseBranch',
            kind: 'field',
            en: 'Local branch to start from',
            bg: 'Локален клон, от който да тръгне',
            doesEn:
              'The branch "From a local branch (main)" starts from, and where a chain begins with no earlier session; main when empty. Hidden with "From wherever the repository is (as until now)".',
            doesBg:
              'Клонът, от който тръгва „От локален клон (main)“, и откъдето започва верига без по-ранна сесия; main, ако е празно. Скрит при „Откъдето е хранилището (както досега)“.',
          },
          {
            key: 'vcs.startedPrevious',
            kind: 'note',
            en: 'Started from the end of {branch} ({commit}), the branch of the session “{name}”.',
            bg: 'Тръгна от края на {branch} ({commit}) — клона на сесията „{name}“.',
            doesEn:
              'After the first run: where the session actually started — the end of the previous session\'s branch.',
            doesBg:
              'След първото пускане: откъде сесията реално е тръгнала — от края на клона на предната сесия.',
          },
          {
            key: 'vcs.startedBranch',
            kind: 'note',
            en: 'Started from the local branch {branch} ({commit}).',
            bg: 'Тръгна от локалния клон {branch} ({commit}).',
            doesEn:
              'After the first run: it started from that local branch.',
            doesBg:
              'След първото пускане: тръгнала е от този локален клон.',
          },
          {
            key: 'vcs.startedHead',
            kind: 'note',
            en: 'Started from where the repository was ({commit}).',
            bg: 'Тръгна оттам, където беше хранилището ({commit}).',
            doesEn:
              'After the first run: it started from wherever the repository was.',
            doesBg:
              'След първото пускане: тръгнала е оттам, където е било хранилището.',
          },
          {
            key: 'vcs.commit',
            kind: 'checkbox',
            en: 'Commit when a task finishes',
            bg: 'Комит при приключване на задача',
            doesEn: 'One local commit per task whatever the outcome; unticked leaves the changes loose in the working tree.',
            doesBg: 'По един локален комит на задача, независимо от изхода; без отметка промените остават свободни в работното дърво.',
          },
          {
            key: 'vcs.ready',
            kind: 'note',
            en: 'Ready: {dir}, currently on {branch}.',
            bg: 'Готово: {dir}, в момента на {branch}.',
            doesEn:
              'Version control can work: the folder and the branch HEAD is on.',
            doesBg:
              'Контролът на версиите може да работи: папката и клонът, на който е HEAD.',
          },
          {
            key: 'vcs.notReady',
            kind: 'note',
            en: 'Version control is on, but it cannot work yet.',
            bg: 'Контролът на версиите е включен, но още не може да работи.',
            doesEn:
              'It is on but cannot work yet; the reason follows (for example uncommitted changes, or no such branch).',
            doesBg:
              'Включен е, но още не може да работи; следва причината (например некомитнати промени или липсващ клон).',
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
            key: 'mirror.listDirs',
            kind: 'button',
            en: 'List directories',
            bg: 'Покажи директориите',
            doesEn:
              'Lists the root\'s folders, to pick what to include.',
            doesBg:
              'Изброява папките в корена, за да се избере какво да се включи.',
          },
          {
            key: 'mirror.rules',
            kind: 'note',
            en: 'What is copied from it',
            bg: 'Какво се копира от него',
            doesEn:
              'The heading above the include and exclude lists.',
            doesBg:
              'Заглавието над списъците за включване и изключване.',
          },
          {
            key: 'mirror.include',
            kind: 'field',
            en: 'Include (one per line; a directory includes everything beneath it)',
            bg: 'Включи (по една на ред; директория включва всичко под нея)',
            doesEn:
              'One folder or file per line; a folder brings everything beneath it.',
            doesBg:
              'По една папка или файл на ред; папка включва всичко под нея.',
          },
          {
            key: 'mirror.exclude',
            kind: 'field',
            en: 'Exclude (one per line)',
            bg: 'Изключи (по една на ред)',
            doesEn:
              'One per line: what to leave out even inside an included folder.',
            doesBg:
              'По един на ред: какво да се изостави дори в включена папка.',
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
            key: 'tree.reload',
            kind: 'button',
            en: 'Read the folders again',
            bg: 'Прочети папките отново',
            doesEn:
              'Reads the folder tree again from disk.',
            doesBg:
              'Прочита отново дървото с папки от диска.',
          },
          {
            key: 'tree.exclude',
            kind: 'button',
            en: 'carve this folder out',
            bg: 'изрежи тази папка',
            doesEn:
              'The "−" on a tree row: carves that folder out of an included one.',
            doesBg:
              '„−“ на ред в дървото: изважда тази папка от включена.',
          },
          {
            key: 'tree.unexclude',
            kind: 'button',
            en: 'stop carving this folder out',
            bg: 'спри да изрязваш тази папка',
            doesEn:
              'Puts a carved-out folder back.',
            doesBg:
              'Връща изважданата папка обратно.',
          },
          {
            key: 'tree.fold',
            kind: 'button',
            en: 'fold',
            bg: 'сгъни',
            doesEn:
              'Folds a tree row.',
            doesBg:
              'Сгъва ред в дървото.',
          },
          {
            key: 'tree.unfold',
            kind: 'button',
            en: 'unfold',
            bg: 'разгъни',
            doesEn:
              'Unfolds a tree row.',
            doesBg:
              'Разгъва ред в дървото.',
          },
          {
            key: 'mirror.check',
            kind: 'button',
            en: 'Check what would be copied',
            bg: 'Провери какво ще се копира',
            doesEn:
              'Counts what would be copied, without copying: files and size.',
            doesBg:
              'Преброява какво би се копирало, без да копира: файлове и размер.',
          },
          {
            key: 'mirror.showFiles',
            kind: 'disclosure',
            en: 'show the list',
            bg: 'покажи списъка',
            doesEn:
              'Under that count: the list of files.',
            doesBg:
              'Под това преброяване: списъкът с файлове.',
          },
          {
            key: 'mirror.showSkipped',
            kind: 'disclosure',
            en: 'show what was left out',
            bg: 'покажи какво остава навън',
            doesEn:
              'Under that count: what was left out, and why.',
            doesBg:
              'Под това преброяване: какво е изоставено и защо.',
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
            key: 'chain.title',
            kind: 'note',
            en: 'What happens when a task does not finish',
            bg: 'Какво става, когато задача не приключи успешно',
            doesEn:
              'The heading above the two radios that decide whether a failed task stops the queue.',
            doesBg:
              'Заглавието над двата радио бутона, които решават дали провалена задача спира опашката.',
          },
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
            key: 'story.hide',
            kind: 'button',
            en: 'Hide what happened',
            bg: 'Скрий какво се случи',
            doesEn:
              'The same button once the story is open: folds it away again.',
            doesBg:
              'Същият бутон, когато историята е отворена: сгъва я обратно.',
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
            key: 'task.cancel',
            kind: 'button',
            en: 'Cancel',
            bg: 'Отказ',
            doesEn:
              'Leaves the edit without saving.',
            doesBg:
              'Излиза от редакцията, без да записва.',
          },
          {
            key: 'task.save',
            kind: 'button',
            en: 'Save',
            bg: 'Запази',
            doesEn:
              'On a task that has not run yet: stores the edit.',
            doesBg:
              'При задача, която още не е вървяла: записва промяната.',
          },
          {
            key: 'task.saveAndRerun',
            kind: 'button',
            en: 'Save and queue it again',
            bg: 'Запази и върни в опашката',
            doesEn:
              'On a task that has already run: stores the edit and queues it again; the earlier attempt is kept. On a done task the new attempt builds on its work. It does not start it.',
            doesBg:
              'При вече изпълнена задача: записва промяната и я връща в опашката; предишният опит се пази. При готова задача новият опит стъпва върху свършеното. Не я пуска.',
          },
          {
            key: 'task.branch',
            kind: 'field',
            en: 'Branch for this task',
            bg: 'Клон за тази задача',
            doesEn:
              'In the edit, with version control on: the branch for this task.',
            doesBg:
              'В редакцията, с включен контрол на версиите: клонът на тази задача.',
          },
          {
            key: 'task.commitMessage',
            kind: 'field',
            en: 'Commit message',
            bg: 'Текст на комита',
            doesEn:
              'In the edit, with version control on: the commit message\'s subject and body.',
            doesBg:
              'В редакцията, с включен контрол на версиите: заглавието и тялото на комита.',
          },
          {
            key: 'task.continue',
            kind: 'button',
            en: 'Continue in the same chat',
            bg: 'Продължи в същия чат',
            doesEn:
              'On a task that stopped before it finished (its limit, the bot stopping, the operator): queues it to carry on in the same chat and branch. Then "Run {n} task(s)".',
            doesBg:
              'На задача, спряла преди да приключи (лимит, спрял бот, оператор): нарежда я да продължи в същия чат и клон. После „Пусни {n} задача(и)“.',
          },
          {
            key: 'task.rerun',
            kind: 'button',
            en: 'Run again',
            bg: 'Пусни отново',
            doesEn:
              'Puts a finished task back in the queue unchanged, to start afresh; the earlier attempt is kept with its own log. It only queues.',
            doesBg:
              'Връща приключила задача в опашката без промяна, да тръгне отначало; предишният опит се пази със собствен дневник. Само я нарежда.',
          },
          {
            key: 'restore.button',
            kind: 'button',
            en: 'Restore',
            bg: 'Върни',
            doesEn:
              'With version control on and a recorded start: puts the repository back to the code as it was before that task, on a new branch. Nothing is deleted.',
            doesBg:
              'С включен контрол на версиите и записано начало: връща хранилището към кода отпреди тази задача, на нов клон. Нищо не се изтрива.',
          },
          {
            key: 'restart.button',
            kind: 'button',
            en: 'Run again from here',
            bg: 'Пусни отново оттук',
            doesEn:
              'Puts the code back, queues that task and every task after it — later sessions of its run included — and starts at once, in the mode that run had.',
            doesBg:
              'Връща кода, нарежда отново тази задача и всички след нея — включително следващите сесии от пускането ѝ — и тръгва веднага, в режима на онова пускане.',
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
            doesEn:
              'Inside the "everything executed, and the files" fold: the whole run of that task as plain text, saved to copilot-operator-logs on the Desktop, Explorer open on it. The file to ask for.',
            doesBg:
              'В раздела „всичко изпълнено и файловете“: цялото изпълнение на задачата като чист текст, записано в copilot-operator-logs на десктопа, с отворен Explorer. Файлът, който да поискаш.',
          },
          {
            key: 'task.files',
            kind: 'disclosure',
            en: 'everything executed, and the files',
            bg: 'всичко изпълнено и файловете',
            doesEn:
              'The fold on the task card that holds "save the log" and the saved reports, files and replies of the run.',
            doesBg:
              'Сгъваемият раздел на картата на задачата, в който са „запази log-а“ и записаните отчети, файлове и отговори.',
          },
          {
            key: 'task.attempts',
            kind: 'disclosure',
            en: 'earlier attempts ({n})',
            bg: 'предишни опити ({n})',
            doesEn:
              'On a task run more than once: the earlier attempts, each with "save this attempt\'s log" and "download plan, work and runner of this attempt".',
            doesBg:
              'На задача, пускана повече от веднъж: по-ранните опити, всеки със „запази log-а на този опит“ и „изтегли план, работа и runner на този опит“.',
          },
          {
            key: 'task.attemptText',
            kind: 'disclosure',
            en: 'the task as this attempt ran it',
            bg: 'задачата, както е изпълнена в този опит',
            doesEn:
              'Inside an earlier attempt: the task text as that attempt ran it.',
            doesBg:
              'В по-ранен опит: текстът на задачата, както го е изпълнил.',
          },
          {
            key: 'task.promptAndL2',
            kind: 'disclosure',
            en: 'task prompt and level 2',
            bg: 'задачата и ниво 2',
            doesEn:
              'The task\'s prompt and its level 2.',
            doesBg:
              'Prompt-ът на задачата и ниво 2 за нея.',
          },
          {
            key: 'task.l2Show',
            kind: 'disclosure',
            en: 'level 2 for this task ({n} line(s))',
            bg: 'ниво 2 за тази задача ({n} реда)',
            doesEn:
              'On a queued task: unfolds the level 2 text it will be sent with.',
            doesBg:
              'На чакаща задача: разгъва текста на ниво 2, с който ще бъде изпратена.',
          },
          {
            key: 'task.firstMessage',
            kind: 'disclosure',
            en: 'the exact first message that opened this task',
            bg: 'точното първо съобщение, с което започна задачата',
            doesEn:
              'The exact first message that opened the task.',
            doesBg:
              'Точното първо съобщение, с което е започнала задачата.',
          },
          {
            key: 'task.finalReply',
            kind: 'disclosure',
            en: 'the last message Copilot sent',
            bg: 'последното съобщение от Copilot',
            doesEn:
              'The last message Copilot sent.',
            doesBg:
              'Последното съобщение от Copilot.',
          },
          {
            key: 'vcs.taskFiles',
            kind: 'disclosure',
            en: '{n} file(s) changed',
            bg: '{n} променени файла',
            doesEn:
              'The files the task\'s commit changed.',
            doesBg:
              'Файловете, които комитът на задачата е променил.',
          },
          {
            key: 'diff.open',
            kind: 'button',
            en: 'See the changes ({n} file(s))',
            bg: 'Виж промените ({n} файла)',
            doesEn:
              'Where the attempt committed: every file it changed, before on the left and after on the right, scrolling together. Also under each earlier attempt.',
            doesBg:
              'Където опитът е комитнал: всеки променен файл, преди вляво и след вдясно, превъртани заедно. И под всеки по-ранен опит.',
          },
          {
            key: 'task.deviations',
            kind: 'disclosure',
            en: 'Not as the task said ({n})',
            bg: 'Не както задачата казва ({n})',
            doesEn:
              'What the model says it did not do as the task said, and why.',
            doesBg:
              'Какво моделът казва, че не е направил както е казано в задачата, и защо.',
          },
          {
            key: 'review.findings',
            kind: 'disclosure',
            en: 'what it found ({n})',
            bg: 'какво намери ({n})',
            doesEn:
              'What the independent review found.',
            doesBg:
              'Какво е намерила независимата рецензия.',
          },
          {
            key: 'task.disputes',
            kind: 'disclosure',
            en: 'Review findings the model disputed ({n})',
            bg: 'Оспорени находки на рецензията ({n})',
            doesEn:
              'Review findings the model disputed, with its evidence.',
            doesBg:
              'Находки на рецензията, които моделът е оспорил, с доказателствата си.',
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
            doesEn:
              'Stopped before it finished: by "Stop", by "Abort task" on a waiting step, or because the bot was stopped mid-task (then its work is committed on its branch at the next start).',
            doesBg:
              'Спряна преди да приключи: със „Спри“, с „Прекрати задачата“ на чакаща стъпка или защото ботът е спрян посред задача (тогава работата ѝ се комитва на клона ѝ при следващото пускане).',
          },
          {
            key: 'status.limit-reached',
            kind: 'badge',
            en: 'limit reached',
            bg: 'достигнат лимит',
            doesEn:
              'The task ran out of its allowed messages or minutes (Settings → Execution) before it could close. "Continue in the same chat" carries it on.',
            doesBg:
              'Задачата е изчерпала позволените си съобщения или минути (Настройки → Изпълнение), преди да приключи. „Продължи в същия чат“ я продължава.',
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
            key: 'l2.saveAs',
            kind: 'button',
            en: 'Save as preset',
            bg: 'Запази като шаблон',
            doesEn:
              'Saves the level 2 text as a preset under a name it asks for.',
            doesBg:
              'Запазва текста на ниво 2 като шаблон под име, което пита.',
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
          {
            key: 'checks.remove',
            kind: 'button',
            en: 'Remove',
            bg: 'Махни',
            doesEn:
              'Removes that check.',
            doesBg:
              'Премахва тази проверка.',
          },
          {
            key: 'checks.cwd',
            kind: 'field',
            en: 'In folder',
            bg: 'В папка',
            doesEn:
              'The folder the check\'s command runs in; empty is the project.',
            doesBg:
              'Папката, в която върви командата на проверката; празно е проектът.',
          },
          {
            key: 'checks.file',
            kind: 'field',
            en: 'File',
            bg: 'Файл',
            doesEn:
              'For a file check: the file.',
            doesBg:
              'За проверка на файл: файлът.',
          },
          {
            key: 'checks.value',
            kind: 'field',
            en: 'Text',
            bg: 'Текст',
            doesEn:
              'For an output or file-content check: the text to look for.',
            doesBg:
              'За проверка на изход или съдържание: текстът, който се търси.',
          },
          {
            key: 'checks.fromReview',
            kind: 'disclosure',
            en: 'From reviews ({n})',
            bg: 'От рецензии ({n})',
            doesEn:
              'Checks the reviewers suggested; they defer to the next review rather than failing the task alone.',
            doesBg:
              'Проверки, предложени от рецензентите; не провалят задачата сами, а оставят решението на следващата рецензия.',
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
          {
            key: 'export.all',
            kind: 'button',
            en: 'Select all',
            bg: 'Избери всички',
            doesEn:
              'Ticks every task for the download.',
            doesBg:
              'Отметва всички задачи за изтеглянето.',
          },
          {
            key: 'export.none',
            kind: 'button',
            en: 'Clear the selection',
            bg: 'Изчисти избора',
            doesEn:
              'Clears the ticks.',
            doesBg:
              'Маха отметките.',
          },
        ],
      },
      {
        headingKey: 'live.title',
        en: 'Live',
        bg: 'На живо',
        controls: [
          {
            key: 'live.title',
            kind: 'note',
            en: 'Live',
            bg: 'На живо',
            doesEn:
              'The panel at the bottom: the session\'s events as they happen — steps, approvals, commits, warnings.',
            doesBg:
              'Панелът най-долу: събитията на сесията, както стават — стъпки, одобрения, комити, предупреждения.',
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
      'Every task of every session in one place — running now, queued next, already done — with the filters, the downloads, and the panel that continues the queue with exactly the tasks the operator ticks. "Continue" and "Choose tasks" exist only in the "Flow" view; tell the operator to be on it first.',
    purposeBg:
      'Всички задачи от всички сесии на едно място — какво върви сега, какво чака и какво е направено — с филтрите, изтеглянията и панела, който продължава опашката с точно отметнатите от оператора задачи. „Продължи“ и „Избери задачи“ има само в изгледа „Поток“; кажи на оператора първо да е на него.',
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
            doesEn:
              'Reads the task list from the server at once; the page also re-reads it by itself every few seconds.',
            doesBg:
              'Прочита списъка със задачи от сървъра веднага; страницата и без това се обновява сама на няколко секунди.',
          },
          {
            key: 'reg.newSession',
            kind: 'button',
            en: 'New session',
            bg: 'Нова сесия',
            doesEn:
              'Goes to the "New session" form on `/`.',
            doesBg:
              'Отива на формата „Нова сесия“ на `/`.',
          },
          {
            key: 'reg.newTask',
            kind: 'select',
            en: 'New task',
            bg: 'Нова задача',
            doesEn:
              'With "choose a session…" open, picking a session opens that session\'s page at its "Add a task" form.',
            doesBg:
              'С отворено „изберете сесия…“, изборът на сесия отваря страницата ѝ на формата „Добави задача“.',
          },
          {
            key: 'reg.newTaskPick',
            kind: 'select',
            en: 'choose a session…',
            bg: 'изберете сесия…',
            doesEn:
              'The empty choice of "New task"; pick a session instead of it.',
            doesBg:
              'Празният избор на „Нова задача“; изберете сесия вместо него.',
          },
          {
            key: 'reg.total',
            kind: 'badge',
            en: 'tasks',
            bg: 'задачи',
            doesEn:
              'The counter for every task in the register, whatever the filters are set to.',
            doesBg:
              'Броячът на всички задачи в регистъра, независимо какво са филтрите.',
          },
          {
            key: 'reg.done',
            kind: 'badge',
            en: 'done',
            bg: 'готови',
            doesEn:
              'The counter for the tasks that ended with the work actually done.',
            doesBg:
              'Броячът на задачите, приключили с наистина свършена работа.',
          },
          {
            key: 'reg.runningCount',
            kind: 'badge',
            en: 'running now',
            bg: 'в момента',
            doesEn:
              'The counter for the tasks being worked on, including one stopped for approval.',
            doesBg:
              'Броячът на задачите, по които се работи, включително спряна за одобрение.',
          },
          {
            key: 'reg.open',
            kind: 'badge',
            en: 'ahead',
            bg: 'предстоят',
            doesEn:
              'The counter for the tasks that have not started and are still waiting in a queue.',
            doesBg:
              'Броячът на задачите, които още не са започнали и чакат в опашка.',
          },
          {
            key: 'reg.failedCount',
            kind: 'badge',
            en: 'did not finish',
            bg: 'не са приключили',
            doesEn:
              'The counter for every ending that is not done: not done, failed, aborted or out of limit.',
            doesBg:
              'Броячът на всички краища, различни от готова: неизпълнени, провалени, прекратени или с достигнат лимит.',
          },
        ],
      },
      {
        headingKey: 'reg.filterSession',
        en: 'Session',
        bg: 'Сесия',
        controls: [
          {
            key: 'reg.allSessions',
            kind: 'select',
            en: 'all sessions',
            bg: 'всички сесии',
            doesEn:
              'The "Session" filter\'s empty choice: every session. Pick one session to narrow the page to it.',
            doesBg:
              'Празният избор на филтъра „Сесия“: всички сесии. Изберете една сесия, за да свиете страницата до нея.',
          },
          {
            key: 'reg.filterStatus',
            kind: 'select',
            en: 'Status',
            bg: 'Състояние',
            doesEn:
              'Narrows the page to the tasks in one state, using the same words as the badges.',
            doesBg:
              'Свива страницата до задачите в едно състояние, със същите думи като етикетите.',
          },
          {
            key: 'reg.allStatuses',
            kind: 'select',
            en: 'all statuses',
            bg: 'всички състояния',
            doesEn:
              'The "Status" filter\'s empty choice: every state.',
            doesBg:
              'Празният избор на филтъра „Състояние“: всички състояния.',
          },
          {
            key: 'reg.search',
            kind: 'field',
            en: 'Search in the titles and the summaries',
            bg: 'Търсене в заглавията и обясненията',
            doesEn:
              'Keeps only the rows whose title, summary, stop reason or session name contains what is typed.',
            doesBg:
              'Оставя само редовете, в чието заглавие, обяснение, причина за спиране или име на сесия се среща написаното.',
          },
          {
            key: 'reg.clear',
            kind: 'button',
            en: 'Clear the filters',
            bg: 'Изчисти филтрите',
            doesEn:
              'Empties the session, status and search filters in one press.',
            doesBg:
              'Изчиства наведнъж филтрите по сесия, по състояние и търсенето.',
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
            doesEn:
              'Shows the register as three threads — "Running now", "What is next", "What has been done" — and is the only view with "Continue", the run controls and "Choose tasks".',
            doesBg:
              'Показва регистъра като три нишки — „В момента“, „Какво следва“, „Какво е направено“ — и е единственият изглед с „Продължи“, бутоните за пускането и „Избери задачи“.',
          },
          {
            key: 'reg.groupBy',
            kind: 'tab',
            en: 'By run',
            bg: 'По изпълнение',
            doesEn:
              'Groups the same tasks under the run that started them, newest first, each with its own plan · work · runner links.',
            doesBg:
              'Групира същите задачи под пускането, което ги е стартирало, най-новото отгоре, всяко със свои връзки план · работа · runner.',
          },
          {
            key: 'reg.viewList',
            kind: 'tab',
            en: 'List',
            bg: 'Списък',
            doesEn:
              'Shows the same tasks as one table, for scanning many of them at once; the title opens the task.',
            doesBg:
              'Показва същите задачи като една таблица, за да се преглеждат много наведнъж; заглавието отваря задачата.',
          },
          {
            key: 'reg.runGroup',
            kind: 'note',
            en: 'Started together',
            bg: 'Пуснати заедно',
            doesEn:
              'In "By run": the heading above the runs.',
            doesBg:
              'В „По изпълнение“: заглавието над пусканията.',
          },
          {
            key: 'reg.notInARun',
            kind: 'note',
            en: 'Not part of a run',
            bg: 'Извън изпълнение',
            doesEn:
              'In "By run": the tasks that were started on their own, not as part of a run.',
            doesBg:
              'В „По изпълнение“: задачите, пуснати сами, не като част от пускане.',
          },
        ],
      },
      {
        headingKey: null,
        en: 'On every task row, in every view',
        bg: 'На всеки ред със задача, във всеки изглед',
        controls: [
          {
            key: 'reg.openTask',
            kind: 'link',
            en: 'task details',
            bg: 'детайли на задачата',
            doesEn:
              'Opens that task\'s card on its session page, where it can be edited, run again or continued.',
            doesBg:
              'Отваря картата на задачата на страницата на сесията ѝ, където може да се редактира, пусне отново или продължи.',
          },
          {
            key: 'home.col.chat',
            kind: 'link',
            en: 'Chat',
            bg: 'Чат',
            doesEn:
              'Opens the Copilot conversation the task ran in.',
            doesBg:
              'Отваря разговора в Copilot, в който е вървяла задачата.',
          },
          {
            key: 'reg.activeNow',
            kind: 'note',
            en: 'Running now',
            bg: 'В момента',
            doesEn:
              'In the "Flow" view: the thread of what is running this minute.',
            doesBg:
              'В изгледа „Поток“: нишката на това, което върви в момента.',
          },
          {
            key: 'save.log',
            kind: 'button',
            en: 'save the log',
            bg: 'запази log-а',
            doesEn:
              'Saves the runner\'s log of that task\'s latest attempt to the Desktop and opens Explorer on it.',
            doesBg:
              'Запазва log-а на runner-а от последния опит на задачата на десктопа и отваря Explorer върху него.',
          },
          {
            key: 'reg.exportTitle',
            kind: 'note',
            en: 'Download as JSON',
            bg: 'Изтегли като JSON',
            doesEn:
              'The words in front of the three downloads "plan", "work" and "runner" of the row (and of a run, on its heading in "By run").',
            doesBg:
              'Думите пред трите изтегляния „план“, „работа“ и „runner“ на реда (и на пускане, на заглавието му в „По изпълнение“).',
          },
          {
            key: 'reg.exportPlan',
            kind: 'link',
            en: 'plan',
            bg: 'план',
            doesEn:
              'Downloads what was asked: the task in the plan format, with the edits made in the interface and its earlier attempts\' text. Imports again.',
            doesBg:
              'Изтегля какво е поискано: задачата във формата на плана, с редакциите от интерфейса и текста на по-ранните опити. Внася се отново.',
          },
          {
            key: 'reg.exportDomain',
            kind: 'link',
            en: 'work',
            bg: 'работа',
            doesEn:
              'Downloads what happened to the work: what the chat tried, what was done, and why it did not end done — earlier attempts included.',
            doesBg:
              'Изтегля какво се случи с работата: какво е пробвал чатът, какво е направено и защо не е завършила готова — с по-ранните опити.',
          },
          {
            key: 'reg.exportBot',
            kind: 'link',
            en: 'runner',
            bg: 'runner',
            doesEn:
              'Downloads what the runner did: the environment, every event and step with its exit code, the review machinery.',
            doesBg:
              'Изтегля какво е направил runner-ът: средата, всяко събитие и стъпка с кода на изход, механиката на рецензията.',
          },
          {
            key: 'diff.open',
            kind: 'button',
            en: 'See the changes ({n} file(s))',
            bg: 'Виж промените ({n} файла)',
            doesEn:
              'Where the attempt committed: every file it changed, before on the left and after on the right, scrolling together.',
            doesBg:
              'Където опитът е комитнал: всеки променен файл, преди вляво и след вдясно, превъртани заедно.',
          },
          {
            key: 'story.show',
            kind: 'button',
            en: 'What happened',
            bg: 'Какво се случи',
            doesEn:
              'Unfolds the task\'s whole story under the row.',
            doesBg:
              'Разгъва цялата история на задачата под реда.',
          },
          {
            key: 'story.showLive',
            kind: 'button',
            en: 'What is happening now',
            bg: 'Какво се случва в момента',
            doesEn:
              'While the task runs: the same, live — it follows the newest entry and shows the running command like a terminal. Tell the operator to watch here.',
            doesBg:
              'Докато задачата върви: същото, на живо — следва най-новото и показва текущата команда като терминал. Кажи на оператора да гледа тук.',
          },
          {
            key: 'story.hide',
            kind: 'button',
            en: 'Hide what happened',
            bg: 'Скрий какво се случи',
            doesEn:
              'The same button once the story is open: folds it away again.',
            doesBg:
              'Същият бутон, когато историята е отворена: сгъва я обратно.',
          },
          {
            key: 'reg.fixPrompt',
            kind: 'button',
            en: 'Fix the prompt and queue it again',
            bg: 'Поправи prompt-а и върни в опашката',
            doesEn:
              'On a row that did not end done, its session idle: rewrite the task\'s text and queue it again. It does not start it.',
            doesBg:
              'На ред, който не е завършил готов, при спряна сесия: пренапишете текста на задачата и я върнете в опашката. Не я пуска.',
          },
          {
            key: 'reg.newPrompt',
            kind: 'button',
            en: 'Give it a new prompt and queue it again',
            bg: 'Нов prompt и върни в опашката',
            doesEn:
              'On a row that ended done, its session idle: a new instruction for the task, built on its finished work (same branch). It does not start it.',
            doesBg:
              'На ред, завършил готов, при спряна сесия: нова инструкция за задачата, върху свършената работа (същия клон). Не я пуска.',
          },
          {
            key: 'restore.button',
            kind: 'button',
            en: 'Restore',
            bg: 'Върни',
            doesEn:
              'As on a task card: back to the code before this task, on a new branch. On a row that ran, when its session is idle.',
            doesBg:
              'Както на картата на задача: връща кода отпреди задачата, на нов клон. На ред, който е вървял, когато сесията му стои.',
          },
          {
            key: 'restart.button',
            kind: 'button',
            en: 'Run again from here',
            bg: 'Пусни отново оттук',
            doesEn:
              'As on a task card: puts the code back, queues this task and the rest of its run, and starts at once in that run\'s mode.',
            doesBg:
              'Както на картата на задача: връща кода, нарежда задачата и останалото от пускането ѝ и тръгва веднага в режима на онова пускане.',
          },
          {
            key: 'row.info',
            kind: 'button',
            en: 'What are these?',
            bg: 'Какво са тези?',
            doesEn:
              'A small round i at the end of the row. Opens a panel saying what each of the row\'s links gives you, and which of the three JSON files to reach for first.',
            doesBg:
              'Малко кръгло i в края на реда. Отваря панел, който казва какво дава всяка от връзките на реда и кой от трите JSON файла да се вземе първи.',
          },
          {
            key: 'reg.attempts',
            kind: 'disclosure',
            en: 'this is attempt {n} — see the {m} before it',
            bg: 'това е опит {n} — виж {m}-те преди него',
            doesEn:
              'On a task run more than once: unfolds the earlier attempts, each with its status, its reason, "save this attempt\'s log" and "download plan, work and runner of this attempt".',
            doesBg:
              'На задача, пускана повече от веднъж: разгъва по-ранните опити, всеки със състоянието, причината, „запази log-а на този опит“ и „изтегли план, работа и runner на този опит“.',
          },
          {
            key: 'reg.attemptsOne',
            kind: 'disclosure',
            en: 'this is attempt {n} — see the one before it',
            bg: 'това е опит {n} — виж този преди него',
            doesEn:
              'The same fold when there is one earlier attempt.',
            doesBg:
              'Същият сгъваем раздел, когато има един по-ранен опит.',
          },
          {
            key: 'save.attemptLog',
            kind: 'button',
            en: 'save this attempt\'s log',
            bg: 'запази log-а на този опит',
            doesEn:
              'Inside the earlier attempts: saves the log of that attempt, rather than of the latest one, to the Desktop.',
            doesBg:
              'В по-ранните опити: запазва на десктопа log-а на този опит, а не на последния.',
          },
          {
            key: 'save.attemptRecord',
            kind: 'button',
            en: 'download plan, work and runner of this attempt',
            bg: 'изтегли план, работа и runner на този опит',
            doesEn:
              'Inside the earlier attempts: that attempt as it ran — plan, work, runner — as one file. A failed attempt also keeps them as plan.json, work.json and runner.json in its run folder.',
            doesBg:
              'В по-ранните опити: този опит, както е вървял — план, работа, runner — в един файл. Провален опит ги пази и като plan.json, work.json и runner.json в папката на пускането си.',
          },
          {
            key: 'reg.stopped',
            kind: 'note',
            en: 'stopped: {reason}',
            bg: 'спряна: {reason}',
            doesEn:
              'In red on the row: why that task or attempt stopped without the work being done.',
            doesBg:
              'В червено на реда: защо задачата или опитът е спрял, без работата да е свършена.',
          },
          {
            key: 'reg.retriedFreshDone',
            kind: 'badge',
            en: 'blocked, then done in a fresh chat ({n}×)',
            bg: 'блокира, после готова в нов чат ({n}×)',
            doesEn:
              'The task was blocked and then finished in a new conversation, so the chat was the cause, not the task.',
            doesBg:
              'Задачата е блокирала и после е станала готова в нов разговор — значи чатът е бил причината, не задачата.',
          },
          {
            key: 'reg.retriedFreshStill',
            kind: 'badge',
            en: 'still blocked after {n} fresh chat(s)',
            bg: 'още блокирана след {n} нови чата',
            doesEn:
              'Fresh conversations did not help, so the cause is in the task text, the checks or the machine.',
            doesBg:
              'Новите разговори не са помогнали — причината е в текста на задачата, в проверките или в машината.',
          },
        ],
      },
      {
        headingKey: 'story.prompt',
        en: 'The task, as given',
        bg: 'Заданието, както е дадено',
        controls: [
          {
            key: 'story.showChat',
            kind: 'checkbox',
            en: 'the conversation',
            bg: 'разговорът',
            doesEn:
              'Shows or hides the messages sent and the replies.',
            doesBg:
              'Показва или скрива изпратените съобщения и отговорите.',
          },
          {
            key: 'story.showCommands',
            kind: 'checkbox',
            en: 'the commands and their output',
            bg: 'командите и изходът им',
            doesEn:
              'Shows or hides the commands that ran and their output.',
            doesBg:
              'Показва или скрива изпълнените команди и изхода им.',
          },
          {
            key: 'story.live',
            kind: 'badge',
            en: 'live',
            bg: 'на живо',
            doesEn:
              'Pulsing while the task runs. The list then stays at the newest entry, and the running command is shown open with its output following its last line, like a terminal.',
            doesBg:
              'Пулсира, докато задачата върви. Списъкът тогава стои на най-новото, а текущата команда е отворена и изходът ѝ следва последния ред, като терминал.',
          },
          {
            key: 'story.follow',
            kind: 'button',
            en: '↓ follow the newest',
            bg: '↓ следвай най-новото',
            doesEn:
              'Appears when the operator scrolled up in a live story: goes back to the newest line and follows it again.',
            doesBg:
              'Появява се, когато операторът е превъртял нагоре в история на живо: връща на най-новия ред и следва отново.',
          },
          {
            key: 'story.showOutput',
            kind: 'button',
            en: 'show output ({n} chars)',
            bg: 'покажи изхода ({n} знака)',
            doesEn:
              'Under a command: unfolds its output (the end of it, for a very long one).',
            doesBg:
              'Под команда: разгъва изхода ѝ (края му, ако е много дълъг).',
          },
          {
            key: 'story.hideOutput',
            kind: 'button',
            en: 'hide output',
            bg: 'скрий изхода',
            doesEn:
              'Folds that output away again.',
            doesBg:
              'Сгъва този изход обратно.',
          },
          {
            key: 'story.showText',
            kind: 'button',
            en: 'show text ({n} chars)',
            bg: 'покажи текста ({n} знака)',
            doesEn:
              'Under a message or a reply: unfolds its full text.',
            doesBg:
              'Под съобщение или отговор: разгъва пълния текст.',
          },
          {
            key: 'story.hideText',
            kind: 'button',
            en: 'hide text',
            bg: 'скрий текста',
            doesEn:
              'Folds that text away again.',
            doesBg:
              'Сгъва този текст обратно.',
          },
        ],
      },
      {
        headingKey: 'reg.upcoming',
        en: 'What is next',
        bg: 'Какво следва',
        controls: [
          {
            key: 'reg.interruptedTitle',
            kind: 'note',
            en: 'The bot stopped in the middle of the work.',
            bg: 'Ботът спря посред работата.',
            doesEn:
              'After the bot stopped under a run (power, Ctrl+C, a crash): the stopped tasks\' work is kept, and "Continue" carries them on where they stopped.',
            doesBg:
              'След като ботът е спрял посред пускане (ток, Ctrl+C, срив): свършеното е запазено, а „Продължи“ продължава спрелите задачи оттам, където са спрели.',
          },
          {
            key: 'batch.pause',
            kind: 'button',
            en: 'Pause after this task',
            bg: 'Пауза след тази задача',
            doesEn:
              'As on `/`: holds the run after the task in flight finishes properly. Press it first after a failure you want to think about.',
            doesBg:
              'Както на `/`: задържа пускането, след като текущата задача приключи както трябва. Натиснете го първо след провал, над който искате да помислите.',
          },
          {
            key: 'batch.resume',
            kind: 'button',
            en: 'Take the hold off',
            bg: 'Махни паузата',
            doesEn:
              'As on `/`: the queue carries on.',
            doesBg:
              'Както на `/`: опашката продължава.',
          },
          {
            key: 'batch.stop',
            kind: 'button',
            en: 'Stop after the current step',
            bg: 'Спри след текущата стъпка',
            doesEn:
              'As on `/`: stops after the current step; the task in flight ends aborted.',
            doesBg:
              'Както на `/`: спира след текущата стъпка; текущата задача завършва прекратена.',
          },
          {
            key: 'reg.continue',
            kind: 'button',
            en: 'Continue: run the {n} queued task(s) in {s} session(s)',
            bg: 'Продължи: пусни {n} чакащи задачи в {s} сесии',
            doesEn:
              'Opens the "Before it continues" panel. It starts nothing yet.',
            doesBg:
              'Отваря панела „Преди да продължи“. Още нищо не пуска.',
          },
          {
            key: 'reg.continueWithFailed',
            kind: 'button',
            en: 'Continue: run {f} unfinished and {n} queued task(s) in {s} session(s)',
            bg: 'Продължи: пусни {f} недовършени и {n} чакащи задачи в {s} сесии',
            doesEn:
              'The same button when a failed task of a chained session would go back into the queue with the queued ones.',
            doesBg:
              'Същият бутон, когато провалена задача от сесия-верига би се върнала в опашката заедно с чакащите.',
          },
          {
            key: 'reg.continuePanelTitle',
            kind: 'note',
            en: 'Before it continues',
            bg: 'Преди да продължи',
            doesEn:
              'The panel\'s heading. Every candidate has a tick box — failed tasks of chains, failed independent ones, the queued — all ticked at first; the run takes exactly the ticked, the rest stay where they are.',
            doesBg:
              'Заглавието на панела. Всеки кандидат има отметка — провалени от вериги, провалени независими, чакащите — отначало всички отметнати; пускането взима точно отметнатите, останалите остават, където са.',
          },
          {
            key: 'reg.pickOnly',
            kind: 'button',
            en: 'only this one',
            bg: 'само тази',
            doesEn:
              'Beside each task in that panel: unticks everything else, so the run takes this task alone — the way to run only the task whose prompt was just fixed.',
            doesBg:
              'До всяка задача в панела: маха отметките от всички други, така че пускането взима само нея — начинът да се пусне само задачата, чийто prompt току-що е поправен.',
          },
          {
            key: 'reg.pickAll',
            kind: 'button',
            en: 'All of them',
            bg: 'Всички',
            doesEn:
              'In that panel: ticks every task.',
            doesBg:
              'В панела: отметва всички задачи.',
          },
          {
            key: 'reg.pickNone',
            kind: 'button',
            en: 'None',
            bg: 'Нито една',
            doesEn:
              'In that panel: unticks every task (the start buttons then do nothing until one is ticked).',
            doesBg:
              'В панела: маха всички отметки (бутоните за пускане тогава не действат, докато не се отметне поне една).',
          },
          {
            key: 'reg.fixPrompt',
            kind: 'button',
            en: 'Fix the prompt and queue it again',
            bg: 'Поправи prompt-а и върни в опашката',
            doesEn:
              'Beside a failed task in that panel: rewrite its text first; it comes back ticked and queued.',
            doesBg:
              'До провалена задача в панела: първо пренапишете текста ѝ; тя се връща отметната и в опашката.',
          },
          {
            key: 'reg.continueGap',
            kind: 'note',
            en: '“{task}” ({session}) is part of a chain and runs without “{before}”, which comes before it. Run it alone only if it does not need that task’s work.',
            bg: '„{task}“ ({session}) е част от верига и тръгва без „{before}“, която е преди нея. Пуснете я сама, само ако не ѝ трябва работата на онази задача.',
            doesEn:
              'Said in that panel when a ticked task of a chain runs without an earlier task of its session. A warning, not a refusal.',
            doesBg:
              'Казва се в панела, когато отметната задача от верига тръгва без по-ранна задача от сесията си. Предупреждение, не отказ.',
          },
          {
            key: 'batch.runName',
            kind: 'field',
            en: 'Name of this run',
            bg: 'Име на това пускане',
            doesEn:
              'In that panel: the name of this run, suggested; the register groups by it and the downloads are named after it.',
            doesBg:
              'В панела: името на това пускане, предложено; регистърът групира по него и изтеглянията се именуват по него.',
          },
          {
            key: 'reg.continueUnattended',
            kind: 'button',
            en: 'Continue without asking',
            bg: 'Продължи без да пита',
            doesEn:
              'Starts exactly the ticked tasks without asking (after "are you sure" unless Settings say otherwise). Stopped ones (aborted, limit reached) continue where they stopped; failed or blocked ones start afresh.',
            doesBg:
              'Пуска точно отметнатите задачи без питане (след „сигурен ли си“, освен ако Настройките казват друго). Спрелите (прекратени, с лимит) продължават откъдето спряха; провалените и блокираните тръгват отначало.',
          },
          {
            key: 'reg.continueGo',
            kind: 'button',
            en: 'Continue, asking before each command',
            bg: 'Продължи, с питане преди всяка команда',
            doesEn:
              'Starts exactly the ticked tasks but stops for approval before every command.',
            doesBg:
              'Пуска точно отметнатите задачи, но спира за одобрение преди всяка команда.',
          },
          {
            key: 'dialog.cancel',
            kind: 'button',
            en: 'Cancel',
            bg: 'Отказ',
            doesEn:
              'Closes the panel without starting anything.',
            doesBg:
              'Затваря панела, без да пуска нищо.',
          },
        ],
      },
      {
        headingKey: 'reg.past',
        en: 'What has been done',
        bg: 'Какво е направено',
        controls: [
          {
            key: 'reg.pick',
            kind: 'button',
            en: 'Choose tasks',
            bg: 'Избери задачи',
            doesEn:
              'Above the finished tasks, in the "Flow" view. Puts a tick box on every task that ran, across every run, so several can be picked at once.',
            doesBg:
              'Над свършените задачи, в изгледа „Поток“. Слага отметка на всяка изпълнена задача, през всички пускания, за да могат да се изберат няколко наведнъж.',
          },
          {
            key: 'reg.bundle',
            kind: 'button',
            en: 'Download plan, work and runner for the {n} chosen, as one file',
            bg: 'Изтегли план, работа и runner за избраните {n}, в един файл',
            doesEn:
              'Once something is ticked: one JSON with all three views of exactly the ticked tasks — the file to ask for when working out why something went as it did. Say how many to tick.',
            doesBg:
              'Щом има отметнато: един JSON с трите изгледа на точно отметнатите задачи — файлът, който се иска, когато се търси защо нещо е тръгнало така. Кажи колко да се отметнат.',
          },
          {
            key: 'reg.pickDone',
            kind: 'button',
            en: 'Done choosing',
            bg: 'Готово с избора',
            doesEn:
              'Leaves the choosing mode and clears the ticks.',
            doesBg:
              'Излиза от режима на избор и маха отметките.',
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
            doesEn:
              'Saves the rewritten task text and puts the task back into its queue with it; the failed attempt stays on its record. Level 2, the checks and the git names are untouched. Then "Continue" with "only this one" runs it alone.',
            doesBg:
              'Запазва пренаписания текст и връща задачата в опашката с него; провалилият се опит остава в историята ѝ. Ниво 2, проверките и git имената остават каквито са. После „Продължи“ със „само тази“ я пуска сама.',
          },
          {
            key: 'dialog.cancel',
            kind: 'button',
            en: 'Cancel',
            bg: 'Отказ',
            doesEn:
              'Closes the box and changes nothing.',
            doesBg:
              'Затваря прозореца и не променя нищо.',
          },
        ],
      },
      {
        headingKey: 'diff.title',
        en: 'Changes in "{title}"',
        bg: 'Промени в „{title}“',
        controls: [
          {
            key: 'diff.nextChange',
            kind: 'button',
            en: 'Next change',
            bg: 'Следваща промяна',
            doesEn:
              'Jumps to the next edit (key n).',
            doesBg:
              'Отива на следващата промяна (клавиш n).',
          },
          {
            key: 'diff.prevChange',
            kind: 'button',
            en: 'Previous change',
            bg: 'Предишна промяна',
            doesEn:
              'The one before (key p).',
            doesBg:
              'Предишната (клавиш p).',
          },
          {
            key: 'diff.nextFile',
            kind: 'button',
            en: 'Next file',
            bg: 'Следващ файл',
            doesEn:
              'The next file in the list on the left (key ]).',
            doesBg:
              'Следващият файл от списъка вляво (клавиш ]).',
          },
          {
            key: 'diff.prevFile',
            kind: 'button',
            en: 'Previous file',
            bg: 'Предишен файл',
            doesEn:
              'The file before (key [).',
            doesBg:
              'Предишният файл (клавиш [).',
          },
          {
            key: 'diff.gap',
            kind: 'button',
            en: '⋯ {n} unchanged line(s) — show them',
            bg: '⋯ {n} непроменени реда — покажи ги',
            doesEn:
              'Opens a folded stretch of unchanged lines.',
            doesBg:
              'Отваря сгънат участък непроменени редове.',
          },
          {
            key: 'diff.whole',
            kind: 'checkbox',
            en: 'Show the whole file',
            bg: 'Покажи целия файл',
            doesEn:
              'Every line, nothing folded.',
            doesBg:
              'Всички редове, нищо сгънато.',
          },
          {
            key: 'diff.wrap',
            kind: 'checkbox',
            en: 'Wrap long lines',
            bg: 'Пренасяй дългите редове',
            doesEn:
              'Off: long lines stay on one line and the table scrolls sideways.',
            doesBg:
              'Изключено: дългите редове остават на един ред и таблицата се превърта настрани.',
          },
          {
            key: 'diff.close',
            kind: 'button',
            en: 'Close',
            bg: 'Затвори',
            doesEn:
              'Closes the view (Esc).',
            doesBg:
              'Затваря изгледа (Esc).',
          },
        ],
      },
      {
        headingKey: 'metrics.title',
        en: 'How the bot is doing',
        bg: 'Как се справя ботът',
        // A table of figures at the foot of the register, read-only; the heading says what it is.
        controls: [],
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
            key: 'def.title',
            kind: 'note',
            en: 'What every new session starts with',
            bg: 'С какво тръгва всяка нова сесия',
            doesEn:
              'The page\'s top heading.',
            doesBg:
              'Горното заглавие на страницата.',
          },
          {
            key: 'def.saveAnyway',
            kind: 'button',
            en: 'Save',
            bg: 'Запази',
            doesEn:
              'Under each block: does nothing new — everything on this page saves itself; it is there for those who look for one.',
            doesBg:
              'Под всеки блок: не прави нищо ново — всичко на страницата се записва само; стои там за тези, които го търсят.',
          },
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
          {
            key: 'proj.folders',
            kind: 'disclosure',
            en: 'Folders that go to the Desktop',
            bg: 'Папки, които отиват на Desktop-а',
            doesEn:
              'On each project: which of its folders go to the Desktop copy — the same include and exclude lists and folder tree as on a session page.',
            doesBg:
              'На всеки проект: кои папки отиват в копието на Desktop-а — същите списъци за включване и изключване и дърво с папки като на страницата на сесия.',
          },
          {
            key: 'proj.affects',
            kind: 'note',
            en: 'What this changes, and what it does not',
            bg: 'Какво променя това и какво не',
            doesEn:
              'Says what changing the project folder changes (new sessions) and what it does not (sessions that exist).',
            doesBg:
              'Казва какво променя смяната на папката на проекта (новите сесии) и какво не (съществуващите).',
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
          {
            key: 'proj.otherRemove',
            kind: 'button',
            en: 'Remove',
            bg: 'Махни',
            doesEn:
              'On an extra project: removes it from the list (nothing on disk is touched).',
            doesBg:
              'На допълнителен проект: маха го от списъка (нищо на диска не се пипа).',
          },
          {
            key: 'proj.toSessions',
            kind: 'button',
            en: 'To the sessions',
            bg: 'Към сесиите',
            doesEn:
              'Goes to the sessions list on `/`.',
            doesBg:
              'Отива на списъка със сесии на `/`.',
          },
          {
            key: 'proj.toImport',
            kind: 'button',
            en: 'To the plan import',
            bg: 'Към внасянето на план',
            doesEn:
              'Goes to the plan import on `/import`.',
            doesBg:
              'Отива на внасянето на план на `/import`.',
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
            key: 'exec.maxIterations',
            kind: 'field',
            en: 'Most messages to the chat in one task',
            bg: 'Най-много съобщения към чата в една задача',
            doesEn: 'How many rounds one task may take (default 60) before it stops as limit reached; saved as you type.',
            doesBg: 'Колко кръга може да отнеме една задача (по подразбиране 60), преди да спре като достигнат лимит; запазва се, докато пишете.',
          },
          {
            key: 'exec.maxRunMinutes',
            kind: 'field',
            en: 'Longest a task may run',
            bg: 'Най-дълго време за една задача',
            doesEn: 'How many minutes one task may run (default 240) before it stops as limit reached; saved as you type.',
            doesBg: 'Колко минути може да върви една задача (по подразбиране 240), преди да спре като достигнат лимит; запазва се, докато пишете.',
          },
          {
            key: 'exec.replyTimeout',
            kind: 'field',
            en: 'How long to wait for a reply from the chat',
            bg: 'Колко да се чака отговор от чата',
            doesEn:
              'Seconds to wait for a chat reply (default 900); a reply not finished by then fails the task with "Copilot did not finish a reply within …".',
            doesBg:
              'Секунди чакане на отговор от чата (по подразбиране 900); незавършен дотогава отговор проваля задачата с „Copilot did not finish a reply within …“.',
          },
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
            kind: 'select',
            en: 'Where the bot runs',
            bg: 'Къде върви ботът',
            doesEn:
              'What contains this runner, as the operator says. With "Nowhere in particular — this account" unattended runs are refused; "This account — I accept unattended runs without isolation" allows them on the operator\'s responsibility.',
            doesBg:
              'Какво огражда този runner, по думите на оператора. С „Никъде специално — в този акаунт“ пусканията без надзор се отказват; „В този акаунт — приемам пускане без надзор без изолация“ ги позволява на отговорност на оператора.',
          },
          {
            key: 'exec.isolationNone',
            kind: 'select',
            en: 'Nowhere in particular — this account',
            bg: 'Никъде специално — в този акаунт',
            doesEn:
              'The default: no unattended runs.',
            doesBg:
              'По подразбиране: без пускания без надзор.',
          },
          {
            key: 'exec.isolationNoneAccepted',
            kind: 'select',
            en: 'This account — I accept unattended runs without isolation',
            bg: 'В този акаунт — приемам пускане без надзор без изолация',
            doesEn:
              'Unattended runs allowed in this account, on the operator\'s responsibility.',
            doesBg:
              'Пусканията без надзор са позволени в този акаунт, на отговорност на оператора.',
          },
          {
            key: 'exec.isolationAccount',
            kind: 'select',
            en: 'A separate low-privilege Windows account',
            bg: 'Отделен Windows акаунт с малки права',
            doesEn:
              'The bot runs as a separate low-privilege account.',
            doesBg:
              'Ботът върви като отделен акаунт с малки права.',
          },
          {
            key: 'exec.isolationSandbox',
            kind: 'select',
            en: 'Windows Sandbox',
            bg: 'Windows Sandbox',
            doesEn:
              'The bot runs in Windows Sandbox.',
            doesBg:
              'Ботът върви в Windows Sandbox.',
          },
          {
            key: 'exec.isolationVm',
            kind: 'select',
            en: 'A virtual machine',
            bg: 'Виртуална машина',
            doesEn:
              'The bot runs in a virtual machine.',
            doesBg:
              'Ботът върви във виртуална машина.',
          },
          {
            key: 'exec.startMode',
            kind: 'select',
            en: 'Starting a run without supervision',
            bg: 'Пускане без надзор',
            doesEn:
              'Whether the unattended run buttons ask "are you sure" first or simply start. Step by step stays beside them.',
            doesBg:
              'Дали бутоните за пускане без надзор първо питат „сигурен ли си“ или просто тръгват. „Стъпка по стъпка“ остава до тях.',
          },
          {
            key: 'exec.startModeAsk',
            kind: 'select',
            en: 'Ask "are you sure" every time',
            bg: 'Питай „сигурен ли си“ всеки път',
            doesEn:
              'The default: every unattended start asks "are you sure" first.',
            doesBg:
              'По подразбиране: всяко пускане без надзор първо пита „сигурен ли си“.',
          },
          {
            key: 'exec.startModeAuto',
            kind: 'select',
            en: 'Start it without asking',
            bg: 'Пускай, без да питаш',
            doesEn:
              'Unattended starts go at once, without the question.',
            doesBg:
              'Пусканията без надзор тръгват веднага, без въпроса.',
          },
          {
            key: 'exec.networkFetch',
            kind: 'select',
            en: 'A command that downloads, in a run without supervision',
            bg: 'Команда, която тегли от интернет, при пускане без надзор',
            doesEn:
              'What a run without supervision does with Invoke-WebRequest, curl and the like: wait for the operator, refuse it back to the chat, or run it unread. Step by step shows every command anyway.',
            doesBg:
              'Какво прави пускане без надзор с Invoke-WebRequest, curl и подобни: чака оператора, отказва я обратно на чата или я изпълнява непрочетена. Стъпка по стъпка така или иначе показва всяка команда.',
          },
          {
            key: 'exec.networkFetchAsk',
            kind: 'select',
            en: 'Wait for me on the approval screen',
            bg: 'Чакай ме на екрана за одобрение',
            doesEn:
              'The default: a downloading command waits on the approval banner even in a run without supervision.',
            doesBg:
              'По подразбиране: команда, която тегли, чака в лентата за одобрение дори при пускане без надзор.',
          },
          {
            key: 'exec.networkFetchRefuse',
            kind: 'select',
            en: 'Refuse it and tell the chat why — the run never waits',
            bg: 'Откажи я и кажи на чата защо — пускането никога не чака',
            doesEn:
              'It is refused and the chat is told why and what to do instead; the run never waits.',
            doesBg:
              'Отказва се и чатът научава защо и какво да направи вместо това; пускането никога не чака.',
          },
          {
            key: 'exec.networkFetchRun',
            kind: 'select',
            en: 'Run it without asking',
            bg: 'Изпълни я, без да питаш',
            doesEn:
              'It runs without anyone reading it. Only on a machine where that is acceptable.',
            doesBg:
              'Изпълнява се, без някой да я е прочел. Само на машина, където това е приемливо.',
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
          {
            key: 'presets.show',
            kind: 'disclosure',
            en: 'show',
            bg: 'покажи',
            doesEn:
              'On a saved preset: unfolds its text.',
            doesBg:
              'На запазен шаблон: разгъва текста му.',
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
            key: 'ap.theme',
            kind: 'note',
            en: 'Theme',
            bg: 'Тема',
            doesEn:
              'The heading above the two theme buttons.',
            doesBg:
              'Заглавието над двата бутона за тема.',
          },
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
      {
        headingKey: 'ap.size',
        en: 'Text size',
        bg: 'Размер на текста',
        controls: [
          {
            key: 'ap.sizeSmall',
            kind: 'button',
            en: 'Small',
            bg: 'Малък',
            doesEn: 'One step below normal.',
            doesBg: 'Една степен под нормалния.',
          },
          {
            key: 'ap.sizeNormal',
            kind: 'button',
            en: 'Normal',
            bg: 'Нормален',
            doesEn: 'Normal size.',
            doesBg: 'Нормален размер.',
          },
          {
            key: 'ap.sizeLarge',
            kind: 'button',
            en: 'Large',
            bg: 'Голям',
            doesEn: 'One step above normal.',
            doesBg: 'Една степен над нормалния.',
          },
          {
            key: 'ap.sizeHuge',
            kind: 'button',
            en: 'Larger',
            bg: 'По-голям',
            doesEn: 'Two steps above normal.',
            doesBg: 'Две степени над нормалния.',
          },
          {
            key: 'ap.sizeGiant',
            kind: 'button',
            en: 'Largest',
            bg: 'Най-голям',
            doesEn: 'Three steps above normal.',
            doesBg: 'Три степени над нормалния.',
          },
        ],
      },
      {
        headingKey: 'ap.a11y',
        en: 'Accessibility',
        bg: 'Достъпност',
        controls: [
          {
            key: 'ap.contrast',
            kind: 'checkbox',
            en: 'Higher contrast',
            bg: 'По-висок контраст',
            doesEn:
              'Stronger colours and borders.',
            doesBg:
              'По-силни цветове и рамки.',
          },
          {
            key: 'ap.motion',
            kind: 'checkbox',
            en: 'Less motion',
            bg: 'По-малко движение',
            doesEn:
              'Turns off animations such as the pulsing live dot.',
            doesBg:
              'Изключва анимациите, например пулсиращата точка на живо.',
          },
          {
            key: 'ap.links',
            kind: 'checkbox',
            en: 'Underline every link',
            bg: 'Подчертавай всички връзки',
            doesEn:
              'Underlines every link.',
            doesBg:
              'Подчертава всяка връзка.',
          },
          {
            key: 'ap.focus',
            kind: 'checkbox',
            en: 'Thick focus outline',
            bg: 'Дебел фокусен контур',
            doesEn:
              'A thick outline around whatever has the keyboard focus.',
            doesBg:
              'Дебел контур около това, което е на фокус от клавиатурата.',
          },
          {
            key: 'ap.reset',
            kind: 'button',
            en: 'Back to the defaults',
            bg: 'Върни настройките по подразбиране',
            doesEn:
              'Puts every appearance setting back.',
            doesBg:
              'Връща всички настройки на външния вид.',
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
            key: 'sys.signin',
            kind: 'note',
            en: 'Sign-in',
            bg: 'Вписване',
            doesEn:
              'The block about the bot\'s browser profile and its sign-in.',
            doesBg:
              'Блокът за профила на браузъра на бота и вписването в него.',
          },
          {
            key: 'sys.settings',
            kind: 'note',
            en: 'Settings',
            bg: 'Настройки',
            doesEn:
              'The block showing the settings as saved and the paths they resolve to.',
            doesBg:
              'Блокът с настройките, както са запазени, и пътищата, до които водят.',
          },
          {
            key: 'sys.profileHeld',
            kind: 'note',
            en: 'Edge is holding the profile (pids {pids}). A run would fail. Close that Edge window.',
            bg: 'Edge държи профила (pid {pids}). Изпълнение би се провалило. Затворете този прозорец на Edge.',
            doesEn: 'The line to look for when a run will not start: a stray Edge window has the profile open.',
            doesBg: 'Редът, който се търси, когато пускане не тръгва: чужд прозорец на Edge държи профила отворен.',
          },
          {
            key: 'sys.profileMissing',
            kind: 'note',
            en: '(not created yet: run cop login)',
            bg: '(още не е създаден: пуснете cop login)',
            doesEn:
              'The bot\'s browser profile does not exist yet: the operator has to run "cop login" once.',
            doesBg:
              'Профилът на браузъра на бота още не съществува: операторът трябва веднъж да пусне „cop login“.',
          },
          {
            key: 'sys.profileBot',
            kind: 'note',
            en: 'In use by the bot\'s own run right now ({n} Edge process(es)). That is expected while a session runs.',
            bg: 'В момента се ползва от собственото изпълнение на бота ({n} процеса на Edge). Това е очаквано, докато сесия работи.',
            doesEn:
              'The profile is held by the bot\'s own run right now — nothing to close.',
            doesBg:
              'Профилът в момента се държи от собственото пускане на бота — няма какво да се затваря.',
          },
          {
            key: 'sys.profileFree',
            kind: 'note',
            en: 'free',
            bg: 'свободен',
            doesEn:
              'Nothing holds the profile; a run can start.',
            doesBg:
              'Нищо не държи профила; пускане може да тръгне.',
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
  note: { en: 'text', bg: 'текст' },
};

const INTRO_EN =
  'Every label in quotes below is the exact text on the screen. Name the control by that text — press "Check it" — instead of describing it, and give the route so the operator knows which page they are on. A label with {braces} in it is filled in with numbers or names at the time. A label with no kind after it is a button.';

const INTRO_BG =
  'Всеки надпис в кавички по-долу е точният текст на екрана. Назовавай контрола с този текст — натисни „Провери“ — вместо да го описваш, и казвай маршрута, за да знае операторът на коя страница е. Надпис с {скоби} се попълва с числа или имена в момента. Надпис без вид след него е бутон.';

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
        // A button is the common case and is said once in the introduction instead of on 120 lines:
        // the brief is pasted into a chat whose composer has a limit, and this is where it goes.
        const kind = control.kind === 'button' ? '' : ` (${KIND_WORDS[control.kind][lang]})`;
        lines.push(`- "${bg ? control.bg : control.en}"${kind} — ${bg ? control.doesBg : control.doesEn}`);
      }
    }
  }

  return lines.join('\n');
}
