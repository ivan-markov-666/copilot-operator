/**
 * One file for a chatbot, with everything it needs to give the right locator (operator, 2026-11-18: "too many things
 * for the user to do. Can't you keep everything needed in one file? The user just takes the file: in it, the
 * instructions what to do, what the goal is, what failed, the old locator and the piece of code where the new locator
 * most likely is. And a way for the chatbot to help the user find the right locator when it is missing from the code
 * block, in the extreme case"). The operator downloads it from the failure's notice, attaches it to Copilot or any other
 * chatbot, and sends it with no words of their own; the chatbot answers with the locator for the field in red.
 *
 * In English, which every chatbot reads, and Copilot's page is in English at work; the chatbot is told to speak to the
 * operator in the language of the bot's interface.
 */
import type { LocatorFailure } from './locatorFailures.js';
import { CHAT_ID, ChatLocatorShows, ChatLocatorWhat, ChatPlaceholder, FILE_NAME, FILE_STEM, type ChatLocatorKey } from '../transport/locators.js';
import type { ChatStep } from '../transport/chatSteps.js';

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  bg: 'Bulgarian',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  ar: 'Arabic',
};

/** The language the chatbot speaks to the operator in: the interface's, English when it is not one of its. */
export function languageName(code: string | undefined): string {
  return LANGUAGE_NAMES[(code ?? '').toLowerCase()] ?? 'English';
}

/** The whole page is cut at this length: what is past it is rarely read by a chatbot, and the file stays small to attach. */
export const PAGE_CAP = 600_000;

/** A fence longer than any run of backticks in the text, so the HTML never closes its own code block. */
function fenced(text: string, lang: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

export type ChatbotFileInput = {
  failure: LocatorFailure;
  /** For one of the operator's own steps: the step as it is in Settings now, if it still is. */
  step?: Pick<ChatStep, 'name' | 'action' | 'key' | 'when'> | undefined;
  /** The piece of the page around where the element most likely is, and the whole page; empty when not kept. */
  piece: string;
  page: string;
  /** The interface's language code. */
  lang?: string;
};

/** What the element is, said for the chatbot. */
function elementOf(failure: LocatorFailure, step: ChatbotFileInput['step']): string {
  if (!failure.key.startsWith('step:')) return ChatLocatorWhat[failure.key as ChatLocatorKey];
  const action = step?.action ?? 'click';
  const what =
    action === 'click' ? 'the element the program clicks at this point'
    : action === 'press' ? `the element whose presence means the key ${step?.key ?? ''} is to be pressed`
    : action === 'appear' ? 'the element that shows when the page is ready for this step'
    : 'the element that shows while the page is not ready yet (a spinner, a banner, a dialog)';
  return `${what}. The user describes it as: "${step?.name || failure.name || '(no description)'}"`;
}

/** When the element is on the screen, for the person to bring it there by hand. */
function showsWhen(failure: LocatorFailure, step: ChatbotFileInput['step']): string {
  if (!failure.key.startsWith('step:')) return ChatLocatorShows[failure.key as ChatLocatorKey];
  const when = (step?.when ?? 'message') === 'open' ? 'right after the chat opens' : 'just before a message is sent';
  return `bring the page to where the program meets it, ${when} (the user knows the step: "${step?.name || failure.name || ''}")`;
}

/** The file's text (Markdown, kept as .txt so every chatbot takes it as an attachment). */
export function chatbotFile({ failure, step, piece, page, lang }: ChatbotFileInput): string {
  const isStep = failure.key.startsWith('step:');
  const where = isStep ? 'Settings → "Steps to the chat", the step\'s row in red' : 'Settings → "The chat\'s locators", the field in red';
  const placeholder = isStep ? undefined : ChatPlaceholder[failure.key as ChatLocatorKey];
  const language = languageName(lang);
  const cutPage = page.length > PAGE_CAP ? `${page.slice(0, PAGE_CAP)}\n<!-- … the rest of the page is cut here (it is ${page.length} characters long) -->` : page;
  const lines: string[] = [
    '# For the chatbot: find a locator on the Microsoft 365 Copilot page',
    '',
    'Read this whole file before you answer. The user attached it and may have written nothing else: start at once.',
    `Speak to the user in ${language}. Keep every locator exactly as it must be typed, in a code block.`,
    '',
    '## What this is about',
    '',
    'The user runs copilot-operator, a program that drives the Microsoft 365 Copilot chat page in Microsoft Edge (with Playwright).',
    'It finds each element it needs on that page by a locator: a CSS selector, an XPath, or a Playwright selector.',
    'Copilot\'s page changed, and one of those locators now finds nothing.',
    '',
    `**Your goal:** give the user ONE new locator that finds exactly this element, and only it. The user pastes it into the program (${where}), and the program finds the element again.`,
    '',
    '## What failed',
    '',
    `- **The element:** ${elementOf(failure, step)}.`,
    `- **Its name in the program:** ${isStep ? `the step "${step?.name || failure.name || failure.key.slice(5)}"` : `"${failure.key}"`}`,
    `- **The old locator, which now finds nothing:** \`${failure.locator}\``,
    `- **When and what the program was doing:** ${failure.at}: ${isStep ? failure.why : `it found nothing ${failure.why}`}`,
    `- **The work:** ${failure.stopped ? 'stopped there' : 'went on without it, more slowly or with something left undone'}`,
    ...(failure.url ? [`- **The page's address:** ${failure.url}`] : []),
    '',
    '## Rules for the new locator',
    '',
    '- A CSS selector; an XPath (starting with /) only when CSS cannot say it. The program also takes Playwright\'s :text-is("…"), :has-text("…"), :has(…) and role=button[name="…"].',
    '- Use what stays the same between versions of the page: id, role, aria-label, data-testid, data-test-id and other data-* attributes, the tag, the visible text.',
    '- Do not use class names made of random letters (like azFuQXgw or ___1x5usfw): they change with every new version of the page.',
    '- Before you give it, check it against the HTML below: it must match exactly one element (for elements the page shows many of, like the conversation\'s messages, it must match each of them and nothing else).',
    ...(placeholder === CHAT_ID ? [`- Keep ${CHAT_ID} in it where the conversation's id goes: the program puts the id there.`] : []),
    ...(placeholder === FILE_NAME
      ? [`- Keep ${FILE_NAME} in it where the file's name goes (the HTML shows message-01-in-full.txt or the like), or ${FILE_STEM} for the name without its extension (message-01-in-full): the program puts the name there.`]
      : []),
    '',
    '## How to answer',
    '',
    '1. The locator alone, in a code block.',
    '2. One line on why it is that element.',
    `3. Tell the user to paste it into the program: ${where}.`,
    '4. Tell the user how to check it on the real page: in Edge on the Copilot page, press F12, open "Elements", press Ctrl+F, paste the locator: it must show "1 of 1". (Ctrl+F there takes CSS and XPath, not Playwright\'s :text-is() or role=…: for those, the program\'s own "Check the locators" in Settings does the check.) If it shows "0 of 0" or more than one, the user tells you, and you look again.',
    '',
    '## Where to look',
    '',
    piece
      ? `Look first in **Part 1**: the piece of the page the program took from around ${failure.around ?? 'where the element was looked for'}. The element is most likely in it: beside it, above it or inside it. If it is not there, look in **Part 2**, the whole page.`
      : 'Look in **Part 2**, the whole page. (The program could not tell which part of the page the element is most likely in, so there is no Part 1.)',
    'The page was saved without its scripts, styles and picture data, and without the names of the user\'s conversations.',
    '',
    '## If the element is in neither part',
    '',
    'This is rare: the page may not have been showing it when it was saved. Do not guess a locator. Walk the user through finding it, one step at a time, and wait for their answer after each:',
    `1. In Edge, open the Copilot page and bring the element onto the screen: ${showsWhen(failure, step)}.`,
    '2. Press F12 (the developer tools), then Ctrl+Shift+C, and click the element on the page. Its line in "Elements" is now highlighted.',
    '3. Right-click that highlighted line → Copy → Copy outerHTML, and paste it to you. Then the same for the line of its parent (the line above it, one step to the left), and paste that too.',
    '4. From what they paste, give the locator as above.',
    'If the user cannot bring the element onto the screen at all, it may no longer exist on the page: say so, and ask them to describe or send a picture of what the page shows at that moment instead, and find with them what replaced it.',
    '',
    '## Part 1: the piece of the page where the element most likely is',
    '',
    piece ? fenced(piece, 'html') : '(none: see Part 2)',
    '',
    '## Part 2: the whole page',
    '',
    cutPage ? fenced(cutPage, 'html') : '(The page itself was not saved: help the user find the element in the browser, as said above.)',
    '',
  ];
  return lines.join('\n');
}
