'use client';

/**
 * "Waiting for the user's action" (operator, 2026-10-27: "when a question appears, a big label in the centre, well
 * seen, that needs no button to go away and goes when the user answers the bot; you may even darken the other parts
 * of the screen and leave only the place that waits for the answer").
 *
 * Whatever waits for the operator says so by a `data-awaits` mark with an id of its own: a command to run or skip,
 * a question, a plan, commands handed over to run, a subtask's choices, the model to choose by hand, Git's password
 * window, the banner of steps waiting. While one is on the screen, everything else is darkened, the card is left
 * lit with a ring around it, and the label is over the darkened part, where it covers no card. It darkens and does
 * not block: every click and key still goes where it went, so nothing is trapped behind it. Answered, the card goes
 * and the label with it.
 *
 * A card seen for the first time is brought into view — by its own scroller when that follows its bottom (the chat,
 * `useFollowBottom`), else scrolled to — and given the keyboard's focus, unless the operator is typing somewhere:
 * focus taken from a box mid-word would lose what they type, and a card's button would get their next Enter.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';

type Box = { x: number; y: number; w: number; h: number };
/** Room left lit around a card, inside the darkening. */
const PAD = 6;
/** The label's size, as near as it needs to be known to keep it off the cards. */
const LABEL = { w: 560, h: 110 };

/** Where `el` is seen: its box cut by every box around it that hides what overflows, and by the window. */
function seenBox(el: HTMLElement): Box | null {
  if (el.getClientRects().length === 0) return null;
  const r = el.getBoundingClientRect();
  let [left, top, right, bottom] = [r.left, r.top, r.right, r.bottom];
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = window.getComputedStyle(p);
    if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
    const b = p.getBoundingClientRect();
    [left, top, right, bottom] = [Math.max(left, b.left), Math.max(top, b.top), Math.min(right, b.right), Math.min(bottom, b.bottom)];
  }
  [left, top, right, bottom] = [Math.max(left, 0), Math.max(top, 0), Math.min(right, window.innerWidth), Math.min(bottom, window.innerHeight)];
  return right - left < 4 || bottom - top < 4 ? null : { x: left, y: top, w: right - left, h: bottom - top };
}

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const sameBoxes = (a: Box[], b: Box[]): boolean => a.length === b.length && a.every((x, i) => Math.abs(x.x - b[i]!.x) < 0.5 && Math.abs(x.y - b[i]!.y) < 0.5 && Math.abs(x.w - b[i]!.w) < 0.5 && Math.abs(x.h - b[i]!.h) < 0.5);

/** Where the label goes: the centre of the window, else the middle of the widest stretch of it no card is in. */
function labelPlace(cards: Box[], vw: number, vh: number): CSSProperties {
  const w = Math.min(LABEL.w, vw - 32);
  const at = (x: number, y: number): CSSProperties => ({ left: x, top: y, maxWidth: w });
  const free = (x: number, y: number): boolean => !cards.some((c) => overlaps({ x: x - w / 2, y: y - LABEL.h / 2, w, h: LABEL.h }, { x: c.x - PAD, y: c.y - PAD, w: c.w + 2 * PAD, h: c.h + 2 * PAD }));
  if (free(vw / 2, vh / 2)) return at(vw / 2, vh / 2);
  const left = Math.min(...cards.map((c) => c.x)) - PAD;
  const right = vw - Math.max(...cards.map((c) => c.x + c.w)) - PAD;
  const above = Math.min(...cards.map((c) => c.y)) - PAD;
  const below = vh - Math.max(...cards.map((c) => c.y + c.h)) - PAD;
  const room = [
    { fits: left >= w + 32, size: left, place: () => at(left / 2, vh / 2) },
    { fits: right >= w + 32, size: right, place: () => at(vw - right / 2, vh / 2) },
    { fits: above >= LABEL.h + 32, size: above, place: () => at(vw / 2, above / 2) },
    { fits: below >= LABEL.h + 32, size: below, place: () => at(vw / 2, vh - below / 2) },
  ].filter((r) => r.fits);
  if (room.length > 0) return room.sort((a, b) => b.size - a.size)[0]!.place();
  return at(vw / 2, LABEL.h / 2 + 16);
}

/** Whether the operator is writing somewhere, where taking the focus would lose what they type. */
function typing(): boolean {
  const at = document.activeElement;
  return at instanceof HTMLElement && (at.isContentEditable || at.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select'));
}

export function AwaitingSpotlight() {
  const { t } = useT();
  const [cards, setCards] = useState(0);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [view, setView] = useState({ w: 0, h: 0 });
  const greeted = useRef(new Set<string>());

  useEffect(() => {
    const look = (): void => {
      const shown = [...document.querySelectorAll<HTMLElement>('[data-awaits]')].filter((c) => c.getClientRects().length > 0);
      setCards(shown.length);
      for (const card of shown) {
        const id = card.dataset.awaits ?? '';
        if (greeted.current.has(id)) continue;
        greeted.current.add(id);
        if (!card.closest('[data-follow]')) card.scrollIntoView({ block: 'nearest' });
        if (!typing()) card.focus({ preventScroll: true });
      }
    };
    const watch = new MutationObserver(look);
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-awaits', 'hidden'] });
    look();
    return () => watch.disconnect();
  }, []);

  // While a card waits: where it is, each frame, as it scrolls and as the panels move.
  useEffect(() => {
    if (cards === 0) {
      setBoxes([]);
      return;
    }
    let frame = 0;
    const draw = (): void => {
      const next = [...document.querySelectorAll<HTMLElement>('[data-awaits]')].map(seenBox).filter((b): b is Box => b !== null);
      setBoxes((was) => (sameBoxes(was, next) ? was : next));
      setView((was) => (was.w === window.innerWidth && was.h === window.innerHeight ? was : { w: window.innerWidth, h: window.innerHeight }));
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [cards]);

  if (cards === 0 || typeof document === 'undefined') return null;
  return createPortal(
    <div className="awaiting">
      <svg className="awaiting-dim" width={view.w} height={view.h} aria-hidden="true">
        <defs>
          <mask id="awaiting-holes">
            <rect width="100%" height="100%" fill="white" />
            {boxes.map((b, i) => (
              <rect key={i} x={b.x - PAD} y={b.y - PAD} width={b.w + 2 * PAD} height={b.h + 2 * PAD} rx="12" fill="black" />
            ))}
          </mask>
        </defs>
        <rect className="awaiting-shade" width="100%" height="100%" mask="url(#awaiting-holes)" />
        {boxes.map((b, i) => (
          <rect key={i} className="awaiting-ring" x={b.x - PAD} y={b.y - PAD} width={b.w + 2 * PAD} height={b.h + 2 * PAD} rx="12" />
        ))}
      </svg>
      <p className="awaiting-label" role="status" style={labelPlace(boxes, view.w || window.innerWidth, view.h || window.innerHeight)}>
        <span className="awaiting-dot" aria-hidden="true" />
        {t('awaiting.title')}
      </p>
    </div>,
    document.body,
  );
}
