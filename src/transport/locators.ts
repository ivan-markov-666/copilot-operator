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
 * Also accepted, should we ever need them: .log, .json, .csv, .md, .xml, .yml, .ps1 is NOT
 * in the list, so downloaded scripts cannot be re-uploaded as-is - rename to .txt or .log.
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

/** CSS selectors for things that have neither a test id nor an accessible name. */
export const Css = {
  /** The composer element. Its DOM id has been stable so far. */
  composer: '#m365-chat-editor-target-element',
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
   * Generation has finished when the last message exposes its copy button.
   * `[data-testid="loading-message"]` is NOT a reliable indicator: it stays in the
   * DOM after streaming ends.
   */
  finishedMarker: `[data-testid="${TestId.lastMessage}"] [data-testid="${TestId.copyResponse}"]`,
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
