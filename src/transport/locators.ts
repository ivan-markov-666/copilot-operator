/**
 * The ONLY file in the project that knows about the Copilot web UI's DOM.
 *
 * Captured live from https://m365.cloud.microsoft/chat on 2026-09-17.
 *
 * Rule of thumb for maintenance: `data-testid` values and `aria-label` values are
 * stable across deployments; Fluent UI class hashes (f1c21dwh, ___7qar2c0, OGl5QnhL)
 * are NOT — never select on them. The `scriptor-*` class names are semantic and
 * are the one exception, because the code-block widget exposes no test id.
 */

/** Stable `data-testid` values in the chat surface. */
export const TestId = {
  /** Scroll container holding every turn. */
  messageList: 'MessageListContainer',
  /** One conversation turn: contains both the user question and the Copilot answer. */
  turn: 'm365-chat-llm-web-ui-chat-message',
  /** The user's own message inside a turn. */
  userMessage: 'chatQuestion',
  /** The Copilot answer inside a turn. */
  assistantOutput: 'chatOutput',
  /** Wrapper of one Copilot answer; its DOM id is `chatMessageResponse-<hash>`. */
  assistantMessage: 'copilot-message-div',
  /** Body of the Copilot answer (no toolbar). */
  assistantReplyBody: 'copilot-message-reply-div',
  /** Rendered markdown of the answer. Download links and code blocks live here. */
  markdownReply: 'markdown-reply',
  /** Present on the newest answer only. */
  lastMessage: 'lastChatMessage',
  /** Message-level copy button (aria-label "Copy Response"). */
  copyResponse: 'CopyButtonTestId',
  /** Composer add-sources ("+") button. Opens the menu; not needed for uploads. */
  plusMenu: 'PlusMenuButton',
} as const;

/**
 * File upload.
 *
 * The page keeps a hidden, always-present multi-file input in the DOM. Playwright can
 * call `setInputFiles` on it directly, so the bot never opens the "+" menu and never
 * touches a native Windows file dialog.
 *
 * Its `accept` list includes `.txt` and `text/plain`, which is what the runner reports use.
 * Also accepted, should we ever need them: .log, .json, .csv, .md, .xml, .yml. .ps1 is NOT
 * in the list. Uploads are the runner's own reports; nothing is ever downloaded.
 */
export const Upload = {
  /** Hidden `<input type="file" multiple>`. */
  input: '#upload-file-button',
  /** Extensions the input accepts that are useful to us. */
  safeReportExtension: '.txt',
  /** Container of the pending attachments in the composer. */
  list: 'div.fx-AttachmentList',
  /** One pending attachment. Its `aria-label` is the file name. */
  chip: 'div.fx-Attachment',
  /** `aria-label` of the chip's remove button, with the file name appended. */
  removeLabelPrefix: 'Remove attachment ',
  /**
   * Wait for this before clicking Send: the chip's DOM id starts with `SPO_` only once
   * the file has finished uploading to SharePoint/OneDrive.
   */
  uploadedIdPrefix: 'SPO_',
} as const;

/**
 * Accessible names used with getByRole / getByLabel.
 * The UI is English-only in this tenant; if a localized tenant is targeted these
 * must be moved into a locale map.
 */
export const Label = {
  /** The composer. It is a contenteditable SPAN, not a textarea. */
  composer: 'Message Copilot',
  send: 'Send',
  /** Visible only while the answer is streaming. Its absence = generation finished. */
  stopGenerating: 'Stop generating',
  copyResponse: 'Copy Response',
  /** Copy button inside a code block; yields the full code, ignoring virtualization. */
  copyCode: 'Copy code',
  /** Expands a long code block. */
  showMoreLines: 'Show more lines',
  newChat: 'New chat',
  modelSelector: 'Model Selector',
} as const;

/**
 * The model picker.
 *
 * The button was captured live: `button#gptModeSwitcher[aria-label="Model Selector"]`, showing
 * `Auto`. What its popup contains was **not** captured, and it is the one thing here that
 * Microsoft changes without warning: models come and go, and a tenant sees a different list
 * from the next tenant. So nothing in this project hard-codes a list of models. The names are
 * read from the open popup at the moment the user asks for them, and what is offered in the UI
 * is whatever the chat itself offered.
 *
 * Because the popup's markup is unknown, the reader is deliberately role-based and tries
 * several shapes rather than one selector. Anything matched inside the popup counts; the
 * button's own text is the current selection.
 */
/*
 * A row that chooses a model, and a row that opens a group, as XPath predicates. The models were `menuitemradio`
 * and the groups `menuitem` until the work page of 2026-10-23 (the operator's models-select-failed.json/.html):
 * there every row is a `menuitem`, a model told from a group only by opening nothing, and every locator written
 * for `menuitemradio` found no model at all — each run asked the operator to choose it by hand. Both shapes count.
 */
const OPENS_SUBMENU = '@aria-haspopup="menu" or @aria-haspopup="true" or @aria-expanded';
const MODEL_ROW = `(@role="menuitemradio" or @role="menuitemcheckbox" or @role="menuitem" or @role="option") and not(${OPENS_SUBMENU})`;
const GROUP_ROW = `@role="menuitem" and (${OPENS_SUBMENU})`;
const modelByText = (text: string): string => `//div[contains(text(), ${xpathText(text)})]/ancestor-or-self::div[${MODEL_ROW}]`;
const groupByText = (text: string): string => `//div[contains(text(), ${xpathText(text)})]/ancestor-or-self::div[${GROUP_ROW}]`;

export const Model = {
  /** The picker button. The id has been stable; the aria-label is the fallback. */
  button: 'button#gptModeSwitcher',
  buttonLabel: 'Model Selector',
  /** Containers a Fluent popup can use. The first visible one after the click wins. */
  popupSelectors: ['[role="menu"]', '[role="listbox"]', '[role="dialog"]', '[role="group"]'],
  /**
   * Roles an option can carry. All of them are read, not just the first that matches:
   * the menu mixes `menuitemradio` for the choices with plain `menuitem` for the groups
   * that open a submenu, so stopping at the first role hides every grouped model.
   */
  optionRoles: ['menuitemradio', 'menuitemcheckbox', 'option', 'radio', 'menuitem'] as const,
  /** Attributes that mark the option currently in force. */
  selectedAttributes: ['aria-checked', 'aria-selected', 'aria-pressed'],
  /**
   * A row that opens a submenu instead of choosing anything. Seen live as `GPT / OpenAI`
   * with a chevron, holding `GPT 5.6 Think deeper` and `GPT 5.6 Quick response`. A tenant
   * with other vendors enabled gets one such group per vendor, which is where the models
   * this project is asked to pick actually live.
   */
  submenuAttributes: ['aria-haspopup', 'aria-expanded'],
  /** A row that chooses a model, as CSS, for the code that runs in the page: either shape (see `MODEL_ROW`). */
  modelRowCss: ':is([role="menuitemradio"],[role="menuitemcheckbox"],[role="menuitem"],[role="option"]):not([aria-haspopup="menu"],[aria-haspopup="true"],[aria-expanded])',
  /**
   * The operator's locators (2026-10-05), with the text taken from the list read in Settings: a model
   * (in a group's submenu or not) and a group row that opens a submenu ("Claude", "GPT"). The menu is
   * too dynamic for anything else that was tried; change these when the page changes.
   */
  modelRowXPath: modelByText,
  groupRowXPath: groupByText,
  /**
   * The same rows by all their text, for a name the page splits over two elements ("Advanced reasoning"
   * and "(Experimental)"), which `text()` sees only the first part of. Asked together with the ones above.
   */
  modelRowByAllText: (text: string): string => `//div[${MODEL_ROW}][contains(normalize-space(.), ${xpathText(text)})]`,
  groupRowByAllText: (text: string): string => `//div[${GROUP_ROW}][contains(normalize-space(.), ${xpathText(text)})]`,
} as const;

/**
 * The model menu's locators, as the operator writes them (2026-10-24: "a mechanism to update the locators, at least
 * their general forms — an option in Settings to edit them"). Three are templates, written for one name with
 * `{$model_name}` or `{$provider_name}` where the name goes, and filled with the names the list read from the page:
 * a model of the main menu (Auto, Think deeper…), a provider's row that opens its own menu (Claude, GPT…), and a model
 * in a provider's menu (Opus 5.5…). Two are elements: the picker button, and the rows of the open menu, which the
 * names are read from. No model and no provider is named here: whatever the page offers is found the same way.
 *
 * A locator is an XPath when it starts with `/`, `(` or `./`, else a CSS selector. Edited in Settings → "The model
 * menu's locators"; an empty one is the default below. The ones written for `menuitemradio` before 2026-10-05 and
 * their fixed list of models (Claude: Sonnet, Opus; GPT: two GPT-5.6) are gone with this.
 */
export const MODEL_NAME = '{$model_name}';
export const PROVIDER_NAME = '{$provider_name}';
export const PICKER_LOCATOR_KEYS = ['button', 'rows', 'model', 'provider', 'providerModel'] as const;
export type PickerLocatorKey = (typeof PICKER_LOCATOR_KEYS)[number];
export type PickerLocators = Record<PickerLocatorKey, string>;

export const DefaultPickerLocators: PickerLocators = {
  button: 'button#gptModeSwitcher',
  rows: '[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[role="radio"],[role="menuitem"]',
  // The operator's three, each found once ("1 of 1") on the work page of 2026-10-24.
  model: `//div[text()='${MODEL_NAME}']/parent::span/parent::span/parent::div`,
  provider: `//div[text()='${PROVIDER_NAME}']/parent::span/parent::span/parent::div[contains(@aria-haspopup, 'menu')]`,
  providerModel: `//div[text()='${MODEL_NAME}']/parent::span/parent::span/parent::div[not(contains(@aria-haspopup, 'menu'))]`,
};

/** The placeholder a template must hold; the two elements hold none. */
export const PickerPlaceholder: Record<PickerLocatorKey, string | null> = {
  button: null,
  rows: null,
  model: MODEL_NAME,
  provider: PROVIDER_NAME,
  providerModel: MODEL_NAME,
};

/** Whether a locator is an XPath: it starts as one does. */
export function isXPath(locator: string): boolean {
  return /^\s*(\/|\(|\.\.?\/)/.test(locator);
}

/** A locator as Playwright takes it: `xpath=` or `css=` in front, unless it names its engine already. */
export function playwrightSelector(locator: string): string {
  const s = locator.trim();
  // An engine named by its prefix — css=, xpath=, or Playwright's own: role=button[name="Send"], text=…, id=… — as it is.
  if (/^[a-z][a-z:-]*=/.test(s)) return s;
  return isXPath(s) ? `xpath=${s}` : `css=${s}`;
}

/** The locator, as it is to be asked in the page itself: which kind, and the text without an engine's name. */
export function pageQuery(locator: string): { xpath: boolean; text: string } {
  const s = locator.trim();
  if (s.startsWith('xpath=')) return { xpath: true, text: s.slice(6) };
  if (s.startsWith('css=')) return { xpath: false, text: s.slice(4) };
  return { xpath: isXPath(s), text: s };
}

/**
 * The chat page's own locators, as the operator writes them (2026-11-17). First the box to write in ("a field in
 * Settings to set it by hand", after the work page's box changed); the same day, every one the bot finds the chat by
 * ("a way to change each of the locators by hand, so I don't have to come back here every time"). Settings, "The
 * chat's locators", in three groups: writing and sending, the answer, the conversations in the sidebar. The model
 * menu's have their own section (`PickerLocators`).
 *
 * A locator is a CSS selector, an XPath (starting with `/` or `(`), or one of Playwright's own forms named by its prefix
 * (`role=button[name="Send"]`, `text=…`), chained with `>>`. An empty one is the default below, which is what the bot
 * looked for before they were editable. When one finds nothing where the bot needs it, the bot says which, keeps the
 * page's HTML for a chatbot to read the right one from, and Settings shows the field in red (see `LocatorMissing`).
 *
 * The box: until 2026-11 a span with the id `m365-chat-editor-target-element`; on 2026-11-17 the work page's is
 * `<span role="textbox" contenteditable="true" aria-label="Message Copilot" data-lexical-editor="true">`, with no id,
 * inside the same wrapper as before (`data-test-id="chat-input-wrapper"`). The default finds either; a locator that
 * finds an element around the box is taken for the box inside it (see `composer()`).
 */
export const CHAT_LOCATOR_KEYS = [
  'composer',
  'send',
  'userMessage',
  'turn',
  'answer',
  'copy',
  'stop',
  'conversationLink',
  'chatMore',
  'renameItem',
  'renameInput',
  'renameSave',
  'uploadInput',
  'attachment',
  'attachmentUploaded',
] as const;
export type ChatLocatorKey = (typeof CHAT_LOCATOR_KEYS)[number];
export type ChatLocators = Record<ChatLocatorKey, string>;

/** Where a conversation's id goes in a template (the sidebar's "More" button of one conversation). */
export const CHAT_ID = '{$chat_id}';
/** Where an attached file's name goes (`message-01-in-full.txt`), and its name without the extension (`message-01-in-full`). */
export const FILE_NAME = '{$file_name}';
export const FILE_STEM = '{$file_stem}';

export const DefaultChatLocators: ChatLocators = {
  composer: '#m365-chat-editor-target-element, [data-test-id="chat-input-wrapper"] [role="textbox"][contenteditable="true"]',
  send: '[data-test-id="chat-input-wrapper"] >> role=button[name="Send"]',
  userMessage: '[id^="user-message-"]',
  turn: '[data-testid="m365-chat-llm-web-ui-chat-message"]',
  answer: '[data-testid="copilot-message-div"]',
  copy: '[data-testid="CopyButtonTestId"]',
  stop: 'button[aria-label="Stop generating"]',
  conversationLink: 'a[href*="/chat/conversation/"]',
  chatMore: `button[data-chat-history-more-button-conversation-id="${CHAT_ID}"]`,
  renameItem: 'role=menuitem[name="Rename"]',
  renameInput: '#new-session-name',
  renameSave: 'role=button[name="Save"]',
  uploadInput: '#upload-file-button',
  /*
   * The attached file in the box, before Send (2026-11-17: the work page shows it as a card with the name without
   * its extension and "Text file", no longer `div.fx-Attachment[aria-label=<name>]`). Either: the old one by its
   * label, or, in the box's wrapper, the element whose text is exactly the file's name, with or without the extension.
   */
  attachment:
    `div.fx-Attachment[aria-label="${FILE_NAME}"], [data-test-id="chat-input-wrapper"] :text-is("${FILE_STEM}"), ` +
    `[data-test-id="chat-input-wrapper"] :text-is("${FILE_NAME}")`,
  /*
   * The same, once it is uploaded: the old one's id starts with SPO_ then; on the new page, nothing in the box's wrapper
   * shows progress any more (a spinner, a progress bar: role=progressbar).
   */
  attachmentUploaded:
    `div.fx-Attachment[aria-label="${FILE_NAME}"][id^="SPO_"], ` +
    `[data-test-id="chat-input-wrapper"]:not(:has(div.fx-Attachment)):not(:has([role="progressbar"])) :text-is("${FILE_STEM}"), ` +
    `[data-test-id="chat-input-wrapper"]:not(:has(div.fx-Attachment)):not(:has([role="progressbar"])) :text-is("${FILE_NAME}")`,
};

/** The groups Settings shows them in, in this order. */
export type ChatLocatorGroup = 'write' | 'attach' | 'answer' | 'conversations';
export const ChatLocatorGroupOf: Record<ChatLocatorKey, ChatLocatorGroup> = {
  composer: 'write',
  send: 'write',
  userMessage: 'write',
  turn: 'answer',
  answer: 'answer',
  copy: 'answer',
  stop: 'answer',
  conversationLink: 'conversations',
  chatMore: 'conversations',
  renameItem: 'conversations',
  renameInput: 'conversations',
  renameSave: 'conversations',
  uploadInput: 'attach',
  attachment: 'attach',
  attachmentUploaded: 'attach',
};

/**
 * What each one is, in words a chatbot that reads the page's HTML can find it by (the text it is handed with the HTML,
 * see `locatorPrompt`), and the failure says.
 */
export const ChatLocatorWhat: Record<ChatLocatorKey, string> = {
  composer: 'the box at the bottom of the chat where a message is typed (an editable element: contenteditable or a textarea)',
  send: "the button that sends the typed message, beside the box where it is typed (not the feedback panel's Send)",
  userMessage: 'the message the user sent, as the conversation shows it (each one; the bot reads the newest)',
  turn: "each message of the conversation, the user's and Copilot's (the elements that carry aria-setsize when the conversation is long)",
  answer: "each of Copilot's answers, as a whole: the element that holds the answer's text and its toolbar (copy, like, dislike)",
  copy: "the Copy button in the toolbar of Copilot's answer (it copies the whole answer)",
  stop: 'the button shown while Copilot is still writing its answer, which stops it ("Stop generating")',
  conversationLink: 'the link to a conversation in the sidebar of conversations (its address holds /chat/conversation/<id> or the like)',
  chatMore: `the "More" button of one conversation in the sidebar, the one that opens its menu (Rename, Delete…); ${CHAT_ID} is where the conversation's id goes`,
  renameItem: 'the "Rename" item of the menu a conversation\'s "More" button opens in the sidebar',
  renameInput: 'the text field of the dialog that renames a conversation',
  renameSave: 'the "Save" button of the dialog that renames a conversation',
  uploadInput: 'the hidden file input (input type="file") of the box where a message is typed, through which files are attached to the message',
  attachment: `the file attached to the message, as the box shows it before Send (a card with the file's name); ${FILE_NAME} is where the file's name goes (message-01-in-full.txt), ${FILE_STEM} the name without its extension (message-01-in-full)`,
  attachmentUploaded: `the same attached file once it has finished uploading (no spinner or progress on it any more); ${FILE_NAME} is where the file's name goes, ${FILE_STEM} the name without its extension`,
};

/**
 * Places on the page an element that is not found is most likely near, when none of the chat's own locators finds
 * something beside it (operator, 2026-11-18: "the piece of code where the new locator probably is").
 */
export const NearPlaces = {
  wrapper: { selector: '[data-test-id="chat-input-wrapper"], [data-testid="chat-input-wrapper"]', what: 'the area around the box where a message is typed' },
  dialog: { selector: '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]', what: 'the dialog open on the page' },
  menu: { selector: '[role="menu"], [role="listbox"]', what: 'the menu open on the page' },
  main: { selector: 'main, [role="main"]', what: 'the main part of the page, where the conversation is' },
  sidebar: { selector: 'nav, [role="navigation"], aside', what: 'the sidebar with the list of conversations' },
} as const;
export type NearPlace = keyof typeof NearPlaces;

/**
 * Where to look for each element that was not found, nearest first: another of the chat's locators that finds
 * something beside it (the box for its Send, the rename dialog's field for its Save), or a place (`NearPlaces`). The
 * first that finds something gives the piece of the page handed to a chatbot.
 */
export const ChatLocatorNear: Record<ChatLocatorKey, Array<ChatLocatorKey | NearPlace>> = {
  composer: ['wrapper', 'send', 'uploadInput', 'main'],
  send: ['composer', 'wrapper', 'uploadInput'],
  userMessage: ['turn', 'answer', 'main'],
  turn: ['userMessage', 'answer', 'main'],
  answer: ['turn', 'copy', 'userMessage', 'main'],
  copy: ['answer', 'turn', 'main'],
  stop: ['composer', 'send', 'wrapper', 'answer'],
  conversationLink: ['sidebar'],
  chatMore: ['conversationLink', 'sidebar'],
  renameItem: ['menu', 'chatMore', 'sidebar'],
  renameInput: ['dialog', 'renameSave', 'sidebar'],
  renameSave: ['renameInput', 'dialog'],
  uploadInput: ['composer', 'wrapper', 'send'],
  attachment: ['composer', 'wrapper', 'uploadInput'],
  attachmentUploaded: ['attachment', 'composer', 'wrapper'],
};
/** For one of the operator's own steps, whose element can be anywhere: a dialog first (most are), then the box's area. */
export const StepNear: Array<ChatLocatorKey | NearPlace> = ['dialog', 'wrapper', 'composer', 'main'];

/** When each one is on the screen, for a person to bring it there and find it by hand in the browser's developer tools. */
export const ChatLocatorShows: Record<ChatLocatorKey, string> = {
  composer: 'open Copilot\'s chat: the box is at the bottom of the page',
  send: 'type a word in the box at the bottom of the chat: the Send button is beside it (do not send it)',
  userMessage: 'open a conversation that has messages: each message the user sent is shown in it',
  turn: 'open a conversation that has messages',
  answer: 'open a conversation in which Copilot has answered',
  copy: 'open a conversation in which Copilot has answered, and point the mouse at an answer: the Copy button is in the row of small buttons under it',
  stop: 'send Copilot a question that takes a long answer, and while it is still writing, the Stop button shows (near the box at the bottom)',
  conversationLink: 'open the sidebar with the list of conversations (the button at the top left, if it is closed)',
  chatMore: 'in the sidebar, point the mouse at a conversation: its "More" button (three dots) shows on its row',
  renameItem: 'in the sidebar, click a conversation\'s "More" button (three dots): the menu with "Rename" opens',
  renameInput: 'in the sidebar, click a conversation\'s "More" button (three dots), then "Rename": the dialog with the field opens',
  renameSave: 'in the sidebar, click a conversation\'s "More" button (three dots), then "Rename": the dialog opens; its button that saves the name is the one wanted (do not click it)',
  uploadInput: 'it is never on the screen: it is the hidden <input type="file"> near the box at the bottom, found in Elements with Ctrl+F and input[type="file"]',
  attachment: 'attach a file to the message with the box\'s attach button (a paper clip or a "+"): its card shows in the box',
  attachmentUploaded: 'attach a file to the message with the box\'s attach button (a paper clip or a "+") and wait until it has finished uploading (no spinner or progress on its card): the card as it is then is wanted',
};

/** The placeholder a template must hold; the others hold none. An attached file's: its name, or its name without the extension. */
export const ChatPlaceholder: Partial<Record<ChatLocatorKey, string>> = { chatMore: CHAT_ID, attachment: FILE_NAME, attachmentUploaded: FILE_NAME };
/** Whether a template holds its placeholder (for a file's, either of the two). */
export function holdsChatPlaceholder(key: ChatLocatorKey, locator: string): boolean {
  const needs = ChatPlaceholder[key];
  if (!needs) return true;
  return locator.includes(needs) || (needs === FILE_NAME && locator.includes(FILE_STEM));
}

/** A file template with the file's name put in, safe inside the quotes it stands in. */
export function fillFileLocator(template: string, file: string): string {
  const name = file.split(/[\\/]/).pop() ?? file;
  const stem = name.replace(/\.[^.]*$/, '');
  const quoted = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return template.split(FILE_NAME).join(quoted(name)).split(FILE_STEM).join(quoted(stem));
}

/** The chat's locators in force: each one saved in Settings, else the default; one that cannot be used is said in `problems`. */
export function resolveChatLocators(saved?: Partial<Record<ChatLocatorKey, string>> | null): { locators: ChatLocators; problems: string[] } {
  const locators = { ...DefaultChatLocators };
  const problems: string[] = [];
  for (const key of CHAT_LOCATOR_KEYS) {
    const own = (saved?.[key] ?? '').trim();
    if (!own) continue;
    const needs = ChatPlaceholder[key];
    const problem = needs && !holdsChatPlaceholder(key, own)
      ? needs === FILE_NAME
        ? `it has no ${FILE_NAME} (or ${FILE_STEM}): put it where the file's name goes`
        : `it has no ${needs}: put it where the conversation's id goes`
      : locatorSyntaxProblem(own);
    if (problem) problems.push(`the chat's ${key} locator in Settings is not used, ${problem}`);
    else locators[key] = own;
  }
  return { locators, problems };
}

/**
 * The text a chatbot is handed with the page's HTML to find a locator in (operator, 2026-11-17: "the goal is to give
 * the HTML to a chatbot and have it say which locator it is and what its selector is"). In English: the chatbot reads
 * it, not the operator, and Copilot's page is in English on the work machine.
 */
export function locatorPrompt(key: ChatLocatorKey, failed: string): string {
  return [
    'The attached file is the HTML of the Microsoft 365 Copilot chat page in a browser (scripts, styles and the list of conversations taken out).',
    `Find this element in it: ${ChatLocatorWhat[key]}.`,
    `This locator used to find it and now finds nothing: ${failed}`,
    'Give me one locator that finds exactly this element, and only it: a CSS selector, or an XPath if CSS cannot say it.',
    'Use what stays the same between versions of the page: id, role, aria-label, data-testid, data-test-id and other data-* attributes, the tag.',
    'Do not use class names made of random letters (like azFuQXgw or ___1x5usfw): they change with every new version of the page.',
    ...(ChatPlaceholder[key] === CHAT_ID ? [`Keep ${CHAT_ID} in it where the conversation's id goes.`] : []),
    ...(ChatPlaceholder[key] === FILE_NAME
      ? [`Keep ${FILE_NAME} in it where the file's name goes (message-01-in-full.txt), or ${FILE_STEM} for the name without its extension (message-01-in-full): the attached file in the HTML is message-01-in-full.txt.`]
      : []),
    'Answer with the locator on the first line, then one line on why it is that element.',
  ].join('\n');
}

/** An XPath axis written with one colon (`parent:span`), which is not XPath; null when there is none. */
export function locatorSyntaxProblem(locator: string): string | null {
  const axis = /(^|[/[(|\s])(ancestor-or-self|ancestor|attribute|child|descendant-or-self|descendant|following-sibling|following|parent|preceding-sibling|preceding|self):(?!:)/.exec(locator);
  return axis && isXPath(locator) ? `"${axis[2]}:" needs two colons: ${axis[2]}::` : null;
}

/**
 * What is wrong with a locator written for `key`, said for the operator, or null. A template without its placeholder
 * would find the same element for every name; an axis written with one colon (`parent:span`) is not XPath. Whether
 * an XPath parses at all is checked where there is a parser for it: the Settings page tries it in the browser.
 */
export function pickerLocatorProblem(key: PickerLocatorKey, locator: string): string | null {
  const s = locator.trim();
  if (s === '') return null;
  const needs = PickerPlaceholder[key];
  if (needs && !s.includes(needs)) return `it has no ${needs}: put it where the name goes`;
  const axis = /(^|[/[(|\s])(ancestor-or-self|ancestor|attribute|child|descendant-or-self|descendant|following-sibling|following|parent|preceding-sibling|preceding|self):(?!:)/.exec(s);
  if (axis && isXPath(s)) return `"${axis[2]}:" needs two colons: ${axis[2]}::`;
  return null;
}

/**
 * The locators in force: each one saved in Settings, else the default. One that cannot be used (see
 * `pickerLocatorProblem`) is not used, and said in `problems`, so the default works and the run says why.
 */
export function resolvePickerLocators(saved?: Partial<Record<PickerLocatorKey, string>> | null): { locators: PickerLocators; problems: string[] } {
  const locators = { ...DefaultPickerLocators };
  const problems: string[] = [];
  for (const key of PICKER_LOCATOR_KEYS) {
    const own = (saved?.[key] ?? '').trim();
    if (!own) continue;
    const problem = pickerLocatorProblem(key, own);
    if (problem) problems.push(`the ${key} locator in Settings is not used, ${problem}`);
    else locators[key] = own;
  }
  return { locators, problems };
}

/**
 * A template with the names put in. A name holding a quote of the kind its placeholder is quoted with is put as an
 * XPath literal of its own (`concat(…)` when it holds both), so a name never breaks the locator open.
 */
export function fillLocator(template: string, names: { model?: string; provider?: string }): string {
  let out = template;
  const fill = (placeholder: string, name: string | undefined) => {
    if (name === undefined) return;
    out = out
      .split(`'${placeholder}'`).join(name.includes("'") ? xpathText(name) : `'${name}'`)
      .split(`"${placeholder}"`).join(name.includes('"') ? xpathText(name) : `"${name}"`)
      .split(placeholder).join(name);
  };
  fill(MODEL_NAME, names.model);
  fill(PROVIDER_NAME, names.provider);
  return out;
}

/**
 * How patiently a model is chosen with those locators (operator's request, 2026-10-06): every element is
 * waited for until it is there and visible (`appearMs`), a fixed pause follows every opening and every
 * press (`settleMs`), and a choice the picker does not show as made is tried again from the start, up to
 * `attempts` times, before the run is told it failed.
 */
export const ModelPicking = {
  attempts: 6,
  /**
   * The operator's rhythm (2026-10-06): an element of the picker is looked for; while it is not there the
   * runner waits `pollMs` and looks again, up to `appearMs`; once it is there it waits `beforePressMs`
   * more, then presses it.
   */
  pollMs: 2_000,
  beforePressMs: 2_000,
  settleMs: 1_500,
  appearMs: 20_000,
} as const;

/** A text as an XPath string literal, whatever quotes it holds. */
export function xpathText(text: string): string {
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"')) return `"${text}"`;
  return `concat('${text.split("'").join(`', "'", '`)}')`;
}

/** CSS selectors for things that have neither a test id nor an accessible name. */
export const Css = {
  /** The composer element: the default of the chat's locator (`DefaultChatLocators`); a run takes Settings' own. */
  composer: DefaultChatLocators.composer,
  /**
   * The composer's own wrapper, and the reason every Send lookup goes through it.
   *
   * "The button called Send" is not unique on this page. The Office feedback panel
   * (`data-testid="obf-…"`) has one too, and when it opens over the chat a page-wide lookup
   * matches two elements and Playwright refuses to guess — which is a run ending on a strict
   * mode violation because Microsoft asked the operator what they thought of Copilot.
   *
   * Note the spelling: this one is `data-test-id`, with hyphens, unlike the `data-testid`
   * values above. Both spellings exist in this UI.
   */
  composerWrapper: '[data-test-id="chat-input-wrapper"]',
  /**
   * The shape of the real Send button, used when the wrapper cannot be found.
   *
   * The composer's Send is its form's submit control; the feedback panel's is an ordinary
   * button. So this tells them apart without knowing either one's container.
   */
  composerSendSubmit: 'button[type="submit"][aria-label="Send"]',
  /**
   * Anything belonging to the Office feedback panel. Never clicked, only detected: its
   * buttons submit an opinion on the operator's own account, and this program has none.
   */
  feedbackPanel: '[data-testid^="obf-"]',
  /**
   * A rendered code block. Beware: it carries `scriptor-codeblock-virtualized`
   * and renders line numbers as separate text nodes, so `innerText` is
   * "PowerShell\n1\nline one\n2\nline two". Never parse it directly - use the
   * "Copy code" button or the message-level "Copy Response" button instead.
   */
  codeBlock: '.scriptor-component-code-block',
  codeBlockVirtualized: '.scriptor-codeblock-virtualized',
  /**
   * A file Copilot generated for download. It is a plain anchor with a blob href,
   * a `download` attribute and `target="_blank"`, which is why nothing useful shows
   * on hover. `aria-label` and `download` both carry the file name.
   *
   * Read only to name what was ignored: the runner never clicks it, and the browser is
   * opened with downloads refused.
   */
  downloadLink: 'a[download]',
  downloadLinkBlob: 'a[href^="blob:"]',
} as const;

/** Signals the transport uses to decide what state the page is in. */
export const Signal = {
  /** Sign-in redirect target. */
  loginHost: 'login.microsoftonline.com',
  /** Generation is running while a button with this label exists anywhere. */
  streamingButtonLabel: Label.stopGenerating,
  /**
   * Generation has finished when the newest answer exposes its copy button.
   *
   * Two traps here, both found by checking against the live DOM rather than assuming:
   *
   * 1. `[data-testid="loading-message"]` is NOT a busy flag. It stays in the DOM after
   *    streaming ends.
   * 2. The copy button is **not** inside `lastChatMessage`. `lastChatMessage` is the answer
   *    body (its DOM id is `response-id_...`); the copy button lives in a toolbar that is a
   *    sibling of it. Both sit inside `copilot-message-div`, which is therefore the anchor
   *    for anything that has to see the whole answer.
   *
   * There is no CSS for "the last element with this test id" across separate containers, so
   * the check is done in JS: take the last `copilot-message-div` and look inside it.
   */
  answerWrapper: `[data-testid="${TestId.assistantMessage}"]`,
  copyButtonInAnswer: `[data-testid="${TestId.copyResponse}"]`,
} as const;

/**
 * Things that stop the chat from working and that only a human can clear.
 *
 * The bot **detects** these and waits. It never clicks the verification checkbox and never
 * tries to get past a challenge: that is the human's job, by design and on purpose. The
 * value here is that the run pauses with a clear message instead of timing out with a
 * confusing one.
 */
export const Blocker = {
  /** Text seen on the human-verification dialog. */
  verificationText: ['Verification required', 'Verify you are human'],
  /** Transient failure banner; a reload usually clears it. */
  errorBannerText: ["Your request couldn't be completed", 'Refresh to try again'],
  refreshLabel: 'Refresh',
  /** Challenge widgets are iframed from these hosts. */
  challengeFrameHosts: ['challenges.cloudflare.com', 'hcaptcha.com', 'recaptcha.net', 'google.com/recaptcha'],
} as const;

/**
 * Telling the work Copilot apart from the consumer one.
 *
 * `m365.cloud.microsoft` redirects to the consumer Copilot when the profile is not signed in
 * with a work or school account. Both surfaces have a message box, so "a textbox is visible"
 * is not proof of being in the right place. The consumer surface also runs bot protection,
 * which the work surface does not, so landing there looks exactly like being detected as a
 * bot when it is really a sign-in problem.
 */
export const Surface = {
  /**
   * The work Copilot's hosts. `copilot.cloud.microsoft` since Microsoft began moving the chat there: on
   * 2026-10-13 the work machine's `m365.cloud.microsoft/chat` landed on
   * `copilot.cloud.microsoft/chat?es=SSR&redirfrom=mcmToCcm`, the same chat with the same composer, and
   * the sign-in was refused as "not the Microsoft 365 Copilot chat" because only the old host was known.
   */
  workHosts: ['m365.cloud.microsoft', 'copilot.cloud.microsoft'],
  /** Only the work surface has this composer (the chat's locator in force decides; this is its default). */
  workMarkers: [DefaultChatLocators.composer],
  consumerHosts: ['copilot.microsoft.com', 'www.bing.com', 'bing.com'],
  /** Chips that only the consumer surface shows. */
  consumerMarkers: ['Shop', 'Play'],
} as const;

/**
 * Chat URL. Microsoft is consolidating this to copilot.cloud.microsoft.
 *
 * The bot starts on `origin`; from then on a window goes to the chat's addresses on the host it found the chat on
 * (`chatOrigin` in copilotTransport.ts), not through the old host's redirect: on 2026-11-17 the work machine's
 * `m365.cloud.microsoft/chat` ended on `copilot.cloud.microsoft/home?es=SSR&redirfrom=mcmToCcm`, Copilot's home page,
 * with no box to write in.
 */
export const Url = {
  chat: 'https://m365.cloud.microsoft/chat',
  origin: 'https://m365.cloud.microsoft',
  /** A new chat, on whichever host. "New chat" is an anchor, so a plain navigation is equivalent to clicking it. */
  newChatPath: '/chat?es=SSR',
  newChat: 'https://m365.cloud.microsoft/chat?es=SSR',
  /** Every conversation has a stable address: /chat/conversation/<uuid>, on whichever host. */
  conversationPath: (id: string) => `/chat/conversation/${id}?es=SSR`,
  conversation: (id: string, origin = 'https://m365.cloud.microsoft') => `${origin}/chat/conversation/${id}?es=SSR`,
  /** Full chat list, used as the last resort when looking a chat up by name. */
  allChats: 'https://m365.cloud.microsoft/chat/all?es=SSR',
} as const;

/**
 * Naming a chat, so the bot can find its own conversation again after a re-login.
 *
 * Path: the sidebar entry's "More" menu -> "Rename" -> a dialog with a text input and a
 * Save button. Enter does **not** submit the dialog; Save must be clicked.
 *
 * The name is capped at 50 characters by the UI, which shows the inline error
 * "Your Copilot chat name can't be longer than 50 characters".
 */
export const Rename = {
  /** Per-chat overflow button in the sidebar. There is one per chat, so scope it to the row. */
  moreButtonLabel: 'More',
  /** The same button by the chat it belongs to (seen live 2026-10-05): found without going through the row. */
  moreButtonForChat: (chatId: string): string => `button[data-chat-history-more-button-conversation-id="${chatId}"]`,
  menuItem: 'Rename',
  /** The dialog's text input. */
  input: '#new-session-name',
  inputLabel: 'Chat name',
  /** The dialog's confirm button. Text, not an aria-label. */
  saveText: 'Save',
  cancelText: 'Cancel',
  maxLength: 50,
} as const;

/**
 * Sidebar chat rows. `aria-label` carries the chat's current name, `href` carries its id,
 * so a row identifies a conversation both ways.
 *
 * `document.title` is NOT reliable here: after a rename it still showed the old title.
 */
export const Sidebar = {
  conversationLink: 'a[href*="/chat/conversation/"]',
} as const;
