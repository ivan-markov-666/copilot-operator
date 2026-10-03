'use client';

/**
 * "Prepare the folder from the remote main branch" (src/vcs/prepareFromRemote.ts): one press fetches
 * and shows what would be kept where and where the folder would end up; "Confirm" does it, and only
 * if the folder is still what was shown. Nothing is thrown away: uncommitted changes and new files go
 * onto a branch of their own first. Shown for every project in Settings and on a session's version
 * control panel.
 */
import { useState } from 'react';
import { api, type PreparePlan } from '../lib/api';
import { useT } from '../lib/i18n';

export function PrepareFolder({ dir, onDone }: { dir: string; onDone?: () => void }) {
  const { t } = useT();
  const [plan, setPlan] = useState<PreparePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState('');
  const short = (c?: string | null): string => (c ?? '—').slice(0, 8);

  const look = async (): Promise<void> => {
    setErr('');
    setResult('');
    setBusy(true);
    try {
      setPlan(await api.preparePreview(dir));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async (): Promise<void> => {
    if (!plan?.fingerprint) return;
    setErr('');
    setBusy(true);
    try {
      const r = await api.prepareProject(dir, plan.fingerprint);
      if (r.ok) {
        setResult(r.result ?? '');
        setPlan(null);
        onDone?.();
      } else setErr(r.problem ?? '');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const list = (items: string[]) => (
    <ul style={{ margin: '2px 0 6px', paddingLeft: 20 }}>
      {items.slice(0, 30).map((x) => (
        <li key={x}>
          <code>{x}</code>
        </li>
      ))}
      {items.length > 30 && <li className="muted">{t('prep.more', { n: items.length - 30 })}</li>}
    </ul>
  );

  return (
    <div className="prepare-folder small" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>
      <button type="button" onClick={() => void look()} disabled={busy}>
        {t('prep.show')}
      </button>
      <p className="why">{t('prep.why')}</p>
      {err && <p className="err" role="alert">{err}</p>}
      {result && <p className="notice" role="status">{result}</p>}
      {plan && !plan.ok && <p className="err">{plan.problem}</p>}
      {plan?.ok && (
        <div className="notice caution" style={{ marginTop: 8 }}>
          <p>
            {t('prep.where', {
              target: plan.target ?? '',
              commit: short(plan.targetCommit),
              branch: plan.branch ?? 'HEAD',
              head: short(plan.head),
            })}
          </p>
          {plan.alreadyThere ? (
            <p>{t('prep.already')}</p>
          ) : (
            <>
              <strong>{t('prep.willDo')}</strong>
              <ol style={{ margin: '4px 0', paddingLeft: 20 }}>
                {plan.savedBranch && (
                  <li>
                    {t('prep.keepChanges', { changed: plan.changed.length, untracked: plan.untracked.length, saved: plan.savedBranch })}
                    {list([...plan.changed, ...plan.untracked])}
                  </li>
                )}
                {plan.savedMainBranch && (
                  <li>
                    {t('prep.keepMain', { n: plan.mainOnlyCommits.length, branch: plan.localBranch ?? '', saved: plan.savedMainBranch })}
                    {list(plan.mainOnlyCommits)}
                  </li>
                )}
                <li>{t('prep.moveTo', { branch: plan.localBranch ?? '', commit: short(plan.targetCommit), target: plan.target ?? '' })}</li>
              </ol>
              {plan.branchOnlyCommits.length > 0 && plan.branch && (
                <p>{t('prep.branchStays', { branch: plan.branch, n: plan.branchOnlyCommits.length })}</p>
              )}
              <p className="muted">{t('prep.ignored')}</p>
              <div className="row">
                <button type="button" className="primary" onClick={() => void confirm()} disabled={busy}>
                  {t('prep.confirm')}
                </button>
                <button type="button" className="quiet" onClick={() => setPlan(null)} disabled={busy}>
                  {t('prep.cancel')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
