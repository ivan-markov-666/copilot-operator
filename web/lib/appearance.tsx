'use client';

/**
 * Theme and accessibility, kept in one place because they are the same kind of thing: choices
 * about how the page looks that belong to the person using it, not to the page.
 *
 * Everything is expressed as a `data-` attribute on `<html>` and read back by the stylesheet.
 * That keeps the components free of theme logic and means the whole setting can be applied by
 * a five-line script before the first paint, which is what `themeScript` in ./themeScript is for:
 * without it a dark-theme user sees a white flash on every navigation. The script is kept out of
 * this module because the layout, a server component, needs its text; see that file for why.
 *
 * The settings live in this browser's localStorage. They are personal, they are worthless to
 * anyone else, and the API has no business storing them.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { APPEARANCE_STORAGE_KEY as STORAGE_KEY, TEXT_SIZES, type TextSize } from './themeScript';

export { TEXT_SIZES, type TextSize } from './themeScript';

export type Theme = 'light' | 'dark';

export type Appearance = {
  theme: Theme;
  textSize: TextSize;
  /** Stronger borders, darker text, filled status colours. */
  highContrast: boolean;
  /** No transitions, no auto-scrolling of the live log. */
  reduceMotion: boolean;
  /** Links underlined everywhere, not only on hover. */
  underlineLinks: boolean;
  /** A thick, always-visible outline on whatever has keyboard focus. */
  strongFocus: boolean;
};

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'light',
  textSize: 'normal',
  highContrast: false,
  reduceMotion: false,
  underlineLinks: false,
  strongFocus: false,
};

/**
 * Whatever is in storage, turned into settings this page can show.
 *
 * Storage is the one input here nobody checks: an older version wrote it, a person edited it in the
 * developer tools, another tab wrote half of it. A value this version does not know used to be put
 * on `<html>` as it was, which matched no rule in the stylesheet and pressed no button on the
 * Appearance page — the text looked normal and nothing said so. Each field is taken only when it is
 * one of the values this version knows, and the default stands for the rest.
 */
export function sanitiseAppearance(raw: unknown): Appearance {
  const a = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const flag = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
  return {
    theme: a.theme === 'dark' ? 'dark' : a.theme === 'light' ? 'light' : DEFAULT_APPEARANCE.theme,
    textSize: (TEXT_SIZES as readonly unknown[]).includes(a.textSize) ? (a.textSize as TextSize) : DEFAULT_APPEARANCE.textSize,
    highContrast: flag(a.highContrast, DEFAULT_APPEARANCE.highContrast),
    reduceMotion: flag(a.reduceMotion, DEFAULT_APPEARANCE.reduceMotion),
    underlineLinks: flag(a.underlineLinks, DEFAULT_APPEARANCE.underlineLinks),
    strongFocus: flag(a.strongFocus, DEFAULT_APPEARANCE.strongFocus),
  };
}

function apply(a: Appearance): void {
  const d = document.documentElement;
  d.dataset.theme = a.theme;
  d.dataset.textsize = a.textSize;
  d.dataset.contrast = a.highContrast ? 'high' : 'normal';
  d.dataset.motion = a.reduceMotion ? 'reduced' : 'normal';
  d.dataset.links = a.underlineLinks ? 'underline' : 'plain';
  d.dataset.focus = a.strongFocus ? 'strong' : 'normal';
}

type Ctx = {
  appearance: Appearance;
  set: (patch: Partial<Appearance>) => void;
  reset: () => void;
  /** False until the stored settings have been read, so nothing renders a wrong toggle. */
  loaded: boolean;
};

const AppearanceContext = createContext<Ctx>({
  appearance: DEFAULT_APPEARANCE,
  set: () => undefined,
  reset: () => undefined,
  loaded: false,
});

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let next = DEFAULT_APPEARANCE;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) next = sanitiseAppearance(JSON.parse(raw));
      else if (window.matchMedia('(prefers-color-scheme: dark)').matches) next = { ...next, theme: 'dark' };
      // A person who asked their system for less motion has already answered this question.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches && !raw) next = { ...next, reduceMotion: true };
    } catch {
      /* storage may be unavailable; the defaults stand */
    }
    setAppearance(next);
    apply(next);
    setLoaded(true);
  }, []);

  const set = useCallback((patch: Partial<Appearance>) => {
    setAppearance((prev) => {
      const next = { ...prev, ...patch };
      apply(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setAppearance(DEFAULT_APPEARANCE);
    apply(DEFAULT_APPEARANCE);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  return <AppearanceContext.Provider value={{ appearance, set, reset, loaded }}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): Ctx {
  return useContext(AppearanceContext);
}
