'use client';

/**
 * UI language: English and Bulgarian, switchable from the header and remembered per browser.
 *
 * Only the interface is translated. Level 1, level 2 and the tasks go to Copilot exactly as
 * written by the user, in whatever language they chose; the contract itself stays English
 * because that is what the parser and the persona were verified against.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { dict, type Key, type Locale } from './strings';

export type { Locale, Key } from './strings';

const STORAGE_KEY = 'cop.locale';

type Ctx = { locale: Locale; setLocale: (l: Locale) => void };
const LocaleContext = createContext<Ctx>({ locale: 'en', setLocale: () => undefined });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');

  useEffect(() => {
    let next: Locale = 'en';
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY) as Locale | null;
      if (saved === 'en' || saved === 'bg') next = saved;
      else if (navigator.language.toLowerCase().startsWith('bg')) next = 'bg';
    } catch {
      /* storage may be unavailable; English stays */
    }
    setLocaleState(next);
    // The markup says lang="en" because that is all the server can know. A reader whose saved
    // language is Bulgarian needs the attribute to say so too, or a screen reader pronounces
    // the page in the wrong language.
    document.documentElement.lang = next;
  }, []);

  const setLocale = (l: Locale) => {
    setLocaleState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = l;
  };

  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>;
}

/** `t('key', { n: 3 })` — looks the key up in the current language, English as fallback. */
export function useT() {
  const { locale } = useContext(LocaleContext);
  const t = (key: Key, vars: Record<string, string | number> = {}): string => {
    const table = dict[locale] as Record<string, string>;
    let s = table[key] ?? (dict.en as Record<string, string>)[key] ?? key;
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
  return { t, locale };
}

export function useLocale(): Ctx {
  return useContext(LocaleContext);
}

export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale();
  const { t } = useT();
  return (
    <select aria-label={t('lang.label')} value={locale} onChange={(e) => setLocale(e.target.value as Locale)} style={{ width: 'auto' }}>
      <option value="en">English</option>
      <option value="bg">Български</option>
    </select>
  );
}

/** Dates in the chosen language's conventions. */
export function useFmtTime() {
  const { locale } = useContext(LocaleContext);
  return (iso?: string): string => {
    if (!iso) return '';
    return new Date(iso).toLocaleString(locale === 'bg' ? 'bg-BG' : undefined, { hour12: false });
  };
}
