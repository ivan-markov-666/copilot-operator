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
import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api, type Approval, type ChatThread, type LeadRound, type ModelCatalogue, type Session, type Skill, type Story, type StoryEntry, type Task, type Workspace } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { usePoll } from '../../lib/usePoll';
import { useFollowBottom } from '../../lib/useFollowBottom';
import { useUnattendedWithoutAsking } from '../../lib/useUnattendedWithoutAsking';
import { confirmDialog } from '../dialog';
import { BY_HAND, ModelPicker } from '../modelPicker';
import { ChangesButton } from '../diffView';
import { CopyButton } from '../copyButton';
import { RichText } from '../richText';
import { PlanCard } from '../approvals';
import { PlanView } from '../planView';
import { StatusMark } from './workbench';
import { FileIcon } from './fileIcon';

const THREAD_KEY = 'cop.chat.thread';
const MODE_KEY = 'cop.chat.mode';
/** Plan mode for the next new conversation, as last chosen in this browser. */
const PLAN_KEY = 'cop.chat.plan';
/** The review for the next new conversation, as last chosen in this browser: on unless 'off'. */
const REVIEW_KEY = 'cop.chat.review';
/** Two chats for the next new conversation, as last chosen in this browser: 'on', or one chat. */
const LEAD_KEY = 'cop.chat.lead';
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

/** What the chat shows: its latest message, `'new'` while it is on a new chat with nothing in it, or null. */
export type ChatTurn = { sessionId: string; taskId: string } | 'new' | null;

export function Cascade({ workspace, composeAsk, showThread, onOpenFile, onChange, onOpenFolder, onTurn }: { workspace: Workspace | null; composeAsk: number; /** A conversation to show, asked from outside the chat: the running one, from the status bar. */ showThread?: { id: string; n: number } | null; onOpenFile: (path: string) => void; onChange: () => void; onOpenFolder: () => void; onTurn: (turn: ChatTurn) => void }) {
  const { t, locale } = useT();
  const quietStart = useUnattendedWithoutAsking();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadId, setThreadId] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<'confirm' | 'unattended'>('confirm');
  /** Plan mode for a conversation not started yet; a started one has its own (`Session.planMode`). */
  const [newPlan, setNewPlan] = useState(false);
  /** The review for a conversation not started yet; a started one has its own (`Session.review`). */
  const [newReview, setNewReview] = useState(true);
  /**
   * Two chats for a conversation not started yet (operator, 2026-10-20): a lead that understands, plans and directs, and
   * a worker that carries out its subtasks. A started conversation keeps how it began. The worker's model: '' is the
   * lead's.
   */
  const [newLead, setNewLead] = useState(false);
  const [newWorkerModel, setNewWorkerModel] = useState('');
  /** The worker's session of a two-chat conversation, whose tasks are the lead's subtasks. */
  const [worker, setWorker] = useState<Session | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [approvals, setApprovals] = useState<Approval[]>([]);
  /** The models as the chat's picker last offered them, and the one for a conversation not started yet. */
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const [newModel, setNewModel] = useState('');
  const [reading, setReading] = useState(false);
  /** The skills of Settings (2026-10-21), and the one chosen for the next message ('' for none). */
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skill, setSkill] = useState('');
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
    setNewPlan(kept(PLAN_KEY) === 'on');
    setNewReview(kept(REVIEW_KEY) !== 'off');
    setNewLead(kept(LEAD_KEY) === 'on');
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
    if (showThread?.id) choose(showThread.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showThread?.n]);
  useEffect(() => {
    api.models().then(setCatalogue).catch(() => undefined);
    api.skills().then((r) => setSkills(r.skills)).catch(() => undefined);
  }, []);
  /** The skills offered here: the ones for every project, and the ones for the open folder. */
  const folderKey = (d: string): string => d.trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  const skillsHere = skills.filter((k) => !k.projectDir || (workspace?.dir && folderKey(k.projectDir) === folderKey(workspace.dir)));

  const readThreads = useCallback(() => api.chatThreads().then(setThreads).catch(() => undefined), []);
  usePoll(readThreads, 5000);
  const readSession = useCallback(
    () =>
      threadId
        ? api
            .session(threadId)
            .then((s) => setSession(s.kind === 'chat' ? s : null))
            .catch((e: unknown) => {
              // Only a conversation the API no longer has is forgotten. A read that failed on the way — the bot
              // restarting, a timeout, the page reloading under it — keeps it, and the next read opens it again
              // (2026-10-20: a reload while the first read was out lost the conversation).
              if ((e as { status?: number }).status !== 404) return;
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
  /*
   * A card answered here goes at once, not with the next read of the list (2026-10-20: the lead's question stayed on
   * the screen, answered, until then); a read already on its way when the answer went does not bring it back.
   */
  const answered = useRef(new Set<string>());
  const readApprovals = () => (threadId && running ? api.approvals(threadId).then((list) => setApprovals(list.filter((a) => !answered.current.has(a.id)))).catch(() => undefined) : Promise.resolve(setApprovals([])));
  usePoll(readApprovals, 1500, !!threadId);
  const decided = (id: string, ok: boolean) => {
    if (ok) {
      answered.current.add(id);
      setApprovals((list) => list.filter((a) => a.id !== id));
    }
    void readApprovals();
  };
  // The worker of a two-chat conversation: its tasks are the subtasks shown under the lead's message.
  const workerId = session?.lead?.workerSessionId ?? '';
  const readWorker = useCallback(() => (workerId ? api.session(workerId).then(setWorker).catch(() => undefined) : Promise.resolve(setWorker(null))), [workerId]);
  useEffect(() => {
    void readWorker();
  }, [readWorker]);
  usePoll(readWorker, running ? 1500 : 10_000, !!workerId);

  const choose = (id: string) => {
    setThreadId(id);
    keep(THREAD_KEY, id);
    setSaid('');
  };
  /** The conversation's model, with the button that reads the list again; as wide as `maxWidth` lets it. */
  const modelPicker = (maxWidth: string) => (
    <>
      <label htmlFor="cs-model" className="sr-only">{t('chat.model')}</label>
      <ModelPicker
        id="cs-model"
        chosen={session ? sessionModelShown : newModelShown}
        onChange={(n) => void chooseModel(n)}
        byHand={t('chat.modelByHand')}
        none={catalogue?.defaultModel ? t('chat.modelDefault', { model: catalogue.defaultModel }) : undefined}
        catalogue={catalogue}
        disabled={running}
        style={{ minWidth: 0, maxWidth }}
      />
      <button type="button" className="wb-icon-btn" onClick={() => void readModels()} disabled={reading || running} title={t('chat.readModels')} aria-label={t('chat.readModels')}>
        ↻
      </button>
    </>
  );
  /** Why "New chat" is off, or '' when it is on: a task running anywhere, or a new chat not begun yet. */
  const anyRunning = running || threads.some((x) => x.running);
  const newChatOff = anyRunning ? t('chat.newChatRunning') : !session ? t('chat.newChatFresh') : '';
  const fresh = () => {
    choose('');
    setSession(null);
    box.current?.focus();
  };

  const send = async () => {
    let message = text.trim();
    if (!message || busy) return;
    /*
     * "/its-name" at the start of the message chooses the skill (2026-10-21), as in Claude Code; the rest is the message.
     * Only a name followed by a space or the end: a path such as /etc/hosts is a message, not a skill.
     */
    let chosen = skill;
    const slash = skillsHere.length > 0 ? /^\/([a-z0-9][a-z0-9-]*[a-z0-9])(?=\s|$)\s*([\s\S]*)$/.exec(message) : null;
    if (slash) {
      const found = skillsHere.find((k) => k.name === slash[1]);
      if (!found) {
        setSaid(t('chat.skillUnknown', { name: slash[1]!, names: skillsHere.map((k) => `/${k.name}`).join(', ') }));
        return;
      }
      if (!slash[2]!.trim()) {
        setSaid(t('chat.skillNoText', { name: found.name }));
        return;
      }
      chosen = found.name;
      message = slash[2]!.trim();
    }
    setBusy(true);
    setSaid('');
    try {
      const fresh = !threadId;
      // Only when chosen: with no model anywhere the runner asks by hand anyway, and Settings may name one not read yet.
      const byHand = fresh && newModel === BY_HAND;
      // The language of the page goes along: the Copilot window says in it when the work on the message has ended.
      // Two chats, for a new conversation: the lead judges the worker's reports, so there is no review of its own.
      const two = fresh && newLead ? { workerModel: newWorkerModel === BY_HAND ? undefined : newWorkerModel || undefined, workerManualModel: newWorkerModel === BY_HAND } : undefined;
      const r = await api.chatSend(message, threadId || undefined, fresh && !byHand ? newModel || undefined : undefined, byHand, locale, fresh && newPlan, fresh ? (two ? false : newReview) : undefined, two, chosen || undefined);
      setText('');
      // A skill goes with one message: the next one starts without, unless chosen again.
      setSkill('');
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
  /**
   * A choice of the open conversation's, under the box: shown at once and written after, and read back either way, so
   * what the API refused goes back to what it holds. Shown only once the API had answered, a click on "Plan mode"
   * looked like it did nothing for as long as the write and the next read took (2026-10-20).
   */
  const changeSession = async (patch: { model?: string; manualModel?: boolean; planMode?: 'off' | 'approve'; review?: { enabled: boolean }; workerModel?: string; workerManualModel?: boolean }) => {
    if (!session) return;
    setSession((s) => {
      if (!s) return s;
      const { review, workerModel, workerManualModel, ...rest } = patch;
      return {
        ...s,
        ...rest,
        ...(review ? { review: { ...(s.review ?? { enabled: true, model: '' }), ...review } } : {}),
        ...(s.lead && (workerModel !== undefined || workerManualModel !== undefined)
          ? { lead: { ...s.lead, workerManualModel: workerManualModel || undefined, workerModel: workerManualModel ? undefined : workerModel || undefined } }
          : {}),
      };
    });
    try {
      await api.updateSession(session.id, patch);
    } catch (e) {
      setSaid((e as Error).message);
    } finally {
      void readSession();
    }
  };
  /** The model of this conversation (or of the next one), as in an IDE's chat: chosen under the box. */
  const chooseModel = async (name: string) => {
    if (!session) {
      setNewModel(name);
      return;
    }
    await changeSession(name === BY_HAND ? { model: '', manualModel: true } : { model: name, manualModel: false });
  };
  /**
   * Two chats (2026-10-20): a lead and a worker, chosen for a new conversation; a started one keeps how it began. The
   * worker's model is chosen beside the lead's: the same as the lead's when none is chosen, or by hand.
   */
  const leadOn = session ? !!session.lead : newLead;
  const chooseLead = (on: boolean) => {
    if (session) return;
    setNewLead(on);
    keep(LEAD_KEY, on ? 'on' : '');
  };
  const workerModelShown = session ? (session.lead?.workerManualModel ? BY_HAND : (session.lead?.workerModel ?? '')) : newWorkerModel;
  const chooseWorkerModel = async (name: string) => {
    if (!session) {
      setNewWorkerModel(name);
      return;
    }
    await changeSession(name === BY_HAND ? { workerModel: '', workerManualModel: true } : { workerModel: name, workerManualModel: false });
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
  /**
   * Plan mode, as in Claude Code (2026-10-20): Copilot first looks at the project with read-only commands and proposes a
   * plan, which is shown in the conversation to approve, to ask for another, or to stop; nothing changes before. Of the
   * conversation when there is one, else of the next one.
   */
  const planOn = session ? session.planMode === 'approve' : newPlan;
  const choosePlan = async (on: boolean) => {
    if (!session) {
      setNewPlan(on);
      keep(PLAN_KEY, on ? 'on' : '');
      return;
    }
    await changeSession({ planMode: on ? 'approve' : 'off' });
  };
  /**
   * The review (operator, 2026-10-20): when Copilot says the work is done, a conversation of its own checks it and sends
   * back what it finds. On unless unticked; of the conversation when there is one, else of the next one.
   */
  const reviewOn = session ? session.review?.enabled !== false : newReview;
  const chooseReview = async (on: boolean) => {
    if (!session) {
      setNewReview(on);
      keep(REVIEW_KEY, on ? '' : 'off');
      return;
    }
    await changeSession({ review: { enabled: on } });
  };
  /*
   * "Pause" and "Continue" (operator, 2026-10-20): the work holds at its next message to Copilot or its next command —
   * a reply being written and a command running are let finish — and goes on from there when asked. Shown at once,
   * as the other choices under the box are.
   */
  const paused = running && !!session?.paused;
  const togglePause = async () => {
    if (!session) return;
    const on = !session.paused;
    setSession((s) => (s ? { ...s, paused: on } : s));
    try {
      await (on ? api.pause(session.id) : api.resume(session.id));
    } catch (e) {
      setSaid((e as Error).message);
    } finally {
      void readSession();
    }
  };
  const stop = () => {
    if (session) void api.stop(session.id).then(() => setSaid(t('chat.stopping'))).catch((e: unknown) => setSaid((e as Error).message));
  };

  const last = session?.tasks.at(-1);
  // Two chats: the panel under the editor follows the worker's latest subtask, where the commands are.
  const lastSubtask = last?.lead?.rounds.filter((r) => r.subtask).at(-1)?.subtask;
  useEffect(() => {
    // A new chat is said as such: the panel under the editor then shows nothing of another conversation (2026-10-19).
    onTurn(!threadId ? 'new' : session && last ? (lastSubtask && workerId ? { sessionId: workerId, taskId: lastSubtask.taskId } : { sessionId: session.id, taskId: last.id }) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, session?.id, last?.id, lastSubtask?.taskId, workerId]);
  const { ref: scrollRef } = useFollowBottom<HTMLDivElement>(true, `${session?.tasks.length ?? 0}:${last?.status ?? ''}:${last?.iterations ?? 0}`);

  return (
    <div className="cs">
      <div className="cs-head">
        <label htmlFor="cs-thread" className="sr-only">{t('chat.thread')}</label>
        <select id="cs-thread" dir="auto" value={threadId} onChange={(e) => choose(e.target.value)}>
          <option value="">{t('chat.newThread')}</option>
          {threads.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name.replace(/^chat: /, '')}
            </option>
          ))}
        </select>
        {/*
          A button with its name on it (2026-10-18: "a 'New chat' button, where the tasks run in a new Copilot chat"): it
          was a bare "+". The next message opens a new conversation in Copilot; this one stays in the list beside it.
        */}
        {/*
          Off while a task runs, in this conversation or another, until it is stopped or its window closed; and on a new
          chat not begun yet, which this already is (operator, 2026-10-20). Each says why on hover and on focus.
        */}
        <span className="cs-new-wrap">
          <button
            type="button"
            className="cs-new"
            aria-disabled={newChatOff ? true : undefined}
            aria-describedby={newChatOff ? 'cs-new-tip' : undefined}
            onClick={() => {
              if (!newChatOff) fresh();
            }}
            title={newChatOff ? undefined : t('chat.newChatWhy')}
          >
            {t('chat.newChat')}
          </button>
          {newChatOff && (
            <span id="cs-new-tip" role="tooltip" className="cs-new-tip">
              {newChatOff}
            </span>
          )}
        </span>
      </div>

      <div className="cs-body" ref={scrollRef} aria-live="polite">
        {!session ? (
          <Welcome workspace={workspace} onPick={(p) => { setText(p); box.current?.focus(); }} onOpenFolder={onOpenFolder} />
        ) : (
          session.tasks.map((task) =>
            session.lead ? (
              <LeadTurn key={task.id} session={session} task={task} worker={worker} approvals={approvals} onDecided={decided} onOpenFile={onOpenFile} onRewind={running || busy ? undefined : () => void rewind(task)} />
            ) : (
              <Turn key={task.id} session={session} task={task} approvals={approvals.filter((a) => a.taskId === task.id)} onDecided={decided} onOpenFile={onOpenFile} onRewind={running || busy ? undefined : () => void rewind(task)} />
            ),
          )
        )}
        {paused && <p className="cs-system cs-paused" role="status">{t('chat.pausedNote')}</p>}
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
        {leadOn ? (
          /* Two chats: the worker's model under the lead's, the two pickers lined up — the lead's when none is chosen. */
          <div className="cs-models">
            <span className="cs-pick-label" aria-hidden="true">
              {t('chat.leadModel')}
            </span>
            <div className="cs-bar">{modelPicker('90%')}</div>
            <label htmlFor="cs-worker-model" className="cs-pick-label">
              {t('chat.workerModel')}
            </label>
            <div className="cs-bar">
              <ModelPicker
                id="cs-worker-model"
                chosen={workerModelShown}
                onChange={(n) => void chooseWorkerModel(n)}
                byHand={t('chat.modelByHand')}
                none={t('chat.workerSameModel')}
                catalogue={catalogue}
                disabled={running}
                style={{ minWidth: 0, maxWidth: '90%' }}
              />
            </div>
          </div>
        ) : (
          <div className="cs-bar">{modelPicker('48%')}</div>
        )}
        {/* Skills (2026-10-21): offered when Settings have one for this folder or for every project. */}
        {skillsHere.length > 0 && (
          <div className="cs-bar">
            <label htmlFor="cs-skill" className="cs-pick-label">
              {t('chat.skill')}
            </label>
            <select id="cs-skill" value={skill} onChange={(e) => setSkill(e.target.value)} disabled={running} title={t('chat.skillWhy')} style={{ minWidth: 0, maxWidth: '70%' }}>
              <option value="">{t('chat.skillNone')}</option>
              {skillsHere.map((k) => (
                <option key={k.name} value={k.name} title={k.description}>
                  /{k.name}
                  {k.description ? ` — ${k.description}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="cs-bar">
          <label htmlFor="cs-mode" className="sr-only">{t('chat.mode')}</label>
          <select id="cs-mode" value={mode} onChange={(e) => { const m = e.target.value as 'confirm' | 'unattended'; setMode(m); keep(MODE_KEY, m); }} disabled={running} title={t('chat.modeWhy')}>
            <option value="confirm">{t('chat.modeAsk')}</option>
            <option value="unattended">{t('chat.modeAuto')}</option>
          </select>
          <label className="cs-plan-toggle" title={t('chat.planModeWhy')}>
            <input type="checkbox" checked={planOn} disabled={running} onChange={(e) => void choosePlan(e.target.checked)} />
            <span>{t('chat.planMode')}</span>
          </label>
          {/* Two chats (2026-10-20): for a new conversation; a started one shows how it began. */}
          <label className="cs-plan-toggle cs-lead-toggle" title={t('chat.leadWhy')}>
            <input type="checkbox" checked={leadOn} disabled={running || !!session} onChange={(e) => chooseLead(e.target.checked)} />
            <span>{t('chat.lead')}</span>
          </label>
          {/* The lead judges the worker's reports: a conversation with two chats has no review of its own. */}
          {!leadOn && (
            <label className="cs-plan-toggle cs-review-toggle" title={t('chat.reviewWhy')}>
              <input type="checkbox" checked={reviewOn} disabled={running} onChange={(e) => void chooseReview(e.target.checked)} />
              <span>{t('chat.review')}</span>
            </label>
          )}
          {/*
            "Pause", "Stop" and "Add" (operator, 2026-10-20): one group, kept on one line — beside the rest when there is
            room, on a line of its own when there is not, and wrapped only when even alone it does not fit.
          */}
          <span className="cs-actions">
            {running && (
              <button type="button" className="cs-pause" onClick={() => void togglePause()} title={paused ? t('chat.resumeWhy') : t('chat.pauseWhy')}>
                {paused ? t('chat.resume') : t('chat.pause')}
              </button>
            )}
            {running && (
              <button type="button" className="danger" onClick={stop}>
                {t('chat.stop')}
              </button>
            )}
            <button type="button" className="primary" disabled={busy || !text.trim() || !workspace?.ok} onClick={() => void send()} title={t('chat.sendWhy')}>
              {running ? t('chat.sendNote') : t('chat.send')}
            </button>
          </span>
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
/** What a task's attempt said and ran, read from its run folder, again and again while it is live. */
function useStoryEntries(sessionId: string, task: Task | undefined): StoryEntry[] {
  const [story, setStory] = useState<Story | null>(null);
  const live = task?.status === 'running' || task?.status === 'waiting-approval';
  const read = () => (task && (task.startedAt || live) ? api.taskStory(sessionId, task.id, task.runId).then(setStory).catch(() => undefined) : Promise.resolve());
  useEffect(() => {
    void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, task?.id, task?.runId, task?.status]);
  usePoll(read, live ? 1500 : 60_000, !!live);
  const entries: StoryEntry[] = [];
  const walk = (es: StoryEntry[]): void => es.forEach((e) => (e.kind === 'review' ? walk(e.entries) : entries.push(e)));
  walk(story?.entries ?? []);
  return entries;
}

/** What Copilot said and what it ran, in order: its notes as messages, each command as a card. */
function StoryLines({ entries }: { entries: StoryEntry[] }) {
  return (
    <>
      {entries.map((e, i) =>
        e.kind === 'reply' ? (
          e.notes?.trim() ? (
            <div key={i} className="cs-bot">
              <RichText text={e.notes} />
              <div className="cs-copy-row">
                <CopyButton text={e.notes} what="chat.copyReply" />
              </div>
            </div>
          ) : null
        ) : e.kind === 'step' ? (
          <Command key={i} step={e} />
        ) : null,
      )}
    </>
  );
}

/** Said when a card in the conversation was answered: `ok` when the API took the answer, and the card goes. */
type Decided = (id: string, ok: boolean) => void;

function Turn({ session, task, approvals, onDecided, onOpenFile, onRewind }: { session: Session; task: Task; approvals: Approval[]; onDecided: Decided; onOpenFile: (path: string) => void; onRewind?: () => void }) {
  const { t } = useT();
  const live = task.status === 'running' || task.status === 'waiting-approval';
  const entries = useStoryEntries(session.id, task);

  return (
    <section className="cs-turn" id={`cs-turn-${task.id}`} aria-label={t('chat.turn', { text: task.title })}>
      <div className="cs-user-row">
        {onRewind && (task.checkpoint || task.status === 'queued') && (
          <button type="button" className="wb-icon-btn cs-rewind" onClick={onRewind} title={t('chat.rewind')} aria-label={t('chat.rewind')}>
            ↶
          </button>
        )}
        <div className="cs-user">
          {task.skill && <SkillChip skill={task.skill} />}
          <Folded>
            <RichText text={task.prompt} />
          </Folded>
          <div className="cs-copy-row">
            <CopyButton text={task.prompt} what="chat.copyMessage" />
          </div>
        </div>
      </div>
      {task.status === 'queued' && <p className="muted small cs-system">{session.status === 'idle' ? t('chat.queued') : t('chat.waitingTurn')}</p>}
      <StoryLines entries={entries} />
      {/* The plan, once approved: what the work follows, folded under its heading. */}
      {task.plan?.approved && !approvals.some((a) => a.plan) && (
        <details className="cs-plan">
          <summary>{t('chat.planShown', { v: task.plan.version })}</summary>
          <PlanView plan={task.plan} />
        </details>
      )}
      {approvals.map((a) => (
        <Ask key={a.id} approval={a} onDecided={onDecided} />
      ))}
      {live && (
        <p className="cs-working" role="status">
          <span className="wb-live" aria-hidden="true" /> {t('chat.working', { n: task.iterations })}
        </p>
      )}
      {!live && task.status !== 'queued' && <Ending task={task} />}
      {/*
        Everything that passed between the bot and Copilot for this message, and nothing of the others: every message
        sent, every reply, every command with its whole output, every attempt (2026-10-18). See taskExchange.ts.
      */}
      {task.runId && (
        <div className="cs-exchange">
          <a className="button-link quiet small" href={api.taskExchangeUrl(session.id, task.id)} download title={t('chat.exchangeWhy')}>
            {t('chat.exchange')}
          </a>
        </div>
      )}
      {(task.vcs?.files?.length ?? 0) > 0 && !live && (
        <div className="cs-files">
          <span className="small">{t('chat.changed', { n: task.vcs!.files!.length })}</span>
          {task.vcs!.files!.slice(0, 12).map((f) => (
            <button key={f.path} type="button" className="cs-file" onClick={() => onOpenFile(f.path)} title={f.path}>
              <FileIcon path={f.path} /> {f.path.split('/').pop()} <span className="muted">{f.added >= 0 ? `+${f.added} −${f.removed}` : ''}</span>
            </button>
          ))}
          <ChangesButton sessionId={session.id} taskId={task.id} runId={task.runId} title={task.title} files={task.vcs!.files!.length} />
        </div>
      )}
    </section>
  );
}

/**
 * How the message ended: the summary, and why when it did not end done, with "Copy" beside it — and under it too when
 * it is long (2026-10-20: "the Copy button not only at the top of the last message, but at the bottom as well"), so a
 * long summary is copied without scrolling back up.
 */
function Ending({ task }: { task: Task }) {
  const body = useRef<HTMLDivElement | null>(null);
  const [long, setLong] = useState(false);
  const text = [task.summary, task.status !== 'done' ? task.reason : ''].filter(Boolean).join('\n\n');
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = (): void => {
      const style = window.getComputedStyle(el);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.45;
      setLong(el.scrollHeight > line * LONG_ENDING_LINES);
    };
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  return (
    <div className={`cs-end s-${task.status}`}>
      <StatusMark status={task.status} />
      <div className="grow" ref={body}>
        {task.summary ? <RichText text={task.summary} /> : null}
        {task.status !== 'done' && task.reason ? <p className="small">{task.reason}</p> : null}
        {text && long && (
          <div className="cs-copy-row cs-copy-bottom">
            <CopyButton text={text} what="chat.copySummary" />
          </div>
        )}
      </div>
      {text && <CopyButton text={text} what="chat.copySummary" />}
    </div>
  );
}

/** From how many lines an ending is long enough for a second "Copy" under it. */
const LONG_ENDING_LINES = 6;

/** How many lines of a long message show while it is folded. */
const FOLDED_LINES = 3;

/**
 * A long message of the operator's, folded to its first three lines (2026-10-19: "if it is too long, do not show all of
 * it: the first three lines, an arrow below them that opens it, and a blur that comes on gradually"). The lines fade
 * out and blur more the lower they are; the arrow opens the whole and closes it again. A message that fits in three
 * lines is shown as it is, with no arrow. Measured as it is drawn, so a change of the text size counts.
 */
function Folded({ children }: { children: ReactNode }) {
  const { t } = useT();
  const box = useRef<HTMLDivElement | null>(null);
  const [limit, setLimit] = useState(0);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = (): void => {
      const style = window.getComputedStyle(el);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.45;
      const max = Math.round(line * FOLDED_LINES);
      setLimit(max);
      // A line's worth of slack: a fourth line cut to a sliver is not worth an arrow.
      setTall(el.scrollHeight > max + line * 0.6);
    };
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const folded = tall && !open;
  return (
    <>
      <div ref={box} className={`cs-fold${folded ? ' folded' : ''}`} style={folded ? { maxHeight: limit } : undefined}>
        {children}
        {folded && (
          <div className="cs-fold-blur" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
      {tall && (
        <button type="button" className="cs-fold-toggle" aria-expanded={open} aria-label={t(open ? 'chat.foldClose' : 'chat.foldOpen')} title={t(open ? 'chat.foldClose' : 'chat.foldOpen')} onClick={() => setOpen(!open)}>
          {open ? '▴' : '▾'}
        </button>
      )}
    </>
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
      <div className="cs-cmd-row">
        <button type="button" className="cs-cmd-head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
          <span className="cs-cmd-ico" aria-hidden="true">{running ? '⟳' : step.failed ? '✗' : '✓'}</span>
          <code className="wb-row-name">{step.command}</code>
          <span className="muted small">{running ? t('chat.running') : step.exitCode !== undefined ? t('chat.exit', { code: step.exitCode }) : step.outcome}</span>
        </button>
        {/* The command and what it printed, as a terminal shows them. */}
        <CopyButton text={step.output ? `$ ${step.command}\n${step.output}` : step.command} what="chat.copyCommand" />
      </div>
      {shown && step.output && <pre className="cs-out">{step.output}</pre>}
    </div>
  );
}

/** A command waiting to be run, asked about where it was asked for. */
function Ask({ approval, onDecided }: { approval: Approval; onDecided: Decided }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const answer = async (action: 'run' | 'skip' | 'abort' | 'run-all') => {
    setBusy(true);
    let ok = false;
    try {
      await api.decide(approval.id, action);
      ok = true;
    } finally {
      setBusy(false);
      onDecided(approval.id, ok);
    }
  };
  // The plan is asked about here, in the conversation (plan mode, 2026-10-20); the model card stays at the top.
  if (approval.plan) return <div className="cs-plan-ask"><PlanCard approval={approval} onDecided={(ok) => onDecided(approval.id, ok)} /></div>;
  if (approval.question) return <QuestionCard approval={approval} onDecided={onDecided} />;
  if (approval.model) return <p className="cs-system small">{t('chat.lookAbove')}</p>;
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

/**
 * A message of a conversation with two chats (operator, 2026-10-20): the operator's assignment; then what the lead did,
 * reply by reply — how it understood the assignment, its notes, its plan, each subtask with the worker's commands under
 * it, its questions with their answers — and the result, which is the message's summary.
 */
function LeadTurn({ session, task, worker, approvals, onDecided, onOpenFile, onRewind }: { session: Session; task: Task; worker: Session | null; approvals: Approval[]; onDecided: Decided; onOpenFile: (path: string) => void; onRewind?: () => void }) {
  const { t } = useT();
  const live = task.status === 'running' || task.status === 'waiting-approval';
  const rounds = task.lead?.rounds ?? [];
  const lastPlanRound = rounds.filter((r) => r.status === 'plan').at(-1)?.n;
  const mine = approvals.filter((a) => a.taskId === task.id);
  const working = rounds.at(-1)?.subtask && worker?.tasks.find((x) => x.id === rounds.at(-1)?.subtask?.taskId && (x.status === 'running' || x.status === 'waiting-approval'));
  return (
    <section className="cs-turn cs-lead-turn" id={`cs-turn-${task.id}`} aria-label={t('chat.turn', { text: task.title })}>
      <div className="cs-user-row">
        {onRewind && (task.checkpoint || task.status === 'queued') && (
          <button type="button" className="wb-icon-btn cs-rewind" onClick={onRewind} title={t('chat.rewind')} aria-label={t('chat.rewind')}>
            ↶
          </button>
        )}
        <div className="cs-user">
          {task.skill && <SkillChip skill={task.skill} />}
          <Folded>
            <RichText text={task.prompt} />
          </Folded>
          <div className="cs-copy-row">
            <CopyButton text={task.prompt} what="chat.copyMessage" />
          </div>
        </div>
      </div>
      {task.status === 'queued' && <p className="muted small cs-system">{session.status === 'idle' ? t('chat.queued') : t('chat.waitingTurn')}</p>}
      {rounds.map((r) => (
        <Fragment key={r.n}>
          {r.understanding && <LeadSays who={t('lead.understood')} text={r.understanding} />}
          {r.notes && <LeadSays who={t('lead.who')} text={r.notes} />}
          {r.status === 'plan' && r.n === lastPlanRound && task.plan && !mine.some((a) => a.plan) && (
            <details className="cs-plan">
              <summary>{t('lead.plan', { v: task.plan.version })}</summary>
              <PlanView plan={task.plan} />
            </details>
          )}
          {r.subtask && <SubtaskTurn round={r} worker={worker} approvals={approvals.filter((a) => a.taskId === r.subtask?.taskId)} onDecided={onDecided} onOpenFile={onOpenFile} />}
          {r.question?.answer !== undefined && (
            <div className="cs-bot cs-lead-qa">
              <p className="cs-who">{t('lead.question')}</p>
              <RichText text={r.question.text} />
              <p className="cs-who">{t('lead.answered')}</p>
              <RichText text={r.question.answer} />
            </div>
          )}
        </Fragment>
      ))}
      {mine.map((a) => (
        <Ask key={a.id} approval={a} onDecided={onDecided} />
      ))}
      {live && (
        <p className="cs-working" role="status">
          <span className="wb-live" aria-hidden="true" /> {working ? t('lead.working', { n: rounds.at(-1)?.subtask?.n ?? 0 }) : t('lead.thinking')}
          {task.lead ? <span className="muted small"> · {t('lead.subtasks', { n: task.lead.subtasks, max: task.lead.maxSubtasks })}</span> : null}
        </p>
      )}
      {/* How many messages went to each chat, and in all (2026-10-21). */}
      {task.lead?.messages && (
        <p className="muted small cs-lead-count">
          {t('lead.messages', { lead: task.lead.messages.lead, worker: task.lead.messages.worker, total: task.lead.messages.lead + task.lead.messages.worker })}
        </p>
      )}
      {!live && task.status !== 'queued' && <Ending task={task} />}
      {!live && (task.lead?.evidence?.length ?? 0) > 0 && (
        <div className="cs-evidence">
          <p className="cs-who">{t('lead.evidence')}</p>
          <ul>
            {task.lead!.evidence!.map((e) => (
              <li key={e}>
                <RichText text={e} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {task.runId && (
        <div className="cs-exchange">
          <a className="button-link quiet small" href={api.taskExchangeUrl(session.id, task.id)} download title={t('chat.exchangeWhy')}>
            {t('chat.exchange')}
          </a>
        </div>
      )}
      {(task.vcs?.files?.length ?? 0) > 0 && !live && (
        <div className="cs-files">
          <span className="small">{t('chat.changed', { n: task.vcs!.files!.length })}</span>
          {task.vcs!.files!.slice(0, 12).map((f) => (
            <button key={f.path} type="button" className="cs-file" onClick={() => onOpenFile(f.path)} title={f.path}>
              <FileIcon path={f.path} /> {f.path.split('/').pop()} <span className="muted">{f.added >= 0 ? `+${f.added} −${f.removed}` : ''}</span>
            </button>
          ))}
          <ChangesButton sessionId={session.id} taskId={task.id} runId={task.runId} title={task.title} files={task.vcs!.files!.length} />
        </div>
      )}
    </section>
  );
}

/** The skill a message was sent with, above it: its name, and what it is for on hover. */
function SkillChip({ skill }: { skill: NonNullable<Task['skill']> }) {
  const { t } = useT();
  return (
    <p className="cs-skill-chip">
      <span className="badge skill" title={skill.description || undefined}>
        {t('chat.skillUsed', { name: skill.name })}
      </span>
    </p>
  );
}

/** What the lead says: its understanding of the assignment, or its notes. */
function LeadSays({ who, text }: { who: string; text: string }) {
  return (
    <div className="cs-bot cs-lead-say">
      <p className="cs-who">{who}</p>
      <RichText text={text} />
      <div className="cs-copy-row">
        <CopyButton text={text} what="chat.copyReply" />
      </div>
    </div>
  );
}

/** One subtask of the lead's, as the worker did it: folded once it ended, open while it runs. */
function SubtaskTurn({ round, worker, approvals, onDecided, onOpenFile }: { round: LeadRound; worker: Session | null; approvals: Approval[]; onDecided: Decided; onOpenFile: (path: string) => void }) {
  const { t } = useT();
  const sub = round.subtask!;
  const task = worker?.tasks.find((x) => x.id === sub.taskId);
  const live = task?.status === 'running' || task?.status === 'waiting-approval';
  const entries = useStoryEntries(worker?.id ?? '', task);
  return (
    <details className={`cs-subtask s-${task?.status ?? 'queued'}`} open={live || approvals.length > 0 || undefined}>
      <summary>
        <StatusMark status={task?.status ?? 'queued'} /> <span>{t('lead.subtask', { n: sub.n, title: sub.title })}</span>
        {sub.readOnly && <span className="badge">{t('lead.readOnly')}</span>}
        {sub.fresh && <span className="badge">{t('lead.fresh')}</span>}
      </summary>
      <div className="cs-subtask-body">
        <StoryLines entries={entries} />
        {approvals.map((a) => (
          <Ask key={a.id} approval={a} onDecided={onDecided} />
        ))}
        {task && !live && task.status !== 'queued' && <Ending task={task} />}
        {task && (task.vcs?.files?.length ?? 0) > 0 && !live && (
          <div className="cs-files">
            {task.vcs!.files!.slice(0, 8).map((f) => (
              <button key={f.path} type="button" className="cs-file" onClick={() => onOpenFile(f.path)} title={f.path}>
                <FileIcon path={f.path} /> {f.path.split('/').pop()}
              </button>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

/** The lead's question for the operator: the choices it offered, or an answer written out; or the task stopped. */
function QuestionCard({ approval, onDecided }: { approval: Approval; onDecided: Decided }) {
  const { t } = useT();
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const q = approval.question!;
  const answer = async (value: string) => {
    if (!value.trim()) return;
    setBusy(true);
    setErr('');
    let ok = false;
    try {
      await api.answerQuestion(approval.id, value);
      ok = true;
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      onDecided(approval.id, ok);
    }
  };
  const stop = async () => {
    if (!(await confirmDialog(t('lead.stopConfirm')))) return;
    setBusy(true);
    let ok = false;
    try {
      await api.decide(approval.id, 'abort');
      ok = true;
    } finally {
      setBusy(false);
      onDecided(approval.id, ok);
    }
  };
  return (
    <div className="cs-ask cs-question" role="group" aria-label={t('lead.question')}>
      <p className="small">
        <strong>{t('lead.question')}</strong>
      </p>
      <RichText text={q.text} />
      {q.why && <p className="muted small">{q.why}</p>}
      {q.options.length > 0 && (
        <div className="row cs-options">
          {q.options.map((o) => (
            <button key={o} type="button" disabled={busy} onClick={() => void answer(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <label htmlFor={`${id}-answer`} className="small">
        {t('lead.answer')}
      </label>
      <textarea id={`${id}-answer`} className="prose" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('lead.answerPlaceholder')} disabled={busy} />
      <div className="row">
        <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void answer(text)}>
          {t('lead.send')}
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void stop()}>
          {t('lead.stop')}
        </button>
      </div>
      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
