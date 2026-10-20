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
      'The links down the side of every page, the language switch, the round to-the-top and to-the-bottom buttons of a long page, the box that asks before anything irreversible, the notice of a start that did not happen, and the banner of steps waiting for a decision, which appears on every page.',
    purposeBg:
      'Връзките отстрани на всяка страница, смяната на езика, кръглите бутони към началото и края на дълга страница, прозорецът, който пита преди нещо необратимо, съобщението за пускане, което не е започнало, и лентата със стъпки, чакащи решение, която се появява на всяка страница.',
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
        headingKey: null,
        en: 'A start that did not happen',
        bg: 'Пускане, което не е започнало',
        controls: [
          {
            key: 'startfail.title',
            kind: 'note',
            en: 'The work did not start',
            bg: 'Работата не започна',
            doesEn:
              'In the start window when its button did not start the work, on / under the run buttons once the window is closed, and on every page when a run was accepted and then could not begin (the browser, the profile, the sign-in, a session refused at its turn): the error itself and where it stopped.',
            doesBg:
              'В прозореца за старт, когато бутонът му не е стартирал работата, на / под бутоните за пускане след затварянето му, и на всяка страница, когато пускане е прието, а после не е могло да започне (браузърът, профилът, влизането, сесия, отказана на своя ред): самата грешка и къде е спряло.',
          },
          {
            key: 'startfail.download',
            kind: 'link',
            en: 'Download what happened (error, run record and terminal)',
            bg: 'Изтегли какво се случи (грешка, запис на пускането и терминал)',
            doesEn:
              'A text file with the error, where it stopped, the run\'s own record, the sessions\' events and every line the bot\'s console printed from the press until a few seconds after. Ask the operator for it when a run does not start.',
            doesBg:
              'Текстов файл с грешката, къде е спряло, собствения запис на пускането, събитията на сесиите и всеки ред, който конзолата на бота е отпечатала от натискането до няколко секунди след това. Поискай го от оператора, когато пускане не тръгва.',
          },
          {
            key: 'startfail.terminal',
            kind: 'link',
            en: 'Download what the terminal showed',
            bg: 'Изтегли какво показа терминалът',
            doesEn:
              'The latest lines the bot\'s console (npm start or cop start) printed, with the time of each, as a text file. Also on /system.',
            doesBg:
              'Последните редове, отпечатани от конзолата на бота (npm start или cop start), с часа на всеки, като текстов файл. Има го и на /system.',
          },
          {
            key: 'startfail.dismiss',
            kind: 'button',
            en: 'Close this notice',
            bg: 'Затвори съобщението',
            doesEn:
              'Closes the notice of a run that could not begin, on every page; the files stay on record.',
            doesBg:
              'Затваря съобщението за пускане, което не е могло да започне, на всяка страница; файловете остават.',
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
          {
            key: 'approval.modelChosen',
            kind: 'button',
            en: 'I chose it — check and continue',
            bg: 'Избрах го — провери и продължи',
            doesEn: 'On the card that appears when the bot could not choose the model: after you chose it in the Copilot window, the bot reads the picker and goes on, or asks again if it shows another model.',
            doesBg: 'На картата, която се появява, когато ботът не успее да избере модела: след като го изберете в прозореца на Copilot, ботът проверява менюто и продължава, или пита пак, ако то показва друг модел.',
          },
          {
            key: 'approval.manualReady',
            kind: 'button',
            en: 'Ready — continue',
            bg: 'Готово — продължи',
            doesEn: 'The one way on of the card shown when the model is chosen by hand (the default, or "Set the model by hand" in the chat): after you chose it in the Copilot window, the run goes on, on that model; the conversation is not asked again.',
            doesBg: 'Единственият бутон за продължаване на картата при ръчен избор на модела (по подразбиране или „Ръчно задаване на модел“ в чата): след като го изберете в прозореца на Copilot, изпълнението продължава на този модел; разговорът не се пита пак.',
          },
          {
            key: 'approval.modelAsItIs',
            kind: 'button',
            en: 'Continue on the model it is on',
            bg: 'Продължи на текущия модел',
            doesEn: 'On the card shown when the bot could not choose the model: the run goes on with whatever model the chat is on, and the record says so.',
            doesBg: 'На картата, когато ботът не успее да избере модела: изпълнението продължава с модела, на който е чатът, и записът го казва.',
          },
          {
            key: 'approval.modelStop',
            kind: 'button',
            en: 'Stop',
            bg: 'Спри',
            doesEn: 'Nothing is sent: the session stops, its tasks stay queued.',
            doesBg: 'Нищо не се изпраща: сесията спира, задачите ѝ остават на опашката.',
          },
          {
            key: 'pm.note',
            kind: 'field',
            en: 'Note for the chat (optional when approving; says what to change when asking for another plan)',
            bg: 'Бележка за чата (по желание при одобрение; казва какво да се промени, когато искаш друг план)',
            doesEn:
              'On a plan waiting for approval (plan first): sent to the chat with the answer — a condition for the work when approving, what to change when asking for another plan.',
            doesBg:
              'На план, който чака одобрение („Първо план“): изпраща се на чата с отговора — условие за работата при одобрение, какво да се промени, когато искаш друг план.',
          },
          {
            key: 'pm.approve',
            kind: 'button',
            en: 'Approve and start the work',
            bg: 'Одобри и започни работата',
            doesEn: 'The plan is recorded as approved by the operator and the chat starts changing the code, following it.',
            doesBg: 'Планът се записва като одобрен от оператора и чатът започва да променя кода, като го следва.',
          },
          {
            key: 'pm.revise',
            kind: 'button',
            en: 'Ask for another plan',
            bg: 'Поискай друг план',
            doesEn: 'Needs the note: the chat makes a new version of the plan with it, still without changing anything, and the card comes back.',
            doesBg: 'Иска бележка: чатът прави нова версия на плана с нея, пак без да променя нищо, и картата се връща.',
          },
          {
            key: 'pm.stop',
            kind: 'button',
            en: 'Stop the task',
            bg: 'Спри задачата',
            doesEn: 'After a confirmation the task ends as stopped, with nothing changed; it can be run again.',
            doesBg: 'След потвърждение задачата приключва като спряна, без нищо променено; може да се пусне отново.',
          },
        ],
      },
    ],
  },

  {
    route: '/',
    nameEn: 'Workbench',
    nameBg: 'Работно място',
    purposeEn:
      'The home screen, laid out as an IDE: the open folder\'s files or its git on the left, the open files and diffs in the middle with Kerrigan when nothing is open, the terminal, the problems and the output of the chat\'s conversation below, and the chat on the right, which works in the open folder. The status bar says what runs; Ctrl+K finds anything.',
    purposeBg:
      'Началният екран, подреден като IDE: файловете или git на отворената папка отляво, отворените файлове и разлики в средата, с Кериган, когато нищо не е отворено, терминалът, проблемите и изходът на разговора в чата отдолу и чатът отдясно, който работи в отворената папка. Лентата най-долу казва какво върви; Ctrl+K намира всичко.',
    sections: [
      {
        headingKey: null,
        en: 'The bar on top, the editor and the bar below',
        bg: 'Лентата горе, редакторът и лентата долу',
        controls: [
          {
            key: 'wb.palette',
            kind: 'button',
            en: 'Find a command, a page or a conversation',
            bg: 'Намери команда, страница или разговор',
            doesEn: 'Opens the command palette (also Ctrl+K): a command, a page or a conversation of the chat, found by a few letters.',
            doesBg: 'Отваря палитрата с команди (и с Ctrl+K): команда, страница или разговор на чата, по няколко букви.',
          },
          {
            key: 'nav.defaults',
            kind: 'link',
            en: 'Settings',
            bg: 'Настройки',
            doesEn: 'In the bar on top: opens Settings.',
            doesBg: 'В лентата горе: отваря Настройки.',
          },
          {
            key: 'wb.welcome',
            kind: 'note',
            en: 'Welcome',
            bg: 'Добре дошъл',
            doesEn: 'The editor with nothing open: the folder the chat works in, and Kerrigan.',
            doesBg: 'Редакторът, когато нищо не е отворено: папката, в която работи чатът, и Кериган.',
          },
          {
            key: 'wb.closeTab',
            kind: 'button',
            en: 'Close {name}',
            bg: 'Затвори {name}',
            doesEn: 'The × on a tab of the editor (a file, or a file\'s two versions): closes it.',
            doesBg: 'Хиксът на раздел в редактора (файл или двете версии на файл): затваря го.',
          },
          {
            key: 'wb.openRunning',
            kind: 'button',
            en: 'Show the conversation that is running in the chat',
            bg: 'Покажи в чата разговора, който върви',
            doesEn: 'In the status bar while the chat works: shows that conversation in the chat (conversation, message, message n of the limit, minutes).',
            doesBg: 'В лентата най-долу, докато чатът работи: показва този разговор в чата (разговор, съобщение, съобщение n от лимита, минути).',
          },
          {
            key: 'wb.waiting',
            kind: 'button',
            en: '{n} waiting for you',
            bg: 'чакат теб: {n}',
            doesEn: 'In the status bar: how many commands or plans wait for an answer; brings the card on top into view.',
            doesBg: 'В лентата най-долу: колко команди или планове чакат отговор; показва картата горе.',
          },
        ],
      },
      {
        headingKey: null,
        en: 'Kerrigan, on the home screen',
        bg: 'Кериган, на началния екран',
        controls: [
          {
            key: 'kerrigan.button',
            kind: 'button',
            en: 'Kerrigan',
            bg: 'Кериган',
            doesEn: 'Opens a menu with two ways to take Kerrigan away: a persona to give to a chat of your own (Copilot, ChatGPT, another), so it knows what copilot-operator is and helps you write a task for it. Optional: the chat here works without her.',
            doesBg: 'Отваря меню с два начина да вземете Кериган: персона, която давате на чат по ваш избор (Copilot, ChatGPT или друг), за да знае какво е copilot-operator и да ви помогне да напишете задание за него. По желание: чатът тук работи и без нея.',
          },
          {
            key: 'kerrigan.save',
            kind: 'button',
            en: 'Save as a file',
            bg: 'Свали като файл',
            doesEn: 'In that menu: saves her as a Markdown file, in the language of the page.',
            doesBg: 'В това меню: сваля я като Markdown файл, на езика на страницата.',
          },
          {
            key: 'kerrigan.copy',
            kind: 'button',
            en: 'Copy to the clipboard',
            bg: 'Копирай в клипборда',
            doesEn: 'In that menu: copies her to the clipboard, to paste at the start of a conversation.',
            doesBg: 'В това меню: копира я в клипборда, за поставяне в началото на разговор.',
          },
          {
            key: 'kerrigan.infoLabel',
            kind: 'button',
            en: 'What is Kerrigan?',
            bg: 'Какво е Кериган?',
            doesEn: 'The "i" beside the button: says what Kerrigan is and how she helps.',
            doesBg: '„i“ до бутона: казва какво е Кериган и как помага.',
          },
        ],
      },
      {
        headingKey: null,
        en: 'The column of icons on the left, and the explorer',
        bg: 'Колоната с икони вляво и изследователят',
        controls: [
          {
            key: 'wb.viewFiles',
            kind: 'button',
            en: 'Files',
            bg: 'Файлове',
            doesEn: 'Shows the open folder\'s files beside it; a file opens in the editor.',
            doesBg: 'Показва файловете на отворената папка до нея; файл се отваря в редактора.',
          },
          {
            key: 'wb.viewCommits',
            kind: 'button',
            en: 'Git',
            bg: 'Git',
            doesEn: 'Shows the open folder\'s git: the branch, the staged changes and the changes, each file with its letter (M modified, A added, D deleted, R renamed, U untracked, ! in conflict) and its lines, and the branch\'s commits; a file opens its two versions side by side, a commit opens to its files. Read-only.',
            doesBg: 'Показва git на отворената папка: клона, подготвените промени и промените — всеки файл с буквата си (M променен, A добавен, D изтрит, R преименуван, U непроследен, ! в конфликт) и редовете си — и комитите на клона; файл отваря двете си версии една до друга, комит се разгъва до файловете си. Само чете.',
          },
          {
            key: 'wb.refresh',
            kind: 'button',
            en: 'Read again',
            bg: 'Прочети отново',
            doesEn: 'The ↻ of the files: reads the folder again at once (it is read every few seconds anyway).',
            doesBg: '↻ на файловете: прочита папката веднага (тя се чете на всеки няколко секунди и без това).',
          },
          {
            key: 'git.refresh',
            kind: 'button',
            en: 'Read the folder\'s git again',
            bg: 'Прочети отново git на папката',
            doesEn: 'The ↻ of the git view: reads the folder\'s git again at once.',
            doesBg: '↻ на изгледа git: прочита git на папката веднага.',
          },
          {
            key: 'wb.appearance',
            kind: 'button',
            en: 'Appearance: theme and text',
            bg: 'Изглед: тема и текст',
            doesEn: 'The last icon: how the page looks, here and now — the theme (System, the default, follows the machine\'s light or dark; Light; Dark), the text size a step at a time (A− and A+), and the reading aids (underline links, less motion, higher contrast, thick focus outline, night light). Kept in this browser; the same as the Appearance page.',
            doesBg: 'Последната икона: как изглежда страницата, тук и веднага — темата (Системна, по подразбиране, следва светлото или тъмното на машината; Светла; Тъмна), размерът на текста стъпка по стъпка (A− и A+) и помощните средства за четене (подчертани връзки, по-малко движение, по-висок контраст, дебела рамка на фокуса, нощна светлина). Пазят се в този браузър; същите като на страницата Изглед.',
          },
          {
            key: 'ap.smaller',
            kind: 'button',
            en: 'Smaller text',
            bg: 'По-малък текст',
            doesEn: 'In that menu, the A−: the text a step smaller.',
            doesBg: 'В това меню, A−: текстът една стъпка по-малък.',
          },
          {
            key: 'ap.larger',
            kind: 'button',
            en: 'Larger text',
            bg: 'По-голям текст',
            doesEn: 'In that menu, the A+: the text a step larger.',
            doesBg: 'В това меню, A+: текстът една стъпка по-голям.',
          },
        ],
      },
      {
        headingKey: 'wb.chatPanel',
        en: 'Chat',
        bg: 'Чат',
        controls: [
          {
            key: 'wb.chatTab',
            kind: 'tab',
            en: 'Chat',
            bg: 'Чат',
            doesEn: 'The chat of the open project folder, as in an IDE: a message is sent to Copilot, the commands it answers with run in the folder and their output goes back, until it is done; shown as the conversation.',
            doesBg: 'Чатът на отворената папка, както в IDE: съобщението отива при Copilot, командите, с които отговаря, се изпълняват в папката и изходът им се връща, докато свърши; показва се като разговор.',
          },
          {
            key: 'chat.thread',
            kind: 'select',
            en: 'Conversation',
            bg: 'Разговор',
            doesEn: 'Which conversation of the chat is shown: an earlier one, or "New conversation".',
            doesBg: 'Кой разговор на чата се показва: по-ранен или „Нов разговор“.',
          },
          {
            key: 'chat.newThread',
            kind: 'select',
            en: 'New conversation',
            bg: 'Нов разговор',
            doesEn: 'In that list: a new conversation, made by the next message.',
            doesBg: 'В този списък: нов разговор, който започва със следващото съобщение.',
          },
          {
            key: 'chat.newChat',
            kind: 'button',
            en: 'New chat',
            bg: 'Нов чат',
            doesEn: 'Beside the list: the next message starts a new conversation, in a new Copilot conversation with nothing of this one in it; this one stays in the list.',
            doesBg: 'До списъка: следващото съобщение започва нов разговор, в нов разговор в Copilot без нищо от този; този остава в списъка.',
          },
          {
            key: 'chat.welcome',
            kind: 'note',
            en: 'Ask for a change in {folder}',
            bg: 'Поискай промяна в {folder}',
            doesEn: 'With no conversation chosen: what the chat works on (the open folder and its branch) and a few messages to begin with.',
            doesBg: 'Когато няма избран разговор: върху какво работи чатът (отворената папка и клонът ѝ) и няколко съобщения за начало.',
          },
          {
            key: 'chat.openFolder',
            kind: 'button',
            en: 'Open a folder',
            bg: 'Отвори папка',
            doesEn: 'Opens the machine\'s folder dialog; the folder chosen becomes the project the chat and the Files view work on (Settings → project folder).',
            doesBg: 'Отваря прозореца за избор на папка; избраната става проектът, върху който работят чатът и изгледът „Файлове“ (Настройки → папка на проекта).',
          },
          {
            key: 'chat.input',
            kind: 'field',
            en: 'Message to the chat',
            bg: 'Съобщение до чата',
            doesEn: 'The message: what to change or ask. Enter sends it, Shift+Enter starts a new line; while it works, what is written is added to what it is doing.',
            doesBg: 'Съобщението: какво да се промени или попита. Enter го изпраща, Shift+Enter започва нов ред; докато работи, написаното се добавя към това, което прави.',
          },
          {
            key: 'chat.model',
            kind: 'select',
            en: 'Model',
            bg: 'Модел',
            doesEn: 'The model of this conversation (or of the next one): "Set the model by hand" (the run waits after signing in until it is chosen in the Copilot window and "Ready" is pressed, once per conversation), "As in Settings", or one the chat\'s picker offered when last read.',
            doesBg: 'Моделът на този разговор (или на следващия): „Ръчно задаване на модел“ (след входа пускането чака, докато моделът бъде избран в прозореца на Copilot и се натисне „Готово“, веднъж на разговор), „Както е в Настройки“ или някой, предложен от избора в чата при последното четене.',
          },
          {
            key: 'chat.readModels',
            kind: 'button',
            en: 'Read the latest models from Copilot',
            bg: 'Прочети последните модели от Copilot',
            doesEn: 'The ↻ beside the model: reads the models Copilot\'s own picker offers now (the browser opens for a moment, and a Copilot window the chat left open is closed first; not while a conversation works).',
            doesBg: '↻ до модела: прочита моделите, които изборът в Copilot предлага сега (браузърът се отваря за момент, а прозорец на Copilot, оставен отворен от чата, първо се затваря; не и докато разговор работи).',
          },
          {
            key: 'copy.copy',
            kind: 'button',
            en: 'Copy',
            bg: 'Копирай',
            doesEn: 'Under your message, under what the chat said, beside how it ended and beside a command: copies that text (a command with what it printed); it says "Copied" for a moment.',
            doesBg: 'Под твое съобщение, под казаното от чата, до края и до команда: копира този текст (команда — заедно с изписаното от нея); за момент пише „Копирано“.',
          },
          {
            key: 'chat.foldOpen',
            kind: 'button',
            en: 'Show the whole message',
            bg: 'Покажи цялото съобщение',
            doesEn: 'The ▾ under a long message of yours, shown folded to its first three lines, fading out: opens it whole.',
            doesBg: 'Стрелката ▾ под твое дълго съобщение, свито до първите три реда, които избледняват: разгъва го цялото.',
          },
          {
            key: 'chat.foldClose',
            kind: 'button',
            en: 'Fold the message to its first lines',
            bg: 'Свий съобщението до първите редове',
            doesEn: 'The ▴ under an opened long message: folds it back to three lines.',
            doesBg: 'Стрелката ▴ под разгънато дълго съобщение: свива го обратно до три реда.',
          },
          {
            key: 'chat.exchange',
            kind: 'link',
            en: '⤓ JSON',
            bg: '⤓ JSON',
            doesEn: 'Under a message: saves everything between the bot and Copilot for that message alone, as a JSON file — every message sent with its files, every reply, every command with its whole output and exit code, every attempt.',
            doesBg: 'Под съобщение: запазва всичко между бота и Copilot само за това съобщение, като JSON файл — всяко изпратено съобщение с файловете му, всеки отговор, всяка команда с целия ѝ изход и изходен код, всеки опит.',
          },
          {
            key: 'chat.rewind',
            kind: 'button',
            en: 'Go back to before this message',
            bg: 'Върни отпреди това съобщение',
            doesEn: 'The ↶ beside a message of yours: puts the folder back exactly as it was before that message — branch, files, uncommitted changes — and takes it and the messages after it out of the conversation; the folder as it was is kept in a safety copy, and the message goes back in the box.',
            doesBg: '↶ до твое съобщение: връща папката точно както беше преди него — клон, файлове, некомитнати промени — и маха него и следващите от разговора; папката, както е била, се пази като резервно копие, а съобщението се връща в полето.',
          },
          {
            key: 'chat.mode',
            kind: 'select',
            en: 'How commands run',
            bg: 'Как се изпълняват командите',
            doesEn: 'Whether the commands the chat sends wait for you or run at once.',
            doesBg: 'Дали командите от чата чакат теб, или се изпълняват веднага.',
          },
          {
            key: 'chat.modeAsk',
            kind: 'select',
            en: 'Ask before each command',
            bg: 'Питай преди всяка команда',
            doesEn: 'Each command waits on a card in the conversation: Run, Run this and the rest, or Skip.',
            doesBg: 'Всяка команда чака на карта в разговора: Изпълни, Изпълни тази и останалите или Пропусни.',
          },
          {
            key: 'chat.modeAuto',
            kind: 'select',
            en: 'Run commands without asking',
            bg: 'Изпълнявай командите без питане',
            doesEn: 'Commands run at once, as in an unattended run; the list of forbidden commands still applies.',
            doesBg: 'Командите се изпълняват веднага, както при пускане без надзор; списъкът със забранени команди пак важи.',
          },
          {
            key: 'chat.send',
            kind: 'button',
            en: 'Send',
            bg: 'Изпрати',
            doesEn: 'Sends the message and starts it on the branch the folder is on; nothing is asked about branches. The Copilot window stays open when the work on it has ended, says so with an OK, and the next message works in it; close it with its X whenever you like (a message it is working on then stops, and the next one opens a new window).',
            doesBg: 'Изпраща съобщението и го пуска на клона, на който е папката; нищо не се пита за клонове. Прозорецът на Copilot остава отворен, когато работата по него свърши, казва го с бутон „ОК“, и следващото съобщение работи в него; затворете го с X, когато пожелаете (съобщение, по което работи, тогава спира, а следващото отваря нов прозорец).',
          },
          {
            key: 'chat.sendNote',
            kind: 'button',
            en: 'Add to it',
            bg: 'Добави',
            doesEn: 'While it works: adds the message to what it is doing; it gets it with its next report.',
            doesBg: 'Докато работи: добавя съобщението към това, което прави; получава го със следващия си отчет.',
          },
          {
            key: 'chat.pause',
            kind: 'button',
            en: 'Pause',
            bg: 'Пауза',
            doesEn: 'While it works: holds the work where it is — a reply being written and a command running are let finish — and then nothing more is sent and nothing runs; the button becomes "Continue". The time paused does not count against the time limit.',
            doesBg: 'Докато работи: задържа работата там, където е — отговор, който се пише, и команда, която тече, се оставят да свършат — и после нищо повече не се изпраща и нищо не се изпълнява; бутонът става „Продължи“. Времето на пауза не се брои към ограничението за време.',
          },
          {
            key: 'chat.resume',
            kind: 'button',
            en: 'Continue',
            bg: 'Продължи',
            doesEn: 'While it is paused: goes on with the work from where it held.',
            doesBg: 'Докато е на пауза: продължава работата оттам, където е задържана.',
          },
          {
            key: 'chat.stop',
            kind: 'button',
            en: 'Stop',
            bg: 'Спри',
            doesEn: 'While it works: stops it; the message in flight ends stopped and can be carried on. The Copilot window stays open for the next message.',
            doesBg: 'Докато работи: спира го; текущото съобщение завършва спряно и може да продължи. Прозорецът на Copilot остава отворен за следващото съобщение.',
          },
          {
            key: 'chat.planMode',
            kind: 'checkbox',
            en: 'Plan mode',
            bg: 'Режим на план',
            doesEn: 'Plan mode, as in Claude Code: Copilot first looks at the project with commands that only read, and proposes a plan — what is there, how, the stages, the files, how it will show it works; the plan is shown in the conversation to approve, to ask for another or to stop, and nothing changes before. Of this conversation, or of the next one.',
            doesBg: 'Режим на план, както в Claude Code: Copilot първо разглежда проекта с команди, които само четат, и предлага план — какво има, как, етапите, файловете, как ще покаже, че работи; планът се показва в разговора, за да го одобрите, да поискате друг или да спрете, и нищо не се променя преди това. На този разговор или на следващия.',
          },
          {
            key: 'chat.planShown',
            kind: 'disclosure',
            en: 'The approved plan (version {v})',
            bg: 'Одобреният план (версия {v})',
            doesEn: 'Under a message worked in plan mode: the plan that was approved, folded.',
            doesBg: 'Под съобщение, изпълнено в режим на план: одобреният план, сгънат.',
          },
          {
            key: 'chat.askRun',
            kind: 'button',
            en: 'Run',
            bg: 'Изпълни',
            doesEn: 'On a command waiting in the conversation: runs it.',
            doesBg: 'На команда, която чака в разговора: изпълнява я.',
          },
          {
            key: 'chat.askRunAll',
            kind: 'button',
            en: 'Run this and the rest',
            bg: 'Изпълни тази и останалите',
            doesEn: 'Runs it and stops asking for the rest of this message.',
            doesBg: 'Изпълнява я и спира да пита за останалото от това съобщение.',
          },
          {
            key: 'chat.askSkip',
            kind: 'button',
            en: 'Skip',
            bg: 'Пропусни',
            doesEn: 'Does not run it; the chat is told and goes on.',
            doesBg: 'Не я изпълнява; чатът научава и продължава.',
          },
          {
            key: 'wb.toggleChat',
            kind: 'button',
            en: 'Show or hide the chat',
            bg: 'Покажи или скрий чата',
            doesEn: 'The × on the right panel (and the chat icon on the far left): hides or shows it (Ctrl+L brings it back with the keyboard in the box).',
            doesBg: 'Хиксът на десния панел (и иконата на чата най-вляво): скрива го или го показва (Ctrl+L го връща с курсора в полето).',
          },
        ],
      },
      {
        headingKey: null,
        en: 'The editor',
        bg: 'Редакторът',
        controls: [
          {
            key: 'ed.save',
            kind: 'button',
            en: 'Save',
            bg: 'Запази',
            doesEn: 'Saves the file (also Ctrl+S), over the version that was opened: a file changed on disk meanwhile is not overwritten without asking. A tab with changes not saved has a dot; closing it asks first.',
            doesBg: 'Запазва файла (и с Ctrl+S), върху версията, която е била отворена: файл, променен на диска междувременно, не се презаписва без питане. Раздел с незапазени промени има точка; затварянето му пита първо.',
          },
          {
            key: 'ed.revert',
            kind: 'button',
            en: 'Undo my changes',
            bg: 'Отмени промените ми',
            doesEn: 'Puts the text back as it was last read or saved.',
            doesBg: 'Връща текста, какъвто е бил при последното четене или запазване.',
          },
          {
            key: 'ed.language',
            kind: 'select',
            en: 'Language',
            bg: 'Език',
            doesEn: 'The language the text is coloured in: "Automatic" (found from the file\'s name and extension, its first line and what it starts with) or one chosen by hand.',
            doesBg: 'Езикът, в който се оцветява текстът: „Автоматично“ (по името и разширението на файла, първия му ред и с какво започва) или избран ръчно.',
          },
          {
            key: 'ed.langAuto',
            kind: 'select',
            en: 'Automatic ({name})',
            bg: 'Автоматично ({name})',
            doesEn: 'In that list: the language found by itself, named in brackets.',
            doesBg: 'В този списък: езикът, разпознат сам, посочен в скобите.',
          },
          {
            key: 'ed.reload',
            kind: 'button',
            en: 'Read it again (my changes are lost)',
            bg: 'Прочети го отново (промените ми се губят)',
            doesEn: 'When the file changed on disk under an edit: reads it again; the edit is lost.',
            doesBg: 'Когато файлът се е променил на диска под редакция: прочита го отново; редакцията се губи.',
          },
          {
            key: 'ed.saveOver',
            kind: 'button',
            en: 'Save over it',
            bg: 'Запази върху него',
            doesEn: 'When the file changed on disk under an edit: saves the edit over it.',
            doesBg: 'Когато файлът се е променил на диска под редакция: записва редакцията върху него.',
          },
        ],
      },
      {
        headingKey: null,
        en: 'The changes of a message, and a file\'s two versions',
        bg: 'Промените на съобщение и двете версии на файл',
        controls: [
          {
            key: 'diff.open',
            kind: 'button',
            en: 'See the changes ({n} file(s))',
            bg: 'Виж промените ({n} файла)',
            doesEn: 'Under a message that changed files: opens what it changed, file by file, before on the left and after on the right.',
            doesBg: 'Под съобщение, което е променило файлове: отваря какво е променило, файл по файл, преди отляво и след отдясно.',
          },
          {
            key: 'diff.title',
            kind: 'note',
            en: 'Changes in "{title}"',
            bg: 'Промени в „{title}“',
            doesEn: 'The heading of that view.',
            doesBg: 'Заглавието на този изглед.',
          },
          {
            key: 'diff.close',
            kind: 'button',
            en: 'Close',
            bg: 'Затвори',
            doesEn: 'Closes it (Escape too).',
            doesBg: 'Затваря го (и Escape).',
          },
          {
            key: 'diff.prevChange',
            kind: 'button',
            en: 'Previous change',
            bg: 'Предишна промяна',
            doesEn: 'Goes to the change before (also p). With "Next change" on one line, two only when there is no room.',
            doesBg: 'Отива на предишната промяна (и с p). Заедно с „Следваща промяна“ на един ред, на два само когато няма място.',
          },
          {
            key: 'diff.nextChange',
            kind: 'button',
            en: 'Next change',
            bg: 'Следваща промяна',
            doesEn: 'Goes to the next change (also n).',
            doesBg: 'Отива на следващата промяна (и с n).',
          },
          {
            key: 'diff.changeN',
            kind: 'note',
            en: 'change {i} of {n}',
            bg: 'промяна {i} от {n}',
            doesEn: 'Right above "Before" and "After": which change is chosen, of how many.',
            doesBg: 'Точно над „Преди“ и „След“: коя промяна е избрана, от колко.',
          },
          {
            key: 'diff.prevFile',
            kind: 'button',
            en: 'Previous file',
            bg: 'Предишен файл',
            doesEn: 'In the changes of a message with several files: the file before (also [).',
            doesBg: 'В промените на съобщение с няколко файла: предишният файл (и с [).',
          },
          {
            key: 'diff.nextFile',
            kind: 'button',
            en: 'Next file',
            bg: 'Следващ файл',
            doesEn: 'The next file (also ]).',
            doesBg: 'Следващият файл (и с ]).',
          },
          {
            key: 'diff.whole',
            kind: 'checkbox',
            en: 'Show the whole file',
            bg: 'Покажи целия файл',
            doesEn: 'Shows the whole file, not only the changes with three lines around them. With "Wrap long lines" on one line.',
            doesBg: 'Показва целия файл, не само промените с по три реда около тях. Заедно с „Пренасяй дългите редове“ на един ред.',
          },
          {
            key: 'diff.wrap',
            kind: 'checkbox',
            en: 'Wrap long lines',
            bg: 'Пренасяй дългите редове',
            doesEn: 'Wraps a long line instead of scrolling it sideways.',
            doesBg: 'Пренася дълъг ред, вместо да се превърта настрани.',
          },
          {
            key: 'diff.gap',
            kind: 'button',
            en: '⋯ {n} unchanged line(s) — show them',
            bg: '⋯ {n} непроменени реда — покажи ги',
            doesEn: 'Opens a run of unchanged lines that is folded.',
            doesBg: 'Разгъва сгънат участък от непроменени редове.',
          },
        ],
      },
      {
        headingKey: 'wb.panel',
        en: 'Panel',
        bg: 'Панел',
        controls: [
          {
            key: 'wb.terminal',
            kind: 'tab',
            en: 'Terminal',
            bg: 'Терминал',
            doesEn: 'The commands the latest message of the conversation open in the chat ran, and what each printed, following the newest while it works. Empty on a new chat until it runs.',
            doesBg: 'Командите, които последното съобщение на отворения в чата разговор е изпълнило, и какво е изписала всяка, като следва най-новата, докато работи. Празен при нов чат, докато не тръгне.',
          },
          {
            key: 'wb.terminalInfoLabel',
            kind: 'button',
            en: 'What the Terminal shows',
            bg: 'Какво показва „Терминал“',
            doesEn: 'The "i" beside "Terminal": says what it shows.',
            doesBg: '„i“ до „Терминал“: казва какво показва.',
          },
          {
            key: 'wb.problems',
            kind: 'tab',
            en: 'Problems',
            bg: 'Проблеми',
            doesEn: 'What did not go well in the conversation open in the chat — a message that ended unfinished, stopped or at a limit, and why; a check that failed. Each brings its message into view in the chat; the count is of the ones not marked seen. Empty on a new chat.',
            doesBg: 'Какво не е минало добре в отворения в чата разговор — съобщение, завършило незавършено, спряно или при ограничение, и защо; проверка, която не е минала. Всяко показва съобщението си в чата; броят е на тези, които не са отбелязани като видени. Празно при нов чат.',
          },
          {
            key: 'wb.problemsInfoLabel',
            kind: 'button',
            en: 'What the Problems show',
            bg: 'Какво показва „Проблеми“',
            doesEn: 'The "i" beside "Problems": says what they show.',
            doesBg: '„i“ до „Проблеми“: казва какво показват.',
          },
          {
            key: 'wb.problemShow',
            kind: 'button',
            en: 'Show its message in the chat',
            bg: 'Покажи съобщението му в чата',
            doesEn: 'A problem itself: brings its message into view in the chat.',
            doesBg: 'Самият проблем: показва съобщението му в чата.',
          },
          {
            key: 'wb.problemSeen',
            kind: 'button',
            en: 'Seen',
            bg: 'Видях',
            doesEn: 'Beside a problem: takes it off the list and the count, in this browser. Its message still has it, and it shows again if a later run of that message has it again.',
            doesBg: 'До проблем: маха го от списъка и от броя, в този браузър. Съобщението му си го пази и се показва пак, ако следващо изпълнение на съобщението има същия проблем.',
          },
          {
            key: 'wb.problemsAllSeen',
            kind: 'button',
            en: 'Seen all',
            bg: 'Видях всички',
            doesEn: 'Under the problems: marks every one shown as seen.',
            doesBg: 'Под проблемите: отбелязва всички показани като видени.',
          },
          {
            key: 'wb.problemsShowSeen',
            kind: 'button',
            en: 'Show the {n} seen',
            bg: 'Покажи видените ({n})',
            doesEn: 'Under the problems: shows the ones marked seen too, faded.',
            doesBg: 'Под проблемите: показва и видените, избледнени.',
          },
          {
            key: 'wb.problemsHideSeen',
            kind: 'button',
            en: 'Hide the seen',
            bg: 'Скрий видените',
            doesEn: 'Hides the ones marked seen again.',
            doesBg: 'Скрива отново видените.',
          },
          {
            key: 'wb.output',
            kind: 'tab',
            en: 'Output',
            bg: 'Изход',
            doesEn: 'The bot\'s own log of the conversation open in the chat, newest at the bottom, each line with its time; errors in red, warnings in yellow.',
            doesBg: 'Собственият дневник на бота за отворения в чата разговор, най-новото отдолу, всеки ред с часа си; грешките в червено, предупрежденията в жълто.',
          },
          {
            key: 'wb.outputInfoLabel',
            kind: 'button',
            en: 'What the Output shows',
            bg: 'Какво показва „Изход“',
            doesEn: 'The "i" beside "Output": says what it shows.',
            doesBg: '„i“ до „Изход“: казва какво показва.',
          },
          {
            key: 'wb.cmdPanel',
            kind: 'button',
            en: 'Show or hide the panel',
            bg: 'Покажи или скрий панела',
            doesEn: 'The arrow at the panel\'s right: hides it to its tabs or shows it again (Ctrl+J).',
            doesBg: 'Стрелката вдясно на панела: свива го до разделите му или го показва отново (Ctrl+J).',
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
        ],
      },
      {
        headingKey: 'login.title',
        en: 'Sign in to Copilot',
        bg: 'Вход в Copilot',
        controls: [
          {
            key: 'login.account',
            kind: 'field',
            en: 'Account (optional)',
            bg: 'Акаунт (по желание)',
            doesEn: 'The work or school address to sign in as. Empty: whichever account is chosen in the window. With one, the profile is signed out first and Microsoft is asked for it.',
            doesBg: 'Служебният адрес, с който да се влезе. Празно: какъвто акаунт се избере в прозореца. С адрес профилът първо излиза и Microsoft се пита точно за него.',
          },
          {
            key: 'login.button',
            kind: 'button',
            en: 'Sign in to Copilot',
            bg: 'Вход в Copilot',
            doesEn: 'What "cop login" does: opens the bot\'s own Edge, waits for the operator to sign in there (the bot never types a password), and closes once the chat appears. Needed once before a run or a reading of the models.',
            doesBg: 'Това, което прави „cop login“: отваря собствения Edge на бота, чака операторът да влезе в него (ботът никога не пише парола) и се затваря, щом чатът се появи. Нужно е веднъж преди пускане или четене на моделите.',
          },
          {
            key: 'login.busy',
            kind: 'note',
            en: 'Waiting for you to sign in…',
            bg: 'Чака да влезете…',
            doesEn: 'The same button while the sign-in window is open; runs and the reading of the models wait for it.',
            doesBg: 'Същият бутон, докато прозорецът за вход е отворен; пусканията и четенето на моделите чакат.',
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
            key: 'prep.show',
            kind: 'button',
            en: 'Prepare the folder from the remote main branch',
            bg: 'Подготви папката от remote main',
            doesEn:
              'Under each project in Settings and on a session’s version control: fetches, then shows what would be kept where — uncommitted changes and new files on a saved branch of their own, commits of the local main the remote lacks on another — and where the folder ends up (the remote main, nothing uncommitted). Changes nothing until "Confirm".',
            doesBg:
              'Под всеки проект в Настройки и в контрола на версиите на сесия: изтегля и показва какво къде ще се запази — некомитнатите промени и новите файлове в отделен запазен клон, комитите на локалния main, които ги няма в remote, в друг — и къде ще е папката (основният клон на remote, без некомитнати промени). Нищо не се променя до „Потвърди“.',
          },
          {
            key: 'prep.confirm',
            kind: 'button',
            en: 'Confirm',
            bg: 'Потвърди',
            doesEn: 'Keeps everything as shown, then checks out the remote main branch as the local one and removes the new files from the folder (they are on the saved branch); ignored files stay. Refused if the folder changed since the preview, or while a run works in it. Afterwards the operator adds the files a task needs and the run screen offers a starting snapshot of them.',
            doesBg: 'Запазва всичко, както е показано, после избира основния клон на remote като локален и маха новите файлове от папката (те са в запазения клон); игнорираните остават. Отказва се, ако папката се е променила след прегледа или докато пускане работи в нея. След това операторът добавя файловете за задачата и екранът за пускане предлага начална снимка от тях.',
          },
          {
            key: 'prep.retry',
            kind: 'button',
            en: 'Try again',
            bg: 'Опитай пак',
            doesEn: 'Shown when the fetch did not get through: fetches again; a remote that wants a password or an SSH key passphrase asks through Git\u2019s own window, which the bot never reads.',
            doesBg: 'Показва се, когато изтеглянето не е минало: изтегля отново; remote, който иска парола или passphrase за SSH ключ, пита през собствения прозорец на Git, който ботът не чете.',
          },
          {
            key: 'prep.copyFetch',
            kind: 'button',
            en: 'Copy the fetch command',
            bg: 'Копирай командата за изтегляне',
            doesEn: 'Copies git fetch for this repository, to run in the operator\u2019s own PowerShell, where ssh asks for the passphrase directly.',
            doesBg: 'Копира git fetch за това хранилище, за собствения PowerShell на оператора, където ssh пита за passphrase директно.',
          },
          {
            key: 'prep.useFetched',
            kind: 'button',
            en: 'Continue with what was last fetched',
            bg: 'Продължи с последно изтегленото',
            doesEn: 'The preview again without fetching, against the remote as it was last fetched (say, by the command above); it says when that was.',
            doesBg: 'Прегледът отново без изтегляне, спрямо remote, както е изтеглен последно (например с командата по-горе); казва кога е било.',
          },
          {
            key: 'prep.cancel',
            kind: 'button',
            en: 'Cancel',
            bg: 'Отказ',
            doesEn: 'Closes the preview; nothing is changed.',
            doesBg: 'Затваря прегледа; нищо не се променя.',
          },
          {
            key: 'exec.autoContinue',
            kind: 'field',
            en: 'Keep going after a limit',
            bg: 'Продължавай след лимит',
            doesEn: 'How many times a task stopped by a limit (messages, minutes, reply wait, wrong format, rounds of fixing checks or review findings) is carried on at once in its own chat, from where it got to (0–20, 3 by default); after that it waits for "Continue". Blocked tasks and tasks the operator stopped are not carried on.',
            doesBg: 'Колко пъти задача, спряна от лимит (съобщения, минути, чакане на отговор, грешен формат, кръгове поправки на проверки или находки), продължава веднага в своя чат, от където е стигнала (0–20, по подразбиране 3); после чака „Continue“. Blocked задачи и задачи, спрени от оператора, не продължават сами.',
          },
          {
            key: 'exec.minApproaches',
            kind: 'field',
            en: 'Approaches the chat must try before it may give up',
            bg: 'Подходи, които чатът трябва да опита, преди да се откаже',
            doesEn: 'How many different approaches a "blocked" must list (2–20); with fewer the chat is asked for another.',
            doesBg: 'Колко различни подхода трябва да изброи „blocked“ (2–20); с по-малко чатът е помолен за още един.',
          },
          {
            key: 'def.manualModel',
            kind: 'field',
            en: 'Choose the model by hand at the start of each run',
            bg: 'Избирай модела ръчно в началото на всяко пускане',
            doesEn: 'The bot leaves the model picker alone and asks, on a card, for the model to be chosen in the Copilot window; a conversation already on the model is not asked about.',
            doesBg: 'Ботът не пипа менюто с моделите и моли, с карта, моделът да бъде избран в прозореца на Copilot; разговор, който вече е на модела, не се пита.',
          },
          {
            key: 'exec.maxReviewRounds',
            kind: 'field',
            en: 'Rounds of fixing after a failed review',
            bg: 'Кръгове поправка след неуспешен преглед',
            doesEn: 'How many times a failed review sends its findings back to be fixed and reviewed again (1–6) before the task ends blocked; separate from the approaches above.',
            doesBg: 'Колко пъти неуспешен преглед връща находките за поправка и нов преглед (1–6), преди задачата да завърши „blocked“; отделно от подходите по-горе.',
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
          {
            key: 'pm.setting',
            kind: 'select',
            en: 'Plan first',
            bg: 'Първо план',
            doesEn:
              'Each task first looks at the code without changing anything and makes a plan; the work starts once the plan is approved, and the review checks the work followed it. A run that does not ask approves the plan itself, so it never waits.',
            doesBg:
              'Всяка задача първо разглежда кода, без да променя нищо, и прави план; работата започва, когато планът е одобрен, а прегледът проверява дали работата го следва. Пускане, което не пита, одобрява плана само, така че никога не чака.',
          },
          {
            key: 'pm.off',
            kind: 'select',
            en: 'Off — the work starts at once',
            bg: 'Изключено — работата започва веднага',
            doesEn: 'No plan: the task starts changing the code in its first reply, as before.',
            doesBg: 'Без план: задачата започва да променя кода от първия си отговор, както досега.',
          },
          {
            key: 'pm.auto',
            kind: 'select',
            en: 'On — the plan is approved without asking',
            bg: 'Включено — планът се одобрява без питане',
            doesEn: 'The runner approves the plan as soon as it is complete and records that it did.',
            doesBg: 'Runner-ът одобрява плана веднага щом е пълен и записва, че го е направил.',
          },
          {
            key: 'pm.approveMode',
            kind: 'select',
            en: 'On — I approve the plan when the run asks before each command',
            bg: 'Включено — аз одобрявам плана, когато пускането пита преди всяка команда',
            doesEn:
              'In a run that asks before each command, the plan waits on a card at the top of every page; an unattended run approves it itself and says why.',
            doesBg:
              'При пускане с питане преди всяка команда планът чака на карта най-горе на всяка страница; пускане без надзор го одобрява само и казва защо.',
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
            key: 'theme.system',
            kind: 'button',
            en: 'System',
            bg: 'Системна',
            doesEn: 'The default: the light or dark this machine is set to, changing with it. Also from the last icon on the workbench\'s left.',
            doesBg: 'По подразбиране: светлото или тъмното, на което е машината, и се сменя с него. Също от последната икона вляво на работното място.',
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
            key: 'ap.night',
            kind: 'checkbox',
            en: 'Night light',
            bg: 'Нощна светлина',
            doesEn: 'A warm tint over the page, with less blue light, for the evening; with either theme.',
            doesBg: 'Топъл оттенък върху страницата, с по-малко синя светлина, за вечерта; и с двете теми.',
          },
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
            key: 'sys.version',
            kind: 'note',
            en: 'copilot-operator version',
            bg: 'Версия на copilot-operator',
            doesEn: 'The first row: which version of the bot is running, as `cop --version` says. Name it when reporting a problem.',
            doesBg: 'Първият ред: коя версия на бота работи, както я казва `cop --version`. Кажи я, когато съобщаваш за проблем.',
          },
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
            key: 'startfail.terminal',
            kind: 'link',
            en: 'Download what the terminal showed',
            bg: 'Изтегли какво показа терминалът',
            doesEn:
              'Under "This machine": the latest lines the bot\'s console printed, with their times, as a text file — what to ask for when something went wrong and nothing on the pages says why.',
            doesBg:
              'Под „Тази машина“: последните редове, отпечатани от конзолата на бота, с часовете им, като текстов файл — това се иска, когато нещо се е объркало и нищо по страниците не казва защо.',
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
