'use client';

/**
 * The line along the workbench's bottom, as an IDE has: where the chosen session's work is (its branch), the model,
 * what is running now and how far into its limits it is, and how many steps wait for an answer.
 */
import { useEffect, useState } from 'react';
import { api, type Session, type Task } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { usePoll } from '../../lib/usePoll';
import { useNow } from '../../lib/useNow';

export function StatusBar({ sessions, session, task, onOpenTask }: { sessions: Session[]; session?: Session; task?: Task; onOpenTask: (sessionId: string, taskId: string) => void }) {
  const { t } = useT();
  const now = useNow(true, 5000);
  const [branch, setBranch] = useState('');
  const [waiting, setWaiting] = useState(0);
  const [limits, setLimits] = useState<{ iterations: number; minutes: number }>({ iterations: 60, minutes: 240 });

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        const l = (s.raw.limits as { maxIterations?: number; maxRunMinutes?: number } | undefined) ?? {};
        setLimits({ iterations: l.maxIterations ?? 60, minutes: l.maxRunMinutes ?? 240 });
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    setBranch('');
    if (!session?.vcs?.enabled) return;
    api.vcsStatus(session.id).then((v) => setBranch(v.branch ?? '')).catch(() => undefined);
  }, [session?.id, session?.status, task?.status]);
  usePoll(() => api.approvals().then((a) => setWaiting(a.length)).catch(() => undefined), 3000);

  const runningSession = sessions.find((s) => s.status !== 'idle');
  const runningTask = runningSession?.tasks.find((x) => x.status === 'running' || x.status === 'waiting-approval');
  const minutes = runningTask?.startedAt ? Math.floor((now - Date.parse(runningTask.startedAt)) / 60000) : 0;

  return (
    <footer className="wb-statusbar" aria-label={t('wb.status')}>
      {session?.vcs?.enabled && (
        <span title={t('wb.branchNow')}>
          <span aria-hidden="true">⎇ </span>
          {branch || '…'}
        </span>
      )}
      {runningSession && runningTask ? (
        <button type="button" className="wb-status-btn" onClick={() => onOpenTask(runningSession.id, runningTask.id)} title={t('wb.openRunning')}>
          <span className="wb-live" aria-hidden="true" /> {t('wb.runningLine', { session: runningSession.name, task: runningTask.title, n: runningTask.iterations, max: limits.iterations, m: minutes, maxm: limits.minutes })}
        </button>
      ) : (
        <span>{t('wb.idle')}</span>
      )}
      <span className="grow" />
      {waiting > 0 && (
        <button type="button" className="wb-status-btn warn" onClick={() => document.querySelector('.approval-banner')?.scrollIntoView({ block: 'start' })}>
          {t('wb.waiting', { n: waiting })}
        </button>
      )}
      {session && <span title={t('wb.modelNow')}>{session.modelInUse ?? session.model ?? t('wb.modelDefault')}</span>}
    </footer>
  );
}
