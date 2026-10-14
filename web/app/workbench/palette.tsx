'use client';

/**
 * The command palette, on Ctrl+K or Ctrl+Shift+P: every task by its session and title, every session, every page,
 * and the workbench's own commands, found by typing a few letters of any of it. Arrow keys choose, Enter does it,
 * Escape closes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '../../lib/i18n';

export type PaletteCommand = { id: string; label: string; hint?: string; run?: () => void; href?: string };

export function Palette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  const { t } = useT();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => input.current?.focus(), []);

  const found = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => words.every((w) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(w))).slice(0, 60);
  }, [q, commands]);
  // The row chosen, kept inside the list as it narrows: reset with the text that narrows it, not in an effect after,
  // which left Enter pressed straight after typing pointing past the end (found by the browser checks, 2026-10-14).
  const active = found.length === 0 ? -1 : Math.min(at, found.length - 1);

  const run = (c: PaletteCommand | undefined) => {
    if (!c) return;
    onClose();
    if (c.href) router.push(c.href);
    else c.run?.();
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="wb-palette" role="dialog" aria-modal="true" aria-label={t('wb.palette')} onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="wb-palette-list"
          aria-activedescendant={active >= 0 ? `wb-cmd-${active}` : undefined}
          aria-label={t('wb.palette')}
          placeholder={t('wb.palettePlaceholder')}
          value={q}
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
              run(found[active]);
            }
          }}
        />
        <ul id="wb-palette-list" role="listbox" aria-label={t('wb.palette')}>
          {found.length === 0 && <li className="muted small">{t('wb.paletteNone')}</li>}
          {found.map((c, i) => (
            <li key={c.id} id={`wb-cmd-${i}`} role="option" aria-selected={i === active} className={i === active ? 'on' : ''} onMouseEnter={() => setAt(i)} onClick={() => run(c)}>
              <span className="wb-row-name">{c.label}</span>
              {c.hint && <span className="muted small">{c.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
