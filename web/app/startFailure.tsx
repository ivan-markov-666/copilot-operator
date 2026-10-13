'use client';

/**
 * A start that did not get as far as a first task, said so it cannot be missed, with the files that
 * show why (src/session/startFailure.ts).
 *
 * Asked for on 2026-10-13: "if something fails and the bot does not start at all, I want to see the
 * error, and a place to download what happened in the terminal". Shown in the start window as the
 * answer to its button, and on every page when the run was accepted first and failed afterwards — the
 * browser that would not open was otherwise a row further down the Sessions page and a stack trace in
 * a console nobody was looking at.
 */
import { useState, type ReactNode } from 'react';
import { api, type StartFailureRef } from '../lib/api';
import { useFmtTime, useT, type Key } from '../lib/i18n';
import { usePoll } from '../lib/usePoll';

/** What failed, where, when, and the two downloads. `reason` alone when the API could not even be asked. */
export function StartFailureNotice({
  failure,
  reason,
  onDismiss,
  intro,
  children,
}: {
  failure?: StartFailureRef;
  reason?: string;
  onDismiss?: () => void;
  intro?: string;
  /** Said under the message: a way to the setting behind a refusal, where there is one. */
  children?: ReactNode;
}) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const message = failure?.message ?? reason ?? '';
  return (
    <div className="notice caution start-failure" role="alert" style={{ overflowWrap: 'anywhere' }}>
      {intro && <p className="small" style={{ marginTop: 0 }}>{intro}</p>}
      <strong>{t('startfail.title')}</strong>
      {failure && <p className="small" style={{ margin: '4px 0' }}>{t('startfail.where', { stage: t(`startfail.stage.${failure.stage}` as Key) })}</p>}
      <pre className="sync-cmd small" style={{ margin: '6px 0' }}>{message}</pre>
      {children}
      {failure && (
        <p className="muted small" style={{ margin: '4px 0' }}>
          {failure.runId ? t('startfail.when', { when: fmtTime(failure.at), run: failure.runId }) : t('startfail.whenNoRun', { when: fmtTime(failure.at) })}
          {failure.sessions.length > 0 ? ` · ${failure.sessions.map((s) => `"${s}"`).join(', ')}` : ''}
        </p>
      )}
      <div className="row" style={{ marginTop: 6 }}>
        {failure && (
          <a className="button-link" href={api.startFailureUrl(failure.id)} download>
            {t('startfail.download')}
          </a>
        )}
        <a className={failure ? 'button-link' : 'button-link plain'} href={api.terminalUrl()} download>
          {t('startfail.terminal')}
        </a>
        {onDismiss && (
          <button type="button" className="quiet" onClick={onDismiss}>
            {t('startfail.dismiss')}
          </button>
        )}
      </div>
      <p className="why">{t('startfail.downloadWhy')}</p>
    </div>
  );
}

const DISMISSED_KEY = 'cop.startFailure.dismissed';

function readDismissed(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * On every page: a run that was accepted and then could not begin — the browser, the profile, the
 * sign-in, a later session refused at its turn. Each is shown until it is closed here.
 */
export function StartFailureBanner() {
  const { t } = useT();
  const [list, setList] = useState<StartFailureRef[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  usePoll(
    () =>
      api
        .startFailures(true)
        .then((l) => {
          setList(l);
          setDismissed(readDismissed());
        })
        .catch(() => undefined),
    5000,
  );
  const shown = list.find((f) => !dismissed.includes(f.id));
  if (!shown) return null;
  const dismiss = () => {
    const next = [...new Set([...readDismissed(), shown.id])].slice(-50);
    try {
      window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    } catch {
      /* closed for this page only */
    }
    setDismissed(next);
  };
  return (
    <div style={{ marginBottom: 12 }}>
      <StartFailureNotice failure={shown} intro={t(shown.stage === 'at-turn' ? 'startfail.laterSession' : 'startfail.later')} onDismiss={dismiss} />
    </div>
  );
}
