import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata = {
  title: 'copilot-operator',
  description: 'Runs task loops with Microsoft 365 Copilot on this machine.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          <header className="top">
            <h1>
              <Link href="/">copilot-operator</Link>
            </h1>
            <nav>
              <Link href="/">Sessions</Link>
              <Link href="/level1">Level 1 contract</Link>
              <Link href="/presets">Level 2 presets</Link>
              <Link href="/system">System</Link>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
