'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** How close to the bottom still counts as "at the bottom", so a pixel of rounding does not stop it. */
const SLACK_PX = 24;
/** Room left above a card that waits for the operator, so its edge is not flush with the top. */
const CARD_MARGIN_PX = 12;

/**
 * Keeps a scrolling element at its bottom while what is in it grows, the way a terminal does.
 *
 * Only while the reader is at the bottom. Scrolling up to read something stops the following —
 * a view that snapped back every two seconds would make the older lines unreadable, which is the
 * one thing a person scrolls up for — and scrolling back down to the end starts it again, as
 * does `follow()`, which is what a "jump to the newest" button calls.
 *
 * Whatever makes it grow keeps it there (operator, 2026-10-27: "the chat scrolls down by itself; opening 'The subtasks
 * in the plan' must not change that, we keep seeing the latest"): a new line, a command's output, a fold opened
 * anywhere in it. Its children are watched for their size, so nothing has to say that it grew; `content` still moves
 * it when it changes. Only a scroll up by the reader stops the following: a fold opened or closed moves nothing by
 * itself, and the element's own moves are told apart from the reader's by where they left it.
 *
 * A card that waits for the operator — anything in it marked `data-awaits` (2026-10-27: "if the bot asks something,
 * the chat moves to the question, wherever the user had scrolled") — is brought into view when it appears, whether
 * the reader was following or had scrolled up; and while it waits, following keeps its top in view rather than going
 * past it to the very bottom.
 *
 * The element is moved after the DOM has the new content and before it is painted, so the reader never sees the jump.
 * The element is taken through a callback ref because the ones this is used on appear only once their data has
 * arrived, after the component using the hook has already mounted.
 */
export function useFollowBottom<T extends HTMLElement>(active: boolean, content: unknown): {
  ref: (el: T | null) => void;
  following: boolean;
  follow: () => void;
} {
  const [el, setEl] = useState<T | null>(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  /** Where the element's own last move left it, until the scroll that move makes is seen. */
  const ours = useRef<number | null>(null);
  const lastTop = useRef(0);
  const seen = useRef(new Set<string>());
  const ref = useCallback((node: T | null) => setEl(node), []);

  const setFollow = useCallback((on: boolean) => {
    if (followingRef.current === on) return;
    followingRef.current = on;
    setFollowing(on);
  }, []);

  /** The scrollTop at which `card` is shown: its top a little below the element's, or centred when it fits. */
  const cardTop = (node: T, card: HTMLElement, centred: boolean): number => {
    const top = card.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
    const room = node.clientHeight - card.offsetHeight;
    return centred && room > 2 * CARD_MARGIN_PX ? top - room / 2 : top - CARD_MARGIN_PX;
  };
  const moveTo = (node: T, top: number): void => {
    const bottom = node.scrollHeight - node.clientHeight;
    node.scrollTop = Math.max(0, Math.min(bottom, top));
    ours.current = node.scrollTop;
    lastTop.current = node.scrollTop;
  };
  /** The bottom; or, while a card in it waits, as far down as still shows the top of the first one. */
  const stick = (node: T): void => {
    const waiting = node.querySelector<HTMLElement>('[data-awaits]');
    const bottom = node.scrollHeight - node.clientHeight;
    moveTo(node, waiting ? Math.min(bottom, cardTop(node, waiting, false)) : bottom);
  };
  /**
   * A card that waits and was not here before: brought into view. Not while the element is hidden (the chat's panel
   * closed): there is nothing to show it in, and it is brought when the panel is shown.
   */
  const bringNewCard = (node: T): boolean => {
    if (node.clientHeight === 0) return false;
    const cards = [...node.querySelectorAll<HTMLElement>('[data-awaits]')];
    const fresh = cards.filter((c) => !seen.current.has(c.dataset.awaits ?? ''));
    for (const c of cards) seen.current.add(c.dataset.awaits ?? '');
    const card = fresh[0];
    if (!card) return false;
    if (followingRef.current) stick(node);
    else moveTo(node, cardTop(node, card, true));
    return true;
  };

  useLayoutEffect(() => {
    if (!el) return;
    el.dataset.follow = '';
    lastTop.current = el.scrollTop;
    const onScroll = (): void => {
      const top = el.scrollTop;
      const atBottom = el.scrollHeight - top - el.clientHeight <= SLACK_PX;
      const mine = ours.current !== null && Math.abs(top - ours.current) <= 1;
      ours.current = null;
      if (atBottom) setFollow(true);
      // Up, and not by the element's own move: the reader went back to read.
      else if (!mine && top < lastTop.current - 1) setFollow(false);
      lastTop.current = top;
    };
    const grew = (): void => {
      if (!activeRef.current) return;
      if (bringNewCard(el)) return;
      if (followingRef.current) stick(el);
    };
    // Every child's size, and the element's own: a line added, a fold opened, the panel made taller.
    const sizes = new ResizeObserver(grew);
    sizes.observe(el);
    for (const child of el.children) sizes.observe(child);
    const children = new MutationObserver((changes) => {
      for (const change of changes) {
        for (const added of change.addedNodes) if (added instanceof Element && added.parentElement === el) sizes.observe(added);
        for (const gone of change.removedNodes) if (gone instanceof Element) sizes.unobserve(gone);
      }
      grew();
    });
    children.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-awaits'] });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      sizes.disconnect();
      children.disconnect();
      delete el.dataset.follow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, setFollow]);

  useLayoutEffect(() => {
    if (!el || !active) return;
    if (bringNewCard(el)) return;
    if (followingRef.current) stick(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, active, content]);

  const follow = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
    if (el) stick(el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el]);

  return { ref, following, follow };
}
