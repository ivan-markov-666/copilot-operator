'use client';

/**
 * An icon per kind of file, as an IDE's explorer has (2026-10-20: "icons for the different program files"): the
 * language's short name — TS, JS, {}, #, <>, PS, PY… — in the colour it is known by, a small picture for the kinds
 * that have one (an image, git, a lock file, settings), and a plain sheet for anything else. Drawn here, so there is
 * nothing to download and it follows the text size.
 *
 * No frame (operator, 2026-10-20: "the icons do not differ when small; drop the square, keep only the text, or only
 * the picture"): the coloured squares all looked alike at 15 px, and the letters in them were too small to read. The
 * letters now fill the icon, and each colour is a middle tone, readable on the light theme and on the dark one.
 */
import { detectLanguage, type LangId } from '../../lib/highlight';

type Glyph = 'image' | 'git' | 'lock' | 'gear' | 'archive';
type Mark = { text?: string; glyph?: Glyph; color: string };

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

function markOf(path: string): Mark | null {
  const name = path.split('/').pop()!.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  if (BY_EXT[ext]) return BY_EXT[ext];
  return BY_LANG[detectLanguage(path)] ?? null;
}

/** The pictures, in a 16 × 16 box, drawn in the mark's colour. */
function GlyphPaths({ glyph }: { glyph: Glyph }) {
  switch (glyph) {
    case 'image':
      return (
        <>
          <circle cx="11" cy="4.5" r="1.8" fill="currentColor" />
          <path d="M1 14 6 7l3.5 4.5L11.5 9 15 14z" fill="currentColor" />
        </>
      );
    case 'git':
      return (
        <>
          <path d="M4.5 3v10M4.5 9.5c0-2.5 7-2 7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="4.5" cy="3" r="1.9" fill="currentColor" />
          <circle cx="4.5" cy="13" r="1.9" fill="currentColor" />
          <circle cx="11.5" cy="4.5" r="1.9" fill="currentColor" />
        </>
      );
    case 'lock':
      return (
        <>
          <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <rect x="3" y="7" width="10" height="8" rx="1.5" fill="currentColor" />
        </>
      );
    case 'gear':
      return (
        <path
          d="M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM7 1h2l.4 1.9 1.3.6 1.7-1 1.4 1.4-1 1.7.6 1.3L15 7v2l-1.9.4-.6 1.3 1 1.7-1.4 1.4-1.7-1-1.3.6L9 15H7l-.4-1.9-1.3-.6-1.7 1-1.4-1.4 1-1.7-.6-1.3L1 9V7l1.9-.4.6-1.3-1-1.7 1.4-1.4 1.7 1 1.3-.6z"
          fill="currentColor"
          fillRule="evenodd"
        />
      );
    case 'archive':
      return (
        <>
          <path d="M2 4h12v10H2z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M8 4v1.5M8 7v1.5M8 10v1.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M1.5 1.5h13V4h-13z" fill="currentColor" />
        </>
      );
  }
}

export function FileIcon({ path }: { path: string }) {
  const m = markOf(path);
  if (!m) {
    return (
      <svg className="file-ico" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M9.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    );
  }
  if (m.glyph) {
    return (
      <svg className="file-ico" viewBox="0 0 16 16" aria-hidden="true" style={{ color: m.color }}>
        <GlyphPaths glyph={m.glyph} />
      </svg>
    );
  }
  const text = m.text ?? '';
  // The letters fill the box: one large, two a little smaller, three pressed to its width.
  const size = text.length >= 3 ? 9.2 : text.length === 2 ? 11.5 : 15;
  return (
    <svg className="file-ico" viewBox="0 0 16 16" aria-hidden="true">
      <text
        x="8"
        y="8.6"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="'Segoe UI', system-ui, sans-serif"
        fontWeight="800"
        fontSize={size}
        fill={m.color}
        {...(text.length >= 2 ? { textLength: text.length >= 3 ? 16 : 15, lengthAdjust: 'spacingAndGlyphs' } : {})}
      >
        {text}
      </text>
    </svg>
  );
}
