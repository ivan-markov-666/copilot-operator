/**
 * What the page's "Copy all" and "Copy" give, for Kerrigan when she directs (operator, 2026-11-12: "by default, show
 * Kerrigan only what pressing 'Copy' or 'Copy all' gives: where she is needed, 'Copy all', or 'Copy' where there is
 * none; at the end of a task, its last message — the summary of what was done, tried and how it went — copied").
 *
 * The page's own is `web/lib/cardCopy.ts`, over the page's dictionary; the program cannot reach that, so this is the same
 * in English — her contract's language — for the cards that come to her: a question, a plan, a subtask cut off. Its
 * words are the English dictionary's, and `test/card-copy.check.ts` holds the two to the same text, so what she is given
 * is what the operator would have copied to her.
 */
import type { PendingApproval, RetryChoice, SubtaskFailure, Task, TaskPlan } from '../session/model.js';

/** The English dictionary's words this needs (`web/lib/lang/en.ts`), by their keys; the check holds them equal. */
export const CARD_WORDS = {
  'lead.question': 'The lead asks you',
  'chat.question': 'The chat asks you',
  'chat.copyOne': 'The answers offered — press one on the card:',
  'chat.copyMany': 'The answers offered — more than one may be chosen: press each one you want on the card, then “{send}”:',
  'chat.copyWrite': 'Or write your own answer in “{answer}” and press “{send}”.',
  'chat.copyWriteMany': 'You can also write in “{answer}”, alone or with the ones chosen, and press “{send}”.',
  'lead.answer': 'Your answer',
  'lead.send': 'Send the answer',
  'chat.sendChosen': 'Send the choice',
  'chat.optionRecommended': 'Recommended by the chat',
  'chat.optionRuns': 'runs: {cmd}',
  'chat.copyOffered': 'The answers offered:',
  'pm.cardTitle': 'Plan for “{title}”, waiting for approval',
  'pm.cardWhy': 'Nothing has been changed yet. The work starts once you approve this plan.',
  'pm.existing': 'Already there',
  'pm.approach': 'Approach',
  'pm.steps': 'Steps',
  'pm.files': 'Files it expects to change',
  'pm.verification': 'How it will show the work is done',
  'pm.risks': 'Risks',
  'retry.title': 'Subtask {n} did not finish',
  'retry.attempt': 'Attempt {k} of {m}',
  'retry.catTransient': 'The chat broke off',
  'retry.catCommand': 'A command could not be run',
  'retry.catEvidence': 'The work was not done',
  'retry.catStopped': 'Stopped',
  'retry.catUnknown': 'Not known what changed',
  'retry.reason': 'Reason: {reason}',
  'retry.unknown': 'The subtask was interrupted after a possible change. Choose whether to continue from the current state or to restore the snapshot.',
  'retry.changed': 'Files changed so far: {files}',
  'retry.same': 'Try again',
  'retry.fresh': 'Try with a new worker',
  'retry.continue': 'Continue from the current state',
  'retry.restore': 'Restore the snapshot',
  'retry.accept': 'Accept as failed',
} as const;
type Word = keyof typeof CARD_WORDS;

const t = (key: Word, vars: Record<string, string | number> = {}): string => CARD_WORDS[key].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
const paragraphs = (parts: string[]): string => parts.filter(Boolean).join('\n\n');

const FAILURE: Record<SubtaskFailure, Word> = {
  TRANSIENT_CHAT_FAILURE: 'retry.catTransient',
  COMMAND_INFRASTRUCTURE_FAILURE: 'retry.catCommand',
  TASK_EVIDENCE_FAILURE: 'retry.catEvidence',
  USER_STOPPED: 'retry.catStopped',
  UNKNOWN_SIDE_EFFECT_STATE: 'retry.catUnknown',
};
const CHOICE: Record<RetryChoice, Word> = { same: 'retry.same', fresh: 'retry.fresh', continue: 'retry.continue', restore: 'retry.restore', accept: 'retry.accept' };

function planAsText(plan: TaskPlan): string {
  const part = (heading: Word, body: string): string[] => (body.trim() ? [`## ${t(heading)}`, '', body.trim(), ''] : []);
  return [
    ...part('pm.existing', plan.existing),
    ...part('pm.approach', plan.approach),
    ...part('pm.steps', plan.steps.map((s, i) => `${i + 1}. ${s.trim()}`).join('\n')),
    ...part('pm.files', plan.files.map((f) => `- \`${f}\``).join('\n')),
    ...part('pm.verification', plan.verification),
    ...part('pm.risks', plan.risks ?? ''),
  ]
    .join('\n')
    .trim();
}

type Question = { text: string; why?: string; options: string[]; commands?: Array<string | null>; multiple?: boolean };

function questionCopy(q: Question): string {
  const send = t(q.multiple ? 'chat.sendChosen' : 'lead.send');
  const offered = q.options.map((o, i) => [`${i + 1}. ${o}${i === 0 ? ` (${t('chat.optionRecommended')})` : ''}`, ...(q.commands?.[i] ? [`   ${t('chat.optionRuns', { cmd: q.commands[i]! })}`] : [])].join('\n'));
  const head = q.multiple ? t('chat.copyMany', { send }) : t('chat.copyOne');
  return paragraphs([q.text, q.why ?? '', offered.length > 0 ? [head, ...offered].join('\n') : '', t(q.multiple ? 'chat.copyWriteMany' : 'chat.copyWrite', { answer: t('lead.answer'), send })]);
}

function retryCopy(r: NonNullable<PendingApproval['retry']>): string {
  return paragraphs([
    `${t('retry.title', { n: r.n })}\n${r.title}`,
    `${t('retry.attempt', { k: r.attempt, m: r.maxAttempts })} · ${t(FAILURE[r.category])}`,
    r.reason ? t('retry.reason', { reason: r.reason }) : '',
    r.sideEffects === 'unknown' ? t('retry.unknown') : '',
    r.changed.length > 0 ? t('retry.changed', { files: r.changed.join(', ') }) : '',
    [t('chat.copyOffered'), ...r.choices.map((c, i) => `${i + 1}. ${t(CHOICE[c])}`)].join('\n'),
  ]);
}

/** "Copy all" of a card that comes to her: a question, a plan, a subtask cut off. Null for any other. */
export function cardCopyText(a: Pick<PendingApproval, 'plan' | 'question' | 'retry' | 'actor'>): string | null {
  if (a.plan) return paragraphs([t('pm.cardTitle', { title: a.plan.title }), t('pm.cardWhy'), planAsText(a.plan.plan)]);
  if (a.question && !a.question.handoff) return paragraphs([t((a.actor ?? 'lead') === 'lead' ? 'lead.question' : 'chat.question'), questionCopy(a.question)]);
  if (a.retry) return retryCopy(a.retry);
  return null;
}

/** "Copy" beside a message's ending: its summary, and why when it did not end done (`Ending` in `cascade.tsx`). */
export function endingCopyText(task: Pick<Task, 'summary' | 'reason' | 'status'>): string {
  return [task.summary, task.status !== 'done' ? task.reason : ''].filter(Boolean).join('\n\n');
}
