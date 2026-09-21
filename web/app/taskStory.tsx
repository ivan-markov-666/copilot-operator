'use client';

/**
 * What happened in a task, as it happens and afterwards.
 *
 * The task text and the ending are always shown: those are the question and the answer.
 * Between them is the whole exchange — every message sent, every reply, every command with
 * its output, every review round — which is more than anyone wants at once, so two switches
 * choose: the conversation (what was sent and answered) and the commands (what ran and what
 * came back). While the task is live the story is re-read every few seconds, so the newest
 * reply and the command running now appear as they happen; when it ends, the ending is added
 * and the reading stops. A failed step, a failing check and a non-done ending are marked, so
 * the eye goes to where it broke.
 */

import { useEffect, useState } from 'react';
import { api, fmtDuration, type Story, type StoryEntry } from '../lib/api';
import { useT } from '../lib/i18n';
import { RichText } from './richText';

const POLL_MS = 4000;

export function TaskStory({ sessionId, taskId, runId, live }: { sessionId: string; taskId: string; runId?: string; live: boolean }) {
  const { t } = useT();
  const [story, setStory] = useState<Story | null>(null);
  const [err, setErr] = useState('');
  const [showChat, setShowChat] = useState(true);
  const [showCommands, setShowCommands] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const s = await api.taskStory(sessionId, taskId, runId);
        if (!alive) return;
        setStory(s);
        setErr('');
        if (s.live) timer = setTimeout(read, POLL_MS);
      } catch (e) {
        if (!alive) return;
        setErr((e as Error).message);
        if (live) timer = setTimeout(read, POLL_MS);
      }
    };
    void read();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, taskId, runId, live]);

  if (err && !story) return <div className="err small">{err}</div>;
  if (!story) return <div className="muted small">{t('story.loading')}</div>;

  const flip = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const shown = (e: StoryEntry): boolean =>
    e.kind === 'review' ? showChat || showCommands : e.kind === 'step' ? showCommands : showChat;

  const renderEntry = (e: StoryEntry, key: string): React.ReactNode => {
    if (!shown(e)) return null;
    if (e.kind === 'review') {
      return (
        <li key={key} className="story-review">
          <div className="story-head">
            <span className="chip">{t('story.review', { n: e.round })}</span>
          </div>
          <ol className="story">{e.entries.map((x, i) => renderEntry(x, `${key}-${i}`))}</ol>
        </li>
      );
    }
    if (e.kind === 'step') {
      const isOpen = open.has(key);
      return (
        <li key={key} className={`story-step${e.failed ? ' failed' : ''}`}>
          <div className="story-head">
            <span className="chip">{t('story.step', { it: e.iteration, id: e.id })}</span>
            {e.outcome && (
              <span className={`badge ${e.failed ? 'failed' : 'done'}`}>
                {e.outcome}
                {e.exitCode !== undefined ? ` · exit ${e.exitCode}` : ''}
                {e.durationMs !== undefined ? ` · ${fmtDuration(e.durationMs)}` : ''}
              </span>
            )}
            {!e.outcome && <span className="badge running">{t('story.running')}</span>}
            {e.failed && <span className="badge failed">{t('story.failedHere')}</span>}
          </div>
          <pre className="story-cmd">{e.command}</pre>
          {e.output && (
            <>
              <button type="button" className="linkish small" onClick={() => flip(key)}>
                {isOpen ? t('story.hideOutput') : t('story.showOutput', { n: e.output.length })}
              </button>
              {isOpen && <pre className="story-out">{e.output}</pre>}
            </>
          )}
        </li>
      );
    }
    const isOpen = open.has(key);
    const who = e.kind === 'sent' ? t('story.bot') : t('story.chat');
    const failedReply = e.kind === 'reply' && (e.status === 'blocked' || e.status === 'failed');
    return (
      <li key={key} className={`story-msg ${e.kind}${failedReply ? ' failed' : ''}`}>
        <div className="story-head">
          <strong>{who}</strong>
          <span className="muted small">{e.label}</span>
          {e.kind === 'reply' && e.status && <span className={`badge ${failedReply ? 'failed' : e.status === 'done' ? 'done' : ''}`}>{e.status}</span>}
        </div>
        {e.kind === 'reply' && e.notes && <p className="story-notes">{e.notes}</p>}
        <button type="button" className="linkish small" onClick={() => flip(key)}>
          {isOpen ? t('story.hideText') : t('story.showText', { n: e.text.length })}
        </button>
        {isOpen && <pre className="story-out">{e.text}</pre>}
      </li>
    );
  };

  const c = story.close;
  const failed = c && c.status !== 'done';

  return (
    <div className="story-box">
      <div className="row small" style={{ marginBottom: 6 }}>
        <label className="option-inline">
          <input type="checkbox" checked={showChat} onChange={(e) => setShowChat(e.target.checked)} /> {t('story.showChat')}
        </label>
        <label className="option-inline">
          <input type="checkbox" checked={showCommands} onChange={(e) => setShowCommands(e.target.checked)} /> {t('story.showCommands')}
        </label>
        {story.live && (
          <span className="live">
            <span className="dot" aria-hidden="true" /> {t('story.live')}
          </span>
        )}
        {err && <span className="err">{err}</span>}
      </div>

      <div className="story-fixed">
        <strong>{t('story.prompt')}</strong>
        <pre className="story-out always">{story.prompt}</pre>
      </div>

      <ol className="story">{story.entries.map((e, i) => renderEntry(e, `e${i}`))}</ol>

      {c ? (
        <div className={`story-fixed close${failed ? ' failed' : ''}`}>
          <strong>{failed ? t('story.endedBadly', { status: c.status }) : t('story.ended')}</strong>
          {c.reason && <p className="err small">{c.reason}</p>}
          {c.summary && <RichText text={c.summary} className="what" />}
          {c.checks && c.checks.length > 0 && (
            <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {c.checks.map((k, i) => (
                <li key={i} className={k.passed ? '' : 'err'}>
                  {k.passed ? '✓' : '✗'} {k.name}
                  {!k.passed && k.detail ? ` — ${k.detail}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="story-fixed muted small">{t('story.notEnded')}</div>
      )}
    </div>
  );
}
