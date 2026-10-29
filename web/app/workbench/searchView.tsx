'use client';

/**
 * The Search view, as VS Code's (Ctrl+Shift+F; operator, 2026-10-21: "search code in the files, designed and working
 * as in VS Code, so that it is easy for most programmers"): a box with Match Case, Match Whole Word and Use Regular
 * Expression beside the text, "…" for the files to include and to exclude, how many results in how many files, and
 * the results by file — its icon, name, folder and count — each line with its matches marked. A line opens its file
 * at that line, the match selected. It searches as one types, a moment after the typing stops.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type SearchResult } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { FileIcon } from './fileIcon';

export type SearchHit = { path: string; line: number; from?: number; to?: number };

/** A line of a result with its matches marked. */
function lineWith(text: string, ranges: Array<[number, number]>): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(
      <mark key={i} className="sv-hit">
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function SearchView({ onOpen, grip, focusAsk }: { onOpen: (hit: SearchHit, keep?: boolean) => void; grip?: ReactNode; focusAsk: number }) {
  const { t } = useT();
  const [q, setQ] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [details, setDetails] = useState(false);
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const box = useRef<HTMLInputElement | null>(null);
  /** The newest search asked for: an older answer that comes after it is not shown. */
  const asked = useRef(0);

  useEffect(() => {
    if (focusAsk > 0) {
      box.current?.focus();
      box.current?.select();
    }
  }, [focusAsk]);

  const run = async (): Promise<void> => {
    const n = ++asked.current;
    if (!q) {
      setResult(null);
      setBusy(false);
      setErr('');
      return;
    }
    setBusy(true);
    try {
      const r = await api.workspaceSearch(q, { matchCase, wholeWord, regex, include, exclude });
      if (n !== asked.current) return;
      setResult(r);
      setErr('');
      setClosed(new Set());
    } catch (e) {
      if (n === asked.current) setErr((e as Error).message);
    } finally {
      if (n === asked.current) setBusy(false);
    }
  };
  // As one types, a moment after the typing stops; an option changed searches again at once.
  useEffect(() => {
    const timer = setTimeout(() => void run(), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, matchCase, wholeWord, regex, include, exclude]);

  const files = result?.files ?? [];
  const allClosed = files.length > 0 && files.every((f) => closed.has(f.path));
  const toggle = (label: string, on: boolean, set: (v: boolean) => void, glyph: ReactNode, cls: string) => (
    <button type="button" className={`sv-toggle ${cls}${on ? ' on' : ''}`} aria-pressed={on} aria-label={label} title={label} onClick={() => set(!on)}>
      {glyph}
    </button>
  );
  const message = busy
    ? t('search.searching')
    : err || result?.problem
      ? t('search.problem', { why: err || result?.problem || '' })
      : result && q
        ? result.total === 0
          ? t('search.none')
          : t('search.results', { n: result.total, files: files.length })
        : '';

  return (
    <div className="sv">
      <div className="wb-side-head">
        {grip}
        <h2>{t('search.title')}</h2>
        <span className="grow" />
        <button type="button" className="wb-icon-btn" onClick={() => void run()} disabled={!q} aria-label={t('search.refresh')} title={t('search.refresh')}>
          ↻
        </button>
        <button
          type="button"
          className="wb-icon-btn"
          onClick={() => {
            setQ('');
            setResult(null);
            box.current?.focus();
          }}
          disabled={!q && !result}
          aria-label={t('search.clear')}
          title={t('search.clear')}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 9.5h5.6L11.5 4" />
          </svg>
        </button>
        <button
          type="button"
          className="wb-icon-btn"
          onClick={() => setClosed(allClosed ? new Set() : new Set(files.map((f) => f.path)))}
          disabled={files.length === 0}
          aria-label={allClosed ? t('search.expand') : t('search.collapse')}
          title={allClosed ? t('search.expand') : t('search.collapse')}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            {allClosed ? <path d="M4 6l4 4 4-4" /> : <path d="M3 3h10v10H3zM5.5 8h5" />}
          </svg>
        </button>
      </div>

      <div className="sv-form">
        <div className="sv-row">
          <button type="button" className={`sv-details${details ? ' on' : ''}`} aria-expanded={details} aria-label={t('search.details')} title={t('search.details')} onClick={() => setDetails(!details)}>
            …
          </button>
          <div className="sv-box">
            <input
              ref={box}
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run();
              }}
              placeholder={t('search.input')}
              aria-label={t('search.input')}
              spellCheck={false}
            />
            {toggle(t('search.matchCase'), matchCase, setMatchCase, 'Aa', 'case')}
            {toggle(t('search.wholeWord'), wholeWord, setWholeWord, <span className="sv-word">ab</span>, 'word')}
            {toggle(t('search.regex'), regex, setRegex, '.*', 'regex')}
          </div>
        </div>
        {details && (
          <div className="sv-globs">
            <label htmlFor="sv-include">{t('search.include')}</label>
            <input id="sv-include" type="text" value={include} onChange={(e) => setInclude(e.target.value)} placeholder={t('search.includePlaceholder')} spellCheck={false} />
            <label htmlFor="sv-exclude">{t('search.exclude')}</label>
            <input id="sv-exclude" type="text" value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder={t('search.excludePlaceholder')} spellCheck={false} />
          </div>
        )}
        {message && (
          <p className={`sv-message${err || result?.problem ? ' bad' : ''}`} role="status">
            {message}
          </p>
        )}
        {result?.truncated && !busy && <p className="sv-message">{t('search.truncated')}</p>}
      </div>

      <div className="sv-results" role="tree" aria-label={t('search.title')}>
        {files.map((f) => {
          const open = !closed.has(f.path);
          const slash = f.path.lastIndexOf('/');
          return (
            <div key={f.path} role="treeitem" aria-expanded={open} aria-selected={false} className="sv-file">
              <button
                type="button"
                className="sv-file-head"
                onClick={() =>
                  setClosed((c) => {
                    const next = new Set(c);
                    if (next.has(f.path)) next.delete(f.path);
                    else next.add(f.path);
                    return next;
                  })
                }
                title={f.path}
              >
                <span className={`sv-chevron${open ? ' open' : ''}`} aria-hidden="true">
                  ›
                </span>
                <FileIcon path={f.path} />
                <span className="sv-name">{f.path.slice(slash + 1)}</span>
                {slash > 0 && <span className="sv-dir">{f.path.slice(0, slash)}</span>}
                <span className="sv-count">{f.matches.reduce((n, m) => n + Math.max(1, m.ranges.length), 0)}</span>
              </button>
              {open && (
                <div role="group">
                  {f.matches.map((m, i) => (
                    <button
                      key={`${m.line}-${i}`}
                      type="button"
                      role="treeitem"
                      aria-selected={false}
                      className="sv-match"
                      title={`${f.path}:${m.line}`}
                      // A preview, as VS Code opens a result; a double click opens it to stay (2026-10-29).
                      onClick={() => onOpen({ path: f.path, line: m.line, ...(m.column !== undefined ? { from: m.column, to: m.column + (m.length ?? 0) } : {}) })}
                      onDoubleClick={() => onOpen({ path: f.path, line: m.line, ...(m.column !== undefined ? { from: m.column, to: m.column + (m.length ?? 0) } : {}) }, true)}
                    >
                      {lineWith(m.text, m.ranges)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
