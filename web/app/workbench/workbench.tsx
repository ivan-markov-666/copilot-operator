'use client';

/**
 * The workbench: the home screen, laid out as an IDE with a chat beside it (operator's request, 2026-10-14: "make it
 * look like VS Code with a chat bot at the side, like Windsurf"). The open project folder's files, or its git, on the
 * left; the open files and diffs in the middle, with the terminal, the problems and the output of the chat's
 * conversation below them; the chat on the right; a status bar at the bottom; and a command palette on Ctrl+K.
 *
 * Only the chat and Kerrigan are left (2026-10-20: "remove Sessions, the task register and the plan from JSON — not
 * only from the UI, we do not need them; we keep the chat, and Kerrigan, who helps with using it"). The panels'
 * sizes and which are open are kept in this browser.
 */
import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { api, type GitArea, type Session, type Task, type Workspace } from '../../lib/api';
import { usePoll } from '../../lib/usePoll';
import { useT } from '../../lib/i18n';
import { LanguageSwitcher } from '../languageMenu';
import { Explorer } from './explorer';
import { FileView } from './fileView';
import { GitDiff } from './gitDiff';
import { ChatPanel } from './chatPanel';
import type { ChatTurn } from './cascade';
import { BottomPanel } from './bottomPanel';
import { StatusBar } from './statusBar';
import { Palette, type PaletteCommand } from './palette';
import { AppearanceMenu } from './appearanceMenu';
import { KerriganAbout, KerriganButton } from './kerriganButton';
import { FileIcon } from './fileIcon';
import { QuickOpen } from './quickOpen';
import { SearchView, type SearchHit } from './searchView';
import type { GoTo } from './fileView';
import { AREA_DRAG, DEFAULT_ORDER, movedTo, orderOf, PanelGrip, type Area } from './panelGrip';
import { confirmDialog } from '../dialog';

export type Tab =
  | { kind: 'file'; path: string }
  /** A file of the open folder's git, its two versions side by side (see gitDiff.tsx). */
  | { kind: 'diff'; area: GitArea; path: string; commit?: string };
export type SideView = 'files' | 'search' | 'commits';
export type BottomTab = 'terminal' | 'problems' | 'output';

const tabKey = (t: Tab): string => (t.kind === 'diff' ? `d:${t.area}:${t.commit ?? ''}:${t.path}` : `f:${t.path}`);

/** Kept in this browser: which panels are open and how big they are. Read with care: storage may be refused. */
/**
 * `side` and `chat` are the widths of the left place and the right one — whichever panel is in them since the panels
 * can be moved (2026-10-21, see `panelGrip.tsx`); `order` is which panel is in which place.
 */
type Layout = { side: number; chat: number; bottom: number; sideOpen: boolean; chatOpen: boolean; bottomOpen: boolean; order: Area[] };
const DEFAULT_LAYOUT: Layout = { side: 290, chat: 420, bottom: 240, sideOpen: true, chatOpen: true, bottomOpen: true, order: DEFAULT_ORDER };
const LAYOUT_KEY = 'cop.workbench.layout';
function readLayout(): Layout {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const kept = { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<Layout>) };
    return { ...kept, order: orderOf(kept.order) };
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
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>('');
  const [side, setSide] = useState<SideView>('files');
  const [problem, setProblem] = useState('');
  /** The open project folder: what the chat works on and the Files view shows. */
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  /** The chat's latest message, which the panel under the editor follows; 'new' on a new chat. */
  const [chatTurn, setChatTurn] = useState<ChatTurn>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>('terminal');
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [palette, setPalette] = useState(false);
  /** Asks the chat composer for the keyboard. */
  const [composeAsk, setComposeAsk] = useState(0);
  /** Asks the chat to show a conversation: the one running, from the status bar. */
  const [showThread, setShowThread] = useState<{ id: string; n: number } | null>(null);
  /** The files open in the editor with edits not saved yet: marked on their tab, and asked about on closing. */
  const [unsaved, setUnsaved] = useState<Set<string>>(new Set());
  const onDirty = useCallback((path: string, dirty: boolean) => {
    setUnsaved((u) => {
      if (u.has(path) === dirty) return u;
      const n = new Set(u);
      if (dirty) n.add(path);
      else n.delete(path);
      return n;
    });
  }, []);

  // Only the chat's conversations: sessions of any other kind, made before 2026-10-20, are not shown anywhere.
  const load = useCallback(
    () =>
      api
        .sessions()
        .then((s) => setSessions(s.filter((x) => x.kind === 'chat')))
        .catch(() => undefined),
    [],
  );
  usePoll(load, 3000);
  const readWorkspace = useCallback(() => api.workspace().then(setWorkspace).catch(() => undefined), []);
  usePoll(readWorkspace, 10_000);
  /** "Open a folder": the machine's folder dialog, and the folder kept as the project in Settings. */
  const openFolder = useCallback(async () => {
    try {
      const pick = await api.browseFolder(workspace?.dir || undefined);
      if (!pick.ok) return;
      const st = await api.settings();
      await api.saveSettings({ ...st.raw, project: { ...((st.raw.project as Record<string, unknown> | undefined) ?? {}), rootDir: pick.path } });
      await readWorkspace();
    } catch (e) {
      setProblem((e as Error).message);
    }
  }, [workspace?.dir, readWorkspace]);

  useEffect(() => setLayout(readLayout()), []);
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* a browser that keeps nothing still works, at the default sizes */
    }
  }, [layout]);

  const open = useCallback((tab: Tab) => {
    setTabs((all) => (all.some((x) => tabKey(x) === tabKey(tab)) ? all : [...all, tab]));
    setActive(tabKey(tab));
  }, []);
  /** Go to File (Ctrl+P) open, the line a file was opened at, and the Search view's box asked to take the keys. */
  const [quickOpen, setQuickOpen] = useState(false);
  const [goTo, setGoTo] = useState<(GoTo & { path: string }) | null>(null);
  const [searchAsk, setSearchAsk] = useState(0);
  const openAt = useCallback(
    (hit: SearchHit) => {
      open({ kind: 'file', path: hit.path });
      setGoTo((g) => ({ path: hit.path, line: hit.line, from: hit.from, to: hit.to, n: (g?.n ?? 0) + 1 }));
    },
    [open],
  );
  const toSearch = (): void => {
    setSide('search');
    setL({ sideOpen: true });
    setSearchAsk((n) => n + 1);
  };
  const close = async (key: string) => {
    const tab = tabs.find((x) => tabKey(x) === key);
    if (tab?.kind === 'file' && unsaved.has(tab.path)) {
      if (!(await confirmDialog(t('ed.closeUnsaved', { name: tab.path.split('/').pop() ?? tab.path })))) return;
      onDirty(tab.path, false);
    }
    setTabs((all) => {
      const i = all.findIndex((x) => tabKey(x) === key);
      const rest = all.filter((x) => tabKey(x) !== key);
      if (key === active) setActive(rest[Math.max(0, i - 1)] ? tabKey(rest[Math.max(0, i - 1)]!) : '');
      return rest;
    });
  };

  const activeTab = tabs.find((x) => tabKey(x) === active);
  // The panel follows the chat: its conversation's latest message; on a new chat, nothing yet (2026-10-19).
  const chatSession = chatTurn && chatTurn !== 'new' ? sessions?.find((x) => x.id === chatTurn.sessionId) : undefined;
  const chatTask = chatTurn && chatTurn !== 'new' ? chatSession?.tasks.find((x) => x.id === chatTurn.taskId) : undefined;

  const setL = (patch: Partial<Layout>) => setLayout((l) => ({ ...l, ...patch }));
  const toChat = () => {
    setL({ chatOpen: true });
    setComposeAsk((n) => n + 1);
  };
  /** A message of the conversation open in the chat, brought into view: from the problems. */
  const showMessage = (taskId: string) => {
    setL({ chatOpen: true });
    window.setTimeout(() => document.getElementById(`cs-turn-${taskId}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
  };

  // Keys an IDE has: the palette, the side bar, the panel, the chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'k' || (k === 'p' && e.shiftKey)) {
        e.preventDefault();
        setPalette(true);
      } else if (k === 'p') {
        // Go to File, as in VS Code (2026-10-21).
        e.preventDefault();
        setQuickOpen(true);
      } else if (k === 'f' && e.shiftKey) {
        e.preventDefault();
        toSearch();
      } else if (k === 'e' && e.shiftKey) {
        e.preventDefault();
        setSide('files');
        setL({ sideOpen: true });
      } else if (k === 'b' && !e.shiftKey) {
        e.preventDefault();
        setL({ sideOpen: !layout.sideOpen });
      } else if (k === 'j') {
        e.preventDefault();
        setL({ bottomOpen: !layout.bottomOpen });
      } else if (k === 'l') {
        e.preventDefault();
        toChat();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layout]);

  const commands = useMemo<PaletteCommand[]>(
    () => [
      { id: 'chat', label: t('wb.cmdChat'), hint: 'Ctrl+L', run: toChat },
      { id: 'side', label: t('wb.cmdSide'), hint: 'Ctrl+B', run: () => setL({ sideOpen: !layout.sideOpen }) },
      { id: 'panel', label: t('wb.cmdPanel'), hint: 'Ctrl+J', run: () => setL({ bottomOpen: !layout.bottomOpen }) },
      { id: 'quick-open', label: t('wb.cmdQuickOpen'), hint: 'Ctrl+P', run: () => setQuickOpen(true) },
      { id: 'search', label: t('wb.cmdSearch'), hint: 'Ctrl+Shift+F', run: toSearch },
      { id: 'layout', label: t('wb.cmdResetLayout'), run: () => setL({ order: DEFAULT_ORDER, side: DEFAULT_LAYOUT.side, chat: DEFAULT_LAYOUT.chat }) },
      { id: 'files', label: t('wb.cmdFiles'), run: () => { setL({ sideOpen: true }); setSide('files'); } },
      { id: 'commits', label: t('wb.cmdCommits'), run: () => { setL({ sideOpen: true }); setSide('commits'); } },
      { id: 'problems', label: t('wb.cmdProblems'), run: () => { setL({ bottomOpen: true }); setBottomTab('problems'); } },
      ...(
        [
          ['/settings', 'nav.defaults'],
          ['/system', 'nav.system'],
        ] as const
      ).map(([href, key]) => ({ id: `go:${href}`, label: t('wb.cmdGo', { page: t(key) }), href })),
      ...(sessions ?? []).map((s) => ({ id: `c:${s.id}`, label: t('wb.cmdThread', { name: s.name.replace(/^chat: /, '') }), run: () => { setL({ chatOpen: true }); setShowThread((v) => ({ id: s.id, n: (v?.n ?? 0) + 1 })); } })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, t, layout],
  );

  // A panel's grip being dragged, and the panel it is over (2026-10-21, see `panelGrip.tsx`).
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState<Area | null>(null);
  /*
   * The three places (2026-10-21): the panels shown, in their order, a splitter between two; the middle place takes
   * what is left, and when the panel there is hidden, the last one shown does.
   */
  const placeOf = (a: Area): number => layout.order.indexOf(a);
  const isShown = (a: Area): boolean => (a === 'side' ? layout.sideOpen : a === 'chat' ? layout.chatOpen : true);
  const shown = layout.order.filter(isShown);
  const widths = shown.map((a) => (placeOf(a) === 1 ? 'minmax(0, 1fr)' : `${placeOf(a) === 0 ? layout.side : layout.chat}px`));
  if (widths.length > 0 && !widths.includes('minmax(0, 1fr)')) widths[widths.length - 1] = 'minmax(0, 1fr)';
  const columns = ['46px', ...widths.flatMap((w, i) => (i === 0 ? [w] : ['5px', w]))].join(' ');
  /** The splitter between two panels shown: it resizes the place at the side, not the middle one. */
  const resize = (left: Area, right: Area) => (d: number) => {
    if (placeOf(left) === 0) setL({ side: clamp(layout.side + d, 180, 820) });
    else if (placeOf(right) === 2) setL({ chat: clamp(layout.chat - d, 260, 820) });
  };
  const moveTo = (a: Area, to: number) => setL({ order: movedTo(layout.order, a, to) });
  const grip = (a: Area, name: string): ReactNode => <PanelGrip area={a} name={name} place={placeOf(a)} onMove={(to) => moveTo(a, to)} onDragging={setDragging} />;
  /** A panel takes another's place when that one's grip is let go of over it. */
  const dropOn = (a: Area) => ({
    'data-area': a,
    'data-drop': t('wb.dropHere'),
    onDragOver: (e: ReactDragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(AREA_DRAG)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (over !== a) setOver(a);
    },
    onDragLeave: (e: ReactDragEvent<HTMLElement>) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setOver((o) => (o === a ? null : o));
    },
    onDrop: (e: ReactDragEvent<HTMLElement>) => {
      const from = e.dataTransfer.getData(AREA_DRAG) as Area;
      e.preventDefault();
      setOver(null);
      setDragging(false);
      if (from && from !== a && layout.order.includes(from)) moveTo(from, placeOf(a));
    },
  });
  const dropClass = (a: Area): string => `${dragging ? ' wb-drop' : ''}${over === a ? ' wb-drop-over' : ''}`;

  const style = {
    '--wb-columns': columns,
    '--wb-side': layout.sideOpen ? `${layout.side}px` : '0px',
    '--wb-chat': layout.chatOpen ? `${layout.chat}px` : '0px',
    '--wb-bottom': layout.bottomOpen ? `${layout.bottom}px` : '34px',
  } as CSSProperties;

  /** The three panels, by name; the body puts them in the places `layout.order` says. */
  const panels: Record<Area, ReactNode> = {
    side: (
      <aside key="side" className={`wb-side${dropClass('side')}`} aria-label={t('wb.explorer')} hidden={!layout.sideOpen} {...dropOn('side')}>
        {/* The Search view stays as it was left while the files are shown, as VS Code keeps it; the panel's one grip
            goes to the view that is shown. */}
        <div className="wb-side-view" hidden={side !== 'search'}>
          <SearchView onOpen={openAt} grip={side === 'search' ? grip('side', t('wb.explorer')) : undefined} focusAsk={searchAsk} />
        </div>
        {side !== 'search' && <Explorer view={side} onOpen={open} workspace={workspace} onOpenFolder={() => void openFolder()} grip={grip('side', t('wb.explorer'))} />}
      </aside>
    ),
    center: (
      <section key="center" className={`wb-center${dropClass('center')}`} aria-label={t('wb.editor')} {...dropOn('center')}>
          <div className="wb-tabs" role="tablist" aria-label={t('wb.openTabs')}>
            {grip('center', t('wb.editor'))}
            {tabs.length === 0 && <span className="muted small wb-tabs-empty">{t('wb.noTabs')}</span>}
            {tabs.map((tab) => {
              const key = tabKey(tab);
              const label =
                tab.kind === 'diff'
                  ? `${tab.path.split('/').pop()} (${tab.area === 'commit' ? (tab.commit ?? '').slice(0, 7) : tab.area === 'branch' ? `⎇ ${tab.commit ?? ''}` : t(tab.area === 'staged' ? 'git.index' : 'git.workingTree')})`
                  : (tab.path.split('/').pop() ?? tab.path);
              return (
                <div key={key} className={`wb-tab${key === active ? ' active' : ''}`}>
                  <button type="button" role="tab" aria-selected={key === active} onClick={() => setActive(key)} title={tab.path}>
                    {tab.kind === 'diff' ? <span className="wb-ico" aria-hidden="true">±</span> : <FileIcon path={tab.path} />}
                    <span className="wb-tab-label">{label}</span>
                    {tab.kind === 'file' && unsaved.has(tab.path) && (
                      <span className="wb-unsaved" title={t('ed.unsaved')} aria-label={t('ed.unsaved')}>●</span>
                    )}
                  </button>
                  <button type="button" className="wb-tab-close" aria-label={t('wb.closeTab', { name: label })} onClick={() => void close(key)}>
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <div className="wb-editor" role="tabpanel">
            {!activeTab ? (
              <Welcome workspace={workspace} problem={problem} />
            ) : activeTab.kind === 'diff' ? (
              <GitDiff key={tabKey(activeTab)} area={activeTab.area} path={activeTab.path} commit={activeTab.commit} />
            ) : null}
            {/* Every open file stays loaded, hidden when its tab is not in front: an edit not saved yet survives a change of tab. */}
            {tabs.map((tab) =>
              tab.kind === 'file' ? (
                <div key={tabKey(tab)} className="wb-file-pane" hidden={tabKey(tab) !== active}>
                  <FileView path={tab.path} onDirty={onDirty} goTo={goTo?.path === tab.path ? goTo : undefined} onOpenFile={(p) => open({ kind: 'file', path: p })} />
                </div>
              ) : null,
            )}
          </div>
          {layout.bottomOpen && <Splitter axis="y" label={t('wb.resize')} onDrag={(d) => setL({ bottom: clamp(layout.bottom - d, 90, 700) })} />}
          <BottomPanel
            open={layout.bottomOpen}
            onToggle={() => setL({ bottomOpen: !layout.bottomOpen })}
            tab={bottomTab}
            onTab={(b) => { setBottomTab(b); setL({ bottomOpen: true }); }}
            session={chatSession}
            task={chatTask}
            newChat={chatTurn === 'new'}
            onShowMessage={showMessage}
          />
        </section>

      ),
    chat: (
      <aside key="chat" className={`wb-chat${dropClass('chat')}`} aria-label={t('wb.chatPanel')} hidden={!layout.chatOpen} {...dropOn('chat')}>
          <ChatPanel
            workspace={workspace}
            composeAsk={composeAsk}
            showThread={showThread}
            onOpenFile={(path) => open({ kind: 'file', path })}
            onOpenFolder={() => void openFolder()}
            onTurn={setChatTurn}
            onChange={() => void load()}
            onClose={() => setL({ chatOpen: false })}
            grip={grip('chat', t('wb.chatPanel'))}
          />
        </aside>
    ),
  };

  return (
    <div className="wb" style={style}>
      <header className="wb-top">
        <span className="wb-brand">copilot-operator</span>
        <button type="button" className="wb-search" onClick={() => setPalette(true)} title={t('wb.paletteWhy')}>
          <span>{t('wb.palette')}</span>
          <kbd>Ctrl+K</kbd>
        </button>
        <nav className="wb-menu" aria-label={t('nav.label')}>
          <Link href="/settings">{t('nav.defaults')}</Link>
          {/* System on the chat's screen too (operator, 2026-10-20), as it is on every other page. */}
          <Link href="/system">{t('nav.system')}</Link>
          {/* How the page looks, after System and before the language (operator, 2026-10-22: the two swapped). */}
          <AppearanceMenu />
          <LanguageSwitcher />
        </nav>
      </header>

      <div className={`wb-body${layout.sideOpen ? '' : ' no-side'}${layout.chatOpen ? '' : ' no-chat'}`}>
        <ActivityBar side={side} sideOpen={layout.sideOpen} onSide={(v) => { if (v === side && layout.sideOpen) setL({ sideOpen: false }); else { setSide(v); setL({ sideOpen: true }); } }} chatOpen={layout.chatOpen} onChat={() => setL({ chatOpen: !layout.chatOpen })} />

        {layout.order.map((a) => {
          const i = shown.indexOf(a);
          const before = i > 0 ? shown[i - 1]! : null;
          return (
            <Fragment key={a}>
              {before && <Splitter axis="x" label={t('wb.resize')} onDrag={resize(before, a)} />}
              {panels[a]}
            </Fragment>
          );
        })}
      </div>

      <StatusBar sessions={sessions ?? []} session={chatSession} workspace={workspace} onShowThread={(id) => { setL({ chatOpen: true }); setShowThread((v) => ({ id, n: (v?.n ?? 0) + 1 })); }} />
      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
      {quickOpen && (
        <QuickOpen
          recent={tabs.filter((x) => x.kind === 'file').map((x) => x.path).reverse()}
          onOpen={(path, line) => (line ? openAt({ path, line }) : open({ kind: 'file', path }))}
          onClose={() => setQuickOpen(false)}
        />
      )}
    </div>
  );
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** The column of icons on the far left: the explorer's two views, the chat beside the work, and how the page looks. */
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
      {item('files', t('wb.viewFiles'), <path d="M4 4h6l2 2h8v14H4z" />)}
      {item('search', t('wb.search'), <><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /></>)}
      {item('commits', t('wb.viewCommits'), <><circle cx="12" cy="12" r="3" /><path d="M12 3v6M12 15v6" /></>)}
      <span className="grow" />
      <button type="button" className={`wb-act${chatOpen ? ' on' : ''}`} aria-pressed={chatOpen} aria-label={t('wb.toggleChat')} title={`${t('wb.toggleChat')} (Ctrl+L)`} onClick={onChat}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 5h16v11H9l-5 4z" />
        </svg>
      </button>
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

/** What the editor shows with nothing open: the folder the chat works on, and Kerrigan to take away. */
function Welcome({ workspace, problem }: { workspace: Workspace | null; problem: string }) {
  const { t } = useT();
  return (
    <div className="wb-welcome">
      <h2>{workspace?.ok ? workspace.name : t('wb.welcome')}</h2>
      <p className="muted">{workspace?.ok ? t('wb.welcomeChat', { dir: workspace.dir }) : t('wb.welcomeWhy')}</p>
      {problem && <p className="err small">{problem}</p>}
      <KerriganButton />
      <KerriganAbout />
      <p className="muted small">{t('wb.keys')}</p>
    </div>
  );
}
