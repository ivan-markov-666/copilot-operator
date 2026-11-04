/**
 * What "Copy all" takes from a card the bot addressed to the operator (operator, 2026-11-04: "for every such message from
 * the bot to the user, let me copy what it gives me as information; the text and the choices too"): the card from top to
 * bottom, in the words it shows, and what it keeps folded, in full. `cardCopy` is the one way in for every kind of card
 * that waits, so a card and what is copied from it say the same. Plain functions over a translator; a check holds them.
 */
import type { Approval, Parked, RetryChoice, SubtaskFailure, TaskPlan } from './api';
import { fenced, handoffCopy } from './handoffCopy';
import type { Key } from './lang/types';

type Translate = (key: Key, vars?: Record<string, string | number>) => string;
type Question = { text: string; why?: string; options: string[]; commands?: Array<string | null>; multiple?: boolean };

/** Why an attempt ended, in words: each kind of technical failure and the others (2026-10-25). */
export const FAILURE_KEY: Record<SubtaskFailure, Key> = {
  TRANSIENT_CHAT_FAILURE: 'retry.catTransient',
  COMMAND_INFRASTRUCTURE_FAILURE: 'retry.catCommand',
  TASK_EVIDENCE_FAILURE: 'retry.catEvidence',
  USER_STOPPED: 'retry.catStopped',
  UNKNOWN_SIDE_EFFECT_STATE: 'retry.catUnknown',
};
export const CHOICE_KEY: Record<RetryChoice, Key> = { same: 'retry.same', fresh: 'retry.fresh', continue: 'retry.continue', restore: 'retry.restore', accept: 'retry.accept' };
/** What a task set aside waits for. */
export const PARKED_WAITS: Record<Parked['kind'], Key> = {
  plan: 'pk.waitsPlan',
  question: 'pk.waitsQuestion',
  retry: 'pk.waitsRetry',
  command: 'pk.waitsCommand',
  model: 'pk.waitsModel',
  password: 'pk.waitsPassword',
};

const paragraphs = (parts: string[]): string => parts.filter(Boolean).join('\n\n');

/** The plan as text, in the page's language: its headings as Markdown, its steps numbered, its files as a list. */
export function planAsText(plan: TaskPlan, t: Translate): string {
  const part = (heading: Key, body: string): string[] => (body.trim() ? [`## ${t(heading)}`, '', body.trim(), ''] : []);
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

/** What "Copy" takes from a question; `open` while it waits for its answer, with how it is answered on the card. */
export function questionCopy(t: Translate, q: Question, open: boolean): string {
  const send = t(q.multiple ? 'chat.sendChosen' : 'lead.send');
  const offered = q.options.map((o, i) => [`${i + 1}. ${o}${i === 0 ? ` (${t('chat.optionRecommended')})` : ''}`, ...(q.commands?.[i] ? [`   ${t('chat.optionRuns', { cmd: q.commands[i]! })}`] : [])].join('\n'));
  const head = !open ? t('chat.copyOffered') : q.multiple ? t('chat.copyMany', { send }) : t('chat.copyOne');
  return paragraphs([
    q.text,
    q.why ?? '',
    offered.length > 0 ? [head, ...offered].join('\n') : '',
    open ? t(q.multiple ? 'chat.copyWriteMany' : 'chat.copyWrite', { answer: t('lead.answer'), send }) : '',
  ]);
}

/** What the bot asks the operator to do about the model: the card says it, and "Copy all" takes it. */
export function modelAsk(t: Translate, m: NonNullable<Approval['model']>): string {
  if (m.manual) return m.asked ? t('approval.manualAsk', { model: m.asked }) : t('approval.manualAskAny');
  return t('approval.modelAsk', { model: m.asked });
}

function modelCopy(t: Translate, m: NonNullable<Approval['model']>): string {
  const lead = m.role === 'lead';
  return paragraphs([
    t(m.manual ? 'approval.manualTitle' : 'approval.modelTitle'),
    m.review ? `${t('approval.reviewModelTitle')}\n${t('approval.reviewModelWhy')}` : '',
    m.role ? `${t(lead ? 'approval.leadModelTitle' : 'approval.workerModelTitle')}\n${t(lead ? 'approval.leadModelWhy' : 'approval.workerModelWhy')}` : '',
    modelAsk(t, m),
    t('approval.modelShown', { shown: m.shown ?? '—' }),
    m.manual ? '' : t('approval.modelWhy', { why: m.why, tries: m.tries }),
  ]);
}

const choices = (t: Translate, list: RetryChoice[]): string => [t('chat.copyOffered'), ...list.map((c, i) => `${i + 1}. ${t(CHOICE_KEY[c])}`)].join('\n');

function retryCopy(t: Translate, r: NonNullable<Approval['retry']>): string {
  return paragraphs([
    `${t('retry.title', { n: r.n })}\n${r.title}`,
    `${t('retry.attempt', { k: r.attempt, m: r.maxAttempts })} · ${t(FAILURE_KEY[r.category])}`,
    r.reason ? t('retry.reason', { reason: r.reason }) : '',
    r.sideEffects === 'unknown' ? t('retry.unknown') : '',
    r.changed.length > 0 ? t('retry.changed', { files: r.changed.join(', ') }) : '',
    choices(t, r.choices),
  ]);
}

/** A command that waits, its warnings and the scripts it runs, each in full. */
function stepCopy(t: Translate, a: Approval, title: string): string {
  return paragraphs([
    title,
    fenced(a.description),
    a.platform ? t('approval.platform', { platform: a.platform }) : '',
    a.readOnly ? t('approval.readOnly') : '',
    a.network ? t('approval.network') : '',
    (a.scripts?.length ?? 0) > 0 ? t('approval.scripts') : '',
    ...(a.scripts ?? []).map((x) =>
      [x.script ? t('approval.scriptOf', { name: x.script, path: x.path }) : x.path, x.problem ?? '', x.cut ? t('ho.cut') : '', x.text !== undefined ? fenced(x.text) : ''].filter(Boolean).join('\n'),
    ),
  ]);
}

/** All a waiting card says, whichever kind it is. `stepTitle`: where a command's card has a heading of its own. */
export function cardCopy(t: Translate, a: Approval, stepTitle?: string): string {
  if (a.plan) return paragraphs([t('pm.cardTitle', { title: a.plan.title }), t('pm.cardWhy'), planAsText(a.plan.plan, t)]);
  if (a.question?.handoff) return handoffCopy(t, a.question.handoff, a.question.text);
  if (a.question) return paragraphs([t((a.actor ?? 'lead') === 'lead' ? 'lead.question' : 'chat.question'), questionCopy(t, a.question, true)]);
  if (a.retry) return retryCopy(t, a.retry);
  if (a.model) return modelCopy(t, a.model);
  return stepCopy(t, a, stepTitle ?? t('chat.askTitle'));
}

/** A task set aside at a card: since when, for what, and that card; what no card holds, in the words the bot says it. */
export function parkedCopy(t: Translate, parked: Parked, at: string): string {
  const body = parked.kind === 'model' ? t('pk.modelWhy') : parked.kind === 'password' ? t('pk.passwordWhy') : cardCopy(t, parked.approval);
  return paragraphs([t('pk.title'), t('pk.since', { at, what: t(PARKED_WAITS[parked.kind]) }), body]);
}

/** A subtask that did not end after a Stop, and what can be done with it (2026-10-25). */
export function afterStopCopy(t: Translate, n: number, title: string): string {
  return paragraphs([t('lead.subtask', { n, title }), t('retry.afterStopWhy'), choices(t, ['same', 'fresh'])]);
}
