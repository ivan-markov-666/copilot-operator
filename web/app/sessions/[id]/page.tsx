'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api, type Approval, type Preset, type Session, type SessionEvent, type Task } from '../../../lib/api';
import { useT, useFmtTime, type Key } from '../../../lib/i18n';

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

      <Level1Panel level1={level1} sent={session.contractSent} />

      <MirrorPanel session={session} onChange={reload} />

      <div className="panel">
        <h2>{t('tasks.title')}</h2>
        <p className="muted small">{t('tasks.hint')}</p>
        {session.tasks.length === 0 && <div className="muted">{t('tasks.none')}</div>}
        {session.tasks.map((task, i) => (
          <TaskCard key={task.id} session={session} task={task} index={i + 1} presets={presets} onChange={reload} />
        ))}
      </div>

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
  useEffect(() => setName(session.name), [session.name]);

  const start = async (mode: 'confirm' | 'unattended') => {
    if (mode === 'unattended' && !confirm(t('session.unattendedConfirm'))) return;
    const r = await api.start(session.id, mode);
    setMsg(r.started ? t('session.started', { mode }) : t('session.notStarted', { reason: r.reason ?? '' }));
    onChange();
  };
  const stop = async () => {
    await api.stop(session.id);
    setMsg(t('session.stopping'));
    onChange();
  };
  const rename = async () => {
    if (name.trim() && name !== session.name) await api.updateSession(session.id, { name });
    onChange();
  };

  const stateLabel = session.running ? t('state.running') : t(`state.${session.status}` as Key);

  return (
    <div className="panel">
      <div className="row">
        <input type="text" className="grow" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void rename()} />
        <span className={`badge ${session.running ? 'running' : ''}`}>{stateLabel}</span>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        {!session.running ? (
          <>
            <button className="primary" onClick={() => void start('confirm')} disabled={queued === 0}>
              {t('session.run', { n: queued })}
            </button>
            <button onClick={() => void start('unattended')} disabled={queued === 0}>
              {t('session.runUnattended')}
            </button>
          </>
        ) : (
          <button className="danger" onClick={() => void stop()}>
            {t('session.stop')}
          </button>
        )}
        <span className="muted small">{msg}</span>
        <span className="grow" />
        {session.chat ? (
          <a href={session.chat.url} target="_blank" rel="noreferrer" className="small">
            {t('session.openChat', { name: session.chat.name })}
          </a>
        ) : (
          <span className="muted small">{t('session.noChat')}</span>
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
  const decide = async (action: 'run' | 'skip' | 'abort') => {
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
// Project mirror
// ---------------------------------------------------------------------------------------

function MirrorPanel({ session, onChange }: { session: Session; onChange: () => void }) {
  const { t } = useT();
  const [enabled, setEnabled] = useState(session.mirror.enabled);
  const [rootDir, setRootDir] = useState(session.mirror.rootDir);
  const [include, setInclude] = useState(session.mirror.includeDirs.join('\n'));
  const [exclude, setExclude] = useState(session.mirror.excludeDirs.join('\n'));
  const [dirs, setDirs] = useState<string[] | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setEnabled(session.mirror.enabled);
    setRootDir(session.mirror.rootDir);
    setInclude(session.mirror.includeDirs.join('\n'));
    setExclude(session.mirror.excludeDirs.join('\n'));
  }, [session.mirror]);

  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    try {
      await api.updateSession(session.id, {
        mirror: { enabled, rootDir: rootDir.trim(), includeDirs: lines(include), excludeDirs: lines(exclude) },
      });
      setMsg(t('mirror.saved'));
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const listDirs = async () => {
    try {
      setDirs(await api.dirs(rootDir));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="panel">
      <h2>{t('mirror.title')}</h2>
      <p className="muted small">{t('mirror.hint', { example: 'src--test--a.spec.ts.txt' })}</p>
      <label>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {t('mirror.enable')}
      </label>
      <label>{t('mirror.root')}</label>
      <div className="row">
        <input type="text" className="grow" value={rootDir} onChange={(e) => setRootDir(e.target.value)} placeholder="C:\Projects\my-app" />
        <button onClick={() => void listDirs()} disabled={!rootDir.trim()}>
          {t('mirror.listDirs')}
        </button>
      </div>
      {dirs && (
        <div className="small muted" style={{ margin: '6px 0' }}>
          {dirs.length === 0 ? t('mirror.noDirs') : dirs.join(' · ')}
        </div>
      )}
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <label>{t('mirror.include')}</label>
          <textarea value={include} onChange={(e) => setInclude(e.target.value)} placeholder={'src\ntests'} style={{ minHeight: 80 }} />
        </div>
        <div className="grow">
          <label>{t('mirror.exclude')}</label>
          <textarea value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder={'src/generated'} style={{ minHeight: 80 }} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => void save()}>{t('mirror.save')}</button>
        <span className="muted small">{msg}</span>
      </div>
    </div>
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
      <textarea className="prose" value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('l2.placeholder')} style={{ minHeight: 140 }} />
      {msg && <div className="muted small">{msg}</div>}
    </>
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
  const [files, setFiles] = useState<{ reports: string[]; artifacts: string[]; replies: string[] } | null>(null);
  const [msg, setMsg] = useState('');

  const save = async () => {
    try {
      await api.updateTask(session.id, task.id, { title, level2, prompt: promptText });
      setEditing(false);
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(t('task.deleteConfirm', { title: task.title }))) return;
    await api.deleteTask(session.id, task.id);
    onChange();
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
    <div className={`task ${task.status}`}>
      <div className="row">
        <h4 className="grow">
          {index}. {task.title}
        </h4>
        <span className={`badge ${task.status}`}>{t(`status.${task.status}` as Key)}</span>
        {task.iterations > 0 && <span className="muted small">{t('task.iterations', { n: task.iterations })}</span>}
        {task.status === 'queued' && !session.running && (
          <>
            <button onClick={() => setEditing((v) => !v)}>{editing ? t('task.cancel') : t('task.edit')}</button>
            <button className="danger" onClick={() => void remove()}>
              {t('task.delete')}
            </button>
          </>
        )}
      </div>
      <div className="muted small">
        {task.startedAt ? t('task.started', { t: fmtTime(task.startedAt) }) : t('task.added', { t: fmtTime(task.createdAt) })}
        {task.finishedAt ? ` · ${t('task.finished', { t: fmtTime(task.finishedAt) })}` : ''}
      </div>

      {editing ? (
        <div style={{ marginTop: 8 }}>
          <label>{t('form.titleLabel')}</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div style={{ marginTop: 8 }}>
            <Level2Editor value={level2} onChange={setLevel2} presets={presets} />
          </div>
          <label>{t('form.taskLabel')}</label>
          <textarea className="prose" value={promptText} onChange={(e) => setPromptText(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={() => void save()}>
              {t('task.save')}
            </button>
            <span className="err">{msg}</span>
          </div>
        </div>
      ) : (
        <>
          {task.summary && (
            <div className="summary">
              <strong>{t('task.whatWasDone')}</strong>
              <div>{task.summary}</div>
            </div>
          )}
          {task.reason && (
            <div className="reason small" style={{ margin: '6px 0' }}>
              {task.reason}
            </div>
          )}

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
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events.length]);
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
