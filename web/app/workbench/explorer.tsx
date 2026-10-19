'use client';

/**
 * The explorer, on the workbench's left: the sessions with their tasks, as a tree; or the files of the open project
 * folder; or its git, as an IDE's Source Control view: the changes, staged and not, and the branch's commits.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type GitArea, type GitFile, type Session, type Workspace, type WorkspaceGit } from '../../lib/api';
import { usePoll } from '../../lib/usePoll';
import { useT, useFmtTime } from '../../lib/i18n';
import { StatusMark, type SideView, type Tab } from './workbench';

export function Explorer({
  view,
  sessions,
  selected,
  onOpen,
  onChange,
  workspace,
  onOpenFolder,
}: {
  view: SideView;
  sessions: Array<Session & { running?: boolean }> | null;
  selected: { sessionId?: string; taskId?: string };
  onOpen: (tab: Tab) => void;
  onChange: () => void;
  workspace: Workspace | null;
  onOpenFolder: () => void;
}) {
  if (view === 'files') return <Files workspace={workspace} onOpen={onOpen} onOpenFolder={onOpenFolder} />;
  if (view === 'commits') return <GitView workspace={workspace} sessions={sessions} onOpen={onOpen} onOpenFolder={onOpenFolder} />;
  // The chat's conversations are the chat's: the tree is the bot's sessions.
  return <Tree sessions={sessions ? sessions.filter((s) => s.kind !== 'chat') : null} selected={selected} onOpen={onOpen} onChange={onChange} />;
}

function Head({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="wb-side-head">
      <h2>{title}</h2>
      <span className="grow" />
      {children}
    </div>
  );
}

function Tree({ sessions, selected, onOpen, onChange }: { sessions: Array<Session & { running?: boolean }> | null; selected: { sessionId?: string; taskId?: string }; onOpen: (tab: Tab) => void; onChange: () => void }) {
  const { t } = useT();
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();

  return (
    <div className="wb-tree">
      <Head title={t('wb.sessions')}>
        <Link className="wb-icon-btn" href="/sessions#new-session" title={t('wb.newSession')} aria-label={t('wb.newSession')}>+</Link>
        <Link className="wb-icon-btn" href="/import" title={t('wb.startPlan')} aria-label={t('wb.startPlan')}>⇩</Link>
        <button type="button" className="wb-icon-btn" onClick={onChange} title={t('wb.refresh')} aria-label={t('wb.refresh')}>↻</button>
      </Head>
      <div className="wb-filter">
        <input type="search" aria-label={t('wb.filter')} placeholder={t('wb.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {!sessions ? (
        <p className="muted small wb-pad">{t('wb.loading')}</p>
      ) : sessions.length === 0 ? (
        <p className="muted small wb-pad">
          {t('wb.noSessions')} <Link href="/import">{t('wb.startPlan')}</Link>
        </p>
      ) : (
        <ul className="wb-tree-list" role="tree" aria-label={t('wb.sessions')}>
          {sessions.map((s) => {
            const tasks = s.tasks.filter((x) => !q || x.title.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
            if (q && tasks.length === 0) return null;
            const isOpen = !closed.has(s.id) || !!q;
            const done = s.tasks.filter((x) => x.status === 'done').length;
            return (
              <li key={s.id} role="treeitem" aria-expanded={isOpen} aria-selected={selected.sessionId === s.id && !selected.taskId}>
                <div className={`wb-row session${selected.sessionId === s.id && !selected.taskId ? ' sel' : ''}`}>
                  <button
                    type="button"
                    className="wb-chev"
                    aria-label={isOpen ? t('wb.collapse', { name: s.name }) : t('wb.expand', { name: s.name })}
                    onClick={() =>
                      setClosed((c) => {
                        const n = new Set(c);
                        if (n.has(s.id)) n.delete(s.id);
                        else n.add(s.id);
                        return n;
                      })
                    }
                  >
                    {isOpen ? '▾' : '▸'}
                  </button>
                  <button type="button" className="wb-row-main" onClick={() => onOpen({ kind: 'session', sessionId: s.id })}>
                    <span className="wb-row-name">{s.name}</span>
                    {s.running && <span className="wb-live" title={t('wb.running')} aria-label={t('wb.running')} />}
                    <span className="wb-count">{done}/{s.tasks.length}</span>
                  </button>
                </div>
                {isOpen && (
                  <ul role="group">
                    {tasks.map((x) => {
                      const n = s.tasks.indexOf(x) + 1;
                      const sel = selected.taskId === x.id;
                      return (
                        <li key={x.id} role="treeitem" aria-selected={sel}>
                          <button type="button" className={`wb-row task${sel ? ' sel' : ''}`} onClick={() => onOpen({ kind: 'task', sessionId: s.id, taskId: x.id })} title={x.title}>
                            <StatusMark status={x.status} />
                            <span className="wb-num">{n}.</span>
                            <span className="wb-row-name">{x.title}</span>
                            {(x.attempt ?? 1) > 1 && <span className="wb-count">a{x.attempt}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The session the files and commits views read: the chosen one, else the first with a repository. */
function useRepoSession(sessions: Session[] | null, selected: { sessionId?: string }): Session | undefined {
  return sessions?.find((s) => s.id === selected.sessionId) ?? sessions?.find((s) => s.vcs?.enabled && s.vcs.repoDir);
}

/** A folder of the open project, built from the flat list of its files. */
type Dir = { dirs: Map<string, Dir>; files: string[] };
function treeOf(paths: string[]): Dir {
  const root: Dir = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let at = root;
    for (const part of parts.slice(0, -1)) {
      let next = at.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        at.dirs.set(part, next);
      }
      at = next;
    }
    at.files.push(p);
  }
  return root;
}
const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' });

/**
 * The open project folder as it is on disk (2026-10-17, "like Windsurf"): what the chat works on, every file of
 * it a click from the editor. Read again on demand and every few seconds, so what the chat writes shows up.
 */
function Files({ workspace, onOpen, onOpenFolder }: { workspace: Workspace | null; onOpen: (tab: Tab) => void; onOpenFolder: () => void }) {
  const { t } = useT();
  const [files, setFiles] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const read = () =>
    workspace?.ok
      ? api
          .workspaceFiles()
          .then((r) => {
            setFiles(r.files);
            setErr('');
          })
          .catch((e: unknown) => setErr((e as Error).message))
      : Promise.resolve();
  useEffect(() => {
    setFiles(null);
    void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.dir, workspace?.ok]);
  usePoll(read, 6000, !!workspace?.ok);

  const toggle = (p: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  const render = (dir: Dir, prefix: string): React.ReactNode => (
    <>
      {[...dir.dirs.keys()].sort(byName).map((name) => {
        const p = prefix ? `${prefix}/${name}` : name;
        return (
          <li key={`d:${p}`} role="treeitem" aria-expanded={open.has(p)}>
            <button type="button" className="wb-row" onClick={() => toggle(p)}>
              <span className="wb-chev" aria-hidden="true">{open.has(p) ? '▾' : '▸'}</span>
              <span className="wb-row-name">{name}</span>
            </button>
            {open.has(p) && <ul role="group">{render(dir.dirs.get(name)!, p)}</ul>}
          </li>
        );
      })}
      {[...dir.files].sort((a, b) => byName(a.split('/').pop()!, b.split('/').pop()!)).map((f) => (
        <li key={`f:${f}`} role="treeitem">
          <button type="button" className="wb-row file" onClick={() => onOpen({ kind: 'file', sessionId: '', path: f })} title={f}>
            <span className="wb-ico" aria-hidden="true">≡</span>
            <span className="wb-row-name">{f.split('/').pop()}</span>
          </button>
        </li>
      ))}
    </>
  );

  return (
    <div className="wb-tree">
      <Head title={workspace?.ok ? workspace.name : t('wb.files')}>
        <button type="button" className="wb-icon-btn" onClick={onOpenFolder} title={t('chat.openFolder')} aria-label={t('chat.openFolder')}>⋯</button>
        <button type="button" className="wb-icon-btn" onClick={() => void read()} title={t('wb.refresh')} aria-label={t('wb.refresh')}>↻</button>
      </Head>
      {!workspace ? (
        <p className="muted small wb-pad">{t('wb.loading')}</p>
      ) : !workspace.ok ? (
        <div className="wb-pad">
          <p className="small">{workspace.problem}</p>
          <button type="button" className="primary" onClick={onOpenFolder}>{t('chat.openFolder')}</button>
        </div>
      ) : err ? (
        <p className="err small wb-pad">{err}</p>
      ) : !files ? (
        <p className="muted small wb-pad">{t('wb.loading')}</p>
      ) : (
        <>
          <p className="muted small wb-pad" title={workspace.dir}>{workspace.branch ? `⎇ ${workspace.branch}` : workspace.dir}</p>
          <ul className="wb-tree-list" role="tree" aria-label={t('wb.files')}>
            {render(treeOf(files), '')}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * The open folder's git, as an IDE's Source Control view shows it (2026-10-19: "let the Commits button show Git as
 * VS Code does"): the branch and how far it is from the one it follows; the changes, staged and not, each file with
 * its letter and its lines, opening its two versions side by side in the editor; and the branch's commits, each
 * opening to the files it changed, which open the same way. A commit a task made says which task. Read-only: it
 * stages, commits and checks out nothing. Read again every five seconds, as the chat changes the folder.
 */
function GitView({ workspace, sessions, onOpen, onOpenFolder }: { workspace: Workspace | null; sessions: Session[] | null; onOpen: (tab: Tab) => void; onOpenFolder: () => void }) {
  const { t } = useT();
  const fmt = useFmtTime();
  const [state, setState] = useState<WorkspaceGit | null>(null);
  const [err, setErr] = useState('');
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState('');
  const [commitFiles, setCommitFiles] = useState<Map<string, GitFile[] | string>>(new Map());
  const read = useCallback(
    () =>
      api
        .workspaceGit()
        .then((g) => {
          setState(g);
          setErr('');
        })
        .catch((e: unknown) => setErr((e as Error).message)),
    [],
  );
  useEffect(() => {
    setState(null);
    if (workspace?.ok) void read();
  }, [read, workspace?.ok, workspace?.dir]);
  usePoll(read, 5_000, !!workspace?.ok);

  const toggle = (id: string): void => setShut((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const openCommit = (sha: string): void => {
    if (opened === sha) {
      setOpened('');
      return;
    }
    setOpened(sha);
    if (!commitFiles.has(sha)) {
      api
        .workspaceCommit(sha)
        .then((c) => setCommitFiles((m) => new Map(m).set(sha, c.files)))
        .catch((e: unknown) => setCommitFiles((m) => new Map(m).set(sha, (e as Error).message)));
    }
  };
  // The task that made a commit, when a task did.
  const madeBy = (sha: string): { sessionId: string; taskId: string; title: string } | null => {
    for (const s of sessions ?? []) {
      for (const x of s.tasks) {
        const c = x.vcs?.commit;
        if (c && (c === sha || sha.startsWith(c) || c.startsWith(sha))) return { sessionId: s.id, taskId: x.id, title: x.title };
      }
    }
    return null;
  };
  const statusName = (status: string): string => t(`git.status.${status === '!' ? 'conflict' : status}` as 'git.status.M');
  const fileRow = (f: GitFile, area: GitArea, commit?: string) => {
    const cut = f.path.lastIndexOf('/');
    return (
      <li key={`${area}:${commit ?? ''}:${f.path}`}>
        <button
          type="button"
          className="wb-row wb-git-file"
          onClick={() => onOpen({ kind: 'diff', sessionId: '', area, path: f.path, ...(commit ? { commit } : {}) })}
          title={`${f.oldPath ? `${f.oldPath} → ` : ''}${f.path} · ${statusName(f.status)}`}
        >
          <span className="wb-row-name">{f.path.slice(cut + 1)}</span>
          {cut >= 0 && <span className="muted wb-git-dir">{f.path.slice(0, cut)}</span>}
          <span className="grow" />
          <span className="wb-git-counts">
            {f.added < 0 ? (
              t('diff.binaryShort')
            ) : (
              <>
                <span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span>
              </>
            )}
          </span>
          <span className={`wb-git-status s-${f.status === '!' ? 'conflict' : f.status}`} aria-hidden="true">
            {f.status}
          </span>
        </button>
      </li>
    );
  };
  const section = (id: string, title: string, count: number | null, body: React.ReactNode) => (
    <div className="wb-git-section">
      <button type="button" className="wb-git-head" aria-expanded={!shut.has(id)} onClick={() => toggle(id)}>
        <span aria-hidden="true">{shut.has(id) ? '▸' : '▾'}</span> {title}
        {count !== null && <span className="wb-badge">{count}</span>}
      </button>
      {!shut.has(id) && body}
    </div>
  );

  return (
    <div className="wb-tree">
      <Head title={t('git.title')}>
        <button type="button" className="wb-icon-btn" onClick={() => void read()} title={t('git.refresh')} aria-label={t('git.refresh')} disabled={!workspace?.ok}>
          ↻
        </button>
      </Head>
      {!workspace?.ok ? (
        <div className="wb-pad">
          <p className="muted small">{t('git.noFolder')}</p>
          <button type="button" onClick={onOpenFolder}>{t('chat.openFolder')}</button>
        </div>
      ) : err ? (
        <p className="err small wb-pad">{err}</p>
      ) : !state ? (
        <p className="muted small wb-pad">{t('wb.loading')}</p>
      ) : !state.isRepo ? (
        <p className="muted small wb-pad">{t('git.notRepo')}</p>
      ) : (
        <>
          <p className="small wb-pad wb-git-branch">
            <span aria-hidden="true">⎇ </span>
            <strong>{state.branch ?? 'HEAD'}</strong>
            {state.upstream && <span className="muted"> · {t('git.upstream', { name: state.upstream.name, ahead: state.upstream.ahead, behind: state.upstream.behind })}</span>}
          </p>
          {state.staged.length > 0 && section('staged', t('git.staged'), state.staged.length, <ul className="wb-git-files">{state.staged.map((f) => fileRow(f, 'staged'))}</ul>)}
          {section(
            'changes',
            t('git.changes'),
            state.changes.length,
            state.changes.length === 0 ? <p className="muted small wb-pad">{t('git.noChanges')}</p> : <ul className="wb-git-files">{state.changes.map((f) => fileRow(f, 'changes'))}</ul>,
          )}
          {section(
            'commits',
            t('git.commits'),
            null,
            state.commits.length === 0 ? (
              <p className="muted small wb-pad">{t('git.noCommits')}</p>
            ) : (
              <ul className="wb-commits">
                {state.commits.map((c) => {
                  const by = madeBy(c.sha);
                  const files = commitFiles.get(c.sha);
                  return (
                    <li key={c.sha}>
                      <button type="button" className="wb-row" aria-expanded={opened === c.sha} onClick={() => openCommit(c.sha)} title={c.subject}>
                        <span aria-hidden="true">{opened === c.sha ? '▾' : '▸'}</span>
                        <code>{c.short}</code>
                        <span className="wb-row-name">{c.subject}</span>
                      </button>
                      <div className="muted wb-commit-meta">
                        {c.author} · {fmt(c.at)}
                        {by && (
                          <>
                            {' · '}
                            <button type="button" className="linkish" onClick={() => onOpen({ kind: 'task', sessionId: by.sessionId, taskId: by.taskId })}>
                              {t('wb.byTask', { title: by.title })}
                            </button>
                          </>
                        )}
                      </div>
                      {opened === c.sha &&
                        (files === undefined ? (
                          <p className="muted small wb-pad">{t('wb.loading')}</p>
                        ) : typeof files === 'string' ? (
                          <p className="err small wb-pad">{files}</p>
                        ) : (
                          <ul className="wb-git-files nested" aria-label={t('git.commitFiles', { sha: c.short })}>
                            {files.map((f) => fileRow(f, 'commit', c.sha))}
                          </ul>
                        ))}
                    </li>
                  );
                })}
              </ul>
            ),
          )}
          {state.moreCommits && <p className="muted small wb-pad">{t('git.more', { n: state.commits.length })}</p>}
        </>
      )}
    </div>
  );
}
