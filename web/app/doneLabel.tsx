'use client';

/**
 * "Done" (operator, 2026-11-03: "when the task ends, if there is no queue, let a message appear — 'Done'. As the message
 * that we wait for the user's action appears, one like it, that we are done with everything").
 *
 * Big, in the middle of the window, like "Waiting for your action" (`awaiting.tsx`), once the work has stopped: nothing
 * runs or is being started, the queue's turn is over (`Activity.queue`), and nothing on the screen waits for the
 * operator. A message that ended done says "Done"; one that ended otherwise says how ("Finished: not done"), since
 * "Done" would say something false; a Stop the operator pressed is theirs, and says nothing. It takes no button: the
 * first click or key anywhere takes it away, and so does the next start. Each ending is shown once, a reload included.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useActivity } from '../lib/activity';
import { useT, type Key } from '../lib/i18n';

/** The ending last taken away, by when it was, so a reload does not show it again. */
const SEEN_KEY = 'cop.done.seen';

function seenAt(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function DoneLabel() {
  const { t } = useT();
  const activity = useActivity();
  const [seen, setSeen] = useState<string>('');
  const [waits, setWaits] = useState(false);
  useEffect(() => setSeen(seenAt()), []);
  // Something on the screen waits for the operator (`data-awaits`): that is said, not this.
  useEffect(() => {
    const look = (): void => setWaits(document.querySelector('[data-awaits]') !== null);
    look();
    const watch = new MutationObserver(look);
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-awaits'] });
    return () => watch.disconnect();
  }, []);
  const end = activity && !activity.running && !activity.starting && !activity.queue && activity.last && activity.last.status !== 'aborted' ? activity.last : null;
  const shown = end !== null && end.at !== seen && !waits;
  useEffect(() => {
    if (!shown || !end) return;
    const away = (): void => {
      setSeen(end.at);
      try {
        localStorage.setItem(SEEN_KEY, end.at);
      } catch {
        // No storage: it goes for this page, and a reload shows it once more.
      }
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', away, true);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', away, true);
    };
  }, [shown, end]);
  if (!shown || !end || typeof document === 'undefined') return null;
  const done = end.status === 'done';
  return createPortal(
    <p className={done ? 'done-label' : 'done-label done-label-ended'} role="status" data-testid="done-label">
      {done && (
        <span className="done-mark" aria-hidden="true">
          ✓
        </span>
      )}
      {done ? t('done.label') : t('done.ended', { status: t(`status.${end.status}` as Key) })}
    </p>,
    document.body,
  );
}
