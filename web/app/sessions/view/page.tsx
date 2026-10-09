'use client';

import { Suspense, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { API, api, withToken, fmtBytes, CHECK_KINDS, checkNeedsCommand, checkNeedsValue, type Approval, type TaskCheck, type ModelCatalogue, type Handoff, type Preset, type Session, type SessionEvent, type Task, type TaskDeviation, type TaskDispute, type TaskReview, type SnapshotPlan, type VcsStatus, type VersionControl } from '../../../lib/api';
import { useT, useFmtTime, type Key } from '../../../lib/i18n';
import { AttemptRecord, SaveLog } from '../../saveLog';
import { fmtDuration, isContinuable } from '../../../lib/api';
import { elapsedMs, isLive, latestRun, runSpanMs } from '../../../lib/clock';
import { useNow } from '../../../lib/useNow';
import { useAppearance } from '../../../lib/appearance';
import { ModelHint, ProjectHint, ReviewModelHint } from '../../defaultHints';
import { ModelPicker } from '../../modelPicker';
import { TaskStory } from '../../taskStory';
import { RichText } from '../../richText';
import { confirmDialog } from '../../dialog';
import { ChangesButton } from '../../diffView';
import { useUnattendedWithoutAsking } from '../../../lib/useUnattendedWithoutAsking';
import { useTaskActions } from '../../taskActions';
import { usePoll } from '../../../lib/usePoll';
import { ContractFields, scopeLines } from '../../contractFields';
import { PrepareFolder } from '../../prepareFolder';
import { ContractFixPanel, RunQueuedPanel } from '../../runQueued';

// ---------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------

/*
 * The session's page. Its address is `/sessions/view?id=<id>` rather than `/sessions/<id>`: the
 * interface an npm install carries is built once, as static files, and a static build cannot hold a
 * page for every session id there will ever be. A query string is read in the browser instead.
 * `useSearchParams` needs a Suspense boundary in such a build, hence the wrapper.
 */
export default function SessionPageRoute() {
  return (
    <Suspense fallback={null}>
      <SessionPage />
    </Suspense>
  );
}

function SessionPage() {
  const { t } = useT();
  const id = useSearchParams().get('id') ?? '';
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [level1, setLevel1] = useState<{ content: string; customised: boolean } | null>(null);
  const [err, setErr] = useState('');
  const [streamClosed, setStreamClosed] = useState(false);
  const refreshTimer = useRef<number | null>(null);
  /*
   * Which reload is the newest. Reloads come from the poll, from the live events and from every
   * button on the page, and a slow one could land after a quicker one sent later — the page then
   * showed a session as idle again a moment after Start, with its run buttons live. Only the answer
   * to the latest request is shown.
   */
  const latest = useRef(0);

  const reload = useCallback(async () => {
    if (!id) return;
    const mine = ++latest.current;
    try {
      const fresh = await api.session(id);
      if (mine !== latest.current) return;
      setSession(fresh);
      setErr('');
    } catch (e) {
      if (mine !== latest.current) return;
      setErr((e as Error).message);
    }
  }, [id]);

  // Coalesce bursts of events into one reload.
  const scheduleReload = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void reload();
    }, 400);
  }, [reload]);

  useEffect(() => {
    if (!id) return;
    api.presets().then(setPresets).catch(() => undefined);
    api.level1().then(setLevel1).catch(() => undefined);

    const es = new EventSource(api.streamUrl(id));
    es.onopen = () => setStreamClosed(false);
    es.onmessage = (m) => {
      let e: SessionEvent;
      try {
        e = JSON.parse(m.data) as SessionEvent;
      } catch {
        return;
      }
      if (e.type === 'ping') return;
      setEvents((prev) => [...prev.slice(-400), e]);
      scheduleReload();
    };
    es.onerror = () => {
      // A dropped connection is retried by the browser on its own; a refused one (the API said no,
      // or is gone) is closed for good, and the live log would otherwise just go quiet.
      if (es.readyState === EventSource.CLOSED) setStreamClosed(true);
    };
    return () => {
      es.close();
    };
  }, [id, scheduleReload]);

  // The session itself, read now and every eight seconds besides whatever the live events trigger.
  usePoll(reload, 8000, Boolean(id));

  if (!id) return <div className="panel err">{t('session.noId')}</div>;
  if (err && !session) return <div className="panel err">{err}</div>;
  if (!session) return <div className="panel muted">{t('home.loading')}</div>;

  const queued = session.tasks.filter((x) => x.status === 'queued').length;

  return (
    <>
      <div className="crumbs">
        <Link href="/">{t('session.crumb')}</Link> / {session.name}
      </div>

      {err && (
        <div className="panel err" role="alert">
          {t('session.stale', { err })}
        </div>
      )}
      {streamClosed && !err && (
        <div className="panel muted small" role="status">
          {t('session.streamClosed')}
        </div>
      )}

      <Header session={session} queued={queued} onChange={reload} />

      <RunClock tasks={session.tasks} />

      {/* A step waiting for a decision is shown by the layout, on every page (app/approvals.tsx). */}

      <ModelPanel session={session} onChange={reload} />

      <Level1Panel level1={level1} sent={session.contractSent} />

      <VcsPanel session={session} onChange={reload} />

      <ReviewPanel session={session} onChange={reload} />


      <div className="panel">
        <h2>{t('tasks.title')}</h2>
        <p className="muted small">{t('tasks.hint')}</p>
        <ChainMode session={session} onChange={reload} />
        {session.tasks.length === 0 && <div className="muted">{t('tasks.none')}</div>}
        {session.tasks.map((task, i) => (
          <TaskCard key={task.id} session={session} task={task} index={i + 1} presets={presets} onChange={reload} />
        ))}
      </div>

      <ExportPanel session={session} />

      <TaskForm session={session} presets={presets} onAdded={reload} onPresetsChanged={() => api.presets().then(setPresets)} />

      <EventLog events={events} />
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Header: name, chat link, run controls
// ---------------------------------------------------------------------------------------

function Header({ session, queued, onChange }: { session: Session; queued: number; onChange: () => void }) {
  const { t } = useT();
  const [msg, setMsg] = useState('');
  // The model chosen in Settings, which a session without one of its own follows.
  const [settingsModel, setSettingsModel] = useState('');
  useEffect(() => {
    api.models().then((c) => setSettingsModel(c.defaultModel ?? '')).catch(() => undefined);
  }, []);
  const [name, setName] = useState(session.name);
  const [group, setGroup] = useState(session.conversationGroup ?? '');
  useEffect(() => setName(session.name), [session.name]);
  useEffect(() => setGroup(session.conversationGroup ?? ''), [session.conversationGroup]);

  // Settings → Execution can say an unattended start needs no "are you sure"; see the hook.
  const quietStart = useUnattendedWithoutAsking();
  /*
   * One request at a time from this header, and every failure said beside the buttons. The buttons
   * used to stay live until the next reload, so a double click sent two starts, and a start the API
   * refused with an error (not with `started: false`) vanished without a word.
   */
  const [busy, setBusy] = useState(false);
  // The guard is a ref: the second click of a double click arrives before React has re-rendered
  // with `busy` true, so a check of the state alone let it through.
  const inFlight = useRef(false);
  const act = async (fn: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
      onChange();
    }
  };
  const start = async (mode: 'confirm' | 'unattended') => {
    if (mode === 'unattended' && !quietStart && !(await confirmDialog(t('session.unattendedConfirm')))) return;
    await act(async () => {
      const r = await api.start(session.id, mode, session.planName);
      setMsg(
        r.started
          ? t(mode === 'unattended' ? 'session.startedAuto' : 'session.startedStep')
          : t('session.notStarted', { reason: r.reason ?? '' }),
      );
    });
  };
  const stop = () =>
    act(async () => {
      await api.stop(session.id);
      setMsg(t('session.stopping'));
    });
  const askAgain = () =>
    act(async () => {
      await api.setRunMode(session.id, 'confirm');
      setMsg(t('session.askingAgain'));
    });
  const rename = () =>
    act(async () => {
      if (name.trim() && name !== session.name) await api.updateSession(session.id, { name });
    });
  const remove = async () => {
    if (session.running) {
      setMsg(t('home.deleteRunning'));
      return;
    }
    if (!(await confirmDialog(t('home.deleteConfirm', { name: session.name, n: session.tasks.length })))) return;
    try {
      await api.deleteSession(session.id);
      window.location.href = '/';
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const saveGroup = async () => {
    if (group.trim() === (session.conversationGroup ?? '')) return;
    try {
      await api.updateSession(session.id, { conversationGroup: group.trim() });
      setMsg(t('session.groupSaved'));
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const stateLabel = session.running ? t('state.running') : t(`state.${session.status}` as Key);

  return (
    <div className="panel">
      <div className="row">
        <input type="text" className="grow" aria-label={t('home.col.name')} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void rename()} />
        <span className={`badge ${session.running ? 'running' : ''}`}>{stateLabel}</span>
      </div>
      {/*
        Running on its own comes first and carries the accent, because it is what almost every
        run is. Step by step is the tool you reach for when something has gone wrong, and a tool
        for that deserves to be present without being the thing your eye lands on first.
      */}
      {!session.running && (
        <div className="run-choice">
          <div>
            <button className="primary" onClick={() => void start('unattended')} disabled={busy || queued === 0}>
              {t('session.run', { n: queued })}
            </button>
            <p className="why">{t('session.runWhy')}</p>
          </div>
          <div>
            <button onClick={() => void start('confirm')} disabled={busy || queued === 0}>
              {t('session.runStep')}
            </button>
            <p className="why">{t('session.runStepWhy')}</p>
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        {session.running && (
          <>
            <button className="danger" onClick={() => void stop()} disabled={busy}>
              {t('session.stop')}
            </button>
            {/* A run switched to unattended says so, and can be put back to asking. */}
            {session.runMode === 'unattended' && (
              <>
                <span className="badge waiting-approval">{t('session.modeUnattended')}</span>
                <button onClick={() => void askAgain()} disabled={busy}>
                  {t('session.askAgain')}
                </button>
              </>
            )}
          </>
        )}
        <span className="muted small">{msg}</span>
        <span className="grow" />
        {/*
          Deleting from here as well as from the list, because this is the page someone is on
          when they decide a session was a false start. It takes the session out of the list and
          nothing else: the run folders and the Copilot conversation both survive.
        */}
        <button className="quiet" onClick={() => void remove()} disabled={session.running}>
          {t('home.delete')}
        </button>
        {session.chat ? (
          <a href={session.chat.url} target="_blank" rel="noreferrer" className="small">
            {t('session.openChat', { name: session.chat.name })}
          </a>
        ) : (
          <span className="muted small">{t('session.noChat')}</span>
        )}
      </div>

      {/*
        What this run will actually use, stated next to the button that starts it. These two
        settings belong to the session, and a session that looks identical to another one can
        be configured completely differently. A task written to read attached files was queued
        twice against a session that attaches none, and nothing on this page said so until the
        summary came back explaining that the file was not there.
      */}
      {/*
        Which conversation this session talks in. It sits by the chat link because that is the
        thing it decides, and it is only ever read at the moment a session first runs.
      */}
      <label htmlFor="session-group">{t('session.group')}</label>
      <div className="row">
        <input
          id="session-group"
          type="text"
          className="grow"
          value={group}
          placeholder={t('session.groupPlaceholder')}
          onChange={(e) => setGroup(e.target.value)}
          onBlur={() => void saveGroup()}
          disabled={session.running}
        />
      </div>
      <p className="why">
        {t('session.groupWhy')}
        {session.chat && ` ${t('session.groupHasChat')}`}
      </p>

      <div className="muted small" style={{ marginTop: 10 }}>
        {t('session.willUseModel', {
          // Settings outrank a model the plan named; the operator's own choice here outranks Settings.
          name: (session.model && (session.modelSource === 'operator' || !settingsModel) ? session.model : '') || (settingsModel ? t('model.followsDefault', { name: settingsModel }) : t('model.default')),
        })}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------------------
// Level 1, shown above the tasks
// ---------------------------------------------------------------------------------------

function Level1Panel({ level1, sent }: { level1: { content: string; customised: boolean } | null; sent: boolean }) {
  const { t } = useT();
  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          {t('l1.title')}
        </h2>
        <span className="badge">{sent ? t('l1.sent') : t('l1.notSent')}</span>
        <Link href="/level1" className="small">
          {t('l1.edit')}
        </Link>
      </div>
      <p className="muted small" style={{ marginBottom: 6 }}>
        {t('l1.hint')}
        {level1?.customised ? ` ${t('l1.customised')}` : ''}
      </p>
      <details>
        <summary>{t('l1.show')}</summary>
        <pre className="tall">{level1?.content ?? '…'}</pre>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Which Copilot model this conversation runs on
// ---------------------------------------------------------------------------------------

/**
 * The picker is a mirror of the chat's own picker, never a list this project maintains.
 *
 * Microsoft changes the line-up, and a tenant sees a different set from the next tenant, so
 * anything hard-coded here would be wrong within weeks. The options come from the live chat,
 * read on request and cached, because reading them opens the browser and takes the profile
 * that a run needs.
 */
function ModelPanel({ session, onChange }: { session: Session; onChange: () => void }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.models().then(setCatalogue).catch(() => undefined);
  }, []);

  const choose = async (name: string) => {
    try {
      await api.updateSession(session.id, { model: name });
      setMsg(name ? t('model.saved', { name }) : t('model.savedDefault'));
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  /** Stores what this session is set to as the choice new sessions will start on. */
  const makeDefault = async () => {
    try {
      const saved = await api.setDefaultModel(chosen);
      setCatalogue((c) => (c ? { ...c, defaultModel: saved.defaultModel } : c));
      setMsg(saved.defaultModel ? t('model.defaultSaved', { name: saved.defaultModel }) : t('model.defaultCleared'));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const refresh = async () => {
    if (!(await confirmDialog(t('model.refreshConfirm')))) return;
    setBusy(true);
    setMsg(t('model.refreshing'));
    try {
      const fresh = await api.refreshModels();
      setCatalogue(fresh);
      setMsg(fresh.options.length === 0 ? (fresh.note ?? t('model.none')) : t('model.refreshed', { n: fresh.options.length }));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // A model the plan named is not this session's own while Settings name one: Settings are used (2026-10-06).
  const planOutranked = !!session.model && session.modelSource !== 'operator' && !!catalogue?.defaultModel;
  const chosen = planOutranked ? '' : (session.model ?? '');
  const all = catalogue?.options ?? [];
  // A model saved before the list was last read still has to be selectable, or switching to
  // another one would silently drop it.
  const known = all.some((o) => o.name === chosen);
  const ungrouped = all.filter((o) => !o.group);
  const grouped = new Map<string, typeof all>();
  for (const o of all) {
    if (!o.group) continue;
    grouped.set(o.group, [...(grouped.get(o.group) ?? []), o]);
  }

  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          {t('model.title')}
        </h2>
        {session.modelInUse && <span className="chip">{t('model.lastUsed', { name: session.modelInUse })}</span>}
        {planOutranked && <p className="muted small">{t('model.planOutranked', { name: session.model ?? '' })}</p>}
      </div>
      <p className="muted small">{t('model.hint')}</p>

      <div className="row">
        <select
          aria-label={t('model.title')}
          value={chosen}
          disabled={session.running}
          onChange={(e) => void choose(e.target.value)}
          style={{ width: 'auto', minWidth: 260 }}
        >
          {/* The empty choice follows Settings, so it says which model that is today. */}
          <option value="">{catalogue?.defaultModel ? t('model.followsDefault', { name: catalogue.defaultModel }) : t('model.default')}</option>
          {chosen && !known && <option value={chosen}>{t('model.notInList', { name: chosen })}</option>}
          {ungrouped.map((o) => (
            <option key={o.name} value={o.name} disabled={o.disabled}>
              {o.name}
              {o.disabled ? ` — ${t('model.unavailable')}` : ''}
            </option>
          ))}
          {/* The picker nests a vendor's models under its own name; the groups are kept. */}
          {[...grouped.entries()].map(([group, items]) => (
            <optgroup key={group} label={group}>
              {items.map((o) => (
                <option key={o.name} value={o.name} disabled={o.disabled}>
                  {o.name}
                  {o.disabled ? ` — ${t('model.unavailable')}` : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button onClick={() => void refresh()} disabled={busy || session.running}>
          {t('model.refresh')}
        </button>
        <span className="muted small" role="status">
          {msg}
        </span>
      </div>
      <ModelHint current={chosen} onUse={(name) => void choose(name)} />

      {/*
        The standing choice, kept on this machine. A session with no model of its own follows it
        at the time it runs; one given its own model keeps that.
      */}
      <div className="row" style={{ marginTop: 8 }}>
        <span className="muted small">
          {catalogue?.defaultModel ? t('model.defaultIs', { name: catalogue.defaultModel }) : t('model.defaultIsNone')}
        </span>
        <button onClick={() => void makeDefault()} disabled={chosen === (catalogue?.defaultModel ?? '')}>
          {chosen ? t('model.makeDefault', { name: chosen }) : t('model.clearDefault')}
        </button>
      </div>

      {catalogue?.readAt ? (
        <p className="muted small" style={{ marginTop: 8 }}>
          {t('model.readAt', { t: fmtTime(catalogue.readAt), n: catalogue.options.length })}
          {catalogue.current ? ` ${t('model.chatWasOn', { name: catalogue.current })}` : ''}
          {catalogue.note ? ` ${catalogue.note}` : ''}
        </p>
      ) : (
        <p className="muted small" style={{ marginTop: 8 }}>
          {t('model.neverRead')}
        </p>
      )}

      {all.length > 0 && (
        <details>
          <summary>{t('model.showDetails')}</summary>
          <pre className="tall">
            {all
              .map(
                (o) =>
                  `${o.selected ? '*' : ' '} ${o.group ? `${o.group} > ` : ''}${o.name}` +
                  `${o.disabled ? '  [unavailable]' : ''}\n    ${o.raw.replace(/\n/g, ' | ')}`,
              )
              .join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Version control
// ---------------------------------------------------------------------------------------

/**
 * Whether this session works on branches of its own, and how.
 *
 * On by default. The runner does the git, not Copilot: branching and committing have to be
 * exact, and a step written by a model goes through improvisation, the approval gate and an
 * output pipeline already known to mangle text. Level 1 tells Copilot the repository is being
 * managed for it, so the two do not both reach for the same branch.
 */
/**
 * Whether the work gets a second opinion, and from which model.
 *
 * Two controls and a paragraph, because the feature is easy to describe and its cost is easy to
 * misjudge: it is an extra conversation per task, which is real time, and it is the only thing
 * here that looks for the defect nobody wrote a check for. Both halves belong on screen.
 */
function ReviewPanel({ session, onChange }: { session: Session; onChange: () => void }) {
  const { t } = useT();
  const current = session.review ?? { enabled: true, model: '' };
  const [enabled, setEnabled] = useState(current.enabled);
  const [model, setModel] = useState(current.model ?? '');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // The review model chosen in Settings, which a session without one of its own follows.
  const [settingsReview, setSettingsReview] = useState('');
  useEffect(() => {
    api.models()
      .then((c) => {
        setSettingsReview(c.defaultReviewModel ?? '');
        // The plan's review model gives way to the one in Settings, as the run does (2026-10-06).
        if (c.defaultReviewModel && session.reviewModelSource !== 'operator') setModel('');
      })
      .catch(() => undefined);
  }, [session.reviewModelSource]);

  const save = async () => {
    setBusy(true);
    setMsg('');
    try {
      await api.updateSession(session.id, { review: { enabled, model } });
      setMsg(t('review.saved'));
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          {t('review.title')}
        </h2>
        <span className={`badge ${enabled ? 'done' : ''}`}>{enabled ? t('review.on') : t('review.off')}</span>
      </div>
      <p className="muted small">{t('review.hint')}</p>

      <div className="option">
        <label>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={session.running} />
          <span>{t('review.enable')}</span>
        </label>
        <p className="why">{t('review.enableWhy')}</p>
      </div>

      <label htmlFor="review-model">{t('review.modelField')}</label>
      <div className="row">
        <ModelPicker
          id="review-model"
          chosen={model}
          onChange={setModel}
          none={settingsReview ? t('model.followsDefault', { name: settingsReview }) : t('review.modelSame')}
          disabled={session.running || !enabled}
        />
      </div>
      <p className="why">{t('review.modelWhy')}</p>
      <ReviewModelHint current={model} onUse={(name) => setModel(name)} />

      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={() => void save()} disabled={busy || session.running}>
          {t('review.save')}
        </button>
        {msg && <span className="muted small">{msg}</span>}
      </div>
    </div>
  );
}

/**
 * The uncommitted files a starting snapshot would take, one choice each, and the button that takes
 * it. What is sent is the whole list as shown: a repository that changed since is refused, so what
 * was approved is what is committed. Not taking it changes nothing; the run is refused until it is.
 */
function SnapshotList({ session, plan, onDone }: { session: Session; plan: SnapshotPlan; onDone: () => void }) {
  const { t } = useT();
  const initial = (): Record<string, 'include' | 'leave-out'> =>
    Object.fromEntries(plan.entries.filter((e) => e.choice).map((e) => [e.path, e.choice as 'include' | 'leave-out']));
  const key = JSON.stringify(plan.entries.map((e) => [e.path, e.choice]));
  const [choices, setChoices] = useState(initial);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setChoices(initial()), [key]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const taken = plan.entries.filter((e) => choices[e.path] === 'include').length;

  const take = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await api.vcsSnapshot(session.id, choices);
      setMsg(r.ok ? t('vcs.snapshotTaken', { branch: r.branch ?? '', commit: (r.commit ?? '').slice(0, 8) }) : (r.problem ?? ''));
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="option">
      <p className="small">{t('vcs.snapshotList', { n: plan.entries.length, branch: plan.baselineBranch ?? '—' })}</p>
      <ul style={{ margin: '4px 0', paddingLeft: 0, listStyle: 'none' }}>
        {plan.entries.map((e) => (
          <li key={e.path} style={{ marginBottom: 4, overflowWrap: 'anywhere' }}>
            <code>{e.path}</code>{' '}
            <span className="muted small">
              ({e.input ? `${t('vcs.snapshotInput')}, ` : ''}{t(`vcs.snapshotKind.${e.kind}`)}{e.size !== undefined ? `, ${fmtBytes(e.size)}` : ''})
            </span>{' '}
            {e.allowed.length === 0 ? (
              <span className="err small">{t('vcs.snapshotBlocked')}</span>
            ) : (
              <select
                aria-label={e.path}
                value={choices[e.path] ?? ''}
                onChange={(ev) => setChoices({ ...choices, [e.path]: ev.target.value as 'include' | 'leave-out' })}
                disabled={busy || session.running || e.allowed.length < 2}
              >
                {e.allowed.map((a) => (
                  <option key={a} value={a}>{t(a === 'include' ? 'vcs.snapshotInclude' : 'vcs.snapshotLeaveOut')}</option>
                ))}
              </select>
            )}
            {e.reason && <div className="muted small">{e.reason}</div>}
          </li>
        ))}
      </ul>
      <button className="primary" onClick={() => void take()} disabled={busy || session.running || !plan.ok || taken === 0}>
        {t('vcs.snapshotTake')}
      </button>
      <p className="why">{t('vcs.snapshotCancelWhy')}</p>
      {msg && <p className="small" role="status">{msg}</p>}
    </div>
  );
}

function VcsPanel({ session, onChange }: { session: Session; onChange: () => void }) {
  const { t } = useT();
  const vcs = session.vcs ?? { enabled: true, repoDir: '', branchMode: 'per-task' as const, commitOnFinish: true, branchPrefix: 'cop/' };
  const [repoDir, setRepoDir] = useState(vcs.repoDir);
  const [status, setStatus] = useState<VcsStatus | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const saved = JSON.stringify(vcs);
  /** Why the chosen folder cannot be used, asked of the API rather than guessed at here. */
  const [repoProblem, setRepoProblem] = useState<string | null>(null);
  const [branchName, setBranchName] = useState(vcs.branchName ?? '');
  useEffect(() => setBranchName((JSON.parse(saved) as VersionControl).branchName ?? ''), [saved]);
  const [baseBranch, setBaseBranch] = useState(vcs.baseBranch ?? '');
  useEffect(() => setBaseBranch((JSON.parse(saved) as VersionControl).baseBranch ?? ''), [saved]);
  // One pattern per line, saved when the field is left.
  const [inputsText, setInputsText] = useState((vcs.userInputs?.paths ?? []).join('\n'));
  useEffect(() => setInputsText(((JSON.parse(saved) as VersionControl).userInputs?.paths ?? []).join('\n')), [saved]);
  const [artifactsText, setArtifactsText] = useState((vcs.artifacts?.paths ?? []).join('\n'));
  useEffect(() => setArtifactsText(((JSON.parse(saved) as VersionControl).artifacts?.paths ?? []).join('\n')), [saved]);
  const lines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const [existingBranch, setExistingBranch] = useState(vcs.existingBranch ?? '');
  useEffect(() => setExistingBranch((JSON.parse(saved) as VersionControl).existingBranch ?? ''), [saved]);
  const startFrom = vcs.startFrom ?? 'head';
  useEffect(() => {
    setRepoDir((JSON.parse(saved) as VersionControl).repoDir);
  }, [saved]);

  /*
   * Whether the chosen folder is a repository at all, asked of the machine rather than guessed
   * from the path. It runs whether version control is on or off, because the answer is what
   * decides if it may be turned on; the session's own preflight only speaks once it already is.
   */
  const folder = (JSON.parse(saved) as VersionControl).repoDir || session.projectDir || '';
  useEffect(() => {
    let cancelled = false;
    if (!folder.trim()) {
      setRepoProblem(null);
      return;
    }
    api
      .repoCheck(folder)
      .then((r) => {
        if (!cancelled) setRepoProblem(r.ok ? null : (r.problem ?? null));
      })
      .catch(() => {
        if (!cancelled) setRepoProblem(null);
      });
    return () => {
      cancelled = true;
    };
  }, [folder]);

  const check = useCallback(() => {
    api
      .vcsStatus(session.id)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [session.id]);
  useEffect(check, [check, saved]);

  const save = async (patch: Partial<VersionControl>) => {
    try {
      await api.updateSession(session.id, { vcs: patch });
      setMsg(t('vcs.saved'));
      onChange();
      check();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const browse = async () => {
    setBusy(true);
    setMsg(t('mirror.browsing'));
    try {
      const picked = await api.browseFolder(repoDir.trim() || session.projectDir || undefined);
      if (picked.ok) {
        setRepoDir(picked.path);
        await save({ repoDir: picked.path });
      } else {
        setMsg(picked.cancelled ? t('mirror.browseCancelled') : (picked.reason ?? ''));
      }
    } catch (e) {
      // Without this the message stayed at "browsing…" for good when the request failed.
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Empty means the project the files are mirrored from, which is the usual case.
  const effectiveRepo = vcs.repoDir || session.projectDir || '';
  const canEnable = effectiveRepo.trim() !== '' && repoProblem === null;

  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          {t('vcs.title')}
        </h2>
        <span className={`badge ${vcs.enabled ? 'done' : ''}`}>{vcs.enabled ? t('vcs.on') : t('vcs.off')}</span>
      </div>
      <p className="muted small">{t('vcs.hint')}</p>

      {/*
        The folder comes first, and the switch is only live once that folder is a repository.
        Turning version control on somewhere it cannot work used to be allowed and then reported
        an hour later on a task card; asking for the repository first makes the switch honest.
      */}
      <label htmlFor="vcs-root">{t('vcs.repoField')}</label>
      <div className="row">
        <input
          id="vcs-root"
          type="text"
          className="grow"
          value={repoDir}
          onChange={(e) => setRepoDir(e.target.value)}
          onBlur={() => repoDir.trim() !== vcs.repoDir && void save({ repoDir: repoDir.trim() })}
          placeholder={session.projectDir || 'C:\\Projects\\my-app'}
          disabled={session.running}
        />
        <button onClick={() => void browse()} disabled={busy || session.running}>
          {t('mirror.browse')}
        </button>
      </div>
      <ProjectHint
        current={repoDir}
        onUse={(d) => {
          setRepoDir(d);
          void save({ repoDir: d });
        }}
      />

      {repoProblem && (
        <div className="notice caution" style={{ marginTop: 8 }}>
          <strong>{t('vcs.noRepo')}</strong>
          <div className="small" style={{ marginTop: 4 }}>{repoProblem}</div>
          <div className="muted small" style={{ marginTop: 6 }}>{t('vcs.noRepoHow')}</div>
        </div>
      )}
      {!repoProblem && effectiveRepo.trim() !== '' && (
        <p className="muted small" style={{ marginTop: 4 }}>{t('vcs.repoOk')}</p>
      )}
      {effectiveRepo.trim() === '' && <p className="muted small" style={{ marginTop: 4 }}>{t('vcs.pickFirst')}</p>}

      <div className={`option${!canEnable && !vcs.enabled ? ' warned' : ''}`}>
        <label>
          <input
            type="checkbox"
            checked={vcs.enabled}
            onChange={(e) => void save({ enabled: e.target.checked })}
            disabled={session.running || (!canEnable && !vcs.enabled)}
          />
          <span>{t('vcs.enable')}</span>
        </label>
        <p className="why">{t('vcs.enableWhy')}</p>
      </div>

      {vcs.enabled && (
        <>
          <div className="muted small" style={{ marginTop: 4 }}>
            {effectiveRepo ? t('vcs.repoIs', { dir: effectiveRepo }) : t('vcs.repoNone')}
          </div>
          {effectiveRepo && !repoProblem && <PrepareFolder dir={effectiveRepo} />}

          <h3>{t('vcs.branches')}</h3>
          {startFrom === 'existing-branch' && <p className="muted small">{t('vcs.branchesExisting', { branch: vcs.existingBranch || '…' })}</p>}
          <div className="option">
            <label>
              <input
                type="radio"
                name="branchMode"
                checked={vcs.branchMode === 'per-task'}
                onChange={() => void save({ branchMode: 'per-task' })}
                disabled={session.running}
              />
              <span>{t('vcs.perTask')}</span>
            </label>
            <p className="why">{t('vcs.perTaskWhy')}</p>
          </div>
          <div className="option">
            <label>
              <input
                type="radio"
                name="branchMode"
                checked={vcs.branchMode === 'per-session'}
                onChange={() => void save({ branchMode: 'per-session' })}
                disabled={session.running}
              />
              <span>{t('vcs.perSession')}</span>
            </label>
            <p className="why">{t('vcs.perSessionWhy')}</p>
          </div>

          {vcs.branchMode === 'per-session' && (
            <>
              <label htmlFor="vcs-branch-name">{t('vcs.branchName')}</label>
              <input
                id="vcs-branch-name"
                type="text"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                onBlur={() => branchName.trim() !== (vcs.branchName ?? '') && void save({ branchName: branchName.trim() })}
                placeholder={session.name}
                disabled={session.running}
              />
              <p className="why">{t('vcs.branchNameWhy')}</p>
            </>
          )}

          {/*
            Where the session begins, asked before it runs. Until this existed the answer was
            "wherever HEAD is", which after a run of sessions is the branch the last one left
            checked out, so whether sessions chained or started clean depended on nothing anyone
            chose. The old behaviour stays available, and last, for sessions that relied on it.
          */}
          <h3>{t('vcs.startFrom')}</h3>
          <div className="option">
            <label>
              <input
                type="radio"
                name="startFrom"
                checked={startFrom === 'branch'}
                onChange={() => void save({ startFrom: 'branch' })}
                disabled={session.running}
              />
              <span>{t('vcs.startBranch')}</span>
            </label>
            <p className="why">{t('vcs.startBranchWhy')}</p>
          </div>
          <div className="option">
            <label>
              <input
                type="radio"
                name="startFrom"
                checked={startFrom === 'previous-session'}
                onChange={() => void save({ startFrom: 'previous-session' })}
                disabled={session.running}
              />
              <span>{t('vcs.startPrevious')}</span>
            </label>
            <p className="why">{t('vcs.startPreviousWhy')}</p>
          </div>
          <div className="option">
            <label>
              <input
                type="radio"
                name="startFrom"
                checked={startFrom === 'head'}
                onChange={() => void save({ startFrom: 'head' })}
                disabled={session.running}
              />
              <span>{t('vcs.startHead')}</span>
            </label>
            <p className="why">{t('vcs.startHeadWhy')}</p>
          </div>
          {/*
            No new branch at all: the session carries on one that exists — a recovery branch, a
            feature branch the team named — and a task is refused rather than run anywhere else.
          */}
          <div className="option">
            <label>
              <input
                type="radio"
                name="startFrom"
                checked={startFrom === 'existing-branch'}
                onChange={() => void save({ startFrom: 'existing-branch' })}
                disabled={session.running}
              />
              <span>{t('vcs.startExisting')}</span>
            </label>
            <p className="why">{t('vcs.startExistingWhy')}</p>
          </div>
          {startFrom === 'existing-branch' && (
            <>
              <label htmlFor="vcs-existing-branch">{t('vcs.existingBranch')}</label>
              <input
                id="vcs-existing-branch"
                type="text"
                list="vcs-local-branches"
                value={existingBranch}
                onChange={(e) => setExistingBranch(e.target.value)}
                onBlur={() => existingBranch.trim() !== (vcs.existingBranch ?? '') && void save({ existingBranch: existingBranch.trim() })}
                disabled={session.running}
              />
              <datalist id="vcs-local-branches">
                {(status?.branches ?? []).map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
              <p className="why">{t('vcs.existingBranchWhy')}</p>
              {vcs.existingBranch && status?.branches && !status.branches.includes(vcs.existingBranch) && (
                <p className="err small">{t('vcs.existingBranchMissing', { branch: vcs.existingBranch })}</p>
              )}
            </>
          )}
          {(startFrom === 'branch' || startFrom === 'previous-session') && (
            <>
              <label htmlFor="vcs-base-branch">{t('vcs.baseBranch')}</label>
              <input
                id="vcs-base-branch"
                type="text"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                onBlur={() => baseBranch.trim() !== (vcs.baseBranch ?? '') && void save({ baseBranch: baseBranch.trim() })}
                placeholder="main"
                disabled={session.running}
              />
              <p className="why">{t('vcs.baseBranchWhy')}</p>
            </>
          )}
          {session.vcsStart && (
            <p className="muted small">
              {session.vcsStart.kind === 'existing-branch'
                ? t('vcs.startedExisting', { branch: session.vcsStart.branch ?? '', commit: session.vcsStart.commit.slice(0, 8) })
                : session.vcsStart.kind === 'previous-session'
                ? t('vcs.startedPrevious', { name: session.vcsStart.fromSession?.name ?? '', branch: session.vcsStart.branch ?? '', commit: session.vcsStart.commit.slice(0, 8) })
                : session.vcsStart.kind === 'branch'
                  ? t('vcs.startedBranch', { branch: session.vcsStart.branch ?? '', commit: session.vcsStart.commit.slice(0, 8) })
                  : session.vcsStart.kind === 'snapshot'
                    ? t('vcs.startedSnapshot', {
                        branch: session.vcsStart.branch ?? '',
                        commit: session.vcsStart.commit.slice(0, 8),
                        from: session.vcsStart.snapshot?.fromBranch ?? 'HEAD',
                        n: session.vcsStart.snapshot?.included.length ?? 0,
                        out: session.vcsStart.snapshot?.leftOut.length ?? 0,
                      })
                    : t('vcs.startedHead', { commit: session.vcsStart.commit.slice(0, 8) })}
              {session.vcsStart.note ? ` — ${session.vcsStart.note}` : ''}
              {session.vcsStart.update && (
                <>
                  <br />
                  {session.vcsStart.update.outcome === 'updated'
                    ? t('vcs.updated', { branch: session.vcsStart.update.branch, remote: session.vcsStart.update.remote ?? '', from: (session.vcsStart.update.from ?? '').slice(0, 8), to: (session.vcsStart.update.to ?? '').slice(0, 8) })
                    : session.vcsStart.update.outcome === 'up-to-date'
                      ? t('vcs.upToDate', { branch: session.vcsStart.update.branch, remote: session.vcsStart.update.remote ?? '' })
                      : t('vcs.notUpdated', { branch: session.vcsStart.update.branch, why: session.vcsStart.update.detail ?? session.vcsStart.update.outcome })}
                </>
              )}
            </p>
          )}
          {/*
            Before the session's first branch: the starting branch fetched and moved forward to the
            server's, only ever forward. Off, it starts from the local branch as this checkout has it.
          */}
          {startFrom !== 'head' && (
            <div className="option">
              <label>
                <input
                  type="checkbox"
                  checked={vcs.updateFromRemote !== false}
                  onChange={(e) => void save({ updateFromRemote: e.target.checked })}
                  disabled={session.running}
                />
                <span>{t('vcs.updateFromRemote')}</span>
              </label>
              <p className="why">{t('vcs.updateFromRemoteWhy')}</p>
            </div>
          )}

          <div className="option">
            <label>
              <input
                type="checkbox"
                checked={vcs.commitOnFinish}
                onChange={(e) => void save({ commitOnFinish: e.target.checked })}
                disabled={session.running}
              />
              <span>{t('vcs.commit')}</span>
            </label>
            <p className="why">{t('vcs.commitWhy')}</p>
          </div>

          {/*
            Uncommitted changes before the first task: kept out, as always, or taken as the commit
            the session starts from. Not for a session carrying on an existing branch: a snapshot is
            a branch of its own, and that session works on the one it was given.
          */}
          {startFrom !== 'existing-branch' && (
            <>
              <h3>{t('vcs.dirty')}</h3>
              {(['reject', 'snapshot', 'tracked-only-snapshot'] as const).map((p) => (
                <div className="option" key={p}>
                  <label>
                    <input
                      type="radio"
                      name={`vcs-dirty-${session.id}`}
                      checked={(vcs.dirtyWorktree?.policy ?? 'reject') === p}
                      onChange={() => void save({ dirtyWorktree: { policy: p, requireApproval: vcs.dirtyWorktree?.requireApproval } })}
                      disabled={session.running}
                    />
                    <span>{t(p === 'reject' ? 'vcs.dirtyReject' : p === 'snapshot' ? 'vcs.dirtySnapshot' : 'vcs.dirtyTracked')}</span>
                  </label>
                  <p className="why">{t(p === 'reject' ? 'vcs.dirtyRejectWhy' : p === 'snapshot' ? 'vcs.dirtySnapshotWhy' : 'vcs.dirtyTrackedWhy')}</p>
                </div>
              ))}
              {(vcs.dirtyWorktree?.policy ?? 'reject') !== 'reject' && (
                <div className="option">
                  <label>
                    <input
                      type="checkbox"
                      checked={vcs.dirtyWorktree?.requireApproval !== false}
                      onChange={(e) => void save({ dirtyWorktree: { policy: vcs.dirtyWorktree?.policy ?? 'snapshot', requireApproval: e.target.checked } })}
                      disabled={session.running}
                    />
                    <span>{t('vcs.dirtyApproval')}</span>
                  </label>
                  <p className="why">{t('vcs.dirtyApprovalWhy')}</p>
                </div>
              )}
            </>
          )}

          {/*
            The operator's input files: in the commit every session of the run starts from, with their
            sums, and read-only while the tasks run. One repository-relative pattern per line.
          */}
          <h3>{t('vcs.inputs')}</h3>
          <label htmlFor={`vcs-inputs-${session.id}`}>{t('vcs.inputsField')}</label>
          <textarea
            id={`vcs-inputs-${session.id}`}
            rows={3}
            value={inputsText}
            onChange={(e) => setInputsText(e.target.value)}
            onBlur={() => JSON.stringify(lines(inputsText)) !== JSON.stringify(vcs.userInputs?.paths ?? []) && void save({ userInputs: { ...vcs.userInputs, paths: lines(inputsText) } })}
            disabled={session.running}
            placeholder="rules-engine/test-data/schemas/*.yaml"
            spellCheck={false}
          />
          <p className="why">{t('vcs.inputsWhy')}</p>
          {(vcs.userInputs?.paths.length ?? 0) > 0 && (
            <div className="option">
              <label>
                <input
                  type="checkbox"
                  checked={vcs.userInputs?.readOnly !== false}
                  onChange={(e) => void save({ userInputs: { paths: vcs.userInputs?.paths ?? [], requireApproval: vcs.userInputs?.requireApproval, readOnly: e.target.checked } })}
                  disabled={session.running}
                />
                <span>{t('vcs.inputsReadOnly')}</span>
              </label>
              <p className="why">{t('vcs.inputsReadOnlyWhy')}</p>
            </div>
          )}
          {session.vcsStart?.inputs && (
            <p className="muted small">
              {session.vcsStart.inputs.carried
                ? t('vcs.inputsCarried', { n: session.vcsStart.inputs.files.length, branch: session.vcsStart.inputs.carried.branch, onto: session.vcsStart.inputs.carried.onto.slice(0, 8) })
                : t('vcs.inputsRecorded', { n: session.vcsStart.inputs.files.length, commit: session.vcsStart.commit.slice(0, 8) })}
            </p>
          )}

          {/* Evidence: kept with the run's record, never committed, .gitignore untouched. */}
          <h3>{t('vcs.artifacts')}</h3>
          <label htmlFor={`vcs-artifacts-${session.id}`}>{t('vcs.artifactsField')}</label>
          <textarea
            id={`vcs-artifacts-${session.id}`}
            rows={2}
            value={artifactsText}
            onChange={(e) => setArtifactsText(e.target.value)}
            onBlur={() => JSON.stringify(lines(artifactsText)) !== JSON.stringify(vcs.artifacts?.paths ?? []) && void save({ artifacts: { paths: lines(artifactsText) } })}
            disabled={session.running}
            placeholder="rules-engine/test-results/**"
            spellCheck={false}
          />
          <p className="why">{t('vcs.artifactsWhy')}</p>

          {/* Whether it will actually work, checked against the real repository. */}
          {status && !status.ok && (
            <div className="notice caution" role="status">
              <strong>{t('vcs.notReady')}</strong> {status.problem}
            </div>
          )}
          {status?.snapshot?.needed && status.snapshot.entries.length > 0 && (
            <SnapshotList session={session} plan={status.snapshot} onDone={() => { onChange(); check(); }} />
          )}
          {status?.ok && (
            <div className="muted small">
              {t('vcs.ready', { branch: status.branch ?? '—', dir: status.repoDir })}
            </div>
          )}
          {/*
            Where the work is, as opposed to where HEAD is. After a per-task run HEAD sits on
            whichever task ran last, which for one nine-task plan was an audit branch without
            the README written one task earlier; the folder looked as if the README was missing.
          */}
          {status?.ok && status.work && status.work.branches.length > 0 && (
            <div className="muted small">
              {status.work.mode === 'per-session' && status.work.complete
                ? t('vcs.completeOn', { branch: status.work.complete })
                : t('vcs.noSingleBranch', { n: status.work.branches.length })}
              {status.work.mode === 'per-task' && (
                <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
                  {status.work.branches.map((b) => (
                    <li key={b.branch}>
                      <code>{b.branch}</code> — {b.title}
                      {b.commit ? '' : ` (${t('vcs.taskNoFiles')})`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="muted small">{t('vcs.pushIsYours')}</p>
        </>
      )}

      <div className="muted small" role="status">
        {msg}
      </div>
    </div>
  );
}

/**
 * What the queue does when a task does not end with a summary.
 *
 * The two readings of a queue are genuinely different kinds of work and the runner cannot
 * guess which one this is. A suite where task 3 builds on task 2 must stop at the first
 * failure, or it runs the rest against a machine in a state nobody planned for. A set of
 * independent checks should keep going, because one failing says nothing about the next.
 */
function ChainMode({ session, onChange }: { session: Session; onChange: () => void }) {
  const { t } = useT();
  const [msg, setMsg] = useState('');
  const mode = session.onFailure ?? 'stop';

  const choose = async (next: 'stop' | 'continue') => {
    if (next === mode) return;
    try {
      await api.updateSession(session.id, { onFailure: next });
      setMsg(t(next === 'stop' ? 'chain.savedStop' : 'chain.savedContinue'));
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <fieldset style={{ border: 0, padding: 0, margin: '10px 0 14px' }}>
      <legend className="muted small" style={{ padding: 0 }}>
        {t('chain.title')}
      </legend>

      <div className="option">
        <label>
          <input type="radio" name="chain" checked={mode === 'stop'} onChange={() => void choose('stop')} disabled={session.running} />
          <span>{t('chain.stop')}</span>
        </label>
        <p className="why">{t('chain.stopWhy')}</p>
      </div>

      <div className="option">
        <label>
          <input
            type="radio"
            name="chain"
            checked={mode === 'continue'}
            onChange={() => void choose('continue')}
            disabled={session.running}
          />
          <span>{t('chain.continue')}</span>
        </label>
        <p className="why">{t('chain.continueWhy')}</p>
      </div>

      {msg && (
        <div className="muted small" role="status">
          {msg}
        </div>
      )}
      {session.running && <div className="muted small">{t('chain.locked')}</div>}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------
// Level 2 editor with presets, shared by the add form and the queued-task editor
// ---------------------------------------------------------------------------------------

function Level2Editor({
  value,
  onChange,
  presets,
  onPresetsChanged,
}: {
  value: string;
  onChange: (v: string) => void;
  presets: Preset[];
  onPresetsChanged?: () => void;
}) {
  const { t } = useT();
  const l2Id = useId();
  const [msg, setMsg] = useState('');
  const saveAs = async () => {
    const name = prompt(t('l2.saveAsPrompt'));
    if (!name) return;
    try {
      await api.savePreset(name, value);
      setMsg(t('l2.savedAs', { name }));
      onPresetsChanged?.();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <>
      <div className="row">
        <label className="grow" style={{ margin: 0 }} htmlFor={`${l2Id}-text`}>
          {t('l2.label')}
        </label>
        <select
          value=""
          aria-label={t('l2.loadPreset')}
          onChange={(e) => {
            const p = presets.find((x) => x.name === e.target.value);
            if (p) onChange(p.content);
          }}
        >
          <option value="">{t('l2.loadPreset')}</option>
          {presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <button onClick={() => void saveAs()} disabled={!value.trim()}>
          {t('l2.saveAs')}
        </button>
      </div>
      {/* The controls above wrap onto their own line on a narrow window, and without this the
          Save-as-preset button ends up sitting on the edge of the text box. */}
      <textarea
        id={`${l2Id}-text`}
        className="prose"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('l2.placeholder')}
        style={{ minHeight: 140, marginTop: 10 }}
      />
      {msg && <div className="muted small">{msg}</div>}
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Taking the work away: the record of what was asked and what came back
// ---------------------------------------------------------------------------------------

/**
 * Downloads the conversation of the chosen tasks, in one of two shapes.
 *
 * The short one is the pair people actually compare: the message that opened the task says
 * what was expected, the last one says what was done. The long one is everything in between,
 * for when the pair is not enough and someone has to see the steps.
 *
 * Selection defaults to every task that has run, because that is the common case; ticking
 * individual tasks narrows it.
 */
function ExportPanel({ session }: { session: Session }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const ran = session.tasks.filter((x) => x.status !== 'queued');
  const [picked, setPicked] = useState<string[]>([]);

  // Nothing ticked means everything: one fewer click for the common case, and the button
  // labels say which it is, so it is never a guess.
  const selection = picked.length > 0 ? picked : ran.map((x) => x.id);
  // A plain <a download> cannot set a header, so this one carries the token in the query, the
  // same way the stream and the other exports do. See `withToken` in web/lib/api.ts.
  const href = (variant: 'full' | 'outcome') =>
    withToken(
      `${API}/sessions/${session.id}/export?variant=${variant}` +
        (picked.length > 0 ? `&tasks=${encodeURIComponent(picked.join(','))}` : ''),
    );

  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="panel">
      <h2>{t('export.title')}</h2>
      <p className="muted small">{t('export.hint')}</p>

      {ran.length === 0 ? (
        <div className="empty">{t('export.nothing')}</div>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 6 }}>
            <button className="quiet" onClick={() => setPicked(ran.map((x) => x.id))}>
              {t('export.all')}
            </button>
            <button className="quiet" onClick={() => setPicked([])}>
              {t('export.none')}
            </button>
            <span className="muted small">
              {picked.length > 0 ? t('export.selected', { n: picked.length }) : t('export.allOf', { n: ran.length })}
            </span>
          </div>

          {ran.map((task) => (
            <div className="option" key={task.id} style={{ margin: '6px 0' }}>
              <label>
                <input type="checkbox" checked={picked.includes(task.id)} onChange={() => toggle(task.id)} />
                <span>
                  {task.title} <span className={`badge ${task.status}`}>{t(`status.${task.status}` as Key)}</span>{' '}
                  {task.readOnly && <span className="chip">{t('task.readOnly')}</span>}{' '}
                  {(task.scope?.length ?? 0) > 0 && <span className="chip">{t('task.scope', { paths: (task.scope ?? []).join(', ') })}</span>}{' '}
                  <span className="muted small">{fmtTime(task.finishedAt ?? task.startedAt ?? task.createdAt)}</span>
                </span>
              </label>
            </div>
          ))}

          <div className="row" style={{ marginTop: 10 }}>
            <a className="button-link" href={href('outcome')} download>
              {t('export.outcome', { n: selection.length })}
            </a>
            <a className="button-link" href={href('full')} download>
              {t('export.full', { n: selection.length })}
            </a>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>
            {t('export.outcomeWhy')}
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// How a task ended, in the runner's fixed shape (src/session/handoff.ts)
// ---------------------------------------------------------------------------------------

/**
 * The eight answers an operator wants from a finished attempt, always in the same order and always
 * from the runner's records: the chat's own account is the summary below it. Empty sections are
 * left out rather than shown as "none", except the two whose emptiness is itself the news.
 */
function HandoffView({ handoff }: { handoff: Handoff }) {
  const { t } = useT();
  const row = (label: Key, body: ReactNode) => (
    <div className="handoff-row">
      <strong>{t(label)}</strong> {body}
    </div>
  );
  const list = (items: string[]) => (
    <ul>
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
  const passed = handoff.validation.filter((v) => v.passed).length;
  return (
    <div className="summary handoff">
      <strong>{t('handoff.title')}</strong>
      {row('handoff.outcome', <>
        <span className={`badge ${handoff.outcome.status}`}>{t(`status.${handoff.outcome.status}` as Key)}</span>
        {handoff.outcome.reason ? ` ${handoff.outcome.reason}` : ''}
      </>)}
      {row('handoff.files', handoff.changedFiles.length === 0
        ? <span className="muted">{t('handoff.noFiles')}</span>
        : <code>{handoff.changedFiles.map((f) => `${f.path}${f.added >= 0 ? ` +${f.added}/-${f.removed}` : ''}`).join(', ')}</code>)}
      {handoff.validation.length > 0 && row('handoff.validation', <>
        {t('handoff.passed', { n: passed, of: handoff.validation.length })}
        {handoff.review ? ` · ${t('handoff.review', { verdict: handoff.review.verdict, open: handoff.review.open })}` : ''}
      </>)}
      {row('handoff.issues', handoff.knownIssues.length === 0 ? <span className="muted">{t('handoff.noIssues')}</span> : list(handoff.knownIssues))}
      {handoff.evidence.runId && row('handoff.evidence', <code>{handoff.evidence.runId}</code>)}
      {(handoff.vcs.branch || handoff.vcs.problem) && row('handoff.vcs', <>
        {handoff.vcs.branch && <code>{handoff.vcs.branch}</code>}
        {handoff.vcs.commit ? ` @ ${handoff.vcs.commit.slice(0, 8)} · ${t('handoff.notPushed')}` : handoff.vcs.branch ? ` · ${t('handoff.noCommit')}` : ''}
        {handoff.vcs.problem ? ` — ${handoff.vcs.problem}` : ''}
      </>)}
      {handoff.manual.length > 0 && row('handoff.manual', list(handoff.manual))}
      {handoff.notExecuted.length > 0 && row('handoff.notRun', list(handoff.notExecuted))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Add a task
// ---------------------------------------------------------------------------------------

function TaskForm({
  session,
  presets,
  onAdded,
  onPresetsChanged,
}: {
  session: Session;
  presets: Preset[];
  onAdded: () => void;
  onPresetsChanged: () => void;
}) {
  const { t } = useT();
  const last = [...session.tasks].reverse()[0];
  const [title, setTitle] = useState('');
  const [level2, setLevel2] = useState(last?.level2 ?? '');
  const [promptText, setPromptText] = useState('');
  const [msg, setMsg] = useState('');
  // A second click while the first is on its way queued the same task twice, and the bot runs both.
  const [adding, setAdding] = useState(false);
  const inFlight = useRef(false);

  const add = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setAdding(true);
    try {
      await api.addTask(session.id, { title, level2, prompt: promptText });
      setTitle('');
      setPromptText('');
      setMsg(t('form.queued'));
      onAdded();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      inFlight.current = false;
      setAdding(false);
    }
  };

  return (
    <div className="panel" id="new-task">
      <h2>{t('form.title')}</h2>
      <p className="muted small">{t('form.hint')}</p>
      <label htmlFor="new-task-title">{t('form.titleLabel')}</label>
      <input id="new-task-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('form.titlePlaceholder')} />
      <div style={{ marginTop: 10 }}>
        <Level2Editor value={level2} onChange={setLevel2} presets={presets} onPresetsChanged={onPresetsChanged} />
      </div>
      <label htmlFor="new-task-prompt">{t('form.taskLabel')}</label>
      <textarea
        id="new-task-prompt"
        className="prose"
        value={promptText}
        onChange={(e) => setPromptText(e.target.value)}
        placeholder={t('form.taskPlaceholder')}
        style={{ minHeight: 140 }}
      />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={() => void add()} disabled={adding || !promptText.trim()}>
          {t('form.add')}
        </button>
        <span className="muted small">{msg}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// One task
// ---------------------------------------------------------------------------------------


function TaskCard({
  session,
  task,
  index,
  presets,
  onChange,
}: {
  session: Session;
  task: Task;
  index: number;
  presets: Preset[];
  onChange: () => void;
}) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const [editing, setEditing] = useState(false);
  const [showStory, setShowStory] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [level2, setLevel2] = useState(task.level2);
  const [promptText, setPromptText] = useState(task.prompt);
  // The names the task carries into git. An import sets these; without them in the form, a
  // task that arrived as JSON would be the only kind with a part nobody can change.
  const [branch, setBranch] = useState(task.vcsPlan?.branch ?? '');
  const [commitMessage, setCommitMessage] = useState(task.vcsPlan?.commitMessage ?? '');
  const [checks, setChecks] = useState<TaskCheck[]>(task.checks ?? []);
  const [readOnlyDraft, setReadOnlyDraft] = useState(!!task.readOnly);
  const [scopeDraft, setScopeDraft] = useState((task.scope ?? []).join('\n'));
  const contract = { readOnly: readOnlyDraft, scope: readOnlyDraft ? [] : scopeLines(scopeDraft) };
  // Ticks only while this task runs; a finished card never re-renders for the clock.
  const now = useNow(isLive(task));
  const [files, setFiles] = useState<{ reports: string[]; artifacts: string[]; replies: string[] } | null>(null);
  const [msg, setMsg] = useState('');
  /**
   * The "Run this task" panel, open on a queued card: asked for with the button, or offered after an
   * edit put the task back in the queue or a contradiction was fixed (`intro` says which).
   */
  const [runPanel, setRunPanel] = useState<{ intro?: string } | null>(null);
  const [fixingContract, setFixingContract] = useState(false);

  /*
   * The form starts from the task as it is now, every time it opens. The fields were copied from
   * the task once, when the card first rendered, so a prompt changed since — "Fix the prompt" in
   * the register, an edit in another tab — showed the old text here, and "Save and queue it again"
   * wrote the old text back over the new one.
   */
  const toggleEditor = (): void => {
    if (!editing) {
      setTitle(task.title);
      setLevel2(task.level2);
      setPromptText(task.prompt);
      setBranch(task.vcsPlan?.branch ?? '');
      setCommitMessage(task.vcsPlan?.commitMessage ?? '');
      setChecks(task.checks ?? []);
      setReadOnlyDraft(!!task.readOnly);
      setScopeDraft((task.scope ?? []).join('\n'));
    }
    setEditing(!editing);
  };

  const save = async () => {
    try {
      await api.updateTask(session.id, task.id, { title, level2, prompt: promptText, vcsPlan: { branch, commitMessage }, checks, ...contract });
      setEditing(false);
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  // A task the runner is inside of is the only one that cannot go. Everything else can: a
  // queued one the user changed their mind about, and a finished one they want out of the
  // register. What was executed stays on disk under runs/ either way.
  const active = task.status === 'running' || task.status === 'waiting-approval';
  // A queued task can be edited even while an earlier task is running: the runner re-reads
  // each task at the moment it picks it up, so an edit made before then is the one that runs.
  // If it starts mid-edit the save is refused with that reason, which is better than a form
  // that is locked for the whole length of a queue. A finished task can be edited too, and
  // saving that edit queues it again; only a task the runner is inside of is closed to edits.
  const editable = !active;
  const hasRun = !active && task.status !== 'queued';

  // Anything that has finished can be repeated, a task that succeeded included: running the
  // same check again is a normal thing to want. A queued task is already about to run, and a
  // running one is exactly what must not be restarted underneath the runner.
  const rerunnable = !active && task.status !== 'queued';
  // Only a task that recorded where it began can be gone back to. Version control being off,
  // or inactive when it ran, means there is no such point and the button would be a lie.
  const restorable =
    !active &&
    (session.vcs?.enabled ?? false) &&
    (!!task.vcs?.baseCommit || (task.attempts ?? []).some((a) => a.vcs?.baseCommit));

  // A task that stopped before it finished — a limit from the settings, the bot stopping under it,
  // the operator — is carried on where it stopped; one with a verdict on its work is run again.
  const continuable = !active && isContinuable(task);
  const carryOn = async () => {
    if (!(await confirmDialog(t('task.continueConfirm', { title: task.title })))) return;
    try {
      await api.continueTask(session.id, task.id);
      onChange();
      // Queued, not started: every way back into the queue ends with the offer to run it.
      setRunPanel({ intro: t('runq.savedOffer') });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const rerun = async () => {
    if (!(await confirmDialog(t('task.rerunConfirm', { title: task.title })))) return;
    try {
      await api.rerunTask(session.id, task.id);
      onChange();
      setRunPanel({ intro: t('runq.savedOffer') });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  /**
   * Saves an edit of a task that has already run, which necessarily queues it again.
   *
   * The attempt that ran is archived with the text it ran with, so its summary keeps standing
   * under the question it actually answered. Editing in place would quietly rewrite history.
   */
  const saveAndRerun = async () => {
    if (!(await confirmDialog(t('task.editRanConfirm', { title: task.title })))) return;
    try {
      // As in the register: a task that ended done is edited to build on its work, not to redo it.
      await api.rerunTask(
        session.id,
        task.id,
        { title, level2, prompt: promptText, vcsPlan: { branch, commitMessage }, checks, ...contract },
        { buildOnFinished: task.status === 'done' },
      );
      setEditing(false);
      onChange();
      // Queued again: the next thing anyone wants is to run it, so that is offered here, on the card.
      setRunPanel({ intro: t('runq.savedOffer') });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  /*
   * Restoring and starting again both live in `taskActions`, shared with the register.
   *
   * They used to be written out here, which meant the sentence warning an operator what they
   * were about to move existed in one place and the register could not offer the button at all.
   * The register is where a failure is noticed, so that was the wrong way round.
   */
  const actions = useTaskActions(onChange);

  const remove = async () => {
    const question = task.status === 'queued' ? 'task.deleteConfirm' : 'task.deleteConfirmRan';
    if (!(await confirmDialog(t(question, { title: task.title })))) return;
    try {
      await api.deleteTask(session.id, task.id);
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  // Read each time the list is opened, not once: a running task keeps adding reports and replies.
  const loadFiles = async () => {
    try {
      setFiles(await api.taskFiles(session.id, task.id));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const fileLinks = (label: Key, kind: 'reports' | 'artifacts' | 'replies', names: string[]) =>
    names.length > 0 && (
      <div>
        <span className="muted">{t(label)} </span>
        {/* A report or a downloaded script is a log by another name, so it is saved the same way. */}
        {names.map((n) => (
          <span key={n} style={{ marginRight: 10 }}>
            <SaveLog label={n} save={() => api.saveTaskFile(session.id, task.id, kind, n)} />
          </span>
        ))}
      </div>
    );

  return (
    // The id is the anchor the task register links to, so "open" lands on this exact card.
    <div className={`task ${task.status}`} id={task.id}>
      <div className="row">
        <h4 className="grow">
          {index}. {task.title}
        </h4>
        <span className={`badge ${task.status}`}>{t(`status.${task.status}` as Key)}</span>
        {task.limit && (
          <span className="chip" title={t('reg.limitChipWhy')}>
            {t('reg.limitChip', { limit: t(`limit.${task.limit.setting}` as Key, { n: task.limit.value }) })}
          </span>
        )}
        {(task.attempt ?? 1) > 1 && <span className="chip">{t('task.attemptN', { n: task.attempt ?? 1 })}</span>}
        {task.iterations > 0 && <span className="muted small">{t('task.iterations', { n: task.iterations })}</span>}
        {task.runId && (
          <button
            className={showStory ? '' : 'quiet'}
            aria-expanded={showStory}
            onClick={() => setShowStory((v) => !v)}
            title={isLive(task) ? t('story.showLiveWhy') : t('story.why')}
          >
            {/* A task being worked on right now says so, and pulses: what is behind the button is
                different in kind from a record of something finished. */}
            {isLive(task) && !showStory && <span className="dot" aria-hidden="true" />}
            {showStory ? t('story.hide') : isLive(task) ? t('story.showLive') : t('story.show')}
          </button>
        )}
        {/* A waiting task is started from its own card, alone or with the queued ones after it. */}
        {task.status === 'queued' && !session.running && session.active !== false && (
          <button
            className={runPanel ? '' : 'primary'}
            aria-expanded={!!runPanel}
            onClick={() => {
              // One fix panel per card: the run panel shows the task's own when a contradiction is left.
              setFixingContract(false);
              setRunPanel(runPanel ? null : {});
            }}
            title={t('runq.buttonWhy')}
          >
            {t('runq.button')}
          </button>
        )}
        {/* Kept while its panel is open: a partial fix queues the task, and the panel still needs its close. */}
        {(fixingContract || (task.stopCode === 'contract-conflict' && !active && task.status !== 'queued' && !session.running)) && (
          <button className={fixingContract ? '' : 'primary'} aria-expanded={fixingContract} onClick={() => setFixingContract(!fixingContract)} title={t('cfix.buttonWhy')}>
            {t('cfix.button')}
          </button>
        )}
        {editable && (
          <button onClick={toggleEditor} title={t('task.editAll')}>
            {editing ? t('task.cancel') : t('task.edit')}
          </button>
        )}
        {continuable && (
          <button className="primary" onClick={() => void carryOn()} title={t('task.continueWhy')}>
            {t('task.continue')}
          </button>
        )}
        {rerunnable && (
          <button className={continuable ? '' : 'primary'} onClick={() => void rerun()} title={t('task.rerunWhy')}>
            {t('task.rerun')}
          </button>
        )}
        {restorable && (
          <button
            onClick={() => void actions.restore({ sessionId: session.id, taskId: task.id, title: task.title })}
            disabled={actions.busy !== '' || session.running}
            title={t('restore.why')}
          >
            {actions.busy === 'restore' ? t('restore.checking') : t('restore.button')}
          </button>
        )}
        {/*
         * Offered on any task that has run, with or without version control: without it the
         * code is not put back, but queueing this task and everything after it and starting
         * them again is still the thing somebody wants after a failure in the middle of a run.
         */}
        {hasRun && (
          <button
            onClick={() => void actions.restartFrom({ sessionId: session.id, taskId: task.id, title: task.title })}
            disabled={actions.busy !== '' || session.running}
            title={t('restart.why')}
          >
            {actions.busy === 'restart' ? t('restart.checking') : t('restart.button')}
          </button>
        )}
        {!active && (
          <button className="danger" onClick={() => void remove()}>
            {t('task.delete')}
          </button>
        )}
        {!editing && (msg || actions.message) && (
          <span className="err" role="alert">
            {msg || actions.message}
          </span>
        )}
      </div>
      <div className="muted small">
        {task.startedAt ? t('task.started', { t: fmtTime(task.startedAt) }) : t('task.added', { t: fmtTime(task.createdAt) })}
        {task.finishedAt ? ` · ${t('task.finished', { t: fmtTime(task.finishedAt) })}` : ''}
        {task.startedAt && task.finishedAt ? ` · ${t('task.took', { d: fmtDuration(elapsedMs(task.startedAt, task.finishedAt)) })}` : ''}
        {isLive(task) ? ` · ${t('task.runningFor', { d: fmtDuration(elapsedMs(task.startedAt, undefined, now)) })}` : ''}
      </div>
      {/*
        What version control actually did, on a task that has run. The strings for this existed
        and nothing rendered them, which is how a task could commit five files and look, on this
        page, as though nothing had happened at all.
      */}
      {task.status !== 'queued' && session.vcs?.enabled && task.vcs && (
        <div className="muted small">
          {task.vcs.problem && !task.vcs.branch ? (
            <span className="reason">{t('vcs.taskProblem', { problem: task.vcs.problem })}</span>
          ) : (
            <>
              {task.vcs.branch && t('vcs.taskBranch', { branch: task.vcs.branch })}
              {task.vcs.baseCommit && ` · ${t('vcs.taskBase', { commit: task.vcs.baseCommit.slice(0, 8) })}`}
              {task.vcs.commit
                ? ` · ${t('vcs.taskCommit', { commit: task.vcs.commit.slice(0, 8) })}`
                : ` · ${t('vcs.taskNoFiles')}`}
              {(task.vcs.files?.length ?? 0) > 0 && (
                <details style={{ display: 'inline' }}>
                  <summary style={{ display: 'inline', cursor: 'pointer' }}>
                    {' · '}
                    {t('vcs.taskFiles', { n: task.vcs.files?.length ?? 0 })}
                  </summary>
                  <ul style={{ margin: '4px 0 4px 0', paddingLeft: 20 }}>
                    {(task.vcs.files ?? []).map((file) => (
                      <li key={file.path}>
                        <code>{file.path}</code>{' '}
                        {file.added < 0 || file.removed < 0 ? (
                          t('vcs.taskBinary')
                        ) : (
                          <>
                            <span style={{ color: 'var(--ok)' }}>+{file.added}</span>{' '}
                            <span style={{ color: 'var(--bad)' }}>-{file.removed}</span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {/* The same files side by side, before and after. */}
              {task.vcs.commit && task.vcs.baseCommit && (
                <>
                  {' · '}
                  <ChangesButton sessionId={session.id} taskId={task.id} title={task.title} files={task.vcs.files?.length ?? 0} />
                </>
              )}
              {/* Pointed out to the model once and left in place, so a person should look. */}
              {(task.vcs.suspicious?.length ?? 0) > 0 && (
                <div className="err small" style={{ marginTop: 4 }}>
                  {t('vcs.suspicious', { n: task.vcs.suspicious?.length ?? 0 })}
                  <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
                    {(task.vcs.suspicious ?? []).map((s) => (
                      <li key={s.path}>
                        <code>{s.path}</code> — {s.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {/* The runner put these back: they were outside the paths the task may change. */}
              {(task.scopeReverted?.length ?? 0) > 0 && (
                <div className="small" style={{ marginTop: 4 }}>
                  {t(task.readOnly ? 'task.readOnlyReverted' : 'task.scopeReverted', { n: task.scopeReverted?.length ?? 0, paths: (task.scopeReverted ?? []).join(', ') })}
                </div>
              )}
              {/* The operator's input files, read-only: the runner put these back. */}
              {(task.inputsRestored?.length ?? 0) > 0 && (
                <div className="small" style={{ marginTop: 4 }}>
                  {t('task.inputsRestored', { n: task.inputsRestored?.length ?? 0, paths: (task.inputsRestored ?? []).join(', ') })}
                </div>
              )}
              {/* Evidence kept with this attempt's record, never committed. */}
              {(task.artifactsKept?.length ?? 0) > 0 && (
                <div className="muted small" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>
                  {t('task.artifactsKept', { n: task.artifactsKept?.length ?? 0, paths: (task.artifactsKept ?? []).slice(0, 10).map((a) => a.path).join(', ') })}
                </div>
              )}
              {/* Commits on the branch that the runner did not make, found before its own commit. */}
              {(task.vcs.foreignCommits?.length ?? 0) > 0 && (
                <div className="err small" style={{ marginTop: 4 }}>
                  {t('vcs.foreignCommits', { n: task.vcs.foreignCommits?.length ?? 0 })}
                  <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
                    {(task.vcs.foreignCommits ?? []).map((c) => (
                      <li key={c}>
                        <code>{c}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/*
        The names an import chose, shown on a task that has not run yet. Without this the only
        way to find out what a plan decided about git would be to open the JSON it came from.
      */}
      {task.status === 'queued' && session.vcs?.enabled && (task.vcsPlan?.branch || task.vcsPlan?.commitMessage) && (
        <div className="muted small">
          {task.vcsPlan.branch && task.vcsPlan.commitMessage
            ? t('task.gitNames', {
                branch: task.vcsPlan.branch,
                subject: task.vcsPlan.commitMessage.split('\n')[0],
              })
            : task.vcsPlan.branch
              ? t('task.gitBranchOnly', { branch: task.vcsPlan.branch })
              : t('task.gitCommitOnly', { subject: (task.vcsPlan.commitMessage ?? '').split('\n')[0] })}
        </div>
      )}

      {fixingContract && (
        <ContractFixPanel
          target={{ sessionId: session.id, taskId: task.id, title: task.title }}
          onApplied={(remaining, changed) => {
            onChange();
            if (remaining === 0) {
              setFixingContract(false);
              setRunPanel({ intro: `${changed} ${t('runq.savedOffer')}` });
            }
          }}
        />
      )}
      {runPanel && task.status === 'queued' && (
        <RunQueuedPanel
          target={{ sessionId: session.id, taskId: task.id, title: task.title }}
          intro={runPanel.intro}
          checkContract={!fixingContract}
          onClose={(started) => {
            setRunPanel(null);
            if (started) onChange();
          }}
        />
      )}

      {showStory && task.runId && (
        <TaskStory sessionId={session.id} taskId={task.id} live={task.status === 'running' || task.status === 'waiting-approval'} />
      )}

      {editing ? (
        <div style={{ marginTop: 8 }}>
          <label>{t('form.titleLabel')}</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div style={{ marginTop: 8 }}>
            <Level2Editor value={level2} onChange={setLevel2} presets={presets} />
          </div>
          <label>{t('form.taskLabel')}</label>
          <textarea className="prose" value={promptText} onChange={(e) => setPromptText(e.target.value)} />

          {session.vcs?.enabled && (
            <>
              <label htmlFor={`branch-${task.id}`}>{t('task.branch')}</label>
              <input
                id={`branch-${task.id}`}
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder={session.vcs.branchPrefix}
                disabled={session.vcs.branchMode === 'per-session'}
              />
              <p className="why">
                {session.vcs.branchMode === 'per-session' ? t('task.branchIgnored') : t('task.branchWhy')}
              </p>

              <label htmlFor={`commit-${task.id}`}>{t('task.commitMessage')}</label>
              <textarea
                id={`commit-${task.id}`}
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                style={{ minHeight: 70 }}
              />
              <p className="why">{t('task.commitWhy')}</p>
            </>
          )}

          <ChecksEditor checks={checks} onChange={setChecks} />
          {/* A new prompt is a new question: say what happens to the checks written for the old one. */}
          {promptText.trim() !== task.prompt.trim() && <p className="notice caution small">{t('task.newIntentNote')}</p>}
          <ContractFields readOnly={readOnlyDraft} scope={scopeDraft} onReadOnly={setReadOnlyDraft} onScope={setScopeDraft} />

          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={() => void (hasRun ? saveAndRerun() : save())}>
              {hasRun ? t('task.saveAndRerun') : t('task.save')}
            </button>
            <span className="err">{msg}</span>
          </div>
          {hasRun && <p className="muted small">{t('task.editRanWhy')}</p>}
        </div>
      ) : (
        <>
          {(task.checks?.length ?? 0) > 0 && (
            <details className="small" style={{ margin: '6px 0' }}>
              <summary>
                {t('checks.title')} — {t('checks.n', { n: task.checks?.length ?? 0 })}
                {(task.checkResults?.length ?? 0) > 0 &&
                  ` · ${(task.checkResults ?? []).filter((r) => r.passed).length}/${task.checkResults?.length} ${t('checks.passed')}`}
              </summary>
              <ul style={{ margin: '6px 0', paddingLeft: 20 }}>
                {(task.checks ?? []).map((c, i) => {
                  const result = (task.checkResults ?? []).find((r) => r.name === c.name);
                  return (
                    <li key={`${c.name}-${i}`}>
                      <strong>{c.name}</strong>
                      <span className="muted">
                        {' — '}
                        {t(`checks.kind.${c.expect}` as Key)}
                        {c.value ? ` "${c.value}"` : ''}
                        {c.run ? `: ${c.run}` : c.file ? `: ${c.file}` : ''}
                      </span>
                      {result && (
                        <div className={result.passed ? 'muted' : 'reason'}>
                          {result.passed ? t('checks.passed') : t('checks.failed')} — {result.detail}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}

          {/*
            Checks reviewers gave with their findings. Listed apart from the operator's, because
            they were not asked for: each is what one review noticed, made repeatable.
          */}
          {(task.reviewChecks?.length ?? 0) > 0 && (
            <details className="small" style={{ margin: '6px 0' }}>
              <summary>{t('checks.fromReview', { n: task.reviewChecks?.length ?? 0 })}</summary>
              <p className="why">{t('checks.fromReviewWhy')}</p>
              <ul style={{ margin: '6px 0', paddingLeft: 20 }}>
                {(task.reviewChecks ?? []).map((rc) => {
                  const result = (task.checkResults ?? []).find((r) => r.name === rc.check.name);
                  return (
                    <li key={`${rc.attempt}:${rc.findingId}:${rc.check.name}`}>
                      <code>{rc.findingId}</code> <strong>{rc.check.name}</strong>
                      {rc.state !== 'active' && (
                        <span className="chip" style={{ marginLeft: 6 }}>
                          {t(`checks.state.${rc.state}` as Key)}
                        </span>
                      )}
                      <div className="muted">{rc.what}</div>
                      {result && (
                        <div className={result.passed ? 'muted' : 'reason'}>
                          {result.passed ? t('checks.passed') : t('checks.failed')} — {result.detail}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}

          <ReviewVerdict review={task.review} />

          {task.stopCode && !isLive(task) && (
            <p className="small">
              <span className="chip" title={t('stop.why')}>
                {t(`stop.${task.stopCode}` as Key)}
              </span>
            </p>
          )}
          {task.handoff && !isLive(task) && <HandoffView handoff={task.handoff} />}

          {task.summary && (
            <div className="summary">
              <strong>{t('task.whatWasDone')}</strong>
              <RichText text={task.summary} />
            </div>
          )}
          {(task.deviations?.length ?? 0) > 0 && <Deviations items={task.deviations ?? []} />}
          {(task.disputes?.length ?? 0) > 0 && <Disputes items={task.disputes ?? []} />}
          {task.environment && (
            <div className="muted small" style={{ margin: '4px 0' }}>
              {t('task.ranWith', {
                node: task.environment.node,
                npm: task.environment.npm ?? '—',
                git: task.environment.git ?? '—',
                pwsh: task.environment.pwsh ?? task.environment.powershell ?? '—',
              })}
            </div>
          )}
          {/* Stopped by the runner; said here because a server left behind is a defect too. */}
          {(task.leftovers?.length ?? 0) > 0 && (
            <div className="err small" style={{ margin: '6px 0' }}>
              {t('task.leftovers', { n: task.leftovers?.length ?? 0 })}
              <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
                {(task.leftovers ?? []).map((l) => (
                  <li key={`${l.by}-${l.pid}`}>
                    <code>{l.name}</code> pid {l.pid}
                    {l.ports.length > 0 ? ` · ${t('task.leftoverPorts', { ports: l.ports.join(', ') })}` : ''} · {l.by}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {task.reason && (
            <div className="reason small" style={{ margin: '6px 0' }}>
              {task.reason}
            </div>
          )}

          {/* Earlier attempts, kept when the task was queued again. Each one owns its run
              folder, so its log is still there to read and compare against. */}
          {(task.attempts?.length ?? 0) > 0 && (
            <details>
              <summary>{t('task.attempts', { n: task.attempts?.length ?? 0 })}</summary>
              {task.attempts?.map((a, i) => (
                <div key={`${a.runId ?? i}`} className="small" style={{ margin: '8px 0 12px' }}>
                  <div className="row">
                    <strong>{t('task.attemptN', { n: i + 1 })}</strong>
                    <span className={`badge ${a.status}`}>{t(`status.${a.status}` as Key)}</span>
                    {a.iterations > 0 && <span className="muted">{t('task.iterations', { n: a.iterations })}</span>}
                    {a.runId && <SaveLog label={t('save.attemptLog')} save={() => api.saveTaskLog(session.id, task.id, a.runId)} />}
                    {a.runId && <AttemptRecord sessionId={session.id} taskId={task.id} attempt={i + 1} />}
                    {a.runId && a.vcs?.commit && a.vcs.baseCommit && (
                      <ChangesButton sessionId={session.id} taskId={task.id} runId={a.runId} title={`${task.title} — ${t('task.attemptN', { n: i + 1 })}`} files={a.vcs.files?.length ?? 0} />
                    )}
                  </div>
                  <div className="muted">
                    {a.startedAt ? t('task.started', { t: fmtTime(a.startedAt) }) : ''}
                    {a.finishedAt ? ` · ${t('task.finished', { t: fmtTime(a.finishedAt) })}` : ''}
                  </div>
                  {a.summary && <div>{a.summary}</div>}
                  {a.reason && <div className="err">{a.reason}</div>}
                  {a.prompt && a.prompt !== task.prompt && (
                    <details>
                      <summary>{t('task.attemptText')}</summary>
                      <pre>{a.prompt}</pre>
                    </details>
                  )}
                </div>
              ))}
            </details>
          )}

          {/*
            A task that has not run yet is shown open. What is about to be sent to Copilot is
            the one thing worth reading before pressing Run, and hiding it behind a disclosure
            made the queue look like a list of titles. A task that has already run is folded
            away again: there the summary is the answer, and the prompt is history.
          */}
          {task.status === 'queued' ? (
            <div style={{ marginTop: 8 }}>
              <div className="muted small">{t('task.prompt')}</div>
              <pre>{task.prompt}</pre>
              {task.level2.trim() ? (
                <details>
                  <summary>{t('task.l2Show', { n: task.level2.trim().split('\n').length })}</summary>
                  <pre>{task.level2}</pre>
                </details>
              ) : (
                <div className="muted small">{t('task.noL2')}</div>
              )}
            </div>
          ) : (
            <details>
              <summary>{t('task.promptAndL2')}</summary>
              {task.level2.trim() && (
                <>
                  <div className="muted small">{t('task.l2')}</div>
                  <pre>{task.level2}</pre>
                </>
              )}
              <div className="muted small">{t('task.prompt')}</div>
              <pre>{task.prompt}</pre>
            </details>
          )}

          {task.firstMessage && (
            <details>
              <summary>{t('task.firstMessage')}</summary>
              <pre className="tall">{task.firstMessage}</pre>
            </details>
          )}

          {task.runId && (
            <details onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && void loadFiles()}>
              <summary>{t('task.files')}</summary>
              <div className="row small" style={{ margin: '6px 0' }}>
                <SaveLog label={t('save.log')} save={() => api.saveTaskLog(session.id, task.id)} />
              </div>
              {files && (
                <div className="small">
                  {fileLinks('task.reports', 'reports', files.reports)}
                  {fileLinks('task.artifacts', 'artifacts', files.artifacts)}
                  {fileLinks('task.replies', 'replies', files.replies)}
                </div>
              )}
            </details>
          )}

          {task.finalReply && (
            <details>
              <summary>{t('task.finalReply')}</summary>
              <pre className="tall">{task.finalReply}</pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Live event log
// ---------------------------------------------------------------------------------------

function EventLog({ events }: { events: SessionEvent[] }) {
  const { t } = useT();
  const { appearance } = useAppearance();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // "Less motion" means the log stops moving under the reader's eyes; they scroll it.
    if (appearance.reduceMotion) return;
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events.length, appearance.reduceMotion]);
  return (
    <div className="panel">
      <h2>{t('live.title')}</h2>
      <div className="log" ref={ref}>
        {events.length === 0 && <div className="muted">{t('live.none')}</div>}
        {events.map((e, i) => (
          <div key={i} className={e.level}>
            <span className="time">{new Date(e.at).toLocaleTimeString(undefined, { hour12: false })}</span>
            {e.message ?? e.type}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// The checks of one task
// ---------------------------------------------------------------------------------------

/**
 * A small repeating form, because a check is four short answers and not a paragraph.
 *
 * The fields change with the kind: asking for a file when the check is about a command is how
 * a form teaches people the wrong shape. Everything here is what an imported plan can set, so
 * a task that arrived as JSON has no part the operator cannot reach.
 */
function ChecksEditor({ checks, onChange }: { checks: TaskCheck[]; onChange: (next: TaskCheck[]) => void }) {
  const { t } = useT();

  const update = (i: number, patch: Partial<TaskCheck>) =>
    onChange(checks.map((c, j) => (i === j ? { ...c, ...patch } : c)));

  return (
    <div style={{ marginTop: 12 }}>
      <label>{t('checks.title')}</label>
      <p className="why" style={{ marginTop: 0 }}>
        {t('checks.why')}
      </p>

      {checks.length === 0 && <p className="muted small">{t('checks.noneWhy')}</p>}

      {checks.map((check, i) => (
        <div className="option" key={i}>
          <div className="row">
            <input
              type="text"
              className="grow"
              value={check.name}
              placeholder={t('checks.namePlaceholder')}
              onChange={(e) => update(i, { name: e.target.value })}
              aria-label={t('checks.name')}
            />
            <select
              value={check.expect}
              onChange={(e) => update(i, { expect: e.target.value as TaskCheck['expect'] })}
              aria-label={t('checks.kind')}
              style={{ width: 'auto' }}
            >
              {CHECK_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`checks.kind.${kind}` as Key)}
                </option>
              ))}
            </select>
            <button className="quiet" onClick={() => onChange(checks.filter((_, j) => j !== i))}>
              {t('checks.remove')}
            </button>
          </div>

          <div className="row" style={{ marginTop: 6 }}>
            {checkNeedsCommand(check.expect) ? (
              <>
                <input
                  type="text"
                  className="grow"
                  value={check.run ?? ''}
                  placeholder={t('checks.run')}
                  onChange={(e) => update(i, { run: e.target.value })}
                  aria-label={t('checks.run')}
                />
                <input
                  type="text"
                  value={check.cwd ?? ''}
                  placeholder={t('checks.cwd')}
                  onChange={(e) => update(i, { cwd: e.target.value })}
                  aria-label={t('checks.cwd')}
                  style={{ width: 220 }}
                />
              </>
            ) : (
              <input
                type="text"
                className="grow"
                value={check.file ?? ''}
                placeholder={t('checks.file')}
                onChange={(e) => update(i, { file: e.target.value })}
                aria-label={t('checks.file')}
              />
            )}
            {checkNeedsValue(check.expect) && (
              <input
                type="text"
                value={check.value ?? ''}
                placeholder={check.expect === 'output-matches' ? t('checks.valueRegex') : t('checks.value')}
                onChange={(e) => update(i, { value: e.target.value })}
                aria-label={t('checks.value')}
                style={{ width: 240 }}
              />
            )}
          </div>
        </div>
      ))}

      <button onClick={() => onChange([...checks, { name: '', expect: 'exit-zero', run: '' }])}>{t('checks.add')}</button>
    </div>
  );
}

/**
 * How long the session's latest run has taken, ticking while it runs.
 *
 * Arithmetic over the timestamps the tasks already carry, grouped by the run they were
 * started under; nothing is stored. Frozen once the last task has finished.
 */
function RunClock({ tasks }: { tasks: Task[] }) {
  const { t } = useT();
  const latest = latestRun(tasks);
  const now = useNow(!!latest && latest.tasks.some(isLive));
  if (!latest) return null;
  const span = runSpanMs(latest.run, latest.tasks, now);
  return (
    <p className="muted small" style={{ margin: '4px 0 10px' }}>
      {t(span.live ? 'session.runClockLive' : 'session.runClock', { n: span.tasks, d: fmtDuration(span.ms) })}
    </p>
  );
}

/**
 * Instructions the model could not follow as written, on the task card.
 *
 * A block of its own rather than a line in the summary, because it is the one part of the
 * outcome that is a decision the operator did not make: the task said X, the machine refused,
 * and the model chose Y. That belongs in front of whoever wrote the task, not inside an account
 * of how well it went.
 */
function Deviations({ items }: { items: TaskDeviation[] }) {
  const { t } = useT();
  return (
    <div className="summary">
      <strong>{t('task.deviations', { n: items.length })}</strong>
      <ol style={{ margin: '6px 0', paddingLeft: 20 }}>
        {items.map((d, i) => (
          <li key={i} style={{ marginBottom: 6 }}>
            <div>{d.instruction}</div>
            <div className="muted">
              {t('task.deviationDid')}: {d.did}
            </div>
            <div className="muted">
              {t('task.deviationWhy')}: {d.why}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Review findings the model said were wrong, with its evidence.
 *
 * Shown because a dispute is a disagreement between two conversations that only a person can
 * finally settle: the next reviewer ruled on it, and the record of both sides is what the
 * operator reads when the ruling looks wrong.
 */
function Disputes({ items }: { items: TaskDispute[] }) {
  const { t } = useT();
  return (
    <div className="summary">
      <strong>{t('task.disputes', { n: items.length })}</strong>
      <ol style={{ margin: '6px 0', paddingLeft: 20 }}>
        {items.map((d, i) => (
          <li key={i} style={{ marginBottom: 6 }}>
            <div>
              <code>{d.finding}</code> — {d.why}
            </div>
            <div className="muted">
              {t('review.evidence')}: {d.evidence}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * What the independent review concluded, on the task it reviewed.
 *
 * Shown above the summary rather than below it, and deliberately so: the summary is the
 * implementer's account of its own work, and the reviewer's verdict is the thing that says
 * whether to believe it. Reading them in that order is reading them in the order they matter.
 */
function ReviewVerdict({ review }: { review?: TaskReview }) {
  const { t } = useT();
  if (!review) return null;
  // A review that was asked for and did not run says why; one switched off says so in a word.
  if (review.verdict === 'skipped') {
    return review.skippedBecause ? <p className="muted small">{t('review.skippedWhy', { why: review.skippedBecause })}</p> : null;
  }

  const tone = review.verdict === 'pass' ? 'done' : review.verdict === 'fail' ? 'blocked' : 'waiting-approval';

  return (
    <div className="small" style={{ margin: '8px 0' }}>
      <div className="row">
        <span className={`badge ${tone}`}>{t(`review.verdict.${review.verdict}` as Key)}</span>
        {review.stepsRun > 0 && <span className="muted">{t('review.ran', { n: review.stepsRun })}</span>}
        {review.rounds > 1 && <span className="muted">{t('review.rounds', { n: review.rounds })}</span>}
        {review.model && <span className="chip">{t('review.onModel', { model: review.model })}</span>}
      </div>

      {review.problem && <p className="reason">{t('review.problem', { problem: review.problem })}</p>}
      {review.summary && <RichText text={review.summary} />}

      {(review.findings?.length ?? 0) > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary>{t('review.findings', { n: review.findings?.length ?? 0 })}</summary>
          <ol style={{ margin: '6px 0', paddingLeft: 20 }}>
            {(review.findings ?? []).map((f, i) => (
              <li key={i} style={{ marginBottom: 8 }}>
                <div>
                  {f.id && <code style={{ marginRight: 6 }}>{f.id}</code>}
                  {f.what}
                  {f.about === 'task' && (
                    <span className="chip" style={{ marginLeft: 6 }}>
                      {t('review.aboutTask')}
                    </span>
                  )}
                  {f.repeated && (
                    <span className="chip" style={{ marginLeft: 6 }}>
                      {t('review.repeated')}
                    </span>
                  )}
                </div>
                {f.where && <div className="muted">{f.where}</div>}
                <div className="muted">
                  {t('review.evidence')}: {f.evidence}
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
