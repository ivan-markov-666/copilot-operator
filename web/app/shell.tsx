'use client';

/**
 * The frame around every page. The workbench at `/` (2026-10-14) takes the whole window, as an IDE does — its own
 * bar on top, its own status bar below — so it gets no header or navigation of the page kind; every other page
 * keeps the column it has always had. The approvals banner and a start that could not begin are shown on both:
 * whatever screen the operator is on, a step waiting for them is asked about there.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Nav } from './nav';
import { GlobalApprovals } from './approvals';
import { AwaitingSpotlight } from './awaiting';
import { SettingsTakenNotice } from './settingsTaken';
import { DoneLabel } from './doneLabel';
import { StartFailureBanner } from './startFailure';
import { LocatorFailureBanner } from './locatorFailure';
import { Logo } from './logo';
import { ErrorBoundary } from './errorBoundary';

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/') {
    return (
      <div className="wb-root">
        <GlobalApprovals />
        <StartFailureBanner />
        <LocatorFailureBanner />
        <main id="main" className="wb-main">
          <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
        </main>
        {/* What waits for the operator, lit, the rest darkened (2026-10-27). */}
        <AwaitingSpotlight />
        {/* What a setting saved while work goes on did to it, and "Done" once the work is over (2026-11-03). */}
        <SettingsTakenNotice />
        <DoneLabel />
      </div>
    );
  }
  return (
    <div className="wrap">
      <header className="top">
        <h1>
          <Link href="/" className="brand-link">
            <Logo />
            copilot-operator
          </Link>
        </h1>
        <Nav />
      </header>
      {/* Whatever page is open, a step waiting for a decision is asked about here. */}
      <GlobalApprovals />
      {/* And a run that was accepted and then could not begin, with what happened as a file. */}
      <StartFailureBanner />
      {/* And a locator of the chat that found nothing, with the way to its field in Settings (2026-11-17). */}
      <LocatorFailureBanner />
      <main id="main">
        <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
      </main>
      <AwaitingSpotlight />
      <SettingsTakenNotice />
      <DoneLabel />
    </div>
  );
}
