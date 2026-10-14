'use client';

/** A file of the session's repository at its branch (or at the task's commit), read-only, with line numbers. */
import { useEffect, useState } from 'react';
import { api, type RepoFile } from '../../lib/api';
import { useT } from '../../lib/i18n';

export function FileView({ sessionId, path, taskId }: { sessionId: string; path: string; taskId?: string }) {
  const { t } = useT();
  const [file, setFile] = useState<RepoFile | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setFile(null);
    setErr('');
    api.repoFile(sessionId, path, taskId).then(setFile).catch((e: unknown) => setErr((e as Error).message));
  }, [sessionId, path, taskId]);
  if (err) return <p className="err small">{err}</p>;
  if (!file) return <p className="muted small">{t('wb.loading')}</p>;
  const lines = (file.text ?? '').split('\n');
  return (
    <div className="wb-file">
      <p className="muted small">{t('wb.fileAt', { path: file.path, ref: file.label })}</p>
      {file.binary ? (
        <p className="muted">{t('wb.binary')}</p>
      ) : file.tooLarge ? (
        <p className="muted">{t('wb.tooLarge')}</p>
      ) : (
        <pre className="wb-code" aria-label={file.path}>
          {lines.map((l, i) => (
            <span key={i} className="wb-line">
              <span className="wb-ln" aria-hidden="true">{i + 1}</span>
              {l}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
