'use client';

/**
 * Keyboard focus for a modal: in when it opens, kept inside while it is open, back when it closes.
 *
 * The three dialogs of the interface (the shared confirm, the changes view, "Fix the prompt") set
 * `aria-modal`, which tells a screen reader the page behind is out of reach — but Tab still walked
 * out into that page, focus stayed wherever it was when the dialog opened, and closing it left the
 * keyboard user at the top of the document instead of on the button they had pressed. This does
 * what `aria-modal` promises, the same way for all three.
 *
 * `initial` is the element to focus first (the dialog's main button or field); without one, the
 * first focusable element inside the container.
 */
import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalFocus(container: RefObject<HTMLElement | null>, open: boolean, initial?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = container.current;
    const first = initial?.current ?? box?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
    first?.focus();

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !box) return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const head = items[0]!;
      const tail = items[items.length - 1]!;
      const inside = box.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === head || !inside)) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && (document.activeElement === tail || !inside)) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Back to where the operator was, if that is still on the page.
      if (before && document.contains(before)) before.focus();
    };
  }, [container, open, initial]);
}
