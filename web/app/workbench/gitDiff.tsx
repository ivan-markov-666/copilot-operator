'use client';

/**
 * One file of the open folder's git, before on the left and after on the right, in a tab of the editor — as an IDE
 * opens a file from its Source Control view (2026-10-19). A change in the working tree is its version in the index
 * against the file on disk; a staged one, HEAD against the index; a commit's, its parent's version against the
 * commit's. A file still changing is read again every few seconds. The rows, the folding of unchanged stretches and
 * the marking of what differs in a line are the changes view's own (see diffView.tsx).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ChangedFileContent, type GitArea } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { usePoll } from '../../lib/usePoll';
import { foldRows, linesOf, sideBySide, type DiffRow } from '../../lib/lineDiff';
import { DiffHead, DiffLine, DiffTools } from '../diffView';

export function GitDiff({ area, path, commit }: { area: GitArea; path: string; commit?: string }) {
  const { t } = useT();
  const [content, setContent] = useState<ChangedFileContent | null>(null);
  const [err, setErr] = useState('');
  const [whole, setWhole] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [gaps, setGaps] = useState<Set<number>>(new Set());
  const [block, setBlock] = useState(-1);
  const scroller = useRef<HTMLDivElement | null>(null);

  const read = useCallback(
    () =>
      api
        .workspaceGitFile(area, path, commit)
        .then((c) => {
          setContent(c);
          setErr('');
        })
        .catch((e: unknown) => setErr((e as Error).message)),
    [area, path, commit],
  );
  useEffect(() => {
    setContent(null);
    setErr('');
    setGaps(new Set());
    setBlock(-1);
    void read();
  }, [read]);
  // A commit's file does not change; the working tree's and the index's may, while the chat works.
  usePoll(read, 5_000, area !== 'commit');

  const rows: DiffRow[] = useMemo(
    () => (content && !content.binary && !content.tooLarge ? sideBySide(linesOf(content.before), linesOf(content.after)) : []),
    [content],
  );
  const items = useMemo(() => foldRows(rows, 3, gaps, whole), [rows, gaps, whole]);
  const blocks = useMemo(() => rows.flatMap((r, i) => (r.kind !== 'same' && (i === 0 || rows[i - 1]!.kind === 'same') ? [i] : [])), [rows]);
  const go = (step: 1 | -1): void => {
    if (blocks.length === 0) return;
    const next = block < 0 ? (step === 1 ? 0 : blocks.length - 1) : Math.min(blocks.length - 1, Math.max(0, block + step));
    setBlock(next);
    scroller.current?.querySelector(`[data-row="${blocks[next]}"]`)?.scrollIntoView({ block: 'center' });
  };

  const where = area === 'commit' ? (commit ?? '').slice(0, 7) : t(area === 'staged' ? 'git.index' : 'git.workingTree');
  const status = content?.status ?? '';
  return (
    <div className="wb-gitdiff">
      <div className="diff-toolbar">
        <div className="diff-title-row">
          <strong className="diff-name">{content?.oldPath ? `${content.oldPath} → ${path}` : path}</strong>
          <span className="muted small">
            {where}
            {status ? ` · ${t(`git.status.${status === '!' ? 'conflict' : status}` as 'git.status.M')}` : ''}
          </span>
        </div>
        <DiffTools changes={blocks.length} onChange={go} whole={whole} onWhole={setWhole} wrap={wrap} onWrap={setWrap} />
      </div>
      <div className="diff-scroll" ref={scroller}>
        {err && <div className="err" style={{ padding: 12 }}>{err}</div>}
        {!content && !err && <div className="muted" style={{ padding: 12 }}>{t('diff.loading')}</div>}
        {content?.binary && <div className="notice" style={{ margin: 12 }}>{t('diff.binary')}</div>}
        {content?.tooLarge && <div className="notice" style={{ margin: 12 }}>{t('diff.tooLarge')}</div>}
        {content && !content.binary && !content.tooLarge && (
          <>
            {rows.length > 0 && blocks.length === 0 && <div className="notice small" style={{ margin: 8 }}>{t('diff.sameText')}</div>}
            <table className={`diff-table${wrap ? '' : ' nowrap'}`}>
              <colgroup>
                <col className="num" />
                <col />
                <col className="num" />
                <col />
              </colgroup>
              <DiffHead changes={blocks.length} at={block} />
              <tbody>
                {items.map((item) =>
                  item.type === 'gap' ? (
                    <tr key={`g${item.from}`} className="diff-gap">
                      <td colSpan={4}>
                        <button type="button" className="linkish small" onClick={() => setGaps((g) => new Set([...g, item.from]))}>
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
  );
}
