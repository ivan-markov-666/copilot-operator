'use client';

/**
 * "On this branch" in the Git view (operator, 2026-10-22: "show all the files changed on this branch, as a pull request
 * does, not only the ones not committed; and of them, which are not committed yet"). Against the branch it would go
 * into — chosen in a list, kept for the folder —: how far apart the two are, every file the branch changed with its
 * lines, and a mark on the ones with something not committed yet; a filter for all of them, the committed ones, the
 * ones not committed. A file opens as the pull request would show it: where the branch began, against it as it is now.
 */
import { useState } from 'react';
import type { BranchChanges, BranchFile } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { FileIcon } from './fileIcon';

type Filter = 'all' | 'committed' | 'uncommitted';
const SAID = {
  staged: 'git.uncommitted.staged',
  changes: 'git.uncommitted.changes',
  untracked: 'git.uncommitted.untracked',
  mixed: 'git.uncommitted.mixed',
} as const;

export function BranchSection({
  data,
  onBase,
  onOpenFile,
  statusName,
}: {
  data: BranchChanges;
  onBase: (base: string) => void;
  /** `keep`: opened to stay (a double click), not as a preview the next one takes the place of. */
  onOpenFile: (path: string, keep?: boolean) => void;
  statusName: (status: string) => string;
}) {
  const { t } = useT();
  const [filter, setFilter] = useState<Filter>('all');
  if (data.problem) {
    const why = data.problem === 'no-common' ? t('git.problem.noCommon', { base: data.base ?? '' }) : data.problem === 'no-base' ? t('git.problem.noBase') : t('git.problem.noCommit');
    return <p className="muted small wb-pad">{why}</p>;
  }
  const files = data.files;
  const open = files.filter((f) => f.uncommitted);
  const done = files.filter((f) => f.committed);
  const shown = filter === 'committed' ? done : filter === 'uncommitted' ? open : files;
  const added = files.reduce((n, f) => n + Math.max(0, f.added), 0);
  const removed = files.reduce((n, f) => n + Math.max(0, f.removed), 0);
  const tab = (id: Filter, label: string) => (
    <button type="button" role="tab" aria-selected={filter === id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>
      {label}
    </button>
  );
  return (
    <div className="wb-branch">
      <div className="wb-branch-base">
        <label htmlFor="wb-branch-base" className="muted small">
          {t('git.against')}
        </label>
        <select id="wb-branch-base" value={data.base ?? ''} onChange={(e) => onBase(e.target.value)} title={t('git.againstWhy')}>
          {data.bases.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>
      {/* Two lines, so neither is broken in a narrow panel: the commits, then the files and their lines. */}
      <p className="muted small wb-pad wb-branch-counts">
        <span className="wb-branch-ahead">{t('git.branchCounts', { ahead: data.ahead, behind: data.behind })}</span>
        <span className="wb-branch-files">
          {t('git.branchFiles', { files: files.length })}
          {files.length > 0 && (
            <span className="wb-git-counts">
              {' · '}
              <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
            </span>
          )}
        </span>
      </p>
      {files.length === 0 ? (
        <p className="muted small wb-pad">{t('git.noBranchChanges', { base: data.base ?? '' })}</p>
      ) : (
        <>
          <div className="wb-branch-filter" role="tablist" aria-label={t('git.filter')}>
            {tab('all', t('git.filterAll', { n: files.length }))}
            {tab('committed', t('git.filterCommitted', { n: done.length }))}
            {tab('uncommitted', t('git.filterUncommitted', { n: open.length }))}
          </div>
          {open.length > 0 && (
            <p className="muted small wb-pad wb-branch-legend">
              <span className="wb-uncommitted" aria-hidden="true">●</span> {t('git.legend')}
            </p>
          )}
          {shown.length === 0 ? (
            <p className="muted small wb-pad">{filter === 'uncommitted' ? t('git.allCommitted') : t('git.noneCommitted')}</p>
          ) : (
            <ul className="wb-git-files" aria-label={t('git.branch')}>
              {shown.map((f) => (
                <BranchRow key={f.path} f={f} onOpen={(keep) => onOpenFile(f.path, keep)} statusName={statusName} />
              ))}
            </ul>
          )}
          {data.moreFiles && <p className="muted small wb-pad">{t('git.moreFiles', { n: files.length })}</p>}
        </>
      )}
    </div>
  );
}

function BranchRow({ f, onOpen, statusName }: { f: BranchFile; onOpen: (keep?: boolean) => void; statusName: (status: string) => string }) {
  const { t } = useT();
  const cut = f.path.lastIndexOf('/');
  const open = f.uncommitted ? t(SAID[f.uncommitted]) : '';
  return (
    <li>
      <button
        type="button"
        className={`wb-row wb-git-file${f.uncommitted ? ' has-uncommitted' : ''}`}
        onClick={() => onOpen()}
        onDoubleClick={() => onOpen(true)}
        title={[`${f.oldPath ? `${f.oldPath} → ` : ''}${f.path} · ${statusName(f.status)}`, f.committed ? t('git.inCommits') : '', open].filter(Boolean).join(' · ')}
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
        {f.uncommitted ? (
          <span className={`wb-uncommitted u-${f.uncommitted}`} role="img" aria-label={open}>
            ●
          </span>
        ) : (
          <span className="wb-uncommitted none" aria-hidden="true" />
        )}
        <span className={`wb-git-status s-${f.status}`} aria-hidden="true">
          {f.status}
        </span>
      </button>
    </li>
  );
}
