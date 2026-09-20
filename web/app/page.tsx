'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type Approval, type BatchState, type ModelCatalogue, type Session, type VcsStatus } from '../lib/api';
import { useT, useFmtTime, type Key } from '../lib/i18n';
import { ModelHint } from './defaultHints';

export default function SessionsPage() {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [onFailure, setOnFailure] = useState<'stop' | 'continue'>('stop');
  const [fromPlan, setFromPlan] = useState(false);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [apiUp, setApiUp] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, current, waiting] = await Promise.all([
        api.sessions(),
        api.batch().catch(() => null),
        api.approvals().catch(() => [] as Approval[]),
      ]);
      setSessions(list);
      setBatch(current);
      setApprovals(waiting);
      // A session that has been deleted since it was ticked must not stay in the list the
      // start button would send.
      setSelected((prev) => prev.filter((id) => list.some((s) => s.id === id)));
      setApiUp(true);
      setError('');
    } catch (e) {
      setApiUp(false);
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);

  /*
   * An import hands this page its sessions and the plan's own answer to "if a session fails".
   *
   * Through the URL rather than through storage, so it is visible, survives a reload of the
   * link, and is gone the moment the operator changes anything. The query is then removed
   * from the address bar: coming back to this page later should not re-tick a selection the
   * operator has since changed their mind about.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const run = (params.get('run') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (run.length === 0) return;
    setSelected(run);
    setOnFailure(params.get('fail') === 'continue' ? 'continue' : 'stop');
    setFromPlan(true);
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const create = async () => {
    try {
      const s = await api.createSession(name || 'session');
      setName('');
      window.location.href = `/sessions/${s.id}`;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * Removing a session from the list, and only from the list.
   *
   * The run folders under `runs/` and the conversation in Copilot both survive on purpose: the
   * record of what was executed on this machine is not something a tidy-up of the session list
   * should be able to destroy. The confirmation says so, because "delete" usually means more.
   */
  const remove = async (session: Session) => {
    if (session.running) {
      setMsg(t('home.deleteRunning'));
      return;
    }
    if (!window.confirm(t('home.deleteConfirm', { name: session.name, n: session.tasks.length }))) return;
    try {
      await api.deleteSession(session.id);
      setMsg(t('home.deleted', { name: session.name }));
      setSelected((prev) => prev.filter((id) => id !== session.id));
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  /** The same, for everything that is ticked. One question, then one pass. */
  const removeSelected = async () => {
    const chosen = (sessions ?? []).filter((x) => selected.includes(x.id));
    if (chosen.length === 0) return;
    const names = chosen.map((x) => `• ${x.name} (${x.tasks.length})`).join('\n');
    if (!window.confirm(t('home.deleteSelectedConfirm', { n: chosen.length, names }))) return;

    let done = 0;
    const failed: string[] = [];
    for (const session of chosen) {
      try {
        await api.deleteSession(session.id);
        done += 1;
      } catch (e) {
        failed.push(`${session.name}: ${(e as Error).message}`);
      }
    }
    setMsg(
      failed.length === 0
        ? t('home.deletedMany', { n: done })
        : t('home.deleteSomeFailed', { n: done, m: failed.length, why: failed.join('; ') }),
    );
    setSelected([]);
    await load();
  };

  const stateLabel = (s: Session) => (s.running ? t('state.running') : t(`state.${s.status}` as 'state.idle'));
  const queuedIn = (s: Session) => s.tasks.filter((x) => x.status === 'queued').length;

  /**
   * Ticking a session puts it in its place rather than at the end.
   *
   * The list on this page is newest first, so appending in the order they are clicked would
   * run an imported plan backwards. Oldest first is the order the sessions were created in,
   * which for an imported plan is the order the plan asked for.
   */
  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      const order = (sessions ?? []).map((s) => s.id).reverse();
      const next = [...prev, id];
      return next.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    });
  };

  const move = (id: string, by: -1 | 1) => {
    setSelected((prev) => {
      const i = prev.indexOf(id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  return (
    <>
      {apiUp === false && (
        <div className="panel">
          <strong>{t('home.apiDown')}</strong>
          <div className="muted small">
            {t('home.apiHint', { cmd: 'npm start', url: process.env.NEXT_PUBLIC_COP_API ?? 'http://127.0.0.1:4000/api' })}
          </div>
          {error && <div className="err">{error}</div>}
        </div>
      )}

      {approvals.length > 0 && (
        <div className="panel">
          <h2>{t('approval.waitingHere')}</h2>
          <p className="muted small">{t('approval.waitingHereWhy')}</p>
          {approvals.map((a) => (
            <HomeApproval
              key={a.id}
              approval={a}
              sessionName={sessions?.find((x) => x.id === a.sessionId)?.name ?? a.sessionId}
              onDecided={load}
            />
          ))}
        </div>
      )}

      <div className="panel">
        <h2>{t('home.new')}</h2>
        <p className="muted small">{t('home.newHint')}</p>
        <div className="row">
          <input
            type="text"
            className="grow"
            placeholder={t('home.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
            }}
          />
          <button className="primary" onClick={() => void create()} disabled={apiUp === false}>
            {t('home.create')}
          </button>
        </div>
      </div>

      {sessions && sessions.length > 0 && (
        <BatchPanel
          sessions={sessions}
          selected={selected}
          setSelected={setSelected}
          onFailure={onFailure}
          setOnFailure={setOnFailure}
          fromPlan={fromPlan}
          batch={batch}
          approvals={approvals}
          onChange={load}
          move={move}
        />
      )}

      <div className="panel">
        <h2>{t('home.sessions')}</h2>
        {sessions === null && <div className="muted">{t('home.loading')}</div>}
        {sessions && sessions.length === 0 && <div className="muted">{t('home.none')}</div>}
        {sessions && sessions.length > 0 && (
          <div className="row" style={{ marginBottom: 10 }}>
            <strong className="small">{t('home.selected', { n: selected.length })}</strong>
            <button
              className="danger"
              onClick={() => void removeSelected()}
              disabled={selected.length === 0 || batch?.running === true || sessions.some((x) => selected.includes(x.id) && x.running)}
            >
              {t('home.deleteSelected', { n: selected.length })}
            </button>
            <span className="muted small">{t('home.tickForBoth')}</span>
          </div>
        )}
        {sessions && sessions.length > 0 && <p className="muted small">{t('home.deleteWhy')}</p>}
        {msg && (
          <div className="muted small" role="status">
            {msg}
          </div>
        )}
        {sessions && sessions.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label={t('home.selectAll')}
                    checked={sessions.length > 0 && selected.length === sessions.length}
                    onChange={(e) => setSelected(e.target.checked ? sessions.map((x) => x.id).reverse() : [])}
                    disabled={batch?.running === true}
                  />
                </th>
                <th>{t('home.col.name')}</th>
                <th>{t('home.col.tasks')}</th>
                <th>{t('home.col.state')}</th>
                <th>{t('home.col.chat')}</th>
                <th>{t('home.col.created')}</th>
                <th>
                  <span className="visually-hidden">{t('home.col.remove')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const done = s.tasks.filter((x) => x.status === 'done').length;
                const queued = queuedIn(s);
                return (
                  <tr key={s.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.includes(s.id)}
                        onChange={() => toggle(s.id)}
                        disabled={batch?.running === true}
                        aria-label={s.name}
                      />
                    </td>
                    <td>
                      <Link href={`/sessions/${s.id}`}>{s.name}</Link>
                    </td>
                    <td>
                      {s.tasks.length} <span className="muted small">{t('home.tasksDetail', { done, queued })}</span>
                    </td>
                    <td>
                      <span className={`badge ${s.running ? 'running' : ''}`}>{stateLabel(s)}</span>
                    </td>
                    <td>
                      {s.chat ? (
                        <a href={s.chat.url} target="_blank" rel="noreferrer">
                          {s.chat.name}
                        </a>
                      ) : (
                        <span className="muted">{t('home.notOpened')}</span>
                      )}
                    </td>
                    <td className="muted small">{fmtTime(s.createdAt)}</td>
                    <td>
                      <button
                        className="quiet"
                        onClick={() => void remove(s)}
                        disabled={s.running || batch?.running === true}
                        title={t('home.delete')}
                      >
                        {t('home.delete')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Running several sessions in turn
// ---------------------------------------------------------------------------------------

/**
 * One button for a queue of queues.
 *
 * Everything here is sequential and says so. The browser profile belongs to one conversation
 * at a time, so "run these five sessions" can only ever mean one after another; a panel that
 * implied otherwise would be promising something the machine cannot do.
 */
function BatchPanel({
  sessions,
  selected,
  setSelected,
  onFailure,
  setOnFailure,
  fromPlan,
  batch,
  approvals,
  onChange,
  move,
}: {
  sessions: Session[];
  selected: string[];
  setSelected: (ids: string[]) => void;
  onFailure: 'stop' | 'continue';
  setOnFailure: (v: 'stop' | 'continue') => void;
  fromPlan: boolean;
  batch: BatchState | null;
  approvals: Approval[];
  onChange: () => void;
  move: (id: string, by: -1 | 1) => void;
}) {
  const { t } = useT();
  const [msg, setMsg] = useState('');
  const [model, setModel] = useState('');
  /*
   * The reviewer's model, separate from the one doing the work.
   *
   * It starts on the default review model when one is set, and empty otherwise: leaving every
   * session on what it is set to is the right default for a run panel, and the sentence under
   * the picker says why picking a different one here is worth the click.
   */
  const [reviewModel, setReviewModel] = useState('');
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const [vcsProblems, setVcsProblems] = useState<Array<{ name: string; problem: string }>>([]);

  useEffect(() => {
    api
      .models()
      .then((c) => {
        setCatalogue(c);
        // Starting on the default is the whole point of having one; leaving every session on
        // its own is still one click away, and the line below says which sessions that changes.
        setModel((current) => current || c.defaultModel);
        setReviewModel((current) => current || c.defaultReviewModel);
      })
      .catch(() => undefined);
  }, []);

  /*
   * Whether version control can actually do its job in the sessions that are about to run.
   *
   * Asked here, before the button is pressed, because the alternative is finding out an hour
   * later from a task card: a run whose repository is dirty still runs, it just quietly stops
   * branching and committing, and the work ends up loose in the tree. The session page has
   * always shown this for one session; a run of five needs it for all of them.
   */
  const selectedKey = selected.join(',');
  useEffect(() => {
    let cancelled = false;
    const ids = selectedKey.split(',').filter(Boolean);
    if (ids.length === 0) {
      setVcsProblems([]);
      return;
    }
    void Promise.all(
      ids.map(async (id) => {
        const status = await api.vcsStatus(id).catch(() => null as VcsStatus | null);
        return { id, status };
      }),
    ).then((results) => {
      if (cancelled) return;
      setVcsProblems(
        results
          .filter((r) => r.status && !r.status.ok && r.status.problem !== 'off')
          .map((r) => ({
            name: sessions.find((x) => x.id === r.id)?.name ?? r.id,
            problem: r.status?.problem ?? '',
          })),
      );
    });
    return () => {
      cancelled = true;
    };
    // `sessions` is only read for a name here; re-running on every poll would ask the API a
    // question about the file system three times a second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const queuedIn = (s: Session) => s.tasks.filter((x) => x.status === 'queued').length;
  const chosen = selected.map((id) => byId.get(id)).filter((s): s is Session => !!s);
  // The ticks also select what to delete, so a session with an empty queue can be ticked. It
  // is left out of the run rather than sent and skipped, which would fill the report with rows
  // about sessions nobody meant to run.
  const runnable = chosen.filter((s) => queuedIn(s) > 0);
  const queuedTotal = runnable.reduce((n, s) => n + queuedIn(s), 0);
  const running = batch?.running === true;
  const oneAlreadyRunning = sessions.some((s) => s.running);
  const blocked = running || runnable.length === 0 || oneAlreadyRunning;

  /** The one thing standing in the way, said in the order the operator would meet it. */
  const blockedReason: { title: Key; why: Key } | null = oneAlreadyRunning
    ? { title: 'batch.oneRunning', why: 'batch.oneRunningWhy' }
    : chosen.length === 0
      ? { title: 'batch.pickFirst', why: 'batch.pickFirstWhy' }
      : runnable.length === 0
        ? { title: 'batch.nothingRunnable', why: 'batch.nothingRunnableWhy' }
        : null;

  const start = async (mode: 'confirm' | 'unattended') => {
    if (mode === 'unattended' && !confirm(t('batch.unattendedConfirm', { n: runnable.length }))) return;
    try {
      const r = await api.startBatch(
        runnable.map((s) => s.id),
        mode,
        onFailure,
        model || undefined,
        reviewModel || undefined,
      );
      setMsg(r.started ? '' : t('batch.notStarted', { reason: r.reason ?? '' }));
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const stop = async () => {
    await api.stopBatch();
    setMsg(t('batch.stopping'));
    onChange();
  };

  // Sessions the chosen model would change, named before the run rather than discovered after.
  const overridden = chosen.filter((s) => (s.model ?? '') !== model).length;
  // And the ones where a review model would have nothing to do, because the review is off.
  const reviewOff = chosen.filter((s) => s.review?.enabled === false).length;

  const all = catalogue?.options ?? [];
  const ungrouped = all.filter((o) => !o.group);
  const grouped = new Map<string, typeof all>();
  for (const o of all) {
    if (!o.group) continue;
    grouped.set(o.group, [...(grouped.get(o.group) ?? []), o]);
  }

  const counts = batch
    ? {
        done: batch.sessions.filter((s) => s.state === 'done').length,
        failed: batch.sessions.filter((s) => s.state === 'failed').length,
        skipped: batch.sessions.filter((s) => s.state === 'skipped' || s.state === 'stopped').length,
      }
    : null;
  const current = batch?.sessions.find((s) => s.state === 'running');


  return (
    <div className="panel">
      <h2>{t('batch.title')}</h2>
      <p className="muted small">{t('batch.hint')}</p>

      {!running && (
        <>
          <div className="row">
            <strong className="small">{t('batch.selected', { n: runnable.length, tasks: queuedTotal })}</strong>
            <button
              className="quiet"
              onClick={() => setSelected(sessions.filter((s) => queuedIn(s) > 0).map((s) => s.id).reverse())}
            >
              {t('batch.selectQueued')}
            </button>
            <button className="quiet" onClick={() => setSelected([])} disabled={chosen.length === 0}>
              {t('batch.selectNone')}
            </button>
          </div>

          {fromPlan && <p className="muted small">{t('batch.fromPlan')}</p>}
          {chosen.length > runnable.length && (
            <p className="muted small">{t('batch.notRunnable', { n: chosen.length - runnable.length })}</p>
          )}

          {runnable.length > 0 && (
            <ol className="run-order">
              {runnable.map((s, i) => (
                <li key={s.id}>
                  <span>
                    {s.name} <span className="muted small">({queuedIn(s)})</span>
                  </span>
                  <span>
                    <button className="quiet" onClick={() => move(s.id, -1)} disabled={i === 0} aria-label="up">
                      ↑
                    </button>
                    <button className="quiet" onClick={() => move(s.id, 1)} disabled={i === runnable.length - 1} aria-label="down">
                      ↓
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}

          <label htmlFor="batch-model">{t('batch.model')}</label>
          <div className="row">
            <select
              id="batch-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              style={{ width: 'auto', minWidth: 260 }}
            >
              <option value="">{t('batch.modelKeep')}</option>
              {ungrouped.map((o) => (
                <option key={o.name} value={o.name} disabled={o.disabled}>
                  {o.name}
                </option>
              ))}
              {[...grouped.entries()].map(([group, items]) => (
                <optgroup key={group} label={group}>
                  {items.map((o) => (
                    <option key={o.name} value={o.name} disabled={o.disabled}>
                      {o.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {(catalogue?.options.length ?? 0) === 0 && <span className="muted small">{t('batch.modelNone')}</span>}
          </div>
          <p className="why">{t('batch.modelWhy')}</p>
          <ModelHint current={model} onUse={(name) => setModel(name)} />
          {model && overridden > 0 && (
            <p className="why" style={{ color: 'var(--warn)' }}>{t('batch.modelOverrides', { n: overridden })}</p>
          )}

          <label htmlFor="batch-review-model">{t('batch.reviewModel')}</label>
          <div className="row">
            <select
              id="batch-review-model"
              value={reviewModel}
              onChange={(e) => setReviewModel(e.target.value)}
              style={{ width: 'auto', minWidth: 260 }}
            >
              <option value="">{t('batch.reviewModelKeep')}</option>
              {ungrouped.map((o) => (
                <option key={o.name} value={o.name} disabled={o.disabled}>
                  {o.name}
                </option>
              ))}
              {[...grouped.entries()].map(([group, items]) => (
                <optgroup key={group} label={group}>
                  {items.map((o) => (
                    <option key={o.name} value={o.name} disabled={o.disabled}>
                      {o.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <p className="why">{t('batch.reviewModelWhy')}</p>
          {reviewModel !== '' && reviewModel === model && (
            <p className="why" style={{ color: 'var(--warn)' }}>{t('batch.reviewSame')}</p>
          )}
          {reviewOff > 0 && <p className="why">{t('batch.reviewOffIn', { n: reviewOff })}</p>}

          <fieldset style={{ border: 0, padding: 0, margin: '10px 0 14px' }}>
            <legend className="muted small" style={{ padding: 0 }}>
              {t('batch.onFailure')}
            </legend>
            <div className="option">
              <label>
                <input type="radio" name="batch-fail" checked={onFailure === 'stop'} onChange={() => setOnFailure('stop')} />
                <span>{t('batch.chain')}</span>
              </label>
              <p className="why">{t('batch.chainWhy')}</p>
            </div>
            <div className="option">
              <label>
                <input type="radio" name="batch-fail" checked={onFailure === 'continue'} onChange={() => setOnFailure('continue')} />
                <span>{t('batch.independent')}</span>
              </label>
              <p className="why">{t('batch.independentWhy')}</p>
            </div>
          </fieldset>

          {/*
            Why the buttons are dead, next to the buttons. A disabled control with no reason
            beside it is a dead end: the operator can see that it will not work and has nothing
            to go on about what would make it work.
          */}
          {blockedReason && (
            <div className="notice caution">
              <strong>{t(blockedReason.title)}</strong>
              <div className="small" style={{ marginTop: 4 }}>{t(blockedReason.why)}</div>
            </div>
          )}

          {vcsProblems.length > 0 && (
            <div className="notice caution">
              <strong>{t('batch.vcsProblem')}</strong>
              <ul>
                {vcsProblems.map((p) => (
                  <li key={p.name}>{t('batch.vcsProblemRow', { name: p.name, problem: p.problem })}</li>
                ))}
              </ul>
              <div className="muted small">{t('batch.vcsProblemWhy')}</div>
            </div>
          )}

          <div className="run-choice">
            <div>
              <button className="primary" onClick={() => void start('unattended')} disabled={blocked}>
                {t('batch.run', { n: runnable.length })}
              </button>
              <p className="why">{t('batch.runWhy')}</p>
            </div>
            <div>
              <button onClick={() => void start('confirm')} disabled={blocked}>
                {t('batch.runStep')}
              </button>
              <p className="why">{t('batch.runStepWhy')}</p>
            </div>
          </div>
        </>
      )}

      {running && (
        <div className="row">
          <button onClick={() => void stop()} disabled={batch?.stopping}>
            {t('batch.stop')}
          </button>
          {/*
            The model the run is actually on, said out loud here because the picker it was
            chosen with is hidden for the duration. A control that vanishes with no replacement
            reads as a fault rather than as a deliberate lock.
          */}
          <span className="badge">
            {t('batch.modelRunning', {
              name:
                (current ? byId.get(current.sessionId)?.modelInUse || byId.get(current.sessionId)?.model : '') ||
                t('model.default'),
            })}
          </span>
          {approvals.length > 0 && <span className="badge waiting-approval">{t('batch.waiting', { n: approvals.length })}</span>}
          {current && (
            <span className="small">
              {t('batch.progress', {
                name: current.name,
                done: batch.sessions.filter((s) => s.state !== 'waiting' && s.state !== 'running').length,
                total: batch.sessions.length,
              })}
            </span>
          )}
        </div>
      )}

      {running && <p className="muted small">{t('batch.hiddenWhileRunning')}</p>}

      {msg && (
        <div className="muted small" role="status">
          {msg}
        </div>
      )}

      {/*
        The download is offered for whatever is ticked, and when nothing is, for the sessions of
        the last run — which is the moment people actually want it: something has just gone
        wrong and they want the whole picture in one file.
      */}
      {(chosen.length > 0 || batch) && (
        <div className="row" style={{ marginTop: 12 }}>
          <a
            className="button-link"
            href={api.debugExportUrl(chosen.length > 0 ? chosen.map((s) => s.id) : (batch?.sessions ?? []).map((s) => s.sessionId))}
          >
            {t('batch.debug')}
          </a>
          <span className="muted small">
            {chosen.length > 0 ? t('batch.debugSelected', { n: chosen.length }) : t('batch.debugLast')}
          </span>
        </div>
      )}
      {(chosen.length > 0 || batch) && <p className="why">{t('batch.debugWhy')}</p>}

      {batch && (
        <>
          {!running && counts && (
            <div className="notice calm" style={{ marginTop: 12 }}>
              <strong>{t('batch.finished', counts)}</strong>
            </div>
          )}
          <table style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>{t('batch.col.session')}</th>
                <th>{t('batch.col.state')}</th>
                <th>{t('batch.col.ran')}</th>
                <th>{t('batch.col.why')}</th>
              </tr>
            </thead>
            <tbody>
              {batch.sessions.map((s) => (
                <tr key={s.sessionId} className={`batch-row ${s.state}`}>
                  <td>
                    <Link href={`/sessions/${s.sessionId}`}>{s.name}</Link>
                  </td>
                  <td>
                    <span className={`badge ${badgeFor(s.state)}`}>{t(`batch.state.${s.state}` as Key)}</span>
                  </td>
                  <td className="small">{t('batch.ranOf', { ran: s.ran, failed: s.failed })}</td>
                  <td className="muted small">{s.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/** The badge classes already exist for task statuses; these are the same five colours. */
function badgeFor(state: BatchState['sessions'][number]['state']): string {
  if (state === 'running') return 'running';
  if (state === 'done') return 'done';
  if (state === 'failed') return 'failed';
  if (state === 'stopped') return 'aborted';
  return '';
}

/**
 * A step waiting for a decision, shown on the list rather than only on the session's page.
 *
 * Starting a run from here and then having to find the question somewhere else is the kind of
 * gap where a run looks stuck when it is simply waiting. The session's name is on every row
 * because, in a batch, which session is asking is half the question.
 */
function HomeApproval({
  approval,
  sessionName,
  onDecided,
}: {
  approval: Approval;
  sessionName: string;
  onDecided: () => void;
}) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const [busy, setBusy] = useState(false);

  const decide = async (action: 'run' | 'skip' | 'abort' | 'run-all') => {
    if (action === 'run-all' && !window.confirm(t('approval.runAllConfirm'))) return;
    setBusy(true);
    try {
      await api.decide(approval.id, action);
    } finally {
      setBusy(false);
      onDecided();
    }
  };

  return (
    <div className="approval">
      <div className="row">
        <strong>{t('approval.title', { n: approval.stepId })}</strong>
        <Link href={`/sessions/${approval.sessionId}`}>{sessionName}</Link>
        <span className="muted small">{fmtTime(approval.createdAt)}</span>
      </div>
      <pre style={{ margin: '8px 0' }}>{approval.description}</pre>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void decide('run')}>
          {t('approval.run')}
        </button>
        <button disabled={busy} onClick={() => void decide('run-all')} title={t('approval.runAllWhy')}>
          {t('approval.runAll')}
        </button>
        <button disabled={busy} onClick={() => void decide('skip')}>
          {t('approval.skip')}
        </button>
        <button className="danger" disabled={busy} onClick={() => void decide('abort')}>
          {t('approval.abort')}
        </button>
      </div>
    </div>
  );
}
