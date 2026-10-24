'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api } from '../lib/api';
import { usePoll } from '../lib/usePoll';
import { useT, type Key } from '../lib/i18n';
import { LanguageSwitcher } from './languageMenu';
import { AppearanceMenu } from './workbench/appearanceMenu';

/**
 * One small line icon per page, drawn inline so they take the current colour and need no
 * font. They are recognition aids next to the label, never the label itself: at phone width
 * the label is what stays readable.
 */
const ICONS: Record<string, ReactNode> = {
  workbench: <path d="M4 5h16v11H9l-5 4zM8 9h8M8 12h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />,
  defaults: <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.5 4 1.5 1-1.6 2.8-1.8-.4a7 7 0 0 1-1.5 1.5l.4 1.8L14.7 21l-1-1.5a7 7 0 0 1-3.4 0l-1 1.5-2.8-1.6.4-1.8A7 7 0 0 1 5.4 16l-1.8.4L2 13.6 3.5 12.6V11.4L2 10.4l1.6-2.8 1.8.4A7 7 0 0 1 6.9 6.5l-.4-1.8L9.3 3l1 1.5a7 7 0 0 1 3.4 0l1-1.5 2.8 1.6-.4 1.8a7 7 0 0 1 1.5 1.5l1.8-.4L22 10.4l-1.5 1z" />,
  system: <path d="M4 5h16v10H4zM2 19h20M9 15v4M15 15v4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />,
  queue: <path d="M4 6h16M4 12h16M4 18h10M17 16l3 2-3 2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />,
};

/*
 * The chat, Settings and System (operator, 2026-10-20). The base prompt's page went (it changes only with the bot, and
 * Settings shows it to read), and so did the presets' (each project carries its level 2 in Settings now) and the
 * Appearance page (the menu at the foot of the chat's left column does all of it).
 */
const LINKS: Array<{ href: string; label: Key; icon: keyof typeof ICONS }> = [
  { href: '/', label: 'nav.workbench', icon: 'workbench' },
  // The queue of tasks (2026-10-24): prepared beforehand, run one after another while nobody watches.
  { href: '/queue', label: 'nav.queue', icon: 'queue' },
  { href: '/settings', label: 'nav.defaults', icon: 'defaults' },
  { href: '/system', label: 'nav.system', icon: 'system' },
];

/**
 * "Appearance" and "Language", one item of the bar (operator, 2026-10-24: "always on one line together — if they go to
 * the line below, they go together — unless there is not room for both"): a narrower window wraps them to the next line
 * as one, and they part only when one line cannot hold the two.
 */
export function NavPair() {
  return (
    <span className="nav-pair">
      <AppearanceMenu />
      <LanguageSwitcher />
    </span>
  );
}

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
      {LINKS.flatMap((l) => [
        <Link key={l.href} href={l.href} aria-current={pathname === l.href ? 'page' : undefined}>
          <svg className="nav-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
            {ICONS[l.icon]}
          </svg>
          <span>{t(l.label)}</span>
          {/*
           * The one place in the app that says "something is happening" without being asked. It sits on the workbench,
           * where the chat is watched (the task register it sat on went on 2026-10-20), and it is on the nav rather
           * than the page because the whole point is to be visible from wherever you happen to be standing.
           */}
          {l.href === '/' && running > 0 && (
            <span className="live" title={t('nav.liveTitle', { n: running })}>
              <span className="dot" aria-hidden="true" />
              {t('nav.live')}
            </span>
          )}
        </Link>,
      ])}
      {/* How the page looks, after System and before the language, as on the chat's screen (operator, 2026-10-22). */}
      <NavPair />
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

  usePoll(
    () =>
      api
        .activity()
        .then((a) => setRunning(a.sessions))
        .catch(() => undefined),
    4000,
  );

  return running;
}
