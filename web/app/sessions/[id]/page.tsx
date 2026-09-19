'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { API, api, fmtBytes, CHECK_KINDS, checkNeedsCommand, checkNeedsValue, type Approval, type TaskCheck, type MirrorPreview, type ModelCatalogue, type Preset, type Session, type SessionEvent, type Task, type TaskReview, type VcsStatus, type VersionControl } from '../../../lib/api';
import { useT, useFmtTime, type Key } from '../../../lib/i18n';
import { findSelectionConflicts, linesOf } from '../../../lib/mirrorRules';
import { useAppearance } from '../../../lib/appearance';
import { ModelHint, ProjectHint } from '../../defaultHints';
import { RichText } from '../../richText';
import { useTaskActions } from '../../taskActions';

// ---------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------

export default function SessionPage() {
  const { t } = useT();
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [level1, setLevel1] = useState<{ content: string; customised: boolean } | null>(null);
  const [err, setErr] = useState('');
  const refreshTimer = useRef<number | null>(null);

  const reload = useCallback(async () => {
    try {
      setSession(await api.session(id));
      setErr('');
    } catch (e) {
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
    void reload();
    api.presets().then(setPresets).catch(() => undefined);
    api.level1().then(setLevel1).catch(() => undefined);

    const es = new EventSource(api.streamUrl(id));
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as SessionEvent;
      if (e.type === 'ping') return;
      setEvents((prev) => [...prev.slice(-400), e]);
      scheduleReload();
    };
    es.onerror = () => {
      /* EventSource reconnects by itself */
    };
    const poll = setInterval(() => void reload(), 8000);
    return () => {
      es.close();
      clearInterval(poll);
    };
  }, [id, reload, scheduleReload]);

  if (err && !session) return <div className="panel err">{err}</div>;
  if (!session) return <div className="panel muted">{t('home.loading')}</div>;

  const queued = session.tasks.filter((x) => x.status === 'queued').length;

  return (
    <>
      <div className="crumbs">
        <Link href="/">{t('session.crumb')}</Link> / {session.name}
      </div>

      <Header session={session} queued={queued} onChange={reload} />

      {(session.pending ?? []).map((a) => (
        <ApprovalBar key={a.id} approval={a} onDecided={reload} />
      ))}

      <ModelPanel session={session} onChange={reload} />

      <Level1Panel level1={level1} sent={session.contractSent} />

      <VcsPanel session={session} onChange={reload} />

      <ReviewPanel session={session} onChange={reload} />

      <MirrorPanel session={session} onChange={reload} />

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
  const [name, setName] = useState(session.name);
  const [group, setGroup] = useState(session.conversationGroup ?? '');
  useEffect(() => setName(session.name), [session.name]);
  useEffect(() => setGroup(session.conversationGroup ?? ''), [session.conversationGroup]);

  const start = async (mode: 'confirm' | 'unattended') => {
    if (mode === 'unattended' && !confirm(t('session.unattendedConfirm'))) return;
    const r = await api.start(session.id, mode);
    setMsg(
      r.started
        ? t(mode === 'unattended' ? 'session.startedAuto' : 'session.startedStep')
        : t('session.notStarted', { reason: r.reason ?? '' }),
    );
    onChange();
  };
  const stop = async () => {
    await api.stop(session.id);
    setMsg(t('session.stopping'));
    onChange();
  };
  const askAgain = async () => {
    await api.setRunMode(session.id, 'confirm');
    setMsg(t('session.askingAgain'));
    onChange();
  };
  const rename = async () => {
    if (name.trim() && name !== session.name) await api.updateSession(session.id, { name });
    onChange();
  };
  const remove = async () => {
    if (session.running) {
      setMsg(t('home.deleteRunning'));
      return;
    }
    if (!window.confirm(t('home.deleteConfirm', { name: session.name, n: session.tasks.length }))) return;
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
        <input type="text" className="grow" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void rename()} />
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
            <button className="primary" onClick={() => void start('unattended')} disabled={queued === 0}>
              {t('session.run', { n: queued })}
            </button>
            <p className="why">{t('session.runWhy')}</p>
          </div>
          <div>
            <button onClick={() => void start('confirm')} disabled={queued === 0}>
              {t('session.runStep')}
            </button>
            <p className="why">{t('session.runStepWhy')}</p>
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        {session.running && (
          <>
            <button className="danger" onClick={() => void stop()}>
              {t('session.stop')}
            </button>
            {/* A run switched to unattended says so, and can be put back to asking. */}
            {session.runMode === 'unattended' && (
              <>
                <span className="badge waiting-approval">{t('session.modeUnattended')}</span>
                <button onClick={() => void askAgain()}>{t('session.askAgain')}</button>
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
        {t('session.willUseModel', { name: session.model || t('model.default') })}
        {' · '}
        {session.mirror.enabled && session.mirror.rootDir ? (
          t('session.willUseFiles', {
            root: session.mirror.rootDir,
            dirs: session.mirror.includeDirs.length ? session.mirror.includeDirs.join(', ') : '.',
          })
        ) : (
          <span className="err">{t('session.noFiles')}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Approval bar: one per pending step
// ---------------------------------------------------------------------------------------

function ApprovalBar({ approval, onDecided }: { approval: Approval; onDecided: () => void }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const [busy, setBusy] = useState(false);
  const decide = async (action: 'run' | 'skip' | 'abort' | 'run-all') => {
    // Running the rest unattended is the same decision as starting unattended, so it is asked
    // in the same words. The step on screen has been seen; the ones after it have not.
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
    if (!window.confirm(t('model.refreshConfirm'))) return;
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

  const chosen = session.model ?? '';
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
          <option value="">{t('model.default')}</option>
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
        The standing choice, kept on this machine. It is copied onto a session when the session
        is created, so changing it later cannot quietly change what an existing session does.
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
      <input
        id="review-model"
        type="text"
        value={model}
        placeholder={t('review.modelSame')}
        onChange={(e) => setModel(e.target.value)}
        disabled={session.running || !enabled}
      />
      <p className="why">{t('review.modelWhy')}</p>
      <ModelHint current={model} onUse={(name) => setModel(name)} />

      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={() => void save()} disabled={busy || session.running}>
          {t('review.save')}
        </button>
        {msg && <span className="muted small">{msg}</span>}
      </div>
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
  useEffect(() => {
    setRepoDir((JSON.parse(saved) as VersionControl).repoDir);
  }, [saved]);

  /*
   * Whether the chosen folder is a repository at all, asked of the machine rather than guessed
   * from the path. It runs whether version control is on or off, because the answer is what
   * decides if it may be turned on; the session's own preflight only speaks once it already is.
   */
  const folder = (JSON.parse(saved) as VersionControl).repoDir || session.mirror.rootDir || '';
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
      const picked = await api.browseFolder(repoDir.trim() || session.mirror.rootDir || undefined);
      if (picked.ok) {
        setRepoDir(picked.path);
        await save({ repoDir: picked.path });
      } else {
        setMsg(picked.cancelled ? t('mirror.browseCancelled') : (picked.reason ?? ''));
      }
    } finally {
      setBusy(false);
    }
  };

  // Empty means the project the files are mirrored from, which is the usual case.
  const effectiveRepo = vcs.repoDir || session.mirror.rootDir || '';
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
          placeholder={session.mirror.rootDir || 'C:\\Projects\\my-app'}
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

          <h3>{t('vcs.branches')}</h3>
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

          {/* Whether it will actually work, checked against the real repository. */}
          {status && !status.ok && (
            <div className="notice caution" role="status">
              <strong>{t('vcs.notReady')}</strong> {status.problem}
            </div>
          )}
          {status?.ok && (
            <div className="muted small">
              {t('vcs.ready', { branch: status.branch ?? '—', dir: status.repoDir })}
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

// ---------------------------------------------------------------------------------------
// Project mirror
// ---------------------------------------------------------------------------------------

function MirrorPanel({ session, onChange }: { session: Session; onChange: () => void }) {
  const { t } = useT();
  const [enabled, setEnabled] = useState(session.mirror.enabled);
  const [rootDir, setRootDir] = useState(session.mirror.rootDir);
  const [include, setInclude] = useState(session.mirror.includeDirs.join('\n'));
  const [exclude, setExclude] = useState(session.mirror.excludeDirs.join('\n'));
  const [respectGitignore, setRespectGitignore] = useState(session.mirror.respectGitignore ?? true);
  const [includeEnvFiles, setIncludeEnvFiles] = useState(session.mirror.includeEnvFiles ?? false);
  const [dirs, setDirs] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<MirrorPreview | null>(null);
  const [busy, setBusy] = useState<'' | 'browse' | 'check'>('');
  const [msg, setMsg] = useState('');
  const [alwaysOut, setAlwaysOut] = useState<string[]>([]);

  // The page refetches the session every few seconds, which hands this component a brand new
  // `mirror` object every time even when nothing in it changed. Keying the reset on the
  // contents rather than on the object identity is what stops a poll from wiping a path
  // halfway through being typed.
  const savedMirror = JSON.stringify(session.mirror);
  useEffect(() => {
    const m = JSON.parse(savedMirror) as Session['mirror'];
    setEnabled(m.enabled);
    setRootDir(m.rootDir);
    setInclude(m.includeDirs.join('\n'));
    setExclude(m.excludeDirs.join('\n'));
    setRespectGitignore(m.respectGitignore ?? true);
    setIncludeEnvFiles(m.includeEnvFiles ?? false);
  }, [savedMirror]);

  useEffect(() => {
    api
      .doctor()
      .then((d) => setAlwaysOut((d.alwaysIgnoredDirs as string[]) ?? []))
      .catch(() => undefined);
  }, []);

  const includeDirs = linesOf(include);
  const excludeDirs = linesOf(exclude);
  const conflicts = findSelectionConflicts(includeDirs, excludeDirs);
  const settings = { rootDir: rootDir.trim(), includeDirs, excludeDirs, respectGitignore, includeEnvFiles };
  // The API refuses these too; the form knows them first so the button can say so.
  const missingRoot = enabled && !settings.rootDir;
  const blocked = conflicts.length > 0 || missingRoot;

  /**
   * Whether the form differs from what is stored.
   *
   * This panel needs an explicit Save while the model picker above it saves on change, and
   * that difference is a trap: a ticked checkbox looks the same whether it was saved or not.
   * A task written to read attached files was queued three times against a session that
   * attaches none, and the ticked box on screen was the reason it looked configured.
   */
  const storedShape = JSON.stringify({
    enabled: session.mirror.enabled,
    rootDir: session.mirror.rootDir,
    includeDirs: session.mirror.includeDirs,
    excludeDirs: session.mirror.excludeDirs,
    respectGitignore: session.mirror.respectGitignore ?? true,
    includeEnvFiles: session.mirror.includeEnvFiles ?? false,
  });
  const formShape = JSON.stringify({ enabled, ...settings });
  const unsaved = formShape !== storedShape;

  const save = async () => {
    if (blocked) return;
    try {
      await api.updateSession(session.id, { mirror: { enabled, ...settings } });
      setMsg(t('mirror.saved'));
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const listDirs = async () => {
    try {
      setDirs(await api.dirs(rootDir, respectGitignore));
      setMsg('');
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  /** Opens the machine's own folder dialog through the API and takes whatever comes back. */
  const browse = async () => {
    setBusy('browse');
    setMsg(t('mirror.browsing'));
    try {
      const picked = await api.browseFolder(rootDir.trim() || undefined);
      if (picked.ok) {
        setRootDir(picked.path);
        setDirs(null);
        setPreview(null);
        setMsg('');
      } else {
        setMsg(picked.cancelled ? t('mirror.browseCancelled') : (picked.reason ?? ''));
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const check = async () => {
    if (!settings.rootDir) {
      setMsg(t('mirror.needRoot'));
      return;
    }
    setBusy('check');
    setMsg(t('mirror.checking'));
    try {
      setPreview(await api.previewMirror(settings));
      setMsg('');
    } catch (e) {
      setPreview(null);
      setMsg((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  /** Turning the env switch on is a decision about secrets, so it is asked out loud once. */
  const toggleEnv = (on: boolean) => {
    if (on && !window.confirm(t('mirror.envWarn'))) return;
    setIncludeEnvFiles(on);
    setPreview(null);
  };

  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          {t('mirror.title')}
        </h2>
        {/* The badge reports what is stored, never what the form shows. */}
        <span className={`badge ${session.mirror.enabled ? 'done' : ''}`}>
          {session.mirror.enabled ? t('mirror.stateOn') : t('mirror.stateOff')}
        </span>
      </div>
      <p className="muted small">{t('mirror.hint', { example: 'src--test--a.spec.ts.txt' })}</p>

      <div className="option">
        <label>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{t('mirror.enable')}</span>
        </label>
      </div>

      <label htmlFor="mirror-root">{t('mirror.root')}</label>
      <div className="row">
        <input
          id="mirror-root"
          type="text"
          className="grow"
          value={rootDir}
          onChange={(e) => {
            setRootDir(e.target.value);
            setPreview(null);
          }}
          placeholder="C:\Projects\my-app"
        />
        <button onClick={() => void browse()} disabled={busy === 'browse'}>
          {t('mirror.browse')}
        </button>
        <button onClick={() => void listDirs()} disabled={!rootDir.trim()}>
          {t('mirror.listDirs')}
        </button>
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>
        {t('mirror.rootHint')}
      </div>
      <ProjectHint
        current={rootDir}
        onUse={(d) => {
          setRootDir(d);
          setPreview(null);
        }}
      />
      {dirs && (
        <div className="small muted" style={{ margin: '6px 0' }}>
          {dirs.length === 0 ? t('mirror.noDirs') : dirs.join(' · ')}
        </div>
      )}

      <h3>{t('mirror.rules')}</h3>
      <div className="option">
        <label>
          <input
            type="checkbox"
            checked={respectGitignore}
            onChange={(e) => {
              setRespectGitignore(e.target.checked);
              setPreview(null);
            }}
          />
          <span>{t('mirror.gitignore')}</span>
        </label>
        <p className="why">{t('mirror.gitignoreWhy')}</p>
      </div>
      <div className={`option${includeEnvFiles ? ' warned' : ''}`}>
        <label>
          <input type="checkbox" checked={includeEnvFiles} onChange={(e) => toggleEnv(e.target.checked)} />
          <span>{t('mirror.env')}</span>
        </label>
        <p className="why">{t('mirror.envWhy')}</p>
        {includeEnvFiles && (
          <p className="why">
            <strong>{t('mirror.envOn')}</strong>
          </p>
        )}
      </div>
      {alwaysOut.length > 0 && <p className="muted small">{t('mirror.alwaysOut', { dirs: alwaysOut.join(', ') })}</p>}

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <label htmlFor="mirror-include">{t('mirror.include')}</label>
          <textarea
            id="mirror-include"
            value={include}
            onChange={(e) => {
              setInclude(e.target.value);
              setPreview(null);
            }}
            placeholder={'src\ntests'}
            style={{ minHeight: 80 }}
            aria-invalid={conflicts.length > 0}
          />
        </div>
        <div className="grow">
          <label htmlFor="mirror-exclude">{t('mirror.exclude')}</label>
          <textarea
            id="mirror-exclude"
            value={exclude}
            onChange={(e) => {
              setExclude(e.target.value);
              setPreview(null);
            }}
            placeholder={'src/generated'}
            style={{ minHeight: 80 }}
            aria-invalid={conflicts.length > 0}
          />
        </div>
      </div>

      {conflicts.length > 0 && (
        <div className="notice" role="alert">
          <strong>{t('mirror.conflict')}</strong>
          <ul>
            {conflicts.map((c, i) => (
              <li key={i}>
                {c.kind === 'same'
                  ? t('mirror.conflictSame', { dir: c.include })
                  : t('mirror.conflictParent', { include: c.include, exclude: c.exclude })}
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 6 }}>{t('mirror.conflictFix')}</div>
        </div>
      )}

      {missingRoot && (
        <div className="notice caution" role="alert">
          <strong>{t('mirror.needRoot')}</strong>
        </div>
      )}

      {unsaved && (
        <div className="notice caution" role="status">
          <strong>{t('mirror.unsaved')}</strong> {t('mirror.unsavedWhy')}
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={() => void save()} disabled={blocked}>
          {t('mirror.save')}
        </button>
        <button onClick={() => void check()} disabled={conflicts.length > 0 || busy === 'check'}>
          {t('mirror.check')}
        </button>
        <span className="muted small" role="status">
          {msg}
        </span>
      </div>

      {preview && <MirrorPreviewBox preview={preview} />}
    </div>
  );
}

/** What the current selection would actually copy. The only honest way to check the switches. */
function MirrorPreviewBox({ preview }: { preview: MirrorPreview }) {
  const { t } = useT();
  if (preview.files.length === 0) {
    return (
      <div className="notice caution" style={{ marginTop: 10 }}>
        <strong>{t('mirror.checkedNone')}</strong>
      </div>
    );
  }
  return (
    <div className="notice calm" style={{ marginTop: 10 }}>
      <strong>{t('mirror.checked', { files: preview.files.length, size: fmtBytes(preview.totalBytes) })}</strong>{' '}
      {preview.envFiles.length > 0 && <span className="err">{t('mirror.checkedEnv', { n: preview.envFiles.length })}</span>}{' '}
      {preview.skipped.length > 0 && <span className="muted">{t('mirror.checkedSkipped', { n: preview.skipped.length })}</span>}
      <details style={{ marginTop: 6 }}>
        <summary>{t('mirror.showFiles')}</summary>
        <pre className="tall">{preview.files.join('\n')}</pre>
      </details>
      {preview.skipped.length > 0 && (
        <details>
          <summary>{t('mirror.showSkipped')}</summary>
          <pre className="tall">{preview.skipped.map((s) => `${s.relPath}  —  ${s.reason}`).join('\n')}</pre>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Is this queue one chain, or a set of independent tasks?
// ---------------------------------------------------------------------------------------

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
        <label className="grow" style={{ margin: 0 }}>
          {t('l2.label')}
        </label>
        <select
          value=""
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
  const href = (variant: 'full' | 'outcome') =>
    `${API}/sessions/${session.id}/export?variant=${variant}` +
    (picked.length > 0 ? `&tasks=${encodeURIComponent(picked.join(','))}` : '');

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

  const add = async () => {
    try {
      await api.addTask(session.id, { title, level2, prompt: promptText });
      setTitle('');
      setPromptText('');
      setMsg(t('form.queued'));
      onAdded();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="panel">
      <h2>{t('form.title')}</h2>
      <p className="muted small">{t('form.hint')}</p>
      <label>{t('form.titleLabel')}</label>
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('form.titlePlaceholder')} />
      <div style={{ marginTop: 10 }}>
        <Level2Editor value={level2} onChange={setLevel2} presets={presets} onPresetsChanged={onPresetsChanged} />
      </div>
      <label>{t('form.taskLabel')}</label>
      <textarea
        className="prose"
        value={promptText}
        onChange={(e) => setPromptText(e.target.value)}
        placeholder={t('form.taskPlaceholder')}
        style={{ minHeight: 140 }}
      />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={() => void add()} disabled={!promptText.trim()}>
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
  const [title, setTitle] = useState(task.title);
  const [level2, setLevel2] = useState(task.level2);
  const [promptText, setPromptText] = useState(task.prompt);
  // The names the task carries into git. An import sets these; without them in the form, a
  // task that arrived as JSON would be the only kind with a part nobody can change.
  const [branch, setBranch] = useState(task.vcsPlan?.branch ?? '');
  const [commitMessage, setCommitMessage] = useState(task.vcsPlan?.commitMessage ?? '');
  const [checks, setChecks] = useState<TaskCheck[]>(task.checks ?? []);
  const [files, setFiles] = useState<{ reports: string[]; artifacts: string[]; replies: string[] } | null>(null);
  const [msg, setMsg] = useState('');

  const save = async () => {
    try {
      await api.updateTask(session.id, task.id, { title, level2, prompt: promptText, vcsPlan: { branch, commitMessage }, checks });
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

  const rerun = async () => {
    if (!window.confirm(t('task.rerunConfirm', { title: task.title }))) return;
    try {
      await api.rerunTask(session.id, task.id);
      onChange();
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
    if (!window.confirm(t('task.editRanConfirm', { title: task.title }))) return;
    try {
      await api.rerunTask(session.id, task.id, { title, level2, prompt: promptText, vcsPlan: { branch, commitMessage }, checks });
      setEditing(false);
      onChange();
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
    if (!confirm(t(question, { title: task.title }))) return;
    try {
      await api.deleteTask(session.id, task.id);
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const loadFiles = async () => {
    if (!files) setFiles(await api.taskFiles(session.id, task.id));
  };

  const fileLinks = (label: Key, kind: 'reports' | 'artifacts' | 'replies', names: string[]) =>
    names.length > 0 && (
      <div>
        <span className="muted">{t(label)} </span>
        {names.map((n) => (
          <a key={n} href={api.taskFileUrl(session.id, task.id, kind, n)} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>
            {n}
          </a>
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
        {(task.attempt ?? 1) > 1 && <span className="chip">{t('task.attemptN', { n: task.attempt ?? 1 })}</span>}
        {task.iterations > 0 && <span className="muted small">{t('task.iterations', { n: task.iterations })}</span>}
        {editable && (
          <button onClick={() => setEditing((v) => !v)} title={t('task.editAll')}>
            {editing ? t('task.cancel') : t('task.edit')}
          </button>
        )}
        {rerunnable && (
          <button className="primary" onClick={() => void rerun()} title={t('task.rerunWhy')}>
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

          <ReviewVerdict review={task.review} />

          {task.summary && (
            <div className="summary">
              <strong>{t('task.whatWasDone')}</strong>
              <RichText text={task.summary} />
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
                    {a.runId && (
                      <a href={api.taskLogUrl(session.id, task.id, a.runId)} target="_blank" rel="noreferrer">
                        {t('task.log')}
                      </a>
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
                <a href={api.taskLogUrl(session.id, task.id)} target="_blank" rel="noreferrer">
                  {t('task.log')}
                </a>
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
 * What the independent review concluded, on the task it reviewed.
 *
 * Shown above the summary rather than below it, and deliberately so: the summary is the
 * implementer's account of its own work, and the reviewer's verdict is the thing that says
 * whether to believe it. Reading them in that order is reading them in the order they matter.
 */
function ReviewVerdict({ review }: { review?: TaskReview }) {
  const { t } = useT();
  if (!review || review.verdict === 'skipped') return null;

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
                <div>{f.what}</div>
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
