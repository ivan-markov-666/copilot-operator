'use client';

/**
 * A log, offered as something that lands on the Desktop rather than in another tab.
 *
 * Opening a log in a tab was the wrong end of the journey: what the operator does with a log
 * is give it to the chat that orchestrates the effort, and a tab has to be saved, found and
 * dragged before it can be given to anything. So this is a button, not a link, and what it
 * says afterwards is the path — the one piece of information that is still useful if Explorer
 * did not come to the front.
 *
 * The save happens on the machine running the API, so it can fail for reasons the browser has
 * no idea about. The failure is said here, next to the button that caused it, instead of in a
 * dialog that would take the operator away from the task they were reading.
 *
 * It lives in its own file because both the register and the session page offer logs, and a
 * component written out twice is a component that will be improved once.
 */
import { useState } from 'react';

import { useT } from '../lib/i18n';
import type { SavedLog } from '../lib/api';

export function SaveLog({ label, save }: { label: string; save: () => Promise<SavedLog> }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [failed, setFailed] = useState(false);

  const press = async () => {
    setBusy(true);
    setSaid('');
    try {
      const saved = await save();
      setFailed(false);
      setSaid(saved.revealed ? t('save.done', { path: saved.path }) : t('save.savedOnly', { path: saved.path, note: saved.note ?? '' }));
    } catch (e) {
      setFailed(true);
      setSaid(t('save.failed', { problem: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Disabled while it runs: a second press would write a second copy of the same log. */}
      <button type="button" className="linkish" disabled={busy} title={t('save.why')} onClick={() => void press()}>
        {busy ? t('save.saving') : label}
      </button>
      {said && <span className={failed ? 'err small' : 'muted small'}>{said}</span>}
    </>
  );
}
