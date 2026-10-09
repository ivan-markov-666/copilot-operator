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

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { api, fmtDuration, type Metrics, type MetricsRow, type Ratio, type RegistryEntry, type TaskCheck, type TaskStatus, sessionHref } from '../../lib/api';
import { usePoll } from '../../lib/usePoll';
import { useModalFocus } from '../../lib/useModalFocus';
import { ContractFields, scopeLines } from '../contractFields';
import { elapsedMs, isLive, runSpanMs } from '../../lib/clock';
import { useNow } from '../../lib/useNow';
import { useT, useFmtTime, type Key } from '../../lib/i18n';
import { AttemptRecord, SaveLog } from '../saveLog';
import { RowInfo } from '../rowInfo';
import { RunControls } from '../runControls';
import { RichText } from '../richText';
import { useTaskActions } from '../taskActions';
import { confirmDialog } from '../dialog';
import { ChangesButton } from '../diffView';
import { useUnattendedWithoutAsking } from '../../lib/useUnattendedWithoutAsking';
import { TaskStory } from '../taskStory';
import { ContractFixPanel, RunQueuedPanel } from '../runQueued';

const OPEN_STATUSES: TaskStatus[] = ['queued', 'running', 'waiting-approval'];
/** Everything that ended without the work being done, which is what the counter asks about. */
const FAILED_STATUSES: TaskStatus[] = ['blocked', 'failed', 'aborted', 'limit-reached'];
/**
 * Stopped before it finished, or at a limit from the settings, rather than judged: "Continue"
 * carries these on where they stopped. Decided by the API (`isContinuable`), not by the status.
 */
const continuable = (e: RegistryEntry): boolean => !!e.continuable;

/** A limit from the settings, in words: "240 minutes per task". */
function limitWords(t: (key: Key, vars?: Record<string, string | number>) => string, limit: NonNullable<RegistryEntry['limit']>): string {
  return t(`limit.${limit.setting}` as Key, { n: limit.value });
}

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

/**
 * Tasks with the same title in other sessions, by `sessionId:taskId`.
 *
 * A plan imported twice, or a session copied to try again, puts two tasks of one name on this page:
 * one fixed and queued, one old and failed. Read by title, the actions beside the old one looked like
 * the actions for the new one (operator feedback 2026-10-08), so each row says where the others are —
 * their session, when they were added, their status and attempt. Not "newer" and "older": the time a
 * task was added survives every re-queue, so a fixed copy could read as the old one, and two different
 * tasks can share a title. A context rather than a prop, because every list on the page shows rows.
 */
const TwinsContext = createContext<Map<string, RegistryEntry[]>>(new Map());

/** The queued row whose "Run this task" panel is open, for the whole page: one at a time, wherever the row is listed. */
type RunPanelState = { taskId: string } | null;
const RunPanelContext = createContext<{ runPanel: RunPanelState; setRunPanel: (next: RunPanelState) => void }>({
  runPanel: null,
  setRunPanel: () => undefined,
});

/**
 * The dialog a row opened — a prompt rewritten, a contradiction fixed — held by the page, not by the list
 * the row is in. Both end with the task queued again, which moves its row from "What has been done" to
 * "What is next" on the next reload, and the offer to run it that follows has to survive that: held by
 * the list, the dialog went with the list on the next 6-second reload, and an offer opened on the row
 * landed in a folded or filtered list, out of sight (review of 2026-10-09).
 */
type TaskDialog = { kind: 'fix-prompt' | 'contract'; entry: RegistryEntry } | null;
const TaskDialogContext = createContext<(next: TaskDialog) => void>(() => undefined);

function twinsOf(entries: RegistryEntry[]): Map<string, RegistryEntry[]> {
  const byTitle = new Map<string, RegistryEntry[]>();
  for (const e of entries) {
    const key = e.title.trim().toLowerCase();
    byTitle.set(key, [...(byTitle.get(key) ?? []), e]);
  }
  const out = new Map<string, RegistryEntry[]>();
  for (const group of byTitle.values()) {
    for (const e of group) {
      const others = group.filter((o) => o.sessionId !== e.sessionId);
      if (others.length > 0) out.set(`${e.sessionId}:${e.taskId}`, others);
    }
  }
  return out;
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

  usePoll(load, 6000);

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
  // Over every task, not the filtered ones: narrowing to one session must not hide that its task has a twin.
  const twins = useMemo(() => twinsOf(all ?? []), [all]);
  const [runPanel, setRunPanel] = useState<RunPanelState>(null);
  const runPanelValue = useMemo(() => ({ runPanel, setRunPanel }), [runPanel]);
  const [dialog, setDialog] = useState<TaskDialog>(null);

  const active = shown.filter((e) => e.status === 'running' || e.status === 'waiting-approval');
  /*
   * What is next, in the order it would run: sessions in the order the last run had them,
   * then each session's queue. A chain session's failed task heads its queue, because that is
   * where "Continue" puts it back — the tasks behind it were written assuming it worked.
   */
  const byRunOrder = (a: RegistryEntry, b: RegistryEntry) =>
    (a.sessionRunOrder ?? Number.MAX_SAFE_INTEGER) - (b.sessionRunOrder ?? Number.MAX_SAFE_INTEGER) || a.position - b.position;
  const queuedOnly = shown.filter((e) => e.status === 'queued');
  const chainFailed = shown.filter(
    (e) => FAILED_STATUSES.includes(e.status) && e.sessionOnFailure === 'stop' && !e.sessionRunning && queuedOnly.some((q) => q.sessionId === e.sessionId),
  );
  const upcoming = [...chainFailed, ...queuedOnly].sort(byRunOrder);
  const past = shown
    .filter((e) => !OPEN_STATUSES.includes(e.status))
    .sort((a, b) => Date.parse(b.finishedAt ?? b.startedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.startedAt ?? a.createdAt));

  const filtered = sessionId !== '' || status !== '' || query.trim() !== '';

  return (
    <TwinsContext.Provider value={twins}>
    <RunPanelContext.Provider value={runPanelValue}>
    <TaskDialogContext.Provider value={setDialog}>
      {dialog?.kind === 'fix-prompt' && (
        <FixPromptDialog
          entry={dialog.entry}
          offerRun
          onClose={(changed) => {
            setDialog(null);
            if (changed) void load();
          }}
        />
      )}
      {dialog?.kind === 'contract' && (
        <ContractDialog
          entry={dialog.entry}
          onChange={() => void load()}
          onClose={(changed) => {
            setDialog(null);
            if (changed) void load();
          }}
        />
      )}
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

      {view === 'list' && shown.length > 0 && <ListView entries={[...active, ...queuedOnly, ...past]} />}

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

          {/*
            The run's controls sit above both lists rather than inside "What is next": that list folds
            away, and "What has been done" comes first, and neither should take the controls with it.
          */}
          {shown.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              {/* Holding or stopping the run belongs next to continuing it: they are the three
                  things an operator does to a run in flight, and this is the page they watch it on. */}
              <RunControls onChange={() => void load()} />
              {/*
               * After the bot stopped under a run — power, a shutdown, Ctrl+C, a crash — the first
               * thing the operator sees here says so, and what to press. Their work is kept and
               * "Continue" carries them on where they stopped.
               */}
              {shown.some((e) => e.interrupted && !e.sessionRunning) && (
                <div className="notice caution" role="status">
                  <strong>{t('reg.interruptedTitle')}</strong>{' '}
                  {t('reg.interrupted', { n: shown.filter((e) => e.interrupted && !e.sessionRunning).length })}
                </div>
              )}
              <ContinueRun entries={shown} onChange={() => void load()} />
            </div>
          )}

          {shown.length > 0 && (
            <section className="panel">
              <h2>{t('reg.past')}</h2>
              <p className="muted small">{t('reg.pastHint')}</p>
              {past.length === 0 ? <div className="empty">{t('reg.noPast')}</div> : <PastByRun entries={past} sizes={runSizes} onChange={() => void load()} />}
            </section>
          )}

          {shown.length > 0 && (
            <section className="panel">
              <FoldingUpcoming count={upcoming.length}>
                <p className="muted small">{t('reg.upcomingHint')}</p>
                {upcoming.length === 0 ? (
                  <div className="empty">{t('reg.noUpcoming')}</div>
                ) : (
                  <Flow entries={upcoming} upcoming sizes={runSizes} onChange={() => void load()} />
                )}
              </FoldingUpcoming>
            </section>
          )}
          {all && all.length > 0 && <MetricsPanel refreshKey={updatedAt} />}
        </>
      )}
    </TaskDialogContext.Provider>
    </RunPanelContext.Provider>
    </TwinsContext.Provider>
  );
}

/** Where the fold of "What is next" is remembered, per viewer. */
const UPCOMING_OPEN_KEY = 'cop.register.upcomingOpen';

/**
 * "What is next", folding. A long queue made the page a long scroll to get past; it opens by itself
 * while the queue is short, and whatever the operator chose last is remembered in this browser.
 */
function FoldingUpcoming({ count, children }: { count: number; children: React.ReactNode }) {
  const { t } = useT();
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const kept = window.localStorage.getItem(UPCOMING_OPEN_KEY);
      if (kept === 'true' || kept === 'false') return kept === 'true';
    } catch {
      /* no storage: fall through to the default */
    }
    return count <= 8;
  });
  // Toggled by the click alone: the browser also fires "toggle" when an open element first appears,
  // and remembering that would overwrite the choice the operator made.
  const flip = (e: React.MouseEvent): void => {
    e.preventDefault();
    const now = !open;
    setOpen(now);
    try {
      window.localStorage.setItem(UPCOMING_OPEN_KEY, String(now));
    } catch {
      /* remembered only for this visit */
    }
  };
  return (
    <details open={open}>
      <summary onClick={flip}>
        <h2 style={{ display: 'inline' }}>
          {t('reg.upcoming')} ({count})
        </h2>
      </summary>
      {open && children}
    </details>
  );
}

/**
 * How well the bot is doing, added up from every task on record (src/session/metrics.ts).
 *
 * Read when the register reloads, which is every few seconds; the figures are cheap to add up and
 * a person watching a run sees them move. One column for all tasks and one per model, because
 * "which model gets it right first time" is the question most of these figures are for.
 */
function MetricsPanel({ refreshKey }: { refreshKey: string }) {
  const { t } = useT();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api
      .metrics()
      .then((m) => {
        setMetrics(m);
        setErr('');
      })
      .catch((e: unknown) => setErr((e as Error).message));
  }, [refreshKey]);
  if (!metrics) return err ? <div className="panel err">{err}</div> : null;
  const ratio = (r: Ratio): string => (r.of === 0 ? '—' : `${r.n} / ${r.of} (${Math.round((100 * r.n) / r.of)}%)`);
  const rows: Array<[Key, (m: MetricsRow) => string]> = [
    ['metrics.tasks', (m) => `${m.tasks} · ${t('metrics.attemptsN', { n: m.attempts })}`],
    ['metrics.firstPass', (m) => ratio(m.firstPass)],
    ['metrics.doneInTheEnd', (m) => ratio(m.doneInTheEnd)],
    ['metrics.falseCompletion', (m) => ratio(m.falseCompletion)],
    ['metrics.reviewRejection', (m) => ratio(m.reviewRejection)],
    ['metrics.repeatedCommands', (m) => ratio(m.repeatedCommands)],
    ['metrics.noProgress', (m) => ratio(m.noProgress)],
    ['metrics.scopeViolation', (m) => ratio(m.scopeViolation)],
    ['metrics.unrelatedDiff', (m) => ratio(m.unrelatedDiff)],
    ['metrics.resumed', (m) => ratio(m.resumed)],
    ['metrics.freshRetries', (m) => String(m.freshRetries)],
    ['metrics.manual', (m) => String(m.manualInterventions)],
    ['metrics.ended', (m) => Object.entries(m.ended).map(([s, n]) => `${t(`status.${s}` as Key)} ${n}`).join(', ') || '—'],
  ];
  const all = metrics.rows[0];
  return (
    <section className="panel metrics">
      <h2>{t('metrics.title')}</h2>
      <p className="muted small">{t('metrics.hint')}</p>
      {all && all.withStats < all.attempts && <p className="muted small">{t('metrics.olderAttempts', { n: all.attempts - all.withStats })}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('metrics.col.measure')}</th>
              {metrics.rows.map((m) => (
                <th key={m.group}>{m.group === 'all' ? t('metrics.col.all') : m.group}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <td>{t(label)}</td>
                {metrics.rows.map((m) => (
                  <td key={m.group}>{value(m)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The vertical thread: one dot per task, coloured by what became of it. */
function Flow({
  entries,
  upcoming = false,
  sizes,
  onChange,
  picking,
}: {
  entries: RegistryEntry[];
  upcoming?: boolean;
  /** How many tasks each run held, so a row can say who it went out with. */
  sizes?: Map<string, number>;
  onChange?: () => void;
  /**
   * Set while the operator is choosing tasks for one file. Absent means no tick boxes at all,
   * which is the ordinary state: a register is for reading, and a column of empty boxes down a
   * page nobody is selecting from is a question nobody asked.
   */
  picking?: { picked: Set<string>; toggle: (key: string) => void };
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
  /** The rows whose story is unfolded. */
  const [storyOpen, setStoryOpen] = useState<Set<string>>(new Set());
  /** The row whose "Continue where it stopped" panel is open, if one is. */
  const [continuing, setContinuing] = useState<string | null>(null);
  /** The queued row whose "Run this task" panel is open. */
  const { runPanel, setRunPanel } = useContext(RunPanelContext);
  /** Opens a row's dialog — the prompt, or the contradiction — at page level; see `TaskDialog`. */
  const openDialog = useContext(TaskDialogContext);
  const twins = useContext(TwinsContext);
  const flipStory = (taskId: string) =>
    setStoryOpen((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });

  return (
    <>
    <ol className="flow">
      {entries.map((e) => {
        const isNext = upcoming && e.queuePosition === 1;
        const runSize = e.runGroup ? (sizes?.get(e.runGroup.id) ?? 1) : 0;
        return (
          <li key={`${e.sessionId}-${e.taskId}`} className={`${e.status}${isNext ? ' next' : ''}`}>
            {/*
              The status marker on the thread. An element rather than a drawn circle so it can say
              what it is on hover: a hollow ring beside a row read as a radio button that did
              nothing (operator feedback 2026-10-08). The actions are the buttons under the task.
            */}
            <span className="flow-mark" role="img" aria-label={t(`status.${e.status}` as Key)} title={t('flow.markWhy', { status: t(`status.${e.status}` as Key) })} />
            <div className="head">
              {picking && (
                <input
                  type="checkbox"
                  className="pick"
                  aria-label={e.title}
                  checked={picking.picked.has(`${e.sessionId}:${e.taskId}`)}
                  onChange={() => picking.toggle(`${e.sessionId}:${e.taskId}`)}
                />
              )}
              <strong>{e.title}</strong>
              <span className={`badge ${e.status}`}>{t(`status.${e.status}` as Key)}</span>
              {isNext && <span className="chip">{t('reg.next')}</span>}
              <TwinChips entry={e} twins={twins.get(`${e.sessionId}:${e.taskId}`)} />
              {e.limit && (
                <span className="chip" title={t('reg.limitChipWhy')}>
                  {t('reg.limitChip', { limit: limitWords(t, e.limit) })}
                </span>
              )}
              {upcoming && FAILED_STATUSES.includes(e.status) && (
                <span className="chip" title={t('reg.willRequeueFirstWhy')}>
                  {t('reg.willRequeueFirst')}
                </span>
              )}
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
              {e.stopCode && (
                <span className="chip" title={t('stop.why')}>
                  {t(`stop.${e.stopCode}` as Key)}
                </span>
              )}
              {(e.scope?.length ?? 0) > 0 && (
                <span className="chip" title={t('task.scopeWhy')}>
                  {t('task.scope', { paths: (e.scope ?? []).join(', ') })}
                </span>
              )}
              {(e.autoRetries ?? 0) > 0 && (
                <span className={`badge ${e.status === 'done' ? 'done' : e.status === 'blocked' ? 'blocked' : ''}`} title={t('reg.retriedFreshWhy')}>
                  {/* "Still blocked" only for a block: a fresh retry can also be stopped, interrupted or end at a limit. */}
                  {e.status === 'done'
                    ? t('reg.retriedFreshDone', { n: e.autoRetries ?? 0 })
                    : e.status === 'blocked'
                      ? t('reg.retriedFreshStill', { n: e.autoRetries ?? 0 })
                      : t('reg.retriedFreshOther', { n: e.autoRetries ?? 0 })}
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
              <Link href={sessionHref(e.sessionId)}>{e.sessionName}</Link>
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
                          <SaveLog label={t('save.attemptLog')} save={() => api.saveTaskLog(e.sessionId, e.taskId, a.runId)} />
                        )}
                        {a.runId && <AttemptRecord sessionId={e.sessionId} taskId={e.taskId} attempt={a.attempt} />}
                        {a.runId && a.changedFiles !== undefined && (
                          <ChangesButton sessionId={e.sessionId} taskId={e.taskId} runId={a.runId} title={`${e.title} — ${t('reg.attemptN', { n: a.attempt })}`} files={a.changedFiles} />
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

            {actions.message && actions.messageTask === e.taskId && <p className="what small">{actions.message}</p>}

            <div className="row small" style={{ marginTop: 6 }}>
              <Link href={sessionHref(e.sessionId, e.taskId)}>{t('reg.openTask')}</Link>
              {e.runId && <SaveLog label={t('save.log')} save={() => api.saveTaskLog(e.sessionId, e.taskId)} />}
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
              {/* What the task changed, before and after — where its attempt committed something. */}
              {e.changedFiles !== undefined && <ChangesButton sessionId={e.sessionId} taskId={e.taskId} title={e.title} files={e.changedFiles} />}
              <RowInfo />
              {e.runId && (
                <button
                  className={storyOpen.has(e.taskId) ? '' : 'quiet'}
                  aria-expanded={storyOpen.has(e.taskId)}
                  onClick={() => flipStory(e.taskId)}
                  title={isLive(e) ? t('story.showLiveWhy') : t('story.why')}
                >
                  {/* A task being worked on right now says so, and pulses, because what is behind
                      the button is different in kind: not a record, a window on it happening. */}
                  {isLive(e) && !storyOpen.has(e.taskId) && <span className="dot" aria-hidden="true" />}
                  {storyOpen.has(e.taskId) ? t('story.hide') : isLive(e) ? t('story.showLive') : t('story.show')}
                </button>
              )}
              {/*
               * A waiting task is started from its own row. Before, the only starts were the
               * session's and the grouped "Continue", so a task fixed and queued again had no button
               * of its own, and the buttons near it belonged to the attempt that had failed.
               */}
              {e.status === 'queued' && !e.sessionRunning && !e.sessionInactive && (
                <button
                  className={runPanel?.taskId === e.taskId ? '' : 'primary'}
                  aria-expanded={runPanel?.taskId === e.taskId}
                  onClick={() => setRunPanel(runPanel?.taskId === e.taskId ? null : { taskId: e.taskId })}
                  title={t('runq.buttonWhy')}
                >
                  {t('runq.button')}
                </button>
              )}
              {e.stopCode === 'contract-conflict' && !OPEN_STATUSES.includes(e.status) && !e.sessionRunning && (
                <button
                  className="primary"
                  aria-haspopup="dialog"
                  onClick={() => openDialog({ kind: 'contract', entry: e })}
                  title={t('cfix.buttonWhy')}
                >
                  {t('cfix.button')}
                </button>
              )}
              {/*
               * On the row itself: a task stopped by a limit is noticed here, and carrying it on
               * used to mean finding its card on the session page or the grouped panel above.
               */}
              {continuable(e) && !e.sessionRunning && !e.sessionInactive && (
                <button
                  className={continuing === e.taskId ? '' : 'primary'}
                  aria-expanded={continuing === e.taskId}
                  onClick={() => setContinuing(continuing === e.taskId ? null : e.taskId)}
                  title={t('reg.continueHereWhy')}
                >
                  {t('reg.continueHere')}
                </button>
              )}
              {/*
               * A task that failed or blocked on its work starts again rather than carrying on — but
               * on its own, from its row, without the rest of the queue going with it.
               */}
              {!continuable(e) && (e.status === 'failed' || e.status === 'blocked') && !e.sessionRunning && !e.sessionInactive && (
                <button
                  // Run as it is, a task that contradicts itself only stops again: the fix beside it is the way on.
                  className={continuing === e.taskId || e.stopCode === 'contract-conflict' ? '' : 'primary'}
                  aria-expanded={continuing === e.taskId}
                  onClick={() => setContinuing(continuing === e.taskId ? null : e.taskId)}
                  title={t('reg.rerunHereWhy')}
                >
                  {t('reg.rerunHere')}
                </button>
              )}
              {FAILED_STATUSES.includes(e.status) && !e.sessionRunning && (
                <button className="quiet" aria-haspopup="dialog" onClick={() => openDialog({ kind: 'fix-prompt', entry: e })} title={t('reg.fixPromptHint')}>
                  {t('reg.fixPrompt')}
                </button>
              )}
              {/*
               * A finished task can be given a new instruction too — "now also do this", "change
               * that" — and it builds on what the task did rather than starting it over. See
               * `Task.buildsOn`.
               */}
              {e.status === 'done' && !e.sessionRunning && (
                <button className="quiet" aria-haspopup="dialog" onClick={() => openDialog({ kind: 'fix-prompt', entry: e })} title={t('reg.newPromptHint')}>
                  {t('reg.newPrompt')}
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
            {continuing === e.taskId && (continuable(e) || e.status === 'failed' || e.status === 'blocked') && !e.sessionRunning && (
              <ContinueHere
                entry={e}
                onClose={(started) => {
                  setContinuing(null);
                  if (started) onChange?.();
                }}
              />
            )}
            {runPanel?.taskId === e.taskId && e.status === 'queued' && (
              <RunQueuedPanel
                target={{ sessionId: e.sessionId, taskId: e.taskId, title: e.title }}
                onClose={(started) => {
                  setRunPanel(null);
                  if (started) onChange?.();
                }}
              />
            )}
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


/** Where tasks of the same title live in other sessions: each one's session, when it was added, its status and attempt. */
function TwinChips({ entry, twins }: { entry: RegistryEntry; twins?: RegistryEntry[] }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  if (!twins || twins.length === 0) return null;
  const why = t('twin.why', { mine: fmtTime(entry.createdAt), attempt: entry.attempt ?? 1 });
  return (
    <>
      <span className="chip twin" title={why}>
        {t('twin.sameTitle', { n: twins.length })}
      </span>
      {twins.map((o) => (
        <span key={`${o.sessionId}:${o.taskId}`} className="chip twin" title={why}>
          {t('twin.alsoIn', { session: o.sessionName, when: fmtTime(o.createdAt), status: t(`status.${o.status}` as Key), attempt: o.attempt ?? 1 })}
        </span>
      ))}
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
  /*
   * Choosing is a mode, and it is off until it is asked for.
   *
   * The selection is held here rather than inside each run's fold, because the question it
   * answers crosses them: the three tasks worth handing over together are as often one from each
   * of three runs as three from one. A fold that closed and forgot what was ticked in it would
   * make exactly the case this exists for impossible.
   */
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const keyOf = (e: RegistryEntry) => `${e.sessionId}:${e.taskId}`;
  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // A task that never ran has no work and no runner to export, so it is not offered.
  const choosable = entries.filter((e) => e.startedAt);
  const chosen = [...picked];

  const download = async () => {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const name = await api.downloadBundle(
        chosen.map((key) => {
          const [sessionId, taskId] = key.split(':');
          return { sessionId, taskId };
        }),
      );
      setMsg(t('reg.bundleSaved', { name }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const selection = picking ? { picked, toggle } : undefined;

  return (
    <>
      <div className="row small" style={{ marginBottom: 8 }}>
        {picking ? (
          <>
            <button className="quiet" onClick={() => { setPicking(false); setPicked(new Set()); setMsg(''); setErr(''); }}>
              {t('reg.pickDone')}
            </button>
            <button className="quiet" onClick={() => setPicked(new Set(choosable.map(keyOf)))}>
              {t('reg.pickAll')}
            </button>
            <button className="quiet" onClick={() => setPicked(new Set())}>
              {t('reg.pickNone')}
            </button>
            <span className="muted">{picked.size > 0 ? t('reg.pickedN', { n: picked.size }) : t('reg.pickedNone')}</span>
            {picked.size > 0 && (
              <button className="primary" disabled={busy} onClick={() => void download()} title={t('reg.bundleWhy')}>
                {t('reg.bundle', { n: picked.size })}
              </button>
            )}
          </>
        ) : (
          <button className="quiet" onClick={() => setPicking(true)} title={t('reg.pickWhy')}>
            {t('reg.pick')}
          </button>
        )}
        {msg && <span className="muted">{msg}</span>}
        {err && <span className="err">{err}</span>}
      </div>
      {grouped.runs.map((run, i) => (
        <details key={run.id} className="run-fold" open={i === 0 || picking}>
          <summary>
            <RunHeading run={run} />
          </summary>
          <Flow entries={run.entries} sizes={sizes} onChange={onChange} picking={selection} />
        </details>
      ))}
      {grouped.loose.length > 0 && (
        <details className="run-fold" open={grouped.runs.length === 0 || picking}>
          <summary>
            <div className="run-heading">
              <h2 style={{ margin: 0 }}>{t('reg.notInARun')}</h2>
              <p className="muted small" style={{ margin: '4px 0 0' }}>{t('reg.notInARunHint')}</p>
            </div>
          </summary>
          <Flow entries={grouped.loose} sizes={sizes} onChange={onChange} picking={selection} />
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
function FixPromptDialog({
  entry,
  onClose,
  offerRun = false,
}: {
  entry: RegistryEntry;
  onClose: (changed: boolean) => void;
  /**
   * After saving, ask whether to run it now instead of closing. Off inside the Continue panel, which
   * is itself the way to run what was just queued.
   */
  offerRun?: boolean;
}) {
  const { t } = useT();
  const [prompt, setPrompt] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  /** Saved and queued: the dialog now asks whether to run it. */
  const [saved, setSaved] = useState(false);
  /*
   * What the new prompt keeps from the old contract. A failed task given a fixed prompt is the same
   * question worded better, so its checks start ticked; a done task given a new prompt is a new
   * question, so they start unticked and the operator ticks what still applies. Checks earlier
   * reviews added are dropped by the API whenever the prompt changes.
   */
  const [checks, setChecks] = useState<TaskCheck[]>([]);
  const [kept, setKept] = useState<Set<number>>(new Set());
  const [readOnly, setReadOnly] = useState(false);
  const [scope, setScope] = useState('');
  const [original, setOriginal] = useState('');
  const boxRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(boxRef, true);
  // Escape leaves it, as it does the other two dialogs; it did nothing here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      /*
       * Not when an "are you sure" box inside it (Run without asking) takes the key: that box marks it
       * handled when its listener runs first, and is still on the page when this one does.
       */
      if (e.key === 'Escape' && !e.defaultPrevented && !busy && !document.querySelector('[role="alertdialog"]')) onClose(saved);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, saved, onClose]);

  useEffect(() => {
    let live = true;
    api
      .session(entry.sessionId)
      .then((s) => {
        const task = s.tasks.find((x) => x.id === entry.taskId);
        if (!live) return;
        setPrompt(task?.prompt ?? '');
        setOriginal(task?.prompt ?? '');
        const list = task?.checks ?? [];
        setChecks(list);
        setKept(new Set(entry.status === 'done' ? [] : list.map((_, i) => i)));
        setReadOnly(!!task?.readOnly);
        setScope((task?.scope ?? []).join('\n'));
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
      // A finished task's new prompt builds on its work; a failed one's starts again.
      await api.rerunTask(
        entry.sessionId,
        entry.taskId,
        { prompt, checks: checks.filter((_, i) => kept.has(i)), readOnly, scope: readOnly ? [] : scopeLines(scope) },
        { buildOnFinished: entry.status === 'done' },
      );
      setMsg(t('reg.fixPromptSaved', { title: entry.title }));
      if (offerRun) {
        setSaved(true);
        setBusy(false);
      } else setTimeout(() => onClose(true), 900);
    } catch (e) {
      setMsg((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => onClose(saved)}>
      <div ref={boxRef} className="modal wide" role="dialog" aria-modal="true" aria-labelledby="fix-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="fix-title">{t('reg.fixPromptTitle', { title: entry.title })}</h2>
        {saved ? (
          /*
           * Saved and queued: what running it would take, and the two ways to start, here in the dialog
           * the operator is already looking at — not on a row that has just moved to another list.
           */
          <RunQueuedPanel
            target={{ sessionId: entry.sessionId, taskId: entry.taskId, title: entry.title }}
            intro={`${msg} ${t('runq.ask')}`}
            focusFirst
            onClose={() => onClose(true)}
          />
        ) : (
          <>
        <p className="muted small">{t(entry.status === 'done' ? 'reg.newPromptHint' : 'reg.fixPromptHint')}</p>
        {entry.reason && <p className="what err small">{t('reg.stopped', { reason: entry.reason })}</p>}
        {prompt === null ? (
          <p className="muted small">{msg || t('reg.fixPromptLoading')}</p>
        ) : (
          <textarea className="prose" aria-labelledby="fix-title" value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ minHeight: 260 }} disabled={busy} />
        )}
        {prompt !== null && checks.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <strong className="small">{t('reg.keepChecks')}</strong>
            <p className="why">{t('reg.keepChecksWhy')}</p>
            {checks.map((c, i) => (
              <div className="option" key={i} style={{ margin: '4px 0' }}>
                <label>
                  <input
                    type="checkbox"
                    checked={kept.has(i)}
                    onChange={(e) =>
                      setKept((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(i);
                        else next.delete(i);
                        return next;
                      })
                    }
                  />
                  <span>{c.name}</span>
                </label>
              </div>
            ))}
          </div>
        )}
        {prompt !== null && prompt.trim() !== original.trim() && <p className="notice caution small">{t('task.newIntentNote')}</p>}
        {prompt !== null && <ContractFields readOnly={readOnly} scope={scope} onReadOnly={setReadOnly} onScope={setScope} />}
        <div className="row modal-actions">
          {msg && prompt !== null && <span className="small grow">{msg}</span>}
          <button type="button" className="quiet" onClick={() => onClose(false)} disabled={busy}>
            {t('dialog.cancel')}
          </button>
          <button type="button" className="primary" onClick={() => void save()} disabled={busy || prompt === null || !prompt.trim()}>
            {t('reg.fixPromptSave')}
          </button>
        </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * "Fix the contradiction" on a row: the ways out, then — once nothing is left in the way — the offer to
 * run it, in one dialog held by the page (see `TaskDialog`). A partial fix keeps the dialog on what is
 * still in the way.
 */
function ContractDialog({ entry, onChange, onClose }: { entry: RegistryEntry; onChange: () => void; onClose: (changed: boolean) => void }) {
  const { t } = useT();
  const [changed, setChanged] = useState(false);
  /** Nothing left in the way: what was changed, said first in the offer to run it. */
  const [ready, setReady] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(boxRef, true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="alertdialog"]')) onClose(changed);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [changed, onClose]);
  const target = { sessionId: entry.sessionId, taskId: entry.taskId, title: entry.title };
  return (
    <div className="modal-backdrop" role="presentation" onClick={() => onClose(changed)}>
      <div ref={boxRef} className="modal wide" role="dialog" aria-modal="true" aria-labelledby="contract-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="contract-title">{t('cfix.button')}</h2>
        {entry.reason && <p className="what err small">{t('reg.stopped', { reason: entry.reason })}</p>}
        {ready !== null ? (
          <RunQueuedPanel target={target} intro={`${ready} ${t('runq.savedOffer')}`} focusFirst onClose={() => onClose(true)} />
        ) : (
          <>
            <ContractFixPanel
              target={target}
              onApplied={(remaining, said) => {
                setChanged(true);
                onChange();
                if (remaining === 0) setReady(said);
              }}
            />
            <div className="row modal-actions">
              <button type="button" className="quiet" onClick={() => onClose(changed)}>
                {changed ? t('runq.later') : t('dialog.cancel')}
              </button>
            </div>
          </>
        )}
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
      <Link href="/#new-session" className="button-link">
        {t('reg.newSession')}
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
              if (e.target.value) window.location.href = sessionHref(e.target.value, 'new-task');
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
/**
 * "Continue where it stopped" on one row: what will happen to the chat, the branch and the files,
 * then the same two ways to start that the rest of the page has.
 *
 * It queues the task to carry on (`continueTask`) and starts that one task alone; the rest of its
 * session's queue stays where it is. What it says about the branch is read from the attempt's own
 * record — committed, nothing new, not committed and why, or no version control at all — because
 * "is my work safe" is the question this button is pressed with.
 */
function ContinueHere({ entry: e, onClose }: { entry: RegistryEntry; onClose: (started: boolean) => void }) {
  const { t } = useT();
  const quietStart = useUnattendedWithoutAsking();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // Stopped: carried on where it stopped. Failed or blocked on its work: a new attempt, the same way alone.
  const carryOn = continuable(e);
  const branchLine = !carryOn
    ? t('reg.rerunHereBranch')
    : e.branch
    ? e.commit
      ? t('reg.continueHereCommitted', { branch: e.branch, commit: e.commit.slice(0, 8) })
      : e.vcsProblem
        ? t('reg.continueHereNotCommitted', { branch: e.branch, problem: e.vcsProblem })
        : t('reg.continueHereNothingNew', { branch: e.branch })
    : e.vcsProblem
      ? t('reg.continueHereVcsInactive', { problem: e.vcsProblem })
      : t('reg.continueHereNoVcs');
  const start = async (mode: 'confirm' | 'unattended') => {
    if (mode === 'unattended' && !quietStart && !(await confirmDialog(t('batch.unattendedConfirm', { n: 1 })))) return;
    setBusy(true);
    setMsg('');
    try {
      if (carryOn) await api.continueTask(e.sessionId, e.taskId);
      else await api.rerunTask(e.sessionId, e.taskId);
      const name = await api.suggestedRunName([e.sessionId]).then((r) => r.name).catch(() => undefined);
      const r = await api.startBatch([e.sessionId], mode, 'stop', undefined, undefined, name, [e.taskId]);
      if (!r.started) {
        // Queued to continue all the same: the grouped "Continue" above, or the session page, starts it.
        setMsg(t('batch.notStarted', { reason: r.reason ?? '' }));
        return;
      }
      setMsg(t('reg.continueHereStarted', { title: e.title }));
      onClose(true);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="notice" role="group" aria-label={t(carryOn ? 'reg.continueHereTitle' : 'reg.rerunHereTitle', { title: e.title })} style={{ marginTop: 8 }}>
      <strong>{t(carryOn ? 'reg.continueHereTitle' : 'reg.rerunHereTitle', { title: e.title })}</strong>
      {e.reason && <p className="small">{e.reason}</p>}
      <ul className="small">
        <li>{t(carryOn ? 'reg.continueHereChat' : 'reg.rerunHereChat')}</li>
        <li>{branchLine}</li>
        <li>{t(carryOn ? 'reg.continueHereCount' : 'reg.rerunHereKept')}</li>
        <li>{t('reg.continueHereAlone')}</li>
      </ul>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void start('confirm')} title={t('reg.continueWhy')}>
          {t('reg.continueGo')}
        </button>
        <button disabled={busy} onClick={() => void start('unattended')} title={t('reg.continueUnattendedWhy')}>
          {t('reg.continueUnattended')}
        </button>
        <button className="quiet" disabled={busy} onClick={() => onClose(false)}>
          {t('dialog.cancel')}
        </button>
        {msg && <span className="small">{msg}</span>}
      </div>
    </div>
  );
}

/** In the Continue panel and the list view: which of several tasks of one title this is. */
function TwinMark({ entry }: { entry: RegistryEntry }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const twins = useContext(TwinsContext).get(`${entry.sessionId}:${entry.taskId}`);
  if (!twins || twins.length === 0) return null;
  return <span className="muted small"> · {t('twin.mark', { when: fmtTime(entry.createdAt), attempt: entry.attempt ?? 1 })}</span>;
}

function ContinueRun({ entries, onChange }: { entries: RegistryEntry[]; onChange: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(false);
  /**
   * The tasks this run takes, by id: queued ones and failed ones alike. Everything is ticked when
   * the panel opens, which is what "continue" always did; unticking narrows it, down to the one
   * task whose prompt was just fixed. What is not ticked stays exactly where it is.
   */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** A failed task whose prompt is being rewritten from inside this panel. */
  const [fixingHint, setFixingHint] = useState<RegistryEntry | null>(null);

  /*
   * What "continue" means depends on the session, and the choice is the operator's.
   *
   * A session whose tasks are one chain stops at a failure, and the queued tasks behind it were
   * written assuming it worked: running them without it runs them against a state that does not
   * exist. So its failed task is offered first and ticked. A session of independent tasks has no
   * such condition. Every task can be unticked — the case this was made for is "I fixed one
   * prompt; run that one, not everything else that is waiting" — and a chain task run without
   * an earlier one of its session is said, not refused, because the operator may know it does
   * not matter.
   */
  // A session set aside on the Sessions page is not offered: its tasks wait until it is active again.
  const upcoming = entries.filter((e) => e.status === 'queued' && !e.sessionInactive);
  const failed = entries.filter((e) => FAILED_STATUSES.includes(e.status) && !e.sessionRunning && !e.sessionInactive);
  const anyRunning = entries.some((e) => e.sessionRunning);
  const chainFailed = failed.filter((e) => e.sessionOnFailure === 'stop');
  const looseFailed = failed.filter((e) => e.sessionOnFailure !== 'stop');
  const candidates = [...upcoming, ...failed];
  const chosen = candidates.filter((e) => picked.has(e.taskId));
  const requeue = failed.filter((e) => picked.has(e.taskId));
  const chosenQueued = upcoming.filter((e) => picked.has(e.taskId));
  // Sessions in the order the last run had them, then by first appearance: the order they run in.
  const ordered = [...chosen].sort(
    (a, b) => (a.sessionRunOrder ?? Number.MAX_SAFE_INTEGER) - (b.sessionRunOrder ?? Number.MAX_SAFE_INTEGER) || a.position - b.position,
  );
  const sessionIds = [...new Set(ordered.map((e) => e.sessionId))];
  // A chosen task of a chain whose session has an earlier task left out: said beside the buttons.
  const gaps = chosen
    .filter((e) => e.sessionOnFailure === 'stop')
    .map((e) => ({ e, before: candidates.find((o) => o.sessionId === e.sessionId && o.position < e.position && !picked.has(o.taskId)) }))
    .filter((g): g is { e: RegistryEntry; before: RegistryEntry } => !!g.before);
  const tick = (id: string, on: boolean): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  /*
   * What this run will be called, suggested by the API and editable here.
   *
   * It used to take the previous run's name verbatim, so two attempts at the same work appeared
   * in the register under one heading and could not be told apart — and where the first run had
   * no name, the second had none either and read as "Unnamed run". The suggestion is the API's
   * rather than this page's because "Run again from here", which starts the same kind of run from
   * a task card, has no field to type into and needs the same answer.
   */
  const [name, setName] = useState('');
  const label =
    chainFailed.length > 0
      ? t('reg.continueWithFailed', { f: chainFailed.length, n: upcoming.length, s: sessionIds.length })
      : t('reg.continue', { n: upcoming.length, s: sessionIds.length });

  const openPanel = () => {
    setPicked(new Set(candidates.map((e) => e.taskId)));
    setOpen(true);
    setMsg('');
    // Asked for when the panel opens rather than kept in step with every tick: what is chosen
    // below changes which tasks run, not what the run is about. The sessions are the ones just
    // ticked — every candidate's — not `sessionIds`, which still reflects the selection before
    // this click (empty the first time, so the name was suggested from no sessions at all).
    const opening = [...new Set(
      [...candidates]
        .sort((a, b) => (a.sessionRunOrder ?? Number.MAX_SAFE_INTEGER) - (b.sessionRunOrder ?? Number.MAX_SAFE_INTEGER) || a.position - b.position)
        .map((e) => e.sessionId),
    )];
    void api
      .suggestedRunName(opening)
      .then((r) => setName(r.name))
      .catch(() => undefined);
  };

  // Settings → Execution can say an unattended start needs no "are you sure"; see the hook.
  const quietStart = useUnattendedWithoutAsking();
  const start = async (mode: 'confirm' | 'unattended') => {
    if (mode === 'unattended' && !quietStart && !(await confirmDialog(t('batch.unattendedConfirm', { n: sessionIds.length })))) return;
    setBusy(true);
    setMsg('');
    try {
      // A task that stopped before it finished carries on where it stopped, in its chat and on its
      // branch; one with a verdict on its work starts again.
      for (const e of requeue) {
        if (continuable(e)) await api.continueTask(e.sessionId, e.taskId);
        else await api.rerunTask(e.sessionId, e.taskId);
      }
      // Exactly what is ticked: the queued tasks nobody chose stay queued for another run.
      const r = await api.startBatch(sessionIds, mode, 'stop', undefined, undefined, name.trim() || undefined, chosen.map((e) => e.taskId));
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
          {label}
        </button>
        {anyRunning && <span className="muted small">{t('reg.continueRunning')}</span>}
        {msg && <span className="small">{msg}</span>}
      </div>
      {open && !anyRunning && (
        <div className="notice" style={{ marginTop: 8 }}>
          <strong>{t('reg.continuePanelTitle')}</strong>
          {/* Said and done in one place: how many are ticked, and the two buttons that change all of them. */}
          <div className="row" style={{ marginTop: 6 }}>
            <span className="small">{t('reg.pickedCount', { n: chosen.length, of: candidates.length })}</span>
            <button className="small" onClick={() => setPicked(new Set())} disabled={chosen.length === 0}>
              {t('reg.pickNone')}
            </button>
            <button className="small" onClick={() => setPicked(new Set(candidates.map((e) => e.taskId)))} disabled={chosen.length === candidates.length}>
              {t('reg.pickAll')}
            </button>
          </div>
          {[
            { key: 'chain', entries: chainFailed, intro: t('reg.continueChain'), fix: true },
            { key: 'loose', entries: looseFailed, intro: t('reg.continueIndependent'), fix: true },
            { key: 'queued', entries: upcoming, intro: t('reg.continueQueued'), fix: false },
          ]
            .filter((group) => group.entries.length > 0)
            .map((group) => (
              <div key={group.key} style={{ marginTop: 6 }}>
                <div className="small">{group.intro}</div>
                <ul className="small" style={{ margin: '4px 0', paddingLeft: 18, listStyle: 'none' }}>
                  {group.entries.map((e) => (
                    <li key={e.taskId}>
                      <label className="option-inline">
                        <input type="checkbox" checked={picked.has(e.taskId)} onChange={(ev) => tick(e.taskId, ev.target.checked)} />
                        <strong>{e.title}</strong> · {e.sessionName} · <span className={`badge ${e.status}`}>{t(`status.${e.status}` as Key)}</span>
                        <TwinMark entry={e} />
                        {continuable(e) && <span className="muted small"> · {t('reg.willContinue')}</span>}
                      </label>{' '}
                      {/* The use case this panel grew for: one fixed task, run on its own. */}
                      <button className="quiet small" onClick={() => setPicked(new Set([e.taskId]))} title={t('reg.pickOnlyWhy')}>
                        {t('reg.pickOnly')}
                      </button>
                      {group.fix && (
                        <>
                          {' '}
                          <button className="quiet small" onClick={() => setFixingHint(e)} title={t('reg.fixPromptHint')}>
                            {t('reg.fixPrompt')}
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          {gaps.length > 0 && (
            <div className="notice caution small" style={{ marginTop: 6 }}>
              {gaps.map((g) => (
                <div key={g.e.taskId}>{t('reg.continueGap', { task: g.e.title, before: g.before.title, session: g.e.sessionName })}</div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <label htmlFor="continue-run-name">{t('batch.runName')}</label>
            <input
              id="continue-run-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('batch.runNamePlaceholder')}
              disabled={busy}
            />
            <p className="why">{t('reg.continueNameWhy')}</p>
          </div>
          <div className="small" style={{ marginTop: 6 }}>
            {t('reg.continueSummary', { q: chosenQueued.length, r: requeue.length, s: sessionIds.length })}
          </div>
          {/*
            The unattended button is the left one, and the left one is the loud one.

            The styles did not move: the primary is still the left slot and the plain button
            still the right one. Only which choice sits in each did, so a hand that learned the
            old order lands on a differently worded button rather than on a silently different
            behaviour.
          */}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy || sessionIds.length === 0} onClick={() => void start('unattended')} title={t('reg.continueUnattendedWhy')}>
              {t('reg.continueUnattended')}
            </button>
            <button disabled={busy || sessionIds.length === 0} onClick={() => void start('confirm')} title={t('reg.continueWhy')}>
              {t('reg.continueGo')}
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
                <Link href={sessionHref(e.sessionId, e.taskId)}>{e.title}</Link>
                <TwinMark entry={e} />
              </td>
              <td>
                <Link href={sessionHref(e.sessionId)}>{e.sessionName}</Link>
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
