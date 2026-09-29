'use client';

/**
 * What a task changed, file by file, before on the left and after on the right.
 *
 * Opened from a task card, a register row, or an earlier attempt. The files are listed down the
 * side with what happened to each — added, changed, deleted, renamed — and how many lines went in
 * and out; the chosen one fills the rest of the screen. The two versions are one table, one row per
 * pair of lines, so scrolling moves both sides together and a line always sits opposite the line it
 * became. Unchanged stretches fold to three lines of context each side and open with a click, or
 * the whole file is shown at once. "Next change" and "Previous change" (n and p) walk the edits,
 * "Next file" and "Previous file" (] and [) the list, Escape closes.
 *
 * The changes are the ones between the commit the task started from and the one it produced, read
 * from git when the view opens (see `taskChanges` in the service): there is something to show only
 * when version control was on and the task committed, and when there is not the view says why.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, type ChangedFile, type ChangedFileContent } from '../lib/api';
import { useModalFocus } from '../lib/useModalFocus';
import { useT } from '../lib/i18n';
import { changedSpan, foldRows, linesOf, sideBySide, type DiffRow } from '../lib/lineDiff';

type Changes = Awaited<ReturnType<typeof api.taskChanges>>;

/** The button that opens the view, labelled with how many files the attempt changed. */
export function ChangesButton({ sessionId, taskId, runId, title, files }: { sessionId: string; taskId: string; runId?: string; title: string; files: number }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="linkish" onClick={() => setOpen(true)} title={t('diff.openWhy')}>
        {t('diff.open', { n: files })}
      </button>
      {open && <DiffDialog sessionId={sessionId} taskId={taskId} runId={runId} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}

export function DiffDialog({ sessionId, taskId, runId, title, onClose }: { sessionId: string; taskId: string; runId?: string; title: string; onClose: () => void }) {
  const { t } = useT();
  const [changes, setChanges] = useState<Changes | null>(null);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState(0);
  const [contents, setContents] = useState<Map<string, ChangedFileContent | string>>(new Map());
  const [whole, setWhole] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [openGaps, setOpenGaps] = useState<Map<string, Set<number>>>(new Map());
  const [block, setBlock] = useState(-1);
  const scroller = useRef<HTMLDivElement | null>(null);
  const overlay = useRef<HTMLDivElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  // Focus on Close when it opens, kept inside, back on "See the changes" when it closes.
  useModalFocus(overlay, true, closeButton);

  useEffect(() => {
    api
      .taskChanges(sessionId, taskId, runId)
      .then(setChanges)
      .catch((e) => setErr((e as Error).message));
  }, [sessionId, taskId, runId]);

  const files = changes?.files ?? [];
  const file: ChangedFile | undefined = files[selected];

  // The chosen file's two versions, read once and kept while the view is open.
  useEffect(() => {
    if (!file || contents.has(file.path)) return;
    api
      .taskChangeFile(sessionId, taskId, file.path, runId)
      .then((c) => setContents((prev) => new Map(prev).set(file.path, c)))
      .catch((e) => setContents((prev) => new Map(prev).set(file.path, (e as Error).message)));
  }, [file, contents, sessionId, taskId, runId]);

  const content = file ? contents.get(file.path) : undefined;
  const rows: DiffRow[] = useMemo(
    () => (content && typeof content !== 'string' && !content.binary && !content.tooLarge ? sideBySide(linesOf(content.before), linesOf(content.after)) : []),
    [content],
  );
  const gaps = (file && openGaps.get(file.path)) || new Set<number>();
  const items = useMemo(() => foldRows(rows, 3, gaps, whole), [rows, gaps, whole]);
  // The first row of every run of changed rows: what "next change" steps through.
  const blocks = useMemo(() => rows.flatMap((r, i) => (r.kind !== 'same' && (i === 0 || rows[i - 1]!.kind === 'same') ? [i] : [])), [rows]);

  // A new file starts at its top, with no change chosen yet.
  useEffect(() => {
    setBlock(-1);
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [selected]);

  const goBlock = useCallback(
    (step: 1 | -1) => {
      if (blocks.length === 0) return;
      const next = block < 0 ? (step === 1 ? 0 : blocks.length - 1) : Math.min(blocks.length - 1, Math.max(0, block + step));
      setBlock(next);
      const target = scroller.current?.querySelector(`[data-row="${blocks[next]}"]`);
      target?.scrollIntoView({ block: 'center' });
    },
    [block, blocks],
  );
  const goFile = useCallback((step: 1 | -1) => setSelected((i) => Math.min(Math.max(0, i + step), Math.max(0, files.length - 1))), [files.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'n') goBlock(1);
      else if (e.key === 'p') goBlock(-1);
      else if (e.key === ']') goFile(1);
      else if (e.key === '[') goFile(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    // The page underneath does not scroll while the view is open.
    const was = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = was;
    };
  }, [goBlock, goFile, onClose]);

  const totals = files.reduce((n, f) => ({ added: n.added + Math.max(0, f.added), removed: n.removed + Math.max(0, f.removed) }), { added: 0, removed: 0 });
  const openGap = (from: number): void => {
    if (!file) return;
    setOpenGaps((prev) => new Map(prev).set(file.path, new Set([...(prev.get(file.path) ?? []), from])));
  };

  return (
    <div ref={overlay} className="diff-overlay" role="dialog" aria-modal="true" aria-labelledby="diff-title">
      <div className="diff-head">
        <h2 id="diff-title">{t('diff.title', { title })}</h2>
        {changes?.ok && (
          <span className="muted small">
            {changes.branch ? `${changes.branch} · ` : ''}
            {changes.base?.slice(0, 8)} → {changes.commit?.slice(0, 8)} · {t('diff.summary', { n: files.length, a: totals.added, r: totals.removed })}
          </span>
        )}
        <span className="grow" />
        <span className="muted small">{t('diff.keys')}</span>
        <button ref={closeButton} type="button" onClick={onClose}>
          {t('diff.close')}
        </button>
      </div>

      {err && <div className="err" style={{ padding: 12 }}>{err}</div>}
      {!changes && !err && <div className="muted" style={{ padding: 12 }}>{t('diff.loading')}</div>}
      {changes && !changes.ok && <div className="notice caution" style={{ margin: 12 }}>{changes.problem}</div>}
      {changes?.ok && files.length === 0 && <div className="notice" style={{ margin: 12 }}>{t('diff.nothing')}</div>}

      {changes?.ok && files.length > 0 && (
        <div className="diff-body">
          <nav className="diff-files" aria-label={t('diff.files')}>
            {files.map((f, i) => {
              const cut = f.path.lastIndexOf('/');
              return (
                <button type="button" key={f.path} className={`diff-file${i === selected ? ' on' : ''}`} onClick={() => setSelected(i)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                  <span className={`diff-status s-${f.status}`}>{f.status}</span>
                  <span className="diff-path">
                    {cut >= 0 && <span className="muted">{f.path.slice(0, cut + 1)}</span>}
                    <strong>{f.path.slice(cut + 1)}</strong>
                  </span>
                  <span className="diff-counts">
                    {f.added < 0 ? t('diff.binaryShort') : (
                      <>
                        <span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span>
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="diff-main">
            {file && (
              <div className="diff-toolbar">
                <strong className="diff-name">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</strong>
                <span className="muted small">
                  {file.status === 'A' ? t('diff.added') : file.status === 'D' ? t('diff.deleted') : file.status === 'R' ? t('diff.renamed') : ''}
                </span>
                <span className="grow" />
                <button type="button" className="quiet" onClick={() => goBlock(-1)} disabled={blocks.length === 0}>
                  {t('diff.prevChange')}
                </button>
                <button type="button" className="quiet" onClick={() => goBlock(1)} disabled={blocks.length === 0}>
                  {t('diff.nextChange')}
                </button>
                <span className="muted small">{blocks.length > 0 ? t('diff.changeN', { i: block < 0 ? '–' : block + 1, n: blocks.length }) : ''}</span>
                <button type="button" className="quiet" onClick={() => goFile(-1)} disabled={selected === 0}>
                  {t('diff.prevFile')}
                </button>
                <button type="button" className="quiet" onClick={() => goFile(1)} disabled={selected >= files.length - 1}>
                  {t('diff.nextFile')}
                </button>
                <label className="option-inline">
                  <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} /> {t('diff.whole')}
                </label>
                <label className="option-inline">
                  <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> {t('diff.wrap')}
                </label>
              </div>
            )}

            <div className="diff-scroll" ref={scroller}>
              {content === undefined && <div className="muted" style={{ padding: 12 }}>{t('diff.loading')}</div>}
              {typeof content === 'string' && <div className="err" style={{ padding: 12 }}>{content}</div>}
              {content && typeof content !== 'string' && content.binary && <div className="notice" style={{ margin: 12 }}>{t('diff.binary')}</div>}
              {content && typeof content !== 'string' && content.tooLarge && <div className="notice" style={{ margin: 12 }}>{t('diff.tooLarge')}</div>}
              {content && typeof content !== 'string' && !content.binary && !content.tooLarge && (
                <>
                  {(content.before ?? '').includes('\r\n') !== (content.after ?? '').includes('\r\n') && content.before !== null && content.after !== null && (
                    <div className="notice small" style={{ margin: 8 }}>
                      {t('diff.eol', { from: (content.before ?? '').includes('\r\n') ? 'CRLF' : 'LF', to: (content.after ?? '').includes('\r\n') ? 'CRLF' : 'LF' })}
                    </div>
                  )}
                  {rows.length > 0 && blocks.length === 0 && <div className="notice small" style={{ margin: 8 }}>{t('diff.sameText')}</div>}
                  <table className={`diff-table${wrap ? '' : ' nowrap'}`}>
                    <colgroup>
                      <col className="num" />
                      <col />
                      <col className="num" />
                      <col />
                    </colgroup>
                    <thead>
                      <tr>
                        <th colSpan={2}>{t('diff.before')}</th>
                        <th colSpan={2}>{t('diff.after')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) =>
                        item.type === 'gap' ? (
                          <tr key={`g${item.from}`} className="diff-gap">
                            <td colSpan={4}>
                              <button type="button" className="linkish small" onClick={() => openGap(item.from)}>
                                {t('diff.gap', { n: item.count })}
                              </button>
                            </td>
                          </tr>
                        ) : (
                          <DiffLine key={item.index} row={item.row} index={item.index} current={block >= 0 && blocks[block] === item.index} />
                        ),
                      )}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** One row: the old line and the new one, with the part of a changed line that differs marked. */
function DiffLine({ row, index, current }: { row: DiffRow; index: number; current: boolean }) {
  const span = row.kind === 'change' ? changedSpan(row.left!.text, row.right!.text) : null;
  const text = (side: 'left' | 'right'): React.ReactNode => {
    const s = row[side];
    if (!s) return null;
    if (!span) return s.text;
    const end = side === 'left' ? span.leftEnd : span.rightEnd;
    return (
      <Fragment>
        {s.text.slice(0, span.start)}
        <mark>{s.text.slice(span.start, end)}</mark>
        {s.text.slice(end)}
      </Fragment>
    );
  };
  return (
    <tr className={`diff-row ${row.kind}${current ? ' current' : ''}`} data-row={index}>
      <td className="num">{row.left?.no ?? ''}</td>
      <td className={`code l${row.left ? '' : ' empty'}`}>{text('left')}</td>
      <td className="num">{row.right?.no ?? ''}</td>
      <td className={`code r${row.right ? '' : ' empty'}`}>{text('right')}</td>
    </tr>
  );
}
