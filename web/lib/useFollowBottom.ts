'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** How close to the bottom still counts as "at the bottom", so a pixel of rounding does not stop it. */
const SLACK_PX = 24;

/**
 * Keeps a scrolling element at its bottom while what is in it grows, the way a terminal does.
 *
 * Only while the reader is at the bottom. Scrolling up to read something stops the following —
 * a view that snapped back every two seconds would make the older lines unreadable, which is the
 * one thing a person scrolls up for — and scrolling back down to the end starts it again, as
 * does `follow()`, which is what a "jump to the newest" button calls.
 *
 * `content` is whatever changes when the element grows; the element is moved after the DOM has
 * the new content and before it is painted, so the reader never sees the jump. The element is
 * taken through a callback ref because the ones this is used on appear only once their data has
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
  const ref = useCallback((node: T | null) => setEl(node), []);

  useLayoutEffect(() => {
    if (!el) return;
    const onScroll = (): void => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= SLACK_PX;
      followingRef.current = atBottom;
      setFollowing(atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [el]);

  useLayoutEffect(() => {
    if (!el || !active || !followingRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [el, active, content]);

  const follow = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
    if (el) el.scrollTop = el.scrollHeight;
  }, [el]);

  return { ref, following, follow };
}
