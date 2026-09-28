'use client';

/**
 * The steps waiting for the operator, on every page, right under the navigation.
 *
 * A step that waits for a decision used to be shown on the Sessions page and on its own session's
 * page, and nowhere else. An operator reading the history, editing Settings or on the import page
 * saw nothing, and the run simply looked stuck — for a download held for approval in an unattended
 * run, all night. So the question is asked wherever the operator is: this sits in the layout, below
 * the navigation, sticks to the top of the window while the page scrolls, and says in the tab's
 * title that something is waiting, for an operator looking at another window altogether.
 *
 * It polls, like the rest of the interface: every two seconds, which is what a person answering a
 * question notices as "at once".
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, sessionHref, type Approval } from '../lib/api';
import { useT, useFmtTime } from '../lib/i18n';
import { confirmDialog } from './dialog';

const EVERY_MS = 2_000;

export function GlobalApprovals() {
  const { t } = useT();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const waiting = await api.approvals();
      setApprovals(waiting);
      // Session names only when there is something to name, so an idle interface asks for one list.
      if (waiting.some((a) => !names[a.sessionId])) {
        const sessions = await api.sessions().catch(() => []);
        setNames(Object.fromEntries(sessions.map((s) => [s.id, s.name])));
      }
    } catch {
      /* the API is down or the key is missing; the pages say which */
    }
  }, [names]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), EVERY_MS);
    return () => clearInterval(timer);
  }, [load]);

  // The tab says so too, for an operator whose attention is in another window.
  useEffect(() => {
    const base = 'copilot-operator';
    document.title = approvals.length > 0 ? `(${approvals.length}) ${t('approval.tabTitle')} — ${base}` : base;
  }, [approvals.length, t]);

  if (approvals.length === 0) return null;

  return (
    <section className="approval-banner" role="alert" aria-live="assertive">
      <h2>{t('approval.waitingHere')}</h2>
      <p className="small">{t('approval.waitingHereWhy')}</p>
      {approvals.map((a) => (
        <ApprovalCard key={a.id} approval={a} sessionName={names[a.sessionId] ?? a.sessionId} onDecided={() => void load()} />
      ))}
    </section>
  );
}

/**
 * One waiting step: the command in full, which session is asking, and the four answers. The session's
 * name is on every card because, in a run of several, which session is asking is half the question.
 */
function ApprovalCard({ approval, sessionName, onDecided }: { approval: Approval; sessionName: string; onDecided: () => void }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const [busy, setBusy] = useState(false);

  const decide = async (action: 'run' | 'skip' | 'abort' | 'run-all') => {
    if (action === 'run-all' && !(await confirmDialog(t('approval.runAllConfirm')))) return;
    setBusy(true);
    try {
      await api.decide(approval.id, action);
    } finally {
      setBusy(false);
      onDecided();
    }
  };

  return (
    <div className="approval">
      <div className="row">
        <strong>{t('approval.title', { n: approval.stepId })}</strong>
        <Link href={sessionHref(approval.sessionId)}>{sessionName}</Link>
        <span className="muted small">{fmtTime(approval.createdAt)}</span>
      </div>
      <pre style={{ margin: '8px 0' }}>{approval.description}</pre>
      {approval.network && <p className="reason small">{t('approval.network')}</p>}
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void decide('run')}>
          {t('approval.run')}
        </button>
        {!approval.network && (
          <button disabled={busy} onClick={() => void decide('run-all')} title={t('approval.runAllWhy')}>
            {t('approval.runAll')}
          </button>
        )}
        <button disabled={busy} onClick={() => void decide('skip')}>
          {t('approval.skip')}
        </button>
        <button className="danger" disabled={busy} onClick={() => void decide('abort')}>
          {t('approval.abort')}
        </button>
      </div>
    </div>
  );
}
