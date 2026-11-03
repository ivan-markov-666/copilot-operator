'use client';

/**
 * What a setting saved while work goes on did to it (operator, 2026-11-03: "when I change a setting, if it can be, let
 * it take effect at once, even while a task is running"). Shown on any page a save is made from, only while something
 * runs, for a few seconds or until closed: in force at once; kept by the message at work and in force from its next
 * one; or in force when the chat window opens again. Nothing is said when nothing runs: then every setting is the
 * next message's anyway.
 */
import { useEffect, useRef, useState } from 'react';
import { onSettingsSaved, type SettingsSaved } from '../lib/api';
import { useT } from '../lib/i18n';

/** How long the notice stays when it is not closed. */
const SHOWN_MS = 9000;

export function SettingsTakenNotice() {
  const { t } = useT();
  const [saved, setSaved] = useState<SettingsSaved | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const off = onSettingsSaved((s) => {
      if (s.running === 0 || s.now.length + s.next.length + s.window.length === 0) return;
      setSaved(s);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(null), SHOWN_MS);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  if (!saved) return null;
  return (
    <div className="settings-taken" role="status" data-testid="settings-taken">
      <div className="settings-taken-lines">
        {saved.now.length > 0 && <p className="settings-taken-now">{t('live.now')}</p>}
        {saved.next.length > 0 && <p>{t('live.next')}</p>}
        {saved.window.length > 0 && <p>{t('live.window')}</p>}
      </div>
      <button type="button" className="wb-icon-btn" aria-label={t('live.close')} title={t('live.close')} onClick={() => setSaved(null)}>
        ✕
      </button>
    </div>
  );
}
