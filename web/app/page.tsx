'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type Session } from '../lib/api';
import { useT, useFmtTime } from '../lib/i18n';

export default function SessionsPage() {
  const { t } = useT();
  const fmtTime = useFmtTime();
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
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
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

  const stateLabel = (s: Session) => (s.running ? t('state.running') : t(`state.${s.status}` as 'state.idle'));

  return (
    <>
      {apiUp === false && (
        <div className="panel">
          <strong>{t('home.apiDown')}</strong>
          <div className="muted small">
            {t('home.apiHint', { cmd: 'npm start', url: process.env.NEXT_PUBLIC_COP_API ?? 'http://127.0.0.1:4000/api' })}
          </div>
          {error && <div className="err">{error}</div>}
        </div>
      )}

      <div className="panel">
        <h2>{t('home.new')}</h2>
        <p className="muted small">{t('home.newHint')}</p>
        <div className="row">
          <input
            type="text"
            className="grow"
            placeholder={t('home.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
            }}
          />
          <button className="primary" onClick={() => void create()} disabled={apiUp === false}>
            {t('home.create')}
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>{t('home.sessions')}</h2>
        {sessions === null && <div className="muted">{t('home.loading')}</div>}
        {sessions && sessions.length === 0 && <div className="muted">{t('home.none')}</div>}
        {sessions && sessions.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>{t('home.col.name')}</th>
                <th>{t('home.col.tasks')}</th>
                <th>{t('home.col.state')}</th>
                <th>{t('home.col.chat')}</th>
                <th>{t('home.col.created')}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const done = s.tasks.filter((x) => x.status === 'done').length;
                const queued = s.tasks.filter((x) => x.status === 'queued').length;
                return (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/sessions/${s.id}`}>{s.name}</Link>
                    </td>
                    <td>
                      {s.tasks.length} <span className="muted small">{t('home.tasksDetail', { done, queued })}</span>
                    </td>
                    <td>
                      <span className={`badge ${s.running ? 'running' : ''}`}>{stateLabel(s)}</span>
                    </td>
                    <td>
                      {s.chat ? (
                        <a href={s.chat.url} target="_blank" rel="noreferrer">
                          {s.chat.name}
                        </a>
                      ) : (
                        <span className="muted">{t('home.notOpened')}</span>
                      )}
                    </td>
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
