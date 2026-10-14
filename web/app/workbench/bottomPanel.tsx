'use client';

/**
 * The panel under the editor: the terminal — the commands the chosen task ran and what each printed, following the
 * newest while it runs; the problems — what did not pass across the session, each a link to its task; and the
 * output — the session's events as they come. Ctrl+J opens and closes it.
 */
import { useEffect, useState } from 'react';
import { api, type Session, type SessionEvent, type Story, type StoryEntry, type Task } from '../../lib/api';
import { useT, useFmtTime } from '../../lib/i18n';
import { usePoll } from '../../lib/usePoll';
import { useFollowBottom } from '../../lib/useFollowBottom';
import type { BottomTab } from './workbench';

export function BottomPanel({
  open,
  onToggle,
  tab,
  onTab,
  session,
  task,
  onOpenTask,
}: {
  open: boolean;
  onToggle: () => void;
  tab: BottomTab;
  onTab: (t: BottomTab) => void;
  session?: Session;
  task?: Task;
  onOpenTask: (sessionId: string, taskId: string) => void;
}) {
  const { t } = useT();
  const problems = session ? problemsOf(session) : [];
  return (
    <section className="wb-bottom" aria-label={t('wb.panel')}>
      <div className="wb-bottom-tabs" role="tablist" aria-label={t('wb.panel')}>
        {(['terminal', 'problems', 'output'] as BottomTab[]).map((b) => (
          <button key={b} type="button" role="tab" aria-selected={open && tab === b} className={open && tab === b ? 'on' : ''} onClick={() => onTab(b)}>
            {t(b === 'terminal' ? 'wb.terminal' : b === 'problems' ? 'wb.problems' : 'wb.output')}
            {b === 'problems' && problems.length > 0 && <span className="wb-badge">{problems.length}</span>}
          </button>
        ))}
        <span className="grow" />
        <button type="button" className="wb-icon-btn" aria-label={t('wb.cmdPanel')} title={`${t('wb.cmdPanel')} (Ctrl+J)`} onClick={onToggle}>
          {open ? '▾' : '▴'}
        </button>
      </div>
      {open && (
        <div className="wb-bottom-body" role="tabpanel">
          {tab === 'terminal' ? (
            <Terminal session={session} task={task} />
          ) : tab === 'problems' ? (
            problems.length === 0 ? (
              <p className="muted small wb-pad">{session ? t('wb.noProblems') : t('wb.pickSession')}</p>
            ) : (
              <ul className="wb-problems">
                {problems.map((p, i) => (
                  <li key={i}>
                    <button type="button" className="wb-row" onClick={() => onOpenTask(p.sessionId, p.taskId)}>
                      <span className={`wb-sev ${p.kind}`} aria-hidden="true">{p.kind === 'error' ? '✗' : '⚠'}</span>
                      <span className="wb-row-name">{p.text}</span>
                      <span className="muted">{p.where}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <Output session={session} />
          )}
        </div>
      )}
    </section>
  );
}

type Problem = { sessionId: string; taskId: string; kind: 'error' | 'warn'; text: string; where: string };

/** What did not pass, task by task: checks, review findings, and why a task stopped. */
function problemsOf(session: Session): Problem[] {
  const out: Problem[] = [];
  session.tasks.forEach((x, i) => {
    const where = `${i + 1}. ${x.title}`;
    for (const c of x.checkResults ?? []) if (!c.passed) out.push({ sessionId: session.id, taskId: x.id, kind: 'error', text: `${c.name}: ${c.detail.slice(0, 160)}`, where });
    if (x.review?.verdict === 'fail') for (const f of x.review.findings ?? []) out.push({ sessionId: session.id, taskId: x.id, kind: 'error', text: f.what.slice(0, 200), where: f.where ? `${where} · ${f.where}` : where });
    if (['failed', 'blocked', 'limit-reached', 'aborted'].includes(x.status) && x.reason) out.push({ sessionId: session.id, taskId: x.id, kind: 'warn', text: x.reason.slice(0, 200), where });
    if (x.vcs?.problem) out.push({ sessionId: session.id, taskId: x.id, kind: 'warn', text: x.vcs.problem.slice(0, 200), where });
  });
  return out;
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
  if (!task) return <p className="muted small wb-pad">{t('wb.pickTask')}</p>;
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
  if (!session) return <p className="muted small wb-pad">{t('wb.pickSession')}</p>;
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
