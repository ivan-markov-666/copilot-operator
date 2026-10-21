'use client';

/**
 * Moving the workbench's panels, as in VS Code (operator, 2026-10-21: "let me move the windows like in VS Code — the
 * chat where 'Open a file from the explorer' is, and that one where the chat was").
 *
 * The three panels — the explorer, the editor with its panel of terminal and problems, and the chat — sit in three
 * places: left, middle and right. Each has a grip in its head: dragged onto another panel, the two swap places;
 * clicked, it opens a menu of the three places, for whoever does not drag. The places keep their sizes (the middle
 * takes what is left), and the order is kept in this browser with the rest of the layout.
 */
import { useT, type Key } from '../../lib/i18n';
import { usePopover } from '../popover';

export type Area = 'side' | 'center' | 'chat';
export const DEFAULT_ORDER: Area[] = ['side', 'center', 'chat'];
/** What a drag carries: only this, so an editor or a text box never takes the drop as text. */
export const AREA_DRAG = 'application/x-cop-area';

/** A stored order, if it is the three panels once each; otherwise the default. */
export function orderOf(value: unknown): Area[] {
  const ok = Array.isArray(value) && value.length === 3 && DEFAULT_ORDER.every((a) => value.includes(a));
  return ok ? (value as Area[]) : DEFAULT_ORDER;
}

/** The order with `area` put in place `to`, and what was there put where `area` was. */
export function movedTo(order: Area[], area: Area, to: number): Area[] {
  const from = order.indexOf(area);
  if (from < 0 || to < 0 || to > 2 || from === to) return order;
  const next = [...order];
  next[from] = order[to]!;
  next[to] = area;
  return next;
}

const PLACES: Key[] = ['wb.moveLeft', 'wb.moveCenter', 'wb.moveRight'];

export function PanelGrip({ name, place, onMove, onDragging }: { name: string; place: number; onMove: (to: number) => void; onDragging: (on: boolean) => void; area: Area }) {
  const { t } = useT();
  // Placed on the screen, not in the panel's head: a head that scrolls (the editor's tabs) would cut the menu off.
  const pop = usePopover('below');
  return (
    <>
      <button
        ref={pop.anchor}
        type="button"
        className="wb-grip"
        draggable
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-controls={pop.open ? pop.id : undefined}
        aria-label={t('wb.move', { name })}
        title={t('wb.moveWhy')}
        onClick={pop.toggle}
        onDragStart={(e) => {
          e.dataTransfer.setData(AREA_DRAG, (e.currentTarget.closest('[data-area]') as HTMLElement | null)?.dataset.area ?? '');
          e.dataTransfer.effectAllowed = 'move';
          pop.close();
          onDragging(true);
        }}
        onDragEnd={() => onDragging(false)}
      >
        <svg viewBox="0 0 10 16" width="8" height="13" aria-hidden="true">
          {[3, 8, 13].map((y) => (
            <g key={y}>
              <circle cx="2.5" cy={y} r="1.4" fill="currentColor" />
              <circle cx="7.5" cy={y} r="1.4" fill="currentColor" />
            </g>
          ))}
        </svg>
      </button>
      {pop.open && (
        <div ref={pop.panel} id={pop.id} role="menu" aria-label={t('wb.move', { name })} className="pop wb-move-menu" style={pop.style}>
          {PLACES.map((label, i) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              disabled={i === place}
              onClick={() => {
                pop.close();
                onMove(i);
              }}
            >
              {t(label)}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
