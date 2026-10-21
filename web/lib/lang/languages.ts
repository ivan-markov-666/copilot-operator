/**
 * The languages of the interface (operator, 2026-10-20: "add German, Spanish, French, Japanese, Korean, Portuguese
 * and Arabic, and make the languages so that new ones are easy to add").
 *
 * To add a language:
 *   1. copy `en.ts` to `<code>.ts` and translate the values (keep the keys, and keep every `{placeholder}`, every
 *      quoted name of another control, and `lang.label`, which is "Language" in every language, as it is);
 *   2. add a row below — its code, its names, its flag (`web/app/flags.tsx`; draw one there if it is new), its
 *      writing direction and the locale its dates are written in;
 *   3. add its line to `load.ts`, which loads it when it is chosen (the page does not build without it);
 *   4. add it to `strings.ts`, where the checks read every language at once.
 * `test/ui-flows.check.ts` then holds it to the same keys and the same placeholders as English.
 *
 * English is in the page from the start; the others are loaded when chosen, so a page does not carry nine languages
 * to show one.
 */
export type FlagId = 'gb' | 'bg' | 'de' | 'es' | 'fr' | 'jp' | 'kr' | 'pt' | 'sa';

export type Language = {
  /** The code it is kept under: in this browser, on the conversation (its window's card), in Kerrigan's file name. */
  code: string;
  /** Its name in English, and in itself. */
  english: string;
  native: string;
  flag: FlagId;
  /** The way it is written: Arabic right to left, the rest left to right. */
  dir: 'ltr' | 'rtl';
  /** The locale dates are written in. */
  dateLocale: string;
};

export const LANGUAGES = [
  { code: 'en', english: 'English', native: 'English', flag: 'gb', dir: 'ltr', dateLocale: 'en-GB' },
  { code: 'bg', english: 'Bulgarian', native: 'Български', flag: 'bg', dir: 'ltr', dateLocale: 'bg-BG' },
  { code: 'de', english: 'German', native: 'Deutsch', flag: 'de', dir: 'ltr', dateLocale: 'de-DE' },
  { code: 'es', english: 'Spanish', native: 'Español', flag: 'es', dir: 'ltr', dateLocale: 'es-ES' },
  { code: 'fr', english: 'French', native: 'Français', flag: 'fr', dir: 'ltr', dateLocale: 'fr-FR' },
  { code: 'pt', english: 'Portuguese', native: 'Português', flag: 'pt', dir: 'ltr', dateLocale: 'pt-PT' },
  { code: 'ja', english: 'Japanese', native: '日本語', flag: 'jp', dir: 'ltr', dateLocale: 'ja-JP' },
  { code: 'ko', english: 'Korean', native: '한국어', flag: 'kr', dir: 'ltr', dateLocale: 'ko-KR' },
  { code: 'ar', english: 'Arabic', native: 'العربية', flag: 'sa', dir: 'rtl', dateLocale: 'ar' },
] as const satisfies readonly Language[];

export type Locale = (typeof LANGUAGES)[number]['code'];

export const languageOf = (code: string): (typeof LANGUAGES)[number] | undefined => LANGUAGES.find((l) => l.code === code);

/** The language a browser asks for, if the interface has it: "de-AT" is German, "pt-BR" Portuguese. */
export function languageFor(asked: string | undefined | null): Locale | null {
  const code = (asked ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return languageOf(code)?.code ?? null;
}
