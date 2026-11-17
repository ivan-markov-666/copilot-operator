/**
 * The steps on the way to the chat, as the operator sets them (2026-11-17: "what happens if we want to add or remove a
 * step? Some steps will drop out in future and new ones will appear to reach the chat"). The locators say where each of
 * the bot's own steps clicks; these say which of those steps are taken at all, and what more is done:
 *
 *   - the bot's own steps that can be done without — declining Edge's and the page's first-run dialogs, closing
 *     Office's feedback panel, naming the conversation in the sidebar — each switched off in Settings;
 *   - steps of the operator's own, in their order, each "if this is on the page, do this": when the chat opens (a new
 *     chat, a conversation opened again, after a sign-in) or before each message. Click it, press a key, wait for it to
 *     show, wait for it to go. One that "must be there" and is not, within its seconds, stops the work and is said like
 *     a locator that found nothing — in red in Settings, with the page's HTML for a chatbot; the others are passed over
 *     when they are not there.
 *
 * Only on Copilot's page, only what the locator finds: nothing is typed, nothing is downloaded, no program is started.
 */
import { locatorSyntaxProblem } from './locators.js';

export const STEP_WHEN = ['open', 'message'] as const;
export type StepWhen = (typeof STEP_WHEN)[number];
export const STEP_ACTIONS = ['click', 'press', 'appear', 'gone'] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

export type ChatStep = {
  /** Its own, made when it is added: what a failure of it is kept under (`step:<id>`). */
  id: string;
  /** In the operator's words: what it is for. */
  name: string;
  when: StepWhen;
  locator: string;
  action: StepAction;
  /** The key `press` presses (Playwright's names: Escape, Enter, Tab, Control+Enter…). */
  key?: string;
  /** Not there within `waitSec`: the work stops, and it is said. Otherwise passed over. */
  must?: boolean;
  /** How long it is waited for (to show, or for `gone` to go). */
  waitSec?: number;
  /** Kept in Settings, not taken. */
  off?: boolean;
};

/** The bot's own steps that can be switched off; all on by default, as before 2026-11-17. */
export const BUILT_IN_STEPS = ['popups', 'feedbackPanel', 'nameChat'] as const;
export type BuiltInStepKey = (typeof BUILT_IN_STEPS)[number];
export type BuiltInSteps = Record<BuiltInStepKey, boolean>;
export const DefaultBuiltInSteps: BuiltInSteps = { popups: true, feedbackPanel: true, nameChat: true };

/** Where a step's failure is kept, and Settings finds its row by. */
export const stepKey = (id: string): string => `step:${id}`;
export const isStepKey = (key: string): boolean => /^step:[\w-]{1,40}$/.test(key);

/** A key Playwright can press: a name or one character, with Control/Shift/Alt/Meta in front. */
export function keyProblem(key: string | undefined): string | null {
  const k = (key ?? '').trim();
  if (!k) return 'no key is given to press';
  const ok = /^(?:(?:Control|Shift|Alt|Meta)\+)*(?:[A-Za-z0-9]|F(?:[1-9]|1[0-2])|Escape|Enter|Tab|Space|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/.test(k);
  return ok ? null : `"${k}" is not a key it can press (Escape, Enter, Tab, Space, an arrow, F1–F12, one letter or digit, Control+… )`;
}

/** What keeps a step from being taken, said for the operator; null when it can be. */
export function stepProblem(step: ChatStep): string | null {
  if (!step.locator.trim()) return 'it has no locator';
  const syntax = locatorSyntaxProblem(step.locator);
  if (syntax) return syntax;
  if (step.action === 'press') return keyProblem(step.key);
  return null;
}

/** The steps taken, in their order: those switched on that can be taken; the rest said in `problems`. */
export function usableSteps(saved: ChatStep[] | undefined | null): { steps: ChatStep[]; problems: string[] } {
  const steps: ChatStep[] = [];
  const problems: string[] = [];
  for (const [i, step] of (saved ?? []).entries()) {
    if (step.off) continue;
    const problem = stepProblem(step);
    if (problem) problems.push(`step ${i + 1} "${step.name || step.locator}" in Settings is not taken: ${problem}`);
    else steps.push(step);
  }
  return { steps, problems };
}

/** The text a chatbot is handed with the page's HTML for a step's element (as `locatorPrompt` for the chat's own). */
export function stepPrompt(step: Pick<ChatStep, 'name' | 'action' | 'key'>, failed: string): string {
  const what =
    step.action === 'click' ? 'the element the user clicks at this point'
    : step.action === 'press' ? `the element whose presence means the key ${step.key ?? ''} is to be pressed`
    : step.action === 'appear' ? 'the element that shows when the page is ready for this step'
    : 'the element that shows while the page is not ready yet (a spinner, a banner, a dialog)';
  return [
    'The attached file is the HTML of the Microsoft 365 Copilot chat page in a browser (scripts, styles and the list of conversations taken out).',
    `Find this element in it: ${what}. The user describes it as: "${step.name || '(no description)'}".`,
    `This locator used to find it and now finds nothing: ${failed}`,
    'Give me one locator that finds exactly this element, and only it: a CSS selector, or an XPath if CSS cannot say it.',
    'Use what stays the same between versions of the page: id, role, aria-label, data-testid, data-test-id and other data-* attributes, the tag, the visible text.',
    'Do not use class names made of random letters (like azFuQXgw or ___1x5usfw): they change with every new version of the page.',
    'Answer with the locator on the first line, then one line on why it is that element.',
  ].join('\n');
}
