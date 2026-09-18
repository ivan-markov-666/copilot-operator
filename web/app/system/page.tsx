'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';

export default function SystemPage() {
  const { t } = useT();
  const [doctor, setDoctor] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<{ raw: Record<string, unknown>; resolved: Record<string, unknown> } | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.doctor().then(setDoctor).catch((e) => setErr((e as Error).message));
    api.settings().then(setSettings).catch((e) => setErr((e as Error).message));
  }, []);

  const held = doctor?.profileHeldBy as number[] | 'unknown' | undefined;

  return (
    <>
      {err && <div className="panel err">{err}</div>}
      <div className="panel">
        <h2>{t('sys.machine')}</h2>
        {!doctor && <div className="muted">{t('sys.loading')}</div>}
        {doctor && (
          <table>
            <tbody>
              <tr>
                <th>{t('sys.node')}</th>
                <td>{String(doctor.node)}</td>
              </tr>
              <tr>
                <th>{t('sys.edge')}</th>
                <td>{doctor.edge ? String(doctor.edge) : <span className="err">{t('sys.edgeMissing')}</span>}</td>
              </tr>
              <tr>
                <th>{t('sys.profile')}</th>
                <td>
                  {String(doctor.profileDir)} {doctor.profileExists ? '' : <span className="muted">{t('sys.profileMissing')}</span>}
                </td>
              </tr>
              <tr>
                <th>{t('sys.profileInUse')}</th>
                <td>
                  {Array.isArray(held) && held.length > 0 ? (
                    <span className="err">{t('sys.profileHeld', { pids: held.join(', ') })}</span>
                  ) : held === 'unknown' ? (
                    <span className="muted">{t('sys.profileUnknown')}</span>
                  ) : (
                    t('sys.profileFree')
                  )}
                </td>
              </tr>
              <tr>
                <th>{t('sys.desktop')}</th>
                <td>
                  {String(doctor.desktop)} <span className="muted">{doctor.desktopSynced ? t('sys.desktopSynced') : t('sys.desktopLocal')}</span>
                </td>
              </tr>
              <tr>
                <th>{t('sys.cwd')}</th>
                <td>{String(doctor.cwd)}</td>
              </tr>
              <tr>
                <th>{t('sys.runs')}</th>
                <td>{String(doctor.runsDir)}</td>
              </tr>
              <tr>
                <th>{t('sys.data')}</th>
                <td>{String(doctor.dataDir)}</td>
              </tr>
              <tr>
                <th>{t('sys.mode')}</th>
                <td>{String(doctor.mode)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>{t('sys.settings')}</h2>
        <p className="muted small">{t('sys.settingsHint', { file: 'data/settings.json', example: 'run.example.yaml' })}</p>
        {settings && (
          <>
            <h3>{t('sys.asSaved')}</h3>
            <pre className="tall">{JSON.stringify(settings.raw, null, 2)}</pre>
            <h3>{t('sys.resolved')}</h3>
            <pre>{JSON.stringify(settings.resolved, null, 2)}</pre>
          </>
        )}
      </div>

      <div className="panel">
        <h2>{t('sys.signin')}</h2>
        <p className="muted small">{t('sys.signinHint')}</p>
        <pre>npx tsx src/cli.ts login --account you@yourtenant.org</pre>
      </div>
    </>
  );
}
