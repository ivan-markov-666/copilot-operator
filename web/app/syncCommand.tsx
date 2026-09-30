'use client';

/**
 * "Bring this project back to the remote's main branch" — as a command to copy, never as a button
 * that does it (src/vcs/syncCommand.ts says why). One press reads the repository and shows what the
 * command would throw away, a read-only preview command, and the command itself, each with a copy
 * button. Shown for every project in Settings and on a session's version control panel.
 */
import { useState } from 'react';
import { api, type SyncPlan } from '../lib/api';
import { useT, useFmtTime } from '../lib/i18n';

export function SyncCommand({ dir }: { dir: string }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');

  const load = async (): Promise<void> => {
    setErr('');
    try {
      setPlan(await api.syncPlan(dir));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const copy = async (what: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(''), 2500);
    } catch {
      setErr(t('plan.copyFailed'));
    }
  };
  const list = (items: string[]) => (
    <ul style={{ margin: '2px 0 6px', paddingLeft: 20 }}>
      {items.slice(0, 30).map((x) => (
        <li key={x}>
          <code>{x}</code>
        </li>
      ))}
      {items.length > 30 && <li className="muted">{t('sync.more', { n: items.length - 30 })}</li>}
    </ul>
  );

  return (
    <div className="sync-command small" style={{ marginTop: 8 }}>
      <button type="button" onClick={() => void load()}>
        {t('sync.show')}
      </button>
      {err && <p className="err">{err}</p>}
      {plan && !plan.ok && <p className="err">{plan.problem}</p>}
      {plan?.ok && (
        <div className="notice caution" style={{ marginTop: 8 }}>
          <p>
            {t('sync.what', { branch: plan.branch ?? '', target: plan.target ?? '' })}{' '}
            <span className="muted">{plan.lastFetched ? t('sync.fetchedAt', { when: fmtTime(plan.lastFetched) }) : t('sync.neverFetched')}</span>
          </p>
          {plan.willLose.commits.length + plan.willLose.changed.length + plan.willLose.untracked.length === 0 ? (
            <p>{t('sync.nothingLost')}</p>
          ) : (
            <>
              <strong>{t('sync.loses')}</strong>
              {plan.willLose.commits.length > 0 && (
                <>
                  <div>{t('sync.commits', { n: plan.willLose.commits.length })}</div>
                  {list(plan.willLose.commits)}
                </>
              )}
              {plan.willLose.changed.length > 0 && (
                <>
                  <div>{t('sync.changed', { n: plan.willLose.changed.length })}</div>
                  {list(plan.willLose.changed)}
                </>
              )}
              {plan.willLose.untracked.length > 0 && (
                <>
                  <div>{t('sync.untracked', { n: plan.willLose.untracked.length })}</div>
                  {list(plan.willLose.untracked)}
                </>
              )}
            </>
          )}
          <p className="muted">{t('sync.keeps')}</p>
          <div className="row">
            <button type="button" onClick={() => void copy('preview', plan.preview)}>
              {t('sync.copyPreview')}
            </button>
            {copied === 'preview' && <span className="badge done">{t('plan.copied')}</span>}
          </div>
          <pre className="sync-cmd">{plan.preview}</pre>
          <div className="row">
            <button type="button" className="danger" onClick={() => void copy('command', plan.command)}>
              {t('sync.copyCommand')}
            </button>
            {copied === 'command' && <span className="badge done">{t('plan.copied')}</span>}
          </div>
          <pre className="sync-cmd">{plan.command}</pre>
          <p className="muted">{t('sync.howToRun')}</p>
        </div>
      )}
    </div>
  );
}
