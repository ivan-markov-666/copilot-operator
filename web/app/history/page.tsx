'use client';

/**
 * The register: every task of every session, past and future, in one place.
 *
 * The session page answers "what is happening in this conversation". This page answers the
 * question that has no home there: what has this machine actually done, and what is it about
 * to do. So the ordering is the point. Upcoming tasks are shown in the order they will run,
 * with the next one out of the gate marked; finished ones newest first, each with its summary
 * or the reason it stopped, because "what was done and what was not" is the whole question.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, fmtDuration, type RegistryEntry, type TaskStatus } from '../../lib/api';
import { elapsedMs, isLive, runSpanMs } from '../../lib/clock';
import { useNow } from '../../lib/useNow';
import { useT, useFmtTime, type Key } from '../../lib/i18n';
import { RichText } from '../richText';
import { useTaskActions } from '../taskActions';
import { confirmDialog } from '../dialog';
import { TaskStory } from '../taskStory';

const OPEN_STATUSES: TaskStatus[] = ['queued', 'running', 'waiting-approval'];
/** Everything that ended without the work being done, which is what the counter asks about. */
const FAILED_STATUSES: TaskStatus[] = ['blocked', 'failed', 'aborted', 'limit-reached'];

type View = 'flow' | 'list' | 'runs';

/** Everything one press of a start button set off, in the order it ran. */
type Run = { id: string; startedAt: string; sessions: number; entries: RegistryEntry[] };

/**
 * The entries gathered into the runs that produced them, newest run first.
 *
 * A register sorted by time puts tasks that merely happened to follow each other next to ones
 * that were genuinely sent off together, and nothing on the row tells them apart. The run id
 * does, so it is what the grouping is built on rather than the clock.
 */
/** How long a run took, or has taken so far — ticking while any of its tasks is still going. */
function RunTook({ run }: { run: Run }) {
  const { t } = useT();
  const live = run.entries.some(isLive);
  const now = useNow(live);
  const span = runSpanMs(run, run.entries, now);
  return <>{t(span.live ? 'reg.runRunning' : 'reg.runTook', { d: fmtDuration(span.ms) })}</>;
}

function groupIntoRuns(entries: RegistryEntry[]): { runs: Run[]; loose: RegistryEntry[] } {
  const byId = new Map<string, Run>();
  const loose: RegistryEntry[] = [];

  for (const e of entries) {
    if (!e.runGroup) {
      loose.push(e);
      continue;
    }
    const run = byId.get(e.runGroup.id);
    if (run) run.entries.push(e);
    else byId.set(e.runGroup.id, { ...e.runGroup, entries: [e] });
  }

  const runs = [...byId.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  for (const run of runs) {
    run.entries.sort((a, b) => Date.parse(a.startedAt ?? a.createdAt) - Date.parse(b.startedAt ?? b.createdAt));
  }
  return { runs, loose };
}

export default function HistoryPage() {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const [all, setAll] = useState<RegistryEntry[] | null>(null);
  const [err, setErr] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string>('');
  const [view, setView] = useState<View>('flow');
  const [sessionId, setSessionId] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      setAll(await api.tasks());
      setUpdatedAt(new Date().toISOString());
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 6000);
    return () => clearInterval(timer);
  }, [load]);

  const sessions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of all ?? []) if (!seen.has(e.sessionId)) seen.set(e.sessionId, e.sessionName);
    return [...seen.entries()];
  }, [all]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (all ?? []).filter((e) => {
      if (sessionId && e.sessionId !== sessionId) return false;
      if (status && e.status !== status) return false;
      if (!q) return true;
      return `${e.title} ${e.summary ?? ''} ${e.reason ?? ''} ${e.sessionName}`.toLowerCase().includes(q);
    });
  }, [all, sessionId, status, query]);

  /*
   * Five numbers that add up to the total.
   *
   * "Ahead" used to include the task being worked on, which made it wrong by exactly one for
   * the whole length of a run — and one is the number that matters when there are two left.
   * Running is its own count now, and ahead means what it says: not started yet.
   */
  const counts = useMemo(() => {
    const source = all ?? [];
    return {
      total: source.length,
      done: source.filter((e) => e.status === 'done').length,
      running: source.filter((e) => e.status === 'running' || e.status === 'waiting-approval').length,
      open: source.filter((e) => e.status === 'queued').length,
      failed: source.filter((e) => FAILED_STATUSES.includes(e.status)).length,
    };
  }, [all]);

  /*
   * How big each run was, counted over every task rather than the filtered ones. Narrowing the
   * page to one session must not make a task claim it ran with fewer others than it did.
   */
  const runSizes = useMemo(() => {
    const sizes = new Map<string, number>();
    for (const e of all ?? []) {
      if (e.runGroup) sizes.set(e.runGroup.id, (sizes.get(e.runGroup.id) ?? 0) + 1);
    }
    return sizes;
  }, [all]);

  const grouped = useMemo(() => groupIntoRuns(shown), [shown]);

  const active = shown.filter((e) => e.status === 'running' || e.status === 'waiting-approval');
  const upcoming = shown.filter((e) => e.status === 'queued');
  const past = shown
    .filter((e) => !OPEN_STATUSES.includes(e.status))
    .sort((a, b) => Date.parse(b.finishedAt ?? b.startedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.startedAt ?? a.createdAt));

  const filtered = sessionId !== '' || status !== '' || query.trim() !== '';

  return (
    <>
      <div className="panel">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>
            {t('reg.title')}
          </h2>
          <span className="muted small">{updatedAt && t('reg.updated', { t: fmtTime(updatedAt) })}</span>
          <button className="quiet" onClick={() => void load()}>
            {t('reg.refresh')}
          </button>
        </div>
        <p className="muted small">{t('reg.hint')}</p>

        <NewTaskPanel sessions={sessions} />

        <div className="counts">
          <div className="count">
            <div className="n">{counts.total}</div>
            <div className="k">{t('reg.total')}</div>
          </div>
          <div className="count done">
            <div className="n">{counts.done}</div>
            <div className="k">{t('reg.done')}</div>
          </div>
          <div className="count running">
            <div className="n">{counts.running}</div>
            <div className="k">{t('reg.runningCount')}</div>
          </div>
          <div className="count queued">
            <div className="n">{counts.open}</div>
            <div className="k">{t('reg.open')}</div>
          </div>
          <div className="count failed">
            <div className="n">{counts.failed}</div>
            <div className="k">{t('reg.failedCount')}</div>
          </div>
        </div>
      </div>

      {err && <div className="panel err">{err}</div>}

      <div className="panel">
        <div className="toolbar">
          <div>
            <label htmlFor="f-session" style={{ margin: 0 }}>
              {t('reg.filterSession')}
            </label>
            <select id="f-session" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              <option value="">{t('reg.allSessions')}</option>
              {sessions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="f-status" style={{ margin: 0 }}>
              {t('reg.filterStatus')}
            </label>
            <select id="f-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('reg.allStatuses')}</option>
              {(
                ['queued', 'running', 'waiting-approval', 'done', 'blocked', 'failed', 'aborted', 'limit-reached'] as TaskStatus[]
              ).map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}` as Key)}
                </option>
              ))}
            </select>
          </div>
          <div className="grow">
            <label htmlFor="f-q" style={{ margin: 0 }}>
              {t('reg.search')}
            </label>
            <input id="f-q" type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('reg.searchPlaceholder')} />
          </div>
          <div>
            <label style={{ margin: 0 }} id="view-label">
              {t('reg.viewLabel')}
            </label>
            <div className="segmented" role="group" aria-labelledby="view-label">
              <button type="button" aria-pressed={view === 'flow'} onClick={() => setView('flow')}>
                {t('reg.viewFlow')}
              </button>
              <button type="button" aria-pressed={view === 'runs'} onClick={() => setView('runs')}>
                {t('reg.groupBy')}
              </button>
              <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
                {t('reg.viewList')}
              </button>
            </div>
          </div>
          {filtered && (
            <button
              className="quiet"
              onClick={() => {
                setSessionId('');
                setStatus('');
                setQuery('');
              }}
            >
              {t('reg.clear')}
            </button>
          )}
        </div>

        {all === null && <div className="muted">{t('home.loading')}</div>}
        {all !== null && all.length === 0 && <div className="empty">{t('reg.none')}</div>}
        {all !== null && all.length > 0 && shown.length === 0 && <div className="empty">{t('reg.noMatch')}</div>}
      </div>

      {view === 'list' && shown.length > 0 && <ListView entries={[...active, ...upcoming, ...past]} />}

      {view === 'runs' && shown.length > 0 && (
        <>
          <div className="panel">
            <h2>{t('reg.runGroup')}</h2>
            <p className="muted small">{t('reg.runGroupHint')}</p>
          </div>

          {grouped.runs.map((run) => (
            <section className="panel" key={run.id}>
              <RunHeading run={run} />
              <Flow entries={run.entries} sizes={runSizes} onChange={() => void load()} />
            </section>
          ))}

          {grouped.loose.length > 0 && (
            <section className="panel">
              <h2>{t('reg.notInARun')}</h2>
              <p className="muted small">{t('reg.notInARunHint')}</p>
              <Flow entries={grouped.loose} sizes={runSizes} onChange={() => void load()} />
            </section>
          )}
        </>
      )}

      {view === 'flow' && (
        <>
          {active.length > 0 && (
            <section className="panel">
              <h2>{t('reg.activeNow')}</h2>
              <Flow entries={active} sizes={runSizes} onChange={() => void load()} />
            </section>
          )}

          {shown.length > 0 && (
            <section className="panel">
              <h2>{t('reg.upcoming')}</h2>
              <p className="muted small">{t('reg.upcomingHint')}</p>
              <ContinueRun entries={shown} onChange={() => void load()} />
              {upcoming.length === 0 ? (
                <div className="empty">{t('reg.noUpcoming')}</div>
              ) : (
                <Flow entries={upcoming} upcoming sizes={runSizes} onChange={() => void load()} />
              )}
            </section>
          )}

          {shown.length > 0 && (
            <section className="panel">
              <h2>{t('reg.past')}</h2>
              <p className="muted small">{t('reg.pastHint')}</p>
              {past.length === 0 ? <div className="empty">{t('reg.noPast')}</div> : <PastByRun entries={past} sizes={runSizes} onChange={() => void load()} />}
            </section>
          )}
        </>
      )}
    </>
  );
}

/** The vertical thread: one dot per task, coloured by what became of it. */
function Flow({
  entries,
  upcoming = false,
  sizes,
  onChange,
}: {
  entries: RegistryEntry[];
  upcoming?: boolean;
  /** How many tasks each run held, so a row can say who it went out with. */
  sizes?: Map<string, number>;
  onChange?: () => void;
}) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  /*
   * The two repository actions, shared with the session page.
   *
   * They are here because this is where a failure is seen. Sending somebody to another page to
   * act on the row they are already reading is exactly the friction that makes a feature go
   * unused, and "run the whole thing again from the one that broke" is the commonest thing
   * anyone wants from this page.
   */
  const actions = useTaskActions(onChange ?? (() => undefined));
  // One tick for the whole list, and only while something in it is still going.
  const now = useNow(entries.some(isLive));
  /** The failed task whose prompt is being rewritten, if one is. */
  const [fixing, setFixing] = useState<RegistryEntry | null>(null);
  /** The rows whose story is unfolded. */
  const [storyOpen, setStoryOpen] = useState<Set<string>>(new Set());
  const flipStory = (taskId: string) =>
    setStoryOpen((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });

  return (
    <>
    {fixing && (
      <FixPromptDialog
        entry={fixing}
        onClose={(changed) => {
          setFixing(null);
          if (changed) onChange?.();
        }}
      />
    )}
    <ol className="flow">
      {entries.map((e) => {
        const isNext = upcoming && e.queuePosition === 1;
        const runSize = e.runGroup ? (sizes?.get(e.runGroup.id) ?? 1) : 0;
        return (
          <li key={`${e.sessionId}-${e.taskId}`} className={`${e.status}${isNext ? ' next' : ''}`}>
            <div className="head">
              <strong>{e.title}</strong>
              <span className={`badge ${e.status}`}>{t(`status.${e.status}` as Key)}</span>
              {isNext && <span className="chip">{t('reg.next')}</span>}
              {e.sessionRunning && <span className="chip">{t('reg.sessionRunning')}</span>}
              {/*
               * Said on the row itself, not only in the grouped view: the commonest moment for
               * this question is while reading a failure, and it is about what else that
               * failure took down with it.
               */}
              {/*
                The verdict of the independent review, next to the status.
                A task can be `done` and still have been through two rounds of somebody else
                finding things wrong with it, and that is worth a word on the row.
              */}
              {e.review && e.review.verdict !== 'skipped' && (
                <span
                  className={`badge ${e.review.verdict === 'pass' ? 'done' : e.review.verdict === 'fail' ? 'blocked' : 'waiting-approval'}`}
                  title={e.review.stepsRun > 0 ? t('review.ran', { n: e.review.stepsRun }) : undefined}
                >
                  {t(`review.verdict.${e.review.verdict}` as Key)}
                  {e.review.findings > 0 ? ` (${e.review.findings})` : ''}
                </span>
              )}
              {/*
                Instructions the model could not follow as written. A count is enough here: the
                row says a decision was taken that the plan did not make, and the task card says
                which.
              */}
              {(e.deviations ?? 0) > 0 && (
                <span className="badge waiting-approval" title={t('reg.deviationsWhy')}>
                  {t('reg.deviations', { n: e.deviations ?? 0 })}
                </span>
              )}
              {(e.disputes ?? 0) > 0 && (
                <span className="badge waiting-approval" title={t('reg.disputesWhy')}>
                  {t('reg.disputes', { n: e.disputes ?? 0 })}
                </span>
              )}
              {e.readOnly && (
                <span className="chip" title={t('reg.readOnlyWhy')}>
                  {t('task.readOnly')}
                </span>
              )}
              {(e.autoRetries ?? 0) > 0 && (
                <span className={`badge ${e.status === 'done' ? 'done' : 'blocked'}`} title={t('reg.retriedFreshWhy')}>
                  {e.status === 'done' ? t('reg.retriedFreshDone', { n: e.autoRetries ?? 0 }) : t('reg.retriedFreshStill', { n: e.autoRetries ?? 0 })}
                </span>
              )}
              {e.runGroup && (
                <span
                  className="chip"
                  title={t('reg.runTitle', {
                    t: runSize,
                    s: e.runGroup.sessions,
                    when: fmtTime(e.runGroup.startedAt),
                  })}
                >
                  {runSize > 1 ? t('reg.runWith', { n: runSize - 1 }) : t('reg.runAlone')}
                </span>
              )}
            </div>

            <div className="when">
              <Link href={`/sessions/${e.sessionId}`}>{e.sessionName}</Link>
              {' · '}
              {e.startedAt ? t('task.started', { t: fmtTime(e.startedAt) }) : t('task.added', { t: fmtTime(e.createdAt) })}
              {e.finishedAt ? ` · ${t('task.finished', { t: fmtTime(e.finishedAt) })}` : ''}
              {e.durationMs !== undefined ? ` · ${t('reg.took', { d: fmtDuration(e.durationMs) })}` : ''}
              {isLive(e) ? ` · ${t('task.runningFor', { d: fmtDuration(elapsedMs(e.startedAt, undefined, now)) })}` : ''}
              {e.iterations > 0 ? ` · ${t('reg.iterations', { n: e.iterations })}` : ''}
            </div>

            {e.status === 'queued' && (
              <div className="when">
                {e.queuePosition && e.queuePosition > 1
                  ? t('reg.willFollow', { n: e.queuePosition - 1 })
                  : e.sessionRunning
                    ? t('reg.queuePos', { n: e.queuePosition ?? 1 })
                    : t('reg.waitingRun')}
              </div>
            )}

            {e.status === 'blocked' && <p className="what muted small">{t('reg.blockedWhat')}</p>}

            {/*
              What happened last time, next to what happened this time.
              A re-run is started from this page, so the question it raises — why did the
              previous attempt not work — should be answerable without leaving it. Folded away,
              because on a task that ran once there is nothing here worth the space.
            */}
            {(e.attempts?.length ?? 0) > 0 && (
              <details className="small" style={{ marginTop: 6 }}>
                <summary>
                  {(e.attempts?.length ?? 0) === 1
                    ? t('reg.attemptsOne', { n: e.attempt ?? (e.attempts?.length ?? 0) + 1 })
                    : t('reg.attempts', { n: e.attempt ?? (e.attempts?.length ?? 0) + 1, m: e.attempts?.length ?? 0 })}
                </summary>
                <ol className="attempts">
                  {e.attempts?.map((a) => (
                    <li key={`${a.runId ?? a.attempt}`}>
                      <div className="head">
                        <strong>{t('reg.attemptN', { n: a.attempt })}</strong>
                        <span className={`badge ${a.status}`}>{t(`status.${a.status}` as Key)}</span>
                        {a.iterations > 0 && <span className="muted">{t('reg.iterations', { n: a.iterations })}</span>}
                        {a.durationMs !== undefined && <span className="muted">{t('reg.took', { d: fmtDuration(a.durationMs) })}</span>}
                        {a.runId && (
                          <a href={api.taskLogUrl(e.sessionId, e.taskId, a.runId)} target="_blank" rel="noreferrer">
                            {t('reg.attemptLog')}
                          </a>
                        )}
                      </div>
                      <div className="when">
                        {a.startedAt ? t('task.started', { t: fmtTime(a.startedAt) }) : ''}
                        {a.finishedAt ? ` · ${t('task.finished', { t: fmtTime(a.finishedAt) })}` : ''}
                        {a.branch ? ` · ${a.branch}` : ''}
                      </div>
                      {a.reason && <p className="what err">{t('reg.stopped', { reason: a.reason })}</p>}
                      {a.summary && <RichText text={a.summary} className="what" />}
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {e.summary && <RichText text={e.summary} className="what" />}
            {e.reason && <p className="what err">{t('reg.stopped', { reason: e.reason })}</p>}

            {actions.message && <p className="what small">{actions.message}</p>}

            <div className="row small" style={{ marginTop: 6 }}>
              <Link href={`/sessions/${e.sessionId}#${e.taskId}`}>{t('reg.openTask')}</Link>
              {e.runId && (
                <a href={api.taskLogUrl(e.sessionId, e.taskId)} target="_blank" rel="noreferrer">
                  {t('reg.openLog')}
                </a>
              )}
              {e.chatUrl && (
                <a href={e.chatUrl} target="_blank" rel="noreferrer">
                  {t('home.col.chat')}
                </a>
              )}
              {/*
               * The three JSON views of this one task, for handing to whoever debugs it: what
               * was asked, what happened to the work, what the runner did. On every task that
               * has run — a passed task is exactly what somebody compares a failed one against.
               */}
              {e.startedAt && <ExportLinks where={{ session: e.sessionId, task: e.taskId }} />}
              {e.runId && (
                <button className={storyOpen.has(e.taskId) ? '' : 'quiet'} onClick={() => flipStory(e.taskId)} title={t('story.why')}>
                  {storyOpen.has(e.taskId) ? t('story.hide') : t('story.show')}
                </button>
              )}
              {FAILED_STATUSES.includes(e.status) && !e.sessionRunning && (
                <button className="quiet" onClick={() => setFixing(e)} title={t('reg.fixPromptHint')}>
                  {t('reg.fixPrompt')}
                </button>
              )}
              {/*
               * Only on a task that has actually run. A queued one has no point to go back to
               * and is already where a restart would put it.
               */}
              {e.startedAt && !e.sessionRunning && (
                <>
                  <button
                    className="quiet"
                    disabled={actions.busy !== ''}
                    title={t('restore.why')}
                    onClick={() => void actions.restore({ sessionId: e.sessionId, taskId: e.taskId, title: e.title })}
                  >
                    {actions.busy === 'restore' ? t('restore.checking') : t('restore.button')}
                  </button>
                  <button
                    className="quiet"
                    disabled={actions.busy !== ''}
                    title={t('restart.why')}
                    onClick={() => void actions.restartFrom({ sessionId: e.sessionId, taskId: e.taskId, title: e.title })}
                  >
                    {actions.busy === 'restart' ? t('restart.checking') : t('restart.button')}
                  </button>
                </>
              )}
            </div>
            {storyOpen.has(e.taskId) && e.runId && (
              <TaskStory sessionId={e.sessionId} taskId={e.taskId} live={e.status === 'running' || e.status === 'waiting-approval'} />
            )}
          </li>
        );
      })}
    </ol>
    </>
  );
}

/** The three JSON downloads, as a tight group of links with what each one answers on hover. */
function ExportLinks({ where }: { where: { run?: string; session?: string; task?: string } }) {
  const { t } = useT();
  return (
    <span className="exports" title={t('reg.exportTitle')}>
      <span className="muted">{t('reg.exportTitle')}:</span>{' '}
      <a href={api.exportUrl('plan', where)} title={t('reg.exportPlanWhy')}>
        {t('reg.exportPlan')}
      </a>
      {' · '}
      <a href={api.exportUrl('domain', where)} title={t('reg.exportDomainWhy')}>
        {t('reg.exportDomain')}
      </a>
      {' · '}
      <a href={api.exportUrl('bot', where)} title={t('reg.exportBotWhy')}>
        {t('reg.exportBot')}
      </a>
    </span>
  );
}

/** A run's title line: its name, its size, when, how long, and its own three downloads. */
function RunHeading({ run }: { run: Run }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const name = run.entries.map((e) => e.runGroup?.name).find(Boolean) ?? t('reg.runUnnamed');
  const done = run.entries.filter((e) => e.status === 'done').length;
  const failed = run.entries.filter((e) => FAILED_STATUSES.includes(e.status)).length;
  return (
    <div className="run-heading">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          {name}
        </h2>
        <span className="muted small">
          {t('reg.runOf', { t: run.entries.length, s: run.sessions })}
          {' · '}
          {t('reg.runAt', { when: fmtTime(run.startedAt) })}
          {' · '}
          <RunTook run={run} />
        </span>
      </div>
      <div className="row small" style={{ marginTop: 4 }}>
        <span className={`badge ${failed > 0 ? 'failed' : done === run.entries.length ? 'done' : ''}`}>{t('reg.runCounts', { done, failed })}</span>
        <ExportLinks where={{ run: run.id }} />
      </div>
    </div>
  );
}

/**
 * Finished tasks, gathered under the run that produced them, newest run first.
 *
 * A register of a hundred finished tasks in one column is unreadable, and the thing that
 * makes it readable is the same thing that answers "what went out together": the run. So
 * each run folds, the newest open and the rest closed, with its name and its counts on the
 * fold, and the tasks that were never part of a run at the bottom.
 */
function PastByRun({ entries, sizes, onChange }: { entries: RegistryEntry[]; sizes: Map<string, number>; onChange: () => void }) {
  const { t } = useT();
  const grouped = useMemo(() => groupIntoRuns(entries), [entries]);
  return (
    <>
      {grouped.runs.map((run, i) => (
        <details key={run.id} className="run-fold" open={i === 0}>
          <summary>
            <RunHeading run={run} />
          </summary>
          <Flow entries={run.entries} sizes={sizes} onChange={onChange} />
        </details>
      ))}
      {grouped.loose.length > 0 && (
        <details className="run-fold" open={grouped.runs.length === 0}>
          <summary>
            <div className="run-heading">
              <h2 style={{ margin: 0 }}>{t('reg.notInARun')}</h2>
              <p className="muted small" style={{ margin: '4px 0 0' }}>{t('reg.notInARunHint')}</p>
            </div>
          </summary>
          <Flow entries={grouped.loose} sizes={sizes} onChange={onChange} />
        </details>
      )}
    </>
  );
}

/**
 * The prompt of one failed task, alone, to be rewritten and queued again.
 *
 * The task card edits everything at once — title, level 2, prompt, git names, checks — and
 * after a failure that is four things too many: the failure is in the task text, and that is
 * what gets rewritten. Nothing else is touched; the attempt that ran keeps the text it ran
 * with, and the new attempt goes to the back of the session's queue.
 */
function FixPromptDialog({ entry, onClose }: { entry: RegistryEntry; onClose: (changed: boolean) => void }) {
  const { t } = useT();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .session(entry.sessionId)
      .then((s) => {
        const task = s.tasks.find((x) => x.id === entry.taskId);
        if (live) setPrompt(task?.prompt ?? '');
      })
      .catch((e) => {
        if (live) setMsg((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [entry.sessionId, entry.taskId]);

  const save = async () => {
    if (prompt === null) return;
    setBusy(true);
    setMsg('');
    try {
      await api.rerunTask(entry.sessionId, entry.taskId, { prompt });
      setMsg(t('reg.fixPromptSaved', { title: entry.title }));
      setTimeout(() => onClose(true), 900);
    } catch (e) {
      setMsg((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => onClose(false)}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="fix-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="fix-title">{t('reg.fixPromptTitle', { title: entry.title })}</h2>
        <p className="muted small">{t('reg.fixPromptHint')}</p>
        {entry.reason && <p className="what err small">{t('reg.stopped', { reason: entry.reason })}</p>}
        {prompt === null ? (
          <p className="muted small">{msg || t('reg.fixPromptLoading')}</p>
        ) : (
          <textarea className="prose" value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ minHeight: 260 }} disabled={busy} />
        )}
        <div className="row modal-actions">
          {msg && prompt !== null && <span className="small grow">{msg}</span>}
          <button type="button" className="quiet" onClick={() => onClose(false)} disabled={busy}>
            {t('dialog.cancel')}
          </button>
          <button type="button" className="primary" onClick={() => void save()} disabled={busy || prompt === null || !prompt.trim()}>
            {t('reg.fixPromptSave')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A way into new work from the page where the need for it is noticed.
 *
 * One button, for a new session. A new task needs a session to live in, so choosing one in
 * the list is the whole action: it opens that session's task form. No second button, because
 * a row with two buttons and a list reads as three decisions and it is one.
 */
function NewTaskPanel({ sessions }: { sessions: Array<[string, string]> }) {
  const { t } = useT();
  return (
    <div className="row" style={{ margin: '14px 0 18px' }}>
      <Link href="/#new-session">
        <button className="primary">{t('reg.newSession')}</button>
      </Link>
      {sessions.length > 0 && (
        <>
          <label htmlFor="new-task-session" style={{ margin: 0 }}>
            {t('reg.newTask')} {t('reg.newTaskIn')}
          </label>
          <select
            id="new-task-session"
            value=""
            onChange={(e) => {
              if (e.target.value) window.location.href = `/sessions/${e.target.value}#new-task`;
            }}
            style={{ width: 'auto', minWidth: 200 }}
          >
            <option value="">{t('reg.newTaskPick')}</option>
            {sessions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

/**
 * Carrying on with what is queued, from the page that shows it is queued.
 *
 * A run that stopped — a failure with "stop the rest", a session stopped by hand, a task fixed
 * and queued again — leaves tasks in "what is next" and no way to set them off from here; the
 * operator had to find the right session page, or the run panel, and rebuild the selection.
 * This is the run panel's start, for exactly the sessions that still have something queued,
 * in the order the queue shows them.
 */
function ContinueRun({ entries, onChange }: { entries: RegistryEntry[]; onChange: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(false);
  /** Failed tasks of independent sessions the operator chose to queue again. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** A failed task whose prompt is being rewritten from inside this panel. */
  const [fixingHint, setFixingHint] = useState<RegistryEntry | null>(null);

  /*
   * What "continue" means depends on the session.
   *
   * A session whose tasks are one chain stops at a failure, and the queued tasks behind it were
   * written assuming it worked: continuing without it would run them against a state that does
   * not exist. So its failed task goes back in the queue, in its place, as a condition — how it
   * is made to pass is the operator's job (the register offers "Fix the prompt", and the runner
   * already tried a fresh conversation). A session of independent tasks has no such condition;
   * its failed tasks are offered, ticked by default, and can be left out.
   */
  const upcoming = entries.filter((e) => e.status === 'queued');
  const failed = entries.filter((e) => FAILED_STATUSES.includes(e.status) && !e.sessionRunning);
  const anyRunning = entries.some((e) => e.sessionRunning);
  const chainFailed = failed.filter((e) => e.sessionOnFailure === 'stop');
  const looseFailed = failed.filter((e) => e.sessionOnFailure !== 'stop');
  const chosenLoose = looseFailed.filter((e) => picked.has(e.taskId));
  const requeue = [...chainFailed, ...chosenLoose];
  // Sessions in the order their first task appears, which is the order they would run.
  const sessionIds = [...new Set([...upcoming, ...requeue].map((e) => e.sessionId))];
  const name = [...upcoming, ...requeue].map((e) => e.runGroup?.name).find(Boolean);

  const openPanel = () => {
    setPicked(new Set(looseFailed.map((e) => e.taskId)));
    setOpen(true);
    setMsg('');
  };

  const start = async (mode: 'confirm' | 'unattended') => {
    if (mode === 'unattended' && !(await confirmDialog(t('batch.unattendedConfirm', { n: sessionIds.length })))) return;
    setBusy(true);
    setMsg('');
    try {
      for (const e of requeue) await api.rerunTask(e.sessionId, e.taskId);
      const r = await api.startBatch(sessionIds, mode, 'stop', undefined, undefined, name);
      setMsg(r.started ? t('reg.continueStarted', { n: sessionIds.length }) : t('batch.notStarted', { reason: r.reason ?? '' }));
      setOpen(false);
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (upcoming.length === 0 && failed.length === 0) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="row">
        <button className="primary" disabled={busy || anyRunning} onClick={openPanel} title={t('reg.continueWhy')}>
          {t('reg.continue', { n: upcoming.length, s: sessionIds.length })}
        </button>
        {anyRunning && <span className="muted small">{t('reg.continueRunning')}</span>}
        {msg && <span className="small">{msg}</span>}
      </div>
      {open && !anyRunning && (
        <div className="notice" style={{ marginTop: 8 }}>
          <strong>{t('reg.continuePanelTitle')}</strong>
          {chainFailed.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="small">{t('reg.continueChain')}</div>
              <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>
                {chainFailed.map((e) => (
                  <li key={e.taskId}>
                    <strong>{e.title}</strong> · {e.sessionName} · <span className={`badge ${e.status}`}>{t(`status.${e.status}` as Key)}</span>{' '}
                    <button className="quiet small" onClick={() => setFixingHint(e)}>
                      {t('reg.fixPrompt')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {looseFailed.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="small">{t('reg.continueIndependent')}</div>
              <ul className="small" style={{ margin: '4px 0', paddingLeft: 18, listStyle: 'none' }}>
                {looseFailed.map((e) => (
                  <li key={e.taskId}>
                    <label className="option-inline">
                      <input
                        type="checkbox"
                        checked={picked.has(e.taskId)}
                        onChange={(ev) =>
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (ev.target.checked) next.add(e.taskId);
                            else next.delete(e.taskId);
                            return next;
                          })
                        }
                      />
                      <strong>{e.title}</strong> · {e.sessionName} · <span className={`badge ${e.status}`}>{t(`status.${e.status}` as Key)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="small" style={{ marginTop: 6 }}>
            {t('reg.continueSummary', { q: upcoming.length, r: requeue.length, s: sessionIds.length })}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy || sessionIds.length === 0} onClick={() => void start('confirm')}>
              {t('reg.continueGo')}
            </button>
            <button disabled={busy || sessionIds.length === 0} onClick={() => void start('unattended')} title={t('reg.continueUnattendedWhy')}>
              {t('reg.continueUnattended')}
            </button>
            <button className="quiet" disabled={busy} onClick={() => setOpen(false)}>
              {t('dialog.cancel')}
            </button>
          </div>
        </div>
      )}
      {fixingHint && (
        <FixPromptDialog
          entry={fixingHint}
          onClose={(changed) => {
            setFixingHint(null);
            if (changed) onChange();
          }}
        />
      )}
    </div>
  );
}

/** The same rows as a table, for scanning many at once rather than reading them. */
function ListView({ entries }: { entries: RegistryEntry[] }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  return (
    <div className="panel">
      <table>
        <thead>
          <tr>
            <th>{t('reg.col.task')}</th>
            <th>{t('reg.col.session')}</th>
            <th>{t('reg.col.status')}</th>
            <th>{t('reg.col.started')}</th>
            <th>{t('reg.col.took')}</th>
            <th>{t('reg.col.result')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={`${e.sessionId}-${e.taskId}`}>
              <td>
                <Link href={`/sessions/${e.sessionId}#${e.taskId}`}>{e.title}</Link>
              </td>
              <td>
                <Link href={`/sessions/${e.sessionId}`}>{e.sessionName}</Link>
              </td>
              <td>
                <span className={`badge ${e.status}`}>{t(`status.${e.status}` as Key)}</span>
              </td>
              <td className="muted small">{e.startedAt ? fmtTime(e.startedAt) : '—'}</td>
              <td className="muted small">{fmtDuration(e.durationMs) || '—'}</td>
              <td className="small">{e.summary ?? (e.reason ? <span className="err">{e.reason}</span> : '—')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
