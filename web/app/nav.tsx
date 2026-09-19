'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api } from '../lib/api';
import { LanguageSwitcher, useT, type Key } from '../lib/i18n';
import { useAppearance } from '../lib/appearance';

const LINKS: Array<{ href: string; label: Key }> = [
  { href: '/', label: 'nav.sessions' },
  { href: '/defaults', label: 'nav.defaults' },
  { href: '/import', label: 'nav.import' },
  { href: '/history', label: 'nav.history' },
  { href: '/level1', label: 'nav.level1' },
  { href: '/presets', label: 'nav.presets' },
  { href: '/appearance', label: 'nav.appearance' },
  { href: '/system', label: 'nav.system' },
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
          {t(l.label)}
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
      <ThemeToggle />
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

/** The one appearance control worth having on every page; the rest live on their own page. */
export function ThemeToggle() {
  const { t } = useT();
  const { appearance, set, loaded } = useAppearance();
  const dark = appearance.theme === 'dark';
  return (
    <button
      type="button"
      className="quiet"
      onClick={() => set({ theme: dark ? 'light' : 'dark' })}
      aria-pressed={dark}
      title={t(dark ? 'theme.toLight' : 'theme.toDark')}
    >
      <span aria-hidden="true">{loaded && dark ? '☀' : '☾'}</span>{' '}
      <span className="small">{t(dark ? 'theme.light' : 'theme.dark')}</span>
    </button>
  );
}
