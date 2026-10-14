'use client';

/**
 * A session in the workbench's editor: run it or stop it, its tasks at a glance, and where its work is. Every
 * setting stays on its own page, one click away; this is where the work is driven from.
 */
import { useState } from 'react';
import Link from 'next/link';
import { api, sessionHref, type Session } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { confirmDialog } from '../dialog';
import { openStartDialog } from '../startDialog';
import { useUnattendedWithoutAsking } from '../../lib/useUnattendedWithoutAsking';
import { StatusMark, type Tab } from './workbench';

export function SessionView({ session, onOpen, onChange }: { session: Session & { running?: boolean }; onOpen: (tab: Tab) => void; onChange: () => void }) {
  const { t } = useT();
  const quietStart = useUnattendedWithoutAsking();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const queued = session.tasks.filter((x) => x.status === 'queued').length;
  const done = session.tasks.filter((x) => x.status === 'done').length;
  const idle = session.status === 'idle';

  const start = async (mode: 'confirm' | 'unattended') => {
    if (mode === 'unattended' && !quietStart && !(await confirmDialog(t('session.unattendedConfirm')))) return;
    setBusy(true);
    setMsg('');
    try {
      const r = await openStartDialog({ sessionIds: [session.id], mode, start: (starts) => api.start(session.id, mode, session.planName, starts) });
      if (r.started) setMsg(t(mode === 'unattended' ? 'session.startedAuto' : 'session.startedStep'));
      else if (r.reply) setMsg(t('session.notStarted', { reason: r.reply.reason ?? '' }));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      onChange();
    }
  };

  const stop = () => api.stop(session.id).then(() => setMsg(t('wb.stopping'))).catch((e: unknown) => setMsg((e as Error).message)).finally(onChange);

  return (
    <article className="wb-task" aria-labelledby={`wb-s-${session.id}`}>
      <header className="wb-task-head">
        <span className="wb-ico" aria-hidden="true">▤</span>
        <div className="grow">
          <h2 id={`wb-s-${session.id}`}>{session.name}</h2>
          <p className="muted small">
            {t('wb.sessionLine', { done, all: session.tasks.length, queued })}
            {session.vcs?.enabled ? ` · ${session.vcs.branchMode === 'per-task' ? t('wb.perTask') : t('wb.perSession')}` : ` · ${t('wb.noVcs')}`}
            {session.modelInUse || session.model ? ` · ${session.modelInUse ?? session.model}` : ''}
          </p>
        </div>
        <Link className="button-link plain small" href={sessionHref(session.id)}>{t('wb.sessionSettings')}</Link>
      </header>
      <div className="wb-actions" role="toolbar" aria-label={t('wb.waysOn')}>
        {idle ? (
          <>
            <button type="button" className="primary" disabled={busy || queued === 0} onClick={() => void start('unattended')}>{t('session.run', { n: queued })}</button>
            <button type="button" disabled={busy || queued === 0} onClick={() => void start('confirm')}>{t('session.runStep')}</button>
          </>
        ) : (
          <button type="button" className="danger" disabled={busy} onClick={() => void stop()}>{t('wb.stopSession')}</button>
        )}
        <Link className="button-link" href={sessionHref(session.id, 'new-task')}>{t('wb.addTask')}</Link>
      </div>
      {queued === 0 && idle && <p className="muted small">{t('wb.nothingQueued')}</p>}
      {msg && <p className="notice small" role="status">{msg}</p>}
      <ol className="wb-list wb-session-tasks">
        {session.tasks.map((x) => (
          <li key={x.id}>
            <button type="button" className="linkish" onClick={() => onOpen({ kind: 'task', sessionId: session.id, taskId: x.id })}>
              <StatusMark status={x.status} /> {x.title}
            </button>
            {x.reason && x.status !== 'done' && x.status !== 'queued' ? <span className="muted small"> — {x.reason.slice(0, 160)}</span> : null}
          </li>
        ))}
      </ol>
    </article>
  );
}
