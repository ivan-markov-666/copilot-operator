'use client';

/**
 * Writing to one task, in its tab (2026-10-14; moved here from the right panel on 2026-10-17, when that became the
 * workbench's own chat). What the box does follows the task: queued or working — a note the chat gets with its
 * next message; failed, blocked or stopped — the prompt it carries on with, from where it got to, in its own chat;
 * done — a new prompt that builds on it. The button says which. Whatever queues the task offers to run it.
 */
import { useEffect, useRef, useState } from 'react';
import { api, canFollowUp, isContinuable, type Session, type Task } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { RunQueuedPanel } from '../runQueued';

type Mode = 'note' | 'continue' | 'newPrompt' | 'none';

export function modeOf(task: Task, sessionIdle: boolean): Mode {
  if (task.status === 'queued' || task.status === 'running' || task.status === 'waiting-approval') return 'note';
  if (!sessionIdle) return 'none';
  if (task.stopCode === 'contract-conflict') return 'none';
  if (isContinuable(task) || canFollowUp(task)) return 'continue';
  if (task.status === 'done') return 'newPrompt';
  return 'none';
}

export function TaskComposer({ session, task, focusAsk, onChange }: { session: Session; task: Task; focusAsk: number; onChange: () => void }) {
  const { t } = useT();
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [offerRun, setOfferRun] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const idle = session.status === 'idle';
  const mode = modeOf(task, idle);
  const live = task.status === 'running' || task.status === 'waiting-approval';

  useEffect(() => {
    setMsg('');
    setOfferRun(false);
    setText('');
  }, [task.id]);
  useEffect(() => {
    if (focusAsk > 0) {
      box.current?.focus();
      box.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [focusAsk]);

  const send = async () => {
    if (!text.trim() || busy || mode === 'none') return;
    setBusy(true);
    setMsg('');
    try {
      if (mode === 'note') {
        await api.addTaskNote(session.id, task.id, text);
        setMsg(live ? t('wb.noteSentSoon') : t('wb.noteKept'));
      } else if (mode === 'continue') {
        await api.continueTask(session.id, task.id, text);
        setMsg(t('wb.queuedToContinue'));
        setOfferRun(true);
      } else {
        await api.rerunTask(session.id, task.id, { prompt: text }, { buildOnFinished: true });
        setMsg(t('wb.queuedNewPrompt'));
        setOfferRun(true);
      }
      setText('');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
      onChange();
    }
  };

  const button = mode === 'note' ? t('wb.sendNote') : mode === 'continue' ? t('wb.sendContinue') : mode === 'newPrompt' ? t('wb.sendNewPrompt') : t('wb.sendNone');
  const hint = mode === 'note' ? (live ? t('wb.hintNoteLive') : t('wb.hintNoteQueued')) : mode === 'continue' ? t('wb.hintContinue') : mode === 'newPrompt' ? t('wb.hintNewPrompt') : idle ? t('wb.hintNone') : t('wb.hintBusy');

  return (
    <div className="wb-compose wb-task-compose">
      {offerRun && task.status === 'queued' && (
        <div className="wb-inline-panel">
          <RunQueuedPanel target={{ sessionId: session.id, taskId: task.id, title: task.title }} onClose={(started) => { setOfferRun(false); if (started) setMsg(t('wb.started')); onChange(); }} />
        </div>
      )}
      {msg && <p className="small" role="status">{msg}</p>}
      <label htmlFor="wb-compose" className="sr-only">{button}</label>
      <textarea
        id="wb-compose"
        ref={box}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ctrl+Enter"
        disabled={mode === 'none' || busy}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="row">
        <span className="muted small grow">{hint}</span>
        <button type="button" className="primary" disabled={mode === 'none' || busy || !text.trim()} onClick={() => void send()} title="Ctrl+Enter">
          {button}
        </button>
      </div>
    </div>
  );
}
