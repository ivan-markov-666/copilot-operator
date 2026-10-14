'use client';

/**
 * The workbench: the home screen, laid out as an IDE with a chat beside it (operator's request, 2026-10-14: "make it
 * look like VS Code with a chat bot at the side, like Windsurf — our own design, their way of showing what there
 * is"). Explorer of sessions and tasks (or the repository's files, or its commits) on the left; the open tabs in
 * the middle, with the terminal, the problems and the session's output below them; the chat of the task chosen on
 * the right, where the operator writes to it — a note while it works, a new prompt once it ended; a status bar at
 * the bottom; and a command palette on Ctrl+K. Every page there was before is one click away, and nothing here
 * replaces it: a task's every detail and setting is still on its session's page.
 *
 * What is chosen is kept in the address (`?s=&t=`), so a link or a reload opens the same task; the panels' sizes
 * and which are open are kept in this browser.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import { api, type Session, type Task } from '../../lib/api';
import { usePoll } from '../../lib/usePoll';
import { LanguageSwitcher, useT } from '../../lib/i18n';
import { Explorer } from './explorer';
import { TaskView } from './taskView';
import { SessionView } from './sessionView';
import { FileView } from './fileView';
import { ChatPanel } from './chatPanel';
import { BottomPanel } from './bottomPanel';
import { StatusBar } from './statusBar';
import { Palette, type PaletteCommand } from './palette';

export type Tab = { kind: 'task'; sessionId: string; taskId: string } | { kind: 'session'; sessionId: string } | { kind: 'file'; sessionId: string; path: string; taskId?: string };
export type SideView = 'tasks' | 'files' | 'commits';
export type BottomTab = 'terminal' | 'problems' | 'output';
export type ChatTab = 'chat' | 'kerrigan';

const tabKey = (t: Tab): string => (t.kind === 'task' ? `t:${t.taskId}` : t.kind === 'session' ? `s:${t.sessionId}` : `f:${t.sessionId}:${t.path}`);

/** Kept in this browser: which panels are open and how big they are. Read with care: storage may be refused. */
type Layout = { side: number; chat: number; bottom: number; sideOpen: boolean; chatOpen: boolean; bottomOpen: boolean };
const DEFAULT_LAYOUT: Layout = { side: 290, chat: 420, bottom: 240, sideOpen: true, chatOpen: true, bottomOpen: true };
const LAYOUT_KEY = 'cop.workbench.layout';
function readLayout(): Layout {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    return raw ? { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<Layout>) } : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function Workbench() {
  return (
    <Suspense fallback={null}>
      <WorkbenchInner />
    </Suspense>
  );
}

function WorkbenchInner() {
  const { t } = useT();
  const [sessions, setSessions] = useState<Array<Session & { running?: boolean }> | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [sel, setSel] = useState<{ sessionId?: string; taskId?: string }>({});
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>('');
  const [side, setSide] = useState<SideView>('tasks');
  const [bottomTab, setBottomTab] = useState<BottomTab>('terminal');
  const [chatTab, setChatTab] = useState<ChatTab>('chat');
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [palette, setPalette] = useState(false);
  /** Asks the chat composer for the keyboard, with what its button will do. */
  const [composeAsk, setComposeAsk] = useState(0);
  const restored = useRef(false);

  const load = useCallback(
    () =>
      api
        .sessions()
        .then((s) => {
          setSessions(s);
          setLoadErr('');
        })
        .catch((e: unknown) => setLoadErr((e as Error).message)),
    [],
  );
  usePoll(load, 3000);

  // Layout and selection, read once in the browser.
  useEffect(() => {
    setLayout(readLayout());
    const q = new URLSearchParams(window.location.search);
    const s = q.get('s') ?? undefined;
    const tk = q.get('t') ?? undefined;
    if (s) setSel({ sessionId: s, taskId: tk });
    restored.current = true;
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* a browser that keeps nothing still works, at the default sizes */
    }
  }, [layout]);
  // The chosen task in the address, so a reload or a link opens it.
  useEffect(() => {
    if (!restored.current) return;
    const q = new URLSearchParams();
    if (sel.sessionId) q.set('s', sel.sessionId);
    if (sel.taskId) q.set('t', sel.taskId);
    const next = q.toString() ? `/?${q.toString()}` : '/';
    if (`${window.location.pathname}${window.location.search}` !== next) window.history.replaceState(null, '', next);
  }, [sel]);

  const open = useCallback((tab: Tab) => {
    setTabs((all) => (all.some((x) => tabKey(x) === tabKey(tab)) ? all : [...all, tab]));
    setActive(tabKey(tab));
    if (tab.kind === 'task') setSel({ sessionId: tab.sessionId, taskId: tab.taskId });
    else setSel((s) => ({ sessionId: tab.sessionId, taskId: s.sessionId === tab.sessionId ? s.taskId : undefined }));
  }, []);
  const close = (key: string) => {
    setTabs((all) => {
      const i = all.findIndex((x) => tabKey(x) === key);
      const rest = all.filter((x) => tabKey(x) !== key);
      if (key === active) setActive(rest[Math.max(0, i - 1)] ? tabKey(rest[Math.max(0, i - 1)]!) : '');
      return rest;
    });
  };

  // The task chosen in the address opens its tab once the sessions are read.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !sessions || !sel.sessionId) return;
    const s = sessions.find((x) => x.id === sel.sessionId);
    if (!s) return;
    opened.current = true;
    if (sel.taskId && s.tasks.some((x) => x.id === sel.taskId)) open({ kind: 'task', sessionId: s.id, taskId: sel.taskId });
    else open({ kind: 'session', sessionId: s.id });
  }, [sessions, sel, open]);

  const session = sessions?.find((s) => s.id === sel.sessionId);
  const task: Task | undefined = session?.tasks.find((x) => x.id === sel.taskId);
  const activeTab = tabs.find((x) => tabKey(x) === active);

  const setL = (patch: Partial<Layout>) => setLayout((l) => ({ ...l, ...patch }));

  // Keys an IDE has: the palette, the side bar, the panel, the chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'k' || (k === 'p' && e.shiftKey)) {
        e.preventDefault();
        setPalette(true);
      } else if (k === 'b' && !e.shiftKey) {
        e.preventDefault();
        setL({ sideOpen: !layout.sideOpen });
      } else if (k === 'j') {
        e.preventDefault();
        setL({ bottomOpen: !layout.bottomOpen });
      } else if (k === 'l') {
        e.preventDefault();
        setL({ chatOpen: true });
        setChatTab('chat');
        setComposeAsk((n) => n + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layout]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [
      { id: 'kerrigan', label: t('wb.cmdKerrigan'), run: () => { setL({ chatOpen: true }); setChatTab('kerrigan'); } },
      { id: 'chat', label: t('wb.cmdChat'), hint: 'Ctrl+L', run: () => { setL({ chatOpen: true }); setChatTab('chat'); setComposeAsk((n) => n + 1); } },
      { id: 'side', label: t('wb.cmdSide'), hint: 'Ctrl+B', run: () => setL({ sideOpen: !layout.sideOpen }) },
      { id: 'panel', label: t('wb.cmdPanel'), hint: 'Ctrl+J', run: () => setL({ bottomOpen: !layout.bottomOpen }) },
      { id: 'files', label: t('wb.cmdFiles'), run: () => { setL({ sideOpen: true }); setSide('files'); } },
      { id: 'commits', label: t('wb.cmdCommits'), run: () => { setL({ sideOpen: true }); setSide('commits'); } },
      { id: 'problems', label: t('wb.cmdProblems'), run: () => { setL({ bottomOpen: true }); setBottomTab('problems'); } },
      ...[
        ['/sessions', 'nav.sessions'],
        ['/history', 'nav.history'],
        ['/import', 'nav.import'],
        ['/defaults', 'nav.defaults'],
        ['/level1', 'nav.level1'],
        ['/presets', 'nav.presets'],
        ['/appearance', 'nav.appearance'],
        ['/system', 'nav.system'],
      ].map(([href, key]) => ({ id: `go:${href}`, label: t('wb.cmdGo', { page: t(key as 'nav.sessions') }), href })),
    ];
    for (const s of sessions ?? []) {
      list.push({ id: `s:${s.id}`, label: t('wb.cmdSession', { name: s.name }), run: () => open({ kind: 'session', sessionId: s.id }) });
      s.tasks.forEach((x, i) => list.push({ id: `t:${x.id}`, label: `${s.name} › ${i + 1}. ${x.title}`, hint: t(`status.${x.status}` as 'status.done'), run: () => open({ kind: 'task', sessionId: s.id, taskId: x.id }) }));
    }
    return list;
  }, [sessions, t, layout, open]);

  const style = {
    '--wb-side': layout.sideOpen ? `${layout.side}px` : '0px',
    '--wb-chat': layout.chatOpen ? `${layout.chat}px` : '0px',
    '--wb-bottom': layout.bottomOpen ? `${layout.bottom}px` : '34px',
  } as CSSProperties;

  return (
    <div className="wb" style={style}>
      <header className="wb-top">
        <span className="wb-brand">copilot-operator</span>
        <button type="button" className="wb-search" onClick={() => setPalette(true)} title={t('wb.paletteWhy')}>
          <span>{t('wb.palette')}</span>
          <kbd>Ctrl+K</kbd>
        </button>
        <nav className="wb-menu" aria-label={t('nav.label')}>
          <Link href="/sessions">{t('nav.sessions')}</Link>
          <Link href="/history">{t('nav.history')}</Link>
          <Link href="/import">{t('nav.import')}</Link>
          <Link href="/defaults">{t('nav.defaults')}</Link>
          <LanguageSwitcher />
        </nav>
      </header>

      <div className={`wb-body${layout.sideOpen ? '' : ' no-side'}${layout.chatOpen ? '' : ' no-chat'}`}>
        <ActivityBar side={side} sideOpen={layout.sideOpen} onSide={(v) => { if (v === side && layout.sideOpen) setL({ sideOpen: false }); else { setSide(v); setL({ sideOpen: true }); } }} chatOpen={layout.chatOpen} onChat={() => setL({ chatOpen: !layout.chatOpen })} />

        <aside className="wb-side" aria-label={t('wb.explorer')} hidden={!layout.sideOpen}>
          {loadErr && !sessions ? <p className="err small" style={{ padding: 10 }}>{loadErr}</p> : null}
          <Explorer view={side} sessions={sessions} selected={sel} onOpen={open} onChange={() => void load()} />
        </aside>
        {layout.sideOpen && <Splitter axis="x" label={t('wb.resize')} onDrag={(d) => setL({ side: clamp(layout.side + d, 180, 560) })} />}

        <section className="wb-center" aria-label={t('wb.editor')}>
          <div className="wb-tabs" role="tablist" aria-label={t('wb.openTabs')}>
            {tabs.length === 0 && <span className="muted small wb-tabs-empty">{t('wb.noTabs')}</span>}
            {tabs.map((tab) => {
              const key = tabKey(tab);
              const s = sessions?.find((x) => x.id === tab.sessionId);
              const tk = tab.kind === 'task' ? s?.tasks.find((x) => x.id === tab.taskId) : undefined;
              const label = tab.kind === 'task' ? (tk?.title ?? t('wb.goneTask')) : tab.kind === 'session' ? (s?.name ?? t('wb.goneSession')) : tab.path.split('/').pop();
              return (
                <div key={key} className={`wb-tab${key === active ? ' active' : ''}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={key === active}
                    onClick={() => (tab.kind === 'task' ? open(tab) : (setActive(key), setSel({ sessionId: tab.sessionId, taskId: tab.kind === 'file' ? tab.taskId : undefined })))}
                    title={tab.kind === 'file' ? tab.path : undefined}
                  >
                    {tk && <StatusMark status={tk.status} />}
                    {tab.kind === 'file' && <span className="wb-ico" aria-hidden="true">≡</span>}
                    {tab.kind === 'session' && <span className="wb-ico" aria-hidden="true">▤</span>}
                    <span className="wb-tab-label">{label}</span>
                  </button>
                  <button type="button" className="wb-tab-close" aria-label={t('wb.closeTab', { name: label ?? '' })} onClick={() => close(key)}>
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <div className="wb-editor" role="tabpanel">
            {!activeTab ? (
              <Welcome sessions={sessions} onOpen={open} onKerrigan={() => { setL({ chatOpen: true }); setChatTab('kerrigan'); }} />
            ) : activeTab.kind === 'task' ? (
              session && task ? (
                <TaskView
                  session={session}
                  task={task}
                  onChange={() => void load()}
                  onCompose={() => { setL({ chatOpen: true }); setChatTab('chat'); setComposeAsk((n) => n + 1); }}
                  onKerrigan={() => { setL({ chatOpen: true }); setChatTab('kerrigan'); }}
                  onOpenFile={(path) => open({ kind: 'file', sessionId: session.id, path, taskId: task.id })}
                />
              ) : (
                <p className="muted">{t('wb.goneTask')}</p>
              )
            ) : activeTab.kind === 'session' ? (
              (() => {
                const s = sessions?.find((x) => x.id === activeTab.sessionId);
                return s ? <SessionView session={s} onOpen={open} onChange={() => void load()} /> : <p className="muted">{t('wb.goneSession')}</p>;
              })()
            ) : (
              <FileView sessionId={activeTab.sessionId} path={activeTab.path} taskId={activeTab.taskId} />
            )}
          </div>
          {layout.bottomOpen && <Splitter axis="y" label={t('wb.resize')} onDrag={(d) => setL({ bottom: clamp(layout.bottom - d, 90, 700) })} />}
          <BottomPanel
            open={layout.bottomOpen}
            onToggle={() => setL({ bottomOpen: !layout.bottomOpen })}
            tab={bottomTab}
            onTab={(b) => { setBottomTab(b); setL({ bottomOpen: true }); }}
            session={session}
            task={task}
            onOpenTask={(sessionId, taskId) => open({ kind: 'task', sessionId, taskId })}
          />
        </section>

        {layout.chatOpen && <Splitter axis="x" label={t('wb.resize')} onDrag={(d) => setL({ chat: clamp(layout.chat - d, 300, 820) })} />}
        <aside className="wb-chat" aria-label={t('wb.chatPanel')} hidden={!layout.chatOpen}>
          <ChatPanel tab={chatTab} onTab={setChatTab} session={session} task={task} sessions={sessions ?? []} composeAsk={composeAsk} onChange={() => void load()} onClose={() => setL({ chatOpen: false })} />
        </aside>
      </div>

      <StatusBar sessions={sessions ?? []} session={session} task={task} onOpenTask={(sessionId, taskId) => open({ kind: 'task', sessionId, taskId })} />
      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
    </div>
  );
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** The column of icons on the far left: the explorer's three views, and the chat beside the work. */
function ActivityBar({ side, sideOpen, onSide, chatOpen, onChat }: { side: SideView; sideOpen: boolean; onSide: (v: SideView) => void; chatOpen: boolean; onChat: () => void }) {
  const { t } = useT();
  const item = (v: SideView, label: string, icon: ReactNode) => (
    <button type="button" className={`wb-act${sideOpen && side === v ? ' on' : ''}`} aria-pressed={sideOpen && side === v} aria-label={label} title={label} onClick={() => onSide(v)}>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {icon}
      </svg>
    </button>
  );
  return (
    <nav className="wb-activity" aria-label={t('wb.views')}>
      {item('tasks', t('wb.viewTasks'), <path d="M4 6h16M4 12h16M4 18h10" />)}
      {item('files', t('wb.viewFiles'), <path d="M4 4h6l2 2h8v14H4z" />)}
      {item('commits', t('wb.viewCommits'), <><circle cx="12" cy="12" r="3" /><path d="M12 3v6M12 15v6" /></>)}
      <span className="grow" />
      <button type="button" className={`wb-act${chatOpen ? ' on' : ''}`} aria-pressed={chatOpen} aria-label={t('wb.toggleChat')} title={`${t('wb.toggleChat')} (Ctrl+L)`} onClick={onChat}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 5h16v11H9l-5 4z" />
        </svg>
      </button>
      <Link className="wb-act" href="/defaults" aria-label={t('nav.defaults')} title={t('nav.defaults')}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" />
        </svg>
      </Link>
    </nav>
  );
}

/** A bar between two panels, dragged to resize them; arrow keys move it too. */
function Splitter({ axis, label, onDrag }: { axis: 'x' | 'y'; label: string; onDrag: (delta: number) => void }) {
  const last = useRef<number | null>(null);
  return (
    <div
      className={`wb-split ${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      tabIndex={0}
      onPointerDown={(e) => {
        last.current = axis === 'x' ? e.clientX : e.clientY;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        const now = axis === 'x' ? e.clientX : e.clientY;
        onDrag(now - last.current);
        last.current = now;
      }}
      onPointerUp={() => (last.current = null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 12;
        if ((axis === 'x' && e.key === 'ArrowLeft') || (axis === 'y' && e.key === 'ArrowUp')) onDrag(-step);
        if ((axis === 'x' && e.key === 'ArrowRight') || (axis === 'y' && e.key === 'ArrowDown')) onDrag(step);
      }}
    />
  );
}

/** A task's state as a mark the eye can scan down a list; the word is beside it for anyone who cannot see the mark. */
export function StatusMark({ status }: { status: Task['status'] }) {
  const { t } = useT();
  const mark: Record<string, string> = { done: '✓', failed: '✗', blocked: '⊘', 'limit-reached': '⏸', aborted: '■', queued: '○', running: '●', 'waiting-approval': '◐' };
  return (
    <span className={`wb-status s-${status}`} title={t(`status.${status}` as 'status.done')} aria-label={t(`status.${status}` as 'status.done')} role="img">
      {mark[status] ?? '·'}
    </span>
  );
}

/** What the editor shows with nothing open: where to begin. */
function Welcome({ sessions, onOpen, onKerrigan }: { sessions: Session[] | null; onOpen: (t: Tab) => void; onKerrigan: () => void }) {
  const { t } = useT();
  const needing = (sessions ?? []).flatMap((s) => s.tasks.filter((x) => ['failed', 'blocked', 'limit-reached', 'aborted', 'waiting-approval'].includes(x.status)).map((x) => ({ s, x })));
  const queued = (sessions ?? []).reduce((n, s) => n + s.tasks.filter((x) => x.status === 'queued').length, 0);
  return (
    <div className="wb-welcome">
      <h2>{t('wb.welcome')}</h2>
      <p className="muted">{t('wb.welcomeWhy')}</p>
      <div className="row">
        <Link className="button-link primary" href="/import">{t('wb.startPlan')}</Link>
        <Link className="button-link" href="/sessions#new-session">{t('wb.newSession')}</Link>
        <button type="button" onClick={onKerrigan}>{t('wb.askKerrigan')}</button>
      </div>
      {needing.length > 0 && (
        <>
          <h3>{t('wb.needsYou', { n: needing.length })}</h3>
          <ul className="wb-list">
            {needing.slice(0, 12).map(({ s, x }) => (
              <li key={x.id}>
                <button type="button" className="linkish" onClick={() => onOpen({ kind: 'task', sessionId: s.id, taskId: x.id })}>
                  <StatusMark status={x.status} /> {s.name} › {x.title}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {queued > 0 && <p className="small">{t('wb.queuedCount', { n: queued })}</p>}
      <p className="muted small">{t('wb.keys')}</p>
    </div>
  );
}
