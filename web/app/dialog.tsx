'use client';

/**
 * The app's own confirm and alert, in place of the browser's.
 *
 * `window.confirm` cannot be styled, cannot be read by the theme, truncates long questions on
 * some platforms and looks like a system fault in the middle of a page that otherwise speaks
 * in full sentences. The questions here are long on purpose — "restore" lists the commits it
 * leaves behind, "run again from here" lists the tasks it will requeue — so they need room.
 *
 * The API is a pair of promises rather than a component, so a call site that used to read
 * `if (!window.confirm(q)) return` reads `if (!(await confirmDialog(q))) return` and nothing
 * else about it changes. One host, mounted by the layout, answers every call.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../lib/i18n';

type Request = {
  kind: 'confirm' | 'alert';
  message: string;
  title?: string;
  okLabel?: string;
  danger?: boolean;
  resolve: (answer: boolean) => void;
};

let host: ((r: Request) => void) | null = null;
/** Calls that arrive before the host mounts, which only happens during hydration. */
const pending: Request[] = [];

function post(r: Request): void {
  if (host) host(r);
  else pending.push(r);
}

export type DialogOptions = { title?: string; okLabel?: string; danger?: boolean };

/** Resolves true when the reader pressed the confirming button, false otherwise. */
export function confirmDialog(message: string, opts: DialogOptions = {}): Promise<boolean> {
  return new Promise((resolve) => post({ kind: 'confirm', message, ...opts, resolve }));
}

/** Resolves when the reader closed it. */
export function alertDialog(message: string, opts: DialogOptions = {}): Promise<void> {
  return new Promise((resolve) => post({ kind: 'alert', message, ...opts, resolve: () => resolve() }));
}

export function DialogHost({ children }: { children?: ReactNode }) {
  const { t } = useT();
  const [queue, setQueue] = useState<Request[]>([]);
  const okRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    host = (r) => setQueue((q) => [...q, r]);
    if (pending.length > 0) {
      const early = pending.splice(0, pending.length);
      setQueue((q) => [...q, ...early]);
    }
    return () => {
      host = null;
    };
  }, []);

  const current = queue[0];

  const answer = useCallback(
    (value: boolean) => {
      if (!current) return;
      current.resolve(value);
      setQueue((q) => q.slice(1));
    },
    [current],
  );

  useEffect(() => {
    if (!current) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        answer(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, answer]);

  return (
    <>
      {children}
      {current && (
        <div className="modal-backdrop" onClick={() => answer(false)} role="presentation">
          <div
            className={`modal${current.danger ? ' danger' : ''}`}
            role={current.kind === 'confirm' ? 'alertdialog' : 'dialog'}
            aria-modal="true"
            aria-labelledby="modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="modal-title">{current.title ?? (current.kind === 'confirm' ? t('dialog.confirmTitle') : t('dialog.noticeTitle'))}</h2>
            <div className="modal-body">{current.message}</div>
            <div className="row modal-actions">
              {current.kind === 'confirm' && (
                <button type="button" className="quiet" onClick={() => answer(false)}>
                  {t('dialog.cancel')}
                </button>
              )}
              <button ref={okRef} type="button" className={current.danger ? 'danger' : 'primary'} onClick={() => answer(true)}>
                {current.okLabel ?? t('dialog.ok')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
