/**
 * The branch mark, drawn (2026-10-20): the "⎇" character it was came out as a stray box or a "⊏" on this machine's
 * fonts, beside the branch's name in the explorer, the status bar and Settings.
 */
export function BranchIcon() {
  return (
    <svg className="branch-ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 3.5v9M4.5 10c0-3 7-2.5 7-5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="4.5" cy="3" r="1.7" fill="currentColor" />
      <circle cx="4.5" cy="13" r="1.7" fill="currentColor" />
      <circle cx="11.5" cy="4.2" r="1.7" fill="currentColor" />
    </svg>
  );
}
