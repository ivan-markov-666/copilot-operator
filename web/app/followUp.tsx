'use client';

/**
 * "Continue with a new prompt": a task that failed is carried on from where it got to, with what the
 * operator says to do now (2026-10-13).
 *
 * The operator asked how the work goes on after a task fails: a new prompt that continues it. There
 * were two ways back and neither was that — "Fix the prompt" started the task over from where it first
 * began, the failed attempt's work set aside on its branch; "Give it a new prompt" built on the work,
 * but only of a task that ended done. Here the failed attempt's work stays in the tree, the task goes
 * back to its own chat and branch (as "Continue" after a limit does), and the chat is told how the
 * attempt ended and why — the runner's reason, the checks that did not pass, what the review found —
 * and then given the prompt. The prompt is added to the task's own, not put in its place: the
 * assignment, its checks and its expected result stand (see `TaskContinuation.instruction`).
 *
 * Shared by the register's row and the session page's task card. After saving, the run is offered in
 * the same dialog, as every way back into the queue does.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { api, type Task } from '../lib/api';
import { useT, type Key } from '../lib/i18n';
import { useModalFocus } from '../lib/useModalFocus';
import { RunQueuedPanel } from './runQueued';

export function FollowUpDialog({
  sessionId,
  taskId,
  title,
  onClose,
}: {
  sessionId: string;
  taskId: string;
  title: string;
  /** `changed`: the task was queued again. */
  onClose: (changed: boolean) => void;
}) {
  const { t } = useT();
  const uid = useId();
  const [task, setTask] = useState<Task | null>(null);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  useModalFocus(boxRef, true, fieldRef);

  useEffect(() => {
    let live = true;
    api
      .session(sessionId)
      .then((s) => {
        if (live) setTask(s.tasks.find((x) => x.id === taskId) ?? null);
      })
      .catch((e: unknown) => {
        if (live) setMsg((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [sessionId, taskId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Not when an "are you sure" box inside it takes the key (Run without asking, in the offer to run).
      if (e.key === 'Escape' && !e.defaultPrevented && !busy && !document.querySelector('[role="alertdialog"]')) onClose(saved);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, saved, onClose]);

  const save = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setMsg('');
    try {
      await api.continueTask(sessionId, taskId, text);
      setMsg(t('fup.saved', { title }));
      setSaved(true);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const failedChecks = (task?.checkResults ?? []).filter((c) => !c.passed);
  const findings = task?.review?.verdict === 'fail' ? task.review.findings ?? [] : [];
  const branch = task?.vcs?.branch;
  const commit = task?.vcs?.commit;

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => !busy && onClose(saved)}>
      <div ref={boxRef} className="modal wide" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} onClick={(e) => e.stopPropagation()} style={{ overflowWrap: 'anywhere' }}>
        <h2 id={`${uid}-title`}>{t('fup.title', { title })}</h2>
        {saved ? (
          <RunQueuedPanel target={{ sessionId, taskId, title }} intro={`${msg} ${t('runq.ask')}`} focusFirst onClose={() => onClose(true)} />
        ) : !task ? (
          <p className="muted small">{msg || t('fup.loading')}</p>
        ) : (
          <>
            <div className="notice caution small">
              <strong>{t('fup.ended', { status: t(`status.${task.status}` as Key) })}</strong>
              {task.reason && <p style={{ margin: '4px 0' }}>{task.reason}</p>}
              {failedChecks.length > 0 && (
                <>
                  <div style={{ marginTop: 6 }}>{t('fup.failedChecks')}</div>
                  <ul style={{ margin: '2px 0', paddingLeft: 18 }}>
                    {failedChecks.slice(0, 10).map((c) => (
                      <li key={c.name}>
                        <code>{c.name}</code>: {c.detail}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {findings.length > 0 && (
                <>
                  <div style={{ marginTop: 6 }}>{t('fup.findings')}</div>
                  <ul style={{ margin: '2px 0', paddingLeft: 18 }}>
                    {findings.slice(0, 10).map((f, i) => (
                      <li key={i}>
                        {f.what}
                        {f.where ? ` (${f.where})` : ''}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {task.summary && task.summary !== task.reason && (
                <p style={{ margin: '6px 0 0' }}>
                  {t('fup.summary')} {task.summary}
                </p>
              )}
            </div>

            <ul className="small" style={{ margin: '8px 0', paddingLeft: 18 }}>
              <li>{t('fup.chat')}</li>
              <li>{branch ? (commit ? t('fup.branch', { branch, commit: commit.slice(0, 8) }) : t('fup.branchNotCommitted', { branch })) : t('fup.noVcs')}</li>
              <li>{t('fup.kept')}</li>
            </ul>

            <details className="small">
              <summary>{t('fup.original')}</summary>
              <pre className="tall">{task.prompt}</pre>
            </details>

            <label htmlFor={`${uid}-prompt`} style={{ marginTop: 10 }}>
              {t('fup.prompt')}
            </label>
            <textarea
              id={`${uid}-prompt`}
              ref={fieldRef}
              className="prose"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('fup.placeholder')}
              style={{ minHeight: 180 }}
              disabled={busy}
            />
            <p className="why">{t('fup.startOver', { fix: t('reg.fixPrompt') })}</p>

            <div className="row modal-actions">
              {msg && <span className="small grow err">{msg}</span>}
              <button type="button" className="quiet" onClick={() => onClose(false)} disabled={busy}>
                {t('dialog.cancel')}
              </button>
              <button type="button" className="primary" onClick={() => void save()} disabled={busy || !text.trim()}>
                {t('fup.save')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
