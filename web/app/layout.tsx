import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';
import { LanguageProvider } from '../lib/i18n';
import { AppearanceProvider, themeScript } from '../lib/appearance';
import { Nav, SkipLink } from './nav';
import { DialogHost } from './dialog';

export const metadata = {
  title: 'copilot-operator',
  description: 'Runs task loops with Microsoft 365 Copilot on this machine.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The attributes below are the defaults the server can know about. The script in the head
    // replaces them with the reader's own settings before the first paint, which means the
    // markup React hydrates against has already changed. That is the point of it, not a bug,
    // so this element's attributes are exempt from the hydration check. The exemption is one
    // element deep and does not reach the page.
    <html
      lang="en"
      suppressHydrationWarning
      data-theme="light"
      data-textsize="normal"
      data-contrast="normal"
      data-motion="normal"
      data-links="plain"
      data-focus="normal"
    >
      <head>
        {/* Applies the stored theme before the first paint, so there is no flash of the wrong one. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <AppearanceProvider>
          <LanguageProvider>
            <DialogHost>
              <SkipLink />
              <div className="wrap">
                <header className="top">
                  <h1>
                    <Link href="/">copilot-operator</Link>
                  </h1>
                  <Nav />
                </header>
                <main id="main">{children}</main>
              </div>
            </DialogHost>
          </LanguageProvider>
        </AppearanceProvider>
      </body>
    </html>
  );
}
