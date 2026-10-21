'use client';

/**
 * "Language" (operator, 2026-10-20): "add the countries' flags where the language is; do not show the language
 * chosen, show the text Language, always in English". The button reads "Language" in every language — someone who
 * cannot read the one on screen still finds the way back — and opens the list, each language with its flag and its
 * own name, the one in use ticked.
 */
import { LANGUAGES } from '../lib/lang/languages';
import { useLocale, useT } from '../lib/i18n';
import { Flag } from './flags';
import { usePopover } from './popover';

export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale();
  const { t } = useT();
  const pop = usePopover('below');
  return (
    <span className="lang-menu">
      <button
        ref={pop.anchor}
        type="button"
        className="lang-btn"
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-controls={pop.open ? pop.id : undefined}
        onClick={pop.toggle}
        title={t('lang.menu')}
      >
        <svg className="lang-globe" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M1.5 8h13M8 1.5c2 2 2.8 4 2.8 6.5S10 12.5 8 14.5M8 1.5C6 3.5 5.2 5.5 5.2 8S6 12.5 8 14.5" fill="none" stroke="currentColor" strokeWidth="1.1" />
        </svg>
        <span lang="en">{t('lang.label')}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {pop.open && (
        <div ref={pop.panel} id={pop.id} role="menu" aria-label={t('lang.menu')} className="pop menu lang-list" style={pop.style}>
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              role="menuitemradio"
              aria-checked={l.code === locale}
              onClick={() => {
                setLocale(l.code);
                pop.close();
              }}
            >
              <Flag id={l.flag} />
              <span className="lang-native" lang={l.code} dir={l.dir}>
                {l.native}
              </span>
              {l.code !== 'en' && (
                <span className="lang-english muted small" lang="en">
                  {l.english}
                </span>
              )}
              <span className="lang-tick" aria-hidden="true">
                {l.code === locale ? '✓' : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
