'use client';

/**
 * UI language: chosen from the "Language" menu, remembered per browser.
 *
 * Only the interface is translated. Level 1, level 2 and the tasks go to Copilot exactly as
 * written by the user, in whatever language they chose; the contract itself stays English
 * because that is what the parser and the persona were verified against.
 *
 * The languages are listed in `lang/languages.ts`, each in its own file (2026-10-20: nine of them, and "easy to add
 * new ones"). English is in the page from the start and is what any missing text falls back to; another language is
 * loaded when it is chosen, and the page goes on in English until it has arrived. Arabic is written right to left:
 * the page's `dir` follows the language.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { en } from './lang/en';
import { languageFor, languageOf, type Locale } from './lang/languages';
import { LOADERS } from './lang/load';
import type { Dictionary, Key } from './lang/types';

export type { Key } from './lang/types';
export type { Locale } from './lang/languages';

const STORAGE_KEY = 'cop.locale';
const ENGLISH = en as Dictionary;

type Ctx = { locale: Locale; setLocale: (l: Locale) => void; table: Dictionary };
const LocaleContext = createContext<Ctx>({ locale: 'en', setLocale: () => undefined, table: ENGLISH });

/** The page's language and writing direction, which a screen reader and the layout read. */
function markPage(code: Locale): void {
  document.documentElement.lang = code;
  document.documentElement.dir = languageOf(code)?.dir ?? 'ltr';
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');
  const [table, setTable] = useState<Dictionary>(ENGLISH);
  /** The languages loaded so far, so going back to one does not load it again. */
  const loaded = useRef<Partial<Record<Locale, Dictionary>>>({ en: ENGLISH });
  /** The language asked for last: a slow load that arrives after a later choice is not applied. */
  const wanted = useRef<Locale>('en');

  const apply = useCallback(async (code: Locale): Promise<void> => {
    wanted.current = code;
    let dict = loaded.current[code];
    if (!dict) {
      try {
        dict = await (LOADERS[code] ?? LOADERS.en)();
        loaded.current[code] = dict;
      } catch {
        // Not loaded (the bot updated under the page, a network hiccup): the page stays as it is.
        return;
      }
    }
    if (wanted.current !== code) return;
    setTable(dict);
    setLocaleState(code);
    markPage(code);
  }, []);

  useEffect(() => {
    let next: Locale = 'en';
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      next = languageFor(saved) ?? languageFor(navigator.language) ?? 'en';
    } catch {
      /* storage may be unavailable; the browser's language, or English */
      next = languageFor(navigator.language) ?? 'en';
    }
    // The markup says lang="en" because that is all the server can know; the saved language is put on it here.
    void apply(next);
  }, [apply]);

  const setLocale = (l: Locale) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
    void apply(l);
  };

  return <LocaleContext.Provider value={{ locale, setLocale, table }}>{children}</LocaleContext.Provider>;
}

/** `t('key', { n: 3 })` — looks the key up in the current language, English as fallback. */
export function useT() {
  const { locale, table } = useContext(LocaleContext);
  const t = (key: Key, vars: Record<string, string | number> = {}): string => {
    let s = table[key] ?? ENGLISH[key] ?? key;
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
  return { t, locale };
}

export function useLocale(): Ctx {
  return useContext(LocaleContext);
}

/** Dates in the chosen language's conventions. */
export function useFmtTime() {
  const { locale } = useContext(LocaleContext);
  return (iso?: string): string => {
    if (!iso) return '';
    return new Date(iso).toLocaleString(languageOf(locale)?.dateLocale, { hour12: false });
  };
}
