'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useFmtTime, useT } from '../../lib/i18n';

type Moved = { from: string; at: string; stillThere: boolean };

/**
 * The bot's folder (operator, 2026-10-22): where its settings, conversations, logs and Edge profile are, and a way to
 * keep them elsewhere from the next start. A clone keeps them in the clone, and COP_HOME is changed where it is set.
 */
function HomeRow({ doctor, onSaved }: { doctor: Record<string, unknown>; onSaved: () => void }) {
  const { t } = useT();
  const fmtTime = useFmtTime();
  const home = String(doctor.home ?? '');
  const from = String(doctor.homeFrom ?? 'checkout');
  const next = typeof doctor.homeNext === 'string' ? doctor.homeNext : null;
  const byDefault = typeof doctor.homeDefault === 'string' ? doctor.homeDefault : null;
  const moved = (doctor.homeMovedFrom ?? null) as Moved | null;
  const changeable = doctor.install === 'package' && from !== 'env';
  const same = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

  const [asking, setAsking] = useState<string | null>(null);
  const [copy, setCopy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');

  const browse = async () => {
    setBusy(true);
    setErr('');
    try {
      const picked = await api.browseFolder((asking ?? '').trim() || home || undefined);
      if (picked.ok) setAsking(picked.path);
      else if (!picked.cancelled) setErr(picked.reason ?? '');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const choose = async (dir: string | null) => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.setHome(dir, copy);
      setSaved(t('sys.homeSaved', { dir: r.home }));
      setAsking(null);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const badge = from === 'chosen' ? t('sys.homeFromChosen') : from === 'env' ? t('sys.homeFromEnv') : from === 'default' ? t('sys.homeFromDefault') : t('sys.homeFromCheckout');
  // Back to the default is offered whenever the next start would not use it.
  const offBase = changeable && byDefault !== null && next !== null && !same(next, byDefault);

  return (
    <tr className="sys-home">
      <th>{t('sys.home')}</th>
      <td>
        <span className="sys-home-dir">{home}</span> <span className="badge">{badge}</span>
        <div className="muted small">{t('sys.homeHolds')}</div>
        {next !== null && !same(next, home) && <div className="notice caution sys-home-next">{t('sys.homeNext', { dir: next })}</div>}
        {moved?.stillThere && <div className="notice calm sys-home-moved">{t('sys.homeMoved', { from: moved.from, at: fmtTime(moved.at) })}</div>}
        {changeable && asking === null && (
          <div className="row" style={{ marginTop: 6 }}>
            <button type="button" className="sys-home-change" disabled={busy} onClick={() => { setSaved(''); setErr(''); setAsking(next ?? home); }}>
              {t('sys.homeChange')}
            </button>
            {offBase && (
              <button type="button" className="quiet sys-home-reset" disabled={busy} onClick={() => { setSaved(''); setAsking(byDefault); }}>
                {t('sys.homeReset')}
              </button>
            )}
          </div>
        )}
        {changeable && asking !== null && (
          <div className="notice calm sys-home-ask">
            <div>{t('sys.homeAsk', { dir: asking || '…' })}</div>
            <div className="row" style={{ marginTop: 6 }}>
              <input type="text" className="sys-home-input" value={asking} onChange={(e) => setAsking(e.target.value)} spellCheck={false} aria-label={t('sys.home')} style={{ flex: 1, minWidth: 0 }} />
              {doctor.folderDialog === true && (
                <button type="button" disabled={busy} onClick={browse}>
                  {t('mirror.browse')}
                </button>
              )}
            </div>
            <label className="sys-home-copyline small">
              <input type="checkbox" className="sys-home-copy" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
              <span>{t('sys.homeCopy')}</span>
            </label>
            <div className="row" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="primary sys-home-use"
                disabled={busy || !asking.trim()}
                onClick={() => choose(byDefault !== null && same(asking.trim(), byDefault) ? null : asking.trim())}
              >
                {t('sys.homeUse')}
              </button>
              <button type="button" className="quiet" disabled={busy} onClick={() => { setAsking(null); setErr(''); }}>
                {t('dialog.cancel')}
              </button>
            </div>
          </div>
        )}
        {saved && <div className="notice calm sys-home-saved">{saved}</div>}
        {err && <div className="err sys-home-err">{err}</div>}
      </td>
    </tr>
  );
}

/**
 * Whose Edge has the bot's profile open (2026-10-22). Until then any Edge on it was "a run would fail" unless a run was
 * going, and the chat's window — kept open between messages by the bot itself — was shown as that warning.
 */
function ProfileUse({ doctor }: { doctor: Record<string, unknown> }) {
  const { t } = useT();
  const pids = Array.isArray(doctor.profileHeldBy) ? (doctor.profileHeldBy as number[]) : [];
  switch (doctor.profileHolder) {
    case 'own-run':
      return <span className="muted">{t('sys.profileBot', { n: pids.length })}</span>;
    case 'own-window':
      return <span className="muted">{t('sys.profileOwnWindow', { n: pids.length })}</span>;
    case 'other':
      return <span className="err">{t('sys.profileHeld', { n: pids.length, pids: pids.join(', ') })}</span>;
    case 'unknown':
      return <span className="muted">{t('sys.profileUnknown')}</span>;
    default:
      return <>{t('sys.profileFree')}</>;
  }
}

/** A size as people read it: 12 KB, 3.4 MB. */
function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Everything the bot has kept, as one .zip (operator, 2026-10-23: "export everything saved so far under this
 * profile"): its data folder, and every run's records when ticked; the key and the Edge profile never. See
 * `config/exportHome.ts`.
 */
function ExportHome() {
  const { t } = useT();
  const [sizes, setSizes] = useState<{ data: number; dataFiles: number; runs: number; runsFiles: number } | null>(null);
  const [runs, setRuns] = useState(false);
  useEffect(() => {
    api.homeExportSize().then(setSizes).catch(() => undefined);
  }, []);
  return (
    <div className="sys-export">
      <h3>{t('sys.export')}</h3>
      <p className="muted small">{t('sys.exportWhat', { size: sizes ? sizeOf(sizes.data) : '…', n: sizes?.dataFiles ?? '…' })}</p>
      <label className="sys-home-copyline small">
        <input type="checkbox" id="export-runs" checked={runs} onChange={(e) => setRuns(e.target.checked)} />
        <span>{t('sys.exportRuns', { size: sizes ? sizeOf(sizes.runs) : '…', n: sizes?.runsFiles ?? '…' })}</span>
      </label>
      <div className="row" style={{ marginTop: 8 }}>
        <a className="button-link plain sys-export-link" href={api.homeExportUrl(runs)} download>
          {t('sys.exportButton')}
        </a>
      </div>
    </div>
  );
}

export default function SystemPage() {
  const { t } = useT();
  const [doctor, setDoctor] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<{ raw: Record<string, unknown>; resolved: Record<string, unknown> } | null>(null);
  const [err, setErr] = useState('');

  const readDoctor = () => api.doctor().then(setDoctor).catch((e) => setErr((e as Error).message));
  useEffect(() => {
    readDoctor();
    api.settings().then(setSettings).catch((e) => setErr((e as Error).message));
  }, []);

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
                <th>{t('sys.version')}</th>
                <td>{String(doctor.version ?? '—')}</td>
              </tr>
              <tr>
                <th>{t('sys.node')}</th>
                <td>{String(doctor.node)}</td>
              </tr>
              <tr>
                <th>{t('sys.edge')}</th>
                <td>{doctor.edge ? String(doctor.edge) : <span className="err">{t('sys.edgeMissing')}</span>}</td>
              </tr>
              <HomeRow doctor={doctor} onSaved={readDoctor} />
              <tr>
                <th>{t('sys.profile')}</th>
                <td>
                  {String(doctor.profileDir)} {doctor.profileExists ? '' : <span className="muted">{t('sys.profileMissing')}</span>}
                </td>
              </tr>
              <tr className="sys-profile-use">
                <th>{t('sys.profileInUse')}</th>
                <td>
                  <ProfileUse doctor={doctor} />
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
        {/* What the bot's console printed, for when something went wrong and no page says why. See src/log/terminal.ts. */}
        <div className="row" style={{ marginTop: 10 }}>
          <a className="button-link plain" href={api.terminalUrl()} download>
            {t('startfail.terminal')}
          </a>
        </div>
        <p className="why">{t('sys.terminalWhy')}</p>
        <ExportHome />
      </div>

      <div className="panel">
        <h2>{t('sys.settings')}</h2>
        <p className="muted small">{t('sys.settingsHint', { file: String(doctor?.settingsFile ?? 'data/settings.json'), example: 'run.example.yaml' })}</p>
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
