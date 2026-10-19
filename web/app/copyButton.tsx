'use client';

/**
 * A button that copies a text, and says so on itself for a moment: "Copied", or that it could not.
 *
 * Asked for the chat's messages on 2026-10-19. The clipboard API first; where the browser refuses it (a page that is
 * not a secure context, a permission withheld), the old way through a selected text area, so a copy that can be made
 * is made. A label in words, not an icon, as the operator asked for the problems' "Seen".
 */
import { useEffect, useRef, useState } from 'react';
import { useT, type Key } from '../lib/i18n';

/** Puts the text on the clipboard; true when it got there. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* refused: the older way below */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, what, className = '' }: { text: string; /** What is copied, for the title and a screen reader. */ what: Key; className?: string }) {
  const { t } = useT();
  const [said, setSaid] = useState<'' | 'copied' | 'failed'>('');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async (): Promise<void> => {
    setSaid((await copyText(text)) ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaid(''), 2_000);
  };
  return (
    <button type="button" className={`quiet small copy-btn ${className}`.trim()} onClick={() => void copy()} title={t(what)} aria-label={t(what)}>
      <span aria-live="polite">{said === 'copied' ? t('copy.copied') : said === 'failed' ? t('copy.failed') : t('copy.copy')}</span>
    </button>
  );
}
