/**
 * The marks of the explorer's file icons (`web/app/workbench/fileIcon.tsx`): for each kind of file, the short name
 * or the picture it is shown by, and its colour — kept apart from the drawing so the checks can hold every one of
 * them to the dark theme (`test/file-icons.check.ts`).
 *
 * The colours are the ones each language is known by, a middle tone that reads on the light theme. On the dark one
 * (operator, 2026-10-21: "make the file icons suit the dark theme too — lighter ones for it if need be") the same
 * colour is lifted towards white until it stands out against the dark panels (`darkColor`), so an icon added here
 * gets its dark colour without anyone choosing one.
 */
import { detectLanguage, type LangId } from './highlight';

export type Glyph = 'image' | 'git' | 'lock' | 'gear' | 'archive';
/** `color` is for the light theme; the dark theme's is worked out from it (see `darkColor`). */
export type Mark = { text?: string; glyph?: Glyph; color: string };

const BY_LANG: Partial<Record<LangId, Mark>> = {
  typescript: { text: 'TS', color: '#3178c6' },
  javascript: { text: 'JS', color: '#b89a00' },
  json: { text: '{}', color: '#c48c12' },
  html: { text: '<>', color: '#e34c26' },
  xml: { text: '<>', color: '#e37933' },
  css: { text: '#', color: '#2f6fe0' },
  scss: { text: 'S', color: '#cd6799' },
  markdown: { text: 'M↓', color: '#3f7fbf' },
  powershell: { text: 'PS', color: '#2a7bd0' },
  batch: { text: 'BAT', color: '#7c8a96' },
  shell: { text: '$_', color: '#4a9e22' },
  python: { text: 'PY', color: '#3d7fbf' },
  csharp: { text: 'C#', color: '#9b4dca' },
  java: { text: 'J', color: '#b07219' },
  kotlin: { text: 'K', color: '#7f52ff' },
  go: { text: 'GO', color: '#00a3cc' },
  rust: { text: 'RS', color: '#c4561f' },
  c: { text: 'C', color: '#6f8aa6' },
  cpp: { text: 'C++', color: '#d6336c' },
  swift: { text: 'SW', color: '#f05138' },
  dart: { text: 'DT', color: '#0a85d6' },
  php: { text: 'PHP', color: '#777bb4' },
  ruby: { text: 'RB', color: '#cc342d' },
  lua: { text: 'LUA', color: '#5466d6' },
  sql: { text: 'SQL', color: '#d48a00' },
  yaml: { text: 'Y', color: '#cb3a3a' },
  toml: { text: 'T', color: '#b5562a' },
  ini: { glyph: 'gear', color: '#7c8a96' },
  dockerfile: { text: 'D', color: '#2496ed' },
  makefile: { text: 'MK', color: '#7c8a96' },
  vue: { text: 'V', color: '#3fae7c' },
};

const IMAGE: Mark = { glyph: 'image', color: '#a074c4' };
const ARCHIVE: Mark = { glyph: 'archive', color: '#a07d3e' };
const BY_EXT: Record<string, Mark> = {
  png: IMAGE, jpg: IMAGE, jpeg: IMAGE, gif: IMAGE, webp: IMAGE, ico: IMAGE, bmp: IMAGE,
  svg: { text: 'SVG', color: '#d6922d' },
  pdf: { text: 'PDF', color: '#d03b35' },
  csv: { text: 'CSV', color: '#2e8a55' }, xlsx: { text: 'XLS', color: '#2e8a55' }, docx: { text: 'DOC', color: '#3a6cc0' }, pptx: { text: 'PPT', color: '#d04a26' },
  zip: ARCHIVE, gz: ARCHIVE, '7z': ARCHIVE, tgz: ARCHIVE,
  txt: { text: 'TXT', color: '#7c8a96' }, log: { text: 'LOG', color: '#7c8a96' },
  lock: { glyph: 'lock', color: '#7c8a96' },
  exe: { text: 'EXE', color: '#7c8a96' }, dll: { text: 'DLL', color: '#7c8a96' },
  sln: { text: 'SLN', color: '#9b4dca' }, csproj: { text: 'C#', color: '#9b4dca' },
  tsx: { text: 'TSX', color: '#3178c6' }, jsx: { text: 'JSX', color: '#b89a00' },
};

const GIT: Mark = { glyph: 'git', color: '#f14e32' };
const BY_NAME: Record<string, Mark> = {
  '.gitignore': GIT, '.gitattributes': GIT, '.gitmodules': GIT,
  'package.json': { text: 'npm', color: '#cb3837' }, 'package-lock.json': { text: 'npm', color: '#cb3837' },
  license: { text: '©', color: '#7c8a96' }, 'license.md': { text: '©', color: '#7c8a96' }, 'license.txt': { text: '©', color: '#7c8a96' },
  '.env': { glyph: 'gear', color: '#c49a10' },
};

export function markOf(path: string): Mark | null {
  const name = path.split('/').pop()!.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  if (BY_EXT[ext]) return BY_EXT[ext];
  return BY_LANG[detectLanguage(path)] ?? null;
}

/** Every mark there is, for the checks. */
export const ALL_MARKS: Mark[] = [...Object.values(BY_LANG), ...Object.values(BY_EXT), ...Object.values(BY_NAME)].filter((m): m is Mark => !!m);

/** The dark theme's panels (`--panel` in globals.css), the lightest background an icon sits on there. */
export const DARK_PANEL = '#152436';
/** How far an icon stands out from the dark panels at least: the contrast WCAG asks of text. */
export const DARK_CONTRAST = 4.5;

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
};
const hexOf = ([r, g, b]: [number, number, number]): string => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Relative luminance, as WCAG defines it. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast of two colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const darkCache = new Map<string, string>();

/** A light theme's colour for the dark one: the same hue, mixed with white until it stands out on the dark panels. */
export function darkColor(hex: string): string {
  const known = darkCache.get(hex);
  if (known) return known;
  const base = rgb(hex);
  let out = hexOf(base);
  // A little lighter at least, so even a colour that already stands out keeps its place beside the lifted ones.
  for (let t = 0.12; t <= 1; t += 0.04) {
    out = hexOf(base.map((v) => v + (255 - v) * t) as [number, number, number]);
    if (contrast(out, DARK_PANEL) >= DARK_CONTRAST + 0.3) break;
  }
  darkCache.set(hex, out);
  return out;
}
