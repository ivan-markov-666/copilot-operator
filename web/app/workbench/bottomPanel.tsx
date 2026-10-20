'use client';

/**
 * The panel under the editor, for the conversation open in the chat: the terminal — the commands its latest message
 * ran and what each printed, following the newest while it runs; the problems — what did not go well in it, each
 * bringing its message into view in the chat; and the output — the bot's events for it as they come. Ctrl+J opens and
 * closes it. On a new chat it is empty until that chat runs (2026-10-19), and a problem can be marked "Seen", which
 * takes it off the list and the count. Each tab has an "i" that says what it shows (2026-10-20).
 */
import { Fragment, useEffect, useState } from 'react';
import { api, type Session, type SessionEvent, type Story, type StoryEntry, type Task } from '../../lib/api';
import { useT, useFmtTime, type Key } from '../../lib/i18n';
import { usePoll } from '../../lib/usePoll';
import { useFollowBottom } from '../../lib/useFollowBottom';
import { InfoTip } from '../popover';
import type { BottomTab } from './workbench';

const TABS: Array<{ tab: BottomTab; label: Key; infoLabel: Key; info: Key }> = [
  { tab: 'terminal', label: 'wb.terminal', infoLabel: 'wb.terminalInfoLabel', info: 'wb.terminalInfo' },
  { tab: 'problems', label: 'wb.problems', infoLabel: 'wb.problemsInfoLabel', info: 'wb.problemsInfo' },
  { tab: 'output', label: 'wb.output', infoLabel: 'wb.outputInfoLabel', info: 'wb.outputInfo' },
];

export function BottomPanel({
  open,
  onToggle,
  tab,
  onTab,
  session,
  task,
  newChat = false,
  onShowMessage,
}: {
  open: boolean;
  onToggle: () => void;
  tab: BottomTab;
  onTab: (t: BottomTab) => void;
  session?: Session;
  task?: Task;
  /** The chat is on a new chat with nothing in it: the panel shows nothing of another conversation. */
  newChat?: boolean;
  /** Brings a message of the conversation into view in the chat. */
  onShowMessage: (taskId: string) => void;
}) {
  const { t } = useT();
  const problems = session ? problemsOf(session) : [];
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [showSeen, setShowSeen] = useState(false);
  useEffect(() => setSeen(readSeen()), []);
  const markSeen = (keys: string[]): void => setSeen(writeSeen(keys));
  const unseen = problems.filter((p) => !seen.has(p.key));
  const shown = showSeen ? problems : unseen;
  const seenHere = problems.length - unseen.length;
  return (
    <section className="wb-bottom" aria-label={t('wb.panel')}>
      <div className="wb-bottom-tabs" role="tablist" aria-label={t('wb.panel')}>
        {TABS.map(({ tab: b, label, infoLabel, info }) => (
          <Fragment key={b}>
            <button type="button" role="tab" aria-selected={open && tab === b} className={open && tab === b ? 'on' : ''} onClick={() => onTab(b)}>
              {t(label)}
              {b === 'problems' && unseen.length > 0 && <span className="wb-badge">{unseen.length}</span>}
            </button>
            <InfoTip label={t(infoLabel)} text={t(info)} />
          </Fragment>
        ))}
        <span className="grow" />
        <button type="button" className="wb-icon-btn" aria-label={t('wb.cmdPanel')} title={`${t('wb.cmdPanel')} (Ctrl+J)`} onClick={onToggle}>
          {open ? '▾' : '▴'}
        </button>
      </div>
      {open && (
        <div className="wb-bottom-body" role="tabpanel">
          {tab === 'terminal' ? (
            newChat ? <p className="muted small wb-pad">{t('wb.newChatTerminal')}</p> : <Terminal session={session} task={task} />
          ) : tab === 'problems' ? (
            problems.length === 0 ? (
              <p className="muted small wb-pad">{newChat ? t('wb.newChatProblems') : session ? t('wb.noProblems') : t('wb.pickChat')}</p>
            ) : (
              <>
                {shown.length === 0 ? (
                  <p className="muted small wb-pad">{t('wb.problemsNoneNew')}</p>
                ) : (
                  <ul className="wb-problems">
                    {shown.map((p) => (
                      <li key={p.key} className={seen.has(p.key) ? 'seen' : undefined}>
                        <button type="button" className="wb-row" onClick={() => onShowMessage(p.taskId)} title={t('wb.problemShow')}>
                          <span className={`wb-sev ${p.kind}`} aria-hidden="true">{p.kind === 'error' ? '✗' : '⚠'}</span>
                          <span className="wb-row-name">{p.text}</span>
                          <span className="muted">{p.where}</span>
                        </button>
                        {!seen.has(p.key) && (
                          <button type="button" className="quiet small wb-seen" onClick={() => markSeen([p.key])} title={t('wb.problemSeenWhy')}>
                            {t('wb.problemSeen')}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {(unseen.length > 1 || seenHere > 0) && (
                  <div className="row wb-pad">
                    {unseen.length > 1 && (
                      <button type="button" className="quiet small" onClick={() => markSeen(unseen.map((p) => p.key))} title={t('wb.problemSeenWhy')}>
                        {t('wb.problemsAllSeen')}
                      </button>
                    )}
                    {seenHere > 0 && (
                      <button type="button" className="quiet small" onClick={() => setShowSeen(!showSeen)}>
                        {showSeen ? t('wb.problemsHideSeen') : t('wb.problemsShowSeen', { n: seenHere })}
                      </button>
                    )}
                  </div>
                )}
              </>
            )
          ) : newChat ? (
            <p className="muted small wb-pad">{t('wb.newChatOutput')}</p>
          ) : (
            <Output session={session} />
          )}
        </div>
      )}
    </section>
  );
}

type Problem = { key: string; taskId: string; kind: 'error' | 'warn'; text: string; where: string };

/** What did not pass, task by task: checks, review findings, and why a task stopped. */
function problemsOf(session: Session): Problem[] {
  const out: Problem[] = [];
  session.tasks.forEach((x, i) => {
    const where = `${i + 1}. ${x.title}`;
    /*
     * What "Seen" remembers it by: the task, its attempt and what the problem says. The same problem on a later
     * attempt of the task is a new one, and is shown again.
     */
    const add = (kind: Problem['kind'], text: string, at = where): void => {
      out.push({ key: `${session.id}|${x.id}|a${x.attempt ?? 1}|${kind}|${text}`, taskId: x.id, kind, text, where: at });
    };
    for (const c of x.checkResults ?? []) if (!c.passed) add('error', `${c.name}: ${c.detail.slice(0, 160)}`);
    if (x.review?.verdict === 'fail') for (const f of x.review.findings ?? []) add('error', f.what.slice(0, 200), f.where ? `${where} · ${f.where}` : where);
    if (['failed', 'blocked', 'limit-reached', 'aborted'].includes(x.status) && x.reason) add('warn', x.reason.slice(0, 200));
    if (x.vcs?.problem) add('warn', x.vcs.problem.slice(0, 200));
  });
  return out;
}

/*
 * The problems marked seen, in this browser. A convenience of the person reading them, as the panel's size is: the
 * record of the task is not changed, and the problem is still there on its task. The newest few hundred are kept.
 */
const SEEN_KEY = 'cop.problems.seen';
const SEEN_KEEP = 500;

function readSeen(): Set<string> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeSeen(keys: string[]): Set<string> {
  const all = [...readSeen(), ...keys.filter((k) => k)];
  const kept = [...new Set(all)].slice(-SEEN_KEEP);
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(kept));
  } catch {
    /* a browser that keeps nothing forgets them on the next visit */
  }
  return new Set(kept);
}

/** The commands the task ran, and their output, as a terminal: re-read every two seconds while it is live. */
function Terminal({ session, task }: { session?: Session; task?: Task }) {
  const { t } = useT();
  const [story, setStory] = useState<Story | null>(null);
  const live = task?.status === 'running' || task?.status === 'waiting-approval';
  const { ref } = useFollowBottom<HTMLDivElement>(!!live, story?.entries.length ?? 0);
  const read = () => (session && task && (task.startedAt || live) ? api.taskStory(session.id, task.id, task.runId).then(setStory).catch(() => undefined) : Promise.resolve());
  // Read at once when another task is chosen, then on the clock: the clock alone left the old one up for 15 s.
  useEffect(() => {
    setStory(null);
    void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.runId]);
  usePoll(read, live ? 2000 : 15000, !!session && !!task);
  if (!task) return <p className="muted small wb-pad">{t('wb.pickChat')}</p>;
  const steps: Array<Extract<StoryEntry, { kind: 'step' }>> = [];
  const walk = (es: StoryEntry[]): void => es.forEach((e) => (e.kind === 'step' ? steps.push(e) : e.kind === 'review' ? walk(e.entries) : undefined));
  walk(story?.entries ?? []);
  if (steps.length === 0) return <p className="muted small wb-pad">{story ? t('wb.noSteps') : t('wb.loading')}</p>;
  return (
    <div ref={ref} className="wb-terminal" aria-live="off">
      {steps.map((s, i) => (
        <div key={i} className={s.failed ? 'bad' : ''}>
          <div className="wb-cmd">
            <span aria-hidden="true">$ </span>
            {s.command}
            <span className="muted"> {s.outcome ? `${s.outcome}${s.exitCode !== undefined ? ` (${s.exitCode})` : ''}` : t('wb.runningNow')}</span>
          </div>
          {s.output && <pre>{s.output}</pre>}
        </div>
      ))}
    </div>
  );
}

/** The session's events, newest at the bottom. */
function Output({ session }: { session?: Session }) {
  const { t } = useT();
  const fmt = useFmtTime();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const { ref } = useFollowBottom<HTMLDivElement>(true, events.length);
  const read = () => (session ? api.sessionEvents(session.id).then(setEvents).catch(() => undefined) : Promise.resolve());
  useEffect(() => {
    setEvents([]);
    void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);
  usePoll(read, 3000, !!session);
  if (!session) return <p className="muted small wb-pad">{t('wb.pickChat')}</p>;
  return (
    <div ref={ref} className="wb-terminal">
      {events.length === 0 ? (
        <p className="muted small">{t('wb.noEvents')}</p>
      ) : (
        events.map((e, i) => (
          <div key={i} className={e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warnline' : ''}>
            <span className="muted">{fmt(e.at)} </span>
            {e.message ?? e.type}
          </div>
        ))
      )}
    </div>
  );
}
