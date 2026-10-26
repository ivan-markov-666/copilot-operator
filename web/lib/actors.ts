/**
 * Who works, or asks, in words (operator, 2026-10-22: "show clearly what the bot is doing and who works — plan mode,
 * the lead, the worker, the reviewer"; "and in the tab that says copilot-operator"). Plain functions over a
 * translator, so the chat, the cards, the LIVE mark and the tab's title say it alike, and a check can hold them to it.
 */
import type { Acting, Activity, Actor } from './api';
import type { Key } from './lang/types';

type Translate = (key: Key, vars?: Record<string, string | number>) => string;

export const ACTOR_NAME: Record<Actor, Key> = { plan: 'actor.plan', lead: 'actor.lead', worker: 'actor.worker', review: 'actor.review' };
export const ACTOR_INFO: Record<Actor, Key> = { plan: 'actor.planInfo', lead: 'actor.leadInfo', worker: 'actor.workerInfo', review: 'actor.reviewInfo' };

/** The actor's name, with the subtask or the review's round when there is one: "Worker · subtask 3". */
export function actorLabel(t: Translate, actor: Actor, acting?: Pick<Acting, 'subtask' | 'round'>): string {
  const more = acting?.subtask ? t('actor.subtask', { n: acting.subtask }) : acting?.round ? t('actor.round', { n: acting.round }) : '';
  return more ? `${t(ACTOR_NAME[actor])} · ${more}` : t(ACTOR_NAME[actor]);
}

/** Whether that answer says the bot is at work: a run going, or one being started. */
export const isWorking = (a: Activity | null | undefined): boolean => !!a && (a.running || a.starting);

/** What the LIVE mark says, on hover and to a reader that cannot see it: who is at work, or that it is paused. */
export function liveText(t: Translate, a: Activity | null | undefined): string {
  if (a?.paused) return t('wb.livePaused');
  return a?.acting ? t('wb.liveWho', { who: actorLabel(t, a.acting.actor, a.acting) }) : t('wb.livePlain');
}

export const BASE_TITLE = 'copilot-operator';

/** How a message ended, as the tab says it. */
export const OUTCOME_WORDS: Record<string, string> = { done: 'Done', failed: 'Error', aborted: 'Stopped', blocked: 'Blocked', 'limit-reached': 'Limit reached' };

/**
 * The tab's title (operator, 2026-10-23: "while the bot works, 'Working.', 'Working..', 'Working...' and round again;
 * 'Done' when it stops, 'Error' when the task fails, and other handy words for the stage it is at — the user is to see
 * it and act"). In English, as asked, whatever the page's language. What waits for the operator comes first; how the
 * last message ended is said while `showLast` — until the operator has had the page in front of them a while.
 */
export function tabTitle(waiting: number, a: Activity | null | undefined, dots: number, showLast: boolean): string {
  const trail = '.'.repeat(Math.min(3, Math.max(1, dots)));
  const word =
    waiting > 0
      ? `Waiting for you (${waiting})`
      : a?.password
        ? 'Waiting for your password'
        : a?.paused
        ? 'Paused'
        : a?.running
          ? `Working${trail}`
          : a?.starting
            ? `Starting${trail}`
            : showLast && a?.last
              ? (OUTCOME_WORDS[a.last.status] ?? '')
              : '';
  return word ? `${word} — ${BASE_TITLE}` : BASE_TITLE;
}

/** A time short enough for a heading: the hour and minute of today, with the day for another. */
export function fmtClock(iso: string | undefined, dateLocale: string | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const clock = d.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === now.toDateString() ? clock : `${d.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' })} ${clock}`;
}
