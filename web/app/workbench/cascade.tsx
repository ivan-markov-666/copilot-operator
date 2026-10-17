'use client';

/**
 * The workbench's chat, as an IDE's chat works (operator's request, 2026-10-17: "I write instructions in the chat
 * and it starts making changes — like Windsurf"). It is not tied to a task: it works in the open project folder.
 * A message is sent to Copilot, which answers with commands; the runner runs them in the folder and sends the
 * output back, round after round, until the chat says it is done — all of it shown here as the conversation:
 * the message, what Copilot says it is doing, a card per command with what it printed, the summary, and the
 * files it changed. The next message goes on in the same Copilot conversation and on the same branch; one written
 * while it works is a note it gets with its next report. A command waiting for an answer is asked about here.
 *
 * Each conversation is a session of kind `chat` and each message a task of it, so everything the runner does for
 * a task — the limits, keep going, the record — holds here too. It asks nothing about branches (2026-10-17): it
 * works on the branch the folder is on, which is the operator's to change, by hand or by asking the chat. Before
 * each message the folder is photographed, and "go back" on a message puts it back as it was then, with that
 * message and the ones after it gone from the conversation. The model is chosen under the box, as in an IDE.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Approval, type ChatThread, type ModelCatalogue, type Session, type Story, type StoryEntry, type Task, type Workspace } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { usePoll } from '../../lib/usePoll';
import { useFollowBottom } from '../../lib/useFollowBottom';
import { useUnattendedWithoutAsking } from '../../lib/useUnattendedWithoutAsking';
import { confirmDialog } from '../dialog';
import { BY_HAND, ModelPicker } from '../modelPicker';
import { ChangesButton } from '../diffView';
import { RichText } from '../richText';
import { StatusMark } from './workbench';

const THREAD_KEY = 'cop.chat.thread';
const MODE_KEY = 'cop.chat.mode';
const keep = (key: string, value: string): void => {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    /* a browser that keeps nothing starts each visit on a new conversation */
  }
};
const kept = (key: string): string => {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};

export function Cascade({ workspace, composeAsk, onOpenFile, onChange, onOpenFolder, onTurn }: { workspace: Workspace | null; composeAsk: number; onOpenFile: (path: string) => void; onChange: () => void; onOpenFolder: () => void; onTurn: (turn: { sessionId: string; taskId: string } | null) => void }) {
  const { t } = useT();
  const quietStart = useUnattendedWithoutAsking();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadId, setThreadId] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<'confirm' | 'unattended'>('confirm');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [approvals, setApprovals] = useState<Approval[]>([]);
  /** The models as the chat's picker last offered them, and the one for a conversation not started yet. */
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const [newModel, setNewModel] = useState('');
  const [reading, setReading] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const running = !!session && session.status !== 'idle';
  /*
   * What the model picker shows. "Set the model by hand" when it was chosen, and also when nothing names a model —
   * none of the conversation's own and none in Settings — because then the run asks for it by hand (2026-10-17;
   * the runner decides the same way, see `modelByHand` in taskRunner.ts). It replaced "Whatever the chat is on".
   */
  const settingsModel = catalogue?.defaultModel ?? '';
  const sessionModelShown = session ? (session.manualModel || (!session.model && !settingsModel) ? BY_HAND : (session.model ?? '')) : '';
  const newModelShown = newModel === BY_HAND || (!newModel && !settingsModel) ? BY_HAND : newModel;

  useEffect(() => {
    setThreadId(kept(THREAD_KEY));
    const m = kept(MODE_KEY);
    if (m === 'confirm' || m === 'unattended') setMode(m);
    else
      api
        .settings()
        .then((s) => setMode(((s.raw.execution as { mode?: string } | undefined)?.mode === 'unattended' ? 'unattended' : 'confirm')))
        .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (composeAsk > 0) box.current?.focus();
  }, [composeAsk]);
  useEffect(() => {
    api.models().then(setCatalogue).catch(() => undefined);
  }, []);

  const readThreads = useCallback(() => api.chatThreads().then(setThreads).catch(() => undefined), []);
  usePoll(readThreads, 5000);
  const readSession = useCallback(
    () =>
      threadId
        ? api
            .session(threadId)
            .then((s) => setSession(s.kind === 'chat' ? s : null))
            .catch(() => {
              setSession(null);
              setThreadId('');
              keep(THREAD_KEY, '');
            })
        : Promise.resolve(setSession(null)),
    [threadId],
  );
  useEffect(() => {
    void readSession();
  }, [readSession]);
  usePoll(readSession, running ? 1500 : 5000, !!threadId);
  usePoll(() => (threadId && running ? api.approvals(threadId).then(setApprovals).catch(() => undefined) : Promise.resolve(setApprovals([]))), 1500, !!threadId);

  const choose = (id: string) => {
    setThreadId(id);
    keep(THREAD_KEY, id);
    setSaid('');
  };
  const fresh = () => {
    choose('');
    setSession(null);
    box.current?.focus();
  };

  const send = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setSaid('');
    try {
      const fresh = !threadId;
      // Only when chosen: with no model anywhere the runner asks by hand anyway, and Settings may name one not read yet.
      const byHand = fresh && newModel === BY_HAND;
      const r = await api.chatSend(message, threadId || undefined, fresh && !byHand ? newModel || undefined : undefined, byHand);
      setText('');
      choose(r.threadId);
      if (r.noted) {
        setSaid(t('chat.noted'));
        return;
      }
      // Commands run without asking: said once, when a conversation begins, unless Settings say not to ask.
      if (mode === 'unattended' && fresh && !quietStart && !(await confirmDialog(t('session.unattendedConfirm')))) {
        setSaid(t('chat.notStartedYet'));
        return;
      }
      // No question about branches: the chat works on the branch the folder is on.
      const reply = await api.start(r.threadId, mode);
      if (!reply.started) setSaid(t('chat.notStarted', { reason: reply.reason ?? '' }));
    } catch (e) {
      setSaid((e as Error).message);
    } finally {
      setBusy(false);
      void readSession();
      void readThreads();
      onChange();
    }
  };
  /** "Go back to before this message": the folder as it was then, the message back in the box to write again. */
  const rewind = async (task: Task) => {
    if (!session || busy) return;
    if (!(await confirmDialog(t('chat.rewindConfirm', { n: session.tasks.length - session.tasks.indexOf(task) })))) return;
    setBusy(true);
    setSaid('');
    try {
      const r = await api.chatRewind(session.id, task.id);
      setText(r.text);
      setSaid(t('chat.rewound'));
      box.current?.focus();
    } catch (e) {
      setSaid((e as Error).message);
    } finally {
      setBusy(false);
      void readSession();
      onChange();
    }
  };
  /** The model of this conversation (or of the next one), as in an IDE's chat: chosen under the box. */
  const chooseModel = async (name: string) => {
    if (!session) {
      setNewModel(name);
      return;
    }
    try {
      await api.updateSession(session.id, name === BY_HAND ? { model: '', manualModel: true } : { model: name, manualModel: false });
      void readSession();
    } catch (e) {
      setSaid((e as Error).message);
    }
  };
  /** The latest models, read from Copilot's own picker (it opens the browser for a moment). */
  const readModels = async () => {
    setReading(true);
    setSaid(t('chat.modelsReading'));
    try {
      setCatalogue(await api.refreshModels());
      setSaid(t('chat.modelsRead'));
    } catch (e) {
      setSaid((e as Error).message);
    } finally {
      setReading(false);
    }
  };
  const stop = () => {
    if (session) void api.stop(session.id).then(() => setSaid(t('chat.stopping'))).catch((e: unknown) => setSaid((e as Error).message));
  };

  const last = session?.tasks.at(-1);
  useEffect(() => {
    onTurn(session && last ? { sessionId: session.id, taskId: last.id } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, last?.id]);
  const { ref: scrollRef } = useFollowBottom<HTMLDivElement>(true, `${session?.tasks.length ?? 0}:${last?.status ?? ''}:${last?.iterations ?? 0}`);

  return (
    <div className="cs">
      <div className="cs-head">
        <label htmlFor="cs-thread" className="sr-only">{t('chat.thread')}</label>
        <select id="cs-thread" value={threadId} onChange={(e) => choose(e.target.value)}>
          <option value="">{t('chat.newThread')}</option>
          {threads.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name.replace(/^chat: /, '')}
            </option>
          ))}
        </select>
        <button type="button" className="wb-icon-btn" onClick={fresh} title={t('chat.newChat')} aria-label={t('chat.newChat')}>
          +
        </button>
      </div>

      <div className="cs-body" ref={scrollRef} aria-live="polite">
        {!session ? (
          <Welcome workspace={workspace} onPick={(p) => { setText(p); box.current?.focus(); }} onOpenFolder={onOpenFolder} />
        ) : (
          session.tasks.map((task) => (
            <Turn key={task.id} session={session} task={task} approvals={approvals.filter((a) => a.taskId === task.id)} onOpenFile={onOpenFile} onRewind={running || busy ? undefined : () => void rewind(task)} />
          ))
        )}
        {said && <p className="cs-system" role="status">{said}</p>}
      </div>

      <div className="cs-compose">
        <label htmlFor="cs-input" className="sr-only">{t('chat.input')}</label>
        <textarea
          id="cs-input"
          ref={box}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={running ? t('chat.placeholderRunning') : workspace?.ok ? t('chat.placeholder', { folder: workspace.name }) : t('chat.placeholderNoFolder')}
          disabled={busy || !workspace?.ok}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="cs-bar">
          <label htmlFor="cs-model" className="sr-only">{t('chat.model')}</label>
          <ModelPicker
            id="cs-model"
            chosen={session ? sessionModelShown : newModelShown}
            onChange={(n) => void chooseModel(n)}
            byHand={t('chat.modelByHand')}
            none={catalogue?.defaultModel ? t('chat.modelDefault', { model: catalogue.defaultModel }) : undefined}
            catalogue={catalogue}
            disabled={running}
            style={{ minWidth: 0, maxWidth: '48%' }}
          />
          <button type="button" className="wb-icon-btn" onClick={() => void readModels()} disabled={reading || running} title={t('chat.readModels')} aria-label={t('chat.readModels')}>
            ↻
          </button>
        </div>
        <div className="cs-bar">
          <label htmlFor="cs-mode" className="sr-only">{t('chat.mode')}</label>
          <select id="cs-mode" value={mode} onChange={(e) => { const m = e.target.value as 'confirm' | 'unattended'; setMode(m); keep(MODE_KEY, m); }} disabled={running} title={t('chat.modeWhy')}>
            <option value="confirm">{t('chat.modeAsk')}</option>
            <option value="unattended">{t('chat.modeAuto')}</option>
          </select>
          <span className="grow" />
          {running && (
            <button type="button" className="danger" onClick={stop}>
              {t('chat.stop')}
            </button>
          )}
          <button type="button" className="primary" disabled={busy || !text.trim() || !workspace?.ok} onClick={() => void send()} title={t('chat.sendWhy')}>
            {running ? t('chat.sendNote') : t('chat.send')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** With no conversation chosen: what the chat works on, and a few ways to begin. */
function Welcome({ workspace, onPick, onOpenFolder }: { workspace: Workspace | null; onPick: (p: string) => void; onOpenFolder: () => void }) {
  const { t } = useT();
  if (!workspace) return <p className="muted small">{t('wb.loading')}</p>;
  if (!workspace.ok) {
    return (
      <div className="cs-welcome">
        <p>{workspace.problem}</p>
        <button type="button" className="primary" onClick={onOpenFolder}>{t('chat.openFolder')}</button>
      </div>
    );
  }
  const examples = [t('chat.example1'), t('chat.example2'), t('chat.example3')];
  return (
    <div className="cs-welcome">
      <h3>{t('chat.welcome', { folder: workspace.name })}</h3>
      <p className="muted small">{t('chat.welcomeWhy', { dir: workspace.dir, branch: workspace.branch ?? '—' })}</p>
      <ul className="cs-examples">
        {examples.map((e) => (
          <li key={e}>
            <button type="button" className="linkish" onClick={() => onPick(e)}>
              {e}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One message and everything that came of it. */
function Turn({ session, task, approvals, onOpenFile, onRewind }: { session: Session; task: Task; approvals: Approval[]; onOpenFile: (path: string) => void; onRewind?: () => void }) {
  const { t } = useT();
  const [story, setStory] = useState<Story | null>(null);
  const live = task.status === 'running' || task.status === 'waiting-approval';
  const read = () => (task.startedAt || live ? api.taskStory(session.id, task.id, task.runId).then(setStory).catch(() => undefined) : Promise.resolve());
  useEffect(() => {
    void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.runId, task.status]);
  usePoll(read, live ? 1500 : 60_000, live);

  const entries: StoryEntry[] = [];
  const walk = (es: StoryEntry[]): void => es.forEach((e) => (e.kind === 'review' ? walk(e.entries) : entries.push(e)));
  walk(story?.entries ?? []);

  return (
    <section className="cs-turn" aria-label={t('chat.turn', { text: task.title })}>
      <div className="cs-user-row">
        {onRewind && (task.checkpoint || task.status === 'queued') && (
          <button type="button" className="wb-icon-btn cs-rewind" onClick={onRewind} title={t('chat.rewind')} aria-label={t('chat.rewind')}>
            ↶
          </button>
        )}
        <div className="cs-user">
          <RichText text={task.prompt} />
        </div>
      </div>
      {task.status === 'queued' && <p className="muted small cs-system">{session.status === 'idle' ? t('chat.queued') : t('chat.waitingTurn')}</p>}
      {entries.map((e, i) =>
        e.kind === 'reply' ? (
          e.notes?.trim() ? (
            <div key={i} className="cs-bot">
              <RichText text={e.notes} />
            </div>
          ) : null
        ) : e.kind === 'step' ? (
          <Command key={i} step={e} />
        ) : null,
      )}
      {approvals.map((a) => (
        <Ask key={a.id} approval={a} />
      ))}
      {live && (
        <p className="cs-working" role="status">
          <span className="wb-live" aria-hidden="true" /> {t('chat.working', { n: task.iterations })}
        </p>
      )}
      {!live && task.status !== 'queued' && (
        <div className={`cs-end s-${task.status}`}>
          <StatusMark status={task.status} />
          <div className="grow">
            {task.summary ? <RichText text={task.summary} /> : null}
            {task.status !== 'done' && task.reason ? <p className="small">{task.reason}</p> : null}
          </div>
        </div>
      )}
      {(task.vcs?.files?.length ?? 0) > 0 && !live && (
        <div className="cs-files">
          <span className="small">{t('chat.changed', { n: task.vcs!.files!.length })}</span>
          {task.vcs!.files!.slice(0, 12).map((f) => (
            <button key={f.path} type="button" className="cs-file" onClick={() => onOpenFile(f.path)} title={f.path}>
              {f.path.split('/').pop()} <span className="muted">{f.added >= 0 ? `+${f.added} −${f.removed}` : ''}</span>
            </button>
          ))}
          <ChangesButton sessionId={session.id} taskId={task.id} runId={task.runId} title={task.title} files={task.vcs!.files!.length} />
        </div>
      )}
    </section>
  );
}

/** A command the chat had run, with what it printed: folded once it passed, open while it runs or when it failed. */
function Command({ step }: { step: Extract<StoryEntry, { kind: 'step' }> }) {
  const { t } = useT();
  const running = !step.outcome;
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? (running || step.failed);
  return (
    <div className={`cs-cmd${step.failed ? ' bad' : ''}`}>
      <button type="button" className="cs-cmd-head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <span className="cs-cmd-ico" aria-hidden="true">{running ? '⟳' : step.failed ? '✗' : '✓'}</span>
        <code className="wb-row-name">{step.command}</code>
        <span className="muted small">{running ? t('chat.running') : step.exitCode !== undefined ? t('chat.exit', { code: step.exitCode }) : step.outcome}</span>
      </button>
      {shown && step.output && <pre className="cs-out">{step.output}</pre>}
    </div>
  );
}

/** A command waiting to be run, asked about where it was asked for. */
function Ask({ approval }: { approval: Approval }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const answer = async (action: 'run' | 'skip' | 'abort' | 'run-all') => {
    setBusy(true);
    try {
      await api.decide(approval.id, action);
    } finally {
      setBusy(false);
    }
  };
  if (approval.plan || approval.model) return <p className="cs-system small">{t('chat.lookAbove')}</p>;
  return (
    <div className="cs-ask" role="group" aria-label={t('chat.askTitle')}>
      <p className="small"><strong>{t('chat.askTitle')}</strong></p>
      <pre className="cs-out">{approval.description}</pre>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => void answer('run')}>{t('chat.askRun')}</button>
        {!approval.network && <button type="button" disabled={busy} onClick={() => void answer('run-all')}>{t('chat.askRunAll')}</button>}
        <button type="button" disabled={busy} onClick={() => void answer('skip')}>{t('chat.askSkip')}</button>
      </div>
    </div>
  );
}
