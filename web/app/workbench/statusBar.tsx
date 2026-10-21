'use client';

/**
 * The line along the workbench's bottom, as an IDE has: the open folder and its branch, the model of the conversation
 * open in the chat, what is running now and how far into its limits it is, and how many steps wait for an answer.
 */
import { useEffect, useState } from 'react';
import { api, type Session, type Workspace } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { usePoll } from '../../lib/usePoll';
import { useNow } from '../../lib/useNow';
import { BranchIcon } from '../branchIcon';

export function StatusBar({ sessions, session, workspace, onShowThread }: { sessions: Session[]; session?: Session; workspace: Workspace | null; onShowThread: (sessionId: string) => void }) {
  const { t } = useT();
  const now = useNow(true, 5000);
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
  usePoll(() => api.approvals().then((a) => setWaiting(a.length)).catch(() => undefined), 3000);

  const runningSession = sessions.find((s) => s.status !== 'idle');
  const runningTask = runningSession?.tasks.find((x) => x.status === 'running' || x.status === 'waiting-approval');
  const minutes = runningTask?.startedAt ? Math.floor((now - Date.parse(runningTask.startedAt)) / 60000) : 0;

  return (
    <footer className="wb-statusbar" aria-label={t('wb.status')}>
      {workspace?.ok && (
        <span title={workspace.dir}>
          <BranchIcon /> {workspace.branch ? `${workspace.name} · ${workspace.branch}` : workspace.name}
        </span>
      )}
      {runningSession && runningTask ? (
        <button type="button" className="wb-status-btn" onClick={() => onShowThread(runningSession.id)} title={t('wb.openRunning')}>
          <span className={runningSession.paused ? 'wb-live paused' : 'wb-live'} aria-hidden="true" /> {t('wb.runningLine', { session: runningSession.name.replace(/^chat: /, ''), task: runningTask.title, n: runningTask.iterations, max: limits.iterations, m: minutes, maxm: limits.minutes })}
          {runningSession.paused && <strong className="wb-paused"> · {t('wb.pausedTag')}</strong>}
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
