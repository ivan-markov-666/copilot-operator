'use client';

/**
 * The explorer, on the workbench's left: the files of the open project folder, or its git, as an IDE's Source Control
 * view: the changes, staged and not, and the branch's commits. The tree of sessions and tasks went with the sessions
 * (2026-10-20).
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type BranchChanges, type GitArea, type GitFile, type Workspace, type WorkspaceGit } from '../../lib/api';
import { BranchSection } from './branchChanges';
import { usePoll } from '../../lib/usePoll';
import { useT, useFmtTime } from '../../lib/i18n';
import type { SideView, Tab } from './workbench';
import { FileIcon } from './fileIcon';
import { BranchIcon } from '../branchIcon';

export function Explorer({ view, onOpen, workspace, onOpenFolder, grip }: { view: SideView; onOpen: (tab: Tab) => void; workspace: Workspace | null; onOpenFolder: () => void; /** Moves the panel (see `panelGrip.tsx`). */ grip?: React.ReactNode }) {
  if (view === 'commits') return <GitView workspace={workspace} onOpen={onOpen} onOpenFolder={onOpenFolder} grip={grip} />;
  return <Files workspace={workspace} onOpen={onOpen} onOpenFolder={onOpenFolder} grip={grip} />;
}

function Head({ title, children, grip }: { title: string; children?: React.ReactNode; grip?: React.ReactNode }) {
  return (
    <div className="wb-side-head">
      {grip}
      <h2>{title}</h2>
      <span className="grow" />
      {children}
    </div>
  );
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
function Files({ workspace, onOpen, onOpenFolder, grip }: { workspace: Workspace | null; onOpen: (tab: Tab) => void; onOpenFolder: () => void; grip?: React.ReactNode }) {
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
          <button type="button" className="wb-row file" onClick={() => onOpen({ kind: 'file', path: f })} title={f}>
            <FileIcon path={f} />
            <span className="wb-row-name">{f.split('/').pop()}</span>
          </button>
        </li>
      ))}
    </>
  );

  return (
    <div className="wb-tree">
      <Head title={workspace?.ok ? workspace.name : t('wb.files')} grip={grip}>
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
          <p className="muted small wb-pad" title={workspace.dir}>
            {workspace.branch ? (
              <>
                <BranchIcon /> {workspace.branch}
              </>
            ) : (
              workspace.dir
            )}
          </p>
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
 * opening to the files it changed, which open the same way. Read-only: it stages, commits and checks out nothing.
 * Read again every five seconds, as the chat changes the folder.
 */
function GitView({ workspace, onOpen, onOpenFolder, grip }: { workspace: Workspace | null; onOpen: (tab: Tab) => void; onOpenFolder: () => void; grip?: React.ReactNode }) {
  const { t } = useT();
  const fmt = useFmtTime();
  const [state, setState] = useState<WorkspaceGit | null>(null);
  const [err, setErr] = useState('');
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState('');
  const [commitFiles, setCommitFiles] = useState<Map<string, GitFile[] | string>>(new Map());
  /*
   * Everything the branch changed, as a pull request shows it (2026-10-22), against the branch chosen for this folder
   * — kept in this browser — or the one a pull request would go into.
   */
  const [branch, setBranch] = useState<BranchChanges | null>(null);
  const baseKey = `cop.git.base:${workspace?.dir ?? ''}`;
  const [base, setBase] = useState('');
  useEffect(() => {
    try {
      setBase(window.localStorage.getItem(baseKey) ?? '');
    } catch {
      setBase('');
    }
  }, [baseKey]);
  const chooseBase = (b: string): void => {
    setBase(b);
    try {
      window.localStorage.setItem(baseKey, b);
    } catch {
      /* kept for this visit only */
    }
  };
  const read = useCallback(
    () =>
      Promise.all([api.workspaceGit(), api.workspaceBranch(base || undefined)])
        .then(([g, b]) => {
          setState(g);
          setBranch(b);
          setErr('');
        })
        .catch((e: unknown) => setErr((e as Error).message)),
    [base],
  );
  useEffect(() => {
    setState(null);
    setBranch(null);
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
  const statusName = (status: string): string => t(`git.status.${status === '!' ? 'conflict' : status}` as 'git.status.M');
  const fileRow = (f: GitFile, area: GitArea, commit?: string) => {
    const cut = f.path.lastIndexOf('/');
    return (
      <li key={`${area}:${commit ?? ''}:${f.path}`}>
        <button
          type="button"
          className="wb-row wb-git-file"
          onClick={() => onOpen({ kind: 'diff', area, path: f.path, ...(commit ? { commit } : {}) })}
          title={`${f.oldPath ? `${f.oldPath} → ` : ''}${f.path} · ${statusName(f.status)}`}
        >
          <FileIcon path={f.path} />
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
      <Head title={t('git.title')} grip={grip}>
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
            <BranchIcon /> <strong>{state.branch ?? 'HEAD'}</strong>
            {state.upstream && <span className="muted"> · {t('git.upstream', { name: state.upstream.name, ahead: state.upstream.ahead, behind: state.upstream.behind })}</span>}
          </p>
          {branch &&
            section(
              'branch',
              t('git.branch'),
              branch.problem ? null : branch.files.length,
              <BranchSection data={branch} onBase={chooseBase} statusName={statusName} onOpenFile={(path) => onOpen({ kind: 'diff', area: 'branch', path, ...(branch.base ? { commit: branch.base } : {}) })} />,
            )}
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
                {state.commits.map((c, i) => {
                  const files = commitFiles.get(c.sha);
                  // The branch's own commits, marked; where it left the base, a line that says so (2026-10-22).
                  const mine = !!branch?.mergeBase && branch.commits.includes(c.sha);
                  const startsHere = !!branch?.mergeBase && c.sha === branch.mergeBase && i > 0 && branch.commits.length > 0;
                  return (
                    <li key={c.sha} className={mine ? 'on-branch' : undefined}>
                      {startsHere && (
                        <p className="wb-branch-start small" role="separator">
                          {t('git.branchStart', { base: branch!.base ?? '', sha: c.short })}
                        </p>
                      )}
                      <button type="button" className="wb-row" aria-expanded={opened === c.sha} onClick={() => openCommit(c.sha)} title={mine ? `${c.subject} · ${t('git.onBranch')}` : c.subject}>
                        <span aria-hidden="true">{opened === c.sha ? '▾' : '▸'}</span>
                        <code>{c.short}</code>
                        <span className="wb-row-name">{c.subject}</span>
                      </button>
                      <div className="muted wb-commit-meta">
                        {c.author} · {fmt(c.at)}
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
