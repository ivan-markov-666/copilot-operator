'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api, fmtTime, type Approval, type Preset, type Session, type SessionEvent, type Task } from '../../../lib/api';

// ---------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------

export default function SessionPage() {
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
  if (!session) return <div className="panel muted">Loading…</div>;

  const queued = session.tasks.filter((t) => t.status === 'queued').length;

  return (
    <>
      <div className="crumbs">
        <Link href="/">Sessions</Link> / {session.name}
      </div>

      <Header session={session} queued={queued} onChange={reload} />

      {(session.pending ?? []).map((a) => (
        <ApprovalBar key={a.id} approval={a} onDecided={reload} />
      ))}

      <Level1Panel level1={level1} sent={session.contractSent} />

      <MirrorPanel session={session} onChange={reload} />

      <div className="panel">
        <h2>Tasks</h2>
        <p className="muted small">
          Run in this order, in the same conversation. When one finishes with a summary, the next queued one starts. A
          task that ends any other way stops the run and leaves the rest queued.
        </p>
        {session.tasks.length === 0 && <div className="muted">No tasks yet. Add one below.</div>}
        {session.tasks.map((t, i) => (
          <TaskCard key={t.id} session={session} task={t} index={i + 1} presets={presets} onChange={reload} />
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
  const [msg, setMsg] = useState('');
  const [name, setName] = useState(session.name);
  useEffect(() => setName(session.name), [session.name]);

  const start = async (mode: 'confirm' | 'unattended') => {
    if (mode === 'unattended' && !confirm('Unattended: commands written by Copilot will run without asking. Continue?')) return;
    const r = await api.start(session.id, mode);
    setMsg(r.started ? `started (${mode})` : `not started: ${r.reason}`);
    onChange();
  };
  const stop = async () => {
    await api.stop(session.id);
    setMsg('stopping after the current step');
    onChange();
  };
  const rename = async () => {
    if (name.trim() && name !== session.name) await api.updateSession(session.id, { name });
    onChange();
  };

  return (
    <div className="panel">
      <div className="row">
        <input type="text" className="grow" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void rename()} />
        <span className={`badge ${session.running ? 'running' : ''}`}>{session.running ? 'running' : session.status}</span>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        {!session.running ? (
          <>
            <button className="primary" onClick={() => void start('confirm')} disabled={queued === 0}>
              Run {queued} queued task{queued === 1 ? '' : 's'} (confirm each step)
            </button>
            <button onClick={() => void start('unattended')} disabled={queued === 0}>
              Run unattended
            </button>
          </>
        ) : (
          <button className="danger" onClick={() => void stop()}>
            Stop after current step
          </button>
        )}
        <span className="muted small">{msg}</span>
        <span className="grow" />
        {session.chat ? (
          <a href={session.chat.url} target="_blank" rel="noreferrer" className="small">
            open chat: {session.chat.name}
          </a>
        ) : (
          <span className="muted small">no conversation yet; the first run opens one</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Approval bar: one per pending step
// ---------------------------------------------------------------------------------------

function ApprovalBar({ approval, onDecided }: { approval: Approval; onDecided: () => void }) {
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
        <strong>Step {approval.stepId} is waiting for you</strong>
        <span className="muted small">{fmtTime(approval.createdAt)}</span>
      </div>
      <pre style={{ margin: '8px 0' }}>{approval.description}</pre>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void decide('run')}>
          Run
        </button>
        <button disabled={busy} onClick={() => void decide('skip')}>
          Skip
        </button>
        <button className="danger" disabled={busy} onClick={() => void decide('abort')}>
          Abort task
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Level 1, shown above the tasks
// ---------------------------------------------------------------------------------------

function Level1Panel({ level1, sent }: { level1: { content: string; customised: boolean } | null; sent: boolean }) {
  return (
    <div className="panel">
      <div className="row">
        <h2 className="grow" style={{ margin: 0 }}>
          Level 1: the contract with the runner
        </h2>
        <span className="badge">{sent ? 'sent in this conversation' : 'sent with the first task'}</span>
        <Link href="/level1" className="small">
          edit
        </Link>
      </div>
      <p className="muted small" style={{ marginBottom: 6 }}>
        Has priority over the level 2 instructions of every task below. Defines the phases, the json format, the
        stop word and the final summary.
        {level1?.customised ? ' Using your customised copy.' : ''}
      </p>
      <details>
        <summary>show the contract</summary>
        <pre className="tall">{level1?.content ?? '…'}</pre>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Project mirror
// ---------------------------------------------------------------------------------------

function MirrorPanel({ session, onChange }: { session: Session; onChange: () => void }) {
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
      setMsg('saved');
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
      <h2>Project files for the chat</h2>
      <p className="muted small">
        Selected directories are copied to one flat folder on the Desktop with the path in the file name (
        <code>src--test--a.spec.ts.txt</code>), only changed files are rewritten, and the files are attached to the first
        message of each task. Attaching uploads a copy to your OneDrive.
      </p>
      <label>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> attach project files
      </label>
      <label>Project root</label>
      <div className="row">
        <input type="text" className="grow" value={rootDir} onChange={(e) => setRootDir(e.target.value)} placeholder="C:\Projects\my-app" />
        <button onClick={() => void listDirs()} disabled={!rootDir.trim()}>
          List directories
        </button>
      </div>
      {dirs && (
        <div className="small muted" style={{ margin: '6px 0' }}>
          {dirs.length === 0 ? 'no selectable directories' : dirs.join(' · ')}
        </div>
      )}
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <label>Include (one per line; a directory includes everything beneath it)</label>
          <textarea value={include} onChange={(e) => setInclude(e.target.value)} placeholder={'src\ntests'} style={{ minHeight: 80 }} />
        </div>
        <div className="grow">
          <label>Exclude (one per line)</label>
          <textarea value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder={'src/generated'} style={{ minHeight: 80 }} />
        </div>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => void save()}>Save</button>
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
  const [msg, setMsg] = useState('');
  const saveAs = async () => {
    const name = prompt('Save these level 2 instructions as a preset named:');
    if (!name) return;
    try {
      await api.savePreset(name, value);
      setMsg(`saved as "${name}"`);
      onPresetsChanged?.();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <>
      <div className="row">
        <label className="grow" style={{ margin: 0 }}>
          Level 2: project, domain and team instructions for this task
        </label>
        <select
          value=""
          onChange={(e) => {
            const p = presets.find((x) => x.name === e.target.value);
            if (p) onChange(p.content);
          }}
        >
          <option value="">load a preset…</option>
          {presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <button onClick={() => void saveAs()} disabled={!value.trim()}>
          Save as preset
        </button>
      </div>
      <textarea
        className="prose"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'What the runner cannot know: the project, its layout, how tests run, the conventions, what never to touch.\nLeave empty if there is nothing to add. Level 1 always wins over anything here.'}
        style={{ minHeight: 140 }}
      />
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
      setMsg('queued');
      onAdded();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="panel">
      <h2>Add a task</h2>
      <p className="muted small">
        Goes to the end of the queue. If the session is running it will be picked up after the current tasks; if it
        is idle, press Run above. Level 2 is prefilled from the previous task so a series of tasks shares it.
      </p>
      <label>Title</label>
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="short name, e.g. run the unit tests" />
      <div style={{ marginTop: 10 }}>
        <Level2Editor value={level2} onChange={setLevel2} presets={presets} onPresetsChanged={onPresetsChanged} />
      </div>
      <label>Task</label>
      <textarea
        className="prose"
        value={promptText}
        onChange={(e) => setPromptText(e.target.value)}
        placeholder="What to do, what the result should be, what is out of bounds."
        style={{ minHeight: 140 }}
      />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={() => void add()} disabled={!promptText.trim()}>
          Add to queue
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
    if (!confirm(`Delete queued task "${task.title}"?`)) return;
    await api.deleteTask(session.id, task.id);
    onChange();
  };
  const loadFiles = async () => {
    if (!files) setFiles(await api.taskFiles(session.id, task.id));
  };

  return (
    <div className={`task ${task.status}`}>
      <div className="row">
        <h4 className="grow">
          {index}. {task.title}
        </h4>
        <span className={`badge ${task.status}`}>{task.status}</span>
        {task.iterations > 0 && <span className="muted small">{task.iterations} iteration{task.iterations === 1 ? '' : 's'}</span>}
        {task.status === 'queued' && !session.running && (
          <>
            <button onClick={() => setEditing((v) => !v)}>{editing ? 'Cancel' : 'Edit'}</button>
            <button className="danger" onClick={() => void remove()}>
              Delete
            </button>
          </>
        )}
      </div>
      <div className="muted small">
        {task.startedAt ? `started ${fmtTime(task.startedAt)}` : `added ${fmtTime(task.createdAt)}`}
        {task.finishedAt ? ` · finished ${fmtTime(task.finishedAt)}` : ''}
      </div>

      {editing ? (
        <div style={{ marginTop: 8 }}>
          <label>Title</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          <div style={{ marginTop: 8 }}>
            <Level2Editor value={level2} onChange={setLevel2} presets={presets} />
          </div>
          <label>Task</label>
          <textarea className="prose" value={promptText} onChange={(e) => setPromptText(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="primary" onClick={() => void save()}>
              Save
            </button>
            <span className="err">{msg}</span>
          </div>
        </div>
      ) : (
        <>
          {task.summary && (
            <div className="summary">
              <strong>What was done</strong>
              <div>{task.summary}</div>
            </div>
          )}
          {task.reason && (
            <div className="reason small" style={{ margin: '6px 0' }}>
              {task.reason}
            </div>
          )}

          <details>
            <summary>task prompt and level 2</summary>
            {task.level2.trim() && (
              <>
                <div className="muted small">level 2</div>
                <pre>{task.level2}</pre>
              </>
            )}
            <div className="muted small">task</div>
            <pre>{task.prompt}</pre>
          </details>

          {task.firstMessage && (
            <details>
              <summary>the exact first message that opened this task</summary>
              <pre className="tall">{task.firstMessage}</pre>
            </details>
          )}

          {task.runId && (
            <details onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && void loadFiles()}>
              <summary>everything executed, and the files</summary>
              <div className="row small" style={{ margin: '6px 0' }}>
                <a href={api.taskLogUrl(session.id, task.id)} target="_blank" rel="noreferrer">
                  task-log.txt: the whole task as text
                </a>
              </div>
              {files && (
                <div className="small">
                  {files.reports.length > 0 && (
                    <div>
                      <span className="muted">reports sent to Copilot: </span>
                      {files.reports.map((n) => (
                        <a key={n} href={api.taskFileUrl(session.id, task.id, 'reports', n)} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>
                          {n}
                        </a>
                      ))}
                    </div>
                  )}
                  {files.artifacts.length > 0 && (
                    <div>
                      <span className="muted">downloaded files: </span>
                      {files.artifacts.map((n) => (
                        <a key={n} href={api.taskFileUrl(session.id, task.id, 'artifacts', n)} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>
                          {n}
                        </a>
                      ))}
                    </div>
                  )}
                  {files.replies.length > 0 && (
                    <div>
                      <span className="muted">raw replies: </span>
                      {files.replies.map((n) => (
                        <a key={n} href={api.taskFileUrl(session.id, task.id, 'replies', n)} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>
                          {n}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </details>
          )}

          {task.finalReply && (
            <details>
              <summary>the last message Copilot sent</summary>
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
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events.length]);
  return (
    <div className="panel">
      <h2>Live</h2>
      <div className="log" ref={ref}>
        {events.length === 0 && <div className="muted">Nothing yet. Events appear here while a run is in progress.</div>}
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
