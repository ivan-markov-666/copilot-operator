/**
 * The flags beside the languages (operator, 2026-10-20: "add the countries' flags where the language is chosen").
 *
 * Drawn here rather than taken from the emoji flags, which Windows does not draw — it shows the two letters instead —
 * and simplified to what reads at the size of a line of text. A language is not a country, so each stands for the
 * country most associated with it: the United Kingdom for English, Portugal for Portuguese, Saudi Arabia for Arabic.
 * A new language's flag is drawn here, in the same 30 × 20 box.
 */
import type { ReactNode } from 'react';
import type { FlagId } from '../lib/lang/languages';

const FLAGS: Record<FlagId, ReactNode> = {
  gb: (
    <>
      <rect width="30" height="20" fill="#012169" />
      <path d="M0 0 30 20M30 0 0 20" stroke="#fff" strokeWidth="4" />
      <path d="M0 0 30 20M30 0 0 20" stroke="#c8102e" strokeWidth="1.4" />
      <path d="M15 0v20M0 10h30" stroke="#fff" strokeWidth="6" />
      <path d="M15 0v20M0 10h30" stroke="#c8102e" strokeWidth="3.4" />
    </>
  ),
  bg: (
    <>
      <rect width="30" height="20" fill="#fff" />
      <rect y="6.67" width="30" height="6.67" fill="#00966e" />
      <rect y="13.33" width="30" height="6.67" fill="#d62612" />
    </>
  ),
  de: (
    <>
      <rect width="30" height="6.67" fill="#000" />
      <rect y="6.67" width="30" height="6.67" fill="#dd0000" />
      <rect y="13.33" width="30" height="6.67" fill="#ffce00" />
    </>
  ),
  es: (
    <>
      <rect width="30" height="20" fill="#aa151b" />
      <rect y="5" width="30" height="10" fill="#f1bf00" />
      <rect x="7" y="7.5" width="3.4" height="5" rx="0.8" fill="#aa151b" opacity="0.85" />
    </>
  ),
  fr: (
    <>
      <rect width="10" height="20" fill="#002395" />
      <rect x="10" width="10" height="20" fill="#fff" />
      <rect x="20" width="10" height="20" fill="#ed2939" />
    </>
  ),
  pt: (
    <>
      <rect width="12" height="20" fill="#006600" />
      <rect x="12" width="18" height="20" fill="#ff0000" />
      <circle cx="12" cy="10" r="4.2" fill="none" stroke="#ffcc00" strokeWidth="1.4" />
      <path d="M10.3 7.8h3.4v3.2a1.7 1.7 0 0 1-3.4 0z" fill="#fff" stroke="#d00" strokeWidth="0.6" />
    </>
  ),
  jp: (
    <>
      <rect width="30" height="20" fill="#fff" />
      <circle cx="15" cy="10" r="6" fill="#bc002d" />
    </>
  ),
  kr: (
    <>
      <rect width="30" height="20" fill="#fff" />
      <path d="M10 10a5 5 0 0 1 10 0 2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 0-5 0z" fill="#cd2e3a" />
      <path d="M10 10a5 5 0 0 0 10 0 2.5 2.5 0 0 0-5 0 2.5 2.5 0 0 1-5 0z" fill="#0047a0" />
      <g stroke="#000" strokeWidth="0.9">
        <path d="M4.2 5.6 6.8 2.4M5.1 6.3 7.7 3.1M6 7 8.6 3.8" />
        <path d="M21.4 3.8 24 7M22.3 3.1 24.9 6.3M23.2 2.4 25.8 5.6" />
        <path d="M4.2 14.4 6.8 17.6M5.1 13.7 7.7 16.9M6 13 8.6 16.2" />
        <path d="M21.4 16.2 24 13M22.3 16.9 24.9 13.7M23.2 17.6 25.8 14.4" />
      </g>
    </>
  ),
  sa: (
    <>
      <rect width="30" height="20" fill="#006c35" />
      <path d="M7 8.2c1-.9 2 .9 3 0s2 .9 3 0 2 .9 3 0 2 .9 3 0 2 .9 3 0" fill="none" stroke="#fff" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M8 12.6h13.4M21.4 12.6l1.6-.9M9.6 11.6v2" stroke="#fff" strokeWidth="1" strokeLinecap="round" />
    </>
  ),
};

export function Flag({ id }: { id: FlagId }) {
  return (
    <svg className="flag" viewBox="0 0 30 20" aria-hidden="true" focusable="false">
      {FLAGS[id]}
    </svg>
  );
}
