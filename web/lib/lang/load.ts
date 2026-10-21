/**
 * Each language's words, loaded when the language is chosen (`i18n.tsx`): the page's part of the list in
 * `languages.ts`, kept apart from it because the checks read the list and these imports are resolved by the page's
 * bundler only. A language of the list with no line here does not build.
 */
import type { Locale } from './languages';
import type { Dictionary } from './types';

export const LOADERS: Record<Locale, () => Promise<Dictionary>> = {
  en: () => import('./en').then((m) => m.en as Dictionary),
  bg: () => import('./bg').then((m) => m.bg),
  de: () => import('./de').then((m) => m.de),
  es: () => import('./es').then((m) => m.es),
  fr: () => import('./fr').then((m) => m.fr),
  pt: () => import('./pt').then((m) => m.pt),
  ja: () => import('./ja').then((m) => m.ja),
  ko: () => import('./ko').then((m) => m.ko),
  ar: () => import('./ar').then((m) => m.ar),
};
