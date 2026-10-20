'use client';

/**
 * An icon per kind of file, as an IDE's explorer has (2026-10-20: "icons for the different program files"): a small
 * badge in the colour the language is known by, with its short name — TS, JS, {}, #, <>, PS, PY… — and a plain sheet
 * for anything else. Drawn here, so there is nothing to download and it follows the text size.
 */
import { detectLanguage, type LangId } from '../../lib/highlight';

type Badge = { text: string; bg: string; fg?: string };

const BY_LANG: Partial<Record<LangId, Badge>> = {
  typescript: { text: 'TS', bg: '#3178c6' },
  javascript: { text: 'JS', bg: '#f0db4f', fg: '#323330' },
  json: { text: '{}', bg: '#c48c12' },
  html: { text: '<>', bg: '#e34c26' },
  xml: { text: '<>', bg: '#e37933' },
  css: { text: '#', bg: '#2965f1' },
  scss: { text: 'S', bg: '#cd6799' },
  markdown: { text: 'M↓', bg: '#3f7fbf' },
  powershell: { text: 'PS', bg: '#2671be' },
  batch: { text: 'BAT', bg: '#4d4d4d' },
  shell: { text: '$_', bg: '#4eaa25' },
  python: { text: 'PY', bg: '#3572a5' },
  csharp: { text: 'C#', bg: '#68217a' },
  java: { text: 'J', bg: '#b07219' },
  kotlin: { text: 'K', bg: '#7f52ff' },
  go: { text: 'GO', bg: '#00add8' },
  rust: { text: 'RS', bg: '#b7410e' },
  c: { text: 'C', bg: '#555d69' },
  cpp: { text: 'C++', bg: '#d6336c' },
  swift: { text: 'SW', bg: '#f05138' },
  dart: { text: 'DT', bg: '#0175c2' },
  php: { text: 'PHP', bg: '#777bb4' },
  ruby: { text: 'RB', bg: '#cc342d' },
  lua: { text: 'LUA', bg: '#000080' },
  sql: { text: 'SQL', bg: '#d48a00' },
  yaml: { text: 'Y', bg: '#cb171e' },
  toml: { text: 'T', bg: '#9c4221' },
  ini: { text: '⚙', bg: '#6d8086' },
  dockerfile: { text: 'D', bg: '#2496ed' },
  makefile: { text: 'MK', bg: '#6d8086' },
  vue: { text: 'V', bg: '#41b883' },
};

const BY_EXT: Record<string, Badge> = {
  png: { text: 'IMG', bg: '#a074c4' }, jpg: { text: 'IMG', bg: '#a074c4' }, jpeg: { text: 'IMG', bg: '#a074c4' }, gif: { text: 'IMG', bg: '#a074c4' }, webp: { text: 'IMG', bg: '#a074c4' }, ico: { text: 'IMG', bg: '#a074c4' }, bmp: { text: 'IMG', bg: '#a074c4' },
  svg: { text: 'SVG', bg: '#e8a33d' },
  pdf: { text: 'PDF', bg: '#c4302b' },
  csv: { text: 'CSV', bg: '#237346' }, xlsx: { text: 'XLS', bg: '#1d6f42' }, docx: { text: 'DOC', bg: '#2b579a' }, pptx: { text: 'PPT', bg: '#c43e1c' },
  zip: { text: 'ZIP', bg: '#8a6d3b' }, gz: { text: 'ZIP', bg: '#8a6d3b' }, '7z': { text: 'ZIP', bg: '#8a6d3b' }, tgz: { text: 'ZIP', bg: '#8a6d3b' },
  txt: { text: 'TXT', bg: '#7a8794' }, log: { text: 'LOG', bg: '#7a8794' },
  lock: { text: 'LCK', bg: '#7a8794' },
  exe: { text: 'EXE', bg: '#4d4d4d' }, dll: { text: 'DLL', bg: '#4d4d4d' },
  sln: { text: 'SLN', bg: '#68217a' }, csproj: { text: 'C#', bg: '#68217a' },
  tsx: { text: 'TSX', bg: '#3178c6' }, jsx: { text: 'JSX', bg: '#e8c000', fg: '#323330' },
};

const BY_NAME: Record<string, Badge> = {
  '.gitignore': { text: 'GIT', bg: '#f14e32' }, '.gitattributes': { text: 'GIT', bg: '#f14e32' }, '.gitmodules': { text: 'GIT', bg: '#f14e32' },
  'package.json': { text: 'NPM', bg: '#cb3837' }, 'package-lock.json': { text: 'NPM', bg: '#cb3837' },
  license: { text: '©', bg: '#7a8794' }, 'license.md': { text: '©', bg: '#7a8794' }, 'license.txt': { text: '©', bg: '#7a8794' },
  '.env': { text: 'ENV', bg: '#d4a017', fg: '#2b2b2b' },
};

function badgeOf(path: string): Badge | null {
  const name = path.split('/').pop()!.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  if (BY_EXT[ext]) return BY_EXT[ext];
  return BY_LANG[detectLanguage(path)] ?? null;
}

export function FileIcon({ path }: { path: string }) {
  const b = badgeOf(path);
  if (!b) {
    return (
      <svg className="file-ico" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M9.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    );
  }
  const size = b.text.length >= 3 ? 5.2 : b.text.length === 2 ? 6.6 : 8.5;
  return (
    <svg className="file-ico" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="0.5" y="1.5" width="15" height="13" rx="3" fill={b.bg} />
      <text x="8" y="8.4" textAnchor="middle" dominantBaseline="middle" fontFamily="'Segoe UI', system-ui, sans-serif" fontWeight="700" fontSize={size} fill={b.fg ?? '#ffffff'}>
        {b.text}
      </text>
    </svg>
  );
}
