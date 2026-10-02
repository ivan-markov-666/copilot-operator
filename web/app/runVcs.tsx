'use client';

import { useState } from 'react';
import { api, fmtBytes, type RunVcsActionId, type RunVcsGroup } from '../lib/api';
import { useT, type Key } from '../lib/i18n';

const ACTION_LABEL: Record<RunVcsActionId, Key> = {
  'review-inputs': 'runvcs.review',
  'snapshot-on-base': 'runvcs.snapshotOnBase',
  'snapshot-here': 'runvcs.snapshotHere',
  'use-current-branch': 'runvcs.useCurrent',
  'allow-snapshot': 'runvcs.allowSnapshot',
};

/**
 * "Prepare version control for this run": one box per repository of the sessions about to run, with
 * what is in the way and the fixes, each saying exactly what it does before it is pressed. The run
 * buttons stay off until every box is ready, and the run itself is refused before the browser opens
 * while one is not (see src/vcs/runPreflight.ts).
 */
export function RunVcsPanel({ groups, sessionIds, onChange }: { groups: RunVcsGroup[]; sessionIds: string[]; onChange: () => void }) {
  const { t } = useT();
  const open = groups.filter((g) => !g.ready);
  if (open.length === 0) return null;
  return (
    <section className="notice caution" aria-labelledby="runvcs-title">
      <h3 id="runvcs-title" style={{ marginTop: 0 }}>{t('runvcs.title')}</h3>
      <p className="small">{t('runvcs.why')}</p>
      {open.map((g) => (
        <RepoBox key={g.repoDir} group={g} sessionIds={sessionIds} onChange={onChange} />
      ))}
    </section>
  );
}

function RepoBox({ group, sessionIds, onChange }: { group: RunVcsGroup; sessionIds: string[]; onChange: () => void }) {
  const { t } = useT();
  const [showInputs, setShowInputs] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const short = (c?: string | null): string => (c ?? '—').slice(0, 8);

  const act = async (id: RunVcsActionId) => {
    if (id === 'review-inputs') {
      setShowInputs((v) => !v);
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const choices =
        id === 'snapshot-on-base'
          ? Object.fromEntries(group.inputs.map((e) => [e.path, 'include' as const]))
          : Object.fromEntries(group.entries.filter((e) => e.choice).map((e) => [e.path, e.choice as 'include' | 'leave-out']));
      const r = await api.runVcsPrepare(sessionIds, group.repoDir, id, choices);
      setMsg(r.ok ? (r.result ?? '') : (r.problem ?? ''));
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="option" style={{ overflowWrap: 'anywhere' }}>
      <table className="small">
        <tbody>
          <tr>
            <th>{t('runvcs.repo')}</th>
            <td><code>{group.repoDir}</code></td>
          </tr>
          <tr>
            <th>{t('runvcs.current')}</th>
            <td><code>{group.branch ?? 'HEAD'}</code> @ <code>{short(group.head)}</code></td>
          </tr>
          {group.baseBranch && (
            <tr>
              <th>{t('runvcs.base')}</th>
              <td><code>{group.baseBranch}</code> @ <code>{short(group.baseHead)}</code></td>
            </tr>
          )}
          <tr>
            <th>{t('runvcs.sessions')}</th>
            <td>{group.sessions.map((s) => `${s.name} (${t(`runvcs.role.${s.role}` as Key)})`).join(', ')}</td>
          </tr>
          {group.inputPatterns.length > 0 && (
            <tr>
              <th>{t('runvcs.patterns')}</th>
              <td>{group.inputPatterns.map((p) => <code key={p} style={{ marginRight: 6 }}>{p}</code>)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {group.problem && <p className="small"><strong>{t('runvcs.problem')}</strong> {group.problem}</p>}

      {group.inputs.length > 0 && (
        <p className="small">{t('runvcs.inputsCount', { n: group.inputs.length })}</p>
      )}
      {showInputs && group.inputs.length > 0 && (
        <ul className="small" style={{ margin: '4px 0' }}>
          {group.inputs.map((e) => (
            <li key={e.path}>
              <code>{e.path}</code> — {t(`vcs.snapshotKind.${e.kind}` as Key)}{e.size !== undefined ? `, ${fmtBytes(e.size)}` : ''}
              {e.allowed.length === 0 && e.reason ? <span className="err"> — {e.reason}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {group.unrelated.length > 0 && (
        <>
          <p className="small"><strong>{t('runvcs.unrelated', { n: group.unrelated.length })}</strong></p>
          <ul className="small" style={{ margin: '4px 0' }}>
            {group.unrelated.slice(0, 30).map((u) => (
              <li key={u.path}><code>{u.path}</code>{u.reason ? ` — ${u.reason}` : ''}</li>
            ))}
          </ul>
        </>
      )}

      {cancelled ? (
        <p className="small muted">
          {t('runvcs.cancelled')}{' '}
          <button className="quiet" onClick={() => setCancelled(false)}>{t('runvcs.showAgain')}</button>
        </p>
      ) : (
        <div>
          {group.actions.map((a) => (
            <div key={a.id} style={{ marginTop: 8 }}>
              <button
                className={a.recommended ? 'primary' : undefined}
                onClick={() => void act(a.id)}
                disabled={busy || !a.available}
              >
                {t(ACTION_LABEL[a.id], { branch: group.baseBranch ?? '', current: group.branch ?? 'HEAD' })}
                {a.id === 'review-inputs' && showInputs ? ' ✓' : ''}
              </button>
              {a.recommended && <span className="badge done" style={{ marginLeft: 6 }}>{t('runvcs.recommended')}</span>}
              <p className="why">{a.available ? a.result : `${t('runvcs.notNow')} ${a.why ?? ''}`}</p>
            </div>
          ))}
          <div style={{ marginTop: 8 }}>
            <button className="quiet" onClick={() => setCancelled(true)} disabled={busy}>{t('runvcs.cancel')}</button>
            <p className="why">{t('runvcs.cancelWhy')}</p>
          </div>
        </div>
      )}
      {msg && <p className="small" role="status">{msg}</p>}
    </div>
  );
}
