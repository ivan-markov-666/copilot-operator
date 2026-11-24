'use client';

/**
 * A locator of the chat that found nothing where the bot needed it, said so it can be fixed without anybody's help
 * (operator, 2026-11-17: "a mechanism that detects which locator exactly the bot failed on … after it fails, the user is
 * taken to the place where the locator is updated, the field painted red … and the bot saves the page's HTML and gives
 * it to the user, to hand to a chatbot that says which locator it is and what its selector is").
 *
 * On every page, under the start failures: which locator, when, and three ways on — to its field in Settings (in red
 * there), the one file for a chatbot, close. A failure that stopped the work takes the operator to the field once, by
 * itself. Gone once the locator is changed in Settings (`changed`), or closed.
 *
 * The file (operator, 2026-11-18: "too many things for the user to do … everything in one file, the user takes it and
 * sends it to the chat, and that is all") holds what the HTML and the text for the chatbot held apart before, with the
 * piece of the page where the element most likely is: downloaded, attached to a chatbot, sent.
 */
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { api, type LocatorFailureRef } from '../lib/api';
import { useFmtTime, useT, type Key } from '../lib/i18n';
import { usePoll } from '../lib/usePoll';

/** Where Settings has a locator's field: the page reads `locator` and goes to it, in red. */
export function locatorFieldUrl(key: string): string {
  // One of the operator's own steps (2026-11-17) is in "Steps to the chat", under the chat's locators.
  // The model menu's (2026-11-24) are in their own section.
  return `/settings?locator=${encodeURIComponent(key)}#${key.startsWith('step:') ? 'chat-steps' : key.startsWith('picker:') ? 'picker-locators' : 'chat-locators'}`;
}

/** One failure: what was not found, the locator, and the ways on. `inSettings`: under its field, where "Fix" is not needed. */
export function LocatorFailureNotice({ failure, inSettings = false, onDismiss }: { failure: LocatorFailureRef; inSettings?: boolean; onDismiss: () => void }) {
  const { t, locale } = useT();
  const fmtTime = useFmtTime();
  const picker = failure.key.startsWith('picker:');
  const name = failure.key.startsWith('step:') ? failure.name || failure.locator : t((picker ? `loc.${failure.key.slice('picker:'.length)}` : `chatloc.${failure.key}`) as Key);
  return (
    <div className={`notice ${failure.stopped ? '' : 'caution'} locator-failure`.trim()} role="alert" data-locator={failure.key} style={{ overflowWrap: 'anywhere' }}>
      {!inSettings && <strong>{picker ? t('chatloc.pickerTitle', { name }) : t(failure.stopped ? 'chatloc.failTitle' : 'chatloc.warnTitle', { name })}</strong>}
      <p className="small" style={{ margin: '4px 0' }}>
        {t('chatloc.failWhen', { when: fmtTime(failure.at) })} <code className="picker-example">{failure.locator}</code>
      </p>
      {failure.why && <p className="muted small" style={{ margin: '4px 0' }}>{failure.why}</p>}
      <div className="row" style={{ marginTop: 6 }}>
        {/* First: what is done first, the file to a chatbot; then its answer goes in the field. */}
        <a className="button-link" href={api.locatorChatbotUrl(failure.key, locale)} download data-chatbot-file>
          {t('chatloc.file')}
        </a>
        {!inSettings && (
          <a className="button-link" href={locatorFieldUrl(failure.key)}>
            {t('chatloc.fix')}
          </a>
        )}
        <button type="button" className="quiet" onClick={onDismiss}>
          {t('chatloc.dismiss')}
        </button>
      </div>
      <p className="why">{t('chatloc.how')}</p>
    </div>
  );
}

const OPENED_KEY = 'cop.locatorFailure.opened';

function readOpened(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(OPENED_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The failures still to fix, read every few seconds; shared by the banner and Settings. */
export function useLocatorFailures(): { list: LocatorFailureRef[]; dismiss: (key: string) => Promise<void>; reload: () => Promise<void> } {
  const [list, setList] = useState<LocatorFailureRef[]>([]);
  const reload = async (): Promise<void> => {
    await api
      .locatorFailures()
      .then((l) => setList(l.filter((f) => !f.changed)))
      .catch(() => undefined);
  };
  usePoll(reload, 5000);
  const dismiss = async (key: string): Promise<void> => {
    setList((l) => l.filter((f) => f.key !== key));
    await api.dismissLocatorFailure(key).catch(() => undefined);
  };
  return { list, dismiss, reload };
}

/** On every page but Settings, which shows each under its field. */
export function LocatorFailureBanner() {
  const pathname = usePathname();
  const { list, dismiss } = useLocatorFailures();
  const onSettings = pathname === '/settings' || pathname === '/settings/';

  // A failure that stopped the work takes the operator to its field, once: what to do next is there.
  useEffect(() => {
    if (onSettings) return;
    const first = list.find((f) => f.stopped);
    if (!first) return;
    const id = `${first.key}@${first.at}`;
    const opened = readOpened();
    if (opened.includes(id)) return;
    try {
      window.localStorage.setItem(OPENED_KEY, JSON.stringify([...opened, id].slice(-50)));
    } catch {
      return; // not remembered: not opened by itself either, or it would be opened again and again
    }
    window.location.assign(locatorFieldUrl(first.key));
  }, [list, onSettings]);

  if (onSettings || list.length === 0) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      {list.map((f) => (
        <LocatorFailureNotice key={f.key} failure={f} onDismiss={() => void dismiss(f.key)} />
      ))}
    </div>
  );
}
