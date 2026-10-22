'use client';

/**
 * Who works, or asks (operator, 2026-10-22: "make it clear who works — plan mode, the lead, the worker, the reviewer;
 * and on the cards that open to choose a model or to allow a command, say clearly who asks"). One mark, the same
 * colour wherever it is: the status bar, the chat's working line, every card. The words are `lib/actors.ts`.
 */
import type { Acting, Actor } from '../lib/api';
import { ACTOR_INFO, actorLabel } from '../lib/actors';
import { useT } from '../lib/i18n';

/** The actor's name in the page's language, with the subtask or the round when there is one. */
export function useActorName(): (actor: Actor, acting?: Pick<Acting, 'subtask' | 'round'>) => string {
  const { t } = useT();
  return (actor, acting) => actorLabel(t, actor, acting);
}

/**
 * The mark: `asks` on a card ("Asked by: Reviewer"), `now` on a working line ("At work: Worker · subtask 3"), or the
 * name alone. Its title says what that one does.
 */
export function ActorChip({ actor, acting, how = 'name' }: { actor: Actor; acting?: Pick<Acting, 'subtask' | 'round'>; how?: 'name' | 'asks' | 'now' }) {
  const { t } = useT();
  const named = actorLabel(t, actor, acting);
  const text = how === 'asks' ? t('actor.asks', { who: named }) : how === 'now' ? t('actor.now', { who: named }) : named;
  return (
    <span className={`actor-chip actor-${actor}`} data-actor={actor} title={t(ACTOR_INFO[actor])}>
      <span className="actor-dot" aria-hidden="true" />
      {text}
    </span>
  );
}
