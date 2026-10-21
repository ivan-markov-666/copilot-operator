'use client';

/**
 * "Go to File", as VS Code's Ctrl+P (operator, 2026-10-21: "search for a file of the project, designed and working as
 * in VS Code"): a box at the top of the screen, the files of the open folder found by a few letters of their name —
 * the letters marked — each with its icon, its name and its folder; the files open in the editor come first while
 * nothing is typed. Arrow keys choose, Enter opens, Escape closes; `name:42` opens it at line 42.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { fuzzyFiles, splitLine, type FuzzyHit } from '../../lib/fuzzy';
import { useT } from '../../lib/i18n';
import { FileIcon } from './fileIcon';

/** A text with the letters at `hits` marked, as the list shows a match. */
export function marked(text: string, hits: number[]): ReactNode[] {
  const at = new Set(hits);
  const out: ReactNode[] = [];
  let run = '';
  let on = false;
  const flush = (k: number): void => {
    if (!run) return;
    out.push(on ? <mark key={k} className="qo-hit">{run}</mark> : run);
    run = '';
  };
  [...text].forEach((ch, i) => {
    const hit = at.has(i);
    if (hit !== on) {
      flush(i);
      on = hit;
    }
    run += ch;
  });
  flush(text.length);
  return out;
}

export function QuickOpen({ recent, onOpen, onClose }: { recent: string[]; onOpen: (path: string, line?: number) => void; onClose: () => void }) {
  const { t } = useT();
  const [files, setFiles] = useState<string[] | null>(null);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  /** Enter pressed before the files were read: the first match opens as soon as they are. */
  const [enterWaits, setEnterWaits] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    api
      .workspaceFiles()
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]));
  }, []);

  const { query, line } = splitLine(q);
  const found = useMemo((): Array<FuzzyHit & { recent?: boolean }> => {
    if (!files) return [];
    if (!query.trim()) {
      const known = new Set(files);
      const opened = recent.filter((p) => known.has(p));
      const others = files.filter((p) => !opened.includes(p)).slice(0, 50);
      return [...opened.map((p) => ({ path: p, score: 0, nameHits: [], dirHits: [], recent: true })), ...others.map((p) => ({ path: p, score: 0, nameHits: [], dirHits: [] }))];
    }
    return fuzzyFiles(files, query, 60);
  }, [files, query, recent]);
  const active = found.length === 0 ? -1 : Math.min(at, found.length - 1);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const open = (hit: FuzzyHit | undefined): void => {
    if (!hit) return;
    onClose();
    onOpen(hit.path, line);
  };
  useEffect(() => {
    if (enterWaits && files) {
      setEnterWaits(false);
      open(found[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enterWaits, files]);

  return (
    <div className="modal-backdrop qo-backdrop" role="presentation" onClick={onClose}>
      <div className="wb-palette qo" role="dialog" aria-modal="true" aria-label={t('quick.label')} onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="qo-list"
          aria-activedescendant={active >= 0 ? `qo-${active}` : undefined}
          aria-label={t('quick.label')}
          placeholder={t('quick.placeholder')}
          value={q}
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setAt(Math.min(found.length - 1, active + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setAt(Math.max(0, active - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (!files) setEnterWaits(true);
              else open(found[active]);
            }
          }}
        />
        <ul id="qo-list" ref={list} role="listbox" aria-label={t('quick.label')}>
          {files && found.length === 0 && <li className="muted small qo-none">{t('quick.none')}</li>}
          {found.map((hit, i) => {
            const slash = hit.path.lastIndexOf('/');
            const name = hit.path.slice(slash + 1);
            const dir = slash >= 0 ? hit.path.slice(0, slash) : '';
            return (
              <li key={hit.path} id={`qo-${i}`} role="option" aria-selected={i === active} className={`qo-row${i === active ? ' on' : ''}`} onMouseEnter={() => setAt(i)} onClick={() => open(hit)} title={hit.path}>
                <FileIcon path={hit.path} />
                <span className="qo-name">{marked(name, hit.nameHits)}</span>
                {dir && <span className="qo-dir">{marked(dir, hit.dirHits)}</span>}
                {'recent' in hit && hit.recent && <span className="qo-tag">{t('quick.recent')}</span>}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
