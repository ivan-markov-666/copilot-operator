/**
 * Every language of the interface at once, as plain data, for the readers that need them all: the checks, which hold
 * each one to English's keys and placeholders (`test/ui-flows.check.ts`) and the guide to the English and Bulgarian
 * labels (`test/guide.check.ts`).
 *
 * The page does not import this: it has English from the start and loads another language when it is chosen
 * (`i18n.tsx`). Each language is its own file in `lang/`, and the list of them, with how to add one, is
 * `lang/languages.ts`.
 */
import { en } from './lang/en';
import { bg } from './lang/bg';
import { de } from './lang/de';
import { es } from './lang/es';
import { fr } from './lang/fr';
import { pt } from './lang/pt';
import { ja } from './lang/ja';
import { ko } from './lang/ko';
import { ar } from './lang/ar';
import type { Locale } from './lang/languages';
import type { Dictionary, Key } from './lang/types';

export type { Dictionary, Key, Locale };

export const dict: Record<Locale, Dictionary> = { en, bg, de, es, fr, pt, ja, ko, ar };
