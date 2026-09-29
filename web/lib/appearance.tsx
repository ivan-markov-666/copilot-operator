'use client';

/**
 * Theme and accessibility, kept in one place because they are the same kind of thing: choices
 * about how the page looks that belong to the person using it, not to the page.
 *
 * Everything is expressed as a `data-` attribute on `<html>` and read back by the stylesheet.
 * That keeps the components free of theme logic and means the whole setting can be applied by
 * a five-line script before the first paint, which is what `themeScript` below is for: without
 * it a dark-theme user sees a white flash on every navigation.
 *
 * The settings live in this browser's localStorage. They are personal, they are worthless to
 * anyone else, and the API has no business storing them.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';

/**
 * The text sizes, smallest first: one step below normal and three above it.
 *
 * The names are what is stored, so they never change meaning: `large` and `huge` were the only two
 * steps above normal until 2026-09-29 and a browser that saved one of them must still land on the
 * same size. New steps got new names (`small`, `giant`) rather than renumbering the old ones. The
 * factor for each lives in globals.css, beside the rest of the scale.
 */
export const TEXT_SIZES = ['small', 'normal', 'large', 'huge', 'giant'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

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

const STORAGE_KEY = 'cop.appearance';

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

/**
 * Runs before React, inline in the document head. Anything it cannot do — bad json, no
 * storage — leaves the defaults in the markup, which are already correct.
 */
export const themeScript = `
(function () {
  try {
    var d = document.documentElement;
    var raw = localStorage.getItem('${STORAGE_KEY}');
    var a = raw ? JSON.parse(raw) : {};
    if (!a || typeof a !== 'object') a = {};
    d.dataset.theme = a.theme === 'dark' ? 'dark' : 'light';
    d.dataset.textsize = ${JSON.stringify(TEXT_SIZES)}.indexOf(a.textSize) >= 0 ? a.textSize : 'normal';
    d.dataset.contrast = a.highContrast ? 'high' : 'normal';
    d.dataset.motion = a.reduceMotion ? 'reduced' : 'normal';
    d.dataset.links = a.underlineLinks ? 'underline' : 'plain';
    d.dataset.focus = a.strongFocus ? 'strong' : 'normal';
  } catch (e) {}
})();
`;

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
