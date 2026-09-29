'use client';

/**
 * Two buttons at the right edge — to the top, to the bottom — on a page long enough to need them.
 *
 * The register is the page this was asked for: a run of many tasks, each with its summary and a
 * story that can be opened, grows to many screens, and the controls that matter are at both
 * ends — "Continue" and the filters at the top, the newest work at the bottom. It sits in the
 * layout rather than on that one page because every page that grows that long has the same
 * problem, and one that does not grow shows nothing: the buttons appear only when the page is
 * more than two screens tall, and each only when there is somewhere for it to go.
 */
import { useEffect, useState } from 'react';

import { useT } from '../lib/i18n';

/** How far from an end still counts as being there. */
const NEAR_PX = 200;

export function ScrollJump() {
  const { t } = useT();
  const [where, setWhere] = useState({ long: false, atTop: true, atBottom: false });

  useEffect(() => {
    const read = (): void => {
      const doc = document.documentElement;
      setWhere({
        long: doc.scrollHeight > window.innerHeight * 2,
        atTop: window.scrollY < NEAR_PX,
        atBottom: window.innerHeight + window.scrollY >= doc.scrollHeight - NEAR_PX,
      });
    };
    read();
    window.addEventListener('scroll', read, { passive: true });
    window.addEventListener('resize', read);
    // The page grows without a scroll or a resize — a story opened, a run's rows arriving.
    const grows = new ResizeObserver(read);
    grows.observe(document.body);
    return () => {
      window.removeEventListener('scroll', read);
      window.removeEventListener('resize', read);
      grows.disconnect();
    };
  }, []);

  if (!where.long) return null;
  return (
    <div className="scroll-jump">
      {!where.atTop && (
        <button type="button" aria-label={t('scroll.top')} title={t('scroll.top')} onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
          ↑
        </button>
      )}
      {!where.atBottom && (
        <button
          type="button"
          aria-label={t('scroll.bottom')}
          title={t('scroll.bottom')}
          onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })}
        >
          ↓
        </button>
      )}
    </div>
  );
}
