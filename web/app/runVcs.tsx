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
  // What the last fix did, kept here: the box that showed it goes away once its repository is ready.
  const [done, setDone] = useState('');
  const open = groups.filter((g) => !g.ready);
  if (open.length === 0) {
    return done ? (
      <p className="notice small" role="status">
        <strong>{t('runvcs.ready')}</strong> {done}
      </p>
    ) : null;
  }
  return (
    <section className="notice caution" aria-labelledby="runvcs-title">
      <h3 id="runvcs-title" style={{ marginTop: 0 }}>{t('runvcs.title')}</h3>
      <p className="small">{t('runvcs.why')}</p>
      {open.map((g) => (
        <RepoBox key={g.repoDir} group={g} sessionIds={sessionIds} onChange={onChange} onDone={setDone} />
      ))}
    </section>
  );
}

function RepoBox({ group, sessionIds, onChange, onDone }: { group: RunVcsGroup; sessionIds: string[]; onChange: () => void; onDone: (result: string) => void }) {
  const { t } = useT();
  const [showInputs, setShowInputs] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  /*
   * The operator's choice per file for "Create starting snapshot on <current>", as the session page has
   * it. The panel used to send the defaults it never showed, so a scratch file was committed into the
   * starting snapshot with no way to leave it out from here (live run 2026-10-03).
   */
  const [choices, setChoices] = useState<Record<string, 'include' | 'leave-out'>>({});
  const choiceOf = (path: string, fallback?: 'include' | 'leave-out' | null): 'include' | 'leave-out' | undefined => choices[path] ?? fallback ?? undefined;
  const snapshotHere = group.actions.find((a) => a.id === 'snapshot-here' && a.available);
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
          : Object.fromEntries(group.entries.filter((e) => choiceOf(e.path, e.choice)).map((e) => [e.path, choiceOf(e.path, e.choice) as 'include' | 'leave-out']));
      const r = await api.runVcsPrepare(sessionIds, group.repoDir, id, choices);
      setMsg(r.ok ? (r.result ?? '') : (r.problem ?? ''));
      if (r.ok) onDone(`${group.repoDir}: ${r.result ?? ''}`);
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
          {group.workBranch && (
            <tr>
              <th>{t('runvcs.workBranch')}</th>
              <td><code>{group.workBranch.name}</code> @ <code>{short(group.workBranch.head)}</code></td>
            </tr>
          )}
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

      {snapshotHere && group.entries.length > 0 && (
        <>
          <p className="small"><strong>{t('runvcs.choose', { n: group.entries.length })}</strong></p>
          <ul className="small" style={{ margin: '4px 0', paddingLeft: 0, listStyle: 'none' }}>
            {group.entries.map((e) => (
              <li key={e.path} style={{ marginBottom: 4 }}>
                <code>{e.path}</code>{' '}
                <span className="muted">({e.input ? `${t('vcs.snapshotInput')}, ` : ''}{t(`vcs.snapshotKind.${e.kind}` as Key)}{e.size !== undefined ? `, ${fmtBytes(e.size)}` : ''})</span>{' '}
                {e.allowed.length === 0 ? (
                  <span className="err">{t('vcs.snapshotBlocked')}</span>
                ) : (
                  <select
                    aria-label={e.path}
                    value={choiceOf(e.path, e.choice) ?? ''}
                    onChange={(ev) => setChoices({ ...choices, [e.path]: ev.target.value as 'include' | 'leave-out' })}
                    disabled={busy || e.allowed.length < 2}
                  >
                    {e.allowed.map((a) => (
                      <option key={a} value={a}>{t(a === 'include' ? 'vcs.snapshotInclude' : 'vcs.snapshotLeaveOut')}</option>
                    ))}
                  </select>
                )}
                {e.reason && <div className="muted">{e.reason}</div>}
              </li>
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
