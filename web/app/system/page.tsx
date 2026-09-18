'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

export default function SystemPage() {
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
        <h2>This machine</h2>
        {!doctor && <div className="muted">Loading…</div>}
        {doctor && (
          <table>
            <tbody>
              <tr><th>Node</th><td>{String(doctor.node)}</td></tr>
              <tr><th>Edge</th><td>{doctor.edge ? String(doctor.edge) : <span className="err">not found</span>}</td></tr>
              <tr><th>Bot profile</th><td>{String(doctor.profileDir)} {doctor.profileExists ? '' : <span className="muted">(not created yet: run cop login)</span>}</td></tr>
              <tr>
                <th>Profile in use</th>
                <td>
                  {Array.isArray(held) && held.length > 0 ? (
                    <span className="err">Edge is holding the profile (pids {held.join(', ')}). A run would fail. Close that Edge window.</span>
                  ) : held === 'unknown' ? (
                    <span className="muted">could not check</span>
                  ) : (
                    'free'
                  )}
                </td>
              </tr>
              <tr><th>Desktop</th><td>{String(doctor.desktop)} <span className="muted">{doctor.desktopSynced ? '(backed up by OneDrive)' : '(not backed up by OneDrive; mirror stays local)'}</span></td></tr>
              <tr><th>Commands run in</th><td>{String(doctor.cwd)}</td></tr>
              <tr><th>Runs folder</th><td>{String(doctor.runsDir)}</td></tr>
              <tr><th>Data folder</th><td>{String(doctor.dataDir)}</td></tr>
              <tr><th>Default mode</th><td>{String(doctor.mode)}</td></tr>
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Settings</h2>
        <p className="muted small">
          Read from <code>data/settings.json</code> next to the project. It has the same shape as <code>run.example.yaml</code>;
          anything missing takes the default. Edit the file and restart the API.
        </p>
        {settings && (
          <>
            <h3>As saved</h3>
            <pre className="tall">{JSON.stringify(settings.raw, null, 2)}</pre>
            <h3>Resolved paths</h3>
            <pre>{JSON.stringify(settings.resolved, null, 2)}</pre>
          </>
        )}
      </div>

      <div className="panel">
        <h2>Sign-in</h2>
        <p className="muted small">
          Signing in is done once, from the terminal, so that the bot never handles credentials:
        </p>
        <pre>npx tsx src/cli.ts login --account you@yourtenant.org</pre>
      </div>
    </>
  );
}
