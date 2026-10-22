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
import { StartFailureBanner } from './startFailure';
import { Logo } from './logo';

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/') {
    return (
      <div className="wb-root">
        <GlobalApprovals />
        <StartFailureBanner />
        <main id="main" className="wb-main">
          {children}
        </main>
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
      <main id="main">{children}</main>
    </div>
  );
}
