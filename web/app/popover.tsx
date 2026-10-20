'use client';

/**
 * A panel that opens beside the button that opened it — the "i" of an explanation, Kerrigan's two ways out, the
 * appearance of the page (2026-10-20). Placed on the screen itself rather than inside the button's box, so a panel
 * that scrolls or clips its contents (the panel under the editor, the column of icons) does not cut it off; kept
 * inside the window, and turned to open above when there is no room below. Escape, a click outside it, or the button
 * again close it, and Escape gives the keyboard back to the button.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

const MARGIN = 8;

export function usePopover(place: 'below' | 'right' = 'below') {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  // Measured before it is painted, so it never shows for a moment in the wrong place.
  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: 'hidden' });
      return;
    }
    const a = anchor.current?.getBoundingClientRect();
    const p = panel.current;
    if (!a || !p) return;
    const w = p.offsetWidth;
    const h = p.offsetHeight;
    let left: number;
    let top: number;
    if (place === 'right') {
      left = a.right + 6;
      top = Math.min(a.top, window.innerHeight - h - MARGIN);
    } else {
      left = Math.min(a.left, window.innerWidth - w - MARGIN);
      top = a.bottom + 6 + h > window.innerHeight - MARGIN ? a.top - 6 - h : a.bottom + 6;
    }
    setStyle({ left: Math.max(MARGIN, left), top: Math.max(MARGIN, top) });
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      anchor.current?.focus();
    };
    // A window that changes size moves the button: the panel is closed rather than left where the button was.
    const onResize = (): void => setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  return { open, setOpen, toggle, close, anchor, panel, style, id };
}

/**
 * A small "i" beside something whose name does not say all it does, and the explanation behind it (2026-10-20: "an
 * info icon, and the information behind it, for what the Terminal, the Problems and the Output show exactly, and for
 * what Kerrigan is and how she helps"). A button, not a hover tooltip, so the keyboard and a touch screen reach it.
 * A blank line in the text starts a new paragraph.
 */
export function InfoTip({ label, text }: { label: string; text: string }) {
  const pop = usePopover('below');
  return (
    <>
      <button ref={pop.anchor} type="button" className="info-btn" aria-label={label} title={label} aria-expanded={pop.open} aria-controls={pop.open ? pop.id : undefined} onClick={pop.toggle}>
        i
      </button>
      {pop.open && (
        <div ref={pop.panel} id={pop.id} role="dialog" aria-label={label} className="pop info-pop" style={pop.style}>
          <p className="pop-title">{label}</p>
          {text.split(/\n\s*\n/).map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      )}
    </>
  );
}
