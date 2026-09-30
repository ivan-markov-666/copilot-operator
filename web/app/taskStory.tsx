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
 *
 * Watched live, it behaves like a terminal: the exchange sits in its own scrolling box that stays
 * at the newest entry, and the command running now is shown open with its output following its
 * last line — so the operator watches, and does not scroll. Scrolling up to read stops the
 * following until they come back to the end (see `useFollowBottom`).
 */

import { useEffect, useRef, useState } from 'react';
import { api, fmtDuration, type Story, type StoryEntry } from '../lib/api';
import { useT, useFmtTime } from '../lib/i18n';
import { useFollowBottom } from '../lib/useFollowBottom';
import { RichText } from './richText';

/** Re-read every two seconds while live: often enough for output to read as a stream. */
const POLL_MS = 2000;

/** A step's output that stays at its last line while it grows — only while `follow`. */
function FollowPre({ text, follow }: { text: string; follow: boolean }) {
  const { ref } = useFollowBottom<HTMLPreElement>(follow, text);
  return (
    <pre ref={ref} className={`story-out${follow ? ' terminal' : ''}`}>
      {text}
    </pre>
  );
}

export function TaskStory({ sessionId, taskId, runId, live }: { sessionId: string; taskId: string; runId?: string; live: boolean }) {
  const { t } = useT();
  const [story, setStory] = useState<Story | null>(null);
  const [err, setErr] = useState('');
  const [showChat, setShowChat] = useState(true);
  const [showCommands, setShowCommands] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  /*
   * Steps seen running, which open on their own, and the ones the operator closed anyway. A step
   * that was open while it ran stays open when it finishes, so its output does not vanish from
   * under the eye that was following it.
   */
  const [seenRunning, setSeenRunning] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const isLive = !!story?.live;
  /*
   * Pinned after every render, not only when a new story arrives: the output of a step that has
   * just started opens in the render after the one that brought it, and grows the list again —
   * pinning on the story alone left the list one opened output short of its end.
   */
  const renders = useRef(0);
  renders.current += 1;
  const scroll = useFollowBottom<HTMLDivElement>(isLive, renders.current);
  const box = useRef<HTMLDivElement | null>(null);
  const scrolledIntoView = useRef(false);

  useEffect(() => {
    if (!story) return;
    const running: string[] = [];
    const walk = (entries: StoryEntry[], prefix: string): void =>
      entries.forEach((e, i) => {
        const key = `${prefix}${i}`;
        if (e.kind === 'review') walk(e.entries, `${key}-`);
        else if (e.kind === 'step' && !e.outcome) running.push(key);
      });
    walk(story.entries, 'e');
    if (running.some((k) => !seenRunning.has(k))) setSeenRunning((prev) => new Set([...prev, ...running]));
    // Opened live, the box is brought on screen once, so there is nothing to scroll to find it.
    if (story.live && !scrolledIntoView.current && box.current) {
      scrolledIntoView.current = true;
      box.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [story, seenRunning]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const s = await api.taskStory(sessionId, taskId, runId);
        if (!alive) return;
        setStory(s);
        setErr('');
        // Either side saying "live" keeps it going. The story can say "not live" for a moment while a
        // task that is running has no run folder yet; stopping on that stopped the story for good,
        // because the page's own `live` had not changed and nothing restarted it.
        if (s.live || live) timer = setTimeout(read, POLL_MS);
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

  const isOpen = (key: string): boolean => open.has(key) || (seenRunning.has(key) && !closed.has(key));
  const flip = (key: string) => {
    const wasOpen = isOpen(key);
    setOpen((prev) => {
      const next = new Set(prev);
      if (wasOpen) next.delete(key);
      else next.add(key);
      return next;
    });
    setClosed((prev) => {
      const next = new Set(prev);
      if (wasOpen) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const shown = (e: StoryEntry): boolean =>
    e.kind === 'review' ? showChat || showCommands : e.kind === 'step' ? showCommands : showChat;

  const renderEntry = (e: StoryEntry, key: string): React.ReactNode => {
    if (!shown(e)) return null;
    if (e.kind === 'review') {
      return (
        <li key={key} className="story-review">
          <div className="story-head">
            <When at={e.at} />
            <span className="chip">{t('story.review', { n: e.round })}</span>
          </div>
          <ol className="story">{e.entries.map((x, i) => renderEntry(x, `${key}-${i}`))}</ol>
        </li>
      );
    }
    if (e.kind === 'step') {
      const stepOpen = isOpen(key);
      const running = !e.outcome && story.live;
      return (
        <li key={key} className={`story-step${e.failed ? ' failed' : ''}`}>
          <div className="story-head">
            <When at={e.at} />
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
                {stepOpen ? t('story.hideOutput') : t('story.showOutput', { n: e.output.length })}
              </button>
              {stepOpen && <FollowPre text={e.output} follow={running} />}
            </>
          )}
        </li>
      );
    }
    const textOpen = open.has(key);
    const who = e.kind === 'sent' ? t('story.bot') : t('story.chat');
    const failedReply = e.kind === 'reply' && (e.status === 'blocked' || e.status === 'failed');
    return (
      <li key={key} className={`story-msg ${e.kind}${failedReply ? ' failed' : ''}`}>
        <div className="story-head">
          <When at={e.at} />
          <strong>{who}</strong>
          <span className="muted small">{e.label}</span>
          {e.kind === 'reply' && e.status && <span className={`badge ${failedReply ? 'failed' : e.status === 'done' ? 'done' : ''}`}>{e.status}</span>}
        </div>
        {e.kind === 'reply' && e.notes && <p className="story-notes">{e.notes}</p>}
        <button type="button" className="linkish small" onClick={() => flip(key)}>
          {textOpen ? t('story.hideText') : t('story.showText', { n: e.text.length })}
        </button>
        {textOpen && <pre className="story-out">{e.text}</pre>}
      </li>
    );
  };

  const c = story.close;
  const failed = c && c.status !== 'done';

  return (
    <div className="story-box" ref={box}>
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
        {/* Scrolled up to read, the following stops; this takes it back to the newest line. */}
        {story.live && !scroll.following && (
          <button type="button" className="quiet small" onClick={scroll.follow} title={t('story.followWhy')}>
            {t('story.follow')}
          </button>
        )}
        {err && <span className="err">{err}</span>}
      </div>

      <div className="story-fixed">
        <strong>{t('story.prompt')}</strong>
        <pre className="story-out always">{story.prompt}</pre>
      </div>

      <div ref={scroll.ref} className={`story-scroll${story.live ? ' live' : ''}`}>
        <ol className="story">{story.entries.map((e, i) => renderEntry(e, `e${i}`))}</ol>
      </div>

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

/**
 * When an entry happened: the time of day, with the date in front when it was not today, and the
 * full date and time on hover. `<time>` so it is a time to a screen reader and to a copy-paste.
 */
function When({ at }: { at?: string }) {
  const fmtTime = useFmtTime();
  const { locale } = useT();
  if (!at) return null;
  const d = new Date(at);
  const tag = locale === 'bg' ? 'bg-BG' : undefined;
  const time = d.toLocaleTimeString(tag, { hour12: false });
  const today = new Date().toDateString() === d.toDateString();
  return (
    <time className="story-when" dateTime={at} title={fmtTime(at)}>
      {today ? time : `${d.toLocaleDateString(tag)} ${time}`}
    </time>
  );
}
