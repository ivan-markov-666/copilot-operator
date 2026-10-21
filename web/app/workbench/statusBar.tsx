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
import { workedMs } from '../../lib/paused';
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

  // The lead's conversation rather than its worker's, which is hidden from the list and works for it.
  const runningSession = sessions.find((s) => s.status !== 'idle' && !s.workerOf) ?? sessions.find((s) => s.status !== 'idle');
  const runningTask = runningSession?.tasks.find((x) => x.status === 'running' || x.status === 'waiting-approval');
  // Its pauses not counted: the minutes stand still while it is paused, as its limit does (2026-10-21).
  const minutes = Math.floor(workedMs(runningTask?.startedAt, runningSession?.pauses, now) / 60000);

  return (
    <footer className="wb-statusbar" aria-label={t('wb.status')}>
      {workspace?.ok && (
        <span title={workspace.dir}>
          <BranchIcon /> {workspace.branch ? `${workspace.name} · ${workspace.branch}` : workspace.name}
        </span>
      )}
      {runningSession && runningTask ? (
        <button type="button" className="wb-status-btn" onClick={() => onShowThread(runningSession.id)} title={t('wb.openRunning')}>
          <span className={runningSession.paused ? 'wb-live paused' : 'wb-live'} aria-hidden="true" />{' '}
          {runningTask.lead
            ? // Two chats (2026-10-21): the lead's messages, the worker's, and the two together.
              t('wb.runningLineTwo', {
                session: runningSession.name.replace(/^chat: /, ''),
                task: runningTask.title,
                lead: runningTask.lead.messages?.lead ?? 0,
                worker: runningTask.lead.messages?.worker ?? 0,
                total: (runningTask.lead.messages?.lead ?? 0) + (runningTask.lead.messages?.worker ?? 0),
                m: minutes,
                maxm: limits.minutes,
              })
            : t('wb.runningLine', { session: runningSession.name.replace(/^chat: /, ''), task: runningTask.title, n: runningTask.iterations, max: limits.iterations, m: minutes, maxm: limits.minutes })}
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
