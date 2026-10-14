'use client';

/**
 * The panel on the workbench's right: the chosen task's conversation as it happens, and a box to write to it —
 * or Kerrigan, to ask how to go on.
 *
 * What the box does follows the task (2026-10-14): queued or working, what is written is a note the chat gets with
 * its next message; failed, blocked or stopped, it is the prompt the task carries on with, from where it got to,
 * in its own chat; done, it is a new prompt that builds on what it did. The button says which, before it is
 * pressed. Ctrl+Enter sends; Ctrl+L brings the keyboard here from anywhere.
 */
import { useEffect, useRef, useState } from 'react';
import { api, canFollowUp, isContinuable, type Session, type Task } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { TaskStory } from '../taskStory';
import { RunQueuedPanel } from '../runQueued';
import { Kerrigan } from './kerrigan';
import type { ChatTab } from './workbench';

type Mode = 'note' | 'continue' | 'newPrompt' | 'none';

function modeOf(task: Task | undefined, sessionIdle: boolean): Mode {
  if (!task) return 'none';
  if (task.status === 'queued' || task.status === 'running' || task.status === 'waiting-approval') return 'note';
  if (!sessionIdle) return 'none';
  if (task.stopCode === 'contract-conflict') return 'none';
  if (isContinuable(task) || canFollowUp(task)) return 'continue';
  if (task.status === 'done') return 'newPrompt';
  return 'none';
}

export function ChatPanel({
  tab,
  onTab,
  session,
  task,
  sessions,
  composeAsk,
  onChange,
  onClose,
}: {
  tab: ChatTab;
  onTab: (t: ChatTab) => void;
  session?: Session;
  task?: Task;
  sessions: Session[];
  composeAsk: number;
  onChange: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <div className="wb-chat-inner">
      <div className="wb-chat-tabs" role="tablist" aria-label={t('wb.chatPanel')}>
        <button type="button" role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => onTab('chat')}>{t('wb.chatTab')}</button>
        <button type="button" role="tab" aria-selected={tab === 'kerrigan'} className={tab === 'kerrigan' ? 'on' : ''} onClick={() => onTab('kerrigan')}>{t('wb.kerriganTab')}</button>
        <span className="grow" />
        <button type="button" className="wb-icon-btn" aria-label={t('wb.toggleChat')} title={t('wb.toggleChat')} onClick={onClose}>×</button>
      </div>
      {tab === 'kerrigan' ? <Kerrigan session={session} task={task} sessions={sessions} onChange={onChange} /> : <Chat session={session} task={task} composeAsk={composeAsk} onChange={onChange} />}
    </div>
  );
}

function Chat({ session, task, composeAsk, onChange }: { session?: Session; task?: Task; composeAsk: number; onChange: () => void }) {
  const { t } = useT();
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [offerRun, setOfferRun] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const idle = session?.status === 'idle';
  const mode = modeOf(task, !!idle);
  const live = task?.status === 'running' || task?.status === 'waiting-approval';

  useEffect(() => {
    setMsg('');
    setOfferRun(false);
  }, [task?.id]);
  useEffect(() => {
    if (composeAsk > 0) box.current?.focus();
  }, [composeAsk]);

  const send = async () => {
    if (!session || !task || !text.trim() || busy || mode === 'none') return;
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

  if (!session || !task) {
    return (
      <div className="wb-chat-empty">
        <p className="muted">{t('wb.chatEmpty')}</p>
      </div>
    );
  }
  const button = mode === 'note' ? t('wb.sendNote') : mode === 'continue' ? t('wb.sendContinue') : mode === 'newPrompt' ? t('wb.sendNewPrompt') : t('wb.sendNone');
  const hint = mode === 'note' ? (live ? t('wb.hintNoteLive') : t('wb.hintNoteQueued')) : mode === 'continue' ? t('wb.hintContinue') : mode === 'newPrompt' ? t('wb.hintNewPrompt') : idle ? t('wb.hintNone') : t('wb.hintBusy');

  return (
    <>
      <div className="wb-chat-head">
        <strong className="wb-row-name">{task.title}</strong>
        <span className="muted small">{session.name}</span>
      </div>
      <div className="wb-chat-story">
        {task.startedAt || live ? <TaskStory key={`${task.id}:${task.runId ?? ''}`} sessionId={session.id} taskId={task.id} runId={task.runId} live={live} /> : <p className="muted small">{t('wb.notRunYet')}</p>}
      </div>
      <div className="wb-compose">
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
    </>
  );
}
