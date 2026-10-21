'use client';

/**
 * An icon per kind of file, as an IDE's explorer has (2026-10-20: "icons for the different program files"): the
 * language's short name — TS, JS, {}, #, <>, PS, PY… — in the colour it is known by, a small picture for the kinds
 * that have one (an image, git, a lock file, settings), and a plain sheet for anything else. Drawn here, so there is
 * nothing to download and it follows the text size.
 *
 * No frame (operator, 2026-10-20: "the icons do not differ when small; drop the square, keep only the text, or only
 * the picture"): the coloured squares all looked alike at 15 px, and the letters in them were too small to read. The
 * letters now fill the icon, in the colour the kind is known by.
 *
 * Each colour has a lighter twin for the dark theme (operator, 2026-10-21), worked out in `lib/fileMarks.ts`: the
 * icon carries both as `--ico` and `--ico-dark`, and the stylesheet picks the theme's.
 */
import type { CSSProperties } from 'react';
import { darkColor, markOf, type Glyph, type Mark } from '../../lib/fileMarks';

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

/** The mark's colour for each theme, for the stylesheet to choose from. */
const colours = (m: Mark): CSSProperties => ({ '--ico': m.color, '--ico-dark': darkColor(m.color) }) as CSSProperties;

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
      <svg className="file-ico marked" viewBox="0 0 16 16" aria-hidden="true" style={colours(m)}>
        <GlyphPaths glyph={m.glyph} />
      </svg>
    );
  }
  const text = m.text ?? '';
  // The letters fill the box: one large, two a little smaller, three pressed to its width.
  const size = text.length >= 3 ? 9.2 : text.length === 2 ? 11.5 : 15;
  return (
    <svg className="file-ico marked" viewBox="0 0 16 16" aria-hidden="true" style={colours(m)}>
      <text
        x="8"
        y="8.6"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="'Segoe UI', system-ui, sans-serif"
        fontWeight="800"
        fontSize={size}
        fill="currentColor"
        {...(text.length >= 2 ? { textLength: text.length >= 3 ? 16 : 15, lengthAdjust: 'spacingAndGlyphs' } : {})}
      >
        {text}
      </text>
    </svg>
  );
}
