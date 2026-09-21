'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api } from '../lib/api';
import { LanguageSwitcher, useT, type Key } from '../lib/i18n';

/**
 * One small line icon per page, drawn inline so they take the current colour and need no
 * font. They are recognition aids next to the label, never the label itself: at phone width
 * the label is what stays readable.
 */
const ICONS: Record<string, ReactNode> = {
  sessions: <path d="M4 5h16v4H4zM4 11h16v4H4zM4 17h10v2H4z" />,
  defaults: <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.5 4 1.5 1-1.6 2.8-1.8-.4a7 7 0 0 1-1.5 1.5l.4 1.8L14.7 21l-1-1.5a7 7 0 0 1-3.4 0l-1 1.5-2.8-1.6.4-1.8A7 7 0 0 1 5.4 16l-1.8.4L2 13.6 3.5 12.6V11.4L2 10.4l1.6-2.8 1.8.4A7 7 0 0 1 6.9 6.5l-.4-1.8L9.3 3l1 1.5a7 7 0 0 1 3.4 0l1-1.5 2.8 1.6-.4 1.8a7 7 0 0 1 1.5 1.5l1.8-.4L22 10.4l-1.5 1z" />,
  import: <path d="M12 3v10m0 0 4-4m-4 4-4-4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  history: <path d="M12 3a9 9 0 1 0 8.5 6M12 7v5l3 2M3 4v5h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  level1: <path d="M6 3h9l5 5v13H6zM14 3v6h6M9 13h7M9 17h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />,
  presets: <path d="M5 4h14v4H5zM5 10h14v4H5zM5 16h9v4H5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />,
  appearance: <path d="M12 3a9 9 0 0 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5S14 15 15.5 15H17a4 4 0 0 0 4-4 8 8 0 0 0-9-8zM8 9a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm4-3a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm4 3a1 1 0 1 0 0 2 1 1 0 0 0 0-2z" />,
  system: <path d="M4 5h16v10H4zM2 19h20M9 15v4M15 15v4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />,
};

const LINKS: Array<{ href: string; label: Key; icon: keyof typeof ICONS }> = [
  { href: '/', label: 'nav.sessions', icon: 'sessions' },
  { href: '/defaults', label: 'nav.defaults', icon: 'defaults' },
  { href: '/import', label: 'nav.import', icon: 'import' },
  { href: '/history', label: 'nav.history', icon: 'history' },
  { href: '/level1', label: 'nav.level1', icon: 'level1' },
  { href: '/presets', label: 'nav.presets', icon: 'presets' },
  { href: '/appearance', label: 'nav.appearance', icon: 'appearance' },
  { href: '/system', label: 'nav.system', icon: 'system' },
];

export function SkipLink() {
  const { t } = useT();
  return (
    <a className="skip-link" href="#main">
      {t('a11y.skip')}
    </a>
  );
}

export function Nav() {
  const { t } = useT();
  const pathname = usePathname();
  const running = useRunning();

  return (
    <nav aria-label={t('nav.label')}>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={pathname === l.href ? 'page' : undefined}>
          <svg className="nav-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            {ICONS[l.icon]}
          </svg>
          <span>{t(l.label)}</span>
          {/*
           * The one place in the app that says "something is happening" without being asked.
           * It sits on the register because the register is where you go to watch it, and it
           * is on the nav rather than the page because the whole point is to be visible from
           * wherever you happen to be standing.
           */}
          {l.href === '/history' && running > 0 && (
            <span className="live" title={t('nav.liveTitle', { n: running })}>
              <span className="dot" aria-hidden="true" />
              {t('nav.live')}
            </span>
          )}
        </Link>
      ))}
      {/* Light or dark is chosen on the Appearance page, with the rest of the reading settings. */}
      <LanguageSwitcher />
    </nav>
  );
}

/**
 * How many sessions are running, refreshed on a timer.
 *
 * Four seconds, and a request that reads nothing from disk: it has to be quick enough that the
 * badge appears when a run starts and cheap enough to be asked from every page in the app.
 * Failures are swallowed on purpose — a nav bar that shows an error because a poll missed is
 * worse than a nav bar whose badge is a few seconds stale.
 */
function useRunning(): number {
  const [running, setRunning] = useState(0);

  useEffect(() => {
    let live = true;
    const read = () =>
      api
        .activity()
        .then((a) => {
          if (live) setRunning(a.sessions);
        })
        .catch(() => undefined);
    void read();
    const timer = setInterval(read, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  return running;
}
