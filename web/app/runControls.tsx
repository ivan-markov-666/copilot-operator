'use client';

/**
 * Hold or stop a run, from wherever the operator happens to be watching it.
 *
 * Stopping already existed, on the sessions list and on the session page. The register did not
 * have it, and the register is where a run is actually watched: the counters, the queue, the
 * failures as they land. So the one moment the control is wanted — something has just gone
 * wrong and the rest of the queue is about to run on top of it — was the one moment it was two
 * navigations away.
 *
 * The two buttons are deliberately not the same act. **Stop** cuts in after the current step:
 * fast, and the task it interrupts ends `aborted` with whatever it was halfway through left
 * halfway through. **Pause** lets that task finish properly — checks, review, commit — and holds
 * the queue behind it. A person who has just seen a failure and wants to think wants the second
 * one, and before this they could only have the first.
 *
 * Neither loses anything: what is queued stays queued, and "Continue" on this same page is what
 * starts it again.
 */
import { useCallback, useEffect, useState } from 'react';

import { api, type BatchState } from '../lib/api';
import { useT } from '../lib/i18n';

export function RunControls({ onChange }: { onChange?: () => void }) {
  const { t } = useT();
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const read = useCallback(async () => {
    try {
      setBatch(await api.batch());
    } catch {
      /* the register already says when the API is unreachable */
    }
  }, []);

  useEffect(() => {
    void read();
    // Faster than the register's own six seconds: this is the part somebody is waiting on.
    const timer = setInterval(() => void read(), 3000);
    return () => clearInterval(timer);
  }, [read]);

  const act = async (what: 'pause' | 'resume' | 'stop') => {
    setBusy(true);
    setErr('');
    try {
      if (what === 'pause') await api.pauseBatch();
      else if (what === 'resume') await api.resumeBatch();
      else await api.stopBatch();
      await read();
      onChange?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!batch?.running) return null;

  return (
    <div className="row" style={{ marginBottom: 8 }}>
      {batch.pausing ? (
        <button className="primary" disabled={busy} onClick={() => void act('resume')} title={t('batch.resumeWhy')}>
          {t('batch.resume')}
        </button>
      ) : (
        <button disabled={busy || batch.stopping} onClick={() => void act('pause')} title={t('batch.pauseWhy')}>
          {t('batch.pause')}
        </button>
      )}
      <button className="danger" disabled={busy || batch.stopping} onClick={() => void act('stop')} title={t('batch.stopWhy')}>
        {t('batch.stop')}
      </button>
      {batch.pausing && !batch.stopping && <span className="muted small">{t('batch.pausing')}</span>}
      {batch.stopping && <span className="muted small">{t('batch.stopping')}</span>}
      {err && <span className="err small">{err}</span>}
    </div>
  );
}
