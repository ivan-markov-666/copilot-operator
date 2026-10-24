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
  if (/^(xpath|css)=/.test(s)) return s;
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
  /** The composer element. Its DOM id has been stable so far. */
  composer: '#m365-chat-editor-target-element',
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
  /** Only the work surface has this composer id and these test ids. */
  workMarkers: ['#m365-chat-editor-target-element'],
  consumerHosts: ['copilot.microsoft.com', 'www.bing.com', 'bing.com'],
  /** Chips that only the consumer surface shows. */
  consumerMarkers: ['Shop', 'Play'],
} as const;

/** Chat URL. Microsoft is consolidating this to copilot.cloud.microsoft. */
export const Url = {
  chat: 'https://m365.cloud.microsoft/chat',
  /** "New chat" is an anchor, so a plain navigation is equivalent to clicking it. */
  newChat: 'https://m365.cloud.microsoft/chat?es=SSR',
  /** Every conversation has a stable address: /chat/conversation/<uuid>. */
  conversation: (id: string) => `https://m365.cloud.microsoft/chat/conversation/${id}?es=SSR`,
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
