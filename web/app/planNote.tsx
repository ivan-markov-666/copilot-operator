'use client';

/**
 * The note that goes with the answer to a plan, and "Ask for another plan", alike on the plan's card and on the card
 * of a queue task set aside at its plan (operator, 2026-11-02: "make it so that 'Ask for another plan' cannot be pressed
 * without text in the field ... with an i button, or a hint when the mouse is over the button"; "make the field's
 * information clearer"). Under the note's name a line says what it is for with each answer; the button stays off until
 * the note says what to change, and the pointer over it and its ⓘ say how it is used.
 */
import type { Key } from '../lib/lang/types';
import type { useChoice } from '../lib/useChoice';
import { useT } from '../lib/i18n';
import { InfoTip } from './popover';

/** What the note is for, under its name: optional when approving, required when asking for another plan. */
export function PlanNoteHint({ id }: { id: string }) {
  const { t } = useT();
  return (
    <p id={id} className="muted small pm-note-hint">
      {t('pm.noteHint')}
    </p>
  );
}

/** "Ask for another plan", off while the note is empty, with its ⓘ beside it; `approve` names the card's other answer. */
export function ReviseButton({ note, label, approve, choice, onPress }: { note: string; label: Key; approve: Key; choice: ReturnType<ReturnType<typeof useChoice>['mark']>; onPress: () => void }) {
  const { t } = useT();
  const empty = !note.trim();
  return (
    <span className="pm-revise">
      <button type="button" {...choice} disabled={choice.disabled || empty} onClick={onPress} title={t(empty ? 'pm.reviseOffWhy' : 'pm.reviseWhy')}>
        {t(label)}
      </button>
      <InfoTip label={t('info.about', { name: t(label) })} text={t('pm.reviseHowWhy', { note: t('pm.note'), revise: t(label), approve: t(approve) })} />
    </span>
  );
}
