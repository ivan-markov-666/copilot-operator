'use client';

/**
 * A task in the workbench's editor: how it stands, every way on from there, and what it did.
 *
 * The ways on are the point (operator's request, 2026-10-14: "the user must never reach a dead end"). Every state
 * offers what can be done next — a queued task runs; a running one is written to or stopped; one that stopped at a
 * limit carries on; one that failed carries on with a new prompt, runs again, is accepted as done, or is undone;
 * a done one gets a new prompt that builds on it, runs again, or is undone — and Kerrigan can be asked about any of
 * them. Whatever queues the task offers to run it right there.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, canFollowUp, isContinuable, sessionHref, type RestartPlan, type Session, type Task, type UndoThisPreview } from '../../lib/api';
import { useT, useFmtTime } from '../../lib/i18n';
import { confirmDialog } from '../dialog';
import { ChangesButton } from '../diffView';
import { RunQueuedPanel } from '../runQueued';
import { RichText } from '../richText';
import { PlanView } from '../planView';
import { StatusMark } from './workbench';
import { TaskComposer } from './taskComposer';
import { TaskStory } from '../taskStory';

export function TaskView({
  session,
  task,
  onChange,
  onKerrigan,
  onOpenFile,
}: {
  session: Session;
  task: Task;
  onChange: () => void;
  onKerrigan: () => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useT();
  const fmt = useFmtTime();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [runPanel, setRunPanel] = useState(false);
  const [undo, setUndo] = useState(false);
  /** Asks this tab's own writing box for the keyboard. */
  const [composeAsk, setComposeAsk] = useState(0);
  const onCompose = () => setComposeAsk((x) => x + 1);
  const n = session.tasks.findIndex((x) => x.id === task.id) + 1;
  const running = task.status === 'running' || task.status === 'waiting-approval';
  const sessionBusy = session.status !== 'idle';
  const continuable = isContinuable(task);
  const followable = canFollowUp(task) && !continuable;
  const conflict = task.stopCode === 'contract-conflict';
  const ran = !!task.startedAt;
  const undone = task.attempts?.at(-1)?.undone;
  const plan = task.plan ?? (task.continuing ? [...(task.attempts ?? [])].reverse().find((a) => a.plan?.approved)?.plan : undefined);

  useEffect(() => {
    setMsg('');
    setRunPanel(false);
    setUndo(false);
    setAcceptOpen(false);
    setAcceptNote('');
  }, [task.id]);

  const act = async (fn: () => Promise<unknown>, after?: string, offerRun = false) => {
    if (busy) return;
    setBusy(true);
    setMsg('');
    try {
      await fn();
      if (after) setMsg(after);
      if (offerRun) setRunPanel(true);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      onChange();
    }
  };

  const remove = async () => {
    if (await confirmDialog(t('wb.removeConfirm', { title: task.title }))) await act(() => api.deleteTask(session.id, task.id), t('wb.removed'));
  };
  const stopNow = () => act(() => api.stop(session.id), t('wb.stopping'));
  const carryOn = () => act(() => api.continueTask(session.id, task.id), t('wb.queuedToContinue'), true);
  const runAgain = async () => {
    if (await confirmDialog(t('wb.runAgainConfirm', { title: task.title }))) await act(() => api.rerunTask(session.id, task.id), t('wb.queuedAgain'), true);
  };
  const acceptNow = () => act(() => api.acceptTask(session.id, task.id, acceptNote), t('wb.accepted')).then(() => setAcceptOpen(false));
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [acceptNote, setAcceptNote] = useState('');

  return (
    <article className="wb-task" aria-labelledby={`wb-task-${task.id}`}>
      <header className="wb-task-head">
        <StatusMark status={task.status} />
        <div className="grow">
          <h2 id={`wb-task-${task.id}`}>{task.title}</h2>
          <p className="muted small">
            {t('wb.taskOf', { n, session: session.name, status: t(`status.${task.status}` as 'status.done') })}
            {(task.attempt ?? 1) > 1 ? ` · ${t('wb.attempt', { n: task.attempt ?? 1 })}` : ''}
            {task.vcs?.branch ? ` · ${task.vcs.branch}${task.vcs.commit ? ` @ ${task.vcs.commit.slice(0, 8)}` : ''}` : ''}
          </p>
        </div>
        <Link className="button-link plain small" href={sessionHref(session.id, task.id)}>{t('wb.onSessionPage')}</Link>
      </header>

      {/* What can be done from here: never nothing. */}
      <div className="wb-actions" role="toolbar" aria-label={t('wb.waysOn')}>
        {task.status === 'queued' && (
          <>
            <button type="button" className="primary" disabled={busy || sessionBusy} onClick={() => setRunPanel(true)}>{t('wb.runThis')}</button>
            <button type="button" onClick={onCompose}>{t('wb.addNote')}</button>
            <Link className="button-link" href={sessionHref(session.id, task.id)}>{t('wb.editTask')}</Link>
            <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
              {t('wb.remove')}
            </button>
          </>
        )}
        {running && (
          <>
            <button type="button" className="primary" onClick={onCompose}>{t('wb.writeToChat')}</button>
            <button type="button" className="danger" disabled={busy} onClick={() => void stopNow()}>{t('wb.stopSession')}</button>
          </>
        )}
        {conflict && (
          <Link className="button-link primary" href={sessionHref(session.id, task.id)}>{t('wb.fixContradiction')}</Link>
        )}
        {continuable && !running && (
          <button type="button" className="primary" disabled={busy || sessionBusy} onClick={() => void carryOn()}>
            {t('wb.continue')}
          </button>
        )}
        {(followable || continuable) && !conflict && !running && (
          <button type="button" className={followable ? 'primary' : ''} disabled={sessionBusy} onClick={onCompose}>{t('wb.continueWithPrompt')}</button>
        )}
        {task.status === 'done' && (
          <button type="button" className="primary" disabled={sessionBusy} onClick={onCompose}>{t('wb.newPrompt')}</button>
        )}
        {ran && !running && task.status !== 'queued' && (
          <button type="button" disabled={busy || sessionBusy} onClick={() => void runAgain()}>
            {t('wb.runAgain')}
          </button>
        )}
        {['failed', 'blocked', 'limit-reached', 'aborted'].includes(task.status) && (
          <button type="button" aria-expanded={acceptOpen} disabled={busy || sessionBusy} onClick={() => setAcceptOpen((o) => !o)}>{t('wb.accept')}</button>
        )}
        {ran && !running && task.status !== 'queued' && (
          <button type="button" aria-expanded={undo} disabled={sessionBusy} onClick={() => setUndo((u) => !u)}>{t('wb.undo')}</button>
        )}
        {(task.vcs?.files?.length ?? 0) > 0 && <ChangesButton sessionId={session.id} taskId={task.id} runId={task.runId} title={task.title} files={task.vcs?.files?.length ?? 0} />}
        <button type="button" onClick={onKerrigan}>{t('wb.askKerrigan')}</button>
      </div>
      {msg && <p className="notice small" role="status">{msg}</p>}
      {sessionBusy && !running && <p className="muted small">{t('wb.sessionBusy')}</p>}

      {/* Writing to this task: a note, the prompt it carries on with, or a new one, by its state. */}
      <TaskComposer session={session} task={task} focusAsk={composeAsk} onChange={onChange} />
      {acceptOpen && (
        <div className="wb-inline-panel" role="group" aria-label={t('wb.accept')}>
          <label htmlFor={`wb-accept-${task.id}`}>{t('wb.acceptNote')}</label>
          <textarea id={`wb-accept-${task.id}`} value={acceptNote} onChange={(e) => setAcceptNote(e.target.value)} style={{ minHeight: 60 }} />
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => void acceptNow()}>
              {t('wb.acceptGo')}
            </button>
            <button type="button" className="quiet" onClick={() => setAcceptOpen(false)}>{t('dialog.cancel')}</button>
          </div>
        </div>
      )}
      {undo && <UndoPanel session={session} task={task} onDone={(text) => { setUndo(false); setMsg(text); setRunPanel(true); onChange(); }} />}
      {runPanel && task.status === 'queued' && (
        <div className="wb-inline-panel">
          <RunQueuedPanel target={{ sessionId: session.id, taskId: task.id, title: task.title }} intro={msg || undefined} onClose={(started) => { setRunPanel(false); if (started) setMsg(t('wb.started')); onChange(); }} />
        </div>
      )}

      {/* How it stands. */}
      <section className="wb-sec">
        <h3>{t('wb.result')}</h3>
        {task.accepted && <p className="notice calm small">{t('wb.acceptedWas', { was: t(`status.${task.accepted.was}` as 'status.done'), at: fmt(task.accepted.at) })}{task.accepted.note ? ` ${task.accepted.note}` : ''}</p>}
        {task.status === 'queued' && undone && <p className="notice calm small">{undone.how === 'this' ? t('wb.undoneThis', { commit: undone.commit?.slice(0, 8) ?? '—' }) : t('wb.undoneBack')}</p>}
        {task.continuing?.instruction && task.status !== 'done' && <p className="small"><strong>{t('task.continuedWith', { n: task.continuing.fromAttempt })}</strong> {task.continuing.instruction}</p>}
        {task.summary ? <RichText text={task.summary} /> : task.status === 'queued' ? <p className="muted small">{t('wb.notRunYet')}</p> : null}
        {task.reason && task.reason !== task.summary && task.status !== 'done' && <p className="reason small">{task.reason}</p>}
      </section>

      <details className="wb-sec" open={task.status === 'queued'}>
        <summary>{t('wb.prompt')}</summary>
        <RichText text={task.prompt} />
      </details>

      {plan && (
        <details className="wb-sec">
          <summary>{t('wb.plan', { n: plan.version })}</summary>
          <PlanView plan={plan} />
        </details>
      )}

      {(task.checkResults?.length ?? 0) > 0 && (
        <section className="wb-sec">
          <h3>{t('wb.checks')}</h3>
          <ul className="wb-list">
            {task.checkResults!.map((c) => (
              <li key={c.name} className={c.passed ? 'ok' : 'bad'}>
                <span aria-hidden="true">{c.passed ? '✓' : '✗'}</span> <strong>{c.name}</strong> <span className="muted small">{c.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {task.review && (
        <section className="wb-sec">
          <h3>{t('wb.review', { verdict: task.review.verdict })}</h3>
          {task.review.summary && <p className="small">{task.review.summary}</p>}
          {(task.review.findings?.length ?? 0) > 0 && (
            <ul className="wb-list">
              {task.review.findings!.map((f, i) => (
                <li key={f.id ?? i} className="bad small">
                  {f.id && <code>{f.id}</code>} {f.what}
                  {f.where ? <span className="muted"> — {f.where}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {(task.vcs?.files?.length ?? 0) > 0 && (
        <section className="wb-sec">
          <h3>{t('wb.changedFiles', { n: task.vcs!.files!.length })}</h3>
          <ul className="wb-list">
            {task.vcs!.files!.map((f) => (
              <li key={f.path}>
                <button type="button" className="linkish" onClick={() => onOpenFile(f.path)}>{f.path}</button>{' '}
                <span className="muted small">{f.added >= 0 ? `+${f.added} −${f.removed}` : t('wb.binary')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(task.notes?.length ?? 0) > 0 && (
        <section className="wb-sec">
          <h3>{t('wb.notes')}</h3>
          <ul className="wb-list">
            {task.notes!.map((x) => (
              <li key={x.id} className="small">
                {x.text} <span className="muted">— {x.sentAt ? t('wb.noteSent', { at: fmt(x.sentAt) }) : t('wb.noteWaiting')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(task.startedAt || running) && (
        <details className="wb-sec" open={running}>
          <summary>{t('wb.conversation')}</summary>
          <TaskStory key={`${task.id}:${task.runId ?? ''}`} sessionId={session.id} taskId={task.id} runId={task.runId} live={running} />
        </details>
      )}

      {(task.attempts?.length ?? 0) > 0 && (
        <details className="wb-sec">
          <summary>{t('wb.attempts', { n: task.attempts!.length })}</summary>
          <ol className="wb-list">
            {task.attempts!.map((a, i) => (
              <li key={i} className="small">
                <StatusMark status={a.status as Task['status']} /> {t('wb.attemptLine', { n: i + 1, status: t(`status.${a.status}` as 'status.done') })}
                {a.undone ? ` · ${a.undone.how === 'this' ? t('wb.undoneShortThis') : t('wb.undoneShortBack')}` : ''}
                {a.reason ? <span className="muted"> — {a.reason.slice(0, 200)}</span> : null}
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

/**
 * Undo, both ways, each said before it is done (2026-10-14): only this task's work taken out of the session's
 * branch, the tasks after it kept; or the branch back to before it, it and the tasks after it queued again.
 */
function UndoPanel({ session, task, onDone }: { session: Session; task: Task; onDone: (text: string) => void }) {
  const { t } = useT();
  const [preview, setPreview] = useState<{ this: UndoThisPreview; back: RestartPlan; problem?: string } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.undoPreview(session.id, task.id).then(setPreview).catch((e: unknown) => setErr((e as Error).message));
  }, [session.id, task.id]);
  const go = async (how: 'this' | 'back') => {
    if (!(await confirmDialog(how === 'this' ? t('wb.undoThisConfirm', { title: task.title }) : t('wb.undoBackConfirm', { title: task.title })))) return;
    setBusy(true);
    try {
      const r = await api.undoTask(session.id, task.id, how);
      onDone(r.message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (err && !preview) return <p className="err small">{err}</p>;
  if (!preview) return <p className="muted small">{t('wb.loading')}</p>;
  const own = preview.this;
  const back = preview.back;
  return (
    <div className="wb-inline-panel" role="group" aria-label={t('wb.undo')}>
      <div className="option">
        <strong>{t('wb.undoThis')}</strong>
        <p className="small">
          {!own.ok
            ? own.problem
            : own.nothing
              ? own.nothing
              : own.perTask
                ? t('wb.undoThisPerTask', { base: (own.baseCommit ?? '').slice(0, 8), branch: own.branch ?? '—' })
                : t('wb.undoThisWhat', { n: own.commits.length, branch: own.branch ?? '', later: own.later.length })}
        </p>
        <button type="button" className="primary" disabled={busy || !own.ok} onClick={() => void go('this')}>{t('wb.undoThisGo')}</button>
      </div>
      <div className="option">
        <strong>{t('wb.undoBack')}</strong>
        <p className="small">{!back.ok ? back.problem : t('wb.undoBackWhat', { tasks: back.tasks.map((x) => `“${x.title}”`).join(', ') })}</p>
        <button type="button" disabled={busy || !back.ok} onClick={() => void go('back')}>{t('wb.undoBackGo')}</button>
      </div>
      {err && <p className="err small">{err}</p>}
      <p className="muted small">{t('wb.undoKept')}</p>
    </div>
  );
}
