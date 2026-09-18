import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';
import { LanguageProvider } from '../lib/i18n';
import { Nav } from './nav';

export const metadata = {
  title: 'copilot-operator',
  description: 'Runs task loops with Microsoft 365 Copilot on this machine.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <LanguageProvider>
          <div className="wrap">
            <header className="top">
              <h1>
                <Link href="/">copilot-operator</Link>
              </h1>
              <Nav />
            </header>
            {children}
          </div>
        </LanguageProvider>
      </body>
    </html>
  );
}
