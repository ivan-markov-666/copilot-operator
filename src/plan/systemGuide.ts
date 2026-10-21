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
            key: 'nav.workbench',
            kind: 'link',
            en: 'Chat',
            bg: 'Чат',
            doesEn: 'Opens the chat, with the project\'s files beside it.',
            doesBg: 'Отваря чата, с файловете на проекта до него.',
          },
          {
            key: 'nav.defaults',
            kind: 'link',
            en: 'Settings',
            bg: 'Настройки',
            doesEn: 'Opens Settings: the projects with their level 2, the sign-in to Copilot, the models of the work and of the review, how a task runs; and the base prompt, to read.',
            doesBg: 'Отваря Настройки: проектите с техния шаблон ниво 2, входа в Copilot, моделите на работата и на рецензията, как върви една задача; и основния prompt, за четене.',
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
            kind: 'button',
            en: 'Language',
            bg: 'Language',
            doesEn: 'Always "Language", in English, whatever the language: opens the list of languages, each with its flag — English, Bulgarian, German, Spanish, French, Portuguese, Japanese, Korean, Arabic — and switches the whole interface, and Kerrigan, to the one chosen.',
            doesBg: 'Винаги „Language“, на английски, какъвто и да е езикът: отваря списъка с езиците, всеки със знамето си — английски, български, немски, испански, френски, португалски, японски, корейски, арабски, — и превключва целия интерфейс и Кериган на избрания.',
          },
          {
            key: 'lang.menu',
            kind: 'note',
            en: 'The language of the interface',
            bg: 'Езикът на интерфейса',
            doesEn: 'What the "Language" button says when pointed at, and the name of the list it opens.',
            doesBg: 'Какво казва бутонът „Language“, когато го посочите, и името на списъка, който отваря.',
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
            key: 'approval.leadModelTitle',
            kind: 'note',
            en: 'This is the model for the LEAD',
            bg: 'Това е моделът за РЪКОВОДИТЕЛЯ',
            doesEn: 'On the card that asks for a model, with two chats: it is for the lead — best the strongest reasoning model.',
            doesBg: 'На картата, която пита за модел, с два чата: той е за ръководителя — най-добре най-силният модел за разсъждение.',
          },
          {
            key: 'approval.workerModelTitle',
            kind: 'note',
            en: 'This is the model for the WORKER',
            bg: 'Това е моделът за ИЗПЪЛНИТЕЛЯ',
            doesEn: 'On the card that asks for a model, with two chats: it is for the worker — best a model good at code.',
            doesBg: 'На картата, която пита за модел, с два чата: той е за изпълнителя — най-добре модел, добър с код.',
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
    nameEn: 'Chat',
    nameBg: 'Чат',
    purposeEn:
      'The home screen, laid out as an IDE: the open folder\'s files or its git on the left, the open files and diffs in the middle with Kerrigan when nothing is open, the terminal, the problems and the output of the chat\'s conversation below, and the chat on the right, which works in the open folder — where they start: the three panels can be moved (the grip ⠿ in the head of each). The status bar says what runs; Ctrl+K finds anything.',
    purposeBg:
      'Началният екран, подреден като IDE: файловете или git на отворената папка отляво, отворените файлове и разлики в средата, с Кериган, когато нищо не е отворено, терминалът, проблемите и изходът на разговора в чата отдолу и чатът отдясно, който работи в отворената папка — така започват: трите панела могат да се местят (дръжката ⠿ в заглавието на всеки). Лентата най-долу казва какво върви; Ctrl+K намира всичко.',
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
            key: 'nav.system',
            kind: 'link',
            en: 'System',
            bg: 'Система',
            doesEn: 'In the bar on top: opens System, the read-only report on this machine.',
            doesBg: 'В лентата горе: отваря Система — отчета за тази машина, само за четене.',
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
            key: 'wb.search',
            kind: 'button',
            en: 'Search (Ctrl+Shift+F)',
            bg: 'Търсене (Ctrl+Shift+F)',
            doesEn: 'The magnifier in the column of icons (or Ctrl+Shift+F): the Search view, as in VS Code — the open folder\'s code searched as you type, the results by file.',
            doesBg: 'Лупата в колоната с икони (или Ctrl+Shift+F): изгледът за търсене, както във VS Code — кодът на отворената папка се търси, докато пишете, резултатите по файлове.',
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
          {
            key: 'ap.theme',
            kind: 'note',
            en: 'Theme',
            bg: 'Тема',
            doesEn: 'In the appearance menu: the theme.',
            doesBg: 'В менюто за изглед: темата.',
          },
          {
            key: 'theme.system',
            kind: 'button',
            en: 'System',
            bg: 'Системна',
            doesEn: 'The machine\'s own theme, light or dark as Windows is set, following it when it changes. The default.',
            doesBg: 'Темата на самата машина — светла или тъмна, както е настроен Windows, — и я следва, когато се смени. По подразбиране.',
          },
          {
            key: 'theme.light',
            kind: 'button',
            en: 'Light',
            bg: 'Светла',
            doesEn: 'Light, whatever the machine is set to.',
            doesBg: 'Светла, каквото и да е настроено на машината.',
          },
          {
            key: 'theme.dark',
            kind: 'button',
            en: 'Dark',
            bg: 'Тъмна',
            doesEn: 'Dark, whatever the machine is set to.',
            doesBg: 'Тъмна, каквото и да е настроено на машината.',
          },
          {
            key: 'ap.size',
            kind: 'note',
            en: 'Text size',
            bg: 'Размер на текста',
            doesEn: 'In the appearance menu: the text size, between A− and A+.',
            doesBg: 'В менюто за изглед: размерът на текста, между A− и A+.',
          },
          {
            key: 'ap.night',
            kind: 'checkbox',
            en: 'Night light',
            bg: 'Нощна светлина',
            doesEn: 'Night light: a warm tint over the page, gentler on the eyes in the evening, in any theme.',
            doesBg: 'Нощна светлина: топъл оттенък върху страницата, по-щадящ за очите вечер, при всяка тема.',
          },
          {
            key: 'ap.links',
            kind: 'checkbox',
            en: 'Underline every link',
            bg: 'Подчертавай всички връзки',
            doesEn: 'Every link underlined, not only on hover.',
            doesBg: 'Всяка връзка е подчертана, не само при посочване.',
          },
          {
            key: 'ap.motion',
            kind: 'checkbox',
            en: 'Less motion',
            bg: 'По-малко движение',
            doesEn: 'No animations or smooth scrolling.',
            doesBg: 'Без анимации и плавно превъртане.',
          },
          {
            key: 'ap.contrast',
            kind: 'checkbox',
            en: 'Higher contrast',
            bg: 'По-висок контраст',
            doesEn: 'Stronger colours and borders.',
            doesBg: 'По-силни цветове и рамки.',
          },
          {
            key: 'ap.focus',
            kind: 'checkbox',
            en: 'Thick focus outline',
            bg: 'Дебел фокусен контур',
            doesEn: 'A thick outline around whatever has the keyboard\'s focus.',
            doesBg: 'Дебел контур около това, което е на фокус от клавиатурата.',
          },
          {
            key: 'ap.reset',
            kind: 'button',
            en: 'Back to the defaults',
            bg: 'Върни настройките по подразбиране',
            doesEn: 'Everything in the menu back to the defaults: the machine\'s theme, normal text, no aids.',
            doesBg: 'Всичко в менюто по подразбиране: темата на машината, нормален текст, без помощни настройки.',
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
            doesBg: 'До списъка: следващото съобщение започва нов разговор, в нов разговор в Copilot без нищо от този; този остава в списъка. Неактивен, докато върви задача — докато не бъде спряна („Спри“) или прозорецът ѝ затворен, — и в нов чат, който още не е започнал; казва защо, когато го посочите.',
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
            doesEn: 'Under your message, under what the chat said, beside how it ended, beside a command and at the top and foot of a plan: copies that text (a command with what it printed, a plan whole with its headings); it says "Copied" for a moment.',
            doesBg: 'Под твое съобщение, под казаното от чата, до края, до команда и в началото и края на план: копира този текст (команда — заедно с изписаното от нея, план — целия, със заглавията му); за момент пише „Копирано“.',
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
            key: 'chat.skill',
            kind: 'select',
            en: 'Skill',
            bg: 'Skill',
            doesEn: 'Under the chat\'s box when Settings have skills for this folder: chooses one for the next message, and its instructions for that kind of task go with it. Starting the message with /its-name does the same.',
            doesBg: 'Под полето на чата, когато в Настройки има skill-ове за тази папка: избира един за следващото съобщение и инструкциите му за този вид задача отиват с него. Същото става, ако съобщението започне с /името му.',
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
            key: 'chat.review',
            kind: 'checkbox',
            en: 'Review',
            bg: 'Рецензия',
            doesEn: 'On unless unticked: when Copilot says the work is done, a conversation of its own reviews it — reads the changes, runs the checks — and sends back what it finds, until it passes or the review rounds in Settings are spent. With the model chosen by hand, the card for the review\'s model says it is the review\'s: choose a different, stronger one. Of this conversation, or of the next one.',
            doesBg: 'Включена, освен ако не е изключена: когато Copilot каже, че работата е готова, отделен разговор я преглежда — чете промените, пуска проверките — и връща каквото открие, докато мине или се изчерпат кръговете на рецензия от Настройки. Когато моделът се избира ръчно, картата за модела на рецензията казва, че е за нея: изберете друг, по-силен. На този разговор или на следващия.',
          },
          {
            key: 'chat.lead',
            kind: 'checkbox',
            en: 'Two chats',
            bg: 'Два чата',
            doesEn: 'Two chats, for a new conversation: the message goes to a lead, which restates it, has a worker survey the project, plans, gives the worker one subtask at a time and judges each report, until the result is ready in the form asked for; the worker runs the commands. Both are conversations in the same Copilot window. A started conversation shows how it began. With it, there is no "Review": the lead judges the worker.',
            doesBg: 'Два чата, за нов разговор: съобщението отива при ръководител, който го преразказва, пуска изпълнител да огледа проекта, прави план, дава на изпълнителя по една подзадача и преценява всеки доклад, докато резултатът стане готов в поискания вид; изпълнителят пуска командите. И двата са разговори в един и същ прозорец на Copilot. Започнатият разговор показва как е започнал. С него няма „Рецензия“: ръководителят преценява изпълнителя.',
          },
          {
            key: 'chat.leadModel',
            kind: 'note',
            en: 'Lead',
            bg: 'Ръководител',
            doesEn: 'With two chats: beside the first model, which is the lead\'s.',
            doesBg: 'С два чата: до първия модел, който е на ръководителя.',
          },
          {
            key: 'chat.workerModel',
            kind: 'select',
            en: 'Worker',
            bg: 'Изпълнител',
            doesEn: 'With two chats: the worker\'s model, beside the lead\'s; "The lead\'s model" when none is chosen, or chosen by hand in the Copilot window.',
            doesBg: 'С два чата: моделът на изпълнителя, до този на ръководителя; „Моделът на ръководителя“, когато не е избран, или ръчно в прозореца на Copilot.',
          },
          {
            key: 'chat.workerSameModel',
            kind: 'select',
            en: 'The lead\'s model',
            bg: 'Моделът на ръководителя',
            doesEn: 'The worker works on the lead\'s model.',
            doesBg: 'Изпълнителят работи на модела на ръководителя.',
          },
          {
            key: 'lead.subtask',
            kind: 'disclosure',
            en: 'Subtask {n}: {title}',
            bg: 'Подзадача {n}: {title}',
            doesEn: 'With two chats: a subtask the lead gave, as the worker did it — its commands and its report; open while it runs, folded once it ended. Marked when it only reads, or went to a new worker.',
            doesBg: 'С два чата: подзадача, дадена от ръководителя, както я е изпълнил изпълнителят — командите и докладът му; отворена, докато върви, сгъната, щом свърши. Отбелязана, когато само чете или е дадена на нов изпълнител.',
          },
          {
            key: 'lead.plan',
            kind: 'disclosure',
            en: 'The lead\'s plan (version {v})',
            bg: 'Планът на ръководителя (версия {v})',
            doesEn: 'With two chats: the lead\'s plan, folded under its message; approved in the conversation first when "Plan mode" is ticked.',
            doesBg: 'С два чата: планът на ръководителя, сгънат под съобщението; първо се одобрява в разговора, когато „Режим на план“ е отметнат.',
          },
          {
            key: 'lead.question',
            kind: 'note',
            en: 'The lead asks you',
            bg: 'Ръководителят ви пита',
            doesEn: 'With two chats: a question only you can answer, from the lead, on a card in the conversation; the work waits for it.',
            doesBg: 'С два чата: въпрос, на който само вие можете да отговорите, от ръководителя, на карта в разговора; работата го чака.',
          },
          {
            key: 'lead.answer',
            kind: 'field',
            en: 'Your answer',
            bg: 'Вашият отговор',
            doesEn: 'On the lead\'s card: your answer, written out; or press one of the choices it offered above.',
            doesBg: 'На картата на ръководителя: отговорът ви, написан; или натиснете някой от вариантите, които е предложил отгоре.',
          },
          {
            key: 'lead.send',
            kind: 'button',
            en: 'Send the answer',
            bg: 'Изпрати отговора',
            doesEn: 'Sends your answer to the lead, and the work goes on.',
            doesBg: 'Изпраща отговора ви на ръководителя и работата продължава.',
          },
          {
            key: 'lead.stop',
            kind: 'button',
            en: 'Stop the task',
            bg: 'Спри задачата',
            doesEn: 'Stops the task at the lead\'s question; what was done so far stays.',
            doesBg: 'Спира задачата на въпроса на ръководителя; направеното дотук остава.',
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
            key: 'nav.appearance',
            kind: 'button',
            en: 'Appearance',
            bg: 'Изглед',
            doesEn: 'In the bar on top, between Settings and System: the theme (System, Light, Dark), the text size with A− and A+, and the reading aids — night light, underlined links, less motion, more contrast, a thick focus outline, the system\'s cursor.',
            doesBg: 'В лентата горе, между Настройки и Система: темата (Системна, Светла, Тъмна), размерът на текста с A− и A+, и помощните опции — нощна светлина, подчертани връзки, по-малко движение, повече контраст, дебел фокусен контур, курсорът на системата.',
          },
          {
            key: 'wb.move',
            kind: 'button',
            en: 'Move {name}',
            bg: 'Премести {name}',
            doesEn: 'The grip ⠿ at the head of the explorer, of the editor and of the chat: drag it onto another panel and the two swap places — the chat where the editor was, for one — or click it and choose to the left, to the middle or to the right. The order is kept in this browser; "Put the panels back where they were" (Ctrl+K) undoes it.',
            doesBg: 'Дръжката ⠿ в заглавието на изследователя, на редактора и на чата: хванете я и я пуснете върху друг панел — двата си разменят местата, например чатът отива там, където е бил редакторът; или щракнете и изберете наляво, в средата или надясно. Подредбата се помни в този браузър; „Върни панелите по местата им“ (Ctrl+K) я връща.',
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
        headingKey: 'search.title',
        en: 'Search',
        bg: 'Търсене',
        controls: [
          {
            key: 'search.input',
            kind: 'field',
            en: 'Search',
            bg: 'Търсене',
            doesEn: 'The text to find in the open folder\'s files, searched a moment after you stop typing (Enter searches at once). Files git ignores and files that are not text are left out; files not committed yet are searched.',
            doesBg: 'Текстът, който да се намери във файловете на отворената папка; търси се малко след като спрете да пишете (Enter търси веднага). Файловете, които git пренебрегва, и тези, които не са текст, се пропускат; още некомитнатите се търсят.',
          },
          {
            key: 'search.matchCase',
            kind: 'button',
            en: 'Match Case',
            bg: 'Главни и малки букви',
            doesEn: 'Aa inside the box: only matches with the same capitals.',
            doesBg: 'Aa в полето: само съвпадения със същите главни и малки букви.',
          },
          {
            key: 'search.wholeWord',
            kind: 'button',
            en: 'Match Whole Word',
            bg: 'Само цели думи',
            doesEn: 'ab inside the box: only whole words, not part of a longer one.',
            doesBg: 'ab в полето: само цели думи, не част от по-дълга.',
          },
          {
            key: 'search.regex',
            kind: 'button',
            en: 'Use Regular Expression',
            bg: 'Регулярен израз',
            doesEn: '.* inside the box: the text is a regular expression (PCRE); one that is not valid is said under the box.',
            doesBg: '.* в полето: текстът е регулярен израз (PCRE); невалиден се казва под полето.',
          },
          {
            key: 'search.details',
            kind: 'button',
            en: 'Toggle Search Details',
            bg: 'Покажи или скрий подробностите',
            doesEn: 'The … beside the box: shows the files to include and to exclude.',
            doesBg: 'Трите точки до полето: показва файловете за включване и изключване.',
          },
          {
            key: 'search.include',
            kind: 'field',
            en: 'files to include',
            bg: 'файлове за включване',
            doesEn: 'Globs, separated by commas: *.ts in any folder, src/** from the root, a folder by its name.',
            doesBg: 'Шаблони, разделени със запетаи: *.ts във всяка папка, src/** от корена, папка по името ѝ.',
          },
          {
            key: 'search.exclude',
            kind: 'field',
            en: 'files to exclude',
            bg: 'файлове за изключване',
            doesEn: 'Globs, as for the files to include, of files left out of the search.',
            doesBg: 'Шаблони, като за включване, на файлове, оставени извън търсенето.',
          },
          {
            key: 'search.refresh',
            kind: 'button',
            en: 'Refresh',
            bg: 'Опресни',
            doesEn: 'Searches again, for files changed since.',
            doesBg: 'Търси наново, за файлове, променени оттогава.',
          },
          {
            key: 'search.clear',
            kind: 'button',
            en: 'Clear Search Results',
            bg: 'Изчисти резултатите',
            doesEn: 'Empties the box and the results.',
            doesBg: 'Изпразва полето и резултатите.',
          },
          {
            key: 'search.collapse',
            kind: 'button',
            en: 'Collapse All',
            bg: 'Свий всички',
            doesEn: 'Folds every file of the results (pressed again: Expand All). A file\'s row folds or opens it; a line of it opens the file at that line, the match chosen.',
            doesBg: 'Свива всеки файл от резултатите (натиснато пак: Разгъни всички). Редът на файл го свива или разгъва; негов ред отваря файла на този ред, със съвпадението избрано.',
          },
          {
            key: 'quick.label',
            kind: 'field',
            en: 'Go to File',
            bg: 'Отиди на файл',
            doesEn: 'Ctrl+P: a box at the top of the screen that finds a file of the open folder by a few letters of its name, the letters marked; Enter opens it, and name:42 opens it at line 42. The files open in the editor come first.',
            doesBg: 'Ctrl+P: поле горе на екрана, което намира файл от отворената папка по няколко букви от името му, със съвпадащите букви отбелязани; Enter го отваря, а име:42 го отваря на ред 42. Отворените в редактора файлове са първи.',
          },
          {
            key: 'ed.viewPreview',
            kind: 'button',
            en: 'Preview',
            bg: 'Преглед',
            doesEn: 'On a Markdown file (with Code and Side by side, or Ctrl+Shift+V): the file as it reads — headings, lists, tables, code in colour, pictures of the folder, and ```mermaid blocks drawn as diagrams. It opens so by default; the choice is kept.',
            doesBg: 'На Markdown файл (с „Код“ и „Едно до друго“, или Ctrl+Shift+V): файлът, както изглежда — заглавия, списъци, таблици, оцветен код, картинки от папката и ```mermaid блокове, начертани като диаграми. По подразбиране се отваря така; изборът се помни.',
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
    purposeEn: 'The base prompt, to read; the projects, each with its folder, branch and level 2 (which Kerrigan carries); the sign-in to Copilot; the model of new conversations and of the review; how a task runs. Every field has an ⓘ saying what it is for. Everything saves itself.',
    purposeBg: 'Основният prompt, за четене; проектите, всеки с папката, клона и шаблона си ниво 2 (който Кериган носи); входът в Copilot; моделът на новите разговори и на рецензията; как върви една задача. Всяко поле има ⓘ, което казва за какво е. Всичко се запазва само.',
    sections: [
      {
        headingKey: 'def.title',
        en: 'Settings',
        bg: 'Настройки',
        controls: [
          {
            key: 'def.autoSave',
            kind: 'note',
            en: 'Everything on this page saves itself as you change it. There is nothing to press.',
            bg: 'Всичко на тази страница се запазва само, докато го променяте. Няма какво да натискате.',
            doesEn: 'Everything on the page saves itself as it is changed.',
            doesBg: 'Всичко на страницата се запазва само, докато се променя.',
          },
          {
            key: 'def.saveAnyway',
            kind: 'button',
            en: 'Save',
            bg: 'Запази',
            doesEn: 'Saves what is already saved, for the comfort of pressing something.',
            doesBg: 'Запазва вече запазеното — за спокойствие.',
          },
        ],
      },
      {
        headingKey: 'l1.title',
        en: 'The base prompt (level 1)',
        bg: 'Основен prompt (ниво 1)',
        controls: [
          {
            key: 'l1.readOnly',
            kind: 'badge',
            en: 'read only',
            bg: 'само за четене',
            doesEn: 'The base prompt is not edited here: it comes with the bot and changes when the bot is updated.',
            doesBg: 'Основният prompt не се редактира тук: идва с бота и се сменя, когато ботът се обнови.',
          },
          {
            key: 'l1.show',
            kind: 'disclosure',
            en: 'Show the whole text',
            bg: 'Покажи целия текст',
            doesEn: 'Opens the whole text the bot gives Copilot at the start of each conversation: how it works through a task with commands and takes it to its end.',
            doesBg: 'Отваря целия текст, който ботът дава на Copilot в началото на всеки разговор: как работи по задачата с команди и я довежда до край.',
          },
        ],
      },
      {
        headingKey: 'proj.title',
        en: 'Projects',
        bg: 'Проекти',
        controls: [
          {
            key: 'proj.isDefault',
            kind: 'badge',
            en: 'the chat\'s folder',
            bg: 'папката на чата',
            doesEn: 'On the first project: the chat works in its folder.',
            doesBg: 'На първия проект: чатът работи в неговата папка.',
          },
          {
            key: 'proj.otherRepo',
            kind: 'badge',
            en: 'git repository',
            bg: 'git хранилище',
            doesEn: 'The folder is a git repository: each message can be undone, and its changes shown.',
            doesBg: 'Папката е git хранилище: всяко съобщение може да се отмени, а промените му — да се покажат.',
          },
          {
            key: 'proj.otherNotRepo',
            kind: 'badge',
            en: 'not a git repository',
            bg: 'не е git хранилище',
            doesEn: 'The folder is not a git repository; "git init" in it makes it one.',
            doesBg: 'Папката не е git хранилище; „git init“ в нея я прави такова.',
          },
          {
            key: 'proj.branch',
            kind: 'badge',
            en: 'Branch: {name}',
            bg: 'Клон: {name}',
            doesEn: 'The branch checked out in the folder now. The chat works on it and makes no branch of its own.',
            doesBg: 'Клонът, изтеглен в папката сега. Чатът работи върху него и не прави свой клон.',
          },
          {
            key: 'proj.entryName',
            kind: 'field',
            en: 'Name',
            bg: 'Име',
            doesEn: 'What the project is called; empty, the folder\'s own name.',
            doesBg: 'Как се казва проектът; ако е празно — името на папката.',
          },
          {
            key: 'proj.entryDir',
            kind: 'field',
            en: 'Folder',
            bg: 'Папка',
            doesEn: 'The project\'s folder; for the first project, where the chat works.',
            doesBg: 'Папката на проекта; за първия проект — там, където работи чатът.',
          },
          {
            key: 'mirror.browse',
            kind: 'button',
            en: 'Browse…',
            bg: 'Избери папка…',
            doesEn: 'Opens the machine\'s folder dialog to pick the folder.',
            doesBg: 'Отваря прозореца за избор на папка на машината.',
          },
          {
            key: 'proj.clear',
            kind: 'button',
            en: 'Clear',
            bg: 'Изчисти',
            doesEn: 'On the first project: clears it, so no folder is open for the chat.',
            doesBg: 'На първия проект: изчиства го, така че за чата няма отворена папка.',
          },
          {
            key: 'proj.otherRemove',
            kind: 'button',
            en: 'Remove',
            bg: 'Махни',
            doesEn: 'On another project: takes it out of the list (the folder stays where it is).',
            doesBg: 'На друг проект: маха го от списъка (папката си остава на мястото).',
          },
          {
            key: 'proj.readOnly',
            kind: 'checkbox',
            en: 'For reference only (no changes)',
            bg: 'Само за справка (без промени)',
            doesEn: 'Ticked, the bot reads the project and runs what only reads it, and changes nothing there: after every command whatever changed in it — files, branches, what is staged — is put back, and the chat is told. On the chat\'s own folder, every message can then only read and report.',
            doesBg: 'Отметнато, ботът чете проекта и пуска това, което само го чете, без да променя нищо там: след всяка команда всичко променено в него — файлове, клонове, подготвеното за commit — се връща, и чатът научава. Ако е папката на чата, всяко съобщение може само да чете и да докладва.',
          },
          {
            key: 'proj.level2',
            kind: 'field',
            en: 'Level 2 template (for Kerrigan)',
            bg: 'Шаблон ниво 2 (за Кериган)',
            doesEn: 'What you write about the project — its stack, conventions, how its tests run, what not to touch. It goes into Kerrigan, saved or copied; the bot sends it nowhere by itself.',
            doesBg: 'Каквото напишете за проекта — на какво е, правилата му, как се пускат тестовете, какво да не се пипа. Влиза в Кериган, свалена или копирана; ботът сам не го изпраща никъде.',
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
            doesEn: 'The new project\'s name.',
            doesBg: 'Името на новия проект.',
          },
          {
            key: 'proj.entryDir',
            kind: 'field',
            en: 'Folder',
            bg: 'Папка',
            doesEn: 'The new project\'s folder.',
            doesBg: 'Папката на новия проект.',
          },
          {
            key: 'mirror.browse',
            kind: 'button',
            en: 'Browse…',
            bg: 'Избери папка…',
            doesEn: 'Opens the machine\'s folder dialog to pick the folder.',
            doesBg: 'Отваря прозореца за избор на папка на машината.',
          },
          {
            key: 'proj.otherAdd',
            kind: 'button',
            en: 'Add',
            bg: 'Добави',
            doesEn: 'Adds it to the projects; its level 2 can then be written.',
            doesBg: 'Добавя го към проектите; после може да се напише шаблонът му ниво 2.',
          },
        ],
      },
      {
        headingKey: 'skills.title',
        en: 'Skills',
        bg: 'Skill-ове',
        controls: [
          {
            key: 'skills.name',
            kind: 'field',
            en: 'Name',
            bg: 'Име',
            doesEn: 'What the skill is called by: lowercase with hyphens (new-test), typed after / at the start of a message.',
            doesBg: 'Как се извиква skill-ът: с малки букви и тирета (new-test), написано след / в началото на съобщение.',
          },
          {
            key: 'skills.description',
            kind: 'field',
            en: 'What it is for',
            bg: 'За какво е',
            doesEn: 'One line on which tasks it is for, shown in the chat\'s list.',
            doesBg: 'Един ред за кои задачи е, показан в списъка на чата.',
          },
          {
            key: 'skills.project',
            kind: 'select',
            en: 'Project',
            bg: 'Проект',
            doesEn: 'The project the skill is for, or every project.',
            doesBg: 'Проектът, за който е skill-ът, или всички проекти.',
          },
          {
            key: 'skills.text',
            kind: 'field',
            en: 'Instructions',
            bg: 'Инструкции',
            doesEn: 'What the chat should know and do for this kind of task — where files go, conventions, steps, how to check it — sent with the message.',
            doesBg: 'Какво трябва да знае и да прави чатът за този вид задача — къде отиват файловете, правилата, стъпките, как се проверява — изпраща се със съобщението.',
          },
          {
            key: 'skills.remove',
            kind: 'button',
            en: 'Remove',
            bg: 'Махни',
            doesEn: 'Takes the skill out of the list; messages already sent with it keep it.',
            doesBg: 'Маха skill-а от списъка; вече изпратените с него съобщения го запазват.',
          },
          {
            key: 'skills.add',
            kind: 'button',
            en: 'Add the skill',
            bg: 'Добави skill-а',
            doesEn: 'Adds the skill written in the fields above it.',
            doesBg: 'Добавя skill-а, написан в полетата над него.',
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
            doesEn: 'The account to sign in with, optional.',
            doesBg: 'Акаунтът, с който да се влезе, по желание.',
          },
          {
            key: 'login.button',
            kind: 'button',
            en: 'Sign in to Copilot',
            bg: 'Вход в Copilot',
            doesEn: 'Opens the bot\'s Edge window for you to sign in to Copilot yourself.',
            doesBg: 'Отваря прозореца на Edge на бота, за да влезете сами в Copilot.',
          },
          {
            key: 'login.busy',
            kind: 'note',
            en: 'Waiting for you to sign in…',
            bg: 'Чака да влезете…',
            doesEn: 'What the button says while it waits for the sign-in.',
            doesBg: 'Какво пише бутонът, докато чака входа.',
          },
        ],
      },
      {
        headingKey: 'def.modelTitle',
        en: 'Model for new conversations',
        bg: 'Модел за новите разговори',
        controls: [
          {
            key: 'def.modelField',
            kind: 'select',
            en: 'Model',
            bg: 'Модел',
            doesEn: 'The model a new conversation starts on, unless one is chosen under the chat\'s box.',
            doesBg: 'Моделът, с който започва нов разговор, освен ако под полето на чата не е избран друг.',
          },
          {
            key: 'def.modelNone',
            kind: 'select',
            en: 'Leave the chat on whatever it is set to',
            bg: 'Остави чата на каквото е настроен',
            doesEn: 'No model chosen here.',
            doesBg: 'Тук не е избран модел.',
          },
          {
            key: 'proj.clear',
            kind: 'button',
            en: 'Clear',
            bg: 'Изчисти',
            doesEn: 'Clears the choice.',
            doesBg: 'Изчиства избора.',
          },
          {
            key: 'model.refresh',
            kind: 'button',
            en: 'Read the list from Copilot',
            bg: 'Прочети списъка от Copilot',
            doesEn: 'Opens Copilot for a moment and reads the models its picker offers.',
            doesBg: 'Отваря Copilot за момент и прочита моделите, които предлага изборът му.',
          },
          {
            key: 'def.manualModel',
            kind: 'checkbox',
            en: 'Choose the model by hand at the start of each run',
            bg: 'Избирай модела ръчно в началото на всяко пускане',
            doesEn: 'Nothing is chosen for you: at the start of a run, and of a review, a card asks you to choose the model in the Copilot window and press "Ready".',
            doesBg: 'Нищо не се избира вместо вас: в началото на пускане и на рецензия карта ви моли да изберете модела в прозореца на Copilot и да натиснете „Готово“.',
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
            doesEn: 'The model the review\'s conversation is put on: best a different, stronger one than the work\'s.',
            doesBg: 'Моделът, на който се слага разговорът на рецензията: най-добре друг, по-силен от този на работата.',
          },
          {
            key: 'def.reviewNone',
            kind: 'select',
            en: 'None chosen here',
            bg: 'Не е избран тук',
            doesEn: 'No model chosen for the review.',
            doesBg: 'Не е избран модел за рецензията.',
          },
          {
            key: 'model.refresh',
            kind: 'button',
            en: 'Read the list from Copilot',
            bg: 'Прочети списъка от Copilot',
            doesEn: 'Reads the models from Copilot again.',
            doesBg: 'Прочита моделите от Copilot отново.',
          },
        ],
      },
      {
        headingKey: 'exec.title',
        en: 'Execution',
        bg: 'Изпълнение',
        controls: [
          {
            key: 'exec.autoContinue',
            kind: 'field',
            en: 'Keep going after a limit',
            bg: 'Продължавай след лимит',
            doesEn: 'How many times a task stopped by a limit is carried on by itself.',
            doesBg: 'Колко пъти задача, спряна от ограничение, продължава сама.',
          },
          {
            key: 'exec.minApproaches',
            kind: 'field',
            en: 'Approaches the chat must try before it may give up',
            bg: 'Подходи, които чатът трябва да опита, преди да се откаже',
            doesEn: 'How many different approaches the chat must try before it may say the task is blocked.',
            doesBg: 'Колко различни подхода чатът трябва да опита, преди да каже, че задачата е блокирана.',
          },
          {
            key: 'exec.maxReviewRounds',
            kind: 'field',
            en: 'Rounds of fixing after a failed review',
            bg: 'Кръгове поправка след неуспешен преглед',
            doesEn: 'How many times the review\'s findings go back to be fixed before the task ends blocked.',
            doesBg: 'Колко пъти находките на рецензията се връщат за поправка, преди задачата да свърши блокирана.',
          },
          {
            key: 'exec.retryBlocked',
            kind: 'field',
            en: 'When a task ends blocked, run it again in a fresh conversation',
            bg: 'Когато задача завърши блокирана, пусни я отново в нов разговор',
            doesEn: 'How many times a blocked task is tried again in a fresh conversation.',
            doesBg: 'Колко пъти блокирана задача се опитва отново в нов разговор.',
          },
          {
            key: 'exec.maxIterations',
            kind: 'field',
            en: 'Most messages to the chat in one task',
            bg: 'Най-много съобщения към чата в една задача',
            doesEn: 'The most messages one task may send to the chat.',
            doesBg: 'Най-много съобщения, които една задача може да изпрати на чата.',
          },
          {
            key: 'exec.maxRunMinutes',
            kind: 'field',
            en: 'Longest a task may run',
            bg: 'Най-дълго време за една задача',
            doesEn: 'The longest a task may run (the time paused not counted).',
            doesBg: 'Най-дългото време на една задача (без времето на пауза).',
          },
          {
            key: 'exec.maxSubtasks',
            kind: 'field',
            en: 'Most subtasks the lead may give',
            bg: 'Най-много подзадачи от ръководителя',
            doesEn: 'The most subtasks the lead of a conversation with two chats may give for one message.',
            doesBg: 'Най-много подзадачи, които ръководителят в разговор с два чата може да даде за едно съобщение.',
          },
          {
            key: 'exec.gap',
            kind: 'checkbox',
            en: 'Pause between messages',
            bg: 'Пауза между съобщенията',
            doesEn: 'Ticked, a message to Copilot waits until "At least" seconds have passed since the one before — to the lead or the worker, in any conversation; the log says how long it waits.',
            doesBg: 'Отметнато, съобщение към Copilot чака, докато от предишното минат „Най-малко“ секунди — към ръководителя или изпълнителя, във всеки разговор; дневникът казва колко чака.',
          },
          {
            key: 'exec.gapSec',
            kind: 'field',
            en: 'At least',
            bg: 'Най-малко',
            doesEn: 'Shown with the pause: its shortest time, in seconds (60: one a minute at most).',
            doesBg: 'Показва се с паузата: най-краткото ѝ време, в секунди (60: най-много по едно на минута).',
          },
          {
            key: 'exec.gapRandom',
            kind: 'checkbox',
            en: 'Random time',
            bg: 'Случайно време',
            doesEn: 'Shown with the pause: each pause drawn anew between "At least" and "At most" (60 to 90 seconds, say).',
            doesBg: 'Показва се с паузата: всяка пауза се избира наново между „Най-малко“ и „Най-много“ (например 60 до 90 секунди).',
          },
          {
            key: 'exec.gapMax',
            kind: 'field',
            en: 'At most',
            bg: 'Най-много',
            doesEn: 'Shown with a random time: the longest pause, in seconds.',
            doesBg: 'Показва се със случайното време: най-дългата пауза, в секунди.',
          },
          {
            key: 'exec.replyTimeout',
            kind: 'field',
            en: 'How long to wait for a reply from the chat',
            bg: 'Колко да се чака отговор от чата',
            doesEn: 'How long to wait for one reply from Copilot.',
            doesBg: 'Колко да се чака един отговор от Copilot.',
          },
          {
            key: 'exec.isolation',
            kind: 'select',
            en: 'Where the bot runs',
            bg: 'Къде върви ботът',
            doesEn: 'What contains the commands: only an isolated place, or your acceptance, lets a run go without supervision.',
            doesBg: 'Какво ограничава командите: само изолирано място или вашето съгласие позволяват пускане без надзор.',
          },
          {
            key: 'exec.isolationNone',
            kind: 'select',
            en: 'Nowhere in particular — this account',
            bg: 'Никъде специално — в този акаунт',
            doesEn: 'Nothing contains them: commands run only with you watching.',
            doesBg: 'Нищо не ги ограничава: командите се изпълняват само когато гледате.',
          },
          {
            key: 'exec.isolationNoneAccepted',
            kind: 'select',
            en: 'This account — I accept unattended runs without isolation',
            bg: 'В този акаунт — приемам пускане без надзор без изолация',
            doesEn: 'This account, and you accept unattended runs without isolation.',
            doesBg: 'Този акаунт, и приемате пускане без надзор без изолация.',
          },
          {
            key: 'exec.isolationAccount',
            kind: 'select',
            en: 'A separate low-privilege Windows account',
            bg: 'Отделен Windows акаунт с малки права',
            doesEn: 'A separate low-privilege Windows account.',
            doesBg: 'Отделен Windows акаунт с малки права.',
          },
          {
            key: 'exec.isolationSandbox',
            kind: 'select',
            en: 'Windows Sandbox',
            bg: 'Windows Sandbox',
            doesEn: 'Windows Sandbox.',
            doesBg: 'Windows Sandbox.',
          },
          {
            key: 'exec.isolationVm',
            kind: 'select',
            en: 'A virtual machine',
            bg: 'Виртуална машина',
            doesEn: 'A virtual machine.',
            doesBg: 'Виртуална машина.',
          },
          {
            key: 'exec.startMode',
            kind: 'select',
            en: 'Starting a run without supervision',
            bg: 'Пускане без надзор',
            doesEn: 'Whether the first message run without asking asks "are you sure" first.',
            doesBg: 'Дали първото съобщение, пуснато без питане, първо пита „сигурен ли си“.',
          },
          {
            key: 'exec.startModeAsk',
            kind: 'select',
            en: 'Ask "are you sure" every time',
            bg: 'Питай „сигурен ли си“ всеки път',
            doesEn: 'Asks every time.',
            doesBg: 'Пита всеки път.',
          },
          {
            key: 'exec.startModeAuto',
            kind: 'select',
            en: 'Start it without asking',
            bg: 'Пускай, без да питаш',
            doesEn: 'Starts without asking.',
            doesBg: 'Започва, без да пита.',
          },
          {
            key: 'exec.networkFetch',
            kind: 'select',
            en: 'A command that downloads, in a run without supervision',
            bg: 'Команда, която тегли от интернет, при пускане без надзор',
            doesEn: 'What a run without supervision does with a command that downloads.',
            doesBg: 'Какво прави пускане без надзор с команда, която тегли от интернет.',
          },
          {
            key: 'exec.networkFetchAsk',
            kind: 'select',
            en: 'Wait for me on the approval screen',
            bg: 'Чакай ме на екрана за одобрение',
            doesEn: 'Waits for you to decide.',
            doesBg: 'Чака да решите.',
          },
          {
            key: 'exec.networkFetchRefuse',
            kind: 'select',
            en: 'Refuse it and tell the chat why — the run never waits',
            bg: 'Откажи я и кажи на чата защо — пускането никога не чака',
            doesEn: 'Refuses it and tells the chat why.',
            doesBg: 'Отказва я и казва на чата защо.',
          },
          {
            key: 'exec.networkFetchRun',
            kind: 'select',
            en: 'Run it without asking',
            bg: 'Изпълни я, без да питаш',
            doesEn: 'Runs it without asking.',
            doesBg: 'Изпълнява я, без да пита.',
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
