'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, fmtTime, type Session } from '../lib/api';

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [apiUp, setApiUp] = useState<boolean | null>(null);

  const load = async () => {
    try {
      setSessions(await api.sessions());
      setApiUp(true);
      setError('');
    } catch (e) {
      setApiUp(false);
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);

  const create = async () => {
    try {
      const s = await api.createSession(name || 'session');
      setName('');
      window.location.href = `/sessions/${s.id}`;
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      {apiUp === false && (
        <div className="panel">
          <strong>The API is not reachable.</strong>
          <div className="muted small">
            Start it from the project folder with <code>npm run api</code>. Expected at {process.env.NEXT_PUBLIC_COP_API ?? 'http://127.0.0.1:4000/api'}.
          </div>
          {error && <div className="err">{error}</div>}
        </div>
      )}

      <div className="panel">
        <h2>New session</h2>
        <p className="muted small">
          A session is one Copilot conversation. Tasks inside it run one after another in that same chat, so
          later tasks can build on earlier ones.
        </p>
        <div className="row">
          <input
            type="text"
            className="grow"
            placeholder="Session name, e.g. payments-service"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
          />
          <button className="primary" onClick={() => void create()} disabled={apiUp === false}>
            Create
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Sessions</h2>
        {sessions === null && <div className="muted">Loading…</div>}
        {sessions && sessions.length === 0 && <div className="muted">None yet.</div>}
        {sessions && sessions.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Tasks</th>
                <th>State</th>
                <th>Chat</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const done = s.tasks.filter((t) => t.status === 'done').length;
                const queued = s.tasks.filter((t) => t.status === 'queued').length;
                return (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/sessions/${s.id}`}>{s.name}</Link>
                    </td>
                    <td>
                      {s.tasks.length} <span className="muted small">({done} done, {queued} queued)</span>
                    </td>
                    <td>
                      <span className={`badge ${s.running ? 'running' : ''}`}>{s.running ? 'running' : s.status}</span>
                    </td>
                    <td>{s.chat ? <a href={s.chat.url} target="_blank" rel="noreferrer">{s.chat.name}</a> : <span className="muted">not opened</span>}</td>
                    <td className="muted small">{fmtTime(s.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
