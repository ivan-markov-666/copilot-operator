'use client';

/**
 * UI language: English and Bulgarian, switchable from the header and remembered per browser.
 *
 * Only the interface is translated. Level 1, level 2 and the tasks go to Copilot exactly as
 * written by the user, in whatever language they chose; the contract itself stays English
 * because that is what the parser and the persona were verified against.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Locale = 'en' | 'bg';

const STORAGE_KEY = 'cop.locale';

const dict = {
  en: {
    // layout
    'nav.sessions': 'Sessions',
    'nav.level1': 'Level 1 contract',
    'nav.presets': 'Level 2 presets',
    'nav.system': 'System',
    'lang.label': 'Language',

    // home
    'home.apiDown': 'The API is not reachable.',
    'home.apiHint': 'Start it from the project folder with {cmd}. Expected at {url}.',
    'home.new': 'New session',
    'home.newHint':
      'A session is one Copilot conversation. Tasks inside it run one after another in that same chat, so later tasks can build on earlier ones.',
    'home.namePlaceholder': 'Session name, e.g. payments-service',
    'home.create': 'Create',
    'home.sessions': 'Sessions',
    'home.loading': 'Loading…',
    'home.none': 'None yet.',
    'home.col.name': 'Name',
    'home.col.tasks': 'Tasks',
    'home.col.state': 'State',
    'home.col.chat': 'Chat',
    'home.col.created': 'Created',
    'home.tasksDetail': '({done} done, {queued} queued)',
    'home.notOpened': 'not opened',

    // states
    'state.running': 'running',
    'state.idle': 'idle',
    'state.stopping': 'stopping',
    'status.queued': 'queued',
    'status.running': 'running',
    'status.waiting-approval': 'waiting for approval',
    'status.done': 'done',
    'status.failed': 'failed',
    'status.aborted': 'aborted',
    'status.limit-reached': 'limit reached',

    // session header
    'session.crumb': 'Sessions',
    'session.run': 'Run {n} queued task(s) (confirm each step)',
    'session.runUnattended': 'Run unattended',
    'session.unattendedConfirm': 'Unattended: commands written by Copilot will run without asking. Continue?',
    'session.stop': 'Stop after current step',
    'session.started': 'started ({mode})',
    'session.notStarted': 'not started: {reason}',
    'session.stopping': 'stopping after the current step',
    'session.openChat': 'open chat: {name}',
    'session.noChat': 'no conversation yet; the first run opens one',

    // approval
    'approval.title': 'Step {n} is waiting for you',
    'approval.run': 'Run',
    'approval.skip': 'Skip',
    'approval.abort': 'Abort task',

    // level 1 panel
    'l1.title': 'Level 1: the contract with the runner',
    'l1.sent': 'sent in this conversation',
    'l1.notSent': 'sent with the first task',
    'l1.edit': 'edit',
    'l1.hint':
      'Has priority over the level 2 instructions of every task below. Defines the phases, the json format, the stop word and the final summary.',
    'l1.customised': 'Using your customised copy.',
    'l1.show': 'show the contract',

    // mirror
    'mirror.title': 'Project files for the chat',
    'mirror.hint':
      'Selected directories are copied to one flat folder on the Desktop with the path in the file name ({example}), only changed files are rewritten, and the files are attached to the first message of each task. Attaching uploads a copy to your OneDrive.',
    'mirror.enable': 'attach project files',
    'mirror.root': 'Project root',
    'mirror.listDirs': 'List directories',
    'mirror.noDirs': 'no selectable directories',
    'mirror.include': 'Include (one per line; a directory includes everything beneath it)',
    'mirror.exclude': 'Exclude (one per line)',
    'mirror.save': 'Save',
    'mirror.saved': 'saved',

    // tasks
    'tasks.title': 'Tasks',
    'tasks.hint':
      'Run in this order, in the same conversation. When one finishes with a summary, the next queued one starts. A task that ends any other way stops the run and leaves the rest queued.',
    'tasks.none': 'No tasks yet. Add one below.',
    'task.iterations': '{n} iteration(s)',
    'task.edit': 'Edit',
    'task.cancel': 'Cancel',
    'task.delete': 'Delete',
    'task.deleteConfirm': 'Delete queued task "{title}"?',
    'task.started': 'started {t}',
    'task.added': 'added {t}',
    'task.finished': 'finished {t}',
    'task.save': 'Save',
    'task.whatWasDone': 'What was done',
    'task.promptAndL2': 'task prompt and level 2',
    'task.l2': 'level 2',
    'task.prompt': 'task',
    'task.firstMessage': 'the exact first message that opened this task',
    'task.files': 'everything executed, and the files',
    'task.log': 'task-log.txt: the whole task as text',
    'task.reports': 'reports sent to Copilot:',
    'task.artifacts': 'downloaded files:',
    'task.replies': 'raw replies:',
    'task.finalReply': 'the last message Copilot sent',

    // task form
    'form.title': 'Add a task',
    'form.hint':
      'Goes to the end of the queue. If the session is running it will be picked up after the current tasks; if it is idle, press Run above. Level 2 is prefilled from the previous task so a series of tasks shares it.',
    'form.titleLabel': 'Title',
    'form.titlePlaceholder': 'short name, e.g. run the unit tests',
    'form.taskLabel': 'Task',
    'form.taskPlaceholder': 'What to do, what the result should be, what is out of bounds.',
    'form.add': 'Add to queue',
    'form.queued': 'queued',

    // level 2 editor
    'l2.label': 'Level 2: project, domain and team instructions for this task',
    'l2.loadPreset': 'load a preset…',
    'l2.saveAs': 'Save as preset',
    'l2.saveAsPrompt': 'Save these level 2 instructions as a preset named:',
    'l2.savedAs': 'saved as "{name}"',
    'l2.placeholder':
      'What the runner cannot know: the project, its layout, how tests run, the conventions, what never to touch.\nLeave empty if there is nothing to add. Level 1 always wins over anything here.',

    // live
    'live.title': 'Live',
    'live.none': 'Nothing yet. Events appear here while a run is in progress.',

    // level 1 page
    'l1page.title': 'Level 1: the contract with the runner',
    'l1page.hint':
      'Sent once at the start of every conversation, before any project instructions. It defines the phases, the json format, the stop word, the final summary and the rules that level 2 cannot override. Edit it only if you know why: the parser expects exactly the format described here.',
    'l1page.custom': 'Customised copy in data/level1.md',
    'l1page.shipped': 'Shipped version, prompts/level1.md',
    'l1page.unsaved': 'unsaved changes',
    'l1page.save': 'Save',
    'l1page.saved': 'Saved. Applies to sessions started from now on.',
    'l1page.reset': 'Reset to shipped',
    'l1page.resetConfirm': 'Discard your edits and go back to the contract shipped with the project?',
    'l1page.resetDone': 'Reset to the shipped contract.',

    // presets page
    'presets.title': 'Level 2 presets',
    'presets.hint':
      "Level 2 is what you know and the runner does not: the project, the domain, the team's conventions, the tools in use. It is sent with every task and can be different for every task. Save the ones you reuse here and pick them when adding a task. Level 1 always has priority over anything written here.",
    'presets.name': 'Name',
    'presets.namePlaceholder': 'e.g. payments-service team',
    'presets.content': 'Instructions',
    'presets.contentPlaceholder': 'Project: ...\nRepository layout: ...\nHow we run tests: ...\nThings never to touch: ...',
    'presets.save': 'Save preset',
    'presets.saved': 'Saved "{name}".',
    'presets.list': 'Saved',
    'presets.none': 'None yet.',
    'presets.edit': 'Edit',
    'presets.delete': 'Delete',
    'presets.deleteConfirm': 'Delete preset "{name}"?',
    'presets.show': 'show',

    // system page
    'sys.machine': 'This machine',
    'sys.loading': 'Loading…',
    'sys.node': 'Node',
    'sys.edge': 'Edge',
    'sys.edgeMissing': 'not found',
    'sys.profile': 'Bot profile',
    'sys.profileMissing': '(not created yet: run cop login)',
    'sys.profileInUse': 'Profile in use',
    'sys.profileHeld': 'Edge is holding the profile (pids {pids}). A run would fail. Close that Edge window.',
    'sys.profileUnknown': 'could not check',
    'sys.profileFree': 'free',
    'sys.desktop': 'Desktop',
    'sys.desktopSynced': '(backed up by OneDrive)',
    'sys.desktopLocal': '(not backed up by OneDrive; mirror stays local)',
    'sys.cwd': 'Commands run in',
    'sys.runs': 'Runs folder',
    'sys.data': 'Data folder',
    'sys.mode': 'Default mode',
    'sys.settings': 'Settings',
    'sys.settingsHint':
      'Read from {file} next to the project. It has the same shape as {example}; anything missing takes the default. Edit the file and restart the API.',
    'sys.asSaved': 'As saved',
    'sys.resolved': 'Resolved paths',
    'sys.signin': 'Sign-in',
    'sys.signinHint': 'Signing in is done once, from the terminal, so that the bot never handles credentials:',
  },

  bg: {
    'nav.sessions': 'Сесии',
    'nav.level1': 'Договор ниво 1',
    'nav.presets': 'Шаблони ниво 2',
    'nav.system': 'Система',
    'lang.label': 'Език',

    'home.apiDown': 'API-то не отговаря.',
    'home.apiHint': 'Пуснете го от папката на проекта с {cmd}. Очаква се на {url}.',
    'home.new': 'Нова сесия',
    'home.newHint':
      'Сесията е един разговор с Copilot. Задачите в нея се изпълняват една след друга в същия чат, така че следващите могат да стъпват на предишните.',
    'home.namePlaceholder': 'Име на сесията, напр. payments-service',
    'home.create': 'Създай',
    'home.sessions': 'Сесии',
    'home.loading': 'Зареждане…',
    'home.none': 'Още няма.',
    'home.col.name': 'Име',
    'home.col.tasks': 'Задачи',
    'home.col.state': 'Състояние',
    'home.col.chat': 'Чат',
    'home.col.created': 'Създадена',
    'home.tasksDetail': '({done} готови, {queued} чакащи)',
    'home.notOpened': 'не е отворен',

    'state.running': 'работи',
    'state.idle': 'свободна',
    'state.stopping': 'спира',
    'status.queued': 'чака',
    'status.running': 'работи',
    'status.waiting-approval': 'чака одобрение',
    'status.done': 'готова',
    'status.failed': 'провалена',
    'status.aborted': 'прекратена',
    'status.limit-reached': 'достигнат лимит',

    'session.crumb': 'Сесии',
    'session.run': 'Изпълни {n} чакаща(и) задача(и) (с потвърждение на всяка стъпка)',
    'session.runUnattended': 'Изпълни без потвърждение',
    'session.unattendedConfirm': 'Без потвърждение: командите, написани от Copilot, ще се изпълняват без да питат. Продължавате ли?',
    'session.stop': 'Спри след текущата стъпка',
    'session.started': 'стартирано ({mode})',
    'session.notStarted': 'не е стартирано: {reason}',
    'session.stopping': 'спира след текущата стъпка',
    'session.openChat': 'отвори чата: {name}',
    'session.noChat': 'още няма разговор; първото изпълнение го отваря',

    'approval.title': 'Стъпка {n} чака вашето решение',
    'approval.run': 'Изпълни',
    'approval.skip': 'Пропусни',
    'approval.abort': 'Прекрати задачата',

    'l1.title': 'Ниво 1: договорът с изпълнителя',
    'l1.sent': 'изпратен в този разговор',
    'l1.notSent': 'изпраща се с първата задача',
    'l1.edit': 'редактирай',
    'l1.hint':
      'Има приоритет над инструкциите от ниво 2 на всяка задача по-долу. Дефинира фазите, JSON формата, стоп думата и финалното обяснение.',
    'l1.customised': 'Използва се вашето редактирано копие.',
    'l1.show': 'покажи договора',

    'mirror.title': 'Файлове на проекта за чата',
    'mirror.hint':
      'Избраните директории се копират в една плоска папка на Desktop с пътя в името на файла ({example}), презаписват се само променените файлове, и файловете се прикачат към първото съобщение на всяка задача. Прикачването качва копие в OneDrive.',
    'mirror.enable': 'прикачай файловете на проекта',
    'mirror.root': 'Корен на проекта',
    'mirror.listDirs': 'Покажи директориите',
    'mirror.noDirs': 'няма подходящи директории',
    'mirror.include': 'Включи (по една на ред; директория включва всичко под нея)',
    'mirror.exclude': 'Изключи (по една на ред)',
    'mirror.save': 'Запази',
    'mirror.saved': 'запазено',

    'tasks.title': 'Задачи',
    'tasks.hint':
      'Изпълняват се в този ред, в същия разговор. Когато една приключи с обяснение, започва следващата чакаща. Задача, която приключи по друг начин, спира изпълнението и останалите остават да чакат.',
    'tasks.none': 'Още няма задачи. Добавете по-долу.',
    'task.iterations': '{n} итерация(и)',
    'task.edit': 'Редактирай',
    'task.cancel': 'Отказ',
    'task.delete': 'Изтрий',
    'task.deleteConfirm': 'Да изтрия ли чакащата задача „{title}“?',
    'task.started': 'започната {t}',
    'task.added': 'добавена {t}',
    'task.finished': 'приключила {t}',
    'task.save': 'Запази',
    'task.whatWasDone': 'Какво е направено',
    'task.promptAndL2': 'задачата и ниво 2',
    'task.l2': 'ниво 2',
    'task.prompt': 'задача',
    'task.firstMessage': 'точното първо съобщение, с което започна задачата',
    'task.files': 'всичко изпълнено и файловете',
    'task.log': 'task-log.txt: цялата задача като текст',
    'task.reports': 'отчети, пратени на Copilot:',
    'task.artifacts': 'свалени файлове:',
    'task.replies': 'сурови отговори:',
    'task.finalReply': 'последното съобщение от Copilot',

    'form.title': 'Добави задача',
    'form.hint':
      'Отива в края на опашката. Ако сесията работи, ще бъде поета след текущите задачи; ако е свободна, натиснете Изпълни горе. Ниво 2 се попълва от предишната задача, така че серия от задачи го споделя.',
    'form.titleLabel': 'Заглавие',
    'form.titlePlaceholder': 'кратко име, напр. пусни unit тестовете',
    'form.taskLabel': 'Задача',
    'form.taskPlaceholder': 'Какво да се направи, какъв трябва да е резултатът, какво е извън обхвата.',
    'form.add': 'Добави в опашката',
    'form.queued': 'добавена',

    'l2.label': 'Ниво 2: инструкции за проекта, домейна и екипа за тази задача',
    'l2.loadPreset': 'зареди шаблон…',
    'l2.saveAs': 'Запази като шаблон',
    'l2.saveAsPrompt': 'Запази тези инструкции от ниво 2 като шаблон с име:',
    'l2.savedAs': 'запазено като „{name}“',
    'l2.placeholder':
      'Това, което изпълнителят не може да знае: проектът, структурата му, как се пускат тестовете, конвенциите, какво никога да не се пипа.\nОставете празно, ако няма какво да добавите. Ниво 1 винаги има предимство пред написаното тук.',

    'live.title': 'На живо',
    'live.none': 'Още нищо. Събитията се появяват тук, докато тече изпълнение.',

    'l1page.title': 'Ниво 1: договорът с изпълнителя',
    'l1page.hint':
      'Изпраща се веднъж в началото на всеки разговор, преди инструкциите за проекта. Дефинира фазите, JSON формата, стоп думата, финалното обяснение и правилата, които ниво 2 не може да променя. Редактирайте го само ако знаете защо: парсърът очаква точно описания тук формат.',
    'l1page.custom': 'Редактирано копие в data/level1.md',
    'l1page.shipped': 'Оригиналът от проекта, prompts/level1.md',
    'l1page.unsaved': 'незапазени промени',
    'l1page.save': 'Запази',
    'l1page.saved': 'Запазено. Важи за сесии, започнати от сега нататък.',
    'l1page.reset': 'Върни оригинала',
    'l1page.resetConfirm': 'Да отхвърля ли редакциите ви и да върна договора, доставен с проекта?',
    'l1page.resetDone': 'Върнат е оригиналният договор.',

    'presets.title': 'Шаблони за ниво 2',
    'presets.hint':
      'Ниво 2 е това, което вие знаете, а изпълнителят не: проектът, домейнът, конвенциите на екипа, използваните инструменти. Изпраща се с всяка задача и може да е различно за всяка. Запазете тук тези, които преизползвате, и ги избирайте при добавяне на задача. Ниво 1 винаги има предимство пред написаното тук.',
    'presets.name': 'Име',
    'presets.namePlaceholder': 'напр. екип payments-service',
    'presets.content': 'Инструкции',
    'presets.contentPlaceholder': 'Проект: ...\nСтруктура на репото: ...\nКак пускаме тестове: ...\nКакво никога да не се пипа: ...',
    'presets.save': 'Запази шаблона',
    'presets.saved': 'Запазено „{name}“.',
    'presets.list': 'Запазени',
    'presets.none': 'Още няма.',
    'presets.edit': 'Редактирай',
    'presets.delete': 'Изтрий',
    'presets.deleteConfirm': 'Да изтрия ли шаблона „{name}“?',
    'presets.show': 'покажи',

    'sys.machine': 'Тази машина',
    'sys.loading': 'Зареждане…',
    'sys.node': 'Node',
    'sys.edge': 'Edge',
    'sys.edgeMissing': 'не е намерен',
    'sys.profile': 'Профил на бота',
    'sys.profileMissing': '(още не е създаден: пуснете cop login)',
    'sys.profileInUse': 'Профилът се ползва от',
    'sys.profileHeld': 'Edge държи профила (pid {pids}). Изпълнение би се провалило. Затворете този прозорец на Edge.',
    'sys.profileUnknown': 'не можа да се провери',
    'sys.profileFree': 'свободен',
    'sys.desktop': 'Desktop',
    'sys.desktopSynced': '(архивира се в OneDrive)',
    'sys.desktopLocal': '(не се архивира в OneDrive; огледалото остава локално)',
    'sys.cwd': 'Командите се изпълняват в',
    'sys.runs': 'Папка с изпълненията',
    'sys.data': 'Папка с данните',
    'sys.mode': 'Режим по подразбиране',
    'sys.settings': 'Настройки',
    'sys.settingsHint':
      'Четат се от {file} до проекта. Има същата форма като {example}; липсващото взема стойността по подразбиране. Редактирайте файла и рестартирайте API-то.',
    'sys.asSaved': 'Както е записано',
    'sys.resolved': 'Изчислени пътища',
    'sys.signin': 'Вписване',
    'sys.signinHint': 'Вписването става веднъж, от терминала, за да не работи ботът никога с пароли:',
  },
} as const;

export type Key = keyof typeof dict.en;

type Ctx = { locale: Locale; setLocale: (l: Locale) => void };
const LocaleContext = createContext<Ctx>({ locale: 'en', setLocale: () => undefined });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY) as Locale | null;
      if (saved === 'en' || saved === 'bg') {
        setLocaleState(saved);
      } else if (navigator.language.toLowerCase().startsWith('bg')) {
        setLocaleState('bg');
      }
    } catch {
      /* storage may be unavailable; English stays */
    }
  }, []);

  const setLocale = (l: Locale) => {
    setLocaleState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = l;
  };

  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>;
}

/** `t('key', { n: 3 })` — looks the key up in the current language, English as fallback. */
export function useT() {
  const { locale } = useContext(LocaleContext);
  const t = (key: Key, vars: Record<string, string | number> = {}): string => {
    const table = dict[locale] as Record<string, string>;
    let s = table[key] ?? (dict.en as Record<string, string>)[key] ?? key;
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
  return { t, locale };
}

export function useLocale(): Ctx {
  return useContext(LocaleContext);
}

export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale();
  const { t } = useT();
  return (
    <select aria-label={t('lang.label')} value={locale} onChange={(e) => setLocale(e.target.value as Locale)} style={{ width: 'auto' }}>
      <option value="en">English</option>
      <option value="bg">Български</option>
    </select>
  );
}

/** Dates in the chosen language's conventions. */
export function useFmtTime() {
  const { locale } = useContext(LocaleContext);
  return (iso?: string): string => {
    if (!iso) return '';
    return new Date(iso).toLocaleString(locale === 'bg' ? 'bg-BG' : undefined, { hour12: false });
  };
}
